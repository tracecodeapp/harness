const RESULT_MARKER = '__TRACECODE_RESULT__';
const TRACE_EVENT_MARKER = '__TRACECODE_EVENT__';
const RUNTIME_TRACE_SCHEMA_VERSION = 'runtime-trace-2026-04-28';
const CPP_STANDARD = 'c++23';
const ESUCCESS = 0;
const EBADF = 8;
const EEXIST = 20;
const EINVAL = 28;
const EIO = 29;
const ENOENT = 44;
const ENOTDIR = 54;
const ENOTSUP = 58;
const FILETYPE_UNKNOWN = 0;
const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;
const OFLAGS_CREAT = 1;
const OFLAGS_DIRECTORY = 2;
const OFLAGS_EXCL = 4;
const OFLAGS_TRUNC = 8;
const FDFLAGS_APPEND = 1;
const WHENCE_SET = 0;
const WHENCE_CUR = 1;
const WHENCE_END = 2;

let configuredAssets = null;
let toolchainPromise = null;

class ProcExit extends Error {
  constructor(code) {
    super(`process exited with code ${code}`);
    this.code = code;
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function encodeUtf8(value) {
  return new TextEncoder().encode(value);
}

function decodeUtf8(value) {
  return new TextDecoder().decode(value);
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function normalizePath(pathname) {
  const raw = String(pathname || '/').replace(/\\/g, '/');
  const absolute = raw.startsWith('/') ? raw : `/${raw}`;
  const parts = [];
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function dirname(pathname) {
  const normalized = normalizePath(pathname);
  if (normalized === '/') return '/';
  const slash = normalized.lastIndexOf('/');
  return slash <= 0 ? '/' : normalized.slice(0, slash);
}

function basename(pathname) {
  const normalized = normalizePath(pathname);
  if (normalized === '/') return '/';
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function resolveAt(base, child) {
  if (!child || child === '.') return normalizePath(base || '/');
  if (child.startsWith('/')) return normalizePath(child);
  return normalizePath(`${base || '/'}/${child}`);
}

function inodeForPath(pathname) {
  let hash = 2166136261;
  for (const ch of normalizePath(pathname)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return BigInt(hash >>> 0) + 1n;
}

function cloneBytes(value) {
  return new Uint8Array(value);
}

function postSuccess(id, type, payload) {
  postMessage({ id, type, payload });
}

function postFailure(id, error) {
  postMessage({
    id,
    type: 'error',
    payload: { error: error instanceof Error ? error.message : String(error) },
  });
}

async function fetchAsset(name, url, responseType) {
  if (!url || typeof url !== 'string') {
    throw new Error(`Missing C++ toolchain asset URL for ${name}.`);
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${name} failed to load from ${url} (${response.status} ${response.statusText})`);
  }

  return responseType === 'text' ? response.text() : response.arrayBuffer();
}

function readTarString(bytes, offset, length) {
  let end = offset;
  const max = offset + length;
  while (end < max && bytes[end] !== 0) end += 1;
  return decodeUtf8(bytes.subarray(offset, end)).trim();
}

function readTarOctal(bytes, offset, length) {
  const value = readTarString(bytes, offset, length).replace(/\0.*$/, '').trim();
  return value ? parseInt(value, 8) : 0;
}

function parseTarEntries(buffer) {
  const bytes = new Uint8Array(buffer);
  const entries = [];
  let offset = 0;

  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const size = readTarOctal(header, 124, 12);
    const type = readTarString(header, 156, 1) || '0';
    const prefix = readTarString(header, 345, 155);
    const filename = normalizePath(prefix ? `${prefix}/${name}` : name);
    offset += 512;

    if (type === '5') {
      entries.push({ type: 'dir', path: filename });
    } else if (type === '0' || type === '') {
      entries.push({ type: 'file', path: filename, contents: cloneBytes(bytes.subarray(offset, offset + size)) });
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return entries;
}

class InMemoryFileSystem {
  constructor() {
    this.files = new Map();
    this.dirs = new Set(['/']);
  }

  clone() {
    const next = new InMemoryFileSystem();
    next.dirs = new Set(this.dirs);
    next.files = new Map([...this.files.entries()].map(([key, value]) => [key, cloneBytes(value)]));
    return next;
  }

  addDirectory(pathname) {
    const normalized = normalizePath(pathname);
    if (normalized === '/') {
      this.dirs.add('/');
      return;
    }
    this.addDirectory(dirname(normalized));
    this.dirs.add(normalized);
  }

  addFile(pathname, contents) {
    const normalized = normalizePath(pathname);
    this.addDirectory(dirname(normalized));
    this.files.set(normalized, contents instanceof Uint8Array ? cloneBytes(contents) : encodeUtf8(String(contents)));
  }

  exists(pathname) {
    const normalized = normalizePath(pathname);
    return this.files.has(normalized) || this.dirs.has(normalized);
  }

  isDirectory(pathname) {
    return this.dirs.has(normalizePath(pathname));
  }

  isFile(pathname) {
    return this.files.has(normalizePath(pathname));
  }

  readFile(pathname) {
    const normalized = normalizePath(pathname);
    const file = this.files.get(normalized);
    if (!file) throw new Error(`File not found: ${normalized}`);
    return file;
  }

  writeFile(pathname, contents) {
    const normalized = normalizePath(pathname);
    this.addDirectory(dirname(normalized));
    this.files.set(normalized, contents instanceof Uint8Array ? cloneBytes(contents) : encodeUtf8(String(contents)));
  }

  resizeFile(pathname, size) {
    const current = this.readFile(pathname);
    const next = new Uint8Array(size);
    next.set(current.subarray(0, Math.min(current.length, size)));
    this.writeFile(pathname, next);
  }

  unlink(pathname) {
    this.files.delete(normalizePath(pathname));
  }

  listDirectory(pathname) {
    const normalized = normalizePath(pathname);
    const prefix = normalized === '/' ? '/' : `${normalized}/`;
    const names = new Set();
    for (const dir of this.dirs) {
      if (dir === normalized || !dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      if (rest && !rest.includes('/')) names.add(rest);
    }
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (rest && !rest.includes('/')) names.add(rest);
    }
    return [...names].sort();
  }

  applyTarEntries(entries) {
    for (const entry of entries) {
      if (entry.type === 'dir') this.addDirectory(entry.path);
      if (entry.type === 'file') this.addFile(entry.path, entry.contents);
    }
  }
}

class MemoryView {
  constructor(memory) {
    this.memory = memory;
    this.refresh();
  }

  refresh() {
    if (this.buffer !== this.memory.buffer) {
      this.buffer = this.memory.buffer;
      this.u8 = new Uint8Array(this.buffer);
      this.view = new DataView(this.buffer);
    }
  }

  readU8(offset) {
    this.refresh();
    return this.view.getUint8(offset);
  }

  writeU8(offset, value) {
    this.refresh();
    this.view.setUint8(offset, value);
  }

  readU16(offset) {
    this.refresh();
    return this.view.getUint16(offset, true);
  }

  writeU16(offset, value) {
    this.refresh();
    this.view.setUint16(offset, value, true);
  }

  readU32(offset) {
    this.refresh();
    return this.view.getUint32(offset, true);
  }

  writeU32(offset, value) {
    this.refresh();
    this.view.setUint32(offset, value >>> 0, true);
  }

  readU64(offset) {
    this.refresh();
    return this.view.getBigUint64(offset, true);
  }

  writeU64(offset, value) {
    this.refresh();
    this.view.setBigUint64(offset, BigInt(value), true);
  }

  readBytes(offset, length) {
    this.refresh();
    return cloneBytes(this.u8.subarray(offset, offset + length));
  }

  writeBytes(offset, bytes) {
    this.refresh();
    this.u8.set(bytes, offset);
  }

  readString(offset, length) {
    return decodeUtf8(this.readBytes(offset, length));
  }

  writeString(offset, value) {
    const bytes = encodeUtf8(value);
    this.writeBytes(offset, bytes);
    return bytes.length;
  }
}

class WasiProcess {
  constructor(options) {
    this.args = options.args || [];
    this.env = options.env || {};
    this.fs = options.fs;
    this.stdin = encodeUtf8(options.stdin || '');
    this.stdinOffset = 0;
    this.stdoutChunks = [];
    this.stderrChunks = [];
    this.filestatSizeOffset = options.filestatSizeOffset || 32;
    this.fds = new Map([
      [0, { kind: 'stdio', name: 'stdin', offset: 0, readable: true, writable: false }],
      [1, { kind: 'stdio', name: 'stdout', offset: 0, readable: false, writable: true }],
      [2, { kind: 'stdio', name: 'stderr', offset: 0, readable: false, writable: true }],
      [3, { kind: 'dir', path: '/', offset: 0, readable: true, writable: false, preopen: '/' }],
    ]);
    this.nextFd = 4;
    this.memory = null;
    this.mem = null;
  }

  setMemory(memory) {
    this.memory = memory;
    this.mem = new MemoryView(memory);
  }

  get stdout() {
    return decodeUtf8(concatBytes(this.stdoutChunks));
  }

  get stderr() {
    return decodeUtf8(concatBytes(this.stderrChunks));
  }

  bind(name) {
    if (typeof this[name] === 'function') return this[name].bind(this);
    return () => ENOTSUP;
  }

  resolveFdPath(fd, pathPtr, pathLen) {
    const entry = this.fds.get(fd);
    if (!entry) return null;
    const path = this.mem.readString(pathPtr, pathLen);
    const base = entry.kind === 'dir' ? entry.path : dirname(entry.path || '/');
    return resolveAt(base, path);
  }

  openFile(pathname, options = {}) {
    const normalized = normalizePath(pathname);
    if (options.directory) {
      if (!this.fs.isDirectory(normalized)) return -ENOENT;
      return this.allocateFd({ kind: 'dir', path: normalized, offset: 0, readable: true, writable: false });
    }

    if (!this.fs.exists(normalized)) {
      if (!options.create) return -ENOENT;
      this.fs.writeFile(normalized, new Uint8Array());
    } else if (options.exclusive) {
      return -EEXIST;
    }

    if (this.fs.isDirectory(normalized)) {
      return this.allocateFd({ kind: 'dir', path: normalized, offset: 0, readable: true, writable: false });
    }

    if (options.truncate) {
      this.fs.writeFile(normalized, new Uint8Array());
    }

    const offset = options.append ? this.fs.readFile(normalized).length : 0;
    return this.allocateFd({ kind: 'file', path: normalized, offset, readable: true, writable: true, append: Boolean(options.append) });
  }

  allocateFd(entry) {
    const fd = this.nextFd++;
    this.fds.set(fd, entry);
    return fd;
  }

  writeFilestat(pathname, outPtr) {
    const normalized = normalizePath(pathname);
    const isDir = this.fs.isDirectory(normalized);
    const isFile = this.fs.isFile(normalized);
    if (!isDir && !isFile) return ENOENT;
    const size = isFile ? this.fs.readFile(normalized).length : 0;
    this.mem.writeU64(outPtr, 1);
    this.mem.writeU64(outPtr + 8, inodeForPath(normalized));
    this.mem.writeU8(outPtr + 16, isDir ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE);
    this.mem.writeU64(outPtr + 24, this.filestatSizeOffset === 24 ? BigInt(size) : 1);
    this.mem.writeU64(outPtr + 32, BigInt(size));
    this.mem.writeU64(outPtr + 40, 0);
    this.mem.writeU64(outPtr + 48, 0);
    this.mem.writeU64(outPtr + 56, 0);
    return ESUCCESS;
  }

  args_sizes_get(argcOut, argvBufSizeOut) {
    const encoded = this.args.map((arg) => encodeUtf8(`${arg}\0`));
    this.mem.writeU32(argcOut, encoded.length);
    this.mem.writeU32(argvBufSizeOut, encoded.reduce((sum, arg) => sum + arg.length, 0));
    return ESUCCESS;
  }

  args_get(argvOut, argvBuf) {
    let ptrOffset = argvOut;
    let bufOffset = argvBuf;
    for (const arg of this.args) {
      const bytes = encodeUtf8(`${arg}\0`);
      this.mem.writeU32(ptrOffset, bufOffset);
      this.mem.writeBytes(bufOffset, bytes);
      ptrOffset += 4;
      bufOffset += bytes.length;
    }
    return ESUCCESS;
  }

  environ_sizes_get(countOut, bufSizeOut) {
    const entries = Object.entries(this.env).map(([key, value]) => encodeUtf8(`${key}=${value}\0`));
    this.mem.writeU32(countOut, entries.length);
    this.mem.writeU32(bufSizeOut, entries.reduce((sum, entry) => sum + entry.length, 0));
    return ESUCCESS;
  }

  environ_get(environOut, environBuf) {
    let ptrOffset = environOut;
    let bufOffset = environBuf;
    for (const [key, value] of Object.entries(this.env)) {
      const bytes = encodeUtf8(`${key}=${value}\0`);
      this.mem.writeU32(ptrOffset, bufOffset);
      this.mem.writeBytes(bufOffset, bytes);
      ptrOffset += 4;
      bufOffset += bytes.length;
    }
    return ESUCCESS;
  }

  fd_write(fd, iovs, iovsLen, nwrittenOut) {
    const entry = this.fds.get(fd);
    if (!entry || !entry.writable) return EBADF;
    const chunks = [];
    let total = 0;
    for (let index = 0; index < iovsLen; index += 1) {
      const ptr = this.mem.readU32(iovs + index * 8);
      const len = this.mem.readU32(iovs + index * 8 + 4);
      const bytes = this.mem.readBytes(ptr, len);
      chunks.push(bytes);
      total += len;
    }

    if (fd === 1 || fd === 2) {
      if (fd === 1) this.stdoutChunks.push(...chunks);
      if (fd === 2) this.stderrChunks.push(...chunks);
    } else if (entry.kind === 'file') {
      const current = this.fs.exists(entry.path) ? this.fs.readFile(entry.path) : new Uint8Array();
      const offset = entry.append ? current.length : entry.offset;
      const next = new Uint8Array(Math.max(current.length, offset + total));
      next.set(current);
      let writeOffset = offset;
      for (const chunk of chunks) {
        next.set(chunk, writeOffset);
        writeOffset += chunk.length;
      }
      entry.offset = writeOffset;
      this.fs.writeFile(entry.path, next);
    }

    this.mem.writeU32(nwrittenOut, total);
    return ESUCCESS;
  }

  fd_read(fd, iovs, iovsLen, nreadOut) {
    const entry = this.fds.get(fd);
    if (!entry || !entry.readable) return EBADF;
    const source = fd === 0 ? this.stdin : entry.kind === 'file' ? this.fs.readFile(entry.path) : new Uint8Array();
    let sourceOffset = fd === 0 ? this.stdinOffset : entry.offset;
    let total = 0;
    for (let index = 0; index < iovsLen; index += 1) {
      const ptr = this.mem.readU32(iovs + index * 8);
      const len = this.mem.readU32(iovs + index * 8 + 4);
      const chunk = source.subarray(sourceOffset, sourceOffset + len);
      this.mem.writeBytes(ptr, chunk);
      sourceOffset += chunk.length;
      total += chunk.length;
      if (chunk.length < len) break;
    }
    if (fd === 0) this.stdinOffset = sourceOffset;
    else entry.offset = sourceOffset;
    this.mem.writeU32(nreadOut, total);
    return ESUCCESS;
  }

  fd_pwrite(fd, iovs, iovsLen, offset, nwrittenOut) {
    const entry = this.fds.get(fd);
    if (!entry || entry.kind !== 'file') return EBADF;
    const oldOffset = entry.offset;
    entry.offset = Number(offset);
    const result = this.fd_write(fd, iovs, iovsLen, nwrittenOut);
    entry.offset = oldOffset;
    return result;
  }

  fd_pread(fd, iovs, iovsLen, offset, nreadOut) {
    const entry = this.fds.get(fd);
    if (!entry || entry.kind !== 'file') return EBADF;
    const oldOffset = entry.offset;
    entry.offset = Number(offset);
    const result = this.fd_read(fd, iovs, iovsLen, nreadOut);
    entry.offset = oldOffset;
    return result;
  }

  fd_seek(fd, offset, whence, newOffsetOut) {
    const entry = this.fds.get(fd);
    if (!entry) return EBADF;
    const fileSize = entry.kind === 'file' && this.fs.exists(entry.path) ? this.fs.readFile(entry.path).length : 0;
    const rawOffset = Number(offset);
    if (whence === WHENCE_SET) entry.offset = rawOffset;
    else if (whence === WHENCE_CUR) entry.offset += rawOffset;
    else if (whence === WHENCE_END) entry.offset = fileSize + rawOffset;
    else return EINVAL;
    if (entry.offset < 0) entry.offset = 0;
    this.mem.writeU64(newOffsetOut, BigInt(entry.offset));
    return ESUCCESS;
  }

  fd_tell(fd, offsetOut) {
    const entry = this.fds.get(fd);
    if (!entry) return EBADF;
    this.mem.writeU64(offsetOut, BigInt(entry.offset || 0));
    return ESUCCESS;
  }

  fd_close(fd) {
    if (fd <= 2) return ESUCCESS;
    if (!this.fds.has(fd)) return EBADF;
    this.fds.delete(fd);
    return ESUCCESS;
  }

  fd_sync() {
    return ESUCCESS;
  }

  fd_datasync() {
    return ESUCCESS;
  }

  fd_fdstat_get(fd, outPtr) {
    const entry = this.fds.get(fd);
    if (!entry) return EBADF;
    const filetype = entry.kind === 'dir' ? FILETYPE_DIRECTORY : entry.kind === 'stdio' ? FILETYPE_CHARACTER_DEVICE : FILETYPE_REGULAR_FILE;
    this.mem.writeU8(outPtr, filetype);
    this.mem.writeU16(outPtr + 2, entry.append ? FDFLAGS_APPEND : 0);
    this.mem.writeU64(outPtr + 8, 0xffff_ffffn);
    this.mem.writeU64(outPtr + 16, 0xffff_ffffn);
    return ESUCCESS;
  }

  fd_fdstat_set_flags(fd, flags) {
    const entry = this.fds.get(fd);
    if (!entry) return EBADF;
    entry.append = Boolean(flags & FDFLAGS_APPEND);
    return ESUCCESS;
  }

  fd_filestat_get(fd, outPtr) {
    const entry = this.fds.get(fd);
    if (!entry) return EBADF;
    if (entry.kind === 'stdio') return EINVAL;
    return this.writeFilestat(entry.path, outPtr);
  }

  fd_filestat_set_size(fd, size) {
    const entry = this.fds.get(fd);
    if (!entry || entry.kind !== 'file') return EBADF;
    this.fs.resizeFile(entry.path, Number(size));
    return ESUCCESS;
  }

  fd_prestat_get(fd, outPtr) {
    const entry = this.fds.get(fd);
    if (!entry || !entry.preopen) return EBADF;
    const name = entry.preopen;
    this.mem.writeU8(outPtr, 0);
    this.mem.writeU32(outPtr + 4, encodeUtf8(name).length);
    return ESUCCESS;
  }

  fd_prestat_dir_name(fd, pathPtr, pathLen) {
    const entry = this.fds.get(fd);
    if (!entry || !entry.preopen) return EBADF;
    this.mem.writeBytes(pathPtr, encodeUtf8(entry.preopen).subarray(0, pathLen));
    return ESUCCESS;
  }

  fd_readdir(fd, bufPtr, bufLen, cookie, bufUsedOut) {
    const entry = this.fds.get(fd);
    if (!entry || entry.kind !== 'dir') return EBADF;
    const names = ['.', '..', ...this.fs.listDirectory(entry.path)];
    let offset = 0;
    const start = Number(cookie);
    for (let index = start; index < names.length; index += 1) {
      const name = names[index];
      const childPath = name === '.' ? entry.path : name === '..' ? dirname(entry.path) : resolveAt(entry.path, name);
      const nameBytes = encodeUtf8(name);
      const entrySize = 24 + nameBytes.length;
      if (offset + entrySize > bufLen) break;
      this.mem.writeU64(bufPtr + offset, BigInt(index + 1));
      this.mem.writeU64(bufPtr + offset + 8, BigInt(index + 1));
      this.mem.writeU32(bufPtr + offset + 16, nameBytes.length);
      this.mem.writeU8(bufPtr + offset + 20, this.fs.isDirectory(childPath) ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE);
      this.mem.writeBytes(bufPtr + offset + 24, nameBytes);
      offset += entrySize;
    }
    this.mem.writeU32(bufUsedOut, offset);
    return ESUCCESS;
  }

  path_open(dirfd, _dirflags, pathPtr, pathLen, oflags, _rightsBase, _rightsInheriting, fdflags, openedFdOut) {
    const pathname = this.resolveFdPath(dirfd, pathPtr, pathLen);
    if (!pathname) return EBADF;
    const fd = this.openFile(pathname, {
      create: Boolean(oflags & OFLAGS_CREAT),
      directory: Boolean(oflags & OFLAGS_DIRECTORY),
      exclusive: Boolean(oflags & OFLAGS_EXCL),
      truncate: Boolean(oflags & OFLAGS_TRUNC),
      append: Boolean(fdflags & FDFLAGS_APPEND),
    });
    if (fd < 0) return -fd;
    this.mem.writeU32(openedFdOut, fd);
    return ESUCCESS;
  }

  path_filestat_get(dirfd, _flags, pathPtr, pathLen, outPtr) {
    const pathname = this.resolveFdPath(dirfd, pathPtr, pathLen);
    if (!pathname) return EBADF;
    return this.writeFilestat(pathname, outPtr);
  }

  path_filestat_set_times() {
    return ESUCCESS;
  }

  path_create_directory(dirfd, pathPtr, pathLen) {
    const pathname = this.resolveFdPath(dirfd, pathPtr, pathLen);
    if (!pathname) return EBADF;
    this.fs.addDirectory(pathname);
    return ESUCCESS;
  }

  path_unlink_file(dirfd, pathPtr, pathLen) {
    const pathname = this.resolveFdPath(dirfd, pathPtr, pathLen);
    if (!pathname) return EBADF;
    this.fs.unlink(pathname);
    return ESUCCESS;
  }

  path_remove_directory() {
    return ESUCCESS;
  }

  path_rename(oldFd, oldPathPtr, oldPathLen, newFd, newPathPtr, newPathLen) {
    const oldPath = this.resolveFdPath(oldFd, oldPathPtr, oldPathLen);
    const newPath = this.resolveFdPath(newFd, newPathPtr, newPathLen);
    if (!oldPath || !newPath) return EBADF;
    if (!this.fs.isFile(oldPath)) return ENOENT;
    this.fs.writeFile(newPath, this.fs.readFile(oldPath));
    this.fs.unlink(oldPath);
    return ESUCCESS;
  }

  path_readlink() {
    return EINVAL;
  }

  path_symlink() {
    return ENOTSUP;
  }

  path_link() {
    return ENOTSUP;
  }

  random_get(buf, bufLen) {
    const bytes = new Uint8Array(bufLen);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    }
    this.mem.writeBytes(buf, bytes);
    return ESUCCESS;
  }

  clock_time_get(_clockId, _precision, timeOut) {
    this.mem.writeU64(timeOut, BigInt(Date.now()) * 1_000_000n);
    return ESUCCESS;
  }

  poll_oneoff(_inPtr, _outPtr, _nsubscriptions, neventsOut) {
    this.mem.writeU32(neventsOut, 0);
    return ESUCCESS;
  }

  proc_exit(code) {
    throw new ProcExit(Number(code));
  }
}

async function instantiateWasi(module, process) {
  const imports = {};
  const wasiNames = [
    'args_get',
    'args_sizes_get',
    'clock_time_get',
    'environ_get',
    'environ_sizes_get',
    'fd_close',
    'fd_datasync',
    'fd_fdstat_get',
    'fd_fdstat_set_flags',
    'fd_filestat_get',
    'fd_filestat_set_size',
    'fd_pread',
    'fd_prestat_dir_name',
    'fd_prestat_get',
    'fd_pwrite',
    'fd_read',
    'fd_readdir',
    'fd_seek',
    'fd_sync',
    'fd_tell',
    'fd_write',
    'path_create_directory',
    'path_filestat_get',
    'path_filestat_set_times',
    'path_link',
    'path_open',
    'path_readlink',
    'path_remove_directory',
    'path_rename',
    'path_symlink',
    'path_unlink_file',
    'poll_oneoff',
    'proc_exit',
    'random_get',
  ];
  const wasi = Object.fromEntries(wasiNames.map((name) => [name, process.bind(name)]));

  for (const item of WebAssembly.Module.imports(module)) {
    if (item.kind !== 'function') continue;
    if (item.module === 'wasi_snapshot_preview1' || item.module === 'wasi_unstable') {
      imports[item.module] ??= {};
      imports[item.module][item.name] = wasi[item.name] || (() => ENOTSUP);
    } else if (item.module === 'env') {
      imports.env ??= {};
      imports.env[item.name] =
        item.name === 'abort'
          ? () => {
              throw new Error('abort');
            }
          : () => ENOTSUP;
    } else {
      imports[item.module] ??= {};
      imports[item.module][item.name] = () => ENOTSUP;
    }
  }

  const instance = await WebAssembly.instantiate(module, imports);
  const memory = instance.exports.memory;
  if (!memory) {
    throw new Error('WASI module did not export memory.');
  }
  process.setMemory(memory);
  return instance;
}

async function runWasi(module, args, fs, options = {}) {
  const process = new WasiProcess({
    args,
    fs,
    stdin: options.stdin || '',
    env: options.env || { USER: 'tracecode' },
    filestatSizeOffset: options.filestatSizeOffset,
  });
  const instance = await instantiateWasi(module, process);
  const start = instance.exports._start || instance.exports.__main_argc_argv || instance.exports.main;
  if (typeof start !== 'function') {
    throw new Error('WASI module does not export _start or main.');
  }

  let exitCode = 0;
  try {
    start();
  } catch (error) {
    if (error instanceof ProcExit) {
      exitCode = error.code;
    } else {
      throw error;
    }
  }

  return {
    exitCode,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function findClangResourceDir(fs) {
  const prefix = '/lib/clang/';
  const versions = [...fs.dirs]
    .filter((path) => path.startsWith(prefix) && path !== prefix)
    .map((path) => path.slice(prefix.length).split('/')[0])
    .filter(Boolean)
    .sort();
  return versions.length > 0 ? `/lib/clang/${versions[versions.length - 1]}` : '/lib/clang/8.0.1';
}

async function loadToolchain() {
  if (!configuredAssets) {
    throw new Error('C++ worker has not been initialized with toolchain asset URLs.');
  }
  if (toolchainPromise) return toolchainPromise;

  toolchainPromise = (async () => {
    const runtimeHeader = await fetchAsset('tracecode_runtime.hpp', configuredAssets.runtimeHeaderUrl, 'text');
    const injectedCompilerBundle =
      typeof globalThis !== 'undefined' ? globalThis.__tracecodeCppCompilerBundle : undefined;
    if (injectedCompilerBundle && typeof injectedCompilerBundle.runClang === 'function') {
      return {
        compiler: 'yowasp',
        runClang: injectedCompilerBundle.runClang,
        runtimeHeader,
      };
    }

    if (configuredAssets.compilerBundleUrl) {
      try {
        const compilerBundle = await import(configuredAssets.compilerBundleUrl);
        if (typeof compilerBundle.runClang === 'function') {
          return {
            compiler: 'yowasp',
            runClang: compilerBundle.runClang,
            runtimeHeader,
          };
        }
      } catch {
        // Fall back to raw clang/lld assets. This lets consumers experiment with
        // either focused compiler package without changing the public worker API.
      }
    }

    const [clangBuffer, lldBuffer, sysrootBuffer] = await Promise.all([
      fetchAsset('clang.wasm', configuredAssets.clangWasmUrl, 'arrayBuffer'),
      fetchAsset('lld.wasm', configuredAssets.lldWasmUrl, 'arrayBuffer'),
      fetchAsset('sysroot.tar', configuredAssets.sysrootUrl, 'arrayBuffer'),
    ]);

    const sysrootEntries = parseTarEntries(sysrootBuffer);
    const baseFs = new InMemoryFileSystem();
    baseFs.applyTarEntries(sysrootEntries);
    baseFs.addFile('/tracecode_runtime.hpp', runtimeHeader);
    baseFs.addFile('/tmp/tracecode_runtime.hpp', runtimeHeader);

    return {
      compiler: 'raw-wasi',
      clangModule: await WebAssembly.compile(clangBuffer),
      lldModule: await WebAssembly.compile(lldBuffer),
      baseFs,
    };
  })();

  return toolchainPromise;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function splitTopLevelCommaList(source) {
  const parts = [];
  let current = '';
  let depth = 0;
  for (const ch of source) {
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function findMatchingParen(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseMethodSignature(source, functionName) {
  const cleaned = stripComments(source);
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namePattern = new RegExp(`\\b${escaped}\\s*\\(`, 'g');
  let match = null;
  let openParenIndex = -1;
  let closeParenIndex = -1;

  while ((match = namePattern.exec(cleaned))) {
    openParenIndex = cleaned.indexOf('(', match.index);
    closeParenIndex = findMatchingParen(cleaned, openParenIndex);
    if (closeParenIndex < 0) continue;
    break;
  }

  if (!match || openParenIndex < 0 || closeParenIndex < 0) {
    throw new Error(`Unable to find C++ Solution method "${functionName}".`);
  }

  const signaturePrefix = cleaned.slice(0, match.index);
  const returnTypeMatch = signaturePrefix.match(/([A-Za-z_][\w:\s<>,*&]*?)\s*$/);
  if (!returnTypeMatch) {
    throw new Error(`Unable to parse C++ Solution method "${functionName}" return type.`);
  }

  const parameterText = cleaned.slice(openParenIndex + 1, closeParenIndex);
  const parameters = splitTopLevelCommaList(parameterText).map((parameterSource, index) => {
    const withoutDefault = parameterSource.split('=')[0].trim();
    const paramMatch = withoutDefault.match(/^(.+?)([A-Za-z_]\w*)$/);
    if (!paramMatch) {
      throw new Error(`Unable to parse C++ parameter ${index + 1}: ${parameterSource}`);
    }
    const type = paramMatch[1].trim();
    const name = paramMatch[2].trim();
    return { type, name };
  });

  const functionNameOffset = match.index;
  const line = cleaned.slice(0, functionNameOffset).split(/\r?\n/).length;
  return { returnType: returnTypeMatch[1].trim(), parameters, line };
}

function parseCppParameters(parameterText) {
  return splitTopLevelCommaList(parameterText)
    .filter((parameterSource) => parameterSource && parameterSource.trim() !== 'void')
    .map((parameterSource, index) => {
      const withoutDefault = parameterSource.split('=')[0].trim();
      const paramMatch = withoutDefault.match(/^(.+?)([A-Za-z_]\w*)$/);
      if (!paramMatch) {
        throw new Error(`Unable to parse C++ parameter ${index + 1}: ${parameterSource}`);
      }
      const type = paramMatch[1].trim();
      const name = paramMatch[2].trim();
      return { type, name };
    });
}

function parseCppFunctionSignatures(source) {
  const cleaned = stripComments(source);
  const signatures = parseCppLambdaSignatures(cleaned);
  const namePattern = /\b([A-Za-z_]\w*)\s*\(/g;
  const skippedNames = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'return',
    'sizeof',
    'decltype',
    'static_cast',
    'dynamic_cast',
    'reinterpret_cast',
    'const_cast',
  ]);
  let match;

  while ((match = namePattern.exec(cleaned))) {
    const name = match[1];
    if (skippedNames.has(name)) continue;

    const openParenIndex = cleaned.indexOf('(', match.index);
    const closeParenIndex = findMatchingParen(cleaned, openParenIndex);
    if (closeParenIndex < 0) continue;

    let cursor = closeParenIndex + 1;
    while (/\s/.test(cleaned[cursor] || '')) cursor += 1;
    while (/^(?:const|noexcept|override|final)\b/.test(cleaned.slice(cursor))) {
      const qualifier = cleaned.slice(cursor).match(/^(?:const|noexcept|override|final)\b/)?.[0] || '';
      cursor += qualifier.length;
      while (/\s/.test(cleaned[cursor] || '')) cursor += 1;
    }
    if (cleaned[cursor] !== '{') continue;

    const signaturePrefix = cleaned.slice(0, match.index);
    const returnTypeMatch = signaturePrefix.match(/([A-Za-z_][\w:\s<>,*&]*?)\s*$/);
    if (!returnTypeMatch) continue;
    const returnType = returnTypeMatch[1].trim();
    if (/^(?:class|struct|public:|private:|protected:)$/.test(returnType)) continue;

    const parameterText = cleaned.slice(openParenIndex + 1, closeParenIndex);
    const line = cleaned.slice(0, match.index).split(/\r?\n/).length;
    signatures.push({
      name,
      returnType,
      parameters: parseCppParameters(parameterText),
      line,
      bodyLine: cleaned.slice(0, cursor).split(/\r?\n/).length,
    });
    namePattern.lastIndex = closeParenIndex + 1;
  }

  return signatures.sort((left, right) => left.line - right.line || left.bodyLine - right.bodyLine);
}

function parseCppLambdaSignatures(source) {
  const signatures = [];
  const lines = source.split(/\r?\n/);
  const lambdaPattern = /\b(?:auto|(?:std::)?function\s*<[^=;]+>)\s+([A-Za-z_]\w*)\s*=\s*\[[^\]]*\]\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?\s*\{/;

  lines.forEach((line, index) => {
    const match = line.match(lambdaPattern);
    if (!match) return;
    const [, name, parameterText, returnType] = match;
    signatures.push({
      name,
      returnType: (returnType || 'auto').trim(),
      parameters: parseCppParameters(parameterText),
      line: index + 1,
      bodyLine: index + 1,
      lambda: true,
    });
  });

  return signatures;
}

function collectCppTypeAliases(source) {
  const aliases = new Map();
  const cleaned = stripComments(source);
  const usingPattern = /\busing\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g;
  let match;
  while ((match = usingPattern.exec(cleaned))) {
    aliases.set(match[1], match[2].trim());
  }

  const typedefPattern = /\btypedef\s+([^;]+?)\s+([A-Za-z_]\w*)\s*;/g;
  while ((match = typedefPattern.exec(cleaned))) {
    aliases.set(match[2], match[1].trim());
  }
  return aliases;
}

function stripCppTypeQualifiers(type) {
  return type
    .replace(/\bconst\b/g, '')
    .replace(/[&]/g, '')
    .replace(/\s+/g, '')
    .replace(/\bstd::/g, '');
}

function resolveCppType(type, aliases = new Map(), seen = new Set()) {
  const trimmed = type.trim();
  const normalized = stripCppTypeQualifiers(trimmed);
  if (aliases.has(normalized) && !seen.has(normalized)) {
    seen.add(normalized);
    return resolveCppType(aliases.get(normalized), aliases, seen);
  }
  return trimmed;
}

function normalizeCppType(type, aliases = new Map()) {
  return stripCppTypeQualifiers(resolveCppType(type, aliases));
}

function localCppType(type) {
  return type
    .replace(/\b(?:public|private|protected)\s*:\s*/g, '')
    .replace(/\bconst\b/g, '')
    .replace(/[&]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cppTraceType(type, aliases = new Map()) {
  const resolved = resolveCppType(type, aliases);
  const withoutQualifiers = resolved
    .replace(/\bconst\b/g, '')
    .replace(/[&]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = normalizeCppType(resolved, aliases);
  if (normalized.startsWith('vector<') && normalized.endsWith('>')) {
    const innerType = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::Vector<${innerType}>`;
  }
  if (normalized.startsWith('deque<') && normalized.endsWith('>')) {
    const innerType = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::Deque<${innerType}>`;
  }
  if (normalized.startsWith('queue<') && normalized.endsWith('>')) {
    const innerType = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::Queue<${innerType}>`;
  }
  if (normalized.startsWith('priority_queue<') && normalized.endsWith('>')) {
    const innerType = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::PriorityQueue<${innerType}>`;
  }
  if (normalized.startsWith('stack<') && normalized.endsWith('>')) {
    const innerType = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::Stack<${innerType}>`;
  }
  if (normalized.startsWith('unordered_map<') && normalized.endsWith('>')) {
    const innerTypes = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::UnorderedMap<${innerTypes}>`;
  }
  if (normalized.startsWith('map<') && normalized.endsWith('>')) {
    const innerTypes = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::Map<${innerTypes}>`;
  }
  if (normalized.startsWith('unordered_set<') && normalized.endsWith('>')) {
    const innerType = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::UnorderedSet<${innerType}>`;
  }
  if (normalized.startsWith('set<') && normalized.endsWith('>')) {
    const innerType = withoutQualifiers.slice(withoutQualifiers.indexOf('<') + 1, withoutQualifiers.lastIndexOf('>')).trim();
    return `tracecode::Set<${innerType}>`;
  }
  return withoutQualifiers;
}

function isVectorCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return normalized.startsWith('vector<') && normalized.endsWith('>');
}

function isDequeCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return normalized.startsWith('deque<') && normalized.endsWith('>');
}

function isAdapterCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return (
    (normalized.startsWith('queue<') && normalized.endsWith('>')) ||
    (normalized.startsWith('priority_queue<') && normalized.endsWith('>')) ||
    (normalized.startsWith('stack<') && normalized.endsWith('>'))
  );
}

function isUnorderedMapCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return normalized.startsWith('unordered_map<') && normalized.endsWith('>');
}

function isMapCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return normalized.startsWith('map<') && normalized.endsWith('>');
}

function isSetCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return (
    (normalized.startsWith('set<') && normalized.endsWith('>')) ||
    (normalized.startsWith('unordered_set<') && normalized.endsWith('>'))
  );
}

function isTraceWrappedCppType(type, aliases = new Map()) {
  return (
    isVectorCppType(type, aliases) ||
    isDequeCppType(type, aliases) ||
    isAdapterCppType(type, aliases) ||
    isUnorderedMapCppType(type, aliases) ||
    isMapCppType(type, aliases) ||
    isSetCppType(type, aliases)
  );
}

function quoteCppString(value) {
  return JSON.stringify(String(value));
}

function cppStringLiteral(value) {
  return JSON.stringify(String(value));
}

function jsonStringLiteral(value) {
  return JSON.stringify(String(value));
}

function traceBudgetForOptions(options = {}) {
  const traceOptions = options.traceOptions || {};
  const rawBudget = Number.isFinite(traceOptions.maxTraceSteps)
    ? Number(traceOptions.maxTraceSteps)
    : Number.isFinite(traceOptions.maxLineEvents)
      ? Number(traceOptions.maxLineEvents)
      : 10000;
  return Math.max(1, Math.floor(rawBudget));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildTreeObjectFromLevelOrder(values) {
  if (!Array.isArray(values) || values.length === 0 || values[0] === null || values[0] === undefined) return null;
  const root = { val: values[0], left: null, right: null };
  const queue = [root];
  let index = 1;
  while (queue.length > 0 && index < values.length) {
    const node = queue.shift();
    const leftValue = values[index++];
    if (leftValue !== null && leftValue !== undefined) {
      node.left = { val: leftValue, left: null, right: null };
      queue.push(node.left);
    }
    if (index >= values.length) break;
    const rightValue = values[index++];
    if (rightValue !== null && rightValue !== undefined) {
      node.right = { val: rightValue, left: null, right: null };
      queue.push(node.right);
    }
  }
  return root;
}

function buildListObjectFromArray(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const head = { val: values[0], next: null };
  let current = head;
  for (let index = 1; index < values.length; index += 1) {
    current.next = { val: values[index], next: null };
    current = current.next;
  }
  return head;
}

function collectSerializedNodes(root, childKeys) {
  const records = [];
  const names = new WeakMap();
  const ids = new Map();

  function visit(node) {
    if (!isRecord(node) || typeof node.__ref__ === 'string') return;
    if (names.has(node)) return;
    const name = `__tc_node_${records.length}`;
    names.set(node, name);
    records.push(node);
    if (typeof node.__id__ === 'string' && node.__id__.length > 0) {
      ids.set(node.__id__, name);
    }
    for (const key of childKeys) {
      visit(node[key]);
    }
  }

  visit(root);
  return { records, names, ids };
}

function serializedNodeValue(record) {
  return record?.val ?? record?.value ?? 0;
}

function childNodeExpression(child, names, ids) {
  if (child === null || child === undefined) return 'nullptr';
  if (isRecord(child) && typeof child.__ref__ === 'string') {
    return ids.get(child.__ref__) || 'nullptr';
  }
  if (isRecord(child) && names.has(child)) {
    return names.get(child);
  }
  return 'nullptr';
}

function buildSerializedTreeNodeLiteral(value, aliases = new Map()) {
  const root = Array.isArray(value) ? buildTreeObjectFromLevelOrder(value) : value;
  if (root === null || root === undefined) return 'nullptr';
  if (!isRecord(root)) {
    throw new Error(`Expected TreeNode object or level-order array input.`);
  }
  const { records, names, ids } = collectSerializedNodes(root, ['left', 'right']);
  if (records.length === 0) return 'nullptr';
  const lines = ['[&]() -> TreeNode* {'];
  for (const record of records) {
    lines.push(`    TreeNode* ${names.get(record)} = new TreeNode(${toCppLiteral(serializedNodeValue(record), 'int', aliases)});`);
  }
  for (const record of records) {
    const name = names.get(record);
    lines.push(`    ${name}->left = ${childNodeExpression(record.left, names, ids)};`);
    lines.push(`    ${name}->right = ${childNodeExpression(record.right, names, ids)};`);
  }
  lines.push(`    return ${names.get(root)};`);
  lines.push('  }()');
  return lines.join('\n');
}

function buildSerializedListNodeLiteral(value, aliases = new Map()) {
  const root = Array.isArray(value) ? buildListObjectFromArray(value) : value;
  if (root === null || root === undefined) return 'nullptr';
  if (!isRecord(root)) {
    throw new Error(`Expected ListNode object or array input.`);
  }
  const { records, names, ids } = collectSerializedNodes(root, ['next']);
  if (records.length === 0) return 'nullptr';
  const lines = ['[&]() -> ListNode* {'];
  for (const record of records) {
    lines.push(`    ListNode* ${names.get(record)} = new ListNode(${toCppLiteral(serializedNodeValue(record), 'int', aliases)});`);
  }
  for (const record of records) {
    lines.push(`    ${names.get(record)}->next = ${childNodeExpression(record.next, names, ids)};`);
  }
  lines.push(`    return ${names.get(root)};`);
  lines.push('  }()');
  return lines.join('\n');
}

function toCppLiteral(value, type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  if (normalized === 'TreeNode*') {
    return buildSerializedTreeNodeLiteral(value, aliases);
  }
  if (normalized === 'ListNode*') {
    return buildSerializedListNodeLiteral(value, aliases);
  }
  if (
    (
      normalized.startsWith('vector<') ||
      normalized.startsWith('array<') ||
      normalized.startsWith('deque<') ||
      normalized.startsWith('queue<') ||
      normalized.startsWith('priority_queue<') ||
      normalized.startsWith('stack<')
    ) &&
    normalized.endsWith('>')
  ) {
    if (!Array.isArray(value)) {
      throw new Error(`Expected array input for ${type}.`);
    }
    const innerType = normalized.slice(normalized.indexOf('<') + 1, -1);
    const arrayTypes = normalized.startsWith('array<') ? splitTopLevelCommaList(innerType) : null;
    const elementType = arrayTypes ? arrayTypes[0] || 'int' : innerType;
    return `{ ${value.map((entry) => toCppLiteral(entry, elementType, aliases)).join(', ')} }`;
  }
  if ((normalized.startsWith('unordered_map<') || normalized.startsWith('map<')) && normalized.endsWith('>')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Expected object input for ${type}.`);
    }
    const args = splitTopLevelCommaList(normalized.slice(normalized.indexOf('<') + 1, -1));
    const keyType = args[0] || 'string';
    const valueType = args[1] || 'int';
    return `{ ${Object.entries(value)
      .map(([key, child]) => `{ ${toCppLiteral(key, keyType, aliases)}, ${toCppLiteral(child, valueType, aliases)} }`)
      .join(', ')} }`;
  }
  if ((normalized.startsWith('unordered_set<') || normalized.startsWith('set<')) && normalized.endsWith('>')) {
    if (!Array.isArray(value)) {
      throw new Error(`Expected array input for ${type}.`);
    }
    const innerType = normalized.slice(normalized.indexOf('<') + 1, -1);
    return `{ ${value.map((entry) => toCppLiteral(entry, innerType, aliases)).join(', ')} }`;
  }
  if (normalized === 'string') return quoteCppString(value);
  if (normalized === 'char') return quoteCppString(String(value)[0] || '\0').replace(/^"/, "'").replace(/"$/, "'");
  if (normalized === 'bool') return value ? 'true' : 'false';
  if (value === null || value === undefined) return 'nullptr';
  if (/^(?:unsigned)?(?:short|int|long|longlong|longlongint|size_t|std::size_t|float|double|longdouble)$/.test(normalized)) {
    return String(value);
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return quoteCppString(value);
  throw new Error(`Unsupported C++ literal for type ${type}: ${JSON.stringify(value)}`);
}

function inputValueForParameter(inputs, parameter, index) {
  if (Object.prototype.hasOwnProperty.call(inputs, parameter.name)) return inputs[parameter.name];
  const values = Object.values(inputs || {});
  return values[index];
}

function buildGeneratedIncludes(source, signature) {
  const probe = `${source}\n${signature.parameters.map((parameter) => parameter.type).join('\n')}`;
  const includes = new Set([
    '#include "/tracecode_runtime.hpp"',
    '#include <algorithm>',
    '#include <array>',
    '#include <bitset>',
    '#include <climits>',
    '#include <cmath>',
    '#include <cstdint>',
    '#include <functional>',
    '#include <limits>',
    '#include <numeric>',
    '#include <sstream>',
    '#include <tuple>',
  ]);
  if (/\bvector\s*</.test(probe)) includes.add('#include <vector>');
  if (/\bunordered_map\s*</.test(probe)) includes.add('#include <unordered_map>');
  if (/\bunordered_set\s*</.test(probe)) includes.add('#include <unordered_set>');
  if (/\bmap\s*</.test(probe)) includes.add('#include <map>');
  if (/\bset\s*</.test(probe)) includes.add('#include <set>');
  if (/\bdeque\s*</.test(probe)) includes.add('#include <deque>');
  if (/\bqueue\s*</.test(probe)) includes.add('#include <queue>');
  if (/\bstack\s*</.test(probe)) includes.add('#include <stack>');
  if (/\bpair\s*</.test(probe)) includes.add('#include <utility>');
  if (/\bstring\b/.test(probe)) includes.add('#include <string>');
  if (/\bspan\s*</.test(probe)) includes.add('#include <span>');
  if (/\bviews::|\branges::|std::views|std::ranges/.test(probe)) includes.add('#include <ranges>');
  if (/\bconcept\b|\brequires\b/.test(probe)) includes.add('#include <concepts>');
  return [...includes].join('\n');
}

function buildTraceArgsJsonExpression(signature, variableNameForParameter = (_parameter, index) => `__tc_arg_${index}`) {
  const pieces = [];
  signature.parameters.forEach((parameter, index) => {
    const normalizedType = normalizeCppType(parameter.type);
    if (normalizedType === 'auto' || normalizedType.includes('&&auto')) return;
    const localName = variableNameForParameter(parameter, index);
    const prefix = `${pieces.length > 0 ? ',' : ''}${jsonStringLiteral(parameter.name)}:`;
    pieces.push(`${cppStringLiteral(prefix)} + tracecode::to_json(${localName})`);
  });
  return pieces.length > 0 ? pieces.join(' + ') : cppStringLiteral('');
}

function stripCppStringsAndComments(line) {
  return line
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/\/\/.*$/, '');
}

function braceDeltaForLine(line) {
  const stripped = stripCppStringsAndComments(line);
  let delta = 0;
  for (const ch of stripped) {
    if (ch === '{') delta += 1;
    if (ch === '}') delta -= 1;
  }
  return delta;
}

function shouldInstrumentCppLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#') || trimmed.startsWith('//')) return false;
  if (/^(public|private|protected)\s*:/.test(trimmed)) return false;
  if (/^(else|catch)\b/.test(trimmed)) return false;
  if (/^(case\b|default\s*:)/.test(trimmed)) return false;
  if (/^[{};]+$/.test(trimmed)) return false;
  if (/^};?$/.test(trimmed)) return false;
  return (
    /;$/.test(trimmed) ||
    /^(if|for|while|switch)\s*\(/.test(trimmed) ||
    /^do\b/.test(trimmed) ||
    /^return\b/.test(trimmed)
  );
}

function buildLineInstrumentation(lineNumber, functionName) {
  return `tracecode::TraceHooks::emitPostLineFrame(${lineNumber}, ${cppStringLiteral(functionName)});`;
}

function buildCurrentLineInstrumentation(lineNumber) {
  return `tracecode::TraceHooks::setCurrentLine(${lineNumber});`;
}

function isSnapshotSerializableCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  if (!normalized || normalized === 'void') return false;
  if (normalized === 'auto' || normalized.includes('auto&&') || normalized.includes('function<')) return false;
  if (normalized === 'TreeNode*' || normalized === 'ListNode*') return true;
  if (/^(?:bool|char|string|size_t|std::size_t|(?:unsigned)?(?:short|int|long|longlong|longlongint)|float|double|longdouble)$/.test(normalized)) {
    return true;
  }
  return (
    normalized.startsWith('vector<') ||
    normalized.startsWith('array<') ||
    normalized.startsWith('deque<') ||
    normalized.startsWith('queue<') ||
    normalized.startsWith('priority_queue<') ||
    normalized.startsWith('stack<') ||
    normalized.startsWith('unordered_map<') ||
    normalized.startsWith('map<') ||
    normalized.startsWith('unordered_set<') ||
    normalized.startsWith('set<') ||
    normalized.startsWith('pair<') ||
    normalized.startsWith('tuple<')
  );
}

function buildSnapshotInstrumentation(lineNumber, variables, currentDepth) {
  return [...variables.entries()]
    .filter(([, variable]) => variable.scopeDepth <= currentDepth)
    .map(([name]) => `tracecode::emit_snapshot_value(${cppStringLiteral(name)}, ${name}, ${lineNumber});`)
    .join('\n');
}

function buildOpaqueObjectSnapshotInstrumentation(name, lineNumber, indent = '') {
  return `${indent}tracecode::write_trace_event_json(std::string(${cppStringLiteral(`{"kind":"snapshot","line":${lineNumber},"target":{"variable":${jsonStringLiteral(name)}},"value":{}}`)}), ${lineNumber});`;
}

function buildFieldTargetJsonExpression(objectName, fieldName, keyExpression) {
  if (keyExpression) {
    return `std::string(${cppStringLiteral(`{"variable":${jsonStringLiteral(objectName)},"path":[${jsonStringLiteral(fieldName)},`)}) + tracecode::to_json(${keyExpression}) + "]}"`;
  }
  return `std::string(${cppStringLiteral(`{"variable":${jsonStringLiteral(objectName)},"path":[${jsonStringLiteral(fieldName)}]}`)})`;
}

function parseFieldAccessExpression(expression) {
  const trimmed = expression.trim();
  const match = trimmed.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)(?:\s*\[\s*(.+?)\s*\])?$/);
  if (!match) return null;
  return {
    objectName: match[1],
    fieldName: match[2],
    keyExpression: match[3]?.trim(),
  };
}

function buildFieldReadInstrumentation(expression, valueExpression, lineNumber, indent = '') {
  const access = parseFieldAccessExpression(expression);
  if (!access) return '';
  const targetExpression = buildFieldTargetJsonExpression(access.objectName, access.fieldName, access.keyExpression);
  return [
    `${indent}tracecode::write_trace_event_json(std::string(${cppStringLiteral(`{"kind":"read","line":${lineNumber},"target":`)}) + ${targetExpression} + ",\\\"value\\\":" + tracecode::to_json(${valueExpression}) + "}", ${lineNumber});`,
    buildOpaqueObjectSnapshotInstrumentation(access.objectName, lineNumber, indent),
  ].join('\n');
}

function rewriteFieldWriteInstrumentation(line, lineNumber) {
  const match = line.match(/^(\s*)([A-Za-z_]\w*)\.([A-Za-z_]\w*)(?:\s*\[\s*(.+?)\s*\])?\s*=\s*(.+?)\s*;\s*$/);
  if (!match) return line;
  const [, indent, objectName, fieldName, keyExpression] = match;
  const targetExpression = buildFieldTargetJsonExpression(objectName, fieldName, keyExpression?.trim());
  const valueExpression = keyExpression
    ? `${objectName}.${fieldName}[${keyExpression.trim()}]`
    : `${objectName}.${fieldName}`;
  return [
    line,
    `${indent}tracecode::write_trace_event_json(std::string(${cppStringLiteral(`{"kind":"write","line":${lineNumber},"target":`)}) + ${targetExpression} + ",\\\"value\\\":" + tracecode::to_json(${valueExpression}) + "}", ${lineNumber});`,
    buildOpaqueObjectSnapshotInstrumentation(objectName, lineNumber, indent),
  ].join('\n');
}

function buildCallInstrumentation(lineNumber, signature) {
  const callEventPrefix = `{"kind":"call","line":${lineNumber},"function":${jsonStringLiteral(signature.name)},"args":`;
  const argsExpression = buildTraceArgsJsonExpression(signature, (parameter) => parameter.name);
  return [
    `std::string __tc_args_json_${lineNumber} = std::string("{") + ${argsExpression} + "}";`,
    `tracecode::write_trace_event_json(std::string(${cppStringLiteral(callEventPrefix)}) + __tc_args_json_${lineNumber} + "}", ${lineNumber});`,
  ].join('\n');
}

function buildReturnInstrumentation(lineNumber, signature) {
  const returnEventPrefix = `{"kind":"return","line":${lineNumber},"function":${jsonStringLiteral(signature.name)}`;
  return `tracecode::write_trace_event_json(std::string(${cppStringLiteral(`${returnEventPrefix}}`)}), ${lineNumber});`;
}

function buildPostLineInstrumentation(lineNumber, functionName, variables, currentDepth, indent = '') {
  const pieces = [
    `${indent}${buildLineInstrumentation(lineNumber, functionName)}`,
  ];
  const snapshots = buildSnapshotInstrumentation(lineNumber, variables, currentDepth);
  if (snapshots) {
    pieces.push(snapshots
      .split('\n')
      .filter(Boolean)
      .map((line) => `${indent}${line}`)
      .join('\n'));
  }
  return pieces.join('\n');
}

function buildValueReturnInstrumentation(expression, lineNumber, signature, indent = '', postLineInstrumentation = '') {
  const returnEventPrefix = `{"kind":"return","line":${lineNumber},"function":${jsonStringLiteral(signature.name)},"value":`;
  const returnStorageType = signature.returnType && signature.returnType.trim() !== 'auto'
    ? localCppType(signature.returnType)
    : 'auto';
  const trimmedExpression = expression.trim();
  const returnDeclaration =
    returnStorageType !== 'auto' && trimmedExpression.startsWith('{') && trimmedExpression.endsWith('}')
      ? `${returnStorageType} __tc_return_${lineNumber} ${trimmedExpression};`
      : `${returnStorageType} __tc_return_${lineNumber} = (${expression});`;
  return [
    `${indent}${returnDeclaration}`,
    buildFieldReadInstrumentation(trimmedExpression, `__tc_return_${lineNumber}`, lineNumber, indent),
    postLineInstrumentation,
    `${indent}tracecode::write_trace_event_json(std::string(${cppStringLiteral(returnEventPrefix)}) + tracecode::to_json(__tc_return_${lineNumber}) + "}", ${lineNumber});`,
    `${indent}return __tc_return_${lineNumber};`,
  ].filter(Boolean).join('\n');
}

function rewriteReturnInstrumentation(line, lineNumber, signature, postLineInstrumentation = '') {
  const match = line.match(/^(\s*)return(?:\s+(.+?))?\s*;\s*$/);
  if (!match) return line;
  const [, indent, expression] = match;
  if (!expression) {
    return [
      postLineInstrumentation,
      `${indent}${buildReturnInstrumentation(lineNumber, signature)}`,
      `${indent}return;`,
    ].filter(Boolean).join('\n');
  }
  return buildValueReturnInstrumentation(expression, lineNumber, signature, indent, postLineInstrumentation);
}

function rewriteSingleLineControlReturn(line, lineNumber, signature, postLineInstrumentation = '') {
  const match = line.match(/^(\s*)((?:else\s+if|if|for|while)\s*\(.*\)|else)\s+return(?:\s+(.+?))?\s*;\s*$/);
  if (!match) return line;
  const [, indent, control, expression] = match;
  if (/^\s*(?:do|switch)\b/.test(line)) return line;
  const innerIndent = `${indent}  `;
  if (!expression) {
    return [
      `${indent}${control} {`,
      `${innerIndent}${buildCurrentLineInstrumentation(lineNumber)}`,
      postLineInstrumentation,
      `${innerIndent}${buildReturnInstrumentation(lineNumber, signature)}`,
      `${innerIndent}return;`,
      `${indent}}`,
    ].join('\n');
  }
  return [
    `${indent}${control} {`,
    `${innerIndent}${buildCurrentLineInstrumentation(lineNumber)}`,
    buildValueReturnInstrumentation(expression, lineNumber, signature, innerIndent, postLineInstrumentation),
    `${indent}}`,
  ].join('\n');
}

function rewriteBracedSingleLineControlReturn(line, lineNumber, signature, postLineInstrumentation = '') {
  const match = line.match(/^(\s*)((?:else\s+if|if|for|while)\s*\(.*\)|else)\s*\{\s*return(?:\s+(.+?))?\s*;\s*\}\s*$/);
  if (!match) return line;
  const [, indent, control, expression] = match;
  const innerIndent = `${indent}  `;
  if (!expression) {
    return [
      `${indent}${control} {`,
      `${innerIndent}${buildCurrentLineInstrumentation(lineNumber)}`,
      postLineInstrumentation,
      `${innerIndent}${buildReturnInstrumentation(lineNumber, signature)}`,
      `${innerIndent}return;`,
      `${indent}}`,
    ].join('\n');
  }
  return [
    `${indent}${control} {`,
    `${innerIndent}${buildCurrentLineInstrumentation(lineNumber)}`,
    buildValueReturnInstrumentation(expression, lineNumber, signature, innerIndent, postLineInstrumentation),
    `${indent}}`,
  ].join('\n');
}

function rewriteControlTransferInstrumentation(line, lineNumber, postLineInstrumentation = '') {
  const match = line.match(/^(\s*)(break|continue)\s*;\s*$/);
  if (!match) return line;
  const [, indent, control] = match;
  return [
    `${indent}tracecode::write_trace_event_json(std::string(${cppStringLiteral(`{"kind":"control","line":${lineNumber},"control":"${control}"}`)}), ${lineNumber});`,
    postLineInstrumentation,
    `${indent}${control};`,
  ].filter(Boolean).join('\n');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteTraceContainerParameters(line, signature, aliases = new Map()) {
  let rewritten = line;
  for (const parameter of signature.parameters) {
    if (!isTraceWrappedCppType(parameter.type, aliases)) continue;
    const typePattern = escapeRegExp(parameter.type).replace(/\\\s+/g, '\\s+');
    const pattern = new RegExp(`${typePattern}\\s+${escapeRegExp(parameter.name)}\\b`);
    rewritten = rewritten.replace(pattern, `${cppTraceType(parameter.type, aliases)}& ${parameter.name}`);
  }
  return rewritten;
}

function rewriteSingleLineControlBody(line, lineNumber, functionName, postLineInstrumentation = '', emitInsideBody = false) {
  const match = line.match(/^(\s*)((?:else\s+if|if|for|while)\s*\(.*\)|else)\s+([^{}].*;\s*)$/);
  if (!match) return line;
  const [, indent, control, statement] = match;
  if (/^\s*(?:do|switch)\b/.test(line)) return line;
  const controlTransfer = statement.trim().match(/^(break|continue)\s*;$/);
  if (controlTransfer) {
    const transfer = controlTransfer[1];
    return `${indent}${control} { ${buildCurrentLineInstrumentation(lineNumber)} tracecode::write_trace_event_json(std::string(${cppStringLiteral(`{"kind":"control","line":${lineNumber},"control":"${transfer}"}`)}), ${lineNumber}); ${postLineInstrumentation} ${transfer}; }`;
  }
  if (emitInsideBody) {
    return `${indent}${control} { ${buildCurrentLineInstrumentation(lineNumber)} ${statement.trim()} ${postLineInstrumentation} }`;
  }
  return `${indent}${control} { ${statement.trim()} }`;
}

function rewriteBracedSingleLineControlBody(line, lineNumber, postLineInstrumentation = '') {
  const match = line.match(/^(\s*)((?:else\s+if|if|for|while)\s*\(.*\)|else)\s*\{\s*([^{}].*;\s*)\}\s*$/);
  if (!match) return line;
  const [, indent, control, statement] = match;
  if (/^\s*(?:do|switch)\b/.test(line)) return line;
  return `${indent}${control} { ${buildCurrentLineInstrumentation(lineNumber)} ${statement.trim()} ${postLineInstrumentation} }`;
}

function findContainerDeclarationSemicolon(lines, startIndex) {
  let candidate = '';
  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    candidate += `${index === startIndex ? '' : '\n'}${line}`;
    for (const ch of stripCppStringsAndComments(line)) {
      if (ch === '<' || ch === '(' || ch === '{' || ch === '[') depth += 1;
      if (ch === '>' || ch === ')' || ch === '}' || ch === ']') depth -= 1;
      if (ch === ';' && depth <= 0) return { text: candidate, endIndex: index };
    }
  }
  return null;
}

function rewriteTraceMultipleContainerLocals(line, lineNumber, aliases = new Map()) {
  const collapsed = line.replace(/\s*\n\s*/g, ' ');
  const match = collapsed.match(/^(\s*)((?:(?:std::)?(?:vector|deque|queue|priority_queue|stack|unordered_map|map|unordered_set|set)\s*<.+>|[A-Za-z_]\w*))\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)+)\s*;\s*$/);
  if (!match) return line;
  const [, indent, declaredType, namesSource] = match;
  if (!isTraceWrappedCppType(declaredType, aliases)) return line;
  const type = cppTraceType(declaredType, aliases);
  return namesSource
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => `${indent}${type} ${name}(${cppStringLiteral(name)}, ${lineNumber});`)
    .join('\n');
}

function rewriteTraceContainerLocal(line, lineNumber, aliases = new Map()) {
  const collapsed = line.replace(/\s*\n\s*/g, ' ');
  const multiple = rewriteTraceMultipleContainerLocals(collapsed, lineNumber, aliases);
  if (multiple !== collapsed) return multiple;
  let match = collapsed.match(/^(\s*)((?:(?:std::)?(?:vector|deque|queue|priority_queue|stack|unordered_map|map|unordered_set|set)\s*<.+>|[A-Za-z_]\w*))\s+([A-Za-z_]\w*)\s*(?:\((.*)\)|=\s*(.+)|(\{.*\}))?\s*;\s*$/);
  if (!match) return line;
  const [, indent, declaredType, name, constructorArgs, assignedValue, bracedValue] = match;
  if (!isTraceWrappedCppType(declaredType, aliases)) return line;
  const normalized = normalizeCppType(declaredType, aliases);
  const kind = normalized.slice(0, normalized.indexOf('<'));
  const initializerType = resolveCppType(declaredType, aliases)
    .replace(/\bconst\b/g, '')
    .replace(/[&]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const initializer = constructorArgs ? `${initializerType}(${constructorArgs})` : assignedValue || bracedValue;
  const type = cppTraceType(declaredType, aliases);
  if ((kind === 'queue' || kind === 'priority_queue' || kind === 'stack') && initializer && initializer.trim() !== '{}') {
    return line;
  }
  if (!initializer || initializer.trim() === '{}') {
    return `${indent}${type} ${name}(${cppStringLiteral(name)}, ${lineNumber});`;
  }
  return `${indent}${type} ${name}(${initializer.trim()}, ${cppStringLiteral(name)}, ${lineNumber});`;
}

function rewriteTraceContainerMember(line, lineNumber, aliases = new Map(), activeClassName = null, traceMemberClassName = null) {
  if (!activeClassName || activeClassName !== traceMemberClassName) return line;
  const collapsed = line.replace(/\s*\n\s*/g, ' ');
  const match = collapsed.match(/^(\s*)((?:(?:std::)?(?:vector|deque|queue|priority_queue|stack|unordered_map|map|unordered_set|set)\s*<.+>|[A-Za-z_]\w*))\s+([A-Za-z_]\w*)\s*(?:=\s*(.+)|(\{.*\}))?\s*;\s*$/);
  if (!match) return line;
  const [, indent, declaredType, name, assignedValue, bracedValue] = match;
  if (!isTraceWrappedCppType(declaredType, aliases)) return line;
  const normalized = normalizeCppType(declaredType, aliases);
  const kind = normalized.slice(0, normalized.indexOf('<'));
  if (
    kind !== 'vector' &&
    kind !== 'deque' &&
    kind !== 'queue' &&
    kind !== 'priority_queue' &&
    kind !== 'stack' &&
    kind !== 'unordered_map' &&
    kind !== 'map' &&
    kind !== 'set' &&
    kind !== 'unordered_set'
  ) return line;
  const initializerType = resolveCppType(declaredType, aliases)
    .replace(/\bconst\b/g, '')
    .replace(/[&]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const initializer = assignedValue || bracedValue;
  const type = cppTraceType(declaredType, aliases);
  if (!initializer || initializer.trim() === '{}') {
    return `${indent}${type} ${name}{${cppStringLiteral('this')}, ${cppStringLiteral(name)}, ${lineNumber}};`;
  }
  return `${indent}${type} ${name}{${initializerType}(${initializer.trim()}), ${cppStringLiteral('this')}, ${cppStringLiteral(name)}, ${lineNumber}};`;
}

function getOpsClassInputs(inputs = {}) {
  const operations = Array.isArray(inputs.operations)
    ? inputs.operations
    : Array.isArray(inputs.ops)
      ? inputs.ops
      : null;
  const argumentsList = Array.isArray(inputs.arguments)
    ? inputs.arguments
    : Array.isArray(inputs.args)
      ? inputs.args
      : null;
  if (!operations || !argumentsList) {
    throw new Error('C++ ops-class execution requires inputs.operations and inputs.arguments (or ops/args).');
  }
  if (operations.length !== argumentsList.length) {
    throw new Error('C++ ops-class operations and arguments must have the same length.');
  }
  return { operations, argumentsList };
}

function normalizeOpsArguments(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function buildOpsClassDriverSource(userCode, className, inputs, options = {}) {
  const aliases = collectCppTypeAliases(userCode);
  const { operations, argumentsList } = getOpsClassInputs(inputs || {});
  if (operations.length === 0 || operations[0] !== className) {
    throw new Error(`C++ ops-class inputs must start with constructor operation "${className}".`);
  }

  const firstMethod = operations.slice(1).find((operation) => typeof operation === 'string' && operation.trim());
  const sourceForDriver = options.tracing === true && firstMethod
    ? instrumentCppSourceForTracing(userCode, firstMethod, { traceMemberClassName: className })
    : userCode;
  const lines = [];
  const constructorArgs = normalizeOpsArguments(argumentsList[0]);
  lines.push(`  tracecode::configure_trace_budget(${traceBudgetForOptions(options)});`);
  const constructorArgsSource = constructorArgs.map((value) => toCppLiteral(value, 'auto', aliases)).join(', ');
  lines.push(constructorArgs.length === 0
    ? `  ${className} __tc_instance;`
    : `  ${className} __tc_instance(${constructorArgsSource});`);
  lines.push('  std::vector<std::string> __tc_outputs;');
  lines.push('  __tc_outputs.push_back("null");');

  for (let index = 1; index < operations.length; index += 1) {
    const operation = operations[index];
    if (typeof operation !== 'string' || !operation.trim()) {
      throw new Error(`C++ ops-class operation at index ${index} must be a method name.`);
    }
    const signature = parseMethodSignature(userCode, operation);
    const args = normalizeOpsArguments(argumentsList[index]);
    if (args.length !== signature.parameters.length) {
      throw new Error(`C++ ops-class method "${operation}" expected ${signature.parameters.length} args, received ${args.length}.`);
    }
    const argNames = [];
    signature.parameters.forEach((parameter, argIndex) => {
      const localName = `__tc_op_${index}_arg_${argIndex}`;
      const declarationType = options.tracing === true && isTraceWrappedCppType(parameter.type, aliases)
        ? cppTraceType(parameter.type, aliases)
        : localCppType(parameter.type);
      const value = args[argIndex];
      if (options.tracing === true && isTraceWrappedCppType(parameter.type, aliases)) {
        lines.push(`  ${declarationType} ${localName}(${toCppLiteral(value, parameter.type, aliases)}, ${cppStringLiteral(parameter.name)}, ${signature.line});`);
      } else {
        lines.push(`  ${declarationType} ${localName} = ${toCppLiteral(value, parameter.type, aliases)};`);
      }
      argNames.push(localName);
    });
    if (options.tracing === true) {
      const callEventPrefix = `{"kind":"call","line":${signature.line},"function":${jsonStringLiteral(operation)},"args":`;
      lines.push(`  std::string __tc_args_json_${index} = std::string("{") + ${buildTraceArgsJsonExpression(signature, (_parameter, argIndex) => `__tc_op_${index}_arg_${argIndex}`)} + "}";`);
      lines.push(`  tracecode::write_trace_event_json(std::string(${cppStringLiteral(callEventPrefix)}) + __tc_args_json_${index} + "}", ${signature.line});`);
    }
    if (normalizeCppType(signature.returnType, aliases) === 'void') {
      lines.push(`  __tc_instance.${operation}(${argNames.join(', ')});`);
      lines.push('  __tc_outputs.push_back("null");');
    } else {
      lines.push(`  auto __tc_op_${index}_result = __tc_instance.${operation}(${argNames.join(', ')});`);
      lines.push(`  __tc_outputs.push_back(tracecode::to_json(__tc_op_${index}_result));`);
    }
  }
  lines.push('  std::string __tc_result_json = "[";');
  lines.push('  for (std::size_t __tc_i = 0; __tc_i < __tc_outputs.size(); ++__tc_i) {');
  lines.push('    if (__tc_i > 0) __tc_result_json += ",";');
  lines.push('    __tc_result_json += __tc_outputs[__tc_i];');
  lines.push('  }');
  lines.push('  __tc_result_json += "]";');
  lines.push('  tracecode::write_result_json_raw(__tc_result_json);');

return `${buildGeneratedIncludes(userCode, { parameters: [] })}
using namespace std;
using namespace tracecode;

#line 1 "UserCode.cpp"
${sourceForDriver}

#line 1 "TraceCodeDriver.cpp"
int main() {
${lines.join('\n')}
  return 0;
}
`;
}

function extractDeclaredSnapshotVariables(line, aliases = new Map()) {
  const variables = [];
  const collapsed = line.replace(/\s*\n\s*/g, ' ').trim();
  if (!collapsed || collapsed.startsWith('//')) return variables;

  const rangeMatch = collapsed.match(/^(?:for)\s*\(\s*([^:;]+?)\s+([A-Za-z_]\w*)\s*:\s*.+\)/);
  if (rangeMatch) {
    if (!collapsed.includes('{')) return variables;
    const [, type, name] = rangeMatch;
    if (isSnapshotSerializableCppType(type, aliases)) variables.push({ name, type });
    return variables;
  }

  const forInitMatch = collapsed.match(/^for\s*\(\s*([^;]+);/);
  if (forInitMatch) {
    variables.push(...extractDeclaredSnapshotVariables(`${forInitMatch[1]};`, aliases));
    return variables;
  }

  const declarationMatch = collapsed.match(/^((?:(?:const|unsigned|long|short|signed)\s+)*(?:(?:std::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)?(?:\s*<.+>)?(?:\s*\*)?))\s+(.+);\s*$/);
  if (!declarationMatch) return variables;
  const [, rawType, declaratorsSource] = declarationMatch;
  if (!isSnapshotSerializableCppType(rawType, aliases)) return variables;
  for (const declarator of splitTopLevelCommaList(declaratorsSource)) {
    const nameMatch = declarator.trim().match(/^([A-Za-z_]\w*)\b/);
    if (nameMatch) variables.push({ name: nameMatch[1], type: rawType });
  }
  return variables;
}

function instrumentCppSourceForTracing(source, functionName, options = {}) {
  const aliases = collectCppTypeAliases(source);
  const targetSignature = parseMethodSignature(source, functionName);
  const signatures = parseCppFunctionSignatures(source);
  if (!signatures.some((signature) => signature.line === targetSignature.line && signature.name === functionName)) {
    signatures.push({
      ...targetSignature,
      name: functionName,
      bodyLine: targetSignature.line,
    });
    signatures.sort((left, right) => left.line - right.line || left.bodyLine - right.bodyLine);
  }
  const lines = source.split(/\r?\n/);
  const output = [];
  let nextSignatureIndex = 0;
  let pendingSignature = null;
  const frameStack = [];
  const classStack = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const activeFrame = frameStack.at(-1) || null;
    const activeSignature = activeFrame?.signature || null;
    const activeClassName = classStack.at(-1)?.name || null;
    if (!pendingSignature && nextSignatureIndex < signatures.length && lineNumber >= signatures[nextSignatureIndex].line) {
      pendingSignature = signatures[nextSignatureIndex];
      nextSignatureIndex += 1;
    }

    const inFunctionBodyBeforeLine = Boolean(activeFrame) && activeFrame.depth > 0;
    const trimmedLine = line.trim();
    const nextSourceLine = lines[index + 1]?.trim() || '';
    const lineStartsElse = /^else\b/.test(trimmedLine);
    const shouldInstrumentLine = inFunctionBodyBeforeLine && !lineStartsElse && shouldInstrumentCppLine(line);
    if (shouldInstrumentLine) {
      output.push(`#line ${lineNumber} "UserCode.cpp"`);
      output.push(buildCurrentLineInstrumentation(lineNumber));
    }

    let lineForDriver = pendingSignature
      ? rewriteTraceContainerParameters(line, pendingSignature, aliases)
      : line;
    if (inFunctionBodyBeforeLine) {
      const declaration = findContainerDeclarationSemicolon(lines, index);
      if (declaration) {
        const rewrittenDeclaration = rewriteTraceContainerLocal(declaration.text, lineNumber, aliases);
        if (rewrittenDeclaration !== declaration.text) {
          output.push(`#line ${lineNumber} "UserCode.cpp"`);
          output.push(buildCurrentLineInstrumentation(lineNumber));
          output.push(rewrittenDeclaration);
          for (const variable of extractDeclaredSnapshotVariables(declaration.text, aliases)) {
            activeFrame.variables.set(variable.name, { type: variable.type, scopeDepth: activeFrame.depth });
          }
          if (shouldInstrumentCppLine(declaration.text)) {
            output.push(buildPostLineInstrumentation(lineNumber, activeSignature.name, activeFrame.variables, activeFrame.depth));
          }
          index = declaration.endIndex;
          continue;
        }
      }
      lineForDriver = rewriteTraceContainerLocal(line, lineNumber, aliases);
      const lineDelta = braceDeltaForLine(line);
      const declaredScopeDepth = activeFrame.depth + Math.max(0, lineDelta);
      for (const variable of extractDeclaredSnapshotVariables(line, aliases)) {
        activeFrame.variables.set(variable.name, { type: variable.type, scopeDepth: declaredScopeDepth });
      }
      const postLineInstrumentation = (shouldInstrumentLine || lineStartsElse)
        ? buildPostLineInstrumentation(lineNumber, activeSignature.name, activeFrame.variables, activeFrame.depth)
        : '';
      lineForDriver = rewriteBracedSingleLineControlReturn(lineForDriver, lineNumber, activeSignature, postLineInstrumentation);
      lineForDriver = rewriteSingleLineControlReturn(lineForDriver, lineNumber, activeSignature, postLineInstrumentation);
      lineForDriver = rewriteBracedSingleLineControlBody(lineForDriver, lineNumber, postLineInstrumentation);
      lineForDriver = rewriteSingleLineControlBody(
        lineForDriver,
        lineNumber,
        activeSignature.name,
        postLineInstrumentation,
        lineStartsElse || nextSourceLine.startsWith('else') || /^(?:for|while)\s*\(/.test(trimmedLine)
      );
      lineForDriver = rewriteControlTransferInstrumentation(lineForDriver, lineNumber, postLineInstrumentation);
      lineForDriver = rewriteFieldWriteInstrumentation(lineForDriver, lineNumber);
      lineForDriver = rewriteReturnInstrumentation(lineForDriver, lineNumber, activeSignature, postLineInstrumentation);
    } else {
      lineForDriver = rewriteTraceContainerMember(
        lineForDriver,
        lineNumber,
        aliases,
        activeClassName,
        options.traceMemberClassName || 'Solution'
      );
    }

    const closesActiveVoidHelper =
      inFunctionBodyBeforeLine &&
      normalizeCppType(activeSignature.returnType, aliases) === 'void' &&
      activeFrame.depth + braceDeltaForLine(line) <= 0;
    if (closesActiveVoidHelper) {
      output.push(`#line ${lineNumber} "UserCode.cpp"`);
      output.push(buildLineInstrumentation(lineNumber, activeSignature.name));
      output.push(buildReturnInstrumentation(lineNumber, activeSignature));
    }

    output.push(`#line ${lineNumber} "UserCode.cpp"`);
    output.push(lineForDriver);
    if (
      shouldInstrumentLine &&
      !nextSourceLine.startsWith('else') &&
      !/^\s*(?:return|break|continue)\b/.test(trimmedLine)
    ) {
      output.push(buildPostLineInstrumentation(lineNumber, activeSignature.name, activeFrame.variables, activeFrame.depth));
    }

    if (pendingSignature || frameStack.length > 0) {
      const delta = braceDeltaForLine(line);
      if (pendingSignature && delta > 0) {
        const nextSignature = pendingSignature;
        pendingSignature = null;
        const variables = new Map();
        for (const parameter of nextSignature.parameters) {
          if (isSnapshotSerializableCppType(parameter.type, aliases)) {
            variables.set(parameter.name, { type: parameter.type, scopeDepth: 1 });
          }
        }
        frameStack.push({ signature: nextSignature, depth: delta, variables });
        if (
          delta > 0 &&
          (nextSignature.name !== functionName || nextSignature.line !== targetSignature.line)
        ) {
          output.push(`#line ${lineNumber} "UserCode.cpp"`);
          output.push(buildCallInstrumentation(lineNumber, nextSignature));
        }
      } else if (frameStack.length > 0) {
        const frame = frameStack[frameStack.length - 1];
        frame.depth += delta;
        for (const [name, variable] of frame.variables) {
          if (variable.scopeDepth > frame.depth) frame.variables.delete(name);
        }
        while (frameStack.length > 0 && frameStack[frameStack.length - 1].depth <= 0) {
          frameStack.pop();
        }
      }
    }

    const classDecl = stripCppStringsAndComments(line).match(/\b(?:class|struct)\s+([A-Za-z_]\w*)\b/);
    const classDelta = braceDeltaForLine(line);
    if (classDecl && classDelta > 0) {
      classStack.push({ name: classDecl[1], depth: classDelta });
    } else if (classStack.length > 0) {
      classStack[classStack.length - 1].depth += classDelta;
      while (classStack.length > 0 && classStack[classStack.length - 1].depth <= 0) {
        classStack.pop();
      }
    }
  }

  return output.join('\n');
}

function buildDriverSource(userCode, functionName, inputs, options = {}) {
  const aliases = collectCppTypeAliases(userCode);
  const signature = parseMethodSignature(userCode, functionName);
  const traced = options.tracing === true;
  const sourceForDriver = options.tracing === true ? instrumentCppSourceForTracing(userCode, functionName) : userCode;
  const declarations = [];
  const argumentNames = [];

  signature.parameters.forEach((parameter, index) => {
    const localName = `__tc_arg_${index}`;
    const declarationType = traced && isTraceWrappedCppType(parameter.type, aliases) ? cppTraceType(parameter.type, aliases) : localCppType(parameter.type);
    const value = inputValueForParameter(inputs, parameter, index);
    if (traced && isTraceWrappedCppType(parameter.type, aliases)) {
      declarations.push(`  ${declarationType} ${localName}(${toCppLiteral(value, parameter.type, aliases)}, ${cppStringLiteral(parameter.name)}, ${signature.line});`);
    } else {
      declarations.push(`  ${declarationType} ${localName} = ${toCppLiteral(value, parameter.type, aliases)};`);
    }
    argumentNames.push(localName);
  });

  const callEventPrefix = `{"kind":"call","line":${signature.line},"function":${jsonStringLiteral(functionName)},"args":`;
  const returnEventPrefix = `{"kind":"return","line":${signature.line},"function":${jsonStringLiteral(functionName)},"value":`;
  const traceCall = traced
    ? [
        `  tracecode::configure_trace_budget(${traceBudgetForOptions(options)});`,
        `  std::string __tc_args_json = std::string("{") + ${buildTraceArgsJsonExpression(signature)} + "}";`,
        `  tracecode::write_trace_event_json(std::string(${cppStringLiteral(callEventPrefix)}) + __tc_args_json + "}", ${signature.line});`,
        `  tracecode::emit_line(${signature.line}, ${cppStringLiteral(functionName)});`,
      ].join('\n')
    : '';
  const traceReturn = traced
    ? `  tracecode::write_trace_event_json(std::string(${cppStringLiteral(returnEventPrefix)}) + tracecode::to_json(__tc_result) + "}", ${signature.line});`
    : '';

return `${buildGeneratedIncludes(userCode, signature)}
using namespace std;
using namespace tracecode;

#line 1 "UserCode.cpp"
${sourceForDriver}

#line 1 "TraceCodeDriver.cpp"
int main() {
  Solution solution;
${declarations.join('\n')}
${traceCall}
  auto __tc_result = solution.${functionName}(${argumentNames.join(', ')});
${traceReturn}
  tracecode::write_result_json(__tc_result);
  return 0;
}
`;
}

function splitMarkerLine(text, markerIndex, marker) {
  const afterMarker = text.slice(markerIndex + marker.length);
  const markerLineEnd = afterMarker.search(/\r?\n/);
  if (markerLineEnd < 0) {
    return {
      payload: afterMarker,
      nextIndex: text.length,
    };
  }
  return {
    payload: afterMarker.slice(0, markerLineEnd),
    nextIndex: markerIndex + marker.length + markerLineEnd + (afterMarker[markerLineEnd] === '\r' ? 2 : 1),
  };
}

function appendConsoleChunk(chunk, consoleOutput, traceEvents, defaultLine) {
  for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
    consoleOutput.push(line);
    if (traceEvents) {
      traceEvents.push({
        kind: 'stdout',
        line: defaultLine,
        text: line,
      });
    }
  }
}

function parseProgramStdout(stdout, options = {}) {
  const consoleOutput = [];
  const traceEvents = options.tracing ? [] : null;
  let output = null;
  let foundResult = false;
  let cursor = 0;

  while (cursor < stdout.length) {
    const resultIndex = stdout.indexOf(RESULT_MARKER, cursor);
    const traceIndex = stdout.indexOf(TRACE_EVENT_MARKER, cursor);
    const markerIndex =
      resultIndex < 0
        ? traceIndex
        : traceIndex < 0
          ? resultIndex
          : Math.min(resultIndex, traceIndex);

    if (markerIndex < 0) {
      appendConsoleChunk(stdout.slice(cursor), consoleOutput, traceEvents, options.defaultLine ?? 1);
      break;
    }

    appendConsoleChunk(stdout.slice(cursor, markerIndex), consoleOutput, traceEvents, options.defaultLine ?? 1);

    if (markerIndex === resultIndex) {
      const marker = splitMarkerLine(stdout, markerIndex, RESULT_MARKER);
      output = marker.payload ? JSON.parse(marker.payload) : null;
      foundResult = true;
      cursor = marker.nextIndex;
    } else {
      const marker = splitMarkerLine(stdout, markerIndex, TRACE_EVENT_MARKER);
      if (traceEvents && marker.payload) {
        traceEvents.push(JSON.parse(marker.payload));
      }
      cursor = marker.nextIndex;
    }
  }

  if (!foundResult && !options.allowMissingResult) {
    throw new Error('C++ program did not emit a TraceCode result.');
  }
  return { output, consoleOutput, events: traceEvents ?? [] };
}

function finalizeRuntimeTrace(events, options = {}) {
  const runId = options.runId || 'cpp:run';
  const file = options.file || 'UserCode.cpp';
  const maxEvents = Number.isFinite(options.maxStoredEvents)
    ? Number(options.maxStoredEvents)
    : Number.isFinite(options.maxTraceSteps)
      ? Number(options.maxTraceSteps)
      : undefined;
  const normalizedEvents = events.map((event) => ({
    ...event,
    runId,
    file,
  }));
  const traceLimitExceeded = maxEvents !== undefined && normalizedEvents.length > maxEvents;
  let storedEvents = traceLimitExceeded ? normalizedEvents.slice(0, Math.max(0, maxEvents)) : normalizedEvents;
  if (
    traceLimitExceeded &&
    normalizedEvents.some((event) => event.kind === 'timeout') &&
    !storedEvents.some((event) => event.kind === 'timeout')
  ) {
    const timeoutEvent = normalizedEvents.find((event) => event.kind === 'timeout');
    storedEvents =
      maxEvents && maxEvents > 1 && timeoutEvent
        ? [...normalizedEvents.slice(0, maxEvents - 1), timeoutEvent]
        : timeoutEvent
          ? [timeoutEvent]
          : storedEvents;
  }
  return {
    trace: {
      schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
      language: 'cpp',
      runId,
      events: storedEvents,
      lineEventCount: storedEvents.filter((event) => event.kind === 'line').length,
      traceStepCount: storedEvents.length,
    },
    traceLimitExceeded,
  };
}

function extractUserErrorLine(diagnostics) {
  const match = diagnostics.match(/UserCode\.cpp:(\d+):\d+:/);
  return match ? Number(match[1]) : undefined;
}

function extractDiagnosticLocation(diagnostics) {
  const match = diagnostics.match(/(?:^|\n)(UserCode\.cpp|TraceCodeDriver\.cpp):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*([^\n]+)/);
  if (!match) return null;
  return {
    file: match[1],
    line: Number(match[2]),
    column: Number(match[3]),
    severity: match[4],
    message: match[5].trim(),
  };
}

function compileFailureResult(diagnostics, fallbackMessage, start, details = {}) {
  const cleanDiagnostics = (diagnostics || '').trim();
  const location = extractDiagnosticLocation(cleanDiagnostics);
  const userLine = location?.file === 'UserCode.cpp' ? location.line : extractUserErrorLine(cleanDiagnostics);
  const prefix =
    location?.file === 'TraceCodeDriver.cpp'
      ? 'C++ generated driver failed'
      : location?.file === 'UserCode.cpp'
        ? 'C++ compilation failed'
        : fallbackMessage;

  return {
    success: false,
    output: null,
    error: cleanDiagnostics ? `${prefix}: ${cleanDiagnostics}` : fallbackMessage,
    ...(userLine !== undefined ? { errorLine: userLine } : {}),
    ...(details.generatedSource ? { generatedSource: details.generatedSource } : {}),
    ...(details.diagnosticStage ? { diagnosticStage: details.diagnosticStage } : {}),
    consoleOutput: [],
    executionTimeMs: Math.max(0, Math.round(now() - start)),
  };
}

async function runTool(module, fs, args) {
  const result = await runWasi(module, args, fs, {
    filestatSizeOffset: args[0] === 'wasm-ld' ? 24 : 32,
  });
  if (result.exitCode !== 0) {
    const message = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    const error = new Error(message || `${args[0]} exited with code ${result.exitCode}`);
    error.exitCode = result.exitCode;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result;
}

async function compileAndRun(source, functionName, inputs, options = {}) {
  const start = now();
  const toolchain = await loadToolchain();
  if (toolchain.compiler === 'yowasp') {
    return compileAndRunWithYowasp(toolchain, source, functionName, inputs, start, options);
  }
  const fs = toolchain.baseFs.clone();
  const resourceDir = findClangResourceDir(fs);
  const signature = options.executionStyle === 'ops-class'
    ? { line: 1 }
    : parseMethodSignature(source, functionName);
  const driverSource = options.executionStyle === 'ops-class'
    ? buildOpsClassDriverSource(source, functionName, inputs || {}, options)
    : buildDriverSource(source, functionName, inputs || {}, options);

  fs.addDirectory('/tmp');
  fs.addFile('/tmp/TraceCodeDriver.cpp', driverSource);

  const clangArgs = [
    'clang',
    '-cc1',
    '-triple',
    'wasm32-unknown-wasi',
    '-emit-obj',
    '-disable-free',
    '-isysroot',
    '/',
    '-internal-isystem',
    '/include/c++/v1',
    '-internal-isystem',
    '/include',
    '-internal-isystem',
    `${resourceDir}/include`,
    '-ferror-limit',
    '19',
    '-fmessage-length',
    '120',
    `-std=${CPP_STANDARD}`,
    '-O0',
    '-o',
    '/tmp/program.o',
    '-x',
    'c++',
    '/tmp/TraceCodeDriver.cpp',
  ];

  try {
    await runTool(toolchain.clangModule, fs, clangArgs);
  } catch (error) {
    const diagnostics = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n').trim();
    return compileFailureResult(diagnostics, 'C++ compilation failed.', start, {
      generatedSource: options?.traceOptions?.includeGeneratedSource ? driverSource : undefined,
      diagnosticStage: options.tracing ? 'trace-driver-compile' : 'driver-compile',
    });
  }

  const libDir = fs.isDirectory('/lib/wasm32-wasi') ? '/lib/wasm32-wasi' : '/lib';
  const crt1 = fs.isFile(`${libDir}/crt1.o`) ? `${libDir}/crt1.o` : '/lib/wasm32-wasi/crt1.o';
  const lldArgs = [
    'wasm-ld',
    '--no-threads',
    '--export-dynamic',
    '-z',
    'stack-size=1048576',
    `-L${libDir}`,
    crt1,
    '/tmp/program.o',
    '-lc',
    '-lc++',
    '-lc++abi',
    ...(fs.isFile(`${libDir}/libcanvas.a`) ? ['-lcanvas'] : []),
    '-o',
    '/tmp/program.wasm',
  ];

  try {
    await runTool(toolchain.lldModule, fs, lldArgs);
  } catch (error) {
    const diagnostics = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n').trim();
    return compileFailureResult(diagnostics, 'C++ linking failed.', start, {
      generatedSource: options?.traceOptions?.includeGeneratedSource ? driverSource : undefined,
      diagnosticStage: 'driver-link',
    });
  }

  try {
    const programModule = await WebAssembly.compile(fs.readFile('/tmp/program.wasm'));
    const program = await runWasi(programModule, ['program.wasm'], fs);
    const parsed = parseProgramStdout(program.stdout, {
      tracing: options.tracing,
      defaultLine: signature.line,
      allowMissingResult: options.tracing,
    });
    const programTimedOut = options.tracing && program.exitCode === 124;
    const baseResult = {
      success: program.exitCode === 0 && !programTimedOut,
      output: parsed.output,
      error: program.exitCode === 0 ? undefined : program.stderr || `C++ program exited with code ${program.exitCode}`,
      consoleOutput: [...parsed.consoleOutput, ...program.stderr.split(/\r?\n/).filter(Boolean)],
      executionTimeMs: Math.max(0, Math.round(now() - start)),
    };
    if (!options.tracing) return baseResult;
    const { trace, traceLimitExceeded } = finalizeRuntimeTrace(parsed.events, options.traceOptions || {});
    const runtimeTraceLimitExceeded = traceLimitExceeded || programTimedOut;
    return {
      ...baseResult,
      ...(programTimedOut ? { error: 'C++ trace budget exceeded.' } : {}),
      trace,
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
      traceLimitExceeded: runtimeTraceLimitExceeded,
      ...(runtimeTraceLimitExceeded ? { timeoutReason: 'trace-limit' } : {}),
    };
  } catch (error) {
    if (options.tracing) {
      const trace = finalizeRuntimeTrace(
        [{ kind: 'exception', line: signature.line, message: error instanceof Error ? error.message : String(error) }],
        options.traceOptions || {}
      ).trace;
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        trace,
        consoleOutput: [],
        executionTimeMs: Math.max(0, Math.round(now() - start)),
        lineEventCount: trace.lineEventCount,
        traceStepCount: trace.traceStepCount,
      };
    }
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      consoleOutput: [],
      executionTimeMs: Math.max(0, Math.round(now() - start)),
    };
  }
}

async function compileAndRunWithYowasp(toolchain, source, functionName, inputs, start, options = {}) {
  const signature = options.executionStyle === 'ops-class'
    ? { line: 1 }
    : parseMethodSignature(source, functionName);
  const rawDriverSource = options.executionStyle === 'ops-class'
    ? buildOpsClassDriverSource(source, functionName, inputs || {}, options)
    : buildDriverSource(source, functionName, inputs || {}, options);
  const driverSource = rawDriverSource.replace(
    '#include "/tracecode_runtime.hpp"',
    '#include "tracecode_runtime.hpp"'
  );
  const stdoutChunks = [];
  const stderrChunks = [];
  const collect = (chunks) => (bytes) => {
    if (bytes) chunks.push(bytes);
  };

  let files;
  try {
    files = await toolchain.runClang(
      ['clang++', 'TraceCodeDriver.cpp', `-std=${CPP_STANDARD}`, '-O0', '-fno-exceptions', '-o', 'program.wasm'],
      {
        'TraceCodeDriver.cpp': driverSource,
        'tracecode_runtime.hpp': toolchain.runtimeHeader,
      },
      {
        stdout: collect(stdoutChunks),
        stderr: collect(stderrChunks),
        fetchProgress: () => {},
      }
    );
  } catch (error) {
    const stdout = decodeUtf8(concatBytes(stdoutChunks));
    const stderr = decodeUtf8(concatBytes(stderrChunks));
    const diagnostics = [stderr, stdout, error instanceof Error ? error.message : String(error)]
      .filter(Boolean)
      .join('\n')
      .trim();
    return compileFailureResult(diagnostics, 'C++ compilation failed.', start, {
      generatedSource: options?.traceOptions?.includeGeneratedSource ? driverSource : undefined,
      diagnosticStage: options.tracing ? 'trace-driver-compile' : 'driver-compile',
    });
  }

  const programBytes = files?.['program.wasm'];
  if (!(programBytes instanceof Uint8Array)) {
    return {
      success: false,
      output: null,
      error: 'C++ compilation did not produce program.wasm.',
      consoleOutput: [],
      executionTimeMs: Math.max(0, Math.round(now() - start)),
    };
  }

  try {
    const program = await runWasi(await WebAssembly.compile(programBytes), ['program.wasm'], new InMemoryFileSystem());
    const parsed = parseProgramStdout(program.stdout, {
      tracing: options.tracing,
      defaultLine: signature.line,
      allowMissingResult: options.tracing,
    });
    const programTimedOut = options.tracing && program.exitCode === 124;
    const baseResult = {
      success: program.exitCode === 0 && !programTimedOut,
      output: parsed.output,
      error: program.exitCode === 0 ? undefined : program.stderr || `C++ program exited with code ${program.exitCode}`,
      consoleOutput: [...parsed.consoleOutput, ...program.stderr.split(/\r?\n/).filter(Boolean)],
      executionTimeMs: Math.max(0, Math.round(now() - start)),
    };
    if (!options.tracing) return baseResult;
    const { trace, traceLimitExceeded } = finalizeRuntimeTrace(parsed.events, options.traceOptions || {});
    const runtimeTraceLimitExceeded = traceLimitExceeded || programTimedOut;
    return {
      ...baseResult,
      ...(programTimedOut ? { error: 'C++ trace budget exceeded.' } : {}),
      trace,
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
      traceLimitExceeded: runtimeTraceLimitExceeded,
      ...(runtimeTraceLimitExceeded ? { timeoutReason: 'trace-limit' } : {}),
    };
  } catch (error) {
    if (options.tracing) {
      const trace = finalizeRuntimeTrace(
        [{ kind: 'exception', line: signature.line, message: error instanceof Error ? error.message : String(error) }],
        options.traceOptions || {}
      ).trace;
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        trace,
        consoleOutput: [],
        executionTimeMs: Math.max(0, Math.round(now() - start)),
        lineEventCount: trace.lineEventCount,
        traceStepCount: trace.traceStepCount,
      };
    }
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      consoleOutput: [],
      executionTimeMs: Math.max(0, Math.round(now() - start)),
    };
  }
}

async function handleInit(payload) {
  const start = now();
  configuredAssets = payload && payload.assets ? payload.assets : null;
  toolchainPromise = null;
  return {
    success: true,
    loadTimeMs: Math.max(0, Math.round(now() - start)),
  };
}

async function handleCompileRun(payload) {
  const source = payload && typeof payload.code === 'string' ? payload.code : '';
  const functionName = payload && typeof payload.functionName === 'string' ? payload.functionName : '';

  if (!source.trim()) {
    return {
      success: false,
      output: null,
      error: 'C++ source is empty.',
      consoleOutput: [],
    };
  }

  if (!functionName.trim()) {
    return {
      success: false,
      output: null,
      error: 'C++ solution-method execution requires a function name.',
      consoleOutput: [],
    };
  }

  try {
    return await compileAndRun(source, functionName, payload?.inputs || {}, {
      executionStyle: payload?.executionStyle || 'solution-method',
    });
  } catch (error) {
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      consoleOutput: [],
    };
  }
}

async function handleExecuteWithTracing(payload) {
  const source = payload && typeof payload.code === 'string' ? payload.code : '';
  const functionName = payload && typeof payload.functionName === 'string' ? payload.functionName : '';

  if (!source.trim()) {
    const trace = finalizeRuntimeTrace([{ kind: 'exception', line: 1, message: 'C++ source is empty.' }]).trace;
    return {
      success: false,
      output: null,
      error: 'C++ source is empty.',
      trace,
      executionTimeMs: 0,
      consoleOutput: [],
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
    };
  }

  if (!functionName.trim()) {
    const trace = finalizeRuntimeTrace([
      { kind: 'exception', line: 1, message: 'C++ solution-method tracing requires a function name.' },
    ]).trace;
    return {
      success: false,
      output: null,
      error: 'C++ solution-method tracing requires a function name.',
      trace,
      executionTimeMs: 0,
      consoleOutput: [],
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
    };
  }

  try {
    const result = await compileAndRun(source, functionName, payload?.inputs || {}, {
      tracing: true,
      traceOptions: payload?.options || {},
      executionStyle: payload?.executionStyle || 'solution-method',
    });
    if (result.trace) return result;
    const trace = finalizeRuntimeTrace([{ kind: 'exception', line: result.errorLine || 1, message: result.error || 'C++ tracing failed.' }]).trace;
    return {
      ...result,
      trace,
      executionTimeMs: result.executionTimeMs || 0,
      consoleOutput: result.consoleOutput || [],
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
    };
  } catch (error) {
    const trace = finalizeRuntimeTrace([
      { kind: 'exception', line: 1, message: error instanceof Error ? error.message : String(error) },
    ]).trace;
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      trace,
      executionTimeMs: 0,
      consoleOutput: [],
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
    };
  }
}

self.onmessage = (event) => {
  const { id, type, payload } = event.data || {};
  if (!id) return;

  const task =
    type === 'init'
      ? handleInit(payload)
      : type === 'compile-run'
        ? handleCompileRun(payload)
        : type === 'execute-with-tracing'
          ? handleExecuteWithTracing(payload)
          : Promise.reject(new Error(`Unknown C++ worker message: ${type}`));

  task.then((result) => postSuccess(id, type, result)).catch((error) => postFailure(id, error));
};

postMessage({ type: 'worker-ready' });

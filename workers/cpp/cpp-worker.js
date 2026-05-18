const RESULT_MARKER = '__TRACECODE_RESULT__';
const TRACE_EVENT_MARKER = '__TRACECODE_EVENT__';
const TRACE_STATUS_MARKER = '__TRACECODE_TRACE_STATUS__';
const RUNTIME_TRACE_SCHEMA_VERSION = 'runtime-trace-2026-04-28';
const CPP_USER_SOURCE_FILE = 'solution.cpp';
const CPP_STANDARD = 'c++23';
const CPP_SCRIPT_FUNCTION_NAME = '__tracecode_script_main';
const DEFAULT_MAX_STORED_EVENTS = 50_000;
const DEFAULT_INTERVIEW_MAX_TRACE_STEPS = 10_000;
const DEFAULT_INTERVIEW_MAX_LINE_EVENTS = 12_000;
const DEFAULT_INTERVIEW_MAX_SINGLE_LINE_HITS = 1_000;
const CPP_PROGRAM_STACK_SIZE = 8 * 1024 * 1024;
const CPP_PROGRAM_CACHE_LIMIT = 32;
const CPP_WARMUP_SOURCE = 'class Solution { public: int add(int a, int b) { return a + b; } };';
const WORKER_DEBUG = (() => {
  try {
    return typeof self !== 'undefined' && typeof self.location?.search === 'string' && self.location.search.includes('dev=');
  } catch {
    return false;
  }
})();
const ESUCCESS = 0;
const EBADF = 8;
const EEXIST = 20;
const EINVAL = 28;
const EIO = 29;
const EISDIR = 31;
const ENOENT = 44;
const ENOTDIR = 54;
const ENOTEMPTY = 55;
const ENOTSUP = 58;
const EROFS = 69;
const FILETYPE_UNKNOWN = 0;
const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;
const OFLAGS_CREAT = 1;
const OFLAGS_DIRECTORY = 2;
const OFLAGS_EXCL = 4;
const OFLAGS_TRUNC = 8;
const FDFLAGS_APPEND = 1;
const RIGHTS_FD_READ = 1n << 1n;
const RIGHTS_FD_WRITE = 1n << 6n;
const WHENCE_SET = 0;
const WHENCE_CUR = 1;
const WHENCE_END = 2;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const CPP_BASE_GENERATED_INCLUDES = Object.freeze([
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
const CPP_STANDARD_INCLUDE_RULES = Object.freeze([
  [/\bvector\s*</, '#include <vector>'],
  [/\bunordered_map\s*</, '#include <unordered_map>'],
  [/\bunordered_set\s*</, '#include <unordered_set>'],
  [/\bmap\s*</, '#include <map>'],
  [/\bset\s*</, '#include <set>'],
  [/\bdeque\s*</, '#include <deque>'],
  [/\b(?:priority_queue|queue)\s*</, '#include <queue>'],
  [/\bstack\s*</, '#include <stack>'],
  [/\bpair\s*</, '#include <utility>'],
  [/\bstring\b/, '#include <string>'],
  [/\bspan\s*</, '#include <span>'],
  [/\bviews::|\branges::|std::views|std::ranges/, '#include <ranges>'],
  [/\bconcept\b|\brequires\b/, '#include <concepts>'],
  [/\b(?:any|any_cast|make_any)\b/, '#include <any>'],
  [/\b(?:bit_cast|bit_ceil|bit_floor|bit_width|byteswap|countl_one|countl_zero|countr_one|countr_zero|has_single_bit|popcount|rotl|rotr)\s*\(/, '#include <bit>'],
  [/\b(?:isalpha|isalnum|isblank|iscntrl|isdigit|isgraph|islower|isprint|ispunct|isspace|isupper|isxdigit|tolower|toupper)\s*\(/, '#include <cctype>'],
  [/\berrno\b/, '#include <cerrno>'],
  [/\b(?:DBL_|FLT_|LDBL_)/, '#include <cfloat>'],
  [/\b(?:from_chars|to_chars)\s*\(/, '#include <charconv>'],
  [/\b(?:chrono::|std::chrono::|duration\s*<|time_point\s*<|system_clock|steady_clock|high_resolution_clock)\b/, '#include <chrono>'],
  [/\b(?:intmax_t|uintmax_t|imaxabs|imaxdiv|strtoimax|strtoumax)\b/, '#include <cinttypes>'],
  [/\b(?:strong_ordering|weak_ordering|partial_ordering|compare_three_way)\b|<=>/, '#include <compare>'],
  [/\bcomplex\s*</, '#include <complex>'],
  [/\b(?:byte|nullptr_t|ptrdiff_t|size_t)\b/, '#include <cstddef>'],
  [/\b(?:FILE|clearerr|fclose|feof|ferror|fflush|fgetc|fgetpos|fgets|fopen|fprintf|fputc|fputs|fread|freopen|fscanf|fseek|fsetpos|ftell|fwrite|getc|getchar|perror|printf|putc|putchar|puts|remove|rename|rewind|scanf|setbuf|setvbuf|snprintf|sprintf|sscanf|tmpfile|tmpnam|ungetc|vfprintf|vfscanf|vprintf|vscanf|vsnprintf|vsprintf|vsscanf)\b/, '#include <cstdio>'],
  [/\b(?:abort|abs|aligned_alloc|atexit|atof|atoi|atol|atoll|bsearch|calloc|div|exit|free|getenv|labs|ldiv|llabs|lldiv|malloc|mblen|mbstowcs|mbtowc|qsort|rand|realloc|srand|strtod|strtof|strtol|strtold|strtoll|strtoul|strtoull|system|wcstombs|wctomb)\b/, '#include <cstdlib>'],
  [/\b(?:memchr|memcmp|memcpy|memmove|memset|strcat|strchr|strcmp|strcoll|strcpy|strcspn|strerror|strlen|strncat|strncmp|strncpy|strpbrk|strrchr|strspn|strstr|strtok|strxfrm)\s*\(/, '#include <cstring>'],
  [/\b(?:exception|exception_ptr|current_exception|make_exception_ptr|rethrow_exception|terminate|uncaught_exceptions?)\b/, '#include <exception>'],
  [/\b(?:expected|unexpected)\s*<|\bunexpect\b/, '#include <expected>'],
  [/\bforward_list\s*</, '#include <forward_list>'],
  [/\binitializer_list\s*</, '#include <initializer_list>'],
  [/\b(?:boolalpha|defaultfloat|fixed|hexfloat|noboolalpha|put_money|put_time|quoted|scientific|setbase|setfill|setiosflags|setprecision|setw)\b/, '#include <iomanip>'],
  [/\b(?:ios|ios_base|streampos|streamoff)\b/, '#include <ios>'],
  [/\b(?:cerr|cin|clog|cout|wcin|wcout|wcerr|wclog)\b/, '#include <iostream>'],
  [/\b(?:advance|back_inserter|begin|cbegin|cend|crbegin|crend|distance|end|front_inserter|inserter|istream_iterator|iterator_traits|make_move_iterator|next|ostream_iterator|prev|rbegin|rend)\b/, '#include <iterator>'],
  [/\blist\s*</, '#include <list>'],
  [/\b(?:allocator|make_shared|make_unique|shared_ptr|unique_ptr|weak_ptr)\b/, '#include <memory>'],
  [/\b(?:numbers::|std::numbers::)/, '#include <numbers>'],
  [/\boptional\s*<|\b(?:make_optional|nullopt)\b/, '#include <optional>'],
  [/\b(?:bernoulli_distribution|binomial_distribution|default_random_engine|discrete_distribution|exponential_distribution|geometric_distribution|knuth_b|linear_congruential_engine|lognormal_distribution|mersenne_twister_engine|minstd_rand|mt19937|mt19937_64|normal_distribution|piecewise_constant_distribution|piecewise_linear_distribution|poisson_distribution|random_device|ranlux24|ranlux48|shuffle_order_engine|student_t_distribution|uniform_int_distribution|uniform_real_distribution|weibull_distribution)\b/, '#include <random>'],
  [/\bratio\s*</, '#include <ratio>'],
  [/\b(?:cmatch|cregex_iterator|cregex_token_iterator|regex|regex_error|regex_iterator|regex_match|regex_replace|regex_search|regex_token_iterator|smatch|sregex_iterator|sregex_token_iterator|wregex|wsmatch)\b/, '#include <regex>'],
  [/\b(?:logic_error|domain_error|invalid_argument|length_error|out_of_range|runtime_error|range_error|overflow_error|underflow_error)\b/, '#include <stdexcept>'],
  [/\bstring_view\b/, '#include <string_view>'],
  [/\b(?:add_const|add_cv|add_lvalue_reference|add_pointer|add_rvalue_reference|add_volatile|aligned_storage|common_type|conditional|decay|enable_if|false_type|integral_constant|is_arithmetic|is_array|is_base_of|is_class|is_const|is_convertible|is_enum|is_floating_point|is_function|is_integral|is_lvalue_reference|is_pointer|is_reference|is_same|is_signed|is_trivially_copyable|is_void|remove_const|remove_cv|remove_pointer|remove_reference|true_type|underlying_type|void_t)\b/, '#include <type_traits>'],
  [/\btype_index\b/, '#include <typeindex>'],
  [/\b(?:type_info|typeid\s*\()/, '#include <typeinfo>'],
  [/\bvalarray\s*</, '#include <valarray>'],
  [/\bvariant\s*<|\b(?:holds_alternative|monostate|visit)\b/, '#include <variant>'],
  [/\b__cpp_lib_/, '#include <version>'],
]);

let configuredAssets = null;
let toolchainPromise = null;
let warmupPromise = null;
let queue = Promise.resolve();
let idleTimer = null;
let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
let queuedTasks = 0;
let programCache = new Map();
let externalCompileRequestId = 0;
const pendingExternalCompiles = new Map();
let compilerWorker = null;
let compilerWorkerRequestId = 0;
const pendingCompilerWorkerRequests = new Map();

function emitRuntimeDiagnostic(level, phase, message, detail) {
  if (!WORKER_DEBUG && level !== 'error') return;
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'info';
  console[method]('[TraceRuntime]', {
    schema: 'tracecode.runtime-diagnostic.v1',
    source: 'harness',
    component: 'CppWorker',
    runtime: 'cpp',
    phase,
    message,
    ...(detail === undefined ? {} : { detail }),
  });
}

class ProcExit extends Error {
  constructor(code) {
    super(`process exited with code ${code}`);
    this.code = code;
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(now() - startedAt));
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function resetIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    postMessage({ type: 'idle-timeout' });
    self.close();
  }, idleTimeoutMs);
}

function applyWorkerOptions(payload) {
  const requestedIdleTimeoutMs = Number(payload?.idleTimeoutMs);
  if (Number.isFinite(requestedIdleTimeoutMs) && requestedIdleTimeoutMs >= 1_000) {
    idleTimeoutMs = Math.round(requestedIdleTimeoutMs);
  }
}

function getProgramCacheKey(compiler, driverSource) {
  return [compiler, CPP_STANDARD, String(CPP_PROGRAM_STACK_SIZE), driverSource].join('\0');
}

function getCachedProgramModule(cacheKey) {
  if (!programCache.has(cacheKey)) return null;
  const module = programCache.get(cacheKey);
  programCache.delete(cacheKey);
  programCache.set(cacheKey, module);
  return module;
}

function storeProgramModule(cacheKey, module) {
  if (programCache.has(cacheKey)) {
    programCache.delete(cacheKey);
  }
  programCache.set(cacheKey, module);
  while (programCache.size > CPP_PROGRAM_CACHE_LIMIT) {
    const oldestKey = programCache.keys().next().value;
    programCache.delete(oldestKey);
  }
}

function encodeUtf8(value) {
  return new TextEncoder().encode(value);
}

function decodeUtf8(value) {
  return new TextDecoder().decode(value);
}

function encodeBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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

function isRuntimeProcPath(pathname) {
  const normalized = normalizePath(pathname);
  return normalized === '/proc' || normalized.startsWith('/proc/');
}

function isRuntimeDeviceNamespacePath(pathname) {
  const normalized = normalizePath(pathname);
  return normalized === '/dev' || normalized.startsWith('/dev/');
}

function isRuntimeDeviceDirectory(pathname) {
  return normalizePath(pathname) === '/dev';
}

function wasiRights(value) {
  try {
    return BigInt(value ?? 0);
  } catch {
    return 0n;
  }
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

function postProjectEvent(id, payload) {
  if (!id) return;
  postMessage({ id, type: 'project-event', payload });
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

function defaultCompilerWorkerUrl() {
  try {
    return self.location?.href ? new URL('cpp-compiler-worker.js', self.location.href).href : '';
  } catch {
    return '';
  }
}

function getCompilerWorkerUrl() {
  return configuredAssets?.compilerWorkerUrl || defaultCompilerWorkerUrl();
}

function canUseEphemeralCompilerWorker() {
  return Boolean(
    canUseExternalCompilerHost() ||
      (configuredAssets?.compilerBundleUrl &&
        getCompilerWorkerUrl() &&
        typeof Worker !== 'undefined' &&
        typeof WebAssembly !== 'undefined')
  );
}

function canUseExternalCompilerHost() {
  return Boolean(configuredAssets?.compilerFrameEnabled);
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
    this.readOnlyFiles = new Set();
    this.fileChangeObserver = null;
  }

  setFileChangeObserver(observer) {
    this.fileChangeObserver = observer;
  }

  clone() {
    const next = new InMemoryFileSystem();
    next.dirs = new Set(this.dirs);
    next.files = new Map([...this.files.entries()].map(([key, value]) => [key, cloneBytes(value)]));
    next.readOnlyFiles = new Set(this.readOnlyFiles);
    return next;
  }

  addDirectory(pathname) {
    const normalized = normalizePath(pathname);
    if (normalized === '/') {
      this.dirs.add('/');
      return;
    }
    this.addDirectory(dirname(normalized));
    const existed = this.dirs.has(normalized);
    this.dirs.add(normalized);
    if (!existed) this.fileChangeObserver?.({ path: normalized, directory: true });
  }

  addFile(pathname, contents) {
    const normalized = normalizePath(pathname);
    this.addDirectory(dirname(normalized));
    this.files.set(normalized, contents instanceof Uint8Array ? cloneBytes(contents) : encodeUtf8(String(contents)));
  }

  addReadOnlyFile(pathname, contents) {
    const normalized = normalizePath(pathname);
    this.addFile(normalized, contents);
    this.readOnlyFiles.add(normalized);
  }

  isReadOnly(pathname) {
    const normalized = normalizePath(pathname);
    return this.readOnlyFiles.has(normalized) || isRuntimeProcPath(normalized);
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
    if (this.isReadOnly(normalized)) throw Object.assign(new Error(`Read-only file system: ${normalized}`), { code: 'EROFS' });
    const bytes = contents instanceof Uint8Array ? cloneBytes(contents) : encodeUtf8(String(contents));
    this.addDirectory(dirname(normalized));
    this.files.set(normalized, bytes);
    this.fileChangeObserver?.({ path: normalized, bytes });
  }

  resizeFile(pathname, size) {
    const current = this.readFile(pathname);
    const next = new Uint8Array(size);
    next.set(current.subarray(0, Math.min(current.length, size)));
    this.writeFile(pathname, next);
  }

  unlink(pathname) {
    const normalized = normalizePath(pathname);
    if (this.isReadOnly(normalized)) throw Object.assign(new Error(`Read-only file system: ${normalized}`), { code: 'EROFS' });
    if (this.dirs.has(normalized)) return EISDIR;
    if (!this.files.has(normalized)) return ENOENT;
    this.files.delete(normalized);
    this.readOnlyFiles.delete(normalized);
    this.fileChangeObserver?.({ path: normalized, deleted: true });
    return ESUCCESS;
  }

  removeDirectory(pathname) {
    const normalized = normalizePath(pathname);
    if (normalized === '/' || !this.dirs.has(normalized)) return ENOENT;
    const prefix = `${normalized}/`;
    for (const dir of this.dirs) {
      if (dir.startsWith(prefix)) return ENOTEMPTY;
    }
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) return ENOTEMPTY;
    }
    this.dirs.delete(normalized);
    this.fileChangeObserver?.({ path: normalized, directory: true, deleted: true });
    return ESUCCESS;
  }

  rename(oldPathname, newPathname) {
    const oldPath = normalizePath(oldPathname);
    const newPath = normalizePath(newPathname);
    if (this.isReadOnly(oldPath) || this.isReadOnly(newPath)) {
      throw Object.assign(new Error(`Read-only file system: ${oldPath}`), { code: 'EROFS' });
    }
    if (this.files.has(oldPath)) {
      this.writeFile(newPath, this.readFile(oldPath));
      this.unlink(oldPath);
      return ESUCCESS;
    }
    if (!this.dirs.has(oldPath)) return ENOENT;
    const oldPrefix = `${oldPath}/`;
    const newPrefix = `${newPath}/`;
    const directories = [...this.dirs]
      .filter((path) => path === oldPath || path.startsWith(oldPrefix))
      .sort((left, right) => left.length - right.length);
    const files = [...this.files.entries()].filter(([path]) => path.startsWith(oldPrefix));
    for (const directory of directories) {
      const target = directory === oldPath ? newPath : `${newPrefix}${directory.slice(oldPrefix.length)}`;
      this.addDirectory(target);
    }
    for (const [file, bytes] of files) {
      const target = `${newPrefix}${file.slice(oldPrefix.length)}`;
      this.writeFile(target, bytes);
    }
    for (const [file] of files) {
      this.unlink(file);
    }
    for (const directory of directories.sort((left, right) => right.length - left.length)) {
      this.dirs.delete(directory);
      this.fileChangeObserver?.({ path: directory, directory: true, deleted: true });
    }
    return ESUCCESS;
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
    this.cwd = normalizePath(options.cwd || '/');
    this.fs.addDirectory(this.cwd);
    this.stdin = encodeUtf8(options.stdin || '');
    this.stdoutChunks = [];
    this.stderrChunks = [];
    this.onOutput = options.onOutput;
    this.kernelDevices = wasiKernelDevices(options);
    this.stdioDevices = standaloneKernelDevices();
    this.filestatSizeOffset = options.filestatSizeOffset || 32;
    this.fds = new Map([
      [0, this.stdioEntryForDevice('/dev/stdin', this.stdioDevices)],
      [1, this.stdioEntryForDevice('/dev/stdout', this.stdioDevices)],
      [2, this.stdioEntryForDevice('/dev/stderr', this.stdioDevices)],
      [3, { kind: 'dir', path: this.cwd, offset: 0, readable: true, writable: false, preopen: '/' }],
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
    if (
      path === 'proc' ||
      path.startsWith('proc/') ||
      path.startsWith('/proc') ||
      path === 'dev' ||
      path.startsWith('dev/') ||
      path.startsWith('/dev') ||
      this.isKernelVirtualPathOperand(path) ||
      this.isKernelVirtualNamespaceOperand(path)
    ) {
      return normalizePath(path);
    }
    const base = entry.kind === 'dir' ? entry.path : dirname(entry.path || '/');
    return resolveAt(base, path);
  }

  stdioEntryForDevice(device, devices = this.kernelDevices) {
    const info = devices.get(normalizePath(device));
    if (!info) return { kind: 'stdio', device, offset: 0, readable: false, writable: false, inputDevice: '', outputDevice: '' };
    return {
      kind: 'stdio',
      device: info.path,
      offset: 0,
      readable: info.readable,
      writable: info.writable,
      inputDevice: info.inputDevice || '',
      outputDevice: info.outputDevice || '',
    };
  }

  stdioEntryForPath(pathname, options = {}) {
    const entry = this.stdioEntryForDevice(pathname);
    if (!entry.device || !this.kernelDevices.has(normalizePath(pathname))) return null;
    if (options.create || options.truncate || options.append) return entry.writable ? entry : null;
    if (options.write && !entry.writable) return null;
    if (!options.write && !entry.readable) return null;
    if (options.read && !entry.readable && !entry.writable) return null;
    return entry;
  }

  isKnownDevicePath(pathname) {
    return this.kernelDevices.has(normalizePath(pathname));
  }

  isKernelVirtualPathOperand(pathname) {
    const normalized = normalizePath(pathname);
    if (normalized === '/') return false;
    for (const path of this.fs.readOnlyFiles) {
      if (normalized === path || path.startsWith(`${normalized}/`)) return true;
    }
    return false;
  }

  isKernelVirtualNamespaceOperand(pathname) {
    const normalized = normalizePath(pathname);
    if (normalized === '/') return false;
    for (const path of this.fs.readOnlyFiles) {
      const slash = path.indexOf('/', 1);
      const root = slash < 0 ? path : path.slice(0, slash);
      if (normalized === root || normalized.startsWith(`${root}/`)) return true;
    }
    return false;
  }

  isKernelVirtualNamespacePath(pathname) {
    const normalized = normalizePath(pathname);
    if (normalized === '/') return false;
    for (const path of this.fs.readOnlyFiles) {
      const slash = path.indexOf('/', 1);
      const root = slash < 0 ? path : path.slice(0, slash);
      if (normalized === path || normalized.startsWith(`${root}/`)) return true;
    }
    return false;
  }

  deviceNamespaceMutationErrno(pathname, missingErrno = ENOENT) {
    const normalized = normalizePath(pathname);
    if (!isRuntimeDeviceNamespacePath(normalized)) return null;
    return isRuntimeDeviceDirectory(normalized) || this.isKnownDevicePath(normalized) ? EROFS : missingErrno;
  }

  filetypeForPath(pathname) {
    const normalized = normalizePath(pathname);
    if (isRuntimeDeviceDirectory(normalized)) return FILETYPE_DIRECTORY;
    if (this.isKnownDevicePath(normalized)) return FILETYPE_CHARACTER_DEVICE;
    if (this.fs.isDirectory(normalized)) return FILETYPE_DIRECTORY;
    return FILETYPE_REGULAR_FILE;
  }

  openFile(pathname, options = {}) {
    const normalized = normalizePath(pathname);
    if (isRuntimeDeviceDirectory(normalized)) {
      return options.directory ? this.allocateFd({ kind: 'dir', path: normalized, offset: 0, readable: true, writable: false }) : -EISDIR;
    }
    const stdioEntry = this.stdioEntryForPath(normalized, options);
    if (stdioEntry) {
      return this.allocateFd(stdioEntry);
    }
    if (isRuntimeDeviceNamespacePath(normalized)) {
      return this.isKnownDevicePath(normalized) ? -EBADF : -ENOENT;
    }
    if ((this.fs.isReadOnly(normalized) || this.isKernelVirtualNamespacePath(normalized)) && (options.create || options.truncate || options.append || options.write)) {
      return -EROFS;
    }
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
    return this.allocateFd({ kind: 'file', path: normalized, offset, readable: true, writable: !this.fs.isReadOnly(normalized) && options.write !== false, append: Boolean(options.append) });
  }

  allocateFd(entry) {
    const fd = this.nextFd++;
    this.fds.set(fd, entry);
    return fd;
  }

  writeFilestat(pathname, outPtr) {
    const normalized = normalizePath(pathname);
    if (isRuntimeDeviceDirectory(normalized) || this.isKnownDevicePath(normalized)) {
      this.mem.writeU64(outPtr, 1);
      this.mem.writeU64(outPtr + 8, inodeForPath(normalized));
      this.mem.writeU8(outPtr + 16, this.filetypeForPath(normalized));
      this.mem.writeU64(outPtr + 24, this.filestatSizeOffset === 24 ? 0n : 1n);
      this.mem.writeU64(outPtr + 32, 0);
      this.mem.writeU64(outPtr + 40, 0);
      this.mem.writeU64(outPtr + 48, 0);
      this.mem.writeU64(outPtr + 56, 0);
      return ESUCCESS;
    }
    if (isRuntimeDeviceNamespacePath(normalized)) return ENOENT;
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
    if (entry?.kind === 'file' && this.fs.isReadOnly(entry.path)) return EROFS;
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

    if (entry.kind === 'stdio' && entry.outputDevice) {
      const stream = entry.outputDevice === '/dev/stderr' ? 'stderr' : 'stdout';
      if (stream === 'stdout') this.stdoutChunks.push(...chunks);
      if (stream === 'stderr') this.stderrChunks.push(...chunks);
      this.onOutput?.(stream, decodeUtf8(concatBytes(chunks)), entry.device);
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
    const source = entry.kind === 'stdio' && entry.inputDevice
      ? this.stdin
      : entry.kind === 'file'
        ? this.fs.readFile(entry.path)
        : new Uint8Array();
    let sourceOffset = entry.offset;
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
    entry.offset = sourceOffset;
    this.mem.writeU32(nreadOut, total);
    return ESUCCESS;
  }

  fd_pwrite(fd, iovs, iovsLen, offset, nwrittenOut) {
    const entry = this.fds.get(fd);
    if (!entry || entry.kind !== 'file') return EBADF;
    if (!entry.writable) return EBADF;
    if (this.fs.isReadOnly(entry.path)) return EROFS;
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
    if (entry.kind === 'stdio') return this.writeFilestat(entry.device, outPtr);
    return this.writeFilestat(entry.path, outPtr);
  }

  fd_filestat_set_size(fd, size) {
    const entry = this.fds.get(fd);
    if (!entry || entry.kind !== 'file') return EBADF;
    if (!entry.writable) return EBADF;
    if (this.fs.isReadOnly(entry.path)) return EROFS;
    this.fs.resizeFile(entry.path, Number(size));
    return ESUCCESS;
  }

  fd_allocate(fd, offset, length) {
    const entry = this.fds.get(fd);
    if (!entry || entry.kind !== 'file') return EBADF;
    if (!entry.writable) return EBADF;
    if (this.fs.isReadOnly(entry.path)) return EROFS;
    const end = Number(offset) + Number(length);
    if (!Number.isFinite(end) || end < 0) return EINVAL;
    const currentSize = this.fs.exists(entry.path) ? this.fs.readFile(entry.path).length : 0;
    if (end > currentSize) this.fs.resizeFile(entry.path, end);
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
    const names = [
      '.',
      '..',
      ...(isRuntimeDeviceDirectory(entry.path)
        ? [...this.kernelDevices.keys()]
            .filter((path) => path.startsWith('/dev/'))
            .map((path) => path.slice('/dev/'.length))
            .filter(Boolean)
            .sort()
        : this.fs.listDirectory(entry.path)),
    ];
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
      this.mem.writeU8(bufPtr + offset + 20, this.filetypeForPath(childPath));
      this.mem.writeBytes(bufPtr + offset + 24, nameBytes);
      offset += entrySize;
    }
    this.mem.writeU32(bufUsedOut, offset);
    return ESUCCESS;
  }

  path_open(dirfd, _dirflags, pathPtr, pathLen, oflags, rightsBase, _rightsInheriting, fdflags, openedFdOut) {
    const pathname = this.resolveFdPath(dirfd, pathPtr, pathLen);
    if (!pathname) return EBADF;
    const fd = this.openFile(pathname, {
      create: Boolean(oflags & OFLAGS_CREAT),
      directory: Boolean(oflags & OFLAGS_DIRECTORY),
      exclusive: Boolean(oflags & OFLAGS_EXCL),
      truncate: Boolean(oflags & OFLAGS_TRUNC),
      append: Boolean(fdflags & FDFLAGS_APPEND),
      read: (wasiRights(rightsBase) & RIGHTS_FD_READ) !== 0n,
      write: (wasiRights(rightsBase) & RIGHTS_FD_WRITE) !== 0n,
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

  path_filestat_set_times(dirfd, _flags, pathPtr, pathLen) {
    const pathname = this.resolveFdPath(dirfd, pathPtr, pathLen);
    if (!pathname) return EBADF;
    if (isRuntimeProcPath(pathname) || this.fs.isReadOnly(pathname) || this.isKernelVirtualNamespacePath(pathname)) return EROFS;
    const deviceErrno = this.deviceNamespaceMutationErrno(pathname);
    if (deviceErrno !== null) return deviceErrno;
    if (!this.fs.exists(pathname)) return ENOENT;
    return ESUCCESS;
  }

  path_create_directory(dirfd, pathPtr, pathLen) {
    const pathname = this.resolveFdPath(dirfd, pathPtr, pathLen);
    if (!pathname) return EBADF;
    if (isRuntimeProcPath(pathname) || this.isKernelVirtualNamespacePath(pathname)) return EROFS;
    const deviceErrno = this.deviceNamespaceMutationErrno(pathname);
    if (deviceErrno !== null) return deviceErrno;
    this.fs.addDirectory(pathname);
    return ESUCCESS;
  }

  path_unlink_file(dirfd, pathPtr, pathLen) {
    const pathname = this.resolveFdPath(dirfd, pathPtr, pathLen);
    if (!pathname) return EBADF;
    if (this.fs.isReadOnly(pathname) || this.isKernelVirtualNamespacePath(pathname)) return EROFS;
    const deviceErrno = this.deviceNamespaceMutationErrno(pathname);
    if (deviceErrno !== null) return deviceErrno;
    return this.fs.unlink(pathname);
  }

  path_remove_directory(dirfd, pathPtr, pathLen) {
    const pathname = this.resolveFdPath(dirfd, pathPtr, pathLen);
    if (!pathname) return EBADF;
    if (isRuntimeProcPath(pathname) || this.isKernelVirtualNamespacePath(pathname)) return EROFS;
    const deviceErrno = this.deviceNamespaceMutationErrno(pathname, ENOTDIR);
    if (deviceErrno !== null) return deviceErrno;
    if (this.fs.isFile(pathname)) return ENOTDIR;
    return this.fs.removeDirectory(pathname);
  }

  path_rename(oldFd, oldPathPtr, oldPathLen, newFd, newPathPtr, newPathLen) {
    const oldPath = this.resolveFdPath(oldFd, oldPathPtr, oldPathLen);
    const newPath = this.resolveFdPath(newFd, newPathPtr, newPathLen);
    if (!oldPath || !newPath) return EBADF;
    if (
      this.fs.isReadOnly(oldPath) ||
      this.isKernelVirtualNamespacePath(oldPath) ||
      isRuntimeProcPath(newPath) ||
      this.isKernelVirtualNamespacePath(newPath)
    ) return EROFS;
    const oldDeviceErrno = this.deviceNamespaceMutationErrno(oldPath);
    if (oldDeviceErrno !== null) return oldDeviceErrno;
    const newDeviceErrno = this.deviceNamespaceMutationErrno(newPath);
    if (newDeviceErrno !== null) return newDeviceErrno;
    return this.fs.rename(oldPath, newPath);
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
    'fd_allocate',
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
    cwd: options.cwd || '/',
    stdin: options.stdin || '',
    env: options.env || { USER: 'tracecode' },
    kernelDevices: options.kernelDevices,
    filestatSizeOffset: options.filestatSizeOffset,
    onOutput: options.onOutput,
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
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/\/\/.*$/gm, '');
}

function cppNoExceptionDefaultReturn(returnType) {
  const valueType = localCppType(String(returnType || 'void'));
  const normalized = stripCppTypeQualifiers(valueType);
  if (!normalized || normalized === 'void') return '';
  if (normalized.endsWith('*') || normalized === 'nullptr_t') return 'nullptr';
  if (normalized === 'bool') return 'false';
  if (normalized === 'string') return 'std::string()';
  if (
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
  ) return '{}';
  if (/^(?:unsigned)?(?:short|int|long|longlong|longlongint|size_t|std::size_t|float|double|longdouble)$/.test(normalized)) {
    return '0';
  }
  return `${valueType}()`;
}

function cppExceptionMessageForThrowExpression(expression) {
  const rawExpression = String(expression || '').trim();
  const stringMatch = rawExpression.match(/"((?:\\.|[^"\\])*)"/);
  if (stringMatch) {
    try {
      return JSON.parse(`"${stringMatch[1]}"`);
    } catch {
      return stringMatch[1];
    }
  }
  return 'C++ exception thrown.';
}

function cppExceptionTraceInstrumentation(lineNumber, message) {
  const eventJson = `{"kind":"exception","line":${lineNumber},"message":${jsonStringLiteral(message)}}`;
  return `tracecode::write_trace_event_json(std::string(${cppStringLiteral(eventJson)}), ${lineNumber});`;
}

function cppThrowReplacementForReturnType(returnType, options = {}) {
  const defaultValue = cppNoExceptionDefaultReturn(returnType);
  const traceInstrumentation = options.traceLine
    ? `${cppExceptionTraceInstrumentation(options.traceLine, options.message || 'C++ exception thrown.')} `
    : '';
  return defaultValue
    ? `{ ${traceInstrumentation}__tracecode_exception_pending = true; return ${defaultValue}; }`
    : `{ ${traceInstrumentation}__tracecode_exception_pending = true; return; }`;
}

function rewriteCppThrowsWithoutExceptions(source, options = {}) {
  if (!/\bthrow\b/.test(source)) return source;
  const lines = source.split(/\r?\n/);
  const output = [];
  const frames = [];
  let depth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    let rewritten = line;
    const lambdaMatch = line.match(/\[[^\]]*\]\s*\([^)]*\)\s*->\s*([^{]+?)\s*\{/);
    const functionMatch = line.match(/^\s*(?!if\b|for\b|while\b|switch\b|catch\b)(?:[A-Za-z_][\w:<>?,*&\s]*?)\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{/);
    if (lambdaMatch) {
      frames.push({ depth: depth + braceDeltaForLine(line), returnType: lambdaMatch[1].trim() });
    } else if (functionMatch) {
      const prefix = line.slice(0, line.indexOf(functionMatch[1])).trim();
      const returnType = cleanCppReturnType(prefix);
      frames.push({ depth: depth + braceDeltaForLine(line), returnType });
    }

    const activeFrame = frames.at(-1);
    if (/\bthrow\b/.test(rewritten) && activeFrame) {
      rewritten = rewritten.replace(/throw(?:\s+([^;]+))?\s*;/g, (_match, expression) => (
        cppThrowReplacementForReturnType(activeFrame.returnType, {
          ...(options.emitTraceEvents ? {
            traceLine: lineNumber,
            message: cppExceptionMessageForThrowExpression(expression),
          } : {}),
        })
      ));
    }

    output.push(rewritten);
    depth += braceDeltaForLine(line);
    while (frames.length > 0 && depth < frames.at(-1).depth) frames.pop();
  }

  return output.join('\n');
}

function rewriteTryBodyReturnsForNoExceptions(tryBody, catchBody, tryId = 0) {
  const trimmedCatch = catchBody.trim();
  let returnIndex = 0;
  return tryBody.replace(/^(\s*)return(?:\s+(.+?))?\s*;\s*$/gm, (match, indent, expression) => {
    if (!trimmedCatch) return match;
    if (!expression) {
      return `${indent}if (__tracecode_exception_pending) { __tracecode_exception_pending = false; ${trimmedCatch} }\n${indent}return;`;
    }
    const trimmedExpression = String(expression).trim();
    if (trimmedExpression.startsWith('{')) {
      return `${indent}if (__tracecode_exception_pending) { __tracecode_exception_pending = false; ${trimmedCatch} }\n${indent}return ${trimmedExpression};`;
    }
    const localName = `__tracecode_try_return_${tryId}_${returnIndex++}`;
    return [
      `${indent}auto ${localName} = (${trimmedExpression});`,
      `${indent}if (__tracecode_exception_pending) { __tracecode_exception_pending = false; ${trimmedCatch} }`,
      `${indent}return ${localName};`,
    ].join('\n');
  });
}

function rewriteCppTryCatchWithoutExceptions(source) {
  if (!/\btry\s*\{/.test(source)) return source;
  let output = '';
  let cursor = 0;

  while (cursor < source.length) {
    const tryMatch = /\btry\s*\{/.exec(source.slice(cursor));
    if (!tryMatch) {
      output += source.slice(cursor);
      break;
    }
    const tryStart = cursor + tryMatch.index;
    const tryOpenBrace = source.indexOf('{', tryStart);
    const tryCloseBrace = findMatchingBrace(source, tryOpenBrace);
    if (tryOpenBrace < 0 || tryCloseBrace < 0) {
      output += source.slice(cursor);
      break;
    }
    const catchMatch = /^\s*catch\s*\([^)]*\)\s*\{/.exec(source.slice(tryCloseBrace + 1));
    if (!catchMatch) {
      output += source.slice(cursor, tryCloseBrace + 1);
      cursor = tryCloseBrace + 1;
      continue;
    }
    const catchStart = tryCloseBrace + 1 + catchMatch.index;
    const catchOpenBrace = source.indexOf('{', catchStart);
    const catchCloseBrace = findMatchingBrace(source, catchOpenBrace);
    if (catchOpenBrace < 0 || catchCloseBrace < 0) {
      output += source.slice(cursor);
      break;
    }

    const tryBody = source.slice(tryOpenBrace + 1, tryCloseBrace);
    const catchBody = source.slice(catchOpenBrace + 1, catchCloseBrace);
    const loweredTryBody = rewriteTryBodyReturnsForNoExceptions(tryBody, catchBody, tryStart);
    const loweredCatch = catchBody.trim()
      ? `\nif (__tracecode_exception_pending) { __tracecode_exception_pending = false; ${catchBody.trim()} }\n`
      : '\n__tracecode_exception_pending = false;\n';

    output += source.slice(cursor, tryStart);
    output += `{ __tracecode_exception_pending = false;${loweredTryBody}${loweredCatch}}`;
    cursor = catchCloseBrace + 1;
  }

  return output;
}

function lowerCppExceptionSyntaxForNoExceptions(source, options = {}) {
  if (!/\b(?:try|throw|catch)\b/.test(source)) return source;
  const lowered = rewriteCppThrowsWithoutExceptions(rewriteCppTryCatchWithoutExceptions(source), options);
  return `static bool __tracecode_exception_pending = false;\n${lowered}`;
}

function normalizeCppUserSource(source, options = {}) {
  const withoutUnsupportedIncludes = String(source || '')
    .split(/\r?\n/)
    .map((line) => (/^\s*#\s*include\s*<bits\/stdc\+\+\.h>\s*$/.test(line) ? '' : line))
    .join('\n');
  return lowerCppExceptionSyntaxForNoExceptions(withoutUnsupportedIncludes, {
    emitTraceEvents: options.tracing === true,
  });
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

function findMatchingSquareBracket(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
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

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseMethodSignature(source, functionName, options = {}) {
  if (Number.isFinite(options.parameterCount)) {
    const inputNames = new Set(options.inputNames || []);
    const candidates = parseCppFunctionSignatures(source)
      .filter((signature) => signature.name === functionName)
      .filter((signature) => signature.parameters.length === options.parameterCount);
    const namedCandidate = candidates.find((signature) =>
      signature.parameters.every((parameter) => inputNames.size === 0 || inputNames.has(parameter.name))
    );
    if (namedCandidate) return namedCandidate;
    if (candidates.length > 0) return candidates[candidates.length - 1];
  }

  const cleaned = stripComments(source);
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namePattern = new RegExp(`\\b${escaped}\\s*\\(`, 'g');
  let match = null;
  let openParenIndex = -1;
  let closeParenIndex = -1;
  let foundSignatureMatch = false;

  while ((match = namePattern.exec(cleaned))) {
    const previousPrefix = cleaned.slice(0, match.index).trimEnd();
    const previousChar = previousPrefix.at(-1);
    if (previousChar === '.' || previousPrefix.endsWith('->')) continue;
    openParenIndex = cleaned.indexOf('(', match.index);
    closeParenIndex = findMatchingParen(cleaned, openParenIndex);
    if (closeParenIndex < 0) continue;
    const afterSignature = cleaned.slice(closeParenIndex + 1, closeParenIndex + 96);
    if (!/^\s*(?:(?:const|noexcept|override|final)\b\s*|[&]\s*)*(?:\{|:)/.test(afterSignature)) continue;
    foundSignatureMatch = true;
    break;
  }

  if (!foundSignatureMatch || !match || openParenIndex < 0 || closeParenIndex < 0) {
    const functionField = parseFunctionFieldSignature(cleaned, functionName);
    if (functionField) return functionField;
    throw new Error(`Unable to find C++ Solution method "${functionName}".`);
  }

  const signaturePrefix = cleaned.slice(0, match.index);
  const returnTypeMatch = signaturePrefix.match(/([A-Za-z_][\w:\s<>,*&]*?)\s*$/);
  if (!returnTypeMatch) {
    const functionField = parseFunctionFieldSignature(cleaned, functionName);
    if (functionField) return functionField;
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
  return { returnType: cleanCppReturnType(returnTypeMatch[1]), parameters, line };
}

function parseFunctionFieldSignature(source, functionName) {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`\\b(?:std::)?function\\s*<\\s*([^()<>]+?)\\s*\\(([^<>]*)\\)\\s*>\\s+${escaped}\\s*;`));
  if (!match) return null;
  const [, returnType, parameterText] = match;
  const initializerLambda = source.match(new RegExp(`${escaped}\\s*\\(\\s*\\[[^\\]]*\\]\\s*\\(([^)]*)\\)`));
  const parameters = initializerLambda
    ? parseCppParameters(initializerLambda[1])
    : splitTopLevelCommaList(parameterText)
      .filter(Boolean)
      .map((type, index) => ({ type: type.trim(), name: `arg${index}` }));
  const line = source.slice(0, match.index).split(/\r?\n/).length;
  return { returnType: cleanCppReturnType(returnType), parameters, line };
}

function resolveCppObjectMethodMacro(source, operation) {
  const escaped = operation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cleaned = stripComments(source);
  const macroTarget = cleaned.match(new RegExp(`^\\s*#\\s*define\\s+${escaped}\\s+([A-Za-z_]\\w*)\\s*$`, 'm'))?.[1];
  if (macroTarget) return macroTarget;
  if (operation === 'delete' && /\bdeleteKey\s*\(/.test(cleaned)) return 'deleteKey';
  return operation;
}

function cleanCppReturnType(returnType) {
  return String(returnType || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#?\s*include\s*<[^>]+>\s*/, '').trim())
    .filter(Boolean)
    .at(-1) || '';
}

function parseConstructorSignature(source, className, aliases = new Map(), options = {}) {
  const cleaned = stripComments(source);
  const constructorNames = [...new Set([className, normalizeCppType(className, aliases), resolveCppType(className, aliases)])]
    .filter(Boolean);
  const candidates = [];
  for (const constructorName of constructorNames) {
    const escaped = constructorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namePattern = new RegExp(`\\b${escaped}\\s*\\(`, 'g');
    let match = null;

    while ((match = namePattern.exec(cleaned))) {
      const prefix = cleaned.slice(Math.max(0, match.index - 96), match.index);
      if (/~\s*$/.test(prefix)) continue;
      const previousToken = prefix.match(/([A-Za-z_]\w*)\s*$/)?.[1];
      if (
        previousToken &&
        previousToken !== 'public' &&
        previousToken !== 'private' &&
        previousToken !== 'protected' &&
        !/^(?:explicit|inline|constexpr|consteval)$/.test(previousToken)
      ) {
        continue;
      }
      const openParenIndex = cleaned.indexOf('(', match.index);
      const closeParenIndex = findMatchingParen(cleaned, openParenIndex);
      if (closeParenIndex < 0) continue;
      const parameterText = cleaned.slice(openParenIndex + 1, closeParenIndex);
      let parameters;
      try {
        parameters = parseCppParameters(parameterText);
      } catch (_error) {
        continue;
      }
      candidates.push({
        returnType: className,
        parameters,
        line: cleaned.slice(0, match.index).split(/\r?\n/).length,
      });
    }
  }
  if (Number.isFinite(options.parameterCount)) {
    const arityMatch = candidates.find((signature) => signature.parameters.length === options.parameterCount);
    if (arityMatch) return arityMatch;
  }
  if (candidates.length > 0) return candidates[0];

  return { returnType: className, parameters: [], line: 1 };
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

function sourceDeclaresCppType(source, name) {
  const cleaned = stripComments(source);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(?:class|struct)\\s+${escaped}\\b`).test(cleaned) ||
    new RegExp(`\\busing\\s+${escaped}\\b`).test(cleaned) ||
    new RegExp(`\\btypedef\\b[^;]*\\b${escaped}\\s*;`).test(cleaned);
}

function buildTracecodeFallbackAliases(source) {
  const aliases = [];
  if (!sourceDeclaresCppType(source, 'TreeNode')) aliases.push('using tracecode::TreeNode;');
  if (!sourceDeclaresCppType(source, 'ListNode')) aliases.push('using tracecode::ListNode;');
  return aliases.join('\n');
}

function sourceDeclaresSolutionClass(source) {
  return /\b(?:class|struct)\s+Solution\b/.test(stripComments(source));
}

function sourceDeclaresCustomToJson(source, type) {
  const normalized = normalizeCppType(type);
  if (!/^[A-Za-z_]\w*$/.test(normalized)) return false;
  return new RegExp(`\\btoJson\\s*\\(\\s*(?:const\\s+)?${escapeRegExp(normalized)}\\s*(?:&|\\b)`).test(stripComments(source));
}

function cppJsonExpressionForValue(expression, type, source) {
  return sourceDeclaresCustomToJson(source, type) ? `toJson(${expression})` : `tracecode::to_json(${expression})`;
}

function collectTraceContainerMemberNames(source, aliases = new Map(), className = 'Solution') {
  const names = new Set();
  const cleaned = stripComments(source);
  const classMatch = cleaned.match(new RegExp(`\\b(?:class|struct)\\s+${escapeRegExp(className)}\\b[\\s\\S]*?\\{([\\s\\S]*?)\\n\\s*public\\s*:`)) ||
    cleaned.match(new RegExp(`\\b(?:class|struct)\\s+${escapeRegExp(className)}\\b[\\s\\S]*?\\{([\\s\\S]*?)\\n\\s*\\};`));
  if (!classMatch) return names;
  for (const line of classMatch[1].split(/\r?\n/)) {
    const variables = extractDeclaredSnapshotVariables(`${line.trim().replace(/^(?:public|private|protected)\s*:\s*/, '')}`, aliases);
    for (const variable of variables) {
      const normalizedType = normalizeCppType(variable.type, aliases);
      const innerType = normalizedType.startsWith('vector<') ? normalizedType.slice('vector<'.length, -1).trim() : '';
      if (isVectorCppType(variable.type, aliases) && !innerType.startsWith('vector<') && innerType !== 'string') names.add(variable.name);
    }
  }
  return names;
}

function isScriptExecutionRequest(functionName, options = {}) {
  return !String(functionName || '').trim() && options.executionStyle === 'function';
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
    const closeBraceIndex = findMatchingBrace(cleaned, cursor);
    if (
      closeBraceIndex > cursor &&
      cleaned.slice(0, closeBraceIndex).split(/\r?\n/).length === cleaned.slice(0, cursor).split(/\r?\n/).length
    ) {
      namePattern.lastIndex = closeParenIndex + 1;
      continue;
    }

    const signaturePrefix = cleaned.slice(0, match.index);
    const returnTypeMatch = signaturePrefix.match(/([A-Za-z_][\w:\s<>,*&]*?)\s*$/);
    if (!returnTypeMatch) continue;
    const returnType = cleanCppReturnType(returnTypeMatch[1]);
    if (/^(?:class|struct|public:|private:|protected:)$/.test(returnType)) continue;

    const parameterText = cleaned.slice(openParenIndex + 1, closeParenIndex);
    let parameters;
    try {
      parameters = parseCppParameters(parameterText);
    } catch (_error) {
      namePattern.lastIndex = closeParenIndex + 1;
      continue;
    }
    const line = cleaned.slice(0, match.index).split(/\r?\n/).length;
    signatures.push({
      name,
      returnType,
      parameters,
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
  const inlineLambdaPattern = /\[[^\]]*\]\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?\s*\{/g;

  lines.forEach((line, index) => {
    const match = line.match(lambdaPattern);
    if (match) {
      const [, name, parameterText, returnType] = match;
      signatures.push({
        name,
        returnType: (returnType || 'auto').trim(),
        parameters: parseCppParameters(parameterText),
        line: index + 1,
        bodyLine: index + 1,
        lambda: true,
        skipInstrumentation: /\bvector\s*<\s*bool\s*>/.test(parameterText),
      });
    }

    inlineLambdaPattern.lastIndex = 0;
    let inlineMatch;
    while ((inlineMatch = inlineLambdaPattern.exec(line))) {
      const assignmentPrefix = line.slice(0, inlineMatch.index);
      const assignedName = assignmentPrefix.match(/\b(?:auto|(?:std::)?function\s*<[^=;]+>)\s+([A-Za-z_]\w*)\s*=\s*$/)?.[1];
      if (assignedName && match?.[1] === assignedName) continue;
      const [, parameterText, returnType] = inlineMatch;
      signatures.push({
        name: assignedName || `<lambda:${index + 1}>`,
        returnType: (returnType || 'auto').trim(),
        parameters: parseCppParameters(parameterText),
        line: index + 1,
        bodyLine: index + 1,
        lambda: true,
        skipInstrumentation: /\bvector\s*<\s*bool\s*>/.test(parameterText),
      });
    }
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
    .replace(/\b(?:static|inline|constexpr|consteval|constinit|virtual|friend|explicit|extern|mutable)\b/g, '')
    .replace(/\bconst\b/g, '')
    .replace(/[&]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNullCppReturnType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return normalized === 'nullptr_t' || normalized === 'std::nullptr_t' || normalized === 'void*';
}

function materializedCppType(type, aliases = new Map()) {
  return localCppType(resolveCppType(type, aliases));
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
  if (!normalized.startsWith('vector<') || !normalized.endsWith('>')) return false;
  if (normalized === 'vector<bool>') return false;
  if (normalized.includes('any') || normalized.includes('variant<')) return false;
  if (normalized.startsWith('vector<vector<vector<')) return false;
  if (normalized.includes('*')) return false;
  if (normalized.includes('pair<') || normalized.includes('tuple<')) return false;
  const inner = normalized.slice('vector<'.length, -1).trim().replace(/^std::/, '');
  if (/^[A-Z]/.test(inner)) return false;
  return true;
}

function isDequeCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  if (normalized.includes('pair<') || normalized.includes('tuple<')) return false;
  return normalized.startsWith('deque<') && normalized.endsWith('>');
}

function isAdapterCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  if (normalized.includes('pair<') || normalized.includes('tuple<')) return false;
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

function hasContainerMappedValueCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  const prefix = normalized.startsWith('unordered_map<')
    ? 'unordered_map<'
    : normalized.startsWith('map<')
      ? 'map<'
      : null;
  if (!prefix || !normalized.endsWith('>')) return false;
  const innerTypes = splitTopLevelCommaList(normalized.slice(prefix.length, -1));
  if (innerTypes.length < 2) return false;
  const valueType = innerTypes[1].trim().replace(/^std::/, '');
  return /^(?:vector|deque|queue|priority_queue|stack|map|unordered_map|set|unordered_set)</.test(valueType);
}

function hasAutoReferenceBindingForMapProxy(source, name) {
  const pattern = new RegExp(`\\bauto\\s*&\\s+[A-Za-z_]\\w*\\s*=\\s*${escapeRegExp(name)}\\s*\\[`);
  return pattern.test(stripComments(source || ''));
}

function hasUnsafeMapProxyAutoReferenceBinding(type, source, name, aliases = new Map()) {
  return hasContainerMappedValueCppType(type, aliases) && hasAutoReferenceBindingForMapProxy(source, name);
}

function parameterAddressEscapes(source, name) {
  const pattern = new RegExp(`(?<![\\w>&])&(?!&)\\s*${escapeRegExp(name)}\\b`);
  return pattern.test(stripComments(source || ''));
}

function isSetCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  const prefix = normalized.startsWith('unordered_set<')
    ? 'unordered_set<'
    : normalized.startsWith('set<')
      ? 'set<'
      : null;
  if (!prefix || !normalized.endsWith('>')) return false;
  return splitTopLevelCommaList(normalized.slice(prefix.length, -1)).length === 1;
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
  const rawBudget = Number.isFinite(traceOptions.maxStoredEvents)
    ? Number(traceOptions.maxStoredEvents)
    : Number.isFinite(traceOptions.maxTraceSteps)
      ? Number(traceOptions.maxTraceSteps)
      : Number.isFinite(traceOptions.maxLineEvents)
        ? Number(traceOptions.maxLineEvents)
        : DEFAULT_MAX_STORED_EVENTS;
  return Math.max(1, Math.floor(rawBudget));
}

function traceLineBudgetForOptions(options = {}) {
  const traceOptions = options.traceOptions || {};
  return Number.isFinite(traceOptions.maxLineEvents)
    ? Math.max(1, Math.floor(Number(traceOptions.maxLineEvents)))
    : 0;
}

function traceSingleLineHitBudgetForOptions(options = {}) {
  const traceOptions = options.traceOptions || {};
  return Number.isFinite(traceOptions.maxSingleLineHits)
    ? Math.max(1, Math.floor(Number(traceOptions.maxSingleLineHits)))
    : 0;
}

function minimalTraceForOptions(options = {}) {
  return options?.traceOptions?.minimalTrace === true;
}

function traceBudgetHardStopForOptions(options = {}) {
  const traceOptions = options.traceOptions || {};
  return (
    (Number.isFinite(traceOptions.maxTraceSteps) && !Number.isFinite(traceOptions.maxStoredEvents)) ||
    Number.isFinite(traceOptions.maxLineEvents) ||
    Number.isFinite(traceOptions.maxSingleLineHits)
  );
}

function configureTraceBudgetCall(options = {}) {
  return `tracecode::configure_trace_budget(${traceBudgetForOptions(options)}, ${traceBudgetHardStopForOptions(options) ? 'true' : 'false'}, ${traceLineBudgetForOptions(options)}, ${traceSingleLineHitBudgetForOptions(options)}, ${minimalTraceForOptions(options) ? 'true' : 'false'});`;
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

function buildSerializedQuadNodeLiteral(value, aliases = new Map()) {
  const root = value;
  if (root === null || root === undefined) return 'nullptr';
  if (!isRecord(root)) {
    throw new Error(`Expected Node object input.`);
  }
  const { records, names, ids } = collectSerializedNodes(root, ['topLeft', 'topRight', 'bottomLeft', 'bottomRight']);
  if (records.length === 0) return 'nullptr';
  const lines = ['[&]() -> Node* {'];
  for (const record of records) {
    lines.push(`    Node* ${names.get(record)} = new Node(${toCppLiteral(serializedNodeValue(record), 'int', aliases)}, ${toCppLiteral(Boolean(record.isLeaf), 'bool', aliases)}, nullptr, nullptr, nullptr, nullptr);`);
  }
  for (const record of records) {
    const name = names.get(record);
    lines.push(`    ${name}->topLeft = ${childNodeExpression(record.topLeft, names, ids)};`);
    lines.push(`    ${name}->topRight = ${childNodeExpression(record.topRight, names, ids)};`);
    lines.push(`    ${name}->bottomLeft = ${childNodeExpression(record.bottomLeft, names, ids)};`);
    lines.push(`    ${name}->bottomRight = ${childNodeExpression(record.bottomRight, names, ids)};`);
  }
  lines.push(`    return ${names.get(root)};`);
  lines.push('  }()');
  return lines.join('\n');
}

function buildSerializedBinaryNodeLiteral(value, aliases = new Map()) {
  const root = Array.isArray(value) ? buildTreeObjectFromLevelOrder(value) : value;
  if (root === null || root === undefined) return 'nullptr';
  if (!isRecord(root)) {
    throw new Error(`Expected Node object or level-order array input.`);
  }
  const { records, names, ids } = collectSerializedNodes(root, ['left', 'right']);
  if (records.length === 0) return 'nullptr';
  const lines = ['[&]() -> Node* {'];
  for (const record of records) {
    const nodeValue = serializedNodeValue(record);
    const valueType = typeof nodeValue === 'string' ? 'std::string' : 'int';
    lines.push(`    Node* ${names.get(record)} = new Node(${toCppLiteral(nodeValue, valueType, aliases)}, nullptr, nullptr);`);
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

function buildSerializedNaryNodeLiteral(value, aliases = new Map()) {
  const root = value;
  if (root === null || root === undefined) return 'nullptr';
  if (!isRecord(root)) {
    throw new Error(`Expected N-ary Node object input.`);
  }
  const { records, names, ids } = collectSerializedNodes(root, ['children']);
  function visitChildren(node) {
    if (!isRecord(node) || !Array.isArray(node.children)) return;
    for (const child of node.children) {
      if (isRecord(child) && !names.has(child) && typeof child.__ref__ !== 'string') {
        const name = `__tc_node_${records.length}`;
        names.set(child, name);
        records.push(child);
        if (typeof child.__id__ === 'string' && child.__id__.length > 0) ids.set(child.__id__, name);
        visitChildren(child);
      }
    }
  }
  visitChildren(root);
  if (records.length === 0) return 'nullptr';
  const lines = ['[&]() -> Node* {'];
  for (const record of records) {
    lines.push(`    Node* ${names.get(record)} = new Node(${toCppLiteral(serializedNodeValue(record), 'int', aliases)});`);
  }
  for (const record of records) {
    const childExpressions = Array.isArray(record.children)
      ? record.children.map((child) => childNodeExpression(child, names, ids)).filter((child) => child !== 'nullptr')
      : [];
    lines.push(`    ${names.get(record)}->children = std::vector<Node*>{${childExpressions.join(', ')}};`);
  }
  lines.push(`    return ${names.get(root)};`);
  lines.push('  }()');
  return lines.join('\n');
}

function isPrimitiveCppType(type) {
  return /^(?:bool|char|string|size_t|std::size_t|(?:unsigned)?(?:short|int|long|longlong|longlongint)|float|double|longdouble)$/.test(type);
}

function cppTypeConstructorName(type, aliases = new Map()) {
  return localCppType(resolveCppType(type, aliases));
}

function nestedListElementType(type) {
  const normalized = String(type || '').replace(/\s+/g, '');
  const match = normalized.match(/^([A-Za-z_]\w*)::List$/);
  return match ? match[1] : null;
}

function buildCustomCppObjectLiteral(value, type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  const pointer = normalized.endsWith('*');
  const objectType = pointer ? normalized.slice(0, -1) : normalized;
  if (!objectType || isPrimitiveCppType(objectType) || objectType.includes('<')) return null;
  if (!/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)?$/.test(objectType)) return null;
  const constructorName = cppTypeConstructorName(type, aliases);
  const valueConstructorName = pointer ? constructorName.replace(/\*$/, '').trim() : constructorName;
  const wrap = (args) => pointer ? `new ${valueConstructorName}(${args})` : `${constructorName}{ ${args} }`;

  if (Array.isArray(value)) {
    const nestedElementType = nestedListElementType(objectType);
    const elementType = nestedElementType || objectType;
    return wrap(value.map((entry) => toCppLiteral(entry, elementType, aliases)).join(', '));
  }

  if (isRecord(value)) {
    const recordType = typeof value.__type__ === 'string' ? normalizeCppType(String(value.__type__), aliases) : null;
    if (recordType && recordType !== objectType) return null;
    const entries = Object.entries(value).filter(([key]) => key !== '__type__' && key !== '__id__' && key !== '__ref__');
    return wrap(entries.map(([, child]) => toCppLiteral(child, 'auto', aliases)).join(', '));
  }

  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean' || typeof value === 'string') {
    return wrap(toCppLiteral(value, typeof value === 'string' ? 'string' : typeof value === 'boolean' ? 'bool' : 'long long', aliases));
  }

  return null;
}

function toCppLiteral(value, type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  if (normalized === 'JsonValue' || normalized === 'tracecode::JsonValue') {
    return `tracecode::parse_json(${cppStringLiteral(JSON.stringify(value))})`;
  }
  if (normalized === 'TreeNode*') {
    return buildSerializedTreeNodeLiteral(value, aliases);
  }
  if (normalized === 'TreeNode') {
    return `*(${buildSerializedTreeNodeLiteral(value, aliases)})`;
  }
  if (normalized === 'ListNode*') {
    return buildSerializedListNodeLiteral(value, aliases);
  }
  if (normalized === 'Node*' && isRecord(value) && ('topLeft' in value || 'isLeaf' in value)) {
    return buildSerializedQuadNodeLiteral(value, aliases);
  }
  if (normalized === 'Node*' && isRecord(value) && Array.isArray(value.children)) {
    return buildSerializedNaryNodeLiteral(value, aliases);
  }
  if (normalized === 'Node*' && (Array.isArray(value) || (isRecord(value) && ('left' in value || 'right' in value)))) {
    return buildSerializedBinaryNodeLiteral(value, aliases);
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
  if (normalized.startsWith('tuple<') && normalized.endsWith('>')) {
    if (!Array.isArray(value)) {
      throw new Error(`Expected array input for ${type}.`);
    }
    const tupleTypes = splitTopLevelCommaList(normalized.slice(normalized.indexOf('<') + 1, -1));
    return `{ ${value.map((entry, index) => toCppLiteral(entry, tupleTypes[index] || 'int', aliases)).join(', ')} }`;
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
  if (normalized === 'auto') {
    if (Array.isArray(value)) return `{ ${value.map((entry) => toCppLiteral(entry, 'auto', aliases)).join(', ')} }`;
    if (isRecord(value)) {
      if (typeof value.__type__ !== 'string') {
        return `{ ${Object.entries(value)
          .map(([key, child]) => `{ ${quoteCppString(key)}, ${toCppLiteral(child, 'auto', aliases)} }`)
          .join(', ')} }`;
      }
      const entries = Object.entries(value).filter(([key]) => key !== '__type__' && key !== '__id__' && key !== '__ref__');
      return `{ ${entries.map(([, child]) => toCppLiteral(child, 'auto', aliases)).join(', ')} }`;
    }
  }
  if (/^(?:unsigned)?(?:short|int|long|longlong|longlongint|size_t|std::size_t|float|double|longdouble)$/.test(normalized)) {
    return String(value);
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return quoteCppString(value);
  const customLiteral = buildCustomCppObjectLiteral(value, type, aliases);
  if (customLiteral) return customLiteral;
  throw new Error(`Unsupported C++ literal for type ${type}: ${JSON.stringify(value)}`);
}

function inputValueForParameter(inputs, parameter, index) {
  if (Object.prototype.hasOwnProperty.call(inputs, parameter.name)) return inputs[parameter.name];
  const values = Object.values(inputs || {});
  return values[index];
}

function isDynamicJsonMapKeyType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases).replace(/^std::/, '');
  return isPrimitiveCppType(normalized) || normalized === 'string';
}

function isDynamicJsonInputType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  if (normalized === 'any' || normalized === 'JsonValue' || normalized === 'tracecode::JsonValue') return true;
  if (normalized === 'TreeNode' || normalized === 'TreeNode*' || normalized === 'ListNode' || normalized === 'ListNode*') {
    return true;
  }
  if (isPrimitiveCppType(normalized)) return true;
  if (
    (
      normalized.startsWith('vector<') ||
      normalized.startsWith('deque<') ||
      normalized.startsWith('queue<') ||
      normalized.startsWith('priority_queue<') ||
      normalized.startsWith('stack<') ||
      normalized.startsWith('set<') ||
      normalized.startsWith('unordered_set<')
    ) &&
    normalized.endsWith('>')
  ) {
    return isDynamicJsonInputType(normalized.slice(normalized.indexOf('<') + 1, -1), aliases);
  }
  if (normalized.startsWith('array<') && normalized.endsWith('>')) {
    const args = splitTopLevelCommaList(normalized.slice(normalized.indexOf('<') + 1, -1));
    return args.length >= 1 && isDynamicJsonInputType(args[0], aliases);
  }
  if (
    (
      normalized.startsWith('map<') ||
      normalized.startsWith('unordered_map<')
    ) &&
    normalized.endsWith('>')
  ) {
    const args = splitTopLevelCommaList(normalized.slice(normalized.indexOf('<') + 1, -1));
    return args.length >= 2 && isDynamicJsonMapKeyType(args[0], aliases) && isDynamicJsonInputType(args[1], aliases);
  }
  if (normalized.startsWith('pair<') && normalized.endsWith('>')) {
    const args = splitTopLevelCommaList(normalized.slice(normalized.indexOf('<') + 1, -1));
    return args.length >= 2 && isDynamicJsonInputType(args[0], aliases) && isDynamicJsonInputType(args[1], aliases);
  }
  if (normalized.startsWith('tuple<') && normalized.endsWith('>')) {
    const args = splitTopLevelCommaList(normalized.slice(normalized.indexOf('<') + 1, -1));
    return args.length > 0 && args.every((arg) => isDynamicJsonInputType(arg, aliases));
  }
  return false;
}

function cppDynamicInputExpression(parameter, index, aliases = new Map()) {
  if (!isDynamicJsonInputType(parameter.type, aliases)) return null;
  const normalized = normalizeCppType(parameter.type, aliases);
  const inputValue = `tracecode::json_input_value(__tc_inputs, ${cppStringLiteral(parameter.name)}, ${index})`;
  if (normalized === 'TreeNode*') {
    return `tracecode::json_to_tree_node<${materializedCppType(parameter.type, aliases).replace(/\*$/, '').trim()}>(${inputValue})`;
  }
  if (normalized === 'TreeNode') {
    return `*tracecode::json_to_tree_node<${materializedCppType(parameter.type, aliases)}>(${inputValue})`;
  }
  if (normalized === 'ListNode*') {
    return `tracecode::json_to_list_node<${materializedCppType(parameter.type, aliases).replace(/\*$/, '').trim()}>(${inputValue})`;
  }
  if (normalized === 'ListNode') {
    return `*tracecode::json_to_list_node<${materializedCppType(parameter.type, aliases)}>(${inputValue})`;
  }
  return `tracecode::read_json_input<${materializedCppType(parameter.type, aliases)}>(__tc_inputs, ${cppStringLiteral(parameter.name)}, ${index})`;
}

function buildGeneratedIncludes(source, signature) {
  const probe = `${source}\n${signature.parameters.map((parameter) => parameter.type).join('\n')}`;
  const includes = new Set(CPP_BASE_GENERATED_INCLUDES);
  for (const [pattern, include] of CPP_STANDARD_INCLUDE_RULES) {
    if (pattern.test(probe)) includes.add(include);
  }
  return [...includes].join('\n');
}

function buildTraceArgsJsonExpression(signature, variableNameForParameter = (_parameter, index) => `__tc_arg_${index}`, aliases = new Map()) {
  const pieces = [];
  signature.parameters.forEach((parameter, index) => {
    const normalizedType = normalizeCppType(parameter.type);
    if (
      normalizedType === 'auto' ||
      normalizedType === 'vector<bool>' ||
      /\bauto\b/.test(parameter.type) ||
      /\bauto\b/.test(normalizedType) ||
      !isSnapshotSerializableCppType(parameter.type, aliases)
    ) return;
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

function parenDeltaForLine(line) {
  const stripped = stripCppStringsAndComments(line);
  let delta = 0;
  for (const ch of stripped) {
    if (ch === '(') delta += 1;
    if (ch === ')') delta -= 1;
  }
  return delta;
}

function shouldInstrumentCppLine(line) {
  const trimmed = stripCppStringsAndComments(line).trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#') || trimmed.startsWith('//')) return false;
  if (/^(public|private|protected)\s*:/.test(trimmed)) return false;
  if (/^(else|catch)\b/.test(trimmed)) return false;
  if (/^(case\b|default\s*:)/.test(trimmed)) return false;
  if (/^delete\b/.test(trimmed)) return false;
  if (/\b(?:destroy|cleanup|deleteTree|deleteList)\s*\(/i.test(trimmed)) return false;
  if (/^[{};]+$/.test(trimmed)) return false;
  if (/^};?$/.test(trimmed)) return false;
  return (
    /;$/.test(trimmed) ||
    /^(if|for|while|switch)\s*\(/.test(trimmed) ||
    /^do\b/.test(trimmed) ||
    /^return\b/.test(trimmed)
  );
}

function isUnbracedControlHeader(line, nextLine = '') {
  const trimmed = stripCppStringsAndComments(line).trim();
  if (!/^(?:if|else\s+if|for|while)\s*\(.*\)\s*$/.test(trimmed)) return false;
  if (trimmed.includes('{') || trimmed.endsWith(';')) return false;
  const nextTrimmed = stripCppStringsAndComments(nextLine).trim();
  return Boolean(nextTrimmed) && !nextTrimmed.startsWith('{');
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
  if (normalized === 'vector<bool>') return false;
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
    .filter(([, variable]) => {
      if (variable.declarationLine === lineNumber && !variable.sameLineVisible) return false;
      return variable.scopeDepth <= currentDepth || variable.declarationLine === lineNumber;
    })
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
  const match = trimmed.match(/^([A-Za-z_]\w*)(?:\.|->)([A-Za-z_]\w*)(?:(?:\.|->)[A-Za-z_]\w*)*(?:\s*\[\s*([^\[\]]+?)\s*\])?$/);
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
  const match = line.match(/^(\s*)([A-Za-z_]\w*)((?:\.|->))([A-Za-z_]\w*)(?:\s*\[\s*([^\[\]]+?)\s*\])?\s*=\s*(.+?)\s*;\s*$/);
  if (!match) return line;
  const [, indent, objectName, operator, fieldName, keyExpression] = match;
  const targetExpression = buildFieldTargetJsonExpression(objectName, fieldName, keyExpression?.trim());
  const valueExpression = keyExpression
    ? `${objectName}${operator}${fieldName}[${keyExpression.trim()}]`
    : `${objectName}${operator}${fieldName}`;
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

function splitTopLevelTernaryExpression(expression) {
  let depth = 0;
  let questionIndex = -1;
  for (let index = 0; index < expression.length; index += 1) {
    const ch = expression[index];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === '?' && depth === 0) {
      questionIndex = index;
      break;
    }
  }
  if (questionIndex < 0) return null;
  depth = 0;
  for (let index = questionIndex + 1; index < expression.length; index += 1) {
    const ch = expression[index];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ':' && depth === 0) {
      return {
        condition: expression.slice(0, questionIndex).trim(),
        whenTrue: expression.slice(questionIndex + 1, index).trim(),
        whenFalse: expression.slice(index + 1).trim(),
      };
    }
  }
  return null;
}

function buildPostLineInstrumentation(lineNumber, functionName, variables, currentDepth, indent = '', includeSnapshots = true) {
  const pieces = [
    `${indent}${buildLineInstrumentation(lineNumber, functionName)}`,
  ];
  const snapshots = includeSnapshots ? buildSnapshotInstrumentation(lineNumber, variables, currentDepth) : '';
  if (snapshots) {
    pieces.push(snapshots
      .split('\n')
      .filter(Boolean)
      .map((line) => `${indent}${line}`)
      .join('\n'));
  }
  return pieces.join('\n');
}

function shouldEmitCppFrameSnapshots(activeSignature, insideLocalLambdaBody) {
  return Boolean(activeSignature) && (!insideLocalLambdaBody || Boolean(activeSignature.lambda));
}

function buildValueReturnInstrumentation(expression, lineNumber, signature, indent = '', postLineInstrumentation = '') {
  const returnEventPrefix = `{"kind":"return","line":${lineNumber},"function":${jsonStringLiteral(signature.name)},"value":`;
  const returnStorageType = signature.returnType && signature.returnType.trim() !== 'auto'
    ? localCppType(signature.returnType)
    : 'auto';
  const trimmedExpression = expression.trim();
  const ternary = returnStorageType !== 'auto' ? splitTopLevelTernaryExpression(trimmedExpression) : null;
  const returnStorageIsPointer = /\*$/.test(returnStorageType.trim());
  const returnDeclaration =
    ternary
      ? returnStorageIsPointer
        ? `${returnStorageType} __tc_return_${lineNumber} = (${ternary.condition}) ? (${ternary.whenTrue}) : (${ternary.whenFalse});`
        : `${returnStorageType} __tc_return_${lineNumber} = (${ternary.condition}) ? ${returnStorageType}(${ternary.whenTrue}) : ${returnStorageType}(${ternary.whenFalse});`
      : returnStorageType !== 'auto' && trimmedExpression.startsWith('{') && trimmedExpression.endsWith('}')
      ? `${returnStorageType} __tc_return_${lineNumber} ${trimmedExpression};`
      : `${returnStorageType} __tc_return_${lineNumber} = (${expression});`;
  return [
    `${indent}${returnDeclaration}`,
    buildFieldReadInstrumentation(trimmedExpression, `__tc_return_${lineNumber}`, lineNumber, indent),
    postLineInstrumentation,
    `${indent}tracecode::write_trace_event_json(std::string(${cppStringLiteral(returnEventPrefix)}) + ${signature.customJsonReturn ? `toJson(__tc_return_${lineNumber})` : `tracecode::to_json(__tc_return_${lineNumber})`} + "}", ${lineNumber});`,
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
  const match = line.match(/^(\s*)((?:else\s+if|if|for|while)\s*\(.*?\)|else)\s+return(?:\s+(.+?))?\s*;\s*$/);
  if (!match) return line;
  const [, indent, control, expression] = match;
  if (/^\s*(?:do|switch)\b/.test(line)) return line;
  if (control !== 'else' && parenDeltaForLine(control) !== 0) return line;
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
  const match = line.match(/^(\s*)((?:else\s+if|if|for|while)\s*\(.*?\)|else)\s*\{\s*return(?:\s+(.+?))?\s*;\s*\}\s*$/);
  if (!match) return line;
  const [, indent, control, expression] = match;
  if (control !== 'else' && parenDeltaForLine(control) !== 0) return line;
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

function rewriteTraceContainerParameters(line, signature, aliases = new Map(), source = '') {
  let rewritten = line;
  const skipNames = signature.skipTraceParameterNames || new Set();
  for (const parameter of signature.parameters) {
    if (skipNames.has(parameter.name)) continue;
    if (!isTraceWrappedCppType(parameter.type, aliases)) continue;
    if (/\bconst\b/.test(parameter.type)) continue;
    if (hasUnsafeMapProxyAutoReferenceBinding(parameter.type, source, parameter.name, aliases)) continue;
    const baseParameterType = parameter.type.replace(/[&]/g, '').trim();
    const typePattern = escapeRegExp(baseParameterType).replace(/\\\s+/g, '\\s+');
    const pattern = new RegExp(`${typePattern}\\s*&?\\s+${escapeRegExp(parameter.name)}\\b`);
    const beforePrimaryRewrite = rewritten;
    rewritten = rewritten.replace(pattern, (match) => {
      const rewrittenType = /&/.test(match)
        ? `${cppTraceType(parameter.type, aliases)}&`
        : cppTraceType(parameter.type, aliases);
      return `${rewrittenType} ${parameter.name}`;
    });
    if (rewritten === beforePrimaryRewrite) {
      const fallbackPattern = new RegExp(`((?:std::)?(?:vector|deque|queue|priority_queue|stack|unordered_map|map|unordered_set|set)\\s*<.+>)\\s*(&?)\\s*${escapeRegExp(parameter.name)}\\b`);
      rewritten = rewritten.replace(fallbackPattern, (_match, _type, ref) => {
        const rewrittenType = ref ? `${cppTraceType(parameter.type, aliases)}&` : cppTraceType(parameter.type, aliases);
        return `${rewrittenType} ${parameter.name}`;
      });
    }
  }
  return rewritten;
}

function rewriteSingleLineControlBody(line, lineNumber, functionName, postLineInstrumentation = '', emitInsideBody = false) {
  const match = line.match(/^(\s*)((?:else\s+if|if|for|while)\s*\(.*?\)|else)\s+([^{}].*;\s*)$/);
  if (!match) return line;
  const [, indent, control, statement] = match;
  if (/^\s*(?:do|switch)\b/.test(line)) return line;
  if (control !== 'else' && parenDeltaForLine(control) !== 0) return line;
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
  const match = line.match(/^(\s*)((?:else\s+if|if|for|while)\s*\(.*?\)|else)\s*\{\s*([^{}].*;\s*)\}\s*$/);
  if (!match) return line;
  const [, indent, control, statement] = match;
  if (/^\s*(?:do|switch)\b/.test(line)) return line;
  if (control !== 'else' && parenDeltaForLine(control) !== 0) return line;
  return `${indent}${control} { ${buildCurrentLineInstrumentation(lineNumber)} ${statement.trim()} ${postLineInstrumentation} }`;
}

function rewriteVectorElementMemberAccess(line, variables, aliases = new Map(), extraTraceContainerNames = new Set()) {
  let rewritten = line;
  const candidateNames = new Set(extraTraceContainerNames);
  for (const [name, variable] of variables || []) {
    const normalizedType = normalizeCppType(variable.type, aliases);
    const innerType = normalizedType.startsWith('vector<') ? normalizedType.slice('vector<'.length, -1).trim() : '';
    if (
      isVectorCppType(variable.type, aliases) &&
      !/\bconst\b/.test(variable.type) &&
      !innerType.startsWith('vector<') &&
      innerType !== 'string' &&
      !/^(?:array|deque|queue|priority_queue|stack|map|unordered_map|set|unordered_set)</.test(innerType.replace(/^std::/, ''))
    ) {
      candidateNames.add(name);
    }
  }
  for (const name of candidateNames) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\[[^\\]]+\\]\\s*\\.`, 'g');
    rewritten = rewritten.replace(pattern, (match) => match.replace(/\.\s*$/, '->'));
  }
  return rewritten;
}

function previousNonWhitespace(source, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(source[cursor])) return source[cursor];
  }
  return '';
}

function nextNonWhitespace(source, index) {
  for (let cursor = index; cursor < source.length; cursor += 1) {
    if (!/\s/.test(source[cursor])) return { ch: source[cursor], index: cursor };
  }
  return { ch: '', index: source.length };
}

function isIndexReadInstrumentableCppType(type, aliases = new Map()) {
  const normalized = normalizeCppType(type, aliases);
  return (
    normalized.startsWith('vector<') ||
    normalized.startsWith('array<') ||
    normalized.startsWith('deque<') ||
    normalized === 'string'
  );
}

function rewriteIndexReadInstrumentation(line, variables, aliases = new Map(), lineNumber = 1) {
  const candidateNames = [...(variables || []).entries()]
    .filter(([, variable]) => isIndexReadInstrumentableCppType(variable.type, aliases))
    .map(([name]) => name)
    .sort((left, right) => right.length - left.length);
  if (candidateNames.length === 0) return line;

  let rewritten = line;
  for (const name of candidateNames) {
    let cursor = 0;
    while (cursor < rewritten.length) {
      const nameIndex = rewritten.indexOf(name, cursor);
      if (nameIndex < 0) break;
      const before = nameIndex > 0 ? rewritten[nameIndex - 1] : '';
      const afterName = rewritten[nameIndex + name.length] || '';
      if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(afterName)) {
        cursor = nameIndex + name.length;
        continue;
      }
      let bracketIndex = nameIndex + name.length;
      while (/\s/.test(rewritten[bracketIndex] || '')) bracketIndex += 1;
      if (rewritten[bracketIndex] !== '[') {
        cursor = nameIndex + name.length;
        continue;
      }
      const closeIndex = findMatchingSquareBracket(rewritten, bracketIndex);
      if (closeIndex < 0) {
        cursor = nameIndex + name.length;
        continue;
      }
      const previous = previousNonWhitespace(rewritten, nameIndex);
      const next = nextNonWhitespace(rewritten, closeIndex + 1);
      const twoCharNext = rewritten.slice(next.index, next.index + 2);
      if (
        previous === '&' ||
        next.ch === '[' ||
        next.ch === '.' ||
        twoCharNext === '->' ||
        twoCharNext === '++' ||
        twoCharNext === '--' ||
        (/^[+\-*/%]?=$/.test(twoCharNext) && twoCharNext !== '==') ||
        (next.ch === '=' && rewritten[next.index + 1] !== '=')
      ) {
        cursor = closeIndex + 1;
        continue;
      }
      const indexExpression = rewritten.slice(bracketIndex + 1, closeIndex).trim();
      const replacement = `tracecode::trace_index_read(${name}, ${cppStringLiteral(name)}, ${indexExpression}, ${lineNumber})`;
      rewritten = `${rewritten.slice(0, nameIndex)}${replacement}${rewritten.slice(closeIndex + 1)}`;
      cursor = nameIndex + replacement.length;
    }
  }
  return rewritten;
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

function rewriteTraceMultipleContainerLocals(line, lineNumber, aliases = new Map(), source = '') {
  const collapsed = line.replace(/\s*\n\s*/g, ' ');
  const match = collapsed.match(/^(\s*)((?:(?:std::)?(?:vector|deque|queue|priority_queue|stack|unordered_map|map|unordered_set|set)\s*<.+>|[A-Za-z_]\w*))\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)+)\s*;\s*$/);
  if (!match) return line;
  const [, indent, declaredType, namesSource] = match;
  if (!isTraceWrappedCppType(declaredType, aliases)) return line;
  if (
    hasContainerMappedValueCppType(declaredType, aliases) &&
    namesSource.split(',').some((name) => hasAutoReferenceBindingForMapProxy(source, name.trim()))
  ) return line;
  const type = cppTraceType(declaredType, aliases);
  return namesSource
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => `${indent}${type} ${name}(${cppStringLiteral(name)}, ${lineNumber});`)
    .join('\n');
}

function localVectorStringFeedsTraceWrappedParameter(source, name, aliases = new Map()) {
  const signatures = parseCppFunctionSignatures(source);
  for (const signature of signatures) {
    for (const [index, parameter] of signature.parameters.entries()) {
      if (/\bconst\b/.test(parameter.type)) continue;
      if (parameterAddressEscapes(source, parameter.name)) continue;
      if (normalizeCppType(parameter.type, aliases) !== 'vector<string>') continue;
      const callPattern = new RegExp(`\\b${escapeRegExp(signature.name)}\\s*\\(`, 'g');
      let match;
      while ((match = callPattern.exec(source))) {
        const openParenIndex = source.indexOf('(', match.index);
        const closeParenIndex = findMatchingParen(source, openParenIndex);
        if (closeParenIndex < 0) continue;
        const args = splitTopLevelCommaList(source.slice(openParenIndex + 1, closeParenIndex));
        if (args[index]?.trim() === name) return true;
        callPattern.lastIndex = closeParenIndex + 1;
      }
    }
  }
  return false;
}

function localNestedVectorUsedInMinMaxInitializerList(source, name) {
  const escapedName = escapeRegExp(name);
  const pattern = new RegExp(`\\b(?:std::)?(?:min|max)\\s*\\(\\s*\\{[^}]*\\b${escapedName}\\s*\\[`, 's');
  return pattern.test(stripComments(source || ''));
}

function rewriteTraceContainerLocal(line, lineNumber, aliases = new Map(), source = '') {
  const collapsed = line.replace(/\s*\n\s*/g, ' ');
  const multiple = rewriteTraceMultipleContainerLocals(collapsed, lineNumber, aliases, source);
  if (multiple !== collapsed) return multiple;
  const declarationParts = collapsed.match(/^(\s*)((?:(?:std::)?(?:vector|deque|queue|priority_queue|stack|unordered_map|map|unordered_set|set)\s*<.+>|[A-Za-z_]\w*))\s+(.+);\s*$/);
  if (declarationParts && splitTopLevelCommaList(declarationParts[3]).length > 1) return line;
  let match = collapsed.match(/^(\s*)((?:(?:std::)?(?:vector|deque|queue|priority_queue|stack|unordered_map|map|unordered_set|set)\s*<.+>|[A-Za-z_]\w*))\s+([A-Za-z_]\w*)\s*(?:\((.*)\)|=\s*(.+)|(\{.*\}))?\s*;\s*$/);
  if (!match) return line;
  const [, indent, declaredType, name, constructorArgs, assignedValue, bracedValue] = match;
  if (!isTraceWrappedCppType(declaredType, aliases)) return line;
  if (
    normalizeCppType(declaredType, aliases) === 'vector<string>' &&
    !localVectorStringFeedsTraceWrappedParameter(source, name, aliases)
  ) return line;
  if (
    normalizeCppType(declaredType, aliases).startsWith('vector<vector<') &&
    localNestedVectorUsedInMinMaxInitializerList(source, name)
  ) return line;
  if (hasUnsafeMapProxyAutoReferenceBinding(declaredType, source, name, aliases)) return line;
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
  userCode = normalizeCppUserSource(userCode, options);
  const aliases = collectCppTypeAliases(userCode);
  const { operations, argumentsList } = getOpsClassInputs(inputs || {});
  let firstOperationIndex = 1;
  let constructorArgumentIndex = 0;
  if (operations[0] === '__init__') {
    firstOperationIndex = 1;
    constructorArgumentIndex = 0;
  } else if (operations[0] === className) {
    firstOperationIndex = 1;
    constructorArgumentIndex = 0;
  } else if (operations.length > 0) {
    firstOperationIndex = 0;
    constructorArgumentIndex = -1;
  } else {
    throw new Error(`C++ ops-class inputs must start with constructor operation "${className}".`);
  }

  const firstMethod = operations.slice(firstOperationIndex).find((operation) => typeof operation === 'string' && operation.trim());
  const firstMethodForTracing = firstMethod ? resolveCppObjectMethodMacro(userCode, firstMethod) : firstMethod;
  const sourceForDriver = options.tracing === true && firstMethod
    ? instrumentCppSourceForTracing(userCode, firstMethodForTracing, { traceMemberClassName: className })
    : userCode;
  const lines = [];
  const constructorArgs = constructorArgumentIndex >= 0 ? normalizeOpsArguments(argumentsList[constructorArgumentIndex]) : [];
  const constructorSignature = parseConstructorSignature(userCode, className, aliases, {
    parameterCount: constructorArgs.length,
  });
  if (constructorArgs.length !== constructorSignature.parameters.length) {
    throw new Error(`C++ ops-class constructor "${className}" expected ${constructorSignature.parameters.length} args, received ${constructorArgs.length}.`);
  }
  lines.push(`  ${configureTraceBudgetCall(options)}`);
  const constructorArgNames = constructorArgs.map((value, index) => {
    const localName = `__tc_ctor_arg_${index}`;
    const type = localCppType(constructorSignature.parameters[index].type);
    lines.push(`  ${type} ${localName} = ${toCppLiteral(value, constructorSignature.parameters[index].type, aliases)};`);
    return localName;
  });
  const constructorArgsSource = constructorArgNames.join(', ');
  lines.push(constructorArgs.length === 0
    ? `  ${className} __tc_instance;`
    : `  ${className} __tc_instance(${constructorArgsSource});`);
  lines.push('  std::vector<std::string> __tc_outputs;');
  if (constructorArgumentIndex >= 0) {
    lines.push('  __tc_outputs.push_back("null");');
  }

  for (let index = firstOperationIndex; index < operations.length; index += 1) {
    const operation = operations[index];
    if (typeof operation !== 'string' || !operation.trim()) {
      throw new Error(`C++ ops-class operation at index ${index} must be a method name.`);
    }
    const signatureOperation = resolveCppObjectMethodMacro(userCode, operation);
    const signature = parseMethodSignature(userCode, signatureOperation);
    const args = normalizeOpsArguments(argumentsList[index]);
    if (args.length !== signature.parameters.length) {
      throw new Error(`C++ ops-class method "${operation}" expected ${signature.parameters.length} args, received ${args.length}.`);
    }
    const argNames = [];
    signature.parameters.forEach((parameter, argIndex) => {
      const localName = `__tc_op_${index}_arg_${argIndex}`;
      const shouldTraceParameter = options.tracing === true &&
        isTraceWrappedCppType(parameter.type, aliases) &&
        !hasUnsafeMapProxyAutoReferenceBinding(parameter.type, userCode, parameter.name, aliases);
      const declarationType = shouldTraceParameter
        ? cppTraceType(parameter.type, aliases)
        : localCppType(parameter.type);
      const value = args[argIndex];
      if (shouldTraceParameter) {
        lines.push(`  ${declarationType} ${localName}(${materializedCppType(parameter.type, aliases)}(${toCppLiteral(value, parameter.type, aliases)}), ${cppStringLiteral(parameter.name)}, ${signature.line});`);
      } else {
        lines.push(`  ${declarationType} ${localName} = ${toCppLiteral(value, parameter.type, aliases)};`);
      }
      argNames.push(localName);
    });
    if (options.tracing === true) {
      const callEventPrefix = `{"kind":"call","line":${signature.line},"function":${jsonStringLiteral(operation)},"args":`;
      lines.push(`  std::string __tc_args_json_${index} = std::string("{") + ${buildTraceArgsJsonExpression(signature, (_parameter, argIndex) => `__tc_op_${index}_arg_${argIndex}`, aliases)} + "}";`);
      lines.push(`  tracecode::write_trace_event_json(std::string(${cppStringLiteral(callEventPrefix)}) + __tc_args_json_${index} + "}", ${signature.line});`);
    }
    if (normalizeCppType(signature.returnType, aliases) === 'void' || isNullCppReturnType(signature.returnType, aliases)) {
      lines.push(`  __tc_instance.${signatureOperation}(${argNames.join(', ')});`);
      lines.push('  __tc_outputs.push_back("null");');
    } else {
      lines.push(`  auto __tc_op_${index}_result = __tc_instance.${signatureOperation}(${argNames.join(', ')});`);
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
${buildTracecodeFallbackAliases(userCode)}

#line 1 "${CPP_USER_SOURCE_FILE}"
${sourceForDriver}

#line 1 "TraceCodeDriver.cpp"
int main() {
${lines.join('\n')}
  return 0;
}
`;
}

function inferAutoSnapshotVariableType(initializer, knownVariables, aliases = new Map()) {
  const expression = stripCppStringsAndComments(initializer).trim();
  const directVariableMatch = expression.match(/^([A-Za-z_]\w*)$/);
  if (directVariableMatch && knownVariables?.has(directVariableMatch[1])) {
    const type = knownVariables.get(directVariableMatch[1])?.type || '';
    return isSnapshotSerializableCppType(type, aliases) ? type : null;
  }
  if (/^(?:true|false)$/.test(expression)) return 'bool';
  if (/^"(?:\\.|[^"\\])*"$/.test(expression)) return 'string';
  if (/^[+-]?\d+$/.test(expression)) return 'long long';
  if (/^[+-]?(?:(?:\d+\.\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(expression)) return 'double';
  return null;
}

function extractDeclaredSnapshotVariables(line, aliases = new Map(), knownVariables = null) {
  const variables = [];
  const collapsed = line.replace(/\s*\n\s*/g, ' ').trim();
  if (!collapsed || collapsed.startsWith('//')) return variables;

  const rangeMatch = collapsed.match(/^(?:for)\s*\(\s*([^:;]+?)\s+([A-Za-z_]\w*)\s*:\s*.+\)/);
  if (rangeMatch) {
    if (!collapsed.includes('{')) return variables;
    const [, type, name] = rangeMatch;
    if (isSnapshotSerializableCppType(type, aliases)) variables.push({ name, type, sameLineVisible: true });
    return variables;
  }

  const forInitMatch = collapsed.match(/^for\s*\(\s*([^;]+);/);
  if (forInitMatch) {
    if (!collapsed.includes('{')) return variables;
    variables.push(...extractDeclaredSnapshotVariables(`${forInitMatch[1]};`, aliases, knownVariables).map((variable) => ({
      ...variable,
      sameLineVisible: true,
    })));
    return variables;
  }

  const declarationMatch = collapsed.match(/^((?:(?:const|unsigned|long|short|signed)\s+)*(?:(?:std::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)?(?:\s*<.+>)?(?:\s*\*)?))\s+(.+);\s*$/);
  if (!declarationMatch) return variables;
  const [, rawType, declaratorsSource] = declarationMatch;
  const rawTypeSerializable = isSnapshotSerializableCppType(rawType, aliases);
  const rawTypeIsAuto = normalizeCppType(rawType, aliases) === 'auto';
  if (!rawTypeSerializable && !rawTypeIsAuto) return variables;
  for (const declarator of splitTopLevelCommaList(declaratorsSource)) {
    const trimmedDeclarator = declarator.trim();
    const nameMatch = trimmedDeclarator.match(/^([A-Za-z_]\w*)\b/);
    const variableType = rawTypeSerializable
      ? rawType
      : inferAutoSnapshotVariableType(trimmedDeclarator.replace(/^([A-Za-z_]\w*)\s*=\s*/, ''), knownVariables, aliases);
    if (nameMatch) {
      if (!variableType) continue;
      variables.push({
        name: nameMatch[1],
        type: variableType,
        sameLineVisible: true,
      });
    }
  }
  return variables;
}

function instrumentCppSourceForTracing(source, functionName, options = {}) {
  const aliases = collectCppTypeAliases(source);
  const traceMemberNames = collectTraceContainerMemberNames(source, aliases, options.traceMemberClassName || 'Solution');
  const targetSignature = parseMethodSignature(source, functionName);
  const skipTraceParameterNames = new Set(
    targetSignature.parameters
      .filter((parameter) => parameterAddressEscapes(source, parameter.name))
      .map((parameter) => parameter.name)
  );
  targetSignature.skipTraceParameterNames = skipTraceParameterNames;
  const signatures = parseCppFunctionSignatures(source);
  for (const signature of signatures) {
    signature.customJsonReturn = sourceDeclaresCustomToJson(source, signature.returnType);
    if (/^(?:destroy|free|cleanup|deleteTree|deleteList)$/i.test(signature.name)) {
      signature.skipInstrumentation = true;
    }
    signature.skipTraceParameterNames = new Set(
      signature.parameters
        .filter((parameter) => parameterAddressEscapes(source, parameter.name))
        .map((parameter) => parameter.name)
    );
  }
  targetSignature.customJsonReturn = sourceDeclaresCustomToJson(source, targetSignature.returnType);
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
  let multilineControlConditionDepth = 0;
  let multilineStatementDepth = 0;
  let multilineStatementContinuation = false;
  let localLambdaDepth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const activeFrame = frameStack.at(-1) || null;
    const activeSignature = activeFrame?.signature || null;
    const skipActiveInstrumentation = Boolean(activeSignature?.skipInstrumentation);
    const activeClassName = classStack.at(-1)?.name || null;
    const localClassDeclarationLine = Boolean(activeFrame) && /\b(?:class|struct)\s+[A-Za-z_]\w*\b/.test(stripCppStringsAndComments(line));
    const insideLocalClassDeclaration = Boolean(activeFrame) && (classStack.some((entry) => entry.local) || localClassDeclarationLine);
    if (!pendingSignature && nextSignatureIndex < signatures.length && lineNumber >= signatures[nextSignatureIndex].line) {
      pendingSignature = signatures[nextSignatureIndex];
      nextSignatureIndex += 1;
    }

    const inFunctionBodyBeforeLine = Boolean(activeFrame) && activeFrame.depth > 0 && !insideLocalClassDeclaration;
    const trimmedLine = line.trim();
    const strippedLine = stripCppStringsAndComments(line);
    const strippedTrimmedLine = strippedLine.trim();
    const nextSourceLine = lines[index + 1]?.trim() || '';
    const nextStrippedLine = stripCppStringsAndComments(lines[index + 1] || '').trim();
    if (activeFrame && /^}\s*else\b/.test(trimmedLine)) {
      for (const [name, variable] of activeFrame.variables) {
        if (variable.scopeDepth >= activeFrame.depth) activeFrame.variables.delete(name);
      }
    }
    const lineStartsElse = /^else\b/.test(trimmedLine);
    const insideLocalLambdaBody = localLambdaDepth > 0;
    const includeSnapshotsForActiveFrame = shouldEmitCppFrameSnapshots(activeSignature, insideLocalLambdaBody);
    const startsLocalLambdaBody =
      inFunctionBodyBeforeLine &&
      /\b(?:auto|(?:std::)?function\s*<[^=;]+>)\s+[A-Za-z_]\w*\s*=\s*\[[^\]]*\]\s*\([^)]*\)\s*(?:->\s*[^{]+)?\{/.test(strippedLine);
    const unbracedControlHeaderLine = isUnbracedControlHeader(line, lines[index + 1] || '');
    const unbracedControlBodyLine = index > 0 && isUnbracedControlHeader(lines[index - 1] || '', line);
    const lineParenDelta = parenDeltaForLine(line);
    const startsMultilineControlCondition =
      inFunctionBodyBeforeLine &&
      multilineControlConditionDepth === 0 &&
      /^\s*(?:if|else\s+if|while|for|switch)\s*\(/.test(stripCppStringsAndComments(line)) &&
      lineParenDelta > 0;
    const startsContinuationStatement =
      inFunctionBodyBeforeLine &&
      multilineStatementDepth === 0 &&
      !multilineStatementContinuation &&
      !startsMultilineControlCondition &&
      !/[;{}]\s*$/.test(strippedTrimmedLine) &&
      (
        /(?:,|\+|-|\*|\/|%|&&|\|\||\?|:)\s*$/.test(strippedTrimmedLine) ||
        /^(?:return\b|[\w:<>,\s*&*]+\s+[A-Za-z_]\w*\s*[=({]|(?:std::)?priority_queue\s*<)/.test(strippedTrimmedLine) ||
        /^(?:,|\+|-|\*|\/|%|&&|\|\||\?|:)/.test(nextStrippedLine)
      );
    const inMultilineControlCondition =
      inFunctionBodyBeforeLine && (multilineControlConditionDepth > 0 || startsMultilineControlCondition);
    const startsMultilineStatement =
      inFunctionBodyBeforeLine &&
      multilineStatementDepth === 0 &&
      !multilineStatementContinuation &&
      !startsMultilineControlCondition &&
      (lineParenDelta > 0 || startsContinuationStatement) &&
      !/;\s*$/.test(stripCppStringsAndComments(line).trim());
    const inMultilineStatement =
      inFunctionBodyBeforeLine && (multilineStatementDepth > 0 || multilineStatementContinuation || startsMultilineStatement);
    const shouldInstrumentLine = inFunctionBodyBeforeLine &&
      !skipActiveInstrumentation &&
      !unbracedControlHeaderLine &&
      !unbracedControlBodyLine &&
      !inMultilineControlCondition &&
      !inMultilineStatement &&
      !lineStartsElse &&
      shouldInstrumentCppLine(line);
    if (shouldInstrumentLine) {
      output.push(`#line ${lineNumber} "${CPP_USER_SOURCE_FILE}"`);
      output.push(buildCurrentLineInstrumentation(lineNumber));
    }

    let lineForDriver = pendingSignature
      ? rewriteTraceContainerParameters(line, pendingSignature, aliases, source)
      : line;
    if (pendingSignature && options.traceMemberClassName && pendingSignature.name !== functionName) {
      lineForDriver = line;
    }
    if (inFunctionBodyBeforeLine && !skipActiveInstrumentation && !unbracedControlHeaderLine && !unbracedControlBodyLine && !inMultilineControlCondition && !inMultilineStatement) {
      const declaration = findContainerDeclarationSemicolon(lines, index);
      if (declaration) {
        const rewrittenDeclaration = rewriteTraceContainerLocal(declaration.text, lineNumber, aliases, source);
        if (rewrittenDeclaration !== declaration.text) {
          output.push(`#line ${lineNumber} "${CPP_USER_SOURCE_FILE}"`);
          output.push(buildCurrentLineInstrumentation(lineNumber));
          output.push(rewrittenDeclaration);
          for (const variable of extractDeclaredSnapshotVariables(declaration.text, aliases, activeFrame.variables)) {
            activeFrame.variables.set(variable.name, {
              type: variable.type,
              scopeDepth: activeFrame.depth,
              declarationLine: lineNumber,
              sameLineVisible: Boolean(variable.sameLineVisible),
            });
          }
          if (shouldInstrumentCppLine(declaration.text)) {
            output.push(buildPostLineInstrumentation(lineNumber, activeSignature.name, activeFrame.variables, activeFrame.depth, '', includeSnapshotsForActiveFrame));
          }
          index = declaration.endIndex;
          continue;
        }
      }
      lineForDriver = rewriteTraceContainerLocal(line, lineNumber, aliases, source);
      const lineDelta = braceDeltaForLine(line);
      const declaredScopeDepth = activeFrame.depth + Math.max(0, lineDelta, /^\s*for\s*\(/.test(trimmedLine) ? 1 : 0);
      const postLineDepth = activeFrame.depth + Math.min(0, lineDelta);
      if (!insideLocalLambdaBody || activeSignature.lambda) {
        for (const variable of extractDeclaredSnapshotVariables(line, aliases, activeFrame.variables)) {
          activeFrame.variables.set(variable.name, {
            type: variable.type,
            scopeDepth: declaredScopeDepth,
            declarationLine: lineNumber,
            sameLineVisible: Boolean(variable.sameLineVisible),
          });
        }
      }
      if (/\b(?:destroy|cleanup|deleteTree|deleteList)\s*\(/i.test(trimmedLine)) {
        for (const [name, variable] of activeFrame.variables) {
          if (normalizeCppType(variable.type, aliases).includes('*')) activeFrame.variables.delete(name);
        }
      }
      const postLineInstrumentation = (shouldInstrumentLine || lineStartsElse)
        ? buildPostLineInstrumentation(lineNumber, activeSignature.name, activeFrame.variables, postLineDepth, '', includeSnapshotsForActiveFrame)
        : '';
      let postLineHandledInline = false;
      const allowReturnInstrumentation = !(insideLocalLambdaBody && !activeSignature.lambda);
      if (allowReturnInstrumentation) {
        let rewrittenControlLine = rewriteBracedSingleLineControlReturn(lineForDriver, lineNumber, activeSignature, postLineInstrumentation);
        postLineHandledInline ||= rewrittenControlLine !== lineForDriver;
        lineForDriver = rewrittenControlLine;
        rewrittenControlLine = rewriteSingleLineControlReturn(lineForDriver, lineNumber, activeSignature, postLineInstrumentation);
        postLineHandledInline ||= rewrittenControlLine !== lineForDriver;
        lineForDriver = rewrittenControlLine;
      }
      let rewrittenControlLine;
      rewrittenControlLine = rewriteBracedSingleLineControlBody(lineForDriver, lineNumber, postLineInstrumentation);
      postLineHandledInline ||= rewrittenControlLine !== lineForDriver;
      lineForDriver = rewrittenControlLine;
      rewrittenControlLine = rewriteSingleLineControlBody(
        lineForDriver,
        lineNumber,
        activeSignature.name,
        postLineInstrumentation,
        lineStartsElse || nextSourceLine.startsWith('else') || /^(?:for|while)\s*\(/.test(trimmedLine)
      );
      postLineHandledInline ||= rewrittenControlLine !== lineForDriver;
      lineForDriver = rewrittenControlLine;
      lineForDriver = rewriteControlTransferInstrumentation(lineForDriver, lineNumber, postLineInstrumentation);
      lineForDriver = rewriteFieldWriteInstrumentation(lineForDriver, lineNumber);
      if (allowReturnInstrumentation) {
        lineForDriver = rewriteReturnInstrumentation(lineForDriver, lineNumber, activeSignature, postLineInstrumentation);
      }
      lineForDriver = rewriteVectorElementMemberAccess(lineForDriver, activeFrame.variables, aliases, traceMemberNames);
      if (activeSignature.lambda) {
        lineForDriver = rewriteIndexReadInstrumentation(lineForDriver, activeFrame.variables, aliases, lineNumber);
      }
      const externalPostLineIsScopeSafe = /^\s*for\s*\([^;:]+:/.test(trimmedLine) && !trimmedLine.includes('{');
      if (postLineHandledInline && !externalPostLineIsScopeSafe) {
        lineForDriver = `${lineForDriver}\n#define __TC_POST_LINE_HANDLED_${lineNumber} 1`;
      }
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
      output.push(`#line ${lineNumber} "${CPP_USER_SOURCE_FILE}"`);
      output.push(buildLineInstrumentation(lineNumber, activeSignature.name));
      output.push(buildReturnInstrumentation(lineNumber, activeSignature));
    }

    output.push(`#line ${lineNumber} "${CPP_USER_SOURCE_FILE}"`);
    output.push(lineForDriver);
    if (
      shouldInstrumentLine &&
      !lineForDriver.includes(`__TC_POST_LINE_HANDLED_${lineNumber}`) &&
      !nextSourceLine.startsWith('else') &&
      !/^\s*(?:return|break|continue)\b/.test(trimmedLine)
    ) {
      const externalPostLineDepth = activeFrame.depth + Math.min(0, braceDeltaForLine(line));
      output.push(buildPostLineInstrumentation(lineNumber, activeSignature.name, activeFrame.variables, externalPostLineDepth, '', includeSnapshotsForActiveFrame));
    }
    if (lineForDriver.includes(`__TC_POST_LINE_HANDLED_${lineNumber}`)) {
      output[output.length - 1] = output[output.length - 1].replace(`\n#define __TC_POST_LINE_HANDLED_${lineNumber} 1`, '');
    }

    if (startsMultilineControlCondition) {
      multilineControlConditionDepth = lineParenDelta;
    } else if (multilineControlConditionDepth > 0) {
      multilineControlConditionDepth = Math.max(0, multilineControlConditionDepth + lineParenDelta);
    }
    if (startsMultilineStatement) {
      multilineStatementDepth = Math.max(0, lineParenDelta);
      multilineStatementContinuation = multilineStatementDepth === 0 && !/;\s*$/.test(strippedTrimmedLine);
    } else if (multilineStatementDepth > 0) {
      multilineStatementDepth = Math.max(0, multilineStatementDepth + lineParenDelta);
    } else if (multilineStatementContinuation) {
      multilineStatementContinuation = !/;\s*$/.test(strippedTrimmedLine);
    }
    if (startsLocalLambdaBody || localLambdaDepth > 0) {
      localLambdaDepth += braceDeltaForLine(line);
      if (localLambdaDepth < 0) localLambdaDepth = 0;
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
          (nextSignature.name !== functionName || nextSignature.line !== targetSignature.line) &&
          !nextSignature.skipInstrumentation
        ) {
          output.push(`#line ${lineNumber} "${CPP_USER_SOURCE_FILE}"`);
          output.push(buildCallInstrumentation(lineNumber, nextSignature));
        }
      } else if (pendingSignature?.lambda && lineNumber >= pendingSignature.line && delta <= 0) {
        pendingSignature = null;
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
      classStack.push({ name: classDecl[1], depth: classDelta, local: Boolean(activeFrame) });
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
  userCode = normalizeCppUserSource(userCode, options);
  const aliases = collectCppTypeAliases(userCode);
  const signature = parseMethodSignature(userCode, functionName, {
    parameterCount: Object.keys(inputs || {}).length,
    inputNames: Object.keys(inputs || {}),
  });
  const skipTraceParameterNames = new Set(
    signature.parameters
      .filter((parameter) => parameterAddressEscapes(userCode, parameter.name))
      .map((parameter) => parameter.name)
  );
  signature.skipTraceParameterNames = skipTraceParameterNames;
  const traced = options.tracing === true;
  const usesSolutionClass = options.executionStyle !== 'function' || sourceDeclaresSolutionClass(userCode);
  const sourceForDriver = options.tracing === true ? instrumentCppSourceForTracing(userCode, functionName) : userCode;
  const declarations = [];
  const argumentNames = [];
  let usesDynamicInputs = false;

  signature.parameters.forEach((parameter, index) => {
    const localName = `__tc_arg_${index}`;
    const shouldTraceParameter = traced &&
      !skipTraceParameterNames.has(parameter.name) &&
      isTraceWrappedCppType(parameter.type, aliases) &&
      !hasUnsafeMapProxyAutoReferenceBinding(parameter.type, userCode, parameter.name, aliases);
    const declarationType = shouldTraceParameter ? cppTraceType(parameter.type, aliases) : localCppType(parameter.type);
    const dynamicInput = cppDynamicInputExpression(parameter, index, aliases);
    const value = dynamicInput ?? toCppLiteral(inputValueForParameter(inputs, parameter, index), parameter.type, aliases);
    usesDynamicInputs ||= dynamicInput !== null;
    if (shouldTraceParameter) {
      declarations.push(`  ${declarationType} ${localName}(${materializedCppType(parameter.type, aliases)}(${value}), ${cppStringLiteral(parameter.name)}, ${signature.line});`);
    } else {
      declarations.push(`  ${declarationType} ${localName} = ${value};`);
    }
    argumentNames.push(localName);
  });

  const callEventPrefix = `{"kind":"call","line":${signature.line},"function":${jsonStringLiteral(functionName)},"args":`;
  const returnEventPrefix = `{"kind":"return","line":${signature.line},"function":${jsonStringLiteral(functionName)},"value":`;
  const returnsNull = isNullCppReturnType(signature.returnType, aliases);
  const returnsVoid = normalizeCppType(signature.returnType, aliases) === 'void';
  const noStoredResult = returnsVoid || returnsNull;
  const voidOutputParameter = returnsVoid && signature.parameters.length > 0 && isSnapshotSerializableCppType(signature.parameters[0].type, aliases)
    ? signature.parameters[0]
    : null;
  const traceSetup = traced ? `  ${configureTraceBudgetCall(options)}` : '';
  const traceCall = traced
    ? [
        `  std::string __tc_args_json = std::string("{") + ${buildTraceArgsJsonExpression(signature, (_parameter, index) => `__tc_arg_${index}`, aliases)} + "}";`,
        `  tracecode::write_trace_event_json(std::string(${cppStringLiteral(callEventPrefix)}) + __tc_args_json + "}", ${signature.line});`,
        `  tracecode::emit_line(${signature.line}, ${cppStringLiteral(functionName)});`,
      ].join('\n')
    : '';
  const traceReturn = traced
    ? noStoredResult
      ? returnsNull
        ? `  tracecode::write_trace_event_json(std::string(${cppStringLiteral(`${returnEventPrefix}null}`)}), ${signature.line});`
        : voidOutputParameter
        ? `  tracecode::write_trace_event_json(std::string(${cppStringLiteral(returnEventPrefix)}) + ${cppJsonExpressionForValue('__tc_arg_0', voidOutputParameter.type, userCode)} + "}", ${signature.line});`
        : `  tracecode::write_trace_event_json(std::string(${cppStringLiteral(`${returnEventPrefix}null}`)}), ${signature.line});`
      : `  tracecode::write_trace_event_json(std::string(${cppStringLiteral(returnEventPrefix)}) + ${cppJsonExpressionForValue('__tc_result', signature.returnType, userCode)} + "}", ${signature.line});`
    : '';
  const resultJsonExpression = noStoredResult
    ? returnsNull
      ? '"null"'
      : voidOutputParameter
      ? cppJsonExpressionForValue('__tc_arg_0', voidOutputParameter.type, userCode)
      : '"null"'
    : cppJsonExpressionForValue('__tc_result', signature.returnType, userCode);
  const callExpression = `${usesSolutionClass ? `solution.${functionName}` : functionName}(${argumentNames.join(', ')})`;
  const invokeAndStore = noStoredResult ? `  ${callExpression};` : `  auto __tc_result = ${callExpression};`;

return `${buildGeneratedIncludes(userCode, signature)}
using namespace std;
${buildTracecodeFallbackAliases(userCode)}

#line 1 "${CPP_USER_SOURCE_FILE}"
${sourceForDriver}

#line 1 "TraceCodeDriver.cpp"
int main() {
${usesSolutionClass ? '  Solution solution;' : ''}
${traceSetup}
${usesDynamicInputs ? '  tracecode::JsonValue __tc_inputs = tracecode::parse_json(tracecode::read_stdin_all());' : ''}
${declarations.join('\n')}
${traceCall}
${invokeAndStore}
${traceReturn}
  tracecode::write_result_json_raw(${resultJsonExpression});
  return 0;
}
`;
}

function scriptLineCount(source) {
  return String(source || '').split(/\r?\n/).length;
}

function buildScriptWrapperSource(userCode, options = {}) {
  userCode = normalizeCppUserSource(userCode, options);
  const userLineCount = scriptLineCount(userCode);
  return `auto ${CPP_SCRIPT_FUNCTION_NAME}() {
#line 1 "${CPP_USER_SOURCE_FILE}"
${userCode}
#line ${userLineCount + 1} "${CPP_USER_SOURCE_FILE}"
  return result;
}`;
}

function buildScriptDriverSource(userCode, options = {}) {
  userCode = normalizeCppUserSource(userCode, options);
  const userLineCount = scriptLineCount(userCode);
  const wrappedSource = buildScriptWrapperSource(userCode, options);
  const sourceForDriver = options.tracing === true
    ? instrumentCppSourceForTracing(wrappedSource, CPP_SCRIPT_FUNCTION_NAME)
    : wrappedSource;
  const traceCall = options.tracing === true
    ? [
        `  ${configureTraceBudgetCall(options)}`,
        `  tracecode::write_trace_event_json(std::string(${cppStringLiteral('{"kind":"call","line":1,"function":"<script>","args":{}}')}), 1);`,
      ].join('\n')
    : '';
  const traceReturn = options.tracing === true
    ? `  tracecode::write_trace_event_json(std::string(${cppStringLiteral('{"kind":"return","line":1,"function":"<script>","value":')}) + tracecode::to_json(__tc_result) + "}", 1);`
    : '';

return `${buildGeneratedIncludes(userCode, { parameters: [] })}
using namespace std;
${buildTracecodeFallbackAliases(userCode)}

#line 1 "${CPP_USER_SOURCE_FILE}"
${sourceForDriver}

#line 1 "TraceCodeDriver.cpp"
int main() {
${traceCall}
  auto __tc_result = ${CPP_SCRIPT_FUNCTION_NAME}();
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
  let traceStatus = null;
  let cursor = 0;

  while (cursor < stdout.length) {
    const resultIndex = stdout.indexOf(RESULT_MARKER, cursor);
    const traceIndex = options.tracing ? stdout.indexOf(TRACE_EVENT_MARKER, cursor) : -1;
    const statusIndex = stdout.indexOf(TRACE_STATUS_MARKER, cursor);
    const markerIndex = [resultIndex, traceIndex, statusIndex]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? -1;

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
    } else if (markerIndex === statusIndex) {
      const marker = splitMarkerLine(stdout, markerIndex, TRACE_STATUS_MARKER);
      traceStatus = marker.payload ? JSON.parse(marker.payload) : null;
      cursor = marker.nextIndex;
    } else {
      const marker = splitMarkerLine(stdout, markerIndex, TRACE_EVENT_MARKER);
      if (traceEvents && marker.payload) {
        try {
          traceEvents.push(JSON.parse(marker.payload));
        } catch (error) {
          throw new Error(`C++ trace event JSON parse failed: ${error instanceof Error ? error.message : String(error)}; payload=${marker.payload}`);
        }
      }
      cursor = marker.nextIndex;
    }
  }

  if (!foundResult && !options.allowMissingResult) {
    throw new Error('C++ program did not emit a TraceCode result.');
  }
  return { output, consoleOutput, events: traceEvents ?? [], traceStatus };
}

function normalizeScriptTraceEvents(events, userLineCount) {
  return events.flatMap((event) => {
    const normalized = { ...event };
    if (normalized.function === CPP_SCRIPT_FUNCTION_NAME) {
      normalized.function = '<script>';
    }
    if (typeof normalized.line === 'number') {
      if (normalized.line > 1) normalized.line -= 1;
      if (normalized.line > userLineCount) return [];
    }
    return [normalized];
  });
}

function cloneCppCallStack(stack) {
  return stack.map((frame) => ({ ...frame }));
}

function popCppCallStackFrame(stack, functionName) {
  if (stack.length === 0) return;
  if (!functionName || stack[stack.length - 1]?.function === functionName) {
    stack.pop();
    return;
  }
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]?.function === functionName) {
      stack.splice(index);
      return;
    }
  }
}

function enrichCppRuntimeTraceCallStacks(events) {
  const stack = [];
  return events.map((event) => {
    if (event?.kind === 'call') {
      const frame = {
        function: event.function || '<module>',
        ...(event.args !== undefined ? { args: event.args } : {}),
        ...(typeof event.line === 'number' ? { line: event.line } : {}),
      };
      stack.push(frame);
      return { ...event, callStack: cloneCppCallStack(stack) };
    }
    if (event?.kind === 'return') {
      const withStack = stack.length > 0 ? { ...event, callStack: cloneCppCallStack(stack) } : { ...event };
      popCppCallStackFrame(stack, event.function);
      return withStack;
    }
    return stack.length > 0 ? { ...event, callStack: cloneCppCallStack(stack) } : { ...event };
  });
}

function finalizeRuntimeTrace(events, options = {}) {
  const runId = options.runId || 'cpp:run';
  const file = options.file || CPP_USER_SOURCE_FILE;
  const maxEvents = Number.isFinite(options.maxStoredEvents)
    ? Number(options.maxStoredEvents)
    : Number.isFinite(options.maxTraceSteps)
      ? Number(options.maxTraceSteps)
      : DEFAULT_MAX_STORED_EVENTS;
  const normalizedEvents = enrichCppRuntimeTraceCallStacks(events).map((event) => ({
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
    droppedEventCount: traceLimitExceeded ? Math.max(0, normalizedEvents.length - storedEvents.length) : 0,
  };
}

function timeoutReasonForParsedTrace(parsed) {
  const statusReason = parsed?.traceStatus?.timeoutReason;
  if (typeof statusReason === 'string' && statusReason.length > 0) {
    return statusReason;
  }
  const timeoutEvent = Array.isArray(parsed?.events)
    ? parsed.events.find((event) => event?.kind === 'timeout' && typeof event.reason === 'string')
    : null;
  return timeoutEvent?.reason || 'trace-limit';
}

function isTraceTimeoutReason(value) {
  return (
    value === 'trace-limit' ||
    value === 'line-limit' ||
    value === 'single-line-limit' ||
    value === 'recursion-limit' ||
    value === 'memory-limit' ||
    value === 'client-timeout'
  );
}

function extractUserErrorLine(diagnostics) {
  const match = diagnostics.match(new RegExp(`${escapeRegExp(CPP_USER_SOURCE_FILE)}:(\\d+):\\d+:`));
  return match ? Number(match[1]) : undefined;
}

function extractDiagnosticLocation(diagnostics) {
  const match = diagnostics.match(new RegExp(`(?:^|\\n)(${escapeRegExp(CPP_USER_SOURCE_FILE)}|TraceCodeDriver\\.cpp):(\\d+):(\\d+):\\s*(fatal error|error|warning|note):\\s*([^\\n]+)`));
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
  const userLine = location?.file === CPP_USER_SOURCE_FILE ? location.line : extractUserErrorLine(cleanDiagnostics);
  const prefix =
    location?.file === 'TraceCodeDriver.cpp'
      ? 'C++ generated driver failed'
      : location?.file === CPP_USER_SOURCE_FILE
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
    executionTimeMs: elapsedMs(start),
    timings: {
      ...(details.timings && typeof details.timings === 'object' ? details.timings : {}),
      totalMs: elapsedMs(start),
    },
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

function rejectPendingCompilerWorkerRequests(error) {
  for (const [, request] of pendingCompilerWorkerRequests) {
    request.reject(error);
  }
  pendingCompilerWorkerRequests.clear();
}

function resetCompilerWorker(error = null) {
  if (compilerWorker) {
    compilerWorker.onmessage = null;
    compilerWorker.onerror = null;
    compilerWorker.onmessageerror = null;
    compilerWorker.terminate();
  }
  compilerWorker = null;
  if (error) rejectPendingCompilerWorkerRequests(error);
}

function getPersistentCompilerWorker() {
  const workerUrl = getCompilerWorkerUrl();
  if (!workerUrl) {
    throw new Error('Missing C++ compiler worker URL.');
  }
  if (compilerWorker) return compilerWorker;

  compilerWorker = new Worker(workerUrl, { type: 'module' });
  compilerWorker.onmessage = (event) => {
    const message = event.data || {};
    if (message.type === 'worker-ready') return;
    const request = pendingCompilerWorkerRequests.get(message.id);
    if (!request) return;
    pendingCompilerWorkerRequests.delete(message.id);
    if (message.type !== 'compile-result') {
      request.reject(new Error(`Unexpected C++ compiler worker response: ${message.type}`));
      return;
    }
    request.resolve(message.payload || {});
  };
  compilerWorker.onerror = (event) => {
    resetCompilerWorker(new Error(event.message || 'C++ compiler worker error'));
  };
  compilerWorker.onmessageerror = () => {
    resetCompilerWorker(new Error('C++ compiler worker message failed to deserialize'));
  };
  return compilerWorker;
}

function runCompilerWorker(driverSource) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = getPersistentCompilerWorker();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const id = `compile-${++compilerWorkerRequestId}`;
    pendingCompilerWorkerRequests.set(id, { resolve, reject });
    worker.postMessage({
      id,
      type: 'compile',
      payload: {
        assets: configuredAssets,
        driverSource,
        standard: CPP_STANDARD,
        stackSize: CPP_PROGRAM_STACK_SIZE,
      },
    });
  });
}

function runCompilerWorkerPayload(payload) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = getPersistentCompilerWorker();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const id = `compile-${++compilerWorkerRequestId}`;
    pendingCompilerWorkerRequests.set(id, { resolve, reject });
    worker.postMessage({
      id,
      type: 'compile',
      payload,
    });
  });
}

function requestExternalCompile(driverSource) {
  const requestId = String(++externalCompileRequestId);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingExternalCompiles.delete(requestId);
      reject(new Error('C++ external compiler request timed out.'));
    }, 120_000);

    pendingExternalCompiles.set(requestId, { resolve, reject, timeoutId });
    postMessage({
      type: 'compile-request',
      requestId,
      payload: {
        assets: configuredAssets,
        driverSource,
        standard: CPP_STANDARD,
        stackSize: CPP_PROGRAM_STACK_SIZE,
      },
    });
  });
}

function requestExternalCompilePayload(payload) {
  const requestId = String(++externalCompileRequestId);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingExternalCompiles.delete(requestId);
      reject(new Error('C++ external compiler request timed out.'));
    }, 120_000);

    pendingExternalCompiles.set(requestId, { resolve, reject, timeoutId });
    postMessage({
      type: 'compile-request',
      requestId,
      payload,
    });
  });
}

function compileDriverOutsideMainWorker(driverSource) {
  if (canUseExternalCompilerHost()) {
    return requestExternalCompile(driverSource);
  }
  return runCompilerWorker(driverSource);
}

function compileProjectOutsideMainWorker(request) {
  const payload = {
    assets: configuredAssets,
    project: request.project,
    cwd: requestCwdRelative(request),
    args: projectCompileArgs(request),
    compilerCommand: projectCompilerCommand(request),
    stdin: request?.stdin || '',
    includePaths: projectCompileIncludePaths(request),
    workspaceOutputPath: projectCompileWorkspaceOutputPath(request),
    standard: CPP_STANDARD,
    stackSize: CPP_PROGRAM_STACK_SIZE,
  };
  if (canUseExternalCompilerHost()) {
    return requestExternalCompilePayload(payload);
  }
  return runCompilerWorkerPayload(payload);
}

function projectCompilerCommand(request) {
  const command = String(request?.options?.compilerCommand || 'clang++');
  return command === 'clang' || command === 'gcc' || command === 'cc' ? 'clang' : 'clang++';
}

function projectPathBytes(file) {
  return file?.encoding === 'base64'
    ? decodeBase64(String(file.contents || ''))
    : encodeUtf8(String(file?.contents || ''));
}

function projectKernelDevices(project) {
  const entries = Array.isArray(project?.kernelDevices) ? project.kernelDevices : [];
  const devices = new Map();
  for (const entry of entries) {
    const path = normalizePath(entry?.path || '');
    if (!path.startsWith('/dev/')) continue;
    devices.set(path, {
      path,
      readable: entry?.readable === true,
      writable: entry?.writable === true,
      inputDevice: typeof entry?.inputDevice === 'string' ? normalizePath(entry.inputDevice) : '',
      outputDevice: typeof entry?.outputDevice === 'string' ? normalizePath(entry.outputDevice) : '',
    });
  }
  return devices;
}

function standaloneKernelDevices() {
  return new Map([
    ['/dev/stdin', { path: '/dev/stdin', readable: true, writable: false, inputDevice: '/dev/stdin', outputDevice: '' }],
    ['/dev/stdout', { path: '/dev/stdout', readable: false, writable: true, inputDevice: '', outputDevice: '/dev/stdout' }],
    ['/dev/stderr', { path: '/dev/stderr', readable: false, writable: true, inputDevice: '', outputDevice: '/dev/stderr' }],
    ['/dev/tty', { path: '/dev/tty', readable: true, writable: true, inputDevice: '/dev/stdin', outputDevice: '/dev/stdout' }],
  ]);
}

function wasiKernelDevices(options) {
  return options.kernelDevices instanceof Map ? options.kernelDevices : standaloneKernelDevices();
}

function projectKernelVirtualFiles(project) {
  const files = Array.isArray(project?.kernelFiles) ? project.kernelFiles : [];
  return files
    .filter((file) => {
      if (!file || typeof file.path !== 'string') return false;
      const path = normalizePath(file.path);
      return path.startsWith('/') && !isRuntimeDeviceNamespacePath(path);
    })
    .map((file) => ({
      path: normalizePath(file.path),
      contents: projectPathBytes(file),
    }));
}

function projectFromContext(context) {
  return context?.project && typeof context.project === 'object' ? context.project : context;
}

function normalizeProjectRoot(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!raw || !raw.startsWith('/')) return '';
  return raw || '/';
}

function projectWorkspaceRoots(context) {
  const project = projectFromContext(context) || {};
  const roots = [];
  for (const value of [project.workspaceRoot, project.cwd, project.workspaceAlias, '/workspace']) {
    const root = normalizeProjectRoot(value);
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

function stripProjectWorkspaceRoot(context, pathname) {
  const raw = String(pathname || '').replace(/\\/g, '/');
  for (const root of projectWorkspaceRoots(context)) {
    if (raw === root) return '';
    if (root !== '/' && raw.startsWith(`${root}/`)) return raw.slice(root.length + 1);
  }
  return null;
}

function relativeProjectPath(pathname, context) {
  const raw = String(pathname || '').replace(/\\/g, '/');
  const stripped = stripProjectWorkspaceRoot(context, raw);
  const withoutWorkspace = stripped === null ? raw.replace(/^\/+/, '') : stripped;
  const parts = [];
  for (const part of withoutWorkspace.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error(`Project path escapes workspace: ${pathname}`);
    parts.push(part);
  }
  return parts.join('/');
}

function relativeProjectOperandPath(pathname, context) {
  const raw = String(pathname || '').replace(/\\/g, '/');
  const stripped = stripProjectWorkspaceRoot(context, raw);
  const withoutWorkspace = stripped === null ? raw.replace(/^\/+/, '') : stripped;
  const parts = [];
  for (const part of withoutWorkspace.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) throw new Error(`Project path escapes workspace: ${pathname}`);
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function requestCwdRelative(request) {
  const defaultRoot = projectWorkspaceRoots(request)[0] || '/workspace';
  const cwd = String(request?.cwd || defaultRoot).replace(/\\/g, '/');
  if (!cwd.startsWith('/')) return relativeProjectOperandPath(cwd, request);
  const stripped = stripProjectWorkspaceRoot(request, cwd);
  if (stripped !== null) {
    return relativeProjectPath(stripped, request);
  }
  throw new Error(`Project cwd must stay inside the workspace: ${cwd}`);
}

function resolveProjectRequestPath(request, value, fallback = '') {
  const text = String(value || fallback);
  if (!text || text === '<compile>' || text === '<project>') return fallback;
  if (text.startsWith('/')) {
    const stripped = stripProjectWorkspaceRoot(request, text);
    if (stripped === null) throw new Error(`Project path escapes workspace: ${text}`);
    return relativeProjectPath(stripped, request);
  }
  const cwd = requestCwdRelative(request);
  return relativeProjectOperandPath(cwd ? `${cwd}/${text}` : text, request);
}

function projectPathRelativeToWorkspace(request, value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.startsWith('/')) {
    const stripped = stripProjectWorkspaceRoot(request, text);
    if (stripped === null) throw new Error(`Project path escapes workspace: ${text}`);
    return relativeProjectPath(stripped, request);
  }
  const cwd = requestCwdRelative(request);
  return relativeProjectOperandPath(cwd ? `${cwd}/${text}` : text, request);
}

function projectCompilerPathArg(request, value) {
  const text = String(value || '');
  const path = projectPathRelativeToWorkspace(request, text);
  const cwd = requestCwdRelative(request);
  if (cwd && (path === cwd || path.startsWith(`${cwd}/`))) {
    return path === cwd ? '.' : path.slice(cwd.length + 1);
  }
  return path;
}

function projectCompilerIncludePathArg(request, value) {
  const text = String(value || '');
  if (!text) return text;
  projectPathRelativeToWorkspace(request, text);
  return '.';
}

function projectCompilerLibraryPathArg(request, value) {
  const text = String(value || '');
  if (!text) return text;
  projectPathRelativeToWorkspace(request, text);
  return '.';
}

function projectCompilerSourcePathArg(request, value) {
  const text = String(value || '');
  if (text && !text.startsWith('/')) {
    projectPathRelativeToWorkspace(request, text);
    if (text.includes('../')) return basename(text);
    return text;
  }
  return projectCompilerPathArg(request, text);
}

function projectCompilerOutputPathArg(request, value) {
  const mapped = projectCompilerPathArg(request, value);
  const index = mapped.lastIndexOf('/');
  return index >= 0 ? mapped.slice(index + 1) || 'a.out' : mapped || 'a.out';
}

function projectCompilerLinkerArtifactPathArg(request, value) {
  const mapped = projectCompilerPathArg(request, value);
  const index = mapped.lastIndexOf('/');
  return index >= 0 ? mapped.slice(index + 1) || mapped : mapped;
}

function projectEnvPathList(request, name) {
  const raw = request?.env && typeof request.env[name] === 'string' ? request.env[name] : '';
  return raw
    .split(/[:;]/)
    .map((path) => path.trim())
    .filter(Boolean);
}

function projectCompileEnvIncludePaths(request) {
  const paths = [
    ...projectEnvPathList(request, 'CPATH'),
  ];
  if (projectCompilerCommand(request) === 'clang') {
    paths.push(...projectEnvPathList(request, 'C_INCLUDE_PATH'));
  } else {
    paths.push(...projectEnvPathList(request, 'CPLUS_INCLUDE_PATH'));
  }
  return paths;
}

function projectCompileEnvLibraryPaths(request) {
  return projectEnvPathList(request, 'LIBRARY_PATH');
}

function projectCompileIncludePaths(request) {
  const args = Array.isArray(request?.args) && request.args.length > 0
    ? request.args.map(String)
    : [request?.scriptPath || 'main.cpp'];
  const includePaths = projectCompileEnvIncludePaths(request).map((path) => resolveProjectRequestPath(request, path, path));
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-I' || arg === '-isystem') {
      const value = args[index + 1];
      if (typeof value === 'string') {
        includePaths.push(resolveProjectRequestPath(request, value, value));
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('-I') && arg.length > 2 && !arg.startsWith('-include')) {
      includePaths.push(resolveProjectRequestPath(request, arg.slice(2), arg.slice(2)));
      continue;
    }
    if (arg.startsWith('-isystem') && arg.length > '-isystem'.length) {
      includePaths.push(resolveProjectRequestPath(request, arg.slice('-isystem'.length), arg.slice('-isystem'.length)));
    }
  }
  return [...new Set(includePaths.filter(Boolean))];
}

function projectCompileWorkspaceOutputPath(request) {
  const args = Array.isArray(request?.args) && request.args.length > 0
    ? request.args.map(String)
    : [request?.scriptPath || 'main.cpp'];
  const outputIndex = args.indexOf('-o');
  const cwd = requestCwdRelative(request);
  if (outputIndex < 0) {
    const inlineOutputArg = args.find((arg) => arg.startsWith('-o') && arg.length > 2);
    if (inlineOutputArg) {
      const inlineValue = inlineOutputArg.slice(2);
      if (inlineValue.startsWith('/')) {
        const stripped = stripProjectWorkspaceRoot(request, inlineValue);
        if (stripped === null) throw new Error(`Project path escapes workspace: ${inlineValue}`);
        return relativeProjectPath(stripped, request);
      }
      return relativeProjectOperandPath(cwd ? `${cwd}/${inlineValue}` : inlineValue, request);
    }
    return relativeProjectOperandPath(cwd ? `${cwd}/a.out` : 'a.out', request);
  }
  const value = args[outputIndex + 1] || 'a.out';
  if (value.startsWith('/')) {
    const stripped = stripProjectWorkspaceRoot(request, value);
    if (stripped === null) throw new Error(`Project path escapes workspace: ${value}`);
    return relativeProjectPath(stripped, request);
  }
  return relativeProjectOperandPath(cwd ? `${cwd}/${value}` : value, request);
}

function projectCompileArgs(request) {
  const args = Array.isArray(request?.args) && request.args.length > 0
    ? request.args.map(String)
    : [request?.scriptPath || 'main.cpp'];
  const cwd = requestCwdRelative(request);
  const mapped = [];
  for (const path of projectCompileEnvIncludePaths(request)) {
    mapped.push('-I', projectCompilerIncludePathArg(request, path));
  }
  for (const path of projectCompileEnvLibraryPaths(request)) {
    mapped.push('-L', projectCompilerLibraryPathArg(request, path));
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-o') {
      mapped.push(arg);
      const value = args[index + 1];
      if (typeof value === 'string') {
        mapped.push(projectCompilerOutputPathArg(request, value));
        index += 1;
      }
      continue;
    }
    if (arg === '-I' || arg === '-isystem') {
      mapped.push(arg);
      const value = args[index + 1];
      if (typeof value === 'string') {
        mapped.push(projectCompilerIncludePathArg(request, value));
        index += 1;
      }
      continue;
    }
    if (arg === '-L') {
      mapped.push(arg);
      const value = args[index + 1];
      if (typeof value === 'string') {
        mapped.push(projectCompilerLibraryPathArg(request, value));
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('-I') && arg.length > 2 && !arg.startsWith('-include')) {
      mapped.push('-I.');
      projectPathRelativeToWorkspace(request, arg.slice(2));
      continue;
    }
    if (arg.startsWith('-L') && arg.length > 2) {
      mapped.push('-L.');
      projectPathRelativeToWorkspace(request, arg.slice(2));
      continue;
    }
    if (arg.startsWith('-isystem') && arg.length > '-isystem'.length) {
      mapped.push('-isystem.');
      projectPathRelativeToWorkspace(request, arg.slice('-isystem'.length));
      continue;
    }
    if (arg.startsWith('-o') && arg.length > 2) {
      mapped.push('-o', projectCompilerOutputPathArg(request, arg.slice(2)));
      continue;
    }
    if (/^(?:[^-].*\.(?:c|cc|cpp|cxx|h|hpp|hh))$/i.test(arg)) {
      mapped.push(projectCompilerSourcePathArg(request, arg));
      continue;
    }
    if (/^\/.*\.(?:a|lib|o|obj)$/i.test(arg) && stripProjectWorkspaceRoot(request, arg) !== null) {
      mapped.push(projectCompilerLinkerArtifactPathArg(request, arg));
      continue;
    }
    mapped.push(arg);
  }
  if (!mapped.includes('-o')) {
    mapped.push('-o', relativeProjectOperandPath(cwd ? `${cwd}/a.out` : 'a.out'));
  }
  return mapped;
}

function createProjectRuntimeFs(project) {
  const fs = new InMemoryFileSystem();
  for (const directory of project?.directories || []) {
    const path = relativeProjectPath(directory, project);
    if (path) fs.addDirectory(`/${path}`);
  }
  for (const file of project?.files || []) {
    const path = relativeProjectPath(file.path, project);
    if (path) fs.addFile(`/${path}`, projectPathBytes(file));
  }
  for (const file of projectKernelVirtualFiles(project)) {
    fs.addReadOnlyFile(file.path, file.contents);
  }
  return fs;
}

function snapshotProjectFs(fs) {
  const snapshot = new Map();
  for (const [path, bytes] of fs.files.entries()) {
    if (isRuntimeProcPath(path)) continue;
    const relativePath = relativeProjectPath(path);
    if (relativePath) snapshot.set(relativePath, cloneBytes(bytes));
  }
  return snapshot;
}

function encodeProjectFileChange(path, bytes) {
  const text = decodeUtf8(bytes);
  if (arraysEqual(encodeUtf8(text), bytes)) {
    return { path, contents: text };
  }
  return { path, contents: encodeBase64(bytes), encoding: 'base64' };
}

function arraysEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function diffProjectFs(before, fs) {
  const after = snapshotProjectFs(fs);
  const changes = [];
  for (const [path, bytes] of [...after.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const oldBytes = before.get(path);
    before.delete(path);
    if (oldBytes && arraysEqual(oldBytes, bytes)) continue;
    changes.push(encodeProjectFileChange(path, bytes));
  }
  for (const path of [...before.keys()].sort()) {
    changes.push({ path, deleted: true });
  }
  return changes;
}

function createProjectEventBridge(messageId) {
  return {
    output(stream, data, device) {
      if (!data) return;
      const outputDevice = stream === 'stderr' ? '/dev/stderr' : '/dev/stdout';
      postProjectEvent(messageId, {
        type: 'output',
        stream,
        device: outputDevice,
        ...(device && device !== outputDevice ? { sourceDevice: device } : {}),
        data,
      });
    },
    fileChange(change) {
      postProjectEvent(messageId, { type: 'file-change', phase: 'live', change });
    },
  };
}

function emitProjectResultOutputEvents(events, result) {
  if (!events || !result) return;
  if (typeof result.stdout === 'string' && result.stdout.length > 0) {
    events.output('stdout', result.stdout);
  }
  if (typeof result.stderr === 'string' && result.stderr.length > 0) {
    events.output('stderr', result.stderr);
  }
}

async function handleProjectCpp(request, messageId) {
  const events = createProjectEventBridge(messageId);
  if (request?.source === 'compile') {
    const startedAt = now();
    const compileResult = await compileProjectOutsideMainWorker(request);
    if (!compileResult.success) {
      const stderr = [compileResult.stderr, compileResult.error].filter(Boolean).join('\n').trim();
      const failureResult = {
        stdout: compileResult.stdout || '',
        stderr: stderr ? `${stderr}\n` : 'C++ compilation failed.\n',
        exitCode: 1,
      };
      emitProjectResultOutputEvents(events, failureResult);
      return failureResult;
    }
    const outputPath = relativeProjectPath(compileResult.outputPath || 'a.out', request) || 'a.out';
    const programBytes = new Uint8Array(compileResult.programBuffer);
    const result = {
      stdout: compileResult.stdout || '',
      stderr: compileResult.stderr || '',
      exitCode: 0,
      files: [encodeProjectFileChange(outputPath, programBytes)],
      timings: {
        compileMs: compileResult.compileMs,
        totalMs: elapsedMs(startedAt),
      },
    };
    emitProjectResultOutputEvents(events, result);
    return result;
  }

  const fs = createProjectRuntimeFs(request?.project);
  const before = snapshotProjectFs(fs);
  fs.setFileChangeObserver((change) => {
    const relativePath = relativeProjectPath(change.path, request?.project);
    if (!relativePath) return;
    events.fileChange(change.directory
      ? { path: relativePath, directory: true, ...(change.deleted ? { deleted: true } : {}) }
      : change.deleted
      ? { path: relativePath, deleted: true }
      : encodeProjectFileChange(relativePath, change.bytes));
  });
  const executablePath = `/${resolveProjectRequestPath(request, request?.scriptPath || './a.out', 'a.out')}`;
  if (!fs.isFile(executablePath)) {
    return {
      stdout: '',
      stderr: `${request?.scriptPath || './a.out'}: executable not found\n`,
      exitCode: 127,
    };
  }
  const startedAt = now();
  const module = await WebAssembly.compile(fs.readFile(executablePath));
  const program = await runWasi(module, [basename(executablePath), ...(request?.args || []).map(String)], fs, {
    cwd: `/${requestCwdRelative(request)}`,
    stdin: request?.stdin || '',
    env: request?.env || { USER: 'tracecode' },
    kernelDevices: projectKernelDevices(request?.project),
    onOutput: (stream, data, device) => events.output(stream, data, device),
  });
  return {
    stdout: program.stdout,
    stderr: program.stderr,
    exitCode: program.exitCode,
    files: diffProjectFs(before, fs),
    timings: {
      runMs: elapsedMs(startedAt),
      totalMs: elapsedMs(startedAt),
    },
  };
}

async function compileAndRun(source, functionName, inputs, options = {}) {
  const start = now();
  if (canUseEphemeralCompilerWorker()) {
    try {
      return await compileAndRunWithExternalCompiler(source, functionName, inputs, start, {
        ...options,
        timings: {
          ...(options.timings && typeof options.timings === 'object' ? options.timings : {}),
          toolchainLoadMs: 0,
        },
      });
    } catch {
      // Fall through to the in-worker compiler path when nested workers are not
      // available or an older deployment is missing the compiler worker asset.
    }
  }

  const toolchainStartedAt = now();
  const toolchain = await loadToolchain();
  const timings = {
    ...(options.timings && typeof options.timings === 'object' ? options.timings : {}),
    toolchainLoadMs: elapsedMs(toolchainStartedAt),
  };
  if (toolchain.compiler === 'yowasp') {
    return compileAndRunWithYowasp(toolchain, source, functionName, inputs, start, {
      ...options,
      timings,
    });
  }
  const fs = toolchain.baseFs.clone();
  const resourceDir = findClangResourceDir(fs);
  const scriptRequest = isScriptExecutionRequest(functionName, options);
  const signature = scriptRequest
    ? { line: 1 }
    : options.executionStyle === 'ops-class'
    ? { line: 1 }
    : parseMethodSignature(source, functionName, {
        parameterCount: Object.keys(inputs || {}).length,
        inputNames: Object.keys(inputs || {}),
      });
  const driverStartedAt = now();
  const driverSource = scriptRequest
    ? buildScriptDriverSource(source, options)
    : options.executionStyle === 'ops-class'
    ? buildOpsClassDriverSource(source, functionName, inputs || {}, options)
    : buildDriverSource(source, functionName, inputs || {}, options);
  timings.driverBuildMs = elapsedMs(driverStartedAt);

  fs.addDirectory('/tmp');
  fs.addFile('/tmp/TraceCodeDriver.cpp', driverSource);

  const cacheKey = getProgramCacheKey(toolchain.compiler, driverSource);
  let programModule = getCachedProgramModule(cacheKey);
  if (programModule) {
    timings.compileCacheHit = true;
    timings.compileMs = 0;
    timings.linkMs = 0;
    timings.wasmCompileMs = 0;
  } else {
    timings.compileCacheHit = false;
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
      const compileStartedAt = now();
      await runTool(toolchain.clangModule, fs, clangArgs);
      timings.compileMs = elapsedMs(compileStartedAt);
    } catch (error) {
      const diagnostics = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n').trim();
      return compileFailureResult(diagnostics, 'C++ compilation failed.', start, {
        generatedSource: options?.traceOptions?.includeGeneratedSource ? driverSource : undefined,
        diagnosticStage: options.tracing ? 'trace-driver-compile' : 'driver-compile',
        timings,
      });
    }

    const libDir = fs.isDirectory('/lib/wasm32-wasi') ? '/lib/wasm32-wasi' : '/lib';
    const crt1 = fs.isFile(`${libDir}/crt1.o`) ? `${libDir}/crt1.o` : '/lib/wasm32-wasi/crt1.o';
    const lldArgs = [
      'wasm-ld',
      '--no-threads',
      '--export-dynamic',
      '-z',
      `stack-size=${CPP_PROGRAM_STACK_SIZE}`,
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
      const linkStartedAt = now();
      await runTool(toolchain.lldModule, fs, lldArgs);
      timings.linkMs = elapsedMs(linkStartedAt);
    } catch (error) {
      const diagnostics = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n').trim();
      return compileFailureResult(diagnostics, 'C++ linking failed.', start, {
        generatedSource: options?.traceOptions?.includeGeneratedSource ? driverSource : undefined,
        diagnosticStage: 'driver-link',
        timings,
      });
    }

    const wasmCompileStartedAt = now();
    programModule = await WebAssembly.compile(fs.readFile('/tmp/program.wasm'));
    timings.wasmCompileMs = elapsedMs(wasmCompileStartedAt);
    storeProgramModule(cacheKey, programModule);
  }

  try {
    const runStartedAt = now();
    const program = await runWasi(programModule, ['program.wasm'], fs, {
      stdin: JSON.stringify(inputs || {}),
    });
    timings.runMs = elapsedMs(runStartedAt);
    const parsed = parseProgramStdout(program.stdout, {
      tracing: options.tracing,
      defaultLine: signature.line,
      allowMissingResult: options.tracing,
    });
    if (scriptRequest && options.tracing) {
      parsed.events = normalizeScriptTraceEvents(parsed.events, scriptLineCount(source));
    }
    const programTimedOut = options.tracing && program.exitCode === 124;
    const runtimeTimedOut = !options.tracing && program.exitCode === 124;
    const baseResult = {
      success: program.exitCode === 0 && !programTimedOut,
      output: parsed.output,
      error: program.exitCode === 0 ? undefined : program.stderr || `C++ program exited with code ${program.exitCode}`,
      consoleOutput: [...parsed.consoleOutput, ...program.stderr.split(/\r?\n/).filter(Boolean)],
      executionTimeMs: elapsedMs(start),
      timings: { ...timings, totalMs: elapsedMs(start) },
      ...(runtimeTimedOut ? { timeoutReason: 'client-timeout', diagnosticStage: 'runtime' } : {}),
    };
    if (!options.tracing) return baseResult;
    const finalizedTrace = finalizeRuntimeTrace(parsed.events, options.traceOptions || {});
    const { trace } = finalizedTrace;
    const runtimeTraceLimitExceeded = finalizedTrace.traceLimitExceeded || Boolean(parsed.traceStatus?.traceLimitExceeded) || programTimedOut;
    const droppedEventCount = (finalizedTrace.droppedEventCount || 0) + (Number(parsed.traceStatus?.droppedEventCount) || 0);
    const timeoutReason = timeoutReasonForParsedTrace(parsed);
    return {
      ...baseResult,
      ...(programTimedOut ? { error: 'C++ trace budget exceeded.' } : {}),
      trace,
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
      traceLimitExceeded: runtimeTraceLimitExceeded,
      ...(runtimeTraceLimitExceeded ? { timeoutReason } : {}),
      ...(runtimeTraceLimitExceeded ? { droppedEventCount } : {}),
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
        executionTimeMs: elapsedMs(start),
        lineEventCount: trace.lineEventCount,
        traceStepCount: trace.traceStepCount,
        timings: { ...timings, totalMs: elapsedMs(start) },
      };
    }
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      consoleOutput: [],
      executionTimeMs: elapsedMs(start),
      timings: { ...timings, totalMs: elapsedMs(start) },
    };
  }
}

async function compileAndRunWithExternalCompiler(source, functionName, inputs, start, options = {}) {
  const timings = {
    ...(options.timings && typeof options.timings === 'object' ? options.timings : {}),
  };
  const scriptRequest = isScriptExecutionRequest(functionName, options);
  const signature = scriptRequest
    ? { line: 1 }
    : options.executionStyle === 'ops-class'
    ? { line: 1 }
    : parseMethodSignature(source, functionName, {
        parameterCount: Object.keys(inputs || {}).length,
        inputNames: Object.keys(inputs || {}),
      });
  const driverStartedAt = now();
  const rawDriverSource = scriptRequest
    ? buildScriptDriverSource(source, options)
    : options.executionStyle === 'ops-class'
    ? buildOpsClassDriverSource(source, functionName, inputs || {}, options)
    : buildDriverSource(source, functionName, inputs || {}, options);
  const driverSource = rawDriverSource.replace(
    '#include "/tracecode_runtime.hpp"',
    '#include "tracecode_runtime.hpp"'
  );
  timings.driverBuildMs = elapsedMs(driverStartedAt);

  const cacheKey = getProgramCacheKey('yowasp-worker', driverSource);
  let programModule = getCachedProgramModule(cacheKey);
  if (programModule) {
    timings.compileCacheHit = true;
    timings.compileMs = 0;
    timings.compilerWorkerMs = 0;
    timings.wasmCompileMs = 0;
  } else {
    timings.compileCacheHit = false;
    const compilerStartedAt = now();
    const compileResult = await compileDriverOutsideMainWorker(driverSource);
    timings.externalCompileMs = elapsedMs(compilerStartedAt);
    timings.compilerWorkerMs = timings.externalCompileMs;
    timings.compileMs = Number.isFinite(Number(compileResult.compileMs))
      ? Number(compileResult.compileMs)
      : timings.compilerWorkerMs;

    if (!compileResult.success) {
      const diagnostics = [compileResult.stderr, compileResult.stdout, compileResult.error]
        .filter(Boolean)
        .join('\n')
        .trim();
      return compileFailureResult(diagnostics, 'C++ compilation failed.', start, {
        generatedSource: options?.traceOptions?.includeGeneratedSource ? driverSource : undefined,
        diagnosticStage: options.tracing ? 'trace-driver-compile' : 'driver-compile',
        timings,
      });
    }

    if (!(compileResult.programBuffer instanceof ArrayBuffer)) {
      return {
        success: false,
        output: null,
        error: 'C++ compiler worker did not return program.wasm.',
        consoleOutput: [],
        executionTimeMs: elapsedMs(start),
        timings: { ...timings, totalMs: elapsedMs(start) },
      };
    }

    const wasmCompileStartedAt = now();
    programModule = await WebAssembly.compile(new Uint8Array(compileResult.programBuffer));
    timings.wasmCompileMs = elapsedMs(wasmCompileStartedAt);
    storeProgramModule(cacheKey, programModule);
  }

  try {
    const runStartedAt = now();
    const program = await runWasi(programModule, ['program.wasm'], new InMemoryFileSystem(), {
      stdin: JSON.stringify(inputs || {}),
    });
    timings.runMs = elapsedMs(runStartedAt);
    const parsed = parseProgramStdout(program.stdout, {
      tracing: options.tracing,
      defaultLine: signature.line,
      allowMissingResult: options.tracing,
    });
    if (scriptRequest && options.tracing) {
      parsed.events = normalizeScriptTraceEvents(parsed.events, scriptLineCount(source));
    }
    const programTimedOut = options.tracing && program.exitCode === 124;
    const runtimeTimedOut = !options.tracing && program.exitCode === 124;
    const baseResult = {
      success: program.exitCode === 0 && !programTimedOut,
      output: parsed.output,
      error: program.exitCode === 0 ? undefined : program.stderr || `C++ program exited with code ${program.exitCode}`,
      consoleOutput: [...parsed.consoleOutput, ...program.stderr.split(/\r?\n/).filter(Boolean)],
      executionTimeMs: elapsedMs(start),
      timings: { ...timings, totalMs: elapsedMs(start) },
      ...(runtimeTimedOut ? { timeoutReason: 'client-timeout', diagnosticStage: 'runtime' } : {}),
    };
    if (!options.tracing) return baseResult;
    const finalizedTrace = finalizeRuntimeTrace(parsed.events, options.traceOptions || {});
    const { trace } = finalizedTrace;
    const runtimeTraceLimitExceeded = finalizedTrace.traceLimitExceeded || Boolean(parsed.traceStatus?.traceLimitExceeded) || programTimedOut;
    const droppedEventCount = (finalizedTrace.droppedEventCount || 0) + (Number(parsed.traceStatus?.droppedEventCount) || 0);
    const timeoutReason = timeoutReasonForParsedTrace(parsed);
    return {
      ...baseResult,
      ...(programTimedOut ? { error: 'C++ trace budget exceeded.' } : {}),
      trace,
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
      traceLimitExceeded: runtimeTraceLimitExceeded,
      ...(runtimeTraceLimitExceeded ? { timeoutReason } : {}),
      ...(runtimeTraceLimitExceeded ? { droppedEventCount } : {}),
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
        executionTimeMs: elapsedMs(start),
        lineEventCount: trace.lineEventCount,
        traceStepCount: trace.traceStepCount,
        timings: { ...timings, totalMs: elapsedMs(start) },
      };
    }
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      consoleOutput: [],
      executionTimeMs: elapsedMs(start),
      timings: { ...timings, totalMs: elapsedMs(start) },
    };
  }
}

async function compileAndRunWithYowasp(toolchain, source, functionName, inputs, start, options = {}) {
  const timings = {
    ...(options.timings && typeof options.timings === 'object' ? options.timings : {}),
  };
  const scriptRequest = isScriptExecutionRequest(functionName, options);
  const signature = scriptRequest
    ? { line: 1 }
    : options.executionStyle === 'ops-class'
    ? { line: 1 }
    : parseMethodSignature(source, functionName, {
        parameterCount: Object.keys(inputs || {}).length,
        inputNames: Object.keys(inputs || {}),
      });
  const driverStartedAt = now();
  const rawDriverSource = scriptRequest
    ? buildScriptDriverSource(source, options)
    : options.executionStyle === 'ops-class'
    ? buildOpsClassDriverSource(source, functionName, inputs || {}, options)
    : buildDriverSource(source, functionName, inputs || {}, options);
  const driverSource = rawDriverSource.replace(
    '#include "/tracecode_runtime.hpp"',
    '#include "tracecode_runtime.hpp"'
  );
  timings.driverBuildMs = elapsedMs(driverStartedAt);
  const stdoutChunks = [];
  const stderrChunks = [];
  const collect = (chunks) => (bytes) => {
    if (bytes) chunks.push(bytes);
  };

  const cacheKey = getProgramCacheKey(toolchain.compiler, driverSource);
  let programModule = getCachedProgramModule(cacheKey);
  if (programModule) {
    timings.compileCacheHit = true;
    timings.compileMs = 0;
    timings.wasmCompileMs = 0;
  } else {
    timings.compileCacheHit = false;
    let files;
    try {
      const compileStartedAt = now();
      files = await toolchain.runClang(
        ['clang++', 'TraceCodeDriver.cpp', `-std=${CPP_STANDARD}`, '-O0', '-fno-exceptions', `-Wl,-z,stack-size=${CPP_PROGRAM_STACK_SIZE}`, '-o', 'program.wasm'],
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
      timings.compileMs = elapsedMs(compileStartedAt);
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
        timings,
      });
    }

    const programBytes = files?.['program.wasm'];
    if (!(programBytes instanceof Uint8Array)) {
      return {
        success: false,
        output: null,
        error: 'C++ compilation did not produce program.wasm.',
        consoleOutput: [],
        executionTimeMs: elapsedMs(start),
        timings: { ...timings, totalMs: elapsedMs(start) },
      };
    }

    const wasmCompileStartedAt = now();
    programModule = await WebAssembly.compile(programBytes);
    timings.wasmCompileMs = elapsedMs(wasmCompileStartedAt);
    storeProgramModule(cacheKey, programModule);
  }

  try {
    const runStartedAt = now();
    const program = await runWasi(programModule, ['program.wasm'], new InMemoryFileSystem(), {
      stdin: JSON.stringify(inputs || {}),
    });
    timings.runMs = elapsedMs(runStartedAt);
    const parsed = parseProgramStdout(program.stdout, {
      tracing: options.tracing,
      defaultLine: signature.line,
      allowMissingResult: options.tracing,
    });
    if (scriptRequest && options.tracing) {
      parsed.events = normalizeScriptTraceEvents(parsed.events, scriptLineCount(source));
    }
    const programTimedOut = options.tracing && program.exitCode === 124;
    const runtimeTimedOut = !options.tracing && program.exitCode === 124;
    const baseResult = {
      success: program.exitCode === 0 && !programTimedOut,
      output: parsed.output,
      error: program.exitCode === 0 ? undefined : program.stderr || `C++ program exited with code ${program.exitCode}`,
      consoleOutput: [...parsed.consoleOutput, ...program.stderr.split(/\r?\n/).filter(Boolean)],
      executionTimeMs: elapsedMs(start),
      timings: { ...timings, totalMs: elapsedMs(start) },
      ...(runtimeTimedOut ? { timeoutReason: 'client-timeout', diagnosticStage: 'runtime' } : {}),
    };
    if (!options.tracing) return baseResult;
    const finalizedTrace = finalizeRuntimeTrace(parsed.events, options.traceOptions || {});
    const { trace } = finalizedTrace;
    const runtimeTraceLimitExceeded = finalizedTrace.traceLimitExceeded || Boolean(parsed.traceStatus?.traceLimitExceeded) || programTimedOut;
    const droppedEventCount = (finalizedTrace.droppedEventCount || 0) + (Number(parsed.traceStatus?.droppedEventCount) || 0);
    const timeoutReason = timeoutReasonForParsedTrace(parsed);
    return {
      ...baseResult,
      ...(programTimedOut ? { error: 'C++ trace budget exceeded.' } : {}),
      trace,
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
      traceLimitExceeded: runtimeTraceLimitExceeded,
      ...(runtimeTraceLimitExceeded ? { timeoutReason } : {}),
      ...(runtimeTraceLimitExceeded ? { droppedEventCount } : {}),
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
        executionTimeMs: elapsedMs(start),
        lineEventCount: trace.lineEventCount,
        traceStepCount: trace.traceStepCount,
        timings: { ...timings, totalMs: elapsedMs(start) },
      };
    }
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error),
      consoleOutput: [],
      executionTimeMs: elapsedMs(start),
      timings: { ...timings, totalMs: elapsedMs(start) },
    };
  }
}

async function warmToolchain() {
  if (!warmupPromise) {
    warmupPromise = (async () => {
      const result = await compileAndRun(CPP_WARMUP_SOURCE, 'add', { a: 1, b: 2 }, {
        executionStyle: 'solution-method',
      });
      if (!result?.success || result.output !== 3) {
        throw new Error(result?.error || 'C++ toolchain warmup failed.');
      }
      return result.timings || {};
    })();
    warmupPromise.catch(() => {
      warmupPromise = null;
    });
  }

  return warmupPromise;
}

async function handleInit(payload) {
  const start = now();
  configuredAssets = payload && payload.assets ? payload.assets : null;
  toolchainPromise = null;
  warmupPromise = null;
  programCache = new Map();
  resetCompilerWorker();
  const totalMs = elapsedMs(start);
  return {
    success: true,
    loadTimeMs: totalMs,
    timings: {
      totalMs,
      toolchainLoadMs: 0,
      warmupMs: 0,
    },
  };
}

async function handleWarmup(payload) {
  if (payload && payload.assets) {
    configuredAssets = payload.assets;
  }
  const start = now();
  let toolchainLoadMs = 0;
  if (!canUseEphemeralCompilerWorker()) {
    const toolchainStartedAt = now();
    await loadToolchain();
    toolchainLoadMs = elapsedMs(toolchainStartedAt);
  }
  const warmupStartedAt = now();
  const warmupTimings = await warmToolchain();
  const warmupMs = elapsedMs(warmupStartedAt);
  const reportedToolchainLoadMs =
    toolchainLoadMs ||
    (typeof warmupTimings.toolchainLoadMs === 'number' ? warmupTimings.toolchainLoadMs : 0);
  const totalMs = elapsedMs(start);
  return {
    success: true,
    loadTimeMs: totalMs,
    timings: {
      totalMs,
      toolchainLoadMs: reportedToolchainLoadMs,
      warmupMs,
      ...(typeof warmupTimings.compileMs === 'number' ? { compileMs: warmupTimings.compileMs } : {}),
      ...(typeof warmupTimings.externalCompileMs === 'number' ? { externalCompileMs: warmupTimings.externalCompileMs } : {}),
      ...(typeof warmupTimings.compilerWorkerMs === 'number' ? { compilerWorkerMs: warmupTimings.compilerWorkerMs } : {}),
      ...(typeof warmupTimings.wasmCompileMs === 'number' ? { wasmCompileMs: warmupTimings.wasmCompileMs } : {}),
      ...(typeof warmupTimings.runMs === 'number' ? { runMs: warmupTimings.runMs } : {}),
    },
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

  if (!functionName.trim() && payload?.executionStyle !== 'function') {
    return {
      success: false,
      output: null,
      error: 'C++ named execution requires a function name.',
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

  if (!functionName.trim() && payload?.executionStyle !== 'function') {
    const trace = finalizeRuntimeTrace([
      { kind: 'exception', line: 1, message: 'C++ named tracing requires a function name.' },
    ]).trace;
    return {
      success: false,
      output: null,
      error: 'C++ named tracing requires a function name.',
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

function isInterviewTimeoutResult(result) {
  const normalized = String(result?.error ?? '').toLowerCase();
  const timeoutReason = result?.timeoutReason ?? '';
  return (
    timeoutReason === 'trace-limit' ||
    timeoutReason === 'line-limit' ||
    timeoutReason === 'single-line-limit' ||
    timeoutReason === 'client-timeout' ||
    normalized.includes('timed out') ||
    normalized.includes('trace budget') ||
    normalized.includes('trace-limit') ||
    normalized.includes('line-limit') ||
    normalized.includes('infinite loop')
  );
}

async function handleExecuteCodeInterview(payload) {
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

  if (!functionName.trim() && payload?.executionStyle !== 'function') {
    return {
      success: false,
      output: null,
      error: 'C++ named interview execution requires a function name.',
      consoleOutput: [],
    };
  }

  try {
    const result = await compileAndRun(source, functionName, payload?.inputs || {}, {
      tracing: true,
      traceOptions: {
        maxTraceSteps: DEFAULT_INTERVIEW_MAX_TRACE_STEPS,
        maxLineEvents: DEFAULT_INTERVIEW_MAX_LINE_EVENTS,
        maxSingleLineHits: DEFAULT_INTERVIEW_MAX_SINGLE_LINE_HITS,
        ...(payload?.options && typeof payload.options === 'object' ? payload.options : {}),
      },
      executionStyle: payload?.executionStyle || 'solution-method',
    });

    if (!result.success) {
      if (isInterviewTimeoutResult(result)) {
        return {
          success: false,
          output: null,
          error: 'Time Limit Exceeded',
          ...(isTraceTimeoutReason(result.timeoutReason) ? { timeoutReason: result.timeoutReason } : {}),
          diagnosticStage: 'interview',
          consoleOutput: result.consoleOutput || [],
          timings: result.timings,
        };
      }
      return {
        success: false,
        output: null,
        error: result.error || 'C++ interview execution failed.',
        ...(result.errorLine !== undefined ? { errorLine: result.errorLine } : {}),
        consoleOutput: result.consoleOutput || [],
        timings: result.timings,
      };
    }

    return {
      success: true,
      output: result.output,
      consoleOutput: result.consoleOutput || [],
      timings: result.timings,
    };
  } catch {
    return {
      success: false,
      output: null,
      error: 'Time Limit Exceeded',
      timeoutReason: 'client-timeout',
      diagnosticStage: 'interview',
      consoleOutput: [],
    };
  }
}

self.onmessage = (event) => {
  const { id, type, payload, requestId } = event.data || {};
  if (type === 'compile-response') {
    const pending = pendingExternalCompiles.get(String(requestId || ''));
    if (!pending) return;
    pendingExternalCompiles.delete(String(requestId));
    clearTimeout(pending.timeoutId);
    if (payload?.success === false && payload?.error) {
      pending.resolve(payload);
      return;
    }
    pending.resolve(payload || {});
    return;
  }

  if (!id) return;
  clearIdleTimer();
  applyWorkerOptions(payload);
  queuedTasks += 1;

  queue = queue
    .catch(() => {})
    .then(async () => {
      const result =
        type === 'init'
          ? await handleInit(payload)
          : type === 'warmup'
            ? await handleWarmup(payload)
          : type === 'compile-run'
            ? await handleCompileRun(payload)
            : type === 'execute-project-cpp'
              ? await handleProjectCpp(payload, id)
            : type === 'execute-with-tracing'
              ? await handleExecuteWithTracing(payload)
              : type === 'execute-code-interview'
                ? await handleExecuteCodeInterview(payload)
                : await Promise.reject(new Error(`Unknown C++ worker message: ${type}`));

      postSuccess(id, type, result);
    })
    .catch((error) => {
      emitRuntimeDiagnostic('error', 'worker-request-failed', 'C++ worker request failed.', {
        type,
        message: error instanceof Error ? error.message : String(error),
      });
      postFailure(id, error);
    })
    .finally(() => {
      queuedTasks = Math.max(0, queuedTasks - 1);
      if (queuedTasks === 0) resetIdleTimer();
    });
};

emitRuntimeDiagnostic('info', 'worker-ready', 'C++ worker is ready.');
postMessage({ type: 'worker-ready' });

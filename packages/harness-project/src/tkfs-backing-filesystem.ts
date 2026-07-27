import * as Effect from 'effect/Effect';
import * as Either from 'effect/Either';
import {
  TraceKernelFileSystem,
  type TraceKernelStat,
} from '@tracecode/tracekernel';
import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from 'just-bash/browser';
import { normalizeWorkspaceCwd } from './paths';

type ReadOptions = Parameters<IFileSystem['readFile']>[1];
type WriteOptions = Parameters<IFileSystem['writeFile']>[2];
type DirectoryEntries = Awaited<
  ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>
>;
type ByteStringResult = Awaited<
  ReturnType<NonNullable<IFileSystem['readFileBytes']>>
>;

function selectedEncoding(
  options: ReadOptions | WriteOptions | undefined,
  fallback: BufferEncoding = 'utf8'
): BufferEncoding {
  if (typeof options === 'string') return options;
  return (options?.encoding ?? fallback) as BufferEncoding;
}

function bytesFromText(value: string, encoding: BufferEncoding): Uint8Array {
  if (encoding === 'base64') {
    const decoded = globalThis.atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }
  if (encoding === 'hex') {
    if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
      throw Object.assign(new Error('EINVAL: invalid hexadecimal file contents'), {
        code: 'EINVAL',
      });
    }
    const bytes = new Uint8Array(value.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }
  if (
    encoding === 'ascii' ||
    encoding === 'binary' ||
    encoding === 'latin1'
  ) {
    return Uint8Array.from(value, (character) => character.charCodeAt(0) & 0xff);
  }
  return new TextEncoder().encode(value);
}

function textFromBytes(bytes: Uint8Array, encoding: BufferEncoding): string {
  if (encoding === 'base64') {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globalThis.btoa(binary);
  }
  if (encoding === 'hex') {
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  if (
    encoding === 'ascii' ||
    encoding === 'binary' ||
    encoding === 'latin1'
  ) {
    return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  }
  return new TextDecoder().decode(bytes);
}

function contentBytes(content: FileContent, options?: WriteOptions): Uint8Array {
  return typeof content === 'string'
    ? bytesFromText(content, selectedEncoding(options))
    : Uint8Array.from(content);
}

function fsStat(stat: TraceKernelStat): FsStat {
  return {
    isFile: stat.kind === 'file',
    isDirectory: stat.kind === 'directory',
    isSymbolicLink: stat.kind === 'symlink',
    mode: stat.mode,
    size: stat.size,
    mtime: new Date(stat.modifiedAt),
  };
}

function localError(code: string, syscall: string, path: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}, ${syscall} '${path}'`), {
    code,
    syscall,
    path,
  });
}

function missingPathError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function runKernelEffect<Value, Failure>(
  effect: Effect.Effect<Value, Failure>
): Promise<Value> {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isLeft(result)) throw result.left;
  return result.right;
}

/**
 * just-bash compatibility over the session-owned TraceKernel filesystem.
 *
 * This adapter contains no filesystem state. Policy, quota, event observation,
 * and shell behavior may wrap it, but every byte and namespace mutation
 * linearizes in the supplied TKFS.
 */
export class TraceKernelBackingFileSystem implements IFileSystem {
  constructor(readonly traceKernelFileSystem: TraceKernelFileSystem) {}

  async readFile(path: string, options?: ReadOptions): Promise<string> {
    const bytes = await this.readFileBuffer(path);
    return textFromBytes(bytes, selectedEncoding(options));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return runKernelEffect(this.traceKernelFileSystem.readFile(path, '/'));
  }

  async readFileBytes(path: string): Promise<ByteStringResult> {
    const bytes = await this.readFileBuffer(path);
    return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('') as unknown as ByteStringResult;
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteOptions
  ): Promise<void> {
    await this.ensureParentDirectory(path);
    await runKernelEffect(
      this.traceKernelFileSystem.writeFile(path, contentBytes(content, options), '/')
    );
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteOptions
  ): Promise<void> {
    await this.ensureParentDirectory(path);
    const file = await runKernelEffect(this.traceKernelFileSystem.prepareOpen(path, '/', {
      access: 'write',
      create: true,
      append: true,
    }));
    await runKernelEffect(
      this.traceKernelFileSystem.writeAt(file, 0, contentBytes(content, options), true)
    );
  }

  async exists(path: string): Promise<boolean> {
    try {
      await runKernelEffect(this.traceKernelFileSystem.lstat(path, '/'));
      return true;
    } catch (error) {
      if (missingPathError(error)) return false;
      throw error;
    }
  }

  async stat(path: string): Promise<FsStat> {
    return fsStat(await runKernelEffect(this.traceKernelFileSystem.stat(path, '/')));
  }

  async lstat(path: string): Promise<FsStat> {
    return fsStat(await runKernelEffect(this.traceKernelFileSystem.lstat(path, '/')));
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await runKernelEffect(this.traceKernelFileSystem.mkdir(path, options, '/'));
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await runKernelEffect(this.traceKernelFileSystem.readdir(path, '/'));
    return entries.map((entry) => entry.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirectoryEntries> {
    const entries = await runKernelEffect(this.traceKernelFileSystem.readdir(path, '/'));
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.kind === 'file',
      isDirectory: entry.kind === 'directory',
      isSymbolicLink: entry.kind === 'symlink',
    }));
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    let stat: FsStat;
    try {
      stat = await this.lstat(path);
    } catch (error) {
      if (options.force && missingPathError(error)) return;
      throw error;
    }
    if (!stat.isDirectory) {
      await runKernelEffect(this.traceKernelFileSystem.unlink(path, '/'));
      return;
    }
    if (options.recursive) {
      for (const entry of await this.readdir(path)) {
        await this.rm(this.resolvePath(path, entry), { recursive: true, force: false });
      }
    }
    await runKernelEffect(this.traceKernelFileSystem.rmdir(path, '/'));
  }

  async cp(src: string, dest: string, options: CpOptions = {}): Promise<void> {
    const source = await this.lstat(src);
    if (source.isSymbolicLink) {
      if (await this.exists(dest)) await this.rm(dest, { recursive: true });
      await this.symlink(await this.readlink(src), dest);
      return;
    }
    if (source.isFile) {
      await this.writeFile(dest, await this.readFileBuffer(src));
      await this.chmod(dest, source.mode);
      await this.utimes(dest, source.mtime, source.mtime);
      return;
    }
    if (!options.recursive) {
      throw localError('EISDIR', 'cp', src, 'source is a directory');
    }
    if (!(await this.exists(dest))) await this.mkdir(dest, { recursive: true });
    await this.chmod(dest, source.mode);
    for (const entry of await this.readdir(src)) {
      await this.cp(
        this.resolvePath(src, entry),
        this.resolvePath(dest, entry),
        { recursive: true }
      );
    }
    await this.utimes(dest, source.mtime, source.mtime);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.ensureParentDirectory(dest);
    await runKernelEffect(this.traceKernelFileSystem.rename(src, dest, '/'));
  }

  resolvePath(base: string, path: string): string {
    return normalizeWorkspaceCwd(path.startsWith('/') ? path : `${base}/${path}`);
  }

  getAllPaths(): string[] {
    return [...this.traceKernelFileSystem.namespacePaths()];
  }

  async chmod(path: string, mode: number): Promise<void> {
    await runKernelEffect(this.traceKernelFileSystem.chmod(path, mode, '/'));
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await runKernelEffect(this.traceKernelFileSystem.symlink(target, linkPath, '/'));
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await runKernelEffect(this.traceKernelFileSystem.link(existingPath, newPath, '/'));
  }

  async readlink(path: string): Promise<string> {
    return runKernelEffect(this.traceKernelFileSystem.readlink(path, '/'));
  }

  async realpath(path: string): Promise<string> {
    return runKernelEffect(this.traceKernelFileSystem.realpath(path, '/'));
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    await runKernelEffect(
      this.traceKernelFileSystem.utimes(path, mtime.getTime(), '/')
    );
  }

  private async ensureParentDirectory(path: string): Promise<void> {
    const normalized = this.resolvePath('/', path);
    const separator = normalized.lastIndexOf('/');
    const parent = separator <= 0 ? '/' : normalized.slice(0, separator);
    if (!(await this.exists(parent))) await this.mkdir(parent, { recursive: true });
  }
}

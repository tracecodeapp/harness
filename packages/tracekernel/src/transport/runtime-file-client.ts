import type {
  TraceKernelSyscallErrorCode,
  TraceKernelSyscallRequest,
  TraceKernelSyscallResult,
  TraceKernelSyscallValue,
} from '../syscalls';
import type { TraceKernelStat } from '../vfs';
import type { TraceKernelSyncSyscallTransport } from './shared-channel';
import { TraceKernelTransportError } from './wire';

export interface TraceKernelGenerationSource {
  current(): number;
}

export class TraceKernelSharedGenerationSource implements TraceKernelGenerationSource {
  private readonly generation: Int32Array;

  constructor(buffer: SharedArrayBuffer) {
    if (
      !(buffer instanceof SharedArrayBuffer) ||
      buffer.byteLength !== Int32Array.BYTES_PER_ELEMENT
    ) {
      throw new TraceKernelTransportError('EPROTO', 'invalid TKFS generation buffer');
    }
    this.generation = new Int32Array(buffer);
  }

  current(): number {
    return Atomics.load(this.generation, 0);
  }
}

export class TraceKernelRuntimeSyscallError extends Error {
  // Runtime code should observe the same public error identity as a native
  // Node syscall. The concrete bridge class remains available to hosts for
  // `instanceof` checks, but its stack must not expose TraceKernel internals.
  readonly name = 'Error';

  constructor(
    readonly code: TraceKernelSyscallErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface TraceKernelRuntimeFileClientOptions {
  readonly generation?: TraceKernelGenerationSource;
  readonly maxCacheEntries?: number;
  readonly maxCacheBytes?: number;
}

interface RuntimeReadCacheEntry {
  readonly generation: number;
  readonly bytes: Uint8Array;
}

/**
 * Transport-neutral bulk-file adapter for language runtimes.
 *
 * Mutable operations always cross the syscall boundary. Reads may use a
 * bounded worker-local cache only while the shared session generation exactly
 * matches the generation returned by the authoritative read.
 */
export class TraceKernelRuntimeFileClient {
  private readonly cache = new Map<string, RuntimeReadCacheEntry>();
  private readonly maxCacheEntries: number;
  private readonly maxCacheBytes: number;
  private cacheBytes = 0;
  private cacheHitCount = 0;
  private cacheMissCount = 0;

  constructor(
    private readonly transport: TraceKernelSyncSyscallTransport,
    private readonly options: TraceKernelRuntimeFileClientOptions = {}
  ) {
    this.maxCacheEntries = Math.max(0, Math.floor(options.maxCacheEntries ?? 256));
    this.maxCacheBytes = Math.max(0, Math.floor(options.maxCacheBytes ?? 16 * 1024 * 1024));
  }

  get cacheHits(): number {
    return this.cacheHitCount;
  }

  get cacheMisses(): number {
    return this.cacheMissCount;
  }

  identity(): Extract<TraceKernelSyscallValue, { op: 'identity' }> {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'identity' }),
      'identity'
    );
  }

  isatty(fd: number): boolean {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'isatty', fd }),
      'isatty'
    ).isTerminal;
  }

  tcgetpgrp(fd: number): number {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'tcgetpgrp', fd }),
      'tcgetpgrp'
    ).pgid;
  }

  tcsetpgrp(fd: number, pgid: number): number {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'tcsetpgrp', fd, pgid }),
      'tcsetpgrp'
    ).pgid;
  }

  tcgetwinsize(fd: number): {
    readonly rows: number;
    readonly columns: number;
  } {
    const value = this.expectSuccess(
      this.transport.dispatchSync({ op: 'tcgetwinsize', fd }),
      'tcgetwinsize'
    );
    return { rows: value.rows, columns: value.columns };
  }

  tcsetwinsize(
    fd: number,
    rows: number,
    columns: number
  ): { readonly rows: number; readonly columns: number } {
    const value = this.expectSuccess(
      this.transport.dispatchSync({
        op: 'tcsetwinsize',
        fd,
        rows,
        columns,
      }),
      'tcsetwinsize'
    );
    return { rows: value.rows, columns: value.columns };
  }

  socket(): number {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'socket' }),
      'socket'
    ).fd;
  }

  bind(
    fd: number,
    address: Extract<TraceKernelSyscallRequest, { op: 'bind' }>['address']
  ): Extract<TraceKernelSyscallValue, { op: 'bind' }>['address'] {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'bind', fd, address }),
      'bind'
    ).address;
  }

  listen(
    fd: number,
    options?: Extract<TraceKernelSyscallRequest, { op: 'listen' }>['options']
  ): void {
    this.expectSuccess(
      this.transport.dispatchSync({ op: 'listen', fd, options }),
      'listen'
    );
  }

  accept(fd: number): Extract<TraceKernelSyscallValue, { op: 'accept' }> {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'accept', fd }),
      'accept'
    );
  }

  connect(
    fd: number,
    address: Extract<TraceKernelSyscallRequest, { op: 'connect' }>['address']
  ): Extract<TraceKernelSyscallValue, { op: 'connect' }> {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'connect', fd, address }),
      'connect'
    );
  }

  send(fd: number, bytes: Uint8Array): number {
    return this.expectSuccess(
      this.transport.dispatchSync({
        op: 'send',
        fd,
        bytes: Uint8Array.from(bytes),
      }),
      'send'
    ).bytesWritten;
  }

  recv(fd: number, maxBytes: number): Uint8Array {
    return Uint8Array.from(this.expectSuccess(
      this.transport.dispatchSync({ op: 'recv', fd, maxBytes }),
      'recv'
    ).bytes);
  }

  shutdown(
    fd: number,
    how: Extract<TraceKernelSyscallRequest, { op: 'shutdown' }>['how']
  ): void {
    this.expectSuccess(
      this.transport.dispatchSync({ op: 'shutdown', fd, how }),
      'shutdown'
    );
  }

  getsockname(
    fd: number
  ): Extract<TraceKernelSyscallValue, { op: 'getsockname' }>['address'] {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'getsockname', fd }),
      'getsockname'
    ).address;
  }

  getpeername(
    fd: number
  ): Extract<TraceKernelSyscallValue, { op: 'getpeername' }>['address'] {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'getpeername', fd }),
      'getpeername'
    ).address;
  }

  socketError(
    fd: number
  ): Extract<TraceKernelSyscallValue, { op: 'getsockopt' }>['error'] {
    return this.expectSuccess(
      this.transport.dispatchSync({
        op: 'getsockopt',
        fd,
        option: 'error',
      }),
      'getsockopt'
    ).error;
  }

  open(
    path: string,
    options?: Extract<TraceKernelSyscallRequest, { op: 'open' }>['options']
  ): number {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'open', path, options }),
      'open'
    ).fd;
  }

  read(fd: number, maxBytes: number, position?: number): Uint8Array {
    return Uint8Array.from(this.expectSuccess(
      this.transport.dispatchSync({
        op: 'read',
        fd,
        maxBytes,
        ...(position === undefined ? {} : { position }),
      }),
      'read'
    ).bytes);
  }

  write(fd: number, bytes: Uint8Array, position?: number): number {
    return this.expectSuccess(
      this.transport.dispatchSync({
        op: 'write',
        fd,
        bytes: Uint8Array.from(bytes),
        ...(position === undefined ? {} : { position }),
      }),
      'write'
    ).bytesWritten;
  }

  seek(
    fd: number,
    offset: number,
    whence: 'set' | 'current' | 'end'
  ): number {
    return this.expectSuccess(
      this.transport.dispatchSync({
        op: 'seek',
        fd,
        offset,
        whence,
      }),
      'seek'
    ).offset;
  }

  closeDescriptor(fd: number): void {
    this.expectSuccess(
      this.transport.dispatchSync({ op: 'close', fd }),
      'close'
    );
  }

  dup(fd: number): number {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'dup', fd }),
      'dup'
    ).fd;
  }

  dup2(fd: number, targetFd: number): number {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'dup2', fd, targetFd }),
      'dup2'
    ).fd;
  }

  getCloseOnExec(fd: number): boolean {
    return this.expectSuccess(
      this.transport.dispatchSync({
        op: 'fcntl',
        fd,
        action: 'get-close-on-exec',
      }),
      'fcntl'
    ).closeOnExec;
  }

  setCloseOnExec(fd: number, closeOnExec: boolean): void {
    this.expectSuccess(
      this.transport.dispatchSync({
        op: 'fcntl',
        fd,
        action: 'set-close-on-exec',
        closeOnExec,
      }),
      'fcntl'
    );
  }

  fstat(fd: number): TraceKernelStat {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'fstat', fd }),
      'fstat'
    ).stat;
  }

  ftruncate(fd: number, length: number): void {
    this.expectSuccess(
      this.transport.dispatchSync({ op: 'ftruncate', fd, length }),
      'ftruncate'
    );
  }

  readFile(path: string): Uint8Array {
    const generation = this.options.generation?.current();
    const cached = this.cache.get(path);
    if (generation !== undefined && cached?.generation === generation) {
      this.cache.delete(path);
      this.cache.set(path, cached);
      this.cacheHitCount += 1;
      return Uint8Array.from(cached.bytes);
    }

    this.cacheMissCount += 1;
    const result = this.transport.dispatchSync({ op: 'readFile', path });
    const value = this.expectSuccess(result, 'readFile');
    const bytes = Uint8Array.from(value.bytes);
    if (
      this.options.generation &&
      this.options.generation.current() === value.cacheGeneration
    ) {
      this.cacheRead(path, value.cacheGeneration, bytes);
    }
    return Uint8Array.from(bytes);
  }

  writeFile(path: string, bytes: Uint8Array): void {
    const result = this.transport.dispatchSync({
      op: 'writeFile',
      path,
      bytes: Uint8Array.from(bytes),
    });
    this.expectSuccess(result, 'writeFile');
    this.removeCached(path);
  }

  stat(path: string): Extract<TraceKernelSyscallValue, { op: 'stat' }>['stat'] {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'stat', path }),
      'stat'
    ).stat;
  }

  lstat(path: string): Extract<TraceKernelSyscallValue, { op: 'lstat' }>['stat'] {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'lstat', path }),
      'lstat'
    ).stat;
  }

  realpath(path: string): string {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'realpath', path }),
      'realpath'
    ).path;
  }

  readdir(
    path: string
  ): Extract<TraceKernelSyscallValue, { op: 'readdir' }>['entries'] {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'readdir', path }),
      'readdir'
    ).entries;
  }

  mkdir(
    path: string,
    options?: Extract<TraceKernelSyscallRequest, { op: 'mkdir' }>['options']
  ): void {
    this.expectSuccess(
      this.transport.dispatchSync({ op: 'mkdir', path, options }),
      'mkdir'
    );
  }

  rmdir(path: string): void {
    this.expectSuccess(
      this.transport.dispatchSync({ op: 'rmdir', path }),
      'rmdir'
    );
  }

  unlink(path: string): void {
    this.expectSuccess(
      this.transport.dispatchSync({ op: 'unlink', path }),
      'unlink'
    );
    this.removeCached(path);
  }

  link(existingPath: string, newPath: string): void {
    this.expectSuccess(
      this.transport.dispatchSync({ op: 'link', existingPath, newPath }),
      'link'
    );
    this.removeCached(newPath);
  }

  symlink(target: string, linkPath: string): void {
    this.expectSuccess(
      this.transport.dispatchSync({ op: 'symlink', target, linkPath }),
      'symlink'
    );
    this.removeCached(linkPath);
  }

  readlink(path: string): string {
    return this.expectSuccess(
      this.transport.dispatchSync({ op: 'readlink', path }),
      'readlink'
    ).target;
  }

  rename(sourcePath: string, destinationPath: string): void {
    this.expectSuccess(
      this.transport.dispatchSync({
        op: 'rename',
        sourcePath,
        destinationPath,
      }),
      'rename'
    );
    this.removeCached(sourcePath);
    this.removeCached(destinationPath);
  }

  clearCache(): void {
    this.cache.clear();
    this.cacheBytes = 0;
  }

  private expectSuccess<Operation extends TraceKernelSyscallValue['op']>(
    result: TraceKernelSyscallResult,
    operation: Operation
  ): Extract<TraceKernelSyscallValue, { op: Operation }> {
    if (!result.ok) {
      throw new TraceKernelRuntimeSyscallError(result.error.code, result.error.message);
    }
    if (result.value.op !== operation) {
      throw new TraceKernelTransportError(
        'EPROTO',
        `expected ${operation} response, received ${result.value.op}`
      );
    }
    return result.value as Extract<TraceKernelSyscallValue, { op: Operation }>;
  }

  private cacheRead(path: string, generation: number, bytes: Uint8Array): void {
    if (
      this.maxCacheEntries === 0 ||
      this.maxCacheBytes === 0 ||
      bytes.byteLength > this.maxCacheBytes
    ) {
      return;
    }
    this.removeCached(path);
    while (
      this.cache.size >= this.maxCacheEntries ||
      this.cacheBytes + bytes.byteLength > this.maxCacheBytes
    ) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.removeCached(oldest);
    }
    const stored = Uint8Array.from(bytes);
    this.cache.set(path, { generation, bytes: stored });
    this.cacheBytes += stored.byteLength;
  }

  private removeCached(path: string): void {
    const cached = this.cache.get(path);
    if (!cached) return;
    this.cache.delete(path);
    this.cacheBytes -= cached.bytes.byteLength;
  }
}

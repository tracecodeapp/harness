import * as Effect from 'effect/Effect';
import {
  TraceKernelBadFileDescriptorError,
  TraceKernelBrokenPipeError,
  TraceKernelChildProcessError,
  TraceKernelDescriptorLimitError,
  TraceKernelFileSystemError,
  TraceKernelInvalidArgumentError,
  TraceKernelInvalidDescriptorOperationError,
  TraceKernelNetworkError,
  TraceKernelProcessLimitError,
  TraceKernelProcessPermissionError,
  TraceKernelProcessStateError,
} from './errors';
import type { TraceKernelProcess, TraceKernelSession } from './kernel';
import type {
  TraceKernelDescriptorMapping,
  TraceKernelProcessTermination,
  TraceKernelSignal,
  TraceKernelSpawnDescriptorAction,
  TraceKernelWatchdogSignal,
} from './model';
import type {
  TraceKernelDirectoryEntry,
  TraceKernelMkdirOptions,
  TraceKernelOpenFileOptions,
  TraceKernelStat,
} from './vfs';
import type {
  TraceKernelTcpAddress,
  TraceKernelTcpListenOptions,
  TraceKernelTcpShutdownHow,
} from './network';
import type { TraceKernelWatchOptions } from './watch';

export type TraceKernelSpawnStdioMode = 'pipe' | 'inherit' | 'ignore';

export interface TraceKernelSpawnStdio {
  readonly stdin?: TraceKernelSpawnStdioMode;
  readonly stdout?: TraceKernelSpawnStdioMode;
  readonly stderr?: TraceKernelSpawnStdioMode;
}

export interface TraceKernelSpawnParentStdio {
  /** Parent-owned writer connected to the child's fd 0. */
  readonly stdinFd?: number;
  /** Parent-owned reader connected to the child's fd 1. */
  readonly stdoutFd?: number;
  /** Parent-owned reader connected to the child's fd 2. */
  readonly stderrFd?: number;
}

export type TraceKernelSyscallRequest =
  | {
      readonly op: 'pipe';
      readonly options?: {
        readonly capacityChunks?: number;
      };
    }
  | {
      readonly op: 'watch';
      readonly path: string;
      readonly options?: TraceKernelWatchOptions;
    }
  | {
      readonly op: 'watchdog';
      readonly action: 'arm' | 'pet' | 'disarm' | 'status';
      readonly timeoutMs?: number;
      readonly signal?: TraceKernelWatchdogSignal;
    }
  | {
      readonly op: 'spawn';
      readonly runtime: string;
      readonly command: string;
      readonly args?: readonly string[];
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly inheritDescriptors?: 'all' | readonly number[];
      readonly descriptorMappings?: readonly TraceKernelDescriptorMapping[];
      readonly descriptorActions?: readonly TraceKernelSpawnDescriptorAction[];
      readonly stdio?: TraceKernelSpawnStdio;
      readonly processGroupId?: number;
      readonly sessionId?: number;
    }
  | {
      readonly op: 'wait';
      readonly pid: number;
      readonly noHang?: boolean;
    }
  | {
      readonly op: 'kill';
      readonly pid: number;
      readonly signal: TraceKernelSignal;
    }
  | {
      readonly op: 'socket';
    }
  | {
      readonly op: 'bind';
      readonly fd: number;
      readonly address: TraceKernelTcpAddress;
    }
  | {
      readonly op: 'listen';
      readonly fd: number;
      readonly options?: TraceKernelTcpListenOptions;
    }
  | {
      readonly op: 'accept';
      readonly fd: number;
    }
  | {
      readonly op: 'connect';
      readonly fd: number;
      readonly address: TraceKernelTcpAddress;
    }
  | {
      readonly op: 'send';
      readonly fd: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly op: 'recv';
      readonly fd: number;
      readonly maxBytes: number;
    }
  | {
      readonly op: 'shutdown';
      readonly fd: number;
      readonly how: TraceKernelTcpShutdownHow;
    }
  | {
      readonly op: 'getsockname' | 'getpeername';
      readonly fd: number;
    }
  | {
      readonly op: 'open';
      readonly path: string;
      readonly options?: TraceKernelOpenFileOptions;
    }
  | {
      readonly op: 'read';
      readonly fd: number;
      readonly maxBytes: number;
      readonly position?: number;
    }
  | {
      readonly op: 'write';
      readonly fd: number;
      readonly bytes: Uint8Array;
      readonly position?: number;
    }
  | {
      readonly op: 'close';
      readonly fd: number;
    }
  | {
      readonly op: 'dup';
      readonly fd: number;
    }
  | {
      readonly op: 'dup2';
      readonly fd: number;
      readonly targetFd: number;
    }
  | {
      readonly op: 'fcntl';
      readonly fd: number;
      readonly action: 'get-close-on-exec' | 'set-close-on-exec';
      readonly closeOnExec?: boolean;
    }
  | {
      readonly op: 'fstat';
      readonly fd: number;
    }
  | {
      readonly op: 'ftruncate';
      readonly fd: number;
      readonly length: number;
    }
  | {
      readonly op: 'stat';
      readonly path: string;
    }
  | {
      readonly op: 'lstat';
      readonly path: string;
    }
  | {
      readonly op: 'realpath';
      readonly path: string;
    }
  | {
      readonly op: 'readdir';
      readonly path: string;
    }
  | {
      readonly op: 'mkdir';
      readonly path: string;
      readonly options?: TraceKernelMkdirOptions;
    }
  | {
      readonly op: 'rmdir';
      readonly path: string;
    }
  | {
      readonly op: 'unlink';
      readonly path: string;
    }
  | {
      readonly op: 'link';
      readonly existingPath: string;
      readonly newPath: string;
    }
  | {
      readonly op: 'symlink';
      readonly target: string;
      readonly linkPath: string;
    }
  | {
      readonly op: 'readlink';
      readonly path: string;
    }
  | {
      readonly op: 'rename';
      readonly sourcePath: string;
      readonly destinationPath: string;
    }
  | {
      readonly op: 'readFile';
      readonly path: string;
    }
  | {
      readonly op: 'writeFile';
      readonly path: string;
      readonly bytes: Uint8Array;
    };

export type TraceKernelSyscallValue =
  | {
      readonly op: 'pipe';
      readonly readFd: number;
      readonly writeFd: number;
    }
  | { readonly op: 'watch'; readonly fd: number }
  | {
      readonly op: 'watchdog';
      readonly armed: boolean;
      readonly timeoutMs?: number;
      readonly deadlineAt?: number;
      readonly signal?: TraceKernelWatchdogSignal;
    }
  | {
      readonly op: 'spawn';
      readonly pid: number;
      readonly stdio?: TraceKernelSpawnParentStdio;
    }
  | {
      readonly op: 'wait';
      readonly pid: number;
      readonly termination?: TraceKernelProcessTermination;
    }
  | { readonly op: 'kill' }
  | { readonly op: 'socket'; readonly fd: number }
  | { readonly op: 'bind'; readonly address: TraceKernelTcpAddress }
  | { readonly op: 'listen' }
  | {
      readonly op: 'accept';
      readonly fd: number;
      readonly localAddress: TraceKernelTcpAddress;
      readonly remoteAddress: TraceKernelTcpAddress;
    }
  | {
      readonly op: 'connect';
      readonly localAddress: TraceKernelTcpAddress;
      readonly remoteAddress: TraceKernelTcpAddress;
    }
  | { readonly op: 'send'; readonly bytesWritten: number }
  | { readonly op: 'recv'; readonly bytes: Uint8Array }
  | { readonly op: 'shutdown' }
  | { readonly op: 'getsockname'; readonly address: TraceKernelTcpAddress }
  | { readonly op: 'getpeername'; readonly address: TraceKernelTcpAddress }
  | { readonly op: 'open'; readonly fd: number }
  | { readonly op: 'read'; readonly bytes: Uint8Array }
  | { readonly op: 'write'; readonly bytesWritten: number }
  | { readonly op: 'close' }
  | { readonly op: 'dup'; readonly fd: number }
  | { readonly op: 'dup2'; readonly fd: number }
  | { readonly op: 'fcntl'; readonly closeOnExec: boolean }
  | { readonly op: 'fstat'; readonly stat: TraceKernelStat }
  | { readonly op: 'ftruncate' }
  | { readonly op: 'stat'; readonly stat: TraceKernelStat }
  | { readonly op: 'lstat'; readonly stat: TraceKernelStat }
  | { readonly op: 'realpath'; readonly path: string }
  | { readonly op: 'readdir'; readonly entries: readonly TraceKernelDirectoryEntry[] }
  | { readonly op: 'mkdir' }
  | { readonly op: 'rmdir' }
  | { readonly op: 'unlink' }
  | { readonly op: 'link' }
  | { readonly op: 'symlink' }
  | { readonly op: 'readlink'; readonly target: string }
  | { readonly op: 'rename' }
  | {
      readonly op: 'readFile';
      readonly bytes: Uint8Array;
      readonly cacheGeneration: number;
    }
  | { readonly op: 'writeFile' };

export type TraceKernelSyscallErrorCode =
  | 'E2BIG'
  | 'EAGAIN'
  | 'EADDRINUSE'
  | 'EACCES'
  | 'EAFNOSUPPORT'
  | 'EBADF'
  | 'EBUSY'
  | 'ECHILD'
  | 'ELOOP'
  | 'ENAMETOOLONG'
  | 'EMFILE'
  | 'EEXIST'
  | 'ECONNREFUSED'
  | 'EDESTADDRREQ'
  | 'EISCONN'
  | 'EISDIR'
  | 'EINVAL'
  | 'EIO'
  | 'ENOENT'
  | 'ENOSYS'
  | 'ENOTDIR'
  | 'ENOTCONN'
  | 'ENOTEMPTY'
  | 'EPERM'
  | 'EPIPE'
  | 'EPROTO'
  | 'EOPNOTSUPP'
  | 'EROFS'
  | 'ESRCH';

export interface TraceKernelSyscallWireError {
  readonly code: TraceKernelSyscallErrorCode;
  readonly message: string;
}

export type TraceKernelSyscallResult =
  | { readonly ok: true; readonly value: TraceKernelSyscallValue }
  | { readonly ok: false; readonly error: TraceKernelSyscallWireError };

function syscallWireError(error: unknown): TraceKernelSyscallWireError {
  if (error instanceof TraceKernelFileSystemError) {
    return Object.freeze({ code: error.code, message: error.message });
  }
  if (error instanceof TraceKernelNetworkError) {
    return Object.freeze({ code: error.code, message: error.message });
  }
  if (
    error instanceof TraceKernelBadFileDescriptorError ||
    error instanceof TraceKernelInvalidDescriptorOperationError
  ) {
    return Object.freeze({ code: 'EBADF', message: error.message });
  }
  if (error instanceof TraceKernelBrokenPipeError) {
    return Object.freeze({ code: 'EPIPE', message: error.message });
  }
  if (error instanceof TraceKernelDescriptorLimitError) {
    return Object.freeze({ code: 'EMFILE', message: error.message });
  }
  if (error instanceof TraceKernelProcessLimitError) {
    return Object.freeze({ code: 'EAGAIN', message: error.message });
  }
  if (error instanceof TraceKernelChildProcessError) {
    return Object.freeze({ code: 'ECHILD', message: error.message });
  }
  if (error instanceof TraceKernelProcessPermissionError) {
    return Object.freeze({ code: 'EACCES', message: error.message });
  }
  if (error instanceof TraceKernelProcessStateError) {
    return Object.freeze({ code: 'ESRCH', message: error.message });
  }
  if (error instanceof TraceKernelInvalidArgumentError) {
    return Object.freeze({ code: error.code, message: error.message });
  }
  return Object.freeze({
    code: 'EIO',
    message: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Effect-native dispatcher with an Effect-free wire contract.
 *
 * Worker transports send `TraceKernelSyscallRequest` and receive
 * `TraceKernelSyscallResult`; no Effect value, service, fiber, or cause crosses
 * the runtime boundary.
 */
export class TraceKernelSyscallDispatcher {
  constructor(
    private readonly session: TraceKernelSession,
    private readonly process: TraceKernelProcess
  ) {}

  dispatch(request: TraceKernelSyscallRequest): Effect.Effect<TraceKernelSyscallResult> {
    return this.dispatchValue(request).pipe(
      Effect.match({
        onFailure: (error): TraceKernelSyscallResult => Object.freeze({
          ok: false,
          error: syscallWireError(error),
        }),
        onSuccess: (value): TraceKernelSyscallResult => Object.freeze({
          ok: true,
          value,
        }),
      })
    );
  }

  private dispatchValue(
    request: TraceKernelSyscallRequest
  ): Effect.Effect<TraceKernelSyscallValue, Error> {
    switch (request.op) {
      case 'pipe':
        return this.session.createPipe(
          this.process,
          this.process,
          request.options
        ).pipe(
          Effect.map(({ readFd, writeFd }) => ({
            op: 'pipe' as const,
            readFd,
            writeFd,
          }))
        );
      case 'watch':
        return this.session.watchFile(
          this.process,
          request.path,
          request.options
        ).pipe(
          Effect.map((fd) => ({ op: 'watch' as const, fd }))
        );
      case 'watchdog':
        return this.session.configureProcessWatchdog(
          this.process,
          request.action,
          {
            timeoutMs: request.timeoutMs,
            signal: request.signal,
          }
        ).pipe(
          Effect.map((watchdog) => ({
            op: 'watchdog' as const,
            armed: watchdog !== undefined,
            ...(watchdog ?? {}),
          }))
        );
      case 'spawn':
        return (
          request.stdio
            ? this.session.spawnChildWithStdio(this.process, {
                runtime: request.runtime,
                command: request.command,
                args: request.args,
                cwd: request.cwd,
                env: request.env,
                inheritDescriptors: request.inheritDescriptors,
                descriptorMappings: request.descriptorMappings,
                descriptorActions: request.descriptorActions,
                processGroupId: request.processGroupId,
                sessionId: request.sessionId,
              }, request.stdio)
            : this.session.spawnChild(this.process, {
                runtime: request.runtime,
                command: request.command,
                args: request.args,
                cwd: request.cwd,
                env: request.env,
                inheritDescriptors: request.inheritDescriptors,
                descriptorMappings: request.descriptorMappings,
                descriptorActions: request.descriptorActions,
                processGroupId: request.processGroupId,
                sessionId: request.sessionId,
              }).pipe(
                Effect.map((process) => ({ process }))
              )
        ).pipe(
          Effect.map(({ process, stdio }) => ({
            op: 'spawn' as const,
            pid: process.pid,
            ...(stdio ? { stdio } : {}),
          }))
        );
      case 'wait':
        return this.session.waitChild(this.process, request.pid, {
          noHang: request.noHang,
        }).pipe(
          Effect.flatMap((snapshot) =>
            snapshot === undefined
              ? Effect.succeed({
                  op: 'wait' as const,
                  pid: request.pid,
                })
              : snapshot.termination
              ? Effect.succeed({
                  op: 'wait' as const,
                  pid: snapshot.pid,
                  termination: snapshot.termination,
                })
              : Effect.fail(new TraceKernelProcessStateError({
                  pid: snapshot.pid,
                  message: `Process ${snapshot.pid} completed without termination state.`,
                }))
          )
        );
      case 'kill':
        return this.session.signalProcessTarget(
          this.process.snapshot().owner,
          this.process,
          request.pid,
          request.signal
        ).pipe(
          Effect.as({ op: 'kill' as const })
        );
      case 'socket':
        return this.session.createTcpSocket(this.process).pipe(
          Effect.map((fd) => ({ op: 'socket' as const, fd }))
        );
      case 'bind':
        return this.session.bindTcp(this.process, request.fd, request.address).pipe(
          Effect.map((address) => ({ op: 'bind' as const, address }))
        );
      case 'listen':
        return this.session.listenTcp(this.process, request.fd, request.options).pipe(
          Effect.as({ op: 'listen' as const })
        );
      case 'accept':
        return this.session.acceptTcp(this.process, request.fd).pipe(
          Effect.map(({ fd, localAddress, remoteAddress }) => ({
            op: 'accept' as const,
            fd,
            localAddress,
            remoteAddress,
          }))
        );
      case 'connect':
        return this.session.connectTcp(this.process, request.fd, request.address).pipe(
          Effect.map(({ localAddress, remoteAddress }) => ({
            op: 'connect' as const,
            localAddress,
            remoteAddress,
          }))
        );
      case 'send':
        return this.process.write(request.fd, request.bytes).pipe(
          Effect.map((bytesWritten) => ({ op: 'send' as const, bytesWritten }))
        );
      case 'recv':
        return this.process.read(request.fd, request.maxBytes).pipe(
          Effect.map((bytes) => ({ op: 'recv' as const, bytes }))
        );
      case 'shutdown':
        return this.session.shutdownTcp(this.process, request.fd, request.how).pipe(
          Effect.as({ op: 'shutdown' as const })
        );
      case 'getsockname':
        return this.session.tcpLocalAddress(this.process, request.fd).pipe(
          Effect.map((address) => ({ op: 'getsockname' as const, address }))
        );
      case 'getpeername':
        return this.session.tcpRemoteAddress(this.process, request.fd).pipe(
          Effect.map((address) => ({ op: 'getpeername' as const, address }))
        );
      case 'open':
        return this.session.openFile(this.process, request.path, request.options).pipe(
          Effect.map((fd) => ({ op: 'open' as const, fd }))
        );
      case 'read':
        return this.process.read(request.fd, request.maxBytes, request.position).pipe(
          Effect.map((bytes) => ({ op: 'read' as const, bytes }))
        );
      case 'write':
        return this.process.write(request.fd, request.bytes, request.position).pipe(
          Effect.map((bytesWritten) => ({ op: 'write' as const, bytesWritten }))
        );
      case 'close':
        return this.process.close(request.fd).pipe(
          Effect.as({ op: 'close' as const })
        );
      case 'dup':
        return this.process.dup(request.fd).pipe(
          Effect.map((fd) => ({ op: 'dup' as const, fd }))
        );
      case 'dup2':
        return this.process.dup2(request.fd, request.targetFd).pipe(
          Effect.map((fd) => ({ op: 'dup2' as const, fd }))
        );
      case 'fcntl':
        return request.action === 'get-close-on-exec'
          ? this.process.descriptors.getCloseOnExec(request.fd).pipe(
              Effect.map((closeOnExec) => ({
                op: 'fcntl' as const,
                closeOnExec,
              }))
            )
          : this.process.descriptors.setCloseOnExec(
              request.fd,
              request.closeOnExec === true
            ).pipe(
              Effect.as({
                op: 'fcntl' as const,
                closeOnExec: request.closeOnExec === true,
              })
            );
      case 'fstat':
        return this.process.fstat(request.fd).pipe(
          Effect.map((stat) => ({ op: 'fstat' as const, stat }))
        );
      case 'ftruncate':
        return this.process.ftruncate(request.fd, request.length).pipe(
          Effect.as({ op: 'ftruncate' as const })
        );
      case 'stat':
        return this.session.stat(request.path).pipe(
          Effect.map((stat) => ({ op: 'stat' as const, stat }))
        );
      case 'lstat':
        return this.session.lstat(request.path).pipe(
          Effect.map((stat) => ({ op: 'lstat' as const, stat }))
        );
      case 'realpath':
        return this.session.realpath(request.path).pipe(
          Effect.map((path) => ({ op: 'realpath' as const, path }))
        );
      case 'readdir':
        return this.session.readdir(request.path).pipe(
          Effect.map((entries) => ({ op: 'readdir' as const, entries }))
        );
      case 'mkdir':
        return this.session.mkdir(request.path, request.options).pipe(
          Effect.as({ op: 'mkdir' as const })
        );
      case 'rmdir':
        return this.session.rmdir(request.path).pipe(
          Effect.as({ op: 'rmdir' as const })
        );
      case 'unlink':
        return this.session.unlink(request.path).pipe(
          Effect.as({ op: 'unlink' as const })
        );
      case 'link':
        return this.session.link(request.existingPath, request.newPath).pipe(
          Effect.as({ op: 'link' as const })
        );
      case 'symlink':
        return this.session.symlink(request.target, request.linkPath).pipe(
          Effect.as({ op: 'symlink' as const })
        );
      case 'readlink':
        return this.session.readlink(request.path).pipe(
          Effect.map((target) => ({ op: 'readlink' as const, target }))
        );
      case 'rename':
        return this.session.rename(request.sourcePath, request.destinationPath).pipe(
          Effect.as({ op: 'rename' as const })
        );
      case 'readFile':
        return this.session.fileSystem.readFileVersioned(
          request.path,
          this.process.snapshot().cwd
        ).pipe(
          Effect.map(({ contents, cacheGeneration }) => ({
            op: 'readFile' as const,
            bytes: contents,
            cacheGeneration,
          }))
        );
      case 'writeFile':
        return this.session.fileSystem.writeFile(
          request.path,
          request.bytes,
          this.process.snapshot().cwd
        ).pipe(
          Effect.as({ op: 'writeFile' as const })
        );
    }
  }
}

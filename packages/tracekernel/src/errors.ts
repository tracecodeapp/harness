import * as Data from 'effect/Data';

export class TraceKernelHostClosedError extends Data.TaggedError(
  'TraceKernelHostClosedError'
)<{
  readonly message: string;
}> {}

export class TraceKernelSessionClosedError extends Data.TaggedError(
  'TraceKernelSessionClosedError'
)<{
  readonly sessionId: string;
  readonly message: string;
}> {}

export class TraceKernelRuntimeUnavailableError extends Data.TaggedError(
  'TraceKernelRuntimeUnavailableError'
)<{
  readonly runtime: string;
  readonly message: string;
}> {}

export class TraceKernelProcessStateError extends Data.TaggedError(
  'TraceKernelProcessStateError'
)<{
  readonly pid: number;
  readonly message: string;
}> {}

export class TraceKernelProcessLimitError extends Data.TaggedError(
  'TraceKernelProcessLimitError'
)<{
  readonly code: 'EAGAIN';
  readonly maxProcesses: number;
  readonly message: string;
}> {}

export class TraceKernelProcessPermissionError extends Data.TaggedError(
  'TraceKernelProcessPermissionError'
)<{
  readonly code: 'EACCES' | 'EPERM';
  readonly pid: number;
  readonly requesterId: string;
  readonly message: string;
}> {}

export class TraceKernelChildProcessError extends Data.TaggedError(
  'TraceKernelChildProcessError'
)<{
  readonly code: 'ECHILD';
  readonly pid: number;
  readonly message: string;
}> {}

export class TraceKernelInvalidArgumentError extends Data.TaggedError(
  'TraceKernelInvalidArgumentError'
)<{
  readonly code: 'EINVAL';
  readonly argument: string;
  readonly message: string;
}> {}

export class TraceKernelBadFileDescriptorError extends Data.TaggedError(
  'TraceKernelBadFileDescriptorError'
)<{
  readonly fd: number;
  readonly operation:
    | 'read'
    | 'write'
    | 'close'
    | 'dup'
    | 'dup2'
    | 'dup3'
    | 'fcntl'
    | 'inherit'
    | 'poll'
    | 'stat'
    | 'truncate';
  readonly message: string;
}> {}

export class TraceKernelBrokenPipeError extends Data.TaggedError(
  'TraceKernelBrokenPipeError'
)<{
  readonly message: string;
}> {}

export class TraceKernelWouldBlockError extends Data.TaggedError(
  'TraceKernelWouldBlockError'
)<{
  readonly code: 'EAGAIN';
  readonly operation: 'read' | 'write' | 'accept';
  readonly message: string;
}> {}

export class TraceKernelDescriptorLimitError extends Data.TaggedError(
  'TraceKernelDescriptorLimitError'
)<{
  readonly code: 'EMFILE';
  readonly maxDescriptors: number;
  readonly message: string;
}> {}

export type TraceKernelNetworkErrorCode =
  | 'EADDRINUSE'
  | 'EAFNOSUPPORT'
  | 'EBADF'
  | 'ECONNREFUSED'
  | 'EDESTADDRREQ'
  | 'EISCONN'
  | 'EINVAL'
  | 'ENOTCONN'
  | 'EOPNOTSUPP';

export class TraceKernelNetworkError extends Data.TaggedError(
  'TraceKernelNetworkError'
)<{
  readonly code: TraceKernelNetworkErrorCode;
  readonly message: string;
}> {}

export class TraceKernelInvalidDescriptorOperationError extends Data.TaggedError(
  'TraceKernelInvalidDescriptorOperationError'
)<{
  readonly fd: number;
  readonly operation: 'read' | 'write' | 'stat' | 'truncate';
  readonly message: string;
}> {}

export type TraceKernelFileSystemErrorCode =
  | 'EACCES'
  | 'EBADF'
  | 'EBUSY'
  | 'ELOOP'
  | 'EEXIST'
  | 'EISDIR'
  | 'EINVAL'
  | 'ENOENT'
  | 'ENOTDIR'
  | 'ENOTEMPTY'
  | 'EPERM';

export class TraceKernelFileSystemError extends Data.TaggedError(
  'TraceKernelFileSystemError'
)<{
  readonly code: TraceKernelFileSystemErrorCode;
  readonly path: string;
  readonly message: string;
}> {}

export type TraceKernelLifecycleError =
  | TraceKernelHostClosedError
  | TraceKernelSessionClosedError
  | TraceKernelRuntimeUnavailableError
  | TraceKernelProcessStateError
  | TraceKernelProcessLimitError
  | TraceKernelProcessPermissionError
  | TraceKernelChildProcessError
  | TraceKernelInvalidArgumentError
  | TraceKernelBadFileDescriptorError
  | TraceKernelBrokenPipeError
  | TraceKernelDescriptorLimitError
  | TraceKernelNetworkError
  | TraceKernelInvalidDescriptorOperationError
  | TraceKernelFileSystemError
  | Error;

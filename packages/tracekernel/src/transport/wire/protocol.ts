import type {
  TraceKernelSyscallErrorCode,
  TraceKernelSyscallRequest,
} from '../../syscalls';

/**
 * Primitive framing shared by each syscall domain codec.
 *
 * This module owns only the versioned envelope, operation assignments, and
 * bounded binary reader/writer. Domain payload shapes belong to their codec.
 */
/**
 * Version of the bounded binary syscall frame used across synchronous runtime
 * worker boundaries. The low byte of every frame magic carries this value.
 */
export const TRACEKERNEL_SYSCALL_WIRE_VERSION = 1 as const;

/** Stable name for the public syscall frame contract. */
export const TRACEKERNEL_SYSCALL_WIRE_SCHEMA =
  'tracekernel.syscall.v1' as const;

export const FRAME_MAGIC =
  0x544b5300 | TRACEKERNEL_SYSCALL_WIRE_VERSION;
export const FRAME_REQUEST = 1;
export const FRAME_RESPONSE = 2;

/**
 * Append-only operation assignments for syscall wire version 1.
 *
 * Changing an existing number or payload shape requires a new wire version;
 * adding an operation appends a new number and remains discoverable here.
 */
export const TRACEKERNEL_SYSCALL_OPERATION_CODES = Object.freeze({
  open: 1,
  read: 2,
  write: 3,
  close: 4,
  dup: 5,
  stat: 6,
  readdir: 7,
  mkdir: 8,
  rmdir: 9,
  unlink: 10,
  rename: 11,
  readFile: 12,
  writeFile: 13,
  fstat: 14,
  ftruncate: 15,
  link: 16,
  symlink: 17,
  readlink: 18,
  lstat: 19,
  realpath: 20,
  socket: 21,
  bind: 22,
  listen: 23,
  accept: 24,
  connect: 25,
  send: 26,
  recv: 27,
  shutdown: 28,
  getsockname: 29,
  getpeername: 30,
  pipe: 31,
  spawn: 32,
  wait: 33,
  kill: 34,
  watch: 35,
  watchdog: 36,
  dup2: 37,
  fcntl: 38,
  setsid: 39,
  setpgid: 40,
  dup3: 41,
  poll: 42,
  getsockopt: 43,
  identity: 44,
  isatty: 45,
  tcgetpgrp: 46,
  tcsetpgrp: 47,
  seek: 48,
  processInfo: 49,
  processList: 50,
  environment: 51,
  tcgetwinsize: 52,
  tcsetwinsize: 53,
} as const satisfies Readonly<Record<TraceKernelSyscallRequest['op'], number>>);

export const OP_CODES = TRACEKERNEL_SYSCALL_OPERATION_CODES;

export type TraceKernelSyscallOperation = keyof typeof OP_CODES;

export const OPERATIONS_BY_CODE = new Map<number, TraceKernelSyscallOperation>(
  Object.entries(OP_CODES).map(([operation, code]) => [
    code,
    operation as TraceKernelSyscallOperation,
  ])
);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
export const SYSCALL_ERROR_CODES: ReadonlySet<TraceKernelSyscallErrorCode> = new Set([
  'E2BIG',
  'EAGAIN',
  'EADDRINUSE',
  'EACCES',
  'EAFNOSUPPORT',
  'EALREADY',
  'EBADF',
  'EBUSY',
  'ECHILD',
  'ELOOP',
  'ENAMETOOLONG',
  'EMFILE',
  'EEXIST',
  'ECONNREFUSED',
  'EDESTADDRREQ',
  'EINPROGRESS',
  'EISCONN',
  'EISDIR',
  'EINVAL',
  'EIO',
  'ENOENT',
  'ENOSYS',
  'ENOTDIR',
  'ENOTCONN',
  'ENOTEMPTY',
  'ENOTTY',
  'EPERM',
  'EPIPE',
  'EPROTO',
  'EOPNOTSUPP',
  'EROFS',
  'ESRCH',
]);

export type TraceKernelTransportErrorCode =
  | 'E2BIG'
  | 'EBUSY'
  | 'ECLOSED'
  | 'ENOSYS'
  | 'EPROTO'
  | 'ETIMEDOUT';

export class TraceKernelTransportError extends Error {
  readonly name = 'TraceKernelTransportError';

  constructor(
    readonly code: TraceKernelTransportErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
  }
}

export class BinaryFrameWriter {
  private bytes = new Uint8Array(256);
  private view = new DataView(this.bytes.buffer);
  private offset = 0;

  u8(value: number): void {
    this.ensure(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  u32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }

  i32(value: number): void {
    this.ensure(4);
    this.view.setInt32(this.offset, value, true);
    this.offset += 4;
  }

  f64(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }

  string(value: string): void {
    this.byteArray(textEncoder.encode(value));
  }

  byteArray(value: Uint8Array): void {
    this.u32(value.byteLength);
    this.ensure(value.byteLength);
    this.bytes.set(value, this.offset);
    this.offset += value.byteLength;
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.offset);
  }

  private ensure(additionalBytes: number): void {
    const required = this.offset + additionalBytes;
    if (required <= this.bytes.byteLength) return;
    let capacity = this.bytes.byteLength;
    while (capacity < required) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.bytes);
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }
}

export class BinaryFrameReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(): number {
    this.ensure(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u32(): number {
    this.ensure(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32(): number {
    this.ensure(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f64(): number {
    this.ensure(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  string(): string {
    return textDecoder.decode(this.byteArray());
  }

  byteArray(): Uint8Array {
    const length = this.u32();
    this.ensure(length);
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  done(): void {
    if (this.offset !== this.bytes.byteLength) {
      throw new TraceKernelTransportError(
        'EPROTO',
        `binary frame contains ${this.bytes.byteLength - this.offset} trailing bytes`
      );
    }
  }

  private ensure(length: number): void {
    if (length < 0 || this.offset + length > this.bytes.byteLength) {
      throw new TraceKernelTransportError('EPROTO', 'truncated binary syscall frame');
    }
  }
}

export function writeFramePrefix(
  writer: BinaryFrameWriter,
  kind: typeof FRAME_REQUEST | typeof FRAME_RESPONSE
): void {
  writer.u32(FRAME_MAGIC);
  writer.u8(kind);
}

export function readFramePrefix(
  reader: BinaryFrameReader,
  expectedKind: typeof FRAME_REQUEST | typeof FRAME_RESPONSE
): void {
  if (reader.u32() !== FRAME_MAGIC || reader.u8() !== expectedKind) {
    throw new TraceKernelTransportError('EPROTO', 'invalid binary syscall frame header');
  }
}

export function writeOperation(writer: BinaryFrameWriter, operation: TraceKernelSyscallOperation): void {
  writer.u8(OP_CODES[operation]);
}

export function readOperation(reader: BinaryFrameReader): TraceKernelSyscallOperation {
  const code = reader.u8();
  const operation = OPERATIONS_BY_CODE.get(code);
  if (!operation) {
    throw new TraceKernelTransportError('EPROTO', `unknown syscall operation code ${code}`);
  }
  return operation;
}

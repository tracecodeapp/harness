import * as Effect from 'effect/Effect';
import type { TraceKernelSyscallDispatcher } from './syscalls';
import type {
  TraceKernelSyscallErrorCode,
  TraceKernelSyscallRequest,
  TraceKernelSyscallResult,
  TraceKernelSyscallValue,
} from './syscalls';
import type { TraceKernelStat } from './vfs';

const FRAME_MAGIC = 0x544b5301;
const FRAME_REQUEST = 1;
const FRAME_RESPONSE = 2;

const OP_CODES = {
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
} as const satisfies Readonly<Record<TraceKernelSyscallRequest['op'], number>>;

type TraceKernelSyscallOperation = keyof typeof OP_CODES;

const OPERATIONS_BY_CODE = new Map<number, TraceKernelSyscallOperation>(
  Object.entries(OP_CODES).map(([operation, code]) => [
    code,
    operation as TraceKernelSyscallOperation,
  ])
);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const SYSCALL_ERROR_CODES: ReadonlySet<TraceKernelSyscallErrorCode> = new Set([
  'E2BIG',
  'EAGAIN',
  'EADDRINUSE',
  'EACCES',
  'EAFNOSUPPORT',
  'EBADF',
  'EBUSY',
  'ECHILD',
  'ELOOP',
  'ENAMETOOLONG',
  'EMFILE',
  'EEXIST',
  'ECONNREFUSED',
  'EDESTADDRREQ',
  'EISCONN',
  'EISDIR',
  'EINVAL',
  'EIO',
  'ENOENT',
  'ENOSYS',
  'ENOTDIR',
  'ENOTCONN',
  'ENOTEMPTY',
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

class BinaryFrameWriter {
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

class BinaryFrameReader {
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

function writeFramePrefix(
  writer: BinaryFrameWriter,
  kind: typeof FRAME_REQUEST | typeof FRAME_RESPONSE
): void {
  writer.u32(FRAME_MAGIC);
  writer.u8(kind);
}

function readFramePrefix(
  reader: BinaryFrameReader,
  expectedKind: typeof FRAME_REQUEST | typeof FRAME_RESPONSE
): void {
  if (reader.u32() !== FRAME_MAGIC || reader.u8() !== expectedKind) {
    throw new TraceKernelTransportError('EPROTO', 'invalid binary syscall frame header');
  }
}

function writeOperation(writer: BinaryFrameWriter, operation: TraceKernelSyscallOperation): void {
  writer.u8(OP_CODES[operation]);
}

function readOperation(reader: BinaryFrameReader): TraceKernelSyscallOperation {
  const code = reader.u8();
  const operation = OPERATIONS_BY_CODE.get(code);
  if (!operation) {
    throw new TraceKernelTransportError('EPROTO', `unknown syscall operation code ${code}`);
  }
  return operation;
}

function writeAddress(
  writer: BinaryFrameWriter,
  address: { readonly host: string; readonly port: number }
): void {
  writer.string(address.host);
  writer.u32(address.port);
}

function readAddress(
  reader: BinaryFrameReader
): { readonly host: string; readonly port: number } {
  return Object.freeze({
    host: reader.string(),
    port: reader.u32(),
  });
}

function writeSpawnStdioMode(
  writer: BinaryFrameWriter,
  mode: 'pipe' | 'inherit' | 'ignore' | undefined
): void {
  writer.u8(
    mode === undefined
      ? 0
      : mode === 'pipe'
        ? 1
        : mode === 'inherit'
          ? 2
          : 3
  );
}

function readSpawnStdioMode(
  reader: BinaryFrameReader
): 'pipe' | 'inherit' | 'ignore' | undefined {
  const encoded = reader.u8();
  if (encoded > 3) {
    throw new TraceKernelTransportError(
      'EPROTO',
      `invalid spawn stdio mode ${encoded}`
    );
  }
  return encoded === 0
    ? undefined
    : encoded === 1
      ? 'pipe'
      : encoded === 2
        ? 'inherit'
        : 'ignore';
}

export function encodeTraceKernelSyscallRequest(
  request: TraceKernelSyscallRequest
): Uint8Array {
  const writer = new BinaryFrameWriter();
  writeFramePrefix(writer, FRAME_REQUEST);
  writeOperation(writer, request.op);
  switch (request.op) {
    case 'pipe':
      writer.u32(request.options?.capacityChunks ?? 0);
      writer.u8(request.options?.closeOnExec === true ? 1 : 0);
      writer.u8(request.options?.nonblocking === true ? 1 : 0);
      break;
    case 'watch':
      writer.string(request.path);
      writer.u8(request.options?.recursive === true ? 1 : 0);
      writer.u32(request.options?.capacityEvents ?? 0);
      break;
    case 'watchdog':
      writer.u8(
        request.action === 'arm'
          ? 1
          : request.action === 'pet'
            ? 2
            : request.action === 'disarm'
              ? 3
              : 4
      );
      writer.u8(request.timeoutMs === undefined ? 0 : 1);
      if (request.timeoutMs !== undefined) writer.u32(request.timeoutMs);
      writer.u8(
        request.signal === undefined
          ? 0
          : request.signal === 'SIGTERM'
            ? 1
            : 2
      );
      break;
    case 'spawn': {
      writer.string(request.runtime);
      writer.string(request.command);
      writer.u32(request.args?.length ?? 0);
      for (const arg of request.args ?? []) writer.string(arg);
      writer.u8(request.cwd === undefined ? 0 : 1);
      if (request.cwd !== undefined) writer.string(request.cwd);
      const environment = Object.entries(request.env ?? {});
      writer.u32(environment.length);
      for (const [name, value] of environment) {
        writer.string(name);
        writer.string(value);
      }
      writer.u8(
        request.inheritDescriptors === 'all'
          ? 1
          : request.inheritDescriptors === undefined
            ? 0
            : 2
      );
      if (
        request.inheritDescriptors !== undefined &&
        request.inheritDescriptors !== 'all'
      ) {
        writer.u32(request.inheritDescriptors.length);
        for (const fd of request.inheritDescriptors) writer.i32(fd);
      }
      writer.u8(request.processGroupId === undefined ? 0 : 1);
      if (request.processGroupId !== undefined) writer.i32(request.processGroupId);
      writer.u8(request.sessionId === undefined ? 0 : 1);
      if (request.sessionId !== undefined) writer.i32(request.sessionId);
      writeSpawnStdioMode(writer, request.stdio?.stdin);
      writeSpawnStdioMode(writer, request.stdio?.stdout);
      writeSpawnStdioMode(writer, request.stdio?.stderr);
      writer.u32(request.descriptorActions?.length ?? 0);
      for (const action of request.descriptorActions ?? []) {
        writer.u8(action.op === 'dup2' ? 1 : 2);
        writer.i32(action.fd);
        if (action.op === 'dup2') writer.i32(action.targetFd);
      }
      writer.u32(request.descriptorMappings?.length ?? 0);
      for (const mapping of request.descriptorMappings ?? []) {
        writer.i32(mapping.parentFd);
        writer.i32(mapping.childFd);
      }
      break;
    }
    case 'wait':
      writer.i32(request.pid);
      writer.u8(request.noHang ? 1 : 0);
      break;
    case 'kill':
      writer.i32(request.pid);
      writer.u8(
        request.signal === 'SIGINT'
          ? 1
          : request.signal === 'SIGTERM'
            ? 2
            : 3
      );
      break;
    case 'setsid':
      break;
    case 'setpgid':
      writer.i32(request.pid);
      writer.i32(request.pgid);
      break;
    case 'socket':
      break;
    case 'bind':
    case 'connect':
      writer.i32(request.fd);
      writeAddress(writer, request.address);
      break;
    case 'listen':
      writer.i32(request.fd);
      writer.u8(
        (request.options?.backlog === undefined ? 0 : 1) |
        (request.options?.capacityChunks === undefined ? 0 : 2)
      );
      if (request.options?.backlog !== undefined) writer.u32(request.options.backlog);
      if (request.options?.capacityChunks !== undefined) {
        writer.u32(request.options.capacityChunks);
      }
      break;
    case 'accept':
    case 'getsockname':
    case 'getpeername':
      writer.i32(request.fd);
      break;
    case 'send':
      writer.i32(request.fd);
      writer.byteArray(request.bytes);
      break;
    case 'recv':
      writer.i32(request.fd);
      writer.u32(request.maxBytes);
      break;
    case 'shutdown':
      writer.i32(request.fd);
      writer.u8(request.how === 'read' ? 1 : request.how === 'write' ? 2 : 3);
      break;
    case 'open': {
      writer.string(request.path);
      const access = request.options?.access === 'write'
        ? 2
        : request.options?.access === 'read-write'
          ? 3
          : request.options?.access === 'read'
            ? 1
            : 0;
      writer.u8(access);
      writer.u8(
        (request.options?.create ? 1 : 0) |
        (request.options?.exclusive ? 2 : 0) |
        (request.options?.truncate ? 4 : 0) |
        (request.options?.append ? 8 : 0)
      );
      break;
    }
    case 'read':
      writer.i32(request.fd);
      writer.u32(request.maxBytes);
      writer.u8(request.position === undefined ? 0 : 1);
      if (request.position !== undefined) writer.f64(request.position);
      break;
    case 'write':
      writer.i32(request.fd);
      writer.byteArray(request.bytes);
      writer.u8(request.position === undefined ? 0 : 1);
      if (request.position !== undefined) writer.f64(request.position);
      break;
    case 'close':
    case 'dup':
    case 'fstat':
      writer.i32(request.fd);
      break;
    case 'dup2':
      writer.i32(request.fd);
      writer.i32(request.targetFd);
      break;
    case 'dup3':
      writer.i32(request.fd);
      writer.i32(request.targetFd);
      writer.u8(request.closeOnExec ? 1 : 0);
      break;
    case 'fcntl':
      writer.i32(request.fd);
      writer.u8(
        request.action === 'get-close-on-exec'
          ? 1
          : request.action === 'set-close-on-exec'
            ? 2
            : request.action === 'get-nonblocking'
              ? 3
              : 4
      );
      if (request.action === 'set-close-on-exec') {
        writer.u8(request.closeOnExec ? 1 : 0);
      } else if (request.action === 'set-nonblocking') {
        writer.u8(request.nonblocking ? 1 : 0);
      }
      break;
    case 'ftruncate':
      writer.i32(request.fd);
      writer.f64(request.length);
      break;
    case 'stat':
    case 'lstat':
    case 'realpath':
    case 'readdir':
    case 'rmdir':
    case 'unlink':
    case 'readFile':
      writer.string(request.path);
      break;
    case 'mkdir':
      writer.string(request.path);
      writer.u8(
        (request.options?.recursive ? 1 : 0) |
        (request.options?.mode === undefined ? 0 : 2)
      );
      if (request.options?.mode !== undefined) writer.u32(request.options.mode);
      break;
    case 'rename':
      writer.string(request.sourcePath);
      writer.string(request.destinationPath);
      break;
    case 'link':
      writer.string(request.existingPath);
      writer.string(request.newPath);
      break;
    case 'symlink':
      writer.string(request.target);
      writer.string(request.linkPath);
      break;
    case 'readlink':
      writer.string(request.path);
      break;
    case 'writeFile':
      writer.string(request.path);
      writer.byteArray(request.bytes);
      break;
  }
  return writer.finish();
}

export function decodeTraceKernelSyscallRequest(
  bytes: Uint8Array
): TraceKernelSyscallRequest {
  const reader = new BinaryFrameReader(bytes);
  readFramePrefix(reader, FRAME_REQUEST);
  const operation = readOperation(reader);
  let request: TraceKernelSyscallRequest;
  switch (operation) {
    case 'pipe': {
      const capacityChunks = reader.u32();
      const closeOnExec = reader.u8();
      const nonblocking = reader.u8();
      if (closeOnExec > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          'Invalid pipe close-on-exec flag'
        );
      }
      if (nonblocking > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          'Invalid pipe nonblocking flag'
        );
      }
      request = {
        op: 'pipe',
        ...(capacityChunks === 0 && closeOnExec === 0 && nonblocking === 0
          ? {}
          : {
              options: {
                ...(capacityChunks === 0 ? {} : { capacityChunks }),
                ...(closeOnExec === 1 ? { closeOnExec: true } : {}),
                ...(nonblocking === 1 ? { nonblocking: true } : {}),
              },
            }),
      };
      break;
    }
    case 'watch': {
      const path = reader.string();
      const recursive = reader.u8();
      if (recursive > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid watch recursive flag ${recursive}`
        );
      }
      const capacityEvents = reader.u32();
      request = {
        op: 'watch',
        path,
        ...(!recursive && capacityEvents === 0
          ? {}
          : {
              options: {
                ...(recursive ? { recursive: true } : {}),
                ...(capacityEvents === 0 ? {} : { capacityEvents }),
              },
            }),
      };
      break;
    }
    case 'watchdog': {
      const actionCode = reader.u8();
      if (actionCode < 1 || actionCode > 4) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid watchdog action ${actionCode}`
        );
      }
      const hasTimeout = reader.u8();
      if (hasTimeout > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid watchdog timeout flag ${hasTimeout}`
        );
      }
      const timeoutMs = hasTimeout ? reader.u32() : undefined;
      const signalCode = reader.u8();
      if (signalCode > 2) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid watchdog signal ${signalCode}`
        );
      }
      request = {
        op: 'watchdog',
        action: actionCode === 1
          ? 'arm'
          : actionCode === 2
            ? 'pet'
            : actionCode === 3
              ? 'disarm'
              : 'status',
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(signalCode === 0
          ? {}
          : { signal: signalCode === 1 ? 'SIGTERM' : 'SIGKILL' }),
      };
      break;
    }
    case 'spawn': {
      const runtime = reader.string();
      const command = reader.string();
      const argsLength = reader.u32();
      const args: string[] = [];
      for (let index = 0; index < argsLength; index += 1) {
        args.push(reader.string());
      }
      const hasCwd = reader.u8();
      if (hasCwd > 1) {
        throw new TraceKernelTransportError('EPROTO', `invalid spawn cwd flag ${hasCwd}`);
      }
      const cwd = hasCwd ? reader.string() : undefined;
      const environmentLength = reader.u32();
      const env: Record<string, string> = {};
      for (let index = 0; index < environmentLength; index += 1) {
        env[reader.string()] = reader.string();
      }
      const inheritance = reader.u8();
      if (inheritance > 2) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid descriptor inheritance mode ${inheritance}`
        );
      }
      let inheritDescriptors: 'all' | readonly number[] | undefined;
      if (inheritance === 1) {
        inheritDescriptors = 'all';
      } else if (inheritance === 2) {
        const descriptorCount = reader.u32();
        const descriptors: number[] = [];
        for (let index = 0; index < descriptorCount; index += 1) {
          descriptors.push(reader.i32());
        }
        inheritDescriptors = Object.freeze(descriptors);
      }
      const hasProcessGroupId = reader.u8();
      if (hasProcessGroupId > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid spawn process-group flag ${hasProcessGroupId}`
        );
      }
      const processGroupId = hasProcessGroupId ? reader.i32() : undefined;
      const hasSessionId = reader.u8();
      if (hasSessionId > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid spawn session flag ${hasSessionId}`
        );
      }
      const sessionId = hasSessionId ? reader.i32() : undefined;
      const stdin = readSpawnStdioMode(reader);
      const stdout = readSpawnStdioMode(reader);
      const stderr = readSpawnStdioMode(reader);
      const stdio = stdin === undefined && stdout === undefined && stderr === undefined
        ? undefined
        : Object.freeze({
            ...(stdin === undefined ? {} : { stdin }),
            ...(stdout === undefined ? {} : { stdout }),
            ...(stderr === undefined ? {} : { stderr }),
          });
      const descriptorActionCount = reader.u32();
      const descriptorActions: Array<
        NonNullable<Extract<TraceKernelSyscallRequest, { op: 'spawn' }>['descriptorActions']>[number]
      > = [];
      for (let index = 0; index < descriptorActionCount; index += 1) {
        const action = reader.u8();
        const fd = reader.i32();
        if (action === 1) {
          descriptorActions.push({ op: 'dup2', fd, targetFd: reader.i32() });
        } else if (action === 2) {
          descriptorActions.push({ op: 'close', fd });
        } else {
          throw new TraceKernelTransportError(
            'EPROTO',
            `invalid spawn descriptor action ${action}`
          );
        }
      }
      const descriptorMappingCount = reader.u32();
      const descriptorMappings: Array<
        NonNullable<Extract<TraceKernelSyscallRequest, { op: 'spawn' }>['descriptorMappings']>[number]
      > = [];
      for (let index = 0; index < descriptorMappingCount; index += 1) {
        descriptorMappings.push({
          parentFd: reader.i32(),
          childFd: reader.i32(),
        });
      }
      request = {
        op: 'spawn',
        runtime,
        command,
        ...(args.length === 0 ? {} : { args: Object.freeze(args) }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(environmentLength === 0 ? {} : { env: Object.freeze(env) }),
        ...(inheritDescriptors === undefined ? {} : { inheritDescriptors }),
        ...(processGroupId === undefined ? {} : { processGroupId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(stdio === undefined ? {} : { stdio }),
        ...(descriptorActions.length === 0
          ? {}
          : { descriptorActions: Object.freeze(descriptorActions) }),
        ...(descriptorMappings.length === 0
          ? {}
          : { descriptorMappings: Object.freeze(descriptorMappings) }),
      };
      break;
    }
    case 'wait': {
      const pid = reader.i32();
      const noHang = reader.u8();
      if (noHang > 1) {
        throw new TraceKernelTransportError('EPROTO', `invalid wait no-hang flag ${noHang}`);
      }
      request = { op: 'wait', pid, ...(noHang ? { noHang: true } : {}) };
      break;
    }
    case 'kill': {
      const pid = reader.i32();
      const signalCode = reader.u8();
      if (signalCode < 1 || signalCode > 3) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid signal code ${signalCode}`
        );
      }
      request = {
        op: 'kill',
        pid,
        signal: signalCode === 1
          ? 'SIGINT'
          : signalCode === 2
            ? 'SIGTERM'
            : 'SIGKILL',
      };
      break;
    }
    case 'setsid':
      request = { op: 'setsid' };
      break;
    case 'setpgid':
      request = { op: 'setpgid', pid: reader.i32(), pgid: reader.i32() };
      break;
    case 'socket':
      request = { op: 'socket' };
      break;
    case 'bind':
    case 'connect':
      request = {
        op: operation,
        fd: reader.i32(),
        address: readAddress(reader),
      };
      break;
    case 'listen': {
      const fd = reader.i32();
      const flags = reader.u8();
      if (flags > 3) {
        throw new TraceKernelTransportError('EPROTO', `invalid listen flags ${flags}`);
      }
      request = {
        op: 'listen',
        fd,
        options: {
          ...(flags & 1 ? { backlog: reader.u32() } : {}),
          ...(flags & 2 ? { capacityChunks: reader.u32() } : {}),
        },
      };
      break;
    }
    case 'accept':
    case 'getsockname':
    case 'getpeername':
      request = { op: operation, fd: reader.i32() };
      break;
    case 'send':
      request = { op: 'send', fd: reader.i32(), bytes: reader.byteArray() };
      break;
    case 'recv':
      request = { op: 'recv', fd: reader.i32(), maxBytes: reader.u32() };
      break;
    case 'shutdown': {
      const fd = reader.i32();
      const howCode = reader.u8();
      if (howCode < 1 || howCode > 3) {
        throw new TraceKernelTransportError('EPROTO', `invalid shutdown mode ${howCode}`);
      }
      request = {
        op: 'shutdown',
        fd,
        how: howCode === 1 ? 'read' : howCode === 2 ? 'write' : 'both',
      };
      break;
    }
    case 'open': {
      const path = reader.string();
      const accessCode = reader.u8();
      const flags = reader.u8();
      const access = accessCode === 1
        ? 'read' as const
        : accessCode === 2
          ? 'write' as const
          : accessCode === 3
            ? 'read-write' as const
            : undefined;
      if (accessCode > 3) {
        throw new TraceKernelTransportError('EPROTO', `invalid open access code ${accessCode}`);
      }
      request = {
        op: 'open',
        path,
        options: {
          ...(access ? { access } : {}),
          ...(flags & 1 ? { create: true } : {}),
          ...(flags & 2 ? { exclusive: true } : {}),
          ...(flags & 4 ? { truncate: true } : {}),
          ...(flags & 8 ? { append: true } : {}),
        },
      };
      break;
    }
    case 'read': {
      const fd = reader.i32();
      const maxBytes = reader.u32();
      const hasPosition = reader.u8();
      if (hasPosition > 1) {
        throw new TraceKernelTransportError('EPROTO', `invalid read position flag ${hasPosition}`);
      }
      request = {
        op: 'read',
        fd,
        maxBytes,
        ...(hasPosition ? { position: reader.f64() } : {}),
      };
      break;
    }
    case 'write': {
      const fd = reader.i32();
      const payload = reader.byteArray();
      const hasPosition = reader.u8();
      if (hasPosition > 1) {
        throw new TraceKernelTransportError('EPROTO', `invalid write position flag ${hasPosition}`);
      }
      request = {
        op: 'write',
        fd,
        bytes: payload,
        ...(hasPosition ? { position: reader.f64() } : {}),
      };
      break;
    }
    case 'close':
      request = { op: 'close', fd: reader.i32() };
      break;
    case 'dup':
      request = { op: 'dup', fd: reader.i32() };
      break;
    case 'dup2':
      request = { op: 'dup2', fd: reader.i32(), targetFd: reader.i32() };
      break;
    case 'dup3': {
      const fd = reader.i32();
      const targetFd = reader.i32();
      const closeOnExec = reader.u8();
      if (closeOnExec > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          'Invalid dup3 close-on-exec flag'
        );
      }
      request = { op: 'dup3', fd, targetFd, closeOnExec: closeOnExec === 1 };
      break;
    }
    case 'fcntl': {
      const fd = reader.i32();
      const action = reader.u8();
      if (action === 1) {
        request = { op: 'fcntl', fd, action: 'get-close-on-exec' };
      } else if (action === 2) {
        const closeOnExec = reader.u8();
        if (closeOnExec > 1) {
          throw new TraceKernelTransportError(
            'EPROTO',
            `invalid close-on-exec flag ${closeOnExec}`
          );
        }
        request = {
          op: 'fcntl',
          fd,
          action: 'set-close-on-exec',
          closeOnExec: closeOnExec === 1,
        };
      } else if (action === 3) {
        request = { op: 'fcntl', fd, action: 'get-nonblocking' };
      } else if (action === 4) {
        const nonblocking = reader.u8();
        if (nonblocking > 1) {
          throw new TraceKernelTransportError(
            'EPROTO',
            `invalid nonblocking flag ${nonblocking}`
          );
        }
        request = {
          op: 'fcntl',
          fd,
          action: 'set-nonblocking',
          nonblocking: nonblocking === 1,
        };
      } else {
        throw new TraceKernelTransportError('EPROTO', `invalid fcntl action ${action}`);
      }
      break;
    }
    case 'fstat':
      request = { op: 'fstat', fd: reader.i32() };
      break;
    case 'ftruncate':
      request = { op: 'ftruncate', fd: reader.i32(), length: reader.f64() };
      break;
    case 'stat':
    case 'lstat':
    case 'realpath':
    case 'readdir':
    case 'rmdir':
    case 'unlink':
    case 'readFile':
      request = { op: operation, path: reader.string() };
      break;
    case 'mkdir': {
      const path = reader.string();
      const flags = reader.u8();
      request = {
        op: 'mkdir',
        path,
        options: {
          ...(flags & 1 ? { recursive: true } : {}),
          ...(flags & 2 ? { mode: reader.u32() } : {}),
        },
      };
      break;
    }
    case 'rename':
      request = {
        op: 'rename',
        sourcePath: reader.string(),
        destinationPath: reader.string(),
      };
      break;
    case 'link':
      request = {
        op: 'link',
        existingPath: reader.string(),
        newPath: reader.string(),
      };
      break;
    case 'symlink':
      request = {
        op: 'symlink',
        target: reader.string(),
        linkPath: reader.string(),
      };
      break;
    case 'readlink':
      request = { op: 'readlink', path: reader.string() };
      break;
    case 'writeFile':
      request = {
        op: 'writeFile',
        path: reader.string(),
        bytes: reader.byteArray(),
      };
      break;
  }
  reader.done();
  return request;
}

function writeStat(
  writer: BinaryFrameWriter,
  stat: Extract<TraceKernelSyscallValue, { op: 'stat' }>['stat']
): void {
  writer.string(stat.path);
  writer.u8(stat.kind === 'file' ? 1 : stat.kind === 'directory' ? 2 : 3);
  writer.f64(stat.inode);
  writer.f64(stat.nlink);
  writer.u32(stat.mode);
  writer.f64(stat.size);
  writer.f64(stat.generation);
  writer.f64(stat.createdAt);
  writer.f64(stat.modifiedAt);
  writer.f64(stat.changedAt);
}

function readStat(
  reader: BinaryFrameReader
): Extract<TraceKernelSyscallValue, { op: 'stat' }>['stat'] {
  const path = reader.string();
  const kindCode = reader.u8();
  if (kindCode !== 1 && kindCode !== 2 && kindCode !== 3) {
    throw new TraceKernelTransportError('EPROTO', `invalid stat kind ${kindCode}`);
  }
  return Object.freeze({
    path,
    kind: kindCode === 1
      ? 'file' as const
      : kindCode === 2
        ? 'directory' as const
        : 'symlink' as const,
    inode: reader.f64(),
    nlink: reader.f64(),
    mode: reader.u32(),
    size: reader.f64(),
    generation: reader.f64(),
    createdAt: reader.f64(),
    modifiedAt: reader.f64(),
    changedAt: reader.f64(),
  });
}

export function encodeTraceKernelSyscallResult(
  result: TraceKernelSyscallResult
): Uint8Array {
  const writer = new BinaryFrameWriter();
  writeFramePrefix(writer, FRAME_RESPONSE);
  writer.u8(result.ok ? 1 : 0);
  if (!result.ok) {
    writer.string(result.error.code);
    writer.string(result.error.message);
    return writer.finish();
  }

  writeOperation(writer, result.value.op);
  const value = result.value;
  switch (value.op) {
    case 'pipe':
      writer.i32(value.readFd);
      writer.i32(value.writeFd);
      break;
    case 'watch':
      writer.i32(value.fd);
      break;
    case 'watchdog':
      writer.u8(value.armed ? 1 : 0);
      if (value.armed) {
        writer.u32(value.timeoutMs!);
        writer.f64(value.deadlineAt!);
        writer.u8(value.signal === 'SIGKILL' ? 2 : 1);
      }
      break;
    case 'spawn':
      writer.i32(value.pid);
      writer.u8(value.stdio?.stdinFd === undefined ? 0 : 1);
      if (value.stdio?.stdinFd !== undefined) writer.i32(value.stdio.stdinFd);
      writer.u8(value.stdio?.stdoutFd === undefined ? 0 : 1);
      if (value.stdio?.stdoutFd !== undefined) writer.i32(value.stdio.stdoutFd);
      writer.u8(value.stdio?.stderrFd === undefined ? 0 : 1);
      if (value.stdio?.stderrFd !== undefined) writer.i32(value.stdio.stderrFd);
      break;
    case 'wait':
      writer.i32(value.pid);
      writer.u8(value.termination === undefined ? 0 : 1);
      if (value.termination === undefined) break;
      writer.u8(
        value.termination.kind === 'exit'
          ? 1
          : value.termination.kind === 'signal'
            ? 2
            : 3
      );
      writer.i32(value.termination.exitCode);
      if (value.termination.kind === 'signal') {
        writer.u8(
          value.termination.signal === 'SIGINT'
            ? 1
            : value.termination.signal === 'SIGTERM'
              ? 2
              : 3
        );
      } else if (value.termination.kind === 'failure') {
        writer.string(value.termination.message);
      }
      break;
    case 'socket':
    case 'open':
    case 'dup':
    case 'dup2':
      writer.i32(value.fd);
      break;
    case 'dup3':
      writer.i32(value.fd);
      writer.u8(value.closeOnExec ? 1 : 0);
      break;
    case 'fcntl':
      writer.u8(value.closeOnExec ? 1 : 0);
      writer.u8(value.nonblocking ? 1 : 0);
      break;
    case 'setsid':
      writer.i32(value.sid);
      writer.i32(value.pgid);
      break;
    case 'setpgid':
      writer.i32(value.pgid);
      break;
    case 'bind':
      writeAddress(writer, value.address);
      break;
    case 'accept':
      writer.i32(value.fd);
      writeAddress(writer, value.localAddress);
      writeAddress(writer, value.remoteAddress);
      break;
    case 'connect':
      writeAddress(writer, value.localAddress);
      writeAddress(writer, value.remoteAddress);
      break;
    case 'send':
      writer.u32(value.bytesWritten);
      break;
    case 'recv':
      writer.byteArray(value.bytes);
      break;
    case 'getsockname':
    case 'getpeername':
      writeAddress(writer, value.address);
      break;
    case 'read':
      writer.byteArray(value.bytes);
      break;
    case 'write':
      writer.u32(value.bytesWritten);
      break;
    case 'stat':
    case 'lstat':
    case 'fstat':
      writeStat(writer, value.stat);
      break;
    case 'realpath':
      writer.string(value.path);
      break;
    case 'readlink':
      writer.string(value.target);
      break;
    case 'readdir':
      writer.u32(value.entries.length);
      for (const entry of value.entries) {
        writer.string(entry.name);
        writer.u8(entry.kind === 'file' ? 1 : entry.kind === 'directory' ? 2 : 3);
        writer.f64(entry.inode);
      }
      break;
    case 'readFile':
      writer.i32(value.cacheGeneration);
      writer.byteArray(value.bytes);
      break;
    case 'close':
    case 'kill':
    case 'listen':
    case 'shutdown':
    case 'mkdir':
    case 'rmdir':
    case 'unlink':
    case 'link':
    case 'symlink':
    case 'rename':
    case 'writeFile':
    case 'ftruncate':
      break;
  }
  return writer.finish();
}

export function decodeTraceKernelSyscallResult(
  bytes: Uint8Array
): TraceKernelSyscallResult {
  const reader = new BinaryFrameReader(bytes);
  readFramePrefix(reader, FRAME_RESPONSE);
  const success = reader.u8();
  if (success > 1) {
    throw new TraceKernelTransportError('EPROTO', `invalid syscall result status ${success}`);
  }
  if (success === 0) {
    const code = reader.string() as TraceKernelSyscallErrorCode;
    if (!SYSCALL_ERROR_CODES.has(code)) {
      throw new TraceKernelTransportError('EPROTO', `unknown syscall error code ${code}`);
    }
    const result: TraceKernelSyscallResult = {
      ok: false,
      error: {
        code,
        message: reader.string(),
      },
    };
    reader.done();
    return result;
  }

  const operation = readOperation(reader);
  let value: TraceKernelSyscallValue;
  switch (operation) {
    case 'pipe':
      value = {
        op: 'pipe',
        readFd: reader.i32(),
        writeFd: reader.i32(),
      };
      break;
    case 'watch':
      value = { op: 'watch', fd: reader.i32() };
      break;
    case 'watchdog': {
      const armed = reader.u8();
      if (armed > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid watchdog armed flag ${armed}`
        );
      }
      if (!armed) {
        value = { op: 'watchdog', armed: false };
        break;
      }
      const timeoutMs = reader.u32();
      const deadlineAt = reader.f64();
      const signalCode = reader.u8();
      if (signalCode !== 1 && signalCode !== 2) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid watchdog response signal ${signalCode}`
        );
      }
      value = {
        op: 'watchdog',
        armed: true,
        timeoutMs,
        deadlineAt,
        signal: signalCode === 2 ? 'SIGKILL' : 'SIGTERM',
      };
      break;
    }
    case 'spawn': {
      const pid = reader.i32();
      const hasStdin = reader.u8();
      if (hasStdin > 1) {
        throw new TraceKernelTransportError('EPROTO', `invalid spawn stdin fd flag ${hasStdin}`);
      }
      const stdinFd = hasStdin ? reader.i32() : undefined;
      const hasStdout = reader.u8();
      if (hasStdout > 1) {
        throw new TraceKernelTransportError('EPROTO', `invalid spawn stdout fd flag ${hasStdout}`);
      }
      const stdoutFd = hasStdout ? reader.i32() : undefined;
      const hasStderr = reader.u8();
      if (hasStderr > 1) {
        throw new TraceKernelTransportError('EPROTO', `invalid spawn stderr fd flag ${hasStderr}`);
      }
      const stderrFd = hasStderr ? reader.i32() : undefined;
      const stdio = stdinFd === undefined && stdoutFd === undefined && stderrFd === undefined
        ? undefined
        : Object.freeze({
            ...(stdinFd === undefined ? {} : { stdinFd }),
            ...(stdoutFd === undefined ? {} : { stdoutFd }),
            ...(stderrFd === undefined ? {} : { stderrFd }),
          });
      value = {
        op: 'spawn',
        pid,
        ...(stdio === undefined ? {} : { stdio }),
      };
      break;
    }
    case 'wait': {
      const pid = reader.i32();
      const completed = reader.u8();
      if (completed > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid wait completion flag ${completed}`
        );
      }
      if (!completed) {
        value = { op: 'wait', pid };
        break;
      }
      const terminationCode = reader.u8();
      if (terminationCode < 1 || terminationCode > 3) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid process termination code ${terminationCode}`
        );
      }
      const exitCode = reader.i32();
      if (terminationCode === 1) {
        value = {
          op: 'wait',
          pid,
          termination: { kind: 'exit', exitCode },
        };
      } else if (terminationCode === 2) {
        const signalCode = reader.u8();
        if (signalCode < 1 || signalCode > 3) {
          throw new TraceKernelTransportError(
            'EPROTO',
            `invalid termination signal code ${signalCode}`
          );
        }
        value = {
          op: 'wait',
          pid,
          termination: {
            kind: 'signal',
            signal: signalCode === 1
              ? 'SIGINT'
              : signalCode === 2
                ? 'SIGTERM'
                : 'SIGKILL',
            exitCode,
          },
        };
      } else {
        value = {
          op: 'wait',
          pid,
          termination: {
            kind: 'failure',
            exitCode,
            message: reader.string(),
          },
        };
      }
      break;
    }
    case 'socket':
    case 'open':
    case 'dup':
    case 'dup2':
      value = { op: operation, fd: reader.i32() };
      break;
    case 'dup3': {
      const fd = reader.i32();
      const closeOnExec = reader.u8();
      if (closeOnExec > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          'Invalid dup3 close-on-exec result'
        );
      }
      value = { op: 'dup3', fd, closeOnExec: closeOnExec === 1 };
      break;
    }
    case 'fcntl': {
      const closeOnExec = reader.u8();
      const nonblocking = reader.u8();
      if (closeOnExec > 1 || nonblocking > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid descriptor flag result ${closeOnExec}:${nonblocking}`
        );
      }
      value = {
        op: 'fcntl',
        closeOnExec: closeOnExec === 1,
        nonblocking: nonblocking === 1,
      };
      break;
    }
    case 'setsid':
      value = { op: 'setsid', sid: reader.i32(), pgid: reader.i32() };
      break;
    case 'setpgid':
      value = { op: 'setpgid', pgid: reader.i32() };
      break;
    case 'bind':
      value = { op: 'bind', address: readAddress(reader) };
      break;
    case 'accept':
      value = {
        op: 'accept',
        fd: reader.i32(),
        localAddress: readAddress(reader),
        remoteAddress: readAddress(reader),
      };
      break;
    case 'connect':
      value = {
        op: 'connect',
        localAddress: readAddress(reader),
        remoteAddress: readAddress(reader),
      };
      break;
    case 'send':
      value = { op: 'send', bytesWritten: reader.u32() };
      break;
    case 'recv':
      value = { op: 'recv', bytes: reader.byteArray() };
      break;
    case 'getsockname':
    case 'getpeername':
      value = { op: operation, address: readAddress(reader) };
      break;
    case 'read':
      value = { op: 'read', bytes: reader.byteArray() };
      break;
    case 'write':
      value = { op: 'write', bytesWritten: reader.u32() };
      break;
    case 'stat':
      value = { op: 'stat', stat: readStat(reader) };
      break;
    case 'lstat':
      value = { op: 'lstat', stat: readStat(reader) };
      break;
    case 'fstat':
      value = { op: 'fstat', stat: readStat(reader) };
      break;
    case 'realpath':
      value = { op: 'realpath', path: reader.string() };
      break;
    case 'readlink':
      value = { op: 'readlink', target: reader.string() };
      break;
    case 'readdir': {
      const length = reader.u32();
      const entries: Array<{
        readonly name: string;
        readonly kind: 'file' | 'directory' | 'symlink';
        readonly inode: number;
      }> = [];
      for (let index = 0; index < length; index += 1) {
        const name = reader.string();
        const kindCode = reader.u8();
        if (kindCode !== 1 && kindCode !== 2 && kindCode !== 3) {
          throw new TraceKernelTransportError('EPROTO', `invalid directory entry kind ${kindCode}`);
        }
        entries.push(Object.freeze({
          name,
          kind: kindCode === 1 ? 'file' : kindCode === 2 ? 'directory' : 'symlink',
          inode: reader.f64(),
        }));
      }
      value = { op: 'readdir', entries: Object.freeze(entries) };
      break;
    }
    case 'readFile':
      value = {
        op: 'readFile',
        cacheGeneration: reader.i32(),
        bytes: reader.byteArray(),
      };
      break;
    case 'close':
    case 'kill':
    case 'listen':
    case 'shutdown':
    case 'mkdir':
    case 'rmdir':
    case 'unlink':
    case 'link':
    case 'symlink':
    case 'rename':
    case 'writeFile':
    case 'ftruncate':
      value = { op: operation };
      break;
  }
  reader.done();
  return { ok: true, value };
}

const SHARED_HEADER_INTS = 8;
const SHARED_HEADER_BYTES = SHARED_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
const STATE_INDEX = 0;
const REQUEST_LENGTH_INDEX = 1;
const RESPONSE_LENGTH_INDEX = 2;
const SEQUENCE_INDEX = 3;

const STATE_IDLE = 0;
const STATE_REQUEST = 1;
const STATE_PROCESSING = 2;
const STATE_RESPONSE = 3;
const STATE_CLOSED = 4;
const STATE_WRITING = 5;

export interface TraceKernelSharedSyscallChannel {
  readonly buffer: SharedArrayBuffer;
  readonly byteCapacity: number;
}

export interface TraceKernelSharedSyscallChannelOptions {
  readonly byteCapacity?: number;
}

export function makeTraceKernelSharedSyscallChannel(
  options: TraceKernelSharedSyscallChannelOptions = {}
): TraceKernelSharedSyscallChannel {
  if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') {
    throw new TraceKernelTransportError(
      'ENOSYS',
      'SharedArrayBuffer and Atomics are required for synchronous syscalls'
    );
  }
  const byteCapacity = Math.max(256, Math.floor(options.byteCapacity ?? 1024 * 1024));
  return Object.freeze({
    buffer: new SharedArrayBuffer(SHARED_HEADER_BYTES + byteCapacity),
    byteCapacity,
  });
}

function validateSharedChannel(
  channel: TraceKernelSharedSyscallChannel
): {
  readonly header: Int32Array;
  readonly payload: Uint8Array;
} {
  if (
    !(channel.buffer instanceof SharedArrayBuffer) ||
    channel.byteCapacity < 256 ||
    channel.buffer.byteLength !== SHARED_HEADER_BYTES + channel.byteCapacity
  ) {
    throw new TraceKernelTransportError('EPROTO', 'invalid shared syscall channel');
  }
  return {
    header: new Int32Array(channel.buffer, 0, SHARED_HEADER_INTS),
    payload: new Uint8Array(channel.buffer, SHARED_HEADER_BYTES),
  };
}

export interface TraceKernelSyncSyscallTransport {
  dispatchSync(request: TraceKernelSyscallRequest): TraceKernelSyscallResult;
}

export interface TraceKernelSharedSyscallClientOptions {
  readonly timeoutMs?: number;
}

export interface TraceKernelSyscallHandler {
  dispatch(request: TraceKernelSyscallRequest): Effect.Effect<TraceKernelSyscallResult>;
}

export function makeTraceKernelPromiseSyscallHandler(
  dispatch: (request: TraceKernelSyscallRequest) => Promise<TraceKernelSyscallResult>
): TraceKernelSyscallHandler {
  return {
    dispatch: (request) => Effect.promise(() => dispatch(request)),
  };
}

/**
 * Dedicated-worker synchronous syscall client.
 *
 * `signalHost` should post a small notification over MessagePort. Request and
 * response bodies stay in the bounded binary SharedArrayBuffer frame.
 */
export class TraceKernelSharedSyscallClient implements TraceKernelSyncSyscallTransport {
  private readonly header: Int32Array;
  private readonly payload: Uint8Array;
  private readonly timeoutMs: number;
  private closed = false;
  private callCount = 0;

  constructor(
    readonly channel: TraceKernelSharedSyscallChannel,
    private readonly signalHost: () => void,
    options: TraceKernelSharedSyscallClientOptions = {}
  ) {
    const views = validateSharedChannel(channel);
    this.header = views.header;
    this.payload = views.payload;
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 20_000));
  }

  get calls(): number {
    return this.callCount;
  }

  dispatchSync(request: TraceKernelSyscallRequest): TraceKernelSyscallResult {
    if (this.closed) {
      throw new TraceKernelTransportError('ECLOSED', 'shared syscall channel is closed');
    }
    const frame = encodeTraceKernelSyscallRequest(request);
    if (frame.byteLength > this.payload.byteLength) {
      throw new TraceKernelTransportError(
        'E2BIG',
        `request frame requires ${frame.byteLength} bytes; capacity is ${this.payload.byteLength}`
      );
    }
    if (
      Atomics.compareExchange(
        this.header,
        STATE_INDEX,
        STATE_IDLE,
        STATE_WRITING
      ) !== STATE_IDLE
    ) {
      if (Atomics.load(this.header, STATE_INDEX) === STATE_CLOSED) {
        this.closed = true;
        throw new TraceKernelTransportError('ECLOSED', 'shared syscall channel is closed');
      }
      throw new TraceKernelTransportError('EBUSY', 'shared syscall channel already has an active call');
    }

    this.payload.set(frame);
    Atomics.store(this.header, REQUEST_LENGTH_INDEX, frame.byteLength);
    Atomics.store(this.header, RESPONSE_LENGTH_INDEX, 0);
    Atomics.add(this.header, SEQUENCE_INDEX, 1);
    Atomics.store(this.header, STATE_INDEX, STATE_REQUEST);
    this.callCount += 1;
    try {
      this.signalHost();
    } catch (error) {
      Atomics.store(this.header, STATE_INDEX, STATE_IDLE);
      throw error;
    }

    const startedAt = Date.now();
    while (true) {
      const state = Atomics.load(this.header, STATE_INDEX);
      if (state === STATE_RESPONSE) break;
      if (state === STATE_CLOSED) {
        this.closed = true;
        throw new TraceKernelTransportError('ECLOSED', 'shared syscall channel closed while waiting');
      }
      const remaining = this.timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        this.close();
        throw new TraceKernelTransportError('ETIMEDOUT', 'synchronous syscall timed out');
      }
      try {
        Atomics.wait(this.header, STATE_INDEX, state, remaining);
      } catch {
        this.close();
        throw new TraceKernelTransportError(
          'ENOSYS',
          'synchronous Atomics.wait is only available in a dedicated worker'
        );
      }
    }

    const responseLength = Atomics.load(this.header, RESPONSE_LENGTH_INDEX);
    if (responseLength < 0 || responseLength > this.payload.byteLength) {
      this.close();
      throw new TraceKernelTransportError('EPROTO', 'host returned an invalid response length');
    }
    const responseFrame = this.payload.slice(0, responseLength);
    Atomics.store(this.header, REQUEST_LENGTH_INDEX, 0);
    Atomics.store(this.header, RESPONSE_LENGTH_INDEX, 0);
    Atomics.store(this.header, STATE_INDEX, STATE_IDLE);
    Atomics.notify(this.header, STATE_INDEX);
    return decodeTraceKernelSyscallResult(responseFrame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    Atomics.store(this.header, STATE_INDEX, STATE_CLOSED);
    Atomics.notify(this.header, STATE_INDEX);
  }
}

/**
 * Host-side channel service. The embedding worker bridge invokes `service`
 * after receiving the client's lightweight request notification.
 */
export class TraceKernelSharedSyscallServer {
  private readonly header: Int32Array;
  private readonly payload: Uint8Array;

  constructor(
    readonly channel: TraceKernelSharedSyscallChannel,
    private readonly dispatcher: TraceKernelSyscallHandler | TraceKernelSyscallDispatcher
  ) {
    const views = validateSharedChannel(channel);
    this.header = views.header;
    this.payload = views.payload;
  }

  service(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (
        Atomics.compareExchange(
          this.header,
          STATE_INDEX,
          STATE_REQUEST,
          STATE_PROCESSING
        ) !== STATE_REQUEST
      ) {
        return Effect.void;
      }
      const requestLength = Atomics.load(this.header, REQUEST_LENGTH_INDEX);
      if (requestLength < 0 || requestLength > this.payload.byteLength) {
        return Effect.sync(() => this.complete(this.protocolFailure(
          'EPROTO',
          'worker supplied an invalid request length'
        )));
      }

      let request: TraceKernelSyscallRequest;
      try {
        request = decodeTraceKernelSyscallRequest(
          this.payload.slice(0, requestLength)
        );
      } catch (error) {
        return Effect.sync(() => this.complete(this.protocolFailure(
          'EPROTO',
          error instanceof Error ? error.message : String(error)
        )));
      }
      return this.dispatcher.dispatch(request).pipe(
        Effect.tap((result) => Effect.sync(() => this.complete(result))),
        Effect.asVoid
      );
    });
  }

  servicePromise(): Promise<void> {
    return Effect.runPromise(this.service());
  }

  close(): void {
    Atomics.store(this.header, STATE_INDEX, STATE_CLOSED);
    Atomics.notify(this.header, STATE_INDEX);
  }

  private complete(result: TraceKernelSyscallResult): void {
    let frame = encodeTraceKernelSyscallResult(result);
    if (frame.byteLength > this.payload.byteLength) {
      frame = encodeTraceKernelSyscallResult(this.protocolFailure(
        'E2BIG',
        `syscall response exceeds channel capacity ${this.payload.byteLength}`
      ));
    }
    if (Atomics.load(this.header, STATE_INDEX) !== STATE_PROCESSING) return;
    this.payload.set(frame);
    Atomics.store(this.header, RESPONSE_LENGTH_INDEX, frame.byteLength);
    if (
      Atomics.compareExchange(
        this.header,
        STATE_INDEX,
        STATE_PROCESSING,
        STATE_RESPONSE
      ) === STATE_PROCESSING
    ) {
      Atomics.notify(this.header, STATE_INDEX);
    }
  }

  private protocolFailure(
    code: 'E2BIG' | 'EPROTO',
    message: string
  ): TraceKernelSyscallResult {
    return {
      ok: false,
      error: { code, message: `${code}: ${message}` },
    };
  }
}

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
  readonly name = 'TraceKernelRuntimeSyscallError';

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

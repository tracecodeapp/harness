import type { TraceKernelNetworkErrorCode } from '../../errors';
import type {
  TraceKernelSyscallRequest,
  TraceKernelSyscallValue,
} from '../../syscalls';
import {
  BinaryFrameReader,
  BinaryFrameWriter,
  TraceKernelSyscallOperation,
  TraceKernelTransportError,
} from './protocol';

/** Binary payload codec for socket and network syscalls. */
const SOCKET_ERROR_CODES: ReadonlySet<TraceKernelNetworkErrorCode> = new Set([
  'EADDRINUSE',
  'EAFNOSUPPORT',
  'EALREADY',
  'EBADF',
  'ECONNREFUSED',
  'EDESTADDRREQ',
  'EINPROGRESS',
  'EISCONN',
  'EINVAL',
  'ENOTCONN',
  'EOPNOTSUPP',
]);

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

export function encodeNetworkRequest(
  writer: BinaryFrameWriter,
  request: TraceKernelSyscallRequest
): boolean {
  switch (request.op) {
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
    case 'getsockopt':
      writer.i32(request.fd);
      writer.u8(request.option === 'error' ? 1 : 0);
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
    default:
      return false;
  }
  return true;
}

export function decodeNetworkRequest(
  reader: BinaryFrameReader,
  operation: TraceKernelSyscallOperation
): TraceKernelSyscallRequest | undefined {
  let request: TraceKernelSyscallRequest;
  switch (operation) {
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
    case 'listen':
      {
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
    case 'getsockopt':
      {
      const fd = reader.i32();
      const option = reader.u8();
      if (option !== 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid socket option code ${option}`
        );
      }
      request = { op: 'getsockopt', fd, option: 'error' };
      break;
          }
    case 'send':
      request = { op: 'send', fd: reader.i32(), bytes: reader.byteArray() };
      break;
    case 'recv':
      request = { op: 'recv', fd: reader.i32(), maxBytes: reader.u32() };
      break;
    case 'shutdown':
      {
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
    default:
      return undefined;
  }
  return request;
}

export function encodeNetworkResult(
  writer: BinaryFrameWriter,
  value: TraceKernelSyscallValue
): boolean {
  switch (value.op) {
    case 'socket':
      writer.i32(value.fd);
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
    case 'getsockopt':
      writer.u8(value.error === undefined ? 0 : 1);
      if (value.error !== undefined) writer.string(value.error);
      break;
    case 'listen':
    case 'shutdown':
      break;
    default:
      return false;
  }
  return true;
}

export function decodeNetworkResult(
  reader: BinaryFrameReader,
  operation: TraceKernelSyscallOperation
): TraceKernelSyscallValue | undefined {
  let value: TraceKernelSyscallValue;
  switch (operation) {
    case 'socket':
      value = { op: operation, fd: reader.i32() };
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
    case 'getsockopt':
      {
      const hasError = reader.u8();
      if (hasError > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid socket error presence flag ${hasError}`
        );
      }
      const error = hasError === 1 ? reader.string() : undefined;
      if (
        error !== undefined &&
        !SOCKET_ERROR_CODES.has(error as TraceKernelNetworkErrorCode)
      ) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid socket error code ${JSON.stringify(error)}`
        );
      }
      value = {
        op: 'getsockopt',
        ...(error === undefined
          ? {}
          : { error: error as TraceKernelNetworkErrorCode }),
      };
      break;
          }
    case 'listen':
    case 'shutdown':
      value = { op: operation };
      break;
    default:
      return undefined;
  }
  return value;
}

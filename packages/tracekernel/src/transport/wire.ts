import type {
  TraceKernelSyscallErrorCode,
  TraceKernelSyscallRequest,
  TraceKernelSyscallResult,
  TraceKernelSyscallValue,
} from '../syscalls';
import {
  decodeFilesystemRequest,
  decodeFilesystemResult,
  encodeFilesystemRequest,
  encodeFilesystemResult,
} from './wire/filesystem-codec';
import {
  decodeNetworkRequest,
  decodeNetworkResult,
  encodeNetworkRequest,
  encodeNetworkResult,
} from './wire/network-codec';
import {
  decodeProcessRequest,
  decodeProcessResult,
  encodeProcessRequest,
  encodeProcessResult,
} from './wire/process-codec';
import {
  BinaryFrameReader,
  BinaryFrameWriter,
  FRAME_REQUEST,
  FRAME_RESPONSE,
  SYSCALL_ERROR_CODES,
  TRACEKERNEL_SYSCALL_OPERATION_CODES,
  TRACEKERNEL_SYSCALL_WIRE_SCHEMA,
  TRACEKERNEL_SYSCALL_WIRE_VERSION,
  TraceKernelTransportError,
  readFramePrefix,
  readOperation,
  writeFramePrefix,
  writeOperation,
} from './wire/protocol';

/**
 * Public wire-codec surface. Domain payloads live behind this dispatcher so
 * the frame contract stays stable while process, network, and filesystem
 * codecs evolve independently.
 */
export {
  TRACEKERNEL_SYSCALL_OPERATION_CODES,
  TRACEKERNEL_SYSCALL_WIRE_SCHEMA,
  TRACEKERNEL_SYSCALL_WIRE_VERSION,
  TraceKernelTransportError,
};
export type {
  TraceKernelTransportErrorCode,
} from './wire/protocol';

export function encodeTraceKernelSyscallRequest(
  request: TraceKernelSyscallRequest
): Uint8Array {
  const writer = new BinaryFrameWriter();
  writeFramePrefix(writer, FRAME_REQUEST);
  writeOperation(writer, request.op);
  if (
    !encodeProcessRequest(writer, request) &&
    !encodeNetworkRequest(writer, request) &&
    !encodeFilesystemRequest(writer, request)
  ) {
    throw new TraceKernelTransportError(
      'ENOSYS',
      `cannot encode unknown syscall request ${JSON.stringify(request)}`
    );
  }
  return writer.finish();
}

export function decodeTraceKernelSyscallRequest(
  bytes: Uint8Array
): TraceKernelSyscallRequest {
  const reader = new BinaryFrameReader(bytes);
  readFramePrefix(reader, FRAME_REQUEST);
  const operation = readOperation(reader);
  const request =
    decodeProcessRequest(reader, operation) ??
    decodeNetworkRequest(reader, operation) ??
    decodeFilesystemRequest(reader, operation);
  if (request === undefined) {
    throw new TraceKernelTransportError(
      'ENOSYS',
      `cannot decode unsupported syscall request ${operation}`
    );
  }
  reader.done();
  return request;
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
  if (
    !encodeProcessResult(writer, result.value) &&
    !encodeNetworkResult(writer, result.value) &&
    !encodeFilesystemResult(writer, result.value)
  ) {
    throw new TraceKernelTransportError(
      'ENOSYS',
      `cannot encode unknown syscall result ${JSON.stringify(result.value)}`
    );
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
    throw new TraceKernelTransportError(
      'EPROTO',
      `invalid syscall result status ${success}`
    );
  }
  if (success === 0) {
    const code = reader.string() as TraceKernelSyscallErrorCode;
    if (!SYSCALL_ERROR_CODES.has(code)) {
      throw new TraceKernelTransportError(
        'EPROTO',
        `unknown syscall error code ${code}`
      );
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
  const value: TraceKernelSyscallValue | undefined =
    decodeProcessResult(reader, operation) ??
    decodeNetworkResult(reader, operation) ??
    decodeFilesystemResult(reader, operation);
  if (value === undefined) {
    throw new TraceKernelTransportError(
      'ENOSYS',
      `cannot decode unsupported syscall result ${operation}`
    );
  }
  reader.done();
  return { ok: true, value };
}

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

/** Binary payload codec for descriptor and filesystem syscalls. */
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
    throw new TraceKernelTransportError(
      'EPROTO',
      `invalid stat kind ${kindCode}`
    );
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

export function encodeFilesystemRequest(
  writer: BinaryFrameWriter,
  request: TraceKernelSyscallRequest
): boolean {
  switch (request.op) {
    case 'open':
      {
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
    case 'seek':
      writer.i32(request.fd);
      writer.f64(request.offset);
      writer.u8(
        request.whence === 'set'
          ? 1
          : request.whence === 'current'
            ? 2
            : 3
      );
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
    default:
      return false;
  }
  return true;
}

export function decodeFilesystemRequest(
  reader: BinaryFrameReader,
  operation: TraceKernelSyscallOperation
): TraceKernelSyscallRequest | undefined {
  let request: TraceKernelSyscallRequest;
  switch (operation) {
    case 'open':
      {
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
    case 'read':
      {
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
    case 'write':
      {
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
    case 'seek':
      {
      const fd = reader.i32();
      const offset = reader.f64();
      const whenceCode = reader.u8();
      const whence = whenceCode === 1
        ? 'set' as const
        : whenceCode === 2
          ? 'current' as const
          : whenceCode === 3
            ? 'end' as const
            : undefined;
      if (!whence) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid seek whence code ${whenceCode}`
        );
      }
      request = { op: 'seek', fd, offset, whence };
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
    case 'dup3':
      {
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
    case 'fcntl':
      {
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
    case 'mkdir':
      {
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
    default:
      return undefined;
  }
  return request;
}

export function encodeFilesystemResult(
  writer: BinaryFrameWriter,
  value: TraceKernelSyscallValue
): boolean {
  switch (value.op) {
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
    case 'read':
      writer.byteArray(value.bytes);
      break;
    case 'write':
      writer.u32(value.bytesWritten);
      break;
    case 'seek':
      writer.f64(value.offset);
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
    case 'mkdir':
    case 'rmdir':
    case 'unlink':
    case 'link':
    case 'symlink':
    case 'rename':
    case 'writeFile':
    case 'ftruncate':
      break;
    default:
      return false;
  }
  return true;
}

export function decodeFilesystemResult(
  reader: BinaryFrameReader,
  operation: TraceKernelSyscallOperation
): TraceKernelSyscallValue | undefined {
  let value: TraceKernelSyscallValue;
  switch (operation) {
    case 'open':
    case 'dup':
    case 'dup2':
      value = { op: operation, fd: reader.i32() };
      break;
    case 'dup3':
      {
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
    case 'fcntl':
      {
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
    case 'read':
      value = { op: 'read', bytes: reader.byteArray() };
      break;
    case 'write':
      value = { op: 'write', bytesWritten: reader.u32() };
      break;
    case 'seek':
      value = { op: 'seek', offset: reader.f64() };
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
    case 'readdir':
      {
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
    default:
      return undefined;
  }
  return value;
}

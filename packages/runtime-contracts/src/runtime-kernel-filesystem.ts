import type {
  RuntimeKernelDeviceInfo,
  RuntimeKernelDevicePath,
  RuntimeKernelInfo,
} from './runtime-project';
import {
  classifyRuntimeKernelVirtualPath,
  normalizeRuntimeKernelManifestDevicePath,
  runtimeDeviceCanRead,
  runtimeDeviceCanWrite,
  runtimeDeviceDirEntries,
  runtimeDeviceEntryKind,
  runtimeDeviceOutputTarget,
  runtimeDeviceStat,
  runtimeKernelDeviceInfo,
  runtimeKernelDeviceOutputTarget,
  runtimeKernelIdentityDirEntries,
  runtimeKernelIdentityEntryKind,
  type RuntimeKernelAccessRequest,
  type RuntimeKernelAccessTarget,
  type RuntimeKernelCopyTarget,
  type RuntimeKernelDirectoryTarget,
  type RuntimeKernelErrorCode,
  type RuntimeKernelFileCopyTarget,
  type RuntimeKernelFileReadTarget,
  type RuntimeKernelLinkTarget,
  type RuntimeKernelMetadataTarget,
  type RuntimeKernelMkdirTarget,
  type RuntimeKernelMutationTarget,
  type RuntimeKernelOpenRequest,
  type RuntimeKernelOpenTarget,
  type RuntimeKernelReadTarget,
  type RuntimeKernelRemoveTarget,
  type RuntimeKernelRenameTarget,
  type RuntimeKernelStatTarget,
  type RuntimeKernelSymlinkTarget,
  type RuntimeKernelTruncateTarget,
  type RuntimeKernelWriteTarget,
} from './runtime-kernel-paths';
import {
  runtimeKernelIdentityStat,
  runtimeProcDirEntries,
  runtimeProcEntryKind,
  runtimeProcStat,
} from './runtime-kernel-proc';

export function runtimeKernelWriteTarget(
  path: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelWriteTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'proc' || virtualPath.kind === 'identity') {
    return { kind: 'error', reason: 'proc-read-only', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device-directory') {
    return { kind: 'error', reason: 'device-directory', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device-namespace') {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    if (device && !runtimeKernelDeviceInfo(devices, device) && runtimeDeviceDirEntries(device, devices)) {
      return { kind: 'error', reason: 'device-directory', path: device };
    }
    if (!device || !runtimeKernelDeviceInfo(devices, device)) {
      return { kind: 'error', reason: 'device-not-found', path: virtualPath.path };
    }
    const outputDevice = runtimeKernelDeviceOutputTarget(devices, device);
    if (!outputDevice) {
      return { kind: 'error', reason: 'device-read-only', path: virtualPath.path };
    }
    return { kind: 'device', device, outputDevice };
  }
  const outputDevice = devices
    ? runtimeKernelDeviceOutputTarget(devices, virtualPath.path)
    : runtimeDeviceOutputTarget(virtualPath.path);
  if (!outputDevice) {
    return { kind: 'error', reason: 'device-read-only', path: virtualPath.path };
  }
  return { kind: 'device', device: virtualPath.path, outputDevice };
}

export function runtimeKernelWriteErrorCode(
  reason: Extract<RuntimeKernelWriteTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  if (reason === 'proc-read-only') return 'EROFS';
  if (reason === 'device-directory') return 'EISDIR';
  if (reason === 'device-read-only') return 'EBADF';
  return 'ENOENT';
}

export function runtimeKernelWriteErrorMessage(
  path: string,
  target: Extract<RuntimeKernelWriteTarget, { kind: 'error' }>
): string {
  if (target.reason === 'proc-read-only') return `Kernel proc path is read-only: ${path}`;
  if (target.reason === 'device-directory') return `Kernel device path is a directory: ${path}`;
  if (target.reason === 'device-read-only') return `Kernel device is read-only: ${target.path}`;
  return `Kernel device path not found: ${path}`;
}

export function runtimeKernelWriteFsErrorMessage(
  path: string,
  target: Extract<RuntimeKernelWriteTarget, { kind: 'error' }>,
  operation = 'open'
): string {
  const code = runtimeKernelWriteErrorCode(target.reason);
  if (code === 'EROFS') return `EROFS: read-only file system, ${operation} '${path}'`;
  if (code === 'EBADF') return `EBADF: bad file descriptor, write`;
  if (code === 'EISDIR') return `EISDIR: illegal operation on a directory, ${operation} '${path}'`;
  return `ENOENT: no such file or directory, ${operation} '${path}'`;
}

export function runtimeKernelMutationTarget(
  path: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelMutationTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'proc' || virtualPath.kind === 'identity') {
    return { kind: 'error', reason: 'proc-read-only', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device-namespace') {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    if (device && !runtimeKernelDeviceInfo(devices, device) && runtimeDeviceDirEntries(device, devices)) {
      return { kind: 'error', reason: 'device-read-only', path: device };
    }
    if (!device || !runtimeKernelDeviceInfo(devices, device)) {
      return { kind: 'error', reason: 'device-not-found', path: virtualPath.path };
    }
    return { kind: 'error', reason: 'device-read-only', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device' && devices && !runtimeKernelDeviceInfo(devices, virtualPath.path)) {
    return { kind: 'error', reason: 'device-not-found', path: virtualPath.path };
  }
  return { kind: 'error', reason: 'device-read-only', path: virtualPath.path };
}

export function runtimeKernelMutationErrorCode(
  reason: Extract<RuntimeKernelMutationTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return reason === 'device-not-found' ? 'ENOENT' : 'EROFS';
}

export function runtimeKernelMutationErrorMessage(
  path: string,
  target: Extract<RuntimeKernelMutationTarget, { kind: 'error' }>,
  options: { deviceMessage?: string } = {}
): string {
  if (target.reason === 'proc-read-only') return `Kernel proc path is read-only: ${path}`;
  if (target.reason === 'device-not-found') return `Kernel device path not found: ${path}`;
  return options.deviceMessage ?? `Kernel device namespace is read-only: ${path}`;
}

export function runtimeKernelMutationFsErrorMessage(
  path: string,
  target: Extract<RuntimeKernelMutationTarget, { kind: 'error' }>,
  operation: string,
  destination?: string
): string {
  const suffix = destination === undefined ? `${operation} '${path}'` : `${operation} '${path}' -> '${destination}'`;
  const code = runtimeKernelMutationErrorCode(target.reason);
  if (code === 'ENOENT') return `ENOENT: no such file or directory, ${suffix}`;
  return `EROFS: read-only file system, ${suffix}`;
}

export function runtimeKernelMetadataTarget(
  path: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelMetadataTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'proc' || virtualPath.kind === 'identity') {
    return { kind: 'error', reason: 'proc-read-only', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device-namespace') {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    if (device && !runtimeKernelDeviceInfo(devices, device) && runtimeDeviceDirEntries(device, devices)) {
      return { kind: 'ignored-device', path: device };
    }
    if (!device || !runtimeKernelDeviceInfo(devices, device)) {
      return { kind: 'error', reason: 'device-not-found', path: virtualPath.path };
    }
    return { kind: 'ignored-device', path: device };
  }
  if (virtualPath.kind === 'device' && devices && !runtimeKernelDeviceInfo(devices, virtualPath.path)) {
    return { kind: 'error', reason: 'device-not-found', path: virtualPath.path };
  }
  return { kind: 'ignored-device', path: virtualPath.path };
}

export function runtimeKernelMetadataErrorCode(
  reason: Extract<RuntimeKernelMetadataTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return reason === 'proc-read-only' ? 'EROFS' : 'ENOENT';
}

export function runtimeKernelMetadataErrorMessage(
  path: string,
  target: Extract<RuntimeKernelMetadataTarget, { kind: 'error' }>
): string {
  if (target.reason === 'proc-read-only') return `Kernel proc path is read-only: ${path}`;
  return `Kernel device path not found: ${path}`;
}

export function runtimeKernelAccessTarget(
  path: string,
  request: RuntimeKernelAccessRequest = {},
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelAccessTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'device-namespace') {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    const info = device ? runtimeKernelDeviceInfo(devices, device) : null;
    if (device && !info && runtimeDeviceDirEntries(device, devices)) {
      return request.write || request.execute
        ? { kind: 'denied', reason: 'permission-denied', path: device }
        : { kind: 'allowed', path: device };
    }
    if (!device || !info) return { kind: 'denied', reason: 'not-found', path: virtualPath.path };
    return (request.read && !info.readable) || (request.write && !info.writable) || request.execute
      ? { kind: 'denied', reason: 'permission-denied', path: device }
      : { kind: 'allowed', path: device };
  }
  if (virtualPath.kind === 'device-directory') {
    return request.write || request.execute
      ? { kind: 'denied', reason: 'permission-denied', path: virtualPath.path }
      : { kind: 'allowed', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device') {
    const info = devices ? runtimeKernelDeviceInfo(devices, virtualPath.path) : null;
    if (devices && !info) return { kind: 'denied', reason: 'not-found', path: virtualPath.path };
    const readable = info ? info.readable : runtimeDeviceCanRead(virtualPath.path);
    const writable = info ? info.writable : runtimeDeviceCanWrite(virtualPath.path);
    return (request.read && !readable) || (request.write && !writable) || request.execute
      ? { kind: 'denied', reason: 'permission-denied', path: virtualPath.path }
      : { kind: 'allowed', path: virtualPath.path };
  }
  const readonlyEntryKind = virtualPath.kind === 'identity'
    ? runtimeKernelIdentityEntryKind(virtualPath.path)
    : runtimeProcEntryKind(virtualPath.path);
  if (!readonlyEntryKind) {
    return { kind: 'denied', reason: 'not-found', path: virtualPath.path };
  }
  return request.write || request.execute
    ? { kind: 'denied', reason: 'permission-denied', path: virtualPath.path }
    : { kind: 'allowed', path: virtualPath.path };
}

export function runtimeKernelOpenTarget(
  path: string,
  request: RuntimeKernelOpenRequest = {},
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelOpenTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'device-namespace') {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    const info = device ? runtimeKernelDeviceInfo(devices, device) : null;
    if (device && !info && runtimeDeviceDirEntries(device, devices)) {
      return { kind: 'error', reason: 'is-directory', path: device };
    }
    if (!device || !info) return { kind: 'error', reason: 'not-found', path: virtualPath.path };
    return {
      kind: 'device',
      device,
      readable: info.readable && request.readable === true,
      writable: info.writable && request.writable === true,
    };
  }
  if (virtualPath.kind === 'device-directory') {
    return { kind: 'error', reason: 'is-directory', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device') {
    const info = devices ? runtimeKernelDeviceInfo(devices, virtualPath.path) : null;
    if (devices && !info) return { kind: 'error', reason: 'not-found', path: virtualPath.path };
    return {
      kind: 'device',
      device: virtualPath.path,
      readable: info ? info.readable && request.readable === true : runtimeDeviceCanRead(virtualPath.path) && request.readable === true,
      writable: info ? info.writable && request.writable === true : runtimeDeviceCanWrite(virtualPath.path) && request.writable === true,
    };
  }

  const entryKind = virtualPath.kind === 'identity'
    ? runtimeKernelIdentityEntryKind(virtualPath.path)
    : runtimeProcEntryKind(virtualPath.path);
  if (!entryKind) {
    return { kind: 'error', reason: 'not-found', path: virtualPath.path };
  }
  if (entryKind === 'directory') {
    return { kind: 'error', reason: 'is-directory', path: virtualPath.path };
  }
  if (request.writable || request.create || request.truncate || request.exclusive) {
    return { kind: 'error', reason: 'read-only', path: virtualPath.path };
  }
  return { kind: 'proc-file', path: virtualPath.path, readable: true, writable: false };
}

export function runtimeKernelOpenErrorCode(
  reason: Extract<RuntimeKernelOpenTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  if (reason === 'is-directory') return 'EISDIR';
  if (reason === 'read-only') return 'EROFS';
  return 'ENOENT';
}

export function runtimeKernelOpenErrorMessage(
  path: string,
  target: Extract<RuntimeKernelOpenTarget, { kind: 'error' }>,
  operation = 'open'
): string {
  const code = runtimeKernelOpenErrorCode(target.reason);
  if (code === 'EROFS') return `EROFS: read-only file system, ${operation} '${path}'`;
  if (code === 'EISDIR') return `EISDIR: illegal operation on a directory, ${operation} '${path}'`;
  return `ENOENT: no such file or directory, ${operation} '${path}'`;
}

export function runtimeKernelReadTarget(
  path: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelReadTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'device-namespace') {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    const info = device ? runtimeKernelDeviceInfo(devices, device) : null;
    if (device && !info && runtimeDeviceDirEntries(device, devices)) {
      return { kind: 'device-directory', path: device };
    }
    if (!device || !info) return { kind: 'error', reason: 'not-found', path: virtualPath.path };
    return info.readable
      ? { kind: 'device-file', path: device }
      : { kind: 'error', reason: 'permission-denied', path: virtualPath.path };
  }
  if (virtualPath.kind === 'device-directory') return virtualPath;
  if (virtualPath.kind === 'device') {
    const info = devices ? runtimeKernelDeviceInfo(devices, virtualPath.path) : null;
    if (devices && !info) return { kind: 'error', reason: 'not-found', path: virtualPath.path };
    const readable = info ? info.readable : runtimeDeviceCanRead(virtualPath.path);
    return readable
      ? { kind: 'device-file', path: virtualPath.path }
      : { kind: 'error', reason: 'permission-denied', path: virtualPath.path };
  }
  const kind = virtualPath.kind === 'identity'
    ? runtimeKernelIdentityEntryKind(virtualPath.path)
    : runtimeProcEntryKind(virtualPath.path);
  if (kind === 'file') return { kind: 'proc-file', path: virtualPath.path };
  if (kind === 'directory') return { kind: 'proc-directory', path: virtualPath.path };
  return { kind: 'error', reason: 'not-found', path: virtualPath.path };
}

export function runtimeKernelFileReadTarget(
  path: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelFileReadTarget {
  const readTarget = runtimeKernelReadTarget(path, devices);
  if (readTarget.kind === 'device-file' || readTarget.kind === 'proc-file' || readTarget.kind === 'workspace') {
    return readTarget;
  }
  if (readTarget.kind === 'device-directory' || readTarget.kind === 'proc-directory') {
    return { kind: 'error', reason: 'is-directory', path: readTarget.path };
  }
  return readTarget;
}

export function runtimeKernelFileReadErrorCode(
  reason: Extract<RuntimeKernelFileReadTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  if (reason === 'permission-denied') return 'EBADF';
  return reason === 'is-directory' ? 'EISDIR' : 'ENOENT';
}

export function runtimeKernelReadErrorMessage(
  path: string,
  target: Extract<RuntimeKernelReadTarget, { kind: 'error' }>
): string {
  if (target.reason === 'permission-denied') return `Kernel device is not readable: ${target.path}`;
  return `Kernel virtual path not found: ${path}`;
}

export function runtimeKernelFileReadErrorMessage(
  path: string,
  target: Extract<RuntimeKernelFileReadTarget, { kind: 'error' }>
): string {
  if (target.reason === 'is-directory') return `Kernel virtual path is a directory: ${path}`;
  if (target.reason === 'permission-denied') return `Kernel device is not readable: ${target.path}`;
  return `Kernel virtual path not found: ${path}`;
}

export function runtimeKernelFileReadFsErrorMessage(
  path: string,
  target: Extract<RuntimeKernelFileReadTarget, { kind: 'error' }>,
  operation = 'open'
): string {
  const code = runtimeKernelFileReadErrorCode(target.reason);
  if (code === 'EBADF') return `EBADF: bad file descriptor, ${operation} '${path}'`;
  if (code === 'EISDIR') return `EISDIR: illegal operation on a directory, ${operation} '${path}'`;
  return `ENOENT: no such file or directory, ${operation} '${path}'`;
}

export function runtimeKernelStatTarget(
  path: string,
  info: RuntimeKernelInfo,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelStatTarget {
  const virtualPath = classifyRuntimeKernelVirtualPath(path);
  if (virtualPath === null) return { kind: 'workspace' };
  if (virtualPath.kind === 'device-directory') {
    return { kind: 'stat', path: virtualPath.path, stat: runtimeDeviceStat(virtualPath.path, devices) };
  }
  if (virtualPath.kind === 'device-namespace') {
    const device = normalizeRuntimeKernelManifestDevicePath(virtualPath.path);
    if (!device || !runtimeKernelDeviceInfo(devices, device)) {
      if (device && runtimeDeviceDirEntries(device, devices)) {
        return { kind: 'stat', path: device, stat: runtimeDeviceStat(device, devices) };
      }
      return { kind: 'error', reason: 'not-found', path: virtualPath.path };
    }
    return { kind: 'stat', path: device, stat: runtimeDeviceStat(device, devices) };
  }
  if (virtualPath.kind === 'device') {
    if (devices && !runtimeKernelDeviceInfo(devices, virtualPath.path)) {
      return { kind: 'error', reason: 'not-found', path: virtualPath.path };
    }
    return { kind: 'stat', path: virtualPath.path, stat: runtimeDeviceStat(virtualPath.path, devices) };
  }
  const stat = virtualPath.kind === 'identity'
    ? runtimeKernelIdentityStat(virtualPath.path, info)
    : runtimeProcStat(virtualPath.path, info);
  return stat
    ? { kind: 'stat', path: virtualPath.path, stat }
    : { kind: 'error', reason: 'not-found', path: virtualPath.path };
}

export function runtimeKernelStatErrorCode(
  _reason: Extract<RuntimeKernelStatTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return 'ENOENT';
}

export function runtimeKernelDirectoryTarget(
  path: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelDirectoryTarget {
  const readTarget = runtimeKernelReadTarget(path, devices);
  if (readTarget.kind === 'workspace') return readTarget;
  if (readTarget.kind === 'device-directory') {
    return {
      kind: 'directory',
      path: readTarget.path,
      entries: (runtimeDeviceDirEntries(readTarget.path, devices) ?? []).map((name) => ({
        name,
        kind: runtimeDeviceEntryKind(`${readTarget.path === '/dev' ? '/dev' : readTarget.path}/${name}` as RuntimeKernelDevicePath, devices),
      })),
    };
  }
  if (readTarget.kind === 'proc-directory') {
    const identityEntries = runtimeKernelIdentityDirEntries(readTarget.path);
    return {
      kind: 'directory',
      path: readTarget.path,
      entries: (identityEntries ?? runtimeProcDirEntries(readTarget.path) ?? []).map((name) => ({
        name,
        kind: identityEntries
          ? runtimeKernelIdentityEntryKind(readTarget.path + '/' + name) ?? 'file'
          : runtimeProcEntryKind(readTarget.path + '/' + name) ?? 'file',
      })),
    };
  }
  if (readTarget.kind === 'device-file' || readTarget.kind === 'proc-file') {
    return { kind: 'error', reason: 'not-directory', path: readTarget.path };
  }
  if (readTarget.reason === 'permission-denied') {
    return { kind: 'error', reason: 'not-directory', path: readTarget.path };
  }
  return { kind: 'error', reason: 'not-found', path: readTarget.path };
}

export function runtimeKernelDirectoryErrorCode(
  reason: Extract<RuntimeKernelDirectoryTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return reason === 'not-directory' ? 'ENOTDIR' : 'ENOENT';
}

export function runtimeKernelCopyTarget(
  source: string,
  destination: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelCopyTarget {
  const sourceTarget = runtimeKernelReadTarget(source, devices);
  const writeTarget = runtimeKernelWriteTarget(destination, devices);
  if (
    sourceTarget.kind === 'device-file' ||
    sourceTarget.kind === 'proc-file' ||
    writeTarget.kind === 'device' ||
    writeTarget.kind === 'error'
  ) {
    return { kind: 'file-copy' };
  }
  if (sourceTarget.kind === 'device-directory' || sourceTarget.kind === 'proc-directory') {
    return { kind: 'error', reason: 'source-directory', path: sourceTarget.path };
  }
  if (sourceTarget.kind === 'error') {
    return { kind: 'error', reason: 'source-not-found', path: sourceTarget.path };
  }
  return { kind: 'workspace' };
}

export function runtimeKernelCopyErrorCode(
  reason: Extract<RuntimeKernelCopyTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return reason === 'source-directory' ? 'EISDIR' : 'ENOENT';
}

export function runtimeKernelCopyErrorMessage(
  source: string,
  destination: string,
  target: Extract<RuntimeKernelCopyTarget, { kind: 'error' }>,
  operation = 'cp'
): string {
  const code = runtimeKernelCopyErrorCode(target.reason);
  if (code === 'EISDIR') return `EISDIR: illegal operation on a directory, ${operation} '${source}'`;
  return `ENOENT: no such file or directory, ${operation} '${source}' -> '${destination}'`;
}

export function runtimeKernelFileCopyTarget(
  source: string,
  destination: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelFileCopyTarget {
  const writeTarget = runtimeKernelWriteTarget(destination, devices);
  if (writeTarget.kind === 'error') {
    return { kind: 'error', side: 'destination', reason: writeTarget.reason, path: writeTarget.path };
  }

  const sourceTarget = runtimeKernelFileReadTarget(source, devices);
  if (sourceTarget.kind === 'error') {
    return { kind: 'error', side: 'source', reason: sourceTarget.reason, path: sourceTarget.path };
  }

  if (writeTarget.kind === 'device') {
    return { kind: 'device-destination', device: writeTarget.device, outputDevice: writeTarget.outputDevice, source: sourceTarget };
  }

  if (sourceTarget.kind === 'device-file' || sourceTarget.kind === 'proc-file') {
    return { kind: 'virtual-source', source: sourceTarget };
  }

  return { kind: 'workspace' };
}

export function runtimeKernelFileCopyErrorCode(
  target: Extract<RuntimeKernelFileCopyTarget, { kind: 'error' }>
): RuntimeKernelErrorCode {
  return target.side === 'destination'
    ? runtimeKernelWriteErrorCode(target.reason)
    : runtimeKernelFileReadErrorCode(target.reason);
}

export function runtimeKernelFileCopyErrorMessage(
  source: string,
  destination: string,
  target: Extract<RuntimeKernelFileCopyTarget, { kind: 'error' }>,
  operation = 'copyfile'
): string {
  const code = runtimeKernelFileCopyErrorCode(target);
  const suffix = `${operation} '${source}' -> '${destination}'`;
  if (code === 'EROFS') return `EROFS: read-only file system, ${suffix}`;
  if (code === 'EBADF') return `EBADF: bad file descriptor, ${suffix}`;
  if (code === 'EISDIR') return `EISDIR: illegal operation on a directory, ${suffix}`;
  return `ENOENT: no such file or directory, ${suffix}`;
}

export function runtimeKernelLinkTarget(
  source: string,
  destination: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelLinkTarget {
  const sourceTarget = runtimeKernelMutationTarget(source, devices);
  if (sourceTarget.kind === 'error') {
    return { kind: 'error', side: 'source', reason: sourceTarget.reason, path: sourceTarget.path };
  }
  const destinationTarget = runtimeKernelMutationTarget(destination, devices);
  if (destinationTarget.kind === 'error') {
    return { kind: 'error', side: 'destination', reason: destinationTarget.reason, path: destinationTarget.path };
  }
  return { kind: 'workspace' };
}

export function runtimeKernelLinkErrorCode(
  reason: Extract<RuntimeKernelLinkTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return runtimeKernelMutationErrorCode(reason);
}

export function runtimeKernelRenameTarget(
  source: string,
  destination: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelRenameTarget {
  const sourceTarget = runtimeKernelMutationTarget(source, devices);
  if (sourceTarget.kind === 'error') {
    return { kind: 'error', side: 'source', reason: sourceTarget.reason, path: sourceTarget.path };
  }
  const destinationTarget = runtimeKernelMutationTarget(destination, devices);
  if (destinationTarget.kind === 'error') {
    return { kind: 'error', side: 'destination', reason: destinationTarget.reason, path: destinationTarget.path };
  }
  return { kind: 'workspace' };
}

export function runtimeKernelRenameErrorCode(
  reason: Extract<RuntimeKernelRenameTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return runtimeKernelMutationErrorCode(reason);
}

export function runtimeKernelSymlinkTarget(
  linkPath: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelSymlinkTarget {
  const linkTarget = runtimeKernelMutationTarget(linkPath, devices);
  if (linkTarget.kind === 'error') {
    return { kind: 'error', reason: linkTarget.reason, path: linkTarget.path };
  }
  return { kind: 'workspace' };
}

export function runtimeKernelSymlinkErrorCode(
  reason: Extract<RuntimeKernelSymlinkTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return runtimeKernelMutationErrorCode(reason);
}

export function runtimeKernelRemoveTarget(
  path: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelRemoveTarget {
  const removeTarget = runtimeKernelMutationTarget(path, devices);
  if (removeTarget.kind === 'error') {
    return { kind: 'error', reason: removeTarget.reason, path: removeTarget.path };
  }
  return { kind: 'workspace' };
}

export function runtimeKernelRemoveErrorCode(
  reason: Extract<RuntimeKernelRemoveTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return runtimeKernelMutationErrorCode(reason);
}

export function runtimeKernelMkdirTarget(
  path: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelMkdirTarget {
  const mkdirTarget = runtimeKernelMutationTarget(path, devices);
  if (mkdirTarget.kind === 'error') {
    return { kind: 'error', reason: mkdirTarget.reason, path: mkdirTarget.path };
  }
  return { kind: 'workspace' };
}

export function runtimeKernelMkdirErrorCode(
  reason: Extract<RuntimeKernelMkdirTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return runtimeKernelMutationErrorCode(reason);
}

export function runtimeKernelTruncateTarget(
  path: string,
  devices?: readonly RuntimeKernelDeviceInfo[]
): RuntimeKernelTruncateTarget {
  const truncateTarget = runtimeKernelMutationTarget(path, devices);
  if (truncateTarget.kind === 'error') {
    return { kind: 'error', reason: truncateTarget.reason, path: truncateTarget.path };
  }
  return { kind: 'workspace' };
}

export function runtimeKernelTruncateErrorCode(
  reason: Extract<RuntimeKernelTruncateTarget, { kind: 'error' }>['reason']
): RuntimeKernelErrorCode {
  return runtimeKernelMutationErrorCode(reason);
}

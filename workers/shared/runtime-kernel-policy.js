export function normalizeRuntimeKernelPath(value) {
  const raw = String(value ?? '').replace(/\\/g, '/');
  const absolute = raw.startsWith('/') ? raw : `/${raw}`;
  const parts = [];
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`.replace(/\/+$/, '') || '/';
}

export function isRuntimeKernelProcPath(value) {
  const normalized = normalizeRuntimeKernelPath(value);
  return normalized === '/proc' || normalized.startsWith('/proc/');
}

export function isRuntimeKernelDeviceNamespacePath(value) {
  const normalized = normalizeRuntimeKernelPath(value);
  return normalized === '/dev' || normalized.startsWith('/dev/');
}

export function isRuntimeKernelDeviceDirectory(value, options = {}) {
  return runtimeKernelDeviceEntryKind(options.devices, value) === 'directory';
}

export function normalizeRuntimeKernelDeviceReference(value) {
  const normalized = normalizeRuntimeKernelPath(value);
  if (normalized === '/dev' || !normalized.startsWith('/dev/')) return '';
  const deviceName = normalized.slice('/dev/'.length);
  return deviceName.length > 0 && !deviceName.includes('/') ? normalized : '';
}

export function normalizeRuntimeKernelManifestDevicePath(value) {
  const normalized = normalizeRuntimeKernelPath(value);
  return normalized !== '/dev' && normalized.startsWith('/dev/') ? normalized : '';
}

function normalizedSet(values) {
  return new Set(Array.from(values ?? [], (value) => normalizeRuntimeKernelPath(value)).filter(Boolean));
}

function normalizedDeviceInfos(devices) {
  let entries = [];
  if (devices instanceof Map) {
    entries = Array.from(devices.values());
  } else if (Array.isArray(devices)) {
    entries = devices;
  } else if (devices && typeof devices === 'object') {
    entries = Object.entries(devices).map(([path, value]) => ({ ...(value ?? {}), path: value?.path ?? path }));
  }

  const normalized = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const path = normalizeRuntimeKernelManifestDevicePath(entry.path);
    if (!path) continue;
    normalized.set(path, {
      path,
      readable: Boolean(entry.readable),
      writable: Boolean(entry.writable),
      inputDevice: normalizeRuntimeKernelDeviceReference(entry.inputDevice) || '',
      outputDevice: normalizeRuntimeKernelDeviceReference(entry.outputDevice) || '',
    });
  }
  return normalized;
}

function normalizedKnownDevices(values) {
  return normalizedSet(values);
}

export function runtimeKernelDeviceInfo(devices, device) {
  return normalizedDeviceInfos(devices).get(normalizeRuntimeKernelManifestDevicePath(device)) ?? null;
}

export function runtimeKernelDeviceDirEntries(devices, value = '/dev', entries = normalizedDeviceInfos(devices)) {
  const path = normalizeRuntimeKernelPath(value);
  if (path !== '/dev' && !path.startsWith('/dev/')) return null;
  const prefix = path === '/dev' ? '/dev/' : `${path}/`;
  const names = new Set();
  for (const devicePath of entries.keys()) {
    if (!devicePath.startsWith(prefix)) continue;
    const rest = devicePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.slice(0, slash);
    if (name) names.add(name);
  }
  if (path !== '/dev' && names.size === 0) return null;
  return Array.from(names).sort();
}

export function runtimeKernelDeviceEntryKind(devices, value, entries = normalizedDeviceInfos(devices)) {
  const path = normalizeRuntimeKernelPath(value);
  if (path === '/dev') return 'directory';
  if (!path.startsWith('/dev/')) return '';
  if (entries.has(normalizeRuntimeKernelManifestDevicePath(path))) return 'file';
  return runtimeKernelDeviceDirEntries(devices, path, entries) ? 'directory' : '';
}

export function runtimeKernelDeviceInputSource(devices, device) {
  const info = runtimeKernelDeviceInfo(devices, device);
  if (!info?.readable) return '';
  return info.inputDevice || info.path;
}

export function runtimeKernelDeviceOutputTarget(devices, device) {
  const info = runtimeKernelDeviceInfo(devices, device);
  if (!info?.writable) return '';
  return info.outputDevice || info.path;
}

function isRuntimeKernelReadOnlyPath(value, readOnlyPaths) {
  const normalized = normalizeRuntimeKernelPath(value);
  if (normalized === '/') return false;
  for (const path of normalizedSet(readOnlyPaths)) {
    const slash = path.indexOf('/', 1);
    const root = slash < 0 ? path : path.slice(0, slash);
    if (normalized === path || normalized === root || normalized.startsWith(`${root}/`)) return true;
  }
  return false;
}

export function runtimeKernelVirtualPathTarget(value, options = {}) {
  const path = normalizeRuntimeKernelPath(value);
  if (isRuntimeKernelProcPath(path)) {
    return { kind: 'proc', path };
  }
  if (isRuntimeKernelReadOnlyPath(path, options.readOnlyPaths)) {
    return { kind: 'read-only-file', path };
  }
  if (isRuntimeKernelDeviceNamespacePath(path)) {
    const deviceEntries = normalizedDeviceInfos(options.devices);
    const deviceEntryKind = runtimeKernelDeviceEntryKind(options.devices, path, deviceEntries);
    if (deviceEntryKind === 'directory') {
      return { kind: 'device-directory', path };
    }
    const knownDevices = options?.knownDevices
      ? normalizedKnownDevices(options.knownDevices)
      : new Set(deviceEntries.keys());
    const device = normalizeRuntimeKernelManifestDevicePath(path);
    if (!device || !knownDevices.has(device)) {
      return { kind: 'device-not-found', path };
    }
    return { kind: 'device-file', path: device };
  }
  return { kind: 'workspace', path };
}

export function runtimeKernelVirtualMutationTarget(value, options = {}) {
  const target = runtimeKernelVirtualPathTarget(value, options);
  if (target.kind === 'workspace') return target;
  if (target.kind === 'device-not-found') {
    return { kind: 'error', reason: 'device-not-found', path: target.path };
  }
  if (target.kind === 'proc') {
    return { kind: 'error', reason: 'proc-read-only', path: target.path };
  }
  if (target.kind === 'read-only-file') {
    return { kind: 'error', reason: 'kernel-read-only', path: target.path };
  }
  return { kind: 'error', reason: 'device-read-only', path: target.path };
}

export function runtimeKernelVirtualOpenTarget(value, request = {}, options = {}) {
  const target = runtimeKernelVirtualPathTarget(value, options);
  if (target.kind === 'workspace') return target;
  if (target.kind === 'device-directory') {
    return { kind: 'error', reason: 'is-directory', path: target.path };
  }
  if (target.kind === 'device-not-found') {
    return { kind: 'error', reason: 'not-found', path: target.path };
  }
  if (target.kind === 'device-file') {
    const info = runtimeKernelDeviceInfo(options.devices, target.path);
    if (!info) return { kind: 'error', reason: 'not-found', path: target.path };
    return {
      kind: 'device',
      device: target.path,
      readable: info.readable && request.readable === true,
      writable: info.writable && request.writable === true,
    };
  }
  if (target.kind === 'proc') {
    if (options.procEntryKind === 'directory') {
      return { kind: 'error', reason: 'is-directory', path: target.path };
    }
    if (options.procEntryKind !== 'file') {
      return { kind: 'error', reason: 'not-found', path: target.path };
    }
    if (request.writable || request.create || request.truncate || request.exclusive) {
      return { kind: 'error', reason: 'read-only', path: target.path };
    }
    return { kind: 'proc-file', path: target.path, readable: true, writable: false };
  }
  return { kind: 'error', reason: 'read-only', path: target.path };
}

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

export function isRuntimeKernelDeviceDirectory(value) {
  return normalizeRuntimeKernelPath(value) === '/dev';
}

export function normalizeRuntimeKernelDeviceReference(value) {
  const normalized = normalizeRuntimeKernelPath(value);
  if (normalized === '/dev' || !normalized.startsWith('/dev/')) return '';
  const deviceName = normalized.slice('/dev/'.length);
  return deviceName.length > 0 && !deviceName.includes('/') ? normalized : '';
}

function normalizedSet(values) {
  return new Set(Array.from(values ?? [], (value) => normalizeRuntimeKernelPath(value)).filter(Boolean));
}

function isRuntimeKernelReadOnlyPath(value, readOnlyPaths) {
  const normalized = normalizeRuntimeKernelPath(value);
  if (normalized === '/') return false;
  for (const path of normalizedSet(readOnlyPaths)) {
    const slash = path.indexOf('/', 1);
    const root = slash < 0 ? path : path.slice(0, slash);
    if (normalized === path || normalized.startsWith(`${root}/`)) return true;
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
  if (isRuntimeKernelDeviceDirectory(path)) {
    return { kind: 'device-directory', path };
  }
  if (isRuntimeKernelDeviceNamespacePath(path)) {
    const knownDevices = normalizedSet(options.knownDevices);
    const device = normalizeRuntimeKernelDeviceReference(path);
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

/**
 * AUTO-GENERATED FILE. DO NOT EDIT MANUALLY.
 *
 * Source: workers/shared/runtime-kernel-policy.js
 * Generator: scripts/generate-runtime-kernel-policy-classic.ts
 */

(function installRuntimeKernelPolicy(globalThis) {
  function normalizeRuntimeKernelPath(value) {
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

  function isRuntimeKernelProcPath(value) {
    const normalized = normalizeRuntimeKernelPath(value);
    return normalized === '/proc' || normalized.startsWith('/proc/');
  }

  function isRuntimeKernelDeviceNamespacePath(value) {
    const normalized = normalizeRuntimeKernelPath(value);
    return normalized === '/dev' || normalized.startsWith('/dev/');
  }

  function isRuntimeKernelDeviceDirectory(value) {
    return normalizeRuntimeKernelPath(value) === '/dev';
  }

  function normalizeRuntimeKernelDeviceReference(value) {
    const normalized = normalizeRuntimeKernelPath(value);
    if (normalized === '/dev' || !normalized.startsWith('/dev/')) return '';
    const deviceName = normalized.slice('/dev/'.length);
    return deviceName.length > 0 && !deviceName.includes('/') ? normalized : '';
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
      const path = normalizeRuntimeKernelDeviceReference(entry.path);
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

  function knownDeviceSet(options) {
    if (options?.knownDevices) return normalizedSet(options.knownDevices);
    return normalizedSet(normalizedDeviceInfos(options?.devices).keys());
  }

  function runtimeKernelDeviceInfo(devices, device) {
    return normalizedDeviceInfos(devices).get(normalizeRuntimeKernelDeviceReference(device)) ?? null;
  }

  function runtimeKernelDeviceInputSource(devices, device) {
    const info = runtimeKernelDeviceInfo(devices, device);
    if (!info?.readable) return '';
    return info.inputDevice || info.path;
  }

  function runtimeKernelDeviceOutputTarget(devices, device) {
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
      if (normalized === path || normalized.startsWith(`${root}/`)) return true;
    }
    return false;
  }

  function runtimeKernelVirtualPathTarget(value, options = {}) {
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
      const knownDevices = knownDeviceSet(options);
      const device = normalizeRuntimeKernelDeviceReference(path);
      if (!device || !knownDevices.has(device)) {
        return { kind: 'device-not-found', path };
      }
      return { kind: 'device-file', path: device };
    }
    return { kind: 'workspace', path };
  }

  function runtimeKernelVirtualMutationTarget(value, options = {}) {
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

  globalThis.TraceRuntimeKernelPolicy = Object.freeze({
    normalizeRuntimeKernelPath,
    isRuntimeKernelProcPath,
    isRuntimeKernelDeviceNamespacePath,
    isRuntimeKernelDeviceDirectory,
    normalizeRuntimeKernelDeviceReference,
    runtimeKernelDeviceInfo,
    runtimeKernelDeviceInputSource,
    runtimeKernelDeviceOutputTarget,
    runtimeKernelVirtualPathTarget,
    runtimeKernelVirtualMutationTarget,
  });
})(typeof self !== 'undefined' ? self : globalThis);

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

  function isRuntimeKernelDeviceDirectory(value, options = {}) {
    return runtimeKernelDeviceEntryKind(options.devices, value) === 'directory';
  }

  function normalizeRuntimeKernelDeviceReference(value) {
    const normalized = normalizeRuntimeKernelPath(value);
    if (normalized === '/dev' || !normalized.startsWith('/dev/')) return '';
    const deviceName = normalized.slice('/dev/'.length);
    return deviceName.length > 0 && !deviceName.includes('/') ? normalized : '';
  }

  function normalizeRuntimeKernelManifestDevicePath(value) {
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

  function runtimeKernelDeviceInfo(devices, device) {
    return normalizedDeviceInfos(devices).get(normalizeRuntimeKernelManifestDevicePath(device)) ?? null;
  }

  function runtimeKernelDeviceDirEntries(devices, value = '/dev', entries = normalizedDeviceInfos(devices)) {
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

  function runtimeKernelDeviceEntryKind(devices, value, entries = normalizedDeviceInfos(devices)) {
    const path = normalizeRuntimeKernelPath(value);
    if (path === '/dev') return 'directory';
    if (!path.startsWith('/dev/')) return '';
    if (entries.has(normalizeRuntimeKernelManifestDevicePath(path))) return 'file';
    return runtimeKernelDeviceDirEntries(devices, path, entries) ? 'directory' : '';
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
      if (normalized === path || normalized === root || normalized.startsWith(`${root}/`)) return true;
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

  function runtimeKernelVirtualOpenTarget(value, request = {}, options = {}) {
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

  const RUNTIME_USER_AUTHORITY_GLOBALS = Object.freeze([
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'WebSocketStream',
    'EventSource',
    'WebTransport',
    'RTCPeerConnection',
    'webkitRTCPeerConnection',
    'RTCDataChannel',
    'indexedDB',
    'caches',
    'Cache',
    'CacheStorage',
    'cookieStore',
    'localStorage',
    'sessionStorage',
    'webkitRequestFileSystem',
    'webkitRequestFileSystemSync',
    'webkitResolveLocalFileSystemURL',
    'webkitResolveLocalFileSystemSyncURL',
    'Worker',
    'SharedWorker',
    'MessageChannel',
    'MessagePort',
    'BroadcastChannel',
    'importScripts',
  ]);
  const RUNTIME_USER_PERMANENT_AUTHORITY_GLOBALS = Object.freeze([
    'postMessage',
  ]);
  const RUNTIME_USER_AUTHORITY_NAVIGATOR_MEMBERS = Object.freeze([
    'sendBeacon',
    'storage',
    'locks',
    'serviceWorker',
  ]);
  const runtimeAuthorityNativeDefineProperty = Object.defineProperty;
  const runtimeAuthorityNativeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const runtimeAuthorityNativeGetPrototypeOf = Object.getPrototypeOf;
  const runtimeAuthorityNativeDeleteProperty = Reflect.deleteProperty;
  const runtimeAuthorityNativeObjectDefineProperties = Object.defineProperties;
  const runtimeAuthorityNativeReflectDefineProperty = Reflect.defineProperty;
  const runtimeAuthorityNativeReflectDeleteProperty = Reflect.deleteProperty;
  const runtimeAuthorityNativeObjectSetPrototypeOf = Object.setPrototypeOf;
  const runtimeAuthorityNativeReflectSetPrototypeOf = Reflect.setPrototypeOf;
  const runtimeAuthorityNativeOwnKeys = Reflect.ownKeys;
  const runtimeAuthorityActiveScopes = new WeakMap();

  function runtimeAuthorityError(name) {
    return Object.assign(
      new Error(`EACCES: ${name} is not available inside TraceKernel browser execution`),
      { code: 'EACCES' }
    );
  }

  function runtimeDeniedAuthority(name) {
    const deny = function traceRuntimeDeniedAuthority() {
      throw runtimeAuthorityError(name);
    };
    if (typeof Proxy !== 'function') return deny;
    return new Proxy(deny, {
      apply: () => deny(),
      construct: () => deny(),
      get: (_target, property) => property === Symbol.toStringTag
        ? 'TraceRuntimeDeniedCapability'
        : runtimeDeniedAuthority(`${name}.${String(property)}`),
      set: () => {
        throw runtimeAuthorityError(name);
      },
    });
  }

  function runtimeAuthorityRestoreDescriptors(records) {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const { target, name, descriptor } = records[index];
      if (descriptor) {
        runtimeAuthorityNativeDefineProperty(target, name, descriptor);
      } else {
        runtimeAuthorityNativeDeleteProperty(target, name);
      }
    }
  }

  function runtimeAuthorityReplaceProperty(records, target, name, value, permanent = false) {
    const descriptor = runtimeAuthorityNativeGetOwnPropertyDescriptor(target, name);
    if (
      descriptor?.configurable === false &&
      !(permanent && 'value' in descriptor && descriptor.writable === true)
    ) {
      if ('value' in descriptor && descriptor.value === value) return;
      throw runtimeAuthorityError(String(name));
    }
    records.push({ target, name, descriptor });
    runtimeAuthorityNativeDefineProperty(target, name, {
      configurable: permanent ? false : descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? false,
      writable: false,
      value,
    });
    if (target[name] !== value) throw runtimeAuthorityError(name);
  }

  function runtimeAuthorityPrototypeChain(value) {
    const targets = [];
    const seen = new Set();
    let current = value;
    while (
      current &&
      (typeof current === 'object' || typeof current === 'function') &&
      !seen.has(current)
    ) {
      targets.push(current);
      seen.add(current);
      current = runtimeAuthorityNativeGetPrototypeOf(current);
    }
    return targets;
  }

  function runtimeAuthorityReplaceAcrossChain(state, value, name, replacement, ensureOwn = true) {
    const targets = runtimeAuthorityPrototypeChain(value);
    let replacedOwn = false;
    for (const target of targets) {
      if (!runtimeAuthorityNativeGetOwnPropertyDescriptor(target, name)) continue;
      runtimeAuthorityReplaceProperty(state.records, target, name, replacement, state.permanent);
      state.protectedProperties.push({ target, name: String(name) });
      if (target === value) replacedOwn = true;
    }
    if (ensureOwn && !replacedOwn) {
      runtimeAuthorityReplaceProperty(state.records, value, name, replacement, state.permanent);
      state.protectedProperties.push({ target: value, name: String(name) });
    }
  }

  function runtimeAuthorityProtectedMutation(state, target, property) {
    const name = String(property);
    for (const protectedProperty of state.protectedProperties) {
      if (protectedProperty.target === target && protectedProperty.name === name) {
        return name;
      }
    }
    return '';
  }

  function runtimeAuthorityInstallMutationGuards(state, scope) {
    const guardedDefineProperty = function guardedDefineProperty(target, property, descriptor) {
      const protectedName = runtimeAuthorityProtectedMutation(state, target, property);
      if (protectedName) throw runtimeAuthorityError(protectedName);
      return runtimeAuthorityNativeDefineProperty(target, property, descriptor);
    };
    const guardedDefineProperties = function guardedDefineProperties(target, descriptors) {
      for (const property of runtimeAuthorityNativeOwnKeys(Object(descriptors))) {
        const protectedName = runtimeAuthorityProtectedMutation(state, target, property);
        if (protectedName) throw runtimeAuthorityError(protectedName);
      }
      return runtimeAuthorityNativeObjectDefineProperties(target, descriptors);
    };
    const guardedReflectDefineProperty = function guardedReflectDefineProperty(target, property, descriptor) {
      const protectedName = runtimeAuthorityProtectedMutation(state, target, property);
      if (protectedName) throw runtimeAuthorityError(protectedName);
      return runtimeAuthorityNativeReflectDefineProperty(target, property, descriptor);
    };
    const guardedReflectDeleteProperty = function guardedReflectDeleteProperty(target, property) {
      const protectedName = runtimeAuthorityProtectedMutation(state, target, property);
      if (protectedName) throw runtimeAuthorityError(protectedName);
      return runtimeAuthorityNativeReflectDeleteProperty(target, property);
    };
    const guardedObjectSetPrototypeOf = function guardedObjectSetPrototypeOf(target, prototype) {
      if (runtimeAuthorityPrototypeChain(scope).includes(target)) throw runtimeAuthorityError('global prototype mutation');
      return runtimeAuthorityNativeObjectSetPrototypeOf(target, prototype);
    };
    const guardedReflectSetPrototypeOf = function guardedReflectSetPrototypeOf(target, prototype) {
      if (runtimeAuthorityPrototypeChain(scope).includes(target)) throw runtimeAuthorityError('global prototype mutation');
      return runtimeAuthorityNativeReflectSetPrototypeOf(target, prototype);
    };

    runtimeAuthorityReplaceProperty(state.records, Object, 'defineProperty', guardedDefineProperty, state.permanent);
    runtimeAuthorityReplaceProperty(state.records, Object, 'defineProperties', guardedDefineProperties, state.permanent);
    runtimeAuthorityReplaceProperty(state.records, Object, 'setPrototypeOf', guardedObjectSetPrototypeOf, state.permanent);
    runtimeAuthorityReplaceProperty(state.records, Reflect, 'defineProperty', guardedReflectDefineProperty, state.permanent);
    runtimeAuthorityReplaceProperty(state.records, Reflect, 'deleteProperty', guardedReflectDeleteProperty, state.permanent);
    runtimeAuthorityReplaceProperty(state.records, Reflect, 'setPrototypeOf', guardedReflectSetPrototypeOf, state.permanent);
    runtimeAuthorityReplaceAcrossChain(state, scope, 'Object', Object);
    runtimeAuthorityReplaceAcrossChain(state, scope, 'Reflect', Reflect);
  }

  function runtimeAuthorityReleaseState(scope, state) {
    state.depth -= 1;
    if (state.depth !== 0) return;
    if (state.permanent) return;
    runtimeAuthorityRestoreDescriptors(state.records);
    if (runtimeAuthorityActiveScopes.get(scope) === state) runtimeAuthorityActiveScopes.delete(scope);
  }

  /**
   * Removes ambient browser authority after a trusted language runtime loads.
   * Reusable trusted workers use temporal restoration by default. Disposable
   * untrusted workers must request permanent mode: it seals every live
   * global/navigator prototype descriptor and never restores authority, so a
   * deferred callback cannot wait out the boundary. Neither mode is an origin-
   * isolation primitive.
   */
  async function withRuntimeUserAuthorityLockdown(callback, options = {}) {
    if (typeof callback !== 'function') {
      throw new TypeError('Runtime user authority lockdown requires a callback.');
    }
    const scope = options.scope ?? globalThis;
    if (!scope || (typeof scope !== 'object' && typeof scope !== 'function')) {
      throw new TypeError('Runtime user authority lockdown requires a worker-like global scope.');
    }
    if (options.mode !== undefined && options.mode !== 'temporary' && options.mode !== 'permanent') {
      throw new TypeError('Runtime user authority lockdown mode must be "temporary" or "permanent".');
    }
    const authorityOverrides = options.authorityOverrides ?? {};
    if (!authorityOverrides || typeof authorityOverrides !== 'object' || Array.isArray(authorityOverrides)) {
      throw new TypeError('Runtime user authority lockdown authorityOverrides must be an object.');
    }
    for (const name of Reflect.ownKeys(authorityOverrides)) {
      if (typeof name !== 'string' || !RUNTIME_USER_AUTHORITY_GLOBALS.includes(name)) {
        throw new TypeError(`Runtime user authority lockdown cannot override unsupported authority "${String(name)}".`);
      }
    }
    const permanent = options.mode === 'permanent';
    const activeState = runtimeAuthorityActiveScopes.get(scope);
    if (activeState) {
      if (permanent && activeState.permanent !== true) {
        throw new Error('Runtime user authority lockdown cannot upgrade an active temporal boundary to permanent mode.');
      }
      activeState.depth += 1;
      try {
        return await callback();
      } finally {
        runtimeAuthorityReleaseState(scope, activeState);
      }
    }

    const state = {
      depth: 1,
      records: [],
      protectedProperties: [],
      permanent,
    };
    runtimeAuthorityActiveScopes.set(scope, state);
      try {
        for (const name of RUNTIME_USER_AUTHORITY_GLOBALS) {
        const replacement = Object.prototype.hasOwnProperty.call(authorityOverrides, name)
          ? authorityOverrides[name]
          : runtimeDeniedAuthority(name);
        runtimeAuthorityReplaceAcrossChain(state, scope, name, replacement);
      }
      if (state.permanent) {
        for (const name of RUNTIME_USER_PERMANENT_AUTHORITY_GLOBALS) {
          runtimeAuthorityReplaceAcrossChain(state, scope, name, runtimeDeniedAuthority(name));
        }
      }
      const navigatorValue = scope.navigator;
      if (navigatorValue && (typeof navigatorValue === 'object' || typeof navigatorValue === 'function')) {
        for (const name of RUNTIME_USER_AUTHORITY_NAVIGATOR_MEMBERS) {
          runtimeAuthorityReplaceAcrossChain(
            state,
            navigatorValue,
            name,
            runtimeDeniedAuthority(`navigator.${name}`),
            true
          );
        }
        runtimeAuthorityReplaceAcrossChain(state, scope, 'navigator', navigatorValue);
      }
      runtimeAuthorityInstallMutationGuards(state, scope);
      return await callback();
    } finally {
      runtimeAuthorityReleaseState(scope, state);
    }
  }

  Object.defineProperty(globalThis, 'TraceRuntimeKernelPolicy', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
    normalizeRuntimeKernelPath,
    isRuntimeKernelProcPath,
    isRuntimeKernelDeviceNamespacePath,
    isRuntimeKernelDeviceDirectory,
    normalizeRuntimeKernelDeviceReference,
    normalizeRuntimeKernelManifestDevicePath,
    runtimeKernelDeviceInfo,
    runtimeKernelDeviceDirEntries,
    runtimeKernelDeviceEntryKind,
    runtimeKernelDeviceInputSource,
    runtimeKernelDeviceOutputTarget,
    runtimeKernelVirtualPathTarget,
    runtimeKernelVirtualMutationTarget,
    runtimeKernelVirtualOpenTarget,
    withRuntimeUserAuthorityLockdown,
    }),
  });
})(typeof self !== 'undefined' ? self : globalThis);

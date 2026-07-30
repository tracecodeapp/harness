import {
  BrowserFunction,
} from "../modules/constructors";

import {
  createBrowserEventLoopApi,
} from "../node-compat/event-loop";

import {
  createHttpApi,
} from "../node-compat/network";

export const permanentBrowserAuthorityDefineProperty = Object.defineProperty;

export const permanentBrowserAuthorityGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

export const permanentBrowserAuthorityGetPrototypeOf = Object.getPrototypeOf;

export const PERMANENT_BROWSER_WORKER_DENIED_GLOBALS = Object.freeze([
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'WebTransport',
  'EventSource',
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
  'postMessage',
  'eval',
  'Function',
]);

export const PERMANENT_BROWSER_WORKER_DENIED_NAVIGATOR_MEMBERS = Object.freeze([
  'sendBeacon',
  'storage',
  'locks',
  'serviceWorker',
]);

export const permanentBrowserDynamicConstructorPrototypes = Object.freeze([
  BrowserFunction.prototype,
  permanentBrowserAuthorityGetPrototypeOf(async function browserAsyncFunction() {}),
  permanentBrowserAuthorityGetPrototypeOf(function* browserGeneratorFunction() {}),
  permanentBrowserAuthorityGetPrototypeOf(async function* browserAsyncGeneratorFunction() {}),
]);

export function permanentBrowserAuthorityError(name: string): Error {
  return new ReferenceError(`${name} is not defined`);
}

export function permanentBrowserDeniedAuthority(name: string): unknown {
  const deny = function deniedBrowserWorkerAuthority(): never {
    throw permanentBrowserAuthorityError(name);
  };
  return typeof Proxy === 'function'
    ? new Proxy(deny, {
        apply: () => deny(),
        construct: () => deny(),
        get: (_target, property) => property === Symbol.toStringTag
          ? 'Function'
          : permanentBrowserDeniedAuthority(`${name}.${String(property)}`),
        set: () => {
          throw permanentBrowserAuthorityError(name);
        },
      })
    : deny;
}

export function permanentBrowserPrototypeChain(value: unknown): object[] {
  const targets: object[] = [];
  const seen = new Set<object>();
  let current = value;
  while (
    current &&
    (typeof current === 'object' || typeof current === 'function') &&
    !seen.has(current as object)
  ) {
    targets.push(current as object);
    seen.add(current as object);
    current = permanentBrowserAuthorityGetPrototypeOf(current);
  }
  return targets;
}

export function sealPermanentBrowserProperty(target: object, name: PropertyKey, value: unknown): void {
  const descriptor = permanentBrowserAuthorityGetOwnPropertyDescriptor(target, name);
  if (
    descriptor?.configurable === false &&
    !('value' in descriptor && descriptor.writable === true)
  ) {
    if ('value' in descriptor && descriptor.value === value) return;
    throw permanentBrowserAuthorityError(String(name));
  }
  permanentBrowserAuthorityDefineProperty(target, name, {
    configurable: false,
    enumerable: descriptor?.enumerable ?? false,
    writable: false,
    value,
  });
  if ((target as Record<PropertyKey, unknown>)[name] !== value) {
    throw permanentBrowserAuthorityError(String(name));
  }
}

export function sealPermanentBrowserPropertyAcrossChain(
  value: unknown,
  name: string,
  replacement: unknown,
  options: { includeOwn?: boolean; ensureOwn?: boolean } = {}
): void {
  const targets = permanentBrowserPrototypeChain(value);
  const includeOwn = options.includeOwn !== false;
  let replacedOwn = false;
  for (let index = includeOwn ? 0 : 1; index < targets.length; index += 1) {
    const target = targets[index];
    if (!permanentBrowserAuthorityGetOwnPropertyDescriptor(target, name)) continue;
    sealPermanentBrowserProperty(target, name, replacement);
    if (target === value) replacedOwn = true;
  }
  if (includeOwn && options.ensureOwn !== false && !replacedOwn) {
    sealPermanentBrowserProperty(value as object, name, replacement);
  }
}

export function installPermanentBrowserWorkerAuthorityBoundary(
  httpApi: ReturnType<typeof createHttpApi>
): () => void {
  if (typeof document !== 'undefined') {
    throw new Error('Permanent browser authority denial is only valid inside a disposable worker.');
  }
  const scope = globalThis as typeof globalThis & Record<string, unknown>;
  for (const name of PERMANENT_BROWSER_WORKER_DENIED_GLOBALS) {
    sealPermanentBrowserPropertyAcrossChain(scope, name, permanentBrowserDeniedAuthority(name));
  }
  const deniedNativeFetch = permanentBrowserDeniedAuthority('native fetch');
  sealPermanentBrowserPropertyAcrossChain(scope, 'fetch', deniedNativeFetch, {
    includeOwn: false,
    ensureOwn: false,
  });
  sealPermanentBrowserProperty(scope, 'fetch', httpApi.fetch);
  sealPermanentBrowserProperty(scope, 'Headers', httpApi.Headers);
  sealPermanentBrowserProperty(scope, 'Request', httpApi.Request);
  sealPermanentBrowserProperty(scope, 'Response', httpApi.Response);

  const navigatorValue = scope.navigator;
  if (navigatorValue && (typeof navigatorValue === 'object' || typeof navigatorValue === 'function')) {
    for (const name of PERMANENT_BROWSER_WORKER_DENIED_NAVIGATOR_MEMBERS) {
      sealPermanentBrowserPropertyAcrossChain(
        navigatorValue,
        name,
        permanentBrowserDeniedAuthority(`navigator.${name}`)
      );
    }
    sealPermanentBrowserProperty(scope, 'navigator', navigatorValue);
  }

  const deniedConstructor = permanentBrowserDeniedAuthority('Function constructor');
  for (const prototype of permanentBrowserDynamicConstructorPrototypes) {
    sealPermanentBrowserProperty(prototype, 'constructor', deniedConstructor);
  }
  return () => {
    // Disposable worker authority is intentionally non-restoring.
  };
}

export function installBrowserHttpGlobalLockdown(
  httpApi: ReturnType<typeof createHttpApi>,
  authorityMode: 'temporary' | 'permanent' = 'temporary'
): () => void {
  if (authorityMode === 'permanent') {
    return installPermanentBrowserWorkerAuthorityBoundary(httpApi);
  }
  const global = globalThis as typeof globalThis & Record<string, unknown>;
  const blockedNetworkApi = (name: string) => function blockedBrowserNetworkApi(): never {
    throw new ReferenceError(`${name} is not defined`);
  };
  const blockedAuthorityObject = (name: string): unknown => {
    const deny = blockedNetworkApi(name);
    return typeof Proxy === 'function'
      ? new Proxy(deny, {
          apply: () => deny(),
          construct: () => deny(),
          get: (_target, property) => property === Symbol.toStringTag ? 'Function' : deny,
        })
      : deny;
  };
  const replacements: Record<string, unknown> = {
    fetch: httpApi.fetch,
    Headers: httpApi.Headers,
    Request: httpApi.Request,
    Response: httpApi.Response,
    XMLHttpRequest: blockedAuthorityObject('XMLHttpRequest'),
    WebSocket: blockedAuthorityObject('WebSocket'),
    WebSocketStream: blockedAuthorityObject('WebSocketStream'),
    WebTransport: blockedAuthorityObject('WebTransport'),
    EventSource: blockedAuthorityObject('EventSource'),
    // A dedicated Worker is an execution boundary, not an origin boundary.
    // User code must not bypass TraceKernel through same-origin persistence,
    // cache, nested workers, or cross-context messaging. The worker bridge
    // captures the host channel before this lockdown is installed.
    ...(typeof document === 'undefined'
      ? {
          indexedDB: blockedAuthorityObject('indexedDB'),
          caches: blockedAuthorityObject('caches'),
          cookieStore: blockedAuthorityObject('cookieStore'),
          Worker: blockedAuthorityObject('Worker'),
          SharedWorker: blockedAuthorityObject('SharedWorker'),
          BroadcastChannel: blockedAuthorityObject('BroadcastChannel'),
          importScripts: blockedAuthorityObject('importScripts'),
        }
      : {}),
  };
  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(replacements)) {
    previousDescriptors.set(name, Object.getOwnPropertyDescriptor(global, name));
    try {
      Object.defineProperty(global, name, {
        configurable: true,
        enumerable: false,
        writable: false,
        value,
      });
    } catch {
      // Same-realm execution is best-effort; worker-backed execution remains the stronger boundary.
    }
  }
  const navigatorValue = global.navigator;
  const navigatorDescriptors = new Map<string, PropertyDescriptor | undefined>();
  if (navigatorValue && typeof navigatorValue === 'object') {
    const navigatorReplacements: Record<string, unknown> = {
      sendBeacon: blockedAuthorityObject('navigator.sendBeacon'),
      ...(typeof document === 'undefined'
        ? {
            storage: blockedAuthorityObject('navigator.storage'),
            locks: blockedAuthorityObject('navigator.locks'),
            serviceWorker: blockedAuthorityObject('navigator.serviceWorker'),
          }
        : {}),
    };
    for (const [name, value] of Object.entries(navigatorReplacements)) {
      navigatorDescriptors.set(name, Object.getOwnPropertyDescriptor(navigatorValue, name));
      try {
        Object.defineProperty(navigatorValue, name, {
          configurable: true,
          enumerable: false,
          writable: false,
          value,
        });
      } catch {
        // Ignore read-only host navigator implementations.
      }
    }
  }
  return () => {
    for (const [name, descriptor] of previousDescriptors) {
      try {
        if (descriptor) {
          Object.defineProperty(global, name, descriptor);
        } else {
          delete global[name];
        }
      } catch {
        // User code can still poison same-realm globals; later executions should prefer worker-backed mode.
      }
    }
    if (navigatorValue && typeof navigatorValue === 'object') {
      for (const [name, descriptor] of navigatorDescriptors) {
        try {
          if (descriptor) {
            Object.defineProperty(navigatorValue, name, descriptor);
          } else {
            delete (navigatorValue as unknown as Record<string, unknown>)[name];
          }
        } catch {
          // Ignore read-only host navigator implementations.
        }
      }
    }
  };
}

export function installBrowserTimerGlobals(eventLoopApi: ReturnType<typeof createBrowserEventLoopApi>): () => void {
  const global = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    setTimeout: eventLoopApi.setTimeout,
    clearTimeout: eventLoopApi.clearTimeout,
    setInterval: eventLoopApi.setInterval,
    clearInterval: eventLoopApi.clearInterval,
    setImmediate: eventLoopApi.setImmediate,
    clearImmediate: eventLoopApi.clearImmediate,
    queueMicrotask: eventLoopApi.queueMicrotask,
  };
  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(replacements)) {
    previousDescriptors.set(name, Object.getOwnPropertyDescriptor(global, name));
    try {
      Object.defineProperty(global, name, {
        configurable: true,
        enumerable: false,
        writable: true,
        value,
      });
    } catch {
      // Same-realm execution is best-effort; worker-backed execution remains the stronger boundary.
    }
  }
  return () => {
    for (const [name, descriptor] of previousDescriptors) {
      try {
        if (descriptor) {
          Object.defineProperty(global, name, descriptor);
        } else {
          delete global[name];
        }
      } catch {
        // User code can still poison same-realm globals; later executions should prefer worker-backed mode.
      }
    }
  };
}

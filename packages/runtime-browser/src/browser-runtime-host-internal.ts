import type {
  Language,
  RuntimePreparedExecutionProvider,
} from '@tracecode/runtime-core';
import type { BrowserRuntimeHost } from './browser-runtime-host';

type PreparedProviderResolver = (
  language: Language
) => RuntimePreparedExecutionProvider;

/*
 * BrowserRuntimeHost and Judge are separate package entrypoints. ESM builds
 * share this module through an emitted chunk, but CommonJS entrypoints are
 * intentionally self-contained. Keep the WeakMap on a non-enumerable global
 * symbol so genuine hosts retain their identity across both bundle formats.
 */
const PREPARED_PROVIDER_RESOLVERS = Symbol.for(
  '@tracecode/runtime-browser/internal/prepared-provider-resolvers'
);

function preparedProviderResolvers(): WeakMap<
  object,
  PreparedProviderResolver
> {
  const globalRecord = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globalRecord[PREPARED_PROVIDER_RESOLVERS];
  if (existing !== undefined) {
    if (!(existing instanceof WeakMap)) {
      throw new Error(
        'Browser runtime host provider registry was initialized with an invalid value.'
      );
    }
    return existing as WeakMap<object, PreparedProviderResolver>;
  }

  const resolvers = new WeakMap<object, PreparedProviderResolver>();
  Object.defineProperty(globalRecord, PREPARED_PROVIDER_RESOLVERS, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: resolvers,
  });
  return resolvers;
}

const resolvers = preparedProviderResolvers();

export function registerBrowserRuntimeHostPreparedProviderResolver(
  host: BrowserRuntimeHost,
  resolve: PreparedProviderResolver
): void {
  if (resolvers.has(host)) {
    throw new Error('Browser runtime host was registered more than once.');
  }
  resolvers.set(host, resolve);
}

export function getBrowserRuntimeHostPreparedProvider(
  host: BrowserRuntimeHost,
  language: Language
): RuntimePreparedExecutionProvider {
  const resolve =
    (typeof host === 'object' && host !== null) ||
      typeof host === 'function'
      ? resolvers.get(host)
      : undefined;
  if (!resolve) {
    throw new TypeError(
      'Browser runtime Judge requires a genuine BrowserRuntimeHost created by createBrowserRuntimeHost().'
    );
  }
  return resolve(language);
}

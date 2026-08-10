import type {
  BrowserRuntimeAssetDescriptor,
  BrowserRuntimeAssetManifest,
} from '../../runtime-browser/src/runtime-assets';
import {
  TRACECC_RUNTIME_ASSETS,
  TRACECC_RUNTIME_CONTENT_HASH,
} from './tracecc-runtime-assets.generated';

export { TRACECC_RUNTIME_CONTENT_HASH } from './tracecc-runtime-assets.generated';

/**
 * Relative path beneath the deployment's generic browser-worker asset root.
 *
 * TraceCC artifacts are published under this content-addressed directory. It
 * deliberately includes the consumer hash rather than the upstream toolchain
 * version: the directory also contains the Harness-owned runtime header and
 * PCH/object shards.
 */
export const TRACECC_RUNTIME_ASSET_RELATIVE_PATH =
  `cpp/tracecc/${TRACECC_RUNTIME_CONTENT_HASH}`;

interface TraceCCAssetIdentity {
  readonly fileName: string;
  readonly integrity: `sha256-${string}`;
  readonly mediaType: string;
  readonly size: number;
}

const typedTraceCCRuntimeAssets = TRACECC_RUNTIME_ASSETS satisfies Readonly<
  Record<string, TraceCCAssetIdentity>
>;

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeAssetBaseUrl(value: string): string {
  const normalized = stripTrailingSlash(value.trim());
  if (!normalized) {
    throw new TypeError('TraceCC requires a non-empty asset base URL.');
  }
  if (/[?#]/u.test(normalized)) {
    throw new TypeError(
      'TraceCC asset base URL must be a directory without a query or fragment.'
    );
  }
  return normalized;
}

function normalizeWorkerUrl(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError('TraceCC worker URL must not be empty.');
  }
  return normalized;
}

function descriptor(
  asset: TraceCCAssetIdentity
): BrowserRuntimeAssetDescriptor {
  return {
    url: asset.fileName,
    integrity: asset.integrity,
    mediaType: asset.mediaType,
    size: asset.size,
    delivery: {
      mutability: 'immutable',
      address: 'content',
    },
  };
}

/**
 * Creates the immutable C++ runtime manifest for the pinned TraceCC release.
 *
 * TraceCC owns the generic compiler and sysroot release. This manifest remains
 * harness-owned because it also pins the TraceCode runtime header, PCH shards,
 * and runtime objects that must match the generated drivers in this package.
 */
export function createTraceCCRuntimeManifest(
  assetBaseUrl: string,
  options: { readonly workerUrl?: string } = {}
): BrowserRuntimeAssetManifest<'cpp'> {
  const normalizedAssetBaseUrl = normalizeAssetBaseUrl(assetBaseUrl);
  const workerUrl = normalizeWorkerUrl(
    options.workerUrl ?? '/workers/cpp-worker.js'
  );
  const compilerWasm = descriptor(
    typedTraceCCRuntimeAssets.compilerWasm
  );
  return {
    runtime: 'cpp',
    runtimeVersion:
      `tracecc-${TRACECC_RUNTIME_CONTENT_HASH.slice(0, 12)}`,
    protocolVersion: 'browser-runtime-assets-v1',
    assetBaseUrl: `${normalizedAssetBaseUrl}/`,
    workerFormat: 'module',
    assets: {
      worker: { url: workerUrl },
      runtimeHeader: descriptor(typedTraceCCRuntimeAssets.runtimeHeader),
      compilerWasm,
      linkerWasm: compilerWasm,
      sysroot: descriptor(typedTraceCCRuntimeAssets.sysroot),
      compilerResources: {
        'tracecc-narrow-pch': descriptor(
          typedTraceCCRuntimeAssets.narrowPch
        ),
        'tracecc-narrow-pch-source': descriptor(
          typedTraceCCRuntimeAssets.narrowPchSource
        ),
        'tracecc-narrow-runtime-object': descriptor(
          typedTraceCCRuntimeAssets.narrowRuntimeObject
        ),
        'tracecc-broad-pch': descriptor(
          typedTraceCCRuntimeAssets.broadPch
        ),
        'tracecc-broad-pch-source': descriptor(
          typedTraceCCRuntimeAssets.broadPchSource
        ),
        'tracecc-broad-runtime-object': descriptor(
          typedTraceCCRuntimeAssets.broadRuntimeObject
        ),
        'tracecc-map-pch': descriptor(
          typedTraceCCRuntimeAssets.mapPch
        ),
        'tracecc-map-pch-source': descriptor(
          typedTraceCCRuntimeAssets.mapPchSource
        ),
        'tracecc-map-runtime-object': descriptor(
          typedTraceCCRuntimeAssets.mapRuntimeObject
        ),
      },
    },
  };
}

/**
 * Resolves the built-in TraceCC manifest from the generic browser asset root.
 *
 * The normal deployment serves all browser assets beneath `/workers`; the
 * immutable TraceCC release is then addressed at
 * `/workers/cpp/tracecc/<consumer-hash>/`, while the C++ worker is served at
 * `/workers/cpp-worker.js`. Consumers that publish the release elsewhere can
 * pass their own generic root; both paths move together. For callers that need
 * to provide a fully custom manifest, `createTraceCCRuntimeManifest` remains
 * available with an explicit worker URL override.
 */
export function resolveBuiltInTraceCCRuntimeManifest(
  assetBaseUrl = '/workers'
): BrowserRuntimeAssetManifest<'cpp'> {
  const normalizedAssetBaseUrl = normalizeAssetBaseUrl(assetBaseUrl);
  return createTraceCCRuntimeManifest(
    `${normalizedAssetBaseUrl}/${TRACECC_RUNTIME_ASSET_RELATIVE_PATH}`,
    { workerUrl: `${normalizedAssetBaseUrl}/cpp-worker.js` }
  );
}

/** The pinned fb4 TraceCC manifest for the standard `/workers` deployment. */
export const TRACECC_RUNTIME_MANIFEST =
  resolveBuiltInTraceCCRuntimeManifest();

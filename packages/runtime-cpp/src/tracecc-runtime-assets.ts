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
  assetBaseUrl: string
): BrowserRuntimeAssetManifest<'cpp'> {
  const normalizedAssetBaseUrl = stripTrailingSlash(assetBaseUrl.trim());
  if (!normalizedAssetBaseUrl) {
    throw new TypeError('TraceCC requires a non-empty asset base URL.');
  }
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
      worker: { url: '/workers/cpp-worker.js' },
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
 * `/workers/cpp/tracecc/<consumer-hash>/`. Consumers that publish the release
 * elsewhere can pass their own generic root. For callers that need to provide
 * a fully custom manifest, `createTraceCCRuntimeManifest` remains available.
 */
export function resolveBuiltInTraceCCRuntimeManifest(
  assetBaseUrl = '/workers'
): BrowserRuntimeAssetManifest<'cpp'> {
  const normalizedAssetBaseUrl = stripTrailingSlash(assetBaseUrl.trim());
  if (!normalizedAssetBaseUrl) {
    throw new TypeError('TraceCC requires a non-empty asset base URL.');
  }
  return createTraceCCRuntimeManifest(
    `${normalizedAssetBaseUrl}/${TRACECC_RUNTIME_ASSET_RELATIVE_PATH}`
  );
}

/** The pinned fb4 TraceCC manifest for the standard `/workers` deployment. */
export const TRACECC_RUNTIME_MANIFEST =
  resolveBuiltInTraceCCRuntimeManifest();

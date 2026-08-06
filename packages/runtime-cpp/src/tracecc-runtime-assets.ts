import type {
  BrowserRuntimeAssetDescriptor,
  BrowserRuntimeAssetManifest,
} from '../../runtime-browser/src/runtime-assets';

export const TRACECC_RUNTIME_CONTENT_HASH =
  '1f50b24524b84b65663aa2fde85c97661a095f438596ffc916c000a6bfe450ca';

interface TraceCCAssetIdentity {
  readonly fileName: string;
  readonly integrity: `sha256-${string}`;
  readonly mediaType: string;
  readonly size: number;
}

const TRACECC_RUNTIME_ASSETS = {
  runtimeHeader: {
    fileName: 'tracecode_runtime.hpp',
    integrity: 'sha256-TeNf7Pwat/nfdgTgoacXj6yjVLIlf6x/cpe0kQCLfCU=',
    mediaType: 'text/plain',
    size: 260_396,
  },
  compilerWasm: {
    fileName: 'tracecc-reactor.wasm',
    integrity: 'sha256-At40hCU4Rmvynp1s8UzQ1eX/UZybo5BWHMsVgQXUTUE=',
    mediaType: 'application/wasm',
    size: 33_478_188,
  },
  sysroot: {
    fileName: 'llvm-resources.tar',
    integrity: 'sha256-2V0qK8hAihbAdEmWrEfJG7PGO7cblDFcl5YIm23ahVU=',
    mediaType: 'application/x-tar',
    size: 29_112_320,
  },
  narrowPch: {
    fileName: 'narrow.pch',
    integrity: 'sha256-/EMxTWLaq7IR1rXgSuhgPkd3ORMYdn9EJWqF631lDk0=',
    mediaType: 'application/octet-stream',
    size: 21_315_532,
  },
  narrowPchSource: {
    fileName: 'narrow.source.hpp',
    integrity: 'sha256-SMqxQfcMBSUHUcAz+7Cp4vkWyOtgv7mNB09JE1cOEAU=',
    mediaType: 'text/plain',
    size: 815,
  },
  narrowRuntimeObject: {
    fileName: 'narrow.o',
    integrity: 'sha256-9WUqAzMQSnFENUfzy2B9fXZ87CLx6PR9vWAQHphBRuA=',
    mediaType: 'application/wasm',
    size: 1_041_990,
  },
  broadPch: {
    fileName: 'broad.pch',
    integrity: 'sha256-tL6cukAxxZiBWTbpDrTcg3xcQ52Ay3+BynyfUwVx/h4=',
    mediaType: 'application/octet-stream',
    size: 24_536_976,
  },
  broadPchSource: {
    fileName: 'broad.source.hpp',
    integrity: 'sha256-MOayycWl5KYaLS8vP2MoJh4kazsDhg0kH9Bi6dvsy0s=',
    mediaType: 'text/plain',
    size: 7095,
  },
  broadRuntimeObject: {
    fileName: 'broad.o',
    integrity: 'sha256-MXZ0vPguPFcIIpZp+btq3IF/PebB3I18jIEUFHMeACw=',
    mediaType: 'application/wasm',
    size: 1_892_299,
  },
  mapPch: {
    fileName: 'map.pch',
    integrity: 'sha256-ylUEb41yHjigdKgzJLGIm/HBQ/tzMB9UPgX0F1XkhNk=',
    mediaType: 'application/octet-stream',
    size: 29_915_372,
  },
  mapPchSource: {
    fileName: 'map.source.hpp',
    integrity: 'sha256-WHaMpx3nG/h1ro6CppBseoDIkgqahbYnFxShHLGT9/c=',
    mediaType: 'text/plain',
    size: 10_708,
  },
  mapRuntimeObject: {
    fileName: 'map.o',
    integrity: 'sha256-DnvgcziANh5qdGPKUPZ1+McTQLyjFbXZrGRoCcxM5TY=',
    mediaType: 'application/wasm',
    size: 3_366_043,
  },
} as const satisfies Readonly<Record<string, TraceCCAssetIdentity>>;

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
    throw new TypeError('TraceCC v9r1 requires a non-empty asset base URL.');
  }
  const compilerWasm = descriptor(
    TRACECC_RUNTIME_ASSETS.compilerWasm
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
      runtimeHeader: descriptor(TRACECC_RUNTIME_ASSETS.runtimeHeader),
      compilerWasm,
      linkerWasm: compilerWasm,
      sysroot: descriptor(TRACECC_RUNTIME_ASSETS.sysroot),
      compilerResources: {
        'tracecc-narrow-pch': descriptor(
          TRACECC_RUNTIME_ASSETS.narrowPch
        ),
        'tracecc-narrow-pch-source': descriptor(
          TRACECC_RUNTIME_ASSETS.narrowPchSource
        ),
        'tracecc-narrow-runtime-object': descriptor(
          TRACECC_RUNTIME_ASSETS.narrowRuntimeObject
        ),
        'tracecc-broad-pch': descriptor(
          TRACECC_RUNTIME_ASSETS.broadPch
        ),
        'tracecc-broad-pch-source': descriptor(
          TRACECC_RUNTIME_ASSETS.broadPchSource
        ),
        'tracecc-broad-runtime-object': descriptor(
          TRACECC_RUNTIME_ASSETS.broadRuntimeObject
        ),
        'tracecc-map-pch': descriptor(
          TRACECC_RUNTIME_ASSETS.mapPch
        ),
        'tracecc-map-pch-source': descriptor(
          TRACECC_RUNTIME_ASSETS.mapPchSource
        ),
        'tracecc-map-runtime-object': descriptor(
          TRACECC_RUNTIME_ASSETS.mapRuntimeObject
        ),
      },
    },
  };
}

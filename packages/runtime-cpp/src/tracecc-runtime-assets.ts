import type {
  BrowserRuntimeAssetDescriptor,
  BrowserRuntimeAssetManifest,
} from '../../runtime-browser/src/runtime-assets';

export const TRACECC_RUNTIME_CONTENT_HASH =
  'd281ef0cfebe48f7ea9fb7543443839b9967e2b51da8dc5c8b750126a1c405fd';

interface TraceCCAssetIdentity {
  readonly fileName: string;
  readonly integrity: `sha256-${string}`;
  readonly mediaType: string;
  readonly size: number;
}

const TRACECC_RUNTIME_ASSETS = {
  runtimeHeader: {
    fileName: 'tracecode_runtime.hpp',
    integrity: 'sha256-GJgPOU8w+OamwzFHDckuMqwR+4tUM147R2bo7/7+G4k=',
    mediaType: 'text/plain',
    size: 262_424,
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
    integrity: 'sha256-aJIvoFLpA0bw3tLuEIh7oBe9WinVvZSPgEyTPCJh1YQ=',
    mediaType: 'application/octet-stream',
    size: 21_320_088,
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
    integrity: 'sha256-NxT61GlGOV9baF2Otz4VSry/U+4ZV62lwNbBr6rGNyc=',
    mediaType: 'application/octet-stream',
    size: 24_541_412,
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
    integrity: 'sha256-TCOBNvfZOWtO5mg0OuzP/eXgLegJORSg+g7VPuLdGQo=',
    mediaType: 'application/octet-stream',
    size: 29_948_616,
  },
  mapPchSource: {
    fileName: 'map.source.hpp',
    integrity: 'sha256-WHaMpx3nG/h1ro6CppBseoDIkgqahbYnFxShHLGT9/c=',
    mediaType: 'text/plain',
    size: 10_708,
  },
  mapRuntimeObject: {
    fileName: 'map.o',
    integrity: 'sha256-ToS0m1JL9HeJdEhXohXo66kviZiVDYAE34RyKQzqFaM=',
    mediaType: 'application/wasm',
    size: 3_371_878,
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

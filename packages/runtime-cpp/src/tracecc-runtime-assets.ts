import type {
  BrowserRuntimeAssetDescriptor,
  BrowserRuntimeAssetManifest,
} from '../../runtime-browser/src/runtime-assets';

export const TRACECC_RUNTIME_CONTENT_HASH =
  'e9457f3a87621f0f6a034c3a18b7e6374c838c226a42215236136d162858807f';

interface TraceCCAssetIdentity {
  readonly fileName: string;
  readonly integrity: `sha256-${string}`;
  readonly mediaType: string;
  readonly size: number;
}

const TRACECC_RUNTIME_ASSETS = {
  runtimeHeader: {
    fileName: 'tracecode_runtime.hpp',
    integrity: 'sha256-Oyj18yszTgnOVJbheZHMMC0Pz0zci3yC6gHDhbPIY68=',
    mediaType: 'text/plain',
    size: 251_172,
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
    integrity: 'sha256-V6ZNistXVJqfGtQB2Uku7p40i3f0SLiRH7oDx43DdmA=',
    mediaType: 'application/octet-stream',
    size: 21_296_076,
  },
  narrowPchSource: {
    fileName: 'narrow.source.hpp',
    integrity: 'sha256-SMqxQfcMBSUHUcAz+7Cp4vkWyOtgv7mNB09JE1cOEAU=',
    mediaType: 'text/plain',
    size: 815,
  },
  narrowRuntimeObject: {
    fileName: 'narrow.o',
    integrity: 'sha256-ny1X8gtLJY2zzWMw2c06gMIv/PDthGetYuXoQj39lQA=',
    mediaType: 'application/wasm',
    size: 1_036_744,
  },
  broadPch: {
    fileName: 'broad.pch',
    integrity: 'sha256-9zwv83WN6KIKXrirfmE82XkzfNkec/evQfs7MFQZHjs=',
    mediaType: 'application/octet-stream',
    size: 24_505_572,
  },
  broadPchSource: {
    fileName: 'broad.source.hpp',
    integrity: 'sha256-MOayycWl5KYaLS8vP2MoJh4kazsDhg0kH9Bi6dvsy0s=',
    mediaType: 'text/plain',
    size: 7_095,
  },
  broadRuntimeObject: {
    fileName: 'broad.o',
    integrity: 'sha256-RCPAYW8fu+bdgc0/mKgZsJZU/m9hVdlF5n5oReBXDCU=',
    mediaType: 'application/wasm',
    size: 1_879_251,
  },
  mapPch: {
    fileName: 'map.pch',
    integrity: 'sha256-8dt6HEfc65XhhXDunS5ytvNbYfcZNH/gKBfgTw7PSGQ=',
    mediaType: 'application/octet-stream',
    size: 29_874_016,
  },
  mapPchSource: {
    fileName: 'map.source.hpp',
    integrity: 'sha256-WHaMpx3nG/h1ro6CppBseoDIkgqahbYnFxShHLGT9/c=',
    mediaType: 'text/plain',
    size: 10_708,
  },
  mapRuntimeObject: {
    fileName: 'map.o',
    integrity: 'sha256-PLpBVFrMQu9DDydeKVtjv1X1wZ6rC2EopXSvrw3nAeE=',
    mediaType: 'application/wasm',
    size: 3_346_406,
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

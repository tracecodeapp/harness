import type {
  BrowserRuntimeAssetDescriptor,
  BrowserRuntimeAssetManifest,
} from '../../runtime-browser/src/runtime-assets';

export const TRACECC_RUNTIME_CONTENT_HASH =
  'fb4b6f41f9e9b7db89b6c8425bb2c6218979219a4150f96619b6461b4b78d294';

interface TraceCCAssetIdentity {
  readonly fileName: string;
  readonly integrity: `sha256-${string}`;
  readonly mediaType: string;
  readonly size: number;
}

const TRACECC_RUNTIME_ASSETS = {
  runtimeHeader: {
    fileName: 'tracecode_runtime.hpp',
    integrity: 'sha256-WEbB8mLN8cwKIWPf25UL7yoTSM9nCqWs8MkE0B14EtE=',
    mediaType: 'text/plain',
    size: 263_083,
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
    integrity: 'sha256-rbuVm7YeO+HwDpSJPAqGGNrrPKeJveazS/juUWXs5/A=',
    mediaType: 'application/octet-stream',
    size: 21_322_216,
  },
  narrowPchSource: {
    fileName: 'narrow.source.hpp',
    integrity: 'sha256-SMqxQfcMBSUHUcAz+7Cp4vkWyOtgv7mNB09JE1cOEAU=',
    mediaType: 'text/plain',
    size: 815,
  },
  narrowRuntimeObject: {
    fileName: 'narrow.o',
    integrity: 'sha256-il/wX66FvAU9SJSiDepMuEZ00CipED4EEEfqcdxEg8c=',
    mediaType: 'application/wasm',
    size: 1_042_570,
  },
  broadPch: {
    fileName: 'broad.pch',
    integrity: 'sha256-ktKxBSglo50GPM9GJJwBpqyYDcFHkKGjoyEtsUmLMrI=',
    mediaType: 'application/octet-stream',
    size: 24_543_552,
  },
  broadPchSource: {
    fileName: 'broad.source.hpp',
    integrity: 'sha256-MOayycWl5KYaLS8vP2MoJh4kazsDhg0kH9Bi6dvsy0s=',
    mediaType: 'text/plain',
    size: 7095,
  },
  broadRuntimeObject: {
    fileName: 'broad.o',
    integrity: 'sha256-f69Oe7kRn9JEIUEPgM1cuYbf50oph4IxEnVP7VIZGp4=',
    mediaType: 'application/wasm',
    size: 1_892_879,
  },
  mapPch: {
    fileName: 'map.pch',
    integrity: 'sha256-fX7zTmJXnRJ2acbDiJ4Wu7/xf1G510SB2fLzkTgr2Uc=',
    mediaType: 'application/octet-stream',
    size: 29_951_380,
  },
  mapPchSource: {
    fileName: 'map.source.hpp',
    integrity: 'sha256-WHaMpx3nG/h1ro6CppBseoDIkgqahbYnFxShHLGT9/c=',
    mediaType: 'text/plain',
    size: 10_708,
  },
  mapRuntimeObject: {
    fileName: 'map.o',
    integrity: 'sha256-02ktvX6uqV05it5kdBEm/ncOszBeO43wX93Yk079E4U=',
    mediaType: 'application/wasm',
    size: 3_372_458,
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

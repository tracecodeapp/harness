import {
  PYTHON_RUNTIME_IMAGE_PROTOCOL_VERSION,
  type BrowserRuntimeEngine,
  type BrowserRuntimeAssets,
} from '@tracecode/runtime-browser';
import {
  PYTHON_RUNTIME_DIRECTORY,
  PYTHON_RUNTIME_SNAPSHOTS,
  PYTHON_RUNTIME_WASM,
} from './python-runtime-assets.generated';
import { PYTHON_RUNTIME_IMAGE_HASH_SEED } from './python-runtime-image-contract';

const IMMUTABLE_VERSIONED_DELIVERY = Object.freeze({
  mutability: 'immutable',
  address: 'versioned',
} as const);

function siblingAssetUrl(workerUrl: string, relativePath: string): string {
  const withoutFragment = workerUrl.split('#', 1)[0]!;
  const withoutQuery = withoutFragment.split('?', 1)[0]!;
  if (/^[a-z][a-z\d+.-]*:/iu.test(withoutQuery)) {
    return new URL(relativePath, withoutQuery).href;
  }
  const separator = withoutQuery.lastIndexOf('/');
  return `${separator < 0 ? '' : withoutQuery.slice(0, separator + 1)}${relativePath}`;
}

function assertImageEngine(
  engine: BrowserRuntimeEngine
): asserts engine is keyof typeof PYTHON_RUNTIME_SNAPSHOTS {
  if (engine === 'unknown') {
    throw new Error(
      'TraceCode Python 0.16 requires a recognized Chromium, Firefox, or WebKit engine ' +
        'to select an isolation-safe CPython runtime image. Set the browser runtime engine ' +
        'explicitly only when user-agent detection is unavailable.'
    );
  }
}

/**
 * Resolves the Python 0.16 runtime image shipped by the Harness asset bundle.
 *
 * These are deployment assets, not learner state. The provider retains the
 * immutable module/snapshot pair while every leased Worker receives fresh
 * mutable Wasm memory and is retired after one prepared submission.
 */
export function resolveBuiltInPythonRuntimeAssets(
  assets: BrowserRuntimeAssets,
  engine: BrowserRuntimeEngine
) {
  assertImageEngine(engine);
  const runtimeDirectoryName = PYTHON_RUNTIME_DIRECTORY.split('/').at(-1);
  if (!runtimeDirectoryName) {
    throw new Error('TraceCode Python runtime directory is invalid.');
  }
  let runtimeBase: string;
  try {
    runtimeBase = siblingAssetUrl(
      assets.pythonRuntime,
      `${runtimeDirectoryName}/`
    );
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // data: and blob: python-runtime overrides are valid self-contained assets,
    // but they cannot be used as hierarchical URL bases. Preserve the legacy
    // worker-relative image layout for those explicit override forms.
    runtimeBase = siblingAssetUrl(
      assets.pythonWorker,
      `${PYTHON_RUNTIME_DIRECTORY}/`
    );
  }
  const snapshot = PYTHON_RUNTIME_SNAPSHOTS[engine];
  return Object.freeze({
    loaderUrl: `${runtimeBase}pyodide.js`,
    indexUrl: runtimeBase,
    image: Object.freeze({
      protocolVersion: PYTHON_RUNTIME_IMAGE_PROTOCOL_VERSION,
      engine,
      // CPython's hash secret is captured inside the restored memory image.
      // Seed 0 matches the release snapshots; changing it here cannot re-key
      // an existing image and would make restored interpreter state invalid.
      // Guest execution limits remain the denial-of-service boundary until a
      // future CPython/Wasm snapshot format can safely re-key after restore.
      pythonHashSeed: PYTHON_RUNTIME_IMAGE_HASH_SEED,
      wasm: Object.freeze({
        url: `${runtimeBase}pyodide.asm.wasm`,
        integrity: PYTHON_RUNTIME_WASM.integrity,
        mediaType: 'application/wasm',
        size: PYTHON_RUNTIME_WASM.size,
        delivery: IMMUTABLE_VERSIONED_DELIVERY,
      }),
      snapshot: Object.freeze({
        url: `${runtimeBase}snapshots/${engine}.bin`,
        integrity: snapshot.integrity,
        mediaType: 'application/octet-stream',
        size: snapshot.size,
        delivery: IMMUTABLE_VERSIONED_DELIVERY,
      }),
    }),
  });
}

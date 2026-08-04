import {
  PYTHON_RUNTIME_IMAGE_PROTOCOL_VERSION,
  type BrowserRuntimeEngine,
  type BrowserRuntimeAssets,
} from '@tracecode/runtime-browser';

const RUNTIME_DIRECTORY = 'python/pyodide-0.29.3';
const IMMUTABLE_VERSIONED_DELIVERY = Object.freeze({
  mutability: 'immutable',
  address: 'versioned',
} as const);

const SNAPSHOTS = Object.freeze({
  chromium: Object.freeze({
    integrity:
      'sha256-9uWlkAbBhlbRC1kWgf5r0Am30Thew5WjsAgNMzu7gVE=',
    size: 20_971_936,
  }),
  firefox: Object.freeze({
    integrity:
      'sha256-ozSkcg1128ksIGL0HrfKsqHNmBknSK0J9D/RulzOO6k=',
    size: 20_971_936,
  }),
  webkit: Object.freeze({
    integrity:
      'sha256-6/QwvAp6JAivTHNhA/unBxEFjg+eYKiQ1Q7S4dcHbvs=',
    size: 20_971_936,
  }),
});

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
): asserts engine is keyof typeof SNAPSHOTS {
  if (engine === 'unknown') {
    throw new Error(
      'TraceCode Python 0.15 requires a recognized Chromium, Firefox, or WebKit engine ' +
        'to select an isolation-safe CPython runtime image. Set the browser runtime engine ' +
        'explicitly only when user-agent detection is unavailable.'
    );
  }
}

/**
 * Resolves the Python 0.15 runtime image shipped by the Harness asset bundle.
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
  const runtimeBase = siblingAssetUrl(
    assets.pythonWorker,
    `${RUNTIME_DIRECTORY}/`
  );
  const snapshot = SNAPSHOTS[engine];
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
      pythonHashSeed: '0',
      wasm: Object.freeze({
        url: `${runtimeBase}pyodide.asm.wasm`,
        integrity:
          'sha256-4vTudbMl416zG/uMYT1N1QmPVQLBVql4R2hodbUCVIA=',
        mediaType: 'application/wasm',
        size: 8_647_684,
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

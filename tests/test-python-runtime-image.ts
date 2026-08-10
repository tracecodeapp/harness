import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createPythonRuntimeImageFactory,
  type PythonRuntimeImage,
} from '../packages/runtime-python/src/python-runtime-image';
import {
  resolveBuiltInPythonRuntimeAssets,
} from '../packages/runtime-python/src/python-runtime-assets';
import { PythonWorkerClient } from '../packages/runtime-python/src/python-worker-client';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const wasmBytes = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d,
  0x01, 0x00, 0x00, 0x00,
]);
const snapshotBytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
const requests: string[] = [];
const immutable = {
  mutability: 'immutable',
  address: 'content',
} as const;

function runtimeImageDescriptor(name: string) {
  return {
    protocolVersion: 'tracecode-python-runtime-image-v1',
    engine: 'chromium',
    pythonHashSeed: '0',
    wasm: {
      url: `https://runtime.test/${name}.wasm`,
      integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      mediaType: 'application/wasm',
      size: wasmBytes.byteLength,
      delivery: immutable,
    },
    snapshot: {
      url: `https://runtime.test/${name}.snapshot`,
      integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      mediaType: 'application/octet-stream',
      size: snapshotBytes.byteLength,
      delivery: immutable,
    },
  } as const;
}

function runtimeImageResponse(input: RequestInfo | URL): Response {
  const url = String(input);
  const bytes = url.endsWith('.wasm') ? wasmBytes : snapshotBytes;
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-length': String(bytes.byteLength),
      'content-type': url.endsWith('.wasm')
        ? 'application/wasm'
        : 'application/octet-stream',
    },
  });
}

const factory = createPythonRuntimeImageFactory({
  descriptor: runtimeImageDescriptor('python'),
  fetch: async (input) => {
    requests.push(String(input));
    return runtimeImageResponse(input);
  },
});

const [first, second] = await Promise.all([
  factory.acquire(),
  factory.acquire(),
]);
assertCondition(first === second, 'Concurrent runtime-image acquisition must share one immutable image.');
assertCondition(
  requests.filter((url) => url.endsWith('.wasm')).length === 1 &&
    requests.filter((url) => url.endsWith('.snapshot')).length === 1,
  `Runtime-image factory must fetch each artifact once: ${JSON.stringify(requests)}`
);
assertCondition(
  first.compiledModule instanceof WebAssembly.Module,
  'Runtime-image factory must retain a compiled WebAssembly.Module.'
);
assertCondition(
  first.snapshot === second.snapshot &&
    first.snapshot.byteLength === snapshotBytes.byteLength,
  'Runtime-image factory must retain one clean snapshot backing array.'
);
const compileStreamingDescriptor = Object.getOwnPropertyDescriptor(
  WebAssembly,
  'compileStreaming'
);
let streamingAttempts = 0;
Object.defineProperty(WebAssembly, 'compileStreaming', {
  configurable: true,
  writable: true,
  value: async () => {
    streamingAttempts += 1;
    throw new TypeError('synthetic streaming compiler rejection');
  },
});
try {
  const fallbackFactory = createPythonRuntimeImageFactory({
    descriptor: runtimeImageDescriptor('fallback'),
    fetch: async (input) => runtimeImageResponse(input),
  });
  const fallbackImage = await fallbackFactory.acquire();
  assertCondition(
    streamingAttempts === 1 &&
      fallbackImage.compiledModule instanceof WebAssembly.Module,
    'Runtime-image factory must buffer and compile valid Wasm when streaming compilation rejects.'
  );
} finally {
  if (compileStreamingDescriptor) {
    Object.defineProperty(
      WebAssembly,
      'compileStreaming',
      compileStreamingDescriptor
    );
  } else {
    delete (WebAssembly as { compileStreaming?: unknown }).compileStreaming;
  }
}

let compressedStreamingAttempts = 0;
Object.defineProperty(WebAssembly, 'compileStreaming', {
  configurable: true,
  writable: true,
  value: async () => {
    compressedStreamingAttempts += 1;
    throw new Error('Encoded responses must use decoded buffered bytes.');
  },
});
try {
  const compressedFactory = createPythonRuntimeImageFactory({
    descriptor: runtimeImageDescriptor('compressed'),
    fetch: async (input) => {
      const response = runtimeImageResponse(input);
      const headers = new Headers(response.headers);
      headers.set('content-encoding', 'br');
      headers.set('content-length', '1');
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers,
      });
    },
  });
  const compressedImage = await compressedFactory.acquire();
  assertCondition(
    compressedStreamingAttempts === 0 &&
      compressedImage.compiledModule instanceof WebAssembly.Module,
    'Encoded runtime-image responses must validate decoded buffered bytes.'
  );
} finally {
  if (compileStreamingDescriptor) {
    Object.defineProperty(
      WebAssembly,
      'compileStreaming',
      compileStreamingDescriptor
    );
  } else {
    delete (WebAssembly as { compileStreaming?: unknown }).compileStreaming;
  }
}

let timedOutFetches = 0;
let abortedFetches = 0;
const timeoutFactory = createPythonRuntimeImageFactory({
  descriptor: runtimeImageDescriptor('timeout'),
  timeoutMs: 10,
  fetch: async (_input, init) => {
    timedOutFetches += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener(
        'abort',
        () => {
          abortedFetches += 1;
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true }
      );
    });
  },
});
const timeoutErrors: string[] = [];
for (let attempt = 0; attempt < 2; attempt += 1) {
  try {
    await timeoutFactory.acquire();
  } catch (error) {
    timeoutErrors.push(error instanceof Error ? error.message : String(error));
  }
}
assertCondition(
  timedOutFetches === 4 &&
    abortedFetches === 4 &&
    timeoutErrors.length === 2 &&
    timeoutErrors.every((message) => message.includes('timed out')),
  `Runtime-image acquisition must abort stalled fetches: ${JSON.stringify({
    timedOutFetches,
    abortedFetches,
    timeoutErrors,
  })}`
);

factory.dispose();
await factory.acquire().then(
  () => {
    throw new Error('Disposed runtime-image factory unexpectedly acquired an image.');
  },
  (error) => {
    assertCondition(
      String(error).includes('disposed'),
      `Disposed runtime-image factory must fail clearly: ${String(error)}`
    );
  }
);

const engines = ['chromium', 'firefox', 'webkit'] as const;
for (const engine of engines) {
  const builtIn = resolveBuiltInPythonRuntimeAssets(
    {
      pythonWorker: '/workers/python-worker.js',
      pythonRuntimeCore: '/workers/python/runtime-core.js',
    } as never,
    engine
  );
  assertCondition(
    builtIn.loaderUrl === '/workers/python/pyodide-0.29.3/pyodide.js' &&
      builtIn.indexUrl === '/workers/python/pyodide-0.29.3/',
    `Built-in ${engine} runtime URLs must follow the synced Harness asset layout.`
  );
  assertCondition(
    builtIn.image.snapshot.url ===
      `/workers/python/pyodide-0.29.3/snapshots/${engine}.bin`,
    `Built-in ${engine} snapshot URL must be engine-specific.`
  );
  const bytes = await readFile(
    `workers/python/pyodide-0.29.3/snapshots/${engine}.bin`
  );
  assertCondition(
    bytes.byteLength === builtIn.image.snapshot.size &&
      builtIn.image.snapshot.integrity ===
        `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
    `Shipped ${engine} snapshot must match its immutable descriptor.`
  );
}

const splitOrigin = resolveBuiltInPythonRuntimeAssets(
  {
    pythonWorker: '/workers/python-worker.js',
    pythonRuntimeCore:
      'https://runtime-assets.example/harness/release/python/runtime-core.js',
  } as never,
  'chromium'
);
assertCondition(
  splitOrigin.loaderUrl ===
    'https://runtime-assets.example/harness/release/python/pyodide-0.29.3/pyodide.js' &&
    splitOrigin.image.snapshot.url ===
      'https://runtime-assets.example/harness/release/python/pyodide-0.29.3/snapshots/chromium.bin',
  'Built-in Python payloads must follow the configured runtime asset root, not the same-origin Worker URL.'
);

const nonHierarchicalRuntimeCore = resolveBuiltInPythonRuntimeAssets(
  {
    pythonWorker: '/workers/python-worker.js',
    pythonRuntimeCore: 'data:text/javascript,export default {}',
  } as never,
  'chromium'
);
assertCondition(
  nonHierarchicalRuntimeCore.loaderUrl ===
    '/workers/python/pyodide-0.29.3/pyodide.js',
  'A non-hierarchical runtime-core override must retain the worker-relative built-in image root.'
);

const builtIn = resolveBuiltInPythonRuntimeAssets(
  {
    pythonWorker: '/workers/python-worker.js',
    pythonRuntimeCore: '/workers/python/runtime-core.js',
  } as never,
  'chromium'
);
const shippedWasm = await readFile(
  'workers/python/pyodide-0.29.3/pyodide.asm.wasm'
);
assertCondition(
  shippedWasm.byteLength === builtIn.image.wasm.size &&
    builtIn.image.wasm.integrity ===
      `sha256-${createHash('sha256').update(shippedWasm).digest('base64')}`,
  'Shipped Pyodide Wasm must match the immutable runtime-image descriptor.'
);

let unknownEngineError = '';
try {
  resolveBuiltInPythonRuntimeAssets(
    {
      pythonWorker: '/workers/python-worker.js',
      pythonRuntimeCore: '/workers/python/runtime-core.js',
    } as never,
    'unknown'
  );
} catch (error) {
  unknownEngineError = error instanceof Error ? error.message : String(error);
}
assertCondition(
  unknownEngineError.includes('requires a recognized'),
  `Unknown browser engines must fail closed: ${unknownEngineError}`
);

interface Deferred {
  readonly entered: Promise<void>;
  enter(): void;
  readonly released: Promise<void>;
  release(): void;
}

function createDeferred(): Deferred {
  let enter!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    enter: () => enter(),
    released: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}

const lifecycleImage: PythonRuntimeImage = Object.freeze({
  protocolVersion: 'tracecode-python-runtime-image-v1',
  compiledModule: await WebAssembly.compile(wasmBytes),
  snapshot: snapshotBytes,
  pythonHashSeed: '0',
});

for (const pendingGate of [
  'runtime-preflight',
  'image',
  'asset-preflight',
] as const) {
  const gate = createDeferred();
  let workersCreated = 0;
  const client = new PythonWorkerClient({
    workerUrl: '/workers/python-worker.js',
    debug: false,
    workerFactory: () => {
      workersCreated += 1;
      throw new Error('A terminated client attempted to create a worker.');
    },
    assetPreflight: async () => {
      if (pendingGate !== 'asset-preflight') return;
      gate.enter();
      await gate.released;
    },
    runtimeAssetPreflight: async () => {
      if (pendingGate !== 'runtime-preflight') return;
      gate.enter();
      await gate.released;
    },
    runtimeImageFactory: {
      async acquire() {
        if (pendingGate === 'image') {
          gate.enter();
          await gate.released;
        }
        return lifecycleImage;
      },
      dispose() {},
    },
  });
  const warmup = client.warmup();
  await gate.entered;
  client.terminate();
  gate.release();
  let terminationError = '';
  try {
    await warmup;
  } catch (error) {
    terminationError = error instanceof Error ? error.message : String(error);
  }
  assertCondition(
    workersCreated === 0 && terminationError.includes('terminated'),
    `Termination during ${pendingGate} must not create a worker: ` +
      JSON.stringify({ workersCreated, terminationError })
  );
}

console.log('PASS: Python immutable runtime-image factory');

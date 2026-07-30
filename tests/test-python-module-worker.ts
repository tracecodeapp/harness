import {
  BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
  createBrowserHarness,
  resolveBrowserRuntimeAssetManifests,
  type BrowserRuntimeAssetManifest,
} from '../src/browser';
import { PythonWorkerClient } from '../packages/runtime-python/src/python-worker-client';
import { createBrowserProjectWorkspace } from '../packages/runtime-browser/src/project';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface PostedMessage {
  id?: string;
  type: string;
  payload?: Record<string, unknown>;
  protocolToken?: string;
}

class CapturingWorker {
  static instances: CapturingWorker[] = [];
  static lifecycle: string[] = [];

  readonly messages: PostedMessage[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor(readonly url: string | URL, readonly options?: WorkerOptions) {
    CapturingWorker.instances.push(this);
    CapturingWorker.lifecycle.push('worker');
    queueMicrotask(() => this.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent));
  }

  postMessage(message: PostedMessage): void {
    this.messages.push(message);
    let type = `${message.type}-result`;
    let payload: Record<string, unknown> = { success: true, loadTimeMs: 0 };
    if (message.type === 'init') type = 'init-result';
    if (message.type === 'warmup') type = 'warmup-result';
    if (message.type === 'execute-project-python') {
      type = 'execute-result';
      payload = { stdout: 'module-project-ok\n', stderr: '', exitCode: 0, files: [] };
    }
    queueMicrotask(() => this.onmessage?.({
      data: { id: message.id, protocolToken: message.protocolToken, type, payload },
    } as MessageEvent));
  }

  terminate(): void {}
}

function modulePythonManifest(): BrowserRuntimeAssetManifest<'python'> {
  return {
    runtime: 'python',
    runtimeVersion: '314.0.2',
    protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
    workerFormat: 'module',
    loaderFormat: 'module',
    assetBaseUrl: 'https://cdn.consumer.example/python/314.0.2/',
    originPolicy: { mode: 'allow-list', origins: ['https://cdn.consumer.example'] },
    assets: {
      worker: { url: 'python-worker.js' },
      runtimeCore: { url: 'runtime-core.js' },
      snippets: { url: 'generated-python-harness-snippets.js' },
      runtimeLoader: { url: 'pyodide.mjs' },
      runtimeIndex: { url: './' },
    },
  };
}

function assertFormatValidation(): void {
  const manifest = resolveBrowserRuntimeAssetManifests({ manifests: { python: modulePythonManifest() } }).python;
  assertCondition(manifest?.workerFormat === 'module', 'Module Python worker format was not retained');
  assertCondition(manifest.loaderFormat === 'module', 'Module Pyodide loader format was not retained');
  assertCondition(
    manifest.assets.runtimeLoader?.url.endsWith('/python/314.0.2/pyodide.mjs'),
    'Consumer module loader URL was not resolved'
  );

  let message = '';
  try {
    resolveBrowserRuntimeAssetManifests({
      manifests: { python: { ...modulePythonManifest(), workerFormat: 'classic' } },
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertCondition(
    message.includes('Python requires classic + classic-script or module + module'),
    `Mixed Python formats must fail clearly, received ${JSON.stringify(message)}`
  );
}

async function assertClientConstructionAndPreflight(): Promise<void> {
  CapturingWorker.instances = [];
  CapturingWorker.lifecycle = [];
  const client = new PythonWorkerClient({
    workerUrl: 'https://cdn.consumer.example/python/314.0.2/python-worker.js',
    workerFormat: 'module',
    runtimeAssets: {
      loaderFormat: 'module',
      loaderUrl: 'https://cdn.consumer.example/python/314.0.2/pyodide.mjs',
      indexUrl: 'https://cdn.consumer.example/python/314.0.2/',
      runtimeCoreUrl: 'https://cdn.consumer.example/python/314.0.2/runtime-core.js',
      snippetsUrl: 'https://cdn.consumer.example/python/314.0.2/snippets.js',
    },
    assetPreflight: async () => { CapturingWorker.lifecycle.push('worker-preflight'); },
    runtimeAssetPreflight: async () => { CapturingWorker.lifecycle.push('runtime-preflight'); },
  });
  await client.init();

  const worker = CapturingWorker.instances[0];
  assertCondition(worker?.options?.type === 'module', 'Python client did not construct a module Worker');
  assertCondition(
    String(worker.url).includes('tracecodePythonWorkerFormat=module'),
    'Module worker declaration was not passed to the dual-format worker source'
  );
  assertCondition(
    !String(worker.url).includes('tracecodePythonSnippets='),
    'Module snippets must be imported from the init payload, not a classic bootstrap query'
  );
  assertCondition(
    CapturingWorker.lifecycle.join(',') === 'worker-preflight,runtime-preflight,worker',
    `Module runtime preflight must finish before Worker construction: ${CapturingWorker.lifecycle.join(',')}`
  );
  const init = worker.messages.find((message) => message.type === 'init');
  const runtimeAssets = init?.payload?.runtimeAssets as Record<string, unknown> | undefined;
  assertCondition(runtimeAssets?.loaderFormat === 'module', 'Module loader format did not reach worker init');
  assertCondition(
    runtimeAssets?.loaderUrl === 'https://cdn.consumer.example/python/314.0.2/pyodide.mjs',
    'Consumer module loader did not reach worker init'
  );
  client.terminate();
}

async function assertClassicAndHarnessPaths(): Promise<void> {
  const classic = new PythonWorkerClient({ workerUrl: '/workers/python-worker.js' });
  await classic.init();
  const classicWorker = CapturingWorker.instances.at(-1);
  assertCondition(classicWorker?.options === undefined, 'Legacy Python path must remain a classic Worker');
  classic.terminate();

  CapturingWorker.instances = [];
  const harness = createBrowserHarness({ assets: { runtimeManifests: { python: modulePythonManifest() } } });
  await harness.getClient('python').init();
  const harnessWorker = CapturingWorker.instances[0];
  assertCondition(harnessWorker?.options?.type === 'module', 'Classic harness entry did not honor module Python manifest');
  harness.dispose();

  CapturingWorker.instances = [];
  const workspace = await createBrowserProjectWorkspace({
    providers: ['python'],
    assets: { runtimeManifests: { python: modulePythonManifest() } },
    files: [{ path: 'main.py', contents: 'print("module-project-ok")' }],
  });
  const result = await workspace.runCommand('python3 main.py');
  assertCondition(result.exitCode === 0, `Project Python module path failed: ${result.stderr}`);
  const projectWorker = CapturingWorker.instances[0];
  assertCondition(projectWorker?.options?.type === 'module', 'Project browser dropped the module Python worker format');
  const init = projectWorker.messages.find((message) => message.type === 'init');
  const runtimeAssets = init?.payload?.runtimeAssets as Record<string, unknown> | undefined;
  assertCondition(
    runtimeAssets?.runtimeCoreUrl === 'https://cdn.consumer.example/python/314.0.2/runtime-core.js',
    'Project browser dropped Python runtime assets before worker initialization'
  );
  await workspace.destroy();
}

const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: CapturingWorker });
try {
  assertFormatValidation();
  await assertClientConstructionAndPreflight();
  await assertClassicAndHarnessPaths();
  console.log('PASS: consumer-generic Python module worker manifest, protocol, and project plumbing');
} finally {
  if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
  else Reflect.deleteProperty(globalThis, 'Worker');
}

import { pathToFileURL } from 'node:url';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function dataModule(source: string): string {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for Python worker response');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: Record<string, unknown>;
  protocolToken?: string;
}

const posted: WorkerMessage[] = [];
const workerUrl = new URL(pathToFileURL(`${process.cwd()}/workers/python/pyodide-worker.js`).href);
workerUrl.searchParams.set('tracecodePythonWorkerFormat', 'module');
workerUrl.searchParams.set('configured-package-failure-test', String(Date.now()));
const scope = {
  location: { href: workerUrl.href, search: workerUrl.search },
  onmessage: null as ((event: MessageEvent<WorkerMessage>) => void) | null,
  postMessage(message: WorkerMessage) {
    posted.push(message);
  },
};

const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });
try {
  await import(workerUrl.href);
  assertCondition(scope.onmessage, 'Python module worker did not install its protocol handler');

  const missingPackageUrl = 'https://cdn.consumer.example/missing_package-1.0.0-py3-none-any.whl';
  const loaderUrl = dataModule(`
    export async function loadPyodide() {
      return {
        async loadPackage(urls) {
          throw new Error('configured-package-contract-failed:' + urls.join(','));
        },
      };
    }
  `);
  const runtimeCoreUrl = dataModule(`
    self.__TRACECODE_PYODIDE_RUNTIME__ = Object.freeze({});
    export {};
  `);
  const snippetsUrl = dataModule(`
    self.__TRACECODE_PYTHON_HARNESS__ = Object.freeze({});
    export {};
  `);

  scope.onmessage({
    data: {
      id: 'init',
      type: 'init',
      protocolToken: 'init-token',
      payload: {
        runtimeAssets: {
          loaderFormat: 'module',
          loaderUrl,
          indexUrl: 'https://cdn.consumer.example/python/314.0.2/',
          runtimeCoreUrl,
          snippetsUrl,
          packageUrls: { missing: missingPackageUrl },
        },
      },
    },
  } as unknown as MessageEvent<WorkerMessage>);
  await waitFor(() => posted.some((message) => message.id === 'init'));
  assertCondition(posted.find((message) => message.id === 'init')?.type === 'init-result', 'Python init failed');

  for (const attempt of ['warmup-1', 'warmup-2']) {
    scope.onmessage({
      data: { id: attempt, type: 'warmup', protocolToken: `${attempt}-token` },
    } as unknown as MessageEvent<WorkerMessage>);
    await waitFor(() => posted.some((message) => message.id === attempt));
    const response = posted.find((message) => message.id === attempt);
    assertCondition(
      response?.type === 'error' && String(response.payload?.error).includes(missingPackageUrl),
      `Configured package failure became a healthy ${attempt} response: ${JSON.stringify(response)}`
    );
  }

  console.log('PASS: explicitly configured Python package failures fail warmup and remain failed on retry');
} finally {
  if (originalSelf) Object.defineProperty(globalThis, 'self', originalSelf);
  else Reflect.deleteProperty(globalThis, 'self');
}

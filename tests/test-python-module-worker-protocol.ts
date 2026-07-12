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
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for module worker protocol response');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

interface WorkerMessage {
  type: string;
  id?: string;
  protocolToken?: string;
  payload?: Record<string, unknown>;
}

const posted: WorkerMessage[] = [];
const nativeAuthorityCalls: string[] = [];
const nativeFetch = () => {
  nativeAuthorityCalls.push('fetch');
  return 'native-fetch';
};
const workerUrl = new URL(pathToFileURL(`${process.cwd()}/workers/python/pyodide-worker.js`).href);
workerUrl.searchParams.set('tracecodePythonWorkerFormat', 'module');
workerUrl.searchParams.set('protocol-test', String(Date.now()));
const scope = {
  location: { href: workerUrl.href, search: workerUrl.search },
  onmessage: null as ((event: MessageEvent<WorkerMessage>) => void) | null,
  postMessage(message: WorkerMessage) {
    posted.push(message);
  },
  fetch: nativeFetch,
  __TRACECODE_PYODIDE_RUNTIME__: undefined as unknown,
  __TRACECODE_PYTHON_HARNESS__: undefined as unknown,
  __TRACECODE_PYODIDE_MODULE_LOAD_OPTIONS__: undefined as unknown,
};

const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });
try {
  await import(workerUrl.href);
  assertCondition(scope.onmessage, 'Module worker did not install its protocol handler');
  assertCondition(posted[0]?.type === 'worker-ready', 'Module worker did not emit worker-ready');

  const loaderUrl = dataModule(`
    export async function loadPyodide(options) {
      self.__TRACECODE_PYODIDE_MODULE_LOAD_OPTIONS__ = options;
      return { loadPackage: async () => undefined };
    }
  `);
  const runtimeCoreUrl = dataModule(`
    self.__TRACECODE_PYODIDE_RUNTIME__ = Object.freeze({
      async executeCode(_deps, code) {
        let fetchResult;
        try { self.fetch('https://ambient.example/'); fetchResult = 'allowed'; }
        catch (error) { fetchResult = error && (error.code || error.name); }
        let policyDeleteResult;
        let policyReplaceResult;
        let policyAssignmentResult;
        if (code === 'poison-policy') {
          policyDeleteResult = Reflect.deleteProperty(self, 'TraceRuntimeKernelPolicy');
          try {
            Object.defineProperty(self, 'TraceRuntimeKernelPolicy', { value: Object.freeze({}) });
            policyReplaceResult = 'allowed';
          } catch (error) {
            policyReplaceResult = error && error.name;
          }
          try {
            self.TraceRuntimeKernelPolicy = Object.freeze({});
            policyAssignmentResult = 'allowed';
          } catch (error) {
            policyAssignmentResult = error && error.name;
          }
        }
        if (code === 'throw-after-probe') throw new Error('user-probe-failure');
        return {
          success: true,
          output: { fetchResult, policyDeleteResult, policyReplaceResult, policyAssignmentResult },
          consoleOutput: [],
        };
      },
    });
    export {};
  `);
  const snippetsUrl = dataModule(`
    self.__TRACECODE_PYTHON_HARNESS__ = Object.freeze({});
    self.__TRACECODE_toPythonLiteral = (value) => JSON.stringify(value);
    export {};
  `);
  const indexUrl = 'https://cdn.consumer.example/python/314.0.2/';

  scope.onmessage({
    data: {
      id: 'init-1',
      type: 'init',
      protocolToken: 'token-init',
      payload: {
        runtimeAssets: {
          loaderFormat: 'module',
          loaderUrl,
          indexUrl,
          runtimeCoreUrl,
          snippetsUrl,
        },
      },
    },
  } as MessageEvent<WorkerMessage>);
  scope.onmessage({
    data: { id: 'warmup-1', type: 'warmup', protocolToken: 'token-warmup' },
  } as MessageEvent<WorkerMessage>);

  await waitFor(() => posted.some((message) => message.id === 'warmup-1'));
  const initIndex = posted.findIndex((message) => message.id === 'init-1');
  const warmupIndex = posted.findIndex((message) => message.id === 'warmup-1');
  assertCondition(posted[initIndex]?.type === 'init-result', 'Module bootstrap did not complete init successfully');
  assertCondition(posted[warmupIndex]?.type === 'warmup-result', 'Module Pyodide loader did not complete warmup');
  assertCondition(initIndex > 0 && warmupIndex > initIndex, 'Worker messages bypassed the ordered module bootstrap queue');
  assertCondition(
    (scope.__TRACECODE_PYODIDE_MODULE_LOAD_OPTIONS__ as { indexURL?: string } | undefined)?.indexURL === indexUrl,
    'Module loadPyodide did not receive the consumer runtime index URL'
  );
  assertCondition(
    typeof (scope as typeof scope & { TraceRuntimeKernelPolicy?: unknown }).TraceRuntimeKernelPolicy === 'object',
    'Module bootstrap did not import the shared runtime kernel policy'
  );

  scope.onmessage({
    data: {
      id: 'execute-1',
      type: 'execute-code',
      protocolToken: 'token-execute',
      payload: { code: 'poison-policy', functionName: null, inputs: {}, executionStyle: 'function' },
    },
  } as MessageEvent<WorkerMessage>);
  await waitFor(() => posted.some((message) => message.id === 'execute-1'));
  const executeResult = posted.find((message) => message.id === 'execute-1');
  const output = (executeResult?.payload as {
    output?: {
      fetchResult?: string;
      policyDeleteResult?: boolean;
      policyReplaceResult?: string;
      policyAssignmentResult?: string;
    };
  } | undefined)?.output;
  assertCondition(executeResult?.type === 'execute-result', 'Python authority probe did not return an execution result');
  assertCondition(output?.fetchResult === 'EACCES', `Ambient fetch was not denied: ${JSON.stringify(output)}`);
  assertCondition(
    output?.policyDeleteResult === false &&
      output.policyReplaceResult === 'TypeError' &&
      output.policyAssignmentResult === 'TypeError',
    `Python user code could poison its trusted policy: ${JSON.stringify(output)}`
  );
  assertCondition(nativeAuthorityCalls.length === 0, 'Python user execution invoked the native ambient fetch capability');
  assertCondition(scope.fetch === nativeFetch, 'Ambient fetch was not restored after successful Python execution');

  scope.onmessage({
    data: {
      id: 'execute-2',
      type: 'execute-code',
      protocolToken: 'token-execute-failure',
      payload: { code: 'throw-after-probe', functionName: null, inputs: {}, executionStyle: 'function' },
    },
  } as MessageEvent<WorkerMessage>);
  await waitFor(() => posted.some((message) => message.id === 'execute-2'));
  const failedResult = posted.find((message) => message.id === 'execute-2');
  assertCondition(
    failedResult?.type === 'error' && String(failedResult.payload?.error).includes('user-probe-failure'),
    `Python user failure did not propagate through the protocol: ${JSON.stringify(failedResult)}`
  );
  assertCondition(nativeAuthorityCalls.length === 0, 'Failed Python execution invoked native ambient fetch');
  assertCondition(scope.fetch === nativeFetch, 'Ambient fetch was not restored after failed Python execution');

  scope.onmessage({
    data: {
      id: 'execute-3',
      type: 'execute-code',
      protocolToken: 'token-execute-after-poison',
      payload: { code: 'probe', functionName: null, inputs: {}, executionStyle: 'function' },
    },
  } as MessageEvent<WorkerMessage>);
  await waitFor(() => posted.some((message) => message.id === 'execute-3'));
  const postPoisonResult = posted.find((message) => message.id === 'execute-3');
  const postPoisonOutput = (postPoisonResult?.payload as { output?: { fetchResult?: string } } | undefined)?.output;
  assertCondition(
    postPoisonResult?.type === 'execute-result' && postPoisonOutput?.fetchResult === 'EACCES',
    `A prior command poisoned the next Python authority boundary: ${JSON.stringify(postPoisonResult)}`
  );
  assertCondition(nativeAuthorityCalls.length === 0, 'Post-poison Python execution reached native ambient fetch');
  console.log('PASS: Python module worker imports assets, orders init, denies authority, and resists cross-command poisoning');
} finally {
  if (originalSelf) Object.defineProperty(globalThis, 'self', originalSelf);
  else Reflect.deleteProperty(globalThis, 'self');
}

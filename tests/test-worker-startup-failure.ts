import assert from 'node:assert/strict';
import test from 'node:test';
import { isRuntimeProviderError } from '../packages/runtime-contracts/src';
import type { BrowserWorkerLike } from '../packages/runtime-browser/src/execution-host';
import { CSharpWorkerClient, type CSharpPreparedProgramArtifact } from '../packages/runtime-csharp/src/csharp-worker-client';
import { JavaScriptWorkerClient } from '../packages/runtime-javascript/src/javascript-worker-client';
import { PythonWorkerClient } from '../packages/runtime-python/src/python-worker-client';
import { createPythonPreparedExecutionProvider } from '../packages/runtime-python/src/python-runtime-client';
import { JavaWorkerClient } from '../packages/runtime-java/src/java-worker-client';
import { CppWorkerClient } from '../packages/runtime-cpp/src/cpp-worker-client';

function failingWorker(phase: 'startup' | 'init' | 'unsuccessful-init' | 'execution'): BrowserWorkerLike {
  const worker: BrowserWorkerLike = {
    onerror: null,
    onmessage: null,
    terminate() {},
    postMessage(message) {
      const { id, protocolToken, type } = message as Record<string, string>;
      if (phase === 'execution') {
        assert.ok(type === 'execute-prepared-code' || type === 'execute-prepared-trace');
        worker.onerror?.({ message: 'same failure' } as ErrorEvent);
      } else {
        assert.ok(phase === 'init' || phase === 'unsuccessful-init');
        worker.onmessage?.({ data: {
          id, protocolToken, type: type === 'init' && phase === 'init' ? 'error' : 'result',
          payload: type === 'init' ? { success: false, error: 'same failure' } : { success: true },
        } } as MessageEvent);
      }
    },
  };
  queueMicrotask(() => {
    if (phase === 'startup') worker.onerror?.({ message: 'same failure' } as ErrorEvent);
    else worker.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent);
  });
  return worker;
}

const workerOptions = {
  workerUrl: 'https://example.test/worker.js',
  workerFactory: () => failingWorker('startup'),
};

for (const language of ['javascript', 'typescript'] as const) {
  for (const phase of ['startup', 'init', 'unsuccessful-init'] as const) {
    test(`${language} rejects ${phase} failure during batch preparation`, async () => {
      const client = new JavaScriptWorkerClient({ ...workerOptions, workerFactory: () => failingWorker(phase) });
      try {
        await assert.rejects(client.executeCodeBatch({
          language, code: 'function f() {}', functionName: 'f', inputBatch: [{}, {}],
        }), isRuntimeProviderError);
      } finally {
        client.terminate();
      }
    });
  }
}

test('JavaScript observes a failed executor while the coordinator is still loading', async () => {
  const client = new JavaScriptWorkerClient({
    ...workerOptions,
    workerFactory: (url) => {
      if (new URL(url).searchParams.get('tracecodeRole') === 'executor') return failingWorker('startup');
      const worker: BrowserWorkerLike = {
        onerror: null, onmessage: null, terminate() {},
        postMessage(message) {
          const { id, protocolToken } = message as Record<string, string>;
          worker.onmessage?.({ data: { id, protocolToken, type: 'result', payload: { success: true } } } as MessageEvent);
        },
      };
      setImmediate(() => worker.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent));
      return worker;
    },
  });
  try {
    await assert.rejects(client.init(), isRuntimeProviderError);
  } finally {
    client.terminate();
  }
});

const prepared: CSharpPreparedProgramArtifact = {
  mode: 'code', code: '', functionName: 'F', executionStyle: 'solution-method',
  compiledArtifactKey: 'key', compiledArtifactBase64: '', compiledArtifactSha256: '',
  preparedRunnerTier: 'compatibility', preparedRunnerReason: 'test',
};

for (const mode of ['code', 'trace'] as const) {
  for (const phase of ['startup', 'execution'] as const) {
    test(`C# prepared ${mode} rejects a crash during ${phase}`, async () => {
      const client = new CSharpWorkerClient({
        ...workerOptions, assetBaseUrl: '/', runtimeRole: 'runner', workerFactory: () => failingWorker(phase),
      });
      try {
        const run = mode === 'code'
          ? client.executePreparedCode(prepared, { inputs: {} })
          : client.executePreparedTrace({ ...prepared, mode }, { inputs: {} });
        if (phase === 'startup') {
          await assert.rejects(run, isRuntimeProviderError);
        } else {
          await assert.rejects(run, { name: 'WorkerCrashedError', message: 'same failure' });
        }
      } finally {
        client.terminate();
      }
    });
  }
}

for (const [language, createClient] of [
  ['Python', () => new PythonWorkerClient(workerOptions)],
  ['Java', () => new JavaWorkerClient(workerOptions)],
  ['C++', () => new CppWorkerClient({
    ...workerOptions, compilerWasmUrl: '/', linkerWasmUrl: '/', sysrootUrl: '/', runtimeHeaderUrl: '/',
  })],
] as const) {
  test(`${language} rejects a startup crash during execution`, async () => {
    const client = createClient();
    try {
      await assert.rejects(client.executeCode({ code: '', functionName: 'f', inputs: {} }), isRuntimeProviderError);
    } finally {
      client.terminate();
    }
  });
}

test('Python compatibility batch rejects when the second case worker cannot start', async () => {
  let workers = 0;
  let executions = 0;
  const provider = createPythonPreparedExecutionProvider({
    replenishStandbyAfterUse: false,
    createWorkerClient: () => new PythonWorkerClient({
      ...workerOptions,
      workerFactory: () => {
        if (workers++ > 0) return failingWorker('startup');
        const worker: BrowserWorkerLike = {
          onerror: null, onmessage: null, terminate() {},
          postMessage(message) {
            const { id, protocolToken, type } = message as Record<string, string>;
            let payload: unknown = { success: true, loadTimeMs: 1 };
            if (type === 'prepare-program') {
              payload = {
                success: true, mode: 'code', consoleOutput: [],
                artifact: { mode: 'code', isolationProfile: { tier: 'hard-isolated' } },
              };
            } else if (type === 'execute-prepared-program') {
              executions++;
              payload = { success: true, output: 1, consoleOutput: [] };
            }
            worker.onmessage?.({ data: { id, protocolToken, type: 'result', payload } } as MessageEvent);
          },
        };
        queueMicrotask(() => worker.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent));
        return worker;
      },
    }),
  });
  try {
    const preparation = await provider.prepareProgram({ mode: 'code', code: 'def f(): return 1', functionName: 'f' });
    assert.equal(preparation.kind, 'prepared');
    assert.equal(preparation.program.mode, 'code');
    assert.ok(preparation.program.executeBatchIsolated);
    await assert.rejects(preparation.program.executeBatchIsolated({ inputBatch: [{}, {}] }), isRuntimeProviderError);
    assert.equal(executions, 1);
    assert.equal(workers, 3, 'the failing runner retries initialization once');
  } finally {
    provider.terminate();
  }
});

#!/usr/bin/env npx tsx

import { createBrowserHarness, resolveBrowserHarnessAssets } from '../packages/harness-browser/src';
import { CppWorkerClient } from '../packages/harness-browser/src/cpp-worker-client';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
}

const workerInstances: MockWorker[] = [];

class MockWorker {
  public onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public readonly url: string | URL;
  public terminated = false;

  constructor(url: string | URL) {
    this.url = url;
    workerInstances.push(this);
    queueMicrotask(() => {
      this.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent<WorkerMessage>);
    });
  }

  postMessage(message: WorkerMessage): void {
    queueMicrotask(() => {
      const { id, type, payload } = message;
      if (type === 'init') {
        this.onmessage?.({
          data: {
            id,
            type: 'init',
            payload: { success: true, loadTimeMs: 1 },
          },
        } as MessageEvent<WorkerMessage>);
        return;
      }

      if (type === 'execute-code' || type === 'execute-code-interview') {
        this.onmessage?.({
          data: {
            id,
            type,
            payload: { success: true, output: payload ?? null, consoleOutput: [] },
          },
        } as MessageEvent<WorkerMessage>);
        return;
      }

      if (type === 'compile-run') {
        this.onmessage?.({
          data: {
            id,
            type,
            payload: { success: true, output: payload ?? null, consoleOutput: [] },
          },
        } as MessageEvent<WorkerMessage>);
        return;
      }

      if (type === 'execute-with-tracing') {
        this.onmessage?.({
          data: {
            id,
            type,
            payload: {
              success: true,
              output: null,
              events: [],
              sourceText: '',
              trace: {
                schemaVersion: 'runtime-trace-2026-04-28',
                language: 'cpp',
                runId: 'cpp:run',
                events: [],
                lineEventCount: 0,
                traceStepCount: 0,
              },
              consoleOutput: [],
              executionTimeMs: 1,
              lineEventCount: 0,
              traceStepCount: 0,
            },
          },
        } as MessageEvent<WorkerMessage>);
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

async function main(): Promise<void> {
  const originalWorker = globalThis.Worker;
  // @ts-expect-error test stub
  globalThis.Worker = MockWorker;

  try {
    const defaultAssets = resolveBrowserHarnessAssets();
    assertCondition(defaultAssets.pythonWorker === '/workers/pyodide-worker.js', 'Default python worker path should resolve');
    assertCondition(defaultAssets.javaWorker === '/workers/java-worker.js', 'Default java worker path should resolve');
    assertCondition(defaultAssets.cppWorker === '/workers/cpp-worker.js', 'Default C++ worker path should resolve');
    assertCondition(defaultAssets.cppClangWasm === '/workers/vendor/cpp/clang.wasm', 'Default C++ clang path should resolve');
    assertCondition(
      defaultAssets.cppCompilerBundle === '/workers/vendor/cpp/yowasp/bundle.js',
      'Default C++ compiler bundle path should resolve'
    );
    assertCondition(
      defaultAssets.typescriptCompiler === '/workers/vendor/typescript.js',
      'Default TypeScript compiler path should resolve'
    );

    const customAssets = resolveBrowserHarnessAssets({
      assetBaseUrl: '/sdk-assets',
      assets: {
        javascriptWorker: 'workers/js-runtime.js',
        pythonWorker: 'https://cdn.example.com/python-worker.js',
        cppClangWasm: 'https://cdn.example.com/cpp/clang.wasm',
        cppCompilerBundle: 'https://cdn.example.com/cpp/bundle.js',
      },
    });
    assertCondition(customAssets.pythonWorker === 'https://cdn.example.com/python-worker.js', 'Explicit asset URLs should be preserved');
    assertCondition(customAssets.cppClangWasm === 'https://cdn.example.com/cpp/clang.wasm', 'Explicit C++ asset URLs should be preserved');
    assertCondition(customAssets.cppCompilerBundle === 'https://cdn.example.com/cpp/bundle.js', 'Explicit C++ compiler bundle URLs should be preserved');
    assertCondition(customAssets.javascriptWorker === '/sdk-assets/workers/js-runtime.js', 'Relative custom assets should join assetBaseUrl');
    console.log('PASS: browser harness asset resolution');

    const harnessA = createBrowserHarness({ assetBaseUrl: '/instance-a' });
    const harnessB = createBrowserHarness({ assetBaseUrl: '/instance-b', debug: true });
    assertCondition(harnessA.isLanguageSupported('java'), 'Browser harness should expose Java support');
    assertCondition(harnessA.isLanguageSupported('cpp'), 'Browser harness should expose C++ support');

    await harnessA.getClient('javascript').init();
    await harnessA.getClient('java').init();
    await harnessA.getClient('cpp').init();
    await harnessB.getClient('python').init();

    assertCondition(
      workerInstances.some((worker) => String(worker.url).startsWith('/instance-a/javascript-worker.js')),
      'Harness A should use its own JavaScript worker URL'
    );
    assertCondition(
      workerInstances.some((worker) => String(worker.url).startsWith('/instance-a/java-worker.js')),
      'Harness A should use its own Java worker URL'
    );
    assertCondition(
      workerInstances.some((worker) => String(worker.url).startsWith('/instance-a/cpp-worker.js')),
      'Harness A should use its own C++ worker URL'
    );
    assertCondition(
      workerInstances.some((worker) => String(worker.url).startsWith('/instance-b/pyodide-worker.js?dev=')),
      'Harness B should use its own Python worker URL when debug is enabled'
    );
    console.log('PASS: browser harness uses per-instance worker URLs');

    const survivingWorker = workerInstances.find((worker) => String(worker.url).startsWith('/instance-b/pyodide-worker.js'));
    harnessA.dispose();
    assertCondition(
      Boolean(survivingWorker && !survivingWorker.terminated),
      'Disposing one harness should not terminate another harness instance'
    );

    const executeResult = await harnessB.getClient('python').executeCode('result = 1', 'noop', {}, 'function');
    assertCondition(executeResult.success, 'Surviving harness instance should still execute after a peer is disposed');
    console.log('PASS: browser harness instances are isolated');

    const javaExecuteResult = await harnessA
      .getClient('java')
      .executeCode('int search(int[] nums, int target) { return 0; }', 'search', {}, 'function');
    assertCondition(javaExecuteResult.success, 'Java runtime should route function-style executeCode through the browser harness client');
    console.log('PASS: browser harness routes Java runtime requests');

    const javaInterviewResult = await harnessA
      .getClient('java')
      .executeCodeInterviewMode('int search(int[] nums, int target) { return 0; }', 'search', {}, 'function');
    assertCondition(
      javaInterviewResult.success,
      'Java runtime should route interview-mode executeCode through the browser harness client'
    );
    console.log('PASS: browser harness routes Java interview-mode requests');

    const cppExecuteResult = await harnessA
      .getClient('cpp')
      .executeCode('class Solution { public: int add(int a, int b) { return a + b; } };', 'add', {}, 'solution-method');
    assertCondition(cppExecuteResult.success, 'C++ runtime should route solution-method executeCode through the browser harness client');
    const cppTraceResult = await harnessA
      .getClient('cpp')
      .executeWithTracing('class Solution { public: int add(int a, int b) { return a + b; } };', 'add', {}, {}, 'solution-method');
    assertCondition(cppTraceResult.success, 'C++ runtime should route solution-method executeWithTracing through the browser harness client');
    console.log('PASS: browser harness routes C++ runtime requests');

    class HangingCppWorker extends MockWorker {
      postMessage(message: WorkerMessage): void {
        const payload = message.payload as { code?: string } | undefined;
        if (message.type === 'compile-run' && payload?.code?.includes('while(true)')) {
          return;
        }
        super.postMessage(message);
      }
    }

    const beforeTimeoutWorkerCount = workerInstances.length;
    // @ts-expect-error test stub
    globalThis.Worker = HangingCppWorker;
    const timeoutClient = new CppWorkerClient({
      workerUrl: '/workers/cpp-worker.js',
      clangWasmUrl: '/workers/vendor/cpp/clang.wasm',
      lldWasmUrl: '/workers/vendor/cpp/lld.wasm',
      sysrootUrl: '/workers/vendor/cpp/sysroot.tar',
      runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
      compilerBundleUrl: '/workers/vendor/cpp/yowasp/bundle.js',
      executionTimeoutMs: 5,
    });
    const timeoutResult = await timeoutClient.executeCode(
      'class Solution { public: int add(int a, int b) { while(true){} return a + b; } };',
      'add',
      { a: 1, b: 2 },
      'solution-method'
    );
    assertCondition(timeoutResult.success === false, 'C++ client timeout should return a failed execution result');
    assertCondition(
      String(timeoutResult.error).includes('timed out'),
      `C++ client timeout should explain the timeout, received ${String(timeoutResult.error)}`
    );
    assertCondition(workerInstances[beforeTimeoutWorkerCount]?.terminated === true, 'C++ client timeout should terminate the stuck worker');
    const recoveryResult = await timeoutClient.executeCode(
      'class Solution { public: int add(int a, int b) { return a + b; } };',
      'add',
      { a: 1, b: 2 },
      'solution-method'
    );
    assertCondition(recoveryResult.success, 'C++ client should recover by creating a fresh worker after timeout');
    timeoutClient.terminate();
    // @ts-expect-error test stub
    globalThis.Worker = MockWorker;
    console.log('PASS: C++ worker client hard timeout terminates and recovers');

    harnessB.disposeLanguage('python');
    assertCondition(Boolean(survivingWorker?.terminated), 'disposeLanguage should terminate the targeted runtime');
    console.log('PASS: browser harness disposeLanguage terminates the targeted runtime');
  } finally {
    globalThis.Worker = originalWorker;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

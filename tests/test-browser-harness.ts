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
  public messages: WorkerMessage[] = [];

  constructor(url: string | URL) {
    this.url = url;
    workerInstances.push(this);
    queueMicrotask(() => {
      this.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent<WorkerMessage>);
    });
  }

  postMessage(message: WorkerMessage): void {
    this.messages.push(message);
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

      if (type === 'warmup') {
        this.onmessage?.({
          data: {
            id,
            type: 'warmup',
            payload: { success: true, loadTimeMs: 2 },
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
    assertCondition(defaultAssets.csharpWorker === '/workers/csharp-worker.js', 'Default C# worker path should resolve');
    assertCondition(defaultAssets.csharpAssetBaseUrl === '/workers/vendor/csharp', 'Default C# asset base URL should resolve');
    assertCondition(defaultAssets.cppWorker === '/workers/cpp-worker.js', 'Default C++ worker path should resolve');
    assertCondition(defaultAssets.cppClangWasm === '', 'Default C++ raw clang path should be disabled');
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
        csharpAssetBaseUrl: 'runtimes/csharp',
        cppClangWasm: 'https://cdn.example.com/cpp/clang.wasm',
        cppCompilerBundle: 'https://cdn.example.com/cpp/bundle.js',
      },
    });
    assertCondition(customAssets.pythonWorker === 'https://cdn.example.com/python-worker.js', 'Explicit asset URLs should be preserved');
    assertCondition(customAssets.cppClangWasm === 'https://cdn.example.com/cpp/clang.wasm', 'Explicit C++ asset URLs should be preserved');
    assertCondition(customAssets.cppCompilerBundle === 'https://cdn.example.com/cpp/bundle.js', 'Explicit C++ compiler bundle URLs should be preserved');
    assertCondition(customAssets.javascriptWorker === '/sdk-assets/workers/js-runtime.js', 'Relative custom assets should join assetBaseUrl');
    assertCondition(customAssets.csharpAssetBaseUrl === '/sdk-assets/runtimes/csharp', 'Relative C# asset base should join assetBaseUrl');
    console.log('PASS: browser harness asset resolution');

    const harnessA = createBrowserHarness({ assetBaseUrl: '/instance-a' });
    const harnessB = createBrowserHarness({ assetBaseUrl: '/instance-b', debug: true });
    assertCondition(harnessA.isLanguageSupported('java'), 'Browser harness should expose Java support');
    assertCondition(harnessA.isLanguageSupported('csharp'), 'Browser harness should expose C# support');
    assertCondition(harnessA.isLanguageSupported('cpp'), 'Browser harness should expose C++ support');
    const cppProfile = harnessA.getProfile('cpp');
    const csharpProfile = harnessA.getProfile('csharp');
    assertCondition(csharpProfile.capabilities.execution.styles.interviewMode, 'C# profile should support interview-mode execution');
    assertCondition(cppProfile.capabilities.execution.styles.function, 'C++ profile should support function execution');
    assertCondition(cppProfile.capabilities.execution.styles.solutionMethod, 'C++ profile should support solution-method execution');
    assertCondition(cppProfile.capabilities.execution.styles.opsClass, 'C++ profile should support ops-class execution');
    assertCondition(cppProfile.capabilities.execution.styles.script, 'C++ profile should support script execution');
    assertCondition(cppProfile.capabilities.execution.styles.interviewMode, 'C++ profile should support interview-mode execution');

    await harnessA.getClient('javascript').init();
    await harnessA.getClient('java').init();
    await harnessA.getClient('csharp').init();
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
      workerInstances.some((worker) => String(worker.url).startsWith('/instance-a/csharp-worker.js')),
      'Harness A should use its own C# worker URL'
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

    const javaWarmupResult = await harnessA.warmLanguage('java');
    const javaWarmupWorker = workerInstances.findLast((worker) => String(worker.url).startsWith('/instance-a/java-worker.js'));
    assertCondition(javaWarmupResult.success, 'Java warmLanguage should resolve successfully');
    assertCondition(
      javaWarmupWorker?.messages.at(-1)?.type === 'warmup',
      'Java warmLanguage should send the Java warmup worker request'
    );
    console.log('PASS: browser harness warms Java runtime on demand');

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
    const javaWorker = workerInstances.findLast((worker) => String(worker.url).startsWith('/instance-a/java-worker.js'));
    assertCondition(
      javaWorker?.messages.at(-1)?.type === 'execute-code',
      'Java executeCode should send execute-code instead of execute-with-tracing'
    );
    console.log('PASS: browser harness routes Java runtime requests');

    const javaInterviewResult = await harnessA
      .getClient('java')
      .executeCodeInterviewMode('int search(int[] nums, int target) { return 0; }', 'search', {}, 'function');
    assertCondition(
      javaInterviewResult.success,
      'Java runtime should route interview-mode executeCode through the browser harness client'
    );
    assertCondition(
      javaWorker?.messages.at(-1)?.type === 'execute-code-interview',
      'Java interview-mode executeCode should send execute-code-interview instead of execute-with-tracing'
    );
    console.log('PASS: browser harness routes Java interview-mode requests');

    const csharpExecuteResult = await harnessA
      .getClient('csharp')
      .executeCode('public class Solution { public int Add(int a, int b) => a + b; }', 'Add', { a: 2, b: 3 }, 'solution-method');
    assertCondition(csharpExecuteResult.success, 'C# runtime should route solution-method executeCode through the browser harness client');
    console.log('PASS: browser harness routes C# runtime requests');

    const csharpTraceResult = await harnessA
      .getClient('csharp')
      .executeWithTracing(
        'public class Solution { public int Add(int a, int b) { return a + b; } }',
        'Add',
        { a: 2, b: 3 },
        { maxTraceSteps: 10 },
        'solution-method'
      );
    assertCondition(csharpTraceResult.success, 'C# runtime should route executeWithTracing through the browser harness client');
    assertCondition(csharpTraceResult.trace.language === 'csharp', 'C# runtime should adapt worker events into a C# runtime trace');
    console.log('PASS: browser harness routes C# tracing requests');

    const csharpOpsClassResult = await harnessA
      .getClient('csharp')
      .executeCode(
        'public class Counter { public Counter(int start) {} public int Inc(int delta) => delta; }',
        'Counter',
        { operations: ['Counter', 'Inc'], arguments: [[1], [2]] },
        'ops-class'
      );
    assertCondition(csharpOpsClassResult.success, 'C# runtime should route ops-class executeCode through the browser harness client');
    console.log('PASS: browser harness routes C# ops-class requests');

    const csharpInterviewResult = await harnessA
      .getClient('csharp')
      .executeCodeInterviewMode(
        'public class Solution { public int Add(int a, int b) { return a + b; } }',
        'Add',
        { a: 2, b: 3 },
        'solution-method'
      );
    assertCondition(csharpInterviewResult.success, 'C# runtime should route interview-mode requests');
    console.log('PASS: browser harness routes C# interview-mode requests');

    const activeCSharpWorker = [...workerInstances]
      .reverse()
      .find((worker) => String(worker.url).startsWith('/instance-a/csharp-worker.js'));
    harnessA.disposeLanguage('csharp');
    assertCondition(Boolean(activeCSharpWorker?.terminated), 'disposeLanguage should terminate the C# worker');
    console.log('PASS: browser harness disposeLanguage terminates C# runtime');

    const cppExecuteResult = await harnessA
      .getClient('cpp')
      .executeCode('class Solution { public: int add(int a, int b) { return a + b; } };', 'add', {}, 'solution-method');
    assertCondition(cppExecuteResult.success, 'C++ runtime should route solution-method executeCode through the browser harness client');
    const cppTraceResult = await harnessA
      .getClient('cpp')
      .executeWithTracing('class Solution { public: int add(int a, int b) { return a + b; } };', 'add', {}, {}, 'solution-method');
    assertCondition(cppTraceResult.success, 'C++ runtime should route solution-method executeWithTracing through the browser harness client');
    const cppScriptResult = await harnessA
      .getClient('cpp')
      .executeCode('int result = 3;', '', {}, 'function');
    assertCondition(cppScriptResult.success, 'C++ runtime should route script-style executeCode through the browser harness client');
    const cppInterviewResult = await harnessA
      .getClient('cpp')
      .executeCodeInterviewMode('int result = 3;', '', {}, 'function');
    assertCondition(cppInterviewResult.success, 'C++ runtime should route interview-mode requests');
    console.log('PASS: browser harness routes C++ runtime requests');

    class HangingCppWorker extends MockWorker {
      postMessage(message: WorkerMessage): void {
        const payload = message.payload as { code?: string } | undefined;
        if (
          (message.type === 'compile-run' || message.type === 'execute-with-tracing' || message.type === 'execute-code-interview') &&
          payload?.code?.includes('while(true)')
        ) {
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
    assertCondition(timeoutResult.timeoutReason === 'client-timeout', 'C++ client timeout should carry client-timeout reason');
    assertCondition(timeoutResult.diagnosticStage === 'runtime', 'C++ execute timeout should be labeled as runtime stage');
    assertCondition(workerInstances[beforeTimeoutWorkerCount]?.terminated === true, 'C++ client timeout should terminate the stuck worker');
    const recoveryResult = await timeoutClient.executeCode(
      'class Solution { public: int add(int a, int b) { return a + b; } };',
      'add',
      { a: 1, b: 2 },
      'solution-method'
    );
    assertCondition(recoveryResult.success, 'C++ client should recover by creating a fresh worker after timeout');

    const traceTimeoutClient = new CppWorkerClient({
      workerUrl: '/workers/cpp-worker.js',
      clangWasmUrl: '/workers/vendor/cpp/clang.wasm',
      lldWasmUrl: '/workers/vendor/cpp/lld.wasm',
      sysrootUrl: '/workers/vendor/cpp/sysroot.tar',
      runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
      compilerBundleUrl: '/workers/vendor/cpp/yowasp/bundle.js',
      tracingTimeoutMs: 5,
    });
    const traceTimeoutResult = await traceTimeoutClient.executeWithTracing(
      'class Solution { public: int add(int a, int b) { while(true){} return a + b; } };',
      'add',
      { a: 1, b: 2 },
      {},
      'solution-method'
    );
    assertCondition(traceTimeoutResult.success === false, 'C++ tracing timeout should return a failed execution result');
    assertCondition(traceTimeoutResult.timeoutReason === 'client-timeout', 'C++ tracing timeout should carry client-timeout reason');
    assertCondition(
      traceTimeoutResult.trace.events.some((event) => event.kind === 'timeout'),
      'C++ tracing timeout should include a timeout runtime event'
    );
    traceTimeoutClient.terminate();

    const interviewTimeoutClient = new CppWorkerClient({
      workerUrl: '/workers/cpp-worker.js',
      clangWasmUrl: '/workers/vendor/cpp/clang.wasm',
      lldWasmUrl: '/workers/vendor/cpp/lld.wasm',
      sysrootUrl: '/workers/vendor/cpp/sysroot.tar',
      runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
      compilerBundleUrl: '/workers/vendor/cpp/yowasp/bundle.js',
      interviewTimeoutMs: 5,
    });
    const interviewClientTimeout = await interviewTimeoutClient.executeCodeInterviewMode(
      'class Solution { public: int add(int a, int b) { while(true){} return a + b; } };',
      'add',
      { a: 1, b: 2 },
      'solution-method'
    );
    assertCondition(interviewClientTimeout.error === 'Time Limit Exceeded', 'C++ interview client timeout should be sanitized');
    assertCondition(
      interviewClientTimeout.timeoutReason === 'client-timeout',
      'C++ interview client timeout should preserve client-timeout reason'
    );
    assertCondition(interviewClientTimeout.diagnosticStage === 'interview', 'C++ interview timeout should be labeled as interview stage');
    interviewTimeoutClient.terminate();

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

#!/usr/bin/env npx tsx

import { createBrowserHarness, resolveBrowserHarnessAssets } from '../packages/harness-browser/src';

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
              trace: [],
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
    assertCondition(
      defaultAssets.typescriptCompiler === '/workers/vendor/typescript.js',
      'Default TypeScript compiler path should resolve'
    );

    const customAssets = resolveBrowserHarnessAssets({
      assetBaseUrl: '/sdk-assets',
      assets: {
        javascriptWorker: 'workers/js-runtime.js',
        pythonWorker: 'https://cdn.example.com/python-worker.js',
      },
    });
    assertCondition(customAssets.pythonWorker === 'https://cdn.example.com/python-worker.js', 'Explicit asset URLs should be preserved');
    assertCondition(customAssets.javascriptWorker === '/sdk-assets/workers/js-runtime.js', 'Relative custom assets should join assetBaseUrl');
    console.log('PASS: browser harness asset resolution');

    const harnessA = createBrowserHarness({ assetBaseUrl: '/instance-a' });
    const harnessB = createBrowserHarness({ assetBaseUrl: '/instance-b', debug: true });
    assertCondition(harnessA.isLanguageSupported('java'), 'Browser harness should expose Java support');

    await harnessA.getClient('javascript').init();
    await harnessA.getClient('java').init();
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

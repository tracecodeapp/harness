#!/usr/bin/env npx tsx

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
}

interface RewriteCall {
  source: string;
  executionStyle: string;
  entryName: string;
  exportsSource: string;
  exportsClassName: string;
  packageName: string;
}

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function loadWorkerSource(): Promise<string> {
  const workerPath = join(process.cwd(), 'workers', 'java', 'java-worker.js');
  return readFile(workerPath, 'utf8');
}

function createWorkerHarness(workerSource: string) {
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();
  const rewriteCalls: RewriteCall[] = [];
  const stringFiles: Array<{ path: string; source: string }> = [];
  let nextId = 0;

  const selfObject: {
    postMessage: (message: WorkerMessage) => void;
    onmessage: ((event: { data: WorkerMessage }) => void) | null;
    importScripts: (...urls: string[]) => void;
    cheerpjInit: () => Promise<void>;
    cheerpOSAddStringFile: (path: string, source: string) => Promise<void>;
    cheerpjRunLibrary: () => Promise<unknown>;
    close: () => void;
  } = {
    postMessage: (message: WorkerMessage) => {
      if (message.type === 'worker-ready') {
        return;
      }
      const id = message.id;
      if (!id) return;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timeoutId);
      if (message.type === 'error') {
        const payload = message.payload as { error?: unknown } | undefined;
        entry.reject(new Error(String(payload?.error ?? 'Worker error')));
        return;
      }
      entry.resolve(message.payload);
    },
    onmessage: null,
    importScripts: () => {},
    cheerpjInit: async () => {},
    cheerpOSAddStringFile: async (path: string, source: string) => {
      stringFiles.push({ path, source });
    },
    cheerpjRunLibrary: async () => ({
      spike: {
        browser: {
          BrowserCompileAndTraceLibrary: {
            compileAndTrace: async (_sourcePath: string, _classesDir: string, mainClassName: string) => {
              if (mainClassName.includes('warmup')) {
                return JSON.stringify({ success: true, output: '0', events: [] });
              }
              return JSON.stringify({
                success: true,
                output: JSON.stringify([0, 1]),
                events: [
                  'line=1 call __tracecodeScript',
                  'line=2 seen={}',
                  'line=99 return __tracecodeScript',
                ],
              });
            },
          },
        },
      },
      harness: {
        browser: {
          JavaRewriteLibrary: {
            rewriteSource: async (
              source: string,
              executionStyle: string,
              entryName: string,
              exportsSource: string,
              exportsClassName: string,
              packageName: string
            ) => {
              rewriteCalls.push({ source, executionStyle, entryName, exportsSource, exportsClassName, packageName });
              return `package ${packageName};\n${source}\n${exportsSource.replace('public class Exports', `public class ${exportsClassName}`)}`;
            },
          },
        },
      },
    }),
    close: () => {},
  };

  const context = vm.createContext({
    console,
    self: selfObject,
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    queueMicrotask,
  });

  vm.runInContext(workerSource, context, {
    filename: 'java-worker.js',
  });

  const onmessage = selfObject.onmessage;
  assertCondition(typeof onmessage === 'function', 'Worker did not register onmessage handler');

  async function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
    const id = String(++nextId);
    const responsePromise = new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        reject(new Error(`Timed out waiting for response: ${type}`));
      }, 5000);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeoutId });
    });

    onmessage?.({ data: { id, type, payload } });
    return responsePromise;
  }

  function terminate(): void {
    onmessage?.({ data: { type: 'terminate' } });
  }

  return { rewriteCalls, sendMessage, stringFiles, terminate };
}

async function main(): Promise<void> {
  const workerSource = await loadWorkerSource();
  const harness = createWorkerHarness(workerSource);

  try {
    const init = await harness.sendMessage<{ success: boolean; loadTimeMs: number }>('init');
    assertCondition(init.success === true, 'Init should succeed');
    console.log('PASS: java worker init with mocked CheerpJ bridge');

    const scriptCode = `import java.util.HashMap;
import java.util.Map;

Map<Integer, Integer> seen = new HashMap<>();
result = new int[] { 0, 1 };`;

    const execute = await harness.sendMessage<{
      success: boolean;
      output: unknown;
      events?: string[];
      sourceText?: string;
    }>('execute-code', {
      code: scriptCode,
      functionName: '',
      inputs: {},
      executionStyle: 'function',
    });

    assertCondition(execute.success === true, 'Java script execution should succeed');
    assertCondition(JSON.stringify(execute.output) === JSON.stringify([0, 1]), 'Java script output should serialize result');
    assertCondition(execute.sourceText === scriptCode, 'Java script execution should preserve original source text');
    assertCondition(
      Array.isArray(execute.events) && execute.events.some((event) => event.includes('call <module>')),
      'Java script trace events should expose <module> call events'
    );
    assertCondition(
      Array.isArray(execute.events) && execute.events.some((event) => event === 'line=5 return <module>'),
      'Java script return event should remap generated wrapper line to the last user line'
    );

    const scriptRewrite = harness.rewriteCalls.at(-1);
    assertCondition(Boolean(scriptRewrite), 'Java script request should call rewrite bridge');
    assertCondition(scriptRewrite?.executionStyle === 'solution-method', 'Java script request should reuse solution-method rewrite path');
    assertCondition(scriptRewrite?.entryName === '__tracecodeScript', 'Java script request should use synthetic script method');
    assertCondition(
      scriptRewrite?.source.includes('class Solution { Object __tracecodeScript() { Object result = null;'),
      'Java script source should be wrapped in a synthetic Solution method'
    );
    assertCondition(
      scriptRewrite?.source.startsWith('import java.util.HashMap;\nimport java.util.Map;'),
      'Java script source should preserve import prelude before the wrapper'
    );
    console.log('PASS: java script mode normalizes to synthetic solution method');

    let invalidRejected = false;
    try {
      await harness.sendMessage('execute-code', {
        code: 'result = 1;',
        functionName: '',
        inputs: {},
        executionStyle: 'solution-method',
      });
    } catch (error) {
      invalidRejected =
        error instanceof Error &&
        error.message.includes('script-mode execution only supports executionStyle="function"');
    }
    assertCondition(invalidRejected, 'Java script mode should reject non-function execution styles');
    console.log('PASS: java script mode rejects non-function execution style');
  } finally {
    harness.terminate();
  }

  console.log('\nJava runtime worker tests passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

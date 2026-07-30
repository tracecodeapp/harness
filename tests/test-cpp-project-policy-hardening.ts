#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

import { CppWorkerClient } from '../packages/harness-cpp/src/cpp-worker-client';
import { createRuntimeWorkspace } from '../packages/harness-project/src/index';

const testFilePath = fileURLToPath(import.meta.url);
const testDirectory = dirname(testFilePath);

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejectedMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function loadCppWorkerPolicyContext(): Promise<vm.Context> {
  const sharedKernelPolicySource = (await readFile(join(testDirectory, '../workers/shared/runtime-kernel-policy.js'), 'utf8'))
    .replace(/\bexport\s+/g, '');
  const workerSource = (await readFile(join(testDirectory, '../workers/cpp/cpp-worker.js'), 'utf8')).replace(
    /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/shared\/runtime-kernel-policy\.js['"];\s*/m,
    ''
  );
  const workerLocation = new URL(pathToFileURL(join(testDirectory, '../workers/cpp/cpp-worker.js')).href);
  const context = vm.createContext({
    console,
    URL,
    TextEncoder,
    TextDecoder,
    WebAssembly,
    Date,
    performance: { now: () => 0 },
    Uint8Array,
    BigInt,
    Map,
    Set,
    Error,
    JSON,
    Object,
    String,
    Number,
    Math,
    RegExp,
    Promise,
    globalThis: null,
    self: null,
    location: workerLocation,
    postMessage() {},
    fetch: async () => ({ ok: false, status: 404, statusText: 'Not Found' }),
    crypto: globalThis.crypto,
  });
  context.globalThis = context;
  context.self = context;
  vm.runInContext(
    sharedKernelPolicySource + '\n' +
      'const isRuntimeDeviceDirectory = isRuntimeKernelDeviceDirectory;\n' +
      'const isRuntimeDeviceNamespacePath = isRuntimeKernelDeviceNamespacePath;\n' +
      'const isRuntimeProcPath = isRuntimeKernelProcPath;\n' +
      workerSource +
      '\nglobalThis.__tracecodeCppPolicy = { toCppLiteral, traceBudgetHardStopForOptions, traceLineBudgetHardStopForOptions };',
    context,
    { filename: 'cpp-worker.js' }
  );
  return context;
}

async function testCppGeneratedDriverInputsAreDataOnly(): Promise<void> {
  const context = await loadCppWorkerPolicyContext();
  const result = vm.runInContext(
    `(() => {
      const rejected = [];
      for (const [label, value, type] of [
        ['int', '0; tracecode::write_result_json_raw("123"); std::exit(0); 0', 'int'],
        ['vector', ['0; tracecode::write_result_json_raw("123"); 0'], 'vector<int>'],
        ['map-key', { '0; tracecode::write_result_json_raw("123"); 0': 1 }, 'map<int,int>'],
        ['double', '1.5; std::exit(0);', 'double'],
      ]) {
        try {
          __tracecodeCppPolicy.toCppLiteral(value, type);
        } catch {
          rejected.push(label);
        }
      }
      return {
        rejected,
        validInt: __tracecodeCppPolicy.toCppLiteral(42, 'int'),
        validDouble: __tracecodeCppPolicy.toCppLiteral(1.25, 'double'),
      };
    })()`,
    context
  ) as { rejected: string[]; validInt: string; validDouble: string };
  assertCondition(
    result.rejected.join(',') === 'int,vector,map-key,double' &&
      result.validInt === '42' &&
      result.validDouble === '1.25',
    `C++ numeric driver literals should reject source-shaped non-numeric inputs: ${JSON.stringify(result)}`
  );
}

async function testCppSoftTraceBudgetKeepsLoopHardStops(): Promise<void> {
  const context = await loadCppWorkerPolicyContext();
  const result = vm.runInContext(
    `(() => ({
      line: __tracecodeCppPolicy.traceLineBudgetHardStopForOptions({
        traceOptions: { softTraceBudget: true, maxLineEvents: 4, maxTraceSteps: 1000, maxStoredEvents: 1000 },
      }),
      singleLine: __tracecodeCppPolicy.traceLineBudgetHardStopForOptions({
        traceOptions: { softTraceBudget: true, maxSingleLineHits: 4, maxTraceSteps: 1000, maxStoredEvents: 1000 },
      }),
      storedOnly: __tracecodeCppPolicy.traceBudgetHardStopForOptions({
        traceOptions: { softTraceBudget: true, maxTraceSteps: 4, maxStoredEvents: 1000 },
      }),
    }))()`,
    context
  ) as { line: boolean; singleLine: boolean; storedOnly: boolean };
  assertCondition(
    result.line === true && result.singleLine === true && result.storedOnly === false,
    `C++ soft trace budgets should not disable line hard-stop guards: ${JSON.stringify(result)}`
  );
}

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
  protocolToken?: string;
}

async function testCppClientTerminatesCompileStageTimeouts(): Promise<void> {
  const previousWorker = (globalThis as { Worker?: unknown }).Worker;
  const workers: CompileStageHangingWorker[] = [];

  class CompileStageHangingWorker {
    public onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
    public onerror: ((event: ErrorEvent) => void) | null = null;
    public terminated = false;

    constructor(public readonly url: string | URL) {
      workers.push(this);
      queueMicrotask(() => {
        if (!this.terminated) this.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent<WorkerMessage>);
      });
    }

    postMessage(message: WorkerMessage): void {
      if (this.terminated) return;
      const { id, type, protocolToken } = message;
      if (type === 'init') {
        queueMicrotask(() => {
          if (!this.terminated) {
            this.onmessage?.({
              data: { id, type: 'init', protocolToken, payload: { success: true, loadTimeMs: 1 } },
            } as MessageEvent<WorkerMessage>);
          }
        });
        return;
      }
      if (type === 'compile-run') {
        queueMicrotask(() => {
          if (!this.terminated) {
            this.onmessage?.({
              data: {
                id,
                type: 'runtime-progress',
                protocolToken,
                payload: { stage: 'compile:start', detail: { sourceBytes: 100 } },
              },
            } as MessageEvent<WorkerMessage>);
          }
        });
      }
    }

    terminate(): void {
      this.terminated = true;
    }
  }

  (globalThis as { Worker?: unknown }).Worker = CompileStageHangingWorker as unknown as typeof Worker;
  const client = new CppWorkerClient({
    workerUrl: '/workers/cpp-worker.js',
    clangWasmUrl: '/workers/vendor/cpp/clang.wasm',
    lldWasmUrl: '/workers/vendor/cpp/lld.wasm',
    sysrootUrl: '/workers/vendor/cpp/sysroot.tar',
    runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
    compilerBundleUrl: '/workers/vendor/cpp/yowasp/bundle.js',
    executionTimeoutMs: 5,
  });
  try {
    const result = await client.executeCode({ code: 'class Solution { public: int add(int a, int b) { return a + b; } };', functionName: 'add', inputs: { a: 1, b: 2 }, executionStyle: 'solution-method' });
    assertCondition(result.kind === 'limit' && result.reason === 'client-timeout', `C++ compile-stage timeout should fail closed: ${JSON.stringify(result)}`);
    assertCondition(workers[0]?.terminated === true, 'C++ compile-stage timeout should terminate the worker');
  } finally {
    client.terminate();
    if (previousWorker === undefined) {
      delete (globalThis as { Worker?: unknown }).Worker;
    } else {
      (globalThis as { Worker?: unknown }).Worker = previousWorker;
    }
  }
}

async function testNpmIgnoreScriptsSkipsLifecycleHooks(): Promise<void> {
  const scriptsRun: string[] = [];
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'package.json',
        contents: JSON.stringify({
          name: 'policy-test',
          version: '1.0.0',
          scripts: {
            prebuild: 'node scripts/prebuild.js',
            build: 'node scripts/build.js',
            postbuild: 'node scripts/postbuild.js',
          },
        }, null, 2),
      },
      { path: 'scripts/prebuild.js', contents: '' },
      { path: 'scripts/build.js', contents: '' },
      { path: 'scripts/postbuild.js', contents: '' },
    ],
    nodeRunner: async (request) => {
      scriptsRun.push(basename(request.scriptPath));
      return { stdout: `ran:${basename(request.scriptPath)}\n`, stderr: '', exitCode: 0 };
    },
  });
  try {
    const result = await workspace.runCommand('npm run build --ignore-scripts');
    assertCondition(result.exitCode === 0, `npm run --ignore-scripts should succeed: ${JSON.stringify(result)}`);
    assertCondition(
      scriptsRun.join(',') === 'build.js',
      `npm run --ignore-scripts should skip pre/post lifecycle hooks: ${JSON.stringify({ scriptsRun, result })}`
    );
  } finally {
    await workspace.destroy();
  }
}

async function testProjectCommandStepGroupsAreBounded(): Promise<void> {
  const error = await rejectedMessage(() => createRuntimeWorkspace({
    projectSession: {
      id: 'many-steps',
      commands: {
        tooMany: {
          steps: Array.from({ length: 65 }, () => 'printf "step\\n"'),
        },
      },
    },
  }));
  assertCondition(
    error.includes('must include at most 64 steps'),
    `project command groups should reject unbounded step lists: ${error}`
  );

  const workspace = await createRuntimeWorkspace({
    executionLimits: { maxCommandCount: 1 },
    projectSession: {
      id: 'limited-steps',
      commands: {
        tooManyForBudget: {
          steps: ['printf "one\\n"', 'printf "two\\n"'],
        },
      },
    },
  });
  try {
    const result = await workspace.runProjectCommand('tooManyForBudget');
    assertCondition(
      result.exitCode === 2 && result.stderr.includes('Project command has too many steps'),
      `project command groups should respect aggregate command-count limits: ${JSON.stringify(result)}`
    );
  } finally {
    await workspace.destroy();
  }
}

async function main(): Promise<void> {
  await testCppGeneratedDriverInputsAreDataOnly();
  await testCppSoftTraceBudgetKeepsLoopHardStops();
  await testCppClientTerminatesCompileStageTimeouts();
  await testNpmIgnoreScriptsSkipsLifecycleHooks();
  await testProjectCommandStepGroupsAreBounded();
  console.log('PASS: C++ and project policy hardening checks');
}

test('cpp project policy hardening', main);

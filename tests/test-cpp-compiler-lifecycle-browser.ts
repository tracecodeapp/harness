#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand, waitForHttp } from './example-app-smoke';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function compilerIntegrity(workersRoot: string, origin: string): Promise<{
  assets: Array<{ url: string; size: number; sha256: string }>;
}> {
  const assets = [];
  for (const file of [
    'bundle.js',
    'llvm-resources.tar',
    'llvm.core.wasm',
    'llvm.core2.wasm',
    'llvm.core3.wasm',
    'llvm.core4.wasm',
  ]) {
    const bytes = await readFile(join(workersRoot, 'cpp', 'compiler', file));
    assets.push({
      url: `${origin}/workers/cpp/compiler/${file}`,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return { assets };
}

async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-cpp-lifecycle-browser-'));
  const workersRoot = join(tempRoot, 'workers');
  const port = 5400 + Math.floor(Math.random() * 200);
  const origin = `http://127.0.0.1:${port}`;

  await runCommand('pnpm', ['exec', 'tsx', 'src/cli.ts', 'sync-assets', workersRoot, '--languages', 'cpp'], root);
  await build({
    entryPoints: [join(root, 'packages', 'runtime-cpp', 'src', 'cpp-worker-client.ts')],
    outfile: join(tempRoot, 'cpp-worker-client.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    tsconfig: join(root, 'tsconfig.base.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  await build({
    entryPoints: [join(root, 'packages', 'runtime-cpp', 'src', 'cpp-prepared-provider.ts')],
    outfile: join(tempRoot, 'cpp-prepared-provider.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    tsconfig: join(root, 'tsconfig.base.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  await writeFile(join(tempRoot, 'index.html'), '<!doctype html><title>C++ lifecycle benchmark</title>', 'utf8');

  const server = spawn('python3', ['-c', [
    'from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler',
    'import os',
    'class Handler(SimpleHTTPRequestHandler):',
    '    def end_headers(self):',
    '        self.send_header("Cross-Origin-Opener-Policy", "same-origin")',
    '        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")',
    '        self.send_header("Cache-Control", "no-cache")',
    '        super().end_headers()',
    `os.chdir(${JSON.stringify(tempRoot)})`,
    `ThreadingHTTPServer(("127.0.0.1", ${port}), Handler).serve_forever()`,
  ].join('\n')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

  const browser = await chromium.launch({ headless: true });
  try {
    await waitForHttp(origin, 30_000);
    const manifest = await compilerIntegrity(workersRoot, origin);
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    await page.goto(origin);
    const result = await page.evaluate(`(async () => {
      const { CppWorkerClient } = await import('/cpp-worker-client.js');
      const { createCppPreparedExecutionProvider } = await import('/cpp-prepared-provider.js');
      const workerOptions = {
        workerUrl: '/workers/cpp-worker.js',
        compilerFrameUrl: '/workers/cpp-compiler-frame.html',
        compilerWorkerUrl: '/workers/cpp-compiler-worker.js',
        compilerWasmUrl: '',
        linkerWasmUrl: '',
        sysrootUrl: '',
        runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
        compilerBundleUrl: '/workers/cpp/compiler/bundle.js',
        compilerIntegrity: ${JSON.stringify(manifest)},
        executionTimeoutMs: 30000,
      };
      const client = new CppWorkerClient(workerOptions);
      const execute = async (code) => {
        const startedAt = performance.now();
        const response = await client.executeCode({ code: code, functionName: 'add', inputs: { a: 2, b: 3 }, executionStyle: 'solution-method' });
        return {
          durationMs: Math.round(performance.now() - startedAt),
          success: response.kind === 'completed',
          output: response.kind === 'completed' ? response.output : undefined,
          error: response.kind === 'completed' ? undefined : response.error,
          timings: response.timings,
          compilerFrames: document.querySelectorAll('iframe').length,
        };
      };
      const cold = await execute('class Solution { public: int add(int a, int b) { return a + b; } };');
      const edited = await execute('class Solution { public: int add(int a, int b) { return a + b + 1; } };');
      const exact = await execute('class Solution { public: int add(int a, int b) { return a + b + 1; } };');
      const invalid = await execute('class Solution { public: int add(int a, int b) { return a + ; } };');
      const recovered = await execute('class Solution { public: int add(int a, int b) { return a * b; } };');

      const sharedCompilerCoordinator = new CppWorkerClient(workerOptions);
      const sharedCompilerProvider = createCppPreparedExecutionProvider({
        createWorkerClient: () => new CppWorkerClient({
          ...workerOptions,
          trustedCompilerService: sharedCompilerCoordinator,
        }),
        warmCompilerOnInit: true,
      });
      const sharedWarmStartedAt = performance.now();
      await sharedCompilerProvider.init();
      const sharedWarmMs = performance.now() - sharedWarmStartedAt;
      const sharedSource =
        'class Solution { public: int add(int a, int b) { return a + b + 7; } };';
      const prepareShared = async () => {
        const startedAt = performance.now();
        const preparation = await sharedCompilerProvider.prepareProgram({
          mode: 'code',
          code: sharedSource,
          functionName: 'add',
          executionStyle: 'solution-method',
        });
        if (preparation.kind !== 'prepared' || preparation.program.mode !== 'code') {
          throw new Error('Shared-compiler C++ preparation failed: ' + JSON.stringify(preparation));
        }
        const result = await preparation.program.executeIsolated({
          inputs: { a: 2, b: 3 },
        });
        await preparation.program.dispose();
        return {
          durationMs: performance.now() - startedAt,
          timings: preparation.timings,
          result,
          framesAfterRunnerDisposal: document.querySelectorAll('iframe').length,
        };
      };
      const sharedFirst = await prepareShared();
      const sharedExact = await prepareShared();
      const sharedFramesBeforeCompilerRetirement =
        document.querySelectorAll('iframe').length;
      sharedCompilerProvider.terminate();
      const sharedFramesAfterRunnerProviderRetirement =
        document.querySelectorAll('iframe').length;
      sharedCompilerCoordinator.terminate();
      const sharedFramesAfterCompilerRetirement =
        document.querySelectorAll('iframe').length;

      const preparedProvider = createCppPreparedExecutionProvider({
        createWorkerClient: () => new CppWorkerClient(workerOptions),
      });
      await preparedProvider.init();
      const prepared = await preparedProvider.prepareProgram({
        mode: 'code',
        code: [
          '#include <vector>',
          'class Solution {',
          'public:',
          '  int observe(std::vector<int>& nums, bool hang) {',
          '    if (hang) { while (true) {} }',
          '    static int calls = 0;',
          '    calls += 1;',
          '    nums.push_back(99);',
          '    return calls * 100 + static_cast<int>(nums.size());',
          '  }',
          '};',
        ].join('\\n'),
        functionName: 'observe',
        executionStyle: 'solution-method',
      });
      if (prepared.kind !== 'prepared' || prepared.program.mode !== 'code') {
        throw new Error('C++ code preparation failed: ' + JSON.stringify(prepared));
      }
      const mutableInput = [1, 2];
      const firstPreparedCase = await prepared.program.executeIsolated({
        inputs: { nums: mutableInput, hang: false },
      });
      const secondPreparedCase = await prepared.program.executeIsolated({
        inputs: { nums: mutableInput, hang: false },
      });
      if (typeof prepared.program.executeBatchIsolated !== 'function') {
        throw new Error('C++ prepared program did not expose isolated batch execution.');
      }
      const preparedBatchCases = await prepared.program.executeBatchIsolated({
        inputBatch: [
          { nums: mutableInput, hang: false },
          { nums: mutableInput, hang: false },
          { nums: mutableInput, hang: false },
        ],
      });
      const abortController = new AbortController();
      const abortedExecution = prepared.program.executeIsolated({
        inputs: { nums: mutableInput, hang: true },
        signal: abortController.signal,
      }).then(
        () => ({ resolved: true }),
        (error) => ({
          resolved: false,
          name: error instanceof Error ? error.name : '',
          message: error instanceof Error ? error.message : String(error),
        })
      );
      setTimeout(() => abortController.abort(), 25);
      const abortedPreparedCase = await abortedExecution;
      await prepared.program.dispose();
      await prepared.program.dispose();
      const executeAfterDispose = await prepared.program.executeIsolated({
        inputs: { nums: mutableInput, hang: false },
      }).then(
        () => '',
        (error) => error instanceof Error ? error.message : String(error)
      );

      const traceProvider = createCppPreparedExecutionProvider({
        createWorkerClient: () => new CppWorkerClient(workerOptions),
      });
      await traceProvider.init();
      const preparedTrace = await traceProvider.prepareProgram({
        mode: 'trace',
        code: [
          'class Solution {',
          'public:',
          '  int add(int a, int b) {',
          '    int sum = a + b;',
          '    return sum;',
          '  }',
          '};',
        ].join('\\n'),
        functionName: 'add',
        executionStyle: 'solution-method',
        traceOptions: { maxTraceSteps: 1000 },
      });
      if (preparedTrace.kind !== 'prepared' || preparedTrace.program.mode !== 'trace') {
        throw new Error('C++ trace preparation failed: ' + JSON.stringify(preparedTrace));
      }
      const preparedTraceCase = await preparedTrace.program.executeIsolated({
        inputs: { a: 2, b: 4 },
      });
      await preparedTrace.program.dispose();

      const preparedOpsProvider = createCppPreparedExecutionProvider({
        createWorkerClient: () => new CppWorkerClient(workerOptions),
      });
      await preparedOpsProvider.init();
      const preparedOps = await preparedOpsProvider.prepareProgram({
        mode: 'code',
        code: [
          'class Counter {',
          'public:',
          '  Counter(int seed) : value(seed) {}',
          '  void increment() { value += 1; }',
          '  int add(int delta) { value += delta; return value; }',
          '  int current() const { return value; }',
          'private:',
          '  int value;',
          '};',
        ].join('\\n'),
        functionName: 'Counter',
        executionStyle: 'ops-class',
      });
      if (preparedOps.kind !== 'prepared' || preparedOps.program.mode !== 'code') {
        throw new Error('C++ ops-class preparation failed: ' + JSON.stringify(preparedOps));
      }
      const preparedOpsFirstCase = await preparedOps.program.executeIsolated({
        inputs: {
          operations: ['Counter', 'increment', 'current'],
          arguments: [[10], [], []],
        },
      });
      const preparedOpsSecondCase = await preparedOps.program.executeIsolated({
        inputs: {
          ops: ['Counter', 'add', 'current'],
          args: [[2], [5], []],
        },
      });
      await preparedOps.program.dispose();

      const preparedOpsTraceProvider = createCppPreparedExecutionProvider({
        createWorkerClient: () => new CppWorkerClient(workerOptions),
      });
      await preparedOpsTraceProvider.init();
      const preparedOpsTrace = await preparedOpsTraceProvider.prepareProgram({
        mode: 'trace',
        code: [
          'class Counter {',
          'public:',
          '  Counter(int seed) : value(seed) {}',
          '  void increment() { value += 1; }',
          '  int current() const { return value; }',
          'private:',
          '  int value;',
          '};',
        ].join('\\n'),
        functionName: 'Counter',
        executionStyle: 'ops-class',
        traceOptions: { maxTraceSteps: 1000 },
      });
      if (preparedOpsTrace.kind !== 'prepared' || preparedOpsTrace.program.mode !== 'trace') {
        throw new Error('C++ ops-class trace preparation failed: ' + JSON.stringify(preparedOpsTrace));
      }
      const preparedOpsTraceCase = await preparedOpsTrace.program.executeIsolated({
        inputs: {
          operations: ['Counter', 'increment', 'current'],
          arguments: [[4], [], []],
        },
      });
      await preparedOpsTrace.program.dispose();

      const protocolClient = new CppWorkerClient(workerOptions);
      await protocolClient.init();
      const invalidPreparationError = await protocolClient.prepareRuntimeProgram({
        mode: 'invalid',
        code: 'int main() { return 0; }',
        functionName: '',
        executionStyle: 'function',
      }).then(
        () => '',
        (error) => error instanceof Error ? error.message : String(error)
      );
      const missingExecutionError = await protocolClient.executePreparedCode({
        programId: 'cpp-prepared-missing',
        mode: 'code',
        lifecycleGeneration: 0,
      }, {
        inputs: {},
      }).then(
        () => '',
        (error) => error instanceof Error ? error.message : String(error)
      );
      const missingDisposalError = await protocolClient.disposePreparedProgram({
        programId: 'cpp-prepared-missing',
        mode: 'code',
        lifecycleGeneration: 0,
      }).then(
        () => '',
        (error) => error instanceof Error ? error.message : String(error)
      );
      protocolClient.terminate();

      const projectFiles = [{
        path: 'main.cpp',
        contents: '#include <iostream>\\nint main() { std::cout << "permanent-project\\\\n"; return 0; }\\n',
      }];
      const projectCompile = await client.executeProjectCpp({
        source: 'compile',
        scriptPath: 'main.cpp',
        args: ['main.cpp', '-o', 'app'],
        cwd: '/workspace',
        env: {},
        project: { files: projectFiles },
      });
      const projectRun = await client.executeProjectCpp({
        source: 'run',
        scriptPath: './app',
        args: [],
        cwd: '/workspace',
        env: {},
        project: { files: [...projectFiles, ...(projectCompile.files || [])] },
      });
      const framesBeforeTerminate = document.querySelectorAll('iframe').length;
      client.terminate();
      return {
        cold,
        edited,
        exact,
        invalid,
        recovered,
        sharedCompiler: {
          warmMs: sharedWarmMs,
          first: sharedFirst,
          exact: sharedExact,
          framesBeforeCompilerRetirement:
            sharedFramesBeforeCompilerRetirement,
          framesAfterRunnerProviderRetirement:
            sharedFramesAfterRunnerProviderRetirement,
          framesAfterCompilerRetirement:
            sharedFramesAfterCompilerRetirement,
        },
        prepared: {
          preparationTimings: prepared.timings,
          capabilities: prepared.program.capabilities,
          firstPreparedCase,
          secondPreparedCase,
          preparedBatchCases,
          mutableInput,
          abortedPreparedCase,
          executeAfterDispose,
        },
        preparedTrace: {
          preparationTimings: preparedTrace.timings,
          result: preparedTraceCase,
        },
        preparedOps: {
          preparationTimings: preparedOps.timings,
          firstCase: preparedOpsFirstCase,
          secondCase: preparedOpsSecondCase,
        },
        preparedOpsTrace: {
          preparationTimings: preparedOpsTrace.timings,
          result: preparedOpsTraceCase,
        },
        protocolErrors: {
          invalidPreparationError,
          missingExecutionError,
          missingDisposalError,
        },
        projectCompile,
        projectRun,
        framesBeforeTerminate,
        framesAfterTerminate: document.querySelectorAll('iframe').length,
      };
    })()`) as {
      cold: { durationMs: number; success: boolean; output?: unknown; error?: string; timings?: Record<string, unknown> };
      edited: { durationMs: number; success: boolean; output?: unknown; error?: string; timings?: Record<string, unknown> };
      exact: { durationMs: number; success: boolean; output?: unknown; error?: string; timings?: Record<string, unknown> };
      invalid: { durationMs: number; success: boolean; output?: unknown; error?: string; timings?: Record<string, unknown> };
      recovered: { durationMs: number; success: boolean; output?: unknown; error?: string; timings?: Record<string, unknown> };
      sharedCompiler: {
        warmMs: number;
        first: {
          durationMs: number;
          timings?: Record<string, unknown>;
          result: { kind: string; output?: unknown };
          framesAfterRunnerDisposal: number;
        };
        exact: {
          durationMs: number;
          timings?: Record<string, unknown>;
          result: { kind: string; output?: unknown };
          framesAfterRunnerDisposal: number;
        };
        framesBeforeCompilerRetirement: number;
        framesAfterRunnerProviderRetirement: number;
        framesAfterCompilerRetirement: number;
      };
      prepared: {
        preparationTimings?: Record<string, unknown>;
        capabilities: { profile: string; caseIsolation: string; maxConcurrency: number };
        firstPreparedCase: { kind: string; output?: unknown; timings?: Record<string, unknown> };
        secondPreparedCase: { kind: string; output?: unknown; timings?: Record<string, unknown> };
        preparedBatchCases: Array<{ kind: string; output?: unknown; timings?: Record<string, unknown> }>;
        mutableInput: unknown[];
        abortedPreparedCase: { resolved: boolean; name?: string; message?: string };
        executeAfterDispose: string;
      };
      preparedTrace: {
        preparationTimings?: Record<string, unknown>;
        result: { kind: string; output?: unknown; trace?: { events?: unknown[] }; timings?: Record<string, unknown> };
      };
      preparedOps: {
        preparationTimings?: Record<string, unknown>;
        firstCase: { kind: string; output?: unknown; timings?: Record<string, unknown> };
        secondCase: { kind: string; output?: unknown; timings?: Record<string, unknown> };
      };
      preparedOpsTrace: {
        preparationTimings?: Record<string, unknown>;
        result: { kind: string; output?: unknown; trace?: { events?: unknown[] }; timings?: Record<string, unknown> };
      };
      protocolErrors: {
        invalidPreparationError: string;
        missingExecutionError: string;
        missingDisposalError: string;
      };
      projectCompile: { stdout: string; stderr: string; exitCode: number; files?: unknown[] };
      projectRun: { stdout: string; stderr: string; exitCode: number };
      framesBeforeTerminate: number;
      framesAfterTerminate: number;
    };

    assertCondition(result.cold.success && result.cold.output === 5, `cold C++ execution failed: ${JSON.stringify(result)}`);
    assertCondition(result.edited.success && result.edited.output === 6, `edited C++ execution failed: ${JSON.stringify(result)}`);
    assertCondition(result.exact.success && result.exact.output === 6, `exact C++ execution failed: ${JSON.stringify(result)}`);
    assertCondition(result.invalid.success === false, `invalid source should fail compilation: ${JSON.stringify(result)}`);
    assertCondition(
      result.recovered.success && result.recovered.output === 6,
      `compiler diagnostics must not poison the next fresh compiler instance: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.sharedCompiler.first.result.kind === 'completed' &&
        result.sharedCompiler.first.result.output === 12 &&
        result.sharedCompiler.exact.result.kind === 'completed' &&
        result.sharedCompiler.exact.result.output === 12,
      `shared compiler artifacts must execute in both disposable runners: ${JSON.stringify(result.sharedCompiler)}`
    );
    assertCondition(
      result.sharedCompiler.first.timings?.artifactCacheHit === false &&
        result.sharedCompiler.exact.timings?.artifactCacheHit === true &&
        result.sharedCompiler.exact.timings?.compileCacheHit === true,
      `the second disposable runner must reuse the provider-owned compiler artifact cache: ${JSON.stringify(result.sharedCompiler)}`
    );
    assertCondition(
      result.sharedCompiler.first.framesAfterRunnerDisposal === 2 &&
        result.sharedCompiler.exact.framesAfterRunnerDisposal === 2 &&
        result.sharedCompiler.framesBeforeCompilerRetirement === 2 &&
        result.sharedCompiler.framesAfterRunnerProviderRetirement === 2 &&
        result.sharedCompiler.framesAfterCompilerRetirement === 1,
      `runner retirement must leave the shared compiler frame alive until explicit compiler retirement: ${JSON.stringify(result.sharedCompiler)}`
    );
    assertCondition(
      result.prepared.capabilities.profile === 'fast' &&
        result.prepared.capabilities.caseIsolation === 'fresh-case-state' &&
        result.prepared.capabilities.maxConcurrency === 1,
      `prepared C++ capabilities must report truthful isolation and serialization: ${JSON.stringify(result.prepared)}`
    );
    assertCondition(
      result.prepared.firstPreparedCase.kind === 'completed' &&
        result.prepared.firstPreparedCase.output === 103 &&
        result.prepared.secondPreparedCase.kind === 'completed' &&
        result.prepared.secondPreparedCase.output === 103,
      `fresh C++ module memory must reset function statics between repeated cases: ${JSON.stringify(result.prepared)}`
    );
    assertCondition(
      result.prepared.preparedBatchCases.length === 3 &&
        result.prepared.preparedBatchCases.every(
          (item) =>
            item.kind === 'completed' &&
            item.output === 103 &&
            item.timings?.compileMs === 0 &&
            item.timings?.artifactCacheHit === true
        ),
      `batched C++ cases must reuse compilation while resetting module memory per case: ${JSON.stringify(result.prepared)}`
    );
    assertCondition(
      result.prepared.mutableInput.length === 2,
      `prepared C++ execution must not mutate caller-owned inputs: ${JSON.stringify(result.prepared.mutableInput)}`
    );
    assertCondition(
      result.prepared.firstPreparedCase.timings?.compileMs === 0 &&
        result.prepared.firstPreparedCase.timings?.wasmCompileMs === 0 &&
        typeof result.prepared.firstPreparedCase.timings?.runMs === 'number' &&
        typeof result.prepared.firstPreparedCase.timings?.totalMs === 'number' &&
        result.prepared.firstPreparedCase.timings?.artifactCacheHit === true &&
        result.prepared.secondPreparedCase.timings?.compileMs === 0 &&
        result.prepared.secondPreparedCase.timings?.artifactCacheHit === true,
      `prepared cases must reuse the immutable compiled artifact without recompiling: ${JSON.stringify(result.prepared)}`
    );
    assertCondition(
      typeof result.prepared.preparationTimings?.compileMs === 'number' &&
        (result.prepared.preparationTimings.compileMs as number) > 0 &&
        result.prepared.preparationTimings.artifactCacheHit === false,
      `preparation timings must report the one real compiler load separately from cached case runs: ${JSON.stringify(result.prepared.preparationTimings)}`
    );
    assertCondition(
      result.prepared.abortedPreparedCase.resolved === false &&
        result.prepared.abortedPreparedCase.name === 'AbortError',
      `caller cancellation must terminate the prepared worker and preserve AbortError: ${JSON.stringify(result.prepared.abortedPreparedCase)}`
    );
    assertCondition(
      result.prepared.executeAfterDispose.includes('already disposed'),
      `disposed prepared programs must fail deterministically: ${JSON.stringify(result.prepared)}`
    );
    assertCondition(
      result.preparedTrace.result.kind === 'completed' &&
        result.preparedTrace.result.output === 6 &&
        Array.isArray(result.preparedTrace.result.trace?.events) &&
        result.preparedTrace.result.trace.events.length > 0 &&
        result.preparedTrace.result.timings?.compileMs === 0 &&
        result.preparedTrace.result.timings?.artifactCacheHit === true,
      `prepared C++ tracing must execute from the cached module with an isolated trace: ${JSON.stringify(result.preparedTrace)}`
    );
    assertCondition(
      result.preparedOps.firstCase.kind === 'completed' &&
        JSON.stringify(result.preparedOps.firstCase.output) === JSON.stringify([null, null, 11]) &&
        result.preparedOps.secondCase.kind === 'completed' &&
        JSON.stringify(result.preparedOps.secondCase.output) === JSON.stringify([null, 7, 7]),
      `prepared C++ ops-class execution must support heterogeneous operation sequences: ${JSON.stringify(result.preparedOps)}`
    );
    assertCondition(
      result.preparedOps.preparationTimings?.artifactCacheHit === false &&
        typeof result.preparedOps.preparationTimings?.compileMs === 'number' &&
        result.preparedOps.preparationTimings.compileMs > 0,
      `prepared C++ ops-class preparation must compile once and reuse the artifact across cases: ${JSON.stringify(result.preparedOps.preparationTimings)}`
    );
    assertCondition(
      result.preparedOpsTrace.result.kind === 'completed' &&
        JSON.stringify(result.preparedOpsTrace.result.output) === JSON.stringify([null, null, 5]) &&
        Array.isArray(result.preparedOpsTrace.result.trace?.events) &&
        result.preparedOpsTrace.result.trace.events.length > 0,
      `prepared C++ ops-class tracing must preserve execution traces: ${JSON.stringify(result.preparedOpsTrace)}`
    );
    assertCondition(
      result.protocolErrors.invalidPreparationError ===
        'C++ prepared program mode must be "code" or "trace".' &&
        result.protocolErrors.missingExecutionError ===
          'C++ prepared program "cpp-prepared-missing" does not exist or was disposed.' &&
        result.protocolErrors.missingDisposalError ===
          'C++ prepared program "cpp-prepared-missing" does not exist or was disposed.',
      `prepared protocol failures must be deterministic: ${JSON.stringify(result.protocolErrors)}`
    );
    assertCondition(
      result.projectCompile.exitCode === 0 &&
        result.projectRun.exitCode === 0 &&
        result.projectRun.stdout === 'permanent-project\n',
      `C++ disposable project workers should retain protocol under permanent authority denial: ${JSON.stringify(result)}`
    );
    assertCondition(result.framesBeforeTerminate === 1, `one compiler frame should persist across commands: ${JSON.stringify(result)}`);
    assertCondition(result.framesAfterTerminate === 0, `terminate should remove the compiler frame: ${JSON.stringify(result)}`);
    assertCondition(
      result.exact.timings?.artifactCacheHit === true && result.exact.timings?.compileCacheHit === true,
      `exact source should hit the content-addressed artifact cache: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.edited.durationMs < result.cold.durationMs,
      `edited source should reuse warm compiler state: ${JSON.stringify(result)}`
    );
    console.log(JSON.stringify(result, null, 2));
    console.log('PASS: C++ browser compiler lifecycle keeps compile state warm and execution disposable');
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

test('cpp compiler lifecycle browser', main);

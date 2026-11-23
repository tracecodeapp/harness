#!/usr/bin/env npx tsx

/**
 * C++ ops-class `delete` operation aliasing, across every driver.
 *
 * `delete` is a C++ keyword, so a learner names the method `deleteKey`. The
 * single-case driver maps the operation to it; the prepared driver, which reads
 * operation names at run time, must too, untraced and traced with recording on
 * and off. The non-prepared batch driver is checked alongside as a regression
 * lock. The prepared driver does no macro-based aliasing: past a dead macro it
 * calls the real method, as the compiler does.
 *
 * Optional: set TRACECODE_ALGOFLOW_ROOT (default ~/Code/algoflow) to also run
 * the app's C++ reference solutions and sample tests for the stages that have a
 * `delete` operation. App data is only read, never copied into this repo.
 */

import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { loadEngineRuntimePackages } from '../scripts/runtime-package-assets.mjs';
import { runCommand, waitForHttp } from './example-app-smoke';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const UNRESOLVED_METHOD = 'C++ ops-class method could not be resolved.';
// Same default as the learner-failure matrix: the headless shell crashes on
// C++ WebAssembly traps on Linux, so use full Chromium there.
const BROWSER_CHANNEL = process.env.TRACECODE_MATRIX_BROWSER_CHANNEL ||
  (process.platform === 'linux' ? 'chromium' : undefined);
const ALGOFLOW_ROOT = process.env.TRACECODE_ALGOFLOW_ROOT || join(homedir(), 'Code', 'algoflow');

interface OpsCase {
  operations: string[];
  arguments: unknown[][];
}

interface Scenario {
  name: string;
  className: string;
  code: string;
  cases: OpsCase[];
  /** Expected per case; null means "must fail with the unresolved-method error". */
  expected: Array<unknown[] | null>;
  /**
   * Check only the prepared paths. The single-case drivers resolve macros by
   * text (a known limit: they do not see #undef or #if); their output is
   * logged, not asserted.
   */
  preparedOnly?: boolean;
}

const KV_SOURCE = [
  '#include <optional>',
  '#include <string>',
  '#include <unordered_map>',
  '',
  'class KeyValueStore {',
  '    std::unordered_map<std::string, int> store;',
  '',
  'public:',
  '    KeyValueStore() = default;',
  '',
  '    void set(std::string key, int value) {',
  '        store[key] = value;',
  '    }',
  '',
  '    std::optional<int> get(std::string key) {',
  '        auto found = store.find(key);',
  '        if (found == store.end()) return std::nullopt;',
  '        return found->second;',
  '    }',
  '',
  '    bool deleteKey(std::string key) {',
  '        return store.erase(key) > 0;',
  '    }',
  '};',
].join('\n');

// A dead macro whose name is also a public method. The compiler calls the
// real get(), so the prepared driver must too.
const DEAD_MACRO_SOURCE = [
  '#define get getValue',
  '#undef get',
  '',
  'class Store {',
  'public:',
  '    int get() { return 1; }',
  '    int getValue() { return 2; }',
  '};',
].join('\n');

const KV_CASES: OpsCase[] = [
  {
    operations: ['KeyValueStore', 'set', 'get', 'delete', 'get', 'delete'],
    arguments: [[], ['a', 1], ['a'], ['a'], ['a'], ['a']],
  },
  {
    operations: ['KeyValueStore', 'set', 'get', 'delete', 'get', 'delete'],
    arguments: [[], ['b', 7], ['b'], ['c'], ['b'], ['b']],
  },
];

const INLINE_SCENARIOS: Scenario[] = [
  {
    name: 'deleteKey alias',
    className: 'KeyValueStore',
    code: KV_SOURCE,
    cases: KV_CASES,
    expected: [
      [null, null, 1, true, null, false],
      [null, null, 7, false, 7, true],
    ],
  },
  {
    name: 'dead macro keeps the real method',
    className: 'Store',
    code: DEAD_MACRO_SOURCE,
    cases: [
      {
        operations: ['Store', 'get', 'getValue'],
        arguments: [[], [], []],
      },
    ],
    expected: [[null, 1, 2]],
    preparedOnly: true,
  },
  {
    name: 'unknown operation still unresolved',
    className: 'KeyValueStore',
    code: KV_SOURCE,
    cases: [
      {
        operations: ['KeyValueStore', 'set', 'remove'],
        arguments: [[], ['a', 1], ['a']],
      },
    ],
    expected: [null],
  },
];

async function referenceScenarios(): Promise<Scenario[]> {
  const stages: Array<[problem: string, stageIndex: number]> = [
    ['in-memory-kv-store', 0],
    ['in-memory-kv-store', 1],
    ['lru-cache-system', 1],
  ];
  const scenarios: Scenario[] = [];
  for (const [problem, stageIndex] of stages) {
    const problemPath = join(ALGOFLOW_ROOT, 'data', 'interviews', `${problem}.json`);
    const solutionPath = join(
      ALGOFLOW_ROOT, 'data', 'reference-solutions', 'cpp', 'interviews', problem, `stage-${stageIndex + 1}.cpp`
    );
    if (!existsSync(problemPath) || !existsSync(solutionPath)) {
      console.log(`SKIP: app reference ${problem} stage ${stageIndex + 1} not found under ${ALGOFLOW_ROOT}`);
      continue;
    }
    const problemData = JSON.parse(await readFile(problemPath, 'utf8')) as {
      functionName: string;
      stages: Array<{ sampleTests: Array<{ input: OpsCase; expected: unknown[] }> }>;
    };
    const tests = problemData.stages[stageIndex].sampleTests;
    scenarios.push({
      name: `reference ${problem} stage ${stageIndex + 1}`,
      className: problemData.functionName,
      code: await readFile(solutionPath, 'utf8'),
      cases: tests.map((sample) => sample.input),
      expected: tests.map((sample) => sample.expected),
    });
  }
  return scenarios;
}

const REQUIRED_TRACECC_ASSETS = [
  'tracecc-reactor.wasm',
  'llvm-resources.tar',
  'tracecode_runtime.hpp',
  'narrow.pch',
  'narrow.source.hpp',
  'narrow.o',
  'broad.pch',
  'broad.source.hpp',
  'broad.o',
  'map.pch',
  'map.source.hpp',
  'map.o',
] as const;

// The TraceCC compiler assets, as tests/test-tracecc-browser-runtime.ts loads them.
async function resolveTraceCCAssets(root: string): Promise<{
  sourceRoot: string;
  files: readonly { path: string; size: number; sha256: string }[];
}> {
  if (process.env.TRACECC_RUNTIME_ASSET_DIR) {
    const sourceRoot = resolve(process.env.TRACECC_RUNTIME_ASSET_DIR);
    return {
      sourceRoot,
      files: await Promise.all(REQUIRED_TRACECC_ASSETS.map(async (path) => {
        const bytes = await readFile(join(sourceRoot, path));
        return { path, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
      })),
    };
  }
  const { tracecc } = await loadEngineRuntimePackages(root);
  return {
    sourceRoot: tracecc.sourceRoot,
    files: tracecc.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  };
}

interface RunSummary {
  ok: boolean;
  output?: unknown;
  events?: number;
  raw: string;
}

type PathResults = Record<string, RunSummary[]>;

async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-cpp-delete-alias-browser-'));
  const workersRoot = join(tempRoot, 'workers');
  const port = 5600 + Math.floor(Math.random() * 200);
  const origin = `http://127.0.0.1:${port}`;
  const scenarios = [...INLINE_SCENARIOS, ...(await referenceScenarios())];
  const traceccAssets = await resolveTraceCCAssets(root);
  const compilerIntegrity = {
    assets: traceccAssets.files.map((file) => ({
      url: `${origin}/tracecc/${file.path}`,
      size: file.size,
      sha256: file.sha256,
    })),
  };

  await runCommand('pnpm', ['exec', 'tsx', 'src/cli.ts', 'sync-assets', workersRoot, '--languages', 'cpp'], root);
  await symlink(traceccAssets.sourceRoot, join(tempRoot, 'tracecc'), 'dir');
  for (const entry of ['cpp-worker-client', 'cpp-prepared-provider', 'tracecc-compiler-service']) {
    await build({
      entryPoints: [join(root, 'packages', 'runtime-cpp', 'src', `${entry}.ts`)],
      outfile: join(tempRoot, `${entry}.js`),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      tsconfig: join(root, 'tsconfig.base.json'),
      alias: {
        zlib: join(root, 'packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': join(root, 'packages/tracekernel/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
  }
  await writeFile(join(tempRoot, 'index.html'), '<!doctype html><title>C++ delete alias</title>', 'utf8');

  const server = spawn('python3', ['-c', [
    'from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler',
    'import os',
    'class Handler(SimpleHTTPRequestHandler):',
    '    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".hpp": "text/plain"}',
    '    def end_headers(self):',
    '        self.send_header("Cross-Origin-Opener-Policy", "same-origin")',
    '        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")',
    '        self.send_header("Cache-Control", "no-cache")',
    '        super().end_headers()',
    `os.chdir(${JSON.stringify(tempRoot)})`,
    `ThreadingHTTPServer(("127.0.0.1", ${port}), Handler).serve_forever()`,
  ].join('\n')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

  const browser = await chromium.launch({ headless: true, ...(BROWSER_CHANNEL ? { channel: BROWSER_CHANNEL } : {}) });
  try {
    await waitForHttp(origin, 30_000);
    const page = await browser.newPage();
    page.setDefaultTimeout(600_000);
    await page.goto(origin);
    await page.evaluate('globalThis.__name = (fn) => fn');
    const results = await page.evaluate(`(async () => {
      const { CppWorkerClient } = await import('/cpp-worker-client.js');
      const { createCppPreparedExecutionProvider } = await import('/cpp-prepared-provider.js');
      const { TraceCCCompilerService } = await import('/tracecc-compiler-service.js');
      const shard = (name) => ({
        pchUrl: '/tracecc/' + name + '.pch',
        pchSourceUrl: '/tracecc/' + name + '.source.hpp',
        runtimeObjectUrl: '/tracecc/' + name + '.o',
      });
      const compiler = new TraceCCCompilerService({
        workerUrl: '/workers/cpp-worker.js',
        compilerUrl: '/tracecc/tracecc-reactor.wasm',
        resourcesUrl: '/tracecc/llvm-resources.tar',
        runtimeHeaderUrl: '/tracecc/tracecode_runtime.hpp',
        compilerIntegrity: ${JSON.stringify(compilerIntegrity)},
        maxCompilesPerWorker: 8,
        shards: { narrow: shard('narrow'), broad: shard('broad'), map: shard('map') },
      });
      const workerOptions = {
        workerUrl: '/workers/cpp-worker.js',
        compilerWasmUrl: '/tracecc/tracecc-reactor.wasm',
        linkerWasmUrl: '/tracecc/tracecc-reactor.wasm',
        sysrootUrl: '/tracecc/llvm-resources.tar',
        runtimeHeaderUrl: '/tracecc/tracecode_runtime.hpp',
        trustedCompilerService: compiler,
        executionTimeoutMs: 60000,
        tracingTimeoutMs: 60000,
      };
      const scenarios = ${JSON.stringify(scenarios)};
      const traceOptions = { maxTraceSteps: 2000 };
      const summarize = (result) => {
        let raw;
        try { raw = JSON.stringify(result); } catch (error) { raw = String(error); }
        const ok = result && (result.kind !== undefined ? result.kind === 'completed' : result.success === true);
        const events = result && result.trace && Array.isArray(result.trace.events) ? result.trace.events.length : undefined;
        return { ok: Boolean(ok), output: result ? result.output : undefined, events, raw: String(raw).slice(0, 2000) };
      };
      const failure = (error) => ({ ok: false, raw: 'threw: ' + (error && error.message ? error.message : String(error)) });
      const client = new CppWorkerClient(workerOptions);
      const out = {};
      for (const scenario of scenarios) {
        const paths = {};
        const base = { code: scenario.code, functionName: scenario.className, executionStyle: 'ops-class' };

        paths.singleCase = [];
        paths.singleCaseTraced = [];
        for (const inputs of scenario.cases) {
          try { paths.singleCase.push(summarize(await client.executeCode({ ...base, inputs }))); }
          catch (error) { paths.singleCase.push(failure(error)); }
          try { paths.singleCaseTraced.push(summarize(await client.executeWithTracing({ ...base, inputs, traceOptions }))); }
          catch (error) { paths.singleCaseTraced.push(failure(error)); }
        }
        try {
          const batch = await client.executeCodeBatch({ ...base, inputBatch: scenario.cases });
          paths.batch = scenario.cases.map((_inputs, index) => summarize(batch.results[index]));
        } catch (error) {
          paths.batch = scenario.cases.map(() => failure(error));
        }

        const codeProvider = createCppPreparedExecutionProvider({ createWorkerClient: () => new CppWorkerClient(workerOptions) });
        await codeProvider.init();
        const prepared = await codeProvider.prepareProgram({ mode: 'code', ...base });
        if (prepared.kind !== 'prepared') {
          paths.prepared = scenario.cases.map(() => failure(new Error('prepare failed: ' + JSON.stringify(prepared))));
          paths.preparedBatch = paths.prepared;
        } else {
          paths.prepared = [];
          for (const inputs of scenario.cases) {
            try { paths.prepared.push(summarize(await prepared.program.executeIsolated({ inputs }))); }
            catch (error) { paths.prepared.push(failure(error)); }
          }
          try {
            const batch = await prepared.program.executeBatchIsolated({ inputBatch: scenario.cases });
            paths.preparedBatch = batch.map(summarize);
          } catch (error) {
            paths.preparedBatch = scenario.cases.map(() => failure(error));
          }
          await prepared.program.dispose();
        }

        const traceProvider = createCppPreparedExecutionProvider({ createWorkerClient: () => new CppWorkerClient(workerOptions) });
        await traceProvider.init();
        const preparedTrace = await traceProvider.prepareProgram({ mode: 'trace', ...base, traceOptions });
        if (preparedTrace.kind !== 'prepared') {
          const failed = scenario.cases.map(() => failure(new Error('trace prepare failed: ' + JSON.stringify(preparedTrace))));
          paths.preparedTraceRecording = failed;
          paths.preparedTraceNotRecording = failed;
          paths.preparedTraceBatchMixed = failed;
        } else {
          paths.preparedTraceRecording = [];
          paths.preparedTraceNotRecording = [];
          for (const inputs of scenario.cases) {
            try { paths.preparedTraceRecording.push(summarize(await preparedTrace.program.executeIsolated({ inputs, recordTrace: true }))); }
            catch (error) { paths.preparedTraceRecording.push(failure(error)); }
            try { paths.preparedTraceNotRecording.push(summarize(await preparedTrace.program.executeIsolated({ inputs, recordTrace: false }))); }
            catch (error) { paths.preparedTraceNotRecording.push(failure(error)); }
          }
          try {
            const batch = await preparedTrace.program.executeBatchIsolated({
              inputBatch: scenario.cases,
              traceEnabledBatch: scenario.cases.map((_inputs, index) => index % 2 === 0),
            });
            paths.preparedTraceBatchMixed = batch.map(summarize);
          } catch (error) {
            paths.preparedTraceBatchMixed = scenario.cases.map(() => failure(error));
          }
          await preparedTrace.program.dispose();
        }
        out[scenario.name] = paths;
        codeProvider.terminate();
        traceProvider.terminate();
      }
      client.terminate();
      compiler.terminate();
      return out;
    })()`) as Record<string, PathResults>;

    const failures: string[] = [];
    for (const scenario of scenarios) {
      const paths = results[scenario.name];
      for (const [pathName, runs] of Object.entries(paths)) {
        if (scenario.preparedOnly && !pathName.startsWith('prepared')) {
          console.log(`known limit (not asserted): ${scenario.name} / ${pathName}: ${runs.map((run) => JSON.stringify(run.ok ? run.output : 'failed')).join(', ')}`);
          continue;
        }
        scenario.expected.forEach((expected, index) => {
          const run = runs[index];
          const label = `${scenario.name} / ${pathName} / case ${index + 1}`;
          if (expected === null) {
            // Only the prepared driver dispatches at run time; the single-case
            // and batch drivers reject an unknown method while generating.
            const requiresMessage = pathName.startsWith('prepared');
            if (run.ok || (requiresMessage && !run.raw.includes(UNRESOLVED_METHOD))) {
              failures.push(`${label}: expected a failure${requiresMessage ? ` with "${UNRESOLVED_METHOD}"` : ''}, got ${run.raw}`);
            }
            return;
          }
          if (!run.ok || JSON.stringify(run.output) !== JSON.stringify(expected)) {
            failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${run.raw}`);
          }
        });
      }
      // Recording on must record; recording off must not.
      for (const [index, expected] of scenario.expected.entries()) {
        if (expected === null) continue;
        const recorded = paths.preparedTraceRecording[index];
        const silent = paths.preparedTraceNotRecording[index];
        if (recorded.ok && !(typeof recorded.events === 'number' && recorded.events > 0)) {
          failures.push(`${scenario.name} / preparedTraceRecording / case ${index + 1}: no trace events recorded`);
        }
        if (silent.ok && typeof silent.events === 'number' && silent.events > 0) {
          failures.push(`${scenario.name} / preparedTraceNotRecording / case ${index + 1}: recorded ${silent.events} events`);
        }
      }
      const checkedPaths = Object.keys(paths).filter((pathName) => !scenario.preparedOnly || pathName.startsWith('prepared'));
      console.log(`${scenario.name}: ${checkedPaths.length} paths x ${scenario.cases.length} cases checked`);
    }
    assertCondition(failures.length === 0, `C++ ops-class delete aliasing diverged:\n${failures.join('\n')}`);
    console.log(`PASS: C++ ops-class delete resolves to deleteKey on every driver (${scenarios.length} scenarios)`);
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('cpp ops-class delete resolves to deleteKey on every driver', main);

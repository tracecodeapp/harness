#!/usr/bin/env npx tsx

/**
 * C++ judged-output policy through the receipt-backed ordinary provider.
 *
 * The composition passes `judgedOutputPolicy` on the ordinary prepare call. A
 * judged answer over a limit is a typed `serialization-limit` with no value:
 * bytes are the UTF-8 length of the answer's JSON (after a learner `toJson`),
 * and items, nodes and depth are counted on the parsed answer. The gate's
 * 1,024-byte control is the first scenario. Answers the WebAssembly program
 * cannot even build (a 100,000-deep tree, a 64 MiB string) are recorded: they
 * must be the learner's failure or a typed limit, never a provider failure.
 */

import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import {
  resolveJudgedOutputPolicy,
  type JudgedOutputPolicy,
} from '../packages/runtime-contracts/src/judged-output-policy';
import { loadEngineRuntimePackages } from '../scripts/runtime-package-assets.mjs';
import { runCommand, waitForHttp } from './example-app-smoke';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const BROWSER_CHANNEL = process.env.TRACECODE_MATRIX_BROWSER_CHANNEL ||
  (process.platform === 'linux' ? 'chromium' : undefined);

interface Scenario {
  name: string;
  code: string;
  functionName: string;
  executionStyle: 'solution-method' | 'ops-class';
  policy: Partial<JudgedOutputPolicy> | null;
  cases: Array<{
    inputs: Record<string, unknown>;
    expect: 'completed' | 'limit' | 'not-provider';
    outputSize?: number;
    limit?: 'byte' | 'item' | 'node' | 'depth';
    warm?: true;
  }>;
}

const REPEAT = `#include <string>
class Solution {
public:
  std::string solve(int n, std::string unit) {
    std::string out;
    for (int i = 0; i < n; ++i) out += unit;
    return out;
  }
};`;

const VECTOR = `#include <vector>
class Solution {
public:
  std::vector<int> solve(int n) { return std::vector<int>(n, 1); }
};`;

const GRID = `#include <vector>
class Solution {
public:
  std::vector<std::vector<int>> solve(int rows, int cols) {
    return std::vector<std::vector<int>>(rows, std::vector<int>(cols, 1));
  }
};`;

const UNORDERED_SET = `#include <unordered_set>
class Solution {
public:
  std::unordered_set<int> solve(int count) {
    std::unordered_set<int> out;
    for (int n = 1; n <= count; ++n) out.insert(n);
    return out;
  }
};`;

const MAP_OF_SETS = `#include <map>
#include <set>
#include <string>
#include <vector>
class Solution {
public:
  std::map<std::string, std::set<std::vector<int>>> solve(bool nested) {
    std::map<std::string, std::set<std::vector<int>>> out;
    auto& values = out["x"];
    if (nested) values.insert(std::vector<int>{1});
    return out;
  }
};`;

const CUSTOM_JSON = `#include <string>
struct Blob { int n; };
std::string toJson(const Blob& blob) { return "\\"" + std::string(blob.n, 'y') + "\\""; }
class Solution {
public:
  Blob solve(int n) { return Blob{ n }; }
};`;

const DEEP_TREE = `class Solution {
public:
  TreeNode* solve(int depth) {
    TreeNode* root = nullptr;
    for (int i = 0; i < depth; ++i) {
      TreeNode* node = new TreeNode(i);
      node->left = root;
      root = node;
    }
    return root;
  }
};`;

const SEAM = { maxBytes: 1024 };

const SCENARIOS: Scenario[] = [
  {
    // The GATES-DESIGN G6 "over ceiling" control: 64 bytes pass, 2,048 refuse.
    name: '1,024-byte seam, ASCII string',
    code: REPEAT, functionName: 'solve', executionStyle: 'solution-method', policy: SEAM,
    cases: [
      { inputs: { n: 64, unit: 'x' }, expect: 'completed', outputSize: 64 },
      { inputs: { n: 2048, unit: 'x' }, expect: 'limit', limit: 'byte' },
      { inputs: { n: 64, unit: 'x' }, expect: 'completed', outputSize: 64, warm: true },
      // 1,022 characters plus two quotes is exactly 1,024 bytes.
      { inputs: { n: 1022, unit: 'x' }, expect: 'completed', outputSize: 1022 },
      { inputs: { n: 1023, unit: 'x' }, expect: 'limit', limit: 'byte' },
    ],
  },
  {
    // 400 two-byte characters are 402 UTF-16 units but 802 bytes; 600 are
    // 602 units, under 1,024, but 1,202 bytes, over it. Four-byte characters
    // are surrogate pairs: 300 of them are 602 units and 1,202 bytes.
    name: '1,024-byte seam counts UTF-8, not UTF-16',
    code: REPEAT, functionName: 'solve', executionStyle: 'solution-method', policy: SEAM,
    cases: [
      { inputs: { n: 400, unit: 'é' }, expect: 'completed' },
      { inputs: { n: 600, unit: 'é' }, expect: 'limit' },
      { inputs: { n: 300, unit: '\u{1F600}' }, expect: 'limit' },
    ],
  },
  {
    name: 'learner toJson output is capped too',
    code: CUSTOM_JSON, functionName: 'solve', executionStyle: 'solution-method', policy: SEAM,
    cases: [
      { inputs: { n: 10 }, expect: 'completed' },
      { inputs: { n: 5000 }, expect: 'limit' },
    ],
  },
  {
    name: 'item limit',
    code: VECTOR, functionName: 'solve', executionStyle: 'solution-method', policy: { maxItems: 100 },
    cases: [
      { inputs: { n: 100 }, expect: 'completed' },
      { inputs: { n: 101 }, expect: 'limit', limit: 'item' },
    ],
  },
  {
    name: 'item limit applies to each container',
    code: GRID, functionName: 'solve', executionStyle: 'solution-method', policy: { maxItems: 2 },
    cases: [
      { inputs: { rows: 2, cols: 2 }, expect: 'completed', outputSize: 13 },
      { inputs: { rows: 2, cols: 3 }, expect: 'limit', limit: 'item' },
    ],
  },
  {
    name: 'node limit counts the root, containers and scalars',
    code: GRID, functionName: 'solve', executionStyle: 'solution-method', policy: { maxNodes: 7 },
    cases: [
      { inputs: { rows: 2, cols: 2 }, expect: 'completed', outputSize: 13 },
      { inputs: { rows: 1, cols: 6 }, expect: 'limit', limit: 'node' },
    ],
  },
  {
    name: 'depth limit counts container nesting',
    code: GRID, functionName: 'solve', executionStyle: 'solution-method', policy: { maxDepth: 1 },
    cases: [
      { inputs: { rows: 0, cols: 0 }, expect: 'completed', outputSize: 2 },
      { inputs: { rows: 1, cols: 0 }, expect: 'limit', limit: 'depth' },
    ],
  },
  {
    name: 'set wrapper only counts towards JSON items and nodes',
    code: UNORDERED_SET, functionName: 'solve', executionStyle: 'solution-method',
    policy: { maxDepth: 1, maxItems: 2, maxNodes: 4 },
    cases: [
      { inputs: { count: 1 }, expect: 'completed', outputSize: JSON.stringify({ __type__: 'set', values: [1] }).length },
      { inputs: { count: 2 }, expect: 'limit', limit: 'node' },
      { inputs: { count: 3 }, expect: 'limit', limit: 'item' },
    ],
  },
  {
    name: 'map, set and nested vector each add one level',
    code: MAP_OF_SETS, functionName: 'solve', executionStyle: 'solution-method', policy: { maxDepth: 2 },
    cases: [
      { inputs: { nested: false }, expect: 'completed', outputSize: JSON.stringify({ x: { __type__: 'set', values: [] } }).length },
      { inputs: { nested: true }, expect: 'limit', limit: 'depth' },
    ],
  },
  {
    name: 'no policy leaves answers uncapped',
    code: REPEAT, functionName: 'solve', executionStyle: 'solution-method', policy: null,
    cases: [{ inputs: { n: 4096, unit: 'x' }, expect: 'completed' }],
  },
  {
    name: 'answers the program cannot build',
    code: DEEP_TREE, functionName: 'solve', executionStyle: 'solution-method', policy: SEAM,
    cases: [{ inputs: { depth: 100000 }, expect: 'not-provider' }],
  },
  {
    name: '64 MiB string under the seam',
    code: REPEAT, functionName: 'solve', executionStyle: 'solution-method', policy: SEAM,
    cases: [{ inputs: { n: 64 * 1024 * 1024, unit: 'x' }, expect: 'not-provider' }],
  },
];

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

async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-cpp-judged-output-browser-'));
  const workersRoot = join(tempRoot, 'workers');
  const port = 5600 + Math.floor(Math.random() * 200);
  const origin = `http://127.0.0.1:${port}`;
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
  await writeFile(join(tempRoot, 'index.html'), '<!doctype html><title>C++ judged output limit</title>', 'utf8');

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
  ].join('\n')], { cwd: root, stdio: 'ignore' });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, ...(BROWSER_CHANNEL ? { channel: BROWSER_CHANNEL } : {}) });
    await waitForHttp(origin, 30_000);
    const page = await browser.newPage();
    page.setDefaultTimeout(600_000);
    await page.goto(origin);
    await page.evaluate('globalThis.__name = (fn) => fn');
    const results = await page.evaluate(`(async () => {
      const { CppWorkerClient } = await import('/cpp-worker-client.js');
      const { createCppOrdinaryExecutionProvider } = await import('/cpp-prepared-provider.js');
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
      const scenarios = ${JSON.stringify(SCENARIOS.map((scenario) => ({
        ...scenario,
        policy: scenario.policy && resolveJudgedOutputPolicy('cpp', scenario.policy)?.policy,
      })))};
      const out = {};
      for (const scenario of scenarios) {
        let preparations = 0;
        class RecordingClient extends CppWorkerClient {
          prepareRuntimeProgram(call) {
            preparations += 1;
            return super.prepareRuntimeProgram(call);
          }
        }
        const provider = createCppOrdinaryExecutionProvider({ createWorkerClient: () => new RecordingClient(workerOptions) });
        await provider.init();
        const base = { code: scenario.code, functionName: scenario.functionName, executionStyle: scenario.executionStyle };
        const runs = [];
        try {
          const prepared = await provider.prepareProgram({
            mode: 'code', ...base, ...(scenario.policy ? { judgedOutputPolicy: scenario.policy } : {}),
          });
          if (prepared.kind !== 'prepared') {
            for (const _ of scenario.cases) runs.push({ threw: 'prepare: ' + JSON.stringify(prepared).slice(0, 400) });
          } else {
            for (const item of scenario.cases) {
              try {
                const result = await prepared.program.executeIsolated({ inputs: item.inputs, limits: { wallClockMs: 60000 } });
                const size = typeof result.output === 'string' ? result.output.length : JSON.stringify(result.output ?? null).length;
                runs.push({ kind: result.kind, reason: result.reason, hasOutput: 'output' in result, outputSize: size, error: String(result.error ?? '').slice(0, 300), stage: result.diagnosticStage, preparations });
              } catch (error) {
                runs.push({ threw: String(error && error.message || error).slice(0, 400), name: error && error.name });
              }
            }
            await prepared.program.dispose();
          }
        } finally {
          provider.terminate();
        }
        out[scenario.name] = runs;
      }
      compiler.terminate();
      return out;
    })()`) as Record<string, Array<Record<string, unknown>>>;

    const failures: string[] = [];
    for (const scenario of SCENARIOS) {
      const runs = results[scenario.name];
      scenario.cases.forEach((item, index) => {
        const run = runs[index];
        const label = `${scenario.name} / case ${index + 1}`;
        console.log(`${label}: ${JSON.stringify(run)}`);
        if (item.expect === 'completed' && run.kind !== 'completed') failures.push(`${label}: expected completed, got ${JSON.stringify(run)}`);
        if (item.outputSize !== undefined && run.outputSize !== item.outputSize) {
          failures.push(`${label}: expected output size ${item.outputSize}, got ${JSON.stringify(run)}`);
        }
        if (item.warm && run.preparations !== 1) failures.push(`${label}: expected the original warm module`);
        if (item.expect === 'limit' && !(run.kind === 'limit' && run.reason === 'serialization-limit' && !run.hasOutput)) {
          failures.push(`${label}: expected a serialization-limit with no value, got ${JSON.stringify(run)}`);
        } else if (item.limit && !String(run.error).includes(`judged-output ${item.limit} limit`)) {
          failures.push(`${label}: expected the ${item.limit} limit, got ${JSON.stringify(run)}`);
        }
        if (item.expect === 'not-provider' && (run.threw !== undefined || !['completed', 'limit', 'failed'].includes(String(run.kind)))) {
          failures.push(`${label}: expected the learner's outcome or a typed limit, got ${JSON.stringify(run)}`);
        }
      });
    }
    assertCondition(failures.length === 0, `C++ judged-output limit diverged:\n${failures.join('\n')}`);
    console.log(`PASS: C++ judged output honours the policy (${SCENARIOS.length} scenarios)`);
  } finally {
    server.kill('SIGTERM');
    try {
      await browser?.close();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

test('cpp judged output honours the judged-output policy', main);

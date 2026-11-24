#!/usr/bin/env npx tsx

/**
 * C++ learner value types as call arguments, across every driver.
 *
 * A learner type such as `struct Value { Value(int); Value(const std::string&); }`
 * receives JSON scalars through its one-argument constructors and JSON objects
 * field by field. Every driver must decode it the same way: the single-case
 * drivers (literals), the batch driver and the prepared driver (the generated
 * JsonObjectAdapter), untraced and traced. A value the type cannot be built
 * from fails with a message naming the type; it is never a default-constructed
 * value. The GA G6 fixtures `cpp-value-default` and `cpp-value-no-default` are
 * the first two scenarios.
 */

import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { loadEngineRuntimePackages } from '../scripts/runtime-package-assets.mjs';
import { runCommand, waitForHttp } from './example-app-smoke';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Same default as the learner-failure matrix: the headless shell crashes on
// C++ WebAssembly traps on Linux, so use full Chromium there.
const BROWSER_CHANNEL = process.env.TRACECODE_MATRIX_BROWSER_CHANNEL ||
  (process.platform === 'linux' ? 'chromium' : undefined);

interface Scenario {
  name: string;
  functionName: string;
  executionStyle: 'solution-method' | 'ops-class';
  code: string;
  cases: Record<string, unknown>[];
  /** Expected output per case, or `{ error }`: the run must fail and its report include the text. */
  expected: Array<unknown | { error: string }>;
  /**
   * Paths not asserted, with the reason. The GA fixtures index a traced
   * `vector<vector<Value>>` element's member, which the runtime's traced nested
   * vector reference does not forward (a header limit, unchanged here).
   */
  untracedOnly?: string;
}

const VALUE_TYPE = (withDefault: boolean) => `struct Value {
  int number;
  std::string text;
  ${withDefault ? 'Value() : number(0) {}' : ''}
  Value(int n) : number(n) {}
  Value(const std::string& s) : number(0), text(s) {}
};`;

const GA_FIXTURE = (withDefault: boolean) => `#include <string>
#include <vector>
${VALUE_TYPE(withDefault)}
class Solution {
public:
  int solve(std::vector<std::vector<Value>> operations) {
    return operations[0][0].text == "add" ? operations[0][1].number : -1;
  }
};`;

const FLAT_FIXTURE = (withDefault: boolean) => `#include <string>
#include <vector>
${VALUE_TYPE(withDefault)}
class Solution {
public:
  int solve(std::vector<Value> args, Value scale) {
    return args[0].text == "add" ? args[1].number * scale.number : -1;
  }
};`;

const OPS_FIXTURE = (withDefault: boolean) => `#include <string>
#include <vector>
${VALUE_TYPE(withDefault)}
class Ledger {
  int total = 0;

public:
  Ledger() = default;

  int add(Value amount) {
    total += amount.number;
    return total;
  }

  std::string label(Value name) {
    return name.text;
  }
};`;

const OPS_CASES = [
  { operations: ['Ledger', 'add', 'label', 'add'], arguments: [[], [7], ['rent'], [4]] },
  { operations: ['Ledger', 'add', 'label', 'add'], arguments: [[], [1], ['food'], [2]] },
];

const method = (name: string, types: string, signature: string, body: string) => `#include <string>
#include <string_view>
#include <vector>
${types}
class Solution {
public:
  ${signature} {
    ${body}
  }
};`;

const KINDS = 'std::string out; for (auto& value : values) out += value.kind + ","; return out;';

const SCENARIOS: Scenario[] = [
  ...[false, true].map((withDefault): Scenario => ({
    name: `GA cpp-value-${withDefault ? 'default' : 'no-default'}`,
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: GA_FIXTURE(withDefault),
    cases: [{ operations: [['add', 7]] }, { operations: [['add', 11]] }],
    expected: [7, 11],
    untracedOnly: 'traced vector<vector<Value>> element member access (runtime header limit)',
  })),
  ...[false, true].map((withDefault): Scenario => ({
    name: `flat value arguments, ${withDefault ? 'default-constructible' : 'no default constructor'}`,
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: FLAT_FIXTURE(withDefault),
    cases: [{ args: ['add', 7], scale: 2 }, { args: ['sub', 7], scale: 3 }],
    expected: [14, -1],
  })),
  ...[false, true].map((withDefault): Scenario => ({
    name: `ops-class value arguments, ${withDefault ? 'default-constructible' : 'no default constructor'}`,
    functionName: 'Ledger',
    executionStyle: 'ops-class',
    code: OPS_FIXTURE(withDefault),
    cases: OPS_CASES,
    expected: [[null, 7, 'rent', 11], [null, 1, 'food', 3]],
  })),
  {
    // An integer picks int over double and long long; past int's range it
    // picks long long; a fraction picks double: as the literal would.
    name: 'integer, floating and wide overloads',
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: method('overloads',
      'struct Kind { std::string kind; Kind(int) : kind("int") {} Kind(double) : kind("double") {} Kind(long long) : kind("long long") {} };',
      'std::string solve(std::vector<Kind> values)', KINDS),
    cases: [{ values: [7, 2.5, 3000000000, -4] }],
    expected: ['int,double,long long,int,'],
  },
  {
    name: 'bool and int overloads, explicit',
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: method('bool',
      'struct Kind { std::string kind; explicit Kind(bool) : kind("bool") {} explicit Kind(int) : kind("int") {} };',
      'std::string solve(std::vector<Kind> values)', KINDS),
    cases: [{ values: [true, 1, false, 0] }],
    expected: ['bool,int,bool,int,'],
  },
  {
    name: 'string, const char* and string_view constructors',
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: method('strings',
      'struct Both { std::string kind; Both(const std::string&) : kind("string") {} Both(const char*) : kind("const char*") {} };\n' +
      'struct View { std::string kind; View(std::string_view text) : kind(text) {} };',
      'std::string solve(Both both, View view)', 'return both.kind + "|" + view.kind;'),
    cases: [{ both: 'x', view: 'seen' }],
    expected: ['const char*|seen'],
  },
  {
    name: 'object and scalar forms of one type, and a one-field aggregate',
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: method('forms',
      'struct Pair { int n = 0; std::string s; Pair() = default; Pair(int x) : n(x) {} };\nstruct Wrap { int v; };',
      'std::string solve(std::vector<Pair> values, std::vector<Wrap> wraps)',
      'std::string out; for (auto& value : values) out += std::to_string(value.n) + value.s + ","; for (auto& w : wraps) out += std::to_string(w.v) + ";"; return out;'),
    cases: [{ values: [{ n: 3, s: 'x' }, 5], wraps: [4, { v: 6 }] }],
    expected: ['3x,5,4;6;'],
  },
  {
    // One case per scenario: the compile-once batch driver runs every case in
    // one program, so a case that fails takes the batch with it.
    name: 'a scalar for a type with no matching constructor names the type',
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: method('nomatch', 'struct Point { int x; int y; };', 'int solve(Point point)', 'return point.x + point.y;'),
    cases: [{ point: 7 }],
    expected: [{ error: "TraceCode cannot build C++ type 'Point' from an integer argument" }],
  },
  {
    name: 'an object for a type with no constructors still decodes field by field',
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: method('fields', 'struct Point { int x; int y; };', 'int solve(Point point)', 'return point.x + point.y;'),
    cases: [{ point: { x: 1, y: 2 } }],
    expected: [3],
  },
  {
    name: 'null for a type with no default constructor names the type',
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: method('null', 'struct Box { int n; Box(int x) : n(x) {} };', 'int solve(std::vector<Box> boxes)', 'int t = 0; for (auto& b : boxes) t += b.n; return t;'),
    cases: [{ boxes: [null, 1] }],
    expected: [{ error: "TraceCode cannot build C++ type 'Box' from null" }],
  },
  // Review fixes (Grok, scope 1 at 06bcc509). The browser runs TraceCC's
  // wasm32 target, where long is 32 bits: an integer literal past int's range
  // has type long long there (long on LP64).
  {
    // Finding 1: rank by the literal's type; INT_MIN fits int.
    name: 'integer literal typing: int, long, long long by range',
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: method('ranks',
      'struct Kind { std::string kind; Kind(int) : kind("int") {} Kind(long) : kind("long") {} Kind(long long) : kind("long long") {} };',
      'std::string solve(std::vector<Kind> values)', KINDS),
    cases: [{ values: [3000000000, -2147483648, 2147483647, -2147483649] }],
    expected: ['long long,int,int,long long,'],
  },
  {
    // Finding 1: with int and a 32-bit long, nothing holds 3000000000; refuse
    // rather than wrap.
    name: 'an integer no integer constructor can hold names the type',
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: method('nofit',
      'struct Kind { std::string kind; Kind(int) : kind("int") {} };',
      'std::string solve(std::vector<Kind> values)', KINDS),
    cases: [{ values: [3000000000] }],
    expected: [{ error: "TraceCode cannot build C++ type 'Kind' from an integer argument: none of its integer constructors can hold the value." }],
  },
  {
    // On wasm32 long is 32 bits, so 3000000000 is a long long literal, and
    // Kind(int) and Kind(long) are equally good conversions from it, as the
    // compiler would say for Kind(3000000000).
    name: 'past long on wasm32, int and long constructors are equally good matches',
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: method('pastlong',
      'struct Kind { std::string kind; Kind(int) : kind("int") {} Kind(long) : kind("long") {} };',
      'std::string solve(std::vector<Kind> values)', KINDS),
    cases: [{ values: [3000000000] }],
    expected: [{ error: "TraceCode cannot build C++ type 'Kind' from an integer argument: its constructors taking int and long are equally good matches." }],
  },
  {
    name: 'int and long constructors keep INT_MIN and INT_MAX on int',
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: method('intlimits',
      'struct Kind { std::string kind; Kind(int) : kind("int") {} Kind(long) : kind("long") {} };',
      'std::string solve(std::vector<Kind> values)', KINDS),
    cases: [{ values: [-2147483648, 2147483647] }],
    expected: ['int,int,'],
  },
  {
    // Finding 2: a templated constructor sees the literal's type on every
    // driver, past INT_MAX too.
    name: 'templated constructor: Run and Submit pass the same type',
    functionName: 'Ledger',
    executionStyle: 'ops-class',
    code: `#include <string>
#include <type_traits>
struct Value {
  std::string kind;
  template <class T>
  Value(T) : kind(std::is_same_v<T, int> ? "int" : std::is_same_v<T, long> ? "long" : std::is_same_v<T, long long> ? "long long" : "other") {}
};
class Ledger {
public:
  Ledger() = default;
  std::string add(Value value) {
    return value.kind;
  }
};`,
    cases: [{ operations: ['Ledger', 'add', 'add'], arguments: [[], [7], [3000000000]] }],
    expected: [[null, 'int', 'long long']],
  },
  {
    // Finding 3: a learner type named Json (compiled and returned 7 on 571139f0).
    name: 'a learner type named Json decodes from an object',
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: method('json', 'struct Json { int n; Json() = default; Json(int x) : n(x) {} };', 'int solve(Json value)', 'return value.n;'),
    cases: [{ value: { n: 7 } }],
    expected: [7],
  },
  {
    name: 'a learner type named Json decodes from a scalar',
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: method('json', 'struct Json { int n; Json() = default; Json(int x) : n(x) {} };', 'int solve(Json value)', 'return value.n;'),
    cases: [{ value: 7 }],
    expected: [7],
  },
  {
    // Finding 4: ops-class Run decodes objects by field name, not key order.
    name: 'ops-class objects decode by field name on every driver',
    functionName: 'Ledger',
    executionStyle: 'ops-class',
    code: `struct Point { int x; int y; };
class Ledger {
public:
  Ledger() = default;
  int sum(Point p) {
    return p.x * 10 + p.y;
  }
};`,
    cases: [{ operations: ['Ledger', 'sum'], arguments: [[], [{ y: 1, x: 2 }]] }],
    expected: [[null, 21]],
  },
  {
    name: 'ops-class arrays for a value type fail alike on every driver',
    functionName: 'Ledger',
    executionStyle: 'ops-class',
    code: `struct Point { int x; int y; };
class Ledger {
public:
  Ledger() = default;
  int sum(Point p) {
    return p.x * 10 + p.y;
  }
};`,
    cases: [{ operations: ['Ledger', 'sum'], arguments: [[], [[1, 2]]] }],
    expected: [{ error: "TraceCode cannot build C++ type 'Point' from a JSON array argument." }],
  },
  {
    // Finding 5: an ambiguous scalar overload leaves the object arm alone
    // (returned 4 on 571139f0).
    name: 'ambiguous scalar constructors still decode an object',
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: method('ambigobj', 'struct Value { int n = -1; Value() = default; Value(long) : n(1) {} Value(short) : n(2) {} };', 'int solve(Value value)', 'return value.n;'),
    cases: [{ value: { n: 4 } }],
    expected: [4],
  },
  {
    name: 'ambiguous constructors name the type when that kind arrives',
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: method('ambiguous', 'struct Wide { long n; Wide(long x) : n(x) {} Wide(short x) : n(x) {} };', 'int solve(Wide wide)', 'return static_cast<int>(wide.n);'),
    cases: [{ wide: 7 }],
    expected: [{ error: "TraceCode cannot build C++ type 'Wide' from an integer argument: its constructors taking long and short are equally good matches." }],
  },
];

// The natural-shape proof set: correct learner solutions written the way a
// learner would, one per affected shape and problem kind, plus controls. Each
// must pass on every driver, Run and Submit.
interface NaturalShapeFixture {
  name: string;
  shape: number | 'control';
  kind: string;
  code: string;
  functionName: string;
  executionStyle: Scenario['executionStyle'];
  cases: Array<{ id: string; input: Record<string, unknown>; expected: unknown }>;
  untracedOnly?: string;
}
const NATURAL_SHAPES = JSON.parse(
  await readFile(resolve(process.cwd(), 'tests', 'fixtures', 'cpp-natural-shapes.json'), 'utf8')
) as { fixtures: NaturalShapeFixture[] };
for (const fixture of NATURAL_SHAPES.fixtures) {
  SCENARIOS.push({
    name: `natural shape ${fixture.shape}: ${fixture.name} (${fixture.kind})`,
    functionName: fixture.functionName,
    executionStyle: fixture.executionStyle,
    code: fixture.code,
    cases: fixture.cases.map(({ input }) => input),
    expected: fixture.cases.map(({ expected }) => expected),
    ...(fixture.untracedOnly ? { untracedOnly: fixture.untracedOnly } : {}),
  });
}

interface RunSummary {
  ok: boolean;
  output?: unknown;
  events?: number;
  raw: string;
}

type PathResults = Record<string, RunSummary[]>;

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
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-cpp-value-type-browser-'));
  const workersRoot = join(tempRoot, 'workers');
  const port = 5600 + Math.floor(Math.random() * 200);
  const origin = `http://127.0.0.1:${port}`;
  // TRACECODE_VALUE_TYPE_FROM (1-based) and TRACECODE_VALUE_TYPE_ONLY (a name
  // substring) narrow the run while diagnosing one scenario.
  const from = Number(process.env.TRACECODE_VALUE_TYPE_FROM ?? 1);
  const only = process.env.TRACECODE_VALUE_TYPE_ONLY;
  const scenarios = SCENARIOS.filter((scenario, index) => index + 1 >= from && (!only || scenario.name.includes(only)));
  assertCondition(scenarios.length > 0, 'no scenario matches TRACECODE_VALUE_TYPE_FROM / TRACECODE_VALUE_TYPE_ONLY');
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
  await writeFile(join(tempRoot, 'index.html'), '<!doctype html><title>C++ value-type arguments</title>', 'utf8');

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
    // No per-request log: the pipes below are drained, but a log line per
    // request has no reader that needs it.
    '    def log_message(self, format, *args):',
    '        pass',
    `os.chdir(${JSON.stringify(tempRoot)})`,
    `ThreadingHTTPServer(("127.0.0.1", ${port}), Handler).serve_forever()`,
  ].join('\n')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  // Drain the server's output. An unread pipe fills after a few hundred
  // requests and blocks the server mid-response, which surfaces as a worker
  // that never loads (WorkerReadyTimeoutError) or a page that never navigates.
  server.stdout.resume();
  server.stderr.resume();

  const browser = await chromium.launch({ headless: true, ...(BROWSER_CHANNEL ? { channel: BROWSER_CHANNEL } : {}) });
  try {
    await waitForHttp(origin, 30_000);
    // All scenarios share one page by default. TRACECODE_VALUE_TYPE_CHUNK=n
    // runs them n at a time, each chunk in a fresh page with its own compiler
    // and worker clients, to separate scenarios while diagnosing.
    const results: Record<string, PathResults> = {};
    const timings: Record<string, Record<string, number>> = {};
    const CHUNK = Number(process.env.TRACECODE_VALUE_TYPE_CHUNK ?? scenarios.length);
    for (let offset = 0; offset < scenarios.length; offset += CHUNK) {
    const chunk = scenarios.slice(offset, offset + CHUNK);
    console.log(`chunk ${offset / CHUNK + 1}: ${chunk.map(({ name }) => name).join(' | ')}`);
    const page = await browser.newPage();
    page.setDefaultTimeout(600_000);
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') console.log(`[page ${message.type()}] ${message.text().slice(0, 400)}`);
    });
    await page.goto(origin);
    await page.evaluate('globalThis.__name = (fn) => fn');
    const chunkStarted = Date.now();
    const chunkOut = await page.evaluate(`(async () => {
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
      const scenarios = ${JSON.stringify(chunk)};
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
      const timings = {};
      for (const scenario of scenarios) {
        const paths = {};
        const times = timings[scenario.name] = {};
        let mark = performance.now();
        const lap = (name) => { const now = performance.now(); times[name] = (times[name] || 0) + Math.round(now - mark); mark = now; };
        const base = { code: scenario.code, functionName: scenario.functionName, executionStyle: scenario.executionStyle };

        paths.singleCase = [];
        paths.singleCaseTraced = [];
        for (const inputs of scenario.cases) {
          try { paths.singleCase.push(summarize(await client.executeCode({ ...base, inputs }))); }
          catch (error) { paths.singleCase.push(failure(error)); }
          lap('singleCase');
          try { paths.singleCaseTraced.push(summarize(await client.executeWithTracing({ ...base, inputs, traceOptions }))); }
          catch (error) { paths.singleCaseTraced.push(failure(error)); }
          lap('singleCaseTraced');
        }
        try {
          const batch = await client.executeCodeBatch({ ...base, inputBatch: scenario.cases });
          paths.batch = scenario.cases.map((_inputs, index) => summarize(batch.results[index]));
        } catch (error) {
          paths.batch = scenario.cases.map(() => failure(error));
        }
        lap('batch');

        const codeProvider = createCppPreparedExecutionProvider({ createWorkerClient: () => new CppWorkerClient(workerOptions) });
        // A provider that cannot start fails this scenario's prepared paths,
        // not every scenario after it.
        let prepared;
        try {
          await codeProvider.init();
          lap('preparedInit');
          prepared = await codeProvider.prepareProgram({ mode: 'code', ...base });
          lap('preparedCompile');
        } catch (error) {
          lap('preparedStartFailed');
          prepared = { kind: 'threw', error: String(error && error.message ? error.message : error) };
        }
        if (prepared.kind !== 'prepared') {
          paths.prepared = scenario.cases.map(() => failure(new Error('prepare failed: ' + JSON.stringify(prepared))));
          paths.preparedBatch = paths.prepared;
        } else {
          paths.prepared = [];
          for (const inputs of scenario.cases) {
            try { paths.prepared.push(summarize(await prepared.program.executeIsolated({ inputs }))); }
            catch (error) { paths.prepared.push(failure(error)); }
          }
          lap('prepared');
          try {
            const batch = await prepared.program.executeBatchIsolated({ inputBatch: scenario.cases });
            paths.preparedBatch = batch.map(summarize);
          } catch (error) {
            paths.preparedBatch = scenario.cases.map(() => failure(error));
          }
          lap('preparedBatch');
          await prepared.program.dispose();
        }

        const traceProvider = createCppPreparedExecutionProvider({ createWorkerClient: () => new CppWorkerClient(workerOptions) });
        let preparedTrace;
        try {
          await traceProvider.init();
          lap('preparedTraceInit');
          preparedTrace = await traceProvider.prepareProgram({ mode: 'trace', ...base, traceOptions });
          lap('preparedTraceCompile');
        } catch (error) {
          lap('preparedTraceStartFailed');
          preparedTrace = { kind: 'threw', error: String(error && error.message ? error.message : error) };
        }
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
          lap('preparedTraceIsolated');
          try {
            const batch = await preparedTrace.program.executeBatchIsolated({
              inputBatch: scenario.cases,
              traceEnabledBatch: scenario.cases.map((_inputs, index) => index % 2 === 0),
            });
            paths.preparedTraceBatchMixed = batch.map(summarize);
          } catch (error) {
            paths.preparedTraceBatchMixed = scenario.cases.map(() => failure(error));
          }
          lap('preparedTraceBatchMixed');
          await preparedTrace.program.dispose();
        }
        out[scenario.name] = paths;
        codeProvider.terminate();
        traceProvider.terminate();
      }
      client.terminate();
      compiler.terminate();
      return { out, timings };
    })()`) as { out: Record<string, PathResults>; timings: Record<string, Record<string, number>> };
    Object.assign(results, chunkOut.out);
    Object.assign(timings, chunkOut.timings);
    console.log(`chunk ${offset / CHUNK + 1} done in ${Date.now() - chunkStarted} ms`);
    await page.close();
    }

    const failures: string[] = [];
    for (const scenario of scenarios) {
      const paths = results[scenario.name];
      for (const [pathName, runs] of Object.entries(paths)) {
        const traced = /Trace|Traced/.test(pathName);
        if (traced && scenario.untracedOnly) {
          console.log(`known limit (not asserted): ${scenario.name} / ${pathName}: ${scenario.untracedOnly}: ${runs.map((run) => JSON.stringify(run.ok ? run.output : 'failed')).join(', ')}`);
          continue;
        }
        scenario.expected.forEach((expected, index) => {
          const run = runs[index];
          const label = `${scenario.name} / ${pathName} / case ${index + 1}`;
          if (expected && typeof expected === 'object' && !Array.isArray(expected) && 'error' in expected) {
            const text = (expected as { error: string }).error;
            if (run.ok || !run.raw.includes(text)) failures.push(`${label}: expected a failure naming "${text}", got ${run.raw}`);
            return;
          }
          if (!run.ok || JSON.stringify(run.output) !== JSON.stringify(expected)) {
            failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${run.raw}`);
          }
        });
      }
      for (const [index, expected] of scenario.expected.entries()) {
        if (scenario.untracedOnly || (expected && typeof expected === 'object' && 'error' in (expected as object))) continue;
        const recorded = paths.preparedTraceRecording[index];
        const silent = paths.preparedTraceNotRecording[index];
        if (recorded.ok && !(typeof recorded.events === 'number' && recorded.events > 0)) {
          failures.push(`${scenario.name} / preparedTraceRecording / case ${index + 1}: no trace events recorded`);
        }
        if (silent.ok && typeof silent.events === 'number' && silent.events > 0) {
          failures.push(`${scenario.name} / preparedTraceNotRecording / case ${index + 1}: recorded ${silent.events} events`);
        }
      }
      const perPath = Object.entries(paths)
        .map(([pathName, runs]) => `${pathName}=${runs.filter((run) => run.ok).length}/${runs.length}`)
        .join(' ');
      const times = Object.entries(timings[scenario.name] ?? {}).map(([name, ms]) => `${name}=${ms}`).join(' ');
      console.log(`${SCENARIOS.indexOf(scenario) + 1}. ${scenario.name}: ${Object.keys(paths).length} paths x ${scenario.cases.length} cases; ok ${perPath}; ms ${times}`);
    }
    assertCondition(failures.length === 0, `C++ value-type arguments diverged:\n${failures.join('\n')}`);
    console.log(`PASS: C++ value-type arguments decode alike on every driver (${scenarios.length} scenarios)`);
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('cpp value-type arguments decode alike on every driver', main);

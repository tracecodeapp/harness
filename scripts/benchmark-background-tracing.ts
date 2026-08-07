#!/usr/bin/env npx tsx
/**
 * Background-tracing benchmark.
 *
 * Answers three questions per language, in a real browser, against the real
 * runtimes:
 *
 *  1. How long until every case has a pass/fail verdict (compile + untraced
 *     run)? This is the clock the Compile button should be racing.
 *  2. What does one traced case cost once the runtime is already warm?
 *  3. If tracing the remaining cases is pushed to a background queue, how long
 *     does that queue take to drain?
 *
 * It also records the current shipping behaviour (one batch that traces every
 * case) so the two can be compared directly.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from '../tests/example-app-smoke';

type BenchmarkLanguage =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'java'
  | 'csharp'
  | 'cpp';

const ALL_LANGUAGES: readonly BenchmarkLanguage[] = [
  'python',
  'javascript',
  'typescript',
  'java',
  'csharp',
  'cpp',
];

const SOLUTION_EXTENSIONS: Record<Exclude<BenchmarkLanguage, 'python'>, string> = {
  javascript: 'js',
  typescript: 'ts',
  java: 'java',
  csharp: 'cs',
  cpp: 'cpp',
};

/**
 * The trace budget the product intends to use. Passing nothing lets the runtime
 * fall back to a 500 single-line-hit ceiling, which aborts large traces and
 * would measure failed work instead of real tracing.
 */
/** Set from the resolved trace options so the reporter can flag capped cases. */
let activeMaxStoredEvents = 16000;

const PRODUCT_TRACE_BUDGET = {
  maxTraceSteps: 4000,
  maxLineEvents: 20000,
  maxSingleLineHits: 4000,
  maxStoredEvents: 16000,
  traceProfile: true,
};

interface BenchmarkCase {
  id: string;
  input: Record<string, unknown>;
  expected: unknown;
}

interface BenchmarkFixture {
  language: BenchmarkLanguage;
  problem: string;
  code: string;
  functionName: string;
  executionStyle?: 'function' | 'solution-method';
  cases: BenchmarkCase[];
}

interface PhaseSummary {
  ms: number;
  verdict: string;
  evaluationStatus: string;
  casesPassed: number;
  casesTotal: number;
  compileMs?: number;
  diagnostics: string[];
}

interface BenchmarkLanguageResult {
  language: BenchmarkLanguage;
  problem: string;
  caseCount: number;
  warmMs?: number;
  correctness: PhaseSummary;
  traceAll?: PhaseSummary;
  perCaseCodeMs: number[];
  perCaseCodeVerdicts: string[];
  perCaseTraceMs: number[];
  perCaseVerdicts: string[];
  perCaseEventCounts?: number[];
  error?: string;
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function parseCsv<T extends string>(raw: string | undefined, fallback: readonly T[]): T[] {
  if (!raw) return [...fallback];
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean) as T[];
  return values.length > 0 ? values : [...fallback];
}

function pascalCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    // TraceCC declares exact media types in its manifest and preflights them.
    case '.hpp':
      return 'text/plain';
    case '.tar':
      return 'application/x-tar';
    case '.o':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}

async function startStaticServer(root: string): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const candidate = normalize(join(root, decodeURIComponent(requestUrl.pathname)));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const filePath = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!filePath || !existsSync(filePath)) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Length': String(statSync(filePath).size),
      'Content-Type': contentType(filePath),
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    createReadStream(filePath).pipe(response);
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve benchmark server address.');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      }),
  };
}

async function loadFixtures(
  productRoot: string,
  problems: readonly string[],
  languages: readonly BenchmarkLanguage[],
  maxCases: number | undefined
): Promise<BenchmarkFixture[]> {
  const fixtures: BenchmarkFixture[] = [];
  for (const problem of problems) {
    const raw = JSON.parse(
      await readFile(resolve(productRoot, 'data', 'problems', `${problem}.json`), 'utf8')
    ) as {
      functionName: string;
      executionStyle?: 'function' | 'solution-method';
      solutionCode: string;
      testCases: Array<{ id: string; input: Record<string, unknown>; expected: unknown }>;
    };
    const cases = (maxCases === undefined ? raw.testCases : raw.testCases.slice(0, maxCases)).map(
      (testCase) => ({
        id: testCase.id,
        input: testCase.input,
        expected: testCase.expected,
      })
    );
    for (const language of languages) {
      const code =
        language === 'python'
          ? raw.solutionCode
          : await readFile(
              resolve(
                productRoot,
                'data',
                'reference-solutions',
                language,
                'practice',
                `${problem}.${SOLUTION_EXTENSIONS[language]}`
              ),
              'utf8'
            );
      fixtures.push({
        language,
        problem,
        code,
        functionName:
          language === 'csharp' ? pascalCase(raw.functionName) : raw.functionName,
        ...(raw.executionStyle ? { executionStyle: raw.executionStyle } : {}),
        cases,
      });
    }
  }
  return fixtures;
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(fraction * sortedValues.length) - 1)
  );
  return sortedValues[index]!;
}

function formatMs(value: number | undefined): string {
  if (value === undefined) return '—';
  return value >= 10_000
    ? `${(value / 1000).toFixed(1)}s`
    : `${Math.round(value)}ms`;
}

function report(results: readonly BenchmarkLanguageResult[]): void {
  const byProblem = new Map<string, BenchmarkLanguageResult[]>();
  for (const result of results) {
    const list = byProblem.get(result.problem) ?? [];
    list.push(result);
    byProblem.set(result.problem, list);
  }

  for (const [problem, list] of byProblem) {
    console.log(`\n### ${problem}\n`);
    console.log(
      [
        'language'.padEnd(11),
        'cases'.padStart(6),
        'pass/fail'.padStart(10),
        'compile'.padStart(9),
        '1st trace'.padStart(10),
        'median'.padStart(8),
        'drain all'.padStart(10),
        'trace-all'.padStart(10),
        'heavy code'.padStart(11),
        'heavy trace'.padStart(12),
        'trace x'.padStart(8),
        'hvy events'.padStart(11),
        'capped'.padStart(7),
        'verdicts'.padStart(9),
      ].join(' ')
    );
    for (const result of list) {
      if (result.error) {
        console.log(`${result.language.padEnd(11)} ERROR: ${result.error.split('\n')[0]}`);
        continue;
      }
      const traces = result.perCaseTraceMs;
      const sorted = [...traces].sort((left, right) => left - right);
      const drain = traces.reduce((total, value) => total + value, 0);
      // The heaviest traced case is where the interpretation-vs-emission split
      // actually matters; averages are swamped by the trivial cases.
      const heavyIndex = traces.indexOf(Math.max(...traces));
      const heavyTrace = traces[heavyIndex];
      const heavyCode = result.perCaseCodeMs[heavyIndex];
      const traceMultiple =
        heavyCode !== undefined && heavyCode > 0 && heavyTrace !== undefined
          ? `${(heavyTrace / heavyCode).toFixed(1)}x`
          : '—';
      const heavyProfile = (result as { perCaseProfiles?: Array<Record<string, unknown> | null> })
        .perCaseProfiles?.[heavyIndex];
      if (heavyProfile) {
        console.log(`  [${result.language} heavy-case profile] ${JSON.stringify(heavyProfile)}`);
      }
      console.log(
        [
          result.language.padEnd(11),
          String(result.caseCount).padStart(6),
          formatMs(result.correctness.ms).padStart(10),
          formatMs(result.correctness.compileMs).padStart(9),
          formatMs(traces[0]).padStart(10),
          formatMs(percentile(sorted, 0.5)).padStart(8),
          formatMs(drain).padStart(10),
          formatMs(result.traceAll?.ms).padStart(10),
          formatMs(heavyCode).padStart(11),
          formatMs(heavyTrace).padStart(12),
          traceMultiple.padStart(8),
          String(result.perCaseEventCounts?.[heavyIndex] ?? '—').padStart(11),
          String(
            // >= 99% of the stored-event budget: runtimes stop within a few
            // events of the cap (some strictly below it), and a case that
            // close to the ceiling did not finish emitting its full trace.
            (result.perCaseEventCounts ?? []).filter(
              (count) => count >= activeMaxStoredEvents * 0.99
            ).length
          ).padStart(7),
          // Timing numbers are meaningless if traced runs stopped passing.
          (result.perCaseVerdicts.every((verdict) => verdict === 'passed')
            ? 'passed'
            : `BAD:${result.perCaseVerdicts.filter((verdict) => verdict !== 'passed').length}`
          ).padStart(9),
        ].join(' ')
      );
    }
  }
}

async function main(): Promise<void> {
  const languages = parseCsv<BenchmarkLanguage>(option('languages'), ALL_LANGUAGES);
  for (const language of languages) {
    if (!ALL_LANGUAGES.includes(language)) {
      throw new Error(`Unsupported language ${JSON.stringify(language)}.`);
    }
  }
  const problems = parseCsv(option('problems'), ['two-sum', 'coin-change']);
  const productRoot = resolve(
    option('product-root') ?? '/Users/obinnanwachukwu/Code/algoflow'
  );
  const maxCasesRaw = option('max-cases');
  const maxCases = maxCasesRaw === undefined ? undefined : Number(maxCasesRaw);
  const outPath = option('out');
  const skipTraceAll = process.argv.includes('--skip-trace-all');
  // Overrides for isolating where traced time actually goes: shrinking the
  // budget should shrink emission work, and minimalTrace should remove it
  // almost entirely. If neither moves the clock, the cost is in the
  // instrumentation scaffolding rather than in emitting events.
  const maxTraceStepsRaw = option('max-trace-steps');
  // --trace-limits=uncapped raises every budget x16 so no runtime stops
  // tracing early; a fast time under product limits can just mean "hit the
  // cap soonest", so cross-runtime comparisons need this equal-output mode.
  const uncapped = option('trace-limits') === 'uncapped';
  const traceOptions = {
    ...PRODUCT_TRACE_BUDGET,
    ...(uncapped
      ? {
          maxTraceSteps: PRODUCT_TRACE_BUDGET.maxTraceSteps * 16,
          maxLineEvents: PRODUCT_TRACE_BUDGET.maxLineEvents * 16,
          maxSingleLineHits: PRODUCT_TRACE_BUDGET.maxSingleLineHits * 16,
          maxStoredEvents: PRODUCT_TRACE_BUDGET.maxStoredEvents * 16,
          // Python retains events under a byte budget; without scaling it the
          // uncapped mode silently stops at the 4MB default.
          maxTraceBytes: 64 * 1024 * 1024,
        }
      : {}),
    ...(maxTraceStepsRaw ? { maxTraceSteps: Number(maxTraceStepsRaw) } : {}),
    ...(process.argv.includes('--minimal-trace') ? { minimalTrace: true } : {}),
    // Profiling instruments the runtime's own hot path (python wraps ~19 hook
    // functions), which inflates every timing here. It stays on by default so
    // recorded numbers stay comparable across this sprint; pass
    // --no-trace-profile for true production-mode timings.
    ...(process.argv.includes('--no-trace-profile') ? { traceProfile: false } : {}),
  };
  activeMaxStoredEvents = traceOptions.maxStoredEvents;

  const fixtures = await loadFixtures(productRoot, problems, languages, maxCases);
  console.log(
    `Benchmarking ${languages.join(', ')} over ${problems.join(', ')} ` +
      `(${fixtures[0]?.cases.length ?? 0} cases for ${problems[0]})`
  );

  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-background-tracing-'));
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    await runCommand(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'sync-assets', join(tempRoot, 'workers'), '--languages', languages.join(',')],
      process.cwd()
    );
    if (languages.includes('cpp')) {
      // C++ needs the assembled TraceCC tree (toolchain + PCH shards) served
      // alongside the workers; `sync-assets` does not produce it.
      const traceccSource = resolve(
        process.env.TRACECC_ASSET_DIR ??
          join(
            '.cache',
            'tracecc-runtime-assets',
            '1f50b24524b84b65663aa2fde85c97661a095f438596ffc916c000a6bfe450ca'
          )
      );
      if (!existsSync(traceccSource)) {
        throw new Error(
          `TraceCC asset tree not found at ${traceccSource}. Run prepare:tracecc-assets ` +
            'or set TRACECC_ASSET_DIR.'
        );
      }
      await cp(traceccSource, join(tempRoot, 'tracecc'), {
        recursive: true,
        force: true,
      });
    }
    if (languages.includes('java')) {
      const traceJVMRoot = resolve(process.env.TRACECODE_TRACEJVM_ROOT ?? '../tracejvm');
      const traceJVMTarget = join(tempRoot, 'tracejvm');
      await mkdir(traceJVMTarget, { recursive: true });
      await copyFile(
        join(traceJVMRoot, 'dist/browser-client.js'),
        join(traceJVMTarget, 'browser-client.js')
      );
      await copyFile(
        join(traceJVMRoot, 'runtime/assets/bjvm_main.wasm'),
        join(traceJVMTarget, 'bjvm_main.wasm')
      );
      await cp(
        join(traceJVMRoot, 'runtime/assets/profiles/core'),
        join(traceJVMTarget, 'profiles/core'),
        { recursive: true, force: true }
      );
      await cp(
        join(traceJVMRoot, '.cache/teavm-javac/artifacts'),
        join(traceJVMTarget, 'compiler'),
        { recursive: true, force: true }
      );
    }
    await build({
      entryPoints: [resolve('tests/fixtures/background-tracing-benchmark-entry.ts')],
      outfile: join(tempRoot, 'background-tracing.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      alias: {
        zlib: resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n', 'utf8');
    server = await startStaticServer(resolve(tempRoot));

    const browser = await chromium.launch({ headless: true });
    const results: BenchmarkLanguageResult[] = [];
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(600_000);
      page.on('pageerror', (error) => {
        console.error(`[browser pageerror] ${error.stack ?? error.message}`);
      });
      page.on('console', (message) => {
        if (message.type() === 'error' || message.text().includes('__TRACECODE_BENCH_FAILURE__') || message.text().includes('__TRACECODE_PYPROF__') || message.text().includes('__TRACECODE_CSPROF__') || process.env.TRACECODE_BENCH_CONSOLE === '1') {
          console.error(`[browser console] ${message.text()}`);
        }
      });
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });

      // One page.evaluate per fixture keeps a single hung runtime from taking
      // the whole matrix down with it.
      for (const fixture of fixtures) {
        console.log(`  → ${fixture.language} / ${fixture.problem} (${fixture.cases.length} cases)`);
        const fixtureResults = (await page.evaluate(
          async ({ fixture: pageFixture, traceOptions, skip }) => {
            const moduleUrl: string = '/background-tracing.mjs';
            const module = await import(moduleUrl);
            return module.runBackgroundTracingBenchmark('/workers', [pageFixture], {
              traceOptions,
              skipTraceAll: skip,
              traceccAssetBaseUrl: '/tracecc',
            });
          },
          { fixture, traceOptions, skip: skipTraceAll }
        )) as BenchmarkLanguageResult[];
        for (const result of fixtureResults) {
          results.push(result);
          if (result.error) console.error(`    ERROR: ${result.error.split('\n')[0]}`);
          else
            console.log(
              `    pass/fail ${formatMs(result.correctness.ms)}, ` +
                `drain ${formatMs(result.perCaseTraceMs.reduce((a, b) => a + b, 0))}`
            );
        }
      }
    } finally {
      await browser.close();
    }

    report(results);
    if (outPath) {
      await writeFile(
        resolve(outPath),
        `${JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            traceOptions,
            problems,
            languages,
            results,
          },
          null,
          2
        )}\n`,
        'utf8'
      );
      console.log(`\nWrote ${outPath}`);
    }
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

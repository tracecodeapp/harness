#!/usr/bin/env node
/**
 * Paired C++ on-demand tracing experiment over the AlgoFlow corpus.
 *
 * This deliberately bypasses Judge and calls CppWorkerClient in the browser.
 * It compares one trace-capable Wasm module with per-case recording selection
 * against a traced module plus a separately compiled clean drain module.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from '../tests/example-app-smoke';
import type {
  CppCompilerIntegrity,
  CppOnDemandFixture,
  CppOnDemandSample,
} from '../tests/fixtures/cpp-on-demand-tracing-benchmark-entry';

const TRACECC_PACKAGE_ROOT = dirname(
  createRequire(import.meta.url).resolve('@tracecode/tracecc/package.json')
);
const TRACECC_PACKAGE_RELEASE_ROOT = join(TRACECC_PACKAGE_ROOT, 'runtime-release');
const TRACECC_ASSET_NAMES = [
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
const TRACE_OPTIONS = {
  maxTraceSteps: 4_000,
  maxLineEvents: 20_000,
  maxSingleLineHits: 4_000,
  maxStoredEvents: 4_000,
};

interface RecordedSample extends CppOnDemandSample {
  readonly iteration: number;
  readonly order: number;
}

interface Failure {
  readonly problem: string;
  readonly iteration?: number;
  readonly strategy?: CppOnDemandSample['strategy'];
  readonly error: string;
}

interface PairSummary {
  readonly problem: string;
  readonly caseCount: number;
  readonly iterationDeltasMs: readonly number[];
  /**
   * The common trace preparation is already sunk for either strategy. This is
   * the decision-relevant delta: marginal clean preparation + dual execution
   * minus one-artifact execution. Positive means keep the one artifact.
   */
  readonly iterationOpportunityDeltasMs: readonly number[];
  readonly stableSign: 'single' | 'dual' | 'tie' | 'unstable';
  readonly singleDecisionMs: number;
  readonly dualDecisionMs: number;
  readonly dualMinusSingleDecisionMs: number;
  readonly dualMinusSingleOpportunityMs: number;
  readonly singleExecutionMs: number;
  readonly dualExecutionMs: number;
  readonly singleMinusDualExecutionMs: number;
  readonly cleanPrepareMs: number;
  readonly drainCaseCount: number;
  readonly cleanExecutionSavingsPerDrainCaseMs: number;
  readonly crossoverDrainCases: number | null;
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
}

function formatMs(value: number): string {
  return value >= 10_000 ? `${(value / 1_000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.wasm':
    case '.o': return 'application/wasm';
    case '.hpp': return 'text/plain';
    case '.tar': return 'application/x-tar';
    default: return 'application/octet-stream';
  }
}

async function startStaticServer(root: string): Promise<{
  readonly origin: string;
  close(): Promise<void>;
}> {
  const normalizedRoot = normalize(root);
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const candidate = normalize(join(normalizedRoot, decodeURIComponent(requestUrl.pathname)));
    if (!candidate.startsWith(`${normalizedRoot}${sep}`) && candidate !== normalizedRoot) {
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
    throw new Error('Unable to resolve C++ benchmark server address.');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }),
  };
}

async function discoverCorpus(productRoot: string): Promise<{
  readonly problems: string[];
  readonly problemDefinitions: number;
  readonly cppSolutions: number;
  readonly missingCppSolutions: string[];
  readonly missingProblemDefinitions: string[];
}> {
  const definitions = (await readdir(resolve(productRoot, 'data/problems')))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .sort();
  const solutions = (await readdir(resolve(productRoot, 'data/reference-solutions/cpp/practice')))
    .filter((name) => name.endsWith('.cpp'))
    .map((name) => name.slice(0, -4))
    .sort();
  const definitionSet = new Set(definitions);
  const solutionSet = new Set(solutions);
  return {
    problems: definitions.filter((name) => solutionSet.has(name)),
    problemDefinitions: definitions.length,
    cppSolutions: solutions.length,
    missingCppSolutions: definitions.filter((name) => !solutionSet.has(name)),
    missingProblemDefinitions: solutions.filter((name) => !definitionSet.has(name)),
  };
}

async function loadFixture(productRoot: string, problem: string): Promise<CppOnDemandFixture> {
  const definition = JSON.parse(await readFile(
    resolve(productRoot, 'data/problems', `${problem}.json`),
    'utf8'
  )) as {
    functionName: string;
    executionStyle?: 'function' | 'solution-method' | 'ops-class';
    testCases: Array<{ id: string; input: Record<string, unknown> }>;
  };
  return {
    problem,
    code: await readFile(
      resolve(productRoot, 'data/reference-solutions/cpp/practice', `${problem}.cpp`),
      'utf8'
    ),
    functionName: definition.functionName,
    ...(definition.executionStyle ? { executionStyle: definition.executionStyle } : {}),
    cases: definition.testCases.map((testCase) => ({
      id: testCase.id,
      input: testCase.input,
    })),
  };
}

async function compilerIntegrity(
  assetRoot: string,
  origin: string
): Promise<CppCompilerIntegrity> {
  return {
    assets: await Promise.all(TRACECC_ASSET_NAMES.map(async (name) => {
      const bytes = await readFile(join(assetRoot, name));
      return {
        url: `${origin}/tracecc/${name}`,
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    })),
  };
}

function assertSameOutputs(single: RecordedSample, dual: RecordedSample): void {
  if (single.outputJson.length !== dual.outputJson.length) {
    throw new Error(`${single.problem}: strategy output counts differ.`);
  }
  for (let index = 0; index < single.outputJson.length; index += 1) {
    const singleOutput = canonicalOutputJson(single.outputJson[index]!);
    const dualOutput = canonicalOutputJson(dual.outputJson[index]!);
    if (singleOutput !== dualOutput) {
      throw new Error(
        `${single.problem} case ${index}: outputs differ; ` +
        `single=${single.outputJson[index]} dual=${dual.outputJson[index]}`
      );
    }
  }
  if (single.eventCounts[0] !== dual.eventCounts[0]) {
    throw new Error(
      `${single.problem}: selected trace event counts differ ` +
      `(${single.eventCounts[0]} vs ${dual.eventCounts[0]}).`
    );
  }
}

/**
 * Reference metadata identifies allocations inside one Wasm instance. A clean
 * and instrumented driver may allocate the same returned tree/list/graph in a
 * different order, so raw `ref-2` versus `ref-0` is not an output difference.
 * Remap IDs by serialized traversal while retaining aliases and back-references.
 */
function canonicalOutputJson(encoded: string): string {
  const references = new Map<string, string>();
  let nextReference = 0;
  const reference = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    let canonical = references.get(value);
    if (!canonical) {
      canonical = `ref-${nextReference++}`;
      references.set(value, canonical);
    }
    return canonical;
  };
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      if (key === '__id__' || key === '__ref__') {
        output[key] = reference(input[key]);
      } else {
        output[key] = visit(input[key]);
      }
    }
    return output;
  };
  return JSON.stringify(visit(JSON.parse(encoded)));
}

function summarize(samples: readonly RecordedSample[]): PairSummary[] {
  const byProblem = new Map<string, RecordedSample[]>();
  for (const sample of samples) {
    const list = byProblem.get(sample.problem) ?? [];
    list.push(sample);
    byProblem.set(sample.problem, list);
  }
  const summaries: PairSummary[] = [];
  for (const [problem, entries] of byProblem) {
    const deltas: number[] = [];
    const opportunityDeltas: number[] = [];
    for (const iteration of [...new Set(entries.map((entry) => entry.iteration))]) {
      const single = entries.find((entry) => entry.iteration === iteration && entry.strategy === 'single-instrumented');
      const dual = entries.find((entry) => entry.iteration === iteration && entry.strategy === 'dual-artifact');
      if (!single || !dual) continue;
      assertSameOutputs(single, dual);
      deltas.push(dual.decisionWallMs - single.decisionWallMs);
      opportunityDeltas.push(
        dual.codePrepareWallMs + dual.executionWallMs - single.executionWallMs
      );
    }
    if (deltas.length === 0) continue;
    const single = entries.filter((entry) => entry.strategy === 'single-instrumented');
    const dual = entries.filter((entry) => entry.strategy === 'dual-artifact');
    const signs = new Set(opportunityDeltas.map((delta) => delta > 0 ? 'single' : delta < 0 ? 'dual' : 'tie'));
    const singleExecutionMs = median(single.map((entry) => entry.executionWallMs));
    const dualExecutionMs = median(dual.map((entry) => entry.executionWallMs));
    const cleanPrepareMs = median(dual.map((entry) => entry.codePrepareWallMs));
    const drainCaseCount = Math.max(0, entries[0]!.outputJson.length - 1);
    const executionSavings = singleExecutionMs - dualExecutionMs;
    const savingsPerDrainCase =
      drainCaseCount > 0 ? executionSavings / drainCaseCount : 0;
    summaries.push({
      problem,
      caseCount: entries[0]!.outputJson.length,
      iterationDeltasMs: deltas,
      iterationOpportunityDeltasMs: opportunityDeltas,
      stableSign: signs.size === 1 ? [...signs][0]! : 'unstable',
      singleDecisionMs: median(single.map((entry) => entry.decisionWallMs)),
      dualDecisionMs: median(dual.map((entry) => entry.decisionWallMs)),
      dualMinusSingleDecisionMs:
        median(dual.map((entry) => entry.decisionWallMs)) -
        median(single.map((entry) => entry.decisionWallMs)),
      dualMinusSingleOpportunityMs:
        median(opportunityDeltas),
      singleExecutionMs,
      dualExecutionMs,
      singleMinusDualExecutionMs: executionSavings,
      cleanPrepareMs,
      drainCaseCount,
      cleanExecutionSavingsPerDrainCaseMs: savingsPerDrainCase,
      crossoverDrainCases:
        savingsPerDrainCase > 0
          ? Math.ceil(cleanPrepareMs / savingsPerDrainCase)
          : null,
    });
  }
  return summaries;
}

function corpusSummary(summaries: readonly PairSummary[], attempted: number, cases: number, failures: readonly Failure[]) {
  const deltas = summaries.map((summary) => summary.dualMinusSingleOpportunityMs);
  const rawDecisionDeltas = summaries.map((summary) => summary.dualMinusSingleDecisionMs);
  const singleTotal = summaries.reduce((total, entry) => total + entry.singleDecisionMs, 0);
  const dualTotal = summaries.reduce((total, entry) => total + entry.dualDecisionMs, 0);
  const bestTotal = summaries.reduce((total, entry) => total + Math.min(entry.singleDecisionMs, entry.dualDecisionMs), 0);
  const singleOpportunityTotal = summaries.reduce(
    (total, entry) => total + entry.singleExecutionMs,
    0
  );
  const dualOpportunityTotal = summaries.reduce(
    (total, entry) => total + entry.cleanPrepareMs + entry.dualExecutionMs,
    0
  );
  const bestOpportunityTotal = summaries.reduce(
    (total, entry) => total + Math.min(
      entry.singleExecutionMs,
      entry.cleanPrepareMs + entry.dualExecutionMs
    ),
    0
  );
  return {
    attemptedProblems: attempted,
    completedProblems: summaries.length,
    failedProblems: failures.length,
    attemptedCases: cases,
    completedCases: summaries.reduce((total, entry) => total + entry.caseCount, 0),
    singleWins: deltas.filter((delta) => delta > 0).length,
    dualWins: deltas.filter((delta) => delta < 0).length,
    ties: deltas.filter((delta) => delta === 0).length,
    stableSingleWins: summaries.filter((entry) => entry.stableSign === 'single').length,
    stableDualWins: summaries.filter((entry) => entry.stableSign === 'dual').length,
    unstable: summaries.filter((entry) => entry.stableSign === 'unstable').length,
    singleDecisionTotalMs: singleTotal,
    dualDecisionTotalMs: dualTotal,
    dualMinusSingleTotalMs: dualTotal - singleTotal,
    dualOverheadPercent: singleTotal > 0 ? ((dualTotal - singleTotal) / singleTotal) * 100 : 0,
    singleOpportunityTotalMs: singleOpportunityTotal,
    dualOpportunityTotalMs: dualOpportunityTotal,
    dualMinusSingleOpportunityTotalMs: dualOpportunityTotal - singleOpportunityTotal,
    dualOpportunityOverheadPercent: singleOpportunityTotal > 0
      ? ((dualOpportunityTotal - singleOpportunityTotal) / singleOpportunityTotal) * 100
      : 0,
    bestPerProblemTotalMs: bestTotal,
    adaptiveSavingsVsSingleMs: singleTotal - bestTotal,
    adaptiveSavingsVsSinglePercent: singleTotal > 0 ? ((singleTotal - bestTotal) / singleTotal) * 100 : 0,
    dualMinusSingleDecisionMs: {
      min: rawDecisionDeltas.length ? Math.min(...rawDecisionDeltas) : 0,
      p25: percentile(rawDecisionDeltas, 0.25),
      p50: percentile(rawDecisionDeltas, 0.5),
      p75: percentile(rawDecisionDeltas, 0.75),
      p90: percentile(rawDecisionDeltas, 0.9),
      p99: percentile(rawDecisionDeltas, 0.99),
      max: rawDecisionDeltas.length ? Math.max(...rawDecisionDeltas) : 0,
    },
    dualMinusSingleOpportunityMs: {
      min: deltas.length ? Math.min(...deltas) : 0,
      p25: percentile(deltas, 0.25),
      p50: percentile(deltas, 0.5),
      p75: percentile(deltas, 0.75),
      p90: percentile(deltas, 0.9),
      p99: percentile(deltas, 0.99),
      max: deltas.length ? Math.max(...deltas) : 0,
    },
    bestOpportunityTotalMs: bestOpportunityTotal,
    adaptiveOpportunitySavingsVsSingleMs:
      singleOpportunityTotal - bestOpportunityTotal,
    adaptiveOpportunitySavingsVsSinglePercent: singleOpportunityTotal > 0
      ? ((singleOpportunityTotal - bestOpportunityTotal) / singleOpportunityTotal) * 100
      : 0,
  };
}

async function main(): Promise<void> {
  const productRoot = resolve(option('product-root') ?? '/Users/obinnanwachukwu/Code/algoflow');
  const explicitAssetRoot = option('tracecc-assets');
  const packageRelease = explicitAssetRoot
    ? null
    : JSON.parse(
        await readFile(join(TRACECC_PACKAGE_RELEASE_ROOT, 'manifest.json'), 'utf8')
      ) as { consumerHash?: string };
  const assetRoot = resolve(
    explicitAssetRoot ?? join(TRACECC_PACKAGE_RELEASE_ROOT, packageRelease?.consumerHash ?? '')
  );
  const outPath = resolve(option('out') ?? 'reports/cpp-on-demand-tracing-corpus-paired-2026-08-08.json');
  const iterations = Number(option('iterations') ?? '2');
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new TypeError('--iterations must be a positive integer.');
  }
  if (!existsSync(join(assetRoot, 'tracecc-reactor.wasm'))) {
    throw new Error(`TraceCC asset tree not found at ${assetRoot}.`);
  }
  const traceccRuntime = JSON.parse(
    await readFile(join(assetRoot, 'tracecc-runtime-manifest.json'), 'utf8')
  ) as { contentHash?: string };
  const traceccHash = traceccRuntime.contentHash;
  if (!traceccHash || !/^[0-9a-f]{64}$/u.test(traceccHash)) {
    throw new Error(`TraceCC runtime manifest is invalid at ${assetRoot}.`);
  }
  if (packageRelease && packageRelease.consumerHash !== traceccHash) {
    throw new Error('TraceCC package and runtime manifests disagree.');
  }
  const corpus = await discoverCorpus(productRoot);
  const requested = option('problems')?.split(',').map((value) => value.trim()).filter(Boolean);
  const problems = requested?.length ? requested : corpus.problems;
  const fixtures = await Promise.all(problems.map((problem) => loadFixture(productRoot, problem)));
  const attemptedCases = fixtures.reduce((total, fixture) => total + fixture.cases.length, 0);
  const tempRoot = await mkdtemp(join(tmpdir(), 'cpp-on-demand-tracing-'));
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  const samples: RecordedSample[] = [];
  const failures: Failure[] = [];
  const completedProblems = new Set<string>();
  let warmMs = 0;

  const writeReport = async () => {
    const completedSamples = samples.filter((sample) => completedProblems.has(sample.problem));
    const summaries = summarize(completedSamples);
    await writeFile(outPath, `${JSON.stringify({
      schema: 'tracecode.cpp-on-demand-tracing-benchmark.v1',
      generatedAt: new Date().toISOString(),
      productRoot,
      tracecc: { contentHash: traceccHash, assetRoot },
      compilerPolicy: {
        artifactCacheEntries: 0,
        artifactCacheBytes: 0,
        maxCompilesPerWorker: 64,
      },
      traceOptions: TRACE_OPTIONS,
      iterations,
      corpus,
      requestedProblems: problems,
      warmMs,
      completedProblems: [...completedProblems],
      failures,
      samples,
      summaries,
      corpusSummary: corpusSummary(summaries, fixtures.length, attemptedCases, failures),
    }, null, 2)}\n`, 'utf8');
  };

  try {
    await runCommand(
      'node',
      ['--import', 'tsx', 'src/cli.ts', 'sync-assets', join(tempRoot, 'workers'), '--languages', 'cpp'],
      process.cwd()
    );
    await cp(assetRoot, join(tempRoot, 'tracecc'), { recursive: true, force: true });
    await build({
      entryPoints: [resolve('tests/fixtures/cpp-on-demand-tracing-benchmark-entry.ts')],
      outfile: join(tempRoot, 'cpp-on-demand-tracing.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      tsconfig: resolve('tsconfig.base.json'),
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n', 'utf8');
    server = await startStaticServer(tempRoot);
    const integrity = await compilerIntegrity(assetRoot, server.origin);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(600_000);
      page.on('pageerror', (error) => console.error(`[browser pageerror] ${error.stack ?? error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') console.error(`[browser console] ${message.text()}`);
      });
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
      warmMs = await page.evaluate(async ({ integrity: browserIntegrity }) => {
        const benchmarkModuleUrl = '/cpp-on-demand-tracing.mjs';
        await import(benchmarkModuleUrl);
        if (!globalThis.initializeCppOnDemandTracing) {
          throw new Error('C++ benchmark initializer was not installed.');
        }
        return (await globalThis.initializeCppOnDemandTracing(browserIntegrity)).warmMs;
      }, { integrity });
      console.log(`TraceCC ${traceccHash.slice(0, 12)} warmed across all PCH lanes in ${formatMs(warmMs)}.`);

      for (let fixtureIndex = 0; fixtureIndex < fixtures.length; fixtureIndex += 1) {
        const fixture = fixtures[fixtureIndex]!;
        console.log(`[${fixtureIndex + 1}/${fixtures.length}] ${fixture.problem} (${fixture.cases.length} cases)`);
        let failed = false;
        for (let iteration = 0; iteration < iterations && !failed; iteration += 1) {
          const order: CppOnDemandSample['strategy'][] = iteration % 2 === 0
            ? ['single-instrumented', 'dual-artifact']
            : ['dual-artifact', 'single-instrumented'];
          for (let orderIndex = 0; orderIndex < order.length; orderIndex += 1) {
            const strategy = order[orderIndex]!;
            try {
              const sample = await page.evaluate(
                async ({ browserFixture, browserStrategy, traceOptions }) => {
                  if (!globalThis.runCppOnDemandTracingSample) {
                    throw new Error('C++ benchmark sample function was not installed.');
                  }
                  return globalThis.runCppOnDemandTracingSample(
                    browserFixture,
                    browserStrategy,
                    0,
                    traceOptions
                  );
                },
                { browserFixture: fixture, browserStrategy: strategy, traceOptions: TRACE_OPTIONS }
              );
              samples.push({ ...sample, iteration, order: orderIndex });
              await writeReport();
            } catch (error) {
              const message = error instanceof Error ? error.stack ?? error.message : String(error);
              failures.push({ problem: fixture.problem, iteration, strategy, error: message });
              console.error(`  FAILED ${strategy} iteration ${iteration + 1}: ${message.split('\n')[0]}`);
              failed = true;
              await writeReport();
              break;
            }
          }
        }
        if (!failed) {
          const entries = samples.filter((sample) => sample.problem === fixture.problem);
          try {
            const summary = summarize(entries)[0];
            if (!summary) throw new Error(`${fixture.problem}: paired samples are incomplete.`);
            completedProblems.add(fixture.problem);
            console.log(
              `  ${summary.dualMinusSingleOpportunityMs >= 0 ? 'one' : 'dual'} wins sunk-cost decision by ` +
              `${formatMs(Math.abs(summary.dualMinusSingleOpportunityMs))}; ` +
              `iterations ${summary.iterationOpportunityDeltasMs.map((delta) => `${delta >= 0 ? '+' : ''}${Math.round(delta)}`).join(', ')}ms ` +
              `(${summary.stableSign})`
            );
          } catch (error) {
            const message = error instanceof Error ? error.stack ?? error.message : String(error);
            failures.push({ problem: fixture.problem, error: message });
            console.error(`  FAILED invariant: ${message.split('\n')[0]}`);
          }
        }
        await writeReport();
      }
      await page.evaluate(() => globalThis.disposeCppOnDemandTracing?.());
    } finally {
      await browser.close();
    }

    const summaries = summarize(samples.filter((sample) => completedProblems.has(sample.problem)));
    const summary = corpusSummary(summaries, fixtures.length, attemptedCases, failures);
    console.log('\nC++ full-corpus on-demand tracing');
    console.log(
      `coverage: ${summary.completedProblems}/${summary.attemptedProblems} problems, ` +
      `${summary.completedCases}/${summary.attemptedCases} cases (${summary.failedProblems} failures)`
    );
    console.log(
      `winners: one artifact ${summary.singleWins}, dual artifact ${summary.dualWins}, ties ${summary.ties}; ` +
      `stable one ${summary.stableSingleWins}, stable dual ${summary.stableDualWins}, unstable ${summary.unstable}`
    );
    console.log(
      `totals: one ${formatMs(summary.singleDecisionTotalMs)}, dual ${formatMs(summary.dualDecisionTotalMs)}, ` +
      `dual overhead ${formatMs(summary.dualMinusSingleTotalMs)} (${summary.dualOverheadPercent.toFixed(1)}%)`
    );
    console.log(
      `sunk-cost opportunity: one ${formatMs(summary.singleOpportunityTotalMs)}, ` +
      `dual ${formatMs(summary.dualOpportunityTotalMs)}, ` +
      `dual overhead ${formatMs(summary.dualMinusSingleOpportunityTotalMs)} ` +
      `(${summary.dualOpportunityOverheadPercent.toFixed(1)}%)`
    );
    console.log(
      `adaptive opportunity savings vs one: ${formatMs(summary.adaptiveOpportunitySavingsVsSingleMs)} ` +
      `(${summary.adaptiveOpportunitySavingsVsSinglePercent.toFixed(2)}%)`
    );
    console.log(`Wrote ${outPath}`);
  } finally {
    await writeReport().catch(() => undefined);
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

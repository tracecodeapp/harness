#!/usr/bin/env node
/**
 * Java on-demand tracing strategy experiment.
 *
 * This intentionally bypasses Judge and the prepared-provider facade. It uses
 * JavaWorkerClient directly so both strategies exercise the real browser
 * Worker, TraceJVM, compiler, generated classes, and fresh-case isolation while
 * excluding comparison, policy, TraceKernel Judge planning, and receipt work.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from '../tests/example-app-smoke';
import type {
  JavaOnDemandCalibration,
  JavaOnDemandFixture,
  JavaOnDemandSample,
} from '../tests/fixtures/java-on-demand-tracing-benchmark-entry';

const DEFAULT_PROBLEMS = [
  'two-sum',
  'coin-change',
  'binary-tree-inorder-traversal',
] as const;

const TRACE_OPTIONS = {
  maxTraceSteps: 4_000,
  maxLineEvents: 20_000,
  maxSingleLineHits: 4_000,
  maxStoredEvents: Number(option('max-stored-events') ?? '16000'),
  traceProfile: process.argv.includes('--trace-profile'),
};

interface RecordedSample extends JavaOnDemandSample {
  readonly iteration: number;
  readonly order: number;
}

interface PairSummary {
  readonly problem: string;
  readonly selectedCaseId: string;
  readonly selectedIndex: number;
  readonly iterations: number;
  readonly singleDecisionMs: number;
  readonly dualDecisionMs: number;
  readonly dualMinusSingleDecisionMs: number;
  readonly singleExecutionMs: number;
  readonly dualExecutionMs: number;
  readonly singleMinusDualExecutionMs: number;
  readonly cleanPrepareMs: number;
  readonly singleWorkers: number;
  readonly dualWorkers: number;
  readonly singleRunnerProcesses: number;
  readonly dualRunnerProcesses: number;
}

interface CorpusFailure {
  readonly problem: string;
  readonly error: string;
}

interface CorpusSummary {
  readonly attemptedProblems: number;
  readonly completedProblems: number;
  readonly failedProblems: number;
  readonly attemptedCases: number;
  readonly completedCases: number;
  readonly singleWins: number;
  readonly dualWins: number;
  readonly ties: number;
  readonly singleDecisionTotalMs: number;
  readonly dualDecisionTotalMs: number;
  readonly bestPerProblemTotalMs: number;
  readonly adaptiveSavingsVsSingleMs: number;
  readonly adaptiveSavingsVsSinglePercent: number;
  readonly dualMinusSingleDecisionMs: {
    readonly min: number;
    readonly p25: number;
    readonly p50: number;
    readonly p75: number;
    readonly p90: number;
    readonly p99: number;
    readonly max: number;
  };
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function csv(raw: string | undefined, fallback: readonly string[]): string[] {
  if (!raw) return [...fallback];
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? values : [...fallback];
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
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  );
  return sorted[index] ?? 0;
}

function formatMs(value: number): string {
  return value >= 10_000
    ? `${(value / 1_000).toFixed(2)}s`
    : `${Math.round(value)}ms`;
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
    case '.jar':
      return 'application/java-archive';
    default:
      return 'application/octet-stream';
  }
}

async function startStaticServer(root: string): Promise<{
  readonly origin: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const candidate = normalize(
      join(root, decodeURIComponent(requestUrl.pathname))
    );
    if (!candidate.startsWith(`${normalize(root)}${sep}`) && candidate !== root) {
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
    throw new Error('Unable to resolve Java benchmark server address.');
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

async function loadFixtures(
  productRoot: string,
  problems: readonly string[],
  maxCases: number | undefined
): Promise<JavaOnDemandFixture[]> {
  const fixtures: JavaOnDemandFixture[] = [];
  for (const problem of problems) {
    const definition = JSON.parse(
      await readFile(
        resolve(productRoot, 'data', 'problems', `${problem}.json`),
        'utf8'
      )
    ) as {
      functionName: string;
      executionStyle?: 'function' | 'solution-method' | 'ops-class';
      testCases: Array<{
        id: string;
        input: Record<string, unknown>;
      }>;
    };
    const code = await readFile(
      resolve(
        productRoot,
        'data',
        'reference-solutions',
        'java',
        'practice',
        `${problem}.java`
      ),
      'utf8'
    );
    const cases = maxCases === undefined
      ? definition.testCases
      : definition.testCases.slice(0, maxCases);
    fixtures.push({
      problem,
      code,
      functionName: definition.functionName,
      ...(definition.executionStyle
        ? { executionStyle: definition.executionStyle }
        : {}),
      cases: cases.map((testCase) => ({
        id: testCase.id,
        input: testCase.input,
      })),
    });
  }
  return fixtures;
}

async function discoverJavaCorpus(productRoot: string): Promise<{
  readonly problems: string[];
  readonly problemDefinitions: number;
  readonly javaSolutions: number;
  readonly missingJavaSolutions: string[];
  readonly missingProblemDefinitions: string[];
}> {
  const problemNames = (await readdir(resolve(productRoot, 'data', 'problems')))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
  const solutionNames = (await readdir(
    resolve(productRoot, 'data', 'reference-solutions', 'java', 'practice')
  ))
    .filter((name) => name.endsWith('.java'))
    .map((name) => name.slice(0, -'.java'.length))
    .sort();
  const problemSet = new Set(problemNames);
  const solutionSet = new Set(solutionNames);
  return {
    problems: problemNames.filter((name) => solutionSet.has(name)),
    problemDefinitions: problemNames.length,
    javaSolutions: solutionNames.length,
    missingJavaSolutions: problemNames.filter((name) => !solutionSet.has(name)),
    missingProblemDefinitions: solutionNames.filter((name) => !problemSet.has(name)),
  };
}

function assertSameOutputs(
  single: JavaOnDemandSample,
  dual: JavaOnDemandSample
): void {
  if (single.outputJson.length !== dual.outputJson.length) {
    throw new Error(`${single.problem}: strategy output counts differ.`);
  }
  for (let index = 0; index < single.outputJson.length; index += 1) {
    if (single.outputJson[index] !== dual.outputJson[index]) {
      throw new Error(
        `${single.problem} case ${index}: single and dual outputs differ.\n` +
          `single=${single.outputJson[index]}\n` +
          `dual=${dual.outputJson[index]}`
      );
    }
  }
}

function summarizePairs(samples: readonly RecordedSample[]): PairSummary[] {
  const groups = new Map<string, RecordedSample[]>();
  for (const sample of samples) {
    const key = `${sample.problem}\0${sample.selectedCaseId}`;
    const entries = groups.get(key) ?? [];
    entries.push(sample);
    groups.set(key, entries);
  }

  const summaries: PairSummary[] = [];
  for (const entries of groups.values()) {
    const single = entries.filter(
      (sample) => sample.strategy === 'single-instrumented'
    );
    const dual = entries.filter(
      (sample) => sample.strategy === 'dual-artifact'
    );
    const pairedIterations = [...new Set(entries.map((sample) => sample.iteration))]
      .flatMap((iteration) => {
        const singleSample = single.find((sample) => sample.iteration === iteration);
        const dualSample = dual.find((sample) => sample.iteration === iteration);
        return singleSample && dualSample
          ? [{ single: singleSample, dual: dualSample }]
          : [];
      });
    for (const pair of pairedIterations) assertSameOutputs(pair.single, pair.dual);

    if (pairedIterations.length === 0) continue;
    const singleDecisionMs = median(single.map((sample) => sample.decisionWallMs));
    const dualDecisionMs = median(dual.map((sample) => sample.decisionWallMs));
    const singleExecutionMs = median(single.map((sample) => sample.executionWallMs));
    const dualExecutionMs = median(dual.map((sample) => sample.executionWallMs));
    summaries.push({
      problem: entries[0]!.problem,
      selectedCaseId: entries[0]!.selectedCaseId,
      selectedIndex: entries[0]!.selectedIndex,
      iterations: pairedIterations.length,
      singleDecisionMs,
      dualDecisionMs,
      dualMinusSingleDecisionMs: dualDecisionMs - singleDecisionMs,
      singleExecutionMs,
      dualExecutionMs,
      singleMinusDualExecutionMs: singleExecutionMs - dualExecutionMs,
      cleanPrepareMs: median(dual.map((sample) => sample.codePrepareWallMs)),
      singleWorkers: median(single.map((sample) => sample.createdWorkerCount)),
      dualWorkers: median(dual.map((sample) => sample.createdWorkerCount)),
      singleRunnerProcesses: median(
        single.map((sample) => sample.runnerProcessCount)
      ),
      dualRunnerProcesses: median(
        dual.map((sample) => sample.runnerProcessCount)
      ),
    });
  }
  return summaries;
}

function summarizeCorpus(
  fixtures: readonly JavaOnDemandFixture[],
  completedProblems: ReadonlySet<string>,
  summaries: readonly PairSummary[],
  failures: readonly CorpusFailure[]
): CorpusSummary {
  const completedSummaries = summaries.filter((summary) =>
    completedProblems.has(summary.problem)
  );
  const singleTotal = completedSummaries.reduce(
    (total, summary) => total + summary.singleDecisionMs,
    0
  );
  const dualTotal = completedSummaries.reduce(
    (total, summary) => total + summary.dualDecisionMs,
    0
  );
  const bestTotal = completedSummaries.reduce(
    (total, summary) =>
      total + Math.min(summary.singleDecisionMs, summary.dualDecisionMs),
    0
  );
  const deltas = completedSummaries.map(
    (summary) => summary.dualMinusSingleDecisionMs
  );
  const adaptiveSavings = singleTotal - bestTotal;
  return {
    attemptedProblems: fixtures.length,
    completedProblems: completedSummaries.length,
    failedProblems: failures.length,
    attemptedCases: fixtures.reduce(
      (total, fixture) => total + fixture.cases.length,
      0
    ),
    completedCases: fixtures.reduce(
      (total, fixture) =>
        total + (completedProblems.has(fixture.problem) ? fixture.cases.length : 0),
      0
    ),
    singleWins: deltas.filter((delta) => delta > 0).length,
    dualWins: deltas.filter((delta) => delta < 0).length,
    ties: deltas.filter((delta) => delta === 0).length,
    singleDecisionTotalMs: singleTotal,
    dualDecisionTotalMs: dualTotal,
    bestPerProblemTotalMs: bestTotal,
    adaptiveSavingsVsSingleMs: adaptiveSavings,
    adaptiveSavingsVsSinglePercent:
      singleTotal > 0 ? (adaptiveSavings / singleTotal) * 100 : 0,
    dualMinusSingleDecisionMs: {
      min: deltas.length > 0 ? Math.min(...deltas) : 0,
      p25: percentile(deltas, 0.25),
      p50: percentile(deltas, 0.5),
      p75: percentile(deltas, 0.75),
      p90: percentile(deltas, 0.9),
      p99: percentile(deltas, 0.99),
      max: deltas.length > 0 ? Math.max(...deltas) : 0,
    },
  };
}

function assertSampleInvariants(sample: JavaOnDemandSample): void {
  if (sample.createdWorkerCount !== 1) {
    throw new Error(
      `${sample.problem}: ${sample.strategy} created ` +
        `${sample.createdWorkerCount} outer Workers instead of one.`
    );
  }
  const expectedRunners = sample.strategy === 'single-instrumented' ? 1 : 2;
  if (sample.runnerProcessCount !== expectedRunners) {
    throw new Error(
      `${sample.problem}: ${sample.strategy} used ` +
        `${sample.runnerProcessCount} inner runners instead of ${expectedRunners}.`
    );
  }
}

function printSummary(
  calibrations: readonly JavaOnDemandCalibration[],
  summaries: readonly PairSummary[]
): void {
  console.log('\nJava direct-runner on-demand tracing\n');
  for (const calibration of calibrations) {
    console.log(
      `${calibration.problem}: calibrated heavy case ` +
        `${calibration.heavyIndex} (${formatMs(calibration.runMs[calibration.heavyIndex] ?? 0)})`
    );
  }
  console.log('');
  console.log(
    [
      'problem'.padEnd(32),
      'selected'.padStart(9),
      'single'.padStart(10),
      'dual'.padStart(10),
      'dual-single'.padStart(12),
      'single-dual'.padStart(11),
      'clean prep'.padStart(11),
      'workers'.padStart(9),
      'runners'.padStart(9),
    ].join(' ')
  );
  for (const summary of summaries) {
    console.log(
      [
        summary.problem.padEnd(32),
        summary.selectedCaseId.padStart(9),
        formatMs(summary.singleDecisionMs).padStart(10),
        formatMs(summary.dualDecisionMs).padStart(10),
        `${summary.dualMinusSingleDecisionMs >= 0 ? '+' : ''}${formatMs(summary.dualMinusSingleDecisionMs)}`.padStart(12),
        formatMs(summary.singleMinusDualExecutionMs).padStart(11),
        formatMs(summary.cleanPrepareMs).padStart(11),
        `${summary.singleWorkers}/${summary.dualWorkers}`.padStart(9),
        `${summary.singleRunnerProcesses}/${summary.dualRunnerProcesses}`.padStart(9),
      ].join(' ')
    );
  }
  console.log('\nPositive dual-single means the preferred one-artifact strategy is faster.');
  console.log('single-dual exec compares the complete one-runner mixed batch with the two-runner dual execution.');
}

function printCorpusSummary(
  summary: CorpusSummary,
  pairSummaries: readonly PairSummary[],
  failures: readonly CorpusFailure[]
): void {
  console.log('\nJava full-corpus on-demand tracing\n');
  console.log(
    `coverage: ${summary.completedProblems}/${summary.attemptedProblems} problems, ` +
      `${summary.completedCases}/${summary.attemptedCases} cases ` +
      `(${summary.failedProblems} failed problems)`
  );
  console.log(
    `winners: one artifact ${summary.singleWins}, dual artifact ` +
      `${summary.dualWins}, ties ${summary.ties}`
  );
  console.log(
    `suite totals: one ${formatMs(summary.singleDecisionTotalMs)}, ` +
      `dual ${formatMs(summary.dualDecisionTotalMs)}, ` +
      `best-per-problem ${formatMs(summary.bestPerProblemTotalMs)} ` +
      `(${summary.adaptiveSavingsVsSinglePercent.toFixed(2)}% saved vs one)`
  );
  const deltas = summary.dualMinusSingleDecisionMs;
  console.log(
    'dual-single distribution (ms): ' +
      `min ${Math.round(deltas.min)}, p25 ${Math.round(deltas.p25)}, ` +
      `p50 ${Math.round(deltas.p50)}, p75 ${Math.round(deltas.p75)}, ` +
      `p90 ${Math.round(deltas.p90)}, p99 ${Math.round(deltas.p99)}, ` +
      `max ${Math.round(deltas.max)}`
  );
  const dualWinners = pairSummaries
    .filter((entry) => entry.dualMinusSingleDecisionMs < 0)
    .sort(
      (left, right) =>
        left.dualMinusSingleDecisionMs - right.dualMinusSingleDecisionMs
    );
  if (dualWinners.length > 0) {
    console.log('dual-artifact winners:');
    for (const winner of dualWinners) {
      console.log(
        `  ${winner.problem}: ${formatMs(-winner.dualMinusSingleDecisionMs)} faster`
      );
    }
  }
  if (failures.length > 0) {
    console.log('failed problems:');
    for (const failure of failures) {
      console.log(`  ${failure.problem}: ${failure.error.split('\n')[0]}`);
    }
  }
}

async function main(): Promise<void> {
  const productRoot = resolve(
    option('product-root') ?? '/Users/obinnanwachukwu/Code/algoflow'
  );
  const traceJVMRoot = resolve(
    process.env.TRACECODE_TRACEJVM_ROOT ?? '../tracejvm'
  );
  const corpusMode = process.argv.includes('--corpus');
  const oneArtifactOnly = process.argv.includes('--one-artifact-only');
  const corpus = corpusMode ? await discoverJavaCorpus(productRoot) : undefined;
  const requestedProblems = option('problems');
  const problems = corpus
    ? (requestedProblems ? csv(requestedProblems, []) : corpus.problems)
    : csv(requestedProblems, DEFAULT_PROBLEMS);
  const iterations = Number(option('iterations') ?? (corpusMode ? 2 : 3));
  const crossoverProblem = option('crossover-problem') ?? 'coin-change';
  const crossoverCounts = csv(option('crossover-counts'), ['1', '2', '4', '6', '8'])
    .map(Number);
  const maxCasesRaw = option('max-cases');
  const maxCases = maxCasesRaw === undefined ? undefined : Number(maxCasesRaw);
  const outPath = option('out');
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new TypeError('--iterations must be a positive integer.');
  }
  if (
    maxCases !== undefined &&
    (!Number.isInteger(maxCases) || maxCases < 2)
  ) {
    throw new TypeError('--max-cases must be an integer of at least 2.');
  }
  if (crossoverCounts.some((count) => !Number.isInteger(count) || count < 1)) {
    throw new TypeError('--crossover-counts must contain positive integers.');
  }

  const fixtures = await loadFixtures(productRoot, problems, maxCases);
  const tempRoot = await mkdtemp(join(tmpdir(), 'java-on-demand-tracing-'));
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    await runCommand(
      'node',
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'sync-assets',
        join(tempRoot, 'workers'),
        '--languages',
        'java',
      ],
      process.cwd()
    );
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

    await build({
      entryPoints: [
        resolve('tests/fixtures/java-on-demand-tracing-benchmark-entry.ts'),
      ],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['es2022'],
      outfile: join(tempRoot, 'benchmark.js'),
      alias: {
        zlib: resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    });
    await writeFile(
      join(tempRoot, 'index.html'),
      '<!doctype html><meta charset="utf-8"><script src="/benchmark.js"></script>\n',
      'utf8'
    );
    server = await startStaticServer(resolve(tempRoot));

    const browser = await chromium.launch({ headless: true });
    const samples: RecordedSample[] = [];
    const calibrations: JavaOnDemandCalibration[] = [];
    const failures: CorpusFailure[] = [];
    const completedProblems = new Set<string>();
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(600_000);
      page.on('pageerror', (error) => {
        console.error(`[browser pageerror] ${error.stack ?? error.message}`);
      });
      page.on('console', (message) => {
        if (message.type() === 'error') {
          console.error(`[browser console] ${message.text()}`);
        }
      });
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });

      const runPairedSamples = async (
        fixture: JavaOnDemandFixture,
        selectedIndex: number
      ): Promise<void> => {
        for (let iteration = 0; iteration < iterations; iteration += 1) {
          const order: JavaOnDemandSample['strategy'][] = oneArtifactOnly
            ? ['single-instrumented']
            : iteration % 2 === 0
              ? ['single-instrumented', 'dual-artifact']
              : ['dual-artifact', 'single-instrumented'];
          for (let orderIndex = 0; orderIndex < order.length; orderIndex += 1) {
            const strategy = order[orderIndex]!;
            console.log(
              `  ${fixture.problem} selected=${fixture.cases[selectedIndex]!.id} ` +
                `iteration=${iteration + 1}/${iterations} ${strategy}`
            );
            const sample = await page.evaluate(
              async ({ pageFixture, pageStrategy, pageSelectedIndex, traceOptions }) => {
                if (!globalThis.runJavaOnDemandTracingSample) {
                  throw new Error('Java benchmark function was not installed.');
                }
                return globalThis.runJavaOnDemandTracingSample(
                  pageFixture,
                  pageStrategy,
                  pageSelectedIndex,
                  traceOptions
                );
              },
              {
                pageFixture: fixture,
                pageStrategy: strategy,
                pageSelectedIndex: selectedIndex,
                traceOptions: TRACE_OPTIONS,
              }
            );
            assertSampleInvariants(sample);
            samples.push({ ...sample, iteration, order: orderIndex });
          }
        }
      };

      const writeReport = async (): Promise<void> => {
        if (!outPath) return;
        const completedSamples = corpusMode
          ? samples.filter((sample) => completedProblems.has(sample.problem))
          : samples;
        const summaries = oneArtifactOnly
          ? []
          : summarizePairs(completedSamples);
        await writeFile(
          resolve(outPath),
          `${JSON.stringify({
            schema: 'tracecode.java-on-demand-tracing-benchmark.v2',
            generatedAt: new Date().toISOString(),
            productRoot,
            traceJVMRoot,
            traceOptions: TRACE_OPTIONS,
            mode: corpusMode ? 'corpus' : 'focused',
            oneArtifactOnly,
            iterations,
            crossoverProblem: corpusMode ? null : crossoverProblem,
            crossoverCounts: corpusMode ? [] : crossoverCounts,
            ...(corpus ? { corpus } : {}),
            calibrations,
            failures,
            completedProblems: [...completedProblems],
            samples,
            summaries,
            ...(corpusMode && !oneArtifactOnly
              ? {
                  corpusSummary: summarizeCorpus(
                    fixtures,
                    completedProblems,
                    summaries,
                    failures
                  ),
                }
              : {}),
          }, null, 2)}\n`,
          'utf8'
        );
      };

      for (const fixture of fixtures) {
        try {
          if (corpusMode) {
            console.log(
              `[${completedProblems.size + failures.length + 1}/${fixtures.length}] ` +
                `${fixture.problem} (${fixture.cases.length} cases)`
            );
            // The corpus study measures the product shape once per problem:
            // selected case first, followed by the complete drain. Running the
            // synthetic crossover sweep for every problem would multiply this
            // 200-problem study without answering another corpus question.
            await runPairedSamples(fixture, 0);
          } else {
            console.log(`Calibrating ${fixture.problem} (${fixture.cases.length} cases)`);
            const calibration = await page.evaluate(
              async ({ pageFixture, traceOptions }) => {
                if (!globalThis.calibrateJavaOnDemandTracing) {
                  throw new Error('Java calibration function was not installed.');
                }
                return globalThis.calibrateJavaOnDemandTracing(
                  pageFixture,
                  traceOptions
                );
              },
              { pageFixture: fixture, traceOptions: TRACE_OPTIONS }
            );
            calibrations.push(calibration);
            const selectedIndices = [...new Set([0, calibration.heavyIndex])];

            for (const selectedIndex of selectedIndices) {
              await runPairedSamples(fixture, selectedIndex);
            }

            if (fixture.problem === crossoverProblem) {
              const selectedCase = fixture.cases[0]!;
              const heavyCase = fixture.cases[calibration.heavyIndex]!;
              for (const count of crossoverCounts) {
                const crossoverFixture: JavaOnDemandFixture = {
                  ...fixture,
                  problem: `${fixture.problem} [${count}x guard-heavy drain]`,
                  cases: [
                    selectedCase,
                    ...Array.from({ length: count }, (_, index) => ({
                      id: `${heavyCase.id}#${index + 1}`,
                      input: heavyCase.input,
                    })),
                  ],
                };
                await runPairedSamples(crossoverFixture, 0);
              }
            }
          }
          completedProblems.add(fixture.problem);
        } catch (error) {
          if (!corpusMode) throw error;
          const message = error instanceof Error
            ? error.stack ?? error.message
            : String(error);
          failures.push({ problem: fixture.problem, error: message });
          console.error(`  FAILED: ${message.split('\n')[0]}`);
        } finally {
          await writeReport();
        }
      }
    } finally {
      await browser.close();
    }

    const completedSamples = corpusMode
      ? samples.filter((sample) => completedProblems.has(sample.problem))
      : samples;
    const summaries = oneArtifactOnly ? [] : summarizePairs(completedSamples);
    if (corpusMode && oneArtifactOnly) {
      const completedCases = fixtures.reduce(
        (total, fixture) =>
          total + (completedProblems.has(fixture.problem) ? fixture.cases.length : 0),
        0
      );
      const totalDecisionMs = completedSamples.reduce(
        (total, sample) => total + sample.decisionWallMs,
        0
      );
      const totalExecutionMs = completedSamples.reduce(
        (total, sample) => total + sample.executionWallMs,
        0
      );
      console.log('\nJava one-artifact full-corpus compatibility\n');
      console.log(
        `coverage: ${completedProblems.size}/${fixtures.length} problems, ` +
          `${completedCases}/${fixtures.reduce((sum, fixture) => sum + fixture.cases.length, 0)} cases ` +
          `(${failures.length} failed problems)`
      );
      console.log(
        `totals: decision ${formatMs(totalDecisionMs)}, execution ${formatMs(totalExecutionMs)}, ` +
          `execution average ${completedCases > 0 ? formatMs(totalExecutionMs / completedCases) : 'n/a'} per case`
      );
    } else if (corpusMode) {
      printCorpusSummary(
        summarizeCorpus(fixtures, completedProblems, summaries, failures),
        summaries,
        failures
      );
    } else {
      printSummary(calibrations, summaries);
    }
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

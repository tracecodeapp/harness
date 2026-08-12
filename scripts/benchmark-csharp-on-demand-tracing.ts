#!/usr/bin/env node
/** Direct C# prepared-runner experiment; intentionally bypasses Judge policy. */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from '../tests/example-app-smoke';
import type {
  CSharpOnDemandFixture,
  CSharpOnDemandSample,
} from '../tests/fixtures/csharp-on-demand-tracing-benchmark-entry';

const PRODUCT_ROOT = resolve(
  process.env.TRACECODE_PRODUCT_ROOT ?? '/Users/obinnanwachukwu/Code/algoflow'
);
const TRACE_OPTIONS = {
  maxTraceSteps: 4_000,
  maxLineEvents: 20_000,
  maxSingleLineHits: 4_000,
  maxStoredEvents: 16_000,
};

interface RecordedSample extends CSharpOnDemandSample {
  readonly iteration: number;
  readonly order: number;
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function pascalCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

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
      output[key] = key === '__id__' || key === '__ref__'
        ? reference(input[key])
        : visit(input[key]);
    }
    return output;
  };
  return JSON.stringify(visit(JSON.parse(encoded)));
}

function assertPair(single: RecordedSample, dual: RecordedSample): void {
  if (single.outputs.length !== dual.outputs.length) {
    throw new Error(`${single.problem}: strategy output lengths differ.`);
  }
  for (let index = 0; index < single.outputs.length; index += 1) {
    if (
      canonicalOutputJson(single.outputs[index]!) !==
      canonicalOutputJson(dual.outputs[index]!)
    ) {
      throw new Error(`${single.problem}: output ${index} differs between strategies.`);
    }
  }
  for (const sample of [single, dual]) {
    if (
      sample.eventCounts[0] === 0 ||
      sample.eventCounts.slice(1).some((count) => count !== 0)
    ) {
      throw new Error(`${sample.problem}: tracing was not limited to the selected case.`);
    }
    if (sample.createdCompilerWorkers > 1) {
      throw new Error(`${sample.problem}: compiler authority unexpectedly restarted ${sample.createdCompilerWorkers} times.`);
    }
    if (sample.createdRunnerWorkers !== sample.outputs.length) {
      throw new Error(
        `${sample.problem}: expected one isolated runner per case, got ${sample.createdRunnerWorkers}.`
      );
    }
    if (sample.runMs.some((value) => value === null)) {
      throw new Error(`${sample.problem}: managed runner timings are incomplete.`);
    }
  }
}

function contentType(pathname: string): string {
  const suffix = extname(pathname);
  if (suffix === '.html') return 'text/html; charset=utf-8';
  if (suffix === '.js' || suffix === '.mjs') return 'text/javascript; charset=utf-8';
  if (suffix === '.json') return 'application/json; charset=utf-8';
  if (suffix === '.wasm') return 'application/wasm';
  return 'application/octet-stream';
}

async function startServer(root: string): Promise<{
  readonly origin: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const candidate = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const path = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!path || !existsSync(path)) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentType(path),
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    createReadStream(path).pipe(response);
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('C# benchmark server did not bind a TCP port.');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((accept) => {
      server.close(() => accept());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }),
  };
}

async function problemNames(): Promise<string[]> {
  if (!process.argv.includes('--corpus')) {
    return (option('problems') ?? 'two-sum,coin-change,n-queens,open-the-lock')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }
  const solutionRoot = resolve(
    PRODUCT_ROOT,
    'data/reference-solutions/csharp/practice'
  );
  const names = (await readdir(solutionRoot))
    .filter((name) => name.endsWith('.cs'))
    .map((name) => name.slice(0, -3))
    .filter((name) => existsSync(resolve(PRODUCT_ROOT, 'data/problems', `${name}.json`)))
    .sort();
  const limit = Number(option('limit') ?? names.length);
  return names.slice(0, Math.max(0, limit));
}

async function loadFixture(problem: string): Promise<CSharpOnDemandFixture> {
  const definition = JSON.parse(
    await readFile(resolve(PRODUCT_ROOT, 'data/problems', `${problem}.json`), 'utf8')
  ) as {
    functionName: string;
    executionStyle?: 'function' | 'solution-method' | 'ops-class';
    testCases: Array<{ id: string; input: Record<string, unknown> }>;
  };
  const code = await readFile(
    resolve(
      PRODUCT_ROOT,
      'data/reference-solutions/csharp/practice',
      `${problem}.cs`
    ),
    'utf8'
  );
  const maxCases = Number(option('max-cases') ?? definition.testCases.length);
  return {
    problem,
    code,
    functionName: pascalCase(definition.functionName),
    executionStyle: definition.executionStyle ?? 'solution-method',
    cases: definition.testCases.slice(0, Math.max(1, maxCases)),
  };
}

function summarize(samples: readonly RecordedSample[]) {
  const summaries = [];
  for (const problem of [...new Set(samples.map((sample) => sample.problem))]) {
    const matching = samples.filter((sample) => sample.problem === problem);
    const single = matching.filter((sample) => sample.strategy === 'single-instrumented');
    const dual = matching.filter((sample) => sample.strategy === 'dual-artifact');
    if (single.length === 0 || dual.length === 0) continue;
    const opportunityDeltas = matching
      .map((sample) => sample.iteration)
      .filter((iteration, index, all) => all.indexOf(iteration) === index)
      .flatMap((iteration) => {
        const one = single.find((sample) => sample.iteration === iteration);
        const two = dual.find((sample) => sample.iteration === iteration);
        const oneDrainRunMs = one?.runMs.slice(1).reduce<number>(
          (total, value) => total + (value ?? 0),
          0
        );
        const twoDrainRunMs = two?.runMs.slice(1).reduce<number>(
          (total, value) => total + (value ?? 0),
          0
        );
        return one && two && oneDrainRunMs !== undefined && twoDrainRunMs !== undefined
          ? [two.codePrepareMs + twoDrainRunMs - oneDrainRunMs]
          : [];
      });
    const signs = new Set(
      opportunityDeltas.map((delta) => delta > 0 ? 'single' : delta < 0 ? 'dual' : 'tie')
    );
    const cleanPrepareMs = median(dual.map((sample) => sample.codePrepareMs));
    const singleDrainRunMs = median(single.map((sample) =>
      sample.runMs.slice(1).reduce<number>((total, value) => total + (value ?? 0), 0)
    ));
    const cleanDrainRunMs = median(dual.map((sample) =>
      sample.runMs.slice(1).reduce<number>((total, value) => total + (value ?? 0), 0)
    ));
    const singleDrainMs = median(single.map((sample) => sample.drainMs));
    const cleanDrainMs = median(dual.map((sample) => sample.drainMs));
    const drainCount = Math.max(0, (single[0]?.outputs.length ?? 1) - 1);
    const savingsPerCase = drainCount > 0
      ? (singleDrainRunMs - cleanDrainRunMs) / drainCount
      : 0;
    summaries.push({
      problem,
      caseCount: single[0]?.outputs.length ?? 0,
      stableSign: signs.size === 1 ? [...signs][0] : 'unstable',
      iterationOpportunityDeltasMs: opportunityDeltas,
      dualMinusSingleOpportunityMedianMs: median(opportunityDeltas),
      cleanPrepareMedianMs: cleanPrepareMs,
      singleDrainManagedMedianMs: singleDrainRunMs,
      cleanDrainManagedMedianMs: cleanDrainRunMs,
      singleDrainMedianMs: singleDrainMs,
      cleanDrainMedianMs: cleanDrainMs,
      crossoverDrainCases: savingsPerCase > 0
        ? Math.ceil(cleanPrepareMs / savingsPerCase)
        : null,
    });
  }
  return summaries;
}

async function main(): Promise<void> {
  const problems = await problemNames();
  const capabilityOnly = process.argv.includes('--capability');
  const iterations = Math.max(1, Number(option('iterations') ?? 2));
  const outPath = resolve(
    option('out') ?? 'reports/csharp-on-demand-tracing-focused-2026-08-08.json'
  );
  const tempRoot = await mkdtemp(join(tmpdir(), 'csharp-on-demand-tracing-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const samples: RecordedSample[] = [];
  const failures: Array<{ problem: string; error: string }> = [];
  const persist = async (): Promise<void> => {
    await mkdir(resolve(outPath, '..'), { recursive: true });
    await writeFile(outPath, `${JSON.stringify({
      schema: 'tracecode.csharp-on-demand-tracing-benchmark.v1',
      generatedAt: new Date().toISOString(),
      productRoot: PRODUCT_ROOT,
      traceOptions: TRACE_OPTIONS,
      iterations,
      capabilityOnly,
      attemptedProblems: problems.length,
      samples,
      failures,
      summaries: summarize(samples),
    }, null, 2)}\n`, 'utf8');
  };
  try {
    await runCommand(
      'node',
      ['--import', 'tsx', 'src/cli.ts', 'sync-assets', join(tempRoot, 'workers'), '--languages', 'csharp'],
      process.cwd()
    );
    await build({
      entryPoints: [resolve('tests/fixtures/csharp-on-demand-tracing-benchmark-entry.ts')],
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
    server = await startServer(tempRoot);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(300_000);
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
      for (let problemIndex = 0; problemIndex < problems.length; problemIndex += 1) {
        const problem = problems[problemIndex]!;
        try {
          const fixture = await loadFixture(problem);
          for (let iteration = 0; iteration < iterations; iteration += 1) {
            const order: CSharpOnDemandSample['strategy'][] = capabilityOnly
              ? ['single-instrumented']
              : iteration % 2 === 0
              ? ['single-instrumented', 'dual-artifact']
              : ['dual-artifact', 'single-instrumented'];
            const pair: RecordedSample[] = [];
            for (let orderIndex = 0; orderIndex < order.length; orderIndex += 1) {
              const strategy = order[orderIndex]!;
              const sample = await page.evaluate(
                async ({ fixture: input, strategy: selectedStrategy, traceOptions }) => {
                  if (!globalThis.runCSharpOnDemandTracingSample) {
                    throw new Error('C# benchmark entry did not initialize.');
                  }
                  return globalThis.runCSharpOnDemandTracingSample(
                    input,
                    selectedStrategy,
                    traceOptions
                  );
                },
                { fixture, strategy, traceOptions: TRACE_OPTIONS }
              );
              const recorded = { ...sample, iteration, order: orderIndex };
              samples.push(recorded);
              pair.push(recorded);
              console.log(
                `[${problemIndex + 1}/${problems.length}] ${problem} ${strategy}: ` +
                `prepare ${(sample.tracePrepareMs + sample.codePrepareMs).toFixed(1)}ms, ` +
                `selected ${sample.selectedLatencyMs.toFixed(1)}ms, drain ${sample.drainMs.toFixed(1)}ms, ` +
                `tiers ${sample.runnerTiers.join(',')}`
              );
            }
            const one = pair.find((sample) => sample.strategy === 'single-instrumented');
            const two = pair.find((sample) => sample.strategy === 'dual-artifact');
            if (capabilityOnly) {
              if (!one) throw new Error(`${problem}: missing one-artifact capability sample.`);
              if (
                one.eventCounts[0] === 0 ||
                one.eventCounts.slice(1).some((count) => count !== 0) ||
                one.runMs.some((value) => value === null)
              ) {
                throw new Error(`${problem}: one-artifact capability invariants failed.`);
              }
            } else {
              if (!one || !two) throw new Error(`${problem}: incomplete strategy pair.`);
              assertPair(one, two);
            }
            await persist();
          }
        } catch (reason) {
          const error = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
          failures.push({ problem, error });
          console.error(`[${problemIndex + 1}/${problems.length}] ${problem} FAILED: ${error.split('\n')[0]}`);
          await persist();
        }
      }
    } finally {
      await browser.close();
    }
    await persist();
    console.log(JSON.stringify({ summaries: summarize(samples), failures }, null, 2));
    console.log(`Wrote ${outPath}`);
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

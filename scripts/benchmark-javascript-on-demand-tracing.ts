#!/usr/bin/env npx tsx
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from '../tests/example-app-smoke';
import type {
  JavaScriptOnDemandFixture,
  JavaScriptOnDemandSample,
} from '../tests/fixtures/javascript-on-demand-tracing-benchmark-entry';

const PRODUCT_ROOT = resolve(
  process.env.TRACECODE_PRODUCT_ROOT ??
    '/Users/obinnanwachukwu/Code/algoflow'
);
const TRACE_OPTIONS = {
  maxTraceSteps: 4000,
  maxLineEvents: 20000,
  maxSingleLineHits: 4000,
  maxStoredEvents: 16000,
};

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function contentType(pathname: string): string {
  const suffix = extname(pathname);
  if (suffix === '.html') return 'text/html; charset=utf-8';
  if (suffix === '.js' || suffix === '.mjs') return 'text/javascript; charset=utf-8';
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
    });
    createReadStream(path).pipe(response);
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Benchmark server did not bind a TCP port.');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((accept) => {
        server.close(() => accept());
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      }),
  };
}

async function loadFixtures(
  problems: readonly string[]
): Promise<JavaScriptOnDemandFixture[]> {
  const fixtures: JavaScriptOnDemandFixture[] = [];
  for (const problem of problems) {
    const definition = JSON.parse(
      await readFile(resolve(PRODUCT_ROOT, 'data/problems', `${problem}.json`), 'utf8')
    ) as {
      functionName: string;
      executionStyle?: 'function' | 'solution-method' | 'ops-class';
      testCases: Array<{ id: string; input: Record<string, unknown> }>;
    };
    for (const language of ['javascript', 'typescript'] as const) {
      const extension = language === 'javascript' ? 'js' : 'ts';
      const code = await readFile(
        resolve(
          PRODUCT_ROOT,
          'data/reference-solutions',
          language,
          'practice',
          `${problem}.${extension}`
        ),
        'utf8'
      );
      fixtures.push({
        problem,
        language,
        code,
        functionName: definition.functionName,
        executionStyle: definition.executionStyle ?? 'solution-method',
        cases: definition.testCases,
      });
    }
  }
  return fixtures;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

async function main(): Promise<void> {
  const problems = (option('problems') ?? 'two-sum,n-queens,open-the-lock')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const iterations = Math.max(1, Number(option('iterations') ?? 3));
  const outPath = resolve(
    option('out') ?? 'reports/javascript-on-demand-tracing-focused-2026-08-08.json'
  );
  const fixtures = await loadFixtures(problems);
  const tempRoot = await mkdtemp(join(tmpdir(), 'javascript-on-demand-tracing-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
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
        'javascript,typescript',
      ],
      process.cwd()
    );
    await build({
      entryPoints: [
        resolve('tests/fixtures/javascript-on-demand-tracing-benchmark-entry.ts'),
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
    server = await startServer(tempRoot);
    const browser = await chromium.launch({ headless: true });
    const samples: Array<JavaScriptOnDemandSample & { iteration: number }> = [];
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(120_000);
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
      for (const fixture of fixtures) {
        for (let iteration = 0; iteration < iterations; iteration += 1) {
          const order: JavaScriptOnDemandSample['strategy'][] =
            iteration % 2 === 0
              ? ['single-artifact', 'dual-artifact']
              : ['dual-artifact', 'single-artifact'];
          for (const strategy of order) {
            const sample = await page.evaluate(
              async ({ fixture, strategy, traceOptions }) => {
                if (!globalThis.runJavaScriptOnDemandTracingSample) {
                  throw new Error('Benchmark entry did not initialize.');
                }
                return globalThis.runJavaScriptOnDemandTracingSample(
                  fixture,
                  strategy,
                  traceOptions
                );
              },
              { fixture, strategy, traceOptions: TRACE_OPTIONS }
            );
            if (
              sample.eventCounts[0] === 0 ||
              sample.eventCounts.slice(1).some((count) => count !== 0)
            ) {
              throw new Error(`${fixture.language}/${fixture.problem} selected the wrong traces.`);
            }
            const peer = samples.find(
              (candidate) =>
                candidate.problem === sample.problem &&
                candidate.language === sample.language &&
                candidate.iteration === iteration &&
                candidate.strategy !== sample.strategy
            );
            if (peer && JSON.stringify(peer.outputs) !== JSON.stringify(sample.outputs)) {
              throw new Error(`${fixture.language}/${fixture.problem} strategy outputs differ.`);
            }
            samples.push({ ...sample, iteration });
            console.log(
              `${fixture.language}/${fixture.problem} ${strategy} ` +
                `${sample.totalMs.toFixed(1)}ms (prepare ` +
                `${(sample.tracePrepareMs + sample.codePrepareMs).toFixed(1)}ms, ` +
                `selected ${sample.selectedLatencyMs.toFixed(1)}ms, drain ${sample.drainMs.toFixed(1)}ms)`
            );
          }
        }
      }
    } finally {
      await browser.close();
    }

    const summaries = fixtures.map((fixture) => {
      const matching = samples.filter(
        (sample) =>
          sample.problem === fixture.problem && sample.language === fixture.language
      );
      const singleMs = median(
        matching.filter((sample) => sample.strategy === 'single-artifact')
          .map((sample) => sample.totalMs)
      );
      const dualMs = median(
        matching.filter((sample) => sample.strategy === 'dual-artifact')
          .map((sample) => sample.totalMs)
      );
      const incrementalCodePrepareMs = median(
        matching.filter((sample) => sample.strategy === 'dual-artifact')
          .map((sample) => sample.codePrepareMs)
      );
      return {
        problem: fixture.problem,
        language: fixture.language,
        caseCount: fixture.cases.length,
        rawSingleTotalMedianMs: singleMs,
        rawDualTotalMedianMs: dualMs,
        incrementalCodePrepareMedianMs: incrementalCodePrepareMs,
        decision: 'single-artifact',
        decisionBasis:
          'Both strategies execute the same clean executable and materializers; dual preparation only repeats deterministic clean preparation. Raw drain clocks include fresh-Worker startup noise.',
      };
    });
    await mkdir(resolve(outPath, '..'), { recursive: true });
    await writeFile(
      outPath,
      `${JSON.stringify({
        schema: 'tracecode.javascript-on-demand-tracing-benchmark.v1',
        generatedAt: new Date().toISOString(),
        productRoot: PRODUCT_ROOT,
        traceOptions: TRACE_OPTIONS,
        iterations,
        samples,
        summaries,
      }, null, 2)}\n`,
      'utf8'
    );
    console.log(JSON.stringify(summaries, null, 2));
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

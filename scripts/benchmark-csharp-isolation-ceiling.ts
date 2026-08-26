import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from '../tests/example-app-smoke';

interface RunResult {
  readonly strategy: 'compatibility' | 'algorithm-fast';
  readonly caseCount: number;
  readonly elapsedMs: number;
  readonly workerCount: number;
  readonly maximumActiveWorkers: number;
  readonly verdict: string;
  readonly passedCases: number;
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.wasm': return 'application/wasm';
    default: return 'application/octet-stream';
  }
}

async function startServer(root: string): Promise<{
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
    const path = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!path || !existsSync(path)) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Length': String(statSync(path).size),
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
  if (!address || typeof address === 'string') throw new Error('No server address.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((accept) => server.close(() => accept())),
  };
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

async function main(): Promise<void> {
  const rounds = Number.parseInt(process.env.TRACECODE_CSHARP_BENCH_ROUNDS ?? '3', 10);
  const strategies = (process.env.TRACECODE_CSHARP_BENCH_STRATEGIES
    ?? 'compatibility,algorithm-fast').split(',') as Array<
      'compatibility' | 'algorithm-fast'
    >;
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-csharp-isolation-ceiling-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await runCommand('pnpm', [
      'exec', 'tsx', 'src/cli.ts', 'sync-assets', join(tempRoot, 'workers'),
      '--languages', 'csharp',
    ], process.cwd());
    await build({
      entryPoints: [resolve('tests/fixtures/csharp-isolation-ceiling-benchmark-entry.ts')],
      outfile: join(tempRoot, 'benchmark.mjs'),
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
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n');
    server = await startServer(resolve(tempRoot));
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(300_000);
      await page.goto(`${server.origin}/index.html`);
      const results = await page.evaluate(async ({ rounds: browserRounds, strategies: browserStrategies }) => {
        await import('/benchmark.mjs');
        if (!globalThis.runCSharpIsolationCeilingBenchmark) {
          throw new Error('Benchmark entry point missing.');
        }
        return globalThis.runCSharpIsolationCeilingBenchmark(
          '/workers',
          browserRounds,
          browserStrategies
        );
      }, { rounds, strategies }) as RunResult[];
      for (const result of results) {
        if (result.verdict !== 'passed' || result.passedCases !== result.caseCount) {
          throw new Error(`Incorrect benchmark result: ${JSON.stringify(result)}`);
        }
      }
      const summary = Array.from(
        Map.groupBy(results, (result) => `${result.strategy}:${result.caseCount}`)
      ).map(([key, samples]) => ({
        key,
        p50Ms: percentile(samples.map((sample) => sample.elapsedMs), 0.5),
        p95Ms: percentile(samples.map((sample) => sample.elapsedMs), 0.95),
        workerCounts: samples.map((sample) => sample.workerCount),
        maximumActiveWorkers: samples.map((sample) => sample.maximumActiveWorkers),
        samplesMs: samples.map((sample) => sample.elapsedMs),
      }));
      console.log(JSON.stringify({ rounds, results, summary }, null, 2));
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});


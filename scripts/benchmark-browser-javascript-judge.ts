#!/usr/bin/env npx tsx

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { build, type Plugin } from 'esbuild';
import {
  chromium,
  firefox,
  webkit,
  type BrowserType,
} from 'playwright';

type Engine = 'chromium' | 'firefox' | 'webkit';
type Variant = 'main-batch' | 'warm-retire';

const root = resolve(process.cwd());
const engines = (process.env.JAVASCRIPT_JUDGE_BENCH_ENGINES ?? 'chromium')
  .split(',')
  .map((value) => value.trim())
  .filter((value): value is Engine =>
    ['chromium', 'firefox', 'webkit'].includes(value)
  );
const samples = Number(process.env.JAVASCRIPT_JUDGE_BENCH_SAMPLES ?? 12);
const baselineRef =
  process.env.JAVASCRIPT_JUDGE_BENCH_BASELINE_REF ?? 'origin/main';
const batchPrewarmLimit = Number(
  process.env.JAVASCRIPT_JUDGE_BATCH_PREWARM_LIMIT ?? 8
);
const memoryOnly = process.env.JAVASCRIPT_JUDGE_BENCH_MEMORY_ONLY === '1';
const reportPath = resolve(
  process.env.JAVASCRIPT_JUDGE_BENCH_REPORT ??
    'reports/javascript-judge-warm-retire-2026-08-04.json'
);

const browserTypes: Record<Engine, BrowserType> = {
  chromium,
  firefox,
  webkit,
};

const baselineSources = new Set([
  'packages/runtime-javascript/src/browser-runtime-provider.ts',
  'packages/runtime-javascript/src/javascript-prepared-program.ts',
  'packages/runtime-javascript/src/javascript-worker-client.ts',
]);

function gitSource(path: string): string {
  return execFileSync('git', ['show', `${baselineRef}:${path}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function baselinePlugin(): Plugin {
  const byAbsolutePath = new Map(
    [...baselineSources].map((path) => [resolve(root, path), path])
  );
  return {
    name: 'javascript-judge-main-baseline',
    setup(buildApi) {
      buildApi.onLoad({ filter: /\.ts$/ }, (args) => {
        const repositoryPath = byAbsolutePath.get(resolve(args.path));
        if (!repositoryPath) return undefined;
        return {
          contents: gitSource(repositoryPath),
          loader: 'ts',
        };
      });
    },
  };
}

function candidateLimitPlugin(): Plugin {
  const clientPath = resolve(
    root,
    'packages/runtime-javascript/src/javascript-worker-client.ts'
  );
  return {
    name: 'javascript-judge-candidate-batch-limit',
    setup(buildApi) {
      buildApi.onLoad({ filter: /javascript-worker-client\.ts$/ }, async (args) => {
        if (resolve(args.path) !== clientPath) return undefined;
        const contents = await readFile(clientPath, 'utf8');
        return {
          contents: contents.replace(
            /const BATCH_PREWARM_LIMIT = \d+;/,
            `const BATCH_PREWARM_LIMIT = ${batchPrewarmLimit};`
          ),
          loader: 'ts',
        };
      });
    },
  };
}

const browserEntry = `
import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
} from './src/judge';

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function memorySnapshot() {
  const memory = performance.memory;
  return memory
    ? {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
      }
    : {};
}

export async function runJavaScriptJudgeBenchmark(options) {
  const NativeWorker = globalThis.Worker;
  const workerEvents = [];
  let nextWorkerId = 1;
  const liveWorkers = new Set();
  class ObservedWorker extends NativeWorker {
    constructor(url, workerOptions) {
      super(url, workerOptions);
      this.observedId = nextWorkerId++;
      liveWorkers.add(this.observedId);
      workerEvents.push({
        kind: 'created',
        id: this.observedId,
        atMs: performance.now(),
        url: String(url),
      });
    }
    terminate() {
      if (liveWorkers.delete(this.observedId)) {
        workerEvents.push({
          kind: 'terminated',
          id: this.observedId,
          atMs: performance.now(),
        });
      }
      super.terminate();
    }
  }
  globalThis.Worker = ObservedWorker;

  const host = createBrowserJudgeHost({
    providers: ['javascript', 'typescript'],
    assetBaseUrl: '/workers',
    safeExecution: { workerLifecycle: 'warm-and-retire' },
  });

  async function evaluate(language, caseCount, trace, marker) {
    const code = language === 'typescript'
      ? 'function solve(value: number): number { return value + 1; }'
      : 'function solve(value) { return value + 1; }';
    const bundleStartedAt = performance.now();
    const bundle = await createAlgorithmJudgeBundle({
      id: language + '-' + caseCount + '-' + trace + '-' + marker,
      language,
      code,
      functionName: 'solve',
      trace,
      traceOptions: trace ? { maxTraceSteps: 1000 } : undefined,
      cases: Array.from({ length: caseCount }, (_, index) => ({
        id: 'case-' + (index + 1),
        input: { value: index },
        expected: index + 1,
      })),
    });
    const evaluateStartedAt = performance.now();
    const receipt = await host.evaluateAlgorithm({ bundle });
    const endedAt = performance.now();
    if (
      receipt.evaluation.status !== 'completed' ||
      receipt.passedCount !== caseCount ||
      receipt.totalCount !== caseCount
    ) {
      throw new Error(
        'Judge benchmark correctness failure: ' + JSON.stringify(receipt)
      );
    }
    return {
      bundleMs: evaluateStartedAt - bundleStartedAt,
      evaluateMs: endedAt - evaluateStartedAt,
      userFacingMs: endedAt - bundleStartedAt,
    };
  }

  async function isolationProbe(language) {
    const code = language === 'typescript'
      ? \`function probe(value: number): number | null {
  const previous = (Array.prototype as any).__tracecodeBenchmarkPoison ?? null;
  (Array.prototype as any).__tracecodeBenchmarkPoison = value;
  return previous;
}\`
      : \`function probe(value) {
  const previous = Array.prototype.__tracecodeBenchmarkPoison ?? null;
  Array.prototype.__tracecodeBenchmarkPoison = value;
  return previous;
}\`;
    const bundle = await createAlgorithmJudgeBundle({
      id: language + '-isolation-probe',
      language,
      code,
      functionName: 'probe',
      cases: [
        { id: 'first', input: { value: 1 }, expected: null },
        { id: 'second', input: { value: 2 }, expected: null },
      ],
    });
    const receipt = await host.evaluateAlgorithm({ bundle });
    return {
      passedCount: receipt.passedCount,
      totalCount: receipt.totalCount,
      status: receipt.evaluation.status,
      values:
        receipt.evaluation.status === 'completed'
          ? receipt.evaluation.cases.map((item) => item.value)
          : [],
    };
  }

  try {
    const warmups = {};
    const languages = options.memoryOnly
      ? ['javascript']
      : ['javascript', 'typescript'];
    for (const language of languages) {
      const startedAt = performance.now();
      warmups[language] = {
        ...(await host.warmLanguage(language)),
        wallMs: performance.now() - startedAt,
      };
    }
    const isolation = options.memoryOnly
      ? {}
      : {
          javascript: await isolationProbe('javascript'),
          typescript: await isolationProbe('typescript'),
        };
    const scenarios = [];
    for (const language of languages) {
      const definitions = options.memoryOnly
        ? [['batch-15', 15, false, 1]]
        : [
            ['single', 1, false, options.samples],
            ['batch-15', 15, false, options.samples],
            ['trace-15', 15, true, Math.max(4, Math.ceil(options.samples / 2))],
            ['batch-50', 50, false, Math.max(3, Math.ceil(options.samples / 4))],
          ];
      for (const [name, caseCount, trace, count] of definitions) {
        const records = [];
        for (let index = 0; index < count; index += 1) {
          records.push(
            await evaluate(language, caseCount, trace, name + '-' + index)
          );
        }
        const userFacing = records.map((record) => record.userFacingMs);
        const evaluateTimes = records.map((record) => record.evaluateMs);
        scenarios.push({
          language,
          name,
          caseCount,
          trace,
          sampleCount: records.length,
          p50UserFacingMs: percentile(userFacing, 0.5),
          p95UserFacingMs: percentile(userFacing, 0.95),
          p50EvaluateMs: percentile(evaluateTimes, 0.5),
          records,
        });
      }
    }
    const beforeDispose = {
      liveWorkers: liveWorkers.size,
      memory: memorySnapshot(),
    };
    host.dispose();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    return {
      warmups,
      isolation,
      scenarios,
      workerEvents,
      beforeDispose,
      afterDispose: {
        liveWorkers: liveWorkers.size,
        memory: memorySnapshot(),
      },
    };
  } finally {
    host.dispose();
    globalThis.Worker = NativeWorker;
  }
}
`;

async function prepareVariant(
  variant: Variant
): Promise<{ staticRoot: string; dispose(): Promise<void> }> {
  const staticRoot = await mkdtemp(
    join(tmpdir(), `tracecode-javascript-judge-${variant}-`)
  );
  const workersRoot = join(staticRoot, 'workers');
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsx',
      'src/cli.ts',
      'sync-assets',
      workersRoot,
      '--languages',
      'javascript,typescript',
    ],
    { cwd: root, stdio: 'ignore' }
  );
  if (variant === 'main-batch') {
    await writeFile(
      join(workersRoot, 'javascript-worker.js'),
      gitSource('workers/javascript/javascript-worker.js'),
      'utf8'
    );
  }
  await build({
    stdin: {
      contents: browserEntry,
      resolveDir: root,
      sourcefile: 'javascript-judge-benchmark-entry.ts',
      loader: 'ts',
    },
    outfile: join(staticRoot, 'benchmark.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    tsconfig: join(root, 'tsconfig.base.json'),
    alias: {
      zlib: join(
        root,
        'packages',
        'tracekernel',
        'src',
        'zlib-browser-shim.ts'
      ),
      'node:zlib': join(
        root,
        'packages',
        'tracekernel',
        'src',
        'zlib-browser-shim.ts'
      ),
    },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins:
      variant === 'main-batch'
        ? [baselinePlugin()]
        : batchPrewarmLimit === 8
          ? []
          : [candidateLimitPlugin()],
    logLevel: 'warning',
  });
  await writeFile(
    join(staticRoot, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>JavaScript Judge benchmark</title>',
    'utf8'
  );
  return {
    staticRoot,
    dispose: () => rm(staticRoot, { recursive: true, force: true }),
  };
}

function contentType(path: string): string {
  const suffix = extname(path);
  if (suffix === '.html') return 'text/html; charset=utf-8';
  if (suffix === '.js' || suffix === '.mjs') {
    return 'text/javascript; charset=utf-8';
  }
  return 'application/octet-stream';
}

function processTreeRssBytes(rootPid: number): number {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      (row): row is [number, number, number] =>
        row.length === 3 && row.every(Number.isFinite)
    );
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parentPid] of rows) {
      if (!descendants.has(pid) && descendants.has(parentPid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return (
    rows.reduce(
      (total, [pid, , rssKiB]) =>
        descendants.has(pid) ? total + rssKiB : total,
      0
    ) * 1024
  );
}

async function serve(staticRoot: string): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const path = resolve(staticRoot, decodeURIComponent(relative));
      if (!path.startsWith(`${staticRoot}/`) && path !== staticRoot) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const bytes = await readFile(path);
      response.writeHead(200, {
        'Content-Type': contentType(path),
        'Cache-Control': 'no-store',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      });
      response.end(bytes);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Benchmark server did not expose a TCP address.');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) =>
          error ? rejectClose(error) : resolveClose()
        )
      ),
  };
}

async function runVariant(
  variant: Variant,
  engine: Engine
): Promise<Record<string, unknown>> {
  const prepared = await prepareVariant(variant);
  const server = await serve(prepared.staticRoot);
  const browserServer = await browserTypes[engine].launchServer({
    headless: true,
  });
  const browser = await browserTypes[engine].connect(
    browserServer.wsEndpoint()
  );
  const browserPid = browserServer.process().pid;
  if (browserPid === undefined) {
    throw new Error(`${engine} browser server did not expose a process id.`);
  }
  let sampleProcessMemory = memoryOnly;
  const processMemorySamples: number[] = [];
  const memorySampler = (async () => {
    while (sampleProcessMemory) {
      processMemorySamples.push(
        processTreeRssBytes(browserPid)
      );
      await new Promise((resolveSample) => setTimeout(resolveSample, 20));
    }
  })();
  try {
    const page = await browser.newPage();
    await page.goto(server.origin);
    const result = await page.evaluate(
      async ({ sampleCount, memoryOnlyRun }) => {
        // @ts-expect-error Generated benchmark module is served by the fixture.
        const module = await import('/benchmark.mjs');
        return module.runJavaScriptJudgeBenchmark({
          samples: sampleCount,
          memoryOnly: memoryOnlyRun,
        });
      },
      { sampleCount: samples, memoryOnlyRun: memoryOnly }
    );
    sampleProcessMemory = false;
    await memorySampler;
    return {
      ...result,
      ...(processMemorySamples.length > 0
        ? {
            processMemory: {
              sampleCount: processMemorySamples.length,
              minTreeRssBytes: Math.min(...processMemorySamples),
              maxTreeRssBytes: Math.max(...processMemorySamples),
              settledTreeRssBytes: processMemorySamples.at(-1),
            },
          }
        : {}),
    };
  } finally {
    sampleProcessMemory = false;
    await memorySampler;
    await browser.close();
    await browserServer.close();
    await server.close();
    await prepared.dispose();
  }
}

async function main(): Promise<void> {
  const results: Record<string, unknown> = {};
  for (const engine of engines) {
    for (const variant of ['main-batch', 'warm-retire'] as const) {
      console.log(`Running ${engine} ${variant}...`);
      results[`${engine}:${variant}`] = await runVariant(variant, engine);
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    baseline: execFileSync('git', ['rev-parse', baselineRef], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    baselineRef,
    engines,
    samples,
    batchPrewarmLimit,
    memoryOnly,
    results,
  };
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${reportPath}`);
}

await main();

#!/usr/bin/env npx tsx
/**
 * Measure TraceHooks hot-path breakdown for one heavy Java coin-change case.
 */
import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from '../tests/example-app-smoke';

const PRODUCT_TRACE_BUDGET = {
  maxTraceSteps: 4000,
  maxLineEvents: 20000,
  maxSingleLineHits: 4000,
  maxStoredEvents: 16000,
  traceProfile: true,
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function startStaticServer(root: string) {
  const mime: Record<string, string> = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
    '.jar': 'application/java-archive',
    '.html': 'text/html',
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let relative = decodeURIComponent(url.pathname);
      if (relative.endsWith('/')) relative += 'index.html';
      const filePath = normalize(join(root, relative.slice(1)));
      if (!filePath.startsWith(root + sep) && filePath !== root) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(filePath);
      res.writeHead(200, {
        'content-type': mime[extname(filePath)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((resolveReady) =>
    server.listen(0, '127.0.0.1', resolveReady)
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind static server');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      }),
  };
}

function ms(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return '—';
  return `${((100 * part) / whole).toFixed(1)}%`;
}

async function main() {
  const productRoot = resolve(
    option('product-root') ?? '/Users/obinnanwachukwu/Code/algoflow'
  );
  const caseId = option('case') ?? 'g2';
  const outPath =
    option('out') ??
    resolve('reports', `java-trace-profile-${caseId}.json`);

  const problem = JSON.parse(
    await readFile(
      resolve(productRoot, 'data/problems/coin-change.json'),
      'utf8'
    )
  ) as {
    functionName: string;
    executionStyle?: 'function' | 'solution-method';
    testCases: Array<{
      id: string;
      input: Record<string, unknown>;
      expected: unknown;
    }>;
  };
  const testCase = problem.testCases.find((entry) => entry.id === caseId);
  if (!testCase) throw new Error(`case ${caseId} not found`);
  const code = await readFile(
    resolve(
      productRoot,
      'data/reference-solutions/java/practice/coin-change.java'
    ),
    'utf8'
  );

  const tempRoot = await mkdtemp(
    join(tmpdir(), 'tracecode-java-trace-profile-')
  );
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    await runCommand(
      'pnpm',
      [
        'exec',
        'tsx',
        'src/cli.ts',
        'sync-assets',
        join(tempRoot, 'workers'),
        '--languages',
        'java',
      ],
      process.cwd()
    );
    const traceJVMRoot = resolve(
      process.env.TRACECODE_TRACEJVM_ROOT ?? '../tracejvm'
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
        resolve('tests/fixtures/background-tracing-benchmark-entry.ts'),
      ],
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
    await writeFile(
      join(tempRoot, 'index.html'),
      '<!doctype html><meta charset="utf-8">\n',
      'utf8'
    );
    server = await startStaticServer(tempRoot);

    const fixture = {
      language: 'java' as const,
      problem: 'coin-change',
      code,
      functionName: problem.functionName,
      ...(problem.executionStyle
        ? { executionStyle: problem.executionStyle }
        : {}),
      cases: [
        {
          id: testCase.id,
          input: testCase.input,
          expected: testCase.expected,
        },
      ],
    };

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(600_000);
      page.on('pageerror', (error) => {
        console.error(`[browser pageerror] ${error.stack ?? error.message}`);
      });
      page.on('console', (message) => {
        if (message.type() === 'error') {
          console.error(`[browser console] ${message.text()}`);
        } else if (message.text().includes('__TRACECODE_HOSTPROF__')) {
          console.log(message.text());
        }
      });
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });

      console.log(
        `Profiling java / coin-change / ${caseId} (amount=${testCase.input.amount})…`
      );
      const [result] = (await page.evaluate(
        async ({ fixture: pageFixture, traceOptions }) => {
          const module = await import('/background-tracing.mjs');
          return module.runBackgroundTracingBenchmark(
            '/workers',
            [pageFixture],
            {
              traceOptions,
              skipTraceAll: true,
            }
          );
        },
        { fixture, traceOptions: PRODUCT_TRACE_BUDGET }
      )) as Array<{
        language: string;
        problem: string;
        warmMs?: number;
        perCaseCodeMs: number[];
        perCaseTraceMs: number[];
        perCaseVerdicts: string[];
        perCaseProfiles?: Array<Record<string, unknown> | null>;
        error?: string;
      }>;

      const profile = result?.perCaseProfiles?.[0] ?? null;
      const report = {
        generatedAt: new Date().toISOString(),
        caseId,
        input: testCase.input,
        expected: testCase.expected,
        result,
        profile,
      };
      await mkdir(resolve(outPath, '..'), { recursive: true });
      await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);

      if (result?.error) {
        console.error(`ERROR: ${result.error}`);
        process.exitCode = 1;
        return;
      }

      const wallCode = Math.round(result.perCaseCodeMs[0] ?? 0);
      const wallTrace = Math.round(result.perCaseTraceMs[0] ?? 0);
      console.log(
        `\nWall clock: code=${wallCode}ms trace=${wallTrace}ms verdict=${result.perCaseVerdicts[0]}`
      );

      if (!profile) {
        console.log('No TraceHooks profile in case stdout.');
        console.log(`Wrote ${outPath}`);
        process.exitCode = 1;
        return;
      }

      const total = ms(profile.totalMs);
      const serialize = ms(profile.serializeMs);
      const emitBuild = ms(profile.emitBuildMs);
      const store = ms(profile.storeMs);
      const attributed = serialize + emitBuild + store;
      const residual = Math.max(0, total - attributed);
      const before = ms(profile.beforeBudgetMs);
      const after = ms(profile.afterBudgetMs);
      const overhead = Math.max(0, wallTrace - total);

      console.log('\nTraceHooks profile (nanoTime inside TraceJVM):');
      console.log(`  totalMs            ${total.toFixed(2)}ms`);
      console.log(
        `  beforeBudgetMs     ${before.toFixed(2)}ms  (${pct(before, total)})`
      );
      console.log(
        `  afterBudgetMs      ${after.toFixed(2)}ms  (${pct(after, total)})`
      );
      console.log(
        `  serializeMs        ${serialize.toFixed(2)}ms  (${pct(serialize, total)})  calls=${profile.serializeCalls} cacheHits=${profile.serializeCacheHits} chars=${profile.serializeChars}`
      );
      console.log(
        `  emitBuildMs        ${emitBuild.toFixed(2)}ms  (${pct(emitBuild, total)})  calls=${profile.emitBuildCalls}`
      );
      console.log(
        `  storeMs            ${store.toFixed(2)}ms  (${pct(store, total)})  events=${profile.storedEvents} chars=${profile.storedChars}`
      );
      console.log(
        `  residual (other)   ${residual.toFixed(2)}ms  (${pct(residual, total)})  ← hook glue / interpreter outside timed regions`
      );
      console.log(
        `  wall − profile     ${overhead.toFixed(0)}ms  ← prepare/JVM/host outside TraceHooks.run`
      );
      console.log(
        `  hooks: length=${profile.lengthCalls} line=${profile.lineCalls} snapshot=${profile.snapshotCalls} readArray=${profile.readArrayCalls} (earlyExit=${profile.readArrayEarlyExits}) writeArray=${profile.writeArrayCalls} scalarWrite=${profile.scalarWriteCalls} dropFast=${profile.dropFastPathCalls}`
      );
      console.log(
        `  budgetAbortFallbacks=${profile.budgetAbortFallbacks} abortTailMs=${profile.budgetAbortFallbackMs}`
      );
      console.log(
        `  exportMs=${profile.exportMs ?? '—'} hostParseMs=${profile.hostParseMs ?? '—'} stdoutChars=${profile.stdoutChars ?? '—'} eventCount=${profile.eventCount ?? '—'}`
      );
      console.log(
        `  events ${profile.eventsSize}/${profile.maxEvents} dropped=${profile.droppedEventCount} budgetTripped=${profile.budgetTripped}`
      );
      console.log(`\nWrote ${outPath}`);
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

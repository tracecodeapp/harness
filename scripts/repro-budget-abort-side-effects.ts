#!/usr/bin/env npx tsx
/**
 * Repro for the budget-abort double-execution bug.
 *
 * `sumAndZero` destructively zeroes its input while summing it. If the trace
 * budget trips mid-loop and the rewriter's TraceBudgetExceededError fallback
 * re-runs the method from the top, the rerun sums a half-zeroed array and
 * returns the wrong total. A correct implementation must return 300 here and
 * the traced verdict must be `passed`.
 *
 * Exit code 0 = traced verdict passed (no double execution observed).
 * Exit code 1 = traced verdict failed/errored (bug present).
 */
import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from '../tests/example-app-smoke';

/**
 * Small stored-event budget so the trip lands mid-loop, well before the
 * method finishes mutating its input.
 */
const REPRO_TRACE_BUDGET = {
  maxTraceSteps: 4000,
  maxLineEvents: 20000,
  maxSingleLineHits: 4000,
  maxStoredEvents: 150,
  traceProfile: true,
};

const REPRO_CODE = `class Solution {
    public int sumAndZero(int[] values) {
        System.out.println("sumAndZero start");
        int total = 0;
        for (int i = 0; i < values.length; i++) {
            total += values[i];
            values[i] = 0;
        }
        System.out.println("sumAndZero end");
        return total;
    }
}
`;

const CASE_INPUT_LENGTH = 300;

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

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-budget-abort-repro-'));
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    await runCommand(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'sync-assets', join(tempRoot, 'workers'), '--languages', 'java'],
      process.cwd()
    );
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
    await cp(join(traceJVMRoot, 'runtime/assets/profiles/core'), join(traceJVMTarget, 'profiles/core'), {
      recursive: true,
      force: true,
    });
    await cp(join(traceJVMRoot, '.cache/teavm-javac/artifacts'), join(traceJVMTarget, 'compiler'), {
      recursive: true,
      force: true,
    });

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
    server = await startStaticServer(tempRoot);

    const fixture = {
      language: 'java' as const,
      problem: 'budget-abort-side-effects',
      code: REPRO_CODE,
      functionName: 'sumAndZero',
      cases: [
        {
          id: 'in-place-sum',
          input: { values: Array.from({ length: CASE_INPUT_LENGTH }, () => 1) },
          expected: CASE_INPUT_LENGTH,
        },
      ],
    };

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(600_000);
      const consoleLines: string[] = [];
      page.on('pageerror', (error) => {
        console.error(`[browser pageerror] ${error.stack ?? error.message}`);
      });
      page.on('console', (message) => {
        consoleLines.push(message.text());
        if (message.type() === 'error') {
          console.error(`[browser console] ${message.text()}`);
        }
      });
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });

      const [result] = (await page.evaluate(
        async ({ fixture: pageFixture, traceOptions }) => {
          const benchmarkModuleUrl = '/background-tracing.mjs';
          const module = await import(benchmarkModuleUrl);
          return module.runBackgroundTracingBenchmark('/workers', [pageFixture], {
            traceOptions,
            skipTraceAll: true,
          });
        },
        { fixture, traceOptions: REPRO_TRACE_BUDGET }
      )) as Array<{
        perCaseCodeMs: number[];
        perCaseTraceMs: number[];
        perCaseVerdicts: string[];
        perCaseCodeVerdicts?: string[];
        perCaseProfiles?: Array<Record<string, unknown> | null>;
        error?: string;
      }>;

      if (result?.error) {
        console.error(`ERROR: ${result.error}`);
        process.exitCode = 1;
        return;
      }
      const codeVerdict = result.perCaseCodeVerdicts?.[0] ?? '(not run)';
      const traceVerdict = result.perCaseVerdicts[0] ?? 'missing';
      const profile = result.perCaseProfiles?.[0] ?? null;
      const startCount = consoleLines.filter((line) => line.includes('sumAndZero start')).length;

      console.log(`untraced verdict: ${codeVerdict}`);
      console.log(`traced verdict:   ${traceVerdict}`);
      console.log(
        `budget tripped:   ${profile?.budgetTripped ?? 'unknown'}  ` +
          `abort fallbacks: ${profile?.budgetAbortFallbacks ?? 'unknown'}`
      );
      if (startCount > 1) {
        console.log(`stdout duplication: "sumAndZero start" seen ${startCount}×`);
      }

      if (traceVerdict !== 'passed') {
        console.error(
          '\nFAIL: traced run returned the wrong result — the budget-abort ' +
            'fallback re-executed a partially-run method over mutated input.'
        );
        process.exitCode = 1;
      } else {
        console.log('\nPASS: traced result correct despite mid-method budget trip.');
      }
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

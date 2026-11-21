#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from './example-preview-process';

const fixtures = [
  {
    language: 'javascript',
    worker: 'javascript-worker.js',
    code: 'function add(a, b) { return a + b; }',
    message: 'JavaScript coordinator worker failed to initialize: Worker error',
  },
  {
    language: 'python',
    worker: 'python-worker.js',
    code: 'def add(a, b):\n    return a + b',
    // Python loads this script for runtime-image bootstrap before case execution.
    message: 'Browser runtime for "python" is unavailable: Python runtime-image bootstrap Worker crashed.',
  },
] as const;

const cases = [
  { id: 'case-1', input: { a: 1, b: 2 }, expected: 3 },
  { id: 'case-2', input: { a: -5, b: 2 }, expected: -3 },
  { id: 'case-3', input: { a: 0, b: 0 }, expected: 0 },
];

async function startStaticServer(root: string) {
  const contentTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
  };
  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
    const file = resolve(root, `.${pathname}`);
    const info = file.startsWith(root + sep)
      ? await stat(file).catch(() => undefined)
      : undefined;
    if (!info?.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Length': info.size,
      'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
    });
    createReadStream(file).on('error', () => response.destroy()).pipe(response);
  });
  await new Promise<void>((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((closed) => {
      server.close(() => closed());
      server.closeAllConnections();
    }),
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'tracecode-worker-startup-browser-'));
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    await runCommand('corepack', [
      'pnpm', 'exec', 'tsx', '--tsconfig', 'tsconfig.base.json', 'src/cli.ts',
      'sync-assets', join(root, 'workers'), '--languages', 'javascript,python',
    ], process.cwd(), { timeoutMs: 20_000 });
    for (const { worker } of fixtures) {
      await access(join(root, 'workers', worker));
    }

    await build({
      stdin: {
        contents: `export {
          createAlgorithmJudgeBundle,
          createBrowserJudgeHost,
          judgeCaseExecutionOutcome,
          judgeCompileExecutionOutcome,
        } from './src/judge';`,
        resolveDir: process.cwd(),
      },
      outfile: join(root, 'judge.mjs'),
      tsconfig: 'tsconfig.base.json',
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
    await writeFile(join(root, 'index.html'), '<!doctype html><meta charset="utf-8">\n');
    server = await startStaticServer(root);

    const browser = await chromium.launch({ headless: true, timeout: 15_000 });
    try {
      const failures: unknown[] = [];
      for (const { language, worker, code, message } of fixtures) {
        const page = await browser.newPage();
        const blockedRequests: string[] = [];
        try {
          await page.route(`**/workers/${worker}**`, async (route) => {
            // Leave asset-verification fetches alone so the native Worker fails.
            const resourceType = route.request().resourceType();
            if (resourceType === 'fetch' || resourceType === 'xhr') {
              await route.continue();
              return;
            }
            blockedRequests.push(resourceType);
            await route.abort('blockedbyclient');
          });
          await page.goto(`${server.origin}/index.html`, { timeout: 10_000 });
          const observed = await page.evaluate(async ({ language, code, cases }) => {
            const moduleUrl: string = '/judge.mjs';
            const judge: typeof import('../src/judge') = await import(moduleUrl);
            const host = judge.createBrowserJudgeHost({
              assetBaseUrl: '/workers',
              providers: [language],
            });
            const summary = {
              conversion(convert: () => ReturnType<typeof judge.judgeCaseExecutionOutcome>) {
                try {
                  const outcome = convert();
                  return {
                    kind: outcome.kind,
                    ...('error' in outcome ? { error: outcome.error } : {}),
                  };
                } catch (error) {
                  if (!(error instanceof Error)) throw error;
                  return {
                    class: error.constructor.name,
                    name: error.name,
                    message: error.message,
                  };
                }
              },
            };

            try {
              const bundle = await judge.createAlgorithmJudgeBundle({
                id: `blocked-${language}-worker`,
                language,
                code,
                functionName: 'add',
                cases,
              });
              const receipt = await host.evaluateAlgorithm({
                bundle,
                stopAtFirstRunaway: false,
                signal: AbortSignal.timeout(15_000),
              });
              const { evaluation } = receipt;
              const compile = evaluation.compile;
              return {
                crossOriginIsolated: globalThis.crossOriginIsolated,
                evaluationStatus: evaluation.status,
                receiptVerdict: receipt.verdict,
                compile: compile && {
                  status: compile.status,
                  failure: compile.failure,
                  diagnostics: compile.diagnostics,
                  conversion: compile.status === 'compiled' ? undefined :
                    summary.conversion(() => judge.judgeCompileExecutionOutcome(
                      compile, { language }
                    )),
                },
                cases: evaluation.cases.map((testCase) => ({
                  caseId: testCase.caseId,
                  status: testCase.status,
                  verdict: testCase.verdict,
                  failure: testCase.failure,
                  diagnostics: testCase.diagnostics,
                  conversion: summary.conversion(() => judge.judgeCaseExecutionOutcome(
                    testCase, { language }
                  )),
                })),
              };
            } finally {
              host.dispose();
            }
          }, { language, code, cases });

          console.log(`${language}: ${JSON.stringify({ worker, blockedRequests, ...observed })}`);
          assert.equal(observed.crossOriginIsolated, false);
          assert.ok(blockedRequests.length > 0, `${language}: no worker script request was blocked`);
          assert.equal(observed.evaluationStatus, 'compile-failed', language);
          assert.deepEqual(observed.cases, [], `${language}: startup failure produced case outcomes`);
          assert.deepEqual(observed.compile?.failure, {
            origin: 'provider',
            reason: 'runtime-failure',
            message,
          }, `${language}: Judge did not report a worker startup failure`);
          assert.ok(observed.compile?.diagnostics.some((diagnostic) =>
            diagnostic.code === 'runtime-provider-error' && diagnostic.message === message
          ), `${language}: Judge omitted the provider error diagnostic`);
          assert.deepEqual(observed.compile?.conversion, {
            class: 'RuntimeProviderError',
            name: 'RuntimeProviderError',
            message,
          }, `${language}: provider failure did not throw during outcome conversion`);
        } catch (error) {
          failures.push(error);
        } finally {
          await page.close();
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, 'Blocked worker startup checks failed');
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
  console.log('Blocked worker startup checks passed in Chromium.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

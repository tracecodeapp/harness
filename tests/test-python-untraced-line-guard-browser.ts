#!/usr/bin/env node
/**
 * Untraced Python cases get the worker's line guard when the caller sets no
 * limit, as the app's Run and Submit do. In a real Pyodide worker driven
 * through the public BrowserJudgeHost (Chromium), a correct program that runs
 * about 1.2 million lines, 400,000 of them on one line, must finish, and a
 * loop that never ends must still be stopped by the guard as a limit, soon
 * enough that Submit's 30-second batch clock never decides the verdict.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { leafLedger } from '../scripts/stage1/leaf-ledger.mjs';
import { bundlePythonBrowserFixture } from './fixtures/python-source-browser-bundle';
import type { LineGuardSample } from './fixtures/python-untraced-line-guard-entry';

// Submit's batch has one 30-second clock when the caller sets no limit; the
// whole evaluation, runaway included, has to finish well inside it.
const EVALUATION_BOUND_MS = 25_000;

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

async function startServer(root: string) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const headers = {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    const candidate = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const filePath = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!existsSync(filePath)) {
      response.writeHead(404, headers).end('Not found');
      return;
    }
    response.writeHead(200, {
      ...headers,
      'Content-Length': String(statSync(filePath).size),
      'Content-Type': contentType(filePath),
    });
    createReadStream(filePath).pipe(response);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections?.();
    }),
  };
}

async function main(): Promise<void> {
  const ledger = leafLedger('python-line-guard');
  const root = resolve('.');
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-python-line-guard-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await bundlePythonBrowserFixture(root, tempRoot, 'python-untraced-line-guard-entry.ts');
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n', 'utf8');
    server = await startServer(resolve(tempRoot));
    const browser = await chromium.launch({ channel: 'chromium', headless: true });
    try {
      const page = await browser.newPage();
      const workerStarts: string[] = [];
      page.on('worker', (worker) => workerStarts.push(worker.url()));
      page.setDefaultTimeout(5 * 60_000);
      page.on('pageerror', (error) => console.error(`[pageerror] ${error.message}`));
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
      const receipt = (await page.evaluate(async (options) => {
        const moduleUrl: string = '/entry.mjs';
        const module = await import(moduleUrl);
        return { nonce: options.nonce, samples: await module.runLineGuard(options) };
      }, { assetBaseUrl: '/workers', nonce: ledger.nonce })) as { nonce: string; samples: LineGuardSample[] };
      assert.equal(receipt.nonce, ledger.nonce);
      assert.ok(workerStarts.some((url) => new URL(url).pathname === '/workers/python-worker.js'), 'real Python worker started');
      ledger.checked('browser-worker');
      const samples = receipt.samples;
      assert.deepEqual(samples.map(({ action }) => action), ['submit', 'run']);
      for (const sample of samples) {
        const byId = new Map(sample.cases.map((testCase) => [testCase.id, testCase]));
        assert.deepEqual(sample.cases.map(({ id }) => id), ['heavy', 'small', 'runaway']);
        const heavy = byId.get('heavy');
        const runaway = byId.get('runaway');
        console.log(
          `${sample.action}: verdict in ${Math.round(sample.ms)} ms; heavy ${heavy?.status}/${heavy?.verdict} ` +
          `(${Math.round(heavy?.runMs ?? NaN)} ms); runaway ${runaway?.status} ${runaway?.failure?.origin}/` +
          `${runaway?.failure?.reason} (${Math.round(runaway?.runMs ?? NaN)} ms)`
        );
        assert.equal(sample.error, undefined, `${sample.action}: ${sample.error}`);
        assert.equal(sample.status, 'completed', sample.action);
        assert.equal(heavy?.verdict, 'passed', `${sample.action}: the heavy correct case: ${JSON.stringify(heavy)}`);
        assert.equal(byId.get('small')?.verdict, 'passed', `${sample.action}: the small case: ${JSON.stringify(byId.get('small'))}`);
        assert.equal(heavy?.value, 79_999_800_000, sample.action);
        assert.equal(byId.get('small')?.value, 6, sample.action);
        assert.equal(runaway?.failure?.origin, 'limit', `${sample.action}: the runaway case: ${JSON.stringify(runaway)}`);
        assert.ok(
          runaway?.failure?.reason === 'line-limit' || runaway?.failure?.reason === 'single-line-limit',
          `${sample.action}: the line guard, not a clock, stops the runaway: ${JSON.stringify(runaway)}`
        );
        assert.ok(
          sample.ms < EVALUATION_BOUND_MS,
          `${sample.action}: verdict in ${Math.round(sample.ms)} ms, over ${EVALUATION_BOUND_MS} ms`
        );
        ledger.checked(sample.action);
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
  ledger.done();
}

test('Untraced Python finishes a heavy correct program and still stops a runaway', main);

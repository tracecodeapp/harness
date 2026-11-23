#!/usr/bin/env node
/**
 * A Python Run whose case loops forever reports that case's time limit within
 * one per-case clock, in a real Pyodide worker driven through the public
 * BrowserJudgeHost (Chromium): the traced Run and the untraced stopping
 * evaluation, with the runaway in the first and in a middle case.
 *
 * The loop runs inside C code (`max(iter(int, 1))`), where the worker's own
 * guard sees no line events, so only the client's per-case clock can stop it.
 *
 * - TRACECODE_STOPPING_CLOCK_WALL_MS=30000   the per-case limit (default 2000)
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
import type { StoppingClockSample } from './fixtures/python-stopping-batch-clock-entry';

const WALL_CLOCK_MS = Number(process.env.TRACECODE_STOPPING_CLOCK_WALL_MS ?? 2_000);
const CASES = 10;
// The per-case clock's headroom over the limit, plus preparing the program
// and replacing the terminated worker on a loaded machine.
const VERDICT_BOUND_MS = WALL_CLOCK_MS + 1_000 + 4_000;

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
  const ledger = leafLedger('python-stopping-clock');
  const root = resolve('.');
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-python-stopping-clock-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await bundlePythonBrowserFixture(root, tempRoot, 'python-stopping-batch-clock-entry.ts');
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n', 'utf8');
    server = await startServer(resolve(tempRoot));
    const browser = await chromium.launch({ channel: 'chromium', headless: true });
    try {
      const page = await browser.newPage();
      const workerStarts: string[] = [];
      page.on('worker', (worker) => workerStarts.push(worker.url()));
      page.setDefaultTimeout(15 * 60_000);
      page.on('pageerror', (error) => console.error(`[pageerror] ${error.message}`));
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
      const receipt = (await page.evaluate(async (options) => {
        const moduleUrl: string = '/entry.mjs';
        const module = await import(moduleUrl);
        return { nonce: options.nonce, samples: await module.runStoppingClock(options) };
      }, {
        assetBaseUrl: '/workers',
        nonce: ledger.nonce,
        caseCount: CASES,
        wallClockMs: WALL_CLOCK_MS,
        scenarios: [
          { action: 'run', runawayCase: 1 },
          { action: 'run', runawayCase: 5 },
          { action: 'submit-stop', runawayCase: 1 },
          { action: 'submit-stop', runawayCase: 5 },
          // A correct program: every case's result arrives as progress.
          { action: 'run', runawayCase: 0 },
          { action: 'submit-stop', runawayCase: 0 },
        ],
      })) as { nonce: string; samples: StoppingClockSample[] };
      assert.equal(receipt.nonce, ledger.nonce);
      assert.ok(workerStarts.some((url) => new URL(url).pathname === '/workers/python-worker.js'), 'real Python worker started');
      ledger.checked('browser-worker');
      const samples = receipt.samples;
      assert.deepEqual(samples.map(({ action, runawayCase }) => [action, runawayCase]), [
        ['run', 1], ['run', 5], ['submit-stop', 1], ['submit-stop', 5], ['run', 0], ['submit-stop', 0],
      ]);
      for (const sample of samples) {
        const label = sample.runawayCase === 0
          ? `${sample.action} of a correct program`
          : `${sample.action} with case ${sample.runawayCase} looping`;
        console.log(`${label}: verdict in ${Math.round(sample.ms)} ms`);
        assert.equal(sample.error, undefined, `${label}: ${sample.error}`);
        assert.equal(sample.status, 'completed', label);
        assert.equal(sample.cases.length, CASES, label);
        sample.cases.forEach((testCase, index) => {
          const caseNumber = index + 1;
          assert.equal(testCase.id ?? testCase.caseId, `case-${caseNumber}`);
          if (sample.runawayCase === 0 || caseNumber < sample.runawayCase) {
            assert.equal(testCase.status, 'completed', `${label}: case ${caseNumber} keeps its result`);
            assert.equal(testCase.value, -1, label);
          } else if (caseNumber === sample.runawayCase) {
            assert.equal(testCase.status, 'timed-out', `${label}: the looping case`);
            assert.equal(testCase.failure?.reason, 'client-timeout', `${label}: the looping case`);
          } else {
            assert.equal(testCase.status, 'not-run', `${label}: case ${caseNumber}`);
          }
          ledger.checked(`${sample.action}/${sample.runawayCase}/case-${caseNumber}`);
        });
        assert.ok(
          sample.ms < VERDICT_BOUND_MS,
          `${label}: verdict in ${Math.round(sample.ms)} ms, over one per-case clock (${VERDICT_BOUND_MS} ms)`
        );
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

test('Python Run stops a never-ending case on one per-case clock in a real worker', main);

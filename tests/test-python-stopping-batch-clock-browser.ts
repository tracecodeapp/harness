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
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from './example-app-smoke';
import type { StoppingClockSample } from './fixtures/python-stopping-batch-clock-entry';

const WALL_CLOCK_MS = Number(process.env.TRACECODE_STOPPING_CLOCK_WALL_MS ?? 2_000);
const CASES = 10;
// The production client arms the clock at the start ACK with 1 s of headroom.
// Allow separate browser scheduling slack when observing its real timer.
// The worker-double suite also checks the deadline with controlled progress.
const CASE_CLOCK_HEADROOM_MS = 1_000;
const BROWSER_TIMER_SLACK_MS = 1_000;

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

/**
 * Which deadline released Run, from the receipt and the trusted Judge journal:
 * a selected clock runaway's pending drawing expires at the ordinary deadline
 * (`observer-expire` before `attachment-bind`), never at the observer's
 * backstop. Redraw and click draw on the same page, and the later Runs on the
 * same host, stay correct and use fresh attempts.
 */
function assertReleasedByOrdinaryDeadline(label: string, sample: StoppingClockSample, seenTokens: Set<string>): void {
  const selected = sample.selected;
  assert.ok(selected, `${label}: selected-case evidence`);
  const { phases, attachment, redraw } = selected;
  for (const token of selected.attemptTokens) {
    assert.equal(seenTokens.has(token), false, `${label}: a fresh observation attempt`);
    seenTokens.add(token);
  }
  if (sample.runawayCase === 0) {
    assert.equal(attachment?.status, 'drawn', `${label}: the healthy case is drawn`);
    assert.equal(phases.includes('observer-expire'), false, `${label}: no expiry`);
  } else {
    assert.equal(attachment?.status, 'refused', `${label}: ${JSON.stringify(attachment)}`);
    assert.equal(attachment?.reason, 'observer-timeout', label);
    const order = ['ordinary-commit', 'observer-expire', 'attachment-bind', 'public-resolve'].map((phase) => phases.indexOf(phase));
    assert.ok(
      order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!)),
      `${label}: the ordinary deadline releases Run: ${phases.join(' > ')}`
    );
    assert.equal(selected.expiredToken, selected.attemptTokens[0], `${label}: the selected attempt expired`);
  }
  assert.equal(redraw.same, true, `${label}: redraw returns the settled attachment`);
  assert.equal(redraw.phases.includes('observer-start'), false, `${label}: redraw does not re-observe`);
  assert.equal(redraw.cacheHitToken, selected.attemptTokens[0], `${label}: redraw is a cache hit`);
  if (selected.click) {
    assert.equal(selected.click.attachment?.status, 'drawn', `${label}: click draw on case 1`);
    assert.ok(selected.click.token, `${label}: click draw observes case 1`);
    assert.equal(seenTokens.has(selected.click.token!), false, `${label}: click draw uses a fresh attempt`);
    seenTokens.add(selected.click.token!);
    assert.equal(selected.click.phases.includes('observer-expire'), false, `${label}: a completed case is not expired`);
  }
}

async function main(): Promise<void> {
  const root = resolve('.');
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-python-stopping-clock-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await runCommand('pnpm', ['exec', 'tsx', '--tsconfig', 'tsconfig.base.json', 'src/cli.ts', 'sync-assets', join(tempRoot, 'workers'), '--languages', 'python'], root);
    await build({
      absWorkingDir: root,
      // The workspace source aliases: the suite runs this before the build
      // phase, when no workspace package has a dist to resolve to.
      tsconfig: join(root, 'tsconfig.base.json'),
      entryPoints: [join(root, 'tests/fixtures/python-stopping-batch-clock-entry.ts')],
      outfile: join(tempRoot, 'entry.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      alias: {
        zlib: join(root, 'packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': join(root, 'packages/tracekernel/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n', 'utf8');
    server = await startServer(resolve(tempRoot));
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(15 * 60_000);
      page.on('pageerror', (error) => console.error(`[pageerror] ${error.message}`));
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
      const samples = (await page.evaluate(async (options) => {
        const moduleUrl: string = '/entry.mjs';
        const module = await import(moduleUrl);
        return module.runStoppingClock(options);
      }, {
        assetBaseUrl: '/workers',
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
      })) as StoppingClockSample[];
      assert.equal(samples.length, 6);
      const seenTokens = new Set<string>();
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
          if (sample.runawayCase === 0 || caseNumber < sample.runawayCase) {
            assert.equal(testCase.status, 'completed', `${label}: case ${caseNumber} keeps its result`);
          } else if (caseNumber === sample.runawayCase) {
            assert.equal(testCase.status, 'timed-out', `${label}: the looping case`);
            assert.equal(testCase.failure?.reason, 'client-timeout', `${label}: the looping case`);
          } else {
            assert.equal(testCase.status, 'not-run', `${label}: case ${caseNumber}`);
          }
        });
        if (sample.action === 'run') assertReleasedByOrdinaryDeadline(label, sample, seenTokens);
        assert.equal(sample.ordinaryBatches.length, 1, `${label}: one ordinary batch`);
        const [batch] = sample.ordinaryBatches;
        const expectedStarts = Array.from({ length: sample.runawayCase || CASES }, (_, index) => index);
        assert.deepEqual(batch.startedCaseIndexes, expectedStarts, `${label}: ordinary worker starts`);
        if (sample.runawayCase === 0) {
          assert.equal(batch.timeout, undefined, `${label}: no ordinary case was terminated`);
          continue;
        }
        const { timeout } = batch;
        assert.ok(timeout, `${label}: ordinary worker was terminated during the looping case`);
        assert.equal(timeout.caseIndex, sample.runawayCase - 1);
        const { beforeMs, activeMs, afterMs } = timeout;
        console.log(`${label}: before start ${Math.round(beforeMs)} ms, active ${Math.round(activeMs)} ms, after termination ${Math.round(afterMs)} ms`);
        assert.ok(beforeMs >= 0 && afterMs >= 0, `${label}: worker timeout falls within the public request`);
        assert.ok(
          activeMs >= WALL_CLOCK_MS && activeMs < WALL_CLOCK_MS + CASE_CLOCK_HEADROOM_MS + BROWSER_TIMER_SLACK_MS,
          `${label}: active case lasted ${Math.round(activeMs)} ms for a ${WALL_CLOCK_MS} ms limit`
        );
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('Python Run stops a never-ending case on one per-case clock in a real worker', main);

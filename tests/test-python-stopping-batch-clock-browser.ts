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
import { chromium, type Page } from 'playwright';
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

async function withPythonPage(run: (page: Page) => Promise<void>): Promise<void> {
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
      stdin: {
        resolveDir: root,
        contents: `
          export { runStoppingClock } from './tests/fixtures/python-stopping-batch-clock-entry.ts';
          export { createAlgorithmJudgeBundle, createBrowserJudgeHost } from './src/judge';
          import { createPythonPreparedExecutionProvider } from './packages/runtime-python/src/python-runtime-client.ts';
          import { PythonWorkerClient } from './packages/runtime-python/src/python-worker-client.ts';
          export function createProvider() {
            const assetBase = new URL('/workers/', location.href);
            const indexUrl = new URL('python/pyodide-0.29.3/', assetBase);
            return createPythonPreparedExecutionProvider({
              createWorkerClient: () => new PythonWorkerClient({
                workerUrl: new URL('python-worker.js', assetBase).href,
                runtimeAssets: {
                  runtimeUrl: new URL('python/python-runtime.js', assetBase).href,
                  snippetsUrl: new URL('generated-python-harness-snippets.js', assetBase).href,
                  indexUrl: indexUrl.href,
                  loaderUrl: new URL('pyodide.js', indexUrl).href,
                },
              }),
            });
          }
        `,
      },
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
      await run(page);
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('Python Run stops a never-ending case on one per-case clock in a real worker', async () => {
  await withPythonPage(async (page) => {
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
  });
});

test('Python ordinary batch gives only the stuck case a timeout in a real worker', async () => {
  await withPythonPage(async (page) => {
    const actual = await page.evaluate(async (wallClockMs) => {
      const entryUrl = '/entry.mjs';
      const { createProvider } = await import(entryUrl);
      const provider = createProvider();
      try {
        const preparation = await provider.prepareProgram({
          mode: 'code',
          code: 'def solve(value):\n    if value == 0:\n        max(iter(int, 1))\n    return value',
          functionName: 'solve',
          executionStyle: 'function',
        });
        if (preparation.kind !== 'prepared') throw new Error(JSON.stringify(preparation));
        const { program } = preparation;
        const starts: number[] = [];
        const rows = await program.executeBatchIsolated({
          inputBatch: [11, 0, 33].map((value) => ({ value })),
          limits: { wallClockMs },
          onCaseStarted(index: number) { starts.push(index); },
        });
        await program.dispose();
        return {
          starts,
          outcomes: rows.map((row: { kind: string; reason?: string; output?: unknown }) =>
            row.kind === 'completed' ? row.output : row.reason ?? row.kind),
        };
      } finally {
        provider.terminate();
      }
    }, WALL_CLOCK_MS);
    assert.deepEqual(actual, { starts: [0, 1, 2], outcomes: [11, 'client-timeout', 33] });
  });
});

test('Python ordinary batch matches five 7 MiB singleton results in a real worker', async () => {
  await withPythonPage(async (page) => {
    const actual = await page.evaluate(async () => {
      const entryUrl = '/entry.mjs';
      const { createProvider } = await import(entryUrl);
      const provider = createProvider();
      try {
        const preparation = await provider.prepareProgram({
          mode: 'code',
          code: 'def solve(value):\n    return str(value) * (7 * 1024 * 1024)',
          functionName: 'solve',
          executionStyle: 'function',
        });
        if (preparation.kind !== 'prepared') throw new Error(JSON.stringify(preparation));
        const { program } = preparation;
        const inputBatch = [1, 2, 3, 4, 5].map((value) => ({ value }));
        const projection = {
          summary(row: { kind: string; output?: string; reason?: string }) {
            return row.kind === 'completed' && typeof row.output === 'string'
              ? { size: row.output.length, first: row.output[0], last: row.output.at(-1) }
              : { kind: row.kind, reason: row.reason };
          },
        };
        const singletons = [];
        for (const inputs of inputBatch) {
          singletons.push(projection.summary(await program.executeIsolated({ inputs })));
        }
        const batch = await program.executeBatchIsolated({ inputBatch, onCaseStarted() {} });
        await program.dispose();
        return {
          singletons,
          batch: batch.map(projection.summary),
          fast: batch.map((row: { timings?: { algorithmFastBatch?: boolean } }) => row.timings?.algorithmFastBatch),
        };
      } finally {
        provider.terminate();
      }
    });
    const expected = [1, 2, 3, 4, 5].map((value) => ({
      size: 7 * 1024 * 1024, first: String(value), last: String(value),
    }));
    assert.deepEqual(actual.singletons, expected, 'every singleton fits under the per-case cap');
    assert.deepEqual(actual.batch, expected, 'every batch row fits under the same per-case cap');
    assert.deepEqual(actual.fast, expected.map(() => true), 'the batch used the fast driver');
  });
});

test('Python ordinary batch bounds unbounded allocation without an explicit memory limit', async () => {
  await withPythonPage(async (page) => {
    const actual = await page.evaluate(async () => {
      const entryUrl = '/entry.mjs';
      const { createAlgorithmJudgeBundle, createBrowserJudgeHost } = await import(entryUrl);
      const host = createBrowserJudgeHost({ assetBaseUrl: '/workers', providers: ['python'] });
      try {
        const bundle = await createAlgorithmJudgeBundle({
          id: 'python-allocation-without-memory-limit',
          language: 'python',
          code: [
            'def solve(value):',
            '    if value == 0:',
            '        blocks = []',
            '        while True:',
            '            blocks.append(bytearray(1024 * 1024))',
            '    return value',
          ].join('\n'),
          functionName: 'solve',
          executionStyle: 'function',
          limits: { wallClockMs: 400 },
          cases: [11, 0, 33].map((value) => ({ id: String(value), input: { value }, expected: value })),
        });
        const { evaluation } = await host.evaluateAlgorithm({ bundle });
        return evaluation.cases.map((row: {
          status: string;
          failure?: { origin: string; reason?: string; stage?: string };
          termination?: { kind: string };
          verdict?: { kind: string };
        }) => ({
          status: row.status,
          origin: row.failure?.origin,
          reason: row.failure?.reason ?? row.failure?.stage,
          termination: row.termination?.kind,
          verdict: row.verdict?.kind,
        }));
      } finally {
        host.dispose();
      }
    });
    console.log('Allocation without maxMemoryBytes:', JSON.stringify(actual));
    assert.equal(actual.length, 3);
    assert.equal(actual[0]?.verdict, 'passed');
    if (actual[1]?.origin === 'provider') {
      assert.equal(actual[1]?.termination, 'failure');
      assert.equal(actual[2]?.origin, 'provider');
    } else {
      assert.equal(actual[1]?.origin, 'limit');
      assert.ok(['client-timeout', 'line-limit', 'single-line-limit', 'memory-limit'].includes(actual[1]?.reason));
      assert.equal(actual[2]?.verdict, 'passed');
    }
  });
});

#!/usr/bin/env node
/**
 * A traced Python Run whose trace stops recording at a budget keeps the
 * learner's code under the worker's runaway guard, in a real Pyodide worker
 * driven through the public BrowserJudgeHost (Chromium) with the app's trace
 * budgets and its 30 s per-case clock:
 *
 * - a loop that never ends, after its trace filled the byte budget, is stopped
 *   by the worker's line guard in seconds, not by the 30 s clock;
 * - a program that ends, after its trace filled the same budget, completes
 *   with its truncated trace;
 * - a program that runs 120k lines after its trace stopped recording
 *   completes: only the learner's lines count toward the runaway ceiling.
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
import type { TraceCutoffSample } from './fixtures/python-trace-cutoff-guard-entry';

// Well under the 30 s per-case clock; the guard itself takes ~1-2 s.
// The untraced ceiling (4,000,000 lines) takes about 9 s on a busy host; this
// stays well inside the client's ~30 s clock, which must not be what stops it.
const RUNAWAY_BOUND_MS = 20_000;

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
    // Not cross-origin isolated, like the app's Practice page: the worker
    // has no interrupt buffer, so only its own guard stops a runaway early.
    const headers = {};
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
  const root = resolve('.');
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-python-trace-cutoff-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await runCommand('pnpm', ['exec', 'tsx', '--tsconfig', 'tsconfig.base.json', 'src/cli.ts', 'sync-assets', join(tempRoot, 'workers'), '--languages', 'python'], root);
    await build({
      absWorkingDir: root,
      // The workspace source aliases: the suite runs this before the build
      // phase, when no workspace package has a dist to resolve to.
      tsconfig: join(root, 'tsconfig.base.json'),
      entryPoints: [join(root, 'tests/fixtures/python-trace-cutoff-guard-entry.ts')],
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
      page.setDefaultTimeout(5 * 60_000);
      page.on('pageerror', (error) => console.error(`[pageerror] ${error.message}`));
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
      assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), false);
      const samples = (await page.evaluate(async (options) => {
        const moduleUrl: string = '/entry.mjs';
        const module = await import(moduleUrl);
        return module.runTraceCutoff(options);
      }, {
        assetBaseUrl: '/workers',
        programs: ['runaway', 'finishes', 'runsLong'],
      })) as TraceCutoffSample[];
      assert.equal(samples.length, 3);
      const [runaway, finishes, runsLong] = samples;
      for (const sample of samples) {
        console.log(`${sample.program}: verdict in ${Math.round(sample.ms)} ms`);
        console.log(JSON.stringify(sample.cases[0]));
        assert.equal(sample.error, undefined, `${sample.program}: ${sample.error}`);
        assert.equal(sample.status, 'completed', sample.program);
        assert.equal(sample.cases.length, 3, sample.program);
      }

      // The loop that never ends: the worker's guard reports a runaway limit.
      const [looping, ...rest] = runaway.cases;
      assert.equal(looping.failure?.origin, 'limit', 'the looping case stopped at a limit');
      assert.ok(
        ['line-limit', 'single-line-limit'].includes(looping.failure?.reason),
        `the worker's line guard stopped the loop, not the clock: ${looping.failure?.reason}`
      );
      assert.equal(looping.verdict?.reason, 'case-did-not-complete');
      assert.match(looping.failure?.message ?? '', /infinite loop/);
      assert.doesNotMatch(looping.failure?.message ?? '', /[Tt]race/, 'a runaway is not described as a trace budget');
      assert.ok(looping.traceEvents > 0, 'the recorded trace prefix is kept');
      for (const testCase of rest) assert.equal(testCase.status, 'not-run');
      assert.ok(
        runaway.ms < RUNAWAY_BOUND_MS,
        `runaway verdict in ${Math.round(runaway.ms)} ms, over ${RUNAWAY_BOUND_MS} ms`
      );

      // The program that ends: it completes, its trace truncated at the byte budget.
      const [traced, ...others] = finishes.cases;
      assert.equal(traced.status, 'completed');
      assert.equal(traced.verdict?.kind, 'passed');
      assert.ok(
        traced.diagnostics?.some((diagnostic: any) =>
          diagnostic.severity === 'warning' && diagnostic.code === 'trace-byte-limit'),
        `the trace reports its byte budget: ${JSON.stringify(traced.diagnostics)}`
      );
      assert.ok(traced.traceEvents > 0, 'the recorded trace prefix is kept');
      for (const testCase of others) assert.equal(testCase.status, 'completed');

      // The long program: it completes, its trace truncated.
      const [long, ...afterLong] = runsLong.cases;
      assert.equal(long.status, 'completed', JSON.stringify(long.failure));
      assert.equal(long.verdict?.kind, 'passed');
      assert.ok(
        long.diagnostics?.some((diagnostic: any) =>
          diagnostic.severity === 'warning' &&
          ['trace-byte-limit', 'trace-limit', 'single-line-limit', 'line-limit'].includes(diagnostic.code)),
        `the trace reports its budget: ${JSON.stringify(long.diagnostics)}`
      );
      for (const testCase of afterLong) assert.equal(testCase.status, 'completed');
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('A traced Python Run keeps its runaway guard after the trace stops recording', main);

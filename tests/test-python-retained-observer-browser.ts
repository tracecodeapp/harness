#!/usr/bin/env node
/**
 * Continued Python drawings on the retained observer, in Chromium through
 * the public BrowserJudgeHost (the app's Run, then click-draws on the same
 * execution), against a fresh observer's drawing of each case:
 *
 * - an algorithm-fast program's click-draws run on the Run's own observer
 *   worker (kept after each complete drawing), and each equals a fresh
 *   observer's drawing byte for byte, after earlier cases mutated globals,
 *   defaults, class attributes, caches, the random stream, the call stack and
 *   the tracer's budgets;
 * - a compatibility-classified program's click-draws each run on a new
 *   observer worker and also equal a fresh observer's drawings;
 * - on one raw worker, a program that writes a module attribute draws the
 *   same twice as classified, and differently once its tier is forced to
 *   algorithm-fast: the comparison would see a leak.
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
import type { ProgramSample, SensitivitySample } from './fixtures/python-retained-observer-entry';
import { PROGRAMS } from './fixtures/python-retained-observer-programs';

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
    const candidate = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const filePath = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!existsSync(filePath)) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
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

const statusOf = (drawing: string) => (JSON.parse(drawing) as { status: string }).status;

function assertProgram(sample: ProgramSample): void {
  const program = PROGRAMS[sample.program];
  const label = sample.program;
  assert.equal(sample.error, undefined, `${label}: ${sample.error}`);
  assert.equal(sample.retained.length, program.inputs.length, label);
  assert.equal(sample.fresh.length, program.inputs.length, label);
  const fast = program.expectTier === 'algorithm-fast';
  for (const [index, drawn] of sample.retained.entries()) {
    const caseLabel = `${label} case ${drawn.caseId}`;
    const fresh = sample.fresh[index];
    // One observer execution per drawing, with the program's classification.
    for (const row of [drawn, fresh]) {
      assert.equal(row.dispatches.length, 1, `${caseLabel}: ${JSON.stringify(row.dispatches)}`);
      if (fast) assert.equal(row.dispatches[0].tier, 'algorithm-fast', caseLabel);
      else assert.notEqual(row.dispatches[0].tier, 'algorithm-fast', caseLabel);
    }
    // A fresh observer had drawn nothing before.
    assert.equal(fresh.priorOnWorker, 0, `${caseLabel}: the fresh observer was not fresh`);
    if (index > 0) {
      const previous = sample.retained[index - 1];
      const kept = fast && statusOf(previous.drawing) === 'drawn';
      if (kept) {
        assert.equal(drawn.dispatches[0].worker, previous.dispatches[0].worker, `${caseLabel}: the observer was not retained`);
        assert.ok(drawn.priorOnWorker >= 1, caseLabel);
      } else {
        assert.equal(drawn.priorOnWorker, 0, `${caseLabel}: a retired observer was reused`);
      }
    }
    assert.equal(drawn.drawing, fresh.drawing, `${caseLabel}: the retained drawing differs from a fresh observer's`);
  }
  if (fast) {
    // The retained observer really drew several cases.
    const reused = sample.retained.filter((row) => row.priorOnWorker > 0).length;
    assert.ok(reused >= 2, `${label}: only ${reused} drawings ran on a retained observer`);
  }
}

async function main(): Promise<void> {
  const root = resolve('.');
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-python-retained-observer-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await runCommand('pnpm', ['exec', 'tsx', '--tsconfig', 'tsconfig.base.json', 'src/cli.ts', 'sync-assets', join(tempRoot, 'workers'), '--languages', 'python'], root);
    await build({
      absWorkingDir: root,
      tsconfig: join(root, 'tsconfig.base.json'),
      entryPoints: [join(root, 'tests/fixtures/python-retained-observer-entry.ts')],
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
        return module.runRetainedObserver(options);
      }, { assetBaseUrl: '/workers', programs: Object.keys(PROGRAMS) })) as ProgramSample[];
      assert.deepEqual(samples.map(({ program }) => program), Object.keys(PROGRAMS));
      for (const sample of samples) {
        console.log(`${sample.program}: ${sample.retained.map((row) => `${row.caseId}@w${row.dispatches[0]?.worker}+${row.priorOnWorker}:${row.drawing && statusOf(row.drawing)}`).join(' ')}`);
        assertProgram(sample);
      }

      const control = (await page.evaluate(async (options) => {
        const moduleUrl: string = '/entry.mjs';
        const module = await import(moduleUrl);
        return module.runSensitivityControl(options);
      }, { workerBaseUrl: '/workers/' })) as SensitivitySample;
      assert.equal(control.error, undefined, control.error);
      assert.equal(control.classifiedTier, 'hard-isolated');
      assert.ok(control.asClassified[0].length > 0);
      assert.equal(control.asClassified[1], control.asClassified[0], 'as classified, the module write is restored');
      assert.equal(control.forcedFast[0], control.asClassified[0], 'a first drawing has nothing to leak from');
      assert.notEqual(control.forcedFast[1], control.forcedFast[0], 'forced to algorithm-fast, the second drawing sees the write');
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('Retained Python observers draw continued cases as fresh observers do', { timeout: 20 * 60_000 }, main);

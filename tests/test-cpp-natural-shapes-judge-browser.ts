#!/usr/bin/env npx tsx

/**
 * Natural C++ learner shapes through the public browser Judge.
 *
 * Correct solutions written the way learners write them (tests/fixtures/
 * cpp-natural-shapes.json): a helper or the ops class itself with public
 * fields and only an argument constructor (LRU Cache's Node, Min Stack's
 * Entry, NumArray, ParkingLot), a type with a nested-type field (a Trie node's
 * enum, a task's kind), and a hand-written value type. Each must pass on the
 * five Judge paths: Run with no, the first and every case traced, and Submit
 * untraced and traced.
 *
 * TRACECODE_NATURAL_SHAPES_EXPECT=571139f0 instead asserts each fixture's
 * recorded outcome on 571139f0 (the compile error, the wrong answer, or a pass
 * for the controls), to show the fixtures fail there for the documented reason.
 */

import { test } from 'node:test';
import { createReadStream, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { loadEngineRuntimePackages } from '../scripts/runtime-package-assets.mjs';
import { runCommand } from './example-app-smoke';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const BROWSER_CHANNEL = process.env.TRACECODE_MATRIX_BROWSER_CHANNEL ||
  (process.platform === 'linux' ? 'chromium' : undefined);
const EXPECT = process.env.TRACECODE_NATURAL_SHAPES_EXPECT ?? 'pass';

interface Fixture {
  name: string;
  shape: number | 'control';
  kind: string;
  code: string;
  functionName: string;
  executionStyle: 'solution-method' | 'ops-class';
  cases: Array<{ id: string; input: Record<string, unknown>; expected: unknown }>;
  on571139f0: { compileError?: string; wrongAnswer?: boolean; passes?: boolean };
}

interface Observation {
  path: string;
  status?: string;
  compileStatus?: string;
  compileMessage?: string;
  cases: Array<{ caseId: string; status?: string; verdict?: string; value?: unknown; message?: string }>;
  threw?: string;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.hpp': 'text/plain',
};

async function serve(root: string) {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    const file = normalize(join(root, path === '/' ? 'index.html' : path));
    const info = file.startsWith(root + sep) && statSync(file, { throwIfNoEntry: false });
    if (!info || !info.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Length': String(info.size),
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections?.(); }),
  };
}

function check(fixture: Fixture, observations: Observation[]): string[] {
  const failures: string[] = [];
  const label = (observation: Observation) => `${fixture.name} / ${observation.path}`;
  for (const observation of observations) {
    if (observation.threw) {
      failures.push(`${label(observation)}: threw ${observation.threw}`);
      continue;
    }
    const verdicts = observation.cases.map((row) => row.verdict);
    if (EXPECT === 'pass' || fixture.on571139f0.passes) {
      if (observation.status !== 'completed' || verdicts.length !== fixture.cases.length || verdicts.some((verdict) => verdict !== 'passed')) {
        failures.push(`${label(observation)}: expected every case to pass, got ${JSON.stringify(observation).slice(0, 1200)}`);
      }
    } else if (fixture.on571139f0.compileError) {
      if (observation.status !== 'compile-failed' || !String(observation.compileMessage).includes(fixture.on571139f0.compileError)) {
        failures.push(`${label(observation)}: expected the compile error "${fixture.on571139f0.compileError}", got ${JSON.stringify(observation).slice(0, 1200)}`);
      }
    } else if (fixture.on571139f0.wrongAnswer) {
      if (observation.status !== 'completed' || !verdicts.includes('failed')) {
        failures.push(`${label(observation)}: expected a wrong answer, got ${JSON.stringify(observation).slice(0, 1200)}`);
      }
    }
  }
  return failures;
}

async function main(): Promise<void> {
  assertCondition(EXPECT === 'pass' || EXPECT === '571139f0', `Unknown TRACECODE_NATURAL_SHAPES_EXPECT ${EXPECT}`);
  const fixtures = (JSON.parse(await readFile(resolve('tests/fixtures/cpp-natural-shapes.json'), 'utf8')) as { fixtures: Fixture[] }).fixtures;
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-cpp-natural-shapes-judge-'));
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    await runCommand('pnpm', ['exec', 'tsx', 'src/cli.ts', 'sync-assets', join(tempRoot, 'workers'), '--languages', 'cpp'], process.cwd());
    const { tracecc } = await loadEngineRuntimePackages(resolve('.'));
    await symlink(tracecc.sourceRoot, join(tempRoot, 'tracecc'), 'dir');
    await build({
      entryPoints: [resolve('tests/fixtures/cpp-natural-shapes-judge-entry.ts')],
      outfile: join(tempRoot, 'natural-shapes.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      tsconfig: resolve('tsconfig.base.json'),
      alias: {
        zlib: resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n', 'utf8');
    server = await serve(resolve(tempRoot));
    const browser = await chromium.launch({ headless: true, ...(BROWSER_CHANNEL ? { channel: BROWSER_CHANNEL } : {}) });
    let results: Record<string, Observation[]>;
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(30 * 60_000);
      await page.goto(`${server.origin}/index.html`);
      results = await page.evaluate(async ({ fixtures: list }) => {
        const moduleUrl = '/natural-shapes.mjs';
        const module = await import(moduleUrl);
        return module.runNaturalShapes(list, '/workers');
      }, { fixtures: fixtures.map(({ name, code, functionName, executionStyle, cases }) => ({ name, code, functionName, executionStyle, cases })) });
    } finally {
      await browser.close();
    }
    if (process.env.TRACECODE_NATURAL_SHAPES_REPORT) {
      await writeFile(resolve(process.env.TRACECODE_NATURAL_SHAPES_REPORT), `${JSON.stringify(results, null, 1)}\n`, 'utf8');
    }
    const failures: string[] = [];
    for (const fixture of fixtures) {
      const observations = results[fixture.name] ?? [];
      assertCondition(observations.length === 5, `${fixture.name}: expected five Judge paths, got ${observations.length}`);
      const found = check(fixture, observations);
      failures.push(...found);
      console.log(`${found.length === 0 ? 'ok' : 'FAIL'} shape ${fixture.shape} ${fixture.name} (${fixture.kind}): ${observations.map((o) => `${o.path}=${o.threw ? 'threw' : o.status}`).join(' ')}`);
    }
    assertCondition(failures.length === 0, `C++ natural shapes (expect ${EXPECT}) diverged:\n${failures.join('\n')}`);
    console.log(`PASS: C++ natural shapes on the five Judge paths (expect ${EXPECT}, ${fixtures.length} fixtures)`);
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('cpp natural learner shapes pass on the five Judge paths', main);

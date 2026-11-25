#!/usr/bin/env npx tsx
// JS and TS judged output through the real Judge host, on the SES pool and the
// disposable worker (lane C-SEAM). Under the trusted bridge's 1,024-byte seam a
// 64-character answer passes and a 2,048-character one is a typed
// serialization-limit with no value; under the product default the edge is
// exact, a 64-node list passes, 65 nodes and a cycle are typed limits, and a
// shared child is written at each occurrence.
//
// TRACECODE_JUDGED_OUTPUT_SEED=drop-policy is the seeded control: it makes the
// synced workers ignore the policy, and the run must then fail on the 2,048
// case (the script exits 0 only when the control is caught).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from './example-app-smoke';

type Result = Awaited<ReturnType<
  typeof import('./fixtures/javascript-judged-output-entry').runJavaScriptJudgedOutputPolicy
>>[number];

const SEED = process.env.TRACECODE_JUDGED_OUTPUT_SEED;
const DEFAULT_BYTES = 8 * 1024 * 1024;

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

async function startServer(root: string) {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const candidate = normalize(join(root, decodeURIComponent(requestUrl.pathname)));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const path = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!path || !existsSync(path)) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Length': String(statSync(path).size),
      'Content-Type': contentType(path),
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    createReadStream(path).pipe(response);
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeAllConnections?.();
    }),
  };
}

/** The seeded control: both synced workers ignore any policy they receive. */
async function dropPolicy(workersRoot: string): Promise<void> {
  for (const file of ['javascript/javascript-worker.js', 'javascript/javascript-ses-algorithm-worker.js']) {
    const path = join(workersRoot, file);
    const source = await readFile(path, 'utf8');
    const seeded = source.replaceAll(
      'const judgedPolicy = normalizeJudgedOutputPolicy(policy);',
      'const judgedPolicy = null;'
    );
    if (seeded === source) throw new Error(`Seeded control could not find the policy in ${file}.`);
    await writeFile(path, seeded);
  }
}

function check(results: Result[]): string[] {
  const failures: string[] = [];
  const expect = (condition: boolean, message: string, detail?: unknown) => {
    if (!condition) failures.push(`${message}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  };
  expect(results.length === 8, 'eight configurations ran', results.length);
  for (const result of results) {
    const label = `${result.language}/${result.execution}/${result.lowered ? 'seam' : 'default'}`;
    const row = (id: string) => result.rows.find((candidate) => candidate.id === id);
    const passed = (id: string) => {
      const found = row(id);
      expect(found?.status === 'completed' && found.verdict === 'passed', `${label} ${id} passes`, found);
      if (found && result.execution === 'ses-compartment-pool') {
        expect(found.fastBatch, `${label} ${id} ran on the SES pool`, found);
      }
      if (found && result.execution === 'disposable-worker') {
        expect(!found.fastBatch, `${label} ${id} ran on the disposable worker`, found);
      }
    };
    const limited = (id: string) => {
      const found = row(id);
      expect(
        found?.status !== 'completed' && found?.failure?.origin === 'limit' &&
          found.failure.reason === 'serialization-limit' && !found.hasValue,
        `${label} ${id} is a typed serialization-limit with no value`,
        found
      );
    };
    expect(result.evaluationStatus === 'completed', `${label} evaluation completed`, result.evaluationStatus);
    const markers = result.markers as Array<Record<string, unknown>>;
    expect(markers.length === 1, `${label} one judged-output-policy marker`, markers);
    expect(markers[0]?.language === result.language, `${label} marker language`, markers[0]);
    expect(markers[0]?.maxBytes === (result.lowered ? 1024 : DEFAULT_BYTES), `${label} marker carries the effective cap`, markers[0]);
    expect(markers[0]?.lowered === result.lowered, `${label} marker says whether the seam lowered it`, markers[0]);
    expect(markers[0]?.maxDepth === 64 && markers[0]?.maxItems === 250_000 && markers[0]?.maxNodes === 1_000_000,
      `${label} marker carries the other defaults`, markers[0]);
    if (result.lowered) {
      passed('ascii-64');
      limited('ascii-2048');
      passed('ascii-1022');
      limited('ascii-1023');
      limited('snow-400');
      passed('after-refusal');
    } else {
      passed('default-under');
      limited('default-over');
      passed('list-64');
      limited('list-65');
      limited('cycle');
      passed('shared');
      passed('after-refusal');
    }
  }
  return failures;
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-javascript-judged-output-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await runCommand('pnpm', ['generate:javascript-ses-worker'], process.cwd());
    await runCommand(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'sync-assets', join(tempRoot, 'workers'), '--languages', 'javascript'],
      process.cwd()
    );
    if (SEED === 'drop-policy') await dropPolicy(join(tempRoot, 'workers'));
    else if (SEED) throw new Error(`Unknown seed ${SEED}.`);
    await build({
      entryPoints: [resolve('tests/fixtures/javascript-judged-output-entry.ts')],
      outfile: join(tempRoot, 'entry.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      alias: {
        '@tracecode/tracekernel/workspace': resolve('packages/tracekernel/src/workspace/index.ts'),
        '@tracecode/tracekernel': resolve('packages/tracekernel/src/index.ts'),
        zlib: resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n');
    server = await startServer(resolve(tempRoot));
    const browser = await chromium.launch({ headless: true });
    let results: Result[];
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(300_000);
      page.on('pageerror', (error) => console.error(error.stack ?? error.message));
      page.on('requestfailed', (request) => console.error(
        `[browser request failed] ${request.url()} ${request.failure()?.errorText ?? ''}`
      ));
      await page.goto(`${server.origin}/`);
      results = await page.evaluate(async ({ origin }) => {
        const entry = await import(`${origin}/entry.mjs`);
        return entry.runJavaScriptJudgedOutputPolicy(`${origin}/workers`);
      }, { origin: server.origin }) as Result[];
    } finally {
      await browser.close();
    }
    const failures = check(results);
    console.log(JSON.stringify({ seed: SEED ?? null, results }, null, 1).slice(0, 20_000));
    if (SEED === 'drop-policy') {
      const caught = failures.some((failure) => failure.includes('ascii-2048 is a typed serialization-limit'));
      if (!caught) {
        console.error(`SEEDED CONTROL NOT CAUGHT: ${JSON.stringify(failures)}`);
        process.exitCode = 1;
        return;
      }
      console.log(`PASS: seeded control (policy dropped) caught by ${failures.length} assertions, including ascii-2048`);
      return;
    }
    if (failures.length > 0) {
      console.error(`FAIL: JavaScript judged-output policy\n${failures.join('\n')}`);
      process.exitCode = 1;
      return;
    }
    console.log('PASS: JavaScript and TypeScript judged-output policy on the SES pool and the disposable worker');
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

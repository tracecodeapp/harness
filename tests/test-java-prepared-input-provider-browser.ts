#!/usr/bin/env node
/**
 * A prepared Java input the Harness cannot build (a learner node constructor
 * that rejects the input's value, a reference to no node) is the provider's
 * failure, not the learner's: the Judge reports failure.origin 'provider'.
 * A failure in the learner's method stays origin 'program'. Real Java worker,
 * public BrowserJudgeHost, Chromium.
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
import type { ProviderOutcomeSample } from './fixtures/java-prepared-input-provider-entry';

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
  const root = resolve('.');
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-java-input-provider-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await runCommand('pnpm', ['exec', 'tsx', 'src/cli.ts', 'sync-assets', join(tempRoot, 'workers'), '--languages', 'java'], root);
    await build({
      absWorkingDir: root,
      entryPoints: [join(root, 'tests/fixtures/java-prepared-input-provider-entry.ts')],
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
      const samples = (await page.evaluate(async (options) => {
        const moduleUrl: string = '/entry.mjs';
        const module = await import(moduleUrl);
        return module.runJavaPreparedInputOutcomes(options);
      }, { assetBaseUrl: '/workers' })) as ProviderOutcomeSample[];
      assert.equal(samples.length, 4);
      for (const sample of samples) {
        const failure = sample.cases[0]?.failure;
        console.log(`${sample.label}: ${sample.cases[0]?.status} origin=${failure?.origin} reason=${failure?.reason} ${JSON.stringify(failure?.message ?? sample.error ?? '').slice(0, 200)}`);
        assert.equal(sample.error, undefined, `${sample.label}: ${sample.error}`);
        assert.equal(sample.status, 'completed', sample.label);
      }
      const [rejected, unknown, learner, unknownTraced] = samples;
      assert.equal(rejected?.cases[0]?.failure?.origin, 'provider', `constructor rejects the input: ${JSON.stringify(rejected?.cases[0])}`);
      assert.equal(unknown?.cases[0]?.failure?.origin, 'provider', `unknown reference: ${JSON.stringify(unknown?.cases[0])}`);
      assert.equal(learner?.cases[0]?.failure?.origin, 'program', `learner method throws: ${JSON.stringify(learner?.cases[0])}`);
      assert.equal(unknownTraced?.cases[0]?.failure?.origin, 'provider', `unknown reference, traced: ${JSON.stringify(unknownTraced?.cases[0])}`);
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('Java prepared inputs the Harness cannot build are provider failures in the Judge', main);

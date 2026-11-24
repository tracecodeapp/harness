#!/usr/bin/env npx tsx

// Real-worker C# observer prestart checks: the observer runner is booted and
// primed when its observation lease is prepared (CSHARP-FIX-FORWARD.md, Fix A).
// Needs materialized compiler and runner bundles (pnpm
// materialize:csharp-role-assets or pnpm update:csharp-runtime).
//
// TRACECODE_CSHARP_ROUTES_OUT=<file> writes the collected results as JSON.

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';

const ROOT = process.cwd();

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}

async function main(): Promise<void> {
  const runnerAssetPath = (
    process.env.TRACECODE_CSHARP_TEST_RUNNER_ASSET_PATH ?? 'workers/vendor/csharp-runner'
  ).replace(/^\/+/u, '');
  assertCondition(
    existsSync(join(ROOT, 'workers/vendor/csharp/_framework/dotnet.boot.js')) &&
      existsSync(join(ROOT, runnerAssetPath, '_framework/dotnet.boot.js')),
    'Expected explicit C# compiler and runner bundles; run pnpm materialize:csharp-role-assets.'
  );
  const { outputFiles: [entry] } = await build({
    entryPoints: [join(ROOT, 'tests/fixtures/csharp-observer-routes-entry.ts')],
    tsconfig: join(ROOT, 'tsconfig.base.json'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: {
      zlib: join(ROOT, 'packages/tracekernel/src/zlib-browser-shim.ts'),
      'node:zlib': join(ROOT, 'packages/tracekernel/src/zlib-browser-shim.ts'),
    },
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/csharp-observer-routes.mjs') {
      response.writeHead(200, { 'Content-Type': contentType(url.pathname) });
      response.end(entry.contents);
      return;
    }
    const candidate = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (candidate !== ROOT && !candidate.startsWith(`${ROOT}${sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const file = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!existsSync(file)) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentType(file),
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assertCondition(address && typeof address !== 'string', 'Expected server port.');
  const origin = `http://127.0.0.1:${address.port}`;
  const engineName = process.env.TRACECODE_CSHARP_BROWSER_ENGINE ?? 'chromium';
  const browserType = ({ chromium, firefox, webkit } as Record<string, BrowserType>)[engineName];
  assertCondition(browserType, `Unsupported C# browser engine: ${engineName}`);
  const results: Record<string, unknown> = { engine: engineName };
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/tests/fixtures/csharp-worker/blank.html`);
    {
      results.observerPrestart = await page.evaluate(async (runnerAssetPath) => {
        const moduleUrl: string = '/csharp-observer-routes.mjs';
        const { assertCSharpObserverPrestart } = await import(moduleUrl);
        return assertCSharpObserverPrestart('/workers/csharp/csharp-worker.js', '/' + runnerAssetPath);
      }, runnerAssetPath);
      console.log(`C# observer runner primed at lease prepare: ${JSON.stringify(results.observerPrestart)}`);
    }
  } finally {
    await browser.close();
    server.close();
    if (process.env.TRACECODE_CSHARP_ROUTES_OUT) {
      writeFileSync(process.env.TRACECODE_CSHARP_ROUTES_OUT, `${JSON.stringify(results, null, 2)}\n`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

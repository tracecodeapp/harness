#!/usr/bin/env npx tsx

// Traced C# builds decline conditional compilation; ordinary builds, Run
// verdicts and Submit are unchanged, and directives that cannot select code
// still draw. Real compiler, general and runner roles in a browser.
//
// TRACECODE_CSHARP_TRACE_DIRECTIVES_OUT=<path> writes the per-program report.

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';

const ROOT = process.cwd();
const ENTRY_PATH = '/csharp-trace-directives.mjs';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

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

async function main(): Promise<void> {
  const runnerAssetPath = (
    process.env.TRACECODE_CSHARP_TEST_RUNNER_ASSET_PATH ?? 'workers/vendor/csharp-runner'
  ).replace(/^\/+/u, '');
  assertCondition(
    runnerAssetPath.length > 0 && !runnerAssetPath.split('/').some((segment) => segment === '..'),
    'TRACECODE_CSHARP_TEST_RUNNER_ASSET_PATH must be a repository-relative path.'
  );
  assertCondition(
    existsSync(join(ROOT, 'workers/vendor/csharp/_framework/dotnet.boot.js')) &&
      existsSync(join(ROOT, runnerAssetPath, '_framework/dotnet.boot.js')),
    'Expected explicit C# compiler and runner bundles; run pnpm materialize:csharp-role-assets.'
  );

  const { outputFiles: [entry] } = await build({
    entryPoints: [join(ROOT, 'tests/fixtures/csharp-trace-directives-entry.ts')],
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

  const isolationHeaders = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === ENTRY_PATH) {
      response.writeHead(200, { 'Content-Type': contentType(url.pathname), ...isolationHeaders });
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
    response.writeHead(200, { 'Content-Type': contentType(file), ...isolationHeaders });
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
  const browserTypes: Record<string, BrowserType> = { chromium, firefox, webkit };
  const browserType = browserTypes[engineName];
  assertCondition(browserType, `Unsupported C# browser engine: ${engineName}`);
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/tests/fixtures/csharp-worker/blank.html`);
    const result = await page.evaluate(async ({ entryPath, runnerAssetPath }) => {
      const { runCSharpTraceDirectives } = await import(entryPath);
      return runCSharpTraceDirectives(
        '/workers/csharp/csharp-worker.js',
        '/workers/vendor/csharp',
        '/' + runnerAssetPath
      );
    }, { entryPath: ENTRY_PATH, runnerAssetPath }) as {
      reports: Array<{ name: string; expectation: string }>;
      failures: string[];
    };
    const out = process.env.TRACECODE_CSHARP_TRACE_DIRECTIVES_OUT;
    if (out) writeFileSync(out, `${JSON.stringify({ engine: engineName, ...result }, null, 2)}\n`);
    for (const report of result.reports) console.log(JSON.stringify(report));
    if (result.failures.length > 0) {
      throw new Error(`C# trace directive checks failed:\n${result.failures.join('\n')}`);
    }
    console.log(`C# trace directive checks passed on ${result.reports.length} programs (${engineName}).`);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

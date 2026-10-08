#!/usr/bin/env npx tsx

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

function assertCondition(condition: boolean, message: string): asserts condition {
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

async function syncPythonAssets(targetDirectory: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      resolve('node_modules/tsx/dist/cli.mjs'),
      resolve('src/cli.ts'),
      'sync-assets',
      targetDirectory,
      '--languages',
      'python,javascript',
    ], { cwd: process.cwd(), stdio: 'inherit' });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(
            `Asset sync failed with ${signal ? `signal ${signal}` : `exit code ${code}.`}`
          )
        );
      }
    });
  });
}

async function startStaticServer(root: string): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const candidate = normalize(
      join(root, decodeURIComponent(requestUrl.pathname))
    );
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const filePath = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!filePath || !existsSync(filePath)) {
      response.writeHead(404).end('Not found');
      return;
    }
    const stat = statSync(filePath);
    response.writeHead(200, {
      'Content-Length': String(stat.size),
      'Content-Type': contentType(filePath),
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    createReadStream(filePath).pipe(response);
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve Python test server address.');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }),
  };
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracekernel-chaining-'));
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    await syncPythonAssets(join(tempRoot, 'workers'));
    await build({ stdin: { contents: `export { createBrowserProjectWorkspace } from './packages/runtime-browser/src/project'; export { createRuntimeCommandStdinPipeFromText } from './packages/runtime-contracts/src/index';`, resolveDir: process.cwd() }, outfile: join(tempRoot, 'fixture.mjs'), bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], logLevel: 'warning', alias: { zlib: resolve('packages/tracekernel/src/zlib-browser-shim.ts'), 'node:zlib': resolve('packages/tracekernel/src/zlib-browser-shim.ts') }, define: { 'process.env.NODE_ENV': '"production"' } });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">');
    server = await startStaticServer(tempRoot);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(120_000);
      page.on('pageerror', error => console.error('pageerror', error.message));
      await page.goto(server.origin);
      await page.evaluate('globalThis.__name = (fn) => fn');
      const results = await page.evaluate(async () => {
        // @ts-expect-error Browser-generated module.
        const { createBrowserProjectWorkspace, createRuntimeCommandStdinPipeFromText } = await import('/fixture.mjs');
        const workspace = await createBrowserProjectWorkspace({ assetBaseUrl: '/workers', providers: ['javascript', 'python'], nodeProjectTimeoutMs: 10000, pythonProjectTimeoutMs: 10000, kernel: { scheduler: { maxConcurrentCommands: 1 } }, files: [
          { path: 'sum.js', contents: 'console.log("JS 55")' },
          { path: 'sum.py', contents: 'print("PY 55")' },
          { path: 'fail.js', contents: 'console.log("failed"); process.exit(7)' },
          { path: 'fail.py', contents: 'import sys\nprint("failed")\nsys.exit(7)' },
          { path: 'nested.sh', contents: 'node sum.js && python sum.py' },
        ] });
        const receipts = [];
        try {
          for (const [command, expected] of [
            ['node sum.js && python sum.py', 'JS 55\nPY 55\n'],
            ['python sum.py && node sum.js', 'PY 55\nJS 55\n'],
            ['node sum.js && node sum.js', 'JS 55\nJS 55\n'],
            ['python sum.py && python sum.py', 'PY 55\nPY 55\n'],
            ['node fail.js || node sum.js', 'failed\nJS 55\n'],
            ['python fail.py || python sum.py', 'failed\nPY 55\n'],
            ['node sum.js | python sum.py', 'PY 55\n'],
            ['bash nested.sh', 'JS 55\nPY 55\n'],
          ]) {
            const started = performance.now();
            const result = await workspace.runCommand(command, { presentation: 'terminal' });
            receipts.push({ command, expected, elapsedMs: Math.round(performance.now()-started), ...result });
          }
        } finally { workspace.dispose(); }
        return receipts;
      });
      console.log(JSON.stringify(results, null, 2));
      await writeFile(resolve('chaining-browser-receipts.json'), JSON.stringify(results, null, 2));
      for (const result of results) assertCondition(result.exitCode === 0 && !result.error && result.stdout === result.expected, `chaining failure ${JSON.stringify(result)}`);
    } finally { await browser.close(); }
  } finally { await server?.close(); await rm(tempRoot, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

#!/usr/bin/env npx tsx

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracekernel-stdin-'));
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    await syncPythonAssets(join(tempRoot, 'workers'));
    await build({ stdin: { contents: `export { createBrowserProjectWorkspace } from './packages/runtime-browser/src/project'; export { createRuntimeCommandStdinPipe, createRuntimeCommandStdinPipeFromText } from './packages/runtime-contracts/src/index';`, resolveDir: process.cwd() }, outfile: join(tempRoot, 'fixture.mjs'), bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], logLevel: 'warning', alias: { zlib: resolve('packages/tracekernel/src/zlib-browser-shim.ts'), 'node:zlib': resolve('packages/tracekernel/src/zlib-browser-shim.ts') }, define: { 'process.env.NODE_ENV': '"production"' } });
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
        const { createBrowserProjectWorkspace, createRuntimeCommandStdinPipe, createRuntimeCommandStdinPipeFromText } = await import('/fixture.mjs');
        const workspace = await createBrowserProjectWorkspace({ assetBaseUrl: '/workers', providers: ['javascript', 'python'], nodeProjectTimeoutMs: 10000, pythonProjectTimeoutMs: 10000, files: [
          { path: 'input.js', contents: 'const fs=require("fs"); const s=fs.readFileSync(0,"utf8"); console.log("OUT:"+Buffer.from(s).toString("hex")); console.error("ERR:"+Buffer.from(s).toString("hex"));' },
          { path: 'input.py', contents: 'import sys\ns=sys.stdin.read()\nprint("OUT:"+s.encode().hex())\nprint("ERR:"+s.encode().hex(),file=sys.stderr)' },
          { path: 'live.js', contents: 'const fs=require("fs");console.log("READY");const s=fs.readFileSync(0,"utf8");console.log("OUT:"+Buffer.from(s).toString("hex"));console.error("ERR:"+Buffer.from(s).toString("hex"));' },
          { path: 'live.py', contents: 'import sys\nprint("READY",flush=True)\ns=sys.stdin.read()\nprint("OUT:"+s.encode().hex())\nprint("ERR:"+s.encode().hex(),file=sys.stderr)' },
          { path: 'data.txt' , contents: 'file\n' }, { path: 'empty.txt', contents: '' },
        ] });
        const receipts = [];
        try {
          for (const executable of ['node input.js', 'python input.py']) {
            for (const input of ['hello\n', '', 'café 東京 😀\n']) {
              const started = performance.now();
              const result = await workspace.runCommand(executable, { presentation: 'terminal', stdinPipe: createRuntimeCommandStdinPipeFromText(input) });
              receipts.push({ command: executable, input, elapsedMs: Math.round(performance.now()-started), ...result });
            }
            for (const command of [`printf 'hello\\n' | ${executable}`, `printf '' | ${executable}`, `${executable} < data.txt`, `${executable} < empty.txt`, `cmd=${executable.split(' ')[0]}; printf '' | $cmd ${executable.split(' ')[1]}`, `printf '' | (${executable})`, `printf '' | command ${executable}`, `printf '' | command command ${executable}`]) {
              const started = performance.now();
              const result = await workspace.runCommand(command, { presentation: 'terminal' });
              receipts.push({ command, elapsedMs: Math.round(performance.now()-started), ...result });
            }
            receipts.push({ command: `printf 'café\\n' | command ${executable}`, input: 'café\n', ...await workspace.runCommand(`printf 'café\\n' | command ${executable}`, { presentation: 'terminal' }) });
            receipts.push({ command: `printf 'first\\n' | ${executable}; printf 'second\\n' | ${executable}`, laterInput: true, ...await workspace.runCommand(`printf 'first\\n' | ${executable}; printf 'second\\n' | ${executable}`, { presentation: 'terminal' }) });
            const liveCommand = executable.replace('input.', 'live.');
            const livePipe = createRuntimeCommandStdinPipe();
            let ready = false;
            const liveResult = await workspace.runCommand(liveCommand, {
              presentation: 'terminal', stdinPipe: livePipe,
              onEvent: (event: { type: string; data?: string }) => {
                if (!ready && event.type === 'output' && event.data?.includes('READY')) {
                  ready = true; livePipe.write('live\n'); livePipe.close();
                }
              },
            });
            if (!ready) throw new Error('runtime never requested live input');
            receipts.push({ command: liveCommand, input: 'live\n', live: true, ...liveResult });
            const controller = new AbortController();
            const cancelResult = await workspace.runCommand(liveCommand, {
              presentation: 'terminal', stdinPipe: createRuntimeCommandStdinPipe(), signal: controller.signal,
              onEvent: (event: { type: string; data?: string }) => {
                if (event.type === 'output' && event.data?.includes('READY')) controller.abort();
              },
            });
            receipts.push({ command: liveCommand, cancelled: true, ...cancelResult });
            receipts.push({ command: executable, recovery: true, ...await workspace.runCommand(executable, { presentation: 'terminal', stdinPipe: createRuntimeCommandStdinPipeFromText('again\n') }) });
          }
        } finally { workspace.dispose(); }
        return receipts;
      });
      console.log(JSON.stringify(results, null, 2));
      const receiptPath = process.env.TRACECODE_STDIN_RECEIPT_PATH;
      if (receiptPath) {
        await mkdir(resolve(receiptPath, '..'), { recursive: true });
        await writeFile(receiptPath, JSON.stringify(results, null, 2));
      }
      for (const result of results) {
        if (result.laterInput) {
          assertCondition(result.exitCode === 0 && result.stdout === 'OUT:66697273740a\nOUT:7365636f6e640a\n' && result.stderr === 'ERR:66697273740a\nERR:7365636f6e640a\n', `later input failure ${JSON.stringify(result)}`);
          continue;
        }
        if (result.cancelled) { assertCondition(result.exitCode !== 0, 'blocked stdin cancellation must terminate'); continue; }
        const expectedInput = result.recovery ? 'again\n' : result.input !== undefined ? result.input : result.command.includes('data.txt') ? 'file\n' : result.command.includes("'hello") ? 'hello\n' : '';
        assertCondition(result.exitCode === 0 && !result.error && result.stdout === `${result.live ? "READY\n" : ""}OUT:${Buffer.from(expectedInput).toString("hex")}\n` && result.stderr === `ERR:${Buffer.from(expectedInput).toString("hex")}\n`, `stdin failure ${JSON.stringify(result)}`);
      }
    } finally { await browser.close(); }
  } finally { await server?.close(); await rm(tempRoot, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

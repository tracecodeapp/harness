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
      'python',
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
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracekernel-013-python-'));
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    await syncPythonAssets(join(tempRoot, 'workers'));
    await build({
      entryPoints: [resolve('packages/harness-browser/src/project.ts')],
      outfile: join(tempRoot, 'project-harness.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      logLevel: 'warning',
      alias: {
        zlib: resolve('packages/harness-project/src/zlib-browser-shim.ts'),
        'node:zlib': resolve('packages/harness-project/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    await writeFile(
      join(tempRoot, 'index.html'),
      '<!doctype html><meta charset="utf-8">\n'
    );
    server = await startStaticServer(tempRoot);

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(180_000);
      const browserErrors: string[] = [];
      page.on('pageerror', (error) => browserErrors.push(error.message));
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
      await page.evaluate('globalThis.__name = (fn) => fn');
      const result = await page.evaluate(async () => {
        // @ts-expect-error Generated into the browser test server.
        const { createBrowserProjectWorkspace } = await import('/project-harness.mjs');
        const workspace = await createBrowserProjectWorkspace({
          assetBaseUrl: '/workers',
          providers: ['python'],
          projectWorkerIsolation: 'per-command',
          pythonProjectTimeoutMs: 120_000,
          files: [
            {
              path: 'watchdog-control.py',
              contents: [
                'from tracekernel import watchdog',
                'armed = watchdog.arm(5000, signal="SIGKILL")',
                'status = watchdog.status()',
                'petted = watchdog.pet()',
                'disarmed = watchdog.disarm()',
                'valid = (',
                '    armed.armed and armed.timeout_ms == 5000 and armed.signal == "SIGKILL"',
                '    and status.armed and status.deadline_at == armed.deadline_at',
                '    and petted.armed and petted.deadline_at >= armed.deadline_at',
                '    and not disarmed.armed and not watchdog.status().armed',
                ')',
                'print(f"watchdog:{str(valid).lower()}")',
                '',
              ].join('\n'),
            },
            {
              path: 'watchdog-expire.py',
              contents: [
                'from tracekernel import watchdog',
                'watchdog.arm(40, signal="SIGKILL")',
                'while True:',
                '    pass',
                '',
              ].join('\n'),
            },
          ],
        });
        try {
          return {
            control: await workspace.runCommand('python watchdog-control.py'),
            expiry: await workspace.runCommand('python watchdog-expire.py'),
          };
        } finally {
          workspace.dispose();
        }
      });

      assertCondition(
        result.control.exitCode === 0 &&
          result.control.stdout === 'watchdog:true\n',
        `Python watchdog controls did not cross the TraceKernel syscall channel: ${JSON.stringify(result.control)}`
      );
      assertCondition(
        result.expiry.exitCode === 137 &&
          result.expiry.error?.detail?.signal === 'SIGKILL',
        `Python watchdog expiry was not kernel-enforced: ${JSON.stringify(result.expiry)}`
      );
      assertCondition(
        browserErrors.length === 0,
        `Python browser conformance emitted unexpected errors: ${JSON.stringify(browserErrors)}`
      );
      console.log(JSON.stringify({
        schema: 'tracekernel-013-python-conformance-v1',
        synchronousSyscallTransport: true,
        watchdogControls: true,
        watchdogExpirySignal: 'SIGKILL',
      }));
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

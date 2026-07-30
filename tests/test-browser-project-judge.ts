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

async function syncAssets(targetDirectory: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      resolve('node_modules/tsx/dist/cli.mjs'),
      resolve('src/cli.ts'),
      'sync-assets',
      targetDirectory,
      '--languages',
      'javascript',
    ], { cwd: process.cwd(), stdio: 'inherit' });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(
            `Asset sync failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`
          )
        );
      }
    });
  });
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

async function startStaticServer(root: string): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const candidate = normalize(join(root, decodeURIComponent(requestUrl.pathname)));
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
    throw new Error('Unable to resolve browser Judge server address.');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }),
  };
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-browser-project-judge-'));
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    await syncAssets(join(tempRoot, 'workers'));
    await build({
      entryPoints: [resolve('tests/fixtures/browser-project-judge-entry.ts')],
      outfile: join(tempRoot, 'project-judge.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      alias: {
        zlib: resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    });
    await writeFile(
      join(tempRoot, 'index.html'),
      '<!doctype html><meta charset="utf-8">\n',
      'utf8'
    );
    server = await startStaticServer(resolve(tempRoot));
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(60_000);
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
      const result = await page.evaluate(async () => {
        const moduleUrl: string = '/project-judge.mjs';
        const module = await import(moduleUrl);
        return module.runBrowserProjectJudge('/workers');
      }) as {
        execution: string;
        verdict: string;
        receipt?: {
          changedPaths: string[];
          steps: Array<{
            process: {
              sessionId: string;
              stdout: string;
              termination: { exitCode: number };
            };
          }>;
        };
      };
      assertCondition(result.execution === 'completed', 'Browser project Judge did not complete.');
      assertCondition(result.verdict === 'passed', 'Browser project Judge did not pass.');
      assertCondition(
        result.receipt?.changedPaths.join(',') === '/workspace/src/value.js',
        `Unexpected changed paths: ${JSON.stringify(result.receipt?.changedPaths)}`
      );
      assertCondition(
        result.receipt.steps[0]!.process.stdout.includes('repository tests passed'),
        'Submission repository test output was not captured.'
      );
      assertCondition(
        result.receipt.steps[1]!.process.termination.exitCode !== 0,
        'Starter overlay replay did not fail.'
      );
      assertCondition(
        result.receipt.steps[0]!.process.sessionId !==
          result.receipt.steps[1]!.process.sessionId,
        'Project Judge reused a TraceKernel workspace across isolated steps.'
      );
    } finally {
      await browser.close();
    }
    console.log('Browser project Judge conformance passed.');
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

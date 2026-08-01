#!/usr/bin/env npx tsx

import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from './example-app-smoke';

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
    response.writeHead(200, {
      'Content-Length': String(statSync(filePath).size),
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
    throw new Error('Unable to resolve browser algorithm Judge server address.');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      }),
  };
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(
    join(tmpdir(), 'tracecode-browser-algorithm-batch-')
  );
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    await runCommand(
      'pnpm',
      [
        'exec',
        'tsx',
        'src/cli.ts',
        'sync-assets',
        join(tempRoot, 'workers'),
        '--languages',
        'python',
      ],
      process.cwd()
    );
    await build({
      entryPoints: [
        resolve('tests/fixtures/browser-algorithm-batch-entry.ts'),
      ],
      outfile: join(tempRoot, 'algorithm-batch.mjs'),
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
      page.setDefaultTimeout(120_000);
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
      const result = await page.evaluate(async () => {
        const moduleUrl: string = '/algorithm-batch.mjs';
        const module = await import(moduleUrl);
        return module.runBrowserAlgorithmBatch('/workers');
      }) as {
        verdict: string;
        caseVerdicts: string[];
        sessionIds: string[];
        plainWorkerUrls: string[];
        traceVerdict: string;
        traceCaseVerdicts: string[];
        traceSessionIds: string[];
        traceWorkerUrls: string[];
      };

      assertCondition(
        result.verdict === 'passed' &&
          result.caseVerdicts.length === 10 &&
          result.caseVerdicts.every((verdict) => verdict === 'passed'),
        `Browser algorithm batch did not pass all ten cases: ${JSON.stringify(result)}`
      );
      assertCondition(
        new Set(result.sessionIds).size === 1,
        `Browser algorithm batch did not use one TraceKernel batch process: ${JSON.stringify(result.sessionIds)}`
      );
      assertCondition(
        result.plainWorkerUrls.length === 2 &&
          result.plainWorkerUrls.every((url) => url.includes('python-worker.js')),
        `Python algorithm batch should construct one compiler and one execution worker: ${JSON.stringify(result.plainWorkerUrls)}`
      );
      assertCondition(
        result.traceVerdict === 'passed' &&
          result.traceCaseVerdicts.length === 10 &&
          result.traceCaseVerdicts.every((verdict) => verdict === 'passed'),
        `Browser trace batch did not pass all ten cases: ${JSON.stringify(result)}`
      );
      assertCondition(
        new Set(result.traceSessionIds).size === 1,
        `Browser trace batch did not use one TraceKernel batch process: ${JSON.stringify(result.traceSessionIds)}`
      );
      assertCondition(
        result.traceWorkerUrls.length === 2 &&
          result.traceWorkerUrls.every((url) => url.includes('python-worker.js')),
        `Python trace batch should construct one compiler and one execution worker: ${JSON.stringify(result.traceWorkerUrls)}`
      );
    } finally {
      await browser.close();
    }
    console.log(
      'Browser algorithm Judge code and trace batches each passed with one compiler and one execution worker.'
    );
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

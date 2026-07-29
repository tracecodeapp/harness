#!/usr/bin/env npx tsx

import { createServer } from 'node:http';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';
import {
  assertTraceKernelTraceJVMResult,
} from './fixtures/tracekernel-tracejvm-result';

type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

const browserTypes: Record<BrowserEngine, BrowserType> = {
  chromium,
  firefox,
  webkit,
};

function contentType(path: string): string {
  if (path.endsWith('.wasm')) return 'application/wasm';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.jar')) return 'application/java-archive';
  return 'application/octet-stream';
}

const traceJVMRoot = resolve(
  process.env.TRACECODE_TRACEJVM_ROOT ?? '../tracejvm'
);
const temporaryDirectory = mkdtempSync(
  join(tmpdir(), 'tracekernel-tracejvm-browser-')
);
const bundlePath = join(temporaryDirectory, 'test.js');

try {
  await build({
    entryPoints: [
      resolve('tests/fixtures/tracekernel-tracejvm-browser-entry.ts'),
    ],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: bundlePath,
    logLevel: 'silent',
    alias: {
      '@tracecode/tracejvm': resolve(traceJVMRoot, 'src/index.ts'),
    },
  });
  const bundle = readFileSync(bundlePath);
  const server = createServer((request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    if (request.url === '/test.js') {
      response.setHeader('content-type', 'text/javascript; charset=utf-8');
      response.end(bundle);
      return;
    }
    if (request.url === '/workers/javascript-project-worker.js') {
      response.setHeader('content-type', 'text/javascript; charset=utf-8');
      response.end(
        readFileSync(
          resolve('workers/javascript/javascript-project-worker.js')
        )
      );
      return;
    }
    if (request.url?.startsWith('/tracejvm/')) {
      const requested = request.url.slice('/tracejvm/'.length);
      const relative = requested === 'browser-worker.js'
        ? 'dist/browser-worker.js'
        : `runtime/assets/${requested}`;
      const path = normalize(join(traceJVMRoot, relative));
      if (
        !path.startsWith(`${traceJVMRoot}/`) ||
        !statSync(path).isFile()
      ) {
        response.statusCode = 404;
        response.end('not found');
        return;
      }
      response.setHeader('content-type', contentType(path));
      response.end(readFileSync(path));
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><script src="/test.js"></script>');
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('TraceJVM browser test server did not bind.');
  }
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const requestedEngines = (
      process.env.TRACECODE_TRACEJVM_ENGINES ?? 'chromium,firefox,webkit'
    ).split(',') as BrowserEngine[];
    for (const engine of requestedEngines) {
      const browserType = browserTypes[engine];
      if (!browserType) throw new Error(`Unknown browser engine: ${engine}`);
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(origin);
        const result = await page.evaluate(async () => {
          if (!globalThis.runTraceKernelTraceJVMTest) {
            throw new Error('TraceJVM browser fixture did not initialize.');
          }
          return globalThis.runTraceKernelTraceJVMTest();
        });
        assertTraceKernelTraceJVMResult(result);
        console.log(
          `PASS: TraceJVM is process-isolated and restartable through TraceKernel in ${engine}`
        );
      } finally {
        await browser.close();
      }
    }
  } finally {
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

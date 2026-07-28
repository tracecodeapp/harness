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
  join(tmpdir(), 'tracekernel-013-tracejvm-browser-')
);
const bundlePath = join(temporaryDirectory, 'test.js');

try {
  await build({
    entryPoints: [
      resolve('tests/fixtures/tracekernel-013-tracejvm-browser-entry.ts'),
    ],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: bundlePath,
    logLevel: 'silent',
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
        const reportStatuses = result.reports.map(
          (report) => `${report.source}:${report.status}:${report.isolation}`
        );
        if (
          result.compile.exitCode !== 0 ||
          result.classFileBase64.length === 0 ||
          result.firstRun.exitCode !== 0 ||
          result.firstRun.stdout !== '1:first:missing:first\n' ||
          result.secondRun.exitCode !== 0 ||
          result.secondRun.stdout !== '1:missing:missing:second\n' ||
          result.filesystemRun.exitCode !== 0 ||
          result.filesystemRun.stdout !==
            'fs:js-before-java:nested:true:abZd:3:random.bin:true:true\n' ||
          result.sharedFile !== 'js-before-java|java' ||
          result.randomFile !== 'abZd' ||
          result.stdinRun.exitCode !== 0 ||
          result.stdinRun.stdout !== 'stdin:hello\n' ||
          result.socketRun.exitCode !== 0 ||
          result.socketRun.stdout !== 'socket:pong\n' ||
          result.processRun.exitCode !== 0 ||
          !/^process:\d+:true:true:true:1:true:false:java-child\n$/u.test(
            result.processRun.stdout
          ) ||
          result.childFile !== 'java-child' ||
          result.interrupted.exitCode !== 130 ||
          result.interrupted.stderr !== '' ||
          result.restarted.exitCode !== 0 ||
          result.restarted.stdout !== '1:missing:missing:restarted\n' ||
          result.workerCount !== 10 ||
          !reportStatuses.includes('compile:completed:not-applicable') ||
          !reportStatuses.includes('run:runtime-error:clean') ||
          !reportStatuses.includes('run:completed:tainted') ||
          reportStatuses.filter(
            (status) => status === 'run:completed:clean'
          ).length !== 5
        ) {
          throw new Error(
            `${engine} failed the TraceKernel/TraceJVM adapter boundary: ${JSON.stringify(result)}`
          );
        }
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

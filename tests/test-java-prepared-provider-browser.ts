#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import {
  chromium,
  firefox,
  webkit,
  type BrowserType,
} from 'playwright';

type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

interface PreparedBrowserResult {
  createdWorkers: number;
  terminatedWorkers: number;
  isolationOutputs: unknown[];
  listOutput: unknown;
  opsOutput: unknown;
  traceOutput: unknown;
  traceKinds: string[];
  traceParity: boolean;
  executionCompileMs: number[];
  executionWorkerDeltas: number[];
  aborted: boolean;
}

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

function safeFile(root: string, relative: string): string | undefined {
  const path = normalize(join(root, relative));
  if (!path.startsWith(`${normalize(root)}${sep}`)) return undefined;
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

function assertPreparedResult(
  result: PreparedBrowserResult,
  engine: BrowserEngine,
  isolated: boolean
): void {
  assert.equal(
    result.isolationOutputs.length,
    2,
    `${engine}: the complete mutable process-boundary probe must execute twice`
  );
  assert.equal(
    result.isolationOutputs[0],
    result.isolationOutputs[1],
    `${engine}: class initialization, statics, locale, time zone, working directory, environment, properties, standard streams, thread state, shutdown hooks, and runtime files must begin identically`
  );
  const boundaryFields = String(result.isolationOutputs[0]).split('|');
  assert.equal(
    boundaryFields[0],
    '101',
    `${engine}: static fields and class initialization must reset per case`
  );
  assert.equal(
    boundaryFields[4],
    'missing',
    `${engine}: custom System properties must not cross cases`
  );
  assert.equal(
    boundaryFields[5],
    'missing',
    `${engine}: arbitrary runtime filesystem writes must not cross cases`
  );
  assert.equal(
    boundaryFields[6],
    '0',
    `${engine}: background Java threads must not leak into the next case`
  );
  assert.equal(
    boundaryFields[11],
    'true',
    `${engine}: standard input and error streams must reset per case`
  );
  assert.equal(
    result.listOutput,
    70,
    `${engine}: prepared arrays, generic collections/maps, nodes, custom objects, builders, and enums must be materialized`
  );
  assert.deepEqual(
    result.opsOutput,
    [null, 7, null, 2],
    `${engine}: prepared operation-class calls must preserve one-case object state`
  );
  assert.equal(
    result.traceOutput,
    6,
    `${engine}: prepared tracing must preserve the legacy result`
  );
  assert.equal(
    result.traceParity,
    true,
    `${engine}: prepared and legacy Java traces must have the same observable shape`
  );
  assert.ok(
    result.traceKinds.includes('line') &&
      result.traceKinds.includes('return'),
    `${engine}: prepared tracing must emit semantic line and return events`
  );
  assert.ok(
    result.executionCompileMs.length >= 5 &&
      result.executionCompileMs.every((value) => value === 0),
    `${engine}: isolated executions must not report compilation work`
  );
  assert.ok(
    result.executionWorkerDeltas.length >= 6 &&
      (
        isolated
          ? result.executionWorkerDeltas.every((value) => value === 0)
          : result.executionWorkerDeltas.some((value) => value > 0)
      ),
    isolated
      ? `${engine}: kernel-bound Java cases must replace inner JVMs without replacing the warm compiler Worker`
      : `${engine}: compatibility execution without synchronous kernel transport must retire physical Workers`
  );
  assert.equal(
    result.aborted,
    true,
    `${engine}: cancellation must abort a running prepared Java case`
  );
  assert.equal(
    result.terminatedWorkers,
    result.createdWorkers,
    `${engine}: every Java worker owned by the test must terminate exactly once`
  );
}

const traceJVMRoot = resolve(
  process.env.TRACECODE_TRACEJVM_ROOT ?? '../tracejvm'
);
const temporaryDirectory = mkdtempSync(
  join(tmpdir(), 'java-prepared-provider-browser-')
);
const bundlePath = join(temporaryDirectory, 'test.js');

try {
  await build({
    entryPoints: [
      resolve('tests/fixtures/java-prepared-provider-browser-entry.ts'),
    ],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const bundle = readFileSync(bundlePath);
  const staticRoutes = new Map<string, string>([
    [
      '/workers/java-runtime-worker.js',
      resolve('workers/java/java-runtime-worker.js'),
    ],
    ['/workers/java-worker.js', resolve('workers/java/java-worker.js')],
    [
      '/workers/java-source-augmentations.js',
      resolve('workers/java/java-source-augmentations.js'),
    ],
    [
      '/workers/shared/tracekernel-syscall-client.js',
      resolve('workers/shared/tracekernel-syscall-client.js'),
    ],
    [
      '/workers/shared/runtime-kernel-policy-classic.js',
      resolve('workers/shared/runtime-kernel-policy-classic.js'),
    ],
    [
      '/workers/vendor/java-browser-helper.jar',
      resolve('workers/vendor/java-browser-helper.jar'),
    ],
  ]);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('isolated') !== 'false') {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (url.pathname === '/test.js') {
      response.setHeader('content-type', 'text/javascript; charset=utf-8');
      response.end(bundle);
      return;
    }

    const staticPath = staticRoutes.get(url.pathname);
    if (staticPath) {
      response.setHeader('content-type', contentType(staticPath));
      response.end(readFileSync(staticPath));
      return;
    }

    if (url.pathname.startsWith('/tracejvm/')) {
      const requested = url.pathname.slice('/tracejvm/'.length);
      const relative =
        requested === 'browser-client.js'
          ? 'dist/browser-client.js'
          : requested === 'browser-worker.js'
            ? 'dist/browser-worker.js'
            : `runtime/assets/${requested}`;
      const path = safeFile(traceJVMRoot, relative);
      if (!path) {
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
    throw new Error('Java prepared-provider browser server did not bind.');
  }
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const requestedEngines = (
      process.env.TRACECODE_JAVA_PREPARED_ENGINES ??
      'chromium,firefox,webkit'
    )
      .split(',')
      .map((engine) => engine.trim())
      .filter(Boolean) as BrowserEngine[];

    for (const engine of requestedEngines) {
      const browserType = browserTypes[engine];
      if (!browserType) throw new Error(`Unknown browser engine: ${engine}`);
      const isolationModes = engine === 'chromium' ? [true, false] : [true];
      for (const isolated of isolationModes) {
        const browser = await browserType.launch({ headless: true });
        try {
          const page = await browser.newPage();
          const browserMessages: string[] = [];
          page.on('console', (message) => {
            if (message.type() === 'error') {
              browserMessages.push(`[console] ${message.text()}`);
            }
          });
          page.on('pageerror', (error) => {
            browserMessages.push(`[pageerror] ${error.message}`);
          });
          await page.goto(`${origin}?isolated=${isolated}`);
          assert.equal(
            await page.evaluate(() => globalThis.crossOriginIsolated),
            isolated,
            `${engine}: test document must exercise the requested isolation mode`
          );
          const result = await page.evaluate(async () => {
            if (!globalThis.runJavaPreparedProviderBrowserTest) {
              throw new Error(
                'Java prepared-provider browser fixture did not initialize.'
              );
            }
            return globalThis.runJavaPreparedProviderBrowserTest();
          });
          try {
            assertPreparedResult(result, engine, isolated);
          } catch (error) {
            if (browserMessages.length > 0) {
              console.error(browserMessages.join('\n'));
            }
            throw error;
          }
          console.log(
            `PASS: Java prepared provider compiles once and isolates every case in ${engine} (${isolated ? 'cross-origin isolated' : 'ordinary document'})`
          );
        } finally {
          await browser.close();
        }
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

import { createServer } from 'node:http';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import type {
  JavaExecutionStyle,
  JavaWorkerTraceResult,
} from '../../packages/runtime-java/src/java-worker-client';
import type {
  TraceExecutionOptions,
} from '../../packages/runtime-contracts/src/runtime-types';

interface CheerpJSemanticTraceRequest {
  code: string;
  functionName: string;
  inputs: Record<string, unknown>;
  traceOptions?: TraceExecutionOptions;
  executionStyle: JavaExecutionStyle;
}

declare global {
  var runCheerpJSemanticTrace:
    | ((request: CheerpJSemanticTraceRequest) => Promise<JavaWorkerTraceResult>)
    | undefined;
  var closeCheerpJSemanticTrace: (() => void) | undefined;
}

export interface CheerpJSemanticTraceRuntime {
  executeWithTracing(
    request: CheerpJSemanticTraceRequest,
  ): Promise<JavaWorkerTraceResult>;
  close(): Promise<void>;
}

type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

const browserTypes = {
  chromium,
  firefox,
  webkit,
};

const servedAssets = new Map<string, string>([
  ['/workers/java/java-worker.js', resolve('workers/java/java-worker.js')],
  [
    '/workers/java/java-source-augmentations.js',
    resolve('workers/java/java-source-augmentations.js'),
  ],
  [
    '/workers/shared/runtime-kernel-policy-classic.js',
    resolve('workers/shared/runtime-kernel-policy-classic.js'),
  ],
  [
    '/workers/vendor/java-browser-helper.jar',
    resolve('workers/vendor/java-browser-helper.jar'),
  ],
  [
    '/workers/vendor/jdk.compiler-17.jar',
    resolve('workers/vendor/jdk.compiler-17.jar'),
  ],
  [
    '/workers/vendor/java-rewriter.jar',
    resolve('workers/vendor/java-rewriter.jar'),
  ],
  [
    '/workers/vendor/javaparser-core-3.25.10.jar',
    resolve('workers/vendor/javaparser-core-3.25.10.jar'),
  ],
]);

function contentType(path: string): string {
  if (extname(path) === '.jar') return 'application/java-archive';
  if (extname(path) === '.js') return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

function selectedBrowser(): BrowserEngine {
  const requested = process.env.TRACECODE_CHEERPJ_BROWSER ?? 'chromium';
  if (requested === 'chromium' || requested === 'firefox' || requested === 'webkit') {
    return requested;
  }
  throw new Error(`Unsupported TRACECODE_CHEERPJ_BROWSER: ${requested}`);
}

async function launchPage(
  origin: string,
  engine: BrowserEngine,
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    browser = await browserTypes[engine].launch({ headless: true });
    context = await browser.newContext();
    const page = await context.newPage();
    if (process.env.TRACECODE_RUNTIME_TRACE_PROGRESS === '1') {
      page.on('console', (message) => {
        console.log(`[cheerpj-browser:${message.type()}] ${message.text()}`);
      });
      page.on('pageerror', (error) => {
        console.error(`[cheerpj-browser:pageerror] ${error.message}`);
      });
    }
    await page.goto(origin);
    await page.waitForFunction(
      () => typeof globalThis.runCheerpJSemanticTrace === 'function',
    );
    return { browser, context, page };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    throw error;
  }
}

export async function createCheerpJSemanticTraceRuntime(
): Promise<CheerpJSemanticTraceRuntime> {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'cheerpj-semantic-trace-'));
  const bundlePath = join(temporaryDirectory, 'cheerpj-semantic-trace.js');
  await build({
    entryPoints: [resolve('tests/fixtures/cheerpj-semantic-trace-browser-entry.ts')],
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
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
      if (request.url === '/cheerpj-semantic-trace.js') {
        response.setHeader('content-type', 'text/javascript; charset=utf-8');
        response.end(bundle);
        return;
      }
      const requestPath = request.url
        ? new URL(request.url, 'http://127.0.0.1').pathname
        : undefined;
      const assetPath = requestPath ? servedAssets.get(requestPath) : undefined;
      if (assetPath) {
        const normalizedPath = normalize(assetPath);
        if (!statSync(normalizedPath).isFile()) {
          response.statusCode = 404;
          response.end('not found');
          return;
        }
        const bytes = readFileSync(normalizedPath);
        response.setHeader('content-type', contentType(normalizedPath));
        response.setHeader('accept-ranges', 'bytes');
        const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/u);
        if (range) {
          const requestedStart = range[1] ? Number.parseInt(range[1], 10) : 0;
          const requestedEnd = range[2]
            ? Number.parseInt(range[2], 10)
            : bytes.length - 1;
          const start = Math.max(0, Math.min(requestedStart, bytes.length - 1));
          const end = Math.max(start, Math.min(requestedEnd, bytes.length - 1));
          response.statusCode = 206;
          response.setHeader('content-range', `bytes ${start}-${end}/${bytes.length}`);
          response.setHeader('content-length', end - start + 1);
          response.end(bytes.subarray(start, end + 1));
          return;
        }
        response.setHeader('content-length', bytes.length);
        response.end(bytes);
        return;
      }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(
        '<!doctype html><script src="/cheerpj-semantic-trace.js"></script>',
      );
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('CheerpJ semantic trace server did not bind.');
  }

  let launched: Awaited<ReturnType<typeof launchPage>>;
  try {
    launched = await launchPage(
      `http://127.0.0.1:${address.port}`,
      selectedBrowser(),
    );
  } catch (error) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  const { browser, context, page } = launched;

  let closed = false;
  return {
    async executeWithTracing(request) {
      if (closed) throw new Error('CheerpJ semantic trace runtime is closed.');
      return page.evaluate(async (input) => {
        if (!globalThis.runCheerpJSemanticTrace) {
          throw new Error('CheerpJ semantic trace fixture did not initialize.');
        }
        return globalThis.runCheerpJSemanticTrace(input);
      }, request);
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await page.evaluate(() => globalThis.closeCheerpJSemanticTrace?.())
          .catch(() => undefined);
        await context.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
      } finally {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    },
  };
}

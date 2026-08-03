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

interface TraceJVMTraceRequest {
  source: string;
  entryClass: string;
  maxStoredEvents: number;
  profileBytecode?: boolean;
}

declare global {
  var runTraceJVMSemanticTrace:
    | ((request: TraceJVMTraceRequest) => Promise<TraceJVMTraceReport>)
    | undefined;
  var closeTraceJVMSemanticTrace: (() => void) | undefined;
}

export interface TraceJVMTraceReport {
  success: boolean;
  output?: string;
  events: string[];
  compilerStdout: string;
  compilerStderr: string;
  runtimeError?: string;
  compileTimeMs: number;
  classLoadTimeMs: number;
  runTimeMs: number;
  compileCacheHit: boolean;
  compilerDebugProfile: string;
  traceLimitExceeded: boolean;
  droppedEventCount: number;
  bytecodeProfile?: unknown;
  diagnosticError?: string;
}

export interface TraceJVMSemanticTraceRuntime {
  compileAndTrace(request: TraceJVMTraceRequest): Promise<TraceJVMTraceReport>;
  close(): Promise<void>;
}

type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

const browserTypes = {
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

function selectedBrowser(): BrowserEngine {
  const requested = process.env.TRACECODE_TRACEJVM_BROWSER ?? 'chromium';
  if (requested === 'chromium' || requested === 'firefox' || requested === 'webkit') {
    return requested;
  }
  throw new Error(`Unsupported TRACECODE_TRACEJVM_BROWSER: ${requested}`);
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
    await page.goto(origin);
    await page.waitForFunction(
      () => typeof globalThis.runTraceJVMSemanticTrace === 'function',
    );
    return { browser, context, page };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    throw error;
  }
}

export async function createTraceJVMSemanticTraceRuntime(
): Promise<TraceJVMSemanticTraceRuntime> {
  const traceJVMRoot = resolve(
    process.env.TRACECODE_TRACEJVM_ROOT ?? '../tracejvm'
  );
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'tracejvm-semantic-trace-'));
  const bundlePath = join(temporaryDirectory, 'tracejvm-semantic-trace.js');
  await build({
    entryPoints: [resolve('tests/fixtures/tracejvm-semantic-trace-browser-entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    alias: {
      '@tracecode/tracejvm': join(traceJVMRoot, 'src/index.ts'),
    },
    define: {
      __TRACECODE_TRACEJVM_HOT_AOT__: JSON.stringify(
        process.env.TRACECODE_TRACEJVM_HOT_AOT === '1',
      ),
    },
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const bundle = readFileSync(bundlePath);
  const helperJarPath = resolve('workers/vendor/java-browser-helper.jar');
  const server = createServer((request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    try {
      if (request.url === '/tracejvm-semantic-trace.js') {
        response.setHeader('content-type', 'text/javascript; charset=utf-8');
        response.end(bundle);
        return;
      }
      if (request.url === '/fixture/java-browser-helper.jar') {
        response.setHeader('content-type', 'application/java-archive');
        response.end(readFileSync(helperJarPath));
        return;
      }
      if (request.url?.startsWith('/tracejvm/')) {
        const requested = request.url.slice('/tracejvm/'.length);
        const relative = requested === 'browser-worker.js'
          ? 'dist/browser-worker.js'
          : requested.startsWith('compiler/')
            ? `.cache/teavm-javac/artifacts/${requested.slice('compiler/'.length)}`
          : `runtime/assets/${requested}`;
        const path = normalize(join(traceJVMRoot, relative));
        if (!path.startsWith(`${traceJVMRoot}/`) || !statSync(path).isFile()) {
          response.statusCode = 404;
          response.end('not found');
          return;
        }
        response.setHeader('content-type', contentType(path));
        response.end(readFileSync(path));
        return;
      }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(
        '<!doctype html><script src="/tracejvm-semantic-trace.js"></script>',
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
    throw new Error('TraceJVM semantic trace server did not bind.');
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
    async compileAndTrace(request) {
      if (closed) throw new Error('TraceJVM semantic trace runtime is closed.');
      return page.evaluate(async (input) => {
        if (!globalThis.runTraceJVMSemanticTrace) {
          throw new Error('TraceJVM semantic trace fixture did not initialize.');
        }
        return globalThis.runTraceJVMSemanticTrace(input);
      }, {
        ...request,
        profileBytecode:
          request.profileBytecode ??
          process.env.TRACECODE_TRACEJVM_BYTECODE_PROFILE === '1',
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await page.evaluate(() => globalThis.closeTraceJVMSemanticTrace?.())
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

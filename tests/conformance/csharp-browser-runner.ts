import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

export interface CSharpConformanceFixture {
  id: string;
  title: string;
  entryStyle: string;
  methodName: string;
  source: string;
  input: Record<string, unknown>;
  expectedReturn: unknown;
  expectedMutations: Record<string, unknown>;
  expectedHarnessOutput?: unknown;
  coverage: string[];
  notes: string;
}

export interface CSharpExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  diagnostics?: unknown[];
  consoleOutput?: string[];
  events?: unknown[];
  trace?: { events?: unknown[] };
  traceLimitExceeded?: boolean;
  timeoutReason?: string;
}

export interface CSharpBridge {
  run(fixture: CSharpConformanceFixture, trace: boolean): Promise<CSharpExecutionResult>;
  close(): Promise<void>;
}

export interface CSharpConformanceRunResult {
  success: boolean;
  expectedOutput: unknown;
  untraced?: CSharpExecutionResult;
  traced?: CSharpExecutionResult;
  phase?: 'untraced' | 'traced';
  error?: string;
}

function normalizeForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeForJson(child)])
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForJson(value));
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}

async function startStaticServer(root: string): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/__tracecode_conformance.html') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      response.end('<!doctype html><meta charset="utf-8"><title>tracecode csharp conformance</title>');
      return;
    }

    const decodedPath = decodeURIComponent(requestUrl.pathname);
    const candidate = normalize(join(root, decodedPath));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    const filePath = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!filePath || !existsSync(filePath)) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    response.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    response.end(readFileSync(filePath));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to resolve C# test server address.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function createCSharpConformanceBridge(): Promise<CSharpBridge> {
  const server = await startStaticServer(process.cwd());
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${server.origin}/__tracecode_conformance.html`);
  await page.evaluate(() => {
    (globalThis as unknown as { __name?: <T>(value: T) => T }).__name = (value) => value;
  });
  const assetBaseUrl = '/workers/vendor/csharp';

  async function close(): Promise<void> {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }

  async function run(fixture: CSharpConformanceFixture, trace: boolean): Promise<CSharpExecutionResult> {
    return page.evaluate(
      async ({ code, functionName, inputs, assetBaseUrl, trace, executionStyle }) => {
        const harnessKey = '__tracecodeCSharpConformanceWorkerHarness';
        async function createHarness() {
          const worker = new Worker('/workers/csharp/csharp-worker.js', { type: 'module' });
          let nextId = 0;
          const pending = new Map();

          function terminate(error = new Error('C# worker terminated')) {
            worker.terminate();
            for (const { reject, timeoutId } of pending.values()) {
              clearTimeout(timeoutId);
              reject(error);
            }
            pending.clear();
            globalThis[harnessKey] = undefined;
          }

          worker.addEventListener('message', (event) => {
            const id = event.data?.id;
            if (!id || !pending.has(id)) return;
            const { resolve, reject, timeoutId } = pending.get(id);
            if (event.data?.protocolToken !== pending.get(id)?.protocolToken) return;
            pending.delete(id);
            clearTimeout(timeoutId);
            if (event.data.type === 'error') {
              reject(new Error(event.data.payload?.error ?? 'C# worker error'));
              return;
            }
            resolve(event.data.payload);
          });

          worker.addEventListener('error', (event) => {
            terminate(new Error(event.message || 'C# worker failed'));
          });

          function send(type, payload) {
            const id = String(++nextId);
            const protocolToken = `csharp-conformance-token-${id}`;
            return new Promise((resolve, reject) => {
              const timeoutId = setTimeout(() => {
                terminate(new Error(`C# worker request timed out: ${type}`));
              }, 180000);
              pending.set(id, { resolve, reject, timeoutId, protocolToken });
              worker.postMessage({ id, type, payload, protocolToken });
            });
          }

          const harness = { assetBaseUrl, send, terminate };
          await send('init', { assetBaseUrl });
          await send('warmup', { assetBaseUrl });
          return harness;
        }

        let harness = globalThis[harnessKey];
        if (!harness || harness.assetBaseUrl !== assetBaseUrl) {
          harness = await createHarness();
          globalThis[harnessKey] = harness;
        }

        return harness.send(trace ? 'execute-with-tracing' : 'execute-code', {
          code,
          functionName,
          inputs,
          executionStyle,
          assetBaseUrl,
          maxStoredEvents: 10000,
          maxTraceSteps: 10000,
        });
      },
      {
        code: fixture.source,
        functionName: fixture.methodName,
        inputs: fixture.input,
        assetBaseUrl,
        trace,
        executionStyle: 'solution-method',
      }
    ) as Promise<CSharpExecutionResult>;
  }

  return { run, close };
}

function expectedOutputForFixture(fixture: CSharpConformanceFixture): unknown {
  if (fixture.expectedHarnessOutput !== undefined) return fixture.expectedHarnessOutput;
  if (fixture.expectedReturn === null) {
    const firstInputKey = Object.keys(fixture.input)[0];
    if (firstInputKey && Object.prototype.hasOwnProperty.call(fixture.expectedMutations, firstInputKey)) {
      return fixture.expectedMutations[firstInputKey];
    }
  }
  return fixture.expectedReturn;
}

export async function runCSharpConformanceFixture(
  bridge: CSharpBridge,
  fixture: CSharpConformanceFixture
): Promise<CSharpConformanceRunResult> {
  const expectedOutput = expectedOutputForFixture(fixture);
  const untraced = await bridge.run(fixture, false);
  let phase: CSharpConformanceRunResult['phase'];
  let error: string | undefined;
  if (!untraced.success) {
    phase = 'untraced';
    error = `${fixture.id}: untraced execution failed: ${untraced.error || JSON.stringify(untraced)}`;
  } else if (!jsonEqual(untraced.output, expectedOutput)) {
    phase = 'untraced';
    error = `${fixture.id}: untraced output mismatch\nExpected: ${stableStringify(expectedOutput)}\nReceived: ${stableStringify(untraced.output)}`;
  }

  const traced = await bridge.run(fixture, true);
  if (!error) {
    if (!traced.success) {
      phase = 'traced';
      error = `${fixture.id}: traced execution failed: ${traced.error || JSON.stringify(traced)}`;
    } else if (!jsonEqual(traced.output, untraced.output)) {
      phase = 'traced';
      error = `${fixture.id}: traced output drifted from untraced output\nUntraced: ${stableStringify(untraced.output)}\nTraced: ${stableStringify(traced.output)}`;
    } else if (!jsonEqual(traced.output, expectedOutput)) {
      phase = 'traced';
      error = `${fixture.id}: traced output mismatch\nExpected: ${stableStringify(expectedOutput)}\nReceived: ${stableStringify(traced.output)}`;
    }
  }

  return {
    success: !error,
    expectedOutput,
    untraced,
    traced,
    ...(phase ? { phase } : {}),
    ...(error ? { error } : {}),
  };
}

import { createServer } from 'node:http';
import { copyFile, readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';

const engineName = process.env.TRACECODE_TRACECLR_BROWSER_ENGINE ?? 'chromium';
const browserTypes: Record<string, BrowserType> = { chromium, firefox, webkit };
const browserType = browserTypes[engineName];
if (!browserType) {
  throw new Error(`Unsupported TraceCLR browser engine: ${engineName}`);
}
const sampleCount = Number(process.env.TRACECODE_TRACECLR_BROWSER_SAMPLES ?? '24');
if (!Number.isInteger(sampleCount) || sampleCount < 2) {
  throw new Error('TRACECODE_TRACECLR_BROWSER_SAMPLES must be an integer >= 2.');
}
const performanceBudgets = {
  chromium: { firstMs: 300, cachedP95Ms: 200 },
  firefox: { firstMs: 450, cachedP95Ms: 300 },
  webkit: { firstMs: 400, cachedP95Ms: 300 },
} as const;

const root = process.cwd();
const runnerDirectory = join(
  root,
  'packages/runtime-csharp/dotnet/TraceCode.CSharpAlgorithmRunner/bin/Release/net10.0/browser-wasm/AppBundle'
);
const learnerAssembly = join(
  root,
  'tools/TraceCode.TraceClrWireProbe/bin/Release/net10.0/TraceCode.TraceClrWireProbe.dll'
);
const workerSource = join(
  root,
  'packages/runtime-csharp/dotnet/TraceCode.CSharpAlgorithmRunner/runner-worker.mjs'
);
const controlledWorkerSource = join(
  root,
  'packages/runtime-csharp/dotnet/TraceCode.CSharpAlgorithmRunner/runner-controlled-worker.mjs'
);
const hostileAssembly = join(
  root,
  'tools/TraceCode.TraceClrHostileProbe/bin/Release/net10.0/TraceCode.TraceClrHostileProbe.dll'
);

function contentType(path: string): string {
  switch (extname(path)) {
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

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function main(): Promise<void> {
  await copyFile(learnerAssembly, join(runnerDirectory, 'TraceCode.TraceClrWireProbe.dll'));
  await copyFile(hostileAssembly, join(runnerDirectory, 'TraceCode.TraceClrHostileProbe.dll'));
  await copyFile(workerSource, join(runnerDirectory, 'runner-worker.mjs'));
  await copyFile(controlledWorkerSource, join(runnerDirectory, 'runner-controlled-worker.mjs'));
  const servedAssets = new Map<string, number>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      response.end('<!doctype html><title>TraceCLR wire probe</title>');
      return;
    }
    const candidate = normalize(join(runnerDirectory, decodeURIComponent(url.pathname)));
    if (candidate !== runnerDirectory && !candidate.startsWith(`${runnerDirectory}${sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const body = await readFile(candidate);
      servedAssets.set(url.pathname, body.byteLength);
      response.writeHead(200, {
        'Content-Type': contentType(candidate),
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address.');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/`);
    const samples = await page.evaluate(async ({ origin, sampleCount }) => {
      const results: Array<{
        first: { values: number[]; executionCount: number };
        second: { values: number[]; executionCount: number };
        totalMs: number;
        wasmHeapBytes: number | null;
      }> = [];
      for (let index = 0; index < sampleCount; index++) {
        results.push(await new Promise((resolve, reject) => {
          const worker = new Worker(`${origin}/runner-worker.mjs`, { type: 'module' });
          worker.addEventListener('message', (event) => {
            worker.terminate();
            resolve(event.data);
          }, { once: true });
          worker.addEventListener('error', (event) => {
            worker.terminate();
            reject(new Error(event.message));
          }, { once: true });
        }));
      }
      return results;
    }, { origin, sampleCount });
    const controlledResults: Array<{
      outcome: 'result' | 'error' | 'terminated';
      output?: number[];
      wasmHeapBytes?: number | null;
    }> = [];
    for (const mode of [0, 1, 2]) {
      controlledResults.push(await page.evaluate(async ({ origin, mode }) => await new Promise<{
        outcome: 'result' | 'error' | 'terminated';
        output?: number[];
        wasmHeapBytes?: number | null;
      }>((resolve, reject) => {
        const worker = new Worker(`${origin}/runner-controlled-worker.mjs`, { type: 'module' });
        let heap: number | null = null;
        const deadline = setTimeout(() => {
          worker.terminate();
          reject(new Error(`Controlled TraceCLR worker mode ${mode} exceeded test deadline.`));
        }, 10_000);
        worker.addEventListener('message', (event) => {
          if (event.data.type === 'ready') {
            heap = event.data.wasmHeapBytes;
            worker.postMessage({ type: 'execute', mode });
          } else if (event.data.type === 'started' && mode === 2) {
            setTimeout(() => {
              worker.terminate();
              clearTimeout(deadline);
              resolve({ outcome: 'terminated', wasmHeapBytes: heap });
            }, 100);
          } else if (event.data.type === 'result') {
            worker.terminate();
            clearTimeout(deadline);
            resolve({ outcome: 'result', output: event.data.output, wasmHeapBytes: heap });
          }
        });
        worker.addEventListener('error', (event) => {
          worker.terminate();
          clearTimeout(deadline);
          if (mode === 1) resolve({ outcome: 'error', wasmHeapBytes: heap });
          else reject(new Error(event.message));
        }, { once: true });
      }), { origin, mode }));
    }
    const recovery = await page.evaluate(async ({ origin }) => await new Promise<{
      first: { values: number[]; executionCount: number };
      second: { values: number[]; executionCount: number };
      totalMs: number;
      wasmHeapBytes: number | null;
    }>((resolve, reject) => {
      const worker = new Worker(`${origin}/runner-worker.mjs`, { type: 'module' });
      worker.addEventListener('message', (event) => {
        worker.terminate();
        resolve(event.data);
      }, { once: true });
      worker.addEventListener('error', (event) => {
        worker.terminate();
        reject(new Error(event.message));
      }, { once: true });
    }), { origin });
    const controlled = {
      normal: controlledResults[0],
      exception: controlledResults[1],
      infiniteLoop: controlledResults[2],
      recovery,
    };
    for (const [index, sample] of samples.entries()) {
      if (
        sample.first.values.join(',') !== '0,1'
        || sample.second.values.join(',') !== '0,1'
        || sample.first.executionCount !== 1
        || sample.second.executionCount !== 1
      ) {
        throw new Error(`TraceCLR wire/isolation mismatch at sample ${index}: ${JSON.stringify(sample)}`);
      }
    }
    if (controlled.normal.outcome !== 'result' || controlled.normal.output?.join(',') !== '42') {
      throw new Error(`TraceCLR controlled normal execution failed: ${JSON.stringify(controlled.normal)}`);
    }
    if (controlled.exception.outcome !== 'error') {
      throw new Error(`TraceCLR exception did not retire its worker: ${JSON.stringify(controlled.exception)}`);
    }
    if (controlled.infiniteLoop.outcome !== 'terminated') {
      throw new Error(`TraceCLR infinite loop was not terminated: ${JSON.stringify(controlled.infiniteLoop)}`);
    }
    if (
      controlled.recovery.first.values.join(',') !== '0,1'
      || controlled.recovery.first.executionCount !== 1
    ) {
      throw new Error(`TraceCLR did not recover in a fresh worker: ${JSON.stringify(controlled.recovery)}`);
    }
    for (const heap of [samples[0].wasmHeapBytes, controlled.normal.wasmHeapBytes]) {
      if (heap !== null && heap !== undefined && heap > 64 * 1024 * 1024) {
        throw new Error(`TraceCLR initial WASM heap exceeds 64 MiB: ${heap}`);
      }
    }
    const cached = samples.slice(1).map((sample) => sample.totalMs);
    const firstMs = samples[0].totalMs;
    const cachedP95Ms = percentile(cached, 0.95);
    const budget = performanceBudgets[engineName as keyof typeof performanceBudgets];
    if (firstMs > budget.firstMs || cachedP95Ms > budget.cachedP95Ms) {
      throw new Error(
        `TraceCLR ${engineName} startup regression: first=${firstMs.toFixed(1)}ms `
        + `(budget ${budget.firstMs}ms), cached p95=${cachedP95Ms.toFixed(1)}ms `
        + `(budget ${budget.cachedP95Ms}ms).`
      );
    }
    const servedBytes = [...servedAssets.values()].reduce((total, bytes) => total + bytes, 0);
    if (servedBytes > 4 * 1024 * 1024) {
      throw new Error(`TraceCLR minimal runner exceeded 4 MiB uncompressed: ${servedBytes} bytes.`);
    }
    console.log(JSON.stringify({
      schema: 'tracecode.traceclr-wire-runner-result.v1',
      engine: engineName,
      samples: samples.length,
      firstMs,
      cachedMedianMs: percentile(cached, 0.5),
      cachedP95Ms,
      wasmHeapBytes: samples[0].wasmHeapBytes,
      exceptionIsolation: controlled.exception.outcome,
      timeoutIsolation: controlled.infiniteLoop.outcome,
      recoveredInFreshWorker: true,
      servedFiles: servedAssets.size,
      servedBytes,
    }));
  } finally {
    await browser.close();
    server.close();
  }
}

void main();

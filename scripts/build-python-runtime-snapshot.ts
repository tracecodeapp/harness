#!/usr/bin/env npx tsx

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';

type Engine = 'chromium' | 'firefox' | 'webkit';
type Runner = 'playwright' | 'ios-simulator';

interface Options {
  readonly check: boolean;
  readonly device: string;
  readonly engine: Engine;
  readonly outputPath: string;
  readonly runner: Runner;
  readonly timeoutMs: number;
}

interface BrowserResult {
  readonly build?: {
    readonly snapshotBytes?: number;
  };
  readonly restore?: {
    readonly snapshotBytes?: number;
    readonly value?: string;
  };
  readonly userAgent?: string;
}

const ROOT = resolve(process.cwd());
const PYODIDE_VERSION = '0.29.3';
const RUNTIME_ROOT = join(
  ROOT,
  'workers',
  'python',
  `pyodide-${PYODIDE_VERSION}`
);
const SNAPSHOT_ROOT = join(RUNTIME_ROOT, 'snapshots');
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MIN_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);

const SNAPSHOT_WORKER = String.raw`
let pyodide;

async function buildSnapshot() {
  importScripts('/runtime/pyodide.js');
  pyodide = await self.loadPyodide({
    indexURL: self.location.origin + '/runtime/',
    _makeSnapshot: true,
    env: { PYTHONHASHSEED: '0' },
  });
  await pyodide.runPythonAsync(
    'import sys, json, math, os, ast, collections, typing'
  );
  const snapshot = pyodide.makeMemorySnapshot();
  const response = await fetch('/candidate.bin', {
    method: 'PUT',
    body: snapshot,
  });
  if (!response.ok) {
    throw new Error('Snapshot upload returned HTTP ' + response.status + '.');
  }
  return { snapshotBytes: snapshot.byteLength };
}

async function restoreSnapshot() {
  const response = await fetch('/candidate.bin', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Snapshot download returned HTTP ' + response.status + '.');
  }
  const snapshot = new Uint8Array(await response.arrayBuffer());
  importScripts('/runtime/pyodide.js');
  pyodide = await self.loadPyodide({
    indexURL: self.location.origin + '/runtime/',
    _loadSnapshot: snapshot,
    stdLibURL: '/empty-stdlib.zip',
    env: { PYTHONHASHSEED: '0' },
  });
  const value = await pyodide.runPythonAsync([
    'import ast, collections, json, math, os, typing',
    'source = "def solve(value):\\n    return value + 1\\n"',
    'namespace = {}',
    'exec(compile(source, "solution.py", "exec"), namespace, namespace)',
    'json.dumps({',
    '    "value": namespace["solve"](41),',
    '    "hash": hash("tracecode"),',
    '    "cwd": os.getcwd(),',
    '}, sort_keys=True)',
  ].join('\n'));
  return { snapshotBytes: snapshot.byteLength, value };
}

self.onmessage = async (event) => {
  try {
    const value = event.data === 'build'
      ? await buildSnapshot()
      : event.data === 'restore'
        ? await restoreSnapshot()
        : Promise.reject(new Error('Unknown snapshot command.'));
    self.postMessage({ ok: true, value });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: String(error && (error.stack || error.message) || error),
    });
  }
};
`;

const SNAPSHOT_PAGE = String.raw`
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TraceCode Python runtime snapshot</title>
<pre id="status">Building Python runtime snapshot...</pre>
<script>
const status = document.querySelector('#status');
const parameters = new URL(location.href).searchParams;
const check = parameters.get('check') === '1';
const nonce = parameters.get('nonce') || String(Date.now());

function runWorker(command) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/snapshot-worker.js?phase=' + command + '&nonce=' + nonce);
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error(command + ' timed out after 180000ms.'));
    }, 180000);
    worker.onmessage = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      if (event.data && event.data.ok) resolve(event.data.value);
      else reject(new Error(event.data && event.data.error || command + ' failed.'));
    };
    worker.onerror = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message || command + ' worker crashed.'));
    };
    worker.postMessage(command);
  });
}

(async () => {
  try {
    const build = check ? undefined : await runWorker('build');
    status.textContent = 'Validating clean restore...';
    const restore = await runWorker('restore');
    const result = { build, restore, userAgent: navigator.userAgent };
    const response = await fetch('/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    });
    if (!response.ok) throw new Error('Result upload returned HTTP ' + response.status + '.');
    status.textContent = 'PASS: Python runtime snapshot built and restored.';
  } catch (error) {
    status.textContent = 'FAIL: ' + String(error && (error.stack || error.message) || error);
    await fetch('/failed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: status.textContent, userAgent: navigator.userAgent }),
    }).catch(() => undefined);
  }
})();
</script>
`;

function argumentValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function parseOptions(): Options {
  const engine = (argumentValue('engine') ?? 'webkit') as Engine;
  const runner = (argumentValue('runner') ?? 'playwright') as Runner;
  const outputPath = resolve(
    argumentValue('output') ?? join(SNAPSHOT_ROOT, `${engine}.bin`)
  );
  const timeoutMs = Number(argumentValue('timeout-ms') ?? 240_000);
  const device = argumentValue('device') ?? 'booted';
  if (!['chromium', 'firefox', 'webkit'].includes(engine)) {
    throw new Error(`Unsupported --engine=${JSON.stringify(engine)}.`);
  }
  if (!['playwright', 'ios-simulator'].includes(runner)) {
    throw new Error(`Unsupported --runner=${JSON.stringify(runner)}.`);
  }
  if (runner === 'ios-simulator' && engine !== 'webkit') {
    throw new Error('The iOS simulator runner can only build the WebKit image.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error('--timeout-ms must be an integer of at least 1000.');
  }
  if (
    outputPath !== SNAPSHOT_ROOT &&
    !outputPath.startsWith(SNAPSHOT_ROOT + sep)
  ) {
    throw new Error(`Snapshot output must stay inside ${SNAPSHOT_ROOT}.`);
  }
  return {
    check: process.argv.includes('--check'),
    device,
    engine,
    outputPath,
    runner,
    timeoutMs,
  };
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    case '.zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

async function readRequestBody(
  request: IncomingMessage,
  maximumBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maximumBytes) {
      throw new Error(`Request exceeded ${maximumBytes} bytes.`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function commonHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
}

async function serveFile(
  response: ServerResponse,
  path: string
): Promise<void> {
  const file = await stat(path);
  response.writeHead(200, {
    ...commonHeaders(),
    'Content-Length': String(file.size),
    'Content-Type': contentType(path),
  });
  createReadStream(path).pipe(response);
}

function browserType(engine: Engine): BrowserType {
  if (engine === 'chromium') return chromium;
  if (engine === 'firefox') return firefox;
  return webkit;
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Snapshot build timed out after ${milliseconds}ms.`)),
      milliseconds
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function main(): Promise<void> {
  const options = parseOptions();
  await stat(join(RUNTIME_ROOT, 'pyodide.js'));
  await stat(join(RUNTIME_ROOT, 'pyodide.asm.wasm'));
  if (options.check) await stat(options.outputPath);

  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'tracecode-python-runtime-snapshot-')
  );
  const candidatePath = join(temporaryRoot, 'candidate.bin');
  const pendingOutputPath = `${options.outputPath}.${process.pid}.tmp`;
  if (options.check) await copyFile(options.outputPath, candidatePath);

  let resolveCompletion!: (value: BrowserResult) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<BrowserResult>((resolvePromise, rejectPromise) => {
    resolveCompletion = resolvePromise;
    rejectCompletion = rejectPromise;
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'PUT' && url.pathname === '/candidate.bin') {
        const bytes = await readRequestBody(request, MAX_SNAPSHOT_BYTES);
        if (bytes.byteLength < MIN_SNAPSHOT_BYTES) {
          throw new Error(`Snapshot was unexpectedly small: ${bytes.byteLength} bytes.`);
        }
        await writeFile(candidatePath, bytes);
        response.writeHead(204, commonHeaders()).end();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/complete') {
        const result = JSON.parse(
          (await readRequestBody(request, 1024 * 1024)).toString('utf8')
        ) as BrowserResult;
        resolveCompletion(result);
        response.writeHead(204, commonHeaders()).end();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/failed') {
        const failure = JSON.parse(
          (await readRequestBody(request, 1024 * 1024)).toString('utf8')
        ) as { error?: string };
        rejectCompletion(new Error(failure.error ?? 'Browser snapshot build failed.'));
        response.writeHead(204, commonHeaders()).end();
        return;
      }
      if (request.method !== 'GET') {
        response.writeHead(405, commonHeaders()).end('Method not allowed');
        return;
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const bytes = Buffer.from(SNAPSHOT_PAGE, 'utf8');
        response.writeHead(200, {
          ...commonHeaders(),
          'Content-Length': String(bytes.byteLength),
          'Content-Type': 'text/html; charset=utf-8',
        }).end(bytes);
        return;
      }
      if (url.pathname === '/snapshot-worker.js') {
        const bytes = Buffer.from(SNAPSHOT_WORKER, 'utf8');
        response.writeHead(200, {
          ...commonHeaders(),
          'Content-Length': String(bytes.byteLength),
          'Content-Type': 'text/javascript; charset=utf-8',
        }).end(bytes);
        return;
      }
      if (url.pathname === '/empty-stdlib.zip') {
        response.writeHead(200, {
          ...commonHeaders(),
          'Content-Length': '0',
          'Content-Type': 'application/zip',
        }).end();
        return;
      }
      if (url.pathname === '/candidate.bin') {
        await serveFile(response, candidatePath);
        return;
      }
      if (url.pathname.startsWith('/runtime/')) {
        const relativePath = decodeURIComponent(url.pathname.slice('/runtime/'.length));
        const candidate = normalize(join(RUNTIME_ROOT, relativePath));
        if (
          candidate !== RUNTIME_ROOT &&
          !candidate.startsWith(RUNTIME_ROOT + sep)
        ) {
          response.writeHead(403, commonHeaders()).end('Forbidden');
          return;
        }
        await serveFile(response, candidate);
        return;
      }
      response.writeHead(404, commonHeaders()).end('Not found');
    } catch (error) {
      response.writeHead(500, commonHeaders()).end(
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  let browser: Awaited<ReturnType<BrowserType['launch']>> | undefined;
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Snapshot server did not expose a TCP address.');
    }
    const pageUrl =
      `http://127.0.0.1:${address.port}/?nonce=${randomUUID()}` +
      (options.check ? '&check=1' : '');

    if (options.runner === 'ios-simulator') {
      await execFileAsync('xcrun', [
        'simctl',
        'openurl',
        options.device,
        pageUrl,
      ]);
    } else {
      browser = await browserType(options.engine).launch({ headless: true });
      const page = await browser.newPage();
      page.setDefaultTimeout(options.timeoutMs);
      await page.goto(pageUrl, { waitUntil: 'load' });
    }

    const result = await withTimeout(completion, options.timeoutMs);
    const candidate = await readFile(candidatePath);
    if (
      result.build?.snapshotBytes !== undefined &&
      result.build.snapshotBytes !== candidate.byteLength
    ) {
      throw new Error('Browser build byte count did not match the uploaded snapshot.');
    }
    if (result.restore?.snapshotBytes !== candidate.byteLength) {
      throw new Error('Browser restore byte count did not match the candidate snapshot.');
    }
    const restoredValue = JSON.parse(result.restore.value ?? 'null') as {
      value?: unknown;
      cwd?: unknown;
    } | null;
    if (
      restoredValue?.value !== 42 ||
      typeof restoredValue.cwd !== 'string' ||
      restoredValue.cwd.length === 0
    ) {
      throw new Error(
        `Snapshot restore sanity check failed: ${JSON.stringify(restoredValue)}.`
      );
    }

    const previous = await readFile(options.outputPath).catch(() => undefined);
    const sha256 = createHash('sha256').update(candidate).digest('hex');
    const previousSha256 = previous
      ? createHash('sha256').update(previous).digest('hex')
      : undefined;
    if (!options.check) {
      await mkdir(dirname(options.outputPath), { recursive: true });
      await copyFile(candidatePath, pendingOutputPath);
      await rename(pendingOutputPath, options.outputPath);
    }
    console.log(JSON.stringify({
      schema: 'tracecode.python-runtime-snapshot-build.v1',
      checked: options.check,
      engine: options.engine,
      runner: options.runner,
      device: options.runner === 'ios-simulator' ? options.device : undefined,
      outputPath: options.outputPath,
      bytes: candidate.byteLength,
      sha256,
      previousSha256,
      changed: previousSha256 !== sha256,
      userAgent: result.userAgent,
      restore: restoredValue,
    }, null, 2));
  } finally {
    await browser?.close().catch(() => undefined);
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
    await rm(pendingOutputPath, { force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

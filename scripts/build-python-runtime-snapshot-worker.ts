#!/usr/bin/env npx tsx

import { execFile } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';
import {
  PYTHON_RUNTIME_IMAGE_HASH_PROBE,
  PYTHON_RUNTIME_IMAGE_HASH_SEED,
} from '../packages/runtime-python/src/python-runtime-image-contract.js';
import {
  publishSnapshotRelease,
  recoverSnapshotRelease,
  snapshotReleasePaths,
} from './python-runtime-snapshot-release.js';
import { assertSnapshotReleaseWorkerLock } from './python-runtime-snapshot-lock.js';

type Engine = 'chromium' | 'firefox' | 'webkit';
type Runner = 'playwright' | 'ios-simulator';

interface Options {
  readonly check: boolean;
  readonly device: string;
  readonly engine: Engine;
  readonly outputPath: string;
  readonly provenancePath: string;
  readonly replace: boolean;
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

interface SnapshotProvenance {
  readonly schema: 'tracecode.python-runtime-snapshot-provenance.v1';
  readonly pyodideVersion: string;
  readonly snapshots: Partial<Record<Engine, {
    readonly builtAt: string | null;
    readonly bytes: number;
    readonly engine: Engine;
    readonly provenance: 'built-and-verified' | 'legacy-unrecorded';
    readonly pythonHashSeed: string;
    readonly runner: Runner | 'legacy-unrecorded';
    readonly sha256: string;
    readonly userAgent: string | null;
  }>>;
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
const PROVENANCE_PATH = join(SNAPSHOT_ROOT, 'provenance.json');
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MIN_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const SNAPSHOT_PREIMPORT_SOURCE =
  'import sys, json, math, os, ast, collections, typing';
const runtimeCoreSource = await readFile(
  join(ROOT, 'workers', 'python', 'runtime-core.js'),
  'utf8'
);
const preludeMarker = 'const PYTHON_DEFAULT_IMPORT_PRELUDE = `';
const preludeStart = runtimeCoreSource.indexOf(preludeMarker);
const preludeEnd = runtimeCoreSource.indexOf(
  '`;',
  preludeStart + preludeMarker.length
);
if (preludeStart < 0 || preludeEnd < 0) {
  throw new Error('Unable to read PYTHON_DEFAULT_IMPORT_PRELUDE from runtime-core.js.');
}
const PYTHON_DEFAULT_IMPORT_PRELUDE = runtimeCoreSource.slice(
  preludeStart + preludeMarker.length,
  preludeEnd
);
if (
  PYTHON_DEFAULT_IMPORT_PRELUDE.includes('\\') ||
  PYTHON_DEFAULT_IMPORT_PRELUDE.includes('${')
) {
  throw new Error(
    'PYTHON_DEFAULT_IMPORT_PRELUDE must remain interpolation-free plain text.'
  );
}

const SNAPSHOT_WORKER = String.raw`
let pyodide;
const sessionNonce = new URL(self.location.href).searchParams.get('nonce');

function sessionUrl(path) {
  return path + '?nonce=' + encodeURIComponent(sessionNonce || '');
}

async function buildSnapshot() {
  importScripts('/runtime/pyodide.js');
  pyodide = await self.loadPyodide({
    indexURL: self.location.origin + '/runtime/',
    _makeSnapshot: true,
    env: { PYTHONHASHSEED: ${JSON.stringify(PYTHON_RUNTIME_IMAGE_HASH_SEED)} },
  });
  await pyodide.runPythonAsync(${JSON.stringify(SNAPSHOT_PREIMPORT_SOURCE)});
  const snapshot = pyodide.makeMemorySnapshot();
  const response = await fetch(sessionUrl('/candidate.bin'), {
    method: 'PUT',
    body: snapshot,
  });
  if (!response.ok) {
    throw new Error('Snapshot upload returned HTTP ' + response.status + '.');
  }
  return { snapshotBytes: snapshot.byteLength };
}

async function restoreSnapshot() {
  const response = await fetch(sessionUrl('/candidate.bin'), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Snapshot download returned HTTP ' + response.status + '.');
  }
  const snapshot = new Uint8Array(await response.arrayBuffer());
  importScripts('/runtime/pyodide.js');
  pyodide = await self.loadPyodide({
    indexURL: self.location.origin + '/runtime/',
    _loadSnapshot: snapshot,
    env: { PYTHONHASHSEED: ${JSON.stringify(PYTHON_RUNTIME_IMAGE_HASH_SEED)} },
  });
  await pyodide.runPythonAsync(${JSON.stringify(PYTHON_DEFAULT_IMPORT_PRELUDE)});
  const value = await pyodide.runPythonAsync([
    'import ast, collections, json, math, os, typing, heapq, itertools, re, string',
    'source = "def solve(value):\\n    return value + 1\\n"',
    'namespace = {}',
    'exec(compile(source, "solution.py", "exec"), namespace, namespace)',
    'json.dumps({',
    '    "value": namespace["solve"](41),',
    '    "hash": hash(${JSON.stringify(PYTHON_RUNTIME_IMAGE_HASH_PROBE.source)}),',
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
const totalTimeoutMs = Number(parameters.get('timeoutMs'));
const phaseCount = check ? 1 : 2;
const phaseTimeoutMs = Math.max(1000, Math.floor((totalTimeoutMs - 1000) / phaseCount));

function runWorker(command) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/snapshot-worker.js?phase=' + command + '&nonce=' + nonce);
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error(command + ' timed out after ' + phaseTimeoutMs + 'ms.'));
    }, phaseTimeoutMs);
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
    const response = await fetch('/complete?nonce=' + encodeURIComponent(nonce), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    });
    if (!response.ok) throw new Error('Result upload returned HTTP ' + response.status + '.');
    status.textContent = 'PASS: Python runtime snapshot built and restored.';
  } catch (error) {
    status.textContent = 'FAIL: ' + String(error && (error.stack || error.message) || error);
    await fetch('/failed?nonce=' + encodeURIComponent(nonce), {
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
  const outputPath = join(SNAPSHOT_ROOT, `${engine}.bin`);
  const timeoutMs = Number(argumentValue('timeout-ms') ?? 240_000);
  const device = argumentValue('device') ?? 'booted';
  const checkRequested = process.argv.includes('--check');
  const replace = process.argv.includes('--replace');
  if (argumentValue('output') !== undefined) {
    throw new Error('--output is not supported; each engine is bound to its release filename.');
  }
  if (checkRequested && replace) {
    throw new Error('Choose either --check or --replace, not both.');
  }
  if (!['chromium', 'firefox', 'webkit'].includes(engine)) {
    throw new Error(`Unsupported --engine=${JSON.stringify(engine)}.`);
  }
  if (!['playwright', 'ios-simulator'].includes(runner)) {
    throw new Error(`Unsupported --runner=${JSON.stringify(runner)}.`);
  }
  if (runner === 'ios-simulator' && engine !== 'webkit') {
    throw new Error('The iOS simulator runner can only build the WebKit image.');
  }
  if (replace && engine !== 'webkit') {
    throw new Error(
      'Only the WebKit release image currently supports replacement.'
    );
  }
  if (replace && engine === 'webkit' && runner !== 'ios-simulator') {
    throw new Error(
      'Replacing the WebKit release image requires --runner=ios-simulator.'
    );
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error('--timeout-ms must be an integer of at least 1000.');
  }
  return {
    check: !replace,
    device,
    engine,
    outputPath,
    provenancePath: PROVENANCE_PATH,
    replace,
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

async function readSnapshotProvenance(
  path: string
): Promise<SnapshotProvenance | undefined> {
  try {
    const provenance = JSON.parse(
      await readFile(path, 'utf8')
    ) as SnapshotProvenance;
    if (
      provenance.schema !== 'tracecode.python-runtime-snapshot-provenance.v1' ||
      provenance.pyodideVersion !== PYODIDE_VERSION
    ) {
      throw new Error('Existing Python snapshot provenance is incompatible.');
    }
    return provenance;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
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
  if (!file.isFile()) {
    response.writeHead(404, commonHeaders()).end('Not found');
    return;
  }
  response.writeHead(200, {
    ...commonHeaders(),
    'Content-Length': String(file.size),
    'Content-Type': contentType(path),
  });
  const stream = createReadStream(path);
  stream.on('error', (error) => response.destroy(error));
  stream.pipe(response);
}

function hasSessionNonce(url: URL, sessionNonce: string): boolean {
  const received = url.searchParams.get('nonce');
  if (received === null) return false;
  const expectedBytes = Buffer.from(sessionNonce, 'utf8');
  const receivedBytes = Buffer.from(received, 'utf8');
  return (
    expectedBytes.byteLength === receivedBytes.byteLength &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
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

async function runSnapshot(options: Options): Promise<void> {
  const temporaryRoot = await mkdtemp(
    join(ROOT, '.python-runtime-snapshot-')
  );
  const candidatePath = join(temporaryRoot, 'candidate.bin');
  if (options.check) await copyFile(options.outputPath, candidatePath);
  const sessionNonce = randomUUID();

  let resolveCompletion!: (value: BrowserResult) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<BrowserResult>((resolvePromise, rejectPromise) => {
    resolveCompletion = resolvePromise;
    rejectCompletion = rejectPromise;
  });
  void completion.catch(() => undefined);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'PUT' && url.pathname === '/candidate.bin') {
        if (!hasSessionNonce(url, sessionNonce)) {
          response.writeHead(403, commonHeaders()).end('Forbidden');
          return;
        }
        const bytes = await readRequestBody(request, MAX_SNAPSHOT_BYTES);
        if (bytes.byteLength < MIN_SNAPSHOT_BYTES) {
          throw new Error(`Snapshot was unexpectedly small: ${bytes.byteLength} bytes.`);
        }
        await writeFile(candidatePath, bytes);
        response.writeHead(204, commonHeaders()).end();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/complete') {
        if (!hasSessionNonce(url, sessionNonce)) {
          response.writeHead(403, commonHeaders()).end('Forbidden');
          return;
        }
        const result = JSON.parse(
          (await readRequestBody(request, 1024 * 1024)).toString('utf8')
        ) as BrowserResult;
        resolveCompletion(result);
        response.writeHead(204, commonHeaders()).end();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/failed') {
        if (!hasSessionNonce(url, sessionNonce)) {
          response.writeHead(403, commonHeaders()).end('Forbidden');
          return;
        }
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
      if (url.pathname === '/candidate.bin') {
        if (!hasSessionNonce(url, sessionNonce)) {
          response.writeHead(403, commonHeaders()).end('Forbidden');
          return;
        }
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
      `http://127.0.0.1:${address.port}/?nonce=${sessionNonce}` +
      `&timeoutMs=${options.timeoutMs}` +
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
      hash?: unknown;
    } | null;
    if (
      restoredValue?.value !== 42 ||
      typeof restoredValue.cwd !== 'string' ||
      restoredValue.cwd.length === 0 ||
      restoredValue.hash !== PYTHON_RUNTIME_IMAGE_HASH_PROBE.value
    ) {
      throw new Error(
        `Snapshot restore sanity check failed: ${JSON.stringify(restoredValue)}.`
      );
    }

    const previous = await readFile(options.outputPath);
    const sha256 = createHash('sha256').update(candidate).digest('hex');
    const previousSha256 = previous
      ? createHash('sha256').update(previous).digest('hex')
      : undefined;
    const existingProvenance = await readSnapshotProvenance(
      options.provenancePath
    );
    const existingRecord = existingProvenance?.snapshots[options.engine];
    const provenanceChecked = existingRecord !== undefined;
    if (
      options.check &&
      (existingRecord !== undefined || options.engine === 'webkit') &&
      (
        existingRecord?.bytes !== candidate.byteLength ||
        existingRecord.engine !== options.engine ||
        !['built-and-verified', 'legacy-unrecorded'].includes(
          existingRecord.provenance
        ) ||
        existingRecord.pythonHashSeed !== PYTHON_RUNTIME_IMAGE_HASH_SEED ||
        existingRecord.sha256 !== sha256 ||
        (options.engine === 'webkit' && (
          existingRecord.provenance !== 'built-and-verified' ||
          existingRecord.runner !== 'ios-simulator' ||
          !/Mobile\/\S+ Safari\//u.test(existingRecord.userAgent ?? '')
        ))
      )
    ) {
      throw new Error(
        `Snapshot provenance did not match ${options.engine}.bin.`
      );
    }
    if (options.replace) {
      if (typeof result.userAgent !== 'string' || result.userAgent.length === 0) {
        throw new Error('Snapshot replacement requires browser provenance.');
      }
      const provenance = existingProvenance ?? {
          schema: 'tracecode.python-runtime-snapshot-provenance.v1',
          pyodideVersion: PYODIDE_VERSION,
          snapshots: {},
        } satisfies SnapshotProvenance;
      const updatedProvenance: SnapshotProvenance = {
        ...provenance,
        snapshots: {
          ...provenance.snapshots,
          [options.engine]: {
            builtAt: new Date().toISOString(),
            bytes: candidate.byteLength,
            engine: options.engine,
            provenance: 'built-and-verified',
            pythonHashSeed: PYTHON_RUNTIME_IMAGE_HASH_SEED,
            runner: options.runner,
            sha256,
            userAgent: result.userAgent,
          },
        },
      };
      await publishSnapshotRelease({
        engine: options.engine,
        image: candidate,
        paths: snapshotReleasePaths(
          ROOT,
          options.outputPath,
          options.provenancePath
        ),
        provenance: Buffer.from(
          `${JSON.stringify(updatedProvenance, null, 2)}\n`,
          'utf8'
        ),
        verify: async () => {
          const published = await readFile(options.outputPath);
          const publishedProvenance = await readSnapshotProvenance(
            options.provenancePath
          );
          const publishedRecord = publishedProvenance?.snapshots[options.engine];
          if (
            published.byteLength !== candidate.byteLength ||
            createHash('sha256').update(published).digest('hex') !== sha256 ||
            publishedRecord?.bytes !== candidate.byteLength ||
            publishedRecord.sha256 !== sha256 ||
            publishedRecord.provenance !== 'built-and-verified' ||
            publishedRecord.runner !== options.runner
          ) {
            throw new Error(
              'Published snapshot and provenance failed verification.'
            );
          }
        },
      });
    }
    console.log(JSON.stringify({
      schema: 'tracecode.python-runtime-snapshot-build.v1',
      checked: options.check,
      replaced: options.replace,
      engine: options.engine,
      runner: options.runner,
      device: options.runner === 'ios-simulator' ? options.device : undefined,
      outputPath: options.outputPath,
      bytes: candidate.byteLength,
      sha256,
      previousSha256,
      changed: previousSha256 !== sha256,
      provenanceChecked,
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
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseOptions();
  assertSnapshotReleaseWorkerLock(process.argv.slice(2), options.replace);
  await stat(join(RUNTIME_ROOT, 'pyodide.js'));
  await stat(join(RUNTIME_ROOT, 'pyodide.asm.wasm'));
  await stat(options.outputPath);

  if (options.replace) {
    await recoverSnapshotRelease(
      snapshotReleasePaths(ROOT, options.outputPath, options.provenancePath),
      options.engine
    );
  }
  await runSnapshot(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

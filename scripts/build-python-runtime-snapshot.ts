#!/usr/bin/env npx tsx

import { execFile } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';
import {
  PYTHON_RUNTIME_IMAGE_HASH_PROBE,
  PYTHON_RUNTIME_IMAGE_HASH_SEED,
} from '../packages/runtime-python/src/python-runtime-image-contract.js';

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

interface ReleaseTransaction {
  readonly schema: 'tracecode.python-runtime-snapshot-release.v1';
  readonly engine: Engine;
  readonly previousImage: {
    readonly bytes: number | null;
    readonly sha256: string | null;
  };
  readonly previousProvenance: {
    readonly bytes: number | null;
    readonly sha256: string | null;
  };
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
const RELEASE_LOCK_PATH = join(ROOT, '.python-runtime-snapshot-release.lock');
const RELEASE_TRANSACTION_PATH = join(
  ROOT,
  '.python-runtime-snapshot-release.transaction.json'
);
const RELEASE_PREVIOUS_IMAGE_PATH = join(
  ROOT,
  '.python-runtime-snapshot-release.previous.bin'
);
const RELEASE_PREVIOUS_PROVENANCE_PATH = join(
  ROOT,
  '.python-runtime-snapshot-release.previous-provenance.json'
);
const RELEASE_RECOVERY_IMAGE_PATH = join(
  ROOT,
  '.python-runtime-snapshot-release.recovering.bin'
);
const RELEASE_RECOVERY_PROVENANCE_PATH = join(
  ROOT,
  '.python-runtime-snapshot-release.recovering-provenance.json'
);
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

async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function fileIdentity(bytes: Buffer | undefined): {
  readonly bytes: number | null;
  readonly sha256: string | null;
} {
  return bytes === undefined
    ? { bytes: null, sha256: null }
    : {
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
}

async function clearReleaseTransaction(): Promise<void> {
  await rm(RELEASE_TRANSACTION_PATH, { force: true });
  await Promise.all([
    rm(RELEASE_PREVIOUS_IMAGE_PATH, { force: true }),
    rm(RELEASE_PREVIOUS_PROVENANCE_PATH, { force: true }),
    rm(RELEASE_RECOVERY_IMAGE_PATH, { force: true }),
    rm(RELEASE_RECOVERY_PROVENANCE_PATH, { force: true }),
  ]);
}

async function beginReleaseTransaction(
  engine: Engine,
  previousImage: Buffer | undefined,
  previousProvenance: Buffer | undefined
): Promise<void> {
  await clearReleaseTransaction();
  try {
    if (previousImage !== undefined) {
      await writeFile(RELEASE_PREVIOUS_IMAGE_PATH, previousImage);
    }
    if (previousProvenance !== undefined) {
      await writeFile(RELEASE_PREVIOUS_PROVENANCE_PATH, previousProvenance);
    }
    const transaction: ReleaseTransaction = {
      schema: 'tracecode.python-runtime-snapshot-release.v1',
      engine,
      previousImage: fileIdentity(previousImage),
      previousProvenance: fileIdentity(previousProvenance),
    };
    await writeFile(
      RELEASE_TRANSACTION_PATH,
      `${JSON.stringify(transaction, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    await clearReleaseTransaction().catch(() => undefined);
    throw error;
  }
}

async function restoreTransactionFile(
  identity: ReleaseTransaction['previousImage'],
  backupPath: string,
  recoveryPath: string,
  targetPath: string
): Promise<void> {
  if (identity.bytes === null && identity.sha256 === null) {
    await rm(targetPath, { force: true });
    return;
  }
  if (identity.bytes === null || identity.sha256 === null) {
    throw new Error('Python runtime snapshot recovery identity is incomplete.');
  }
  const backup = await readFile(backupPath);
  if (
    backup.byteLength !== identity.bytes ||
    createHash('sha256').update(backup).digest('hex') !== identity.sha256
  ) {
    throw new Error(`Python runtime snapshot recovery backup is invalid: ${backupPath}.`);
  }
  await writeFile(recoveryPath, backup);
  await rename(recoveryPath, targetPath);
  const restored = await readFile(targetPath);
  if (
    restored.byteLength !== identity.bytes ||
    createHash('sha256').update(restored).digest('hex') !== identity.sha256
  ) {
    throw new Error(`Python runtime snapshot recovery failed: ${targetPath}.`);
  }
}

async function recoverInterruptedRelease(options: Options): Promise<void> {
  const transactionBytes = await readOptionalFile(RELEASE_TRANSACTION_PATH);
  if (transactionBytes === undefined) {
    await clearReleaseTransaction();
    return;
  }
  const transaction = JSON.parse(
    transactionBytes.toString('utf8')
  ) as ReleaseTransaction;
  if (
    transaction.schema !== 'tracecode.python-runtime-snapshot-release.v1' ||
    transaction.engine !== options.engine
  ) {
    throw new Error('Python runtime snapshot release recovery journal is incompatible.');
  }
  await restoreTransactionFile(
    transaction.previousImage,
    RELEASE_PREVIOUS_IMAGE_PATH,
    RELEASE_RECOVERY_IMAGE_PATH,
    options.outputPath
  );
  await restoreTransactionFile(
    transaction.previousProvenance,
    RELEASE_PREVIOUS_PROVENANCE_PATH,
    RELEASE_RECOVERY_PROVENANCE_PATH,
    options.provenancePath
  );
  await clearReleaseTransaction();
}

async function processIsAlive(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

async function acquireReleaseLock(): Promise<Awaited<ReturnType<typeof open>>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let releaseLock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      releaseLock = await open(RELEASE_LOCK_PATH, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const ownerBytes = await readOptionalFile(RELEASE_LOCK_PATH);
      if (ownerBytes === undefined) continue;
      const ownerPid = Number(ownerBytes.toString('utf8').trim());
      if (await processIsAlive(ownerPid)) {
        throw new Error(
          `Python runtime snapshot replacement is already running as PID ${ownerPid}.`
        );
      }
      await rm(RELEASE_LOCK_PATH, { force: true });
      continue;
    }
    try {
      await releaseLock.writeFile(`${process.pid}\n`, 'utf8');
      return releaseLock;
    } catch (error) {
      await releaseLock.close().catch(() => undefined);
      await rm(RELEASE_LOCK_PATH, { force: true });
      throw error;
    }
  }
  throw new Error(`Unable to acquire ${RELEASE_LOCK_PATH}.`);
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
  const pendingOutputPath = join(temporaryRoot, `${options.engine}.bin`);
  const pendingProvenancePath = join(temporaryRoot, 'provenance.json');
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

    const previous = await readOptionalFile(options.outputPath);
    const previousProvenance = await readOptionalFile(options.provenancePath);
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
      await mkdir(dirname(options.outputPath), { recursive: true });
      await copyFile(candidatePath, pendingOutputPath);
      await writeFile(
        pendingProvenancePath,
        `${JSON.stringify(updatedProvenance, null, 2)}\n`,
        'utf8'
      );
      await beginReleaseTransaction(
        options.engine,
        previous,
        previousProvenance
      );
      try {
        await rename(pendingOutputPath, options.outputPath);
        await rename(pendingProvenancePath, options.provenancePath);

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
          throw new Error('Published snapshot and provenance failed verification.');
        }
        await clearReleaseTransaction();
      } catch (releaseError) {
        const rollbackErrors: unknown[] = [];
        try {
          if (previous === undefined) {
            await rm(options.outputPath, { force: true });
          } else {
            await writeFile(pendingOutputPath, previous);
            await rename(pendingOutputPath, options.outputPath);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        try {
          if (previousProvenance === undefined) {
            await rm(options.provenancePath, { force: true });
          } else {
            await writeFile(pendingProvenancePath, previousProvenance);
            await rename(pendingProvenancePath, options.provenancePath);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [releaseError, ...rollbackErrors],
            'Snapshot release failed and rollback was incomplete.'
          );
        }
        await clearReleaseTransaction();
        throw releaseError;
      }
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
    await rm(pendingOutputPath, { force: true });
    await rm(pendingProvenancePath, { force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseOptions();
  await stat(join(RUNTIME_ROOT, 'pyodide.js'));
  await stat(join(RUNTIME_ROOT, 'pyodide.asm.wasm'));
  if (options.check) await stat(options.outputPath);

  let releaseLock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (options.replace) {
      releaseLock = await acquireReleaseLock();
      await recoverInterruptedRelease(options);
    }
    await runSnapshot(options);
  } finally {
    if (releaseLock) {
      await releaseLock.close().catch(() => undefined);
      const ownerBytes = await readOptionalFile(RELEASE_LOCK_PATH);
      if (ownerBytes?.toString('utf8').trim() === String(process.pid)) {
        await rm(RELEASE_LOCK_PATH, { force: true });
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

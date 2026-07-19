#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runCommand, waitForHttp } from './example-app-smoke';

interface ModuleSmokeResult {
  initMs: number;
  warmupMs: number;
  executeMs: number;
  output: unknown;
  projectStdout: string;
  workerFormat: string;
  configuredPackageFailure: string;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-python-module-browser-'));
  const workersRoot = join(tempRoot, 'workers');
  const port = 5900 + Math.floor(Math.random() * 200);
  const origin = `http://127.0.0.1:${port}`;

  await runCommand(
    'pnpm',
    ['exec', 'tsx', 'src/cli.ts', 'sync-assets', workersRoot, '--languages', 'python'],
    process.cwd()
  );
  await writeFile(join(tempRoot, 'index.html'), '<!doctype html><title>Python module worker smoke</title>', 'utf8');

  const server = spawn('python3', ['-c', [
    'from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler',
    'import os',
    'class Handler(SimpleHTTPRequestHandler):',
    '    def end_headers(self):',
    '        self.send_header("Cross-Origin-Opener-Policy", "same-origin")',
    '        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")',
    '        super().end_headers()',
    `os.chdir(${JSON.stringify(tempRoot)})`,
    `ThreadingHTTPServer(("127.0.0.1", ${port}), Handler).serve_forever()`,
  ].join('\n')], {
    cwd: tempRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const browser = await chromium.launch({ headless: true });
  try {
    await waitForHttp(origin, 30_000);
    const page = await browser.newPage();
    const missingPackageRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('missing_package-1.0.0')) missingPackageRequests.push(request.url());
    });
    page.setDefaultTimeout(180_000);
    await page.goto(origin);

    const result = await page.evaluate<ModuleSmokeResult>(`(async () => {
      const worker = new Worker('/workers/pyodide-worker.js?tracecodePythonWorkerFormat=module', {
        type: 'module',
      });
      const pending = new Map();
      let nextId = 0;
      let readyResolve;
      const ready = new Promise((resolve) => { readyResolve = resolve; });
      worker.onmessage = (event) => {
        const { id, type, payload, protocolToken } = event.data || {};
        if (type === 'worker-ready') {
          readyResolve();
          return;
        }
        // Project output/file events are streamed before the terminal command
        // result and must not settle the request promise.
        if (type === 'project-event') return;
        const request = pending.get(id);
        if (!request || request.protocolToken !== protocolToken) return;
        pending.delete(id);
        if (type === 'error') request.reject(new Error(payload && payload.error || 'Python worker error'));
        else request.resolve(payload);
      };
      worker.onerror = (event) => {
        for (const request of pending.values()) request.reject(new Error(event.message || 'Python worker error'));
        pending.clear();
      };
      const request = (type, payload) => new Promise((resolve, reject) => {
        const id = 'module-smoke-' + (++nextId);
        const protocolToken = 'module-smoke-token-' + nextId;
        pending.set(id, { resolve, reject, protocolToken });
        worker.postMessage({ id, type, payload, protocolToken });
      });

      await ready;
      const init = await request('init', {
        runtimeAssets: {
          loaderFormat: 'module',
          loaderUrl: 'https://cdn.jsdelivr.net/pyodide/v314.0.2/full/pyodide.mjs',
          indexUrl: 'https://cdn.jsdelivr.net/pyodide/v314.0.2/full/',
          runtimeCoreUrl: location.origin + '/workers/pyodide/runtime-core.js',
          snippetsUrl: location.origin + '/workers/generated-python-harness-snippets.js',
        },
      });
      const warmup = await request('warmup');
      const startedAt = performance.now();
      const execution = await request('execute-code', {
        code: 'def add(a, b):\\n    return a + b',
        functionName: 'add',
        inputs: { a: 20, b: 22 },
        executionStyle: 'function',
      });
      const executeMs = performance.now() - startedAt;
      const projectInput = new TextEncoder().encode('module-stdin\\n');
      const projectInputBuffer = new SharedArrayBuffer(12 + 65536);
      const projectInputHeader = new Int32Array(projectInputBuffer, 0, 3);
      new Uint8Array(projectInputBuffer, 12).set(projectInput);
      Atomics.store(projectInputHeader, 1, projectInput.byteLength);
      Atomics.store(projectInputHeader, 2, 1);
      const project = await request('execute-project-python', {
        source: 'file',
        scriptPath: 'main.py',
        args: [],
        cwd: '/workspace',
        env: {},
        stdinPipe: { buffer: projectInputBuffer },
        projectUserAuthorityMode: 'permanent',
        project: {
          kernelDevices: [{ path: '/dev/stdin', readable: true, writable: false, inputDevice: '/dev/stdin' }],
          files: [{
            path: 'main.py',
            contents: 'import sys\\nprint("permanent-project")\\nprint(sys.stdin.readline().strip())\\nsys.__stdout__.write("provider-stdout\\\\n")\\nsys.__stdout__.flush()\\n',
          }],
        },
      });
      worker.terminate();

      const failingWorker = new Worker('/workers/pyodide-worker.js?tracecodePythonWorkerFormat=module', {
        type: 'module',
      });
      const failingPending = new Map();
      let failingNextId = 0;
      let failingReadyResolve;
      const failingReady = new Promise((resolve) => { failingReadyResolve = resolve; });
      failingWorker.onmessage = (event) => {
        const { id, type, payload, protocolToken } = event.data || {};
        if (type === 'worker-ready') {
          failingReadyResolve();
          return;
        }
        const pendingRequest = failingPending.get(id);
        if (!pendingRequest || pendingRequest.protocolToken !== protocolToken) return;
        failingPending.delete(id);
        if (type === 'error') pendingRequest.reject(new Error(payload && payload.error || 'Python worker error'));
        else pendingRequest.resolve(payload);
      };
      failingWorker.onerror = (event) => {
        for (const pendingRequest of failingPending.values()) {
          pendingRequest.reject(new Error(event.message || 'Python worker error'));
        }
        failingPending.clear();
      };
      const failingRequest = (type, payload) => new Promise((resolve, reject) => {
        const id = 'module-package-failure-' + (++failingNextId);
        const protocolToken = 'module-package-failure-token-' + failingNextId;
        failingPending.set(id, { resolve, reject, protocolToken });
        failingWorker.postMessage({ id, type, payload, protocolToken });
      });
      await failingReady;
      await failingRequest('init', {
        runtimeAssets: {
          loaderFormat: 'module',
          loaderUrl: 'https://cdn.jsdelivr.net/pyodide/v314.0.2/full/pyodide.mjs',
          indexUrl: 'https://cdn.jsdelivr.net/pyodide/v314.0.2/full/',
          runtimeCoreUrl: location.origin + '/workers/pyodide/runtime-core.js',
          snippetsUrl: location.origin + '/workers/generated-python-harness-snippets.js',
          packageUrls: {
            missing: location.origin + '/missing_package-1.0.0-py3-none-any.whl',
          },
        },
      });
      let configuredPackageFailure = '';
      try {
        await failingRequest('warmup');
      } catch (error) {
        configuredPackageFailure = error instanceof Error ? error.message : String(error);
      } finally {
        failingWorker.terminate();
      }
      return {
        initMs: init.loadTimeMs,
        warmupMs: warmup.loadTimeMs,
        executeMs,
        output: execution.output,
        projectStdout: project.stdout,
        workerFormat: 'module',
        configuredPackageFailure,
      };
    })()`);

    assertCondition(result.workerFormat === 'module', 'Browser smoke did not use a module worker');
    assertCondition(result.output === 42, `Pyodide 314.0.2 returned ${JSON.stringify(result.output)}, expected 42`);
    assertCondition(
      result.projectStdout === 'permanent-project\nmodule-stdin\nprovider-stdout\n',
      `Pyodide permanent project worker returned unexpected stdout: ${JSON.stringify(result.projectStdout)}`
    );
    assertCondition(Number.isFinite(result.initMs), 'Module bootstrap timing was not reported');
    assertCondition(Number.isFinite(result.warmupMs), 'Pyodide warmup timing was not reported');
    assertCondition(
      result.configuredPackageFailure.includes('missing_package-1.0.0-py3-none-any.whl'),
      `A failed manifest-declared package preload was reported as healthy: ${result.configuredPackageFailure}; requests=${JSON.stringify(missingPackageRequests)}`
    );
    console.log(`PASS: Pyodide 314.0.2 module worker browser smoke ${JSON.stringify(result)}`);
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('python module worker browser', main);

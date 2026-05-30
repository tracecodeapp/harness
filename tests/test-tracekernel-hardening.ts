#!/usr/bin/env npx tsx

import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntimeWorkspace } from '../packages/harness-project/src/index';
import { createBrowserJavaScriptProjectRunner } from '../packages/harness-javascript/src/project-browser';

const testFilePath = fileURLToPath(import.meta.url);
const testDirectory = dirname(testFilePath);

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

class ProtocolTestWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private workerOnMessage: ((event: MessageEvent) => void) | null = null;
  private readonly queuedMessages: unknown[] = [];
  private terminated = false;

  constructor(private readonly url: string) {
    void this.load();
  }

  postMessage(message: unknown): void {
    if (this.terminated) return;
    if (!this.workerOnMessage) {
      this.queuedMessages.push(message);
      return;
    }
    this.workerOnMessage({ data: message } as MessageEvent);
  }

  terminate(): void {
    this.terminated = true;
    this.workerOnMessage = null;
    this.queuedMessages.length = 0;
  }

  private async load(): Promise<void> {
    const scope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: (message: unknown) => {
        if (this.terminated) return;
        queueMicrotask(() => this.onmessage?.({ data: message } as MessageEvent));
      },
    };
    (globalThis as typeof globalThis & { self?: unknown; postMessage?: unknown }).self = scope;
    (globalThis as typeof globalThis & { self?: unknown; postMessage?: unknown }).postMessage = scope.postMessage;
    try {
      await import(this.url);
      this.workerOnMessage = scope.onmessage;
      for (const message of this.queuedMessages.splice(0)) {
        this.workerOnMessage?.({ data: message } as MessageEvent);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onerror?.({ message } as ErrorEvent);
    }
  }
}

async function withProtocolTestWorker(run: (workerUrl: string) => Promise<void>): Promise<void> {
  const previousWorker = (globalThis as typeof globalThis & { Worker?: unknown }).Worker;
  const previousSelf = (globalThis as typeof globalThis & { self?: unknown }).self;
  const previousPostMessage = (globalThis as typeof globalThis & { postMessage?: unknown }).postMessage;
  const workers: ProtocolTestWorker[] = [];
  (globalThis as typeof globalThis & { Worker?: unknown }).Worker = class extends ProtocolTestWorker {
    constructor(url: string) {
      super(url);
      workers.push(this);
    }
  };
  const workerUrl = `${pathToFileURL(join(testDirectory, '../packages/harness-javascript/src/project-browser-worker.ts')).href}?hardening=${Date.now()}-${Math.random()}`;
  try {
    await run(workerUrl);
  } finally {
    for (const worker of workers) worker.terminate();
    if (previousWorker === undefined) {
      delete (globalThis as typeof globalThis & { Worker?: unknown }).Worker;
    } else {
      (globalThis as typeof globalThis & { Worker?: unknown }).Worker = previousWorker;
    }
    if (previousSelf === undefined) {
      delete (globalThis as typeof globalThis & { self?: unknown }).self;
    } else {
      (globalThis as typeof globalThis & { self?: unknown }).self = previousSelf;
    }
    if (previousPostMessage === undefined) {
      delete (globalThis as typeof globalThis & { postMessage?: unknown }).postMessage;
    } else {
      (globalThis as typeof globalThis & { postMessage?: unknown }).postMessage = previousPostMessage;
    }
  }
}

async function testBrowserJavaScriptWorkerRejectsUserSpoofedResults(): Promise<void> {
  await withProtocolTestWorker(async (workerUrl) => {
    const runner = createBrowserJavaScriptProjectRunner({ workerUrl, timeoutMs: 1000 });
    const result = await runner({
      code: '',
      source: 'file',
      scriptPath: 'spoof.js',
      args: [],
      cwd: '/workspace',
      env: {},
      project: {
        cwd: '/workspace',
        files: [
          {
            path: 'spoof.js',
            contents: [
              'postMessage({ id: "1", type: "execute-result", payload: { stdout: "spoofed-result\\n", stderr: "", exitCode: 0 } });',
              'console.log("real-output");',
            ].join('\n'),
          },
        ],
      },
    });

    assertCondition(result.exitCode === 0, `worker-backed browser JS should still finish: ${JSON.stringify(result)}`);
    assertCondition(result.stdout === 'real-output\n', `worker-backed browser JS should ignore user-spoofed results: ${JSON.stringify(result)}`);
  });
}

async function testBrowserJavaScriptReadonlyHardlinksAreRejected(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    nodeRunner: createBrowserJavaScriptProjectRunner({ timeoutMs: 1000 }),
    projectSession: {
      id: 'hardening-session',
      projectId: 'hardening',
      projectSlug: 'hardening',
      name: 'TraceKernel Hardening',
      language: 'javascript',
      entrypoint: 'hardlink.js',
      files: [
        { path: 'README.md', contents: 'protected\n', readonly: true },
        { path: '.trace/fixtures/secret.txt', contents: 'secret\n', hidden: true },
        {
          path: 'hardlink.js',
          contents: [
            'const fs = require("node:fs");',
            'for (const [source, destination] of [["README.md", "alias.txt"], [".trace/fixtures/secret.txt", "visible-secret.txt"]]) {',
            '  try { fs.linkSync(source, destination); console.log(`${source}:linked`); }',
            '  catch (error) { console.log(`${source}:${error.code}`); }',
            '  console.log(`${destination}:exists=${fs.existsSync(destination)}`);',
            '}',
            'console.log(`readme=${fs.readFileSync("README.md", "utf8")}`);',
          ].join('\n'),
        },
      ],
    },
  });

  const result = await workspace.runCommand('node hardlink.js');
  assertCondition(result.exitCode === 0, `browser JS hardlink test should complete: ${JSON.stringify(result)}`);
  assertCondition(
    result.stdout === [
      'README.md:EROFS',
      'alias.txt:exists=false',
      '.trace/fixtures/secret.txt:EROFS',
      'visible-secret.txt:exists=false',
      'readme=protected',
      '',
      '',
    ].join('\n'),
    `browser JS should reject hardlinks from readonly/hidden files: ${JSON.stringify(result)}`
  );
  assertCondition(!(await workspace.exists('alias.txt')), 'readonly hardlink alias should not persist');
  assertCondition(!(await workspace.exists('visible-secret.txt')), 'hidden hardlink alias should not persist');
  assertCondition(await workspace.readFile('README.md') === 'protected\n', 'readonly source should remain unchanged');

  workspace.dispose();
}

async function testBrowserJavaScriptHiddenFilesAreNotMounted(): Promise<void> {
  const runner = createBrowserJavaScriptProjectRunner({ timeoutMs: 1000 });
  const result = await runner({
    code: '',
    source: 'file',
    scriptPath: 'main.js',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      workspaceRoot: '/workspace',
      files: [
        {
          path: 'main.js',
          contents: [
            'const fs = require("node:fs");',
            'for (const path of ["secret.txt", ".trace/fixtures/secret.txt"]) {',
            '  console.log(`${path}:exists=${fs.existsSync(path)}`);',
            '  try { console.log(`${path}:read=${fs.readFileSync(path, "utf8")}`); }',
            '  catch (error) { console.log(`${path}:read:${error.code}`); }',
            '  try { fs.copyFileSync(path, `${path.replaceAll("/", "_")}.copy`); console.log(`${path}:copy:ok`); }',
            '  catch (error) { console.log(`${path}:copy:${error.code}`); }',
            '}',
            'console.log(`root=${fs.readdirSync(".").join(",")}`);',
          ].join('\n'),
        },
        { path: 'secret.txt', contents: 'top-secret\n' },
        { path: '.trace/fixtures/secret.txt', contents: 'fixture-secret\n' },
      ],
      hiddenFiles: ['secret.txt', '.trace/fixtures/secret.txt'],
      readonlyFiles: ['secret.txt', '.trace/fixtures/secret.txt'],
    },
  });

  assertCondition(result.exitCode === 0, `hidden-file mount test should complete: ${JSON.stringify(result)}`);
  assertCondition(
    result.stdout === [
      'secret.txt:exists=false',
      'secret.txt:read:ENOENT',
      'secret.txt:copy:ENOENT',
      '.trace/fixtures/secret.txt:exists=false',
      '.trace/fixtures/secret.txt:read:ENOENT',
      '.trace/fixtures/secret.txt:copy:ENOENT',
      'root=main.js',
      '',
    ].join('\n'),
    `browser JS should not mount hidden project files for user code: ${JSON.stringify(result)}`
  );
  assertCondition(
    !result.files?.some((file) => file.path.includes('secret') || file.contents.includes('secret')),
    `hidden files should not leak through final diffs: ${JSON.stringify(result.files)}`
  );
}

async function testBrowserJavaScriptHiddenNamespaceMutationMatrix(): Promise<void> {
  const runner = createBrowserJavaScriptProjectRunner({ timeoutMs: 1000 });
  const operations = [
    'writeFileSync("readonly.txt","x")',
    'appendFileSync("readonly.txt","x")',
    'renameSync("readonly.txt","renamed.txt")',
    'writeFileSync(".trace/hidden.txt","x")',
    'mkdirSync(".trace", {recursive:true})',
    'renameSync("normal.txt",".trace/hidden.txt")',
    'linkSync("normal.txt",".trace/link.txt")',
    'copyFileSync("normal.txt",".trace/copy.txt")',
  ];
  const result = await runner({
    code: [
      'const fs = require("node:fs");',
      `const operations = ${JSON.stringify(operations)};`,
      'for (const operation of operations) {',
      '  try { eval(`fs.${operation}`); console.log(`${operation}:ok`); }',
      '  catch (error) { console.log(`${operation}:${error.code}`); }',
      '}',
      'console.log(`root=${fs.readdirSync(".").join(",")}`);',
      'try { console.log(`trace=${fs.readdirSync(".trace").join(",")}`); }',
      'catch (error) { console.log(`trace:${error.code}`); }',
    ].join('\n'),
    source: 'inline',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      workspaceRoot: '/workspace',
      files: [
        { path: 'normal.txt', contents: 'normal\n' },
        { path: 'readonly.txt', contents: 'readonly\n' },
        { path: '.trace/hidden.txt', contents: 'hidden\n' },
      ],
      hiddenFiles: ['.trace/hidden.txt'],
      readonlyFiles: ['readonly.txt', '.trace/hidden.txt'],
    },
  });

  assertCondition(result.exitCode === 0, `hidden namespace mutation matrix should complete: ${JSON.stringify(result)}`);
  assertCondition(
    result.stdout === [
      'writeFileSync("readonly.txt","x"):EROFS',
      'appendFileSync("readonly.txt","x"):EROFS',
      'renameSync("readonly.txt","renamed.txt"):EROFS',
      'writeFileSync(".trace/hidden.txt","x"):EROFS',
      'mkdirSync(".trace", {recursive:true}):EROFS',
      'renameSync("normal.txt",".trace/hidden.txt"):EROFS',
      'linkSync("normal.txt",".trace/link.txt"):EROFS',
      'copyFileSync("normal.txt",".trace/copy.txt"):EROFS',
      'root=normal.txt,readonly.txt',
      'trace:ENOENT',
      '',
    ].join('\n'),
    `browser JS should reject writes into hidden namespaces: ${JSON.stringify(result)}`
  );
  assertCondition(
    !result.files?.some((file) => file.path.startsWith('.trace/') || file.contents.includes('hidden')),
    `hidden namespace files should not leak through final diffs: ${JSON.stringify(result.files)}`
  );
}

async function testTraceKernelHttpTimeoutSignalsCooperativeHandlers(): Promise<void> {
  const workspace = await createRuntimeWorkspace();
  let sideEffectsAfterTimeout = 0;
  let signalSeen = false;
  let signalAborted = false;
  const listener = workspace.http.listen({ host: '127.0.0.1', port: 3650 }, async (request) => {
    signalSeen = Boolean(request.signal);
    request.signal?.addEventListener('abort', () => {
      signalAborted = true;
    }, { once: true });
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (!request.signal?.aborted) sideEffectsAfterTimeout += 1;
    return { status: 200, body: 'late\n' };
  });
  try {
    const response = await workspace.http.request({ url: 'http://localhost:3650/slow', timeoutMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertCondition(response.status === 0, `TraceKernel HTTP timeout should return a transport failure: ${JSON.stringify(response)}`);
    assertCondition(signalSeen, 'TraceKernel HTTP handlers should receive a request abort signal');
    assertCondition(signalAborted, 'TraceKernel HTTP timeout should abort the request signal');
    assertCondition(sideEffectsAfterTimeout === 0, 'cooperative TraceKernel HTTP handlers should be able to suppress post-timeout side effects');
  } finally {
    listener.close();
    workspace.dispose();
  }
}

async function testTraceKernelHttpDiagnosticsAreRedacted(): Promise<void> {
  const workspace = await createRuntimeWorkspace();
  let handlerUrl = '';
  const listener = workspace.http.listen({ host: '127.0.0.1', port: 3651 }, (request) => {
    handlerUrl = request.url;
    return { status: 200, body: 'ok\n' };
  });
  try {
    const response = await workspace.http.request({
      url: 'http://user:pass@localhost:3651/path?token=secret-token&api_key=secret-key&visible=yes',
    });
    assertCondition(response.status === 200, `redaction request should succeed: ${JSON.stringify(response)}`);
    assertCondition(handlerUrl.includes('secret-token') && handlerUrl.includes('secret-key'), 'handler should receive the original request URL');
    const requests = await workspace.readFile('/proc/tracekernel/net/requests');
    const events = await workspace.readFile('/proc/tracekernel/events');
    assertCondition(!requests.includes('secret-token') && !requests.includes('secret-key') && !requests.includes('user:pass'), `request diagnostics should redact secrets: ${requests}`);
    assertCondition(!events.includes('secret-token') && !events.includes('secret-key') && !events.includes('user:pass'), `event diagnostics should redact secrets: ${events}`);
    assertCondition(requests.includes('token=redacted') && requests.includes('api_key=redacted') && requests.includes('visible=yes'), `request diagnostics should preserve useful non-secret context: ${requests}`);
  } finally {
    listener.close();
    workspace.dispose();
  }
}

async function testTraceKernelHttpListenerLimit(): Promise<void> {
  const workspace = await createRuntimeWorkspace();
  const listeners: Array<{ close(): void }> = [];
  try {
    for (let index = 0; index < 128; index += 1) {
      listeners.push(workspace.http.listen({ host: '127.0.0.1', port: 0 }, () => ({ status: 200, body: 'ok\n' })));
    }
    let rejected = false;
    try {
      workspace.http.listen({ host: '127.0.0.1', port: 0 }, () => ({ status: 200, body: 'overflow\n' }));
    } catch (error) {
      rejected = (error as { code?: unknown }).code === 'EAGAIN';
    }
    assertCondition(rejected, 'TraceKernel HTTP should reject listener exhaustion with EAGAIN');
  } finally {
    for (const listener of listeners) listener.close();
    workspace.dispose();
  }
}

async function main(): Promise<void> {
  await testBrowserJavaScriptWorkerRejectsUserSpoofedResults();
  await testBrowserJavaScriptReadonlyHardlinksAreRejected();
  await testBrowserJavaScriptHiddenFilesAreNotMounted();
  await testBrowserJavaScriptHiddenNamespaceMutationMatrix();
  await testTraceKernelHttpTimeoutSignalsCooperativeHandlers();
  await testTraceKernelHttpDiagnosticsAreRedacted();
  await testTraceKernelHttpListenerLimit();
  console.log('tracekernel hardening tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

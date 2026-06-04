#!/usr/bin/env npx tsx

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { javaTraceHooksEventsToRuntimeTrace } from '../packages/harness-core/src/trace-adapters/java';
import { createRuntimeWorkspace } from '../packages/harness-project/src/index';
import { assertRuntimeFinalDiffBudget } from '../packages/harness-core/src/runtime-project';
import { createBrowserJavaScriptProjectRunner } from '../packages/harness-javascript/src/project-browser';
import { createNativeCSharpProjectRunner } from '../packages/harness-csharp/src/project-node';
import { createNativeCppProjectRunner } from '../packages/harness-cpp/src/project-node';
import { createNativeJavaProjectRunner } from '../packages/harness-java/src/project-node';

const testFilePath = fileURLToPath(import.meta.url);
const testDirectory = dirname(testFilePath);

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function nativeJavaTraceEvent(event: Record<string, unknown>): string {
  return `trace:${JSON.stringify(event)}`;
}

async function rejectedMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
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

async function testBrowserJavaScriptHardenedModeRequiresWorker(): Promise<void> {
  const previousWorker = (globalThis as typeof globalThis & { Worker?: unknown }).Worker;
  delete (globalThis as typeof globalThis & { Worker?: unknown }).Worker;
  try {
    const runner = createBrowserJavaScriptProjectRunner({ hardened: true, timeoutMs: 1000 });
    const result = await runner({
      code: 'console.log("should-not-run");',
      source: 'inline',
      args: [],
      cwd: '/workspace',
      env: {},
      project: {
        cwd: '/workspace',
        workspaceRoot: '/workspace',
        files: [],
      },
    });

    assertCondition(result.exitCode === 1, `hardened browser JS without Worker should fail closed: ${JSON.stringify(result)}`);
    assertCondition(result.stdout === '', `hardened browser JS should not execute same-realm code: ${JSON.stringify(result)}`);
    assertCondition(
      result.stderr.includes('requires a Worker-backed runner'),
      `hardened browser JS should explain the missing Worker-backed runner: ${JSON.stringify(result)}`
    );
  } finally {
    if (previousWorker === undefined) {
      delete (globalThis as typeof globalThis & { Worker?: unknown }).Worker;
    } else {
      (globalThis as typeof globalThis & { Worker?: unknown }).Worker = previousWorker;
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
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, timeoutMs: 1000 }),
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
  const runner = createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, timeoutMs: 1000 });
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
  const runner = createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, timeoutMs: 1000 });
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

async function testJavaScriptTraceSerializationIsBounded(): Promise<void> {
  const source = await readFile(join(dirname(testDirectory), 'workers', 'javascript', 'javascript-worker.js'), 'utf8');
  const postedMessages: unknown[] = [];
  const workerScope = {
    location: { search: '' },
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (message: unknown) => {
      postedMessages.push(message);
    },
  };
  const context = vm.createContext({
    console,
    self: workerScope,
    postMessage: workerScope.postMessage,
    performance: { now: () => 0 },
    queueMicrotask,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder,
  });
  vm.runInContext(source, context, { filename: 'javascript-worker.js' });

  const result = vm.runInContext(
    `(() => {
      const shared = { leaf: { value: 1 } };
      const aliasSerialized = serializeTopLevelValue(
        { first: shared, second: shared },
        { ids: new Map(), nextId: 1 }
      );
      const broad = Array.from({ length: 64 }, (_, row) =>
        Array.from({ length: 64 }, (_, column) => ({ row, column }))
      );
      const broadSerialized = serializeTopLevelValue(broad, { ids: new Map(), nextId: 1 });
      const broadText = JSON.stringify(broadSerialized);
      return {
        aliasFirstValue: aliasSerialized.first.leaf.value,
        aliasSecond: aliasSerialized.second,
        broadLength: broadText.length,
        broadHasBudgetMarker: broadText.includes('max serialized nodes'),
      };
    })()`,
    context
  ) as { aliasFirstValue: number; aliasSecond: unknown; broadLength: number; broadHasBudgetMarker: boolean };

  assertCondition(result.aliasFirstValue === 1, `JS serializer should still materialize the first alias: ${JSON.stringify(result)}`);
  assertCondition(result.aliasSecond === '<cycle>', `JS serializer should not duplicate shared object aliases: ${JSON.stringify(result)}`);
  assertCondition(result.broadHasBudgetMarker, `JS serializer should emit the max-node budget marker: ${JSON.stringify(result)}`);
  assertCondition(result.broadLength < 250_000, `JS serializer should keep broad graphs bounded: ${JSON.stringify(result)}`);
}

async function testJavaScriptInputMaterializerAvoidsTypeNameEval(): Promise<void> {
  const sources = [
    ['worker', await readFile(join(dirname(testDirectory), 'workers', 'javascript', 'javascript-worker.js'), 'utf8')],
    [
      'package executor',
      await readFile(join(dirname(testDirectory), 'packages', 'harness-javascript', 'src', 'javascript-executor.ts'), 'utf8'),
    ],
  ] as const;

  for (const [label, source] of sources) {
    assertCondition(
      !source.includes('return eval(__typeName)'),
      `${label} input materializer must not eval serialized __type__/__class names`
    );
    assertCondition(
      source.includes('__tracecodeConstructorRegistry'),
      `${label} input materializer should resolve constructors through the trusted registry`
    );
  }
}

async function testJavaScriptDestructuredIterableTracingDoesNotExhaustValues(): Promise<void> {
  const source = await readFile(join(dirname(testDirectory), 'workers', 'javascript', 'javascript-worker.js'), 'utf8');
  const pending = new Map<string, { token: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let ready = false;
  const workerScope = {
    location: { search: '' },
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (message: unknown) => {
      const record = message as { id?: string; type?: string; payload?: unknown; protocolToken?: string };
      if (record.type === 'worker-ready') {
        ready = true;
        return;
      }
      if (!record.id) return;
      const entry = pending.get(record.id);
      if (!entry || record.protocolToken !== entry.token) return;
      pending.delete(record.id);
      if (record.type === 'error') {
        entry.reject(new Error(String((record.payload as { error?: unknown } | undefined)?.error ?? 'worker error')));
        return;
      }
      entry.resolve(record.payload);
    },
  };
  const context = vm.createContext({
    console,
    self: workerScope,
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    importScripts: (...urls: string[]) => {
      throw new Error(`Unexpected importScripts in destructured iterable test: ${urls.join(',')}`);
    },
  });
  vm.runInContext(source, context, { filename: 'javascript-worker.js' });
  assertCondition(ready, 'JavaScript worker should emit ready before destructured iterable test');
  assertCondition(typeof workerScope.onmessage === 'function', 'JavaScript worker should register onmessage');

  const id = 'destructured-iterable';
  const token = 'destructured-iterable-token';
  const response = new Promise<{ success?: boolean; output?: unknown; error?: string }>((resolve, reject) => {
    pending.set(id, { token, resolve: resolve as (value: unknown) => void, reject });
  });
  workerScope.onmessage?.({
    data: {
      id,
      protocolToken: token,
      type: 'execute-with-tracing',
      payload: {
        code: [
          'function solve() {',
          '  let pulls = 0;',
          '  function makePair() {',
          '    const iterator = {',
          '      next() {',
          '        pulls += 1;',
          '        if (pulls === 1) return { value: 2, done: false };',
          '        if (pulls === 2) return { value: 3, done: false };',
          '        return { done: true };',
          '      },',
          '      return() { return { done: true }; },',
          '      [Symbol.iterator]() { return this; },',
          '    };',
          '    return iterator;',
          '  }',
          '  let total = 0;',
          '  for (const [a, b] of [makePair()]) {',
          '    total = a * 10 + b;',
          '  }',
          '  return { total, pulls };',
          '}',
        ].join('\n'),
        functionName: 'solve',
        inputs: {},
        executionStyle: 'function',
        language: 'javascript',
      },
    },
  });

  const result = await response;
  assertCondition(result.success === true, `destructured iterable trace should execute: ${result.error ?? 'unknown error'}`);
  assertCondition(
    JSON.stringify(result.output) === JSON.stringify({ total: 23, pulls: 2 }),
    `destructured iterable tracing should not pre-consume yielded iterables: ${JSON.stringify(result.output)}`
  );
}

async function testNativeProjectRunnersRejectVirtualPathTraversal(): Promise<void> {
  const projectRoot = '/home/obi/weather-api';
  const project = {
    cwd: projectRoot,
    workspaceRoot: projectRoot,
    workspaceAlias: '/workspace',
    files: [
      { path: 'main.cpp', contents: 'int main() { return 0; }\n' },
      { path: 'Main.java', contents: 'public class Main { public static void main(String[] args) {} }\n' },
      { path: 'Program.cs', contents: 'System.Console.WriteLine("ok");\n' },
    ],
  };

  const cppError = await rejectedMessage(() => createNativeCppProjectRunner({
    compilerCommand: process.execPath,
    timeoutMs: 1000,
  })({
    code: '',
    source: 'compile',
    scriptPath: '/workspace/main.cpp',
    args: ['-std=c++17', `${projectRoot}/../../escape.cpp`, '-o', '/workspace/../../pwn'],
    cwd: projectRoot,
    env: {},
    project,
  }));
  assertCondition(cppError.includes('must not escape the workspace'), `native C++ runner should reject virtual traversal before spawn: ${cppError}`);

  const javaError = await rejectedMessage(() => createNativeJavaProjectRunner({
    javacCommand: process.execPath,
    javaCommand: process.execPath,
    timeoutMs: 1000,
  })({
    code: '',
    source: 'compile',
    scriptPath: '/workspace/Main.java',
    args: ['-d', '/workspace/../../classes', 'Main.java'],
    cwd: projectRoot,
    env: {},
    project,
  }));
  assertCondition(javaError.includes('must not escape the workspace'), `native Java runner should reject virtual traversal before spawn: ${javaError}`);

  const csharpError = await rejectedMessage(() => createNativeCSharpProjectRunner({
    dotnetCommand: process.execPath,
    timeoutMs: 1000,
  })({
    code: '',
    source: 'compile',
    scriptPath: '/workspace/Program.cs',
    args: ['--output', '/workspace/../../bin'],
    cwd: projectRoot,
    env: {},
    project,
  }));
  assertCondition(csharpError.includes('must not escape the workspace'), `native C# runner should reject virtual traversal before spawn: ${csharpError}`);
}

async function testCSharpWorkerRejectsKernelAndWorkspaceTraversal(): Promise<void> {
  const source = await readFile(join(dirname(testDirectory), 'workers', 'csharp', 'csharp-worker.js'), 'utf8');
  const context = vm.createContext({
    console,
    self: {
      addEventListener: () => {},
      postMessage: () => {},
      close: () => {},
      location: { search: '' },
    },
    TextEncoder,
    TextDecoder,
    Uint8Array,
    SharedArrayBuffer,
    Int32Array,
    Atomics,
    btoa: (binary: string) => Buffer.from(binary, 'binary').toString('base64'),
    atob: (encoded: string) => Buffer.from(encoded, 'base64').toString('binary'),
    performance: { now: () => 0 },
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  vm.runInContext(source, context, { filename: 'csharp-worker.js' });
  const result = vm.runInContext(
    `(() => {
      const request = { project: { cwd: '/workspace/src', workspaceRoot: '/workspace', workspaceAlias: '/workspace' } };
      let mutationError = '';
      try {
        throwProjectWorkspaceEscapingMutationError('/workspace/src/../../escape.txt', 'write');
      } catch (error) {
        mutationError = error && error.code ? error.code : String(error && error.message || error);
      }
      return {
        kernelTraversal: normalizeKernelVirtualManifestPath('/proc/../workspace/pwn.txt'),
        deviceTraversal: normalizeRawKernelDevicePath('/dev/../workspace/stdout'),
        escapedLivePath: normalizeProjectFsPath('/workspace/src/../../escape.txt', request),
        normalizedLivePath: normalizeProjectFsPath('/workspace/src/../safe.txt', request),
        mutationError,
      };
    })()`,
    context
  ) as {
    kernelTraversal: string | null;
    deviceTraversal: string | null;
    escapedLivePath: string | null;
    normalizedLivePath: string | null;
    mutationError: string;
  };

  assertCondition(result.kernelTraversal === null, `C# kernel manifest traversal should be rejected: ${JSON.stringify(result)}`);
  assertCondition(result.deviceTraversal === null, `C# device manifest traversal should be rejected: ${JSON.stringify(result)}`);
  assertCondition(result.escapedLivePath === null, `C# live event traversal path should not be emitted: ${JSON.stringify(result)}`);
  assertCondition(result.normalizedLivePath === 'safe.txt', `C# live event path should normalize in-workspace dot segments: ${JSON.stringify(result)}`);
  assertCondition(result.mutationError === 'EACCES', `C# workspace escape mutation should be rejected: ${JSON.stringify(result)}`);
}

async function testCSharpWorkerProjectEventBudgets(): Promise<void> {
  const source = await readFile(join(dirname(testDirectory), 'workers', 'csharp', 'csharp-worker.js'), 'utf8');
  const posted: Array<{ type?: string; payload?: { type?: string; stream?: string; data?: string; change?: { path?: string } } }> = [];
  const context = vm.createContext({
    console,
    self: {
      addEventListener: () => {},
      postMessage: (message: unknown) => {
        posted.push(message as { type?: string; payload?: { type?: string; stream?: string; data?: string; change?: { path?: string } } });
      },
      close: () => {},
      location: { search: '' },
    },
    TextEncoder,
    TextDecoder,
    Uint8Array,
    SharedArrayBuffer,
    Int32Array,
    Atomics,
    btoa: (binary: string) => Buffer.from(binary, 'binary').toString('base64'),
    atob: (encoded: string) => Buffer.from(encoded, 'base64').toString('binary'),
    performance: { now: () => 0 },
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  vm.runInContext(source, context, { filename: 'csharp-worker.js' });
  const result = vm.runInContext(
    `(() => {
      activeProjectIo = {
        messageId: 'budget-test',
        protocolToken: 'token',
        eventStdout: [],
        eventStderr: [],
        outputBytes: { stdout: 0, stderr: 0 },
        truncatedOutputStreams: new Set(),
        liveFileChangeCount: 0,
        liveFileChangeBytes: 0,
        warnedLiveFileBudget: false,
      };
      emitProjectEvent({
        type: 'output',
        stream: 'stdout',
        device: '/dev/stdout',
        data: 'x'.repeat(1024 * 1024 + 16),
      });
      emitProjectEvent({
        type: 'output',
        stream: 'stdout',
        device: '/dev/stdout',
        data: 'late',
      });
      emitProjectEvent({
        type: 'file-change',
        phase: 'live',
        change: { path: 'huge.txt', contents: 'x'.repeat(4 * 1024 * 1024 + 1) },
      });
      const stdout = activeProjectIo.eventStdout.join('');
      const truncated = activeProjectIo.truncatedOutputStreams.has('stdout');
      activeProjectIo = null;
      return { stdout, truncated };
    })()`,
    context
  ) as { stdout: string; truncated: boolean };
  const projectEvents = posted.filter((message) => message.type === 'project-event');
  const outputEvents = projectEvents.filter((message) => message.payload?.type === 'output');
  const fileChangeEvents = projectEvents.filter((message) => message.payload?.type === 'file-change');

  assertCondition(result.truncated, `C# worker should mark oversized stdout as truncated: ${JSON.stringify(result)}`);
  assertCondition(
    result.stdout.includes('output truncated after 1048576 bytes'),
    `C# worker should keep a capped stdout buffer with marker: ${JSON.stringify(result)}`
  );
  assertCondition(outputEvents.length === 1, `C# worker should drop stdout chunks after truncation: ${JSON.stringify(projectEvents)}`);
  assertCondition(fileChangeEvents.length === 0, `C# worker should drop oversized live file-change payloads: ${JSON.stringify(projectEvents)}`);
}

async function testJavaWorkerProjectEventBudgets(): Promise<void> {
  const source = (await readFile(join(dirname(testDirectory), 'workers', 'java', 'java-worker.js'), 'utf8')).replace(
    /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/shared\/runtime-kernel-policy\.js['"];\s*/m,
    ''
  );
  const posted: Array<{ type?: string; payload?: { type?: string; stream?: string; data?: string; change?: { path?: string } } }> = [];
  const context = vm.createContext({
    console,
    self: {
      postMessage: (message: unknown) => {
        posted.push(message as { type?: string; payload?: { type?: string; stream?: string; data?: string; change?: { path?: string } } });
      },
      location: { href: 'http://localhost/workers/java/java-worker.js', origin: 'http://localhost', search: '' },
    },
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    SharedArrayBuffer,
    Int32Array,
    Atomics,
    btoa: (binary: string) => Buffer.from(binary, 'binary').toString('base64'),
    atob: (encoded: string) => Buffer.from(encoded, 'base64').toString('binary'),
    performance: { now: () => 0 },
    queueMicrotask: (callback: () => void) => callback(),
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  vm.runInContext(source, context, { filename: 'java-worker.js' });
  const result = vm.runInContext(
    `(() => {
      activeJavaProjectIo = {
        messageId: 'java-budget-test',
        request: { project: { kernelDevices: [] } },
        stdinPipe: null,
        stdoutEmitted: false,
        stderrEmitted: false,
        eventStdout: [],
        eventStderr: [],
        outputBytes: { stdout: 0, stderr: 0 },
        truncatedOutputStreams: new Set(),
        liveFileChangeCount: 0,
        liveFileChangeBytes: 0,
        warnedLiveFileBudget: false,
      };
      emitLiveJavaProjectOutput('stdout', 'x'.repeat(1024 * 1024 + 16), '', '');
      emitLiveJavaProjectOutput('stdout', 'late', '', '');
      emitLiveJavaProjectFileSnapshot('huge.txt', 'x'.repeat(6 * 1024 * 1024));
      const stdout = activeJavaProjectIo.eventStdout.join('');
      const truncated = activeJavaProjectIo.truncatedOutputStreams.has('stdout');
      const emitted = { stdout: activeJavaProjectIo.stdoutEmitted, stderr: activeJavaProjectIo.stderrEmitted };
      activeJavaProjectIo = null;
      return { stdout, truncated, emitted };
    })()`,
    context
  ) as { stdout: string; truncated: boolean; emitted: { stdout: boolean; stderr: boolean } };
  const projectEvents = posted.filter((message) => message.type === 'project-event');
  const outputEvents = projectEvents.filter((message) => message.payload?.type === 'output');
  const fileChangeEvents = projectEvents.filter((message) => message.payload?.type === 'file-change');

  assertCondition(result.truncated, `Java worker should mark oversized stdout as truncated: ${JSON.stringify(result)}`);
  assertCondition(result.emitted.stdout, `Java worker should track emitted stdout after budgeted events: ${JSON.stringify(result)}`);
  assertCondition(
    result.stdout.includes('output truncated after 1048576 bytes'),
    `Java worker should keep a capped stdout buffer with marker: ${JSON.stringify(result)}`
  );
  assertCondition(outputEvents.length === 1, `Java worker should drop stdout chunks after truncation: ${JSON.stringify(projectEvents)}`);
  assertCondition(fileChangeEvents.length === 0, `Java worker should drop oversized live file-change payloads: ${JSON.stringify(projectEvents)}`);
}

function testJavaHelperRunScopeAndCacheManifest(): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tracecode-java-helper-hardening-'));
  try {
    const sourcePath = join(tmpRoot, 'JavaHelperStateSmoke.java');
    const classesPath = join(tmpRoot, 'classes');
    const helperJar = join(process.cwd(), 'workers', 'vendor', 'java-browser-helper.jar');
    writeFileSync(
      sourcePath,
      `import tracecode.browser.BrowserCompileAndTraceLibrary;
import tracecode.browser.ProjectEvents;
import tracecode.user.TraceHooks;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public class JavaHelperStateSmoke {
  public static void main(String[] args) throws Exception {
    runTraceHooksStaleThread();
    runProjectEventsStaleStream();
    runCompileCacheManifest(args[0]);
  }

  private static void runTraceHooksStaleThread() throws Exception {
    int firstToken = TraceHooks.beginRun(10);
    CountDownLatch staleAttempted = new CountDownLatch(1);
    Thread stale = new Thread(() -> {
      try {
        Thread.sleep(100);
        TraceHooks.emit("trace:{\\\\\\"kind\\\\\\":\\\\\\"line\\\\\\",\\\\\\"line\\\\\\":99}");
      } catch (Exception error) {
        throw new RuntimeException(error);
      } finally {
        staleAttempted.countDown();
      }
    });
    stale.start();
    TraceHooks.emit("trace:{\\\\\\"kind\\\\\\":\\\\\\"line\\\\\\",\\\\\\"line\\\\\\":1}");
    int secondToken = TraceHooks.beginRun(10);
    TraceHooks.emit("trace:{\\\\\\"kind\\\\\\":\\\\\\"line\\\\\\",\\\\\\"line\\\\\\":2}");
    if (!staleAttempted.await(2, TimeUnit.SECONDS)) {
      throw new IllegalStateException("stale TraceHooks thread did not run");
    }
    String events = String.join("\\\\n", TraceHooks.drainEvents());
    TraceHooks.endRun(secondToken);
    TraceHooks.endRun(firstToken);
    if (!events.contains("\\\\\\"line\\\\\\":2") || events.contains("\\\\\\"line\\\\\\":1") || events.contains("\\\\\\"line\\\\\\":99")) {
      throw new IllegalStateException("TraceHooks stale run isolation failed: " + events);
    }
    System.out.println("trace-hooks-ok");
  }

  private static void runProjectEventsStaleStream() throws Exception {
    ByteArrayOutputStream capture = new ByteArrayOutputStream();
    int firstToken = ProjectEvents.beginProjectRun();
    OutputStream firstStream = ProjectEvents.streamingOutput(capture, "stdout");
    CountDownLatch staleAttempted = new CountDownLatch(1);
    Thread stale = new Thread(() -> {
      try {
        Thread.sleep(100);
        firstStream.write("stale\\\\n".getBytes(StandardCharsets.UTF_8));
        firstStream.flush();
      } catch (Exception error) {
        throw new RuntimeException(error);
      } finally {
        staleAttempted.countDown();
      }
    });
    stale.start();
    firstStream.write("current\\\\n".getBytes(StandardCharsets.UTF_8));
    firstStream.flush();
    int secondToken = ProjectEvents.beginProjectRun();
    if (!staleAttempted.await(2, TimeUnit.SECONDS)) {
      throw new IllegalStateException("stale ProjectEvents thread did not run");
    }
    OutputStream secondStream = ProjectEvents.streamingOutput(capture, "stdout");
    secondStream.write("next\\\\n".getBytes(StandardCharsets.UTF_8));
    secondStream.flush();
    ProjectEvents.endProjectRun(secondToken);
    ProjectEvents.endProjectRun(firstToken);
    String captured = capture.toString(StandardCharsets.UTF_8.name());
    if (!captured.contains("current\\\\n") || !captured.contains("next\\\\n") || captured.contains("stale")) {
      throw new IllegalStateException("ProjectEvents stale stream isolation failed: " + captured);
    }
    System.out.println("project-events-ok");
  }

  private static void runCompileCacheManifest(String helperJar) throws Exception {
    Path root = Files.createTempDirectory("tracecode-java-cache-smoke-");
    Path source = root.resolve("Main.java");
    Path classes = root.resolve("classes");
    Files.writeString(
        source,
        "import tracecode.user.TraceHooks; public class Main { public static String run() { return TraceHooks.serializeOutputResult(new String(new char[]{'o','k'})); } }\\n",
        StandardCharsets.UTF_8);
    String first = BrowserCompileAndTraceLibrary.compileAndRun(source.toString(), classes.toString(), "Main", helperJar, "none");
    Files.writeString(classes.resolve("Poison.class"), "not-a-class", StandardCharsets.UTF_8);
    String second = BrowserCompileAndTraceLibrary.compileAndRun(source.toString(), classes.toString(), "Main", helperJar, "none");
    String third = BrowserCompileAndTraceLibrary.compileAndRun(source.toString(), classes.toString(), "Main", helperJar, "none");
    if (!first.contains("\\\"compileCacheHit\\\":false") ||
        !second.contains("\\\"compileCacheHit\\\":false") ||
        !third.contains("\\\"compileCacheHit\\\":true")) {
      throw new IllegalStateException("Java compile cache manifest isolation failed: " + first + "\\n" + second + "\\n" + third);
    }
    System.out.println("compile-cache-ok");
  }
}
`,
      'utf8'
    );
    mkdirSync(classesPath);
    execFileSync('javac', ['-cp', helperJar, '-d', classesPath, sourcePath], { cwd: process.cwd(), stdio: 'pipe' });
    const output = execFileSync(
      'java',
      ['-cp', [classesPath, helperJar].join(delimiter), 'JavaHelperStateSmoke', helperJar],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' }
    );
    assertCondition(output.includes('trace-hooks-ok'), `TraceHooks run-scope smoke should pass: ${output}`);
    assertCondition(output.includes('project-events-ok'), `ProjectEvents run-scope smoke should pass: ${output}`);
    assertCondition(output.includes('compile-cache-ok'), `Java compile cache manifest smoke should pass: ${output}`);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function testJavaWorkerDiagnosticsAreBounded(): Promise<void> {
  const source = (await readFile(join(dirname(testDirectory), 'workers', 'java', 'java-worker.js'), 'utf8')).replace(
    /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/shared\/runtime-kernel-policy\.js['"];\s*/m,
    ''
  );
  const context = vm.createContext({
    console,
    self: {
      postMessage: () => {},
      location: { href: 'http://localhost/workers/java/java-worker.js', origin: 'http://localhost', search: '' },
    },
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    SharedArrayBuffer,
    Int32Array,
    Atomics,
    btoa: (binary: string) => Buffer.from(binary, 'binary').toString('base64'),
    atob: (encoded: string) => Buffer.from(encoded, 'base64').toString('binary'),
    performance: { now: () => 0 },
    queueMicrotask: (callback: () => void) => callback(),
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  vm.runInContext(source, context, { filename: 'java-worker.js' });
  const result = vm.runInContext(
    `(() => {
      const sourceRoot = '/files/java-worker/source-root';
      const projectRoot = '/workspace/' + 'r'.repeat(200000);
      const diagnosticLine = sourceRoot + '/Main.java:1: error: boom';
      const compilerStdout = Array.from({ length: 4096 }, () => diagnosticLine).join('\\n');
      const runtimeError = 'runtime:' + 'x'.repeat(200000);
      const stderr = javaProjectFailureStderr({ compilerStdout, compilerStderr: '', runtimeError }, sourceRoot, projectRoot);
      return {
        length: stderr.length,
        hasHugePath: stderr.includes('r'.repeat(4096)),
        hasTruncation: stderr.includes('<truncated'),
      };
    })()`,
    context
  ) as { length: number; hasHugePath: boolean; hasTruncation: boolean };

  assertCondition(result.length <= 66000, `Java project diagnostics should be capped: ${JSON.stringify(result)}`);
  assertCondition(!result.hasHugePath, `Java project diagnostics should cap replacement paths: ${JSON.stringify(result)}`);
  assertCondition(result.hasTruncation, `Java project diagnostics should include truncation marker: ${JSON.stringify(result)}`);
}

function testJavaTraceHeaderExpansionIsBounded(): void {
  const sourceText = [
    'class Solution {',
    '  void run() {',
    '    for (int i = 0; i < 10; i++) {',
    '      work();',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const rawEvents: string[] = [
    nativeJavaTraceEvent({ kind: 'line', line: 1, function: 'run' }),
  ];
  for (let index = 0; index < 5000; index += 1) {
    rawEvents.push(nativeJavaTraceEvent({
      kind: 'snapshot',
      line: 2,
      target: { variable: `v${index}` },
      value: index,
    }));
  }
  rawEvents.push(nativeJavaTraceEvent({ kind: 'line', line: 4, function: 'run' }));

  const trace = javaTraceHooksEventsToRuntimeTrace(rawEvents, sourceText, { runId: 'java:bounded-header' });
  const headerEvents = trace.events.filter((event) => event.line === 3);

  assertCondition(
    trace.events.length <= rawEvents.length + 2048,
    `Java header expansion should cap synthetic event growth: raw=${rawEvents.length} normalized=${trace.events.length}`
  );
  assertCondition(
    headerEvents.length <= 2048,
    `Java header expansion should cap synthetic header events: ${headerEvents.length}`
  );
}

async function testCppWorkerProjectEventBudgets(): Promise<void> {
  const source = (await readFile(join(dirname(testDirectory), 'workers', 'cpp', 'cpp-worker.js'), 'utf8')).replace(
    /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/shared\/runtime-kernel-policy\.js['"];\s*/m,
    ''
  );
  const posted: Array<{ type?: string; payload?: { type?: string; stream?: string; data?: string; change?: { path?: string } } }> = [];
  const context = vm.createContext({
    console,
    self: { location: { href: 'http://localhost/workers/cpp/cpp-worker.js', origin: 'http://localhost', search: '' } },
    location: { href: 'http://localhost/workers/cpp/cpp-worker.js', origin: 'http://localhost', search: '' },
    postMessage: (message: unknown) => {
      posted.push(message as { type?: string; payload?: { type?: string; stream?: string; data?: string; change?: { path?: string } } });
    },
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    WebAssembly,
    BigInt,
    Map,
    Set,
    Promise,
    JSON,
    Math,
    Date,
    performance: { now: () => 0 },
    btoa: (binary: string) => Buffer.from(binary, 'binary').toString('base64'),
    atob: (encoded: string) => Buffer.from(encoded, 'base64').toString('binary'),
  });
  vm.runInContext(source, context, { filename: 'cpp-worker.js' });
  const result = vm.runInContext(
    `(() => {
      const events = createProjectEventBridge('cpp-budget-test');
      const result = { stdout: 'x'.repeat(1024 * 1024 + 16), stderr: '' };
      emitProjectResultOutputEvents(events, result);
      events.output('stdout', 'late');
      events.fileBytesChange('huge.bin', new Uint8Array(4 * 1024 * 1024 + 1));
      const byteBudget = createProjectOutputByteBudget();
      const first = byteBudget.capture('stderr', [encodeUtf8('e'.repeat(1024 * 1024 + 16))]);
      const second = byteBudget.capture('stderr', [encodeUtf8('late')]);
      return {
        stdout: result.stdout,
        byteBudgetOutput: decodeUtf8(concatBytes(first)),
        secondChunks: second.length,
      };
    })()`,
    context
  ) as { stdout: string; byteBudgetOutput: string; secondChunks: number };
  const projectEvents = posted.filter((message) => message.type === 'project-event');
  const outputEvents = projectEvents.filter((message) => message.payload?.type === 'output');
  const fileChangeEvents = projectEvents.filter((message) => message.payload?.type === 'file-change');

  assertCondition(
    result.stdout.includes('output truncated after 1048576 bytes'),
    `C++ worker should cap returned stdout after project event truncation: ${JSON.stringify(result)}`
  );
  assertCondition(
    result.byteBudgetOutput.includes('stderr output truncated after 1048576 bytes') && result.secondChunks === 0,
    `C++ WASI byte budget should cap stored stderr chunks: ${JSON.stringify(result)}`
  );
  assertCondition(outputEvents.length === 1, `C++ worker should drop stdout chunks after truncation: ${JSON.stringify(projectEvents)}`);
  assertCondition(fileChangeEvents.length === 0, `C++ worker should drop oversized live file-change payloads: ${JSON.stringify(projectEvents)}`);
}

function testRuntimeFinalDiffBudgets(): void {
  let countError = '';
  try {
    assertRuntimeFinalDiffBudget(Array.from({ length: 4097 }, (_, index) => ({
      path: `generated/${index}.txt`,
      contents: 'x',
    })));
  } catch (error) {
    countError = error instanceof Error ? error.message : String(error);
  }

  let sizeError = '';
  try {
    assertRuntimeFinalDiffBudget([
      { path: 'huge.txt', contents: 'x'.repeat(16 * 1024 * 1024 + 1) },
    ]);
  } catch (error) {
    sizeError = error instanceof Error ? error.message : String(error);
  }

  let totalError = '';
  try {
    assertRuntimeFinalDiffBudget([
      { path: 'one.txt', contents: 'x'.repeat(11 * 1024 * 1024) },
      { path: 'two.txt', contents: 'x'.repeat(11 * 1024 * 1024) },
      { path: 'three.txt', contents: 'x'.repeat(11 * 1024 * 1024) },
    ]);
  } catch (error) {
    totalError = error instanceof Error ? error.message : String(error);
  }

  assertCondition(countError.includes('final-diff file-change count limit'), `final-diff count budget should reject large arrays: ${countError}`);
  assertCondition(sizeError.includes('final-diff file-change size limit'), `final-diff per-file budget should reject large files: ${sizeError}`);
  assertCondition(totalError.includes('final-diff byte limit'), `final-diff total budget should reject large aggregate payloads: ${totalError}`);
}

async function testTraceKernelProjectCommandStepsAreBounded(): Promise<void> {
  const message = await rejectedMessage(async () => {
    const workspace = await createRuntimeWorkspace({
      nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, timeoutMs: 1000 }),
      projectSession: {
        id: 'step-limit-session',
        projectSlug: 'step-limit',
        language: 'javascript',
        entrypoint: 'index.js',
        files: [{ path: 'index.js', contents: 'console.log("ok");\n' }],
        commands: {
          flood: {
            steps: Array.from({ length: 65 }, (_, index) => `printf "${index}\\n"`),
          },
        },
      },
    });
    workspace.dispose();
  });

  assertCondition(
    message.includes('must include at most 64 steps'),
    `TraceKernel project commands should reject oversized step lists: ${message}`
  );
}

async function testTraceKernelNpmIgnoreScriptsSkipsLifecycleHooks(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, timeoutMs: 1000 }),
    packageManager: true,
    files: [
      {
        path: 'package.json',
        contents: JSON.stringify({
          name: 'ignore-scripts-app',
          version: '1.0.0',
          scripts: {
            prebuild: 'node scripts/pre.js',
            build: 'node scripts/build.js',
            postbuild: 'node scripts/post.js',
          },
        }, null, 2),
      },
      { path: 'scripts/pre.js', contents: 'console.log("pre");\n' },
      { path: 'scripts/build.js', contents: 'console.log("build");\n' },
      { path: 'scripts/post.js', contents: 'console.log("post");\n' },
    ],
  });

  try {
    const normal = await workspace.runCommand('npm run build');
    assertCondition(
      normal.exitCode === 0 &&
        normal.stdout.includes('\npre\n') &&
        normal.stdout.includes('\nbuild\n') &&
        normal.stdout.includes('\npost\n'),
      `npm run should execute lifecycle hooks without --ignore-scripts: ${JSON.stringify(normal)}`
    );

    const ignored = await workspace.runCommand('npm run build --ignore-scripts');
    assertCondition(
      ignored.exitCode === 0 &&
        ignored.stdout.includes('\nbuild\n') &&
        !ignored.stdout.includes('\npre\n') &&
        !ignored.stdout.includes('\npost\n'),
      `npm run --ignore-scripts should skip lifecycle hooks while running the target script: ${JSON.stringify(ignored)}`
    );
  } finally {
    workspace.dispose();
  }
}

async function testTraceKernelDeviceOutputAccumulationIsBounded(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, timeoutMs: 1000 }),
    files: [
      {
        path: 'writer.js',
        contents: [
          'const fs = require("node:fs");',
          'fs.writeFileSync("/dev/stdout", "x".repeat(1024 * 1024 + 16));',
          'fs.writeFileSync("/dev/stdout", "after-truncation-sentinel");',
        ].join('\n'),
      },
    ],
  });

  try {
    const result = await workspace.runCommand('node writer.js');
    assertCondition(result.exitCode === 0, `device output cap command should complete: ${JSON.stringify(result)}`);
    assertCondition(
      result.stdout.includes('stdout output truncated after 1048576 bytes'),
      `TraceKernel should mark oversized device stdout as truncated: ${JSON.stringify({
        length: result.stdout.length,
        tail: result.stdout.slice(-120),
      })}`
    );
    assertCondition(
      !result.stdout.includes('after-truncation-sentinel'),
      'TraceKernel should drop device stdout chunks after the stream budget is exhausted'
    );
  } finally {
    workspace.dispose();
  }
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

async function testTraceKernelHttpRejectsMalformedInputs(): Promise<void> {
  const workspace = await createRuntimeWorkspace();
  const seenRequests: Array<{ path: string; visibleHeader?: string; rawHeader?: string }> = [];
  const listener = workspace.http.listen({ host: '127.0.0.1', port: 3652 }, (request) => {
    seenRequests.push({
      path: request.path,
      visibleHeader: request.headers?.['x-visible'],
      rawHeader: request.rawHeaders?.find(([name]) => name.toLowerCase() === 'x-visible')?.[1],
    });
    return { status: 200, body: 'ok\n' };
  });
  try {
    const invalidPort = await workspace.http.request({ url: 'http://localhost:0/' });
    assertCondition(invalidPort.status === 400, `invalid connect port should be a clean HTTP rejection: ${JSON.stringify(invalidPort)}`);

    let rejectedHost = false;
    try {
      workspace.http.listen({ host: 'bad\thost\nrow', port: 0 }, () => ({ status: 200, body: 'bad\n' }));
    } catch (error) {
      rejectedHost = (error as { code?: unknown }).code === 'EADDRNOTAVAIL';
    }
    assertCondition(rejectedHost, 'TraceKernel HTTP should reject listener hosts with control characters');

    const invalidMethod = await workspace.http.request({
      method: 'GET\tX\nROW',
      url: 'http://localhost:3652/path',
    });
    assertCondition(invalidMethod.status === 400, `invalid HTTP method should be rejected: ${JSON.stringify(invalidMethod)}`);
    const invalidPath = await workspace.http.request({
      url: 'http://localhost:3652/path',
      path: '/safe\r\nX-Smuggled: yes',
    });
    assertCondition(invalidPath.status === 400, `invalid HTTP path should be rejected: ${JSON.stringify(invalidPath)}`);
    const invalidRawHeader = await workspace.http.request({
      url: 'http://localhost:3652/path',
      rawHeaders: [['x-safe', 'ok'], ['x-bad', 'ok\r\nX-Smuggled: yes']],
    });
    assertCondition(invalidRawHeader.status === 400, `invalid raw HTTP header should be rejected: ${JSON.stringify(invalidRawHeader)}`);
    const canonicalRawHeader = await workspace.http.request({
      url: 'http://localhost:3652/path',
      headers: { 'x-visible': 'headers-map' },
      rawHeaders: [['x-visible', 'raw-pair']],
    });
    assertCondition(canonicalRawHeader.status === 200, `canonical raw HTTP header request should succeed: ${JSON.stringify(canonicalRawHeader)}`);
    assertCondition(
      seenRequests.some((request) =>
        request.path === '/path' &&
        request.visibleHeader === 'headers-map' &&
        request.rawHeader === 'headers-map'
      ),
      `HTTP header maps should be canonical over conflicting raw header pairs: ${JSON.stringify(seenRequests)}`
    );
    const requests = await workspace.readFile('/proc/tracekernel/net/requests');
    assertCondition(!requests.includes('GET\tX\nROW'), `request diagnostics should not contain injected control rows: ${requests}`);
    assertCondition(!requests.includes('X-Smuggled'), `request diagnostics should not contain smuggled header rows: ${requests}`);

  } finally {
    listener.close();
    workspace.dispose();
  }
}

async function testTraceKernelHttpRejectsInvalidResponseStatus(): Promise<void> {
  const workspace = await createRuntimeWorkspace();
  const listener = workspace.http.listen({ host: '127.0.0.1', port: 3653 }, () => ({ status: -1, body: 'bad\n' }));
  try {
    const response = await workspace.http.request({ url: 'http://localhost:3653/status' });
    assertCondition(response.status === 500, `invalid listener status should become a handler failure: ${JSON.stringify(response)}`);
    assertCondition(
      String(response.body ?? '').includes('invalid TraceKernel HTTP response status'),
      `invalid listener status should explain the rejection: ${JSON.stringify(response)}`
    );
  } finally {
    listener.close();
    workspace.dispose();
  }
}

async function testBrowserJavaScriptHttpAbortPropagatesToKernel(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, timeoutMs: 1000 }),
    files: [
      {
        path: 'fetch-abort.js',
        contents: [
          '(async () => {',
          '  const controller = new AbortController();',
          '  const promise = fetch("http://localhost:3654/slow", { signal: controller.signal });',
          '  controller.abort();',
          '  try { await promise; console.log("resolved"); }',
          '  catch (error) { console.log(error.name + ":" + (error.code || "")); }',
          '})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });',
          '',
        ].join('\n'),
      },
    ],
  });
  let signalSeen = false;
  let signalAborted = false;
  let sideEffectsAfterAbort = 0;
  const listener = workspace.http.listen({ host: '127.0.0.1', port: 3654 }, async (request) => {
    signalSeen = Boolean(request.signal);
    request.signal?.addEventListener('abort', () => {
      signalAborted = true;
    }, { once: true });
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (request.signal?.aborted) signalAborted = true;
    if (!request.signal?.aborted) sideEffectsAfterAbort += 1;
    return { status: 200, body: 'late\n' };
  });
  try {
    const result = await workspace.runCommand('node fetch-abort.js');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertCondition(result.exitCode === 0, `fetch abort client should finish: ${JSON.stringify(result)}`);
    assertCondition(result.stdout === 'AbortError:ABORT_ERR\n', `fetch abort should reject locally: ${result.stdout}`);
    assertCondition(signalSeen, 'TraceKernel HTTP handler should receive a signal for JS fetch');
    assertCondition(signalAborted, 'JS fetch abort should abort the TraceKernel handler signal');
    assertCondition(sideEffectsAfterAbort === 0, 'JS fetch abort should let cooperative handlers suppress late side effects');
  } finally {
    listener.close();
    workspace.dispose();
  }
}

async function testBrowserJavaScriptHttpTimeoutPropagatesToKernel(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, timeoutMs: 1000 }),
    files: [
      {
        path: 'http-timeout.js',
        contents: [
          'const http = require("node:http");',
          'const req = http.request({ hostname: "localhost", port: 3655, path: "/slow" }, (res) => console.log("resolved:" + res.statusCode));',
          'req.setTimeout(1, () => console.log("timeout"));',
          'req.on("error", (error) => console.log(error.code || error.name));',
          'req.end();',
          '',
        ].join('\n'),
      },
    ],
  });
  let signalAborted = false;
  let sideEffectsAfterTimeout = 0;
  const listener = workspace.http.listen({ host: '127.0.0.1', port: 3655 }, async (request) => {
    request.signal?.addEventListener('abort', () => {
      signalAborted = true;
    }, { once: true });
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (request.signal?.aborted) signalAborted = true;
    if (!request.signal?.aborted) sideEffectsAfterTimeout += 1;
    return { status: 200, body: 'late\n' };
  });
  try {
    const result = await workspace.runCommand('node http-timeout.js');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertCondition(result.exitCode === 0, `node:http timeout client should finish: ${JSON.stringify(result)}`);
    assertCondition(result.stdout === 'timeout\nETIMEDOUT\n', `node:http timeout should still look local to the client: ${result.stdout}`);
    assertCondition(signalAborted, 'node:http timeout should abort the TraceKernel handler signal');
    assertCondition(sideEffectsAfterTimeout === 0, 'node:http timeout should let cooperative handlers suppress late side effects');
  } finally {
    listener.close();
    workspace.dispose();
  }
}

async function testBrowserJavaScriptHttpDestroyCompletesActiveRequest(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, timeoutMs: 1000 }),
    files: [
      {
        path: 'http-destroy.js',
        contents: [
          'const http = require("node:http");',
          'const req = http.get("http://localhost:3657/slow", (res) => console.log("resolved:" + res.statusCode));',
          'req.on("close", () => console.log("closed:" + req.destroyed));',
          'req.on("error", (error) => console.log("error:" + (error.code || error.name)));',
          'req.destroy();',
          '',
        ].join('\n'),
      },
    ],
  });
  let signalAborted = false;
  let sideEffectsAfterDestroy = 0;
  const listener = workspace.http.listen({ host: '127.0.0.1', port: 3657 }, async (request) => {
    request.signal?.addEventListener('abort', () => {
      signalAborted = true;
    }, { once: true });
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (request.signal?.aborted) signalAborted = true;
    if (!request.signal?.aborted) sideEffectsAfterDestroy += 1;
    return { status: 200, body: 'late\n' };
  });
  try {
    const result = await workspace.runCommand('node http-destroy.js');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertCondition(result.exitCode === 0, `destroyed node:http request should finish: ${JSON.stringify(result)}`);
    assertCondition(result.stdout === 'closed:true\n', `destroyed node:http request should emit close and not hang: ${result.stdout}`);
    assertCondition(signalAborted, 'node:http destroy should abort the TraceKernel handler signal');
    assertCondition(sideEffectsAfterDestroy === 0, 'node:http destroy should let cooperative handlers suppress late side effects');
  } finally {
    listener.close();
    workspace.dispose();
  }
}

async function testBrowserJavaScriptGlobalFetchUsesTraceKernel(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, timeoutMs: 1000 }),
    files: [
      {
        path: 'global-fetch.js',
        contents: [
          '(async () => {',
          '  try { globalThis.fetch = async () => ({ status: 299, text: async () => "ambient" }); console.log("assign:ok"); }',
          '  catch (error) { console.log("assign:" + error.name); }',
          '  const globalResponse = await globalThis.fetch("http://localhost:3656/global");',
          '  console.log("global:" + globalResponse.status + ":" + await globalResponse.text());',
          '  const injectedResponse = await fetch("http://localhost:3656/injected");',
          '  console.log("injected:" + injectedResponse.status + ":" + await injectedResponse.text());',
          '})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });',
          '',
        ].join('\n'),
      },
    ],
  });
  let hits = 0;
  const listener = workspace.http.listen({ host: '127.0.0.1', port: 3656 }, (request) => {
    hits += 1;
    return { status: 207, body: `${request.path}\n` };
  });
  try {
    const result = await workspace.runCommand('node global-fetch.js');
    assertCondition(result.exitCode === 0, `global fetch lockdown test should finish: ${JSON.stringify(result)}`);
    assertCondition(
      result.stdout === 'assign:ok\nglobal:207:/global\n\ninjected:207:/injected\n\n',
      `globalThis.fetch should remain routed through TraceKernel: ${result.stdout}`
    );
    assertCondition(hits === 2, `TraceKernel listener should receive both global and injected fetches: ${hits}`);
  } finally {
    listener.close();
    workspace.dispose();
  }
}

async function main(): Promise<void> {
  await testBrowserJavaScriptHardenedModeRequiresWorker();
  await testBrowserJavaScriptWorkerRejectsUserSpoofedResults();
  await testBrowserJavaScriptReadonlyHardlinksAreRejected();
  await testBrowserJavaScriptHiddenFilesAreNotMounted();
  await testBrowserJavaScriptHiddenNamespaceMutationMatrix();
  await testJavaScriptTraceSerializationIsBounded();
  await testJavaScriptInputMaterializerAvoidsTypeNameEval();
  await testJavaScriptDestructuredIterableTracingDoesNotExhaustValues();
  await testNativeProjectRunnersRejectVirtualPathTraversal();
  await testCSharpWorkerRejectsKernelAndWorkspaceTraversal();
  await testCSharpWorkerProjectEventBudgets();
  await testJavaWorkerProjectEventBudgets();
  testJavaHelperRunScopeAndCacheManifest();
  await testJavaWorkerDiagnosticsAreBounded();
  testJavaTraceHeaderExpansionIsBounded();
  await testCppWorkerProjectEventBudgets();
  testRuntimeFinalDiffBudgets();
  await testTraceKernelProjectCommandStepsAreBounded();
  await testTraceKernelNpmIgnoreScriptsSkipsLifecycleHooks();
  await testTraceKernelDeviceOutputAccumulationIsBounded();
  await testTraceKernelHttpTimeoutSignalsCooperativeHandlers();
  await testTraceKernelHttpDiagnosticsAreRedacted();
  await testTraceKernelHttpListenerLimit();
  await testTraceKernelHttpRejectsMalformedInputs();
  await testTraceKernelHttpRejectsInvalidResponseStatus();
  await testBrowserJavaScriptHttpAbortPropagatesToKernel();
  await testBrowserJavaScriptHttpTimeoutPropagatesToKernel();
  await testBrowserJavaScriptHttpDestroyCompletesActiveRequest();
  await testBrowserJavaScriptGlobalFetchUsesTraceKernel();
  console.log('tracekernel hardening tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

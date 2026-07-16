#!/usr/bin/env npx tsx

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { access, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { javaTraceHooksEventsToRuntimeTrace } from '../packages/harness-core/src/trace-adapters/java';
import {
  RUNTIME_WORKSPACE_DEFAULT_MAX_BYTES,
  RUNTIME_WORKSPACE_DEFAULT_MAX_ENTRY_COUNT,
  RUNTIME_WORKSPACE_DEFAULT_MAX_FILE_BYTES,
  createRuntimeWorkspace,
  normalizeRuntimeWorkspaceStorageLimits,
} from '../packages/harness-project/src/index';
import { assertRuntimeFinalDiffBudget, type RuntimeCommandEvent } from '../packages/harness-core/src/runtime-project';
import { createIndexedDbKernelStorage } from '../packages/harness-browser/src/project';
import {
  createBrowserJavaScriptProjectRunner,
  createBrowserTypeScriptProjectRunner,
} from '../packages/harness-javascript/src/project-browser';
import { executeTypeScriptCode } from '../packages/harness-javascript/src/javascript-executor';
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

function csharpWorkerVmSource(source: string): string {
  const startupStart = 'const sharedKernelPolicyReady = loadSharedKernelPolicy().then(() => {';
  const startupEnd = '\n});\n\nfunction now()';
  const startIndex = source.indexOf(startupStart);
  const endIndex = source.indexOf(startupEnd, startIndex);
  assertCondition(startIndex >= 0 && endIndex >= 0, 'C# worker VM source should locate shared policy startup loading');
  const stubbedStartup = [
    "Object.defineProperty(self, 'TraceRuntimeKernelPolicy', {",
    '  value: Object.freeze({ withRuntimeUserAuthorityLockdown: async (callback) => callback() }),',
    '  configurable: false,',
    '  enumerable: false,',
    '  writable: false,',
    '});',
    'trustedRuntimeUserAuthorityLockdown = self.TraceRuntimeKernelPolicy.withRuntimeUserAuthorityLockdown;',
    'const sharedKernelPolicyReady = Promise.resolve();',
  ].join('\n');
  return source.slice(0, startIndex) + stubbedStartup + source.slice(endIndex + '\n});'.length);
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

function setTestGlobalProperty(name: string, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete (globalThis as unknown as Record<string, unknown>)[name];
    }
  };
}

async function testConcurrentCommandsKeepChainLocalContext(): Promise<void> {
  let releaseCommands!: () => void;
  const commandsReleased = new Promise<void>((resolve) => {
    releaseCommands = resolve;
  });
  let bothStarted!: () => void;
  const bothStartedPromise = new Promise<void>((resolve) => {
    bothStarted = resolve;
  });
  const started = new Set<string>();

  const workspace = await createRuntimeWorkspace({
    kernel: { scheduler: { maxConcurrentCommands: 2 } },
    files: [
      { path: 'a.js', contents: 'a\n' },
      { path: 'b.js', contents: 'b\n' },
      { path: 'a.out', contents: 'old-a\n' },
      { path: 'b.out', contents: 'old-b\n' },
    ],
    nodeRunner: async (request) => {
      const label = request.scriptPath.endsWith('a.js') ? 'a' : 'b';
      started.add(label);
      request.onEvent?.({ type: 'output', stream: 'stdout', data: `${label}:live\n` });
      if (started.size === 2) bothStarted();
      await commandsReleased;
      return {
        stdout: `${label}:done\n`,
        stderr: '',
        exitCode: 0,
        files: [{ path: `${label}.out`, contents: `${label}\n` }],
      };
    },
  });

  const fileChangeActors = new Map<string, string>();
  const unsubscribe = workspace.watch((event) => {
    if (event.type === 'file-change') {
      fileChangeActors.set(event.change.path, event.actor?.id ?? '');
    }
  });
  try {
    const commandOutput: Record<string, string[]> = { a: [], b: [] };
    const a = workspace.runCommand('node a.js', {
      onEvent: (event) => {
        if (event.type === 'output') commandOutput.a.push(event.data);
      },
    });
    const b = workspace.runCommand('node b.js', {
      onEvent: (event) => {
        if (event.type === 'output') commandOutput.b.push(event.data);
      },
    });
    await bothStartedPromise;
    releaseCommands();
    const [aResult, bResult] = await Promise.all([a, b]);

    assertCondition(aResult.stdout === 'a:done\n', `first command stdout should stay local: ${JSON.stringify(aResult)}`);
    assertCondition(bResult.stdout === 'b:done\n', `second command stdout should stay local: ${JSON.stringify(bResult)}`);
    assertCondition(commandOutput.a.join('') === 'a:live\n', `first command events should stay local: ${JSON.stringify(commandOutput)}`);
    assertCondition(commandOutput.b.join('') === 'b:live\n', `second command events should stay local: ${JSON.stringify(commandOutput)}`);
    assertCondition(await workspace.readFile('a.out') === 'a\n', 'first command file should be written');
    assertCondition(await workspace.readFile('b.out') === 'b\n', 'second command file should be written');
    const aActor = fileChangeActors.get('a.out');
    const bActor = fileChangeActors.get('b.out');
    assertCondition(Boolean(aActor) && Boolean(bActor) && aActor !== bActor, `file changes should keep distinct actors: ${JSON.stringify([...fileChangeActors])}`);
  } finally {
    unsubscribe();
    workspace.dispose();
  }
}

async function testBackgroundJobDoesNotBlockForegroundCommands(): Promise<void> {
  let releaseBackground!: () => void;
  const backgroundReleased = new Promise<void>((resolve) => {
    releaseBackground = resolve;
  });
  let backgroundStarted!: () => void;
  const backgroundStartedPromise = new Promise<void>((resolve) => {
    backgroundStarted = resolve;
  });
  let backgroundComplete = false;

  const workspace = await createRuntimeWorkspace({
    kernel: { scheduler: { maxConcurrentCommands: 2 } },
    files: [{ path: 'bg.js', contents: 'bg\n' }],
    nodeRunner: async () => {
      backgroundStarted();
      await backgroundReleased;
      await new Promise((resolve) => setTimeout(resolve, 200));
      backgroundComplete = true;
      return { stdout: 'bg done\n', stderr: '', exitCode: 0 };
    },
  });
  const session = workspace.createTerminalSession();
  try {
    const backgroundSubmission = await session.run('node bg.js &');
    const backgroundPid = Number(backgroundSubmission.stdout.match(/\[\d+\] ([0-9]+)/)?.[1]);
    assertCondition(Number.isInteger(backgroundPid) && backgroundPid > 1, `background submission should report a pid: ${JSON.stringify(backgroundSubmission)}`);
    await backgroundStartedPromise;
    const foreground = await session.run('echo hi');
    assertCondition(foreground.exitCode === 0 && foreground.stdout === 'hi\n', `foreground command should complete while background is running: ${JSON.stringify(foreground)}`);
    assertCondition(!backgroundComplete, 'background job should still be running before latch release');
    releaseBackground();
    const wait = await session.run(`wait ${backgroundPid}`);
    assertCondition(wait.exitCode === 0 && wait.stdout.includes(`pid\t${backgroundPid}\n`), `background job should be waitable after release: ${JSON.stringify(wait)}`);
    assertCondition(backgroundComplete, 'background runner should complete after latch release');
  } finally {
    workspace.dispose();
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

async function testBrowserJavaScriptMainThreadExecutionRequiresTrustedOptIn(): Promise<void> {
  const previousWorker = (globalThis as typeof globalThis & { Worker?: unknown }).Worker;
  delete (globalThis as typeof globalThis & { Worker?: unknown }).Worker;
  const request = {
    code: 'console.log("trusted-main-thread");',
    source: 'inline' as const,
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      workspaceRoot: '/workspace',
      files: [],
    },
  };
  try {
    const defaultResult = await createBrowserJavaScriptProjectRunner({ timeoutMs: 1000 })(request);
    assertCondition(defaultResult.exitCode === 126, `browser JS without Worker should fail closed: ${JSON.stringify(defaultResult)}`);
    assertCondition(defaultResult.stdout === '', `browser JS default fallback should not execute same-realm code: ${JSON.stringify(defaultResult)}`);
    assertCondition(
      defaultResult.stderr === 'node: JavaScript runtime is unavailable\n' &&
        defaultResult.error?.detail?.diagnostic === 'JavaScript Worker execution is unavailable and trusted main-thread execution was not enabled',
      `browser JS default fallback should keep configuration detail out of terminal stderr: ${JSON.stringify(defaultResult)}`
    );

    const allowOnlyResult = await createBrowserJavaScriptProjectRunner({
      allowMainThreadExecution: true,
      timeoutMs: 1000,
    })(request);
    assertCondition(allowOnlyResult.exitCode === 126, `allowMainThreadExecution alone should fail closed: ${JSON.stringify(allowOnlyResult)}`);
    assertCondition(allowOnlyResult.stdout === '', `allowMainThreadExecution alone should not execute same-realm code: ${JSON.stringify(allowOnlyResult)}`);
    assertCondition(
      allowOnlyResult.stderr === 'node: JavaScript runtime is unavailable\n' &&
        allowOnlyResult.error?.detail?.diagnostic === 'JavaScript Worker execution is unavailable and trusted main-thread execution was not enabled',
      `allowMainThreadExecution alone should keep configuration detail out of terminal stderr: ${JSON.stringify(allowOnlyResult)}`
    );

    const hardenedResult = await createBrowserJavaScriptProjectRunner({
      allowMainThreadExecution: true,
      trustedMainThreadExecution: true,
      hardened: true,
      timeoutMs: 1000,
    })(request);
    assertCondition(hardenedResult.exitCode === 126, `hardened browser JS should still require a Worker: ${JSON.stringify(hardenedResult)}`);
    assertCondition(hardenedResult.stdout === '', `hardened browser JS should not execute same-realm code: ${JSON.stringify(hardenedResult)}`);
    assertCondition(
      hardenedResult.stderr === 'node: JavaScript runtime is unavailable\n' &&
        hardenedResult.error?.detail?.diagnostic === 'JavaScript Worker execution is unavailable and trusted main-thread execution was not enabled',
      `hardened browser JS should keep configuration detail out of terminal stderr: ${JSON.stringify(hardenedResult)}`
    );

    const trustedResult = await createBrowserJavaScriptProjectRunner({
      allowMainThreadExecution: true,
      trustedMainThreadExecution: true,
      timeoutMs: 1000,
    })(request);
    assertCondition(
      trustedResult.exitCode === 0 && trustedResult.stdout === 'trusted-main-thread\n',
      `explicitly trusted main-thread browser JS should still work for same-realm tests: ${JSON.stringify(trustedResult)}`
    );
  } finally {
    if (previousWorker === undefined) {
      delete (globalThis as typeof globalThis & { Worker?: unknown }).Worker;
    } else {
      (globalThis as typeof globalThis & { Worker?: unknown }).Worker = previousWorker;
    }
  }
}

async function testBrowserTypeScriptDomCompilerScriptPolicy(): Promise<void> {
  const appendedScripts: Array<{
    src: string;
    async: boolean;
    onload: (() => void) | null;
    onerror: (() => void) | null;
  }> = [];
  const testDocument = {
    baseURI: 'https://tracecode.example/app/index.html',
    createElement(tagName: string) {
      assertCondition(tagName === 'script', `TypeScript compiler loader should only create script elements: ${tagName}`);
      return {
        src: '',
        async: false,
        onload: null,
        onerror: null,
      };
    },
    head: {
      appendChild(script: (typeof appendedScripts)[number]) {
        appendedScripts.push(script);
        script.onerror?.();
        return script;
      },
    },
  };
  const restoreDocument = setTestGlobalProperty('document', testDocument);
  const restoreLocation = setTestGlobalProperty('location', { href: 'https://tracecode.example/app/index.html' });
  const restoreTs = setTestGlobalProperty('ts', undefined);
  const request = () => ({
    code: '',
    source: 'file' as const,
    scriptPath: 'index.ts',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      workspaceRoot: '/workspace',
      files: [],
    },
  });

  try {
    const defaultMessage = await rejectedMessage(() => createBrowserTypeScriptProjectRunner({
      compilerUrl: '/workers/vendor/typescript.js',
    })(request()));
    assertCondition(
      defaultMessage.includes('requires a trusted compiler object or a worker-backed compiler'),
      `DOM TypeScript compiler script loading should remain disabled by default: ${defaultMessage}`
    );
    assertCondition(appendedScripts.length === 0, 'Disabled DOM TypeScript compiler loading should not append scripts');

    const remoteMessage = await rejectedMessage(() => createBrowserTypeScriptProjectRunner({
      allowDomCompilerScript: true,
      compilerUrl: 'https://cdn.example.com/typescript.js',
    })(request()));
    assertCondition(
      remoteMessage.includes('External TypeScript compiler DOM script URLs require allowExternalDomCompilerScript'),
      `Remote DOM TypeScript compiler scripts should require a second explicit opt-in: ${remoteMessage}`
    );
    assertCondition(appendedScripts.length === 0, 'Rejected remote TypeScript compiler URLs should not append scripts');

    const dataUrlMessage = await rejectedMessage(() => createBrowserTypeScriptProjectRunner({
      allowDomCompilerScript: true,
      allowExternalDomCompilerScript: true,
      compilerUrl: 'data:text/javascript,globalThis.ts={}',
    })(request()));
    assertCondition(
      dataUrlMessage.includes('must use http, https, or file'),
      `DOM TypeScript compiler script URLs should reject inline schemes: ${dataUrlMessage}`
    );
    assertCondition(appendedScripts.length === 0, 'Rejected inline TypeScript compiler URLs should not append scripts');

    testDocument.baseURI = 'file:///Users/example/app/index.html';
    const externalFileMessage = await rejectedMessage(() => createBrowserTypeScriptProjectRunner({
      allowDomCompilerScript: true,
      compilerUrl: 'file:///Users/example/typescript.js',
    })(request()));
    assertCondition(
      externalFileMessage.includes('External TypeScript compiler DOM script URLs require allowExternalDomCompilerScript'),
      `File TypeScript compiler scripts outside the document base should require explicit trust: ${externalFileMessage}`
    );
    assertCondition(appendedScripts.length === 0, 'Rejected external file TypeScript compiler URLs should not append scripts');
    testDocument.baseURI = 'https://tracecode.example/app/index.html';

    const sameOriginMessage = await rejectedMessage(() => createBrowserTypeScriptProjectRunner({
      allowDomCompilerScript: true,
      compilerUrl: '/workers/vendor/typescript.js',
    })(request()));
    assertCondition(
      sameOriginMessage.includes('Failed to load TypeScript compiler from https://tracecode.example/workers/vendor/typescript.js'),
      `Same-origin TypeScript compiler script should be allowed through to the DOM loader: ${sameOriginMessage}`
    );
    assertCondition(
      appendedScripts.length === 1 &&
        appendedScripts[0]?.src === 'https://tracecode.example/workers/vendor/typescript.js' &&
        appendedScripts[0]?.async === true,
      `Same-origin TypeScript compiler script should be normalized and appended: ${JSON.stringify(appendedScripts)}`
    );

    const trustedRemoteMessage = await rejectedMessage(() => createBrowserTypeScriptProjectRunner({
      allowDomCompilerScript: true,
      allowExternalDomCompilerScript: true,
      compilerUrl: 'https://cdn.example.com/typescript.js',
    })(request()));
    assertCondition(
      trustedRemoteMessage.includes('Failed to load TypeScript compiler from https://cdn.example.com/typescript.js'),
      `Explicitly trusted remote TypeScript compiler script should be allowed through to the DOM loader: ${trustedRemoteMessage}`
    );
    assertCondition(
      appendedScripts.length === 2 &&
        appendedScripts[1]?.src === 'https://cdn.example.com/typescript.js' &&
        appendedScripts[1]?.async === true,
      `Trusted remote TypeScript compiler script should be normalized and appended: ${JSON.stringify(appendedScripts)}`
    );
  } finally {
    restoreTs();
    restoreLocation();
    restoreDocument();
  }
}

async function testIndexedDbKernelStorageEncryptsSnapshots(): Promise<void> {
  const stores = new Map<string, Map<string, unknown>>();
  const requestAsync = <Result>(result: Result): IDBRequest<Result> => {
    const request = { result, error: null } as IDBRequest<Result>;
    queueMicrotask(() => request.onsuccess?.({} as Event));
    return request;
  };
  const fakeDb = {
    objectStoreNames: {
      contains(name: string) {
        return stores.has(name);
      },
    },
    createObjectStore(name: string) {
      const store = new Map<string, unknown>();
      stores.set(name, store);
      return store;
    },
    transaction(storeName: string) {
      const store = stores.get(storeName);
      if (!store) throw new Error(`Missing fake IndexedDB object store: ${storeName}`);
      return {
        objectStore() {
          return {
            get(key: string) {
              return requestAsync(store.get(key));
            },
            put(value: unknown, key: string) {
              store.set(key, value);
              return requestAsync(undefined);
            },
            delete(key: string) {
              store.delete(key);
              return requestAsync(undefined);
            },
          };
        },
      };
    },
  };
  const fakeIndexedDb = {
    open() {
      const request = { result: fakeDb, error: null } as IDBOpenDBRequest;
      queueMicrotask(() => {
        request.onupgradeneeded?.({} as IDBVersionChangeEvent);
        request.onsuccess?.({} as Event);
      });
      return request;
    },
  };
  const restoreIndexedDb = setTestGlobalProperty('indexedDB', fakeIndexedDb);
  try {
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    const storage = createIndexedDbKernelStorage({
      key: 'workspace',
      databaseName: 'tracecode-secure-workspace',
      storeName: 'workspaces',
      trustedSameOriginPersistence: true,
      encryptionKey,
      keyId: 'test-key',
    });
    await storage.save({
      files: [{ path: 'secret.txt', contents: 'do-not-store-plaintext\n' }],
      entrypoint: 'secret.txt',
    });

    const rawRecord = stores.get('workspaces')?.get('workspace') as
      | { version?: number; revision?: number; savedAt?: string; encrypted?: { ciphertext?: string; iv?: string; keyId?: string } }
      | undefined;
    assertCondition(
      rawRecord?.version === 3 &&
        rawRecord.revision === 1 &&
        typeof rawRecord.encrypted?.ciphertext === 'string' &&
        typeof rawRecord.encrypted.iv === 'string' &&
        rawRecord.encrypted.keyId === 'test-key',
      `IndexedDB kernel storage should persist an encrypted record: ${JSON.stringify(rawRecord)}`
    );
    assertCondition(
      !JSON.stringify(rawRecord).includes('do-not-store-plaintext'),
      `IndexedDB kernel storage should not persist plaintext workspace contents: ${JSON.stringify(rawRecord)}`
    );

    const loaded = await storage.load();
    assertCondition(
      loaded?.snapshot.files[0]?.path === 'secret.txt' &&
        loaded.snapshot.files[0]?.contents === 'do-not-store-plaintext\n' &&
        loaded.snapshot.entrypoint === 'secret.txt',
      `IndexedDB kernel storage should decrypt snapshots through the storage API: ${JSON.stringify(loaded)}`
    );

    stores.get('workspaces')?.set('other-workspace', JSON.parse(JSON.stringify(rawRecord)));
    const otherStorage = createIndexedDbKernelStorage({
      key: 'other-workspace',
      databaseName: 'tracecode-secure-workspace',
      storeName: 'workspaces',
      trustedSameOriginPersistence: true,
      encryptionKey,
      keyId: 'test-key',
    });
    const namespaceSwapError = await rejectedMessage(() => otherStorage.load());
    assertCondition(
      namespaceSwapError.includes('Failed to decrypt'),
      `encrypted records must be authenticated to their database/store/key namespace: ${namespaceSwapError}`
    );

    const wrongKeyIdStorage = createIndexedDbKernelStorage({
      key: 'workspace',
      databaseName: 'tracecode-secure-workspace',
      storeName: 'workspaces',
      trustedSameOriginPersistence: true,
      encryptionKey,
      keyId: 'wrong-key',
    });
    const keyIdError = await rejectedMessage(() => wrongKeyIdStorage.load());
    assertCondition(
      keyIdError.includes('keyId does not match'),
      `encrypted records must validate the configured keyId before decryption: ${keyIdError}`
    );

    let currentRevision = 0;
    const replayStorage = createIndexedDbKernelStorage({
      key: 'replay-workspace',
      databaseName: 'tracecode-secure-workspace',
      storeName: 'workspaces',
      trustedSameOriginPersistence: true,
      encryptionKey,
      keyId: 'test-key',
      revisionAuthority: {
        trustedExternalState: true,
        nextRevision() {
          currentRevision += 1;
          return currentRevision;
        },
        assertCurrentRevision(revision) {
          if (revision !== currentRevision) throw new Error(`stale revision ${revision}; current is ${currentRevision}`);
        },
      },
    });
    await replayStorage.save({ files: [{ path: 'one.txt', contents: 'one\n' }] });
    const replayedRecord = JSON.parse(JSON.stringify(stores.get('workspaces')?.get('replay-workspace')));
    await replayStorage.save({ files: [{ path: 'two.txt', contents: 'two\n' }] });
    stores.get('workspaces')?.set('replay-workspace', replayedRecord);
    const replayError = await rejectedMessage(() => replayStorage.load());
    assertCondition(
      replayError.includes('stale revision 1; current is 2'),
      `external revision authority should reject replayed encrypted records: ${replayError}`
    );

    let clearRevision = 0;
    const clearStorage = createIndexedDbKernelStorage({
      key: 'clear-workspace',
      databaseName: 'tracecode-secure-workspace',
      storeName: 'workspaces',
      trustedSameOriginPersistence: true,
      encryptionKey,
      keyId: 'test-key',
      revisionAuthority: {
        trustedExternalState: true,
        nextRevision() {
          clearRevision += 1;
          return clearRevision;
        },
        assertCurrentRevision(revision) {
          if (revision !== clearRevision) throw new Error(`stale cleared revision ${revision}; current is ${clearRevision}`);
        },
      },
    });
    await clearStorage.save({ files: [{ path: 'cleared.txt', contents: 'restore-me\n' }] });
    const clearedRecord = JSON.parse(JSON.stringify(stores.get('workspaces')?.get('clear-workspace')));
    await clearStorage.clear?.();
    stores.get('workspaces')?.set('clear-workspace', clearedRecord);
    const clearReplayError = await rejectedMessage(() => clearStorage.load());
    assertCondition(
      clearReplayError.includes('stale cleared revision 1; current is 2'),
      `clearing encrypted storage must advance external replay authority: ${clearReplayError}`
    );
  } finally {
    restoreIndexedDb();
  }
}

async function testBrowserJavaScriptWorkerRejectsUserSpoofedResults(): Promise<void> {
  await withProtocolTestWorker(async (workerUrl) => {
    // This same-realm protocol double cannot safely emulate the non-restoring
    // descriptor seals of a disposable WorkerGlobalScope. Real Chromium
    // permanent-mode coverage lives in test-javascript-authority-browser.ts;
    // this test isolates protocol spoofing under the explicit trusted-reuse path.
    const runner = createBrowserJavaScriptProjectRunner({
      workerUrl,
      workerIsolation: 'shared',
      trustedReusableWorker: true,
      timeoutMs: 1000,
    });
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

async function testBrowserJavaScriptSharedWorkerRequiresTrustedOptIn(): Promise<void> {
  await withProtocolTestWorker(async (workerUrl) => {
    const runner = createBrowserJavaScriptProjectRunner({
      workerUrl,
      workerIsolation: 'shared',
      timeoutMs: 1000,
    });
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

    assertCondition(result.exitCode === 126, `untrusted shared browser JS worker should fail closed: ${JSON.stringify(result)}`);
    assertCondition(result.stdout === '', `untrusted shared browser JS worker should not execute project code: ${JSON.stringify(result)}`);
    assertCondition(
      result.stderr === 'node: JavaScript runtime is unavailable\n' &&
        result.error?.detail?.diagnostic === 'Shared JavaScript worker isolation requires trustedReusableWorker',
      `shared browser JS workers should keep configuration detail out of terminal stderr: ${JSON.stringify(result)}`
    );

    const invalidIsolationRunner = createBrowserJavaScriptProjectRunner({
      workerUrl,
      workerIsolation: 'shared ' as 'shared',
      timeoutMs: 1000,
    });
    const invalidIsolationResult = await invalidIsolationRunner({
      code: 'console.log("should-not-run-invalid-isolation");',
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

    assertCondition(
      invalidIsolationResult.exitCode === 126,
      `invalid browser JS worker isolation should fail closed: ${JSON.stringify(invalidIsolationResult)}`
    );
    assertCondition(
      invalidIsolationResult.stdout === '',
      `invalid browser JS worker isolation should not execute project code: ${JSON.stringify(invalidIsolationResult)}`
    );
    assertCondition(
      invalidIsolationResult.stderr === 'node: JavaScript runtime is unavailable\n' &&
        invalidIsolationResult.error?.detail?.diagnostic === 'Invalid JavaScript worker isolation: shared ',
      `invalid browser JS worker isolation should keep configuration detail out of terminal stderr: ${JSON.stringify(invalidIsolationResult)}`
    );
  });
}

async function testBrowserJavaScriptReadonlyHardlinksAreRejected(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true, timeoutMs: 1000 }),
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
	      '.trace/fixtures/secret.txt:ENOENT',
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

async function testCommandFilesystemRespectsHiddenProjectFiles(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    projectSession: {
      id: 'command-hidden-files',
      files: [
        { path: 'visible.txt', contents: 'visible\n' },
        { path: '.trace/fixtures/secret.txt', contents: 'hidden-input\n', hidden: true, readonly: true },
      ],
    },
  });

  try {
    const read = await workspace.runCommand('cat .trace/fixtures/secret.txt');
    const exists = await workspace.runCommand('test -e .trace/fixtures/secret.txt');
    const stat = await workspace.runCommand('stat .trace/fixtures/secret.txt');
    const list = await workspace.runCommand('ls -a .trace/fixtures');
    const find = await workspace.runCommand('find .');
    const copy = await workspace.runCommand('cp .trace/fixtures/secret.txt copied-secret.txt');
    const link = await workspace.runCommand('ln .trace/fixtures/secret.txt linked-secret.txt');
    assertCondition(
      read.exitCode !== 0 && !read.stdout.includes('hidden-input') && !read.stderr.includes('hidden-input'),
      `ordinary commands must not read hidden project files: ${JSON.stringify(read)}`
    );
    assertCondition(exists.exitCode !== 0, `ordinary command exists checks must not see hidden project files: ${JSON.stringify(exists)}`);
    assertCondition(
      stat.exitCode !== 0 && !stat.stdout.includes('secret.txt'),
      `ordinary command stat calls must not see hidden project files: ${JSON.stringify(stat)}`
    );
    assertCondition(
      list.exitCode !== 0 && !list.stdout.includes('secret.txt'),
      `ordinary command directory reads must not see hidden project files: ${JSON.stringify(list)}`
    );
    assertCondition(
      !find.stdout.includes('secret.txt') && !find.stdout.includes('.trace'),
      `ordinary command directory traversal must filter hidden project paths: ${JSON.stringify(find)}`
    );
    assertCondition(
      copy.exitCode !== 0 && !(await workspace.exists('copied-secret.txt')),
      `ordinary commands must not copy hidden project files into visible paths: ${JSON.stringify(copy)}`
    );
    assertCondition(
      link.exitCode !== 0 && !(await workspace.exists('linked-secret.txt')),
      `ordinary commands must not hardlink hidden project files into visible paths: ${JSON.stringify(link)}`
    );

    const authorizedRead = await workspace.runCommand('cat .trace/fixtures/secret.txt', { includeHiddenFiles: true });
    const authorizedStat = await workspace.runCommand('stat .trace/fixtures/secret.txt', { includeHiddenFiles: true });
    const authorizedList = await workspace.runCommand('ls -a .trace/fixtures', { includeHiddenFiles: true });
    const authorizedFind = await workspace.runCommand('find .', { includeHiddenFiles: true });
    assertCondition(
      authorizedRead.exitCode === 0 && authorizedRead.stdout === 'hidden-input\n',
      `explicit hidden-file commands should preserve authorized reads: ${JSON.stringify(authorizedRead)}`
    );
    assertCondition(
      authorizedStat.exitCode === 0 && authorizedStat.stdout.includes('.trace/fixtures/secret.txt'),
      `explicit hidden-file commands should preserve authorized stat calls: ${JSON.stringify(authorizedStat)}`
    );
    assertCondition(
      authorizedList.exitCode === 0 && authorizedList.stdout.includes('secret.txt'),
      `explicit hidden-file commands should preserve authorized directory reads: ${JSON.stringify(authorizedList)}`
    );
    assertCondition(
      authorizedFind.exitCode === 0 && authorizedFind.stdout.includes('.trace/fixtures/secret.txt'),
      `explicit hidden-file commands should preserve authorized directory traversal: ${JSON.stringify(authorizedFind)}`
    );

    const publicMkdirError = await rejectedMessage(() => workspace.mkdir('.trace/fixtures/public-created'));
    const commandMkdir = await workspace.runCommand('mkdir -p .trace/fixtures/command-created');
    assertCondition(
      publicMkdirError.includes('EROFS') && !(await workspace.exists('.trace/fixtures/public-created')),
      `public mkdir must reject hidden readonly subtrees: ${publicMkdirError}`
    );
    assertCondition(
      commandMkdir.exitCode !== 0 && !(await workspace.exists('.trace/fixtures/command-created')),
      `command mkdir must reject hidden readonly subtrees: ${JSON.stringify(commandMkdir)}`
    );
  } finally {
    workspace.dispose();
  }
}

async function testDirectCppExecutableRespectsHiddenProjectFiles(): Promise<void> {
  const mountedSnapshots: string[][] = [];
  const workspace = await createRuntimeWorkspace({
    projectSession: {
      id: 'cpp-direct-hidden-files',
      files: [
        { path: 'main.cpp', contents: 'int main() { return 0; }\n' },
        { path: 'visible.txt', contents: 'visible\n' },
        { path: '.trace/fixtures/secret.txt', contents: 'secret\n', hidden: true },
      ],
    },
    cppRunner: async (request) => {
      mountedSnapshots.push(request.project.files.map((file) => file.path));
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });

  try {
    const compile = await workspace.runCommand('clang++ main.cpp -o a.out');
    const ordinaryRun = await workspace.runCommand('./a.out');
    const authorizedRun = await workspace.runCommand('./a.out', { includeHiddenFiles: true });
    assertCondition(compile.exitCode === 0, `C++ compile stub should register the executable: ${JSON.stringify(compile)}`);
    assertCondition(ordinaryRun.exitCode === 0, `ordinary direct C++ run should succeed: ${JSON.stringify(ordinaryRun)}`);
    assertCondition(authorizedRun.exitCode === 0, `authorized direct C++ run should succeed: ${JSON.stringify(authorizedRun)}`);
    assertCondition(mountedSnapshots.length === 3, `expected compile and two run snapshots: ${mountedSnapshots.length}`);
    assertCondition(
      mountedSnapshots[0].includes('visible.txt') && !mountedSnapshots[0].includes('.trace/fixtures/secret.txt'),
      `ordinary C++ compilation must not mount hidden files: ${JSON.stringify(mountedSnapshots[0])}`
    );
    assertCondition(
      mountedSnapshots[1].includes('visible.txt') && !mountedSnapshots[1].includes('.trace/fixtures/secret.txt'),
      `ordinary direct C++ execution must not mount hidden files: ${JSON.stringify(mountedSnapshots[1])}`
    );
    assertCondition(
      mountedSnapshots[2].includes('.trace/fixtures/secret.txt'),
      `explicit hidden-file authorization should still reach direct C++ execution: ${JSON.stringify(mountedSnapshots[2])}`
    );
  } finally {
    workspace.dispose();
  }
}

async function testKernelActorsEnforceFilesystemCapabilities(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'read/allowed.txt', contents: 'allowed\n' },
      { path: 'private.txt', contents: 'private\n' },
      { path: 'trash/delete.txt', contents: 'delete\n' },
      { path: 'keep.txt', contents: 'keep\n' },
    ],
  });
  const restrictedActor = {
    id: 'restricted-agent',
    kind: 'test' as const,
    capabilities: {
      read: ['read/**'],
      write: ['write/**'],
      delete: ['trash/**'],
    },
  };

  try {
    assertCondition(
      await workspace.kernel.readFile('read/allowed.txt', restrictedActor) === 'allowed\n',
      'restricted actor should retain reads inside its allowlist'
    );
    const deniedRead = await rejectedMessage(() => workspace.kernel.readFile('private.txt', restrictedActor));
    assertCondition(deniedRead.includes('EACCES'), `restricted actor read should fail closed: ${deniedRead}`);

    await workspace.kernel.writeFile('write/allowed.txt', 'written\n', restrictedActor);
    assertCondition(await workspace.readFile('write/allowed.txt') === 'written\n', 'restricted actor should write inside its allowlist');
    const deniedWrite = await rejectedMessage(() => workspace.kernel.writeFile('private-write.txt', 'blocked\n', restrictedActor));
    assertCondition(
      deniedWrite.includes('EACCES') && !(await workspace.exists('private-write.txt')),
      `restricted actor write should fail closed: ${deniedWrite}`
    );

    await workspace.kernel.deleteFile('trash/delete.txt', restrictedActor);
    assertCondition(!(await workspace.exists('trash/delete.txt')), 'restricted actor should delete inside its allowlist');
    const deniedDelete = await rejectedMessage(() => workspace.kernel.deleteFile('keep.txt', restrictedActor));
    assertCondition(
      deniedDelete.includes('EACCES') && await workspace.exists('keep.txt'),
      `restricted actor delete should fail closed: ${deniedDelete}`
    );

    await workspace.kernel.applyFileChange(
      { path: 'write/from-diff.txt', contents: 'diff\n' },
      restrictedActor,
      'final-diff'
    );
    const deniedDiff = await rejectedMessage(() => workspace.kernel.applyFileChange(
      { path: 'outside-diff.txt', contents: 'blocked\n' },
      restrictedActor,
      'final-diff'
    ));
    assertCondition(
      deniedDiff.includes('EACCES') && !(await workspace.exists('outside-diff.txt')),
      `restricted actor final diff should enforce write capabilities: ${deniedDiff}`
    );

    const implicitUnrestrictedActor = { id: 'legacy-host', kind: 'system' as const, capabilities: {} };
    assertCondition(
      await workspace.kernel.readFile('private.txt', implicitUnrestrictedActor) === 'private\n',
      'omitted filesystem capability lists should preserve backward-compatible unrestricted access'
    );
    const denyAllActor = {
      id: 'deny-all',
      kind: 'test' as const,
      capabilities: { read: [], write: [], delete: [] },
    };
    const denyAllRead = await rejectedMessage(() => workspace.kernel.readFile('read/allowed.txt', denyAllActor));
    assertCondition(denyAllRead.includes('EACCES'), `explicit empty capability lists should deny all access: ${denyAllRead}`);
  } finally {
    workspace.dispose();
  }
}

async function testWorkspaceHydrationCannotOverwriteProtectedSessionFiles(): Promise<void> {
  const projectSession = {
    id: 'protected-hydration',
    files: [
      { path: 'locked.txt', contents: 'authoritative\n', readonly: true },
      { path: '.trace/secret.txt', contents: 'secret\n', hidden: true, readonly: true },
    ],
  } as const;

  const readonlyOverwrite = await rejectedMessage(() => createRuntimeWorkspace({
    projectSession,
    files: [{ path: 'locked.txt', contents: 'attacker-controlled\n' }],
  }));
  assertCondition(
    readonlyOverwrite.includes('EROFS') && readonlyOverwrite.includes('hydrate'),
    `top-level hydration must not overwrite readonly session files: ${readonlyOverwrite}`
  );

  const hiddenOverwrite = await rejectedMessage(() => createRuntimeWorkspace({
    projectSession,
    files: [{ path: '.trace/secret.txt', contents: 'attacker-controlled\n' }],
  }));
  assertCondition(
    hiddenOverwrite.includes('EROFS') && hiddenOverwrite.includes('hydrate'),
    `top-level hydration must not overwrite hidden session files: ${hiddenOverwrite}`
  );

  const hiddenSibling = await rejectedMessage(() => createRuntimeWorkspace({
    projectSession,
    files: [{ path: '.trace/injected.txt', contents: 'attacker-controlled\n' }],
  }));
  assertCondition(
    hiddenSibling.includes('EROFS'),
    `top-level hydration must not create files inside hidden namespaces: ${hiddenSibling}`
  );

  const identicalWorkspace = await createRuntimeWorkspace({
    projectSession,
    files: [
      { path: 'locked.txt', contents: 'authoritative\n' },
      { path: '.trace/secret.txt', contents: 'secret\n' },
      { path: 'editable.txt', contents: 'editable\n' },
    ],
  });
  try {
    assertCondition(
      await identicalWorkspace.readFile('locked.txt') === 'authoritative\n' &&
        await identicalWorkspace.readFile('editable.txt') === 'editable\n',
      'identical protected hydration entries should remain harmless no-ops while editable files load'
    );
  } finally {
    identicalWorkspace.dispose();
  }
}

async function testBrowserJavaScriptHiddenFilesAreNotMounted(): Promise<void> {
  const runner = createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true, timeoutMs: 1000 });
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
  const runner = createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true, timeoutMs: 1000 });
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

async function testBrowserJavaScriptVirtualTypeScriptPackageRespectsHiddenNamespace(): Promise<void> {
  const runner = createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true, timeoutMs: 1000 });
  const result = await runner({
    code: [
      'try { console.log("typescript:" + require("typescript").version); }',
      'catch (error) { console.log("typescript:missing"); }',
      '',
    ].join('\n'),
    source: 'inline',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      workspaceRoot: '/workspace',
      files: [
        {
          path: 'package.json',
          contents: JSON.stringify({ dependencies: { typescript: '^5.9.0' } }),
        },
      ],
      hiddenFiles: ['node_modules/typescript'],
    },
  });

  assertCondition(result.exitCode === 0, `hidden TypeScript package test should complete: ${JSON.stringify(result)}`);
  assertCondition(
    result.stdout === 'typescript:missing\n',
    `browser JS should not inject virtual TypeScript under a hidden namespace: ${JSON.stringify(result)}`
  );
  assertCondition(
    !result.files?.some((file) => file.path.startsWith('node_modules/typescript')),
    `hidden virtual TypeScript package should not leak through final diffs: ${JSON.stringify(result.files)}`
  );
}

async function testBrowserJavaScriptFdWriteStreamsPreserveAppendSemantics(): Promise<void> {
  const runner = createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true, timeoutMs: 1000 });
  const result = await runner({
    code: [
      'const fs = require("node:fs");',
      'fs.writeFileSync("append.txt", "abcdef");',
      'const fd = fs.openSync("append.txt", "a+");',
      'await new Promise((resolve, reject) => {',
      '  const stream = fs.createWriteStream(null, { fd, start: 2 });',
      '  stream.on("error", reject);',
      '  stream.on("finish", resolve);',
      '  stream.end("XY");',
      '});',
      'console.log(fs.readFileSync("append.txt", "utf8"));',
      '',
    ].join('\n'),
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

  assertCondition(result.exitCode === 0, `fd append stream test should complete: ${JSON.stringify(result)}`);
  assertCondition(
    result.stdout === 'abcdefXY\n',
    `fd-backed createWriteStream should append despite explicit start on append fds: ${JSON.stringify(result)}`
  );
}

async function testBrowserJavaScriptFileHandleStreamCloseStateIsNotSymbolForgeable(): Promise<void> {
  const runner = createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true, timeoutMs: 1000 });
  const result = await runner({
    code: [
      'const fs = require("node:fs");',
      'const handle = await fs.promises.open("close.txt", "w+");',
      'const stream = handle.createWriteStream();',
      'const symbolSets = Object.getOwnPropertySymbols(stream).map((symbol) => stream[symbol]).filter((value) => value instanceof Set);',
      'for (const set of symbolSets) for (const listener of [...set]) listener();',
      'try { await handle.writeFile("ok"); console.log("write:open"); }',
      'catch (error) { console.log("write:" + error.code); }',
      'stream.end();',
      'await new Promise((resolve) => stream.on("close", resolve));',
      'try { await handle.writeFile("late"); console.log("late:open"); }',
      'catch (error) { console.log("late:" + error.code); }',
      '',
    ].join('\n'),
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

  assertCondition(result.exitCode === 0, `FileHandle close forgeability test should complete: ${JSON.stringify(result)}`);
  assertCondition(
    result.stdout === 'write:open\nlate:EBADF\n',
    `FileHandle close state should not be forgeable through stream symbols: ${result.stdout}`
  );
}

async function testBrowserJavaScriptCpRejectsFileToRootDirectory(): Promise<void> {
  const runner = createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true, timeoutMs: 1000 });
  const result = await runner({
    code: [
      'const fs = require("node:fs");',
      'try { fs.cpSync("source.txt", "."); console.log("cp:ok"); }',
      'catch (error) { console.log("cp:" + error.code); }',
      'console.log("root=" + fs.readdirSync(".").join(","));',
      '',
    ].join('\n'),
    source: 'inline',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      workspaceRoot: '/workspace',
      files: [{ path: 'source.txt', contents: 'source\n' }],
    },
  });

  assertCondition(result.exitCode === 0, `cp root rejection test should complete: ${JSON.stringify(result)}`);
  assertCondition(
    result.stdout === 'cp:ERR_FS_CP_NON_DIR_TO_DIR\nroot=source.txt\n',
    `browser JS should reject file copies to the workspace root directory: ${JSON.stringify(result)}`
  );
  assertCondition(
    !result.files?.some((file) => file.path === ''),
    `browser JS should not emit empty-path file changes: ${JSON.stringify(result.files)}`
  );
}

async function testBrowserJavaScriptSyntaxErrorsHideRunnerInternals(): Promise<void> {
  const runner = createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true, timeoutMs: 1000 });
  const result = await runner({
    code: 'const broken = ;\n',
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

  assertCondition(result.exitCode === 1, `syntax error should fail: ${JSON.stringify(result)}`);
  assertCondition(result.stderr.includes('SyntaxError'), `syntax error should be reported: ${JSON.stringify(result)}`);
  assertCondition(
    !result.stderr.includes('runBrowserJavaScriptProjectRequest') &&
      !result.stderr.includes('project-browser.ts') &&
      !result.stderr.includes('executeEntrypoint') &&
      !result.stderr.includes('executeModule'),
    `browser JS syntax errors should not expose runner internals: ${JSON.stringify(result.stderr)}`
  );
}

async function testBrowserJavaScriptTimeoutWaitsForLiveFileChangeQueue(): Promise<void> {
  // Same-realm execution temporarily installs virtual timer globals. Capture a
  // host timer so this assertion observes the outer runner timeout.
  const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
  let releaseApply!: () => void;
  const applyCanFinish = new Promise<void>((resolve) => {
    releaseApply = resolve;
  });
  let applyStarted = false;
  const runner = createBrowserJavaScriptProjectRunner({
    allowMainThreadExecution: true,
    trustedMainThreadExecution: true,
    timeoutMs: 5,
    applyFileChange: async () => {
      applyStarted = true;
      await applyCanFinish;
      return false;
    },
  });
  let settled = false;
  const command = runner({
    code: [
      'const fs = require("node:fs");',
      'fs.writeFileSync("late.txt", "late\\n");',
      '',
    ].join('\n'),
    source: 'inline',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      workspaceRoot: '/workspace',
      files: [],
    },
  }).finally(() => {
    settled = true;
  });

  await new Promise((resolve) => hostSetTimeout(resolve, 25));
  assertCondition(applyStarted, 'browser JS timeout test should start live file-change application');
  assertCondition(settled, 'browser JS timeout should resolve even while live file-change application is pending');
  const result = await command;
  assertCondition(
    result.exitCode === 124 &&
      result.stderr.includes('node: execution timed out after 5ms'),
    `browser JS timeout should return the timeout result before live queue settles: ${JSON.stringify(result)}`
  );
  releaseApply();
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
  assertCondition(
    source.includes('const stableNodeRefState = { ids: new WeakMap(), nextId: 1 };'),
    'JS trace recorder should not retain traced node objects with a strong Map'
  );
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
  const policySource = await readFile(
    join(dirname(testDirectory), 'workers', 'shared', 'runtime-kernel-policy-classic.js'),
    'utf8'
  );
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
  let context!: vm.Context;
  context = vm.createContext({
    console,
    self: workerScope,
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    importScripts: (...urls: string[]) => {
      if (urls.every((url) => url.includes('runtime-kernel-policy-classic.js'))) {
        vm.runInContext(policySource, context, { filename: 'runtime-kernel-policy-classic.js' });
        return;
      }
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
          '  let setPulls = 0;',
          '  class GuardedSet extends Set {',
          '    [Symbol.iterator]() {',
          '      const iterator = super[Symbol.iterator]();',
          '      return {',
          '        next() {',
          '          setPulls += 1;',
          '          if (setPulls > 1) throw new Error("set overread");',
          '          return iterator.next();',
          '        },',
          '        return() { return { done: true }; },',
          '        [Symbol.iterator]() { return this; },',
          '      };',
          '    }',
          '  }',
          '  const buckets = [new GuardedSet([5, 6, 7])];',
          '  let first = 0;',
          '  for (const value of buckets[0]) {',
          '    first = value;',
          '    break;',
          '  }',
          '  return { total, pulls, first, setPulls };',
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
    JSON.stringify(result.output) === JSON.stringify({ total: 23, pulls: 2, first: 5, setPulls: 1 }),
    `destructured iterable tracing should not pre-consume yielded iterables: ${JSON.stringify(result.output)}`
  );
}

async function testJavaScriptInputHydrationIsBounded(): Promise<void> {
  const sources = [
    ['worker', await readFile(join(dirname(testDirectory), 'workers', 'javascript', 'javascript-worker.js'), 'utf8')],
    [
      'package executor',
      await readFile(join(dirname(testDirectory), 'packages', 'harness-javascript', 'src', 'javascript-executor.ts'), 'utf8'),
    ],
  ] as const;

  for (const [label, source] of sources) {
    assertCondition(
      !source.includes('const node = queue.shift()'),
      `${label} tree level-order hydration should use a cursor queue instead of Array.shift`
    );
    assertCondition(
      source.includes('INPUT_MATERIALIZER_MAX_DEPTH') &&
        source.includes('Input materializer exceeded maximum depth') &&
        source.includes('ERR_HARNESS_INPUT_MATERIALIZER_DEPTH'),
      `${label} input materializer should reject oversized nested inputs before stack exhaustion`
    );
  }

  const context = vm.createContext({
    console,
    self: {
      location: { search: '' },
      onmessage: null,
      postMessage: () => {},
    },
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    importScripts: (...urls: string[]) => {
      throw new Error(`Unexpected importScripts in input hydration test: ${urls.join(',')}`);
    },
  });
  vm.runInContext(sources[0][1], context, { filename: 'javascript-worker.js' });
  const result = vm.runInContext(
    `(() => {
      const node = { __type__: 'TreeNode', val: 1 };
      node.left = node;
      node.extra = node;
      const materialized = materializeTreeInput(node);
      return {
        val: materialized.val,
        leftCycles: materialized.left === materialized,
        extraCycles: materialized.extra === materialized,
      };
    })()`,
    context
  ) as { val: number; leftCycles: boolean; extraCycles: boolean };

  assertCondition(
    result.val === 1 && result.leftCycles && result.extraCycles,
    `JavaScript tree input hydration should preserve cycles without recursive overflow: ${JSON.stringify(result)}`
  );

  const deepWorkerResult = vm.runInContext(
    `(() => {
      const head = { __type__: 'ListNode', val: 0, next: null };
      let cursor = head;
      for (let index = 0; index < 600; index += 1) {
        cursor.next = { __type__: 'ListNode', val: index + 1, next: null };
        cursor = cursor.next;
      }
      try {
        materializeListInput(head);
        return 'ok';
      } catch (error) {
        return String(error && error.message ? error.message : error);
      }
    })()`,
    context
  ) as string;
  assertCondition(
    deepWorkerResult.includes('maximum depth'),
    `JavaScript worker list input hydration should reject deep chains before stack exhaustion: ${deepWorkerResult}`
  );

  const deepTree: Record<string, unknown> = { __type__: 'TreeNode', val: 0, left: null, right: null };
  let cursor = deepTree;
  for (let depth = 0; depth < 600; depth += 1) {
    const child: Record<string, unknown> = { __type__: 'TreeNode', val: depth + 1, left: null, right: null };
    cursor.left = child;
    cursor = child;
  }
  const packageResult = await executeTypeScriptCode(
    'function depth(root: TreeNode | null): number { return root ? 1 : 0; }',
    'depth',
    { root: deepTree },
    'function'
  );
  assertCondition(
    packageResult.success === false && typeof packageResult.error === 'string' && packageResult.error.includes('maximum depth'),
    `Package TypeScript tree input hydration should reject deep chains before stack exhaustion: ${JSON.stringify(packageResult)}`
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
  const source = csharpWorkerVmSource(await readFile(join(dirname(testDirectory), 'workers', 'csharp', 'csharp-worker.js'), 'utf8'));
  const context = vm.createContext({
    console,
    self: {
      addEventListener: () => {},
      postMessage: () => {},
      close: () => {},
      location: { search: '' },
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
        internalKernelPath: normalizeKernelVirtualManifestPath('/tmp/tracecode-csharp-project/lock'),
        customKernelPath: normalizeKernelVirtualManifestPath('/tracekernel/custom'),
        deviceTraversal: normalizeRawKernelDevicePath('/dev/../workspace/stdout'),
        escapedLivePath: normalizeProjectFsPath('/workspace/src/../../escape.txt', request),
        normalizedLivePath: normalizeProjectFsPath('/workspace/src/../safe.txt', request),
        staleInternalLivePath: normalizeProjectFsPath('/tmp/tracecode-csharp-project/stale-secret.txt', request),
        mutationError,
        sanitizedUnhandledStderr: sanitizeCSharpProjectStderr([
          'before\\n',
          'Unhandled exception. System.InvalidOperationException: boom\\n',
          '   at TraceCode.CSharpHost.CompilerHost.InvokeProjectEntryPoint() in /tmp/tracecode-csharp-project/CompilerHost.cs:line 2776\\n',
          '   at Program.Main() in /tmp/tracecode-csharp-project/Program.cs:line 3\\n',
        ].join('')),
        sourceTreePolicy: csharpSharedKernelPolicyUrl('http://localhost/workers/csharp/csharp-worker.js'),
        distributedPolicy: csharpSharedKernelPolicyUrl('http://localhost/workers/csharp-worker.js'),
      };
    })()`,
    context
  ) as {
    kernelTraversal: string | null;
    internalKernelPath: string | null;
    customKernelPath: string | null;
    deviceTraversal: string | null;
    escapedLivePath: string | null;
    normalizedLivePath: string | null;
    staleInternalLivePath: string | null;
    mutationError: string;
    sanitizedUnhandledStderr: string;
    sourceTreePolicy: string;
    distributedPolicy: string;
  };

  assertCondition(result.kernelTraversal === null, `C# kernel manifest traversal should be rejected: ${JSON.stringify(result)}`);
  assertCondition(result.internalKernelPath === null, `C# kernel manifest internal paths should be rejected: ${JSON.stringify(result)}`);
  assertCondition(result.customKernelPath === '/tracekernel/custom', `C# custom kernel manifest path should be preserved: ${JSON.stringify(result)}`);
  assertCondition(result.deviceTraversal === null, `C# device manifest traversal should be rejected: ${JSON.stringify(result)}`);
  assertCondition(result.escapedLivePath === null, `C# live event traversal path should not be emitted: ${JSON.stringify(result)}`);
  assertCondition(result.normalizedLivePath === 'safe.txt', `C# live event path should normalize in-workspace dot segments: ${JSON.stringify(result)}`);
  assertCondition(result.staleInternalLivePath === null, `C# worker should not expose stale internal project paths as live events: ${JSON.stringify(result)}`);
  assertCondition(result.mutationError === 'EACCES', `C# workspace escape mutation should be rejected: ${JSON.stringify(result)}`);
  assertCondition(
    result.sanitizedUnhandledStderr.includes('Unhandled exception. System.InvalidOperationException: boom') &&
      !result.sanitizedUnhandledStderr.includes('/tmp/tracecode-csharp-project') &&
      !result.sanitizedUnhandledStderr.includes('\n   at '),
    `C# project stderr should redact host stack traces and internal paths: ${JSON.stringify(result)}`
  );
  assertCondition(
    result.sourceTreePolicy === 'http://localhost/workers/shared/runtime-kernel-policy.js' &&
      result.distributedPolicy === 'http://localhost/workers/shared/runtime-kernel-policy.js',
    `C# shared policy import should resolve inside the worker shared asset directory: ${JSON.stringify(result)}`
  );
}

async function testCSharpWorkerProjectEventBudgets(): Promise<void> {
  const source = csharpWorkerVmSource(await readFile(join(dirname(testDirectory), 'workers', 'csharp', 'csharp-worker.js'), 'utf8'));
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

async function testCSharpManagedLiveSnapshotsReserveBeforeRead(): Promise<void> {
  const source = await readFile(join(dirname(testDirectory), 'runtimes', 'csharp', 'TraceCode.CSharpHost', 'CompilerHost.cs'), 'utf8');
  assertCondition(
    source.includes('TryReserveLiveProjectFileChangeBudget(ProjectFileChangeByteSize(change))') &&
      source.includes('TryReserveLiveFileSnapshotBudget') &&
      source.includes('liveBudgetReserved: true'),
    'C# managed live file snapshots should reserve live budgets before emitting snapshot changes'
  );
  assertCondition(
    /if \(!TryReserveLiveFileSnapshotBudget\(relativePath, absolutePath\)\)[\s\S]*?return;[\s\S]*?File\.ReadAllBytes\(absolutePath\)[\s\S]*?liveBudgetReserved: true/.test(source),
    'C# managed live file snapshots should check budget before reading the changed file'
  );
  assertCondition(
    /if \(!TryReserveLiveFileSnapshotBudget\(nestedRelativePath, filePath\)\)[\s\S]*?continue;[\s\S]*?File\.ReadAllBytes\(filePath\)[\s\S]*?liveBudgetReserved: true/.test(source),
    'C# managed directory snapshots should check each nested file budget before reading file bytes'
  );
  assertCondition(
    !source.includes('LiveFileSnapshotWithinBudget'),
    'C# managed live file snapshots should not use the old per-file-only budget check'
  );
}

async function testCSharpWorkerInputPreflightBudgets(): Promise<void> {
  const source = csharpWorkerVmSource(await readFile(join(dirname(testDirectory), 'workers', 'csharp', 'csharp-worker.js'), 'utf8'));
  const context = vm.createContext({
    console,
    self: {
      addEventListener: () => {},
      postMessage: () => {},
      close: () => {},
      location: { search: '' },
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
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  vm.runInContext(source, context, { filename: 'csharp-worker.js' });
  const result = vm.runInContext(
    `(() => {
      const root = { __type__: 'Node', val: 0, children: [] };
      let cursor = root;
      for (let depth = 0; depth < 80; depth++) {
        const child = { __type__: 'Node', val: depth + 1, children: [] };
        cursor.children = [child];
        cursor = child;
      }
      try {
        validateCSharpInputsForJson({ root });
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })()`,
    context
  ) as string;

  assertCondition(
    result.includes('maximum depth'),
    `C# worker should reject deep structured inputs before host JSON serialization: ${result}`
  );
}

async function testCSharpInputHydrationConstructorsAreBounded(): Promise<void> {
  const source = await readFile(join(dirname(testDirectory), 'runtimes', 'csharp', 'TraceCode.CSharpHost', 'CompilerHost.cs'), 'utf8');
  assertCondition(
    source.includes('MaxInputConstructorCandidates = 32') &&
      source.includes('MaxInputConstructorParameters = 32'),
    'C# input hydration should cap reflected constructor scans'
  );
  assertCondition(
    source.includes('ConstructorInfo? parameterless = targetType.GetConstructor(Type.EmptyTypes);') &&
      source.indexOf('ConstructorInfo? parameterless = targetType.GetConstructor(Type.EmptyTypes);') < source.indexOf('foreach (ConstructorInfo constructor in targetType'),
    'C# input hydration should prefer parameterless construction before invoking matching constructors'
  );
  assertCondition(
    source.includes('RecordConstructorCandidate(constructorIndex++') &&
      source.includes('RecordConstructorParameterCount(parameters.Length') &&
      source.includes('IsSafeInputConstructorParameter'),
    'C# input hydration should budget and filter reflected constructor parameters'
  );
}

async function testNativeCSharpInputConversionPrefersStringDictionaries(): Promise<void> {
  const source = await readFile(join(dirname(testDirectory), 'packages', 'harness-native', 'src', 'index.ts'), 'utf8');
  const convertStart = source.indexOf('private static object? ConvertJsonElement');
  const convertEnd = source.indexOf('private static Type? ListElementType', convertStart);
  const convertSource = source.slice(convertStart, convertEnd);
  const dictionaryBranch = convertSource.indexOf('var dictionaryValueType = StringDictionaryValueType(targetType);');
  const listBranch = convertSource.indexOf('var listElementType = ListElementType(targetType);');
  assertCondition(
    dictionaryBranch >= 0 && listBranch >= 0 && dictionaryBranch < listBranch,
    'Native C# input conversion should classify string-keyed dictionaries before list-like collection interfaces'
  );
  assertCondition(
    convertSource.includes('targetType.IsAssignableFrom(dictionaryType)'),
    'Native C# input conversion should only synthesize Dictionary<string,T> values for assignable targets'
  );

  const listStart = source.indexOf('private static Type? ListElementType');
  const listEnd = source.indexOf('private static Type? StringDictionaryValueType', listStart);
  const listSource = source.slice(listStart, listEnd);
  assertCondition(
    listSource.includes('StringDictionaryValueType(type) != null') &&
      listSource.indexOf('StringDictionaryValueType(type) != null') < listSource.indexOf('typeof(List<>)'),
    'Native C# list input conversion should not treat string-keyed dictionaries as list-like inputs'
  );
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

function isDeniedCSharpBrowserRuntimeAsset(path: string): boolean {
  const fileName = path.split('/').at(-1) ?? path;
  const normalized = fileName.replace(/^[0-9]+_/, '');
  return /^System\.Net(?:\.|$)/i.test(normalized) ||
    /^System\.Reflection\.Emit(?:\.|$).*\.dll$/i.test(normalized) ||
    /^System\.Runtime\.InteropServices\.JavaScript\.dll$/i.test(normalized);
}

async function testCSharpBrowserRuntimeNetworkAssembliesAreDenied(): Promise<void> {
  const root = dirname(testDirectory);
  const frameworkRoots = [
    join(root, 'workers', 'vendor', 'csharp', '_framework'),
  ];
  const syncedPackageFramework = join(root, 'packages', 'harness-csharp', 'workers', 'vendor', 'csharp', '_framework');
  try {
    await access(syncedPackageFramework);
    frameworkRoots.push(syncedPackageFramework);
  } catch {
    // Package-local worker assets are generated by sync:package-assets. The
    // canonical runtime remains the source-level contract on fresh checkouts.
  }
  for (const frameworkRoot of frameworkRoots) {
    const files = await listFilesRecursive(frameworkRoot);
    const deniedFiles = files.filter(isDeniedCSharpBrowserRuntimeAsset);
    assertCondition(
      deniedFiles.length === 0,
      `C# browser runtime should not ship denied network/reflection/user-reference assets: ${JSON.stringify(deniedFiles)}`
    );

    const bootManifest = await readFile(join(frameworkRoot, 'dotnet.boot.js'), 'utf8');
    assertCondition(
      !/"(?:name|virtualPath)":\s*"[^"]*System\.Net(?:\.|")/i.test(bootManifest) &&
        !/"(?:name|virtualPath)":\s*"\/tracecode-refs\/System\.Reflection\.Emit(?:\.|")/i.test(bootManifest) &&
        !bootManifest.includes('/tracecode-refs/System.Runtime.InteropServices.JavaScript.dll'),
      `C# browser runtime boot manifest should not reference denied assemblies under ${frameworkRoot}`
    );
  }

  const hostSource = await readFile(join(root, 'runtimes', 'csharp', 'TraceCode.CSharpHost', 'CompilerHost.cs'), 'utf8');
  assertCondition(
    hostSource.includes('ValidateUserSourcePolicy(originalUserTree)') &&
      hostSource.includes('ValidateUserSourcePolicy(projectTree)') &&
      hostSource.includes('IsAllowedUserAssemblyName'),
    'C# compiler host should enforce denied browser runtime APIs before compiling user code and project references'
  );
  assertCondition(
    [
      '"System.Reflection.Assembly"',
      '"System.Runtime.Loader"',
      '"System.Type"',
      '"System.AppDomain"',
      'deniedAliases',
      'usingDirective.Alias',
      'IdentifierNameSyntax identifierName',
    ].every((marker) => hostSource.includes(marker)),
    'C# compiler host should deny fully qualified and aliased reflection/runtime loader bypasses'
  );
  const projectFile = await readFile(join(root, 'runtimes', 'csharp', 'TraceCode.CSharpHost', 'TraceCode.CSharpHost.csproj'), 'utf8');
  assertCondition(
    projectFile.includes('Remove="$(TargetDir)System.Net*.dll"') &&
      projectFile.includes('Remove="$(TargetDir)System.Reflection.Emit*.dll"') &&
      projectFile.includes('Remove="$(TargetDir)System.Runtime.InteropServices.JavaScript.dll"'),
    'C# browser runtime publish should keep denied assemblies out of compiler reference VFS'
  );
  const updateScript = await readFile(join(root, 'scripts', 'update-csharp-wasm-runtime.sh'), 'utf8');
  assertCondition(
    updateScript.includes('prune-csharp-wasm-runtime-assets.ts'),
    'C# runtime update script should prune denied assemblies after publish'
  );
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
        bridgeRunId: 'java-budget-bridge',
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
      emitLiveJavaProjectOutput('java-budget-bridge', 'stdout', 'x'.repeat(1024 * 1024 + 16), '', '');
      emitLiveJavaProjectOutput('java-budget-bridge', 'stdout', 'late', '', '');
      emitLiveJavaProjectFileSnapshot('java-budget-bridge', 'huge.txt', 'x'.repeat(6 * 1024 * 1024));
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

async function testJavaWorkerCheerpJLoaderPolicyRequiresLocalAppAsset(): Promise<void> {
  const source = await readFile(join(dirname(testDirectory), 'workers', 'java', 'java-worker.js'), 'utf8');
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
      const rejected = [];
      const accepted = assertTrustedJavaAsset('CheerpJ loader', '/app/workers/vendor/cheerpj-loader.js');
      for (const url of [
        'https://cjrtnc.leaningtech.com/4.2/loader.js',
        'https://example.com/4.2/loader.js',
        '/workers/vendor/cheerpj-loader.js',
      ]) {
        try {
          assertTrustedJavaAsset('CheerpJ loader', url);
        } catch (error) {
          rejected.push(error instanceof Error ? error.message : String(error));
        }
      }
      let rejectedPolicy = '';
      try {
        javaSharedKernelPolicyUrl('http://localhost/assets/java-worker.js');
      } catch (error) {
        rejectedPolicy = error instanceof Error ? error.message : String(error);
      }
      return {
        accepted,
        rejected,
        sourceTreePolicy: javaSharedKernelPolicyUrl('http://localhost/workers/java/java-worker.js'),
        distributedPolicy: javaSharedKernelPolicyUrl('http://localhost/workers/java-worker.js'),
        rejectedPolicy,
      };
    })()`,
    context
  ) as {
    accepted: string;
    rejected: string[];
    sourceTreePolicy: string;
    distributedPolicy: string;
    rejectedPolicy: string;
  };

  assertCondition(
    result.accepted === 'http://localhost/app/workers/vendor/cheerpj-loader.js',
    `CheerpJ loader policy should accept only a same-origin /app/ asset: ${JSON.stringify(result)}`
  );
  assertCondition(
    result.rejected.length === 3 && result.rejected.every((message) => message.includes('local /app/ asset path')),
    `CheerpJ loader policy should reject remote or non-/app loader URLs: ${JSON.stringify(result)}`
  );
  assertCondition(
    result.sourceTreePolicy === 'http://localhost/workers/shared/runtime-kernel-policy-classic.js' &&
      result.distributedPolicy === 'http://localhost/workers/shared/runtime-kernel-policy-classic.js' &&
      result.rejectedPolicy.includes('worker shared asset directory'),
    `Java shared policy import should resolve only inside the worker shared asset directory: ${JSON.stringify(result)}`
  );
}

async function testJavaQueueAugmentationRequiresNativeBlockShape(): Promise<void> {
  const source = await readFile(join(dirname(testDirectory), 'workers', 'java', 'java-source-augmentations.js'), 'utf8');
  const context = vm.createContext({ self: {} });
  vm.runInContext(source, context, { filename: 'java-source-augmentations.js' });
  const augmentations = (context.self as {
    TraceCodeJavaSourceAugmentations?: {
      augmentJavaCollectionOperations: (source: string, sourceText?: string) => string;
    };
  }).TraceCodeJavaSourceAugmentations;
  assertCondition(Boolean(augmentations), 'Java source augmentations should load in a VM context');

  const spoofedUserHookSource = augmentations!.augmentJavaCollectionOperations(`import java.util.*;

class Solution {
  boolean solve() {
    Deque<Integer> q = new ArrayDeque<>();
    q.offerLast(1); TraceHooks.emitMutatingCallAtLine(6, "q", "offerLast", 1);
    return q.size() == 1;
  }
}`, '');
  assertCondition(
    spoofedUserHookSource.includes('TraceHooks.offerDequeLastAtLine(6, "q", q, 1)'),
    `Java queue augmentation should not let user hook calls suppress wrapping: ${spoofedUserHookSource}`
  );

  const nativeBlockSource = augmentations!.augmentJavaCollectionOperations(`import java.util.*;

class Solution {
  boolean solve() {
    Deque<Integer> q = new ArrayDeque<>();
    int i = 5;
    { q.offerLast(i); TraceHooks.emitMutatingCallAtLine(6, "q", "offerLast", i); TraceHooks.emitIndexedWriteAtLine(6, "q", new Object[] { ((java.util.Collection) q).size() - 1 }, i, null); TraceHooks.emitRuntimeSnapshotAtLine(6, "q", q); }
    return true;
  }
}`, '');
  assertCondition(
    !nativeBlockSource.includes('TraceHooks.offerDequeLastAtLine') &&
      nativeBlockSource.includes('q.offerLast(i); TraceHooks.emitMutatingCallAtLine'),
    `Java queue augmentation should still skip native generated mutation blocks: ${nativeBlockSource}`
  );
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
    runCompileAndRunClearsTraceHooks(args[0]);
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

  private static void runCompileAndRunClearsTraceHooks(String helperJar) throws Exception {
    Path root = Files.createTempDirectory("tracecode-java-run-state-smoke-");
    Path source = root.resolve("Main.java");
    Path classes = root.resolve("classes");
    Files.writeString(
        source,
        String.join("\\n",
            "import tracecode.user.TraceHooks;",
            "public class Main {",
            "  public static String run() {",
            "    TraceHooks.emit(\\\"trace:{\\\\\\\"kind\\\\\\\":\\\\\\\"line\\\\\\\",\\\\\\\"line\\\\\\\":7}\\\");",
            "    return \\\"ok\\\";",
            "  }",
            "}") + "\\n",
        StandardCharsets.UTF_8);
    String report = BrowserCompileAndTraceLibrary.compileAndRun(source.toString(), classes.toString(), "Main", helperJar, "none");
    String events = String.join("\\\\n", TraceHooks.drainEvents());
    if (!report.contains("\\\"success\\\":true") || !events.isEmpty()) {
      throw new IllegalStateException("compileAndRun left TraceHooks state behind: " + report + "\\n" + events);
    }
    System.out.println("compile-run-tracehooks-clear-ok");
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
    assertCondition(output.includes('compile-run-tracehooks-clear-ok'), `compileAndRun should clear TraceHooks run state: ${output}`);
    assertCondition(output.includes('compile-cache-ok'), `Java compile cache manifest smoke should pass: ${output}`);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function testNativeJavaHostCacheUsesPrivateTempDirectory(): Promise<void> {
  const source = await readFile(join(dirname(testDirectory), 'packages', 'harness-native', 'src', 'index.ts'), 'utf8');
  assertCondition(
    source.includes("await mkdtemp(join(tmpdir(), 'tracecode-native-java-host-'))"),
    'Native Java host helper should compile into a fresh private temp directory'
  );
  assertCondition(
    !source.includes('existsSync(hostClass)'),
    'Native Java host helper must not trust a pre-existing predictable class file'
  );
  assertCondition(
    source.indexOf('const hostRoot = await mkdtemp') < source.indexOf('const hostCompile = await runProcess'),
    'Native Java host helper should allocate the private directory before compiling the host'
  );
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
      const literalProjectRoot = "/workspace/$&/$\\x60/$'";
      const literalStderr = javaProjectFailureStderr(
        { compilerStdout: diagnosticLine, compilerStderr: '', runtimeError: '' },
        sourceRoot,
        literalProjectRoot
      );
      return {
        length: stderr.length,
        hasHugePath: stderr.includes('r'.repeat(4096)),
        hasTruncation: stderr.includes('<truncated'),
        literalStderr,
        literalExpected: literalProjectRoot + '/Main.java:1: error: boom',
      };
    })()`,
    context
  ) as { length: number; hasHugePath: boolean; hasTruncation: boolean; literalStderr: string; literalExpected: string };

  assertCondition(result.length <= 66000, `Java project diagnostics should be capped: ${JSON.stringify(result)}`);
  assertCondition(!result.hasHugePath, `Java project diagnostics should cap replacement paths: ${JSON.stringify(result)}`);
  assertCondition(result.hasTruncation, `Java project diagnostics should include truncation marker: ${JSON.stringify(result)}`);
  assertCondition(
    result.literalStderr === result.literalExpected,
    `Java project diagnostics should treat replacement roots literally: ${JSON.stringify(result)}`
  );
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

async function testJavaWorkerTraceHeaderExpansionIsBounded(): Promise<void> {
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
  const sourceText = [
    'class Solution {',
    '  void run() {',
    '    for (int i = 0; i < 10; i++) {',
    '      i = i + 1;',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const rawEvents: string[] = [];
  for (let index = 0; index < 3000; index += 1) {
    rawEvents.push(nativeJavaTraceEvent({ kind: 'line', line: 4, function: 'run' }));
    rawEvents.push(nativeJavaTraceEvent({
      kind: 'snapshot',
      line: 4,
      target: { variable: 'i' },
      value: index,
    }));
  }
  Object.assign(context, { workerLoopSourceText: sourceText, workerLoopEvents: rawEvents });
  const result = vm.runInContext(
    `(() => {
      const expanded = expandLoopHeaderTraceEvents(workerLoopEvents, workerLoopSourceText);
      return {
        raw: workerLoopEvents.length,
        expanded: expanded.length,
        headerEvents: expanded.filter((event) => parseTraceLineNumber(event) === 3).length,
      };
    })()`,
    context
  ) as { raw: number; expanded: number; headerEvents: number };

  assertCondition(
    result.expanded <= result.raw + 2048,
    `Java worker header expansion should cap synthetic event growth: ${JSON.stringify(result)}`
  );
  assertCondition(
    result.headerEvents <= 2048,
    `Java worker header expansion should cap synthetic header events: ${JSON.stringify(result)}`
  );
}

async function testCppWorkerProjectEventBudgets(): Promise<void> {
  const source = (await readFile(join(dirname(testDirectory), 'workers', 'cpp', 'cpp-worker.js'), 'utf8')).replace(
    /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/shared\/runtime-kernel-policy\.js['"];\s*/m,
    ''
  );
  const posted: Array<{ type?: string; payload?: { type?: string; stream?: string; data?: string; change?: { path?: string } } }> = [];
  const capturePostMessage = (message: unknown) => {
    posted.push(message as { type?: string; payload?: { type?: string; stream?: string; data?: string; change?: { path?: string } } });
  };
  const context = vm.createContext({
    console,
    self: {
      location: { href: 'http://localhost/workers/cpp/cpp-worker.js', origin: 'http://localhost', search: '' },
      postMessage: capturePostMessage,
    },
    location: { href: 'http://localhost/workers/cpp/cpp-worker.js', origin: 'http://localhost', search: '' },
    postMessage: capturePostMessage,
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


async function testCppPinnedToolchainFetchesFailClosed(): Promise<void> {
  const source = (await readFile(join(dirname(testDirectory), 'workers', 'cpp', 'cpp-worker.js'), 'utf8')).replace(
    /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/shared\/runtime-kernel-policy\.js['"];\s*/m,
    ''
  );
  const context = vm.createContext({
    console,
    self: {
      location: { href: 'http://localhost/workers/cpp/cpp-worker.js', origin: 'http://localhost', search: '' },
      postMessage: () => {},
    },
    location: { href: 'http://localhost/workers/cpp/cpp-worker.js', origin: 'http://localhost', search: '' },
    postMessage: () => {},
    URL,
    TextEncoder,
    TextDecoder,
    Headers,
    Response,
    Request,
    Uint8Array,
    ArrayBuffer,
    WebAssembly,
    BigInt,
    Map,
    Set,
    Promise,
    JSON,
    Math,
    Date,
    performance: { now: () => 0 },
    fetch: async () => new Response('unchecked', { status: 200 }),
    btoa: (binary: string) => Buffer.from(binary, 'binary').toString('base64'),
    atob: (encoded: string) => Buffer.from(encoded, 'base64').toString('binary'),
  });
  vm.runInContext(source, context, { filename: 'cpp-worker.js' });
  const result = await vm.runInContext(
    `(async () => {
      configuredAssets = {
        toolchainIntegrity: {
          assets: [{ url: 'https://toolchain.example/yowasp/bundle.js', sha256: '${'0'.repeat(64)}' }],
        },
      };
      const bundleHref = 'https://toolchain.example/yowasp/bundle.js';
      const topLevelResult = await withPinnedCppFetch(bundleHref, () => fetch('https://toolchain.example/yowasp/unmanifested-at-import.wasm'))
        .then(() => 'allowed', (error) => String(error?.message || error));
      const compilerBundle = wrapPinnedCppExports({
        async runClang() {
          await fetch(new URL('llvm.core.wasm', bundleHref).href);
          return {};
        },
      }, bundleHref);
      const lazyResult = await compilerBundle.runClang()
        .then(() => 'allowed', (error) => String(error?.message || error));
      return { topLevelResult, lazyResult };
    })()`,
    context
  ) as { topLevelResult: string; lazyResult: string };

  assertCondition(
    result.topLevelResult.includes('exact pinned toolchain manifest URL'),
    `Pinned C++ imports should reject unmanifested secondary assets during import: ${JSON.stringify(result)}`
  );
  assertCondition(
    result.lazyResult.includes('exact pinned toolchain manifest URL'),
    `Pinned C++ runClang should reject unmanifested lazy secondary assets: ${JSON.stringify(result)}`
  );
}

async function testCppCompilerLifecycleSeparatesCompilationFromExecution(): Promise<void> {
  const source = (await readFile(join(dirname(testDirectory), 'workers', 'cpp', 'cpp-worker.js'), 'utf8')).replace(
    /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/shared\/runtime-kernel-policy\.js['"];\s*/m,
    ''
  );
  const workers: Array<{
    url: string;
    terminated: boolean;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: { message?: string }) => void) | null;
    onmessageerror: (() => void) | null;
    postMessage(message: unknown): void;
    terminate(): void;
  }> = [];
  class DisposableCompilerWorker {
    url: string;
    terminated = false;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    onmessageerror: (() => void) | null = null;

    constructor(url: string) {
      this.url = url;
      workers.push(this);
    }

    postMessage(message: { id?: string; protocolToken?: string }): void {
      Promise.resolve().then(() => {
        this.onmessage?.({
          data: {
            id: message.id,
            protocolToken: message.protocolToken,
            type: 'compile-result',
            payload: { success: true, stdout: '', stderr: '', programBuffer: new ArrayBuffer(0) },
          },
        });
      });
    }

    terminate(): void {
      this.terminated = true;
    }
  }
  const context = vm.createContext({
    console,
    self: {
      location: { href: 'http://localhost/workers/cpp/cpp-worker.js', origin: 'http://localhost', search: '' },
      postMessage: () => {},
    },
    location: { href: 'http://localhost/workers/cpp/cpp-worker.js', origin: 'http://localhost', search: '' },
    postMessage: () => {},
    Worker: DisposableCompilerWorker,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    WebAssembly,
    BigInt,
    Map,
    Set,
    Promise,
    JSON,
    Math,
    Date,
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    btoa: (binary: string) => Buffer.from(binary, 'binary').toString('base64'),
    atob: (encoded: string) => Buffer.from(encoded, 'base64').toString('binary'),
  });
  vm.runInContext(source, context, { filename: 'cpp-worker.js' });
  const result = await vm.runInContext(
    `(() => {
      configuredAssets = { compilerWorkerUrl: 'http://localhost/workers/cpp/cpp-compiler-worker.js' };
      return Promise.all([
        runCompilerWorkerPayload({ project: { files: [] }, args: [] }),
        runCompilerWorkerPayload({ project: { files: [] }, args: [] }),
      ]).then(() => ({
        activeCompilerWorkers: activeCompilerWorkers.size,
        pendingCompilerWorkerRequests: pendingCompilerWorkerRequests.size,
      }));
    })()`,
    context
  ) as { activeCompilerWorkers: number; pendingCompilerWorkerRequests: number };

  assertCondition(workers.length === 2, `C++ worker should create one compiler worker per compile: ${workers.length}`);
  assertCondition(workers.every((worker) => worker.terminated), 'C++ compiler workers should terminate after their compile result');
  assertCondition(
    result.activeCompilerWorkers === 0 && result.pendingCompilerWorkerRequests === 0,
    `C++ compiler worker bookkeeping should be drained after each compile: ${JSON.stringify(result)}`
  );

  const frameSource = await readFile(join(dirname(testDirectory), 'workers', 'cpp', 'cpp-compiler-frame.html'), 'utf8');
  assertCondition(
    frameSource.includes('let compilerWorker = null') &&
      frameSource.includes('function getCompilerWorker()') &&
      frameSource.includes("resetCompilerWorker(new Error('C++ compiler worker request timed out'))"),
    'C++ compiler frame should retain only the trusted compiler/toolchain worker and reset it on timeout'
  );
  const compilerWorkerSource = await readFile(join(dirname(testDirectory), 'workers', 'cpp', 'cpp-compiler-worker.js'), 'utf8');
  assertCondition(
    !compilerWorkerSource.includes('WebAssembly.instantiate') &&
      !compilerWorkerSource.includes('new WebAssembly.Instance') &&
      !compilerWorkerSource.includes('runWasi('),
    'the persistent C++ compiler worker must never instantiate or execute compiled user programs'
  );

  const clientSource = await readFile(join(dirname(testDirectory), 'packages', 'harness-browser', 'src', 'cpp-worker-client.ts'), 'utf8');
  assertCondition(
    clientSource.includes('private runInDisposableExecutionWorker<T>') &&
      clientSource.includes('this.retireExecutionWorker();') &&
      clientSource.includes("this.clearCompilerFrames(new Error('C++ compiler frame request timed out.'));"),
    'C++ browser client should retire user execution workers after every command while preserving only healthy compiler frames'
  );
}

async function testCppInheritedStdioRespectsKernelDevices(): Promise<void> {
  const source = (await readFile(join(dirname(testDirectory), 'workers', 'cpp', 'cpp-worker.js'), 'utf8')).replace(
    /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/shared\/runtime-kernel-policy\.js['"];\s*/m,
    ''
  );
  const sharedKernelPolicySource = (await readFile(join(dirname(testDirectory), 'workers', 'shared', 'runtime-kernel-policy.js'), 'utf8'))
    .replace(/^export (async )?function /gm, '$1function ');
  const context = vm.createContext({
    console,
    self: {
      location: { href: 'http://localhost/workers/cpp/cpp-worker.js', origin: 'http://localhost', search: '' },
      postMessage: () => {},
    },
    location: { href: 'http://localhost/workers/cpp/cpp-worker.js', origin: 'http://localhost', search: '' },
    postMessage: () => {},
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
  vm.runInContext(sharedKernelPolicySource, context, { filename: 'runtime-kernel-policy.js' });
  vm.runInContext(source, context, { filename: 'cpp-worker.js' });
  const result = vm.runInContext(
    `(() => {
      const restrictedDevices = new Map([
        ['/dev/stdin', { path: '/dev/stdin', readable: false, writable: false, inputDevice: '', outputDevice: '' }],
        ['/dev/stdout', { path: '/dev/stdout', readable: false, writable: false, inputDevice: '', outputDevice: '' }],
        ['/dev/stderr', { path: '/dev/stderr', readable: false, writable: false, inputDevice: '', outputDevice: '' }],
      ]);
      const restricted = new WasiProcess({ args: [], fs: new InMemoryFileSystem(), kernelDevices: restrictedDevices });
      const standalone = new WasiProcess({ args: [], fs: new InMemoryFileSystem() });
      const manyDevices = new Map(Array.from({ length: 256 }, (_, index) => {
        const path = '/dev/custom-' + index;
        return [path, { path, readable: false, writable: true, inputDevice: '', outputDevice: '/dev/stdout' }];
      }));
      const deviceHeavy = new WasiProcess({ args: [], fs: new InMemoryFileSystem(), kernelDevices: manyDevices });
      const originalKeys = deviceHeavy.kernelDevices.keys.bind(deviceHeavy.kernelDevices);
      let keysCalls = 0;
      deviceHeavy.kernelDevices.keys = function() {
        keysCalls += 1;
        return originalKeys();
      };
      const firstDeviceType = deviceHeavy.filetypeForPath('/dev/custom-1');
      const secondDeviceType = deviceHeavy.filetypeForPath('/dev/custom-2');
      return {
        restrictedStdin: restricted.fds.get(0),
        restrictedStdout: restricted.fds.get(1),
        restrictedStderr: restricted.fds.get(2),
        standaloneStdin: standalone.fds.get(0),
        standaloneStdout: standalone.fds.get(1),
        deviceClassificationKeysCalls: keysCalls,
        firstDeviceType,
        secondDeviceType,
      };
    })()`,
    context
  ) as {
    restrictedStdin: { readable: boolean; inputDevice: string };
    restrictedStdout: { writable: boolean; outputDevice: string };
    restrictedStderr: { writable: boolean; outputDevice: string };
    standaloneStdin: { readable: boolean; inputDevice: string };
    standaloneStdout: { writable: boolean; outputDevice: string };
    deviceClassificationKeysCalls: number;
    firstDeviceType: number;
    secondDeviceType: number;
  };

  assertCondition(
    !result.restrictedStdin.readable &&
      !result.restrictedStdin.inputDevice &&
      !result.restrictedStdout.writable &&
      !result.restrictedStdout.outputDevice &&
      !result.restrictedStderr.writable &&
      !result.restrictedStderr.outputDevice,
    `C++ inherited stdio fds should respect restrictive project device manifests: ${JSON.stringify(result)}`
  );
  assertCondition(
    result.standaloneStdin.readable &&
      result.standaloneStdin.inputDevice === '/dev/stdin' &&
      result.standaloneStdout.writable &&
      result.standaloneStdout.outputDevice === '/dev/stdout',
    `C++ standalone inherited stdio fds should keep default devices: ${JSON.stringify(result)}`
  );
  assertCondition(
    result.deviceClassificationKeysCalls === 0 &&
      result.firstDeviceType === result.secondDeviceType,
    `C++ /dev filetype classification should reuse the process known-device set: ${JSON.stringify(result)}`
  );
}

async function testCppTraceIdsDoNotExposePointers(): Promise<void> {
  const source = await readFile(join(dirname(testDirectory), 'workers', 'cpp', 'tracecode_runtime.hpp'), 'utf8');
  assertCondition(!source.includes('reinterpret_cast<std::uintptr_t>'), 'C++ trace IDs must not derive from raw pointer addresses');
  assertCondition(!source.includes('"ptr-"'), 'C++ trace IDs must not include pointer-address prefixes');
  assertCondition(
    source.includes('const std::string id = tracecode_ref_id(node);') && source.includes('reset_tracecode_object_ref_ids();'),
    'C++ trace IDs should use opaque sequential ref ids'
  );
}

async function testCppContainerLookupFindsRespectTraceBudget(): Promise<void> {
  const source = await readFile(join(dirname(testDirectory), 'workers', 'cpp', 'tracecode_runtime.hpp'), 'utf8');
  const start = source.indexOf('inline void emit_container_lookup_read_value');
  const end = source.indexOf('template <typename Container, typename Key>', start + 1);
  const helperSource = source.slice(start, end);
  assertCondition(
    helperSource.includes('if (minimal_trace_enabled() || !check_trace_budget(line)) return;') &&
      helperSource.indexOf('check_trace_budget(line)') < helperSource.indexOf('container.find(key)'),
    'C++ container lookup read instrumentation should check trace budget before the instrumentation-only find'
  );
}

async function testCppInferredNumericLiteralsRejectNonFiniteValues(): Promise<void> {
  const source = (await readFile(join(dirname(testDirectory), 'workers', 'cpp', 'cpp-worker.js'), 'utf8')).replace(
    /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/shared\/runtime-kernel-policy\.js['"];\s*/m,
    ''
  );
  const context = vm.createContext({
    console,
    self: {
      location: { href: 'http://localhost/workers/cpp/cpp-worker.js', origin: 'http://localhost', search: '' },
      postMessage: () => {},
    },
    location: { href: 'http://localhost/workers/cpp/cpp-worker.js', origin: 'http://localhost', search: '' },
    postMessage: () => {},
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
      const messages = [];
      for (const value of [Infinity, -Infinity, NaN]) {
        try {
          messages.push(toCppLiteral(value, 'auto'));
        } catch (error) {
          messages.push(error instanceof Error ? error.message : String(error));
        }
      }
      return {
        finiteAuto: toCppLiteral(1.5, 'auto'),
        finiteUnknown: toCppLiteral(7, 'UserNumber'),
        messages,
      };
    })()`,
    context
  ) as { finiteAuto: string; finiteUnknown: string; messages: string[] };

  assertCondition(result.finiteAuto === '1.5', `C++ inferred auto numeric literals should preserve finite doubles: ${JSON.stringify(result)}`);
  assertCondition(result.finiteUnknown === '7', `C++ inferred unknown-type numeric literals should preserve finite integers: ${JSON.stringify(result)}`);
  assertCondition(
    result.messages.length === 3 && result.messages.every((message) => message.includes('Expected finite numeric input')),
    `C++ inferred numeric literals should reject NaN/Infinity instead of emitting raw identifiers: ${JSON.stringify(result)}`
  );
}

async function testBulkTraceWritesAreBudgetedBeforeLoops(): Promise<void> {
  const root = dirname(testDirectory);
  const [javascriptSource, pythonSource, javaSource, csharpSinkSource, csharpHostSource, cppSource] = await Promise.all([
    readFile(join(root, 'workers', 'javascript', 'javascript-worker.js'), 'utf8'),
    readFile(join(root, 'workers', 'python', 'runtime-core.js'), 'utf8'),
    readFile(join(root, 'workers', 'java', 'src', 'tracecode', 'user', 'TraceHooks.java'), 'utf8'),
    readFile(join(root, 'runtimes', 'csharp', 'TraceCode.CSharpHost', 'RuntimeTraceSink.cs'), 'utf8'),
    readFile(join(root, 'runtimes', 'csharp', 'TraceCode.CSharpHost', 'CompilerHost.cs'), 'utf8'),
    readFile(join(root, 'workers', 'cpp', 'tracecode_runtime.hpp'), 'utf8'),
  ]);
  assertCondition(
    javascriptSource.includes('const MAX_TRACE_BULK_ACCESSES = 512') &&
      javascriptSource.includes('pendingAccessBudget(reserve = 0)') &&
      javascriptSource.includes('Math.min(__target.length, __traceRecorder.pendingAccessBudget())') &&
      javascriptSource.includes('Math.min(__args.length, __traceRecorder.pendingAccessBudget())'),
    'JavaScript bulk trace writes should cap pending access allocation before sort/reverse/push loops'
  );
  assertCondition(
    pythonSource.includes('_TRACE_MAX_BULK_ACCESSES = 512') &&
      pythonSource.includes('budget = __tracecode_pending_access_budget(frame)') &&
      pythonSource.includes('if index >= budget:') &&
      pythonSource.includes('before_values = list(target[:snapshot_budget])'),
    'Python bulk trace writes should cap pending access loops and heap snapshots before allocation'
  );
  assertCondition(
    javaSource.includes('MAX_BULK_INDEXED_WRITES = 512') &&
      javaSource.includes('bulkIndexedWriteLimit') &&
      javaSource.includes('for (int index = 0; index < limit; index++)'),
    'Java bulk trace writes should cap array write loops before walking full containers'
  );
  assertCondition(
    csharpSinkSource.includes('MaxBulkIndexedWrites = 512') &&
      csharpSinkSource.includes('BulkIndexedWriteLimit') &&
      csharpHostSource.includes('RuntimeTraceSink.BulkIndexedWriteLimit(Count)') &&
      csharpHostSource.includes('if (index >= limit)'),
    'C# bulk trace writes should cap sink and helper loops before walking full containers'
  );
  assertCondition(
    cppSource.includes('trace_bulk_index_write_limit') &&
      cppSource.includes('snapshot_values(std::size_t limit)') &&
      cppSource.includes('out.size() < limit') &&
      cppSource.includes('for (std::size_t index = 0; index < limit; ++index)'),
    'C++ bulk trace writes should cap priority queue snapshots and write loops before walking full containers'
  );
}

async function testSharedKernelPolicyRefreshesMutableDeviceManifests(): Promise<void> {
  const source = await readFile(join(dirname(testDirectory), 'workers', 'shared', 'runtime-kernel-policy.js'), 'utf8');
  assertCondition(
    !source.includes('normalizedDeviceInfoCache') &&
      !source.includes('normalizedKnownDeviceCache'),
    'shared kernel policy should not cache mutable device manifests by object identity'
  );
  assertCondition(
    source.includes('runtimeKernelDeviceEntryKind(devices, value, entries = normalizedDeviceInfos(devices))') &&
      source.includes('runtimeKernelDeviceDirEntries(devices, path, entries)') &&
      source.includes('new Set(deviceEntries.keys())'),
    'shared kernel policy should reuse normalized device entries during /dev classification'
  );
  assertCondition(
    source.includes('normalized === path || normalized === root || normalized.startsWith(`${root}/`)'),
    'shared kernel policy should treat kernel virtual manifest ancestor roots as read-only'
  );
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

async function testKernelObservedFileSystemLiveFileChangesAreBudgeted(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'chunk.txt', contents: 'x'.repeat(1024 * 1024) }],
  });

  try {
    const oversizedEvents: RuntimeCommandEvent[] = [];
    const oversized = await workspace.runCommand([
      'cat chunk.txt chunk.txt chunk.txt chunk.txt chunk.txt > too-large.txt',
      'printf "ok\\n" > small.txt',
    ].join(' && '), { onEvent: (event) => oversizedEvents.push(event) });
    assertCondition(oversized.exitCode === 0, `oversized live write command should complete: ${JSON.stringify(oversized)}`);
    assertCondition((await workspace.stat('too-large.txt')).size === 5 * 1024 * 1024, 'oversized live write should persist without streaming its contents');
    assertCondition(
      !oversizedEvents.some((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change.path === 'too-large.txt' &&
        'contents' in event.change &&
        event.change.contents !== ''
      ),
      `oversized live file contents should be dropped before reading the payload: ${JSON.stringify(oversizedEvents)}`
    );
    assertCondition(
      oversizedEvents.some((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change.path === 'small.txt' &&
        event.change.contents === 'ok\n'
      ),
      `small live file-change should still stream after an oversized write is skipped: ${JSON.stringify(oversizedEvents)}`
    );

    const growthEvents: RuntimeCommandEvent[] = [];
    const growth = await workspace.runCommand(
      Array.from({ length: 8 }, () => 'cat chunk.txt >> grow.txt').join(' && '),
      { onEvent: (event) => growthEvents.push(event) }
    );
    assertCondition(growth.exitCode === 0, `growing live write command should complete: ${JSON.stringify(growth)}`);
    assertCondition((await workspace.stat('grow.txt')).size === 8 * 1024 * 1024, 'growing live write should persist the full file');
    const growSnapshots = growthEvents.filter((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'grow.txt' &&
      'contents' in event.change
    );
    assertCondition(
      growSnapshots.length > 0 && growSnapshots.length < 8,
      `growing live file snapshots should stop once the cumulative budget is exhausted: ${JSON.stringify(growthEvents)}`
    );
  } finally {
    workspace.dispose();
  }
}

async function testRuntimeWorkspaceStorageQuotasAreAtomic(): Promise<void> {
  const defaults = normalizeRuntimeWorkspaceStorageLimits(undefined);
  assertCondition(
    defaults.maxWorkspaceBytes === RUNTIME_WORKSPACE_DEFAULT_MAX_BYTES &&
      defaults.maxFileBytes === RUNTIME_WORKSPACE_DEFAULT_MAX_FILE_BYTES &&
      defaults.maxEntryCount === RUNTIME_WORKSPACE_DEFAULT_MAX_ENTRY_COUNT,
    `workspace storage defaults should remain bounded: ${JSON.stringify(defaults)}`
  );
  const overrides = normalizeRuntimeWorkspaceStorageLimits({
    maxWorkspaceBytes: 123,
    maxFileBytes: 45,
    maxEntryCount: 6,
  });
  assertCondition(
    overrides.maxWorkspaceBytes === 123 && overrides.maxFileBytes === 45 && overrides.maxEntryCount === 6,
    `workspace storage limits should accept consumer-owned overrides: ${JSON.stringify(overrides)}`
  );

  const seededError = await rejectedMessage(() => createRuntimeWorkspace({
    storageLimits: { maxWorkspaceBytes: 8, maxFileBytes: 2, maxEntryCount: 10 },
    files: [{ path: 'oversized.txt', contents: 'abc' }],
  }));
  assertCondition(seededError.includes('EFBIG'), `seed hydration should enforce per-file storage limits: ${seededError}`);

  const bytesWorkspace = await createRuntimeWorkspace({
    storageLimits: { maxWorkspaceBytes: 8, maxFileBytes: 5, maxEntryCount: 10 },
    files: [{ path: 'stable.txt', contents: '1234' }],
  });
  try {
    const oversized = await rejectedMessage(() => bytesWorkspace.writeFile('stable.txt', '123456'));
    assertCondition(oversized.includes('EFBIG'), `direct overwrites should enforce per-file limits: ${oversized}`);
    assertCondition(
      await bytesWorkspace.readFile('stable.txt') === '1234',
      'a rejected oversized overwrite must leave the previous file unchanged'
    );

    await bytesWorkspace.writeFile('other.txt', 'abcd');
    const aggregate = await rejectedMessage(() => bytesWorkspace.appendFile('other.txt', 'e'));
    assertCondition(aggregate.includes('ENOSPC'), `append should enforce aggregate workspace bytes: ${aggregate}`);
    assertCondition(
      await bytesWorkspace.readFile('other.txt') === 'abcd',
      'a rejected aggregate append must leave the previous file unchanged'
    );
  } finally {
    bytesWorkspace.dispose();
  }

  const entryWorkspace = await createRuntimeWorkspace({
    storageLimits: { maxWorkspaceBytes: 100, maxFileBytes: 100, maxEntryCount: 2 },
  });
  try {
    await entryWorkspace.writeFile('nested/one.txt', '1');
    const entries = await rejectedMessage(() => entryWorkspace.writeFile('two.txt', '2'));
    assertCondition(entries.includes('ENOSPC'), `implicit directories should count toward the path limit: ${entries}`);
    assertCondition(!(await entryWorkspace.exists('two.txt')), 'a rejected entry-count write must not create its target');
  } finally {
    entryWorkspace.dispose();
  }

  const copyWorkspace = await createRuntimeWorkspace({
    storageLimits: { maxWorkspaceBytes: 5, maxFileBytes: 5, maxEntryCount: 20 },
    files: [{ path: 'source.txt', contents: 'abc' }],
  });
  try {
    const copy = await rejectedMessage(() => copyWorkspace.copyFile('source.txt', 'copy.txt'));
    assertCondition(copy.includes('ENOSPC'), `copy should reserve aggregate bytes before mutation: ${copy}`);
    assertCondition(!(await copyWorkspace.exists('copy.txt')), 'a rejected copy must not create its destination');

    const hardlink = await copyWorkspace.runCommand('ln source.txt linked.txt');
    assertCondition(hardlink.exitCode !== 0, `hard links should enforce logical aggregate bytes: ${JSON.stringify(hardlink)}`);
    assertCondition(!(await copyWorkspace.exists('linked.txt')), 'a rejected hard link must not create its destination');
  } finally {
    copyWorkspace.dispose();
  }

  const symlinkWorkspace = await createRuntimeWorkspace({
    storageLimits: { maxWorkspaceBytes: 20, maxFileBytes: 10, maxEntryCount: 20 },
    files: [{ path: 'target.txt', contents: 'ab' }],
  });
  try {
    const first = await symlinkWorkspace.runCommand('ln -s target.txt alias');
    assertCondition(first.exitCode === 0, `a symlink target within quota should succeed: ${JSON.stringify(first)}`);
    await symlinkWorkspace.writeFile('alias', '12345');
    await symlinkWorkspace.appendFile('alias', '67890');
    assertCondition(
      await symlinkWorkspace.readFile('alias') === '1234567890' &&
        await symlinkWorkspace.readFile('target.txt') === 'ab',
      'writes and appends to a final symlink path should mirror InMemoryFs replacement semantics without changing its old target'
    );
    const oversizedAlias = await rejectedMessage(() => symlinkWorkspace.appendFile('alias', '!'));
    assertCondition(oversizedAlias.includes('EFBIG'), `symlink replacement should retain exact per-file accounting: ${oversizedAlias}`);
    assertCondition(
      await symlinkWorkspace.readFile('alias') === '1234567890',
      'a rejected append to a former symlink path must leave its replacement file unchanged'
    );

    const second = await symlinkWorkspace.runCommand('ln -s target.txt alias-2');
    assertCondition(second.exitCode !== 0, `symlink target storage should count toward aggregate bytes: ${JSON.stringify(second)}`);
    assertCondition(!(await symlinkWorkspace.exists('alias-2')), 'a rejected symlink must not create its path');
  } finally {
    symlinkWorkspace.dispose();
  }

  const hardlinkWorkspace = await createRuntimeWorkspace({
    storageLimits: { maxWorkspaceBytes: 8, maxFileBytes: 6, maxEntryCount: 20 },
    files: [{ path: 'source.txt', contents: 'abc' }],
  });
  try {
    const linked = await hardlinkWorkspace.runCommand('ln source.txt hard.txt');
    assertCondition(linked.exitCode === 0, `a within-quota hard link should succeed: ${JSON.stringify(linked)}`);
    await hardlinkWorkspace.writeFile('hard.txt', '12345');
    assertCondition(
      await hardlinkWorkspace.readFile('source.txt') === 'abc' && await hardlinkWorkspace.readFile('hard.txt') === '12345',
      'hard-link paths should follow InMemoryFs copy-on-write accounting'
    );
    const rejectedAppend = await rejectedMessage(() => hardlinkWorkspace.appendFile('hard.txt', 'x'));
    assertCondition(rejectedAppend.includes('ENOSPC'), `hard-link replacement growth should enforce aggregate bytes: ${rejectedAppend}`);
    assertCondition(
      await hardlinkWorkspace.readFile('source.txt') === 'abc' && await hardlinkWorkspace.readFile('hard.txt') === '12345',
      'a rejected hard-link-path append must leave both logical entries unchanged'
    );
  } finally {
    hardlinkWorkspace.dispose();
  }

  const overwriteWorkspace = await createRuntimeWorkspace({
    storageLimits: { maxWorkspaceBytes: 8, maxFileBytes: 5, maxEntryCount: 20 },
    files: [
      { path: 'source.txt', contents: 'abc' },
      { path: 'destination.txt', contents: '12' },
    ],
  });
  try {
    await overwriteWorkspace.copyFile('source.txt', 'destination.txt');
    assertCondition(
      await overwriteWorkspace.readFile('destination.txt') === 'abc',
      'copy overwrite should replace rather than double-count destination bytes'
    );
    await overwriteWorkspace.moveFile('source.txt', 'destination.txt');
    assertCondition(
      !(await overwriteWorkspace.exists('source.txt')) && await overwriteWorkspace.readFile('destination.txt') === 'abc',
      'move overwrite should remove source bytes and retain one destination entry'
    );
    await overwriteWorkspace.appendFile('deep/nested/new.txt', '12345');
    assertCondition(
      await overwriteWorkspace.readFile('deep/nested/new.txt') === '12345',
      'append-to-create should still create missing parents after direct mkdir calls were removed'
    );
    const rejectedNested = await rejectedMessage(() => overwriteWorkspace.copyFile('destination.txt', 'other/copy.txt'));
    assertCondition(rejectedNested.includes('ENOSPC'), `nested copy should reserve parents and bytes before mutation: ${rejectedNested}`);
    assertCondition(
      !(await overwriteWorkspace.exists('other')) && !(await overwriteWorkspace.exists('other/copy.txt')),
      'a rejected nested copy must not create destination parents'
    );
  } finally {
    overwriteWorkspace.dispose();
  }

  const rejectedOverwriteWorkspace = await createRuntimeWorkspace({
    storageLimits: { maxWorkspaceBytes: 6, maxFileBytes: 5, maxEntryCount: 20 },
    files: [
      { path: 'source.txt', contents: '1234' },
      { path: 'destination.txt', contents: 'x' },
    ],
  });
  try {
    const rejectedCopy = await rejectedMessage(() =>
      rejectedOverwriteWorkspace.copyFile('source.txt', 'destination.txt')
    );
    assertCondition(rejectedCopy.includes('ENOSPC'), `copy overwrite should project replacement bytes: ${rejectedCopy}`);
    assertCondition(
      await rejectedOverwriteWorkspace.readFile('source.txt') === '1234' &&
        await rejectedOverwriteWorkspace.readFile('destination.txt') === 'x',
      'a rejected copy overwrite must preserve both source and destination'
    );
  } finally {
    rejectedOverwriteWorkspace.dispose();
  }

  const rejectedMoveWorkspace = await createRuntimeWorkspace({
    storageLimits: { maxWorkspaceBytes: 10, maxFileBytes: 10, maxEntryCount: 2 },
    files: [
      { path: 'source.txt', contents: 'source' },
      { path: 'keep.txt', contents: 'keep' },
    ],
  });
  try {
    const rejectedMove = await rejectedMessage(() =>
      rejectedMoveWorkspace.moveFile('source.txt', 'nested/destination.txt')
    );
    assertCondition(rejectedMove.includes('ENOSPC'), `move should project missing destination parents: ${rejectedMove}`);
    assertCondition(
      await rejectedMoveWorkspace.readFile('source.txt') === 'source' &&
        await rejectedMoveWorkspace.readFile('keep.txt') === 'keep' &&
        !(await rejectedMoveWorkspace.exists('nested')),
      'a rejected move must preserve its source and avoid creating destination parents'
    );
  } finally {
    rejectedMoveWorkspace.dispose();
  }

  const shellWorkspace = await createRuntimeWorkspace({
    storageLimits: { maxWorkspaceBytes: 4, maxFileBytes: 4, maxEntryCount: 20 },
  });
  try {
    const shell = await shellWorkspace.runCommand('printf 12345 > shell.txt');
    assertCondition(shell.exitCode !== 0, `shell writes should cross the same storage boundary: ${JSON.stringify(shell)}`);
    assertCondition(
      await shellWorkspace.exists('shell.txt') && await shellWorkspace.readFile('shell.txt') === '',
      'a rejected redirected write should preserve the preceding create/truncate without persisting over-quota bytes'
    );
  } finally {
    shellWorkspace.dispose();
  }

  const rejectedFinalDiffWorkspace = await createRuntimeWorkspace({
    storageLimits: { maxWorkspaceBytes: 5, maxFileBytes: 5, maxEntryCount: 20 },
    files: [
      { path: 'runner.js', contents: 'r' },
      { path: 'keep.txt', contents: 'ok' },
    ],
    nodeRunner: async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      files: [
        { path: 'one.txt', contents: '12' },
        { path: 'two.txt', contents: '34' },
      ],
    }),
  });
  try {
    const result = await rejectedFinalDiffWorkspace.runCommand('node runner.js');
    assertCondition(
      result.exitCode === 28 && result.error?.code === 'ENOSPC',
      `final-diff quota rejection should be a structured command failure: ${JSON.stringify(result)}`
    );
    assertCondition(
      !(await rejectedFinalDiffWorkspace.exists('one.txt')) &&
        !(await rejectedFinalDiffWorkspace.exists('two.txt')) &&
        await rejectedFinalDiffWorkspace.readFile('keep.txt') === 'ok',
      'a rejected final-diff transaction must leave the workspace unchanged'
    );
  } finally {
    rejectedFinalDiffWorkspace.dispose();
  }

  const netFinalDiffWorkspace = await createRuntimeWorkspace({
    storageLimits: { maxWorkspaceBytes: 5, maxFileBytes: 4, maxEntryCount: 20 },
    files: [
      { path: 'runner.js', contents: 'r' },
      { path: 'old.txt', contents: '1234' },
    ],
    nodeRunner: async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      files: [
        { path: 'old.txt', deleted: true },
        { path: 'new.txt', contents: 'abcd' },
      ],
    }),
  });
  try {
    const result = await netFinalDiffWorkspace.runCommand('node runner.js');
    assertCondition(result.exitCode === 0, `a deletion-first within-quota final diff should commit: ${JSON.stringify(result)}`);
    assertCondition(
      await netFinalDiffWorkspace.readFile('new.txt') === 'abcd' && !(await netFinalDiffWorkspace.exists('old.txt')),
      'a within-quota net final diff should commit all changes'
    );
  } finally {
    netFinalDiffWorkspace.dispose();
  }

  const transientFinalDiffWorkspace = await createRuntimeWorkspace({
    storageLimits: { maxWorkspaceBytes: 5, maxFileBytes: 4, maxEntryCount: 20 },
    files: [
      { path: 'runner.js', contents: 'r' },
      { path: 'old.txt', contents: '1234' },
    ],
    nodeRunner: async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      files: [
        { path: 'new.txt', contents: 'abcd' },
        { path: 'old.txt', deleted: true },
      ],
    }),
  });
  try {
    const result = await transientFinalDiffWorkspace.runCommand('node runner.js');
    assertCondition(
      result.exitCode === 28 && result.error?.code === 'ENOSPC',
      `final-diff preflight should reject an over-quota mutation prefix before applying it: ${JSON.stringify(result)}`
    );
    assertCondition(
      await transientFinalDiffWorkspace.readFile('old.txt') === '1234' &&
        !(await transientFinalDiffWorkspace.exists('new.txt')),
      'a rejected transient-overage final diff must leave its original state unchanged'
    );
  } finally {
    transientFinalDiffWorkspace.dispose();
  }
}

async function testTraceKernelTraversalSkipsSymlinkCycles(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'loop/value.txt', contents: 'value\n' }],
    directories: ['loop/empty'],
  });
  try {
    const privateFs = (workspace as unknown as {
      bash: { fs: { symlink(target: string, linkPath: string): Promise<void> } };
    }).bash.fs;
    await privateFs.symlink('/workspace/loop', '/workspace/loop/self');

    const snapshot = await workspace.snapshot();
    assertCondition(
      snapshot.files.some((file) => file.path === 'loop/value.txt') &&
        !snapshot.files.some((file) => file.path.startsWith('loop/self/')) &&
        !snapshot.directories?.some((directory) => directory.startsWith('loop/self')),
      `workspace snapshots should not follow symlink cycles: ${JSON.stringify(snapshot)}`
    );

    const result = await workspace.runCommand('ls -RF loop');
    assertCondition(result.exitCode === 0, `recursive ls symlink-cycle test should finish: ${JSON.stringify(result)}`);
    assertCondition(
      result.stdout.includes('self@') && !result.stdout.includes('loop/self:'),
      `recursive ls should list symlinks without traversing them: ${result.stdout}`
    );
  } finally {
    workspace.dispose();
  }

  const unchangedWorkspace = await createRuntimeWorkspace({
    files: [
      { path: 'runner.js', contents: 'console.log("runner")\n' },
      { path: 'tree/kept.txt', contents: 'kept\n' },
    ],
    nodeRunner: async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      files: [{ path: 'tree', directory: true, deleted: true }],
    }),
  });
  try {
    const result = await unchangedWorkspace.runCommand('node runner.js');
    assertCondition(
      result.exitCode === 116 &&
        result.error?.code === 'ESTALE',
      `directory final-diff tombstone should reject unchanged omitted descendants: ${JSON.stringify(result)}`
    );
    assertCondition(
      await unchangedWorkspace.readFile('tree/kept.txt') === 'kept\n',
      'rejected unchanged directory final-diff tombstone should not delete descendants'
    );
  } finally {
    unchangedWorkspace.dispose();
  }
}

async function testTraceKernelFinalDiffDirectoryDeletesRejectStaleDescendants(): Promise<void> {
  let releaseCommand!: () => void;
  const commandReleased = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  let commandStarted!: () => void;
  const commandStartedPromise = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'runner.js', contents: 'console.log("runner")\n' },
      { path: 'tree/kept.txt', contents: 'kept\n' },
    ],
    nodeRunner: async () => {
      commandStarted();
      await commandReleased;
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        files: [{ path: 'tree', directory: true, deleted: true }],
      };
    },
  });
  try {
    const command = workspace.runCommand('node runner.js');
    await commandStartedPromise;
    await workspace.writeFile('tree/new-child.txt', 'new\n');
    releaseCommand();
    const result = await command;
    assertCondition(
      result.exitCode === 116 &&
        result.error?.code === 'ESTALE',
      `directory final-diff tombstone should reject stale omitted descendants: ${JSON.stringify(result)}`
    );
    assertCondition(
      await workspace.readFile('tree/kept.txt') === 'kept\n' &&
        await workspace.readFile('tree/new-child.txt') === 'new\n',
      'rejected stale directory final-diff tombstone should not delete descendants'
    );
  } finally {
    workspace.dispose();
  }
}

async function testTraceKernelProjectCommandStepsAreBounded(): Promise<void> {
  const message = await rejectedMessage(async () => {
    const workspace = await createRuntimeWorkspace({
      nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true, timeoutMs: 1000 }),
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
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true, timeoutMs: 1000 }),
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
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true, timeoutMs: 1000 }),
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

async function testTraceKernelPublicProcInfoIsRedacted(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    kernel: {
      user: { id: 'auth-user-123', username: 'obi', home: '/home/obi' },
      host: { hostname: 'private-host', osName: 'darwin' },
      workspace: {
        id: 'private-workspace-id',
        name: 'weather-api',
        root: '/home/obi/weather-api',
        startedAt: '2026-06-03T05:00:00.000Z',
      },
      workspaceAlias: '/workspace',
    },
  });

  try {
    const privileged = JSON.parse(await workspace.kernel.readFile('/proc/kernel/info')) as {
      user: { username: string };
      workspaceRoot: string;
    };
    assertCondition(privileged.user.username === 'obi', 'privileged kernel reads should retain configured user metadata');
    assertCondition(privileged.workspaceRoot === '/home/obi/weather-api', 'privileged kernel reads should retain canonical workspace root');

    const publicInfoText = await workspace.readFile('/proc/kernel/info');
    const publicInfo = JSON.parse(publicInfoText) as {
      user: { username: string };
      host: { hostname: string };
      workspace: { id: string; root: string };
      workspaceRoot: string;
    };
    assertCondition(
      publicInfo.user.username === 'user' &&
        publicInfo.host.hostname === 'tracevm' &&
        publicInfo.workspace.id === 'workspace' &&
        publicInfo.workspace.root === '/workspace' &&
        publicInfo.workspaceRoot === '/workspace',
      `public /proc info should be redacted: ${publicInfoText}`
    );
    assertCondition(
      !publicInfoText.includes('obi') &&
        !publicInfoText.includes('private-host') &&
        !publicInfoText.includes('/home/obi/weather-api'),
      `public /proc info should not expose configured identity: ${publicInfoText}`
    );

    const shellResult = await workspace.runCommand('cat /proc/kernel/info');
    assertCondition(shellResult.exitCode === 0, `shell /proc read should succeed: ${JSON.stringify(shellResult)}`);
    assertCondition(
      shellResult.stdout.includes('"workspaceRoot": "/workspace"') &&
        !shellResult.stdout.includes('/home/obi/weather-api'),
      `shell /proc read should use public kernel identity: ${shellResult.stdout}`
    );

    const snapshot = await workspace.snapshot();
    const snapshotProcInfo = snapshot.kernelFiles?.find((file) => file.path === '/proc/kernel/info');
    assertCondition(snapshot.kernel?.workspaceRoot === '/workspace', `snapshot kernel info should be public: ${JSON.stringify(snapshot.kernel)}`);
    assertCondition(
      snapshotProcInfo !== undefined &&
        JSON.parse(snapshotProcInfo.contents).workspaceRoot === '/workspace' &&
        !snapshotProcInfo.contents.includes('/home/obi/weather-api'),
      `snapshot proc files should be public: ${JSON.stringify(snapshotProcInfo)}`
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

async function testTraceKernelWildcardHttpDoesNotCatchExternalHosts(): Promise<void> {
  const workspace = await createRuntimeWorkspace();
  let seenUrl = '';
  const listener = workspace.http.listen({ port: 3658 }, (request) => {
    seenUrl = request.url;
    return { status: 200, body: 'wildcard\n' };
  });
  try {
    const localResponse = await workspace.http.request({ url: 'http://localhost:3658/local' });
    assertCondition(localResponse.status === 200, `local request should reach wildcard listener: ${JSON.stringify(localResponse)}`);
    assertCondition(localResponse.body === 'wildcard\n', `local wildcard body mismatch: ${JSON.stringify(localResponse)}`);

    const externalResponse = await workspace.http.request({ url: 'http://api.example.com:3658/secret?token=abc' });
    assertCondition(
      externalResponse.status === 0 && externalResponse.error?.code === 'ENOTFOUND',
      `external host should not be captured by wildcard listener: ${JSON.stringify(externalResponse)}`
    );
    assertCondition(
      seenUrl === 'http://localhost:3658/local',
      `wildcard listener should only observe the local request, saw ${seenUrl}`
    );
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
    const rawOnlyHeader = await workspace.http.request({
      url: 'http://localhost:3652/raw-only',
      rawHeaders: [['x-visible', 'raw-only']],
    });
    assertCondition(rawOnlyHeader.status === 200, `raw-only HTTP header request should succeed: ${JSON.stringify(rawOnlyHeader)}`);
    assertCondition(
      seenRequests.some((request) =>
        request.path === '/raw-only' &&
        request.visibleHeader === 'raw-only' &&
        request.rawHeader === 'raw-only'
      ),
      `HTTP raw-only header pairs should be preserved when headers is empty: ${JSON.stringify(seenRequests)}`
    );
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
      String(response.body ?? '').includes('invalid HTTP response status'),
      `invalid listener status should explain the rejection: ${JSON.stringify(response)}`
    );
  } finally {
    listener.close();
    workspace.dispose();
  }
}

async function testBrowserJavaScriptHttpAbortPropagatesToKernel(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true, timeoutMs: 1000 }),
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
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true, timeoutMs: 1000 }),
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
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true, timeoutMs: 1000 }),
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
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true, timeoutMs: 1000 }),
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

async function testBrowserJavaScriptWorkerAmbientAuthorityIsDenied(): Promise<void> {
  const attempted: string[] = [];
  const fakeCapabilities: Record<string, unknown> = {
    indexedDB: { open: () => attempted.push('indexedDB') },
    caches: { open: () => attempted.push('caches') },
    cookieStore: { get: () => attempted.push('cookieStore') },
    Worker: class { constructor() { attempted.push('Worker'); } },
    SharedWorker: class { constructor() { attempted.push('SharedWorker'); } },
    BroadcastChannel: class { constructor() { attempted.push('BroadcastChannel'); } },
    importScripts: () => attempted.push('importScripts'),
  };
  const restorers = Object.entries(fakeCapabilities).map(([name, value]) => ({
    name,
    value,
    restore: setTestGlobalProperty(name, value),
  }));
  try {
    const workspace = await createRuntimeWorkspace({
      nodeRunner: createBrowserJavaScriptProjectRunner({
        allowMainThreadExecution: true,
        trustedMainThreadExecution: true,
        timeoutMs: 1000,
      }),
      files: [{
        path: 'ambient-authority.js',
        contents: [
          'const probes = [',
          '  ["indexedDB", () => globalThis.indexedDB.open("tracecode")],',
          '  ["caches", () => globalThis.caches.open("tracecode")],',
          '  ["cookieStore", () => globalThis.cookieStore.get("tracecode")],',
          '  ["Worker", () => new globalThis.Worker("nested.js")],',
          '  ["SharedWorker", () => new globalThis.SharedWorker("nested.js")],',
          '  ["BroadcastChannel", () => new globalThis.BroadcastChannel("tracecode")],',
          '  ["importScripts", () => globalThis.importScripts("nested.js")],',
          '];',
          'for (const [name, probe] of probes) {',
          '  try { probe(); console.log(name + ":allowed"); }',
          '  catch (error) { console.log(name + ":" + (error.code || error.name)); }',
          '}',
          '',
        ].join('\n'),
      }],
    });
    try {
      const result = await workspace.runCommand('node ambient-authority.js');
      assertCondition(result.exitCode === 0, `ambient authority probe should finish: ${JSON.stringify(result)}`);
      assertCondition(
        result.stdout === [
          'indexedDB:ReferenceError',
          'caches:ReferenceError',
          'cookieStore:ReferenceError',
          'Worker:ReferenceError',
          'SharedWorker:ReferenceError',
          'BroadcastChannel:ReferenceError',
          'importScripts:ReferenceError',
          '',
        ].join('\n'),
        `worker ambient capabilities should fail closed: ${result.stdout}`
      );
      assertCondition(attempted.length === 0, `ambient host capabilities must not be invoked: ${attempted.join(',')}`);
    } finally {
      workspace.dispose();
    }
    for (const { name, value } of restorers) {
      assertCondition(
        (globalThis as unknown as Record<string, unknown>)[name] === value,
        `${name} should be restored after browser JavaScript execution`
      );
    }
  } finally {
    for (const { restore } of restorers.reverse()) restore();
  }
}

async function main(): Promise<void> {
  await testConcurrentCommandsKeepChainLocalContext();
  await testBackgroundJobDoesNotBlockForegroundCommands();
  await testBrowserJavaScriptMainThreadExecutionRequiresTrustedOptIn();
  await testBrowserTypeScriptDomCompilerScriptPolicy();
  await testIndexedDbKernelStorageEncryptsSnapshots();
  await testBrowserJavaScriptWorkerRejectsUserSpoofedResults();
  await testBrowserJavaScriptSharedWorkerRequiresTrustedOptIn();
  await testBrowserJavaScriptReadonlyHardlinksAreRejected();
  await testCommandFilesystemRespectsHiddenProjectFiles();
  await testDirectCppExecutableRespectsHiddenProjectFiles();
  await testKernelActorsEnforceFilesystemCapabilities();
  await testWorkspaceHydrationCannotOverwriteProtectedSessionFiles();
  await testBrowserJavaScriptHiddenFilesAreNotMounted();
  await testBrowserJavaScriptHiddenNamespaceMutationMatrix();
  await testBrowserJavaScriptVirtualTypeScriptPackageRespectsHiddenNamespace();
  await testBrowserJavaScriptFdWriteStreamsPreserveAppendSemantics();
  await testBrowserJavaScriptFileHandleStreamCloseStateIsNotSymbolForgeable();
  await testBrowserJavaScriptCpRejectsFileToRootDirectory();
  await testBrowserJavaScriptSyntaxErrorsHideRunnerInternals();
  await testBrowserJavaScriptTimeoutWaitsForLiveFileChangeQueue();
  await testJavaScriptTraceSerializationIsBounded();
  await testJavaScriptInputMaterializerAvoidsTypeNameEval();
  await testJavaScriptDestructuredIterableTracingDoesNotExhaustValues();
  await testJavaScriptInputHydrationIsBounded();
  await testNativeProjectRunnersRejectVirtualPathTraversal();
  await testCSharpWorkerRejectsKernelAndWorkspaceTraversal();
  await testCSharpWorkerProjectEventBudgets();
  await testCSharpManagedLiveSnapshotsReserveBeforeRead();
  await testCSharpWorkerInputPreflightBudgets();
  await testCSharpInputHydrationConstructorsAreBounded();
  await testNativeCSharpInputConversionPrefersStringDictionaries();
  await testCSharpBrowserRuntimeNetworkAssembliesAreDenied();
  await testJavaWorkerProjectEventBudgets();
  await testJavaWorkerCheerpJLoaderPolicyRequiresLocalAppAsset();
  await testJavaQueueAugmentationRequiresNativeBlockShape();
  testJavaHelperRunScopeAndCacheManifest();
  await testNativeJavaHostCacheUsesPrivateTempDirectory();
  await testJavaWorkerDiagnosticsAreBounded();
  testJavaTraceHeaderExpansionIsBounded();
  await testJavaWorkerTraceHeaderExpansionIsBounded();
  await testCppWorkerProjectEventBudgets();
  await testCppPinnedToolchainFetchesFailClosed();
  await testCppCompilerLifecycleSeparatesCompilationFromExecution();
  await testCppInheritedStdioRespectsKernelDevices();
  await testCppTraceIdsDoNotExposePointers();
  await testCppContainerLookupFindsRespectTraceBudget();
  await testCppInferredNumericLiteralsRejectNonFiniteValues();
  await testBulkTraceWritesAreBudgetedBeforeLoops();
  await testSharedKernelPolicyRefreshesMutableDeviceManifests();
  testRuntimeFinalDiffBudgets();
  await testKernelObservedFileSystemLiveFileChangesAreBudgeted();
  await testRuntimeWorkspaceStorageQuotasAreAtomic();
  await testTraceKernelTraversalSkipsSymlinkCycles();
  await testTraceKernelFinalDiffDirectoryDeletesRejectStaleDescendants();
  await testTraceKernelProjectCommandStepsAreBounded();
  await testTraceKernelNpmIgnoreScriptsSkipsLifecycleHooks();
  await testTraceKernelDeviceOutputAccumulationIsBounded();
  await testTraceKernelPublicProcInfoIsRedacted();
  await testTraceKernelHttpTimeoutSignalsCooperativeHandlers();
  await testTraceKernelHttpDiagnosticsAreRedacted();
  await testTraceKernelWildcardHttpDoesNotCatchExternalHosts();
  await testTraceKernelHttpListenerLimit();
  await testTraceKernelHttpRejectsMalformedInputs();
  await testTraceKernelHttpRejectsInvalidResponseStatus();
  await testBrowserJavaScriptHttpAbortPropagatesToKernel();
  await testBrowserJavaScriptHttpTimeoutPropagatesToKernel();
  await testBrowserJavaScriptHttpDestroyCompletesActiveRequest();
  await testBrowserJavaScriptGlobalFetchUsesTraceKernel();
  await testBrowserJavaScriptWorkerAmbientAuthorityIsDenied();
  console.log('tracekernel hardening tests passed');
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

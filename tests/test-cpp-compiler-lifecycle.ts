#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { CppWorkerClient } from '../packages/harness-cpp/src/cpp-worker-client';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const MINIMAL_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

interface WorkerMessage {
  id?: string;
  type: string;
  requestId?: string;
  protocolToken?: string;
  payload?: Record<string, unknown>;
}

class CompilerBridgeWorker {
  static instances: CompilerBridgeWorker[] = [];
  static nextCompileRequest = 0;

  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  poisoned = false;
  observedPoisonAtCommandStart = false;
  private pendingExecution: WorkerMessage | null = null;

  constructor(readonly url: string | URL) {
    CompilerBridgeWorker.instances.push(this);
    queueMicrotask(() => this.onmessage?.({ data: { type: 'worker-ready' } } as unknown as MessageEvent<WorkerMessage>));
  }

  postMessage(message: WorkerMessage): void {
    if (this.terminated) return;
    if (message.type === 'init') {
      queueMicrotask(() => this.onmessage?.({
        data: {
          id: message.id,
          type: 'init',
          protocolToken: message.protocolToken,
          payload: { success: true, loadTimeMs: 0 },
        },
      } as unknown as MessageEvent<WorkerMessage>));
      return;
    }

    if (message.type === 'compile-run') {
      this.observedPoisonAtCommandStart = this.poisoned;
      this.poisoned = true;
      this.pendingExecution = message;
      const requestId = `compile-${++CompilerBridgeWorker.nextCompileRequest}`;
      const code = String(message.payload?.code ?? '');
      queueMicrotask(() => this.onmessage?.({
        data: {
          type: 'compile-request',
          requestId,
          protocolToken: message.protocolToken,
          payload: {
            assets: {
              compilerBundleUrl: 'https://assets.example/cpp/bundle.js',
              toolchainIntegrity: {
                assets: [{ url: 'https://assets.example/cpp/bundle.js', sha256: 'a'.repeat(64) }],
              },
            },
            driverSource: `driver:${code}`,
            standard: 'c++23',
            stackSize: 8 * 1024 * 1024,
          },
        },
      } as unknown as MessageEvent<WorkerMessage>));
      return;
    }

    if (message.type === 'compile-response') {
      const execution = this.pendingExecution;
      this.pendingExecution = null;
      if (!execution) return;
      const compilation = (message.payload ?? {}) as { success?: boolean; error?: string; timings?: { artifactCacheHit?: boolean } };
      const success = compilation.success === true;
      queueMicrotask(() => this.onmessage?.({
        data: {
          id: execution.id,
          type: execution.type,
          protocolToken: execution.protocolToken,
          payload: success
            ? {
                success: true,
                output: compilation.timings?.artifactCacheHit === true ? 'cached' : 'compiled',
                consoleOutput: [],
                timings: compilation.timings,
              }
            : {
                success: false,
                output: null,
                error: compilation.error,
                consoleOutput: [],
              },
        },
      } as unknown as MessageEvent<WorkerMessage>));
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

function createClient(options: Partial<ConstructorParameters<typeof CppWorkerClient>[0]> = {}): CppWorkerClient {
  return new CppWorkerClient({
    workerUrl: '/workers/cpp-worker.js',
    compilerWasmUrl: '/workers/cpp/compiler/compiler.wasm',
    linkerWasmUrl: '/workers/cpp/compiler/linker.wasm',
    sysrootUrl: '/workers/vendor/cpp/sysroot.tar',
    runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
    compilerBundleUrl: '/workers/cpp/compiler/bundle.js',
    externalCompilerUrl: 'https://compiler.example/compile',
    ...options,
  });
}

async function testContentAddressedArtifactsAndDisposableExecution(): Promise<void> {
  const originalWorker = globalThis.Worker;
  const originalFetch = globalThis.fetch;
  CompilerBridgeWorker.instances = [];
  let fetchCount = 0;
  // @ts-expect-error focused Worker test double
  globalThis.Worker = CompilerBridgeWorker;
  globalThis.fetch = async (_input, init) => {
    fetchCount += 1;
    const body = JSON.parse(String(init?.body ?? '{}')) as { driverSource?: string };
    assertCondition(body.driverSource?.startsWith('driver:'), 'external compiler should receive the generated driver source');
    return new Response(MINIMAL_WASM.slice(), {
      status: 200,
      headers: {
        'content-type': 'application/wasm',
        'x-tracecode-compile-ms': '100',
      },
    });
  };

  const client = createClient();
  let standbyWorker: CompilerBridgeWorker | undefined;
  try {
    const first = await client.executeCode({ code: 'source-a', functionName: 'run', inputs: {}, executionStyle: 'function' });
    const exact = await client.executeCode({ code: 'source-a', functionName: 'run', inputs: {}, executionStyle: 'function' });
    const edited = await client.executeCode({ code: 'source-b', functionName: 'run', inputs: {}, executionStyle: 'function' });

    assertCondition(first.kind === 'completed' && first.output === 'compiled', `first source should compile: ${JSON.stringify(first)}`);
    assertCondition(exact.kind === 'completed' && exact.output === 'cached', `exact source should use the artifact cache: ${JSON.stringify(exact)}`);
    assertCondition(edited.kind === 'completed' && edited.output === 'compiled', `edited source should recompile: ${JSON.stringify(edited)}`);
    assertCondition(fetchCount === 2, `exact cache should avoid one compiler invocation while edited source recompiles: ${fetchCount}`);
    const usedWorkers = CompilerBridgeWorker.instances.filter((worker) => worker.poisoned);
    const standbyWorkers = CompilerBridgeWorker.instances.filter((worker) => !worker.poisoned);
    assertCondition(
      usedWorkers.length === 3 &&
        usedWorkers.every((worker) => worker.terminated && !worker.observedPoisonAtCommandStart),
      'execution workers must be retired after one command so worker-global state cannot poison the next command'
    );
    assertCondition(
      standbyWorkers.length === 1 && !standbyWorkers[0].terminated,
      'one clean C++ execution worker should be initialized for the next interactive command'
    );
    standbyWorker = standbyWorkers[0];
  } finally {
    const workerCountBeforeTerminate = CompilerBridgeWorker.instances.length;
    client.terminate();
    await Promise.resolve();
    assertCondition(standbyWorker?.terminated, 'client termination should retire the clean C++ standby worker');
    assertCondition(
      CompilerBridgeWorker.instances.length === workerCountBeforeTerminate,
      'an asynchronous C++ prewarm must not recreate a worker after client termination'
    );
    globalThis.fetch = originalFetch;
    globalThis.Worker = originalWorker;
  }
}

async function testInvalidArtifactsFailClosedAndAreNotCached(): Promise<void> {
  const originalWorker = globalThis.Worker;
  const originalFetch = globalThis.fetch;
  CompilerBridgeWorker.instances = [];
  let fetchCount = 0;
  // @ts-expect-error focused Worker test double
  globalThis.Worker = CompilerBridgeWorker;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
  };
  const client = createClient();
  try {
    const first = await client.executeCode({ code: 'invalid-artifact', functionName: 'run', inputs: {}, executionStyle: 'function' });
    const second = await client.executeCode({ code: 'invalid-artifact', functionName: 'run', inputs: {}, executionStyle: 'function' });
    assertCondition(
      first.kind === 'failed' && first.error.includes('invalid WebAssembly'),
      `invalid compiler artifacts should fail closed: ${JSON.stringify(first)}`
    );
    assertCondition(second.kind === 'failed', 'invalid compiler artifacts should remain rejected');
    assertCondition(fetchCount === 2, 'invalid compiler artifacts must never enter the content-addressed cache');
  } finally {
    client.terminate();
    globalThis.fetch = originalFetch;
    globalThis.Worker = originalWorker;
  }
}

async function testTerminationDuringAssetPreflightCannotRecreateWorkerAndClientRecovers(): Promise<void> {
  const originalWorker = globalThis.Worker;
  const originalFetch = globalThis.fetch;
  CompilerBridgeWorker.instances = [];
  let releaseFirstPreflight!: () => void;
  const firstPreflightReleased = new Promise<void>((resolve) => {
    releaseFirstPreflight = resolve;
  });
  let markFirstPreflightStarted!: () => void;
  const firstPreflightStarted = new Promise<void>((resolve) => {
    markFirstPreflightStarted = resolve;
  });
  let preflightCalls = 0;
  // @ts-expect-error focused Worker test double
  globalThis.Worker = CompilerBridgeWorker;
  globalThis.fetch = async () => new Response(MINIMAL_WASM.slice(), { status: 200 });
  const client = createClient({
    async assetPreflight() {
      preflightCalls += 1;
      if (preflightCalls !== 1) return;
      markFirstPreflightStarted();
      await firstPreflightReleased;
    },
  });

  try {
    const interrupted = client.executeCode({
      code: 'interrupted-preflight',
      functionName: 'run',
      inputs: {},
      executionStyle: 'function',
    });
    await firstPreflightStarted;
    client.terminate();
    releaseFirstPreflight();

    let interruptionError = '';
    try {
      await interrupted;
    } catch (error) {
      interruptionError = error instanceof Error ? error.message : String(error);
    }
    await Promise.resolve();

    assertCondition(
      interruptionError.includes('Worker was terminated'),
      `termination during asset preflight should reject the stale command: ${interruptionError}`
    );
    assertCondition(
      CompilerBridgeWorker.instances.length === 0,
      'a stale asset-preflight continuation must not create a C++ execution worker after termination'
    );

    const recovered = await client.executeCode({
      code: 'recovered-after-terminate',
      functionName: 'run',
      inputs: {},
      executionStyle: 'function',
    });
    assertCondition(
      recovered.kind === 'completed',
      `C++ terminate should release current resources without permanently disabling later commands: ${JSON.stringify(recovered)}`
    );
  } finally {
    releaseFirstPreflight();
    client.terminate();
    globalThis.fetch = originalFetch;
    globalThis.Worker = originalWorker;
  }
}

async function testTimeoutAbortsCompilerAndRetiresExecution(): Promise<void> {
  const originalWorker = globalThis.Worker;
  const originalFetch = globalThis.fetch;
  CompilerBridgeWorker.instances = [];
  let compilerAbortObserved = false;
  let fetchCount = 0;
  let resolveIgnoredAbort: ((response: Response) => void) | null = null;
  // @ts-expect-error focused Worker test double
  globalThis.Worker = CompilerBridgeWorker;
  globalThis.fetch = async (_input, init) => {
    fetchCount += 1;
    if (fetchCount > 1) return new Response(MINIMAL_WASM.slice(), { status: 200 });
    return new Promise<Response>((resolve) => {
      resolveIgnoredAbort = resolve;
      init?.signal?.addEventListener('abort', () => {
        compilerAbortObserved = true;
        // Deliberately ignore cancellation to model a non-cooperative delegate.
      }, { once: true });
    });
  };
  const client = createClient({ executionTimeoutMs: 10 });
  try {
    const result = await client.executeCode({ code: 'hang-compiler', functionName: 'run', inputs: {}, executionStyle: 'function' });
    assertCondition(result.kind === 'limit' && result.reason === 'client-timeout', `timeout should be explicit: ${JSON.stringify(result)}`);
    assertCondition(compilerAbortObserved, 'execution timeout should abort the in-flight compiler request');
    assertCondition(
      CompilerBridgeWorker.instances.length === 1 && CompilerBridgeWorker.instances[0].terminated,
      'execution timeout should terminate the user execution worker'
    );
    assertCondition(resolveIgnoredAbort, 'timeout test should retain the ignored compiler response');
    (resolveIgnoredAbort as unknown as (response: Response) => void)(new Response(MINIMAL_WASM.slice(), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const recovery = await client.executeCode({ code: 'hang-compiler', functionName: 'run', inputs: {}, executionStyle: 'function' });
    assertCondition(
      recovery.kind === 'completed' && recovery.output === 'compiled' && fetchCount === 2,
      `a late timed-out compiler response must not repopulate the artifact cache: ${JSON.stringify(recovery)}`
    );
  } finally {
    client.terminate();
    globalThis.fetch = originalFetch;
    globalThis.Worker = originalWorker;
  }
}

async function testCallerAbortResetsCompilerAndExecution(): Promise<void> {
  const originalWorker = globalThis.Worker;
  const originalFetch = globalThis.fetch;
  CompilerBridgeWorker.instances = [];
  let fetchStarted: (() => void) | null = null;
  let compilerAbortObserved = false;
  // @ts-expect-error focused Worker test double
  globalThis.Worker = CompilerBridgeWorker;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    fetchStarted?.();
    init?.signal?.addEventListener('abort', () => {
      compilerAbortObserved = true;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
  const client = createClient({ executionTimeoutMs: 30_000 });
  const controller = new AbortController();
  try {
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const execution = client.executeCode({ code: 'caller-abort', functionName: 'run', inputs: {}, executionStyle: 'function', signal: controller.signal });
    await started;
    controller.abort();
    let error: unknown;
    try {
      await execution;
    } catch (caught) {
      error = caught;
    }
    assertCondition(error instanceof Error && error.name === 'AbortError', `caller abort should reject with AbortError: ${String(error)}`);
    assertCondition(compilerAbortObserved, 'caller abort should cancel the in-flight compiler request');
    assertCondition(
      CompilerBridgeWorker.instances.length === 1 && CompilerBridgeWorker.instances[0].terminated,
      'caller abort should retire the user execution worker'
    );
  } finally {
    client.terminate();
    globalThis.fetch = originalFetch;
    globalThis.Worker = originalWorker;
  }
}

async function testCallerAbortCannotRecreateCompilerFrameAfterAsyncCacheKey(): Promise<void> {
  const originalWorker = globalThis.Worker;
  const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  CompilerBridgeWorker.instances = [];
  let digestStarted: (() => void) | null = null;
  let resolveDigest!: (digest: ArrayBuffer) => void;
  let compilerFrameCreations = 0;
  const digestPending = new Promise<ArrayBuffer>((resolve) => {
    resolveDigest = resolve;
  });
  const digestDidStart = new Promise<void>((resolve) => {
    digestStarted = resolve;
  });

  // @ts-expect-error focused Worker test double
  globalThis.Worker = CompilerBridgeWorker;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      subtle: {
        digest: async () => {
          digestStarted?.();
          return digestPending;
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: 'https://app.example/project' },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement() {
        compilerFrameCreations += 1;
        throw new Error('stale compiler continuation created an iframe');
      },
      body: { appendChild() {} },
    },
  });

  const client = createClient({
    externalCompilerUrl: undefined,
    compilerFrameUrl: 'https://app.example/workers/cpp-compiler-frame.html',
    compilerWorkerUrl: 'https://app.example/workers/cpp-compiler-worker.js',
  });
  const controller = new AbortController();
  try {
    const execution = client.executeCode({
      code: 'cache-key-race',
      functionName: 'run',
      inputs: {},
      executionStyle: 'function',
      signal: controller.signal,
    });
    await digestDidStart;
    controller.abort();
    // Per-command worker pools permanently retire the leased client when the
    // command signal fires, in addition to the client's own abort reset.
    client.terminate();
    resolveDigest(new Uint8Array(32).buffer);
    let error: unknown;
    try {
      await execution;
    } catch (caught) {
      error = caught;
    }
    await Promise.resolve();
    assertCondition(error instanceof Error && error.name === 'AbortError', `caller abort should reject with AbortError: ${String(error)}`);
    assertCondition(
      compilerFrameCreations === 0,
      'a compile request retired during asynchronous cache-key hashing must not recreate its compiler iframe'
    );
  } finally {
    client.terminate();
    globalThis.Worker = originalWorker;
    if (originalCryptoDescriptor) Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
    else delete (globalThis as { crypto?: Crypto }).crypto;
    if (originalDocumentDescriptor) Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
    else delete (globalThis as { document?: Document }).document;
    if (originalLocationDescriptor) Object.defineProperty(globalThis, 'location', originalLocationDescriptor);
    else delete (globalThis as { location?: Location }).location;
  }
}

async function testCompilerFrameKeepsOnlyTrustedCompilerWarm(): Promise<void> {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const html = await readFile(join(testDirectory, '..', 'workers', 'cpp', 'cpp-compiler-frame.html'), 'utf8');
  const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assertCondition(source, 'compiler frame module source should be present');

  const handlers = new Map<string, (event: Record<string, unknown>) => unknown>();
  const compilerWorkers: FrameCompilerWorker[] = [];
  class FrameCompilerWorker {
    onmessage: ((event: { data: WorkerMessage }) => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminated = false;
    constructor(readonly url: string) {
      compilerWorkers.push(this);
    }
    postMessage(message: WorkerMessage): void {
      queueMicrotask(() => this.onmessage?.({
        data: {
          id: message.id,
          type: 'compile-result',
          protocolToken: message.protocolToken,
          payload: { success: true, programBuffer: MINIMAL_WASM.slice().buffer },
        },
      }));
    }
    terminate(): void {
      this.terminated = true;
    }
  }

  const responses: WorkerMessage[] = [];
  const parentSource = {
    postMessage(message: WorkerMessage): void {
      responses.push(message);
    },
  };
  const context = vm.createContext({
    console,
    location: {
      href: 'https://cdn.example/cpp/compiler-frame.html?tracecodeFrameToken=frame-token&tracecodeParentOrigin=https%3A%2F%2Fapp.example&tracecodeCompilerWorkerUrl=https%3A%2F%2Fcdn.example%2Fcpp%2Fcompiler-worker.js',
      search: '?tracecodeFrameToken=frame-token&tracecodeParentOrigin=https%3A%2F%2Fapp.example&tracecodeCompilerWorkerUrl=https%3A%2F%2Fcdn.example%2Fcpp%2Fcompiler-worker.js',
      origin: 'https://cdn.example',
    },
    parent: parentSource,
    Worker: FrameCompilerWorker,
    URL,
    URLSearchParams,
    Date,
    Math,
    Promise,
    ArrayBuffer,
    Uint8Array,
    setTimeout,
    clearTimeout,
    addEventListener(type: string, handler: (event: Record<string, unknown>) => unknown) {
      handlers.set(type, handler);
    },
  });
  vm.runInContext(source, context, { filename: 'cpp-compiler-frame.html' });
  const messageHandler = handlers.get('message');
  assertCondition(messageHandler, 'compiler frame should install a message handler');

  await messageHandler({
    origin: 'https://app.example',
    source: { postMessage() {} },
    data: {
      id: 'not-parent',
      type: 'compile',
      frameToken: 'frame-token',
      protocolToken: 'protocol-not-parent',
      payload: { driverSource: 'not-parent' },
    },
  });
  assertCondition(
    compilerWorkers.length === 0,
    'compiler frame must reject same-origin messages that do not come from its parent window'
  );

  for (const id of ['one', 'two']) {
    await messageHandler({
      origin: 'https://app.example',
      source: parentSource,
      data: {
        id,
        type: 'compile',
        frameToken: 'frame-token',
        protocolToken: `protocol-${id}`,
        payload: { driverSource: id },
      },
    });
  }
  assertCondition(
    (compilerWorkers.length as number) === 1,
    `edited source should reuse one trusted compiler worker: ${compilerWorkers.length}; responses=${JSON.stringify(responses)}`
  );
  assertCondition(
    compilerWorkers[0].url === 'https://cdn.example/cpp/compiler-worker.js',
    `consumer CDN compiler worker URL should remain bound to the frame origin: ${compilerWorkers[0].url}`
  );
  assertCondition(!compilerWorkers[0].terminated, 'healthy compiler worker should stay warm between edited sources');
  assertCondition(responses.filter((message) => message.type === 'compile-result').length === 2, 'both compiles should complete');

  handlers.get('pagehide')?.({});
  assertCondition(compilerWorkers[0].terminated, 'page lifecycle teardown should terminate the trusted compiler worker');
}

async function main(): Promise<void> {
  await testContentAddressedArtifactsAndDisposableExecution();
  await testInvalidArtifactsFailClosedAndAreNotCached();
  await testTerminationDuringAssetPreflightCannotRecreateWorkerAndClientRecovers();
  await testTimeoutAbortsCompilerAndRetiresExecution();
  await testCallerAbortResetsCompilerAndExecution();
  await testCallerAbortCannotRecreateCompilerFrameAfterAsyncCacheKey();
  await testCompilerFrameKeepsOnlyTrustedCompilerWarm();
  console.log('C++ compiler lifecycle tests passed');
}

test('cpp compiler lifecycle', main);

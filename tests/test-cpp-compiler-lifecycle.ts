#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { createCppBrowserRuntimeProvider } from '../packages/runtime-cpp/src/browser-runtime-provider';
import { CppWorkerClient } from '../packages/runtime-cpp/src/cpp-worker-client';
import { createCppPreparedExecutionProvider } from '../packages/runtime-cpp/src/cpp-prepared-provider';
import { createTraceCCRuntimeManifest } from '../packages/runtime-cpp/src/tracecc-runtime-assets';

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

class PreparedProtocolWorker {
  static instances: PreparedProtocolWorker[] = [];
  static compileRequests = 0;
  static executions = 0;
  static batchExecutions = 0;
  static disposals = 0;

  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: WorkerMessage[] = [];
  terminated = false;
  private pendingPreparation: WorkerMessage | null = null;
  private preparedMode: 'code' | 'trace' | null = null;

  constructor(readonly url: string | URL) {
    PreparedProtocolWorker.instances.push(this);
    queueMicrotask(() => this.onmessage?.({
      data: { type: 'worker-ready' },
    } as unknown as MessageEvent<WorkerMessage>));
  }

  postMessage(message: WorkerMessage): void {
    if (this.terminated) return;
    this.messages.push(message);
    if (message.type === 'init') {
      queueMicrotask(() => this.reply(message, {
        success: true,
        loadTimeMs: 0,
      }));
      return;
    }
    if (message.type === 'prewarm-trusted-tracecc-assets') {
      queueMicrotask(() => this.reply(message, { success: true }));
      return;
    }
    if (message.type === 'prepare-runtime-program') {
      PreparedProtocolWorker.compileRequests += 1;
      this.pendingPreparation = message;
      this.preparedMode = message.payload?.mode === 'trace' ? 'trace' : 'code';
      queueMicrotask(() => this.onmessage?.({
        data: {
          type: 'compile-request',
          requestId: `prepared-compile-${PreparedProtocolWorker.compileRequests}`,
          protocolToken: message.protocolToken,
          payload: {
            assets: {
              compilerBundleUrl: 'https://assets.example/cpp/bundle.js',
              toolchainIntegrity: {
                assets: [{
                  url: 'https://assets.example/cpp/bundle.js',
                  sha256: 'a'.repeat(64),
                }],
              },
            },
            driverSource: `prepared:${String(message.payload?.code ?? '')}`,
            standard: 'c++23',
            stackSize: 8 * 1024 * 1024,
          },
        },
      } as unknown as MessageEvent<WorkerMessage>));
      return;
    }
    if (message.type === 'compile-response') {
      const preparation = this.pendingPreparation;
      this.pendingPreparation = null;
      if (!preparation) return;
      const compilation = message.payload ?? {};
      queueMicrotask(() => this.reply(preparation, compilation.success === true
        ? {
            success: true,
            programId: 'prepared-1',
            mode: this.preparedMode,
            consoleOutput: [],
            timings: compilation.timings,
          }
        : {
            success: false,
            error: String(compilation.error ?? 'compile failed'),
            consoleOutput: [],
          }));
      return;
    }
    if (message.type === 'execute-prepared-runtime-program') {
      PreparedProtocolWorker.executions += 1;
      if (message.payload?.inputs && (message.payload.inputs as { hang?: unknown }).hang === true) {
        return;
      }
      if (message.payload?.mode !== this.preparedMode) {
        queueMicrotask(() => this.onmessage?.({
          data: {
            id: message.id,
            type: 'error',
            protocolToken: message.protocolToken,
            payload: {
              error: `C++ prepared program "prepared-1" was prepared for ${this.preparedMode}, not ${String(message.payload?.mode)}.`,
            },
          },
        } as unknown as MessageEvent<WorkerMessage>));
        return;
      }
      const value = Number((message.payload?.inputs as { value?: unknown } | undefined)?.value ?? 0);
      queueMicrotask(() => this.reply(message, this.preparedMode === 'trace'
        ? {
            success: true,
            output: value,
            trace: {
              schemaVersion: 'runtime-trace-2026-04-28',
              language: 'cpp',
              runId: 'prepared:test',
              events: [{ kind: 'line', runId: 'prepared:test', line: 1 }],
              lineEventCount: 1,
              traceStepCount: 1,
            },
            executionTimeMs: 1,
            consoleOutput: [],
            timings: {
              compileMs: 0,
              wasmCompileMs: 0,
              runMs: 1,
              artifactCacheHit: true,
              compileCacheHit: true,
            },
          }
        : {
            success: true,
            output: value,
            executionTimeMs: 1,
            consoleOutput: [],
            timings: {
              compileMs: 0,
              wasmCompileMs: 0,
              runMs: 1,
              artifactCacheHit: true,
              compileCacheHit: true,
            },
          }));
      return;
    }
    if (message.type === 'execute-prepared-runtime-program-batch') {
      PreparedProtocolWorker.batchExecutions += 1;
      const inputBatch = Array.isArray(message.payload?.inputBatch)
        ? message.payload.inputBatch as Array<{ value?: unknown; hang?: unknown }>
        : [];
      queueMicrotask(() => {
        for (let caseIndex = 0; caseIndex < inputBatch.length; caseIndex += 1) {
          const inputs = inputBatch[caseIndex]!;
          if (inputs.hang === true) return;
          const result = {
            success: true,
            output: Number(inputs.value ?? 0),
            executionTimeMs: 1,
            consoleOutput: [],
            timings: {
              compileMs: 0,
              wasmCompileMs: 0,
              runMs: 1,
              artifactCacheHit: true,
              compileCacheHit: true,
            },
          };
          this.onmessage?.({
            data: {
              id: message.id,
              type: 'runtime-progress',
              protocolToken: message.protocolToken,
              payload: {
                stage: 'prepared-code-case-complete',
                detail: { caseIndex, caseCount: inputBatch.length, result },
              },
            },
          } as unknown as MessageEvent<WorkerMessage>);
        }
        this.reply(message, {
          success: true,
          resultCount: inputBatch.length,
        });
      });
      return;
    }
    if (message.type === 'dispose-prepared-runtime-program') {
      PreparedProtocolWorker.disposals += 1;
      queueMicrotask(() => this.reply(message, { success: true }));
    }
  }

  private reply(message: WorkerMessage, payload: Record<string, unknown>): void {
    this.onmessage?.({
      data: {
        id: message.id,
        type: message.type,
        protocolToken: message.protocolToken,
        payload,
      },
    } as unknown as MessageEvent<WorkerMessage>);
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

async function testBrowserProviderPreparedLeaseExposure(): Promise<void> {
  const lease = createCppBrowserRuntimeProvider().create({
    assets: {
      cppWorker: '/workers/cpp-worker.js',
      cppCompilerFrame: '/workers/cpp-compiler-frame.html',
      cppCompilerWorker: '/workers/cpp-compiler-worker.js',
      cppCompilerWasm: '/workers/cpp/compiler/compiler.wasm',
      cppLinkerWasm: '/workers/cpp/compiler/linker.wasm',
      cppSysroot: '/workers/vendor/cpp/sysroot.tar',
      cppRuntimeHeader: '/workers/cpp/tracecode_runtime.hpp',
      cppCompilerBundle: '/workers/cpp/compiler/bundle.js',
      cppCompilerIntegrity: {
        assets: [{
          url: '/workers/cpp/compiler/bundle.js',
          size: 1,
          sha256: 'a'.repeat(64),
        }],
      },
      runtimeManifests: {
        cpp: createTraceCCRuntimeManifest('/workers/cpp/tracecc'),
      },
    } as never,
    debug: false,
    prewarmAfterUse: true,
    workerFactoryFor: () => undefined,
    preflight: () => async () => undefined,
    manifestAsset: () => undefined,
    manifestAssetCollection: () => undefined,
  } as never);
  try {
    assertCondition(
      lease.preparedProviders?.get('cpp') !== undefined,
      'C++ browser runtime leases should expose an explicit prepared-provider map'
    );
    assertCondition(
      !('clients' in lease),
      'C++ browser runtime leases must not expose a direct client map'
    );
  } finally {
    lease.dispose();
  }
}

async function testBrowserProviderDefersCompilerWarmupUntilPreparation(): Promise<void> {
  const originalWorker = globalThis.Worker;
  const originalRequestIdleCallback = globalThis.requestIdleCallback;
  const originalCancelIdleCallback = globalThis.cancelIdleCallback;
  PreparedProtocolWorker.instances = [];
  const executedPreflights: string[][] = [];
  let idleCallback: IdleRequestCallback | null = null;
  // @ts-expect-error focused Worker test double
  globalThis.Worker = PreparedProtocolWorker;
  globalThis.requestIdleCallback = (callback) => {
    idleCallback = callback;
    return 1;
  };
  globalThis.cancelIdleCallback = () => undefined;
  const lease = createCppBrowserRuntimeProvider().create({
    assets: {
      cppWorker: '/workers/cpp-worker.js',
      cppCompilerFrame: '/workers/cpp-compiler-frame.html',
      cppCompilerWorker: '/workers/cpp-compiler-worker.js',
      cppCompilerWasm: '/workers/cpp/tracecc/tracecc-reactor.wasm',
      cppLinkerWasm: '/workers/cpp/tracecc/tracecc-reactor.wasm',
      cppSysroot: '/workers/cpp/tracecc/llvm-resources.tar',
      cppRuntimeHeader: '/workers/cpp/tracecc/tracecode_runtime.hpp',
      cppCompilerBundle: '',
      cppCompilerIntegrity: { assets: [] },
      runtimeManifests: {
        cpp: createTraceCCRuntimeManifest('/workers/cpp/tracecc'),
      },
    } as never,
    debug: false,
    prewarmAfterUse: false,
    workerFactoryFor: () => undefined,
    preflight: (_language: string, assetNames: readonly string[]) => async () => {
      executedPreflights.push([...assetNames]);
    },
    manifestAsset: () => undefined,
    manifestAssetCollection: () => undefined,
  } as never);
  try {
    const provider = lease.preparedProviders?.get('cpp');
    assertCondition(provider, 'C++ prepared provider should be registered');
    const result = await provider.init();
    assertCondition(result.success, `C++ standby initialization failed: ${JSON.stringify(result)}`);
    assertCondition(idleCallback, 'entering a C++ surface should queue compiler warmup at browser idle');
    assertCondition(
      PreparedProtocolWorker.instances.length === 1 &&
        !String(PreparedProtocolWorker.instances[0]?.url).includes('traceccRole=compiler'),
      `entering a C++ surface must not start the compiler Worker: ${PreparedProtocolWorker.instances.map((worker) => worker.url)}`
    );
    assertCondition(
      executedPreflights.length === 0,
      `entering a C++ surface must not fetch runtime bytes in the page realm: ${JSON.stringify(executedPreflights)}`
    );
    const queuedIdleCallback = idleCallback as unknown as IdleRequestCallback;
    queuedIdleCallback({
      didTimeout: false,
      timeRemaining: () => 50,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const compilerWorker = PreparedProtocolWorker.instances.find((worker) =>
      String(worker.url).includes('traceccRole=compiler')
    );
    assertCondition(
      compilerWorker,
      `idle compiler asset prewarm must start the trusted compiler Worker: ${PreparedProtocolWorker.instances.map((worker) => worker.url)}`
    );
    assertCondition(
      compilerWorker.messages?.some((message) =>
        message.type === 'prewarm-trusted-tracecc-assets' &&
        String(message.payload?.traceccPchUrl).includes('narrow')
      ) === true,
      'idle compiler asset prewarm must fetch and verify the narrow toolchain inside the Worker'
    );
  } finally {
    lease.dispose();
    globalThis.Worker = originalWorker;
    globalThis.requestIdleCallback = originalRequestIdleCallback;
    globalThis.cancelIdleCallback = originalCancelIdleCallback;
  }
}

async function testCompilePromotesQueuedCompilerPrewarm(): Promise<void> {
  const events: string[] = [];
  let clientSequence = 0;
  let queuedPrewarm: (() => Promise<void>) | null = null;
  let promotedTask: Promise<void> | null = null;
  const provider = createCppPreparedExecutionProvider({
    createWorkerClient: () => {
      const clientId = ++clientSequence;
      return {
        async init() {
          events.push(`init:${clientId}`);
          return { success: true, loadTimeMs: 0 };
        },
        async prepareRuntimeProgram() {
          events.push(`prepare:${clientId}`);
          return {
            success: false,
            error: 'focused promotion stop',
            consoleOutput: [],
          };
        },
        terminate() {
          events.push(`terminate:${clientId}`);
        },
      } as never;
    },
    prewarmCompiler: async () => {
      events.push('prewarm-assets');
    },
    scheduleCompilerPrewarm: (prewarm) => {
      queuedPrewarm = prewarm;
      return {
        promote: () => {
          promotedTask ??= prewarm();
          return promotedTask;
        },
        wait: () => promotedTask ?? new Promise<void>(() => undefined),
        cancel: () => undefined,
      };
    },
  });
  try {
    await provider.init();
    assertCondition(queuedPrewarm, 'provider init should queue a promotable compiler asset prewarm');
    assertCondition(
      !events.includes('prewarm-assets'),
      `queued compiler asset prewarm must not run eagerly: ${events}`
    );
    await provider.prepareProgram({
      mode: 'code',
      code: 'int add(int a, int b) { return a + b; }',
      functionName: 'add',
      executionStyle: 'function',
    });
    const warmupIndex = events.indexOf('prewarm-assets');
    const prepareIndex = events.findIndex((event) => event.startsWith('prepare:'));
    assertCondition(
      warmupIndex >= 0 && prepareIndex > warmupIndex,
      `the first compile should promote and await queued compiler warmup: ${events}`
    );
  } finally {
    provider.terminate();
  }
}

async function testPreparedProviderProtocolLifecycle(): Promise<void> {
  const originalWorker = globalThis.Worker;
  const originalFetch = globalThis.fetch;
  PreparedProtocolWorker.instances = [];
  PreparedProtocolWorker.compileRequests = 0;
  PreparedProtocolWorker.executions = 0;
  PreparedProtocolWorker.batchExecutions = 0;
  PreparedProtocolWorker.disposals = 0;
  let compilerFetches = 0;
  // @ts-expect-error focused Worker test double
  globalThis.Worker = PreparedProtocolWorker;
  globalThis.fetch = async () => {
    compilerFetches += 1;
    return new Response(MINIMAL_WASM.slice(), {
      status: 200,
      headers: {
        'content-type': 'application/wasm',
        'x-tracecode-compile-ms': '5',
      },
    });
  };

  const provider = createCppPreparedExecutionProvider({
    createWorkerClient: () => createClient(),
  });
  try {
    await provider.init();
    const preparation = await provider.prepareProgram({
      mode: 'code',
      code: 'class Solution { public: int identity(int value) { return value; } };',
      functionName: 'identity',
      executionStyle: 'solution-method',
    });
    assertCondition(
      preparation.kind === 'prepared' && preparation.program.mode === 'code',
      `C++ prepared provider should return a code program: ${JSON.stringify(preparation)}`
    );
    assertCondition(
      preparation.program.capabilities.caseIsolation === 'fresh-case-state' &&
        preparation.program.capabilities.maxConcurrency === 1,
      'C++ prepared provider should report fresh state and its serialized worker capacity'
    );
    const first = await preparation.program.executeIsolated({
      inputs: { value: 1 },
    });
    const second = await preparation.program.executeIsolated({
      inputs: { value: 2 },
    });
    const batch = await preparation.program.executeBatchIsolated?.({
      inputBatch: [{ value: 3 }, { value: 4 }, { value: 5 }],
    });
    assertCondition(
      first.kind === 'completed' && first.output === 1 &&
        second.kind === 'completed' && second.output === 2,
      `prepared executions should reuse one program: ${JSON.stringify({ first, second })}`
    );
    assertCondition(
      batch?.map((result) => result.kind === 'completed' ? result.output : null).join(',') ===
        '3,4,5' &&
        PreparedProtocolWorker.batchExecutions === 1,
      `prepared code batches should cross one Worker request: ${JSON.stringify({
        batch,
        batchExecutions: PreparedProtocolWorker.batchExecutions,
      })}`
    );
    const explicitlyLimitedBatch =
      await preparation.program.executeBatchIsolated?.({
        inputBatch: [{ value: 6 }, { value: 7 }],
        limits: { wallClockMs: 25 },
      });
    assertCondition(
      explicitlyLimitedBatch?.map((result) =>
        result.kind === 'completed' ? result.output : null
      ).join(',') === '6,7' &&
        PreparedProtocolWorker.executions === 4 &&
        PreparedProtocolWorker.batchExecutions === 1,
      `explicit per-case deadlines must retain one Worker request per case: ${JSON.stringify({
        explicitlyLimitedBatch,
        executions: PreparedProtocolWorker.executions,
        batchExecutions: PreparedProtocolWorker.batchExecutions,
      })}`
    );
    assertCondition(
      PreparedProtocolWorker.compileRequests === 1 &&
        compilerFetches === 1 &&
        PreparedProtocolWorker.executions === 4 &&
        PreparedProtocolWorker.batchExecutions === 1,
      `one preparation must compile exactly once regardless of case count: ${JSON.stringify({
        compileRequests: PreparedProtocolWorker.compileRequests,
        compilerFetches,
        executions: PreparedProtocolWorker.executions,
        batchExecutions: PreparedProtocolWorker.batchExecutions,
      })}`
    );
    await preparation.program.dispose();
    await preparation.program.dispose();
    assertCondition(
      PreparedProtocolWorker.disposals === 1,
      'prepared-program disposal should cross the worker protocol exactly once'
    );
    let disposedError = '';
    try {
      await preparation.program.executeIsolated({ inputs: { value: 3 } });
    } catch (error) {
      disposedError = error instanceof Error ? error.message : String(error);
    }
    assertCondition(
      disposedError === 'C++ prepared program "prepared-1" was already disposed.',
      `execution after disposal should fail deterministically: ${disposedError}`
    );

    const abortProvider = createCppPreparedExecutionProvider({
      createWorkerClient: () => createClient(),
    });
    const abortPreparation = await abortProvider.prepareProgram({
      mode: 'code',
      code: 'class Solution { public: int hang(int value) { return value; } };',
      functionName: 'hang',
      executionStyle: 'solution-method',
    });
    assertCondition(
      abortPreparation.kind === 'prepared' && abortPreparation.program.mode === 'code',
      `abort preparation should succeed: ${JSON.stringify(abortPreparation)}`
    );
    const controller = new AbortController();
    const execution = abortPreparation.program.executeIsolated({
      inputs: { value: 0, hang: true },
      signal: controller.signal,
    });
    controller.abort();
    let abortError: unknown;
    try {
      await execution;
    } catch (error) {
      abortError = error;
    }
    assertCondition(
      abortError instanceof Error && abortError.name === 'AbortError',
      `prepared caller cancellation should preserve AbortError: ${String(abortError)}`
    );
    const workerCountBeforeDispose = PreparedProtocolWorker.instances.length;
    await abortPreparation.program.dispose();
    assertCondition(
      PreparedProtocolWorker.instances.length === workerCountBeforeDispose,
      'disposing an already-aborted prepared program must not recreate its worker'
    );

    const timeoutProvider = createCppPreparedExecutionProvider({
      createWorkerClient: () => createClient(),
    });
    const timeoutPreparation = await timeoutProvider.prepareProgram({
      mode: 'code',
      code: 'class Solution { public: int hang(int value) { return value; } };',
      functionName: 'hang',
      executionStyle: 'solution-method',
    });
    assertCondition(
      timeoutPreparation.kind === 'prepared' &&
        timeoutPreparation.program.mode === 'code',
      `timeout preparation should succeed: ${JSON.stringify(timeoutPreparation)}`
    );
    const timedOut = await timeoutPreparation.program.executeIsolated({
      inputs: { value: 0, hang: true },
      limits: { wallClockMs: 5 },
    });
    assertCondition(
      timedOut.kind === 'limit' && timedOut.reason === 'client-timeout',
      `prepared wall-clock limits should return a structured limit: ${JSON.stringify(timedOut)}`
    );
    const workerCountBeforeTimeoutDispose =
      PreparedProtocolWorker.instances.length;
    await timeoutPreparation.program.dispose();
    assertCondition(
      PreparedProtocolWorker.instances.length ===
        workerCountBeforeTimeoutDispose,
      'disposing a timed-out prepared program must not recreate its worker'
    );

    const batchTimeoutProvider = createCppPreparedExecutionProvider({
      createWorkerClient: () => createClient({ executionTimeoutMs: 5 }),
    });
    const batchTimeoutPreparation = await batchTimeoutProvider.prepareProgram({
      mode: 'code',
      code: 'class Solution { public: int hang(int value) { return value; } };',
      functionName: 'hang',
      executionStyle: 'solution-method',
    });
    assertCondition(
      batchTimeoutPreparation.kind === 'prepared' &&
        batchTimeoutPreparation.program.mode === 'code',
      `batch timeout preparation should succeed: ${JSON.stringify(batchTimeoutPreparation)}`
    );
    const timedOutBatch =
      await batchTimeoutPreparation.program.executeBatchIsolated?.({
        inputBatch: [
          { value: 0, hang: true },
          { value: 1, hang: false },
        ],
      });
    assertCondition(
      timedOutBatch?.length === 2 &&
        timedOutBatch.every((result) =>
          result.kind === 'limit' && result.reason === 'client-timeout'
        ),
      `a stuck aggregate batch should return structured limits for every unresolved case: ${JSON.stringify(timedOutBatch)}`
    );
    const workerCountBeforeBatchTimeoutDispose =
      PreparedProtocolWorker.instances.length;
    await batchTimeoutPreparation.program.dispose();
    assertCondition(
      PreparedProtocolWorker.instances.length ===
        workerCountBeforeBatchTimeoutDispose,
      'disposing a timed-out prepared batch must not recreate its worker'
    );
    batchTimeoutProvider.terminate();

    const lifecycleProvider = createCppPreparedExecutionProvider({
      createWorkerClient: () => createClient(),
    });
    await lifecycleProvider.init();
    const warmedWorker = PreparedProtocolWorker.instances.at(-1);
    lifecycleProvider.reset();
    assertCondition(
      warmedWorker?.terminated,
      'reset must retire the prepared C++ standby worker'
    );
    const lifecyclePreparation = await lifecycleProvider.prepareProgram({
      mode: 'code',
      code: 'class Solution { public: int identity(int value) { return value; } };',
      functionName: 'identity',
      executionStyle: 'solution-method',
    });
    assertCondition(
      lifecyclePreparation.kind === 'prepared' &&
        lifecyclePreparation.program.mode === 'code',
      `prepared C++ provider must remain reusable after reset: ${JSON.stringify(lifecyclePreparation)}`
    );
    lifecycleProvider.reset();
    let resetProgramError = '';
    try {
      await lifecyclePreparation.program.executeIsolated({
        inputs: { value: 9 },
      });
    } catch (error) {
      resetProgramError =
        error instanceof Error ? error.message : String(error);
    }
    assertCondition(
      resetProgramError.includes('already disposed'),
      `reset must retire programs owned by the prior provider generation: ${resetProgramError}`
    );
    await lifecyclePreparation.program.dispose();
    lifecycleProvider.terminate();
    let terminatedProviderError = '';
    try {
      await lifecycleProvider.init();
    } catch (error) {
      terminatedProviderError =
        error instanceof Error ? error.message : String(error);
    }
    assertCondition(
      terminatedProviderError.includes('has been terminated'),
      `terminated prepared C++ providers must not restart: ${terminatedProviderError}`
    );

    const recycledClient = createClient();
    const firstGeneration = await recycledClient.prepareRuntimeProgram({
      mode: 'code',
      code: 'class Solution { public: int identity(int value) { return value; } };',
      functionName: 'identity',
      executionStyle: 'solution-method',
    });
    assertCondition(
      firstGeneration.success,
      `first low-level preparation should succeed: ${JSON.stringify(firstGeneration)}`
    );
    recycledClient.terminate();
    await recycledClient.disposePreparedProgram(firstGeneration.handle);
    const secondGeneration = await recycledClient.prepareRuntimeProgram({
      mode: 'code',
      code: 'class Solution { public: int identity(int value) { return value; } };',
      functionName: 'identity',
      executionStyle: 'solution-method',
    });
    assertCondition(
      secondGeneration.success &&
        secondGeneration.handle.programId === firstGeneration.handle.programId &&
        secondGeneration.handle.lifecycleGeneration !==
          firstGeneration.handle.lifecycleGeneration,
      `worker-local ids may be reused only behind generation fencing: ${JSON.stringify({
        firstGeneration,
        secondGeneration,
      })}`
    );
    const recycledResult = await recycledClient.executePreparedCode(
      secondGeneration.handle,
      { inputs: { value: 7 } }
    );
    assertCondition(
      recycledResult.kind === 'completed' && recycledResult.output === 7,
      `disposing a stale generation must not poison a recycled program id: ${JSON.stringify(recycledResult)}`
    );
    await recycledClient.disposePreparedProgram(secondGeneration.handle);
    recycledClient.terminate();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Worker = originalWorker;
  }
}

async function testPreparedRunnerRetirementPreservesSharedCompiler(): Promise<void> {
  const originalWorker = globalThis.Worker;
  PreparedProtocolWorker.instances = [];
  PreparedProtocolWorker.compileRequests = 0;
  PreparedProtocolWorker.executions = 0;
  PreparedProtocolWorker.disposals = 0;
  const compilerPayloads: unknown[] = [];
  const compilerCoordinator = {
    async compileTrusted(payload: unknown, signal?: AbortSignal) {
      assertCondition(!signal?.aborted, 'shared compiler request should begin active');
      compilerPayloads.push(payload);
      return {
        success: true,
        programBuffer: MINIMAL_WASM.slice().buffer,
        stdout: '',
        stderr: '',
        timings: {
          compileCacheHit: false,
          artifactCacheHit: false,
        },
      };
    },
  };
  // @ts-expect-error focused Worker test double
  globalThis.Worker = PreparedProtocolWorker;

  const provider = createCppPreparedExecutionProvider({
    createWorkerClient: () => createClient({
      trustedCompilerService: compilerCoordinator,
    }),
  });
  try {
    await provider.init();
    for (const [index, code] of ['source-one', 'source-two'].entries()) {
      const preparation = await provider.prepareProgram({
        mode: 'code',
        code,
        functionName: 'identity',
        executionStyle: 'solution-method',
      });
      assertCondition(
        preparation.kind === 'prepared',
        `shared compiler preparation ${index + 1} should succeed`
      );
      const result = await preparation.program.executeIsolated({
        inputs: { value: index + 1 },
      });
      assertCondition(
        result.kind === 'completed' && result.output === index + 1,
        `shared compiler runner ${index + 1} should execute`
      );
      await preparation.program.dispose();
      assertCondition(
        PreparedProtocolWorker.instances[index]?.terminated,
        `prepared runner ${index + 1} must be physically retired`
      );
    }
    assertCondition(
      compilerPayloads.length === 2,
      `one shared compiler coordinator should serve both disposable runners: ${compilerPayloads.length}`
    );
    assertCondition(
      PreparedProtocolWorker.instances.length === 2 &&
        PreparedProtocolWorker.instances.every((worker) => worker.terminated),
      'every learner runner should retire while the provider-owned compiler remains available'
    );
  } finally {
    provider.terminate();
    globalThis.Worker = originalWorker;
  }
}

async function testTrustedCompilerSerializesConcurrentRequests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let activeFetches = 0;
  let peakActiveFetches = 0;
  let fetchCalls = 0;
  let releaseFirstFetch!: () => void;
  let markFirstFetchStarted!: () => void;
  const firstFetchGate = new Promise<void>((resolve) => {
    releaseFirstFetch = resolve;
  });
  const firstFetchStarted = new Promise<void>((resolve) => {
    markFirstFetchStarted = resolve;
  });
  globalThis.fetch = async () => {
    fetchCalls += 1;
    activeFetches += 1;
    peakActiveFetches = Math.max(peakActiveFetches, activeFetches);
    if (fetchCalls === 1) {
      markFirstFetchStarted();
      await firstFetchGate;
    }
    activeFetches -= 1;
    return new Response(MINIMAL_WASM.slice(), {
      status: 200,
      headers: { 'content-type': 'application/wasm' },
    });
  };
  const compiler = createClient();
  try {
    const first = compiler.compileTrusted({ driverSource: 'first' });
    const second = compiler.compileTrusted({ driverSource: 'second' });
    await firstFetchStarted;
    const queuedFetchCalls = fetchCalls;
    const queuedPeakActiveFetches = peakActiveFetches;
    assertCondition(
      queuedFetchCalls === 1 && queuedPeakActiveFetches === 1,
      `the second trusted compile must wait behind the first: calls=${queuedFetchCalls}, peak=${queuedPeakActiveFetches}`
    );
    releaseFirstFetch();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assertCondition(
      firstResult.success === true &&
        secondResult.success === true &&
        fetchCalls === 2 &&
        peakActiveFetches === 1,
      `trusted compiler requests must complete serially: ${JSON.stringify({ fetchCalls, peakActiveFetches })}`
    );
  } finally {
    releaseFirstFetch();
    compiler.terminate();
    globalThis.fetch = originalFetch;
  }
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

async function main(): Promise<void> {
  await testBrowserProviderPreparedLeaseExposure();
  await testPreparedRunnerRetirementPreservesSharedCompiler();
  await testTrustedCompilerSerializesConcurrentRequests();
  await testContentAddressedArtifactsAndDisposableExecution();
  await testInvalidArtifactsFailClosedAndAreNotCached();
  await testTerminationDuringAssetPreflightCannotRecreateWorkerAndClientRecovers();
  await testTimeoutAbortsCompilerAndRetiresExecution();
  await testCallerAbortResetsCompilerAndExecution();
  await testCallerAbortCannotRecreateCompilerFrameAfterAsyncCacheKey();
  console.log('C++ compiler lifecycle tests passed');
}

test('cpp browser provider prewarms assets inside TraceCC without page fetches', testBrowserProviderDefersCompilerWarmupUntilPreparation);
test('cpp compile promotes queued compiler asset prewarm', testCompilePromotesQueuedCompilerPrewarm);
test('cpp prepared provider protocol lifecycle', testPreparedProviderProtocolLifecycle);
test('cpp compiler lifecycle', main);

#!/usr/bin/env npx tsx

// The trusted TraceCC compiler Worker learns its integrity manifest only from
// its `init` message. Every other request it serves needs that manifest: a
// compile or asset prewarm that arrives first fails closed with "TraceCC
// compiler requires an exact SHA-256 entry in the TraceCC toolchain
// manifest." These tests hold a fresh compiler Worker in its boot window and
// send a second request while the first caller is still starting it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCppBrowserRuntimeProvider } from '../packages/runtime-cpp/src/browser-runtime-provider';
import { TraceCCCompilerService } from '../packages/runtime-cpp/src/tracecc-compiler-service';
import { createTraceCCRuntimeManifest } from '../packages/runtime-cpp/src/tracecc-runtime-assets';
import { createBrowserRuntimeHost, createBrowserRuntimeProviderRegistry } from '../packages/runtime-browser/src';
import type { BrowserRuntimeJudgeReceiptLease } from '../packages/runtime-browser/src/browser-runtime-host-internal';
import { createBrowserJudgeHostFromRuntimeHost } from '../src/internal/browser-judge';
import { createAlgorithmJudgeBundle } from '../src/judge';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const MINIMAL_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const COMPILER_URL = '/workers/cpp/tracecc/tracecc-reactor.wasm';
const MISSING_MANIFEST_ERROR =
  'TraceCC compiler requires an exact SHA-256 entry in the TraceCC toolchain manifest.';

interface WorkerMessage {
  id?: string;
  type: string;
  requestId?: string;
  protocolToken?: string;
  payload?: Record<string, unknown>;
}

type MessageHandler = ((event: MessageEvent<WorkerMessage>) => void) | null;

function deliver(handler: MessageHandler, data: WorkerMessage): void {
  handler?.({ data } as unknown as MessageEvent<WorkerMessage>);
}

/**
 * Mirrors the real compiler Worker's integrity rule (cpp-worker.js
 * `fetchPinnedTraceccAssetResponse`): it knows the manifest only after `init`,
 * and handles requests in arrival order. Its boot is held until released.
 */
class StrictCompilerWorker {
  static instances: StrictCompilerWorker[] = [];
  /** The next Worker answers its init with the worker's failure reply (`postFailure`). */
  static failNextInit: string | null = null;
  static autoBoot = false;
  static beforeCompile: ((source: string) => Promise<void> | undefined) | undefined;
  static readonly compiles: string[] = [];

  onmessage: MessageHandler = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly received: string[] = [];
  terminated = false;
  private manifestUrls: Set<string> | null = null;
  private releaseBoot!: () => void;
  readonly booted = new Promise<void>((resolve) => {
    this.releaseBoot = resolve;
  });

  constructor(readonly url: string | URL) {
    StrictCompilerWorker.instances.push(this);
    if (StrictCompilerWorker.autoBoot) this.finishBoot();
    void this.booted.then(() => {
      if (!this.terminated) deliver(this.onmessage, { type: 'worker-ready' });
    });
  }

  finishBoot(): void {
    this.releaseBoot();
  }

  postMessage(message: WorkerMessage): void {
    if (this.terminated) return;
    this.received.push(message.type);
    const reply = (payload: Record<string, unknown>, type = message.type) =>
      queueMicrotask(() => {
        if (!this.terminated) {
          deliver(this.onmessage, { id: message.id, type, protocolToken: message.protocolToken, payload });
        }
      });
    if (message.type === 'init' && StrictCompilerWorker.failNextInit !== null) {
      const error = StrictCompilerWorker.failNextInit;
      StrictCompilerWorker.failNextInit = null;
      reply({ error }, 'error');
      return;
    }
    if (message.type === 'init') {
      const integrity = (message.payload?.assets as { toolchainIntegrity?: { assets?: { url?: string; sha256?: string }[] } } | undefined)
        ?.toolchainIntegrity;
      this.manifestUrls = new Set(
        (integrity?.assets ?? []).filter((entry) => entry.url && entry.sha256).map((entry) => String(entry.url))
      );
      reply({ success: true, loadTimeMs: 0 });
      return;
    }
    if (message.type === 'prewarm-trusted-tracecc-assets' || message.type === 'compile-trusted-tracecc') {
      if (!this.manifestUrls?.has(String(message.payload?.traceccCompilerUrl))) {
        reply({ error: MISSING_MANIFEST_ERROR }, 'error');
        return;
      }
      if (message.type !== 'compile-trusted-tracecc') {
        reply({ success: true });
        return;
      }
      const project = message.payload?.project as { files?: { contents: string }[] } | undefined;
      const source = project?.files?.[0]?.contents ?? '';
      StrictCompilerWorker.compiles.push(source);
      const finish = () => reply({ success: true, outputBytes: MINIMAL_WASM.slice(), stdout: '', stderr: '', timings: {} });
      const held = StrictCompilerWorker.beforeCompile?.(source);
      if (held) void held.then(finish);
      else finish();
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** A warm learner runner that asks the page to compile each preparation. */
class LearnerWorker {
  static instances: LearnerWorker[] = [];
  static compileRequests = 0;
  static beforeTraceCompileRequest: (() => void) | undefined;

  onmessage: MessageHandler = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  private pendingPreparation: WorkerMessage | null = null;

  constructor(readonly url: string | URL) {
    LearnerWorker.instances.push(this);
    queueMicrotask(() => deliver(this.onmessage, { type: 'worker-ready' }));
  }

  postMessage(message: WorkerMessage): void {
    if (this.terminated) return;
    const reply = (target: WorkerMessage, payload: Record<string, unknown>) =>
      queueMicrotask(() => {
        if (!this.terminated) {
          deliver(this.onmessage, { id: target.id, type: target.type, protocolToken: target.protocolToken, payload });
        }
      });
    if (message.type === 'init') {
      reply(message, { success: true, loadTimeMs: 0 });
      return;
    }
    if (message.type === 'prepare-runtime-program') {
      if (message.payload?.mode === 'trace') LearnerWorker.beforeTraceCompileRequest?.();
      LearnerWorker.compileRequests += 1;
      this.pendingPreparation = message;
      queueMicrotask(() => deliver(this.onmessage, {
        type: 'compile-request',
        requestId: `learner-compile-${LearnerWorker.compileRequests}`,
        protocolToken: message.protocolToken,
        payload: { driverSource: `${String(message.payload?.mode)}:${String(message.payload?.code ?? '')}` },
      }));
      return;
    }
    if (message.type === 'execute-prepared-runtime-program') {
      const inputs = message.payload?.inputs as { value: number };
      reply(message, { success: true, output: inputs.value, consoleOutput: [] });
    }
    if (message.type === 'dispose-prepared-runtime-program') {
      reply(message, { success: true });
    }
    if (message.type === 'compile-response') {
      const preparation = this.pendingPreparation;
      this.pendingPreparation = null;
      if (!preparation) return;
      const compilation = message.payload ?? {};
      // The real worker reports a page compile failure without a program
      // stage, which the provider classifies as its own failure.
      reply(preparation, compilation.success === true
        ? { success: true, programId: 'prepared-1', mode: preparation.payload?.mode, consoleOutput: [] }
        : {
            success: false,
            error: `C++ compiler failed without diagnostics: ${String(compilation.error ?? '')}`,
            consoleOutput: [],
          });
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

function routedWorkerFactory(url: string | URL): StrictCompilerWorker | LearnerWorker {
  return String(url).includes('traceccRole=compiler')
    ? new StrictCompilerWorker(url)
    : new LearnerWorker(url);
}

function resetFakes(): void {
  StrictCompilerWorker.instances = [];
  StrictCompilerWorker.failNextInit = null;
  StrictCompilerWorker.autoBoot = false;
  StrictCompilerWorker.beforeCompile = undefined;
  StrictCompilerWorker.compiles.length = 0;
  LearnerWorker.instances = [];
  LearnerWorker.compileRequests = 0;
  LearnerWorker.beforeTraceCompileRequest = undefined;
}

/**
 * Resolves after the next compile has digested its driver and reached the
 * compiler service's transport, so the request is waiting on the Worker boot.
 */
function interceptNextArtifactDigest(): { reached: Promise<void>; restore: () => void } {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.digest;
  let reachedTransport!: () => void;
  const reached = new Promise<void>((resolve) => {
    reachedTransport = resolve;
  });
  Object.defineProperty(subtle, 'digest', {
    configurable: true,
    writable: true,
    value: async (...args: Parameters<SubtleCrypto['digest']>) => {
      const digest = await original.apply(subtle, args);
      setTimeout(reachedTransport, 0);
      return digest;
    },
  });
  return { reached, restore: () => { delete (subtle as { digest?: unknown }).digest; } };
}

const SHARD = {
  pchUrl: '/workers/cpp/tracecc/narrow.pch',
  pchSourceUrl: '/workers/cpp/tracecc/narrow.hpp',
  runtimeObjectUrl: '/workers/cpp/tracecc/narrow.o',
};

function createCppLease(workerFactory?: (url: string | URL) => unknown): BrowserRuntimeJudgeReceiptLease {
  return createCppBrowserRuntimeProvider().create({
    assets: {
      cppWorker: '/workers/cpp-worker.js',
      cppCompilerFrame: '/workers/cpp-compiler-frame.html',
      cppCompilerWorker: '/workers/cpp-compiler-worker.js',
      cppCompilerWasm: COMPILER_URL,
      cppLinkerWasm: COMPILER_URL,
      cppSysroot: '/workers/cpp/tracecc/llvm-resources.tar',
      cppRuntimeHeader: '/workers/cpp/tracecc/tracecode_runtime.hpp',
      cppCompilerBundle: '',
      cppCompilerIntegrity: { assets: [{ url: COMPILER_URL, sha256: 'a'.repeat(64) }] },
      runtimeManifests: { cpp: createTraceCCRuntimeManifest('/workers/cpp/tracecc') },
    } as never,
    debug: false,
    workerLifecyclePolicy: 'retire-only',
    workerFactoryFor: () => workerFactory,
    preflight: () => async () => undefined,
    manifestAsset: () => undefined,
    manifestAssetCollection: () => undefined,
  } as never) as BrowserRuntimeJudgeReceiptLease;
}

function createService(
  workerFactory: (url: string | URL) => unknown = (url) => new StrictCompilerWorker(url)
): TraceCCCompilerService {
  return new TraceCCCompilerService({
    workerUrl: '/workers/cpp-worker.js',
    compilerUrl: COMPILER_URL,
    resourcesUrl: '/workers/cpp/tracecc/llvm-resources.tar',
    runtimeHeaderUrl: '/workers/cpp/tracecc/tracecode_runtime.hpp',
    compilerIntegrity: { assets: [{ url: COMPILER_URL, sha256: 'a'.repeat(64) }] },
    shards: { narrow: SHARD, broad: SHARD, map: SHARD },
    workerFactory: (url) => workerFactory(url) as never,
  });
}

async function startCompiler(service: TraceCCCompilerService): Promise<StrictCompilerWorker> {
  const prewarm = service.prewarmAssets();
  const worker = StrictCompilerWorker.instances[0]!;
  worker.finishBoot();
  await prewarm;
  return worker;
}

/** Bound a failed assertion without releasing the compiler barrier first. */
async function beforeBarrier<T>(pending: Promise<T>): Promise<T> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new Error('Request waited for the held compile')), 1_000);
  try {
    return await Promise.race([pending, expired.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function createCppJudge(lease: ReturnType<typeof createCppLease>) {
  const runtime = createBrowserRuntimeHost({
    providers: ['cpp'],
    providerRegistry: createBrowserRuntimeProviderRegistry([{
      id: 'cpp-order-test', languages: ['cpp'], create: () => lease,
    }]),
    featureOverrides: { worker: true, webAssembly: true, webCrypto: true, sharedArrayBuffer: true, crossOriginIsolated: true },
  });
  return createBrowserJudgeHostFromRuntimeHost(runtime);
}

test('a cold joined C++ Run initializes its drawing runner before admission but reaches TraceCC with ordinary code first', async (t) => {
  resetFakes();
  StrictCompilerWorker.autoBoot = true;
  const phases: string[] = [];
  const bridge = Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1');
  const globals = [
    ['window', globalThis],
    ['document', { defaultView: globalThis }],
    [bridge, { onEvent: ({ phase }: { phase: string }) => phases.push(phase) }],
  ] as const;
  for (const [key, value] of globals) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const host = createCppJudge(createCppLease(routedWorkerFactory));
  const entered = Promise.withResolvers<void>();
  const ordinary = Promise.withResolvers<void>();
  const drawingRunnerReady = Promise.withResolvers<void>();
  const startedDrawing = Promise.withResolvers<void>();
  const code = 'int echo(int value) { return value; }';
  try {
    const bundle = await createAlgorithmJudgeBundle({
      id: 'cpp-prepare-order', language: 'cpp', code, functionName: 'echo',
      cases: [{ id: 'A', input: { value: 7 }, expected: 7 }],
    });
    StrictCompilerWorker.beforeCompile = (source) => {
      if (source === `code:${code}`) {
        entered.resolve();
        return ordinary.promise;
      }
      if (phases.includes('ordinary-case-started')) startedDrawing.resolve();
      else startedDrawing.reject(new Error('TraceCC observer prepared before ordinary case admission'));
    };
    LearnerWorker.beforeTraceCompileRequest = drawingRunnerReady.resolve;
    void startedDrawing.promise.catch(() => {});
    const verdict = host.execute({
      bundle, interactive: true, tracing: { caseIds: ['A'] },
    });
    void verdict.catch(() => {});
    await beforeBarrier(Promise.all([entered.promise, drawingRunnerReady.promise]));
    assert.deepEqual(StrictCompilerWorker.compiles, [`code:${code}`]);
    ordinary.resolve();
    assert.equal((await verdict).evaluation.cases[0]?.verdict.kind, 'passed');
    await beforeBarrier(startedDrawing.promise);
    assert.deepEqual(StrictCompilerWorker.compiles, [`code:${code}`, `trace:${code}`]);
  } finally {
    ordinary.resolve();
    host.dispose();
  }
});

test('the C++ Judge provider preserves TraceCC when disposing a running drawing before a cache-miss Run', async () => {
  resetFakes();
  StrictCompilerWorker.autoBoot = true;
  const host = createCppJudge(createCppLease(routedWorkerFactory));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const make = (id: string) => createAlgorithmJudgeBundle({
    id: `cpp-observer-role-${id}`, language: 'cpp',
    code: `int echo(int value) { /* ${id} */ return value; }`, functionName: 'echo',
    cases: [{ id, input: { value: 7 }, expected: 7 }],
  });
  try {
    const [a, b] = await Promise.all([make('A'), make('B')]);
    StrictCompilerWorker.beforeCompile = (source) => {
      if (!source.startsWith('trace:') || !source.includes('/* A */')) return;
      entered.resolve();
      return release.promise;
    };
    const first = await host.execute({
      bundle: a, interactive: true, drawingDelivery: 'after-verdict', tracing: { caseIds: ['A'] },
    });
    assert.ok(first.executionId);
    await beforeBarrier(entered.promise);
    const compiler = StrictCompilerWorker.instances[0]!;
    const drawing = host.execute({ executionId: first.executionId, tracing: { caseIds: ['A'] } });
    const rejectedDrawing = assert.rejects(drawing, { name: 'JudgePlanError' });
    void rejectedDrawing.catch(() => undefined);
    await beforeBarrier(host.disposeExecution(first.executionId));
    const second = host.execute({ bundle: b, interactive: true, drawingDelivery: 'after-verdict' });
    void second.catch(() => undefined);
    await beforeBarrier(rejectedDrawing);
    assert.equal(compiler.terminated, false);
    assert.deepEqual(StrictCompilerWorker.compiles.map((source) => source.match(/^(code|trace):.*\/\* (.) \*\//)?.slice(1)),
      [['code', 'A'], ['trace', 'A']]);
    release.resolve();
    assert.equal((await beforeBarrier(second)).evaluation.cases[0]?.verdict.kind, 'passed');
    assert.deepEqual(StrictCompilerWorker.compiles.map((source) => source.match(/^(code|trace):.*\/\* (.) \*\//)?.slice(1)),
      [['code', 'A'], ['trace', 'A'], ['code', 'B']]);
    assert.deepEqual(StrictCompilerWorker.instances, [compiler]);
    assert.equal(compiler.terminated, false);
  } finally {
    release.resolve();
    host.dispose();
  }
});

test('a C++ drawing held in the TraceCC queue refuses at its preparation deadline', async () => {
  resetFakes();
  StrictCompilerWorker.autoBoot = true;
  const lease = createCppLease(routedWorkerFactory);
  const provider = lease.judgeReceiptProviders!.get('cpp')!;
  const host = createCppJudge({
    ...lease,
    judgeReceiptProviders: new Map([['cpp', {
      ...provider,
      capabilities: { ...provider.capabilities, observationPrepareDeadlineMs: 20 },
    }]]),
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const make = (id: string) => createAlgorithmJudgeBundle({
    id: `cpp-prepare-deadline-${id}`, language: 'cpp',
    code: `int echo(int value) { /* ${id} */ return value; }`, functionName: 'echo',
    cases: [{ id, input: { value: 7 }, expected: 7 }],
  });
  try {
    const [a, b, c] = await Promise.all([make('A'), make('B'), make('C')]);
    assert.equal((await host.evaluateAlgorithm({ bundle: b })).evaluation.cases[0]?.verdict.kind, 'passed');
    StrictCompilerWorker.beforeCompile = (source) => {
      if (!source.startsWith('trace:') || !source.includes('/* A */')) return;
      entered.resolve();
      return release.promise;
    };
    await host.execute({ bundle: a, interactive: true, drawingDelivery: 'after-verdict', tracing: { caseIds: ['A'] } });
    await beforeBarrier(entered.promise);
    const rerun = await beforeBarrier(host.execute({
      bundle: b, interactive: true, drawingDelivery: 'after-verdict', tracing: { caseIds: ['B'] },
    }));
    assert.ok(rerun.executionId);
    const drawing = await beforeBarrier(host.execute({ executionId: rerun.executionId, tracing: { caseIds: ['B'] } }));
    const attachment = drawing.evaluation.cases[0]?.attachment;
    assert.ok(attachment?.status === 'refused' && attachment.reason === 'observer-timeout');
    release.resolve();
    const sentinel = await host.execute({ bundle: c, interactive: true, tracing: { caseIds: ['C'] } });
    assert.equal(sentinel.evaluation.cases[0]?.verdict.kind, 'passed');
    assert.ok(StrictCompilerWorker.compiles.some((s) => s.startsWith('trace:') && s.includes('/* C */')));
    assert.equal(StrictCompilerWorker.compiles.some((s) => s.startsWith('trace:') && s.includes('/* B */')), false);
    assert.equal(StrictCompilerWorker.instances.length, 1);
    assert.equal(StrictCompilerWorker.instances[0]!.terminated, false);
  } finally {
    release.resolve();
    host.dispose();
  }
});

test('TraceCC admits an ordinary compile ahead of a queued observer', async () => {
  resetFakes();
  const service = createService();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await startCompiler(service);
    StrictCompilerWorker.beforeCompile = (source) => {
      if (source !== 'A observer running') return;
      entered.resolve();
      return release.promise;
    };
    const a = service.compileTrusted({ driverSource: 'A observer running' }, undefined, 'observer');
    await entered.promise;
    const queued = service.compileTrusted({ driverSource: 'A observer queued' }, undefined, 'observer');
    const b = service.compileTrusted({ driverSource: 'B ordinary' });
    release.resolve();
    await Promise.all([a, queued, b]);
    assert.deepEqual(StrictCompilerWorker.compiles, ['A observer running', 'B ordinary', 'A observer queued']);
  } finally {
    release.resolve();
    service.terminate();
  }
});

test('disposing a running and a queued TraceCC observer drops both results without restarting the compiler', async () => {
  resetFakes();
  const service = createService();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const extras: Promise<unknown>[] = [];
  const abortB = new AbortController();
  try {
    const worker = await startCompiler(service);
    StrictCompilerWorker.beforeCompile = (source) => {
      if (source !== 'A observer running') return;
      entered.resolve();
      return release.promise;
    };
    const abortA = new AbortController();
    const a = service.compileTrusted({ driverSource: 'A observer running' }, abortA.signal, 'observer');
    extras.push(a.catch(() => {}));
    await entered.promise;
    const queued = service.compileTrusted({ driverSource: 'A observer queued' }, abortA.signal, 'observer');
    extras.push(queued.catch(() => {}));
    const b = service.compileTrusted({ driverSource: 'B ordinary' }, abortB.signal);
    extras.push(b.catch(() => {}));
    abortA.abort(new DOMException('A disposed', 'AbortError'));
    assert.equal(worker.terminated, false, 'disposing A must preserve the worker running its compile');
    await beforeBarrier(Promise.all([
      assert.rejects(a, { name: 'AbortError' }),
      assert.rejects(queued, { name: 'AbortError' }),
    ]));
    release.resolve();
    assert.equal((await b).success, true);
    assert.equal(worker.terminated, false);
    assert.equal(StrictCompilerWorker.instances.length, 1);
    const retry = await service.compileTrusted({ driverSource: 'A observer running' }, undefined, 'observer');
    assert.notEqual((retry.timings as { artifactCacheHit?: boolean }).artifactCacheHit, true);
    assert.deepEqual(StrictCompilerWorker.compiles, ['A observer running', 'B ordinary', 'A observer running']);
  } finally {
    release.resolve();
    abortB.abort();
    service.terminate();
    await Promise.all(extras);
  }
});

test('a same-source TraceCC ordinary rerun hits the cache while an observer compile is held', async () => {
  resetFakes();
  const service = createService();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await startCompiler(service);
    const ordinary = { driverSource: 'same ordinary source' };
    await service.compileTrusted(ordinary);
    StrictCompilerWorker.beforeCompile = () => {
      entered.resolve();
      return release.promise;
    };
    const observation = service.compileTrusted({ driverSource: 'observer' }, undefined, 'observer');
    await entered.promise;
    const repeat = service.compileTrusted(ordinary);
    try {
      const result = await beforeBarrier(repeat);
      assert.equal((result.timings as { artifactCacheHit?: boolean }).artifactCacheHit, true);
      assert.deepEqual(StrictCompilerWorker.compiles, ['same ordinary source', 'observer']);
    } finally {
      release.resolve();
      await Promise.allSettled([observation, repeat]);
    }
  } finally {
    release.resolve();
    service.terminate();
  }
});

test('a compile sent while an asset prewarm starts the TraceCC compiler Worker waits for its init', async () => {
  resetFakes();
  const service = createService();
  const digest = interceptNextArtifactDigest();
  try {
    // The idle prewarm starts the compiler Worker; it is still booting.
    const prewarm = service.prewarmAssets().then(
      () => 'prewarmed',
      (error: Error) => `prewarm failed: ${error.message}`
    );
    const worker = StrictCompilerWorker.instances[0];
    assertCondition(worker, 'the asset prewarm should start the trusted compiler Worker');

    // A Run's compile arrives during that boot.
    const compile = service.compileTrusted({ driverSource: 'int main() { return 0; }' }).then(
      (result) => result,
      (error: Error) => ({ success: false, error: error.message })
    );
    await digest.reached;
    worker.finishBoot();

    const [prewarmOutcome, compiled] = await Promise.all([prewarm, compile]);
    assertCondition(
      compiled.success === true,
      `the concurrent compile must not reach the Worker before its manifest: ${JSON.stringify(compiled)}`
    );
    assertCondition(
      worker.received[0] === 'init',
      `the compiler Worker must receive its integrity manifest before any request; received ${worker.received.join(', ')}`
    );
    assertCondition(prewarmOutcome === 'prewarmed', `the asset prewarm must still succeed: ${prewarmOutcome}`);
  } finally {
    digest.restore();
    service.terminate();
  }
});

test('a Run submitted as an aborted first prepare is still starting the compiler compiles (W abort/interactive/prepare/first-request)', async () => {
  resetFakes();
  const originalWorker = globalThis.Worker;
  // @ts-expect-error focused Worker test double
  globalThis.Worker = routedWorkerFactory;
  const lease = createCppLease();
  const digest = interceptNextArtifactDigest();
  try {
    const provider = lease.preparedProviders?.get('cpp');
    assertCondition(provider, 'C++ prepared provider should be registered');
    // A fresh host: the standby runner is warm and the compiler asset prewarm
    // is queued, not started (Node has no idle scheduler to start it).
    await provider.init();
    assertCondition(StrictCompilerWorker.instances.length === 0, 'entering C++ must not start the compiler Worker');

    // The first Run's prepare promotes the queued prewarm, which starts the
    // compiler Worker. The learner aborts while that Worker is booting; the
    // promoted prewarm cannot be cancelled and keeps the first prepare waiting.
    const abort = new AbortController();
    const program = {
      mode: 'code' as const,
      code: 'int add(int a, int b) { return a + b; }',
      functionName: 'add',
      executionStyle: 'function' as const,
    };
    const aborted = provider.prepareProgram({ ...program, signal: abort.signal }).then(
      () => 'settled',
      () => 'rejected'
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const compilerWorker = StrictCompilerWorker.instances[0];
    assertCondition(compilerWorker, 'the first prepare should start the trusted compiler Worker');
    abort.abort(new DOMException('Aborted', 'AbortError'));

    // The next Run is submitted in the same turn, like the application's
    // handoff. The queued prewarm is already taken, so it compiles at once on
    // the warm standby runner.
    const next = provider.prepareProgram(program).then(
      (preparation) => preparation,
      (error: Error) => ({ kind: 'provider-failure' as const, message: error.message })
    );
    await digest.reached;
    compilerWorker.finishBoot();

    const preparation = await next;
    await aborted;
    assertCondition(
      preparation.kind === 'prepared',
      `the next Run must compile, not report a provider failure: ${JSON.stringify(preparation)}`
    );
    assertCondition(
      compilerWorker.received[0] === 'init',
      `the compiler Worker must receive its integrity manifest first; received ${compilerWorker.received.join(', ')}`
    );
    if (preparation.kind === 'prepared') await preparation.program.dispose();
  } finally {
    digest.restore();
    lease.dispose();
    globalThis.Worker = originalWorker;
  }
});

test('a reset while the compiler Worker boots releases its waiters and spares the next Worker', async () => {
  resetFakes();
  const service = createService();
  try {
    const first = service.prewarmAssets().then(
      () => 'prewarmed',
      (error: Error) => `rejected: ${error.message}`
    );
    const booting = StrictCompilerWorker.instances[0];
    assertCondition(booting, 'the asset prewarm should start the trusted compiler Worker');
    // A cancelled Run resets the service before this Worker ever reports ready.
    service.terminate();
    const outcome = await Promise.race([
      first,
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 1_000)),
    ]);
    assertCondition(
      outcome.startsWith('rejected:'),
      `a caller waiting on a reset boot must be released, not held to the ready timeout: ${outcome}`
    );
    assertCondition(booting.terminated, 'the reset must terminate the booting Worker');

    // The next request starts a fresh Worker that completes normally.
    const next = service.prewarmAssets();
    const replacement = StrictCompilerWorker.instances[1];
    assertCondition(replacement && replacement !== booting, 'the next request should start a new Worker');
    replacement.finishBoot();
    await next;
    assertCondition(
      replacement.received.join(',') === 'init,prewarm-trusted-tracecc-assets' && !replacement.terminated,
      `the replacement Worker must initialize, then serve: ${replacement.received.join(', ')}`
    );
  } finally {
    service.terminate();
  }
});

test('a compiler Worker whose init fails is replaced by the next request', async () => {
  resetFakes();
  const service = createService();
  try {
    StrictCompilerWorker.failNextInit = 'TraceCC compiler Worker initialization failed in the worker.';
    const first = service.prewarmAssets().then(
      () => 'prewarmed',
      (error: Error) => `rejected: ${error.message}`
    );
    const failed = StrictCompilerWorker.instances[0];
    assertCondition(failed, 'the asset prewarm should start the trusted compiler Worker');
    failed.finishBoot();
    const outcome = await first;
    assertCondition(
      outcome === 'rejected: TraceCC compiler Worker initialization failed in the worker.',
      `the caller that hit the failed init must get its error: ${outcome}`
    );

    const next = service.prewarmAssets().then(
      () => 'prewarmed',
      (error: Error) => `rejected: ${error.message}`
    );
    const replacement = StrictCompilerWorker.instances[1];
    replacement?.finishBoot();
    const recovered = await next;
    assertCondition(
      replacement !== undefined && recovered === 'prewarmed',
      `the next request must start a fresh Worker and succeed: ${recovered} (${StrictCompilerWorker.instances.length} Workers)`
    );
    assertCondition(
      failed.terminated,
      'the Worker whose init failed must be terminated, not left running'
    );
    assertCondition(
      replacement.received.join(',') === 'init,prewarm-trusted-tracecc-assets',
      `the replacement Worker must initialize, then serve: ${replacement.received.join(', ')}`
    );
  } finally {
    service.terminate();
  }
});

test('a compiler Worker that cannot be constructed is retried by the next request', async () => {
  resetFakes();
  let constructions = 0;
  const service = createService((url) => {
    constructions += 1;
    if (constructions === 1) throw new Error('Worker construction failed.');
    return new StrictCompilerWorker(url);
  });
  try {
    const first = await service.prewarmAssets().then(
      () => 'prewarmed',
      (error: Error) => `rejected: ${error.message}`
    );
    assertCondition(
      first === 'rejected: Worker construction failed.',
      `the caller that hit the constructor failure must get its error: ${first}`
    );

    const next = service.prewarmAssets().then(
      () => 'prewarmed',
      (error: Error) => `rejected: ${error.message}`
    );
    // Let the retried startup construct its Worker before releasing the boot.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    StrictCompilerWorker.instances[0]?.finishBoot();
    const recovered = await next;
    assertCondition(
      constructions === 2 && recovered === 'prewarmed',
      `the next request must construct a fresh Worker and succeed: ${recovered} (${constructions} constructions)`
    );
  } finally {
    service.terminate();
  }
});

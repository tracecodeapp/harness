#!/usr/bin/env npx tsx

// The trusted TraceCC compiler Worker learns its integrity manifest only from
// its `init` message. Every other request it serves needs that manifest: a
// compile or asset prewarm that arrives first fails closed with "TraceCC
// compiler requires an exact SHA-256 entry in the TraceCC toolchain
// manifest." These tests hold a fresh compiler Worker in its boot window and
// send a second request while the first caller is still starting it.

import { test } from 'node:test';
import { createCppBrowserRuntimeProvider } from '../packages/runtime-cpp/src/browser-runtime-provider';
import { TraceCCCompilerService } from '../packages/runtime-cpp/src/tracecc-compiler-service';
import { createTraceCCRuntimeManifest } from '../packages/runtime-cpp/src/tracecc-runtime-assets';

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
      reply(message.type === 'compile-trusted-tracecc'
        ? { success: true, outputBytes: MINIMAL_WASM.slice(), stdout: '', stderr: '', timings: {} }
        : { success: true });
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
      LearnerWorker.compileRequests += 1;
      this.pendingPreparation = message;
      queueMicrotask(() => deliver(this.onmessage, {
        type: 'compile-request',
        requestId: `learner-compile-${LearnerWorker.compileRequests}`,
        protocolToken: message.protocolToken,
        payload: { driverSource: `driver:${String(message.payload?.code ?? '')}` },
      }));
      return;
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
  LearnerWorker.instances = [];
  LearnerWorker.compileRequests = 0;
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
  const lease = createCppBrowserRuntimeProvider().create({
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
    workerFactoryFor: () => undefined,
    preflight: () => async () => undefined,
    manifestAsset: () => undefined,
    manifestAssetCollection: () => undefined,
  } as never);
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

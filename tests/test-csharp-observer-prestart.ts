#!/usr/bin/env npx tsx

// Fix A (CSHARP-FIX-FORWARD.md): the C# observer runner is created and
// primed when the observation lease is prepared, not inside observe().
//
// Every command each worker receives is journaled with the worker's index
// and role, together with marks for the provider calls. The assertions read
// command order only; nothing here depends on timing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCSharpBrowserRuntimeProvider } from '../packages/runtime-csharp/src/browser-runtime-provider';
import { CSharpWorkerClient } from '../packages/runtime-csharp/src/csharp-worker-client';
import type { CSharpRuntimeClient } from '../packages/runtime-csharp/src/csharp-runtime-client';
import { encodeTraceClrWireResult } from '../packages/runtime-csharp/src/traceclr-wire';
import { createBrowserRuntimeHost, createBrowserRuntimeProviderRegistry } from '../packages/runtime-browser/src';
import { createBrowserJudgeHostFromRuntimeHost } from '../src/internal/browser-judge';
import { createAlgorithmJudgeBundle } from '../src/judge';
import type { BrowserRuntimeProviderContext } from '../packages/runtime-browser/src/runtime-provider-registry';
import type { BrowserRuntimeJudgeReceiptLease } from '../packages/runtime-browser/src/browser-runtime-host-internal';

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: Record<string, unknown>;
  protocolToken?: string;
}

interface JournalEntry {
  readonly worker: number;
  readonly role: string;
  readonly type: string;
  readonly detail?: string;
  readonly functionName?: string;
}

const PRIME_INPUTS = { a: 1, b: 2 };
const INT_WIRE = {
  parameters: [{ name: 'value', type: { wireType: 'int32' } }],
  returnType: { wireType: 'int32' },
};

class JournalWorker {
  static journal: JournalEntry[] = [];
  static instances: JournalWorker[] = [];
  /** While set, every trusted prime waits for it before replying. */
  static primeGate: Promise<void> | undefined;
  /** Prime replies for runner workers whose index is in this set fail. */
  static failPrimeFor = new Set<number>();
  /** Compile requests in these modes fail as a learner compile error. */
  static failCompileModes = new Set<string>();
  static compilerWarmupFails = false;
  static fastOrdinary = false;
  static beforePrepare: ((functionName: string, mode: string) => Promise<void> | undefined) | undefined;
  static beforeRelease: ((artifactKey: string) => Promise<void> | undefined) | undefined;
  static beforeObserve: (() => Promise<void>) | undefined;
  static beforeCode: ((value: unknown) => Promise<void> | undefined) | undefined;

  readonly index: number;
  role = 'unknown';
  terminated = false;
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor(readonly url: string | URL) {
    this.index = JournalWorker.instances.length;
    JournalWorker.instances.push(this);
    queueMicrotask(() => {
      this.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent<WorkerMessage>);
    });
  }

  static reset(): void {
    JournalWorker.journal = [];
    JournalWorker.instances = [];
    JournalWorker.primeGate = undefined;
    JournalWorker.failPrimeFor = new Set();
    JournalWorker.failCompileModes = new Set();
    JournalWorker.compilerWarmupFails = false;
    JournalWorker.fastOrdinary = false;
    JournalWorker.beforePrepare = undefined;
    JournalWorker.beforeRelease = undefined;
    JournalWorker.beforeObserve = undefined;
    JournalWorker.beforeCode = undefined;
  }

  static mark(label: string): void {
    JournalWorker.journal.push({ worker: -1, role: 'provider', type: `mark:${label}` });
  }

  postMessage(message: WorkerMessage): void {
    const payload = message.payload ?? {};
    if (typeof payload.runtimeRole === 'string') this.role = payload.runtimeRole;
    const inputs = payload.inputs as Record<string, unknown> | undefined;
    const prime = message.type === 'execute-prepared-code' &&
      inputs?.a === PRIME_INPUTS.a && inputs?.b === PRIME_INPUTS.b;
    const observation = message.type === 'execute-prepared-trace' && payload.observation !== undefined;
    JournalWorker.journal.push({
      worker: this.index,
      role: this.role,
      type: prime ? 'prime' : observation ? 'observe' : message.type,
      ...(message.type === 'prepare-program' ? { detail: String(payload.mode) } : {}),
      ...(message.type === 'dispose-prepared-program' ? { detail: String(payload.compiledArtifactKey) } : {}),
      ...(typeof payload.functionName === 'string' ? { functionName: payload.functionName } : {}),
    });
    const reply = (replyPayload: unknown): void => {
      if (this.terminated) return;
      this.onmessage?.({
        data: { id: message.id, type: message.type, payload: replyPayload, protocolToken: message.protocolToken },
      } as MessageEvent<WorkerMessage>);
    };
    void (async () => {
      await Promise.resolve();
      switch (message.type) {
        case 'init':
          reply({ success: true, loadTimeMs: 1 });
          return;
        case 'warmup':
          if (this.role === 'compiler' && JournalWorker.compilerWarmupFails) {
            reply({ success: false, error: 'mock compiler warmup failure', loadTimeMs: 1 });
            return;
          }
          reply({
            success: true,
            loadTimeMs: 1,
            ...(this.role === 'compiler'
              ? {
                  trustedPreparedArtifact: {
                    mode: 'trace',
                    code: 'public class Solution { public int Add(int a, int b) => a + b; }',
                    functionName: 'Add',
                    executionStyle: 'solution-method',
                    compiledArtifactKey: 'trusted-prime',
                    compiledArtifactBase64: 'TVqQAAMAAAAEAAAA',
                    compiledArtifactSha256: 'ab'.repeat(32),
                    preparedRunnerTier: 'compatibility',
                    preparedRunnerReason: 'trusted compiler prime',
                  },
                }
              : {}),
          });
          return;
        case 'prepare-program': {
          const mode = String(payload.mode);
          const functionName = String(payload.functionName);
          await JournalWorker.beforePrepare?.(functionName, mode);
          if (JournalWorker.failCompileModes.has(mode)) {
            reply({
              success: false,
              error: 'CS1002: ; expected',
              diagnostics: [{ file: 'solution.cs', line: 1, column: 1, message: '; expected', severity: 'error' }],
              consoleOutput: [],
            });
            return;
          }
          // Ordinary assemblies take the compatibility tier and the companion
          // the algorithm-fast tier, so one fixture covers both runner shapes.
          const fast = mode === 'trace' || JournalWorker.fastOrdinary;
          reply({
            success: true,
            compiledArtifactKey: JournalWorker.fastOrdinary ? `${mode}-${functionName}` : `${mode}-artifact`,
            compiledArtifactBase64: 'TVqQAAMAAAAEAAAA',
            compiledArtifactSha256: (fast ? 'cd' : 'ef').repeat(32),
            preparedRunnerTier: fast ? 'algorithm-fast' : 'compatibility',
            preparedRunnerReason: fast ? 'direct wire driver' : 'compatibility driver',
            ...(fast ? { traceClrWireContract: INT_WIRE } : {}),
            consoleOutput: [],
          });
          return;
        }
        case 'execute-prepared-code':
          if (prime) {
            await JournalWorker.primeGate;
            reply({
              success: true,
              output: JournalWorker.failPrimeFor.has(this.index) ? 4 : 3,
              consoleOutput: [],
            });
            return;
          }
          await JournalWorker.beforeCode?.(inputs?.value);
          reply({
            success: true, output: inputs?.value ?? null, consoleOutput: [],
            ...(JournalWorker.fastOrdinary ? { outputBytes: encodeTraceClrWireResult(INT_WIRE, inputs?.value) } : {}),
          });
          return;
        case 'execute-prepared-trace': {
          if (observation) await JournalWorker.beforeObserve?.();
          const observationPayload = payload.observation as { attemptToken?: unknown } | undefined;
          reply({
            success: true,
            observationStatus: 'drawn',
            events: [{ kind: 'line', runId: 'csharp:run', file: 'solution.cs', line: 1 }],
            observation: { attemptToken: observationPayload?.attemptToken },
          });
          return;
        }
        case 'dispose-prepared-program':
          await JournalWorker.beforeRelease?.(String(payload.compiledArtifactKey));
          reply({ success: true });
          return;
        default:
          reply({ success: true });
      }
    })();
  }

  terminate(): void {
    this.terminated = true;
  }
}

function createLease(): BrowserRuntimeJudgeReceiptLease {
  const context = {
    assets: {
      csharpWorker: '/workers/csharp-worker.js',
      csharpAssetBaseUrl: '/workers/vendor/csharp',
      csharpCompilerAssetBaseUrl: '/workers/vendor/csharp-compiler',
      csharpRunnerAssetBaseUrl: '/workers/vendor/csharp-runner',
    },
    debug: false,
    workerLifecyclePolicy: 'warm-and-retire',
    workerFactoryFor: () => (url: string | URL) => new JournalWorker(url) as unknown as Worker,
    preflight: () => async () => undefined,
    manifestAsset: () => undefined,
    manifestAssetCollection: () => undefined,
  } as unknown as BrowserRuntimeProviderContext;
  return createCSharpBrowserRuntimeProvider().create(context) as BrowserRuntimeJudgeReceiptLease;
}

const PROGRAM = {
  code: 'public class Solution { public int Echo(int value) => value; }',
  functionName: 'Echo',
  executionStyle: 'solution-method' as const,
};

async function whileHeld<T>(work: Promise<T>, describe: string): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(describe)), 1_000);
  try {
    return await Promise.race([work, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function createCompilerClient() {
  return new CSharpWorkerClient({
    workerUrl: '/workers/csharp-worker.js',
    assetBaseUrl: '/workers/vendor/csharp-compiler',
    runtimeRole: 'compiler',
    workerFactory: (url) => new JournalWorker(url) as unknown as Worker,
  });
}

function compileOrder(): string[] {
  return JournalWorker.journal.flatMap((entry) =>
    entry.type === 'prepare-program' ? [entry.functionName!] : []);
}

function createCSharpJudge(lease: BrowserRuntimeJudgeReceiptLease) {
  return createBrowserJudgeHostFromRuntimeHost(createBrowserRuntimeHost({
    providers: ['csharp'],
    providerRegistry: createBrowserRuntimeProviderRegistry([{
      id: 'csharp-test', languages: ['csharp'], create: () => lease,
    }]),
    featureOverrides: { worker: true, webAssembly: true, webCrypto: true, sharedArrayBuffer: true, crossOriginIsolated: true },
  }));
}

function csharpBundle(label: string, value: number) {
  return createAlgorithmJudgeBundle({
    id: `csharp-review-${label}`, language: 'csharp',
    code: PROGRAM.code.replace('Echo', `Echo${label}`),
    functionName: `Echo${label}`, executionStyle: PROGRAM.executionStyle,
    cases: [{ id: label, input: { value }, expected: value }],
  });
}

test('the C# Judge provider preserves Roslyn when disposing a running drawing before a new compile', async () => {
  JournalWorker.reset();
  const host = createCSharpJudge(createLease());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const [a, b] = await Promise.all([csharpBundle('A', 7), csharpBundle('B', 8)]);
    JournalWorker.beforePrepare = (name, mode) => {
      if (name !== 'EchoA' || mode !== 'trace') return;
      entered.resolve();
      return release.promise;
    };
    const first = await host.execute({
      bundle: a, interactive: true, drawingDelivery: 'after-verdict', tracing: { caseIds: ['A'] },
    });
    assert.ok(first.executionId);
    await whileHeld(entered.promise, 'A companion never reached Roslyn');
    const compiler = JournalWorker.instances.find(({ role }) => role === 'compiler')!;
    const drawing = host.execute({ executionId: first.executionId, tracing: { caseIds: ['A'] } });
    const rejectedDrawing = assert.rejects(drawing, { name: 'JudgePlanError' });
    void rejectedDrawing.catch(() => undefined);
    await whileHeld(host.disposeExecution(first.executionId), 'A dispose waited for its companion');
    const second = host.execute({ bundle: b, interactive: true, drawingDelivery: 'after-verdict' });
    void second.catch(() => undefined);
    await whileHeld(rejectedDrawing, 'A drawing did not detach');
    assert.equal(compiler.terminated, false);
    assert.deepEqual(compileOrder(), ['EchoA', 'EchoA']);
    release.resolve();
    assert.equal((await whileHeld(second, 'B did not finish')).evaluation.cases[0]?.verdict.kind, 'passed');
    assert.deepEqual(compileOrder(), ['EchoA', 'EchoA', 'EchoB']);
    assert.deepEqual(JournalWorker.instances.filter(({ role }) => role === 'compiler'), [compiler]);
    assert.equal(compiler.terminated, false);
  } finally {
    release.resolve();
    host.dispose();
  }
});

for (const route of ['joined', 'submit'] as const) {
  test(`C# ${route} verdict does not await compiler cleanup behind a drawing`, async () => {
    JournalWorker.reset();
    JournalWorker.fastOrdinary = true;
    const host = createCSharpJudge(createLease());
    const drawingEntered = Promise.withResolvers<void>();
    const releaseDrawing = Promise.withResolvers<void>();
    const codeEntered = Promise.withResolvers<void>();
    const releaseCode = Promise.withResolvers<void>();
    const cleanupPosted = Promise.withResolvers<void>();
    try {
      const [a, b, c, d] = await Promise.all([
        csharpBundle('A', 7), csharpBundle('B', 8), csharpBundle('C', 9), csharpBundle('D', 10),
      ]);
      const deferred = { interactive: true as const, drawingDelivery: 'after-verdict' as const };
      const first = await host.execute({ bundle: a, ...deferred });
      const third = await host.execute({ bundle: c, ...deferred });
      assert.ok(first.executionId && third.executionId);
      JournalWorker.beforePrepare = (name, mode) => {
        if (name !== 'EchoA' || mode !== 'trace') return;
        drawingEntered.resolve();
        return releaseDrawing.promise;
      };
      JournalWorker.beforeCode = (value) => {
        if (value !== 8) return;
        codeEntered.resolve();
        return releaseCode.promise;
      };
      JournalWorker.beforeRelease = (key) => {
        if (key === 'code-EchoB') cleanupPosted.resolve();
        return undefined;
      };
      const second = route === 'joined'
        ? host.execute({ bundle: b, interactive: true })
        : host.evaluateAlgorithm({ bundle: b });
      void second.catch(() => undefined);
      await whileHeld(codeEntered.promise, 'B did not enter its ordinary case');
      const drawing = host.execute({ executionId: first.executionId, tracing: { caseIds: ['A'] } });
      void drawing.catch(() => undefined);
      await whileHeld(drawingEntered.promise, 'A companion never reached Roslyn');
      const laterDrawing = host.execute({ executionId: third.executionId, tracing: { caseIds: ['C'] } });
      void laterDrawing.catch(() => undefined);
      await settle();
      releaseCode.resolve();
      assert.equal((await whileHeld(second, `${route} verdict waited for A's drawing`)).evaluation.cases[0]?.verdict.kind, 'passed');
      const queuedRun = host.execute({ bundle: d, ...deferred });
      void queuedRun.catch(() => undefined);
      await settle();
      releaseDrawing.resolve();
      await whileHeld(Promise.all([queuedRun, drawing, laterDrawing, cleanupPosted.promise]), 'queued compile, cleanup and drawings did not finish');
      const cleanup = JournalWorker.journal.findIndex(({ type, detail }) => type === 'dispose-prepared-program' && detail === 'code-EchoB');
      const compile = JournalWorker.journal.findIndex(({ type, detail, functionName }) =>
        type === 'prepare-program' && detail === 'code' && functionName === 'EchoD');
      const queued = JournalWorker.journal.findIndex(({ type, detail, functionName }) =>
        type === 'prepare-program' && detail === 'trace' && functionName === 'EchoC');
      assert.ok(compile >= 0 && compile < cleanup && cleanup < queued,
        'ordinary cleanup should post after queued ordinary compiles and ahead of queued companions');
    } finally {
      releaseCode.resolve();
      releaseDrawing.resolve();
      host.dispose();
    }
  });
}

test('C# uses a fresh ordinary runner if its replacement spare stalls while priming', async () => {
  JournalWorker.reset();
  JournalWorker.fastOrdinary = true;
  const lease = createLease();
  const finishPrime = Promise.withResolvers<void>();
  try {
    const { provider, standby } = await warmPage(lease);
    const first = await provider.prepareProgram({ ...PROGRAM, mode: 'code' });
    assert.ok(first.kind === 'prepared' && first.program.mode === 'code');
    assert.equal((await first.program.executeIsolated({ inputs: { value: 7 } })).kind, 'completed');
    JournalWorker.primeGate = finishPrime.promise;
    await first.program.dispose();
    await settle();
    const spare = runnerWorkers().find((worker) => worker !== standby && commandsOf(worker.index).includes('prime'));
    assert.ok(spare, 'the replacement spare reached the held prime');
    const second = await provider.prepareProgram({ ...PROGRAM, functionName: 'EchoB', mode: 'code' });
    assert.ok(second.kind === 'prepared' && second.program.mode === 'code');
    const result = await whileHeld(second.program.executeIsolated({ inputs: { value: 8 } }), 'B waited for the stalled spare');
    assert.equal(result.kind, 'completed');
    assert.equal(JournalWorker.journal.filter(({ type }) => type === 'execute-prepared-code').length, 2);
    assert.ok(!commandsOf(spare.index).includes('execute-prepared-code'));
    await second.program.dispose();
  } finally {
    finishPrime.resolve();
    lease.dispose();
  }
});

test('Roslyn admits an ordinary compile ahead of a queued companion', async () => {
  JournalWorker.reset();
  const compiler = createCompilerClient();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await compiler.warmup();
    JournalWorker.beforePrepare = (name) => {
      if (name !== 'Running') return;
      entered.resolve();
      return release.promise;
    };
    const a = compiler.prepareProgram({ ...PROGRAM, functionName: 'Running', mode: 'trace' }, 'observer');
    await entered.promise;
    const queued = compiler.prepareProgram({ ...PROGRAM, functionName: 'Queued', mode: 'trace' }, 'observer');
    const b = compiler.prepareProgram({ ...PROGRAM, functionName: 'Ordinary', mode: 'code' });
    assert.deepEqual(compileOrder(), ['Running']);
    release.resolve();
    await Promise.all([a, queued, b]);
    assert.deepEqual(compileOrder(), ['Running', 'Ordinary', 'Queued']);
  } finally {
    release.resolve();
    compiler.terminate();
  }
});

test('disposing a running and a queued Roslyn companion detaches both without closing the compiler session', async () => {
  JournalWorker.reset();
  const compiler = createCompilerClient();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const discarded = Promise.withResolvers<void>();
  const abortA = new AbortController();
  const abortB = new AbortController();
  const requests: Promise<unknown>[] = [];
  try {
    await compiler.warmup();
    const worker = JournalWorker.instances[0]!;
    JournalWorker.beforePrepare = (name) => {
      if (name !== 'Running') return;
      entered.resolve();
      return release.promise;
    };
    JournalWorker.beforeRelease = () => {
      discarded.resolve();
      return undefined;
    };
    const a = compiler.prepareProgram({ ...PROGRAM, functionName: 'Running', mode: 'trace', signal: abortA.signal }, 'observer');
    requests.push(a.catch(() => {}));
    await entered.promise;
    const queued = compiler.prepareProgram({ ...PROGRAM, functionName: 'Queued', mode: 'trace', signal: abortA.signal }, 'observer');
    requests.push(queued.catch(() => {}));
    const b = compiler.prepareProgram({ ...PROGRAM, functionName: 'Ordinary', mode: 'code', signal: abortB.signal });
    requests.push(b.catch(() => {}));
    abortA.abort(new DOMException('A disposed', 'AbortError'));
    await whileHeld(Promise.all([
      assert.rejects(a, { name: 'AbortError' }),
      assert.rejects(queued, { name: 'AbortError' }),
    ]), 'queued and running observer must detach before the compiler is released');
    assert.equal(worker.terminated, false, 'disposing A cannot close the compiler session');
    release.resolve();
    assert.equal((await b).success, true);
    await whileHeld(discarded.promise, 'a detached artifact must be released');
    assert.deepEqual(compileOrder(), ['Running', 'Ordinary']);
    const releaseIndex = JournalWorker.journal.findIndex(({ type }) => type === 'dispose-prepared-program');
    const bIndex = JournalWorker.journal.findIndex(({ functionName }) => functionName === 'Ordinary');
    assert.ok(releaseIndex > bIndex, 'detached artifact cleanup yields to B');
    assert.equal(JournalWorker.instances.length, 1);
  } finally {
    abortB.abort();
    release.resolve();
    compiler.terminate();
    await Promise.all(requests);
  }
});

test('a Roslyn companion held in the compiler queue refuses at its preparation deadline', async () => {
  JournalWorker.reset();
  const lease = createLease();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const { provider } = await warmPage(lease);
    JournalWorker.beforePrepare = (name) => {
      if (name !== 'Blocking') return;
      entered.resolve();
      return release.promise;
    };
    const blocking = provider.prepareProgram({ ...PROGRAM, functionName: 'Blocking', mode: 'code' });
    await entered.promise;
    const observer = await (provider as CSharpRuntimeClient).prepareObservation(PROGRAM, undefined, {}, 10);
    assert.ok(!('status' in observer));
    const drawing = observer.observe({ program: PROGRAM, inputs: { value: 7 }, attemptToken: 'held' });
    assert.deepEqual(await whileHeld(drawing, 'the queued observer missed its preparation deadline'),
      { status: 'refused', reason: 'observer-timeout' });
    assert.deepEqual(compileOrder(), ['Blocking']);
    release.resolve();
    const artifact = await blocking;
    assert.ok(artifact.kind === 'prepared');
    await artifact.program.dispose();
    await observer.dispose();
    assert.deepEqual(compileOrder(), ['Blocking'], 'expired preparation never reaches the compiler');
    assert.equal(JournalWorker.instances.filter(({ role }) => role === 'compiler').length, 1);
  } finally {
    release.resolve();
    lease.dispose();
  }
});

for (const disposeA of [false, true]) {
  test(`deferred C# Run B uses a primed spare while A's compiler release is held (dispose A: ${disposeA})`, async () => {
    JournalWorker.reset();
    JournalWorker.fastOrdinary = true;
    const lease = createLease();
    const runtime = createBrowserRuntimeHost({
      providers: ['csharp'],
      providerRegistry: createBrowserRuntimeProviderRegistry([{
        id: 'csharp-spare-test', languages: ['csharp'], create: () => lease,
      }]),
      featureOverrides: { worker: true, webAssembly: true, webCrypto: true, sharedArrayBuffer: true, crossOriginIsolated: true },
    });
    const host = createBrowserJudgeHostFromRuntimeHost(runtime);
    const releaseHeld = Promise.withResolvers<void>();
    const releaseA = Promise.withResolvers<void>();
    const observationStarted = Promise.withResolvers<void>();
    const finishDrawing = Promise.withResolvers<void>();
    const bundle = (label: 'A' | 'B', value: number) => createAlgorithmJudgeBundle({
      id: `csharp-spare-${label}`, language: 'csharp',
      code: PROGRAM.code.replace('Echo', `Echo${label}`),
      functionName: `Echo${label}`,
      executionStyle: PROGRAM.executionStyle,
      cases: [{ id: label, input: { value }, expected: value }],
    });
    try {
      await host.warmLanguage('csharp');
      JournalWorker.beforeRelease = (key) => {
        if (key === 'code-EchoA') releaseHeld.resolve();
        return key.endsWith('-EchoA') ? releaseA.promise : undefined;
      };
      JournalWorker.beforeObserve = () => {
        observationStarted.resolve();
        return finishDrawing.promise;
      };
      const [aBundle, bBundle] = await Promise.all([bundle('A', 7), bundle('B', 8)]);
      const verdictA = await host.execute({
        bundle: aBundle, interactive: true, drawingDelivery: 'after-verdict', tracing: { caseIds: ['A'] },
      });
      assert.equal(verdictA.evaluation.cases[0]?.verdict.kind, 'passed');
      assert.ok(verdictA.executionId);
      await whileHeld(Promise.all([releaseHeld.promise, observationStarted.promise]), 'A has no pending drawing and release');
      const drawingA = host.execute({ executionId: verdictA.executionId, tracing: { caseIds: ['A'] } });
      const outcomeA = drawingA.then((result) => result.evaluation.cases[0]?.attachment?.status, (error: Error) => error.name);
      if (disposeA) {
        await whileHeld(host.disposeExecution(verdictA.executionId), 'disposing A waited on the held compiler release');
      }
      const b = await whileHeld(host.execute({
        bundle: bBundle, interactive: true, drawingDelivery: 'after-verdict',
      }), 'B waited on the held compiler release');
      assert.equal(b.evaluation.cases[0]?.verdict.kind, 'passed');
      const executions = JournalWorker.journal.filter(({ type }) => type === 'execute-prepared-code');
      assert.equal(executions.length, 2);
      assert.notEqual(executions[0]!.worker, executions[1]!.worker);
      assert.deepEqual(commandsOf(executions[1]!.worker).slice(0, 4),
        ['init', 'warmup', 'prime', 'execute-prepared-code'], 'B must acquire warmed spare capacity');
      assert.equal(JournalWorker.instances.filter(({ role }) => role === 'compiler').length, 1);
      releaseA.resolve();
      finishDrawing.resolve();
      assert.equal(await outcomeA, disposeA ? 'JudgePlanError' : 'drawn');
    } finally {
      releaseA.resolve();
      finishDrawing.resolve();
      host.dispose();
    }
  });
}

type ObservationLease = {
  observe(call: { program: typeof PROGRAM; inputs: Record<string, unknown>; attemptToken: string; signal?: AbortSignal }): Promise<{ status: string }>;
  dispose(): Promise<void>;
};

async function prepareObservation(lease: BrowserRuntimeJudgeReceiptLease): Promise<ObservationLease> {
  const provider = lease.judgeReceiptProviders?.get('csharp');
  assert.ok(provider, 'C# lease exposes its receipt provider');
  const prepared = await provider.prepareObservation(
    { ...PROGRAM, runtimeVersion: provider.runtimeVersion }, new AbortController().signal, {}
  );
  assert.ok(!('status' in prepared), `observation lease prepared, got ${JSON.stringify(prepared)}`);
  return prepared as unknown as ObservationLease;
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function runnerWorkers(): JournalWorker[] {
  return JournalWorker.instances.filter((worker) => worker.role === 'runner');
}

function commandsOf(worker: number): string[] {
  return JournalWorker.journal.filter((entry) => entry.worker === worker).map((entry) => entry.type);
}

function markIndex(label: string): number {
  const index = JournalWorker.journal.findIndex((entry) => entry.type === `mark:${label}`);
  assert.ok(index >= 0, `mark ${label} recorded`);
  return index;
}

/** Worker creations and live (not terminated) workers by role. */
function roleCounts(): Record<string, { created: number; live: number }> {
  const counts: Record<string, { created: number; live: number }> = {};
  for (const worker of JournalWorker.instances) {
    const entry = counts[worker.role] ??= { created: 0, live: 0 };
    entry.created += 1;
    if (!worker.terminated) entry.live += 1;
  }
  return counts;
}

async function warmPage(lease: BrowserRuntimeJudgeReceiptLease) {
  const provider = lease.preparedProviders.get('csharp');
  assert.ok(provider, 'C# lease exposes prepared execution');
  await provider.init();
  const standby = runnerWorkers();
  assert.equal(standby.length, 1, 'page warmup publishes one standby runner');
  return { provider, standby: standby[0]! };
}

test('A: the observer runner boots and runs the trusted prime at lease prepare, before observe()', async () => {
  JournalWorker.reset();
  const lease = createLease();
  try {
    const { provider, standby } = await warmPage(lease);
    const ordinary = await provider.prepareProgram({ ...PROGRAM, mode: 'code' });
    assert.ok(ordinary.kind === 'prepared' && ordinary.program.mode === 'code');

    JournalWorker.mark('prepare-observation');
    const observer = await prepareObservation(lease);
    await settle();
    JournalWorker.mark('observe');
    const observerRunners = runnerWorkers().filter((worker) => worker !== standby);
    assert.equal(observerRunners.length, 1, 'lease prepare creates exactly one observer runner');
    const observerWorker = observerRunners[0]!;
    const prepareMark = markIndex('prepare-observation');
    const observeMark = markIndex('observe');
    const beforeObserve = JournalWorker.journal
      .slice(prepareMark, observeMark)
      .filter((entry) => entry.worker === observerWorker.index)
      .map((entry) => entry.type);
    assert.deepEqual(beforeObserve, ['init', 'warmup', 'prime'],
      'the observer runner loads .NET and runs the trusted prime at lease prepare');

    const drawing = await observer.observe({ program: PROGRAM, inputs: { value: 7 }, attemptToken: 'attempt-1' });
    assert.equal(drawing.status, 'drawn');
    const afterObserve = JournalWorker.journal
      .slice(observeMark)
      .filter((entry) => entry.worker === observerWorker.index)
      .map((entry) => entry.type);
    assert.deepEqual(afterObserve, ['observe'],
      'observe() sends the drawing straight to the primed runner: no runtime load inside observe()');
    assert.equal(
      JournalWorker.journal.slice(observeMark).filter((entry) => entry.role === 'runner' && entry.type === 'init').length,
      0,
      'no runner loads a runtime while the learner waits for the drawing'
    );
    assert.deepEqual(
      JournalWorker.journal.slice(observeMark).filter((entry) => entry.type === 'prepare-program').map((entry) => entry.detail),
      ['trace'],
      'the companion still compiles inside the first observe(), on the shared compiler'
    );

    await observer.dispose();
    assert.equal(observerWorker.terminated, true, 'observation dispose terminates its runner');
    await ordinary.program.dispose();
  } finally {
    lease.dispose();
  }
});

test('A: the observer stays a separate runner; the standby still serves the ordinary run', async () => {
  JournalWorker.reset();
  const lease = createLease();
  try {
    const { provider, standby } = await warmPage(lease);
    const observer = await prepareObservation(lease);
    const ordinary = await provider.prepareProgram({ ...PROGRAM, mode: 'code' });
    assert.ok(ordinary.kind === 'prepared' && ordinary.program.mode === 'code');
    const result = await ordinary.program.executeBatchIsolated!({ inputBatch: [{ value: 1 }, { value: 2 }] });
    assert.deepEqual(result.map((row) => row.kind === 'completed' && row.output), [1, 2]);
    await observer.observe({ program: PROGRAM, inputs: { value: 1 }, attemptToken: 'attempt-1' });

    // Compatibility cases each take a fresh runner; the first takes the standby.
    assert.ok(commandsOf(standby.index).includes('execute-prepared-code'),
      'the first ordinary case runs on the page standby, not on the observer');
    assert.ok(!commandsOf(standby.index).includes('observe'), 'the standby never draws');
    const observerWorkers = JournalWorker.instances.filter((worker) => commandsOf(worker.index).includes('observe'));
    assert.equal(observerWorkers.length, 1);
    assert.notEqual(observerWorkers[0], standby);
    assert.ok(
      !commandsOf(observerWorkers[0]!.index).includes('execute-prepared-code'),
      'the observer runner never runs an ordinary learner case'
    );

    await observer.dispose();
    await ordinary.program.dispose();
  } finally {
    lease.dispose();
  }
});

test('A: a lease disposed before its first observe terminates the primed runner and starts nothing else', async () => {
  JournalWorker.reset();
  const lease = createLease();
  try {
    const { standby } = await warmPage(lease);
    const observer = await prepareObservation(lease);
    await settle();
    const created = JournalWorker.instances.length;
    const observerWorker = JournalWorker.instances.at(-1)!;
    assert.notEqual(observerWorker, standby, 'lease prepare created an observer runner');
    assert.equal(observerWorker.role, 'runner');
    assert.equal(observerWorker.terminated, false);
    await observer.dispose();
    await settle();
    assert.equal(observerWorker.terminated, true, 'the unused primed runner is terminated');
    assert.equal(JournalWorker.instances.length, created, 'disposal does not create replacement capacity');
  } finally {
    lease.dispose();
  }
});

test('A: disposing while the prime is in flight terminates the runner and never sends it learner code', async () => {
  JournalWorker.reset();
  const lease = createLease();
  try {
    await warmPage(lease);
    const gate = Promise.withResolvers<void>();
    JournalWorker.primeGate = gate.promise;
    const observer = await prepareObservation(lease);
    await settle();
    const observerWorker = JournalWorker.instances.at(-1)!;
    assert.deepEqual(commandsOf(observerWorker.index), ['init', 'warmup', 'prime']);
    const pending = observer.observe({ program: PROGRAM, inputs: { value: 3 }, attemptToken: 'attempt-1' });
    await settle();
    await observer.dispose();
    await assert.rejects(pending);
    gate.resolve();
    await settle();
    assert.equal(observerWorker.terminated, true);
    assert.ok(!commandsOf(observerWorker.index).includes('observe'), 'no learner code reaches the runner');
    assert.equal(
      JournalWorker.instances.filter((worker) => commandsOf(worker.index).includes('observe')).length,
      0,
      'no replacement runner draws after disposal'
    );
  } finally {
    JournalWorker.primeGate = undefined;
    lease.dispose();
  }
});

test('A: an aborted observe() while the prime is in flight rejects with the abort and retires the runner', async () => {
  JournalWorker.reset();
  const lease = createLease();
  try {
    await warmPage(lease);
    const gate = Promise.withResolvers<void>();
    JournalWorker.primeGate = gate.promise;
    const observer = await prepareObservation(lease);
    await settle();
    const observerWorker = JournalWorker.instances.at(-1)!;
    const controller = new AbortController();
    const pending = observer.observe({
      program: PROGRAM, inputs: { value: 3 }, attemptToken: 'attempt-1', signal: controller.signal,
    });
    await settle();
    const reason = new Error('observation backstop');
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    gate.resolve();
    await settle();
    assert.equal(observerWorker.terminated, true, 'the runner the aborted attempt was waiting for is retired');
    assert.ok(!commandsOf(observerWorker.index).includes('observe'));

    // A later attempt on the same lease (a redraw) still draws, on a fresh runner.
    const redraw = await observer.observe({ program: PROGRAM, inputs: { value: 4 }, attemptToken: 'attempt-2' });
    assert.equal(redraw.status, 'drawn');
    await observer.dispose();
  } finally {
    JournalWorker.primeGate = undefined;
    lease.dispose();
  }
});

test('A: a failed trusted prime retires that runner; observe() falls back to a fresh runner with the same drawing', async () => {
  JournalWorker.reset();
  const lease = createLease();
  try {
    await warmPage(lease);
    // The next worker created is the observer; fail its prime only.
    JournalWorker.failPrimeFor.add(JournalWorker.instances.length);
    const observer = await prepareObservation(lease);
    await settle();
    const failedWorker = JournalWorker.instances.at(-1)!;
    assert.deepEqual(commandsOf(failedWorker.index), ['init', 'warmup', 'prime']);
    assert.equal(failedWorker.terminated, true, 'a runner whose prime failed is retired before any learner code');
    const drawing = await observer.observe({ program: PROGRAM, inputs: { value: 5 }, attemptToken: 'attempt-1' });
    assert.equal(drawing.status, 'drawn');
    assert.ok(!commandsOf(failedWorker.index).includes('observe'));
    const drawers = JournalWorker.instances.filter((worker) => commandsOf(worker.index).includes('observe'));
    assert.equal(drawers.length, 1);
    assert.notEqual(drawers[0], failedWorker);
    await observer.dispose();
  } finally {
    lease.dispose();
  }
});

test('A: without a ready compiler the observer is runtime-warm only, as the standby is', async () => {
  JournalWorker.reset();
  JournalWorker.compilerWarmupFails = true;
  const lease = createLease();
  try {
    const observer = await prepareObservation(lease);
    await settle();
    const observerWorker = runnerWorkers().at(-1)!;
    assert.deepEqual(commandsOf(observerWorker.index), ['init', 'warmup'],
      'no trusted prime without the compiler artifact');
    assert.equal(observerWorker.terminated, false, 'a runtime-warm runner that ran nothing stays usable');
    await observer.dispose();
    assert.equal(observerWorker.terminated, true);
  } finally {
    lease.dispose();
  }
});

test('A: click-draw and continuation reuse the retained observer runner with one command each', async () => {
  JournalWorker.reset();
  const lease = createLease();
  try {
    await warmPage(lease);
    const observer = await prepareObservation(lease);
    await observer.observe({ program: PROGRAM, inputs: { value: 1 }, attemptToken: 'attempt-1' });
    const created = JournalWorker.instances.length;
    const drawer = JournalWorker.instances.find((worker) => commandsOf(worker.index).includes('observe'))!;
    JournalWorker.mark('click');
    const click = await observer.observe({ program: PROGRAM, inputs: { value: 2 }, attemptToken: 'attempt-2' });
    const next = await observer.observe({ program: PROGRAM, inputs: { value: 3 }, attemptToken: 'attempt-3' });
    assert.equal(click.status, 'drawn');
    assert.equal(next.status, 'drawn');
    assert.equal(JournalWorker.instances.length, created, 'clicks create no runner');
    const afterClick = JournalWorker.journal.slice(markIndex('click'));
    assert.deepEqual(afterClick.filter((entry) => entry.worker >= 0).map((entry) => [entry.worker, entry.type]), [
      [drawer.index, 'observe'],
      [drawer.index, 'observe'],
    ], 'each click is one command on the retained observer, with no compile');
    await observer.dispose();
    assert.equal(drawer.terminated, true);
  } finally {
    lease.dispose();
  }
});

test('A: language disposal during the prime retires the observer; observe() uses fresh capacity', async () => {
  JournalWorker.reset();
  const lease = createLease();
  try {
    await warmPage(lease);
    const gate = Promise.withResolvers<void>();
    JournalWorker.primeGate = gate.promise;
    const observer = await prepareObservation(lease);
    await settle();
    const observerWorker = JournalWorker.instances.at(-1)!;
    lease.disposeLanguage('csharp');
    gate.resolve();
    JournalWorker.primeGate = undefined;
    await settle();
    assert.equal(observerWorker.terminated, true);
    const drawing = await observer.observe({ program: PROGRAM, inputs: { value: 9 }, attemptToken: 'attempt-1' });
    assert.equal(drawing.status, 'drawn');
    assert.ok(!commandsOf(observerWorker.index).includes('observe'), 'the retired runner never draws');
    await observer.dispose();
  } finally {
    JournalWorker.primeGate = undefined;
    lease.dispose();
  }
});

test('A: worker counts by role for Run, Run with a click, compile-error Run and Submit', async () => {
  const scenarios: Record<string, Record<string, { created: number; live: number }>> = {};
  const run = async (name: string, body: (lease: BrowserRuntimeJudgeReceiptLease) => Promise<void>) => {
    JournalWorker.reset();
    const lease = createLease();
    try {
      await warmPage(lease);
      await body(lease);
      await settle();
      scenarios[name] = roleCounts();
    } finally {
      lease.dispose();
    }
  };
  const ordinaryBatch = async (lease: BrowserRuntimeJudgeReceiptLease) => {
    const provider = lease.preparedProviders.get('csharp')!;
    const prepared = await provider.prepareProgram({ ...PROGRAM, mode: 'code' });
    if (prepared.kind !== 'prepared' || prepared.program.mode !== 'code') return prepared;
    await prepared.program.executeBatchIsolated!({ inputBatch: [{ value: 1 }, { value: 2 }] });
    return prepared;
  };
  await run('submit', async (lease) => {
    const prepared = await ordinaryBatch(lease);
    if (prepared.kind === 'prepared') await prepared.program.dispose();
  });
  await run('run', async (lease) => {
    const observer = await prepareObservation(lease);
    const prepared = await ordinaryBatch(lease);
    await observer.observe({ program: PROGRAM, inputs: { value: 1 }, attemptToken: 'attempt-1' });
    if (prepared.kind === 'prepared') await prepared.program.dispose();
    await observer.dispose();
  });
  await run('run+click', async (lease) => {
    const observer = await prepareObservation(lease);
    const prepared = await ordinaryBatch(lease);
    await observer.observe({ program: PROGRAM, inputs: { value: 1 }, attemptToken: 'attempt-1' });
    if (prepared.kind === 'prepared') await prepared.program.dispose();
    await observer.observe({ program: PROGRAM, inputs: { value: 2 }, attemptToken: 'attempt-2' });
    await observer.dispose();
  });
  await run('compile-error run', async (lease) => {
    JournalWorker.failCompileModes.add('code');
    const observer = await prepareObservation(lease);
    const prepared = await ordinaryBatch(lease);
    assert.equal(prepared.kind, 'failed');
    await observer.dispose();
  });
  console.log(`C# worker counts by role (created/live at end, after page warmup):\n${
    Object.entries(scenarios).map(([name, counts]) => `  ${name}: ${
      Object.entries(counts).map(([role, { created, live }]) => `${role} ${created}/${live}`).join(', ')
    }`).join('\n')
  }`);
  // Before Fix A (68721fca): submit 3, run 4, run+click 4, compile-error run 1.
  // Submit: the standby, a fresh runner for the second compatibility case and
  // the replenishment. Run adds exactly one observer runner; a click adds none.
  assert.equal(scenarios.submit!.runner!.created, 3, 'Submit starts no observer');
  assert.equal(scenarios.run!.runner!.created, 4, 'Run: Submit\'s runners plus one observer');
  assert.equal(scenarios['run+click']!.runner!.created, 4, 'a click adds no runner');
  // The observer now boots at lease prepare, which Judge reaches before the
  // ordinary compile, so a compile-error Run boots one runner it never uses.
  assert.equal(scenarios['compile-error run']!.runner!.created, 2, 'compile-error Run: standby plus the unused observer');
  for (const [name, counts] of Object.entries(scenarios)) {
    assert.equal(counts.compiler!.created, 1, `${name}: one compiler`);
    assert.equal(counts.runner!.live, 1, `${name}: only the page standby is live afterwards`);
  }
});

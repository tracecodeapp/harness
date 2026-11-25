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
}

const PRIME_INPUTS = { a: 1, b: 2 };

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
          const fast = mode === 'trace';
          reply({
            success: true,
            compiledArtifactKey: `${mode}-artifact`,
            compiledArtifactBase64: 'TVqQAAMAAAAEAAAA',
            compiledArtifactSha256: (fast ? 'cd' : 'ef').repeat(32),
            preparedRunnerTier: fast ? 'algorithm-fast' : 'compatibility',
            preparedRunnerReason: fast ? 'direct wire driver' : 'compatibility driver',
            ...(fast
              ? {
                  traceClrWireContract: {
                    parameters: [{ name: 'value', type: { wireType: 'int32' } }],
                    returnType: { wireType: 'int32' },
                  },
                }
              : {}),
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
          reply({ success: true, output: inputs?.value ?? null, consoleOutput: [] });
          return;
        case 'execute-prepared-trace': {
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

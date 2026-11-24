#!/usr/bin/env npx tsx
/**
 * Python's shipped observation policy is sequential: a Run's drawing is made
 * after its verdict, on the verdict's own warm worker, and never by a second
 * worker started alongside the verdict.
 *
 * The real BrowserJudgeHost, Judge schedule, Python prepared provider and
 * PythonWorkerClient run against a worker double that speaks the worker
 * protocol (tests/fixtures/python-protocol-worker.ts). The double answers
 * one command at a time, in order, like the Pyodide worker, and journals
 * every command, so the tests read which worker did what, and when.
 *
 * Covered: the order (verdict batch, then observer prepare and execution on
 * the same worker), worker counts by role, the Run → click-draw → redraw →
 * Submit → Run sequence, an observer that fails, hangs or crashes (the
 * verdict is unchanged), the ordinary clock not reaching the observer, and
 * the verdicts that cannot hand their worker over (the observer then gets a
 * fresh worker, started only after the verdict).
 *
 * The interpreter-level reset proof (learner state, recorder, module state)
 * is tests/test-python-sequential-observation-reset.ts, on real Pyodide.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPythonPreparedExecutionProvider } from '../packages/runtime-python/src/index';
import { PythonWorkerClient } from '../packages/runtime-python/src/python-worker-client';
import { createAlgorithmJudgeBundle } from '../src/judge';
import { createBrowserJudgeHostFromRuntimeHost } from '../src/internal/browser-judge';
import type { JudgeReceiptProvider } from '../packages/runtime-browser/src/browser-runtime-host-internal';
import {
  createBrowserRuntimeHost,
  createBrowserRuntimeProviderRegistry,
} from '../packages/runtime-browser/src';
import {
  createProtocolWorld,
  type ProtocolCommand,
  type ProtocolWorkerBehaviour,
  type ProtocolWorld,
} from './fixtures/python-protocol-worker';

const CODE = 'def solve(value):\n    return value';
const CASES = ['a', 'b', 'c', 'd'].map((id, index) => ({
  id,
  input: { value: index + 1 },
  expected: index + 1,
}));

interface Fixture {
  readonly world: ProtocolWorld;
  readonly host: ReturnType<typeof createBrowserJudgeHostFromRuntimeHost>;
  readonly provider: ReturnType<typeof createPythonPreparedExecutionProvider>;
  dispose(): void;
}

async function fixture(
  behaviour: ProtocolWorkerBehaviour = {},
  capabilities: { observationDeadlineMs?: number } = {}
): Promise<Fixture> {
  const world = createProtocolWorld(behaviour);
  const provider = createPythonPreparedExecutionProvider({
    // The browser's warm-and-retire policy: a used worker is replaced by a
    // fresh standby when its program is disposed.
    replenishStandbyAfterUse: true,
    createWorkerClient: () => new PythonWorkerClient({
      workerUrl: 'python-worker.js',
      debug: false,
      workerFactory: () => world.factory() as never,
    }),
  });
  const runtimeHost = createBrowserRuntimeHost({
    providerRegistry: createBrowserRuntimeProviderRegistry([{
      id: 'python-protocol-double',
      languages: ['python'],
      create() {
        return {
          preparedProviders: new Map([['python', provider]] as const),
          // The Python browser provider's receipt registration
          // (packages/runtime-python/src/browser-runtime-provider.ts).
          judgeReceiptProviders: new Map([['python', {
            runtimeVersion: 'python-protocol-double',
            capabilities: {
              observationLease: 'separate' as const,
              observationDeadlineMs: capabilities.observationDeadlineMs ?? 15_000,
              observationPrepareDeadlineMs: 30_000,
              stoppingBatchAdmission: 'worker-start' as const,
              nonStoppingBatchAdmission: 'worker-start' as const,
              observationReplyOwnership: 'transferred' as const,
            },
            prepareObservation: (program, signal, traceOptions) =>
              provider.prepareObservation(program, signal, traceOptions),
          } satisfies JudgeReceiptProvider]] as const),
          disposeLanguage() {},
          dispose() {},
        };
      },
    }]),
    providers: ['python'],
    featureOverrides: {
      worker: true,
      webAssembly: true,
      webCrypto: true,
      sharedArrayBuffer: true,
      crossOriginIsolated: true,
    },
  });
  const host = createBrowserJudgeHostFromRuntimeHost(runtimeHost);
  // The page warms Python before the learner's first Run.
  await provider.init();
  return {
    world,
    host,
    provider,
    dispose() {
      host.dispose();
      provider.terminate();
    },
  };
}

function runBundle(limits?: { wallClockMs: number }) {
  return createAlgorithmJudgeBundle({
    id: 'python-sequential-observation',
    language: 'python',
    code: CODE,
    functionName: 'solve',
    executionStyle: 'function',
    trace: true,
    ...(limits ? { limits } : {}),
    cases: CASES,
  });
}

function submitBundle() {
  return createAlgorithmJudgeBundle({
    id: 'python-sequential-observation-submit',
    language: 'python',
    code: CODE,
    functionName: 'solve',
    executionStyle: 'function',
    cases: CASES,
  });
}

/** The parts of a row the verdict owns. */
function verdicts(evaluation: { status: string; cases?: readonly unknown[] }) {
  assert.equal(evaluation.status, 'completed');
  return (evaluation.cases ?? []).map((row) => {
    const { caseId, status, verdict, value, stdout, failure } = row as Record<string, unknown>;
    return { caseId, status, verdict: (verdict as { kind?: unknown } | undefined)?.kind, value, stdout, failure };
  });
}

function attachment(evaluation: { cases?: readonly unknown[] }, caseId: string) {
  const row = (evaluation.cases ?? []).find((entry) => (entry as { caseId: string }).caseId === caseId) as
    | { attachment?: { status: string; reason?: string } }
    | undefined;
  if (!row?.attachment) return undefined;
  const { status, reason } = row.attachment;
  return reason === undefined ? { status } : { status, reason };
}

const isPrepare = (command: ProtocolCommand) => command.type === 'prepare-program';
const isLearnerWork = (command: ProtocolCommand) => command.type.startsWith('execute-');
const isObserverWork = (command: ProtocolCommand) =>
  command.observationOnly === true || command.mode === 'trace';

/** Workers that prepared or executed anything, by worker id. */
function executionWorkers(world: ProtocolWorld, since = 0): number[] {
  return [...new Set(world.commands
    .filter((command) => command.seq > since && (isPrepare(command) || isLearnerWork(command)))
    .map((command) => command.worker))];
}

function describe(world: ProtocolWorld): string {
  return JSON.stringify(world.commands.map(({ worker, type, mode, observationOnly, seq, startedAt, repliedAt }) =>
    ({ worker, type, mode, observationOnly, seq, startedAt, repliedAt })));
}

const EXPECTED_VERDICTS = CASES.map(({ id, expected }) => ({
  caseId: id,
  status: 'completed',
  verdict: 'passed',
  value: expected,
  stdout: '',
  failure: undefined,
}));

test('a Run draws on the verdict worker, after the verdict batch', async () => {
  const { world, host, dispose } = await fixture();
  try {
    const before = world.seq;
    const initial = await host.execute({ bundle: await runBundle(), interactive: true, tracing: { caseIds: ['b'] } });
    assert.deepEqual(verdicts(initial.evaluation), EXPECTED_VERDICTS);
    assert.equal(attachment(initial.evaluation, 'b')?.status, 'drawn');

    // One worker prepared and executed everything for this Run.
    assert.deepEqual(executionWorkers(world, before), [0], describe(world));
    const work = world.commands.filter((command) => command.seq > before && (isPrepare(command) || isLearnerWork(command)));
    assert.deepEqual(
      work.map(({ type, mode, observationOnly }) => ({ type, mode, observationOnly })),
      [
        { type: 'prepare-program', mode: 'code', observationOnly: undefined },
        { type: 'execute-prepared-program-batch', mode: 'code', observationOnly: undefined },
        { type: 'prepare-program', mode: 'trace', observationOnly: true },
        { type: 'execute-prepared-program', mode: 'trace', observationOnly: true },
      ],
      describe(world)
    );
    // The verdict comes first: the observer's prepare reaches the worker
    // only after every case of the verdict batch finished, and the worker
    // starts it only after the batch replied.
    const [, batch, observerPrepare] = work;
    const lastCaseFinished = Math.max(...world.cases.filter((event) => event.phase === 'finished').map((event) => event.seq));
    assert.ok(observerPrepare!.seq > lastCaseFinished, describe(world));
    assert.ok(observerPrepare!.startedAt! > batch!.repliedAt!, describe(world));
    // It is queued behind the batch rather than sent after the page has
    // handled the batch reply, so the worker goes straight from one to the
    // other.
    assert.ok(observerPrepare!.seq < batch!.repliedAt!, describe(world));
    // No second Python worker ran alongside the verdict.
    assert.equal(world.maxBusyWorkers, 1);
    // Created: the page's standby (now the observer) and its replacement.
    assert.equal(world.workers.length, 2, describe(world));
    assert.equal(world.workers[0]!.terminated, false, 'the observer keeps its worker for click-draws');
    assert.equal(world.workers[1]!.executions, 0, 'the replacement is a clean standby');
    await host.disposeExecution(initial.executionId!);
    assert.equal(world.workers[0]!.terminated, true, 'disposing the execution retires the observer worker');
  } finally {
    dispose();
  }
});

test('worker counts by role across Run, click-draw, redraw, Submit and Run', async () => {
  const { world, host, dispose } = await fixture();
  try {
    const bundle = await runBundle();
    // Run 1: the standby (worker 0) judges and then draws.
    const run1 = await host.execute({ bundle, interactive: true, tracing: { caseIds: ['a'] } });
    assert.deepEqual(verdicts(run1.evaluation), EXPECTED_VERDICTS);
    assert.equal(attachment(run1.evaluation, 'a')?.status, 'drawn');
    assert.deepEqual(world.workers.map((worker) => worker.terminated), [false, false], describe(world));

    // Click-draw: the retained observer (worker 0) draws, nothing is created.
    let mark = world.seq;
    const click = await host.execute({ executionId: run1.executionId!, tracing: { caseIds: ['c'] } });
    assert.equal(attachment(click.evaluation, 'c')?.status, 'drawn');
    assert.deepEqual(
      world.commands.filter((command) => command.seq > mark && isLearnerWork(command))
        .map(({ worker, type, observationOnly }) => ({ worker, type, observationOnly })),
      [{ worker: 0, type: 'execute-prepared-program', observationOnly: true }]
    );
    assert.equal(world.workers.length, 2);

    // Redraw: a cached drawing, no worker command.
    mark = world.seq;
    const redraw = await host.execute({ executionId: run1.executionId!, tracing: { caseIds: ['a'] } });
    assert.equal(attachment(redraw.evaluation, 'a')?.status, 'drawn');
    assert.deepEqual(world.commands.filter((command) => command.seq > mark && isLearnerWork(command)), []);

    // Submit: the standby (worker 1) judges; no observer, no trace work.
    mark = world.seq;
    const submit = await host.evaluateAlgorithm({ bundle: await submitBundle() });
    assert.deepEqual(verdicts(submit.evaluation), EXPECTED_VERDICTS);
    const submitWork = world.commands.filter((command) => command.seq > mark && (isPrepare(command) || isLearnerWork(command)));
    assert.deepEqual(
      submitWork.map(({ worker, type, mode }) => ({ worker, type, mode })),
      [
        { worker: 1, type: 'prepare-program', mode: 'code' },
        { worker: 1, type: 'execute-prepared-program-batch', mode: 'code' },
      ],
      describe(world)
    );
    assert.equal(submitWork.some(isObserverWork), false);
    // Submit's worker is retired and replaced (worker 2).
    assert.equal(world.workers.length, 3, describe(world));
    assert.equal(world.workers[1]!.terminated, true);

    // The app releases Run 1 before the next Run.
    await host.disposeExecution(run1.executionId!);
    assert.equal(world.workers[0]!.terminated, true);

    // Run 2: the new standby (worker 2), which never ran an observer, judges
    // and then draws. One replacement standby is created (worker 3).
    mark = world.seq;
    const run2 = await host.execute({ bundle, interactive: true, tracing: { caseIds: ['d'] } });
    assert.deepEqual(verdicts(run2.evaluation), EXPECTED_VERDICTS);
    assert.equal(attachment(run2.evaluation, 'd')?.status, 'drawn');
    assert.deepEqual(executionWorkers(world, mark), [2], describe(world));
    assert.equal(world.workers.length, 4, describe(world));
    assert.equal(world.workers[3]!.executions, 0);
    await host.disposeExecution(run2.executionId!);

    // Never more than one worker prepared or ran learner code at a time,
    // and every Run created exactly one worker: its replacement standby.
    assert.equal(world.maxBusyWorkers, 1);
    assert.deepEqual(world.live().map((worker) => worker.id), [3]);
  } finally {
    dispose();
  }
});

for (const [label, behaviour, reason] of [
  ['fails to prepare', { observerPrepareFails: true }, 'observer-prepare'],
  ['hangs', { observerExecution: 'hangs' }, 'observer-timeout'],
  ['crashes its worker', { observerExecution: 'crashes' }, 'observer-runtime'],
] as const) {
  test(`an observer that ${label} leaves the verdict unchanged`, async () => {
    const { world, host, dispose } = await fixture(behaviour, { observationDeadlineMs: 300 });
    try {
      const run = await host.execute({ bundle: await runBundle(), interactive: true, tracing: { caseIds: ['c'] } });
      assert.deepEqual(verdicts(run.evaluation), EXPECTED_VERDICTS);
      assert.deepEqual(attachment(run.evaluation, 'c'), { status: 'refused', reason });
      // The observer ran (or tried to) on the verdict's worker, after it.
      const observer = world.commands.filter(isObserverWork);
      assert.ok(observer.length > 0, describe(world));
      assert.ok(observer.every((command) => command.worker === 0), describe(world));
      assert.equal(world.maxBusyWorkers, 1);
      await host.disposeExecution(run.executionId!);
      // A failed observer's worker never outlives the execution.
      assert.equal(world.workers[0]!.terminated, true);
    } finally {
      dispose();
    }
  });
}

test('the verdict batch clock does not reach the observer on the same worker', async () => {
  // A 100 ms per-case limit, and a drawing that takes 600 ms: if the
  // stopping batch's case clock survived the batch, it would terminate the
  // worker under the observer.
  const { world, host, dispose } = await fixture({ observerDelayMs: 600 });
  try {
    const run = await host.execute({ bundle: await runBundle({ wallClockMs: 100 }), interactive: true, tracing: { caseIds: ['a'] } });
    assert.deepEqual(verdicts(run.evaluation), EXPECTED_VERDICTS);
    assert.equal(attachment(run.evaluation, 'a')?.status, 'drawn');
    assert.deepEqual(world.drawings.map((drawing) => drawing.worker), [0]);
    assert.equal(world.workers[0]!.terminated, false);
    await host.disposeExecution(run.executionId!);
  } finally {
    dispose();
  }
});

test('a learner exception in the verdict batch still hands its worker to the observer', async () => {
  const { world, host, dispose } = await fixture({ raisesOn: (input) => input.value === 3 });
  try {
    const run = await host.execute({ bundle: await runBundle(), interactive: true, tracing: { caseIds: ['b'] } });
    const rows = verdicts(run.evaluation);
    assert.equal(rows[2]?.status, 'runtime-error', JSON.stringify(rows[2]));
    assert.equal(attachment(run.evaluation, 'b')?.status, 'drawn');
    assert.deepEqual(executionWorkers(world), [0], describe(world));
    await host.disposeExecution(run.executionId!);
  } finally {
    dispose();
  }
});

for (const [label, behaviour, check] of [
  [
    'a hard-isolated program',
    { tier: 'hard-isolated' },
    (rows: ReturnType<typeof verdicts>) => assert.deepEqual(rows, EXPECTED_VERDICTS),
  ],
  [
    'a batch whose learner code ended the runtime',
    { endsRuntimeOn: (input: Record<string, unknown>) => input.value === 4 },
    (rows: ReturnType<typeof verdicts>) => {
      assert.deepEqual(rows.slice(0, 3), EXPECTED_VERDICTS.slice(0, 3));
      assert.equal(rows[3]?.status, 'runtime-error', JSON.stringify(rows[3]));
    },
  ],
] as const) {
  test(`${label} draws on a fresh worker started after the verdict`, async () => {
    const { world, host, dispose } = await fixture(behaviour);
    try {
      const run = await host.execute({ bundle: await runBundle(), interactive: true, tracing: { caseIds: ['a'] } });
      check(verdicts(run.evaluation));
      assert.equal(attachment(run.evaluation, 'a')?.status, 'drawn');
      const observerExecution = world.commands.find((command) => isLearnerWork(command) && isObserverWork(command));
      assert.ok(observerExecution, describe(world));
      const ordinaryReplies = world.commands
        .filter((command) => isLearnerWork(command) && !isObserverWork(command))
        .map((command) => command.repliedAt ?? Number.POSITIVE_INFINITY);
      const observerWorker = world.workers[observerExecution.worker]!;
      // The observer's worker did no ordinary work and was created only
      // after the verdict's last ordinary command answered.
      assert.ok(
        world.commands.filter((command) => command.worker === observerWorker.id).every(isObserverWorkOrSetup),
        describe(world)
      );
      const created = world.commands.find((command) => command.worker === observerWorker.id)!;
      assert.ok(created.seq > Math.max(...ordinaryReplies), describe(world));
      assert.equal(world.maxBusyWorkers, 1, describe(world));
      await host.disposeExecution(run.executionId!);
    } finally {
      dispose();
    }
  });
}

function isObserverWorkOrSetup(command: ProtocolCommand): boolean {
  return command.type === 'init' || command.type === 'warmup' || isObserverWork(command);
}

test('a clock runaway in the verdict batch draws the earlier selected case on a fresh worker', async () => {
  // Case c's learner code never yields: the client's case clock terminates
  // the verdict worker, so it cannot be handed over.
  const { world, host, dispose } = await fixture({ hangsOn: (input) => input.value === 3 });
  try {
    const run = await host.execute({
      bundle: await runBundle({ wallClockMs: 100 }),
      interactive: true,
      tracing: { caseIds: ['a'] },
    });
    const rows = verdicts(run.evaluation);
    assert.deepEqual(rows.slice(0, 2), EXPECTED_VERDICTS.slice(0, 2));
    assert.equal(rows[2]?.status, 'timed-out', JSON.stringify(rows[2]));
    assert.equal(rows[3]?.status, 'not-run', JSON.stringify(rows[3]));
    assert.equal(attachment(run.evaluation, 'a')?.status, 'drawn');
    assert.equal(world.workers[0]!.terminated, true, 'the runaway worker is gone');
    assert.deepEqual(world.drawings.map((drawing) => drawing.worker === 0), [false]);
    assert.equal(world.maxBusyWorkers, 1, describe(world));
    await host.disposeExecution(run.executionId!);
  } finally {
    dispose();
  }
});

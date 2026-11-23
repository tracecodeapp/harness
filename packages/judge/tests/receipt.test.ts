import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { serialize } from 'node:v8';
import { MessageChannel, Worker } from 'node:worker_threads';
import { judgeCaseExecutionOutcome, judgeCompileExecutionOutcome } from '../../../src/internal/judge-execution-outcome';
import type { Attachment, Cut, Drawing, Refusal } from '../../../src/judge';
import { RUNTIME_TRACE_SCHEMA_VERSION, type RuntimeTrace } from '../../runtime-contracts/src/runtime-trace';
import { allCasesPassPolicy, createAlgorithmJudgeReceipt } from '../src/algorithm-evaluate';
import { ALGORITHM_BUNDLE_SCHEMA, type JudgeAlgorithmBundle } from '../src/algorithm-model';
import { VerdictReceiptStore, type ReceiptJournalEvent } from '../src/internal/receipt-store';
import type { Binding } from '../src/internal/receipt-types';
import type { JudgeCaseResult, JudgeCompileResult } from '../src/model';

const evaluatedAt = '2026-11-23T00:00:00.000Z';
const scope = {
  evaluationId: 'evaluation-1',
  workspaceDigest: 'sha256:workspace',
  generation: 1,
};
const a = { ...scope, caseId: 'A' };
const b = { ...scope, caseId: 'B' };
const trace: RuntimeTrace = {
  schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
  language: 'javascript',
  runId: 'test-observer',
  lineEventCount: 1,
  traceStepCount: 1,
  events: [{ kind: 'line', runId: 'test-observer', line: 1 }],
};
const drawn: Drawing = { status: 'drawn', trace };

function bundle(caseIds: readonly string[]): JudgeAlgorithmBundle {
  return {
    schema: ALGORITHM_BUNDLE_SCHEMA,
    id: 'bundle',
    workspaceDigest: scope.workspaceDigest,
    execution: { sourcePath: '/workspace/solution.js', functionName: 'solve' },
    plan: {
      id: 'plan',
      runtime: 'javascript',
      workspace: { files: [] },
      driver: { files: [] },
      run: { command: 'javascript' },
      cases: caseIds.map((id) => ({ id, input: { n: 7 }, expected: 7 })),
    },
    policy: allCasesPassPolicy(),
  };
}

function ordinary(caseId = 'A', value: unknown = 7): Extract<JudgeCaseResult, { status: 'completed' }> {
  return {
    status: 'completed',
    caseId,
    value,
    expected: 7,
    verdict: { kind: 'passed', comparatorId: 'test', comparison: { matched: true } },
    ...processResult(),
  };
}

function processResult() {
  return {
    sessionId: 'ordinary',
    pid: 1,
    timedOut: false,
    termination: { kind: 'exit', exitCode: 0 },
    stdout: 'ordinary\n\n',
    stderr: 'ordinary stderr\n',
    startedAt: 10,
    endedAt: 11,
    timings: { totalMs: 1 },
    diagnostics: [{ severity: 'info', message: 'ordinary diagnostic', line: 2 }],
  } as const;
}

const compiled = { ...processResult(), status: 'compiled' } satisfies JudgeCompileResult;
const failed: JudgeCaseResult = {
  ...ordinary(),
  status: 'runtime-error',
  failure: { origin: 'program', stage: 'runtime', line: 3, message: 'ordinary failure' },
  verdict: { kind: 'not-evaluated', reason: 'case-did-not-complete' },
};
const skipped: JudgeCaseResult = {
  ...ordinary('B'),
  status: 'not-run',
  notRun: { reason: 'run-stopped-after-limit', stoppedByCaseId: 'A', limit: 'line-limit' },
  verdict: { kind: 'not-evaluated', reason: 'case-did-not-complete' },
  stdout: '',
  stderr: '',
};

test('the /judge attachment exports retain closed discriminants and reasons', () => {
  type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
  const statuses: Equal<Attachment['status'], 'drawn' | 'truncated' | 'refused'> = true;
  const cuts: Equal<Cut,
    'step-budget' | 'line-budget' | 'single-line-budget' | 'stored-event-budget' |
    'byte-budget' | 'observer-deadline' | 'depth-budget'
  > = true;
  const refusals: Equal<Refusal,
    'recorder-unavailable' | 'unsupported-program' | 'unsupported-option' |
    'observer-prepare' | 'observer-encode' | 'observer-runtime' | 'observer-protocol' |
    'observer-timeout' | 'uncertified-drawing' | 'case-not-run'
  > = true;
  assert.ok(statuses && cuts && refusals);
});

function owner(caseIds: readonly string[] = ['A'], journal: ReceiptJournalEvent[] = []) {
  return new VerdictReceiptStore(scope, bundle(caseIds), (event) => journal.push(event));
}

test('both completion orders bind the same drawing after sealing the ordinary receipt', async () => {
  async function run(observerFirst: boolean) {
    const journal: ReceiptJournalEvent[] = [];
    const store = owner(['A', 'B'], journal);
    const attempt = store.beginObservation('A');
    const observerBarrier = Promise.withResolvers<void>();
    const ordinaryBarrier = Promise.withResolvers<void>();
    const observe = observerBarrier.promise.then(() => {
      assert.equal(store.publishDrawing(attempt, a, drawn), true);
    });
    const execute = ordinaryBarrier.promise.then(() => {
      store.commitOrdinary(b, ordinary('B'));
      store.commitOrdinary(a, ordinary());
      return store.seal({ status: 'completed', compile: compiled }, evaluatedAt);
    });

    if (observerFirst) {
      observerBarrier.resolve();
      await observe;
      assert.equal(journal.some(({ event }) => event === 'attachment-bind'), false);
      ordinaryBarrier.resolve();
    } else {
      ordinaryBarrier.resolve();
      await execute;
      assert.equal(journal.some(({ event }) => event === 'attachment-bind'), false);
      observerBarrier.resolve();
    }
    const receipt = await execute;
    await observe;

    const projected = store.projectReceipt(['A']);
    assert.deepEqual(projected.evaluation.cases.map(({ caseId }) => caseId), ['A', 'B']);
    assert.deepEqual(projected.evaluation.cases[0]?.attachment, { ...a, ...drawn });
    assert.equal('attachment' in projected.evaluation.cases[1]!, false);
    assert.equal(projected.evaluation.cases[1], receipt.evaluation.cases[1]);
    assert.equal(projected.evaluation.cases[0]?.trace, projected.evaluation.cases[0]?.attachment?.status === 'drawn'
      ? projected.evaluation.cases[0].attachment.trace
      : undefined);
    assert.equal(projected.policy, receipt.policy);
    assert.equal(projected.passedCount, 2);
    assert.equal(journal.at(-1)?.event, 'attachment-bind');
    assert.deepEqual(journal.filter(({ event }) => event === 'ordinary-commit').map(({ binding }) => binding.caseId), ['B', 'A']);
    return serialize(projected);
  }

  assert.deepEqual(await run(true), await run(false));
});

test('worker poison, mismatched bindings, duplicate commits and late replies leave the archive unchanged', () => {
  const journal: ReceiptJournalEvent[] = [];
  const store = owner(['A', 'B'], journal);
  const attempt = store.beginObservation('A');
  const row = store.commitOrdinary(a, failed);
  const archive = serialize(row);
  assert.throws(() => store.commitOrdinary(a, ordinary('A', 999)), /already committed/);
  store.commitOrdinary(b, ordinary('B'));
  const receipt = store.seal({ status: 'completed' }, evaluatedAt);
  const receiptBytes = serialize(receipt);
  assert.throws(() => store.seal({ status: 'completed' }, evaluatedAt), /already sealed/);
  const poison = { ...drawn, value: 999, stdout: 'forged', failure: { origin: 'provider', message: 'forged' } };

  const mismatches: Binding[] = [
    { ...a, evaluationId: 'another-evaluation' },
    { ...a, workspaceDigest: 'sha256:different' },
    b,
    { ...a, generation: 2 },
  ];
  for (const mismatch of mismatches) {
    assert.equal(store.publishDrawing(attempt, mismatch, poison), false);
    assert.equal(journal.some(({ event }) => event === 'attachment-bind'), false);
    assert.deepEqual(serialize(row), archive);
  }
  assert.equal(store.publishDrawing(attempt, a, poison), true);
  const projection = store.projectEvaluation(['A']);
  const { attachment, trace: legacyTrace, ...ordinaryFields } = projection.cases[0]!;
  assert.deepEqual(attachment, { ...a, ...drawn });
  assert.equal(legacyTrace, attachment?.status === 'drawn' ? attachment.trace : undefined);
  assert.deepEqual(serialize(ordinaryFields), archive);
  assert.equal(JSON.stringify(judgeCaseExecutionOutcome(projection.cases[0]!, { language: 'javascript' })),
    JSON.stringify(judgeCaseExecutionOutcome(failed, { language: 'javascript' })));
  assert.equal(store.publishDrawing(attempt, a, { status: 'refused', reason: 'observer-runtime' }), false);
  store.dispose();
  assert.equal(store.publishDrawing(attempt, a, poison), false);
  assert.throws(() => store.projectEvaluation(['A']), /disposed/);
  assert.deepEqual(serialize(receipt), receiptBytes);
  assert.deepEqual(serialize(row), archive);
  assert.equal(journal.filter(({ event }) => event === 'ordinary-write-attempt').length, 3);
  assert.equal(journal.filter(({ event }) => event === 'ordinary-commit').length, 2);
});

test('expired attempt cannot publish against a retry or a replacement generation', () => {
  const store = owner();
  const expired = store.beginObservation('A');
  store.cancelObservation(expired);
  const current = store.beginObservation('A');
  const row = store.commitOrdinary(a, ordinary());
  const archive = serialize(row);
  store.seal({ status: 'completed' }, evaluatedAt);
  assert.equal(store.publishDrawing(expired, a, drawn), false);
  const replacement = new VerdictReceiptStore({ ...scope, generation: 2 }, bundle(['A']));
  const replacementBinding = { ...a, generation: 2 };
  replacement.beginObservation('A');
  replacement.commitOrdinary(replacementBinding, ordinary());
  replacement.seal({ status: 'completed' }, evaluatedAt);
  assert.equal(replacement.publishDrawing(current, replacementBinding, drawn), false);
  assert.equal(store.publishDrawing(current, a, drawn), true);
  assert.deepEqual(serialize(row), archive);
});

test('live attempts are scoped to the evaluation even at the same generation and case', () => {
  const first = owner();
  const otherScope = { ...scope, evaluationId: 'evaluation-2' };
  const otherBinding = { ...otherScope, caseId: 'A' };
  const second = new VerdictReceiptStore(otherScope, bundle(['A']));
  const firstAttempt = first.beginObservation('A');
  const secondAttempt = second.beginObservation('A');
  assert.notEqual(firstAttempt.token, secondAttempt.token);
  const row = second.commitOrdinary(otherBinding, ordinary());
  const bytes = serialize(row);
  assert.equal(second.publishDrawing(firstAttempt, otherBinding, drawn), false);
  assert.equal(second.publishDrawing(secondAttempt, a, drawn), false);
  second.seal({ status: 'completed' }, evaluatedAt);
  assert.deepEqual(second.projectEvaluation(['A']).cases[0]?.attachment, {
    ...otherBinding, status: 'refused', reason: 'observer-protocol',
  });
  assert.deepEqual(serialize(row), bytes);
});

test('ordinary snapshots keep aliases, cycles and value presence without freezing inputs', () => {
  const shared = { n: 7, child: null as unknown };
  const aliased = { left: shared, right: shared, explicitUndefined: undefined };
  shared.child = aliased;
  const store = owner(['A', 'B', 'C']);
  const row = store.commitOrdinary(a, { ...ordinary('A', aliased), expected: aliased });
  const bytes = serialize(row);
  const { value: _, ...noValue } = ordinary('B');
  const absent = store.commitOrdinary(b, noValue);
  const present = store.commitOrdinary({ ...scope, caseId: 'C' }, ordinary('C', null));
  const receipt = store.seal({ status: 'completed' }, evaluatedAt);
  const payload = row.value as typeof aliased;
  shared.n = 999;
  assert.equal(payload.left.n, 7);
  assert.equal(payload.left, payload.right);
  assert.equal(payload.left.child, payload);
  assert.equal(payload, row.expected);
  assert.equal(Object.hasOwn(payload, 'explicitUndefined'), true);
  assert.equal(Object.isFrozen(payload.left), true);
  assert.equal(Object.hasOwn(absent, 'value'), false);
  assert.equal(Object.hasOwn(present, 'value'), true);
  assert.equal(present.value, null);
  assert.equal(receipt.evaluation.cases[0], row);
  assert.equal(Object.isFrozen(receipt.evaluation), true);
  assert.deepEqual(serialize(row), bytes);
});

test('selected rows always project an outcome, including a missing reply and a skipped case', () => {
  const store = owner(['A', 'B', 'C']);
  const pending = store.beginObservation('A');
  store.commitOrdinary(a, ordinary());
  store.commitOrdinary(b, skipped);
  store.commitOrdinary({ ...scope, caseId: 'C' }, ordinary('C'));
  const receipt = store.seal({ status: 'completed' }, evaluatedAt);
  const projection = store.projectEvaluation(['A', 'B']);
  assert.deepEqual(projection.cases[0]?.attachment, { ...a, status: 'refused', reason: 'observer-protocol' });
  assert.deepEqual(projection.cases[1]?.attachment, { ...b, status: 'refused', reason: 'case-not-run' });
  const skippedOutcome = judgeCaseExecutionOutcome(projection.cases[1]!, { language: 'javascript', trace: true });
  assert.deepEqual(skippedOutcome, {
    kind: 'not-run',
    reason: 'run-stopped-after-limit',
    stoppedByCaseId: 'A',
    limit: 'line-limit',
    consoleOutput: [],
  });
  for (const row of projection.cases) assert.equal('trace' in row, false);
  for (const row of projection.cases) {
    for (const legacyField of ['untracedRunNeeded', 'traceUnavailable', 'traceUnavailableRun', 'providerFailure']) {
      assert.equal(Object.hasOwn(row, legacyField), false);
    }
  }
  assert.equal('attachment' in projection.cases[2]!, false);
  assert.equal(store.publishDrawing(pending, a, drawn), false);
  assert.equal(store.projectEvaluation().cases[0], receipt.evaluation.cases[0]);
  assert.deepEqual(store.projectEvaluation(['B'], ['B', 'A']).cases.map(({ caseId }) => caseId), ['B', 'A']);
});

test('compile failure keeps the original decision and has no attachments even when requested', () => {
  const store = owner();
  const attempt = store.beginObservation('A');
  assert.equal(store.publishDrawing(attempt, a, drawn), true);
  const compile = {
    ...compiled,
    status: 'compile-failed',
    failure: { origin: 'program', stage: 'compile', message: 'original compile error' },
  } satisfies JudgeCompileResult;
  const expected = { planId: 'plan', status: 'compile-failed', compile, cases: [] } as const;
  const archive = store.seal({ status: 'compile-failed', compile }, evaluatedAt);
  assert.deepEqual(archive, createAlgorithmJudgeReceipt(bundle(['A']), expected, evaluatedAt));
  assert.deepEqual(store.projectReceipt(['A']).evaluation, expected);
  assert.equal(store.publishDrawing(attempt, a, drawn), false);
  const outcome = judgeCompileExecutionOutcome(compile, { language: 'javascript', trace: true });
  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.trace.runId, 'javascript:compile');
  assert.deepEqual(outcome.trace.events, []);
});

test('truncation projects one owned prefix and a closed reason without changing diagnostics', () => {
  const store = owner();
  const attempt = store.beginObservation('A');
  const emptyTrace = { ...trace, events: [], lineEventCount: 0, traceStepCount: 0 };
  const reason: Cut = 'byte-budget';
  const row = store.commitOrdinary(a, ordinary());
  const before = serialize(row);
  assert.equal(store.publishDrawing(attempt, a, { status: 'truncated', reason, trace: emptyTrace, attemptedEvents: 1 }), true);
  store.seal({ status: 'completed' }, evaluatedAt);
  const projected = store.projectEvaluation(['A']).cases[0]!;
  const attachment: Attachment | undefined = projected.attachment;
  assert.equal(attachment?.status, 'truncated');
  assert.equal(attachment.reason, reason);
  assert.equal(attachment.attemptedEvents, 1);
  assert.equal(projected.trace, attachment.trace);
  assert.notEqual(attachment.trace, emptyTrace);
  assert.equal(Object.isFrozen(attachment.trace.events), true);
  assert.equal(projected.diagnostics, row.diagnostics);
  assert.equal(JSON.stringify(projected.diagnostics), JSON.stringify(ordinary().diagnostics));
  assert.deepEqual(serialize(row), before);
});

test('case outcome reads attachment presentation and preserves ordinary result bytes', () => {
  const options = { language: 'javascript', trace: true } as const;
  const warning = {
    severity: 'warning',
    kind: 'trace-truncated',
    code: 'line-limit',
    message: 'legacy observer cutoff',
  } as const;
  const row = { ...ordinary(), diagnostics: [warning] };
  const noTrace = judgeCaseExecutionOutcome(row, { language: 'javascript' });
  assert.deepEqual(judgeCaseExecutionOutcome(row, options), { kind: 'trace-refused' });

  const drawings: Drawing[] = [
    drawn,
    { status: 'truncated', reason: 'byte-budget', trace, attemptedEvents: 2 },
    { status: 'refused', reason: 'recorder-unavailable' },
  ];
  for (const drawing of drawings) {
    const store = owner();
    const attempt = store.beginObservation('A');
    store.commitOrdinary(a, row);
    store.seal({ status: 'completed' }, evaluatedAt);
    store.publishDrawing(attempt, a, drawing);
    const projected = store.projectEvaluation(['A']).cases[0]!;
    assert.equal(JSON.stringify(judgeCaseExecutionOutcome(projected, { language: 'javascript', trace: false })),
      JSON.stringify(noTrace));
    const legacyTrace = { ...trace, runId: 'unrelated-legacy-trace' };
    const outcome = judgeCaseExecutionOutcome({ ...projected, trace: legacyTrace }, options);
    if (drawing.status === 'refused') {
      assert.deepEqual(outcome, { kind: 'trace-refused' });
    } else {
      assert.equal(outcome.kind, 'completed');
      assert.equal(outcome.output, 7);
      assert.deepEqual(outcome.consoleOutput, ['ordinary', '']);
      assert.equal(outcome.trace, projected.trace);
      assert.equal(outcome.traceTruncated, drawing.status === 'truncated' ? 'trace-byte-limit' : undefined);
    }
  }
});

test('the ordinary conversion and archive never read observer properties', () => {
  const plain = ordinary();
  const poison = {
    ...plain,
    get trace(): never { throw new Error('read observer trace'); },
    get attachment(): never { throw new Error('read observer attachment'); },
  };
  const options = { language: 'javascript', trace: false } as const;
  assert.deepEqual(judgeCaseExecutionOutcome(poison, options), judgeCaseExecutionOutcome(plain, options));
  const store = owner();
  assert.deepEqual(store.commitOrdinary(a, poison), plain);
  store.seal({ status: 'completed' }, evaluatedAt);
  const [row] = store.projectEvaluation().cases;
  assert.equal(Object.hasOwn(row!, 'trace'), false);
  assert.equal(Object.hasOwn(row!, 'attachment'), false);
});

test('an observer deadline requires a retained prefix to count as truncated', () => {
  const cases = [
    { draw: { status: 'truncated', reason: 'observer-deadline', trace, attemptedEvents: 1 },
      expected: { status: 'truncated', reason: 'observer-deadline', trace, attemptedEvents: 1 } },
    { draw: { status: 'truncated', reason: 'observer-deadline',
      trace: { ...trace, events: [], lineEventCount: 0, traceStepCount: 0 }, attemptedEvents: 0 },
      expected: { status: 'refused', reason: 'observer-timeout' } },
    { draw: { status: 'refused', reason: 'observer-timeout' },
      expected: { status: 'refused', reason: 'observer-timeout' } },
  ];
  for (const { draw, expected } of cases) {
    const store = owner();
    const attempt = store.beginObservation('A');
    store.commitOrdinary(a, ordinary());
    store.seal({ status: 'completed' }, evaluatedAt);
    assert.equal(store.publishDrawing(attempt, a, draw), true);
    const row = store.projectEvaluation(['A']).cases[0]!;
    assert.deepEqual(row.attachment, { ...a, ...expected });
    if (expected.status === 'refused') {
      assert.equal('trace' in row, false);
    } else {
      const outcome = judgeCaseExecutionOutcome(row, { language: 'javascript', trace: true });
      assert.equal(outcome.kind, 'completed');
      assert.notEqual(outcome.traceTruncated, 'client-timeout');
    }
  }
});

const expectedTraceCutCodes = {
  'step-budget': 'trace-limit',
  'stored-event-budget': 'trace-limit',
  'byte-budget': 'trace-byte-limit',
  'line-budget': 'trace-limit',
  'single-line-budget': 'trace-limit',
  'depth-budget': 'trace-limit',
  'observer-deadline': 'trace-limit',
} satisfies Record<Cut, 'trace-limit' | 'trace-byte-limit'>;

// The exhaustive record makes any addition to the exported Cut union a test
// type error until it is included in both loops.
const attachmentCuts = Object.keys(expectedTraceCutCodes) as Cut[];

function traceTruncatedFor(reason: Cut) {
  const store = owner();
  const attempt = store.beginObservation('A');
  store.commitOrdinary(a, ordinary());
  store.seal({ status: 'completed' }, evaluatedAt);
  assert.equal(store.publishDrawing(attempt, a, {
    status: 'truncated', reason, trace, attemptedEvents: 1,
  }), true);
  const row = store.projectEvaluation(['A']).cases[0]!;
  assert.equal(row.attachment?.status, 'truncated');
  assert.equal(row.attachment.reason, reason);
  const outcome = judgeCaseExecutionOutcome(row, { language: 'javascript', trace: true });
  assert.equal(outcome.kind, 'completed');
  return outcome.traceTruncated;
}

test('attachment cuts map to the app-compatible traceTruncated codes', async (t) => {
  for (const reason of attachmentCuts) {
    await t.test(reason, () => {
      assert.equal(traceTruncatedFor(reason), expectedTraceCutCodes[reason]);
    });
  }
});

test('no attachment cut becomes a learner limit', () => {
  for (const reason of attachmentCuts) {
    const code = traceTruncatedFor(reason);
    assert.ok(code === 'trace-limit' || code === 'trace-byte-limit', `${reason} mapped to ${code}`);
  }
});

test('ordinary provider failure and not-run retain precedence over refusal', () => {
  const options = { language: 'javascript', trace: true } as const;
  const unavailable: JudgeCaseResult = {
    ...failed,
    failure: { origin: 'provider', reason: 'runtime-failure', message: 'ordinary provider lost' },
    attachment: { ...a, status: 'refused', reason: 'recorder-unavailable' },
  };
  assert.throws(() => judgeCaseExecutionOutcome(unavailable, options), /ordinary provider lost/);
  assert.deepEqual(
    judgeCaseExecutionOutcome({ ...skipped, attachment: { ...b, status: 'refused', reason: 'case-not-run' } }, options),
    judgeCaseExecutionOutcome(skipped, { language: 'javascript' }),
  );
});

test('unknown observer reasons and invalid prefixes refuse without rewriting the verdict', () => {
  const malformed = [
    { status: 'refused', reason: 'unknown-reason' },
    { status: 'refused', reason: 'case-not-run' },
    { status: 'truncated', reason: 'unknown-reason', trace, attemptedEvents: 1 },
    { status: 'truncated', reason: 'byte-budget', trace: { ...trace, events: [] }, attemptedEvents: 0 },
    { status: 'drawn', trace: {} },
    { status: 'unknown' },
  ];

  for (const message of malformed) {
    const store = owner();
    const attempt = store.beginObservation('A');
    const row = store.commitOrdinary(a, ordinary());
    const bytes = serialize(row);
    store.seal({ status: 'completed' }, evaluatedAt);
    assert.equal(store.publishDrawing(attempt, a, message), true);
    const projected = store.projectEvaluation(['A']).cases[0]!;
    assert.deepEqual(projected.attachment, { ...a, status: 'refused', reason: 'observer-protocol' });
    assert.equal('trace' in projected, false);
    assert.deepEqual(serialize(row), bytes);
  }
});

function openProbe(role: 'ordinary' | 'observer', phase?: string) {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL('./fixtures/receipt-worker.cjs', import.meta.url), {
    workerData: { journal: port2, binding: a, role, phase },
    transferList: [port2],
  });
  return {
    async run(input: unknown) {
      const events: unknown[] = [];
      port1.on('message', (event) => events.push(event));
      const done = once(port1, 'close');
      const reply = once(worker, 'message');
      worker.postMessage(input);
      const [[output]] = await Promise.all([reply, done]);
      return { output, events };
    },
    async dispose() {
      port1.close();
      await worker.terminate();
    },
  };
}

test('trusted test worker acknowledges the injected phase on a separate journal port', async (t) => {
  const scenarios = [
    ['recorder', 'recorder-unavailable'],
    ['build', 'observer-prepare'],
    ['encoder', 'observer-encode'],
  ] as const satisfies readonly (readonly [string, Refusal])[];

  for (const [phase, reason] of scenarios) {
    await t.test(phase, async () => {
      const ordinaryProbe = openProbe('ordinary');
      const observerProbe = openProbe('observer', phase);
      try {
        const journal: ReceiptJournalEvent[] = [];
        const store = owner(['A'], journal);
        const attempt = store.beginObservation('A');
        const shared = { n: 7 };
        const input = { left: shared, right: shared };
        const ordinaryRun = await ordinaryProbe.run(input);
        assert.deepEqual(ordinaryRun.events, [{ event: 'start', role: 'ordinary', binding: a }]);
        assert.deepEqual(ordinaryRun.output, { value: 7, stdout: '7\n', aliases: true });
        const { value, stdout } = ordinaryRun.output;
        store.commitOrdinary(a, { ...ordinary('A', value), stdout });
        const receipt = store.seal({ status: 'completed' }, evaluatedAt);
        const before = serialize(receipt);

        const observation = await observerProbe.run(input);
        assert.deepEqual(observation.events, [
          { event: 'start', role: 'observer', binding: a },
          { event: 'injection-ack', phase, binding: a },
        ]);
        assert.equal(store.publishDrawing(attempt, a, observation.output), true);
        const projected = store.projectEvaluation(['A']).cases[0]!;
        assert.deepEqual(projected.attachment, { ...a, status: 'refused', reason });
        assert.equal(projected.value, 7);
        assert.equal(projected.stdout, '7\n');
        assert.equal(input.right.n, 7);
        assert.deepEqual(journal.map(({ event, binding }) => [event, binding]), [
          ['ordinary-write-attempt', a], ['ordinary-commit', a], ['attachment-bind', a],
        ]);
        assert.deepEqual(serialize(receipt), before);
      } finally {
        await Promise.all([ordinaryProbe.dispose(), observerProbe.dispose()]);
      }
    });
  }
});

test('ends-same gates binding on terminal outcome, value presence, and exact stdout', () => {
  const stdout = processResult().stdout;
  const state = { status: 'completed' as const, value: { present: true, value: 7 }, console: stdout };
  const cases = [
    [state, undefined],
    [{ ...state, value: { present: true, value: 999 } }, 'uncertified-drawing'],
    [{ ...state, console: 'ordinary\n' }, 'uncertified-drawing'],
    [{ ...state, value: { present: false } }, 'uncertified-drawing'],
    [undefined, 'uncertified-drawing'],
    [{ status: 'compile-failed', console: stdout }, 'observer-prepare'],
    [{ status: 'trapped', console: stdout }, 'observer-runtime'],
    [{ status: 'timed-out', console: stdout }, 'observer-timeout'],
  ] as const;

  for (const [finalState, reason] of cases) {
    for (const observeFirst of [true, false]) {
      const journal: ReceiptJournalEvent[] = [];
      const store = new VerdictReceiptStore(scope, bundle(['A']), (event) => journal.push(event), 'ends-same');
      const attempt = store.beginObservation('A');
      const publish = () => {
        assert.equal(store.publishDrawing(attempt, a, {
          ...drawn, finalState: finalState && { ...finalState, verdict: { kind: 'failed' } },
          value: -500, stdout: 'forged', verdict: { kind: 'failed' },
        }), true);
      };
      if (observeFirst) {
        publish();
        assert.equal(journal.length, 0);
      }

      const row = store.commitOrdinary(a, ordinary());
      const receipt = store.seal({ status: 'completed' }, evaluatedAt);
      if (!observeFirst) publish();
      const projected = store.projectReceipt(['A']);
      assert.equal(projected.verdict, receipt.verdict);
      assert.equal(projected.passedCount, receipt.passedCount);
      const { attachment, trace: legacyTrace, ...ordinaryFields } = projected.evaluation.cases[0]!;
      assert.deepEqual(ordinaryFields, row);
      assert.deepEqual(attachment, reason ? { ...a, status: 'refused', reason } : { ...a, ...drawn });
      assert.equal(legacyTrace, attachment?.status === 'drawn' ? attachment.trace : undefined);
      assert.deepEqual(journal.map(({ event }) => event), ['ordinary-write-attempt', 'ordinary-commit', 'attachment-bind']);
    }
  }
});

test('ends-same uses the row comparison override against the ordinary value', () => {
  const manifest: JudgeAlgorithmBundle = {
    ...bundle(['A']),
    comparison: {
      schema: 'tracecode.judge.comparator-policy.v1',
      default: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
      cases: { A: { schema: 'tracecode.judge.comparator.v1', mode: 'unordered-array' } },
    },
  };
  const store = new VerdictReceiptStore(scope, manifest, undefined, 'ends-same');
  const attempt = store.beginObservation('A');
  const evidence = [2, 1];
  store.publishDrawing(attempt, a, {
    ...drawn,
    finalState: { status: 'completed', console: processResult().stdout, value: { present: true, value: evidence } },
  });
  evidence[0] = 999;
  store.commitOrdinary(a, {
    ...ordinary('A', [1, 2]),
    verdict: { kind: 'failed', comparatorId: 'tracecode:case-policy:v1', comparison: { matched: false } },
  });
  store.seal({ status: 'completed' }, evaluatedAt);
  const receipt = store.projectReceipt(['A']);
  assert.equal(receipt.evaluation.cases[0]?.attachment?.status, 'drawn');
  assert.equal(receipt.passedCount, 0);
  assert.equal(receipt.evaluation.cases[0]?.verdict.kind, 'failed');
});

test('non-certifying producers ignore private terminal evidence', () => {
  const store = owner();
  const attempt = store.beginObservation('A');
  store.publishDrawing(attempt, a, {
    ...drawn, finalState: { status: 'trapped', console: 'different' },
  });
  store.commitOrdinary(a, ordinary());
  store.seal({ status: 'completed' }, evaluatedAt);
  assert.deepEqual(store.projectEvaluation(['A']).cases[0]?.attachment, { ...a, ...drawn });
});

test('ends-same does not treat two valid answers to a custom validator as equal', () => {
  const source = bundle(['A']);
  const manifest: JudgeAlgorithmBundle = {
    ...source,
    plan: { ...source.plan, cases: [{ id: 'A', input: { nums: [1, 4, 2, 3], target: 5 } }] },
    comparison: {
      schema: 'tracecode.judge.comparator-policy.v1',
      default: { schema: 'tracecode.judge.comparator.v1', customValidator: 'two-sum-indices' },
    },
  };
  const store = new VerdictReceiptStore(scope, manifest, undefined, 'ends-same');
  store.commitOrdinary(a, ordinary('A', [0, 1]));
  store.seal({ status: 'completed' }, evaluatedAt);
  const attempt = store.beginObservation('A');
  store.publishDrawing(attempt, a, {
    ...drawn, finalState: {
      status: 'completed', console: processResult().stdout, value: { present: true, value: [2, 3] },
    },
  });
  assert.deepEqual(store.projectEvaluation(['A']).cases[0]?.attachment, {
    ...a, status: 'refused', reason: 'uncertified-drawing',
  });
});

test('ends-same distinguishes a recorder deadline from a traced execution timeout', () => {
  for (const status of ['completed', 'timed-out'] as const) {
    const store = new VerdictReceiptStore(scope, bundle(['A']), undefined, 'ends-same');
    store.commitOrdinary(a, ordinary());
    store.seal({ status: 'completed' }, evaluatedAt);
    const attempt = store.beginObservation('A');
    const truncated = { status: 'truncated', reason: 'observer-deadline', attemptedEvents: 2, trace } as const;
    store.publishDrawing(attempt, a, {
      ...truncated,
      finalState: {
        status, console: processResult().stdout,
        ...(status === 'completed' ? { value: { present: true, value: 7 } } : {}),
      },
    });
    assert.deepEqual(store.projectEvaluation(['A']).cases[0]?.attachment,
      status === 'completed'
        ? { ...a, ...truncated }
        : { ...a, status: 'refused', reason: 'observer-timeout' });
  }
});

test('ends-same distinguishes a published undefined from an absent result', () => {
  for (const present of [true, false]) {
    const store = new VerdictReceiptStore(scope, bundle(['A']), undefined, 'ends-same');
    const row = { ...ordinary(), value: undefined };
    store.commitOrdinary(a, row);
    store.seal({ status: 'completed' }, evaluatedAt);
    const attempt = store.beginObservation('A');
    store.publishDrawing(attempt, a, {
      ...drawn, finalState: { status: 'completed', console: row.stdout, value: { present } },
    });
    const projected = store.projectEvaluation(['A']).cases[0]!;
    assert.ok(Object.hasOwn(projected, 'value'));
    assert.equal(projected.attachment?.status, present ? 'drawn' : 'refused');
  }
});

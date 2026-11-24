import assert from 'node:assert/strict';
import test from 'node:test';
import { RUNTIME_TRACE_SCHEMA_VERSION, type RuntimeTrace } from '../../runtime-contracts/src/runtime-trace';
import { allCasesPassPolicy } from '../src/algorithm-evaluate';
import { ALGORITHM_BUNDLE_SCHEMA, type JudgeAlgorithmBundle } from '../src/algorithm-model';
import { VerdictReceiptStore } from '../src/internal/receipt-store';
import type { Attachment, Binding } from '../src/internal/receipt-types';
import type { JudgeCaseResult } from '../src/model';

// Ownership of a drawing handed to publishDrawing. 'borrowed' (the default)
// copies the reply; 'transferred' adopts a reply the adapter built for this
// call and never touches again, freezing it in place.

const evaluatedAt = '2026-11-24T00:00:00.000Z';
const scope = { evaluationId: 'evaluation-1', workspaceDigest: 'sha256:workspace', generation: 1 };
const bindingFor = (caseId: string, evaluationId = scope.evaluationId): Binding =>
  ({ ...scope, evaluationId, caseId });
const a = bindingFor('A');
const stdout = 'ordinary\n';

function bundle(caseIds: readonly string[]): JudgeAlgorithmBundle {
  return {
    schema: ALGORITHM_BUNDLE_SCHEMA,
    id: 'bundle',
    workspaceDigest: scope.workspaceDigest,
    execution: { sourcePath: '/workspace/solution.py', functionName: 'solve' },
    plan: {
      id: 'plan',
      runtime: 'python',
      workspace: { files: [] },
      driver: { files: [] },
      run: { command: 'python' },
      cases: caseIds.map((id) => ({ id, input: { n: 7 }, expected: 7 })),
    },
    policy: allCasesPassPolicy(),
  };
}

function ordinary(caseId = 'A', value: unknown = 7): JudgeCaseResult {
  return {
    status: 'completed',
    caseId,
    value,
    expected: 7,
    verdict: { kind: 'passed', comparatorId: 'test', comparison: { matched: true } },
    sessionId: 'ordinary',
    pid: 1,
    timedOut: false,
    termination: { kind: 'exit', exitCode: 0 },
    stdout,
    stderr: '',
    startedAt: 10,
    endedAt: 11,
    timings: { totalMs: 1 },
    diagnostics: [],
  };
}

// Tests reach into events by shape, so they see them as loose records.
type TestEvent = Record<string, any>;
type TestTrace = Omit<RuntimeTrace, 'events'> & { events: TestEvent[] };

/** A Python-shaped trace built fresh for one call, as an adapter builds it. */
function freshTrace(eventCount = 3): TestTrace {
  const events = [];
  for (let index = 0; index < eventCount; index += 1) {
    const depth = 1 + (index % 3);
    events.push({
      kind: 'line' as const,
      runId: 'python:run',
      file: 'solution.py',
      line: 1 + (index % 9),
      frameId: `f${depth}`,
      sourceSpan: { file: 'solution.py', startLine: 1, startColumn: 0, endLine: 1, endColumn: 9 },
      callStack: Array.from({ length: depth }, (_, frame) => ({
        function: frame ? 'backtrack' : 'permute',
        line: 2 + frame,
        args: { path: [1, 2, 3].slice(0, frame), used: [true, false, true] },
      })),
    });
  }
  return {
    schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
    language: 'python',
    runId: 'python:run',
    events,
    lineEventCount: events.length,
    traceStepCount: events.length,
  };
}

function sealedStore(caseIds: readonly string[] = ['A'], evaluationId = scope.evaluationId, certify = false) {
  const store = new VerdictReceiptStore(
    { ...scope, evaluationId }, bundle(caseIds), undefined, certify ? 'ends-same' : undefined
  );
  for (const caseId of caseIds) store.commitOrdinary(bindingFor(caseId, evaluationId), ordinary(caseId));
  store.seal({ status: 'completed' }, evaluatedAt);
  return store;
}

function publish(
  store: VerdictReceiptStore,
  message: unknown,
  ownership: 'borrowed' | 'transferred',
  binding: Binding = a
): Attachment {
  const attempt = store.beginObservation(binding.caseId);
  assert.equal(store.publishDrawing(attempt, binding, message, ownership), true);
  return store.projectEvaluation([binding.caseId], [binding.caseId]).cases[0]!.attachment!;
}

function drawnTrace(attachment: Attachment): TestTrace {
  assert.equal(attachment.status, 'drawn');
  return attachment.trace as unknown as TestTrace;
}

/** Every object reachable from root, each once. */
function objectsIn(root: unknown): Set<object> {
  const found = new Set<object>();
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (value === null || typeof value !== 'object' || found.has(value)) continue;
    found.add(value);
    for (const key of Reflect.ownKeys(value)) {
      stack.push(Reflect.getOwnPropertyDescriptor(value, key)!.value);
    }
  }
  return found;
}

function assertDeepFrozen(root: unknown) {
  for (const node of objectsIn(root)) assert.equal(Object.isFrozen(node), true);
}

test('a transferred drawing becomes the receipt without a second copy, frozen in place', () => {
  const trace = freshTrace();
  const attachment = publish(sealedStore(), { status: 'drawn', trace }, 'transferred');
  const owned = drawnTrace(attachment);
  assert.equal(owned, trace);
  assert.equal(owned.events[0], trace.events[0]);
  assertDeepFrozen(owned);
  assert.equal(Object.isFrozen(attachment), true);
});

test('a borrowed drawing is still copied and leaves the producer object writable', () => {
  const trace = freshTrace();
  const owned = drawnTrace(publish(sealedStore(), { status: 'drawn', trace }, 'borrowed'));
  assert.notEqual(owned, trace);
  assert.deepEqual(owned, trace);
  assertDeepFrozen(owned);
  assert.equal(Object.isFrozen(trace), false);
});

test('post-publish mutation of the producer object cannot change the receipt', () => {
  for (const ownership of ['borrowed', 'transferred'] as const) {
    const trace = freshTrace();
    const expected = structuredClone(trace);
    const owned = drawnTrace(publish(sealedStore(), { status: 'drawn', trace }, ownership));
    const event = trace.events[0] as { line: number; callStack: { args: { path: number[] } }[] };
    const mutations = [
      () => { (trace.events as unknown[]).push({ kind: 'line', runId: 'x', line: 99 }); },
      () => { event.line = 99; },
      () => { event.callStack[0]!.args.path.push(42); },
      () => { (trace as { traceStepCount: number }).traceStepCount = 0; },
      () => { delete (trace.events[1] as { frameId?: string }).frameId; },
    ];
    for (const mutate of mutations) {
      if (ownership === 'transferred') assert.throws(mutate, TypeError);
      else mutate();
    }
    assert.deepEqual(owned, expected, ownership);
  }
});

test('no aliasing across two drawings or two attempts, even when a producer republishes its object', () => {
  // A cache that hands the same graph (or a graph sharing one cached node) to
  // two evaluations, or to a second attempt, must not alias the first receipt.
  const cachedFrame = { function: 'solve', line: 1, args: { memo: [1, 2] } };
  const first = freshTrace();
  (first.events[0] as { callStack: unknown[] }).callStack = [cachedFrame];
  const second = freshTrace();
  (second.events[2] as { callStack: unknown[] }).callStack = [cachedFrame];

  const drawings = [
    drawnTrace(publish(sealedStore(['A'], 'evaluation-1'), { status: 'drawn', trace: first }, 'transferred',
      bindingFor('A', 'evaluation-1'))),
    drawnTrace(publish(sealedStore(['A'], 'evaluation-2'), { status: 'drawn', trace: first }, 'transferred',
      bindingFor('A', 'evaluation-2'))),
    drawnTrace(publish(sealedStore(['A'], 'evaluation-3'), { status: 'drawn', trace: second }, 'transferred',
      bindingFor('A', 'evaluation-3'))),
  ];
  const retryStore = sealedStore(['A', 'B'], 'evaluation-4');
  drawings.push(
    drawnTrace(publish(retryStore, { status: 'drawn', trace: first }, 'transferred', bindingFor('A', 'evaluation-4'))),
    drawnTrace(publish(retryStore, { status: 'drawn', trace: first }, 'transferred', bindingFor('B', 'evaluation-4'))),
  );
  for (let left = 0; left < drawings.length; left += 1) {
    const nodes = objectsIn(drawings[left]);
    for (let right = left + 1; right < drawings.length; right += 1) {
      for (const node of objectsIn(drawings[right])) {
        assert.equal(nodes.has(node), false, `drawings ${left} and ${right} share an object`);
      }
    }
  }
  assert.deepEqual(drawings[1], drawings[0]);
  assert.deepEqual(drawings[3], drawings[0]);
  assert.deepEqual((drawings[2]!.events[2] as { callStack: unknown }).callStack, [cachedFrame]);
});

test('a transferred graph that is already frozen elsewhere is copied, not shared', () => {
  // A naive in-place freeze that treats a frozen node as done would leave this
  // still-writable child reachable from the receipt.
  const writable = [1, 2, 3];
  const sealedShell = Object.freeze({ items: writable });
  const trace = freshTrace();
  (trace.events[0] as { callStack: unknown[] }).callStack = [{ function: 'f', args: { held: sealedShell } }];
  const owned = drawnTrace(publish(sealedStore(), { status: 'drawn', trace }, 'transferred'));
  writable.push(4);
  const held = (owned.events[0] as { callStack: { args: { held: { items: number[] } } }[] })
    .callStack[0]!.args.held;
  assert.deepEqual(held.items, [1, 2, 3]);
  assert.notEqual(held, sealedShell);
  assertDeepFrozen(owned);
});

test('shared and cyclic graph values keep their shape and are frozen throughout', () => {
  for (const ownership of ['borrowed', 'transferred'] as const) {
    const trace = freshTrace(4);
    const target = { variable: 'path', path: [0] };
    const cyclic: Record<string, unknown> = { n: 1 };
    cyclic.self = cyclic;
    cyclic.list = [cyclic, target];
    const events = trace.events as Record<string, unknown>[];
    Object.assign(events[1]!, { kind: 'write', target, value: cyclic });
    Object.assign(events[2]!, { kind: 'read', target, value: cyclic });
    events.push(events[3]!);
    Object.assign(trace, { lineEventCount: 3, traceStepCount: 5 });

    const owned = drawnTrace(publish(sealedStore(), { status: 'drawn', trace }, ownership));
    const [, write, read, last, repeated] = owned.events as Record<string, unknown>[];
    const value = write!.value as Record<string, unknown>;
    assert.equal(write!.target, read!.target, ownership);
    assert.equal(read!.value, value);
    assert.equal(value.self, value);
    assert.equal((value.list as unknown[])[0], value);
    assert.equal((value.list as unknown[])[1], write!.target);
    assert.equal(repeated, last);
    assertDeepFrozen(owned);
  }
});

test('getters, proxies and exotic objects are refused or cannot change the receipt', () => {
  let getterReads = 0;
  const withGetter = (trace: TestTrace) => {
    Object.defineProperty(trace.events[0]!, 'line', {
      enumerable: true,
      get() { getterReads += 1; return getterReads; },
    });
    return trace;
  };
  const withHidden = (trace: TestTrace) => {
    Object.defineProperty(trace.events[0]!, 'hidden', { value: { writable: [1] }, enumerable: false, writable: true });
    return trace;
  };
  const withValue = (value: unknown) => {
    const trace = freshTrace();
    (trace.events[0] as Record<string, unknown>).value = value;
    return trace;
  };
  class Point { x = 1; }
  const refused = [
    ['getter', withGetter(freshTrace())],
    ['symbol key', withValue({ [Symbol('s')]: 1 })],
    ['function value', withValue(() => 1)],
    ['map', withValue(new Map([[1, 2]]))],
    ['date', withValue(new Date(0))],
    ['class instance', withValue(new Point())],
    ['typed array', withValue(new Uint8Array([1, 2]))],
  ] as const;
  for (const ownership of ['borrowed', 'transferred'] as const) {
    for (const [label, trace] of refused) {
      const store = sealedStore();
      const attachment = publish(store, { status: 'drawn', trace }, ownership);
      assert.deepEqual(attachment, { ...a, status: 'refused', reason: 'observer-protocol' }, `${ownership} ${label}`);
    }
    // A non-enumerable property is kept and owned, like any other.
    const hidden = withHidden(freshTrace());
    const owned = drawnTrace(publish(sealedStore(), { status: 'drawn', trace: hidden }, ownership));
    const kept = Reflect.getOwnPropertyDescriptor(owned.events[0]!, 'hidden')!.value as { writable: number[] };
    assert.deepEqual(kept.writable, [1]);
    assertDeepFrozen(owned);
  }
  assert.equal(getterReads, 0, 'no getter was invoked');

  // A revocable proxy in a borrowed reply is copied into plain data.
  const borrowedProxy = Proxy.revocable({ kind: 'line', runId: 'python:run', line: 1 }, {});
  const borrowed = freshTrace();
  (borrowed.events as unknown[])[0] = borrowedProxy.proxy;
  const copied = drawnTrace(publish(sealedStore(), { status: 'drawn', trace: borrowed }, 'borrowed'));
  borrowedProxy.revoke();
  assert.equal(copied.events[0]!.line, 1);

  // A transferred proxy is frozen through its traps. The proxy invariants then
  // pin every successful read to the frozen target, so a lying trap can only
  // make a read throw, never report a different value.
  let lie = false;
  const lying = new Proxy({ kind: 'line', runId: 'python:run', line: 1 }, {
    get(target, key, receiver) {
      return lie && key === 'line' ? 99 : Reflect.get(target, key, receiver);
    },
  });
  const transferred = freshTrace();
  (transferred.events as unknown[])[0] = lying;
  const attachment = publish(sealedStore(), { status: 'drawn', trace: transferred }, 'transferred');
  lie = true;
  const event = drawnTrace(attachment).events[0]!;
  assert.equal(Object.isFrozen(event), true);
  let line: unknown;
  try {
    line = event.line;
  } catch (error) {
    assert.ok(error instanceof TypeError);
    line = 'threw';
  }
  assert.ok(line === 1 || line === 'threw', `a frozen proxy reported ${String(line)}`);
});

test('malformed transferred replies are refused as observer-protocol', () => {
  const malformed = (): unknown[] => [
    { status: 'refused', reason: 'unknown-reason' },
    { status: 'refused', reason: 'case-not-run' },
    { status: 'truncated', reason: 'unknown-reason', trace: freshTrace(), attemptedEvents: 4 },
    { status: 'truncated', reason: 'byte-budget', trace: freshTrace(), attemptedEvents: 2 },
    { status: 'drawn', trace: {} },
    { status: 'drawn', trace: { ...freshTrace(), events: {} } },
    { status: 'drawn', trace: { ...freshTrace(), lineEventCount: -1 } },
    { status: 'drawn', trace: 'not-a-trace' },
    { status: 'unknown' },
    null,
    'drawn',
  ];
  for (const ownership of ['borrowed', 'transferred'] as const) {
    for (const message of malformed()) {
      const attachment = publish(sealedStore(), message, ownership);
      assert.deepEqual(attachment, { ...a, status: 'refused', reason: 'observer-protocol' },
        `${ownership} ${JSON.stringify(message)}`);
    }
  }
});

test('the envelope is checked on the owned trace, not on a value read before it', () => {
  // The check and the receipt must see the same graph: a getter on the reply
  // envelope is read once, and the trace's own fields cannot be swapped.
  for (const ownership of ['borrowed', 'transferred'] as const) {
    let reads = 0;
    const message = {
      status: 'drawn',
      get trace() {
        reads += 1;
        return reads === 1 ? freshTrace() : { status: 'forged' };
      },
    };
    const owned = drawnTrace(publish(sealedStore(), message, ownership));
    assert.equal(reads, 1);
    assert.equal(owned.schemaVersion, RUNTIME_TRACE_SCHEMA_VERSION);
  }
});

test('finalState evidence is owned on the transferred path and certifies the same way', () => {
  for (const ownership of ['borrowed', 'transferred'] as const) {
    for (const observeFirst of [true, false]) {
      const store = new VerdictReceiptStore(scope, bundle(['A']), undefined, 'ends-same');
      const shared = [1, 2];
      const trace = freshTrace();
      Object.assign(trace.events[2]!, { kind: 'return', value: shared });
      const evidence = { present: true, value: shared };
      const message = {
        status: 'drawn', trace,
        finalState: { status: 'completed', console: stdout, value: evidence },
      };
      const attempt = store.beginObservation('A');
      const publishNow = () => assert.equal(store.publishDrawing(attempt, a, message, ownership), true);
      if (observeFirst) publishNow();
      // Producer mutation between publish and seal must not affect certification.
      if (observeFirst) {
        const mutate = () => { shared[0] = 999; };
        if (ownership === 'transferred') assert.throws(mutate, TypeError);
        else mutate();
        evidence.present = false;
      }
      store.commitOrdinary(a, ordinary('A', [1, 2]));
      store.seal({ status: 'completed' }, evaluatedAt);
      if (!observeFirst) publishNow();
      const attachment = store.projectEvaluation(['A']).cases[0]!.attachment!;
      assert.equal(attachment.status, 'drawn', `${ownership} observeFirst=${observeFirst}`);
      const returned = (drawnTrace(attachment).events[2] as { value: number[] }).value;
      assert.deepEqual(returned, [1, 2]);
      if (ownership === 'transferred') {
        assert.equal(returned, shared, 'trace and finalState share one adopted node');
        assert.equal(Object.isFrozen(shared), true);
      }
    }
  }
});

test('malformed finalState evidence on the transferred path still cannot certify', () => {
  const store = new VerdictReceiptStore(scope, bundle(['A']), undefined, 'ends-same');
  store.commitOrdinary(a, ordinary('A', [1, 2]));
  store.seal({ status: 'completed' }, evaluatedAt);
  const result = [1, 2];
  Object.defineProperty(result, 1, { get: () => 2, enumerable: true });
  const attachment = publish(store, {
    status: 'drawn', trace: freshTrace(),
    finalState: { status: 'completed', console: stdout, value: { present: true, value: result } },
  }, 'transferred');
  assert.deepEqual(attachment, { ...a, status: 'refused', reason: 'uncertified-drawing' });
});

test('size scaling: a transferred drawing allocates no copy of any node at any size', () => {
  for (const eventCount of [1, 64, 1024, 4096]) {
    const trace = freshTrace(eventCount);
    const before = objectsIn(trace);
    const owned = drawnTrace(publish(sealedStore(), { status: 'drawn', trace }, 'transferred'));
    const after = objectsIn(owned);
    assert.equal(after.size, before.size, `n=${eventCount}`);
    for (const node of after) assert.equal(before.has(node), true, `n=${eventCount}: a node was copied`);
  }
});

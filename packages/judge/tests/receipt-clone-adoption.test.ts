import assert from 'node:assert/strict';
import test from 'node:test';
import { RUNTIME_TRACE_SCHEMA_VERSION, type RuntimeTrace } from '../../runtime-contracts/src/runtime-trace';
import { allCasesPassPolicy } from '../src/algorithm-evaluate';
import { ALGORITHM_BUNDLE_SCHEMA, type JudgeAlgorithmBundle } from '../src/algorithm-model';
import { VerdictReceiptStore } from '../src/internal/receipt-store';
import type { Attachment, Binding } from '../src/internal/receipt-types';
import type { JudgeCaseResult } from '../src/model';

// 'transferred-clone' is a transferred reply whose every object is a
// structured clone of a worker message, a JSON.parse result, or plain data an
// audited adapter built from those. Such a graph has only enumerable,
// string-keyed data properties and no proxies, so the store checks one
// prototype per object and one type per value, then freezes in place.
// Everything a structured clone can still carry must be handled exactly as the
// full check (and the borrowed copy) handles it.

type Ownership = 'borrowed' | 'transferred' | 'transferred-clone';
const ownerships = ['borrowed', 'transferred', 'transferred-clone'] as const satisfies readonly Ownership[];

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

type TestEvent = Record<string, any>;
type TestTrace = Omit<RuntimeTrace, 'events'> & { events: TestEvent[] };

/**
 * A Python-shaped trace. Call arguments are null-prototype records, as
 * Python's sanitizeJsonValue builds them on the main thread.
 */
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
        args: Object.assign(Object.create(null) as Record<string, unknown>, {
          path: [1, 2, 3].slice(0, frame), used: [true, false, true],
        }),
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

/** The same trace as it arrives in a worker message. */
function clonedTrace(eventCount = 3): TestTrace {
  return structuredClone(freshTrace(eventCount));
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
  ownership: Ownership,
  binding: Binding = a
): Attachment {
  const attempt = store.beginObservation(binding.caseId);
  // The ownership type widens with the implementation; the tests come first.
  assert.equal(store.publishDrawing(attempt, binding, message, ownership as never), true);
  return store.projectEvaluation([binding.caseId], [binding.caseId]).cases[0]!.attachment!;
}

function drawnTrace(attachment: Attachment): TestTrace {
  assert.equal(attachment.status, 'drawn');
  return attachment.trace as unknown as TestTrace;
}

/** Every object reachable from root through any own property, each once. */
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

function assertDeepFrozen(root: unknown, label?: string) {
  for (const node of objectsIn(root)) assert.equal(Object.isFrozen(node), true, label);
}

const descriptorReaders = [
  [Reflect, 'ownKeys'],
  [Reflect, 'getOwnPropertyDescriptor'],
  [Object, 'getOwnPropertyDescriptor'],
  [Object, 'getOwnPropertyDescriptors'],
  [Object, 'getOwnPropertyNames'],
  [Object, 'getOwnPropertySymbols'],
] as const;

/** Counts the store's calls to the property-descriptor APIs while run() runs. */
function countDescriptorReads(run: () => void): number {
  let reads = 0;
  const originals = descriptorReaders.map(([owner, name]) =>
    [owner, name, (owner as unknown as Record<string, unknown>)[name]] as const);
  for (const [owner, name, original] of originals) {
    (owner as unknown as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
      reads += 1;
      return (original as (...args: unknown[]) => unknown).apply(this, args);
    };
  }
  try {
    run();
  } finally {
    for (const [owner, name, original] of originals) (owner as unknown as Record<string, unknown>)[name] = original;
  }
  return reads;
}

/**
 * A canonical description of a graph: prototypes, own keys in order with
 * their enumerability, holes, primitive types (bigint, -0, NaN, undefined) and
 * the identity structure (shared nodes and cycles as back references).
 */
function describe(root: unknown): string {
  const ids = new Map<object, number>();
  const visit = (value: unknown): unknown => {
    if (typeof value === 'bigint') return { bigint: String(value) };
    if (typeof value === 'number') return Object.is(value, -0) ? { number: '-0' } : { number: String(value) };
    if (value === undefined) return { undefined: true };
    if (value === null || typeof value !== 'object') return value;
    const seen = ids.get(value);
    if (seen !== undefined) return { ref: seen };
    ids.set(value, ids.size);
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value).map((key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key)!;
      return [String(key), descriptor.enumerable, visit(descriptor.value)];
    });
    return {
      prototype: prototype === null ? 'null' : prototype === Array.prototype ? 'array' : 'object',
      keys,
    };
  };
  return JSON.stringify(visit(root));
}

test('a clone-provenance drawing is adopted in place and frozen without reading a property descriptor', () => {
  for (const [label, trace] of [['structured clone', clonedTrace()], ['adapter-built', freshTrace()]] as const) {
    const before = objectsIn(trace);
    const store = sealedStore();
    let attachment: Attachment | undefined;
    const reads = countDescriptorReads(() => {
      attachment = publish(store, { status: 'drawn', trace }, 'transferred-clone');
    });
    const owned = drawnTrace(attachment!);
    assert.equal(owned, trace, `${label}: the trace was copied`);
    assert.equal(owned.events[0], trace.events[0], label);
    assert.equal(reads, 0, `${label}: the store read ${reads} property descriptors or key lists`);
    const after = objectsIn(owned);
    assert.equal(after.size, before.size, label);
    for (const node of after) assert.equal(before.has(node), true, `${label}: a node was copied`);
    assertDeepFrozen(owned, label);
    // The null-prototype records an adapter builds keep their prototype.
    assert.equal(Object.getPrototypeOf(trace.events[1]!.callStack[0].args), label === 'adapter-built' ? null : Object.prototype);
  }
});

/** Every non-plain object a structured clone can carry, as a clone delivers it. */
function cloneExotics(): (readonly [string, () => unknown])[] {
  const values: (readonly [string, () => unknown])[] = [
    ['Map', () => new Map([[1, { nested: true }]])],
    ['Set', () => new Set([1, 2])],
    ['Date', () => new Date(0)],
    ['RegExp', () => /a+/gi],
    ['ArrayBuffer', () => new ArrayBuffer(8)],
    ['DataView', () => new DataView(new ArrayBuffer(8))],
    ['Int8Array', () => new Int8Array([1, -2])],
    ['Uint8Array', () => new Uint8Array([1, 2])],
    ['Uint8ClampedArray', () => new Uint8ClampedArray([1, 2])],
    ['Int16Array', () => new Int16Array([1, 2])],
    ['Uint16Array', () => new Uint16Array([1, 2])],
    ['Int32Array', () => new Int32Array([1, 2])],
    ['Uint32Array', () => new Uint32Array([1, 2])],
    ['Float32Array', () => new Float32Array([1.5])],
    ['Float64Array', () => new Float64Array([1.5])],
    ['BigInt64Array', () => new BigInt64Array([1n])],
    ['BigUint64Array', () => new BigUint64Array([1n])],
    ['Error', () => new Error('boom')],
    ['TypeError', () => new TypeError('boom')],
    ['RangeError', () => new RangeError('boom')],
    ['SyntaxError', () => new SyntaxError('boom')],
    ['ReferenceError', () => new ReferenceError('boom')],
    ['EvalError', () => new EvalError('boom')],
    ['URIError', () => new URIError('boom')],
    ['Boolean object', () => Object(true)],
    ['Number object', () => Object(1)],
    ['String object', () => Object('text')],
    ['BigInt object', () => Object(1n)],
  ];
  if (typeof SharedArrayBuffer === 'function') {
    values.push(['SharedArrayBuffer', () => new SharedArrayBuffer(8)]);
  }
  return values.map(([label, make]) => [label, () => structuredClone(make())] as const);
}

/** Places one value at every depth where a trace can hold data. */
function placements(): (readonly [string, (trace: TestTrace, value: unknown) => void])[] {
  return [
    ['event value', (trace, value) => { trace.events[0]!.value = value; }],
    ['call argument', (trace, value) => { trace.events[2]!.callStack[1].args.held = value; }],
    ['array element', (trace, value) => { trace.events[1]!.value = [1, [2, value]]; }],
    ['named array property', (trace, value) => {
      const list: unknown[] & { extra?: unknown } = [1, 2];
      list.extra = value;
      trace.events[1]!.value = list;
    }],
    ['trace envelope field', (trace, value) => { (trace as Record<string, unknown>).extra = { value }; }],
  ];
}

test('every exotic value a structured clone can carry is still refused as observer-protocol', () => {
  for (const [label, make] of cloneExotics()) {
    for (const [where, place] of placements()) {
      for (const ownership of ownerships) {
        // Placed, then the whole trace cloned, as a worker message delivers it.
        const trace = freshTrace();
        place(trace, make());
        const attachment = publish(sealedStore(), { status: 'drawn', trace: structuredClone(trace) }, ownership);
        assert.deepEqual(attachment, { ...a, status: 'refused', reason: 'observer-protocol' },
          `${ownership}: ${label} as ${where}`);
      }
    }
  }
  // The exotic object as the trace itself, or as its events.
  for (const ownership of ownerships) {
    for (const trace of [structuredClone(new Map()), structuredClone(Object.assign(freshTrace(), {
      events: new Set(),
    }))]) {
      const attachment = publish(sealedStore(), { status: 'drawn', trace }, ownership);
      assert.deepEqual(attachment, { ...a, status: 'refused', reason: 'observer-protocol' }, ownership);
    }
  }
});

test('an exotic value refused in finalState evidence cannot certify, as on the full check', () => {
  for (const [label, make] of cloneExotics()) {
    for (const ownership of ownerships) {
      const store = sealedStore(['A'], scope.evaluationId, true);
      const attachment = publish(store, structuredClone({
        status: 'drawn', trace: freshTrace(),
        finalState: { status: 'completed', console: stdout, value: { present: true, value: [7, make()] } },
      }), ownership);
      assert.deepEqual(attachment, { ...a, status: 'refused', reason: 'uncertified-drawing' }, `${ownership}: ${label}`);
    }
  }
});

test('BigInt primitives, sparse arrays, holes and named array properties are handled exactly as the full check handles them', () => {
  // Neither the borrowed copy nor F1's adoption refuses these: a BigInt is an
  // immutable primitive, a hole is not a property (and a frozen array cannot
  // gain one), and a named array property is an ordinary data property. The
  // clone check keeps them, frozen, exactly as both do.
  const shapes = (): (readonly [string, unknown])[] => {
    const named: unknown[] & { named?: unknown } = [1, 2];
    named.named = { child: [3] };
    const trailing = [1, 2];
    trailing.length = 5;
    return [
      ['bigint', 2n ** 70n],
      ['negative bigint', -1n],
      ['hole', [1, , 3]],
      ['trailing holes', trailing],
      ['only holes', new Array(3)],
      ['named array property', named],
      ['undefined, -0 and NaN', [undefined, -0, Number.NaN, { field: undefined }]],
    ];
  };
  for (const [index, [label]] of shapes().entries()) {
    const outcomes = ownerships.map((ownership) => {
      const trace = freshTrace();
      trace.events[0]!.value = shapes()[index]![1];
      const message = { status: 'drawn', trace: structuredClone(trace) };
      const attachment = publish(sealedStore(), message, ownership);
      const owned = drawnTrace(attachment);
      assertDeepFrozen(owned, `${ownership}: ${label}`);
      if (ownership === 'transferred-clone') assert.equal(owned, message.trace, `${label}: adopted in place`);
      return describe(owned.events[0]!.value);
    });
    assert.equal(outcomes[1], outcomes[0], `transferred: ${label}`);
    assert.equal(outcomes[2], outcomes[0], `transferred-clone: ${label}`);
  }
  // The holes are still holes in the adopted graph.
  const trace = clonedTrace();
  trace.events[0]!.value = [1, , 3];
  const owned = drawnTrace(publish(sealedStore(), { status: 'drawn', trace }, 'transferred-clone'));
  const value = owned.events[0]!.value as unknown[];
  assert.equal(value.length, 3);
  assert.equal(1 in value, false);
});

test('pre-frozen, sealed and non-extensible subtrees of a clone-provenance reply are copied, not shared', () => {
  const restrict: Record<string, <T extends object>(node: T) => T> = {
    frozen: Object.freeze,
    sealed: Object.seal,
    'non-extensible': Object.preventExtensions,
  };
  for (const [label, lock] of Object.entries(restrict)) {
    const trace = clonedTrace();
    const child = { n: 1 };
    const node = lock({ child, m: 'kept' }) as { child: { n: number } | string; m?: string };
    trace.events[0]!.callStack[0].args = { held: node, sibling: child };
    const owned = drawnTrace(publish(sealedStore(), { status: 'drawn', trace }, 'transferred-clone'));
    const args = owned.events[0]!.callStack[0].args as { held: typeof node; sibling: { n: number } };
    assert.notEqual(args.held, node, `${label}: the node was shared, not copied`);
    if (label !== 'frozen') {
      assert.equal(Object.isFrozen(node), false, `${label}: the producer's node was frozen in place`);
      node.child = 'replaced';
      if (label === 'non-extensible') delete node.m;
    }
    try { child.n = 2; } catch { /* the child may already be frozen; either way the receipt is unchanged */ }
    assert.deepEqual(args.held, { child: { n: 1 }, m: 'kept' }, label);
    assert.equal(args.sibling.n, 1, label);
    assert.equal(args.held.child, args.sibling, `${label}: sharing inside the copy is kept`);
    assertDeepFrozen(owned, label);
  }
});

test('shared and cyclic values of a cloned reply keep their shape, are adopted once and frozen throughout', () => {
  const build = () => {
    const trace = freshTrace(4);
    const target = { variable: 'path', path: [0] };
    const cyclic: Record<string, unknown> = { n: 1 };
    cyclic.self = cyclic;
    cyclic.list = [cyclic, target];
    Object.assign(trace.events[1]!, { kind: 'write', target, value: cyclic });
    Object.assign(trace.events[2]!, { kind: 'read', target, value: cyclic });
    trace.events.push(trace.events[3]!);
    Object.assign(trace, { lineEventCount: 3, traceStepCount: 5 });
    // A structured clone keeps sharing and cycles.
    return structuredClone(trace);
  };
  const shapes = ownerships.map((ownership) => {
    const trace = build();
    const owned = drawnTrace(publish(sealedStore(), { status: 'drawn', trace }, ownership));
    const [, write, read, last, repeated] = owned.events;
    const value = write!.value as Record<string, unknown>;
    assert.equal(write!.target, read!.target, ownership);
    assert.equal(read!.value, value);
    assert.equal(value.self, value);
    assert.equal((value.list as unknown[])[0], value);
    assert.equal((value.list as unknown[])[1], write!.target);
    assert.equal(repeated, last);
    assertDeepFrozen(owned, ownership);
    if (ownership === 'transferred-clone') {
      assert.equal(owned, trace);
      assert.equal(owned.events[1], trace.events[1]);
    }
    return describe(owned);
  });
  assert.equal(shapes[2], shapes[0]);
  assert.equal(shapes[1], shapes[0]);
});

test('no aliasing across two clone-provenance drawings or two attempts when a producer republishes its object', () => {
  const cachedFrame = { function: 'solve', line: 1, args: { memo: [1, 2] } };
  const first = clonedTrace();
  first.events[0]!.callStack = [cachedFrame];
  const second = clonedTrace();
  second.events[2]!.callStack = [cachedFrame];

  const drawings = [
    drawnTrace(publish(sealedStore(['A'], 'evaluation-1'), { status: 'drawn', trace: first }, 'transferred-clone',
      bindingFor('A', 'evaluation-1'))),
    drawnTrace(publish(sealedStore(['A'], 'evaluation-2'), { status: 'drawn', trace: first }, 'transferred-clone',
      bindingFor('A', 'evaluation-2'))),
    drawnTrace(publish(sealedStore(['A'], 'evaluation-3'), { status: 'drawn', trace: second }, 'transferred-clone',
      bindingFor('A', 'evaluation-3'))),
  ];
  const retryStore = sealedStore(['A', 'B'], 'evaluation-4');
  drawings.push(
    drawnTrace(publish(retryStore, { status: 'drawn', trace: first }, 'transferred-clone', bindingFor('A', 'evaluation-4'))),
    drawnTrace(publish(retryStore, { status: 'drawn', trace: first }, 'transferred-clone', bindingFor('B', 'evaluation-4'))),
  );
  for (let left = 0; left < drawings.length; left += 1) {
    const nodes = objectsIn(drawings[left]);
    for (let right = left + 1; right < drawings.length; right += 1) {
      for (const node of objectsIn(drawings[right])) {
        assert.equal(nodes.has(node), false, `drawings ${left} and ${right} share an object`);
      }
    }
  }
  assert.equal(drawings[0], first, 'the first publish adopts in place');
  assert.deepEqual(drawings[1], drawings[0]);
  assert.deepEqual(drawings[3], drawings[0]);
  assert.deepEqual(drawings[2]!.events[2]!.callStack, [cachedFrame]);
});

test('post-publish mutation of a clone-provenance reply throws and cannot change the receipt', () => {
  const trace = clonedTrace();
  const expected = structuredClone(trace);
  const owned = drawnTrace(publish(sealedStore(), { status: 'drawn', trace }, 'transferred-clone'));
  const event = trace.events[0]!;
  const mutations = [
    () => { trace.events.push({ kind: 'line', runId: 'x', line: 99 }); },
    () => { event.line = 99; },
    () => { event.callStack[0].args.path.push(42); },
    () => { (trace as { traceStepCount: number }).traceStepCount = 0; },
    () => { delete trace.events[1]!.frameId; },
  ];
  for (const mutate of mutations) assert.throws(mutate, TypeError);
  assert.deepEqual(owned, expected);
});

test('clone-provenance finalState evidence is adopted with the trace and certifies the same way', () => {
  for (const ownership of ownerships) {
    for (const observeFirst of [true, false]) {
      const store = new VerdictReceiptStore(scope, bundle(['A']), undefined, 'ends-same');
      const message = structuredClone((() => {
        const shared = [1, 2];
        const trace = freshTrace();
        Object.assign(trace.events[2]!, { kind: 'return', value: shared });
        return {
          status: 'drawn', trace,
          finalState: { status: 'completed', console: stdout, value: { present: true, value: shared } },
        };
      })());
      const shared = message.finalState.value.value;
      const attempt = store.beginObservation('A');
      const publishNow = () => assert.equal(store.publishDrawing(attempt, a, message, ownership as never), true);
      if (observeFirst) {
        publishNow();
        const mutate = () => { shared[0] = 999; };
        if (ownership === 'borrowed') mutate();
        else assert.throws(mutate, TypeError);
      }
      store.commitOrdinary(a, ordinary('A', [1, 2]));
      store.seal({ status: 'completed' }, evaluatedAt);
      if (!observeFirst) publishNow();
      const attachment = store.projectEvaluation(['A']).cases[0]!.attachment!;
      const label = `${ownership} observeFirst=${observeFirst}`;
      assert.equal(attachment.status, 'drawn', label);
      const returned = drawnTrace(attachment).events[2]!.value as number[];
      assert.deepEqual(returned, [1, 2], label);
      if (ownership !== 'borrowed') {
        assert.equal(returned, shared, `${label}: trace and finalState share one adopted node`);
        assert.equal(Object.isFrozen(shared), true, label);
      }
    }
  }
});

test('malformed clone-provenance replies are refused as observer-protocol', () => {
  const malformed = (): unknown[] => [
    { status: 'refused', reason: 'unknown-reason' },
    { status: 'refused', reason: 'case-not-run' },
    { status: 'truncated', reason: 'unknown-reason', trace: clonedTrace(), attemptedEvents: 4 },
    { status: 'truncated', reason: 'byte-budget', trace: clonedTrace(), attemptedEvents: 2 },
    { status: 'drawn', trace: {} },
    { status: 'drawn', trace: { ...clonedTrace(), events: {} } },
    { status: 'drawn', trace: { ...clonedTrace(), lineEventCount: -1 } },
    { status: 'drawn', trace: 'not-a-trace' },
    { status: 'unknown' },
    null,
    'drawn',
  ];
  for (const message of malformed()) {
    const attachment = publish(sealedStore(), structuredClone(message), 'transferred-clone');
    assert.deepEqual(attachment, { ...a, status: 'refused', reason: 'observer-protocol' }, JSON.stringify(message));
  }
});

/** Deterministic PRNG, so each ownership sees an identical fresh graph. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random reply as a worker message or an adapter can deliver it. */
function randomReply(seed: number): unknown {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const exotics = cloneExotics();
  const pool: object[] = [];
  const value = (depth: number): unknown => {
    const roll = next();
    if (pool.length && roll < 0.08) return pick(pool);
    if (roll < 0.11) return exotics[Math.floor(next() * exotics.length)]![1]();
    if (depth >= 4 || roll < 0.45) {
      return pick([0, -0, 1.5, Number.NaN, 'text', '', true, false, null, undefined, 3n]);
    }
    if (roll < 0.75) {
      const record: Record<string, unknown> = next() < 0.2 ? Object.create(null) : {};
      pool.push(record);
      const count = Math.floor(next() * 4);
      for (let index = 0; index < count; index += 1) {
        // Defined, not assigned: JSON.parse and a clone make an own
        // '__proto__' data property; assignment would set the prototype.
        Object.defineProperty(record, pick(['a', 'b', '0', '__proto__', 'path']), {
          value: value(depth + 1), enumerable: true, writable: true, configurable: true,
        });
      }
      return record;
    }
    const list = [] as unknown as unknown[] & Record<string, unknown>;
    pool.push(list);
    const length = Math.floor(next() * 5);
    for (let index = 0; index < length; index += 1) {
      if (next() < 0.2) continue;
      list[index] = value(depth + 1);
    }
    if (next() < 0.15) list.length += 2;
    if (next() < 0.15) list.named = value(depth + 1);
    return list;
  };
  const trace = freshTrace(3);
  for (const event of trace.events) {
    if (next() < 0.7) event.value = value(0);
    if (next() < 0.3) event.callStack[0].args.extra = value(1);
  }
  const message = { status: 'drawn', trace };
  // Most replies arrive by structured clone, which drops null prototypes;
  // the rest are adapter-built and keep them.
  return next() < 0.7 ? structuredClone(message) : message;
}

test('differential: every reply a clone or an adapter can deliver gets the same outcome on all three ownerships', () => {
  let drawn = 0;
  let refused = 0;
  for (let seed = 1; seed <= 400; seed += 1) {
    const outcomes = ownerships.map((ownership) => {
      const attachment = publish(sealedStore(), randomReply(seed), ownership);
      if (attachment.status !== 'drawn') return JSON.stringify(attachment);
      assertDeepFrozen(attachment.trace, `seed ${seed} ${ownership}`);
      return describe(attachment.trace);
    });
    if (outcomes[0]!.includes('"refused"')) refused += 1;
    else drawn += 1;
    assert.equal(outcomes[1], outcomes[0], `seed ${seed}: transferred differs from borrowed`);
    assert.equal(outcomes[2], outcomes[0], `seed ${seed}: transferred-clone differs from borrowed`);
  }
  assert.ok(drawn > 50 && refused > 50, `corpus covers both outcomes (drawn ${drawn}, refused ${refused})`);
});

test('size scaling: a clone-provenance drawing copies no node at any size', () => {
  for (const eventCount of [1, 64, 1024, 4096]) {
    const trace = clonedTrace(eventCount);
    const before = objectsIn(trace);
    const owned = drawnTrace(publish(sealedStore(), { status: 'drawn', trace }, 'transferred-clone'));
    const after = objectsIn(owned);
    assert.equal(after.size, before.size, `n=${eventCount}`);
    for (const node of after) assert.equal(before.has(node), true, `n=${eventCount}: a node was copied`);
  }
});

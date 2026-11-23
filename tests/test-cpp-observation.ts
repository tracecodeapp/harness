import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  createCppObservationRegistration,
  createLegacyCppDrawingProducer,
  createSparseCppDrawingProducer,
} from '../packages/runtime-cpp/src/cpp-observation';
import { RUNTIME_TRACE_SCHEMA_VERSION, type RuntimeTrace } from '../packages/runtime-contracts/src/runtime-trace';

const source = 'int f() { return 0 && 1; }';
const program = { code: source, functionName: 'f', executionStyle: 'function', runtimeVersion: 'test-cpp' } as const;
const options = { runtimeVersion: program.runtimeVersion, observationDeadlineMs: 1000 };
const signal = new AbortController().signal;
const request = { program, inputs: {}, attemptToken: 'test' };
const wasm = Uint8Array.of(
  0, 97, 115, 109, 1, 0, 0, 0, // Wasm preamble
  1, 5, 1, 96, 0, 1, 127, // type [] -> i32
  3, 2, 1, 0, // one function using that type
  10, 6, 1, 4, 0, 65, 0, 11, // CODE; i32.const 0; end
);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const offset = source.indexOf('&&');

function siteMap() {
  return {
    schema: 'tracecc.stage1.sites.v1',
    pch: 'narrow',
    sourceSha256: sha(source),
    moduleSha256: sha(wasm),
    codeSha256: sha(wasm.subarray(21)),
    files: ['learner.cpp'],
    functions: [{ name: 'f', lo: 2, hi: 6, frameBaseLocal: null }],
    sites: [{
      id: 'edge/fold', kind: 'edge.fold.skip', detail: '&&', file: 0, fn: 0, pc: 3,
      line: 1, column: offset + 1, offset, translationUnitOffset: offset,
      labelOrdinal: 0,
    }],
  };
}

test('sparse observation requires all three digests and independently verified coordinates', async () => {
  for (const fault of [undefined, 'sourceSha256', 'moduleSha256', 'codeSha256', 'source-offset', 'pc-operand'] as const) {
    const sites = siteMap();
    if (fault === 'source-offset') sites.sites[0]!.offset++;
    else if (fault === 'pc-operand') sites.sites[0]!.pc++;
    else if (fault) sites[fault] = '';
    let observers = 0;
    let disposals = 0;
    const producer = createSparseCppDrawingProducer({
      loadArtifact: async () => ({ ordinaryModule: wasm, sites }),
      async verifySites({ sites: map }) {
        // The independent boundary for the literal test module. PC 4 is
        // inside the i32.const immediate and was never a compiler label.
        return map.sites.every((site) => site.pc === 3);
      },
      createObserver() {
        observers++;
        return {
          observe: async () => ({ status: 'refused', reason: 'unsupported-program' }),
          dispose() { disposals++; },
        };
      },
    });
    const registration = createCppObservationRegistration(producer, options);
    const lease = await registration.prepareObservation(program, signal);
    const drawing = await lease.observe(request);
    assert.deepEqual(drawing, {
      status: 'refused',
      reason: fault ? 'uncertified-drawing' : 'unsupported-program',
    });
    await lease.dispose();
    assert.equal(observers, fault ? 0 : 1);
    assert.equal(disposals, observers);
  }
});

test('a producer prepare throw becomes a typed refusal with no fallback', async () => {
  let starts = 0;
  let retired = 0;
  const producer = createLegacyCppDrawingProducer({
    createObserverWorkerClient: () => ({
      async init() { return { success: true, loadTimeMs: 0 }; },
      async prepareRuntimeProgram() { starts++; throw new Error('rewriter compile threw'); },
      async executePreparedTrace() { assert.fail('must not run'); },
      terminate() { retired++; },
    }),
  });
  const registration = createCppObservationRegistration(producer, options);
  const lease = await registration.prepareObservation(program, signal);
  assert.deepEqual(await lease.observe(request), {
    status: 'refused',
    reason: 'observer-prepare',
    finalState: { status: 'compile-failed', console: '' },
  });
  await lease.dispose();
  assert.equal(starts, 1);
  assert.equal(retired, 1);
});

test('the selected legacy producer draws its recorded events and refuses an empty recorder', async () => {
  const trace: RuntimeTrace = {
    schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
    language: 'cpp',
    runId: 'legacy',
    events: [{ kind: 'line', runId: 'legacy', line: 1 }],
    lineEventCount: 1,
    traceStepCount: 1,
  };
  for (const variant of ['recorded', 'empty', 'cut', 'trapped', 'timed-out', 'absent'] as const) {
    const producer = createLegacyCppDrawingProducer({
      createObserverWorkerClient: () => ({
        async init() { return { success: true, loadTimeMs: 0 }; },
        async prepareRuntimeProgram() {
          return {
            success: true,
            handle: { programId: 'legacy-test', mode: 'trace', lifecycleGeneration: 0 },
            consoleOutput: [],
          };
        },
        async executePreparedTrace(_handle, call) {
          assert.equal(call.recordTrace, true);
          const base = { trace, executionTimeMs: 1, consoleOutput: ['one', 'two\n', ''] };
          if (variant === 'trapped') {
            return { ...base, kind: 'failed', error: 'trap', diagnosticStage: 'runtime' };
          }
          if (variant === 'timed-out') {
            return { ...base, kind: 'limit', error: 'timeout', reason: 'client-timeout' };
          }
          return {
            ...base,
            kind: 'completed',
            trace: variant === 'empty' ? { ...trace, events: [], lineEventCount: 0, traceStepCount: 0 } : trace,
            output: variant === 'absent' ? undefined : { values: [0, null] },
            ...(variant === 'cut' ? { traceTruncated: 'trace-limit' as const } : {}),
          };
        },
        terminate() {},
      }),
    });
    const registration = createCppObservationRegistration(producer, options);
    assert.equal(registration.capabilities.certification, 'ends-same');
    const lease = await registration.prepareObservation(program, signal);
    const console = 'one\ntwo\n\n';
    const finalState = variant === 'trapped' || variant === 'timed-out' ? { status: variant, console } : {
      status: 'completed',
      console,
      value: variant === 'absent' ? { present: false } : { present: true, value: { values: [0, null] } },
    };
    try {
      const drawing = variant === 'recorded' || variant === 'absent' ? { status: 'drawn', trace } : {
        status: 'refused',
        reason: {
          empty: 'recorder-unavailable',
          cut: 'uncertified-drawing',
          trapped: 'observer-runtime',
          'timed-out': 'observer-timeout',
        }[variant],
      };
      assert.deepEqual(await lease.observe(request), { ...drawing, finalState });
    } finally {
      await lease.dispose();
    }
  }
});

test('observation projection reads only Drawing fields and drops a late result after disposal', async () => {
  const trace: RuntimeTrace = {
    schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION, language: 'cpp' as const, runId: 'test',
    events: [{ kind: 'line' as const, runId: 'test', line: 1 }], lineEventCount: 1, traceStepCount: 1,
  };
  const reply = { status: 'drawn' as const, trace, get output(): never { throw new Error('poisoned'); } };
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<typeof reply>();
  const registration = createCppObservationRegistration({
    async prepare() {
      return {
        async observe(call) {
          if (call.attemptToken === 'late') {
            started.resolve();
            return pending.promise;
          }
          return reply;
        },
        dispose() {},
      };
    },
  }, options);
  const lease = await registration.prepareObservation(program, signal);
  assert.deepEqual(await lease.observe(request), { status: 'drawn', trace });
  const late = lease.observe({ ...request, attemptToken: 'late' });
  await started.promise;
  await lease.dispose();
  pending.resolve(reply);
  await assert.rejects(late, { name: 'AbortError' });
});

test('each sparse attempt gets its own verified byte copy and retires its worker on cancellation', async () => {
  const started = Promise.withResolvers<void>();
  const replies = Promise.withResolvers<void>();
  const allocated: Uint8Array[] = [];
  let retired = 0;
  const producer = createSparseCppDrawingProducer({
    loadArtifact: async () => ({ ordinaryModule: wasm, sites: siteMap() }),
    verifySites: async ({ sites }) => sites.sites[0]?.pc === 3,
    createObserver({ ordinaryModule }) {
      assert.deepEqual(ordinaryModule, wasm);
      allocated.push(ordinaryModule);
      // A derivation may edit a private buffer in place.
      ordinaryModule[0] = 1;
      return {
        async observe() {
          if (allocated.length === 2) started.resolve();
          await replies.promise;
          return { status: 'refused', reason: 'uncertified-drawing' };
        },
        dispose() { retired++; },
      };
    },
  });
  const registration = createCppObservationRegistration(producer, options);
  const lease = await registration.prepareObservation(program, signal);
  const cancel = new AbortController();
  const first = lease.observe({ ...request, signal: cancel.signal });
  const second = lease.observe({ ...request, attemptToken: 'second' });
  await started.promise;
  cancel.abort();
  // The second attempt can finish independently of the first.
  replies.resolve();
  await assert.rejects(first, { name: 'AbortError' });
  assert.deepEqual(await second, { status: 'refused', reason: 'uncertified-drawing' });
  await lease.dispose();
  assert.notEqual(allocated[0]?.buffer, allocated[1]?.buffer);
  assert.equal(wasm[0], 0);
  assert.equal(retired, 2);
});

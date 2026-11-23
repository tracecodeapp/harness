import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  createCppObservationRegistration,
  createLegacyCppDrawingProducer,
  createSparseCppDrawingProducer,
} from '../packages/runtime-cpp/src/cpp-observation';
import { RUNTIME_TRACE_SCHEMA_VERSION } from '../packages/runtime-contracts/src/runtime-trace';

const source = 'int f() { int x = 0; return x; }';
const program = { code: source, functionName: 'f', executionStyle: 'function' } as const;
const request = { program, inputs: {}, attemptToken: 'test' };
const wasm = Uint8Array.of(
  0, 97, 115, 109, 1, 0, 0, 0, // Wasm preamble
  1, 5, 1, 96, 0, 1, 127, // type [] -> i32
  3, 2, 1, 0, // one function using that type
  10, 6, 1, 4, 0, 65, 0, 11, // CODE; i32.const 0; end
);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const offset = source.indexOf('x');

function siteMap() {
  return {
    schema: 'tracecc.stage1.sites.v1',
    pch: 'narrow',
    sourceSha256: sha(source),
    moduleSha256: sha(wasm),
    codeSha256: sha(wasm.subarray(20)),
    files: ['learner.cpp'],
    functions: [{ name: 'f', lo: 2, hi: 6, frameBaseLocal: null }],
    sites: [{
      id: 'decl/x', kind: 'local.begin', detail: 'x', file: 0, fn: 0, pc: 3,
      line: 1, column: offset + 1, offset, translationUnitOffset: offset,
      labelOrdinal: 0, scalar: 'i32', frameOffset: 0,
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
    const registration = createCppObservationRegistration(producer, 1000);
    const lease = await registration.prepareObservation({ program });
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
    certify() { assert.fail('must not certify'); },
  });
  const registration = createCppObservationRegistration(producer, 1000);
  const lease = await registration.prepareObservation({ program });
  assert.deepEqual(await lease.observe(request), { status: 'refused', reason: 'observer-prepare' });
  await lease.dispose();
  assert.equal(starts, 1);
  assert.equal(retired, 1);
});

test('observation projection reads only Drawing fields and drops a late result after disposal', async () => {
  const trace = {
    schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION, language: 'cpp' as const, runId: 'test',
    events: [{ kind: 'line' as const, line: 1 }], lineEventCount: 1, traceStepCount: 1,
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
  }, 1000);
  const lease = await registration.prepareObservation({ program });
  assert.deepEqual(await lease.observe(request), { status: 'drawn', trace });
  const late = lease.observe({ ...request, attemptToken: 'late' });
  await started.promise;
  await lease.dispose();
  pending.resolve(reply);
  await assert.rejects(late, { name: 'AbortError' });
});

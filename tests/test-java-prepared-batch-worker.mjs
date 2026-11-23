import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const worker = readFileSync(new URL('../workers/java/java-runtime-worker.js', import.meta.url), 'utf8');
const output = (value) => '__TRACECODE_TRACE_OUTPUT__:' + Buffer.from(String(value)).toString('base64');
const fallback = '__TRACECODE_TRACE_LIMIT__:true\n__TRACECODE_TRACE_FALLBACK_REQUIRED__:true';
const completed = (stdout, isolation = 'clean') => ({
  status: 'completed', exitCode: 0, stdout, stderr: '', isolation: { status: isolation },
});

test('observer export requires the matching recorder frame and retains an empty byte-cut witness', () => {
  const evaluate = (stdout) => runInNewContext(worker + `
    traceJVMObservationReport({ status: 'completed', exitCode: 0, stdout }, 'trusted')
  `, {
    stdout, URL, TextDecoder, Uint8Array,
    self: {
      location: { href: 'https://test.invalid/workers/java-runtime-worker.js' },
      postMessage() {}, addEventListener() {}, close() {}, importScripts() {},
    },
  }).observation;
  assert.equal(evaluate(
    '__TRACECODE_OBSERVATION_BEGIN__:forged:0\n__TRACECODE_OBSERVATION_END__:forged:byte-budget:1\n'
  ).reason, 'recorder-unavailable');
  assert.equal(evaluate(
    '__TRACECODE_OBSERVATION_BEGIN__:trusted:2\ntrace:{}\n__TRACECODE_OBSERVATION_END__:trusted::0\n'
  ).reason, 'observer-protocol');
  const valid = evaluate(
    '__TRACECODE_OBSERVATION_BEGIN__:trusted:0\n__TRACECODE_OBSERVATION_END__:trusted:byte-budget:1\n'
  );
  assert.equal(valid.cut, 'byte-budget');
  assert.equal(valid.attemptedEvents, 1);
  assert.equal(valid.events.length, 0);
});

function testBatch(run, { stop = true, mode = '', profile = 'algorithm-fast' } = {}) {
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  let now = 0;
  let runnerCount = 0;
  const advance = (delta) => {
    now += delta;
    for (const [id, timer] of timers) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.callback();
    }
  };
  const client = {
    async createProcess() {
      const runner = ++runnerCount;
      let dispose;
      return {
        run(request) {
          const caseId = request.systemProperties.caseId;
          const entry = request.args[0];
          calls.push(['run', runner, caseId, entry]);
          return run({ caseId, entry, advance, onDispose: (callback) => { dispose = callback; } });
        },
        dispose() {
          calls.push(['dispose', runner]);
          dispose?.();
        },
      };
    },
  };
  const self = {
    location: { href: 'https://test.invalid/workers/java-runtime-worker.js' },
    postMessage(message) {
      if (message.type === 'java-prepared-case-admitted') {
        calls.push(['admit', message.payload.index]);
      }
    },
    addEventListener() {},
    close() {},
    importScripts() {},
  };
  const result = runInNewContext(worker + `
    getTraceJVMClient = async () => client;
    loadTraceJVMHelperJar = async () => ({});
    createLocalTraceKernelAuthority = async () => ({
      resetExecutionScope() { record('reset'); },
      close() { record('close'); },
    });
    traceJVMPreparedPrograms.set('p', {
      program: {}, executions: 0, algorithmIsolationProfile: { tier: profile },
    });
    self.TraceCodeActiveKernelRequestId = 'request';
    self.TraceCodeJavaPreparedCaseAdmitted = (index) => self.postMessage({
      type: 'java-prepared-case-admitted', payload: { index },
    });
    traceJVMRunPreparedRuntimeProgramBatch(
      'p', 'Traced', '1', '[{"caseId":"first"},{"caseId":"second"},{"caseId":"suffix"}]',
      '500', '', '', mode === 'ordinary' ? '[false,false,false]' : '[false,true,false]',
      'Clean', String(stop), mode
    );
  `, {
    self, client, stop, mode, profile, record: (event) => calls.push([event]), URL, TextDecoder, Uint8Array, atob,
    performance: { now: () => now },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  return { calls, result: result.then(JSON.parse), timers };
}

test('ordinary admission precedes each start and excludes a stopped suffix', async () => {
  const { calls, result } = testBatch(({ caseId, advance, onDispose }) => {
    if (caseId === 'first') return completed(output('first'));
    queueMicrotask(() => advance(501));
    return new Promise((resolve) => onDispose(() => resolve(completed(''))));
  }, { mode: 'ordinary' });
  const report = await result;
  assert.equal(report.runnerProcessCount, 1);
  assert.equal(report.results[1].timeoutReason, 'client-timeout');
  assert.deepEqual(calls, [
    ['admit', 0], ['run', 1, 'first', 'Clean'], ['reset'],
    ['admit', 1], ['run', 1, 'second', 'Clean'], ['dispose', 1], ['close'],
  ]);
});

test('observer-only batch preserves a budget stop without executing the clean companion', async () => {
  const { calls, result } = testBatch(({ entry }) =>
    completed(entry === 'Traced' ? fallback : output('clean')), { mode: 'observer' });
  const report = await result;
  assert.equal(report.results[1].traceLimitExceeded, true);
  assert.equal(report.results[1].output, undefined);
  assert.equal(calls.filter(([type]) => type === 'run').length, 3);
  assert.equal(report.runnerProcessCount, 1);
});

test('prepared Java trace fallback shares the case deadline and stops before dispatching the suffix', async () => {
  let cancelFallback;
  let fallbackCrossedDeadline;
  const { calls, result, timers } = testBatch(({ caseId, entry, advance, onDispose }) => {
    if (caseId === 'first' || caseId === 'suffix') return completed(output(caseId));
    if (entry === 'Traced') {
      advance(300);
      return completed(fallback);
    }
    return new Promise((resolve) => {
      onDispose(() => {
        cancelFallback = true;
        resolve({ status: 'cancelled', exitCode: 130, stdout: '', stderr: '' });
      });
      // Pass the remaining 200 ms but stay below a restarted 500 ms timer.
      queueMicrotask(() => {
        advance(201);
        fallbackCrossedDeadline = true;
        queueMicrotask(() => resolve(completed(output('late fallback'))));
      });
    });
  });
  const report = await result;
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].output, 'first');
  assert.equal(report.results[1].timeoutReason, 'client-timeout');
  assert.match(report.results[1].runtimeError, /500ms/);
  assert.equal(report.results[1].runTimeMs, 500);
  assert.equal(fallbackCrossedDeadline, true);
  assert.equal(cancelFallback, true);
  assert.deepEqual(calls, [
    ['run', 1, 'first', 'Clean'], ['reset'],
    ['run', 1, 'second', 'Traced'], ['dispose', 1], ['reset'],
    ['run', 2, 'second', 'Clean'], ['dispose', 2], ['close'],
  ]);
  assert.equal(timers.size, 0);
});

test('a nonstopping batch drains a cancelled case and isolates a tainted runner', async () => {
  const { calls, result } = testBatch(({ caseId, advance, onDispose }) => {
    if (caseId === 'second') {
      const run = new Promise((resolve) => onDispose(() => {
        setImmediate(() => {
          calls.push(['drained']);
          resolve({ status: 'cancelled', exitCode: 130, stdout: '', stderr: '' });
        });
      }));
      queueMicrotask(() => advance(501));
      return run;
    }
    return completed(output(caseId), caseId === 'first' ? 'tainted' : 'clean');
  }, { stop: false });
  const report = await result;
  assert.deepEqual(report.results.map((entry) => entry.output ?? entry.timeoutReason), ['first', 'client-timeout', 'suffix']);
  assert.equal(report.runnerProcessCount, 3);
  assert.deepEqual(calls, [
    ['run', 1, 'first', 'Clean'], ['dispose', 1], ['reset'],
    ['run', 2, 'second', 'Traced'], ['dispose', 2], ['drained'], ['reset'],
    ['run', 3, 'suffix', 'Clean'], ['dispose', 3], ['close'],
  ]);
});

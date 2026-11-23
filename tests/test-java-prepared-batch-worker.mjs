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

function testBatch(run, { stop = true } = {}) {
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
    postMessage() {},
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
      program: {}, executions: 0, algorithmIsolationProfile: { tier: 'algorithm-fast' },
    });
    traceJVMRunPreparedRuntimeProgramBatch(
      'p', 'Traced', '1', '[{"caseId":"first"},{"caseId":"second"},{"caseId":"suffix"}]',
      '500', '', '', '[false,true,false]', 'Clean', String(stop)
    );
  `, {
    self, client, stop, record: (event) => calls.push([event]), URL, TextDecoder, Uint8Array, atob,
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

import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { Worker } from 'node:worker_threads';

const BYTE_COUNT = 128 * 1024 * 1024;
const CLOCK = { wallClockMs: 30_000 };
const MEMORY_PROGRAM = `def solve(size):
    payload = bytearray(size)
    # Hold the allocation across the production memory sampling interval.
    for _ in range(240):
        pass
    return len(payload)`;
const SUM_PROGRAM = `def solve(n):
    total = sum(range(n))
    return total`;

let worker;
let requestId = 0;

function request(type, payload) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('No Python worker reply for ' + type)), 40_000);
    function finish(error, value) {
      clearTimeout(timeout);
      worker.off('message', onMessage);
      worker.off('error', finish);
      if (error) reject(error);
      else resolve(value);
    }
    function onMessage(reply) {
      if (reply.id !== id) return;
      finish(reply.type === 'error' ? new Error(reply.payload.error) : null, reply.payload);
    }
    worker.on('message', onMessage);
    worker.on('error', finish);
    worker.postMessage({ id, type, protocolToken: 'python-clock-memory-test', payload });
  });
}

before(async () => {
  worker = new Worker(new URL('./fixtures/python-clock-memory-worker.mjs', import.meta.url));
  const root = resolve('workers/python');
  const index = join(root, 'pyodide-0.29.3');
  await request('init', {
    runtimeAssets: {
      loaderUrl: join(index, 'pyodide.js'),
      indexUrl: index + '/',
      runtimeUrl: join(root, 'python-runtime.js'),
    },
  });
  await request('warmup', {});
});

after(async () => {
  await worker?.terminate();
});

async function prepare(code) {
  const result = await request('prepare-program', { code, mode: 'code', functionName: 'solve' });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.artifact.isolationProfile.tier, 'algorithm-fast', JSON.stringify(result.artifact.isolationProfile));
  return result.artifact;
}

function single(artifact, inputs, limits) {
  return request('execute-prepared-program', { artifact, mode: 'code', inputs, limits });
}

async function batch(artifact, inputBatch, limits) {
  const result = await request('execute-prepared-program-batch', { artifact, mode: 'code', inputBatch, limits });
  assert.equal(result.timings?.algorithmFastBatch, true, JSON.stringify(result));
  assert.equal(result.results.length, inputBatch.length);
  return result.results;
}

function outcome({ success, output, timeoutReason, error }) {
  return { success, output, timeoutReason, error };
}

test('Clock-only prepared single and fast batch allow the same 128 MiB allocation', async () => {
  const artifact = await prepare(MEMORY_PROGRAM);
  const inputs = { size: BYTE_COUNT };
  const alone = await single(artifact, inputs, CLOCK);
  const [batched, sibling] = await batch(artifact, [inputs, { size: 17 }], CLOCK);
  assert.deepEqual(outcome(batched), outcome(alone));
  assert.deepEqual(outcome(alone), outcome({ success: true, output: BYTE_COUNT }));
  assert.equal(sibling.output, 17);
});

test('An explicit memory cap produces the same typed limit and message in both routes', async () => {
  const artifact = await prepare(MEMORY_PROGRAM);
  const limits = { ...CLOCK, maxMemoryBytes: 96 * 1024 * 1024 };
  const inputs = { size: BYTE_COUNT };
  const alone = await single(artifact, inputs, limits);
  const [batched, sibling] = await batch(artifact, [inputs, { size: 17 }], limits);
  assert.deepEqual(outcome(alone), outcome(batched));
  assert.deepEqual(outcome(alone), {
    success: false, output: null, timeoutReason: 'memory-limit',
    error: 'Execution stopped: resource limit exceeded (memory-limit).',
  });
  assert.equal(sibling.output, 17);
});

test('A clock still arms deadline, line, and recursion guards in both routes', async () => {
  const checks = [
    { reason: 'client-timeout', code: SUM_PROGRAM, input: { n: 1_000_000 }, limits: { wallClockMs: 20 } },
    { reason: 'single-line-limit', code: 'def solve(n):\n    for _ in range(n):\n        pass\n    return n', input: { n: 1_500_001 }, limits: CLOCK },
    { reason: 'recursion-limit', code: 'def solve(n):\n    if n == 0:\n        return 0\n    return solve(n - 1)', input: { n: 2_500 }, limits: CLOCK },
  ];
  for (const { reason, code, input, limits } of checks) {
    const artifact = await prepare(code);
    const alone = await single(artifact, input, limits);
    const [batched, sibling] = await batch(artifact, [input, { n: 0 }], limits);
    assert.equal(alone.timeoutReason, reason, JSON.stringify(alone));
    assert.equal(batched.timeoutReason, reason, JSON.stringify(batched));
    assert.equal(sibling.output, 0, JSON.stringify(sibling));
  }
});

test('An untraced fast batch with its default clock keeps heavy body time within 1.3x of a default single', async (t) => {
  const artifact = await prepare(SUM_PROGRAM);
  const n = 3_000_000;
  const expected = n * (n - 1) / 2;
  const singles = [];
  const batches = [];
  const runSingle = async () => {
    const result = await single(artifact, { n });
    assert.equal(result.output, expected, JSON.stringify(result));
    singles.push(Number(result.consoleOutput[0]));
  };
  const runBatch = async () => {
    const [, result] = await batch(artifact, [{ n: 0 }, { n }], CLOCK);
    assert.equal(result.output, expected, JSON.stringify(result));
    batches.push(Number(result.consoleOutput[0]));
  };
  await runSingle();
  await runBatch();
  await runBatch();
  await runSingle();
  for (const sample of [...singles, ...batches]) assert.ok(Number.isFinite(sample) && sample > 0);
  const mean = (samples) => (samples[0] + samples[1]) / 2;
  const ratio = mean(batches) / mean(singles);
  t.diagnostic(JSON.stringify({ singleBodySeconds: singles, fastBatchBodySeconds: batches, ratio }));
  assert.ok(ratio <= 1.3, 'Fast batch to single guest body ratio: ' + ratio);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { javaProductionControlOutcome } from './java-production-control-witness.mjs';

function result(caseCount = 10) {
  return {
    java: { phases: [
      { worker: 1, role: 'legacy-trace', type: 'prepare-runtime-program' },
      { worker: 1, role: 'legacy-trace', type: 'execute-prepared-runtime-program-batch',
        cases: caseCount, tier: 'algorithm-fast', timings: { runnerProcessCount: 1 } },
    ] },
  };
}

test('accepts the published one-worker one-JVM batch shape', () => {
  assert.equal(javaProductionControlOutcome(result(), 'run', 10), undefined);
  const submit = result();
  assert.equal(javaProductionControlOutcome(submit, 'submit', 10), undefined);
  const click = result(1);
  click.java.phases.shift();
  assert.equal(javaProductionControlOutcome(click, 'click', 1), undefined);
});

test('does not require evidence fields introduced after the published release', () => {
  const published = result();
  assert.equal(published.evaluation, undefined);
  assert.equal(javaProductionControlOutcome(published, 'run', 10), undefined);
});

test('rejects per-case batches, worker replacement and restores', () => {
  const perCase = result();
  perCase.java.phases[1].cases = 1;
  assert.equal(javaProductionControlOutcome(perCase, 'run', 10),
    'Published Java single-worker witness differs');

  const replacement = result();
  replacement.java.phases[1].worker = 2;
  assert.equal(javaProductionControlOutcome(replacement, 'run', 10),
    'Published Java single-worker witness differs');

  const restored = result();
  restored.java.phases.push({ worker: 1, type: 'restore-prepared-runtime-program' });
  assert.equal(javaProductionControlOutcome(restored, 'run', 10),
    'Published Java single-worker witness differs');
});

test('requires explicit one-process evidence from the batch', () => {
  const missing = result();
  delete missing.java.phases[1].timings.runnerProcessCount;
  assert.equal(javaProductionControlOutcome(missing, 'run', 10),
    'Published Java single-worker witness differs');

  const restarted = result();
  restarted.java.phases[1].timings.runnerProcessCount = 10;
  assert.equal(javaProductionControlOutcome(restarted, 'run', 10),
    'Published Java single-worker witness differs');
});

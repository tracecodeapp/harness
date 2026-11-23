import assert from 'node:assert/strict';
import test from 'node:test';
import { javaCandidateOutcome } from './java-candidate-witness.mjs';

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function runResult(ordinaryWorker, observerWorker, caseCount) {
  return {
    java: {
      phases: [
        { worker: ordinaryWorker, role: 'ordinary', type: 'prepare-runtime-program' },
        {
          worker: ordinaryWorker,
          role: 'ordinary',
          type: 'execute-prepared-runtime-program-batch',
          cases: caseCount,
          tier: 'algorithm-fast',
          timings: {},
        },
        { worker: observerWorker, role: 'observer', type: 'prepare-runtime-program' },
        {
          worker: observerWorker,
          role: 'observer',
          type: 'execute-prepared-runtime-program-batch',
          cases: 1,
          timings: { runnerProcessCount: caseCount + 7 },
        },
      ],
    },
    evaluation: {
      cases: [{ id: 'selected', learnerLine: 4, attachment: { status: 'drawn' }, legacyRefusalFields: [] }],
    },
  };
}

test('seeded #77 controls accept a separate observer without folding it into ordinary reuse', () => {
  const next = random(212026);
  for (let i = 0; i < 32; i++) {
    const caseCount = 2 + Math.floor(next() * 30);
    const ordinaryWorker = 1 + Math.floor(next() * 1_000);
    let observerWorker = 1 + Math.floor(next() * 1_000);
    if (observerWorker === ordinaryWorker) observerWorker++;
    const result = runResult(ordinaryWorker, observerWorker, caseCount);
    assert.equal(javaCandidateOutcome(result, 'run', caseCount, 'selected'), undefined);
  }
});

test('seeded controls reject an ordinary path that restarts a JVM per case', () => {
  const next = random(212026);
  for (let i = 0; i < 32; i++) {
    const caseCount = 2 + Math.floor(next() * 30);
    const ordinaryWorker = 1 + Math.floor(next() * 1_000);
    const result = runResult(ordinaryWorker, ordinaryWorker + 1_001, caseCount);
    const batch = result.java.phases.find(({ role, type }) =>
      role === 'ordinary' && type === 'execute-prepared-runtime-program-batch');
    if (i % 2) {
      batch.tier = 'compatibility';
    } else {
      batch.timings.runnerProcessCount = caseCount;
    }
    assert.equal(javaCandidateOutcome(result, 'run', caseCount, 'selected'),
      'Java role, batch or worker-reuse witness differs');
  }
});

test('ordinary restores and shared outer workers remain invalid', () => {
  const restored = runResult(1, 2, 10);
  restored.java.phases.splice(1, 0,
    { worker: 1, role: 'ordinary', type: 'restore-prepared-runtime-program' });
  assert.equal(javaCandidateOutcome(restored, 'run', 10, 'selected'),
    'Java role, batch or worker-reuse witness differs');

  const shared = runResult(1, 1, 10);
  assert.equal(javaCandidateOutcome(shared, 'run', 10, 'selected'),
    'Java role, batch or worker-reuse witness differs');

  const missingWorker = runResult(undefined, 2, 10);
  assert.equal(javaCandidateOutcome(missingWorker, 'run', 10, 'selected'),
    'Java role, batch or worker-reuse witness differs');
});

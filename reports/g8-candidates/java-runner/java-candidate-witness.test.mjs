import assert from 'node:assert/strict';
import test from 'node:test';
import {
  javaCandidateCacheReceipt,
  javaCandidateOutcome,
  javaWorkerPhaseTimings,
} from './java-candidate-witness.mjs';

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
          timings: { runnerProcessCount: 1 },
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

test('ordinary batch rejects missing timings or runner-process evidence', () => {
  const noTimings = runResult(1, 2, 10);
  const noTimingsBatch = noTimings.java.phases.find(({ role, type }) =>
    role === 'ordinary' && type === 'execute-prepared-runtime-program-batch');
  delete noTimingsBatch.timings;
  assert.equal(javaCandidateOutcome(noTimings, 'run', 10, 'selected'),
    'Java role, batch or worker-reuse witness differs');

  const noRunnerProcessCount = runResult(1, 2, 10);
  const noCountBatch = noRunnerProcessCount.java.phases.find(({ role, type }) =>
    role === 'ordinary' && type === 'execute-prepared-runtime-program-batch');
  delete noCountBatch.timings.runnerProcessCount;
  assert.equal(javaCandidateOutcome(noRunnerProcessCount, 'run', 10, 'selected'),
    'Java role, batch or worker-reuse witness differs');
});

test('cache receipt records both candidate prepare roles without treating missing flags as hits', () => {
  const result = runResult(1, 2, 10);
  const ordinaryPrepare = result.java.phases[0];
  ordinaryPrepare.timings = { compileCacheHit: true, artifactCacheHit: false };
  const observerPrepare = result.java.phases[2];
  observerPrepare.timings = { compileCacheHit: false };
  assert.deepEqual(javaCandidateCacheReceipt(result), {
    ordinary: [{ role: 'ordinary', worker: 1, compileCacheHit: true, artifactCacheHit: false }],
    observer: [{ role: 'observer', worker: 2, compileCacheHit: false, artifactCacheHit: undefined }],
  });
});

test('seeded control rejects a second ordinary prepare', () => {
  const next = random(212026);
  for (let i = 0; i < 32; i++) {
    const caseCount = 2 + Math.floor(next() * 30);
    const run = runResult(i + 1, i + 101, caseCount);
    run.java.phases.unshift({
      worker: i + 1,
      role: 'ordinary',
      type: 'prepare-runtime-program',
      timings: { compileCacheHit: true, artifactCacheHit: true },
    });
    assert.equal(javaCandidateOutcome(run, 'run', caseCount, 'selected'),
      'Java role, batch or worker-reuse witness differs');

    const submit = runResult(i + 1, i + 101, caseCount);
    submit.java.phases = submit.java.phases.filter(({ role }) => role !== 'observer');
    submit.java.phases.unshift({ worker: i + 1, role: 'ordinary', type: 'prepare-runtime-program' });
    assert.equal(javaCandidateOutcome(submit, 'submit', caseCount),
      'Java role, batch or worker-reuse witness differs');

    const click = runResult(i + 1, i + 101, caseCount);
    click.java.phases = click.java.phases.filter(({ role, type }) =>
      role !== 'ordinary' && type !== 'prepare-runtime-program');
    click.java.phases.unshift({ worker: i + 1, role: 'ordinary', type: 'prepare-runtime-program' });
    assert.equal(javaCandidateOutcome(click, 'click', 1, 'selected'),
      'Java role, batch or worker-reuse witness differs');
  }
});

test('seeded control rejects ordinary singles and non-observer restores', () => {
  const next = random(212026);
  for (let i = 0; i < 32; i++) {
    const caseCount = 2 + Math.floor(next() * 30);
    const result = runResult(i + 1, i + 101, caseCount);
    result.java.phases.push(i % 2 === 0
      ? { worker: i + 1, role: 'ordinary', type: 'execute-prepared-runtime-program' }
      : { worker: 10_000 + i, type: 'restore-prepared-runtime-program' });
    assert.equal(javaCandidateOutcome(result, 'run', caseCount, 'selected'),
      'Java role, batch or worker-reuse witness differs');
  }
});

test('seeded control takes runner count only from the first result timings', () => {
  const next = random(212026);
  for (let i = 0; i < 32; i++) {
    const envelopeCount = 1 + Math.floor(next() * 5);
    const timings = javaWorkerPhaseTimings({
      timings: { runnerProcessCount: envelopeCount, compileCacheHit: true },
      results: [{ timings: { compileCacheHit: true } }],
    });
    assert.deepEqual(timings, { compileCacheHit: true });
  }
});

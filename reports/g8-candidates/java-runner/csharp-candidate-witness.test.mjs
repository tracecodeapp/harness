import assert from 'node:assert/strict';
import test from 'node:test';
import {
  csharpCandidateCacheReceipt,
  csharpCandidateOutcome,
} from './csharp-candidate-witness.mjs';

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function runResult(ordinaryWorker, observerWorker, caseCount) {
  const ordinaryKey = 'ordinary-' + ordinaryWorker;
  const observerKey = 'observer-' + observerWorker;
  return {
    csharp: {
      phases: [
        {
          worker: 1,
          workerKind: 'compiler',
          role: 'ordinary',
          type: 'prepare-program',
          mode: 'code',
          artifactKey: ordinaryKey,
          timings: { compileCacheHit: false, artifactCacheHit: false },
        },
        ...Array.from({ length: caseCount }, () => ({
          worker: ordinaryWorker,
          workerKind: 'runner',
          role: 'ordinary',
          type: 'execute-prepared-code',
          artifactKey: ordinaryKey,
          tier: 'algorithm-fast',
          timings: {
            executionRealm: 'retained-worker-collectible-context',
            compileCacheHit: true,
            artifactCacheHit: true,
          },
        })),
        {
          worker: 1,
          workerKind: 'compiler',
          role: 'observer',
          type: 'prepare-program',
          mode: 'trace',
          artifactKey: observerKey,
          timings: { compileCacheHit: false, artifactCacheHit: false },
        },
        {
          worker: observerWorker,
          workerKind: 'runner',
          role: 'observer',
          type: 'execute-prepared-trace',
          observation: true,
          artifactKey: observerKey,
          tier: 'algorithm-fast',
          timings: {
            executionRealm: 'retained-worker-collectible-context',
            compileCacheHit: true,
            artifactCacheHit: true,
          },
        },
      ],
    },
    evaluation: {
      cases: [{ id: 'selected', learnerLine: 4, attachment: { status: 'drawn' }, legacyRefusalFields: [] }],
    },
  };
}

test('seeded controls accept one reset-in-place ordinary runner and a distinct observer', () => {
  const next = random(622026);
  for (let i = 0; i < 32; i++) {
    const caseCount = 2 + Math.floor(next() * 30);
    const ordinaryWorker = 10 + Math.floor(next() * 1_000);
    let observerWorker = 10 + Math.floor(next() * 1_000);
    if (observerWorker === ordinaryWorker) observerWorker++;
    assert.equal(csharpCandidateOutcome(
      runResult(ordinaryWorker, observerWorker, caseCount),
      'run',
      caseCount,
      'selected',
    ), undefined);
  }
});

test('seeded controls reject an ordinary runner restart per case', () => {
  const next = random(622026);
  for (let i = 0; i < 32; i++) {
    const caseCount = 2 + Math.floor(next() * 30);
    const result = runResult(i + 100, i + 10_000, caseCount);
    const executions = result.csharp.phases.filter(({ role, type }) =>
      role === 'ordinary' && type === 'execute-prepared-code');
    executions.forEach((phase, index) => { phase.worker += index; });
    assert.equal(csharpCandidateOutcome(result, 'run', caseCount, 'selected'),
      'C# assembly, reset or observer witness differs');
  }
});

test('seeded controls reject a shared observer runner', () => {
  const next = random(622026);
  for (let i = 0; i < 32; i++) {
    const caseCount = 2 + Math.floor(next() * 30);
    const worker = 10 + Math.floor(next() * 1_000);
    assert.equal(csharpCandidateOutcome(runResult(worker, worker, caseCount), 'run', caseCount, 'selected'),
      'C# assembly, reset or observer witness differs');
  }
});

test('ordinary assembly, reset evidence and restores fail closed', () => {
  const secondPrepare = runResult(2, 3, 10);
  secondPrepare.csharp.phases.unshift({
    worker: 1,
    workerKind: 'compiler',
    role: 'ordinary',
    type: 'prepare-program',
    mode: 'code',
    artifactKey: 'ordinary-2',
  });
  assert.equal(csharpCandidateOutcome(secondPrepare, 'run', 10, 'selected'),
    'C# assembly, reset or observer witness differs');

  const noReset = runResult(2, 3, 10);
  const ordinary = noReset.csharp.phases.find(({ role, type }) =>
    role === 'ordinary' && type === 'execute-prepared-code');
  delete ordinary.timings.executionRealm;
  assert.equal(csharpCandidateOutcome(noReset, 'run', 10, 'selected'),
    'C# assembly, reset or observer witness differs');

  const restored = runResult(2, 3, 10);
  restored.csharp.phases.push({
    worker: 2,
    workerKind: 'runner',
    role: 'ordinary',
    type: 'restore-prepared-program',
  });
  assert.equal(csharpCandidateOutcome(restored, 'run', 10, 'selected'),
    'C# assembly, reset or observer witness differs');
});

test('one matching end-of-program disposal is cleanup, not a per-case reload', () => {
  const result = runResult(2, 3, 10);
  result.csharp.phases.push(
    {
      worker: 1,
      workerKind: 'compiler',
      role: 'ordinary',
      type: 'dispose-prepared-program',
      artifactKey: 'ordinary-2',
    },
    {
      worker: 1,
      workerKind: 'compiler',
      role: 'observer',
      type: 'dispose-prepared-program',
      artifactKey: 'observer-3',
    },
  );
  assert.equal(csharpCandidateOutcome(result, 'run', 10, 'selected'), undefined);

  result.csharp.phases.push({
    worker: 1,
    workerKind: 'compiler',
    role: 'ordinary',
    type: 'dispose-prepared-program',
    artifactKey: 'ordinary-2',
  });
  assert.equal(csharpCandidateOutcome(result, 'run', 10, 'selected'),
    'C# assembly, reset or observer witness differs');
});

test('submit has no observer and click has no ordinary reload', () => {
  const submit = runResult(2, 3, 10);
  submit.csharp.phases = submit.csharp.phases.filter(({ role }) => role !== 'observer');
  assert.equal(csharpCandidateOutcome(submit, 'submit', 10), undefined);

  const click = runResult(2, 3, 10);
  click.csharp.phases = click.csharp.phases.filter(({ role, type }) =>
    role === 'observer' && type === 'execute-prepared-trace');
  assert.equal(csharpCandidateOutcome(click, 'click', 1, 'selected'), undefined);
});

test('cache receipt keeps reported ordinary and observer flags', () => {
  const result = runResult(2, 3, 2);
  assert.deepEqual(csharpCandidateCacheReceipt(result), {
    ordinary: [
      { type: 'prepare-program', worker: 1, compileCacheHit: false, artifactCacheHit: false },
      { type: 'execute-prepared-code', worker: 2, compileCacheHit: true, artifactCacheHit: true },
      { type: 'execute-prepared-code', worker: 2, compileCacheHit: true, artifactCacheHit: true },
    ],
    observer: [
      { type: 'prepare-program', worker: 1, compileCacheHit: false, artifactCacheHit: false },
      { type: 'execute-prepared-trace', worker: 3, compileCacheHit: true, artifactCacheHit: true },
    ],
  });
});

test('observer reply may omit timings but must keep its prepared artifact identity', () => {
  const capturedShape = runResult(2, 3, 10);
  const observer = capturedShape.csharp.phases.find(({ role, type }) =>
    role === 'observer' && type === 'execute-prepared-trace');
  delete observer.timings;
  assert.equal(csharpCandidateOutcome(capturedShape, 'run', 10, 'selected'), undefined);
  assert.deepEqual(csharpCandidateCacheReceipt(capturedShape).observer, [
    { type: 'prepare-program', worker: 1, compileCacheHit: false, artifactCacheHit: false },
  ]);

  observer.artifactKey = 'another-observer-artifact';
  assert.equal(csharpCandidateOutcome(capturedShape, 'run', 10, 'selected'),
    'C# assembly, reset or observer witness differs');
});

function addTrustedReplenishment(result, worker = 90, artifactKey = 'trusted-warmup') {
  result.csharp.phases.push(
    { worker, workerKind: 'runner', role: 'ordinary', type: 'init', received: 1 },
    { worker, workerKind: 'runner', role: 'ordinary', type: 'warmup', received: 2 },
    { worker, workerKind: 'runner', role: 'ordinary', type: 'execute-prepared-code',
      tier: 'compatibility', artifactKey, received: 3,
      timings: { compileCacheHit: true, artifactCacheHit: true } },
  );
  return result;
}

test('accepts a positively identified trusted replenishment without folding it into learner reuse', () => {
  const result = addTrustedReplenishment(runResult(2, 3, 10));
  assert.equal(csharpCandidateOutcome(result, 'run', 10, 'selected', 'trusted-warmup'), undefined);
  const receipt = csharpCandidateCacheReceipt(result, 'trusted-warmup');
  assert.equal(receipt.ordinary.some(({ worker }) => worker === 90), false);
  assert.deepEqual(receipt.replenishment, [{
    type: 'execute-prepared-code', worker: 90,
    compileCacheHit: true, artifactCacheHit: true,
  }]);
});

test('rejects a compatibility-labeled learner artifact on a second worker', () => {
  const result = addTrustedReplenishment(runResult(2, 3, 10), 90,
    'learner-compatibility-artifact');
  assert.equal(csharpCandidateOutcome(result, 'run', 10, 'selected', 'trusted-warmup'),
    'C# assembly, reset or observer witness differs');
});

test('rejects a learner command sent to the trusted replenishment worker', () => {
  const result = addTrustedReplenishment(runResult(2, 3, 10));
  result.csharp.phases.push({
    worker: 90,
    workerKind: 'runner',
    role: 'ordinary',
    type: 'execute-prepared-code',
    tier: 'algorithm-fast',
    artifactKey: 'ordinary-2',
    received: 4,
    timings: {
      executionRealm: 'retained-worker-collectible-context',
      compileCacheHit: true,
      artifactCacheHit: true,
    },
  });
  assert.match(csharpCandidateOutcome(result, 'run', 10, 'selected', 'trusted-warmup'),
    /trusted standby|assembly, reset/);
});

test('pending trusted prime is scoped to an explicit Submit-after-Run allowance', () => {
  const result = addTrustedReplenishment(runResult(2, 3, 10));
  result.csharp.phases = result.csharp.phases.filter(({ role }) => role !== 'observer');
  const prime = result.csharp.phases.find(({ artifactKey }) => artifactKey === 'trusted-warmup');
  delete prime.received;
  delete prime.timings;

  assert.equal(csharpCandidateOutcome(result, 'submit', 10, undefined, 'trusted-warmup'),
    'C# trusted standby replenishment witness differs');
  assert.equal(csharpCandidateOutcome(result, 'submit', 10, undefined, 'trusted-warmup', {
    allowPendingTrustedPrime: true,
  }), undefined);

  result.csharp.phases.push({
    worker: prime.worker,
    workerKind: 'runner',
    role: 'ordinary',
    type: 'execute-prepared-code',
    tier: 'algorithm-fast',
    artifactKey: 'ordinary-2',
    received: 4,
  });
  assert.match(csharpCandidateOutcome(result, 'submit', 10, undefined, 'trusted-warmup', {
    allowPendingTrustedPrime: true,
  }), /trusted standby|assembly, reset/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { csharpProductionControlOutcome } from './csharp-production-control-witness.mjs';

test('accepts the published single C# worker shape', () => {
  const result = { csharp: { phases: Array.from({ length: 10 }, () => ({
    worker: 1, type: 'execute-code', received: 10,
  })) } };
  assert.equal(csharpProductionControlOutcome(result), undefined);
});

test('rejects per-case worker replacement, missing replies and missing execution evidence', () => {
  const restarted = { csharp: { phases: Array.from({ length: 10 }, (_, index) => ({
    worker: index + 1, type: 'execute-code', received: 10,
  })) } };
  assert.equal(csharpProductionControlOutcome(restarted),
    'Published C# single-worker witness differs');

  const missing = { csharp: { phases: [{ worker: 1, type: 'execute-code' }] } };
  assert.equal(csharpProductionControlOutcome(missing),
    'Published C# single-worker witness differs');
  assert.equal(csharpProductionControlOutcome({ csharp: { phases: [] } }),
    'Published C# single-worker witness differs');
});

function trustedReplenishment(worker = 9, artifactKey = 'trusted-warmup') {
  return [
    { worker, workerKind: 'runner', role: 'ordinary', type: 'init', received: 1 },
    { worker, workerKind: 'runner', role: 'ordinary', type: 'warmup', received: 2 },
    { worker, workerKind: 'runner', role: 'ordinary', type: 'execute-prepared-code', tier: 'compatibility',
      artifactKey, received: 3 },
  ];
}

test('positively recognizes only the pre-registered trusted standby prime', () => {
  const result = { csharp: { phases: [
    ...trustedReplenishment(),
    ...Array.from({ length: 10 }, () => ({ worker: 1, type: 'execute-code', received: 10 })),
  ] } };
  assert.equal(csharpProductionControlOutcome(result, 'trusted-warmup'), undefined);

  result.csharp.phases[2].artifactKey = 'learner-compatibility-artifact';
  assert.equal(csharpProductionControlOutcome(result, 'trusted-warmup'),
    'Published C# single-worker witness differs');
});

test('rejects learner commands on a recognized replenishment worker', () => {
  const result = { csharp: { phases: [
    ...trustedReplenishment(),
    { worker: 9, role: 'ordinary', type: 'execute-prepared-code', tier: 'algorithm-fast',
      artifactKey: 'learner', received: 4 },
    ...Array.from({ length: 10 }, () => ({ worker: 1, type: 'execute-code', received: 10 })),
  ] } };
  assert.match(csharpProductionControlOutcome(result, 'trusted-warmup'),
    /trusted standby|single-worker/);
});

function promotedOrdinaryResult(caseCount = 3) {
  const learnerKey = 'learner-algorithm-fast';
  return { csharp: { phases: [
    { worker: 1, workerKind: 'compiler', role: 'observer', type: 'prepare-program',
      tier: 'algorithm-fast', artifactKey: learnerKey, received: 0 },
    ...trustedReplenishment(),
    ...Array.from({ length: caseCount }, () => ({
      worker: 9, workerKind: 'runner', role: 'ordinary', type: 'execute-prepared-trace',
      tier: 'algorithm-fast', artifactKey: learnerKey, received: 4,
      timings: {
        executionRealm: 'retained-worker-collectible-context',
        compileCacheHit: true,
        artifactCacheHit: true,
      },
    })),
  ] } };
}

test('accepts only the exact measured-path promotion of the trusted standby worker', () => {
  const result = promotedOrdinaryResult();
  assert.equal(csharpProductionControlOutcome(result, 'trusted-warmup', { caseCount: 3 }),
    undefined);

  result.csharp.phases.at(-1).artifactKey = 'other-learner-artifact';
  assert.equal(csharpProductionControlOutcome(result, 'trusted-warmup', { caseCount: 3 }),
    'C# trusted standby replenishment witness differs');
});

test('lesson promotion requires the trusted prime when runner setup and learner work coexist', () => {
  const result = promotedOrdinaryResult();
  const options = { caseCount: 3, requireTrustedPromotionEvidence: true };
  assert.equal(csharpProductionControlOutcome(result, 'trusted-warmup', options), undefined);

  result.csharp.phases = result.csharp.phases.filter(({ artifactKey }) =>
    artifactKey !== 'trusted-warmup');
  assert.equal(csharpProductionControlOutcome(result, 'trusted-warmup', options),
    'C# trusted standby replenishment witness differs');
});

test('rejects extra learner workers and per-case restarts beside a promoted worker', () => {
  const extraWorker = promotedOrdinaryResult();
  extraWorker.csharp.phases.push({
    worker: 10, workerKind: 'runner', role: 'ordinary', type: 'execute-prepared-trace',
    tier: 'compatibility', artifactKey: 'learner-algorithm-fast', received: 5,
  });
  assert.equal(csharpProductionControlOutcome(extraWorker, 'trusted-warmup', { caseCount: 3 }),
    'Published C# single-worker witness differs');

  const restarted = promotedOrdinaryResult();
  restarted.csharp.phases.at(-1).worker = 10;
  assert.equal(csharpProductionControlOutcome(restarted, 'trusted-warmup', { caseCount: 3 }),
    'C# trusted standby replenishment witness differs');
});

test('accepts an exact pending trusted prime only for Submit-after-Run replenishment', () => {
  const result = { csharp: { phases: [
    ...trustedReplenishment(),
    ...Array.from({ length: 3 }, () => ({
      worker: 1, type: 'execute-code', received: 10,
    })),
  ] } };
  const prime = result.csharp.phases[2];
  delete prime.received;
  assert.equal(csharpProductionControlOutcome(result, 'trusted-warmup'),
    'C# trusted standby replenishment witness differs');
  assert.equal(csharpProductionControlOutcome(result, 'trusted-warmup', {
    allowPendingTrustedPrime: true,
  }), undefined);

  prime.received = null;
  prime.timings = null;
  assert.equal(csharpProductionControlOutcome(result, 'trusted-warmup', {
    allowPendingTrustedPrime: true,
  }), 'C# trusted standby replenishment witness differs');
});

test('pending trusted prime still rejects missing setup and any learner command', () => {
  const missingWarmup = { csharp: { phases: [
    ...trustedReplenishment().filter(({ type }) => type !== 'warmup'),
    { worker: 1, type: 'execute-code', received: 10 },
  ] } };
  delete missingWarmup.csharp.phases[1].received;
  assert.equal(csharpProductionControlOutcome(missingWarmup, 'trusted-warmup', {
    allowPendingTrustedPrime: true,
  }), 'C# trusted standby replenishment witness differs');

  const learnerCommand = { csharp: { phases: [
    ...trustedReplenishment(),
    { worker: 9, workerKind: 'runner', role: 'ordinary', type: 'execute-prepared-code',
      tier: 'algorithm-fast', artifactKey: 'learner', received: 4 },
    { worker: 1, type: 'execute-code', received: 10 },
  ] } };
  delete learnerCommand.csharp.phases[2].received;
  assert.equal(csharpProductionControlOutcome(learnerCommand, 'trusted-warmup', {
    allowPendingTrustedPrime: true,
  }), 'C# trusted standby replenishment witness differs');
});

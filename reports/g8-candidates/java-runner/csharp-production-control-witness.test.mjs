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
    { worker, role: 'ordinary', type: 'init', received: 1 },
    { worker, role: 'ordinary', type: 'warmup', received: 2 },
    { worker, role: 'ordinary', type: 'execute-prepared-code', tier: 'compatibility',
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

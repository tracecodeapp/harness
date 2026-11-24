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

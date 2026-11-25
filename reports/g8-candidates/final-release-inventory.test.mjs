import assert from 'node:assert/strict';
import test from 'node:test';

import { finalReleaseShapeInventory } from './final-release-inventory.mjs';

test('the only uncaptured shapes are pre-registered for the final Python capture', () => {
  const rows = finalReleaseShapeInventory();
  assert.ok(rows.length > 0);
  const missing = rows.filter((row) => row.witnessRequired && !row.captured);
  assert.equal(missing.length, 11);
  assert.ok(missing.every((row) => row.language === 'python' && row.scope === 'desktop'));
  assert.deepEqual(new Set(missing.map((row) => row.witnessVersion)),
    new Set(['0.17.1', 'sequential']));
  assert.deepEqual(new Set(rows.map((row) => row.language)),
    new Set(['javascript', 'typescript', 'python', 'cpp', 'java', 'csharp']));
  assert.deepEqual(new Set(rows.map((row) => row.scope)), new Set(['phone', 'desktop']));
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const references = JSON.parse(readFileSync(new URL('./host-check-references.json', import.meta.url)));

test('keeps every re-recorded host check beside its frozen value and reason', () => {
  assert.equal(references.schema, 'tracecode.speed-host-check-references.v1');
  assert.equal(references.date, '2026-11-24');
  assert.equal(references.rows.length, 6);
  for (const row of references.rows) {
    assert.ok(row.oldReference.n >= 0 && row.newReference.n === 20);
    if (row.oldReference.n > 0) {
      assert.ok(Number.isFinite(row.oldReference.median) && Number.isFinite(row.oldReference.p90));
    } else {
      assert.equal(row.reason, 'The frozen host-check reference was missing.');
    }
    assert.ok(Number.isFinite(row.newReference.median) && Number.isFinite(row.newReference.p90));
    assert.ok(row.reason.length > 0);
  }
  assert.equal(new Set(references.rows.map(({ cell, version }) => `${cell}/${version}`)).size, 6);
});

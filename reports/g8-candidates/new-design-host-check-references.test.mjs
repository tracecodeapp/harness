import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const references = JSON.parse(readFileSync(
  new URL('./new-design-host-check-references.json', import.meta.url)));

test('pins the accepted C# fresh, repeat and Submit A/A host checks', () => {
  assert.equal(references.schema, 'tracecode.speed-new-design-host-check-references.v1');
  assert.equal(references.date, '2026-11-24');
  assert.equal(references.rows.length, 16);
  assert.equal(new Set(references.rows.map(({ cell, version }) =>
    `${cell}/${version}`)).size, 16);
  for (const row of references.rows) {
    assert.match(row.cell, /^csharp\/1\/(binary-search|permutations)\/warm\//);
    assert.equal(row.version, '0.17.1');
    assert.equal(row.reference.n, 40);
    assert.ok(Number.isFinite(row.reference.median) && row.reference.median > 0);
    assert.ok(Number.isFinite(row.reference.p90) && row.reference.p90 > 0);
    assert.match(row.source, /^accepted C# /);
  }
});

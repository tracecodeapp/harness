import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const report = JSON.parse(await readFile(process.argv[2], 'utf8')).languages.typescript;
const programs = ['runtime-error', 'recursive-limit', 'runtime-names', 'top-level-process', 'raw-import-text'];
const shared = ['first-drawing', 'trace-limit', 'runaway', 'compile-failure', 'refused', 'disposed', 'abandoned'];
const expected = programs.flatMap((id) =>
  [...shared, `interactive/${id}`, `all/${id}`].map((history) => `${id}/${history}`),
).sort();
const differences = Object.entries(report.programs).flatMap(([id, { histories }]) =>
  histories.filter((entry) => entry.differences.length).map(({ name }) => `${id}/${name}`),
).sort();
assert.equal(report.comparisons, 330, 'G2/TS/b025fdb8/comparisons');
assert.equal(report.differences, 45, 'G2/TS/b025fdb8/differences');
assert.equal(report.verdict, 'VIOLATED', 'G2/TS/b025fdb8/verdict');
assert.deepEqual(differences, expected, 'G2/TS/b025fdb8/difference-keys');
console.log('G2/TS/b025fdb8: reproduced 330 comparisons and all 45 archived difference keys');

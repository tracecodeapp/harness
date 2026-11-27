import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { selectCells } from '../../scripts/gates/select.mjs';
import { candidatePlan } from '../../scripts/gates/candidate-all.mjs';

const { cells, noCell } = JSON.parse(readFileSync('scripts/gates/cells.json', 'utf8'));
const python = cells.find(({ id }) => id === 'python-project-paths');
const java = cells.find(({ id }) => id === 'java-runtime');
const workflow = {
  id: 'ci-workflow', inputs: ['.github/workflows/ci.yml', 'reports/required.json'],
};
const inventory = { cells: [python, java, workflow], noCell };
const all = ['ci-workflow', 'java-runtime', 'python-project-paths'];

test('the selector scopes language inputs and ignores a regenerated lock', () => {
  assert.deepEqual(selectCells(inventory, ['workers/java/worker.js', 'runtime-assets.lock.json']), ['java-runtime']);
  assert.deepEqual(selectCells(inventory, ['workers/python/worker.js']), ['python-project-paths']);
  assert.deepEqual(selectCells(inventory, ['packages/runtime-contracts/src/runtime-calls.ts']), all);
});

test('claimed paths take precedence over noCell and unfamiliar files select the full inventory', () => {
  assert.deepEqual(selectCells(inventory, ['CHANGELOG.md', '.github/workflows/unclaimed.yml', '.gitignore']), []);
  assert.deepEqual(selectCells(inventory, ['.github/workflows/ci.yml', 'reports/required.json']), ['ci-workflow']);
  assert.deepEqual(selectCells(inventory, ['tests/fixtures/expectation.md']), all);
  assert.deepEqual(selectCells(inventory, ['new-directory/runner.mjs']), all);
});

test('the candidate plan schedules every cell once on its declared host', () => {
  const plan = candidatePlan(cells);
  const scheduled = Object.entries(plan).flatMap(([host, group]) => group.map((cell) => {
    assert.equal(cell.host, host);
    return cell.id;
  }));
  assert.deepEqual(scheduled.sort(), cells.map(({ id }) => id).sort());
  assert.equal(plan.agentrunner.filter(({ id }) => id === 'canary').length, 1);
  const ci = plan.ci.map(({ id }) => id);
  assert(ci.indexOf('build-tracekernel') < ci.indexOf('python-prepared-provider'));
  assert(ci.indexOf('build') < ci.indexOf('packaged-surface'));
});

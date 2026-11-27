import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

test('the selector respects runtime ownership and ignores a regenerated lock', () => {
  assert.deepEqual(selectCells(inventory, ['workers/java/worker.js', 'runtime-assets.lock.json']), ['java-runtime']);
  assert.deepEqual(selectCells(inventory, ['workers/python/worker.js']), ['java-runtime', 'python-project-paths']);
  assert.deepEqual(selectCells(inventory, ['packages/runtime-contracts/src/runtime-calls.ts']), all);
});

test('manifest edits select only callers of changed scripts unless a shared field changes', () => {
  const before = {
    devDependencies: { tsx: '1.0.0' },
    scripts: {
      'test:python-project-paths': 'pnpm run python-wrapper',
      'python-wrapper': 'npm run python-leaf',
      'python-leaf': 'node python-test.mjs',
      'test:java-runtime': 'node java-test.mjs',
    },
  };
  const after = structuredClone(before);
  const selected = () => selectCells(inventory, ['package.json'], { before, after });

  after.scripts['test:unrelated'] = 'node unrelated-test.mjs';
  assert.deepEqual(selected(), []);
  after.scripts['python-leaf'] += ' --strict';
  assert.deepEqual(selected(), ['python-project-paths']);
  after.devDependencies.tsx = '2.0.0';
  assert.deepEqual(selected(), all);
  assert.deepEqual(selectCells({ cells, noCell }, ['package.json'], { before, after }),
    cells.map(({ id }) => id).sort());
});

test('claimed paths take precedence over noCell and unfamiliar files select the full inventory', () => {
  assert.deepEqual(selectCells(inventory, ['CHANGELOG.md', '.github/workflows/unclaimed.yml', '.gitignore']), []);
  assert.deepEqual(selectCells(inventory, ['.github/workflows/ci.yml', 'reports/required.json']), ['ci-workflow']);
  assert.deepEqual(selectCells(inventory, ['tests/fixtures/expectation.md']), all);
  assert.deepEqual(selectCells(inventory, ['new-directory/runner.mjs']), all);
  assert.deepEqual(selectCells({ cells, noCell }, [
    'docs/gates.md', 'AGENTS.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'benchmarks/speed-baseline-021/run.mjs',
    'reports/evidence.json', '.gitignore', '.github/workflows/unclaimed.yml', 'runtime-assets.lock.json',
  ]), []);
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

test('candidate-all invokes each local cell once and reports failed cells', () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-all-test-'));
  const checkout = join(root, 'checkout');
  const runner = resolve('scripts/gates/candidate-all.mjs');
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' });
  try {
    mkdirSync(join(checkout, 'scripts/gates'), { recursive: true });
    const cells = [
      { id: 'first', host: 'laptop-unit', command: 'echo CHECK-FIRST; exit 3', pins: {} },
      { id: 'second', host: 'laptop-unit', command: 'echo CHECK-SECOND', pins: {} },
      { id: 'other-host', host: 'agentrunner', command: 'echo CHECK-OTHER', pins: {} },
    ];
    writeFileSync(join(checkout, 'scripts/gates/cells.json'), JSON.stringify({ cells, noCell: [] }));
    git('init', '--quiet');
    git('add', '.');
    git('-c', 'user.name=Gate Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '-m', 'candidate inventory');
    const result = spawnSync(process.execPath, [runner, '--rev', 'HEAD', '--host', 'laptop-unit'], {
      cwd: checkout, encoding: 'utf8', env: { ...process.env, TMPDIR: root },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.stdout.match(/^CHECK-.+$/gm), ['CHECK-FIRST', 'CHECK-SECOND']);
    assert.deepEqual(JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))).results,
      [{ cell: 'first', exitCode: 3 }, { cell: 'second', exitCode: 0 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the selector reads both compared inventories instead of checkout HEAD', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-select-revs-'));
  const selector = resolve('scripts/gates/select.mjs');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  try {
    mkdirSync(join(root, 'scripts/gates'), { recursive: true });
    function commit(cells, oldValue, newValue) {
      writeFileSync(join(root, 'scripts/gates/cells.json'), JSON.stringify({
        cells, noCell: ['scripts/gates/cells.json'],
      }));
      writeFileSync(join(root, 'old.mjs'), oldValue);
      writeFileSync(join(root, 'new.mjs'), newValue);
      git('add', '.');
      git('-c', 'user.name=Gate Test', '-c', 'user.email=test@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'snapshot');
      return git('rev-parse', 'HEAD').trim();
    }
    git('init', '--quiet');
    const base = commit([{ id: 'base-cell', inputs: ['old.mjs'] }], 'old', 'old');
    const head = commit([{ id: 'head-cell', inputs: ['new.mjs'] }], 'new', 'new');
    commit([{ id: 'checkout-cell', inputs: ['old.mjs', 'new.mjs'] }], 'other', 'other');
    const output = execFileSync(process.execPath, [selector, '--base', base, '--head', head], {
      cwd: root, encoding: 'utf8',
    });
    assert.deepEqual(output.trim().split('\n'), ['base-cell', 'head-cell']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

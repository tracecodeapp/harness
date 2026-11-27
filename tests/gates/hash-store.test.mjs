import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { hashCell } from '../../scripts/gates/cell-hash.mjs';
import { git, loadCell } from '../../scripts/gates/inventory.mjs';
import { readCellPass, readPass, writeResult } from '../../scripts/gates/result-store.mjs';
import { allowedEnvironment } from '../../scripts/gates/host-pins.mjs';

function change(file, contents) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function commit(message) {
  git('add', '-A');
  git('-c', 'user.name=Gate Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message);
  return git('rev-parse', 'HEAD').trim();
}

test('hashes Git blobs, the cell, and its pins', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-hash-'));
  const cwd = process.cwd();
  try {
    process.chdir(root);
    git('init', '--quiet');
    const cell = {
      id: 'python', language: 'python', command: 'node tests/gate.mjs', host: 'agentrunner',
      inputs: ['workers/python/**', 'scripts/gates/**', 'tests/gate.mjs'],
      pins: { engine: '1.0' },
    };
    change('scripts/gates/cells.json', JSON.stringify([cell]));
    change('workers/python/input.py', 'x = 1\n');
    change('workers/java/input.java', 'class A {}\n');
    change('src/shared.ts', 'export const x = 1;\n');
    change('tests/gate.mjs', 'console.log("gate");\n');
    const initial = commit('initial tree');
    const base = hashCell(loadCell(initial, 'python'), initial);

    change('workers/java/input.java', 'class B {}\n');
    const unrelated = commit('unrelated language');
    assert.equal(hashCell(cell, unrelated), base);

    change('workers/python/input.py', 'x = 2\n');
    assert.equal(hashCell(cell, unrelated), base);
    const own = commit('own input');
    assert.notEqual(hashCell(cell, own), base);

    git('update-index', '--chmod=+x', 'workers/python/input.py');
    git('-c', 'user.name=Gate Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'mode-only change');
    assert.notEqual(hashCell(cell, git('rev-parse', 'HEAD').trim()), hashCell(cell, own));

    change('src/shared.ts', 'export const x = 2;\n');
    const shared = commit('shared input');
    assert.notEqual(hashCell(cell, shared), hashCell(cell, own));
    assert.notEqual(hashCell({ ...cell, pins: { engine: '2.0' } }, initial), base);
    assert.notEqual(hashCell({ ...cell, command: 'node --test tests/gate.mjs' }, initial), base);

    const host = { node: 'v22.18.0', playwrightBrowsers: ['chromium-1208'], candidateTarballSha256: 'a'.repeat(64) };
    const withHost = hashCell(cell, initial, host);
    assert.notEqual(withHost, base);
    assert.equal(withHost, hashCell(cell, initial, Object.fromEntries(Object.entries(host).reverse())));
    assert.notEqual(withHost, hashCell(cell, initial, { ...host, node: 'v22.19.0' }));
    assert.notEqual(withHost, hashCell(cell, initial, { ...host, playwrightBrowsers: ['chromium-1255'] }));
    assert.notEqual(withHost, hashCell(cell, initial, { ...host, candidateTarballSha256: 'b'.repeat(64) }));
    assert.notEqual(hashCell(cell, initial, host, 'gate-a'), hashCell(cell, initial, host, 'gate-b'));
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('the store serves only passes for the requested key', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-store-'));
  const record = {
    cell: 'python', hash: 'a'.repeat(64), jobId: 'job-1', end: '2026-11-27T04:00:00Z',
  };
  const cached = () => readPass(root, record.cell, record.hash);
  try {
    assert.equal(cached(), undefined);
    writeResult(root, { ...record, status: 'fail', exitCode: 1 });
    assert.equal(cached(), undefined);
    const success = { ...record, status: 'pass', exitCode: 0 };
    writeResult(root, success);
    assert.deepEqual(cached(), success);
    assert.deepEqual(readCellPass(root, { id: record.cell }, record.hash), success);
    assert.equal(readCellPass(root, { id: record.cell }, record.hash, true), undefined);
    writeResult(root, { ...success, cell: 'ga-python' });
    assert.equal(readCellPass(root, { id: 'ga-python' }, record.hash), undefined);
    assert.equal(readPass(root, record.cell, 'b'.repeat(64)), undefined);
    writeResult(root, { ...record, status: 'fail', exitCode: 1, jobId: 'job-2' });
    assert.equal(cached(), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('regenerating the runtime asset lock after a Java edit preserves the Python key', () => {
  const { cells } = JSON.parse(readFileSync('scripts/gates/cells.json', 'utf8'));
  const cell = cells.find(({ id }) => id === 'python-project-paths');
  assert(cell);
  const root = mkdtempSync(join(tmpdir(), 'gate-lock-hash-'));
  const cwd = process.cwd();
  try {
    process.chdir(root);
    git('init', '--quiet');
    change('scripts/gates/cells.json', JSON.stringify({ cells: [cell], noCell: ['runtime-assets.lock.json'] }));
    change('workers/python/worker.js', 'export const python = 1;\n');
    change('workers/java/worker.js', 'export const java = 1;\n');
    change('runtime-assets.lock.json', '{"java":"original"}\n');
    const before = commit('original workers');

    change('workers/java/worker.js', 'export const java = 2;\n');
    change('runtime-assets.lock.json', '{"java":"regenerated"}\n');
    const after = commit('Java worker and its regenerated lock');
    assert.equal(hashCell(loadCell(before, cell.id), before), hashCell(loadCell(after, cell.id), after));
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('package scripts re-key callers and shared dependency fields re-key every cell', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-package-hash-'));
  const cwd = process.cwd();
  try {
    process.chdir(root);
    git('init', '--quiet');
    const cells = [
      { id: 'python', command: 'pnpm test:python', setup: 'pnpm prepare-python', inputs: [], pins: {} },
      { id: 'java', command: 'pnpm test:java', inputs: [], pins: {} },
    ];
    const manifest = {
      devDependencies: { tsx: '1.0.0' },
      scripts: {
        'test:python': 'pnpm run python-check',
        'python-check': "npm run 'python-leaf'",
        'python-leaf': 'node python-test.mjs',
        'prepare-python': 'node prepare.mjs',
        'test:java': 'node java-test.mjs',
      },
    };
    function keys(message) {
      change('package.json', JSON.stringify(manifest));
      const rev = commit(message);
      return cells.map((cell) => hashCell(cell, rev));
    }

    const baseline = keys('manifest baseline');
    manifest.scripts['test:unrelated'] = 'node unrelated-test.mjs';
    assert.deepEqual(keys('unrelated script'), baseline);

    manifest.scripts['python-leaf'] += ' --strict';
    const changed = keys('transitive test script');
    assert.notEqual(changed[0], baseline[0]);
    assert.equal(changed[1], baseline[1]);

    manifest.scripts['prepare-python'] += ' --check';
    const setup = keys('setup script');
    assert.notEqual(setup[0], changed[0]);
    assert.equal(setup[1], changed[1]);

    manifest.devDependencies.tsx = '2.0.0';
    const dependencies = keys('development dependency');
    dependencies.forEach((hash, index) => assert.notEqual(hash, setup[index]));

    manifest.browser = { zlib: './shim.js' };
    keys('browser metadata').forEach((hash, index) => assert.notEqual(hash, dependencies[index]));
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('only explicitly allowed host variables enter the pin environment', () => {
  const initial = { PATH: '/bin', JAVA_HOME: '/jdk', NODE_OPTIONS: '--require bad', TRACECODE_BYPASS: '1' };
  assert.deepEqual(allowedEnvironment(initial), { PATH: '/bin', JAVA_HOME: '/jdk' });
  assert.notDeepEqual(allowedEnvironment(initial), allowedEnvironment({ ...initial, JAVA_HOME: '/other-jdk' }));
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { missingEvidence } from '../scripts/stage1/leaf-ledger.mjs';
import { knownLeaves } from '../scripts/stage1/suite-floor.mjs';

test('a child that vanishes or returns after startup cannot qualify', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-floor-control-'));
  try {
    const source = new URL('../scripts/stage1/leaf-ledger.mjs', import.meta.url).href;
    const { id, assertions } = knownLeaves['tests/test-python-untraced-line-guard-browser.ts'];
    const execute = async (name, expression) => {
      const file = join(directory, name);
      const code = `import { leafLedger } from ${JSON.stringify(source)};
        import assert from 'node:assert/strict';
        const leaf = leafLedger(${JSON.stringify(id)});
        assert.equal(1, 1); leaf.checked('browser-worker');
        ${expression}
        leaf.done();`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, TRACECODE_SUITE_LEDGER: file, TRACECODE_SUITE_NONCE: name },
      });
      assert.equal(child.status, 0, child.stderr.toString());
      return (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    };
    const checks = "assert.equal(6, 6); leaf.checked('submit'); assert.equal(6, 6); leaf.checked('run');";
    assert.deepEqual(missingEvidence(id, assertions, await execute('healthy', checks)), []);
    assert.deepEqual(missingEvidence(id, assertions, await execute('short', '')), [
      `G7/suite/${id}/missing-assertion/submit`, `G7/suite/${id}/missing-assertion/run`,
    ]);
    assert.deepEqual(missingEvidence(id, assertions, []), [`G7/suite/${id}/missing-leaf`]);
    assert.deepEqual(missingEvidence(id, assertions, await execute('repaired', checks)), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

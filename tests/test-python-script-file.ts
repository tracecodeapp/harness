import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { withPythonScriptFile } from './fixtures/python-script-file';

test('passes a generated Python program larger than Linux MAX_ARG_STRLEN by file', () => {
  const script = '# ' + 'x'.repeat(132_000) + '\nprint("fixture-end-λ:" + input())\n';
  const options = { input: 'stdin-stays-available\n', encoding: 'utf8' } as const;
  if (process.platform === 'linux') {
    assert.equal((spawnSync('python3', ['-c', script], options).error as NodeJS.ErrnoException | undefined)?.code, 'E2BIG');
  }
  const result = withPythonScriptFile(script, (file) => spawnSync('python3', [file], options));
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'fixture-end-λ:stdin-stays-available\n');
});

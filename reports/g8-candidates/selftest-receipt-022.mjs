import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { production022 } from './plan-022.mjs';

const [operation, file, rigCommit, tarballSha256] = process.argv.slice(2);
assert.ok(file);
assert.match(rigCommit, /^[a-f0-9]{40}$/u);
assert.equal(tarballSha256, production022.sha256, 'Published 0.21.0 tarball digest differs');
const receipt = { schema: 'tracecode.speed-022.selftest.v1', pass: true, rigCommit, tarballSha256 };
if (operation === 'record') {
  await writeFile(file, JSON.stringify(receipt) + '\n', { flag: 'wx' });
} else {
  assert.equal(operation, 'require');
  const prior = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(prior, receipt, 'Self-test pass must match the rig commit and 0.21.0 tarball');
}

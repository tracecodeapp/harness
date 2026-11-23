import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAlgorithmJudgeBundle, createBrowserJudgeHost } from '@tracecode/harness/judge';
import * as tracekernel from '@tracecode/harness/tracekernel';

const output = process.argv[2];
const root = dirname(fileURLToPath(import.meta.resolve('@tracecode/harness/package.json')));
const parse = async (path) => JSON.parse(await readFile(path, 'utf8'));
const lock = await parse(join(root, 'runtime-assets.lock.json'));
const members = new Map((await parse(join(output, 'tar-members.json'))).map((member) => [member.path, member]));
assert.equal(typeof createAlgorithmJudgeBundle, 'function', 'G7/consumer/judge-bundle');
assert.equal(typeof createBrowserJudgeHost, 'function', 'G7/consumer/judge-host');
assert.ok(Object.keys(tracekernel).length > 0, 'G7/consumer/tracekernel');

async function measured(stream) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of stream) {
    size += bytes.byteLength;
    hash.update(bytes);
  }
  return { size, sha256: hash.digest('hex') };
}

function matchIdentity(actual, expected, id) {
  assert.ok(expected, id);
  assert.deepEqual(actual, { size: expected.size, sha256: expected.sha256 }, id);
}

for (const { path, type, ...identity } of members.values()) {
  if (type !== 'file') continue;
  matchIdentity(await measured(createReadStream(join(root, path.slice('package/'.length)))), identity, `G7/consumer/installed/${path}`);
}
const lockedFiles = new Map(Object.values(lock.components).flatMap(({ files }) => files).map((file) => [file.path, file]));
for (const [path, identity] of lockedFiles) {
  const member = members.get('package/' + path);
  assert.ok(member, `G7/pack/lock-path/${path}`);
  matchIdentity({ size: member.size, sha256: member.sha256 }, identity, `G7/pack/lock-bytes/${path}`);
}

const target = join(process.cwd(), 'workers');
const inventory = JSON.parse(execFileSync(process.execPath, [
  join(root, 'dist/cli.cjs'), 'sync-assets', target, '--inventory',
], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
assert.equal(inventory.matchesLock, true, 'G7/consumer/staged-totals');
assert.deepEqual(inventory.notStagedByHarness, [], 'G7/consumer/extra-assets');
const files = new Map(inventory.files.map((file) => [file.path, file]));
assert.equal(files.size, inventory.totals.files, 'G7/consumer/unique-assets');
const tracecc = lock.engineDependencies.tracecc;
const traceccFiles = tracecc.files.map((entry) => ({
  ...entry, path: `cpp/tracecc/${tracecc.consumerHash}/${entry.path}`,
}));
const jvm = lock.engineDependencies.tracejvm;
const enginePins = [...traceccFiles, {
  path: `java/${jvm.relativePrefix}/release.json`,
  size: jvm.descriptorSize, sha256: jvm.descriptorSha256,
}];
for (const file of enginePins) {
  const staged = files.get(file.path);
  assert.ok(staged, `G7/consumer/engine-path/${file.path}`);
  matchIdentity({ size: staged.size, sha256: staged.sha256 }, file, `G7/consumer/engine-bytes/${file.path}`);
}

const mediaTypes = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1));
  if (!files.has(path)) return response.writeHead(404).end();
  response.setHeader('Content-Type', mediaTypes[extname(path)] ?? 'application/octet-stream');
  createReadStream(join(target, path)).on('error', (error) => response.destroy(error)).pipe(response);
});
try {
  await new Promise((ready, fail) => server.listen(0, '127.0.0.1', ready).once('error', fail));
  const base = `http://127.0.0.1:${server.address().port}/`;
  for (const [path, file] of files) {
    const response = await fetch(new URL(path, base));
    assert.equal(response.status, 200, `G7/consumer/http/${path}`);
    const identity = await measured(response.body);
    matchIdentity(identity, file, `G7/consumer/served/${path}`);
    if (file.source) {
      matchIdentity(identity, members.get('package/' + file.source), `G7/consumer/tar-source/${path}`);
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
await writeFile(join(output, 'served-assets.json'), JSON.stringify(inventory, null, 2) + '\n');

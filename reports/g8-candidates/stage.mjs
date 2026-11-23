import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [input, expected, commit, output, frozenVersion = '0.20.1', manifestFile, lockFile] = process.argv.slice(2);
assert.ok(input && /^[0-9a-f]{64}$/.test(expected) && output && commit);
const sourceCommit = commit === 'none' ? undefined : commit;
const archive = resolve(input);
const outputDir = resolve(output);
const root = join(outputDir, 'package');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const run = (program, args, cwd) => execFileSync(program, args, { cwd, stdio: 'inherit' });
const provenance = manifestFile ? await json(resolve(manifestFile)) : null;
assert.equal(hash(await readFile(archive)), expected, archive);
if (provenance) {
  assert.equal(provenance.tarballSha256, expected);
  assert.equal(provenance.head, sourceCommit);
  assert.ok(lockFile);
}
await mkdir(outputDir);
run('tar', ['-xzf', archive, '-C', outputDir], outputDir);
const manifestPath = join(root, 'package.json');
const pkg = await json(manifestPath);
const frozenLock = await json(new URL('baseline/dependency-locks/' + frozenVersion + '.package-lock.json', import.meta.url));
const lock = lockFile ? await readFile(resolve(lockFile), 'utf8') : (() => {
  frozenLock.version = frozenLock.packages[''].version = pkg.version;
  return JSON.stringify(frozenLock, null, 2) + '\n';
})();
const installedLock = JSON.parse(lock);
assert.equal(pkg.name, installedLock.name);
assert.equal(pkg.version, installedLock.version);
assert.deepEqual(pkg.dependencies, installedLock.packages[''].dependencies, 'Package dependency declarations differ from its lock');
if (provenance) {
  assert.equal(provenance.version, pkg.version);
  assert.equal(provenance.dependencyLockSha256, hash(lock));
}
delete pkg.devDependencies;
await writeFile(manifestPath, JSON.stringify(pkg, null, 2) + '\n');
await writeFile(join(root, 'package-lock.json'), lock);
await copyFile(archive, join(outputDir, 'tracecode-harness-' + pkg.version + '.tgz'));
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], root);
const dependencies = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], { cwd: root });
const normalized = JSON.parse(dependencies);
normalized.version = frozenVersion;
const frozen = await json(new URL('baseline/dependency-locks/tree-sha256.json', import.meta.url));
assert.equal(hash(JSON.stringify(normalized, null, 2) + '\n'), frozen[frozenVersion], 'Installed dependency tree differs from baseline');
if (provenance) assert.equal(hash(dependencies), provenance.dependenciesSha256);
await writeFile(join(outputDir, 'dependencies.json'), dependencies);
run('node', ['dist/cli.cjs', 'sync-assets', '../site/workers', '--languages', 'python,javascript,java,cpp,csharp'], root);
const files = Object.fromEntries(await Promise.all([
  'package/dist/judge.js',
  'package/dist/tracekernel.js',
  'package/runtime-assets.lock.json',
  'site/workers/java-runtime-worker.js',
  'site/workers/java-worker.js',
  'site/workers/vendor/java-browser-helper.jar',
].map(async (name) => [name, hash(await readFile(join(outputDir, name)))])));
const receipt = { ...(sourceCommit && { commit: sourceCommit }), version: pkg.version,
  packageVersion: pkg.version, tarballSha256: expected,
  dependenciesSha256: hash(dependencies), dependencyLockSha256: hash(lock), files };
await writeFile(join(outputDir, 'candidate.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));

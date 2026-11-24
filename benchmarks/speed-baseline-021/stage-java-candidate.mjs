import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [tarballArg, tarballSha256, commit, outArg = 'reports/speed-baseline-021'] = process.argv.slice(2);
assert.ok(tarballArg && /^[a-f0-9]{64}$/.test(tarballSha256) && /^[a-f0-9]{40}$/.test(commit),
  'Usage: stage-java-candidate.mjs <packed tarball> <tarball SHA-256> <source commit> [output directory]');
const tarball = resolve(tarballArg);
const root = resolve(outArg, 'vcandidate');
const installed = join(root, 'package');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const run = (program, args, cwd = root) => execFileSync(program, args, { cwd, stdio: 'inherit' });

assert.equal(hash(await readFile(tarball)), tarballSha256);
await mkdir(resolve(outArg), { recursive: true });
await mkdir(root);
await copyFile(tarball, join(root, 'candidate.tgz'));
run('tar', ['-xzf', 'candidate.tgz']);
const manifestPath = join(installed, 'package.json');
const manifest = await readJson(manifestPath);
const lock = await readJson(new URL('./dependency-locks/0.20.1.package-lock.json', import.meta.url));
assert.equal(manifest.name, lock.name);
assert.deepEqual(manifest.dependencies, lock.packages[''].dependencies,
  'Candidate dependency declarations differ. Freeze and review a compatible candidate lock first.');
const version = manifest.version;
lock.version = lock.packages[''].version = version;
delete manifest.devDependencies;
const dependencyLock = JSON.stringify(lock, null, 2) + '\n';
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(installed, 'package-lock.json'), dependencyLock);
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], installed);
const dependencies = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], { cwd: installed });
const tree = JSON.parse(dependencies);
tree.version = '0.20.1';
const frozen = await readJson(new URL('./dependency-locks/tree-sha256.json', import.meta.url));
assert.equal(hash(JSON.stringify(tree, null, 2) + '\n'), frozen['0.20.1'],
  'Candidate installed tree differs from the frozen 0.20.1 tree');
await writeFile(join(root, 'dependencies.json'), dependencies);
run('node', ['dist/cli.cjs', 'sync-assets', '../site/workers', '--languages',
  'python,javascript,java,cpp,csharp'], installed);
const files = Object.fromEntries(await Promise.all([
  'package/dist/judge.js',
  'package/dist/tracekernel.js',
  'package/runtime-assets.lock.json',
  'site/workers/java-runtime-worker.js',
  'site/workers/java-worker.js',
  'site/workers/vendor/java-browser-helper.jar',
].map(async (name) => [name, hash(await readFile(join(root, name)))])));
await writeFile(join(root, 'candidate.json'), JSON.stringify({
  commit, version, tarballSha256, files,
  dependencyLockSha256: hash(dependencyLock),
  dependenciesSha256: hash(dependencies),
}, null, 2) + '\n');

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scripts, '../..');

function run(cwd, command, args, capture = false) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  })?.trim();
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

async function clean(tree, output, stage) {
  const status = run(tree, 'git', ['status', '--porcelain=v1', '--untracked-files=all'], true);
  const diff = run(tree, 'git', ['diff', 'HEAD', '--binary', '--no-ext-diff'], true);
  await writeFile(join(output, `${stage}.status`), status + '\n');
  if (status || diff) {
    await writeFile(join(output, `${stage}.diff`), diff + '\n');
    throw new Error(`G7/${stage}/tree-dirty\n${status}`);
  }
  run(tree, 'git', ['diff', 'HEAD', '--exit-code']);
}

export async function verifyTarball(tarball, expected) {
  const actual = await digest(tarball);
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
    throw new Error(`G7/pack/digest: expected ${expected}, observed ${actual}`);
  }
  return actual;
}

async function main([sha, destination, ...extra]) {
  if (sha === '--verify' && destination && extra.length === 1) {
    await verifyTarball(resolve(destination), extra[0]);
    return;
  }
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !destination || extra.length) {
    throw new Error('Usage: node scripts/stage1/clean-pack.mjs <full-commit-sha> <empty-external-output-dir>');
  }
  const outputPath = resolve(destination);
  const parent = await realpath(dirname(outputPath));
  const output = join(parent, relative(dirname(outputPath), outputPath));
  const repoPath = await realpath(repo);
  const fromRepo = relative(repoPath, output);
  if (!fromRepo || (!isAbsolute(fromRepo) && fromRepo !== '..' && !fromRepo.startsWith('..' + sep))) {
    throw new Error('Artifact directory must be outside the checkout');
  }
  await mkdir(output, { recursive: true });
  if ((await realpath(output)) !== output || (await readdir(output)).length) {
    throw new Error('Artifact directory must be an empty real directory');
  }
  const root = await mkdtemp(join(tmpdir(), 'harness-clean-pack-'));
  const tree = join(root, 'source');
  let added = false;
  try {
    run(repo, 'git', ['worktree', 'add', '--detach', tree, sha]);
    added = true;
    const head = run(tree, 'git', ['rev-parse', 'HEAD'], true);
    const node = process.version;
    const pnpm = run(tree, 'corepack', ['pnpm', '--version'], true);
    if (head !== sha || node !== 'v22.18.0' || pnpm !== '10.4.1') {
      throw new Error(`G7/preflight: observed ${head}, Node ${node}, pnpm ${pnpm}`);
    }
    const lockDigest = await digest(join(tree, 'pnpm-lock.yaml'));
    const environment = { head, node, pnpm, os: process.platform, arch: process.arch, lockDigest };
    await writeFile(join(output, 'environment.json'), JSON.stringify(environment, null, 2) + '\n');
    await clean(tree, output, 'checkout');
    const started = performance.now();
    run(tree, 'corepack', ['pnpm', 'install', '--frozen-lockfile']);
    console.log(`G7/install ${Math.round(performance.now() - started)} ms`);
    await clean(tree, output, 'install');
    let buildError;
    const building = performance.now();
    try {
      run(tree, 'corepack', ['pnpm', 'build']);
    } catch (error) {
      buildError = error;
    }
    console.log(`G7/build ${Math.round(performance.now() - building)} ms`);
    if (buildError) {
      // Preserve the tree as evidence. A failed build cannot qualify the dirty-tree control.
      await clean(tree, output, 'failed-build');
      throw buildError;
    }
    await clean(tree, output, 'build');
    for (const check of ['version:check', 'release:check', 'test:runtime-assets-lock']) {
      run(tree, 'corepack', ['pnpm', check]);
    }
    const packing = performance.now();
    run(tree, 'corepack', ['pnpm', 'pack', '--pack-destination', output]);
    await clean(tree, output, 'pack');
    const tarballs = (await readdir(output)).filter((name) => name.endsWith('.tgz'));
    if (tarballs.length !== 1) throw new Error('G7/pack/inventory: expected exactly one tarball');
    const [file] = tarballs;
    const tarball = join(output, file);
    const sha256 = await digest(tarball);
    const consumer = join(root, 'consumer');
    await writeFile(join(output, 'pack.json'), JSON.stringify({ ...environment, file, sha256 }, null, 2) + '\n');
    run(repo, 'python3', [join(scripts, 'tar-manifest.py'), tarball, join(output, 'tar-members.json')]);
    await verifyTarball(tarball, sha256);
    await mkdir(consumer);
    await copyFile(tarball, join(consumer, 'candidate.tgz'));
    const dependencyVersions = JSON.parse(run(tree, 'corepack', ['pnpm', 'list', '--prod', '--depth', '0', '--json'], true))[0].dependencies;
    const overrides = Object.fromEntries(Object.entries(dependencyVersions).map(([name, { version }]) => {
      if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error(`G7/pack/unpinned: ${name}@${version}`);
      return [name, version];
    }));
    const consumerManifest = JSON.stringify({
      private: true,
      packageManager: 'pnpm@10.4.1',
      dependencies: { '@tracecode/harness': 'file:./candidate.tgz' },
      pnpm: { overrides },
    }, null, 2) + '\n';
    await writeFile(join(consumer, 'package.json'), consumerManifest);
    await writeFile(join(output, 'consumer-package.json'), consumerManifest);
    run(consumer, 'corepack', ['pnpm', 'install', '--ignore-scripts', '--no-frozen-lockfile']);
    const consumerLock = await readFile(join(consumer, 'pnpm-lock.yaml'));
    await writeFile(join(output, 'consumer-lock.yaml'), consumerLock);
    run(consumer, 'corepack', ['pnpm', 'install', '--ignore-scripts', '--frozen-lockfile']);
    const moduleFile = join(consumer, 'verify.mjs');
    await writeFile(moduleFile, await readFile(join(scripts, 'verify-consumer.mjs')));
    run(consumer, 'node', [moduleFile, output]);
    await verifyTarball(tarball, sha256);
    await writeFile(join(output, 'qualified.sha256'), sha256 + '\n');
    console.log(`G7/pack qualified ${sha} ${sha256} in ${Math.round(performance.now() - packing)} ms`);
  } finally {
    if (added) run(repo, 'git', ['worktree', 'remove', '--force', tree]);
    await rm(root, { force: true, recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

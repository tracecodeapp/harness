#!/usr/bin/env node
// Publishes the packed, tested release tarball itself (docs/publishing.md,
// "Release process"). `pnpm publish .` repacks the directory with npm's packer
// and cannot publish the tested bytes; `npm publish <tarball>` runs no
// lifecycle scripts, so the guards `prepublishOnly` would run are run here.
//
//   node scripts/publish-release-tarball.mjs <tarball.tgz> <expected-sha256> [--dry-run]

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RELEASE_GUARDS = ['release:check', 'release:tag-check', 'test:runtime-assets-lock'];

function fail(message) {
  throw new Error(`Release tarball publish refused: ${message}`);
}

function usage() {
  fail('usage: node scripts/publish-release-tarball.mjs <tarball.tgz> <expected-sha256> [--dry-run]');
}

function readTarballEntry(tarball, entry) {
  const result = spawnSync('tar', ['-xzOf', tarball, entry], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`${entry} is missing from ${tarball}: ${String(result.stderr ?? '').trim()}`);
  }
  return result.stdout;
}

function runGuard(root, script, environment) {
  const result = spawnSync('pnpm', ['run', script], {
    cwd: root,
    env: environment,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    fail(`release guard "${script}" failed (exit ${result.status ?? result.signal})`);
  }
}

export async function publishReleaseTarball({
  root = process.cwd(),
  tarball,
  expectedSha256,
  dryRun = false,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  environment = process.env,
  log = (line) => console.log(line),
}) {
  if (typeof tarball !== 'string' || tarball.length === 0) usage();
  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(expectedSha256)) {
    fail('the expected sha256 must be 64 lowercase hex characters');
  }
  const tarballPath = resolve(root, tarball);
  let bytes;
  try {
    bytes = await readFile(tarballPath);
  } catch (error) {
    fail(`cannot read ${tarballPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 1. The file is the tested candidate.
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedSha256) {
    fail(`${tarballPath} has sha256 ${sha256}, not the tested ${expectedSha256}`);
  }

  // 2. It is this checkout's release: same package, same version, same
  //    runtime release (the lock names the immutable runtime release ID).
  const rootManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const tarballManifest = JSON.parse(readTarballEntry(tarballPath, 'package/package.json').toString('utf8'));
  if (tarballManifest.name !== rootManifest.name) {
    fail(`the tarball is ${tarballManifest.name}, this checkout releases ${rootManifest.name}`);
  }
  if (tarballManifest.version !== rootManifest.version) {
    fail(`the tarball is version ${tarballManifest.version}, this checkout is ${rootManifest.version}`);
  }
  const checkoutLock = await readFile(resolve(root, 'runtime-assets.lock.json'));
  const tarballLock = readTarballEntry(tarballPath, 'package/runtime-assets.lock.json');
  if (!checkoutLock.equals(tarballLock)) {
    fail("the tarball's runtime-assets.lock.json differs from this checkout's");
  }

  // 3. The guards `prepublishOnly` runs for a directory publish.
  for (const script of RELEASE_GUARDS) runGuard(root, script, environment);

  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const shasum = createHash('sha1').update(bytes).digest('hex');
  const publishArgs = ['publish', tarballPath, '--access', 'public', '--auth-type=web'];
  const verify = [
    `Verify: npm view ${rootManifest.name}@${rootManifest.version} dist.integrity dist.shasum`,
    `  expected integrity ${integrity}`,
    `  expected shasum    ${shasum}`,
  ];

  if (dryRun) {
    log(`Dry run: would run npm ${publishArgs.join(' ')}`);
    for (const line of verify) log(line);
    return { published: false, sha256, integrity, shasum };
  }

  // 4. npm's web second factor fails with EOTP when output is redirected.
  if (!interactive) {
    fail('run this in an interactive terminal (npm --auth-type=web fails with EOTP when output is redirected)');
  }
  const published = spawnSync('npm', publishArgs, { cwd: root, env: environment, stdio: 'inherit' });
  if (published.status !== 0) {
    fail(`npm publish failed (exit ${published.status ?? published.signal})`);
  }
  for (const line of verify) log(line);
  return { published: true, sha256, integrity, shasum };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const [tarball, expectedSha256] = args.filter((argument) => argument !== '--dry-run');
  publishReleaseTarball({ tarball, expectedSha256, dryRun }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

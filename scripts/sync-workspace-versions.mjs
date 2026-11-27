#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolvePackDevDependencies } from './pack-manifest.mjs';

const ROOT = process.cwd();
const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

async function readManifest(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function parseArguments(argv) {
  const check = argv.includes('--check');
  const positional = argv.filter((argument) => argument !== '--check');
  if (positional.length > 1) {
    throw new Error(
      'usage: node scripts/sync-workspace-versions.mjs [--check] [version]'
    );
  }
  if (check && positional.length > 0) {
    throw new Error('--check reads the root version and does not accept a version');
  }
  return { check, requestedVersion: positional[0] };
}

async function packageManifestPaths(root) {
  const packagesRoot = join(root, 'packages');
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesRoot, entry.name, 'package.json'))
    .sort();
  const manifests = [];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      manifests.push(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return manifests;
}

async function main() {
  const { check, requestedVersion } = parseArguments(process.argv.slice(2));
  const rootManifestPath = join(ROOT, 'package.json');
  const rootManifest = await readManifest(rootManifestPath);
  const version = requestedVersion ?? rootManifest.version;
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    throw new Error(`invalid Harness release version: ${JSON.stringify(version)}`);
  }

  const mismatches = [];
  let synchronized = 0;
  for (const manifestPath of await packageManifestPaths(ROOT)) {
    const manifest = await readManifest(manifestPath);
    if (manifest.private !== true) {
      throw new Error(
        `${manifestPath} must remain private before its version can be synchronized`
      );
    }
    if (manifest.version === version) continue;
    if (check) {
      mismatches.push(
        `${manifest.name ?? manifestPath}: ${String(manifest.version)}`
      );
      continue;
    }
    manifest.version = version;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    synchronized += 1;
  }

  const devDependencies = rootManifest.devDependencies;
  const resolvedDevDependencies = devDependencies && resolvePackDevDependencies(devDependencies, version);
  const hasPackRanges = Object.values(devDependencies ?? {}).some((specifier) => specifier.startsWith('workspace:^'));
  const packRangesChanged = hasPackRanges && (
    JSON.stringify(devDependencies) !== JSON.stringify(resolvedDevDependencies)
  );
  if (check && packRangesChanged) {
    mismatches.push('package.json: run pnpm version:sync to synchronize and order the root workspace devDependencies');
  }

  if (mismatches.length > 0) {
    throw new Error(
      `workspace package versions must match @tracecode/harness ${version}:\n` +
        mismatches.map((mismatch) => `- ${mismatch}`).join('\n')
    );
  }

  if (!check && (rootManifest.version !== version || packRangesChanged)) {
    rootManifest.version = version;
    if (hasPackRanges) rootManifest.devDependencies = resolvedDevDependencies;
    await writeFile(rootManifestPath, `${JSON.stringify(rootManifest, null, 2)}\n`, 'utf8');
  }

  if (!check && hasPackRanges) {
    // Use pnpm to update the importer specifiers, also on retry after a failed sync.
    execFileSync('pnpm', ['install', '--lockfile-only', '--prefer-offline', '--ignore-scripts', '--no-frozen-lockfile'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }

  console.log(
    check
      ? `PASS: every private package manifest matches @tracecode/harness ${version}.`
      : `Synchronized ${synchronized} private package manifests to @tracecode/harness ${version}.`
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

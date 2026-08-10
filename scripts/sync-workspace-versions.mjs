#!/usr/bin/env node

import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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

  if (requestedVersion && rootManifest.version !== version) {
    rootManifest.version = version;
    await writeFile(
      rootManifestPath,
      `${JSON.stringify(rootManifest, null, 2)}\n`,
      'utf8'
    );
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

  if (mismatches.length > 0) {
    throw new Error(
      `workspace package versions must match @tracecode/harness ${version}:\n` +
        mismatches.map((mismatch) => `- ${mismatch}`).join('\n')
    );
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

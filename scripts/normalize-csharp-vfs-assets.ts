#!/usr/bin/env npx tsx

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDotnetBootManifest,
  updateResourceHash,
  type BootAsset,
} from './pack-csharp-managed-assemblies.js';

interface NormalizeCSharpVfsAssetsResult {
  bundleDirectory: string;
  files: number;
  renamed: number;
}

function sha256Base64(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('base64');
}

function requireReferencePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/tracecode-refs/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    basename(value) !== value.slice('/tracecode-refs/'.length) ||
    !value.endsWith('.dll')
  ) {
    throw new Error(`${label} must be a direct /tracecode-refs DLL path.`);
  }
  return value;
}

function requireSupportName(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^supportFiles\/(?:\d+_)?[^/\\]+\.dll$/.test(value)
  ) {
    throw new Error(`${label} must be a supportFiles DLL path.`);
  }
  return value;
}

export async function normalizeCSharpVfsAssets(
  bundleDirectory: string
): Promise<NormalizeCSharpVfsAssetsResult> {
  const resolvedBundleDirectory = resolve(bundleDirectory);
  const frameworkDirectory = join(resolvedBundleDirectory, '_framework');
  const bootPath = join(frameworkDirectory, 'dotnet.boot.js');
  const parsed = parseDotnetBootManifest(
    await readFile(bootPath, 'utf8'),
    bootPath
  );
  const resources = parsed.config.resources;
  if (
    !resources ||
    !Array.isArray(resources.vfs) ||
    resources.vfs.length === 0
  ) {
    throw new Error(
      `C# host boot manifest is missing VFS references at ${bootPath}.`
    );
  }

  const desiredNames = new Set<string>();
  let renamed = 0;
  for (const [index, asset] of (resources.vfs as BootAsset[]).entries()) {
    const virtualPath = requireReferencePath(
      asset.virtualPath,
      `C# VFS asset ${index} virtualPath`
    );
    const currentName = requireSupportName(
      asset.name,
      `C# VFS asset ${index} name`
    );
    const desiredName = `supportFiles/${basename(virtualPath)}`;
    if (desiredNames.has(desiredName)) {
      throw new Error(`Duplicate normalized C# VFS asset: ${desiredName}.`);
    }
    desiredNames.add(desiredName);

    const sourcePath = join(frameworkDirectory, ...currentName.split('/'));
    const contents = await readFile(sourcePath);
    if (asset.hash !== `sha256-${sha256Base64(contents)}`) {
      throw new Error(
        `C# VFS asset integrity failed before normalization: ${currentName}.`
      );
    }
    if (currentName !== desiredName) {
      await rename(
        sourcePath,
        join(frameworkDirectory, ...desiredName.split('/'))
      );
      asset.name = desiredName;
      renamed += 1;
    }
  }

  if (renamed > 0) {
    updateResourceHash(resources);
    await writeFile(
      bootPath,
      `${parsed.prefix}${JSON.stringify(parsed.config, null, 2)}${parsed.suffix}`
    );
  }
  return {
    bundleDirectory: resolvedBundleDirectory,
    files: resources.vfs.length,
    renamed,
  };
}

async function main(): Promise<void> {
  const directories = process.argv.slice(2);
  if (directories.length === 0) {
    throw new Error(
      'Usage: normalize-csharp-vfs-assets.ts <bundle-directory> [...]'
    );
  }
  for (const directory of directories) {
    console.log(JSON.stringify(await normalizeCSharpVfsAssets(directory)));
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

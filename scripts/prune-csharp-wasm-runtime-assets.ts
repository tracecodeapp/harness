#!/usr/bin/env npx tsx

import { createHash } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const vendorDir = resolve(process.argv[2] ?? join(ROOT, 'workers', 'vendor', 'csharp'));
const frameworkDir = join(vendorDir, '_framework');
const bootPath = join(frameworkDir, 'dotnet.boot.js');

interface BootConfig {
  resources?: Record<string, unknown>;
}

interface BootAsset {
  name?: unknown;
  virtualPath?: unknown;
}

function normalizedAssetBaseName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const baseName = value.split('/').at(-1) ?? value;
  return baseName.replace(/^[0-9]+_/, '');
}

function isPrunedRuntimeAssetName(name: string): boolean {
  return /^System\.Net(?:\.|$)/i.test(name);
}

function isPrunedReferenceAssetName(name: string): boolean {
  return isPrunedRuntimeAssetName(name) ||
    /^System\.Reflection\.Emit(?:\.|$)/i.test(name) ||
    /^System\.Runtime\.InteropServices\.JavaScript\.dll$/i.test(name);
}

function shouldPruneAsset(asset: BootAsset): boolean {
  const names = [
    normalizedAssetBaseName(asset.name),
    normalizedAssetBaseName(asset.virtualPath),
  ].filter(Boolean);
  return names.some((name) => {
    if (name.endsWith('.dll')) return isPrunedReferenceAssetName(name);
    if (name.endsWith('.wasm')) return isPrunedRuntimeAssetName(name);
    return false;
  });
}

function pruneResources(value: unknown, removed: Set<string>): unknown {
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (const item of value) {
      if (item && typeof item === 'object' && shouldPruneAsset(item as BootAsset)) {
        const asset = item as BootAsset;
        for (const path of [asset.name, asset.virtualPath]) {
          if (typeof path === 'string') removed.add(path);
        }
        continue;
      }
      kept.push(pruneResources(item, removed));
    }
    return kept;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, child]) => [key, pruneResources(child, removed)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

async function removeMatchingFiles(directory: string, removed: Set<string>): Promise<void> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await removeMatchingFiles(path, removed);
      continue;
    }
    const baseName = normalizedAssetBaseName(entry.name);
    const shouldRemove = entry.name.endsWith('.dll')
      ? isPrunedReferenceAssetName(baseName)
      : entry.name.endsWith('.wasm') && isPrunedRuntimeAssetName(baseName);
    if (!shouldRemove) continue;
    removed.add(path);
    await rm(path, { force: true });
  }
}

function updateResourceHash(resources: Record<string, unknown>): void {
  const hashInput = JSON.stringify({
    ...resources,
    hash: undefined,
  });
  resources.hash = `sha256-${createHash('sha256').update(hashInput).digest('base64')}`;
}

async function main(): Promise<void> {
  const source = await readFile(bootPath, 'utf8');
  const match = source.match(/^(?<prefix>export const config = \/\*json-start\*\/)(?<json>[\s\S]*?)(?<suffix>\/\*json-end\*\/;)$/);
  if (!match?.groups) {
    throw new Error(`Unable to parse C# dotnet boot manifest at ${bootPath}`);
  }

  const config = JSON.parse(match.groups.json) as BootConfig;
  if (!config.resources || typeof config.resources !== 'object') {
    throw new Error(`C# dotnet boot manifest is missing resources at ${bootPath}`);
  }

  const removed = new Set<string>();
  config.resources = pruneResources(config.resources, removed) as Record<string, unknown>;
  updateResourceHash(config.resources);
  await writeFile(bootPath, `${match.groups.prefix}${JSON.stringify(config, null, 2)}${match.groups.suffix}`, 'utf8');
  await removeMatchingFiles(frameworkDir, removed);

  if (removed.size > 0) {
    console.log(`Pruned ${removed.size} C# browser runtime asset references`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

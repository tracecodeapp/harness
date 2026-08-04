#!/usr/bin/env npx tsx

import { createHash } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CSHARP_ASSEMBLY_PACKS_SCHEMA =
  'tracecode.csharp-assembly-packs.v1';
export const CSHARP_ASSEMBLY_PACK_SCHEMA =
  'tracecode.csharp-assembly-pack.v1';
export const CSHARP_ASSEMBLY_PACK_MAGIC = Buffer.from('TCPACK01', 'ascii');
export const CSHARP_RUNNER_ASSEMBLY_PACK_COUNT = 3;

const MAX_PACK_COUNT = 16;
const PACK_INDEX_LENGTH_BYTES = 4;
const PACK_TRAILER_BYTES =
  PACK_INDEX_LENGTH_BYTES + CSHARP_ASSEMBLY_PACK_MAGIC.byteLength;

export interface BootAsset {
  name?: unknown;
  virtualPath?: unknown;
  hash?: unknown;
}

export interface AssemblyPackEntry {
  virtualPath: string;
  offset: number;
  length: number;
  sha256: string;
}

export interface AssemblyPackIndex {
  schema: typeof CSHARP_ASSEMBLY_PACK_SCHEMA;
  entries: Record<string, AssemblyPackEntry>;
}

export interface AssemblyPackMetadata {
  name: string;
  hash: string;
  bytes: number;
  assemblyCount: number;
  assemblies: string[];
}

export interface AssemblyPacksExtension {
  schema: typeof CSHARP_ASSEMBLY_PACKS_SCHEMA;
  assemblyCount: number;
  packs: AssemblyPackMetadata[];
}

export interface BootConfig {
  mainAssemblyName?: unknown;
  resources?: {
    hash?: unknown;
    assembly?: BootAsset[];
    coreAssembly?: BootAsset[];
    extensions?: Record<string, unknown> & {
      tracecodeAssemblyPacks?: unknown;
    };
    [key: string]: unknown;
  };
}

interface ParsedBootManifest {
  config: BootConfig;
  prefix: string;
  suffix: string;
}

interface LoadedAssembly {
  manifestIndex: number;
  name: string;
  virtualPath: string;
  contents: Buffer;
}

interface AssemblyGroup {
  index: number;
  bytes: number;
  assets: LoadedAssembly[];
}

export interface ParsedAssemblyPack {
  index: AssemblyPackIndex;
  indexOffset: number;
  indexBytes: number;
}

export interface PackCSharpManagedAssembliesResult {
  runnerDirectory: string;
  assemblyCount: number;
  packs: Array<
    AssemblyPackMetadata & {
      indexBytes: number;
      sha256: string;
    }
  >;
}

function sha256Base64(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('base64');
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function parseDotnetBootManifest(
  source: string,
  bootPath: string
): ParsedBootManifest {
  const match = source.match(
    /^(?<prefix>export const config = \/\*json-start\*\/)(?<json>[\s\S]*?)(?<suffix>\/\*json-end\*\/;)$/
  );
  if (!match?.groups) {
    throw new Error(`Unable to parse .NET boot manifest at ${bootPath}`);
  }
  return {
    config: JSON.parse(match.groups.json) as BootConfig,
    prefix: match.groups.prefix,
    suffix: match.groups.suffix,
  };
}

export function managedAssemblyAssets(config: BootConfig): BootAsset[] {
  return [
    ...(config.resources?.coreAssembly ?? []),
    ...(config.resources?.assembly ?? []),
  ];
}

function requireSafeAssetName(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== basename(value) ||
    value.includes('\\') ||
    !value.endsWith('.wasm') ||
    value === '.' ||
    value === '..'
  ) {
    throw new Error(`${label} must be a non-empty framework-local filename.`);
  }
  return value;
}

function requireVirtualPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').includes('..')
  ) {
    throw new Error(`${label} must be a safe relative virtual path.`);
  }
  return value;
}

function selectLightestGroup(groups: AssemblyGroup[]): AssemblyGroup {
  return groups.reduce((selected, candidate) =>
    candidate.bytes < selected.bytes ||
    (candidate.bytes === selected.bytes && candidate.index < selected.index)
      ? candidate
      : selected
  );
}

function buildPack(group: AssemblyGroup): {
  bytes: Buffer;
  index: AssemblyPackIndex;
  indexBytes: number;
} {
  const entries: Record<string, AssemblyPackEntry> = {};
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const asset of group.assets) {
    entries[asset.name] = {
      virtualPath: asset.virtualPath,
      offset,
      length: asset.contents.byteLength,
      sha256: sha256Hex(asset.contents),
    };
    chunks.push(asset.contents);
    offset += asset.contents.byteLength;
  }
  const index: AssemblyPackIndex = {
    schema: CSHARP_ASSEMBLY_PACK_SCHEMA,
    entries,
  };
  const encodedIndex = Buffer.from(JSON.stringify(index), 'utf8');
  const encodedIndexLength = Buffer.alloc(PACK_INDEX_LENGTH_BYTES);
  encodedIndexLength.writeUInt32LE(encodedIndex.byteLength);
  return {
    bytes: Buffer.concat([
      ...chunks,
      encodedIndex,
      encodedIndexLength,
      CSHARP_ASSEMBLY_PACK_MAGIC,
    ]),
    index,
    indexBytes: encodedIndex.byteLength,
  };
}

export function parseCSharpAssemblyPack(
  bytes: Buffer,
  label: string
): ParsedAssemblyPack {
  if (bytes.byteLength <= PACK_TRAILER_BYTES) {
    throw new Error(`${label} is too small to be a C# assembly pack.`);
  }
  const magicOffset =
    bytes.byteLength - CSHARP_ASSEMBLY_PACK_MAGIC.byteLength;
  if (
    !bytes
      .subarray(magicOffset)
      .equals(CSHARP_ASSEMBLY_PACK_MAGIC)
  ) {
    throw new Error(`${label} has an invalid C# assembly pack magic.`);
  }
  const indexLengthOffset = magicOffset - PACK_INDEX_LENGTH_BYTES;
  const indexBytes = bytes.readUInt32LE(indexLengthOffset);
  const indexOffset = indexLengthOffset - indexBytes;
  if (indexBytes <= 0 || indexOffset < 0) {
    throw new Error(`${label} has an out-of-bounds C# assembly pack index.`);
  }
  let index: unknown;
  try {
    index = JSON.parse(
      bytes.subarray(indexOffset, indexLengthOffset).toString('utf8')
    );
  } catch (error) {
    throw new Error(`${label} has an unreadable C# assembly pack index.`, {
      cause: error,
    });
  }
  if (
    !index ||
    typeof index !== 'object' ||
    (index as { schema?: unknown }).schema !== CSHARP_ASSEMBLY_PACK_SCHEMA ||
    !(index as { entries?: unknown }).entries ||
    typeof (index as { entries?: unknown }).entries !== 'object' ||
    Array.isArray((index as { entries?: unknown }).entries)
  ) {
    throw new Error(`${label} has an invalid C# assembly pack index.`);
  }
  return {
    index: index as AssemblyPackIndex,
    indexOffset,
    indexBytes,
  };
}

function updateResourceHash(resources: NonNullable<BootConfig['resources']>): void {
  resources.hash = `sha256-${sha256Base64(
    JSON.stringify({ ...resources, hash: undefined })
  )}`;
}

async function writeAtomically(path: string, contents: Buffer | string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, contents);
  await rename(temporaryPath, path);
}

export async function packCSharpManagedAssemblies(
  runnerDirectory: string,
  packCount = CSHARP_RUNNER_ASSEMBLY_PACK_COUNT
): Promise<PackCSharpManagedAssembliesResult> {
  if (
    !Number.isSafeInteger(packCount) ||
    packCount < 1 ||
    packCount > MAX_PACK_COUNT
  ) {
    throw new Error(`C# assembly pack count must be between 1 and ${MAX_PACK_COUNT}.`);
  }

  const resolvedRunnerDirectory = resolve(runnerDirectory);
  const frameworkDirectory = join(resolvedRunnerDirectory, '_framework');
  const bootPath = join(frameworkDirectory, 'dotnet.boot.js');
  const parsedBoot = parseDotnetBootManifest(
    await readFile(bootPath, 'utf8'),
    bootPath
  );
  const resources = parsedBoot.config.resources;
  if (!resources) {
    throw new Error(`C# runner boot manifest is missing resources at ${bootPath}.`);
  }
  if (resources.extensions?.tracecodeAssemblyPacks) {
    throw new Error(`C# runner is already assembly-packed at ${bootPath}.`);
  }

  const assemblyAssets = managedAssemblyAssets(parsedBoot.config);
  if (assemblyAssets.length === 0) {
    throw new Error('C# runner boot manifest does not contain managed assemblies.');
  }
  if (packCount > assemblyAssets.length) {
    throw new Error('C# assembly pack count exceeds the managed assembly count.');
  }

  const seenNames = new Set<string>();
  const loadedAssets: LoadedAssembly[] = [];
  for (const [manifestIndex, asset] of assemblyAssets.entries()) {
    const name = requireSafeAssetName(
      asset.name,
      `Managed assembly ${manifestIndex} name`
    );
    const virtualPath = requireVirtualPath(
      asset.virtualPath ?? name,
      `Managed assembly ${name} virtualPath`
    );
    if (seenNames.has(name)) {
      throw new Error(`Duplicate C# managed assembly asset: ${name}.`);
    }
    seenNames.add(name);
    const contents = await readFile(join(frameworkDirectory, name));
    const actualIntegrity = `sha256-${sha256Base64(contents)}`;
    if (asset.hash !== actualIntegrity) {
      throw new Error(
        `C# managed assembly integrity failed before packing: ${name}.`
      );
    }
    loadedAssets.push({
      manifestIndex,
      name,
      virtualPath,
      contents,
    });
  }

  // Longest-processing-time partitioning gives browsers three balanced
  // parallel transfers. Original manifest order within each pack keeps the
  // output deterministic across filesystems and Node versions.
  const groups: AssemblyGroup[] = Array.from(
    { length: packCount },
    (_, index) => ({ index, bytes: 0, assets: [] })
  );
  const largestFirst = [...loadedAssets].sort(
    (left, right) =>
      right.contents.byteLength - left.contents.byteLength ||
      left.manifestIndex - right.manifestIndex
  );
  for (const asset of largestFirst) {
    const group = selectLightestGroup(groups);
    group.assets.push(asset);
    group.bytes += asset.contents.byteLength;
  }
  for (const group of groups) {
    group.assets.sort(
      (left, right) => left.manifestIndex - right.manifestIndex
    );
  }

  const packFiles: Array<{ name: string; bytes: Buffer }> = [];
  const packs: PackCSharpManagedAssembliesResult['packs'] = [];
  for (const group of groups) {
    const built = buildPack(group);
    const parsed = parseCSharpAssemblyPack(
      built.bytes,
      `generated C# assembly pack ${group.index + 1}`
    );
    if (
      parsed.indexBytes !== built.indexBytes ||
      JSON.stringify(parsed.index) !== JSON.stringify(built.index)
    ) {
      throw new Error('Generated C# assembly pack failed its round-trip check.');
    }
    const name =
      packCount === 1
        ? 'assemblies.pack'
        : `assemblies-${String(group.index + 1).padStart(2, '0')}.pack`;
    const hashBase64 = sha256Base64(built.bytes);
    packFiles.push({ name, bytes: built.bytes });
    packs.push({
      name,
      hash: `sha256-${hashBase64}`,
      bytes: built.bytes.byteLength,
      assemblyCount: group.assets.length,
      assemblies: group.assets.map((asset) => asset.name),
      indexBytes: built.indexBytes,
      sha256: Buffer.from(hashBase64, 'base64').toString('hex'),
    });
  }

  resources.extensions = {
    ...(resources.extensions ?? {}),
    tracecodeAssemblyPacks: {
      schema: CSHARP_ASSEMBLY_PACKS_SCHEMA,
      assemblyCount: loadedAssets.length,
      packs: packs.map(
        ({ indexBytes: _indexBytes, sha256: _sha256, ...metadata }) => metadata
      ),
    } satisfies AssemblyPacksExtension,
  };
  updateResourceHash(resources);
  const nextBootSource =
    `${parsedBoot.prefix}${JSON.stringify(parsedBoot.config, null, 2)}` +
    parsedBoot.suffix;

  for (const pack of packFiles) {
    await writeAtomically(join(frameworkDirectory, pack.name), pack.bytes);
  }
  await writeAtomically(bootPath, nextBootSource);

  for (const asset of loadedAssets) {
    await rm(join(frameworkDirectory, asset.name));
  }
  // Release source maps are not requested at debugLevel 0 and cost download
  // and package bytes without helping learner diagnostics.
  for (const optionalName of ['dotnet.js.map', 'dotnet.runtime.js.map']) {
    await rm(join(frameworkDirectory, optionalName), { force: true });
  }

  return {
    runnerDirectory: resolvedRunnerDirectory,
    assemblyCount: loadedAssets.length,
    packs,
  };
}

async function main(): Promise<void> {
  const runnerDirectory = process.argv[2];
  const packCount = Number(
    process.argv[3] ?? CSHARP_RUNNER_ASSEMBLY_PACK_COUNT
  );
  if (!runnerDirectory) {
    throw new Error(
      'Usage: pack-csharp-managed-assemblies.ts <runner-directory> [pack-count]'
    );
  }
  console.log(
    JSON.stringify(
      await packCSharpManagedAssemblies(runnerDirectory, packCount),
      null,
      2
    )
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

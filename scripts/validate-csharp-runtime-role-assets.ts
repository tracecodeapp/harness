#!/usr/bin/env npx tsx

import { createHash } from 'node:crypto';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  CSHARP_ASSEMBLY_PACKS_SCHEMA,
  CSHARP_RUNNER_ASSEMBLY_PACK_COUNT,
  parseCSharpAssemblyPack,
  type AssemblyPackMetadata,
  type AssemblyPacksExtension,
} from './pack-csharp-managed-assemblies.js';
import { materializeCSharpRoleAssets } from './csharp-role-artifacts.js';

interface BootAsset {
  name?: unknown;
  virtualPath?: unknown;
}

interface BootConfig {
  mainAssemblyName?: unknown;
  resources?: {
    assembly?: BootAsset[];
    coreAssembly?: BootAsset[];
    vfs?: BootAsset[];
    [key: string]: unknown;
  };
}

interface BundleStats {
  files: number;
  rawBytes: number;
  brotliBytes: number;
}

const GENERAL_MAX_RAW_BYTES = 55 * 1024 * 1024;
const COMPILER_MAX_RAW_BYTES = 55 * 1024 * 1024;
const RUNNER_MAX_RAW_BYTES = 16 * 1024 * 1024;
const RUNNER_MAX_BROTLI_BYTES = 6 * 1024 * 1024;

interface TraceClrAlgorithmProfile {
  schema?: unknown;
  runnerRootAssemblies?: unknown;
}

async function readRunnerRequiredJudgeAssemblies(): Promise<string[]> {
  const profilePath = resolve(
    'packages/runtime-csharp/traceclr-algorithm-profile.json'
  );
  const profile = JSON.parse(
    await readFile(profilePath, 'utf8')
  ) as TraceClrAlgorithmProfile;
  if (
    profile.schema !== 'tracecode.traceclr-algorithm-profile.v1' ||
    !Array.isArray(profile.runnerRootAssemblies) ||
    profile.runnerRootAssemblies.length === 0 ||
    !profile.runnerRootAssemblies.every(
      (assembly): assembly is string =>
        typeof assembly === 'string' && assembly.length > 0
    )
  ) {
    throw new Error(
      `Invalid generated TraceCLR algorithm profile at ${profilePath}.`
    );
  }
  return profile.runnerRootAssemblies;
}

function sha256Base64(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('base64');
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function managedAssemblyAssets(config: BootConfig): BootAsset[] {
  return [
    ...(config.resources?.coreAssembly ?? []),
    ...(config.resources?.assembly ?? []),
  ];
}

function requireAssemblyPacksExtension(config: BootConfig): AssemblyPacksExtension {
  const extensions = config.resources?.extensions;
  const extension =
    extensions &&
    typeof extensions === 'object' &&
    !Array.isArray(extensions)
      ? (extensions as { tracecodeAssemblyPacks?: unknown })
          .tracecodeAssemblyPacks
      : undefined;
  if (
    !extension ||
    typeof extension !== 'object' ||
    (extension as { schema?: unknown }).schema !== CSHARP_ASSEMBLY_PACKS_SCHEMA ||
    !Array.isArray((extension as { packs?: unknown }).packs)
  ) {
    throw new Error(
      'Disposable C# runner is missing its managed-assembly pack manifest.'
    );
  }
  return extension as AssemblyPacksExtension;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function validateRunnerAssemblyPacks(
  runnerDirectory: string,
  config: BootConfig
): Promise<void> {
  const frameworkDirectory = join(runnerDirectory, '_framework');
  const assemblyAssets = managedAssemblyAssets(config);
  const expectedVirtualPaths = new Map<string, string>();
  for (const asset of assemblyAssets) {
    if (
      typeof asset.name !== 'string' ||
      typeof (asset.virtualPath ?? asset.name) !== 'string' ||
      expectedVirtualPaths.has(asset.name)
    ) {
      throw new Error('C# runner boot manifest has invalid assembly metadata.');
    }
    expectedVirtualPaths.set(
      asset.name,
      (asset.virtualPath ?? asset.name) as string
    );
    if (await fileExists(join(frameworkDirectory, asset.name))) {
      throw new Error(
        `Packed C# runner still ships loose managed assembly ${asset.name}.`
      );
    }
  }

  const extension = requireAssemblyPacksExtension(config);
  if (
    extension.assemblyCount !== assemblyAssets.length ||
    extension.packs.length !== CSHARP_RUNNER_ASSEMBLY_PACK_COUNT
  ) {
    throw new Error(
      `C# runner must contain exactly ${CSHARP_RUNNER_ASSEMBLY_PACK_COUNT} packs covering all ${assemblyAssets.length} assemblies.`
    );
  }

  const seenPackNames = new Set<string>();
  const seenAssemblyNames = new Set<string>();
  for (const metadata of extension.packs as AssemblyPackMetadata[]) {
    if (
      typeof metadata?.name !== 'string' ||
      metadata.name !== metadata.name.split('/').at(-1) ||
      metadata.name.includes('\\') ||
      !metadata.name.endsWith('.pack') ||
      seenPackNames.has(metadata.name) ||
      typeof metadata.hash !== 'string' ||
      !/^sha256-[A-Za-z0-9+/]{43}=$/.test(metadata.hash) ||
      !Number.isSafeInteger(metadata.bytes) ||
      metadata.bytes <= 12 ||
      !Number.isSafeInteger(metadata.assemblyCount) ||
      metadata.assemblyCount < 1 ||
      !Array.isArray(metadata.assemblies) ||
      metadata.assemblyCount !== metadata.assemblies.length
    ) {
      throw new Error('C# runner has invalid assembly-pack metadata.');
    }
    seenPackNames.add(metadata.name);
    const packPath = join(frameworkDirectory, metadata.name);
    const packBytes = await readFile(packPath);
    if (
      packBytes.byteLength !== metadata.bytes ||
      `sha256-${sha256Base64(packBytes)}` !== metadata.hash
    ) {
      throw new Error(`C# runner assembly pack integrity failed: ${metadata.name}.`);
    }
    const parsed = parseCSharpAssemblyPack(packBytes, packPath);
    const entries = Object.entries(parsed.index.entries);
    if (entries.length !== metadata.assemblyCount) {
      throw new Error(
        `C# runner assembly pack index count differs from ${metadata.name}.`
      );
    }
    const ranges: Array<[number, number]> = [];
    for (const [name, entry] of entries) {
      if (
        !metadata.assemblies.includes(name) ||
        !expectedVirtualPaths.has(name) ||
        seenAssemblyNames.has(name) ||
        entry.virtualPath !== expectedVirtualPaths.get(name) ||
        !Number.isSafeInteger(entry.offset) ||
        !Number.isSafeInteger(entry.length) ||
        entry.offset < 0 ||
        entry.length <= 0 ||
        entry.offset + entry.length > parsed.indexOffset ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)
      ) {
        throw new Error(
          `C# runner assembly pack has invalid entry ${metadata.name}:${name}.`
        );
      }
      const assemblyBytes = packBytes.subarray(
        entry.offset,
        entry.offset + entry.length
      );
      if (sha256Hex(assemblyBytes) !== entry.sha256) {
        throw new Error(
          `C# runner packed assembly integrity failed: ${metadata.name}:${name}.`
        );
      }
      seenAssemblyNames.add(name);
      ranges.push([entry.offset, entry.offset + entry.length]);
    }
    ranges.sort((left, right) => left[0] - right[0]);
    if (
      ranges.some(
        (range, index) => index > 0 && range[0] < ranges[index - 1][1]
      )
    ) {
      throw new Error(`C# runner assembly pack entries overlap: ${metadata.name}.`);
    }
    if (
      metadata.assemblies.some(
        (name) => !Object.prototype.hasOwnProperty.call(parsed.index.entries, name)
      )
    ) {
      throw new Error(
        `C# runner assembly pack manifest differs from ${metadata.name}.`
      );
    }
  }
  if (
    seenAssemblyNames.size !== expectedVirtualPaths.size ||
    [...expectedVirtualPaths.keys()].some(
      (name) => !seenAssemblyNames.has(name)
    )
  ) {
    throw new Error('C# runner assembly packs do not cover its boot manifest.');
  }

  const resources = config.resources;
  if (!resources) {
    throw new Error('C# runner boot manifest is missing resources.');
  }
  const expectedResourceHash = `sha256-${sha256Base64(
    JSON.stringify({ ...resources, hash: undefined })
  )}`;
  if (resources.hash !== expectedResourceHash) {
    throw new Error('C# runner boot resource hash is stale after packing.');
  }
  for (const sourceMap of ['dotnet.js.map', 'dotnet.runtime.js.map']) {
    if (await fileExists(join(frameworkDirectory, sourceMap))) {
      throw new Error(`Packed C# runner must not ship unused ${sourceMap}.`);
    }
  }
  const actualPackNames = (await readdir(frameworkDirectory))
    .filter((name) => name.endsWith('.pack'))
    .sort();
  const expectedPackNames = [...seenPackNames].sort();
  if (JSON.stringify(actualPackNames) !== JSON.stringify(expectedPackNames)) {
    throw new Error('C# runner contains unreferenced assembly-pack files.');
  }
}

function parseBootConfig(source: string, bootPath: string): BootConfig {
  const match = source.match(
    /^export const config = \/\*json-start\*\/(?<json>[\s\S]*?)\/\*json-end\*\/;$/
  );
  if (!match?.groups?.json) {
    throw new Error(`Unable to parse .NET boot manifest at ${bootPath}`);
  }
  return JSON.parse(match.groups.json) as BootConfig;
}

function assetNames(config: BootConfig): string[] {
  return [
    ...(config.resources?.coreAssembly ?? []),
    ...(config.resources?.assembly ?? []),
    ...(config.resources?.vfs ?? []),
  ].flatMap((asset) =>
    [asset.name, asset.virtualPath].filter(
      (value): value is string => typeof value === 'string'
    )
  );
}

async function bundleStats(directory: string): Promise<BundleStats> {
  const totals: BundleStats = { files: 0, rawBytes: 0, brotliBytes: 0 };
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      const bytes = await readFile(path);
      totals.files += 1;
      totals.rawBytes += bytes.byteLength;
      totals.brotliBytes += brotliCompressSync(bytes, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 6,
        },
      }).byteLength;
    }
  };
  await visit(directory);
  return totals;
}

function requireAsset(
  names: readonly string[],
  pattern: RegExp,
  label: string
): void {
  if (!names.some((name) => pattern.test(name))) {
    throw new Error(`${label} is missing from its C# role bundle.`);
  }
}

function rejectAsset(
  names: readonly string[],
  pattern: RegExp,
  label: string
): void {
  const match = names.find((name) => pattern.test(name));
  if (match) {
    throw new Error(`${label} leaked into the disposable C# runner: ${match}`);
  }
}

function requireAssembly(names: readonly string[], assembly: string): void {
  const filename = `${assembly}.wasm`;
  if (
    !names.some(
      (name) => name === filename || name.endsWith(`/${filename}`)
    )
  ) {
    throw new Error(
      `Disposable C# runner is missing rooted Judge reference ${assembly}.`
    );
  }
}

function validateStableVfsNames(config: BootConfig, role: string): void {
  const vfsAssets = config.resources?.vfs ?? [];
  if (vfsAssets.length === 0) {
    throw new Error(`${role} C# bundle is missing compiler VFS references.`);
  }
  for (const asset of vfsAssets) {
    if (
      typeof asset.virtualPath !== 'string' ||
      !asset.virtualPath.startsWith('/tracecode-refs/') ||
      typeof asset.name !== 'string' ||
      asset.name !== `supportFiles/${basename(asset.virtualPath)}`
    ) {
      throw new Error(
        `${role} C# bundle contains an unstable compiler VFS asset name.`
      );
    }
  }
}

async function inspectBundle(
  role: 'general' | 'compiler' | 'runner',
  directory: string
): Promise<{ config: BootConfig; names: string[]; stats: BundleStats }> {
  await stat(directory);
  const bootPath = join(directory, '_framework', 'dotnet.boot.js');
  const config = parseBootConfig(await readFile(bootPath, 'utf8'), bootPath);
  const names = assetNames(config);
  const stats = await bundleStats(directory);
  const expectedMain =
    role === 'runner'
      ? 'TraceCode.CSharpJudgeRunner.dll'
      : 'TraceCode.CSharpHost.dll';
  if (config.mainAssemblyName !== expectedMain) {
    throw new Error(
      `${role} C# bundle main assembly is ${String(config.mainAssemblyName)}; expected ${expectedMain}.`
    );
  }
  return { config, names, stats };
}

function assertMaxBytes(
  actual: number,
  maximum: number,
  label: string
): void {
  if (actual > maximum) {
    throw new Error(
      `${label} is ${(actual / 1024 / 1024).toFixed(2)} MiB; limit is ${(maximum / 1024 / 1024).toFixed(2)} MiB.`
    );
  }
}

async function main(): Promise<void> {
  if (process.argv.length === 2) {
    await materializeCSharpRoleAssets(resolve(process.cwd()));
  }
  const generalDir = resolve(
    process.argv[2] ?? 'workers/vendor/csharp'
  );
  const compilerDir = resolve(
    process.argv[3] ?? 'workers/vendor/csharp-compiler'
  );
  const runnerDir = resolve(
    process.argv[4] ?? 'workers/vendor/csharp-runner'
  );

  const [general, compiler, runner] = await Promise.all([
    inspectBundle('general', generalDir),
    inspectBundle('compiler', compilerDir),
    inspectBundle('runner', runnerDir),
  ]);
  await validateRunnerAssemblyPacks(runnerDir, runner.config);

  for (const [role, bundle] of [
    ['general', general],
    ['compiler', compiler],
  ] as const) {
    validateStableVfsNames(bundle.config, role);
    const extensions = bundle.config.resources?.extensions;
    if (
      extensions &&
      typeof extensions === 'object' &&
      !Array.isArray(extensions) &&
      'tracecodeAssemblyPacks' in extensions
    ) {
      throw new Error(
        `${role} C# bundle must not use Judge-only assembly packs.`
      );
    }
    requireAsset(
      bundle.names,
      /Microsoft\.CodeAnalysis\.CSharp\.wasm$/i,
      `${role} Roslyn compiler`
    );
    requireAsset(
      bundle.names,
      /TraceCode\.CSharpHost\.wasm$/i,
      `${role} Host`
    );
    requireAsset(
      bundle.names,
      /\/tracecode-refs\/TraceCode\.CSharpHost\.dll$/i,
      `${role} trusted Project bridge metadata`
    );
  }

  requireAsset(
    runner.names,
    /TraceCode\.CSharpJudgeRunner\.wasm$/i,
    'runner entry assembly'
  );
  requireAsset(
    runner.names,
    /TraceCode\.CSharpJudgeRuntime\.wasm$/i,
    'runner Judge runtime'
  );
  for (const assembly of await readRunnerRequiredJudgeAssemblies()) {
    requireAssembly(runner.names, assembly);
  }
  rejectAsset(
    runner.names,
    /Microsoft\.CodeAnalysis(?:\.CSharp)?(?:\.resources)?\.wasm$/i,
    'Roslyn'
  );
  rejectAsset(
    runner.names,
    /TraceCode\.CSharpHost\.wasm$/i,
    'compiler/general Host'
  );
  if ((runner.config.resources?.vfs ?? []).length !== 0) {
    throw new Error('Disposable C# runner must not contain compiler VFS assets.');
  }

  assertMaxBytes(general.stats.rawBytes, GENERAL_MAX_RAW_BYTES, 'general bundle');
  assertMaxBytes(
    compiler.stats.rawBytes,
    COMPILER_MAX_RAW_BYTES,
    'compiler bundle'
  );
  assertMaxBytes(runner.stats.rawBytes, RUNNER_MAX_RAW_BYTES, 'runner bundle');
  assertMaxBytes(
    runner.stats.brotliBytes,
    RUNNER_MAX_BROTLI_BYTES,
    'runner bundle Brotli size'
  );

  const report = Object.fromEntries(
    [
      ['general', general.stats],
      ['compiler', compiler.stats],
      ['runner', runner.stats],
    ].map(([role, stats]) => [
      role,
      {
        ...(stats as BundleStats),
        rawMiB: Number(((stats as BundleStats).rawBytes / 1024 / 1024).toFixed(2)),
        brotliMiB: Number(
          ((stats as BundleStats).brotliBytes / 1024 / 1024).toFixed(2)
        ),
      },
    ])
  );
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

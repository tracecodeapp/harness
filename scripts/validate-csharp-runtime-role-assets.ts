#!/usr/bin/env npx tsx

import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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
const RUNNER_REQUIRED_JUDGE_ASSEMBLIES = [
  'TraceCode.CSharpJudgeRunner',
  'TraceCode.CSharpJudgeRuntime',
  'Microsoft.CSharp',
  'mscorlib',
  'netstandard',
  'System',
  'System.Core',
  'System.Private.CoreLib',
  'System.Runtime',
  'System.Runtime.Extensions',
  'System.Runtime.CompilerServices.Unsafe',
  'System.Runtime.Numerics',
  'System.Runtime.Serialization.Primitives',
  'System.AppContext',
  'System.Buffers',
  'System.Collections',
  'System.Collections.Concurrent',
  'System.Collections.Immutable',
  'System.Collections.NonGeneric',
  'System.Collections.Specialized',
  'System.ComponentModel',
  'System.ComponentModel.Annotations',
  'System.ComponentModel.Primitives',
  'System.ComponentModel.TypeConverter',
  'System.Console',
  'System.Dynamic.Runtime',
  'System.Globalization',
  'System.IO',
  'System.IO.FileSystem',
  'System.IO.FileSystem.Primitives',
  'System.Linq',
  'System.Linq.Expressions',
  'System.Linq.Queryable',
  'System.Memory',
  'System.Numerics',
  'System.Numerics.Vectors',
  'System.ObjectModel',
  'System.Reflection',
  'System.Reflection.Extensions',
  'System.Reflection.Metadata',
  'System.Reflection.Primitives',
  'System.Text.Encoding.Extensions',
  'System.Text.Json',
  'System.Text.RegularExpressions',
  'System.Threading',
  'System.Threading.Tasks',
  'System.Threading.Tasks.Extensions',
  'System.ValueTuple',
] as const;

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

  for (const [role, bundle] of [
    ['general', general],
    ['compiler', compiler],
  ] as const) {
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
  for (const assembly of RUNNER_REQUIRED_JUDGE_ASSEMBLIES) {
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

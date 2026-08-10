#!/usr/bin/env npx tsx

import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { unzipSync, zipSync, type Zippable } from 'fflate';

export const CSHARP_ROLE_ARTIFACTS_SCHEMA =
  'tracecode.csharp-role-artifacts.v2';
const ROLE_NAMES = ['general', 'compiler', 'runner'] as const;
const CSHARP_ROLE_BROWSER_ASSETS = Object.freeze({
  general: Object.freeze({
    packagePath: 'workers/vendor/csharp',
    targetPath: 'vendor/csharp',
  }),
  compiler: Object.freeze({
    packagePath: 'workers/vendor/csharp',
    targetPath: 'vendor/csharp',
  }),
  runner: Object.freeze({
    packagePath: 'workers/vendor/csharp-runner',
    targetPath: 'vendor/csharp-runner',
  }),
});
const ZIP_MTIME = new Date(1980, 0, 1);
const MAX_ROLE_LIMITS = {
  general: {
    files: 512,
    rawBytes: 64 * 1024 * 1024,
    artifactBytes: 32 * 1024 * 1024,
  },
  compiler: { files: 512, rawBytes: 64 * 1024 * 1024, artifactBytes: 32 * 1024 * 1024 },
  runner: { files: 64, rawBytes: 24 * 1024 * 1024, artifactBytes: 12 * 1024 * 1024 },
} as const;

type CSharpArtifactRole = (typeof ROLE_NAMES)[number];

interface FileEntry {
  path: string;
  bytes: Uint8Array;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface CSharpRoleArtifactMetadata {
  artifact: string;
  artifactBytes: number;
  artifactSha256: string;
  fileCount: number;
  treeSha256: string;
  uncompressedBytes: number;
}

export interface CSharpRoleArtifactsManifest {
  schema: typeof CSHARP_ROLE_ARTIFACTS_SCHEMA;
  format: 'zip';
  recipe: {
    archiveTool: 'fflate@0.8.3';
    command: 'pnpm update:csharp-runtime';
    compilerReferencePack: string;
    dotnetSdk: string;
    runnerTrimProfile: string;
    targetFramework: string;
  };
  runtime: {
    framework: 'Microsoft.NETCore.App';
    version: string;
  };
  deployment: {
    browserAssets: typeof CSHARP_ROLE_BROWSER_ASSETS;
    compilerSharesGeneralAssets: true;
  };
  roles: Record<CSharpArtifactRole, CSharpRoleArtifactMetadata>;
}

export interface CreateCSharpRoleArtifactsOptions {
  artifactDirectory?: string;
  compilerDirectory?: string;
  compilerReferencePack: string;
  dotnetSdk: string;
  generalDirectory?: string;
  runnerDirectory?: string;
  runnerTrimProfile: string;
  targetFramework: string;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertCompilerSharesGeneralArtifact(
  roles: Record<CSharpArtifactRole, CSharpRoleArtifactMetadata>
): void {
  const general = roles.general;
  const compiler = roles.compiler;
  for (const field of [
    'artifact',
    'artifactBytes',
    'artifactSha256',
    'fileCount',
    'treeSha256',
    'uncompressedBytes',
  ] as const) {
    if (general[field] !== compiler[field]) {
      throw new Error(
        `C# compiler asset alias requires byte-identical general and compiler roles; ${field} differs. ` +
          'Publish a distinct compiler asset path before allowing the role trees to diverge.'
      );
    }
  }
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

async function collectFiles(root: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const artifactPath = relative(root, path).split(sep).join('/');
        if (!isSafeRelativePath(artifactPath)) {
          throw new Error(`Unsafe C# role artifact path: ${artifactPath}`);
        }
        files.push({ path: artifactPath, bytes: await readFile(path) });
      } else {
        throw new Error(`C# role assets must not contain links or special files: ${path}`);
      }
    }
  }
  await visit(root);
  files.sort((left, right) => compareText(left.path, right.path));
  return files;
}

function treeSha256(files: FileEntry[]): string {
  const hash = createHash('sha256');
  hash.update(`${CSHARP_ROLE_ARTIFACTS_SCHEMA}\0`);
  for (const file of files) {
    const pathBytes = Buffer.from(file.path, 'utf8');
    const header = Buffer.alloc(12);
    header.writeUInt32BE(pathBytes.byteLength, 0);
    header.writeBigUInt64BE(BigInt(file.bytes.byteLength), 4);
    hash.update(header);
    hash.update(pathBytes);
    hash.update(createHash('sha256').update(file.bytes).digest());
  }
  return hash.digest('hex');
}

function buildZip(files: FileEntry[]): Uint8Array {
  const input: Zippable = {};
  for (const file of files) {
    input[file.path] = [
      file.bytes,
      { attrs: 0o644 << 16, level: 9, mtime: ZIP_MTIME, os: 3 },
    ];
  }
  return zipSync(input, {
    attrs: 0o644 << 16,
    level: 9,
    mtime: ZIP_MTIME,
    os: 3,
  });
}

function parseRuntimeVersion(runtimeConfig: unknown, expectedTfm: string): string {
  const options =
    runtimeConfig &&
    typeof runtimeConfig === 'object' &&
    'runtimeOptions' in runtimeConfig &&
    runtimeConfig.runtimeOptions &&
    typeof runtimeConfig.runtimeOptions === 'object'
      ? runtimeConfig.runtimeOptions
      : undefined;
  if (!options || !('tfm' in options) || options.tfm !== expectedTfm) {
    throw new Error(`C# role runtimeconfig does not target ${expectedTfm}.`);
  }
  const frameworks =
    'includedFrameworks' in options && Array.isArray(options.includedFrameworks)
      ? options.includedFrameworks
      : [];
  const framework = frameworks.find(
    (candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      'name' in candidate &&
      candidate.name === 'Microsoft.NETCore.App'
  );
  if (
    !framework ||
    !('version' in framework) ||
    typeof framework.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(framework.version)
  ) {
    throw new Error('C# role runtimeconfig is missing Microsoft.NETCore.App.');
  }
  return framework.version;
}

async function roleRuntimeVersion(
  role: CSharpArtifactRole,
  directory: string,
  targetFramework: string
): Promise<string> {
  const runtimeConfigName =
    role === 'runner'
      ? 'TraceCode.CSharpJudgeRunner.runtimeconfig.json'
      : 'TraceCode.CSharpHost.runtimeconfig.json';
  return parseRuntimeVersion(
    JSON.parse(await readFile(join(directory, runtimeConfigName), 'utf8')),
    targetFramework
  );
}

async function publishDirectory(staging: string, target: string): Promise<void> {
  const parent = dirname(target);
  const backup = join(
    parent,
    `.${target.split(sep).at(-1)}.backup-${process.pid}-${Date.now()}`
  );
  let movedPrevious = false;
  try {
    try {
      await rename(target, backup);
      movedPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(staging, target);
    if (movedPrevious) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (movedPrevious) {
      await rename(backup, target).catch(() => undefined);
    }
    throw error;
  }
}

export async function createCSharpRoleArtifacts(
  options: CreateCSharpRoleArtifactsOptions
): Promise<CSharpRoleArtifactsManifest> {
  const root = resolve(process.cwd());
  const artifactDirectory = resolve(
    options.artifactDirectory ?? join(root, 'workers/vendor/csharp-role-artifacts')
  );
  const directories: Record<CSharpArtifactRole, string> = {
    general: resolve(
      options.generalDirectory ?? join(root, 'workers/vendor/csharp')
    ),
    compiler: resolve(
      options.compilerDirectory ?? join(root, 'workers/vendor/csharp-compiler')
    ),
    runner: resolve(
      options.runnerDirectory ?? join(root, 'workers/vendor/csharp-runner')
    ),
  };
  const versions = await Promise.all(
    ROLE_NAMES.map((role) =>
      roleRuntimeVersion(role, directories[role], options.targetFramework)
    )
  );
  if (new Set(versions).size !== 1) {
    throw new Error('C# role bundles use different .NET runtime versions.');
  }

  await mkdir(dirname(artifactDirectory), { recursive: true });
  const staging = await mkdtemp(
    join(dirname(artifactDirectory), '.csharp-role-artifacts-')
  );
  try {
    const roles = {} as Record<CSharpArtifactRole, CSharpRoleArtifactMetadata>;
    for (const role of ROLE_NAMES) {
      const files = await collectFiles(directories[role]);
      const uncompressedBytes = files.reduce(
        (total, file) => total + file.bytes.byteLength,
        0
      );
      const limits = MAX_ROLE_LIMITS[role];
      if (
        files.length < 1 ||
        files.length > limits.files ||
        uncompressedBytes > limits.rawBytes
      ) {
        throw new Error(`C# ${role} role assets exceed their safety envelope.`);
      }
      const artifactBytes = buildZip(files);
      if (artifactBytes.byteLength > limits.artifactBytes) {
        throw new Error(`C# ${role} role artifact exceeds its size limit.`);
      }
      const artifactSha256 = sha256(artifactBytes);
      const artifact = `csharp-bundle.${artifactSha256}.zip`;
      const artifactPath = join(staging, artifact);
      try {
        const existing = await readFile(artifactPath);
        if (!Buffer.from(existing).equals(Buffer.from(artifactBytes))) {
          throw new Error(`C# ${role} role artifact hash collision.`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await writeFile(artifactPath, artifactBytes);
      }
      roles[role] = {
        artifact,
        artifactBytes: artifactBytes.byteLength,
        artifactSha256,
        fileCount: files.length,
        treeSha256: treeSha256(files),
        uncompressedBytes,
      };
    }
    assertCompilerSharesGeneralArtifact(roles);
    const manifest: CSharpRoleArtifactsManifest = {
      schema: CSHARP_ROLE_ARTIFACTS_SCHEMA,
      format: 'zip',
      recipe: {
        archiveTool: 'fflate@0.8.3',
        command: 'pnpm update:csharp-runtime',
        compilerReferencePack: options.compilerReferencePack,
        dotnetSdk: options.dotnetSdk,
        runnerTrimProfile: options.runnerTrimProfile,
        targetFramework: options.targetFramework,
      },
      runtime: {
        framework: 'Microsoft.NETCore.App',
        version: versions[0]!,
      },
      deployment: {
        browserAssets: CSHARP_ROLE_BROWSER_ASSETS,
        compilerSharesGeneralAssets: true,
      },
      roles,
    };
    await writeFile(
      join(staging, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    );
    await publishDirectory(staging, artifactDirectory);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function validateManifest(
  candidate: unknown,
  artifactDirectory: string
): CSharpRoleArtifactsManifest {
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !('schema' in candidate) ||
    candidate.schema !== CSHARP_ROLE_ARTIFACTS_SCHEMA ||
    !('format' in candidate) ||
    candidate.format !== 'zip' ||
    !('recipe' in candidate) ||
    !candidate.recipe ||
    typeof candidate.recipe !== 'object' ||
    !('archiveTool' in candidate.recipe) ||
    candidate.recipe.archiveTool !== 'fflate@0.8.3' ||
    !('command' in candidate.recipe) ||
    candidate.recipe.command !== 'pnpm update:csharp-runtime' ||
    !('dotnetSdk' in candidate.recipe) ||
    typeof candidate.recipe.dotnetSdk !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(candidate.recipe.dotnetSdk) ||
    !('targetFramework' in candidate.recipe) ||
    typeof candidate.recipe.targetFramework !== 'string' ||
    !/^net\d+\.\d+$/.test(candidate.recipe.targetFramework) ||
    !('compilerReferencePack' in candidate.recipe) ||
    typeof candidate.recipe.compilerReferencePack !== 'string' ||
    !('runnerTrimProfile' in candidate.recipe) ||
    typeof candidate.recipe.runnerTrimProfile !== 'string' ||
    !('runtime' in candidate) ||
    !candidate.runtime ||
    typeof candidate.runtime !== 'object' ||
    !('framework' in candidate.runtime) ||
    candidate.runtime.framework !== 'Microsoft.NETCore.App' ||
    !('version' in candidate.runtime) ||
    typeof candidate.runtime.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(candidate.runtime.version) ||
    !('deployment' in candidate) ||
    !candidate.deployment ||
    typeof candidate.deployment !== 'object' ||
    !('compilerSharesGeneralAssets' in candidate.deployment) ||
    candidate.deployment.compilerSharesGeneralAssets !== true ||
    !('browserAssets' in candidate.deployment) ||
    JSON.stringify(candidate.deployment.browserAssets) !==
      JSON.stringify(CSHARP_ROLE_BROWSER_ASSETS) ||
    !('roles' in candidate) ||
    !candidate.roles ||
    typeof candidate.roles !== 'object'
  ) {
    throw new Error(`Invalid C# role artifact manifest at ${artifactDirectory}.`);
  }
  for (const role of ROLE_NAMES) {
    const metadata =
      role in candidate.roles
        ? (candidate.roles as Record<string, unknown>)[role]
        : undefined;
    const limits = MAX_ROLE_LIMITS[role];
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      !('artifact' in metadata) ||
      typeof metadata.artifact !== 'string' ||
      !/^csharp-bundle\.[a-f0-9]{64}\.zip$/.test(metadata.artifact) ||
      !('artifactSha256' in metadata) ||
      typeof metadata.artifactSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(metadata.artifactSha256) ||
      !metadata.artifact.includes(metadata.artifactSha256) ||
      !('treeSha256' in metadata) ||
      typeof metadata.treeSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(metadata.treeSha256) ||
      !('fileCount' in metadata) ||
      typeof metadata.fileCount !== 'number' ||
      !Number.isSafeInteger(metadata.fileCount) ||
      metadata.fileCount < 1 ||
      metadata.fileCount > limits.files ||
      !('artifactBytes' in metadata) ||
      typeof metadata.artifactBytes !== 'number' ||
      !Number.isSafeInteger(metadata.artifactBytes) ||
      metadata.artifactBytes < 1 ||
      metadata.artifactBytes > limits.artifactBytes ||
      !('uncompressedBytes' in metadata) ||
      typeof metadata.uncompressedBytes !== 'number' ||
      !Number.isSafeInteger(metadata.uncompressedBytes) ||
      metadata.uncompressedBytes < 1 ||
      metadata.uncompressedBytes > limits.rawBytes
    ) {
      throw new Error(`Invalid C# ${role} role artifact metadata.`);
    }
  }
  const manifest = candidate as CSharpRoleArtifactsManifest;
  assertCompilerSharesGeneralArtifact(manifest.roles);
  return manifest;
}

export async function readCSharpRoleArtifactsManifest(
  artifactDirectory = resolve('workers/vendor/csharp-role-artifacts')
): Promise<CSharpRoleArtifactsManifest> {
  const source = await readFile(join(artifactDirectory, 'manifest.json'), 'utf8');
  const manifest = validateManifest(JSON.parse(source), artifactDirectory);
  const actualFiles = (await readdir(artifactDirectory)).sort();
  const expectedFiles = [
    'manifest.json',
    ...new Set(ROLE_NAMES.map((role) => manifest.roles[role].artifact)),
  ].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('C# role artifact directory contains missing or stale files.');
  }
  return manifest;
}

async function readVerifiedArtifact(
  role: CSharpArtifactRole,
  artifactDirectory: string,
  metadata: CSharpRoleArtifactMetadata
): Promise<Buffer> {
  const artifact = await readFile(join(artifactDirectory, metadata.artifact));
  if (
    artifact.byteLength !== metadata.artifactBytes ||
    sha256(artifact) !== metadata.artifactSha256
  ) {
    throw new Error(`C# ${role} role artifact integrity check failed.`);
  }
  return artifact;
}

function extractAndVerifyArtifact(
  role: CSharpArtifactRole,
  artifact: Uint8Array,
  metadata: CSharpRoleArtifactMetadata
): FileEntry[] {
  let declaredBytes = 0;
  let declaredFiles = 0;
  const declaredNames = new Set<string>();
  const archive = unzipSync(artifact, {
    filter: (file) => {
      declaredBytes += file.originalSize;
      declaredFiles += 1;
      if (
        !Number.isSafeInteger(file.originalSize) ||
        file.originalSize < 0 ||
        !isSafeRelativePath(file.name) ||
        declaredNames.has(file.name) ||
        declaredFiles > metadata.fileCount ||
        declaredBytes > metadata.uncompressedBytes
      ) {
        throw new Error(`Unsafe C# ${role} role ZIP inventory.`);
      }
      declaredNames.add(file.name);
      return true;
    },
  });
  const files = Object.entries(archive)
    .map(([path, bytes]) => ({ path, bytes }))
    .sort((left, right) => compareText(left.path, right.path));
  if (
    files.length !== metadata.fileCount ||
    declaredFiles !== metadata.fileCount ||
    declaredBytes !== metadata.uncompressedBytes ||
    files.some((file) => !isSafeRelativePath(file.path)) ||
    files.reduce((total, file) => total + file.bytes.byteLength, 0) !==
      metadata.uncompressedBytes ||
    treeSha256(files) !== metadata.treeSha256
  ) {
    throw new Error(`C# ${role} role artifact tree integrity check failed.`);
  }
  return files;
}

async function writeTree(directory: string, files: FileEntry[]): Promise<void> {
  for (const file of files) {
    const target = join(directory, ...file.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { mode: 0o644 });
  }
}

async function directoryMatches(
  directory: string,
  metadata: CSharpRoleArtifactMetadata
): Promise<boolean> {
  try {
    const files = await collectFiles(directory);
    return (
      files.length === metadata.fileCount &&
      files.reduce((total, file) => total + file.bytes.byteLength, 0) ===
        metadata.uncompressedBytes &&
      treeSha256(files) === metadata.treeSha256
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function materializeCSharpRoleAssets(
  root = resolve(process.cwd())
): Promise<{ changed: CSharpArtifactRole[]; manifest: CSharpRoleArtifactsManifest }> {
  const artifactDirectory = join(root, 'workers/vendor/csharp-role-artifacts');
  const manifest = await readCSharpRoleArtifactsManifest(artifactDirectory);
  const changed: CSharpArtifactRole[] = [];
  for (const role of ROLE_NAMES) {
    const target = join(
      root,
      role === 'general'
        ? 'workers/vendor/csharp'
        : `workers/vendor/csharp-${role}`
    );
    const metadata = manifest.roles[role];
    const artifact = await readVerifiedArtifact(
      role,
      artifactDirectory,
      metadata
    );
    if (await directoryMatches(target, metadata)) continue;
    const files = extractAndVerifyArtifact(role, artifact, metadata);
    const stagingRoot = await mkdtemp(
      join(dirname(target), `.csharp-${role}-materialize-`)
    );
    const stagingTree = join(stagingRoot, 'tree');
    try {
      await mkdir(stagingTree);
      await writeTree(stagingTree, files);
      if (!(await directoryMatches(stagingTree, metadata))) {
        throw new Error(`Materialized C# ${role} role tree failed verification.`);
      }
      await publishDirectory(stagingTree, target);
      changed.push(role);
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
  return { changed, manifest };
}

export async function verifyCSharpRoleAssets(
  root = resolve(process.cwd())
): Promise<CSharpRoleArtifactsManifest> {
  const artifactDirectory = join(root, 'workers/vendor/csharp-role-artifacts');
  const manifest = await readCSharpRoleArtifactsManifest(artifactDirectory);
  for (const role of ROLE_NAMES) {
    await readVerifiedArtifact(role, artifactDirectory, manifest.roles[role]);
    const target = join(
      root,
      role === 'general'
        ? 'workers/vendor/csharp'
        : `workers/vendor/csharp-${role}`
    );
    if (!(await directoryMatches(target, manifest.roles[role]))) {
      throw new Error(
        `Materialized C# ${role} role assets do not match their canonical artifact.`
      );
    }
  }
  return manifest;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'verify') {
    await verifyCSharpRoleAssets(resolve(process.argv[3] ?? process.cwd()));
    console.log('C# role assets match their canonical artifacts.');
    return;
  }
  if (command === 'materialize') {
    const result = await materializeCSharpRoleAssets(
      resolve(process.argv[3] ?? process.cwd())
    );
    console.log(
      result.changed.length === 0
        ? 'C# role assets already match their canonical artifacts.'
        : `Materialized C# role assets: ${result.changed.join(', ')}.`
    );
    return;
  }
  if (command === 'create') {
    const [
      generalDirectory,
      compilerDirectory,
      runnerDirectory,
      artifactDirectory,
      dotnetSdk,
      targetFramework,
      compilerReferencePack,
      runnerTrimProfile,
    ] = process.argv.slice(3);
    if (
      !generalDirectory ||
      !compilerDirectory ||
      !runnerDirectory ||
      !artifactDirectory ||
      !dotnetSdk ||
      !targetFramework ||
      !compilerReferencePack ||
      !runnerTrimProfile
    ) {
      throw new Error(
        'Usage: csharp-role-artifacts.ts create <general-dir> <compiler-dir> <runner-dir> <artifact-dir> <dotnet-sdk> <target-framework> <compiler-reference-pack> <runner-trim-profile>'
      );
    }
    const manifest = await createCSharpRoleArtifacts({
      artifactDirectory,
      compilerDirectory,
      compilerReferencePack,
      dotnetSdk,
      generalDirectory,
      runnerDirectory,
      runnerTrimProfile,
      targetFramework,
    });
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  throw new Error(
    'Usage: csharp-role-artifacts.ts <create|materialize|verify> ...'
  );
}

const roleArtifactsEntrypoint = process.argv[1];
if (
  roleArtifactsEntrypoint &&
  /(?:^|[/\\])csharp-role-artifacts\.(?:ts|js|mjs)$/u.test(
    roleArtifactsEntrypoint
  )
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

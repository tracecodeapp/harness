#!/usr/bin/env npx tsx

import { deepStrictEqual, equal, rejects } from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  createCSharpRoleArtifacts,
  materializeCSharpRoleAssets,
  readCSharpRoleArtifactsManifest,
  verifyCSharpRoleAssets,
} from '../scripts/csharp-role-artifacts.js';

const SDK_VERSION = '10.0.110';
const TARGET_FRAMEWORK = 'net10.0';
const RUNTIME_VERSION = '10.0.10';

async function fixtureRole(
  directory: string,
  runtimeConfigName: string,
  files: Record<string, string>
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, runtimeConfigName),
    `${JSON.stringify({
      runtimeOptions: {
        tfm: TARGET_FRAMEWORK,
        includedFrameworks: [
          { name: 'Microsoft.NETCore.App', version: RUNTIME_VERSION },
        ],
      },
    }, null, 2)}\n`
  );
  for (const [path, source] of Object.entries(files)) {
    const target = join(directory, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }
}

async function compareDirectories(
  left: string,
  right: string
): Promise<void> {
  const leftEntries = await readdir(left, { withFileTypes: true });
  const rightEntries = await readdir(right, { withFileTypes: true });
  deepStrictEqual(
    leftEntries.map((entry) => [entry.name, entry.isDirectory()]),
    rightEntries.map((entry) => [entry.name, entry.isDirectory()])
  );
  for (const entry of leftEntries) {
    const leftPath = join(left, entry.name);
    const rightPath = join(right, entry.name);
    if (entry.isDirectory()) {
      await compareDirectories(leftPath, rightPath);
    } else {
      deepStrictEqual(await readFile(leftPath), await readFile(rightPath));
    }
  }
}

async function createFixture(t: TestContext): Promise<{
  artifactDirectory: string;
  compilerSource: string;
  generalSource: string;
  root: string;
  runnerSource: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'tracecode-csharp-role-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generalSource = join(root, 'source/general');
  const compilerSource = join(root, 'source/compiler');
  const runnerSource = join(root, 'source/runner');
  const hostFiles = {
    '_framework/compiler.wasm': 'compiler-bytes',
    '_framework/supportFiles/System.Runtime.dll': 'reference-bytes',
    'main.mjs': 'export default {};\n',
  };
  await Promise.all([
    fixtureRole(
      generalSource,
      'TraceCode.CSharpHost.runtimeconfig.json',
      hostFiles
    ),
    fixtureRole(
      compilerSource,
      'TraceCode.CSharpHost.runtimeconfig.json',
      hostFiles
    ),
  ]);
  await fixtureRole(
    runnerSource,
    'TraceCode.CSharpJudgeRunner.runtimeconfig.json',
    {
      '_framework/assemblies-01.pack': 'runner-pack-bytes',
      '_framework/dotnet.native.wasm': 'runtime-bytes',
      'main.mjs': 'export default {};\n',
    }
  );
  const artifactDirectory = join(
    root,
    'workers/vendor/csharp-role-artifacts'
  );
  return {
    artifactDirectory,
    compilerSource,
    generalSource,
    root,
    runnerSource,
  };
}

function creationOptions(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return {
    artifactDirectory: fixture.artifactDirectory,
    compilerDirectory: fixture.compilerSource,
    compilerReferencePack: 'Minimal',
    dotnetSdk: SDK_VERSION,
    generalDirectory: fixture.generalSource,
    runnerDirectory: fixture.runnerSource,
    runnerTrimProfile: 'JudgeReferences',
    targetFramework: TARGET_FRAMEWORK,
  } as const;
}

test('C# role artifacts are deterministic and materialize exact trees', async (t) => {
  const fixture = await createFixture(t);
  const first = await createCSharpRoleArtifacts(creationOptions(fixture));
  const copyDirectory = join(fixture.root, 'artifact-copy');
  const second = await createCSharpRoleArtifacts({
    ...creationOptions(fixture),
    artifactDirectory: copyDirectory,
  });
  deepStrictEqual(second, first);
  await compareDirectories(fixture.artifactDirectory, copyDirectory);
  equal(
    first.roles.general.artifact,
    first.roles.compiler.artifact,
    'identical general and compiler trees must share one content-addressed archive'
  );

  const materialized = await materializeCSharpRoleAssets(fixture.root);
  deepStrictEqual(materialized.changed, ['general', 'compiler', 'runner']);
  await compareDirectories(
    fixture.generalSource,
    join(fixture.root, 'workers/vendor/csharp')
  );
  await compareDirectories(
    fixture.compilerSource,
    join(fixture.root, 'workers/vendor/csharp-compiler')
  );
  await compareDirectories(
    fixture.runnerSource,
    join(fixture.root, 'workers/vendor/csharp-runner')
  );
  await verifyCSharpRoleAssets(fixture.root);

  await writeFile(
    join(fixture.root, 'workers/vendor/csharp-compiler/_framework/compiler.wasm'),
    'tampered'
  );
  const repaired = await materializeCSharpRoleAssets(fixture.root);
  deepStrictEqual(repaired.changed, ['compiler']);
  deepStrictEqual(
    await materializeCSharpRoleAssets(fixture.root).then((result) => result.changed),
    []
  );
});

test('C# role artifact integrity and inventory fail closed', async (t) => {
  const fixture = await createFixture(t);
  const manifest = await createCSharpRoleArtifacts(creationOptions(fixture));
  const runnerArtifact = join(
    fixture.artifactDirectory,
    manifest.roles.runner.artifact
  );
  const bytes = await readFile(runnerArtifact);
  bytes[bytes.byteLength - 1] ^= 0xff;
  await writeFile(runnerArtifact, bytes);
  await rejects(
    () => materializeCSharpRoleAssets(fixture.root),
    /runner role artifact integrity check failed/
  );

  await createCSharpRoleArtifacts(creationOptions(fixture));
  await writeFile(join(fixture.artifactDirectory, 'stale.zip'), 'stale');
  await rejects(
    () => readCSharpRoleArtifactsManifest(fixture.artifactDirectory),
    /missing or stale files/
  );
});

test('tracked C# role artifacts are reproducible from their materialized trees', async (t) => {
  const root = resolve(process.cwd());
  const manifest = await verifyCSharpRoleAssets(root);
  const packageJson = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8')
  ) as { files?: string[] };
  equal(
    packageJson.files?.includes('!workers/vendor/csharp-role-artifacts/**'),
    true,
    'npm publication must not duplicate canonical role ZIPs'
  );
  equal(
    manifest.recipe.dotnetSdk,
    (
      await readFile(
        join(root, 'packages/runtime-csharp/dotnet/Directory.Build.props'),
        'utf8'
      )
    ).match(/<TraceCodeDotnetSdkVersion>([^<]+)</)?.[1]
  );
  const buildProps = await readFile(
    join(root, 'packages/runtime-csharp/dotnet/Directory.Build.props'),
    'utf8'
  );
  equal(
    buildProps.includes(
      '&quot;-ffile-prefix-map=$(DOTNET_ROOT)=/tracecode/dotnet&quot;'
    ),
    true,
    'native Wasm debug paths must not depend on the SDK installation root'
  );
  for (const role of ['csharp', 'csharp-compiler', 'csharp-runner']) {
    for (const name of ['dotnet.native.js', 'dotnet.native.wasm']) {
      const bytes = await readFile(
        join(root, 'workers/vendor', role, '_framework', name)
      );
      equal(
        bytes.includes(Buffer.from(root)),
        false,
        `${role}/${name} must not retain the checkout path`
      );
      equal(
        bytes.includes(Buffer.from('/tracecode/dotnet')),
        true,
        `${role}/${name} must use the canonical SDK path map`
      );
    }
  }

  const regenerated = await mkdtemp(
    join(tmpdir(), 'tracecode-csharp-role-artifacts-regenerated-')
  );
  t.after(() => rm(regenerated, { recursive: true, force: true }));
  await createCSharpRoleArtifacts({
    artifactDirectory: regenerated,
    compilerDirectory: join(root, 'workers/vendor/csharp-compiler'),
    compilerReferencePack: manifest.recipe.compilerReferencePack,
    dotnetSdk: manifest.recipe.dotnetSdk,
    generalDirectory: join(root, 'workers/vendor/csharp'),
    runnerDirectory: join(root, 'workers/vendor/csharp-runner'),
    runnerTrimProfile: manifest.recipe.runnerTrimProfile,
    targetFramework: manifest.recipe.targetFramework,
  });
  await compareDirectories(
    join(root, 'workers/vendor/csharp-role-artifacts'),
    regenerated
  );

  const cleanRoot = await mkdtemp(
    join(tmpdir(), 'tracecode-csharp-role-artifacts-clean-')
  );
  t.after(() => rm(cleanRoot, { recursive: true, force: true }));
  const cleanArtifacts = join(
    cleanRoot,
    'workers/vendor/csharp-role-artifacts'
  );
  await mkdir(cleanArtifacts, { recursive: true });
  for (const name of await readdir(
    join(root, 'workers/vendor/csharp-role-artifacts')
  )) {
    await copyFile(
      join(root, 'workers/vendor/csharp-role-artifacts', name),
      join(cleanArtifacts, name)
    );
  }
  deepStrictEqual(
    (await materializeCSharpRoleAssets(cleanRoot)).changed,
    ['general', 'compiler', 'runner']
  );
  await verifyCSharpRoleAssets(cleanRoot);
});

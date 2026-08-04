#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CSHARP_ASSEMBLY_PACKS_SCHEMA,
  packCSharpManagedAssemblies,
  parseCSharpAssemblyPack,
  parseDotnetBootManifest,
} from '../scripts/pack-csharp-managed-assemblies';
import { normalizeCSharpVfsAssets } from '../scripts/normalize-csharp-vfs-assets';

const ASSEMBLIES = [
  ['System.Private.CoreLib.wasm', 8_192],
  ['TraceCode.CSharpJudgeRunner.wasm', 3_071],
  ['System.Runtime.wasm', 2_047],
  ['System.Console.wasm', 1_021],
  ['System.Collections.wasm', 509],
  ['System.Linq.wasm', 251],
] as const;

async function createFixture(root: string): Promise<void> {
  const frameworkDirectory = join(root, '_framework');
  await mkdir(frameworkDirectory, { recursive: true });
  const fixtureAssets = ASSEMBLIES.map(([name, length], index) => {
    const contents = Buffer.alloc(length, index + 1);
    return {
      contents,
      manifest: {
        name,
        virtualPath: name,
        hash: `sha256-${createHash('sha256')
          .update(contents)
          .digest('base64')}`,
      },
    };
  });
  const [coreAsset, ...assemblyAssets] = fixtureAssets;
  const config = {
    mainAssemblyName: 'TraceCode.CSharpJudgeRunner.dll',
    resources: {
      hash: 'sha256-stale-fixture',
      coreAssembly: [coreAsset.manifest],
      assembly: assemblyAssets.map((asset) => asset.manifest),
    },
  };
  await writeFile(
    join(frameworkDirectory, 'dotnet.boot.js'),
    `export const config = /*json-start*/${JSON.stringify(config, null, 2)}/*json-end*/;`
  );
  await writeFile(join(frameworkDirectory, 'dotnet.js.map'), 'unused');
  await writeFile(join(frameworkDirectory, 'dotnet.runtime.js.map'), 'unused');
  for (const [index, [name]] of ASSEMBLIES.entries()) {
    await writeFile(
      join(frameworkDirectory, name),
      fixtureAssets[index].contents
    );
  }
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(stat(path), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, 'ENOENT');
    return true;
  });
}

async function run(t: TestContext): Promise<void> {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'tracecode-csharp-assembly-packs-')
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const firstFixture = join(temporaryRoot, 'first');
  const secondFixture = join(temporaryRoot, 'second');
  await Promise.all([
    createFixture(firstFixture),
    createFixture(secondFixture),
  ]);

  const [firstResult, secondResult] = await Promise.all([
    packCSharpManagedAssemblies(firstFixture, 3),
    packCSharpManagedAssemblies(secondFixture, 3),
  ]);
  assert.equal(firstResult.assemblyCount, ASSEMBLIES.length);
  assert.deepEqual(firstResult.packs, secondResult.packs);
  assert.equal(firstResult.packs.length, 3);
  assert.ok(
    Math.max(...firstResult.packs.map((pack) => pack.bytes)) -
      Math.min(...firstResult.packs.map((pack) => pack.bytes)) <
      ASSEMBLIES[0][1],
    'three-pack partition should be balanced below the largest assembly'
  );

  const firstFramework = join(firstFixture, '_framework');
  const secondFramework = join(secondFixture, '_framework');
  for (const pack of firstResult.packs) {
    const [firstBytes, secondBytes] = await Promise.all([
      readFile(join(firstFramework, pack.name)),
      readFile(join(secondFramework, pack.name)),
    ]);
    assert.deepEqual(firstBytes, secondBytes);
    const parsed = parseCSharpAssemblyPack(firstBytes, pack.name);
    assert.equal(
      Object.keys(parsed.index.entries).length,
      pack.assemblyCount
    );
    for (const name of pack.assemblies) {
      const source = ASSEMBLIES.find(([candidate]) => candidate === name);
      assert.ok(source, `pack contains known fixture assembly ${name}`);
      const entry = parsed.index.entries[name];
      assert.ok(entry, `pack index contains ${name}`);
      assert.deepEqual(
        firstBytes.subarray(entry.offset, entry.offset + entry.length),
        Buffer.alloc(source[1], ASSEMBLIES.indexOf(source) + 1)
      );
    }
  }

  const bootPath = join(firstFramework, 'dotnet.boot.js');
  const parsedBoot = parseDotnetBootManifest(
    await readFile(bootPath, 'utf8'),
    bootPath
  );
  const extension = (
    parsedBoot.config.resources?.extensions as {
      tracecodeAssemblyPacks?: {
        schema?: unknown;
        assemblyCount?: unknown;
      };
    }
  )?.tracecodeAssemblyPacks;
  assert.equal(extension?.schema, CSHARP_ASSEMBLY_PACKS_SCHEMA);
  assert.equal(extension?.assemblyCount, ASSEMBLIES.length);

  for (const [name] of ASSEMBLIES) {
    await assertMissing(join(firstFramework, name));
  }
  await assertMissing(join(firstFramework, 'dotnet.js.map'));
  await assertMissing(join(firstFramework, 'dotnet.runtime.js.map'));
  assert.deepEqual(
    (await readdir(firstFramework))
      .filter((name) => name.endsWith('.pack'))
      .sort(),
    firstResult.packs.map((pack) => pack.name).sort()
  );

  const corruptPack = Buffer.from(
    await readFile(join(firstFramework, firstResult.packs[0].name))
  );
  corruptPack[corruptPack.length - 1] ^= 0xff;
  assert.throws(
    () => parseCSharpAssemblyPack(corruptPack, 'corrupt fixture'),
    /invalid C# assembly pack magic/
  );
}

test('C# runner managed-assembly packs are deterministic and round-trip exact', run);

test('C# VFS reference names are stable and preserve exact metadata bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tracecode-csharp-vfs-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const framework = join(root, '_framework');
  const support = join(framework, 'supportFiles');
  await mkdir(support, { recursive: true });
  const reference = Buffer.from('reference-assembly-bytes');
  const config = {
    resources: {
      hash: 'sha256-stale',
      vfs: [{
        virtualPath: '/tracecode-refs/System.Runtime.dll',
        name: 'supportFiles/17_System.Runtime.dll',
        hash: `sha256-${createHash('sha256').update(reference).digest('base64')}`,
      }],
    },
  };
  await writeFile(
    join(framework, 'dotnet.boot.js'),
    `export const config = /*json-start*/${JSON.stringify(config, null, 2)}/*json-end*/;`
  );
  await writeFile(join(support, '17_System.Runtime.dll'), reference);

  assert.deepEqual(
    await normalizeCSharpVfsAssets(root),
    { bundleDirectory: root, files: 1, renamed: 1 }
  );
  assert.deepEqual(
    await readFile(join(support, 'System.Runtime.dll')),
    reference
  );
  await assertMissing(join(support, '17_System.Runtime.dll'));
  assert.equal((await normalizeCSharpVfsAssets(root)).renamed, 0);

  const parsed = parseDotnetBootManifest(
    await readFile(join(framework, 'dotnet.boot.js'), 'utf8'),
    join(framework, 'dotnet.boot.js')
  ).config;
  assert.equal(
    (parsed.resources?.vfs as Array<{ name?: unknown }> | undefined)?.[0]?.name,
    'supportFiles/System.Runtime.dll'
  );
  assert.match(String(parsed.resources?.hash), /^sha256-[A-Za-z0-9+/]{43}=$/);
});

interface PackedAssemblyLoader {
  onConfigLoaded(config: unknown): void;
  loadBootResource(
    type: string,
    name: string
  ): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
  }> | undefined;
}

function instantiateProductionLoader(
  fetchImplementation: (
    url: string,
    init: RequestInit
  ) => Promise<unknown>
): PackedAssemblyLoader {
  const workerSource = requireWorkerSource();
  const start = workerSource.indexOf(
    'function createTraceCodePackedAssemblyLoader(assetBaseUrl)'
  );
  const end = workerSource.indexOf('\nasync function loadRuntime(assetBaseUrl)', start);
  assert.ok(start >= 0 && end > start, 'production worker contains packed loader');
  const loaderSource = workerSource.slice(start, end);
  const createLoader = new Function(
    'resolveAssetUrl',
    'fetch',
    'Headers',
    'TextDecoder',
    `${loaderSource}; return createTraceCodePackedAssemblyLoader;`
  )(
    (base: string, relative: string) => `${base}/${relative}`,
    fetchImplementation,
    Headers,
    TextDecoder
  ) as (assetBaseUrl: string) => PackedAssemblyLoader;
  return createLoader('/runner');
}

function requireWorkerSource(): string {
  return requireTextFile(
    resolve('workers/csharp/csharp-worker.js')
  );
}

function requireTextFile(path: string): string {
  return requireBufferFile(path).toString('utf8');
}

function requireBufferFile(path: string): Buffer {
  // Keep production-loader setup I/O synchronous so the fetch mock remains
  // browser-shaped and contains only the boot-resource promise boundary.
  return readFileSync(path);
}

test('production C# pack loader fails closed and returns exact assembly bytes', async () => {
  const runnerFramework = resolve('workers/vendor/csharp-runner/_framework');
  const bootPath = join(runnerFramework, 'dotnet.boot.js');
  const config = parseDotnetBootManifest(
    requireTextFile(bootPath),
    bootPath
  ).config;
  const extension = (
    config.resources?.extensions as {
      tracecodeAssemblyPacks: {
        packs: Array<{
          name: string;
          hash: string;
          assemblies: string[];
        }>;
      };
    }
  ).tracecodeAssemblyPacks;
  const firstPack = extension.packs[0];
  const firstPackBytes = requireBufferFile(
    join(runnerFramework, firstPack.name)
  );
  const firstPackIndex = parseCSharpAssemblyPack(
    firstPackBytes,
    firstPack.name
  ).index;
  const requestedAssembly = firstPack.assemblies[0];
  const requestedEntry = firstPackIndex.entries[requestedAssembly];
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const loader = instantiateProductionLoader(async (url, init) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () =>
        firstPackBytes.buffer.slice(
          firstPackBytes.byteOffset,
          firstPackBytes.byteOffset + firstPackBytes.byteLength
        ),
    };
  });
  loader.onConfigLoaded(config);
  assert.equal(loader.loadBootResource('manifest', 'dotnet.boot.js'), undefined);
  const response = await loader.loadBootResource(
    'assembly',
    requestedAssembly
  );
  assert.ok(response);
  const assemblyBytes = Buffer.from(await response.arrayBuffer());
  assert.equal(
    createHash('sha256').update(assemblyBytes).digest('hex'),
    requestedEntry.sha256
  );
  assert.equal(fetchCalls.length, 1);
  assert.equal(
    fetchCalls[0].url,
    `/runner/_framework/${firstPack.name}`
  );
  assert.equal(fetchCalls[0].init.integrity, firstPack.hash);
  await assert.rejects(
    response.arrayBuffer(),
    /assembly pack asset was consumed twice/
  );

  const corruptPack = Buffer.from(firstPackBytes);
  corruptPack[requestedEntry.offset] ^= 0xff;
  const corruptLoader = instantiateProductionLoader(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () =>
      corruptPack.buffer.slice(
        corruptPack.byteOffset,
        corruptPack.byteOffset + corruptPack.byteLength
      ),
  }));
  corruptLoader.onConfigLoaded(config);
  await assert.rejects(
    corruptLoader.loadBootResource('assembly', requestedAssembly)!,
    /assembly pack integrity mismatch/
  );

  const invalidHashConfig = structuredClone(config);
  (
    invalidHashConfig.resources!.extensions as {
      tracecodeAssemblyPacks: {
        packs: Array<{ hash: string }>;
      };
    }
  ).tracecodeAssemblyPacks.packs[0].hash = 'sha256-invalid';
  assert.throws(
    () =>
      instantiateProductionLoader(async () => {
        throw new Error('fetch must not run for invalid metadata');
      }).onConfigLoaded(invalidHashConfig),
    /Invalid TraceCode C# assembly pack entry metadata/
  );
});

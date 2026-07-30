#!/usr/bin/env npx tsx

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const PACKAGE_DIR = join(ROOT, 'packages', 'runtime-sql');
const REMOVED_PROVIDER_API = [
  'PgliteSqlTraceClientOptions',
  'PGLITE_SQL_TRACE_CAPABILITIES',
  'createPgliteSqlTraceClient',
  'inferPgliteSqlPersistence',
] as const;

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertRuntimeSurface(
  runtime: Record<string, unknown>,
  label: string
): Promise<void> {
  for (const exportName of [
    'SQL_RUNTIME_TRACE_CAPABILITIES',
    'createSqlRuntimeTraceClient',
    'createSqlTraceClient',
    'inferSqlPersistence',
    'assertValidSqlTrace',
  ]) {
    assertCondition(exportName in runtime, `${label} should export ${exportName}`);
  }
  for (const removedName of REMOVED_PROVIDER_API) {
    assertCondition(!(removedName in runtime), `${label} should not export removed API ${removedName}`);
  }
}

async function main(): Promise<void> {
  assertCondition(
    !existsSync(join(ROOT, 'packages', 'harness-sql')),
    'Removed packages/harness-sql directory should not remain in the workspace'
  );

  const [manifestText, packageReadme, rootManifestText, rootFacade, lockfile, declarations, rootDeclarations] =
    await Promise.all([
      readFile(join(PACKAGE_DIR, 'package.json'), 'utf8'),
      readFile(join(PACKAGE_DIR, 'README.md'), 'utf8'),
      readFile(join(ROOT, 'package.json'), 'utf8'),
      readFile(join(ROOT, 'src', 'sql.ts'), 'utf8'),
      readFile(join(ROOT, 'pnpm-lock.yaml'), 'utf8'),
      readFile(join(PACKAGE_DIR, 'dist', 'index.d.ts'), 'utf8'),
      readFile(join(ROOT, 'dist', 'sql.d.ts'), 'utf8'),
    ]);
  const manifest = JSON.parse(manifestText) as {
    name?: unknown;
    version?: unknown;
    repository?: { directory?: unknown };
  };
  const rootManifest = JSON.parse(rootManifestText) as {
    exports?: Record<string, unknown>;
  };

  assertCondition(manifest.name === '@tracecode/runtime-sql', 'SQL runtime package name should be @tracecode/runtime-sql');
  assertCondition(manifest.version === '0.14.0', 'SQL runtime package should publish the 0.14.0 API');
  assertCondition(
    manifest.repository?.directory === 'packages/runtime-sql',
    'SQL runtime package repository directory should match its workspace path'
  );
  assertCondition(rootManifest.exports?.['./sql'] !== undefined, 'Root package should preserve the ./sql facade');
  assertCondition(
    rootFacade.trim() === "export * from '../packages/runtime-sql/src/index';",
    'Root ./sql source facade should re-export the SQL runtime package'
  );
  assertCondition(
    lockfile.includes("'@tracecode/runtime-sql':") &&
      lockfile.includes('version: link:../../packages/runtime-sql') &&
      lockfile.includes('packages/runtime-sql: {}') &&
      !lockfile.includes('@tracecode/harness-sql') &&
      !lockfile.includes('packages/harness-sql'),
    'Workspace lockfile should link the renamed SQL runtime package'
  );
  assertCondition(
    !manifestText.includes('@tracecode/harness-sql') &&
      !manifestText.includes('packages/harness-sql') &&
      !packageReadme.includes('@tracecode/harness-sql') &&
      !packageReadme.includes('createPgliteSqlTraceClient'),
    'Published SQL runtime metadata and README should not retain the removed package or provider-branded API'
  );

  for (const publicName of [
    'interface SqlRuntimeTraceClientOptions',
    'persistenceLocation?: string',
    'SQL_RUNTIME_TRACE_CAPABILITIES',
    'createSqlRuntimeTraceClient',
    'createSqlTraceClient',
    'inferSqlPersistence',
    'assertValidSqlTrace',
  ]) {
    assertCondition(declarations.includes(publicName), `Standalone SQL declarations should include ${publicName}`);
    assertCondition(rootDeclarations.includes(publicName), `Root ./sql declarations should include ${publicName}`);
  }
  for (const removedName of REMOVED_PROVIDER_API) {
    assertCondition(!declarations.includes(removedName), `Standalone SQL declarations should omit ${removedName}`);
    assertCondition(!rootDeclarations.includes(removedName), `Root ./sql declarations should omit ${removedName}`);
  }

  const esm = await import(pathToFileURL(join(PACKAGE_DIR, 'dist', 'index.js')).href);
  const require = createRequire(import.meta.url);
  const cjs = require(join(PACKAGE_DIR, 'dist', 'index.cjs')) as Record<string, unknown>;
  const rootEsm = await import(pathToFileURL(join(ROOT, 'dist', 'sql.js')).href);
  const rootCjs = require(join(ROOT, 'dist', 'sql.cjs')) as Record<string, unknown>;
  await assertRuntimeSurface(esm, 'SQL runtime ESM build');
  await assertRuntimeSurface(cjs, 'SQL runtime CommonJS build');
  await assertRuntimeSurface(rootEsm, 'Root ./sql ESM facade');
  await assertRuntimeSurface(rootCjs, 'Root ./sql CommonJS facade');

  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-runtime-sql-package-'));
  try {
    const pack = spawnSync('pnpm', ['pack', '--pack-destination', tempRoot], {
      cwd: PACKAGE_DIR,
      encoding: 'utf8',
    });
    if (pack.status !== 0) {
      throw new Error(pack.stderr || pack.stdout || '@tracecode/runtime-sql pack failed');
    }
    const tarballName = String(pack.stdout).trim().split('\n').filter(Boolean).at(-1);
    assertCondition(Boolean(tarballName), '@tracecode/runtime-sql pack should print a tarball path');
    const tarballPath = isAbsolute(tarballName!) ? tarballName! : join(tempRoot, tarballName!);
    const extractedDir = join(tempRoot, 'package');
    await mkdir(extractedDir, { recursive: true });
    const extract = spawnSync('tar', ['-xf', tarballPath, '-C', extractedDir, '--strip-components=1'], {
      encoding: 'utf8',
    });
    if (extract.status !== 0) {
      throw new Error(extract.stderr || extract.stdout || '@tracecode/runtime-sql tarball extraction failed');
    }
    for (const relativePath of [
      'package.json',
      'README.md',
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ]) {
      assertCondition(
        (await stat(join(extractedDir, relativePath))).isFile(),
        `@tracecode/runtime-sql tarball should include ${relativePath}`
      );
    }
    const packedManifest = JSON.parse(await readFile(join(extractedDir, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    assertCondition(
      packedManifest.name === '@tracecode/runtime-sql' && packedManifest.version === '0.14.0',
      'Packed SQL runtime manifest should preserve the 0.14 package identity'
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  console.log('PASS: SQL runtime package and root facade expose the generic 0.14 surface');
}

test('SQL runtime package surface', main);

import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const CHECK_SCRIPT = resolve(ROOT, 'scripts/check-publish-safety.mjs');
const RELEASE_CHECK_SCRIPT = 'node scripts/check-publish-safety.mjs';
const ROOT_RELEASE_SCRIPT = 'pnpm release:check && pnpm publish . --access public';
const PREPUBLISH_SCRIPT = 'pnpm release:check && pnpm build && pnpm release:check';

interface FixtureOptions {
  rootName?: string;
  internalPrivate?: boolean;
  npmrc?: string;
  releaseRootScript?: string;
  workspacePattern?: string;
}

function runAudit(
  root: string,
  environment: NodeJS.ProcessEnv = process.env
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CHECK_SCRIPT, '--root', root], {
    cwd: ROOT,
    encoding: 'utf8',
    env: environment,
  });
}

function assertAuditFailure(root: string, expected: RegExp): void {
  const result = runAudit(root);
  assert.notEqual(result.status, 0, `audit unexpectedly passed:\n${result.stdout}`);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    expected,
    `audit failure did not explain the violated invariant`
  );
}

async function writeFixture(root: string, options: FixtureOptions = {}): Promise<void> {
  const internalDir = join(root, 'packages', 'internal');
  await mkdir(internalDir, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: options.rootName ?? '@tracecode/harness',
      version: '0.14.0-test',
      publishConfig: { access: 'public' },
      scripts: {
        prepublishOnly: PREPUBLISH_SCRIPT,
        'release:check': RELEASE_CHECK_SCRIPT,
        'release:root': options.releaseRootScript ?? ROOT_RELEASE_SCRIPT,
      },
    }),
    'utf8'
  );
  await writeFile(
    join(root, 'pnpm-workspace.yaml'),
    `packages:\n  - ${options.workspacePattern ?? 'packages/*'}\n`,
    'utf8'
  );
  await writeFile(
    join(root, '.npmrc'),
    options.npmrc ?? 'include-workspace-root=false\n',
    'utf8'
  );
  await writeFile(
    join(internalDir, 'package.json'),
    JSON.stringify({
      name: '@tracecode/internal-test-package',
      private: options.internalPrivate ?? true,
      version: '99.0.0-private-test',
    }),
    'utf8'
  );
}

async function repositoryManifestInventory(): Promise<Array<{
  name: string;
  private?: boolean;
  path: string;
  version?: string;
}>> {
  const manifestPaths = ['package.json'];
  for (const workspaceRoot of ['packages', 'examples']) {
    const entries = await readdir(join(ROOT, workspaceRoot), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        manifestPaths.push(join(workspaceRoot, entry.name, 'package.json'));
      }
    }
  }

  return Promise.all(manifestPaths.map(async (path) => {
    const manifest = JSON.parse(await readFile(join(ROOT, path), 'utf8')) as {
      name?: unknown;
      private?: boolean;
      version?: unknown;
    };
    assert.equal(typeof manifest.name, 'string', `${path} must declare a package name`);
    return {
      name: manifest.name as string,
      private: manifest.private,
      path,
      ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
    };
  }));
}

async function main(): Promise<void> {
  const repositoryAudit = runAudit(ROOT);
  assert.equal(
    repositoryAudit.status,
    0,
    `repository publish audit failed:\n${repositoryAudit.stdout}\n${repositoryAudit.stderr}`
  );
  assert.match(
    repositoryAudit.stdout,
    /@tracecode\/harness is the only publishable workspace manifest; 16 internal manifests are private/u
  );

  const inventory = await repositoryManifestInventory();
  const publishable = inventory.filter((manifest) => manifest.private !== true);
  assert.deepEqual(
    publishable.map(({ name, path }) => ({ name, path })),
    [{ name: '@tracecode/harness', path: 'package.json' }],
    'only the root @tracecode/harness manifest may be publishable'
  );
  const rootVersion = publishable[0]?.version;
  const independentlyVersioned = inventory
    .filter(
      (manifest) =>
        manifest.path !== 'package.json' &&
        typeof manifest.version === 'string' &&
        manifest.version !== rootVersion
    );
  assert.ok(
    independentlyVersioned.every((manifest) => manifest.private === true),
    'only private implementation workspaces may version independently of the registry release'
  );

  const rootManifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    publishConfig?: { access?: unknown };
    scripts?: Record<string, string>;
  };
  assert.equal(rootManifest.publishConfig?.access, 'public');
  assert.equal(rootManifest.scripts?.['release:check'], RELEASE_CHECK_SCRIPT);
  assert.equal(rootManifest.scripts?.['release:root'], ROOT_RELEASE_SCRIPT);
  assert.equal(rootManifest.scripts?.prepublishOnly, PREPUBLISH_SCRIPT);
  assert.doesNotMatch(
    rootManifest.scripts?.['release:root'] ?? '',
    /(?:^|\s)(?:-r|--recursive)(?:\s|$)/u,
    'the audited release command must never recurse through workspace packages'
  );

  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const recursiveSelection = spawnSync(
    pnpmCommand,
    ['--recursive', 'exec', process.execPath, '-e', 'console.log(process.cwd())'],
    {
      cwd: ROOT,
      encoding: 'utf8',
    }
  );
  assert.equal(
    recursiveSelection.status,
    0,
    `recursive workspace selection failed:\n${recursiveSelection.stdout}\n${recursiveSelection.stderr}`
  );
  const recursivelySelectedDirectories = recursiveSelection.stdout.trim().split(/\r?\n/u).filter(Boolean);
  assert.equal(
    recursivelySelectedDirectories.length,
    inventory.length - 1,
    'recursive pnpm commands should select every private workspace and exclude only the root'
  );
  assert.ok(
    recursivelySelectedDirectories.every((directory) => resolve(directory) !== ROOT),
    'include-workspace-root=false must keep the registry release out of recursive pnpm commands'
  );

  const fixtureRoot = await mkdtemp(join(tmpdir(), 'tracecode-publish-safety-'));
  try {
    await writeFixture(fixtureRoot);
    const passingFixture = runAudit(fixtureRoot);
    assert.equal(
      passingFixture.status,
      0,
      `valid root-only fixture failed:\n${passingFixture.stdout}\n${passingFixture.stderr}`
    );

    await writeFixture(fixtureRoot, { internalPrivate: false });
    assertAuditFailure(
      fixtureRoot,
      /packages\/internal\/package\.json .* must set "private": true/u
    );

    await writeFixture(fixtureRoot, { npmrc: 'include-workspace-root=true\n' });
    assertAuditFailure(fixtureRoot, /include-workspace-root=false/u);

    await writeFixture(fixtureRoot, {
      releaseRootScript: 'pnpm --recursive publish',
    });
    assertAuditFailure(fixtureRoot, /release:root must publish only the workspace root/u);

    await writeFixture(fixtureRoot, {
      workspacePattern: 'packages/**',
    });
    assertAuditFailure(fixtureRoot, /unsupported workspace pattern/u);

    await writeFixture(fixtureRoot, {
      rootName: '@tracecode/not-the-root',
    });
    assertAuditFailure(fixtureRoot, /workspace root must be @tracecode\/harness/u);

    await writeFixture(fixtureRoot);
    for (const [key, value] of [
      ['npm_config_recursive', 'true'],
      ['npm_config_filter', '@tracecode/harness'],
      ['npm_config_workspace', 'packages/harness-core'],
      ['npm_config_workspace_root', 'true'],
      ['npm_config_workspaces', 'true'],
    ] as const) {
      const result = runAudit(fixtureRoot, {
        ...process.env,
        [key]: value,
      });
      assert.notEqual(result.status, 0, `${key} must reject workspace-scoped publication`);
      assert.match(`${result.stdout}\n${result.stderr}`, /workspace-scoped publication is forbidden/u);
    }

    const argvScopedAudit = runAudit(fixtureRoot, {
      ...process.env,
      npm_config_argv: JSON.stringify({
        original: ['publish', '--recursive'],
      }),
    });
    assert.notEqual(argvScopedAudit.status, 0, 'recursive npm_config_argv must be rejected');
    assert.match(
      `${argvScopedAudit.stdout}\n${argvScopedAudit.stderr}`,
      /workspace-scoped publication is forbidden/u
    );

    const workspaceRootArgvAudit = runAudit(fixtureRoot, {
      ...process.env,
      npm_config_argv: JSON.stringify({
        original: ['publish', '-w'],
      }),
    });
    assert.notEqual(workspaceRootArgvAudit.status, 0, 'workspace-root npm_config_argv must be rejected');
    assert.match(
      `${workspaceRootArgvAudit.stdout}\n${workspaceRootArgvAudit.stderr}`,
      /workspace-scoped publication is forbidden/u
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }

  console.log('PASS: root release is audited and every non-root workspace manifest is private');
}

test('root publish safety', main);

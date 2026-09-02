import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const CHECK_SCRIPT = resolve(ROOT, 'scripts/check-publish-safety.mjs');
const RELEASE_TAG_SCRIPT = resolve(ROOT, 'scripts/check-release-tag.mjs');
const VERSION_SYNC_SCRIPT = resolve(ROOT, 'scripts/sync-workspace-versions.mjs');
const RELEASE_CHECK_SCRIPT = 'node scripts/check-publish-safety.mjs';
const RELEASE_TAG_CHECK_SCRIPT = 'node scripts/check-release-tag.mjs';
const ROOT_RELEASE_SCRIPT = 'pnpm publish . --access public';
const PREPUBLISH_SCRIPT =
  'pnpm release:check && pnpm release:tag-check && pnpm test:runtime-assets-lock && pnpm build && pnpm release:tag-check && pnpm test:runtime-assets-lock';
const RUNTIME_STAMP_EXCLUSION = '!workers/**/.stamp';

interface FixtureOptions {
  internalName?: string;
  internalVersion?: string;
  rootName?: string;
  internalPrivate?: boolean;
  npmrc?: string;
  packageFiles?: string[];
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

function runVersionSync(
  root: string,
  ...args: string[]
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [VERSION_SYNC_SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
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
      version: '0.0.0-test',
      publishConfig: { access: 'public' },
      files: options.packageFiles ?? [RUNTIME_STAMP_EXCLUSION],
      scripts: {
        prepublishOnly: PREPUBLISH_SCRIPT,
        'release:check': RELEASE_CHECK_SCRIPT,
        'release:tag-check': RELEASE_TAG_CHECK_SCRIPT,
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
      name: options.internalName ?? '@tracecode/internal-test-package',
      private: options.internalPrivate ?? true,
      version: options.internalVersion ?? '0.0.0-test',
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
        const manifestPath = join(workspaceRoot, entry.name, 'package.json');
        try {
          await access(join(ROOT, manifestPath));
          manifestPaths.push(manifestPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
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
  assert.ok(
    inventory
      .filter((manifest) => manifest.path.startsWith('packages/'))
      .every((manifest) => manifest.version === rootVersion),
    'every private implementation package should share the root registry release version'
  );

  const rootManifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    publishConfig?: { access?: unknown };
    scripts?: Record<string, string>;
    files?: string[];
  };
  assert.equal(rootManifest.publishConfig?.access, 'public');
  assert.equal(rootManifest.scripts?.['release:check'], RELEASE_CHECK_SCRIPT);
  assert.equal(rootManifest.scripts?.['release:tag-check'], RELEASE_TAG_CHECK_SCRIPT);
  assert.equal(rootManifest.scripts?.['release:root'], ROOT_RELEASE_SCRIPT);
  assert.equal(rootManifest.scripts?.prepublishOnly, PREPUBLISH_SCRIPT);
  assert.ok(rootManifest.files?.includes(RUNTIME_STAMP_EXCLUSION));
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
    const publishSafetyLink = join(fixtureRoot, 'check-publish-safety-link.mjs');
    await symlink(CHECK_SCRIPT, publishSafetyLink);
    const linkedFixture = spawnSync(
      process.execPath,
      [publishSafetyLink, '--root', fixtureRoot],
      { cwd: ROOT, encoding: 'utf8' }
    );
    assert.equal(
      linkedFixture.status,
      0,
      `symlinked publish audit failed:\n${linkedFixture.stdout}\n${linkedFixture.stderr}`
    );

    const synchronizedFixture = runVersionSync(fixtureRoot, '0.0.1-test.1');
    assert.equal(
      synchronizedFixture.status,
      0,
      `version synchronization failed:\n${synchronizedFixture.stdout}\n${synchronizedFixture.stderr}`
    );
    const synchronizedRoot = JSON.parse(
      await readFile(join(fixtureRoot, 'package.json'), 'utf8')
    ) as { version?: string };
    const synchronizedInternal = JSON.parse(
      await readFile(
        join(fixtureRoot, 'packages', 'internal', 'package.json'),
        'utf8'
      )
    ) as { version?: string };
    assert.equal(synchronizedRoot.version, '0.0.1-test.1');
    assert.equal(synchronizedInternal.version, synchronizedRoot.version);
    assert.equal(runVersionSync(fixtureRoot, '--check').status, 0);

    await writeFixture(fixtureRoot, { internalPrivate: false });
    assertAuditFailure(
      fixtureRoot,
      /packages\/internal\/package\.json .* must set "private": true/u
    );

    await writeFixture(fixtureRoot, { internalVersion: '99.0.0-private-test' });
    assertAuditFailure(
      fixtureRoot,
      /version must match @tracecode\/harness 0\.0\.0-test/u
    );

    await writeFixture(fixtureRoot, {
      internalName: '@tracecode/harness-python',
    });
    assertAuditFailure(fixtureRoot, /retired harness-\* workspace namespace/u);

    await writeFixture(fixtureRoot, { npmrc: 'include-workspace-root=true\n' });
    assertAuditFailure(fixtureRoot, /include-workspace-root=false/u);

    await writeFixture(fixtureRoot, {
      releaseRootScript: 'pnpm --recursive publish',
    });
    assertAuditFailure(fixtureRoot, /release:root must publish only the workspace root/u);

    await writeFixture(fixtureRoot, { packageFiles: [] });
    assertAuditFailure(fixtureRoot, /must exclude runtime lock metadata/u);

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
      ['npm_config_workspace', 'packages/runtime-contracts'],
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

  const releaseFixture = await mkdtemp(join(tmpdir(), 'tracecode-release-tag-'));
  const checkout = join(releaseFixture, 'checkout');
  const origin = join(releaseFixture, 'origin.git');
  const releaseTagLink = join(releaseFixture, 'check-release-tag-link.mjs');
  const isolatedGitConfig = join(releaseFixture, 'isolated.gitconfig');
  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: isolatedGitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const runGit = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync('git', args, {
      cwd: checkout,
      encoding: 'utf8',
      env: gitEnvironment,
    });
  try {
    await mkdir(checkout, { recursive: true });
    await writeFile(isolatedGitConfig, '', 'utf8');
    assert.equal(
      spawnSync('git', ['init', '--bare', origin], {
        encoding: 'utf8',
        env: gitEnvironment,
      }).status,
      0
    );
    assert.equal(runGit('init').status, 0);
    assert.equal(runGit('config', 'user.name', 'TraceCode release test').status, 0);
    assert.equal(runGit('config', 'user.email', 'release-test@tracecode.invalid').status, 0);
    await writeFile(
      join(checkout, 'package.json'),
      JSON.stringify({ name: '@tracecode/harness', version: '1.2.3' }),
      'utf8'
    );
    assert.equal(runGit('add', 'package.json').status, 0);
    assert.equal(runGit('commit', '-m', 'release candidate').status, 0);
    assert.equal(runGit('remote', 'add', 'origin', origin).status, 0);
    await symlink(RELEASE_TAG_SCRIPT, releaseTagLink);

    const runTagAudit = (): SpawnSyncReturns<string> =>
      spawnSync(process.execPath, [releaseTagLink, '--root', checkout], {
        cwd: ROOT,
        encoding: 'utf8',
        env: gitEnvironment,
      });
    assert.notEqual(runTagAudit().status, 0, 'an absent local release tag must fail');
    assert.equal(runGit('tag', '-a', 'v1.2.3', '-m', 'v1.2.3').status, 0);
    assert.notEqual(runTagAudit().status, 0, 'an unpushed release tag must fail');
    assert.equal(runGit('push', 'origin', 'refs/tags/v1.2.3').status, 0);
    const tagged = runTagAudit();
    assert.equal(tagged.status, 0, `${tagged.stdout}\n${tagged.stderr}`);

    const releaseHead = runGit('rev-parse', 'HEAD').stdout.trim();
    const releaseTree = runGit('write-tree').stdout.trim();
    const mismatchedRemoteCommit = runGit(
      'commit-tree',
      releaseTree,
      '-p',
      releaseHead,
      '-m',
      'mismatched remote tag target'
    ).stdout.trim();
    assert.equal(
      runGit(
        'push',
        '--force',
        'origin',
        `${mismatchedRemoteCommit}:refs/tags/v1.2.3`
      ).status,
      0
    );
    assert.notEqual(
      runTagAudit().status,
      0,
      'a remote release tag on a different commit must fail'
    );
    assert.equal(
      runGit('push', '--force', 'origin', 'refs/tags/v1.2.3').status,
      0
    );
    const restoredTag = runTagAudit();
    assert.equal(restoredTag.status, 0, `${restoredTag.stdout}\n${restoredTag.stderr}`);

    await writeFile(join(checkout, 'uncommitted.txt'), 'dirty\n', 'utf8');
    assert.notEqual(runTagAudit().status, 0, 'a dirty release checkout must fail');
    await rm(join(checkout, 'uncommitted.txt'));
    await writeFile(join(checkout, 'next.txt'), 'next\n', 'utf8');
    assert.equal(runGit('add', 'next.txt').status, 0);
    assert.equal(runGit('commit', '-m', 'post release').status, 0);
    assert.notEqual(runTagAudit().status, 0, 'a release tag on a different commit must fail');
  } finally {
    await rm(releaseFixture, { recursive: true, force: true });
  }

  console.log('PASS: root release is audited and every non-root workspace manifest is private');
}

test('root publish safety', main);

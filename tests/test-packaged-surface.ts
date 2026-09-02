#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const ROOT = process.cwd();
const PUBLIC_CODE_EXPORTS = ['./tracekernel', './judge'] as const;
const RETIRED_EXPORTS = [
  '.',
  './browser',
  './browser/project',
  './project',
  './project-node',
] as const;

function runNode(
  cwd: string,
  source: string,
  module = false
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [...(module ? ['--input-type=module'] : []), '-e', source],
    { cwd, encoding: 'utf8' }
  );
}

test('published package has only TraceKernel and Judge code entrypoints', async () => {
  const manifest = JSON.parse(
    await readFile(join(ROOT, 'package.json'), 'utf8')
  ) as {
    exports?: Record<string, unknown>;
    files?: unknown;
    main?: unknown;
    module?: unknown;
    types?: unknown;
  };

  assert.deepEqual(
    Object.keys(manifest.exports ?? {}).sort(),
    ['./judge', './package.json', './tracekernel'],
    'the package export map should name only the two product authorities'
  );
  assert.equal(manifest.main, undefined);
  assert.equal(manifest.module, undefined);
  assert.equal(manifest.types, undefined);
  assert.ok(
    Array.isArray(manifest.files) && manifest.files.includes('!dist/**/*.map'),
    'the release tarball must not republish generated dist source maps'
  );
  assert.ok(
    Array.isArray(manifest.files) && manifest.files.includes('!workers/**/.stamp'),
    'runtime materialization stamps must stay outside the published asset inventory'
  );
  for (const retired of RETIRED_EXPORTS) {
    assert.equal(
      manifest.exports?.[retired],
      undefined,
      `${retired} must not return as a public compatibility surface`
    );
  }

  const traceKernelTypes = await readFile(
    join(ROOT, 'dist/tracekernel.d.ts'),
    'utf8'
  );
  const judgeTypes = await readFile(join(ROOT, 'dist/judge.d.ts'), 'utf8');
  assert.match(traceKernelTypes, /createBrowserWorkspace/u);
  assert.doesNotMatch(traceKernelTypes, /createBrowserRuntimeHost/u);
  assert.match(judgeTypes, /createBrowserJudgeHost/u);
  assert.match(judgeTypes, /createJudge/u);
  assert.match(judgeTypes, /BrowserJudgeExecuteRequest/u);
  assert.match(judgeTypes, /disposeExecution/u);
  assert.match(judgeTypes, /interactiveExecutionIdleTimeoutMs/u);
  assert.match(judgeTypes, /DEFAULT_INTERACTIVE_EXECUTION_IDLE_TIMEOUT_MS/u);
  assert.doesNotMatch(judgeTypes, /createBrowserRuntimeJudge/u);
  assert.doesNotMatch(judgeTypes, /createBrowserJudgeHostFromRuntimeHost/u);
});

test('published worker inventory exactly matches the runtime asset lock', async () => {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packlist = spawnSync(
    npmCommand,
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );
  assert.equal(packlist.status, 0, `${packlist.stdout}\n${packlist.stderr}`);
  const packs = JSON.parse(packlist.stdout) as Array<{
    files?: Array<{ path?: unknown }>;
  }>;
  assert.equal(packs.length, 1, 'npm pack should describe exactly one root package');
  const packedWorkerPaths = (packs[0]?.files ?? [])
    .map((entry) => entry.path)
    .filter((entry): entry is string =>
      typeof entry === 'string' && entry.startsWith('workers/')
    )
    .sort();

  const lock = JSON.parse(
    await readFile(join(ROOT, 'runtime-assets.lock.json'), 'utf8')
  ) as {
    components?: Record<string, { files?: Array<{ path?: unknown }> }>;
  };
  const lockedWorkerPaths = Object.values(lock.components ?? {})
    .flatMap((component) => component.files ?? [])
    .map((entry) => entry.path)
    .filter((entry): entry is string => typeof entry === 'string')
    .sort();
  assert.deepEqual(
    packedWorkerPaths,
    lockedWorkerPaths,
    'the physical npm workers/ inventory must equal the runtime lock exactly'
  );
  assert.ok(
    packedWorkerPaths.every((entry) => !entry.endsWith('/.stamp')),
    'runtime materialization stamps must not be published'
  );
});

test('JavaScript project worker embeds only the generated Harness version', async () => {
  const manifest = JSON.parse(
    await readFile(join(ROOT, 'package.json'), 'utf8')
  ) as { version?: unknown };
  assert.equal(typeof manifest.version, 'string');
  const worker = await readFile(
    join(ROOT, 'workers', 'javascript', 'javascript-project-worker.js'),
    'utf8'
  );
  assert.doesNotMatch(worker, /release:tag-check|prepublishOnly/u);
  assert.doesNotMatch(worker, /var package_default = \{/u);
  assert.ok(
    worker.includes(
      `var TRACECODE_HARNESS_VERSION = ${JSON.stringify(manifest.version)};`
    ),
    'the worker should embed the generated root Harness version'
  );
});

test('built ESM surfaces execute through their owning authority', async () => {
  const traceKernel = await import(
    pathToFileURL(join(ROOT, 'dist/tracekernel.js')).href
  );
  const judge = await import(pathToFileURL(join(ROOT, 'dist/judge.js')).href);

  assert.equal(typeof traceKernel.createBrowserWorkspace, 'function');
  assert.equal(typeof traceKernel.createRuntimeWorkspace, 'function');
  assert.equal(typeof traceKernel.makeTraceKernelHost, 'function');
  assert.equal(typeof judge.createBrowserJudgeHost, 'function');
  assert.equal(typeof judge.evaluateJudgePlan, 'function');

  const workspace = await traceKernel.createRuntimeWorkspace({
    files: [{ path: 'surface.txt', contents: 'simple\\n' }],
  });
  try {
    const result = await workspace.runCommand('cat surface.txt');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'simple\\n');
  } finally {
    await workspace.destroy();
  }
});

test('installed package resolves both module systems and rejects retired paths', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tracecode-surface-'));
  try {
    const scope = join(fixture, 'node_modules', '@tracecode');
    await mkdir(scope, { recursive: true });
    await symlink(ROOT, join(scope, 'harness'), 'dir');
    await writeFile(
      join(fixture, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
      'utf8'
    );

    const esm = runNode(
      fixture,
      `
        import * as tracekernel from '@tracecode/harness/tracekernel';
        import * as judge from '@tracecode/harness/judge';
        if (typeof tracekernel.createBrowserWorkspace !== 'function') throw new Error('missing TraceKernel browser workspace');
        if (typeof tracekernel.createRuntimeWorkspace !== 'function') throw new Error('missing TraceKernel workspace');
        if (typeof judge.createBrowserJudgeHost !== 'function') throw new Error('missing Judge host');
      `,
      true
    );
    assert.equal(esm.status, 0, `${esm.stdout}\n${esm.stderr}`);

    const cjs = runNode(
      fixture,
      `
        const tracekernel = require('@tracecode/harness/tracekernel');
        const judge = require('@tracecode/harness/judge');
        if (typeof tracekernel.createBrowserWorkspace !== 'function') throw new Error('missing TraceKernel browser workspace');
        if (typeof judge.createBrowserJudgeHost !== 'function') throw new Error('missing Judge host');
      `
    );
    assert.equal(cjs.status, 0, `${cjs.stdout}\n${cjs.stderr}`);

    for (const retired of RETIRED_EXPORTS) {
      const specifier =
        retired === '.'
          ? '@tracecode/harness'
          : `@tracecode/harness/${retired.slice(2)}`;
      const rejected = runNode(
        fixture,
        `import(${JSON.stringify(specifier)}).then(
          () => process.exit(2),
          (error) => {
            if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
              console.error(error);
              process.exit(3);
            }
          }
        )`,
        true
      );
      assert.equal(
        rejected.status,
        0,
        `${specifier} unexpectedly resolved:\n${rejected.stdout}\n${rejected.stderr}`
      );
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('public TypeScript declarations are consumable without internal imports', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tracecode-types-'));
  try {
    const scope = join(fixture, 'node_modules', '@tracecode');
    await mkdir(scope, { recursive: true });
    await symlink(ROOT, join(scope, 'harness'), 'dir');
    await writeFile(
      join(fixture, 'consumer.ts'),
      `
        import {
          createBrowserWorkspace,
          createRuntimeWorkspace,
          type CreateBrowserWorkspaceOptions,
        } from '@tracecode/harness/tracekernel';
        import {
          DEFAULT_INTERACTIVE_EXECUTION_IDLE_TIMEOUT_MS,
          createBrowserJudgeHost,
          type BrowserJudgeExecuteRequest,
          type CreateBrowserJudgeOptions,
        } from '@tracecode/harness/judge';

        void createBrowserWorkspace;
        void createRuntimeWorkspace;
        void createBrowserJudgeHost;
        void DEFAULT_INTERACTIVE_EXECUTION_IDLE_TIMEOUT_MS;
        const workspaceOptions: CreateBrowserWorkspaceOptions = {};
        const judgeOptions = null as CreateBrowserJudgeOptions | null;
        const executeRequest = null as BrowserJudgeExecuteRequest | null;
        void workspaceOptions;
        void judgeOptions;
        void executeRequest;
      `,
      'utf8'
    );
    await writeFile(
      join(fixture, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        },
        include: ['consumer.ts'],
      }),
      'utf8'
    );

    const tsc = spawnSync(
      resolve(ROOT, 'node_modules/.bin/tsc'),
      ['-p', 'tsconfig.json'],
      { cwd: fixture, encoding: 'utf8' }
    );
    assert.equal(tsc.status, 0, `${tsc.stdout}\n${tsc.stderr}`);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('root package remains the only publishable workspace', async () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/check-publish-safety.mjs'],
    { cwd: ROOT, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stdout,
    /@tracecode\/harness is the only publishable workspace manifest/u
  );

  for (const entrypoint of PUBLIC_CODE_EXPORTS) {
    assert.ok(entrypoint in JSON.parse(
      await readFile(join(ROOT, 'package.json'), 'utf8')
    ).exports);
  }
});

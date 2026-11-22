#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { bundleServerEntries, inspectServerClosures } from './packaged-server-graph';

const ROOT = process.cwd();
const PUBLIC_CODE_EXPORTS = [
  './judge', './judge/browser', './tracekernel', './tracekernel/browser', './tracekernel/workspace',
] as const;
const MOVED = {
  './judge/browser': [
    'createBrowserJudgeHost', 'createBrowserProjectJudge',
    'BROWSER_WORKER_LIFECYCLE_POLICIES', 'DEFAULT_INTERACTIVE_EXECUTION_IDLE_TIMEOUT_MS',
  ],
  './tracekernel/browser': [
    'createBrowserWorkspace', 'createIndexedDbKernelStorage', 'createBrowserExecutionWorkerHost',
    'installBrowserExecutionWorkerHost', 'createBrowserRuntimeEnvironment', 'createPythonAnalysisClient',
  ],
  './tracekernel/workspace': [
    'RuntimeProjectWorkspace', 'createRuntimeWorkspace', 'JustBashRuntimeWorkspace',
    'RuntimeProjectWorkspaceTerminalSession', 'createPackageManagerProjectCommands',
    'syntheticIp', 'syntheticLatency', 'RUNTIME_WORKSPACE_DEFAULT_MAX_BYTES',
    'RUNTIME_WORKSPACE_DEFAULT_MAX_ENTRY_COUNT', 'RUNTIME_WORKSPACE_DEFAULT_MAX_FILE_BYTES',
    'normalizeRuntimeWorkspaceStorageLimits', 'createPythonProjectCommands',
    'createNodeProjectCommands', 'createTypeScriptProjectCommands', 'createJavaProjectCommands',
    'createCppProjectCommands', 'createCSharpProjectCommands',
  ],
} as const;

const fixture = await mkdtemp(join(tmpdir(), 'tracecode-packed-surface-'));
after(() => rm(fixture, { recursive: true, force: true }));
const packedRoot = join(fixture, 'node_modules', '@tracecode', 'harness');
let packed: Promise<{ files: { path: string }[] }> | undefined;

function packedPackage() {
  return packed ??= (async () => {
    const pack = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', fixture],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
    );
    assert.equal(pack.status, 0, `${pack.stdout}\n${pack.stderr}`);
    const [tarball] = JSON.parse(pack.stdout) as {
      filename: string;
      files: { path: string }[];
    }[];
    await mkdir(packedRoot, { recursive: true });
    const extract = spawnSync('tar', [
      '-xf', join(fixture, tarball.filename), '-C', packedRoot, '--strip-components=1',
    ], { encoding: 'utf8' });
    assert.equal(extract.status, 0, extract.stderr);
    const { dependencies } = JSON.parse(await readFile(join(packedRoot, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(dependencies)) {
      const target = join(fixture, 'node_modules', dependency);
      await mkdir(dirname(target), { recursive: true });
      await symlink(await realpath(join(ROOT, 'node_modules', dependency)), target, 'dir');
    }
    return tarball;
  })();
}
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

test('published package exposes the five entrypoints', async () => {
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
    [...PUBLIC_CODE_EXPORTS, './package.json', './runtime-assets.lock.json'].sort()
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
  const browserJudgeTypes = await readFile(join(ROOT, 'dist/judge/browser.d.ts'), 'utf8');
  assert.doesNotMatch(traceKernelTypes, /createBrowserWorkspace/u);
  assert.doesNotMatch(traceKernelTypes, /createBrowserRuntimeHost/u);
  assert.doesNotMatch(judgeTypes, /createBrowserJudgeHost/u);
  assert.match(judgeTypes, /createJudge/u);
  assert.match(browserJudgeTypes, /BrowserJudgeExecuteRequest/u);
  assert.match(browserJudgeTypes, /disposeExecution/u);
  assert.match(browserJudgeTypes, /interactiveExecutionIdleTimeoutMs/u);
  assert.match(browserJudgeTypes, /DEFAULT_INTERACTIVE_EXECUTION_IDLE_TIMEOUT_MS/u);
  assert.doesNotMatch(browserJudgeTypes, /createBrowserRuntimeJudge/u);
  assert.doesNotMatch(browserJudgeTypes, /createBrowserJudgeHostFromRuntimeHost/u);
});

test('published worker inventory exactly matches the runtime asset lock', async () => {
  const packedWorkerPaths = (await packedPackage()).files
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

test('server entry closures contain no browser execution or workspace implementation', async () => {
  const reports = await inspectServerClosures(join(ROOT, 'dist'));
  for (const { entry, modules, violations } of reports) {
    console.log(`dist/${entry}: ${modules.length} modules, ${violations.length} violations`);
  }
  assert.deepEqual(reports.flatMap(({ entry, violations }) =>
    violations.map((violation) => `${entry}: ${violation}`)
  ), []);
});

test('packed server entries bundle under workerd conditions without browser execution', async () => {
  await packedPackage();
  const { bytes, violations } = await bundleServerEntries(fixture);
  console.log(`Packed workerd bundle: ${bytes} bytes`);
  assert.deepEqual(violations, []);
});

test('the packed entries load in Node ESM and CommonJS', async () => {
  await packedPackage();
  const check = `
    const entries = ${JSON.stringify(PUBLIC_CODE_EXPORTS)};
    const moved = ${JSON.stringify(MOVED)};
    const api = {};
    for (const entry of entries) {
      api[entry] = await load('@tracecode/harness/' + entry.slice(2));
    }
    for (const [entry, names] of Object.entries(moved)) {
      const original = entry.startsWith('./judge') ? './judge' : './tracekernel';
      for (const name of names) {
        if (!(name in api[entry])) throw new Error(entry + ' missing ' + name);
        if (name in api[original]) throw new Error(original + ' still exports ' + name);
      }
    }
    if (typeof api['./judge'].evaluateJudgePlan !== 'function') throw new Error('missing Judge evaluator');
    if (typeof api['./tracekernel'].makeTraceKernelHost !== 'function') throw new Error('missing kernel');
    const workspace = await api['./tracekernel/workspace'].createRuntimeWorkspace({
      files: [{ path: 'surface.txt', contents: 'simple' }],
    });
    try {
      const result = await workspace.runCommand('cat surface.txt');
      if (result.exitCode !== 0 || result.stdout !== 'simple') throw new Error(JSON.stringify(result));
    } finally {
      await workspace.destroy();
    }
    const lock = await readLock();
    if (lock.schema !== 'tracecode.runtime-assets-lock.v1' ||
        !Number.isSafeInteger(lock.stagedInventory?.files) ||
        !Number.isSafeInteger(lock.stagedInventory?.bytes)) throw new Error('invalid packed asset lock');
  `;
  const esm = runNode(fixture, `
    import { createRequire } from 'node:module';
    const load = (specifier) => import(specifier);
    const readLock = () => createRequire(import.meta.url)('@tracecode/harness/runtime-assets.lock.json');
    ${check}
  `, true);
  assert.equal(esm.status, 0, `${esm.stdout}\n${esm.stderr}`);
  const cjs = runNode(fixture, `
    (async () => {
      const load = require;
      const readLock = () => require('@tracecode/harness/runtime-assets.lock.json');
      ${check}
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `);
  assert.equal(cjs.status, 0, `${cjs.stdout}\n${cjs.stderr}`);

  for (const retired of RETIRED_EXPORTS) {
    const specifier = retired === '.' ? '@tracecode/harness' : `@tracecode/harness/${retired.slice(2)}`;
    const rejected = runNode(fixture, `
      try {
        await import(${JSON.stringify(specifier)});
        process.exitCode = 2;
      } catch (error) {
        if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
      }
    `, true);
    assert.equal(rejected.status, 0, `${specifier}: ${rejected.stdout}\n${rejected.stderr}`);
  }
});

test('packed declarations resolve for all five entries in both module systems', async () => {
  await packedPackage();
  const imports = `
    import { makeTraceKernelHost, type CreateRuntimeWorkspaceOptions } from '@tracecode/harness/tracekernel';
    import { createBrowserWorkspace, type CreateBrowserWorkspaceOptions } from '@tracecode/harness/tracekernel/browser';
    import { createRuntimeWorkspace } from '@tracecode/harness/tracekernel/workspace';
    import { evaluateJudgePlan, type JudgeEvaluationPlan } from '@tracecode/harness/judge';
    import { createBrowserJudgeHost, type BrowserJudgeExecuteRequest } from '@tracecode/harness/judge/browser';
    const workspaceOptions: CreateRuntimeWorkspaceOptions = {};
    const browserOptions: CreateBrowserWorkspaceOptions = {};
    void [makeTraceKernelHost, createRuntimeWorkspace(workspaceOptions),
      createBrowserWorkspace(browserOptions), evaluateJudgePlan, createBrowserJudgeHost];
    void (null as JudgeEvaluationPlan<unknown, unknown> | BrowserJudgeExecuteRequest | null);
    // @ts-expect-error Browser host moved to the browser entry
    import type { BrowserJudgeExecuteRequest as RetiredJudgeRequest } from '@tracecode/harness/judge';
    // @ts-expect-error Browser options moved to the browser entry
    import type { CreateBrowserWorkspaceOptions as RetiredWorkspaceOptions } from '@tracecode/harness/tracekernel';
  `;
  await Promise.all([
    writeFile(join(fixture, 'consumer.mts'), imports),
    writeFile(join(fixture, 'consumer.cts'), imports),
  ]);
  await writeFile(join(fixture, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022', 'DOM'],
      module: 'NodeNext',
      strict: true,
      noEmit: true,
    },
    include: ['consumer.mts', 'consumer.cts'],
  }));
  const tsc = spawnSync(resolve(ROOT, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], {
    cwd: fixture, encoding: 'utf8',
  });
  assert.equal(tsc.status, 0, `${tsc.stdout}\n${tsc.stderr}`);
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

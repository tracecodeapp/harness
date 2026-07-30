import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildTestPlan,
  resolveTestCapacity,
  runTaskPhase,
  selectRunnableTaskIndex,
  type TestTask,
} from '../scripts/run-test-suite';

const ORIGINAL_ALL_SCRIPTS = [
  'test:runtime-info-sync',
  'test:kernel-policy-sync',
  'test:typescript-project-libs-sync',
  'test:publish-safety',
  'test:contracts-public-surface',
  'test:python-public-surface',
  'test:java-public-surface',
  'test:csharp-public-surface',
  'test:cpp-public-surface',
  'typecheck',
  'test:trace-adapters',
  'test:sql-trace',
  'test:sql-trace-fixtures',
  'test:sql-browser-example',
  'test:python-sync',
  'test:python-runtime',
  'test:python-prepared-provider',
  'test:python-browser-worker',
  'test:python-worker-client-http',
  'test:java-sync',
  'test:java-runtime',
  'test:csharp-runtime',
  'test:csharp-worker-browser',
  'test:cpp-rewriter',
  'test:cpp-script-lambda-trace',
  'test:cpp-runtime',
  'test:js-runtime',
  'test:project',
  'test:runtime-contract',
  'test:judge',
  'test:runtime-execution-judge',
  'test:prepared-provider-release-gate',
  'test:native-harness',
  'test:runtime-trace',
  'test:standalone-boundary',
  'build',
  'test:packaged-surface',
  'test:language-packages',
  'test:sql-package-surface',
  'test:smoke',
  'test:browser-runtime-host',
  'test:asset-sync',
  'test:example-app',
  'test:java-example-app',
  'test:project-ide-example',
  'test:project-terminal-example',
  'test:example-app-packaged',
  'test:java-example-app-packaged',
] as const;

const scriptsFor = (profile: 'all' | 'ci'): string[] =>
  buildTestPlan(profile).flatMap((phase) => phase.tasks.map((entry) => entry.script));

test('parallel test plan retains every test from the serial full gate exactly once', () => {
  const actual = scriptsFor('all');
  assert.equal(new Set(actual).size, actual.length, 'test plan must not contain duplicate scripts');
  for (const script of ORIGINAL_ALL_SCRIPTS) {
    assert.ok(actual.includes(script), `missing ${script}`);
  }
  assert.deepEqual(
    actual.filter((script) => script !== 'test:test-suite-runner').sort(),
    [...ORIGINAL_ALL_SCRIPTS].sort()
  );
});

test('CI profile excludes only browser examples and full-package examples', () => {
  const actual = scriptsFor('ci');
  const fullOnly = [
    'test:sql-browser-example',
    'test:browser-runtime-host',
    'test:example-app',
    'test:java-example-app',
    'test:project-ide-example',
    'test:project-terminal-example',
    'test:example-app-packaged',
    'test:java-example-app-packaged',
  ];
  for (const script of fullOnly) assert.ok(!actual.includes(script), `${script} should be full-gate only`);
  for (const script of ORIGINAL_ALL_SCRIPTS) {
    if (!fullOnly.includes(script)) assert.ok(actual.includes(script), `CI is missing ${script}`);
  }
});

test('capacity defaults are conservative and can be overridden', () => {
  assert.equal(resolveTestCapacity(undefined, { ci: false, parallelism: 10 }), 4);
  assert.equal(resolveTestCapacity(undefined, { ci: true, parallelism: 10 }), 2);
  assert.equal(resolveTestCapacity(undefined, { ci: true, parallelism: 1 }), 1);
  assert.equal(resolveTestCapacity('7', { ci: true, parallelism: 1 }), 7);
  assert.throws(() => resolveTestCapacity('0'), /positive integer/);
  assert.throws(() => resolveTestCapacity('many'), /positive integer/);
});

test('scheduler can backfill a light task when the next heavy task does not fit', () => {
  const pending: TestTask[] = [
    { script: 'heavy', weight: 2 },
    { script: 'light', weight: 1 },
  ];
  assert.equal(selectRunnableTaskIndex(pending, 2, 3), 1);
});

test('exclusive tasks consume the full scheduler capacity', () => {
  const pending: TestTask[] = [
    { script: 'exclusive', exclusive: true },
    { script: 'light', weight: 1 },
  ];
  assert.equal(selectRunnableTaskIndex(pending, 1, 4), 1);
  assert.equal(selectRunnableTaskIndex(pending, 0, 4), 0);
  assert.equal(selectRunnableTaskIndex([{ script: 'light', weight: 1 }], 4, 4), -1);
});

test('tasks that mutate the same named resource never overlap', () => {
  const pending: TestTask[] = [
    { script: 'same-resource', resources: ['example:web-ide'] },
    { script: 'independent', resources: ['example:project-ide'] },
  ];
  assert.equal(
    selectRunnableTaskIndex(
      pending,
      1,
      4,
      [{ script: 'running', resources: ['example:web-ide'] }]
    ),
    1
  );
});

test('scheduler never exceeds weighted capacity', async () => {
  const tasks: TestTask[] = [
    { script: 'heavy-a', weight: 2 },
    { script: 'heavy-b', weight: 2 },
    { script: 'light-a', weight: 1 },
    { script: 'light-b', weight: 1 },
  ];
  let activeWeight = 0;
  let peakWeight = 0;
  const completed = await runTaskPhase(tasks, {
    capacity: 3,
    async runTask(entry) {
      const weight = entry.weight ?? 1;
      activeWeight += weight;
      peakWeight = Math.max(peakWeight, activeWeight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeWeight -= weight;
      return { task: entry, durationMs: 5 };
    },
  });
  assert.equal(completed.length, tasks.length);
  assert.ok(peakWeight <= 3, `weighted concurrency peaked at ${peakWeight}`);
});

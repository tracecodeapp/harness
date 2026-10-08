import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';

import {
  buildTestPlan,
  executePackageScript,
  describeRunningTask,
  resolveTaskTimeout,
  DEFAULT_TASK_TIMEOUT_MS,
  parseArguments,
  resolveTestCapacity,
  runTaskPhase,
  selectRunnableTaskIndex,
  type TestTask,
} from '../scripts/run-test-suite';

const ORIGINAL_ALL_SCRIPTS = [
  'test:runtime-info-sync',
  'test:runtime-assets-lock',
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
  'test:java-prepared-provider:browser',
  'test:csharp-runtime',
  'test:csharp-worker-browser',
  'test:cpp-rewriter',
  'test:js-runtime',
  'test:project',
  'test:runtime-contract',
  'test:judge',
  'test:tracekernel-capabilities',
  'test:runtime-execution-judge',
  'test:prepared-provider-release-gate',
  'test:terminal-executable-restoration',
  'test:native-harness',
  'test:runtime-trace',
  'test:tracecc',
  'test:standalone-boundary',
  'build',
  'test:cpp-prepared-lifecycle',
  'test:tracecc-browser',
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
    'test:java-prepared-provider:browser',
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

test('phase selection resumes from a stable phase ID', () => {
  const phases = buildTestPlan('all', { from: 'heavy-runtime' });
  assert.deepEqual(phases.map((phase) => phase.id), ['heavy-runtime', 'build', 'packaged']);
  assert.ok(phases[0].tasks.some((entry) => entry.script === 'test:csharp-worker-browser'));
  assert.ok(!phases.some((phase) => phase.tasks.some((entry) => entry.script === 'typecheck')));
});

test('only selection accepts phase IDs and package scripts', () => {
  const phase = buildTestPlan('all', { only: ['fast-runtime-contracts'] });
  assert.deepEqual(phase.map((entry) => entry.id), ['fast-runtime-contracts']);
  assert.ok(phase[0].tasks.length > 1);

  const task = buildTestPlan('all', { only: ['test:native-harness'] });
  assert.deepEqual(task.map((entry) => entry.id), ['fast-runtime-contracts']);
  assert.deepEqual(task[0].tasks.map((entry) => entry.script), ['test:native-harness']);

  const redundant = buildTestPlan('all', {
    only: ['fast-runtime-contracts', 'test:native-harness'],
  });
  assert.deepEqual(redundant.map((entry) => entry.id), ['fast-runtime-contracts']);

  assert.throws(
    () => buildTestPlan('all', { only: ['does-not-exist'] }),
    /Unknown --only selector/
  );
  assert.throws(
    () => buildTestPlan('all', { from: 'preflight', only: ['build'] }),
    /cannot be combined/
  );
});

test('CLI arguments expose selection and keep-going explicitly', () => {
  assert.deepEqual(
    parseArguments(['--ci', '--from=heavy-runtime', '--keep-going', '--jobs=2']),
    {
      profile: 'ci',
      list: false,
      keepGoing: true,
      jobs: '2',
      selection: { from: 'heavy-runtime' },
    }
  );
  assert.deepEqual(
    parseArguments(['--only=test:native-harness,build', '--list']),
    {
      profile: 'all',
      list: true,
      keepGoing: false,
      jobs: undefined,
      selection: { only: ['test:native-harness', 'build'] },
    }
  );
  assert.throws(() => parseArguments(['--only=']), /requires/);
  assert.throws(() => parseArguments(['--from=preflight', '--only=build']), /cannot be combined/);
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


function controlledClock() {
  let now = 0;
  const timers = new Set<{ callback: () => void; due: number }>();
  return {
    now: () => now,
    schedule(callback: () => void, delayMs: number) {
      const timer = { callback, due: now + delayMs };
      timers.add(timer);
      return () => { timers.delete(timer); };
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter((timer) => timer.due <= end).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        timers.delete(next);
        now = next.due;
        next.callback();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

test('task deadlines default conservatively and reject non-finite overrides', () => {
  assert.equal(DEFAULT_TASK_TIMEOUT_MS, 20 * 60_000);
  assert.equal(resolveTaskTimeout('1800000'), 30 * 60_000);
  for (const invalid of ['', '0', '-1', 'Infinity', '1.5', '10ms', '2147483648']) {
    assert.throws(() => resolveTaskTimeout(invalid), /positive integer/);
  }
});

test('real subprocess success and nonzero exit keep their results', { timeout: 10_000 }, async () => {
  const clock = controlledClock();
  await executePackageScript(process.cwd(), { script: 'controlled-success' }, new AbortController().signal, {
    command: process.execPath, args: ['-e', 'console.log("success")'], clock,
  });
  await assert.rejects(executePackageScript(process.cwd(), { script: 'controlled-failure' }, new AbortController().signal, {
    command: process.execPath, args: ['-e', 'process.exit(7)'], clock,
  }), /controlled-failure failed.*exit 7/);
  assert.equal(clock.pending(), 0);
});

for (const reason of ['deadline', 'abort'] as const) {
  test(`${reason} escalates a TERM-resistant real subprocess to KILL without sleeping`, { timeout: 10_000, skip: process.platform === 'win32' }, async () => {
    const clock = controlledClock();
    const controller = new AbortController();
    const entry = { script: `controlled-${reason}` };
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    let pid = 0;
    const execution = executePackageScript(process.cwd(), entry, controller.signal, {
      command: process.execPath,
      args: ['-e', 'process.on("SIGTERM", () => {}); console.log(process.pid); setInterval(() => {}, 1000000);'],
      timeoutMs: 1000,
      clock,
      onOutput(chunk) { pid = Number(chunk.trim()); ready(); },
    });
    // Attach rejection handling before triggering fake-clock cancellation.
    const rejected = assert.rejects(execution, reason === 'deadline' ? /controlled-deadline exceeded.*1.0s.*after 1.0s/ : /controlled-abort aborted after/);
    await started;
    clock.advance(400);
    assert.match(describeRunningTask(entry, clock.now()), /elapsed 0.4s, last output 0.4s ago/);
    if (reason === 'deadline') clock.advance(600);
    else controller.abort();
    clock.advance(5000);
    await rejected;
    assert.equal(clock.pending(), 0);
    assert.equal(describeRunningTask(entry), entry.script);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });
}

test('already-aborted execution never launches a subprocess', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executePackageScript(process.cwd(), { script: 'never-launch' }, controller.signal, {
    command: '/does/not/exist',
  }), /aborted before launch/);
});


test('termination is bounded even when a child never emits close', { timeout: 10_000 }, async () => {
  const clock = controlledClock();
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough; stderr: PassThrough; unref(): void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let unreferenced = false;
  child.unref = () => { unreferenced = true; };
  const execution = executePackageScript(process.cwd(), { script: 'unreaped' }, new AbortController().signal, {
    timeoutMs: 1000, clock,
    spawnProcess: (() => child) as unknown as typeof spawn,
  });
  const rejected = assert.rejects(execution, /unreaped exceeded.*process did not close within 10.0s termination grace/);
  clock.advance(11_000);
  await rejected;
  assert.equal(unreferenced, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(clock.pending(), 0);
});

test('a cooperative zero-exit abort remains a failure', { timeout: 10_000, skip: process.platform === 'win32' }, async () => {
  const clock = controlledClock();
  const controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const execution = executePackageScript(process.cwd(), { script: 'cooperative-abort' }, controller.signal, {
    command: process.execPath,
    args: ['-e', 'process.on("SIGTERM", () => process.exit(0)); console.log("ready"); setInterval(() => {}, 1000000);'],
    clock, onOutput: () => ready(),
  });
  const rejected = assert.rejects(execution, /cooperative-abort aborted/);
  await started;
  controller.abort();
  await rejected;
  assert.equal(clock.pending(), 0);
});

test('spawn errors cancel task timers', { timeout: 10_000 }, async () => {
  const clock = controlledClock();
  await assert.rejects(executePackageScript(process.cwd(), { script: 'spawn-error' }, new AbortController().signal, {
    command: '/does/not/exist', clock,
  }), /ENOENT/);
  assert.equal(clock.pending(), 0);
});

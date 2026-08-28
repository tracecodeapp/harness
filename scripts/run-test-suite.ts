#!/usr/bin/env npx tsx

import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export type TestProfile = 'all' | 'ci';

export interface TestTask {
  script: string;
  weight?: number;
  exclusive?: boolean;
  resources?: string[];
  profiles?: TestProfile[];
}

export interface TestPhase {
  id: string;
  name: string;
  tasks: TestTask[];
  capacity?: number;
}

export interface TaskResult {
  task: TestTask;
  durationMs: number;
  error?: Error;
}

export interface TestPlanSelection {
  from?: string;
  only?: string[];
}

interface RunPhaseOptions {
  capacity: number;
  runTask: (task: TestTask, signal: AbortSignal) => Promise<TaskResult>;
  signal?: AbortSignal;
  heartbeatMs?: number;
  onHeartbeat?: (running: TestTask[]) => void;
}

const BOTH: TestProfile[] = ['all', 'ci'];

const task = (
  script: string,
  weight = 1,
  profiles: TestProfile[] = BOTH
): TestTask => ({ script, weight, profiles });

/**
 * The suite is deliberately split at cost and mutation boundaries. Fast
 * source/contract checks run before compiler and browser work. The build phase
 * regenerates and bundles artifacts, so packaged-surface tests cannot overlap
 * it.
 */
export const TEST_PHASES: TestPhase[] = [
  {
    id: 'preflight',
    name: 'preflight',
    tasks: [
      task('test:test-suite-runner'),
      task('test:runtime-info-sync'),
      task('test:runtime-assets-lock'),
      task('test:kernel-policy-sync'),
      task('test:typescript-project-libs-sync'),
      task('test:python-sync'),
      task('test:java-sync'),
      task('test:publish-safety'),
      task('test:contracts-public-surface'),
      task('test:python-public-surface'),
      task('test:java-public-surface'),
      task('test:csharp-public-surface'),
      task('test:cpp-public-surface'),
      task('typecheck', 2),
    ],
  },
  {
    id: 'fast-runtime-contracts',
    name: 'fast runtime contracts',
    tasks: [
      task('test:js-runtime'),
      task('test:cpp-rewriter'),
      task('test:trace-adapters'),
      task('test:sql-trace'),
      task('test:sql-trace-fixtures'),
      task('test:runtime-contract'),
      task('test:judge'),
      task('test:tracekernel-capabilities'),
      task('test:runtime-execution-judge'),
      task('test:prepared-provider-release-gate'),
      task('test:native-harness'),
      task('test:standalone-boundary'),
    ],
  },
  {
    id: 'heavy-runtime',
    name: 'heavy runtime and browser tests',
    tasks: [
      // The two longest gates are isolated compiler processes. Running them in
      // the two heavyweight slots removes almost seven minutes of idle wall
      // time without sharing a VM, worker, filesystem, or browser.
      task('test:runtime-trace', 2),
      task('test:tracecc', 2),
      task('test:java-runtime', 2),
      task('test:java-prepared-provider:browser', 2, ['all']),
      task('test:csharp-runtime', 2),
      task('test:csharp-worker-browser', 2),
      // Project owns timing-sensitive worker/listener integration tests. Under
      // compiler saturation their real registration deadline becomes a test of
      // the host scheduler instead of TraceKernel, so keep this gate exclusive.
      { ...task('test:project', 2), exclusive: true },
      task('test:python-runtime'),
      task('test:python-prepared-provider', 2),
      task('test:python-browser-worker'),
      task('test:python-worker-client-http'),
      task('test:sql-browser-example', 1, ['all']),
    ],
  },
  {
    id: 'build',
    name: 'build',
    capacity: 1,
    tasks: [task('build')],
  },
  {
    id: 'packaged',
    name: 'packaged and example tests',
    tasks: [
      task('test:cpp-prepared-lifecycle', 2),
      task('test:tracecc-browser', 2),
      task('test:browser-runtime-host', 2, ['all']),
      task('test:java-example-app-packaged', 2, ['all']),
      task('test:example-app-packaged', 2, ['all']),
      { ...task('test:java-example-app', 2, ['all']), resources: ['example:web-ide'] },
      task('test:project-ide-example', 2, ['all']),
      task('test:project-terminal-example', 2, ['all']),
      { ...task('test:example-app', 2, ['all']), resources: ['example:web-ide'] },
      task('test:packaged-surface'),
      task('test:language-packages'),
      task('test:sql-package-surface'),
      task('test:smoke'),
      task('test:asset-sync'),
    ],
  },
];

function matchesPhase(phase: TestPhase, selector: string): boolean {
  return phase.id === selector || phase.name === selector;
}

export function buildTestPlan(
  profile: TestProfile,
  selection: TestPlanSelection = {}
): TestPhase[] {
  if (selection.from && selection.only?.length) {
    throw new Error('--from and --only cannot be combined.');
  }

  let phases = TEST_PHASES.map((phase) => ({
    ...phase,
    tasks: phase.tasks.filter((entry) => entry.profiles?.includes(profile) ?? true),
  })).filter((phase) => phase.tasks.length > 0);

  if (selection.from) {
    const index = phases.findIndex((phase) => matchesPhase(phase, selection.from!));
    if (index === -1) {
      throw new Error(`Unknown test phase for --from: ${selection.from}.`);
    }
    phases = phases.slice(index);
  }

  if (selection.only?.length) {
    const unmatched = new Set(selection.only);
    phases = phases.flatMap((phase) => {
      const phaseSelected = selection.only!.some((selector) => matchesPhase(phase, selector));
      if (phaseSelected) {
        for (const selector of selection.only!) {
          if (
            matchesPhase(phase, selector) ||
            phase.tasks.some((entry) => entry.script === selector)
          ) {
            unmatched.delete(selector);
          }
        }
        return [phase];
      }
      const tasks = phase.tasks.filter((entry) => {
        if (!selection.only!.includes(entry.script)) return false;
        unmatched.delete(entry.script);
        return true;
      });
      return tasks.length > 0 ? [{ ...phase, tasks }] : [];
    });
    if (unmatched.size > 0) {
      throw new Error(`Unknown --only selector(s): ${[...unmatched].join(', ')}.`);
    }
  }

  return phases;
}

export function resolveTestCapacity(
  requested: string | undefined,
  options: { ci?: boolean; parallelism?: number } = {}
): number {
  if (requested !== undefined) {
    const parsed = Number.parseInt(requested, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`TRACECODE_TEST_JOBS must be a positive integer, received ${JSON.stringify(requested)}.`);
    }
    return parsed;
  }
  const parallelism = options.parallelism ?? availableParallelism();
  return options.ci ? Math.max(1, Math.min(2, parallelism)) : Math.max(2, Math.min(4, Math.floor(parallelism / 2)));
}

function taskWeight(entry: TestTask, capacity: number): number {
  if (entry.exclusive) return capacity;
  return Math.min(Math.max(1, entry.weight ?? 1), capacity);
}

export function selectRunnableTaskIndex(
  pending: TestTask[],
  usedCapacity: number,
  capacity: number,
  running: TestTask[] = []
): number {
  const lockedResources = new Set(running.flatMap((entry) => entry.resources ?? []));
  return pending.findIndex((entry) =>
    usedCapacity + taskWeight(entry, capacity) <= capacity &&
    !(entry.resources ?? []).some((resource) => lockedResources.has(resource))
  );
}

export async function runTaskPhase(
  tasks: TestTask[],
  options: RunPhaseOptions
): Promise<TaskResult[]> {
  const pending = [...tasks];
  const running = new Map<Promise<TaskResult>, TestTask>();
  const results: TaskResult[] = [];
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortFromParent, { once: true });
  const heartbeat = options.heartbeatMs && options.onHeartbeat
    ? setInterval(() => {
        if (running.size > 0) options.onHeartbeat?.([...running.values()]);
      }, options.heartbeatMs)
    : undefined;

  try {
    while (pending.length > 0 || running.size > 0) {
      if (controller.signal.aborted) {
        await Promise.allSettled(running.keys());
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error('Test suite aborted.');
      }

      let usedCapacity = [...running.values()].reduce(
        (total, entry) => total + taskWeight(entry, options.capacity),
        0
      );
      let nextIndex = selectRunnableTaskIndex(
        pending,
        usedCapacity,
        options.capacity,
        [...running.values()]
      );
      while (nextIndex !== -1 && !controller.signal.aborted) {
        const [next] = pending.splice(nextIndex, 1);
        const execution = options.runTask(next, controller.signal);
        running.set(execution, next);
        usedCapacity += taskWeight(next, options.capacity);
        nextIndex = selectRunnableTaskIndex(
          pending,
          usedCapacity,
          options.capacity,
          [...running.values()]
        );
      }

      if (running.size === 0) {
        continue;
      }

      try {
        const completed = await Promise.race(running.keys());
        // Promise.race does not identify its source promise, so remove the one
        // whose task matches the unique task carried in the result.
        const source = [...running.entries()].find(([, entry]) => entry === completed.task)?.[0];
        if (source) running.delete(source);
        else throw new Error(`Test scheduler lost the completed task ${completed.task.script}.`);
        results.push(completed);
      } catch (error) {
        controller.abort(error);
        await Promise.allSettled(running.keys());
        throw error;
      }
    }
    return results;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    options.signal?.removeEventListener('abort', abortFromParent);
  }
}

function createPrefixedWriter(label: string, target: NodeJS.WriteStream): {
  write: (chunk: Buffer | string) => void;
  flush: () => void;
} {
  let buffered = '';
  const emit = (line: string) => target.write(`[${label}] ${line}\n`);
  return {
    write(chunk) {
      buffered += chunk.toString().replaceAll('\r', '\n');
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) emit(line);
    },
    flush() {
      if (buffered) emit(buffered);
      buffered = '';
    },
  };
}

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

async function executePackageScript(
  cwd: string,
  entry: TestTask,
  signal: AbortSignal
): Promise<TaskResult> {
  const startedAt = performance.now();
  console.log(`START ${entry.script}`);
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const child = spawn(command, ['run', entry.script], {
    cwd,
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = createPrefixedWriter(entry.script, process.stdout);
  const stderr = createPrefixedWriter(entry.script, process.stderr);
  child.stdout?.on('data', stdout.write);
  child.stderr?.on('data', stderr.write);
  const abort = () => terminateProcessTree(child);
  signal.addEventListener('abort', abort, { once: true });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
  }).finally(() => {
    signal.removeEventListener('abort', abort);
    stdout.flush();
    stderr.flush();
  });

  const durationMs = performance.now() - startedAt;
  if (exit.code !== 0) {
    throw new Error(
      `${entry.script} failed after ${formatDuration(durationMs)} (${exit.signal ? `signal ${exit.signal}` : `exit ${exit.code}`}).`
    );
  }
  console.log(`PASS  ${entry.script} (${formatDuration(durationMs)})`);
  return { task: entry, durationMs };
}

function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 100) / 10;
  return `${seconds.toFixed(1)}s`;
}

async function validateScripts(cwd: string, phases: TestPhase[]): Promise<void> {
  const packageJson = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = packageJson.scripts ?? {};
  const missing = phases.flatMap((phase) => phase.tasks).filter((entry) => !scripts[entry.script]);
  if (missing.length > 0) {
    throw new Error(`Test plan references missing package scripts: ${missing.map((entry) => entry.script).join(', ')}`);
  }
}

export function parseArguments(argv: string[]): {
  profile: TestProfile;
  list: boolean;
  keepGoing: boolean;
  jobs?: string;
  selection: TestPlanSelection;
} {
  let profile: TestProfile = 'all';
  let list = false;
  let keepGoing = false;
  let jobs: string | undefined;
  let from: string | undefined;
  let only: string[] | undefined;
  for (const argument of argv) {
    if (argument === '--ci') profile = 'ci';
    else if (argument === '--all') profile = 'all';
    else if (argument === '--list') list = true;
    else if (argument === '--keep-going') keepGoing = true;
    else if (argument.startsWith('--jobs=')) jobs = argument.slice('--jobs='.length);
    else if (argument.startsWith('--from=')) from = argument.slice('--from='.length).trim();
    else if (argument.startsWith('--only=')) {
      only = argument.slice('--only='.length).split(',').map((value) => value.trim()).filter(Boolean);
    }
    else throw new Error(`Unknown test-suite argument: ${argument}`);
  }
  if (from === '') throw new Error('--from requires a phase ID.');
  if (only?.length === 0) throw new Error('--only requires a phase ID or package script.');
  if (from && only?.length) throw new Error('--from and --only cannot be combined.');
  return { profile, list, keepGoing, jobs, selection: { ...(from ? { from } : {}), ...(only ? { only } : {}) } };
}

async function main(): Promise<void> {
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { profile, list, keepGoing, jobs, selection } = parseArguments(process.argv.slice(2));
  const phases = buildTestPlan(profile, selection);
  await validateScripts(cwd, phases);
  const capacity = resolveTestCapacity(jobs ?? process.env.TRACECODE_TEST_JOBS, {
    ci: profile === 'ci' || process.env.CI === 'true',
  });

  if (list) {
    console.log(`Test profile: ${profile}; capacity: ${capacity}`);
    for (const phase of phases) {
      console.log(`${phase.id} (${phase.name}): ${phase.tasks.map((entry) => {
        const markers = [
          String(entry.weight ?? 1),
          ...(entry.exclusive ? ['exclusive'] : []),
          ...(entry.resources ?? []),
        ];
        return `${entry.script}[${markers.join(',')}]`;
      }).join(', ')}`);
    }
    return;
  }

  const suiteStartedAt = performance.now();
  const results: TaskResult[] = [];
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Test suite interrupted.'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    console.log(`Running ${profile} test profile with capacity ${capacity}${keepGoing ? ' (keep-going)' : ''}.`);
    for (const phase of phases) {
      const phaseCapacity = phase.capacity ?? capacity;
      console.log(`\n=== ${phase.id}: ${phase.name} (${phase.tasks.length} tasks; capacity ${phaseCapacity}) ===`);
      const phaseResults = await runTaskPhase(phase.tasks, {
        capacity: phaseCapacity,
        signal: controller.signal,
        runTask: async (entry, signal) => {
          const startedAt = performance.now();
          try {
            return await executePackageScript(cwd, entry, signal);
          } catch (error) {
            if (!keepGoing) throw error;
            const normalized = error instanceof Error ? error : new Error(String(error));
            const durationMs = performance.now() - startedAt;
            console.error(`FAIL  ${entry.script} (${formatDuration(durationMs)}): ${normalized.message}`);
            return { task: entry, durationMs, error: normalized };
          }
        },
        heartbeatMs: 30_000,
        onHeartbeat: (running) => {
          console.log(`RUNNING ${running.map((entry) => entry.script).join(', ')}`);
        },
      });
      results.push(...phaseResults);
      if (phaseResults.some((result) => result.error)) {
        console.error(`\nStopping after failed phase ${phase.id}; later phases may depend on it.`);
        break;
      }
    }
    const slowest = [...results].sort((left, right) => right.durationMs - left.durationMs).slice(0, 8);
    console.log('\nSlowest tasks:');
    for (const result of slowest) {
      console.log(`  ${formatDuration(result.durationMs).padStart(8)}  ${result.task.script}${result.error ? ' [failed]' : ''}`);
    }
    const failures = results.filter((result) => result.error);
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} test task(s) failed:\n${failures.map((result) => `- ${result.task.script}: ${result.error!.message}`).join('\n')}`
      );
    }
    console.log(`\nPASS: ${profile} test profile (${formatDuration(performance.now() - suiteStartedAt)})`);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

#!/usr/bin/env npx tsx

import { spawn, type SpawnOptions } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  createSnapshotReleaseLockTokenArgument,
  runSnapshotReleaseLockCommand,
} from './python-runtime-snapshot-lock.js';

interface SnapshotBuilderInvocation {
  readonly args?: readonly string[];
  readonly repositoryRoot?: string;
  readonly stdio?: SpawnOptions['stdio'];
  readonly workerPath?: string;
}

async function runUnlockedWorker(
  workerPath: string,
  args: readonly string[],
  stdio: SpawnOptions['stdio']
): Promise<void> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', workerPath, ...args],
    { env: process.env, stdio }
  );
  const result = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
  if (result.code === 0) return;
  throw new Error(
    `Python runtime snapshot worker failed with ${
      result.signal ?? `exit code ${String(result.code)}`
    }.`
  );
}

export async function runPythonRuntimeSnapshotBuilder(
  invocation: SnapshotBuilderInvocation = {}
): Promise<void> {
  const repositoryRoot = invocation.repositoryRoot ?? resolve(process.cwd());
  const args = invocation.args ?? process.argv.slice(2);
  const stdio = invocation.stdio ?? 'inherit';
  const workerPath = invocation.workerPath ?? join(
    dirname(fileURLToPath(import.meta.url)),
    'build-python-runtime-snapshot-worker.ts'
  );
  const replace = args.includes('--replace');
  if (!replace) {
    await runUnlockedWorker(workerPath, args, stdio);
    return;
  }
  await runSnapshotReleaseLockCommand({
    args: [
      '--import',
      'tsx',
      workerPath,
      createSnapshotReleaseLockTokenArgument(),
      ...args,
    ],
    command: process.execPath,
    lockPath: join(repositoryRoot, '.python-runtime-snapshot-release.lock'),
    stdio,
  });
}

const isMain = process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runPythonRuntimeSnapshotBuilder().catch((error) => {
    console.error(
      error instanceof Error ? error.stack ?? error.message : String(error)
    );
    process.exitCode = 1;
  });
}

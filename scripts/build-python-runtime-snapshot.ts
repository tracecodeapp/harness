#!/usr/bin/env npx tsx

import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPythonRuntimeSnapshotWorker } from './build-python-runtime-snapshot-worker.js';
import {
  acquireSnapshotReleaseLock,
  type SnapshotReleaseLock,
} from './python-runtime-snapshot-file-lock.js';

interface SnapshotBuilderInvocation {
  readonly args?: readonly string[];
  readonly repositoryRoot?: string;
  readonly worker?: (
    args: readonly string[],
    releaseLock?: SnapshotReleaseLock
  ) => Promise<void>;
}

export async function runPythonRuntimeSnapshotBuilder(
  invocation: SnapshotBuilderInvocation = {}
): Promise<void> {
  const repositoryRoot = invocation.repositoryRoot ?? resolve(process.cwd());
  const args = invocation.args ?? process.argv.slice(2);
  const worker = invocation.worker ?? runPythonRuntimeSnapshotWorker;
  if (!args.includes('--replace')) {
    await worker(args);
    return;
  }
  const lock = await acquireSnapshotReleaseLock(
    join(repositoryRoot, '.python-runtime-snapshot-release.lock')
  );
  try {
    await worker(args, lock);
  } finally {
    await lock.release();
  }
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

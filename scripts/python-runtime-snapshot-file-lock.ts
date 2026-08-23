import { spawn } from 'node:child_process';
import { open, type FileHandle } from 'node:fs/promises';

export class SnapshotReleaseLockUnavailableError extends Error {
  constructor(readonly lockPath: string) {
    super(`Another Python runtime snapshot replacement holds ${lockPath}.`);
    this.name = 'SnapshotReleaseLockUnavailableError';
  }
}

export interface SnapshotReleaseLock {
  readonly release: () => Promise<void>;
}

const activeSnapshotReleaseLocks = new WeakMap<SnapshotReleaseLock, string>();

export function assertSnapshotReleaseLockHeld(
  lock: SnapshotReleaseLock | undefined,
  lockPath: string
): asserts lock is SnapshotReleaseLock {
  if (lock === undefined || activeSnapshotReleaseLocks.get(lock) !== lockPath) {
    throw new Error(
      'Python runtime snapshot replacement must run through build-python-runtime-snapshot.ts with its release lock held.'
    );
  }
}

function lockInvocation(platform: NodeJS.Platform): {
  readonly args: string[];
  readonly command: string;
} {
  if (platform === 'darwin') {
    return {
      command: '/usr/bin/lockf',
      args: ['-t', '0', '3'],
    };
  }
  if (platform === 'linux') {
    return {
      command: '/usr/bin/flock',
      args: ['-E', '75', '-n', '3'],
    };
  }
  throw new Error(
    `Python runtime snapshot replacement does not support ${platform} locking.`
  );
}

async function acquireFileDescriptorLock(
  lockPath: string,
  file: FileHandle,
  platform: NodeJS.Platform
): Promise<void> {
  const invocation = lockInvocation(platform);
  const child = spawn(invocation.command, invocation.args, {
    stdio: ['ignore', 'pipe', 'pipe', file.fd],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const result = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
  if (result.code === 0) return;
  if (result.code === 75) {
    throw new SnapshotReleaseLockUnavailableError(lockPath);
  }
  throw new Error(
    `Python runtime snapshot lock failed with ${
      result.signal ?? `exit code ${String(result.code)}`
    }${stderr.trim() ? `: ${stderr.trim()}` : '.'}`
  );
}

export async function acquireSnapshotReleaseLock(
  lockPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<SnapshotReleaseLock> {
  const file = await open(lockPath, 'a+');
  try {
    await acquireFileDescriptorLock(lockPath, file, platform);
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
  let releasePromise: Promise<void> | undefined;
  const lock: SnapshotReleaseLock = {
    release: () => {
      if (releasePromise === undefined) {
        activeSnapshotReleaseLocks.delete(lock);
        releasePromise = file.close();
      }
      return releasePromise;
    },
  };
  activeSnapshotReleaseLocks.set(lock, lockPath);
  return lock;
}

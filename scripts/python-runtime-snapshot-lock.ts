import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';

const RELEASE_LOCK_TOKEN_PREFIX =
  '--python-runtime-snapshot-release-lock-token=';

export class SnapshotReleaseLockUnavailableError extends Error {
  constructor(readonly lockPath: string) {
    super(`Another Python runtime snapshot replacement holds ${lockPath}.`);
    this.name = 'SnapshotReleaseLockUnavailableError';
  }
}

export interface SnapshotReleaseLockCommand {
  readonly args: readonly string[];
  readonly command: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly lockPath: string;
  readonly platform?: NodeJS.Platform;
  readonly stdio?: SpawnOptions['stdio'];
}

export function createSnapshotReleaseLockTokenArgument(): string {
  return `${RELEASE_LOCK_TOKEN_PREFIX}${randomUUID()}`;
}

export function assertSnapshotReleaseWorkerLock(
  args: readonly string[],
  replace: boolean
): void {
  if (!replace) return;
  const tokens = args.filter((argument) =>
    argument.startsWith(RELEASE_LOCK_TOKEN_PREFIX)
  );
  if (
    tokens.length !== 1 ||
    !/^--python-runtime-snapshot-release-lock-token=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      tokens[0] ?? ''
    )
  ) {
    throw new Error(
      'Python runtime snapshot replacement must run through build-python-runtime-snapshot.ts.'
    );
  }
}

function lockInvocation(options: SnapshotReleaseLockCommand): {
  readonly args: string[];
  readonly command: string;
} {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    return {
      command: '/usr/bin/lockf',
      args: [
        '-t',
        '0',
        '-k',
        options.lockPath,
        options.command,
        ...options.args,
      ],
    };
  }
  if (platform === 'linux') {
    return {
      command: '/usr/bin/flock',
      args: [
        '-E',
        '75',
        '-n',
        '-o',
        options.lockPath,
        options.command,
        ...options.args,
      ],
    };
  }
  throw new Error(
    `Python runtime snapshot replacement does not support ${platform} locking.`
  );
}

export function spawnSnapshotReleaseLockCommand(
  options: SnapshotReleaseLockCommand
): ChildProcess {
  const invocation = lockInvocation(options);
  return spawn(invocation.command, invocation.args, {
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
  });
}

export async function waitForSnapshotReleaseLockCommand(
  child: ChildProcess,
  lockPath: string
): Promise<void> {
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
    `Locked Python runtime snapshot replacement failed with ${
      result.signal ?? `exit code ${String(result.code)}`
    }.`
  );
}

export async function runSnapshotReleaseLockCommand(
  options: SnapshotReleaseLockCommand
): Promise<void> {
  await waitForSnapshotReleaseLockCommand(
    spawnSnapshotReleaseLockCommand(options),
    options.lockPath
  );
}

#!/usr/bin/env npx tsx

import type { RuntimeProjectSessionInfo } from '../packages/harness-core/src/index';
import { WorkspaceLifecycleState } from '../packages/harness-project/src/workspace-lifecycle-state';

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function session(
  expirationBehavior:
    | 'none'
    | 'readonly'
    | 'destroy',
  expiresAt: string
): RuntimeProjectSessionInfo {
  const createdAt = new Date(0).toISOString();
  return {
    id: `session-${expirationBehavior}`,
    workspaceRoot: '/home/user/project',
    cwd: '/home/user/project',
    commands: {},
    readonlyFiles: [],
    hiddenFiles: [],
    lifecycle: {
      createdAt,
      lastOpenedAt: createdAt,
      expiresAt,
      expirationBehavior,
    },
  };
}

function inertLifecycleState(): WorkspaceLifecycleState {
  return new WorkspaceLifecycleState({
    workspaceRoot: '/home/user/project',
    isReadonlyPolicySuspended: () => false,
    onExpired: () => undefined,
    destroyExpired: async () => undefined,
  });
}

async function main(): Promise<void> {
  const identities = inertLifecycleState();
  assertEqual(
    identities.allocateRuntimeActorId(),
    'runtime:1',
    'first runtime actor'
  );
  assertEqual(
    identities.allocateRuntimeActorId(),
    'runtime:2',
    'second runtime actor'
  );
  assertEqual(
    identities.allocateTemporaryEntry(),
    1,
    'first temporary entry'
  );
  assertEqual(
    identities.allocateTemporaryEntry(),
    2,
    'second temporary entry'
  );
  assertEqual(
    identities.allocateTerminalSessionId(),
    'terminal-1',
    'first terminal session'
  );
  assertEqual(
    identities.allocateTerminalSessionId(),
    'terminal-2',
    'second terminal session'
  );
  assertEqual(
    identities.scheduleExpirationDestroy(),
    true,
    'first expiration destroy should schedule'
  );
  assertEqual(
    identities.scheduleExpirationDestroy(),
    false,
    'expiration destroy should schedule exactly once'
  );
  assertEqual(
    identities.toggleTerminalVerbose(),
    true,
    'toggle should enable terminal verbosity'
  );
  assertEqual(
    identities.setTerminalVerbose(false),
    false,
    'explicit setter should disable terminal verbosity'
  );

  const past = new Date(Date.now() - 1_000).toISOString();
  const readonlySession = session('readonly', past);
  let expiredTransitions = 0;
  let destroyed = 0;
  const readonly = new WorkspaceLifecycleState({
    session: readonlySession,
    workspaceRoot: readonlySession.workspaceRoot,
    isReadonlyPolicySuspended: () => false,
    onExpired: () => {
      expiredTransitions += 1;
    },
    destroyExpired: async () => {
      destroyed += 1;
    },
  });

  let mutationCode = '';
  try {
    readonly.assertUsableForMutation('write');
  } catch (error) {
    mutationCode = String(
      (error as { code?: unknown }).code ?? ''
    );
  }
  const runResult = readonly.unusableRunResult('npm test');
  assertCondition(
    mutationCode === 'EROFS' &&
      runResult?.stderr.includes('project session expired') === true &&
      expiredTransitions === 1 &&
      destroyed === 0,
    'readonly expiration should transition once and block mutations and runs'
  );

  const noneSession = session('none', past);
  const none = new WorkspaceLifecycleState({
    session: noneSession,
    workspaceRoot: noneSession.workspaceRoot,
    isReadonlyPolicySuspended: () => false,
    onExpired: () => undefined,
    destroyExpired: async () => undefined,
  });
  none.assertUsableForMutation('write');
  assertCondition(
    none.unusableRunResult('npm test') === null,
    'expiration behavior none should leave mutation and run policy open'
  );

  const destroySession = session('destroy', past);
  const destroy = new WorkspaceLifecycleState({
    session: destroySession,
    workspaceRoot: destroySession.workspaceRoot,
    isReadonlyPolicySuspended: () => false,
    onExpired: () => undefined,
    destroyExpired: async () => {
      destroyed += 1;
    },
  });
  const destroyRun = destroy.unusableRunResult('npm test');
  await Promise.resolve();
  await Promise.resolve();
  destroy.unusableRunResult('npm test');
  await Promise.resolve();
  assertCondition(
    destroyRun?.stderr.includes('project session expired') === true &&
      destroyed === 1,
    'destroy expiration should schedule teardown once'
  );

  destroy.destroyed = true;
  let destroyedCode = '';
  try {
    destroy.assertNotDestroyed();
  } catch (error) {
    destroyedCode = String(
      (error as { code?: unknown }).code ?? ''
    );
  }
  assertCondition(
    destroyedCode === 'EINVAL',
    'destroyed workspaces should reject lifecycle entrypoints'
  );
}

void main().then(() => {
  console.log('workspace lifecycle state tests passed');
});

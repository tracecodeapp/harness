#!/usr/bin/env npx tsx

import { WorkspaceAccessPolicy } from '../packages/harness-project/src/workspace-access-policy';

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

function errorCode(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

async function main(): Promise<void> {
  const mutations: string[] = [];
  const policy = new WorkspaceAccessPolicy({
    cwd: '/home/learner/service',
    workspaceAlias: '/workspace',
    readonlyFiles: new Set(['src/config.json']),
    hiddenFiles: ['.scenario/answer.json'],
    ensureUsableForMutation: (operation) => {
      mutations.push(operation);
    },
  });

  assertCondition(
    policy.isReadOnly('src/config.json'),
    'configured readonly files should be reported through the public path API'
  );
  assertCondition(
    policy.isReadOnly('/workspace/src/config.json'),
    'the workspace alias should resolve before readonly checks'
  );
  assertCondition(
    policy.isProjectPathHidden('.scenario') &&
      policy.isWorkspacePathHidden(
        '/home/learner/service/.scenario/answer.json'
      ),
    'hidden descendants should hide their containing directory'
  );
  assertCondition(
    errorCode(() =>
      policy.assertWorkspacePathVisible(
        '/home/learner/service/.scenario',
        'open'
      )
    ) === 'ENOENT',
    'hidden paths should look absent to readers'
  );
  assertCondition(
    errorCode(() =>
      policy.assertWorkspacePathWritable(
        '/home/learner/service/src/config.json',
        'write'
      )
    ) === 'EROFS',
    'readonly files should reject writes'
  );
  assertCondition(
    errorCode(() =>
      policy.assertWorkspaceSubtreeWritable(
        '/home/learner/service/src',
        'remove'
      )
    ) === 'EROFS',
    'a subtree containing readonly files should reject recursive mutation'
  );
  assertCondition(
    errorCode(() =>
      policy.assertWorkspacePathWritable('/home/learner/other.txt', 'write')
    ) === 'EROFS',
    'paths outside writable mounts should reject writes'
  );
  assertCondition(
    errorCode(() =>
      policy.assertDynamicVirtualWritable('/tracekernel/bin/node', 'write')
    ) === 'EROFS',
    'virtual namespaces should reject direct mutation'
  );

  await policy.withSuspendedReadonlyPolicy(async () => {
    policy.assertWorkspacePathWritable(
      '/home/learner/service/src/config.json',
      'hydrate'
    );
  });
  assertCondition(
    mutations.includes('hydrate') &&
      !policy.isReadonlyPolicySuspended(),
    'trusted hydration should suspend only readonly path policy'
  );
}

await main();
console.log('workspace access policy tests passed');

#!/usr/bin/env npx tsx

import { createRuntimeWorkspace } from '../packages/tracekernel/src/workspace/index';

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    kernel: {
      user: { username: 'learner' },
      host: { hostname: 'tracevm' },
      workspace: { name: 'workspace' },
    },
    files: [
      { path: 'src/server.ts', contents: 'export {};\n' },
      { path: 'src/service.ts', contents: 'export {};\n' },
      { path: 'README.md', contents: '# Workspace\n' },
    ],
  });

  try {
    const directoryCompletion = await workspace.completeCommand(
      'cd sr',
      'cd sr'.length
    );
    assertCondition(
      directoryCompletion?.input === 'cd src/' &&
        directoryCompletion.matches.length === 1 &&
        directoryCompletion.matches[0]?.kind === 'directory',
      `directory completion should append a slash: ${JSON.stringify(
        directoryCompletion
      )}`
    );

    const commonPrefix = await workspace.completeCommand(
      'cat src/se',
      'cat src/se'.length
    );
    assertCondition(
      commonPrefix?.input === 'cat src/serv' &&
        commonPrefix.matches.length === 2,
      `ambiguous completion should extend only the common prefix: ${JSON.stringify(
        commonPrefix
      )}`
    );

    const homeCompletion = await workspace.completeCommand(
      'cd ~/wo',
      'cd ~/wo'.length
    );
    assertCondition(
      homeCompletion?.input === 'cd ~/workspace/' &&
        homeCompletion.matches[0]?.kind === 'directory',
      `completion should resolve paths relative to home: ${JSON.stringify(
        homeCompletion
      )}`
    );

    const session = workspace.createTerminalSession();
    const enterSource = await session.run('cd src');
    assertCondition(
      enterSource.exitCode === 0 &&
        session.cwd.endsWith('/workspace/src'),
      `terminal navigation should resolve a workspace directory: ${JSON.stringify(
        { enterSource, cwd: session.cwd }
      )}`
    );
    const rejectedNavigation = await session.run('cd ../../..');
    assertCondition(
      rejectedNavigation.exitCode !== 0 &&
        session.cwd.endsWith('/workspace/src'),
      `terminal navigation should reject paths outside the configured home: ${JSON.stringify(
        { rejectedNavigation, cwd: session.cwd }
      )}`
    );
  } finally {
    workspace.dispose();
  }
}

await main();
console.log('workspace terminal navigation tests passed');

#!/usr/bin/env npx tsx

import { createRuntimeWorkspace } from '../packages/harness-project/src/index';

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    kernel: {
      user: {
        username: 'learner',
      },
      host: {
        hostname: 'tracevm',
      },
    },
  });

  try {
    const commandShim = await workspace.readFile('/tracekernel/bin/uname');
    assertCondition(
      commandShim.startsWith('#!/bin/sh\nexec tracekernel-dispatch-uname '),
      `command catalog should project executable shims: ${commandShim}`
    );

    const commandTable = await workspace.readFile(
      '/proc/tracekernel/commands'
    );
    assertCondition(
      commandTable.includes(
        'uname\t/tracekernel/bin/uname\ttool'
      ),
      `proc command projection should use the command catalog: ${commandTable}`
    );

    await workspace.writeSkillFiles([
      {
        path: 'debugging/README.md',
        contents: 'Inspect the failure before changing the system.\n',
      },
    ]);
    assertCondition(
      (await workspace.readDir('/skills')).join(',') === 'debugging',
      'skill namespace should expose projected directories'
    );
    assertCondition(
      (await workspace.readFile('/skills/debugging/README.md')).startsWith(
        'Inspect the failure'
      ),
      'skill namespace should expose projected files'
    );

    const selfStatus = await workspace.runCommand(
      'cat /proc/self/status'
    );
    assertCondition(
      selfStatus.exitCode === 0 &&
        selfStatus.stdout.includes('Command:\tcat /proc/self/status') &&
        selfStatus.stdout.includes('Actor:\truntime:runtime:'),
      `proc self should follow the active command context: ${JSON.stringify(
        selfStatus
      )}`
    );

    const procStat = await workspace.stat('/proc/tracekernel/runtimes');
    assertCondition(
      procStat.isFile && procStat.mode === 0o444 && procStat.size > 0,
      `proc projection should expose read-only file metadata: ${JSON.stringify(
        procStat
      )}`
    );
  } finally {
    workspace.dispose();
  }
}

await main();
console.log('workspace virtual filesystem tests passed');

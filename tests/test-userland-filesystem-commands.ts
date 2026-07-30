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
    files: [
      { path: 'README.md', contents: 'tracekernel\n' },
      { path: 'src/index.js', contents: 'console.log("ok");\n' },
    ],
  });
  try {
    const listing = await workspace.runCommand('ls -l');
    assertCondition(
      listing.exitCode === 0 &&
        listing.stdout.includes('README.md') &&
        listing.stdout.includes('src'),
      `ls should render workspace entries: ${JSON.stringify(listing)}`
    );

    const stat = await workspace.runCommand(
      "stat -c '%n %s %F' README.md"
    );
    assertCondition(
      stat.exitCode === 0 &&
        stat.stdout === 'README.md 12 regular file\n',
      `stat should render requested fields: ${JSON.stringify(stat)}`
    );

    const usage = await workspace.runCommand('du -b src');
    assertCondition(
      usage.exitCode === 0 && usage.stdout === '19\tsrc\n',
      `du should aggregate file sizes: ${JSON.stringify(usage)}`
    );

    const filesystem = await workspace.runCommand('df -h');
    assertCondition(
      filesystem.exitCode === 0 &&
        filesystem.stdout.includes('Filesystem Size') &&
        filesystem.stdout.includes('tracekernel'),
      `df should render quota usage: ${JSON.stringify(filesystem)}`
    );

    const mounts = await workspace.runCommand('mount');
    assertCondition(
      mounts.exitCode === 0 &&
        mounts.stdout.includes('type tracefs'),
      `mount should render fixed topology: ${JSON.stringify(mounts)}`
    );

    const temporary = await workspace.runCommand(
      'mktemp /tmp/probe.XXXX'
    );
    const temporaryPath = temporary.stdout.trim();
    const temporaryStat = await workspace.runCommand(
      `stat -c '%F' ${temporaryPath}`
    );
    assertCondition(
      temporary.exitCode === 0 &&
        /^\/tmp\/probe\.[0-9a-z]{4}$/.test(temporaryPath) &&
        temporaryStat.stdout === 'regular file\n',
      `mktemp should create a file: ${JSON.stringify(temporary)}`
    );
  } finally {
    workspace.dispose();
  }
}

await main();
console.log('filesystem userland command tests passed');

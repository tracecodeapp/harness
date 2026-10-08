import { createRuntimeWorkspace } from '../packages/tracekernel/src/workspace/index';
import type { RuntimeCommandResult } from '../packages/runtime-contracts/src/index';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const workspace = await createRuntimeWorkspace({ files: [] });
try {
  const session = workspace.createTerminalSession();
  const check = async (command: string, exitCode: number, stdout?: string) => {
    const result = await session.run(command);
    assert(result.exitCode === exitCode, `${command}: ${JSON.stringify(result)}`);
    assert(!result.error, `${command}: handled filesystem error leaked: ${JSON.stringify(result)}`);
    if (stdout !== undefined) assert(result.stdout === stdout, `${command}: unexpected stdout ${JSON.stringify(result)}`);
    return result;
  };
  await check("printf 'first\\n' > output.txt", 0, '');
  await check("printf 'second\\n' >> output.txt", 0, '');
  await check('cat output.txt', 0, 'first\nsecond\n');
  await check("printf 'replacement\\n' > output.txt", 0, '');
  await check('cat output.txt', 0, 'replacement\n');
  await check("printf '#!/bin/sh\\nprintf script-ok\\n' > script.sh; chmod +x script.sh; ./script.sh", 0, 'script-ok');
  const missing = await check('cat missing.txt', 1);
  assert(missing.stderr.includes('missing.txt'), 'A genuine file failure must retain terminal diagnostics');
  await check('cat missing.txt || printf recovered', 0, 'recovered');
  const unrelatedExit = await workspace.runCommand('cat missing.txt || true; exit 7');
  assert(unrelatedExit.exitCode === 7 && !unrelatedExit.error, 'A recovered ENOENT must not become provenance for a later exit 7');
  await check('test -f absent.txt; printf builtin-ok', 0, 'builtin-ok');
  await check('printf after-failure', 0, 'after-failure');
  const unknownCommand = await session.run('no_such_terminal_command');
  assert(unknownCommand.exitCode === 127 && unknownCommand.stderr.includes('no_such_terminal_command'), 'Missing commands must preserve shell command-not-found behavior');
  const failedMutation = await check('mkdir missing-parent/child', 1);
  assert(failedMutation.stderr.includes('missing-parent'), 'Failed mutation must retain its diagnostics');
  const events = await workspace.readFile('/proc/tracekernel/events');
  assert(events.includes('fs-syscall-abort') && events.includes('ENOENT'), 'Rejected mutation must remain in syscall diagnostics');
} finally {
  workspace.dispose();
}

const authoritativeError = { code: 'EIO', message: 'runner transport failed' };
const runnerWorkspace = await createRuntimeWorkspace({
  files: [{ path: 'main.js', contents: '' }],
  nodeRunner: async (): Promise<RuntimeCommandResult> => ({
    stdout: '', stderr: '', exitCode: 0, error: authoritativeError,
  }),
});
try {
  const result = await runnerWorkspace.runCommand('node main.js');
  assert(result.error?.message === authoritativeError.message, 'Explicit runner metadata must survive even with exit 0');
} finally {
  runnerWorkspace.dispose();
}

const quotaWorkspace = await createRuntimeWorkspace({
  storageLimits: { maxWorkspaceBytes: 4, maxFileBytes: 4, maxEntryCount: 20 },
  files: [{ path: 'runner.js', contents: 'r' }],
  nodeRunner: async (): Promise<RuntimeCommandResult> => ({
    stdout: '', stderr: '', exitCode: 0,
    files: [{ path: 'generated.txt', contents: '1234' }],
  }),
});
try {
  const shell = await quotaWorkspace.runCommand('printf 12345 > large.txt');
  assert(shell.exitCode !== 0 && shell.error?.code === 'EFBIG', `Storage integrity errors must remain structured: ${JSON.stringify(shell)}`);
  const finalDiff = await quotaWorkspace.runCommand('node runner.js');
  assert(finalDiff.exitCode === 28 && finalDiff.error?.code === 'ENOSPC', `Final-diff failures must remain authoritative: ${JSON.stringify(finalDiff)}`);
} finally {
  quotaWorkspace.dispose();
}
console.log('terminal error provenance tests passed');

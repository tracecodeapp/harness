#!/usr/bin/env npx tsx

import {
  createRuntimeWorkspace,
  type RuntimeCommandResult,
} from '../packages/tracekernel/src/workspace/index';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  let releaseChild!: () => void;
  const childReleased = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  let childStarted!: () => void;
  const childStartedPromise = new Promise<void>((resolve) => {
    childStarted = resolve;
  });

  const workspace = await createRuntimeWorkspace({
    kernel: { maxProcesses: 3 },
    files: [{ path: 'hold.js', contents: 'setInterval(() => {}, 1000);\n' }],
    nodeRunner: async (): Promise<RuntimeCommandResult> => {
      childStarted();
      await childReleased;
      return { stdout: 'released\n', stderr: '', exitCode: 0 };
    },
  });

  const host = workspace.kernel.createProcess({
    name: 'tracebot',
    actor: { kind: 'runtime', id: 'tracebot' },
    signalPolicy: 'system-only',
  });
  const child = host.runCommand('node hold.js');
  await childStartedPromise;

  const full = await workspace.readFile('/proc/tracekernel/sched');
  assert(full.includes('processes\t3\n'), `process diagnostics should count PID 1, host, and child: ${full}`);
  assert(full.includes('max_processes\t3\n'), `process diagnostics should expose the configured ceiling: ${full}`);
  assert(full.includes('available_processes\t0\n'), `process diagnostics should expose exhaustion: ${full}`);
  assert(
    full.includes('next_pid\t103\n'),
    `the reserved kernel host service plus the admitted host and child should consume three PIDs: ${full}`
  );

  const rejectedCommand = await workspace.runCommand('echo unreachable');
  assert(rejectedCommand.exitCode === 11, `process-table exhaustion should return errno 11: ${JSON.stringify(rejectedCommand)}`);
  assert(rejectedCommand.error?.code === 'EAGAIN', `process-table exhaustion should return EAGAIN: ${JSON.stringify(rejectedCommand)}`);
  assert(rejectedCommand.error?.errno === 11, `process-table exhaustion should preserve errno: ${JSON.stringify(rejectedCommand)}`);
  assert(rejectedCommand.error?.syscall === 'fork', `process-table exhaustion should identify fork: ${JSON.stringify(rejectedCommand)}`);
  assert(rejectedCommand.error?.path === 'echo unreachable', `process-table exhaustion should identify the attempted command: ${JSON.stringify(rejectedCommand)}`);
  assert(
    rejectedCommand.stderr === 'bash: fork: Resource temporarily unavailable\n',
    `process-table exhaustion should have native-looking stderr: ${JSON.stringify(rejectedCommand)}`
  );

  let rejectedHostError: unknown;
  try {
    workspace.kernel.createProcess({
      name: 'tracecode-client',
      actor: { kind: 'runtime', id: 'tracecode-client' },
    });
  } catch (error) {
    rejectedHostError = error;
  }
  assert(rejectedHostError instanceof Error, 'host process creation should throw when the process table is full');
  assert((rejectedHostError as Error & { code?: string }).code === 'EAGAIN', `host process rejection should expose EAGAIN: ${String(rejectedHostError)}`);
  assert((rejectedHostError as Error & { errno?: number }).errno === 11, `host process rejection should expose errno 11: ${String(rejectedHostError)}`);
  assert((rejectedHostError as Error & { syscall?: string }).syscall === 'fork', `host process rejection should identify fork: ${String(rejectedHostError)}`);

  const afterRejections = await workspace.readFile('/proc/tracekernel/sched');
  assert(afterRejections.includes('next_pid\t103\n'), `failed forks must not consume PIDs: ${afterRejections}`);
  const events = await workspace.readFile('/proc/tracekernel/events');
  const rejectionEvents = events.split('\n').filter((line) => line.includes('process-reject'));
  assert(rejectionEvents.length === 2, `both command and host rejections should be diagnosed: ${events}`);
  assert(rejectionEvents.every((line) => line.includes('"syscall":"fork"')), `rejection diagnostics should identify fork: ${events}`);

  releaseChild();
  const childResult = await child;
  assert(childResult.exitCode === 0, `the admitted child should complete normally: ${JSON.stringify(childResult)}`);

  const replacement = workspace.kernel.createProcess({
    name: 'tracecode-client',
    actor: { kind: 'runtime', id: 'tracecode-client' },
  });
  const recovered = await workspace.readFile('/proc/tracekernel/sched');
  assert(recovered.includes('processes\t3\n'), `a completed child should release its process-table slot: ${recovered}`);
  assert(replacement.pid === 103, `the next successful fork should receive the first unconsumed PID: ${replacement.pid}`);

  replacement.dispose();
  host.dispose();

  const zombie = await workspace.runCommand('echo zombie', { retainOnExit: true });
  const secondZombie = await workspace.runCommand('echo second-zombie', { retainOnExit: true });
  assert(
    zombie.exitCode === 0 && secondZombie.exitCode === 0,
    `the retained commands should exit normally: ${JSON.stringify({ zombie, secondZombie })}`
  );
  const zombieFull = await workspace.readFile('/proc/tracekernel/sched');
  const zombieLine = zombieFull.split('\n').find((line) => line.includes('\tzombie\techo zombie'));
  const zombiePid = zombieLine?.split('\t')[1] ?? '';
  const secondZombieLine = zombieFull.split('\n').find((line) => line.includes('\tzombie\techo second-zombie'));
  const secondZombiePid = secondZombieLine?.split('\t')[1] ?? '';
  assert(
    /^[0-9]+$/.test(zombiePid) && /^[0-9]+$/.test(secondZombiePid),
    `the retained children should occupy the remaining process-table slots: ${zombieFull}`
  );
  assert(
    zombieFull.includes('processes\t3\n') && zombieFull.includes('available_processes\t0\n'),
    `the zombies should exhaust maxProcesses: ${zombieFull}`
  );

  const blockedByZombie = await workspace.runCommand('echo still-blocked');
  assert(
    blockedByZombie.error?.code === 'EAGAIN' && blockedByZombie.error.syscall === 'fork',
    `ordinary commands should remain blocked while a zombie owns the last slot: ${JSON.stringify(blockedByZombie)}`
  );
  const waitHelp = await workspace.runCommand('wait --help');
  assert(
    waitHelp.exitCode === 0 && waitHelp.stdout.startsWith('wait - ') && waitHelp.stdout.includes('Usage: wait [PID]'),
    `the no-fork wait builtin should retain the shared help contract while the process table is full: ${JSON.stringify(waitHelp)}`
  );
  const beforeWait = await workspace.readFile('/proc/tracekernel/sched');
  const nextPidBeforeWait = beforeWait.match(/next_pid\t(\d+)/)?.[1];
  const wait = await workspace.runCommand(`wait ${zombiePid}`);
  assert(
    wait.exitCode === 0 && wait.stdout === '' && wait.stderr === '',
    `the shell builtin should reap without forking: ${JSON.stringify(wait)}`
  );
  const afterWait = await workspace.readFile('/proc/tracekernel/sched');
  assert(afterWait.includes('processes\t2\n'), `wait should release exactly one zombie slot: ${afterWait}`);
  assert(afterWait.includes(`next_pid\t${nextPidBeforeWait}\n`), `in-process wait must not consume a PID: ${afterWait}`);

  const thirdZombie = await workspace.runCommand('echo third-zombie', { retainOnExit: true });
  assert(thirdZombie.exitCode === 0, `the third retained command should exit normally: ${JSON.stringify(thirdZombie)}`);
  const thirdZombieSched = await workspace.readFile('/proc/tracekernel/sched');
  const thirdZombiePid = thirdZombieSched.split('\n').find((line) => line.includes('\tzombie\techo third-zombie'))?.split('\t')[1] ?? '';
  assert(
    thirdZombieSched.includes('processes\t3\n') && /^[0-9]+$/.test(thirdZombiePid),
    `the third zombie should exhaust the recovered slot: ${thirdZombieSched}`
  );
  const beforeControlWaitPid = thirdZombieSched.match(/next_pid\t(\d+)/)?.[1];
  const controlWait = await workspace.runCommand(`/tracekernel/bin/tracekernelctl wait ${secondZombiePid}`);
  assert(
    controlWait.exitCode === 0 && controlWait.stdout.includes(`pid\t${secondZombiePid}\n`),
    `the control-plane wait form should also reap without forking: ${JSON.stringify(controlWait)}`
  );
  const afterControlWait = await workspace.readFile('/proc/tracekernel/sched');
  assert(
    afterControlWait.includes(`next_pid\t${beforeControlWaitPid}\n`),
    `control-plane wait must not consume a PID: ${afterControlWait}`
  );
  const cleanupWait = await workspace.runCommand(`wait ${thirdZombiePid}`);
  assert(cleanupWait.exitCode === 0, `the remaining zombie should be reapable: ${JSON.stringify(cleanupWait)}`);

  workspace.dispose();
  console.log('PASS: TraceKernel enforces one kernel-wide process-table limit');
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

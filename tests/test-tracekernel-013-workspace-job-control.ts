#!/usr/bin/env npx tsx

import {
  createRuntimeWorkspace,
  type JavaScriptProjectCommandRunner,
} from '../packages/harness-project/src/index';
import type { TraceKernelSession } from '../packages/tracekernel/src/index';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let markSignaled!: () => void;
  const signaled = new Promise<void>((resolve) => {
    markSignaled = resolve;
  });

  const nodeRunner: JavaScriptProjectCommandRunner = async (request) => {
    markStarted();
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        markSignaled();
        resolve();
      };
      if (request.signal?.aborted) {
        finish();
        return;
      }
      request.signal?.addEventListener('abort', finish, { once: true });
    });
    return { stdout: '', stderr: '', exitCode: 143 };
  };

  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'job.js',
        contents: '// long-running job-control fixture\n',
      },
    ],
    nodeRunner,
  });
  const session = (
    workspace as unknown as {
      traceKernelAuthority?: { session: TraceKernelSession };
    }
  ).traceKernelAuthority?.session;
  assertCondition(session, 'Workspace did not create a TraceKernel session.');

  try {
    const running = workspace.runCommand('node job.js');
    await started;

    const processTable = await workspace.readFile(
      '/proc/tracekernel/processes'
    );
    const processLine = processTable
      .split('\n')
      .find((line) => line.endsWith('\tnode job.js'));
    const pid = Number(processLine?.split('\t')[0]);
    assertCondition(
      Number.isSafeInteger(pid) && pid > 1,
      `Could not find the active job PID: ${JSON.stringify(processTable)}`
    );

    const foreground = await workspace.runCommand(`fg ${pid}`);
    assertCondition(
      foreground.exitCode === 0,
      `fg failed: ${JSON.stringify(foreground)}`
    );
    const foregroundProcess = session
      .processSnapshots()
      .find((process) => process.pid === pid);
    const foregroundTerminal = session.terminalSnapshots()[0];
    const foregroundDescriptors = foregroundProcess?.descriptors.filter(
      (descriptor) => descriptor.fd >= 0 && descriptor.fd <= 2
    );
    assertCondition(
      foregroundProcess &&
        foregroundTerminal &&
        foregroundProcess.controllingTerminalId === foregroundTerminal.id &&
        foregroundTerminal.foregroundProcessGroupId ===
          foregroundProcess.pgid &&
        foregroundDescriptors?.length === 3 &&
        foregroundDescriptors.every(
          (descriptor) =>
            descriptor.kind === 'terminal' &&
            descriptor.resourceId === foregroundTerminal.id
        ),
      `fg did not atomically place the job on the kernel terminal: ${JSON.stringify({
        process: foregroundProcess,
        terminal: foregroundTerminal,
        descriptors: foregroundDescriptors,
      })}`
    );
    const foregroundStatus = await workspace.readFile(`/proc/${pid}/status`);
    assertCondition(
      foregroundStatus.includes('Tty:\t/dev/tty\n') &&
        foregroundStatus.includes('Foreground:\t1\n'),
      `Product process status did not read through foreground placement: ${JSON.stringify(
        foregroundStatus
      )}`
    );

    const background = await workspace.runCommand(`bg ${pid}`);
    assertCondition(
      background.exitCode === 0,
      `bg failed: ${JSON.stringify(background)}`
    );
    const backgroundProcess = session
      .processSnapshots()
      .find((process) => process.pid === pid);
    const backgroundTerminal = session.terminalSnapshots()[0];
    const backgroundDescriptors = backgroundProcess?.descriptors.filter(
      (descriptor) => descriptor.fd >= 0 && descriptor.fd <= 2
    );
    assertCondition(
      backgroundProcess &&
        backgroundTerminal &&
        backgroundProcess.controllingTerminalId === backgroundTerminal.id &&
        backgroundTerminal.foregroundProcessGroupId ===
          backgroundTerminal.sessionId &&
        backgroundDescriptors?.length === 3 &&
        backgroundDescriptors.every(
          (descriptor) => descriptor.kind === 'device'
        ),
      `bg did not restore compatibility stdio and kernel foreground ownership: ${JSON.stringify({
        process: backgroundProcess,
        terminal: backgroundTerminal,
        descriptors: backgroundDescriptors,
      })}`
    );
    const backgroundStatus = await workspace.readFile(`/proc/${pid}/status`);
    assertCondition(
      backgroundStatus.includes('Tty:\t?\n') &&
        backgroundStatus.includes('Foreground:\t0\n'),
      `Product process status did not read through background placement: ${JSON.stringify(
        backgroundStatus
      )}`
    );

    const killed = await workspace.runCommand(`kill -TERM ${pid}`);
    assertCondition(
      killed.exitCode === 0,
      `kill failed: ${JSON.stringify(killed)}`
    );
    await signaled;
    const result = await running;
    assertCondition(
      result.exitCode === 143,
      `Signaled job returned the wrong result: ${JSON.stringify(result)}`
    );
    const waited = await workspace.runCommand(`wait ${pid}`);
    assertCondition(
      waited.exitCode === 143 &&
        waited.stdout.includes(`pid\t${pid}\n`) &&
        waited.stdout.includes('signal\tSIGTERM\n'),
      `wait did not reap the job: ${JSON.stringify(waited)}`
    );
    assertCondition(
      session.processSnapshots().length === 0,
      `Job-control commands leaked kernel processes: ${JSON.stringify(
        session.processSnapshots()
      )}`
    );
  } finally {
    workspace.dispose();
  }

  console.log(JSON.stringify({
    schema: 'tracekernel-013-workspace-job-control-v1',
    kernelOwnedForegroundProcessGroup: true,
    atomicTerminalStandardIoPlacement: true,
    atomicNullStandardIoPlacement: true,
    controllingTerminalRemainsSessionOwned: true,
    productStatusReadsThroughKernelPlacement: true,
    shellJobLifecycleReaped: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(
    error instanceof Error ? error.stack ?? error.message : String(error)
  );
  process.exitCode = 1;
});

#!/usr/bin/env npx tsx

import * as Effect from 'effect/Effect';
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
  let markNormalStarted!: () => void;
  const normalStarted = new Promise<void>((resolve) => {
    markNormalStarted = resolve;
  });
  let releaseNormal!: () => void;
  const normalReleased = new Promise<void>((resolve) => {
    releaseNormal = resolve;
  });

  const nodeRunner: JavaScriptProjectCommandRunner = async (request) => {
    if (request.scriptPath.endsWith('normal-job.js')) {
      markNormalStarted();
      await normalReleased;
      return { stdout: 'normal-exit\n', stderr: '', exitCode: 23 };
    }
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
      {
        path: 'normal-job.js',
        contents: '// normally completing wait fixture\n',
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
    const productProcess = (
      workspace as unknown as {
        processTable: Map<number, {
          kernelProcess?: unknown;
          abortController?: unknown;
          ppid: number;
          pgid: number;
          sid: number;
          state:
            | 'queued'
            | 'running'
            | 'blocked'
            | 'signaled'
            | 'zombie'
            | 'exited';
        }>;
      }
    ).processTable.get(pid);
    assertCondition(productProcess, 'Product process projection was unavailable.');
    const executionHandles = (
      workspace as unknown as {
        processExecutionHandles: Map<
          number,
          {
            kernelProcess: { readonly pid: number };
            abortController?: AbortController;
          }
        >;
      }
    ).processExecutionHandles;
    const executionHandle = executionHandles.get(pid);
    assertCondition(
      !Object.prototype.hasOwnProperty.call(productProcess, 'kernelProcess') &&
        !Object.prototype.hasOwnProperty.call(productProcess, 'abortController') &&
        executionHandle?.kernelProcess.pid === pid &&
        executionHandle.abortController instanceof AbortController,
      `Host execution handles leaked into the mutable product process projection: ${JSON.stringify(
        {
          productKeys: Object.keys(productProcess),
          executionPid: executionHandle?.kernelProcess.pid,
          hasAbortController:
            executionHandle?.abortController instanceof AbortController,
        }
      )}`
    );
    const originalState = productProcess.state;
    const rejectedTopologyMutations = [
      Reflect.set(productProcess, 'ppid', 99_991),
      Reflect.set(productProcess, 'pgid', 99_992),
      Reflect.set(productProcess, 'sid', 99_993),
    ];
    productProcess.state = 'zombie';
    const [
      authoritativeStatus,
      authoritativeProcesses,
      authoritativePs,
      authoritativeJobs,
      authoritativeGroupProbe,
    ] =
      await Promise.all([
        workspace.readFile(`/proc/${pid}/status`),
        workspace.readFile('/proc/tracekernel/processes'),
        workspace.runCommand('ps -ef'),
        workspace.runCommand('jobs -l'),
        workspace.runCommand(`kill -0 -${pid}`),
      ]);
    assertCondition(
      authoritativeStatus.includes('State:\tR (running)\n') &&
        authoritativeStatus.includes('PPid:\t1\n') &&
        authoritativeStatus.includes(`PGid:\t${pid}\n`) &&
        authoritativeStatus.includes('Sid:\t1\n') &&
        authoritativeProcesses.includes(
          `${pid}\t1\t${pid}\t1\trunning\t?\t0\t/workspace\tnode job.js`
        ) &&
        authoritativePs.stdout.includes(
          `${String(pid).padStart(5, ' ')}${String(1).padStart(6, ' ')}${String(pid).padStart(6, ' ')}${String(1).padStart(6, ' ')}`
        ) &&
        authoritativeJobs.stdout.includes(
          `${pid}\tRunning\tbackground\t?\tnode job.js`
        ) &&
        authoritativeGroupProbe.exitCode === 0 &&
        rejectedTopologyMutations.every((accepted) => !accepted),
      `Process inspection trusted the corrupted product projection: ${JSON.stringify({
        authoritativeStatus,
        authoritativeProcesses,
        authoritativePs,
        authoritativeJobs,
        authoritativeGroupProbe,
        rejectedTopologyMutations,
      })}`
    );
    productProcess.state = originalState;

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
    const duplicateKernelWait = await Effect.runPromise(
      Effect.either(session.waitInitChild(pid, { noHang: true }))
    );
    assertCondition(
      duplicateKernelWait._tag === 'Left' &&
        'code' in duplicateKernelWait.left &&
        duplicateKernelWait.left.code === 'ECHILD' &&
        session.processSnapshots().length === 0 &&
        !executionHandles.has(pid),
      `Shell wait did not reap logical PID 1's kernel child exactly once: ${JSON.stringify({
        duplicateKernelWait,
        processes: session.processSnapshots(),
        retainedExecutionHandle: executionHandles.has(pid),
      })}`
    );

    const normalRunning = workspace.runCommand('node normal-job.js');
    await normalStarted;
    const normalProcessTable = await workspace.readFile(
      '/proc/tracekernel/processes'
    );
    const normalProcessLine = normalProcessTable
      .split('\n')
      .find((line) => line.endsWith('\tnode normal-job.js'));
    const normalPid = Number(normalProcessLine?.split('\t')[0]);
    assertCondition(
      Number.isSafeInteger(normalPid) && normalPid > 1,
      `Could not find the normally completing job: ${JSON.stringify(
        normalProcessTable
      )}`
    );
    const normalWait = workspace.runCommand(`wait ${normalPid}`);
    releaseNormal();
    const [normalResult, normalWaited] = await Promise.all([
      normalRunning,
      normalWait,
    ]);
    assertCondition(
      normalResult.exitCode === 23 &&
        normalResult.stdout === 'normal-exit\n' &&
        normalWaited.exitCode === 23 &&
        normalWaited.stdout.includes(`pid\t${normalPid}\n`),
      `A pre-exit shell wait raced normal auto-reaping: ${JSON.stringify({
        normalResult,
        normalWaited,
      })}`
    );
    const duplicateNormalWait = await Effect.runPromise(
      Effect.either(session.waitInitChild(normalPid, { noHang: true }))
    );
    assertCondition(
      duplicateNormalWait._tag === 'Left' &&
        'code' in duplicateNormalWait.left &&
        duplicateNormalWait.left.code === 'ECHILD',
      `Normally completing shell wait was not exactly once: ${JSON.stringify(
        duplicateNormalWait
      )}`
    );
  } finally {
    workspace.dispose();
  }

  let releaseSchedulerA!: () => void;
  const schedulerAReleased = new Promise<void>((resolve) => {
    releaseSchedulerA = resolve;
  });
  let releaseSchedulerB!: () => void;
  const schedulerBReleased = new Promise<void>((resolve) => {
    releaseSchedulerB = resolve;
  });
  let markSchedulerAStarted!: () => void;
  const schedulerAStarted = new Promise<void>((resolve) => {
    markSchedulerAStarted = resolve;
  });
  let markSchedulerBStarted!: () => void;
  const schedulerBStarted = new Promise<void>((resolve) => {
    markSchedulerBStarted = resolve;
  });
  const schedulerWorkspace = await createRuntimeWorkspace({
    kernel: { scheduler: { maxConcurrentCommands: 1 } },
    files: [
      { path: 'scheduler-a.js', contents: '// scheduler holder\n' },
      { path: 'scheduler-b.js', contents: '// scheduler waiter\n' },
    ],
    nodeRunner: async (request) => {
      if (request.scriptPath.endsWith('scheduler-a.js')) {
        markSchedulerAStarted();
        await schedulerAReleased;
        return { stdout: 'a\n', stderr: '', exitCode: 0 };
      }
      markSchedulerBStarted();
      await schedulerBReleased;
      return { stdout: 'b\n', stderr: '', exitCode: 0 };
    },
  });
  const schedulerSession = (
    schedulerWorkspace as unknown as {
      traceKernelAuthority?: { session: TraceKernelSession };
    }
  ).traceKernelAuthority?.session;
  assertCondition(
    schedulerSession,
    'Scheduler workspace did not create a TraceKernel session.'
  );
  try {
    const schedulerA = schedulerWorkspace.runCommand('node scheduler-a.js');
    await schedulerAStarted;
    const schedulerB = schedulerWorkspace.runCommand('node scheduler-b.js');
    let queuedSnapshot = schedulerSession
      .processSnapshots()
      .find((snapshot) => snapshot.command === 'node scheduler-b.js');
    for (let attempt = 0; attempt < 100 && !queuedSnapshot; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      queuedSnapshot = schedulerSession
        .processSnapshots()
        .find((snapshot) => snapshot.command === 'node scheduler-b.js');
    }
    const runningSnapshot = schedulerSession
      .processSnapshots()
      .find((snapshot) => snapshot.command === 'node scheduler-a.js');
    assertCondition(
      runningSnapshot?.schedulingState === 'running' &&
        queuedSnapshot?.schedulingState === 'queued',
      `Workspace scheduling was not published to TraceKernel: ${JSON.stringify({
        runningSnapshot,
        queuedSnapshot,
      })}`
    );
    const queuedProcesses = await schedulerWorkspace.readFile(
      '/proc/tracekernel/processes'
    );
    assertCondition(
      queuedProcesses.includes(
        `${queuedSnapshot.pid}\t1\t${queuedSnapshot.pid}\t1\tqueued\t`
      ),
      `/proc did not read queued state from TraceKernel: ${JSON.stringify(
        queuedProcesses
      )}`
    );
    releaseSchedulerA();
    await schedulerBStarted;
    const admittedSnapshot = schedulerSession
      .processSnapshots()
      .find((snapshot) => snapshot.pid === queuedSnapshot.pid);
    assertCondition(
      admittedSnapshot?.schedulingState === 'running',
      `Scheduler admission did not update TraceKernel: ${JSON.stringify(
        admittedSnapshot
      )}`
    );
    releaseSchedulerB();
    const [schedulerAResult, schedulerBResult] = await Promise.all([
      schedulerA,
      schedulerB,
    ]);
    assertCondition(
      schedulerAResult.stdout === 'a\n' &&
        schedulerBResult.stdout === 'b\n',
      'Scheduler conformance commands did not complete.'
    );
  } finally {
    schedulerWorkspace.dispose();
  }

  console.log(JSON.stringify({
    schema: 'tracekernel-013-workspace-job-control-v1',
    kernelOwnedForegroundProcessGroup: true,
    atomicTerminalStandardIoPlacement: true,
    atomicNullStandardIoPlacement: true,
    controllingTerminalRemainsSessionOwned: true,
    productStatusReadsThroughKernelPlacement: true,
    shellJobLifecycleReaped: true,
    shellWaitReapsLogicalInitChildExactlyOnce: true,
    preExitShellWaitBeatsNormalAutoReap: true,
    procPsAndJobsReadAuthoritativeProcessTable: true,
    kernelOwnedSchedulingState: true,
    immutableKernelBackedTopologyProjection: true,
    processGroupControlIgnoresProductLifecycleProjection: true,
    hostExecutionHandlesSeparatedFromProcessProjection: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(
    error instanceof Error ? error.stack ?? error.message : String(error)
  );
  process.exitCode = 1;
});

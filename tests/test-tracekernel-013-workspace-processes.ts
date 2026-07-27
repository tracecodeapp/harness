#!/usr/bin/env npx tsx

import {
  createRuntimeWorkspace,
  type JavaScriptProjectCommandRunner,
} from '../packages/harness-project/src/index';
import type {
  RuntimeKernelSyscallBridge,
  RuntimeProjectCommandRequest,
} from '../packages/harness-core/src/runtime-project';
import type {
  TraceKernelSession,
  TraceKernelSyscallRequest,
  TraceKernelSyscallResult,
} from '../packages/tracekernel/src/index';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function syscalls(
  request: RuntimeProjectCommandRequest
): RuntimeKernelSyscallBridge {
  assertCondition(
    request.kernelSyscalls,
    `runtime process ${request.process?.pid ?? 'unknown'} did not receive a syscall bridge`
  );
  return request.kernelSyscalls;
}

/**
 * harness-core deliberately treats the syscall wire as unknown so it does not
 * depend on TraceKernel. Runtime adapters own this single validation/typing
 * boundary before working with the versioned kernel protocol.
 */
function dispatch(
  kernel: RuntimeKernelSyscallBridge,
  request: TraceKernelSyscallRequest
): Promise<TraceKernelSyscallResult> {
  return kernel.dispatch(request) as Promise<TraceKernelSyscallResult>;
}

async function main(): Promise<void> {
  const observedProcesses: Array<{
    readonly scriptPath: string;
    readonly pid: number;
    readonly ppid: number;
  }> = [];
  let terminalRuntimeCount = 0;
  let detachedRuntimeCount = 0;
  const terminalInterruptSignals: Array<{
    readonly scriptPath: string;
    readonly signal: string;
  }> = [];
  const interruptChildStartWaiters: Array<() => void> = [];
  let authoritativeSession: TraceKernelSession | undefined;
  const waitForInterruptChildStart = (): Promise<void> =>
    new Promise<void>((resolve) => {
      interruptChildStartWaiters.push(resolve);
    });

  const nodeRunner: JavaScriptProjectCommandRunner = async (request) => {
    const authoritativeProcess = authoritativeSession?.processSnapshots().find(
      (process) => process.pid === request.process?.pid
    );
    assertCondition(
      authoritativeProcess &&
        authoritativeProcess.ppid === request.process?.ppid &&
        authoritativeProcess.pgid === request.process?.pgid &&
        authoritativeProcess.sid === request.process?.sid,
      `product runner PID ${request.process?.pid ?? 'unknown'} was not owned by the extracted TraceKernel session`
    );
    observedProcesses.push({
      scriptPath: request.scriptPath,
      pid: request.process?.pid ?? -1,
      ppid: request.process?.ppid ?? -1,
    });
    const kernel = syscalls(request);
    const tty = await dispatch(kernel, { op: 'isatty', fd: 0 });
    const foregroundGroup = await dispatch(kernel, {
      op: 'tcgetpgrp',
      fd: 0,
    });
    if (request.terminal?.isTTY) {
      terminalRuntimeCount += 1;
      assertCondition(
        tty.ok &&
          tty.value.op === 'isatty' &&
          tty.value.isTerminal &&
          foregroundGroup.ok &&
          foregroundGroup.value.op === 'tcgetpgrp' &&
          foregroundGroup.value.pgid === request.process?.pgid,
        `terminal process did not receive authoritative foreground state: ${JSON.stringify({
          tty,
          foregroundGroup,
          process: request.process,
        })}`
      );
    } else {
      detachedRuntimeCount += 1;
      assertCondition(
        tty.ok &&
          tty.value.op === 'isatty' &&
          !tty.value.isTerminal &&
          !foregroundGroup.ok &&
          foregroundGroup.error.code === 'ENOTTY',
        `detached process received a controlling terminal: ${JSON.stringify({
          tty,
          foregroundGroup,
          process: request.process,
        })}`
      );
    }

    const recordTerminalInterrupt = (): void => {
      const reason = request.signal?.reason as { signal?: unknown } | undefined;
      terminalInterruptSignals.push({
        scriptPath: request.scriptPath,
        signal: typeof reason?.signal === 'string' ? reason.signal : 'unknown',
      });
    };
    if (request.scriptPath.endsWith('interrupt-child.js')) {
      interruptChildStartWaiters.shift()?.();
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) {
          recordTerminalInterrupt();
          resolve();
          return;
        }
        request.signal?.addEventListener('abort', () => {
          recordTerminalInterrupt();
          resolve();
        }, { once: true });
      });
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (request.scriptPath.endsWith('interrupt-parent.js')) {
      request.signal?.addEventListener(
        'abort',
        recordTerminalInterrupt,
        { once: true }
      );
      const spawned = await dispatch(kernel, {
        op: 'spawn',
        runtime: 'javascript',
        command: 'node',
        args: ['interrupt-child.js'],
      });
      assertCondition(
        spawned.ok && spawned.value.op === 'spawn',
        `interrupt parent could not spawn its process-group peer: ${JSON.stringify(spawned)}`
      );
      if (!spawned.ok || spawned.value.op !== 'spawn') {
        return { stdout: '', stderr: 'spawn failed\n', exitCode: 1 };
      }
      await dispatch(kernel, { op: 'wait', pid: spawned.value.pid });
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (request.scriptPath.endsWith('child.js')) {
      const writeFd = Number(request.args.at(-1));
      const childDescriptor = authoritativeSession?.processSnapshots()
        .find((process) => process.pid === request.process?.pid)
        ?.descriptors.find((descriptor) => descriptor.fd === writeFd);
      assertCondition(
        childDescriptor?.kind === 'pipe-writer',
        `the inherited child fd was not owned by its TraceKernel process: ${JSON.stringify(
          childDescriptor
        )}`
      );
      const written = await dispatch(kernel, {
        op: 'write',
        fd: writeFd,
        bytes: new TextEncoder().encode('child-pipe'),
      });
      assertCondition(
        written.ok &&
          written.value.op === 'write' &&
          written.value.bytesWritten === 10,
        `child could not write its inherited pipe descriptor: ${JSON.stringify(written)}`
      );
      const file = await dispatch(kernel, {
        op: 'writeFile',
        path: 'child-owned.txt',
        bytes: new TextEncoder().encode('child-file'),
      });
      assertCondition(
        file.ok && file.value.op === 'writeFile',
        `child could not write the shared kernel filesystem: ${JSON.stringify(file)}`
      );
      return {
        stdout: '',
        stderr: '',
        exitCode: 7,
      };
    }

    const pipe = await dispatch(kernel, {
      op: 'pipe',
      options: { capacityChunks: 2 },
    });
    assertCondition(
      pipe.ok && pipe.value.op === 'pipe',
      `parent could not create a kernel pipe: ${JSON.stringify(pipe)}`
    );
    if (!pipe.ok || pipe.value.op !== 'pipe') {
      return { stdout: '', stderr: 'pipe failed\n', exitCode: 1 };
    }
    const { readFd, writeFd } = pipe.value;
    const parentPipeDescriptors = authoritativeSession?.processSnapshots()
      .find((process) => process.pid === request.process?.pid)
      ?.descriptors.filter((descriptor) =>
        descriptor.fd === readFd ||
        descriptor.fd === writeFd
      );
    assertCondition(
      parentPipeDescriptors?.length === 2 &&
        parentPipeDescriptors.some((descriptor) => descriptor.kind === 'pipe-reader') &&
        parentPipeDescriptors.some((descriptor) => descriptor.kind === 'pipe-writer'),
      `pipe descriptors were not installed in the authoritative process table: ${JSON.stringify(
        parentPipeDescriptors
      )}`
    );

    const spawned = await dispatch(kernel, {
      op: 'spawn',
      runtime: 'javascript',
      command: 'node',
      args: ['child.js', String(pipe.value.writeFd)],
      env: { CHILD_ENV: 'inherited' },
      inheritDescriptors: [pipe.value.writeFd],
    });
    assertCondition(
      spawned.ok && spawned.value.op === 'spawn',
      `parent could not spawn its JavaScript child: ${JSON.stringify(spawned)}`
    );
    if (!spawned.ok || spawned.value.op !== 'spawn') {
      return { stdout: '', stderr: 'spawn failed\n', exitCode: 1 };
    }

    const closedWriter = await dispatch(kernel, {
      op: 'close',
      fd: pipe.value.writeFd,
    });
    assertCondition(
      closedWriter.ok,
      `parent could not close its pipe writer: ${JSON.stringify(closedWriter)}`
    );
    const read = await dispatch(kernel, {
      op: 'read',
      fd: pipe.value.readFd,
      maxBytes: 64,
    });
    assertCondition(
      read.ok && read.value.op === 'read',
      `parent could not read its child pipe: ${JSON.stringify(read)}`
    );
    const waited = await dispatch(kernel, {
      op: 'wait',
      pid: spawned.value.pid,
    });
    assertCondition(
      waited.ok &&
        waited.value.op === 'wait' &&
        waited.value.termination?.kind === 'exit' &&
        waited.value.termination.exitCode === 7,
      `parent did not receive its child's exit status: ${JSON.stringify(waited)}`
    );
    const waitedTwice = await dispatch(kernel, {
      op: 'wait',
      pid: spawned.value.pid,
    });
    assertCondition(
      !waitedTwice.ok && waitedTwice.error.code === 'ECHILD',
      `reaped child did not return ECHILD: ${JSON.stringify(waitedTwice)}`
    );
    const childFile = await dispatch(kernel, {
      op: 'readFile',
      path: 'child-owned.txt',
    });
    assertCondition(
      childFile.ok && childFile.value.op === 'readFile',
      `parent could not read the child's shared file: ${JSON.stringify(childFile)}`
    );
    return {
      stdout: [
        read.ok && read.value.op === 'read'
          ? new TextDecoder().decode(read.value.bytes)
          : '',
        childFile.ok && childFile.value.op === 'readFile'
          ? new TextDecoder().decode(childFile.value.bytes)
          : '',
        `child-exit:${waited.ok && waited.value.op === 'wait'
          ? waited.value.termination?.exitCode ?? -1
          : -1}`,
        '',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    };
  };

  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'parent.js', contents: '// parent runtime fixture\n' },
      { path: 'child.js', contents: '// child runtime fixture\n' },
      {
        path: 'interrupt-parent.js',
        contents: '// terminal foreground process-group fixture\n',
      },
      {
        path: 'interrupt-child.js',
        contents: '// terminal foreground process-group child fixture\n',
      },
    ],
    nodeRunner,
  });
  authoritativeSession = (
    workspace as unknown as {
      traceKernelAuthority?: { session: TraceKernelSession };
    }
  ).traceKernelAuthority?.session;
  assertCondition(
    authoritativeSession,
    'The product workspace did not own an extracted TraceKernel session.'
  );
  const authoritativeFileMutations: Array<{
    readonly operation: string;
    readonly paths: readonly string[];
    readonly directProcessCommit: boolean;
  }> = [];
  const stopWatchingAuthoritativeFileMutations =
    authoritativeSession.fileSystem.watchMutations((mutation) => {
      authoritativeFileMutations.push({
        operation: mutation.operation,
        paths: mutation.paths,
        directProcessCommit: mutation.origin === undefined,
      });
    });

  try {
    const result = await workspace.runCommand('node parent.js');
    assertCondition(
      result.exitCode === 0 &&
        result.stdout === 'child-pipe\nchild-file\nchild-exit:7\n',
      `workspace process syscalls did not complete the parent/child flow: ${JSON.stringify(result)}`
    );
    const parent = observedProcesses.find((process) =>
      process.scriptPath.endsWith('parent.js')
    );
    const child = observedProcesses.find((process) =>
      process.scriptPath.endsWith('child.js')
    );
    assertCondition(
      parent &&
        child &&
        child.pid !== parent.pid &&
        child.ppid === parent.pid,
      `child runner did not receive an isolated process identity: ${JSON.stringify(observedProcesses)}`
    );
    assertCondition(
      authoritativeFileMutations.some(
        (mutation) =>
          mutation.operation === 'write' &&
          mutation.directProcessCommit &&
          mutation.paths.includes('/workspace/child-owned.txt')
      ),
      `runtime path syscalls did not commit through the authoritative session: ${JSON.stringify(
        authoritativeFileMutations
      )}`
    );
    const events = await workspace.readFile('/proc/tracekernel/events');
    assertCondition(
      events.includes(`process-start\t${child.pid}\t`) &&
        events.includes(`process-zombie\t${child.pid}\t`) &&
        events.includes(`process-reap\t${child.pid}\t`),
      `kernel events did not retain the child lifecycle: ${JSON.stringify(events)}`
    );

    const terminal = workspace.createTerminalSession();
    const terminalResult = await terminal.run('node parent.js');
    assertCondition(
      terminalResult.exitCode === 0 &&
        terminalResult.stdout === 'child-pipe\nchild-file\nchild-exit:7\n',
      `terminal-owned parent/child flow did not complete: ${JSON.stringify(terminalResult)}`
    );
    assertCondition(
      terminalRuntimeCount === 2 && detachedRuntimeCount === 2,
      `controlling-terminal inheritance did not match parent/child execution: ${JSON.stringify({
        terminalRuntimeCount,
        detachedRuntimeCount,
      })}`
    );

    const interruptTerminal = workspace.createTerminalSession();
    const interruptChildStarted = waitForInterruptChildStart();
    const interruptedRun = interruptTerminal.run('node interrupt-parent.js');
    await interruptChildStarted;
    assertCondition(
      interruptTerminal.interrupt() &&
        !interruptTerminal.interrupt(),
      'terminal interrupt should target its foreground process group exactly once'
    );
    const interruptedResult = await interruptedRun;
    assertCondition(
      interruptedResult.exitCode === 130 &&
        interruptedResult.error?.detail?.signal === 'SIGINT',
      `terminal foreground process-group interrupt did not own parent termination: ${JSON.stringify(
        interruptedResult
      )}`
    );
    assertCondition(
      terminalInterruptSignals.length === 2 &&
        terminalInterruptSignals.every((delivery) =>
          delivery.signal === 'SIGINT'
        ) &&
        terminalInterruptSignals.some((delivery) =>
          delivery.scriptPath.endsWith('interrupt-parent.js')
        ) &&
        terminalInterruptSignals.some((delivery) =>
          delivery.scriptPath.endsWith('interrupt-child.js')
        ),
      `terminal interrupt did not reach every foreground process-group member: ${JSON.stringify(
        terminalInterruptSignals
      )}`
    );

    const quitTerminal = workspace.createTerminalSession();
    const quitChildStarted = waitForInterruptChildStart();
    const quitRun = quitTerminal.run('node interrupt-parent.js');
    await quitChildStarted;
    const quitDeliveriesStart = terminalInterruptSignals.length;
    assertCondition(
      quitTerminal.writeStdin('\x1c') &&
        !quitTerminal.writeStdin('\x1c'),
      'terminal VQUIT should be consumed and delivered to the foreground group exactly once'
    );
    const quitResult = await quitRun;
    const quitDeliveries = terminalInterruptSignals.slice(
      quitDeliveriesStart
    );
    assertCondition(
      quitResult.exitCode === 131 &&
        quitResult.error?.detail?.signal === 'SIGQUIT' &&
        quitDeliveries.length === 2 &&
        quitDeliveries.every((delivery) => delivery.signal === 'SIGQUIT'),
      `terminal VQUIT did not reach every foreground process-group member: ${JSON.stringify({
        result: quitResult,
        deliveries: quitDeliveries,
      })}`
    );
    const interruptEvents = await workspace.readFile(
      '/proc/tracekernel/events'
    );
    assertCondition(
      interruptEvents.includes('process-group-signal') &&
        interruptEvents.includes('"signal":"SIGINT"') &&
        interruptEvents.includes('"signal":"SIGQUIT"') &&
        interruptEvents.includes('"count":2'),
      `terminal interrupt did not journal authoritative group delivery: ${JSON.stringify(
        interruptEvents
      )}`
    );
    assertCondition(
      authoritativeSession.processSnapshots().length === 0,
      'Completed product runners remained in the authoritative TraceKernel process table.'
    );
  } finally {
    stopWatchingAuthoritativeFileMutations();
    workspace.dispose();
  }

  console.log(JSON.stringify({
    schema: 'tracekernel-013-workspace-processes-v1',
    languageInitiatedSpawn: true,
    kernelOwnedProductPids: true,
    kernelOwnedPathSyscalls: true,
    kernelOwnedDescriptors: true,
    distinctRuntimeProcessIdentity: true,
    processOwnedPipeInheritance: true,
    sharedFilesystemAcrossParentAndChild: true,
    exactlyOnceChildReaping: true,
    controllingTerminalInheritedByChildren: true,
    detachedCommandsReportEnotty: true,
    terminalInterruptTargetsForegroundProcessGroup: true,
    terminalSignalCharacters: ['VINTR', 'VQUIT'],
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

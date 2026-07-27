#!/usr/bin/env npx tsx

import {
  createRuntimeWorkspace,
  type JavaScriptProjectCommandRunner,
} from '../packages/harness-project/src/index';
import type {
  RuntimeKernelSyscallBridge,
  RuntimeProjectCommandRequest,
} from '../packages/harness-core/src/runtime-project';
import {
  createRuntimeCommandStdinPipeFromText,
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
  const killChildStartWaiters: Array<() => void> = [];
  const terminalInputStartWaiters: Array<() => void> = [];
  const terminalEofStartWaiters: Array<() => void> = [];
  let authoritativeSession: TraceKernelSession | undefined;
  const waitForInterruptChildStart = (): Promise<void> =>
    new Promise<void>((resolve) => {
      interruptChildStartWaiters.push(resolve);
    });
  const waitForKillChildStart = (): Promise<void> =>
    new Promise<void>((resolve) => {
      killChildStartWaiters.push(resolve);
    });
  const waitForTerminalInputStart = (): Promise<void> =>
    new Promise<void>((resolve) => {
      terminalInputStartWaiters.push(resolve);
    });
  const waitForTerminalEofStart = (): Promise<void> =>
    new Promise<void>((resolve) => {
      terminalEofStartWaiters.push(resolve);
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
    const identity = await dispatch(kernel, { op: 'identity' });
    assertCondition(
      identity.ok &&
        identity.value.op === 'identity' &&
        identity.value.pid === request.process?.pid &&
        identity.value.ppid === request.process?.ppid &&
        identity.value.pgid === request.process?.pgid &&
        identity.value.sid === request.process?.sid,
      `runtime identity did not come from its authoritative process record: ${JSON.stringify({
        identity,
        process: request.process,
      })}`
    );
    const tty = await dispatch(kernel, { op: 'isatty', fd: 0 });
    const foregroundGroup = await dispatch(kernel, {
      op: 'tcgetpgrp',
      fd: 0,
    });
    if (request.terminal?.isTTY) {
      terminalRuntimeCount += 1;
      const terminalDescriptors = authoritativeProcess?.descriptors.filter(
        (descriptor) => descriptor.fd >= 0 && descriptor.fd <= 2
      );
      const terminalResourceIds = new Set(
        terminalDescriptors?.map((descriptor) => descriptor.resourceId)
      );
      const terminalSnapshot = authoritativeSession?.terminalSnapshots().find(
        (terminal) => terminal.id === authoritativeProcess?.controllingTerminalId
      );
      const foregroundTransfer = await dispatch(kernel, {
        op: 'tcsetpgrp',
        fd: 0,
        pgid: request.process?.pgid ?? -1,
      });
      assertCondition(
        tty.ok &&
          tty.value.op === 'isatty' &&
          tty.value.isTerminal &&
          foregroundGroup.ok &&
          foregroundGroup.value.op === 'tcgetpgrp' &&
          foregroundGroup.value.pgid === request.process?.pgid &&
          terminalDescriptors?.length === 3 &&
          terminalDescriptors.every(
            (descriptor) => descriptor.kind === 'terminal'
          ) &&
          terminalResourceIds.size === 1 &&
          terminalSnapshot?.foregroundProcessGroupId === request.process?.pgid &&
          foregroundTransfer.ok &&
          foregroundTransfer.value.op === 'tcsetpgrp' &&
          foregroundTransfer.value.pgid === request.process?.pgid,
        `terminal process did not receive authoritative foreground state: ${JSON.stringify({
          tty,
          foregroundGroup,
          foregroundTransfer,
          terminalDescriptors,
          terminalSnapshot,
          process: request.process,
        })}`
      );
    } else {
      detachedRuntimeCount += 1;
      const detachedStandardDescriptors =
        authoritativeProcess?.descriptors.filter(
          (descriptor) => descriptor.fd >= 0 && descriptor.fd <= 2
        );
      const detachedStdioKinds = new Map(
        detachedStandardDescriptors?.map((descriptor) => [
          descriptor.fd,
          descriptor.kind,
        ])
      );
      const hasHostAttachedStandardIo =
        detachedStdioKinds.get(0) === 'pipe-reader' &&
        detachedStdioKinds.get(1) === 'pipe-writer' &&
        detachedStdioKinds.get(2) === 'pipe-writer';
      const hasNullStandardIo = detachedStandardDescriptors?.every(
        (descriptor) => descriptor.kind === 'device'
      );
      assertCondition(
        tty.ok &&
          tty.value.op === 'isatty' &&
          !tty.value.isTerminal &&
          !foregroundGroup.ok &&
          foregroundGroup.error.code === 'ENOTTY' &&
          detachedStandardDescriptors?.length === 3 &&
          (
            request.process?.ppid === 1
              ? hasHostAttachedStandardIo
              : hasNullStandardIo
          ),
        `detached process standard descriptors did not match its host/child boundary: ${JSON.stringify({
          tty,
          foregroundGroup,
          detachedStandardDescriptors,
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
    if (request.scriptPath.endsWith('topology-child.js')) {
      const createdSession = await dispatch(kernel, { op: 'setsid' });
      const detachedIdentity = await dispatch(kernel, { op: 'identity' });
      const kernelSnapshot = authoritativeSession?.processSnapshots().find(
        (process) => process.pid === request.process?.pid
      );
      assertCondition(
        createdSession.ok &&
          createdSession.value.op === 'setsid' &&
          createdSession.value.sid === request.process?.pid &&
          createdSession.value.pgid === request.process?.pid &&
          detachedIdentity.ok &&
          detachedIdentity.value.op === 'identity' &&
          detachedIdentity.value.sid === request.process?.pid &&
          detachedIdentity.value.pgid === request.process?.pid &&
          kernelSnapshot?.sid === request.process?.pid &&
          kernelSnapshot.pgid === request.process?.pid &&
          kernelSnapshot.controllingTerminalId === undefined,
        `setsid did not update the authoritative process topology: ${JSON.stringify({
          createdSession,
          detachedIdentity,
          kernelSnapshot,
        })}`
      );
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (request.scriptPath.endsWith('kill-child.js')) {
      killChildStartWaiters.shift()?.();
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) {
          resolve();
          return;
        }
        request.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (request.scriptPath.endsWith('terminal-input.js')) {
      terminalInputStartWaiters.shift()?.();
      const input = await dispatch(kernel, {
        op: 'read',
        fd: 0,
        maxBytes: 64,
      });
      assertCondition(
        input.ok &&
          input.value.op === 'read' &&
          new TextDecoder().decode(input.value.bytes) === 'kernel-input',
        `terminal input did not cross the kernel-owned fd 0: ${JSON.stringify(input)}`
      );
      return {
        stdout: 'kernel-input\n',
        stderr: '',
        exitCode: 0,
      };
    }
    if (request.scriptPath.endsWith('terminal-output.js')) {
      const stdout = await dispatch(kernel, {
        op: 'write',
        fd: 1,
        bytes: new TextEncoder().encode('kernel-stdout\n'),
      });
      const stderr = await dispatch(kernel, {
        op: 'write',
        fd: 2,
        bytes: new TextEncoder().encode('kernel-stderr\n'),
      });
      assertCondition(
        stdout.ok &&
          stdout.value.op === 'write' &&
          stdout.value.bytesWritten === 14 &&
          stderr.ok &&
          stderr.value.op === 'write' &&
          stderr.value.bytesWritten === 14,
        `terminal output did not cross kernel fd 1/2: ${JSON.stringify({
          stdout,
          stderr,
        })}`
      );
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (request.scriptPath.endsWith('terminal-eof.js')) {
      terminalEofStartWaiters.shift()?.();
      const input = await dispatch(kernel, {
        op: 'read',
        fd: 0,
        maxBytes: 64,
      });
      assertCondition(
        input.ok &&
          input.value.op === 'read' &&
          input.value.bytes.byteLength === 0,
        `terminal EOF did not produce a one-shot fd 0 EOF: ${JSON.stringify(input)}`
      );
      return { stdout: 'kernel-eof\n', stderr: '', exitCode: 0 };
    }
    if (request.scriptPath.endsWith('detached-stdio.js')) {
      assertCondition(
        request.stdinPipe === undefined,
        'descriptor-capable JavaScript received the legacy stdin transport'
      );
      const input = await dispatch(kernel, {
        op: 'read',
        fd: 0,
        maxBytes: 64,
      });
      const eof = await dispatch(kernel, {
        op: 'read',
        fd: 0,
        maxBytes: 64,
      });
      const stdout = await dispatch(kernel, {
        op: 'write',
        fd: 1,
        bytes: new TextEncoder().encode('detached-stdout\n'),
      });
      const stderr = await dispatch(kernel, {
        op: 'write',
        fd: 2,
        bytes: new TextEncoder().encode('detached-stderr\n'),
      });
      assertCondition(
        input.ok &&
          input.value.op === 'read' &&
          new TextDecoder().decode(input.value.bytes) === 'detached-input' &&
          eof.ok &&
          eof.value.op === 'read' &&
          eof.value.bytes.byteLength === 0 &&
          stdout.ok &&
          stdout.value.op === 'write' &&
          stdout.value.bytesWritten === 16 &&
          stderr.ok &&
          stderr.value.op === 'write' &&
          stderr.value.bytesWritten === 16,
        `detached stdio did not cross kernel fd 0/1/2: ${JSON.stringify({
          input,
          eof,
          stdout,
          stderr,
        })}`
      );
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

    const armedWatchdog = await dispatch(kernel, {
      op: 'watchdog',
      action: 'arm',
      timeoutMs: 5_000,
      signal: 'SIGKILL',
    });
    const watchdogStatus = await dispatch(kernel, {
      op: 'watchdog',
      action: 'status',
    });
    const pettedWatchdog = await dispatch(kernel, {
      op: 'watchdog',
      action: 'pet',
    });
    const disarmedWatchdog = await dispatch(kernel, {
      op: 'watchdog',
      action: 'disarm',
    });
    const disarmedStatus = await dispatch(kernel, {
      op: 'watchdog',
      action: 'status',
    });
    assertCondition(
      armedWatchdog.ok &&
        armedWatchdog.value.op === 'watchdog' &&
        armedWatchdog.value.armed &&
        armedWatchdog.value.timeoutMs === 5_000 &&
        armedWatchdog.value.signal === 'SIGKILL' &&
        watchdogStatus.ok &&
        watchdogStatus.value.op === 'watchdog' &&
        watchdogStatus.value.armed &&
        pettedWatchdog.ok &&
        pettedWatchdog.value.op === 'watchdog' &&
        pettedWatchdog.value.armed &&
        (pettedWatchdog.value.deadlineAt ?? 0) >=
          (watchdogStatus.value.deadlineAt ?? 0) &&
        disarmedWatchdog.ok &&
        disarmedWatchdog.value.op === 'watchdog' &&
        !disarmedWatchdog.value.armed &&
        disarmedStatus.ok &&
        disarmedStatus.value.op === 'watchdog' &&
        !disarmedStatus.value.armed &&
        authoritativeSession?.processSnapshots().find(
          (process) => process.pid === request.process?.pid
        )?.watchdog === undefined,
      `runtime watchdog state was not owned by its kernel process: ${JSON.stringify({
        armedWatchdog,
        watchdogStatus,
        pettedWatchdog,
        disarmedWatchdog,
        disarmedStatus,
      })}`
    );

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
    const topologyChild = await dispatch(kernel, {
      op: 'spawn',
      runtime: 'javascript',
      command: 'node',
      args: ['topology-child.js'],
    });
    assertCondition(
      topologyChild.ok && topologyChild.value.op === 'spawn',
      `parent could not spawn its topology child: ${JSON.stringify(topologyChild)}`
    );
    if (!topologyChild.ok || topologyChild.value.op !== 'spawn') {
      return { stdout: '', stderr: 'topology spawn failed\n', exitCode: 1 };
    }
    const topologyWait = await dispatch(kernel, {
      op: 'wait',
      pid: topologyChild.value.pid,
    });
    assertCondition(
      topologyWait.ok &&
        topologyWait.value.op === 'wait' &&
        topologyWait.value.termination?.kind === 'exit' &&
        topologyWait.value.termination.exitCode === 0,
      `detached topology child did not exit cleanly: ${JSON.stringify(topologyWait)}`
    );

    const killChildStarted = waitForKillChildStart();
    const killChild = await dispatch(kernel, {
      op: 'spawn',
      runtime: 'javascript',
      command: 'node',
      args: ['kill-child.js'],
    });
    assertCondition(
      killChild.ok && killChild.value.op === 'spawn',
      `parent could not spawn its signal target: ${JSON.stringify(killChild)}`
    );
    if (!killChild.ok || killChild.value.op !== 'spawn') {
      return { stdout: '', stderr: 'kill spawn failed\n', exitCode: 1 };
    }
    await killChildStarted;
    const killed = await dispatch(kernel, {
      op: 'kill',
      pid: killChild.value.pid,
      signal: 'SIGTERM',
    });
    const killedWait = await dispatch(kernel, {
      op: 'wait',
      pid: killChild.value.pid,
    });
    assertCondition(
      killed.ok &&
        killed.value.op === 'kill' &&
        killedWait.ok &&
        killedWait.value.op === 'wait' &&
        killedWait.value.termination?.kind === 'signal' &&
        killedWait.value.termination.signal === 'SIGTERM',
      `kernel signal delivery did not own child termination: ${JSON.stringify({
        killed,
        killedWait,
      })}`
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
      {
        path: 'topology-child.js',
        contents: '// authoritative setsid fixture\n',
      },
      {
        path: 'kill-child.js',
        contents: '// authoritative signal-delivery fixture\n',
      },
      {
        path: 'terminal-input.js',
        contents: '// authoritative terminal-input fixture\n',
      },
      {
        path: 'terminal-output.js',
        contents: '// authoritative terminal-output fixture\n',
      },
      {
        path: 'terminal-eof.js',
        contents: '// authoritative terminal-EOF fixture\n',
      },
      {
        path: 'detached-stdio.js',
        contents: '// authoritative detached-stdio fixture\n',
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
    const detachedEvents: Array<{
      type: string;
      stream?: string;
      data?: string;
      actor?: { id?: string };
    }> = [];
    const detachedStdioResult = await workspace.runCommand(
      'node detached-stdio.js',
      {
        stdinPipe: createRuntimeCommandStdinPipeFromText('detached-input'),
        onEvent: (event) => {
          detachedEvents.push(event);
        },
      }
    );
    assertCondition(
      detachedStdioResult.exitCode === 0 &&
        detachedStdioResult.stdout === 'detached-stdout\n' &&
        detachedStdioResult.stderr === 'detached-stderr\n' &&
        detachedEvents.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stdout' &&
            event.data === 'detached-stdout\n' &&
            typeof event.actor?.id === 'string'
        ) &&
        detachedEvents.some(
          (event) =>
            event.type === 'output' &&
            event.stream === 'stderr' &&
            event.data === 'detached-stderr\n' &&
            typeof event.actor?.id === 'string'
        ),
      `detached host stdio was not captured at the kernel boundary: ${JSON.stringify({
        result: detachedStdioResult,
        events: detachedEvents,
      })}`
    );

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
    terminal.resize(132, 48);
    const resizedKernelTerminal = authoritativeSession.terminalSnapshots()[0];
    assertCondition(
      resizedKernelTerminal?.columns === 132 &&
        resizedKernelTerminal.rows === 48,
      `terminal resize did not update the authoritative terminal resource: ${JSON.stringify(
        resizedKernelTerminal
      )}`
    );
    const terminalInputStarted = waitForTerminalInputStart();
    const terminalInputRun = terminal.run('node terminal-input.js');
    await terminalInputStarted;
    assertCondition(
      terminal.writeStdin('kernel-input'),
      'terminal input was not accepted by the kernel terminal bridge'
    );
    const terminalInputResult = await terminalInputRun;
    assertCondition(
      terminalInputResult.exitCode === 0 &&
        terminalInputResult.stdout === 'kernel-input\n',
      `kernel terminal fd 0 did not drive the runtime: ${JSON.stringify(
        terminalInputResult
      )}`
    );
    const terminalOutputResult = await terminal.run('node terminal-output.js');
    assertCondition(
      terminalOutputResult.exitCode === 0 &&
        terminalOutputResult.stdout === 'kernel-stdout\n' &&
        terminalOutputResult.stderr === 'kernel-stderr\n',
      `kernel terminal fd 1/2 did not publish attributed output: ${JSON.stringify(
        terminalOutputResult
      )}`
    );
    const terminalEofStarted = waitForTerminalEofStart();
    const terminalEofRun = terminal.run('node terminal-eof.js');
    await terminalEofStarted;
    assertCondition(
      terminal.endStdin() && !terminal.endStdin(),
      'terminal EOF should be delivered to the active command exactly once'
    );
    const terminalEofResult = await terminalEofRun;
    assertCondition(
      terminalEofResult.exitCode === 0 &&
        terminalEofResult.stdout === 'kernel-eof\n',
      `kernel terminal EOF did not release fd 0: ${JSON.stringify(
        terminalEofResult
      )}`
    );
    const reusableInputStarted = waitForTerminalInputStart();
    const reusableInputRun = terminal.run('node terminal-input.js');
    await reusableInputStarted;
    assertCondition(
      terminal.writeStdin('kernel-input'),
      'terminal did not accept input after a one-shot EOF'
    );
    const reusableInputResult = await reusableInputRun;
    assertCondition(
      reusableInputResult.exitCode === 0 &&
        reusableInputResult.stdout === 'kernel-input\n',
      `terminal EOF incorrectly closed later input: ${JSON.stringify(
        reusableInputResult
      )}`
    );
    assertCondition(
      terminalRuntimeCount === 8 && detachedRuntimeCount === 5,
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
    kernelOwnedProcessControls: true,
    kernelOwnedTerminalDescriptors: true,
    kernelOwnedWatchdogs: true,
    distinctRuntimeProcessIdentity: true,
    processOwnedPipeInheritance: true,
    sharedFilesystemAcrossParentAndChild: true,
    kernelOwnedWaitRecords: true,
    exactlyOnceChildReaping: true,
    controllingTerminalInheritedByChildren: true,
    detachedCommandsReportEnotty: true,
    terminalInterruptTargetsForegroundProcessGroup: true,
    kernelOwnedTerminalResize: true,
    kernelOwnedTerminalInput: true,
    kernelOwnedTerminalOutput: true,
    kernelOwnedTerminalEof: true,
    kernelOwnedDetachedStdio: true,
    terminalSignalCharacters: ['VINTR', 'VQUIT'],
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

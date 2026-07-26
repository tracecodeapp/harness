#!/usr/bin/env npx tsx

import {
  createRuntimeWorkspace,
  type JavaScriptProjectCommandRunner,
} from '../packages/harness-project/src/index';
import type {
  RuntimeKernelSyscallBridge,
  RuntimeProjectCommandRequest,
} from '../packages/harness-core/src/runtime-project';

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

async function main(): Promise<void> {
  const observedProcesses: Array<{
    readonly scriptPath: string;
    readonly pid: number;
    readonly ppid: number;
  }> = [];

  const nodeRunner: JavaScriptProjectCommandRunner = async (request) => {
    observedProcesses.push({
      scriptPath: request.scriptPath,
      pid: request.process?.pid ?? -1,
      ppid: request.process?.ppid ?? -1,
    });
    const kernel = syscalls(request);

    if (request.scriptPath.endsWith('child.js')) {
      const writeFd = Number(request.args.at(-1));
      const written = await kernel.dispatch({
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
      const file = await kernel.dispatch({
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

    const pipe = await kernel.dispatch({
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

    const spawned = await kernel.dispatch({
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

    const closedWriter = await kernel.dispatch({
      op: 'close',
      fd: pipe.value.writeFd,
    });
    assertCondition(
      closedWriter.ok,
      `parent could not close its pipe writer: ${JSON.stringify(closedWriter)}`
    );
    const read = await kernel.dispatch({
      op: 'read',
      fd: pipe.value.readFd,
      maxBytes: 64,
    });
    assertCondition(
      read.ok && read.value.op === 'read',
      `parent could not read its child pipe: ${JSON.stringify(read)}`
    );
    const waited = await kernel.dispatch({
      op: 'wait',
      pid: spawned.value.pid,
    });
    assertCondition(
      waited.ok &&
        waited.value.op === 'wait' &&
        waited.value.termination.kind === 'exit' &&
        waited.value.termination.exitCode === 7,
      `parent did not receive its child's exit status: ${JSON.stringify(waited)}`
    );
    const waitedTwice = await kernel.dispatch({
      op: 'wait',
      pid: spawned.value.pid,
    });
    assertCondition(
      !waitedTwice.ok && waitedTwice.error.code === 'ECHILD',
      `reaped child did not return ECHILD: ${JSON.stringify(waitedTwice)}`
    );
    const childFile = await kernel.dispatch({
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
          ? waited.value.termination.exitCode
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
    ],
    nodeRunner,
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
    const events = await workspace.readFile('/proc/tracekernel/events');
    assertCondition(
      events.includes(`process-start\t${child.pid}\t`) &&
        events.includes(`process-zombie\t${child.pid}\t`) &&
        events.includes(`process-reap\t${child.pid}\t`),
      `kernel events did not retain the child lifecycle: ${JSON.stringify(events)}`
    );
  } finally {
    workspace.dispose();
  }

  console.log(JSON.stringify({
    schema: 'tracekernel-013-workspace-processes-v1',
    languageInitiatedSpawn: true,
    distinctRuntimeProcessIdentity: true,
    processOwnedPipeInheritance: true,
    sharedFilesystemAcrossParentAndChild: true,
    exactlyOnceChildReaping: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

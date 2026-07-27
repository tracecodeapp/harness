#!/usr/bin/env npx tsx

import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Option from 'effect/Option';
import {
  makeTraceKernelHost,
  TraceKernelFileSystemError,
  TraceKernelSyscallDispatcher,
  type TraceKernelRuntimeProvider,
  type TraceKernelSyscallResult,
} from '@tracecode/tracekernel';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function success(result: TraceKernelSyscallResult): asserts result is Extract<
  TraceKernelSyscallResult,
  { readonly ok: true }
> {
  assertCondition(result.ok, `Syscall failed: ${JSON.stringify(result)}`);
}

async function main(): Promise<void> {
  const provider: TraceKernelRuntimeProvider = {
    runtime: 'syscall-test',
    initialize: Effect.succeed({
      acquire: (process) =>
        Effect.acquireRelease(
          Effect.succeed({
            id: `syscall-lease-${process.pid}`,
            runtime: 'syscall-test',
            execute: () =>
              process.command === 'syscall-child' ||
              process.command === 'syscall-stdio-child'
                ? Effect.sleep(50).pipe(
                    Effect.as({
                      exitCode: 7,
                      stdout: process.command === 'syscall-stdio-child'
                        ? 'stdio-out\n'
                        : 'child-exit\n',
                      ...(process.command === 'syscall-stdio-child'
                        ? { stderr: 'stdio-error\n' }
                      : {}),
                    })
                  )
                : process.command.startsWith('wait-selector-')
                ? Effect.sleep(
                    process.command === 'wait-selector-group'
                      ? 100
                      : process.command === 'wait-selector-any'
                        ? 150
                        : 200
                  ).pipe(
                    Effect.as({
                      exitCode: process.command === 'wait-selector-group'
                        ? 31
                        : process.command === 'wait-selector-any'
                          ? 32
                          : 33,
                    })
                  )
                : Effect.never,
          }),
          () => Effect.void
        ),
    }),
  };

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const host = yield* makeTraceKernelHost({ providers: [provider] });
      const session = yield* host.openSession();
      const process = yield* session.spawn({
        runtime: 'syscall-test',
        command: 'syscall-client',
        owner: { id: 'runtime-adapter', kind: 'system' },
      });
      const peer = yield* session.spawn({
        runtime: 'syscall-test',
        command: 'syscall-peer',
        owner: { id: 'runtime-peer', kind: 'system' },
      });
      yield* Effect.all([process.awaitStarted(), peer.awaitStarted()], {
        concurrency: 'unbounded',
        discard: true,
      });
      const syscalls = new TraceKernelSyscallDispatcher(session, process);
      const peerSyscalls = new TraceKernelSyscallDispatcher(session, peer);
      const mutableTopologyChild = yield* session.spawn({
        runtime: 'syscall-test',
        command: 'mutable-topology-child',
        parentPid: process.pid,
      });
      yield* mutableTopologyChild.awaitStarted();
      const childTopologySyscalls = new TraceKernelSyscallDispatcher(
        session,
        mutableTopologyChild
      );
      const initialIdentity = yield* childTopologySyscalls.dispatch({
        op: 'identity',
      });
      success(initialIdentity);
      assertCondition(
        initialIdentity.value.op === 'identity' &&
          initialIdentity.value.pid === mutableTopologyChild.pid &&
          initialIdentity.value.ppid === process.pid &&
          initialIdentity.value.pgid === process.snapshot().pgid &&
          initialIdentity.value.sid === process.snapshot().sid,
        `identity did not reflect the authoritative process record: ${JSON.stringify(
          initialIdentity
        )}`
      );
      const parentIdentity = yield* childTopologySyscalls.dispatch({
        op: 'identity',
        pid: process.pid,
      });
      success(parentIdentity);
      assertCondition(
        parentIdentity.value.op === 'identity' &&
          parentIdentity.value.pid === process.pid &&
          parentIdentity.value.ppid === 1,
        `identity could not inspect another visible process in the session: ${JSON.stringify(
          parentIdentity
        )}`
      );
      const createdSession = yield* childTopologySyscalls.dispatch({ op: 'setsid' });
      success(createdSession);
      assertCondition(
        createdSession.value.op === 'setsid' &&
          createdSession.value.sid === mutableTopologyChild.pid &&
          mutableTopologyChild.snapshot().sid === mutableTopologyChild.pid &&
          mutableTopologyChild.snapshot().pgid === mutableTopologyChild.pid,
        `setsid did not atomically create a session and process group: ${JSON.stringify(
          createdSession
        )}`
      );
      const sessionLeaderGroupChange = yield* childTopologySyscalls.dispatch({
        op: 'setpgid',
        pid: 0,
        pgid: 0,
      });
      assertCondition(
        !sessionLeaderGroupChange.ok &&
          sessionLeaderGroupChange.error.code === 'EPERM',
        `setpgid allowed a session leader to change process group: ${JSON.stringify(
          sessionLeaderGroupChange
        )}`
      );
      success(yield* syscalls.dispatch({
        op: 'kill',
        pid: mutableTopologyChild.pid,
        signal: 'SIGTERM',
      }));
      success(yield* syscalls.dispatch({
        op: 'wait',
        pid: mutableTopologyChild.pid,
      }));
      const processCountBeforeInvalidTopology = session.processSnapshots().length;
      const invalidGroup = yield* syscalls.dispatch({
        op: 'spawn',
        runtime: 'syscall-test',
        command: 'invalid-process-group',
        processGroupId: 999_999,
      });
      assertCondition(
        !invalidGroup.ok &&
          invalidGroup.error.code === 'EINVAL' &&
          session.processSnapshots().length === processCountBeforeInvalidTopology,
        `spawn admitted a nonexistent process group: ${JSON.stringify(invalidGroup)}`
      );
      const invalidSession = yield* syscalls.dispatch({
        op: 'spawn',
        runtime: 'syscall-test',
        command: 'invalid-session',
        sessionId: process.pid + 999,
      });
      assertCondition(
        !invalidSession.ok &&
          invalidSession.error.code === 'EINVAL' &&
          session.processSnapshots().length === processCountBeforeInvalidTopology,
        `spawn admitted a child into a foreign session: ${JSON.stringify(invalidSession)}`
      );
      const newSessionChild = yield* syscalls.dispatch({
        op: 'spawn',
        runtime: 'syscall-test',
        command: 'new-session-child',
        sessionId: 0,
      });
      success(newSessionChild);
      if (newSessionChild.value.op !== 'spawn') {
        throw new Error(`new-session spawn returned ${newSessionChild.value.op}`);
      }
      const newSessionPid = newSessionChild.value.pid;
      assertCondition(
        session.processSnapshots().some((snapshot) =>
            snapshot.pid === newSessionPid &&
            snapshot.sid === snapshot.pid &&
            snapshot.pgid === snapshot.pid
          ),
        `setsid-style spawn did not become both session and group leader: ${JSON.stringify(
          newSessionChild
        )}`
      );
      success(yield* syscalls.dispatch({
        op: 'kill',
        pid: newSessionPid,
        signal: 'SIGTERM',
      }));
      success(yield* syscalls.dispatch({
        op: 'wait',
        pid: newSessionPid,
      }));

      const pipe = yield* syscalls.dispatch({
        op: 'pipe',
        options: { capacityChunks: 2 },
      });
      success(pipe);
      assertCondition(pipe.value.op === 'pipe', 'pipe returned the wrong response variant.');
      if (pipe.value.op !== 'pipe') return;
      const setCloseOnExec = yield* syscalls.dispatch({
        op: 'fcntl',
        fd: pipe.value.readFd,
        action: 'set-close-on-exec',
        closeOnExec: true,
      });
      success(setCloseOnExec);
      const getCloseOnExec = yield* syscalls.dispatch({
        op: 'fcntl',
        fd: pipe.value.readFd,
        action: 'get-close-on-exec',
      });
      success(getCloseOnExec);
      assertCondition(
        getCloseOnExec.value.op === 'fcntl' &&
          getCloseOnExec.value.closeOnExec,
        `fcntl did not preserve FD_CLOEXEC: ${JSON.stringify(getCloseOnExec)}`
      );
      const emptyPipePoll = yield* syscalls.dispatch({
        op: 'poll',
        entries: [{ fd: pipe.value.readFd, read: true }],
        timeoutMs: 0,
      });
      success(emptyPipePoll);
      assertCondition(
        emptyPipePoll.value.op === 'poll' &&
          emptyPipePoll.value.entries.length === 0,
        `poll reported an empty pipe reader as readable: ${JSON.stringify(emptyPipePoll)}`
      );
      const writablePipePoll = yield* syscalls.dispatch({
        op: 'poll',
        entries: [{ fd: pipe.value.writeFd, write: true }],
        timeoutMs: 0,
      });
      success(writablePipePoll);
      assertCondition(
        writablePipePoll.value.op === 'poll' &&
          writablePipePoll.value.entries.length === 1 &&
          writablePipePoll.value.entries[0]?.write === true,
        `poll did not report pipe capacity as writable: ${JSON.stringify(writablePipePoll)}`
      );
      const waitingPipePoll = yield* Effect.fork(syscalls.dispatch({
        op: 'poll',
        entries: [{ fd: pipe.value.readFd, read: true }],
        timeoutMs: 1_000,
      }));
      yield* Effect.yieldNow();
      assertCondition(
        Option.isNone(yield* Fiber.poll(waitingPipePoll)),
        'poll returned before the requested pipe event occurred.'
      );
      const pipeWrite = yield* syscalls.dispatch({
        op: 'write',
        fd: pipe.value.writeFd,
        bytes: new TextEncoder().encode('pipe-wire'),
      });
      success(pipeWrite);
      const awakenedPipePoll = yield* Fiber.join(waitingPipePoll);
      success(awakenedPipePoll);
      assertCondition(
        awakenedPipePoll.value.op === 'poll' &&
          awakenedPipePoll.value.entries.length === 1 &&
          awakenedPipePoll.value.entries[0]?.read === true,
        `a pipe write did not wake a blocked poll: ${JSON.stringify(awakenedPipePoll)}`
      );
      const pipeRead = yield* syscalls.dispatch({
        op: 'read',
        fd: pipe.value.readFd,
        maxBytes: 64,
      });
      success(pipeRead);
      assertCondition(
        pipeRead.value.op === 'read' &&
          new TextDecoder().decode(pipeRead.value.bytes) === 'pipe-wire',
        `pipe bytes changed across the dispatcher: ${JSON.stringify(pipeRead)}`
      );

      const spawned = yield* syscalls.dispatch({
        op: 'spawn',
        runtime: 'syscall-test',
        command: 'syscall-child',
        args: ['one', 'two'],
        cwd: '/workspace/child',
        env: { CHILD_VALUE: 'isolated' },
        inheritDescriptors: [pipe.value.readFd, pipe.value.writeFd],
      });
      success(spawned);
      assertCondition(spawned.value.op === 'spawn', 'spawn returned the wrong response variant.');
      if (spawned.value.op !== 'spawn') return;
      const childPid = spawned.value.pid;
      const pending = yield* syscalls.dispatch({
        op: 'wait',
        pid: childPid,
        noHang: true,
      });
      success(pending);
      assertCondition(
        pending.value.op === 'wait' &&
          pending.value.pid === childPid &&
          pending.value.termination === undefined,
        `nonblocking wait reaped or blocked on a running child: ${JSON.stringify(pending)}`
      );
      const pipeReadFd = pipe.value.readFd;
      const pipeWriteFd = pipe.value.writeFd;
      const childSnapshot = session.processSnapshots().find(
        (snapshot) => snapshot.pid === childPid
      );
      assertCondition(
        childSnapshot?.ppid === process.pid &&
          childSnapshot.cwd === '/workspace/child' &&
          childSnapshot.env.CHILD_VALUE === 'isolated' &&
          childSnapshot.descriptors.some((descriptor) => descriptor.fd === pipeReadFd) &&
          childSnapshot.descriptors.some((descriptor) => descriptor.fd === pipeWriteFd),
        `spawn did not preserve child topology, environment, or inherited descriptors: ${JSON.stringify(childSnapshot)}`
      );
      const waited = yield* syscalls.dispatch({
        op: 'wait',
        pid: childPid,
      });
      success(waited);
      assertCondition(
        waited.value.op === 'wait' &&
          waited.value.pid === childPid &&
          waited.value.termination?.kind === 'exit' &&
          waited.value.termination.exitCode === 7,
        `wait returned the wrong child termination: ${JSON.stringify(waited)}`
      );
      const reaped = yield* syscalls.dispatch({
        op: 'wait',
        pid: childPid,
      });
      assertCondition(
        !reaped.ok && reaped.error.code === 'ECHILD',
        `waiting twice did not return ECHILD: ${JSON.stringify(reaped)}`
      );
      const waitGroupChild = yield* syscalls.dispatch({
        op: 'spawn',
        runtime: 'syscall-test',
        command: 'wait-selector-group',
        processGroupId: 0,
      });
      const waitAnyChild = yield* syscalls.dispatch({
        op: 'spawn',
        runtime: 'syscall-test',
        command: 'wait-selector-any',
      });
      const waitExactChild = yield* syscalls.dispatch({
        op: 'spawn',
        runtime: 'syscall-test',
        command: 'wait-selector-exact',
      });
      success(waitGroupChild);
      success(waitAnyChild);
      success(waitExactChild);
      if (
        waitGroupChild.value.op !== 'spawn' ||
        waitAnyChild.value.op !== 'spawn' ||
        waitExactChild.value.op !== 'spawn'
      ) return;
      const noCompletedChild = yield* syscalls.dispatch({
        op: 'wait',
        pid: -1,
        noHang: true,
      });
      success(noCompletedChild);
      assertCondition(
        noCompletedChild.value.op === 'wait' &&
          noCompletedChild.value.pid === -1 &&
          noCompletedChild.value.termination === undefined,
        `waitpid(-1, WNOHANG) did not report no completed child: ${JSON.stringify(
          noCompletedChild
        )}`
      );
      const waitedParentGroup = yield* syscalls.dispatch({
        op: 'wait',
        pid: 0,
      });
      success(waitedParentGroup);
      assertCondition(
        waitedParentGroup.value.op === 'wait' &&
          waitedParentGroup.value.pid === waitAnyChild.value.pid &&
          waitedParentGroup.value.termination?.kind === 'exit' &&
          waitedParentGroup.value.termination.exitCode === 32,
        `waitpid(0) selected a child outside the caller's process group: ${JSON.stringify(
          waitedParentGroup
        )}`
      );
      const waitedNamedGroup = yield* syscalls.dispatch({
        op: 'wait',
        pid: -waitGroupChild.value.pid,
      });
      success(waitedNamedGroup);
      assertCondition(
        waitedNamedGroup.value.op === 'wait' &&
          waitedNamedGroup.value.pid === waitGroupChild.value.pid &&
          waitedNamedGroup.value.termination?.kind === 'exit' &&
          waitedNamedGroup.value.termination.exitCode === 31,
        `waitpid(-pgid) selected the wrong child: ${JSON.stringify(
          waitedNamedGroup
        )}`
      );
      const waitedAnyChild = yield* syscalls.dispatch({
        op: 'wait',
        pid: -1,
      });
      success(waitedAnyChild);
      assertCondition(
        waitedAnyChild.value.op === 'wait' &&
          waitedAnyChild.value.pid === waitExactChild.value.pid &&
          waitedAnyChild.value.termination?.kind === 'exit' &&
          waitedAnyChild.value.termination.exitCode === 33,
        `waitpid(-1) did not reap the remaining child: ${JSON.stringify(
          waitedAnyChild
        )}`
      );
      const concurrentChildA = yield* syscalls.dispatch({
        op: 'spawn',
        runtime: 'syscall-test',
        command: 'wait-selector-concurrent-a',
      });
      const concurrentChildB = yield* syscalls.dispatch({
        op: 'spawn',
        runtime: 'syscall-test',
        command: 'wait-selector-concurrent-b',
      });
      success(concurrentChildA);
      success(concurrentChildB);
      if (
        concurrentChildA.value.op !== 'spawn' ||
        concurrentChildB.value.op !== 'spawn'
      ) return;
      const concurrentWaitA = yield* Effect.fork(syscalls.dispatch({
        op: 'wait',
        pid: -1,
      }));
      const concurrentWaitB = yield* Effect.fork(syscalls.dispatch({
        op: 'wait',
        pid: -1,
      }));
      const concurrentWaitResults = yield* Effect.all([
        Fiber.join(concurrentWaitA),
        Fiber.join(concurrentWaitB),
      ], { concurrency: 'unbounded' });
      const concurrentlyReapedPids = concurrentWaitResults.flatMap((result) => {
        success(result);
        return result.value.op === 'wait' ? [result.value.pid] : [];
      });
      assertCondition(
        new Set(concurrentlyReapedPids).size === 2 &&
          concurrentlyReapedPids.includes(concurrentChildA.value.pid) &&
          concurrentlyReapedPids.includes(concurrentChildB.value.pid),
        `concurrent waitpid(-1) callers reaped the same child: ${JSON.stringify(
          concurrentWaitResults
        )}`
      );
      const noChildrenRemain = yield* syscalls.dispatch({
        op: 'wait',
        pid: -1,
        noHang: true,
      });
      assertCondition(
        !noChildrenRemain.ok && noChildrenRemain.error.code === 'ECHILD',
        `waitpid(-1) did not report ECHILD after all children were reaped: ${JSON.stringify(
          noChildrenRemain
        )}`
      );
      success(yield* syscalls.dispatch({ op: 'close', fd: pipe.value.writeFd }));
      const hungUpPipePoll = yield* syscalls.dispatch({
        op: 'poll',
        entries: [{ fd: pipe.value.readFd, read: true }],
        timeoutMs: 0,
      });
      success(hungUpPipePoll);
      assertCondition(
        hungUpPipePoll.value.op === 'poll' &&
          hungUpPipePoll.value.entries.length === 1 &&
          hungUpPipePoll.value.entries[0]?.read === true &&
          hungUpPipePoll.value.entries[0]?.hangup === true,
        `poll did not report EOF and HUP after the final writer closed: ${JSON.stringify(
          hungUpPipePoll
        )}`
      );
      const invalidPipePoll = yield* syscalls.dispatch({
        op: 'poll',
        entries: [{ fd: 999_999, read: true }],
        timeoutMs: 1_000,
      });
      success(invalidPipePoll);
      assertCondition(
        invalidPipePoll.value.op === 'poll' &&
          invalidPipePoll.value.entries.length === 1 &&
          invalidPipePoll.value.entries[0]?.invalid === true,
        `poll did not return POLLNVAL-style readiness: ${JSON.stringify(invalidPipePoll)}`
      );
      success(yield* syscalls.dispatch({ op: 'close', fd: pipe.value.readFd }));

      const stdioChild = yield* syscalls.dispatch({
        op: 'spawn',
        runtime: 'syscall-test',
        command: 'syscall-stdio-child',
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      });
      success(stdioChild);
      assertCondition(
        stdioChild.value.op === 'spawn' &&
          stdioChild.value.stdio?.stdinFd !== undefined &&
          stdioChild.value.stdio.stdoutFd !== undefined &&
          stdioChild.value.stdio.stderrFd !== undefined,
        `spawn did not return parent-owned stdio descriptors: ${JSON.stringify(stdioChild)}`
      );
      if (stdioChild.value.op !== 'spawn' || !stdioChild.value.stdio) return;
      const stdioChildPid = stdioChild.value.pid;
      const stdioSnapshot = session.processSnapshots().find(
        ({ pid }) => pid === stdioChildPid
      );
      assertCondition(
        [0, 1, 2].every((fd) =>
          stdioSnapshot?.descriptors.some((descriptor) => descriptor.fd === fd)
        ),
        `child stdio endpoints were not installed before execution: ${JSON.stringify(stdioSnapshot)}`
      );
      success(yield* syscalls.dispatch({
        op: 'write',
        fd: stdioChild.value.stdio.stdinFd!,
        bytes: new TextEncoder().encode('stdio-input'),
      }));
      success(yield* syscalls.dispatch({
        op: 'close',
        fd: stdioChild.value.stdio.stdinFd!,
      }));
      const [stdioOut, stdioError] = yield* Effect.all([
        syscalls.dispatch({
          op: 'read',
          fd: stdioChild.value.stdio.stdoutFd!,
          maxBytes: 64,
        }),
        syscalls.dispatch({
          op: 'read',
          fd: stdioChild.value.stdio.stderrFd!,
          maxBytes: 64,
        }),
      ], { concurrency: 'unbounded' });
      success(stdioOut);
      success(stdioError);
      assertCondition(
        stdioOut.value.op === 'read' &&
          stdioError.value.op === 'read' &&
          new TextDecoder().decode(stdioOut.value.bytes) === 'stdio-out\n' &&
          new TextDecoder().decode(stdioError.value.bytes) === 'stdio-error\n',
        `child output did not cross process-owned stdio pipes: ${JSON.stringify({
          stdioOut,
          stdioError,
        })}`
      );
      success(yield* syscalls.dispatch({
        op: 'wait',
        pid: stdioChild.value.pid,
      }));
      for (const fd of [
        stdioChild.value.stdio.stdoutFd!,
        stdioChild.value.stdio.stderrFd!,
      ]) {
        const eof = yield* syscalls.dispatch({ op: 'read', fd, maxBytes: 1 });
        success(eof);
        assertCondition(
          eof.value.op === 'read' && eof.value.bytes.byteLength === 0,
          `closed child stdio writer did not produce EOF: ${JSON.stringify(eof)}`
        );
        success(yield* syscalls.dispatch({ op: 'close', fd }));
      }

      const blockedChild = yield* syscalls.dispatch({
        op: 'spawn',
        runtime: 'syscall-test',
        command: 'syscall-child-blocked',
      });
      success(blockedChild);
      assertCondition(
        blockedChild.value.op === 'spawn',
        'blocked child spawn returned the wrong response variant.'
      );
      if (blockedChild.value.op !== 'spawn') return;
      success(yield* syscalls.dispatch({
        op: 'kill',
        pid: blockedChild.value.pid,
        signal: 'SIGTERM',
      }));
      const killedChild = yield* syscalls.dispatch({
        op: 'wait',
        pid: blockedChild.value.pid,
      });
      success(killedChild);
      assertCondition(
        killedChild.value.op === 'wait' &&
          killedChild.value.termination?.kind === 'signal' &&
          killedChild.value.termination.signal === 'SIGTERM' &&
          killedChild.value.termination.exitCode === 143,
        `kernel kill/wait lost child signal status: ${JSON.stringify(killedChild)}`
      );

      const mkdir = yield* syscalls.dispatch({
        op: 'mkdir',
        path: 'wire',
      });
      success(mkdir);
      assertCondition(mkdir.value.op === 'mkdir', 'mkdir returned the wrong response variant.');

      const opened = yield* syscalls.dispatch({
        op: 'open',
        path: 'wire/original.txt',
        options: { access: 'read-write', create: true, truncate: true },
      });
      success(opened);
      assertCondition(opened.value.op === 'open', 'open returned the wrong response variant.');
      if (opened.value.op !== 'open') return;

      const fd = opened.value.fd;
      const written = yield* syscalls.dispatch({
        op: 'write',
        fd,
        bytes: new TextEncoder().encode('wire-contract'),
      });
      success(written);
      assertCondition(
        written.value.op === 'write' && written.value.bytesWritten === 13,
        `write returned the wrong response: ${JSON.stringify(written)}`
      );

      const positioned = yield* syscalls.dispatch({
        op: 'read',
        fd,
        maxBytes: 4,
        position: 5,
      });
      success(positioned);
      assertCondition(
        positioned.value.op === 'read' &&
          new TextDecoder().decode(positioned.value.bytes) === 'cont',
        `Positioned read returned the wrong bytes: ${JSON.stringify(positioned)}`
      );

      const descriptorStat = yield* syscalls.dispatch({ op: 'fstat', fd });
      success(descriptorStat);
      assertCondition(
        descriptorStat.value.op === 'fstat' && descriptorStat.value.stat.size === 13,
        `fstat returned the wrong response: ${JSON.stringify(descriptorStat)}`
      );

      const truncated = yield* syscalls.dispatch({ op: 'ftruncate', fd, length: 4 });
      success(truncated);
      assertCondition(
        truncated.value.op === 'ftruncate',
        `ftruncate returned the wrong response: ${JSON.stringify(truncated)}`
      );

      yield* syscalls.dispatch({ op: 'close', fd });
      const renamed = yield* syscalls.dispatch({
        op: 'rename',
        sourcePath: 'wire/original.txt',
        destinationPath: 'wire/renamed.txt',
      });
      success(renamed);
      assertCondition(renamed.value.op === 'rename', 'rename returned the wrong response variant.');

      const listed = yield* syscalls.dispatch({ op: 'readdir', path: 'wire' });
      success(listed);
      assertCondition(
        listed.value.op === 'readdir' &&
          listed.value.entries.length === 1 &&
          listed.value.entries[0]?.name === 'renamed.txt',
        `readdir returned the wrong response: ${JSON.stringify(listed)}`
      );

      const stat = yield* syscalls.dispatch({ op: 'stat', path: 'wire/renamed.txt' });
      success(stat);
      assertCondition(
        stat.value.op === 'stat' &&
          stat.value.stat.kind === 'file' &&
          stat.value.stat.size === 4,
        `stat returned the wrong response: ${JSON.stringify(stat)}`
      );

      const linked = yield* syscalls.dispatch({
        op: 'link',
        existingPath: 'wire/renamed.txt',
        newPath: 'wire/hard.txt',
      });
      success(linked);
      const symlinked = yield* syscalls.dispatch({
        op: 'symlink',
        target: 'hard.txt',
        linkPath: 'wire/link.txt',
      });
      success(symlinked);
      const linkStat = yield* syscalls.dispatch({
        op: 'lstat',
        path: 'wire/link.txt',
      });
      success(linkStat);
      assertCondition(
        linkStat.value.op === 'lstat' &&
          linkStat.value.stat.kind === 'symlink',
        `lstat returned the wrong symlink response: ${JSON.stringify(linkStat)}`
      );
      const readlink = yield* syscalls.dispatch({
        op: 'readlink',
        path: 'wire/link.txt',
      });
      success(readlink);
      assertCondition(
        readlink.value.op === 'readlink' && readlink.value.target === 'hard.txt',
        `readlink returned the wrong target: ${JSON.stringify(readlink)}`
      );
      const realpath = yield* syscalls.dispatch({
        op: 'realpath',
        path: 'wire/link.txt',
      });
      success(realpath);
      assertCondition(
        realpath.value.op === 'realpath' &&
          realpath.value.path === '/workspace/wire/hard.txt',
        `realpath returned the wrong path: ${JSON.stringify(realpath)}`
      );
      const hardStat = yield* syscalls.dispatch({ op: 'stat', path: 'wire/hard.txt' });
      success(hardStat);
      assertCondition(
        hardStat.value.op === 'stat' && hardStat.value.stat.nlink === 2,
        `Hard-link stat returned the wrong link count: ${JSON.stringify(hardStat)}`
      );

      const reopened = yield* syscalls.dispatch({
        op: 'open',
        path: 'wire/renamed.txt',
        options: { access: 'read' },
      });
      success(reopened);
      assertCondition(reopened.value.op === 'open', 'reopen returned the wrong response variant.');
      if (reopened.value.op !== 'open') return;

      const read = yield* syscalls.dispatch({
        op: 'read',
        fd: reopened.value.fd,
        maxBytes: 64,
      });
      success(read);
      assertCondition(
        read.value.op === 'read' &&
          new TextDecoder().decode(read.value.bytes) === 'wire',
        'Structured-clone syscall round trip changed file bytes.'
      );

      const cloned = structuredClone(read);
      assertCondition(
        cloned.ok && cloned.value.op === 'read' && cloned.value.bytes instanceof Uint8Array,
        'Syscall response is not structured-cloneable.'
      );

      yield* syscalls.dispatch({ op: 'close', fd: reopened.value.fd });
      const badRead = yield* syscalls.dispatch({
        op: 'read',
        fd: reopened.value.fd,
        maxBytes: 1,
      });
      assertCondition(
        !badRead.ok && badRead.error.code === 'EBADF',
        `Closed descriptor did not produce a wire-level EBADF: ${JSON.stringify(badRead)}`
      );

      const unlinked = yield* syscalls.dispatch({
        op: 'unlink',
        path: 'wire/renamed.txt',
      });
      success(unlinked);
      success(yield* syscalls.dispatch({ op: 'unlink', path: 'wire/link.txt' }));
      success(yield* syscalls.dispatch({ op: 'unlink', path: 'wire/hard.txt' }));
      const removedDirectory = yield* syscalls.dispatch({ op: 'rmdir', path: 'wire' });
      success(removedDirectory);

      const listener = yield* syscalls.dispatch({ op: 'socket' });
      success(listener);
      assertCondition(listener.value.op === 'socket', 'socket returned the wrong response.');
      if (listener.value.op !== 'socket') return;
      const boundSocket = yield* syscalls.dispatch({
        op: 'bind',
        fd: listener.value.fd,
        address: { host: 'localhost', port: 0 },
      });
      success(boundSocket);
      assertCondition(boundSocket.value.op === 'bind', 'bind returned the wrong response.');
      if (boundSocket.value.op !== 'bind') return;
      success(yield* syscalls.dispatch({
        op: 'listen',
        fd: listener.value.fd,
        options: { backlog: 4, capacityChunks: 2 },
      }));

      const accepting = yield* Effect.fork(syscalls.dispatch({
        op: 'accept',
        fd: listener.value.fd,
      }));
      const clientSocket = yield* peerSyscalls.dispatch({ op: 'socket' });
      success(clientSocket);
      assertCondition(clientSocket.value.op === 'socket', 'peer socket returned the wrong response.');
      if (clientSocket.value.op !== 'socket') return;
      const connectedSocket = yield* peerSyscalls.dispatch({
        op: 'connect',
        fd: clientSocket.value.fd,
        address: boundSocket.value.address,
      });
      success(connectedSocket);
      const acceptedSocket = yield* Fiber.join(accepting);
      success(acceptedSocket);
      assertCondition(
        acceptedSocket.value.op === 'accept',
        `accept returned the wrong response: ${JSON.stringify(acceptedSocket)}`
      );
      if (acceptedSocket.value.op !== 'accept') return;

      const sent = yield* peerSyscalls.dispatch({
        op: 'send',
        fd: clientSocket.value.fd,
        bytes: new TextEncoder().encode('tcp-wire'),
      });
      success(sent);
      const received = yield* syscalls.dispatch({
        op: 'recv',
        fd: acceptedSocket.value.fd,
        maxBytes: 64,
      });
      success(received);
      assertCondition(
        received.value.op === 'recv' &&
          new TextDecoder().decode(received.value.bytes) === 'tcp-wire',
        `TCP syscall bytes changed across the dispatcher: ${JSON.stringify(received)}`
      );
      const localAddress = yield* peerSyscalls.dispatch({
        op: 'getsockname',
        fd: clientSocket.value.fd,
      });
      const remoteAddress = yield* peerSyscalls.dispatch({
        op: 'getpeername',
        fd: clientSocket.value.fd,
      });
      success(localAddress);
      success(remoteAddress);
      assertCondition(
        localAddress.value.op === 'getsockname' &&
          remoteAddress.value.op === 'getpeername' &&
          remoteAddress.value.address.port === boundSocket.value.address.port,
        'Socket address syscalls returned inconsistent endpoint identities.'
      );
      const socketError = yield* peerSyscalls.dispatch({
        op: 'getsockopt',
        fd: clientSocket.value.fd,
        option: 'error',
      });
      success(socketError);
      assertCondition(
        socketError.value.op === 'getsockopt' &&
          socketError.value.error === undefined,
        `A connected socket retained a wire-level error: ${JSON.stringify(socketError)}`
      );
      success(yield* peerSyscalls.dispatch({
        op: 'shutdown',
        fd: clientSocket.value.fd,
        how: 'write',
      }));
      const eof = yield* syscalls.dispatch({
        op: 'recv',
        fd: acceptedSocket.value.fd,
        maxBytes: 1,
      });
      success(eof);
      assertCondition(
        eof.value.op === 'recv' && eof.value.bytes.byteLength === 0,
        'Socket shutdown did not produce wire-level EOF.'
      );

      yield* peerSyscalls.dispatch({ op: 'close', fd: clientSocket.value.fd });
      yield* syscalls.dispatch({ op: 'close', fd: acceptedSocket.value.fd });
      yield* syscalls.dispatch({ op: 'close', fd: listener.value.fd });

      const groupLeader = yield* session.spawn({
        runtime: 'syscall-test',
        command: 'syscall-group-leader',
        owner: process.snapshot().owner,
      });
      yield* groupLeader.awaitStarted();
      const [groupChildA, groupChildB] = yield* Effect.all([
        session.spawn({
          runtime: 'syscall-test',
          command: 'syscall-group-child-a',
          parentPid: groupLeader.pid,
          owner: process.snapshot().owner,
        }),
        session.spawn({
          runtime: 'syscall-test',
          command: 'syscall-group-child-b',
          parentPid: groupLeader.pid,
          owner: process.snapshot().owner,
        }),
      ], { concurrency: 'unbounded' });
      yield* Effect.all([
        groupChildA.awaitStarted(),
        groupChildB.awaitStarted(),
      ], { concurrency: 'unbounded', discard: true });
      const processGroupId = groupLeader.snapshot().pgid;
      assertCondition(
        groupChildA.snapshot().pgid === processGroupId &&
          groupChildB.snapshot().pgid === processGroupId,
        'Child processes did not retain their inherited process group.'
      );
      const groupKill = yield* syscalls.dispatch({
        op: 'kill',
        pid: -processGroupId,
        signal: 'SIGTERM',
      });
      success(groupKill);
      const groupTerminations = yield* Effect.all([
        groupLeader.wait(),
        groupChildA.wait(),
        groupChildB.wait(),
      ], { concurrency: 'unbounded' });
      assertCondition(
        groupTerminations.every((snapshot) =>
          snapshot.termination?.kind === 'signal' &&
          snapshot.termination.signal === 'SIGTERM'
        ) &&
          process.snapshot().phase === 'running' &&
          peer.snapshot().phase === 'running',
        `Process-group kill escaped its PGID or missed a member: ${JSON.stringify(groupTerminations)}`
      );
      const missingGroup = yield* syscalls.dispatch({
        op: 'kill',
        pid: -999_999,
        signal: 'SIGTERM',
      });
      assertCondition(
        !missingGroup.ok && missingGroup.error.code === 'ESRCH',
        `Missing process-group kill did not return ESRCH: ${JSON.stringify(missingGroup)}`
      );

      yield* peer.signal('SIGTERM');
      yield* process.signal('SIGTERM');

      const limitedSession = yield* host.openSession({
        maxDescriptorsPerProcess: 1,
      });
      const limitedProcess = yield* limitedSession.spawn({
        runtime: 'syscall-test',
        command: 'limited-syscall-client',
      });
      yield* limitedProcess.awaitStarted();
      const limitedSyscalls = new TraceKernelSyscallDispatcher(
        limitedSession,
        limitedProcess
      );
      const onlySocket = yield* limitedSyscalls.dispatch({ op: 'socket' });
      success(onlySocket);
      const exhausted = yield* limitedSyscalls.dispatch({ op: 'socket' });
      assertCondition(
        !exhausted.ok && exhausted.error.code === 'EMFILE',
        `Descriptor exhaustion did not cross the wire as EMFILE: ${JSON.stringify(exhausted)}`
      );
      assertCondition(
        limitedProcess.snapshot().descriptors.length === 1 &&
          limitedSession.resourceIds().length === 1,
        'A wire-level EMFILE failure leaked a socket resource.'
      );
      if (onlySocket.value.op === 'socket') {
        yield* limitedSyscalls.dispatch({ op: 'close', fd: onlySocket.value.fd });
      }
      yield* limitedProcess.signal('SIGTERM');

      const authorizedPaths: string[] = [];
      const policySession = yield* host.openSession({
        fileSystemPolicy: {
          authorize: (request) => {
            authorizedPaths.push(...request.accesses.map((access) => access.path));
            const denied = request.accesses.find(
              (access) => access.path === '/workspace/protected.txt'
            );
            return denied
              ? Effect.fail(new TraceKernelFileSystemError({
                  code: 'EACCES',
                  path: denied.path,
                  message: `EACCES: denied ${denied.permission} ${denied.path}`,
                }))
              : Effect.void;
          },
        },
      });
      yield* policySession.writeFile(
        'protected.txt',
        new TextEncoder().encode('protected')
      );
      yield* policySession.symlink('protected.txt', 'alias.txt');
      yield* policySession.mkdir('canonical-parent');
      yield* policySession.symlink('canonical-parent', 'directory-alias');
      yield* policySession.symlink('policy-loop-b', 'policy-loop-a');
      yield* policySession.symlink('policy-loop-a', 'policy-loop-b');
      const policyProcess = yield* policySession.spawn({
        runtime: 'syscall-test',
        command: 'policy-syscall-client',
        owner: { id: 'policy-runtime', kind: 'user' },
      });
      yield* policyProcess.awaitStarted();
      const policySyscalls = new TraceKernelSyscallDispatcher(
        policySession,
        policyProcess
      );
      const deniedAliasRead = yield* policySyscalls.dispatch({
        op: 'readFile',
        path: 'alias.txt',
      });
      assertCondition(
        !deniedAliasRead.ok && deniedAliasRead.error.code === 'EACCES',
        `Filesystem policy did not deny a canonicalized symlink target: ${JSON.stringify(
          deniedAliasRead
        )}`
      );
      const allowedWrite = yield* policySyscalls.dispatch({
        op: 'writeFile',
        path: 'allowed.txt',
        bytes: new TextEncoder().encode('allowed'),
      });
      success(allowedWrite);
      const recursiveMkdir = yield* policySyscalls.dispatch({
        op: 'mkdir',
        path: 'directory-alias/missing/nested',
        options: { recursive: true },
      });
      success(recursiveMkdir);
      const recursiveDirectory = yield* policySession.fileSystem.stat(
        'canonical-parent/missing/nested'
      );
      assertCondition(
        recursiveDirectory.kind === 'directory',
        'Recursive mkdir did not create the authorized missing suffix.'
      );
      const nonRecursiveMkdir = yield* policySyscalls.dispatch({
        op: 'mkdir',
        path: 'non-recursive-parent/nested',
      });
      assertCondition(
        !nonRecursiveMkdir.ok && nonRecursiveMkdir.error.code === 'ENOENT',
        `Non-recursive mkdir admitted a missing parent: ${JSON.stringify(
          nonRecursiveMkdir
        )}`
      );
      const cyclicLinkStat = yield* policySyscalls.dispatch({
        op: 'lstat',
        path: 'policy-loop-a',
      });
      success(cyclicLinkStat);
      assertCondition(
        cyclicLinkStat.value.op === 'lstat' &&
          cyclicLinkStat.value.stat.kind === 'symlink',
        'Filesystem policy followed the final symlink for lstat.'
      );
      const cyclicLinkUnlink = yield* policySyscalls.dispatch({
        op: 'unlink',
        path: 'policy-loop-a',
      });
      success(cyclicLinkUnlink);
      assertCondition(
        authorizedPaths.includes('/workspace/protected.txt') &&
          authorizedPaths.includes('/workspace/allowed.txt') &&
          authorizedPaths.includes(
            '/workspace/canonical-parent/missing/nested'
          ) &&
          authorizedPaths.includes('/workspace/policy-loop-a'),
        `Filesystem policy did not receive canonical paths: ${JSON.stringify(
          authorizedPaths
        )}`
      );
      yield* policyProcess.signal('SIGTERM');
    })
  ));

  console.log(JSON.stringify({
    schema: 'tracekernel-013-syscalls-v1',
    plainRequestContract: true,
    structuredCloneResponse: true,
    namespaceOperationsShareTheWireContract: true,
    tcpOperationsShareTheWireContract: true,
    processAndPipeOperationsShareTheWireContract: true,
    processIdentityUsesAuthoritativeRecord: true,
    unixProcessGroupSignalSelectors: true,
    childStdioUsesProcessOwnedDescriptors: true,
    childWriterCloseProducesEof: true,
    nonblockingWaitDoesNotReap: true,
    childWaitReapsExactlyOnce: true,
    waitpidSelectors: ['exact', 'any', 'caller-pgid', 'named-pgid'],
    concurrentWaitersReapDistinctChildren: true,
    typedErrorsMappedToPosixWireErrors: true,
    descriptorLimitsCrossWireAsEmfile: true,
    filesystemPolicyCanonicalizesSymlinks: true,
    effectDoesNotCrossRuntimeBoundary: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

#!/usr/bin/env npx tsx

import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import {
  makeTraceKernelHost,
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
            execute: () => Effect.never,
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
      yield* peer.signal('SIGTERM');
      yield* process.signal('SIGTERM');
    })
  ));

  console.log(JSON.stringify({
    schema: 'tracekernel-013-syscalls-v1',
    plainRequestContract: true,
    structuredCloneResponse: true,
    namespaceOperationsShareTheWireContract: true,
    tcpOperationsShareTheWireContract: true,
    typedErrorsMappedToPosixWireErrors: true,
    effectDoesNotCrossRuntimeBoundary: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

#!/usr/bin/env npx tsx

import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Option from 'effect/Option';
import {
  decodeTraceKernelWatchEvent,
  makeTraceKernelHost,
  TraceKernelSyscallDispatcher,
  type TraceKernelRuntimeProvider,
  type TraceKernelSyscallResult,
} from '@tracecode/tracekernel';

function assertCondition(condition: unknown, message: string): asserts condition {
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
    runtime: 'watch-test',
    initialize: Effect.succeed({
      acquire: (process) =>
        Effect.succeed({
          id: `watch-${process.pid}`,
          runtime: 'watch-test',
          execute: () => Effect.never,
          release: () => Effect.void,
        }),
    }),
  };

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const host = yield* makeTraceKernelHost({ providers: [provider] });
      const session = yield* host.openSession();
      const watcher = yield* session.spawn({
        runtime: 'watch-test',
        command: 'watcher',
      });
      const writer = yield* session.spawn({
        runtime: 'watch-test',
        command: 'writer',
      });
      yield* Effect.all([watcher.awaitStarted(), writer.awaitStarted()], {
        concurrency: 'unbounded',
        discard: true,
      });
      const watcherSyscalls = new TraceKernelSyscallDispatcher(session, watcher);
      const writerSyscalls = new TraceKernelSyscallDispatcher(session, writer);

      const watched = yield* watcherSyscalls.dispatch({
        op: 'watch',
        path: '/workspace',
        options: { recursive: true, capacityEvents: 8 },
      });
      success(watched);
      assertCondition(watched.value.op === 'watch', 'watch returned the wrong response variant.');
      if (watched.value.op !== 'watch') return;

      const emptyPoll = yield* watcherSyscalls.dispatch({
        op: 'poll',
        entries: [{ fd: watched.value.fd, read: true }],
        timeoutMs: 0,
      });
      success(emptyPoll);
      assertCondition(
        emptyPoll.value.op === 'poll' && emptyPoll.value.entries.length === 0,
        `an empty watch reported readable events: ${JSON.stringify(emptyPoll)}`
      );
      const watchPoll = yield* Effect.fork(watcherSyscalls.dispatch({
        op: 'poll',
        entries: [{ fd: watched.value.fd, read: true }],
        timeoutMs: 1_000,
      }));
      yield* Effect.yieldNow();
      assertCondition(
        Option.isNone(yield* Fiber.poll(watchPoll)),
        'watch poll returned before a filesystem mutation.'
      );
      const created = yield* writerSyscalls.dispatch({
        op: 'writeFile',
        path: '/workspace/from-peer.txt',
        bytes: new TextEncoder().encode('one'),
      });
      success(created);
      const readyPoll = yield* Fiber.join(watchPoll);
      success(readyPoll);
      assertCondition(
        readyPoll.value.op === 'poll' &&
          readyPoll.value.entries[0]?.read === true,
        `a filesystem mutation did not wake watch poll: ${JSON.stringify(readyPoll)}`
      );
      const first = yield* watcherSyscalls.dispatch({
        op: 'read',
        fd: watched.value.fd,
        maxBytes: 16 * 1024 + 9,
      });
      success(first);
      assertCondition(first.value.op === 'read', 'watch descriptor did not return bytes.');
      if (first.value.op !== 'read') return;
      const createEvent = decodeTraceKernelWatchEvent(first.value.bytes);
      assertCondition(
        createEvent.eventType === 'rename' &&
          createEvent.entryOperation === 'create' &&
          createEvent.path === '/workspace/from-peer.txt',
        `watch did not report peer creation: ${JSON.stringify(createEvent)}`
      );

      success(yield* writerSyscalls.dispatch({
        op: 'writeFile',
        path: '/workspace/from-peer.txt',
        bytes: new TextEncoder().encode('two'),
      }));
      const changed = yield* watcherSyscalls.dispatch({
        op: 'read',
        fd: watched.value.fd,
        maxBytes: 16 * 1024 + 9,
      });
      success(changed);
      assertCondition(
        changed.value.op === 'read' &&
          decodeTraceKernelWatchEvent(changed.value.bytes).eventType === 'change',
        `watch did not distinguish content mutation: ${JSON.stringify(changed)}`
      );

      success(yield* writerSyscalls.dispatch({
        op: 'rename',
        sourcePath: '/workspace/from-peer.txt',
        destinationPath: '/workspace/renamed-by-peer.txt',
      }));
      const renameSource = yield* watcherSyscalls.dispatch({
        op: 'read',
        fd: watched.value.fd,
        maxBytes: 16 * 1024 + 9,
      });
      const renameDestination = yield* watcherSyscalls.dispatch({
        op: 'read',
        fd: watched.value.fd,
        maxBytes: 16 * 1024 + 9,
      });
      success(renameSource);
      success(renameDestination);
      const renameSourceEvent = renameSource.value.op === 'read'
        ? decodeTraceKernelWatchEvent(renameSource.value.bytes)
        : undefined;
      const renameDestinationEvent = renameDestination.value.op === 'read'
        ? decodeTraceKernelWatchEvent(renameDestination.value.bytes)
        : undefined;
      assertCondition(
        renameSourceEvent?.eventType === 'rename' &&
          renameSourceEvent.entryOperation === 'delete' &&
          renameSourceEvent.path === '/workspace/from-peer.txt' &&
          renameDestinationEvent?.eventType === 'rename' &&
          renameDestinationEvent.entryOperation === 'create' &&
          renameDestinationEvent.path === '/workspace/renamed-by-peer.txt',
        `watch did not preserve exact rename endpoint semantics: ${JSON.stringify({
          renameSourceEvent,
          renameDestinationEvent,
        })}`
      );

      success(yield* writerSyscalls.dispatch({
        op: 'unlink',
        path: '/workspace/renamed-by-peer.txt',
      }));
      const deleted = yield* watcherSyscalls.dispatch({
        op: 'read',
        fd: watched.value.fd,
        maxBytes: 16 * 1024 + 9,
      });
      success(deleted);
      const deleteEvent = deleted.value.op === 'read'
        ? decodeTraceKernelWatchEvent(deleted.value.bytes)
        : undefined;
      assertCondition(
        deleteEvent?.eventType === 'rename' &&
          deleteEvent.entryOperation === 'delete' &&
          deleteEvent.path === '/workspace/renamed-by-peer.txt',
        `watch did not report exact peer deletion: ${JSON.stringify(deleteEvent)}`
      );

      const constrained = yield* watcherSyscalls.dispatch({
        op: 'watch',
        path: '/workspace',
        options: { recursive: true, capacityEvents: 1 },
      });
      success(constrained);
      assertCondition(constrained.value.op === 'watch', 'bounded watch setup failed.');
      if (constrained.value.op !== 'watch') return;
      for (const name of ['overflow-a', 'overflow-b', 'overflow-c']) {
        success(yield* writerSyscalls.dispatch({
          op: 'writeFile',
          path: `/workspace/${name}`,
          bytes: new TextEncoder().encode(name),
        }));
      }
      const retained = yield* watcherSyscalls.dispatch({
        op: 'read',
        fd: constrained.value.fd,
        maxBytes: 16 * 1024 + 9,
      });
      const overflow = yield* watcherSyscalls.dispatch({
        op: 'read',
        fd: constrained.value.fd,
        maxBytes: 16 * 1024 + 9,
      });
      success(retained);
      success(overflow);
      assertCondition(
        overflow.value.op === 'read' &&
          decodeTraceKernelWatchEvent(overflow.value.bytes).eventType === 'overflow',
        `bounded watch queue did not report overflow: ${JSON.stringify({
          retained,
          overflow,
        })}`
      );

      success(yield* watcherSyscalls.dispatch({ op: 'close', fd: watched.value.fd }));
      success(yield* watcherSyscalls.dispatch({ op: 'close', fd: constrained.value.fd }));
      yield* Effect.all([
        watcher.signal('SIGTERM'),
        writer.signal('SIGTERM'),
      ], { concurrency: 'unbounded', discard: true });
    })
  ));

  console.log(JSON.stringify({
    schema: 'tracekernel-watch-v1',
    processOwnedWatchDescriptors: true,
    crossProcessNotifications: true,
    createVsChangeSemantics: true,
    exactCreateDeleteSemantics: true,
    exactRenameEndpointSemantics: true,
    boundedQueueOverflowIsExplicit: true,
    eventDrivenPollReadiness: true,
    descriptorCloseStopsDelivery: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

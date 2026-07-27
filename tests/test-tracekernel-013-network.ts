#!/usr/bin/env npx tsx

import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Option from 'effect/Option';
import {
  makeTraceKernelHost,
  TraceKernelNetworkError,
  TraceKernelWouldBlockError,
  type TraceKernelRuntimeProvider,
} from '@tracecode/tracekernel';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertWouldBlock(exit: Exit.Exit<unknown, Error>, operation: string): void {
  assertCondition(Exit.isFailure(exit), `${operation} unexpectedly succeeded.`);
  if (Exit.isSuccess(exit)) return;
  const failure = Cause.failureOption(exit.cause);
  assertCondition(
    Option.isSome(failure) &&
      failure.value instanceof TraceKernelWouldBlockError &&
      failure.value.code === 'EAGAIN',
    `${operation} did not return EAGAIN: ${Cause.pretty(exit.cause)}`
  );
}

function assertNetworkError(
  exit: Exit.Exit<unknown, Error>,
  expectedCode: TraceKernelNetworkError['code']
): void {
  assertCondition(Exit.isFailure(exit), `Expected ${expectedCode}, but operation succeeded.`);
  if (Exit.isSuccess(exit)) return;
  const failure = Cause.failureOption(exit.cause);
  assertCondition(
    Option.isSome(failure) &&
      failure.value instanceof TraceKernelNetworkError &&
      failure.value.code === expectedCode,
    `Expected ${expectedCode}, received ${Cause.pretty(exit.cause)}`
  );
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function main(): Promise<void> {
  const provider: TraceKernelRuntimeProvider = {
    runtime: 'network-test',
    initialize: Effect.succeed({
      acquire: (process) =>
        Effect.succeed({
          id: `network-lease-${process.pid}`,
          runtime: 'network-test',
          execute: () => Effect.never,
          release: () => Effect.void,
        }),
    }),
  };

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const host = yield* makeTraceKernelHost({ providers: [provider] });
      const session = yield* host.openSession();
      const server = yield* session.spawn({
        runtime: 'network-test',
        command: 'server',
      });
      const client = yield* session.spawn({
        runtime: 'network-test',
        command: 'client',
      });
      const contender = yield* session.spawn({
        runtime: 'network-test',
        command: 'contender',
      });
      yield* Effect.all([
        server.awaitStarted(),
        client.awaitStarted(),
        contender.awaitStarted(),
      ], { concurrency: 'unbounded', discard: true });

      const listenerFd = yield* session.createTcpSocket(server);
      const bound = yield* session.bindTcp(server, listenerFd, {
        host: 'localhost',
        port: 0,
      });
      assertCondition(
        bound.host === '127.0.0.1' && bound.port >= 49_152,
        `Ephemeral bind returned an invalid address: ${JSON.stringify(bound)}`
      );

      const isolatedSession = yield* host.openSession();
      const isolatedProcess = yield* isolatedSession.spawn({
        runtime: 'network-test',
        command: 'isolated-listener',
      });
      yield* isolatedProcess.awaitStarted();
      const isolatedFd = yield* isolatedSession.createTcpSocket(isolatedProcess);
      const isolatedBound = yield* isolatedSession.bindTcp(
        isolatedProcess,
        isolatedFd,
        bound
      );
      assertCondition(
        isolatedBound.port === bound.port,
        'Independent sessions did not receive isolated port namespaces.'
      );
      yield* isolatedProcess.signal('SIGTERM');

      const conflictingFd = yield* session.createTcpSocket(contender);
      assertNetworkError(
        yield* Effect.exit(session.bindTcp(contender, conflictingFd, bound)),
        'EADDRINUSE'
      );

      yield* session.listenTcp(server, listenerFd, {
        backlog: 1,
        capacityChunks: 1,
      });
      const emptyListener = yield* server.descriptors.readiness(listenerFd, {
        read: true,
        write: false,
      });
      assertCondition(
        !emptyListener.read,
        'An empty TCP listener reported an accept-ready connection.'
      );
      yield* server.descriptors.setNonblocking(listenerFd, true);
      assertWouldBlock(
        yield* Effect.exit(session.acceptTcp(server, listenerFd)),
        'nonblocking accept on an empty listener'
      );
      yield* server.descriptors.setNonblocking(listenerFd, false);

      const clientFd = yield* session.createTcpSocket(client);
      const connected = yield* session.connectTcp(client, clientFd, bound);
      const readyListener = yield* server.descriptors.readiness(listenerFd, {
        read: true,
        write: false,
      });
      assertCondition(
        readyListener.read,
        'A queued TCP connection did not make the listener readable.'
      );
      const accepted = yield* session.acceptTcp(server, listenerFd);
      const drainedListener = yield* server.descriptors.readiness(listenerFd, {
        read: true,
        write: false,
      });
      assertCondition(
        !drainedListener.read,
        'A drained listener remained spuriously readable.'
      );
      assertCondition(
        connected.remoteAddress.port === bound.port &&
          accepted.localAddress.port === bound.port &&
          connected.localAddress.port === accepted.remoteAddress.port,
        'Connected endpoints received inconsistent local/remote addresses.'
      );
      assertCondition(
        server.snapshot().descriptors.some((descriptor) =>
          descriptor.fd === accepted.fd && descriptor.kind === 'tcp-socket'
        ),
        'accept() did not install a process-owned socket descriptor.'
      );

      const initiallyReadable = yield* server.descriptors.readiness(
        accepted.fd,
        { read: true, write: false }
      );
      assertCondition(
        !initiallyReadable.read,
        'An empty connected TCP stream reported readable data.'
      );
      yield* server.descriptors.setNonblocking(accepted.fd, true);
      assertWouldBlock(
        yield* Effect.exit(server.read(accepted.fd, 16)),
        'nonblocking recv on an empty stream'
      );
      yield* server.descriptors.setNonblocking(accepted.fd, false);
      yield* client.descriptors.setNonblocking(clientFd, true);
      yield* client.write(clientFd, encoder.encode('nonblocking-one'));
      assertWouldBlock(
        yield* Effect.exit(client.write(clientFd, encoder.encode('nonblocking-two'))),
        'nonblocking send under stream backpressure'
      );
      assertCondition(
        decoder.decode(yield* server.read(accepted.fd, 64)) === 'nonblocking-one',
        'Nonblocking TCP send changed the queued payload.'
      );
      yield* client.descriptors.setNonblocking(clientFd, false);
      const waitingForData = yield* Effect.fork(
        server.descriptors.awaitReadiness(
          accepted.fd,
          { read: true, write: false }
        )
      );
      yield* client.write(clientFd, encoder.encode('abcdef'));
      const dataReady = yield* Fiber.join(waitingForData);
      assertCondition(
        dataReady.read,
        'TCP data did not wake descriptor readiness.'
      );
      assertCondition(
        decoder.decode(yield* server.read(accepted.fd, 2)) === 'ab' &&
          decoder.decode(yield* server.read(accepted.fd, 8)) === 'cdef',
        'TCP stream reads did not preserve byte fragmentation.'
      );
      yield* server.write(accepted.fd, encoder.encode('reply'));
      assertCondition(
        decoder.decode(yield* client.read(clientFd, 64)) === 'reply',
        'TCP stream was not bidirectional.'
      );

      yield* client.write(clientFd, encoder.encode('one'));
      const backpressuredWrite = yield* Effect.fork(
        client.write(clientFd, encoder.encode('two'))
      );
      yield* Effect.yieldNow();
      assertCondition(
        Option.isNone(yield* Fiber.poll(backpressuredWrite)),
        'Bounded TCP stream did not apply sender backpressure.'
      );
      assertCondition(
        decoder.decode(yield* server.read(accepted.fd, 16)) === 'one',
        'TCP server received the wrong first queued chunk.'
      );
      assertCondition(
        (yield* Fiber.join(backpressuredWrite)) === 3 &&
          decoder.decode(yield* server.read(accepted.fd, 16)) === 'two',
        'Backpressured TCP data was not released in order.'
      );

      const waitingForFin = yield* Effect.fork(server.read(accepted.fd, 16));
      yield* Effect.yieldNow();
      assertCondition(
        Option.isNone(yield* Fiber.poll(waitingForFin)),
        'TCP recv did not block before peer shutdown.'
      );
      yield* session.shutdownTcp(client, clientFd, 'write');
      assertCondition(
        (yield* Fiber.join(waitingForFin)).byteLength === 0,
        'Peer write shutdown did not produce EOF.'
      );
      const peerFinReady = yield* server.descriptors.readiness(
        accepted.fd,
        { read: true, write: false }
      );
      assertCondition(
        peerFinReady.read && peerFinReady.hangup,
        'TCP peer FIN did not remain level-ready as readable HUP.'
      );
      yield* server.write(accepted.fd, encoder.encode('after-fin'));
      assertCondition(
        decoder.decode(yield* client.read(clientFd, 64)) === 'after-fin',
        'A peer write half-close incorrectly disabled the reverse stream.'
      );

      const blockedAccept = yield* Effect.fork(session.acceptTcp(server, listenerFd));
      yield* Effect.yieldNow();
      yield* server.close(listenerFd);
      assertCondition(
        Exit.isFailure(yield* Fiber.await(blockedAccept)),
        'Closing a listener did not wake a blocked accept().'
      );

      const backlogListenerFd = yield* session.createTcpSocket(server);
      const backlogAddress = yield* session.bindTcp(server, backlogListenerFd, {
        host: '127.0.0.1',
        port: 0,
      });
      yield* session.listenTcp(server, backlogListenerFd, { backlog: 1 });
      const queuedClientFd = yield* session.createTcpSocket(client);
      yield* session.connectTcp(client, queuedClientFd, backlogAddress);
      const blockedClientFd = yield* session.createTcpSocket(contender);
      const backlogBlockedConnect = yield* Effect.fork(
        session.connectTcp(contender, blockedClientFd, backlogAddress)
      );
      yield* Effect.yieldNow();
      assertCondition(
        Option.isNone(yield* Fiber.poll(backlogBlockedConnect)),
        'A full listener backlog did not block the next connect().'
      );
      assertCondition(
        Exit.isFailure(yield* Fiber.interrupt(backlogBlockedConnect)),
        'Interrupting a backlog-blocked connect() did not terminate it.'
      );
      const reboundAfterInterrupt = yield* session.bindTcp(
        contender,
        blockedClientFd,
        { host: '127.0.0.1', port: 0 }
      );
      assertCondition(
        reboundAfterInterrupt.port >= 49_152,
        'Interrupted connect() did not release its provisional port or reset the socket.'
      );
      const nonblockingClientFd = yield* session.createTcpSocket(contender);
      yield* contender.descriptors.setNonblocking(nonblockingClientFd, true);
      assertNetworkError(
        yield* Effect.exit(
          session.connectTcp(contender, nonblockingClientFd, backlogAddress)
        ),
        'EINPROGRESS'
      );
      assertNetworkError(
        yield* Effect.exit(
          session.connectTcp(contender, nonblockingClientFd, backlogAddress)
        ),
        'EALREADY'
      );
      const pendingConnect = yield* contender.descriptors.readiness(
        nonblockingClientFd,
        { read: false, write: true }
      );
      assertCondition(
        !pendingConnect.write && !pendingConnect.error,
        'An incomplete nonblocking connect reported writable.'
      );
      const connectCompletion = yield* Effect.fork(
        contender.descriptors.awaitReadiness(
          nonblockingClientFd,
          { read: false, write: true }
        )
      );
      const queuedAccepted = yield* session.acceptTcp(server, backlogListenerFd);
      const completedConnect = yield* Fiber.join(connectCompletion);
      assertCondition(
        completedConnect.write && !completedConnect.error,
        'A completed nonblocking connect did not become writable.'
      );
      assertCondition(
        (yield* session.tcpSocketError(contender, nonblockingClientFd)) ===
          undefined,
        'A successful nonblocking connect retained a socket error.'
      );
      assertNetworkError(
        yield* Effect.exit(
          session.connectTcp(contender, nonblockingClientFd, backlogAddress)
        ),
        'EISCONN'
      );
      const nonblockingAccepted = yield* session.acceptTcp(
        server,
        backlogListenerFd
      );
      yield* server.close(queuedAccepted.fd);
      yield* server.close(nonblockingAccepted.fd);
      yield* server.close(backlogListenerFd);
      yield* client.close(queuedClientFd);
      yield* contender.close(blockedClientFd);
      yield* contender.close(nonblockingClientFd);

      const refusedFd = yield* session.createTcpSocket(contender);
      assertNetworkError(
        yield* Effect.exit(session.connectTcp(contender, refusedFd, bound)),
        'ECONNREFUSED'
      );
      const refusedNonblockingFd = yield* session.createTcpSocket(contender);
      yield* contender.descriptors.setNonblocking(refusedNonblockingFd, true);
      assertNetworkError(
        yield* Effect.exit(
          session.connectTcp(contender, refusedNonblockingFd, bound)
        ),
        'EINPROGRESS'
      );
      const refusedReady = yield* contender.descriptors.awaitReadiness(
        refusedNonblockingFd,
        { read: false, write: true }
      );
      assertCondition(
        refusedReady.write && refusedReady.error,
        'A failed nonblocking connect did not report writable error readiness.'
      );
      assertCondition(
        (yield* session.tcpSocketError(contender, refusedNonblockingFd)) ===
          'ECONNREFUSED' &&
          (yield* session.tcpSocketError(contender, refusedNonblockingFd)) ===
            undefined,
        'SO_ERROR did not consume the asynchronous connection error exactly once.'
      );
      yield* contender.close(refusedNonblockingFd);
      const rebound = yield* session.bindTcp(contender, conflictingFd, bound);
      assertCondition(
        rebound.port === bound.port,
        'Closing the listener did not release its bound port.'
      );

      yield* Effect.all([
        server.signal('SIGTERM'),
        client.signal('SIGTERM'),
        contender.signal('SIGTERM'),
      ], { concurrency: 'unbounded', discard: true });
      assertCondition(
        session.resourceIds().length === 0,
        `Process teardown stranded TCP resources: ${JSON.stringify(session.resourceIds())}`
      );
    })
  ));

  console.log(JSON.stringify({
    schema: 'tracekernel-013-network-v1',
    sessionLocalPortOwnership: true,
    sessionNamespacesAreIsolated: true,
    blockingAcceptAndConnect: true,
    listenerAndStreamReadiness: true,
    peerFinReportsReadableHangup: true,
    bidirectionalFragmentedStreams: true,
    boundedBackpressure: true,
    nonblockingAcceptRecvAndSend: true,
    nonblockingConnectLifecycle: true,
    writeHalfClosePreservesReverseStream: true,
    listenerCloseWakesAccept: true,
    backlogAppliesConnectBackpressure: true,
    interruptedConnectReleasesProvisionalBinding: true,
    processExitReleasesSocketsAndPorts: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

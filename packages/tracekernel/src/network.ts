import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Option from 'effect/Option';
import * as Queue from 'effect/Queue';
import * as Scope from 'effect/Scope';
import {
  TraceKernelPipe,
  type TraceKernelDescriptor,
  type TraceKernelDescriptorReadiness,
  type TraceKernelPollEvents,
} from './descriptors';
import {
  TraceKernelNetworkError,
  TraceKernelWouldBlockError,
  type TraceKernelNetworkErrorCode,
} from './errors';

export interface TraceKernelTcpAddress {
  readonly host: string;
  readonly port: number;
}

export interface TraceKernelTcpListenOptions {
  readonly backlog?: number;
  readonly capacityChunks?: number;
}

export type TraceKernelTcpShutdownHow = 'read' | 'write' | 'both';

export interface TraceKernelTcpAcceptResult {
  readonly socket: TraceKernelTcpSocket;
  readonly localAddress: TraceKernelTcpAddress;
  readonly remoteAddress: TraceKernelTcpAddress;
}

export interface TraceKernelTcpConnectResult {
  readonly localAddress: TraceKernelTcpAddress;
  readonly remoteAddress: TraceKernelTcpAddress;
}

interface TraceKernelTcpEndpoint {
  readonly reader: TraceKernelDescriptor;
  readonly writer: TraceKernelDescriptor;
}

interface TraceKernelTcpListener {
  readonly queue: Queue.Queue<TraceKernelTcpSocket>;
  readonly closed: Deferred.Deferred<void>;
}

interface TraceKernelTcpBinding {
  readonly address: TraceKernelTcpAddress;
  readonly socket: TraceKernelTcpSocket;
}

function networkError(
  code: TraceKernelNetworkErrorCode,
  message: string
): TraceKernelNetworkError {
  return new TraceKernelNetworkError({ code, message: `${code}: ${message}` });
}

function normalizeHost(host: string): string | TraceKernelNetworkError {
  const normalized = host.trim().toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized === '127.0.0.1'
  ) {
    return '127.0.0.1';
  }
  if (normalized === '0.0.0.0') return normalized;
  return networkError(
    'EAFNOSUPPORT',
    `address ${JSON.stringify(host)} is outside the local IPv4 namespace`
  );
}

function normalizePort(port: number): number | TraceKernelNetworkError {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    return networkError('EINVAL', `invalid TCP port ${String(port)}`);
  }
  return port;
}

/**
 * One session-local TCP socket open-file description.
 *
 * `dup()` shares this object and therefore shares connection and shutdown
 * state. The final descriptor close releases the binding and both stream
 * directions. Accepted-but-not-yet-installed sockets retain one kernel
 * reference while queued on a listener.
 */
export class TraceKernelTcpSocket {
  private references = 1;
  private state: 'new' | 'bound' | 'listening' | 'connecting' | 'connected' | 'closed' = 'new';
  private boundAddress?: TraceKernelTcpAddress;
  private localAddressValue?: TraceKernelTcpAddress;
  private remoteAddressValue?: TraceKernelTcpAddress;
  private endpoint?: TraceKernelTcpEndpoint;
  private listener?: TraceKernelTcpListener;
  private readShutdown = false;
  private writeShutdown = false;
  private ownsBinding = false;
  private connectError?: TraceKernelNetworkError;
  private connectFiber?: Fiber.RuntimeFiber<void, never>;
  private connectToken?: symbol;

  constructor(
    readonly id: string,
    private readonly namespace: TraceKernelNetworkNamespace,
    private readonly closed: Deferred.Deferred<void>,
    private readinessChanged: Deferred.Deferred<void>,
    private readonly onFullyClosed: (id: string) => void
  ) {}

  descriptor(): TraceKernelDescriptor {
    return {
      kind: 'tcp-socket',
      resourceId: this.id,
      resource: this,
      read: (maxBytes) => this.read(maxBytes),
      readNonblocking: (maxBytes) => this.readNonblocking(maxBytes),
      write: (bytes) => this.write(bytes),
      writeNonblocking: (bytes) => this.writeNonblocking(bytes),
      readiness: (events) => this.readiness(events),
      awaitReadiness: (events) => this.awaitReadiness(events),
      duplicate: () => this.duplicate(),
      close: () => this.closeReference(),
    };
  }

  get phase(): string {
    return this.state;
  }

  localAddress(): Effect.Effect<TraceKernelTcpAddress, TraceKernelNetworkError> {
    const address = this.localAddressValue ?? this.boundAddress;
    return address
      ? Effect.succeed(Object.freeze({ ...address }))
      : Effect.fail(networkError('EDESTADDRREQ', 'socket has no local address'));
  }

  remoteAddress(): Effect.Effect<TraceKernelTcpAddress, TraceKernelNetworkError> {
    return this.remoteAddressValue
      ? Effect.succeed(Object.freeze({ ...this.remoteAddressValue }))
      : Effect.fail(networkError('ENOTCONN', 'socket is not connected'));
  }

  bind(address: TraceKernelTcpAddress): Effect.Effect<TraceKernelTcpAddress, TraceKernelNetworkError> {
    if (this.state !== 'new') {
      return Effect.fail(networkError('EINVAL', 'socket is already bound or connected'));
    }
    return this.namespace.bind(this, address).pipe(
      Effect.tap((bound) => Effect.sync(() => {
        this.boundAddress = bound;
        this.localAddressValue = bound;
        this.ownsBinding = true;
        this.state = 'bound';
      }))
    );
  }

  listen(
    options: TraceKernelTcpListenOptions = {}
  ): Effect.Effect<void, TraceKernelNetworkError> {
    return Effect.suspend(() => {
      if (this.state === 'closed') {
        return Effect.fail(networkError('EBADF', 'socket is closed'));
      }
      if (this.state === 'listening') return Effect.void;
      if (this.state !== 'bound') {
        return Effect.fail(networkError('EDESTADDRREQ', 'socket must be bound before listen'));
      }
      return Effect.gen(this, function* () {
        const queue = yield* Queue.bounded<TraceKernelTcpSocket>(
          Math.max(1, Math.floor(options.backlog ?? 128))
        );
        const closed = yield* Deferred.make<void>();
        this.listener = { queue, closed };
        this.state = 'listening';
        this.namespace.markListening(this, options.capacityChunks);
        yield* this.notifyReadiness();
      });
    });
  }

  accept(): Effect.Effect<TraceKernelTcpAcceptResult, TraceKernelNetworkError> {
    return Effect.suspend(() => {
      const listener = this.listener;
      if (this.state !== 'listening' || !listener) {
        return Effect.fail(networkError('EINVAL', 'socket is not listening'));
      }
      return Effect.raceFirst(
        Queue.take(listener.queue),
        Deferred.await(listener.closed).pipe(
          Effect.andThen(Effect.fail(networkError('EBADF', 'listening socket is closed')))
        )
      ).pipe(
        Effect.tap(() => this.notifyReadiness()),
        Effect.flatMap((socket) => this.acceptedResult(socket))
      );
    });
  }

  acceptNonblocking(): Effect.Effect<
    TraceKernelTcpAcceptResult,
    TraceKernelNetworkError | TraceKernelWouldBlockError
  > {
    return Effect.suspend(() => {
      const listener = this.listener;
      if (this.state !== 'listening' || !listener) {
        return Effect.fail(networkError('EINVAL', 'socket is not listening'));
      }
      return Effect.gen(this, function* () {
        const socket = yield* Queue.poll(listener.queue);
        if (Option.isNone(socket)) {
          return yield* Effect.fail(new TraceKernelWouldBlockError({
            code: 'EAGAIN',
            operation: 'accept',
            message: 'EAGAIN: no connection is ready to accept',
          }));
        }
        yield* this.notifyReadiness();
        return yield* this.acceptedResult(socket.value);
      });
    });
  }

  connect(
    address: TraceKernelTcpAddress
  ): Effect.Effect<TraceKernelTcpConnectResult, TraceKernelNetworkError> {
    return Effect.suspend(() => {
      if (this.state === 'closed') {
        return Effect.fail(networkError('EBADF', 'socket is closed'));
      }
      if (this.state === 'connected') {
        return Effect.fail(networkError('EISCONN', 'socket is already connected'));
      }
      if (this.state === 'connecting') {
        return Effect.fail(networkError('EALREADY', 'socket connection is already in progress'));
      }
      if (this.state === 'listening') {
        return Effect.fail(networkError('EOPNOTSUPP', 'listening socket cannot connect'));
      }
      this.connectError = undefined;
      this.state = 'connecting';
      return Effect.raceFirst(
        this.namespace.connect(this, address),
        Deferred.await(this.closed).pipe(
          Effect.andThen(Effect.fail(networkError('EBADF', 'socket closed during connect')))
        )
      ).pipe(
        Effect.tapError(() => Effect.sync(() => {
          this.state = this.boundAddress ? 'bound' : 'new';
        })),
        Effect.onInterrupt(() => Effect.sync(() => {
          if (this.state !== 'closed') {
            this.state = this.boundAddress ? 'bound' : 'new';
          }
        }))
      );
    });
  }

  connectNonblocking(
    address: TraceKernelTcpAddress
  ): Effect.Effect<never, TraceKernelNetworkError> {
    return Effect.suspend(() => {
      if (this.state === 'closed') {
        return Effect.fail(networkError('EBADF', 'socket is closed'));
      }
      if (this.state === 'connected') {
        return Effect.fail(networkError('EISCONN', 'socket is already connected'));
      }
      if (this.state === 'connecting') {
        return Effect.fail(networkError('EALREADY', 'socket connection is already in progress'));
      }
      if (this.state === 'listening') {
        return Effect.fail(networkError('EOPNOTSUPP', 'listening socket cannot connect'));
      }
      this.connectError = undefined;
      this.state = 'connecting';
      const token = Symbol(`connect-${this.id}`);
      this.connectToken = token;
      return Effect.gen(this, function* () {
        const fiber = yield* this.namespace.fork(
          Effect.raceFirst(
            this.namespace.connect(this, address),
            Deferred.await(this.closed).pipe(
              Effect.andThen(Effect.fail(networkError(
                'EBADF',
                'socket closed during connect'
              )))
            )
          ).pipe(
            Effect.tapError((error) => Effect.sync(() => {
              if (this.state !== 'closed') {
                this.state = this.boundAddress ? 'bound' : 'new';
                this.connectError = error;
              }
            })),
            Effect.matchEffect({
              onFailure: () => Effect.void,
              onSuccess: () => Effect.void,
            }),
            Effect.ensuring(Effect.gen(this, function* () {
              if (this.connectToken === token) {
                this.connectToken = undefined;
                this.connectFiber = undefined;
              }
              yield* this.notifyReadiness();
            }))
          )
        );
        if (this.connectToken === token) this.connectFiber = fiber;
        return yield* Effect.fail(networkError(
          'EINPROGRESS',
          'socket connection is in progress'
        ));
      });
    });
  }

  /**
   * Implements the consume-on-read portion of `getsockopt(SO_ERROR)`.
   *
   * A pending connect reports no error until its completion becomes
   * observable through descriptor readiness. Once consumed, a failed socket
   * may be connected again.
   */
  takeConnectError(): Effect.Effect<TraceKernelNetworkErrorCode | undefined> {
    return Effect.sync(() => {
      const error = this.connectError;
      this.connectError = undefined;
      return error?.code;
    }).pipe(Effect.tap(() => this.notifyReadiness()));
  }

  attachConnected(
    endpoint: TraceKernelTcpEndpoint,
    localAddress: TraceKernelTcpAddress,
    remoteAddress: TraceKernelTcpAddress,
    ownsBinding: boolean
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      this.endpoint = endpoint;
      this.localAddressValue = Object.freeze({ ...localAddress });
      this.remoteAddressValue = Object.freeze({ ...remoteAddress });
      this.ownsBinding = this.ownsBinding || ownsBinding;
      this.state = 'connected';
    }).pipe(Effect.andThen(this.notifyReadiness()));
  }

  reserveImplicitBinding(address: TraceKernelTcpAddress): void {
    this.localAddressValue = Object.freeze({ ...address });
    this.ownsBinding = true;
  }

  clearImplicitBinding(): void {
    if (this.boundAddress) return;
    this.localAddressValue = undefined;
    this.ownsBinding = false;
  }

  enqueue(socket: TraceKernelTcpSocket): Effect.Effect<void, TraceKernelNetworkError> {
    const listener = this.listener;
    if (this.state !== 'listening' || !listener) {
      return Effect.fail(networkError('ECONNREFUSED', 'target port is not listening'));
    }
    return Effect.raceFirst(
      Queue.offer(listener.queue, socket).pipe(Effect.asVoid),
      Deferred.await(listener.closed).pipe(
        Effect.andThen(Effect.fail(networkError('ECONNREFUSED', 'listener closed during connect')))
      )
    ).pipe(Effect.tap(() => this.notifyReadiness()));
  }

  shutdown(how: TraceKernelTcpShutdownHow): Effect.Effect<void, TraceKernelNetworkError> {
    return Effect.suspend(() => {
      if (this.state !== 'connected' || !this.endpoint) {
        return Effect.fail(networkError('ENOTCONN', 'socket is not connected'));
      }
      const effects: Effect.Effect<void>[] = [];
      if ((how === 'read' || how === 'both') && !this.readShutdown) {
        this.readShutdown = true;
        effects.push(this.endpoint.reader.close());
      }
      if ((how === 'write' || how === 'both') && !this.writeShutdown) {
        this.writeShutdown = true;
        effects.push(this.endpoint.writer.close());
      }
      return Effect.all(effects, { concurrency: 'unbounded', discard: true }).pipe(
        Effect.andThen(this.notifyReadiness())
      );
    });
  }

  dispose(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.state === 'closed') return Effect.void;
      this.state = 'closed';
      this.references = 0;
      const listener = this.listener;
      this.listener = undefined;
      const endpoint = this.endpoint;
      this.endpoint = undefined;
      const connectFiber = this.connectFiber;
      this.connectFiber = undefined;
      this.connectToken = undefined;
      this.connectError = undefined;
      const notifyClosed = Deferred.succeed(this.closed, undefined).pipe(Effect.asVoid);
      const closeListener = listener
        ? Deferred.succeed(listener.closed, undefined).pipe(
            Effect.asVoid,
            Effect.andThen(Queue.takeAll(listener.queue)),
            Effect.flatMap((queued) => Effect.forEach(
              queued,
              (socket) => socket.dispose(),
              { concurrency: 'unbounded', discard: true }
            )),
            Effect.ensuring(Queue.shutdown(listener.queue))
          )
        : Effect.void;
      const closeEndpoint = endpoint
        ? Effect.all([
            this.readShutdown ? Effect.void : endpoint.reader.close(),
            this.writeShutdown ? Effect.void : endpoint.writer.close(),
          ], { concurrency: 'unbounded', discard: true })
        : Effect.void;
      return Effect.all([
        notifyClosed,
        this.notifyReadiness(),
        connectFiber ? Fiber.interrupt(connectFiber).pipe(Effect.asVoid) : Effect.void,
        closeListener,
        closeEndpoint,
        this.ownsBinding
          ? this.namespace.releaseBinding(this)
          : Effect.void,
      ], { concurrency: 'unbounded', discard: true }).pipe(
        Effect.ensuring(Effect.sync(() => this.onFullyClosed(this.id)))
      );
    });
  }

  private read(maxBytes: number): Effect.Effect<Uint8Array, Error> {
    if (this.state !== 'connected' || !this.endpoint) {
      return Effect.fail(networkError('ENOTCONN', 'socket is not connected'));
    }
    if (this.readShutdown) {
      return Effect.fail(networkError('EBADF', 'socket read side is shut down'));
    }
    return this.endpoint.reader.read?.(maxBytes)
      ?? Effect.fail(networkError('EBADF', 'socket is not readable'));
  }

  private write(bytes: Uint8Array): Effect.Effect<number, Error> {
    if (this.state !== 'connected' || !this.endpoint) {
      return Effect.fail(networkError('ENOTCONN', 'socket is not connected'));
    }
    if (this.writeShutdown) {
      return Effect.fail(networkError('EBADF', 'socket write side is shut down'));
    }
    return this.endpoint.writer.write?.(bytes)
      ?? Effect.fail(networkError('EBADF', 'socket is not writable'));
  }

  private readNonblocking(maxBytes: number): Effect.Effect<Uint8Array, Error> {
    if (this.state !== 'connected' || !this.endpoint) {
      return Effect.fail(networkError('ENOTCONN', 'socket is not connected'));
    }
    if (this.readShutdown) {
      return Effect.fail(networkError('EBADF', 'socket read side is shut down'));
    }
    return this.endpoint.reader.readNonblocking?.(maxBytes)
      ?? Effect.fail(networkError('EBADF', 'socket is not nonblocking-readable'));
  }

  private writeNonblocking(bytes: Uint8Array): Effect.Effect<number, Error> {
    if (this.state !== 'connected' || !this.endpoint) {
      return Effect.fail(networkError('ENOTCONN', 'socket is not connected'));
    }
    if (this.writeShutdown) {
      return Effect.fail(networkError('EBADF', 'socket write side is shut down'));
    }
    return this.endpoint.writer.writeNonblocking?.(bytes)
      ?? Effect.fail(networkError('EBADF', 'socket is not nonblocking-writable'));
  }

  private acceptedResult(
    socket: TraceKernelTcpSocket
  ): Effect.Effect<TraceKernelTcpAcceptResult, TraceKernelNetworkError> {
    return Effect.all({
      localAddress: socket.localAddress(),
      remoteAddress: socket.remoteAddress(),
    }).pipe(
      Effect.map(({ localAddress, remoteAddress }) => Object.freeze({
        socket,
        localAddress,
        remoteAddress,
      }))
    );
  }

  private readiness(
    events: TraceKernelPollEvents
  ): Effect.Effect<TraceKernelDescriptorReadiness, Error> {
    return Effect.suspend(() => {
      if (this.state === 'closed') {
        return Effect.succeed(Object.freeze({
          read: false,
          write: false,
          hangup: true,
          error: true,
        }));
      }
      if (this.state === 'listening' && this.listener) {
        return Queue.isEmpty(this.listener.queue).pipe(
          Effect.map((empty) => Object.freeze({
            read: events.read && !empty,
            write: false,
            hangup: false,
            error: false,
          }))
        );
      }
      if (this.connectError) {
        return Effect.succeed(Object.freeze({
          read: false,
          write: events.write,
          hangup: false,
          error: true,
        }));
      }
      if (this.state !== 'connected' || !this.endpoint) {
        return Effect.succeed(Object.freeze({
          read: false,
          write: false,
          hangup: false,
          error: false,
        }));
      }
      const endpoint = this.endpoint;
      const read = endpoint.reader.readiness?.({
        read: events.read && !this.readShutdown,
        write: false,
      }) ?? Effect.succeed({
        read: false,
        write: false,
        hangup: false,
        error: false,
      });
      const write = endpoint.writer.readiness?.({
        read: false,
        write: events.write && !this.writeShutdown,
      }) ?? Effect.succeed({
        read: false,
        write: false,
        hangup: false,
        error: false,
      });
      return Effect.all({ read, write }).pipe(
        Effect.map((ready) => Object.freeze({
          read: !this.readShutdown && ready.read.read,
          write: !this.writeShutdown && ready.write.write,
          hangup: this.readShutdown ||
            ready.read.hangup ||
            ready.write.hangup,
          error: ready.read.error || ready.write.error,
        }))
      );
    });
  }

  private awaitReadiness(
    events: TraceKernelPollEvents
  ): Effect.Effect<TraceKernelDescriptorReadiness, Error> {
    return Effect.suspend(() => {
      const changed = this.readinessChanged;
      return this.readiness(events).pipe(
        Effect.flatMap((readiness) => {
          if (
            readiness.read ||
            readiness.write ||
            readiness.hangup ||
            readiness.error
          ) {
            return Effect.succeed(readiness);
          }
          const waits: Effect.Effect<unknown, Error>[] = [
            Deferred.await(changed),
          ];
          if (this.state === 'connected' && this.endpoint) {
            if (this.endpoint.reader.awaitReadiness) {
              waits.push(this.endpoint.reader.awaitReadiness({
                read: events.read && !this.readShutdown,
                write: false,
              }));
            }
            if (this.endpoint.writer.awaitReadiness) {
              waits.push(this.endpoint.writer.awaitReadiness({
                read: false,
                write: events.write && !this.writeShutdown,
              }));
            }
          }
          return Effect.raceAll(waits).pipe(
            Effect.andThen(this.awaitReadiness(events))
          );
        })
      );
    });
  }

  private notifyReadiness(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const previous = this.readinessChanged;
      const next = yield* Deferred.make<void>();
      this.readinessChanged = next;
      yield* Deferred.succeed(previous, undefined);
    });
  }

  private duplicate(): Effect.Effect<TraceKernelDescriptor, Error> {
    if (this.state === 'closed') {
      return Effect.fail(networkError('EBADF', 'socket is closed'));
    }
    this.references += 1;
    return Effect.succeed(this.descriptor());
  }

  private closeReference(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.state === 'closed') return Effect.void;
      this.references -= 1;
      return this.references > 0 ? Effect.void : this.dispose();
    });
  }
}

/**
 * Session-owned local IPv4 namespace.
 *
 * Bindings are exclusive by port for the first foundation. `0.0.0.0` is a
 * wildcard listener and localhost resolves to `127.0.0.1`. External addresses
 * are deliberately rejected rather than silently escaping to browser fetch.
 */
export class TraceKernelNetworkNamespace {
  private readonly bindings = new Map<number, TraceKernelTcpBinding>();
  private readonly sockets = new Map<string, TraceKernelTcpSocket>();
  private readonly listenerChunkCapacity = new Map<string, number>();
  private nextSocketId = 1;
  private nextEphemeralPort = 49_152;
  private closed = false;

  private constructor(
    private readonly mutex: Effect.Semaphore,
    private readonly scope: Scope.CloseableScope
  ) {}

  static make(): Effect.Effect<TraceKernelNetworkNamespace> {
    return Effect.all({
      mutex: Effect.makeSemaphore(1),
      scope: Scope.make(),
    }).pipe(
      Effect.map(({ mutex, scope }) =>
        new TraceKernelNetworkNamespace(mutex, scope)
      )
    );
  }

  fork(
    effect: Effect.Effect<void, never>
  ): Effect.Effect<Fiber.RuntimeFiber<void, never>> {
    return Effect.forkIn(effect, this.scope);
  }

  createSocket(): Effect.Effect<TraceKernelTcpSocket, TraceKernelNetworkError> {
    return Effect.gen(this, function* () {
      if (this.closed) {
        return yield* Effect.fail(networkError('EBADF', 'network namespace is closed'));
      }
      const id = `tcp-${this.nextSocketId++}`;
      const closed = yield* Deferred.make<void>();
      const readinessChanged = yield* Deferred.make<void>();
      const socket = new TraceKernelTcpSocket(
        id,
        this,
        closed,
        readinessChanged,
        (closedId) => this.sockets.delete(closedId)
      );
      this.sockets.set(id, socket);
      return socket;
    });
  }

  resourceIds(): readonly string[] {
    return [...this.sockets.keys()].sort();
  }

  bind(
    socket: TraceKernelTcpSocket,
    requested: TraceKernelTcpAddress
  ): Effect.Effect<TraceKernelTcpAddress, TraceKernelNetworkError> {
    return this.mutex.withPermits(1)(
      Effect.suspend(() => {
        if (this.closed) {
          return Effect.fail(networkError('EBADF', 'network namespace is closed'));
        }
        if (socket.phase !== 'new' && socket.phase !== 'connecting') {
          return Effect.fail(networkError('EINVAL', 'socket is already bound or connected'));
        }
        const host = normalizeHost(requested.host);
        if (host instanceof TraceKernelNetworkError) return Effect.fail(host);
        const requestedPort = normalizePort(requested.port);
        if (requestedPort instanceof TraceKernelNetworkError) return Effect.fail(requestedPort);
        const port = requestedPort === 0
          ? this.allocateEphemeralPort()
          : requestedPort;
        if (port instanceof TraceKernelNetworkError) return Effect.fail(port);
        if (this.bindings.has(port)) {
          return Effect.fail(networkError('EADDRINUSE', `TCP port ${port} is already bound`));
        }
        const address = Object.freeze({ host, port });
        this.bindings.set(port, { address, socket });
        return Effect.succeed(address);
      })
    );
  }

  markListening(socket: TraceKernelTcpSocket, capacityChunks = 16): void {
    this.listenerChunkCapacity.set(
      socket.id,
      Math.max(1, Math.floor(capacityChunks))
    );
  }

  connect(
    client: TraceKernelTcpSocket,
    requested: TraceKernelTcpAddress
  ): Effect.Effect<TraceKernelTcpConnectResult, TraceKernelNetworkError> {
    return Effect.uninterruptibleMask((restore) => Effect.gen(this, function* () {
      const target = yield* this.resolveListener(requested);
      let localAddress: TraceKernelTcpAddress;
      let ownsBinding = false;
      const existingLocal = yield* Effect.option(client.localAddress());
      if (Option.isSome(existingLocal)) {
        localAddress = existingLocal.value;
      } else {
        localAddress = yield* this.bind(client, {
          host: '127.0.0.1',
          port: 0,
        });
        ownsBinding = true;
        client.reserveImplicitBinding(localAddress);
      }
      const serverSocket = yield* this.createSocket();
      const pair = yield* this.makeDuplexPair(
        client.id,
        serverSocket.id,
        this.listenerChunkCapacity.get(target.socket.id) ?? 16
      );
      const listenerAddress = target.address.host === '0.0.0.0'
        ? Object.freeze({ host: '127.0.0.1', port: target.address.port })
        : target.address;
      yield* serverSocket.attachConnected(
        pair.server,
        listenerAddress,
        localAddress,
        false
      );
      const offered = yield* Effect.exit(restore(target.socket.enqueue(serverSocket)));
      if (offered._tag === 'Failure') {
        yield* serverSocket.dispose();
        yield* pair.client.reader.close();
        yield* pair.client.writer.close();
        if (ownsBinding) {
          yield* this.releaseBinding(client);
          client.clearImplicitBinding();
        }
        return yield* Effect.failCause(offered.cause);
      }
      yield* client.attachConnected(
        pair.client,
        localAddress,
        listenerAddress,
        ownsBinding
      );
      return Object.freeze({
        localAddress,
        remoteAddress: listenerAddress,
      });
    }));
  }

  releaseBinding(socket: TraceKernelTcpSocket): Effect.Effect<void> {
    return this.mutex.withPermits(1)(
      Effect.sync(() => {
        for (const [port, binding] of this.bindings) {
          if (binding.socket === socket) this.bindings.delete(port);
        }
        this.listenerChunkCapacity.delete(socket.id);
      })
    );
  }

  dispose(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.closed) return Effect.void;
      this.closed = true;
      const sockets = [...this.sockets.values()];
      return Effect.forEach(
        sockets,
        (socket) => socket.dispose(),
        { concurrency: 'unbounded', discard: true }
      ).pipe(
        Effect.andThen(Scope.close(this.scope, Exit.void)),
        Effect.ensuring(Effect.sync(() => {
          this.bindings.clear();
          this.sockets.clear();
          this.listenerChunkCapacity.clear();
        }))
      );
    });
  }

  private resolveListener(
    requested: TraceKernelTcpAddress
  ): Effect.Effect<TraceKernelTcpBinding, TraceKernelNetworkError> {
    return this.mutex.withPermits(1)(
      Effect.suspend(() => {
        const host = normalizeHost(requested.host);
        if (host instanceof TraceKernelNetworkError) return Effect.fail(host);
        const port = normalizePort(requested.port);
        if (port instanceof TraceKernelNetworkError) return Effect.fail(port);
        const binding = this.bindings.get(port);
        if (
          !binding ||
          binding.socket.phase !== 'listening' ||
          (binding.address.host !== '0.0.0.0' && binding.address.host !== host)
        ) {
          return Effect.fail(networkError(
            'ECONNREFUSED',
            `no listener at ${host}:${port}`
          ));
        }
        return Effect.succeed(binding);
      })
    );
  }

  private allocateEphemeralPort(): number | TraceKernelNetworkError {
    for (let attempt = 0; attempt <= 16_383; attempt += 1) {
      const port = this.nextEphemeralPort;
      this.nextEphemeralPort = port >= 65_535 ? 49_152 : port + 1;
      if (!this.bindings.has(port)) return port;
    }
    return networkError('EADDRINUSE', 'no ephemeral TCP ports are available');
  }

  private makeDuplexPair(
    clientId: string,
    serverId: string,
    capacityChunks: number
  ): Effect.Effect<{
    readonly client: TraceKernelTcpEndpoint;
    readonly server: TraceKernelTcpEndpoint;
  }> {
    return Effect.gen(function* () {
      const clientToServer = yield* TraceKernelPipe.make(
        `${clientId}->${serverId}`,
        { capacityChunks }
      );
      const serverToClient = yield* TraceKernelPipe.make(
        `${serverId}->${clientId}`,
        { capacityChunks }
      );
      return Object.freeze({
        client: Object.freeze({
          reader: serverToClient.reader(),
          writer: clientToServer.writer(),
        }),
        server: Object.freeze({
          reader: clientToServer.reader(),
          writer: serverToClient.writer(),
        }),
      });
    });
  }
}

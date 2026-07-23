import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Queue from 'effect/Queue';
import {
  TraceKernelPipe,
  type TraceKernelDescriptor,
} from './descriptors';
import {
  TraceKernelNetworkError,
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

  constructor(
    readonly id: string,
    private readonly namespace: TraceKernelNetworkNamespace,
    private readonly closed: Deferred.Deferred<void>,
    private readonly onFullyClosed: (id: string) => void
  ) {}

  descriptor(): TraceKernelDescriptor {
    return {
      kind: 'tcp-socket',
      resourceId: this.id,
      resource: this,
      read: (maxBytes) => this.read(maxBytes),
      write: (bytes) => this.write(bytes),
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
        Effect.flatMap((socket) => Effect.all({
          localAddress: socket.localAddress(),
          remoteAddress: socket.remoteAddress(),
        }).pipe(
          Effect.map(({ localAddress, remoteAddress }) => Object.freeze({
            socket,
            localAddress,
            remoteAddress,
          }))
        ))
      );
    });
  }

  connect(
    address: TraceKernelTcpAddress
  ): Effect.Effect<TraceKernelTcpConnectResult, TraceKernelNetworkError> {
    return Effect.suspend(() => {
      if (this.state === 'closed') {
        return Effect.fail(networkError('EBADF', 'socket is closed'));
      }
      if (this.state === 'connected' || this.state === 'connecting') {
        return Effect.fail(networkError('EISCONN', 'socket is already connected'));
      }
      if (this.state === 'listening') {
        return Effect.fail(networkError('EOPNOTSUPP', 'listening socket cannot connect'));
      }
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

  attachConnected(
    endpoint: TraceKernelTcpEndpoint,
    localAddress: TraceKernelTcpAddress,
    remoteAddress: TraceKernelTcpAddress,
    ownsBinding: boolean
  ): void {
    this.endpoint = endpoint;
    this.localAddressValue = Object.freeze({ ...localAddress });
    this.remoteAddressValue = Object.freeze({ ...remoteAddress });
    this.ownsBinding = this.ownsBinding || ownsBinding;
    this.state = 'connected';
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
    );
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
      return Effect.all(effects, { concurrency: 'unbounded', discard: true });
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

  private constructor(private readonly mutex: Effect.Semaphore) {}

  static make(): Effect.Effect<TraceKernelNetworkNamespace> {
    return Effect.makeSemaphore(1).pipe(
      Effect.map((mutex) => new TraceKernelNetworkNamespace(mutex))
    );
  }

  createSocket(): Effect.Effect<TraceKernelTcpSocket, TraceKernelNetworkError> {
    return Effect.gen(this, function* () {
      if (this.closed) {
        return yield* Effect.fail(networkError('EBADF', 'network namespace is closed'));
      }
      const id = `tcp-${this.nextSocketId++}`;
      const closed = yield* Deferred.make<void>();
      const socket = new TraceKernelTcpSocket(
        id,
        this,
        closed,
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
      serverSocket.attachConnected(
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
      client.attachConnected(pair.client, localAddress, listenerAddress, ownsBinding);
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

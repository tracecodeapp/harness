import { BrowserTraceKernelNetwork } from "../../browser/contracts";

import { BrowserBuffer, bytesFromNodeValue } from "../../internal/encoding";

import { createListenerMap, dispatchBrowserNetworkSyscall } from "./shared";

export function normalizeNetConnectArgs(args: unknown[]): {
  port: number;
  host: string;
  callback?: () => void;
} {
  const callback = args.find((value): value is () => void => typeof value === 'function');
  const first = args[0];
  if (typeof first === 'object' && first !== null) {
    const options = first as { port?: unknown; host?: unknown };
    return {
      port: Number(options.port),
      host: typeof options.host === 'string' ? options.host : '127.0.0.1',
      ...(callback ? { callback } : {}),
    };
  }
  return {
    port: Number(first),
    host: typeof args[1] === 'string' ? args[1] : '127.0.0.1',
    ...(callback ? { callback } : {}),
  };
}

export function createNetApi(
  kernelNetwork: BrowserTraceKernelNetwork | undefined,
  signal: AbortSignal | undefined
) {
  type NetSocket = ReturnType<typeof createSocket>;
  const activeSockets = new Set<NetSocket>();
  const activeServers = new Set<ReturnType<typeof createServer>>();
  const closeWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  let activeWorkError: Error | null = null;

  const notifyCloseWaiters = (): void => {
    if (activeSockets.size > 0 || activeServers.size > 0) return;
    while (closeWaiters.length > 0) {
      const waiter = closeWaiters.shift();
      if (!waiter) continue;
      if (activeWorkError) waiter.reject(activeWorkError);
      else waiter.resolve();
    }
  };

  function createSocket(existingFd?: number) {
    const events = createListenerMap();
    let fd = existingFd;
    let destroyed = false;
    let connected = false;
    let readableEnded = false;
    let writableEnded = false;
    let paused = false;
    let resumeReader: (() => void) | undefined;
    let encoding: string | undefined;
    let localAddress: { host: string; port: number } | undefined;
    let remoteAddress: { host: string; port: number } | undefined;
    let writeTail = Promise.resolve();
    let onFinalClose: (() => void) | undefined;

    const removeActive = (): void => {
      if (!activeSockets.delete(socket)) return;
      onFinalClose?.();
      notifyCloseWaiters();
    };
    const closeDescriptor = async (): Promise<void> => {
      const closingFd = fd;
      fd = undefined;
      if (closingFd === undefined) return;
      try {
        await dispatchBrowserNetworkSyscall(kernelNetwork, {
          op: 'close',
          fd: closingFd,
        });
      } catch (error) {
        if ((error as { code?: unknown })?.code !== 'EBADF') throw error;
      }
    };
    const fail = (error: unknown): void => {
      const cause = error instanceof Error ? error : new Error(String(error));
      try {
        if (!events.emit('error', cause)) activeWorkError ??= cause;
      } catch (listenerError) {
        activeWorkError ??= listenerError instanceof Error
          ? listenerError
          : new Error(String(listenerError));
      }
    };
    const finishClose = async (error?: unknown): Promise<void> => {
      if (destroyed) return;
      destroyed = true;
      resumeReader?.();
      resumeReader = undefined;
      try {
        await closeDescriptor();
      } catch (closeError) {
        error ??= closeError;
      }
      if (error) fail(error);
      events.emit('close', Boolean(error));
      removeActive();
    };
    const receive = async (): Promise<void> => {
      while (!destroyed && fd !== undefined) {
        try {
          if (paused) {
            await new Promise<void>((resolve) => {
              resumeReader = resolve;
            });
            resumeReader = undefined;
            if (destroyed) return;
          }
          const result = await dispatchBrowserNetworkSyscall(kernelNetwork, {
            op: 'recv',
            fd,
            maxBytes: 64 * 1024,
          });
          if (result.bytes.byteLength === 0) {
            readableEnded = true;
            events.emit('end');
            await writeTail;
            if (!writableEnded && fd !== undefined) {
              writableEnded = true;
              await dispatchBrowserNetworkSyscall(kernelNetwork, {
                op: 'shutdown',
                fd,
                how: 'write',
              });
            }
            await finishClose();
            return;
          }
          const chunk = BrowserBuffer.from(result.bytes);
          events.emit(
            'data',
            encoding ? chunk.toString(encoding as BufferEncoding) : chunk
          );
        } catch (error) {
          if (!destroyed) await finishClose(error);
          return;
        }
      }
    };
    const attach = (
      nextFd: number,
      nextLocalAddress: { host: string; port: number },
      nextRemoteAddress: { host: string; port: number },
      emitConnect: boolean
    ): void => {
      fd = nextFd;
      localAddress = nextLocalAddress;
      remoteAddress = nextRemoteAddress;
      connected = true;
      activeSockets.add(socket);
      if (emitConnect) events.emit('connect');
      void receive();
    };

    const socket = {
      connecting: false,
      get destroyed() {
        return destroyed;
      },
      get readableEnded() {
        return readableEnded;
      },
      get writableEnded() {
        return writableEnded;
      },
      get remoteAddress() {
        return remoteAddress?.host;
      },
      get remotePort() {
        return remoteAddress?.port;
      },
      get remoteFamily() {
        return remoteAddress ? 'IPv4' : undefined;
      },
      address: () => localAddress
        ? { address: localAddress.host, port: localAddress.port, family: 'IPv4' }
        : {},
      connect: (...args: unknown[]) => {
        const options = normalizeNetConnectArgs(args);
        if (options.callback) events.once('connect', options.callback);
        socket.connecting = true;
        activeSockets.add(socket);
        void (async () => {
          try {
            const created = await dispatchBrowserNetworkSyscall(kernelNetwork, {
              op: 'socket',
            });
            fd = created.fd;
            const connection = await dispatchBrowserNetworkSyscall(kernelNetwork, {
              op: 'connect',
              fd,
              address: { host: options.host, port: options.port },
            });
            socket.connecting = false;
            attach(
              fd,
              connection.localAddress,
              connection.remoteAddress,
              true
            );
          } catch (error) {
            socket.connecting = false;
            await finishClose(error);
          }
        })();
        return socket;
      },
      write: (chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
        const writeCallback = typeof encodingOrCallback === 'function'
          ? encodingOrCallback as (error?: Error) => void
          : typeof callback === 'function'
            ? callback as (error?: Error) => void
            : undefined;
        const bytes = typeof chunk === 'string'
          ? BrowserBuffer.from(
              chunk,
              typeof encodingOrCallback === 'string'
                ? encodingOrCallback as BufferEncoding
                : 'utf8'
            )
          : BrowserBuffer.from(bytesFromNodeValue(chunk));
        writeTail = writeTail.then(async () => {
          if (destroyed || fd === undefined || !connected) {
            throw Object.assign(new Error('ENOTCONN: socket is not connected'), {
              code: 'ENOTCONN',
            });
          }
          await dispatchBrowserNetworkSyscall(kernelNetwork, {
            op: 'send',
            fd,
            bytes,
          });
        });
        void writeTail.then(
          () => writeCallback?.(),
          (error) => {
            writeCallback?.(error instanceof Error ? error : new Error(String(error)));
            void finishClose(error);
          }
        );
        return true;
      },
      end: (chunk?: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
        const endCallback = typeof encodingOrCallback === 'function'
          ? encodingOrCallback as () => void
          : typeof callback === 'function'
            ? callback as () => void
            : undefined;
        if (chunk !== undefined) socket.write(chunk, typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined);
        writeTail = writeTail.then(async () => {
          if (fd !== undefined && !writableEnded) {
            writableEnded = true;
            await dispatchBrowserNetworkSyscall(kernelNetwork, {
              op: 'shutdown',
              fd,
              how: 'write',
            });
          }
          events.emit('finish');
          endCallback?.();
          if (readableEnded) await finishClose();
        });
        void writeTail.catch((error) => finishClose(error));
        return socket;
      },
      destroy: (error?: Error) => {
        void finishClose(error);
        return socket;
      },
      setEncoding: (nextEncoding: string) => {
        encoding = nextEncoding;
        return socket;
      },
      setNoDelay: () => socket,
      setKeepAlive: () => socket,
      pause: () => {
        paused = true;
        return socket;
      },
      resume: () => {
        paused = false;
        resumeReader?.();
        resumeReader = undefined;
        return socket;
      },
      on: events.on,
      addListener: events.addListener,
      once: events.once,
      removeListener: events.removeListener,
      off: events.off,
      emit: events.emit,
      _attach: attach,
      _setOnFinalClose: (listener: () => void) => {
        onFinalClose = listener;
      },
    };
    return socket;
  }

  function createServer(connectionListener?: (socket: NetSocket) => void) {
    const events = createListenerMap();
    const connections = new Set<NetSocket>();
    let fd: number | undefined;
    let listening = false;
    let closing = false;
    let boundAddress: { host: string; port: number } | undefined;

    const maybeFinishClose = (): void => {
      if (!closing || connections.size > 0 || fd !== undefined) return;
      activeServers.delete(server);
      events.emit('close');
      notifyCloseWaiters();
    };
    const recordServerError = (error: unknown): void => {
      const cause = error instanceof Error ? error : new Error(String(error));
      try {
        if (!events.emit('error', cause)) activeWorkError ??= cause;
      } catch (listenerError) {
        activeWorkError ??= listenerError instanceof Error
          ? listenerError
          : new Error(String(listenerError));
      }
    };
    const acceptLoop = async (): Promise<void> => {
      while (listening && fd !== undefined) {
        try {
          const accepted = await dispatchBrowserNetworkSyscall(kernelNetwork, {
            op: 'accept',
            fd,
          });
          if (!listening) {
            await dispatchBrowserNetworkSyscall(kernelNetwork, {
              op: 'close',
              fd: accepted.fd,
            });
            continue;
          }
          const socket = createSocket(accepted.fd);
          connections.add(socket);
          socket._setOnFinalClose(() => {
            connections.delete(socket);
            maybeFinishClose();
          });
          socket._attach(
            accepted.fd,
            accepted.localAddress,
            accepted.remoteAddress,
            false
          );
          events.emit('connection', socket);
        } catch (error) {
          if (listening) {
            recordServerError(error);
            closing = true;
            listening = false;
            const closingFd = fd;
            fd = undefined;
            if (closingFd !== undefined) {
              await dispatchBrowserNetworkSyscall(kernelNetwork, {
                op: 'close',
                fd: closingFd,
              }).catch(() => undefined);
            }
          }
          break;
        }
      }
      maybeFinishClose();
    };

    const server = {
      get listening() {
        return listening;
      },
      listen: (...args: unknown[]) => {
        const callback = args.find((value): value is () => void => typeof value === 'function');
        const first = args[0];
        const options = typeof first === 'object' && first !== null
          ? first as { port?: unknown; host?: unknown; backlog?: unknown }
          : {
              port: first,
              host: typeof args[1] === 'string' ? args[1] : undefined,
              backlog: undefined,
            };
        activeServers.add(server);
        void (async () => {
          try {
            const created = await dispatchBrowserNetworkSyscall(kernelNetwork, {
              op: 'socket',
            });
            fd = created.fd;
            boundAddress = await dispatchBrowserNetworkSyscall(kernelNetwork, {
              op: 'bind',
              fd,
              address: {
                host: typeof options.host === 'string' ? options.host : '127.0.0.1',
                port: Number(options.port),
              },
            }).then((result) => result.address);
            await dispatchBrowserNetworkSyscall(kernelNetwork, {
              op: 'listen',
              fd,
              options: {
                ...(Number.isFinite(Number(options.backlog))
                  ? { backlog: Number(options.backlog) }
                  : {}),
              },
            });
            listening = true;
            events.emit('listening');
            callback?.();
            void acceptLoop();
          } catch (error) {
            recordServerError(error);
            closing = true;
            if (fd !== undefined) {
              const closingFd = fd;
              fd = undefined;
              await dispatchBrowserNetworkSyscall(kernelNetwork, {
                op: 'close',
                fd: closingFd,
              }).catch(() => undefined);
            }
            maybeFinishClose();
          }
        })();
        return server;
      },
      close: (callback?: (error?: Error) => void) => {
        if (callback) events.once('close', callback as () => void);
        closing = true;
        listening = false;
        const closingFd = fd;
        fd = undefined;
        if (closingFd !== undefined) {
          void dispatchBrowserNetworkSyscall(kernelNetwork, {
            op: 'close',
            fd: closingFd,
          }).then(maybeFinishClose, (error) => {
            recordServerError(error);
            maybeFinishClose();
          });
        } else {
          queueMicrotask(maybeFinishClose);
        }
        return server;
      },
      address: () => boundAddress
        ? { address: boundAddress.host, port: boundAddress.port, family: 'IPv4' }
        : null,
      getConnections: (callback: (error: Error | null, count: number) => void) => {
        queueMicrotask(() => callback(null, connections.size));
      },
      on: events.on,
      addListener: events.addListener,
      once: events.once,
      removeListener: events.removeListener,
      off: events.off,
      emit: events.emit,
    };
    if (connectionListener) server.on('connection', connectionListener as (...args: unknown[]) => void);
    return server;
  }

  const closeAll = (): void => {
    for (const server of [...activeServers]) server.close();
    for (const socket of [...activeSockets]) socket.destroy();
  };
  signal?.addEventListener('abort', closeAll, { once: true });

  const connect = (...args: unknown[]) => createSocket().connect(...args);
  const Socket = function Socket(this: unknown) {
    return createSocket();
  };
  const Server = function Server(
    this: unknown,
    connectionListener?: (socket: NetSocket) => void
  ) {
    return createServer(connectionListener);
  };

  return {
    module: {
      createServer,
      connect,
      createConnection: connect,
      Socket,
      Server,
      isIP: (input: string) => input === '127.0.0.1' || input === '0.0.0.0' ? 4 : 0,
      isIPv4: (input: string) => input === '127.0.0.1' || input === '0.0.0.0',
      isIPv6: () => false,
    },
    hasActiveWork: () => activeSockets.size > 0 || activeServers.size > 0 || activeWorkError !== null,
    waitForClose: () => activeSockets.size === 0 && activeServers.size === 0
      ? activeWorkError ? Promise.reject(activeWorkError) : Promise.resolve()
      : new Promise<void>((resolve, reject) => closeWaiters.push({ resolve, reject })),
    closeAll,
  };
}

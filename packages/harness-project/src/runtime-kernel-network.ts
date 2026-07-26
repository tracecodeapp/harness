import {
  TraceKernelNetworkNamespace,
  TraceKernelTcpSocket,
  type TraceKernelDescriptor,
  type TraceKernelTcpAcceptResult,
  type TraceKernelTcpAddress,
  type TraceKernelTcpConnectResult,
  type TraceKernelTcpListenOptions,
  type TraceKernelTcpShutdownHow,
} from '@tracecode/tracekernel';
import * as Effect from 'effect/Effect';

export interface RuntimeKernelDescriptorRegistry {
  install(pid: number, descriptor: TraceKernelDescriptor): number;
  descriptor(
    pid: number,
    fd: number,
    operation: string
  ): Promise<TraceKernelDescriptor>;
  getNonblocking(pid: number, fd: number): Promise<boolean>;
}

/**
 * Transitional RuntimeWorkspace owner for TraceKernel's session-local network
 * namespace.
 *
 * Socket state and byte streams remain implemented by TraceKernel. This
 * adapter only associates the workspace's existing process IDs and unified
 * descriptor registry with the kernel namespace while RuntimeWorkspace is
 * progressively replaced by a native TraceKernel session.
 */
export class RuntimeKernelNetworkManager {
  private readonly namespace = Effect.runPromise(
    TraceKernelNetworkNamespace.make()
  );

  constructor(
    private readonly descriptors: RuntimeKernelDescriptorRegistry
  ) {}

  async socket(pid: number): Promise<number> {
    const namespace = await this.namespace;
    const socket = await Effect.runPromise(namespace.createSocket());
    const descriptor = socket.descriptor();
    try {
      return this.descriptors.install(pid, descriptor);
    } catch (error) {
      await Effect.runPromise(descriptor.close());
      throw error;
    }
  }

  async bind(
    pid: number,
    fd: number,
    address: TraceKernelTcpAddress
  ): Promise<TraceKernelTcpAddress> {
    const socket = await this.socketFor(pid, fd, 'bind');
    return Effect.runPromise(socket.bind(address));
  }

  async listen(
    pid: number,
    fd: number,
    options?: TraceKernelTcpListenOptions
  ): Promise<void> {
    const socket = await this.socketFor(pid, fd, 'listen');
    await Effect.runPromise(socket.listen(options));
  }

  async accept(
    pid: number,
    fd: number
  ): Promise<TraceKernelTcpAcceptResult & { readonly fd: number }> {
    const listener = await this.socketFor(pid, fd, 'accept');
    const nonblocking = await this.descriptors.getNonblocking(pid, fd);
    const accepted = await Effect.runPromise(
      nonblocking ? listener.acceptNonblocking() : listener.accept()
    );
    const descriptor = accepted.socket.descriptor();
    let acceptedFd: number;
    try {
      acceptedFd = this.descriptors.install(pid, descriptor);
    } catch (error) {
      await Effect.runPromise(descriptor.close());
      throw error;
    }
    return Object.freeze({
      ...accepted,
      fd: acceptedFd,
    });
  }

  async connect(
    pid: number,
    fd: number,
    address: TraceKernelTcpAddress
  ): Promise<TraceKernelTcpConnectResult> {
    const socket = await this.socketFor(pid, fd, 'connect');
    return Effect.runPromise(socket.connect(address));
  }

  async shutdown(
    pid: number,
    fd: number,
    how: TraceKernelTcpShutdownHow
  ): Promise<void> {
    const socket = await this.socketFor(pid, fd, 'shutdown');
    await Effect.runPromise(socket.shutdown(how));
  }

  async localAddress(
    pid: number,
    fd: number
  ): Promise<TraceKernelTcpAddress> {
    const socket = await this.socketFor(pid, fd, 'getsockname');
    return Effect.runPromise(socket.localAddress());
  }

  async remoteAddress(
    pid: number,
    fd: number
  ): Promise<TraceKernelTcpAddress> {
    const socket = await this.socketFor(pid, fd, 'getpeername');
    return Effect.runPromise(socket.remoteAddress());
  }

  async dispose(): Promise<void> {
    const namespace = await this.namespace;
    await Effect.runPromise(namespace.dispose());
  }

  private async socketFor(
    pid: number,
    fd: number,
    operation: string
  ): Promise<TraceKernelTcpSocket> {
    const descriptor = await this.descriptors.descriptor(pid, fd, operation);
    if (
      descriptor.kind !== 'tcp-socket' ||
      !(descriptor.resource instanceof TraceKernelTcpSocket)
    ) {
      throw Object.assign(
        new Error(`EBADF: descriptor ${fd} is not a TCP socket, ${operation}`),
        { code: 'EBADF' }
      );
    }
    return descriptor.resource;
  }
}

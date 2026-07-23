import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as Effect from 'effect/Effect';
import {
  TraceKernelDescriptorTable,
  type TraceKernelDescriptor,
} from '@tracecode/tracekernel';
import {
  RuntimeKernelNetworkManager,
  type RuntimeKernelDescriptorRegistry,
} from '../packages/harness-project/src/runtime-kernel-network';

class TestProcessDescriptorRegistry implements RuntimeKernelDescriptorRegistry {
  private readonly tables = new Map<number, TraceKernelDescriptorTable>();

  install(pid: number, descriptor: TraceKernelDescriptor): number {
    return this.table(pid).install(descriptor);
  }

  descriptor(
    pid: number,
    fd: number,
    _operation: string
  ): Promise<TraceKernelDescriptor> {
    return Effect.runPromise(this.table(pid).lookup(fd));
  }

  closeProcess(pid: number): Promise<void> {
    const table = this.tables.get(pid);
    this.tables.delete(pid);
    return table ? Effect.runPromise(table.closeAll()) : Promise.resolve();
  }

  private table(pid: number): TraceKernelDescriptorTable {
    let table = this.tables.get(pid);
    if (!table) {
      table = new TraceKernelDescriptorTable();
      this.tables.set(pid, table);
    }
    return table;
  }
}

function inertFileDescriptor(resourceId: string): TraceKernelDescriptor {
  return {
    kind: 'file',
    resourceId,
    duplicate: () => Effect.succeed(inertFileDescriptor(resourceId)),
    close: () => Effect.void,
  };
}

async function writeDescriptor(
  registry: TestProcessDescriptorRegistry,
  pid: number,
  fd: number,
  bytes: Uint8Array
): Promise<number> {
  const descriptor = await registry.descriptor(pid, fd, 'write');
  assert.ok(descriptor.write);
  return Effect.runPromise(descriptor.write(bytes));
}

async function readDescriptor(
  registry: TestProcessDescriptorRegistry,
  pid: number,
  fd: number,
  maxBytes: number
): Promise<Uint8Array> {
  const descriptor = await registry.descriptor(pid, fd, 'read');
  assert.ok(descriptor.read);
  return Effect.runPromise(descriptor.read(maxBytes));
}

export async function runTraceKernelWorkspaceNetworkConformance(): Promise<void> {
  const registry = new TestProcessDescriptorRegistry();
  const network = new RuntimeKernelNetworkManager(registry);
  const serverPid = 101;
  const clientPid = 102;

  const serverFd = await network.socket(serverPid);
  assert.equal(serverFd, 3);
  const fileFd = registry.install(clientPid, inertFileDescriptor('client-file'));
  assert.equal(fileFd, 3);
  const clientFd = await network.socket(clientPid);
  assert.equal(
    clientFd,
    4,
    'socket descriptors must share the process fd allocator with regular files'
  );

  const listeningAddress = await network.bind(serverPid, serverFd, {
    host: '127.0.0.1',
    port: 0,
  });
  await network.listen(serverPid, serverFd, {
    backlog: 2,
    capacityChunks: 2,
  });

  const accepting = network.accept(serverPid, serverFd);
  const connected = await network.connect(clientPid, clientFd, listeningAddress);
  const accepted = await accepting;
  assert.equal(accepted.fd, 4);
  assert.deepEqual(connected.remoteAddress, listeningAddress);
  assert.deepEqual(accepted.localAddress, listeningAddress);

  const request = new TextEncoder().encode('ping');
  assert.equal(await writeDescriptor(registry, clientPid, clientFd, request), 4);
  assert.equal(
    new TextDecoder().decode(
      await readDescriptor(registry, serverPid, accepted.fd, 2)
    ),
    'pi'
  );
  assert.equal(
    new TextDecoder().decode(
      await readDescriptor(registry, serverPid, accepted.fd, 8)
    ),
    'ng'
  );

  await network.shutdown(clientPid, clientFd, 'write');
  assert.equal(
    (await readDescriptor(registry, serverPid, accepted.fd, 8)).byteLength,
    0,
    'write shutdown must surface as peer EOF'
  );

  await registry.closeProcess(clientPid);
  await registry.closeProcess(serverPid);
  await network.dispose();

  console.log(JSON.stringify({
    schema: 'tracekernel-013-workspace-network-conformance-v1',
    sharedProcessDescriptorNamespace: true,
    localTcpLifecycle: true,
    fragmentedReads: true,
    writeHalfClose: true,
  }, null, 2));
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : '';

if (invokedPath === import.meta.url) {
  await runTraceKernelWorkspaceNetworkConformance();
}

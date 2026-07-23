import { parentPort, workerData } from 'node:worker_threads';
import {
  TraceKernelRuntimeFileClient,
  TraceKernelSharedGenerationSource,
  TraceKernelSharedSyscallClient,
  TraceKernelTransportError,
} from '../../packages/tracekernel/dist/index.js';

if (!parentPort) throw new Error('TraceKernel transport fixture requires a parent port.');
const hostPort = parentPort;
const transport = new TraceKernelSharedSyscallClient(
  workerData.channel,
  () => hostPort.postMessage({ type: 'syscall' }),
  { timeoutMs: 10_000 }
);
const files = new TraceKernelRuntimeFileClient(transport, {
  generation: new TraceKernelSharedGenerationSource(workerData.generationBuffer),
  maxCacheEntries: 8,
  maxCacheBytes: 4096,
});

hostPort.on('message', (request) => {
  try {
    switch (request.op) {
      case 'read-twice': {
        const first = files.readFile(request.path);
        first.fill(0);
        const second = files.readFile(request.path);
        hostPort.postMessage({
          type: 'result',
          id: request.id,
          bytes: second,
          transportCalls: transport.calls,
          cacheHits: files.cacheHits,
          cacheMisses: files.cacheMisses,
        });
        break;
      }
      case 'read':
        hostPort.postMessage({
          type: 'result',
          id: request.id,
          bytes: files.readFile(request.path),
          transportCalls: transport.calls,
          cacheHits: files.cacheHits,
          cacheMisses: files.cacheMisses,
        });
        break;
      case 'read-many': {
        const beforeCalls = transport.calls;
        const startedAt = performance.now();
        for (let index = 0; index < request.iterations; index += 1) {
          files.readFile(request.path);
        }
        hostPort.postMessage({
          type: 'result',
          id: request.id,
          elapsedMs: performance.now() - startedAt,
          syscallCalls: transport.calls - beforeCalls,
        });
        break;
      }
      case 'read-uncached-many': {
        const beforeCalls = transport.calls;
        const startedAt = performance.now();
        for (let index = 0; index < request.iterations; index += 1) {
          const result = transport.dispatchSync({ op: 'readFile', path: request.path });
          if (!result.ok || result.value.op !== 'readFile') {
            throw new Error(`Unexpected uncached benchmark result: ${JSON.stringify(result)}`);
          }
        }
        hostPort.postMessage({
          type: 'result',
          id: request.id,
          elapsedMs: performance.now() - startedAt,
          syscallCalls: transport.calls - beforeCalls,
        });
        break;
      }
      case 'write':
        files.writeFile(request.path, request.bytes);
        hostPort.postMessage({
          type: 'result',
          id: request.id,
          transportCalls: transport.calls,
        });
        break;
      case 'socket-listen': {
        const fd = files.socket();
        const address = files.bind(fd, {
          host: '127.0.0.1',
          port: 0,
        });
        files.listen(fd, { backlog: 4, capacityChunks: 2 });
        hostPort.postMessage({
          type: 'result',
          id: request.id,
          fd,
          address,
        });
        break;
      }
      case 'socket-accept-recv': {
        const accepted = files.accept(request.fd);
        const bytes = files.recv(accepted.fd, 1024);
        files.closeDescriptor(accepted.fd);
        hostPort.postMessage({
          type: 'result',
          id: request.id,
          bytes,
          address: accepted.remoteAddress,
        });
        break;
      }
      case 'socket-connect-send': {
        const fd = files.socket();
        const connected = files.connect(fd, request.address);
        const bytesWritten = files.send(fd, request.bytes);
        files.shutdown(fd, 'write');
        files.closeDescriptor(fd);
        hostPort.postMessage({
          type: 'result',
          id: request.id,
          bytesWritten,
          address: connected.localAddress,
        });
        break;
      }
      case 'close':
        transport.close();
        hostPort.postMessage({ type: 'result', id: request.id });
        break;
    }
  } catch (error) {
    hostPort.postMessage({
      type: 'result',
      id: request.id,
      error: {
        code: error instanceof TraceKernelTransportError ? error.code : error?.code,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

hostPort.postMessage({ type: 'ready' });

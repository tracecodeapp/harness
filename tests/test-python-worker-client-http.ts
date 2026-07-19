#!/usr/bin/env npx tsx

import { PythonWorkerClient, type PythonProjectCommandRequest } from '../packages/harness-browser/src/pyodide-worker-client';
import type {
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpHandler,
  RuntimeKernelHttpListenOptions,
  RuntimeKernelHttpListenerHandle,
  RuntimeKernelHttpRequest,
} from '../packages/harness-core/src/runtime-project';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

class PythonProtocolWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly postedMessages: unknown[] = [];
  capturedKernelHttpRequest: RuntimeKernelHttpRequest | undefined;
  nestedDispatchResultSeen = false;
  private inboundRequestId: string | undefined;
  private executeMessage:
    | {
        id: string;
        protocolToken: string;
      }
    | undefined;

  constructor(readonly url: string) {
    queueMicrotask(() => this.emit({ type: 'worker-ready' }));
  }

  postMessage(message: unknown): void {
    this.postedMessages.push(message);
    const envelope = message as {
      id?: string;
      type?: string;
      protocolToken?: string;
      payload?: {
        type?: string;
        listenerId?: string;
        requestId?: string;
        request?: RuntimeKernelHttpRequest;
      };
    };
    if (!envelope.id || !envelope.protocolToken) return;

    if (envelope.type === 'init') {
      queueMicrotask(() => {
        this.emit({
          id: envelope.id,
          type: 'init-result',
          protocolToken: envelope.protocolToken,
          payload: { success: true, loadTimeMs: 0 },
        });
      });
      return;
    }

    if (envelope.type === 'warmup') {
      queueMicrotask(() => {
        this.emit({
          id: envelope.id,
          type: 'warmup-result',
          protocolToken: envelope.protocolToken,
          payload: { success: true, loadTimeMs: 0 },
        });
      });
      return;
    }

    if (envelope.type === 'execute-project-python') {
      this.executeMessage = { id: envelope.id, protocolToken: envelope.protocolToken };
      queueMicrotask(() => {
        this.emit({
          id: envelope.id,
          type: 'kernel-http-listen',
          protocolToken: envelope.protocolToken,
          payload: {
            type: 'kernel-http-listen',
            listenerId: 'python-listener-1',
            options: { host: '127.0.0.1', port: 17701 },
          },
        });
      });
      return;
    }

    if (envelope.type === 'kernel-http-request') {
      this.inboundRequestId = envelope.payload?.requestId;
      this.capturedKernelHttpRequest = envelope.payload?.request;
      assertCondition(
        !('signal' in (this.capturedKernelHttpRequest as unknown as Record<string, unknown>)),
        `Python worker-bound HTTP request should omit AbortSignal: ${JSON.stringify(this.capturedKernelHttpRequest)}`
      );
      queueMicrotask(() => {
        this.emit({
          id: envelope.id,
          type: 'kernel-http-dispatch',
          protocolToken: envelope.protocolToken,
          payload: {
            type: 'kernel-http-dispatch',
            requestId: 'nested-dispatch-1',
            request: {
              method: 'GET',
              url: 'http://localhost:17702/upstream',
              path: '/upstream',
              headers: { 'x-server': 'python' },
              body: '',
            },
            timeoutMs: 1234,
          },
        });
      });
      return;
    }

    if (envelope.type === 'kernel-http-dispatch-result') {
      this.nestedDispatchResultSeen = true;
      const execute = this.executeMessage;
      assertCondition(Boolean(execute), 'Python execute message should be active before nested dispatch result');
      queueMicrotask(() => {
        this.emit({
          id: envelope.id,
          type: 'kernel-http-response',
          protocolToken: envelope.protocolToken,
          payload: {
            type: 'kernel-http-response',
            requestId: this.inboundRequestId,
            response: {
              status: 209,
              headers: { 'content-type': 'text/plain' },
              body: 'python-listener-ok\n',
            },
          },
        });
        this.emit({
          id: execute!.id,
          type: 'execute-result',
          protocolToken: execute!.protocolToken,
          payload: { stdout: 'done\n', stderr: '', exitCode: 0 },
        });
      });
    }
  }

  terminate(): void {}

  private emit(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }
}

async function testPythonWorkerHttpRequestsAreSerializableAndReentrant(): Promise<void> {
  const previousWorker = (globalThis as { Worker?: unknown }).Worker;
  const workerInstances: PythonProtocolWorker[] = [];
  (globalThis as { Worker?: unknown }).Worker = class extends PythonProtocolWorker {
    constructor(url: string) {
      super(url);
      workerInstances.push(this);
    }
  };

  const dispatches: Array<{ request: RuntimeKernelHttpRequest; timeoutMs?: number }> = [];
  let listenerHandler: RuntimeKernelHttpHandler | undefined;
  const kernelHttp: RuntimeKernelHttpBridge = {
    listen(options: RuntimeKernelHttpListenOptions, handler: RuntimeKernelHttpHandler): RuntimeKernelHttpListenerHandle {
      listenerHandler = handler;
      return {
        id: 'host-listener-1',
        info: {
          id: 'host-listener-1',
          pid: 1,
          host: options.host ?? '127.0.0.1',
          port: options.port,
          protocol: options.protocol ?? 'http',
          startedAt: new Date(0).toISOString(),
        },
        close() {},
      };
    },
    async dispatch(request, options) {
      dispatches.push({
        request,
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      return {
        status: 204,
        headers: { 'content-type': 'text/plain' },
        body: 'nested-ok\n',
      };
    },
  };

  try {
    const client = new PythonWorkerClient({ workerUrl: '/workers/pyodide-worker.js', debug: false });
    const executePromise = client.executeProjectPython(
      ({
        source: 'file',
        scriptPath: 'server.py',
        args: [],
        cwd: '/workspace',
        env: {},
        project: { cwd: '/workspace', files: [{ path: 'server.py', contents: '' }] },
        kernelHttp,
      } as unknown as PythonProjectCommandRequest),
      1000
    );

    for (let attempt = 0; attempt < 20 && !listenerHandler; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assertCondition(Boolean(listenerHandler), 'Python worker should register a TraceKernel HTTP listener');

    const controller = new AbortController();
    const response = await listenerHandler!({
      method: 'POST',
      url: 'http://localhost:17701/inbound',
      path: '/inbound',
      headers: { 'content-type': 'text/plain' },
      body: 'from-js',
      signal: controller.signal,
    });
    const result = await executePromise;
    const worker = workerInstances[0];

    assertCondition(response.status === 209 && response.body === 'python-listener-ok\n', 'Python worker listener response should return to host');
    assertCondition(result.exitCode === 0 && result.stdout === 'done\n', 'Python worker execute request should complete');
    assertCondition(worker?.nestedDispatchResultSeen === true, 'Python worker should receive nested dispatch result while handling a request');
    assertCondition(
      dispatches.length === 1 &&
        dispatches[0]?.request.path === '/upstream' &&
        dispatches[0]?.timeoutMs === 1234,
      `Python worker should be able to dispatch HTTP while handling a listener request: ${JSON.stringify(dispatches)}`
    );
    console.log('PASS: PythonWorkerClient strips listener AbortSignal and supports nested HTTP dispatch');
  } finally {
    if (previousWorker === undefined) {
      delete (globalThis as { Worker?: unknown }).Worker;
    } else {
      (globalThis as { Worker?: unknown }).Worker = previousWorker;
    }
  }
}

await testPythonWorkerHttpRequestsAreSerializableAndReentrant();

#!/usr/bin/env npx tsx

import { CSharpWorkerClient } from '../packages/harness-browser/src/csharp-worker-client';
import type {
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpDispatchOptions,
  RuntimeKernelHttpHandler,
  RuntimeKernelHttpListenOptions,
  RuntimeKernelHttpListenerHandle,
  RuntimeKernelHttpRequest,
  RuntimeKernelHttpResponse,
} from '../packages/harness-core/src/runtime-project';

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }
  throw new Error(message);
}

interface ProtocolEnvelope {
  id?: string;
  type?: string;
  protocolToken?: string;
  payload?: Record<string, unknown>;
}

class CSharpProtocolWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly postedMessages: ProtocolEnvelope[] = [];
  terminated = false;
  projectPayload: Record<string, unknown> | undefined;
  listenerRequest: RuntimeKernelHttpRequest | undefined;
  listenerAbortSeen = false;
  nestedDispatchResultSeen = false;
  abortedDispatchErrorSeen = false;
  private executeMessage: { id: string; protocolToken: string; scriptPath: string } | undefined;
  private listenerRequestId: string | undefined;

  constructor(readonly url: string | URL) {
    queueMicrotask(() => this.emit({ type: 'worker-ready' }));
  }

  postMessage(message: ProtocolEnvelope): void {
    // Reproduce browser structured-clone behavior so function-bearing project
    // payloads fail this regression test instead of being silently accepted.
    structuredClone(message);
    this.postedMessages.push(message);
    const { id, type, protocolToken, payload } = message;
    if (!id || !protocolToken) return;

    if (type === 'init' || type === 'warmup') {
      queueMicrotask(() => this.emit({
        id,
        type,
        protocolToken,
        payload: { success: true, loadTimeMs: 0 },
      }));
      return;
    }

    if (type === 'execute-project-csharp') {
      this.projectPayload = payload;
      this.executeMessage = {
        id,
        protocolToken,
        scriptPath: String(payload?.scriptPath ?? ''),
      };
      queueMicrotask(() => this.emit({
        id,
        type: 'kernel-http-listen',
        protocolToken,
        payload: {
          type: 'kernel-http-listen',
          listenerId: `csharp-listener:${this.executeMessage!.scriptPath}`,
          options: { host: '127.0.0.1', port: 17711 },
        },
      }));
      return;
    }

    if (type === 'kernel-http-listen-result') {
      if (this.executeMessage?.scriptPath === 'timeout.cs') {
        queueMicrotask(() => this.emit({
          id,
          type: 'kernel-http-dispatch',
          protocolToken,
          payload: {
            type: 'kernel-http-dispatch',
            requestId: 'timeout-dispatch',
            request: {
              method: 'GET',
              url: 'http://localhost:17712/never',
              path: '/never',
            },
          },
        }));
      }
      return;
    }

    if (type === 'kernel-http-request') {
      this.listenerRequestId = String(payload?.requestId ?? '');
      this.listenerRequest = payload?.request as RuntimeKernelHttpRequest;
      if (this.executeMessage?.scriptPath === 'terminate.cs') return;
      queueMicrotask(() => this.emit({
        id,
        type: 'kernel-http-dispatch',
        protocolToken,
        payload: {
          type: 'kernel-http-dispatch',
          requestId: 'nested-dispatch',
          request: {
            method: 'GET',
            url: 'http://localhost:17712/upstream',
            path: '/upstream',
            headers: { 'x-runtime': 'csharp' },
          },
          timeoutMs: 1234,
        },
      }));
      return;
    }

    if (type === 'kernel-http-dispatch-result' && payload?.requestId === 'nested-dispatch') {
      this.nestedDispatchResultSeen = true;
      queueMicrotask(() => {
        this.emit({
          id,
          type: 'kernel-http-dispatch',
          protocolToken,
          payload: {
            type: 'kernel-http-dispatch',
            requestId: 'aborted-dispatch',
            request: {
              method: 'GET',
              url: 'http://localhost:17712/abort',
              path: '/abort',
            },
          },
        });
        queueMicrotask(() => this.emit({
          id,
          type: 'kernel-http-abort-dispatch',
          protocolToken,
          payload: { type: 'kernel-http-abort-dispatch', requestId: 'aborted-dispatch' },
        }));
      });
      return;
    }

    if (type === 'kernel-http-error' && payload?.requestId === 'aborted-dispatch') {
      this.abortedDispatchErrorSeen = true;
      return;
    }

    if (type === 'kernel-http-abort-request' && payload?.requestId === this.listenerRequestId) {
      this.listenerAbortSeen = true;
      const execute = this.executeMessage;
      assertCondition(Boolean(execute), 'C# project command should remain active during HTTP listener dispatch');
      queueMicrotask(() => {
        this.emit({
          id,
          type: 'kernel-http-response',
          protocolToken,
          payload: {
            type: 'kernel-http-response',
            requestId: this.listenerRequestId,
            response: {
              status: 209,
              headers: { 'content-type': 'text/plain' },
              body: 'csharp-listener-ok\n',
            },
          },
        });
        this.emit({
          id,
          type: 'kernel-http-close',
          protocolToken,
          payload: {
            type: 'kernel-http-close',
            listenerId: `csharp-listener:${execute!.scriptPath}`,
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

  terminate(): void {
    this.terminated = true;
  }

  private emit(message: ProtocolEnvelope): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }
}

interface BridgeState {
  listenerHandler?: RuntimeKernelHttpHandler;
  listenerCloseCount: number;
  dispatches: Array<{
    request: RuntimeKernelHttpRequest;
    options?: RuntimeKernelHttpDispatchOptions;
  }>;
  abortedDispatchSeen: boolean;
  timeoutDispatchAborted: boolean;
}

function createKernelHttpBridge(state: BridgeState): RuntimeKernelHttpBridge {
  return {
    listen(options: RuntimeKernelHttpListenOptions, handler: RuntimeKernelHttpHandler): RuntimeKernelHttpListenerHandle {
      state.listenerHandler = handler;
      const id = `host-listener:${state.listenerCloseCount}`;
      return {
        id,
        info: {
          id,
          pid: 1,
          host: options.host ?? '127.0.0.1',
          port: options.port,
          protocol: options.protocol ?? 'http',
          startedAt: new Date(0).toISOString(),
        },
        close() {
          state.listenerCloseCount += 1;
        },
      };
    },
    dispatch(request, options): Promise<RuntimeKernelHttpResponse> {
      state.dispatches.push({ request, options });
      if (request.path === '/upstream') {
        return Promise.resolve({ status: 204, headers: { 'x-upstream': 'ok' }, body: '' });
      }
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          if (request.path === '/abort') state.abortedDispatchSeen = true;
          if (request.path === '/never') state.timeoutDispatchAborted = true;
          reject(Object.assign(new Error('dispatch aborted'), { name: 'AbortError' }));
        };
        options?.signal?.addEventListener('abort', onAbort, { once: true });
        if (options?.signal?.aborted) onAbort();
        void resolve;
      });
    },
  };
}

async function testCSharpKernelHttpProtocol(): Promise<void> {
  const state: BridgeState = {
    listenerCloseCount: 0,
    dispatches: [],
    abortedDispatchSeen: false,
    timeoutDispatchAborted: false,
  };
  const client = new CSharpWorkerClient({
    workerUrl: '/workers/csharp-worker.js',
    assetBaseUrl: '/workers/vendor/csharp',
    debug: false,
  });
  const execute = client.executeProjectCSharp({
    source: 'run',
    scriptPath: 'server.cs',
    args: [],
    cwd: '/workspace',
    env: {},
    project: { cwd: '/workspace', files: [{ path: 'server.cs', contents: '' }] },
    kernelHttp: createKernelHttpBridge(state),
  }, 1_000);

  await waitFor(() => Boolean(state.listenerHandler), 'CSharpWorkerClient should register the worker HTTP listener');
  const controller = new AbortController();
  const listenerResponse = state.listenerHandler!({
    method: 'POST',
    url: 'http://localhost:17711/inbound',
    path: '/inbound',
    headers: { 'content-type': 'text/plain' },
    body: 'from-host',
    signal: controller.signal,
  });

  await waitFor(
    () => state.abortedDispatchSeen,
    'CSharpWorkerClient should abort worker-originated dispatches on protocol request'
  );
  controller.abort();
  const [response, result] = await Promise.all([listenerResponse, execute]);
  const worker = workerInstances.at(-1);

  assertCondition(response.status === 209 && response.body === 'csharp-listener-ok\n', 'C# listener response should cross the bridge');
  assertCondition(result.exitCode === 0 && result.stdout === 'done\n', 'C# project command should complete after bridge traffic');
  assertCondition(worker?.projectPayload !== undefined, 'C# worker should receive a project payload');
  assertCondition(!('kernelHttp' in worker.projectPayload), 'C# project payload must omit the function-bearing kernelHttp bridge');
  assertCondition(
    worker.listenerRequest !== undefined && !('signal' in (worker.listenerRequest as Record<string, unknown>)),
    'C# worker-bound HTTP listener requests must omit AbortSignal'
  );
  assertCondition(worker.listenerAbortSeen, 'C# listener request abort should be forwarded to the worker');
  assertCondition(worker.nestedDispatchResultSeen, 'C# worker should receive nested dispatch responses');
  assertCondition(worker.abortedDispatchErrorSeen, 'C# worker should receive an error when it aborts an outbound dispatch');
  assertCondition(
    state.dispatches.some((entry) => entry.request.path === '/upstream' && entry.options?.timeoutMs === 1234),
    'C# outbound dispatch should preserve request and timeout metadata'
  );
  assertCondition(state.listenerCloseCount === 1, 'C# worker close should release the host listener exactly once');
  client.terminate();
  console.log('PASS: CSharpWorkerClient keeps kernelHttp host-side and bridges listen/dispatch/abort/close traffic');
}

async function testCSharpKernelHttpTimeoutCleanup(): Promise<void> {
  const state: BridgeState = {
    listenerCloseCount: 0,
    dispatches: [],
    abortedDispatchSeen: false,
    timeoutDispatchAborted: false,
  };
  const client = new CSharpWorkerClient({
    workerUrl: '/workers/csharp-worker.js',
    assetBaseUrl: '/workers/vendor/csharp',
    debug: false,
  });
  let errorMessage = '';
  try {
    await client.executeProjectCSharp({
      source: 'run',
      scriptPath: 'timeout.cs',
      args: [],
      cwd: '/workspace',
      env: {},
      project: { cwd: '/workspace', files: [{ path: 'timeout.cs', contents: '' }] },
      kernelHttp: createKernelHttpBridge(state),
    }, 25);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  const worker = workerInstances.at(-1);
  assertCondition(errorMessage.includes('C# execution timed out'), `C# project timeout should reject predictably: ${errorMessage}`);
  assertCondition(state.listenerCloseCount === 1, 'C# timeout should close command-scoped HTTP listeners');
  assertCondition(state.timeoutDispatchAborted, 'C# timeout should abort command-scoped outbound HTTP dispatches');
  assertCondition(worker?.terminated === true, 'C# timeout should terminate the stuck worker');
  console.log('PASS: CSharpWorkerClient cleans up HTTP listeners and dispatches on timeout');
}

async function testCSharpKernelHttpTerminationCleanup(): Promise<void> {
  const state: BridgeState = {
    listenerCloseCount: 0,
    dispatches: [],
    abortedDispatchSeen: false,
    timeoutDispatchAborted: false,
  };
  const client = new CSharpWorkerClient({
    workerUrl: '/workers/csharp-worker.js',
    assetBaseUrl: '/workers/vendor/csharp',
    debug: false,
  });
  const execute = client.executeProjectCSharp({
    source: 'run',
    scriptPath: 'terminate.cs',
    args: [],
    cwd: '/workspace',
    env: {},
    project: { cwd: '/workspace', files: [{ path: 'terminate.cs', contents: '' }] },
    kernelHttp: createKernelHttpBridge(state),
  }, 1_000);
  await waitFor(() => Boolean(state.listenerHandler), 'C# termination test should register an HTTP listener');
  const listenerResponse = state.listenerHandler!({
    method: 'GET',
    url: 'http://localhost:17711/pending',
    path: '/pending',
  });
  const worker = workerInstances.at(-1);
  await waitFor(() => Boolean(worker?.listenerRequest), 'C# termination test should leave a listener response pending');
  client.terminate();

  let executionError = '';
  let listenerError = '';
  try {
    await execute;
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
  }
  try {
    await listenerResponse;
  } catch (error) {
    listenerError = error instanceof Error ? error.message : String(error);
  }

  assertCondition(executionError.includes('Worker was terminated'), `C# termination should reject project execution: ${executionError}`);
  assertCondition(
    listenerError.includes('C# worker finished before HTTP response'),
    `C# termination should reject pending listener responses: ${listenerError}`
  );
  assertCondition(state.listenerCloseCount === 1, 'C# termination should close command-scoped HTTP listeners');
  assertCondition(worker?.terminated === true, 'C# explicit termination should terminate the worker');
  console.log('PASS: CSharpWorkerClient rejects pending HTTP responses and closes listeners on termination');
}

const previousWorker = (globalThis as typeof globalThis & { Worker?: unknown }).Worker;
const workerInstances: CSharpProtocolWorker[] = [];
(globalThis as typeof globalThis & { Worker?: unknown }).Worker = class extends CSharpProtocolWorker {
  constructor(url: string | URL) {
    super(url);
    workerInstances.push(this);
  }
};

try {
  await testCSharpKernelHttpProtocol();
  await testCSharpKernelHttpTimeoutCleanup();
  await testCSharpKernelHttpTerminationCleanup();
} finally {
  if (previousWorker === undefined) {
    delete (globalThis as typeof globalThis & { Worker?: unknown }).Worker;
  } else {
    (globalThis as typeof globalThis & { Worker?: unknown }).Worker = previousWorker;
  }
}

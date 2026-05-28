import type {
  RuntimeCommandEvent,
  RuntimeCommandResult,
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpHandler,
  RuntimeKernelHttpListenOptions,
  RuntimeKernelHttpListenerHandle,
  RuntimeKernelHttpListenerInfo,
  RuntimeKernelHttpProtocolMessage,
  RuntimeKernelHttpRequest,
  RuntimeKernelHttpResponse,
} from '../../harness-core/src/runtime-project';
import {
  runBrowserJavaScriptProjectRequest,
  type BrowserJavaScriptProjectRunnerOptions,
  type JavaScriptProjectCommandRequest,
} from './project-browser';

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
}

const workerScope = self as typeof self & {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  postMessage(message: unknown): void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class WorkerKernelHttpBridge implements RuntimeKernelHttpBridge {
  private nextListenerId = 1;
  private nextRequestId = 1;
  private readonly listeners = new Map<string, RuntimeKernelHttpHandler>();
  private readonly listenerInfo = new Map<string, RuntimeKernelHttpListenerInfo>();
  private readonly dispatchRequests = new Map<string, { resolve: (response: RuntimeKernelHttpResponse) => void; reject: (error: Error) => void }>();

  constructor(
    private readonly postProtocolMessage: (message: RuntimeKernelHttpProtocolMessage) => void
  ) {}

  listen(options: RuntimeKernelHttpListenOptions, handler: RuntimeKernelHttpHandler): RuntimeKernelHttpListenerHandle {
    const listenerId = `worker-http-${this.nextListenerId++}`;
    const optimisticInfo: RuntimeKernelHttpListenerInfo = {
      id: listenerId,
      pid: 0,
      host: options.host ?? '127.0.0.1',
      port: options.port,
      protocol: options.protocol ?? 'http',
      startedAt: new Date().toISOString(),
    };
    this.listeners.set(listenerId, handler);
    this.listenerInfo.set(listenerId, optimisticInfo);
    this.postProtocolMessage({
      type: 'kernel-http-listen',
      listenerId,
      options,
    });
    let closed = false;
    const listenerInfo = this.listenerInfo;
    return {
      id: listenerId,
      get info() {
        return listenerInfo.get(listenerId) ?? optimisticInfo;
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.listeners.delete(listenerId);
        this.listenerInfo.delete(listenerId);
        this.postProtocolMessage({ type: 'kernel-http-close', listenerId });
      },
    } as RuntimeKernelHttpListenerHandle;
  }

  dispatch(request: RuntimeKernelHttpRequest): Promise<RuntimeKernelHttpResponse> {
    const requestId = `worker-dispatch-${this.nextRequestId++}`;
    return new Promise<RuntimeKernelHttpResponse>((resolve, reject) => {
      this.dispatchRequests.set(requestId, { resolve, reject });
      this.postProtocolMessage({
        type: 'kernel-http-dispatch',
        requestId,
        request,
      });
    });
  }

  resolveDispatch(requestId: string, response: RuntimeKernelHttpResponse): void {
    const request = this.dispatchRequests.get(requestId);
    this.dispatchRequests.delete(requestId);
    request?.resolve(response);
  }

  rejectDispatch(requestId: string, error: string): void {
    const request = this.dispatchRequests.get(requestId);
    this.dispatchRequests.delete(requestId);
    request?.reject(new Error(error));
  }

  updateListenerInfo(listenerId: string, info: RuntimeKernelHttpListenerInfo): void {
    this.listenerInfo.set(listenerId, info);
  }

  failListener(listenerId: string): void {
    this.listeners.delete(listenerId);
    this.listenerInfo.delete(listenerId);
  }

  async handleRequest(listenerId: string, requestId: string, request: RuntimeKernelHttpRequest): Promise<void> {
    const handler = this.listeners.get(listenerId);
    if (!handler) {
      this.postProtocolMessage({
        type: 'kernel-http-error',
        requestId,
        listenerId,
        error: `TraceKernel HTTP listener not found: ${listenerId}`,
      });
      return;
    }
    try {
      const response = await handler(request);
      this.postProtocolMessage({
        type: 'kernel-http-response',
        requestId,
        response,
      });
    } catch (error) {
      this.postProtocolMessage({
        type: 'kernel-http-error',
        requestId,
        listenerId,
        error: errorMessage(error),
      });
    }
  }
}

const activeHttpBridges = new Map<string, WorkerKernelHttpBridge>();

workerScope.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const { id, type, payload } = event.data;
  if (!id) return;

  if (type === 'kernel-http-request') {
    const message = payload as RuntimeKernelHttpProtocolMessage;
    if (message.type === 'kernel-http-request') {
      void activeHttpBridges.get(id)?.handleRequest(message.listenerId, message.requestId, message.request);
    }
    return;
  }

  if (type === 'kernel-http-listen-result') {
    const message = payload as RuntimeKernelHttpProtocolMessage;
    if (message.type === 'kernel-http-listen-result') {
      activeHttpBridges.get(id)?.updateListenerInfo(message.listenerId, message.info);
    }
    return;
  }

  if (type === 'kernel-http-dispatch-result') {
    const message = payload as RuntimeKernelHttpProtocolMessage;
    if (message.type === 'kernel-http-dispatch-result') {
      activeHttpBridges.get(id)?.resolveDispatch(message.requestId, message.response);
    }
    return;
  }

  if (type === 'kernel-http-error') {
    const message = payload as RuntimeKernelHttpProtocolMessage;
    if (message.type === 'kernel-http-error' && message.requestId) {
      activeHttpBridges.get(id)?.rejectDispatch(message.requestId, message.error);
    } else if (message.type === 'kernel-http-error' && message.listenerId) {
      activeHttpBridges.get(id)?.failListener(message.listenerId);
    }
    return;
  }

  if (type !== 'execute-project-javascript') {
    workerScope.postMessage({ id, type: 'error', payload: { error: `Unsupported JavaScript project worker message: ${type}` } });
    return;
  }

  const request = payload as JavaScriptProjectCommandRequest;
  const options: BrowserJavaScriptProjectRunnerOptions = {};
  const executionState = { cancelled: false };
  const kernelHttp = new WorkerKernelHttpBridge((message) => {
    workerScope.postMessage({ id, type: message.type, payload: message });
  });
  activeHttpBridges.set(id, kernelHttp);

  runBrowserJavaScriptProjectRequest(
    {
      ...request,
      kernelHttp,
      onEvent: (runtimeEvent: RuntimeCommandEvent) => {
        if (
          runtimeEvent.type === 'status' &&
          (runtimeEvent.phase === 'process-start' || runtimeEvent.phase === 'process-exit')
        ) {
          return;
        }
        workerScope.postMessage({ id, type: 'project-event', payload: runtimeEvent });
      },
    },
    options,
    executionState
  ).then(
    (result: RuntimeCommandResult) => {
      activeHttpBridges.delete(id);
      workerScope.postMessage({ id, type: 'execute-result', payload: result });
    },
    (error) => {
      activeHttpBridges.delete(id);
      workerScope.postMessage({ id, type: 'error', payload: { error: errorMessage(error) } });
    }
  );
};

workerScope.postMessage({ type: 'worker-ready' });

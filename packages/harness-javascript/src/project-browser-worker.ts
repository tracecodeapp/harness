import type {
  RuntimeCommandEvent,
  RuntimeCommandResult,
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpDispatchOptions,
  RuntimeKernelHttpHandler,
  RuntimeKernelHttpListenOptions,
  RuntimeKernelHttpListenerHandle,
  RuntimeKernelHttpListenerInfo,
  RuntimeKernelHttpProtocolMessage,
  RuntimeKernelHttpRequest,
  RuntimeKernelHttpResponse,
  RuntimeKernelSyscallBridge,
} from '@tracecode/harness-core';
import {
  TraceKernelRuntimeFileClient,
  TraceKernelSharedGenerationSource,
  TraceKernelSharedSyscallClient,
  type TraceKernelSyscallRequest,
  type TraceKernelSyscallResult,
} from '@tracecode/tracekernel';
import {
  runBrowserJavaScriptProjectRequest,
  type BrowserTraceKernelFileSystem,
  type BrowserJavaScriptProjectRunnerOptions,
  type BrowserJavaScriptProjectExecutionState,
  type JavaScriptProjectCommandRequest,
} from './project-browser';

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
  protocolToken?: string;
  runnerOptions?: Pick<
    BrowserJavaScriptProjectRunnerOptions,
    'allowDynamicEval' | 'projectUserAuthorityMode'
  >;
  kernelSyscallChannel?: RuntimeKernelSyscallBridge['channel'];
  kernelSyscallGenerationBuffer?: SharedArrayBuffer;
  port?: MessagePort;
}

const workerScope = self as typeof self & {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  postMessage(message: unknown): void;
};
const postWorkerMessage = workerScope.postMessage.bind(workerScope);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class WorkerKernelHttpBridge implements RuntimeKernelHttpBridge {
  private nextListenerId = 1;
  private nextRequestId = 1;
  private readonly listeners = new Map<string, RuntimeKernelHttpHandler>();
  private readonly listenerInfo = new Map<string, RuntimeKernelHttpListenerInfo>();
  private readonly listenerRegistrations = new Map<string, {
    resolve: (info: RuntimeKernelHttpListenerInfo) => void;
    reject: (error: Error) => void;
  }>();
  private readonly dispatchRequests = new Map<string, {
    resolve: (response: RuntimeKernelHttpResponse) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  }>();
  private readonly serverRequestAbortControllers = new Map<string, AbortController>();

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
    let resolveRegistration!: (info: RuntimeKernelHttpListenerInfo) => void;
    let rejectRegistration!: (error: Error) => void;
    const ready = new Promise<RuntimeKernelHttpListenerInfo>((resolve, reject) => {
      resolveRegistration = resolve;
      rejectRegistration = reject;
    });
    this.listenerRegistrations.set(listenerId, {
      resolve: resolveRegistration,
      reject: rejectRegistration,
    });
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
      ready,
      close: () => {
        if (closed) return;
        closed = true;
        this.listeners.delete(listenerId);
        this.listenerInfo.delete(listenerId);
        this.listenerRegistrations.delete(listenerId);
        this.postProtocolMessage({ type: 'kernel-http-close', listenerId });
      },
    };
  }

  dispatch(request: RuntimeKernelHttpRequest, options: RuntimeKernelHttpDispatchOptions = {}): Promise<RuntimeKernelHttpResponse> {
    const requestId = `worker-dispatch-${this.nextRequestId++}`;
    return new Promise<RuntimeKernelHttpResponse>((resolve, reject) => {
      let abortListener: (() => void) | undefined;
      const cleanup = (): void => {
        if (abortListener) options.signal?.removeEventListener?.('abort', abortListener);
      };
      this.dispatchRequests.set(requestId, { resolve, reject, cleanup });
      if (options.signal) {
        abortListener = () => {
          this.postProtocolMessage({
            type: 'kernel-http-abort-dispatch',
            requestId,
          });
        };
        options.signal.addEventListener?.('abort', abortListener, { once: true });
        if (options.signal.aborted) abortListener();
      }
      this.postProtocolMessage({
        type: 'kernel-http-dispatch',
        requestId,
        request,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
    });
  }

  resolveDispatch(requestId: string, response: RuntimeKernelHttpResponse): void {
    const request = this.dispatchRequests.get(requestId);
    this.dispatchRequests.delete(requestId);
    request?.cleanup();
    request?.resolve(response);
  }

  rejectDispatch(requestId: string, error: string): void {
    const request = this.dispatchRequests.get(requestId);
    this.dispatchRequests.delete(requestId);
    request?.cleanup();
    request?.reject(new Error(error));
  }

  updateListenerInfo(listenerId: string, info: RuntimeKernelHttpListenerInfo): void {
    this.listenerInfo.set(listenerId, info);
    this.listenerRegistrations.get(listenerId)?.resolve(info);
    this.listenerRegistrations.delete(listenerId);
  }

  failListener(listenerId: string, message: string): void {
    this.listeners.delete(listenerId);
    this.listenerInfo.delete(listenerId);
    const error = new Error(message);
    const code = /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1];
    if (code) Object.assign(error, { code });
    this.listenerRegistrations.get(listenerId)?.reject(error);
    this.listenerRegistrations.delete(listenerId);
  }

  abortRequest(requestId: string): void {
    this.serverRequestAbortControllers.get(requestId)?.abort();
  }

  async handleRequest(listenerId: string, requestId: string, request: RuntimeKernelHttpRequest): Promise<void> {
    const handler = this.listeners.get(listenerId);
    if (!handler) {
      this.postProtocolMessage({
        type: 'kernel-http-error',
        requestId,
        listenerId,
        error: `Network listener not found: ${listenerId}`,
      });
      return;
    }
    const abortController = new AbortController();
    this.serverRequestAbortControllers.set(requestId, abortController);
    try {
      const response = await handler({
        ...request,
        signal: abortController.signal,
      });
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
    } finally {
      this.serverRequestAbortControllers.delete(requestId);
    }
  }
}

interface ActiveWorkerCommand {
  bridge: WorkerKernelHttpBridge;
  protocolToken: string;
  executionState: BrowserJavaScriptProjectExecutionState;
  syscallClient?: TraceKernelSharedSyscallClient;
  asyncSyscallClient?: WorkerKernelAsyncSyscallClient;
}

const activeHttpBridges = new Map<string, ActiveWorkerCommand>();

class WorkerKernelAsyncSyscallClient {
  private nextRequestId = 1;
  private closed = false;
  private readonly pending = new Map<string, {
    resolve: (result: TraceKernelSyscallResult) => void;
  }>();

  constructor(
    private readonly postProtocolMessage: (
      requestId: string,
      request: TraceKernelSyscallRequest
    ) => void
  ) {}

  private closedResult(): TraceKernelSyscallResult {
    return {
      ok: false,
      error: {
        code: 'EIO',
        message: 'ECLOSED: async syscall client is closed',
      },
    };
  }

  dispatch(request: TraceKernelSyscallRequest): Promise<TraceKernelSyscallResult> {
    if (this.closed) {
      return Promise.resolve(this.closedResult());
    }
    const requestId = `async-syscall-${this.nextRequestId++}`;
    return new Promise<TraceKernelSyscallResult>((resolve) => {
      this.pending.set(requestId, { resolve });
      this.postProtocolMessage(requestId, request);
    });
  }

  resolve(requestId: string, result: TraceKernelSyscallResult): void {
    const pending = this.pending.get(requestId);
    this.pending.delete(requestId);
    pending?.resolve(result);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const result = this.closedResult();
    for (const pending of this.pending.values()) pending.resolve(result);
    this.pending.clear();
  }
}

function postCommandMessage(
  postMessage: (message: WorkerMessage) => void,
  id: string,
  protocolToken: string,
  type: string,
  payload: unknown
): void {
  postMessage({ id, type, payload, protocolToken });
}

function handleKernelHttpHostMessage(message: WorkerMessage): boolean {
  const { id, type, payload, protocolToken } = message;
  if (!id) return false;
  const command = activeHttpBridges.get(id);
  if (!command) return false;
  if (protocolToken !== command.protocolToken) return true;

  if (type === 'runtime-signal') {
    const signal = typeof (payload as { signal?: unknown } | undefined)?.signal === 'string'
      ? (payload as { signal: string }).signal
      : 'SIGTERM';
    const handled = command.executionState.dispatchSignal?.(signal) === true;
    if (!handled) {
      command.executionState.cancelled = true;
      command.executionState.abortController.abort({ signal });
      command.executionState.cleanupHostGlobals?.();
    }
    return true;
  }

  if (type === 'kernel-syscall-async-result') {
    const result = payload as {
      requestId?: unknown;
      result?: unknown;
    };
    if (typeof result.requestId === 'string') {
      command.asyncSyscallClient?.resolve(
        result.requestId,
        result.result as TraceKernelSyscallResult
      );
    }
    return true;
  }

  if (type === 'kernel-http-request') {
    const message = payload as RuntimeKernelHttpProtocolMessage;
    if (message.type === 'kernel-http-request') {
      void command.bridge.handleRequest(message.listenerId, message.requestId, message.request);
    }
    return true;
  }

  if (type === 'kernel-http-abort-request') {
    const message = payload as RuntimeKernelHttpProtocolMessage;
    if (message.type === 'kernel-http-abort-request') {
      command.bridge.abortRequest(message.requestId);
    }
    return true;
  }

  if (type === 'kernel-http-listen-result') {
    const message = payload as RuntimeKernelHttpProtocolMessage;
    if (message.type === 'kernel-http-listen-result') {
      command.bridge.updateListenerInfo(message.listenerId, message.info);
    }
    return true;
  }

  if (type === 'kernel-http-dispatch-result') {
    const message = payload as RuntimeKernelHttpProtocolMessage;
    if (message.type === 'kernel-http-dispatch-result') {
      command.bridge.resolveDispatch(message.requestId, message.response);
    }
    return true;
  }

  if (type === 'kernel-http-error') {
    const message = payload as RuntimeKernelHttpProtocolMessage;
    if (message.type === 'kernel-http-error' && message.requestId) {
      command.bridge.rejectDispatch(message.requestId, message.error);
    } else if (message.type === 'kernel-http-error' && message.listenerId) {
      command.bridge.failListener(message.listenerId, message.error);
    }
    return true;
  }

  return false;
}

workerScope.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const {
    id,
    type,
    payload,
    protocolToken,
    runnerOptions,
    kernelSyscallChannel,
    kernelSyscallGenerationBuffer,
    port,
  } = event.data;
  if (!id) return;

  if (handleKernelHttpHostMessage(event.data)) return;

  if (type !== 'execute-project-javascript') {
    postWorkerMessage({ id, type: 'error', payload: { error: `Unsupported JavaScript project worker message: ${type}` } });
    return;
  }

  if (typeof protocolToken !== 'string' || protocolToken.length === 0) {
    postWorkerMessage({ id, type: 'error', payload: { error: 'Missing JavaScript project worker protocol token.' } });
    return;
  }

  const commandPort = port ?? null;
  const postToHost = commandPort ? commandPort.postMessage.bind(commandPort) : postWorkerMessage;
  commandPort?.start?.();
  if (commandPort) {
    commandPort.onmessage = (messageEvent: MessageEvent<WorkerMessage>) => {
      handleKernelHttpHostMessage(messageEvent.data);
    };
  }

  const request = payload as JavaScriptProjectCommandRequest;
  const options: BrowserJavaScriptProjectRunnerOptions = {
    allowDynamicEval: runnerOptions?.allowDynamicEval,
    projectUserAuthorityMode: runnerOptions?.projectUserAuthorityMode,
  };
  const executionState: BrowserJavaScriptProjectExecutionState = {
    cancelled: false,
    abortController: new AbortController(),
  };
  let syscallClient: TraceKernelSharedSyscallClient | undefined;
  let asyncSyscallClient: WorkerKernelAsyncSyscallClient | undefined;
  if (kernelSyscallChannel) {
    syscallClient = new TraceKernelSharedSyscallClient(
      kernelSyscallChannel,
      () => postCommandMessage(
        postToHost,
        id,
        protocolToken,
        'kernel-syscall',
        {}
      )
    );
    executionState.kernelFileSystem = new TraceKernelRuntimeFileClient(
      syscallClient,
      {
        ...(kernelSyscallGenerationBuffer
          ? {
              generation: new TraceKernelSharedGenerationSource(
                kernelSyscallGenerationBuffer
              ),
            }
          : {}),
      }
    ) satisfies BrowserTraceKernelFileSystem;
    executionState.kernelSyscalls = syscallClient;
    asyncSyscallClient = new WorkerKernelAsyncSyscallClient(
      (requestId, request) => postCommandMessage(
        postToHost,
        id,
        protocolToken,
        'kernel-syscall-async',
        { requestId, request }
      )
    );
    executionState.kernelNetwork = asyncSyscallClient;
  }
  const kernelHttp = new WorkerKernelHttpBridge((message) => {
    postCommandMessage(postToHost, id, protocolToken, message.type, message);
  });
  activeHttpBridges.set(id, {
    bridge: kernelHttp,
    protocolToken,
    executionState,
    ...(syscallClient ? { syscallClient } : {}),
    ...(asyncSyscallClient ? { asyncSyscallClient } : {}),
  });
  const clearActiveCommand = (): void => {
    activeHttpBridges.get(id)?.syscallClient?.close();
    activeHttpBridges.get(id)?.asyncSyscallClient?.close();
    activeHttpBridges.delete(id);
  };

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
        postCommandMessage(postToHost, id, protocolToken, 'project-event', runtimeEvent);
      },
    },
    options,
    executionState
  ).then(
    (result: RuntimeCommandResult) => {
      clearActiveCommand();
      postCommandMessage(postToHost, id, protocolToken, 'execute-result', result);
      commandPort?.close();
    },
    (error) => {
      clearActiveCommand();
      postCommandMessage(postToHost, id, protocolToken, 'error', { error: errorMessage(error) });
      commandPort?.close();
    }
  );
};

postWorkerMessage({ type: 'worker-ready' });

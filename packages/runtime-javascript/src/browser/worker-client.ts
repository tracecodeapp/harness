import type {
  RuntimeCommandEvent,
  RuntimeCommandResult,
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpListenerHandle,
  RuntimeKernelHttpProtocolMessage,
  RuntimeKernelHttpRequest,
  RuntimeKernelHttpResponse,
  RuntimeKernelSignalBridge,
  RuntimeKernelSyscallBridge,
  RuntimeProjectEngineLeaseController,
} from "@tracecode/runtime-core";

import {
  createRuntimeProjectIoBridge,
  runtimeAbortSignalName,
} from "@tracecode/runtime-core";

import {
  DEFAULT_SIGNAL_GRACE_MS,
} from "./constants";

import {
  BrowserJavaScriptProjectRunnerOptions,
  BrowserJavaScriptProjectWorkerFactory,
  BrowserJavaScriptProjectWorkerLike,
  JavaScriptProjectCommandRequest,
  JavaScriptProjectCommandRunner,
} from "./contracts";

import {
  serializableKernelHttpRequest,
} from "../modules/resolution";

export function requireModulesForRequest(request: JavaScriptProjectCommandRequest): string[] {
  return Array.isArray(request.options?.require)
    ? request.options.require.filter((item): item is string => typeof item === 'string')
    : [];
}

export interface BrowserJavaScriptProjectWorkerMessage {
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
}

export interface BrowserJavaScriptProjectPendingMessage {
  protocolToken: string;
  resolve: (value: RuntimeCommandResult) => void;
  reject: (error: Error) => void;
  onEvent?: (event: RuntimeCommandEvent) => void;
  kernelHttp?: RuntimeKernelHttpBridge;
  kernelSyscalls?: RuntimeKernelSyscallBridge;
  httpListeners: Map<string, RuntimeKernelHttpListenerHandle>;
  httpRequests: Map<string, { resolve: (response: RuntimeKernelHttpResponse) => void; reject: (error: Error) => void }>;
  httpDispatchAbortControllers: Map<string, AbortController>;
  abortCleanup?: () => void;
  kernelSignalCleanup?: () => void;
  signalGraceTimeoutId?: ReturnType<typeof setTimeout>;
}

export function createBrowserJavaScriptProjectAbortError(): Error {
  return Object.assign(new Error('Execution aborted'), { name: 'AbortError' });
}

export function createBrowserJavaScriptProjectProtocolToken(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function createBrowserJavaScriptProjectPolicyFailureRunner(diagnostic: string): JavaScriptProjectCommandRunner {
  return withDescriptorStdioCapability((request) => {
    const stderr = 'node: JavaScript runtime is unavailable\n';
    const io = createRuntimeProjectIoBridge(request.onEvent);
    io.output('stderr', stderr);
    io.status('process-exit', 'Browser Node exited', { command: 'node', exitCode: 126, diagnostic });
    return Promise.resolve({
      stdout: '',
      stderr,
      exitCode: 126,
      error: {
        code: 'ENOEXEC',
        errno: 8,
        message: 'JavaScript runtime is unavailable',
        detail: { diagnostic },
      },
    });
  }, false);
}

export function withDescriptorStdioCapability<
  Runner extends JavaScriptProjectCommandRunner,
>(runner: Runner, descriptorStdio: boolean): Runner {
  return Object.assign(runner, {
    capabilities: Object.freeze({
      ...runner.capabilities,
      descriptorStdio,
    }),
  });
}

export class BrowserJavaScriptProjectWorkerClient {
  private readonly hostSetTimeout = globalThis.setTimeout.bind(globalThis);
  private readonly hostClearTimeout = globalThis.clearTimeout.bind(globalThis);
  private worker: BrowserJavaScriptProjectWorkerLike | null = null;
  private workerReadyPromise: Promise<void> | null = null;
  private workerReadyResolve: (() => void) | null = null;
  private workerReadyReject: ((error: Error) => void) | null = null;
  private messageId = 0;
  private httpRequestId = 0;
  private readonly pendingMessages = new Map<string, BrowserJavaScriptProjectPendingMessage>();
  private engineLeaseTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly workerUrl: string,
    private readonly runnerOptions: Pick<
      BrowserJavaScriptProjectRunnerOptions,
      'allowDynamicEval' | 'projectUserAuthorityMode'
    > = {},
    private readonly workerFactory?: BrowserJavaScriptProjectWorkerFactory
  ) {}

  executeProject(
    request: JavaScriptProjectCommandRequest,
    timeoutMs: number,
    onEvent?: (event: RuntimeCommandEvent) => void
  ): Promise<RuntimeCommandResult> {
    const signal = request.signal;
    if (signal?.aborted) {
      const abortError = createBrowserJavaScriptProjectAbortError();
      this.terminateAndReset(abortError);
      return Promise.reject(abortError);
    }
    const {
      signal: _signal,
      onEvent: _requestOnEvent,
      engineLease: _engineLease,
      kernelHttp,
      kernelSyscalls,
      kernelSignals,
      ...workerRequest
    } = request;
    return this.executeWithTimeout(
      () => this.sendMessage(
        'execute-project-javascript',
        workerRequest,
        onEvent,
        kernelHttp,
        kernelSyscalls,
        kernelSignals,
        signal
      ),
      timeoutMs
    );
  }

  warmup(): Promise<void> {
    this.getWorker();
    return this.workerReadyPromise ?? Promise.resolve();
  }

  async acquireReusableEngineLease(controller: RuntimeProjectEngineLeaseController): Promise<void> {
    const predecessor = this.engineLeaseTail;
    let releaseTurn!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    this.engineLeaseTail = predecessor
      .catch(() => undefined)
      .then(() => releaseGate);
    await predecessor.catch(() => undefined);

    let validatedWorker: BrowserJavaScriptProjectWorkerLike | null = null;
    try {
      controller.attach({
        revalidate: async () => {
          const worker = this.worker;
          if (!worker) throw new Error('JavaScript worker is not running after execution.');
          if (this.pendingMessages.size !== 0) {
            throw new Error(
              `JavaScript worker still owns ${this.pendingMessages.size} pending request(s).`
            );
          }
          if (!this.workerReadyPromise) {
            throw new Error('JavaScript worker has no readiness promise.');
          }
          await this.workerReadyPromise;
          if (this.worker !== worker) {
            throw new Error('JavaScript worker generation changed during revalidation.');
          }
          validatedWorker = worker;
        },
        release: (disposition) => {
          try {
            if (disposition.kind === 'reuse') return;
            if (validatedWorker && this.worker !== validatedWorker) return;
            this.terminateAndReset(
              new Error(`JavaScript engine lease destroyed: ${disposition.reason}`)
            );
          } finally {
            releaseTurn();
          }
        },
      });
    } catch (error) {
      releaseTurn();
      throw error;
    }
  }

  terminate(): void {
    this.terminateAndReset();
  }

  private getWorker(): BrowserJavaScriptProjectWorkerLike {
    if (this.worker) return this.worker;
    this.workerReadyPromise = new Promise<void>((resolve, reject) => {
      this.workerReadyResolve = resolve;
      this.workerReadyReject = reject;
    });
    this.worker = this.workerFactory
      ? this.workerFactory(this.workerUrl, { type: 'module' })
      : new Worker(this.workerUrl, { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<BrowserJavaScriptProjectWorkerMessage>) => {
      if (event.data.type === 'worker-ready') {
        this.workerReadyResolve?.();
        this.workerReadyResolve = null;
        this.workerReadyReject = null;
        return;
      }
      this.handleWorkerMessage(event.data);
    };
    this.worker.onerror = (event) => {
      this.terminateAndReset(new Error(event.message || 'JavaScript project worker error'));
    };
    return this.worker;
  }

  private handleWorkerMessage(message: BrowserJavaScriptProjectWorkerMessage): void {
    const { id, type, payload, protocolToken } = message;
    if (!id) return;
    const pending = this.pendingMessages.get(id);
    if (!pending || protocolToken !== pending.protocolToken) return;
    if (type === 'project-event') {
      pending.onEvent?.(payload as RuntimeCommandEvent);
      return;
    }
    if (type === 'kernel-syscall') {
      if (!pending.kernelSyscalls) return;
      void pending.kernelSyscalls.service().catch(() => {
        pending.kernelSyscalls?.close();
      });
      return;
    }
    if (type === 'kernel-syscall-async') {
      const request = payload as {
        requestId?: unknown;
        request?: unknown;
      };
      if (typeof request.requestId !== 'string') return;
      if (!pending.kernelSyscalls) {
        this.postWorkerMessage(id, 'kernel-syscall-async-result', {
          requestId: request.requestId,
          result: {
            ok: false,
            error: {
              code: 'ENOSYS',
              message: 'ENOSYS: network subsystem is unavailable',
            },
          },
        });
        return;
      }
      void pending.kernelSyscalls.dispatch(request.request).then(
        (result) => this.postWorkerMessage(id, 'kernel-syscall-async-result', {
          requestId: request.requestId,
          result,
        }),
        (error) => this.postWorkerMessage(id, 'kernel-syscall-async-result', {
          requestId: request.requestId,
          result: {
            ok: false,
            error: {
              code: 'EIO',
              message: error instanceof Error ? error.message : String(error),
            },
          },
        })
      );
      return;
    }
    if (
      type === 'kernel-http-listen' ||
      type === 'kernel-http-close' ||
      type === 'kernel-http-response' ||
      type === 'kernel-http-dispatch' ||
      type === 'kernel-http-abort-dispatch' ||
      type === 'kernel-http-error'
    ) {
      this.handleKernelHttpProtocolMessage(id, type, payload);
      return;
    }
    this.pendingMessages.delete(id);
    this.cleanupPendingKernelHttp(pending);
    if (type === 'error') {
      const errorMessage = payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error?: unknown }).error ?? 'JavaScript project worker failed')
        : 'JavaScript project worker failed';
      pending.reject(new Error(errorMessage));
      return;
    }
    pending.resolve(payload as RuntimeCommandResult);
  }

  private sendMessage(
    type: string,
    payload: unknown,
    onEvent?: (event: RuntimeCommandEvent) => void,
    kernelHttp?: RuntimeKernelHttpBridge,
    kernelSyscalls?: RuntimeKernelSyscallBridge,
    kernelSignals?: RuntimeKernelSignalBridge,
    signal?: AbortSignal
  ): Promise<RuntimeCommandResult> {
    const worker = this.getWorker();
    const id = String(++this.messageId);
    const protocolToken = createBrowserJavaScriptProjectProtocolToken();
    return new Promise<RuntimeCommandResult>((resolve, reject) => {
      const pending: BrowserJavaScriptProjectPendingMessage = {
        protocolToken,
        resolve,
        reject,
        ...(onEvent ? { onEvent } : {}),
        ...(kernelHttp ? { kernelHttp } : {}),
        ...(kernelSyscalls ? { kernelSyscalls } : {}),
        httpListeners: new Map(),
        httpRequests: new Map(),
        httpDispatchAbortControllers: new Map(),
      };
      this.pendingMessages.set(id, pending);
      const message: BrowserJavaScriptProjectWorkerMessage = {
        id,
        type,
        payload,
        protocolToken,
        runnerOptions: this.runnerOptions,
        ...(kernelSyscalls
          ? {
              kernelSyscallChannel: kernelSyscalls.channel,
              ...(kernelSyscalls.generationBuffer
                ? { kernelSyscallGenerationBuffer: kernelSyscalls.generationBuffer }
                : {}),
            }
          : {}),
      };
      worker.postMessage(message);
      if (kernelSignals) {
        pending.kernelSignalCleanup = kernelSignals.subscribe(
          ({ signal: runtimeSignal }) => {
            if (!this.pendingMessages.has(id)) return;
            this.postWorkerMessage(id, 'runtime-signal', {
              signal: runtimeSignal,
            });
          }
        );
      }
      if (signal) {
        const onAbort = (): void => {
          if (!this.pendingMessages.has(id)) return;
          this.postWorkerMessage(id, 'runtime-signal', { signal: runtimeAbortSignalName(signal) });
          pending.signalGraceTimeoutId = this.hostSetTimeout(() => {
            if (!this.pendingMessages.has(id)) return;
            this.terminateAndReset(createBrowserJavaScriptProjectAbortError());
          }, DEFAULT_SIGNAL_GRACE_MS);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        pending.abortCleanup = () => signal.removeEventListener('abort', onAbort);
        if (signal.aborted) onAbort();
      }
    });
  }

  private handleKernelHttpProtocolMessage(commandId: string, type: string, payload: unknown): void {
    const pending = this.pendingMessages.get(commandId);
    if (!pending) return;
    const message = payload as RuntimeKernelHttpProtocolMessage;
    if (type === 'kernel-http-listen' && message.type === 'kernel-http-listen') {
      if (!pending.kernelHttp) {
        this.postKernelHttpError(commandId, { listenerId: message.listenerId, error: 'Network subsystem is unavailable.' });
        return;
      }
      try {
        const handle = pending.kernelHttp.listen(message.options, (request) => this.dispatchWorkerKernelHttpRequest(commandId, message.listenerId, request));
        pending.httpListeners.set(message.listenerId, handle);
        const publishReady = (info = handle.info): void => {
          if (
            !this.pendingMessages.has(commandId) ||
            pending.httpListeners.get(message.listenerId) !== handle
          ) {
            return;
          }
          this.postWorkerMessage(commandId, 'kernel-http-listen-result', {
            type: 'kernel-http-listen-result',
            listenerId: message.listenerId,
            info,
          } satisfies RuntimeKernelHttpProtocolMessage);
        };
        if (handle.ready) {
          void handle.ready.then(publishReady, (error) => {
            if (pending.httpListeners.get(message.listenerId) === handle) {
              pending.httpListeners.delete(message.listenerId);
            }
            handle.close();
            this.postKernelHttpError(commandId, {
              listenerId: message.listenerId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        } else {
          publishReady();
        }
      } catch (error) {
        this.postKernelHttpError(commandId, {
          listenerId: message.listenerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (type === 'kernel-http-close' && message.type === 'kernel-http-close') {
      pending.httpListeners.get(message.listenerId)?.close();
      pending.httpListeners.delete(message.listenerId);
      return;
    }
    if (type === 'kernel-http-response' && message.type === 'kernel-http-response') {
      const request = pending.httpRequests.get(message.requestId);
      pending.httpRequests.delete(message.requestId);
      request?.resolve(message.response);
      return;
    }
    if (type === 'kernel-http-dispatch' && message.type === 'kernel-http-dispatch') {
      if (!pending.kernelHttp) {
        this.postKernelHttpError(commandId, { requestId: message.requestId, error: 'Network subsystem is unavailable.' });
        return;
      }
      const abortController = new AbortController();
      pending.httpDispatchAbortControllers.set(message.requestId, abortController);
      pending.kernelHttp.dispatch(message.request, {
        signal: abortController.signal,
        ...(message.timeoutMs !== undefined ? { timeoutMs: message.timeoutMs } : {}),
      }).then((response) => {
        pending.httpDispatchAbortControllers.delete(message.requestId);
        this.postWorkerMessage(commandId, 'kernel-http-dispatch-result', {
          type: 'kernel-http-dispatch-result',
          requestId: message.requestId,
          response,
        } satisfies RuntimeKernelHttpProtocolMessage);
      }, (error) => {
        pending.httpDispatchAbortControllers.delete(message.requestId);
        this.postKernelHttpError(commandId, {
          requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    if (type === 'kernel-http-abort-dispatch' && message.type === 'kernel-http-abort-dispatch') {
      pending.httpDispatchAbortControllers.get(message.requestId)?.abort();
      pending.httpDispatchAbortControllers.delete(message.requestId);
      return;
    }
    if (type === 'kernel-http-error' && message.type === 'kernel-http-error') {
      if (message.requestId) {
        const request = pending.httpRequests.get(message.requestId);
        pending.httpRequests.delete(message.requestId);
        request?.reject(new Error(message.error));
      }
    }
  }

  private dispatchWorkerKernelHttpRequest(
    commandId: string,
    listenerId: string,
    request: RuntimeKernelHttpRequest
  ): Promise<RuntimeKernelHttpResponse> {
    const pending = this.pendingMessages.get(commandId);
    if (!pending || !this.worker) return Promise.reject(new Error('JavaScript project worker is not running.'));
    const requestId = `${commandId}:http:${++this.httpRequestId}`;
    let abortListener: (() => void) | undefined;
    return new Promise<RuntimeKernelHttpResponse>((resolve, reject) => {
      const cleanup = (): void => {
        if (abortListener) request.signal?.removeEventListener?.('abort', abortListener);
      };
      pending.httpRequests.set(requestId, {
        resolve: (response) => {
          cleanup();
          resolve(response);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      if (request.signal) {
        abortListener = () => {
          this.postWorkerMessage(commandId, 'kernel-http-abort-request', {
            type: 'kernel-http-abort-request',
            requestId,
          } satisfies RuntimeKernelHttpProtocolMessage);
        };
        request.signal.addEventListener?.('abort', abortListener, { once: true });
        if (request.signal.aborted) abortListener();
      }
      this.postWorkerMessage(commandId, 'kernel-http-request', {
        type: 'kernel-http-request',
        listenerId,
        requestId,
        request: serializableKernelHttpRequest(request),
      } satisfies RuntimeKernelHttpProtocolMessage);
    });
  }

  private postWorkerMessage(commandId: string, type: string, payload: unknown): void {
    const pending = this.pendingMessages.get(commandId);
    if (!pending) return;
    const message: BrowserJavaScriptProjectWorkerMessage = {
      id: commandId,
      type,
      payload,
      protocolToken: pending.protocolToken,
    };
    this.worker?.postMessage(message);
  }

  private postKernelHttpError(
    commandId: string,
    error: Omit<Extract<RuntimeKernelHttpProtocolMessage, { type: 'kernel-http-error' }>, 'type'>
  ): void {
    this.postWorkerMessage(commandId, 'kernel-http-error', {
      type: 'kernel-http-error',
      ...error,
    } satisfies RuntimeKernelHttpProtocolMessage);
  }

  private cleanupPendingKernelHttp(pending: BrowserJavaScriptProjectPendingMessage): void {
    pending.abortCleanup?.();
    pending.kernelSignalCleanup?.();
    if (pending.signalGraceTimeoutId !== undefined) this.hostClearTimeout(pending.signalGraceTimeoutId);
    for (const listener of pending.httpListeners.values()) listener.close();
    pending.httpListeners.clear();
    for (const request of pending.httpRequests.values()) request.reject(new Error('JavaScript project worker finished before HTTP response.'));
    pending.httpRequests.clear();
    for (const abortController of pending.httpDispatchAbortControllers.values()) abortController.abort();
    pending.httpDispatchAbortControllers.clear();
  }

  private executeWithTimeout(
    executor: () => Promise<RuntimeCommandResult>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<RuntimeCommandResult> {
    return new Promise<RuntimeCommandResult>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.hostClearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        const abortError = createBrowserJavaScriptProjectAbortError();
        this.terminateAndReset(abortError);
        rejectOnce(abortError);
      };
      const timeoutId = this.hostSetTimeout(() => {
        const timeoutError = new Error(`node: execution timed out after ${timeoutMs}ms`);
        this.terminateAndReset(timeoutError);
        rejectOnce(timeoutError);
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });

      executor().then((result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      }, (error) => {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private terminateAndReset(reason: Error = new Error('JavaScript project worker was terminated')): void {
    this.worker?.terminate();
    this.worker = null;
    this.workerReadyReject?.(reason);
    this.workerReadyPromise = null;
    this.workerReadyResolve = null;
    this.workerReadyReject = null;
    for (const [, pending] of this.pendingMessages) {
      this.cleanupPendingKernelHttp(pending);
      pending.reject(reason);
    }
    this.pendingMessages.clear();
  }
}

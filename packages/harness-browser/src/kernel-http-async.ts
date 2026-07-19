/**
 * Shared async kernel-HTTP bridge for worker clients whose workers speak the
 * message-based (non-SharedArrayBuffer) kernel-HTTP sub-protocol.
 *
 * A worker client participates by exposing an {@link AsyncKernelHttpHost}
 * adapter over its pending-message registry and worker handle. The protocol
 * behavior lives here once: listener registration (closing any previous
 * listener under the same id), listener teardown, host->worker request
 * relaying with abort propagation, worker-initiated dispatches with abort
 * controllers, and end-of-command cleanup.
 */

import type {
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpListenerHandle,
  RuntimeKernelHttpProtocolMessage,
  RuntimeKernelHttpRequest,
  RuntimeKernelHttpResponse,
} from '@tracecode/harness-core';

export interface AsyncKernelHttpPendingState {
  readonly kernelHttp?: RuntimeKernelHttpBridge;
  readonly httpListeners?: Map<string, RuntimeKernelHttpListenerHandle>;
  readonly httpRequests?: Map<
    string,
    { resolve: (response: RuntimeKernelHttpResponse) => void; reject: (error: Error) => void }
  >;
  readonly httpDispatchAbortControllers?: Map<string, AbortController>;
}

export interface AsyncKernelHttpHost {
  /** Human label used in teardown/error messages, e.g. 'Python' or 'C#'. */
  readonly runtimeLabel: string;
  getPending(commandId: string): AsyncKernelHttpPendingState | undefined;
  postWorkerMessage(commandId: string, type: string, payload: RuntimeKernelHttpProtocolMessage): void;
  isWorkerRunning(): boolean;
  nextHttpRequestId(): number;
}

export function serializableKernelHttpRequest(request: RuntimeKernelHttpRequest): RuntimeKernelHttpRequest {
  const { signal: _signal, ...serializable } = request;
  return serializable;
}

export function postAsyncKernelHttpError(
  host: AsyncKernelHttpHost,
  commandId: string,
  error: Omit<Extract<RuntimeKernelHttpProtocolMessage, { type: 'kernel-http-error' }>, 'type'>
): void {
  host.postWorkerMessage(commandId, 'kernel-http-error', {
    type: 'kernel-http-error',
    ...error,
  } satisfies RuntimeKernelHttpProtocolMessage);
}

export function handleAsyncKernelHttpProtocolMessage(
  host: AsyncKernelHttpHost,
  commandId: string,
  type: string,
  payload: unknown
): void {
  const pending = host.getPending(commandId);
  if (!pending) return;
  const message = payload as RuntimeKernelHttpProtocolMessage;

  if (type === 'kernel-http-listen' && message.type === 'kernel-http-listen') {
    if (!pending.kernelHttp) {
      postAsyncKernelHttpError(host, commandId, {
        listenerId: message.listenerId,
        error: 'Network subsystem is unavailable.',
      });
      return;
    }
    try {
      const previous = pending.httpListeners?.get(message.listenerId);
      previous?.close();
      const handle = pending.kernelHttp.listen(message.options, (request) =>
        dispatchAsyncWorkerKernelHttpRequest(host, commandId, message.listenerId, request)
      );
      pending.httpListeners?.set(message.listenerId, handle);
      host.postWorkerMessage(commandId, 'kernel-http-listen-result', {
        type: 'kernel-http-listen-result',
        listenerId: message.listenerId,
        info: handle.info,
      } satisfies RuntimeKernelHttpProtocolMessage);
    } catch (error) {
      postAsyncKernelHttpError(host, commandId, {
        listenerId: message.listenerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (type === 'kernel-http-close' && message.type === 'kernel-http-close') {
    const listener = pending.httpListeners?.get(message.listenerId);
    pending.httpListeners?.delete(message.listenerId);
    try {
      listener?.close();
    } catch (error) {
      postAsyncKernelHttpError(host, commandId, {
        listenerId: message.listenerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (type === 'kernel-http-response' && message.type === 'kernel-http-response') {
    const request = pending.httpRequests?.get(message.requestId);
    pending.httpRequests?.delete(message.requestId);
    request?.resolve(message.response);
    return;
  }

  if (type === 'kernel-http-dispatch' && message.type === 'kernel-http-dispatch') {
    if (!pending.kernelHttp) {
      postAsyncKernelHttpError(host, commandId, {
        requestId: message.requestId,
        error: 'Network subsystem is unavailable.',
      });
      return;
    }
    const abortController = new AbortController();
    pending.httpDispatchAbortControllers?.set(message.requestId, abortController);
    Promise.resolve()
      .then(() =>
        pending.kernelHttp!.dispatch(message.request, {
          signal: abortController.signal,
          ...(message.timeoutMs !== undefined ? { timeoutMs: message.timeoutMs } : {}),
        })
      )
      .then(
        (response) => {
          pending.httpDispatchAbortControllers?.delete(message.requestId);
          host.postWorkerMessage(commandId, 'kernel-http-dispatch-result', {
            type: 'kernel-http-dispatch-result',
            requestId: message.requestId,
            response,
          } satisfies RuntimeKernelHttpProtocolMessage);
        },
        (error) => {
          pending.httpDispatchAbortControllers?.delete(message.requestId);
          postAsyncKernelHttpError(host, commandId, {
            requestId: message.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      );
    return;
  }

  if (type === 'kernel-http-abort-dispatch' && message.type === 'kernel-http-abort-dispatch') {
    pending.httpDispatchAbortControllers?.get(message.requestId)?.abort();
    pending.httpDispatchAbortControllers?.delete(message.requestId);
    return;
  }

  if (type === 'kernel-http-error' && message.type === 'kernel-http-error' && message.requestId) {
    const request = pending.httpRequests?.get(message.requestId);
    pending.httpRequests?.delete(message.requestId);
    request?.reject(new Error(message.error));
  }
}

export function dispatchAsyncWorkerKernelHttpRequest(
  host: AsyncKernelHttpHost,
  commandId: string,
  listenerId: string,
  request: RuntimeKernelHttpRequest
): Promise<RuntimeKernelHttpResponse> {
  const pending = host.getPending(commandId);
  if (!pending || !host.isWorkerRunning()) {
    return Promise.reject(new Error(`${host.runtimeLabel} worker is not running.`));
  }
  const requestId = `${commandId}:http:${host.nextHttpRequestId()}`;
  let abortListener: (() => void) | undefined;
  return new Promise<RuntimeKernelHttpResponse>((resolve, reject) => {
    const cleanup = (): void => {
      if (abortListener) request.signal?.removeEventListener?.('abort', abortListener);
    };
    pending.httpRequests?.set(requestId, {
      resolve: (response) => {
        cleanup();
        resolve(response);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
    });
    host.postWorkerMessage(commandId, 'kernel-http-request', {
      type: 'kernel-http-request',
      listenerId,
      requestId,
      request: serializableKernelHttpRequest(request),
    } satisfies RuntimeKernelHttpProtocolMessage);
    if (request.signal) {
      abortListener = () => {
        host.postWorkerMessage(commandId, 'kernel-http-abort-request', {
          type: 'kernel-http-abort-request',
          requestId,
        } satisfies RuntimeKernelHttpProtocolMessage);
      };
      request.signal.addEventListener?.('abort', abortListener, { once: true });
      if (request.signal.aborted) abortListener();
    }
  });
}

/** End-of-command teardown: close listeners, fail outstanding requests, abort dispatches. */
export function cleanupAsyncKernelHttp(pending: AsyncKernelHttpPendingState, runtimeLabel: string): void {
  for (const listener of pending.httpListeners?.values() ?? []) {
    try {
      listener.close();
    } catch {
      // Cleanup must continue so requests and dispatches cannot outlive their command.
    }
  }
  pending.httpListeners?.clear();
  for (const request of pending.httpRequests?.values() ?? []) {
    request.reject(new Error(`${runtimeLabel} worker finished before HTTP response.`));
  }
  pending.httpRequests?.clear();
  for (const abortController of pending.httpDispatchAbortControllers?.values() ?? []) {
    abortController.abort();
  }
  pending.httpDispatchAbortControllers?.clear();
}

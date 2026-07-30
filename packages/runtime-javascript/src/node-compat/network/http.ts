import type { RuntimeFileEncoding, RuntimeKernelHttpBridge, RuntimeKernelHttpListenerHandle, RuntimeKernelHttpResponse } from "@tracecode/runtime-core";

import { bytesFromFsWriteValue, bytesFromRuntimeHttpBody, bytesToRuntimeHttpBody, concatBytes, textFromBytes } from "../../internal/encoding";

import { HTTP_STATUS_CODES, bodyToHttpBody, createClientIncomingMessage, createIncomingMessage, createListenerMap, createServerResponse, headersFromHttpOptions, normalizeHttpClientRequest, runtimeKernelFetchError, runtimeKernelNetworkCause } from "./shared";

export function createHttpApi(kernelHttp: RuntimeKernelHttpBridge | undefined, signal: AbortSignal | undefined) {
  const activeHandles = new Set<RuntimeKernelHttpListenerHandle>();
  const activeClientAborters = new Set<() => void>();
  let activeClientRequests = 0;
  let activeWorkError: Error | null = null;
  const closeWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const notifyCloseWaiters = (): void => {
    if (activeHandles.size > 0 || activeClientRequests > 0) return;
    while (closeWaiters.length > 0) {
      const waiter = closeWaiters.shift();
      if (!waiter) continue;
      if (activeWorkError) waiter.reject(activeWorkError);
      else waiter.resolve();
    }
  };
  const closeHandle = (handle: RuntimeKernelHttpListenerHandle): void => {
    if (!activeHandles.delete(handle)) return;
    handle.close();
    notifyCloseWaiters();
  };
  const closeAll = (): void => {
    for (const handle of [...activeHandles]) closeHandle(handle);
    for (const abortClient of [...activeClientAborters]) abortClient();
  };
  signal?.addEventListener('abort', closeAll, { once: true });

  const createServer = (requestListener?: (request: unknown, response: unknown) => unknown) => {
    const events = createListenerMap();
    let handle: RuntimeKernelHttpListenerHandle | null = null;
    const server = {
      listening: false,
      listen: (...args: unknown[]) => {
        if (!kernelHttp) throw Object.assign(new Error('ENOSYS: network subsystem is unavailable'), { code: 'ENOSYS' });
        const port = typeof args[0] === 'number' || typeof args[0] === 'string' ? Number(args[0]) : 80;
        const host = typeof args[1] === 'string' ? args[1] : undefined;
        const callback = args.find((arg): arg is () => void => typeof arg === 'function');
        const listenerHandle = kernelHttp.listen({ port, ...(host ? { host } : {}) }, async (request) => {
          const incoming = createIncomingMessage(request);
          const responsePromise = new Promise<RuntimeKernelHttpResponse>((resolve) => {
            const response = createServerResponse(resolve);
            let handled = false;
            try {
              handled = events.emit('request', incoming, response);
            } catch (error) {
              if (!response.writableEnded) {
                response.statusCode = 500;
                response.end(error instanceof Error ? error.message : String(error));
              }
              return;
            }
            if (!handled && !response.writableEnded) {
              response.statusCode = 404;
              response.end('');
            }
          });
          return responsePromise;
        });
        handle = listenerHandle;
        activeHandles.add(listenerHandle);
        const markListening = (): void => {
          if (handle !== listenerHandle) return;
          server.listening = true;
          events.emit('listening');
          callback?.();
        };
        if (listenerHandle.ready) {
          void listenerHandle.ready.then(markListening, (cause) => {
            if (handle !== listenerHandle) return;
            server.listening = false;
            const error = cause instanceof Error ? cause : new Error(String(cause));
            try {
              if (!events.emit('error', error)) activeWorkError ??= error;
            } catch (unhandledError) {
              activeWorkError ??= unhandledError instanceof Error
                ? unhandledError
                : new Error(String(unhandledError));
            }
            closeHandle(listenerHandle);
            if (handle === listenerHandle) handle = null;
          });
        } else {
          markListening();
        }
        return server;
      },
      close: (callback?: (error?: Error) => void) => {
        if (handle) closeHandle(handle);
        handle = null;
        server.listening = false;
        events.emit('close');
        callback?.();
        return server;
      },
      address: () => handle ? { address: handle.info.host, port: handle.info.port, family: 'IPv4' } : null,
      on: events.on,
      addListener: events.addListener,
      once: events.once,
      removeListener: events.removeListener,
      off: events.off,
      emit: events.emit,
    };
    if (requestListener) server.on('request', requestListener as (...args: unknown[]) => void);
    return server;
  };

  const request = (...args: unknown[]) => {
    const events = createListenerMap();
    const chunks: Uint8Array[] = [];
    const headers: Record<string, string> = {};
    let ended = false;
    let destroyed = false;
    let timeoutMs: number | undefined;
    let timeoutCallback: (() => void) | undefined;
    let activeAbortClientRequest: ((error?: Error) => void) | undefined;
    let requestOptions: ReturnType<typeof normalizeHttpClientRequest>;
    try {
      requestOptions = normalizeHttpClientRequest(args);
      Object.assign(headers, requestOptions.headers);
      timeoutMs = requestOptions.timeoutMs;
    } catch (error) {
      requestOptions = {
        headers,
        method: 'GET',
        url: new URL('http://localhost/'),
      };
      queueMicrotask(() => events.emit('error', error));
    }
    const clientRequest = {
      destroyed: false,
      writableEnded: false,
      setTimeout: (milliseconds: number, callback?: () => void) => {
        timeoutMs = Math.max(0, Number(milliseconds) || 0);
        timeoutCallback = callback;
        if (callback) events.once('timeout', callback);
        return clientRequest;
      },
      setHeader: (name: string, value: unknown) => {
        headers[String(name).toLowerCase()] = String(value);
        return clientRequest;
      },
      getHeader: (name: string) => headers[String(name).toLowerCase()],
      getHeaders: () => ({ ...headers }),
      hasHeader: (name: string) => Object.prototype.hasOwnProperty.call(headers, String(name).toLowerCase()),
      removeHeader: (name: string) => {
        delete headers[String(name).toLowerCase()];
      },
      write: (chunk: unknown, encoding?: string | (() => void), callback?: () => void) => {
        if (destroyed) return false;
        chunks.push(bytesFromFsWriteValue(chunk, typeof encoding === 'string' ? encoding : undefined));
        const done = typeof encoding === 'function' ? encoding : callback;
        done?.();
        return true;
      },
      end: (chunk?: unknown, encoding?: string | (() => void), callback?: () => void) => {
        if (ended || destroyed) return clientRequest;
        if (chunk !== undefined && chunk !== null) clientRequest.write(chunk, typeof encoding === 'string' ? encoding : undefined);
        ended = true;
        clientRequest.writableEnded = true;
        const done = typeof encoding === 'function' ? encoding : callback;
        done?.();
        if (!kernelHttp) {
          activeClientRequests += 1;
          queueMicrotask(() => {
            events.emit('error', Object.assign(new Error('ENOSYS: network subsystem is unavailable'), { code: 'ENOSYS' }));
            activeClientRequests -= 1;
            notifyCloseWaiters();
          });
          return clientRequest;
        }
        const body = bytesToRuntimeHttpBody(concatBytes(chunks));
        const rawHeaders = Object.entries(headers);
        activeClientRequests += 1;
        let active = true;
        let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | undefined;
        let requestAbortListener: (() => void) | undefined;
        const dispatchAbortController = new AbortController();
        const finishClientRequest = (): void => {
          if (!active) return;
          active = false;
          activeAbortClientRequest = undefined;
          if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle);
          if (requestAbortListener) requestOptions.signal?.removeEventListener?.('abort', requestAbortListener);
          activeClientAborters.delete(abortClientRequest);
          queueMicrotask(() => {
            queueMicrotask(() => {
              activeClientRequests -= 1;
              notifyCloseWaiters();
            });
          });
        };
        const abortClientRequest = (error?: Error): void => {
          if (destroyed) return;
          destroyed = true;
          clientRequest.destroyed = true;
          if (!dispatchAbortController.signal.aborted) dispatchAbortController.abort();
          if (error) events.emit('error', error);
          events.emit('close');
          finishClientRequest();
        };
        activeAbortClientRequest = abortClientRequest;
        activeClientAborters.add(abortClientRequest);
        if (requestOptions.signal) {
          requestAbortListener = () => abortClientRequest(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
          requestOptions.signal.addEventListener?.('abort', requestAbortListener, { once: true });
          if (requestOptions.signal.aborted) requestAbortListener();
        }
        if (!destroyed && timeoutMs !== undefined) {
          timeoutHandle = globalThis.setTimeout(() => {
            events.emit('timeout');
            abortClientRequest(Object.assign(new Error(`ETIMEDOUT: request timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
          }, timeoutMs);
        }
        void kernelHttp.dispatch({
          method: requestOptions.method,
          url: requestOptions.url.toString(),
          path: `${requestOptions.url.pathname}${requestOptions.url.search}`,
          headers,
          ...(rawHeaders.length > 0 ? { rawHeaders } : {}),
          ...(chunks.length > 0 ? body : {}),
        }, {
          signal: dispatchAbortController.signal,
        }).then((response) => {
          if (destroyed) return;
          if (response.status === 0) {
            events.emit('error', runtimeKernelNetworkCause(response, requestOptions.url));
            finishClientRequest();
            return;
          }
          const incoming = createClientIncomingMessage(response);
          requestOptions.callback?.(incoming);
          events.emit('response', incoming);
          finishClientRequest();
        }, (error) => {
          if (!destroyed) events.emit('error', error);
          finishClientRequest();
        });
        return clientRequest;
      },
      abort: () => {
        clientRequest.destroy();
        events.emit('abort');
      },
      destroy: (error?: Error) => {
        if (activeAbortClientRequest) {
          activeAbortClientRequest(error);
          return clientRequest;
        }
        if (destroyed) return clientRequest;
        destroyed = true;
        clientRequest.destroyed = true;
        if (error) events.emit('error', error);
        events.emit('close');
        return clientRequest;
      },
      on: events.on,
      addListener: events.addListener,
      once: events.once,
      removeListener: events.removeListener,
      off: events.off,
      emit: events.emit,
    };
    return clientRequest;
  };

  const get = (...args: unknown[]) => {
    const clientRequest = request(...args);
    clientRequest.end();
    return clientRequest;
  };

  const httpsRequest = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string' || first instanceof URL) return request(...args);
    const options = first && typeof first === 'object'
      ? { ...(first as Record<string, unknown>), protocol: (first as Record<string, unknown>).protocol ?? 'https:' }
      : { protocol: 'https:' };
    return request(options, ...args.slice(1));
  };

  const httpsGet = (...args: unknown[]) => {
    const clientRequest = httpsRequest(...args);
    clientRequest.end();
    return clientRequest;
  };

  class TraceKernelHeaders {
    readonly headerValues = new Map<string, string>();

    constructor(init?: unknown) {
      const record = headersFromHttpOptions(init);
      for (const [name, value] of Object.entries(record)) this.set(name, value);
    }

    append(name: string, value: unknown): void {
      const key = String(name).toLowerCase();
      const current = this.headerValues.get(key);
      this.headerValues.set(key, current === undefined ? String(value) : `${current}, ${String(value)}`);
    }

    delete(name: string): void {
      this.headerValues.delete(String(name).toLowerCase());
    }

    entries(): IterableIterator<[string, string]> {
      return this.headerValues.entries();
    }

    forEach(callback: (value: string, name: string, parent: TraceKernelHeaders) => void): void {
      for (const [name, value] of this.headerValues) callback(value, name, this);
    }

    get(name: string): string | null {
      return this.headerValues.get(String(name).toLowerCase()) ?? null;
    }

    has(name: string): boolean {
      return this.headerValues.has(String(name).toLowerCase());
    }

    keys(): IterableIterator<string> {
      return this.headerValues.keys();
    }

    set(name: string, value: unknown): void {
      this.headerValues.set(String(name).toLowerCase(), String(value));
    }

    values(): IterableIterator<string> {
      return this.headerValues.values();
    }

    toRecord(): Record<string, string> {
      return Object.fromEntries(this.headerValues);
    }

    [Symbol.iterator](): IterableIterator<[string, string]> {
      return this.entries();
    }
  }

  class TraceKernelRequest {
    readonly headers: TraceKernelHeaders;
    readonly method: string;
    readonly signal?: AbortSignal;
    readonly url: string;
    readonly bodyPayload?: { body: string; bodyEncoding?: RuntimeFileEncoding };

    constructor(input: unknown, init?: Record<string, unknown>) {
      const sourceRequest = input instanceof TraceKernelRequest ? input : null;
      const source = input as {
        url?: unknown;
        method?: unknown;
        headers?: unknown;
        body?: unknown;
        bodyEncoding?: RuntimeFileEncoding;
        signal?: AbortSignal;
      };
      const inputUrl = typeof input === 'string' || input instanceof URL
        ? String(input)
        : String(sourceRequest?.url ?? source.url ?? '');
      this.url = inputUrl;
      this.method = String(init?.method ?? sourceRequest?.method ?? source.method ?? 'GET').toUpperCase();
      this.headers = new TraceKernelHeaders(sourceRequest?.headers ?? source.headers);
      const initHeaders = new TraceKernelHeaders(init?.headers);
      initHeaders.forEach((value, name) => this.headers.set(name, value));
      this.bodyPayload = init && Object.prototype.hasOwnProperty.call(init, 'body')
        ? bodyToHttpBody(init.body)
        : sourceRequest?.bodyForDispatch() ?? (
            source.bodyEncoding === 'base64'
              ? { body: String(source.body ?? ''), bodyEncoding: 'base64' }
              : bodyToHttpBody(source.body)
          );
      const initSignal = init?.signal;
      this.signal = initSignal && typeof initSignal === 'object' ? initSignal as AbortSignal : sourceRequest?.signal ?? source.signal;
    }

    async text(): Promise<string> {
      return textFromBytes(bytesFromRuntimeHttpBody(this.bodyPayload ?? {}));
    }

    bodyForDispatch(): { body: string; bodyEncoding?: RuntimeFileEncoding } | undefined {
      return this.bodyPayload;
    }
  }

  class TraceKernelResponse {
    readonly headers: TraceKernelHeaders;
    readonly ok: boolean;
    readonly redirected = false;
    readonly status: number;
    readonly statusText: string;
    readonly type = 'basic';
    readonly url: string;
    readonly bodyBytes: Uint8Array;
    used = false;

    constructor(bodyOrResponse: unknown = '', initOrUrl?: Record<string, unknown> | string) {
      const kernelResponse = typeof initOrUrl === 'string' &&
        bodyOrResponse !== null &&
        typeof bodyOrResponse === 'object' &&
        'status' in bodyOrResponse
        ? bodyOrResponse as RuntimeKernelHttpResponse
        : null;
      const init = !kernelResponse && initOrUrl && typeof initOrUrl === 'object' ? initOrUrl : {};
      const status = kernelResponse ? kernelResponse.status : Math.trunc(Number(init.status ?? 200)) || 200;
      this.status = status;
      this.statusText = HTTP_STATUS_CODES[status] ?? '';
      this.ok = status >= 200 && status < 300;
      this.headers = new TraceKernelHeaders(kernelResponse ? kernelResponse.headers : init.headers);
      this.bodyBytes = kernelResponse
        ? bytesFromRuntimeHttpBody(kernelResponse)
        : bytesFromRuntimeHttpBody(bodyToHttpBody(bodyOrResponse) ?? {});
      this.url = typeof initOrUrl === 'string' ? initOrUrl : '';
    }

    get bodyUsed(): boolean {
      return this.used;
    }

    consume(): Uint8Array {
      if (this.used) throw new TypeError('Body has already been consumed.');
      this.used = true;
      return new Uint8Array(this.bodyBytes);
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
      const bytes = this.consume();
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return buffer;
    }

    clone(): TraceKernelResponse {
      if (this.used) throw new TypeError('Body has already been consumed.');
      return new TraceKernelResponse({
        status: this.status,
        headers: this.headers.toRecord(),
        ...bytesToRuntimeHttpBody(this.bodyBytes),
      }, this.url);
    }

    async json(): Promise<unknown> {
      return JSON.parse(textFromBytes(this.consume()));
    }

    async text(): Promise<string> {
      return textFromBytes(this.consume());
    }
  }

  const fetch = async (input: unknown, init?: Record<string, unknown>): Promise<TraceKernelResponse> => {
    if (!kernelHttp) throw Object.assign(new Error('ENOSYS: network subsystem is unavailable'), { code: 'ENOSYS' });
    const request = new TraceKernelRequest(input, init);
    const url = new URL(request.url);
    const body = request.bodyForDispatch();
    const headers = request.headers.toRecord();
    const rawHeaders = Object.entries(headers);
    activeClientRequests += 1;
    let active = true;
    let abortListener: (() => void) | undefined;
    let rejectFetch: ((error: unknown) => void) | undefined;
    const dispatchAbortController = new AbortController();
    const finishFetch = (): void => {
      if (!active) return;
      active = false;
      if (abortListener) request.signal?.removeEventListener?.('abort', abortListener);
      activeClientAborters.delete(abortFetch);
      globalThis.setTimeout(() => {
        activeClientRequests -= 1;
        notifyCloseWaiters();
      }, 0);
    };
    const abortFetch = (): void => {
      if (!dispatchAbortController.signal.aborted) dispatchAbortController.abort();
      rejectFetch?.(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
      finishFetch();
    };
    activeClientAborters.add(abortFetch);
    return new Promise<TraceKernelResponse>((resolve, reject) => {
      rejectFetch = reject;
      if (request.signal) {
        abortListener = abortFetch;
        request.signal.addEventListener?.('abort', abortListener, { once: true });
        if (request.signal.aborted) {
          abortFetch();
          return;
        }
      }
      if (!active) return;
      void kernelHttp.dispatch({
        method: request.method,
        url: url.toString(),
        path: `${url.pathname}${url.search}`,
        headers,
        ...(rawHeaders.length > 0 ? { rawHeaders } : {}),
        ...(body !== undefined ? body : {}),
      }, {
        signal: dispatchAbortController.signal,
      }).then((response) => {
        if (!active) return;
        if (response.status === 0) {
          reject(runtimeKernelFetchError(response, url));
          finishFetch();
          return;
        }
        resolve(new TraceKernelResponse(response, url.toString()));
        finishFetch();
      }, (error) => {
        if (!active) return;
        reject(error);
        finishFetch();
      });
    });
  };

  return {
    module: {
      createServer,
      request,
      get,
      Server: function Server(this: unknown, requestListener?: (request: unknown, response: unknown) => unknown) {
        return createServer(requestListener);
      },
      STATUS_CODES: HTTP_STATUS_CODES,
    },
    httpsModule: {
      request: httpsRequest,
      get: httpsGet,
      STATUS_CODES: HTTP_STATUS_CODES,
    },
    fetch,
    Headers: TraceKernelHeaders,
    Request: TraceKernelRequest,
    Response: TraceKernelResponse,
    // A completed asynchronous operation with an unhandled failure is still
    // process work. Keep it visible until waitForClose reports the failure;
    // otherwise the quiescence loop can observe zero handles and incorrectly
    // return exit 0 before propagating an EADDRINUSE or client error.
    hasActiveWork: () => activeHandles.size > 0 || activeClientRequests > 0 || activeWorkError !== null,
    waitForClose: () => activeHandles.size === 0 && activeClientRequests === 0
      ? activeWorkError ? Promise.reject(activeWorkError) : Promise.resolve()
      : new Promise<void>((resolve, reject) => closeWaiters.push({ resolve, reject })),
    closeAll,
  };
}

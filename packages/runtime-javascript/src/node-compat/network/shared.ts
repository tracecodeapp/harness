import type { RuntimeFileEncoding, RuntimeKernelHttpRequest, RuntimeKernelHttpResponse } from "@tracecode/runtime-core";

import type { TraceKernelSyscallRequest, TraceKernelSyscallValue } from "@tracecode/tracekernel";

import { BrowserTraceKernelNetwork } from "../../browser/contracts";

import { BrowserBuffer, bytesFromFsWriteValue, bytesFromRuntimeHttpBody, bytesToRuntimeHttpBody, concatBytes } from "../../internal/encoding";

export function createListenerMap() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const on = (event: string, listener: (...args: unknown[]) => void) => {
    const next = listeners.get(event) ?? [];
    next.push(listener);
    listeners.set(event, next);
    return api;
  };
  const removeListener = (event: string, listener: (...args: unknown[]) => void) => {
    const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== listener);
    if (next.length === 0) listeners.delete(event);
    else listeners.set(event, next);
    return api;
  };
  const emit = (event: string, ...args: unknown[]): boolean => {
    const current = listeners.get(event) ?? [];
    for (const listener of current) listener(...args);
    return current.length > 0;
  };
  const api = {
    on,
    addListener: on,
    removeListener,
    off: removeListener,
    once: (event: string, listener: (...args: unknown[]) => void) => {
      const wrapped = (...args: unknown[]) => {
        removeListener(event, wrapped);
        listener(...args);
      };
      return on(event, wrapped);
    },
    emit,
  };
  return api;
}

export function createIncomingMessage(request: RuntimeKernelHttpRequest) {
  const events = createListenerMap();
  let encoding: string | undefined;
  let bodyRead = false;
  let bodyScheduled = false;
  let readableEnded = false;
  const bodyBytes = bytesFromRuntimeHttpBody(request);
  const rawHeaders = request.rawHeaders
    ? request.rawHeaders.flatMap(([name, value]) => [name, value])
    : Object.entries(request.headers ?? {}).flatMap(([name, value]) => [name, value]);
  const formatBody = () => encoding ? BrowserBuffer.from(bodyBytes).toString(encoding as BufferEncoding) : BrowserBuffer.from(bodyBytes);
  const scheduleBody = (): void => {
    if (bodyScheduled) return;
    bodyScheduled = true;
    queueMicrotask(() => {
      if (bodyBytes.byteLength > 0 && !bodyRead) {
        bodyRead = true;
        events.emit('data', formatBody());
      }
      readableEnded = true;
      events.emit('end');
    });
  };
  const message = {
    method: request.method,
    url: request.path,
    headers: request.headers ?? {},
    rawHeaders,
    signal: request.signal,
    httpVersion: '1.1',
    complete: true,
    get readableEnded() {
      return readableEnded;
    },
    socket: { remoteAddress: '127.0.0.1' },
    setEncoding: (nextEncoding: string) => {
      encoding = nextEncoding;
      return message;
    },
    read: () => {
      if (bodyRead) return null;
      bodyRead = true;
      readableEnded = true;
      return formatBody();
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      events.on(event, listener);
      if (event === 'data' || event === 'end') scheduleBody();
      return message;
    },
    addListener: (event: string, listener: (...args: unknown[]) => void) => message.on(event, listener),
    once: (event: string, listener: (...args: unknown[]) => void) => {
      events.once(event, listener);
      if (event === 'data' || event === 'end') scheduleBody();
      return message;
    },
    removeListener: events.removeListener,
    off: events.removeListener,
    [Symbol.asyncIterator]: async function* () {
      if (bodyBytes.byteLength > 0 && !bodyRead) {
        bodyRead = true;
        readableEnded = true;
        yield formatBody();
      }
    },
  };
  return message;
}

export function createServerResponse(resolve: (response: RuntimeKernelHttpResponse) => void) {
  const events = createListenerMap();
  const headers: Record<string, string> = {};
  const headerEntries = new Map<string, { name: string; values: string[] }>();
  const chunks: Uint8Array[] = [];
  let ended = false;
  const setHeaderValue = (name: string, value: unknown): void => {
    const key = String(name).toLowerCase();
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    const text = values.join(', ');
    headers[key] = text;
    headerEntries.set(key, { name: String(name), values });
  };
  const responseRawHeaders = (): Array<[string, string]> => {
    const result: Array<[string, string]> = [];
    for (const entry of headerEntries.values()) {
      for (const value of entry.values) result.push([entry.name, value]);
    }
    return result;
  };
  const response = {
    statusCode: 200,
    statusMessage: 'OK',
    headersSent: false,
    writableEnded: false,
    setHeader: (name: string, value: unknown) => {
      setHeaderValue(name, value);
      return response;
    },
    getHeader: (name: string) => headers[String(name).toLowerCase()],
    getHeaders: () => ({ ...headers }),
    hasHeader: (name: string) => Object.prototype.hasOwnProperty.call(headers, String(name).toLowerCase()),
    removeHeader: (name: string) => {
      const key = String(name).toLowerCase();
      delete headers[key];
      headerEntries.delete(key);
    },
    flushHeaders: () => {
      response.headersSent = true;
    },
    writeHead: (statusCode: number, reasonOrHeaders?: string | Record<string, unknown>, maybeHeaders?: Record<string, unknown>) => {
      response.statusCode = Number(statusCode) || 200;
      response.headersSent = true;
      const nextHeaders = typeof reasonOrHeaders === 'object' && reasonOrHeaders !== null ? reasonOrHeaders : maybeHeaders;
      for (const [name, value] of Object.entries(nextHeaders ?? {})) setHeaderValue(name, value);
      return response;
    },
    write: (chunk: unknown, encoding?: string | (() => void), callback?: () => void) => {
      chunks.push(bytesFromFsWriteValue(chunk, typeof encoding === 'string' ? encoding : undefined));
      const done = typeof encoding === 'function' ? encoding : callback;
      done?.();
      return true;
    },
    end: (chunk?: unknown, encoding?: string | (() => void), callback?: () => void) => {
      if (ended) return response;
      if (chunk !== undefined && chunk !== null) response.write(chunk, typeof encoding === 'string' ? encoding : undefined);
      ended = true;
      response.writableEnded = true;
      const done = typeof encoding === 'function' ? encoding : callback;
      done?.();
      events.emit('finish');
      events.emit('close');
      const bodyBytes = concatBytes(chunks);
      const rawHeaders = responseRawHeaders();
      resolve({
        status: response.statusCode,
        headers,
        ...(rawHeaders.length > 0 ? { rawHeaders } : {}),
        ...bytesToRuntimeHttpBody(bodyBytes),
      });
      return response;
    },
    on: events.on,
    addListener: events.addListener,
    once: events.once,
    removeListener: events.removeListener,
    off: events.off,
    emit: events.emit,
  };
  return response;
}

export const HTTP_STATUS_CODES: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  404: 'Not Found',
  500: 'Internal Server Error',
};

export function createClientIncomingMessage(response: RuntimeKernelHttpResponse) {
  const events = createListenerMap();
  let encoding: string | undefined;
  let bodyRead = false;
  let bodyScheduled = false;
  let readableEnded = false;
  const bodyBytes = bytesFromRuntimeHttpBody(response);
  const formatBody = () => encoding ? BrowserBuffer.from(bodyBytes).toString(encoding as BufferEncoding) : BrowserBuffer.from(bodyBytes);
  const scheduleBody = (): void => {
    if (bodyScheduled) return;
    bodyScheduled = true;
    queueMicrotask(() => {
      if (bodyBytes.byteLength > 0 && !bodyRead) {
        bodyRead = true;
        events.emit('data', formatBody());
      }
      readableEnded = true;
      events.emit('end');
    });
  };
  const message = {
    statusCode: response.status,
    statusMessage: HTTP_STATUS_CODES[response.status] ?? '',
    headers: response.headers ?? {},
    rawHeaders: response.rawHeaders
      ? response.rawHeaders.flatMap(([name, value]) => [name, value])
      : Object.entries(response.headers ?? {}).flatMap(([name, value]) => [name, value]),
    httpVersion: '1.1',
    complete: true,
    get readableEnded() {
      return readableEnded;
    },
    setEncoding: (nextEncoding: string) => {
      encoding = nextEncoding;
      return message;
    },
    read: () => {
      if (bodyRead) return null;
      bodyRead = true;
      readableEnded = true;
      return formatBody();
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      events.on(event, listener);
      if (event === 'data' || event === 'end') scheduleBody();
      return message;
    },
    addListener: (event: string, listener: (...args: unknown[]) => void) => message.on(event, listener),
    once: (event: string, listener: (...args: unknown[]) => void) => {
      events.once(event, listener);
      if (event === 'data' || event === 'end') scheduleBody();
      return message;
    },
    removeListener: events.removeListener,
    off: events.removeListener,
    [Symbol.asyncIterator]: async function* () {
      if (bodyBytes.byteLength > 0 && !bodyRead) {
        bodyRead = true;
        readableEnded = true;
        yield formatBody();
      }
    },
  };
  return message;
}

export function headersFromHttpOptions(headers: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers || typeof headers !== 'object') return result;
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      result[String(entry[0]).toLowerCase()] = String(entry[1]);
    }
    return result;
  }
  if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
    (headers as { forEach: (callback: (value: unknown, name: unknown) => void) => void }).forEach((value, name) => {
      result[String(name).toLowerCase()] = String(value);
    });
    return result;
  }
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (Array.isArray(value)) result[name.toLowerCase()] = value.map(String).join(', ');
    else if (value !== undefined) result[name.toLowerCase()] = String(value);
  }
  return result;
}

export function bodyToHttpBody(body: unknown): { body: string; bodyEncoding?: RuntimeFileEncoding } | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return { body };
  if (body instanceof URLSearchParams) return { body: body.toString() };
  if (body instanceof ArrayBuffer) return bytesToRuntimeHttpBody(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) return bytesToRuntimeHttpBody(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  return { body: String(body) };
}

export function normalizeHttpClientRequest(args: unknown[]): {
  callback?: (response: unknown) => void;
  headers: Record<string, string>;
  method: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  url: URL;
} {
  const callback = args.find((arg): arg is (response: unknown) => void => typeof arg === 'function');
  const parts = args.filter((arg) => typeof arg !== 'function');
  const first = parts[0];
  const second = parts[1];
  const urlInput = typeof first === 'string' || first instanceof URL ? first : undefined;
  const options = (urlInput !== undefined ? second : first) as Record<string, unknown> | undefined;
  const baseUrl = urlInput !== undefined ? new URL(urlInput) : undefined;
  const optionHost = typeof options?.hostname === 'string'
    ? options.hostname
    : typeof options?.host === 'string'
      ? options.host
      : undefined;
  const protocol = String(options?.protocol ?? baseUrl?.protocol ?? 'http:');
  const hostname = optionHost ?? baseUrl?.hostname ?? 'localhost';
  const port = options?.port !== undefined ? String(options.port) : baseUrl?.port;
  const path = String(options?.path ?? `${baseUrl?.pathname ?? '/'}${baseUrl?.search ?? ''}`);
  const url = new URL(`${protocol}//${hostname}${port ? `:${port}` : ''}${path.startsWith('/') ? path : `/${path}`}`);
  return {
    ...(callback ? { callback } : {}),
    headers: headersFromHttpOptions(options?.headers),
    method: String(options?.method ?? 'GET').toUpperCase(),
    ...(typeof (options as { signal?: unknown } | undefined)?.signal === 'object' && (options as { signal?: unknown } | undefined)?.signal !== null
      ? { signal: (options as { signal: AbortSignal }).signal }
      : {}),
    ...(options?.timeout !== undefined && Number.isFinite(Number(options.timeout))
      ? { timeoutMs: Math.max(0, Number(options.timeout)) }
      : {}),
    url,
  };
}

export function runtimeKernelNetworkCause(response: RuntimeKernelHttpResponse, url: URL): Error {
  const code = response.error?.code || 'ECONNREFUSED';
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const message = code === 'EPROTONOSUPPORT'
    ? response.error?.message.replace(/^EPROTONOSUPPORT:\s*/, '') || `Protocol "${url.protocol.replace(/:$/, '')}" not supported`
    : code === 'EAGAIN' || code === 'ERATELIMIT'
      ? 'Resource temporarily unavailable'
      : `connect ${code} ${url.hostname}:${port}`;
  return Object.assign(new Error(message), {
    code,
    ...(code.startsWith('EHOST') || code === 'ECONNREFUSED'
      ? { address: url.hostname, port: Number(port) }
      : {}),
  });
}

export function runtimeKernelFetchError(response: RuntimeKernelHttpResponse, url: URL): TypeError {
  const cause = runtimeKernelNetworkCause(response, url);
  return Object.assign(new TypeError('fetch failed'), { cause });
}

export async function dispatchBrowserNetworkSyscall<
  Operation extends TraceKernelSyscallValue['op']
>(
  kernelNetwork: BrowserTraceKernelNetwork | undefined,
  request: Extract<TraceKernelSyscallRequest, { op: Operation }>
): Promise<Extract<TraceKernelSyscallValue, { op: Operation }>> {
  if (!kernelNetwork) {
    throw Object.assign(
      new Error('ENOSYS: network subsystem is unavailable'),
      { code: 'ENOSYS' }
    );
  }
  const result = await kernelNetwork.dispatch(request);
  if (result.ok === false) {
    throw Object.assign(new Error(result.error.message), {
      code: result.error.code,
    });
  }
  return result.value as Extract<TraceKernelSyscallValue, { op: Operation }>;
}

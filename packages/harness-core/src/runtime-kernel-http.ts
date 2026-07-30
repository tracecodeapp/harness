import type { RuntimeFileEncoding } from './runtime-workspace-manifest';

export interface RuntimeKernelHttpListenOptions {
  host?: string;
  port: number;
  protocol?: 'http';
}

export interface RuntimeKernelHttpListenerInfo {
  id: string;
  pid: number;
  host: string;
  port: number;
  protocol: 'http';
  startedAt: string;
}

export interface RuntimeKernelHttpRequest {
  method: string;
  url: string;
  path: string;
  headers?: Record<string, string>;
  rawHeaders?: readonly [string, string][];
  body?: string;
  bodyEncoding?: RuntimeFileEncoding;
  signal?: AbortSignal;
}

export interface RuntimeKernelHttpResponse {
  status: number;
  headers?: Record<string, string>;
  rawHeaders?: readonly [string, string][];
  body?: string;
  bodyEncoding?: RuntimeFileEncoding;
  annotation?: unknown;
  error?: RuntimeKernelHttpError;
}

export interface RuntimeKernelHttpBodyPayload {
  body?: string;
  bodyEncoding?: RuntimeFileEncoding;
}

export interface RuntimeKernelHttpError {
  code: string;
  message: string;
}

export interface RuntimeKernelHttpBodyInit {
  body: string;
  bodyEncoding?: RuntimeFileEncoding;
}

export interface RuntimeWorkspaceHttpRequestOptions {
  method?: string;
  url: string;
  path?: string;
  headers?: Record<string, string>;
  rawHeaders?: readonly [string, string][];
  body?: string;
  bodyEncoding?: RuntimeFileEncoding;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RuntimeKernelHttpDispatchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RuntimeWorkspaceHttpJsonRequestOptions extends Omit<RuntimeWorkspaceHttpRequestOptions, 'body' | 'bodyEncoding'> {
  body?: unknown;
}

export interface RuntimeWorkspaceHttpJsonResponse<T = unknown> extends RuntimeKernelHttpResponse {
  json: T;
  text: string;
}

export interface RuntimeWorkspaceHttpClient {
  request(options: RuntimeWorkspaceHttpRequestOptions): Promise<RuntimeKernelHttpResponse>;
  json<T = unknown>(options: RuntimeWorkspaceHttpJsonRequestOptions): Promise<RuntimeWorkspaceHttpJsonResponse<T>>;
  listen(options: RuntimeKernelHttpListenOptions, handler: RuntimeKernelHttpHandler): RuntimeKernelHttpListenerHandle;
}

export interface RuntimeKernelHttpListenerHandle {
  readonly id: string;
  readonly info: RuntimeKernelHttpListenerInfo;
  /**
   * Resolves once a transported listener has been accepted by the kernel.
   * In-process listeners are registered synchronously and may omit this.
   */
  readonly ready?: Promise<RuntimeKernelHttpListenerInfo>;
  close(): void;
}

export type RuntimeKernelHttpHandler = (request: RuntimeKernelHttpRequest) => Promise<RuntimeKernelHttpResponse> | RuntimeKernelHttpResponse;

export interface RuntimeKernelHttpBridge {
  listen(options: RuntimeKernelHttpListenOptions, handler: RuntimeKernelHttpHandler): RuntimeKernelHttpListenerHandle;
  dispatch(request: RuntimeKernelHttpRequest, options?: RuntimeKernelHttpDispatchOptions): Promise<RuntimeKernelHttpResponse>;
}

type RuntimeHttpBufferConstructor = {
  from(value: string, encoding: 'base64'): Uint8Array;
  from(value: Uint8Array): { toString(encoding: 'base64'): string };
};

function runtimeHttpGlobalBuffer(): RuntimeHttpBufferConstructor | undefined {
  return (globalThis as typeof globalThis & { Buffer?: RuntimeHttpBufferConstructor }).Buffer;
}

function runtimeHttpBytesFromBase64(value: string): Uint8Array {
  const buffer = runtimeHttpGlobalBuffer();
  if (buffer) return buffer.from(value, 'base64');

  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function runtimeHttpBase64FromBytes(bytes: Uint8Array): string {
  const buffer = runtimeHttpGlobalBuffer();
  if (buffer) return buffer.from(bytes).toString('base64');

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}

function runtimeHttpDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function runtimeHttpBodyBytes(message: RuntimeKernelHttpBodyPayload): Uint8Array {
  if (message.body === undefined) return new Uint8Array();
  return message.bodyEncoding === 'base64'
    ? runtimeHttpBytesFromBase64(message.body)
    : new TextEncoder().encode(message.body);
}

export function runtimeHttpBodyText(message: RuntimeKernelHttpBodyPayload): string {
  const bytes = runtimeHttpBodyBytes(message);
  return runtimeHttpDecodeUtf8(bytes) ?? new TextDecoder().decode(bytes);
}

export function runtimeHttpBodyFromBytes(bytes: Uint8Array): RuntimeKernelHttpBodyInit {
  const text = runtimeHttpDecodeUtf8(bytes);
  if (text !== null) return { body: text };
  return { body: runtimeHttpBase64FromBytes(bytes), bodyEncoding: 'base64' };
}

export function runtimeHttpBodyFromText(text: string): RuntimeKernelHttpBodyInit {
  return { body: text };
}

export function runtimeHttpRequestBytes(request: RuntimeKernelHttpRequest): Uint8Array {
  return runtimeHttpBodyBytes(request);
}

export function runtimeHttpRequestText(request: RuntimeKernelHttpRequest): string {
  return runtimeHttpBodyText(request);
}

export function runtimeHttpResponseBytes(response: RuntimeKernelHttpResponse): Uint8Array {
  return runtimeHttpBodyBytes(response);
}

export function runtimeHttpResponseText(response: RuntimeKernelHttpResponse): string {
  return runtimeHttpBodyText(response);
}

export type RuntimeKernelHttpProtocolMessage =
  | {
      type: 'kernel-http-listen';
      listenerId: string;
      options: RuntimeKernelHttpListenOptions;
    }
  | {
      type: 'kernel-http-listen-result';
      listenerId: string;
      info: RuntimeKernelHttpListenerInfo;
    }
  | {
      type: 'kernel-http-close';
      listenerId: string;
    }
  | {
      type: 'kernel-http-request';
      listenerId: string;
      requestId: string;
      request: RuntimeKernelHttpRequest;
    }
  | {
      type: 'kernel-http-abort-request';
      requestId: string;
    }
  | {
      type: 'kernel-http-response';
      requestId: string;
      response: RuntimeKernelHttpResponse;
    }
  | {
      type: 'kernel-http-dispatch';
      requestId: string;
      request: RuntimeKernelHttpRequest;
      timeoutMs?: number;
    }
  | {
      type: 'kernel-http-abort-dispatch';
      requestId: string;
    }
  | {
      type: 'kernel-http-dispatch-result';
      requestId: string;
      response: RuntimeKernelHttpResponse;
    }
  | {
      type: 'kernel-http-error';
      requestId?: string;
      listenerId?: string;
      error: string;
    };

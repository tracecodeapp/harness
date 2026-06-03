import type { CodeExecutionBatchResult, CodeExecutionResult, RuntimeExecutionTimings } from '../../harness-core/src/types';
import type {
  RuntimeCommandEvent,
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpListenerHandle,
  RuntimeKernelHttpListenOptions,
  RuntimeKernelHttpRequest,
  RuntimeKernelHttpResponse,
  RuntimeProjectCommandRequest,
} from '../../harness-core/src/runtime-project';
import { javaTraceHooksEventsToRuntimeTrace } from '../../harness-core/src/trace-adapters/java';
import { createEmptyRuntimeTrace, type RuntimeTrace } from '../../harness-core/src/runtime-trace';
import { logRuntimeDiagnostic } from './runtime-diagnostics';
import { createWorkerProtocolToken } from './worker-protocol';

type MessageId = string;
export type JavaExecutionStyle = 'function' | 'solution-method' | 'ops-class';

export interface JavaWorkerClientOptions {
  workerUrl: string;
  debug?: boolean;
  workerIdleTimeoutMs?: number;
}

interface PendingMessage {
  protocolToken: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onEvent?: RuntimeCommandEventHandler;
  kernelHttp?: RuntimeKernelHttpBridge;
  httpServers?: Map<string, JavaHttpServerBridge>;
  timeoutId?: ReturnType<typeof setTimeout>;
}

interface JavaHttpServerQueueEntry {
  request: RuntimeKernelHttpRequest;
  resolve: (response: RuntimeKernelHttpResponse) => void;
  abortListener?: () => void;
}

interface JavaHttpServerBridge {
  handle: RuntimeKernelHttpListenerHandle;
  requestBuffer: SharedArrayBuffer;
  active: boolean;
  closed: boolean;
  queue: JavaHttpServerQueueEntry[];
}

function createExecutionAbortError(): Error {
  return Object.assign(new Error('Execution aborted'), { name: 'AbortError' });
}

interface WorkerMessage {
  id?: MessageId;
  type: string;
  payload?: unknown;
  protocolToken?: string;
}

interface InitResult {
  success: boolean;
  loadTimeMs: number;
  timings?: RuntimeExecutionTimings;
}

interface WarmupResult {
  success: boolean;
  loadTimeMs: number;
  timings?: RuntimeExecutionTimings;
}

export interface JavaWorkerRawTraceResult {
  success: boolean;
  output?: unknown;
  events: string[];
  sourceText?: string;
  executionTimeMs: number;
  error?: string;
  errorLine?: number;
  consoleOutput: string[];
  traceLimitExceeded?: boolean;
  timeoutReason?: 'trace-limit';
  droppedEventCount?: number;
  timings?: RuntimeExecutionTimings;
}

export interface JavaWorkerTraceResult extends JavaWorkerRawTraceResult {
  trace: RuntimeTrace;
}

interface JavaWorkerCodeResult {
  success: boolean;
  output?: unknown;
  executionTimeMs?: number;
  error?: string;
  errorLine?: number;
  consoleOutput?: string[];
  timings?: RuntimeExecutionTimings;
}

export type JavaWorkerProjectRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;
export type JavaWorkerProjectResult = RuntimeCommandResult;

export interface JavaTraceExecutionOptions {
  maxTraceSteps?: number;
  maxLineEvents?: number;
  maxSingleLineHits?: number;
  maxStoredEvents?: number;
  maxPathDepth?: number;
  minimalTrace?: boolean;
}

const EXECUTION_TIMEOUT_MS = 20_000;
const TRACING_TIMEOUT_MS = 25_000;
const INIT_TIMEOUT_MS = 120_000;
const MESSAGE_TIMEOUT_MS = 30_000;
const WORKER_READY_TIMEOUT_MS = 10_000;
const JAVA_DEFAULT_FILE = 'solution.java';
const JAVA_HTTP_SYNC_HEADER_BYTES = 8;
const JAVA_HTTP_SYNC_STATE_INDEX = 0;
const JAVA_HTTP_SYNC_LENGTH_INDEX = 1;
const JAVA_HTTP_SYNC_IDLE = 0;
const JAVA_HTTP_SYNC_REQUEST = 1;
const JAVA_HTTP_SYNC_RESPONSE = 2;
const JAVA_HTTP_SYNC_CLOSED = 3;
const JAVA_HTTP_SERVER_MAX_QUEUED_REQUESTS = 16;

function javaHttpBase64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function javaHttpBase64FromString(value: string): string {
  return javaHttpBase64FromBytes(new TextEncoder().encode(value));
}

function javaHttpStringFromBase64(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function javaHttpResponseManifest(response: RuntimeKernelHttpResponse): string {
  const status = Number.isFinite(response.status) ? Math.trunc(response.status) : 500;
  const rawHeaders =
    response.rawHeaders && response.rawHeaders.length > 0
      ? response.rawHeaders
      : Object.entries(response.headers ?? {});
  const headerLines = rawHeaders.map(([name, value]) => (
    `${javaHttpBase64FromString(String(name))}\t${javaHttpBase64FromString(String(value))}`
  ));
  const body = response.body ?? '';
  const bodyBase64 = response.bodyEncoding === 'base64'
    ? body
    : javaHttpBase64FromString(body);
  return ['OK', String(status), String(headerLines.length), ...headerLines, bodyBase64].join('\n');
}

function javaHttpErrorManifest(message: string): string {
  return ['ERROR', javaHttpBase64FromString(message)].join('\n');
}

function javaHttpRequestManifest(request: RuntimeKernelHttpRequest): string {
  const rawHeaders =
    request.rawHeaders && request.rawHeaders.length > 0
      ? request.rawHeaders
      : Object.entries(request.headers ?? {});
  const headerLines = rawHeaders.map(([name, value]) => (
    `${javaHttpBase64FromString(String(name))}\t${javaHttpBase64FromString(String(value))}`
  ));
  const body = request.body ?? '';
  const bodyBase64 = request.bodyEncoding === 'base64'
    ? body
    : javaHttpBase64FromString(body);
  return [
    'REQUEST',
    javaHttpBase64FromString(request.method),
    javaHttpBase64FromString(request.url),
    javaHttpBase64FromString(request.path),
    String(headerLines.length),
    ...headerLines,
    bodyBase64,
  ].join('\n');
}

function javaHttpResponseFromManifest(manifest: string): RuntimeKernelHttpResponse {
  const lines = manifest.split('\n');
  if (lines[0] === 'ERROR') {
    return {
      status: 500,
      headers: { 'content-type': 'text/plain' },
      body: `${lines[1] ? javaHttpStringFromBase64(lines[1]) : 'Java HTTP server request failed'}\n`,
    };
  }
  if (lines[0] !== 'OK' || lines.length < 4) {
    return { status: 500, headers: { 'content-type': 'text/plain' }, body: 'Invalid Java HTTP server response\n' };
  }
  const status = Number.parseInt(lines[1] ?? '', 10);
  const headerCount = Number.parseInt(lines[2] ?? '', 10);
  if (!Number.isFinite(status) || !Number.isFinite(headerCount) || headerCount < 0 || lines.length < 4 + headerCount) {
    return { status: 500, headers: { 'content-type': 'text/plain' }, body: 'Invalid Java HTTP server response\n' };
  }
  const rawHeaders: [string, string][] = [];
  const headers: Record<string, string> = {};
  for (let index = 0; index < headerCount; index += 1) {
    const [encodedName, encodedValue] = (lines[3 + index] ?? '').split('\t');
    if (!encodedName || encodedValue === undefined) continue;
    const name = javaHttpStringFromBase64(encodedName);
    const value = javaHttpStringFromBase64(encodedValue);
    rawHeaders.push([name, value]);
    headers[name] = value;
  }
  return {
    status,
    headers,
    rawHeaders,
    body: lines[3 + headerCount] ?? '',
    bodyEncoding: 'base64',
  };
}

function writeJavaHttpSyncManifest(buffer: SharedArrayBuffer, manifest: string): void {
  const header = new Int32Array(buffer, 0, 2);
  const bytes = new Uint8Array(buffer, JAVA_HTTP_SYNC_HEADER_BYTES);
  const encoded = new TextEncoder().encode(manifest);
  if (encoded.byteLength > bytes.byteLength) {
    const overflow = new TextEncoder().encode(javaHttpErrorManifest('TraceKernel HTTP response exceeded Java bridge buffer capacity'));
    bytes.set(overflow.subarray(0, bytes.byteLength));
    Atomics.store(header, JAVA_HTTP_SYNC_LENGTH_INDEX, Math.min(overflow.byteLength, bytes.byteLength));
  } else {
    bytes.set(encoded);
    Atomics.store(header, JAVA_HTTP_SYNC_LENGTH_INDEX, encoded.byteLength);
  }
  Atomics.store(header, JAVA_HTTP_SYNC_STATE_INDEX, 1);
  Atomics.notify(header, JAVA_HTTP_SYNC_STATE_INDEX);
}

export class JavaWorkerClient {
  private worker: Worker | null = null;
  private pendingMessages = new Map<MessageId, PendingMessage>();
  private messageId = 0;
  private isInitializing = false;
  private initPromise: Promise<InitResult> | null = null;
  private warmupPromise: Promise<WarmupResult> | null = null;
  private workerReadyPromise: Promise<void> | null = null;
  private workerReadyResolve: (() => void) | null = null;
  private workerReadyReject: ((error: Error) => void) | null = null;
  private readonly debug: boolean;

  constructor(private readonly options: JavaWorkerClientOptions) {
    this.debug = options.debug ?? process.env.NODE_ENV === 'development';
  }

  isSupported(): boolean {
    return typeof Worker !== 'undefined';
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;

    if (!this.isSupported()) {
      throw new Error('Web Workers are not supported in this environment');
    }

    this.workerReadyPromise = new Promise((resolve, reject) => {
      this.workerReadyResolve = resolve;
      this.workerReadyReject = (error: Error) => reject(error);
    });

    const workerUrl =
      this.debug && !this.options.workerUrl.includes('?')
        ? `${this.options.workerUrl}?dev=${Date.now()}`
        : this.options.workerUrl;

    this.worker = new Worker(workerUrl);
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const { id, type, payload, protocolToken } = event.data;

      if (type === 'worker-ready') {
        this.workerReadyResolve?.();
        this.workerReadyResolve = null;
        this.workerReadyReject = null;
        logRuntimeDiagnostic('info', {
          component: 'JavaWorkerClient',
          runtime: 'java',
          phase: 'worker-ready',
          message: 'Java worker is ready.',
        }, { enabled: this.debug });
        return;
      }

      if (type === 'idle-timeout') {
        logRuntimeDiagnostic('info', {
          component: 'JavaWorkerClient',
          runtime: 'java',
          phase: 'idle-timeout',
          message: 'Java worker closed after idle timeout.',
        }, { enabled: this.debug });
        this.terminateAndReset(new Error('Java worker closed after idle timeout'));
        return;
      }

      if (!id) return;
      const pending = this.pendingMessages.get(id);
      if (!pending) return;
      if (protocolToken !== pending.protocolToken) return;
      if (type === 'project-event') {
        pending.onEvent?.(payload as RuntimeCommandEvent);
        return;
      }
      if (type === 'kernel-http-dispatch-sync') {
        this.handleKernelHttpDispatchSync(id, payload);
        return;
      }
      if (type === 'kernel-http-listen-sync') {
        this.handleKernelHttpListenSync(id, payload);
        return;
      }
      if (type === 'kernel-http-close') {
        this.handleKernelHttpClose(id, payload);
        return;
      }
      this.pendingMessages.delete(id);
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
      this.closePendingHttpListeners(pending);

      if (type === 'error') {
        pending.reject(new Error((payload as { error: string }).error));
        return;
      }

      pending.resolve(payload);
    };

    this.worker.onerror = (error) => {
      logRuntimeDiagnostic('error', {
        component: 'JavaWorkerClient',
        runtime: 'java',
        phase: 'worker-error',
        message: 'Java worker emitted an error event.',
        detail: {
          message: error.message,
          filename: error.filename,
          lineno: error.lineno,
          colno: error.colno,
        },
      });
      const workerError = new Error(error.message || 'Java worker error');
      this.workerReadyReject?.(workerError);
      this.workerReadyResolve = null;
      this.workerReadyReject = null;
      for (const [, pending] of this.pendingMessages) {
        if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
        this.closePendingHttpListeners(pending);
        pending.reject(workerError);
      }
      this.pendingMessages.clear();
      this.terminateAndReset(workerError);
    };

    return this.worker;
  }

  private async waitForWorkerReady(): Promise<void> {
    const readyPromise = this.workerReadyPromise;
    if (!readyPromise) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutId = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        const timeoutError = new Error(
          `Java worker failed to initialize in time (${Math.round(WORKER_READY_TIMEOUT_MS / 1000)}s)`
        );
        logRuntimeDiagnostic('warn', {
          component: 'JavaWorkerClient',
          runtime: 'java',
          phase: 'worker-ready-timeout',
          message: 'Java worker did not send worker-ready before the timeout.',
          detail: { timeoutMs: WORKER_READY_TIMEOUT_MS },
        }, { enabled: this.debug });
        this.terminateAndReset(timeoutError);
        reject(timeoutError);
      }, WORKER_READY_TIMEOUT_MS);

      readyPromise
        .then(() => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeoutId);
          resolve();
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeoutId);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private async sendMessage<T>(
    type: string,
    payload?: unknown,
    timeoutMs = MESSAGE_TIMEOUT_MS,
    onEvent?: RuntimeCommandEventHandler,
    kernelHttp?: RuntimeKernelHttpBridge
  ): Promise<T> {
    const worker = this.getWorker();
    await this.waitForWorkerReady();
    const id = String(++this.messageId);
    const protocolToken = createWorkerProtocolToken();

    return new Promise<T>((resolve, reject) => {
      this.pendingMessages.set(id, {
        protocolToken,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(onEvent ? { onEvent } : {}),
        ...(kernelHttp ? { kernelHttp } : {}),
        httpServers: new Map(),
      });

      const timeoutId = globalThis.setTimeout(() => {
        const pending = this.pendingMessages.get(id);
        if (!pending) return;
        this.pendingMessages.delete(id);
        this.closePendingHttpListeners(pending);
        logRuntimeDiagnostic('warn', {
          component: 'JavaWorkerClient',
          runtime: 'java',
          phase: 'worker-request-timeout',
          message: 'Java worker request timed out.',
          detail: { id, type, timeoutMs },
        }, { enabled: this.debug });
        pending.reject(new Error(`Worker request timed out: ${type}`));
      }, timeoutMs);

      const pending = this.pendingMessages.get(id);
      if (pending) pending.timeoutId = timeoutId;

      worker.postMessage({ id, type, payload, protocolToken });
    });
  }

  private closePendingHttpListeners(pending: PendingMessage): void {
    for (const [, bridge] of pending.httpServers ?? []) {
      this.closeJavaHttpServerBridge(bridge);
    }
    pending.httpServers?.clear();
  }

  private handleKernelHttpDispatchSync(commandId: MessageId, payload: unknown): void {
    const pending = this.pendingMessages.get(commandId);
    if (!pending) return;
    const { request, buffer } = (payload ?? {}) as {
      request?: RuntimeKernelHttpRequest;
      buffer?: SharedArrayBuffer;
      timeoutMs?: number;
    };
    if (typeof SharedArrayBuffer === 'undefined' || !(buffer instanceof SharedArrayBuffer)) return;
    if (!pending.kernelHttp) {
      writeJavaHttpSyncManifest(buffer, javaHttpErrorManifest('TraceKernel HTTP is not available for this Java command'));
      return;
    }
    if (!request || typeof request !== 'object') {
      writeJavaHttpSyncManifest(buffer, javaHttpErrorManifest('Invalid Java TraceKernel HTTP request'));
      return;
    }
    const timeoutMs = Number((payload as { timeoutMs?: unknown } | undefined)?.timeoutMs);
    pending.kernelHttp.dispatch(request, {
      ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
    })
      .then((response) => {
        writeJavaHttpSyncManifest(buffer, javaHttpResponseManifest(response));
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        writeJavaHttpSyncManifest(buffer, javaHttpErrorManifest(message || 'TraceKernel HTTP request failed'));
      });
  }

  private handleKernelHttpListenSync(commandId: MessageId, payload: unknown): void {
    const pending = this.pendingMessages.get(commandId);
    if (!pending) return;
    const { serverId, options, requestBuffer, controlBuffer } = (payload ?? {}) as {
      serverId?: string;
      options?: RuntimeKernelHttpListenOptions;
      requestBuffer?: SharedArrayBuffer;
      controlBuffer?: SharedArrayBuffer;
    };
    if (!serverId || !options || typeof SharedArrayBuffer === 'undefined' || !(requestBuffer instanceof SharedArrayBuffer) || !(controlBuffer instanceof SharedArrayBuffer)) {
      if (controlBuffer instanceof SharedArrayBuffer) {
        writeJavaHttpSyncManifest(controlBuffer, javaHttpErrorManifest('Invalid Java TraceKernel HTTP listener registration'));
      }
      return;
    }
    if (!pending.kernelHttp) {
      writeJavaHttpSyncManifest(controlBuffer, javaHttpErrorManifest('TraceKernel HTTP is not available for this Java command'));
      return;
    }
    try {
      const bridge: JavaHttpServerBridge = {
        handle: undefined as unknown as RuntimeKernelHttpListenerHandle,
        requestBuffer,
        active: false,
        closed: false,
        queue: [],
      };
      const handle = pending.kernelHttp.listen(options, (request) => this.enqueueJavaHttpServerRequest(bridge, request));
      bridge.handle = handle;
      pending.httpServers?.set(serverId, bridge);
      writeJavaHttpSyncManifest(controlBuffer, ['OK', javaHttpBase64FromString(JSON.stringify(handle.info))].join('\n'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJavaHttpSyncManifest(controlBuffer, javaHttpErrorManifest(message || 'Unable to register Java TraceKernel HTTP listener'));
    }
  }

  private handleKernelHttpClose(commandId: MessageId, payload: unknown): void {
    const pending = this.pendingMessages.get(commandId);
    if (!pending) return;
    const { serverId, requestBuffer } = (payload ?? {}) as {
      serverId?: string;
      requestBuffer?: SharedArrayBuffer;
    };
    if (serverId) {
      const bridge = pending.httpServers?.get(serverId);
      if (bridge) this.closeJavaHttpServerBridge(bridge);
      pending.httpServers?.delete(serverId);
    }
    if (typeof SharedArrayBuffer !== 'undefined' && requestBuffer instanceof SharedArrayBuffer) {
      const header = new Int32Array(requestBuffer, 0, 2);
      Atomics.store(header, JAVA_HTTP_SYNC_STATE_INDEX, JAVA_HTTP_SYNC_CLOSED);
      Atomics.notify(header, JAVA_HTTP_SYNC_STATE_INDEX);
    }
  }

  private closeJavaHttpServerBridge(bridge: JavaHttpServerBridge): void {
    if (bridge.closed) return;
    bridge.closed = true;
    bridge.handle.close();
    const header = new Int32Array(bridge.requestBuffer, 0, 2);
    Atomics.store(header, JAVA_HTTP_SYNC_STATE_INDEX, JAVA_HTTP_SYNC_CLOSED);
    Atomics.notify(header, JAVA_HTTP_SYNC_STATE_INDEX);
    const queued = bridge.queue.splice(0);
    for (const entry of queued) {
      if (entry.abortListener) entry.request.signal?.removeEventListener?.('abort', entry.abortListener);
      entry.resolve({
        status: 503,
        headers: { 'content-type': 'text/plain' },
        body: 'Java TraceKernel HTTP server closed\n',
      });
    }
  }

  private enqueueJavaHttpServerRequest(
    bridge: JavaHttpServerBridge,
    request: RuntimeKernelHttpRequest
  ): Promise<RuntimeKernelHttpResponse> {
    if (bridge.closed) {
      return Promise.resolve({
        status: 503,
        headers: { 'content-type': 'text/plain' },
        body: 'Java TraceKernel HTTP server closed\n',
      });
    }
    if (bridge.queue.length >= JAVA_HTTP_SERVER_MAX_QUEUED_REQUESTS) {
      return Promise.resolve({
        status: 503,
        headers: { 'content-type': 'text/plain' },
        body: 'Java TraceKernel HTTP server queue is full\n',
      });
    }
    return new Promise<RuntimeKernelHttpResponse>((resolve) => {
      const entry: JavaHttpServerQueueEntry = { request, resolve };
      if (request.signal) {
        entry.abortListener = () => {
          const index = bridge.queue.indexOf(entry);
          if (index >= 0) bridge.queue.splice(index, 1);
          request.signal?.removeEventListener?.('abort', entry.abortListener!);
          resolve({
            status: 0,
            headers: { 'content-type': 'text/plain' },
            body: 'TraceKernel HTTP request aborted\n',
          });
        };
        request.signal.addEventListener?.('abort', entry.abortListener, { once: true });
        if (request.signal.aborted) {
          entry.abortListener();
          return;
        }
      }
      bridge.queue.push(entry);
      this.drainJavaHttpServerQueue(bridge);
    });
  }

  private drainJavaHttpServerQueue(bridge: JavaHttpServerBridge): void {
    if (bridge.active || bridge.closed) return;
    const entry = bridge.queue.shift();
    if (!entry) return;
    if (entry.abortListener) entry.request.signal?.removeEventListener?.('abort', entry.abortListener);
    bridge.active = true;
    this.dispatchJavaHttpServerRequest(bridge, entry.request)
      .then(entry.resolve)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        entry.resolve({
          status: 500,
          headers: { 'content-type': 'text/plain' },
          body: `${message || 'Java TraceKernel HTTP server request failed'}\n`,
        });
      })
      .finally(() => {
        bridge.active = false;
        this.drainJavaHttpServerQueue(bridge);
      });
  }

  private dispatchJavaHttpServerRequest(bridge: JavaHttpServerBridge, request: RuntimeKernelHttpRequest): Promise<RuntimeKernelHttpResponse> {
    const buffer = bridge.requestBuffer;
    const header = new Int32Array(buffer, 0, 2);
    const bytes = new Uint8Array(buffer, JAVA_HTTP_SYNC_HEADER_BYTES);
    if (Atomics.load(header, JAVA_HTTP_SYNC_STATE_INDEX) !== JAVA_HTTP_SYNC_IDLE) {
      return Promise.resolve({
        status: 503,
        headers: { 'content-type': 'text/plain' },
        body: 'Java TraceKernel HTTP server buffer is not idle\n',
      });
    }
    const encoded = new TextEncoder().encode(javaHttpRequestManifest(request));
    if (encoded.byteLength > bytes.byteLength) {
      return Promise.resolve({
        status: 413,
        headers: { 'content-type': 'text/plain' },
        body: 'TraceKernel HTTP request exceeded Java bridge buffer capacity\n',
      });
    }
    bytes.set(encoded);
    Atomics.store(header, JAVA_HTTP_SYNC_LENGTH_INDEX, encoded.byteLength);
    Atomics.store(header, JAVA_HTTP_SYNC_STATE_INDEX, JAVA_HTTP_SYNC_REQUEST);
    Atomics.notify(header, JAVA_HTTP_SYNC_STATE_INDEX);

    return new Promise((resolve) => {
      let settled = false;
      let abortListener: (() => void) | undefined;
      const settle = (response: RuntimeKernelHttpResponse): void => {
        if (settled) return;
        settled = true;
        if (abortListener) request.signal?.removeEventListener?.('abort', abortListener);
        resolve(response);
      };
      if (request.signal) {
        abortListener = () => {
          this.closeJavaHttpServerBridge(bridge);
          settle({
            status: 0,
            headers: { 'content-type': 'text/plain' },
            body: 'TraceKernel HTTP request aborted\n',
          });
        };
        request.signal.addEventListener?.('abort', abortListener, { once: true });
        if (request.signal.aborted) {
          abortListener();
          return;
        }
      }
      const poll = () => {
        if (settled) return;
        const state = Atomics.load(header, JAVA_HTTP_SYNC_STATE_INDEX);
        if (state === JAVA_HTTP_SYNC_RESPONSE) {
          const length = Atomics.load(header, JAVA_HTTP_SYNC_LENGTH_INDEX);
          const manifest = new TextDecoder().decode(bytes.subarray(0, Math.max(0, Math.min(length, bytes.byteLength))));
          Atomics.store(header, JAVA_HTTP_SYNC_LENGTH_INDEX, 0);
          Atomics.store(header, JAVA_HTTP_SYNC_STATE_INDEX, JAVA_HTTP_SYNC_IDLE);
          Atomics.notify(header, JAVA_HTTP_SYNC_STATE_INDEX);
          settle(javaHttpResponseFromManifest(manifest));
          return;
        }
        if (state === JAVA_HTTP_SYNC_CLOSED) {
          settle({
            status: 503,
            headers: { 'content-type': 'text/plain' },
            body: 'Java TraceKernel HTTP server closed\n',
          });
          return;
        }
        globalThis.setTimeout(poll, 1);
      };
      poll();
    });
  }

  private async executeWithTimeout<T>(executor: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      const abortError = createExecutionAbortError();
      this.terminateAndReset(abortError);
      throw abortError;
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        globalThis.clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        const abortError = createExecutionAbortError();
        this.terminateAndReset(abortError);
        settleReject(abortError);
      };
      const timeoutId = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        logRuntimeDiagnostic('warn', {
          component: 'JavaWorkerClient',
          runtime: 'java',
          phase: 'execution-timeout',
          message: 'Java execution timed out; terminating worker.',
          detail: { timeoutMs },
        }, { enabled: this.debug });
        this.terminateAndReset();
        reject(
          new Error(
            `Java execution timed out after ${Math.round(timeoutMs / 1000)} seconds.`
          )
        );
      }, timeoutMs);

      signal?.addEventListener('abort', onAbort, { once: true });

      executor()
        .then((result) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        })
        .catch((error) => {
          settleReject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private terminateAndReset(reason: Error = new Error('Worker was terminated')): void {
    this.workerReadyReject?.(reason);
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initPromise = null;
    this.warmupPromise = null;
    this.isInitializing = false;
    this.workerReadyPromise = null;
    this.workerReadyResolve = null;
    this.workerReadyReject = null;

    for (const [, pending] of this.pendingMessages) {
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
      pending.reject(reason);
    }
    this.pendingMessages.clear();
  }

  async init(): Promise<InitResult> {
    if (this.initPromise) return this.initPromise;
    if (this.isInitializing) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
      return this.init();
    }

    this.isInitializing = true;
    this.initPromise = (async () => {
      try {
        return await this.sendMessage<InitResult>('init', this.workerOptionsPayload(), INIT_TIMEOUT_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const shouldRetry =
          message.includes('Worker request timed out: init') ||
          message.includes('Worker was terminated') ||
          message.includes('Java worker error') ||
          message.includes('failed to initialize in time');

        if (!shouldRetry) {
          throw error;
        }

        logRuntimeDiagnostic('warn', {
          component: 'JavaWorkerClient',
          runtime: 'java',
          phase: 'init-retry',
          message: 'Java worker init failed; resetting worker and retrying once.',
          detail: { message },
        }, { enabled: this.debug });

        this.terminateAndReset(error instanceof Error ? error : new Error(message));
        return this.sendMessage<InitResult>('init', this.workerOptionsPayload(), INIT_TIMEOUT_MS);
      }
    })();
    try {
      return await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  private workerOptionsPayload(): { idleTimeoutMs?: number } {
    return this.options.workerIdleTimeoutMs === undefined
      ? {}
      : { idleTimeoutMs: this.options.workerIdleTimeoutMs };
  }

  async warmup(): Promise<WarmupResult> {
    if (this.warmupPromise) return this.warmupPromise;
    this.warmupPromise = (async () => {
      try {
        await this.init();
        return await this.sendMessage<WarmupResult>(
          'warmup',
          this.workerOptionsPayload(),
          INIT_TIMEOUT_MS
        );
      } catch (error) {
        this.warmupPromise = null;
        throw error;
      }
    })();
    return this.warmupPromise;
  }

  async executeWithTracing(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options: JavaTraceExecutionOptions | undefined,
    executionStyle: JavaExecutionStyle
  ): Promise<JavaWorkerTraceResult> {
    await this.init();
    const result = await this.executeWithTimeout(
      () =>
        this.sendMessage<JavaWorkerRawTraceResult>(
          'execute-with-tracing',
          { code, functionName, inputs, options, executionStyle },
          TRACING_TIMEOUT_MS + 5_000
        ),
      TRACING_TIMEOUT_MS
    );
    return {
      ...result,
      trace: result.success
        ? javaTraceHooksEventsToRuntimeTrace(result.events, result.sourceText, {
            runId: 'java:run',
            file: JAVA_DEFAULT_FILE,
            maxPathDepth: options?.maxPathDepth,
          })
        : createEmptyRuntimeTrace('java', { runId: 'java:run', file: JAVA_DEFAULT_FILE }),
    };
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options: JavaTraceExecutionOptions | undefined,
    executionStyle: JavaExecutionStyle
  ): Promise<CodeExecutionResult> {
    return this.executeCodeMessage('execute-code', code, functionName, inputs, options, executionStyle);
  }

  async executeCodeBatch(
    code: string,
    functionName: string,
    inputBatch: Record<string, unknown>[],
    options: JavaTraceExecutionOptions | undefined,
    executionStyle: JavaExecutionStyle
  ): Promise<CodeExecutionBatchResult> {
    await this.init();
    return this.executeWithTimeout(
      () =>
        this.sendMessage<CodeExecutionBatchResult>(
          'execute-code-batch',
          { code, functionName, inputBatch, options, executionStyle },
          EXECUTION_TIMEOUT_MS + 5_000
        ),
      EXECUTION_TIMEOUT_MS
    );
  }

  private async executeCodeMessage(
    type: 'execute-code' | 'execute-code-interview',
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options: JavaTraceExecutionOptions | undefined,
    executionStyle: JavaExecutionStyle
  ): Promise<CodeExecutionResult> {
    await this.init();
    const result = await this.executeWithTimeout(
      () =>
        this.sendMessage<JavaWorkerCodeResult>(
          type,
          { code, functionName, inputs, options, executionStyle },
          EXECUTION_TIMEOUT_MS + 5_000
        ),
      EXECUTION_TIMEOUT_MS
    );
    if (!result.success) {
      return {
        success: false,
        output: null,
        error: result.error ?? 'Java execution failed',
        ...(result.errorLine !== undefined ? { errorLine: result.errorLine } : {}),
        consoleOutput: result.consoleOutput ?? [],
        timings: result.timings,
      };
    }
    return {
      success: true,
      output: result.output,
      consoleOutput: result.consoleOutput ?? [],
      timings: result.timings,
    };
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options: JavaTraceExecutionOptions | undefined,
    executionStyle: JavaExecutionStyle
  ): Promise<CodeExecutionResult> {
    return this.executeCodeMessage('execute-code-interview', code, functionName, inputs, options, executionStyle);
  }

  async executeProjectJava(
    request: JavaWorkerProjectRequest,
    timeoutMs = EXECUTION_TIMEOUT_MS,
    onEvent?: RuntimeCommandEventHandler,
    signal: AbortSignal | undefined = request.signal
  ): Promise<JavaWorkerProjectResult> {
    if (signal?.aborted) {
      const abortError = createExecutionAbortError();
      this.terminateAndReset(abortError);
      throw abortError;
    }
    const abortInit = () => this.terminateAndReset(createExecutionAbortError());
    signal?.addEventListener('abort', abortInit, { once: true });
    try {
      await this.init();
    } finally {
      signal?.removeEventListener('abort', abortInit);
    }
    const { signal: _signal, onEvent: _requestOnEvent, kernelHttp, ...workerRequest } = request;
    return this.executeWithTimeout(
      () =>
        this.sendMessage<JavaWorkerProjectResult>(
          'execute-project-java',
          workerRequest,
          timeoutMs + 5_000,
          onEvent,
          kernelHttp
        ),
      timeoutMs,
      signal
    );
  }

  terminate(): void {
    this.terminateAndReset();
  }
}

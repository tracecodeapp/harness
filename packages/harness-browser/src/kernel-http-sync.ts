/**
 * Shared client-side bridge for the synchronous TraceKernel HTTP worker protocol.
 *
 * Runtimes whose user code executes synchronously on the worker thread (Java via
 * CheerpJ, C++ via WASI) cannot await async host responses. Instead the worker
 * posts `kernel-http-dispatch-sync` / `kernel-http-listen-sync` messages carrying
 * SharedArrayBuffers and blocks on Atomics.wait; the client services the request
 * through the command's RuntimeKernelHttpBridge and writes a manifest back into
 * the buffer. Manifests are newline-delimited with base64-encoded fields so both
 * sides can parse them without a JSON dependency.
 */

import type {
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpListenOptions,
  RuntimeKernelHttpListenerHandle,
  RuntimeKernelHttpRequest,
  RuntimeKernelHttpResponse,
} from '@tracecode/harness-core';

export const KERNEL_HTTP_SYNC_HEADER_BYTES = 8;
export const KERNEL_HTTP_SYNC_STATE_INDEX = 0;
export const KERNEL_HTTP_SYNC_LENGTH_INDEX = 1;
export const KERNEL_HTTP_SYNC_IDLE = 0;
export const KERNEL_HTTP_SYNC_REQUEST = 1;
export const KERNEL_HTTP_SYNC_RESPONSE = 2;
export const KERNEL_HTTP_SYNC_CLOSED = 3;
export const KERNEL_HTTP_SYNC_MAX_QUEUED_REQUESTS = 16;

function kernelHttpBase64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function kernelHttpBase64FromString(value: string): string {
  return kernelHttpBase64FromBytes(new TextEncoder().encode(value));
}

export function kernelHttpStringFromBase64(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

export function kernelHttpResponseManifest(response: RuntimeKernelHttpResponse): string {
  const status = Number.isFinite(response.status) ? Math.trunc(response.status) : 500;
  const rawHeaders =
    response.rawHeaders && response.rawHeaders.length > 0
      ? response.rawHeaders
      : Object.entries(response.headers ?? {});
  const headerLines = rawHeaders.map(([name, value]) => (
    `${kernelHttpBase64FromString(String(name))}\t${kernelHttpBase64FromString(String(value))}`
  ));
  const body = response.body ?? '';
  const bodyBase64 = response.bodyEncoding === 'base64'
    ? body
    : kernelHttpBase64FromString(body);
  return ['OK', String(status), String(headerLines.length), ...headerLines, bodyBase64].join('\n');
}

export function kernelHttpErrorManifest(message: string): string {
  return ['ERROR', kernelHttpBase64FromString(message)].join('\n');
}

export function kernelHttpRequestManifest(request: RuntimeKernelHttpRequest): string {
  const rawHeaders =
    request.rawHeaders && request.rawHeaders.length > 0
      ? request.rawHeaders
      : Object.entries(request.headers ?? {});
  const headerLines = rawHeaders.map(([name, value]) => (
    `${kernelHttpBase64FromString(String(name))}\t${kernelHttpBase64FromString(String(value))}`
  ));
  const body = request.body ?? '';
  const bodyBase64 = request.bodyEncoding === 'base64'
    ? body
    : kernelHttpBase64FromString(body);
  return [
    'REQUEST',
    kernelHttpBase64FromString(request.method),
    kernelHttpBase64FromString(request.url),
    kernelHttpBase64FromString(request.path),
    String(headerLines.length),
    ...headerLines,
    bodyBase64,
  ].join('\n');
}

export function kernelHttpResponseFromManifest(manifest: string, runtimeLabel: string): RuntimeKernelHttpResponse {
  const lines = manifest.split('\n');
  if (lines[0] === 'ERROR') {
    return {
      status: 500,
      headers: { 'content-type': 'text/plain' },
      body: `${lines[1] ? kernelHttpStringFromBase64(lines[1]) : `${runtimeLabel} HTTP server request failed`}\n`,
    };
  }
  if (lines[0] !== 'OK' || lines.length < 4) {
    return { status: 500, headers: { 'content-type': 'text/plain' }, body: `Invalid ${runtimeLabel} HTTP server response\n` };
  }
  const status = Number.parseInt(lines[1] ?? '', 10);
  const headerCount = Number.parseInt(lines[2] ?? '', 10);
  if (!Number.isFinite(status) || !Number.isFinite(headerCount) || headerCount < 0 || lines.length < 4 + headerCount) {
    return { status: 500, headers: { 'content-type': 'text/plain' }, body: `Invalid ${runtimeLabel} HTTP server response\n` };
  }
  const rawHeaders: [string, string][] = [];
  const headers: Record<string, string> = {};
  for (let index = 0; index < headerCount; index += 1) {
    const [encodedName, encodedValue] = (lines[3 + index] ?? '').split('\t');
    if (!encodedName || encodedValue === undefined) continue;
    const name = kernelHttpStringFromBase64(encodedName);
    const value = kernelHttpStringFromBase64(encodedValue);
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

export function writeKernelHttpSyncManifest(buffer: SharedArrayBuffer, manifest: string, runtimeLabel: string): void {
  const header = new Int32Array(buffer, 0, 2);
  const bytes = new Uint8Array(buffer, KERNEL_HTTP_SYNC_HEADER_BYTES);
  const encoded = new TextEncoder().encode(manifest);
  if (encoded.byteLength > bytes.byteLength) {
    const overflow = new TextEncoder().encode(
      kernelHttpErrorManifest(`${runtimeLabel} network response exceeded buffer capacity`)
    );
    bytes.set(overflow.subarray(0, bytes.byteLength));
    Atomics.store(header, KERNEL_HTTP_SYNC_LENGTH_INDEX, Math.min(overflow.byteLength, bytes.byteLength));
  } else {
    bytes.set(encoded);
    Atomics.store(header, KERNEL_HTTP_SYNC_LENGTH_INDEX, encoded.byteLength);
  }
  // The waiting worker only requires a transition away from 0 (idle); the Java
  // worker shipped with 1 here, so keep the wire value stable.
  Atomics.store(header, KERNEL_HTTP_SYNC_STATE_INDEX, 1);
  Atomics.notify(header, KERNEL_HTTP_SYNC_STATE_INDEX);
}

interface KernelHttpSyncQueueEntry {
  request: RuntimeKernelHttpRequest;
  resolve: (response: RuntimeKernelHttpResponse) => void;
  abortListener?: () => void;
}

export interface KernelHttpSyncServerBridge {
  handle: RuntimeKernelHttpListenerHandle;
  requestBuffer: SharedArrayBuffer;
  active: boolean;
  closed: boolean;
  queue: KernelHttpSyncQueueEntry[];
}

/** The subset of a client's pending-command state that the sync bridge operates on. */
export interface KernelHttpSyncPending {
  kernelHttp?: RuntimeKernelHttpBridge;
  httpServers?: Map<string, KernelHttpSyncServerBridge>;
}

// A worker can write a RESPONSE and close (or exit) before the in-flight
// dispatch poll has read it. Let that response drain before marking the
// buffer closed; force-close after ~2s if nobody consumes it.
function markKernelHttpSyncBufferClosed(buffer: SharedArrayBuffer, attempt = 0): void {
  const header = new Int32Array(buffer, 0, 2);
  if (attempt < 2_000 && Atomics.load(header, KERNEL_HTTP_SYNC_STATE_INDEX) === KERNEL_HTTP_SYNC_RESPONSE) {
    globalThis.setTimeout(() => markKernelHttpSyncBufferClosed(buffer, attempt + 1), 1);
    return;
  }
  Atomics.store(header, KERNEL_HTTP_SYNC_STATE_INDEX, KERNEL_HTTP_SYNC_CLOSED);
  Atomics.notify(header, KERNEL_HTTP_SYNC_STATE_INDEX);
}

export function closeKernelHttpSyncServerBridge(bridge: KernelHttpSyncServerBridge, runtimeLabel: string): void {
  if (bridge.closed) return;
  bridge.closed = true;
  bridge.handle.close();
  markKernelHttpSyncBufferClosed(bridge.requestBuffer);
  const queued = bridge.queue.splice(0);
  for (const entry of queued) {
    if (entry.abortListener) entry.request.signal?.removeEventListener?.('abort', entry.abortListener);
    entry.resolve({
      status: 503,
      headers: { 'content-type': 'text/plain' },
      body: 'Service Unavailable\n',
    });
  }
}

export function closeKernelHttpSyncServers(pending: KernelHttpSyncPending, runtimeLabel: string): void {
  for (const [, bridge] of pending.httpServers ?? []) {
    closeKernelHttpSyncServerBridge(bridge, runtimeLabel);
  }
  pending.httpServers?.clear();
}

export function handleKernelHttpDispatchSyncMessage(pending: KernelHttpSyncPending, payload: unknown, runtimeLabel: string): void {
  const { request, buffer } = (payload ?? {}) as {
    request?: RuntimeKernelHttpRequest;
    buffer?: SharedArrayBuffer;
    timeoutMs?: number;
  };
  if (typeof SharedArrayBuffer === 'undefined' || !(buffer instanceof SharedArrayBuffer)) return;
  if (!pending.kernelHttp) {
    writeKernelHttpSyncManifest(
      buffer,
      kernelHttpErrorManifest('Network subsystem is unavailable'),
      runtimeLabel
    );
    return;
  }
  if (!request || typeof request !== 'object') {
    writeKernelHttpSyncManifest(
      buffer,
      kernelHttpErrorManifest(`Invalid ${runtimeLabel} network request`),
      runtimeLabel
    );
    return;
  }
  const timeoutMs = Number((payload as { timeoutMs?: unknown } | undefined)?.timeoutMs);
  pending.kernelHttp.dispatch(request, {
    ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  })
    .then((response) => {
      writeKernelHttpSyncManifest(buffer, kernelHttpResponseManifest(response), runtimeLabel);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      writeKernelHttpSyncManifest(
        buffer,
        kernelHttpErrorManifest(message || 'Network request failed'),
        runtimeLabel
      );
    });
}

export function handleKernelHttpListenSyncMessage(pending: KernelHttpSyncPending, payload: unknown, runtimeLabel: string): void {
  const { serverId, options, requestBuffer, controlBuffer } = (payload ?? {}) as {
    serverId?: string;
    options?: RuntimeKernelHttpListenOptions;
    requestBuffer?: SharedArrayBuffer;
    controlBuffer?: SharedArrayBuffer;
  };
  if (
    !serverId ||
    !options ||
    typeof SharedArrayBuffer === 'undefined' ||
    !(requestBuffer instanceof SharedArrayBuffer) ||
    !(controlBuffer instanceof SharedArrayBuffer)
  ) {
    if (controlBuffer instanceof SharedArrayBuffer) {
      writeKernelHttpSyncManifest(
        controlBuffer,
        kernelHttpErrorManifest(`Invalid ${runtimeLabel} network listener registration`),
        runtimeLabel
      );
    }
    return;
  }
  if (!pending.kernelHttp) {
    writeKernelHttpSyncManifest(
      controlBuffer,
      kernelHttpErrorManifest('Network subsystem is unavailable'),
      runtimeLabel
    );
    return;
  }
  try {
    const bridge: KernelHttpSyncServerBridge = {
      handle: undefined as unknown as RuntimeKernelHttpListenerHandle,
      requestBuffer,
      active: false,
      closed: false,
      queue: [],
    };
    const handle = pending.kernelHttp.listen(options, (request) =>
      enqueueKernelHttpSyncServerRequest(bridge, request, runtimeLabel)
    );
    bridge.handle = handle;
    pending.httpServers?.set(serverId, bridge);
    writeKernelHttpSyncManifest(
      controlBuffer,
      ['OK', kernelHttpBase64FromString(JSON.stringify(handle.info))].join('\n'),
      runtimeLabel
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeKernelHttpSyncManifest(
      controlBuffer,
      kernelHttpErrorManifest(message || `Unable to register ${runtimeLabel} network listener`),
      runtimeLabel
    );
  }
}

export function handleKernelHttpCloseMessage(pending: KernelHttpSyncPending, payload: unknown, runtimeLabel: string): void {
  const { serverId, requestBuffer } = (payload ?? {}) as {
    serverId?: string;
    requestBuffer?: SharedArrayBuffer;
  };
  if (serverId) {
    const bridge = pending.httpServers?.get(serverId);
    if (bridge) closeKernelHttpSyncServerBridge(bridge, runtimeLabel);
    pending.httpServers?.delete(serverId);
  }
  if (typeof SharedArrayBuffer !== 'undefined' && requestBuffer instanceof SharedArrayBuffer) {
    markKernelHttpSyncBufferClosed(requestBuffer);
  }
}

function enqueueKernelHttpSyncServerRequest(
  bridge: KernelHttpSyncServerBridge,
  request: RuntimeKernelHttpRequest,
  runtimeLabel: string
): Promise<RuntimeKernelHttpResponse> {
  if (bridge.closed) {
    return Promise.resolve({
      status: 503,
      headers: { 'content-type': 'text/plain' },
      body: 'Service Unavailable\n',
    });
  }
  if (bridge.queue.length >= KERNEL_HTTP_SYNC_MAX_QUEUED_REQUESTS) {
    return Promise.resolve({
      status: 503,
      headers: { 'content-type': 'text/plain' },
      body: 'Service Unavailable\n',
    });
  }
  return new Promise<RuntimeKernelHttpResponse>((resolve) => {
    const entry: KernelHttpSyncQueueEntry = { request, resolve };
    if (request.signal) {
      entry.abortListener = () => {
        const index = bridge.queue.indexOf(entry);
        if (index >= 0) bridge.queue.splice(index, 1);
        request.signal?.removeEventListener?.('abort', entry.abortListener!);
        resolve({
          status: 0,
          headers: { 'content-type': 'text/plain' },
          body: 'Network request aborted\n',
        });
      };
      request.signal.addEventListener?.('abort', entry.abortListener, { once: true });
      if (request.signal.aborted) {
        entry.abortListener();
        return;
      }
    }
    bridge.queue.push(entry);
    drainKernelHttpSyncServerQueue(bridge, runtimeLabel);
  });
}

function drainKernelHttpSyncServerQueue(bridge: KernelHttpSyncServerBridge, runtimeLabel: string): void {
  if (bridge.active || bridge.closed) return;
  const entry = bridge.queue.shift();
  if (!entry) return;
  if (entry.abortListener) entry.request.signal?.removeEventListener?.('abort', entry.abortListener);
  bridge.active = true;
  dispatchKernelHttpSyncServerRequest(bridge, entry.request, runtimeLabel)
    .then(entry.resolve)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      entry.resolve({
        status: 500,
        headers: { 'content-type': 'text/plain' },
        body: `${message || `${runtimeLabel} network request failed`}\n`,
      });
    })
    .finally(() => {
      bridge.active = false;
      drainKernelHttpSyncServerQueue(bridge, runtimeLabel);
    });
}

function dispatchKernelHttpSyncServerRequest(
  bridge: KernelHttpSyncServerBridge,
  request: RuntimeKernelHttpRequest,
  runtimeLabel: string
): Promise<RuntimeKernelHttpResponse> {
  const buffer = bridge.requestBuffer;
  const header = new Int32Array(buffer, 0, 2);
  const bytes = new Uint8Array(buffer, KERNEL_HTTP_SYNC_HEADER_BYTES);
  if (Atomics.load(header, KERNEL_HTTP_SYNC_STATE_INDEX) !== KERNEL_HTTP_SYNC_IDLE) {
    return Promise.resolve({
      status: 503,
      headers: { 'content-type': 'text/plain' },
      body: 'Service Unavailable\n',
    });
  }
  const encoded = new TextEncoder().encode(kernelHttpRequestManifest(request));
  if (encoded.byteLength > bytes.byteLength) {
    return Promise.resolve({
      status: 413,
      headers: { 'content-type': 'text/plain' },
      body: `${runtimeLabel} network request exceeded buffer capacity\n`,
    });
  }
  bytes.set(encoded);
  Atomics.store(header, KERNEL_HTTP_SYNC_LENGTH_INDEX, encoded.byteLength);
  Atomics.store(header, KERNEL_HTTP_SYNC_STATE_INDEX, KERNEL_HTTP_SYNC_REQUEST);
  Atomics.notify(header, KERNEL_HTTP_SYNC_STATE_INDEX);

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
        closeKernelHttpSyncServerBridge(bridge, runtimeLabel);
        settle({
          status: 0,
          headers: { 'content-type': 'text/plain' },
          body: 'Network request aborted\n',
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
      const state = Atomics.load(header, KERNEL_HTTP_SYNC_STATE_INDEX);
      if (state === KERNEL_HTTP_SYNC_RESPONSE) {
        const length = Atomics.load(header, KERNEL_HTTP_SYNC_LENGTH_INDEX);
        const manifest = new TextDecoder().decode(bytes.subarray(0, Math.max(0, Math.min(length, bytes.byteLength))));
        Atomics.store(header, KERNEL_HTTP_SYNC_LENGTH_INDEX, 0);
        Atomics.store(header, KERNEL_HTTP_SYNC_STATE_INDEX, KERNEL_HTTP_SYNC_IDLE);
        Atomics.notify(header, KERNEL_HTTP_SYNC_STATE_INDEX);
        settle(kernelHttpResponseFromManifest(manifest, runtimeLabel));
        return;
      }
      if (state === KERNEL_HTTP_SYNC_CLOSED) {
        settle({
          status: 503,
          headers: { 'content-type': 'text/plain' },
          body: 'Service Unavailable\n',
        });
        return;
      }
      globalThis.setTimeout(poll, 1);
    };
    poll();
  });
}

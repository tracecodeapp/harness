import {
  runtimeHttpBodyBytes,
  type RuntimeKernelHttpBodyPayload,
  type RuntimeKernelHttpError,
  type RuntimeKernelHttpRequest,
  type RuntimeKernelHttpResponse,
  type RuntimeWorkspaceActor,
} from '@tracecode/runtime-core';
import {
  TRACEKERNEL_HTTP_MAX_BODY_BYTES,
  TRACEKERNEL_HTTP_MAX_DIAGNOSTIC_FIELD_LENGTH,
  TRACEKERNEL_HTTP_MAX_HEADER_BYTES,
  TRACEKERNEL_HTTP_MAX_HEADER_COUNT,
  type RuntimeKernelHttpPathResult,
  type RuntimeKernelHttpRequestResult,
} from './http-state';

/**
 * Stateless validation and normalization for the workspace HTTP boundary.
 *
 * Keeping this separate from listener/request state makes the accepted wire
 * contract independently testable and prevents protocol validation from
 * depending on workspace lifecycle internals.
 */
export class WorkspaceHttpPolicy {
  sanitizeDiagnosticField(value: unknown): string {
    const text = String(value ?? '');
    const escaped = text
      .replace(/\\/g, '\\\\')
      .replace(/\t/g, '\\t')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n');
    return escaped.length > TRACEKERNEL_HTTP_MAX_DIAGNOSTIC_FIELD_LENGTH
      ? `${escaped.slice(0, TRACEKERNEL_HTTP_MAX_DIAGNOSTIC_FIELD_LENGTH)}...`
      : escaped;
  }

  createError(code: string, message: string): RuntimeKernelHttpError {
    return { code, message };
  }

  errorFromThrown(
    error: unknown,
    fallbackCode: string
  ): RuntimeKernelHttpError {
    const message = error instanceof Error ? error.message : String(error);
    const taggedCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    const parsedCode = /^([A-Z][A-Z0-9_]*):/.exec(message)?.[1] ?? '';
    return this.createError(
      taggedCode || parsedCode || fallbackCode,
      message
    );
  }

  errorResponse(
    status: number,
    error: RuntimeKernelHttpError,
    body = `${error.message}\n`
  ): RuntimeKernelHttpResponse {
    return { status, body, error };
  }

  normalizeHost(host: string, kind: 'connect' | 'listen'): string {
    if (host.length > 253 || /[\u0000-\u0020\u007f]/.test(host)) {
      throw Object.assign(
        new Error(
          `EADDRNOTAVAIL: invalid ${kind} host '${this.sanitizeDiagnosticField(host)}'`
        ),
        { code: 'EADDRNOTAVAIL' }
      );
    }
    return host;
  }

  normalizeMethod(method: unknown): string {
    const normalized = String(method ?? 'GET').toUpperCase();
    if (!/^[A-Z0-9!#$%&'*+\-.^_`|~]{1,64}$/.test(normalized)) {
      throw Object.assign(
        new Error(
          `EINVAL: invalid HTTP method '${this.sanitizeDiagnosticField(normalized)}'`
        ),
        { code: 'EINVAL' }
      );
    }
    return normalized;
  }

  normalizeHeaders(
    headers: Record<string, string> | undefined
  ): Record<string, string> | undefined {
    if (!headers) return undefined;
    const entries = Object.entries(headers);
    if (entries.length === 0) return undefined;
    if (entries.length > TRACEKERNEL_HTTP_MAX_HEADER_COUNT) {
      throw Object.assign(
        new Error('EMSGSIZE: HTTP header count limit exceeded'),
        { code: 'EMSGSIZE' }
      );
    }
    let headerBytes = 0;
    const normalized: Record<string, string> = {};
    for (const [name, value] of entries) {
      const key = String(name).toLowerCase();
      const text = String(value);
      if (
        !/^[a-z0-9!#$%&'*+\-.^_`|~]{1,128}$/.test(key) ||
        /[\r\n\u0000]/.test(text)
      ) {
        throw Object.assign(
          new Error(
            `EINVAL: invalid HTTP header '${this.sanitizeDiagnosticField(name)}'`
          ),
          { code: 'EINVAL' }
        );
      }
      headerBytes += key.length + text.length;
      if (headerBytes > TRACEKERNEL_HTTP_MAX_HEADER_BYTES) {
        throw Object.assign(
          new Error('EMSGSIZE: HTTP header byte limit exceeded'),
          { code: 'EMSGSIZE' }
        );
      }
      normalized[key] = text;
    }
    return normalized;
  }

  headersFromRawHeaders(
    rawHeaders: readonly [string, string][]
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of rawHeaders) {
      headers[String(name).toLowerCase()] = String(value);
    }
    return headers;
  }

  normalizeRawHeaders(
    rawHeaders: readonly [string, string][] | undefined
  ): readonly [string, string][] | undefined {
    if (!rawHeaders) return undefined;
    if (rawHeaders.length > TRACEKERNEL_HTTP_MAX_HEADER_COUNT) {
      throw Object.assign(
        new Error('EMSGSIZE: HTTP raw header count limit exceeded'),
        { code: 'EMSGSIZE' }
      );
    }
    let headerBytes = 0;
    const normalized: [string, string][] = [];
    for (const entry of rawHeaders) {
      if (!Array.isArray(entry) || entry.length < 2) {
        throw Object.assign(
          new Error('EINVAL: invalid HTTP raw header entry'),
          { code: 'EINVAL' }
        );
      }
      const [name, value] = entry;
      const key = String(name);
      const text = String(value);
      if (
        !/^[A-Za-z0-9!#$%&'*+\-.^_`|~]{1,128}$/.test(key) ||
        /[\r\n\u0000]/.test(text)
      ) {
        throw Object.assign(
          new Error(
            `EINVAL: invalid HTTP raw header '${this.sanitizeDiagnosticField(name)}'`
          ),
          { code: 'EINVAL' }
        );
      }
      headerBytes += key.length + text.length;
      if (headerBytes > TRACEKERNEL_HTTP_MAX_HEADER_BYTES) {
        throw Object.assign(
          new Error('EMSGSIZE: HTTP raw header byte limit exceeded'),
          { code: 'EMSGSIZE' }
        );
      }
      normalized.push([key, text]);
    }
    return normalized;
  }

  normalizeRequestPath(
    path: unknown,
    url: URL
  ): RuntimeKernelHttpPathResult {
    const fallback = `${url.pathname || '/'}${url.search}`;
    const normalized = String(path ?? fallback) || fallback;
    if (
      !normalized.startsWith('/') ||
      normalized.length > 8192 ||
      /[\r\n\u0000]/.test(normalized)
    ) {
      return {
        ok: false,
        error: this.createError(
          'EINVAL',
          `EINVAL: invalid HTTP request path '${this.sanitizeDiagnosticField(normalized)}'`
        ),
      };
    }
    return { ok: true, path: normalized };
  }

  assertBodyLimit(
    message: RuntimeKernelHttpBodyPayload,
    direction: 'request' | 'response'
  ): void {
    let bytes: Uint8Array;
    try {
      bytes = runtimeHttpBodyBytes(message);
    } catch {
      throw Object.assign(
        new Error(`EINVAL: invalid HTTP ${direction} body encoding`),
        { code: 'EINVAL' }
      );
    }
    if (bytes.byteLength > TRACEKERNEL_HTTP_MAX_BODY_BYTES) {
      throw Object.assign(
        new Error(`EMSGSIZE: HTTP ${direction} body limit exceeded`),
        { code: 'EMSGSIZE' }
      );
    }
  }

  normalizeRequest(
    request: Omit<RuntimeKernelHttpRequest, 'path'> & { path?: string }
  ): RuntimeKernelHttpRequestResult {
    let url: URL;
    try {
      url = new URL(String(request.url));
    } catch {
      return {
        ok: false,
        error: this.createError(
          'EINVAL',
          'EINVAL: invalid HTTP request URL'
        ),
      };
    }
    let rawHeaders: readonly [string, string][] | undefined;
    let explicitHeaders: Record<string, string> | undefined;
    try {
      rawHeaders = this.normalizeRawHeaders(request.rawHeaders);
      explicitHeaders = this.normalizeHeaders(request.headers);
    } catch (error) {
      return { ok: false, error: this.errorFromThrown(error, 'EINVAL') };
    }
    const headers =
      explicitHeaders ??
      (rawHeaders ? this.headersFromRawHeaders(rawHeaders) : undefined);
    const path = this.normalizeRequestPath(request.path, url);
    if (!path.ok) {
      return { ok: false, error: path.error };
    }
    let method: string;
    try {
      method = this.normalizeMethod(request.method);
    } catch (error) {
      return { ok: false, error: this.errorFromThrown(error, 'EINVAL') };
    }
    const normalized: RuntimeKernelHttpRequest = {
      method,
      url: url.toString(),
      path: path.path,
    };
    if (headers) normalized.headers = headers;
    if (explicitHeaders) {
      normalized.rawHeaders = Object.entries(explicitHeaders);
    } else if (rawHeaders) {
      normalized.rawHeaders = rawHeaders;
    }
    if (request.body !== undefined) normalized.body = String(request.body);
    if (request.bodyEncoding) normalized.bodyEncoding = request.bodyEncoding;
    if (request.signal) normalized.signal = request.signal;
    try {
      this.assertBodyLimit(normalized, 'request');
    } catch (error) {
      return { ok: false, error: this.errorFromThrown(error, 'EINVAL') };
    }
    return { ok: true, request: normalized };
  }

  normalizeResponse(
    response: RuntimeKernelHttpResponse
  ): RuntimeKernelHttpResponse {
    const status = Math.trunc(Number(response.status));
    if (!Number.isFinite(status) || status < 100 || status > 599) {
      throw Object.assign(
        new Error(
          `EINVAL: invalid HTTP response status '${response.status}'`
        ),
        { code: 'EINVAL' }
      );
    }
    const normalized: RuntimeKernelHttpResponse = { status };
    const rawHeaders = this.normalizeRawHeaders(response.rawHeaders);
    const headers = rawHeaders
      ? this.headersFromRawHeaders(rawHeaders)
      : this.normalizeHeaders(response.headers);
    if (headers) normalized.headers = headers;
    if (rawHeaders) {
      normalized.rawHeaders = rawHeaders;
    } else if (headers) {
      normalized.rawHeaders = Object.entries(headers);
    }
    if (response.body !== undefined) normalized.body = String(response.body);
    if (response.bodyEncoding) {
      normalized.bodyEncoding = response.bodyEncoding;
    }
    if (response.annotation !== undefined) {
      normalized.annotation = response.annotation;
    }
    this.assertBodyLimit(normalized, 'response');
    return normalized;
  }

  normalizeConnectHost(host: string | undefined): string {
    const normalized = (host ?? '127.0.0.1').trim().toLowerCase();
    if (
      !normalized ||
      normalized === '0.0.0.0' ||
      normalized === '::' ||
      normalized === '*'
    ) {
      return '127.0.0.1';
    }
    if (normalized === 'localhost') return '127.0.0.1';
    return this.normalizeHost(normalized, 'connect');
  }

  normalizeListenHost(
    host: string | undefined,
    actor: RuntimeWorkspaceActor
  ): string {
    const defaultHost = actor.kind === 'runtime' ? '127.0.0.1' : '0.0.0.0';
    const normalized = (host ?? defaultHost).trim().toLowerCase();
    if (!normalized) return defaultHost;
    if (normalized === '::' || normalized === '*') {
      if (actor.kind === 'runtime') {
        throw Object.assign(
          new Error('EACCES: wildcard listen is not permitted'),
          { code: 'EACCES' }
        );
      }
      return '0.0.0.0';
    }
    if (normalized === 'localhost') return '127.0.0.1';
    if (this.isWildcardHost(normalized) && actor.kind === 'runtime') {
      throw Object.assign(
        new Error('EACCES: wildcard listen is not permitted'),
        { code: 'EACCES' }
      );
    }
    return this.normalizeHost(normalized, 'listen');
  }

  isWildcardHost(host: string): boolean {
    return host === '0.0.0.0';
  }

  isWildcardConnectHost(host: string): boolean {
    return host === '127.0.0.1';
  }

  normalizeConnectPort(port: number): number {
    const normalized = Math.trunc(Number(port));
    if (!Number.isFinite(normalized) || normalized < 1 || normalized > 65535) {
      throw Object.assign(
        new Error(`EADDRNOTAVAIL: invalid port '${port}'`),
        { code: 'EADDRNOTAVAIL' }
      );
    }
    return normalized;
  }
}

export const workspaceHttpPolicy = new WorkspaceHttpPolicy();

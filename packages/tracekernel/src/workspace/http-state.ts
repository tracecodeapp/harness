import type {
  RuntimeExternalHttpConfig,
  RuntimeKernelHttpError,
  RuntimeKernelHttpHandler,
  RuntimeKernelHttpListenerInfo,
  RuntimeKernelHttpRequest,
  RuntimeKernelHttpResponse,
  RuntimeWorkspaceActor,
} from '@tracecode/harness-core';

export const TRACEKERNEL_HTTP_LISTENER_LIMIT = 128;
export const TRACEKERNEL_HTTP_REQUEST_LOG_LIMIT = 256;
export const TRACEKERNEL_HTTP_MAX_IN_FLIGHT_REQUESTS = 256;
export const TRACEKERNEL_HTTP_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const TRACEKERNEL_HTTP_MAX_HEADER_COUNT = 128;
export const TRACEKERNEL_HTTP_MAX_HEADER_BYTES = 64 * 1024;
export const TRACEKERNEL_HTTP_MAX_DIAGNOSTIC_FIELD_LENGTH = 4096;
export const TRACEKERNEL_HTTP_TCP_READ_BYTES = 64 * 1024;
export const TRACEKERNEL_HTTP_REQUEST_FRAME_TIMEOUT_MS = 30_000;
export const TRACEKERNEL_EXTERNAL_HTTP_MAX_TIMEOUT_MS = 60_000;

const TRACEKERNEL_EXTERNAL_HTTP_DEFAULT_TIMEOUT_MS = 10_000;
const TRACEKERNEL_EXTERNAL_HTTP_DEFAULT_MAX_CONCURRENT_REQUESTS = 8;
const TRACEKERNEL_EXTERNAL_HTTP_DEFAULT_MAX_REQUESTS_PER_COMMAND = 64;
const TRACEKERNEL_SENSITIVE_URL_PARAM_NAMES = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'code',
  'key',
  'password',
  'secret',
  'session',
  'sig',
  'signature',
  'token',
]);

export const TRACEKERNEL_HTTP_STATUS_TEXT: Readonly<Record<number, string>> =
  Object.freeze({
    100: 'Continue',
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    204: 'No Content',
    206: 'Partial Content',
    300: 'Multiple Choices',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    307: 'Temporary Redirect',
    308: 'Permanent Redirect',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    408: 'Request Timeout',
    409: 'Conflict',
    410: 'Gone',
    413: 'Payload Too Large',
    415: 'Unsupported Media Type',
    418: "I'm a Teapot",
    422: 'Unprocessable Content',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  });

export interface NormalizedRuntimeExternalHttpHostRule {
  hostname: string;
  wildcardSubdomains: boolean;
  port?: number;
}

export interface NormalizedRuntimeExternalHttpConfig {
  fetch: RuntimeExternalHttpConfig['fetch'];
  hosts:
    | readonly NormalizedRuntimeExternalHttpHostRule[]
    | ((url: URL) => boolean);
  allowHttp: boolean;
  timeoutMs: number;
  maxConcurrentRequests: number;
  maxRequestsPerCommand: number;
}

export type HostResolution =
  | {
      reachable: true;
      via: 'loopback' | 'listener' | 'external';
      ip: string;
      latencyMs: number;
    }
  | { reachable: false; reason: 'unknown-host' };

export interface RuntimeKernelHttpListenerRecord {
  info: RuntimeKernelHttpListenerInfo;
  handler: RuntimeKernelHttpHandler;
  actor: RuntimeWorkspaceActor;
  ready: Promise<void>;
  listenerFd?: number;
  transportAddress?: { host: string; port: number };
  closed: boolean;
  listening: boolean;
  readonly connectionControllers: Map<number, AbortController>;
}

export interface RuntimeKernelHttpTcpDispatchContext {
  readonly url: URL;
  readonly actor: RuntimeWorkspaceActor;
  readonly signal: AbortSignal;
  readonly response: Promise<RuntimeKernelHttpResponse>;
  resolve(response: RuntimeKernelHttpResponse): void;
  reject(error: unknown): void;
}

export interface RuntimeKernelHttpListenerOwner {
  pid: number;
  idPrefix: string;
  actor?: RuntimeWorkspaceActor;
}

export interface RuntimeKernelHttpRequestRecord {
  seq: number;
  time: string;
  listenerId?: string;
  pid?: number;
  method: string;
  url: string;
  status?: number;
  error?: string;
  external?: true;
}

export type RuntimeKernelHttpPathResult =
  | { ok: true; path: string }
  | { ok: false; error: RuntimeKernelHttpError };

export type RuntimeKernelHttpRequestResult =
  | { ok: true; request: RuntimeKernelHttpRequest }
  | { ok: false; error: RuntimeKernelHttpError };

function clampRuntimeExternalHttpPositiveInteger(
  value: unknown,
  fallback: number,
  max: number
): number {
  if (value === undefined) return fallback;
  const normalized = Math.trunc(Number(value));
  if (!Number.isFinite(normalized)) return fallback;
  return Math.min(max, Math.max(1, normalized));
}

function normalizeRuntimeExternalHttpHostEntry(
  entry: string
): NormalizedRuntimeExternalHttpHostRule {
  const raw = entry.trim();
  if (!raw || raw === '*') {
    throw new TypeError(
      'Runtime external HTTP host entries must not be empty or "*". Use a predicate for full-wildcard egress.'
    );
  }
  const wildcardSubdomains = raw.startsWith('*.');
  const hostAndPort = wildcardSubdomains ? raw.slice(2) : raw;
  const lastColon = hostAndPort.lastIndexOf(':');
  const hasPort =
    lastColon > -1 && /^[0-9]+$/.test(hostAndPort.slice(lastColon + 1));
  const hostname = (
    hasPort ? hostAndPort.slice(0, lastColon) : hostAndPort
  ).toLowerCase();
  if (
    !hostname ||
    hostname.includes('/') ||
    hostname.includes('@') ||
    hostname.includes('*')
  ) {
    throw new TypeError(`Invalid Runtime external HTTP host entry "${entry}".`);
  }
  let port: number | undefined;
  if (hasPort) {
    port = Math.trunc(Number(hostAndPort.slice(lastColon + 1)));
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new TypeError(
        `Invalid Runtime external HTTP host port in "${entry}".`
      );
    }
  }
  return {
    hostname,
    wildcardSubdomains,
    ...(port !== undefined ? { port } : {}),
  };
}

export function normalizeRuntimeExternalHttpConfig(
  config: RuntimeExternalHttpConfig | undefined
): NormalizedRuntimeExternalHttpConfig | undefined {
  if (config === undefined) return undefined;
  if (typeof config.fetch !== 'function') {
    throw new TypeError(
      'Runtime external HTTP config requires a fetch delegate.'
    );
  }
  const hosts =
    typeof config.hosts === 'function'
      ? config.hosts
      : Array.isArray(config.hosts)
        ? config.hosts.map(normalizeRuntimeExternalHttpHostEntry)
        : undefined;
  if (!hosts) {
    throw new TypeError(
      'Runtime external HTTP config requires a hosts allowlist or predicate.'
    );
  }
  return {
    fetch: config.fetch,
    hosts,
    allowHttp: config.allowHttp === true,
    timeoutMs: clampRuntimeExternalHttpPositiveInteger(
      config.timeoutMs,
      TRACEKERNEL_EXTERNAL_HTTP_DEFAULT_TIMEOUT_MS,
      TRACEKERNEL_EXTERNAL_HTTP_MAX_TIMEOUT_MS
    ),
    maxConcurrentRequests: clampRuntimeExternalHttpPositiveInteger(
      config.maxConcurrentRequests,
      TRACEKERNEL_EXTERNAL_HTTP_DEFAULT_MAX_CONCURRENT_REQUESTS,
      Number.MAX_SAFE_INTEGER
    ),
    maxRequestsPerCommand: clampRuntimeExternalHttpPositiveInteger(
      config.maxRequestsPerCommand,
      TRACEKERNEL_EXTERNAL_HTTP_DEFAULT_MAX_REQUESTS_PER_COMMAND,
      Number.MAX_SAFE_INTEGER
    ),
  };
}

function stableHostnameHash(hostname: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < hostname.length; index += 1) {
    hash ^= hostname.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function stableKernelJournalFingerprint(value: string): string {
  return stableHostnameHash(value).toString(16).padStart(8, '0').slice(0, 8);
}

export function syntheticIp(hostname: string): string {
  const hash = stableHostnameHash(hostname.toLowerCase());
  return `192.0.2.${(hash % 254) + 1}`;
}

export function syntheticLatency(hostname: string): number {
  const hash = stableHostnameHash(hostname.toLowerCase());
  return Number((0.1 + (hash % 291) / 100).toFixed(2));
}

export function formatPingLatency(latencyMs: number): string {
  return latencyMs.toFixed(2);
}

export function defaultRuntimeExternalHttpPort(protocol: string): number {
  return protocol === 'http:' ? 80 : 443;
}

export function isBareHostnameForExternalResolution(hostname: string): boolean {
  return !!hostname && !/[\u0000-\u0020\u007f:/@[\]]/.test(hostname);
}

export function redactRuntimeDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = 'redacted';
    if (url.password) url.password = 'redacted';
    for (const [name] of url.searchParams) {
      if (TRACEKERNEL_SENSITIVE_URL_PARAM_NAMES.has(name.toLowerCase())) {
        url.searchParams.set(name, 'redacted');
      }
    }
    return url.toString();
  } catch {
    return value.replace(
      /([?&](?:access_token|api_key|apikey|auth|authorization|code|key|password|secret|session|sig|signature|token)=)[^&#\s]*/gi,
      '$1redacted'
    );
  }
}

/**
 * Mutable HTTP/network bookkeeping for one workspace session.
 *
 * The protocol mechanics remain on the compatibility workspace façade for
 * now, while listener ownership and request budgets have a single boundary
 * ready to move under TraceKernel networking.
 */
export class WorkspaceHttpState {
  readonly external?: NormalizedRuntimeExternalHttpConfig;
  readonly listeners = new Map<string, RuntimeKernelHttpListenerRecord>();
  readonly retiredListeners = new Set<RuntimeKernelHttpListenerRecord>();
  readonly tcpDispatches = new Map<number, RuntimeKernelHttpTcpDispatchContext>();
  readonly requestLog: RuntimeKernelHttpRequestRecord[] = [];
  readonly lifecycleAbortController = new AbortController();
  nextListenerSeq = 1;
  nextRequestSeq = 1;
  nextEphemeralPort = 49152;
  activeRequests = 0;
  activeExternalRequests = 0;
  workspaceExternalRequestCount = 0;

  constructor(config: RuntimeExternalHttpConfig | undefined) {
    this.external = normalizeRuntimeExternalHttpConfig(config);
  }
}

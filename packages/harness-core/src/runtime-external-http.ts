import {
  runtimeHttpBodyBytes,
  runtimeHttpBodyFromBytes,
  type RuntimeKernelHttpResponse,
} from './runtime-project';

export const RUNTIME_EXTERNAL_HTTP_MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface RuntimeExternalHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  bodyEncoding?: 'utf8' | 'base64';
  signal: AbortSignal;
}

export interface RuntimeExternalHttpConfig {
  fetch: (request: RuntimeExternalHttpRequest) => Promise<RuntimeKernelHttpResponse>;
  hosts: readonly string[] | ((url: URL) => boolean);
  allowHttp?: boolean;
  timeoutMs?: number;
  maxConcurrentRequests?: number;
  maxRequestsPerCommand?: number;
}

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal'];
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function normalizedUrlHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => {
    if (!/^[0-9]+$/.test(part)) return NaN;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : NaN;
  });
  return bytes.every((value) => Number.isFinite(value)) ? bytes : null;
}

function expandIpv6(hostname: string): number[] | null {
  const value = hostname.toLowerCase();
  if (!value.includes(':')) return null;
  const [head = '', tail = '', extra] = value.split('::');
  if (extra !== undefined) return null;
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const parsePart = (part: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    return Number.parseInt(part, 16);
  };
  const parsedHead = headParts.map(parsePart);
  const parsedTail = tailParts.map(parsePart);
  if (parsedHead.some((part) => part === null) || parsedTail.some((part) => part === null)) return null;
  const missing = 8 - parsedHead.length - parsedTail.length;
  if (value.includes('::')) {
    if (missing < 0) return null;
    return [...parsedHead, ...Array.from({ length: missing }, () => 0), ...parsedTail] as number[];
  }
  if (missing !== 0) return null;
  return parsedHead as number[];
}

function blockedIpv4Reason(ipv4: readonly number[]): string | null {
  const [first, second] = ipv4;
  if (first === 127) return 'IPv4 loopback addresses are blocked';
  if (first === 10) return 'IPv4 private addresses are blocked';
  if (first === 172 && second >= 16 && second <= 31) return 'IPv4 private addresses are blocked';
  if (first === 192 && second === 168) return 'IPv4 private addresses are blocked';
  if (first === 169 && second === 254) return 'IPv4 link-local addresses are blocked';
  if (first === 0) return 'IPv4 this-network addresses are blocked';
  return null;
}

export function isBlockedExternalHttpHost(url: URL): string | null {
  const hostname = normalizedUrlHostname(url);
  const ipv4 = parseIpv4(hostname);
  if (ipv4) return blockedIpv4Reason(ipv4);
  const ipv6 = expandIpv6(hostname);
  if (ipv6) {
    if (ipv6.every((part) => part === 0) || (ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] === 1)) {
      return 'IPv6 loopback or unspecified addresses are blocked';
    }
    if ((ipv6[0] & 0xfe00) === 0xfc00) return 'IPv6 unique local addresses are blocked';
    if ((ipv6[0] & 0xffc0) === 0xfe80) return 'IPv6 link-local addresses are blocked';
    if (ipv6.slice(0, 5).every((part) => part === 0) && ipv6[5] === 0xffff) {
      const mapped = blockedIpv4Reason([ipv6[6] >> 8, ipv6[6] & 0xff, ipv6[7] >> 8, ipv6[7] & 0xff]);
      if (mapped) return `IPv4-mapped IPv6: ${mapped}`;
    }
    return null;
  }
  if (hostname === 'localhost' || hostname === 'metadata.google.internal') return `hostname ${hostname} is blocked`;
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return `hostname ${hostname} is blocked`;
  }
  return null;
}

function filteredHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

export function createDefaultExternalHttpFetch(): RuntimeExternalHttpConfig['fetch'] {
  return async (request) => {
    const bodyBytes = request.body === undefined ? undefined : runtimeHttpBodyBytes(request);
    let body: ArrayBuffer | undefined;
    if (bodyBytes) {
      body = new ArrayBuffer(bodyBytes.byteLength);
      new Uint8Array(body).set(bodyBytes);
    }
    const response = await globalThis.fetch(request.url, {
      method: request.method,
      headers: filteredHeaders(request.headers),
      body,
      credentials: 'omit',
      redirect: 'follow',
      signal: request.signal,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > RUNTIME_EXTERNAL_HTTP_MAX_BODY_BYTES) {
      throw new Error('TraceKernel external HTTP response body limit exceeded');
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
    });
    return {
      status: response.status,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...runtimeHttpBodyFromBytes(bytes),
    };
  };
}

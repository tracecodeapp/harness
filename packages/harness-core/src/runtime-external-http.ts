import {
  runtimeHttpBodyBytes,
  runtimeHttpBodyFromBytes,
  type RuntimeKernelHttpResponse,
} from './runtime-project';

export const RUNTIME_EXTERNAL_HTTP_MAX_BODY_BYTES = 4 * 1024 * 1024;

const RUNTIME_EXTERNAL_HTTP_MAX_REDIRECTS = 5;

export interface RuntimeExternalHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  bodyEncoding?: 'utf8' | 'base64';
  signal: AbortSignal;
}

export interface RuntimeExternalHttpResponse extends RuntimeKernelHttpResponse {
  annotation?: unknown;
}

export interface RuntimeExternalHttpConfig {
  fetch: (request: RuntimeExternalHttpRequest) => Promise<RuntimeExternalHttpResponse>;
  hosts: readonly string[] | ((url: URL) => boolean);
  allowHttp?: boolean;
  timeoutMs?: number;
  maxConcurrentRequests?: number;
  maxRequestsPerCommand?: number;
}

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];
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
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REQUEST_BODY_HEADERS = new Set([
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-type',
]);

function normalizedUrlHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
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
  if (first === 100 && second >= 64 && second <= 127) return 'IPv4 shared address space is blocked';
  if (first === 172 && second >= 16 && second <= 31) return 'IPv4 private addresses are blocked';
  if (first === 192 && second === 168) return 'IPv4 private addresses are blocked';
  if (first === 169 && second === 254) return 'IPv4 link-local addresses are blocked';
  if (first === 0) return 'IPv4 this-network addresses are blocked';
  if (first === 192 && second === 0) return 'IPv4 special-purpose addresses are blocked';
  if (first === 198 && (second === 18 || second === 19)) return 'IPv4 benchmarking addresses are blocked';
  if (
    (first === 192 && second === 0 && ipv4[2] === 2) ||
    (first === 198 && second === 51 && ipv4[2] === 100) ||
    (first === 203 && second === 0 && ipv4[2] === 113)
  ) {
    return 'IPv4 documentation addresses are blocked';
  }
  if (first >= 224) return 'IPv4 multicast or reserved addresses are blocked';
  return null;
}

export function isBlockedExternalHttpHost(url: URL): string | null {
  const hostname = normalizedUrlHostname(url);
  if (!hostname) return 'empty hostname is blocked';
  const ipv4 = parseIpv4(hostname);
  if (ipv4) return blockedIpv4Reason(ipv4);
  const ipv6 = expandIpv6(hostname);
  if (ipv6) {
    if (ipv6.every((part) => part === 0) || (ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] === 1)) {
      return 'IPv6 loopback or unspecified addresses are blocked';
    }
    if ((ipv6[0] & 0xfe00) === 0xfc00) return 'IPv6 unique local addresses are blocked';
    if ((ipv6[0] & 0xffc0) === 0xfe80) return 'IPv6 link-local addresses are blocked';
    if ((ipv6[0] & 0xffc0) === 0xfec0) return 'IPv6 site-local addresses are blocked';
    if ((ipv6[0] & 0xff00) === 0xff00) return 'IPv6 multicast addresses are blocked';
    if (ipv6.slice(0, 5).every((part) => part === 0) && ipv6[5] === 0xffff) {
      const mapped = blockedIpv4Reason([ipv6[6] >> 8, ipv6[6] & 0xff, ipv6[7] >> 8, ipv6[7] & 0xff]);
      if (mapped) return `IPv4-mapped IPv6: ${mapped}`;
    }
    if (ipv6.slice(0, 6).every((part) => part === 0)) {
      const compatible = blockedIpv4Reason([ipv6[6] >> 8, ipv6[6] & 0xff, ipv6[7] >> 8, ipv6[7] & 0xff]);
      if (compatible) return `IPv4-compatible IPv6: ${compatible}`;
    }
    if (ipv6[0] === 0x0064 && ipv6[1] === 0xff9b && ipv6.slice(2, 6).every((part) => part === 0)) {
      const translated = blockedIpv4Reason([ipv6[6] >> 8, ipv6[6] & 0xff, ipv6[7] >> 8, ipv6[7] & 0xff]);
      if (translated) return `IPv4-translated IPv6: ${translated}`;
    }
    if (ipv6[0] === 0x2002) {
      const sixToFour = blockedIpv4Reason([ipv6[1] >> 8, ipv6[1] & 0xff, ipv6[2] >> 8, ipv6[2] & 0xff]);
      if (sixToFour) return `6to4 IPv6: ${sixToFour}`;
    }
    return null;
  }
  if (hostname === 'localhost' || hostname === 'metadata.google.internal') return `hostname ${hostname} is blocked`;
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return `hostname ${hostname} is blocked`;
  }
  if (!hostname.includes('.')) return `single-label hostname ${hostname} is blocked`;
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

function headersWithoutRequestBody(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (REQUEST_BODY_HEADERS.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

function assertSupportedExternalHttpUrl(url: URL, kind: 'request' | 'redirect'): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`TraceKernel external HTTP ${kind} blocked: unsupported ${kind} URL scheme ${url.protocol}`);
  }
  const blocklistReason = isBlockedExternalHttpHost(url);
  if (blocklistReason) {
    throw new Error(`TraceKernel external HTTP ${kind} blocked: ${blocklistReason}`);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the policy error that caused cancellation.
  }
}

async function readLimitedResponseBody(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const contentLength = response.headers.get('content-length')?.trim();
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > RUNTIME_EXTERNAL_HTTP_MAX_BODY_BYTES) {
    await cancelResponseBody(response);
    throw new Error('TraceKernel external HTTP response body limit exceeded');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > RUNTIME_EXTERNAL_HTTP_MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the body-limit error when the transport cannot be cancelled cleanly.
        }
        throw new Error('TraceKernel external HTTP response body limit exceeded');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Creates a direct Fetch API delegate with bounded response bodies and redirects.
 * Cross-origin redirects are rejected because this delegate does not own the
 * workspace host allowlist. Browsers also hide manual redirect targets behind
 * opaque responses, so browser redirects fail closed. A delegate that supports
 * cross-origin redirects must re-apply its deployment's host and IP policy per hop.
 */
export function createDefaultExternalHttpFetch(): RuntimeExternalHttpConfig['fetch'] {
  return async (request) => {
    const bodyBytes = request.body === undefined ? undefined : runtimeHttpBodyBytes(request);
    let body: ArrayBuffer | undefined;
    if (bodyBytes) {
      body = new ArrayBuffer(bodyBytes.byteLength);
      new Uint8Array(body).set(bodyBytes);
    }
    let currentUrl = new URL(request.url);
    let method = request.method;
    let requestHeaders = filteredHeaders(request.headers);
    let currentBody = body;
    let response: Response;
    let redirects = 0;

    assertSupportedExternalHttpUrl(currentUrl, 'request');
    while (true) {
      response = await globalThis.fetch(currentUrl.toString(), {
        method,
        headers: requestHeaders,
        body: currentBody,
        credentials: 'omit',
        redirect: 'manual',
        signal: request.signal,
      });
      if (response.type === 'opaqueredirect') {
        await cancelResponseBody(response);
        throw new Error('TraceKernel external HTTP redirect blocked: browser did not expose the redirect target');
      }
      const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
      if (location === null) break;
      if (redirects >= RUNTIME_EXTERNAL_HTTP_MAX_REDIRECTS) {
        await cancelResponseBody(response);
        throw new Error(`TraceKernel external HTTP redirect limit exceeded (${RUNTIME_EXTERNAL_HTTP_MAX_REDIRECTS})`);
      }

      let redirectUrl: URL;
      try {
        redirectUrl = new URL(location, currentUrl);
      } catch {
        await cancelResponseBody(response);
        throw new Error('TraceKernel external HTTP redirect blocked: invalid redirect URL');
      }
      try {
        assertSupportedExternalHttpUrl(redirectUrl, 'redirect');
      } catch (error) {
        await cancelResponseBody(response);
        throw error;
      }
      if (redirectUrl.origin !== currentUrl.origin) {
        await cancelResponseBody(response);
        throw new Error(
          `TraceKernel external HTTP cross-origin redirect blocked: ${currentUrl.origin} -> ${redirectUrl.origin}`
        );
      }

      await cancelResponseBody(response);
      const normalizedMethod = method.toUpperCase();
      if (
        (response.status === 303 && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') ||
        ((response.status === 301 || response.status === 302) && normalizedMethod === 'POST')
      ) {
        method = 'GET';
        currentBody = undefined;
        requestHeaders = headersWithoutRequestBody(requestHeaders);
      }
      currentUrl = redirectUrl;
      redirects += 1;
    }

    const bytes = await readLimitedResponseBody(response);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) responseHeaders[name.toLowerCase()] = value;
    });
    return {
      status: response.status,
      ...(Object.keys(responseHeaders).length > 0 ? { headers: responseHeaders } : {}),
      ...runtimeHttpBodyFromBytes(bytes),
    };
  };
}

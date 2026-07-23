const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const HEADER_END = new Uint8Array([13, 10, 13, 10]);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface TraceKernelHttp1Limits {
  readonly maxStartLineBytes?: number;
  readonly maxHeaderBytes?: number;
  readonly maxHeaderCount?: number;
  readonly maxBodyBytes?: number;
}

export interface TraceKernelHttp1Header {
  readonly name: string;
  readonly value: string;
}

export interface TraceKernelHttp1Request {
  readonly kind: 'request';
  readonly method: string;
  readonly target: string;
  readonly version: 'HTTP/1.1';
  readonly headers: readonly TraceKernelHttp1Header[];
  readonly body: Uint8Array;
}

export interface TraceKernelHttp1Response {
  readonly kind: 'response';
  readonly version: 'HTTP/1.1';
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly TraceKernelHttp1Header[];
  readonly body: Uint8Array;
}

export type TraceKernelHttp1Message =
  | TraceKernelHttp1Request
  | TraceKernelHttp1Response;

interface NormalizedLimits {
  readonly maxStartLineBytes: number;
  readonly maxHeaderBytes: number;
  readonly maxHeaderCount: number;
  readonly maxBodyBytes: number;
}

export class TraceKernelHttp1Error extends Error {
  readonly name = 'TraceKernelHttp1Error';

  constructor(
    readonly code: 'E2BIG' | 'EPROTO',
    message: string
  ) {
    super(`${code}: ${message}`);
  }
}

function limits(options: TraceKernelHttp1Limits = {}): NormalizedLimits {
  return Object.freeze({
    maxStartLineBytes: Math.max(1, Math.floor(options.maxStartLineBytes ?? 8 * 1024)),
    maxHeaderBytes: Math.max(4, Math.floor(options.maxHeaderBytes ?? 64 * 1024)),
    maxHeaderCount: Math.max(0, Math.floor(options.maxHeaderCount ?? 128)),
    maxBodyBytes: Math.max(0, Math.floor(options.maxBodyBytes ?? 4 * 1024 * 1024)),
  });
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function indexOfBytes(bytes: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = 0; index <= bytes.byteLength - needle.byteLength; index += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function headerValue(
  headers: readonly TraceKernelHttp1Header[],
  name: string
): string | undefined {
  const values = headers
    .filter((header) => header.name.toLowerCase() === name)
    .map((header) => header.value);
  return values.length === 0 ? undefined : values.join(',');
}

function parseContentLength(
  headers: readonly TraceKernelHttp1Header[],
  normalized: NormalizedLimits
): number {
  const transferEncoding = headerValue(headers, 'transfer-encoding');
  if (transferEncoding && transferEncoding.toLowerCase() !== 'identity') {
    throw new TraceKernelHttp1Error(
      'EPROTO',
      `unsupported transfer-encoding ${JSON.stringify(transferEncoding)}`
    );
  }
  const value = headerValue(headers, 'content-length');
  if (value === undefined) return 0;
  const parts = value.split(',').map((part) => part.trim());
  if (
    parts.length === 0 ||
    parts.some((part) => !/^(0|[1-9][0-9]*)$/.test(part)) ||
    parts.some((part) => part !== parts[0])
  ) {
    throw new TraceKernelHttp1Error('EPROTO', 'invalid or conflicting content-length');
  }
  const length = Number(parts[0]);
  if (!Number.isSafeInteger(length)) {
    throw new TraceKernelHttp1Error('EPROTO', 'content-length exceeds integer range');
  }
  if (length > normalized.maxBodyBytes) {
    throw new TraceKernelHttp1Error(
      'E2BIG',
      `HTTP body exceeds ${normalized.maxBodyBytes} bytes`
    );
  }
  return length;
}

function parseHead(
  bytes: Uint8Array,
  kind: TraceKernelHttp1Message['kind'],
  normalized: NormalizedLimits
): {
  readonly startLine: string;
  readonly headers: readonly TraceKernelHttp1Header[];
} {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new TraceKernelHttp1Error('EPROTO', 'HTTP head is not valid UTF-8');
  }
  const lines = text.split('\r\n');
  const startLine = lines.shift() ?? '';
  if (encoder.encode(startLine).byteLength > normalized.maxStartLineBytes) {
    throw new TraceKernelHttp1Error(
      'E2BIG',
      `HTTP start line exceeds ${normalized.maxStartLineBytes} bytes`
    );
  }
  if (!startLine) {
    throw new TraceKernelHttp1Error('EPROTO', `empty HTTP ${kind} start line`);
  }
  if (lines.length > normalized.maxHeaderCount) {
    throw new TraceKernelHttp1Error(
      'E2BIG',
      `HTTP header count exceeds ${normalized.maxHeaderCount}`
    );
  }
  const headers = lines.map((line): TraceKernelHttp1Header => {
    if (/^[ \t]/.test(line)) {
      throw new TraceKernelHttp1Error('EPROTO', 'obsolete folded headers are not accepted');
    }
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw new TraceKernelHttp1Error('EPROTO', `malformed HTTP header ${JSON.stringify(line)}`);
    }
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (!TOKEN.test(name) || /[\0\r\n]/.test(value)) {
      throw new TraceKernelHttp1Error('EPROTO', `invalid HTTP header ${JSON.stringify(name)}`);
    }
    return Object.freeze({ name, value });
  });
  return Object.freeze({ startLine, headers: Object.freeze(headers) });
}

function requestFrom(
  startLine: string,
  headers: readonly TraceKernelHttp1Header[],
  body: Uint8Array
): TraceKernelHttp1Request {
  const match = /^([^ ]+) ([^ ]+) HTTP\/1\.1$/.exec(startLine);
  if (!match || !TOKEN.test(match[1] ?? '') || !(match[2] ?? '').startsWith('/')) {
    throw new TraceKernelHttp1Error('EPROTO', `malformed HTTP request line ${JSON.stringify(startLine)}`);
  }
  return Object.freeze({
    kind: 'request',
    method: match[1]!,
    target: match[2]!,
    version: 'HTTP/1.1',
    headers,
    body: Uint8Array.from(body),
  });
}

function responseFrom(
  startLine: string,
  headers: readonly TraceKernelHttp1Header[],
  body: Uint8Array
): TraceKernelHttp1Response {
  const match = /^HTTP\/1\.1 ([0-9]{3})(?: (.*))?$/.exec(startLine);
  const status = Number(match?.[1]);
  if (!match || status < 100 || status > 999) {
    throw new TraceKernelHttp1Error('EPROTO', `malformed HTTP response line ${JSON.stringify(startLine)}`);
  }
  return Object.freeze({
    kind: 'response',
    version: 'HTTP/1.1',
    status,
    statusText: match[2] ?? '',
    headers,
    body: Uint8Array.from(body),
  });
}

/**
 * Incremental one-message HTTP/1.1 decoder.
 *
 * The decoder deliberately rejects pipelined trailing bytes and unsupported
 * transfer codings. Connection reuse and chunked coding can be layered later
 * without weakening the bounded one-message contract used by the first local
 * HTTP-over-TCP migration.
 */
export class TraceKernelHttp1Decoder<
  Kind extends TraceKernelHttp1Message['kind']
> {
  private bytes: Uint8Array = new Uint8Array();
  private headEnd = -1;
  private bodyLength?: number;
  private completed = false;
  private readonly normalized: NormalizedLimits;

  constructor(
    private readonly kind: Kind,
    options: TraceKernelHttp1Limits = {}
  ) {
    this.normalized = limits(options);
  }

  push(chunk: Uint8Array): Extract<TraceKernelHttp1Message, { kind: Kind }> | null {
    if (this.completed) {
      throw new TraceKernelHttp1Error('EPROTO', 'HTTP decoder already completed');
    }
    this.bytes = concat(this.bytes, Uint8Array.from(chunk));
    if (this.headEnd < 0) {
      this.headEnd = indexOfBytes(this.bytes, HEADER_END);
      if (this.headEnd < 0) {
        if (this.bytes.byteLength > this.normalized.maxHeaderBytes) {
          throw new TraceKernelHttp1Error(
            'E2BIG',
            `HTTP head exceeds ${this.normalized.maxHeaderBytes} bytes`
          );
        }
        return null;
      }
      const headBytes = this.headEnd + HEADER_END.byteLength;
      if (headBytes > this.normalized.maxHeaderBytes) {
        throw new TraceKernelHttp1Error(
          'E2BIG',
          `HTTP head exceeds ${this.normalized.maxHeaderBytes} bytes`
        );
      }
      const parsed = parseHead(
        this.bytes.slice(0, this.headEnd),
        this.kind,
        this.normalized
      );
      this.bodyLength = parseContentLength(parsed.headers, this.normalized);
    }
    const messageLength = this.headEnd + HEADER_END.byteLength + (this.bodyLength ?? 0);
    if (this.bytes.byteLength < messageLength) return null;
    if (this.bytes.byteLength > messageLength) {
      throw new TraceKernelHttp1Error(
        'EPROTO',
        'trailing bytes after one-message HTTP frame'
      );
    }
    const parsed = parseHead(
      this.bytes.slice(0, this.headEnd),
      this.kind,
      this.normalized
    );
    const body = this.bytes.slice(this.headEnd + HEADER_END.byteLength);
    this.completed = true;
    return (
      this.kind === 'request'
        ? requestFrom(parsed.startLine, parsed.headers, body)
        : responseFrom(parsed.startLine, parsed.headers, body)
    ) as Extract<TraceKernelHttp1Message, { kind: Kind }>;
  }

  finish(): Extract<TraceKernelHttp1Message, { kind: Kind }> {
    const message = this.push(new Uint8Array());
    if (!message) {
      throw new TraceKernelHttp1Error('EPROTO', 'unexpected EOF in HTTP message');
    }
    return message;
  }
}

function encodeMessage(
  startLine: string,
  headers: readonly TraceKernelHttp1Header[],
  body: Uint8Array,
  options: TraceKernelHttp1Limits
): Uint8Array {
  const normalized = limits(options);
  if (encoder.encode(startLine).byteLength > normalized.maxStartLineBytes) {
    throw new TraceKernelHttp1Error('E2BIG', 'HTTP start line exceeds configured limit');
  }
  if (headers.length > normalized.maxHeaderCount) {
    throw new TraceKernelHttp1Error('E2BIG', 'HTTP header count exceeds configured limit');
  }
  if (body.byteLength > normalized.maxBodyBytes) {
    throw new TraceKernelHttp1Error('E2BIG', 'HTTP body exceeds configured limit');
  }
  const outputHeaders = [...headers];
  const hasDeclaredLength = headerValue(outputHeaders, 'content-length') !== undefined;
  if (!hasDeclaredLength) {
    outputHeaders.push({ name: 'Content-Length', value: String(body.byteLength) });
  }
  if (parseContentLength(outputHeaders, normalized) !== body.byteLength) {
    throw new TraceKernelHttp1Error('EPROTO', 'content-length does not match HTTP body');
  }
  const lines = outputHeaders.map(({ name, value }) => {
    if (!TOKEN.test(name) || /[\0\r\n]/.test(value)) {
      throw new TraceKernelHttp1Error('EPROTO', `invalid HTTP header ${JSON.stringify(name)}`);
    }
    return `${name}: ${value}`;
  });
  const head = encoder.encode(`${startLine}\r\n${lines.join('\r\n')}\r\n\r\n`);
  if (head.byteLength > normalized.maxHeaderBytes) {
    throw new TraceKernelHttp1Error('E2BIG', 'HTTP head exceeds configured limit');
  }
  return concat(head, body);
}

export function encodeTraceKernelHttp1Request(
  request: Omit<TraceKernelHttp1Request, 'kind' | 'version'>,
  options: TraceKernelHttp1Limits = {}
): Uint8Array {
  if (!TOKEN.test(request.method) || !request.target.startsWith('/')) {
    throw new TraceKernelHttp1Error('EPROTO', 'invalid HTTP request target or method');
  }
  return encodeMessage(
    `${request.method} ${request.target} HTTP/1.1`,
    request.headers,
    request.body,
    options
  );
}

export function encodeTraceKernelHttp1Response(
  response: Omit<TraceKernelHttp1Response, 'kind' | 'version'>,
  options: TraceKernelHttp1Limits = {}
): Uint8Array {
  if (
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 999 ||
    /[\0\r\n]/.test(response.statusText)
  ) {
    throw new TraceKernelHttp1Error('EPROTO', 'invalid HTTP response status');
  }
  return encodeMessage(
    `HTTP/1.1 ${response.status} ${response.statusText}`,
    response.headers,
    response.body,
    options
  );
}

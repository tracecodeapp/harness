const TRACE_EVENT_TRANSFER_SCHEMA = 'tracecode.trace-events.transfer.v1';

const TRACE_EVENT_TRANSFER_CHUNK_BYTES = 64 * 1024;
const TRACE_EVENT_TRANSFER_MIN_BYTES = 64 * 1024;
const TRACE_EVENT_TRANSFER_MIN_EVENTS = 128;
const TRACE_EVENT_TRANSFER_MAX_CHUNK_BYTES = 256 * 1024;
const TRACE_EVENT_TRANSFER_MAX_BYTES = 64 * 1024 * 1024;
const TRACE_EVENT_TRANSFER_MAX_CHUNKS = 4096;
const TRACE_EVENT_TRANSFER_MAX_EVENTS = 1_000_000;

export interface TraceEventTransferRequest {
  schema: typeof TRACE_EVENT_TRANSFER_SCHEMA;
  encoding: 'json-utf8';
  maxChunkBytes: number;
  minTransferBytes: number;
  minEventCount: number;
}

interface TraceEventTransferDescriptor {
  schema: typeof TRACE_EVENT_TRANSFER_SCHEMA;
  encoding: 'json-utf8';
  path: 'trace.events' | 'events' | 'results[].trace.events';
  eventCount: number;
  eventCounts?: number[];
  byteLength: number;
  chunks: ArrayBuffer[];
}

type TraceTransportEnvelope = Record<string, unknown> & {
  __traceEventTransport?: unknown;
};

/**
 * Opt-in negotiation keeps a newer worker compatible with older clients. The
 * worker only strips events from its normal result when the request carries
 * this exact capability descriptor.
 */
export function traceEventTransferRequest(): TraceEventTransferRequest {
  return {
    schema: TRACE_EVENT_TRANSFER_SCHEMA,
    encoding: 'json-utf8',
    maxChunkBytes: TRACE_EVENT_TRANSFER_CHUNK_BYTES,
    minTransferBytes: TRACE_EVENT_TRANSFER_MIN_BYTES,
    minEventCount: TRACE_EVENT_TRANSFER_MIN_EVENTS,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseNonNegativeInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`Invalid trace event transfer ${label}.`);
  }
  return value as number;
}

function parseDescriptor(value: unknown): TraceEventTransferDescriptor {
  if (!isRecord(value)) throw new Error('Invalid trace event transfer descriptor.');
  if (value.schema !== TRACE_EVENT_TRANSFER_SCHEMA || value.encoding !== 'json-utf8') {
    throw new Error('Unsupported trace event transfer schema.');
  }
  if (value.path !== 'trace.events' && value.path !== 'events' && value.path !== 'results[].trace.events') {
    throw new Error('Invalid trace event transfer path.');
  }
  const eventCount = parseNonNegativeInteger(
    value.eventCount,
    'event count',
    TRACE_EVENT_TRANSFER_MAX_EVENTS
  );
  const byteLength = parseNonNegativeInteger(
    value.byteLength,
    'byte length',
    TRACE_EVENT_TRANSFER_MAX_BYTES
  );
  const eventCounts = value.path === 'results[].trace.events'
    ? (() => {
        if (!Array.isArray(value.eventCounts) || value.eventCounts.length === 0) {
          throw new Error('Trace event batch transfer did not contain per-result event counts.');
        }
        if (value.eventCounts.length > TRACE_EVENT_TRANSFER_MAX_EVENTS) {
          throw new Error('Trace event batch transfer contained too many results.');
        }
        const parsed = value.eventCounts.map((count) =>
          parseNonNegativeInteger(count, 'per-result event count', TRACE_EVENT_TRANSFER_MAX_EVENTS)
        );
        if (parsed.reduce((sum, count) => sum + count, 0) !== eventCount) {
          throw new Error('Trace event batch transfer event counts did not match the total.');
        }
        return parsed;
      })()
    : undefined;
  if (!Array.isArray(value.chunks) || value.chunks.length === 0) {
    throw new Error('Trace event transfer did not contain any chunks.');
  }
  if (value.chunks.length > TRACE_EVENT_TRANSFER_MAX_CHUNKS) {
    throw new Error('Trace event transfer contained too many chunks.');
  }
  const chunks = value.chunks.map((chunk) => {
    if (!(chunk instanceof ArrayBuffer)) {
      throw new Error('Trace event transfer contained a non-ArrayBuffer chunk.');
    }
    if (chunk.byteLength === 0 || chunk.byteLength > TRACE_EVENT_TRANSFER_MAX_CHUNK_BYTES) {
      throw new Error('Trace event transfer chunk exceeded its size bound.');
    }
    return chunk;
  });
  const actualByteLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (actualByteLength !== byteLength) {
    throw new Error('Trace event transfer byte length did not match its chunks.');
  }
  return {
    schema: TRACE_EVENT_TRANSFER_SCHEMA,
    encoding: 'json-utf8',
    path: value.path,
    eventCount,
    ...(eventCounts ? { eventCounts } : {}),
    byteLength,
    chunks,
  };
}

function decodeEvents(descriptor: TraceEventTransferDescriptor): unknown[] {
  const bytes = new Uint8Array(descriptor.byteLength);
  let offset = 0;
  for (const chunk of descriptor.chunks) {
    bytes.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(
      `Trace event transfer could not be decoded: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(decoded)) {
    throw new Error('Trace event transfer payload was not an array.');
  }
  if (descriptor.path !== 'results[].trace.events' && decoded.length !== descriptor.eventCount) {
    throw new Error('Trace event transfer event count did not match its payload.');
  }
  if (descriptor.path === 'results[].trace.events') {
    const eventCounts = descriptor.eventCounts ?? [];
    if (decoded.length !== eventCounts.length) {
      throw new Error('Trace event batch transfer result count did not match its payload.');
    }
    for (let index = 0; index < eventCounts.length; index += 1) {
      if (!Array.isArray(decoded[index]) || (decoded[index] as unknown[]).length !== eventCounts[index]) {
        throw new Error('Trace event batch transfer per-result event count did not match its payload.');
      }
    }
  }
  return decoded;
}

/**
 * Rehydrates the internal transferable representation before a public runtime
 * result is resolved. Legacy workers, small traces, and non-tracing responses
 * pass through unchanged.
 */
export function restoreTransferredTraceEvents(payload: unknown): unknown {
  if (!isRecord(payload) || !('__traceEventTransport' in payload)) return payload;
  const envelope = payload as TraceTransportEnvelope;
  const descriptor = parseDescriptor(envelope.__traceEventTransport);
  const events = decodeEvents(descriptor);
  const { __traceEventTransport: _transport, ...publicResult } = envelope;

  if (descriptor.path === 'results[].trace.events') {
    const eventCounts = descriptor.eventCounts ?? [];
    if (!Array.isArray(publicResult.results) || publicResult.results.length !== eventCounts.length) {
      throw new Error('Trace event batch transfer expected matching result placeholders.');
    }
    const results = publicResult.results.map((result, index) => {
      if (!isRecord(result) || !isRecord(result.trace) || !Array.isArray(result.trace.events) || result.trace.events.length !== 0) {
        throw new Error('Trace event batch transfer expected empty runtime trace event placeholders.');
      }
      return {
        ...result,
        trace: {
          ...result.trace,
          events: events[index],
        },
      };
    });
    return { ...publicResult, results };
  }

  if (descriptor.path === 'events') {
    if (!Array.isArray(publicResult.events) || publicResult.events.length !== 0) {
      throw new Error('Trace event transfer expected an empty result events placeholder.');
    }
    return { ...publicResult, events };
  }

  if (!isRecord(publicResult.trace) || !Array.isArray(publicResult.trace.events) || publicResult.trace.events.length !== 0) {
    throw new Error('Trace event transfer expected an empty runtime trace events placeholder.');
  }
  return {
    ...publicResult,
    trace: {
      ...publicResult.trace,
      events,
    },
  };
}

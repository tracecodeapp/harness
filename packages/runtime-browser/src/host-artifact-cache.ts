interface HostArtifactCacheEntry {
  readonly value: string;
  readonly bytes: number;
}

/**
 * Small host-owned LRU for immutable, content-addressed compiler output.
 *
 * The cache intentionally stores opaque strings. Language runtimes must
 * recompute and validate their artifact key before consuming a value. Keeping
 * this above the worker lifecycle lets safe mode retire every execution worker
 * without paying the compiler cost again.
 */
export class HostArtifactCache {
  private readonly entries = new Map<string, HostArtifactCacheEntry>();
  private retainedBytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 0) {
      throw new TypeError('Host artifact cache maxEntries must be a non-negative integer.');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new TypeError('Host artifact cache maxBytes must be a non-negative safe integer.');
    }
  }

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  put(key: string, value: string): boolean {
    if (!key || this.maxEntries === 0 || this.maxBytes === 0) return false;
    const bytes = new TextEncoder().encode(value).byteLength;
    if (bytes > this.maxBytes) return false;

    const prior = this.entries.get(key);
    if (prior) {
      this.retainedBytes -= prior.bytes;
      this.entries.delete(key);
    }
    this.entries.set(key, { value, bytes });
    this.retainedBytes += bytes;
    this.trim();
    return this.entries.has(key);
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get byteLength(): number {
    return this.retainedBytes;
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries || this.retainedBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) this.retainedBytes -= oldest.bytes;
    }
  }
}

export function handleHostArtifactCacheRequest(options: {
  readonly cache: HostArtifactCache;
  readonly message: WorkerSessionMessage;
  readonly worker: BrowserWorkerLike;
  readonly validateProtocolToken: (protocolToken: unknown) => boolean;
}): void {
  const { cache, message, worker, validateProtocolToken } = options;
  if (!validateProtocolToken(message.protocolToken) || !message.requestId) return;
  const payload = message.payload && typeof message.payload === 'object'
    ? message.payload as Record<string, unknown>
    : {};
  const key = typeof payload.key === 'string' ? payload.key : '';
  const operation = payload.operation;
  let value: string | undefined;
  let stored = false;
  if (operation === 'get' && key) {
    value = cache.get(key);
  } else if (operation === 'put' && key && typeof payload.value === 'string') {
    stored = cache.put(key, payload.value);
  }
  worker.postMessage({
    type: 'compiler-artifact-cache-response',
    requestId: message.requestId,
    protocolToken: message.protocolToken,
    payload: {
      hit: value !== undefined,
      ...(value === undefined ? {} : { value }),
      stored,
      entries: cache.size,
      bytes: cache.byteLength,
    },
  });
}
import type { BrowserWorkerLike } from './execution-host';
import type { WorkerSessionMessage } from './worker-session-core';

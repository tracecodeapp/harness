import type {
  RuntimePreparedExecutionProvider,
  RuntimePreparedProgram,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
} from '@tracecode/runtime-contracts';

/**
 * Content-keyed reuse for prepared programs.
 *
 * Evaluations prepare and dispose one program per run, so draining N traced
 * cases of the same solution as N single-case evaluations used to pay full
 * preparation (compile RPC, process lease, runtime warmup) N times. This
 * wrapper keys prepared programs by preparation content, hands each caller a
 * refcounted facade, and keeps the underlying program warm for a short idle
 * window after the last facade is disposed so back-to-back evaluations of the
 * same content reuse one prepared artifact.
 *
 * Correctness properties:
 * - The prepared-program contract (`fresh-case-state`) already requires that
 *   no mutable state flows between executions, so sharing one underlying
 *   program across sequential evaluations observes identical semantics.
 * - Failed preparations are never cached.
 * - Any rejected execution poisons the cache entry: in-flight facades keep
 *   their reference, but no new evaluation will be attached to the entry.
 * - Underlying `dispose()` runs exactly once, after the last facade releases
 *   it and the idle window (or an eviction/flush) ends its cache residency.
 */
export interface PreparedProgramReuseOptions {
  /** Distinct preparation contents kept warm at once. */
  readonly maxEntries?: number;
  /** How long an unreferenced program stays warm before disposal. */
  readonly idleTtlMs?: number;
}

interface CacheEntry {
  readonly key: string;
  readonly program: RuntimePreparedProgram;
  readonly result: RuntimeProgramPreparationResult & { kind: 'prepared' };
  references: number;
  poisoned: boolean;
  /** True once the entry left the cache map; dispose when references hit 0. */
  evicted: boolean;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  lastUsedAt: number;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
}

function preparationKey(call: RuntimeProgramPreparationCall): string {
  return stableStringify({
    mode: call.mode,
    code: call.code,
    functionName: call.functionName,
    executionStyle: call.executionStyle ?? null,
    traceOptions: call.traceOptions ?? null,
  });
}

export interface ReusablePreparedProvider
  extends RuntimePreparedExecutionProvider {
  /** Dispose every cached prepared program immediately. */
  flushPreparedProgramCache(): void;
}

export function withPreparedProgramReuse(
  delegate: RuntimePreparedExecutionProvider,
  options: PreparedProgramReuseOptions = {}
): ReusablePreparedProvider {
  const maxEntries = options.maxEntries ?? 2;
  const idleTtlMs = options.idleTtlMs ?? 30_000;
  const entries = new Map<string, CacheEntry>();
  const pending = new Map<string, Promise<RuntimeProgramPreparationResult>>();

  function disposeUnderlying(entry: CacheEntry): void {
    void entry.program.dispose().catch(() => {
      // Disposal failures of an already-released program are not actionable
      // for the evaluation that triggered them.
    });
  }

  function evict(entry: CacheEntry): void {
    if (entry.evicted) return;
    entry.evicted = true;
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    entries.delete(entry.key);
    if (entry.references === 0) disposeUnderlying(entry);
  }

  function scheduleIdleDisposal(entry: CacheEntry): void {
    if (entry.evicted) {
      if (entry.references === 0) disposeUnderlying(entry);
      return;
    }
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.references === 0) evict(entry);
    }, idleTtlMs);
  }

  function evictLeastRecentlyUsedBeyondCap(): void {
    while (entries.size > maxEntries) {
      let oldest: CacheEntry | undefined;
      for (const entry of entries.values()) {
        if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) oldest = entry;
      }
      if (!oldest) return;
      evict(oldest);
    }
  }

  function facadeFor(entry: CacheEntry): RuntimePreparedProgram {
    entry.references += 1;
    entry.lastUsedAt = Date.now();
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.references -= 1;
      if (entry.references === 0) scheduleIdleDisposal(entry);
    };
    const guard = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        // A failed execution may mean the underlying process is gone; stop
        // attaching new evaluations to this preparation.
        entry.poisoned = true;
        evict(entry);
        throw error;
      }
    };
    const program = entry.program;
    const facade = {
      mode: program.mode,
      capabilities: program.capabilities,
      executeIsolated: (call: never) =>
        guard(() => program.executeIsolated(call)),
      ...(program.executeBatchIsolated
        ? {
            executeBatchIsolated: (call: never) =>
              guard(() => program.executeBatchIsolated!(call)),
          }
        : {}),
      dispose: async (): Promise<void> => {
        release();
      },
    };
    return facade as unknown as RuntimePreparedProgram;
  }

  return {
    init: () => delegate.init(),
    async prepareProgram(
      call: RuntimeProgramPreparationCall
    ): Promise<RuntimeProgramPreparationResult> {
      const key = preparationKey(call);
      const cached = entries.get(key);
      if (cached && !cached.poisoned) {
        return { ...cached.result, program: facadeFor(cached) };
      }
      const inFlight = pending.get(key);
      if (inFlight) {
        const settled = await inFlight;
        const entry = entries.get(key);
        if (settled.kind === 'prepared' && entry && !entry.poisoned) {
          return { ...entry.result, program: facadeFor(entry) };
        }
        // The concurrent preparation failed or was evicted; prepare afresh.
      }
      const preparation = (async () => {
        const result = await delegate.prepareProgram(call);
        if (result.kind !== 'prepared') return result;
        const entry: CacheEntry = {
          key,
          program: result.program,
          result,
          references: 0,
          poisoned: false,
          evicted: false,
          idleTimer: undefined,
          lastUsedAt: Date.now(),
        };
        entries.set(key, entry);
        evictLeastRecentlyUsedBeyondCap();
        return result;
      })();
      pending.set(key, preparation);
      try {
        const result = await preparation;
        if (result.kind !== 'prepared') return result;
        const entry = entries.get(key);
        if (!entry || entry.poisoned) {
          // Evicted before first use (cap pressure); hand the caller the
          // underlying program directly with single-owner semantics.
          return result;
        }
        return { ...entry.result, program: facadeFor(entry) };
      } finally {
        if (pending.get(key) === preparation) pending.delete(key);
      }
    },
    flushPreparedProgramCache(): void {
      for (const entry of [...entries.values()]) evict(entry);
    },
  };
}

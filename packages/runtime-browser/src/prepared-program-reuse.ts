import type {
  RuntimePreparedExecutionProvider,
  RuntimePreparedProgram,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
} from '@tracecode/runtime-contracts';
import {
  preparedRuntimeAbortError,
  RuntimeProgramConcurrencyGate,
} from './program-concurrency-gate';

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
  readonly gate: RuntimeProgramConcurrencyGate;
  references: number;
  /** Callers already awaiting this preparation but not yet holding a facade. */
  pendingClaims: number;
  poisoned: boolean;
  /** True once the entry left the cache map; dispose when references hit 0. */
  evicted: boolean;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  lastUsedAt: number;
}

interface PendingPreparation {
  readonly promise: Promise<RuntimeProgramPreparationResult>;
  readonly controller: AbortController;
  claimants: number;
}

function waitForCaller<Result>(
  promise: Promise<Result>,
  signal: AbortSignal | undefined
): Promise<Result> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(preparedRuntimeAbortError(signal));
  }
  return new Promise<Result>((resolve, reject) => {
    const onAbort = () => reject(preparedRuntimeAbortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
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
  const pending = new Map<string, PendingPreparation>();
  let generation = 0;

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
        if (entry.references > 0 || entry.pendingClaims > 0) continue;
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
      if (entry.references === 0) {
        evictLeastRecentlyUsedBeyondCap();
        if (!entry.evicted) scheduleIdleDisposal(entry);
      }
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
        entry.gate.run(
          (call as { signal?: AbortSignal }).signal,
          () => guard(() => program.executeIsolated(call))
        ),
      ...(program.executeBatchIsolated
        ? {
            executeBatchIsolated: (call: never) =>
              entry.gate.run(
                (call as { signal?: AbortSignal }).signal,
                () => guard(() => program.executeBatchIsolated!(call))
              ),
          }
        : {}),
      dispose: async (): Promise<void> => {
        release();
      },
    };
    return facade as unknown as RuntimePreparedProgram;
  }

  function claimEntry(entry: CacheEntry): RuntimePreparedProgram {
    const facade = facadeFor(entry);
    evictLeastRecentlyUsedBeyondCap();
    return facade;
  }

  function claimPendingEntry(
    entry: CacheEntry,
    preparation: PendingPreparation
  ): RuntimePreparedProgram {
    preparation.claimants -= 1;
    entry.pendingClaims -= 1;
    return claimEntry(entry);
  }

  function abandonPendingClaim(
    key: string,
    preparation: PendingPreparation
  ): void {
    preparation.claimants -= 1;
    const entry = entries.get(key);
    if (!entry) return;
    entry.pendingClaims -= 1;
    queueMicrotask(() => {
      if (entry.references !== 0 || entry.pendingClaims !== 0) return;
      evictLeastRecentlyUsedBeyondCap();
      if (!entry.evicted) scheduleIdleDisposal(entry);
    });
  }

  return {
    init: () => delegate.init(),
    async prepareProgram(
      call: RuntimeProgramPreparationCall
    ): Promise<RuntimeProgramPreparationResult> {
      if (call.signal?.aborted) {
        throw preparedRuntimeAbortError(call.signal);
      }
      const key = preparationKey(call);
      const cached = entries.get(key);
      if (cached && !cached.poisoned) {
        return { ...cached.result, program: claimEntry(cached) };
      }
      const inFlight = pending.get(key);
      if (inFlight) {
        inFlight.claimants += 1;
        let settled: RuntimeProgramPreparationResult;
        try {
          settled = await waitForCaller(inFlight.promise, call.signal);
        } catch (error) {
          abandonPendingClaim(key, inFlight);
          throw error;
        }
        const entry = entries.get(key);
        if (settled.kind === 'prepared' && entry && !entry.poisoned) {
          return { ...entry.result, program: claimPendingEntry(entry, inFlight) };
        }
        abandonPendingClaim(key, inFlight);
        if (settled.kind !== 'prepared') return settled;
        // Cap pressure evicted the concurrent result before this waiter could
        // claim it. Prepare a new artifact rather than returning disposed state.
      }
      const preparationGeneration = generation;
      const controller = new AbortController();
      let pendingPreparation!: PendingPreparation;
      const preparation = (async () => {
        const result = await delegate.prepareProgram({
          ...call,
          signal: controller.signal,
        });
        if (result.kind !== 'prepared') return result;
        if (generation !== preparationGeneration) {
          await result.program.dispose();
          throw new Error(
            'Prepared program cache was flushed while preparation was in flight.'
          );
        }
        const entry: CacheEntry = {
          key,
          program: result.program,
          result,
          gate: new RuntimeProgramConcurrencyGate(
            result.program.capabilities.maxConcurrency
          ),
          references: 0,
          pendingClaims: pendingPreparation.claimants,
          poisoned: false,
          evicted: false,
          idleTimer: undefined,
          lastUsedAt: Date.now(),
        };
        entries.set(key, entry);
        return result;
      })();
      pendingPreparation = { promise: preparation, controller, claimants: 1 };
      pending.set(key, pendingPreparation);
      void preparation.then(
        () => {
          if (pending.get(key) === pendingPreparation) pending.delete(key);
          queueMicrotask(() => {
            const entry = entries.get(key);
            if (entry && entry.references === 0) {
              evictLeastRecentlyUsedBeyondCap();
              if (!entry.evicted) scheduleIdleDisposal(entry);
            }
          });
        },
        () => {
          if (pending.get(key) === pendingPreparation) pending.delete(key);
        }
      );
      let result: RuntimeProgramPreparationResult;
      try {
        result = await waitForCaller(preparation, call.signal);
      } catch (error) {
        abandonPendingClaim(key, pendingPreparation);
        throw error;
      }
      if (result.kind !== 'prepared') {
        abandonPendingClaim(key, pendingPreparation);
        return result;
      }
      const entry = entries.get(key);
      if (!entry || entry.poisoned) {
        abandonPendingClaim(key, pendingPreparation);
        throw new Error(
          'Prepared program left the reuse cache before its first execution.'
        );
      }
      return {
        ...entry.result,
        program: claimPendingEntry(entry, pendingPreparation),
      };
    },
    flushPreparedProgramCache(): void {
      generation += 1;
      const reason = new Error(
        'Prepared program cache was flushed while preparation was in flight.'
      );
      for (const preparation of pending.values()) {
        preparation.controller.abort(reason);
      }
      pending.clear();
      for (const entry of [...entries.values()]) evict(entry);
    },
  };
}

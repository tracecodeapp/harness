import type {
  CodeExecutionResult,
  ExecutionResult,
  RuntimeClient,
  RuntimeCodeCall,
  RuntimeCommandResult,
  RuntimeExecuteCodeRequest,
  RuntimeExecuteProjectRequest,
  RuntimeExecuteRequest,
  RuntimeExecuteResponse,
  RuntimeExecuteResult,
  RuntimeTraceCall,
} from '@tracecode/harness-core';

/**
 * Serializes executions and retires the provider worker after every request.
 * Runtime assets may still be cached by the browser, but no mutable
 * interpreter/VM state crosses an execution boundary.
 */
export class FreshWorkerRuntimeClient implements RuntimeClient {
  private tail: Promise<void> = Promise.resolve();
  private preparation: Promise<{ success: boolean; loadTimeMs: number }> | null = null;
  private generation = 1;

  constructor(
    private readonly inner: RuntimeClient,
    private readonly lifecycle: {
      retireWorker: () => void;
      prepareWorker: () => Promise<{ success: boolean; loadTimeMs: number }>;
      prewarmAfterUse?: boolean;
      beforeExecution?: () => Promise<void>;
      runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
    }
  ) {}

  init(): Promise<{ success: boolean; loadTimeMs: number }> {
    return this.serialized(() => this.inner.init(), false);
  }

  execute(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult>;
  execute(request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResponse> {
    return this.serialized(() => this.inner.execute(request), true);
  }

  executeWithTracing(call: RuntimeTraceCall): Promise<ExecutionResult> {
    return this.serialized(() => this.inner.executeWithTracing(call), true);
  }

  executeCode(call: RuntimeCodeCall): Promise<CodeExecutionResult> {
    return this.serialized(() => this.inner.executeCode(call), true);
  }

  /**
   * Warm a worker that has never observed learner code. Repeated calls share
   * the same preparation, so callers can start this during idle UI time.
   */
  prepare(): Promise<{ success: boolean; loadTimeMs: number }> {
    if (this.preparation) return this.preparation;
    const preparationGeneration = this.generation;
    const preparation = this.lifecycle.prepareWorker().then(
      (result) => {
        if (preparationGeneration !== this.generation) {
          this.lifecycle.retireWorker();
          throw new Error('Fresh runtime worker preparation was superseded.');
        }
        return result;
      },
      (error) => {
        if (preparationGeneration === this.generation) {
          this.generation += 1;
          this.preparation = null;
          this.lifecycle.retireWorker();
        }
        throw error;
      }
    );
    this.preparation = preparation;
    void preparation.catch(() => undefined);
    return preparation;
  }

  /** Retire both a dirty execution worker and any clean standby. */
  reset(): void {
    this.generation += 1;
    this.preparation = null;
    this.lifecycle.retireWorker();
  }

  private serialized<T>(operation: () => Promise<T>, retireAfter: boolean): Promise<T> {
    const result = this.tail.then(async () => {
      // A failed background warmup has already retired its worker. Let the
      // runtime client's normal cold-start retry path handle this execution.
      if (this.preparation) await this.preparation.catch(() => undefined);
      const run = async () => {
        if (this.lifecycle.beforeExecution) await this.lifecycle.beforeExecution();
        try {
          return await operation();
        } finally {
          if (retireAfter) this.reset();
        }
      };
      try {
        return this.lifecycle.runExclusive
          ? await this.lifecycle.runExclusive(run)
          : await run();
      } finally {
        // Replenish only after first use. Harness construction remains lazy,
        // while the next request can lease a fully warm, still-clean worker.
        if (retireAfter && (this.lifecycle.prewarmAfterUse ?? true)) {
          void this.prepare().catch(() => undefined);
        }
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

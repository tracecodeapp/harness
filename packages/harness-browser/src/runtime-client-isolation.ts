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

  constructor(
    private readonly inner: RuntimeClient,
    private readonly retireWorker: () => void
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

  private serialized<T>(operation: () => Promise<T>, retireAfter: boolean): Promise<T> {
    const result = this.tail.then(async () => {
      try {
        return await operation();
      } finally {
        if (retireAfter) this.retireWorker();
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

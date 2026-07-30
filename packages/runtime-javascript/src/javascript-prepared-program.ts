import type {
  CodeExecutionResult,
  ExecutionResult,
  RuntimePreparedCodeCall,
  RuntimePreparedProgram,
  RuntimePreparedProgramMode,
  RuntimePreparedTraceCall,
} from '@tracecode/runtime-contracts';

interface LinkedAbortSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function linkAbortSignals(
  lifecycleSignal: AbortSignal,
  callerSignal?: AbortSignal
): LinkedAbortSignal {
  const controller = new AbortController();
  const registrations: Array<{
    readonly signal: AbortSignal;
    readonly listener: () => void;
  }> = [];

  const link = (signal: AbortSignal): void => {
    const listener = () => controller.abort(signal.reason);
    if (signal.aborted) {
      listener();
      return;
    }
    signal.addEventListener('abort', listener, { once: true });
    registrations.push({ signal, listener });
  };

  link(lifecycleSignal);
  if (callerSignal) link(callerSignal);

  return {
    signal: controller.signal,
    dispose(): void {
      for (const registration of registrations) {
        registration.signal.removeEventListener(
          'abort',
          registration.listener
        );
      }
    },
  };
}

export interface JavaScriptPreparedProgramOperations {
  readonly mode: RuntimePreparedProgramMode;
  executeCode?(
    call: RuntimePreparedCodeCall,
    signal: AbortSignal
  ): Promise<CodeExecutionResult>;
  executeTrace?(
    call: RuntimePreparedTraceCall,
    signal: AbortSignal
  ): Promise<ExecutionResult>;
  dispose?(): void | Promise<void>;
}

/**
 * Owns the lifecycle of one immutable JavaScript/TypeScript preparation.
 *
 * The artifact itself stays in the worker client closure. This owner only
 * coordinates execution cancellation and exactly-once disposal, so the
 * public prepared-program object cannot expose or mutate compiler output.
 */
export function createJavaScriptPreparedProgram(
  operations: JavaScriptPreparedProgramOperations
): RuntimePreparedProgram {
  const lifecycle = new AbortController();
  const active = new Set<Promise<unknown>>();
  let disposed = false;
  let disposePromise: Promise<void> | null = null;

  const run = <T>(
    callerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    if (disposed) {
      return Promise.reject(
        abortError('Prepared JavaScript program has been disposed.')
      );
    }
    if (callerSignal?.aborted) {
      return Promise.reject(abortError('Prepared JavaScript execution aborted.'));
    }

    const linked = linkAbortSignals(lifecycle.signal, callerSignal);
    const pending = Promise.resolve()
      .then(() => {
        if (linked.signal.aborted) {
          throw abortError('Prepared JavaScript execution aborted.');
        }
        return operation(linked.signal);
      })
      .finally(() => {
        linked.dispose();
        active.delete(pending);
      });
    active.add(pending);
    return pending;
  };

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    lifecycle.abort(
      abortError('Prepared JavaScript program was disposed during execution.')
    );
    disposePromise = Promise.allSettled([...active]).then(async () => {
      await operations.dispose?.();
    });
    return disposePromise;
  };

  if (operations.mode === 'code') {
    if (!operations.executeCode) {
      throw new TypeError(
        'Prepared JavaScript code program requires executeCode.'
      );
    }
    return Object.freeze({
      mode: 'code' as const,
      capabilities: Object.freeze({
        caseIsolation: 'fresh-case-state' as const,
        maxConcurrency: 1,
      }),
      executeIsolated: (call: RuntimePreparedCodeCall) =>
        run(call.signal, (signal) =>
          operations.executeCode!({ ...call, signal }, signal)
        ),
      dispose,
    });
  }

  if (!operations.executeTrace) {
    throw new TypeError(
      'Prepared JavaScript trace program requires executeTrace.'
    );
  }
  return Object.freeze({
    mode: 'trace' as const,
    capabilities: Object.freeze({
      caseIsolation: 'fresh-case-state' as const,
      maxConcurrency: 1,
    }),
    executeIsolated: (call: RuntimePreparedTraceCall) =>
      run(call.signal, (signal) =>
        operations.executeTrace!({ ...call, signal }, signal)
      ),
    dispose,
  });
}

/**
 * Tagged transport/lifecycle errors for browser worker clients.
 *
 * These classify failures of the worker infrastructure itself: spawn, bootstrap,
 * request round-trips, crashes, and teardown. A user program failing is not an
 * error at this layer — it travels as data inside a successful result
 * (`success: false`), never through these classes.
 *
 * Messages are load-bearing: consumers and tests assert on exact substrings
 * (e.g. focused worker tests match 'Worker request timed out:'),
 * so each class reproduces the historical message verbatim.
 */

import * as Data from 'effect/Data';

/** A request/response round-trip to the worker exceeded its deadline. */
export class WorkerRequestTimeoutError extends Data.TaggedError('WorkerRequestTimeoutError')<{
  readonly messageType: string;
  readonly timeoutMs: number;
}> {
  constructor(args: { readonly messageType: string; readonly timeoutMs: number }) {
    super(args);
    this.message = `Worker request timed out: ${args.messageType}`;
  }
}

/** The worker never posted its 'worker-ready' bootstrap signal in time. */
export class WorkerReadyTimeoutError extends Data.TaggedError('WorkerReadyTimeoutError')<{
  readonly runtimeLabel: string;
  readonly timeoutMs: number;
}> {
  constructor(args: { readonly runtimeLabel: string; readonly timeoutMs: number }) {
    super(args);
    this.message = `${args.runtimeLabel} worker failed to initialize in time (${Math.round(args.timeoutMs / 1000)}s)`;
  }
}

/** The worker was torn down (explicitly, or as recovery from a stuck state). */
export class WorkerTerminatedError extends Data.TaggedError('WorkerTerminatedError') {
  constructor(message: string = 'Worker was terminated') {
    super();
    this.message = message;
  }
}

/** The worker fired its `onerror` event (script crash, load failure). */
export class WorkerCrashedError extends Data.TaggedError('WorkerCrashedError')<{
  readonly workerMessage: string | undefined;
  readonly filename: string | undefined;
  readonly lineno: number | undefined;
  readonly colno: number | undefined;
}> {
  constructor(args: {
    readonly workerMessage: string | undefined;
    readonly filename: string | undefined;
    readonly lineno: number | undefined;
    readonly colno: number | undefined;
  }) {
    super(args);
    this.message = args.workerMessage || 'Worker error';
  }
}

/** A single execution exceeded its client-side deadline; the worker is presumed stuck. */
export class ExecutionTimeoutError extends Data.TaggedError('ExecutionTimeoutError')<{
  readonly timeoutMs: number;
  readonly runtimeLabel: string | undefined;
}> {
  constructor(args: { readonly timeoutMs: number; readonly runtimeLabel?: string }) {
    super({ timeoutMs: args.timeoutMs, runtimeLabel: args.runtimeLabel });
    const seconds = Math.round(args.timeoutMs / 1000);
    this.message = args.runtimeLabel
      ? `${args.runtimeLabel} execution timed out after ${seconds} seconds.`
      : `Execution timed out (possible infinite loop). Code execution was stopped after ${seconds} seconds.`;
  }
}

/**
 * Recognize execution deadlines across package/module boundaries.
 *
 * The browser package can be loaded once from source and once from a bundled
 * runtime (for example, by a worker entrypoint).  Those copies have distinct
 * class constructors, so `instanceof ExecutionTimeoutError` is not stable at
 * the API boundary.  The tagged-error discriminant is the shared contract.
 */
export function isExecutionTimeoutError(
  error: unknown
): error is ExecutionTimeoutError {
  return (
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    error._tag === 'ExecutionTimeoutError' &&
    'timeoutMs' in error &&
    typeof error.timeoutMs === 'number' &&
    Number.isFinite(error.timeoutMs) &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

/** The caller's AbortSignal fired mid-execution. */
export class ExecutionAbortedError extends Data.TaggedError('ExecutionAbortedError') {
  constructor() {
    super();
    this.message = 'Execution aborted';
    // runtime-project.ts detects aborts via `error.name === 'AbortError'` (DOM convention).
    this.name = 'AbortError';
  }
}

/** The worker script answered a request with an `error`-type reply. */
export class WorkerReportedError extends Data.TaggedError('WorkerReportedError')<{
  readonly workerMessage: string;
}> {
  constructor(args: { readonly workerMessage: string }) {
    super(args);
    this.message = args.workerMessage;
  }
}

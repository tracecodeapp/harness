import {
  RUNTIME_SIGNAL_EXIT_CODES,
  isRuntimeAbortError,
  isRuntimeTimeoutError,
  runtimeErrorMessage,
  runtimeFileChangeByteSize,
} from './runtime-command-internal';
import {
  RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES,
  RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGES,
  RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES,
  assertRuntimeFinalDiffBudget,
  createRuntimeProjectIoBridge,
  filterRuntimeCommandResultFiles,
  normalizeRuntimeFileChange,
  runtimeAbortSignalName,
  runtimeFileChangePath,
  runtimeProjectTruncateUtf8,
  runtimeProjectUtf8Bytes,
  runtimeSignalExitCode,
  type RuntimeCommandEvent,
  type RuntimeCommandEventHandler,
  type RuntimeCommandEventStream,
  type RuntimeCommandResult,
  type RuntimeProjectCommandRequest,
  type RuntimeProjectEngineLeaseController,
} from './runtime-command';
import type {
  RuntimeFileChange,
  RuntimeFileMutationPhase,
  RuntimeWorkspaceActor,
} from './runtime-workspace-manifest';

export function runtimeProjectInfrastructureFailure(
  error: unknown,
  signal: AbortSignal | undefined
): RuntimeCommandResult {
  const diagnostic = runtimeErrorMessage(error);
  const aborted = isRuntimeAbortError(error) || signal?.aborted;
  if (aborted) {
    const signalName = runtimeAbortSignalName(signal);
    const signalCode = RUNTIME_SIGNAL_EXIT_CODES.get(signalName) ?? RUNTIME_SIGNAL_EXIT_CODES.get('SIGTERM')!;
    return {
      stdout: '',
      stderr: '',
      exitCode: 128 + signalCode,
      error: {
        code: 'EINTR',
        errno: 4,
        syscall: 'wait4',
        message: 'Process interrupted by signal',
        detail: {
          signal: signalName,
          signalCode,
          diagnostic,
        },
      },
    };
  }
  if (isRuntimeTimeoutError(error)) {
    return {
      stdout: '',
      stderr: '',
      exitCode: 124,
      error: {
        code: 'ETIMEDOUT',
        errno: 110,
        message: 'Process timed out',
        detail: { diagnostic },
      },
    };
  }
  return {
    stdout: '',
    stderr: '',
    exitCode: runtimeSignalExitCode('SIGKILL'),
    error: {
      code: 'EIO',
      errno: 5,
      message: 'Runtime process terminated unexpectedly',
      detail: {
        signal: 'SIGKILL',
        signalCode: RUNTIME_SIGNAL_EXIT_CODES.get('SIGKILL')!,
        diagnostic,
      },
    },
  };
}

export class RuntimeProjectOutputTracker {
  private stdoutStreamed = '';
  private stderrStreamed = '';

  observe(event: RuntimeCommandEvent): void {
    if (event.type !== 'output') return;
    if (event.stream === 'stdout') this.stdoutStreamed += event.data;
    if (event.stream === 'stderr') this.stderrStreamed += event.data;
  }

  emitMissingFinalOutput(
    result: Pick<RuntimeCommandResult, 'stdout' | 'stderr'>,
    output: (stream: RuntimeCommandEventStream, data: string) => void
  ): void {
    this.emitMissingStreamOutput('stdout', result.stdout, this.stdoutStreamed, output);
    this.emitMissingStreamOutput('stderr', result.stderr, this.stderrStreamed, output);
  }

  /**
   * Return a complete final transcript when a command also emitted live output events.
   *
   * Nested commands can be interrupted after streaming output but before their parent has copied
   * that output into its returned result. In that case the returned value is a shorter prefix of
   * the transcript already shown in the terminal. Treating it as new output replays that prefix.
   */
  completeFinalOutput(
    result: Pick<RuntimeCommandResult, 'stdout' | 'stderr'>
  ): Pick<RuntimeCommandResult, 'stdout' | 'stderr'> {
    return {
      stdout: this.completeStreamOutput(result.stdout, this.stdoutStreamed),
      stderr: this.completeStreamOutput(result.stderr, this.stderrStreamed),
    };
  }

  private completeStreamOutput(finalOutput: string, streamedOutput: string): string {
    if (!streamedOutput) return finalOutput;
    if (!finalOutput) return streamedOutput;
    if (finalOutput.includes(streamedOutput)) return finalOutput;
    if (streamedOutput.includes(finalOutput)) return streamedOutput;

    // Some adapters return only the unstreamed tail. Preserve the live transcript and append only
    // the portion that does not overlap its suffix.
    const maximumOverlap = Math.min(streamedOutput.length, finalOutput.length);
    for (let overlap = maximumOverlap; overlap > 0; overlap -= 1) {
      if (streamedOutput.endsWith(finalOutput.slice(0, overlap))) {
        return `${streamedOutput}${finalOutput.slice(overlap)}`;
      }
    }
    return `${streamedOutput}${finalOutput}`;
  }

  private emitMissingStreamOutput(
    stream: RuntimeCommandEventStream,
    finalOutput: string,
    streamedOutput: string,
    output: (stream: RuntimeCommandEventStream, data: string) => void
  ): void {
    if (!finalOutput) return;
    if (!streamedOutput) {
      output(stream, finalOutput);
      return;
    }
    if (finalOutput.startsWith(streamedOutput)) {
      const suffix = finalOutput.slice(streamedOutput.length);
      if (suffix) output(stream, suffix);
    }
  }
}

export interface RuntimeProjectEventQueueOptions {
  actor?: RuntimeWorkspaceActor;
  signal?: AbortSignal;
  applyFileChange(
    change: RuntimeFileChange,
    phase: RuntimeFileMutationPhase,
    options?: RuntimeProjectFileChangeApplyOptions
  ): Promise<boolean | void>;
  emit(event: RuntimeCommandEvent): void;
}

async function awaitRuntimeAbortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (!signal) return { aborted: false, value: await promise };
  if (signal.aborted) return { aborted: true };
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ aborted: false, value });
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

export class RuntimeProjectEventQueue {
  private queue: Promise<void> = Promise.resolve();
  private failure: { error: unknown } | null = null;

  enqueue(event: RuntimeCommandEvent, options: RuntimeProjectEventQueueOptions): void {
    const execution = this.queue.then(async () => {
      if (this.failure) return;
      if (options.signal?.aborted) return;
      if (event.type !== 'file-change') {
        options.emit(event);
        return;
      }

      const change = normalizeRuntimeFileChange(event.change);
      const phase = event.phase ?? 'live';
      if (options.signal?.aborted) return;
      const applied = await awaitRuntimeAbortable(
        options.applyFileChange(change, phase, { signal: options.signal }),
        options.signal
      );
      if (!('value' in applied)) return;
      const shouldEmit = applied.value;
      if (options.signal?.aborted) return;
      if (shouldEmit === false) return;
      options.emit({
        ...event,
        change,
        phase,
        actor: event.actor ?? options.actor,
      });
    });
    // Own the rejection as soon as the work is created. A live runtime can
    // continue emitting events before its caller reaches flush(), and leaving
    // the rejection unattached until then makes Node report a false
    // unhandled-rejection failure. Preserve the first failure for flush while
    // keeping the serial queue usable for already-enqueued cleanup work.
    this.queue = execution.catch((error) => {
      this.failure ??= { error };
    });
  }

  async flush(): Promise<void> {
    const pending = this.queue;
    await pending;
    const failure = this.failure;
    this.failure = null;
    if (failure) throw failure.error;
  }
}

export interface RuntimeProjectFileChangeApplyOptions {
  signal?: AbortSignal;
}

export interface RuntimeProjectLiveIoControllerOptions {
  actor?: RuntimeWorkspaceActor;
  applyFileChange?: (
    change: RuntimeFileChange,
    phase: RuntimeFileMutationPhase,
    options?: RuntimeProjectFileChangeApplyOptions
  ) => Promise<boolean | void>;
  onEvent?: RuntimeCommandEventHandler;
  signal?: AbortSignal;
}

export class RuntimeProjectLiveIoController {
  private readonly outputTracker = new RuntimeProjectOutputTracker();
  private readonly eventQueue: RuntimeProjectEventQueue | null;
  private readonly abortController = new AbortController();
  private readonly abortInputSignal?: AbortSignal;
  private readonly abortInputListener?: () => void;
  private readonly appliedFileChanges = new Map<string, string>();
  private readonly outputBytes: Record<RuntimeCommandEventStream, number> = { stdout: 0, stderr: 0 };
  private readonly truncatedOutputStreams = new Set<RuntimeCommandEventStream>();
  private liveFileChangeCount = 0;
  private liveFileChangeBytes = 0;
  private pendingFileChanges = 0;
  private closed = false;

  constructor(private readonly options: RuntimeProjectLiveIoControllerOptions) {
    this.eventQueue = options.applyFileChange ? new RuntimeProjectEventQueue() : null;
    this.abortInputSignal = options.signal;
    if (options.signal?.aborted) {
      this.abortController.abort();
    } else if (options.signal) {
      this.abortInputListener = () => this.abortController.abort();
      options.signal.addEventListener('abort', this.abortInputListener, { once: true });
    }
  }

  emit(event: RuntimeCommandEvent): void {
    const budgetedEvent = this.applyEventBudgets(event);
    if (!budgetedEvent) return;
    this.outputTracker.observe(budgetedEvent);
    this.options.onEvent?.(budgetedEvent);
  }

  handleRuntimeEvent(event: RuntimeCommandEvent): void {
    if (this.closed || this.abortController.signal.aborted) return;
    if (event.type === 'file-change') {
      event = { ...event, change: normalizeRuntimeFileChange(event.change) };
    }
    if (event.type === 'file-change' && !this.eventQueue) this.recordLiveFileChangeBudget(event.change);
    if (event.type !== 'file-change' && this.pendingFileChanges === 0) {
      this.emit(event);
      return;
    }
    if (!this.eventQueue) {
      this.emit(event);
      return;
    }
    if (event.type === 'file-change') this.pendingFileChanges += 1;
    this.eventQueue.enqueue(event, {
      actor: this.options.actor,
      signal: this.abortController.signal,
      applyFileChange: async (change, phase, applyOptions) => {
        try {
          if (this.abortController.signal.aborted) return false;
          if (phase === 'live') this.recordLiveFileChangeBudget(change);
          if (this.abortController.signal.aborted) return false;
          const shouldEmit = await this.options.applyFileChange?.(change, phase, applyOptions);
          if (this.abortController.signal.aborted) return false;
          this.appliedFileChanges.set(runtimeFileChangePath(change), JSON.stringify(change));
          return shouldEmit;
        } finally {
          this.pendingFileChanges = Math.max(0, this.pendingFileChanges - 1);
        }
      },
      emit: (nextEvent) => this.emit(nextEvent),
    });
  }

  close(): void {
    this.closed = true;
    if (this.abortInputSignal && this.abortInputListener) {
      this.abortInputSignal.removeEventListener('abort', this.abortInputListener);
    }
  }

  private applyEventBudgets(event: RuntimeCommandEvent): RuntimeCommandEvent | null {
    if (event.type !== 'output') return event;
    if (this.truncatedOutputStreams.has(event.stream)) return null;
    const used = this.outputBytes[event.stream];
    const remaining = RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES - used;
    const bytes = runtimeProjectUtf8Bytes(event.data);
    if (bytes <= remaining) {
      this.outputBytes[event.stream] = used + bytes;
      return event;
    }
    this.truncatedOutputStreams.add(event.stream);
    const marker = `\n[${event.stream} output truncated after ${RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES} bytes]\n`;
    const truncated = `${runtimeProjectTruncateUtf8(event.data, Math.max(0, remaining))}${marker}`;
    this.outputBytes[event.stream] = RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES + runtimeProjectUtf8Bytes(marker);
    return truncated ? { ...event, data: truncated } : null;
  }

  private recordLiveFileChangeBudget(change: RuntimeFileChange): void {
    this.liveFileChangeCount += 1;
    if (this.liveFileChangeCount > RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGES) {
      throw Object.assign(new Error('EMSGSIZE: TraceKernel live file-change count limit exceeded'), { code: 'EMSGSIZE' });
    }
    const size = runtimeFileChangeByteSize(change);
    if (size > RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES) {
      throw Object.assign(new Error('EMSGSIZE: TraceKernel live file-change size limit exceeded'), { code: 'EMSGSIZE' });
    }
    this.liveFileChangeBytes += size;
    if (this.liveFileChangeBytes > RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES) {
      throw Object.assign(new Error('EMSGSIZE: TraceKernel live file-change byte limit exceeded'), { code: 'EMSGSIZE' });
    }
  }

  async flush(): Promise<void> {
    await this.eventQueue?.flush();
  }

  filterAppliedResultFiles<Result extends RuntimeCommandResult>(result: Result): Result {
    if (this.appliedFileChanges.size === 0) return result;
    const appliedFileChanges = new Map(this.appliedFileChanges);
    this.appliedFileChanges.clear();
    return filterRuntimeCommandResultFiles(result, (change) => {
      const normalized = normalizeRuntimeFileChange(change);
      return appliedFileChanges.get(runtimeFileChangePath(normalized)) === JSON.stringify(normalized);
    }) as Result;
  }

  emitMissingFinalOutput(
    result: Pick<RuntimeCommandResult, 'stdout' | 'stderr'>,
    output: (stream: RuntimeCommandEventStream, data: string) => void
  ): void {
    this.outputTracker.emitMissingFinalOutput(result, output);
  }
}

export async function applyRuntimeCommandResultFiles(
  result: RuntimeCommandResult,
  applyFileChange: (change: RuntimeFileChange, phase: RuntimeFileMutationPhase) => Promise<void>
): Promise<RuntimeCommandResult> {
  assertRuntimeFinalDiffBudget(result.files);
  for (const file of result.files ?? []) {
    await applyFileChange(normalizeRuntimeFileChange(file), 'final-diff');
  }
  const { files: _files, ...commandResult } = result;
  return commandResult;
}

export interface RuntimeProjectWorkerBridgeOptions<
  Request extends RuntimeProjectCommandRequest<string>,
  Result extends RuntimeCommandResult = RuntimeCommandResult
> {
  request: Request;
  startPhase: string;
  startMessage: string;
  startDetail?: Record<string, unknown>;
  finishPhase: string;
  finishMessage: string;
  finishDetail?: (result: Result) => Record<string, unknown>;
  applyFileChange?: (change: RuntimeFileChange, phase: RuntimeFileMutationPhase) => Promise<boolean | void>;
  run(
    request: Omit<Request, 'onEvent' | 'engineLease'>,
    onEvent: RuntimeCommandEventHandler,
    engineLease: RuntimeProjectEngineLeaseController | undefined
  ): Promise<Result>;
}

export async function runRuntimeProjectWorkerBridge<
  Request extends RuntimeProjectCommandRequest<string>,
  Result extends RuntimeCommandResult = RuntimeCommandResult
>(options: RuntimeProjectWorkerBridgeOptions<Request, Result>): Promise<Result> {
  const liveIo = new RuntimeProjectLiveIoController({
    applyFileChange: options.applyFileChange,
    onEvent: options.request.onEvent,
    signal: options.request.signal,
  });
  const io = createRuntimeProjectIoBridge((event) => liveIo.emit(event));
  const forwardWorkerEvent = (event: RuntimeCommandEvent): void => {
    liveIo.handleRuntimeEvent(event);
  };
  io.status(options.startPhase, options.startMessage, options.startDetail);
  const {
    onEvent: _onEvent,
    engineLease: _engineLease,
    ...workerRequest
  } = options.request;
  let result: Result;
  try {
    result = await options.run(workerRequest, forwardWorkerEvent, options.request.engineLease);
    liveIo.close();
    await liveIo.flush();
  } catch (error) {
    liveIo.close();
    const failedResult = runtimeProjectInfrastructureFailure(error, options.request.signal) as Result;
    liveIo.emitMissingFinalOutput(failedResult, (stream, data) => io.output(stream, data));
    io.status(options.finishPhase, options.finishMessage, {
      exitCode: failedResult.exitCode,
      error: failedResult.error?.message,
      ...(failedResult.error?.detail ?? {}),
    });
    return failedResult;
  }
  const commandResult = liveIo.filterAppliedResultFiles(result);
  liveIo.emitMissingFinalOutput(commandResult, (stream, data) => io.output(stream, data));
  io.status(
    options.finishPhase,
    options.finishMessage,
    options.finishDetail ? options.finishDetail(commandResult) : { exitCode: commandResult.exitCode }
  );
  return commandResult;
}

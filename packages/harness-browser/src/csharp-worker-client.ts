import {
  RUNTIME_TRACE_SCHEMA_VERSION,
  withRuntimeTraceOptions,
  type RuntimeTrace,
  type RuntimeTraceEvent,
} from '../../harness-core/src/runtime-trace';
import type { TraceExecutionOptions } from '../../harness-core/src/runtime-types';
import type {
  CodeExecutionResult,
  CodeExecutionBatchResult,
  ExecutionResult,
  RuntimeExecutionTimings,
} from '../../harness-core/src/types';
import type {
  RuntimeCommandEvent,
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeProjectCommandRequest,
} from '../../harness-core/src/runtime-project';
import { logRuntimeDiagnostic } from './runtime-diagnostics';
import { createWorkerProtocolToken } from './worker-protocol';

type MessageId = string;
export type CSharpExecutionStyle = 'function' | 'solution-method' | 'ops-class';

export interface CSharpWorkerClientOptions {
  workerUrl: string;
  assetBaseUrl: string;
  debug?: boolean;
  initTimeoutMs?: number;
  executionTimeoutMs?: number;
  tracingTimeoutMs?: number;
  interviewTimeoutMs?: number;
  workerIdleTimeoutMs?: number;
}

interface PendingMessage {
  protocolToken: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onEvent?: RuntimeCommandEventHandler;
  timeoutId?: ReturnType<typeof setTimeout>;
}

function createExecutionAbortError(): Error {
  return Object.assign(new Error('Execution aborted'), { name: 'AbortError' });
}

interface WorkerMessage {
  id?: MessageId;
  type: string;
  payload?: unknown;
  protocolToken?: string;
}

interface InitResult {
  success: boolean;
  loadTimeMs: number;
  timings?: RuntimeExecutionTimings;
}

interface WarmupResult {
  success: boolean;
  loadTimeMs: number;
  error?: string;
  timings?: RuntimeExecutionTimings;
}

const EXECUTION_TIMEOUT_MS = 20_000;
const TRACING_TIMEOUT_MS = 20_000;
const INTERVIEW_MODE_TIMEOUT_MS = 5_000;
const INIT_TIMEOUT_MS = 45_000;
const MESSAGE_TIMEOUT_MS = 30_000;
const WORKER_READY_TIMEOUT_MS = 10_000;
const CSHARP_DEFAULT_FILE = 'solution.cs';
const CSHARP_LEGACY_USER_FILE = 'UserCode.cs';

export interface CSharpDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: string;
  id?: string;
}

export type CSharpProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;
export type CSharpProjectCommandResult = RuntimeCommandResult;

interface CSharpWorkerExecuteResult {
  success: boolean;
  output?: unknown;
  error?: string;
  diagnostics?: CSharpDiagnostic[];
  consoleOutput?: string[];
  events?: RuntimeTraceEvent[];
  executionTimeMs?: number;
  traceLimitExceeded?: boolean;
  timeoutReason?: ExecutionResult['timeoutReason'];
  timings?: RuntimeExecutionTimings;
}

function isCSharpUserFile(file: string | undefined): boolean {
  return Boolean(file?.endsWith(CSHARP_DEFAULT_FILE) || file?.endsWith(CSHARP_LEGACY_USER_FILE));
}

function isCSharpUserDiagnostic(diagnostic: CSharpDiagnostic): boolean {
  return isCSharpUserFile(diagnostic.file);
}

function normalizeCSharpTraceEventFile(event: RuntimeTraceEvent): RuntimeTraceEvent {
  return isCSharpUserFile(event.file) ? { ...event, file: CSHARP_DEFAULT_FILE } : event;
}

export class CSharpWorkerClient {
  private worker: Worker | null = null;
  private pendingMessages = new Map<MessageId, PendingMessage>();
  private messageId = 0;
  private isInitializing = false;
  private initPromise: Promise<InitResult> | null = null;
  private warmupPromise: Promise<WarmupResult> | null = null;
  private workerReadyPromise: Promise<void> | null = null;
  private workerReadyResolve: (() => void) | null = null;
  private workerReadyReject: ((error: Error) => void) | null = null;
  private readonly debug: boolean;
  private readonly initTimeoutMs: number;
  private readonly executionTimeoutMs: number;
  private readonly tracingTimeoutMs: number;
  private readonly interviewTimeoutMs: number;

  constructor(private readonly options: CSharpWorkerClientOptions) {
    this.debug = options.debug ?? process.env.NODE_ENV === 'development';
    this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.executionTimeoutMs = options.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS;
    this.tracingTimeoutMs = options.tracingTimeoutMs ?? TRACING_TIMEOUT_MS;
    this.interviewTimeoutMs = options.interviewTimeoutMs ?? INTERVIEW_MODE_TIMEOUT_MS;
  }

  isSupported(): boolean {
    return typeof Worker !== 'undefined';
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;

    if (!this.isSupported()) {
      throw new Error('Web Workers are not supported in this environment');
    }

    this.workerReadyPromise = new Promise((resolve, reject) => {
      this.workerReadyResolve = resolve;
      this.workerReadyReject = (error: Error) => reject(error);
    });

    const workerUrl =
      this.debug && !this.options.workerUrl.includes('?')
        ? `${this.options.workerUrl}?dev=${Date.now()}`
        : this.options.workerUrl;

    this.worker = new Worker(workerUrl, { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const { id, type, payload, protocolToken } = event.data;

      if (type === 'worker-ready') {
        this.workerReadyResolve?.();
        this.workerReadyResolve = null;
        this.workerReadyReject = null;
        logRuntimeDiagnostic('info', {
          component: 'CSharpWorkerClient',
          runtime: 'csharp',
          phase: 'worker-ready',
          message: 'C# worker is ready.',
        }, { enabled: this.debug });
        return;
      }

      if (type === 'idle-timeout') {
        logRuntimeDiagnostic('info', {
          component: 'CSharpWorkerClient',
          runtime: 'csharp',
          phase: 'idle-timeout',
          message: 'C# worker closed after idle timeout.',
        }, { enabled: this.debug });
        this.terminateAndReset(new Error('C# worker closed after idle timeout'));
        return;
      }

      if (!id) return;
      const pending = this.pendingMessages.get(id);
      if (!pending) return;
      if (protocolToken !== pending.protocolToken) return;
      if (type === 'project-event') {
        pending.onEvent?.(payload as RuntimeCommandEvent);
        return;
      }
      this.pendingMessages.delete(id);
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);

      if (type === 'error') {
        pending.reject(new Error((payload as { error: string }).error));
        return;
      }

      pending.resolve(payload);
    };

    this.worker.onerror = (error) => {
      logRuntimeDiagnostic('error', {
        component: 'CSharpWorkerClient',
        runtime: 'csharp',
        phase: 'worker-error',
        message: 'C# worker emitted an error event.',
        detail: {
          message: error.message,
          filename: error.filename,
          lineno: error.lineno,
          colno: error.colno,
        },
      });
      const workerError = new Error(error.message || 'C# worker error');
      this.workerReadyReject?.(workerError);
      this.workerReadyResolve = null;
      this.workerReadyReject = null;
      for (const [, pending] of this.pendingMessages) {
        if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
        pending.reject(workerError);
      }
      this.pendingMessages.clear();
      this.terminateAndReset(workerError);
    };

    return this.worker;
  }

  private async waitForWorkerReady(): Promise<void> {
    const readyPromise = this.workerReadyPromise;
    if (!readyPromise) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutId = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        const timeoutError = new Error(
          `C# worker failed to initialize in time (${Math.round(WORKER_READY_TIMEOUT_MS / 1000)}s)`
        );
        logRuntimeDiagnostic('warn', {
          component: 'CSharpWorkerClient',
          runtime: 'csharp',
          phase: 'worker-ready-timeout',
          message: 'C# worker did not send worker-ready before the timeout.',
          detail: { timeoutMs: WORKER_READY_TIMEOUT_MS },
        }, { enabled: this.debug });
        this.terminateAndReset(timeoutError);
        reject(timeoutError);
      }, WORKER_READY_TIMEOUT_MS);

      readyPromise
        .then(() => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeoutId);
          resolve();
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeoutId);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private async sendMessage<T>(
    type: string,
    payload?: unknown,
    timeoutMs = MESSAGE_TIMEOUT_MS,
    onEvent?: RuntimeCommandEventHandler
  ): Promise<T> {
    const worker = this.getWorker();
    await this.waitForWorkerReady();
    const id = String(++this.messageId);
    const protocolToken = createWorkerProtocolToken();

    return new Promise<T>((resolve, reject) => {
      this.pendingMessages.set(id, {
        protocolToken,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(onEvent ? { onEvent } : {}),
      });

      const timeoutId = globalThis.setTimeout(() => {
        const pending = this.pendingMessages.get(id);
        if (!pending) return;
        this.pendingMessages.delete(id);
        logRuntimeDiagnostic('warn', {
          component: 'CSharpWorkerClient',
          runtime: 'csharp',
          phase: 'worker-request-timeout',
          message: 'C# worker request timed out.',
          detail: { id, type, timeoutMs },
        }, { enabled: this.debug });
        pending.reject(new Error(`Worker request timed out: ${type}`));
      }, timeoutMs);

      const pending = this.pendingMessages.get(id);
      if (pending) pending.timeoutId = timeoutId;

      worker.postMessage({ id, type, payload, protocolToken });
    });
  }

  private async executeWithTimeout<T>(executor: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      const abortError = createExecutionAbortError();
      this.terminateAndReset(abortError);
      throw abortError;
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        globalThis.clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        const abortError = createExecutionAbortError();
        this.terminateAndReset(abortError);
        settleReject(abortError);
      };
      const timeoutId = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        logRuntimeDiagnostic('warn', {
          component: 'CSharpWorkerClient',
          runtime: 'csharp',
          phase: 'execution-timeout',
          message: 'C# execution timed out; terminating worker.',
          detail: { timeoutMs },
        }, { enabled: this.debug });
        this.terminateAndReset();
        reject(new Error(`C# execution timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
      }, timeoutMs);

      signal?.addEventListener('abort', onAbort, { once: true });

      executor()
        .then((result) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        })
        .catch((error) => {
          settleReject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private terminateAndReset(reason: Error = new Error('Worker was terminated')): void {
    this.workerReadyReject?.(reason);
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initPromise = null;
    this.warmupPromise = null;
    this.isInitializing = false;
    this.workerReadyPromise = null;
    this.workerReadyResolve = null;
    this.workerReadyReject = null;

    for (const [, pending] of this.pendingMessages) {
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);
      pending.reject(reason);
    }
    this.pendingMessages.clear();
  }

  private shouldRetryInit(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('timed out') ||
      message.includes('Worker request timed out') ||
      message.includes('worker error') ||
      message.includes('Failed to fetch') ||
      message.includes('was terminated') ||
      message.includes('closed after idle timeout')
    );
  }

  private sendInitMessage(): Promise<InitResult> {
    return this.sendMessage<InitResult>(
      'init',
      { assetBaseUrl: this.options.assetBaseUrl, ...this.workerOptionsPayload() },
      this.initTimeoutMs
    );
  }

  private workerOptionsPayload(): { idleTimeoutMs?: number } {
    return this.options.workerIdleTimeoutMs === undefined
      ? {}
      : { idleTimeoutMs: this.options.workerIdleTimeoutMs };
  }

  async init(): Promise<InitResult> {
    if (this.initPromise) return this.initPromise;
    if (this.isInitializing) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
      return this.init();
    }

    this.isInitializing = true;
    this.initPromise = (async () => {
      try {
        return await this.sendInitMessage();
      } catch (error) {
        if (!this.shouldRetryInit(error)) throw error;
        this.terminateAndReset(error instanceof Error ? error : new Error(String(error)));
        return this.sendInitMessage();
      }
    })();
    try {
      return await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  async warmup(): Promise<WarmupResult> {
    if (this.warmupPromise) return this.warmupPromise;
    this.warmupPromise = (async () => {
      try {
        await this.init();
        return await this.sendMessage<WarmupResult>(
          'warmup',
          { assetBaseUrl: this.options.assetBaseUrl, ...this.workerOptionsPayload() },
          this.initTimeoutMs
        );
      } catch (error) {
        this.warmupPromise = null;
        throw error;
      }
    })();
    return this.warmupPromise;
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: CSharpExecutionStyle,
    signal?: AbortSignal
  ): Promise<CodeExecutionResult> {
    await this.init();
    const result = await this.executeWithTimeout(
      () =>
        this.sendMessage<CSharpWorkerExecuteResult>(
          'execute-code',
          {
            code,
            functionName,
            inputs,
            executionStyle,
            assetBaseUrl: this.options.assetBaseUrl,
            timeoutMs: Math.max(100, this.executionTimeoutMs - 1_000),
            ...this.workerOptionsPayload(),
          },
          this.executionTimeoutMs + 5_000
        ),
      this.executionTimeoutMs,
      signal
    );

    if (!result.success) {
      const firstUserDiagnostic = result.diagnostics?.find(isCSharpUserDiagnostic);
      return {
        success: false,
        output: null,
        error: result.error ?? 'C# execution failed',
        ...(firstUserDiagnostic ? { errorLine: firstUserDiagnostic.line } : {}),
        consoleOutput: result.consoleOutput ?? [],
        timings: result.timings,
      };
    }

    return {
      success: true,
      output: result.output,
      consoleOutput: result.consoleOutput ?? [],
      timings: result.timings,
    };
  }

  async executeCodeBatch(
    code: string,
    functionName: string,
    inputBatch: Record<string, unknown>[],
    executionStyle: CSharpExecutionStyle,
    signal?: AbortSignal
  ): Promise<CodeExecutionBatchResult> {
    await this.init();
    const result = await this.executeWithTimeout(
      () =>
        this.sendMessage<CodeExecutionBatchResult>(
          'execute-code-batch',
          {
            code,
            functionName,
            inputBatch,
            executionStyle,
            assetBaseUrl: this.options.assetBaseUrl,
            timeoutMs: Math.max(100, this.executionTimeoutMs - 1_000),
            ...this.workerOptionsPayload(),
          },
          this.executionTimeoutMs + 5_000
        ),
      this.executionTimeoutMs,
      signal
    );

    return {
      ...result,
      results: (result.results ?? []).map((entry) => ({
        ...entry,
        output: entry.output ?? null,
      })),
    };
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: CSharpExecutionStyle,
    signal?: AbortSignal
  ): Promise<CodeExecutionResult> {
    await this.init();
    let result: CSharpWorkerExecuteResult;
    try {
      result = await this.executeWithTimeout(
        () =>
          this.sendMessage<CSharpWorkerExecuteResult>(
            'execute-code-interview',
            {
              code,
              functionName,
              inputs,
              executionStyle,
              assetBaseUrl: this.options.assetBaseUrl,
              timeoutMs: Math.max(100, this.interviewTimeoutMs - 1_000),
              ...this.workerOptionsPayload(),
            },
            this.interviewTimeoutMs + 5_000
          ),
        this.interviewTimeoutMs,
        signal
      );
    } catch {
      return {
        success: false,
        output: null,
        error: 'Time Limit Exceeded',
        timeoutReason: 'client-timeout',
        diagnosticStage: 'interview',
        consoleOutput: [],
        timings: { totalMs: this.interviewTimeoutMs },
      };
    }

    if (!result.success) {
      const firstUserDiagnostic = result.diagnostics?.find(isCSharpUserDiagnostic);
      if (this.isInterviewTimeoutLike(result)) {
        return {
          success: false,
          output: null,
          error: 'Time Limit Exceeded',
          timeoutReason: result.timeoutReason ?? 'client-timeout',
          diagnosticStage: 'interview',
          consoleOutput: result.consoleOutput ?? [],
          timings: result.timings,
        };
      }

      return {
        success: false,
        output: null,
        error: result.error ?? 'C# execution failed',
        ...(firstUserDiagnostic ? { errorLine: firstUserDiagnostic.line } : {}),
        consoleOutput: result.consoleOutput ?? [],
        timings: result.timings,
      };
    }

    return {
      success: true,
      output: result.output,
      consoleOutput: result.consoleOutput ?? [],
      timings: result.timings,
    };
  }

  async executeWithTracing(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options: TraceExecutionOptions | undefined,
    executionStyle: CSharpExecutionStyle,
    signal?: AbortSignal
  ): Promise<ExecutionResult> {
    await this.init();
    let result: CSharpWorkerExecuteResult;
    const tracingTimeoutMs = this.resolveTracingTimeoutMs(functionName, executionStyle);
    try {
      result = await this.executeWithTimeout(
        () =>
          this.sendMessage<CSharpWorkerExecuteResult>(
            'execute-with-tracing',
            {
              code,
              functionName,
              inputs,
              executionStyle,
              assetBaseUrl: this.options.assetBaseUrl,
              timeoutMs: Math.max(100, tracingTimeoutMs - 1_000),
              maxTraceSteps: options?.maxTraceSteps,
              maxLineEvents: options?.maxLineEvents,
              maxSingleLineHits: options?.maxSingleLineHits,
              maxStoredEvents: options?.maxStoredEvents,
              maxPathDepth: options?.maxPathDepth,
              minimalTrace: options?.minimalTrace,
              ...this.workerOptionsPayload(),
            },
            tracingTimeoutMs + 5_000
          ),
        tracingTimeoutMs,
        signal
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const trace = this.createTrace([
        {
          kind: 'timeout',
          runId: 'csharp:run',
          file: CSHARP_DEFAULT_FILE,
          message,
        },
      ]);
      return {
        success: false,
        output: null,
        error: message,
        trace,
        executionTimeMs: tracingTimeoutMs,
        consoleOutput: [],
        traceLimitExceeded: true,
        timeoutReason: 'client-timeout',
        lineEventCount: trace.lineEventCount,
        traceStepCount: trace.traceStepCount,
        timings: { totalMs: tracingTimeoutMs },
      };
    }

    const consoleOutput = result.consoleOutput ?? [];
    const hostEmittedStdout = result.events?.some((event) => event.kind === 'stdout') === true;
    const events = [
      ...(result.events ?? []),
      ...(hostEmittedStdout
        ? []
        : consoleOutput.map((text): RuntimeTraceEvent => ({
            kind: 'stdout',
            runId: 'csharp:run',
            file: CSHARP_DEFAULT_FILE,
            text,
          }))),
    ];
    const trace = this.createTrace(events, { maxPathDepth: options?.maxPathDepth });

    if (!result.success) {
      const firstUserDiagnostic = result.diagnostics?.find(isCSharpUserDiagnostic);
      return {
        success: false,
        output: null,
        error: result.error ?? 'C# execution failed',
        ...(firstUserDiagnostic ? { errorLine: firstUserDiagnostic.line } : {}),
        trace,
        executionTimeMs: result.executionTimeMs ?? 0,
        consoleOutput,
        ...(result.traceLimitExceeded !== undefined
          ? { traceLimitExceeded: result.traceLimitExceeded }
          : {}),
        ...(result.timeoutReason ? { timeoutReason: result.timeoutReason } : {}),
        lineEventCount: trace.lineEventCount,
        traceStepCount: trace.traceStepCount,
        timings: result.timings,
      };
    }

    return {
      success: true,
      output: result.output,
      trace,
      executionTimeMs: result.executionTimeMs ?? 0,
      consoleOutput,
      ...(result.traceLimitExceeded !== undefined
        ? { traceLimitExceeded: result.traceLimitExceeded }
        : {}),
      ...(result.timeoutReason ? { timeoutReason: result.timeoutReason } : {}),
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
      timings: result.timings,
    };
  }

  async executeProjectCSharp(
    request: CSharpProjectCommandRequest,
    timeoutMs = this.executionTimeoutMs,
    onEvent?: RuntimeCommandEventHandler,
    signal: AbortSignal | undefined = request.signal
  ): Promise<CSharpProjectCommandResult> {
    if (signal?.aborted) {
      const abortError = createExecutionAbortError();
      this.terminateAndReset(abortError);
      throw abortError;
    }
    const abortInit = () => this.terminateAndReset(createExecutionAbortError());
    signal?.addEventListener('abort', abortInit, { once: true });
    try {
      await this.init();
    } finally {
      signal?.removeEventListener('abort', abortInit);
    }
    const { signal: _signal, onEvent: _requestOnEvent, ...workerRequest } = request;
    return this.executeWithTimeout(
      () =>
        this.sendMessage<CSharpProjectCommandResult>(
          'execute-project-csharp',
          {
            ...workerRequest,
            assetBaseUrl: this.options.assetBaseUrl,
            timeoutMs: Math.max(100, timeoutMs - 1_000),
            ...this.workerOptionsPayload(),
          },
          timeoutMs + 5_000,
          onEvent
        ),
      timeoutMs,
      signal
    );
  }

  private createTrace(events: RuntimeTraceEvent[], options: { maxPathDepth?: number } = {}): RuntimeTrace {
    return withRuntimeTraceOptions({
      schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
      language: 'csharp',
      runId: 'csharp:run',
      events: events.map(normalizeCSharpTraceEventFile),
      lineEventCount: events.filter((event) => event.kind === 'line').length,
      traceStepCount: events.length,
    }, options);
  }

  private isInterviewTimeoutLike(result: CSharpWorkerExecuteResult): boolean {
    if (result.timeoutReason) return true;
    const normalized = String(result.error ?? '').toLowerCase();
    return (
      normalized.includes('timed out') ||
      normalized.includes('trace-limit') ||
      normalized.includes('line-limit') ||
      normalized.includes('single-line-limit') ||
      normalized.includes('recursion-limit') ||
      normalized.includes('memory-limit')
    );
  }

  private resolveTracingTimeoutMs(functionName: string, executionStyle: CSharpExecutionStyle): number {
    void functionName;
    void executionStyle;
    return this.tracingTimeoutMs;
  }

  terminate(): void {
    this.terminateAndReset();
  }
}

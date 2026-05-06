import {
  RUNTIME_TRACE_SCHEMA_VERSION,
  type RuntimeTrace,
  type RuntimeTraceEvent,
} from '../../harness-core/src/runtime-trace';
import type { TraceExecutionOptions } from '../../harness-core/src/runtime-types';
import type { CodeExecutionResult, ExecutionResult } from '../../harness-core/src/types';

type MessageId = string;
export type CSharpExecutionStyle = 'function' | 'solution-method' | 'ops-class';

export interface CSharpWorkerClientOptions {
  workerUrl: string;
  assetBaseUrl: string;
  debug?: boolean;
}

interface PendingMessage {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

interface WorkerMessage {
  id?: MessageId;
  type: string;
  payload?: unknown;
}

interface InitResult {
  success: boolean;
  loadTimeMs: number;
}

const EXECUTION_TIMEOUT_MS = 20_000;
const INTERVIEW_MODE_TIMEOUT_MS = 5_000;
const INIT_TIMEOUT_MS = 30_000;
const MESSAGE_TIMEOUT_MS = 30_000;
const WORKER_READY_TIMEOUT_MS = 10_000;

export interface CSharpDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: string;
  id?: string;
}

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
}

export class CSharpWorkerClient {
  private worker: Worker | null = null;
  private pendingMessages = new Map<MessageId, PendingMessage>();
  private messageId = 0;
  private isInitializing = false;
  private initPromise: Promise<InitResult> | null = null;
  private workerReadyPromise: Promise<void> | null = null;
  private workerReadyResolve: (() => void) | null = null;
  private workerReadyReject: ((error: Error) => void) | null = null;
  private readonly debug: boolean;

  constructor(private readonly options: CSharpWorkerClientOptions) {
    this.debug = options.debug ?? process.env.NODE_ENV === 'development';
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
      const { id, type, payload } = event.data;

      if (type === 'worker-ready') {
        this.workerReadyResolve?.();
        this.workerReadyResolve = null;
        this.workerReadyReject = null;
        return;
      }

      if (!id) return;
      const pending = this.pendingMessages.get(id);
      if (!pending) return;
      this.pendingMessages.delete(id);
      if (pending.timeoutId) globalThis.clearTimeout(pending.timeoutId);

      if (type === 'error') {
        pending.reject(new Error((payload as { error: string }).error));
        return;
      }

      pending.resolve(payload);
    };

    this.worker.onerror = (error) => {
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
    timeoutMs = MESSAGE_TIMEOUT_MS
  ): Promise<T> {
    const worker = this.getWorker();
    await this.waitForWorkerReady();
    const id = String(++this.messageId);

    return new Promise<T>((resolve, reject) => {
      this.pendingMessages.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      const timeoutId = globalThis.setTimeout(() => {
        const pending = this.pendingMessages.get(id);
        if (!pending) return;
        this.pendingMessages.delete(id);
        pending.reject(new Error(`Worker request timed out: ${type}`));
      }, timeoutMs);

      const pending = this.pendingMessages.get(id);
      if (pending) pending.timeoutId = timeoutId;

      worker.postMessage({ id, type, payload });
    });
  }

  private async executeWithTimeout<T>(executor: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeoutId = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.terminateAndReset();
        reject(new Error(`C# execution timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
      }, timeoutMs);

      executor()
        .then((result) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeoutId);
          reject(error);
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

  async init(): Promise<InitResult> {
    if (this.initPromise) return this.initPromise;
    if (this.isInitializing) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
      return this.init();
    }

    this.isInitializing = true;
    this.initPromise = this.sendMessage<InitResult>(
      'init',
      { assetBaseUrl: this.options.assetBaseUrl },
      INIT_TIMEOUT_MS
    );
    try {
      return await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: CSharpExecutionStyle
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
            timeoutMs: EXECUTION_TIMEOUT_MS - 1_000,
          },
          EXECUTION_TIMEOUT_MS + 5_000
        ),
      EXECUTION_TIMEOUT_MS
    );

    if (!result.success) {
      const firstUserDiagnostic = result.diagnostics?.find((diagnostic) => diagnostic.file.endsWith('UserCode.cs'));
      return {
        success: false,
        output: null,
        error: result.error ?? 'C# execution failed',
        ...(firstUserDiagnostic ? { errorLine: firstUserDiagnostic.line } : {}),
        consoleOutput: result.consoleOutput ?? [],
      };
    }

    return {
      success: true,
      output: result.output,
      consoleOutput: result.consoleOutput ?? [],
    };
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: CSharpExecutionStyle
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
              timeoutMs: INTERVIEW_MODE_TIMEOUT_MS - 1_000,
            },
            INTERVIEW_MODE_TIMEOUT_MS + 5_000
          ),
        INTERVIEW_MODE_TIMEOUT_MS
      );
    } catch {
      return {
        success: false,
        output: null,
        error: 'Time Limit Exceeded',
        timeoutReason: 'client-timeout',
        diagnosticStage: 'interview',
        consoleOutput: [],
      };
    }

    if (!result.success) {
      const firstUserDiagnostic = result.diagnostics?.find((diagnostic) => diagnostic.file.endsWith('UserCode.cs'));
      if (this.isInterviewTimeoutLike(result)) {
        return {
          success: false,
          output: null,
          error: 'Time Limit Exceeded',
          timeoutReason: result.timeoutReason ?? 'client-timeout',
          diagnosticStage: 'interview',
          consoleOutput: result.consoleOutput ?? [],
        };
      }

      return {
        success: false,
        output: null,
        error: result.error ?? 'C# execution failed',
        ...(firstUserDiagnostic ? { errorLine: firstUserDiagnostic.line } : {}),
        consoleOutput: result.consoleOutput ?? [],
      };
    }

    return {
      success: true,
      output: result.output,
      consoleOutput: result.consoleOutput ?? [],
    };
  }

  async executeWithTracing(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options: TraceExecutionOptions | undefined,
    executionStyle: CSharpExecutionStyle
  ): Promise<ExecutionResult> {
    await this.init();
    let result: CSharpWorkerExecuteResult;
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
              timeoutMs: EXECUTION_TIMEOUT_MS - 1_000,
              maxTraceSteps: options?.maxTraceSteps,
              maxLineEvents: options?.maxLineEvents,
              maxSingleLineHits: options?.maxSingleLineHits,
              maxStoredEvents: options?.maxStoredEvents,
              minimalTrace: options?.minimalTrace,
            },
            EXECUTION_TIMEOUT_MS + 5_000
          ),
        EXECUTION_TIMEOUT_MS
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const trace = this.createTrace([
        {
          kind: 'timeout',
          runId: 'csharp:run',
          file: 'UserCode.cs',
          message,
        },
      ]);
      return {
        success: false,
        output: null,
        error: message,
        trace,
        executionTimeMs: EXECUTION_TIMEOUT_MS,
        consoleOutput: [],
        traceLimitExceeded: true,
        timeoutReason: 'client-timeout',
        lineEventCount: trace.lineEventCount,
        traceStepCount: trace.traceStepCount,
      };
    }

    const consoleOutput = result.consoleOutput ?? [];
    const events = [
      ...(result.events ?? []),
      ...consoleOutput.map((text): RuntimeTraceEvent => ({
        kind: 'stdout',
        runId: 'csharp:run',
        file: 'UserCode.cs',
        text,
      })),
    ];
    const trace = this.createTrace(events);

    if (!result.success) {
      const firstUserDiagnostic = result.diagnostics?.find((diagnostic) => diagnostic.file.endsWith('UserCode.cs'));
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
    };
  }

  private createTrace(events: RuntimeTraceEvent[]): RuntimeTrace {
    return {
      schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
      language: 'csharp',
      runId: 'csharp:run',
      events,
      lineEventCount: events.filter((event) => event.kind === 'line').length,
      traceStepCount: events.length,
    };
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

  terminate(): void {
    this.terminateAndReset();
  }
}

import type { CodeExecutionResult, ExecutionResult, RuntimeExecutionTimings } from './types';
import type {
  RuntimeCommandResult,
  RuntimeProjectCommandRequest,
} from './runtime-project';

export type Language = 'python' | 'javascript' | 'typescript' | 'java' | 'csharp' | 'cpp';

export type RuntimeExecutionStyle = 'function' | 'solution-method' | 'ops-class';

export type RuntimeMaturity = 'experimental' | 'beta' | 'stable';

export type RuntimeExecutionPipeline = 'interpreted' | 'transpiled' | 'compiled';

export type RuntimeCompileCost = 'none' | 'low' | 'high';

export type RuntimeExecutionIsolationBoundary =
  | 'fresh-worker'
  | 'fresh-program-instance'
  | 'interpreter-cleanup'
  | 'fresh-class-loader'
  | 'fresh-assembly-load-context';

export interface RuntimeExecutionIsolationSupport {
  /**
   * Whether separate untrusted executions may safely share the initialized
   * browser runtime. False means the consumer must replace the containing
   * runtime (for example, its Worker or browser context) between principals.
   */
  safeForUntrustedReuse: boolean;
  /** The strongest isolation boundary created between executions. */
  boundary: RuntimeExecutionIsolationBoundary;
}

export type RuntimeProjectIoTier = 'unsupported' | 'final-diff' | 'bridged-live' | 'native-live';

export type RuntimeProjectIoEnvironment = 'browser' | 'node';

export interface RuntimeProjectIoSupport {
  tier: RuntimeProjectIoTier;
  supported: boolean;
  kernelFs: boolean;
  liveMutationEvents: boolean;
  finalDiff: boolean;
  providerLiveInterception: boolean;
  streamingStdio: boolean;
  liveStdin: boolean;
  deviceFiles: boolean;
}

export interface RuntimeProjectIoCapabilityRow {
  language: Language;
  browser: RuntimeProjectIoSupport;
  node: RuntimeProjectIoSupport;
  notes: readonly string[];
  limitations: readonly string[];
}

export interface RuntimeCapabilities {
  execution: {
    compilation: {
      required: boolean;
      pipeline: RuntimeExecutionPipeline;
      cost: RuntimeCompileCost;
    };
    styles: {
      function: boolean;
      solutionMethod: boolean;
      opsClass: boolean;
      script: boolean;
    };
    /** Which `RuntimeExecutionLimits` knobs this runtime honors. */
    limits: RuntimeExecutionLimitSupport;
    timeouts: {
      clientTimeouts: boolean;
      runtimeTimeouts: boolean;
    };
    isolation: RuntimeExecutionIsolationSupport;
  };
  project: {
    workspace: {
      supported: boolean;
      kernelFs: boolean;
      virtualDevices: boolean;
      virtualProc: boolean;
    };
    filesystem: {
      finalDiff: boolean;
      liveMutationEvents: boolean;
      providerLiveInterception: boolean;
      binaryFiles: boolean;
      directories: boolean;
    };
    stdio: {
      liveStdin: boolean;
      outputEvents: boolean;
      deviceFiles: boolean;
    };
  };
    tracing: {
      supported: boolean;
      events: {
      line: boolean;
      call: boolean;
      return: boolean;
      exception: boolean;
      stdout: boolean;
      timeout: boolean;
      };
      controls: {
        maxTraceSteps: boolean;
        maxLineEvents: boolean;
        maxSingleLineHits: boolean;
        maxStoredEvents: boolean;
        minimalTrace: boolean;
      };
    fidelity: {
      preciseLineMapping: boolean;
      stableFunctionNames: boolean;
      callStack: boolean;
    };
  };
  diagnostics: {
    compileErrors: boolean;
    runtimeErrors: boolean;
    mappedErrorLines: boolean;
    stackTraces: boolean;
  };
  structures: {
    treeNodeRefs: boolean;
    listNodeRefs: boolean;
    mapSerialization: boolean;
    setSerialization: boolean;
    graphSerialization: boolean;
    cycleReferences: boolean;
  };
}

/**
 * Caller-tunable execution limits. The harness enforces what it can and reports
 * limit trips structurally as a `limit` outcome with a `reason`; interpreting
 * a trip (e.g. rendering a verdict like "Time Limit Exceeded") is the client's job.
 *
 * Guest-enforced limits may be clamped to runtime-specific safety floors.
 * Languages declare which limits they honor via `capabilities.execution.limits`.
 */
export interface RuntimeExecutionLimits {
  /** Client-side wall-clock deadline per case, in milliseconds. A trip yields a `limit` outcome with reason `client-timeout` instead of a rejected execution. */
  wallClockMs?: number;
  /** Guest-enforced ceiling on executed line events (`line-limit`). */
  maxLineEvents?: number;
  /** Guest-enforced ceiling on hits of a single line (`single-line-limit`). */
  maxSingleLineHits?: number;
  /** Guest-enforced call-depth ceiling (`recursion-limit`). */
  maxCallDepth?: number;
  /** Guest-enforced memory ceiling in bytes (`memory-limit`). */
  maxMemoryBytes?: number;
}

export interface RuntimeExecutionLimitSupport {
  wallClock: boolean;
  lineEvents: boolean;
  singleLineHits: boolean;
  callDepth: boolean;
  memory: boolean;
}

export interface TraceBudget {
  maxTraceSteps?: number;
  maxLineEvents?: number;
  maxSingleLineHits?: number;
  maxStoredEvents?: number;
  maxPathDepth?: number;
}

export interface TraceExecutionOptions extends TraceBudget {
  minimalTrace?: boolean;
}

export interface LanguageRuntimeProfile {
  language: Language;
  maturity: RuntimeMaturity;
  capabilities: RuntimeCapabilities;
  notes?: string[];
}

export interface RuntimeExecuteCase {
  id?: string;
  inputs: Record<string, unknown>;
  expected?: unknown;
}

/** A single non-tracing execution call (one case). */
export interface RuntimeCodeCall {
  code: string;
  functionName: string;
  inputs: Record<string, unknown>;
  executionStyle?: RuntimeExecutionStyle;
  signal?: AbortSignal;
  limits?: RuntimeExecutionLimits;
}

/** A multi-case non-tracing execution call sharing one compiled program. */
export interface RuntimeBatchCall {
  code: string;
  functionName: string;
  inputBatch: Record<string, unknown>[];
  executionStyle?: RuntimeExecutionStyle;
  signal?: AbortSignal;
}

/** A single tracing execution call (one case). */
export interface RuntimeTraceCall {
  code: string;
  functionName: string | null;
  inputs: Record<string, unknown>;
  traceOptions?: TraceExecutionOptions;
  executionStyle?: RuntimeExecutionStyle;
  signal?: AbortSignal;
}

export interface RuntimeExecuteCodeRequest {
  kind?: 'code';
  code: string;
  functionName?: string | null;
  executionStyle?: RuntimeExecutionStyle;
  cases: RuntimeExecuteCase[];
  trace?: boolean;
  limits?: RuntimeExecutionLimits;
  traceOptions?: TraceExecutionOptions;
  signal?: AbortSignal;
}

export interface RuntimeExecuteCaseResult {
  id?: string;
  expected?: unknown;
  /** Present when `expected` was provided: true iff the case completed with a deep-equal output. */
  passed?: boolean;
  /** Tracing requests produce `ExecutionResult` outcomes; plain runs produce `CodeExecutionResult`. */
  outcome: CodeExecutionResult | ExecutionResult;
}

export interface RuntimeExecuteResult {
  /** Aggregate summary: true iff every case outcome completed. */
  success: boolean;
  cases: RuntimeExecuteCaseResult[];
  timings?: RuntimeExecutionTimings;
}

export interface RuntimeExecuteProjectRequest extends RuntimeProjectCommandRequest {
  kind: 'project';
}

export type RuntimeExecuteRequest = RuntimeExecuteCodeRequest | RuntimeExecuteProjectRequest;

export type RuntimeExecuteResponse = RuntimeExecuteResult | RuntimeCommandResult;

export interface RuntimeClient {
  init(): Promise<{ success: boolean; loadTimeMs: number }>;
  execute(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult>;
  execute(request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResponse>;
  executeWithTracing(call: RuntimeTraceCall): Promise<ExecutionResult>;
  executeCode(call: RuntimeCodeCall): Promise<CodeExecutionResult>;
}

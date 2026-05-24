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
      interviewMode: boolean;
    };
    timeouts: {
      clientTimeouts: boolean;
      runtimeTimeouts: boolean;
    };
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

export interface RuntimeExecuteCodeRequest {
  kind?: 'code';
  code: string;
  functionName?: string | null;
  executionStyle?: RuntimeExecutionStyle;
  cases: RuntimeExecuteCase[];
  trace?: boolean;
  interview?: boolean;
  traceOptions?: TraceExecutionOptions;
}

export interface RuntimeExecuteCaseResult {
  id?: string;
  success: boolean;
  output?: unknown;
  expected?: unknown;
  passed?: boolean;
  error?: string;
  errorLine?: number;
  consoleOutput?: string[];
  trace?: ExecutionResult['trace'];
  traceLimitExceeded?: boolean;
  timeoutReason?: CodeExecutionResult['timeoutReason'];
  diagnosticStage?: CodeExecutionResult['diagnosticStage'];
  timings?: RuntimeExecutionTimings;
}

export interface RuntimeExecuteResult {
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
  executeWithTracing(
    code: string,
    functionName: string | null,
    inputs: Record<string, unknown>,
    options?: TraceExecutionOptions,
    executionStyle?: RuntimeExecutionStyle
  ): Promise<ExecutionResult>;
  executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle?: RuntimeExecutionStyle
  ): Promise<CodeExecutionResult>;
  executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle?: RuntimeExecutionStyle
  ): Promise<CodeExecutionResult>;
}

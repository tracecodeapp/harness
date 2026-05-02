import type { CodeExecutionResult, ExecutionResult } from './types';

export type Language = 'python' | 'javascript' | 'typescript' | 'java' | 'cpp';

export type RuntimeExecutionStyle = 'function' | 'solution-method' | 'ops-class';

export type RuntimeMaturity = 'experimental' | 'beta' | 'stable';

export interface RuntimeCapabilities {
  execution: {
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

export interface RuntimeClient {
  init(): Promise<{ success: boolean; loadTimeMs: number }>;
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

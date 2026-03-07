import type { CodeExecutionResult, ExecutionResult } from './types';

export type Language = 'python' | 'javascript' | 'typescript';

export type RuntimeExecutionStyle = 'function' | 'solution-method' | 'ops-class';

export interface RuntimeCapabilities {
  supportsTracing: boolean;
  supportsStepVisualization: boolean;
  supportsScriptMode: boolean;
}

export interface TraceExecutionOptions {
  maxTraceSteps?: number;
  maxLineEvents?: number;
  maxSingleLineHits?: number;
  minimalTrace?: boolean;
}

export interface RuntimeClient {
  getCapabilities(): RuntimeCapabilities;
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

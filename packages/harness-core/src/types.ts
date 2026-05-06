/**
 * Execution types for browser runtime contracts.
 */

export type ExecutionStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'running'
  | 'stepping'
  | 'paused'
  | 'completed'
  | 'error';

// Test case execution result
export interface TestResult {
  id: string;
  passed: boolean;
  input: Record<string, unknown>;
  expected: unknown;
  actual: unknown;
  error?: string;
  warning?: string;
  executionTimeMs?: number;
}

// Non-tracing code execution result
export interface CodeExecutionResult {
  success: boolean;
  output: unknown;
  error?: string;
  errorLine?: number;
  consoleOutput?: string[];
  timeoutReason?:
    | 'trace-limit'
    | 'line-limit'
    | 'single-line-limit'
    | 'recursion-limit'
    | 'memory-limit'
    | 'client-timeout';
  diagnosticStage?:
    | 'compile'
    | 'runtime'
    | 'trace'
    | 'interview'
    | 'driver-compile'
    | 'trace-driver-compile'
    | 'driver-link';
}

// Complete execution result
export interface ExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  errorLine?: number;
  trace: import('./runtime-trace').RuntimeTrace;
  executionTimeMs: number;
  consoleOutput: string[];
  traceLimitExceeded?: boolean;
  maxTraceSteps?: number;
  timeoutReason?:
    | 'trace-limit'
    | 'line-limit'
    | 'single-line-limit'
    | 'recursion-limit'
    | 'memory-limit'
    | 'client-timeout';
  lineEventCount?: number;
  traceStepCount?: number;
}

// Pyodide loading state
export interface PyodideState {
  status: 'loading' | 'ready' | 'error';
  error?: Error;
  loadTimeMs?: number;
}

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

// Call stack frame info
export interface CallStackFrame {
  function: string;
  args: Record<string, unknown>;
  line: number;
}

export type RuntimeTraceAccessKind =
  | 'indexed-read'
  | 'indexed-write'
  | 'cell-read'
  | 'cell-write'
  | 'mutating-call';

export interface RuntimeTraceAccessEvent {
  variable: string;
  kind: RuntimeTraceAccessKind;
  indices?: number[];
  method?: string;
  pathDepth?: 1 | 2;
}

// Raw trace data from Python sys.settrace
export interface RawTraceStep {
  line: number;
  event: 'line' | 'call' | 'return' | 'exception' | 'timeout' | 'stdout';
  variables: Record<string, unknown>;
  variableSources?: Record<string, 'user' | 'user-input' | 'harness-prelude'>;
  function: string;
  callStack?: CallStackFrame[];
  accesses?: RuntimeTraceAccessEvent[];
  returnValue?: unknown;
  stdoutLineCount?: number;
  visualization?: RuntimeVisualizationPayload;
}

export type RuntimeObjectKind = 'hashmap' | 'object' | 'map' | 'set' | 'tree' | 'linked-list' | 'graph-adjacency';

export interface RuntimeHashMapEntry {
  key: unknown;
  value: unknown;
  highlight?: boolean;
}

export interface RuntimeHashMapVisualization {
  name: string;
  kind?: 'hashmap' | 'object' | 'map' | 'set';
  entries: RuntimeHashMapEntry[];
  highlightedKey?: unknown;
  deletedKey?: unknown;
  objectClassName?: string;
  objectId?: string;
}

export interface RuntimeVisualizationPayload {
  hashMaps?: RuntimeHashMapVisualization[];
  objectKinds?: Partial<Record<string, RuntimeObjectKind>>;
}

// Processed step for visualization
export interface ProcessedStep {
  stepIndex: number;
  lineNumber: number;
  lineContent: string;
  functionName: string;
  variables: Record<string, unknown>;
  output?: string;
  event?: 'line' | 'call' | 'return' | 'exception' | 'timeout' | 'stdout';
  callStack?: CallStackFrame[];
  accesses?: RuntimeTraceAccessEvent[];
  returnValue?: unknown;
  stdoutLineCount?: number;
  visualization?: RuntimeVisualizationPayload;
}

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
}

// Complete execution result
export interface ExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  errorLine?: number;
  trace: RawTraceStep[];
  executionTimeMs: number;
  consoleOutput: string[];
  traceLimitExceeded?: boolean;
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

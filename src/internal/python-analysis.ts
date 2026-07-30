import type {
  CodeExecutionResult,
  RuntimeExecutionStyle,
} from '../../packages/runtime-contracts/src/index';
import {
  PythonWorkerClient,
  type PythonWorkerClientOptions,
} from '../../packages/runtime-python/src/python-worker-client';

export interface PythonAnalysisClient {
  init(): Promise<{ success: boolean; loadTimeMs: number }>;
  analyzeCode(code: string): Promise<unknown>;
  executeCode(request: {
    code: string;
    functionName: string;
    inputs: Record<string, unknown>;
    executionStyle?: RuntimeExecutionStyle;
    signal?: AbortSignal;
  }): Promise<CodeExecutionResult>;
  terminate(): void;
}

export type CreatePythonAnalysisClientOptions = PythonWorkerClientOptions;

/**
 * Creates the implementation-neutral Python analysis service used by the
 * semantic engine. Runtime provider classes stay private to Harness.
 */
export function createPythonAnalysisClient(
  options: CreatePythonAnalysisClientOptions
): PythonAnalysisClient {
  const client = new PythonWorkerClient(options);
  return {
    init: () => client.init(),
    analyzeCode: (code) => client.analyzeCode(code),
    executeCode: (request) => client.executeCode(request),
    terminate: () => client.terminate(),
  };
}

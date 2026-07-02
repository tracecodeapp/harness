import type {
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeFileChange,
  RuntimeFile,
  RuntimeFileEncoding,
  RuntimeFileMutationPhase,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectFileChangeApplyOptions,
  RuntimeProjectSnapshot,
} from '@tracecode/harness-core';
import { runRuntimeProjectWorkerBridge } from '@tracecode/harness-core';
import type { CppWorkerClient } from '../../harness-browser/src/cpp-worker-client';

export type CppProjectFileEncoding = RuntimeFileEncoding;
export type CppProjectFile = RuntimeFile;
export type CppProjectSnapshot = RuntimeProjectSnapshot;
export type CppProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;
export type CppProjectCommandResult = RuntimeCommandResult;
export type CppProjectCommandRunner = RuntimeProjectCommandRunner<CppProjectCommandRequest>;
export type BrowserCppProjectCommandRunner = CppProjectCommandRunner;

export interface BrowserCppProjectRunnerOptions {
  timeoutMs?: number;
  applyFileChange?: (
    change: RuntimeFileChange,
    phase: RuntimeFileMutationPhase,
    options?: RuntimeProjectFileChangeApplyOptions
  ) => Promise<boolean | void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createBrowserCppProjectRunner(
  workerClient: Pick<CppWorkerClient, 'executeProjectCpp'> & {
    executeProjectCpp(
      request: CppProjectCommandRequest,
      timeoutMs?: number,
      onEvent?: RuntimeCommandEventHandler,
      signal?: AbortSignal
    ): Promise<CppProjectCommandResult>;
  },
  options: BrowserCppProjectRunnerOptions = {}
): CppProjectCommandRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (request) => {
    return runRuntimeProjectWorkerBridge({
      request,
      startPhase: request.source === 'compile' ? 'compile-start' : 'process-start',
      startMessage: request.source === 'compile' ? 'Starting C++ browser compile' : 'Starting C++ browser executable',
      startDetail: { source: request.source, scriptPath: request.scriptPath, args: request.args, cwd: request.cwd },
      finishPhase: request.source === 'compile' ? 'compile-end' : 'process-exit',
      finishMessage: request.source === 'compile' ? 'Finished C++ browser compile' : 'Finished C++ browser executable',
      finishDetail: (result) => ({ source: request.source, exitCode: result.exitCode }),
      applyFileChange: options.applyFileChange,
      run: (workerRequest, onEvent) => workerClient.executeProjectCpp(workerRequest, timeoutMs, onEvent, workerRequest.signal),
    });
  };
}

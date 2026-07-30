import type {
  RuntimeCommandResult,
  RuntimeFileChange,
  RuntimeFile,
  RuntimeFileEncoding,
  RuntimeFileMutationPhase,
  RuntimeCommandEventHandler,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectEngineLeaseController,
  RuntimeProjectFileChangeApplyOptions,
  RuntimeProjectSnapshot,
} from '@tracecode/runtime-contracts';
import {
  runRuntimeProjectWorkerBridge,
  withRuntimeProjectCommandRunnerCapabilities,
} from '@tracecode/runtime-contracts';
import type { PythonWorkerClient } from './python-worker-client';

export type PythonProjectFileEncoding = RuntimeFileEncoding;
export type PythonProjectFile = RuntimeFile;
export type PythonProjectSnapshot = RuntimeProjectSnapshot;
export type PythonProjectCommandRequest = RuntimeProjectCommandRequest<
  'argument' | 'file' | 'stdin' | 'module'
>;
export type PythonProjectCommandResult = RuntimeCommandResult;
export type PythonProjectCommandRunner = RuntimeProjectCommandRunner<PythonProjectCommandRequest>;
export type BrowserPythonProjectCommandRunner = PythonProjectCommandRunner;

export interface BrowserPythonProjectRunnerOptions {
  timeoutMs?: number;
  applyFileChange?: (
    change: RuntimeFileChange,
    phase: RuntimeFileMutationPhase,
    options?: RuntimeProjectFileChangeApplyOptions
  ) => Promise<boolean | void>;
}

export interface BrowserPythonProjectWorkerClient {
  executeProjectPython(
    request: PythonProjectCommandRequest,
    timeoutMs?: number,
    onEvent?: RuntimeCommandEventHandler,
    signal?: AbortSignal,
    engineLease?: RuntimeProjectEngineLeaseController
  ): Promise<PythonProjectCommandResult>;
}

export function createBrowserPythonProjectRunner(
  workerClient: BrowserPythonProjectWorkerClient | PythonWorkerClient,
  options: BrowserPythonProjectRunnerOptions = {}
): BrowserPythonProjectCommandRunner {
  return withRuntimeProjectCommandRunnerCapabilities(
    (request) => runRuntimeProjectWorkerBridge({
      request,
      startPhase: 'process-start',
      startMessage: 'Starting Python browser project command',
      startDetail: {
        source: request.source,
        scriptPath: request.scriptPath,
        args: request.args,
        cwd: request.cwd,
      },
      finishPhase: 'process-exit',
      finishMessage: 'Finished Python browser project command',
      applyFileChange: options.applyFileChange,
      run: (workerRequest, onEvent, engineLease) =>
        workerClient.executeProjectPython(
          workerRequest,
          options.timeoutMs,
          onEvent,
          workerRequest.signal,
          engineLease
        ),
    }),
    { descriptorStdio: true }
  );
}

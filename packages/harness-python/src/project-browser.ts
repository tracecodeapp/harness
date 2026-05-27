import type {
  RuntimeCommandResult,
  RuntimeFileChange,
  RuntimeFile,
  RuntimeFileEncoding,
  RuntimeFileMutationPhase,
  RuntimeCommandEventHandler,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectSnapshot,
} from '../../harness-core/src/runtime-project';
import { runRuntimeProjectWorkerBridge } from '../../harness-core/src/runtime-project';
import type { PythonWorkerClient } from '../../harness-browser/src/pyodide-worker-client';

export type PythonProjectFileEncoding = RuntimeFileEncoding;
export type PythonProjectFile = RuntimeFile;
export type PythonProjectSnapshot = RuntimeProjectSnapshot;
export type PythonProjectCommandRequest = RuntimeProjectCommandRequest<
  'argument' | 'file' | 'stdin' | 'module'
>;
export type PythonProjectCommandResult = RuntimeCommandResult;
export type PythonProjectCommandRunner = RuntimeProjectCommandRunner<PythonProjectCommandRequest>;
export type BrowserPythonProjectCommandRunner = PythonProjectCommandRunner;
export type PyodidePythonProjectCommandRunner = PythonProjectCommandRunner;

export interface BrowserPythonProjectRunnerOptions {
  timeoutMs?: number;
  applyFileChange?: (change: RuntimeFileChange, phase: RuntimeFileMutationPhase) => Promise<boolean | void>;
}

export type CreatePyodidePythonProjectRunnerOptions = BrowserPythonProjectRunnerOptions;

export interface PyodidePythonProjectWorkerClient {
  executeProjectPython(
    request: PythonProjectCommandRequest,
    timeoutMs?: number,
    onEvent?: RuntimeCommandEventHandler,
    signal?: AbortSignal
  ): Promise<PythonProjectCommandResult>;
}

export type BrowserPythonProjectWorkerClient = PyodidePythonProjectWorkerClient;

export function createBrowserPythonProjectRunner(
  workerClient: PyodidePythonProjectWorkerClient | PythonWorkerClient,
  options: BrowserPythonProjectRunnerOptions = {}
): BrowserPythonProjectCommandRunner {
  return (request) =>
    runRuntimeProjectWorkerBridge({
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
      run: (workerRequest, onEvent) => workerClient.executeProjectPython(workerRequest, options.timeoutMs, onEvent, workerRequest.signal),
    });
}

export const createPyodidePythonProjectRunner = createBrowserPythonProjectRunner;

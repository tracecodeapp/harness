import type {
  RuntimeCommandResult,
  RuntimeFile,
  RuntimeFileEncoding,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectSnapshot,
} from '../../harness-core/src/runtime-project';
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
}

export type CreatePyodidePythonProjectRunnerOptions = BrowserPythonProjectRunnerOptions;

export interface PyodidePythonProjectWorkerClient {
  executeProjectPython(
    request: PythonProjectCommandRequest,
    timeoutMs?: number
  ): Promise<PythonProjectCommandResult>;
}

export type BrowserPythonProjectWorkerClient = PyodidePythonProjectWorkerClient;

export function createBrowserPythonProjectRunner(
  workerClient: PyodidePythonProjectWorkerClient | PythonWorkerClient,
  options: BrowserPythonProjectRunnerOptions = {}
): BrowserPythonProjectCommandRunner {
  return (request) => {
    request.onEvent?.({
      type: 'status',
      phase: 'process-start',
      message: 'Starting Python browser project command',
      detail: { source: request.source, scriptPath: request.scriptPath, args: request.args, cwd: request.cwd },
    });
    const { onEvent: _onEvent, ...workerRequest } = request;
    return workerClient.executeProjectPython(workerRequest, options.timeoutMs).then((result) => {
      request.onEvent?.({
        type: 'status',
        phase: 'process-exit',
        message: 'Finished Python browser project command',
        detail: { exitCode: result.exitCode },
      });
      if (result.stdout) request.onEvent?.({ type: 'output', stream: 'stdout', data: result.stdout });
      if (result.stderr) request.onEvent?.({ type: 'output', stream: 'stderr', data: result.stderr });
      return result;
    });
  };
}

export const createPyodidePythonProjectRunner = createBrowserPythonProjectRunner;

import type {
  RuntimeCommandEvent,
  RuntimeCommandResult,
  RuntimeFile,
  RuntimeFileEncoding,
  RuntimeCommandEventHandler,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectSnapshot,
} from '../../harness-core/src/runtime-project';
import { createRuntimeProjectIoBridge } from '../../harness-core/src/runtime-project';
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
    timeoutMs?: number,
    onEvent?: RuntimeCommandEventHandler
  ): Promise<PythonProjectCommandResult>;
}

export type BrowserPythonProjectWorkerClient = PyodidePythonProjectWorkerClient;

export function createBrowserPythonProjectRunner(
  workerClient: PyodidePythonProjectWorkerClient | PythonWorkerClient,
  options: BrowserPythonProjectRunnerOptions = {}
): BrowserPythonProjectCommandRunner {
  return (request) => {
    let stdoutStreamed = false;
    let stderrStreamed = false;
    const io = createRuntimeProjectIoBridge((event: RuntimeCommandEvent) => {
      if (event.type === 'output' && event.stream === 'stdout') stdoutStreamed = true;
      if (event.type === 'output' && event.stream === 'stderr') stderrStreamed = true;
      request.onEvent?.(event);
    });
    const forwardWorkerEvent = (event: RuntimeCommandEvent): void => {
      if (event.type === 'output' && event.stream === 'stdout') stdoutStreamed = true;
      if (event.type === 'output' && event.stream === 'stderr') stderrStreamed = true;
      request.onEvent?.(event);
    };
    io.status('process-start', 'Starting Python browser project command', {
      source: request.source,
      scriptPath: request.scriptPath,
      args: request.args,
      cwd: request.cwd,
    });
    const { onEvent: _onEvent, ...workerRequest } = request;
    return workerClient.executeProjectPython(workerRequest, options.timeoutMs, forwardWorkerEvent).then((result) => {
      io.status('process-exit', 'Finished Python browser project command', { exitCode: result.exitCode });
      if (result.stdout && !stdoutStreamed) io.output('stdout', result.stdout);
      if (result.stderr && !stderrStreamed) io.output('stderr', result.stderr);
      return result;
    });
  };
}

export const createPyodidePythonProjectRunner = createBrowserPythonProjectRunner;

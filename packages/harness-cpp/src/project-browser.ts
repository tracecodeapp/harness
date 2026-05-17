import type {
  RuntimeCommandResult,
  RuntimeFile,
  RuntimeFileEncoding,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectSnapshot,
} from '../../harness-core/src/runtime-project';
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
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createBrowserCppProjectRunner(
  workerClient: Pick<CppWorkerClient, 'executeProjectCpp'>,
  options: BrowserCppProjectRunnerOptions = {}
): CppProjectCommandRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (request) => {
    request.onEvent?.({
      type: 'status',
      phase: request.source === 'compile' ? 'compile-start' : 'process-start',
      message: request.source === 'compile' ? 'Starting C++ browser compile' : 'Starting C++ browser executable',
      detail: { source: request.source, scriptPath: request.scriptPath, args: request.args, cwd: request.cwd },
    });
    const { onEvent: _onEvent, ...workerRequest } = request;
    return workerClient.executeProjectCpp(workerRequest, timeoutMs).then((result) => {
      request.onEvent?.({
        type: 'status',
        phase: request.source === 'compile' ? 'compile-end' : 'process-exit',
        message: request.source === 'compile' ? 'Finished C++ browser compile' : 'Finished C++ browser executable',
        detail: { source: request.source, exitCode: result.exitCode },
      });
      if (result.stdout) request.onEvent?.({ type: 'output', stream: 'stdout', data: result.stdout });
      if (result.stderr) request.onEvent?.({ type: 'output', stream: 'stderr', data: result.stderr });
      return result;
    });
  };
}

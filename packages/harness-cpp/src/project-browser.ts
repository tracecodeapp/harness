import type {
  RuntimeCommandEvent,
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeFile,
  RuntimeFileEncoding,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectSnapshot,
} from '../../harness-core/src/runtime-project';
import { createRuntimeProjectIoBridge } from '../../harness-core/src/runtime-project';
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
  workerClient: Pick<CppWorkerClient, 'executeProjectCpp'> & {
    executeProjectCpp(
      request: CppProjectCommandRequest,
      timeoutMs?: number,
      onEvent?: RuntimeCommandEventHandler
    ): Promise<CppProjectCommandResult>;
  },
  options: BrowserCppProjectRunnerOptions = {}
): CppProjectCommandRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    io.status(
      request.source === 'compile' ? 'compile-start' : 'process-start',
      request.source === 'compile' ? 'Starting C++ browser compile' : 'Starting C++ browser executable',
      { source: request.source, scriptPath: request.scriptPath, args: request.args, cwd: request.cwd }
    );
    const { onEvent: _onEvent, ...workerRequest } = request;
    return workerClient.executeProjectCpp(workerRequest, timeoutMs, forwardWorkerEvent).then((result) => {
      io.status(
        request.source === 'compile' ? 'compile-end' : 'process-exit',
        request.source === 'compile' ? 'Finished C++ browser compile' : 'Finished C++ browser executable',
        { source: request.source, exitCode: result.exitCode }
      );
      if (result.stdout && !stdoutStreamed) io.output('stdout', result.stdout);
      if (result.stderr && !stderrStreamed) io.output('stderr', result.stderr);
      return result;
    });
  };
}

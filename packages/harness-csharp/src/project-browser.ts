import type {
  RuntimeCommandResult,
  RuntimeFile,
  RuntimeFileEncoding,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectSnapshot,
} from '../../harness-core/src/runtime-project';
import type { CSharpWorkerClient } from '../../harness-browser/src/csharp-worker-client';

export type CSharpProjectFileEncoding = RuntimeFileEncoding;
export type CSharpProjectFile = RuntimeFile;
export type CSharpProjectSnapshot = RuntimeProjectSnapshot;
export type CSharpProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;
export type CSharpProjectCommandResult = RuntimeCommandResult;
export type CSharpProjectCommandRunner = RuntimeProjectCommandRunner<CSharpProjectCommandRequest>;
export type BrowserCSharpProjectCommandRunner = CSharpProjectCommandRunner;

export interface BrowserCSharpProjectRunnerOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function createBrowserCSharpProjectRunner(
  workerClient: Pick<CSharpWorkerClient, 'executeProjectCSharp'>,
  options: BrowserCSharpProjectRunnerOptions = {}
): CSharpProjectCommandRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (request) => {
    if (request.source === 'run' && request.options?.noBuild === true) {
      return Promise.resolve({
        stdout: '',
        stderr: 'dotnet: --no-build is not supported in the browser project environment\n',
        exitCode: 2,
      });
    }
    request.onEvent?.({
      type: 'status',
      phase: request.source === 'compile' ? 'compile-start' : 'process-start',
      message: request.source === 'compile' ? 'Starting C# browser compile' : 'Starting C# browser run',
      detail: { source: request.source, scriptPath: request.scriptPath, args: request.args, cwd: request.cwd },
    });
    const { onEvent: _onEvent, ...workerRequest } = request;
    return workerClient.executeProjectCSharp(workerRequest, timeoutMs).then((result) => {
      request.onEvent?.({
        type: 'status',
        phase: request.source === 'compile' ? 'compile-end' : 'process-exit',
        message: request.source === 'compile' ? 'Finished C# browser compile' : 'Finished C# browser run',
        detail: { exitCode: result.exitCode },
      });
      if (result.stdout) request.onEvent?.({ type: 'output', stream: 'stdout', data: result.stdout });
      if (result.stderr) request.onEvent?.({ type: 'output', stream: 'stderr', data: result.stderr });
      return result;
    });
  };
}

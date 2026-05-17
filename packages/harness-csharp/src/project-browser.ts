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
  workerClient: Pick<CSharpWorkerClient, 'executeProjectCSharp'> & {
    executeProjectCSharp(
      request: CSharpProjectCommandRequest,
      timeoutMs?: number,
      onEvent?: RuntimeCommandEventHandler
    ): Promise<CSharpProjectCommandResult>;
  },
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
      request.source === 'compile' ? 'Starting C# browser compile' : 'Starting C# browser run',
      { source: request.source, scriptPath: request.scriptPath, args: request.args, cwd: request.cwd }
    );
    const { onEvent: _onEvent, ...workerRequest } = request;
    return workerClient.executeProjectCSharp(workerRequest, timeoutMs, forwardWorkerEvent).then((result) => {
      io.status(
        request.source === 'compile' ? 'compile-end' : 'process-exit',
        request.source === 'compile' ? 'Finished C# browser compile' : 'Finished C# browser run',
        { exitCode: result.exitCode }
      );
      if (result.stdout && !stdoutStreamed) io.output('stdout', result.stdout);
      if (result.stderr && !stderrStreamed) io.output('stderr', result.stderr);
      return result;
    });
  };
}

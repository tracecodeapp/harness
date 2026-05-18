import type {
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeFileChange,
  RuntimeFile,
  RuntimeFileEncoding,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectSnapshot,
} from '../../harness-core/src/runtime-project';
import { runRuntimeProjectWorkerBridge } from '../../harness-core/src/runtime-project';
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
  applyFileChange?: (change: RuntimeFileChange) => Promise<void>;
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
    return runRuntimeProjectWorkerBridge({
      request,
      startPhase: request.source === 'compile' ? 'compile-start' : 'process-start',
      startMessage: request.source === 'compile' ? 'Starting C# browser compile' : 'Starting C# browser run',
      startDetail: { source: request.source, scriptPath: request.scriptPath, args: request.args, cwd: request.cwd },
      finishPhase: request.source === 'compile' ? 'compile-end' : 'process-exit',
      finishMessage: request.source === 'compile' ? 'Finished C# browser compile' : 'Finished C# browser run',
      applyFileChange: options.applyFileChange,
      run: (workerRequest, onEvent) => workerClient.executeProjectCSharp(workerRequest, timeoutMs, onEvent),
    });
  };
}

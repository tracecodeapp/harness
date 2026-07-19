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
import { createRuntimeProjectIoBridge, runRuntimeProjectWorkerBridge } from '@tracecode/harness-core';
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
  applyFileChange?: (
    change: RuntimeFileChange,
    phase: RuntimeFileMutationPhase,
    options?: RuntimeProjectFileChangeApplyOptions
  ) => Promise<boolean | void>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const NO_BUILD_UNSUPPORTED_STDERR = 'dotnet: --no-build is not supported by this runtime\n';
const SYMLINKS_UNSUPPORTED_STDERR = 'ENOTSUP: symbolic links are not supported by this runtime\n';

function unsupportedBrowserCSharpRunResult(request: CSharpProjectCommandRequest): CSharpProjectCommandResult {
  const result: CSharpProjectCommandResult = {
    stdout: '',
    stderr: NO_BUILD_UNSUPPORTED_STDERR,
    exitCode: 2,
  };
  const io = createRuntimeProjectIoBridge(request.onEvent);
  io.status('process-start', 'Starting C# browser run', {
    source: request.source,
    scriptPath: request.scriptPath,
    args: request.args,
    cwd: request.cwd,
  });
  io.output('stderr', result.stderr);
  io.status('process-exit', 'Finished C# browser run', { exitCode: result.exitCode });
  return result;
}

function unsupportedBrowserCSharpSymlinkResult(request: CSharpProjectCommandRequest): CSharpProjectCommandResult {
  const result: CSharpProjectCommandResult = {
    stdout: '',
    stderr: SYMLINKS_UNSUPPORTED_STDERR,
    exitCode: 1,
    error: {
      code: 'ENOTSUP',
      message: 'Symbolic links are not supported by this runtime.',
      syscall: 'materialize',
    },
  };
  const io = createRuntimeProjectIoBridge(request.onEvent);
  io.status('process-start', 'Starting C# browser command', {
    source: request.source,
    scriptPath: request.scriptPath,
    args: request.args,
    cwd: request.cwd,
  });
  io.output('stderr', result.stderr);
  io.status('process-exit', 'Finished C# browser command', { exitCode: result.exitCode, code: 'ENOTSUP' });
  return result;
}

export function createBrowserCSharpProjectRunner(
  workerClient: Pick<CSharpWorkerClient, 'executeProjectCSharp'> & {
    executeProjectCSharp(
      request: CSharpProjectCommandRequest,
      timeoutMs?: number,
      onEvent?: RuntimeCommandEventHandler,
      signal?: AbortSignal
    ): Promise<CSharpProjectCommandResult>;
  },
  options: BrowserCSharpProjectRunnerOptions = {}
): CSharpProjectCommandRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (request) => {
    if ((request.project.symlinks?.length ?? 0) > 0) {
      return Promise.resolve(unsupportedBrowserCSharpSymlinkResult(request));
    }
    if (request.source === 'run' && request.options?.noBuild === true) {
      return Promise.resolve(unsupportedBrowserCSharpRunResult(request));
    }
    return runRuntimeProjectWorkerBridge({
      request,
      startPhase: request.source === 'compile' ? 'compile-start' : 'process-start',
      startMessage: request.source === 'compile' ? 'Starting C# browser compile' : 'Starting C# browser run',
      startDetail: { source: request.source, scriptPath: request.scriptPath, args: request.args, cwd: request.cwd },
      finishPhase: request.source === 'compile' ? 'compile-end' : 'process-exit',
      finishMessage: request.source === 'compile' ? 'Finished C# browser compile' : 'Finished C# browser run',
      applyFileChange: options.applyFileChange,
      run: (workerRequest, onEvent) => workerClient.executeProjectCSharp(workerRequest, timeoutMs, onEvent, workerRequest.signal),
    });
  };
}

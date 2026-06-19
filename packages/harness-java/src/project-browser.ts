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
} from '../../harness-core/src/runtime-project';
import { createRuntimeProjectIoBridge, runRuntimeProjectWorkerBridge } from '../../harness-core/src/runtime-project';
import type { JavaWorkerClient } from '../../harness-browser/src/java-worker-client';

export type JavaProjectFileEncoding = RuntimeFileEncoding;
export type JavaProjectFile = RuntimeFile;
export type JavaProjectSnapshot = RuntimeProjectSnapshot;
export type JavaProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;
export type JavaProjectCommandResult = RuntimeCommandResult;
export type JavaProjectCommandRunner = RuntimeProjectCommandRunner<JavaProjectCommandRequest>;
export type BrowserJavaProjectCommandRunner = JavaProjectCommandRunner;

export interface BrowserJavaProjectRunnerOptions {
  timeoutMs?: number;
  applyFileChange?: (
    change: RuntimeFileChange,
    phase: RuntimeFileMutationPhase,
    options?: RuntimeProjectFileChangeApplyOptions
  ) => Promise<boolean | void>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function unsupportedBrowserJavaResult(request: JavaProjectCommandRequest, stderr: string): JavaProjectCommandResult {
  const result: JavaProjectCommandResult = {
    stdout: '',
    stderr,
    exitCode: 2,
  };
  const io = createRuntimeProjectIoBridge(request.onEvent);
  io.status(
    request.source === 'compile' ? 'compile-start' : 'process-start',
    request.source === 'compile' ? 'Starting Java browser compile' : 'Starting Java browser run',
    {
      source: request.source,
      scriptPath: request.scriptPath,
      args: request.args,
      cwd: request.cwd,
    }
  );
  io.output('stderr', result.stderr);
  io.status(
    request.source === 'compile' ? 'compile-end' : 'process-exit',
    request.source === 'compile' ? 'Finished Java browser compile' : 'Finished Java browser run',
    {
      exitCode: result.exitCode,
    }
  );
  return result;
}

export function createBrowserJavaProjectRunner(
  workerClient: Pick<JavaWorkerClient, 'executeProjectJava'> & {
    executeProjectJava(
      request: JavaProjectCommandRequest,
      timeoutMs?: number,
      onEvent?: RuntimeCommandEventHandler,
      signal?: AbortSignal
    ): Promise<JavaProjectCommandResult>;
  },
  options: BrowserJavaProjectRunnerOptions = {}
): JavaProjectCommandRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (request) => {
    if (request.options?.enablePreview === true) {
      return Promise.resolve(
        unsupportedBrowserJavaResult(request, 'java: --enable-preview is not supported in the browser project environment\n')
      );
    }
    if (request.options?.enableAssertions === true) {
      return Promise.resolve(
        unsupportedBrowserJavaResult(request, 'java: -ea is not supported in the browser project environment\n')
      );
    }
    return runRuntimeProjectWorkerBridge({
      request,
      startPhase: request.source === 'compile' ? 'compile-start' : 'process-start',
      startMessage: request.source === 'compile' ? 'Starting Java browser compile' : 'Starting Java browser run',
      startDetail: { source: request.source, scriptPath: request.scriptPath, args: request.args, cwd: request.cwd },
      finishPhase: request.source === 'compile' ? 'compile-end' : 'process-exit',
      finishMessage: request.source === 'compile' ? 'Finished Java browser compile' : 'Finished Java browser run',
      applyFileChange: options.applyFileChange,
      run: (workerRequest, onEvent) => workerClient.executeProjectJava(workerRequest, timeoutMs, onEvent, workerRequest.signal),
    });
  };
}

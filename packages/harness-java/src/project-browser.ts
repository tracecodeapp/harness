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
  applyFileChange?: (change: RuntimeFileChange) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function createBrowserJavaProjectRunner(
  workerClient: Pick<JavaWorkerClient, 'executeProjectJava'> & {
    executeProjectJava(
      request: JavaProjectCommandRequest,
      timeoutMs?: number,
      onEvent?: RuntimeCommandEventHandler
    ): Promise<JavaProjectCommandResult>;
  },
  options: BrowserJavaProjectRunnerOptions = {}
): JavaProjectCommandRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (request) => {
    if (request.options?.enablePreview === true) {
      return Promise.resolve({
        stdout: '',
        stderr: 'java: --enable-preview is not supported in the browser project environment\n',
        exitCode: 2,
      });
    }
    if (request.options?.enableAssertions === true) {
      return Promise.resolve({
        stdout: '',
        stderr: 'java: -ea is not supported in the browser project environment\n',
        exitCode: 2,
      });
    }
    return runRuntimeProjectWorkerBridge({
      request,
      startPhase: request.source === 'compile' ? 'compile-start' : 'process-start',
      startMessage: request.source === 'compile' ? 'Starting Java browser compile' : 'Starting Java browser run',
      startDetail: { source: request.source, scriptPath: request.scriptPath, args: request.args, cwd: request.cwd },
      finishPhase: request.source === 'compile' ? 'compile-end' : 'process-exit',
      finishMessage: request.source === 'compile' ? 'Finished Java browser compile' : 'Finished Java browser run',
      applyFileChange: options.applyFileChange,
      run: (workerRequest, onEvent) => workerClient.executeProjectJava(workerRequest, timeoutMs, onEvent),
    });
  };
}

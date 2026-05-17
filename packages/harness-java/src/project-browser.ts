import type {
  RuntimeCommandResult,
  RuntimeFile,
  RuntimeFileEncoding,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectSnapshot,
} from '../../harness-core/src/runtime-project';
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
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function createBrowserJavaProjectRunner(
  workerClient: Pick<JavaWorkerClient, 'executeProjectJava'>,
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
    return workerClient.executeProjectJava(request, timeoutMs);
  };
}

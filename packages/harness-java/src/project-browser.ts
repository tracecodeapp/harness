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
      request.source === 'compile' ? 'Starting Java browser compile' : 'Starting Java browser run',
      { source: request.source, scriptPath: request.scriptPath, args: request.args, cwd: request.cwd }
    );
    const { onEvent: _onEvent, ...workerRequest } = request;
    return workerClient.executeProjectJava(workerRequest, timeoutMs, forwardWorkerEvent).then((result) => {
      io.status(
        request.source === 'compile' ? 'compile-end' : 'process-exit',
        request.source === 'compile' ? 'Finished Java browser compile' : 'Finished Java browser run',
        { exitCode: result.exitCode }
      );
      if (result.stdout && !stdoutStreamed) io.output('stdout', result.stdout);
      if (result.stderr && !stderrStreamed) io.output('stderr', result.stderr);
      return result;
    });
  };
}

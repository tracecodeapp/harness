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
  return (request) => workerClient.executeProjectCpp(request, timeoutMs);
}

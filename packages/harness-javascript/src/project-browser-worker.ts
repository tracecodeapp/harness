import type {
  RuntimeCommandEvent,
  RuntimeCommandResult,
} from '../../harness-core/src/runtime-project';
import {
  runBrowserJavaScriptProjectRequest,
  type BrowserJavaScriptProjectRunnerOptions,
  type JavaScriptProjectCommandRequest,
} from './project-browser';

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
}

const workerScope = self as typeof self & {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  postMessage(message: unknown): void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

workerScope.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const { id, type, payload } = event.data;
  if (!id) return;

  if (type !== 'execute-project-javascript') {
    workerScope.postMessage({ id, type: 'error', payload: { error: `Unsupported JavaScript project worker message: ${type}` } });
    return;
  }

  const request = payload as JavaScriptProjectCommandRequest;
  const options: BrowserJavaScriptProjectRunnerOptions = {};
  const executionState = { cancelled: false };

  runBrowserJavaScriptProjectRequest(
    {
      ...request,
      onEvent: (runtimeEvent: RuntimeCommandEvent) => {
        if (
          runtimeEvent.type === 'status' &&
          (runtimeEvent.phase === 'process-start' || runtimeEvent.phase === 'process-exit')
        ) {
          return;
        }
        workerScope.postMessage({ id, type: 'project-event', payload: runtimeEvent });
      },
    },
    options,
    executionState
  ).then(
    (result: RuntimeCommandResult) => {
      workerScope.postMessage({ id, type: 'execute-result', payload: result });
    },
    (error) => {
      workerScope.postMessage({ id, type: 'error', payload: { error: errorMessage(error) } });
    }
  );
};

workerScope.postMessage({ type: 'worker-ready' });

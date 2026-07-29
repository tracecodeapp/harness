#!/usr/bin/env npx tsx

import { PyodideWorkerClient } from '../packages/harness-browser/src/pyodide-worker-client';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
  protocolToken?: string;
  kernelSyscallChannel?: {
    buffer: SharedArrayBuffer;
    byteCapacity: number;
  };
  kernelSyscallGenerationBuffer?: SharedArrayBuffer;
}

class PythonKernelWorker {
  static instances: PythonKernelWorker[] = [];

  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: WorkerMessage[] = [];
  terminated = false;

  constructor(_url: string | URL, _options?: WorkerOptions) {
    PythonKernelWorker.instances.push(this);
    queueMicrotask(() => {
      this.onmessage?.({
        data: { type: 'worker-ready' },
      } as MessageEvent<WorkerMessage>);
    });
  }

  postMessage(message: WorkerMessage): void {
    if (this.terminated) return;
    this.messages.push(message);
    if (message.type === 'execute-project-python') {
      queueMicrotask(() => {
        this.onmessage?.({
          data: {
            id: message.id,
            type: 'kernel-syscall',
            protocolToken: message.protocolToken,
            payload: {},
          },
        } as MessageEvent<WorkerMessage>);
      });
    }
    const payload = message.type === 'init' || message.type === 'warmup'
      ? { success: true, loadTimeMs: 0 }
      : { stdout: '', stderr: '', exitCode: 0, files: [] };
    queueMicrotask(() => {
      this.onmessage?.({
        data: {
          id: message.id,
          type: message.type,
          protocolToken: message.protocolToken,
          payload,
        },
      } as MessageEvent<WorkerMessage>);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

async function main(): Promise<void> {
  const originalWorker = globalThis.Worker;
  // @ts-expect-error focused Worker protocol double
  globalThis.Worker = PythonKernelWorker;
  PythonKernelWorker.instances = [];
  const syscallBuffer = new SharedArrayBuffer(288);
  const generationBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  let serviceCalls = 0;
  const client = new PyodideWorkerClient({
    workerUrl: '/workers/pyodide-worker.js',
  });
  try {
    await client.executeProjectPython({
      code: 'print("ok")',
      source: 'file',
      scriptPath: 'main.py',
      args: [],
      cwd: '/workspace',
      env: {},
      project: {
        workspaceRoot: '/workspace',
        files: [{ path: 'main.py', contents: 'print("ok")\n' }],
      },
      kernelSyscalls: {
        channel: { buffer: syscallBuffer, byteCapacity: 256 },
        generationBuffer,
        dispatch: async () => ({
          ok: false,
          error: { code: 'ENOSYS', message: 'not used by the sync transport test' },
        }),
        service: async () => {
          serviceCalls += 1;
        },
        close: () => undefined,
      },
    });
    await Promise.resolve();
    const execution = PythonKernelWorker.instances
      .flatMap((worker) => worker.messages)
      .find((message) => message.type === 'execute-project-python');
    assertCondition(
      execution?.kernelSyscallChannel?.buffer === syscallBuffer &&
        execution.kernelSyscallGenerationBuffer === generationBuffer,
      'Python project execution should receive the shared syscall and TKFS generation buffers'
    );
    assertCondition(
      serviceCalls === 1,
      `Python syscall notifications should service the correlated bridge once: ${serviceCalls}`
    );
  } finally {
    client.terminate();
    globalThis.Worker = originalWorker;
  }
  console.log('PASS: Python project worker syscall channel plumbing');
}

await main();

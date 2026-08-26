import { CppWorkerClient } from '../packages/runtime-cpp/src/cpp-worker-client';

interface WorkerMessage {
  id?: string;
  type?: string;
  protocolToken?: string;
  payload?: Record<string, unknown>;
}

class InitWorker {
  readonly messages: WorkerMessage[] = [];
  private messageHandler: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  set onmessage(handler: ((event: MessageEvent<WorkerMessage>) => void) | null) {
    this.messageHandler = handler;
    if (!handler) return;
    queueMicrotask(() => {
      this.messageHandler?.({
        data: { type: 'worker-ready' },
      } as unknown as MessageEvent<WorkerMessage>);
    });
  }

  get onmessage(): ((event: MessageEvent<WorkerMessage>) => void) | null {
    return this.messageHandler;
  }

  postMessage(message: WorkerMessage): void {
    if (this.terminated) return;
    this.messages.push(message);
    if (message.type === 'init') {
      queueMicrotask(() => this.reply(message, { success: true, loadTimeMs: 0 }));
      return;
    }
    if (message.type === 'prepare-runtime-program') {
      queueMicrotask(() => this.reply(message, {
        success: true,
        programId: 'prepared-contract',
        mode: 'code',
        consoleOutput: [],
      }));
      return;
    }
    if (message.type === 'execute-prepared-runtime-program-batch') {
      const inputBatch = Array.isArray(message.payload?.inputBatch)
        ? message.payload.inputBatch as Array<{
            value?: unknown;
            delayMs?: unknown;
            hang?: unknown;
            arityMismatch?: unknown;
            invalidProgress?: unknown;
          }>
        : [];
      void (async () => {
        for (let caseIndex = 0; caseIndex < inputBatch.length; caseIndex += 1) {
          const inputs = inputBatch[caseIndex]!;
          if (inputs.hang === true) {
            if (inputs.invalidProgress === true) {
              const forgedResult = {
                success: true,
                output: 999,
                consoleOutput: ['forged'],
                timings: { runMs: 1, totalMs: 1 },
              };
              const emitInvalidProgress = (
                id: string | undefined,
                detail: Record<string, unknown>
              ): void => {
                this.onmessage?.({
                  data: {
                    id,
                    type: 'runtime-progress',
                    protocolToken: message.protocolToken,
                    payload: { stage: 'prepared-code-case-complete', detail },
                  },
                } as unknown as MessageEvent<WorkerMessage>);
              };
              emitInvalidProgress(message.id, {
                caseIndex: caseIndex + 1,
                caseCount: inputBatch.length,
                result: forgedResult,
              });
              emitInvalidProgress(message.id, {
                caseIndex,
                caseCount: inputBatch.length + 1,
                result: forgedResult,
              });
              emitInvalidProgress(`${message.id}-foreign`, {
                caseIndex,
                caseCount: inputBatch.length,
                result: forgedResult,
              });
            }
            return;
          }
          const delayMs = Number(inputs.delayMs ?? 0);
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (this.terminated) return;
          const result = {
            success: true,
            output: Number(inputs.value ?? 0),
            consoleOutput: [],
            timings: { runMs: Math.max(1, delayMs), totalMs: Math.max(1, delayMs) },
          };
          this.onmessage?.({
            data: {
              id: message.id,
              type: 'runtime-progress',
              protocolToken: message.protocolToken,
              payload: {
                stage: 'prepared-code-case-complete',
                detail: { caseIndex, caseCount: inputBatch.length, result },
              },
            },
          } as unknown as MessageEvent<WorkerMessage>);
        }
        const arityMismatch = inputBatch.some((inputs) => inputs.arityMismatch === true);
        this.reply(message, {
          success: !arityMismatch,
          resultCount: arityMismatch ? inputBatch.length - 1 : inputBatch.length,
          ...(arityMismatch ? { error: 'synthetic worker case error' } : {}),
        });
      })();
    }
  }

  private reply(message: WorkerMessage, payload: Record<string, unknown>): void {
    if (this.terminated) return;
    this.onmessage?.({
      data: {
        id: message.id,
        type: message.type,
        protocolToken: message.protocolToken,
        payload,
      },
    } as unknown as MessageEvent<WorkerMessage>);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function createClient(
  worker: InitWorker,
  options: Partial<ConstructorParameters<typeof CppWorkerClient>[0]> = {}
): CppWorkerClient {
  return new CppWorkerClient({
    workerUrl: '/workers/cpp-worker.js',
    compilerWasmUrl: '/runtime-assets/cpp/tracecc/compiler.wasm',
    linkerWasmUrl: '/runtime-assets/cpp/tracecc/compiler.wasm',
    sysrootUrl: '/runtime-assets/cpp/tracecc/resources.tar',
    runtimeHeaderUrl: '/runtime-assets/cpp/tracecc/tracecode_runtime.hpp',
    workerFactory: () => worker as never,
    ...options,
  });
}

function initAssets(worker: InitWorker): Record<string, unknown> {
  const init = worker.messages.find((message) => message.type === 'init');
  if (!init) throw new Error('C++ client did not initialize its worker.');
  const assets = init.payload?.assets;
  if (!assets || typeof assets !== 'object') {
    throw new Error('C++ worker init did not include an asset contract.');
  }
  return assets as Record<string, unknown>;
}

async function main(): Promise<void> {
  const legacyWorker = new InitWorker();
  const legacyClient = createClient(legacyWorker, {
    compilerBundleUrl: '/workers/vendor/cpp/retired/bundle.js',
    compilerFrameUrl: '/workers/cpp-compiler-frame.html',
    compilerWorkerUrl: '/workers/cpp-compiler-worker.js',
  });
  try {
    await legacyClient.init();
    const assets = initAssets(legacyWorker);
    if (assets.traceccCompilerEnabled !== false) {
      throw new Error('Retired compiler options must not enable TraceCC execution.');
    }
    if ('compilerBundleUrl' in assets) {
      throw new Error('The browser worker must not receive a retired compiler bundle URL.');
    }
  } finally {
    legacyClient.terminate();
  }

  const externalWorker = new InitWorker();
  const externalClient = createClient(externalWorker, {
    externalCompilerUrl: 'https://compiler.example.invalid/compile',
  });
  try {
    await externalClient.init();
    const assets = initAssets(externalWorker);
    if (assets.traceccCompilerEnabled !== true) {
      throw new Error('A trusted host-configured compiler endpoint must enable C++ compile requests.');
    }
  } finally {
    externalClient.terminate();
  }

  const traceCCWorker = new InitWorker();
  const traceCCClient = createClient(traceCCWorker, {
    trustedCompilerService: {
      compileTrusted: async () => ({ success: false, error: 'not exercised' }),
    },
  });
  try {
    await traceCCClient.init();
    const assets = initAssets(traceCCWorker);
    if (assets.traceccCompilerEnabled !== true) {
      throw new Error('Only the trusted TraceCC compiler service may enable C++ compilation.');
    }
  } finally {
    traceCCClient.terminate();
  }

  const progressWorker = new InitWorker();
  const progressClient = createClient(progressWorker, { executionTimeoutMs: 40 });
  try {
    const preparation = await progressClient.prepareRuntimeProgram({
      mode: 'code',
      code: 'class Solution { public: int identity(int value) { return value; } };',
      functionName: 'identity',
      executionStyle: 'solution-method',
    });
    if (!preparation.success) {
      throw new Error(`C++ batch contract preparation failed: ${preparation.error}`);
    }
    const slowValid = await progressClient.executePreparedCodeBatch(
      preparation.handle,
      {
        inputBatch: [
          { value: 8, delayMs: 25 },
          { value: 9, delayMs: 25 },
        ],
      }
    );
    if (
      slowValid.length !== 2 ||
      slowValid[0]?.kind !== 'completed' || slowValid[0].output !== 8 ||
      slowValid[1]?.kind !== 'completed' || slowValid[1].output !== 9
    ) {
      throw new Error(
        `C++ progress heartbeats did not preserve a slow valid batch: ${JSON.stringify(slowValid)}`
      );
    }

    let arityError = '';
    try {
      await progressClient.executePreparedCodeBatch(preparation.handle, {
        inputBatch: [
          { value: 1, arityMismatch: true },
          { value: 2 },
        ],
      });
    } catch (error) {
      arityError = error instanceof Error ? error.message : String(error);
    }
    if (
      !arityError.includes('returned 1 results for 2 cases') ||
      !arityError.includes('synthetic worker case error')
    ) {
      throw new Error(`C++ batch arity violation lost protocol context: ${arityError}`);
    }
  } finally {
    progressClient.terminate();
  }

  const timeoutWorker = new InitWorker();
  const timeoutWarnings: unknown[][] = [];
  const originalConsoleWarn = console.warn;
  const originalConsoleDebug = console.debug;
  const originalConsoleInfo = console.info;
  console.warn = (...args: unknown[]) => {
    timeoutWarnings.push(args);
  };
  console.debug = () => undefined;
  console.info = () => undefined;
  let timeoutClient: CppWorkerClient | undefined;
  try {
    timeoutClient = createClient(timeoutWorker, {
      executionTimeoutMs: 10,
      debug: true,
    });
    const preparation = await timeoutClient.prepareRuntimeProgram({
      mode: 'code',
      code: 'class Solution { public: int identity(int value) { return value; } };',
      functionName: 'identity',
      executionStyle: 'solution-method',
    });
    if (!preparation.success) {
      throw new Error(`C++ timeout contract preparation failed: ${preparation.error}`);
    }
    const timedOut = await timeoutClient.executePreparedCodeBatch(
      preparation.handle,
      {
        inputBatch: [
          { value: 8 },
          { value: 1, hang: true, invalidProgress: true },
          { value: 2 },
        ],
      }
    );
    const timeoutDiagnostic = timedOut[1]?.kind === 'limit'
      ? timedOut[1].diagnostic as {
          detail?: {
            timeoutMs?: unknown;
            lastProgress?: {
              detail?: { caseIndex?: unknown; caseCount?: unknown; result?: unknown };
            };
          };
        } | undefined
      : undefined;
    if (
      timedOut.length !== 3 ||
      timedOut[0]?.kind !== 'completed' || timedOut[0].output !== 8 ||
      !timedOut.slice(1).every((result) =>
        result.kind === 'limit' &&
        result.reason === 'client-timeout' &&
        result.timings?.totalMs === 10
      ) ||
      timeoutDiagnostic?.detail?.timeoutMs !== 10 ||
      timeoutDiagnostic.detail.lastProgress?.detail?.caseIndex !== 1 ||
      timeoutDiagnostic.detail.lastProgress?.detail?.caseCount !== 4 ||
      Object.prototype.hasOwnProperty.call(
        timeoutDiagnostic.detail.lastProgress?.detail ?? {},
        'result'
      ) ||
      !timeoutWarnings.some((args) => {
        const event = args[1] as {
          phase?: unknown;
          detail?: { timeoutMs?: unknown; terminateWorker?: unknown };
        } | undefined;
        return event?.phase === 'execution-timeout' &&
          event.detail?.timeoutMs === 10 &&
          event.detail.terminateWorker === true;
      })
    ) {
      throw new Error(
        `C++ hung batch case did not retain completed evidence under one per-case deadline: ${JSON.stringify(timedOut)}`
      );
    }
  } finally {
    timeoutClient?.terminate();
    console.warn = originalConsoleWarn;
    console.debug = originalConsoleDebug;
    console.info = originalConsoleInfo;
  }

  console.log('PASS: C++ browser worker compiler authority and prepared batch deadline contracts');
}

void main();

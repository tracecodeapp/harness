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
    this.messages.push(message);
    if (message.type !== 'init') return;
    queueMicrotask(() => {
      this.onmessage?.({
        data: {
          id: message.id,
          type: message.type,
          protocolToken: message.protocolToken,
          payload: { success: true, loadTimeMs: 0 },
        },
      } as unknown as MessageEvent<WorkerMessage>);
    });
  }

  terminate(): void {}
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
    externalCompilerUrl: 'https://compiler.example.invalid/compile',
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

  console.log('PASS: C++ browser worker accepts only the trusted TraceCC compiler authority');
}

void main();

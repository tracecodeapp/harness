import {
  PYTHON_RUNTIME_IMAGE_PROTOCOL_VERSION,
  type PythonRuntimeImageAssetDescriptor,
} from '@tracecode/runtime-browser';
import {
  appendWorkerUrlQueryParameter,
  createWorkerProtocolToken,
  type BrowserWorkerFactory,
  type BrowserWorkerLike,
} from '@tracecode/runtime-browser/internal';

export interface PythonRuntimeImage {
  readonly protocolVersion: typeof PYTHON_RUNTIME_IMAGE_PROTOCOL_VERSION;
  readonly compiledModule: WebAssembly.Module;
  readonly snapshot: Uint8Array;
  readonly pythonHashSeed: string;
}

export interface PythonRuntimeImageFactory {
  acquire(): Promise<PythonRuntimeImage>;
  dispose(): void;
}

interface PythonRuntimeImageFactoryOptions {
  readonly descriptor: PythonRuntimeImageAssetDescriptor;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * When supplied, immutable image fetching and Wasm compilation run in a
   * short-lived bootstrap Worker instead of the page realm.
   */
  readonly workerUrl?: string;
  readonly workerFactory?: BrowserWorkerFactory;
  readonly workerFormat?: 'classic' | 'module';
  readonly timeoutMs?: number;
}

interface PythonRuntimeImageWorkerReply {
  readonly id?: string;
  readonly type?: string;
  readonly protocolToken?: string;
  readonly payload?: {
    readonly error?: string;
    readonly runtimeImage?: PythonRuntimeImage;
  };
}

function fetchOptions(
  descriptor: PythonRuntimeImageAssetDescriptor['wasm'],
  signal: AbortSignal
): RequestInit {
  return {
    cache: 'force-cache',
    credentials: 'omit',
    redirect: 'error',
    integrity: descriptor.integrity,
    signal,
  };
}

function assertDeclaredLength(
  name: string,
  descriptor: PythonRuntimeImageAssetDescriptor['wasm'],
  actualBytes: number
): void {
  if (descriptor.size !== actualBytes) {
    throw new Error(
      `Python runtime image ${name} decoded size ${actualBytes} did not match declared size ${descriptor.size}.`
    );
  }
}

async function fetchImageAsset(
  fetchImplementation: typeof globalThis.fetch,
  name: string,
  descriptor: PythonRuntimeImageAssetDescriptor['wasm'],
  signal: AbortSignal
): Promise<Response> {
  const response = await fetchImplementation(
    descriptor.url,
    fetchOptions(descriptor, signal)
  );
  if (!response.ok || response.type === 'opaque') {
    throw new Error(
      `Python runtime image ${name} request returned HTTP ${response.status}.`
    );
  }
  return response;
}

/**
 * Page-lifetime owner for immutable CPython/Wasm startup state.
 *
 * The returned WebAssembly.Module is stateless and may be structured-cloned
 * into disposable Workers. The snapshot bytes are retained clean here and
 * cloned by postMessage; mutable Wasm memory is never shared between runners.
 */
export function createPythonRuntimeImageFactory(
  options: PythonRuntimeImageFactoryOptions
): PythonRuntimeImageFactory {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new Error('Python runtime image factory requires fetch().');
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Python runtime image timeoutMs must be positive.');
  }
  let disposed = false;
  let imagePromise: Promise<PythonRuntimeImage> | null = null;
  let activeBuildController: AbortController | null = null;
  let activeBootstrapWorker: BrowserWorkerLike | null = null;
  let activeBootstrapCancellation: (() => void) | null = null;

  const buildInWorker = (): Promise<PythonRuntimeImage> =>
    new Promise((resolve, reject) => {
      if (!options.workerUrl) {
        reject(new Error('Python runtime-image bootstrap requires a worker URL.'));
        return;
      }
      const workerFormat = options.workerFormat ?? 'classic';
      let workerUrl = appendWorkerUrlQueryParameter(
        options.workerUrl,
        'tracecodePythonRole',
        'runtime-image'
      );
      if (workerFormat === 'module') {
        workerUrl = appendWorkerUrlQueryParameter(
          workerUrl,
          'tracecodePythonWorkerFormat',
          'module'
        );
      }
      const worker = options.workerFactory
        ? options.workerFactory(
            workerUrl,
            workerFormat === 'module' ? { type: 'module' } : undefined
          )
        : new Worker(
            workerUrl,
            workerFormat === 'module' ? { type: 'module' } : undefined
          );
      activeBootstrapWorker = worker;
      const id = 'python-runtime-image';
      const protocolToken = createWorkerProtocolToken();
      let requested = false;
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeoutId);
        worker.terminate();
        if (activeBootstrapWorker === worker) activeBootstrapWorker = null;
        activeBootstrapCancellation = null;
        operation();
      };
      const timeoutId = globalThis.setTimeout(() => {
        finish(() => reject(
          new Error(
            `Python runtime image acquisition timed out after ${timeoutMs}ms.`
          )
        ));
      }, timeoutMs);
      activeBootstrapCancellation = () => {
        finish(() => reject(
          new Error('Python runtime image factory was disposed while loading.')
        ));
      };
      worker.onerror = (event) => {
        finish(() => reject(
          new Error(
            event.message || 'Python runtime-image bootstrap Worker crashed.'
          )
        ));
      };
      worker.onmessage = (event: MessageEvent<PythonRuntimeImageWorkerReply>) => {
        const message = event.data;
        if (message?.type === 'worker-ready' && !requested) {
          requested = true;
          worker.postMessage({
            id,
            type: 'build-runtime-image',
            protocolToken,
            payload: {
              source: 'tracecode-python-runtime-image-v1',
              descriptor: options.descriptor,
            },
          });
          return;
        }
        if (
          message?.id !== id ||
          message.protocolToken !== protocolToken
        ) {
          return;
        }
        if (message.type === 'error') {
          finish(() => reject(
            new Error(
              message.payload?.error ||
                'Python runtime-image bootstrap failed.'
            )
          ));
          return;
        }
        if (message.type !== 'runtime-image-result') return;
        const image = message.payload?.runtimeImage;
        if (
          image?.protocolVersion !== PYTHON_RUNTIME_IMAGE_PROTOCOL_VERSION ||
          !(image.compiledModule instanceof WebAssembly.Module) ||
          !(image.snapshot instanceof Uint8Array) ||
          image.snapshot.byteLength === 0 ||
          typeof image.pythonHashSeed !== 'string' ||
          image.pythonHashSeed.length === 0
        ) {
          finish(() => reject(
            new Error('Python runtime-image bootstrap returned an invalid image.')
          ));
          return;
        }
        finish(() => resolve(Object.freeze(image)));
      };
    });

  const build = async (): Promise<PythonRuntimeImage> => {
    if (disposed) throw new Error('Python runtime image factory is disposed.');
    if (options.workerUrl) {
      const image = await buildInWorker();
      if (disposed) {
        throw new Error(
          'Python runtime image factory was disposed while loading.'
        );
      }
      return image;
    }
    const controller = new AbortController();
    activeBuildController = controller;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = globalThis.setTimeout(() => {
        reject(
          new Error(
            `Python runtime image acquisition timed out after ${timeoutMs}ms.`
          )
        );
        controller.abort();
      }, timeoutMs);
    });
    const compileWasm = async () => {
      const response = await fetchImageAsset(
        fetchImplementation,
        'Wasm',
        options.descriptor.wasm,
        controller.signal
      );
      const declaredContentLength = Number(
        response.headers.get('content-length')
      );
      const contentEncoding = response.headers.get('content-encoding');
      // SRI is the authoritative streaming-path byte identity check. Only
      // stream an unencoded response whose wire length matches the decoded
      // release descriptor; every other response is buffered and measured.
      // Cloning and reading a successful stream solely to recount it would
      // retain a second Wasm buffer during the memory-sensitive cold path.
      const hasUsableContentLength =
        !contentEncoding &&
        Number.isFinite(declaredContentLength) &&
        declaredContentLength === options.descriptor.wasm.size;
      const compileBuffered = async (
        bufferedResponse: Response
      ): Promise<WebAssembly.Module> => {
        const bytes = await bufferedResponse.arrayBuffer();
        assertDeclaredLength(
          'Wasm',
          options.descriptor.wasm,
          bytes.byteLength
        );
        return WebAssembly.compile(bytes);
      };
      let compiledModule: WebAssembly.Module;
      if (
        hasUsableContentLength &&
        typeof WebAssembly.compileStreaming === 'function'
      ) {
        let bufferedFallback: Response | undefined;
        try {
          bufferedFallback = response.clone();
        } catch {
          // A non-cloneable response cannot preserve a second body for
          // streaming recovery, so compile its bytes directly.
        }
        if (bufferedFallback) {
          try {
            compiledModule = await WebAssembly.compileStreaming(
              Promise.resolve(response)
            );
          } catch (streamingError) {
            try {
              compiledModule = await compileBuffered(bufferedFallback);
            } catch (bufferedError) {
              throw new AggregateError(
                [streamingError, bufferedError],
                'Python runtime image Wasm failed streaming and buffered compilation.'
              );
            }
          }
        } else {
          compiledModule = await compileBuffered(response);
        }
      } else {
        compiledModule = await compileBuffered(response);
      }
      return compiledModule;
    };
    const loadSnapshot = async () => {
      const response = await fetchImageAsset(
        fetchImplementation,
        'snapshot',
        options.descriptor.snapshot,
        controller.signal
      );
      const snapshot = new Uint8Array(await response.arrayBuffer());
      assertDeclaredLength(
        'snapshot',
        options.descriptor.snapshot,
        snapshot.byteLength
      );
      return snapshot;
    };
    try {
      const [compiledModule, snapshot] = await Promise.race([
        Promise.all([compileWasm(), loadSnapshot()]),
        timeout,
      ]);
      if (disposed) {
        throw new Error(
          'Python runtime image factory was disposed while loading.'
        );
      }
      return Object.freeze({
        protocolVersion: PYTHON_RUNTIME_IMAGE_PROTOCOL_VERSION,
        compiledModule,
        snapshot,
        pythonHashSeed: options.descriptor.pythonHashSeed,
      });
    } finally {
      if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
      if (activeBuildController === controller) {
        activeBuildController = null;
      }
    }
  };

  return Object.freeze({
    acquire(): Promise<PythonRuntimeImage> {
      if (disposed) {
        return Promise.reject(new Error('Python runtime image factory is disposed.'));
      }
      imagePromise ??= build().catch((error) => {
        imagePromise = null;
        throw error;
      });
      return imagePromise;
    },
    dispose(): void {
      disposed = true;
      activeBuildController?.abort();
      activeBuildController = null;
      activeBootstrapCancellation?.();
      activeBootstrapCancellation = null;
      activeBootstrapWorker?.terminate();
      activeBootstrapWorker = null;
      imagePromise = null;
    },
  });
}

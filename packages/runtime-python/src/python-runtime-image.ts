import {
  PYTHON_RUNTIME_IMAGE_PROTOCOL_VERSION,
  type PythonRuntimeImageAssetDescriptor,
} from '@tracecode/runtime-browser';

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
  readonly timeoutMs?: number;
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

  const build = async (): Promise<PythonRuntimeImage> => {
    if (disposed) throw new Error('Python runtime image factory is disposed.');
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
      imagePromise = null;
    },
  });
}

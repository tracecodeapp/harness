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
}

function fetchOptions(
  descriptor: PythonRuntimeImageAssetDescriptor['wasm']
): RequestInit {
  return {
    cache: 'force-cache',
    credentials: 'omit',
    redirect: 'error',
    integrity: descriptor.integrity,
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
  descriptor: PythonRuntimeImageAssetDescriptor['wasm']
): Promise<Response> {
  const response = await fetchImplementation(
    descriptor.url,
    fetchOptions(descriptor)
  );
  if (!response.ok || response.type === 'opaque') {
    throw new Error(
      `Python runtime image ${name} request returned HTTP ${response.status}.`
    );
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > 0) {
    assertDeclaredLength(name, descriptor, declaredLength);
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
  let disposed = false;
  let imagePromise: Promise<PythonRuntimeImage> | null = null;

  const build = async (): Promise<PythonRuntimeImage> => {
    if (disposed) throw new Error('Python runtime image factory is disposed.');
    const compileWasm = async () => {
      const response = await fetchImageAsset(
        fetchImplementation,
        'Wasm',
        options.descriptor.wasm
      );
      const declaredContentLength = Number(
        response.headers.get('content-length')
      );
      const hasUsableContentLength =
        Number.isFinite(declaredContentLength) &&
        declaredContentLength > 0;
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
        options.descriptor.snapshot
      );
      const snapshot = new Uint8Array(await response.arrayBuffer());
      assertDeclaredLength(
        'snapshot',
        options.descriptor.snapshot,
        snapshot.byteLength
      );
      return snapshot;
    };
    const [compiledModule, snapshot] = await Promise.all([
      compileWasm(),
      loadSnapshot(),
    ]);
    if (disposed) throw new Error('Python runtime image factory was disposed while loading.');
    return Object.freeze({
      protocolVersion: PYTHON_RUNTIME_IMAGE_PROTOCOL_VERSION,
      compiledModule,
      snapshot,
      pythonHashSeed: options.descriptor.pythonHashSeed,
    });
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
      imagePromise = null;
    },
  });
}

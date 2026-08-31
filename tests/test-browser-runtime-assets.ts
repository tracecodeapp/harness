import {
  BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
  resolveBrowserRuntimeAssetManifests,
  type AnyBrowserRuntimeAssetManifest,
  type BrowserRuntimeAssetManifests,
} from '../src/browser';
import {
  resolveBrowserRuntimeAssets,
} from '../packages/runtime-browser/src/runtime-assets';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertThrowsMessage(run: () => unknown, expectedMessage: string): void {
  try {
    run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assertCondition(
      message.includes(expectedMessage),
      `Expected error containing ${JSON.stringify(expectedMessage)}, received ${JSON.stringify(message)}`
    );
    return;
  }
  throw new Error(`Expected error containing ${JSON.stringify(expectedMessage)}`);
}

const consumerOriginPolicy = {
  mode: 'allow-list',
  origins: ['https://assets.consumer.example'],
} as const;

const consumerManifests = {
  python: {
    runtime: 'python',
    runtimeVersion: '314.0.2',
    protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
    workerFormat: 'module',
    loaderFormat: 'module',
    assetBaseUrl: 'https://assets.consumer.example/python/314.0.2',
    originPolicy: consumerOriginPolicy,
    assets: {
      worker: {
        url: 'worker.js',
        integrity: 'sha384-python-worker',
        mediaType: 'text/javascript',
        size: 1024,
      },
      runtime: { url: 'python-runtime.mjs' },
      snippets: { url: 'harness-snippets.mjs' },
      runtimeLoader: { url: 'pyodide.mjs' },
      runtimeIndex: { url: './' },
      distribution: {
        'pyodide-lock.json': { url: 'pyodide-lock.json' },
        'pyodide.asm.wasm': { url: 'pyodide.asm.wasm' },
      },
      packages: {
        sortedcontainers: { url: 'sortedcontainers.whl' },
      },
    },
  },
  javascript: {
    runtime: 'javascript',
    runtimeVersion: 'es2022',
    protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
    workerFormat: 'classic',
    assetBaseUrl: 'https://assets.consumer.example/javascript/es2022',
    originPolicy: consumerOriginPolicy,
    assets: {
      worker: { url: 'classic-worker.js' },
      algorithmWorker: { url: 'ses-algorithm-worker.js' },
      projectWorker: { url: 'project-worker.js' },
      libraries: { url: 'javascript-libraries.js' },
    },
  },
  typescript: {
    runtime: 'typescript',
    runtimeVersion: '5.9.3',
    protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
    loaderFormat: 'classic-script',
    assetBaseUrl: 'https://assets.consumer.example/typescript/5.9.3',
    originPolicy: consumerOriginPolicy,
    assets: {
      compiler: { url: 'typescript.js' },
    },
  },
  java: {
    runtime: 'java',
    runtimeVersion: '17-browser-1',
    protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
    workerFormat: 'classic',
    loaderFormat: 'classic-script',
    assetBaseUrl: 'https://assets.consumer.example/java/17-browser-1',
    originPolicy: consumerOriginPolicy,
    assets: {
      worker: { url: 'java-worker.js' },
    },
  },
  csharp: {
    runtime: 'csharp',
    runtimeVersion: 'csharp-browser-1',
    protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
    workerFormat: 'module',
    loaderFormat: 'module',
    assetBaseUrl: 'https://assets.consumer.example/csharp/csharp-browser-1',
    originPolicy: consumerOriginPolicy,
    assets: {
      worker: { url: 'csharp-worker.js' },
      assetBaseUrl: { url: 'runtime' },
      dependencies: {
        '_framework/dotnet.js': { url: 'runtime/_framework/dotnet.js' },
        '_framework/dotnet.native.wasm': { url: 'runtime/_framework/dotnet.native.wasm' },
      },
    },
  },
  cpp: {
    runtime: 'cpp',
    runtimeVersion: 'cpp23-browser-1',
    protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
    workerFormat: 'module',
    assetBaseUrl: 'https://assets.consumer.example/cpp/cpp23-browser-1',
    originPolicy: consumerOriginPolicy,
    assets: {
      worker: { url: 'cpp-worker.js' },
      runtimeHeader: { url: 'tracecode_runtime.hpp' },
      compilerWasm: { url: 'compiler.wasm' },
      linkerWasm: { url: 'linker.wasm' },
      sysroot: { url: 'sysroot.tar' },
      compilerResources: {
        'llvm.core.wasm': {
          url: 'llvm.core.wasm',
          integrity: 'sha256-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
          size: 456,
        },
      },
    },
  },
} satisfies BrowserRuntimeAssetManifests;

function testLegacyCompatibility(): void {
  const defaultAssets = resolveBrowserRuntimeAssets();
  assertCondition(defaultAssets.pythonWorker === '/workers/python-worker.js', 'Default asset paths must use canonical runtime names');
  assertCondition(
    defaultAssets.javaWorker === '/workers/java-runtime-worker.js',
    'Default Java assets must select the provider-neutral runtime worker required by prepared execution'
  );
  assertCondition(
    !defaultAssets.javaWorker.includes('tracejvm-java-worker.js'),
    'Default Java asset URLs must not expose the runtime engine implementation'
  );
  assertCondition(defaultAssets.cppCompilerWasm === '', 'Disabled direct compiler paths must remain disabled');
  assertCondition(defaultAssets.runtimeManifests === undefined, 'Legacy resolution must not synthesize version metadata');

  const legacyAssets = resolveBrowserRuntimeAssets({
    assetBaseUrl: '/consumer-assets',
    assets: {
      pythonWorker: 'python/worker.js',
      javaWorker: 'https://legacy.example/java-worker.js',
    },
  });
  assertCondition(
    legacyAssets.pythonWorker === '/consumer-assets/python/worker.js',
    'Relative legacy overrides must still use assetBaseUrl'
  );
  assertCondition(
    legacyAssets.javaWorker === 'https://legacy.example/java-worker.js',
    'Explicit classic Java worker overrides must remain available to legacy Project consumers'
  );
}

function testConsumerCdnManifests(): void {
  const assetOptions = {
    assetBaseUrl: '/legacy-assets',
    assets: { runtimeManifests: consumerManifests },
  };
  const assets = resolveBrowserRuntimeAssets(assetOptions);

  const expected = {
    pythonWorker: 'https://assets.consumer.example/python/314.0.2/worker.js',
    pythonRuntime: 'https://assets.consumer.example/python/314.0.2/python-runtime.mjs',
    pythonSnippets: 'https://assets.consumer.example/python/314.0.2/harness-snippets.mjs',
    javascriptWorker: 'https://assets.consumer.example/javascript/es2022/classic-worker.js',
    javascriptAlgorithmWorker: 'https://assets.consumer.example/javascript/es2022/ses-algorithm-worker.js',
    javascriptProjectWorker: 'https://assets.consumer.example/javascript/es2022/project-worker.js',
    typescriptCompiler: 'https://assets.consumer.example/typescript/5.9.3/typescript.js',
    javaWorker: 'https://assets.consumer.example/java/17-browser-1/java-worker.js',
    csharpWorker: 'https://assets.consumer.example/csharp/csharp-browser-1/csharp-worker.js',
    csharpAssetBaseUrl: 'https://assets.consumer.example/csharp/csharp-browser-1/runtime',
    cppWorker: 'https://assets.consumer.example/cpp/cpp23-browser-1/cpp-worker.js',
    cppRuntimeHeader: 'https://assets.consumer.example/cpp/cpp23-browser-1/tracecode_runtime.hpp',
    cppCompilerWasm: 'https://assets.consumer.example/cpp/cpp23-browser-1/compiler.wasm',
    cppLinkerWasm: 'https://assets.consumer.example/cpp/cpp23-browser-1/linker.wasm',
    cppSysroot: 'https://assets.consumer.example/cpp/cpp23-browser-1/sysroot.tar',
  } as const;
  for (const [key, value] of Object.entries(expected)) {
    assertCondition(
      assets[key as keyof typeof expected] === value,
      `${key} must resolve from its consumer-owned runtime manifest`
    );
  }

  const pythonWorker = assets.runtimeManifests?.python?.assets.worker;
  assertCondition(pythonWorker?.integrity === 'sha384-python-worker', 'Integrity metadata must survive flattening');
  assertCondition(pythonWorker?.mediaType === 'text/javascript', 'Media-type metadata must survive flattening');
  assertCondition(pythonWorker?.size === 1024, 'Size metadata must survive flattening');
  assertCondition(
    assets.runtimeManifests?.python?.runtimeVersion === '314.0.2',
    'Runtime versions must survive flattening'
  );
  assertCondition(
    assets.runtimeManifests?.python?.assets.runtimeLoader?.url ===
      'https://assets.consumer.example/python/314.0.2/pyodide.mjs',
    'Python loader assets must remain available to worker initialization'
  );
  assertCondition(
    assets.runtimeManifests?.python?.assets.distribution?.['pyodide-lock.json']?.url ===
      'https://assets.consumer.example/python/314.0.2/pyodide-lock.json',
    'Python self-hosted distribution inventory paths must resolve beneath runtimeIndex'
  );
  assertCondition(
    assets.runtimeManifests?.csharp?.assets.dependencies?.['_framework/dotnet.js']?.url ===
      'https://assets.consumer.example/csharp/csharp-browser-1/runtime/_framework/dotnet.js',
    'C# runtime dependency declarations must survive normalization'
  );
  assertCondition(
    JSON.stringify(assets.cppCompilerIntegrity?.assets) === JSON.stringify([
      {
        url: 'https://assets.consumer.example/cpp/cpp23-browser-1/llvm.core.wasm',
        sha256: '01'.repeat(32),
        size: 456,
      },
    ]),
    `C++ SHA-256 SRI metadata must derive the exact internal compiler pins: ${JSON.stringify(assets.cppCompilerIntegrity)}`
  );
}

function testProviderResolution(): void {
  const provider = (runtime: string): AnyBrowserRuntimeAssetManifest | undefined =>
    runtime === 'java' ? consumerManifests.java : undefined;
  const resolved = resolveBrowserRuntimeAssetManifests({ provider });
  assertCondition(
    resolved.java?.assets.worker.url === 'https://assets.consumer.example/java/17-browser-1/java-worker.js',
    'Runtime providers must resolve consumer manifests'
  );
  assertCondition(Object.keys(resolved).length === 1, 'Providers must not synthesize manifests for omitted runtimes');
}

function testPythonRuntimeImageManifest(): void {
  const immutable = {
    mutability: 'immutable',
    address: 'content',
  } as const;
  const runtimeImage = {
    protocolVersion: 'tracecode-python-runtime-image-v1',
    engine: 'chromium',
    pythonHashSeed: '0',
    wasm: {
      url: 'runtime-image/pyodide.asm.wasm',
      integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      mediaType: 'application/wasm',
      size: 8_647_684,
      delivery: immutable,
    },
    snapshot: {
      url: 'runtime-image/clean.bin',
      integrity: 'sha256-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
      mediaType: 'application/octet-stream',
      size: 20_971_936,
      delivery: immutable,
    },
  } as const;
  const resolved = resolveBrowserRuntimeAssetManifests({
    manifests: {
      python: {
        ...consumerManifests.python,
        assets: {
          ...consumerManifests.python.assets,
          runtimeImage,
        },
      },
    },
  });
  assertCondition(
    resolved.python?.assets.runtimeImage?.wasm.url ===
      'https://assets.consumer.example/python/314.0.2/runtime-image/pyodide.asm.wasm',
    'Python runtime-image Wasm must resolve through the manifest asset base'
  );
  assertCondition(
    resolved.python?.assets.runtimeImage?.snapshot.size === 20_971_936 &&
      resolved.python.assets.runtimeImage.engine === 'chromium' &&
      resolved.python.assets.runtimeImage.pythonHashSeed === '0',
    'Python runtime-image snapshot metadata must survive normalization'
  );

  assertThrowsMessage(
    () =>
      resolveBrowserRuntimeAssetManifests({
        manifests: {
          python: {
            ...consumerManifests.python,
            assets: {
              ...consumerManifests.python.assets,
              runtimeImage: {
                ...runtimeImage,
                snapshot: {
                  ...runtimeImage.snapshot,
                  delivery: undefined,
                },
              },
            },
          } as unknown as BrowserRuntimeAssetManifests['python'],
        },
      }),
    'must declare immutable delivery, integrity, and size'
  );
}

function testManifestAlternativesAndRelativeBases(): void {
  const assets = resolveBrowserRuntimeAssets({
    assetBaseUrl: '/consumer-assets',
    assets: {
      runtimeManifests: {
        java: {
          runtime: 'java',
          runtimeVersion: 'relative-build',
          protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
          assetBaseUrl: 'java/relative-build',
          originPolicy: { mode: 'same-origin' },
          assets: { worker: { url: './worker.js' } },
        },
        cpp: {
          runtime: 'cpp',
          runtimeVersion: 'direct-compiler',
          protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
          assetBaseUrl: '/raw-cpp',
          originPolicy: { mode: 'same-origin' },
          assets: {
            worker: { url: 'worker.js' },
            runtimeHeader: { url: 'runtime.hpp' },
            compilerWasm: { url: 'compiler.wasm' },
            linkerWasm: { url: 'linker.wasm' },
            sysroot: { url: 'sysroot.tar' },
          },
        },
      },
    },
  });
  assertCondition(
    assets.javaWorker === '/consumer-assets/java/relative-build/worker.js',
    'Relative manifest bases must resolve against the consumer assetBaseUrl'
  );
  assertCondition(assets.cppCompilerWasm === '/raw-cpp/compiler.wasm', 'Direct C++ compiler assets must flatten normally');
}

function testInvalidManifestsFailClearly(): void {
  assertThrowsMessage(
    () =>
      resolveBrowserRuntimeAssetManifests({
        manifests: {
          python: {
            ...consumerManifests.python,
            assets: {
              worker: { url: 'worker.mjs' },
              runtime: { url: 'python-runtime.mjs' },
            },
          } as unknown as BrowserRuntimeAssetManifests['python'],
        },
      }),
    'missing required asset "snippets"'
  );

  assertThrowsMessage(
    () =>
      resolveBrowserRuntimeAssetManifests({
        manifests: {
          java: {
            ...consumerManifests.java,
            runtime: 'python',
          } as unknown as BrowserRuntimeAssetManifests['java'],
        },
      }),
    'runtime must be "java"'
  );

  assertThrowsMessage(
    () =>
      resolveBrowserRuntimeAssetManifests({
        manifests: {
          java: {
            ...consumerManifests.java,
            assets: {
              worker: { url: 'java-worker.js' },
              loader: { url: 'retired-loader.js' },
            },
          } as unknown as BrowserRuntimeAssetManifests['java'],
        },
      }),
    'unknown asset "loader"'
  );

  assertThrowsMessage(
    () =>
      resolveBrowserRuntimeAssetManifests({
        manifests: {
          typescript: {
            ...consumerManifests.typescript,
            protocolVersion: 'browser-runtime-assets-v2',
          } as unknown as BrowserRuntimeAssetManifests['typescript'],
        },
      }),
    'unsupported protocolVersion'
  );

  assertThrowsMessage(
    () =>
      resolveBrowserRuntimeAssetManifests({
        manifests: {
          javascript: {
            ...consumerManifests.javascript,
            assets: {
              ...consumerManifests.javascript.assets,
              worker: { url: 'https://other.example/worker.js' },
            },
          },
        },
      }),
    'which is not in its origin allow-list'
  );

  assertThrowsMessage(
    () =>
      resolveBrowserRuntimeAssetManifests({
        manifests: {
          csharp: {
            ...consumerManifests.csharp,
            assets: {
              ...consumerManifests.csharp.assets,
              worker: { url: 'worker.js', size: -1 },
            },
          },
        },
      }),
    'size must be a non-negative safe integer'
  );

  assertThrowsMessage(
    () =>
      resolveBrowserRuntimeAssetManifests({
        manifests: {
          csharp: {
            ...consumerManifests.csharp,
            assets: {
              ...consumerManifests.csharp.assets,
              compilerAssetBaseUrl: { url: 'compiler' },
            },
          },
        },
      }),
    'compilerAssetBaseUrl and runnerAssetBaseUrl together'
  );

  assertThrowsMessage(
    () =>
      resolveBrowserRuntimeAssetManifests({
        manifests: {
          csharp: {
            ...consumerManifests.csharp,
            assets: {
              ...consumerManifests.csharp.assets,
              runnerDependencies: {
                '_framework/assemblies.pack-manifest.json': {
                  url: 'runner/_framework/assemblies.pack-manifest.json',
                },
              },
            },
          },
        },
      }),
    'runnerDependencies require the compiler/runner role pair'
  );

  assertThrowsMessage(
    () =>
      resolveBrowserRuntimeAssets({
        assets: {
          runtimeManifests: { python: consumerManifests.python },
          pythonWorker: '/ambiguous-worker.js',
        },
      }),
    'cannot combine its manifest with legacy asset override "pythonWorker"'
  );

  assertThrowsMessage(
    () =>
      resolveBrowserRuntimeAssetManifests({
        manifests: {
          cpp: {
            ...consumerManifests.cpp,
            originPolicy: {
              mode: 'allow-list',
              origins: ['https://assets.consumer.example', 'https://other.example'],
            },
            assets: {
              ...consumerManifests.cpp.assets,
              compilerWasm: { url: 'https://other.example/compiler.wasm' },
            },
          },
        },
      }),
    'must include an exact sha256 SRI token for compiler pinning'
  );

  assertThrowsMessage(
    () =>
      resolveBrowserRuntimeAssetManifests({
        manifests: {
          python: {
            ...consumerManifests.python,
            workerFormat: 'classic',
          },
        },
      }),
    'Python requires classic + classic-script or module + module'
  );

  assertThrowsMessage(
    () =>
      resolveBrowserRuntimeAssetManifests({
        manifests: {
          python: {
            ...consumerManifests.python,
            assets: {
              worker: { url: 'worker.mjs' },
              runtime: { url: 'python-runtime.mjs' },
              snippets: { url: 'snippets.mjs' },
            },
          } as unknown as BrowserRuntimeAssetManifests['python'],
        },
      }),
    'missing required asset "runtimeLoader"'
  );

  assertThrowsMessage(
    () =>
      resolveBrowserRuntimeAssetManifests({
        manifests: {
          python: {
            ...consumerManifests.python,
            workerFormat: undefined,
          } as unknown as BrowserRuntimeAssetManifests['python'],
        },
      }),
    'must explicitly declare workerFormat and loaderFormat'
  );

  assertThrowsMessage(
    () =>
      resolveBrowserRuntimeAssetManifests({
        manifests: {
          python: {
            ...consumerManifests.python,
            assets: {
              ...consumerManifests.python.assets,
              distribution: { '../escape.wasm': { url: '../escape.wasm' } },
            },
          },
        },
      }),
    'must be a normalized deployment-relative path beneath runtimeIndex'
  );
}

testLegacyCompatibility();
testConsumerCdnManifests();
testProviderResolution();
testPythonRuntimeImageManifest();
testManifestAlternativesAndRelativeBases();
testInvalidManifestsFailClearly();
console.log('PASS: browser runtime asset manifests');

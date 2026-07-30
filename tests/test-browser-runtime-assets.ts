import {
  BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
  resolveBrowserHarnessAssets,
  resolveBrowserRuntimeAssetManifests,
  type AnyBrowserRuntimeAssetManifest,
  type BrowserRuntimeAssetManifests,
  type CreateBrowserHarnessOptions,
} from '../src/browser';

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
      runtimeCore: { url: 'runtime-core.mjs' },
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
      loader: { url: 'cheerpj-loader.js' },
      helperJar: { url: 'java-browser-helper.jar', runtimePath: '/app/java/java-browser-helper.jar' },
      compilerJar: { url: 'jdk.compiler-17.jar' },
      rewriterJar: { url: 'java-rewriter.jar' },
      parserJar: { url: 'javaparser.jar' },
    },
  },
  csharp: {
    runtime: 'csharp',
    runtimeVersion: 'dotnet-10-browser-1',
    protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
    workerFormat: 'module',
    loaderFormat: 'module',
    assetBaseUrl: 'https://assets.consumer.example/csharp/dotnet-10-browser-1',
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
    runtimeVersion: 'clang-22-browser-1',
    protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
    workerFormat: 'module',
    assetBaseUrl: 'https://assets.consumer.example/cpp/clang-22-browser-1',
    originPolicy: consumerOriginPolicy,
    assets: {
      worker: { url: 'cpp-worker.js' },
      compilerFrame: { url: 'compiler-frame.html' },
      compilerWorker: { url: 'compiler-worker.js' },
      runtimeHeader: { url: 'tracecode_runtime.hpp' },
      compilerBundle: {
        url: 'compiler-bundle.js',
        integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        size: 123,
      },
      clangWasm: { url: 'clang.wasm' },
      lldWasm: { url: 'lld.wasm' },
      sysroot: { url: 'sysroot.tar' },
      toolchain: {
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
  const defaultAssets = resolveBrowserHarnessAssets();
  assertCondition(defaultAssets.pythonWorker === '/workers/python-worker.js', 'Default asset paths must use canonical runtime names');
  assertCondition(defaultAssets.cppClangWasm === '', 'Disabled legacy asset paths must remain disabled');
  assertCondition(defaultAssets.runtimeManifests === undefined, 'Legacy resolution must not synthesize version metadata');

  const legacyAssets = resolveBrowserHarnessAssets({
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
    'Absolute legacy overrides must still be preserved'
  );
}

function testConsumerCdnManifests(): void {
  const harnessOptions = {
    assetBaseUrl: '/legacy-assets',
    assets: { runtimeManifests: consumerManifests },
  } satisfies CreateBrowserHarnessOptions;
  const assets = resolveBrowserHarnessAssets(harnessOptions);

  const expected = {
    pythonWorker: 'https://assets.consumer.example/python/314.0.2/worker.js',
    pythonRuntimeCore: 'https://assets.consumer.example/python/314.0.2/runtime-core.mjs',
    pythonSnippets: 'https://assets.consumer.example/python/314.0.2/harness-snippets.mjs',
    javascriptWorker: 'https://assets.consumer.example/javascript/es2022/classic-worker.js',
    javascriptProjectWorker: 'https://assets.consumer.example/javascript/es2022/project-worker.js',
    typescriptCompiler: 'https://assets.consumer.example/typescript/5.9.3/typescript.js',
    javaWorker: 'https://assets.consumer.example/java/17-browser-1/java-worker.js',
    csharpWorker: 'https://assets.consumer.example/csharp/dotnet-10-browser-1/csharp-worker.js',
    csharpAssetBaseUrl: 'https://assets.consumer.example/csharp/dotnet-10-browser-1/runtime',
    cppWorker: 'https://assets.consumer.example/cpp/clang-22-browser-1/cpp-worker.js',
    cppCompilerFrame: 'https://assets.consumer.example/cpp/clang-22-browser-1/compiler-frame.html',
    cppCompilerWorker: 'https://assets.consumer.example/cpp/clang-22-browser-1/compiler-worker.js',
    cppRuntimeHeader: 'https://assets.consumer.example/cpp/clang-22-browser-1/tracecode_runtime.hpp',
    cppCompilerBundle: 'https://assets.consumer.example/cpp/clang-22-browser-1/compiler-bundle.js',
    cppClangWasm: 'https://assets.consumer.example/cpp/clang-22-browser-1/clang.wasm',
    cppLldWasm: 'https://assets.consumer.example/cpp/clang-22-browser-1/lld.wasm',
    cppSysroot: 'https://assets.consumer.example/cpp/clang-22-browser-1/sysroot.tar',
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
    assets.runtimeManifests?.java?.assets.helperJar?.url ===
      'https://assets.consumer.example/java/17-browser-1/java-browser-helper.jar',
    'Java runtime jars must remain available to worker initialization'
  );
  assertCondition(
    assets.runtimeManifests?.java?.assets.helperJar?.runtimePath === '/app/java/java-browser-helper.jar',
    'Runtime-native asset paths must survive manifest normalization without replacing delivery URLs'
  );
  assertCondition(
    assets.runtimeManifests?.csharp?.assets.dependencies?.['_framework/dotnet.js']?.url ===
      'https://assets.consumer.example/csharp/dotnet-10-browser-1/runtime/_framework/dotnet.js',
    'C# runtime dependency declarations must survive normalization'
  );
  assertCondition(
    JSON.stringify(assets.cppToolchainIntegrity?.assets) === JSON.stringify([
      {
        url: 'https://assets.consumer.example/cpp/clang-22-browser-1/compiler-bundle.js',
        sha256: '0'.repeat(64),
        size: 123,
      },
      {
        url: 'https://assets.consumer.example/cpp/clang-22-browser-1/llvm.core.wasm',
        sha256: '01'.repeat(32),
        size: 456,
      },
    ]),
    `C++ SHA-256 SRI metadata must derive the exact internal toolchain pins: ${JSON.stringify(assets.cppToolchainIntegrity)}`
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

function testManifestAlternativesAndRelativeBases(): void {
  const assets = resolveBrowserHarnessAssets({
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
          runtimeVersion: 'raw-toolchain',
          protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
          assetBaseUrl: '/raw-cpp',
          originPolicy: { mode: 'same-origin' },
          assets: {
            worker: { url: 'worker.js' },
            compilerFrame: { url: 'frame.html' },
            compilerWorker: { url: 'compiler-worker.js' },
            runtimeHeader: { url: 'runtime.hpp' },
            clangWasm: { url: 'clang.wasm' },
            lldWasm: { url: 'lld.wasm' },
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
  assertCondition(assets.cppCompilerBundle === '', 'A raw C++ toolchain manifest must not re-enable the default bundle');
  assertCondition(assets.cppClangWasm === '/raw-cpp/clang.wasm', 'Raw C++ toolchain assets must flatten normally');
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
              runtimeCore: { url: 'runtime-core.mjs' },
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
      resolveBrowserHarnessAssets({
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
              compilerBundle: { url: 'https://other.example/compiler-bundle.js' },
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
          cpp: {
            ...consumerManifests.cpp,
            originPolicy: {
              mode: 'allow-list',
              origins: ['https://assets.consumer.example', 'https://other.example'],
            },
            assets: {
              ...consumerManifests.cpp.assets,
              compilerFrame: { url: 'https://other.example/compiler-frame.html' },
            },
          },
        },
      }),
    'compilerFrame and assets.compilerWorker must share an origin'
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
              runtimeCore: { url: 'runtime-core.mjs' },
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
testManifestAlternativesAndRelativeBases();
testInvalidManifestsFailClearly();
console.log('PASS: browser runtime asset manifests');

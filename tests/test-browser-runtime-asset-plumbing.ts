import {
  BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
  createBrowserRuntimeAssetPreflight,
  createBrowserRuntimeHost,
  resolveBrowserRuntimeAssetManifests,
  type BrowserRuntimeAssetManifests,
} from '../src/browser';
import { createBrowserProjectWorkspace } from '../packages/runtime-browser/src/project';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface PostedMessage {
  id?: string;
  type: string;
  payload?: Record<string, unknown>;
  protocolToken?: string;
}

class CapturingWorker {
  static instances: CapturingWorker[] = [];
  static fetches: string[] = [];

  readonly messages: PostedMessage[] = [];
  readonly fetchesAtMessage = new Map<string, string[]>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor(readonly url: string | URL, readonly options?: WorkerOptions) {
    CapturingWorker.instances.push(this);
    queueMicrotask(() => this.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent));
  }

  postMessage(message: PostedMessage): void {
    this.messages.push(message);
    this.fetchesAtMessage.set(message.type, [...CapturingWorker.fetches]);
    const responseType = message.type === 'warmup' ? 'warmup-result' : `${message.type}-result`;
    const payload = message.type.startsWith('execute-project-')
      ? { stdout: '', stderr: '', exitCode: 0, files: [] }
      : { success: true, loadTimeMs: 0 };
    queueMicrotask(() => this.onmessage?.({
      data: {
        id: message.id,
        protocolToken: message.protocolToken,
        type: responseType,
        payload,
      },
    } as MessageEvent));
  }

  terminate(): void {}
}

const originPolicy = {
  mode: 'allow-list',
  origins: ['https://cdn.consumer.example'],
} as const;

function descriptor(url: string) {
  return { url };
}

function consumerManifests(): BrowserRuntimeAssetManifests {
  const protocolVersion = BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION;
  return {
    python: {
      runtime: 'python',
      runtimeVersion: '0.29.4',
      protocolVersion,
      workerFormat: 'classic',
      loaderFormat: 'classic-script',
      assetBaseUrl: 'https://cdn.consumer.example/python/',
      originPolicy,
      assets: {
        worker: descriptor('worker.js'),
        runtimeCore: descriptor('runtime-core.js'),
        snippets: descriptor('snippets.js'),
        runtimeLoader: descriptor('pyodide.js'),
        runtimeIndex: descriptor('./'),
        packages: { sortedcontainers: descriptor('sortedcontainers.whl') },
      },
    },
    javascript: {
      runtime: 'javascript',
      runtimeVersion: 'es2022',
      protocolVersion,
      workerFormat: 'classic',
      assetBaseUrl: 'https://cdn.consumer.example/javascript/',
      originPolicy,
      assets: {
        worker: descriptor('worker.js'),
        projectWorker: descriptor('project-worker.js'),
        libraries: descriptor('javascript-libraries.js'),
      },
    },
    typescript: {
      runtime: 'typescript',
      runtimeVersion: '5.9.3',
      protocolVersion,
      loaderFormat: 'classic-script',
      assetBaseUrl: 'https://cdn.consumer.example/typescript/',
      originPolicy,
      assets: { compiler: descriptor('typescript.js') },
    },
    java: {
      runtime: 'java',
      runtimeVersion: '17-browser',
      protocolVersion,
      workerFormat: 'classic',
      loaderFormat: 'classic-script',
      assetBaseUrl: 'https://cdn.consumer.example/java/',
      originPolicy,
      assets: {
        worker: descriptor('worker.js'),
      },
    },
    csharp: {
      runtime: 'csharp',
      runtimeVersion: 'dotnet-browser',
      protocolVersion,
      workerFormat: 'module',
      loaderFormat: 'module',
      assetBaseUrl: 'https://cdn.consumer.example/csharp/',
      originPolicy,
      assets: {
        worker: descriptor('worker.js'),
        assetBaseUrl: descriptor('runtime'),
        dependencies: {
          '_framework/dotnet.js': descriptor('runtime/_framework/dotnet.js'),
          '_framework/dotnet.native.wasm': descriptor('runtime/_framework/dotnet.native.wasm'),
        },
      },
    },
  };
}

function findWorker(fragment: string): CapturingWorker {
  const worker = CapturingWorker.instances.find((entry) => String(entry.url).includes(fragment));
  assertCondition(worker, `Expected a worker URL containing ${JSON.stringify(fragment)}`);
  return worker;
}

function initMessage(worker: CapturingWorker): PostedMessage {
  const message = worker.messages.find((entry) => entry.type === 'init');
  assertCondition(message, `Expected ${String(worker.url)} to receive an init message`);
  return message;
}

function findInitializedWorker(fragment: string): CapturingWorker {
  const worker = CapturingWorker.instances.find(
    (entry) => String(entry.url).includes(fragment) && entry.messages.some((message) => message.type === 'init')
  );
  assertCondition(worker, `Expected an initialized worker URL containing ${JSON.stringify(fragment)}`);
  return worker;
}

async function testManifestAssetsReachWorkerInitialization(): Promise<void> {
  CapturingWorker.instances = [];
  const host = createBrowserRuntimeHost({
    assets: { runtimeManifests: consumerManifests() },
  });
  await host.warmLanguage('python');
  await host.warmLanguage('typescript');
  await host.warmLanguage('java');
  await host.warmLanguage('csharp');

  const pythonWorker = findWorker('/python/worker.js');
  assertCondition(
    String(pythonWorker.url).includes(
      'tracecodePythonSnippets=https%3A%2F%2Fcdn.consumer.example%2Fpython%2Fsnippets.js'
    ),
    'Configured Python snippets must be available during classic worker bootstrap'
  );
  const pythonPayload = initMessage(pythonWorker).payload;
  const pythonAssets = pythonPayload?.runtimeAssets as Record<string, unknown> | undefined;
  assertCondition(
    pythonAssets?.loaderUrl === 'https://cdn.consumer.example/python/pyodide.js',
    'Python runtime loader must reach the worker init payload'
  );
  assertCondition(
    (pythonAssets?.packageUrls as Record<string, string> | undefined)?.sortedcontainers ===
      'https://cdn.consumer.example/python/sortedcontainers.whl',
    'Python package artifacts must reach the worker init payload'
  );

  const javascriptPayload = initMessage(findInitializedWorker('/javascript/worker.js')).payload;
  assertCondition(
    javascriptPayload?.typescriptCompilerUrl === 'https://cdn.consumer.example/typescript/typescript.js',
    'The persistent JS/TS coordinator must receive the consumer compiler URL'
  );
  assertCondition(
    javascriptPayload?.javascriptLibrariesUrl ===
      'https://cdn.consumer.example/javascript/javascript-libraries.js',
    'The persistent JavaScript coordinator must receive consumer runtime libraries'
  );

  const javaPayload = initMessage(findWorker('/java/worker.js')).payload;
  assertCondition(
    javaPayload?.runtimeAssets === undefined,
    'The Java bridge worker must own its engine asset tree instead of receiving retired manifest roles'
  );

  const csharpWorker = findWorker('/csharp/worker.js');
  const csharpPayload = initMessage(csharpWorker).payload;
  assertCondition(csharpWorker.options?.type === 'module', 'C# manifest must retain the module-worker boundary');
  assertCondition(
    (csharpPayload?.runtimeDependencies as Record<string, string> | undefined)?.['_framework/dotnet.js'] ===
      'https://cdn.consumer.example/csharp/runtime/_framework/dotnet.js',
    'C# runtime dependencies must reach the worker init payload'
  );
  host.dispose();

  CapturingWorker.instances = [];
  const runtimeAssetHost = createBrowserRuntimeHost({
    assetBaseUrl: '/direct-java-loader',
    assets: { javaWorker: 'java-worker.js' },
    providers: ['java'],
    java: {
      runtimeAssetBaseUrl:
        'https://runtime.example/java engine/?release=17&channel=stable#wasm',
    },
  });
  await runtimeAssetHost.warmLanguage('java');
  const runtimeAssetWorker = findWorker('/direct-java-loader/java-worker.js');
  assertCondition(
    String(runtimeAssetWorker.url).includes(
      'tracejvmBaseUrl=https%3A%2F%2Fruntime.example%2Fjava%20engine%2F%3Frelease%3D17%26channel%3Dstable%23wasm'
    ),
    `Java runtimeAssetBaseUrl must be URL-encoded onto the bridge worker URL: ${String(runtimeAssetWorker.url)}`
  );
  runtimeAssetHost.dispose();
}

async function testMetadataMismatchStopsBeforeWorkerConstruction(): Promise<void> {
  CapturingWorker.instances = [];
  const manifests = consumerManifests();
  manifests.typescript = {
    ...manifests.typescript!,
    assets: {
      compiler: {
        url: 'typescript.js',
        mediaType: 'text/javascript',
        size: 4,
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('bad', {
    status: 200,
    headers: { 'content-type': 'text/javascript; charset=utf-8' },
  });
  try {
    const host = createBrowserRuntimeHost({
      assets: { runtimeManifests: manifests },
    });
    let message = '';
    try {
      await host.warmLanguage('typescript');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertCondition(message.includes('decoded size 3 did not match declared size 4'), 'Size mismatch must be reported');
    assertCondition(CapturingWorker.instances.length === 0, 'Metadata mismatch must fail before worker construction');
    host.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function sha256Integrity(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return `sha256-${btoa(binary)}`;
}

async function testIntegrityAndMediaTypeVerification(): Promise<void> {
  const body = 'compiler';
  const manifests = consumerManifests();
  manifests.typescript = {
    ...manifests.typescript!,
    assets: {
      compiler: {
        url: 'typescript.js',
        integrity: await sha256Integrity(body),
        mediaType: 'text/javascript',
        size: new TextEncoder().encode(body).byteLength,
      },
    },
  };
  const resolved = resolveBrowserRuntimeAssetManifests({ manifests });
  const verifier = createBrowserRuntimeAssetPreflight(resolved, {
    fetch: async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    }),
  });
  await verifier.preflight('typescript', ['compiler']);

  const invalidManifests = consumerManifests();
  invalidManifests.typescript = {
    ...invalidManifests.typescript!,
    assets: {
      compiler: {
        url: 'typescript.js',
        integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        mediaType: 'application/javascript',
        size: new TextEncoder().encode(body).byteLength,
      },
    },
  };
  const invalidVerifier = createBrowserRuntimeAssetPreflight(
    resolveBrowserRuntimeAssetManifests({ manifests: invalidManifests }),
    {
      fetch: async () => new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/javascript' },
      }),
    }
  );
  let message = '';
  try {
    await invalidVerifier.preflight('typescript', ['compiler']);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertCondition(message.includes('did not match the declared integrity'), 'Integrity mismatch must be enforced');
}

async function testPreflightRetriesFailuresAndSharesConcurrentWork(): Promise<void> {
  const manifests = consumerManifests();
  manifests.typescript = {
    ...manifests.typescript!,
    assets: {
      compiler: {
        url: 'typescript.js',
        size: 8,
        delivery: { mutability: 'immutable', address: 'versioned' },
      },
    },
  };
  let fetchCount = 0;
  let releaseFetch: (() => void) | undefined;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const verifier = createBrowserRuntimeAssetPreflight(resolveBrowserRuntimeAssetManifests({ manifests }), {
    fetch: async () => {
      fetchCount += 1;
      if (fetchCount === 1) throw new Error('temporary-cdn-failure');
      await fetchGate;
      return new Response('compiler', { status: 200 });
    },
  });

  let firstFailure = '';
  try {
    await verifier.preflight('typescript', ['compiler']);
  } catch (error) {
    firstFailure = error instanceof Error ? error.message : String(error);
  }
  assertCondition(firstFailure.includes('temporary-cdn-failure'), 'The initial transient preflight failure must surface');

  const retryA = verifier.preflight('typescript', ['compiler']);
  const retryB = verifier.preflight('typescript', ['compiler']);
  await Promise.resolve();
  assertCondition(fetchCount === 2, `Concurrent retries must share one fetch, observed ${fetchCount}`);
  releaseFetch?.();
  await Promise.all([retryA, retryB]);
  await verifier.preflight('typescript', ['compiler']);
  assertCondition(fetchCount === 2, 'A successful immutable-asset preflight should remain cached');

  const mutableManifests = consumerManifests();
  mutableManifests.typescript = {
    ...mutableManifests.typescript!,
    assets: { compiler: { url: 'typescript.js', size: 8 } },
  };
  let mutableFetchCount = 0;
  const mutableVerifier = createBrowserRuntimeAssetPreflight(
    resolveBrowserRuntimeAssetManifests({ manifests: mutableManifests }),
    {
      fetch: async () => {
        mutableFetchCount += 1;
        return new Response('compiler', { status: 200 });
      },
    }
  );
  await mutableVerifier.preflight('typescript', ['compiler']);
  await mutableVerifier.preflight('typescript', ['compiler']);
  assertCondition(mutableFetchCount === 2, 'Mutable/unattested assets must be reverified on later preflights');
}

async function testProjectManifestAssetBinding(): Promise<void> {
  const manifests = consumerManifests();
  for (const [options, expected] of [
    [
      {
        providers: ['javascript'],
        assets: { runtimeManifests: { javascript: manifests.javascript } },
        nodeProject: { workerUrl: 'https://unverified.example/project-worker.js' },
      },
      'cannot override nodeProject.workerUrl while its runtime manifest is active',
    ],
    [
      {
        providers: ['javascript', 'typescript'],
        assets: { runtimeManifests: { typescript: manifests.typescript } },
        typescriptProject: { compilerUrl: 'https://unverified.example/typescript.js' },
      },
      'cannot override typescriptProject.compilerUrl while its runtime manifest is active',
    ],
  ] as const) {
    let message = '';
    try {
      await createBrowserProjectWorkspace(options);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertCondition(
      message.includes(expected),
      `Project execution URL must stay bound to its verified manifest descriptor: ${JSON.stringify(message)}`
    );
  }

  const legacy = await createBrowserProjectWorkspace({
    providers: ['javascript', 'typescript'],
    nodeProject: { workerUrl: 'https://legacy.example/project-worker.js' },
    typescriptProject: { compilerUrl: 'https://legacy.example/typescript.js' },
  });
  legacy.dispose();
}

async function testProjectManifestAssetsArePreflightedAndForwarded(): Promise<void> {
  CapturingWorker.instances = [];
  CapturingWorker.fetches = [];
  const manifests = consumerManifests();
  const sized = (url: string) => ({ url, size: 5 });
  manifests.javascript = {
    ...manifests.javascript!,
    assets: {
      ...manifests.javascript!.assets,
      projectWorker: sized('project-worker.js'),
    },
  };
  manifests.typescript = {
    ...manifests.typescript!,
    assets: { compiler: sized('typescript.js') },
  };
  manifests.csharp = {
    ...manifests.csharp!,
    assets: {
      worker: sized('worker.js'),
      assetBaseUrl: sized('runtime'),
      dependencies: {
        '_framework/dotnet.js': sized('runtime/_framework/dotnet.js'),
        '_framework/dotnet.native.wasm': sized('runtime/_framework/dotnet.native.wasm'),
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    CapturingWorker.fetches.push(url);
    return new Response('asset', { status: 200 });
  };
  const workspace = await createBrowserProjectWorkspace({
    providers: ['javascript', 'typescript', 'csharp'],
    assets: { runtimeManifests: manifests },
    files: [
      { path: 'index.js', contents: 'console.log("project-js");\n' },
      { path: 'main.ts', contents: 'const value: number = 1;\n' },
      { path: 'Program.cs', contents: 'Console.WriteLine("project-csharp");\n' },
      {
        path: 'Project.csproj',
        contents: '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>\n',
      },
    ],
  });
  try {
    assertCondition((await workspace.runCommand('node index.js')).exitCode === 0, 'Project JavaScript should run');
    assertCondition((await workspace.runCommand('tsc --noEmit main.ts')).exitCode === 0, 'Project TypeScript should compile');
    assertCondition((await workspace.runCommand('dotnet build Project.csproj')).exitCode === 0, 'Project C# should build');

    const javascriptWorker = findWorker('/javascript/project-worker.js');
    const csharpWorker = findWorker('/csharp/worker.js');
    const requiredBeforeExecution = {
      javascript: ['https://cdn.consumer.example/javascript/project-worker.js'],
      csharp: [
        'https://cdn.consumer.example/csharp/worker.js',
        'https://cdn.consumer.example/csharp/runtime',
        'https://cdn.consumer.example/csharp/runtime/_framework/dotnet.js',
        'https://cdn.consumer.example/csharp/runtime/_framework/dotnet.native.wasm',
      ],
    } as const;
    for (const url of requiredBeforeExecution.javascript) {
      assertCondition(
        javascriptWorker.fetchesAtMessage.get('execute-project-javascript')?.includes(url),
        `JavaScript project worker must be verified before execution: ${url}; ` +
          `observed ${JSON.stringify(javascriptWorker.fetchesAtMessage.get('execute-project-javascript'))}`
      );
    }
    for (const url of requiredBeforeExecution.csharp) {
      assertCondition(
        csharpWorker.fetchesAtMessage.get('execute-project-csharp')?.includes(url),
        `C# project assets must be verified before execution: ${url}`
      );
    }
    assertCondition(
      CapturingWorker.fetches.includes('https://cdn.consumer.example/typescript/typescript.js'),
      'TypeScript compiler must be verified before its lazy project load'
    );

    const csharpDependencies = initMessage(csharpWorker).payload?.runtimeDependencies as
      | Record<string, string>
      | undefined;
    assertCondition(
      csharpDependencies?.['_framework/dotnet.js'] ===
        'https://cdn.consumer.example/csharp/runtime/_framework/dotnet.js',
      'C# project worker init must receive manifest dependency URLs'
    );
  } finally {
    workspace.dispose();
    globalThis.fetch = originalFetch;
  }
}

const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: CapturingWorker });
try {
  await testManifestAssetsReachWorkerInitialization();
  await testMetadataMismatchStopsBeforeWorkerConstruction();
  await testIntegrityAndMediaTypeVerification();
  await testPreflightRetriesFailuresAndSharesConcurrentWork();
  await testProjectManifestAssetBinding();
  await testProjectManifestAssetsArePreflightedAndForwarded();
  console.log('PASS: browser runtime asset manifest plumbing and preflight');
} finally {
  if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
  else Reflect.deleteProperty(globalThis, 'Worker');
}

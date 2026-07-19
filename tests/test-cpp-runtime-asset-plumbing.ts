#!/usr/bin/env npx tsx

import {
  BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
  createBrowserHarness,
  resolveBrowserHarnessAssets,
  type BrowserRuntimeAssetDescriptor,
  type BrowserRuntimeAssetManifests,
} from '../packages/harness-browser/src';
import { CppWorkerClient } from '../packages/harness-browser/src/cpp-worker-client';
import { createBrowserProjectWorkspace } from '../packages/harness-browser/src/project';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: Record<string, unknown>;
  protocolToken?: string;
}

class AssetWorker {
  static instances: AssetWorker[] = [];
  static fetches: string[] = [];

  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  readonly messages: WorkerMessage[] = [];
  fetchesAtProjectExecution: string[] = [];

  constructor(readonly url: string | URL, readonly options?: WorkerOptions) {
    AssetWorker.instances.push(this);
    queueMicrotask(() => this.onmessage?.({ data: { type: 'worker-ready' } } as unknown as MessageEvent<WorkerMessage>));
  }

  postMessage(message: WorkerMessage): void {
    if (this.terminated) return;
    this.messages.push(message);
    if (message.type === 'execute-project-cpp') {
      this.fetchesAtProjectExecution = [...AssetWorker.fetches];
    }
    const payload = message.type === 'init'
      ? { success: true, loadTimeMs: 0 }
      : message.type === 'warmup'
        ? { success: true, loadTimeMs: 0 }
        : message.type === 'execute-project-cpp'
          ? { stdout: '', stderr: '', exitCode: 0, files: [] }
          : { success: true, output: 3, consoleOutput: [] };
    queueMicrotask(() => this.onmessage?.({
      data: {
        id: message.id,
        type: message.type,
        protocolToken: message.protocolToken,
        payload,
      },
    } as unknown as MessageEvent<WorkerMessage>));
  }

  terminate(): void {
    this.terminated = true;
  }
}

async function sri(body: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return `sha256-${btoa(binary)}`;
}

async function descriptor(url: string, body: string): Promise<BrowserRuntimeAssetDescriptor> {
  return {
    url,
    integrity: await sri(body),
    size: new TextEncoder().encode(body).byteLength,
  };
}

async function cppManifest(): Promise<{
  manifests: BrowserRuntimeAssetManifests;
  bodies: Map<string, string>;
}> {
  const bodies = new Map<string, string>([
    ['/cpp/cpp-worker.js', 'execution-worker'],
    ['/cpp/compiler-frame.html', 'compiler-frame'],
    ['/cpp/compiler-worker.js', 'compiler-worker'],
    ['/cpp/tracecode_runtime.hpp', 'runtime-header'],
    ['/cpp/compiler-bundle.js', 'compiler-bundle'],
    ['/cpp/llvm.core.wasm', 'llvm-core'],
    ['/cpp/llvm-resources.tar', 'llvm-resources'],
  ]);
  const asset = (url: string) => descriptor(url, bodies.get(url) ?? '');
  return {
    bodies,
    manifests: {
      cpp: {
        runtime: 'cpp',
        runtimeVersion: 'clang-22-consumer-build',
        protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
        workerFormat: 'module',
        assetBaseUrl: '/cpp/',
        originPolicy: { mode: 'same-origin' },
        assets: {
          worker: await asset('/cpp/cpp-worker.js'),
          compilerFrame: await asset('/cpp/compiler-frame.html'),
          compilerWorker: await asset('/cpp/compiler-worker.js'),
          runtimeHeader: await asset('/cpp/tracecode_runtime.hpp'),
          compilerBundle: await asset('/cpp/compiler-bundle.js'),
          toolchain: {
            'llvm.core.wasm': await asset('/cpp/llvm.core.wasm'),
            'llvm-resources.tar': await asset('/cpp/llvm-resources.tar'),
          },
        },
      },
    },
  };
}

async function testCppClientPreflightsLazily(): Promise<void> {
  const calls: string[] = [];
  const client = new CppWorkerClient({
    workerUrl: '/cpp/cpp-worker.js',
    compilerFrameUrl: '/cpp/compiler-frame.html',
    compilerWorkerUrl: '/cpp/compiler-worker.js',
    runtimeHeaderUrl: '/cpp/tracecode_runtime.hpp',
    compilerBundleUrl: '/cpp/compiler-bundle.js',
    clangWasmUrl: '',
    lldWasmUrl: '',
    sysrootUrl: '',
    assetPreflight: async () => { calls.push('worker'); },
    runtimeAssetPreflight: async () => { calls.push('toolchain'); },
  });
  try {
    await client.init();
    assertCondition(
      calls.join(',') === 'worker',
      `init should verify only the execution worker: ${JSON.stringify(calls)}`
    );
    await client.executeProjectCpp({
      code: '',
      source: 'run',
      scriptPath: './program.wasm',
      args: [],
      cwd: '/workspace',
      env: {},
      project: { files: [{ path: 'program.wasm', contents: '', encoding: 'base64' }] },
    });
    assertCondition(
      !calls.includes('toolchain'),
      `running an existing project artifact should not fetch the compiler toolchain: ${JSON.stringify(calls)}`
    );
    await client.executeProjectCpp({
      code: '',
      source: 'compile',
      scriptPath: 'clang++',
      args: ['main.cpp', '-o', 'program.wasm'],
      cwd: '/workspace',
      env: {},
      project: { files: [{ path: 'main.cpp', contents: 'int main() { return 0; }\n' }] },
    });
    assertCondition(
      calls.filter((call) => call === 'toolchain').length === 1,
      `project compilation should verify compiler assets exactly once: ${JSON.stringify(calls)}`
    );
  } finally {
    client.terminate();
  }
}

async function testClassicAndProjectManifestPlumbing(): Promise<void> {
  const { manifests, bodies } = await cppManifest();
  const originalFetch = globalThis.fetch;
  AssetWorker.instances = [];
  AssetWorker.fetches = [];
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    AssetWorker.fetches.push(url);
    const body = bodies.get(url);
    return body === undefined
      ? new Response('missing', { status: 404 })
      : new Response(body, { status: 200 });
  };
  try {
    const resolvedAssets = resolveBrowserHarnessAssets({ assets: { runtimeManifests: manifests } });
    assertCondition(
      resolvedAssets.cppToolchainIntegrity?.assets.length === 4,
      `C++ manifest should derive four exact pins before client construction: ${JSON.stringify(resolvedAssets.cppToolchainIntegrity)}`
    );
    const harness = createBrowserHarness({ assets: { runtimeManifests: manifests } });
    await harness.getClient('cpp').init();
    const classicWorker = AssetWorker.instances.find((worker) => String(worker.url) === '/cpp/cpp-worker.js');
    assertCondition(classicWorker, 'Classic C++ should construct the consumer manifest worker');
    const classicInit = classicWorker.messages.find((message) => message.type === 'init');
    const pins = (classicInit?.payload?.assets as { toolchainIntegrity?: { assets?: unknown[] } } | undefined)
      ?.toolchainIntegrity?.assets;
    assertCondition(
      Array.isArray(pins) && pins.length === 4,
      `Classic C++ init should receive derived exact toolchain pins: ${JSON.stringify(classicInit)}`
    );
    assertCondition(
      AssetWorker.fetches.length === 1 && AssetWorker.fetches[0] === '/cpp/cpp-worker.js',
      `Classic init should preflight only its execution worker: ${JSON.stringify(AssetWorker.fetches)}`
    );
    harness.dispose();

    AssetWorker.instances = [];
    AssetWorker.fetches = [];
    const workspace = await createBrowserProjectWorkspace({
      assets: { runtimeManifests: manifests },
      files: [{ path: 'main.cpp', contents: 'int main() { return 0; }\n' }],
    });
    try {
      const result = await workspace.runCommand('clang++ main.cpp -o program.wasm');
      assertCondition(result.exitCode === 0, `project C++ manifest compile should complete: ${JSON.stringify(result)}`);
      const projectWorker = AssetWorker.instances.find((worker) =>
        worker.messages.some((message) => message.type === 'execute-project-cpp')
      );
      assertCondition(projectWorker, 'Project C++ should construct a consumer-manifest worker');
      const requiredRuntimeAssets = [
        '/cpp/compiler-frame.html',
        '/cpp/compiler-worker.js',
        '/cpp/tracecode_runtime.hpp',
        '/cpp/compiler-bundle.js',
        '/cpp/llvm.core.wasm',
        '/cpp/llvm-resources.tar',
      ];
      assertCondition(
        requiredRuntimeAssets.every((url) => projectWorker.fetchesAtProjectExecution.includes(url)),
        `project compile must finish toolchain preflight before worker execution: ${JSON.stringify(projectWorker.fetchesAtProjectExecution)}`
      );
    } finally {
      workspace.dispose();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: AssetWorker });
Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: { href: 'https://app.example/', origin: 'https://app.example' },
});
try {
  await testCppClientPreflightsLazily();
  await testClassicAndProjectManifestPlumbing();
  console.log('PASS: C++ Classic/project runtime asset manifest plumbing');
} finally {
  if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
  else Reflect.deleteProperty(globalThis, 'Worker');
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  else Reflect.deleteProperty(globalThis, 'location');
}

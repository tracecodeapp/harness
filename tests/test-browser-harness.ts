#!/usr/bin/env npx tsx

import { test } from 'node:test';
import {
  BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
  createBrowserHarness,
  resolveBrowserHarnessAssets,
} from '../packages/harness-browser/src';
import { createBrowserProjectWorkspace } from '../packages/harness-browser/src/project';
import { CppWorkerClient } from '../packages/harness-browser/src/cpp-worker-client';
import { JavaWorkerClient } from '../packages/harness-browser/src/java-worker-client';
import { PythonWorkerClient } from '../packages/harness-browser/src/pyodide-worker-client';
import { createRuntimeCommandStdinPipeFromText } from '../packages/harness-core/src/runtime-project';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
  protocolToken?: string;
}

const JAVA_HTTP_SYNC_STATE_INDEX = 0;
const JAVA_HTTP_SYNC_LENGTH_INDEX = 1;
const JAVA_HTTP_SYNC_REQUEST = 1;
const JAVA_HTTP_SYNC_RESPONSE = 2;
const JAVA_HTTP_SYNC_CLOSED = 3;
const JAVA_HTTP_SYNC_HEADER_BYTES = 8;

function testBase64(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

function testJavaHttpResponseManifest(status: number, headers: Record<string, string>, body: string): string {
  const headerLines = Object.entries(headers).map(([name, value]) => `${testBase64(name)}\t${testBase64(value)}`);
  return ['OK', String(status), String(headerLines.length), ...headerLines, testBase64(body)].join('\n');
}

const workerInstances: MockWorker[] = [];
let heldPythonProjectStarted: (() => void) | undefined;
let releaseHeldPythonProject: (() => void) | undefined;
let holdPythonWarmupForUrlPrefix: string | undefined;
let javaHttpTimeoutServerStarted: (() => void) | undefined;
let javaHttpTimeoutRequestBuffer: SharedArrayBuffer | undefined;
let failedWarmupUrlPrefix: string | undefined;
let remainingFailedWarmups = 0;

class MockWorker {
  public onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public readonly url: string | URL;
  public terminated = false;
  public messages: WorkerMessage[] = [];

  constructor(url: string | URL) {
    this.url = url;
    workerInstances.push(this);
    queueMicrotask(() => {
      this.onmessage?.({ data: { type: 'worker-ready' } } as MessageEvent<WorkerMessage>);
    });
  }

  postMessage(message: WorkerMessage): void {
    this.messages.push(message);
    queueMicrotask(() => {
      const { id, type, payload, protocolToken } = message;
      if (type === 'init') {
        this.onmessage?.({
          data: {
            id,
            type: 'init',
            protocolToken,
            payload: { success: true, loadTimeMs: 1 },
          },
        } as MessageEvent<WorkerMessage>);
        return;
      }

      if (type === 'prewarm-executor') {
        this.onmessage?.({
          data: {
            id,
            type: 'prewarm-result',
            protocolToken,
            payload: { success: true },
          },
        } as MessageEvent<WorkerMessage>);
        return;
      }

      if (type === 'warmup') {
        if (
          failedWarmupUrlPrefix &&
          remainingFailedWarmups > 0 &&
          String(this.url).startsWith(failedWarmupUrlPrefix)
        ) {
          remainingFailedWarmups -= 1;
          this.onmessage?.({
            data: {
              id,
              type: 'error',
              protocolToken,
              payload: { error: 'synthetic prewarm failure' },
            },
          } as MessageEvent<WorkerMessage>);
          return;
        }
        if (
          holdPythonWarmupForUrlPrefix &&
          String(this.url).startsWith(holdPythonWarmupForUrlPrefix)
        ) {
          return;
        }
        this.onmessage?.({
          data: {
            id,
            type: 'warmup',
            protocolToken,
            payload: { success: true, loadTimeMs: 2 },
          },
        } as MessageEvent<WorkerMessage>);
        return;
      }

      if (type === 'execute-code') {
        this.onmessage?.({
          data: {
            id,
            type,
            payload: { success: false, error: 'spoofed missing protocol token' },
          },
        } as MessageEvent<WorkerMessage>);
        this.onmessage?.({
          data: {
            id,
            type,
            protocolToken,
            payload: { success: true, output: payload ?? null, consoleOutput: [] },
          },
        } as MessageEvent<WorkerMessage>);
        return;
      }

      if (type === 'execute-code-batch' || type === 'compile-run-batch') {
        const inputBatch = Array.isArray((payload as { inputBatch?: unknown[] } | undefined)?.inputBatch)
          ? (payload as { inputBatch: unknown[] }).inputBatch
          : [];
        this.onmessage?.({
          data: {
            id,
            type,
            protocolToken,
            payload: {
              success: true,
              results: inputBatch.map((inputs) => ({ success: true, output: inputs, consoleOutput: [] })),
              consoleOutput: [],
            },
          },
        } as MessageEvent<WorkerMessage>);
        return;
      }

      if (type.startsWith('execute-project-')) {
        if (type === 'execute-project-python' && (payload as { scriptPath?: string } | undefined)?.scriptPath === 'hold.py') {
          heldPythonProjectStarted?.();
          heldPythonProjectStarted = undefined;
          releaseHeldPythonProject = () => {
            this.onmessage?.({
              data: {
                id,
                type,
                protocolToken,
                payload: {
                  stdout: 'held-python-finished\n',
                  stderr: '',
                  exitCode: 0,
                },
              },
            } as MessageEvent<WorkerMessage>);
          };
          return;
        }
        const projectScriptPath = (payload as { scriptPath?: string } | undefined)?.scriptPath;
        const isSyncHttpClientScript =
          (type === 'execute-project-java' && projectScriptPath === 'HttpClient.java') ||
          (type === 'execute-project-cpp' && projectScriptPath === './http-client');
        if (isSyncHttpClientScript) {
          const buffer = new SharedArrayBuffer(4096);
          this.onmessage?.({
            data: {
                id,
                type: 'kernel-http-dispatch-sync',
                protocolToken,
                payload: {
                request: {
                  method: 'GET',
                  url: 'http://tracekernel.test/queue?limit=1',
                  path: '/queue?limit=1',
                  headers: { accept: 'text/plain' },
                },
                buffer,
              },
            },
          } as MessageEvent<WorkerMessage>);
          queueMicrotask(() => {
            const header = new Int32Array(buffer, 0, 2);
            const length = Atomics.load(header, 1);
            const manifest = new TextDecoder().decode(new Uint8Array(buffer, 8, length));
            this.onmessage?.({
              data: {
                id,
                type,
                protocolToken,
                payload: {
                  stdout: manifest,
                  stderr: '',
                  exitCode: 0,
                },
              },
            } as MessageEvent<WorkerMessage>);
          });
          return;
        }
        const isSyncHttpServerScript =
          (type === 'execute-project-java' && projectScriptPath === 'HttpServer.java') ||
          (type === 'execute-project-cpp' && projectScriptPath === './http-server');
        if (isSyncHttpServerScript) {
          const requestBuffer = new SharedArrayBuffer(4096);
          const controlBuffer = new SharedArrayBuffer(4096);
          const requestHeader = new Int32Array(requestBuffer, 0, 2);
          const requestBytes = new Uint8Array(requestBuffer, JAVA_HTTP_SYNC_HEADER_BYTES);
          const requestManifests: string[] = [];
          this.onmessage?.({
            data: {
                id,
                type: 'kernel-http-listen-sync',
                protocolToken,
                payload: {
                serverId: 'java-http-test',
                options: { host: '127.0.0.1', port: 3210 },
                requestBuffer,
                controlBuffer,
              },
            },
          } as MessageEvent<WorkerMessage>);
          const finish = () => {
            this.onmessage?.({
              data: {
                id,
                type: 'kernel-http-close',
                protocolToken,
                payload: {
                  type: 'kernel-http-close',
                  serverId: 'java-http-test',
                  requestBuffer,
                },
              },
            } as MessageEvent<WorkerMessage>);
            this.onmessage?.({
              data: {
                id,
                type,
                protocolToken,
                payload: {
                  stdout: `server-listened\n${requestManifests.join('\n---\n')}\n`,
                  stderr: '',
                  exitCode: 0,
                },
              },
            } as MessageEvent<WorkerMessage>);
          };
          const waitForState = (state: number) => new Promise<void>((resolve) => {
            const poll = () => {
              if (Atomics.load(requestHeader, JAVA_HTTP_SYNC_STATE_INDEX) === state) {
                resolve();
                return;
              }
              setTimeout(poll, 0);
            };
            poll();
          });
          const waitForStateChange = (state: number) => new Promise<void>((resolve) => {
            const poll = () => {
              if (Atomics.load(requestHeader, JAVA_HTTP_SYNC_STATE_INDEX) !== state) {
                resolve();
                return;
              }
              setTimeout(poll, 0);
            };
            poll();
          });
          const serveRequests = async () => {
            for (let requestIndex = 0; requestIndex < 2; requestIndex += 1) {
              await waitForState(JAVA_HTTP_SYNC_REQUEST);
              const length = Atomics.load(requestHeader, JAVA_HTTP_SYNC_LENGTH_INDEX);
              const requestManifest = new TextDecoder().decode(requestBytes.subarray(0, length));
              requestManifests.push(requestManifest);
              const responseBody = requestManifests.length === 1 ? 'server-body' : 'queued-body';
              const response = new TextEncoder().encode(testJavaHttpResponseManifest(208, { 'content-type': 'text/plain', 'x-java-server': 'ok' }, responseBody));
              requestBytes.set(response);
              Atomics.store(requestHeader, JAVA_HTTP_SYNC_LENGTH_INDEX, response.byteLength);
              Atomics.store(requestHeader, JAVA_HTTP_SYNC_STATE_INDEX, JAVA_HTTP_SYNC_RESPONSE);
              Atomics.notify(requestHeader, JAVA_HTTP_SYNC_STATE_INDEX);
              await waitForStateChange(JAVA_HTTP_SYNC_RESPONSE);
            }
            finish();
          };
          void serveRequests();
          return;
        }
        const isSyncHttpServerTimeoutScript =
          (type === 'execute-project-java' && projectScriptPath === 'HttpServerTimeout.java') ||
          (type === 'execute-project-cpp' && projectScriptPath === './http-server-timeout');
        if (isSyncHttpServerTimeoutScript) {
          const requestBuffer = new SharedArrayBuffer(4096);
          const controlBuffer = new SharedArrayBuffer(4096);
          javaHttpTimeoutRequestBuffer = requestBuffer;
          this.onmessage?.({
            data: {
              id,
              type: 'kernel-http-listen-sync',
              protocolToken,
              payload: {
                serverId: 'java-http-timeout-test',
                options: { host: '127.0.0.1', port: 3211 },
                requestBuffer,
                controlBuffer,
              },
            },
          } as MessageEvent<WorkerMessage>);
          javaHttpTimeoutServerStarted?.();
          javaHttpTimeoutServerStarted = undefined;
          return;
        }
        this.onmessage?.({
          data: {
            id,
            type,
            protocolToken,
            payload: {
              stdout: `${type}:${(payload as { scriptPath?: string } | undefined)?.scriptPath ?? ''}\n`,
              stderr: '',
              exitCode: 0,
            },
          },
        } as MessageEvent<WorkerMessage>);
        return;
      }

      if (type === 'compile-run') {
        this.onmessage?.({
          data: {
            id,
            type,
            protocolToken,
            payload: { success: true, output: payload ?? null, consoleOutput: [] },
          },
        } as MessageEvent<WorkerMessage>);
        return;
      }

      if (type === 'execute-with-tracing') {
        this.onmessage?.({
          data: {
            id,
            type,
            protocolToken,
            payload: {
              success: true,
              output: null,
              events: [],
              sourceText: '',
              trace: {
                schemaVersion: 'runtime-trace-2026-04-28',
                language: 'cpp',
                runId: 'cpp:run',
                events: [],
                lineEventCount: 0,
                traceStepCount: 0,
              },
              consoleOutput: [],
              executionTimeMs: 1,
              lineEventCount: 0,
              traceStepCount: 0,
            },
          },
        } as MessageEvent<WorkerMessage>);
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

async function main(): Promise<void> {
  const originalWorker = globalThis.Worker;
  // @ts-expect-error test stub
  globalThis.Worker = MockWorker;

  try {
    const defaultAssets = resolveBrowserHarnessAssets();
    assertCondition(defaultAssets.pythonWorker === '/workers/pyodide-worker.js', 'Default python worker path should resolve');
    assertCondition(defaultAssets.javaWorker === '/workers/java-worker.js', 'Default java worker path should resolve');
    assertCondition(defaultAssets.csharpWorker === '/workers/csharp-worker.js', 'Default C# worker path should resolve');
    assertCondition(defaultAssets.csharpAssetBaseUrl === '/workers/vendor/csharp', 'Default C# asset base URL should resolve');
    assertCondition(defaultAssets.cppWorker === '/workers/cpp-worker.js', 'Default C++ worker path should resolve');
    assertCondition(
      defaultAssets.cppCompilerFrame === '/workers/cpp-compiler-frame.html',
      'Default C++ compiler frame path should resolve'
    );
    assertCondition(
      defaultAssets.cppCompilerWorker === '/workers/cpp-compiler-worker.js',
      'Default C++ compiler worker path should resolve'
    );
    assertCondition(defaultAssets.cppClangWasm === '', 'Default C++ raw clang path should be disabled');
    assertCondition(
      defaultAssets.cppCompilerBundle === '/workers/vendor/cpp/yowasp/bundle.js',
      'Default C++ compiler bundle path should resolve'
    );
    assertCondition(
      defaultAssets.typescriptCompiler === '/workers/vendor/typescript.js',
      'Default TypeScript compiler path should resolve'
    );
    assertCondition(
      defaultAssets.javascriptProjectWorker === '/workers/javascript-project-worker.js',
      'Default JavaScript project worker path should resolve'
    );

    const cppToolchainIntegrity = {
      assets: [
        {
          url: 'https://cdn.example.com/cpp/bundle.js',
          size: 1234,
          sha256: '0'.repeat(64),
        },
      ],
    };
    const customAssets = resolveBrowserHarnessAssets({
      assetBaseUrl: '/sdk-assets',
      assets: {
        javascriptWorker: 'workers/js-runtime.js',
        javascriptProjectWorker: 'workers/js-project-runtime.js',
        pythonWorker: 'https://cdn.example.com/python-worker.js',
        csharpAssetBaseUrl: 'runtimes/csharp',
        cppClangWasm: 'https://cdn.example.com/cpp/clang.wasm',
        cppCompilerFrame: 'workers/cpp-compiler-frame.html',
        cppCompilerWorker: 'workers/cpp-compiler-worker.js',
        cppCompilerBundle: 'https://cdn.example.com/cpp/bundle.js',
        cppToolchainIntegrity,
      },
    });
    assertCondition(customAssets.pythonWorker === 'https://cdn.example.com/python-worker.js', 'Explicit asset URLs should be preserved');
    assertCondition(customAssets.cppClangWasm === 'https://cdn.example.com/cpp/clang.wasm', 'Explicit C++ asset URLs should be preserved');
    assertCondition(customAssets.cppCompilerFrame === '/sdk-assets/workers/cpp-compiler-frame.html', 'Relative custom C++ compiler frame should join assetBaseUrl');
    assertCondition(customAssets.cppCompilerWorker === '/sdk-assets/workers/cpp-compiler-worker.js', 'Relative custom C++ compiler worker should join assetBaseUrl');
    assertCondition(customAssets.cppCompilerBundle === 'https://cdn.example.com/cpp/bundle.js', 'Explicit C++ compiler bundle URLs should be preserved');
    assertCondition(customAssets.cppToolchainIntegrity === cppToolchainIntegrity, 'C++ toolchain integrity manifest should be preserved');
    assertCondition(customAssets.javascriptWorker === '/sdk-assets/workers/js-runtime.js', 'Relative custom assets should join assetBaseUrl');
    assertCondition(
      customAssets.javascriptProjectWorker === '/sdk-assets/workers/js-project-runtime.js',
      'Relative custom JavaScript project assets should join assetBaseUrl'
    );
    assertCondition(customAssets.csharpAssetBaseUrl === '/sdk-assets/runtimes/csharp', 'Relative C# asset base should join assetBaseUrl');
    console.log('PASS: browser harness asset resolution');

    const browserProjectWorkspace = await createBrowserProjectWorkspace({
      assetBaseUrl: '/project-assets',
      files: [{ path: 'index.js', contents: 'console.log("browser-project-node")\n' }],
      nodeProjectTimeoutMs: 1000,
    });
    try {
      const projectNodeResult = await browserProjectWorkspace.runCommand('node index.js');
      const projectWorker = workerInstances.findLast((worker) =>
        String(worker.url).startsWith('/project-assets/javascript-project-worker.js')
      );
      assertCondition(projectNodeResult.exitCode === 0, 'Browser project Node command should complete through worker');
      assertCondition(
        projectNodeResult.stdout === 'execute-project-javascript:index.js\n',
        'Browser project Node worker response should be returned'
      );
      assertCondition(
        projectWorker?.messages.at(-1)?.type === 'execute-project-javascript',
        'Browser project Node command should use the JavaScript project worker'
      );
      assertCondition(
        !('signal' in ((projectWorker?.messages.at(-1)?.payload ?? {}) as Record<string, unknown>)),
        'Browser project Node worker payload should omit non-cloneable abort signals'
      );
    } finally {
      browserProjectWorkspace.dispose();
    }
    console.log('PASS: browser project workspace routes Node commands through worker');

    const javascriptOnlyWorkspace = await createBrowserProjectWorkspace({
      providers: ['javascript'],
      assetBaseUrl: '/project-javascript-only',
      files: [{ path: 'index.js', contents: 'console.log("selected")\n' }],
    });
    try {
      const javascriptResult = await javascriptOnlyWorkspace.runCommand('node index.js');
      const pythonResult = await javascriptOnlyWorkspace.runCommand('python3 -c "print(1)"');
      assertCondition(javascriptResult.exitCode === 0, 'selected JavaScript provider should be assembled');
      assertCondition(
        pythonResult.exitCode !== 0 && /command (?:not found|not available)/u.test(pythonResult.stderr),
        `unselected Python provider should not be exposed: ${JSON.stringify(pythonResult)}`
      );
    } finally {
      javascriptOnlyWorkspace.dispose();
    }

    const filesystemOnlyWorkspace = await createBrowserProjectWorkspace({
      providers: [],
      files: [{ path: 'README.md', contents: 'filesystem only\n' }],
    });
    try {
      const listing = await filesystemOnlyWorkspace.runCommand('ls');
      const runtimeAttempt = await filesystemOnlyWorkspace.runCommand('node index.js');
      assertCondition(listing.stdout.includes('README.md'), 'empty provider selection should retain the project filesystem');
      assertCondition(
        /command (?:not found|not available)/u.test(runtimeAttempt.stderr),
        'empty provider selection should expose no runtime adapters'
      );
    } finally {
      filesystemOnlyWorkspace.dispose();
    }
    console.log('PASS: browser project provider selection assembles only requested runtime adapters');

    let unselectedClassicHostProviderError = '';
    try {
      createBrowserHarness({
        providers: ['java'],
        executionHost: {
          url: 'https://exec.tracecode.test/host.html',
          providers: ['python'],
        },
      });
    } catch (error) {
      unselectedClassicHostProviderError = error instanceof Error ? error.message : String(error);
    }
    assertCondition(
      unselectedClassicHostProviderError.includes('executionHost provider "python" is not selected'),
      `Classic execution host routing must reject unselected providers: ${unselectedClassicHostProviderError}`
    );
    let splitJavaScriptHostProviderError = '';
    try {
      createBrowserHarness({
        providers: ['javascript', 'typescript'],
        executionHost: {
          url: 'https://exec.tracecode.test/host.html',
          providers: ['typescript'],
        },
      });
    } catch (error) {
      splitJavaScriptHostProviderError = error instanceof Error ? error.message : String(error);
    }
    assertCondition(
      splitJavaScriptHostProviderError.includes('JavaScript and TypeScript share one Classic worker'),
      `Classic execution host routing must make shared-worker placement explicit: ${splitJavaScriptHostProviderError}`
    );
    let unselectedProjectHostProviderError = '';
    try {
      await createBrowserProjectWorkspace({
        providers: ['python'],
        executionHost: {
          url: 'https://exec.tracecode.test/host.html',
          providers: ['java'],
        },
      });
    } catch (error) {
      unselectedProjectHostProviderError = error instanceof Error ? error.message : String(error);
    }
    assertCondition(
      unselectedProjectHostProviderError.includes('executionHost provider "java" is not selected'),
      `Project execution host routing must reject unselected providers: ${unselectedProjectHostProviderError}`
    );
    let unexecutableTypeScriptHostProviderError = '';
    try {
      await createBrowserProjectWorkspace({
        providers: ['typescript'],
        executionHost: {
          url: 'https://exec.tracecode.test/host.html',
          providers: ['typescript'],
        },
      });
    } catch (error) {
      unexecutableTypeScriptHostProviderError = error instanceof Error ? error.message : String(error);
    }
    assertCondition(
      unexecutableTypeScriptHostProviderError.includes('requires the "javascript" project provider'),
      `Project TypeScript host routing must name its JavaScript execution dependency: ${unexecutableTypeScriptHostProviderError}`
    );
    console.log('PASS: browser execution hosts validate provider-specific routing and shared-worker aliases');

    let invalidPythonCompileCacheError = '';
    try {
      new PythonWorkerClient({ workerUrl: '/python-worker.js', compileCacheLimit: 17 });
    } catch (error) {
      invalidPythonCompileCacheError = error instanceof Error ? error.message : String(error);
    }
    assertCondition(
      invalidPythonCompileCacheError.includes('Python compileCacheLimit must be an integer from 0 to 16'),
      `Python compiled runner cache must enforce its public memory bound: ${invalidPythonCompileCacheError}`
    );

    const concurrentProjectWorkspace = await createBrowserProjectWorkspace({
      assetBaseUrl: '/project-concurrency',
      pythonProjectTimeoutMs: 5000,
      files: [
        { path: 'hold.py', contents: 'print("hold")\n' },
        { path: 'client.py', contents: 'print("client")\n' },
      ],
    });
    try {
      const beforeWorkerCount = workerInstances.length;
      const heldStarted = new Promise<void>((resolve) => {
        heldPythonProjectStarted = resolve;
      });
      const held = concurrentProjectWorkspace.runCommand('python3 hold.py');
      await heldStarted;
      const client = await concurrentProjectWorkspace.runCommand('python3 client.py');
      const projectPythonWorkers = workerInstances
        .slice(beforeWorkerCount)
        .filter((worker) => String(worker.url).startsWith('/project-concurrency/pyodide-worker.js'));
      assertCondition(client.exitCode === 0, `Browser project workspace should run a second Python command while the first is active: ${JSON.stringify(client)}`);
      assertCondition(client.stdout === 'execute-project-python:client.py\n', `Second Python project command should complete normally: ${client.stdout}`);
      assertCondition(projectPythonWorkers.length >= 2, `Browser project workspace should create separate Python workers for concurrent commands: ${projectPythonWorkers.length}`);
      releaseHeldPythonProject?.();
      releaseHeldPythonProject = undefined;
      const heldResult = await held;
      assertCondition(heldResult.exitCode === 0 && heldResult.stdout === 'held-python-finished\n', `Held Python command should finish after release: ${JSON.stringify(heldResult)}`);
    } finally {
      heldPythonProjectStarted = undefined;
      releaseHeldPythonProject = undefined;
      concurrentProjectWorkspace.dispose();
    }
    console.log('PASS: browser project workspace isolates concurrent project runtime commands');

    const beforeAuthorityWorkerCount = workerInstances.length;
    const authorityProjectWorkspace = await createBrowserProjectWorkspace({
      assetBaseUrl: '/project-authority',
      assets: {
        runtimeManifests: {
          java: {
            runtime: 'java',
            runtimeVersion: 'test-java-project-assets',
            protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
            workerFormat: 'classic',
            loaderFormat: 'classic-script',
            assetBaseUrl: '/project-authority/',
            originPolicy: { mode: 'any' },
            assets: {
              worker: { url: 'java-worker.js' },
              loader: { url: 'cheerpj-loader.js' },
              helperJar: { url: 'helper.jar' },
              compilerJar: { url: 'compiler.jar' },
              rewriterJar: { url: 'rewriter.jar' },
              parserJar: { url: 'parser.jar' },
            },
          },
        },
      },
      projectWorkerPrewarm: {
        python: 1,
        javascript: 1,
        typescript: 1,
        java: 1,
        csharp: 1,
        cpp: 1,
      },
      files: [
        { path: 'main.py', contents: 'print("python")\n' },
        { path: 'main.js', contents: 'console.log("javascript")\n' },
        { path: 'main.ts', contents: 'console.log("typescript")\n' },
        { path: 'Main.java', contents: 'class Main { public static void main(String[] args) {} }\n' },
        { path: 'main.cpp', contents: 'int main() { return 0; }\n' },
        {
          path: 'App.csproj',
          contents: '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n',
        },
        { path: 'Program.cs', contents: 'Console.WriteLine("csharp");\n' },
      ],
    });
    try {
      const prewarmedWorkerUrls = workerInstances
        .slice(beforeAuthorityWorkerCount)
        .map((worker) => String(worker.url));
      for (const workerName of ['pyodide-worker.js', 'javascript-project-worker.js', 'java-worker.js', 'csharp-worker.js', 'cpp-worker.js']) {
        assertCondition(
          prewarmedWorkerUrls.some((url) => url.includes(workerName)),
          `Project workspace should begin ${workerName} warmup without waiting for a command: ${JSON.stringify(prewarmedWorkerUrls)}`
        );
      }
      await authorityProjectWorkspace.runCommand('python3 main.py');
      await authorityProjectWorkspace.runCommand('node main.js');
      await authorityProjectWorkspace.runCommand('java Main');
      await authorityProjectWorkspace.runCommand('dotnet run --project App.csproj');
      await authorityProjectWorkspace.runCommand('clang++ main.cpp -o app');
      const authorityWorkers = workerInstances.slice(beforeAuthorityWorkerCount);
      for (const [runtime, workerName, messageType] of [
        ['Python', 'pyodide-worker.js', 'execute-project-python'],
        ['Java', 'java-worker.js', 'execute-project-java'],
        ['C#', 'csharp-worker.js', 'execute-project-csharp'],
        ['C++', 'cpp-worker.js', 'execute-project-cpp'],
      ] as const) {
        const worker = authorityWorkers.find((candidate) =>
          String(candidate.url).includes(workerName) &&
          candidate.messages.some((message) => message.type === messageType)
        );
        const projectMessage = worker?.messages.find((message) => message.type === messageType);
        assertCondition(
          (projectMessage?.payload as { projectUserAuthorityMode?: unknown } | undefined)?.projectUserAuthorityMode === 'permanent',
          `${runtime} default per-command project worker must request permanent user-authority denial: ` +
            JSON.stringify(authorityWorkers.map((candidate) => ({ url: String(candidate.url), messages: candidate.messages })))
        );
        if (runtime !== 'C++') {
          assertCondition(
            (worker?.messages.findIndex((message) => message.type === 'warmup') ?? -1) >= 0 &&
              (worker?.messages.findIndex((message) => message.type === 'warmup') ?? -1) <
                (worker?.messages.findIndex((message) => message.type === messageType) ?? -1),
            `${runtime} prewarmed worker must finish warmup before its one user lease`
          );
        } else {
          const cppWarmupWorkerIndex = authorityWorkers.findIndex((candidate) =>
            String(candidate.url).includes('cpp-worker.js') &&
            candidate.messages.some((message) => message.type === 'warmup')
          );
          const cppCommandWorkerIndex = authorityWorkers.indexOf(worker!);
          assertCondition(
            cppWarmupWorkerIndex >= 0 && cppCommandWorkerIndex > cppWarmupWorkerIndex,
            'C++ toolchain warmup must start before the disposable user execution worker'
          );
        }
        assertCondition(worker?.terminated === true, `${runtime} one-shot project worker must be retired after the command`);
      }
    } finally {
      authorityProjectWorkspace.dispose();
    }

    const trustedSharedProjectWorkspace = await createBrowserProjectWorkspace({
      assetBaseUrl: '/project-authority-shared',
      projectWorkerIsolation: 'shared',
      trustedSharedWorkerReuse: true,
      files: [{ path: 'main.py', contents: 'print("trusted")\n' }],
    });
    try {
      await trustedSharedProjectWorkspace.runCommand('python3 main.py');
      const trustedWorker = workerInstances.findLast((worker) =>
        String(worker.url).startsWith('/project-authority-shared/pyodide-worker.js')
      );
      const projectMessage = trustedWorker?.messages.find((message) => message.type === 'execute-project-python');
      assertCondition(
        (projectMessage?.payload as { projectUserAuthorityMode?: unknown } | undefined)?.projectUserAuthorityMode === undefined,
        'Explicit trusted shared project workers must keep the reversible authority boundary'
      );
      assertCondition(trustedWorker?.terminated === false, 'Trusted shared project worker should remain reusable until disposal');
    } finally {
      trustedSharedProjectWorkspace.dispose();
    }
    console.log('PASS: disposable project workers request permanent authority denial while trusted shared workers stay reusable');

    let invalidPrewarmError = '';
    try {
      await createBrowserProjectWorkspace({ projectWorkerPrewarm: { python: 3 } });
    } catch (error) {
      invalidPrewarmError = error instanceof Error ? error.message : String(error);
    }
    assertCondition(
      invalidPrewarmError.includes('projectWorkerPrewarm.python must be an integer from 0 to 2'),
      `Prewarm depth must fail closed at the documented bound: ${invalidPrewarmError}`
    );

    const beforePrewarmWorkerCount = workerInstances.length;
    const prewarmedWorkspace = await createBrowserProjectWorkspace({
      assetBaseUrl: '/project-prewarm',
      projectWorkerPrewarm: { python: 1 },
      files: [
        { path: 'first.py', contents: 'print("first")\n' },
        { path: 'second.py', contents: 'print("second")\n' },
      ],
    });
    try {
      const first = await prewarmedWorkspace.runCommand('python3 first.py');
      const second = await prewarmedWorkspace.runCommand('python3 second.py');
      assertCondition(first.exitCode === 0 && second.exitCode === 0, 'Prewarmed Python project commands should complete');
      const poolWorkers = workerInstances
        .slice(beforePrewarmWorkerCount)
        .filter((worker) => String(worker.url).startsWith('/project-prewarm/pyodide-worker.js'));
      const executedWorkers = poolWorkers.filter((worker) =>
        worker.messages.some((message) => message.type === 'execute-project-python')
      );
      assertCondition(executedWorkers.length === 2, `Each command should lease one clean prewarmed worker: ${executedWorkers.length}`);
      assertCondition(
        executedWorkers.every((worker) =>
          worker.messages.filter((message) => message.type === 'execute-project-python').length === 1 &&
          worker.messages.findIndex((message) => message.type === 'warmup') <
            worker.messages.findIndex((message) => message.type === 'execute-project-python') &&
          worker.terminated
        ),
        'Prewarmed workers must warm before lease, execute once, and terminate without contaminated reuse'
      );
    } finally {
      prewarmedWorkspace.dispose();
    }
    assertCondition(
      workerInstances
        .slice(beforePrewarmWorkerCount)
        .filter((worker) => String(worker.url).startsWith('/project-prewarm/pyodide-worker.js'))
        .every((worker) => worker.terminated),
      'Disposing a prewarmed workspace must retire idle, warming, and leased workers'
    );

    const abortWarmupPrefix = '/project-cold-warmup-abort/pyodide-worker.js';
    holdPythonWarmupForUrlPrefix = abortWarmupPrefix;
    const abortWarmupWorkspace = await createBrowserProjectWorkspace({
      assetBaseUrl: '/project-cold-warmup-abort',
      projectWorkerPrewarm: { python: 0 },
      files: [{ path: 'abort.py', contents: 'while True: pass\n' }],
    });
    const abortWarmupController = new AbortController();
    const abortWarmupStartedAt = Date.now();
    const abortWarmupCommand = abortWarmupWorkspace.runCommand('python3 abort.py', {
      signal: abortWarmupController.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    abortWarmupController.abort();
    const abortWarmupResult = await abortWarmupCommand;
    const abortWarmupWallMs = Date.now() - abortWarmupStartedAt;
    const abortedWarmupWorker = workerInstances.findLast((worker) =>
      String(worker.url).startsWith(abortWarmupPrefix)
    );
    holdPythonWarmupForUrlPrefix = undefined;
    abortWarmupWorkspace.dispose();
    assertCondition(
      abortWarmupResult.exitCode === 143 &&
        abortWarmupResult.error?.detail?.signal === 'SIGTERM' &&
        abortWarmupWallMs < 1_000,
      `Aborting a command during a cold provider warmup should settle immediately: ${JSON.stringify({ abortWarmupResult, abortWarmupWallMs })}`
    );
    assertCondition(
      abortedWarmupWorker?.terminated === true &&
        !abortedWarmupWorker.messages.some((message) => message.type === 'execute-project-python'),
      'Aborting a cold provider warmup must retire the worker before user code executes'
    );

    failedWarmupUrlPrefix = '/project-prewarm-failure/pyodide-worker.js';
    remainingFailedWarmups = 1;
    const beforeFailedPrewarmCount = workerInstances.length;
    const retryingPrewarmWorkspace = await createBrowserProjectWorkspace({
      assetBaseUrl: '/project-prewarm-failure',
      projectWorkerPrewarm: { python: 1 },
      files: [{ path: 'retry.py', contents: 'print("retry")\n' }],
    });
    try {
      const result = await retryingPrewarmWorkspace.runCommand('python3 retry.py');
      assertCondition(result.exitCode === 0, `A failed prewarm should be evicted and retried: ${JSON.stringify(result)}`);
      const retryWorkers = workerInstances
        .slice(beforeFailedPrewarmCount)
        .filter((worker) => String(worker.url).startsWith('/project-prewarm-failure/pyodide-worker.js'));
      assertCondition(retryWorkers.length >= 2, 'A failed prewarm should create a fresh replacement worker');
      assertCondition(
        retryWorkers[0]?.terminated === true &&
        !retryWorkers[0]?.messages.some((message) => message.type === 'execute-project-python'),
        'A worker whose warmup failed must be retired before any user command'
      );
      assertCondition(
        retryWorkers.some((worker) =>
          worker.messages.filter((message) => message.type === 'execute-project-python').length === 1 && worker.terminated
        ),
        'The replacement prewarmed worker should execute once and retire'
      );
    } finally {
      failedWarmupUrlPrefix = undefined;
      remainingFailedWarmups = 0;
      retryingPrewarmWorkspace.dispose();
    }

    const retiringPrewarmWorkspace = await createBrowserProjectWorkspace({
      assetBaseUrl: '/project-prewarm-retire',
      projectWorkerPrewarm: { python: 1 },
      files: [{ path: 'hold.py', contents: 'print("hold")\n' }],
    });
    const retiringStarted = new Promise<void>((resolve) => {
      heldPythonProjectStarted = resolve;
    });
    const retiringCommand = retiringPrewarmWorkspace.runCommand('python3 hold.py');
    await retiringStarted;
    const retiringWorker = workerInstances.findLast((worker) =>
      String(worker.url).startsWith('/project-prewarm-retire/pyodide-worker.js') &&
      worker.messages.some((message) => message.type === 'execute-project-python')
    );
    retiringPrewarmWorkspace.dispose();
    await retiringCommand.catch(() => undefined);
    assertCondition(retiringWorker?.terminated === true, 'Disposal must immediately retire an active one-shot lease');
    heldPythonProjectStarted = undefined;
    releaseHeldPythonProject = undefined;
    console.log('PASS: opt-in one-shot prewarm pools warm before lease, never reuse user workers, and evict failures');

    const harnessA = createBrowserHarness({ assetBaseUrl: '/instance-a' });
    const harnessB = createBrowserHarness({ assetBaseUrl: '/instance-b', debug: true });
    assertCondition(harnessA.isLanguageSupported('java'), 'Browser harness should expose Java support');
    assertCondition(harnessA.isLanguageSupported('csharp'), 'Browser harness should expose C# support');
    assertCondition(harnessA.isLanguageSupported('cpp'), 'Browser harness should expose C++ support');
    const cppProfile = harnessA.getProfile('cpp');
    const csharpProfile = harnessA.getProfile('csharp');
    const typescriptInfo = harnessA.getLanguageInfo('typescript');
    const supportedInfos = harnessA.getSupportedLanguageInfos();
    let invalidRuntimeInfoError = '';
    try {
      harnessA.getLanguageInfo('constructor' as never);
    } catch (error) {
      invalidRuntimeInfoError = error instanceof Error ? error.message : String(error);
    }
    assertCondition(csharpProfile.capabilities.execution.limits.wallClock, 'C# profile should honor wall-clock execution limits');
    assertCondition(cppProfile.capabilities.execution.styles.function, 'C++ profile should support function execution');
    assertCondition(cppProfile.capabilities.execution.styles.solutionMethod, 'C++ profile should support solution-method execution');
    assertCondition(cppProfile.capabilities.execution.styles.opsClass, 'C++ profile should support ops-class execution');
    assertCondition(cppProfile.capabilities.execution.styles.script, 'C++ profile should support script execution');
    assertCondition(cppProfile.capabilities.execution.limits.wallClock, 'C++ profile should honor wall-clock execution limits');
    assertCondition(
      typescriptInfo.compiler?.name === 'TypeScript' && Boolean(typescriptInfo.compiler.version),
      'Browser harness should expose TypeScript runtime info'
    );
    assertCondition(
      typescriptInfo.description.includes('Compiler options:') &&
        typescriptInfo.description.includes('@datastructures-js/priority-queue'),
      'Browser harness should expose natural-language TypeScript runtime info'
    );
    assertCondition(
      supportedInfos.some((info) => info.language === 'csharp' && Boolean(info.runtime.version)),
      'Browser harness should expose supported language runtime infos'
    );
    assertCondition(
      invalidRuntimeInfoError.includes('Runtime info for language "constructor" is not implemented yet.'),
      `Browser harness should reject inherited runtime info keys: ${invalidRuntimeInfoError}`
    );

    await harnessA.getClient('javascript').init();
    await harnessA.getClient('java').init();
    await harnessA.getClient('csharp').init();
    await harnessA.getClient('cpp').init();
    await harnessB.getClient('python').init();

    assertCondition(
      workerInstances.some((worker) => String(worker.url).startsWith('/instance-a/javascript-worker.js')),
      'Harness A should use its own JavaScript worker URL'
    );
    assertCondition(
      workerInstances.some((worker) => String(worker.url).startsWith('/instance-a/java-worker.js')),
      'Harness A should use its own Java worker URL'
    );
    assertCondition(
      workerInstances.some((worker) => String(worker.url).startsWith('/instance-a/csharp-worker.js')),
      'Harness A should use its own C# worker URL'
    );
    assertCondition(
      workerInstances.some((worker) => String(worker.url).startsWith('/instance-a/cpp-worker.js')),
      'Harness A should use its own C++ worker URL'
    );
    assertCondition(
      workerInstances.some((worker) => String(worker.url).startsWith('/instance-b/pyodide-worker.js?dev=')),
      'Harness B should use its own Python worker URL when debug is enabled'
    );
    console.log('PASS: browser harness uses per-instance worker URLs');

    const pythonWarmupResult = await harnessB.warmLanguage('python');
    const pythonWarmupWorker = workerInstances.findLast((worker) =>
      String(worker.url).startsWith('/instance-b/pyodide-worker.js')
    );
    assertCondition(pythonWarmupResult.success, 'Python warmLanguage should resolve successfully');
    assertCondition(
      pythonWarmupWorker?.messages.at(-1)?.type === 'warmup',
      'Python warmLanguage should send the Python warmup worker request'
    );
    console.log('PASS: browser harness warms Python runtime on demand');

    const coldPythonHarness = createBrowserHarness({ assetBaseUrl: '/cold-python' });
    const coldPythonResult = await coldPythonHarness.getClient('python').executeCode({ code: 'result = 1', functionName: 'noop', inputs: {}, executionStyle: 'function' });
    const coldPythonWorker = workerInstances.findLast((worker) => String(worker.url).startsWith('/cold-python/pyodide-worker.js'));
    const coldPythonMessageTypes = coldPythonWorker?.messages.map((message) => message.type).join(',');
    assertCondition(coldPythonResult.kind === 'completed', 'Cold Python harness should execute successfully');
    assertCondition(
      coldPythonMessageTypes === 'init,warmup,execute-code',
      `Cold Python execution should warm the runtime before execute-code: ${coldPythonMessageTypes}`
    );
    assertCondition(
      coldPythonWorker?.terminated === true,
      'Safe browser harness execution should retire the Python interpreter worker after user code'
    );
    await coldPythonHarness.getClient('python').executeCode({ code: 'result = 2', functionName: 'noop', inputs: {}, executionStyle: 'function' });
    const secondColdPythonWorker = workerInstances.findLast((worker) =>
      String(worker.url).startsWith('/cold-python/pyodide-worker.js')
    );
    assertCondition(
      secondColdPythonWorker !== coldPythonWorker && secondColdPythonWorker?.terminated === true,
      'Consecutive safe Python executions should use different retired workers'
    );
    coldPythonHarness.dispose();
    console.log('PASS: browser harness warms cold Python execution before user-code timing');

    const unsafePythonHarness = createBrowserHarness({
      assetBaseUrl: '/unsafe-python-reuse',
      executionIsolation: 'unsafe-reuse',
    });
    await unsafePythonHarness.getClient('python').executeCode({ code: 'result = 1', functionName: 'noop', inputs: {}, executionStyle: 'function' });
    const unsafePythonWorker = workerInstances.findLast((worker) =>
      String(worker.url).startsWith('/unsafe-python-reuse/pyodide-worker.js')
    );
    await unsafePythonHarness.getClient('python').executeCode({ code: 'result = 2', functionName: 'noop', inputs: {}, executionStyle: 'function' });
    const reusedUnsafePythonWorker = workerInstances.findLast((worker) =>
      String(worker.url).startsWith('/unsafe-python-reuse/pyodide-worker.js')
    );
    assertCondition(
      unsafePythonWorker === reusedUnsafePythonWorker && unsafePythonWorker?.terminated === false,
      'Unsafe reuse should require an explicit harness option and retain the interpreter worker'
    );
    unsafePythonHarness.dispose();
    console.log('PASS: browser harness defaults to fresh workers and requires explicit unsafe reuse');

    const timeoutPythonUrl = '/cold-python-timeout/pyodide-worker.js';
    const timeoutPythonClient = new PythonWorkerClient({ workerUrl: timeoutPythonUrl });
    const beforePythonTimeoutWorkerCount = workerInstances.length;
    let coldWarmupTimeoutError = '';
    holdPythonWarmupForUrlPrefix = timeoutPythonUrl;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 120_000) {
        return originalSetTimeout(handler, 0, ...args);
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout;
    try {
      await timeoutPythonClient.executeCode({ code: 'result = 1', functionName: 'noop', inputs: {}, executionStyle: 'function' });
    } catch (error) {
      coldWarmupTimeoutError = error instanceof Error ? error.message : String(error);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      holdPythonWarmupForUrlPrefix = undefined;
      timeoutPythonClient.terminate();
    }
    const coldWarmupTimeoutWorker = workerInstances[beforePythonTimeoutWorkerCount];
    assertCondition(
      coldWarmupTimeoutError.includes('Worker request timed out: warmup'),
      `Cold Python warmup should fail under the runtime warmup timeout: ${coldWarmupTimeoutError}`
    );
    assertCondition(
      coldWarmupTimeoutWorker?.terminated === true,
      'Cold Python warmup timeout should terminate and reset the worker'
    );
    assertCondition(
      coldWarmupTimeoutWorker?.messages.map((message) => message.type).join(',') === 'init,warmup',
      `Cold Python warmup timeout should not reach execute-code: ${coldWarmupTimeoutWorker?.messages.map((message) => message.type).join(',')}`
    );
    console.log('PASS: Python cold warmup is bounded by runtime warmup timeout');

    const javaWarmupResult = await harnessA.warmLanguage('java');
    const javaWarmupWorker = workerInstances.findLast((worker) => String(worker.url).startsWith('/instance-a/java-worker.js'));
    assertCondition(javaWarmupResult.success, 'Java warmLanguage should resolve successfully');
    assertCondition(
      javaWarmupWorker?.messages.at(-1)?.type === 'warmup',
      'Java warmLanguage should send the Java warmup worker request'
    );
    console.log('PASS: browser harness warms Java runtime on demand');

    let javaHttpDispatchPath = '';
    const javaHttpClient = new JavaWorkerClient({ workerUrl: '/instance-a/java-worker.js' });
    const javaHttpResult = await javaHttpClient.executeProjectJava({
      code: '',
      source: 'run',
      scriptPath: 'HttpClient.java',
      args: [],
      cwd: '/workspace',
      env: {},
      project: {
        files: [{ path: 'HttpClient.java', contents: 'class HttpClient {}\n' }],
      },
      kernelHttp: {
        listen() {
          throw new Error('Java client-side HTTP test should not open listeners');
        },
        async dispatch(request) {
          javaHttpDispatchPath = request.path;
          return {
            status: 201,
            headers: { 'content-type': 'text/plain' },
            body: 'queued',
          };
        },
      },
    });
    javaHttpClient.terminate();
    assertCondition(javaHttpDispatchPath === '/queue?limit=1', 'Java worker client should dispatch TraceKernel HTTP requests');
    assertCondition(
      javaHttpResult.stdout.startsWith('OK\n201\n') && javaHttpResult.stdout.endsWith('\ncXVldWVk'),
      'Java worker client should write TraceKernel HTTP responses into the sync bridge buffer'
    );
    const javaHttpWorker = workerInstances.findLast((worker) => String(worker.url).startsWith('/instance-a/java-worker.js'));
    assertCondition(
      !('kernelHttp' in ((javaHttpWorker?.messages.at(-1)?.payload ?? {}) as Record<string, unknown>)),
      'Java worker payload should omit the non-cloneable kernel HTTP bridge'
    );
    console.log('PASS: Java worker client bridges synchronous TraceKernel HTTP dispatch');

    let javaListenClosed = false;
    let javaListenPort = 0;
    let javaServerExternalResponse: { status?: number; body?: string; bodyEncoding?: string; headers?: Record<string, string> } | undefined;
    let javaServerQueuedResponse: { status?: number; body?: string; bodyEncoding?: string; headers?: Record<string, string> } | undefined;
    const javaServerClient = new JavaWorkerClient({ workerUrl: '/instance-a/java-worker.js' });
    const javaServerResult = await javaServerClient.executeProjectJava({
      code: '',
      source: 'run',
      scriptPath: 'HttpServer.java',
      args: [],
      cwd: '/workspace',
      env: {},
      project: {
        files: [{ path: 'HttpServer.java', contents: 'class HttpServer {}\n' }],
      },
      kernelHttp: {
        listen(options, handler) {
          javaListenPort = options.port ?? 0;
          void Promise.resolve(handler({
            method: 'POST',
            url: 'http://127.0.0.1:3210/queue?id=7',
            path: '/queue?id=7',
            headers: { 'content-type': 'text/plain' },
            body: 'work',
          })).then((response) => {
            javaServerExternalResponse = response;
          });
          void Promise.resolve(handler({
            method: 'GET',
            url: 'http://127.0.0.1:3210/busy',
            path: '/busy',
          })).then((response) => {
            javaServerQueuedResponse = response;
          });
          return {
            id: 'java-http-test',
            info: { id: 'java-http-test', pid: 0, protocol: 'http' as const, startedAt: new Date(0).toISOString(), host: options.host ?? '127.0.0.1', port: javaListenPort, url: `http://127.0.0.1:${javaListenPort}` },
            close() {
              javaListenClosed = true;
            },
          };
        },
        async dispatch() {
          throw new Error('Java server listener registration test should not dispatch outbound requests');
        },
      },
    });
    await Promise.resolve();
    javaServerClient.terminate();
    assertCondition(javaServerResult.stdout.startsWith('server-listened\nREQUEST\n'), 'Java worker client should complete after Java HTTP server request lifecycle');
    assertCondition(javaListenPort === 3210, 'Java worker client should register Java HttpServer listeners with TraceKernel HTTP');
    assertCondition(
      javaServerResult.stdout.includes(testBase64('POST')) &&
        javaServerResult.stdout.includes(testBase64('/queue?id=7')) &&
        javaServerResult.stdout.includes(testBase64('GET')) &&
        javaServerResult.stdout.includes(testBase64('/busy')),
      `Java worker client should write queued external TraceKernel HTTP requests into the Java server buffer: ${javaServerResult.stdout}`
    );
    assertCondition(
      javaServerExternalResponse?.status === 208 &&
        javaServerExternalResponse.bodyEncoding === 'base64' &&
        javaServerExternalResponse.body === testBase64('server-body') &&
        javaServerExternalResponse.headers?.['x-java-server'] === 'ok',
      'Java worker client should read Java server responses from the shared buffer'
    );
    assertCondition(
      javaServerQueuedResponse?.status === 208 &&
        javaServerQueuedResponse.bodyEncoding === 'base64' &&
        javaServerQueuedResponse.body === testBase64('queued-body') &&
        javaServerQueuedResponse.headers?.['x-java-server'] === 'ok',
      'Java worker client should queue concurrent Java HTTP server requests behind the shared bridge buffer'
    );
    assertCondition(javaListenClosed, 'Java worker client should close Java HttpServer listeners when the worker closes them');
    console.log('PASS: Java worker client bridges TraceKernel HTTP server listeners');

    let javaTimeoutListenClosed = false;
    javaHttpTimeoutRequestBuffer = undefined;
    const javaTimeoutServerStarted = new Promise<void>((resolve) => {
      javaHttpTimeoutServerStarted = resolve;
    });
    const javaTimeoutClient = new JavaWorkerClient({ workerUrl: '/instance-a/java-worker.js' });
    const javaTimeoutRun = javaTimeoutClient.executeProjectJava({
      code: '',
      source: 'run',
      scriptPath: 'HttpServerTimeout.java',
      args: [],
      cwd: '/workspace',
      env: {},
      project: {
        files: [{ path: 'HttpServerTimeout.java', contents: 'class HttpServerTimeout {}\n' }],
      },
      kernelHttp: {
        listen(options) {
          return {
            id: 'java-http-timeout-test',
            info: {
              id: 'java-http-timeout-test',
              pid: 0,
              protocol: 'http' as const,
              startedAt: new Date(0).toISOString(),
              host: options.host ?? '127.0.0.1',
              port: options.port ?? 0,
              url: `http://127.0.0.1:${options.port ?? 0}`,
            },
            close() {
              javaTimeoutListenClosed = true;
            },
          };
        },
        async dispatch() {
          throw new Error('Java server timeout test should not dispatch outbound requests');
        },
      },
    }, 25);
    await javaTimeoutServerStarted;
    let javaTimeoutError = '';
    try {
      await javaTimeoutRun;
    } catch (error) {
      javaTimeoutError = error instanceof Error ? error.message : String(error);
    } finally {
      javaHttpTimeoutServerStarted = undefined;
      javaTimeoutClient.terminate();
    }
    assertCondition(
      javaTimeoutError.includes('Java execution timed out'),
      `Java server timeout should reject command execution: ${javaTimeoutError}`
    );
    assertCondition(javaTimeoutListenClosed, 'Java worker client should close Java HttpServer listeners when a command times out');
    assertCondition(Boolean(javaHttpTimeoutRequestBuffer), 'Java server timeout test should expose the listener request buffer');
    assertCondition(
      Atomics.load(new Int32Array(javaHttpTimeoutRequestBuffer!, 0, 2), JAVA_HTTP_SYNC_STATE_INDEX) === JAVA_HTTP_SYNC_CLOSED,
      'Java worker client should wake Java HttpServer bridge waits when a command times out'
    );
    console.log('PASS: Java worker client closes TraceKernel HTTP listeners on timeout');

    const cppWarmupResult = await harnessA.warmLanguage('cpp');
    const cppWarmupWorker = workerInstances.findLast(
      (worker) =>
        String(worker.url).startsWith('/instance-a/cpp-worker.js') &&
        worker.messages.some((message) => message.type === 'warmup')
    );
    assertCondition(cppWarmupResult.success, 'C++ warmLanguage should resolve successfully');
    assertCondition(
      cppWarmupWorker?.messages.some((message) => message.type === 'warmup') === true,
      'C++ warmLanguage should send the C++ warmup worker request'
    );
    console.log('PASS: browser harness warms C++ runtime on demand');

    const cppWorkerAssets = {
      clangWasmUrl: '/instance-a/vendor/cpp/clang.wasm',
      lldWasmUrl: '/instance-a/vendor/cpp/lld.wasm',
      sysrootUrl: '/instance-a/vendor/cpp/sysroot.tar',
      runtimeHeaderUrl: '/instance-a/vendor/cpp/tracecode_runtime.hpp',
      compilerBundleUrl: '/instance-a/vendor/cpp/yowasp/bundle.js',
    };
    let cppHttpDispatchPath = '';
    const cppHttpClient = new CppWorkerClient({ workerUrl: '/instance-a/cpp-worker.js', ...cppWorkerAssets });
    const cppHttpResult = await cppHttpClient.executeProjectCpp({
      code: '',
      source: 'run',
      scriptPath: './http-client',
      args: [],
      cwd: '/workspace',
      env: {},
      project: {
        files: [{ path: 'http-client', contents: '' }],
      },
      kernelHttp: {
        listen() {
          throw new Error('C++ client-side HTTP test should not open listeners');
        },
        async dispatch(request) {
          cppHttpDispatchPath = request.path;
          return {
            status: 201,
            headers: { 'content-type': 'text/plain' },
            body: 'queued',
          };
        },
      },
    });
    cppHttpClient.terminate();
    assertCondition(cppHttpDispatchPath === '/queue?limit=1', 'C++ worker client should dispatch TraceKernel HTTP requests');
    assertCondition(
      cppHttpResult.stdout.startsWith('OK\n201\n') && cppHttpResult.stdout.endsWith('\ncXVldWVk'),
      'C++ worker client should write TraceKernel HTTP responses into the sync bridge buffer'
    );
    const cppHttpWorker = workerInstances.findLast((worker) => String(worker.url).startsWith('/instance-a/cpp-worker.js'));
    assertCondition(
      !('kernelHttp' in ((cppHttpWorker?.messages.at(-1)?.payload ?? {}) as Record<string, unknown>)),
      'C++ worker payload should omit the non-cloneable kernel HTTP bridge'
    );
    console.log('PASS: C++ worker client bridges synchronous TraceKernel HTTP dispatch');

    let cppListenClosed = false;
    let cppListenPort = 0;
    let cppServerExternalResponse: { status?: number; body?: string; bodyEncoding?: string; headers?: Record<string, string> } | undefined;
    let cppServerQueuedResponse: { status?: number; body?: string; bodyEncoding?: string; headers?: Record<string, string> } | undefined;
    const cppServerClient = new CppWorkerClient({ workerUrl: '/instance-a/cpp-worker.js', ...cppWorkerAssets });
    const cppServerResult = await cppServerClient.executeProjectCpp({
      code: '',
      source: 'run',
      scriptPath: './http-server',
      args: [],
      cwd: '/workspace',
      env: {},
      project: {
        files: [{ path: 'http-server', contents: '' }],
      },
      kernelHttp: {
        listen(options, handler) {
          cppListenPort = options.port ?? 0;
          void Promise.resolve(handler({
            method: 'POST',
            url: 'http://127.0.0.1:3210/queue?id=7',
            path: '/queue?id=7',
            headers: { 'content-type': 'text/plain' },
            body: 'work',
          })).then((response) => {
            cppServerExternalResponse = response;
          });
          void Promise.resolve(handler({
            method: 'GET',
            url: 'http://127.0.0.1:3210/busy',
            path: '/busy',
          })).then((response) => {
            cppServerQueuedResponse = response;
          });
          return {
            id: 'cpp-http-test',
            info: { id: 'cpp-http-test', pid: 0, protocol: 'http' as const, startedAt: new Date(0).toISOString(), host: options.host ?? '127.0.0.1', port: cppListenPort, url: `http://127.0.0.1:${cppListenPort}` },
            close() {
              cppListenClosed = true;
            },
          };
        },
        async dispatch() {
          throw new Error('C++ server listener registration test should not dispatch outbound requests');
        },
      },
    });
    await Promise.resolve();
    cppServerClient.terminate();
    assertCondition(cppServerResult.stdout.startsWith('server-listened\nREQUEST\n'), 'C++ worker client should complete after C++ HTTP server request lifecycle');
    assertCondition(cppListenPort === 3210, 'C++ worker client should register C++ HTTP server listeners with TraceKernel HTTP');
    assertCondition(
      cppServerResult.stdout.includes(testBase64('POST')) &&
        cppServerResult.stdout.includes(testBase64('/queue?id=7')) &&
        cppServerResult.stdout.includes(testBase64('GET')) &&
        cppServerResult.stdout.includes(testBase64('/busy')),
      `C++ worker client should write queued external TraceKernel HTTP requests into the C++ server buffer: ${cppServerResult.stdout}`
    );
    assertCondition(
      cppServerExternalResponse?.status === 208 &&
        cppServerExternalResponse.bodyEncoding === 'base64' &&
        cppServerExternalResponse.body === testBase64('server-body') &&
        cppServerExternalResponse.headers?.['x-java-server'] === 'ok',
      'C++ worker client should read C++ server responses from the shared buffer'
    );
    assertCondition(
      cppServerQueuedResponse?.status === 208 &&
        cppServerQueuedResponse.bodyEncoding === 'base64' &&
        cppServerQueuedResponse.body === testBase64('queued-body'),
      'C++ worker client should queue concurrent C++ HTTP server requests behind the shared bridge buffer'
    );
    assertCondition(cppListenClosed, 'C++ worker client should close C++ HTTP server listeners when the worker closes them');
    console.log('PASS: C++ worker client bridges TraceKernel HTTP server listeners');

    let cppTimeoutListenClosed = false;
    javaHttpTimeoutRequestBuffer = undefined;
    const cppTimeoutServerStarted = new Promise<void>((resolve) => {
      javaHttpTimeoutServerStarted = resolve;
    });
    const cppTimeoutClient = new CppWorkerClient({ workerUrl: '/instance-a/cpp-worker.js', ...cppWorkerAssets });
    const cppTimeoutRun = cppTimeoutClient.executeProjectCpp({
      code: '',
      source: 'run',
      scriptPath: './http-server-timeout',
      args: [],
      cwd: '/workspace',
      env: {},
      project: {
        files: [{ path: 'http-server-timeout', contents: '' }],
      },
      kernelHttp: {
        listen(options) {
          return {
            id: 'cpp-http-timeout-test',
            info: {
              id: 'cpp-http-timeout-test',
              pid: 0,
              protocol: 'http' as const,
              startedAt: new Date(0).toISOString(),
              host: options.host ?? '127.0.0.1',
              port: options.port ?? 0,
              url: `http://127.0.0.1:${options.port ?? 0}`,
            },
            close() {
              cppTimeoutListenClosed = true;
            },
          };
        },
        async dispatch() {
          throw new Error('C++ server timeout test should not dispatch outbound requests');
        },
      },
    }, 25);
    await cppTimeoutServerStarted;
    let cppTimeoutError = '';
    try {
      await cppTimeoutRun;
    } catch (error) {
      cppTimeoutError = error instanceof Error ? error.message : String(error);
    } finally {
      javaHttpTimeoutServerStarted = undefined;
      cppTimeoutClient.terminate();
    }
    assertCondition(
      cppTimeoutError.includes('C++ compile/run timed out'),
      `C++ server timeout should reject command execution: ${cppTimeoutError}`
    );
    assertCondition(cppTimeoutListenClosed, 'C++ worker client should close C++ HTTP server listeners when a command times out');
    assertCondition(Boolean(javaHttpTimeoutRequestBuffer), 'C++ server timeout test should expose the listener request buffer');
    assertCondition(
      Atomics.load(new Int32Array(javaHttpTimeoutRequestBuffer!, 0, 2), JAVA_HTTP_SYNC_STATE_INDEX) === JAVA_HTTP_SYNC_CLOSED,
      'C++ worker client should wake C++ HTTP server bridge waits when a command times out'
    );
    console.log('PASS: C++ worker client closes TraceKernel HTTP listeners on timeout');

    const csharpWarmupResult = await harnessA.warmLanguage('csharp');
    const csharpWarmupWorker = workerInstances.findLast((worker) => String(worker.url).startsWith('/instance-a/csharp-worker.js'));
    assertCondition(csharpWarmupResult.success, 'C# warmLanguage should resolve successfully');
    assertCondition(
      csharpWarmupWorker?.messages.at(-1)?.type === 'warmup',
      'C# warmLanguage should send the C# warmup worker request'
    );
    console.log('PASS: browser harness warms C# runtime on demand');

    const coldCSharpHarness = createBrowserHarness({ assetBaseUrl: '/cold-csharp' });
    const coldCSharpResult = await coldCSharpHarness
      .getClient('csharp')
      .executeCode({ code: 'public class Solution { public int Add(int a, int b) => a + b; }', functionName: 'Add', inputs: { a: 1, b: 2 }, executionStyle: 'solution-method' });
    const coldCSharpWorker = workerInstances.findLast((worker) => String(worker.url).startsWith('/cold-csharp/csharp-worker.js'));
    const coldCSharpMessageTypes = coldCSharpWorker?.messages.map((message) => message.type).join(',');
    coldCSharpHarness.dispose();
    assertCondition(coldCSharpResult.kind === 'completed', 'Cold C# harness should execute successfully');
    assertCondition(
      coldCSharpMessageTypes === 'init,warmup,execute-code',
      `Cold C# execution should warm the runtime before execute-code: ${coldCSharpMessageTypes}`
    );
    console.log('PASS: browser harness warms cold C# execution before user-code timing');

    const typescriptWarmupResult = await harnessA.warmLanguage('typescript');
    const typescriptWarmupWorker = workerInstances.findLast((worker) =>
      String(worker.url).startsWith('/instance-a/javascript-worker.js')
    );
    const typescriptWarmupPayload = typescriptWarmupWorker?.messages.at(-1)?.payload as
      | { language?: string }
      | undefined;
    assertCondition(typescriptWarmupResult.success, 'TypeScript warmLanguage should resolve successfully');
    assertCondition(
      typescriptWarmupWorker?.messages.at(-1)?.type === 'warmup' && typescriptWarmupPayload?.language === 'typescript',
      'TypeScript warmLanguage should send the JavaScript worker warmup request'
    );
    console.log('PASS: browser harness warms TypeScript compiler on demand');

    const survivingWorker = workerInstances.find((worker) => String(worker.url).startsWith('/instance-b/pyodide-worker.js'));
    harnessA.dispose();
    assertCondition(
      Boolean(survivingWorker && !survivingWorker.terminated),
      'Disposing one harness should not terminate another harness instance'
    );

    const executeResult = await harnessB.getClient('python').executeCode({ code: 'result = 1', functionName: 'noop', inputs: {}, executionStyle: 'function' });
    assertCondition(executeResult.kind === 'completed', 'Surviving harness instance should still execute after a peer is disposed');
    const pythonBatchResult = await harnessB.getClient('python').execute({
      code: 'def add(a, b):\n    return a + b',
      functionName: 'add',
      executionStyle: 'function',
      cases: [
        { id: 'a', inputs: { a: 1, b: 2 }, expected: { a: 1, b: 2 } },
        { id: 'b', inputs: { a: 3, b: 4 }, expected: { a: 3, b: 4 } },
      ],
    });
    assertCondition(pythonBatchResult.success, 'Python unified execute should route multi-case run requests');
    assertCondition(
      workerInstances.findLast((worker) => String(worker.url).startsWith('/instance-b/pyodide-worker.js'))?.messages.at(-1)?.type === 'execute-code-batch',
      'Python unified execute should send execute-code-batch for multi-case run requests'
    );
    const javascriptBatchResult = await harnessB.getClient('javascript').execute({
      code: 'function add(a, b) { return a + b; }',
      functionName: 'add',
      executionStyle: 'function',
      cases: [
        { id: 'a', inputs: { a: 1, b: 2 }, expected: { a: 1, b: 2 } },
        { id: 'b', inputs: { a: 3, b: 4 }, expected: { a: 3, b: 4 } },
      ],
    });
    assertCondition(javascriptBatchResult.success, 'JavaScript unified execute should route multi-case run requests');
    const javascriptBatchWorker = workerInstances.findLast(
      (worker) =>
        String(worker.url).startsWith('/instance-b/javascript-worker.js') &&
        worker.messages.some((message) => message.type === 'execute-code-batch')
    );
    assertCondition(
      javascriptBatchWorker?.messages.at(-1)?.type === 'execute-code-batch',
      'JavaScript unified execute should send execute-code-batch for multi-case run requests'
    );
    assertCondition(Boolean(javascriptBatchWorker?.terminated), 'JavaScript worker should terminate after a code execution');
    const javascriptSingleResult = await harnessB.getClient('javascript').executeCode({ code: 'function id(x) { return x; }', functionName: 'id', inputs: { x: 1 }, executionStyle: 'function' });
    const javascriptSingleWorker = workerInstances.findLast(
      (worker) =>
        String(worker.url).startsWith('/instance-b/javascript-worker.js') &&
        worker.messages.some((message) => message.type === 'execute-code')
    );
    assertCondition(javascriptSingleResult.kind === 'completed', 'JavaScript runtime should execute again after worker isolation reset');
    assertCondition(
      Boolean(javascriptSingleWorker && javascriptSingleWorker !== javascriptBatchWorker && javascriptSingleWorker.terminated),
      'JavaScript runtime should create and terminate a fresh worker for the next execution'
    );
    console.log('PASS: browser harness instances are isolated');

    const javaExecuteResult = await harnessA
      .getClient('java')
      .executeCode({ code: 'int search(int[] nums, int target) { return 0; }', functionName: 'search', inputs: {}, executionStyle: 'function' });
    assertCondition(javaExecuteResult.kind === 'completed', 'Java runtime should route function-style executeCode through the browser harness client');
    const javaWorker = workerInstances.findLast((worker) => String(worker.url).startsWith('/instance-a/java-worker.js'));
    assertCondition(
      javaWorker?.messages.at(-1)?.type === 'execute-code' && javaWorker.terminated,
      'Java executeCode should send execute-code instead of execute-with-tracing'
    );
    console.log('PASS: browser harness routes Java runtime requests');

    const javaLimitsResult = await harnessA
      .getClient('java')
      .executeCode({ code: 'int search(int[] nums, int target) { return 0; }', functionName: 'search', inputs: {}, executionStyle: 'function', limits: {
        wallClockMs: 5_000,
      } });
    assertCondition(
      javaLimitsResult.kind === 'completed',
      'Java runtime should route wall-clock-limited executeCode through the browser harness client'
    );
    const javaLimitsWorker = workerInstances.findLast((worker) =>
      String(worker.url).startsWith('/instance-a/java-worker.js')
    );
    assertCondition(
      javaLimitsWorker !== javaWorker &&
        javaLimitsWorker?.messages.at(-1)?.type === 'execute-code' &&
        javaLimitsWorker.terminated,
      'Java wall-clock-limited executeCode should send execute-code'
    );
    console.log('PASS: browser harness routes Java wall-clock-limited requests');

    const javaUnifiedBatchResult = await harnessA
      .getClient('java')
      .execute({
        code: 'class Solution { int add(int a, int b) { return a + b; } }',
        functionName: 'add',
        executionStyle: 'function',
        cases: [
          { id: 'a', inputs: { a: 1, b: 2 }, expected: { a: 1, b: 2 } },
          { id: 'b', inputs: { a: 3, b: 4 }, expected: { a: 3, b: 4 } },
        ],
      });
    assertCondition(javaUnifiedBatchResult.success, 'Java unified execute should route multi-case run requests');
    const javaBatchWorker = workerInstances.findLast((worker) =>
      String(worker.url).startsWith('/instance-a/java-worker.js')
    );
    assertCondition(
      javaBatchWorker !== javaLimitsWorker &&
        javaBatchWorker?.messages.at(-1)?.type === 'execute-code-batch' &&
        javaBatchWorker.terminated,
      'Java unified execute should send execute-code-batch for multi-case run requests'
    );
    console.log('PASS: browser harness routes Java unified batch execute');

    const javaProjectExecute = await harnessA
      .getClient('java')
      .execute({
        kind: 'project',
        code: '',
        source: 'run' as unknown as import('../packages/harness-core/src/runtime-project').RuntimeProjectCommandSource,
        scriptPath: 'Main',
        args: [],
        cwd: '/home/user/project',
        env: {},
        project: {
          cwd: '/home/user/project',
          workspaceRoot: '/home/user/project',
          workspaceAlias: '/workspace',
          files: [{ path: 'Main.java', contents: 'class Main {}\n' }],
        },
      });
    assertCondition(javaProjectExecute.exitCode === 0, 'Java unified execute should route project requests');
    const javaProjectWorker = workerInstances.findLast((worker) =>
      String(worker.url).startsWith('/instance-a/java-worker.js')
    );
    assertCondition(
      javaProjectWorker !== javaBatchWorker &&
        javaProjectWorker?.messages.at(-1)?.type === 'execute-project-java' &&
        javaProjectWorker.terminated,
      'Java unified execute should send execute-project-java for project requests'
    );
    console.log('PASS: browser harness routes Java unified project execute');

    const csharpExecuteResult = await harnessA
      .getClient('csharp')
      .executeCode({ code: 'public class Solution { public int Add(int a, int b) => a + b; }', functionName: 'Add', inputs: { a: 2, b: 3 }, executionStyle: 'solution-method' });
    assertCondition(csharpExecuteResult.kind === 'completed', 'C# runtime should route solution-method executeCode through the browser harness client');
    console.log('PASS: browser harness routes C# runtime requests');

    const csharpTraceResult = await harnessA
      .getClient('csharp')
      .executeWithTracing({ code: 'public class Solution { public int Add(int a, int b) { return a + b; } }', functionName: 'Add', inputs: { a: 2, b: 3 }, traceOptions: { maxTraceSteps: 10 }, executionStyle: 'solution-method' });
    assertCondition(csharpTraceResult.kind === 'completed', 'C# runtime should route executeWithTracing through the browser harness client');
    assertCondition(csharpTraceResult.trace.language === 'csharp', 'C# runtime should adapt worker events into a C# runtime trace');
    console.log('PASS: browser harness routes C# tracing requests');

    const csharpOpsClassResult = await harnessA
      .getClient('csharp')
      .executeCode({ code: 'public class Counter { public Counter(int start) {} public int Inc(int delta) => delta; }', functionName: 'Counter', inputs: { operations: ['Counter', 'Inc'], arguments: [[1], [2]] }, executionStyle: 'ops-class' });
    assertCondition(csharpOpsClassResult.kind === 'completed', 'C# runtime should route ops-class executeCode through the browser harness client');
    console.log('PASS: browser harness routes C# ops-class requests');

    const csharpLimitsResult = await harnessA
      .getClient('csharp')
      .executeCode({ code: 'public class Solution { public int Add(int a, int b) { return a + b; } }', functionName: 'Add', inputs: { a: 2, b: 3 }, executionStyle: 'solution-method', limits: { wallClockMs: 5_000 } });
    assertCondition(csharpLimitsResult.kind === 'completed', 'C# runtime should route wall-clock-limited requests');
    console.log('PASS: browser harness routes C# wall-clock-limited requests');

    const csharpBatchResult = await harnessA
      .getClient('csharp')
      .execute({
        code: 'public class Solution { public int Add(int a, int b) { return a + b; } }',
        functionName: 'Add',
        executionStyle: 'solution-method',
        cases: [
          { id: 'a', inputs: { a: 1, b: 2 }, expected: { a: 1, b: 2 } },
          { id: 'b', inputs: { a: 3, b: 4 }, expected: { a: 3, b: 4 } },
        ],
      });
    assertCondition(csharpBatchResult.success, 'C# unified execute should route multi-case run requests');
    const csharpWorker = [...workerInstances].reverse().find((worker) => String(worker.url).startsWith('/instance-a/csharp-worker.js'));
    assertCondition(
      csharpWorker?.messages.at(-1)?.type === 'execute-code-batch',
      'C# unified execute should send execute-code-batch for multi-case run requests'
    );
    console.log('PASS: browser harness routes C# unified batch execute');

    const activeCSharpWorker = [...workerInstances]
      .reverse()
      .find((worker) => String(worker.url).startsWith('/instance-a/csharp-worker.js'));
    harnessA.disposeLanguage('csharp');
    assertCondition(Boolean(activeCSharpWorker?.terminated), 'disposeLanguage should terminate the C# worker');
    console.log('PASS: browser harness disposeLanguage terminates C# runtime');

    const cppExecuteResult = await harnessA
      .getClient('cpp')
      .executeCode({ code: 'class Solution { public: int add(int a, int b) { return a + b; } };', functionName: 'add', inputs: {}, executionStyle: 'solution-method' });
    assertCondition(cppExecuteResult.kind === 'completed', 'C++ runtime should route solution-method executeCode through the browser harness client');
    const cppTraceResult = await harnessA
      .getClient('cpp')
      .executeWithTracing({ code: 'class Solution { public: int add(int a, int b) { return a + b; } };', functionName: 'add', inputs: {}, traceOptions: {}, executionStyle: 'solution-method' });
    assertCondition(cppTraceResult.kind === 'completed', 'C++ runtime should route solution-method executeWithTracing through the browser harness client');
    const cppScriptResult = await harnessA
      .getClient('cpp')
      .executeCode({ code: 'int result = 3;', functionName: '', inputs: {}, executionStyle: 'function' });
    assertCondition(cppScriptResult.kind === 'completed', 'C++ runtime should route script-style executeCode through the browser harness client');
    const cppLimitsResult = await harnessA
      .getClient('cpp')
      .executeCode({ code: 'int result = 3;', functionName: '', inputs: {}, executionStyle: 'function', limits: { wallClockMs: 5_000 } });
    assertCondition(cppLimitsResult.kind === 'completed', 'C++ runtime should route wall-clock-limited requests');
    const cppBatchResult = await harnessA
      .getClient('cpp')
      .execute({
        code: 'class Solution { public: int add(int a, int b) { return a + b; } };',
        functionName: 'add',
        executionStyle: 'solution-method',
        cases: [
          { id: 'a', inputs: { a: 1, b: 2 }, expected: { a: 1, b: 2 } },
          { id: 'b', inputs: { a: 3, b: 4 }, expected: { a: 3, b: 4 } },
        ],
      });
    assertCondition(cppBatchResult.success, 'C++ unified execute should route multi-case run requests');
    const activeCppWorker = [...workerInstances].reverse().find(
      (worker) =>
        String(worker.url).startsWith('/instance-a/cpp-worker.js') &&
        worker.messages.some((message) => message.type === 'compile-run-batch')
    );
    assertCondition(
      activeCppWorker?.messages.at(-1)?.type === 'compile-run-batch',
      'C++ unified execute should send compile-run-batch for multi-case run requests'
    );
    console.log('PASS: browser harness routes C++ runtime requests');

    class HangingCppWorker extends MockWorker {
      postMessage(message: WorkerMessage): void {
        const payload = message.payload as { code?: string } | undefined;
        if (
          (message.type === 'compile-run' || message.type === 'execute-with-tracing') &&
          payload?.code?.includes('while(true)')
        ) {
          return;
        }
        super.postMessage(message);
      }
    }

    const beforeTimeoutWorkerCount = workerInstances.length;
    // @ts-expect-error test stub
    globalThis.Worker = HangingCppWorker;
    const timeoutClient = new CppWorkerClient({
      workerUrl: '/workers/cpp-worker.js',
      clangWasmUrl: '/workers/vendor/cpp/clang.wasm',
      lldWasmUrl: '/workers/vendor/cpp/lld.wasm',
      sysrootUrl: '/workers/vendor/cpp/sysroot.tar',
      runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
      compilerBundleUrl: '/workers/vendor/cpp/yowasp/bundle.js',
      executionTimeoutMs: 5,
    });
    const timeoutResult = await timeoutClient.executeCode({ code: 'class Solution { public: int add(int a, int b) { while(true){} return a + b; } };', functionName: 'add', inputs: { a: 1, b: 2 }, executionStyle: 'solution-method' });
    assertCondition(timeoutResult.kind === 'limit', 'C++ client timeout should return a limit outcome');
    assertCondition(
      timeoutResult.kind === 'limit' && timeoutResult.error.includes('timed out'),
      `C++ client timeout should explain the timeout, received ${JSON.stringify(timeoutResult)}`
    );
    assertCondition(
      timeoutResult.kind === 'limit' && timeoutResult.reason === 'client-timeout',
      'C++ client timeout should carry client-timeout reason'
    );
    assertCondition(workerInstances[beforeTimeoutWorkerCount]?.terminated === true, 'C++ client timeout should terminate the stuck worker');
    const recoveryResult = await timeoutClient.executeCode({ code: 'class Solution { public: int add(int a, int b) { return a + b; } };', functionName: 'add', inputs: { a: 1, b: 2 }, executionStyle: 'solution-method' });
    assertCondition(recoveryResult.kind === 'completed', 'C++ client should recover by creating a fresh worker after timeout');

    const traceTimeoutClient = new CppWorkerClient({
      workerUrl: '/workers/cpp-worker.js',
      clangWasmUrl: '/workers/vendor/cpp/clang.wasm',
      lldWasmUrl: '/workers/vendor/cpp/lld.wasm',
      sysrootUrl: '/workers/vendor/cpp/sysroot.tar',
      runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
      compilerBundleUrl: '/workers/vendor/cpp/yowasp/bundle.js',
      tracingTimeoutMs: 5,
    });
    const traceTimeoutResult = await traceTimeoutClient.executeWithTracing({ code: 'class Solution { public: int add(int a, int b) { while(true){} return a + b; } };', functionName: 'add', inputs: { a: 1, b: 2 }, traceOptions: {}, executionStyle: 'solution-method' });
    assertCondition(
      traceTimeoutResult.kind === 'limit' && traceTimeoutResult.reason === 'client-timeout',
      'C++ tracing timeout should return a client-timeout limit outcome'
    );
    assertCondition(
      traceTimeoutResult.trace.events.some((event) => event.kind === 'timeout'),
      'C++ tracing timeout should include a timeout runtime event'
    );
    traceTimeoutClient.terminate();

    const wallClockLimitClient = new CppWorkerClient({
      workerUrl: '/workers/cpp-worker.js',
      clangWasmUrl: '/workers/vendor/cpp/clang.wasm',
      lldWasmUrl: '/workers/vendor/cpp/lld.wasm',
      sysrootUrl: '/workers/vendor/cpp/sysroot.tar',
      runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
      compilerBundleUrl: '/workers/vendor/cpp/yowasp/bundle.js',
    });
    const wallClockLimitTimeout = await wallClockLimitClient.executeCode({ code: 'class Solution { public: int add(int a, int b) { while(true){} return a + b; } };', functionName: 'add', inputs: { a: 1, b: 2 }, executionStyle: 'solution-method', limits: { wallClockMs: 5 } });
    assertCondition(
      wallClockLimitTimeout.kind === 'limit' && wallClockLimitTimeout.reason === 'client-timeout',
      'C++ wall-clock limit trip should carry the structured client-timeout reason'
    );
    assertCondition(
      wallClockLimitTimeout.kind === 'limit' && wallClockLimitTimeout.error.includes('timed out'),
      'C++ wall-clock limit trip should report a descriptive timeout error'
    );
    wallClockLimitClient.terminate();

    timeoutClient.terminate();
    // @ts-expect-error test stub
    globalThis.Worker = MockWorker;
    console.log('PASS: C++ worker client hard timeout terminates and recovers');

    harnessB.disposeLanguage('python');
    assertCondition(Boolean(survivingWorker?.terminated), 'disposeLanguage should terminate the targeted runtime');
    console.log('PASS: browser harness disposeLanguage terminates the targeted runtime');
  } finally {
    globalThis.Worker = originalWorker;
  }
}

test('browser harness', main);

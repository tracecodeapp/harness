#!/usr/bin/env npx tsx

import { createBrowserHarness, resolveBrowserHarnessAssets } from '../packages/harness-browser/src';
import { createBrowserProjectWorkspace } from '../packages/harness-browser/src/project';
import { CppWorkerClient } from '../packages/harness-browser/src/cpp-worker-client';
import { JavaWorkerClient } from '../packages/harness-browser/src/java-worker-client';
import { createRuntimeCommandStdinPipeFromText } from '../packages/harness-core/src/runtime-project';

function assertCondition(condition: boolean, message: string): void {
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
const JAVA_HTTP_SYNC_HEADER_BYTES = 8;

function testBase64(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

function testJavaHttpResponseManifest(status: number, headers: Record<string, string>, body: string): string {
  const headerLines = Object.entries(headers).map(([name, value]) => `${testBase64(name)}\t${testBase64(value)}`);
  return ['OK', String(status), String(headerLines.length), ...headerLines, testBase64(body)].join('\n');
}

const workerInstances: MockWorker[] = [];

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

      if (type === 'warmup') {
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

      if (type === 'execute-code' || type === 'execute-code-interview') {
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
        if (type === 'execute-project-java' && (payload as { scriptPath?: string } | undefined)?.scriptPath === 'HttpClient.java') {
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
        if (type === 'execute-project-java' && (payload as { scriptPath?: string } | undefined)?.scriptPath === 'HttpServer.java') {
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
      },
    });
    assertCondition(customAssets.pythonWorker === 'https://cdn.example.com/python-worker.js', 'Explicit asset URLs should be preserved');
    assertCondition(customAssets.cppClangWasm === 'https://cdn.example.com/cpp/clang.wasm', 'Explicit C++ asset URLs should be preserved');
    assertCondition(customAssets.cppCompilerFrame === '/sdk-assets/workers/cpp-compiler-frame.html', 'Relative custom C++ compiler frame should join assetBaseUrl');
    assertCondition(customAssets.cppCompilerWorker === '/sdk-assets/workers/cpp-compiler-worker.js', 'Relative custom C++ compiler worker should join assetBaseUrl');
    assertCondition(customAssets.cppCompilerBundle === 'https://cdn.example.com/cpp/bundle.js', 'Explicit C++ compiler bundle URLs should be preserved');
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

    const harnessA = createBrowserHarness({ assetBaseUrl: '/instance-a' });
    const harnessB = createBrowserHarness({ assetBaseUrl: '/instance-b', debug: true });
    assertCondition(harnessA.isLanguageSupported('java'), 'Browser harness should expose Java support');
    assertCondition(harnessA.isLanguageSupported('csharp'), 'Browser harness should expose C# support');
    assertCondition(harnessA.isLanguageSupported('cpp'), 'Browser harness should expose C++ support');
    const cppProfile = harnessA.getProfile('cpp');
    const csharpProfile = harnessA.getProfile('csharp');
    const typescriptInfo = harnessA.getLanguageInfo('typescript');
    const supportedInfos = harnessA.getSupportedLanguageInfos();
    assertCondition(csharpProfile.capabilities.execution.styles.interviewMode, 'C# profile should support interview-mode execution');
    assertCondition(cppProfile.capabilities.execution.styles.function, 'C++ profile should support function execution');
    assertCondition(cppProfile.capabilities.execution.styles.solutionMethod, 'C++ profile should support solution-method execution');
    assertCondition(cppProfile.capabilities.execution.styles.opsClass, 'C++ profile should support ops-class execution');
    assertCondition(cppProfile.capabilities.execution.styles.script, 'C++ profile should support script execution');
    assertCondition(cppProfile.capabilities.execution.styles.interviewMode, 'C++ profile should support interview-mode execution');
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
          void handler({
            method: 'POST',
            url: 'http://127.0.0.1:3210/queue?id=7',
            path: '/queue?id=7',
            headers: { 'content-type': 'text/plain' },
            body: 'work',
          }).then((response) => {
            javaServerExternalResponse = response;
          });
          void handler({
            method: 'GET',
            url: 'http://127.0.0.1:3210/busy',
            path: '/busy',
          }).then((response) => {
            javaServerQueuedResponse = response;
          });
          return {
            id: 'java-http-test',
            info: { id: 'java-http-test', host: options.host ?? '127.0.0.1', port: javaListenPort, url: `http://127.0.0.1:${javaListenPort}` },
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

    const cppWarmupResult = await harnessA.warmLanguage('cpp');
    const cppWarmupWorker = workerInstances.findLast((worker) => String(worker.url).startsWith('/instance-a/cpp-worker.js'));
    assertCondition(cppWarmupResult.success, 'C++ warmLanguage should resolve successfully');
    assertCondition(
      cppWarmupWorker?.messages.at(-1)?.type === 'warmup',
      'C++ warmLanguage should send the C++ warmup worker request'
    );
    console.log('PASS: browser harness warms C++ runtime on demand');

    const csharpWarmupResult = await harnessA.warmLanguage('csharp');
    const csharpWarmupWorker = workerInstances.findLast((worker) => String(worker.url).startsWith('/instance-a/csharp-worker.js'));
    assertCondition(csharpWarmupResult.success, 'C# warmLanguage should resolve successfully');
    assertCondition(
      csharpWarmupWorker?.messages.at(-1)?.type === 'warmup',
      'C# warmLanguage should send the C# warmup worker request'
    );
    console.log('PASS: browser harness warms C# runtime on demand');

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

    const executeResult = await harnessB.getClient('python').executeCode('result = 1', 'noop', {}, 'function');
    assertCondition(executeResult.success, 'Surviving harness instance should still execute after a peer is disposed');
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
    assertCondition(
      workerInstances.findLast((worker) => String(worker.url).startsWith('/instance-b/javascript-worker.js'))?.messages.at(-1)?.type === 'execute-code-batch',
      'JavaScript unified execute should send execute-code-batch for multi-case run requests'
    );
    console.log('PASS: browser harness instances are isolated');

    const javaExecuteResult = await harnessA
      .getClient('java')
      .executeCode('int search(int[] nums, int target) { return 0; }', 'search', {}, 'function');
    assertCondition(javaExecuteResult.success, 'Java runtime should route function-style executeCode through the browser harness client');
    const javaWorker = workerInstances.findLast((worker) => String(worker.url).startsWith('/instance-a/java-worker.js'));
    assertCondition(
      javaWorker?.messages.at(-1)?.type === 'execute-code',
      'Java executeCode should send execute-code instead of execute-with-tracing'
    );
    console.log('PASS: browser harness routes Java runtime requests');

    const javaInterviewResult = await harnessA
      .getClient('java')
      .executeCodeInterviewMode('int search(int[] nums, int target) { return 0; }', 'search', {}, 'function');
    assertCondition(
      javaInterviewResult.success,
      'Java runtime should route interview-mode executeCode through the browser harness client'
    );
    assertCondition(
      javaWorker?.messages.at(-1)?.type === 'execute-code-interview',
      'Java interview-mode executeCode should send execute-code-interview instead of execute-with-tracing'
    );
    console.log('PASS: browser harness routes Java interview-mode requests');

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
    assertCondition(
      javaWorker?.messages.at(-1)?.type === 'execute-code-batch',
      'Java unified execute should send execute-code-batch for multi-case run requests'
    );
    console.log('PASS: browser harness routes Java unified batch execute');

    const javaProjectExecute = await harnessA
      .getClient('java')
      .execute({
        kind: 'project',
        code: '',
        source: 'run',
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
    assertCondition(
      javaWorker?.messages.at(-1)?.type === 'execute-project-java',
      'Java unified execute should send execute-project-java for project requests'
    );
    console.log('PASS: browser harness routes Java unified project execute');

    const csharpExecuteResult = await harnessA
      .getClient('csharp')
      .executeCode('public class Solution { public int Add(int a, int b) => a + b; }', 'Add', { a: 2, b: 3 }, 'solution-method');
    assertCondition(csharpExecuteResult.success, 'C# runtime should route solution-method executeCode through the browser harness client');
    console.log('PASS: browser harness routes C# runtime requests');

    const csharpTraceResult = await harnessA
      .getClient('csharp')
      .executeWithTracing(
        'public class Solution { public int Add(int a, int b) { return a + b; } }',
        'Add',
        { a: 2, b: 3 },
        { maxTraceSteps: 10 },
        'solution-method'
      );
    assertCondition(csharpTraceResult.success, 'C# runtime should route executeWithTracing through the browser harness client');
    assertCondition(csharpTraceResult.trace.language === 'csharp', 'C# runtime should adapt worker events into a C# runtime trace');
    console.log('PASS: browser harness routes C# tracing requests');

    const csharpOpsClassResult = await harnessA
      .getClient('csharp')
      .executeCode(
        'public class Counter { public Counter(int start) {} public int Inc(int delta) => delta; }',
        'Counter',
        { operations: ['Counter', 'Inc'], arguments: [[1], [2]] },
        'ops-class'
      );
    assertCondition(csharpOpsClassResult.success, 'C# runtime should route ops-class executeCode through the browser harness client');
    console.log('PASS: browser harness routes C# ops-class requests');

    const csharpInterviewResult = await harnessA
      .getClient('csharp')
      .executeCodeInterviewMode(
        'public class Solution { public int Add(int a, int b) { return a + b; } }',
        'Add',
        { a: 2, b: 3 },
        'solution-method'
      );
    assertCondition(csharpInterviewResult.success, 'C# runtime should route interview-mode requests');
    console.log('PASS: browser harness routes C# interview-mode requests');

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
      .executeCode('class Solution { public: int add(int a, int b) { return a + b; } };', 'add', {}, 'solution-method');
    assertCondition(cppExecuteResult.success, 'C++ runtime should route solution-method executeCode through the browser harness client');
    const cppTraceResult = await harnessA
      .getClient('cpp')
      .executeWithTracing('class Solution { public: int add(int a, int b) { return a + b; } };', 'add', {}, {}, 'solution-method');
    assertCondition(cppTraceResult.success, 'C++ runtime should route solution-method executeWithTracing through the browser harness client');
    const cppScriptResult = await harnessA
      .getClient('cpp')
      .executeCode('int result = 3;', '', {}, 'function');
    assertCondition(cppScriptResult.success, 'C++ runtime should route script-style executeCode through the browser harness client');
    const cppInterviewResult = await harnessA
      .getClient('cpp')
      .executeCodeInterviewMode('int result = 3;', '', {}, 'function');
    assertCondition(cppInterviewResult.success, 'C++ runtime should route interview-mode requests');
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
    const activeCppWorker = [...workerInstances].reverse().find((worker) => String(worker.url).startsWith('/instance-a/cpp-worker.js'));
    assertCondition(
      activeCppWorker?.messages.at(-1)?.type === 'compile-run-batch',
      'C++ unified execute should send compile-run-batch for multi-case run requests'
    );
    console.log('PASS: browser harness routes C++ runtime requests');

    class HangingCppWorker extends MockWorker {
      postMessage(message: WorkerMessage): void {
        const payload = message.payload as { code?: string } | undefined;
        if (
          (message.type === 'compile-run' || message.type === 'execute-with-tracing' || message.type === 'execute-code-interview') &&
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
    const timeoutResult = await timeoutClient.executeCode(
      'class Solution { public: int add(int a, int b) { while(true){} return a + b; } };',
      'add',
      { a: 1, b: 2 },
      'solution-method'
    );
    assertCondition(timeoutResult.success === false, 'C++ client timeout should return a failed execution result');
    assertCondition(
      String(timeoutResult.error).includes('timed out'),
      `C++ client timeout should explain the timeout, received ${String(timeoutResult.error)}`
    );
    assertCondition(timeoutResult.timeoutReason === 'client-timeout', 'C++ client timeout should carry client-timeout reason');
    assertCondition(timeoutResult.diagnosticStage === 'runtime', 'C++ execute timeout should be labeled as runtime stage');
    assertCondition(workerInstances[beforeTimeoutWorkerCount]?.terminated === true, 'C++ client timeout should terminate the stuck worker');
    const recoveryResult = await timeoutClient.executeCode(
      'class Solution { public: int add(int a, int b) { return a + b; } };',
      'add',
      { a: 1, b: 2 },
      'solution-method'
    );
    assertCondition(recoveryResult.success, 'C++ client should recover by creating a fresh worker after timeout');

    const traceTimeoutClient = new CppWorkerClient({
      workerUrl: '/workers/cpp-worker.js',
      clangWasmUrl: '/workers/vendor/cpp/clang.wasm',
      lldWasmUrl: '/workers/vendor/cpp/lld.wasm',
      sysrootUrl: '/workers/vendor/cpp/sysroot.tar',
      runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
      compilerBundleUrl: '/workers/vendor/cpp/yowasp/bundle.js',
      tracingTimeoutMs: 5,
    });
    const traceTimeoutResult = await traceTimeoutClient.executeWithTracing(
      'class Solution { public: int add(int a, int b) { while(true){} return a + b; } };',
      'add',
      { a: 1, b: 2 },
      {},
      'solution-method'
    );
    assertCondition(traceTimeoutResult.success === false, 'C++ tracing timeout should return a failed execution result');
    assertCondition(traceTimeoutResult.timeoutReason === 'client-timeout', 'C++ tracing timeout should carry client-timeout reason');
    assertCondition(
      traceTimeoutResult.trace.events.some((event) => event.kind === 'timeout'),
      'C++ tracing timeout should include a timeout runtime event'
    );
    traceTimeoutClient.terminate();

    const interviewTimeoutClient = new CppWorkerClient({
      workerUrl: '/workers/cpp-worker.js',
      clangWasmUrl: '/workers/vendor/cpp/clang.wasm',
      lldWasmUrl: '/workers/vendor/cpp/lld.wasm',
      sysrootUrl: '/workers/vendor/cpp/sysroot.tar',
      runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
      compilerBundleUrl: '/workers/vendor/cpp/yowasp/bundle.js',
      interviewTimeoutMs: 5,
    });
    const interviewClientTimeout = await interviewTimeoutClient.executeCodeInterviewMode(
      'class Solution { public: int add(int a, int b) { while(true){} return a + b; } };',
      'add',
      { a: 1, b: 2 },
      'solution-method'
    );
    assertCondition(interviewClientTimeout.error === 'Time Limit Exceeded', 'C++ interview client timeout should be sanitized');
    assertCondition(
      interviewClientTimeout.timeoutReason === 'client-timeout',
      'C++ interview client timeout should preserve client-timeout reason'
    );
    assertCondition(interviewClientTimeout.diagnosticStage === 'interview', 'C++ interview timeout should be labeled as interview stage');
    interviewTimeoutClient.terminate();

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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

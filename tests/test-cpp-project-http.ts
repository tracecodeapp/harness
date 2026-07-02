#!/usr/bin/env npx tsx

// End-to-end C++ TraceKernel HTTP test in Node:
// - the real cpp-worker.js runs inside a node:worker_threads worker (via vm),
//   so its Atomics.wait-based sync HTTP bridge blocks a real separate thread;
// - the real CppWorkerClient drives it through a Worker shim;
// - project compiles run through the external-compiler-host path, serviced by
//   the real cpp-compiler-worker.js compile logic with the local @yowasp/clang
//   toolchain (which also proves tracecode_http.hpp is injected and compiles);
// - a stub RuntimeKernelHttpBridge stands in for the workspace kernel.

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { Worker as NodeWorker } from 'node:worker_threads';
import { CppWorkerClient } from '../packages/harness-browser/src/cpp-worker-client';
import type {
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpHandler,
  RuntimeKernelHttpListenOptions,
  RuntimeKernelHttpRequest,
} from '../packages/harness-core/src/runtime-project';

const EXTERNAL_COMPILER_URL = 'http://tracecode-cpp-test.invalid/compile';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function base64FromString(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function stringFromBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

const WORKER_BOOTSTRAP = String.raw`
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const repoRoot = workerData.repoRoot;
const sharedKernelPolicySource = (await readFile(repoRoot + '/workers/shared/runtime-kernel-policy.js', 'utf8'))
  .replace(/\bexport\s+/g, '');
const workerSource = (await readFile(repoRoot + '/workers/cpp/cpp-worker.js', 'utf8')).replace(
  /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/shared\/runtime-kernel-policy\.js['"];\s*/,
  ''
);

const readAsset = async (url) => {
  const pathname = String(url).replace('file://', '');
  const data = await readFile(pathname);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    text: async () => data.toString('utf8'),
  };
};

const sandbox = {
  console,
  URL,
  TextEncoder,
  TextDecoder,
  WebAssembly,
  Date,
  performance,
  ArrayBuffer,
  SharedArrayBuffer,
  Atomics,
  DataView,
  Uint8Array,
  Int32Array,
  BigInt,
  Map,
  Set,
  WeakMap,
  Error,
  TypeError,
  RangeError,
  JSON,
  Object,
  Array,
  Boolean,
  String,
  Number,
  Math,
  RegExp,
  Promise,
  Blob,
  Headers,
  Response,
  atob,
  btoa,
  setTimeout,
  clearTimeout,
  queueMicrotask,
  globalThis: null,
  self: null,
  location: new URL(pathToFileURL(repoRoot + '/workers/cpp/cpp-worker.js').href),
  postMessage: (message) => parentPort.postMessage(message),
  fetch: readAsset,
  crypto: globalThis.crypto,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const context = vm.createContext(sandbox);
const script = new vm.Script(
  sharedKernelPolicySource + '\n' +
    'const isRuntimeDeviceDirectory = isRuntimeKernelDeviceDirectory;\n' +
    'const isRuntimeDeviceNamespacePath = isRuntimeKernelDeviceNamespacePath;\n' +
    'const isRuntimeProcPath = isRuntimeKernelProcPath;\n' +
    workerSource,
  {
    importModuleDynamically(specifier) {
      return import(specifier);
    },
  }
);
await script.runInContext(context);

parentPort.on('message', (message) => {
  sandbox.onmessage?.({ data: message });
});
`;

interface CompileHost {
  compileProject(payload: unknown): Promise<{
    success?: boolean;
    error?: string;
    stdout?: string;
    stderr?: string;
    programBuffer?: ArrayBuffer;
  }>;
}

async function createCompileHost(): Promise<CompileHost> {
  const compilerSource = await readFile('workers/cpp/cpp-compiler-worker.js', 'utf8');
  const sandbox: Record<string, unknown> = {
    console,
    URL,
    TextEncoder,
    TextDecoder,
    WebAssembly,
    Date,
    performance,
    ArrayBuffer,
    DataView,
    Uint8Array,
    BigInt,
    Map,
    Set,
    Error,
    TypeError,
    JSON,
    Object,
    Array,
    String,
    Number,
    Math,
    RegExp,
    Promise,
    Blob,
    Headers,
    Response,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    globalThis: null,
    self: null,
    location: new URL(pathToFileURL(join(process.cwd(), 'workers/cpp/cpp-compiler-worker.js')).href),
    postMessage: () => {},
    fetch: async (url: string) => {
      const pathname = String(url).replace('file://', '');
      const data = await readFile(pathname);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        text: async () => data.toString('utf8'),
      };
    },
    crypto: globalThis.crypto,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  const script = new vm.Script(
    `${compilerSource}\nglobalThis.__tracecodeCompileProject = compileProjectWithYowasp;`,
    {
      // @ts-expect-error importModuleDynamically is supported at runtime
      importModuleDynamically(specifier: string) {
        return import(specifier);
      },
    }
  );
  script.runInContext(context);
  const compileProject = (sandbox as { __tracecodeCompileProject?: (payload: unknown) => Promise<never> }).__tracecodeCompileProject;
  if (typeof compileProject !== 'function') {
    throw new Error('cpp-compiler-worker.js did not expose compileProjectWithYowasp');
  }
  return { compileProject };
}

const CPP_HTTP_PROGRAM = [
  '#include "tracecode_http.hpp"',
  '#include <cstdio>',
  '',
  'int main() {',
  '  tracecode::http::Request request;',
  '  request.method = "POST";',
  '  request.url = "http://localhost:3300/echo?x=1";',
  '  request.headers.push_back(tracecode::http::Header{"x-cpp", "yes"});',
  '  request.body = "cpp-body";',
  '  auto response = tracecode::http::fetch(request);',
  '  std::printf("fetch:%d:%s:%s\\n", response.status, response.header("X-Echo").c_str(), response.body.c_str());',
  '',
  '  auto server = tracecode::http::Server::listen(3999);',
  '  if (!server) {',
  '    std::printf("listen-error:%s\\n", server.error().c_str());',
  '    return 1;',
  '  }',
  '  std::printf("listening:%d:%s\\n", server.port(), server.host().c_str());',
  '  for (int index = 0; index < 2; index += 1) {',
  '    auto incoming = server.next(20000);',
  '    if (!incoming) {',
  '      std::printf("next-error:%s\\n", incoming.error.c_str());',
  '      return 1;',
  '    }',
  '    std::printf("request:%s:%s:%s\\n", incoming.method.c_str(), incoming.path.c_str(), incoming.body.c_str());',
  '    tracecode::http::Response reply;',
  '    reply.status = 200 + index;',
  '    reply.headers.push_back(tracecode::http::Header{"x-cpp-server", "ok"});',
  '    reply.body = "reply-" + std::to_string(index) + ":" + incoming.header("x-req");',
  '    if (!server.respond(reply)) {',
  '      std::printf("respond-error\\n");',
  '      return 1;',
  '    }',
  '  }',
  '  server.close();',
  '  std::printf("done\\n");',
  '  return 0;',
  '}',
  '',
].join('\n');

async function main(): Promise<void> {
  // vm dynamic import (used to load the @yowasp/clang bundle) requires
  // --experimental-vm-modules; re-exec once with the flag so worker threads
  // inherit it through execArgv.
  if (
    !process.execArgv.includes('--experimental-vm-modules') &&
    !(process.env.NODE_OPTIONS ?? '').includes('--experimental-vm-modules')
  ) {
    execFileSync(
      process.execPath,
      ['--experimental-vm-modules', '--import', 'tsx', fileURLToPath(import.meta.url)],
      { cwd: process.cwd(), stdio: 'inherit', maxBuffer: 32 * 1024 * 1024 }
    );
    return;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-cpp-http-'));
  const bootstrapPath = join(tempRoot, 'cpp-worker-thread.mjs');
  await writeFile(bootstrapPath, WORKER_BOOTSTRAP, 'utf8');

  const compileHost = await createCompileHost();
  const originalFetch = globalThis.fetch;
  const nodeWorkers: NodeWorker[] = [];

  class WorkerShim {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    private readonly worker: NodeWorker;

    constructor(_url: string | URL, _options?: unknown) {
      this.worker = new NodeWorker(bootstrapPath, { workerData: { repoRoot: process.cwd() } });
      nodeWorkers.push(this.worker);
      this.worker.on('message', (data) => this.onmessage?.({ data }));
      this.worker.on('error', (error) => {
        this.onerror?.({ message: error instanceof Error ? error.message : String(error) });
      });
    }

    postMessage(message: unknown): void {
      this.worker.postMessage(message);
    }

    terminate(): void {
      void this.worker.terminate();
    }
  }

  const previousWorker = (globalThis as typeof globalThis & { Worker?: unknown }).Worker;
  (globalThis as typeof globalThis & { Worker?: unknown }).Worker = WorkerShim;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === EXTERNAL_COMPILER_URL) {
      const payload = JSON.parse(String(init?.body ?? '{}')) as unknown;
      const result = await compileHost.compileProject(payload);
      if (result?.success && result.programBuffer instanceof ArrayBuffer) {
        return new Response(result.programBuffer, {
          status: 200,
          headers: { 'content-type': 'application/wasm' },
        });
      }
      return new Response(JSON.stringify(result ?? { success: false, error: 'C++ test compile failed' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(input as never, init);
  }) as typeof fetch;

  const client = new CppWorkerClient({
    workerUrl: 'cpp-worker.js',
    debug: false,
    clangWasmUrl: 'file:///missing/clang.wasm',
    lldWasmUrl: 'file:///missing/lld.wasm',
    sysrootUrl: 'file:///missing/sysroot.tar',
    runtimeHeaderUrl: pathToFileURL(join(process.cwd(), 'workers/cpp/tracecode_runtime.hpp')).href,
    compilerBundleUrl: pathToFileURL(join(process.cwd(), 'node_modules/@yowasp/clang/gen/bundle.js')).href,
    externalCompilerUrl: EXTERNAL_COMPILER_URL,
  });

  try {
    const projectFiles = [{ path: 'main.cpp', contents: CPP_HTTP_PROGRAM }];
    const compileResult = await client.executeProjectCpp({
      code: '',
      source: 'compile',
      scriptPath: 'main.cpp',
      args: ['main.cpp', '-o', 'a.out'],
      cwd: '/workspace',
      env: {},
      project: { files: projectFiles },
    }, 300_000);
    assertCondition(
      compileResult.exitCode === 0,
      `C++ HTTP program should compile against the injected tracecode_http.hpp: ${JSON.stringify({
        exitCode: compileResult.exitCode,
        stdout: compileResult.stdout,
        stderr: compileResult.stderr,
      })}`
    );
    const compiledFiles = compileResult.files ?? [];
    assertCondition(
      compiledFiles.some((file) => file.path === 'a.out'),
      `C++ HTTP compile should emit a.out: ${JSON.stringify(compiledFiles.map((file) => file.path))}`
    );
    console.log('PASS: tracecode_http.hpp is injected into C++ project compiles and compiles cleanly');

    const dispatched: Array<RuntimeKernelHttpRequest & { timeoutMs?: number }> = [];
    let listenerHandler: RuntimeKernelHttpHandler | undefined;
    let listenerOptions: RuntimeKernelHttpListenOptions | undefined;
    let listenerClosed = false;
    const kernelHttp: RuntimeKernelHttpBridge = {
      listen(options, handler) {
        listenerOptions = options;
        listenerHandler = handler;
        return {
          id: 'cpp-e2e-listener',
          info: {
            id: 'cpp-e2e-listener',
            pid: 0,
            host: options.host ?? '127.0.0.1',
            port: options.port,
            protocol: 'http',
            startedAt: '2026-07-02T00:00:00.000Z',
          },
          close() {
            listenerClosed = true;
          },
        };
      },
      async dispatch(request, options) {
        dispatched.push({ ...request, ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
        return {
          status: 209,
          headers: { 'x-echo': request.headers?.['x-cpp'] ?? '' },
          body: `dispatch:${request.method}:${request.path}:${request.body !== undefined ? stringFromBase64(request.body) : ''}`,
        };
      },
    };

    const runPromise = client.executeProjectCpp({
      code: '',
      source: 'run',
      scriptPath: './a.out',
      args: [],
      cwd: '/workspace',
      env: {},
      project: { files: [...projectFiles, ...compiledFiles] },
      kernelHttp,
    }, 120_000);

    const listenerReady = (async () => {
      for (let attempt = 0; attempt < 2_000; attempt += 1) {
        if (listenerHandler) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('C++ program did not register a TraceKernel HTTP listener in time');
    })();
    await Promise.race([listenerReady, runPromise.then((result) => {
      throw new Error(`C++ program exited before registering a listener: ${JSON.stringify(result)}`);
    })]);

    const firstResponse = await listenerHandler!({
      method: 'POST',
      url: 'http://127.0.0.1:3999/task?id=1',
      path: '/task?id=1',
      headers: { 'x-req': 'one' },
      body: 'payload-1',
    });
    const secondResponse = await listenerHandler!({
      method: 'GET',
      url: 'http://127.0.0.1:3999/status',
      path: '/status',
      headers: { 'x-req': 'two' },
    });
    const runResult = await runPromise;

    assertCondition(
      runResult.exitCode === 0,
      `C++ HTTP program should exit cleanly: ${JSON.stringify({ exitCode: runResult.exitCode, stdout: runResult.stdout, stderr: runResult.stderr })}`
    );
    const expectedStdout = [
      'fetch:209:yes:dispatch:POST:/echo?x=1:cpp-body',
      'listening:3999:127.0.0.1',
      'request:POST:/task?id=1:payload-1',
      'request:GET:/status:',
      'done',
      '',
    ].join('\n');
    assertCondition(
      runResult.stdout === expectedStdout,
      `C++ HTTP program stdout mismatch:\n--- expected ---\n${expectedStdout}\n--- actual ---\n${runResult.stdout}\n--- stderr ---\n${runResult.stderr}`
    );
    console.log('PASS: C++ program dispatches TraceKernel HTTP requests and observes host responses');

    assertCondition(dispatched.length === 1, `C++ program should dispatch exactly one outbound request: ${JSON.stringify(dispatched)}`);
    const outbound = dispatched[0]!;
    assertCondition(
      outbound.method === 'POST' &&
        outbound.url === 'http://localhost:3300/echo?x=1' &&
        outbound.path === '/echo?x=1' &&
        outbound.headers?.['x-cpp'] === 'yes' &&
        outbound.bodyEncoding === 'base64' &&
        outbound.body === base64FromString('cpp-body'),
      `C++ outbound request should carry method/url/headers/body through the bridge: ${JSON.stringify(outbound)}`
    );
    console.log('PASS: C++ outbound requests reach the host RuntimeKernelHttpBridge intact');

    assertCondition(
      listenerOptions?.port === 3999 && (listenerOptions?.host ?? '127.0.0.1') === '127.0.0.1',
      `C++ listener should register host/port with the bridge: ${JSON.stringify(listenerOptions)}`
    );
    assertCondition(
      firstResponse.status === 200 &&
        firstResponse.bodyEncoding === 'base64' &&
        firstResponse.body === base64FromString('reply-0:one') &&
        firstResponse.headers?.['x-cpp-server'] === 'ok',
      `first C++ server response mismatch: ${JSON.stringify(firstResponse)}`
    );
    assertCondition(
      secondResponse.status === 201 &&
        secondResponse.bodyEncoding === 'base64' &&
        secondResponse.body === base64FromString('reply-1:two'),
      `second C++ server response mismatch: ${JSON.stringify(secondResponse)}`
    );
    assertCondition(listenerClosed, 'C++ Server::close should close the host listener handle');
    console.log('PASS: C++ in-workspace HTTP listener serves sequential requests over the sync bridge');
  } finally {
    client.terminate();
    globalThis.fetch = originalFetch;
    if (previousWorker === undefined) {
      delete (globalThis as typeof globalThis & { Worker?: unknown }).Worker;
    } else {
      (globalThis as typeof globalThis & { Worker?: unknown }).Worker = previousWorker;
    }
    await Promise.all(nodeWorkers.map((worker) => worker.terminate().catch(() => {})));
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();

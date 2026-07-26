#!/usr/bin/env npx tsx

// End-to-end C++ TraceKernel HTTP test in Node:
// - the real cpp-worker.js runs inside a node:worker_threads worker (via vm),
//   so its Atomics.wait-based sync HTTP bridge blocks a real separate thread;
// - the real CppWorkerClient drives it through a Worker shim;
// - project compiles run through the external-compiler-host path, serviced by
//   the real cpp-compiler-worker.js compile logic with the local @yowasp/clang
//   toolchain (which also proves tracecode_http.hpp is injected and compiles);
// - a stub RuntimeKernelHttpBridge stands in for the workspace kernel.

import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { Worker as NodeWorker } from 'node:worker_threads';
import { CppWorkerClient } from '../packages/harness-browser/src/cpp-worker-client';
import { createBrowserCppProjectRunner } from '../packages/harness-cpp/src/project-browser';
import { createBrowserJavaScriptProjectRunner } from '../packages/harness-javascript/src/project-browser';
import { createRuntimeWorkspace } from '../packages/harness-project/src/index';
import type {
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpHandler,
  RuntimeKernelHttpListenOptions,
  RuntimeKernelHttpRequest,
} from '../packages/harness-core/src/runtime-project';

const EXTERNAL_COMPILER_URL = 'http://tracecode-cpp-test.invalid/compile';

const CPP_TKFS_PROGRAM = [
  '#include <fstream>',
  '#include <iostream>',
  '#include <iterator>',
  '#include <string>',
  'int main() {',
  '  std::ifstream input("seed.txt", std::ios::binary);',
  '  std::string seed((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());',
  '  std::ofstream output("generated.txt", std::ios::binary | std::ios::trunc);',
  '  output << "kernel-write";',
  '  output.close();',
  '  std::cout << seed;',
  '  return 0;',
  '}',
  '',
].join('\n');

const CPP_TK_TCP_PROGRAM = [
  '#include <arpa/inet.h>',
  '#include <netinet/in.h>',
  '#include <sys/socket.h>',
  '#include <unistd.h>',
  '#include <cerrno>',
  '#include <cstdio>',
  '#include <cstring>',
  'int main() {',
  '  int server = socket(AF_INET, SOCK_STREAM, 0);',
  '  sockaddr_in address {};',
  '  address.sin_family = AF_INET;',
  '  address.sin_port = htons(41234);',
  '  address.sin_addr.s_addr = inet_addr("127.0.0.1");',
  '  int bindResult = bind(server, reinterpret_cast<sockaddr*>(&address), sizeof(address));',
  '  int bindErrno = errno;',
  '  int listenResult = bindResult == 0 ? listen(server, 4) : -1;',
  '  int listenErrno = errno;',
  '  if (bindResult != 0 || listenResult != 0) { std::printf("bind:%d:%d listen:%d:%d\\n", bindResult, bindErrno, listenResult, listenErrno); return 1; }',
  '  int client = socket(AF_INET, SOCK_STREAM, 0);',
  '  if (connect(client, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) return 2;',
  '  int peer = accept(server, nullptr, nullptr);',
  '  if (peer < 0) return 3;',
  '  if (send(client, "ping", 4, 0) != 4) return 4;',
  '  char request[5] = {};',
  '  if (recv(peer, request, 4, 0) != 4) return 5;',
  '  if (send(peer, "pong", 4, 0) != 4) return 6;',
  '  char response[5] = {};',
  '  if (recv(client, response, 4, 0) != 4) return 7;',
  '  std::printf("%s:%s\\n", request, response);',
  '  close(peer); close(client); close(server);',
  '  return 0;',
  '}',
  '',
].join('\n');

const CPP_CROSS_LANGUAGE_FS_PROGRAM = [
  '#include <fcntl.h>',
  '#include <sys/stat.h>',
  '#include <unistd.h>',
  '#include <chrono>',
  '#include <cstdio>',
  '#include <cstring>',
  '#include <string>',
  '',
  'static bool wait_for(const char* path) {',
  '  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);',
  '  struct stat info {};',
  '  while (std::chrono::steady_clock::now() < deadline) {',
  '    if (stat(path, &info) == 0) return true;',
  '  }',
  '  return false;',
  '}',
  '',
  'static bool write_all(const char* path, const char* value) {',
  '  const int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);',
  '  if (fd < 0) return false;',
  '  const size_t length = std::strlen(value);',
  '  const bool ok = write(fd, value, length) == static_cast<ssize_t>(length);',
  '  close(fd);',
  '  return ok;',
  '}',
  '',
  'int main(int argc, char** argv) {',
  '  const std::string mode = argc > 1 ? argv[1] : "";',
  '  if (mode == "watch-js") {',
  '    const int fd = open("cpp-watches.txt", O_RDONLY);',
  '    if (fd < 0 || !write_all("cpp-ready.txt", "ready")) return 10;',
  '    if (!wait_for("js-done.txt")) return 11;',
  '    char buffer[64] = {};',
  '    const ssize_t count = pread(fd, buffer, sizeof(buffer) - 1, 0);',
  '    close(fd);',
  '    if (count < 0) return 12;',
  '    std::printf("cpp-observed:%s\\n", buffer);',
  '    return 0;',
  '  }',
  '  if (mode == "write-js") {',
  '    if (!wait_for("js-ready.txt")) return 20;',
  '    if (!write_all("js-watches.txt", "from-cpp")) return 21;',
  '    if (!write_all("cpp-done.txt", "done")) return 22;',
  '    std::printf("cpp-wrote\\n");',
  '    return 0;',
  '  }',
  '  return 2;',
  '}',
  '',
].join('\n');

function assertCondition(condition: unknown, message: string): asserts condition {
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

const JAVASCRIPT_WORKER_BOOTSTRAP = String.raw`
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

globalThis.self = globalThis;
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
self.postMessage = globalThis.postMessage;

const queued = [];
parentPort.on('message', (message) => {
  if (typeof self.onmessage === 'function') {
    self.onmessage({ data: message });
  } else {
    queued.push(message);
  }
});

await import(pathToFileURL(workerData.workerPath).href);
for (const message of queued.splice(0)) {
  self.onmessage?.({ data: message });
}
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

// Plain POSIX sockets only — no TraceCode-specific API. The program performs
// a loopback HTTP request, a named-host request through getaddrinfo, and then
// serves two HTTP requests from a hand-rolled socket server.
const CPP_HTTP_PROGRAM = [
  '#include <arpa/inet.h>',
  '#include <netdb.h>',
  '#include <netinet/in.h>',
  '#include <sys/socket.h>',
  '#include <unistd.h>',
  '#include <cstdio>',
  '#include <cstdlib>',
  '#include <cstring>',
  '#include <string>',
  '',
  'static std::string http_exchange(int fd, const std::string& request) {',
  '  const char* data = request.c_str();',
  '  size_t remaining = request.size();',
  '  while (remaining > 0) {',
  '    ssize_t sent = send(fd, data, remaining, 0);',
  '    if (sent <= 0) return "";',
  '    data += sent;',
  '    remaining -= (size_t)sent;',
  '  }',
  '  std::string response;',
  '  char buffer[512];',
  '  while (true) {',
  '    ssize_t got = recv(fd, buffer, sizeof(buffer), 0);',
  '    if (got <= 0) break;',
  '    response.append(buffer, (size_t)got);',
  '  }',
  '  return response;',
  '}',
  '',
  'static std::string status_line(const std::string& response) {',
  '  size_t end = response.find("\\r\\n");',
  '  return end == std::string::npos ? response : response.substr(0, end);',
  '}',
  '',
  'static std::string body_of(const std::string& response) {',
  '  size_t split = response.find("\\r\\n\\r\\n");',
  '  return split == std::string::npos ? std::string() : response.substr(split + 4);',
  '}',
  '',
  'int main() {',
  '  int fd = socket(AF_INET, SOCK_STREAM, 0);',
  '  sockaddr_in loopback {};',
  '  loopback.sin_family = AF_INET;',
  '  loopback.sin_port = htons(3300);',
  '  loopback.sin_addr.s_addr = inet_addr("127.0.0.1");',
  '  if (connect(fd, reinterpret_cast<sockaddr*>(&loopback), sizeof(loopback)) != 0) {',
  '    std::printf("connect-failed\\n");',
  '    return 1;',
  '  }',
  '  std::string response = http_exchange(fd,',
  '    "POST /echo?x=1 HTTP/1.1\\r\\n"',
  '    "Host: localhost:3300\\r\\n"',
  '    "X-Cpp: yes\\r\\n"',
  '    "Content-Length: 8\\r\\n"',
  '    "\\r\\n"',
  '    "cpp-body");',
  '  close(fd);',
  '  std::printf("loopback:%s:%s\\n", status_line(response).c_str(), body_of(response).c_str());',
  '',
  '  addrinfo hints {};',
  '  hints.ai_family = AF_INET;',
  '  hints.ai_socktype = SOCK_STREAM;',
  '  addrinfo* resolved = nullptr;',
  '  if (getaddrinfo("api.example.com", "http", &hints, &resolved) != 0 || resolved == nullptr) {',
  '    std::printf("resolve-failed\\n");',
  '    return 1;',
  '  }',
  '  int external = socket(resolved->ai_family, resolved->ai_socktype, 0);',
  '  if (connect(external, resolved->ai_addr, resolved->ai_addrlen) != 0) {',
  '    std::printf("external-connect-failed\\n");',
  '    return 1;',
  '  }',
  '  freeaddrinfo(resolved);',
  '  std::string externalResponse = http_exchange(external,',
  '    "GET /status HTTP/1.1\\r\\nHost: api.example.com\\r\\n\\r\\n");',
  '  close(external);',
  '  std::printf("external:%s:%s\\n", status_line(externalResponse).c_str(), body_of(externalResponse).c_str());',
  '',
  '  int server = socket(AF_INET, SOCK_STREAM, 0);',
  '  sockaddr_in bindAddress {};',
  '  bindAddress.sin_family = AF_INET;',
  '  bindAddress.sin_port = htons(3999);',
  '  bindAddress.sin_addr.s_addr = htonl(INADDR_ANY);',
  '  if (bind(server, reinterpret_cast<sockaddr*>(&bindAddress), sizeof(bindAddress)) != 0) {',
  '    std::printf("bind-failed\\n");',
  '    return 1;',
  '  }',
  '  if (listen(server, 4) != 0) {',
  '    std::printf("listen-failed\\n");',
  '    return 1;',
  '  }',
  '  sockaddr_in boundAddress {};',
  '  unsigned int boundLength = sizeof(boundAddress);',
  '  getsockname(server, reinterpret_cast<sockaddr*>(&boundAddress), &boundLength);',
  '  std::printf("listening:%d\\n", (int)ntohs(boundAddress.sin_port));',
  '',
  '  for (int index = 0; index < 2; index += 1) {',
  '    int conn = accept(server, nullptr, nullptr);',
  '    if (conn < 0) {',
  '      std::printf("accept-failed\\n");',
  '      return 1;',
  '    }',
  '    std::string request;',
  '    char buffer[512];',
  '    while (true) {',
  '      size_t headEnd = request.find("\\r\\n\\r\\n");',
  '      if (headEnd != std::string::npos) {',
  '        size_t contentLength = 0;',
  '        size_t marker = request.find("Content-Length:");',
  '        if (marker == std::string::npos) marker = request.find("content-length:");',
  '        if (marker != std::string::npos) contentLength = (size_t)atoi(request.c_str() + marker + 15);',
  '        if (request.size() >= headEnd + 4 + contentLength) break;',
  '      }',
  '      ssize_t got = recv(conn, buffer, sizeof(buffer), 0);',
  '      if (got <= 0) break;',
  '      request.append(buffer, (size_t)got);',
  '    }',
  '    std::string requestLine = request.substr(0, request.find("\\r\\n"));',
  '    std::string xreq;',
  '    size_t xreqAt = request.find("x-req: ");',
  '    if (xreqAt != std::string::npos) {',
  '      size_t lineEnd = request.find("\\r\\n", xreqAt);',
  '      xreq = request.substr(xreqAt + 7, lineEnd - xreqAt - 7);',
  '    }',
  '    std::string requestBody = body_of(request);',
  '    std::printf("request:%s:%s:%s\\n", requestLine.c_str(), xreq.c_str(), requestBody.c_str());',
  '    std::string responseBody = "reply-" + std::to_string(index) + ":" + xreq;',
  '    char head[256];',
  '    std::snprintf(head, sizeof(head),',
  '      "HTTP/1.1 %d OK\\r\\nContent-Type: text/plain\\r\\nX-Cpp-Server: ok\\r\\nContent-Length: %d\\r\\n\\r\\n",',
  '      200 + index, (int)responseBody.size());',
  '    std::string reply = std::string(head) + responseBody;',
  '    send(conn, reply.c_str(), reply.size(), 0);',
  '    close(conn);',
  '  }',
  '  close(server);',
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
  const javascriptBootstrapPath = join(tempRoot, 'javascript-worker-thread.mjs');
  await writeFile(bootstrapPath, WORKER_BOOTSTRAP, 'utf8');
  await writeFile(javascriptBootstrapPath, JAVASCRIPT_WORKER_BOOTSTRAP, 'utf8');

  const compileHost = await createCompileHost();
  const originalFetch = globalThis.fetch;
  const nodeWorkers: NodeWorker[] = [];

  class WorkerShim {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    private readonly worker: NodeWorker;

    constructor(url: string | URL, _options?: unknown) {
      const isJavaScriptWorker = String(url).includes('javascript-project-worker');
      this.worker = new NodeWorker(
        isJavaScriptWorker ? javascriptBootstrapPath : bootstrapPath,
        {
          workerData: isJavaScriptWorker
            ? { workerPath: join(process.cwd(), 'workers/javascript/javascript-project-worker.js') }
            : { repoRoot: process.cwd() },
        }
      );
      nodeWorkers.push(this.worker);
      this.worker.on('message', (data) => this.onmessage?.({ data }));
      this.worker.on('error', (error) => {
        this.onerror?.({ message: error instanceof Error ? error.message : String(error) });
      });
    }

    postMessage(message: unknown, transfer?: Transferable[]): void {
      this.worker.postMessage(message, transfer as import('node:worker_threads').TransferListItem[]);
    }

    terminate(): void {
      void this.worker.terminate();
    }
  }

  const previousWorker = (globalThis as { Worker?: unknown }).Worker;
  (globalThis as { Worker?: unknown }).Worker = WorkerShim;
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
      `plain BSD-socket C++ program should compile against the wasi sysroot with injected shims: ${JSON.stringify({
        exitCode: compileResult.exitCode,
        stdout: compileResult.stdout,
        stderr: compileResult.stderr,
      })}`
    );
    const compiledFiles = compileResult.files ?? [];
    assertCondition(
      compiledFiles.some((file) => file.path === 'a.out'),
      `C++ socket compile should emit a.out: ${JSON.stringify(compiledFiles.map((file) => file.path))}`
    );
    console.log('PASS: plain POSIX socket code compiles in C++ project mode without any TraceCode API');

    const tkfsWorkspace = await createRuntimeWorkspace({
      files: [
        { path: 'tkfs.cpp', contents: CPP_TKFS_PROGRAM },
        { path: 'seed.txt', contents: 'kernel-read\n' },
      ],
      cppRunner: createBrowserCppProjectRunner(client, { timeoutMs: 120_000 }),
    });
    try {
      const tkfsCompile = await tkfsWorkspace.runCommand('clang++ tkfs.cpp -o a.out');
      assertCondition(
        tkfsCompile.exitCode === 0,
        `C++ TKFS fixture should compile: ${JSON.stringify(tkfsCompile)}`
      );
      const tkfsRun = await tkfsWorkspace.runCommand('./a.out');
      assertCondition(
        tkfsRun.exitCode === 0 &&
          tkfsRun.stdout === 'kernel-read\n' &&
          await tkfsWorkspace.readFile('generated.txt') === 'kernel-write',
        `C++ WASI should read and write the authoritative TraceKernel filesystem: ${JSON.stringify({
          run: tkfsRun,
          snapshot: await tkfsWorkspace.snapshot(),
        })}`
      );
      assertCondition(
        (tkfsRun.files ?? []).length === 0,
        `kernel-backed C++ mutations should not be replayed as snapshot diffs: ${JSON.stringify(tkfsRun.files)}`
      );
    } finally {
      tkfsWorkspace.dispose();
    }
    console.log('PASS: C++ WASI filesystem calls use TraceKernel-owned descriptors');

    const javascriptRunner = createBrowserJavaScriptProjectRunner({
      workerUrl: 'javascript-project-worker.js',
      workerFactory: (url, options) => new WorkerShim(url, options),
      workerIsolation: 'per-command',
      timeoutMs: 120_000,
    });
    const crossLanguageWorkspace = await createRuntimeWorkspace({
      files: [
        { path: 'cross-language.cpp', contents: CPP_CROSS_LANGUAGE_FS_PROGRAM },
        { path: 'cpp-watches.txt', contents: 'before-js' },
        { path: 'js-watches.txt', contents: 'before-cpp' },
        {
          path: 'js-writer.js',
          contents: [
            'const fs = require("node:fs");',
            'const deadline = Date.now() + 20_000;',
            'while (!fs.existsSync("cpp-ready.txt") && Date.now() < deadline) {}',
            'if (!fs.existsSync("cpp-ready.txt")) throw new Error("C++ reader did not become ready");',
            'fs.writeFileSync("cpp-watches.txt", "from-js");',
            'fs.writeFileSync("js-done.txt", "done");',
            'console.log("js-wrote");',
            '',
          ].join('\n'),
        },
        {
          path: 'js-watcher.js',
          contents: [
            'const fs = require("node:fs");',
            'const fd = fs.openSync("js-watches.txt", "r");',
            'fs.writeFileSync("js-ready.txt", "ready");',
            'const deadline = Date.now() + 20_000;',
            'while (!fs.existsSync("cpp-done.txt") && Date.now() < deadline) {}',
            'if (!fs.existsSync("cpp-done.txt")) throw new Error("C++ writer did not finish");',
            'const buffer = Buffer.alloc(64);',
            'const count = fs.readSync(fd, buffer, 0, buffer.length, 0);',
            'fs.closeSync(fd);',
            'console.log(`js-observed:${buffer.subarray(0, count).toString("utf8")}`);',
            '',
          ].join('\n'),
        },
      ],
      cppRunner: createBrowserCppProjectRunner(client, { timeoutMs: 120_000 }),
      nodeRunner: javascriptRunner,
    });
    try {
      const crossLanguageCompile = await crossLanguageWorkspace.runCommand(
        'clang++ cross-language.cpp -o a.out'
      );
      assertCondition(
        crossLanguageCompile.exitCode === 0,
        `cross-language C++ fixture should compile: ${JSON.stringify(crossLanguageCompile)}`
      );

      const [cppWatching, javascriptWriting] = await Promise.all([
        crossLanguageWorkspace.runCommand('./a.out watch-js'),
        crossLanguageWorkspace.runCommand('node js-writer.js'),
      ]);
      assertCondition(
        cppWatching.exitCode === 0 &&
          cppWatching.stdout === 'cpp-observed:from-js\n' &&
          javascriptWriting.exitCode === 0 &&
          javascriptWriting.stdout === 'js-wrote\n',
        `an already-open C++ descriptor should observe a JavaScript mutation: ${JSON.stringify({
          cppWatching,
          javascriptWriting,
        })}`
      );

      const [javascriptWatching, cppWriting] = await Promise.all([
        crossLanguageWorkspace.runCommand('node js-watcher.js'),
        crossLanguageWorkspace.runCommand('./a.out write-js'),
      ]);
      assertCondition(
        javascriptWatching.exitCode === 0 &&
          javascriptWatching.stdout === 'js-observed:from-cpp\n' &&
          cppWriting.exitCode === 0 &&
          cppWriting.stdout === 'cpp-wrote\n',
        `an already-open JavaScript descriptor should observe a C++ mutation: ${JSON.stringify({
          javascriptWatching,
          cppWriting,
        })}`
      );

      const kernelEvents = await crossLanguageWorkspace.readFile('/proc/tracekernel/events');
      assertCondition(
        kernelEvents.includes('./a.out watch-js') &&
          kernelEvents.includes('node js-writer.js') &&
          kernelEvents.includes('node js-watcher.js') &&
          kernelEvents.includes('./a.out write-js'),
        `the shared kernel should own all four process lifecycles: ${JSON.stringify(kernelEvents)}`
      );
      assertCondition(
        (cppWatching.files ?? []).length === 0 &&
          (javascriptWriting.files ?? []).length === 0 &&
          (javascriptWatching.files ?? []).length === 0 &&
          (cppWriting.files ?? []).length === 0,
        'cross-language mutations should be authoritative syscalls, not returned snapshot diffs'
      );
    } finally {
      crossLanguageWorkspace.dispose();
      javascriptRunner.dispose?.();
    }
    console.log('PASS: C++ and JavaScript observe each other through one TraceKernel filesystem');

    const tcpWorkspace = await createRuntimeWorkspace({
      files: [{ path: 'tcp.cpp', contents: CPP_TK_TCP_PROGRAM }],
      cppRunner: createBrowserCppProjectRunner(client, { timeoutMs: 120_000 }),
    });
    try {
      const tcpCompile = await tcpWorkspace.runCommand('clang++ tcp.cpp -o a.out');
      assertCondition(
        tcpCompile.exitCode === 0,
        `C++ TraceKernel TCP fixture should compile: ${JSON.stringify(tcpCompile)}`
      );
      const tcpRun = await tcpWorkspace.runCommand('./a.out');
      assertCondition(
        tcpRun.exitCode === 0 && tcpRun.stdout === 'ping:pong\n',
        `C++ BSD sockets should use TraceKernel TCP byte streams: ${JSON.stringify(tcpRun)}`
      );
    } finally {
      tcpWorkspace.dispose();
    }
    console.log('PASS: C++ BSD sockets use TraceKernel TCP descriptors');

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
      project: { files: [...projectFiles, ...compiledFiles] as import('../packages/harness-core/src/runtime-project').RuntimeFile[] },
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
      'loopback:HTTP/1.1 209:dispatch:POST:/echo?x=1:cpp-body',
      'external:HTTP/1.1 209:dispatch:GET:/status:',
      'listening:3999',
      'request:POST /task?id=1 HTTP/1.1:one:payload-1',
      'request:GET /status HTTP/1.1:two:',
      'done',
      '',
    ].join('\n');
    assertCondition(
      runResult.stdout === expectedStdout,
      `C++ socket program stdout mismatch:\n--- expected ---\n${expectedStdout}\n--- actual ---\n${runResult.stdout}\n--- stderr ---\n${runResult.stderr}`
    );
    console.log('PASS: C++ programs speak HTTP over plain sockets and observe host responses');

    assertCondition(dispatched.length === 2, `C++ program should dispatch two outbound requests: ${JSON.stringify(dispatched)}`);
    const loopbackRequest = dispatched[0]!;
    assertCondition(
      loopbackRequest.method === 'POST' &&
        loopbackRequest.url === 'http://127.0.0.1:3300/echo?x=1' &&
        loopbackRequest.path === '/echo?x=1' &&
        loopbackRequest.headers?.['x-cpp'] === 'yes' &&
        loopbackRequest.headers?.['host'] === 'localhost:3300' &&
        loopbackRequest.bodyEncoding === 'base64' &&
        loopbackRequest.body === base64FromString('cpp-body'),
      `C++ loopback socket request should carry method/url/headers/body through the bridge: ${JSON.stringify(loopbackRequest)}`
    );
    const externalRequest = dispatched[1]!;
    assertCondition(
      externalRequest.method === 'GET' &&
        externalRequest.url === 'http://api.example.com/status' &&
        externalRequest.path === '/status' &&
        externalRequest.body === undefined,
      `getaddrinfo-resolved request should carry the hostname into the bridge URL: ${JSON.stringify(externalRequest)}`
    );
    console.log('PASS: BSD-socket requests reach the host RuntimeKernelHttpBridge intact (loopback and named hosts)');

    assertCondition(
      listenerOptions?.port === 3999 && (listenerOptions?.host ?? '127.0.0.1') === '127.0.0.1',
      `C++ listener should register host/port with the bridge: ${JSON.stringify(listenerOptions)}`
    );
    assertCondition(
      firstResponse.status === 200 &&
        firstResponse.bodyEncoding === 'base64' &&
        firstResponse.body === base64FromString('reply-0:one') &&
        firstResponse.rawHeaders?.some(([name, value]) => name.toLowerCase() === 'x-cpp-server' && value === 'ok') === true,
      `first C++ server response mismatch: ${JSON.stringify(firstResponse)}`
    );
    assertCondition(
      secondResponse.status === 201 &&
        secondResponse.bodyEncoding === 'base64' &&
        secondResponse.body === base64FromString('reply-1:two'),
      `second C++ server response mismatch: ${JSON.stringify(secondResponse)}`
    );
    assertCondition(listenerClosed, 'closing the C++ server socket should close the host listener handle');
    console.log('PASS: hand-rolled C++ socket server serves sequential requests over the sync bridge');
  } finally {
    client.terminate();
    globalThis.fetch = originalFetch;
    if (previousWorker === undefined) {
      delete (globalThis as { Worker?: unknown }).Worker;
    } else {
      (globalThis as { Worker?: unknown }).Worker = previousWorker;
    }
    await Promise.all(nodeWorkers.map((worker) => worker.terminate().catch(() => {})));
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await test('cpp project http', main);

#!/usr/bin/env npx tsx

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function testHiddenCommandAccessTokenRoundTripsAcrossEntrypoints(): Promise<void> {
  // Exercised at the harness-core ESM<->CJS boundary rather than through a full
  // workspace: the hidden-command token brand lives in harness-core (a
  // globalThis Symbol.for-keyed WeakSet), so if the ESM and CJS builds shared no
  // identity this cross-recognition would fail. We deliberately avoid importing
  // the harness-project workspace bundle here because its ESM output
  // dynamic-requires turndown/@mixmark-io/domino, a pre-existing packaging
  // limitation unrelated to token identity.
  const coreEsm = await import(pathToFileURL(join(process.cwd(), 'packages/harness-core/dist/index.js')).href);
  const require = createRequire(import.meta.url);
  const coreCjs = require(join(process.cwd(), 'packages/harness-core/dist/index.cjs'));

  const cjsToken = coreCjs.createRuntimeProjectHiddenCommandAccess();
  const esmToken = coreEsm.createRuntimeProjectHiddenCommandAccess();
  assertCondition(
    coreEsm.isRuntimeProjectHiddenCommandAccess(cjsToken) === true,
    'Hidden command token minted from the CJS core build should be recognized by the ESM core build'
  );
  assertCondition(
    coreCjs.isRuntimeProjectHiddenCommandAccess(esmToken) === true,
    'Hidden command token minted from the ESM core build should be recognized by the CJS core build'
  );
  assertCondition(
    coreEsm.isRuntimeProjectHiddenCommandAccess({}) === false &&
      coreCjs.isRuntimeProjectHiddenCommandAccess({}) === false,
    'Hidden command token guard should reject plain objects across both core builds'
  );
}

async function runWithTempRoot(tempRoot: string): Promise<void> {
  const packOutput = spawnSync('pnpm', ['pack', '--pack-destination', tempRoot], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (packOutput.status !== 0) {
    throw new Error(packOutput.stderr || packOutput.stdout || 'pnpm pack failed');
  }

  const tarballName = String(packOutput.stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .at(-1);
  assertCondition(Boolean(tarballName), 'pnpm pack should print the generated tarball name');

  const packageDir = join(tempRoot, 'app', 'node_modules', '@tracecode', 'harness');
  await mkdir(packageDir, { recursive: true });

  const tarballPath = isAbsolute(tarballName!) ? tarballName! : join(tempRoot, tarballName!);
  const extract = spawnSync('tar', ['-xf', tarballPath, '-C', packageDir, '--strip-components=1'], {
    encoding: 'utf8',
  });
  if (extract.status !== 0) {
    throw new Error(extract.stderr || extract.stdout || 'Failed to extract packed harness tarball');
  }

  const requiredPackagedFiles = [
    'dist/index.js',
    'dist/index.cjs',
    'dist/index.d.ts',
    'dist/browser.js',
    'dist/browser.cjs',
    'dist/browser.d.ts',
    'dist/browser/project.js',
    'dist/browser/project.cjs',
    'dist/project.js',
    'dist/project.cjs',
    'dist/project.d.ts',
    'dist/project-node.js',
    'dist/project-node.cjs',
    'dist/project-node.d.ts',
    'dist/native.js',
    'dist/native.cjs',
    'dist/native.d.ts',
    'dist/zlib-browser-shim.js',
    'dist/zlib-browser-shim.cjs',
    'dist/core.js',
    'dist/core.cjs',
    'dist/python.js',
    'dist/python.cjs',
    'dist/javascript.js',
    'dist/javascript.cjs',
    'dist/java.js',
    'dist/java.cjs',
    'dist/csharp.js',
    'dist/csharp.cjs',
    'dist/cpp.js',
    'dist/cpp.cjs',
    'dist/sql.js',
    'dist/sql.cjs',
    'THIRD_PARTY_NOTICES.md',
    'workers/python/pyodide-worker.js',
    'workers/javascript/javascript-worker.js',
    'workers/javascript/javascript-project-worker.js',
    'workers/java/java-worker.js',
    'workers/java/java-source-augmentations.js',
    'workers/csharp/csharp-worker.js',
    'workers/vendor/java-browser-helper.jar',
    'workers/vendor/java-rewriter.jar',
    'workers/vendor/javaparser-core-3.25.10.jar',
    'workers/vendor/jdk.compiler-17.jar',
    'workers/vendor/typescript.js',
    'workers/vendor/csharp/_framework/dotnet.js',
    'workers/vendor/csharp/_framework/dotnet.native.wasm',
    'workers/vendor/csharp/_framework/dotnet.runtime.js',
    'workers/vendor/csharp/_framework/dotnet.boot.js',
  ];

  for (const relativePath of requiredPackagedFiles) {
    const filePath = join(packageDir, relativePath);
    const fileStat = await stat(filePath);
    assertCondition(fileStat.isFile(), `Packed tarball should include ${relativePath}`);
  }

  const rootTypes = await readFile(join(packageDir, 'dist/index.d.ts'), 'utf8');
  assertCondition(
    rootTypes.includes('getRuntimeProjectIoSupport') &&
      rootTypes.includes('getRuntimeProjectIoCapabilityMatrix') &&
      rootTypes.includes('RuntimeProjectIoCapabilityRow'),
    'Root declarations should expose the stable project I/O support helpers and matrix type'
  );
  const browserTypes = await readFile(join(packageDir, 'dist/browser.d.ts'), 'utf8');
  assertCondition(
    browserTypes.includes('getRuntimeProjectIoSupport') &&
      browserTypes.includes('getRuntimeProjectIoCapabilityMatrix') &&
      browserTypes.includes('getRuntimeProjectIoCapability'),
    'Browser declarations should expose the stable project I/O support helpers'
  );
  const projectTypes = await readFile(join(packageDir, 'dist/project.d.ts'), 'utf8');
  const projectNodeTypes = await readFile(join(packageDir, 'dist/project-node.d.ts'), 'utf8');
  assertCondition(
    projectTypes.includes('RuntimeProjectWorkspace') &&
      projectTypes.includes('JustBashRuntimeWorkspace') &&
      projectNodeTypes.includes('RuntimeProjectWorkspace') &&
      projectNodeTypes.includes('JustBashRuntimeWorkspace'),
    'Project declarations should expose RuntimeProjectWorkspace and the deprecated JustBashRuntimeWorkspace alias'
  );
  assertCondition(
    projectTypes.includes('ProjectWorkspaceCommand = CustomCommand') &&
      projectNodeTypes.includes('ProjectWorkspaceCommand') &&
      !projectTypes.includes('ProjectWorkspaceCommand = unknown') &&
      !projectNodeTypes.includes('ProjectWorkspaceCommand = unknown'),
    'ProjectWorkspaceCommand declarations should be typed as CustomCommand, not unknown'
  );
  const projectNodeTypeSurface = [
    'CreateRuntimeWorkspaceOptions',
    'ProjectWorkspaceCommand',
    'ProjectWorkspaceJavaScriptConfig',
    'ProjectWorkspaceExecutionLimits',
    'RuntimeTraceKernelControlOptions',
    'RuntimePackageManagerName',
    'RuntimePackageManifest',
    'RuntimePackageInstallRequest',
    'RuntimePackageDependencyProvider',
    'RuntimePackageManagerConfig',
    'PythonProjectCommandRequest',
    'PythonProjectCommandRunner',
    'JavaScriptProjectCommandRequest',
    'JavaScriptProjectCommandRunner',
    'TypeScriptProjectCommandRequest',
    'TypeScriptProjectCommandRunner',
    'JavaProjectCommandRequest',
    'JavaProjectCommandRunner',
    'CppProjectCommandRequest',
    'CppProjectCommandRunner',
    'CSharpProjectCommandRequest',
    'CSharpProjectCommandRunner',
    'RuntimeCommandOptions',
    'RuntimeCommandResult',
    'RuntimeCommandEvent',
    'RuntimeCommandEventHandler',
    'RuntimeCommandEventStream',
    'RuntimeCommandFileChangeEvent',
    'RuntimeCommandOutputEvent',
    'RuntimeCommandStatusEvent',
    'RuntimeFile',
    'RuntimeFileChange',
    'RuntimeFileEncoding',
    'RuntimeKernelHostConfig',
    'RuntimeKernelHostInfo',
    'RuntimeKernelInfo',
    'RuntimeKernelHttpBridge',
    'RuntimeKernelHttpBodyInit',
    'RuntimeKernelHttpBodyPayload',
    'RuntimeKernelHttpHandler',
    'RuntimeKernelHttpListenOptions',
    'RuntimeKernelHttpListenerHandle',
    'RuntimeKernelHttpListenerInfo',
    'RuntimeKernelHttpRequest',
    'RuntimeKernelHttpResponse',
    'RuntimeKernelUserConfig',
    'RuntimeKernelUserInfo',
    'RuntimeKernelWorkspaceConfig',
    'RuntimeKernelWorkspaceInfo',
    'RuntimeTraceKernelSchedulerConfig',
    'RuntimeKernelDevicePath',
    'RuntimeFileMutationPhase',
    'RuntimeTraceKernelConfig',
    'RuntimeProjectCommandRequest',
    'RuntimeProjectCommandRunner',
    'RuntimeProjectTerminalPrompt',
    'RuntimeProjectTerminalEvent',
    'RuntimeProjectTerminalEventHandler',
    'RuntimeProjectTerminalInputState',
    'RuntimeProjectTerminalInputStateReason',
    'RuntimeProjectTerminalRunOptions',
    'RuntimeProjectTerminalSession',
    'RuntimeProjectTerminalSessionOptions',
    'RuntimeProjectSession',
    'RuntimeProjectSessionCommand',
    'RuntimeProjectSessionCommandDefinition',
    'RuntimeProjectSessionFile',
    'RuntimeProjectSessionInfo',
    'RuntimeProjectIoBridge',
    'RuntimeProjectPatch',
    'RuntimeProjectPatchBase',
    'RuntimeProjectPatchChange',
    'RuntimeProjectPatchDirectoryCreate',
    'RuntimeProjectPatchDirectoryDelete',
    'RuntimeProjectPatchFileDelete',
    'RuntimeProjectPatchFileWrite',
    'RuntimeProjectPatchOptions',
    'RuntimeProjectLiveIoControllerOptions',
    'RuntimeProjectWorkerBridgeOptions',
    'RuntimeProjectSnapshot',
    'RuntimeWorkspace',
    'RuntimeWorkspaceActor',
    'RuntimeWorkspaceActorKind',
    'RuntimeWorkspaceCapabilities',
    'RuntimeWorkspaceEvent',
    'RuntimeWorkspaceEventHandler',
    'RuntimeWorkspaceHttpClient',
    'RuntimeWorkspaceHttpJsonRequestOptions',
    'RuntimeWorkspaceHttpJsonResponse',
    'RuntimeWorkspaceHttpRequestOptions',
    'RuntimeWorkspaceKernel',
    'RuntimeWorkspaceRemoveOptions',
    'RuntimeWorkspaceStat',
    'RuntimeWorkspaceUnsubscribe',
    'CreateNativeProjectWorkspaceOptions',
  ];
  for (const exportName of projectNodeTypeSurface) {
    assertCondition(projectNodeTypes.includes(exportName), `Project-node declarations should include ${exportName}`);
  }
  for (const forbidden of [
    'createRuntimeProjectIoBridge',
    'runRuntimeProjectWorkerBridge',
    'createPythonProjectCommands',
    'createNodeProjectCommands',
    'createTypeScriptProjectCommands',
    'createJavaProjectCommands',
    'createCppProjectCommands',
    'createCSharpProjectCommands',
    'createPackageManagerProjectCommands',
    'class RuntimeProjectLiveIoController',
    'RuntimeProjectLiveIoController,',
  ]) {
    assertCondition(!projectNodeTypes.includes(forbidden), `Project-node declarations should not expose ${forbidden}`);
  }

  const appDir = join(tempRoot, 'app');
  const evalScript = `
    (async () => {
      const browserRequire = require('@tracecode/harness/browser');
      if (typeof browserRequire.createBrowserHarness !== 'function') {
        throw new Error('Missing CommonJS browser export');
      }
      const projectRequire = require('@tracecode/harness/project');
      if (typeof projectRequire.createRuntimeWorkspace !== 'function') {
        throw new Error('Missing CommonJS root project subpath export');
      }
      const projectNodeRequire = require('@tracecode/harness/project-node');
      if (typeof projectNodeRequire.createNativeProjectWorkspace !== 'function') {
        throw new Error('Missing CommonJS root native project subpath export');
      }
      const nativeRequire = require('@tracecode/harness/native');
      if (typeof nativeRequire.createNativeHarness !== 'function') {
        throw new Error('Missing CommonJS root native harness subpath export');
      }

      const root = await import('@tracecode/harness');
      const project = await import('@tracecode/harness/project');
      const projectNode = await import('@tracecode/harness/project-node');
      const native = await import('@tracecode/harness/native');
      const browser = await import('@tracecode/harness/browser');
      const browserProject = await import('@tracecode/harness/browser/project');
      const core = await import('@tracecode/harness/core');
      const python = await import('@tracecode/harness/python');
      const javascript = await import('@tracecode/harness/javascript');
      const java = await import('@tracecode/harness/java');
      const csharp = await import('@tracecode/harness/csharp');
      const cpp = await import('@tracecode/harness/cpp');
      const sql = await import('@tracecode/harness/sql');

      async function waitForPackedHttpListener(workspace, port) {
        let listeners = '';
        for (let attempt = 0; attempt < 40; attempt += 1) {
          listeners = await workspace.readFile('/proc/tracekernel/net/listeners');
          if (listeners.includes('\\thttp\\t127.0.0.1\\t' + port + '\\t')) return listeners;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        throw new Error('Packed consumer HTTP listener did not start on ' + port + ':\\n' + listeners);
      }

      async function killPackedHttpListener(workspace, port) {
        const listeners = await waitForPackedHttpListener(workspace, port);
        const row = listeners.split('\\n').find((line) => line.includes('\\thttp\\t127.0.0.1\\t' + port + '\\t'));
        const pid = row && row.split('\\t')[1];
        if (!pid) throw new Error('Packed consumer HTTP listener row should include pid: ' + listeners);
        const killed = await workspace.runCommand('kill ' + pid);
        if (killed.exitCode !== 0) throw new Error('Packed consumer HTTP listener should be killable: ' + JSON.stringify(killed));
        await workspace.runCommand('wait ' + pid);
      }

      if (typeof browser.createBrowserHarness !== 'function') throw new Error('Missing createBrowserHarness export');
      if (typeof sql.createSqlTraceClient !== 'function') throw new Error('Missing SQL trace client export');
      if (typeof sql.createPgliteSqlTraceClient !== 'function') throw new Error('Missing PGlite SQL trace client export');
      if (typeof sql.assertValidSqlTrace !== 'function') throw new Error('Missing SQL trace validation export');
      if (typeof browser.getLanguageRuntimeInfo !== 'function') throw new Error('Missing browser runtime info export');
      if (typeof browser.getRuntimeProjectIoSupport !== 'function') {
        throw new Error('Missing browser project I/O support helper export');
      }
      if (typeof browserProject.createBrowserProjectWorkspace !== 'function') {
        throw new Error('Missing browser project workspace export');
      }
      if (typeof browserProject.runtimeHttpResponseText !== 'function') {
        throw new Error('Missing browser project HTTP body helper export');
      }
      if (typeof project.createRuntimeWorkspace !== 'function') {
        throw new Error('Missing root project workspace subpath export');
      }
      if (typeof project.runtimeHttpBodyFromBytes !== 'function' || typeof project.runtimeHttpResponseText !== 'function') {
        throw new Error('Missing project HTTP body helper exports');
      }
      if (typeof project.RuntimeProjectLiveIoController !== 'function') {
        throw new Error('Missing project live I/O controller subpath export');
      }
      if (typeof projectNode.createNativeProjectWorkspace !== 'function') {
        throw new Error('Missing root native project workspace subpath export');
      }
      const expectedProjectNodeRuntimeExports = [
        'JustBashRuntimeWorkspace',
        'RuntimeProjectWorkspace',
        'createNativeProjectWorkspace',
        'createRuntimeProjectHiddenCommandAccess',
        'createRuntimeWorkspace',
        'normalizeRuntimeProjectPath',
        'runtimeHttpBodyBytes',
        'runtimeHttpBodyFromBytes',
        'runtimeHttpBodyFromText',
        'runtimeHttpBodyText',
        'runtimeHttpRequestBytes',
        'runtimeHttpRequestText',
        'runtimeHttpResponseBytes',
        'runtimeHttpResponseText',
      ];
      const actualProjectNodeRuntimeExports = Object.keys(projectNode).sort();
      if (actualProjectNodeRuntimeExports.join(',') !== expectedProjectNodeRuntimeExports.join(',')) {
        throw new Error('Unexpected project-node runtime exports: ' + actualProjectNodeRuntimeExports.join(','));
      }
      if (projectNode.JustBashRuntimeWorkspace !== projectNode.RuntimeProjectWorkspace) {
        throw new Error('Deprecated project-node workspace alias should point at RuntimeProjectWorkspace');
      }
      for (const exportName of [
        'RuntimeProjectLiveIoController',
        'createRuntimeProjectIoBridge',
        'runRuntimeProjectWorkerBridge',
        'createPythonProjectCommands',
        'createNodeProjectCommands',
        'createTypeScriptProjectCommands',
        'createJavaProjectCommands',
        'createCppProjectCommands',
        'createCSharpProjectCommands',
        'createPackageManagerProjectCommands',
      ]) {
        if (exportName in projectNode) {
          throw new Error('Project-node should not expose ' + exportName);
        }
      }
      if (typeof native.createNativeHarness !== 'function') {
        throw new Error('Missing root native harness subpath export');
      }
      const packedNativeHarness = native.createNativeHarness();
      const packedNativeJs = packedNativeHarness.getClient('javascript');
      const packedNativeJsResult = await packedNativeJs.executeCode(
        'function solve(value) { return value + 1; }',
        'solve',
        { value: 41 }
      );
      if (!packedNativeJsResult.success || packedNativeJsResult.output !== 42) {
        throw new Error('Packed native harness JavaScript smoke failed: ' + JSON.stringify(packedNativeJsResult));
      }
      packedNativeHarness.dispose();
      const nativeWorkspace = await projectNode.createNativeProjectWorkspace({
        files: [
          { path: 'index.js', contents: 'console.log("packed-native-project")\\n' },
          { path: 'main.py', contents: 'print("packed-native-python")\\n' },
          { path: 'Main.java', contents: 'class Main { public static void main(String[] args) { System.out.println("packed-native-java"); } }\\n' },
          { path: 'main.cpp', contents: '#include <iostream>\\nint main() { std::cout << "packed-native-cpp\\\\n"; return 0; }\\n' },
          {
            path: 'NativePacked.csproj',
            contents: [
              '<Project Sdk="Microsoft.NET.Sdk">',
              '  <PropertyGroup>',
              '    <OutputType>Exe</OutputType>',
              '    <TargetFramework>net10.0</TargetFramework>',
              '    <ImplicitUsings>enable</ImplicitUsings>',
              '  </PropertyGroup>',
              '</Project>',
              '',
            ].join('\\n'),
          },
          { path: 'Program.cs', contents: 'Console.WriteLine("packed-native-csharp");\\n' },
        ],
      });
      const nativeNode = await nativeWorkspace.runCommand('node index.js');
      if (nativeNode.exitCode !== 0 || nativeNode.stdout !== 'packed-native-project\\n') {
        throw new Error('Packed native project workspace Node smoke failed: ' + JSON.stringify(nativeNode));
      }
      const nativePython = await nativeWorkspace.runCommand('python3 main.py');
      if (nativePython.exitCode !== 0 || nativePython.stdout !== 'packed-native-python\\n') {
        throw new Error('Packed native project workspace Python smoke failed: ' + JSON.stringify(nativePython));
      }
      const nativeJavac = await nativeWorkspace.runCommand('javac Main.java');
      if (nativeJavac.exitCode !== 0) {
        throw new Error('Packed native project workspace javac smoke failed: ' + JSON.stringify(nativeJavac));
      }
      const nativeJava = await nativeWorkspace.runCommand('java Main');
      if (nativeJava.exitCode !== 0 || nativeJava.stdout !== 'packed-native-java\\n') {
        throw new Error('Packed native project workspace Java smoke failed: ' + JSON.stringify(nativeJava));
      }
      const nativeCppCompile = await nativeWorkspace.runCommand('clang++ main.cpp -o native-cpp');
      if (nativeCppCompile.exitCode !== 0) {
        throw new Error('Packed native project workspace C++ compile smoke failed: ' + JSON.stringify(nativeCppCompile));
      }
      const nativeCpp = await nativeWorkspace.runCommand('./native-cpp');
      if (nativeCpp.exitCode !== 0 || nativeCpp.stdout !== 'packed-native-cpp\\n') {
        throw new Error('Packed native project workspace C++ run smoke failed: ' + JSON.stringify(nativeCpp));
      }
      const nativeCSharp = await nativeWorkspace.runCommand('dotnet run --project NativePacked.csproj');
      if (nativeCSharp.exitCode !== 0 || !nativeCSharp.stdout.endsWith('packed-native-csharp\\n')) {
        throw new Error('Packed native project workspace C# smoke failed: ' + JSON.stringify(nativeCSharp));
      }
      const packedMock = nativeWorkspace.http.listen({ host: '127.0.0.1', port: 0 }, (request) => ({
        status: 208,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: request.method, path: request.path, body: request.body || '' }) + '\\n',
      }));
      const packedHttp = await nativeWorkspace.http.request({
        method: 'POST',
        url: 'http://localhost:' + packedMock.info.port + '/packed',
        body: 'from-package',
      });
      if (packedHttp.status !== 208 || project.runtimeHttpResponseText(packedHttp) !== '{"method":"POST","path":"/packed","body":"from-package"}\\n') {
        throw new Error('Packed native project workspace HTTP smoke failed: ' + JSON.stringify(packedHttp));
      }
      packedMock.close();
      const packedStall = nativeWorkspace.http.listen({ host: '127.0.0.1', port: 0 }, () => new Promise(() => {}));
      const packedTimeout = await nativeWorkspace.http.request({ url: 'http://localhost:' + packedStall.info.port + '/stall', timeoutMs: 1 });
      if (packedTimeout.status !== 0 || packedTimeout.body !== 'TraceKernel HTTP request timed out after 1 milliseconds\\n') {
        throw new Error('Packed native project workspace HTTP timeout smoke failed: ' + JSON.stringify(packedTimeout));
      }
      packedStall.close();
      const consumerHttpRequests = [];
      const consumerWorkspace = await browserProject.createBrowserProjectWorkspace({
        kernel: { scheduler: { maxConcurrentCommands: 4 } },
        files: [
          {
            path: 'server.js',
            contents: [
              'const http = require("node:http");',
              'const queue = [];',
              'http.createServer((req, res) => {',
              '  const chunks = [];',
              '  req.on("data", (chunk) => chunks.push(chunk));',
              '  req.on("end", () => {',
              '    const body = Buffer.concat(chunks).toString();',
              '    if (req.method === "POST" && req.url === "/enqueue") {',
              '      queue.push(JSON.parse(body));',
              '      res.writeHead(201, { "content-type": "application/json" });',
              '      res.end(JSON.stringify({ size: queue.length }) + "\\\\n");',
              '      return;',
              '    }',
              '    if (req.method === "GET" && req.url === "/dequeue") {',
              '      res.writeHead(200, { "content-type": "application/json" });',
              '      res.end(JSON.stringify(queue.shift() || null) + "\\\\n");',
              '      return;',
              '    }',
              '    res.writeHead(404, { "content-type": "text/plain" });',
              '    res.end("missing\\\\n");',
              '  });',
              '}).listen(9101, "127.0.0.1");',
              '',
            ].join('\\n'),
          },
          {
            path: 'node-client.js',
            contents: [
              '(async () => {',
              '  const response = await fetch("http://localhost:9100/from-node", {',
              '    method: "POST",',
              '    headers: { "content-type": "text/plain", "x-client": "node" },',
              '    body: "node-body",',
              '  });',
              '  console.log(response.status + ":" + JSON.stringify(await response.json()));',
              '})().catch((error) => { console.error(error.message); process.exitCode = 1; });',
              '',
            ].join('\\n'),
          },
          { path: 'python-client.py', contents: 'print("python client")\\n' },
          { path: 'python-server.py', contents: 'print("python server")\\n' },
          { path: 'JavaClient.java', contents: 'class JavaClient { public static void main(String[] args) {} }\\n' },
          { path: 'JavaServer.java', contents: 'class JavaServer { public static void main(String[] args) {} }\\n' },
        ],
        nodeProjectTimeoutMs: 20000,
        nodeProject: {
          allowDynamicEval: true,
          allowMainThreadExecution: true,
          trustedMainThreadExecution: true,
        },
        pythonWorkerClient: {
          async executeProjectPython(request, _timeoutMs, _onEvent, signal) {
            if (request.scriptPath === 'python-client.py') {
              const response = await request.kernelHttp.dispatch({
                method: 'POST',
                url: 'http://localhost:9100/from-python',
                path: '/from-python',
                headers: { 'content-type': 'text/plain', 'x-client': 'python' },
                body: 'python-body',
              });
              return { stdout: response.status + ':' + response.body, stderr: '', exitCode: response.status === 207 ? 0 : 1 };
            }
            if (request.scriptPath === 'python-server.py') {
              const handle = request.kernelHttp.listen({ host: '127.0.0.1', port: 9102 }, (httpRequest) => ({
                status: 203,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ language: 'python', method: httpRequest.method, path: httpRequest.path, body: httpRequest.body || '' }) + '\\n',
              }));
              await new Promise((resolve) => {
                if (signal?.aborted) {
                  resolve();
                  return;
                }
                signal?.addEventListener('abort', resolve, { once: true });
              });
              handle.close();
              return { stdout: '', stderr: '', exitCode: 143 };
            }
            return { stdout: request.scriptPath + ':unused-python\\n', stderr: '', exitCode: 0 };
          },
          terminate() {},
        },
        javaWorkerClient: {
          async executeProjectJava(request, _timeoutMs, _onEvent, signal) {
            if (request.scriptPath === 'JavaClient') {
              const response = await request.kernelHttp.dispatch({
                method: 'POST',
                url: 'http://localhost:9100/from-java',
                path: '/from-java',
                headers: { 'content-type': 'text/plain', 'x-client': 'java' },
                body: 'java-body',
              });
              return { stdout: response.status + ':' + response.body, stderr: '', exitCode: response.status === 207 ? 0 : 1 };
            }
            if (request.scriptPath === 'JavaServer') {
              const handle = request.kernelHttp.listen({ host: '127.0.0.1', port: 9103 }, (httpRequest) => ({
                status: 206,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ language: 'java', method: httpRequest.method, path: httpRequest.path, body: httpRequest.body || '' }) + '\\n',
              }));
              await new Promise((resolve) => {
                if (signal?.aborted) {
                  resolve();
                  return;
                }
                signal?.addEventListener('abort', resolve, { once: true });
              });
              handle.close();
              return { stdout: '', stderr: '', exitCode: 143 };
            }
            return { stdout: request.source + ':' + request.scriptPath + ':unused-java\\n', stderr: '', exitCode: 0 };
          },
          terminate() {},
        },
        csharpWorkerClient: {
          async executeProjectCSharp(request) {
            return { stdout: request.source + ':' + request.args.join(',') + ':unused-csharp\\n', stderr: '', exitCode: 0 };
          },
          terminate() {},
        },
        cppWorkerClient: {
          async executeProjectCpp(request) {
            return { stdout: request.source + ':' + request.args.join(',') + ':unused-cpp\\n', stderr: '', exitCode: 0 };
          },
          terminate() {},
        },
      });
      const upstream = consumerWorkspace.http.listen({ host: '127.0.0.1', port: 9100 }, (request) => {
        consumerHttpRequests.push({ method: request.method, path: request.path, body: request.body || '', client: request.headers?.['x-client'] || '' });
        return {
          status: 207,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method: request.method, path: request.path, body: request.body || '', client: request.headers?.['x-client'] || '' }) + '\\n',
        };
      });
      try {
        const terminal = consumerWorkspace.createTerminalSession();
        const startNodeServer = await terminal.run('node server.js &');
        if (startNodeServer.exitCode !== 0) {
          throw new Error('Packed consumer terminal server should start: ' + JSON.stringify(startNodeServer));
        }
        await waitForPackedHttpListener(consumerWorkspace, 9101);
        const agentEnqueue = await consumerWorkspace.runCommand('curl -s --json \\'{"id":1}\\' http://localhost:9101/enqueue');
        if (agentEnqueue.exitCode !== 0 || agentEnqueue.stdout !== '{"size":1}\\n') {
          throw new Error('Packed consumer agent command should call terminal-owned server: ' + JSON.stringify(agentEnqueue));
        }
        const apiDequeue = await consumerWorkspace.http.json({
          method: 'GET',
          url: 'http://localhost:9101/dequeue',
          timeoutMs: 1000,
        });
        if (apiDequeue.status !== 200 || apiDequeue.json?.id !== 1) {
          throw new Error('Packed consumer workspace HTTP API should call terminal-owned server: ' + JSON.stringify(apiDequeue));
        }
        const nodeClient = await consumerWorkspace.runCommand('node node-client.js');
        if (nodeClient.exitCode !== 0 || nodeClient.stdout !== '207:{"method":"POST","path":"/from-node","body":"node-body","client":"node"}\\n') {
          throw new Error('Packed consumer Node project should call mock upstream: ' + JSON.stringify(nodeClient));
        }
        const pythonClient = await consumerWorkspace.runCommand('python3 python-client.py');
        if (pythonClient.exitCode !== 0 || pythonClient.stdout !== '207:{"method":"POST","path":"/from-python","body":"python-body","client":"python"}\\n') {
          throw new Error('Packed consumer Python project should call mock upstream: ' + JSON.stringify(pythonClient));
        }
        const javaClient = await consumerWorkspace.runCommand('java JavaClient');
        if (javaClient.exitCode !== 0 || javaClient.stdout !== '207:{"method":"POST","path":"/from-java","body":"java-body","client":"java"}\\n') {
          throw new Error('Packed consumer Java project should call mock upstream: ' + JSON.stringify(javaClient));
        }
        const startPythonServer = await terminal.run('python3 python-server.py &');
        if (startPythonServer.exitCode !== 0) {
          throw new Error('Packed consumer Python server should start: ' + JSON.stringify(startPythonServer));
        }
        await waitForPackedHttpListener(consumerWorkspace, 9102);
        const pythonServerResponse = await consumerWorkspace.http.request({
          method: 'POST',
          url: 'http://localhost:9102/from-test',
          body: 'test-body',
          timeoutMs: 1000,
        });
        if (pythonServerResponse.status !== 203 || project.runtimeHttpResponseText(pythonServerResponse) !== '{"language":"python","method":"POST","path":"/from-test","body":"test-body"}\\n') {
          throw new Error('Packed consumer API should call Python project server: ' + JSON.stringify(pythonServerResponse));
        }
        const startJavaServer = await terminal.run('java JavaServer &');
        if (startJavaServer.exitCode !== 0) {
          throw new Error('Packed consumer Java server should start: ' + JSON.stringify(startJavaServer));
        }
        await waitForPackedHttpListener(consumerWorkspace, 9103);
        const javaServerResponse = await consumerWorkspace.http.request({
          method: 'POST',
          url: 'http://localhost:9103/from-test',
          body: 'test-body',
          timeoutMs: 1000,
        });
        if (javaServerResponse.status !== 206 || project.runtimeHttpResponseText(javaServerResponse) !== '{"language":"java","method":"POST","path":"/from-test","body":"test-body"}\\n') {
          throw new Error('Packed consumer API should call Java project server: ' + JSON.stringify(javaServerResponse));
        }
        if (consumerHttpRequests.map((request) => request.path + ':' + request.client).join(',') !== '/from-node:node,/from-python:python,/from-java:java') {
          throw new Error('Packed consumer mock upstream should receive Node/Python/Java project requests: ' + JSON.stringify(consumerHttpRequests));
        }
        await killPackedHttpListener(consumerWorkspace, 9103);
        await killPackedHttpListener(consumerWorkspace, 9102);
        await killPackedHttpListener(consumerWorkspace, 9101);
      } finally {
        upstream.close();
        consumerWorkspace.dispose();
      }
      const browserWorkspace = await browserProject.createBrowserProjectWorkspace({
        files: [
          { path: 'main.py', contents: 'print("browser-python")\\n' },
          { path: 'index.js', contents: 'const fs = require("node:fs"); fs.writeFileSync("node.txt", "browser-node\\\\n"); console.log("browser-node");\\n' },
          { path: 'Main.java', contents: 'class Main {}\\n' },
          { path: 'Program.cs', contents: 'Console.WriteLine("browser-csharp");\\n' },
          { path: 'main.cpp', contents: 'int main() { return 0; }\\n' },
        ],
        nodeProjectTimeoutMs: 20000,
        nodeProject: {
          allowDynamicEval: true,
          allowMainThreadExecution: true,
          trustedMainThreadExecution: true,
        },
        pythonWorkerClient: {
          async executeProjectPython(request) {
            return { stdout: request.scriptPath + ':browser-python\\n', stderr: '', exitCode: 0 };
          },
          terminate() {},
        },
        javaWorkerClient: {
          async executeProjectJava(request) {
            return { stdout: request.source + ':' + request.scriptPath + ':browser-java\\n', stderr: '', exitCode: 0 };
          },
          terminate() {},
        },
        csharpWorkerClient: {
          async executeProjectCSharp(request) {
            return { stdout: request.source + ':' + request.args.join(',') + ':browser-csharp\\n', stderr: '', exitCode: 0 };
          },
          terminate() {},
        },
        cppWorkerClient: {
          async executeProjectCpp(request) {
            return { stdout: request.source + ':' + request.args.join(',') + ':browser-cpp\\n', stderr: '', exitCode: 0 };
          },
          terminate() {},
        },
      });
      try {
        const browserPython = await browserWorkspace.runCommand('python3 main.py');
        if (browserPython.exitCode !== 0 || browserPython.stdout !== 'main.py:browser-python\\n') {
          throw new Error('Packed browser project Python smoke failed: ' + JSON.stringify(browserPython));
        }
        const browserNode = await browserWorkspace.runCommand('node index.js');
        if (browserNode.exitCode !== 0 || browserNode.stdout !== 'browser-node\\n') {
          throw new Error('Packed browser project Node smoke failed: ' + JSON.stringify(browserNode));
        }
        const nodeSideEffect = await browserWorkspace.readFile('node.txt');
        if (nodeSideEffect !== 'browser-node\\n') {
          throw new Error('Packed browser project Node side effect failed: ' + JSON.stringify(nodeSideEffect));
        }
        const browserJava = await browserWorkspace.runCommand('java Main');
        if (browserJava.exitCode !== 0 || browserJava.stdout !== 'run:Main:browser-java\\n') {
          throw new Error('Packed browser project Java smoke failed: ' + JSON.stringify(browserJava));
        }
        const browserCSharp = await browserWorkspace.runCommand('dotnet run -- alpha beta');
        if (browserCSharp.exitCode !== 0 || browserCSharp.stdout !== 'run:alpha,beta:browser-csharp\\n') {
          throw new Error('Packed browser project C# smoke failed: ' + JSON.stringify(browserCSharp));
        }
        const browserCpp = await browserWorkspace.runCommand('clang++ main.cpp -o a.out');
        if (browserCpp.exitCode !== 0 || browserCpp.stdout !== 'compile:main.cpp,-o,a.out:browser-cpp\\n') {
          throw new Error('Packed browser project C++ smoke failed: ' + JSON.stringify(browserCpp));
        }
        const browserGcc = await browserWorkspace.runCommand('gcc main.cpp -o c-app');
        if (browserGcc.exitCode !== 0 || browserGcc.stdout !== 'compile:main.cpp,-o,c-app:browser-cpp\\n') {
          throw new Error('Packed browser project gcc alias smoke failed: ' + JSON.stringify(browserGcc));
        }
        const browserCc = await browserWorkspace.runCommand('cc main.cpp -o cc-app');
        if (browserCc.exitCode !== 0 || browserCc.stdout !== 'compile:main.cpp,-o,cc-app:browser-cpp\\n') {
          throw new Error('Packed browser project cc alias smoke failed: ' + JSON.stringify(browserCc));
        }
        const browserCppRun = await browserWorkspace.runCommand('./a.out alpha beta');
        if (browserCppRun.exitCode !== 0 || browserCppRun.stdout !== 'run:alpha,beta:browser-cpp\\n') {
          throw new Error('Packed browser project C++ executable smoke failed: ' + JSON.stringify(browserCppRun));
        }
      } finally {
        browserWorkspace.dispose();
      }
      if ('getPyodideWorkerClient' in browser) throw new Error('Low-level worker clients should not be publicly exported');
      if ('enforceRuntimeWorkerIsolation' in browser) throw new Error('Worker isolation helpers should not be publicly exported');
      if (typeof core.getLanguageRuntimeInfo !== 'function') throw new Error('Missing core runtime info export');
      if (typeof python.generateSolutionScript !== 'function') throw new Error('Missing python export');
      if (typeof python.createBrowserPythonProjectRunner !== 'function') {
        throw new Error('Missing python browser project runner export');
      }
      if (typeof javascript.executeJavaScriptCode !== 'function') throw new Error('Missing javascript export');
      if (typeof java.createJavaRuntimeClient !== 'function') throw new Error('Missing java export');
      if (typeof csharp.createCSharpRuntimeClient !== 'function') throw new Error('Missing csharp export');
      if (typeof cpp.createCppRuntimeClient !== 'function') throw new Error('Missing cpp export');
      if (typeof sql.createSqlTraceClient !== 'function') throw new Error('Missing sql export');
      if (typeof root.createBrowserHarness !== 'function') throw new Error('Root export should expose createBrowserHarness');
      if ('createSqlTraceClient' in root) throw new Error('Root export should not expose SQL trace helpers; use @tracecode/harness/sql');
      if (typeof root.getRuntimeProjectIoSupport !== 'function') {
        throw new Error('Root export should expose project I/O support helper');
      }
      const jsProjectIo = root.getRuntimeProjectIoSupport('javascript');
      const tsProjectIo = browser.getRuntimeProjectIoSupport('typescript');
      if (jsProjectIo.tier !== 'native-live' || tsProjectIo.tier !== 'unsupported') {
        throw new Error('Project I/O support helper returned unexpected tiers');
      }
      const projectIoMatrix = root.getRuntimeProjectIoCapabilityMatrix();
      const javaProjectIo = browser.getRuntimeProjectIoCapability('java');
      if (!Array.isArray(projectIoMatrix) || projectIoMatrix.length < 6) {
        throw new Error('Project I/O capability matrix should include supported language rows');
      }
      if (javaProjectIo.browser.tier !== 'bridged-live' || javaProjectIo.node.tier !== 'final-diff') {
        throw new Error('Project I/O capability row returned unexpected Java tiers');
      }
      for (const exportName of ['createRuntimeWorkspace', 'createNativeProjectWorkspace', 'createBrowserProjectWorkspace']) {
        if (exportName in root) {
          throw new Error('Root default surface should not include project-mode just-bash API: ' + exportName);
        }
      }
      for (const exportName of ['createRuntimeWorkspace', 'createBrowserProjectWorkspace']) {
        if (exportName in browser) {
          throw new Error('Browser default surface should not include project-mode just-bash API: ' + exportName);
        }
      }
      const javaInfo = root.getLanguageRuntimeInfo('java');
      if (javaInfo.versionLabel !== 'Java ' + javaInfo.runtime.version) {
        throw new Error('Root export should expose language runtime info');
      }
      if (!javaInfo.description.includes('javac')) {
        throw new Error('Root export should expose natural-language language runtime info');
      }
      console.log('ok');
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
  const run = spawnSync('node', ['-e', evalScript], {
    cwd: appDir,
    encoding: 'utf8',
  });

  if (run.status !== 0) {
    throw new Error(run.stderr || run.stdout || 'Packed surface import check failed');
  }

  await writeFile(
    join(appDir, 'browser-project-entry.js'),
    [
      'import { createBrowserProjectWorkspace } from "@tracecode/harness/browser/project";',
      'import { RuntimeProjectLiveIoController, createRuntimeWorkspace } from "@tracecode/harness/project";',
      'if (typeof createBrowserProjectWorkspace !== "function") throw new Error("missing project export");',
      'if (typeof createRuntimeWorkspace !== "function") throw new Error("missing root project export");',
      'if (typeof RuntimeProjectLiveIoController !== "function") throw new Error("missing live io controller export");',
      'console.log("ok");',
      '',
    ].join('\n'),
    'utf8'
  );
  const esbuildPath = join(process.cwd(), 'node_modules', '.bin', 'esbuild');
  const browserBundle = spawnSync(
    esbuildPath,
    [
      'browser-project-entry.js',
      '--bundle',
      '--platform=browser',
      '--format=esm',
      '--conditions=browser',
      '--outfile=browser-project-bundle.js',
      '--log-level=error',
    ],
    {
      cwd: appDir,
      encoding: 'utf8',
    }
  );
  if (browserBundle.status !== 0) {
    throw new Error(browserBundle.stderr || browserBundle.stdout || 'Packed browser project bundle check failed');
  }
  const bundledBrowserProject = await readFile(join(appDir, 'browser-project-bundle.js'), 'utf8');
  for (const forbidden of ['createRequire', 'worker_threads', 'from "module"']) {
    assertCondition(
      !bundledBrowserProject.includes(forbidden),
      `Packed browser project bundle should not include Node-only ${forbidden}`
    );
  }

  const bundledZlibShim = await readFile(join(packageDir, 'dist/zlib-browser-shim.js'), 'utf8');
  for (const forbidden of ['createRequire', 'worker_threads', 'from "module"']) {
    assertCondition(
      !bundledZlibShim.includes(forbidden),
      `Packed zlib browser shim should not include Node-only ${forbidden}`
    );
  }

  console.log('PASS: packaged public surface imports through published subpaths');
}

async function main(): Promise<void> {
  await testHiddenCommandAccessTokenRoundTripsAcrossEntrypoints();
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-harness-pack-'));
  try {
    await runWithTempRoot(tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

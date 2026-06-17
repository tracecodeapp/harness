#!/usr/bin/env npx tsx

import {
  createRuntimeWorkspace,
  runtimeHttpBodyFromBytes,
  runtimeHttpResponseBytes,
  runtimeHttpResponseText,
} from '../packages/harness-project/src/index';
import {
  createBrowserJavaScriptProjectRunner,
  createBrowserTypeScriptProjectRunner,
} from '../packages/harness-javascript/src/project-browser';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function waitForListener(workspace: Awaited<ReturnType<typeof createRuntimeWorkspace>>, port: number): Promise<string> {
  let listeners = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    listeners = await workspace.readFile('/proc/tracekernel/net/listeners');
    if (listeners.includes(`\thttp\t127.0.0.1\t${port}\t`)) return listeners;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`TraceKernel HTTP listener did not start on ${port}:\n${listeners}`);
}

async function main(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'server.js',
        contents: [
          'const http = require("node:http");',
          'http.createServer((req, res) => {',
          '  const chunks = [];',
          '  req.on("data", (chunk) => chunks.push(chunk));',
          '  req.on("end", () => {',
          '    const body = Buffer.concat(chunks);',
          '    if (req.url === "/binary") {',
          '      res.setHeader("set-cookie", ["a=1", "b=2"]);',
          '      res.writeHead(201, {',
          '        "content-type": "application/octet-stream",',
          '        "x-body-hex": body.toString("hex"),',
          '      });',
          '      res.end(Buffer.from([0, 255, 1, 2]));',
          '      return;',
          '    }',
          '    if (req.url === "/json") {',
          '      res.writeHead(200, { "content-type": "application/json" });',
          '      res.end(JSON.stringify({ ok: true, method: req.method, body: body.toString() }) + "\\n");',
          '      return;',
          '    }',
          '    res.writeHead(404, { "content-type": "text/plain" });',
          '    res.end("missing\\n");',
          '  });',
          '}).listen(3300, "127.0.0.1");',
          '',
        ].join('\n'),
      },
      {
        path: 'fetch-binary.js',
        contents: [
          '(async () => {',
          '  const response = await fetch("http://localhost:3300/binary", {',
          '    method: "POST",',
          '    body: new Uint8Array([0, 255, 1]),',
          '  });',
          '  const bytes = new Uint8Array(await response.arrayBuffer());',
          '  console.log(response.status + ":" + response.headers.get("x-body-hex"));',
          '  console.log(Array.from(bytes).join(","));',
          '})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });',
          '',
        ].join('\n'),
      },
      {
        path: 'fetch-lifecycle.js',
        contents: [
          '(async () => {',
          '  const response = await fetch("http://localhost:3300/json");',
          '  const clone = response.clone();',
          '  process.stdout.write(await response.text());',
          '  try {',
          '    await response.text();',
          '  } catch (error) {',
          '    console.log(error.name + ":" + response.bodyUsed);',
          '  }',
          '  try {',
          '    response.clone();',
          '  } catch (error) {',
          '    console.log(error.name);',
          '  }',
          '  console.log((await clone.json()).ok);',
          '})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });',
          '',
        ].join('\n'),
      },
      {
        path: 'node-client.js',
        contents: [
          'const http = require("node:http");',
          'const req = http.request({',
          '  hostname: "localhost",',
          '  port: 3300,',
          '  path: "/binary",',
          '  method: "POST",',
          '}, (res) => {',
          '  const chunks = [];',
          '  res.on("data", (chunk) => chunks.push(chunk));',
          '  res.on("end", () => {',
          '    const body = Buffer.concat(chunks);',
          '    console.log(res.statusCode + ":" + res.headers["x-body-hex"]);',
          '    console.log(res.rawHeaders.join("|"));',
          '    console.log(Array.from(body).join(","));',
          '  });',
          '});',
          'req.write(Buffer.from([0, 255, 1]));',
          'req.end();',
          '',
        ].join('\n'),
      },
      {
        path: 'mock-fetch-client.js',
        contents: [
          '(async () => {',
          '  const response = await fetch("http://localhost:3400/from-fetch", {',
          '    method: "POST",',
          '    headers: { "x-client": "fetch" },',
          '    body: "fetch-body",',
          '  });',
          '  console.log(response.status + ":" + response.headers.get("content-type"));',
          '  console.log(JSON.stringify(await response.json()));',
          '})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });',
          '',
        ].join('\n'),
      },
      {
        path: 'mock-http-client.js',
        contents: [
          'const http = require("node:http");',
          'const req = http.request({',
          '  hostname: "localhost",',
          '  port: 3400,',
          '  path: "/from-http",',
          '  method: "POST",',
          '  headers: { "x-client": "node-http" },',
          '}, (res) => {',
          '  let body = "";',
          '  res.setEncoding("utf8");',
          '  res.on("data", (chunk) => { body += chunk; });',
          '  res.on("end", () => {',
          '    console.log(res.statusCode + ":" + res.headers["content-type"]);',
          '    console.log(body.trim());',
          '  });',
          '});',
          'req.write("http-body");',
          'req.end();',
          '',
        ].join('\n'),
      },
      {
        path: 'conflict-server.js',
        contents: [
          'const http = require("node:http");',
          'try {',
          '  http.createServer((req, res) => res.end("unexpected\\n")).listen(3500, "127.0.0.1");',
          '  console.log("unexpected");',
          '} catch (error) {',
          '  console.log(error.code);',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'project-listener.js',
        contents: [
          'const http = require("node:http");',
          'http.createServer((req, res) => res.end("project\\n")).listen(3501, "127.0.0.1");',
          '',
        ].join('\n'),
      },
      {
        path: 'tsconfig.json',
        contents: JSON.stringify({
          compilerOptions: {
            outDir: 'dist',
            rootDir: '.',
            module: 'commonjs',
            target: 'es2020',
            strict: true,
          },
          files: ['ts-http-client.ts'],
        }, null, 2),
      },
      {
        path: 'ts-http-client.ts',
        contents: [
          'async function main(): Promise<void> {',
          '  const response = await fetch("http://localhost:3300/json", {',
          '    method: "POST",',
          '    headers: { "content-type": "application/json" },',
          '    body: JSON.stringify({ ts: true }),',
          '  });',
          '  const payload = await response.json() as { ok: boolean; method: string; body: string };',
          '  console.log(response.status + ":" + response.ok + ":" + payload.method + ":" + payload.body);',
          '}',
          'main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });',
          '',
        ].join('\n'),
      },
    ],
    kernel: { scheduler: { maxConcurrentCommands: 4 } },
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true }),
    typescriptRunner: createBrowserTypeScriptProjectRunner(),
  });

  try {
    const terminal = workspace.createTerminalSession();
    const start = await terminal.run('node server.js &');
    assertCondition(start.exitCode === 0, `HTTP conformance server should start: ${JSON.stringify(start)}`);
    const listeners = await waitForListener(workspace, 3300);

    const fetchBinary = await workspace.runCommand('node fetch-binary.js');
    assertCondition(fetchBinary.exitCode === 0, `fetch binary request should succeed: ${JSON.stringify(fetchBinary)}`);
    assertCondition(fetchBinary.stdout === '201:00ff01\n0,255,1,2\n', `fetch should preserve binary request/response bytes: ${fetchBinary.stdout}`);

    const requestBinary = await workspace.http.request({
      method: 'POST',
      url: 'http://localhost:3300/binary',
      ...runtimeHttpBodyFromBytes(new Uint8Array([0, 255, 1])),
    });
    assertCondition(requestBinary.status === 201, `workspace HTTP binary request should return 201: ${JSON.stringify(requestBinary)}`);
    assertCondition(requestBinary.headers?.['x-body-hex'] === '00ff01', `workspace HTTP request should preserve binary request bytes: ${JSON.stringify(requestBinary)}`);
    assertCondition(requestBinary.bodyEncoding === 'base64', `workspace HTTP response should use base64 for non-UTF8 bytes: ${JSON.stringify(requestBinary)}`);
    assertCondition(
      Array.from(runtimeHttpResponseBytes(requestBinary)).join(',') === '0,255,1,2',
      `workspace HTTP response should preserve binary response bytes: ${JSON.stringify(requestBinary)}`
    );
    const bomBody = runtimeHttpBodyFromBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]));
    assertCondition(
      Array.from(runtimeHttpBodyBytes(bomBody)).join(',') === '239,187,191,65',
      `workspace HTTP byte helpers should preserve leading UTF-8 BOM bytes: ${JSON.stringify(bomBody)}`
    );
    assertCondition(
      requestBinary.rawHeaders?.some(([name, value]) => name.toLowerCase() === 'set-cookie' && value === 'a=1') === true &&
        requestBinary.rawHeaders?.some(([name, value]) => name.toLowerCase() === 'set-cookie' && value === 'b=2') === true,
      `workspace HTTP raw headers should preserve repeated response headers: ${JSON.stringify(requestBinary.rawHeaders)}`
    );

    const requestJson = await workspace.http.json<{ ok: boolean; method: string; body: string }>({
      method: 'POST',
      url: 'http://localhost:3300/json',
      body: { id: 7 },
    });
    assertCondition(requestJson.json.ok === true, `workspace HTTP JSON helper should parse JSON: ${JSON.stringify(requestJson)}`);
    assertCondition(requestJson.json.method === 'POST', `workspace HTTP JSON helper should preserve method: ${JSON.stringify(requestJson)}`);
    assertCondition(requestJson.json.body === '{"id":7}', `workspace HTTP JSON helper should stringify request body: ${JSON.stringify(requestJson)}`);
    assertCondition(
      runtimeHttpResponseText(requestJson) === '{"ok":true,"method":"POST","body":"{\\"id\\":7}"}\n',
      `workspace HTTP response text helper should decode UTF-8 response bodies: ${JSON.stringify(requestJson)}`
    );

    const typeScriptCompile = await workspace.runCommand('tsc --project tsconfig.json');
    assertCondition(typeScriptCompile.exitCode === 0, `TypeScript HTTP client should typecheck and compile: ${JSON.stringify(typeScriptCompile)}`);
    const typeScriptClient = await workspace.runCommand('node dist/ts-http-client.js');
    assertCondition(typeScriptClient.exitCode === 0, `compiled TypeScript HTTP client should run: ${JSON.stringify(typeScriptClient)}`);
    assertCondition(
      typeScriptClient.stdout === '200:true:POST:{"ts":true}\n',
      `compiled TypeScript should use TraceKernel fetch after tsc emit: ${typeScriptClient.stdout}`
    );

    const lifecycle = await workspace.runCommand('node fetch-lifecycle.js');
    assertCondition(lifecycle.exitCode === 0, `fetch response lifecycle should succeed: ${JSON.stringify(lifecycle)}`);
    assertCondition(
      lifecycle.stdout === '{"ok":true,"method":"GET","body":""}\nTypeError:true\nTypeError\ntrue\n',
      `fetch response lifecycle should match consumed-body and clone behavior: ${lifecycle.stdout}`
    );

    const nodeClient = await workspace.runCommand('node node-client.js');
    assertCondition(nodeClient.exitCode === 0, `node http client should succeed: ${JSON.stringify(nodeClient)}`);
    assertCondition(nodeClient.stdout.includes('201:00ff01\n'), `node http client should preserve binary request bytes: ${nodeClient.stdout}`);
    assertCondition(nodeClient.stdout.includes('0,255,1,2\n'), `node http client should preserve binary response bytes: ${nodeClient.stdout}`);
    assertCondition(
      nodeClient.stdout.includes('set-cookie|a=1|set-cookie|b=2'),
      `node http client rawHeaders should preserve repeated response headers: ${nodeClient.stdout}`
    );

    const mockRequests: Array<{ method: string; path: string; body?: string; headers?: Record<string, string> }> = [];
    const mockServer = workspace.http.listen({ host: '127.0.0.1', port: 3400 }, async (request) => {
      mockRequests.push({
        method: request.method,
        path: request.path,
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(request.headers ? { headers: request.headers } : {}),
      });
      return {
        status: request.path === '/from-curl' ? 201 : 202,
        headers: { 'content-type': 'application/json' },
        rawHeaders: [['content-type', 'application/json']],
        body: JSON.stringify({
          method: request.method,
          path: request.path,
          body: request.body ?? '',
          client: request.headers?.['x-client'] ?? '',
        }) + '\n',
      };
    });
    assertCondition(mockServer.info.pid === 0, `consumer-owned listener should be system-owned: ${JSON.stringify(mockServer.info)}`);
    const mockListeners = await workspace.readFile('/proc/tracekernel/net/listeners');
    assertCondition(
      mockListeners.includes(`${mockServer.info.id}\t0\thttp\t127.0.0.1\t3400\t`),
      `consumer-owned listener should be visible in /proc: ${mockListeners}`
    );

    const fetchToMock = await workspace.runCommand('node mock-fetch-client.js');
    assertCondition(fetchToMock.exitCode === 0, `project fetch should call consumer-owned listener: ${JSON.stringify(fetchToMock)}`);
    assertCondition(
      fetchToMock.stdout === '202:application/json\n{"method":"POST","path":"/from-fetch","body":"fetch-body","client":"fetch"}\n',
      `project fetch should receive consumer-owned listener response: ${fetchToMock.stdout}`
    );

    const httpToMock = await workspace.runCommand('node mock-http-client.js');
    assertCondition(httpToMock.exitCode === 0, `project node:http should call consumer-owned listener: ${JSON.stringify(httpToMock)}`);
    assertCondition(
      httpToMock.stdout === '202:application/json\n{"method":"POST","path":"/from-http","body":"http-body","client":"node-http"}\n',
      `project node:http should receive consumer-owned listener response: ${httpToMock.stdout}`
    );

    const curlToMock = await workspace.runCommand('curl -s --json \'{"id":1}\' http://localhost:3400/from-curl');
    assertCondition(curlToMock.exitCode === 0, `project curl should call consumer-owned listener: ${JSON.stringify(curlToMock)}`);
    assertCondition(
      curlToMock.stdout === '{"method":"POST","path":"/from-curl","body":"{\\"id\\":1}","client":""}\n',
      `project curl should receive consumer-owned listener response: ${curlToMock.stdout}`
    );
    assertCondition(
      mockRequests.map((request) => request.path).join(',') === '/from-fetch,/from-http,/from-curl',
      `consumer-owned listener should receive project requests in order: ${JSON.stringify(mockRequests)}`
    );

    mockServer.close();
    const afterMockCloseListeners = await workspace.readFile('/proc/tracekernel/net/listeners');
    assertCondition(
      !afterMockCloseListeners.includes('\thttp\t127.0.0.1\t3400\t'),
      `consumer-owned listener close should remove /proc entry: ${afterMockCloseListeners}`
    );
    const afterMockCloseCurl = await workspace.runCommand('curl -s http://localhost:3400/from-curl');
    assertCondition(afterMockCloseCurl.exitCode === 7, `closed consumer-owned listener should refuse connections: ${JSON.stringify(afterMockCloseCurl)}`);

    const ephemeralMock = workspace.http.listen({ host: '127.0.0.1', port: 0 }, () => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'ephemeral\n',
    }));
    assertCondition(ephemeralMock.info.pid === 0, `ephemeral consumer listener should be system-owned: ${JSON.stringify(ephemeralMock.info)}`);
    assertCondition(ephemeralMock.info.port >= 49152, `consumer listen(0) should allocate an ephemeral port: ${JSON.stringify(ephemeralMock.info)}`);
    const ephemeralCurl = await workspace.runCommand(`curl -s http://localhost:${ephemeralMock.info.port}/`);
    assertCondition(ephemeralCurl.exitCode === 0, `consumer ephemeral listener should be reachable: ${JSON.stringify(ephemeralCurl)}`);
    assertCondition(ephemeralCurl.stdout === 'ephemeral\n', `consumer ephemeral listener should answer requests: ${ephemeralCurl.stdout}`);
    ephemeralMock.close();

    const conflictMock = workspace.http.listen({ host: '127.0.0.1', port: 3500 }, () => ({
      status: 200,
      body: 'mock\n',
    }));
    const conflictProject = await workspace.runCommand('node conflict-server.js');
    assertCondition(conflictProject.exitCode === 0, `project bind conflict command should finish: ${JSON.stringify(conflictProject)}`);
    assertCondition(conflictProject.stdout === 'EADDRINUSE\n', `consumer listener should conflict with project bind: ${conflictProject.stdout}`);
    conflictMock.close();

    const projectStart = await terminal.run('node project-listener.js &');
    assertCondition(projectStart.exitCode === 0, `project conflict listener should start: ${JSON.stringify(projectStart)}`);
    const projectConflictListeners = await waitForListener(workspace, 3501);
    let consumerConflictError = '';
    try {
      workspace.http.listen({ host: '127.0.0.1', port: 3501 }, () => ({ status: 200, body: 'unexpected\n' }));
    } catch (error) {
      consumerConflictError = error instanceof Error ? error.message : String(error);
    }
    assertCondition(
      consumerConflictError.includes('EADDRINUSE'),
      `project listener should conflict with consumer bind: ${consumerConflictError}`
    );
    const projectConflictRow = projectConflictListeners.split('\n').find((line) => line.includes('\thttp\t127.0.0.1\t3501\t'));
    const projectConflictPid = projectConflictRow?.split('\t')[1];
    assertCondition(projectConflictPid !== undefined, `project conflict listener row should include pid: ${projectConflictListeners}`);
    const projectConflictKilled = await workspace.runCommand(`kill ${projectConflictPid}`);
    assertCondition(projectConflictKilled.exitCode === 0, `project conflict listener should be killable: ${JSON.stringify(projectConflictKilled)}`);
    await workspace.runCommand(`wait ${projectConflictPid}`);

    const failingMock = workspace.http.listen({ host: '127.0.0.1', port: 3502 }, () => {
      throw new Error('mock exploded');
    });
    const failingResponse = await workspace.http.request({ url: 'http://localhost:3502/fail' });
    assertCondition(failingResponse.status === 500, `consumer listener exceptions should return 500: ${JSON.stringify(failingResponse)}`);
    assertCondition(failingResponse.body === 'mock exploded\n', `consumer listener exception body should include message: ${JSON.stringify(failingResponse)}`);
    const failingProjectResponse = await workspace.runCommand('curl -s http://localhost:3502/fail');
    assertCondition(failingProjectResponse.exitCode === 0, `project curl should receive redacted host listener failure body: ${JSON.stringify(failingProjectResponse)}`);
    assertCondition(
      failingProjectResponse.stdout === 'TraceKernel HTTP listener failed\n',
      `project-visible host listener failures should be redacted: ${failingProjectResponse.stdout}`
    );
    failingMock.close();

    const stalledMock = workspace.http.listen({ host: '127.0.0.1', port: 3504 }, () => new Promise(() => {}));
    const stalledResponse = await workspace.http.request({ url: 'http://localhost:3504/stall', timeoutMs: 5 });
    assertCondition(stalledResponse.status === 0, `workspace HTTP request timeout should return a transport failure: ${JSON.stringify(stalledResponse)}`);
    assertCondition(
      stalledResponse.body === 'TraceKernel HTTP request timed out after 5 milliseconds\n',
      `workspace HTTP request timeout should explain the timeout: ${JSON.stringify(stalledResponse)}`
    );
    const abortController = new AbortController();
    const abortedPromise = workspace.http.request({ url: 'http://localhost:3504/abort', signal: abortController.signal });
    abortController.abort();
    const abortedResponse = await abortedPromise;
    assertCondition(abortedResponse.status === 0, `workspace HTTP request abort should return a transport failure: ${JSON.stringify(abortedResponse)}`);
    assertCondition(
      abortedResponse.body === 'TraceKernel HTTP request aborted\n',
      `workspace HTTP request abort should explain the abort: ${JSON.stringify(abortedResponse)}`
    );
    stalledMock.close();

    const queuedWorkspace = await createRuntimeWorkspace({
      kernel: { scheduler: { maxConcurrentCommands: 1 } },
    });
    const queuedStall = queuedWorkspace.http.listen({ host: '127.0.0.1', port: 3505 }, () => new Promise(() => {}));
    try {
      const timedOutCurl = queuedWorkspace.runCommand('curl -s --max-time 0.01 http://localhost:3505/hang');
      const queuedEcho = queuedWorkspace.runCommand('printf "after\\n"');
      const [curlResult, echoResult] = await Promise.all([timedOutCurl, queuedEcho]);
      assertCondition(curlResult.exitCode === 28, `curl timeout should exit 28: ${JSON.stringify(curlResult)}`);
      assertCondition(
        curlResult.stderr === 'curl: (28) Operation timed out after 10 milliseconds\n',
        `curl timeout should preserve curl-shaped stderr: ${JSON.stringify(curlResult)}`
      );
      assertCondition(echoResult.exitCode === 0 && echoResult.stdout === 'after\n', `timed-out HTTP command should release scheduler slot: ${JSON.stringify(echoResult)}`);
    } finally {
      queuedStall.close();
      await queuedWorkspace.destroy();
    }

    const disposableMock = workspace.http.listen({ host: '127.0.0.1', port: 3503 }, () => ({
      status: 200,
      body: 'disposed?\n',
    }));
    assertCondition(disposableMock.info.pid === 0, `disposable listener should be system-owned: ${JSON.stringify(disposableMock.info)}`);
    workspace.dispose();
    const afterDispose = await workspace.http.request({ url: 'http://localhost:3503/' });
    assertCondition(afterDispose.status === 0, `dispose should clear consumer-owned listeners: ${JSON.stringify(afterDispose)}`);

    const listenerRow = listeners.split('\n').find((line) => line.includes('\thttp\t127.0.0.1\t3300\t'));
    const serverPid = listenerRow?.split('\t')[1];
    assertCondition(serverPid !== undefined, `listener row should include owning pid: ${listeners}`);
    const killed = await workspace.runCommand(`kill ${serverPid}`);
    assertCondition(killed.exitCode === 0, `HTTP conformance server should be killable: ${JSON.stringify(killed)}`);
    await workspace.runCommand(`wait ${serverPid}`);
  } finally {
    await workspace.destroy();
  }
}

await main();

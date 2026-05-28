#!/usr/bin/env npx tsx

import { createRuntimeWorkspace } from '../packages/harness-project/src/index';
import { createBrowserJavaScriptProjectRunner } from '../packages/harness-javascript/src/project-browser';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function bytesFromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
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
    ],
    kernel: { scheduler: { maxConcurrentCommands: 4 } },
    nodeRunner: createBrowserJavaScriptProjectRunner(),
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
      body: 'AP8B',
      bodyEncoding: 'base64',
    });
    assertCondition(requestBinary.status === 201, `workspace HTTP binary request should return 201: ${JSON.stringify(requestBinary)}`);
    assertCondition(requestBinary.headers?.['x-body-hex'] === '00ff01', `workspace HTTP request should preserve binary request bytes: ${JSON.stringify(requestBinary)}`);
    assertCondition(requestBinary.bodyEncoding === 'base64', `workspace HTTP response should use base64 for non-UTF8 bytes: ${JSON.stringify(requestBinary)}`);
    assertCondition(
      Array.from(bytesFromBase64(requestBinary.body ?? '')).join(',') === '0,255,1,2',
      `workspace HTTP response should preserve binary response bytes: ${JSON.stringify(requestBinary)}`
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

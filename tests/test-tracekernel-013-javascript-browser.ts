#!/usr/bin/env npx tsx

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

async function syncAssets(targetDirectory: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      resolve('node_modules/tsx/dist/cli.mjs'),
      resolve('src/cli.ts'),
      'sync-assets',
      targetDirectory,
      '--languages',
      'javascript,typescript',
    ], { cwd: process.cwd(), stdio: 'inherit' });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(`Asset sync failed with ${signal ? `signal ${signal}` : `exit code ${code}.`}`)
        );
      }
    });
  });
}

async function startStaticServer(root: string): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const candidate = normalize(join(root, decodeURIComponent(requestUrl.pathname)));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const filePath = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!filePath || !existsSync(filePath)) {
      response.writeHead(404).end('Not found');
      return;
    }
    const stat = statSync(filePath);
    response.writeHead(200, {
      'Content-Length': String(stat.size),
      'Content-Type': contentType(filePath),
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    createReadStream(filePath).pipe(response);
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve test server address.');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }),
  };
}

const conformanceBody = [
  'const fs = require("node:fs");',
  'const fsp = require("node:fs/promises");',
  'const assert = (condition, message) => { if (!condition) throw new Error(message); };',
  'const code = (operation) => { try { operation(); return "ok"; } catch (error) { return error.code; } };',
  'fs.mkdirSync("sync-tree/nested", { recursive: true, mode: 0o750 });',
  'fs.writeFileSync("sync-tree/nested/value.txt", "sync-value");',
  'assert(fs.readFileSync("sync-tree/nested/value.txt", "utf8") === "sync-value", "sync read/write");',
  'assert(fs.statSync("sync-tree").isDirectory(), "sync directory stat");',
  'assert(fs.statSync("sync-tree/nested/value.txt").isFile(), "sync file stat");',
  'const syncEntries = fs.readdirSync("sync-tree", { recursive: true });',
  'assert(syncEntries.join("|") === "nested|nested/value.txt", "recursive readdir: " + syncEntries.join("|"));',
  'const syncDirents = fs.readdirSync("sync-tree/nested", { withFileTypes: true });',
  'assert(syncDirents.length === 1 && syncDirents[0].isFile(), "sync dirent");',
  'fs.renameSync("sync-tree/nested/value.txt", "sync-tree/nested/renamed.txt");',
  'assert(!fs.existsSync("sync-tree/nested/value.txt"), "rename removes source");',
  'assert(fs.readFileSync("sync-tree/nested/renamed.txt", "utf8") === "sync-value", "rename keeps bytes");',
  'fs.linkSync("sync-tree/nested/renamed.txt", "sync-tree/nested/hard.txt");',
  'const hardSource = fs.statSync("sync-tree/nested/renamed.txt");',
  'const hardAlias = fs.statSync("sync-tree/nested/hard.txt");',
  'assert(hardSource.ino === hardAlias.ino && hardSource.nlink === 2 && hardAlias.nlink === 2, "hard-link identity");',
  'fs.writeFileSync("sync-tree/nested/hard.txt", "hard-value");',
  'assert(fs.readFileSync("sync-tree/nested/renamed.txt", "utf8") === "hard-value", "hard-link shared bytes");',
  'fs.unlinkSync("sync-tree/nested/renamed.txt");',
  'assert(fs.statSync("sync-tree/nested/hard.txt").nlink === 1, "hard-link decrement");',
  'fs.symlinkSync("hard.txt", "sync-tree/nested/value-link");',
  'assert(fs.lstatSync("sync-tree/nested/value-link").isSymbolicLink(), "lstat symlink");',
  'assert(fs.statSync("sync-tree/nested/value-link").ino === hardAlias.ino, "stat follows symlink");',
  'assert(fs.readlinkSync("sync-tree/nested/value-link") === "hard.txt", "readlink literal target");',
  'const linkRealpath = fs.realpathSync("sync-tree/nested/value-link");',
  'assert(linkRealpath.endsWith("/sync-tree/nested/hard.txt"), "realpath symlink: " + linkRealpath);',
  'fs.writeFileSync("sync-tree/nested/value-link", "link-value");',
  'assert(fs.readFileSync("sync-tree/nested/hard.txt", "utf8") === "link-value", "write through symlink");',
  'fs.symlinkSync("missing.txt", "sync-tree/nested/dangling-link");',
  'assert(fs.lstatSync("sync-tree/nested/dangling-link").isSymbolicLink(), "dangling lstat");',
  'assert(code(() => fs.statSync("sync-tree/nested/dangling-link")) === "ENOENT", "dangling stat");',
  'fs.symlinkSync("loop-b", "sync-tree/nested/loop-a");',
  'fs.symlinkSync("loop-a", "sync-tree/nested/loop-b");',
  'assert(code(() => fs.statSync("sync-tree/nested/loop-a")) === "ELOOP", "symlink loop");',
  'fs.unlinkSync("sync-tree/nested/value-link");',
  'fs.unlinkSync("sync-tree/nested/dangling-link");',
  'fs.unlinkSync("sync-tree/nested/loop-a");',
  'fs.unlinkSync("sync-tree/nested/loop-b");',
  'fs.unlinkSync("sync-tree/nested/hard.txt");',
  'fs.rmdirSync("sync-tree/nested");',
  'fs.rmdirSync("sync-tree");',
  'assert(code(() => fs.statSync("sync-tree")) === "ENOENT", "ENOENT propagation");',
  '(async () => {',
  '  await fsp.mkdir("async-tree/nested", { recursive: true });',
  '  await fsp.writeFile("async-tree/nested/value.txt", "async-value");',
  '  assert(await fsp.readFile("async-tree/nested/value.txt", "utf8") === "async-value", "async read/write");',
  '  assert((await fsp.stat("async-tree")).isDirectory(), "async stat");',
  '  assert((await fsp.readdir("async-tree")).join("|") === "nested", "async readdir");',
  '  await fsp.rename("async-tree/nested/value.txt", "async-tree/nested/renamed.txt");',
  '  await fsp.unlink("async-tree/nested/renamed.txt");',
  '  await fsp.rmdir("async-tree/nested");',
  '  await fsp.rmdir("async-tree");',
  '  fs.mkdirSync("rm-tree/a/b", { recursive: true });',
  '  fs.writeFileSync("rm-tree/a/b/value.txt", "remove-me");',
  '  fs.rmSync("rm-tree", { recursive: true });',
  '  assert(!fs.existsSync("rm-tree"), "recursive rm");',
  '  fs.writeFileSync("conformance-" + __CONFORMANCE_LANGUAGE__ + ".txt", __CONFORMANCE_LANGUAGE__);',
  '  console.log(JSON.stringify({ language: __CONFORMANCE_LANGUAGE__, status: "pass" }));',
  '})();',
  '',
].join('\n');

const descriptorConformanceSource = [
  'const fs = require("node:fs");',
  'const fsp = require("node:fs/promises");',
  'const assert = (condition, message) => { if (!condition) throw new Error(message); };',
  'const text = (buffer) => Buffer.from(buffer).toString("utf8");',
  'fs.writeFileSync("descriptor.txt", "abcdef");',
  'const first = fs.openSync("descriptor.txt", "r+");',
  'const second = fs.openSync("descriptor.txt", "r");',
  'const a = Buffer.alloc(2);',
  'const b = Buffer.alloc(2);',
  'assert(fs.readSync(first, a, 0, 2, null) === 2 && text(a) === "ab", "first offset");',
  'assert(fs.readSync(second, b, 0, 2, null) === 2 && text(b) === "ab", "independent offset");',
  'const positioned = Buffer.alloc(2);',
  'fs.readSync(first, positioned, 0, 2, 0);',
  'assert(text(positioned) === "ab", "positioned read");',
  'const afterPositioned = Buffer.alloc(2);',
  'fs.readSync(first, afterPositioned, 0, 2, null);',
  'assert(text(afterPositioned) === "cd", "positioned read changed shared offset");',
  'const inodeBeforeRename = fs.fstatSync(first).ino;',
  'fs.renameSync("descriptor.txt", "descriptor-renamed.txt");',
  'fs.writeSync(first, Buffer.from("XY"), 0, 2, 0);',
  'assert(fs.readFileSync("descriptor-renamed.txt", "utf8") === "XYcdef", "descriptor did not follow rename");',
  'assert(fs.fstatSync(first).ino === inodeBeforeRename, "inode changed across rename");',
  'fs.unlinkSync("descriptor-renamed.txt");',
  'fs.writeSync(first, Buffer.from("Z"), 0, 1, 2);',
  'const detached = Buffer.alloc(6);',
  'fs.readSync(first, detached, 0, 6, 0);',
  'assert(text(detached) === "XYZdef", "unlinked descriptor lost node");',
  'fs.writeFileSync("descriptor-renamed.txt", "replacement");',
  'assert(fs.readFileSync("descriptor-renamed.txt", "utf8") === "replacement", "replacement path wrong");',
  'const stillDetached = Buffer.alloc(6);',
  'fs.readSync(first, stillDetached, 0, 6, 0);',
  'assert(text(stillDetached) === "XYZdef", "replacement rebound detached descriptor");',
  'fs.ftruncateSync(first, 3);',
  'assert(fs.fstatSync(first).size === 3, "ftruncate/fstat");',
  'fs.closeSync(second);',
  'fs.closeSync(first);',
  'fs.writeFileSync("snapshot-before-unlink.txt", "before");',
  'const snapshotFd = fs.openSync("snapshot-before-unlink.txt", "r");',
  'fs.writeFileSync("snapshot-before-unlink.txt", "latest-before-unlink");',
  'fs.unlinkSync("snapshot-before-unlink.txt");',
  'const snapshotted = Buffer.alloc(32);',
  'const snapshottedBytes = fs.readSync(snapshotFd, snapshotted, 0, snapshotted.length, 0);',
  'assert(text(snapshotted.subarray(0, snapshottedBytes)) === "latest-before-unlink", "pre-unlink snapshot lost latest bytes");',
  'fs.closeSync(snapshotFd);',
  'const append = fs.openSync("append.txt", "a+");',
  'fs.writeSync(append, "one");',
  'fs.writeSync(append, "two", 0, "utf8");',
  'assert(fs.readFileSync("append.txt", "utf8") === "onetwo", "append ignored EOF");',
  'fs.closeSync(append);',
  'const writeStream = fs.createWriteStream("stream.txt");',
  'let writeStreamError = null;',
  'writeStream.on("error", (error) => { writeStreamError = error; });',
  'assert(writeStream.write("stream-value") === true, "write stream rejected: " + (writeStreamError && writeStreamError.message));',
  'assert(fs.readFileSync("stream.txt", "utf8") === "stream-value", "descriptor-backed write stream");',
  'writeStream.end();',
  'const readStream = fs.createReadStream("stream.txt");',
  'assert(String(readStream.read()) === "stream-value", "descriptor-backed read stream");',
  '(async () => {',
  '  const handle = await fsp.open("handle.txt", "w+");',
  '  await handle.write(Buffer.from("handle"));',
  '  const read = Buffer.alloc(6);',
  '  const result = await handle.read(read, 0, 6, 0);',
  '  assert(result.bytesRead === 6 && text(read) === "handle", "FileHandle read/write");',
  '  await handle.truncate(4);',
  '  assert((await handle.stat()).size === 4, "FileHandle truncate/stat");',
  '  await handle.close();',
  '  console.log(JSON.stringify({ descriptorStatus: "pass" }));',
  '})();',
  '',
].join('\n');

function conformanceSource(language: 'javascript' | 'typescript'): string {
  const languageLiteral = JSON.stringify(language);
  const source = conformanceBody.replaceAll('__CONFORMANCE_LANGUAGE__', languageLiteral);
  if (language === 'javascript') return source;
  return [
    'declare function require(id: string): any;',
    source
      .replace(
        'const assert = (condition, message) =>',
        'const assert: (condition: unknown, message: string) => asserts condition = (condition, message) =>'
      )
      .replace(
        'const code = (operation) =>',
        'const code = (operation: () => unknown) =>'
      )
      .replace(
        '} catch (error) { return error.code; }',
        '} catch (error) { return (error as { code?: string }).code; }'
      ),
  ].join('\n');
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracekernel-013-javascript-'));
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    await syncAssets(join(tempRoot, 'workers'));
    await build({
      entryPoints: [resolve('packages/harness-browser/src/project.ts')],
      outfile: join(tempRoot, 'project-harness.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      logLevel: 'warning',
      alias: {
        zlib: resolve('packages/harness-project/src/zlib-browser-shim.ts'),
        'node:zlib': resolve('packages/harness-project/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n');
    server = await startStaticServer(tempRoot);

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(60_000);
      const browserErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') browserErrors.push(message.text());
      });
      page.on('pageerror', (error) => browserErrors.push(error.message));
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
      await page.evaluate('globalThis.__name = (fn) => fn');
      const result = await page.evaluate(async ({
        javascriptSource,
        typescriptSource,
        descriptorSource,
      }) => {
        // @ts-expect-error This module is generated into the browser test server.
        const { createBrowserProjectWorkspace } = await import('/project-harness.mjs');
        const workspace = await createBrowserProjectWorkspace({
          assetBaseUrl: '/workers',
          providers: ['javascript', 'typescript'],
          projectWorkerIsolation: 'per-command',
          nodeProjectTimeoutMs: 30_000,
          files: [
            { path: 'shared.txt', contents: 'before-writer' },
            {
              path: 'reader.js',
              contents: [
                'const fs = require("node:fs");',
                'const initial = fs.readFileSync("shared.txt", "utf8");',
                'console.log("reader:started:" + initial);',
                'const deadline = performance.now() + 5000;',
                'let observed = initial;',
                'while (performance.now() < deadline) {',
                '  observed = fs.readFileSync("shared.txt", "utf8");',
                '  if (observed === "from-writer") break;',
                '}',
                'console.log("reader:observed:" + observed);',
                '',
              ].join('\n'),
            },
            {
              path: 'writer.js',
              contents: 'require("node:fs").writeFileSync("shared.txt", "from-writer");\n',
            },
            { path: 'descriptor-shared.txt', contents: 'before-descriptor-writer' },
            {
              path: 'descriptor-reader.js',
              contents: [
                'const fs = require("node:fs");',
                'const fd = fs.openSync("descriptor-shared.txt", "r");',
                'const read = () => {',
                '  const buffer = Buffer.alloc(64);',
                '  const count = fs.readSync(fd, buffer, 0, buffer.length, 0);',
                '  return buffer.subarray(0, count).toString("utf8");',
                '};',
                'const initial = read();',
                'console.log("descriptor-reader:started:" + initial);',
                'const deadline = performance.now() + 5000;',
                'let observed = initial;',
                'while (performance.now() < deadline) {',
                '  observed = read();',
                '  if (observed === "from-descriptor-writer") break;',
                '}',
                'fs.closeSync(fd);',
                'console.log("descriptor-reader:observed:" + observed);',
                '',
              ].join('\n'),
            },
            {
              path: 'descriptor-writer.js',
              contents: 'require("node:fs").writeFileSync("descriptor-shared.txt", "from-descriptor-writer");\n',
            },
            { path: 'namespace-target.txt', contents: 'before-namespace-writer' },
            {
              path: 'namespace-reader.js',
              contents: [
                'const fs = require("node:fs");',
                'console.log("namespace-reader:started");',
                'const deadline = performance.now() + 5000;',
                'let observed = false;',
                'while (performance.now() < deadline) {',
                '  try {',
                '    const target = fs.statSync("namespace-target.txt");',
                '    const hard = fs.statSync("namespace-hard.txt");',
                '    const link = fs.lstatSync("namespace-link.txt");',
                '    observed = target.ino === hard.ino && target.nlink === 2 && hard.nlink === 2',
                '      && link.isSymbolicLink()',
                '      && fs.readlinkSync("namespace-link.txt") === "namespace-target.txt"',
                '      && fs.readFileSync("namespace-link.txt", "utf8") === "namespace-shared";',
                '    if (observed) break;',
                '  } catch (error) {',
                '    if (error.code !== "ENOENT") throw error;',
                '  }',
                '}',
                'console.log("namespace-reader:observed:" + observed);',
                '',
              ].join('\n'),
            },
            {
              path: 'namespace-writer.js',
              contents: [
                'const fs = require("node:fs");',
                'fs.linkSync("namespace-target.txt", "namespace-hard.txt");',
                'fs.symlinkSync("namespace-target.txt", "namespace-link.txt");',
                'fs.writeFileSync("namespace-hard.txt", "namespace-shared");',
                '',
              ].join('\n'),
            },
            {
              path: 'tcp-server.js',
              contents: [
                'const net = require("node:net");',
                'const server = net.createServer((socket) => {',
                '  socket.setEncoding("utf8");',
                '  socket.on("data", (chunk) => {',
                '    socket.end("echo:" + chunk);',
                '    server.close();',
                '  });',
                '});',
                'server.on("error", (error) => { throw error; });',
                'server.listen(41234, "127.0.0.1", () => {',
                '  console.log("tcp-server:listening");',
                '});',
                '',
              ].join('\n'),
            },
            {
              path: 'tcp-client.js',
              contents: [
                'const net = require("node:net");',
                'let response = "";',
                'const socket = net.connect(41234, "127.0.0.1", () => {',
                '  socket.end("ping");',
                '});',
                'socket.setEncoding("utf8");',
                'socket.on("data", (chunk) => { response += chunk; });',
                'socket.on("end", () => {',
                '  console.log("tcp-client:response:" + response);',
                '});',
                'socket.on("error", (error) => { throw error; });',
                '',
              ].join('\n'),
            },
            {
              path: 'http-server.js',
              contents: [
                'const http = require("node:http");',
                'const server = http.createServer((request, response) => {',
                '  let body = "";',
                '  request.setEncoding("utf8");',
                '  request.on("data", (chunk) => { body += chunk; });',
                '  request.on("end", () => {',
                '    response.writeHead(211, { "X-TraceKernel-Transport": "tcp" });',
                '    response.end("http:" + request.method + ":" + request.url + ":" + body);',
                '    server.close();',
                '  });',
                '});',
                'server.on("error", (error) => { throw error; });',
                'server.listen(41236, "127.0.0.1", () => {',
                '  console.log("http-server:listening");',
                '});',
                '',
              ].join('\n'),
            },
            {
              path: 'http-raw-client.js',
              contents: [
                'const net = require("node:net");',
                'let response = "";',
                'const socket = net.connect(41236, "127.0.0.1", () => {',
                '  socket.end("POST /from-net HTTP/1.1\\r\\nHost: browser.local:41236\\r\\nContent-Length: 4\\r\\n\\r\\nping");',
                '});',
                'socket.setEncoding("utf8");',
                'socket.on("data", (chunk) => { response += chunk; });',
                'socket.on("end", () => {',
                '  console.log("http-raw-client:response:" + JSON.stringify(response));',
                '});',
                'socket.on("error", (error) => { throw error; });',
                '',
              ].join('\n'),
            },
            {
              path: 'raw-http-server.js',
              contents: [
                'const net = require("node:net");',
                'const server = net.createServer((socket) => {',
                '  let request = "";',
                '  socket.setEncoding("utf8");',
                '  socket.on("data", (chunk) => {',
                '    request += chunk;',
                '    if (!request.includes("\\r\\n\\r\\n")) return;',
                '    const body = "raw-server:" + request.split("\\r\\n", 1)[0];',
                '    socket.end("HTTP/1.1 212 \\r\\nX-Raw-Server: yes\\r\\nContent-Length: " + body.length + "\\r\\n\\r\\n" + body);',
                '    server.close();',
                '  });',
                '});',
                'server.on("error", (error) => { throw error; });',
                'server.listen(41237, "127.0.0.1", () => {',
                '  console.log("raw-http-server:listening");',
                '});',
                '',
              ].join('\n'),
            },
            {
              path: 'node-http-client.js',
              contents: [
                'const http = require("node:http");',
                'const request = http.request({',
                '  hostname: "127.0.0.1",',
                '  port: 41237,',
                '  method: "PUT",',
                '  path: "/from-http",',
                '  headers: { "X-Node-Http": "yes" },',
                '}, (response) => {',
                '  let body = "";',
                '  response.setEncoding("utf8");',
                '  response.on("data", (chunk) => { body += chunk; });',
                '  response.on("end", () => {',
                '    console.log("node-http-client:response:" + response.statusCode + ":" + response.headers["x-raw-server"] + ":" + body);',
                '  });',
                '});',
                'request.on("error", (error) => { throw error; });',
                'request.end();',
                '',
              ].join('\n'),
            },
            { path: 'host-cycle.txt', contents: 'before-host-cycle' },
            {
              path: 'host-cycle-reader.js',
              contents: [
                'const fs = require("node:fs");',
                'const fd = fs.openSync("host-cycle.txt", "r");',
                'console.log("host-cycle-reader:started");',
                'const deadline = performance.now() + 5000;',
                'while (performance.now() < deadline && !fs.existsSync("host-cycle-ready.txt")) {}',
                'const buffer = Buffer.alloc(64);',
                'const count = fs.readSync(fd, buffer, 0, buffer.length, 0);',
                'fs.closeSync(fd);',
                'console.log("host-cycle-reader:observed:" + buffer.subarray(0, count).toString("utf8"));',
                '',
              ].join('\n'),
            },
            {
              path: 'spawn-child.js',
              contents: [
                'const fs = require("node:fs");',
                'fs.writeFileSync("spawn-child.txt", `${process.ppid}:${process.pid}`);',
                '',
              ].join('\n'),
            },
            {
              path: 'spawn-parent.js',
              contents: [
                'const fs = require("node:fs");',
                'const { spawn } = require("node:child_process");',
                'const child = spawn("node", ["spawn-child.js"], { stdio: "inherit" });',
                'child.on("error", (error) => { throw error; });',
                'child.on("close", (code, signal) => {',
                '  const identity = fs.readFileSync("spawn-child.txt", "utf8");',
                '  const [ppid, pid] = identity.split(":").map(Number);',
                '  console.log(`spawn:${code}:${signal}:${ppid === process.pid}:${pid === child.pid}`);',
                '});',
                '',
              ].join('\n'),
            },
            {
              path: 'stdio-child.js',
              contents: [
                'let input = "";',
                'process.stdin.setEncoding("utf8");',
                'process.stdin.on("data", (chunk) => { input += chunk; });',
                'process.stdin.on("end", () => {',
                '  const summary = Buffer.from(`child-stdout:${input.length}:${input.slice(0, 5)}:${input.slice(-5)}`);',
                '  process.stdout.write(Buffer.concat([summary, Buffer.from([0, 255, 1, 254])]));',
                '  process.stderr.write(`child-stderr:${input.length}`);',
                '});',
                '',
              ].join('\n'),
            },
            {
              path: 'stdio-parent.js',
              contents: [
                'const { spawn } = require("node:child_process");',
                'const child = spawn("node", ["stdio-child.js"]);',
                'const stdoutChunks = [];',
                'let stderr = "";',
                'let drained = false;',
                'child.stderr.setEncoding("utf8");',
                'child.stdout.on("data", (chunk) => { stdoutChunks.push(chunk); });',
                'child.stderr.on("data", (chunk) => { stderr += chunk; });',
                'child.stdin.on("drain", () => { drained = true; });',
                'const input = "alpha" + "x".repeat(96 * 1024) + "omega";',
                'const accepted = child.stdin.write(input);',
                'child.stdin.end();',
                'child.on("error", (error) => { throw error; });',
                'child.on("close", (code, signal) => {',
                '  const stdout = Buffer.concat(stdoutChunks);',
                '  console.log(JSON.stringify({',
                '    code, signal, accepted, drained,',
                '    stdout: stdout.subarray(0, -4).toString("utf8"),',
                '    stdoutHex: stdout.subarray(-4).toString("hex"),',
                '    stderr,',
                '  }));',
                '});',
                '',
              ].join('\n'),
            },
            { path: 'isolation-private.txt', contents: 'parent-descriptor' },
            {
              path: 'isolation-child.js',
              contents: [
                'const fs = require("node:fs");',
                'const inheritedNumber = Number(process.argv[2]);',
                'const report = {',
                '  inheritedEnv: process.env.TRACEKERNEL_ISOLATION,',
                '  inheritedPrototype: Array.prototype.tracekernelIsolation ?? null,',
                '  inheritedGlobal: globalThis.tracekernelIsolation ?? null,',
                '  parentDescriptorRead: null,',
                '};',
                'try {',
                '  const bytes = Buffer.alloc(32);',
                '  const count = fs.readSync(inheritedNumber, bytes, 0, bytes.length, 0);',
                '  report.parentDescriptorRead = bytes.subarray(0, count).toString("utf8");',
                '} catch (error) {',
                '  report.parentDescriptorRead = error.code;',
                '}',
                'process.env.TRACEKERNEL_ISOLATION = "child-env";',
                'Array.prototype.tracekernelIsolation = "child-prototype";',
                'globalThis.tracekernelIsolation = { owner: "child" };',
                'fs.writeFileSync("isolation-report.json", JSON.stringify(report));',
                '',
              ].join('\n'),
            },
            {
              path: 'isolation-parent.js',
              contents: [
                'const fs = require("node:fs");',
                'const { spawn } = require("node:child_process");',
                'const memory = Buffer.from("parent-memory");',
                'const state = { owner: "parent", count: 7 };',
                'globalThis.tracekernelIsolation = state;',
                'Array.prototype.tracekernelIsolation = "parent-prototype";',
                'process.env.TRACEKERNEL_ISOLATION = "parent-env";',
                'const fd = fs.openSync("isolation-private.txt", "r");',
                'const child = spawn("node", ["isolation-child.js", String(fd)], { stdio: "inherit" });',
                'child.on("error", (error) => { throw error; });',
                'child.on("close", (code) => {',
                '  const bytes = Buffer.alloc(32);',
                '  const count = fs.readSync(fd, bytes, 0, bytes.length, 0);',
                '  fs.closeSync(fd);',
                '  const report = JSON.parse(fs.readFileSync("isolation-report.json", "utf8"));',
                '  const isolated = code === 0 &&',
                '    memory.toString("utf8") === "parent-memory" &&',
                '    state.owner === "parent" && state.count === 7 &&',
                '    globalThis.tracekernelIsolation === state &&',
                '    Array.prototype.tracekernelIsolation === "parent-prototype" &&',
                '    process.env.TRACEKERNEL_ISOLATION === "parent-env" &&',
                '    bytes.subarray(0, count).toString("utf8") === "parent-descriptor" &&',
                '    report.inheritedEnv === "parent-env" &&',
                '    report.inheritedPrototype === null &&',
                '    report.inheritedGlobal === null &&',
                '    report.parentDescriptorRead === "EBADF";',
                '  delete Array.prototype.tracekernelIsolation;',
                '  delete globalThis.tracekernelIsolation;',
                '  delete process.env.TRACEKERNEL_ISOLATION;',
                '  console.log(`isolation:${isolated}:${child.pid !== process.pid}`);',
                '});',
                '',
              ].join('\n'),
            },
            { path: 'conformance.js', contents: javascriptSource },
            { path: 'descriptor-conformance.js', contents: descriptorSource },
            { path: 'conformance.ts', contents: typescriptSource },
            {
              path: 'tsconfig.json',
              contents: JSON.stringify({
                compilerOptions: {
                  module: 'commonjs',
                  target: 'es2020',
                  strict: true,
                  outDir: 'compiled',
                },
                files: ['conformance.ts'],
              }),
            },
          ],
        });
        try {
          let markReaderStarted!: () => void;
          const readerStarted = new Promise<void>((resolvePromise) => {
            markReaderStarted = resolvePromise;
          });
          const reader = workspace.runCommand('node reader.js', {
            onEvent(event: { type: string; stream?: string; data?: string }) {
              if (
                event.type === 'output' &&
                event.stream === 'stdout' &&
                event.data?.includes('reader:started:before-writer')
              ) {
                markReaderStarted();
              }
            },
          });
          await Promise.race([
            readerStarted,
            reader.then((command: unknown) => {
              throw new Error(`reader exited before startup: ${JSON.stringify(command)}`);
            }),
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error('reader did not start')), 10_000);
            }),
          ]);
          const writer = await workspace.runCommand('node writer.js');
          const readerResult = await reader;
          let markDescriptorReaderStarted!: () => void;
          const descriptorReaderStarted = new Promise<void>((resolvePromise) => {
            markDescriptorReaderStarted = resolvePromise;
          });
          const descriptorReader = workspace.runCommand('node descriptor-reader.js', {
            onEvent(event: { type: string; stream?: string; data?: string }) {
              if (
                event.type === 'output' &&
                event.stream === 'stdout' &&
                event.data?.includes('descriptor-reader:started:before-descriptor-writer')
              ) {
                markDescriptorReaderStarted();
              }
            },
          });
          await Promise.race([
            descriptorReaderStarted,
            descriptorReader.then((command: unknown) => {
              throw new Error(`descriptor reader exited before startup: ${JSON.stringify(command)}`);
            }),
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error('descriptor reader did not start')), 10_000);
            }),
          ]);
          const descriptorWriter = await workspace.runCommand('node descriptor-writer.js');
          const descriptorReaderResult = await descriptorReader;
          let markNamespaceReaderStarted!: () => void;
          const namespaceReaderStarted = new Promise<void>((resolvePromise) => {
            markNamespaceReaderStarted = resolvePromise;
          });
          const namespaceReader = workspace.runCommand('node namespace-reader.js', {
            onEvent(event: { type: string; stream?: string; data?: string }) {
              if (
                event.type === 'output' &&
                event.stream === 'stdout' &&
                event.data?.includes('namespace-reader:started')
              ) {
                markNamespaceReaderStarted();
              }
            },
          });
          await Promise.race([
            namespaceReaderStarted,
            namespaceReader.then((command: unknown) => {
              throw new Error(`namespace reader exited before startup: ${JSON.stringify(command)}`);
            }),
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error('namespace reader did not start')), 10_000);
            }),
          ]);
          const namespaceWriter = await workspace.runCommand('node namespace-writer.js');
          const namespaceReaderResult = await namespaceReader;
          let markTcpServerStarted!: () => void;
          const tcpServerStarted = new Promise<void>((resolvePromise) => {
            markTcpServerStarted = resolvePromise;
          });
          const tcpServer = workspace.runCommand('node tcp-server.js', {
            onEvent(event: { type: string; stream?: string; data?: string }) {
              if (
                event.type === 'output' &&
                event.stream === 'stdout' &&
                event.data?.includes('tcp-server:listening')
              ) {
                markTcpServerStarted();
              }
            },
          });
          await Promise.race([
            tcpServerStarted,
            tcpServer.then((command: unknown) => {
              throw new Error(`TCP server exited before listening: ${JSON.stringify(command)}`);
            }),
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error('TCP server did not start')), 10_000);
            }),
          ]);
          const tcpClient = await workspace.runCommand('node tcp-client.js');
          const tcpServerResult = await tcpServer;
          let markHttpServerStarted!: () => void;
          const httpServerStarted = new Promise<void>((resolvePromise) => {
            markHttpServerStarted = resolvePromise;
          });
          const httpServer = workspace.runCommand('node http-server.js', {
            onEvent(event: { type: string; stream?: string; data?: string }) {
              if (
                event.type === 'output' &&
                event.stream === 'stdout' &&
                event.data?.includes('http-server:listening')
              ) {
                markHttpServerStarted();
              }
            },
          });
          await Promise.race([
            httpServerStarted,
            httpServer.then((command: unknown) => {
              throw new Error(`HTTP server exited before listening: ${JSON.stringify(command)}`);
            }),
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error('HTTP server did not start')), 10_000);
            }),
          ]);
          const httpRawClient = await workspace.runCommand('node http-raw-client.js');
          const httpServerResult = await httpServer;
          let markRawHttpServerStarted!: () => void;
          const rawHttpServerStarted = new Promise<void>((resolvePromise) => {
            markRawHttpServerStarted = resolvePromise;
          });
          const rawHttpServer = workspace.runCommand('node raw-http-server.js', {
            onEvent(event: { type: string; stream?: string; data?: string }) {
              if (
                event.type === 'output' &&
                event.stream === 'stdout' &&
                event.data?.includes('raw-http-server:listening')
              ) {
                markRawHttpServerStarted();
              }
            },
          });
          await Promise.race([
            rawHttpServerStarted,
            rawHttpServer.then((command: unknown) => {
              throw new Error(`Raw HTTP server exited before listening: ${JSON.stringify(command)}`);
            }),
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error('Raw HTTP server did not start')), 10_000);
            }),
          ]);
          const nodeHttpClient = await workspace.runCommand('node node-http-client.js');
          const rawHttpServerResult = await rawHttpServer;
          let markHostCycleReaderStarted!: () => void;
          const hostCycleReaderStarted = new Promise<void>((resolvePromise) => {
            markHostCycleReaderStarted = resolvePromise;
          });
          const hostCycleReader = workspace.runCommand('node host-cycle-reader.js', {
            onEvent(event: { type: string; stream?: string; data?: string }) {
              if (
                event.type === 'output' &&
                event.stream === 'stdout' &&
                event.data?.includes('host-cycle-reader:started')
              ) {
                markHostCycleReaderStarted();
              }
            },
          });
          await Promise.race([
            hostCycleReaderStarted,
            hostCycleReader.then((command: unknown) => {
              throw new Error(`host-cycle reader exited before startup: ${JSON.stringify(command)}`);
            }),
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error('host-cycle reader did not start')), 10_000);
            }),
          ]);
          await workspace.writeFile('host-cycle.txt', 'latest-before-host-delete');
          await workspace.deleteFile('host-cycle.txt');
          await workspace.writeFile('host-cycle.txt', 'host-replacement');
          await workspace.writeFile('host-cycle-ready.txt', 'ready');
          const hostCycleReaderResult = await hostCycleReader;
          const spawnedChild = await workspace.runCommand('node spawn-parent.js');
          const pipedChild = await workspace.runCommand('node stdio-parent.js');
          const processIsolation = await workspace.runCommand('node isolation-parent.js');
          const javascript = await workspace.runCommand('node conformance.js');
          const descriptors = await workspace.runCommand('node descriptor-conformance.js');
          const compile = await workspace.runCommand('tsc --project tsconfig.json');
          const typescript = compile.exitCode === 0
            ? await workspace.runCommand('node compiled/conformance.js')
            : null;
          const restricted = workspace.kernel.createProcess({
            name: 'restricted-javascript',
            actor: {
              id: 'restricted-javascript',
              kind: 'runtime',
              capabilities: {
                read: ['**'],
                write: [],
                delete: [],
                execute: true,
              },
            },
            signalPolicy: 'system-only',
          });
          let restrictedWrite;
          let restrictedListen;
          try {
            restrictedWrite = await restricted.runCommand(
              'node -e "require(\\\"node:fs\\\").writeFileSync(\\\"blocked.txt\\\", \\\"blocked\\\")"'
            );
            restrictedListen = await restricted.runCommand(
              'node -e "require(\\\"node:net\\\").createServer().listen(41235, \\\"127.0.0.1\\\")"'
            );
          } finally {
            restricted.dispose();
          }
          return {
            reader: readerResult,
            writer,
            descriptorReader: descriptorReaderResult,
            descriptorWriter,
            namespaceReader: namespaceReaderResult,
            namespaceWriter,
            tcpServer: tcpServerResult,
            tcpClient,
            httpServer: httpServerResult,
            httpRawClient,
            rawHttpServer: rawHttpServerResult,
            nodeHttpClient,
            hostCycleReader: hostCycleReaderResult,
            spawnedChild,
            pipedChild,
            processIsolation,
            javascript,
            descriptors,
            compile,
            typescript,
            restrictedWrite,
            restrictedListen,
            blockedExists: await workspace.exists('blocked.txt'),
            shared: await workspace.readFile('shared.txt'),
            hostCycle: await workspace.readFile('host-cycle.txt'),
            spawnChild: await workspace.readFile('spawn-child.txt'),
            isolationReport: JSON.parse(await workspace.readFile('isolation-report.json')),
            javascriptMarker: javascript.exitCode === 0
              ? await workspace.readFile('conformance-javascript.txt')
              : null,
            typescriptMarker: typescript?.exitCode === 0
              ? await workspace.readFile('conformance-typescript.txt')
              : null,
          };
        } finally {
          workspace.dispose();
        }
      }, {
        javascriptSource: conformanceSource('javascript'),
        typescriptSource: conformanceSource('typescript'),
        descriptorSource: descriptorConformanceSource,
      });

      assertCondition(
        result.writer.exitCode === 0 &&
          result.reader.exitCode === 0 &&
          result.reader.stdout.includes('reader:observed:from-writer') &&
          result.shared === 'from-writer',
        `An already-running JS worker did not observe a peer's write: ${JSON.stringify(result)}`
      );
      assertCondition(
        result.hostCycleReader.exitCode === 0 &&
          result.hostCycleReader.stdout.includes(
            'host-cycle-reader:observed:latest-before-host-delete'
          ) &&
          result.hostCycle === 'host-replacement',
        `Host unlink/recreate did not preserve the open descriptor node: ${JSON.stringify(result)}`
      );
      assertCondition(
        result.spawnedChild.exitCode === 0 &&
          result.spawnedChild.stdout.includes('spawn:0:null:true:true') &&
          /^[0-9]+:[0-9]+$/.test(result.spawnChild),
        `node:child_process did not acquire and reap a distinct worker process: ${JSON.stringify(result)}`
      );
      assertCondition(
        result.pipedChild.exitCode === 0 &&
          result.pipedChild.stdout.includes('"code":0') &&
          result.pipedChild.stdout.includes('"accepted":false') &&
          result.pipedChild.stdout.includes('"drained":true') &&
          result.pipedChild.stdout.includes('child-stdout:98314:alpha:omega') &&
          result.pipedChild.stdout.includes('"stdoutHex":"00ff01fe"') &&
          result.pipedChild.stdout.includes('child-stderr:98314'),
        `node:child_process stdio did not preserve bytes, EOF, and backpressure: ${JSON.stringify(result)}`
      );
      assertCondition(
        result.processIsolation.exitCode === 0 &&
          result.processIsolation.stdout.includes('isolation:true:true') &&
          result.isolationReport.inheritedEnv === 'parent-env' &&
          result.isolationReport.inheritedPrototype === null &&
          result.isolationReport.inheritedGlobal === null &&
          result.isolationReport.parentDescriptorRead === 'EBADF',
        `A child process mutated or acquired parent-private process state: ${JSON.stringify(result)}`
      );
      assertCondition(
        result.descriptorWriter.exitCode === 0 &&
          result.descriptorReader.exitCode === 0 &&
          result.descriptorReader.stdout.includes(
            'descriptor-reader:observed:from-descriptor-writer'
          ),
        `An open descriptor did not observe a peer write: ${JSON.stringify(result)}`
      );
      assertCondition(
        result.namespaceWriter.exitCode === 0 &&
          result.namespaceReader.exitCode === 0 &&
          result.namespaceReader.stdout.includes('namespace-reader:observed:true'),
        `An already-running worker did not observe peer namespace changes: ${JSON.stringify(result)}`
      );
      assertCondition(
        result.tcpServer.exitCode === 0 &&
          result.tcpClient.exitCode === 0 &&
          result.tcpServer.stdout.includes('tcp-server:listening') &&
          result.tcpClient.stdout.includes('tcp-client:response:echo:ping'),
        `Cross-process node:net traffic did not traverse TraceKernel: ${JSON.stringify(result)}`
      );
      assertCondition(
        result.httpServer.exitCode === 0 &&
          result.httpRawClient.exitCode === 0 &&
          result.httpRawClient.stdout.includes('HTTP/1.1 211') &&
          result.httpRawClient.stdout.includes('X-TraceKernel-Transport: tcp') &&
          result.httpRawClient.stdout.includes('http:POST:/from-net:ping'),
        `A raw node:net client did not reach node:http over TraceKernel TCP: ${JSON.stringify(result)}`
      );
      assertCondition(
        result.rawHttpServer.exitCode === 0 &&
          result.nodeHttpClient.exitCode === 0 &&
          result.nodeHttpClient.stdout.includes(
            'node-http-client:response:212:yes:raw-server:PUT /from-http HTTP/1.1'
          ),
        `A node:http client did not reach a raw node:net HTTP server: ${JSON.stringify(result)}`
      );
      assertCondition(
        result.descriptors.exitCode === 0 &&
          result.descriptors.stdout.includes('"descriptorStatus":"pass"'),
        `JavaScript descriptor syscall conformance failed: ${JSON.stringify(result)}`
      );
      assertCondition(
        result.javascript.exitCode === 0 &&
          result.javascript.stdout.includes('"language":"javascript","status":"pass"') &&
          result.javascriptMarker === 'javascript',
        `JavaScript path syscall conformance failed: ${JSON.stringify(result)}`
      );
      assertCondition(
        result.compile.exitCode === 0 &&
          result.typescript?.exitCode === 0 &&
          result.typescript.stdout.includes('"language":"typescript","status":"pass"') &&
          result.typescriptMarker === 'typescript',
        `TypeScript-emitted JavaScript path syscall conformance failed: ${JSON.stringify(result)}`
      );
      assertCondition(
        result.restrictedWrite.exitCode !== 0 &&
          result.restrictedWrite.stderr.includes('EACCES') &&
          result.blockedExists === false,
        `The host syscall handler did not enforce actor write capabilities: ${JSON.stringify(result)}`
      );
      assertCondition(
        result.restrictedListen.exitCode !== 0 &&
          result.restrictedListen.stderr.includes('EACCES'),
        `The async socket handler did not enforce actor listen capabilities: ${JSON.stringify(result)}`
      );
      assertCondition(
        browserErrors.length === 0,
        `Browser emitted unexpected errors: ${JSON.stringify(browserErrors)}`
      );

      const generatedWorkerPath = resolve('workers/javascript/javascript-project-worker.js');
      const generatedWorker = await readFile(generatedWorkerPath, 'utf8');
      assertCondition(
        !generatedWorker.includes('effect/Effect') && !generatedWorker.includes('EffectPrimitive'),
        'The browser runtime worker must not bundle the host-side Effect implementation.'
      );
      console.log(JSON.stringify({
        schema: 'tracekernel-013-javascript-conformance-v1',
        liveCrossWorkerVisibility: true,
        pathOperations: [
          'readFile',
          'writeFile',
          'stat',
          'readdir',
          'mkdir',
          'rmdir',
          'unlink',
          'rename',
          'link',
          'symlink',
          'readlink',
          'lstat',
          'realpath',
          'recursive-rm',
        ],
        descriptorOperations: [
          'open',
          'read',
          'write',
          'close',
          'fstat',
          'ftruncate',
          'positioned-io',
          'append',
          'rename-survival',
          'unlink-survival',
          'streams',
          'cross-worker-live-read',
          'cross-worker-namespace-visibility',
        ],
        networkOperations: [
          'node:net-listen',
          'node:net-connect',
          'bidirectional-stream',
          'cross-process-half-close',
          'node:http-over-raw-tcp',
          'node:http-client-to-raw-tcp',
        ],
        processOperations: [
          'node:child_process-spawn',
          'distinct-child-pid',
          'parent-pid-topology',
          'child-wait-and-reap',
          'kernel-piped-stdin-stdout-stderr',
          'pipe-eof-and-backpressure',
          'heap-and-global-isolation',
          'environment-copy-on-spawn',
          'descriptor-non-inheritance',
        ],
        adapters: ['javascript', 'typescript-emitted-javascript'],
        hostCapabilityEnforcement: true,
        generatedWorkerBytes: statSync(generatedWorkerPath).size,
        hostEffectBundledIntoRuntime: false,
      }, null, 2));
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

#!/usr/bin/env npx tsx

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}

async function syncPythonAssets(targetDirectory: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      resolve('node_modules/tsx/dist/cli.mjs'),
      resolve('src/cli.ts'),
      'sync-assets',
      targetDirectory,
      '--languages',
      'python,javascript',
    ], { cwd: process.cwd(), stdio: 'inherit' });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(
            `Asset sync failed with ${signal ? `signal ${signal}` : `exit code ${code}.`}`
          )
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
    const candidate = normalize(
      join(root, decodeURIComponent(requestUrl.pathname))
    );
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
    throw new Error('Unable to resolve Python test server address.');
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

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracekernel-013-python-'));
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    await syncPythonAssets(join(tempRoot, 'workers'));
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
    await writeFile(
      join(tempRoot, 'index.html'),
      '<!doctype html><meta charset="utf-8">\n'
    );
    server = await startStaticServer(tempRoot);

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(180_000);
      const browserErrors: string[] = [];
      page.on('pageerror', (error) => browserErrors.push(error.message));
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
      await page.evaluate('globalThis.__name = (fn) => fn');
      const result = await page.evaluate(async () => {
        // @ts-expect-error Generated into the browser test server.
        const { createBrowserProjectWorkspace } = await import('/project-harness.mjs');
        const workspace = await createBrowserProjectWorkspace({
          assetBaseUrl: '/workers',
          providers: ['python', 'javascript'],
          projectWorkerIsolation: 'per-command',
          pythonProjectTimeoutMs: 120_000,
          files: [
            {
              path: 'watchdog-control.py',
              contents: [
                'from tracekernel import watchdog',
                'armed = watchdog.arm(5000, signal="SIGKILL")',
                'status = watchdog.status()',
                'petted = watchdog.pet()',
                'disarmed = watchdog.disarm()',
                'valid = (',
                '    armed.armed and armed.timeout_ms == 5000 and armed.signal == "SIGKILL"',
                '    and status.armed and status.deadline_at == armed.deadline_at',
                '    and petted.armed and petted.deadline_at >= armed.deadline_at',
                '    and not disarmed.armed and not watchdog.status().armed',
                ')',
                'print(f"watchdog:{str(valid).lower()}")',
                '',
              ].join('\n'),
            },
            {
              path: 'watchdog-expire.py',
              contents: [
                'from tracekernel import watchdog',
                'watchdog.arm(40, signal="SIGKILL")',
                'while True:',
                '    pass',
                '',
              ].join('\n'),
            },
            {
              path: 'kernel-fs.py',
              contents: [
                'from tracekernel import fs',
                'host_value = fs.read_text("host-shared.txt")',
                'fs.mkdir("python-kernel-dir")',
                'written = fs.write_bytes("python-kernel-dir/value.bin", b"\\x00python\\xff")',
                'info = fs.stat("python-kernel-dir/value.bin")',
                'entries = fs.listdir("python-kernel-dir")',
                'fs.rename("python-kernel-dir/value.bin", "python-kernel-dir/final.bin")',
                'valid = (',
                '    host_value == "host-authoritative\\n"',
                '    and written == 8',
                '    and info.kind == "file" and info.size == 8',
                '    and entries == ["value.bin"]',
                '    and fs.read_bytes("python-kernel-dir/final.bin") == b"\\x00python\\xff"',
                ')',
                'print(f"tkfs:{str(valid).lower()}")',
                '',
              ].join('\n'),
            },
            {
              path: 'host-shared.txt',
              contents: 'host-authoritative\n',
            },
            {
              path: 'kernel-native-fs.py',
              contents: [
                'import os',
                'from pathlib import Path',
                'host_value = Path("host-shared.txt").read_text()',
                'Path("python-native").mkdir()',
                'path = Path("python-native/value.bin")',
                'path.write_bytes(b"abcdef")',
                'with path.open("ab") as handle:',
                '    handle.write(b"gh")',
                'fd = os.open(path, os.O_RDWR)',
                'try:',
                '    os.lseek(fd, 2, os.SEEK_SET)',
                '    middle = os.read(fd, 3)',
                '    os.ftruncate(fd, 5)',
                'finally:',
                '    os.close(fd)',
                'os.rename(path, "python-native/final.bin")',
                'os.symlink("final.bin", "python-native/link.bin")',
                'valid = (',
                '    host_value == "host-authoritative\\n"',
                '    and middle == b"cde"',
                '    and Path("python-native/final.bin").read_bytes() == b"abcde"',
                '    and Path("python-native/link.bin").read_bytes() == b"abcde"',
                '    and os.readlink("python-native/link.bin") == "final.bin"',
                '    and sorted(os.listdir("python-native")) == ["final.bin", "link.bin"]',
                ')',
                'print(f"native-tkfs:{str(valid).lower()}")',
                '',
              ].join('\n'),
            },
            {
              path: 'spawn-child.js',
              contents: [
                'const fs = require("node:fs");',
                'const parent = fs.readFileSync("spawn-parent.txt", "utf8");',
                'fs.writeFileSync("spawn-js-child.txt", `${parent.trim()}:js\\n`);',
                'process.stdout.write("js-child:ok\\n");',
                '',
              ].join('\n'),
            },
            {
              path: 'spawn-child.py',
              contents: [
                'import builtins',
                'from pathlib import Path',
                'isolated = not hasattr(builtins, "tracekernel_parent_secret")',
                'builtins.tracekernel_parent_secret = "child"',
                'pipe_value = input().strip()',
                'parent = Path("spawn-parent.txt").read_text().strip()',
                'Path("spawn-python-child.txt").write_text(f"{parent}:python\\n")',
                'print(f"python-child:{str(isolated).lower()}:{pipe_value}")',
                '',
              ].join('\n'),
            },
            {
              path: 'spawn-parent.py',
              contents: [
                'import builtins',
                'from pathlib import Path',
                'import subprocess',
                'builtins.tracekernel_parent_secret = "parent"',
                'Path("spawn-parent.txt").write_text("parent\\n")',
                'js = subprocess.run(',
                '    ["node", "spawn-child.js"],',
                '    capture_output=True,',
                '    text=True,',
                '    check=True,',
                ')',
                'python = subprocess.run(',
                '    ["python", "spawn-child.py"],',
                '    input="through-kernel-pipe\\n",',
                '    capture_output=True,',
                '    text=True,',
                '    check=True,',
                ')',
                'valid = (',
                '    js.stdout == "js-child:ok\\n" and js.stderr == ""',
                '    and python.stdout == "python-child:true:through-kernel-pipe\\n"',
                '    and python.stderr == ""',
                '    and builtins.tracekernel_parent_secret == "parent"',
                '    and Path("spawn-js-child.txt").read_text() == "parent:js\\n"',
                '    and Path("spawn-python-child.txt").read_text() == "parent:python\\n"',
                ')',
                'print(f"spawn:{str(valid).lower()}")',
                '',
              ].join('\n'),
            },
            {
              path: 'group-grandchild.js',
              contents: [
                'setTimeout(() => {',
                '  require("node:fs").writeFileSync("python-group-survived.txt", "escaped");',
                '}, 500);',
                'setInterval(() => {}, 1000);',
                '',
              ].join('\n'),
            },
            {
              path: 'group-leader.js',
              contents: [
                'const fs = require("node:fs");',
                'const { spawn } = require("node:child_process");',
                'const child = spawn("node", ["group-grandchild.js"], { stdio: "inherit" });',
                'child.on("error", (error) => { throw error; });',
                'fs.writeFileSync("python-group-ready.txt", `${process.pid}:${child.pid}`);',
                'setInterval(() => {}, 1000);',
                '',
              ].join('\n'),
            },
            {
              path: 'group-parent.py',
              contents: [
                'import os',
                'import signal',
                'import subprocess',
                'import time',
                'from pathlib import Path',
                'leader = subprocess.Popen(',
                '    ["node", "group-leader.js"],',
                '    start_new_session=True,',
                ')',
                'deadline = time.monotonic() + 5',
                'ready = Path("python-group-ready.txt")',
                'while not ready.exists() and time.monotonic() < deadline:',
                '    time.sleep(0.01)',
                'if not ready.exists():',
                '    raise RuntimeError("detached JavaScript group did not start")',
                'leader_pid, child_pid = map(int, ready.read_text().split(":"))',
                'if leader_pid != leader.pid or child_pid == leader.pid:',
                '    raise RuntimeError("invalid group process identities")',
                'os.killpg(leader.pid, signal.SIGKILL)',
                'returncode = leader.wait()',
                'time.sleep(0.65)',
                'valid = returncode == -signal.SIGKILL and not Path("python-group-survived.txt").exists()',
                'print(f"group:{str(valid).lower()}")',
                '',
              ].join('\n'),
            },
            {
              path: 'socket-child.js',
              contents: [
                'const net = require("node:net");',
                'const port = Number(process.argv[2]);',
                'const socket = net.createConnection({ host: "127.0.0.1", port });',
                'const chunks = [];',
                'socket.on("connect", () => {',
                '  socket.write(Buffer.from("fragment-"));',
                '  socket.end(Buffer.from("payload"));',
                '});',
                'socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));',
                'socket.on("end", () => {',
                '  process.stdout.write(`socket-child:${Buffer.concat(chunks).toString("utf8")}\\n`);',
                '});',
                'socket.on("error", (error) => { throw error; });',
                '',
              ].join('\n'),
            },
            {
              path: 'socket-parent.py',
              contents: [
                'import socket',
                'import subprocess',
                'with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:',
                '    server.bind(("127.0.0.1", 0))',
                '    server.listen(4)',
                '    host, port = server.getsockname()',
                '    child = subprocess.Popen(',
                '        ["node", "socket-child.js", str(port)],',
                '        stdout=subprocess.PIPE,',
                '        stderr=subprocess.PIPE,',
                '        text=True,',
                '    )',
                '    with server.accept()[0] as connection:',
                '        chunks = []',
                '        while True:',
                '            chunk = connection.recv(3)',
                '            if not chunk:',
                '                break',
                '            chunks.append(chunk)',
                '        payload = b"".join(chunks)',
                '        connection.sendall(payload.upper())',
                '        connection.shutdown(socket.SHUT_WR)',
                '    stdout, stderr = child.communicate()',
                'valid = (',
                '    host == "127.0.0.1"',
                '    and payload == b"fragment-payload"',
                '    and stdout == "socket-child:FRAGMENT-PAYLOAD\\n"',
                '    and stderr == ""',
                '    and child.returncode == 0',
                ')',
                'print(f"socket:{str(valid).lower()}")',
                '',
              ].join('\n'),
            },
          ],
        });
        try {
          const fsControl = await workspace.runCommand('python kernel-fs.py');
          const nativeFsControl = await workspace.runCommand(
            'python kernel-native-fs.py'
          );
          const spawnControl = await workspace.runCommand(
            'python spawn-parent.py'
          );
          const processGroupControl = await workspace.runCommand(
            'python group-parent.py'
          );
          const socketControl = await workspace.runCommand(
            'python socket-parent.py'
          );
          return {
            fsControl,
            nativeFsControl,
            nativeFsResult: nativeFsControl.exitCode === 0
              ? await workspace.readFile(
                  'python-native/final.bin',
                  'base64'
                )
              : null,
            spawnControl,
            processGroupControl,
            socketControl,
            spawnJsResult: spawnControl.exitCode === 0
              ? await workspace.readFile('spawn-js-child.txt')
              : null,
            spawnPythonResult: spawnControl.exitCode === 0
              ? await workspace.readFile('spawn-python-child.txt')
              : null,
            fsResult: fsControl.exitCode === 0
              ? await workspace.readFile(
                  'python-kernel-dir/final.bin',
                  'base64'
                )
              : null,
            control: await workspace.runCommand('python watchdog-control.py'),
            expiry: await workspace.runCommand('python watchdog-expire.py'),
          };
        } finally {
          workspace.dispose();
        }
      });

      assertCondition(
        result.socketControl.exitCode === 0 &&
          result.socketControl.stdout === 'socket:true\n',
        `Python and JavaScript did not share kernel TCP streams: ${JSON.stringify(result.socketControl)}`
      );
      assertCondition(
        result.spawnControl.exitCode === 0 &&
          result.spawnControl.stdout === 'spawn:true\n' &&
          result.spawnJsResult === 'parent:js\n' &&
          result.spawnPythonResult === 'parent:python\n',
        `Python child processes did not share kernel FS and stdio: ${JSON.stringify(result.spawnControl)}`
      );
      assertCondition(
        result.processGroupControl.exitCode === 0 &&
          result.processGroupControl.stdout === 'group:true\n',
        `Python os.killpg/start_new_session did not control a cross-language process tree: ${JSON.stringify(result.processGroupControl)}`
      );
      assertCondition(
        result.nativeFsControl.exitCode === 0 &&
          result.nativeFsControl.stdout === 'native-tkfs:true\n' &&
          result.nativeFsResult === 'YWJjZGU=',
        `Ordinary Python filesystem APIs did not use authoritative TKFS: ${JSON.stringify(result.nativeFsControl)} ${JSON.stringify(result.nativeFsResult)}`
      );
      assertCondition(
        result.fsControl.exitCode === 0 &&
          result.fsControl.stdout === 'tkfs:true\n' &&
          result.fsResult === 'AHB5dGhvbv8=',
        `Python filesystem controls did not use authoritative TKFS: ${JSON.stringify(result.fsControl)} ${JSON.stringify(result.fsResult)}`
      );
      assertCondition(
        result.control.exitCode === 0 &&
          result.control.stdout === 'watchdog:true\n',
        `Python watchdog controls did not cross the TraceKernel syscall channel: ${JSON.stringify(result.control)}`
      );
      assertCondition(
        result.expiry.exitCode === 137 &&
          result.expiry.error?.detail?.signal === 'SIGKILL',
        `Python watchdog expiry was not kernel-enforced: ${JSON.stringify(result.expiry)}`
      );
      assertCondition(
        browserErrors.length === 0,
        `Python browser conformance emitted unexpected errors: ${JSON.stringify(browserErrors)}`
      );
      console.log(JSON.stringify({
        schema: 'tracekernel-013-python-conformance-v1',
        synchronousSyscallTransport: true,
        explicitTkfsControls: true,
        nativeTkfsMount: true,
        childProcesses: ['javascript', 'python'],
        processGroups: ['start_new_session', 'os.kill', 'os.killpg'],
        tcpPeers: ['python', 'javascript'],
        watchdogControls: true,
        watchdogExpirySignal: 'SIGKILL',
      }));
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

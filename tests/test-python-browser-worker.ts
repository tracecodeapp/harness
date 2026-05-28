#!/usr/bin/env npx tsx

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runCommand, waitForHttp } from './example-app-smoke';
import { createRuntimeCommandStdinPipeFromText } from '../packages/harness-core/src/runtime-project';

interface PythonProjectWorkerFile {
  path: string;
  contents?: string;
  encoding?: 'utf8' | 'base64';
  deleted?: true;
}

interface PythonProjectWorkerResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  files?: PythonProjectWorkerFile[];
  events?: Array<{
    type: string;
    stream?: 'stdout' | 'stderr';
    device?: string;
    sourceDevice?: string;
    data?: string;
    phase?: string;
    change?: PythonProjectWorkerFile;
  }>;
}

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function findFile(result: PythonProjectWorkerResponse, path: string): PythonProjectWorkerFile | undefined {
  return result.files?.find((file) => file.path === path);
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-python-browser-'));
  const workersRoot = join(tempRoot, 'workers');
  const port = 5400 + Math.floor(Math.random() * 200);
  const origin = `http://127.0.0.1:${port}`;

  await runCommand('pnpm', ['exec', 'tsx', 'src/cli.ts', 'sync-assets', workersRoot], process.cwd());
  await writeFile(join(tempRoot, 'index.html'), '<!doctype html><title>Python worker smoke</title>', 'utf8');

  const server = spawn('python3', ['-c', [
    'from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler',
    'import os',
    'class Handler(SimpleHTTPRequestHandler):',
    '    def end_headers(self):',
    '        self.send_header("Cross-Origin-Opener-Policy", "same-origin")',
    '        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")',
    '        super().end_headers()',
    `os.chdir(${JSON.stringify(tempRoot)})`,
    `ThreadingHTTPServer(("127.0.0.1", ${port}), Handler).serve_forever()`,
  ].join('\n')], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (chunk) => process.stdout.write(String(chunk)));
  server.stderr?.on('data', (chunk) => process.stderr.write(String(chunk)));

  const browser = await chromium.launch({ headless: true });
  try {
    await waitForHttp(origin, 30_000);
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    await page.goto(origin);

    const results = await page.evaluate(`(async () => {
      const worker = new Worker('/workers/pyodide-worker.js');
      let nextId = 0;
      let nextHttpRequestId = 0;
      const pending = new Map();
      const listeners = new Map();
      const requestWaiters = new Map();
      const createRuntimeCommandStdinPipeFromText = (text) => {
        const encoded = new TextEncoder().encode(text);
        const capacity = Math.max(65536, encoded.byteLength + 1);
        const buffer = new SharedArrayBuffer(12 + capacity);
        const header = new Int32Array(buffer, 0, 3);
        new Uint8Array(buffer, 12).set(encoded);
        Atomics.store(header, 1, encoded.byteLength % capacity);
        Atomics.store(header, 2, 1);
        return { buffer };
      };

      worker.onmessage = (event) => {
        const { id, type, payload } = event.data || {};
        if (type === 'worker-ready') return;
        if (!id) return;
        const request = pending.get(id);
        if (!request) return;
        if (type === 'project-event') {
          request.events.push(payload);
          return;
        }
        if (type === 'kernel-http-listen') {
          const info = {
            id: payload.listenerId,
            pid: 100,
            host: (payload.options && payload.options.host) || '127.0.0.1',
            port: Number(payload.options && payload.options.port),
            protocol: 'http',
            startedAt: new Date().toISOString(),
          };
          listeners.set(payload.listenerId, { commandId: id, info });
          request.events.push({ type: 'kernel-http-listen', info });
          worker.postMessage({
            id,
            type: 'kernel-http-listen-result',
            payload: { type: 'kernel-http-listen-result', listenerId: payload.listenerId, info },
          });
          return;
        }
        if (type === 'kernel-http-close') {
          listeners.delete(payload.listenerId);
          request.events.push({ type: 'kernel-http-close', listenerId: payload.listenerId });
          return;
        }
        if (type === 'kernel-http-response') {
          const waiter = requestWaiters.get(payload.requestId);
          requestWaiters.delete(payload.requestId);
          if (waiter) waiter.resolve(payload.response);
          return;
        }
        if (type === 'kernel-http-error') {
          const waiter = requestWaiters.get(payload.requestId);
          requestWaiters.delete(payload.requestId);
          if (waiter) waiter.reject(new Error(String(payload.error || 'kernel-http-error')));
          else request.reject(new Error(String(payload.error || 'kernel-http-error')));
          return;
        }
        pending.delete(id);
        if (type === 'error') {
          request.reject(new Error(String((payload && payload.error) || 'Python worker error')));
        } else {
          request.resolve({ ...payload, events: request.events });
        }
      };
      worker.onerror = (event) => {
        for (const request of pending.values()) {
          clearTimeout(request.timeoutId);
          request.reject(new Error(event.message || 'Python worker error'));
        }
        pending.clear();
      };

      const terminateWorker = () => {
        worker.terminate();
        for (const request of pending.values()) {
          clearTimeout(request.timeoutId);
          request.reject(new Error('worker terminated'));
        }
        pending.clear();
      };

      const send = (type, payload, timeoutMs = 120000) =>
        new Promise((resolve, reject) => {
          const id = String(++nextId);
          const timeoutId = setTimeout(() => {
            pending.delete(id);
            reject(new Error(type + ' timed out'));
          }, timeoutMs);
          pending.set(id, {
            events: [],
            timeoutId,
            resolve: (value) => {
              clearTimeout(timeoutId);
              resolve(value);
            },
            reject: (error) => {
              clearTimeout(timeoutId);
              reject(error);
            },
          });
          worker.postMessage({ id, type, payload });
        });

      const dispatchHttp = (port, request, timeoutMs = 30000) => {
        const entry = [...listeners.entries()].find(([, value]) => Number(value.info.port) === Number(port));
        if (!entry) return Promise.reject(new Error('listener not found on port ' + port));
        const [listenerId, value] = entry;
        const requestId = 'http-' + (++nextHttpRequestId);
        return new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            requestWaiters.delete(requestId);
            reject(new Error('kernel http request timed out'));
          }, timeoutMs);
          requestWaiters.set(requestId, {
            resolve: (response) => {
              clearTimeout(timeoutId);
              resolve(response);
            },
            reject: (error) => {
              clearTimeout(timeoutId);
              reject(error);
            },
          });
          worker.postMessage({
            id: value.commandId,
            type: 'kernel-http-request',
            payload: { type: 'kernel-http-request', listenerId, requestId, request },
          });
        });
      };

      await send('init', {}, 120000);

      const traceKernelDevices = [
        { path: '/dev/stdin', readable: true, writable: false, inputDevice: '/dev/stdin' },
        { path: '/dev/null', readable: true, writable: true, inputDevice: '/dev/null', outputDevice: '/dev/null' },
        { path: '/dev/stdout', readable: false, writable: true, outputDevice: '/dev/stdout' },
        { path: '/dev/stderr', readable: false, writable: true, outputDevice: '/dev/stderr' },
        { path: '/dev/tty', readable: true, writable: true, inputDevice: '/dev/stdin', outputDevice: '/dev/stdout' },
        { path: '/dev/log', readable: false, writable: true, outputDevice: '/dev/stderr' },
        { path: '/dev/capture', readable: false, writable: true, outputDevice: '/dev/capture' },
        { path: '/dev/tee', readable: false, writable: true, outputDevice: '/dev/capture' },
        { path: '/dev/custom-in', readable: true, writable: false, inputDevice: '/dev/stdin' },
      ];

      const projectFiles = [
        {
          path: 'main.py',
          contents: [
            'import os',
            'import sys',
            'import js',
            'from helpers.value import answer',
            '',
            'line = sys.stdin.readline().strip()',
            'print(answer())',
            'print(line)',
            'print(os.environ.get("MODE", ""))',
            'print(",".join(sys.argv[1:]))',
            'print(os.getcwd())',
            'stdin_fd = os.open("/dev/stdin", os.O_RDONLY)',
            'try:',
            '    print("dev-fd-stdin=" + os.read(stdin_fd, 64).decode("utf-8").strip())',
            'finally:',
            '    os.close(stdin_fd)',
            'stdin_fdopen_fd = os.open("/dev/stdin", os.O_RDONLY)',
            'with os.fdopen(stdin_fdopen_fd, "r", encoding="utf-8") as stdin_fdopen:',
            '    print("dev-fdopen-stdin=" + stdin_fdopen.read().strip())',
            'custom_fd = os.open("/dev/custom-in", os.O_RDONLY)',
            'try:',
            '    print("dev-fd-custom-in=" + os.read(custom_fd, 64).decode("utf-8").strip())',
            'finally:',
            '    os.close(custom_fd)',
            'print("dev-custom-present=" + str("log" in os.listdir("/dev") and "custom-in" in os.listdir("/dev")))',
            'print("dev-custom-access=" + str(os.access("/dev/log", os.W_OK)) + ":" + str(os.access("/dev/custom-in", os.R_OK)))',
            'with open("/dev/custom-in", "r", encoding="utf-8") as custom_in:',
            '    print("dev-file-custom-in=" + custom_in.read().strip())',
            'try:',
            '    open("/dev/custom-in", "w", encoding="utf-8")',
            '    print("dev-file-custom-in-write-open:ok")',
            'except OSError:',
            '    print("dev-file-custom-in-write-open:blocked")',
            'with open("/dev/custom-in", "r", encoding="utf-8") as custom_in_chunks:',
            '    print("dev-file-custom-in-chunks=" + custom_in_chunks.read(4) + "|" + custom_in_chunks.read().strip() + "|" + str(custom_in_chunks.read() == ""))',
            'with open("/dev/custom-in", "rb") as custom_in_binary:',
            '    print("dev-file-custom-in-binary=" + custom_in_binary.read().decode("utf-8").strip())',
            'with open("/dev/custom-in", "rb") as custom_in_binary_chunks:',
            '    print("dev-file-custom-in-binary-chunks=" + custom_in_binary_chunks.read(4).decode("utf-8") + "|" + custom_in_binary_chunks.read().decode("utf-8").strip() + "|" + str(custom_in_binary_chunks.read() == b""))',
            'with open("/dev/log", "w", encoding="utf-8") as log:',
            '    log.write("dev-file-log\\\\n")',
            'try:',
            '    open("/dev/log", "r", encoding="utf-8")',
            '    print("dev-file-log-read-open:ok")',
            'except OSError:',
            '    print("dev-file-log-read-open:blocked")',
            'with open("/dev/log", "wb") as log_binary:',
            '    log_binary.write(b"dev-file-log-binary\\\\n")',
            'log_fd = os.open("/dev/log", os.O_WRONLY)',
            'try:',
            '    os.write(log_fd, b"dev-fd-log\\\\n")',
            'finally:',
            '    os.close(log_fd)',
            'stdout_fd = os.open("/dev/stdout", os.O_WRONLY)',
            'try:',
            '    os.write(stdout_fd, b"dev-fd-out\\\\n")',
            'finally:',
            '    os.close(stdout_fd)',
            'stdout_fdopen_fd = os.open("/dev/stdout", os.O_WRONLY)',
            'with os.fdopen(stdout_fdopen_fd, "w", encoding="utf-8") as stdout_fdopen:',
            '    stdout_fdopen.write("dev-fdopen-out\\\\n")',
            'tty_fd = os.open("/dev/tty", os.O_WRONLY)',
            'try:',
            '    os.write(tty_fd, b"dev-fd-tty\\\\n")',
            'finally:',
            '    os.close(tty_fd)',
            'tty_rw_fd = os.open("/dev/tty", os.O_RDWR)',
            'try:',
            '    print("dev-fd-tty-rw-read=" + os.read(tty_rw_fd, 64).decode("utf-8").strip())',
            '    os.write(tty_rw_fd, b"dev-fd-tty-rw-write\\\\n")',
            'finally:',
            '    os.close(tty_rw_fd)',
            'with open("/dev/tty", "w", encoding="utf-8") as tty:',
            '    tty.write("dev-file-tty\\\\n")',
            '    tty.writelines(["dev-file-tty-lines", "\\\\n"])',
            'with open("/dev/tty", "r+", encoding="utf-8") as tty_rw:',
            '    print("dev-file-tty-rw-read=" + tty_rw.readline().strip())',
            '    print("dev-file-tty-rw-eof=" + str(tty_rw.read() == ""))',
            '    tty_rw.write("dev-file-tty-rw-write\\\\n")',
            'with open("/dev/null", "r+", encoding="utf-8") as null_file:',
            '    print("dev-null=" + str(len(null_file.read())))',
            '    null_file.write("discarded\\\\n")',
            'sys.__stdout__.write("provider-hook-out\\\\n")',
            'sys.__stdout__.writelines(["provider-hook-lines", "\\\\n"])',
            'sys.__stdout__.flush()',
            'sys.stdout.buffer.write(b"stdout-buffer\\\\n")',
            'sys.stdout.flush()',
            'stderr_fd = os.open("/dev/stderr", os.O_WRONLY)',
            'try:',
            '    os.write(stderr_fd, b"dev-fd-err\\\\n")',
            'finally:',
            '    os.close(stderr_fd)',
            'sys.__stderr__.write("provider-hook-err\\\\n")',
            'sys.__stderr__.flush()',
            'sys.stderr.buffer.write(b"stderr-buffer\\\\n")',
            'sys.stderr.flush()',
            'print("stderr-line", file=sys.stderr)',
            'with open("/workspace/generated.txt", "w", encoding="utf-8") as handle:',
            '    handle.write(str(answer()) + "\\\\n")',
            'with open("/workspace/live-before-stdout.txt", "w", encoding="utf-8") as handle:',
            '    handle.write("before-output\\\\n")',
            '    handle.flush()',
            'sys.stdout.write("after-live-file\\\\n")',
            'sys.stdout.flush()',
            'with open("/workspace/writelines.txt", "w", encoding="utf-8") as handle:',
            '    handle.writelines(["line-a\\\\n", "line-b\\\\n"])',
            'with open("bytes.bin", "wb") as handle:',
            '    handle.write(bytes([0, 255]))',
            'js.eval(\\'pyodide.FS.writeFile("/tracecode_project/provider-live.txt", "provider-live\\\\\\\\n", { encoding: "utf8" })\\')',
            'js.eval(\\'pyodide.FS.chmod("/tracecode_project/provider-metadata.txt", 0o600); if (typeof pyodide.FS.utime === "function") pyodide.FS.utime("/tracecode_project/provider-metadata.txt", 1, 1)\\')',
            'js.eval(\\'const providerEmpty = pyodide.FS.open("/tracecode_project/provider-empty.txt", "w"); pyodide.FS.close(providerEmpty)\\')',
            'js.eval(\\'pyodide.FS.createDataFile("/tracecode_project", "provider-create-data.txt", "provider-create-data\\\\\\\\n", true, true)\\')',
            'js.eval(\\'pyodide.FS.create("/tracecode_project/provider-create.txt")\\')',
            'js.eval(\\'pyodide.FS.createPath("/tracecode_project", "provider-created-path/nested", true, true); pyodide.FS.createDataFile("/tracecode_project/provider-created-path/nested", "value.txt", "provider-created-path\\\\\\\\n", true, true)\\')',
            'js.eval(\\'pyodide.FS.mkdir("/tracecode_project/provider-tree"); pyodide.FS.mkdir("/tracecode_project/provider-tree/nested"); pyodide.FS.writeFile("/tracecode_project/provider-tree/nested/value.txt", "provider-tree\\\\\\\\n", { encoding: "utf8" }); pyodide.FS.rename("/tracecode_project/provider-tree", "/tracecode_project/provider-tree-moved")\\')',
            'js.eval(\\'pyodide.FS.mkdir("/tracecode_project/provider-dir"); pyodide.FS.rename("/tracecode_project/provider-dir", "/tracecode_project/provider-renamed-dir"); pyodide.FS.rmdir("/tracecode_project/provider-renamed-dir")\\')',
            'fd = os.open("/workspace/fd-live.txt", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o666)',
            'try:',
            '    os.write(fd, b"fd-one\\\\n")',
            '    os.write(fd, b"fd-two\\\\n")',
            'finally:',
            '    os.close(fd)',
            'fd = os.open("/workspace/fdopen-live.txt", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o666)',
            'with os.fdopen(fd, "w", encoding="utf-8") as handle:',
            '    handle.write("fdopen-one\\\\n")',
            'fd = os.open("/workspace/fd-empty.txt", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o666)',
            'os.close(fd)',
            'with open("/workspace/truncated.txt", "w+", encoding="utf-8") as handle:',
            '    handle.write("abcdef")',
            '    handle.truncate(3)',
            'os.rename("/workspace/truncated.txt", "/workspace/renamed-truncated.txt")',
            'os.makedirs("/workspace/live-dir/child")',
            'os.rename("/workspace/live-dir/child", "/workspace/live-dir/renamed-child")',
            'os.rmdir("/workspace/live-dir/renamed-child")',
            'os.rmdir("/workspace/live-dir")',
            'with open("/workspace/os-truncate.txt", "w", encoding="utf-8") as handle:',
            '    handle.write("abcdef")',
            'os.truncate("/workspace/os-truncate.txt", 4)',
            'fd = os.open("/workspace/ftruncate.txt", os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o666)',
            'try:',
            '    os.write(fd, b"abcdef")',
            '    os.ftruncate(fd, 2)',
            'finally:',
            '    os.close(fd)',
            'with open("/workspace/metadata-path.txt", "w", encoding="utf-8") as handle:',
            '    handle.write("metadata-path\\\\n")',
            'os.chmod("/workspace/metadata-path.txt", 0o600)',
            'os.utime("/workspace/metadata-path.txt", (1, 1))',
            'with open("/workspace/metadata-fd.txt", "w", encoding="utf-8") as handle:',
            '    handle.write("metadata-fd\\\\n")',
            'fd = os.open("/workspace/metadata-fd.txt", os.O_RDONLY)',
            'try:',
            '    os.fchmod(fd, 0o600)',
            'finally:',
            '    os.close(fd)',
            'os.remove("/workspace/stale.txt")',
            '',
          ].join('\\n'),
        },
        { path: 'helpers/value.py', contents: 'def answer():\\n    return 42\\n' },
        { path: 'provider-metadata.txt', contents: 'provider-meta\\n' },
        { path: 'stale.txt', contents: 'delete me\\n' },
      ];

      const fileRun = await send('execute-project-python', {
        source: 'file',
        scriptPath: '/workspace/main.py',
        args: ['alpha', 'beta'],
        cwd: '/workspace',
        env: { MODE: 'browser-python-project' },
        stdinPipe: createRuntimeCommandStdinPipeFromText('from-stdin\\n'),
        project: { cwd: '/workspace', files: projectFiles, kernelDevices: traceKernelDevices },
      });

      const moduleRun = await send('execute-project-python', {
        source: 'module',
        scriptPath: 'app',
        args: ['module-arg'],
        cwd: '/workspace',
        env: { PYTHONPATH: '/workspace/libs' },
        project: {
          cwd: '/workspace',
          files: [
            { path: 'app/__main__.py', contents: 'import sys\\nfrom extra import value\\nprint(value())\\nprint(",".join(sys.argv[1:]))\\n' },
            { path: 'libs/extra.py', contents: 'def value():\\n    return "pythonpath-ok"\\n' },
          ],
        },
      });

      const cwdRelativeFileRun = await send('execute-project-python', {
        source: 'file',
        scriptPath: '../src/main.py',
        args: [],
        cwd: '/workspace/build',
        env: { PYTHONPATH: '../libs' },
        project: {
          cwd: '/workspace',
          files: [
            { path: 'build/.keep', contents: '' },
            { path: 'src/main.py', contents: 'import os\\nfrom extra import value\\nprint(os.getcwd())\\nprint(value())\\nopen("generated.txt", "w").write("created\\\\n")\\n' },
            { path: 'libs/extra.py', contents: 'def value():\\n    return "cwd-pythonpath-ok"\\n' },
          ],
        },
      });

      const workspaceRelativeFileRun = await send('execute-project-python', {
        source: 'file',
        scriptPath: 'src/main.py',
        args: [],
        cwd: '/workspace/src',
        env: {},
        project: {
          cwd: '/workspace',
          files: [
            { path: 'src/main.py', contents: 'import os\\nprint(os.getcwd())\\nprint("workspace-relative-script")\\n' },
          ],
        },
      });

      const stdinRun = await send('execute-project-python', {
        source: 'stdin',
        scriptPath: '<stdin>',
        code: 'import sys\\nprint("stdin-source")\\nprint(sys.stdin.read().strip())\\n',
        args: [],
        cwd: '/workspace',
        env: {},
        stdinPipe: createRuntimeCommandStdinPipeFromText('stdin-data\\n'),
        project: {
          cwd: '/workspace',
          files: [],
          kernelDevices: [{ path: '/dev/stdin', readable: true, writable: false }],
        },
      });

      const argumentRun = await send('execute-project-python', {
        source: 'argument',
        scriptPath: '<string>',
        code: 'import os, sys\\nprint("argument-source")\\nprint(os.getcwd())\\nprint(",".join(sys.argv[1:]))\\n',
        args: ['x', 'y'],
        cwd: '/workspace',
        env: {},
        project: { cwd: '/workspace', files: [] },
      });

      const noDeviceManifestRun = await send('execute-project-python', {
        source: 'argument',
        scriptPath: '<string>',
        code: [
          'import os',
          'print(",".join(os.listdir("/dev")))',
          'print(os.path.exists("/dev/stdout"))',
          'try:',
          '    open("/dev/stdout", "w").write("invented\\\\n")',
          '    print("dev-stdout:ok")',
          'except OSError:',
          '    print("dev-stdout:blocked")',
        ].join('\\n'),
        args: [],
        cwd: '/workspace',
        env: {},
        project: { cwd: '/workspace', files: [] },
      });

      const manifestCustomDeviceRun = await send('execute-project-python', {
        source: 'argument',
        scriptPath: '<string>',
        code: [
          'import os',
          'import sys',
          'print("stdin-visible=" + sys.stdin.read().strip())',
          'with open("/dev/custom-in", "r", encoding="utf-8") as custom_in:',
          '    print("custom-file=" + custom_in.read().strip())',
          'custom_fd = os.open("/dev/custom-in", os.O_RDONLY)',
          'try:',
          '    print("custom-fd=" + os.read(custom_fd, 64).decode("utf-8").strip())',
          'finally:',
          '    os.close(custom_fd)',
          'print("nested-dev-dir=" + str(os.path.isdir("/dev/pts")) + ":" + ",".join(os.listdir("/dev/pts")))',
          'with open("/dev/log", "w", encoding="utf-8") as log:',
          '    log.write("log-file\\\\n")',
          'log_fd = os.open("/dev/log", os.O_WRONLY)',
          'try:',
          '    os.write(log_fd, b"log-fd\\\\n")',
          'finally:',
          '    os.close(log_fd)',
          'with open("/dev/pts/0", "w", encoding="utf-8") as pts:',
          '    pts.write("pts-file\\\\n")',
          'pts_fd = os.open("/dev/pts/0", os.O_WRONLY)',
          'try:',
          '    os.write(pts_fd, b"pts-fd\\\\n")',
          'finally:',
          '    os.close(pts_fd)',
          'with open("/dev/capture", "w", encoding="utf-8") as capture:',
          '    capture.write("capture-file\\\\n")',
          'capture_fd = os.open("/dev/capture", os.O_WRONLY)',
          'try:',
          '    os.write(capture_fd, b"capture-fd\\\\n")',
          'finally:',
          '    os.close(capture_fd)',
          'with open("/dev/tee", "w", encoding="utf-8") as tee:',
          '    tee.write("tee-file\\\\n")',
          'tee_fd = os.open("/dev/tee", os.O_WRONLY)',
          'try:',
          '    os.write(tee_fd, b"tee-fd\\\\n")',
          'finally:',
          '    os.close(tee_fd)',
        ].join('\\n'),
        args: [],
        cwd: '/workspace',
        env: {},
        stdinPipe: createRuntimeCommandStdinPipeFromText('manifest-stdin\\n'),
        project: {
          cwd: '/workspace',
          files: [],
          kernelDevices: [
            { path: '/dev/custom-in', readable: true, writable: false, inputDevice: '/dev/stdin' },
            { path: '/dev/log', readable: false, writable: true, outputDevice: '/dev/stderr' },
            { path: '/dev/pts/0', readable: false, writable: true, outputDevice: '/dev/stdout' },
            { path: '/dev/capture', readable: false, writable: true, outputDevice: '/dev/capture' },
            { path: '/dev/tee', readable: false, writable: true, outputDevice: '/dev/capture' },
          ],
        },
      });

      const sharedStdinCursorRun = await send('execute-project-python', {
        source: 'argument',
        scriptPath: '<string>',
        code: [
          'import sys',
          'print("sys=" + sys.stdin.readline().strip())',
          'with open("/dev/custom-in", "r", encoding="utf-8") as custom_in:',
          '    print("custom=" + custom_in.read().replace("\\\\n", "<lf>"))',
        ].join('\\n'),
        args: [],
        cwd: '/workspace',
        env: {},
        stdinPipe: createRuntimeCommandStdinPipeFromText('one\\ntwo\\nthree\\n'),
        project: {
          cwd: '/workspace',
          files: [],
          kernelDevices: traceKernelDevices,
        },
      });

      const fdReadlineRun = await send('execute-project-python', {
        source: 'argument',
        scriptPath: '<string>',
        code: [
          'import os',
          'custom_fd = os.open("/dev/custom-in", os.O_RDONLY)',
          'with os.fdopen(custom_fd, "r", encoding="utf-8") as custom_in:',
          '    print("dev-line-1=" + custom_in.readline().strip())',
          '    print("dev-line-2=" + custom_in.readline().strip())',
          '    print("dev-rest=" + custom_in.read().strip())',
          'proc_fd = os.open("/proc/kernel/version", os.O_RDONLY)',
          'with os.fdopen(proc_fd, "r", encoding="utf-8") as proc_file:',
          '    print("proc-line-1=" + proc_file.readline().strip())',
          '    print("proc-line-2=" + proc_file.readline().strip())',
          '    print("proc-rest=" + proc_file.read().strip())',
        ].join('\\n'),
        args: [],
        cwd: '/workspace',
        env: {},
        stdinPipe: createRuntimeCommandStdinPipeFromText('dev-one\\ndev-two\\ndev-three\\n'),
        project: {
          cwd: '/workspace',
          files: [],
          kernelDevices: [
            { path: '/dev/custom-in', readable: true, writable: false, inputDevice: '/dev/stdin' },
          ],
          kernelFiles: [
            { path: '/proc/kernel/version', contents: 'proc-one\\nproc-two\\nproc-three\\n' },
          ],
        },
      });

      const duplicateFdRun = await send('execute-project-python', {
        source: 'argument',
        scriptPath: '<string>',
        code: [
          'import os',
          'stdout_fd = os.open("/dev/stdout", os.O_WRONLY)',
          'stdout_dup = os.dup(stdout_fd)',
          'os.close(stdout_fd)',
          'try:',
          '    os.write(stdout_dup, b"dup-stdout\\\\n")',
          'finally:',
          '    os.close(stdout_dup)',
          'log_fd = os.open("/dev/log", os.O_WRONLY)',
          'log_dup = os.dup2(log_fd, 1000123)',
          'os.close(log_fd)',
          'try:',
          '    os.write(log_dup, b"dup2-log\\\\n")',
          'finally:',
          '    os.close(log_dup)',
          'custom_fd = os.open("/dev/custom-in", os.O_RDONLY)',
          'custom_first = os.read(custom_fd, 4).decode("utf-8")',
          'custom_dup = os.dup(custom_fd)',
          'os.close(custom_fd)',
          'try:',
          '    print("dev-dup-read=" + custom_first + "|" + os.read(custom_dup, 64).decode("utf-8").strip())',
          'finally:',
          '    os.close(custom_dup)',
          'proc_fd = os.open("/proc/kernel/version", os.O_RDONLY)',
          'proc_first = os.read(proc_fd, 5).decode("utf-8")',
          'proc_dup = os.dup(proc_fd)',
          'os.close(proc_fd)',
          'try:',
          '    print("proc-dup=" + proc_first + "|" + os.read(proc_dup, 64).decode("utf-8").strip().replace("\\\\n", "<lf>"))',
          'finally:',
          '    os.close(proc_dup)',
        ].join('\\n'),
        args: [],
        cwd: '/workspace',
        env: {},
        stdinPipe: createRuntimeCommandStdinPipeFromText('dup-stdin\\n'),
        project: {
          cwd: '/workspace',
          files: [],
          kernelDevices: traceKernelDevices,
          kernelFiles: [
            { path: '/proc/kernel/version', contents: 'proc-dup-one\\nproc-dup-two\\n' },
          ],
        },
      });

      const vectoredFdRun = await send('execute-project-python', {
        source: 'argument',
        scriptPath: '<string>',
        code: [
          'import os',
          'read_fd = os.open("/dev/custom-in", os.O_RDONLY)',
          'try:',
          '    first = bytearray(5)',
          '    second = bytearray(64)',
          '    count = os.readv(read_fd, [first, second])',
          '    print("readv=" + bytes(first + second)[:count].decode("utf-8").replace("\\\\n", "<lf>"))',
          'finally:',
          '    os.close(read_fd)',
          'file_fd = os.open("/workspace/writev-live.txt", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o666)',
          'try:',
          '    os.writev(file_fd, [b"writev-", memoryview(b"file\\\\n")])',
          'finally:',
          '    os.close(file_fd)',
          'stdout_fd = os.open("/dev/stdout", os.O_WRONLY)',
          'try:',
          '    os.writev(stdout_fd, [b"writev-", b"stdout\\\\n"])',
          'finally:',
          '    os.close(stdout_fd)',
          'log_fd = os.open("/dev/log", os.O_WRONLY)',
          'try:',
          '    os.writev(log_fd, [b"writev-", b"log\\\\n"])',
          'finally:',
          '    os.close(log_fd)',
        ].join('\\n'),
        args: [],
        cwd: '/workspace',
        env: {},
        stdinPipe: createRuntimeCommandStdinPipeFromText('readv-one\\nreadv-two\\n'),
        project: {
          cwd: '/workspace',
          files: [],
          kernelDevices: traceKernelDevices,
        },
      });

      const directoryRun = await send('execute-project-python', {
        source: 'argument',
        scriptPath: '<string>',
        code: 'import os\\nprint(os.path.isdir("/workspace/empty/child"))\\nprint(",".join(os.listdir("/workspace/empty")))\\n',
        args: [],
        cwd: '/workspace',
        env: {},
        project: { cwd: '/workspace', directories: ['empty/child'], files: [] },
      });

      const linkApiRun = await send('execute-project-python', {
        source: 'argument',
        scriptPath: '<string>',
        code: [
          'import errno',
          'import os',
          'import js',
          'with open("/workspace/link-source.txt", "w", encoding="utf-8") as source:',
          '    source.write("linked\\\\n")',
          'os.link("/workspace/link-source.txt", "/workspace/link-hard.txt")',
          'try:',
          '    os.symlink("/workspace/link-source.txt", "/workspace/link-symlink.txt")',
          '    print("symlink:ok")',
          'except OSError as error:',
          '    print("symlink:" + ("ENOSYS" if error.errno == errno.ENOSYS else type(error).__name__))',
          'try:',
          '    js.eval(\\'pyodide.FS.symlink("/tracecode_project/link-source.txt", "/tracecode_project/provider-symlink.txt")\\')',
          '    print("provider-symlink:ok")',
          'except Exception as error:',
          '    print("provider-symlink:blocked")',
          'try:',
          '    os.readlink("/workspace/link-source.txt")',
          '    print("readlink:ok")',
          'except OSError:',
          '    print("readlink:blocked")',
          'print(open("/workspace/link-hard.txt", "r", encoding="utf-8").read(), end="")',
        ].join('\\n'),
        args: [],
        cwd: '/workspace',
        env: {},
        project: { cwd: '/workspace', files: [] },
      });

      const statvfsRun = await send('execute-project-python', {
        source: 'argument',
        scriptPath: '<string>',
        code: [
          'import os',
          'workspace = os.statvfs("/workspace")',
          'dev = os.statvfs("/dev/stdout")',
          'proc = os.statvfs("/proc/kernel/info")',
          'relative = os.statvfs(".")',
          'print(workspace.f_bsize > 0 and workspace.f_blocks > 0)',
          'print(dev.f_bsize == 4096 and dev.f_blocks == 1048576 and dev.f_bavail <= dev.f_bfree)',
          'print(proc.f_bsize == 4096 and proc.f_flag != 0)',
          'print(relative.f_bsize == workspace.f_bsize)',
          'for path in ["/dev/missing", "/proc/missing"]:',
          '    try:',
          '        os.statvfs(path)',
          '        print(path + ":ok")',
          '    except FileNotFoundError:',
          '        print(path + ":missing")',
        ].join('\\n'),
        args: [],
        cwd: '/workspace',
        env: {},
        project: {
          cwd: '/workspace',
          files: [],
          kernelFiles: [
            { path: '/proc/kernel/info', contents: 'tracekernel\\n' },
          ],
          kernelDevices: traceKernelDevices,
        },
      });

      const providerKernelVirtualMutationRun = await send('execute-project-python', {
        source: 'argument',
        scriptPath: '<string>',
        code: [
          'import js',
          'for expression, label in [',
          '    (\\'pyodide.FS.writeFile("/proc/kernel/info", "{}")\\', "proc-write"),',
          '    (\\'pyodide.FS.mkdir("/proc/kernel/new")\\', "proc-mkdir"),',
          '    (\\'pyodide.FS.writeFile("/dev/log", "leaked\\\\\\\\n", { encoding: "utf8" })\\', "dev-write"),',
          '    (\\'pyodide.FS.writeFile("/dev/stdout", "provider-stdout\\\\\\\\n", { encoding: "utf8" })\\', "dev-stdout-write"),',
          '    (\\'pyodide.FS.open("/dev/stdout", "w")\\', "dev-open-write"),',
          '    (\\'pyodide.FS.open("/dev/stdout", 1)\\', "dev-open-numeric-write"),',
          '    (\\'pyodide.FS.rename("/tracecode_project/provider-source.txt", "/dev/log")\\', "dev-rename-dest"),',
          ']:',
          '    try:',
          '        if label == "dev-rename-dest":',
          '            js.eval(\\'pyodide.FS.writeFile("/tracecode_project/provider-source.txt", "source\\\\\\\\n", { encoding: "utf8" })\\')',
          '        js.eval(expression)',
          '        print(label + ":ok")',
          '    except Exception:',
          '        print(label + ":blocked")',
          'with open("/workspace/after-provider-guard.txt", "w", encoding="utf-8") as handle:',
          '    handle.write("guarded\\\\n")',
        ].join('\\n'),
        args: [],
        cwd: '/workspace',
        env: {},
        project: {
          cwd: '/workspace',
          files: [],
          kernelDevices: traceKernelDevices,
          kernelFiles: [
            { path: '/proc/kernel/info', contents: 'tracekernel\\n' },
          ],
        },
      });

      const canonicalRootRun = await send('execute-project-python', {
        source: 'file',
        scriptPath: '/home/ada/weather-api/app.py',
        args: [],
        cwd: '/workspace/src',
        env: { PYTHONPATH: '/home/ada/weather-api/libs' },
        project: {
          cwd: '/home/ada/weather-api',
          workspaceRoot: '/home/ada/weather-api',
          workspaceAlias: '/workspace',
          kernel: {
            name: 'tracekernel',
            version: '0.7.0-test',
            workspaceRoot: '/home/ada/weather-api',
            workspaceAlias: '/workspace',
            workspace: { id: 'weather-api', name: 'weather-api', root: '/home/ada/weather-api', startedAt: '2026-05-18T00:00:00.000Z' },
            user: { id: 'ada', username: 'ada' },
            host: { hostname: 'tracevm-browser' },
          },
          kernelFiles: [
            { path: '/proc/kernel/info', contents: '{\\n  "name": "tracekernel"\\n}\\n' },
            { path: '/proc/kernel/version', contents: 'tracekernel test\\n' },
            { path: '/proc/self/mountinfo', contents: '26 0 0:3 / /proc rw,nosuid,nodev,noexec - tracefs tracekernel:proc rw\\n' },
          ],
          kernelDevices: [
            ...traceKernelDevices,
          ],
          files: [
            {
              path: 'app.py',
              contents: [
                'import os',
                'import json',
                'from helper import value',
                'print(os.getcwd())',
                'print(os.environ.get("HOME", ""))',
                'print(value())',
                'proc_info = json.load(open("/proc/kernel/info", "r", encoding="utf-8"))',
                'print(proc_info["name"])',
                'print(os.listdir("/proc/kernel"))',
                'print(open("/proc/kernel/version", "r", encoding="utf-8").read().strip())',
                'proc_fd = os.open("/proc/kernel/version", os.O_RDONLY)',
                'try:',
                '    print(os.read(proc_fd, 64).decode("utf-8").strip())',
                '    if hasattr(os, "fchmod"):',
                '        try:',
                '            os.fchmod(proc_fd, 0o600)',
                '            print("proc-fchmod:ok")',
                '        except OSError:',
                '            print("proc-fchmod:blocked")',
                '    else:',
                '        print("proc-fchmod:unavailable")',
                '    if hasattr(os, "fchown"):',
                '        try:',
                '            os.fchown(proc_fd, 1, 1)',
                '            print("proc-fchown:ok")',
                '        except OSError:',
                '            print("proc-fchown:blocked")',
                '    else:',
                '        print("proc-fchown:unavailable")',
                'finally:',
                '    os.close(proc_fd)',
                'proc_fdopen_fd = os.open("/proc/kernel/version", os.O_RDONLY)',
                'with os.fdopen(proc_fdopen_fd, "r", encoding="utf-8") as proc_fdopen:',
                '    print(proc_fdopen.read().strip())',
                'proc_fdopen_write_fd = os.open("/proc/kernel/version", os.O_RDONLY)',
                'try:',
                '    os.fdopen(proc_fdopen_write_fd, "w", encoding="utf-8")',
                '    print("proc-fdopen-write:ok")',
                'except OSError:',
                '    os.close(proc_fdopen_write_fd)',
                '    print("proc-fdopen-write:blocked")',
                'try:',
                '    os.open("/proc/kernel/version", os.O_WRONLY)',
                '    print("proc-os-write:ok")',
                'except OSError:',
                '    print("proc-os-write:blocked")',
                'print(os.path.isfile("/proc/kernel/info"))',
                'print(os.access("/proc/kernel/info", os.W_OK))',
                'print(",".join(os.listdir("/dev")))',
                'print(os.path.isdir("/dev"))',
                'print(os.path.isfile("/dev/stdout"))',
                'print(os.access("/dev/stdout", os.W_OK))',
                'print(os.access("/dev/stdin", os.W_OK))',
                'print(os.stat("/dev/stdout").st_size)',
                'print(",".join(sorted(entry.name + ":" + str(entry.is_file()) + ":" + str(entry.is_dir()) for entry in os.scandir("/dev"))))',
                'print(",".join(sorted(entry.name + ":" + str(entry.is_file()) + ":" + str(entry.is_dir()) for entry in os.scandir("/proc"))))',
                'with open("/home/ada/weather-api/canonical.txt", "w", encoding="utf-8") as handle:',
                '    handle.write("canonical\\\\n")',
                'with open("/workspace/alias.txt", "w", encoding="utf-8") as handle:',
                '    handle.write("alias\\\\n")',
                'try:',
                '    os.remove("/dev/stdout")',
                '    print("dev-remove:ok")',
                'except OSError:',
                '    print("dev-remove:blocked")',
                'try:',
                '    os.mkdir("/dev/new")',
                '    print("dev-mkdir:ok")',
                'except OSError:',
                '    print("dev-mkdir:blocked")',
                'try:',
                '    os.rename("/workspace/alias.txt", "/dev/stdout")',
                '    print("dev-rename:ok")',
                'except OSError:',
                '    print("dev-rename:blocked")',
                '',
              ].join('\\n'),
            },
            { path: 'libs/helper.py', contents: 'def value():\\n    return "helper-ok"\\n' },
          ],
        },
      });

      let outsideCwdError = '';
      try {
        await send('execute-project-python', {
          source: 'file',
          scriptPath: '/workspace/main.py',
          args: [],
          cwd: '/outside',
          env: {},
          project: { cwd: '/workspace', files: projectFiles },
        });
      } catch (error) {
        outsideCwdError = error instanceof Error ? error.message : String(error);
      }

      const asgiRunPromise = send('execute-project-python', {
        source: 'file',
        scriptPath: '/workspace/app.py',
        args: [],
        cwd: '/workspace',
        env: {},
        project: {
          cwd: '/workspace',
          files: [
            {
              path: 'app.py',
              contents: [
                'from fastapi import FastAPI',
                'import uvicorn',
                '',
                'app = FastAPI()',
                'items = []',
                '',
                '@app.post("/enqueue")',
                'def enqueue(item):',
                '    items.append(item)',
                '    return {"size": len(items)}',
                '',
                '@app.get("/dequeue")',
                'def dequeue():',
                '    return items.pop(0) if items else None',
                '',
                '@app.post("/items/{item_id}", status_code=201)',
                'def set_item(item_id, payload, verbose):',
                '    return {"item_id": item_id, "payload": payload, "verbose": verbose}',
                '',
                'uvicorn.run(app, host="127.0.0.1", port=8765)',
                '',
              ].join('\\n'),
            },
          ],
        },
      }, 120000);
      for (let attempt = 0; attempt < 100 && ![...listeners.values()].some((listener) => listener.info.port === 8765); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const asgiEnqueue = await dispatchHttp(8765, {
        method: 'POST',
        url: 'http://localhost:8765/enqueue',
        path: '/enqueue',
        headers: { 'content-type': 'application/json' },
        body: '{"id":1}',
      });
      const asgiDequeue = await dispatchHttp(8765, {
        method: 'GET',
        url: 'http://localhost:8765/dequeue',
        path: '/dequeue',
        headers: {},
        body: '',
      });
      const asgiRouteParams = await dispatchHttp(8765, {
        method: 'POST',
        url: 'http://localhost:8765/items/abc?verbose=true',
        path: '/items/abc?verbose=true',
        headers: { 'content-type': 'application/json' },
        body: '{"count":2}',
      });
      terminateWorker();
      try {
        await asgiRunPromise;
      } catch (error) {
        // Terminating the worker is how this smoke test stops the long-lived server.
      }

      return { fileRun, moduleRun, cwdRelativeFileRun, workspaceRelativeFileRun, stdinRun, argumentRun, noDeviceManifestRun, manifestCustomDeviceRun, sharedStdinCursorRun, fdReadlineRun, duplicateFdRun, vectoredFdRun, directoryRun, linkApiRun, statvfsRun, providerKernelVirtualMutationRun, canonicalRootRun, outsideCwdError, asgiEnqueue, asgiDequeue, asgiRouteParams };
    })()`) as {
      fileRun: PythonProjectWorkerResponse;
      moduleRun: PythonProjectWorkerResponse;
      cwdRelativeFileRun: PythonProjectWorkerResponse;
      workspaceRelativeFileRun: PythonProjectWorkerResponse;
      stdinRun: PythonProjectWorkerResponse;
      argumentRun: PythonProjectWorkerResponse;
      noDeviceManifestRun: PythonProjectWorkerResponse;
      manifestCustomDeviceRun: PythonProjectWorkerResponse;
      sharedStdinCursorRun: PythonProjectWorkerResponse;
      fdReadlineRun: PythonProjectWorkerResponse;
      duplicateFdRun: PythonProjectWorkerResponse;
      vectoredFdRun: PythonProjectWorkerResponse;
      directoryRun: PythonProjectWorkerResponse;
      linkApiRun: PythonProjectWorkerResponse;
      statvfsRun: PythonProjectWorkerResponse;
      providerKernelVirtualMutationRun: PythonProjectWorkerResponse;
      canonicalRootRun: PythonProjectWorkerResponse;
      outsideCwdError: string;
      asgiEnqueue: { status: number; headers?: Record<string, string>; body?: string };
      asgiDequeue: { status: number; headers?: Record<string, string>; body?: string };
      asgiRouteParams: { status: number; headers?: Record<string, string>; body?: string };
    };

    assertCondition(results.fileRun.exitCode === 0, `Python project file run should succeed: ${results.fileRun.stderr}`);
    assertCondition(
      results.fileRun.stdout === '42\nfrom-stdin\nbrowser-python-project\nalpha,beta\n/workspace\ndev-fd-stdin=\ndev-fdopen-stdin=\ndev-fd-custom-in=\ndev-custom-present=True\ndev-custom-access=True:True\ndev-file-custom-in=\ndev-file-custom-in-write-open:blocked\ndev-file-custom-in-chunks=||True\ndev-file-custom-in-binary=\ndev-file-custom-in-binary-chunks=||True\ndev-file-log-read-open:blocked\ndev-fd-out\ndev-fdopen-out\ndev-fd-tty\ndev-fd-tty-rw-read=\ndev-fd-tty-rw-write\ndev-file-tty\ndev-file-tty-lines\ndev-file-tty-rw-read=\ndev-file-tty-rw-eof=True\ndev-file-tty-rw-write\ndev-null=0\nprovider-hook-out\nprovider-hook-lines\nstdout-buffer\nafter-live-file\n',
      `Python project file stdout should match workspace semantics: ${JSON.stringify(results.fileRun.stdout)}`
    );
    assertCondition(
      results.fileRun.stderr === 'dev-file-log\ndev-file-log-binary\ndev-fd-log\ndev-fd-err\nprovider-hook-err\nstderr-buffer\nstderr-line\n',
      `Python project file stderr should match workspace semantics: ${JSON.stringify(results.fileRun.stderr)}`
    );
    assertCondition(
      results.fileRun.events
        ?.filter((event) => event.type === 'output' && event.stream === 'stdout' && event.device === '/dev/stdout')
        .map((event) => event.data)
        .join('') === results.fileRun.stdout,
      `Python project worker should stream stdout events: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events
        ?.filter((event) =>
          event.type === 'output' &&
          event.stream === 'stdout' &&
          event.device === '/dev/stdout' &&
          event.sourceDevice === '/dev/tty'
        )
        .map((event) => event.data)
        .join('') === 'dev-fd-tty\ndev-fd-tty-rw-write\ndev-file-tty\ndev-file-tty-lines\ndev-file-tty-rw-write\n',
      `Python project worker should preserve /dev/tty source device on routed output events: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events
        ?.filter((event) => event.type === 'output' && event.stream === 'stderr' && event.device === '/dev/stderr')
        .map((event) => event.data)
        .join('') === results.fileRun.stderr,
      `Python project worker should stream stderr events: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events
        ?.filter((event) =>
          event.type === 'output' &&
          event.stream === 'stderr' &&
          event.device === '/dev/stderr' &&
          event.sourceDevice === '/dev/log'
        )
        .map((event) => event.data)
        .join('') === 'dev-file-log\ndev-file-log-binary\ndev-fd-log\n',
      `Python project worker should support manifest-provided custom output devices: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      findFile(results.fileRun, 'generated.txt')?.contents === '42\n',
      'Python project file run should report generated text files'
    );
    assertCondition(
      findFile(results.fileRun, 'live-before-stdout.txt')?.contents === 'before-output\n',
      'Python project file run should report flushed live text files'
    );
    assertCondition(
      findFile(results.fileRun, 'writelines.txt')?.contents === 'line-a\nline-b\n',
      'Python project file run should report writelines side effects'
    );
    assertCondition(
      findFile(results.fileRun, 'bytes.bin')?.contents === 'AP8=' &&
        findFile(results.fileRun, 'bytes.bin')?.encoding === 'base64',
      'Python project file run should report generated binary files as base64'
    );
    assertCondition(
      findFile(results.fileRun, 'provider-live.txt')?.contents === 'provider-live\n',
      'Python project file run should report provider-level Pyodide FS writes'
    );
    assertCondition(
      findFile(results.fileRun, 'provider-empty.txt')?.contents === '',
      'Python project file run should report provider-level zero-byte creates'
    );
    assertCondition(
      findFile(results.fileRun, 'provider-create-data.txt')?.contents === 'provider-create-data\n',
      'Python project file run should report provider-level createDataFile writes'
    );
    assertCondition(
      findFile(results.fileRun, 'provider-created-path/nested/value.txt')?.contents === 'provider-created-path\n',
      'Python project file run should report provider-level createPath children'
    );
    assertCondition(
      findFile(results.fileRun, 'provider-tree-moved/nested/value.txt')?.contents === 'provider-tree\n',
      'Python project file run should report provider-level moved directory children'
    );
    assertCondition(
      findFile(results.fileRun, 'fd-live.txt')?.contents === 'fd-one\nfd-two\n',
      'Python project file run should report low-level fd side effects'
    );
    assertCondition(
      findFile(results.fileRun, 'fdopen-live.txt')?.contents === 'fdopen-one\n',
      'Python project file run should report os.fdopen side effects'
    );
    assertCondition(
      findFile(results.fileRun, 'fd-empty.txt')?.contents === '',
      'Python project file run should report low-level zero-byte creates'
    );
    assertCondition(
      findFile(results.fileRun, 'renamed-truncated.txt')?.contents === 'abc',
      'Python project file run should report truncate and rename side effects'
    );
    assertCondition(
      findFile(results.fileRun, 'os-truncate.txt')?.contents === 'abcd',
      'Python project file run should report os.truncate side effects'
    );
    assertCondition(
      findFile(results.fileRun, 'ftruncate.txt')?.contents === 'ab',
      'Python project file run should report os.ftruncate side effects'
    );
    assertCondition(findFile(results.fileRun, 'stale.txt')?.deleted === true, 'Python project file run should report deletions');
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'generated.txt' &&
        event.change.contents === '42\n'
      )) === true,
      `Python project worker should stream live text file mutations: ${JSON.stringify(results.fileRun.events)}`
    );
    const liveBeforeStdoutIndex = results.fileRun.events?.findIndex((event) => (
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change?.path === 'live-before-stdout.txt' &&
      event.change.contents === 'before-output\n'
    )) ?? -1;
    const stdoutAfterLiveIndex = results.fileRun.events?.findIndex((event) => (
      event.type === 'output' &&
      event.stream === 'stdout' &&
      event.device === '/dev/stdout' &&
      event.data === 'after-live-file\n'
    )) ?? -1;
    assertCondition(
      liveBeforeStdoutIndex >= 0 && stdoutAfterLiveIndex > liveBeforeStdoutIndex,
      `Python project worker should emit flushed file mutations before later stdout: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'bytes.bin' &&
        event.change.contents === 'AP8=' &&
        event.change.encoding === 'base64'
      )) === true,
      `Python project worker should stream live binary file mutations: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'writelines.txt' &&
        event.change.contents === 'line-a\nline-b\n'
      )) === true,
      `Python project worker should stream live writelines mutations: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'provider-live.txt' &&
        event.change.contents === 'provider-live\n'
      )) === true,
      `Python project worker should stream provider-level Pyodide FS mutations: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'provider-metadata.txt' &&
        event.change.contents === 'provider-meta\n'
      )) === true,
      `Python project worker should stream provider-level Pyodide FS metadata mutations: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'provider-empty.txt' &&
        event.change.contents === ''
      )) === true,
      `Python project worker should stream provider-level zero-byte creates: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'provider-create-data.txt' &&
        event.change.contents === 'provider-create-data\n'
      )) === true,
      `Python project worker should stream provider-level createDataFile writes: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'provider-create.txt' &&
        event.change.contents === ''
      )) === true,
      `Python project worker should stream provider-level create writes: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'provider-created-path' &&
        event.change.directory === true
      )) === true &&
        results.fileRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'provider-created-path/nested' &&
          event.change.directory === true
        )) === true &&
        results.fileRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'provider-created-path/nested/value.txt' &&
          event.change.contents === 'provider-created-path\n'
        )) === true,
      `Python project worker should stream provider-level createPath subtrees: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'provider-dir' &&
        event.change.directory === true
      )) === true &&
        results.fileRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'provider-dir' &&
          event.change.directory === true &&
          event.change.deleted === true
        )) === true &&
        results.fileRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'provider-renamed-dir' &&
          event.change.directory === true
        )) === true &&
        results.fileRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'provider-renamed-dir' &&
          event.change.directory === true &&
          event.change.deleted === true
        )) === true,
      `Python project worker should stream provider-level directory mutations: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'provider-tree' &&
        event.change.directory === true &&
        event.change.deleted === true
      )) === true &&
        results.fileRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'provider-tree-moved' &&
          event.change.directory === true
        )) === true &&
        results.fileRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'provider-tree-moved/nested' &&
          event.change.directory === true
        )) === true &&
        results.fileRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'provider-tree-moved/nested/value.txt' &&
          event.change.contents === 'provider-tree\n'
        )) === true,
      `Python project worker should stream provider-level moved directory subtrees: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'fd-live.txt' &&
        event.change.contents === 'fd-one\nfd-two\n'
      )) === true,
      `Python project worker should stream live os.write mutations: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'fdopen-live.txt' &&
        event.change.contents === 'fdopen-one\n'
      )) === true,
      `Python project worker should stream live os.fdopen mutations: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'fd-empty.txt' &&
        event.change.contents === ''
      )) === true,
      `Python project worker should stream low-level zero-byte creates: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'truncated.txt' &&
        event.change.contents === 'abc'
      )) === true,
      `Python project worker should stream live truncate mutations: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'os-truncate.txt' &&
        event.change.contents === 'abcd'
      )) === true,
      `Python project worker should stream live os.truncate mutations: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'ftruncate.txt' &&
        event.change.contents === 'ab'
      )) === true,
      `Python project worker should stream live os.ftruncate mutations: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'metadata-path.txt' &&
        event.change.contents === 'metadata-path\n'
      )) === true,
      `Python project worker should stream live path metadata mutations: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'metadata-fd.txt' &&
        event.change.contents === 'metadata-fd\n'
      )) === true,
      `Python project worker should stream live descriptor metadata mutations: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'truncated.txt' &&
        event.change.deleted === true
      )) === true &&
        results.fileRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'renamed-truncated.txt' &&
          event.change.contents === 'abc'
        )) === true,
      `Python project worker should stream live rename mutations: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'live-dir' &&
        event.change.directory === true
      )) === true &&
        results.fileRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'live-dir/child' &&
          event.change.directory === true
        )) === true &&
        results.fileRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'live-dir/child' &&
          event.change.directory === true &&
          event.change.deleted === true
        )) === true &&
        results.fileRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'live-dir/renamed-child' &&
          event.change.directory === true
        )) === true &&
        results.fileRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'live-dir/renamed-child' &&
          event.change.directory === true &&
          event.change.deleted === true
        )) === true &&
        results.fileRun.events?.some((event) => (
          event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change?.path === 'live-dir' &&
          event.change.directory === true &&
          event.change.deleted === true
      )) === true,
      `Python project worker should stream live directory mutations: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'live-dir/child' &&
        event.change.deleted === true &&
        event.change.directory !== true
      )) !== true,
      `Python project worker should not emit file-shaped deletes for directory renames: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      results.fileRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'stale.txt' &&
        event.change.deleted === true
      )) === true,
      `Python project worker should stream live deletions: ${JSON.stringify(results.fileRun.events)}`
    );

    assertCondition(results.moduleRun.exitCode === 0, `Python project module run should succeed: ${results.moduleRun.stderr}`);
    assertCondition(
      results.moduleRun.stdout === 'pythonpath-ok\nmodule-arg\n',
      `Python project module run should honor PYTHONPATH and argv: ${JSON.stringify(results.moduleRun.stdout)}`
    );

    assertCondition(results.cwdRelativeFileRun.exitCode === 0, `Python project cwd-relative file run should succeed: ${results.cwdRelativeFileRun.stderr}`);
    assertCondition(
      results.cwdRelativeFileRun.stdout === '/workspace/build\ncwd-pythonpath-ok\n',
      `Python project cwd-relative file run should honor cwd and PYTHONPATH: ${JSON.stringify(results.cwdRelativeFileRun.stdout)}`
    );
    assertCondition(
      findFile(results.cwdRelativeFileRun, 'build/generated.txt')?.contents === 'created\n',
      'Python project cwd-relative file run should report cwd-relative side effects'
    );
    assertCondition(
      results.workspaceRelativeFileRun.exitCode === 0 &&
        results.workspaceRelativeFileRun.stdout === '/workspace/src\nworkspace-relative-script\n',
      `Python project worker should resolve workspace-relative script paths before cwd-relative fallback: ${JSON.stringify(results.workspaceRelativeFileRun)}`
    );

    assertCondition(results.stdinRun.exitCode === 0, `Python project stdin source should succeed: ${results.stdinRun.stderr}`);
    assertCondition(
      results.stdinRun.stdout === 'stdin-source\nstdin-data\n',
      `Python project stdin source stdout should match: ${JSON.stringify(results.stdinRun.stdout)}`
    );

    assertCondition(results.argumentRun.exitCode === 0, `Python project argument source should succeed: ${results.argumentRun.stderr}`);
    assertCondition(
      results.argumentRun.stdout === 'argument-source\n/workspace\nx,y\n',
      `Python project argument source stdout should match: ${JSON.stringify(results.argumentRun.stdout)}`
    );
    assertCondition(results.noDeviceManifestRun.exitCode === 0, `Python project no-device-manifest run should succeed: ${results.noDeviceManifestRun.stderr}`);
    assertCondition(
      results.noDeviceManifestRun.stdout === '\nFalse\ndev-stdout:blocked\n',
      `Python project worker should not invent /dev devices without kernelDevices: ${JSON.stringify(results.noDeviceManifestRun.stdout)}`
    );
    assertCondition(results.manifestCustomDeviceRun.exitCode === 0, `Python project manifest custom device run should succeed: ${results.manifestCustomDeviceRun.stderr}`);
    assertCondition(
      results.manifestCustomDeviceRun.stdout === 'stdin-visible=\ncustom-file=manifest-stdin\ncustom-fd=\nnested-dev-dir=True:0\npts-file\npts-fd\ncapture-file\ncapture-fd\ntee-file\ntee-fd\n',
      `Python project custom input device should read from stdin: ${JSON.stringify(results.manifestCustomDeviceRun.stdout)}`
    );
    assertCondition(results.sharedStdinCursorRun.exitCode === 0, `Python project shared stdin cursor run should succeed: ${results.sharedStdinCursorRun.stderr}`);
    assertCondition(
      results.sharedStdinCursorRun.stdout === 'sys=one\ncustom=two<lf>three<lf>\n',
      `Python project sys.stdin and /dev devices should share one stdin cursor: ${JSON.stringify(results.sharedStdinCursorRun.stdout)}`
    );
    assertCondition(
      results.manifestCustomDeviceRun.stderr === 'log-file\nlog-fd\n',
      `Python project custom log device should write to stderr: ${JSON.stringify(results.manifestCustomDeviceRun.stderr)}`
    );
    assertCondition(
      results.manifestCustomDeviceRun.events
        ?.filter((event) =>
          event.type === 'output' &&
          event.stream === 'stderr' &&
          event.device === '/dev/stderr' &&
          event.sourceDevice === '/dev/log'
        )
        .map((event) => event.data)
        .join('') === 'log-file\nlog-fd\n',
      `Python project custom log device should preserve sourceDevice: ${JSON.stringify(results.manifestCustomDeviceRun.events)}`
    );
    assertCondition(
      results.manifestCustomDeviceRun.events
        ?.filter((event) =>
          event.type === 'output' &&
          event.stream === 'stdout' &&
          event.device === '/dev/stdout' &&
          event.sourceDevice === '/dev/pts/0'
        )
        .map((event) => event.data)
        .join('') === 'pts-file\npts-fd\n',
      `Python project nested custom output device should preserve sourceDevice: ${JSON.stringify(results.manifestCustomDeviceRun.events)}`
    );
    assertCondition(
      results.manifestCustomDeviceRun.events
        ?.filter((event) =>
          event.type === 'output' &&
          event.stream === 'stdout' &&
          event.device === '/dev/capture' &&
          event.sourceDevice === undefined
        )
        .map((event) => event.data)
        .join('') === 'capture-file\ncapture-fd\n',
      `Python project direct custom stdout-like device should preserve output device without redundant sourceDevice: ${JSON.stringify(results.manifestCustomDeviceRun.events)}`
    );
    assertCondition(
      results.manifestCustomDeviceRun.events
        ?.filter((event) =>
          event.type === 'output' &&
          event.stream === 'stdout' &&
          event.device === '/dev/capture' &&
          event.sourceDevice === '/dev/tee'
        )
        .map((event) => event.data)
        .join('') === 'tee-file\ntee-fd\n',
      `Python project custom stdout-like alias should preserve routed sourceDevice: ${JSON.stringify(results.manifestCustomDeviceRun.events)}`
    );
    assertCondition(results.fdReadlineRun.exitCode === 0, `Python project fd readline run should succeed: ${results.fdReadlineRun.stderr}`);
    assertCondition(
      results.fdReadlineRun.stdout === 'dev-line-1=dev-one\ndev-line-2=dev-two\ndev-rest=dev-three\nproc-line-1=proc-one\nproc-line-2=proc-two\nproc-rest=proc-three\n',
      `Python project fd readline should preserve unread virtual fd data: ${JSON.stringify(results.fdReadlineRun.stdout)}`
    );
    assertCondition(results.duplicateFdRun.exitCode === 0, `Python project duplicate fd run should succeed: ${results.duplicateFdRun.stderr}`);
    assertCondition(
      results.duplicateFdRun.stdout === 'dup-stdout\ndev-dup-read=dup-|stdin\nproc-dup=proc-|dup-one<lf>proc-dup-two\n',
      `Python project duplicated virtual fds should preserve device/proc behavior: ${JSON.stringify(results.duplicateFdRun.stdout)}`
    );
    assertCondition(
      results.duplicateFdRun.stderr === 'dup2-log\n',
      `Python project duplicated stderr-like virtual fds should route output: ${JSON.stringify(results.duplicateFdRun.stderr)}`
    );
    assertCondition(
      results.duplicateFdRun.events?.some((event) => (
        event.type === 'output' &&
        event.stream === 'stdout' &&
        event.device === '/dev/stdout' &&
        event.data === 'dup-stdout\n'
      )) === true,
      `Python project duplicated stdout fd should stream output events: ${JSON.stringify(results.duplicateFdRun.events)}`
    );
    assertCondition(
      results.duplicateFdRun.events?.some((event) => (
        event.type === 'output' &&
        event.stream === 'stderr' &&
        event.device === '/dev/stderr' &&
        event.sourceDevice === '/dev/log' &&
        event.data === 'dup2-log\n'
      )) === true,
      `Python project dup2 stderr-like fd should preserve source device events: ${JSON.stringify(results.duplicateFdRun.events)}`
    );
    assertCondition(results.vectoredFdRun.exitCode === 0, `Python project vectored fd run should succeed: ${results.vectoredFdRun.stderr}`);
    assertCondition(
      results.vectoredFdRun.stdout === 'readv=readv-one<lf>readv-two<lf>\nwritev-stdout\n',
      `Python project os.readv/os.writev stdout should match: ${JSON.stringify(results.vectoredFdRun.stdout)}`
    );
    assertCondition(
      results.vectoredFdRun.stderr === 'writev-log\n',
      `Python project os.writev stderr routing should match: ${JSON.stringify(results.vectoredFdRun.stderr)}`
    );
    assertCondition(
      findFile(results.vectoredFdRun, 'writev-live.txt')?.contents === 'writev-file\n',
      'Python project os.writev run should report final file contents'
    );
    assertCondition(
      results.vectoredFdRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'writev-live.txt' &&
        event.change.contents === 'writev-file\n'
      )) === true,
      `Python project worker should stream live os.writev mutations: ${JSON.stringify(results.vectoredFdRun.events)}`
    );
    assertCondition(
      results.vectoredFdRun.events?.some((event) => (
        event.type === 'output' &&
        event.stream === 'stdout' &&
        event.device === '/dev/stdout' &&
        event.data === 'writev-stdout\n'
      )) === true,
      `Python project worker should route os.writev stdout events: ${JSON.stringify(results.vectoredFdRun.events)}`
    );
    assertCondition(
      results.vectoredFdRun.events?.some((event) => (
        event.type === 'output' &&
        event.stream === 'stderr' &&
        event.device === '/dev/stderr' &&
        event.sourceDevice === '/dev/log' &&
        event.data === 'writev-log\n'
      )) === true,
      `Python project worker should route os.writev custom stderr events: ${JSON.stringify(results.vectoredFdRun.events)}`
    );
    assertCondition(results.directoryRun.exitCode === 0, `Python project directory source should succeed: ${results.directoryRun.stderr}`);
    assertCondition(
      results.directoryRun.stdout === 'True\nchild\n',
      `Python project worker should materialize snapshot directories: ${JSON.stringify(results.directoryRun.stdout)}`
    );
    assertCondition(results.linkApiRun.exitCode === 0, `Python project link API run should succeed: ${results.linkApiRun.stderr}`);
    assertCondition(
      results.linkApiRun.stdout === 'symlink:ENOSYS\nprovider-symlink:blocked\nreadlink:blocked\nlinked\n',
      `Python project link APIs should use manifest-representable semantics: ${JSON.stringify(results.linkApiRun.stdout)}`
    );
    assertCondition(
      findFile(results.linkApiRun, 'link-hard.txt')?.contents === 'linked\n',
      'Python project hard links should persist as regular file snapshots'
    );
    assertCondition(
      findFile(results.linkApiRun, 'link-symlink.txt') === undefined &&
        findFile(results.linkApiRun, 'provider-symlink.txt') === undefined,
      'Python project symlinks should not appear in final file diffs'
    );
    assertCondition(
      results.linkApiRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'link-hard.txt' &&
        event.change.contents === 'linked\n'
      )) === true,
      `Python project hard links should stream live file snapshots: ${JSON.stringify(results.linkApiRun.events)}`
    );
    assertCondition(
      results.linkApiRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        (event.change?.path === 'link-symlink.txt' || event.change?.path === 'provider-symlink.txt')
      )) !== true,
      `Python project rejected symlinks should not stream file mutations: ${JSON.stringify(results.linkApiRun.events)}`
    );
    assertCondition(results.statvfsRun.exitCode === 0, `Python project statvfs run should succeed: ${results.statvfsRun.stderr}`);
    assertCondition(
      results.statvfsRun.stdout === 'True\nTrue\nTrue\nTrue\n/dev/missing:missing\n/proc/missing:missing\n',
      `Python project statvfs should route through workspace and kernel paths: ${JSON.stringify(results.statvfsRun.stdout)}`
    );
    assertCondition(
      results.providerKernelVirtualMutationRun.exitCode === 0,
      `Python provider kernel virtual mutation run should succeed: ${results.providerKernelVirtualMutationRun.stderr}`
    );
    assertCondition(
      results.providerKernelVirtualMutationRun.stdout === 'proc-write:blocked\nproc-mkdir:blocked\ndev-write:ok\nprovider-stdout\ndev-stdout-write:ok\ndev-open-write:blocked\ndev-open-numeric-write:blocked\ndev-rename-dest:blocked\n',
      `Python provider-level Pyodide FS should route writable devices and block other kernel virtual mutations: ${JSON.stringify(results.providerKernelVirtualMutationRun.stdout)}`
    );
    assertCondition(
      results.providerKernelVirtualMutationRun.stderr === 'leaked\n',
      `Python provider-level Pyodide FS should route custom writable devices through stderr: ${JSON.stringify(results.providerKernelVirtualMutationRun.stderr)}`
    );
    assertCondition(
      results.providerKernelVirtualMutationRun.events?.some((event) => (
        event.type === 'output' &&
        event.stream === 'stderr' &&
        event.device === '/dev/stderr' &&
        event.sourceDevice === '/dev/log' &&
        event.data === 'leaked\n'
      )) === true,
      `Python provider-level Pyodide FS should preserve routed source device events: ${JSON.stringify(results.providerKernelVirtualMutationRun.events)}`
    );
    assertCondition(
      findFile(results.providerKernelVirtualMutationRun, 'after-provider-guard.txt')?.contents === 'guarded\n',
      'Python provider-level kernel guard should leave workspace writes functional'
    );
    assertCondition(
      results.providerKernelVirtualMutationRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        (event.change?.path.startsWith('/dev') || event.change?.path.startsWith('/proc'))
      )) !== true,
      `Python provider-level kernel guard should not emit virtual namespace file mutations: ${JSON.stringify(results.providerKernelVirtualMutationRun.events)}`
    );
    assertCondition(results.canonicalRootRun.exitCode === 0, `Python project canonical root run should succeed: ${results.canonicalRootRun.stderr}`);
    assertCondition(
      results.canonicalRootRun.stdout === "/home/ada/weather-api/src\n/home/ada\nhelper-ok\ntracekernel\n['info', 'version']\ntracekernel test\ntracekernel test\nproc-fchmod:blocked\nproc-fchown:blocked\ntracekernel test\nproc-fdopen-write:blocked\nproc-os-write:blocked\nTrue\nFalse\ncapture,custom-in,log,null,stderr,stdin,stdout,tee,tty\nTrue\nTrue\nTrue\nFalse\n0\ncapture:True:False,custom-in:True:False,log:True:False,null:True:False,stderr:True:False,stdin:True:False,stdout:True:False,tee:True:False,tty:True:False\nkernel:False:True,self:False:True\ndev-remove:blocked\ndev-mkdir:blocked\ndev-rename:blocked\n",
      `Python project canonical root run should report tracekernel paths: ${JSON.stringify(results.canonicalRootRun.stdout)}`
    );
    assertCondition(
      findFile(results.canonicalRootRun, 'canonical.txt')?.contents === 'canonical\n' &&
        findFile(results.canonicalRootRun, 'alias.txt')?.contents === 'alias\n',
      'Python project canonical root run should map canonical and alias writes'
    );
    assertCondition(
      results.canonicalRootRun.events?.some((event) => (
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change?.path === 'canonical.txt' &&
        event.change.contents === 'canonical\n'
      )) === true,
      `Python project canonical root run should stream live canonical writes: ${JSON.stringify(results.canonicalRootRun.events)}`
    );
    assertCondition(
      results.outsideCwdError.includes('Project cwd must stay inside the workspace'),
      `Python project worker should reject cwd outside workspace: ${results.outsideCwdError}`
    );
    assertCondition(
      results.asgiEnqueue.status === 200 && results.asgiEnqueue.body === '{"size":1}\n',
      `Python project ASGI shim should enqueue through TraceKernel HTTP: ${JSON.stringify(results.asgiEnqueue)}`
    );
    assertCondition(
      results.asgiDequeue.status === 200 && results.asgiDequeue.body === '{"id":1}\n',
      `Python project ASGI shim should dequeue through TraceKernel HTTP: ${JSON.stringify(results.asgiDequeue)}`
    );
    assertCondition(
      results.asgiRouteParams.status === 201 &&
        results.asgiRouteParams.body === '{"item_id":"abc","payload":{"count":2},"verbose":"true"}\n',
      `Python project ASGI shim should support route params, query params, and decorator status codes: ${JSON.stringify(results.asgiRouteParams)}`
    );
  } finally {
    await browser.close();
    if (!server.killed) {
      server.kill('SIGTERM');
    }
    await new Promise<void>((resolve) => server.once('exit', () => resolve()));
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

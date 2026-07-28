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
              path: 'terminal-control.py',
              contents: [
                'import os',
                'import signal',
                'import sys',
                'import termios',
                'from tracekernel import terminal',
                'resize_signals = []',
                'signal.signal(signal.SIGWINCH, lambda signum, frame: resize_signals.append(signum))',
                'foreground = os.tcgetpgrp(0)',
                'transferred = os.tcsetpgrp(0, foreground)',
                'initial_os_size = os.get_terminal_size(1)',
                'initial_termios_size = termios.tcgetwinsize(0)',
                'initial_api_size = terminal.window_size()',
                'resized = termios.tcsetwinsize(0, (66, 166))',
                'valid = (',
                '    os.isatty(0) and os.isatty(1) and os.isatty(2)',
                '    and terminal.isatty(0)',
                '    and terminal.foreground_process_group() == foreground',
                '    and transferred == foreground',
                '    and terminal.set_foreground_process_group(foreground) == foreground',
                '    and initial_os_size == (144, 55)',
                '    and initial_termios_size == (55, 144)',
                '    and initial_api_size == (55, 144)',
                '    and resized is None',
                '    and os.get_terminal_size(1) == (166, 66)',
                '    and terminal.window_size() == (66, 166)',
                '    and terminal.set_window_size(77, 177) == (77, 177)',
                '    and termios.tcgetwinsize(2) == (77, 177)',
                '    and resize_signals == [signal.SIGWINCH, signal.SIGWINCH]',
                ')',
                'standard_input = input()',
                'print(f"terminal:{str(valid).lower()}:{standard_input}")',
                'print("kernel-stderr", file=sys.stderr)',
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
                'import os',
                'from pathlib import Path',
                'isolated = not hasattr(builtins, "tracekernel_parent_secret")',
                'pid = os.getpid()',
                'created_sid = os.setsid()',
                'visible_sid = os.getsid(0)',
                'visible_pgid = os.getpgrp()',
                'topology = created_sid == pid and visible_sid == pid and visible_pgid == pid',
                'builtins.tracekernel_parent_secret = "child"',
                'pipe_value = input().strip()',
                'parent = Path("spawn-parent.txt").read_text().strip()',
                'Path("spawn-python-child.txt").write_text(f"{parent}:python\\n")',
                'print(f"python-child:{str(isolated).lower()}:{str(topology).lower()}:{pipe_value}")',
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
                '    and python.stdout == "python-child:true:true:through-kernel-pipe\\n"',
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
              path: 'wait-child.py',
              contents: 'raise SystemExit(42)\n',
            },
            {
              path: 'group-parent.py',
              contents: [
                'import errno',
                'import os',
                'import signal',
                'import subprocess',
                'import time',
                'from pathlib import Path',
                'leader = subprocess.Popen(',
                '    ["node", "group-leader.js"],',
                '    start_new_session=True,',
                ')',
                'if os.waitpid(-1, os.WNOHANG) != (0, 0):',
                '    raise RuntimeError("waitpid(-1, WNOHANG) reaped a running child")',
                'if leader.poll() is not None:',
                '    raise RuntimeError("nonblocking poll reaped a running child")',
                'try:',
                '    leader.wait(timeout=0.02)',
                '    raise RuntimeError("timed wait completed for a running child")',
                'except subprocess.TimeoutExpired:',
                '    pass',
                'deadline = time.monotonic() + 5',
                'ready = Path("python-group-ready.txt")',
                'while not ready.exists() and time.monotonic() < deadline:',
                '    time.sleep(0.01)',
                'if not ready.exists():',
                '    raise RuntimeError("detached JavaScript group did not start")',
                'leader_pid, child_pid = map(int, ready.read_text().split(":"))',
                'if leader_pid != leader.pid or child_pid == leader.pid:',
                '    raise RuntimeError("invalid group process identities")',
                'if os.getpgid(leader.pid) != leader.pid or os.getsid(leader.pid) != leader.pid:',
                '    raise RuntimeError("target process topology was not kernel-visible")',
                'os.killpg(leader.pid, signal.SIGHUP)',
                'waited_leader, leader_status = os.waitpid(-leader.pid, 0)',
                'local = subprocess.Popen(["python", "wait-child.py"])',
                'waited_local, local_status = os.waitpid(0, 0)',
                'no_children = False',
                'try:',
                '    os.waitpid(-1, os.WNOHANG)',
                'except ChildProcessError as error:',
                '    no_children = error.errno == errno.ECHILD',
                'time.sleep(0.65)',
                'valid = (',
                '    waited_leader == leader.pid',
                '    and os.WIFSIGNALED(leader_status)',
                '    and os.WTERMSIG(leader_status) == signal.SIGHUP',
                '    and waited_local == local.pid',
                '    and os.WIFEXITED(local_status)',
                '    and os.WEXITSTATUS(local_status) == 42',
                '    and no_children',
                '    and not Path("python-group-survived.txt").exists()',
                ')',
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
              path: 'python-fd-child.js',
              contents: [
                'const fs = require("node:fs");',
                'const fd = Number(process.argv[2]);',
                'const value = process.argv[3];',
                'fs.writeSync(fd, value);',
                'if (process.argv[4] === "merge") {',
                '  fs.writeSync(1, "stdout-through-pipe\\n");',
                '  fs.writeSync(2, "stderr-through-dup2\\n");',
                '}',
                '',
              ].join('\n'),
            },
            {
              path: 'python-fd-parent.py',
              contents: [
                'import os',
                'import fcntl',
                'import errno',
                'import select',
                'import selectors',
                'from pathlib import Path',
                'import subprocess',
                'pipe_reader, pipe_writer = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)',
                'try:',
                '    if os.get_inheritable(pipe_reader) or os.get_inheritable(pipe_writer):',
                '        raise RuntimeError("pipe2(O_CLOEXEC) returned inheritable descriptors")',
                '    if os.get_blocking(pipe_reader) or not (fcntl.fcntl(pipe_reader, fcntl.F_GETFL) & os.O_NONBLOCK):',
                '        raise RuntimeError("pipe2(O_NONBLOCK) did not publish status flags")',
                '    empty_would_block = False',
                '    empty_error = None',
                '    try:',
                '        os.read(pipe_reader, 1)',
                '    except OSError as error:',
                '        empty_error = (type(error).__name__, error.errno, errno.EAGAIN, str(error))',
                '        empty_would_block = error.errno == errno.EAGAIN',
                '    if not empty_would_block:',
                '        raise RuntimeError(f"empty nonblocking pipe read did not return EAGAIN: {empty_error!r}")',
                '    poller = select.poll()',
                '    poller.register(pipe_reader, select.POLLIN)',
                '    poller.register(pipe_writer, select.POLLOUT)',
                '    initial_events = dict(poller.poll(0))',
                '    if initial_events.get(pipe_reader, 0) != 0 or not (initial_events.get(pipe_writer, 0) & select.POLLOUT):',
                '        raise RuntimeError(f"initial poll readiness was wrong: {initial_events!r}")',
                '    selected_read, selected_write, selected_error = select.select([pipe_reader], [pipe_writer], [], 0)',
                '    if selected_read or selected_write != [pipe_writer] or selected_error:',
                '        raise RuntimeError("select.select did not report only the writable pipe endpoint")',
                '    selector = selectors.DefaultSelector()',
                '    selector.register(pipe_reader, selectors.EVENT_READ)',
                '    if selector.select(0):',
                '        raise RuntimeError("selectors reported an empty pipe as readable")',
                '    duplicate_writer = os.dup(pipe_writer)',
                '    try:',
                '        os.set_blocking(duplicate_writer, True)',
                '        if not os.get_blocking(pipe_writer):',
                '            raise RuntimeError("O_NONBLOCK was not shared across dup")',
                '        fcntl.fcntl(pipe_writer, fcntl.F_SETFL, os.O_NONBLOCK)',
                '        os.write(duplicate_writer, b"python-kernel-pipe")',
                '    finally:',
                '        os.close(duplicate_writer)',
                '    os.close(pipe_writer)',
                '    pipe_writer = -1',
                '    readable_events = dict(poller.poll(1000))',
                '    if not (readable_events.get(pipe_reader, 0) & select.POLLIN) or not (readable_events.get(pipe_reader, 0) & select.POLLHUP):',
                '        raise RuntimeError(f"poll did not report buffered EOF readiness: {readable_events!r}")',
                '    if not selector.select(0):',
                '        raise RuntimeError("selectors did not report a readable pipe")',
                '    selector.close()',
                '    pipe_value = os.read(pipe_reader, 64)',
                'finally:',
                '    if pipe_writer >= 0:',
                '        os.close(pipe_writer)',
                '    os.close(pipe_reader)',
                'cross_reader, cross_writer = os.pipe()',
                'try:',
                '    pipe_child = subprocess.Popen(',
                '        ["node", "python-fd-child.js", str(cross_writer), "cross-language-pipe"],',
                '        pass_fds=(cross_writer,),',
                '        stdout=subprocess.DEVNULL,',
                '        stderr=subprocess.DEVNULL,',
                '    )',
                '    os.close(cross_writer)',
                '    cross_writer = -1',
                '    cross_pipe_value = os.read(cross_reader, 64)',
                '    pipe_child_code = pipe_child.wait()',
                'finally:',
                '    if cross_writer >= 0:',
                '        os.close(cross_writer)',
                '    os.close(cross_reader)',
                'passed = os.open("python-pass-fd.txt", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)',
                'if os.get_inheritable(passed) or not (fcntl.fcntl(passed, fcntl.F_GETFD) & fcntl.FD_CLOEXEC):',
                '    raise RuntimeError("Python open descriptor was not close-on-exec")',
                'try:',
                '    child = subprocess.Popen(',
                '        ["node", "python-fd-child.js", str(passed), "through-pass-fds", "merge"],',
                '        pass_fds=(passed,),',
                '        stdout=subprocess.PIPE,',
                '        stderr=subprocess.STDOUT,',
                '        text=True,',
                '    )',
                '    merged, separate = child.communicate()',
                'finally:',
                '    os.close(passed)',
                'inherited = os.open("python-close-fds-false.txt", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)',
                'try:',
                '    os.set_inheritable(inherited, True)',
                '    if not os.get_inheritable(inherited):',
                '        raise RuntimeError("Python inheritable descriptor flag did not persist")',
                '    inherited_child = subprocess.Popen(',
                '        ["node", "python-fd-child.js", str(inherited), "through-close-fds-false"],',
                '        close_fds=False,',
                '        stdout=subprocess.DEVNULL,',
                '        stderr=subprocess.DEVNULL,',
                '    )',
                '    inherited_code = inherited_child.wait()',
                'finally:',
                '    os.close(inherited)',
                'valid = (',
                '    child.returncode == 0',
                '    and merged == "stdout-through-pipe\\nstderr-through-dup2\\n"',
                '    and separate is None',
                '    and Path("python-pass-fd.txt").read_text() == "through-pass-fds"',
                '    and inherited_code == 0',
                '    and Path("python-close-fds-false.txt").read_text() == "through-close-fds-false"',
                '    and pipe_value == b"python-kernel-pipe"',
                '    and pipe_child_code == 0',
                '    and cross_pipe_value == b"cross-language-pipe"',
                ')',
                'print(f"fd-inheritance:{str(valid).lower()}")',
                '',
              ].join('\n'),
            },
            {
              path: 'socket-parent.py',
              contents: [
                'import errno',
                'import select',
                'import selectors',
                'import socket',
                'import subprocess',
                'with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:',
                '    server.bind(("127.0.0.1", 0))',
                '    server.listen(4)',
                '    listener_poll = select.poll()',
                '    listener_poll.register(server, select.POLLIN)',
                '    if listener_poll.poll(0):',
                '        raise RuntimeError("empty TCP listener reported readable")',
                '    listener_selector = selectors.DefaultSelector()',
                '    listener_selector.register(server, selectors.EVENT_READ)',
                '    if listener_selector.select(0):',
                '        raise RuntimeError("selectors reported an empty TCP listener")',
                '    server.setblocking(False)',
                '    nonblocking_accept = False',
                '    try:',
                '        server.accept()',
                '    except OSError as error:',
                '        nonblocking_accept = error.errno == errno.EAGAIN',
                '    if not nonblocking_accept or server.getblocking():',
                '        raise RuntimeError("nonblocking listener accept did not return EAGAIN")',
                '    server.setblocking(True)',
                '    host, port = server.getsockname()',
                '    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as pending:',
                '        pending.setblocking(False)',
                '        connect_result = pending.connect_ex((host, port))',
                '        if connect_result != errno.EINPROGRESS:',
                '            raise RuntimeError(f"nonblocking connect returned {connect_result}")',
                '        pending_poll = select.poll()',
                '        pending_poll.register(pending, select.POLLOUT)',
                '        if not (dict(pending_poll.poll(5000)).get(pending.fileno(), 0) & select.POLLOUT):',
                '            raise RuntimeError("nonblocking connect did not become writable")',
                '        if pending.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) != 0:',
                '            raise RuntimeError("successful nonblocking connect retained SO_ERROR")',
                '        with server.accept()[0]:',
                '            pass',
                '    child = subprocess.Popen(',
                '        ["node", "socket-child.js", str(port)],',
                '        stdout=subprocess.PIPE,',
                '        stderr=subprocess.PIPE,',
                '        text=True,',
                '    )',
                '    if not (dict(listener_poll.poll(5000)).get(server.fileno(), 0) & select.POLLIN):',
                '        raise RuntimeError("connecting child did not make listener poll-readable")',
                '    if not listener_selector.select(0):',
                '        raise RuntimeError("selectors did not report the queued connection")',
                '    listener_selector.close()',
                '    with server.accept()[0] as connection:',
                '        readable, writable, exceptional = select.select([connection], [connection], [], 1.0)',
                '        if connection not in readable or connection not in writable or exceptional:',
                '            raise RuntimeError("select.select did not expose connected stream readiness")',
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
                '    and nonblocking_accept',
                '    and payload == b"fragment-payload"',
                '    and stdout == "socket-child:FRAGMENT-PAYLOAD\\n"',
                '    and stderr == ""',
                '    and child.returncode == 0',
                ')',
                'print(f"socket:{str(valid).lower()}")',
                '',
              ].join('\n'),
            },
            {
              path: 'orphan-parent.py',
              contents: [
                'import subprocess',
                'subprocess.Popen(["python", "orphan-python-child.py"])',
                'subprocess.Popen(["node", "orphan-js-child.js"])',
                'print("orphan-parent")',
                '',
              ].join('\n'),
            },
            {
              path: 'orphan-python-child.py',
              contents: [
                'import os',
                'import time',
                'from pathlib import Path',
                'time.sleep(0.1)',
                'Path("orphan-python-identity.txt").write_text(str(os.getppid()))',
                '',
              ].join('\n'),
            },
            {
              path: 'orphan-js-child.js',
              contents: [
                'setTimeout(() => {',
                '  require("node:fs").writeFileSync(',
                '    "orphan-js-identity.txt",',
                '    String(process.ppid)',
                '  );',
                '}, 100);',
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
          const descriptorInheritance = await workspace.runCommand(
            'python python-fd-parent.py'
          );
          const terminal = workspace.createTerminalSession();
          terminal.resize(144, 55);
          const pendingTerminalControl = terminal.run(
            'python terminal-control.py'
          );
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
          if (
            !terminal.writeStdin('kernel-stdin\n') ||
            !terminal.endStdin()
          ) {
            throw new Error(
              'Python terminal did not accept kernel-owned fd 0 input.'
            );
          }
          const terminalControl = await pendingTerminalControl;
          const orphanParent = await workspace.runCommand(
            'python orphan-parent.py'
          );
          let orphanPythonParent: string | null = null;
          let orphanJavaScriptParent: string | null = null;
          for (let attempt = 0; attempt < 500; attempt += 1) {
            try {
              orphanPythonParent = await workspace.readFile(
                'orphan-python-identity.txt'
              );
              orphanJavaScriptParent = await workspace.readFile(
                'orphan-js-identity.txt'
              );
              if (
                (orphanPythonParent?.length ?? 0) > 0 &&
                (orphanJavaScriptParent?.length ?? 0) > 0
              ) {
                break;
              }
            } catch {
              await new Promise((resolvePromise) =>
                setTimeout(resolvePromise, 10)
              );
            }
          }
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
            descriptorInheritance,
            terminalControl,
            orphanParent,
            orphanPythonParent,
            orphanJavaScriptParent,
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
        result.orphanParent.exitCode === 0 &&
          result.orphanParent.stdout === 'orphan-parent\n' &&
          result.orphanPythonParent === '1' &&
          result.orphanJavaScriptParent === '1',
        `orphaned runtime children did not observe kernel reparenting: ${JSON.stringify({
          parent: result.orphanParent,
          python: result.orphanPythonParent,
          javascript: result.orphanJavaScriptParent,
        })}`
      );
      assertCondition(
        result.socketControl.exitCode === 0 &&
          result.socketControl.stdout === 'socket:true\n',
        `Python and JavaScript did not share kernel TCP streams: ${JSON.stringify(result.socketControl)}`
      );
      assertCondition(
        result.descriptorInheritance.exitCode === 0 &&
          result.descriptorInheritance.stdout === 'fd-inheritance:true\n',
        `Python subprocess descriptor inheritance/remapping was not kernel-owned: ${JSON.stringify(
          result.descriptorInheritance
        )}`
      );
      assertCondition(
        result.terminalControl.exitCode === 0 &&
          result.terminalControl.stdout ===
            'terminal:true:kernel-stdin\n' &&
          result.terminalControl.stderr === 'kernel-stderr\n',
        `Python terminal controls did not use kernel-owned terminal state: ${JSON.stringify(
          result.terminalControl
        )}`
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
        descriptorStandardIo: true,
        childProcesses: ['javascript', 'python'],
        dynamicProcessIdentity: ['python', 'javascript', 'orphan-reparenting'],
        processGroups: [
          'start_new_session',
          'os.setsid',
          'os.setpgid',
          'os.getpid/getppid/getpgrp/getsid',
          'os.kill',
          'os.killpg',
          'SIGHUP/SIGQUIT-termination',
        ],
        terminalJobControl: [
          'os.isatty',
          'os.tcgetpgrp',
          'os.tcsetpgrp',
          'os.get_terminal_size',
          'termios.tcgetwinsize/tcsetwinsize',
          'tracekernel.terminal.window_size',
          'signal.SIGWINCH-safe-point-delivery',
          'tracekernel.terminal',
        ],
        childWait: [
          'Popen.poll',
          'Popen.wait(timeout)',
          'waitpid(-1)',
          'waitpid(0)',
          'waitpid(-pgid)',
          'WNOHANG',
          'ECHILD',
          'exactly-once-reap',
        ],
        descriptorInheritance: [
          'os.pipe/os.pipe2',
          'O_NONBLOCK/EAGAIN',
          'os.get_blocking/os.set_blocking',
          'cross-language-pipe-pass_fds',
          'pass_fds',
          'close_fds=false',
          'stderr=STDOUT',
          'os.get_inheritable',
          'os.set_inheritable',
          'fcntl(F_GETFD/F_SETFD/F_GETFL/F_SETFL)',
          'select.poll/select.select/selectors',
        ],
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

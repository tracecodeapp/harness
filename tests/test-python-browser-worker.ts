#!/usr/bin/env npx tsx

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runCommand, waitForHttp } from './example-app-smoke';

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

  const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', tempRoot], {
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
      const pending = new Map();

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
        pending.delete(id);
        if (type === 'error') {
          request.reject(new Error(String((payload && payload.error) || 'Python worker error')));
        } else {
          request.resolve({ ...payload, events: request.events });
        }
      };
      worker.onerror = (event) => {
        for (const request of pending.values()) {
          request.reject(new Error(event.message || 'Python worker error'));
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

      await send('init', {}, 120000);

      const traceKernelDevices = [
        { path: '/dev/stdin', readable: true, writable: false, inputDevice: '/dev/stdin' },
        { path: '/dev/stdout', readable: false, writable: true, outputDevice: '/dev/stdout' },
        { path: '/dev/stderr', readable: false, writable: true, outputDevice: '/dev/stderr' },
        { path: '/dev/tty', readable: true, writable: true, inputDevice: '/dev/stdin', outputDevice: '/dev/stdout' },
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
            'stdout_fd = os.open("/dev/stdout", os.O_WRONLY)',
            'try:',
            '    os.write(stdout_fd, b"dev-fd-out\\\\n")',
            'finally:',
            '    os.close(stdout_fd)',
            'stderr_fd = os.open("/dev/stderr", os.O_WRONLY)',
            'try:',
            '    os.write(stderr_fd, b"dev-fd-err\\\\n")',
            'finally:',
            '    os.close(stderr_fd)',
            'print("stderr-line", file=sys.stderr)',
            'with open("/workspace/generated.txt", "w", encoding="utf-8") as handle:',
            '    handle.write(str(answer()) + "\\\\n")',
            'with open("bytes.bin", "wb") as handle:',
            '    handle.write(bytes([0, 255]))',
            'js.eval(\\'pyodide.FS.writeFile("/tracecode_project/provider-live.txt", "provider-live\\\\\\\\n", { encoding: "utf8" })\\')',
            'fd = os.open("/workspace/fd-live.txt", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o666)',
            'try:',
            '    os.write(fd, b"fd-one\\\\n")',
            '    os.write(fd, b"fd-two\\\\n")',
            'finally:',
            '    os.close(fd)',
            'with open("/workspace/truncated.txt", "w+", encoding="utf-8") as handle:',
            '    handle.write("abcdef")',
            '    handle.truncate(3)',
            'os.rename("/workspace/truncated.txt", "/workspace/renamed-truncated.txt")',
            'with open("/workspace/os-truncate.txt", "w", encoding="utf-8") as handle:',
            '    handle.write("abcdef")',
            'os.truncate("/workspace/os-truncate.txt", 4)',
            'fd = os.open("/workspace/ftruncate.txt", os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o666)',
            'try:',
            '    os.write(fd, b"abcdef")',
            '    os.ftruncate(fd, 2)',
            'finally:',
            '    os.close(fd)',
            'os.remove("/workspace/stale.txt")',
            '',
          ].join('\\n'),
        },
        { path: 'helpers/value.py', contents: 'def answer():\\n    return 42\\n' },
        { path: 'stale.txt', contents: 'delete me\\n' },
      ];

      const fileRun = await send('execute-project-python', {
        source: 'file',
        scriptPath: '/workspace/main.py',
        args: ['alpha', 'beta'],
        cwd: '/workspace',
        env: { MODE: 'browser-python-project' },
        stdin: 'from-stdin\\n',
        project: { cwd: '/workspace', files: projectFiles, kernelDevices: traceKernelDevices },
      });

      const moduleRun = await send('execute-project-python', {
        source: 'module',
        scriptPath: 'app',
        args: ['module-arg'],
        cwd: '/workspace',
        env: { PYTHONPATH: '/workspace/libs' },
        stdin: '',
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
        stdin: '',
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
        stdin: '',
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
        stdin: 'stdin-data\\n',
        project: { cwd: '/workspace', files: [] },
      });

      const argumentRun = await send('execute-project-python', {
        source: 'argument',
        scriptPath: '<string>',
        code: 'import os, sys\\nprint("argument-source")\\nprint(os.getcwd())\\nprint(",".join(sys.argv[1:]))\\n',
        args: ['x', 'y'],
        cwd: '/workspace',
        env: {},
        stdin: '',
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
        stdin: '',
        project: { cwd: '/workspace', files: [] },
      });

      const directoryRun = await send('execute-project-python', {
        source: 'argument',
        scriptPath: '<string>',
        code: 'import os\\nprint(os.path.isdir("/workspace/empty/child"))\\nprint(",".join(os.listdir("/workspace/empty")))\\n',
        args: [],
        cwd: '/workspace',
        env: {},
        stdin: '',
        project: { cwd: '/workspace', directories: ['empty/child'], files: [] },
      });

      const canonicalRootRun = await send('execute-project-python', {
        source: 'file',
        scriptPath: '/home/ada/weather-api/app.py',
        args: [],
        cwd: '/workspace/src',
        env: { PYTHONPATH: '/home/ada/weather-api/libs' },
        stdin: '',
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
                'finally:',
                '    os.close(proc_fd)',
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
          stdin: '',
          project: { cwd: '/workspace', files: projectFiles },
        });
      } catch (error) {
        outsideCwdError = error instanceof Error ? error.message : String(error);
      }

      worker.terminate();
      return { fileRun, moduleRun, cwdRelativeFileRun, workspaceRelativeFileRun, stdinRun, argumentRun, noDeviceManifestRun, directoryRun, canonicalRootRun, outsideCwdError };
    })()`) as {
      fileRun: PythonProjectWorkerResponse;
      moduleRun: PythonProjectWorkerResponse;
      cwdRelativeFileRun: PythonProjectWorkerResponse;
      workspaceRelativeFileRun: PythonProjectWorkerResponse;
      stdinRun: PythonProjectWorkerResponse;
      argumentRun: PythonProjectWorkerResponse;
      noDeviceManifestRun: PythonProjectWorkerResponse;
      directoryRun: PythonProjectWorkerResponse;
      canonicalRootRun: PythonProjectWorkerResponse;
      outsideCwdError: string;
    };

    assertCondition(results.fileRun.exitCode === 0, `Python project file run should succeed: ${results.fileRun.stderr}`);
    assertCondition(
      results.fileRun.stdout === '42\nfrom-stdin\nbrowser-python-project\nalpha,beta\n/workspace\ndev-fd-stdin=from-stdin\ndev-fd-out\n',
      `Python project file stdout should match workspace semantics: ${JSON.stringify(results.fileRun.stdout)}`
    );
    assertCondition(
      results.fileRun.stderr === 'dev-fd-err\nstderr-line\n',
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
        ?.filter((event) => event.type === 'output' && event.stream === 'stderr' && event.device === '/dev/stderr')
        .map((event) => event.data)
        .join('') === results.fileRun.stderr,
      `Python project worker should stream stderr events: ${JSON.stringify(results.fileRun.events)}`
    );
    assertCondition(
      findFile(results.fileRun, 'generated.txt')?.contents === '42\n',
      'Python project file run should report generated text files'
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
      findFile(results.fileRun, 'fd-live.txt')?.contents === 'fd-one\nfd-two\n',
      'Python project file run should report low-level fd side effects'
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
        event.change?.path === 'provider-live.txt' &&
        event.change.contents === 'provider-live\n'
      )) === true,
      `Python project worker should stream provider-level Pyodide FS mutations: ${JSON.stringify(results.fileRun.events)}`
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
    assertCondition(results.directoryRun.exitCode === 0, `Python project directory source should succeed: ${results.directoryRun.stderr}`);
    assertCondition(
      results.directoryRun.stdout === 'True\nchild\n',
      `Python project worker should materialize snapshot directories: ${JSON.stringify(results.directoryRun.stdout)}`
    );
    assertCondition(results.canonicalRootRun.exitCode === 0, `Python project canonical root run should succeed: ${results.canonicalRootRun.stderr}`);
    assertCondition(
      results.canonicalRootRun.stdout === "/home/ada/weather-api/src\n/home/ada\nhelper-ok\ntracekernel\n['info', 'version']\ntracekernel test\ntracekernel test\nproc-os-write:blocked\nTrue\nFalse\nstderr,stdin,stdout,tty\nTrue\nTrue\nTrue\nFalse\n0\nstderr:True:False,stdin:True:False,stdout:True:False,tty:True:False\nkernel:False:True,self:False:True\ndev-remove:blocked\ndev-mkdir:blocked\ndev-rename:blocked\n",
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

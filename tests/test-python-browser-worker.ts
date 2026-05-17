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
        pending.delete(id);
        if (type === 'error') {
          request.reject(new Error(String((payload && payload.error) || 'Python worker error')));
        } else {
          request.resolve(payload);
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

      const projectFiles = [
        {
          path: 'main.py',
          contents: [
            'import os',
            'import sys',
            'from helpers.value import answer',
            '',
            'line = sys.stdin.readline().strip()',
            'print(answer())',
            'print(line)',
            'print(os.environ.get("MODE", ""))',
            'print(",".join(sys.argv[1:]))',
            'print(os.getcwd())',
            'with open("/workspace/generated.txt", "w", encoding="utf-8") as handle:',
            '    handle.write(str(answer()) + "\\\\n")',
            'with open("bytes.bin", "wb") as handle:',
            '    handle.write(bytes([0, 255]))',
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
        project: { cwd: '/workspace', files: projectFiles },
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
      return { fileRun, moduleRun, cwdRelativeFileRun, workspaceRelativeFileRun, stdinRun, argumentRun, directoryRun, outsideCwdError };
    })()`) as {
      fileRun: PythonProjectWorkerResponse;
      moduleRun: PythonProjectWorkerResponse;
      cwdRelativeFileRun: PythonProjectWorkerResponse;
      workspaceRelativeFileRun: PythonProjectWorkerResponse;
      stdinRun: PythonProjectWorkerResponse;
      argumentRun: PythonProjectWorkerResponse;
      directoryRun: PythonProjectWorkerResponse;
      outsideCwdError: string;
    };

    assertCondition(results.fileRun.exitCode === 0, `Python project file run should succeed: ${results.fileRun.stderr}`);
    assertCondition(
      results.fileRun.stdout === '42\nfrom-stdin\nbrowser-python-project\nalpha,beta\n/workspace\n',
      `Python project file stdout should match workspace semantics: ${JSON.stringify(results.fileRun.stdout)}`
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
    assertCondition(findFile(results.fileRun, 'stale.txt')?.deleted === true, 'Python project file run should report deletions');

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
    assertCondition(results.directoryRun.exitCode === 0, `Python project directory source should succeed: ${results.directoryRun.stderr}`);
    assertCondition(
      results.directoryRun.stdout === 'True\nchild\n',
      `Python project worker should materialize snapshot directories: ${JSON.stringify(results.directoryRun.stdout)}`
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

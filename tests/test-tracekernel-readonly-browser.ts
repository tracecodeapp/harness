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

async function syncAssets(targetDirectory: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      resolve('node_modules/tsx/dist/cli.mjs'),
      resolve('src/cli.ts'),
      'sync-assets',
      targetDirectory,
      '--languages',
      process.env.TRACECODE_READONLY_RUNTIMES ?? 'python,javascript,csharp,cpp,java',
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

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracekernel-readonly-'));
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    await syncAssets(join(tempRoot, 'workers'));
    await build({
      entryPoints: [resolve('packages/runtime-browser/src/project.ts')],
      outfile: join(tempRoot, 'project-harness.mjs'),
      bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], logLevel: 'warning',
      alias: { zlib: resolve('packages/tracekernel/src/zlib-browser-shim.ts'), 'node:zlib': resolve('packages/tracekernel/src/zlib-browser-shim.ts') },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">');
    server = await startStaticServer(tempRoot);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(180_000);
      await page.goto(`${server.origin}/index.html`);
      await page.evaluate('globalThis.__name = (fn) => fn');
      const results = await page.evaluate(async (selected: string[]) => {
        // @ts-expect-error Generated into the browser test server.
        const { createBrowserProjectWorkspace } = await import('/project-harness.mjs');
        const javascript = `
          const fs = require('fs');
          const metadataFd = fs.openSync('locked', 'r');
          const operations = [
            () => fs.writeFileSync('locked', 'late'),
            () => fs.writeFileSync('locked', 'late', { flag: 'a' }),
            () => fs.appendFileSync('locked', 'late'),
            () => fs.cpSync('/tmp/input', 'copied'),
            () => fs.fchmodSync(metadataFd, 0o600),
            () => fs.futimesSync(metadataFd, 1, 1),
            () => fs.renameSync('/tmp/input', 'locked'),
            () => fs.copyFileSync('/tmp/input', 'locked'),
            () => fs.linkSync('/tmp/input', 'hard'),
            () => fs.symlinkSync('/tmp/input', 'soft'),
            () => fs.mkdirSync('new'),
            () => fs.rmdirSync('empty'),
            () => fs.chmodSync('locked', 0o600),
            () => fs.utimesSync('locked', 1, 1),
            () => fs.truncateSync('locked', 0),
            () => fs.unlinkSync('locked'),
          ];
          let denied = 0;
          for (const operation of operations) {
            try { operation(); } catch (error) {
              if (!['EROFS', 'EACCES'].includes(error.code)) throw error;
              denied++;
            }
          }
          fs.closeSync(metadataFd);
          if (denied !== operations.length || fs.readFileSync('locked', 'utf8') !== 'snapshot') throw Error('authority escaped: ' + denied);
          fs.writeFileSync('/tmp/output', 'scratch');
          if (fs.readFileSync('/tmp/output', 'utf8') !== 'scratch') throw Error('scratch blocked');
          console.log('denied:' + denied + ':scratch');
        `;
        const python = [
          'import os, errno, shutil',
          'from pathlib import Path',
          'Path("/tmp/input").write_text("scratch")',
          'operations = [',
          ' lambda: Path("locked").write_text("late"),',
          ' lambda: os.rename("locked", "moved"),',
          ' lambda: shutil.copyfile("/tmp/input", "locked"),',
          ' lambda: os.link("locked", "hard"),',
          ' lambda: os.symlink("locked", "soft"),',
          ' lambda: os.mkdir("new"),',
          ' lambda: os.rmdir("empty"),',
          ' lambda: os.chmod("locked", 0o600),',
          ' lambda: os.utime("locked", (1, 1)),',
          ' lambda: os.truncate("locked", 0),',
          ' lambda: os.unlink("locked"),',
          ']',
          'denied = 0',
          'for operation in operations:',
          ' try:',
          '  operation()',
          ' except OSError as error:',
          '  assert error.errno in (errno.EROFS, errno.EACCES), repr(error)',
          '  denied += 1',
          'assert denied == len(operations), denied',
          'assert Path("locked").read_text() == "snapshot"',
          'Path("/tmp/output").write_text("scratch")',
          'assert Path("/tmp/output").read_text() == "scratch"',
          'print(f"denied:{denied}:scratch")',
        ].join('\n');
        const csharp = 'using System.IO; File.WriteAllText("locked", "late");';
        const cpp = `
          #include <cstdio>
          #include <cerrno>
          #include <sys/stat.h>
          #include <unistd.h>
          int main() {
            int denied = 0;
            FILE* relative = fopen("tmp/seed", "r");
            if (!relative || fgetc(relative) != 'w') return 3;
            fclose(relative);
            FILE* file = fopen("locked", "w");
            if (!file && (errno == EROFS || errno == EACCES)) denied++; else if (file) fclose(file);
            if (rename("/tmp/input", "locked") == -1 && (errno == EROFS || errno == EACCES)) denied++;
            if (unlink("locked") == -1 && (errno == EROFS || errno == EACCES)) denied++;
            if (mkdir("new", 0700) == -1 && (errno == EROFS || errno == EACCES)) denied++;
            if (rmdir("empty") == -1 && (errno == EROFS || errno == EACCES)) denied++;
            if (link("/tmp/input", "hard") == -1 && (errno == EROFS || errno == EACCES)) denied++;
            if (symlink("/tmp/input", "soft") == -1 && (errno == EROFS || errno == EACCES)) denied++;
            file = fopen("/tmp/output", "w");
            if (!file) return 2;
            fputs("scratch", file); fclose(file);
            printf("denied:%d:scratch\\n", denied);
            return denied == 7 ? 0 : 1;
          }
        `;
        const java = `
          import java.nio.file.*;
          import java.io.IOException;
          public class Main {
            interface Operation { void run() throws IOException; }
            public static void main(String[] args) throws Exception {
              Path locked = Path.of("locked");
              Operation[] operations = {
                () -> Files.writeString(locked, "late"),
                () -> Files.move(Path.of("/tmp/input"), locked, StandardCopyOption.REPLACE_EXISTING),
                () -> Files.copy(Path.of("/tmp/input"), locked, StandardCopyOption.REPLACE_EXISTING),
                () -> Files.createDirectory(Path.of("new")),
                () -> Files.delete(locked)
              };
              int denied = 0;
              for (Operation operation : operations) {
                try { operation.run(); } catch (IOException error) {
                  String reason = String.valueOf(error.getMessage()).toLowerCase();
                  if (!reason.contains("read-only") && !reason.contains("permission denied")) throw error;
                  denied++;
                }
              }
              Files.writeString(Path.of("/tmp/output"), "scratch");
              if (!Files.readString(Path.of("/tmp/output")).equals("scratch")) throw new Exception("scratch blocked");
              System.out.println("denied:" + denied + ":scratch");
              if (denied != operations.length) throw new Exception("authority escaped");
            }
          }
        `;
        const cases = [
          { provider: 'javascript', command: 'node check.js', path: 'check.js', contents: javascript, count: 16 },
          { provider: 'python', command: 'python3 check.py', path: 'check.py', contents: python, count: 11 },
          { provider: 'csharp', command: 'dotnet run --project App.csproj', path: 'Program.cs', contents: csharp, count: 0 },
          { provider: 'cpp', prepare: 'clang++ check.cpp -o check', command: './check', path: 'check.cpp', contents: cpp, count: 7 },
          { provider: 'java', prepare: 'javac Main.java', command: 'java Main', path: 'Main.java', contents: java, count: 5 },
        ];
        const results = [];
        for (const { provider, prepare, command, path, contents, count } of cases.filter((c) => selected.includes(c.provider))) {
          const workspace = await createBrowserProjectWorkspace({ assetBaseUrl: '/workers', providers: [provider], files: [{ path: 'locked', contents: 'snapshot' }, { path: 'move', contents: 'snapshot' }, { path: 'delete', contents: 'snapshot' }, { path, contents }, ...(provider === 'csharp' ? [{ path: 'App.csproj', contents: '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>' }] : [])], pythonProjectTimeoutMs: 120_000, csharpProjectTimeoutMs: 180_000 });
          try {
            await workspace.mkdir('empty');
            await workspace.mkdir('tmp');
            await workspace.writeFile('tmp/seed', 'workspace');
            await workspace.runCommand('echo scratch > /tmp/input');
            // Prepare compiled artifacts before establishing the grading snapshot.
            if (prepare) {
              const compiled = await workspace.runCommand(prepare);
              if (compiled.exitCode !== 0) throw new Error(JSON.stringify({ prepare, compiled }));
            }
            const actor = workspace.kernel.createProcess({ name: 'grader', actor: { kind: 'runtime', id: 'grader', capabilities: { execute: true } }, workspaceAccess: 'read-only' });
            const result = await actor.runCommand(command);
            const locked = await workspace.readFile('locked').catch(() => '<missing>');
            await actor.revokeAndDrain();
            results.push({ command, ...result, locked, count });
          } finally { await workspace.destroy(); }
        }
        return results;
      }, (process.env.TRACECODE_READONLY_RUNTIMES ?? 'javascript,python,csharp,cpp,java').split(','));
      console.log(JSON.stringify(results));
      for (const result of results) {
        if (result.count === 0) {
          assertCondition(result.exitCode !== 0 && /[Rr]ead-only file system/.test(result.stderr) && result.locked === 'snapshot', JSON.stringify(result));
          console.log('PASS C# compiler output receives normal read-only filesystem error before learner execution');
          continue;
        }
        assertCondition(result.exitCode === 0 && result.stdout.includes(`denied:${result.count}:scratch`) && result.locked === 'snapshot', JSON.stringify(result));
        console.log(`PASS ${result.command}: ${result.count} native filesystem denials, caught errno, unchanged bytes and writable scratch`);
      }
    } finally { await browser.close(); }
  } finally { await server?.close(); await rm(tempRoot, { recursive: true, force: true }); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });

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

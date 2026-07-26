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
      return 'application/json';
    case '.wasm':
      return 'application/wasm';
    case '.dll':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}

async function syncCSharpAssets(targetDirectory: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      resolve('node_modules/tsx/dist/cli.mjs'),
      resolve('src/cli.ts'),
      'sync-assets',
      targetDirectory,
      '--languages',
      'csharp',
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
    throw new Error('Unable to resolve C# test server address.');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) => error ? rejectPromise(error) : resolvePromise());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }),
  };
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracekernel-013-csharp-'));
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    await syncCSharpAssets(join(tempRoot, 'workers'));
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
      page.setDefaultTimeout(240_000);
      const browserErrors: string[] = [];
      page.on('pageerror', (error) => browserErrors.push(error.message));
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
      await page.evaluate('globalThis.__name = (fn) => fn');
      const result = await page.evaluate(async () => {
        // @ts-expect-error Generated into the browser test server.
        const { createBrowserProjectWorkspace } = await import('/project-harness.mjs');
        const workspace = await createBrowserProjectWorkspace({
          assetBaseUrl: '/workers',
          providers: ['csharp'],
          projectWorkerIsolation: 'per-command',
          csharpProjectTimeoutMs: 180_000,
          files: [
            {
              path: 'App.csproj',
              contents: [
                '<Project Sdk="Microsoft.NET.Sdk">',
                '  <PropertyGroup>',
                '    <OutputType>Exe</OutputType>',
                '    <TargetFramework>net10.0</TargetFramework>',
                '  </PropertyGroup>',
                '</Project>',
                '',
              ].join('\n'),
            },
            {
              path: 'Program.cs',
              contents: [
                'using System;',
                'using System.IO;',
                '',
                'string host = File.ReadAllText("host-shared.txt");',
                'Directory.CreateDirectory("csharp-kernel");',
                'using (var stream = new FileStream(',
                '    "csharp-kernel/value.bin",',
                '    FileMode.CreateNew,',
                '    FileAccess.ReadWrite,',
                '    FileShare.ReadWrite',
                '))',
                '{',
                '    stream.Write(new byte[] { 0, 1, 2, 3, 4, 255 });',
                '    stream.Seek(2, SeekOrigin.Begin);',
                '    stream.WriteByte(9);',
                '    stream.SetLength(5);',
                '}',
                'File.Move("csharp-kernel/value.bin", "csharp-kernel/final.bin");',
                'byte[] value = File.ReadAllBytes("csharp-kernel/final.bin");',
                'bool valid = host == "host-authoritative\\n"',
                '    && value.Length == 5',
                '    && value[0] == 0',
                '    && value[1] == 1',
                '    && value[2] == 9',
                '    && value[3] == 3',
                '    && value[4] == 4;',
                'Console.WriteLine($"tkfs:{valid.ToString().ToLowerInvariant()}");',
                '',
              ].join('\n'),
            },
            {
              path: 'host-shared.txt',
              contents: 'host-authoritative\n',
            },
          ],
        });
        try {
          const command = await workspace.runCommand(
            'dotnet run --project App.csproj'
          );
          return {
            command,
            commandKeys: Object.keys(command ?? {}),
            bytes: command.exitCode === 0
              ? await workspace.readFile('csharp-kernel/final.bin', 'base64')
              : null,
          };
        } finally {
          workspace.dispose();
        }
      });

      assertCondition(
        result.command.exitCode === 0 &&
          result.command.stdout.endsWith('tkfs:true\n') &&
          result.bytes === 'AAEJAwQ=',
        `C# System.IO did not use authoritative TKFS: ${JSON.stringify(result)} browserErrors=${JSON.stringify(browserErrors)}`
      );
      assertCondition(
        browserErrors.length === 0,
        `C# browser conformance emitted unexpected errors: ${JSON.stringify(browserErrors)}`
      );
      console.log(JSON.stringify({
        schema: 'tracekernel-013-csharp-conformance-v1',
        synchronousSyscallTransport: true,
        systemIoTkfsMount: true,
        descriptorIo: true,
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

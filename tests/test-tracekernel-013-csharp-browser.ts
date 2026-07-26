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
      'csharp,javascript',
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
          providers: ['csharp', 'javascript'],
          projectWorkerIsolation: 'per-command',
          csharpProjectTimeoutMs: 180_000,
          symlinks: [
            {
              path: 'seed-link.txt',
              symlink: true,
              target: 'host-shared.txt',
            },
          ],
          files: [
            {
              path: 'App.csproj',
              contents: [
                '<Project Sdk="Microsoft.NET.Sdk">',
                '  <PropertyGroup>',
                '    <OutputType>Exe</OutputType>',
                '    <TargetFramework>net10.0</TargetFramework>',
                '    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>',
                '  </PropertyGroup>',
                '  <ItemGroup>',
                '    <Compile Include="Program.cs" />',
                '  </ItemGroup>',
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
                'var armed = TraceKernel.Watchdog.Arm(',
                '    30000,',
                '    TraceKernel.KernelSignal.Kill',
                ');',
                'var petted = TraceKernel.Watchdog.Pet();',
                'var disarmed = TraceKernel.Watchdog.Disarm();',
                'ParentState.Value = 73;',
                'var nonblockingPipe = TraceKernel.KernelPipe.Create(capacityChunks: 1, nonblocking: true);',
                'bool emptyReadWouldBlock = false;',
                'try',
                '{',
                '    nonblockingPipe.ReadEnd.Read(8);',
                '}',
                'catch (TraceKernel.TraceKernelException error) when (error.Code == "EAGAIN")',
                '{',
                '    emptyReadWouldBlock = true;',
                '}',
                'nonblockingPipe.WriteEnd.WriteText("ready");',
                'bool fullWriteWouldBlock = false;',
                'try',
                '{',
                '    nonblockingPipe.WriteEnd.WriteText("blocked");',
                '}',
                'catch (TraceKernel.TraceKernelException error) when (error.Code == "EAGAIN")',
                '{',
                '    fullWriteWouldBlock = true;',
                '}',
                'string nonblockingValue = System.Text.Encoding.UTF8.GetString(',
                '    nonblockingPipe.ReadEnd.Read(16)',
                ');',
                'bool managedNonblockingPipe = emptyReadWouldBlock && fullWriteWouldBlock',
                '    && nonblockingValue == "ready" && nonblockingPipe.ReadEnd.Nonblocking;',
                'nonblockingPipe.ReadEnd.Dispose();',
                'nonblockingPipe.WriteEnd.Dispose();',
                'var inheritedPipe = TraceKernel.KernelPipe.Create(closeOnExec: true);',
                'var mappedWriteEnd = inheritedPipe.WriteEnd.DuplicateTo(20, closeOnExec: true);',
                'bool descriptorFlags = inheritedPipe.ReadEnd.CloseOnExec &&',
                '    inheritedPipe.WriteEnd.CloseOnExec &&',
                '    mappedWriteEnd.CloseOnExec && !mappedWriteEnd.Inheritable;',
                'var descriptorChild = TraceKernel.KernelProcess.Start(',
                '    "javascript",',
                '    "node",',
                '    new[] { "fd-child.js", "10" },',
                '    new TraceKernel.SpawnOptions',
                '    {',
                '        DescriptorMappings = new[]',
                '        {',
                '            new TraceKernel.DescriptorMapping(mappedWriteEnd.Number, 9),',
                '        },',
                '        DescriptorActions = new TraceKernel.SpawnDescriptorAction[]',
                '        {',
                '            new TraceKernel.SpawnDescriptorAction.Duplicate(9, 10),',
                '            new TraceKernel.SpawnDescriptorAction.Close(9),',
                '        },',
                '        StandardError = TraceKernel.StdioMode.Pipe,',
                '    }',
                ');',
                'inheritedPipe.WriteEnd.Dispose();',
                'mappedWriteEnd.Dispose();',
                'string inheritedDescriptorOutput = inheritedPipe.ReadEnd.ReadToEndText();',
                'string descriptorError = descriptorChild.StandardError!.ReadToEndText();',
                'var descriptorExit = descriptorChild.Wait();',
                'inheritedPipe.ReadEnd.Dispose();',
                'descriptorChild.StandardError.Dispose();',
                'var javascriptChild = TraceKernel.KernelProcess.Start(',
                '    "javascript",',
                '    "node",',
                '    new[] { "child.js" },',
                '    new TraceKernel.SpawnOptions',
                '    {',
                '        StandardOutput = TraceKernel.StdioMode.Pipe,',
                '        StandardError = TraceKernel.StdioMode.Pipe,',
                '    }',
                ');',
                'string javascriptOutput = javascriptChild.StandardOutput!.ReadToEndText();',
                'string javascriptError = javascriptChild.StandardError!.ReadToEndText();',
                'var javascriptExit = javascriptChild.Wait();',
                'javascriptChild.StandardOutput.Dispose();',
                'javascriptChild.StandardError.Dispose();',
                'var csharpChild = TraceKernel.KernelProcess.Start(',
                '    "csharp",',
                '    "dotnet",',
                '    new[] { "run", "--project", "child/Child.csproj" },',
                '    new TraceKernel.SpawnOptions',
                '    {',
                '        StandardOutput = TraceKernel.StdioMode.Pipe,',
                '        StandardError = TraceKernel.StdioMode.Pipe,',
                '    }',
                ');',
                'string csharpOutput = csharpChild.StandardOutput!.ReadToEndText();',
                'string csharpError = csharpChild.StandardError!.ReadToEndText();',
                'var csharpExit = csharpChild.Wait();',
                'csharpChild.StandardOutput.Dispose();',
                'csharpChild.StandardError.Dispose();',
                'var groupLeader = TraceKernel.KernelProcess.Start(',
                '    "javascript",',
                '    "node",',
                '    new[] { "group-leader.js" },',
                '    new TraceKernel.SpawnOptions',
                '    {',
                '        StartNewSession = true,',
                '    }',
                ');',
                'bool nonblockingWait = !groupLeader.TryWait(out _);',
                'var groupDeadline = DateTime.UtcNow.AddSeconds(5);',
                'while (!File.Exists("csharp-group-ready.txt") && DateTime.UtcNow < groupDeadline)',
                '{',
                '    System.Threading.Thread.Sleep(10);',
                '}',
                'if (!File.Exists("csharp-group-ready.txt"))',
                '{',
                '    throw new InvalidOperationException("Managed child process group did not start.");',
                '}',
                'string[] groupPids = File.ReadAllText("csharp-group-ready.txt").Split(":");',
                'bool groupIdentity = int.Parse(groupPids[0]) == groupLeader.Pid',
                '    && int.Parse(groupPids[1]) != groupLeader.Pid;',
                'TraceKernel.KernelProcess.SignalProcessGroup(',
                '    groupLeader.Pid,',
                '    TraceKernel.KernelSignal.Kill',
                ');',
                'var groupExit = groupLeader.Wait();',
                'System.Threading.Thread.Sleep(650);',
                'bool processGroupKilled = nonblockingWait && groupIdentity',
                '    && groupExit.Signal == TraceKernel.KernelSignal.Kill',
                '    && !File.Exists("csharp-group-survived.txt");',
                'using var javascriptListener = TraceKernel.KernelSocket.Create();',
                'var javascriptEndpoint = javascriptListener.Bind("127.0.0.1", 0);',
                'javascriptListener.Listen(backlog: 4, capacityChunks: 2);',
                'var javascriptSocketChild = TraceKernel.KernelProcess.Start(',
                '    "javascript",',
                '    "node",',
                '    new[] { "socket-child.js", javascriptEndpoint.Port.ToString() },',
                '    new TraceKernel.SpawnOptions',
                '    {',
                '        StandardOutput = TraceKernel.StdioMode.Pipe,',
                '        StandardError = TraceKernel.StdioMode.Pipe,',
                '    }',
                ');',
                'using var javascriptConnection = javascriptListener.Accept();',
                'string javascriptSocketRequest = ReadSocketToEnd(javascriptConnection);',
                'javascriptConnection.SendText("ack-js");',
                'javascriptConnection.Shutdown(TraceKernel.SocketShutdown.Write);',
                'string javascriptSocketOutput = javascriptSocketChild.StandardOutput!.ReadToEndText();',
                'string javascriptSocketError = javascriptSocketChild.StandardError!.ReadToEndText();',
                'var javascriptSocketExit = javascriptSocketChild.Wait();',
                'javascriptSocketChild.StandardOutput.Dispose();',
                'javascriptSocketChild.StandardError.Dispose();',
                'using var csharpListener = TraceKernel.KernelSocket.Create();',
                'var csharpEndpoint = csharpListener.Bind("127.0.0.1", 0);',
                'csharpListener.Listen(backlog: 4, capacityChunks: 2);',
                'var csharpSocketChild = TraceKernel.KernelProcess.Start(',
                '    "csharp",',
                '    "dotnet",',
                '    new[]',
                '    {',
                '        "run", "--project", "child/Child.csproj", "--",',
                '        csharpEndpoint.Port.ToString(),',
                '    },',
                '    new TraceKernel.SpawnOptions',
                '    {',
                '        StandardOutput = TraceKernel.StdioMode.Pipe,',
                '        StandardError = TraceKernel.StdioMode.Pipe,',
                '    }',
                ');',
                'using var csharpConnection = csharpListener.Accept();',
                'string csharpSocketRequest = ReadSocketToEnd(csharpConnection);',
                'csharpConnection.SendText("ack-csharp");',
                'csharpConnection.Shutdown(TraceKernel.SocketShutdown.Write);',
                'string csharpSocketOutput = csharpSocketChild.StandardOutput!.ReadToEndText();',
                'string csharpSocketError = csharpSocketChild.StandardError!.ReadToEndText();',
                'var csharpSocketExit = csharpSocketChild.Wait();',
                'csharpSocketChild.StandardOutput.Dispose();',
                'csharpSocketChild.StandardError.Dispose();',
                'using var watcher = TraceKernel.KernelFileWatcher.Create(',
                '    "/workspace",',
                '    recursive: true,',
                '    capacityEvents: 8',
                ');',
                'var watchChild = TraceKernel.KernelProcess.Start(',
                '    "javascript",',
                '    "node",',
                '    new[] { "watch-child.js" }',
                ');',
                'TraceKernel.KernelFileWatchEvent? watchedEvent = null;',
                'for (int index = 0; index < 8; index++)',
                '{',
                '    var candidate = watcher.ReadEvent();',
                '    if (candidate.Path.EndsWith("/watch-from-child.txt"))',
                '    {',
                '        watchedEvent = candidate;',
                '        break;',
                '    }',
                '}',
                'var watchExit = watchChild.Wait();',
                'string host = File.ReadAllText("host-shared.txt");',
                'string seededLink = File.ReadAllText("seed-link.txt");',
                'File.CreateSymbolicLink("created-link.txt", "host-shared.txt");',
                'string? createdLinkTarget = new FileInfo("created-link.txt").LinkTarget;',
                'string createdLinkContents = File.ReadAllText("created-link.txt");',
                'TraceKernel.KernelFileSystem.CreateHardLink(',
                '    "host-shared.txt",',
                '    "hard-shared.txt"',
                ');',
                'File.WriteAllText("hard-shared.txt", "hard-updated");',
                'string hardLinkedOriginal = File.ReadAllText("host-shared.txt");',
                'string rawLinkTarget = TraceKernel.KernelFileSystem.ReadLink("created-link.txt");',
                'string resolvedLink = TraceKernel.KernelFileSystem.RealPath("created-link.txt");',
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
                '    && seededLink == host',
                '    && createdLinkContents == host',
                '    && createdLinkTarget != null',
                '    && createdLinkTarget.EndsWith("/host-shared.txt")',
                '    && rawLinkTarget == "host-shared.txt"',
                '    && resolvedLink.EndsWith("/host-shared.txt")',
                '    && hardLinkedOriginal == "hard-updated"',
                '    && File.ReadAllText("seed-link.txt") == "hard-updated"',
                '    && armed.Armed',
                '    && armed.Signal == TraceKernel.KernelSignal.Kill',
                '    && petted.Armed',
                '    && !disarmed.Armed',
                '    && ParentState.Value == 73',
                '    && descriptorFlags',
                '    && managedNonblockingPipe',
                '    && descriptorExit.ExitCode == 0',
                '    && inheritedDescriptorOutput == "inherited-fd"',
                '    && descriptorError == ""',
                '    && javascriptExit.ExitCode == 0',
                '    && javascriptOutput == "javascript-child\\n"',
                '    && javascriptError == ""',
                '    && File.ReadAllText("javascript-child.txt") == "js-shared"',
                '    && csharpExit.ExitCode == 0',
                '    && csharpOutput == "csharp-child\\n"',
                '    && csharpError == ""',
                '    && File.ReadAllText("csharp-child.txt") == "csharp-shared"',
                '    && processGroupKilled',
                '    && javascriptSocketRequest == "js-socket"',
                '    && javascriptConnection.GetLocalEndpoint() == javascriptEndpoint',
                '    && javascriptConnection.GetRemoteEndpoint().Port > 0',
                '    && javascriptSocketExit.ExitCode == 0',
                '    && javascriptSocketOutput == "socket:ack-js\\n"',
                '    && javascriptSocketError == ""',
                '    && csharpSocketRequest == "csharp-socket"',
                '    && csharpConnection.GetLocalEndpoint() == csharpEndpoint',
                '    && csharpConnection.GetRemoteEndpoint().Port > 0',
                '    && csharpSocketExit.ExitCode == 0',
                '    && csharpSocketOutput == "socket:ack-csharp\\n"',
                '    && csharpSocketError == ""',
                '    && watchExit.ExitCode == 0',
                '    && watchedEvent != null',
                '    && watchedEvent.EventType == "rename"',
                '    && File.ReadAllText("watch-from-child.txt") == "watched"',
                '    && value.Length == 5',
                '    && value[0] == 0',
                '    && value[1] == 1',
                '    && value[2] == 9',
                '    && value[3] == 3',
                '    && value[4] == 4;',
                'Console.WriteLine($"tkfs:{valid.ToString().ToLowerInvariant()}");',
                '',
                'static string ReadSocketToEnd(TraceKernel.KernelSocket socket)',
                '{',
                '    var output = new StringBuilder();',
                '    while (true)',
                '    {',
                '        byte[] bytes = socket.Receive(3);',
                '        if (bytes.Length == 0) return output.ToString();',
                '        output.Append(Encoding.UTF8.GetString(bytes));',
                '    }',
                '}',
                '',
                'static class ParentState',
                '{',
                '    public static int Value;',
                '}',
                '',
              ].join('\n'),
            },
            {
              path: 'host-shared.txt',
              contents: 'host-authoritative\n',
            },
            {
              path: 'child.js',
              contents: [
                'const fs = require("node:fs");',
                'fs.writeFileSync("javascript-child.txt", "js-shared");',
                'console.log("javascript-child");',
                '',
              ].join('\n'),
            },
            {
              path: 'fd-child.js',
              contents: [
                'const fs = require("node:fs");',
                'fs.writeSync(Number(process.argv[2]), Buffer.from("inherited-fd"));',
                '',
              ].join('\n'),
            },
            {
              path: 'group-grandchild.js',
              contents: [
                'setTimeout(() => {',
                '  require("node:fs").writeFileSync("csharp-group-survived.txt", "escaped");',
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
                'fs.writeFileSync("csharp-group-ready.txt", `${process.pid}:${child.pid}`);',
                'setInterval(() => {}, 1000);',
                '',
              ].join('\n'),
            },
            {
              path: 'socket-child.js',
              contents: [
                'const net = require("node:net");',
                'const socket = net.connect({',
                '  host: "127.0.0.1",',
                '  port: Number(process.argv[2]),',
                '});',
                'const chunks = [];',
                'socket.on("connect", () => {',
                '  socket.write(Buffer.from("js-"));',
                '  socket.end(Buffer.from("socket"));',
                '});',
                'socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));',
                'socket.on("end", () => {',
                '  console.log("socket:" + Buffer.concat(chunks).toString("utf8"));',
                '});',
                '',
              ].join('\n'),
            },
            {
              path: 'watch-child.js',
              contents: [
                'require("node:fs").writeFileSync(',
                '  "watch-from-child.txt",',
                '  "watched"',
                ');',
                '',
              ].join('\n'),
            },
            {
              path: 'child/Child.csproj',
              contents: [
                '<Project Sdk="Microsoft.NET.Sdk">',
                '  <PropertyGroup>',
                '    <OutputType>Exe</OutputType>',
                '    <TargetFramework>net10.0</TargetFramework>',
                '    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>',
                '  </PropertyGroup>',
                '  <ItemGroup>',
                '    <Compile Include="Child.cs" />',
                '  </ItemGroup>',
                '</Project>',
                '',
              ].join('\n'),
            },
            {
              path: 'child/Child.cs',
              contents: [
                'using System;',
                'using System.IO;',
                'if (args.Length == 0)',
                '{',
                '    if (TraceKernel.KernelProcess.CreateSession() <= 0)',
                '        throw new InvalidOperationException("setsid failed");',
                '    ParentState.Value = 999;',
                '    File.WriteAllText("csharp-child.txt", "csharp-shared");',
                '    Console.WriteLine("csharp-child");',
                '}',
                'else',
                '{',
                '    using var socket = TraceKernel.KernelSocket.Create();',
                '    socket.Connect("127.0.0.1", int.Parse(args[0]));',
                '    socket.SendText("csharp-socket");',
                '    socket.Shutdown(TraceKernel.SocketShutdown.Write);',
                '    var output = new StringBuilder();',
                '    while (true)',
                '    {',
                '        byte[] bytes = socket.Receive(3);',
                '        if (bytes.Length == 0) break;',
                '        output.Append(Encoding.UTF8.GetString(bytes));',
                '    }',
                '    Console.WriteLine("socket:" + output);',
                '}',
                '',
                'static class ParentState',
                '{',
                '    public static int Value;',
                '}',
                '',
              ].join('\n'),
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
        managedWatchdog: true,
        managedChildProcesses: true,
        managedProcessGroups: true,
        managedTopologyMutation: true,
        managedNonblockingWait: true,
        crossLanguageChildren: true,
        sameLanguageWorkerIsolation: true,
        selectedDescriptorInheritance: true,
        mappedDescriptorInheritance: true,
        orderedDescriptorActions: true,
        managedDescriptorFlags: true,
        managedAtomicDup3AndPipe2: true,
        managedNonblockingPipes: true,
        managedTcpSockets: true,
        socketHalfClose: true,
        symbolicLinks: true,
        hardLinks: true,
        filesystemWatchDescriptors: true,
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

#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { RuntimeWorkspaceStat } from '../packages/harness-core/src/runtime-project';
import { MessageChannel } from 'node:worker_threads';
import {
  type JavaScriptProjectCommandRequest,
  type JavaProjectCommandRequest,
  type CppProjectCommandRequest,
  type CSharpProjectCommandRequest,
  type PythonProjectCommandRequest,
  type RuntimeCommandOptions,
  type RuntimeCommandResult,
  type RuntimeCommandEvent,
  type RuntimeProjectTerminalEvent,
  type RuntimeWorkspace,
  type RuntimeWorkspaceEvent,
  createRuntimeProjectHiddenCommandAccess,
  createRuntimeWorkspace,
  normalizeRuntimeProjectPath,
} from '../packages/harness-project/src/index';
import {
  createRuntimeCommandStdinPipe,
  createRuntimeCommandStdinPipeFromText,
  type RuntimeFile,
  RuntimeProjectEventQueue,
  readRuntimeCommandStdinPipeBytes,
} from '../packages/harness-core/src/runtime-project';
import { getLanguageRuntimeInfo } from '../packages/harness-core/src/runtime-language-info';
import packageJson from '../package.json' with { type: 'json' };
import {
  leadingPersistentCdTarget,
  parseSimpleCommandWords,
  parseTerminalCommandList,
} from '../packages/harness-project/src/arg-parsers';
import { createNativePythonProjectRunner } from '../packages/harness-python/src/project-node';
import {
  createBrowserPythonProjectRunner,
  createPyodidePythonProjectRunner,
} from '../packages/harness-python/src/project-browser';
import {
  type CreateBrowserProjectWorkspaceOptions,
  createBrowserProjectWorkspace,
  createIndexedDbKernelStorage,
} from '../packages/harness-browser/src/project';
import { createNativeJavaScriptProjectRunner, createTypeScriptProjectRunner } from '../packages/harness-javascript/src/project-node';
import { createBrowserJavaScriptProjectRunner } from '../packages/harness-javascript/src/project-browser';
import { createNativeJavaProjectRunner } from '../packages/harness-java/src/project-node';
import { createBrowserJavaProjectRunner } from '../packages/harness-java/src/project-browser';
import { createNativeCppProjectRunner } from '../packages/harness-cpp/src/project-node';
import { createBrowserCppProjectRunner } from '../packages/harness-cpp/src/project-browser';
import { createNativeCSharpProjectRunner } from '../packages/harness-csharp/src/project-node';
import { createBrowserCSharpProjectRunner } from '../packages/harness-csharp/src/project-browser';
import { createNativeProjectWorkspace } from '../src/project-node';

const execFileAsync = promisify(execFile);
const testTextDecoder = new TextDecoder();
const testFilePath = fileURLToPath(import.meta.url);
const testDirectory = dirname(testFilePath);
const expectedTraceKernelVersion = packageJson.version;
type TestRuntimeProjectSnapshot = Awaited<ReturnType<RuntimeWorkspace['snapshot']>>;

// Loose views for asserting on discriminated-union payloads without per-site narrowing.
type LooseFileChange = { path: string; contents?: string; encoding?: 'utf8' | 'base64'; deleted?: true; directory?: true };
const looseChange = (change: unknown): LooseFileChange => change as LooseFileChange;
type OutputEvent = Extract<RuntimeCommandEvent, { type: 'output' }>;
const asJsProjectRequest = (request: Omit<JavaScriptProjectCommandRequest, 'scriptPath'> & { scriptPath?: string }) =>
  request as JavaScriptProjectCommandRequest;

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function cloneProjectSnapshot(snapshot: TestRuntimeProjectSnapshot): TestRuntimeProjectSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as TestRuntimeProjectSnapshot;
}

function throwingBrowserWorkerClients(): Pick<
  CreateBrowserProjectWorkspaceOptions,
  'pythonWorkerClient' | 'javaWorkerClient' | 'csharpWorkerClient' | 'cppWorkerClient'
> {
  return {
    pythonWorkerClient: {
      async executeProjectPython() {
        throw new Error('unexpected Python runner call');
      },
      terminate() {},
    },
    javaWorkerClient: {
      async executeProjectJava() {
        throw new Error('unexpected Java runner call');
      },
      terminate() {},
    },
    csharpWorkerClient: {
      async executeProjectCSharp() {
        throw new Error('unexpected C# runner call');
      },
      terminate() {},
    },
    cppWorkerClient: {
      async executeProjectCpp() {
        throw new Error('unexpected C++ runner call');
      },
      terminate() {},
    },
  };
}

function stdinPipe(text: string) {
  return createRuntimeCommandStdinPipeFromText(text);
}

class FakeModuleWorker {
  private static nextInstanceId = 1;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private workerOnMessage: ((event: MessageEvent) => void) | null = null;
  private readonly queuedMessages: unknown[] = [];
  private terminated = false;
  private readonly instanceId = FakeModuleWorker.nextInstanceId++;

  constructor(private readonly url: string) {
    void this.load();
  }

  postMessage(message: unknown): void {
    if (this.terminated) return;
    // The production worker permanently removes ambient browser authority in
    // its own realm. This fake shares the test process realm, so use the
    // equivalent temporary boundary and restore the host after each command.
    const candidate = message as {
      runnerOptions?: { projectUserAuthorityMode?: 'temporary' | 'permanent' };
    };
    const deliveredMessage = candidate.runnerOptions?.projectUserAuthorityMode === 'permanent'
      ? {
          ...(message as Record<string, unknown>),
          runnerOptions: { ...candidate.runnerOptions, projectUserAuthorityMode: 'temporary' as const },
        }
      : message;
    if (!this.workerOnMessage) {
      this.queuedMessages.push(deliveredMessage);
      return;
    }
    this.workerOnMessage({ data: deliveredMessage } as MessageEvent);
  }

  terminate(): void {
    this.terminated = true;
    this.workerOnMessage = null;
    this.queuedMessages.length = 0;
  }

  private async load(): Promise<void> {
    const previousSelf = (globalThis as typeof globalThis & { self?: unknown }).self;
    const scope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: (message: unknown) => {
        if (this.terminated) return;
        queueMicrotask(() => this.onmessage?.({ data: message } as MessageEvent));
      },
    };
    try {
      (globalThis as typeof globalThis & { self?: unknown }).self = scope as unknown as Window & typeof globalThis;
      const importUrl = new URL(this.url);
      importUrl.searchParams.set('fake-worker-instance', String(this.instanceId));
      await import(importUrl.href);
      this.workerOnMessage = scope.onmessage;
      for (const message of this.queuedMessages.splice(0)) {
        this.workerOnMessage?.({ data: message } as MessageEvent);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onerror?.({ message } as ErrorEvent);
    } finally {
      (globalThis as typeof globalThis & { self?: unknown }).self = previousSelf;
    }
  }
}

const fakeWorkerAuthorityGlobals = [
  'fetch', 'Headers', 'Request', 'Response', 'XMLHttpRequest', 'WebSocket',
  'WebSocketStream', 'WebTransport', 'EventSource', 'indexedDB', 'caches',
  'cookieStore', 'Worker', 'SharedWorker', 'BroadcastChannel', 'importScripts',
] as const;

function snapshotFakeWorkerHostGlobals(): () => void {
  const global = globalThis as typeof globalThis & Record<string, unknown>;
  const descriptors = new Map(
    fakeWorkerAuthorityGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(global, name)] as const)
  );
  return () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(global, name, descriptor);
      else delete global[name];
    }
  };
}

async function runCommandWithLiveInput(
  workspace: RuntimeWorkspace,
  command: string,
  promptText: string,
  inputText: string,
  options: RuntimeCommandOptions = {}
): Promise<RuntimeCommandResult> {
  const stdin = createRuntimeCommandStdinPipe();
  let stdout = '';
  let wrote = false;
  const result = await workspace.runCommand(command, {
    ...options,
    stdinPipe: stdin,
    onEvent: (event) => {
      options.onEvent?.(event);
      if (event.type !== 'output' || event.stream !== 'stdout') return;
      stdout += event.data;
      if (wrote || !stdout.includes(promptText)) return;
      wrote = true;
      stdin.write(inputText);
      stdin.close();
    },
  });
  if (!wrote) {
    stdin.close();
    throw new Error(`Live stdin prompt was not observed for ${command}: ${JSON.stringify({ promptText, result })}`);
  }
  return result;
}

function readTestRequestStdin(request: Pick<PythonProjectCommandRequest, 'stdinPipe'>): string {
  if (!request.stdinPipe) return '';
  let stdin = '';
  while (true) {
    const chunk = readRuntimeCommandStdinPipeBytes(request.stdinPipe);
    if (chunk.byteLength === 0) break;
    stdin += testTextDecoder.decode(chunk, { stream: true });
  }
  stdin += testTextDecoder.decode();
  return stdin;
}

async function createExternalJavaJarBase64(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tracecode-java-jar-fixture-'));
  try {
    const sourcePath = join(root, 'src/lib/External.java');
    const classesPath = join(root, 'classes');
    const jarPath = join(root, 'external.jar');
    await mkdir(dirname(sourcePath), { recursive: true });
    await mkdir(classesPath, { recursive: true });
    await writeFile(
      sourcePath,
      'package lib;\npublic class External { public static int value() { return 42; } }\n',
      'utf8'
    );
    await execFileAsync('javac', ['-d', classesPath, sourcePath]);
    await execFileAsync('jar', ['cf', jarPath, '-C', classesPath, '.']);
    return (await readFile(jarPath)).toString('base64');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createRunnableJavaJarBase64(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tracecode-java-run-jar-fixture-'));
  try {
    const sourcePath = join(root, 'src/app/Main.java');
    const classesPath = join(root, 'classes');
    const manifestPath = join(root, 'MANIFEST.MF');
    const jarPath = join(root, 'app.jar');
    await mkdir(dirname(sourcePath), { recursive: true });
    await mkdir(classesPath, { recursive: true });
    await writeFile(
      sourcePath,
      [
        'package app;',
        'public class Main {',
        '  public static void main(String[] args) {',
        '    System.out.println(System.getProperty("trace.mode", "missing"));',
        '    System.out.println(String.join(",", args));',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );
    await writeFile(manifestPath, 'Manifest-Version: 1.0\nMain-Class: app.Main\n\n', 'utf8');
    await execFileAsync('javac', ['-d', classesPath, sourcePath]);
    await execFileAsync('jar', ['cfm', jarPath, manifestPath, '-C', classesPath, '.']);
    return (await readFile(jarPath)).toString('base64');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createExternalCSharpDllBase64(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tracecode-csharp-ref-fixture-'));
  try {
    const projectPath = join(root, 'ExternalLib.csproj');
    await writeFile(
      projectPath,
      [
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <PropertyGroup>',
        '    <TargetFramework>net10.0</TargetFramework>',
        '    <ImplicitUsings>enable</ImplicitUsings>',
        '    <Nullable>disable</Nullable>',
        '  </PropertyGroup>',
        '</Project>',
        '',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      join(root, 'Helper.cs'),
      'namespace ExternalLib; public static class Helper { public static int Value() => 314; }\n',
      'utf8'
    );
    await execFileAsync('dotnet', ['build', projectPath, '-c', 'Release', '-v', 'quiet', '--nologo']);
    return (await readFile(join(root, 'bin', 'Release', 'net10.0', 'ExternalLib.dll'))).toString('base64');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createIndexedArArchiveBase64(memberName: string, memberBase64: string): Promise<string> {
  assertCondition(!memberName.includes('/'), `ar fixture member name must be local: ${memberName}`);
  const root = await mkdtemp(join(tmpdir(), 'tracecode-cpp-ar-fixture-'));
  try {
    const memberPath = join(root, memberName);
    const archivePath = join(root, 'libfixture.a');
    await writeFile(memberPath, Buffer.from(memberBase64, 'base64'));
    await execFileAsync('ar', ['rcs', archivePath, memberPath]);
    await execFileAsync('ranlib', [archivePath]);
    return (await readFile(archivePath)).toString('base64');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUInt16LE(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function writeUInt32LE(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function createStoredJarBase64(files: Array<{ path: string; contents: string | Buffer }>): string {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const contents = Buffer.isBuffer(file.contents) ? file.contents : Buffer.from(file.contents, 'utf8');
    const crc = crc32(contents);
    const localHeader = Buffer.concat([
      writeUInt32LE(0x04034b50),
      writeUInt16LE(10),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt32LE(crc),
      writeUInt32LE(contents.length),
      writeUInt32LE(contents.length),
      writeUInt16LE(name.length),
      writeUInt16LE(0),
      name,
    ]);
    localParts.push(localHeader, contents);
    centralParts.push(Buffer.concat([
      writeUInt32LE(0x02014b50),
      writeUInt16LE(0x031e),
      writeUInt16LE(10),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt32LE(crc),
      writeUInt32LE(contents.length),
      writeUInt32LE(contents.length),
      writeUInt16LE(name.length),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt16LE(0),
      writeUInt32LE(0),
      writeUInt32LE(offset),
      name,
    ]));
    offset += localHeader.length + contents.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.concat([
    writeUInt32LE(0x06054b50),
    writeUInt16LE(0),
    writeUInt16LE(0),
    writeUInt16LE(files.length),
    writeUInt16LE(files.length),
    writeUInt32LE(centralDirectory.length),
    writeUInt32LE(offset),
    writeUInt16LE(0),
  ]);
  return Buffer.concat([...localParts, centralDirectory, end]).toString('base64');
}

function assertRejects(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message);
}

async function assertRejectsAsync(fn: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(message);
}

async function waitForMacrotasks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function processPidForCommand(workspace: RuntimeWorkspace, command: string): Promise<string> {
  const processes = await workspace.readFile('/proc/tracekernel/processes');
  const processLine = processes.split('\n').find((line) => line.endsWith(`\t${command}`));
  const pid = processLine?.split('\t')[0] ?? '';
  assertCondition(/^[0-9]+$/.test(pid), `expected active pid for ${command}: ${JSON.stringify(processes)}`);
  return pid;
}

async function testWorkspaceFilesAndCommands(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'src/hello.txt', contents: 'hello\n' },
      { path: './src/nested/value.txt', contents: '42\n' },
    ],
    directories: ['src/initial-empty/deep'],
    entrypoint: '/workspace/src/hello.txt',
  });

  await workspace.writeFile('src/generated.txt', 'generated\n');
  await workspace.writeFile('/workspace/src/absolute-write.txt', 'absolute\n');
  await workspace.writeFile('src/binary.bin', Buffer.from([0, 1, 2, 255]).toString('base64'), 'base64');
  await workspace.appendFile('src/generated.txt', 'appended\n');
  await workspace.appendFile('/workspace/src/absolute-write.txt', 'appended-absolute\n');
  await workspace.appendFile('src/binary.bin', Buffer.from([3, 4]).toString('base64'), 'base64');
  await workspace.appendFile('src/new-appended.txt', 'new\n');
  await workspace.appendFile('src/nested-appended/value.txt', 'nested\n');

  const cat = await workspace.runCommand('cat src/hello.txt src/generated.txt src/absolute-write.txt');
  assertCondition(cat.exitCode === 0, 'cat should succeed');
  assertCondition(cat.stdout === 'hello\ngenerated\nappended\nabsolute\nappended-absolute\n', 'cat should read workspace files');

  const list = await workspace.runCommand('find src -type f | sort');
  assertCondition(
    list.stdout === 'src/absolute-write.txt\nsrc/binary.bin\nsrc/generated.txt\nsrc/hello.txt\nsrc/nested-appended/value.txt\nsrc/nested/value.txt\nsrc/new-appended.txt\n',
    `find should see project files, received ${JSON.stringify(list.stdout)}`
  );
  assertCondition(
    await workspace.readFile('/workspace/src/absolute-write.txt') === 'absolute\nappended-absolute\n',
    'absolute virtual file IO should read workspace files'
  );
  assertCondition(
    (await workspace.readFile('src/binary.bin', 'base64')) === Buffer.from([0, 1, 2, 255, 3, 4]).toString('base64'),
    'base64 file IO should round-trip and append binary contents'
  );
  assertCondition(await workspace.readFile('src/new-appended.txt') === 'new\n', 'appendFile should create missing files');
  assertCondition(await workspace.readFile('src/nested-appended/value.txt') === 'nested\n', 'appendFile should create parent directories');
  assertCondition(await workspace.exists('src/hello.txt'), 'exists should detect relative workspace files');
  assertCondition(await workspace.exists('/workspace/src/hello.txt'), 'exists should detect absolute virtual workspace files');
  assertCondition(await workspace.exists('src/nested'), 'exists should detect workspace directories');
  assertCondition(!(await workspace.exists('src/missing.txt')), 'exists should return false for missing workspace paths');
  const fileStat = await workspace.stat('src/hello.txt');
  assertCondition(fileStat.isFile && !fileStat.isDirectory && typeof fileStat.ino === 'number' && fileStat.ino > 0, 'stat should identify relative workspace files and expose an inode');
  const absoluteFileStat = await workspace.stat('/workspace/src/hello.txt');
  assertCondition(absoluteFileStat.isFile && !absoluteFileStat.isDirectory, 'stat should identify absolute virtual workspace files');
  const directoryStat = await workspace.stat('src/nested');
  assertCondition(!directoryStat.isFile && directoryStat.isDirectory, 'stat should identify workspace directories');
  assertCondition(
    (await workspace.readDir()).join(',') === 'src',
    'readDir should list sorted workspace root entries'
  );
  assertCondition(
    (await workspace.readDir('src')).join(',') === 'absolute-write.txt,binary.bin,generated.txt,hello.txt,initial-empty,nested,nested-appended,new-appended.txt',
    'readDir should list sorted relative directory entries'
  );
  assertCondition(
    (await workspace.readDir('src/initial-empty')).join(',') === 'deep',
    'constructor directories should create recursive empty directories'
  );
  assertCondition(
    (await workspace.readDir('/workspace/src/nested')).join(',') === 'value.txt',
    'readDir should list absolute virtual directory entries'
  );
  const directoryEvents: RuntimeWorkspaceEvent[] = [];
  const unsubscribeDirectoryEvents = workspace.watch((event) => directoryEvents.push(event));
  await workspace.mkdir('src/created/deep');
  await workspace.mkdir('/workspace/src/absolute-created');
  await workspace.mkdir('src/persist-empty/deep');
  await workspace.mkdir('.');
  unsubscribeDirectoryEvents();
  const createdStat = await workspace.stat('src/created/deep');
  assertCondition(!createdStat.isFile && createdStat.isDirectory, 'mkdir should create recursive relative directories');
  const absoluteCreatedStat = await workspace.stat('/workspace/src/absolute-created');
  assertCondition(!absoluteCreatedStat.isFile && absoluteCreatedStat.isDirectory, 'mkdir should create absolute virtual directories');
  assertCondition(
    (await workspace.readDir('src/created')).join(',') === 'deep',
    'mkdir should make created directories visible to readDir'
  );
  assertCondition(
    directoryEvents.some((event) =>
      event.type === 'file-change' &&
        event.change.path === 'src/created' &&
        'directory' in event.change &&
        event.change.directory === true
    ) &&
      directoryEvents.some((event) =>
        event.type === 'file-change' &&
          event.change.path === 'src/created/deep' &&
          'directory' in event.change &&
          event.change.directory === true
      ),
    `workspace mkdir should stream live directory mutations: ${JSON.stringify(directoryEvents)}`
  );
  await workspace.copyFile('src/hello.txt', 'src/copied/hello-copy.txt');
  assertCondition(await workspace.readFile('src/copied/hello-copy.txt') === 'hello\n', 'copyFile should copy text files');
  const copiedStat = await workspace.stat('src/copied/hello-copy.txt');
  await workspace.copyFile('/workspace/src/binary.bin', '/workspace/src/copied/binary-copy.bin');
  assertCondition(
    (await workspace.readFile('src/copied/binary-copy.bin', 'base64')) === Buffer.from([0, 1, 2, 255, 3, 4]).toString('base64'),
    'copyFile should preserve binary files'
  );
  await workspace.moveFile('src/copied/hello-copy.txt', 'src/moved/hello-moved.txt');
  assertCondition(await workspace.readFile('src/moved/hello-moved.txt') === 'hello\n', 'moveFile should move text files');
  const movedStat = await workspace.stat('src/moved/hello-moved.txt');
  assertCondition(
    copiedStat.ino === movedStat.ino,
    `moveFile should preserve kernel inode identity across rename: ${JSON.stringify({ copiedStat, movedStat })}`
  );
  const inodeTable = await workspace.readFile('/proc/tracekernel/inodes');
  assertCondition(
    inodeTable.includes(`${movedStat.ino}\tsrc/moved/hello-moved.txt`) &&
      !inodeTable.includes(`${copiedStat.ino}\tsrc/copied/hello-copy.txt`),
    `kernel inode proc table should reflect renamed paths: ${JSON.stringify(inodeTable)}`
  );
  assertCondition(!(await workspace.exists('src/copied/hello-copy.txt')), 'moveFile should remove the source file');
  await workspace.moveFile('/workspace/src/copied/binary-copy.bin', '/workspace/src/moved/binary-moved.bin');
  assertCondition(
    (await workspace.readFile('src/moved/binary-moved.bin', 'base64')) === Buffer.from([0, 1, 2, 255, 3, 4]).toString('base64'),
    'moveFile should preserve binary files'
  );
  await workspace.remove('src/copied', { recursive: true });
  await workspace.remove('src/moved', { recursive: true });
  await assertRejectsAsync(
    () => workspace.copyFile('src/missing-copy.txt', 'src/copied/missing.txt'),
    'copyFile should reject missing sources'
  );
  await assertRejectsAsync(
    () => workspace.copyFile('/outside/source.txt', 'src/copied/outside.txt'),
    'copyFile should reject source paths outside the workspace'
  );
  await assertRejectsAsync(
    () => workspace.moveFile('src/hello.txt', '/outside/destination.txt'),
    'moveFile should reject destination paths outside the workspace'
  );
  await workspace.writeFile('src/remove-file.txt', 'remove me\n');
  await workspace.remove('src/remove-file.txt');
  assertCondition(!(await workspace.exists('src/remove-file.txt')), 'remove should delete files');
  await assertRejectsAsync(
    () => workspace.remove('src/created'),
    'remove should reject non-empty directories without recursive mode'
  );
  const directoryDeleteEvents: RuntimeWorkspaceEvent[] = [];
  const unsubscribeDirectoryDeleteEvents = workspace.watch((event) => directoryDeleteEvents.push(event));
  await workspace.remove('src/created', { recursive: true });
  unsubscribeDirectoryDeleteEvents();
  assertCondition(!(await workspace.exists('src/created/deep')), 'remove should recursively delete relative directories');
  assertCondition(
    directoryDeleteEvents.some((event) =>
      event.type === 'file-change' &&
        event.change.path === 'src/created/deep' &&
        'directory' in event.change &&
        event.change.directory === true &&
        event.change.deleted === true
    ) &&
      directoryDeleteEvents.some((event) =>
        event.type === 'file-change' &&
          event.change.path === 'src/created' &&
          'directory' in event.change &&
          event.change.directory === true &&
          event.change.deleted === true
      ),
    `workspace remove should stream live directory deletions: ${JSON.stringify(directoryDeleteEvents)}`
  );
  await workspace.remove('/workspace/src/absolute-created', { recursive: true });
  assertCondition(!(await workspace.exists('/workspace/src/absolute-created')), 'remove should recursively delete absolute virtual directories');
  await workspace.remove('src/missing-remove');
  await assertRejectsAsync(
    () => workspace.remove('/outside/remove', { recursive: true }),
    'remove should reject absolute paths outside the workspace'
  );
  await assertRejectsAsync(
    () => workspace.mkdir('/outside/created'),
    'mkdir should reject absolute paths outside the workspace'
  );
  await assertRejectsAsync(
    () => workspace.readDir('src/hello.txt'),
    'readDir should reject file paths'
  );
  await assertRejectsAsync(
    () => workspace.readDir('src/missing'),
    'readDir should reject missing directories'
  );
  await assertRejectsAsync(
    () => workspace.readDir('/outside'),
    'readDir should reject absolute paths outside the workspace'
  );
  await assertRejectsAsync(
    () => workspace.stat('src/missing.txt'),
    'stat should reject missing workspace paths'
  );
  await assertRejectsAsync(
    () => workspace.stat('/outside/escape.txt'),
    'stat should reject absolute paths outside the workspace'
  );
  await assertRejectsAsync(
    () => workspace.exists('/outside/escape.txt'),
    'exists should reject absolute paths outside the workspace'
  );
  await workspace.deleteFile('src/generated.txt');
  await workspace.deleteFile('/workspace/src/absolute-write.txt');
  await workspace.deleteFile('src/new-appended.txt');
  await workspace.remove('src/nested-appended', { recursive: true });
  assertCondition(!(await workspace.exists('src/generated.txt')), 'exists should reflect deleted relative files');
  assertCondition(!(await workspace.exists('/workspace/src/absolute-write.txt')), 'exists should reflect deleted absolute virtual files');
  await assertRejectsAsync(
    () => workspace.readFile('src/generated.txt'),
    'deleteFile should remove relative workspace files'
  );
  await assertRejectsAsync(
    () => workspace.readFile('/workspace/src/absolute-write.txt'),
    'deleteFile should remove absolute virtual workspace files'
  );
  await assertRejectsAsync(
    () => workspace.deleteFile('/outside/escape.txt'),
    'deleteFile should reject absolute paths outside the workspace'
  );
  await workspace.deleteFile('src/missing.txt');

  const defaultSnapshot = await workspace.snapshot();
  assertCondition(defaultSnapshot.entrypoint === 'src/hello.txt', 'snapshot should use the workspace default entrypoint');

  const snapshot = await workspace.snapshot({ entrypoint: 'src/nested/value.txt' });
  assertCondition(snapshot.cwd === '/workspace', 'snapshot should include workspace cwd');
  assertCondition(snapshot.entrypoint === 'src/nested/value.txt', 'snapshot should let explicit entrypoints override the default');
  assertCondition(
    snapshot.files.map((file) => file.path).join(',') === 'src/binary.bin,src/hello.txt,src/nested/value.txt',
    'snapshot should return sorted project-relative files'
  );
  assertCondition(
    snapshot.directories?.join(',') === 'src,src/initial-empty,src/initial-empty/deep,src/nested,src/persist-empty,src/persist-empty/deep',
    `snapshot should preserve sorted project-relative directories, received ${snapshot.directories?.join(',')}`
  );

  const absoluteEntrypointSnapshot = await workspace.snapshot({ entrypoint: '/workspace/src/hello.txt' });
  assertCondition(
    absoluteEntrypointSnapshot.entrypoint === 'src/hello.txt',
    'snapshot should normalize absolute virtual entrypoint'
  );
  await assertRejectsAsync(
    () => workspace.snapshot({ entrypoint: '/outside/hello.txt' }),
    'snapshot should reject absolute entrypoints outside the workspace'
  );
  workspace.dispose();
  const afterDispose = await workspace.runCommand('cat src/hello.txt');
  assertCondition(afterDispose.exitCode === 0, 'native just-bash workspace dispose should be a safe no-op');
}

async function testWorkspaceConcurrentAppendFile(): Promise<void> {
  const workspace = await createRuntimeWorkspace();
  const writes = Array.from({ length: 50 }, (_, index) => `line-${index}\n`);
  await Promise.all(writes.map((line) => workspace.appendFile('logs/output.txt', line)));

  const content = await workspace.readFile('logs/output.txt');
  const lines = content.trim().split('\n').sort((left, right) => left.localeCompare(right));
  assertCondition(
    lines.length === writes.length &&
      lines.join(',') === writes.map((line) => line.trim()).sort((left, right) => left.localeCompare(right)).join(','),
    `concurrent appendFile calls should preserve every write: ${JSON.stringify(content)}`
  );
}

function comparableProjectSnapshot(snapshot: Awaited<ReturnType<RuntimeWorkspace['snapshot']>>) {
  return {
    entrypoint: snapshot.entrypoint,
    files: snapshot.files.map((file) => ({
      path: file.path,
      contents: file.contents,
      ...(file.encoding ? { encoding: file.encoding } : {}),
    })),
    symlinks: snapshot.symlinks ?? [],
    directories: snapshot.directories ?? [],
    directoryMetadata: snapshot.directoryMetadata ?? [],
  };
}

async function testSnapshotCacheReusesUnchangedWorkspace(): Promise<void> {
  const requests: JavaScriptProjectCommandRequest[] = [];
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'main.js', contents: 'console.log("main")\n' },
      { path: 'src/value.txt', contents: 'one\n' },
    ],
    nodeRunner: async (request) => {
      requests.push(request);
      return { stdout: 'ok\n', stderr: '', exitCode: 0 };
    },
  });

  await workspace.runCommand('node main.js');
  await workspace.runCommand('node main.js');
  const firstValue = requests[0]?.project.files.find((file) => file.path === 'src/value.txt');
  const secondValue = requests[1]?.project.files.find((file) => file.path === 'src/value.txt');
  assertCondition(firstValue !== undefined && secondValue !== undefined, 'snapshot cache test should capture the sampled file');
  assertCondition(firstValue === secondValue, 'unchanged language command snapshots should reuse cached RuntimeFile objects');
  assertCondition(requests[0]?.project.files !== requests[1]?.project.files, 'language command snapshots should still receive shallow-copied file arrays');

  await workspace.writeFile('src/value.txt', 'two\n');
  await workspace.runCommand('node main.js');
  const thirdValue = requests[2]?.project.files.find((file) => file.path === 'src/value.txt');
  assertCondition(thirdValue?.contents === 'two\n', `snapshot cache should invalidate after writeFile: ${JSON.stringify(thirdValue)}`);
}

async function testSnapshotCacheInvalidatesOnFinalDiff(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'main.js', contents: 'console.log("main")\n' },
      { path: 'src/value.txt', contents: 'base\n' },
    ],
    nodeRunner: async (): Promise<RuntimeCommandResult> => ({
      stdout: 'changed\n',
      stderr: '',
      exitCode: 0,
      files: [{ path: 'src/value.txt', contents: 'from-final-diff\n' }],
    }),
  });

  const primed = await workspace.snapshot();
  assertCondition(
    primed.files.find((file) => file.path === 'src/value.txt')?.contents === 'base\n',
    'snapshot cache final-diff test should prime the original content'
  );
  const result = await workspace.runCommand('node main.js');
  assertCondition(result.exitCode === 0, `final-diff command should succeed: ${JSON.stringify(result)}`);
  const snapshot = await workspace.snapshot();
  assertCondition(
    snapshot.files.find((file) => file.path === 'src/value.txt')?.contents === 'from-final-diff\n',
    `snapshot cache should invalidate for suspended final-diff writes: ${JSON.stringify(snapshot.files)}`
  );
}

async function testSnapshotCacheRespectsHiddenFiltering(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    projectSession: {
      id: 'hidden-cache-test',
      projectId: 'hidden-cache-project',
      projectSlug: 'hidden-cache',
      files: [
        { path: 'src/main.js', contents: 'console.log("visible")\n' },
        { path: '.trace/fixtures/input.txt', contents: 'hidden\n', hidden: true },
      ],
    },
  });

  const visible = await workspace.snapshot();
  const hidden = await workspace.snapshot({ includeHidden: true });
  assertCondition(!visible.files.some((file) => file.path === '.trace/fixtures/input.txt'), 'snapshot() should omit hidden files');
  assertCondition(hidden.files.some((file) => file.path === '.trace/fixtures/input.txt'), 'snapshot({ includeHidden: true }) should include hidden files');
  const visibleFile = visible.files.find((file) => file.path === 'src/main.js');
  const hiddenVisibleFile = hidden.files.find((file) => file.path === 'src/main.js');
  assertCondition(
    visibleFile !== undefined && visibleFile === hiddenVisibleFile,
    'visible and hidden-filtered snapshots should share cached RuntimeFile objects for the same generation'
  );
}

async function testWorkspaceProjectPatchExportImport(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    entrypoint: 'src/main.txt',
    files: [
      { path: 'src/main.txt', contents: 'base\n' },
      { path: 'docs/old.txt', contents: 'old\n' },
    ],
    directories: ['empty', 'removed-empty'],
    symlinks: [{ path: 'current-link', symlink: true, target: 'src/main.txt' }],
  });
  const base = await workspace.snapshot();
  await workspace.writeFile('src/main.txt', 'changed\n');
  await workspace.writeFile('src/new.txt', 'new\n');
  await workspace.writeFile('assets/bin.dat', Buffer.from([0, 1, 2, 255]).toString('base64'), 'base64');
  await workspace.deleteFile('docs/old.txt');
  await workspace.remove('removed-empty', { recursive: true });
  await workspace.mkdir('new-empty/deep');
  await workspace.runCommand('chmod 700 empty');
  await workspace.runCommand('rm current-link; ln -s src/new.txt current-link; ln -s src/main.txt added-link');

  const patchIdentity = {
    base: {
      id: 'two-sum-project',
      version: '2026-06-07',
    },
  };
  const patch = await workspace.exportPatch(base, patchIdentity);
  assertCondition(patch.version === 1, 'exportPatch should use the v1 patch format');
  assertCondition(patch.base.id === 'two-sum-project', 'exportPatch should preserve caller-provided base id');
  assertCondition(patch.base.version === '2026-06-07', 'exportPatch should preserve caller-provided base version');
  assertCondition(/^[0-9a-f]{64}$/.test(patch.base.manifestHash), `exportPatch should include a manifest hash: ${patch.base.manifestHash}`);
  assertCondition(
    patch.changes.some((change) => change.kind === 'write' && change.path === 'src/main.txt') &&
      patch.changes.some((change) => change.kind === 'write' && change.path === 'src/new.txt' && change.baseHash === null) &&
      patch.changes.some((change) => change.kind === 'write' && change.path === 'assets/bin.dat' && change.encoding === 'base64') &&
      patch.changes.some((change) => change.kind === 'delete' && change.path === 'docs/old.txt') &&
      patch.changes.some((change) => change.kind === 'rmdir' && change.path === 'removed-empty') &&
      patch.changes.some((change) => change.kind === 'mkdir' && change.path === 'new-empty/deep') &&
      patch.changes.some((change) => change.kind === 'directory' && change.path === 'empty' && change.mode === 0o700) &&
      patch.changes.some((change) => change.kind === 'symlink' && change.path === 'current-link' && change.target === 'src/new.txt') &&
      patch.changes.some((change) => change.kind === 'symlink' && change.path === 'added-link' && change.target === 'src/main.txt' && change.baseHash === null),
    `exportPatch should describe writes, deletes, binary files, symlinks, and empty directory changes: ${JSON.stringify(patch)}`
  );

  const restoredEvents: RuntimeWorkspaceEvent[] = [];
  const restored = await createRuntimeWorkspace({
    entrypoint: base.entrypoint,
    files: base.files,
    symlinks: base.symlinks,
    directories: base.directories,
    directoryMetadata: base.directoryMetadata,
  });
  restored.watch((event) => {
    if (event.type === 'file-change') restoredEvents.push(event);
  });
  await assertRejectsAsync(
    () => restored.importPatch(base, patch),
    'importPatch should reject identity-bearing patches when the importer cannot verify their project identity'
  );
  await assertRejectsAsync(
    () => restored.importPatch(base, patch, { base: { id: 'different-project', version: '2026-06-07' } }),
    'importPatch should reject mismatched project identity before mutating'
  );
  await restored.importPatch(base, patch, patchIdentity);
  assertCondition(
    JSON.stringify(comparableProjectSnapshot(await restored.snapshot())) ===
      JSON.stringify(comparableProjectSnapshot(await workspace.snapshot())),
    'importPatch should recreate the exported workspace state from the base snapshot'
  );
  assertCondition(
    restoredEvents.length === patch.changes.length,
    `importPatch should emit one file-change event per committed patch change: ${restoredEvents.length} vs ${patch.changes.length}`
  );

  const changedBase = {
    ...base,
    files: base.files.map((file) => file.path === 'src/main.txt' ? { ...file, contents: 'released-edit\n' } : file),
  };
  const staleBaseWorkspace = await createRuntimeWorkspace({
    entrypoint: changedBase.entrypoint,
    files: changedBase.files,
    symlinks: changedBase.symlinks,
    directories: changedBase.directories,
    directoryMetadata: changedBase.directoryMetadata,
  });
  await assertRejectsAsync(
    () => staleBaseWorkspace.importPatch(changedBase, patch, patchIdentity),
    'importPatch should reject a patch whose base manifest does not match the provided base'
  );
  assertCondition(await staleBaseWorkspace.readFile('src/main.txt') === 'released-edit\n', 'stale import should not mutate the workspace');

  const dirtyWorkspace = await createRuntimeWorkspace({
    entrypoint: base.entrypoint,
    files: base.files,
    symlinks: base.symlinks,
    directories: base.directories,
    directoryMetadata: base.directoryMetadata,
  });
  await dirtyWorkspace.writeFile('local-only.txt', 'dirty\n');
  await assertRejectsAsync(
    () => dirtyWorkspace.importPatch(base, patch, patchIdentity),
    'importPatch should reject when the current workspace is not the patch base'
  );
  assertCondition(await dirtyWorkspace.readFile('local-only.txt') === 'dirty\n', 'current-workspace rejection should preserve existing files');
  assertCondition(await dirtyWorkspace.readFile('src/main.txt') === 'base\n', 'current-workspace rejection should not apply patch writes');

  const invalidPatch = {
    ...patch,
    changes: [
      patch.changes.find((change) => change.kind === 'write' && change.path === 'src/main.txt')!,
      {
        kind: 'write' as const,
        path: 'invalid.txt',
        contents: 'invalid\n',
        baseHash: '0'.repeat(64),
      },
    ],
  };
  const invalidWorkspace = await createRuntimeWorkspace({
    entrypoint: base.entrypoint,
    files: base.files,
    symlinks: base.symlinks,
    directories: base.directories,
    directoryMetadata: base.directoryMetadata,
  });
  await assertRejectsAsync(
    () => invalidWorkspace.importPatch(base, invalidPatch, patchIdentity),
    'importPatch should reject invalid path preconditions before mutating'
  );
  assertCondition(await invalidWorkspace.readFile('src/main.txt') === 'base\n', 'invalid patch rejection should not apply earlier writes');
  assertCondition(!(await invalidWorkspace.exists('invalid.txt')), 'invalid patch rejection should not create later files');

  const hiddenWorkspace = await createRuntimeWorkspace({
    projectSession: {
      id: 'hidden-patch-test',
      projectId: 'hidden-patch-project',
      projectSlug: 'hidden-patch',
      language: 'python',
      files: [
        { path: 'src/main.py', contents: 'print("visible")\n' },
        { path: '.trace/fixtures/input.txt', contents: 'secret\n', hidden: true },
      ],
    },
  });
  const hiddenBase = await hiddenWorkspace.snapshot();
  const hiddenBasePatch = await hiddenWorkspace.exportPatch(hiddenBase);
  await assertRejectsAsync(
    () =>
      hiddenWorkspace.importPatch(hiddenBase, {
        ...hiddenBasePatch,
        changes: [
          {
            kind: 'write',
            path: '.trace/fixtures/conftest.py',
            contents: 'poison\n',
            baseHash: null,
          },
        ],
      }),
    'importPatch should reject hidden fixture directory descendant writes'
  );
  const hiddenSnapshot = await hiddenWorkspace.snapshot({ includeHidden: true });
  assertCondition(
    !hiddenSnapshot.files.some((file) => file.path === '.trace/fixtures/conftest.py'),
    'hidden fixture directory patch rejection should not create hidden descendant files'
  );
}

async function testWorkspaceConcurrentFilesystemMutations(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'source.txt', contents: 'copy-source\n' },
      { path: 'moves/source-a.txt', contents: 'move-a\n' },
      { path: 'moves/source-b.txt', contents: 'move-b\n' },
    ],
  });

  await Promise.all(Array.from({ length: 25 }, () => workspace.mkdir('same/deep/path')));
  assertCondition(await workspace.exists('same/deep/path'), 'concurrent mkdir calls should leave the directory present');

  const writeCandidates = Array.from({ length: 30 }, (_, index) => `write-${index}\n`);
  await Promise.all(writeCandidates.map((contents) => workspace.writeFile('same/file.txt', contents)));
  const finalWrite = await workspace.readFile('same/file.txt');
  assertCondition(writeCandidates.includes(finalWrite), `concurrent writeFile should leave one complete write: ${JSON.stringify(finalWrite)}`);

  await Promise.all(Array.from({ length: 10 }, () => workspace.copyFile('source.txt', 'copies/source-copy.txt')));
  assertCondition(
    await workspace.readFile('copies/source-copy.txt') === 'copy-source\n',
    'concurrent copyFile calls to the same destination should preserve complete copied contents'
  );

  await Promise.all([
    workspace.moveFile('moves/source-a.txt', 'moves/dest-a.txt'),
    workspace.moveFile('moves/source-b.txt', 'moves/dest-b.txt'),
  ]);
  assertCondition(
    await workspace.readFile('moves/dest-a.txt') === 'move-a\n' &&
      await workspace.readFile('moves/dest-b.txt') === 'move-b\n' &&
      !(await workspace.exists('moves/source-a.txt')) &&
      !(await workspace.exists('moves/source-b.txt')),
    'concurrent moveFile calls for distinct files should preserve moved contents'
  );

  for (let index = 0; index < 20; index += 1) {
    await Promise.all([
      workspace.writeFile('volatile/child.txt', `child-${index}\n`),
      workspace.remove('volatile', { recursive: true }),
    ]);
    if (await workspace.exists('volatile/child.txt')) {
      assertCondition(
        await workspace.readFile('volatile/child.txt') === `child-${index}\n`,
        'concurrent write/remove should leave either no file or the complete written file'
      );
    }
  }

  const kernelCandidates = Array.from({ length: 20 }, (_, index) => `kernel-${index}\n`);
  await Promise.all(kernelCandidates.map((contents) =>
    workspace.kernel.applyFileChange({ path: 'kernel/generated.txt', contents })
  ));
  const finalKernelWrite = await workspace.readFile('kernel/generated.txt');
  assertCondition(
    kernelCandidates.includes(finalKernelWrite),
    `concurrent kernel file changes should leave one complete write: ${JSON.stringify(finalKernelWrite)}`
  );
}

async function testWorkspaceConcurrentRunCommandSerialization(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'a.js', contents: 'console.log("a")\n' },
      { path: 'b.js', contents: 'console.log("b")\n' },
    ],
    nodeRunner: async (request) => {
      const label = request.scriptPath.endsWith('a.js') ? 'a' : 'b';
      request.onEvent?.({ type: 'output', stream: 'stdout', data: `${label}:start\n` });
      await new Promise((resolve) => setTimeout(resolve, 10));
      request.onEvent?.({ type: 'output', stream: 'stdout', data: `${label}:end\n` });
      return { stdout: `${label}:start\n${label}:end\n`, stderr: '', exitCode: 0 };
    },
  });

  const commandEvents: Record<string, string[]> = { a: [], b: [] };
  const [a, b] = await Promise.all([
    workspace.runCommand('node a.js', {
      onEvent: (event) => {
        if (event.type === 'output') commandEvents.a.push(event.data);
      },
    }),
    workspace.runCommand('node b.js', {
      onEvent: (event) => {
        if (event.type === 'output') commandEvents.b.push(event.data);
      },
    }),
  ]);

  assertCondition(a.stdout === 'a:start\na:end\n', `first concurrent command should receive its own result: ${JSON.stringify(a)}`);
  assertCondition(b.stdout === 'b:start\nb:end\n', `second concurrent command should receive its own result: ${JSON.stringify(b)}`);
  assertCondition(
    commandEvents.a.join('') === 'a:start\na:end\n' &&
      commandEvents.b.join('') === 'b:start\nb:end\n',
    `concurrent command output events should not cross streams: ${JSON.stringify(commandEvents)}`
  );
}

async function testWorkspaceRunCommandsCanOverlap(): Promise<void> {
  let releaseCommands!: () => void;
  const commandsReleased = new Promise<void>((resolve) => {
    releaseCommands = resolve;
  });
  let bothStarted!: () => void;
  const bothStartedPromise = new Promise<void>((resolve) => {
    bothStarted = resolve;
  });
  const started = new Set<string>();

  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'a.js', contents: 'console.log("a")\n' },
      { path: 'b.js', contents: 'console.log("b")\n' },
    ],
    nodeRunner: async (request) => {
      const label = request.scriptPath.endsWith('a.js') ? 'a' : 'b';
      started.add(label);
      if (started.size === 2) bothStarted();
      await commandsReleased;
      return { stdout: `${label}:done\n`, stderr: '', exitCode: 0 };
    },
  });

  const commands = Promise.all([
    workspace.runCommand('node a.js'),
    workspace.runCommand('node b.js'),
  ]);
  const overlapped = await Promise.race([
    bothStartedPromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  releaseCommands();
  const [a, b] = await commands;

  assertCondition(overlapped, `concurrent commands should be allowed to overlap: ${JSON.stringify([...started])}`);
  assertCondition(
    a.stdout === 'a:done\n' && b.stdout === 'b:done\n',
    `overlapping commands should still receive isolated results: ${JSON.stringify({ a, b })}`
  );
}

async function testWorkspaceSchedulerQueuesBeyondConcurrencyLimit(): Promise<void> {
  let releaseA!: () => void;
  const aReleased = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let releaseB!: () => void;
  const bReleased = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  let aStarted!: () => void;
  const aStartedPromise = new Promise<void>((resolve) => {
    aStarted = resolve;
  });
  let bStarted!: () => void;
  const bStartedPromise = new Promise<void>((resolve) => {
    bStarted = resolve;
  });

  const workspace = await createRuntimeWorkspace({
    kernel: { scheduler: { maxConcurrentCommands: 1 } },
    files: [
      { path: 'a.js', contents: 'console.log("a")\n' },
      { path: 'b.js', contents: 'console.log("b")\n' },
    ],
    nodeRunner: async (request) => {
      if (request.scriptPath.endsWith('a.js')) {
        aStarted();
        await aReleased;
        return { stdout: 'a:done\n', stderr: '', exitCode: 0 };
      }
      bStarted();
      await bReleased;
      return { stdout: 'b:done\n', stderr: '', exitCode: 0 };
    },
  });

  const commandA = workspace.runCommand('node a.js');
  await aStartedPromise;
  const commandB = workspace.runCommand('node b.js');
  await new Promise((resolve) => setTimeout(resolve, 20));

  const beforeReleaseSched = await workspace.readFile('/proc/tracekernel/sched');
  const beforeReleaseProcesses = await workspace.readFile('/proc/tracekernel/processes');
  const queuedLine = beforeReleaseProcesses.split('\n').find((line) => line.endsWith('\tnode b.js'));
  const queuedPid = queuedLine?.split('\t')[0] ?? '';
  assertCondition(
    beforeReleaseSched.includes('queued\t1\n') &&
      beforeReleaseSched.includes('running\t1\n') &&
      beforeReleaseSched.includes('max_concurrent\t1\n') &&
      beforeReleaseSched.includes(`task\t${queuedPid}\tqueued\tnode b.js`) &&
      queuedLine?.includes('\tqueued\t'),
    `scheduler should queue commands beyond configured concurrency: ${JSON.stringify({ beforeReleaseSched, beforeReleaseProcesses })}`
  );
  const queuedStatus = await workspace.readFile(`/proc/${queuedPid}/status`);
  assertCondition(
    queuedStatus.includes('State:\tS (queued)\n') &&
      queuedStatus.includes('Command:\tnode b.js\n'),
    `queued commands should have proc status before admission: ${JSON.stringify(queuedStatus)}`
  );

  releaseA();
  await bStartedPromise;
  const afterAdmitSched = await workspace.readFile('/proc/tracekernel/sched');
  assertCondition(
    afterAdmitSched.includes('queued\t0\n') &&
      afterAdmitSched.includes('running\t1\n') &&
      afterAdmitSched.includes(`task\t${queuedPid}\trunning\tnode b.js`),
    `scheduler should admit queued command when capacity is released: ${JSON.stringify(afterAdmitSched)}`
  );
  releaseB();
  const [a, b] = await Promise.all([commandA, commandB]);
  assertCondition(
    a.stdout === 'a:done\n' && b.stdout === 'b:done\n',
    `scheduler should preserve command results after queue admission: ${JSON.stringify({ a, b })}`
  );
  const events = await workspace.readFile('/proc/tracekernel/events');
  assertCondition(
    events.includes(`process-queue\t${queuedPid}\t`) &&
      events.includes(`process-admit\t${queuedPid}\t`) &&
      events.includes(`process-start\t${queuedPid}\t`),
    `scheduler events should expose queue, admission, and start lifecycle: ${JSON.stringify(events)}`
  );
}

async function testWorkspaceSchedulerRejectsBeyondQueueLimit(): Promise<void> {
  let releaseA!: () => void;
  const aReleased = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let aStarted!: () => void;
  const aStartedPromise = new Promise<void>((resolve) => {
    aStarted = resolve;
  });

  const workspace = await createRuntimeWorkspace({
    kernel: { scheduler: { maxConcurrentCommands: 1, maxQueuedCommands: 1 } },
    files: [
      { path: 'a.js', contents: 'console.log("a")\n' },
      { path: 'b.js', contents: 'console.log("b")\n' },
      { path: 'c.js', contents: 'console.log("c")\n' },
    ],
    nodeRunner: async (request) => {
      if (request.scriptPath.endsWith('a.js')) {
        aStarted();
        await aReleased;
        return { stdout: 'a:done\n', stderr: '', exitCode: 0 };
      }
      return { stdout: `${request.scriptPath}:done\n`, stderr: '', exitCode: 0 };
    },
  });

  const commandA = workspace.runCommand('node a.js');
  await aStartedPromise;
  const commandB = workspace.runCommand('node b.js');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const commandC = await workspace.runCommand('node c.js');

  assertCondition(
    commandC.exitCode === 11 &&
      commandC.error?.code === 'EAGAIN' &&
      commandC.error.syscall === 'sched',
    `scheduler should reject commands beyond the configured queue limit: ${JSON.stringify(commandC)}`
  );
  const sched = await workspace.readFile('/proc/tracekernel/sched');
  assertCondition(
    sched.includes('queued\t1\n') &&
      sched.includes('running\t1\n') &&
      sched.includes('max_queued\t1\n'),
    `scheduler diagnostics should expose configured queue pressure: ${JSON.stringify(sched)}`
  );
  const events = await workspace.readFile('/proc/tracekernel/events');
  assertCondition(events.includes('process-reject'), `scheduler rejection should be visible in kernel events: ${JSON.stringify(events)}`);

  releaseA();
  const [a, b] = await Promise.all([commandA, commandB]);
  assertCondition(a.exitCode === 0 && b.exitCode === 0, `admitted commands should still complete after rejection: ${JSON.stringify({ a, b })}`);
}

async function testWorkspaceSchedulerQueueSlotReleasedAfterCancellation(): Promise<void> {
  let releaseA!: () => void;
  const aReleased = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let releaseC!: () => void;
  const cReleased = new Promise<void>((resolve) => {
    releaseC = resolve;
  });
  let aStarted!: () => void;
  const aStartedPromise = new Promise<void>((resolve) => {
    aStarted = resolve;
  });
  let cStarted!: () => void;
  const cStartedPromise = new Promise<void>((resolve) => {
    cStarted = resolve;
  });
  const controllerB = new AbortController();

  const workspace = await createRuntimeWorkspace({
    kernel: { scheduler: { maxConcurrentCommands: 1, maxQueuedCommands: 1 } },
    files: [
      { path: 'a.js', contents: 'console.log("a")\n' },
      { path: 'b.js', contents: 'console.log("b")\n' },
      { path: 'c.js', contents: 'console.log("c")\n' },
    ],
    nodeRunner: async (request) => {
      if (request.scriptPath.endsWith('a.js')) {
        aStarted();
        await aReleased;
        return { stdout: 'a:done\n', stderr: '', exitCode: 0 };
      }
      if (request.scriptPath.endsWith('c.js')) {
        cStarted();
        await cReleased;
        return { stdout: 'c:done\n', stderr: '', exitCode: 0 };
      }
      return { stdout: 'b:done\n', stderr: '', exitCode: 0 };
    },
  });

  const commandA = workspace.runCommand('node a.js');
  await aStartedPromise;
  const commandB = workspace.runCommand('node b.js', { signal: controllerB.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controllerB.abort();
  const b = await commandB;
  const commandC = workspace.runCommand('node c.js');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const sched = await workspace.readFile('/proc/tracekernel/sched');

  assertCondition(
    b.exitCode === 143 &&
      b.error?.code === 'EINTR',
    `queued command cancellation should return a kernel interruption: ${JSON.stringify(b)}`
  );
  assertCondition(
    sched.includes('queued\t1\n') &&
      sched.includes('running\t1\n') &&
      sched.includes('task\t') &&
      sched.includes('\tqueued\tnode c.js'),
    `canceled queued command should release its queue slot for a later command: ${JSON.stringify(sched)}`
  );
  releaseA();
  await cStartedPromise;
  releaseC();
  const [a, c] = await Promise.all([commandA, commandC]);
  assertCondition(a.exitCode === 0 && c.exitCode === 0, `commands around queue cancellation should complete: ${JSON.stringify({ a, c })}`);
}

async function testWorkspaceProcProcessState(): Promise<void> {
  const selfStatus = await (await createRuntimeWorkspace()).runCommand('cat /proc/self/status');
  assertCondition(
    selfStatus.exitCode === 0 &&
      /^Pid:\t[0-9]+$/m.test(selfStatus.stdout) &&
      selfStatus.stdout.includes('State:\tR (running)\n') &&
      selfStatus.stdout.includes('FDSize:\t3\n') &&
      selfStatus.stdout.includes('Tty:\t?\n') &&
      selfStatus.stdout.includes('Foreground:\t0\n') &&
      selfStatus.stdout.includes('Command:\tcat /proc/self/status\n'),
    `commands should observe their process through /proc/self/status: ${JSON.stringify(selfStatus)}`
  );
  const terminalSelfStatus = await (await createRuntimeWorkspace()).runCommand('cat /proc/self/status', { presentation: 'terminal' });
  assertCondition(
    terminalSelfStatus.exitCode === 0 &&
      terminalSelfStatus.stdout.includes('Tty:\t/dev/tty\n') &&
      terminalSelfStatus.stdout.includes('Foreground:\t1\n'),
    `terminal-presented commands should own the foreground tty in /proc/self/status: ${JSON.stringify(terminalSelfStatus)}`
  );
  const selfFdInfo = await (await createRuntimeWorkspace()).runCommand('cat /proc/self/fdinfo/1');
  assertCondition(
    selfFdInfo.exitCode === 0 &&
      selfFdInfo.stdout.includes('flags:\tw\n') &&
      selfFdInfo.stdout.includes('target:\t/dev/stdout\n'),
    `commands should observe their fd table through /proc/self/fdinfo: ${JSON.stringify(selfFdInfo)}`
  );

  let releaseCommand!: () => void;
  const commandReleased = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  let commandStarted!: () => void;
  const commandStartedPromise = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'slow.js', contents: 'console.log("slow")\n' }],
    nodeRunner: async () => {
      commandStarted();
      await commandReleased;
      return { stdout: 'slow:done\n', stderr: '', exitCode: 0 };
    },
  });

  const command = workspace.runCommand('node slow.js');
  await commandStartedPromise;

  const processes = await workspace.readFile('/proc/tracekernel/processes');
  const processLine = processes.split('\n').find((line) => line.endsWith('\tnode slow.js'));
  assertCondition(Boolean(processLine), `kernel process table should show active commands: ${JSON.stringify(processes)}`);
  const pid = processLine?.split('\t')[0] ?? '';
  assertCondition(/^[0-9]+$/.test(pid), `active process line should expose a numeric pid: ${JSON.stringify(processLine)}`);

  const procEntries = await workspace.readDir('/proc');
  assertCondition(
    procEntries.includes('tracekernel') && procEntries.includes(pid),
    `kernel /proc should expose tracekernel and active pid directories: ${JSON.stringify(procEntries)}`
  );
  const status = await workspace.readFile(`/proc/${pid}/status`);
  assertCondition(
    status.includes(`Pid:\t${pid}\n`) &&
      status.includes('PPid:\t1\n') &&
      status.includes(`PGid:\t${pid}\n`) &&
      status.includes('Sid:\t1\n') &&
      status.includes('FDSize:\t3\n') &&
      status.includes('Tty:\t?\n') &&
      status.includes('Foreground:\t0\n') &&
      status.includes('State:\tR (running)\n') &&
      status.includes('Command:\tnode slow.js\n'),
    `kernel /proc/<pid>/status should expose active process state: ${JSON.stringify(status)}`
  );
  const fdEntries = await workspace.readDir(`/proc/${pid}/fd`);
  assertCondition(fdEntries.join(',') === '0,1,2', `kernel /proc/<pid>/fd should expose process descriptors: ${JSON.stringify(fdEntries)}`);
  const stdoutFdInfo = await workspace.readFile(`/proc/${pid}/fdinfo/1`);
  assertCondition(
    stdoutFdInfo.includes('flags:\tw\n') && stdoutFdInfo.includes('target:\t/dev/stdout\n'),
    `kernel /proc/<pid>/fdinfo should expose descriptor metadata: ${JSON.stringify(stdoutFdInfo)}`
  );
  const sched = await workspace.readFile('/proc/tracekernel/sched');
  assertCondition(
    sched.includes('running\t1\n') && sched.includes(`task\t${pid}\trunning\tnode slow.js`),
    `kernel scheduler proc file should expose active task state: ${JSON.stringify(sched)}`
  );
  const locks = await workspace.readFile('/proc/tracekernel/locks');
  assertCondition(
    locks.startsWith('path\tactive\twaiting\treaders\twriter\twaiting_readers\twaiting_writers\n'),
    `kernel locks proc file should expose lock diagnostics: ${JSON.stringify(locks)}`
  );

  releaseCommand();
  const result = await command;
  assertCondition(result.stdout === 'slow:done\n', `slow command should complete: ${JSON.stringify(result)}`);
  const afterProcesses = await workspace.readFile('/proc/tracekernel/processes');
  assertCondition(
    !afterProcesses.includes(`\t${pid}\t`) && !afterProcesses.includes('node slow.js'),
    `kernel process table should drop exited commands: ${JSON.stringify(afterProcesses)}`
  );
  await assertRejectsAsync(
    () => workspace.readFile(`/proc/${pid}/status`),
    'exited process proc entries should disappear'
  );
}

async function testTraceKernelRuntimeDiscovery(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    nodeRunner: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    pythonRunner: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    packageManager: true,
  });

  try {
    const runtimesText = await workspace.readFile('/proc/tracekernel/runtimes');
    const runtimes = JSON.parse(runtimesText) as {
      schema: string;
      binPath: string;
      runtimes: Array<{ language: string; available: boolean; commands: string[]; paths: string[] }>;
    };
    const javascriptRuntime = runtimes.runtimes.find((runtime) => runtime.language === 'javascript');
    const pythonRuntime = runtimes.runtimes.find((runtime) => runtime.language === 'python');
    assertCondition(runtimes.schema === 'tracekernel.runtimes.v1', 'runtime proc file should expose a stable schema');
    assertCondition(runtimes.binPath === '/tracekernel/bin', 'runtime proc file should publish the virtual bin path');
    assertCondition(
      javascriptRuntime?.available === true &&
        javascriptRuntime.commands.includes('node') &&
        javascriptRuntime.paths.includes('/tracekernel/bin/node'),
      `runtime proc file should expose configured JavaScript commands: ${runtimesText}`
    );
    assertCondition(
      pythonRuntime?.available === true &&
        pythonRuntime.commands.includes('python3') &&
        pythonRuntime.commands.includes('python'),
      `runtime proc file should expose configured Python commands: ${runtimesText}`
    );

    const commands = await workspace.readFile('/proc/tracekernel/commands');
    assertCondition(
      commands.includes('name\tpath\tkind\tlanguage\tadapter\tversion\tdescription\n') &&
        commands.includes('node\t/tracekernel/bin/node\truntime\tjavascript') &&
        commands.includes('npm\t/tracekernel/bin/npm\tpackage-manager'),
      `command proc file should expose agent-facing command metadata: ${commands}`
    );

    const procEntries = await workspace.readDir('/proc/tracekernel');
    assertCondition(
      procEntries.join(',') === 'commands,events,inodes,locks,net,processes,runtimes,sched',
      `tracekernel proc directory should list discovery and diagnostic files: ${JSON.stringify(procEntries)}`
    );
    const binEntries = await workspace.readDir('/tracekernel/bin');
    assertCondition(
      binEntries.includes('node') && binEntries.includes('python3') && binEntries.includes('npm'),
      `virtual bin directory should list available commands: ${JSON.stringify(binEntries)}`
    );
    const nodeShim = await workspace.readFile('/tracekernel/bin/node');
    assertCondition(
      nodeShim === '#!/bin/sh\nexec tracekernel-dispatch-node "$@"\n',
      `virtual bin commands should be executable dispatch shims: ${JSON.stringify(nodeShim)}`
    );

    const whichNode = await workspace.runCommand('which node python3 missing-tool');
    assertCondition(
      whichNode.exitCode === 1 &&
        whichNode.stdout === '/tracekernel/bin/node\n/tracekernel/bin/python3\n' &&
        whichNode.stderr.includes('missing-tool'),
      `which should resolve known commands and fail unknown commands: ${JSON.stringify(whichNode)}`
    );
    const commandV = await workspace.runCommand('command -v node');
    assertCondition(
      commandV.exitCode === 0 && commandV.stdout === '/tracekernel/bin/node\n',
      `command -v should use the same command registry: ${JSON.stringify(commandV)}`
    );
    const pathWhich = await workspace.runCommand('/tracekernel/bin/which node');
    assertCondition(
      pathWhich.exitCode === 0 && pathWhich.stdout === '/tracekernel/bin/node\n',
      `virtual bin paths returned by discovery should be invokable: ${JSON.stringify(pathWhich)}`
    );
  } finally {
    workspace.dispose();
  }
}

async function testTraceKernelSkillsRoot(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    skills: [
      { path: 'sorting/README.md', contents: 'sort skill\n' },
      { path: '/skills/provider/search.md', contents: 'search skill\n' },
    ],
  });

  try {
    assertCondition(
      (await workspace.readDir('/skills')).join(',') === 'provider,sorting',
      'skills root should list provider-inserted skill namespaces'
    );
    assertCondition(
      (await workspace.readDir('/skills/sorting')).join(',') === 'README.md',
      'skills directories should be readable through the kernel namespace'
    );
    assertCondition(
      await workspace.readFile('/skills/sorting/README.md') === 'sort skill\n',
      'skills files should be readable by user code'
    );
    const cat = await workspace.runCommand('cat /skills/provider/search.md');
    assertCondition(cat.exitCode === 0 && cat.stdout === 'search skill\n', `skills files should be visible to shell commands: ${JSON.stringify(cat)}`);
    const copy = await workspace.runCommand('cp /skills/provider/search.md copied-skill.md');
    assertCondition(copy.exitCode === 0, `skills files should be copyable into the workspace: ${JSON.stringify(copy)}`);
    assertCondition(await workspace.readFile('copied-skill.md') === 'search skill\n', 'copied skill files should preserve contents');

    const refusedSkillWrite = await workspace.runCommand('printf "mutate\\n" > /skills/provider/search.md');
    assertCondition(
      refusedSkillWrite.exitCode !== 0 &&
        refusedSkillWrite.error?.code === 'EROFS' &&
        refusedSkillWrite.stderr.includes('read-only file system'),
      `skills files should reject shell writes as normal command failures: ${JSON.stringify(refusedSkillWrite)}`
    );
    await assertRejectsAsync(
      () => workspace.writeFile('/skills/new.md', 'no\n'),
      'workspace writes should not create skills'
    );
    await assertRejectsAsync(
      () => workspace.mkdir('/skills/new'),
      'workspace mkdir should not mutate the skills root'
    );

    await workspace.writeSkillFiles([{ path: 'late/tool.md', contents: 'late\n' }]);
    assertCondition(await workspace.readFile('/skills/late/tool.md') === 'late\n', 'kernel skill insertion should work after workspace creation');
    await workspace.kernel.writeSkillFiles([{ path: 'provider/search.md', contents: 'updated search skill\n' }]);
    assertCondition(await workspace.readFile('/skills/provider/search.md') === 'updated search skill\n', 'kernel skill insertion should update existing skill files');
    const snapshot = await workspace.snapshot({ includeHidden: true });
    assertCondition(
      snapshot.kernelFiles?.some((file) => file.path === '/skills/late/tool.md' && file.contents === 'late\n') === true,
      `workspace snapshots should include skill files for browser and worker runners: ${JSON.stringify(snapshot.kernelFiles)}`
    );
    await assertRejectsAsync(
      () => workspace.writeSkillFiles([{ path: 'late', contents: 'conflict\n' }]),
      'skills should reject file/directory path conflicts'
    );
  } finally {
    workspace.dispose();
  }

  const sessionWorkspace = await createRuntimeWorkspace({
    projectSession: {
      id: 'skills-session',
      skills: [{ path: 'session/guide.md', contents: 'session skill\n' }],
    },
  });
  try {
    assertCondition(
      await sessionWorkspace.readFile('/skills/session/guide.md') === 'session skill\n',
      'project sessions should be able to seed protected skills'
    );
  } finally {
    sessionWorkspace.dispose();
  }
}

async function testWorkspaceTraceKernelKillProcess(): Promise<void> {
  let commandStarted!: () => void;
  const commandStartedPromise = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  let signalDelivered!: () => void;
  const signalDeliveredPromise = new Promise<void>((resolve) => {
    signalDelivered = resolve;
  });
  let releaseAfterSignal!: () => void;
  const releaseAfterSignalPromise = new Promise<void>((resolve) => {
    releaseAfterSignal = resolve;
  });

  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'sleep.js', contents: 'setInterval(() => {}, 1000)\n' }],
    nodeRunner: async (request) => {
      commandStarted();
      if (!request.signal) {
        return { stdout: '', stderr: 'missing signal\n', exitCode: 1 };
      }
      return new Promise<RuntimeCommandResult>((resolve) => {
        request.signal?.addEventListener('abort', () => {
          signalDelivered();
          void releaseAfterSignalPromise.then(() => {
            resolve({ stdout: '', stderr: '', exitCode: 143 });
          });
        }, { once: true });
      });
    },
  });

  const command = workspace.runCommand('node sleep.js');
  await commandStartedPromise;
  const processes = await workspace.readFile('/proc/tracekernel/processes');
  const processLine = processes.split('\n').find((line) => line.endsWith('\tnode sleep.js'));
  const pid = processLine?.split('\t')[0] ?? '';
  assertCondition(/^[0-9]+$/.test(pid), `kill test should find active process pid: ${JSON.stringify(processes)}`);

  const kill = await workspace.runCommand(`tracekernelctl kill ${pid} TERM`);
  assertCondition(
    kill.exitCode === 0 && kill.stdout === `tracekernelctl: sent SIGTERM to ${pid}\n`,
    `tracekernelctl kill should deliver SIGTERM: ${JSON.stringify(kill)}`
  );
  await signalDeliveredPromise;
  const status = await workspace.readFile(`/proc/${pid}/status`);
  assertCondition(
    status.includes('State:\tX (signaled)\n') &&
      status.includes('Signal:\tSIGTERM\n') &&
      status.includes('SignalCode:\t15\n'),
    `signaled process should expose signal state through proc: ${JSON.stringify(status)}`
  );
  const sched = await workspace.readFile('/proc/tracekernel/sched');
  assertCondition(
    sched.includes(`task\t${pid}\tsignaled\tnode sleep.js`),
    `scheduler proc file should show signaled task: ${JSON.stringify(sched)}`
  );

  releaseAfterSignal();
  const result = await command;
  assertCondition(
    result.exitCode === 143 &&
      result.error?.code === 'EINTR' &&
      result.error.syscall === 'wait4' &&
      result.error.path === pid,
    `killed command should return structured kernel interruption: ${JSON.stringify(result)}`
  );
  const zombieStatus = await workspace.readFile(`/proc/${pid}/status`);
  assertCondition(
    zombieStatus.includes('State:\tZ (zombie)\n') &&
      zombieStatus.includes('ExitCode:\t143\n') &&
      zombieStatus.includes('Signal:\tSIGTERM\n'),
    `exited signaled process should remain as an unreaped zombie: ${JSON.stringify(zombieStatus)}`
  );
  const zombieSched = await workspace.readFile('/proc/tracekernel/sched');
  assertCondition(
    zombieSched.includes('zombies\t1\n') &&
      zombieSched.includes(`task\t${pid}\tzombie\tnode sleep.js`),
    `scheduler proc file should expose unreaped zombies: ${JSON.stringify(zombieSched)}`
  );
  const wait = await workspace.runCommand(`tracekernelctl wait ${pid}`);
  assertCondition(
    wait.exitCode === 143 &&
      wait.stdout.includes(`pid\t${pid}\n`) &&
      wait.stdout.includes('exitCode\t143\n') &&
      wait.stdout.includes('signal\tSIGTERM\n'),
    `tracekernelctl wait should reap zombie process state: ${JSON.stringify(wait)}`
  );
  const events = await workspace.readFile('/proc/tracekernel/events');
  assertCondition(
    events.includes(`process-start\t${pid}\t`) &&
      events.includes(`process-signal\t${pid}\t`) &&
      events.includes(`process-zombie\t${pid}\t`) &&
      events.includes(`process-reap\t${pid}\t`),
    `kernel event proc file should expose structured process lifecycle events: ${JSON.stringify(events)}`
  );
  await assertRejectsAsync(
    () => workspace.readFile(`/proc/${pid}/status`),
    'reaped process proc entries should disappear'
  );
}

async function testWorkspaceTraceKernelKillPropagatesToNativeNodeRunner(): Promise<void> {
  let observedReady!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    observedReady = resolve;
  });
  let stdout = '';
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'slow-native.js', contents: 'console.log("ready"); setInterval(() => {}, 1000);\n' },
    ],
    nodeRunner: createNativeJavaScriptProjectRunner({ timeoutMs: 30_000 }),
  });

  const command = workspace.runCommand('node slow-native.js', {
    onEvent: (event) => {
      if (event.type !== 'output' || event.stream !== 'stdout') return;
      stdout += event.data;
      if (stdout.includes('ready')) observedReady();
    },
  });
  await readyPromise;
  const pid = await processPidForCommand(workspace, 'node slow-native.js');
  const kill = await workspace.runCommand(`tracekernelctl kill ${pid} TERM`);
  const result = await Promise.race([
    command,
    new Promise<RuntimeCommandResult>((resolve) =>
      setTimeout(() => resolve({ stdout: '', stderr: 'native runner did not stop after SIGTERM\n', exitCode: 124 }), 2_000)
    ),
  ]);

  assertCondition(kill.exitCode === 0, `tracekernelctl kill should signal native node command: ${JSON.stringify(kill)}`);
  assertCondition(
    result.exitCode === 143 &&
      result.error?.code === 'EINTR' &&
      result.error.detail?.signal === 'SIGTERM',
    `native node runner should stop promptly when the kernel process is signaled: ${JSON.stringify(result)}`
  );
  const events = await workspace.readFile('/proc/tracekernel/events');
  assertCondition(
    events.includes(`process-signal\t${pid}\t`) &&
      events.includes(`process-zombie\t${pid}\t`),
    `kernel events should show native process signal and zombie lifecycle: ${JSON.stringify(events)}`
  );
}

async function testWorkspaceTraceKernelKillProcessGroup(): Promise<void> {
  let commandStarted!: () => void;
  const commandStartedPromise = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  let signalDelivered!: () => void;
  const signalDeliveredPromise = new Promise<void>((resolve) => {
    signalDelivered = resolve;
  });

  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'group-process.js', contents: 'setInterval(() => {}, 1000)\n' }],
    nodeRunner: async (request) => {
      commandStarted();
      return new Promise<RuntimeCommandResult>((resolve) => {
        request.signal?.addEventListener('abort', () => {
          signalDelivered();
          resolve({ stdout: '', stderr: '', exitCode: 143 });
        }, { once: true });
      });
    },
  });

  const command = workspace.runCommand('node group-process.js');
  await commandStartedPromise;
  const pid = await processPidForCommand(workspace, 'node group-process.js');
  const kill = await workspace.runCommand(`tracekernelctl kill -${pid} TERM`);
  await signalDeliveredPromise;
  const result = await command;

  assertCondition(
    kill.exitCode === 0 &&
      kill.stdout === `tracekernelctl: sent SIGTERM to process group ${pid} (1 process)\n`,
    `tracekernelctl should support negative pgid signal targets: ${JSON.stringify(kill)}`
  );
  assertCondition(result.exitCode === 143 && result.error?.detail?.signal === 'SIGTERM', `process-group kill should interrupt the target command: ${JSON.stringify(result)}`);
  const events = await workspace.readFile('/proc/tracekernel/events');
  assertCondition(events.includes('process-group-signal'), `process-group signal should be visible in kernel events: ${JSON.stringify(events)}`);
  await workspace.runCommand(`tracekernelctl wait ${pid}`);
}

async function testWorkspaceTraceKernelWaitBlocksUntilZombie(): Promise<void> {
  let commandStarted!: () => void;
  const commandStartedPromise = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  let signalDelivered!: () => void;
  const signalDeliveredPromise = new Promise<void>((resolve) => {
    signalDelivered = resolve;
  });
  let releaseAfterSignal!: () => void;
  const releaseAfterSignalPromise = new Promise<void>((resolve) => {
    releaseAfterSignal = resolve;
  });

  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'wait.js', contents: 'setInterval(() => {}, 1000)\n' }],
    nodeRunner: async (request) => {
      commandStarted();
      return new Promise<RuntimeCommandResult>((resolve) => {
        request.signal?.addEventListener('abort', () => {
          signalDelivered();
          void releaseAfterSignalPromise.then(() => {
            resolve({ stdout: '', stderr: '', exitCode: 130 });
          });
        }, { once: true });
      });
    },
  });

  const command = workspace.runCommand('node wait.js');
  await commandStartedPromise;
  const processes = await workspace.readFile('/proc/tracekernel/processes');
  const processLine = processes.split('\n').find((line) => line.endsWith('\tnode wait.js'));
  const pid = processLine?.split('\t')[0] ?? '';
  assertCondition(/^[0-9]+$/.test(pid), `blocking wait test should find active process pid: ${JSON.stringify(processes)}`);

  const kill = await workspace.runCommand(`tracekernelctl kill ${pid} INT`);
  assertCondition(kill.exitCode === 0, `tracekernelctl kill INT should succeed: ${JSON.stringify(kill)}`);
  await signalDeliveredPromise;

  let waitSettled = false;
  const wait = workspace.runCommand(`wait ${pid}`).then((result) => {
    waitSettled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertCondition(!waitSettled, 'wait <pid> should block while the signaled process is still unwinding');

  releaseAfterSignal();
  const result = await command;
  const waitResult = await wait;
  assertCondition(result.exitCode === 130, `signaled command should finish before wait reaps it: ${JSON.stringify(result)}`);
  assertCondition(
    waitResult.exitCode === 130 &&
      waitResult.stdout.includes(`pid\t${pid}\n`) &&
      waitResult.stdout.includes('signal\tSIGINT\n'),
    `blocking wait should reap the requested zombie through the kernel command surface: ${JSON.stringify(waitResult)}`
  );

  const noChild = await workspace.runCommand('wait');
  assertCondition(
    noChild.exitCode === 10 && noChild.stderr === 'wait: no child process\n',
    `wait without children should fail like waitpid ECHILD: ${JSON.stringify(noChild)}`
  );
}

async function testWorkspaceQueuedCommandCancellation(): Promise<void> {
  let releaseActive!: () => void;
  const activeReleased = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  let activeStarted!: () => void;
  const activeStartedPromise = new Promise<void>((resolve) => {
    activeStarted = resolve;
  });

  const workspace = await createRuntimeWorkspace({
    kernel: { scheduler: { maxConcurrentCommands: 1 } },
    files: [
      { path: 'active.js', contents: 'console.log("active")\n' },
      { path: 'queued.js', contents: 'console.log("queued")\n' },
    ],
    nodeRunner: async (request) => {
      if (request.scriptPath.endsWith('active.js')) {
        activeStarted();
        await activeReleased;
        return { stdout: 'active:done\n', stderr: '', exitCode: 0 };
      }
      return { stdout: 'queued:ran\n', stderr: '', exitCode: 0 };
    },
  });

  const active = workspace.runCommand('node active.js');
  await activeStartedPromise;
  const queuedAbort = new AbortController();
  const queued = workspace.runCommand('node queued.js', { signal: queuedAbort.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const queuedPid = await processPidForCommand(workspace, 'node queued.js');
  const queuedStatus = await workspace.readFile(`/proc/${queuedPid}/status`);
  assertCondition(
    queuedStatus.includes('State:\tS (queued)\n'),
    `queued command should be visible as queued before cancellation: ${JSON.stringify(queuedStatus)}`
  );

  queuedAbort.abort();
  const queuedResult = await queued;
  assertCondition(
    queuedResult.exitCode === 143 &&
      queuedResult.error?.code === 'EINTR' &&
      queuedResult.error.syscall === 'wait4' &&
      queuedResult.error.path === queuedPid,
    `queued command cancellation should return structured EINTR: ${JSON.stringify(queuedResult)}`
  );
  const schedAfterAbort = await workspace.readFile('/proc/tracekernel/sched');
  assertCondition(
    schedAfterAbort.includes('queued\t0\n') &&
      schedAfterAbort.includes('waiting\t0\n'),
    `scheduler should not leak queued work after cancellation: ${JSON.stringify(schedAfterAbort)}`
  );
  releaseActive();
  const activeResult = await active;
  assertCondition(activeResult.exitCode === 0, `active command should finish after queued cancellation: ${JSON.stringify(activeResult)}`);
  const wait = await workspace.runCommand(`wait ${queuedPid}`);
  assertCondition(wait.exitCode === 143 && wait.stdout.includes('signal\tSIGTERM\n'), `queued canceled command should be reapable: ${JSON.stringify(wait)}`);
}

async function testWorkspaceVfsLockWaitCancellation(): Promise<void> {
  let releaseLock!: () => void;
  const lockReleased = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  let lockHeld!: () => void;
  const lockHeldPromise = new Promise<void>((resolve) => {
    lockHeld = resolve;
  });

  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'locked.txt', contents: 'initial\n' }],
    customCommands: [{
      name: 'hold-lock',
      execute: async (_args: string[], ctx: { fs: unknown }) => {
        await (ctx.fs as { withBaseMutation: Function }).withBaseMutation(
          ['/workspace/locked.txt'],
          async () => {
            lockHeld();
            await lockReleased;
          },
          'file-write'
        );
        return { stdout: 'held\n', stderr: '', exitCode: 0 };
      },
    }],
  });

  const holder = workspace.runCommand('hold-lock');
  await lockHeldPromise;
  const reader = workspace.runCommand('cat locked.txt');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const readerPid = await processPidForCommand(workspace, 'cat locked.txt');
  const locksWhileWaiting = await workspace.readFile('/proc/tracekernel/locks');
  assertCondition(
    locksWhileWaiting.includes('/workspace/locked.txt\t1\t1\t0\t1\t1\t0'),
    `VFS lock diagnostics should show a waiting reader behind the writer: ${JSON.stringify(locksWhileWaiting)}`
  );

  const kill = await workspace.runCommand(`tracekernelctl kill ${readerPid} TERM`);
  assertCondition(kill.exitCode === 0, `kill should signal lock waiter: ${JSON.stringify(kill)}`);
  const readerResult = await reader;
  assertCondition(
    readerResult.exitCode === 143 &&
      readerResult.error?.code === 'EINTR' &&
      readerResult.error.path === readerPid,
    `canceling a VFS lock waiter should return structured EINTR: ${JSON.stringify(readerResult)}`
  );
  const locksAfterCancel = await workspace.readFile('/proc/tracekernel/locks');
  assertCondition(
    locksAfterCancel.includes('/workspace/locked.txt\t1\t0\t0\t1\t0\t0'),
    `VFS lock waiter cancellation should remove the queued reader and leave only the holder: ${JSON.stringify(locksAfterCancel)}`
  );

  releaseLock();
  const holderResult = await holder;
  assertCondition(holderResult.exitCode === 0, `lock holder should finish: ${JSON.stringify(holderResult)}`);
  const locksAfterRelease = await workspace.readFile('/proc/tracekernel/locks');
  assertCondition(
    locksAfterRelease.startsWith('path\tactive\twaiting\treaders\twriter\twaiting_readers\twaiting_writers\n') &&
      !locksAfterRelease.includes('/workspace/locked.txt'),
    `VFS locks should be idle after holder release: ${JSON.stringify(locksAfterRelease)}`
  );
}

async function testWorkspaceVfsLockHolderCancellationReleasesWaiters(): Promise<void> {
  let holderSignalDelivered!: () => void;
  const holderSignalDeliveredPromise = new Promise<void>((resolve) => {
    holderSignalDelivered = resolve;
  });
  let lockHeld!: () => void;
  const lockHeldPromise = new Promise<void>((resolve) => {
    lockHeld = resolve;
  });

  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'held.txt', contents: 'initial\n' }],
    customCommands: [{
      name: 'hold-until-signal',
      execute: async (_args: string[], ctx: { fs: unknown; signal?: AbortSignal }) => {
        await (ctx.fs as { withBaseMutation: Function }).withBaseMutation(
          ['/workspace/held.txt'],
          async () => {
            lockHeld();
            await new Promise<void>((resolve) => {
              ctx.signal?.addEventListener('abort', () => {
                holderSignalDelivered();
                resolve();
              }, { once: true });
            });
          },
          'file-write'
        );
        return { stdout: '', stderr: '', exitCode: 143 };
      },
    }],
  });

  const holder = workspace.runCommand('hold-until-signal');
  await lockHeldPromise;
  const waiter = workspace.runCommand('cat held.txt');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const holderPid = await processPidForCommand(workspace, 'hold-until-signal');
  const waiterPid = await processPidForCommand(workspace, 'cat held.txt');
  const locksBeforeKill = await workspace.readFile('/proc/tracekernel/locks');
  assertCondition(
    locksBeforeKill.includes('/workspace/held.txt\t1\t1\t0\t1\t1\t0'),
    `holder should block reader before cancellation: ${JSON.stringify(locksBeforeKill)}`
  );

  const kill = await workspace.runCommand(`tracekernelctl kill ${holderPid} TERM`);
  assertCondition(kill.exitCode === 0, `kill should signal lock holder: ${JSON.stringify(kill)}`);
  await holderSignalDeliveredPromise;
  const [holderResult, waiterResult] = await Promise.all([holder, waiter]);
  assertCondition(
    holderResult.exitCode === 143 &&
      holderResult.error?.code === 'EINTR',
    `canceling a lock holder should return structured EINTR: ${JSON.stringify(holderResult)}`
  );
  assertCondition(
    waiterResult.exitCode === 0 && waiterResult.stdout === 'initial\n',
    `waiter should proceed after canceled holder releases the VFS lock: ${JSON.stringify({ waiterPid, waiterResult })}`
  );
  const locksAfterRelease = await workspace.readFile('/proc/tracekernel/locks');
  assertCondition(
    !locksAfterRelease.includes('/workspace/held.txt'),
    `canceling a lock holder should not leak active locks or waiters: ${JSON.stringify(locksAfterRelease)}`
  );
}

async function testWorkspaceFinalDiffLockWaitCancellation(): Promise<void> {
  let releaseLock!: () => void;
  const lockReleased = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  let lockHeld!: () => void;
  const lockHeldPromise = new Promise<void>((resolve) => {
    lockHeld = resolve;
  });
  let releaseRunner!: () => void;
  const runnerReleased = new Promise<void>((resolve) => {
    releaseRunner = resolve;
  });
  let runnerStarted!: () => void;
  const runnerStartedPromise = new Promise<void>((resolve) => {
    runnerStarted = resolve;
  });

  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'final.txt', contents: 'initial\n' },
      { path: 'mutate.js', contents: 'console.log("mutate")\n' },
    ],
    customCommands: [{
      name: 'hold-final-lock',
      execute: async (_args: string[], ctx: { fs: unknown }) => {
        await (ctx.fs as { withBaseMutation: Function }).withBaseMutation(
          ['/workspace/final.txt'],
          async () => {
            lockHeld();
            await lockReleased;
          },
          'file-write'
        );
        return { stdout: 'held\n', stderr: '', exitCode: 0 };
      },
    }],
    nodeRunner: async () => {
      runnerStarted();
      await runnerReleased;
      return {
        stdout: 'mutate:done\n',
        stderr: '',
        exitCode: 0,
        files: [{ path: 'final.txt', contents: 'mutated\n' }],
      };
    },
  });

  const abort = new AbortController();
  const mutate = workspace.runCommand('node mutate.js', { signal: abort.signal });
  await runnerStartedPromise;
  const holder = workspace.runCommand('hold-final-lock');
  await lockHeldPromise;
  releaseRunner();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const mutatePid = await processPidForCommand(workspace, 'node mutate.js');
  const locksWhileWaiting = await workspace.readFile('/proc/tracekernel/locks');
  assertCondition(
    locksWhileWaiting.includes('/workspace/final.txt\t1\t1\t0\t1\t0\t1'),
    `final-diff writer should wait behind existing writer lock: ${JSON.stringify(locksWhileWaiting)}`
  );

  abort.abort();
  const mutateResult = await mutate;
  assertCondition(
    mutateResult.exitCode === 143 &&
      mutateResult.error?.code === 'EINTR' &&
      mutateResult.error.path === mutatePid,
    `canceling a final-diff lock waiter should return structured EINTR: ${JSON.stringify(mutateResult)}`
  );
  releaseLock();
  const holderResult = await holder;
  assertCondition(holderResult.exitCode === 0, `final lock holder should finish: ${JSON.stringify(holderResult)}`);
  assertCondition(
    await workspace.readFile('final.txt') === 'initial\n',
    'canceled final-diff should not mutate the file after lock wait cancellation'
  );
  const locksAfterRelease = await workspace.readFile('/proc/tracekernel/locks');
  assertCondition(
    !locksAfterRelease.includes('/workspace/final.txt'),
    `final-diff lock cancellation should not leak locks: ${JSON.stringify(locksAfterRelease)}`
  );
}

async function testWorkspaceLiveFilesystemSyscallEventsAndCancellation(): Promise<void> {
  let releaseLock!: () => void;
  const lockReleased = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  let lockHeld!: () => void;
  const lockHeldPromise = new Promise<void>((resolve) => {
    lockHeld = resolve;
  });
  let earlyLiveEvent!: () => void;
  const earlyLiveEventPromise = new Promise<void>((resolve) => {
    earlyLiveEvent = resolve;
  });

  const liveEvents: RuntimeWorkspaceEvent[] = [];
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'live-syscall.js', contents: 'console.log("live")\n' },
      { path: 'early-live.txt', contents: 'before\n' },
      { path: 'blocked-live.txt', contents: 'initial\n' },
    ],
    customCommands: [{
      name: 'hold-blocked-live',
      execute: async (_args: string[], ctx: { fs: unknown }) => {
        await (ctx.fs as { withBaseMutation: Function }).withBaseMutation(
          ['/workspace/blocked-live.txt'],
          async () => {
            lockHeld();
            await lockReleased;
          },
          'file-write'
        );
        return { stdout: 'held\n', stderr: '', exitCode: 0 };
      },
    }],
    nodeRunner: async (request) => {
      request.onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'early-live.txt', contents: 'early\n' } });
      await lockHeldPromise;
      request.onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'blocked-live.txt', contents: 'blocked\n' } });
      return { stdout: 'live-syscall\n', stderr: '', exitCode: 0 };
    },
  });

  const abort = new AbortController();
  const command = workspace.runCommand('node live-syscall.js', {
    signal: abort.signal,
    onEvent: (event) => {
      liveEvents.push(event);
      if (event.type === 'file-change' && event.phase === 'live' && event.change.path === 'early-live.txt') {
        earlyLiveEvent();
      }
    },
  });
  await earlyLiveEventPromise;
  const holder = workspace.runCommand('hold-blocked-live');
  await lockHeldPromise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const commandPid = await processPidForCommand(workspace, 'node live-syscall.js');
  const locksWhileWaiting = await workspace.readFile('/proc/tracekernel/locks');
  assertCondition(
    locksWhileWaiting.includes('/workspace/blocked-live.txt\t1\t1\t0\t1\t'),
    `live file-change should wait behind the held write lock: ${JSON.stringify(locksWhileWaiting)}`
  );

  abort.abort();
  const result = await command;
  assertCondition(
    result.exitCode === 143 &&
      result.error?.code === 'EINTR' &&
      result.error.path === commandPid,
    `canceling a live filesystem syscall waiter should return structured EINTR: ${JSON.stringify(result)}`
  );
  releaseLock();
  const holderResult = await holder;
  assertCondition(holderResult.exitCode === 0, `live syscall lock holder should finish: ${JSON.stringify(holderResult)}`);
  assertCondition(
    await workspace.readFile('early-live.txt') === 'early\n' &&
      await workspace.readFile('blocked-live.txt') === 'initial\n',
    'earlier successful live syscalls should remain visible while the interrupted syscall should not commit'
  );
  assertCondition(
    liveEvents.some((event) => event.type === 'file-change' && event.phase === 'live' && event.change.path === 'early-live.txt') &&
      !liveEvents.some((event) => event.type === 'file-change' && event.phase === 'live' && event.change.path === 'blocked-live.txt'),
    `failed live syscall should not emit its live file-change event: ${JSON.stringify(liveEvents)}`
  );
  const kernelEvents = await workspace.readFile('/proc/tracekernel/events');
  assertCondition(
    kernelEvents.includes('fs-syscall-start') &&
      kernelEvents.includes('fs-syscall-commit') &&
      kernelEvents.includes('fs-syscall-abort') &&
      kernelEvents.includes('early-live.txt') &&
      kernelEvents.includes('blocked-live.txt'),
    `kernel events should expose live syscall start/commit/abort lifecycle: ${JSON.stringify(kernelEvents)}`
  );
  const locksAfterRelease = await workspace.readFile('/proc/tracekernel/locks');
  assertCondition(
    !locksAfterRelease.includes('/workspace/blocked-live.txt'),
    `live syscall cancellation should not leak locks: ${JSON.stringify(locksAfterRelease)}`
  );
}

async function testWorkspaceShellProcessUtilities(): Promise<void> {
  let commandStarted!: () => void;
  const commandStartedPromise = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  let signalDelivered!: () => void;
  const signalDeliveredPromise = new Promise<void>((resolve) => {
    signalDelivered = resolve;
  });
  let releaseAfterSignal!: () => void;
  const releaseAfterSignalPromise = new Promise<void>((resolve) => {
    releaseAfterSignal = resolve;
  });

  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'shell-process.js', contents: 'setInterval(() => {}, 1000)\n' }],
    nodeRunner: async (request) => {
      commandStarted();
      return new Promise<RuntimeCommandResult>((resolve) => {
        request.signal?.addEventListener('abort', () => {
          signalDelivered();
          void releaseAfterSignalPromise.then(() => {
            resolve({ stdout: '', stderr: '', exitCode: 143 });
          });
        }, { once: true });
      });
    },
  });

  const command = workspace.runCommand('node shell-process.js');
  await commandStartedPromise;
  const processes = await workspace.readFile('/proc/tracekernel/processes');
  const processLine = processes.split('\n').find((line) => line.endsWith('\tnode shell-process.js'));
  const pid = processLine?.split('\t')[0] ?? '';
  assertCondition(/^[0-9]+$/.test(pid), `shell utility test should find active process pid: ${JSON.stringify(processes)}`);

  const ps = await workspace.runCommand('ps -ef');
  assertCondition(
    ps.exitCode === 0 &&
      ps.stdout.includes('PID  PPID  PGID') &&
      ps.stdout.includes('TTY') &&
      ps.stdout.includes(`?        node shell-process.js`),
    `ps should expose kernel process table: ${JSON.stringify(ps)}`
  );
  const jobs = await workspace.runCommand('jobs -l');
  assertCondition(
    jobs.exitCode === 0 && jobs.stdout.includes(`${pid}\tRunning\tbackground\t?\tnode shell-process.js`),
    `jobs -l should expose active kernel jobs with foreground and tty metadata: ${JSON.stringify(jobs)}`
  );
  const fg = await workspace.runCommand(`fg ${pid}`);
  assertCondition(
    fg.exitCode === 0 && fg.stdout === `fg: ${pid}\tpgid=${pid}\tforeground\tnode shell-process.js\n`,
    `fg should move a kernel job into the foreground: ${JSON.stringify(fg)}`
  );
  const foregroundStatus = await workspace.readFile(`/proc/${pid}/status`);
  assertCondition(
    foregroundStatus.includes('Tty:\t/dev/tty\n') && foregroundStatus.includes('Foreground:\t1\n'),
    `fg should update proc foreground metadata: ${JSON.stringify(foregroundStatus)}`
  );
  const bg = await workspace.runCommand('bg %1');
  assertCondition(
    bg.exitCode === 0 && bg.stdout === `bg: ${pid}\tpgid=${pid}\tbackground\tnode shell-process.js\n`,
    `bg should move a kernel job back into the background: ${JSON.stringify(bg)}`
  );
  const backgroundJobs = await workspace.runCommand('jobs -l');
  assertCondition(
    backgroundJobs.exitCode === 0 && backgroundJobs.stdout.includes(`${pid}\tRunning\tbackground\t?\tnode shell-process.js`),
    `jobs -l should reflect bg foreground metadata changes: ${JSON.stringify(backgroundJobs)}`
  );
  const kill = await workspace.runCommand(`kill -TERM ${pid}`);
  assertCondition(kill.exitCode === 0, `kill should signal kernel process: ${JSON.stringify(kill)}`);
  await signalDeliveredPromise;
  releaseAfterSignal();
  const result = await command;
  assertCondition(result.exitCode === 143, `killed shell utility process should exit with signal code: ${JSON.stringify(result)}`);
  const wait = await workspace.runCommand(`wait ${pid}`);
  assertCondition(
    wait.exitCode === 143 && wait.stdout.includes(`pid\t${pid}\n`) && wait.stdout.includes('signal\tSIGTERM\n'),
    `wait should reap kernel zombie state after shell kill: ${JSON.stringify(wait)}`
  );
}

async function testWorkspaceDestroyWaitsForActiveCommand(): Promise<void> {
  let releaseCommand!: () => void;
  const commandReleased = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  let commandStarted!: () => void;
  const commandStartedPromise = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });

  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'slow.js', contents: 'console.log("slow")\n' }],
    nodeRunner: async (request) => {
      request.onEvent?.({ type: 'output', stream: 'stdout', data: 'slow:start\n' });
      commandStarted();
      await commandReleased;
      request.onEvent?.({ type: 'output', stream: 'stdout', data: 'slow:end\n' });
      return { stdout: 'slow:start\nslow:end\n', stderr: '', exitCode: 0 };
    },
  });

  const command = workspace.runCommand('node slow.js');
  await commandStartedPromise;

  let destroySettled = false;
  const destroy = workspace.destroy({ reason: 'test' }).then(() => {
    destroySettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertCondition(!destroySettled, 'destroy should wait for an active command before clearing the workspace');

  releaseCommand();
  const result = await command;
  await destroy;
  assertCondition(
    result.stdout === 'slow:start\nslow:end\n' && destroySettled,
    `destroy should allow the active command to finish before completing: ${JSON.stringify(result)}`
  );
  const afterDestroy = await workspace.runCommand('pwd');
  assertCondition(
    afterDestroy.exitCode !== 0 && afterDestroy.stderr === 'project session is no longer available\n',
    `commands after destroy should be rejected: ${JSON.stringify(afterDestroy)}`
  );
}

async function testWorkspaceConcurrentMutationDoesNotEnterCommandEvents(): Promise<void> {
  let releaseCommand!: () => void;
  const commandReleased = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  let commandStarted!: () => void;
  const commandStartedPromise = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });

  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'slow.js', contents: 'console.log("slow")\n' }],
    nodeRunner: async (request) => {
      request.onEvent?.({ type: 'output', stream: 'stdout', data: 'slow:start\n' });
      commandStarted();
      await commandReleased;
      request.onEvent?.({ type: 'output', stream: 'stdout', data: 'slow:end\n' });
      return { stdout: 'slow:start\nslow:end\n', stderr: '', exitCode: 0 };
    },
  });

  const watchedEvents: RuntimeCommandEvent[] = [];
  workspace.watch((event) => watchedEvents.push(event));
  const commandEvents: RuntimeCommandEvent[] = [];
  const command = workspace.runCommand('node slow.js', {
    onEvent: (event) => commandEvents.push(event),
  });
  await commandStartedPromise;

  await workspace.writeFile('external.txt', 'external\n');
  assertCondition(
    !commandEvents.some((event) => event.type === 'file-change' && event.change.path === 'external.txt'),
    `external workspace writes should not enter active command events: ${JSON.stringify(commandEvents)}`
  );
  assertCondition(
    watchedEvents.some((event) =>
      event.type === 'file-change' &&
        event.change.path === 'external.txt' &&
        event.actor?.kind === 'principal'
    ),
    `external workspace writes should remain principal workspace events: ${JSON.stringify(watchedEvents)}`
  );

  releaseCommand();
  const result = await command;
  assertCondition(result.stdout === 'slow:start\nslow:end\n', `slow command should still complete: ${JSON.stringify(result)}`);
}

async function testWorkspaceStaleFinalDiffIsRejected(): Promise<void> {
  let releaseCommand!: () => void;
  const commandReleased = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  let commandStarted!: () => void;
  const commandStartedPromise = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });

  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'stale.js', contents: 'console.log("stale")\n' },
      { path: 'target.txt', contents: 'original\n' },
    ],
    nodeRunner: async () => {
      commandStarted();
      await commandReleased;
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        files: [{ path: 'target.txt', contents: 'runner\n' }],
      };
    },
  });

  const command = workspace.runCommand('node stale.js');
  await commandStartedPromise;
  await workspace.writeFile('target.txt', 'external\n');
  releaseCommand();

  const result = await command;
  assertCondition(
    result.exitCode === 116 &&
      result.stderr === "ESTALE: stale file handle, write 'target.txt'\n" &&
      result.error?.code === 'ESTALE' &&
      result.error.syscall === 'write' &&
      result.error.path === 'target.txt',
    `stale final diff should fail instead of overwriting a newer file: ${JSON.stringify(result)}`
  );
  assertCondition(
    await workspace.readFile('target.txt') === 'external\n',
    'stale final diff should leave the newer file contents intact'
  );
}

async function testWorkspaceConcurrentStaleFinalDiffStress(): Promise<void> {
  const commandCount = 10;
  let releaseCommands!: () => void;
  const commandsReleased = new Promise<void>((resolve) => {
    releaseCommands = resolve;
  });
  let allStarted!: () => void;
  const allStartedPromise = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  const started = new Set<string>();

  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'shared.txt', contents: 'initial\n' },
      ...Array.from({ length: commandCount }, (_, index) => ({
        path: `stress-${index}.js`,
        contents: `console.log("stress-${index}")\n`,
      })),
    ],
    nodeRunner: async (request) => {
      const label = request.scriptPath.replace(/\.js$/, '');
      started.add(label);
      if (started.size === commandCount) allStarted();
      await commandsReleased;
      return {
        stdout: `${label}\n`,
        stderr: '',
        exitCode: 0,
        files: [{ path: 'shared.txt', contents: `${label}\n` }],
      };
    },
  });

  const commands = Array.from({ length: commandCount }, (_, index) => workspace.runCommand(`node stress-${index}.js`));
  const overlapped = await Promise.race([
    allStartedPromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  releaseCommands();
  const results = await Promise.all(commands);

  const successes = results.filter((result) => result.exitCode === 0);
  const staleFailures = results.filter((result) =>
    result.exitCode === 116 &&
      result.error?.code === 'ESTALE' &&
      result.error.syscall === 'write' &&
      result.error.path === 'shared.txt'
  );
  const finalContents = await workspace.readFile('shared.txt');
  assertCondition(overlapped, `stale stress commands should overlap before final diff application: ${JSON.stringify([...started])}`);
  assertCondition(
    successes.length === 1 && staleFailures.length === commandCount - 1,
    `exactly one concurrent final diff should win and the rest should fail ESTALE: ${JSON.stringify(results)}`
  );
  assertCondition(
    successes.some((result) => result.stdout === finalContents),
    `winning final diff should determine the final complete file contents: ${JSON.stringify({ finalContents, results })}`
  );
  const locks = await workspace.readFile('/proc/tracekernel/locks');
  assertCondition(
    locks.startsWith('path\tactive\twaiting\treaders\twriter\twaiting_readers\twaiting_writers\n') && !locks.includes('\t1\t'),
    `kernel lock diagnostics should be idle after stale stress completes: ${JSON.stringify(locks)}`
  );
}

async function testWorkspaceFinalDiffTransactionRejectsWithoutPartialCommit(): Promise<void> {
  let releaseCommand!: () => void;
  const commandReleased = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  let commandStarted!: () => void;
  const commandStartedPromise = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  const events: RuntimeWorkspaceEvent[] = [];

  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'first.txt', contents: 'first:initial\n' },
      { path: 'second.txt', contents: 'second:initial\n' },
      { path: 'multi-stale.js', contents: 'console.log("multi")\n' },
    ],
    nodeRunner: async () => {
      commandStarted();
      await commandReleased;
      return {
        stdout: 'multi:done\n',
        stderr: '',
        exitCode: 0,
        files: [
          { path: 'first.txt', contents: 'first:command\n' },
          { path: 'second.txt', contents: 'second:command\n' },
        ],
      };
    },
  });
  const unsubscribe = workspace.watch((event) => events.push(event));

  const command = workspace.runCommand('node multi-stale.js');
  await commandStartedPromise;
  await workspace.writeFile('second.txt', 'second:external\n');
  releaseCommand();
  const result = await command;
  unsubscribe();

  assertCondition(
    result.exitCode === 116 &&
      result.error?.code === 'ESTALE',
    `multi-file stale final diff should reject the whole transaction: ${JSON.stringify(result)}`
  );
  assertCondition(
    await workspace.readFile('first.txt') === 'first:initial\n' &&
      await workspace.readFile('second.txt') === 'second:external\n',
    'stale multi-file final diff should leave all transaction files unchanged'
  );
  assertCondition(
    !events.some((event) => event.type === 'file-change' && event.phase === 'final-diff' && event.change.path === 'first.txt') &&
      !events.some((event) => event.type === 'file-change' && event.phase === 'final-diff' && event.change.path === 'second.txt'),
    `rejected final-diff transaction should not emit partial final-diff events: ${JSON.stringify(events)}`
  );
  const kernelEvents = await workspace.readFile('/proc/tracekernel/events');
  assertCondition(
    kernelEvents.includes('fs-transaction-start') &&
      kernelEvents.includes('fs-transaction-abort') &&
      !kernelEvents.includes('fs-transaction-commit'),
    `stale final-diff transaction should expose transaction abort events: ${JSON.stringify(kernelEvents)}`
  );
}

async function testWorkspaceFinalDiffDirectoryDeleteTransactionIsAtomic(): Promise<void> {
  let releaseCommand!: () => void;
  const commandReleased = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  let commandStarted!: () => void;
  const commandStartedPromise = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  const events: RuntimeWorkspaceEvent[] = [];

  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'target.txt', contents: 'target:initial\n' },
      { path: 'tree/original.txt', contents: 'tree:initial\n' },
      { path: 'dir-stale.js', contents: 'console.log("dir")\n' },
    ],
    nodeRunner: async () => {
      commandStarted();
      await commandReleased;
      return {
        stdout: 'dir:done\n',
        stderr: '',
        exitCode: 0,
        files: [
          { path: 'target.txt', contents: 'target:command\n' },
          { path: 'tree', directory: true, deleted: true },
        ],
      };
    },
  });
  const unsubscribe = workspace.watch((event) => events.push(event));

  const command = workspace.runCommand('node dir-stale.js');
  await commandStartedPromise;
  await workspace.mkdir('tree/new-child');
  releaseCommand();
  const result = await command;
  unsubscribe();

  assertCondition(
    result.exitCode === 116 &&
      result.error?.code === 'ESTALE',
    `stale directory delete final diff should reject the whole transaction: ${JSON.stringify(result)}`
  );
  assertCondition(
    await workspace.readFile('target.txt') === 'target:initial\n' &&
      await workspace.exists('tree/original.txt') &&
      await workspace.exists('tree/new-child'),
    'stale directory delete transaction should leave file write and directory tree unchanged'
  );
  assertCondition(
    !events.some((event) => event.type === 'file-change' && event.phase === 'final-diff'),
    `rejected directory final-diff transaction should not emit final-diff events: ${JSON.stringify(events)}`
  );
}

async function testWorkspaceAdapterFinalDiffTransactionsRejectStaleBatches(): Promise<void> {
  type WorkspaceOptions = NonNullable<Parameters<typeof createRuntimeWorkspace>[0]>;
  const cases: Array<{
    name: string;
    command: string;
    files: RuntimeFile[];
    options(started: () => void, released: Promise<void>): WorkspaceOptions;
  }> = [
    {
      name: 'python',
      command: 'python3 main.py',
      files: [{ path: 'main.py', contents: 'print("python")\n' }],
      options: (started, released) => ({
        pythonRunner: async () => {
          started();
          await released;
          return {
            stdout: 'python\n',
            stderr: '',
            exitCode: 0,
            files: [
              { path: 'first.txt', contents: 'python:first\n' },
              { path: 'second.txt', contents: 'python:second\n' },
            ],
          };
        },
      }),
    },
    {
      name: 'node',
      command: 'node main.js',
      files: [{ path: 'main.js', contents: 'console.log("node")\n' }],
      options: (started, released) => ({
        nodeRunner: async () => {
          started();
          await released;
          return {
            stdout: 'node\n',
            stderr: '',
            exitCode: 0,
            files: [
              { path: 'first.txt', contents: 'node:first\n' },
              { path: 'second.txt', contents: 'node:second\n' },
            ],
          };
        },
      }),
    },
    {
      name: 'java',
      command: 'javac Main.java',
      files: [{ path: 'Main.java', contents: 'class Main {}\n' }],
      options: (started, released) => ({
        javaRunner: async () => {
          started();
          await released;
          return {
            stdout: 'java\n',
            stderr: '',
            exitCode: 0,
            files: [
              { path: 'first.txt', contents: 'java:first\n' },
              { path: 'second.txt', contents: 'java:second\n' },
            ],
          };
        },
      }),
    },
    {
      name: 'cpp',
      command: 'clang++ main.cpp -o app',
      files: [{ path: 'main.cpp', contents: 'int main() { return 0; }\n' }],
      options: (started, released) => ({
        cppRunner: async () => {
          started();
          await released;
          return {
            stdout: 'cpp\n',
            stderr: '',
            exitCode: 0,
            files: [
              { path: 'first.txt', contents: 'cpp:first\n' },
              { path: 'second.txt', contents: 'cpp:second\n' },
            ],
          };
        },
      }),
    },
    {
      name: 'csharp',
      command: 'dotnet build App.csproj',
      files: [{ path: 'App.csproj', contents: '<Project Sdk="Microsoft.NET.Sdk"></Project>\n' }],
      options: (started, released) => ({
        csharpRunner: async () => {
          started();
          await released;
          return {
            stdout: 'csharp\n',
            stderr: '',
            exitCode: 0,
            files: [
              { path: 'first.txt', contents: 'csharp:first\n' },
              { path: 'second.txt', contents: 'csharp:second\n' },
            ],
          };
        },
      }),
    },
  ];

  for (const testCase of cases) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const workspace = await createRuntimeWorkspace({
      files: [
        { path: 'first.txt', contents: 'first:initial\n' },
        { path: 'second.txt', contents: 'second:initial\n' },
        ...testCase.files,
      ],
      ...testCase.options(started, released),
    });

    const command = workspace.runCommand(testCase.command);
    await startedPromise;
    await workspace.writeFile('second.txt', `${testCase.name}:external\n`);
    release();
    const result = await command;

    assertCondition(
      result.exitCode === 116 &&
        result.error?.code === 'ESTALE',
      `${testCase.name} adapter should reject stale returned final-diff batches: ${JSON.stringify(result)}`
    );
    assertCondition(
      await workspace.readFile('first.txt') === 'first:initial\n' &&
        await workspace.readFile('second.txt') === `${testCase.name}:external\n`,
      `${testCase.name} adapter stale final diff should not partially commit`
    );
  }
}

async function testWorkspaceFinalDiffTransactionRollsBackUnexpectedApplyFailure(): Promise<void> {
  const events: RuntimeWorkspaceEvent[] = [];
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'first.txt', contents: 'first:initial\n' },
      { path: 'second.txt', contents: 'second:initial\n' },
    ],
  });
  const unsubscribe = workspace.watch((event) => events.push(event));
  let throwingFileReads = 0;
  const throwingFile = {
    path: 'second.txt',
    get contents(): string {
      throwingFileReads += 1;
      if (throwingFileReads > 1) throw new Error('synthetic final-diff apply failure');
      return 'second:changed\n';
    },
  };
  let failed = false;

  try {
    await (workspace as RuntimeWorkspace & {
      applyFinalDiffResultFiles(result: RuntimeCommandResult): Promise<RuntimeCommandResult>;
    }).applyFinalDiffResultFiles({
      stdout: '',
      stderr: '',
      exitCode: 0,
      files: [
        { path: 'first.txt', contents: 'first:changed\n' },
        throwingFile as unknown as { path: string; contents: string },
      ],
    });
  } catch (error) {
    failed = error instanceof Error && error.message === 'synthetic final-diff apply failure';
  } finally {
    unsubscribe();
  }

  assertCondition(failed, 'unexpected final-diff apply failure should propagate to the caller');
  assertCondition(
    await workspace.readFile('first.txt') === 'first:initial\n' &&
      await workspace.readFile('second.txt') === 'second:initial\n',
    'unexpected final-diff apply failure should roll back already-applied paths'
  );
  assertCondition(
    !events.some((event) => event.type === 'file-change' && event.phase === 'final-diff'),
    `rolled-back final-diff transaction should not emit final-diff file-change events: ${JSON.stringify(events)}`
  );
  const kernelEvents = await workspace.readFile('/proc/tracekernel/events');
  assertCondition(
    kernelEvents.includes('fs-transaction-abort') && kernelEvents.includes('"rolledBack":true'),
    `rolled-back final-diff transaction should expose rollback in kernel events: ${JSON.stringify(kernelEvents)}`
  );
}

async function testWorkspaceFinalDiffUpdatesKernelInodeTable(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'old.txt', contents: 'old\n' },
      { path: 'tree/child.txt', contents: 'child\n' },
      { path: 'inode-final-diff.js', contents: 'console.log("inode")\n' },
    ],
    nodeRunner: async () => ({
      stdout: 'inode\n',
      stderr: '',
      exitCode: 0,
      files: [
        { path: 'old.txt', deleted: true },
        { path: 'tree/child.txt', deleted: true },
        { path: 'tree', directory: true, deleted: true },
        { path: 'new-dir/new.txt', contents: 'new\n' },
      ],
    }),
  });
  const oldStat = await workspace.stat('old.txt');
  const childStat = await workspace.stat('tree/child.txt');
  const result = await workspace.runCommand('node inode-final-diff.js');
  const inodeTable = await workspace.readFile('/proc/tracekernel/inodes');

  assertCondition(result.exitCode === 0, `final-diff inode command should succeed: ${JSON.stringify(result)}`);
  assertCondition(
    inodeTable.includes('\tnew-dir/new.txt') &&
      !inodeTable.includes(`${oldStat.ino}\told.txt`) &&
      !inodeTable.includes(`${childStat.ino}\ttree/child.txt`),
    `final-diff commits should update the kernel inode table: ${JSON.stringify(inodeTable)}`
  );
}

async function testWorkspaceMetadataIsConsistentAcrossLiveAndFinalDiffWrites(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'metadata-final.js', contents: 'console.log("metadata")\n' },
    ],
    nodeRunner: async () => ({
      stdout: 'metadata\n',
      stderr: '',
      exitCode: 0,
      files: [{ path: 'final-metadata.txt', contents: 'final\n' }],
    }),
  });

  await workspace.writeFile('live-metadata.txt', 'live\n');
  const finalResult = await workspace.runCommand('node metadata-final.js');
  const liveStat = await workspace.stat('live-metadata.txt');
  const finalStat = await workspace.stat('final-metadata.txt');
  const procStat = await workspace.stat('/proc/kernel/info');

  assertCondition(finalResult.exitCode === 0, `metadata final-diff command should succeed: ${JSON.stringify(finalResult)}`);
  for (const [label, stat] of [['live', liveStat], ['final', finalStat]] as const) {
    assertCondition(
      stat.isFile &&
        !stat.isDirectory &&
        stat.size === `${label}\n`.length &&
        typeof stat.ino === 'number' &&
        typeof stat.mode === 'number' &&
        typeof stat.mtimeMs === 'number' &&
        stat.nlink === 1,
      `${label} workspace stat should expose stable metadata: ${JSON.stringify(stat)}`
    );
  }
  assertCondition(
    procStat.isFile &&
      procStat.mode === 0o444 &&
      procStat.mtimeMs === 0 &&
      procStat.nlink === 1,
    `virtual proc stat should expose deterministic metadata: ${JSON.stringify(procStat)}`
  );
}

async function testWorkspaceConcurrentIndependentFinalDiffWrites(): Promise<void> {
  let releaseCommands!: () => void;
  const commandsReleased = new Promise<void>((resolve) => {
    releaseCommands = resolve;
  });
  let bothStarted!: () => void;
  const bothStartedPromise = new Promise<void>((resolve) => {
    bothStarted = resolve;
  });
  const started = new Set<string>();

  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'same-dir/a.txt', contents: 'a:initial\n' },
      { path: 'same-dir/b.txt', contents: 'b:initial\n' },
      { path: 'write-a.js', contents: 'console.log("a")\n' },
      { path: 'write-b.js', contents: 'console.log("b")\n' },
    ],
    nodeRunner: async (request) => {
      const label = request.scriptPath.endsWith('write-a.js') ? 'a' : 'b';
      started.add(label);
      if (started.size === 2) bothStarted();
      await commandsReleased;
      return {
        stdout: `${label}:done\n`,
        stderr: '',
        exitCode: 0,
        files: [{ path: `same-dir/${label}.txt`, contents: `${label}:updated\n` }],
      };
    },
  });

  const commands = Promise.all([
    workspace.runCommand('node write-a.js'),
    workspace.runCommand('node write-b.js'),
  ]);
  await bothStartedPromise;
  releaseCommands();
  const [a, b] = await commands;

  assertCondition(
    a.exitCode === 0 && b.exitCode === 0,
    `independent final-diff writes in the same directory should both commit: ${JSON.stringify({ a, b })}`
  );
  assertCondition(
    await workspace.readFile('same-dir/a.txt') === 'a:updated\n' &&
      await workspace.readFile('same-dir/b.txt') === 'b:updated\n',
    'independent final-diff writes should update their own files'
  );
}

async function testWorkspaceRenameConflictsWithStaleFinalDiffWrite(): Promise<void> {
  let releaseCommand!: () => void;
  const commandReleased = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  let commandStarted!: () => void;
  const commandStartedPromise = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });

  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'target.txt', contents: 'initial\n' },
      { path: 'rename-race.js', contents: 'console.log("race")\n' },
    ],
    nodeRunner: async () => {
      commandStarted();
      await commandReleased;
      return {
        stdout: 'race:done\n',
        stderr: '',
        exitCode: 0,
        files: [{ path: 'target.txt', contents: 'command\n' }],
      };
    },
  });

  const command = workspace.runCommand('node rename-race.js');
  await commandStartedPromise;
  await workspace.moveFile('target.txt', 'renamed.txt');
  releaseCommand();
  const result = await command;

  assertCondition(
    result.exitCode === 116 &&
      result.error?.code === 'ESTALE',
    `rename should invalidate a stale final-diff write to the old path: ${JSON.stringify(result)}`
  );
  assertCondition(
    await workspace.readFile('renamed.txt') === 'initial\n' &&
      !(await workspace.exists('target.txt')),
    'stale final-diff write should not resurrect a renamed file'
  );
}

async function testPythonCommandAdapter(): Promise<void> {
  const requests: PythonProjectCommandRequest[] = [];
  const workspace = await createRuntimeWorkspace({
    entrypoint: 'main.py',
    files: [
      { path: 'helper.py', contents: 'def add(a, b):\n    return a + b\n' },
      { path: 'main.py', contents: 'from helper import add\nprint(add(2, 3))\n' },
    ],
    pythonRunner: async (request) => {
      requests.push(request);
      return {
        stdout: [
          `source=${request.source}`,
          `script=${request.scriptPath}`,
          `args=${request.args.join(',')}`,
          `files=${request.project.files.map((file) => file.path).join(',')}`,
          request.code.includes('from helper import add') ? 'loaded-main' : 'missing-main',
        ].join('\n') + '\n',
        stderr: '',
        exitCode: 0,
      };
    },
  });

  const result = await workspace.runCommand('python3 main.py alpha beta');
  assertCondition(result.exitCode === 0, 'python3 adapter should succeed');
  assertCondition(
    result.stdout === 'source=file\nscript=main.py\nargs=alpha,beta\nfiles=helper.py,main.py\nloaded-main\n',
    `python3 adapter should receive file execution request, received ${JSON.stringify(result.stdout)}`
  );
  assertCondition(requests.length === 1, 'python runner should be invoked once');
  assertCondition(requests[0]?.project.files.length === 2, 'python runner should receive project snapshot');
  assertCondition(requests[0]?.project.entrypoint === 'main.py', 'python runner should receive workspace entrypoint');

  const codeResult = await workspace.runCommand('python -c "print(1 + 2)"');
  assertCondition(codeResult.stdout.includes('source=argument'), 'python alias should support -c code');
  assertCondition(codeResult.stdout.includes('script=-c'), 'python alias should mark -c requests as argument source');

  const flaggedCodeResult = await workspace.runCommand('python3 -u -B -P --check-hash-based-pycs default -X utf8 -c "print(3 + 4)" gamma');
  assertCondition(flaggedCodeResult.exitCode === 0, 'python3 adapter should accept interpreter flags before -c');
  assertCondition(
    flaggedCodeResult.stdout === 'source=argument\nscript=-c\nargs=gamma\nfiles=helper.py,main.py\nmissing-main\n',
    `python3 adapter should ignore interpreter flags and preserve -c args, received ${JSON.stringify(flaggedCodeResult.stdout)}`
  );

  const longModuleResult = await workspace.runCommand('python3 --module main delta');
  assertCondition(longModuleResult.exitCode === 0, 'python3 adapter should accept --module');
  assertCondition(
    longModuleResult.stdout === 'source=module\nscript=main\nargs=delta\nfiles=helper.py,main.py\nmissing-main\n',
    `python3 adapter should map --module to a module request, received ${JSON.stringify(longModuleResult.stdout)}`
  );
}

async function testNodeCommandAdapter(): Promise<void> {
  const requests: JavaScriptProjectCommandRequest[] = [];
  const workspace = await createRuntimeWorkspace({
    entrypoint: 'index.js',
    files: [
      { path: 'helper.js', contents: 'exports.add = (a, b) => a + b;\n' },
      { path: 'index.js', contents: 'const { add } = require("./helper");\nconsole.log(add(2, 3));\n' },
    ],
    nodeRunner: async (request) => {
      requests.push(request);
      return {
        stdout: [
          `source=${request.source}`,
          `script=${request.scriptPath}`,
          `args=${request.args.join(',')}`,
          `inputType=${typeof request.options?.inputType === 'string' ? request.options.inputType : ''}`,
          `files=${request.project.files.map((file) => file.path).join(',')}`,
          request.code.includes('require("./helper")') ? 'loaded-index' : 'missing-index',
        ].join('\n') + '\n',
        stderr: '',
        exitCode: 0,
      };
    },
  });

  const result = await workspace.runCommand('node index.js alpha beta');
  assertCondition(result.exitCode === 0, 'node adapter should succeed');
  assertCondition(
    result.stdout === 'source=file\nscript=index.js\nargs=alpha,beta\ninputType=\nfiles=helper.js,index.js\nloaded-index\n',
    `node adapter should receive file execution request, received ${JSON.stringify(result.stdout)}`
  );
  assertCondition(requests.length === 1, 'node runner should be invoked once');
  assertCondition(requests[0]?.project.files.length === 2, 'node runner should receive project snapshot');
  assertCondition(requests[0]?.project.entrypoint === 'index.js', 'node runner should receive workspace entrypoint');

  const codeResult = await workspace.runCommand('node -e "console.log(1 + 2)"');
  assertCondition(codeResult.stdout.includes('source=argument'), 'node adapter should support -e code');

  const flaggedEval = await workspace.runCommand('node --no-warnings --input-type=module -e "console.log(await Promise.resolve(7))" gamma');
  assertCondition(flaggedEval.exitCode === 0, 'node adapter should accept launcher flags before -e');
  assertCondition(
    flaggedEval.stdout === 'source=argument\nscript=-e\nargs=gamma\ninputType=module\nfiles=helper.js,index.js\nmissing-index\n',
    `node adapter should preserve input-type module for eval requests, received ${JSON.stringify(flaggedEval.stdout)}`
  );

  const diagnosticFlagEval = await workspace.runCommand('node --trace-warnings --trace-deprecation --throw-deprecation -e "console.log(9)"');
  assertCondition(diagnosticFlagEval.exitCode === 0, 'node adapter should accept diagnostic launcher flags before -e');
  assertCondition(
    diagnosticFlagEval.stdout === 'source=argument\nscript=-e\nargs=\ninputType=\nfiles=helper.js,index.js\nmissing-index\n',
    `node adapter should ignore supported diagnostic launcher flags, received ${JSON.stringify(diagnosticFlagEval.stdout)}`
  );

  const printResult = await workspace.runCommand('node --print "1 + 2" delta');
  assertCondition(printResult.exitCode === 0, 'node adapter should support --print expressions');
  assertCondition(
    printResult.stdout === 'source=argument\nscript=-e\nargs=delta\ninputType=\nfiles=helper.js,index.js\nmissing-index\n',
    `node adapter should map --print to an argument request, received ${JSON.stringify(printResult.stdout)}`
  );
}

async function testPythonNodeCommandAdapterGlobScripts(): Promise<void> {
  const pythonRequests: PythonProjectCommandRequest[] = [];
  const nodeRequests: JavaScriptProjectCommandRequest[] = [];
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'scripts/run.py', contents: 'print("python glob")\n' },
      { path: 'scripts/run.js', contents: 'console.log("node glob");\n' },
      { path: 'data/a.txt', contents: 'a\n' },
      { path: 'data/b.txt', contents: 'b\n' },
    ],
    pythonRunner: async (request) => {
      pythonRequests.push(request);
      return {
        stdout: `${request.source}:${request.scriptPath}:${request.args.join(',')}:${request.code.includes('python glob') ? 'file' : request.code}\n`,
        stderr: '',
        exitCode: 0,
      };
    },
    nodeRunner: async (request) => {
      nodeRequests.push(request);
      return {
        stdout: `${request.source}:${request.scriptPath}:${request.args.join(',')}:${request.code.includes('node glob') ? 'file' : request.code}\n`,
        stderr: '',
        exitCode: 0,
      };
    },
  });

  const python = await workspace.runCommand('python3 scripts/*.py data/*.txt');
  assertCondition(python.exitCode === 0, `python3 glob script adapter should succeed: ${python.stderr}`);
  assertCondition(
    python.stdout === 'file:scripts/run.py:data/a.txt,data/b.txt:file\n',
    `python3 adapter should expand script and argv globs after parsing: ${python.stdout}`
  );

  const pythonInline = await workspace.runCommand('python3 -c "print(\'*\')" data/*.txt');
  assertCondition(pythonInline.exitCode === 0, `python3 inline glob args should succeed: ${pythonInline.stderr}`);
  assertCondition(
    pythonInline.stdout === "argument:-c:data/a.txt,data/b.txt:print('*')\n",
    `python3 adapter should not glob-expand inline code strings: ${pythonInline.stdout}`
  );

  const node = await workspace.runCommand('node scripts/*.js data/*.txt');
  assertCondition(node.exitCode === 0, `node glob script adapter should succeed: ${node.stderr}`);
  assertCondition(
    node.stdout === 'file:scripts/run.js:data/a.txt,data/b.txt:file\n',
    `node adapter should expand script and argv globs after parsing: ${node.stdout}`
  );

  const nodeInline = await workspace.runCommand('node -e "console.log(\'*\')" data/*.txt');
  assertCondition(nodeInline.exitCode === 0, `node inline glob args should succeed: ${nodeInline.stderr}`);
  assertCondition(
    nodeInline.stdout === "argument:-e:data/a.txt,data/b.txt:console.log('*')\n",
    `node adapter should not glob-expand inline code strings: ${nodeInline.stdout}`
  );

  assertCondition(pythonRequests.length === 2, 'python glob adapter should invoke runner for file and inline forms');
  assertCondition(nodeRequests.length === 2, 'node glob adapter should invoke runner for file and inline forms');
}

async function testCommandAdapterWorkspaceCwd(): Promise<void> {
  let received: JavaScriptProjectCommandRequest | null = null;
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'lib/shared.js', contents: 'exports.value = 11;\n' },
      { path: 'src/index.js', contents: 'console.log("cwd");\n' },
    ],
    nodeRunner: async (request) => {
      received = request;
      return {
        stdout: `${request.cwd}:${request.scriptPath}:${request.project.files.map((file) => file.path).join(',')}\n`,
        stderr: '',
        exitCode: 0,
        files: [
          { path: 'src/generated.txt', contents: 'created\n' },
          { path: '/workspace/src/absolute-generated.txt', contents: 'absolute-created\n' },
        ],
      };
    },
  });

  const result = await workspace.runCommand('node index.js', { cwd: 'src' });
  assertCondition(result.exitCode === 0, 'node adapter cwd request should succeed');
  assertCondition(
    result.stdout === '/workspace/src:src/index.js:lib/shared.js,src/index.js\n',
    `node adapter should preserve workspace-relative files and cwd separately: ${result.stdout}`
  );
  assertCondition((received as JavaScriptProjectCommandRequest | null)?.project.cwd === '/workspace', 'node adapter project snapshot should keep workspace root cwd');
  assertCondition(await workspace.readFile('src/generated.txt') === 'created\n', 'node adapter should apply runner file changes from workspace root');
  assertCondition(
    await workspace.readFile('/workspace/src/absolute-generated.txt') === 'absolute-created\n',
    'node adapter should apply absolute virtual runner file changes'
  );

  const absoluteCwdResult = await workspace.runCommand('node index.js', { cwd: '/workspace/src' });
  assertCondition(absoluteCwdResult.exitCode === 0, 'node adapter absolute cwd request should succeed');
  assertCondition(
    absoluteCwdResult.stdout === '/workspace/src:src/index.js:lib/shared.js,src/absolute-generated.txt,src/generated.txt,src/index.js\n',
    `node adapter should accept absolute virtual cwd inside workspace: ${absoluteCwdResult.stdout}`
  );

  const deleteWorkspace = await createRuntimeWorkspace({
    files: [{ path: 'src/stale.txt', contents: 'delete me\n' }],
    nodeRunner: async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      files: [{ path: '/workspace/src/stale.txt', deleted: true }],
    }),
  });
  const deleteResult = await deleteWorkspace.runCommand('node -e ""');
  assertCondition(deleteResult.exitCode === 0, 'node adapter absolute deletion should succeed');
  await assertRejectsAsync(
    () => deleteWorkspace.readFile('/workspace/src/stale.txt'),
    'node adapter should apply absolute virtual runner deletions'
  );

  const boundaryWorkspace = await createRuntimeWorkspace({
    pythonRunner: async () => {
      throw new Error('python runner should not receive outside-workspace scripts');
    },
    nodeRunner: async () => {
      throw new Error('node runner should not receive outside-workspace scripts');
    },
    javaRunner: async () => {
      throw new Error('java runner should not receive outside-workspace jars');
    },
  });
  const pythonOutside = await boundaryWorkspace.runCommand(
    "mkdir -p /tmp && printf 'print(1)\\n' > /tmp/main.py && python3 /tmp/main.py"
  );
  assertCondition(
    pythonOutside.exitCode !== 0 && pythonOutside.stderr.includes('Python script path must stay inside the workspace'),
    `python adapter should reject existing scripts outside the workspace before invoking runner: ${pythonOutside.stderr}`
  );
  const nodeOutside = await boundaryWorkspace.runCommand(
    "mkdir -p /tmp && printf 'console.log(1)\\n' > /tmp/main.js && node /tmp/main.js"
  );
  assertCondition(
    nodeOutside.exitCode !== 0 && nodeOutside.stderr.includes('Node script path must stay inside the workspace'),
    `node adapter should reject existing scripts outside the workspace before invoking runner: ${nodeOutside.stderr}`
  );
  const javaOutside = await boundaryWorkspace.runCommand(
    "mkdir -p /tmp && printf 'not-a-jar\\n' > /tmp/app.jar && java -jar /tmp/app.jar"
  );
  assertCondition(
    javaOutside.exitCode !== 0 && javaOutside.stderr.includes('Java jar path must stay inside the workspace'),
    `java adapter should reject existing jars outside the workspace before invoking runner: ${javaOutside.stderr}`
  );
}

async function testJavaCommandAdapter(): Promise<void> {
  const requests: JavaProjectCommandRequest[] = [];
  const workspace = await createRuntimeWorkspace({
    entrypoint: 'Main.java',
    files: [
      { path: 'Helper.java', contents: 'class Helper { static int add(int a, int b) { return a + b; } }\n' },
      { path: 'Main.java', contents: 'class Main { public static void main(String[] args) { System.out.println(Helper.add(2, 3)); } }\n' },
      { path: 'javac.args', contents: 'Main.java Helper.java\n' },
      { path: 'run.args', contents: '-cp . Main from-argfile\n' },
      {
        path: 'app.jar',
        contents: createStoredJarBase64([
          { path: 'META-INF/MANIFEST.MF', contents: 'Manifest-Version: 1.0\nMain-Class: app.Main\n\n' },
        ]),
        encoding: 'base64',
      },
    ],
    javaRunner: async (request) => {
      requests.push(request);
      return {
        stdout: [
          `source=${request.source}`,
          `script=${request.scriptPath}`,
          `args=${request.args.join(',')}`,
          `files=${request.project.files.map((file) => file.path).join(',')}`,
        ].join('\n') + '\n',
        stderr: '',
        exitCode: 0,
        ...(request.source === 'compile'
          ? { files: [{ path: 'out/CompileMarker.txt', contents: 'compiled\n' }] }
          : {}),
      };
    },
  });

  const compile = await workspace.runCommand('javac Main.java Helper.java');
  assertCondition(compile.exitCode === 0, 'javac adapter should succeed');
  assertCondition(
    compile.stdout === 'source=compile\nscript=Main.java\nargs=Main.java,Helper.java\nfiles=app.jar,Helper.java,javac.args,Main.java,run.args\n',
    `javac adapter should receive compile request, received ${JSON.stringify(compile.stdout)}`
  );
  assertCondition(requests[0]?.project.entrypoint === 'Main.java', 'java runner should receive workspace entrypoint');
  const marker = await workspace.runCommand('cat out/CompileMarker.txt');
  assertCondition(marker.stdout === 'compiled\n', 'javac adapter should apply runner file side effects');

  const argfileCompile = await workspace.runCommand('javac @javac.args');
  assertCondition(argfileCompile.exitCode === 0, 'javac adapter should expand argfiles');
  assertCondition(
    argfileCompile.stdout === 'source=compile\nscript=Main.java\nargs=Main.java,Helper.java\nfiles=app.jar,Helper.java,javac.args,Main.java,out/CompileMarker.txt,run.args\n',
    `javac adapter should parse expanded argfile compile request, received ${JSON.stringify(argfileCompile.stdout)}`
  );

  const run = await workspace.runCommand('java Main alpha beta');
  assertCondition(run.exitCode === 0, 'java adapter should succeed');
  assertCondition(
    run.stdout === 'source=run\nscript=Main\nargs=alpha,beta\nfiles=app.jar,Helper.java,javac.args,Main.java,out/CompileMarker.txt,run.args\n',
    `java adapter should receive run request, received ${JSON.stringify(run.stdout)}`
  );

  const classpathRun = await workspace.runCommand('java -cp . Main gamma');
  assertCondition(classpathRun.exitCode === 0, 'java adapter should accept -cp before main class');
  assertCondition(
    classpathRun.stdout === 'source=run\nscript=Main\nargs=gamma\nfiles=app.jar,Helper.java,javac.args,Main.java,out/CompileMarker.txt,run.args\n',
    `java adapter should parse classpath run request, received ${JSON.stringify(classpathRun.stdout)}`
  );
  assertCondition(requests[3]?.options?.classpath === '.', 'java adapter should pass classpath through request options');

  const previewRun = await workspace.runCommand('java --enable-preview Main preview');
  assertCondition(previewRun.exitCode === 0, 'java adapter should accept --enable-preview before main class');
  assertCondition(
    previewRun.stdout === 'source=run\nscript=Main\nargs=preview\nfiles=app.jar,Helper.java,javac.args,Main.java,out/CompileMarker.txt,run.args\n',
    `java adapter should parse --enable-preview run request, received ${JSON.stringify(previewRun.stdout)}`
  );
  assertCondition(requests[4]?.options?.enablePreview === true, 'java adapter should preserve --enable-preview in request options');

  const assertionRun = await workspace.runCommand('java -ea Main assertions');
  assertCondition(assertionRun.exitCode === 0, 'java adapter should accept -ea before main class');
  assertCondition(
    assertionRun.stdout === 'source=run\nscript=Main\nargs=assertions\nfiles=app.jar,Helper.java,javac.args,Main.java,out/CompileMarker.txt,run.args\n',
    `java adapter should parse -ea run request, received ${JSON.stringify(assertionRun.stdout)}`
  );
  assertCondition(requests[5]?.options?.enableAssertions === true, 'java adapter should preserve -ea in request options');

  const argfileRun = await workspace.runCommand('java @run.args');
  assertCondition(argfileRun.exitCode === 0, 'java adapter should expand runtime argfiles');
  assertCondition(
    argfileRun.stdout === 'source=run\nscript=Main\nargs=from-argfile\nfiles=app.jar,Helper.java,javac.args,Main.java,out/CompileMarker.txt,run.args\n',
    `java adapter should parse expanded runtime argfile request, received ${JSON.stringify(argfileRun.stdout)}`
  );
  assertCondition(requests[6]?.options?.classpath === '.', 'java adapter should pass argfile classpath through request options');

  const jarRun = await workspace.runCommand('java -Dtrace.mode=adapter -jar app.jar one two');
  assertCondition(jarRun.exitCode === 0, 'java adapter should accept -jar before program args');
  assertCondition(
    jarRun.stdout === 'source=run\nscript=app.jar\nargs=one,two\nfiles=app.jar,Helper.java,javac.args,Main.java,out/CompileMarker.txt,run.args\n',
    `java adapter should parse jar run request, received ${JSON.stringify(jarRun.stdout)}`
  );
  assertCondition(requests[7]?.options?.jarPath === 'app.jar', 'java adapter should pass jar path through request options');
  assertCondition(requests[7]?.options?.classpath === 'app.jar', 'java adapter should run jar as an explicit classpath resource');
  assertCondition(requests[7]?.options?.jarMainClass === 'app.Main', 'java adapter should read Main-Class from stored jar manifests');
  assertCondition(
    (requests[7]?.options?.systemProperties as Record<string, string> | undefined)?.['trace.mode'] === 'adapter',
    'java adapter should preserve -D options for jar execution'
  );
  assertCondition(requests.length === 8, 'java runner should be invoked for javac and java commands');
}

async function testJavaRunCommandGlobExpansion(): Promise<void> {
  const requests: JavaProjectCommandRequest[] = [];
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'data/a.txt', contents: 'a\n' },
      { path: 'data/b.txt', contents: 'b\n' },
      {
        path: 'jars/app.jar',
        contents: createStoredJarBase64([
          { path: 'META-INF/MANIFEST.MF', contents: 'Manifest-Version: 1.0\nMain-Class: app.Main\n\n' },
        ]),
        encoding: 'base64',
      },
    ],
    javaRunner: async (request) => {
      requests.push(request);
      return {
        stdout: [
          `script=${request.scriptPath}`,
          `args=${request.args.join(',')}`,
          `jarPath=${typeof request.options?.jarPath === 'string' ? request.options.jarPath : ''}`,
          `jarMain=${typeof request.options?.jarMainClass === 'string' ? request.options.jarMainClass : ''}`,
        ].join('\n') + '\n',
        stderr: '',
        exitCode: 0,
      };
    },
  });

  const classRun = await workspace.runCommand('java Main data/*.txt');
  assertCondition(classRun.exitCode === 0, `java program arg glob adapter should succeed: ${classRun.stderr}`);
  assertCondition(
    classRun.stdout === 'script=Main\nargs=data/a.txt,data/b.txt\njarPath=\njarMain=\n',
    `java adapter should expand program arg globs for class runs: ${classRun.stdout}`
  );

  const jarRun = await workspace.runCommand('java -jar jars/*.jar data/*.txt');
  assertCondition(jarRun.exitCode === 0, `java jar glob adapter should succeed: ${jarRun.stderr}`);
  assertCondition(
    jarRun.stdout === 'script=jars/app.jar\nargs=data/a.txt,data/b.txt\njarPath=jars/app.jar\njarMain=app.Main\n',
    `java adapter should expand jar path and program arg globs for jar runs: ${jarRun.stdout}`
  );

  assertCondition(requests.length === 2, 'java glob adapter should invoke runner for class and jar forms');
}

async function testCppCommandAdapter(): Promise<void> {
  const requests: CppProjectCommandRequest[] = [];
  const workspace = await createRuntimeWorkspace({
    entrypoint: 'main.cpp',
    files: [
      { path: 'main.cpp', contents: '#include "helper.hpp"\nint main() { return value(); }\n' },
      { path: 'helper.hpp', contents: 'int value();\n' },
      { path: 'data/a.txt', contents: 'a\n' },
      { path: 'data/b.txt', contents: 'b\n' },
      { path: 'bin/app.out', contents: Buffer.from('fake-binary').toString('base64'), encoding: 'base64' },
    ],
    cppRunner: async (request) => {
      requests.push(request);
      return {
        stdout: [
          `source=${request.source}`,
          `script=${request.scriptPath}`,
          `args=${request.args.join(',')}`,
          `files=${request.project.files.map((file) => file.path).join(',')}`,
        ].join('\n') + '\n',
        stderr: '',
        exitCode: 0,
        files: request.source === 'compile'
          ? [{ path: 'a.out', contents: Buffer.from('fake-binary').toString('base64'), encoding: 'base64' }]
          : [{ path: 'generated.txt', contents: 'created\n' }],
      };
    },
  });

  const compile = await workspace.runCommand('clang++ -std=c++17 main.cpp helper.cpp');
  assertCondition(compile.exitCode === 0, 'clang++ adapter should succeed');
  assertCondition(
    compile.stdout === 'source=compile\nscript=main.cpp\nargs=-std=c++17,main.cpp,helper.cpp\nfiles=bin/app.out,data/a.txt,data/b.txt,helper.hpp,main.cpp\n',
    `clang++ adapter should receive compile request, received ${JSON.stringify(compile.stdout)}`
  );
  assertCondition(requests[0]?.project.entrypoint === 'main.cpp', 'cpp runner should receive workspace entrypoint');
  assertCondition((await workspace.readFile('a.out', 'base64')).length > 0, 'clang++ adapter should apply generated executable');

  const verboseCompile = await workspace.runCommand('clang++ -v -std=c++17 main.cpp helper.cpp');
  assertCondition(verboseCompile.exitCode === 0, 'clang++ adapter should preserve -v as a compile flag when inputs are present');
  assertCondition(
    verboseCompile.stdout === 'source=compile\nscript=main.cpp\nargs=-v,-std=c++17,main.cpp,helper.cpp\nfiles=a.out,bin/app.out,data/a.txt,data/b.txt,helper.hpp,main.cpp\n',
    `clang++ adapter should not treat -v with inputs as version-only, received ${JSON.stringify(verboseCompile.stdout)}`
  );

  const gccCompile = await workspace.runCommand('gcc -std=c17 main.cpp -o c-app');
  assertCondition(gccCompile.exitCode === 0, 'gcc adapter should route through C++ project runner');
  assertCondition(
    gccCompile.stdout === 'source=compile\nscript=main.cpp\nargs=-std=c17,main.cpp,-o,c-app\nfiles=a.out,bin/app.out,data/a.txt,data/b.txt,helper.hpp,main.cpp\n',
    `gcc adapter should preserve compiler args, received ${JSON.stringify(gccCompile.stdout)}`
  );
  assertCondition(requests[2]?.options?.compilerCommand === 'gcc', 'gcc adapter should preserve requested compiler command');

  const ccCompile = await workspace.runCommand('cc -std=c17 main.cpp -o cc-app');
  assertCondition(ccCompile.exitCode === 0, 'cc adapter should route through C++ project runner');
  assertCondition(requests[3]?.options?.compilerCommand === 'cc', 'cc adapter should preserve requested compiler command');

  const namedCompile = await workspace.runCommand('clang++ -std=c++17 main.cpp helper.cpp -o app');
  assertCondition(namedCompile.exitCode === 0, 'clang++ adapter should compile named executable outputs');
  assertCondition(
    namedCompile.stdout === 'source=compile\nscript=main.cpp\nargs=-std=c++17,main.cpp,helper.cpp,-o,app\nfiles=a.out,bin/app.out,data/a.txt,data/b.txt,helper.hpp,main.cpp\n',
    `clang++ adapter should preserve named output args, received ${JSON.stringify(namedCompile.stdout)}`
  );

  const run = await workspace.runCommand('./a.out data/*.txt');
  assertCondition(run.exitCode === 0, './a.out adapter should succeed');
  assertCondition(
    run.stdout === 'source=run\nscript=a.out\nargs=data/a.txt,data/b.txt\nfiles=a.out,bin/app.out,data/a.txt,data/b.txt,helper.hpp,main.cpp\n',
    `./a.out adapter should receive executable request, received ${JSON.stringify(run.stdout)}`
  );
  assertCondition(await workspace.readFile('generated.txt') === 'created\n', './a.out adapter should apply generated files');

  const namedRun = await workspace.runCommand('./app gamma delta');
  assertCondition(namedRun.exitCode === 0, './app adapter should run named executable outputs');
  assertCondition(
    namedRun.stdout === 'source=run\nscript=app\nargs=gamma,delta\nfiles=a.out,bin/app.out,data/a.txt,data/b.txt,generated.txt,helper.hpp,main.cpp\n',
    `./app adapter should route named executable paths through the C++ runner, received ${JSON.stringify(namedRun.stdout)}`
  );

  const repeatedNamedRun = await workspace.runCommand('./app data/*.txt');
  assertCondition(repeatedNamedRun.exitCode === 0, './app adapter should keep named executable outputs runnable with glob args');
  assertCondition(
    repeatedNamedRun.stdout === 'source=run\nscript=app\nargs=data/a.txt,data/b.txt\nfiles=a.out,bin/app.out,data/a.txt,data/b.txt,generated.txt,helper.hpp,main.cpp\n',
    `./app adapter should expand argv globs on repeated named executable runs, received ${JSON.stringify(repeatedNamedRun.stdout)}`
  );

  const explicitCompile = await workspace.runCommand('clang++ -std=c++17 main.cpp helper.cpp -o bin/app.out');
  assertCondition(explicitCompile.exitCode === 0, 'clang++ adapter should compile executable outputs for direct path glob runs');
  const explicitRun = await workspace.runCommand('./bin/*.out data/*.txt');
  assertCondition(
    explicitRun.exitCode === 0,
    `virtual executable loader should expand executable and argv globs, received ${JSON.stringify(explicitRun)}`
  );
  assertCondition(
    explicitRun.stdout === 'source=run\nscript=bin/app.out\nargs=data/a.txt,data/b.txt\nfiles=a.out,bin/app.out,data/a.txt,data/b.txt,generated.txt,helper.hpp,main.cpp\n',
    `virtual executable loader should expand script and argv globs, received ${JSON.stringify(explicitRun.stdout)}`
  );
  assertCondition(requests.length === 10, 'cpp runner should be invoked for compile variants and direct executable runs');
}

async function testCppBareOutputRunsInFirstCompoundCommand(): Promise<void> {
  const requests: CppProjectCommandRequest[] = [];
  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'main.cpp', contents: 'int main() { return 0; }\n' }],
    cppRunner: async (request): Promise<RuntimeCommandResult> => {
      requests.push(request);
      if (request.source === 'compile') {
        const outputIndex = request.args.lastIndexOf('-o');
        const outputPath = outputIndex >= 0 ? request.args[outputIndex + 1] : 'a.out';
        assertCondition(outputPath, `C++ regression compile should include an output path: ${JSON.stringify(request)}`);
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          files: [{
            path: outputPath,
            contents: Buffer.from('first-run-executable').toString('base64'),
            encoding: 'base64',
          }],
        };
      }
      return {
        stdout: `ran:${request.scriptPath}:${request.args.join(',')}\n`,
        stderr: '',
        exitCode: 0,
      };
    },
  });

  assertCondition(!(await workspace.exists('project-bench')), 'Regression output must not exist before the compound command');
  const result = await workspace.runCommand('clang++ main.cpp -o project-bench && ./project-bench first-run');
  assertCondition(
    result.exitCode === 0 && result.stdout === 'ran:project-bench:first-run\n',
    `A bare -o output should be registered before its first ./ invocation in the same shell chain: ${JSON.stringify(result)}`
  );
  assertCondition(
    requests.length === 2 &&
      requests[0]?.source === 'compile' &&
      requests[1]?.source === 'run' &&
      requests[1]?.scriptPath === 'project-bench',
    `The first compound command should route compile then run through the C++ adapter: ${JSON.stringify(requests)}`
  );
  assertCondition(await workspace.exists('project-bench'), 'The compiler output should persist in the workspace');

  const requestCountBeforeBareInvocation = requests.length;
  const bareInvocation = await workspace.runCommand('project-bench should-not-use-cwd');
  assertCondition(
    bareInvocation.exitCode !== 0 && requests.length === requestCountBeforeBareInvocation,
    `Produced-output discovery must not change bare command PATH resolution: ${JSON.stringify(bareInvocation)}`
  );
  workspace.dispose();
}

async function testCSharpCommandAdapter(): Promise<void> {
  const requests: CSharpProjectCommandRequest[] = [];
  const workspace = await createRuntimeWorkspace({
    entrypoint: 'apps/App.csproj',
    files: [
      { path: 'Program.cs', contents: 'Console.WriteLine(Helper.Value());\n' },
      { path: 'Helper.cs', contents: 'static class Helper { public static int Value() => 42; }\n' },
      { path: 'apps/App.csproj', contents: '<Project Sdk="Microsoft.NET.Sdk" />\n' },
      { path: 'build/.keep', contents: '' },
      { path: 'data/a.txt', contents: 'a\n' },
      { path: 'data/b.txt', contents: 'b\n' },
    ],
    csharpRunner: async (request) => {
      requests.push(request);
      return {
        stdout: [
          `source=${request.source}`,
          `script=${request.scriptPath}`,
          `args=${request.args.join(',')}`,
          `buildArgs=${Array.isArray(request.options?.buildArgs) ? request.options.buildArgs.join(',') : ''}`,
          `files=${request.project.files.map((file) => file.path).join(',')}`,
        ].join('\n') + '\n',
        stderr: '',
        exitCode: 0,
        files: [{ path: 'generated.txt', contents: 'created\n' }],
      };
    },
  });

  const build = await workspace.runCommand('dotnet build');
  assertCondition(build.exitCode === 0, 'dotnet build adapter should succeed');
  assertCondition(
    build.stdout === 'source=compile\nscript=<project>\nargs=\nbuildArgs=\nfiles=apps/App.csproj,build/.keep,data/a.txt,data/b.txt,Helper.cs,Program.cs\n',
    `dotnet build adapter should receive compile request, received ${JSON.stringify(build.stdout)}`
  );
  assertCondition(requests[0]?.project.entrypoint === 'apps/App.csproj', 'csharp runner should receive workspace entrypoint');

  const separatedBuild = await workspace.runCommand('dotnet build apps/*.csproj --property DefineConstants=FROM_BUILD');
  assertCondition(separatedBuild.exitCode === 0, 'dotnet build adapter should normalize separated MSBuild properties');
  assertCondition(
    separatedBuild.stdout === 'source=compile\nscript=apps/App.csproj\nargs=--property:DefineConstants=FROM_BUILD\nbuildArgs=\nfiles=apps/App.csproj,build/.keep,data/a.txt,data/b.txt,generated.txt,Helper.cs,Program.cs\n',
    `dotnet build adapter should expand project globs and receive normalized separated property args, received ${JSON.stringify(separatedBuild.stdout)}`
  );

  const cwdRelativeBuild = await workspace.runCommand('dotnet build ../apps/App.csproj', { cwd: 'build' });
  assertCondition(cwdRelativeBuild.exitCode === 0, 'dotnet build adapter should preserve cwd-relative project paths');
  assertCondition(
    cwdRelativeBuild.stdout === 'source=compile\nscript=../apps/App.csproj\nargs=\nbuildArgs=\nfiles=apps/App.csproj,build/.keep,data/a.txt,data/b.txt,generated.txt,Helper.cs,Program.cs\n',
    `dotnet build adapter should send cwd-relative project paths to the runner, received ${JSON.stringify(cwdRelativeBuild.stdout)}`
  );

  const run = await workspace.runCommand('dotnet run -p DefineConstants=FROM_RUN -- data/*.txt');
  assertCondition(run.exitCode === 0, 'dotnet run adapter should succeed');
  assertCondition(
    run.stdout === 'source=run\nscript=<project>\nargs=data/a.txt,data/b.txt\nbuildArgs=-p:DefineConstants=FROM_RUN\nfiles=apps/App.csproj,build/.keep,data/a.txt,data/b.txt,generated.txt,Helper.cs,Program.cs\n',
    `dotnet run adapter should receive run request, received ${JSON.stringify(run.stdout)}`
  );

  const configuredRun = await workspace.runCommand('dotnet run --project apps/App.csproj --configuration Release --framework net10.0 --no-restore -- data/*.txt');
  assertCondition(configuredRun.exitCode === 0, 'dotnet run adapter should preserve build-affecting options');
  assertCondition(
    configuredRun.stdout === 'source=run\nscript=apps/App.csproj\nargs=data/a.txt,data/b.txt\nbuildArgs=--configuration,Release,--framework,net10.0,--no-restore\nfiles=apps/App.csproj,build/.keep,data/a.txt,data/b.txt,generated.txt,Helper.cs,Program.cs\n',
    `dotnet run adapter should pass build-affecting options separately from program args, received ${JSON.stringify(configuredRun.stdout)}`
  );

  const bareArgsRun = await workspace.runCommand('dotnet run --project apps/App.csproj alpha beta');
  assertCondition(bareArgsRun.exitCode === 0, 'dotnet run adapter should accept bare application args');
  assertCondition(
    bareArgsRun.stdout === 'source=run\nscript=apps/App.csproj\nargs=alpha,beta\nbuildArgs=\nfiles=apps/App.csproj,build/.keep,data/a.txt,data/b.txt,generated.txt,Helper.cs,Program.cs\n',
    `dotnet run adapter should pass bare non-option args as program args, received ${JSON.stringify(bareArgsRun.stdout)}`
  );

  const shortProjectRun = await workspace.runCommand('dotnet run -p apps/App.csproj gamma');
  assertCondition(shortProjectRun.exitCode === 0, 'dotnet run adapter should accept deprecated -p project shorthand');
  assertCondition(
    shortProjectRun.stdout === 'source=run\nscript=apps/App.csproj\nargs=gamma\nbuildArgs=\nfiles=apps/App.csproj,build/.keep,data/a.txt,data/b.txt,generated.txt,Helper.cs,Program.cs\n',
    `dotnet run adapter should map -p .csproj to project selection, received ${JSON.stringify(shortProjectRun.stdout)}`
  );

  const noBuildRun = await workspace.runCommand('dotnet run --no-build --project apps/App.csproj delta');
  assertCondition(noBuildRun.exitCode === 0, 'dotnet run adapter should preserve --no-build');
  assertCondition(
    noBuildRun.stdout === 'source=run\nscript=apps/App.csproj\nargs=delta\nbuildArgs=\nfiles=apps/App.csproj,build/.keep,data/a.txt,data/b.txt,generated.txt,Helper.cs,Program.cs\n',
    `dotnet run adapter should keep --no-build out of build args, received ${JSON.stringify(noBuildRun.stdout)}`
  );
  assertCondition(requests[7]?.options?.noBuild === true, 'dotnet run adapter should expose --no-build as a request option');

  const launchProfileRun = await workspace.runCommand('dotnet run --project apps/App.csproj --launch-profile MissingProfile --no-launch-profile epsilon');
  assertCondition(launchProfileRun.exitCode === 0, 'dotnet run adapter should consume launch profile options');
  assertCondition(
    launchProfileRun.stdout === 'source=run\nscript=apps/App.csproj\nargs=epsilon\nbuildArgs=\nfiles=apps/App.csproj,build/.keep,data/a.txt,data/b.txt,generated.txt,Helper.cs,Program.cs\n',
    `dotnet run adapter should not leak launch profile names into program args, received ${JSON.stringify(launchProfileRun.stdout)}`
  );
  assertCondition(await workspace.readFile('generated.txt') === 'created\n', 'dotnet adapter should apply runner file changes');
  assertCondition(requests.length === 9, 'csharp runner should be invoked for build variants and run variants');
}

async function testCompileCommandGlobExpansion(): Promise<void> {
  const javaRequests: JavaProjectCommandRequest[] = [];
  const cppRequests: CppProjectCommandRequest[] = [];
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'java/A.java', contents: 'class A {}\n' },
      { path: 'java/B.java', contents: 'class B {}\n' },
      { path: 'java/notes.txt', contents: 'ignore me\n' },
      { path: 'cpp/helper.cpp', contents: 'int helper() { return 1; }\n' },
      { path: 'cpp/main.cpp', contents: 'int helper(); int main() { return helper(); }\n' },
      { path: 'cpp/helper.hpp', contents: 'int helper();\n' },
    ],
    javaRunner: async (request) => {
      javaRequests.push(request);
      return { stdout: request.args.join(',') + '\n', stderr: '', exitCode: 0 };
    },
    cppRunner: async (request) => {
      cppRequests.push(request);
      return {
        stdout: request.args.join(',') + '\n',
        stderr: '',
        exitCode: 0,
        files: [{ path: 'cpp/app', contents: Buffer.from('fake-binary').toString('base64'), encoding: 'base64' }],
      };
    },
  });

  const javac = await workspace.runCommand('javac *.java', { cwd: 'java' });
  assertCondition(javac.exitCode === 0, `javac glob adapter should succeed: ${javac.stderr}`);
  assertCondition(
    javac.stdout === 'A.java,B.java\n',
    `javac adapter should expand cwd globs before invoking the runner: ${javac.stdout}`
  );
  assertCondition(javaRequests[0]?.scriptPath === 'A.java', 'javac adapter should use the first expanded source as scriptPath');

  const clang = await workspace.runCommand('clang++ cpp/*.cpp -o cpp/app');
  assertCondition(clang.exitCode === 0, `clang++ glob adapter should succeed: ${clang.stderr}`);
  assertCondition(
    clang.stdout === 'cpp/helper.cpp,cpp/main.cpp,-o,cpp/app\n',
    `clang++ adapter should expand workspace globs before invoking the runner: ${clang.stdout}`
  );
  assertCondition(cppRequests[0]?.scriptPath === 'cpp/helper.cpp', 'clang++ adapter should use the first expanded source as scriptPath');

  const unmatched = await workspace.runCommand('javac missing/*.java');
  assertCondition(unmatched.exitCode === 0, `unmatched javac glob should stay literal for runner diagnostics: ${unmatched.stderr}`);
  assertCondition(
    unmatched.stdout === 'missing/*.java\n',
    `unmatched javac globs should preserve bash-like literal behavior: ${unmatched.stdout}`
  );
}

async function testNativeCompileGlobProjectRunners(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'java/Helper.java', contents: 'class Helper { static int value() { return 42; } }\n' },
      { path: 'java/Main.java', contents: 'class Main { public static void main(String[] args) { System.out.println(Helper.value()); } }\n' },
      { path: 'cpp/helper.cpp', contents: 'int value() { return 43; }\n' },
      { path: 'cpp/main.cpp', contents: '#include <iostream>\nint value();\nint main() { std::cout << value() << "\\n"; }\n' },
    ],
    javaRunner: createNativeJavaProjectRunner(),
    cppRunner: createNativeCppProjectRunner({ timeoutMs: 30_000 }),
  });

  const javac = await workspace.runCommand('javac *.java', { cwd: 'java' });
  assertCondition(javac.exitCode === 0, `native javac glob compile should succeed: ${javac.stderr}`);
  const java = await workspace.runCommand('java Main', { cwd: 'java' });
  assertCondition(java.exitCode === 0, `native java glob-built class should run: ${java.stderr}`);
  assertCondition(java.stdout === '42\n', `native java glob-built class should link helpers: ${java.stdout}`);

  const clang = await workspace.runCommand('clang++ -std=c++17 *.cpp -o glob-app', { cwd: 'cpp' });
  assertCondition(clang.exitCode === 0, `native clang++ glob compile should succeed: ${clang.stderr}`);
  const cpp = await workspace.runCommand('./glob-app', { cwd: 'cpp' });
  assertCondition(cpp.exitCode === 0, `native C++ glob-built executable should run: ${cpp.stderr}`);
  assertCondition(cpp.stdout === '43\n', `native C++ glob-built executable should link helpers: ${cpp.stdout}`);
}

async function testNativePythonProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'helper.py', contents: 'def add(a, b):\n    return a + b\n' },
      { path: 'stale.txt', contents: 'delete me\n' },
      {
        path: 'main.py',
        contents: [
          'import sys',
          'from helper import add',
          'print(add(2, 3))',
          'print(",".join(sys.argv[1:]))',
          '',
        ].join('\n'),
      },
    ],
    pythonRunner: createNativePythonProjectRunner(),
  });

  const result = await workspace.runCommand('python3 main.py alpha beta');
  assertCondition(result.exitCode === 0, `native python should succeed: ${result.stderr}`);
  assertCondition(result.stdout === '5\nalpha,beta\n', `native python should execute project files: ${result.stdout}`);

  const codeResult = await workspace.runCommand('python3 -c "from helper import add; print(add(10, 7))"');
  assertCondition(codeResult.exitCode === 0, `native python -c should succeed: ${codeResult.stderr}`);
  assertCondition(codeResult.stdout === '17\n', `native python -c should import project files: ${codeResult.stdout}`);

  const evalArgvResult = await workspace.runCommand('python3 -c "import sys; print(sys.argv[0]); print(\\",\\".join(sys.argv[1:]))" alpha beta');
  assertCondition(evalArgvResult.exitCode === 0, `native python -c argv should succeed: ${evalArgvResult.stderr}`);
  assertCondition(
    evalArgvResult.stdout === '-c\nalpha,beta\n',
    `native python -c argv should match desktop semantics: ${evalArgvResult.stdout}`
  );

  const sideEffectResult = await workspace.runCommand([
    'python3',
    '-c',
      '"open(\\"generated.txt\\", \\"w\\").write(\\"created\\\\n\\"); open(\\"helper.py\\", \\"a\\").write(\\"# changed\\\\n\\"); open(\\"bytes.bin\\", \\"wb\\").write(bytes([0, 255]))"',
  ].join(' '));
  assertCondition(sideEffectResult.exitCode === 0, `native python file side effects should succeed: ${sideEffectResult.stderr}`);
  assertCondition(await workspace.readFile('generated.txt') === 'created\n', 'native python should persist generated text files');
  assertCondition((await workspace.readFile('helper.py')).endsWith('# changed\n'), 'native python should persist modified source files');
  assertCondition(
    (await workspace.readFile('bytes.bin', 'base64')) === Buffer.from([0, 255]).toString('base64'),
    'native python should persist generated binary files'
  );

  const deleteResult = await workspace.runCommand('python3 -c "import os; os.remove(\\"stale.txt\\")"');
  assertCondition(deleteResult.exitCode === 0, `native python file deletion should succeed: ${deleteResult.stderr}`);
  await assertRejectsAsync(() => workspace.readFile('stale.txt'), 'native python should persist deleted files');

  const timeoutEvents: RuntimeCommandEvent[] = [];
  const timeoutWorkspace = await createRuntimeWorkspace({
    pythonRunner: createNativePythonProjectRunner({ timeoutMs: 5 }),
  });
  const timeoutResult = await timeoutWorkspace.runCommand(
    'python3 -c "import time; time.sleep(0.025); print(\\"late\\")"',
    { onEvent: (event) => timeoutEvents.push(event) }
  );
  assertCondition(
    timeoutResult.exitCode === 124 && timeoutResult.stderr.includes('python3: execution timed out after 5ms'),
    `native Python timeout should return a timeout result: ${JSON.stringify(timeoutResult)}`
  );
  assertCondition(
    timeoutEvents.some((event) => event.type === 'status' && event.phase === 'process-start') &&
      timeoutEvents.some((event) => event.type === 'status' && event.phase === 'process-exit' && event.detail?.exitCode === 124) &&
      !timeoutEvents.some((event) => event.type === 'output' && event.data.includes('late')),
    `native Python timeout should emit terminal process status without late output: ${JSON.stringify(timeoutEvents)}`
  );
  const nativePythonTimeoutStderrIndex = timeoutEvents.findIndex(
    (event) => event.type === 'output' && event.stream === 'stderr' && event.data.includes('python3: execution timed out after 5ms')
  );
  const nativePythonTimeoutExitIndex = timeoutEvents.findIndex(
    (event) => event.type === 'status' && event.phase === 'process-exit' && event.detail?.exitCode === 124
  );
  assertCondition(
    nativePythonTimeoutStderrIndex >= 0 && nativePythonTimeoutExitIndex > nativePythonTimeoutStderrIndex,
    `native Python timeout should stream timeout stderr before process-exit: ${JSON.stringify(timeoutEvents)}`
  );
  timeoutWorkspace.dispose();

  const startErrorEvents: RuntimeCommandEvent[] = [];
  const startErrorWorkspace = await createRuntimeWorkspace({
    pythonRunner: createNativePythonProjectRunner({ pythonCommand: 'tracecode-missing-python-command' }),
  });
  const startErrorResult = await startErrorWorkspace.runCommand('python3 -c "print(1)"', {
    onEvent: (event) => startErrorEvents.push(event),
  });
  assertCondition(startErrorResult.exitCode === 1, `native Python start error should return failure: ${JSON.stringify(startErrorResult)}`);
  assertCondition(
    startErrorEvents.some((event) => event.type === 'status' && event.phase === 'process-start') &&
      startErrorEvents.some((event) => event.type === 'status' && event.phase === 'process-error' && event.detail?.command === 'tracecode-missing-python-command'),
    `native Python start error should emit process-error status: ${JSON.stringify(startErrorEvents)}`
  );
  const nativePythonStartErrorStderrIndex = startErrorEvents.findIndex(
    (event) => event.type === 'output' && event.stream === 'stderr' && event.data.includes('tracecode-missing-python-command')
  );
  const nativePythonStartErrorStatusIndex = startErrorEvents.findIndex(
    (event) => event.type === 'status' && event.phase === 'process-error' && event.detail?.command === 'tracecode-missing-python-command'
  );
  assertCondition(
    nativePythonStartErrorStderrIndex >= 0 && nativePythonStartErrorStatusIndex > nativePythonStartErrorStderrIndex,
    `native Python start error should stream stderr before process-error: ${JSON.stringify(startErrorEvents)}`
  );
  startErrorWorkspace.dispose();
}

async function testNativeNestedPythonProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'src/helper.py', contents: 'def add(a, b):\n    return a + b\n' },
      { path: 'src/main.py', contents: 'from helper import add\nprint(add(2, 3))\n' },
    ],
    pythonRunner: createNativePythonProjectRunner(),
  });

  const result = await workspace.runCommand('python3 src/main.py');
  assertCondition(result.exitCode === 0, `native nested python should succeed: ${result.stderr}`);
  assertCondition(result.stdout === '5\n', `native nested python should import beside script: ${result.stdout}`);
}

async function testNativePythonModuleProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'app/__init__.py', contents: '' },
      { path: 'app/mathlib.py', contents: 'def add(a, b):\n    return a + b\n' },
      {
        path: 'app/main.py',
        contents: [
          'import sys',
          'from .mathlib import add',
          'print(add(2, 3))',
          'print(__package__)',
          'print(",".join(sys.argv[1:]))',
          '',
        ].join('\n'),
      },
      { path: 'app/argv.py', contents: 'import sys\nprint(sys.argv[0])\nprint(",".join(sys.argv[1:]))\n' },
    ],
    pythonRunner: createNativePythonProjectRunner(),
  });

  const result = await workspace.runCommand('python3 -B -u -P --check-hash-based-pycs default -X utf8 -m app.main alpha beta');
  assertCondition(result.exitCode === 0, `native python -m package should succeed: ${result.stderr}`);
  assertCondition(result.stdout === '5\napp\nalpha,beta\n', `native python -m package should preserve package context: ${result.stdout}`);

  const argvResult = await workspace.runCommand('python3 -m app.argv gamma');
  assertCondition(argvResult.exitCode === 0, `native python -m argv should succeed: ${argvResult.stderr}`);
  assertCondition(
    argvResult.stdout.split('\n')[0].endsWith('/app/argv.py'),
    `native python -m argv[0] should resolve to module file path: ${argvResult.stdout}`
  );
  assertCondition(
    argvResult.stdout.endsWith('gamma\n'),
    `native python -m argv should preserve module args: ${argvResult.stdout}`
  );

  const longModuleResult = await workspace.runCommand('python3 --module app.main delta');
  assertCondition(longModuleResult.exitCode === 0, `native python --module package should succeed: ${longModuleResult.stderr}`);
  assertCondition(
    longModuleResult.stdout === '5\napp\ndelta\n',
    `native python --module should match -m package execution: ${longModuleResult.stdout}`
  );
}

async function testNativePythonPathProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    env: { PYTHONPATH: 'vendor' },
    files: [
      { path: 'build/.keep', contents: '' },
      { path: 'vendor/pkgtools.py', contents: 'def value():\n    return 42\n' },
      {
        path: 'main.py',
        contents: [
          'import os',
          'from pkgtools import value',
          'print(value())',
          'print(os.environ.get("MODE"))',
          '',
        ].join('\n'),
      },
    ],
    pythonRunner: createNativePythonProjectRunner(),
  });

  const result = await workspace.runCommand('python3 main.py', { env: { MODE: 'project' } });
  assertCondition(result.exitCode === 0, `native python PYTHONPATH should succeed: ${result.stderr}`);
  assertCondition(result.stdout === '42\nproject\n', `native python should honor workspace PYTHONPATH and env: ${result.stdout}`);

  const absolutePathResult = await workspace.runCommand('python3 -c "from pkgtools import value; print(value())"', {
    env: { PYTHONPATH: '/workspace/vendor' },
  });
  assertCondition(absolutePathResult.exitCode === 0, `native python should map absolute /workspace PYTHONPATH entries: ${absolutePathResult.stderr}`);
  assertCondition(
    absolutePathResult.stdout === '42\n',
    `native python should import modules from absolute /workspace PYTHONPATH entries: ${absolutePathResult.stdout}`
  );

  const cwdRelativePathResult = await workspace.runCommand('python3 -c "from pkgtools import value; print(value())"', {
    cwd: 'build',
    env: { PYTHONPATH: '../vendor' },
  });
  assertCondition(cwdRelativePathResult.exitCode === 0, `native python should resolve cwd-relative PYTHONPATH entries: ${cwdRelativePathResult.stderr}`);
  assertCondition(
    cwdRelativePathResult.stdout === '42\n',
    `native python should import modules from cwd-relative PYTHONPATH entries: ${cwdRelativePathResult.stdout}`
  );

  const outsidePathResult = await workspace.runCommand('python3 -c "print(1)"', {
    env: { PYTHONPATH: '/outside/vendor' },
  });
  assertCondition(
    outsidePathResult.exitCode !== 0 && outsidePathResult.stderr.includes('Project path must stay inside the workspace'),
    `native python should reject PYTHONPATH entries outside the workspace: ${outsidePathResult.stderr}`
  );

  const relativeOutsidePathResult = await workspace.runCommand('python3 -c "print(1)"', {
    env: { PYTHONPATH: '../outside/vendor' },
  });
  assertCondition(
    relativeOutsidePathResult.exitCode !== 0 && relativeOutsidePathResult.stderr.includes('Project path must stay inside the workspace'),
    `native python should reject cwd-relative PYTHONPATH entries outside the workspace: ${relativeOutsidePathResult.stderr}`
  );
}

async function testNativePythonProjectRunnerCwd(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'build/.keep', contents: '' },
      { path: 'src/helper.py', contents: 'def value():\n    return 31\n' },
      {
        path: 'src/main.py',
        contents: [
          'import os',
          'from helper import value',
          'print(os.getcwd().endswith("/src"))',
          'print(value())',
          'open("generated.txt", "w").write("created\\n")',
          '',
        ].join('\n'),
      },
    ],
    pythonRunner: createNativePythonProjectRunner(),
  });

  const result = await workspace.runCommand('python3 main.py', { cwd: 'src' });
  assertCondition(result.exitCode === 0, `native python cwd should succeed: ${result.stderr}`);
  assertCondition(result.stdout === 'True\n31\n', `native python cwd should run from requested directory: ${result.stdout}`);
  assertCondition(await workspace.readFile('src/generated.txt') === 'created\n', 'native python cwd side effects should be workspace-relative');

  const parentRelativeResult = await workspace.runCommand('python3 ../src/main.py', { cwd: 'build' });
  assertCondition(parentRelativeResult.exitCode === 0, `native python should resolve cwd-relative parent script paths: ${parentRelativeResult.stderr}`);
  assertCondition(
    parentRelativeResult.stdout === 'False\n31\n',
    `native python should execute cwd-relative parent script paths with desktop cwd semantics: ${parentRelativeResult.stdout}`
  );
  assertCondition(await workspace.readFile('build/generated.txt') === 'created\n', 'native python cwd-relative script side effects should stay under cwd');
}

async function testNativePythonProjectRunnerStdin(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'src/helper.py', contents: 'def value():\n    return 41\n' },
    ],
    pythonRunner: createNativePythonProjectRunner(),
  });

  const result = await workspace.runCommand(
    [
      'printf',
      "'import os\\nfrom helper import value\\nprint(os.getcwd().endswith(\"/src\"))\\nprint(value())\\nopen(\"generated.txt\", \"w\").write(\"created\\\\n\")\\n'",
      '|',
      'python3 -',
    ].join(' '),
    { cwd: 'src' }
  );
  assertCondition(result.exitCode === 0, `native python stdin should succeed: ${result.stderr}`);
  assertCondition(result.stdout === 'True\n41\n', `native python stdin should execute from requested cwd: ${result.stdout}`);
  assertCondition(await workspace.readFile('src/generated.txt') === 'created\n', 'native python stdin side effects should be workspace-relative');

  const argvResult = await workspace.runCommand(
    'printf \'import sys; print(sys.argv[0]); print(",".join(sys.argv[1:]))\\n\' | python3 - alpha beta'
  );
  assertCondition(argvResult.exitCode === 0, `native python stdin argv should succeed: ${argvResult.stderr}`);
  assertCondition(
    argvResult.stdout === '-\nalpha,beta\n',
    `native python stdin argv should match desktop semantics: ${argvResult.stdout}`
  );
}

async function testNativePythonProjectRunnerAbsoluteWorkspacePaths(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'src/helper.py', contents: 'def value():\n    return 53\n' },
      {
        path: 'src/main.py',
        contents: [
          'import os',
          'print(os.getcwd())',
          'print(open("/workspace/src/helper.py").read().split()[-1])',
          'open("/workspace/src/absolute.txt", "w").write("absolute\\n")',
          'os.remove("/workspace/src/stale.txt")',
          '',
        ].join('\n'),
      },
      { path: 'src/stale.txt', contents: 'delete me\n' },
    ],
    pythonRunner: createNativePythonProjectRunner(),
  });

  const result = await workspace.runCommand('python3 main.py', { cwd: 'src' });
  assertCondition(result.exitCode === 0, `native python absolute workspace paths should succeed: ${result.stderr}`);
  assertCondition(result.stdout === '/workspace/src\n53\n', `native python should expose virtual workspace cwd and files: ${result.stdout}`);
  assertCondition(await workspace.readFile('src/absolute.txt') === 'absolute\n', 'native python should persist absolute /workspace writes');
  await assertRejectsAsync(() => workspace.readFile('src/stale.txt'), 'native python should persist absolute /workspace deletes');
}

async function testNativePythonProjectRunnerDirectAbsoluteScriptPath(): Promise<void> {
  const runner = createNativePythonProjectRunner();
  const result = await runner({
    code: '',
    source: 'file',
    scriptPath: '/workspace/src/main.py',
    args: ['alpha'],
    cwd: '/workspace',
    env: {},
    stdinPipe: stdinPipe('from-tty\n'),
    project: {
      cwd: '/workspace',
      files: [
        { path: 'src/helper.py', contents: 'def value():\n    return 67\n' },
        {
          path: 'src/main.py',
          contents: 'from helper import value\nimport sys\nprint(value())\nprint(",".join(sys.argv[1:]))\n',
        },
      ],
    },
  });

  assertCondition(result.exitCode === 0, `native python direct absolute scriptPath should succeed: ${result.stderr}`);
  assertCondition(
    result.stdout === '67\nalpha\n',
    `native python direct runner should accept /workspace scriptPath: ${result.stdout}`
  );
  await assertRejectsAsync(
    () => runner({
      code: '',
      source: 'file',
      scriptPath: '/outside/main.py',
      args: [],
      cwd: '/workspace',
      env: {},
      project: { cwd: '/workspace', files: [{ path: 'main.py', contents: 'print("bad")\n' }] },
    }),
    'native python direct runner should reject absolute scriptPath outside the workspace'
  );
  await assertRejectsAsync(
    () => runner({
      code: '',
      source: 'file',
      scriptPath: 'main.py',
      args: [],
      cwd: '/outside',
      env: {},
      project: { cwd: '/workspace', files: [{ path: 'main.py', contents: 'print("bad")\n' }] },
    }),
    'native python direct runner should reject cwd outside the workspace'
  );
}

async function testNativeJavaScriptProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'lib/math.js', contents: 'exports.add = (a, b) => a + b;\n' },
      { path: 'stale.txt', contents: 'delete me\n' },
      { path: 'node_modules/adder/package.json', contents: '{"main":"src/main.js"}\n' },
      { path: 'node_modules/adder/src/main.js', contents: 'module.exports = { add: (a, b) => a + b + 100 };\n' },
      { path: 'node_modules/esadder/package.json', contents: '{"type":"module","exports":{"import":"./src/index.js","require":"./src/index.js"}}\n' },
      { path: 'node_modules/esadder/src/index.js', contents: 'export function add(a, b) { return a + b + 200; }\n' },
      { path: 'node_modules/condpkg/package.json', contents: '{"exports":{"import":"./esm.mjs","require":"./cjs.cjs"}}\n' },
      { path: 'node_modules/condpkg/cjs.cjs', contents: 'exports.value = "require-branch";\n' },
      { path: 'node_modules/condpkg/esm.mjs', contents: 'export const value = "import-branch";\n' },
      { path: 'node_modules/subadder/package.json', contents: '{"type":"module","exports":{"./feature":{"import":"./src/feature.js","require":"./src/feature.js"}}}\n' },
      { path: 'node_modules/subadder/src/feature.js', contents: 'export function add(a, b) { return a + b + 400; }\n' },
      { path: 'node_modules/modadder/package.json', contents: '{"type":"module","module":"src/module.js"}\n' },
      { path: 'node_modules/modadder/src/module.js', contents: 'export const add = (a, b) => a + b + 300;\n' },
      { path: 'vendor/envpkg.js', contents: 'exports.value = 515;\n' },
      { path: 'preload.js', contents: 'const fs = require("node:fs"); globalThis.tracecodePreload = "native-preload"; fs.writeFileSync("preload.txt", "loaded\\n");\n' },
      { path: 'appdir/package.json', contents: '{"main":"src/cli.js"}\n' },
      { path: 'appdir/src/cli.js', contents: 'console.log("appdir:" + process.argv.slice(2).join(","));\n' },
      { path: 'indexdir/index.js', contents: 'console.log("indexdir:" + process.argv.slice(2).join(","));\n' },
      { path: 'node_modules/cliadder/package.json', contents: '{"main":"src/cli.js"}\n' },
      { path: 'node_modules/cliadder/src/cli.js', contents: 'console.log("cliadder:" + process.argv.slice(2).join(","));\n' },
      { path: 'node_modules/localpkg/index.js', contents: 'exports.value = "root-local";\n' },
      { path: 'src/node_modules/localpkg/index.js', contents: 'exports.value = "nested-local";\n' },
      { path: 'node_modules/exportedpkg/package.json', contents: '{"exports":{"./feature":{"require":"./root-feature.js"}}}\n' },
      { path: 'node_modules/exportedpkg/root-feature.js', contents: 'exports.value = "root-export";\n' },
      { path: 'src/node_modules/exportedpkg/package.json', contents: '{"exports":{"./feature":{"require":"./nested-feature.js"}}}\n' },
      { path: 'src/node_modules/exportedpkg/nested-feature.js', contents: 'exports.value = "nested-export";\n' },
      { path: 'src/app/index.js', contents: 'console.log(require("localpkg").value);\nconsole.log(require("exportedpkg/feature").value);\n' },
      {
        path: 'index.js',
        contents: [
          'const { add } = require("./lib/math");',
          'console.log(add(2, 3));',
          'console.log(process.argv.slice(2).join(","));',
          '',
        ].join('\n'),
      },
    ],
    nodeRunner: createNativeJavaScriptProjectRunner(),
  });

  const result = await workspace.runCommand('node index.js alpha beta');
  assertCondition(result.exitCode === 0, `native node should succeed: ${result.stderr}`);
  assertCondition(result.stdout === '5\nalpha,beta\n', `native node should execute project files: ${result.stdout}`);

  const codeResult = await workspace.runCommand('node -e "const { add } = require(\\"./lib/math\\"); console.log(add(10, 7))"');
  assertCondition(codeResult.exitCode === 0, `native node -e should succeed: ${codeResult.stderr}`);
  assertCondition(codeResult.stdout === '17\n', `native node -e should import project files: ${codeResult.stdout}`);

  const evalArgvResult = await workspace.runCommand('node -e "console.log(process.argv.slice(1).join(\\"\\,\\"))" alpha beta');
  assertCondition(evalArgvResult.exitCode === 0, `native node -e argv should succeed: ${evalArgvResult.stderr}`);
  assertCondition(evalArgvResult.stdout === 'alpha,beta\n', `native node -e argv should match desktop semantics: ${evalArgvResult.stdout}`);

  const moduleEvalResult = await workspace.runCommand('node --no-warnings --trace-warnings --input-type=module -e "const { add } = await import(\\"./lib/math.js\\"); console.log(add(10, 7))"');
  assertCondition(moduleEvalResult.exitCode === 0, `native node --input-type=module -e should succeed: ${moduleEvalResult.stderr}`);
  assertCondition(moduleEvalResult.stdout === '17\n', `native node --input-type=module should run eval as ESM: ${moduleEvalResult.stdout}`);

  const printResult = await workspace.runCommand('node -p "require(\\"./lib/math\\").add(3, 4)"');
  assertCondition(printResult.exitCode === 0, `native node -p should succeed: ${printResult.stderr}`);
  assertCondition(printResult.stdout === '7\n', `native node -p should print evaluated project expressions: ${printResult.stdout}`);

  const rootRequireResult = await workspace.runCommand('node -e "const { add } = require(\\"lib/math\\"); console.log(add(1, 4))"');
  assertCondition(rootRequireResult.exitCode === 0, `native node root require should succeed: ${rootRequireResult.stderr}`);
  assertCondition(rootRequireResult.stdout === '5\n', `native node root require should resolve from workspace root: ${rootRequireResult.stdout}`);

  const packageResult = await workspace.runCommand('node -e "const { add } = require(\\"adder\\"); console.log(add(1, 4))"');
  assertCondition(packageResult.exitCode === 0, `native node package require should succeed: ${packageResult.stderr}`);
  assertCondition(packageResult.stdout === '105\n', `native node package require should resolve package main: ${packageResult.stdout}`);

  const requireResolveResult = await workspace.runCommand([
    'node',
    '-e',
    '"console.log(require.resolve(\\"./lib/math\\").endsWith(\\"/lib/math.js\\")); console.log(require.resolve(\\"adder\\").endsWith(\\"/node_modules/adder/src/main.js\\")); console.log(require.resolve(\\"node:fs\\")); console.log(require.resolve(\\"fs\\"));"',
  ].join(' '));
  assertCondition(requireResolveResult.exitCode === 0, `native node require.resolve should succeed: ${requireResolveResult.stderr}`);
  assertCondition(
    requireResolveResult.stdout === 'true\ntrue\nnode:fs\nfs\n',
    `native node require.resolve should resolve files, packages, and builtins: ${requireResolveResult.stdout}`
  );

  const esmPackageResult = await workspace.runCommand('node -e "import(\\"esadder\\").then(({ add }) => console.log(add(1, 4)))"');
  assertCondition(esmPackageResult.exitCode === 0, `native node package ESM import should succeed: ${esmPackageResult.stderr}`);
  assertCondition(esmPackageResult.stdout === '205\n', `native node package ESM import should resolve package exports: ${esmPackageResult.stdout}`);

  const conditionalRequireResult = await workspace.runCommand('node -e "console.log(require(\\"condpkg\\").value)"');
  assertCondition(conditionalRequireResult.exitCode === 0, `native node conditional exports require should succeed: ${conditionalRequireResult.stderr}`);
  assertCondition(
    conditionalRequireResult.stdout === 'require-branch\n',
    `native node require should use require export condition: ${conditionalRequireResult.stdout}`
  );

  const conditionalImportResult = await workspace.runCommand('node -e "import(\\"condpkg\\").then(({ value }) => console.log(value))"');
  assertCondition(conditionalImportResult.exitCode === 0, `native node conditional exports import should succeed: ${conditionalImportResult.stderr}`);
  assertCondition(
    conditionalImportResult.stdout === 'import-branch\n',
    `native node import should use import export condition: ${conditionalImportResult.stdout}`
  );

  const subpathExportResult = await workspace.runCommand('node -e "import(\\"subadder/feature\\").then(({ add }) => console.log(add(1, 4)))"');
  assertCondition(subpathExportResult.exitCode === 0, `native node package subpath export import should succeed: ${subpathExportResult.stderr}`);
  assertCondition(subpathExportResult.stdout === '405\n', `native node package subpath export should resolve through package exports: ${subpathExportResult.stdout}`);

  const directoryMainResult = await workspace.runCommand('node appdir alpha beta');
  assertCondition(directoryMainResult.exitCode === 0, `native node directory main should succeed: ${directoryMainResult.stderr}`);
  assertCondition(directoryMainResult.stdout === 'appdir:alpha,beta\n', `native node directory main should resolve package entrypoint: ${directoryMainResult.stdout}`);

  const directoryIndexResult = await workspace.runCommand('node indexdir gamma');
  assertCondition(directoryIndexResult.exitCode === 0, `native node directory index should succeed: ${directoryIndexResult.stderr}`);
  assertCondition(directoryIndexResult.stdout === 'indexdir:gamma\n', `native node directory index should resolve index.js: ${directoryIndexResult.stdout}`);

  const nodeModulesDirectoryResult = await workspace.runCommand('node node_modules/cliadder delta');
  assertCondition(nodeModulesDirectoryResult.exitCode === 0, `native node node_modules directory main should succeed: ${nodeModulesDirectoryResult.stderr}`);
  assertCondition(nodeModulesDirectoryResult.stdout === 'cliadder:delta\n', `native node node_modules directory should resolve package entrypoint: ${nodeModulesDirectoryResult.stdout}`);

  const nestedNodeModulesResult = await workspace.runCommand('node app/index.js', { cwd: 'src' });
  assertCondition(nestedNodeModulesResult.exitCode === 0, `native node nested node_modules should succeed: ${nestedNodeModulesResult.stderr}`);
  assertCondition(
    nestedNodeModulesResult.stdout === 'nested-local\nnested-export\n',
    `native node should prefer nearest parent node_modules packages and exports: ${nestedNodeModulesResult.stdout}`
  );

  const nodePathResult = await workspace.runCommand('node -e "console.log(require(\\"envpkg\\").value)"', {
    env: { NODE_PATH: '/workspace/vendor' },
  });
  assertCondition(nodePathResult.exitCode === 0, `native node NODE_PATH should resolve workspace modules: ${nodePathResult.stderr}`);
  assertCondition(nodePathResult.stdout === '515\n', `native node NODE_PATH should import from /workspace entries: ${nodePathResult.stdout}`);

  const preloadResult = await workspace.runCommand('node --require /workspace/preload.js -e "console.log(globalThis.tracecodePreload)"');
  assertCondition(preloadResult.exitCode === 0, `native node --require should preload workspace files: ${preloadResult.stderr}`);
  assertCondition(preloadResult.stdout === 'native-preload\n', `native node --require should run before eval: ${preloadResult.stdout}`);
  assertCondition(await workspace.readFile('preload.txt') === 'loaded\n', 'native node --require side effects should persist');

  const processExitResult = await workspace.runCommand('node -e "console.log(\\"before-exit\\"); process.exit(7); console.log(\\"after-exit\\")"');
  assertCondition(processExitResult.exitCode === 7, `native node process.exit should return the requested exit code: ${processExitResult.exitCode}`);
  assertCondition(processExitResult.stdout === 'before-exit\n', `native node process.exit should preserve stdout before exit: ${processExitResult.stdout}`);
  assertCondition(processExitResult.stderr === '', `native node process.exit should not print an internal error: ${processExitResult.stderr}`);

  const outsideNodePathResult = await workspace.runCommand('node -e "console.log(1)"', {
    env: { NODE_PATH: '/outside/vendor' },
  });
  assertCondition(
    outsideNodePathResult.exitCode !== 0 && outsideNodePathResult.stderr.includes('Project path must stay inside the workspace'),
    `native node should reject NODE_PATH entries outside the workspace: ${outsideNodePathResult.stderr}`
  );

  const sideEffectResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"fs\\"); fs.writeFileSync(\\"generated.txt\\", \\"created\\\\n\\"); fs.appendFileSync(\\"lib/math.js\\", \\"// changed\\\\n\\"); fs.writeFileSync(\\"bytes.bin\\", new Uint8Array([0, 255]));"',
  ].join(' '));
  assertCondition(sideEffectResult.exitCode === 0, `native node file side effects should succeed: ${sideEffectResult.stderr}`);
  assertCondition(await workspace.readFile('generated.txt') === 'created\n', 'native node should persist generated text files');
  assertCondition((await workspace.readFile('lib/math.js')).endsWith('// changed\n'), 'native node should persist modified source files');
  assertCondition(
    (await workspace.readFile('bytes.bin', 'base64')) === Buffer.from([0, 255]).toString('base64'),
    'native node should persist generated binary files'
  );

  const deleteResult = await workspace.runCommand('node -e "require(\\"fs\\").unlinkSync(\\"stale.txt\\")"');
  assertCondition(deleteResult.exitCode === 0, `native node file deletion should succeed: ${deleteResult.stderr}`);
  await assertRejectsAsync(() => workspace.readFile('stale.txt'), 'native node should persist deleted files');

  const copyRenameResult = await workspace.runCommand([
    'node',
    '-e',
    '"(async () => { const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); fs.writeFileSync(\\"copy-source.txt\\", \\"copy-sync\\\\n\\"); fs.copyFileSync(\\"copy-source.txt\\", \\"copy-target.txt\\"); fs.renameSync(\\"copy-target.txt\\", \\"renamed-target.txt\\"); await fsp.writeFile(\\"async-copy-source.txt\\", \\"copy-async\\\\n\\"); await fsp.copyFile(\\"async-copy-source.txt\\", \\"async-copy-target.txt\\"); await fsp.rename(\\"async-copy-target.txt\\", \\"async-renamed-target.txt\\"); })();"',
  ].join(' '));
  assertCondition(copyRenameResult.exitCode === 0, `native node copy/rename workflow should succeed: ${copyRenameResult.stderr}`);
  assertCondition(await workspace.readFile('renamed-target.txt') === 'copy-sync\n', 'native node should persist copyFileSync/renameSync results');
  assertCondition(await workspace.readFile('async-renamed-target.txt') === 'copy-async\n', 'native node should persist fs.promises copyFile/rename results');
  await assertRejectsAsync(() => workspace.readFile('copy-target.txt'), 'native node renameSync should remove the old target path');
  await assertRejectsAsync(() => workspace.readFile('async-copy-target.txt'), 'native node async rename should remove the old target path');

  const zlibResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const zlib = require(\\"node:zlib\\"); const gz = zlib.gzipSync(\\"hello project\\"); console.log(Buffer.isBuffer(gz)); console.log(zlib.gunzipSync(gz).toString()); const deflated = zlib.deflateSync(Buffer.from(\\"raw\\")); console.log(zlib.inflateSync(deflated).toString()); fs.writeFileSync(\\"compressed.gz\\", gz);"',
  ].join(' '));
  assertCondition(zlibResult.exitCode === 0, `native node zlib should succeed: ${zlibResult.stderr}`);
  assertCondition(zlibResult.stdout === 'true\nhello project\nraw\n', `native node zlib should match desktop sync APIs: ${zlibResult.stdout}`);
  assertCondition((await workspace.readFile('compressed.gz', 'base64')).length > 0, 'native node zlib output should persist binary files');

  const encodedReadResult = await workspace.runCommand([
    'node',
    '-e',
    '"(async () => { const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); fs.writeFileSync(\\"encoded.bin\\", Buffer.from([0, 255, 65])); console.log(typeof fs.readFileSync(\\"encoded.bin\\", \\"base64\\")); console.log(fs.readFileSync(\\"encoded.bin\\", \\"base64\\")); console.log(typeof fs.readFileSync(\\"encoded.bin\\", { encoding: \\"hex\\" })); console.log(fs.readFileSync(\\"encoded.bin\\", { encoding: \\"hex\\" })); console.log(typeof await fsp.readFile(\\"encoded.bin\\", \\"base64\\")); console.log(await fsp.readFile(\\"encoded.bin\\", \\"base64\\")); })();"',
  ].join(' '));
  assertCondition(encodedReadResult.exitCode === 0, `native node encoded reads should succeed: ${encodedReadResult.stderr}`);
  assertCondition(
    encodedReadResult.stdout === 'string\nAP9B\nstring\n00ff41\nstring\nAP9B\n',
    `native node encoded reads should return strings: ${encodedReadResult.stdout}`
  );

  const encodedWriteResult = await workspace.runCommand([
    'node',
    '-e',
    '"(async () => { const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); fs.writeFileSync(\\"encoded-write.bin\\", \\"AP9B\\", \\"base64\\"); fs.appendFileSync(\\"encoded-write.bin\\", \\"42\\", { encoding: \\"hex\\" }); await fsp.writeFile(\\"async-encoded-write.bin\\", \\"AP9B\\", \\"base64\\"); await fsp.appendFile(\\"async-encoded-write.bin\\", \\"42\\", { encoding: \\"hex\\" }); console.log(fs.readFileSync(\\"encoded-write.bin\\").toString(\\"hex\\")); console.log(fs.readFileSync(\\"async-encoded-write.bin\\").toString(\\"hex\\")); })();"',
  ].join(' '));
  assertCondition(encodedWriteResult.exitCode === 0, `native node encoded writes should succeed: ${encodedWriteResult.stderr}`);
  assertCondition(
    encodedWriteResult.stdout === '00ff4142\n00ff4142\n',
    `native node encoded writes should decode strings before writing: ${encodedWriteResult.stdout}`
  );

  const directoryResult = await workspace.runCommand([
    'node',
    '--input-type=module',
    '-e',
    '"const fsMod = await import(\\"node:fs\\"); const fs = fsMod.default ?? fsMod; const fsp = await import(\\"node:fs/promises\\"); fs.mkdirSync(\\"empty/nested\\", { recursive: true }); console.log(fs.statSync(\\"empty\\").isDirectory()); console.log(fs.readdirSync(\\"empty\\").join(\\"\\,\\")); console.log(fs.readdirSync(\\"empty/nested\\").join(\\"\\,\\")); fs.rmdirSync(\\"empty/nested\\"); console.log(fs.existsSync(\\"empty/nested\\")); await fsp.mkdir(\\"async-empty/nested\\", { recursive: true }); console.log((await fsp.stat(\\"async-empty\\")).isDirectory()); console.log((await fsp.readdir(\\"async-empty\\")).join(\\"\\,\\")); await fsp.rm(\\"async-empty\\", { recursive: true }); console.log(fs.existsSync(\\"async-empty\\")); fs.rmSync(\\"empty\\", { recursive: true }); console.log(fs.existsSync(\\"empty\\"));"',
  ].join(' '));
  assertCondition(directoryResult.exitCode === 0, `native node empty directory workflow should succeed: ${directoryResult.stderr}`);
  assertCondition(
    directoryResult.stdout === 'true\nnested\n\nfalse\ntrue\nnested\nfalse\nfalse\n',
    `native node empty directory workflow should match desktop semantics: ${directoryResult.stdout}`
  );

  const direntResult = await workspace.runCommand([
    'node',
    '-e',
    '"(async () => { const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); fs.mkdirSync(\\"dirent/sub\\", { recursive: true }); fs.writeFileSync(\\"dirent/file.txt\\", \\"x\\"); const label = (entry) => entry.name + \\":\\" + entry.isFile() + \\":\\" + entry.isDirectory() + \\":\\" + entry.isSymbolicLink() + \\":\\" + entry.isBlockDevice() + \\":\\" + entry.isCharacterDevice() + \\":\\" + entry.isFIFO() + \\":\\" + entry.isSocket(); const syncEntries = fs.readdirSync(\\"dirent\\", { withFileTypes: true }).map(label).sort(); console.log(syncEntries.join(\\"|\\")); const asyncEntries = (await fsp.readdir(\\"dirent\\", { withFileTypes: true })).map(label).sort(); console.log(asyncEntries.join(\\"|\\")); })();"',
  ].join(' '));
  assertCondition(direntResult.exitCode === 0, `native node readdir Dirent workflow should succeed: ${direntResult.stderr}`);
  assertCondition(
    direntResult.stdout === 'file.txt:true:false:false:false:false:false:false|sub:false:true:false:false:false:false:false\nfile.txt:true:false:false:false:false:false:false|sub:false:true:false:false:false:false:false\n',
    `native node readdir withFileTypes should return Dirent-like entries: ${direntResult.stdout}`
  );

  const pathResult = await workspace.runCommand([
    'node',
    '-e',
    '"const path = require(\\"node:path\\"); console.log(path.normalize(\\"/workspace/src/../lib/file.js\\")); console.log(path.normalize(\\"src/../lib/file.js\\")); console.log(path.dirname(\\"/workspace/src/index.js\\")); console.log(path.basename(\\"/workspace/src/index.test.js\\", \\".js\\")); console.log(path.extname(\\"/workspace/src/index.test.js\\")); console.log(path.isAbsolute(\\"/workspace/src/index.js\\")); console.log(path.relative(\\"/workspace/src/app\\", \\"/workspace/src/lib/helper.js\\")); console.log(path.resolve(\\"/workspace/src/app\\", \\"../lib/helper.js\\")); console.log(path.posix.relative(\\"/workspace/a\\", \\"/workspace/b/c.js\\")); console.log(JSON.stringify(path.parse(\\"/workspace/src/app.test.js\\"))); console.log(path.format({ dir: \\"/workspace/out\\", name: \\"bundle\\", ext: \\".js\\" })); console.log(path.format({ root: \\"/\\", base: \\"x.txt\\" }));"',
  ].join(' '));
  assertCondition(pathResult.exitCode === 0, `native node path API should succeed: ${pathResult.stderr}`);
  assertCondition(
    pathResult.stdout === '/workspace/lib/file.js\nlib/file.js\n/workspace/src\nindex.test\n.js\ntrue\n../lib/helper.js\n/workspace/src/lib/helper.js\n../b/c.js\n{"root":"/","dir":"/workspace/src","base":"app.test.js","ext":".js","name":"app.test"}\n/workspace/out/bundle.js\n/x.txt\n',
    `native node path API should provide desktop posix behavior: ${pathResult.stdout}`
  );

  const fileUrlResult = await workspace.runCommand([
    'node',
    '-e',
    '"(async () => { const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const url = require(\\"node:url\\"); const fileUrl = url.pathToFileURL(\\"/workspace/url-file.txt\\"); fs.writeFileSync(fileUrl, \\"url-sync\\\\n\\"); console.log(fs.readFileSync(fileUrl, \\"utf8\\")); console.log(fs.existsSync(fileUrl)); await fsp.writeFile(fileUrl, \\"url-async\\\\n\\"); console.log(await fsp.readFile(fileUrl, \\"utf8\\")); fs.unlinkSync(fileUrl); console.log(fs.existsSync(fileUrl)); })();"',
  ].join(' '));
  assertCondition(fileUrlResult.exitCode === 0, `native node file URL fs workflow should succeed: ${fileUrlResult.stderr}`);
  assertCondition(
    fileUrlResult.stdout === 'url-sync\n\ntrue\nurl-async\n\nfalse\n',
    `native node fs should accept file URL paths: ${fileUrlResult.stdout}`
  );
}

async function testNativeJavaScriptProjectRunnerCwd(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'build/.keep', contents: '' },
      { path: 'src/helper.js', contents: 'exports.value = 29;\n' },
      { path: 'vendor/cwdpkg.js', contents: 'exports.value = 129;\n' },
      {
        path: 'src/index.js',
        contents: [
          'const fs = require("fs");',
          'const { value } = require("./helper");',
          'console.log(process.cwd().endsWith("/src"));',
          'console.log(value);',
          'fs.writeFileSync("generated.txt", "created\\n");',
          '',
        ].join('\n'),
      },
    ],
    nodeRunner: createNativeJavaScriptProjectRunner(),
  });

  const result = await workspace.runCommand('node index.js', { cwd: 'src' });
  assertCondition(result.exitCode === 0, `native node cwd should succeed: ${result.stderr}`);
  assertCondition(result.stdout === 'true\n29\n', `native node cwd should run from requested directory: ${result.stdout}`);
  assertCondition(await workspace.readFile('src/generated.txt') === 'created\n', 'native node cwd side effects should be workspace-relative');

  const parentRelativeResult = await workspace.runCommand('node ../src/index.js', { cwd: 'build' });
  assertCondition(parentRelativeResult.exitCode === 0, `native node should resolve cwd-relative parent script paths: ${parentRelativeResult.stderr}`);
  assertCondition(
    parentRelativeResult.stdout === 'false\n29\n',
    `native node should execute cwd-relative parent script paths with desktop cwd semantics: ${parentRelativeResult.stdout}`
  );
  assertCondition(await workspace.readFile('build/generated.txt') === 'created\n', 'native node cwd-relative script side effects should stay under cwd');

  const cwdRelativeNodePathResult = await workspace.runCommand('node -e "console.log(require(\\"cwdpkg\\").value)"', {
    cwd: 'build',
    env: { NODE_PATH: '../vendor' },
  });
  assertCondition(cwdRelativeNodePathResult.exitCode === 0, `native node should resolve cwd-relative NODE_PATH entries: ${cwdRelativeNodePathResult.stderr}`);
  assertCondition(cwdRelativeNodePathResult.stdout === '129\n', `native node should import modules from cwd-relative NODE_PATH entries: ${cwdRelativeNodePathResult.stdout}`);

  const timeoutEvents: RuntimeCommandEvent[] = [];
  const timeoutWorkspace = await createRuntimeWorkspace({
    nodeRunner: createNativeJavaScriptProjectRunner({ timeoutMs: 5 }),
  });
  const timeoutResult = await timeoutWorkspace.runCommand(
    'node -e "setTimeout(() => console.log(\\"late\\"), 25)"',
    { onEvent: (event) => timeoutEvents.push(event) }
  );
  assertCondition(
    timeoutResult.exitCode === 124 && timeoutResult.stderr.includes('node: execution timed out after 5ms'),
    `native node timeout should return a timeout result: ${JSON.stringify(timeoutResult)}`
  );
  assertCondition(
    timeoutEvents.some((event) => event.type === 'status' && event.phase === 'process-start') &&
      timeoutEvents.some((event) => event.type === 'status' && event.phase === 'process-exit' && event.detail?.exitCode === 124) &&
      !timeoutEvents.some((event) => event.type === 'output' && event.data.includes('late')),
    `native node timeout should emit terminal process status without late output: ${JSON.stringify(timeoutEvents)}`
  );
  const nativeTimeoutStderrIndex = timeoutEvents.findIndex(
    (event) => event.type === 'output' && event.stream === 'stderr' && event.data.includes('node: execution timed out after 5ms')
  );
  const nativeTimeoutExitIndex = timeoutEvents.findIndex(
    (event) => event.type === 'status' && event.phase === 'process-exit' && event.detail?.exitCode === 124
  );
  assertCondition(
    nativeTimeoutStderrIndex >= 0 && nativeTimeoutExitIndex > nativeTimeoutStderrIndex,
    `native node timeout should stream timeout stderr before process-exit: ${JSON.stringify(timeoutEvents)}`
  );
  timeoutWorkspace.dispose();

  const startErrorEvents: RuntimeCommandEvent[] = [];
  const startErrorWorkspace = await createRuntimeWorkspace({
    nodeRunner: createNativeJavaScriptProjectRunner({ nodeCommand: 'tracecode-missing-node-command' }),
  });
  const startErrorResult = await startErrorWorkspace.runCommand('node -e "console.log(1)"', {
    onEvent: (event) => startErrorEvents.push(event),
  });
  assertCondition(startErrorResult.exitCode === 1, `native node start error should return failure: ${JSON.stringify(startErrorResult)}`);
  assertCondition(
    startErrorEvents.some((event) => event.type === 'status' && event.phase === 'process-start') &&
      startErrorEvents.some((event) => event.type === 'status' && event.phase === 'process-error' && event.detail?.command === 'tracecode-missing-node-command'),
    `native node start error should emit process-error status: ${JSON.stringify(startErrorEvents)}`
  );
  const nativeStartErrorStderrIndex = startErrorEvents.findIndex(
    (event) => event.type === 'output' && event.stream === 'stderr' && event.data.includes('tracecode-missing-node-command')
  );
  const nativeStartErrorStatusIndex = startErrorEvents.findIndex(
    (event) => event.type === 'status' && event.phase === 'process-error' && event.detail?.command === 'tracecode-missing-node-command'
  );
  assertCondition(
    nativeStartErrorStderrIndex >= 0 && nativeStartErrorStatusIndex > nativeStartErrorStderrIndex,
    `native node start error should stream stderr before process-error: ${JSON.stringify(startErrorEvents)}`
  );
  startErrorWorkspace.dispose();

}

async function testNativeJavaScriptProjectRunnerStdin(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'src/helper.js', contents: 'exports.value = 43;\n' },
    ],
    nodeRunner: createNativeJavaScriptProjectRunner(),
  });

  const result = await workspace.runCommand(
    [
      'printf',
      "'const fs = require(\"fs\");\\nconst { value } = require(\"./helper\");\\nconsole.log(process.cwd().endsWith(\"/src\"));\\nconsole.log(value);\\nfs.writeFileSync(\"generated.txt\", \"created\\\\n\");\\n'",
      '|',
      'node -',
    ].join(' '),
    { cwd: 'src' }
  );
  assertCondition(result.exitCode === 0, `native node stdin should succeed: ${result.stderr}`);
  assertCondition(result.stdout === 'true\n43\n', `native node stdin should execute from requested cwd: ${result.stdout}`);
  assertCondition(await workspace.readFile('src/generated.txt') === 'created\n', 'native node stdin side effects should be workspace-relative');

  const argvResult = await workspace.runCommand(
    'printf \'console.log(process.argv.slice(1).join(","))\\n\' | node - alpha beta'
  );
  assertCondition(argvResult.exitCode === 0, `native node stdin argv should succeed: ${argvResult.stderr}`);
  assertCondition(argvResult.stdout === '-,alpha,beta\n', `native node stdin argv should match desktop semantics: ${argvResult.stdout}`);
}

async function testNativeJavaScriptProjectRunnerAbsoluteWorkspacePaths(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'src/helper.js', contents: 'exports.value = 61;\n' },
      { path: 'src/stale.txt', contents: 'delete me\n' },
      {
        path: 'src/index.js',
        contents: [
          'const fs = require("node:fs");',
          'console.log(process.cwd());',
          'console.log(require("/workspace/src/helper.js").value);',
          'console.log(fs.readdirSync("/workspace/src").includes("helper.js"));',
          'fs.writeFileSync("/workspace/src/absolute.txt", "absolute\\n");',
          'fs.unlinkSync("/workspace/src/stale.txt");',
          '',
        ].join('\n'),
      },
    ],
    nodeRunner: createNativeJavaScriptProjectRunner(),
  });

  const result = await workspace.runCommand('node index.js', { cwd: 'src' });
  assertCondition(result.exitCode === 0, `native node absolute workspace paths should succeed: ${result.stderr}`);
  assertCondition(
    result.stdout === '/workspace/src\n61\ntrue\n',
    `native node should expose virtual workspace cwd and files: ${result.stdout}`
  );
  assertCondition(await workspace.readFile('src/absolute.txt') === 'absolute\n', 'native node should persist absolute /workspace writes');
  await assertRejectsAsync(() => workspace.readFile('src/stale.txt'), 'native node should persist absolute /workspace deletes');
}

async function testProjectJavaScriptRunnersDirectAbsoluteScriptPath(): Promise<void> {
  const request: JavaScriptProjectCommandRequest = {
    code: '',
    source: 'file',
    scriptPath: '/workspace/src/index.js',
    args: ['alpha', 'beta'],
    cwd: '/workspace',
    env: {},
    stdinPipe: stdinPipe('one\ntwo\nthree\n'),
    project: {
      cwd: '/workspace',
      files: [
        { path: 'src/helper.js', contents: 'exports.value = 71;\n' },
        {
          path: 'src/index.js',
          contents: 'const { value } = require("./helper");\nconsole.log(value);\nconsole.log(process.argv.slice(2).join(","));\n',
        },
      ],
    },
  };

  const nativeResult = await createNativeJavaScriptProjectRunner()(request);
  assertCondition(nativeResult.exitCode === 0, `native node direct absolute scriptPath should succeed: ${nativeResult.stderr}`);
  assertCondition(
    nativeResult.stdout === '71\nalpha,beta\n',
    `native node direct runner should accept /workspace scriptPath: ${nativeResult.stdout}`
  );

  const browserResult = await createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true })(request);
  assertCondition(browserResult.exitCode === 0, `browser node direct absolute scriptPath should succeed: ${browserResult.stderr}`);
  assertCondition(
    browserResult.stdout === '71\nalpha,beta\n',
    `browser node direct runner should accept /workspace scriptPath: ${browserResult.stdout}`
  );

  await assertRejectsAsync(
    () => createNativeJavaScriptProjectRunner()({
      ...request,
      scriptPath: '/outside/index.js',
    }),
    'native node direct runner should reject absolute scriptPath outside the workspace'
  );
  const browserOutsideResult = await createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true })({
    ...request,
    scriptPath: '/outside/index.js',
  });
  assertCondition(
    browserOutsideResult.exitCode !== 0 && browserOutsideResult.stderr.includes('Path must be inside workspace'),
    `browser node direct runner should reject absolute scriptPath outside the workspace: ${browserOutsideResult.stderr}`
  );
  await assertRejectsAsync(
    () => createNativeJavaScriptProjectRunner()({
      ...request,
      cwd: '/outside',
    }),
    'native node direct runner should reject cwd outside the workspace'
  );
  await assertRejectsAsync(
    () => createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true })({
      ...request,
      cwd: '/outside',
    }),
    'browser node direct runner should reject cwd outside the workspace'
  );
}

async function testBrowserJavaScriptProjectRunnerApplyFileChangeHook(): Promise<void> {
  const appliedChanges: string[] = [];
  const events: RuntimeCommandEvent[] = [];
  const runner = createBrowserJavaScriptProjectRunner({
    allowMainThreadExecution: true, trustedMainThreadExecution: true,
    applyFileChange: async (change, phase) => {
      appliedChanges.push(`${phase}:${change.path}`);
      return false;
    },
  });

  const result = await runner(asJsProjectRequest({
    code: [
      'const fs = require("node:fs");',
      'fs.mkdirSync("live-dir/nested", { recursive: true });',
      'fs.writeFileSync("live-dir/nested/live-js.txt", "live\\n");',
      'fs.rmSync("live-dir", { recursive: true });',
      'console.log("after-live");',
    ].join(' '),
    source: 'argument',
    args: [],
    cwd: '/workspace',
    env: {},
    stdinPipe: stdinPipe('hidden\n'),
    project: {
      cwd: '/workspace',
      files: [],
    },
    onEvent: (event) => events.push(event),
  }));

  assertCondition(result.exitCode === 0, `browser node applyFileChange hook command should succeed: ${result.stderr}`);
  assertCondition(result.stdout === 'after-live\n', `browser node applyFileChange hook should preserve stdout: ${result.stdout}`);
  assertCondition(
    appliedChanges.includes('live:live-dir') &&
      appliedChanges.includes('live:live-dir/nested') &&
      appliedChanges.includes('live:live-dir/nested/live-js.txt'),
    `browser node applyFileChange hook should receive live file and directory mutations: ${JSON.stringify(appliedChanges)}`
  );
  assertCondition(
    events.some((event) => event.type === 'output' && event.data === 'after-live\n'),
    `browser node applyFileChange hook should preserve later output events: ${JSON.stringify(events)}`
  );
  assertCondition(
    !events.some((event) => event.type === 'file-change' && event.change.path.startsWith('live-dir')),
    `browser node applyFileChange hook should support suppressing duplicate file-change events: ${JSON.stringify(events)}`
  );

  const failedEvents: RuntimeCommandEvent[] = [];
  const failedRunner = createBrowserJavaScriptProjectRunner({
    allowMainThreadExecution: true, trustedMainThreadExecution: true,
    applyFileChange: async (change) => {
      throw new Error(`reject-live:${change.path}`);
    },
  });
  const failedResult = await failedRunner(asJsProjectRequest({
    code: 'const fs = require("node:fs"); fs.writeFileSync("bad-live-js.txt", "bad\\n"); console.log("after-bad-live");',
    source: 'argument',
    args: [],
    cwd: '/workspace',
    env: {},
    stdinPipe: stdinPipe('from-tty\n'),
    project: {
      cwd: '/workspace',
      files: [],
    },
    onEvent: (event) => failedEvents.push(event),
  }));

  assertCondition(
    failedResult.exitCode === 137 && failedResult.error?.code === 'EIO',
    `browser node failed applyFileChange hook should terminate the runtime process: ${JSON.stringify(failedResult)}`
  );
  assertCondition(
    !failedResult.stderr.includes('reject-live:bad-live-js.txt') &&
      failedResult.error?.detail?.diagnostic === 'reject-live:bad-live-js.txt',
    `browser node failed applyFileChange hook should keep host diagnostics out of stderr: ${JSON.stringify(failedResult)}`
  );
  assertCondition(
    !failedEvents.some((event) => event.type === 'output' && event.data === 'after-bad-live\n'),
    `browser node failed applyFileChange hook should stop later streamed output events: ${JSON.stringify(failedEvents)}`
  );
  const failedApplyExitIndex = failedEvents.findIndex(
    (event) =>
      event.type === 'status' &&
      event.phase === 'process-exit' &&
      event.detail?.exitCode === 137 &&
      event.detail?.diagnostic === 'reject-live:bad-live-js.txt'
  );
  assertCondition(
    failedApplyExitIndex >= 0 &&
      !failedEvents.some((event) => event.type === 'output' && event.data.includes('reject-live:bad-live-js.txt')),
    `browser node failed applyFileChange hook should expose diagnostics only in status metadata: ${JSON.stringify(failedEvents)}`
  );

  const timerAppliedChanges: string[] = [];
  const timerEvents: RuntimeCommandEvent[] = [];
  const timerResult = await createBrowserJavaScriptProjectRunner({
    allowMainThreadExecution: true, trustedMainThreadExecution: true,
    applyFileChange: async (change, phase) => {
      timerAppliedChanges.push(`${phase}:${change.path}`);
      return true;
    },
  })(asJsProjectRequest({
    code: [
      'const fs = require("node:fs");',
      'setTimeout(() => {',
      '  fs.writeFileSync("timer-live.txt", "timer-live\\n");',
      '  console.log("timer-out");',
      '}, 0);',
      'console.log("sync-out");',
    ].join('\n'),
    source: 'argument',
    args: [],
    cwd: '/workspace',
    env: {},
    stdinPipe: stdinPipe('one\ntwo\nthree\n'),
    project: {
      cwd: '/workspace',
      files: [],
    },
    onEvent: (event) => timerEvents.push(event),
  }));

  assertCondition(timerResult.exitCode === 0, `browser node timer-backed live I/O should succeed: ${timerResult.stderr}`);
  assertCondition(
    timerResult.stdout === 'sync-out\ntimer-out\n',
    `browser node should wait for pending timer stdout before process exit: ${JSON.stringify(timerResult)}`
  );
  assertCondition(
    timerAppliedChanges.includes('live:timer-live.txt'),
    `browser node should apply timer-backed live filesystem mutations: ${JSON.stringify(timerAppliedChanges)}`
  );
  const timerChangeIndex = timerEvents.findIndex((event) => event.type === 'file-change' && event.change.path === 'timer-live.txt');
  const timerOutputIndex = timerEvents.findIndex((event) => event.type === 'output' && event.data === 'timer-out\n');
  const timerExitIndex = timerEvents.findIndex((event) => event.type === 'status' && event.phase === 'process-exit');
  assertCondition(
    timerChangeIndex >= 0 && timerOutputIndex > timerChangeIndex && timerExitIndex > timerOutputIndex,
    `browser node should stream timer file changes before later stdout and exit: ${JSON.stringify(timerEvents)}`
  );

  const timerGlobalShadowResult = await createBrowserJavaScriptProjectRunner({
    allowMainThreadExecution: true,
    trustedMainThreadExecution: true,
  })(asJsProjectRequest({
    code: [
      'const setTimeout = 1;',
      'let clearInterval = 2;',
      'const queueMicrotask = 3;',
      'const fetch = 4;',
      'console.log(setTimeout + clearInterval + queueMicrotask + fetch);',
    ].join('\n'),
    source: 'argument',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      files: [],
    },
  }));
  assertCondition(
    timerGlobalShadowResult.exitCode === 0 && timerGlobalShadowResult.stdout === '10\n',
    `browser node eval wrappers should allow lexical timer/global shadows: ${JSON.stringify(timerGlobalShadowResult)}`
  );

  const timerGlobalShadowFileResult = await createBrowserJavaScriptProjectRunner({
    allowMainThreadExecution: true,
    trustedMainThreadExecution: true,
  })({
    code: '',
    source: 'file',
    scriptPath: 'shadow.js',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      files: [{
        path: 'shadow.js',
        contents: [
          'const setTimeout = 1;',
          'let clearInterval = 2;',
          'const queueMicrotask = 3;',
          'const fetch = 4;',
          'console.log(setTimeout + clearInterval + queueMicrotask + fetch);',
        ].join('\n'),
      }],
    },
  });
  assertCondition(
    timerGlobalShadowFileResult.exitCode === 0 && timerGlobalShadowFileResult.stdout === '10\n',
    `browser node module wrappers should allow lexical timer/global shadows: ${JSON.stringify(timerGlobalShadowFileResult)}`
  );

  const timeoutTimerEvents: RuntimeCommandEvent[] = [];
  const timeoutTimerResult = await createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true, timeoutMs: 5 })(asJsProjectRequest({
    code: [
      'const fs = require("node:fs");',
      'setTimeout(() => {',
      '  fs.writeFileSync("late-timeout.txt", "late\\n");',
      '  console.log("late-timeout");',
      '}, 25);',
    ].join('\n'),
    source: 'argument',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      files: [],
    },
    onEvent: (event) => timeoutTimerEvents.push(event),
  }));
  await new Promise((resolve) => setTimeout(resolve, 35));
  assertCondition(
    timeoutTimerResult.exitCode === 124 &&
      !timeoutTimerResult.files?.some((change) => change.path === 'late-timeout.txt') &&
      !timeoutTimerResult.stdout.includes('late-timeout'),
    `browser node should time out pending timers without returning late filesystem/output changes: ${JSON.stringify(timeoutTimerResult)}`
  );
  assertCondition(
    !timeoutTimerEvents.some((event) => event.type === 'file-change' && event.change.path === 'late-timeout.txt') &&
      !timeoutTimerEvents.some((event) => event.type === 'output' && event.data.includes('late-timeout')),
    `browser node should suppress late timer events after timeout: ${JSON.stringify(timeoutTimerEvents)}`
  );
  const timeoutStderrIndex = timeoutTimerEvents.findIndex(
    (event) => event.type === 'output' && event.stream === 'stderr' && event.data.includes('node: execution timed out after 5ms')
  );
  const timeoutExitIndex = timeoutTimerEvents.findIndex(
    (event) => event.type === 'status' && event.phase === 'process-exit' && event.detail?.exitCode === 124
  );
  assertCondition(
    timeoutStderrIndex >= 0 && timeoutExitIndex > timeoutStderrIndex,
    `browser node timeout should stream timeout stderr before process-exit: ${JSON.stringify(timeoutTimerEvents)}`
  );

  const timeoutApplyStarted: string[] = [];
  const timeoutApplyCommitted: string[] = [];
  const timeoutApplyEvents: RuntimeCommandEvent[] = [];
  let resolveTimeoutApplyStarted!: () => void;
  let resolveTimeoutApply!: () => void;
  const timeoutApplyStartedPromise = new Promise<void>((resolve) => {
    resolveTimeoutApplyStarted = resolve;
  });
  const timeoutApplyGate = new Promise<void>((resolve) => {
    resolveTimeoutApply = resolve;
  });
  const timeoutApplyRunner = createBrowserJavaScriptProjectRunner({
    allowMainThreadExecution: true,
    trustedMainThreadExecution: true,
    timeoutMs: 5,
    applyFileChange: async (change, phase, options) => {
      timeoutApplyStarted.push(`${phase}:${change.path}`);
      resolveTimeoutApplyStarted();
      await timeoutApplyGate;
      if (options?.signal?.aborted) return false;
      timeoutApplyCommitted.push(`${phase}:${change.path}`);
      return true;
    },
  });
  const timeoutApplyRun = timeoutApplyRunner(asJsProjectRequest({
    code: [
      'const fs = require("node:fs");',
      'fs.writeFileSync("timeout-apply-one.txt", "one\\n");',
      'fs.writeFileSync("timeout-apply-two.txt", "two\\n");',
      'await new Promise((resolve) => setTimeout(resolve, 50));',
    ].join('\n'),
    source: 'argument',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      files: [],
    },
    onEvent: (event) => timeoutApplyEvents.push(event),
  }));
  await timeoutApplyStartedPromise;
  const timeoutApplyResult = await timeoutApplyRun;
  resolveTimeoutApply();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertCondition(
    timeoutApplyResult.exitCode === 124 &&
      timeoutApplyStarted.length === 1 &&
      timeoutApplyStarted[0] === 'live:timeout-apply-one.txt' &&
      timeoutApplyCommitted.length === 0,
    `browser node timeout should abort pending live file-change applies: ${JSON.stringify({
      timeoutApplyResult,
      timeoutApplyStarted,
      timeoutApplyCommitted,
    })}`
  );
  assertCondition(
    !timeoutApplyEvents.some((event) => event.type === 'file-change' && event.change.path.startsWith('timeout-apply-')),
    `browser node timeout should suppress queued live file-change events after apply abort: ${JSON.stringify(timeoutApplyEvents)}`
  );
}

async function testBrowserJavaScriptProjectRunnerKernelDeviceInventory(): Promise<void> {
  const events: RuntimeCommandEvent[] = [];
  const result = await createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true })(asJsProjectRequest({
    code: [
      'const fs = require("node:fs");',
      'process.stdout.write(fs.readFileSync("/dev/tty", "utf8").trim() + "\\n");',
      'process.stdout.write(fs.readFileSync("/dev/custom-in", "utf8").trim() + "\\n");',
      'const devNames = fs.readdirSync("/dev");',
      'process.stdout.write(String(devNames.includes("log") && devNames.includes("custom-in") && devNames.includes("pts")) + "\\n");',
      'process.stdout.write(fs.readdirSync("/dev/pts").join(",") + ":" + String(fs.statSync("/dev/pts").isDirectory()) + ":" + String(fs.statSync("/dev/pts/0").isCharacterDevice()) + "\\n");',
      'process.stdout.write(String(fs.existsSync("/dev/log")) + ":" + String(fs.existsSync("/dev/missing")) + "\\n");',
      'fs.accessSync("/dev/log", fs.constants.W_OK);',
      'fs.accessSync("/dev/custom-in", fs.constants.R_OK);',
      'try { fs.rmSync("/dev/log"); } catch (error) { process.stdout.write("rm-log:" + error.code + "\\n"); }',
      'fs.chmodSync("/dev/log", 0o600);',
      'process.stdout.write("chmod-log:ok\\n");',
      'try { fs.rmSync("/dev/missing"); } catch (error) { process.stdout.write("rm-missing:" + error.code + "\\n"); }',
      'process.stdout.write("null-read:" + fs.readFileSync("/dev/null").length + "\\n");',
      'fs.copyFileSync("/dev/custom-in", "custom-copy.txt");',
      'process.stdout.write(fs.readFileSync("custom-copy.txt", "utf8").trim() + "\\n");',
      'fs.writeFileSync("/dev/null", "discarded\\n");',
      'fs.writeFileSync("/dev/tty", "tty-device\\n");',
      'fs.copyFileSync("message.txt", "/dev/tty");',
      'fs.writeFileSync("/dev/log", "log-device\\n");',
      'fs.copyFileSync("message.txt", "/dev/log");',
      'fs.writeFileSync("/dev/pts/0", "pts-device\\n");',
    ].join('\n'),
    source: 'argument',
    args: [],
    cwd: '/workspace',
    env: {},
    stdinPipe: stdinPipe('from-tty\n'),
    project: {
      cwd: '/workspace',
      files: [{ path: 'message.txt', contents: 'copy-device\n' }],
      kernelDevices: [
        { path: '/dev/stdin', readable: true, writable: false, inputDevice: '/dev/stdin' },
        { path: '/dev/null', readable: true, writable: true, inputDevice: '/dev/null', outputDevice: '/dev/null' },
        { path: '/dev/stdout', readable: false, writable: true, outputDevice: '/dev/stdout' },
        { path: '/dev/stderr', readable: false, writable: true, outputDevice: '/dev/stderr' },
        { path: '/dev/tty', readable: true, writable: true, inputDevice: '/dev/stdin', outputDevice: '/dev/stderr' },
        { path: '/dev/log', readable: false, writable: true, outputDevice: '/dev/stderr' },
        { path: '/dev/custom-in', readable: true, writable: false, inputDevice: '/dev/stdin' },
        { path: '/dev/pts/0', readable: false, writable: true, outputDevice: '/dev/stdout' },
      ],
    },
    onEvent: (event) => events.push(event),
  }));

  assertCondition(result.exitCode === 0, `browser node custom kernel device inventory should succeed: ${result.stderr}`);
  assertCondition(
    result.stdout === 'from-tty\n\ntrue\n0:true:true\ntrue:false\nrm-log:EROFS\nchmod-log:ok\nrm-missing:ENOENT\nnull-read:0\n\npts-device\n',
    `browser node should read manifest devices and list them in /dev: ${JSON.stringify(result)}`
  );
  assertCondition(
    result.stderr === 'tty-device\ncopy-device\nlog-device\ncopy-device\n',
    `browser node should route /dev/tty writes through configured stderr target: ${JSON.stringify(result)}`
  );
  assertCondition(
    events.filter((event) => event.type === 'output' && event.stream === 'stderr' && event.device === '/dev/stderr')
      .map((event) => (event as OutputEvent).data)
      .join('') === result.stderr,
    `browser node should stream custom device-routed stderr events: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.filter((event) =>
      event.type === 'output' &&
      event.stream === 'stderr' &&
      event.device === '/dev/stderr' &&
      event.sourceDevice === '/dev/tty'
    ).map((event) => (event as OutputEvent).data).join('') === 'tty-device\ncopy-device\n',
    `browser node should preserve source device for custom-routed /dev/tty writes: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.filter((event) =>
      event.type === 'output' &&
      event.stream === 'stderr' &&
      event.device === '/dev/stderr' &&
      event.sourceDevice === '/dev/log'
    ).map((event) => (event as OutputEvent).data).join('') === 'log-device\ncopy-device\n',
    `browser node should support manifest-provided custom output devices: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.filter((event) =>
      event.type === 'output' &&
      event.stream === 'stdout' &&
      event.device === '/dev/stdout' &&
      event.sourceDevice === '/dev/pts/0'
    ).map((event) => (event as OutputEvent).data).join('') === 'pts-device\n',
    `browser node should support nested manifest output devices: ${JSON.stringify(events)}`
  );
  const customDeviceExitIndex = events.findIndex((event) => event.type === 'status' && event.phase === 'process-exit');
  const customDeviceOutputIndexes = [
    events.findIndex((event) =>
      event.type === 'output' &&
      event.stream === 'stderr' &&
      event.device === '/dev/stderr' &&
      event.sourceDevice === '/dev/tty' &&
      event.data === 'tty-device\n'
    ),
    events.findIndex((event) =>
      event.type === 'output' &&
      event.stream === 'stderr' &&
      event.device === '/dev/stderr' &&
      event.sourceDevice === '/dev/log' &&
      event.data === 'log-device\n'
    ),
    events.findIndex((event) =>
      event.type === 'output' &&
      event.stream === 'stdout' &&
      event.device === '/dev/stdout' &&
      event.sourceDevice === '/dev/pts/0' &&
      event.data === 'pts-device\n'
    ),
  ];
  assertCondition(
    customDeviceExitIndex > 0 &&
      customDeviceOutputIndexes.every((index) => index >= 0 && index < customDeviceExitIndex),
    `browser node custom device output events should stream before process-exit: ${JSON.stringify(events)}`
  );

  const sharedStdinCursorResult = await createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true })(asJsProjectRequest({
    code: [
      'const fs = require("node:fs");',
      'process.stdin.setEncoding("utf8");',
      'process.stdout.write("process=" + process.stdin.read(4) + "\\n");',
      'process.stdout.write("custom=" + fs.readFileSync("/dev/custom-in", "utf8").replace(/\\n/g, "<lf>") + "\\n");',
    ].join('\n'),
    source: 'argument',
    args: [],
    cwd: '/workspace',
    env: {},
    stdinPipe: stdinPipe('one\ntwo\nthree\n'),
    project: {
      cwd: '/workspace',
      files: [],
      kernelDevices: [
        { path: '/dev/stdin', readable: true, writable: false, inputDevice: '/dev/stdin' },
        { path: '/dev/stdout', readable: false, writable: true, outputDevice: '/dev/stdout' },
        { path: '/dev/stderr', readable: false, writable: true, outputDevice: '/dev/stderr' },
        { path: '/dev/custom-in', readable: true, writable: false, inputDevice: '/dev/stdin' },
      ],
    },
  }));
  assertCondition(sharedStdinCursorResult.exitCode === 0, `browser node shared stdin cursor case should succeed: ${sharedStdinCursorResult.stderr}`);
  assertCondition(
    sharedStdinCursorResult.stdout === 'process=one\n\ncustom=two<lf>three<lf>\n',
    `browser node process.stdin and /dev devices should share one stdin cursor: ${JSON.stringify(sharedStdinCursorResult)}`
  );

  const restrictedResult = await createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true })(asJsProjectRequest({
    code: [
      'const fs = require("node:fs");',
      'try { fs.readFileSync(0, "utf8"); console.log("fd0:ok"); } catch (error) { console.log("fd0:" + error.code); }',
      'try { fs.writeSync(1, "fd1-out\\n"); console.log("fd1:ok"); } catch (error) { console.log("fd1:" + error.code); }',
      'try { process.stdin.resume(); let text = ""; process.stdin.on("data", (chunk) => text += chunk); await new Promise((resolve) => process.stdin.on("end", resolve)); console.log("stdin:" + text.trim()); } catch (error) { console.log("stdin:" + error.code); }',
      'try { process.stdout.write("process-out\\n"); console.log("process:ok"); } catch (error) { console.log("process:" + error.code); }',
      'try { fs.readFileSync("/dev/stdout", "utf8"); console.log("stdout-readfile:ok"); } catch (error) { console.log("stdout-readfile:" + error.code); }',
      'try { await new Promise((resolve, reject) => fs.createReadStream("/dev/stdout").on("error", reject).on("end", resolve).resume()); console.log("stdout-stream:ok"); } catch (error) { console.log("stdout-stream:" + error.code); }',
      'try { fs.copyFileSync("/dev/stdout", "stdout-copy.txt"); console.log("stdout-copy:ok"); } catch (error) { console.log("stdout-copy:" + error.code); }',
      'try { const fd = fs.openSync("/dev/stdout", "r"); const buffer = Buffer.alloc(1); fs.readSync(fd, buffer, 0, 1, 0); console.log("stdout-read-open:ok"); } catch (error) { console.log("stdout-read-open:" + error.code); }',
      'try { const fd = fs.openSync("/dev/stdin", "w"); fs.writeSync(fd, "stdin-write\\n"); console.log("stdin-write-open:ok"); } catch (error) { console.log("stdin-write-open:" + error.code); }',
      'fs.writeFileSync("/dev/stderr", "stderr-ok\\n");',
    ].join('\n'),
    source: 'argument',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      files: [],
      kernelDevices: [
        { path: '/dev/stdin', readable: false, writable: false },
        { path: '/dev/stdout', readable: false, writable: false },
        { path: '/dev/stderr', readable: false, writable: true, outputDevice: '/dev/stderr' },
        { path: '/dev/tty', readable: false, writable: false },
      ],
    },
  }));
  assertCondition(restrictedResult.exitCode === 0, `browser node restricted kernel device inventory should succeed: ${restrictedResult.stderr}`);
  assertCondition(
    restrictedResult.stdout === 'fd0:EBADF\nfd1:EBADF\nstdin:\nprocess:EBADF\nstdout-readfile:EBADF\nstdout-stream:EBADF\nstdout-copy:EBADF\nstdout-read-open:EBADF\nstdin-write-open:EBADF\n',
    `browser node fd/process stdio should respect restricted kernelDevices: ${JSON.stringify(restrictedResult)}`
  );
  assertCondition(
    restrictedResult.stderr === 'stderr-ok\n',
    `browser node restricted kernelDevices should still allow configured stderr: ${JSON.stringify(restrictedResult)}`
  );
}

async function testProjectJavaScriptRunnersPreserveEmptyDirectories(): Promise<void> {
  const request: JavaScriptProjectCommandRequest = {
    code: '',
    source: 'file',
    scriptPath: 'index.js',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      directories: ['empty/child'],
      files: [
        {
          path: 'index.js',
          contents: 'const fs = require("node:fs"); console.log(fs.statSync("empty/child").isDirectory()); console.log(fs.readdirSync("empty").join(","));\n',
        },
      ],
    },
  };

  const nativeResult = await createNativeJavaScriptProjectRunner()(request);
  assertCondition(nativeResult.exitCode === 0, `native node should see project snapshot directories: ${nativeResult.stderr}`);
  assertCondition(
    nativeResult.stdout === 'true\nchild\n',
    `native node should preserve project snapshot directories: ${nativeResult.stdout}`
  );

  const browserResult = await createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true })(request);
  assertCondition(browserResult.exitCode === 0, `browser node should see project snapshot directories: ${browserResult.stderr}`);
  assertCondition(
    browserResult.stdout === 'true\nchild\n',
    `browser node should preserve project snapshot directories: ${browserResult.stdout}`
  );
}

async function testBrowserJavaScriptProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'package.json',
        contents: JSON.stringify({
          scripts: {
            test: 'node index.js',
          },
          devDependencies: {
            typescript: 'latest',
          },
        }, null, 2),
      },
      { path: 'config.json', contents: '{"offset":4}\n' },
      { path: 'stale.txt', contents: 'delete me\n' },
      { path: 'lib/math.js', contents: 'const config = require("../config.json"); module.exports = { add: (a, b) => a + b + config.offset };\n' },
      { path: 'node_modules/adder/package.json', contents: '{"main":"src/main.js"}\n' },
      { path: 'node_modules/adder/src/main.js', contents: 'module.exports = { add: (a, b) => a + b + 100 };\n' },
      { path: 'node_modules/esadder/package.json', contents: '{"type":"module","exports":{"import":"./src/index.js","require":"./src/index.js"}}\n' },
      { path: 'node_modules/esadder/src/index.js', contents: 'export function add(a, b) { return a + b + 200; }\n' },
      { path: 'node_modules/condpkg/package.json', contents: '{"exports":{"import":"./esm.mjs","require":"./cjs.cjs"}}\n' },
      { path: 'node_modules/condpkg/cjs.cjs', contents: 'exports.value = "require-branch";\n' },
      { path: 'node_modules/condpkg/esm.mjs', contents: 'export const value = "import-branch";\n' },
      { path: 'node_modules/subadder/package.json', contents: '{"type":"module","exports":{"./feature":{"import":"./src/feature.js","require":"./src/feature.js"}}}\n' },
      { path: 'node_modules/subadder/src/feature.js', contents: 'export function add(a, b) { return a + b + 400; }\n' },
      { path: 'node_modules/modadder/package.json', contents: '{"type":"module","module":"src/module.js"}\n' },
      { path: 'node_modules/modadder/src/module.js', contents: 'export const add = (a, b) => a + b + 300;\n' },
      { path: 'vendor/envpkg.js', contents: 'exports.value = 616;\n' },
      { path: 'preload.js', contents: 'const fs = require("node:fs"); globalThis.tracecodePreload = "browser-preload"; fs.writeFileSync("preload.txt", "loaded\\n");\n' },
      { path: 'appdir/package.json', contents: '{"main":"src/cli.js"}\n' },
      { path: 'appdir/src/cli.js', contents: 'console.log("appdir:" + process.argv.slice(2).join(","));\n' },
      { path: 'indexdir/index.js', contents: 'console.log("indexdir:" + process.argv.slice(2).join(","));\n' },
      { path: 'node_modules/cliadder/package.json', contents: '{"main":"src/cli.js"}\n' },
      { path: 'node_modules/cliadder/src/cli.js', contents: 'console.log("cliadder:" + process.argv.slice(2).join(","));\n' },
      { path: 'node_modules/localpkg/index.js', contents: 'exports.value = "root-local";\n' },
      { path: 'src/node_modules/localpkg/index.js', contents: 'exports.value = "nested-local";\n' },
      { path: 'node_modules/exportedpkg/package.json', contents: '{"exports":{"./feature":{"require":"./root-feature.js"}}}\n' },
      { path: 'node_modules/exportedpkg/root-feature.js', contents: 'exports.value = "root-export";\n' },
      { path: 'src/node_modules/exportedpkg/package.json', contents: '{"exports":{"./feature":{"require":"./nested-feature.js"}}}\n' },
      { path: 'src/node_modules/exportedpkg/nested-feature.js', contents: 'exports.value = "nested-export";\n' },
      { path: 'src/app/index.js', contents: 'console.log(require("localpkg").value);\nconsole.log(require("exportedpkg/feature").value);\n' },
      {
        path: 'compat.js',
        contents: [
          'const assert = require("node:assert/strict");',
          'const { EventEmitter } = require("node:events");',
          'const { promisify, types } = require("node:util");',
          'const { setTimeout: delay } = require("node:timers/promises");',
          'const { randomUUID, randomBytes } = require("node:crypto");',
          'const processModule = require("node:process");',
          'const { PassThrough } = require("node:stream");',
          '(async () => {',
          '  assert.equal(require("assert/strict"), assert);',
          '  assert.deepEqual({ a: [1, Buffer.from("ok")] }, { a: [1, Buffer.from("ok")] });',
          '  const emitter = new EventEmitter();',
          '  let seen = "";',
          '  emitter.once("ready", (value) => { seen = value; });',
          '  emitter.emit("ready", "event");',
          '  assert.equal(seen, "event");',
          '  const read = promisify((value, callback) => callback(null, value + 1));',
          '  assert.equal(await read(4), 5);',
          '  assert.equal(types.isDate(new Date()), true);',
          '  assert.match(randomUUID(), /^[0-9a-f-]{36}$/);',
          '  assert.equal(randomBytes(4).length, 4);',
          '  assert.equal(processModule.cwd(), process.cwd());',
          '  const stream = new PassThrough();',
          '  let streamed = "";',
          '  stream.on("data", (chunk) => { streamed += chunk.toString(); });',
          '  stream.write("st");',
          '  stream.end("ream");',
          '  await delay(0);',
          '  assert.equal(streamed, "stream");',
          '  console.log("compat-ok");',
          '})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });',
          '',
        ].join('\n'),
      },
      { path: 'index.js', contents: 'const { add } = require("./lib/math"); console.log(add(2, 3)); console.log(process.argv.slice(2).join(","));\n' },
    ],
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true }),
  });

  const result = await workspace.runCommand('node index.js alpha beta');
  assertCondition(result.exitCode === 0, `browser node should succeed: ${result.stderr}`);
  assertCondition(result.stdout === '9\nalpha,beta\n', `browser node should support require/json/argv: ${result.stdout}`);

  const compatResult = await workspace.runCommand('node compat.js');
  assertCondition(compatResult.exitCode === 0, `browser node compatibility builtins should succeed: ${compatResult.stderr}`);
  assertCondition(compatResult.stdout === 'compat-ok\n', `browser node compatibility builtins should work: ${compatResult.stdout}`);

  const codeResult = await workspace.runCommand('node -e "const { add } = require(\\"./lib/math\\"); console.log(add(10, 7))"');
  assertCondition(codeResult.exitCode === 0, `browser node -e should succeed: ${codeResult.stderr}`);
  assertCondition(codeResult.stdout === '21\n', `browser node -e should import project files: ${codeResult.stdout}`);

  const evalArgvResult = await workspace.runCommand('node -e "console.log(process.argv.slice(1).join(\\"\\,\\"))" alpha beta');
  assertCondition(evalArgvResult.exitCode === 0, `browser node -e argv should succeed: ${evalArgvResult.stderr}`);
  assertCondition(evalArgvResult.stdout === 'alpha,beta\n', `browser node -e argv should match desktop semantics: ${evalArgvResult.stdout}`);

  const runtimeErrorResult = await workspace.runCommand('node -e "function outer(){ inner(); } function inner(){ throw new Error(\\"boom-browser-js\\"); } outer();"');
  assertCondition(runtimeErrorResult.exitCode === 1, `browser node runtime exception should fail: ${JSON.stringify(runtimeErrorResult)}`);
  assertCondition(
    runtimeErrorResult.stderr.includes('Error: boom-browser-js') &&
      runtimeErrorResult.stderr.includes('at inner') &&
      runtimeErrorResult.stderr.includes('at outer'),
    `browser node runtime exception should surface stack frames: ${JSON.stringify(runtimeErrorResult)}`
  );

  const rootRequireResult = await workspace.runCommand('node -e "const { add } = require(\\"lib/math\\"); console.log(add(1, 4))"');
  assertCondition(rootRequireResult.exitCode === 0, `browser node root require should succeed: ${rootRequireResult.stderr}`);
  assertCondition(rootRequireResult.stdout === '9\n', `browser node root require should resolve from workspace root: ${rootRequireResult.stdout}`);

  const packageResult = await workspace.runCommand('node -e "const { add } = require(\\"adder\\"); console.log(add(1, 4))"');
  assertCondition(packageResult.exitCode === 0, `browser node package require should succeed: ${packageResult.stderr}`);
  assertCondition(packageResult.stdout === '105\n', `browser node package require should resolve package main: ${packageResult.stdout}`);

  const typeScriptVersion = getLanguageRuntimeInfo('typescript').compiler?.version ?? '5.9.3';
  const typeScriptRequireResult = await workspace.runCommand('node -p "require(\\"typescript\\").version"');
  assertCondition(
    typeScriptRequireResult.exitCode === 0 && typeScriptRequireResult.stdout === `${typeScriptVersion}\n`,
    `browser node should expose the declared tracekernel TypeScript package version: ${JSON.stringify(typeScriptRequireResult)}`
  );

  const requireResolveResult = await workspace.runCommand([
    'node',
    '-e',
    '"console.log(require.resolve(\\"./lib/math\\").endsWith(\\"/lib/math.js\\")); console.log(require.resolve(\\"adder\\").endsWith(\\"/node_modules/adder/src/main.js\\")); console.log(require.resolve(\\"node:fs\\")); console.log(require.resolve(\\"fs\\"));"',
  ].join(' '));
  assertCondition(requireResolveResult.exitCode === 0, `browser node require.resolve should succeed: ${requireResolveResult.stderr}`);
  assertCondition(
    requireResolveResult.stdout === 'true\ntrue\nnode:fs\nfs\n',
    `browser node require.resolve should resolve files, packages, and builtins: ${requireResolveResult.stdout}`
  );

  const esmPackageResult = await workspace.runCommand('node -e "const { add } = require(\\"esadder\\"); console.log(add(1, 4))"');
  assertCondition(esmPackageResult.exitCode === 0, `browser node package ESM require should succeed: ${esmPackageResult.stderr}`);
  assertCondition(esmPackageResult.stdout === '205\n', `browser node package ESM require should resolve package exports: ${esmPackageResult.stdout}`);

  const dynamicImportPackageResult = await workspace.runCommand('node -e "const { add } = await import(\\"esadder\\"); console.log(add(1, 4))"');
  assertCondition(dynamicImportPackageResult.exitCode === 0, `browser node package ESM dynamic import should succeed: ${dynamicImportPackageResult.stderr}`);
  assertCondition(dynamicImportPackageResult.stdout === '205\n', `browser node package ESM dynamic import should resolve package exports: ${dynamicImportPackageResult.stdout}`);

  const conditionalRequireResult = await workspace.runCommand('node -e "console.log(require(\\"condpkg\\").value)"');
  assertCondition(conditionalRequireResult.exitCode === 0, `browser node conditional exports require should succeed: ${conditionalRequireResult.stderr}`);
  assertCondition(
    conditionalRequireResult.stdout === 'require-branch\n',
    `browser node require should use require export condition: ${conditionalRequireResult.stdout}`
  );

  const conditionalImportResult = await workspace.runCommand('node -e "const { value } = await import(\\"condpkg\\"); console.log(value)"');
  assertCondition(conditionalImportResult.exitCode === 0, `browser node conditional exports import should succeed: ${conditionalImportResult.stderr}`);
  assertCondition(
    conditionalImportResult.stdout === 'import-branch\n',
    `browser node import should use import export condition: ${conditionalImportResult.stdout}`
  );

  const moduleEvalResult = await workspace.runCommand('node --trace-warnings --input-type=module -e "import { add } from \\"esadder\\"; console.log(add(1, 4))"');
  assertCondition(moduleEvalResult.exitCode === 0, `browser node --input-type=module eval should succeed: ${moduleEvalResult.stderr}`);
  assertCondition(moduleEvalResult.stdout === '205\n', `browser node --input-type=module should transform static imports in eval: ${moduleEvalResult.stdout}`);

  const printResult = await workspace.runCommand('node --print "require(\\"./lib/math\\").add(3, 4)"');
  assertCondition(printResult.exitCode === 0, `browser node --print should succeed: ${printResult.stderr}`);
  assertCondition(printResult.stdout === '11\n', `browser node --print should print evaluated project expressions: ${printResult.stdout}`);

  const subpathExportResult = await workspace.runCommand('node -e "const { add } = await import(\\"subadder/feature\\"); console.log(add(1, 4))"');
  assertCondition(subpathExportResult.exitCode === 0, `browser node package subpath export import should succeed: ${subpathExportResult.stderr}`);
  assertCondition(subpathExportResult.stdout === '405\n', `browser node package subpath export should resolve through package exports: ${subpathExportResult.stdout}`);

  const modulePackageResult = await workspace.runCommand('node -e "const { add } = require(\\"modadder\\"); console.log(add(1, 4))"');
  assertCondition(modulePackageResult.exitCode === 0, `browser node package module field should succeed: ${modulePackageResult.stderr}`);
  assertCondition(modulePackageResult.stdout === '305\n', `browser node package module field should resolve ESM module entry: ${modulePackageResult.stdout}`);

  const directoryMainResult = await workspace.runCommand('node appdir alpha beta');
  assertCondition(directoryMainResult.exitCode === 0, `browser node directory main should succeed: ${directoryMainResult.stderr}`);
  assertCondition(directoryMainResult.stdout === 'appdir:alpha,beta\n', `browser node directory main should resolve package entrypoint: ${directoryMainResult.stdout}`);

  const directoryIndexResult = await workspace.runCommand('node indexdir gamma');
  assertCondition(directoryIndexResult.exitCode === 0, `browser node directory index should succeed: ${directoryIndexResult.stderr}`);
  assertCondition(directoryIndexResult.stdout === 'indexdir:gamma\n', `browser node directory index should resolve index.js: ${directoryIndexResult.stdout}`);

  const nodeModulesDirectoryResult = await workspace.runCommand('node node_modules/cliadder delta');
  assertCondition(nodeModulesDirectoryResult.exitCode === 0, `browser node node_modules directory main should succeed: ${nodeModulesDirectoryResult.stderr}`);
  assertCondition(nodeModulesDirectoryResult.stdout === 'cliadder:delta\n', `browser node node_modules directory should resolve package entrypoint: ${nodeModulesDirectoryResult.stdout}`);

  const nestedNodeModulesResult = await workspace.runCommand('node app/index.js', { cwd: 'src' });
  assertCondition(nestedNodeModulesResult.exitCode === 0, `browser node nested node_modules should succeed: ${nestedNodeModulesResult.stderr}`);
  assertCondition(
    nestedNodeModulesResult.stdout === 'nested-local\nnested-export\n',
    `browser node should prefer nearest parent node_modules packages and exports: ${nestedNodeModulesResult.stdout}`
  );

  const nodePathResult = await workspace.runCommand('node -e "console.log(require(\\"envpkg\\").value)"', {
    env: { NODE_PATH: '/workspace/vendor' },
  });
  assertCondition(nodePathResult.exitCode === 0, `browser node NODE_PATH should resolve workspace modules: ${nodePathResult.stderr}`);
  assertCondition(nodePathResult.stdout === '616\n', `browser node NODE_PATH should import from /workspace entries: ${nodePathResult.stdout}`);

  const preloadResult = await workspace.runCommand('node -r ./preload.js -e "console.log(globalThis.tracecodePreload)"');
  assertCondition(preloadResult.exitCode === 0, `browser node -r should preload workspace files: ${preloadResult.stderr}`);
  assertCondition(preloadResult.stdout === 'browser-preload\n', `browser node -r should run before eval: ${preloadResult.stdout}`);
  assertCondition(await workspace.readFile('preload.txt') === 'loaded\n', 'browser node -r side effects should persist');

  const processExitResult = await workspace.runCommand('node -e "console.log(\\"before-exit\\"); process.exit(7); console.log(\\"after-exit\\")"');
  assertCondition(processExitResult.exitCode === 7, `browser node process.exit should return the requested exit code: ${processExitResult.exitCode}`);
  assertCondition(processExitResult.stdout === 'before-exit\n', `browser node process.exit should preserve stdout before exit: ${processExitResult.stdout}`);
  assertCondition(processExitResult.stderr === '', `browser node process.exit should not print an internal error: ${processExitResult.stderr}`);

  const processExitCodeResult = await workspace.runCommand('node -e "process.exitCode = 5; console.log(\\"exit-code-set\\")"');
  assertCondition(processExitCodeResult.exitCode === 5, `browser node process.exitCode should set the final exit code: ${JSON.stringify(processExitCodeResult)}`);
  assertCondition(processExitCodeResult.stdout === 'exit-code-set\n', `browser node process.exitCode should preserve stdout: ${processExitCodeResult.stdout}`);

  const sideEffectResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); fs.writeFileSync(\\"generated.txt\\", \\"created\\\\n\\"); fs.appendFileSync(\\"lib/math.js\\", \\"// changed\\\\n\\"); fs.writeFileSync(\\"bytes.bin\\", new Uint8Array([0, 255]));"',
  ].join(' '));
  assertCondition(sideEffectResult.exitCode === 0, `browser node file side effects should succeed: ${sideEffectResult.stderr}`);
  assertCondition(await workspace.readFile('generated.txt') === 'created\n', 'browser node should persist generated text files');
  assertCondition((await workspace.readFile('lib/math.js')).endsWith('// changed\n'), 'browser node should persist modified source files');
  assertCondition(
    (await workspace.readFile('bytes.bin', 'base64')) === Buffer.from([0, 255]).toString('base64'),
    'browser node should persist generated binary files'
  );

  const deleteResult = await workspace.runCommand('node -e "require(\\"node:fs\\").unlinkSync(\\"stale.txt\\")"');
  assertCondition(deleteResult.exitCode === 0, `browser node file deletion should succeed: ${deleteResult.stderr}`);
  await assertRejectsAsync(() => workspace.readFile('stale.txt'), 'browser node should persist deleted files');

  const copyRenameResult = await workspace.runCommand([
    'node',
    '-e',
    '"(async () => { const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); fs.writeFileSync(\\"copy-source.txt\\", \\"copy-sync\\\\n\\"); fs.copyFileSync(\\"copy-source.txt\\", \\"copy-target.txt\\"); fs.renameSync(\\"copy-target.txt\\", \\"renamed-target.txt\\"); await fsp.writeFile(\\"async-copy-source.txt\\", \\"copy-async\\\\n\\"); await fsp.copyFile(\\"async-copy-source.txt\\", \\"async-copy-target.txt\\"); await fsp.rename(\\"async-copy-target.txt\\", \\"async-renamed-target.txt\\"); })();"',
  ].join(' '));
  assertCondition(copyRenameResult.exitCode === 0, `browser node copy/rename workflow should succeed: ${copyRenameResult.stderr}`);
  assertCondition(await workspace.readFile('renamed-target.txt') === 'copy-sync\n', 'browser node should persist copyFileSync/renameSync results');
  assertCondition(await workspace.readFile('async-renamed-target.txt') === 'copy-async\n', 'browser node should persist fs.promises copyFile/rename results');
  await assertRejectsAsync(() => workspace.readFile('copy-target.txt'), 'browser node renameSync should remove the old target path');
  await assertRejectsAsync(() => workspace.readFile('async-copy-target.txt'), 'browser node async rename should remove the old target path');

  const mkdirReturnResult = await workspace.runCommand([
    'node',
    '-e',
    '"(async () => { const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const call = (fn) => new Promise((resolve, reject) => fn((error, value) => error ? reject(error) : resolve(value))); console.log(fs.mkdirSync(\\"mkdir-return-sync/a\\", { recursive: true })); console.log(String(fs.mkdirSync(\\"mkdir-return-sync/a\\", { recursive: true }))); console.log(await call((done) => fs.mkdir(\\"mkdir-return-callback/a\\", { recursive: true }, done))); console.log(await fsp.mkdir(\\"mkdir-return-promise/a\\", { recursive: true })); console.log(fs.mkdirSync(\\"/workspace/mkdir-return-absolute/a\\", { recursive: true })); })();"',
  ].join(' '));
  assertCondition(mkdirReturnResult.exitCode === 0, `browser node mkdir return workflow should succeed: ${mkdirReturnResult.stderr}`);
  assertCondition(
    mkdirReturnResult.stdout === 'mkdir-return-sync\nundefined\nmkdir-return-callback\nmkdir-return-promise\n/workspace/mkdir-return-absolute\n',
    `browser node recursive mkdir should return the first created directory like Node: ${JSON.stringify(mkdirReturnResult)}`
  );

  const renameDirectoryEvents: RuntimeCommandEvent[] = [];
  const renameDirectoryResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); fs.mkdirSync(\\"rename-tree/child\\", { recursive: true }); fs.mkdirSync(\\"rename-tree/empty\\"); fs.writeFileSync(\\"rename-tree/child/value.txt\\", \\"moved\\\\n\\"); fs.chmodSync(\\"rename-tree/empty\\", 0o711); fs.utimesSync(\\"rename-tree/empty\\", 100, 200); fs.chmodSync(\\"rename-tree/child/value.txt\\", 0o600); fs.utimesSync(\\"rename-tree/child/value.txt\\", 300, 400); fs.renameSync(\\"rename-tree\\", \\"renamed-tree\\"); await fsp.mkdir(\\"async-rename-tree/child\\", { recursive: true }); await fsp.writeFile(\\"async-rename-tree/child/value.txt\\", \\"async-moved\\\\n\\"); await fsp.rename(\\"async-rename-tree\\", \\"async-renamed-tree\\"); console.log(fs.readFileSync(\\"renamed-tree/child/value.txt\\", \\"utf8\\")); console.log(fs.statSync(\\"renamed-tree/empty\\").isDirectory()); console.log(await fsp.readFile(\\"async-renamed-tree/child/value.txt\\", \\"utf8\\"));"',
  ].join(' '), { onEvent: (event) => renameDirectoryEvents.push(event) });
  assertCondition(renameDirectoryResult.exitCode === 0, `browser node directory rename workflow should succeed: ${renameDirectoryResult.stderr}`);
  assertCondition(
    renameDirectoryResult.stdout === 'moved\n\ntrue\nasync-moved\n\n',
    `browser node directory rename should match desktop-like fs output: ${renameDirectoryResult.stdout}`
  );
  assertCondition(await workspace.readFile('renamed-tree/child/value.txt') === 'moved\n', 'browser node renameSync should persist moved directory files');
  assertCondition((await workspace.stat('renamed-tree/empty')).isDirectory, 'browser node renameSync should persist moved empty directories');
  const renamedEmptyStat = await workspace.stat('renamed-tree/empty');
  const renamedFileStat = await workspace.stat('renamed-tree/child/value.txt');
  assertCondition(
    renamedEmptyStat.mode === 0o711 && renamedEmptyStat.mtimeMs === 200_000,
    `browser node directory rename should preserve directory mode and mtime: ${JSON.stringify(renamedEmptyStat)}`
  );
  assertCondition(
    renamedFileStat.mode === 0o600 && renamedFileStat.mtimeMs === 400_000,
    `browser node directory rename should preserve child file mode and mtime: ${JSON.stringify(renamedFileStat)}`
  );
  await assertRejectsAsync(() => workspace.readFile('rename-tree/child/value.txt'), 'browser node renameSync should remove old directory files');
  assertCondition(await workspace.readFile('async-renamed-tree/child/value.txt') === 'async-moved\n', 'browser node async rename should persist moved directory files');
  await assertRejectsAsync(() => workspace.readFile('async-rename-tree/child/value.txt'), 'browser node async rename should remove old directory files');
  assertCondition(
    renameDirectoryEvents.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'rename-tree/child/value.txt' &&
      looseChange(event.change).deleted === true
    ) &&
      renameDirectoryEvents.some((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change.path === 'renamed-tree/child/value.txt' &&
        'contents' in event.change
      ) &&
      renameDirectoryEvents.some((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change.path === 'rename-tree/empty' &&
        looseChange(event.change).directory === true &&
        looseChange(event.change).deleted === true
      ) &&
      renameDirectoryEvents.some((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change.path === 'renamed-tree/empty' &&
        looseChange(event.change).directory === true &&
        looseChange(event.change).deleted !== true
      ),
    `browser node directory rename should stream live old-tree deletes and new-tree snapshots: ${JSON.stringify(renameDirectoryEvents)}`
  );

  await workspace.writeFile('rename-self-file.txt', 'self\n');
  await workspace.mkdir('rename-self-dir');
  await workspace.writeFile('rename-self-dir/value.txt', 'dir\n');
  const renameSelfEvents: RuntimeCommandEvent[] = [];
  const renameSelfResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const code = (fn) => { try { fn(); return \\"ok\\"; } catch (error) { return error.code; } }; console.log(code(() => fs.renameSync(\\"rename-self-file.txt\\", \\"rename-self-file.txt\\"))); console.log(code(() => fs.renameSync(\\"rename-self-dir\\", \\"rename-self-dir\\"))); console.log(code(() => fs.renameSync(\\"missing-self-rename.txt\\", \\"missing-self-rename.txt\\"))); console.log(fs.readFileSync(\\"rename-self-file.txt\\", \\"utf8\\")); console.log(fs.readFileSync(\\"rename-self-dir/value.txt\\", \\"utf8\\"));"',
  ].join(' '), { onEvent: (event) => renameSelfEvents.push(event) });
  assertCondition(renameSelfResult.exitCode === 0, `browser node self rename workflow should succeed: ${renameSelfResult.stderr}`);
  assertCondition(
    renameSelfResult.stdout === 'ok\nok\nENOENT\nself\n\ndir\n\n',
    `browser node self renames should match desktop no-op semantics: ${renameSelfResult.stdout}`
  );
  assertCondition(
    renameSelfEvents.some((event) => (
      event.type === 'file-change' &&
      (event.change.path === 'rename-self-file.txt' || event.change.path.startsWith('rename-self-dir'))
    )) !== true,
    `browser node self renames should not emit live file mutations: ${JSON.stringify(renameSelfEvents)}`
  );

  const copyModeResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const call = (fn) => new Promise((resolve, reject) => fn((error) => error ? reject(error) : resolve())); fs.writeFileSync(\\"copy-mode-source.txt\\", \\"source\\"); fs.writeFileSync(\\"copy-mode-target.txt\\", \\"target\\"); try { fs.copyFileSync(\\"copy-mode-source.txt\\", \\"copy-mode-target.txt\\", fs.constants.COPYFILE_EXCL); } catch (error) { console.log(error.code); } try { await call((done) => fs.copyFile(\\"copy-mode-source.txt\\", \\"copy-mode-target.txt\\", fs.COPYFILE_EXCL, done)); } catch (error) { console.log(error.code); } try { await fsp.copyFile(\\"copy-mode-source.txt\\", \\"copy-mode-target.txt\\", fsp.constants.COPYFILE_EXCL); } catch (error) { console.log(error.code); } fs.copyFileSync(\\"copy-mode-source.txt\\", \\"copy-mode-created.txt\\", fs.constants.COPYFILE_EXCL); console.log(fs.constants.COPYFILE_EXCL, fs.COPYFILE_EXCL); console.log(fs.readFileSync(\\"copy-mode-target.txt\\", \\"utf8\\")); console.log(fs.readFileSync(\\"copy-mode-created.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(copyModeResult.exitCode === 0, `browser node copyFile mode workflow should succeed: ${copyModeResult.stderr}`);
  assertCondition(
    copyModeResult.stdout === 'EEXIST\nEEXIST\nEEXIST\n1 1\ntarget\nsource\n',
    `browser node copyFile should support COPYFILE_EXCL modes: ${copyModeResult.stdout}`
  );

  const linkEvents: RuntimeCommandEvent[] = [];
  const linkResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const call = (fn) => new Promise((resolve, reject) => fn((error, value) => error ? reject(error) : resolve(value))); fs.writeFileSync(\\"link-source.txt\\", \\"linked\\\\n\\"); fs.linkSync(\\"link-source.txt\\", \\"link-sync.txt\\"); await call((done) => fs.link(\\"link-source.txt\\", \\"link-callback.txt\\", done)); await fsp.link(\\"link-source.txt\\", \\"link-async.txt\\"); for (const op of [\\"readlink\\", \\"symlink\\", \\"symlink-dev\\", \\"link-proc\\"]) { try { if (op === \\"readlink\\") fs.readlinkSync(\\"link-source.txt\\"); else if (op === \\"symlink\\") fs.symlinkSync(\\"link-source.txt\\", \\"link-symlink.txt\\"); else if (op === \\"symlink-dev\\") await fsp.symlink(\\"link-source.txt\\", \\"/dev/stdout\\"); else await fsp.link(\\"/proc/kernel/info\\", \\"link-proc.txt\\"); console.log(op + \\":ok\\"); } catch (error) { console.log(op + \\":\\" + error.code); } } console.log(fs.readFileSync(\\"link-sync.txt\\", \\"utf8\\") + fs.readFileSync(\\"link-callback.txt\\", \\"utf8\\") + await fsp.readFile(\\"link-async.txt\\", \\"utf8\\")); fs.writeFileSync(\\"link-sync.txt\\", \\"mutated\\\\n\\"); const sourceStat = fs.statSync(\\"link-source.txt\\"); const callbackStat = fs.statSync(\\"link-callback.txt\\"); console.log(sourceStat.nlink + \\":\\" + callbackStat.nlink + \\":\\" + (sourceStat.ino === callbackStat.ino)); console.log(fs.readFileSync(\\"link-source.txt\\", \\"utf8\\") + fs.readFileSync(\\"link-async.txt\\", \\"utf8\\")); fs.unlinkSync(\\"link-source.txt\\"); console.log(fs.existsSync(\\"link-source.txt\\") + \\":\\" + fs.statSync(\\"link-sync.txt\\").nlink + \\":\\" + fs.readFileSync(\\"link-callback.txt\\", \\"utf8\\"));"',
  ].join(' '), { onEvent: (event) => linkEvents.push(event) });
  assertCondition(linkResult.exitCode === 0, `browser node link workflow should succeed: ${linkResult.stderr}`);
  assertCondition(
    linkResult.stdout === 'readlink:EINVAL\nsymlink:ok\nsymlink-dev:EROFS\nlink-proc:EROFS\nlinked\nlinked\nlinked\n\n4:4:true\nmutated\nmutated\n\nfalse:3:mutated\n\n',
    `browser node link/readlink/symlink APIs should have stable kernel-aligned semantics: ${linkResult.stdout}`
  );
  await assertRejectsAsync(() => workspace.readFile('link-source.txt'), 'browser node unlink should remove only one hard-link name');
  assertCondition(await workspace.readFile('link-sync.txt') === 'mutated\n', 'browser node hard-link writes should persist through linked names');
  assertCondition(await workspace.readFile('link-callback.txt') === 'mutated\n', 'browser node callback hard link should share linked file contents');
  assertCondition(await workspace.readFile('link-async.txt') === 'mutated\n', 'browser node fs.promises hard link should share linked file contents');
  assertCondition(
    (await workspace.snapshot()).symlinks?.some((symlink) => (
      symlink.path === 'link-symlink.txt' && symlink.target === 'link-source.txt'
    )) === true,
    'browser node symlink creation should persist the link identity instead of flattening or dropping it'
  );
  assertCondition(
    linkEvents.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'link-sync.txt' &&
      'contents' in event.change &&
      event.change.contents === 'linked\n'
    ) &&
      linkEvents.some((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change.path === 'link-callback.txt' &&
        'contents' in event.change
      ) &&
      linkEvents.some((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change.path === 'link-async.txt' &&
        'contents' in event.change
      ),
    `browser node link APIs should stream live file snapshots: ${JSON.stringify(linkEvents)}`
  );

  const symlinkEvents: RuntimeCommandEvent[] = [];
  const symlinkResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const code = (fn) => { try { fn(); return \\"ok\\"; } catch (error) { return error.code; } }; fs.writeFileSync(\\"symlink-target.txt\\", \\"one\\n\\"); fs.symlinkSync(\\"symlink-target.txt\\", \\"symlink-alias.txt\\"); console.log(fs.readlinkSync(\\"symlink-alias.txt\\")); console.log(fs.lstatSync(\\"symlink-alias.txt\\").isSymbolicLink(), fs.statSync(\\"symlink-alias.txt\\").isFile(), fs.readdirSync(\\".\\", { withFileTypes: true }).find((entry) => entry.name === \\"symlink-alias.txt\\").isSymbolicLink()); fs.writeFileSync(\\"symlink-alias.txt\\", \\"two\\n\\"); console.log(fs.readFileSync(\\"symlink-target.txt\\", \\"utf8\\").trim()); fs.unlinkSync(\\"symlink-alias.txt\\"); console.log(fs.existsSync(\\"symlink-target.txt\\"), fs.existsSync(\\"symlink-alias.txt\\")); fs.symlinkSync(\\"created-through-link.txt\\", \\"dangling-link.txt\\"); console.log(fs.lstatSync(\\"dangling-link.txt\\").isSymbolicLink(), code(() => fs.statSync(\\"dangling-link.txt\\")), fs.existsSync(\\"dangling-link.txt\\")); fs.writeFileSync(\\"dangling-link.txt\\", \\"created\\n\\"); console.log(fs.readFileSync(\\"created-through-link.txt\\", \\"utf8\\").trim()); fs.symlinkSync(\\"loop-b\\", \\"loop-a\\"); fs.symlinkSync(\\"loop-a\\", \\"loop-b\\"); console.log(code(() => fs.statSync(\\"loop-a\\"))); fs.mkdirSync(\\"linked-dir\\"); fs.writeFileSync(\\"linked-dir/value.txt\\", \\"directory\\n\\"); fs.symlinkSync(\\"linked-dir\\", \\"dir-alias\\"); console.log(fs.readFileSync(\\"dir-alias/value.txt\\", \\"utf8\\").trim(), fs.readdirSync(\\"dir-alias\\").join(\\",\\")); fs.writeFileSync(\\"linked-dir/module.js\\", \\"module.exports = 41;\\n\\"); fs.symlinkSync(\\"linked-dir/module.js\\", \\"module-alias.js\\"); console.log(require(\\"./module-alias.js\\") + require(\\"./dir-alias/module.js\\")); await fsp.symlink(\\"symlink-target.txt\\", \\"async-alias.txt\\"); console.log(await fsp.readlink(\\"async-alias.txt\\"), (await fsp.lstat(\\"async-alias.txt\\")).isSymbolicLink());"',
  ].join(' '), { onEvent: (event) => symlinkEvents.push(event) });
  assertCondition(symlinkResult.exitCode === 0, `browser node symlink workflow should succeed: ${symlinkResult.stderr}`);
  assertCondition(
    symlinkResult.stdout === 'symlink-target.txt\ntrue true true\ntwo\ntrue false\ntrue ENOENT false\ncreated\nELOOP\ndirectory value.txt\n82\nsymlink-target.txt true\n',
    `browser node symlinks should follow native stat, read, write, directory, dangling-link, and loop semantics: ${symlinkResult.stdout}`
  );
  assertCondition(
    symlinkEvents.some((event) => (
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'async-alias.txt' &&
      'symlink' in event.change &&
      event.change.symlink === true &&
      event.change.target === 'symlink-target.txt'
    )),
    `browser node symlink APIs should stream first-class link mutations: ${JSON.stringify(symlinkEvents)}`
  );

  const cpEvents: RuntimeCommandEvent[] = [];
  const cpResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const call = (fn) => new Promise((resolve, reject) => fn((error) => error ? reject(error) : resolve())); fs.mkdirSync(\\"cp-src/nested\\", { recursive: true }); fs.mkdirSync(\\"cp-src/empty\\", { recursive: true }); fs.writeFileSync(\\"cp-src/root.txt\\", \\"root\\\\n\\"); fs.writeFileSync(\\"cp-src/nested/value.txt\\", \\"nested\\\\n\\"); fs.cpSync(\\"cp-src\\", \\"cp-sync\\", { recursive: true }); await call((done) => fs.cp(\\"cp-sync/root.txt\\", \\"cp-callback.txt\\", done)); await fsp.cp(\\"cp-sync\\", \\"cp-async\\", { recursive: true, filter: (source) => !source.endsWith(\\"nested/value.txt\\") }); fs.cpSync(\\"cp-src/root.txt\\", \\"cp-skip.txt\\"); fs.cpSync(\\"cp-src/nested/value.txt\\", \\"cp-skip.txt\\", { force: false }); fs.writeFileSync(\\"cp-file-target.txt\\", \\"file-target\\\\n\\"); for (const [source, target] of [[\\"cp-src\\", \\"cp-file-target.txt\\"], [\\"cp-src\\", \\"cp-src\\"], [\\"cp-src\\", \\"cp-src/nested/self-copy\\"]]) { try { fs.cpSync(source, target, { recursive: true }); } catch (error) { console.log(error.code); } } console.log(fs.readFileSync(\\"cp-sync/nested/value.txt\\", \\"utf8\\").trim()); console.log(fs.readFileSync(\\"cp-callback.txt\\", \\"utf8\\").trim()); console.log(fs.statSync(\\"cp-sync/empty\\").isDirectory()); console.log(fs.existsSync(\\"cp-async/nested/value.txt\\")); console.log(fs.readFileSync(\\"cp-skip.txt\\", \\"utf8\\").trim()); console.log(fs.readFileSync(\\"cp-file-target.txt\\", \\"utf8\\").trim()); console.log(fs.existsSync(\\"cp-src/nested/self-copy\\"));"',
  ].join(' '), { onEvent: (event) => cpEvents.push(event) });
  assertCondition(cpResult.exitCode === 0, `browser node cp workflow should succeed: ${cpResult.stderr}`);
  assertCondition(
    cpResult.stdout === 'ERR_FS_CP_DIR_TO_NON_DIR\nERR_FS_CP_EINVAL\nERR_FS_CP_EINVAL\nnested\nroot\ntrue\nfalse\nroot\nfile-target\nfalse\n',
    `browser node cp APIs should copy files, directories, filters, and force=false semantics: ${cpResult.stdout}`
  );
  assertCondition(await workspace.readFile('cp-sync/nested/value.txt') === 'nested\n', 'browser node cpSync should persist recursive copied files');

  const cpVirtualResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); fs.cpSync(\\"/proc/kernel/info\\", \\"cp-proc-info.json\\"); console.log(JSON.parse(fs.readFileSync(\\"cp-proc-info.json\\", \\"utf8\\")).name); fs.cpSync(\\"cp-proc-info.json\\", \\"/dev/stdout\\"); try { fs.cpSync(\\"/proc\\", \\"cp-proc-dir\\"); } catch (error) { console.log(error.code); }"'
  ].join(' '));
  assertCondition(cpVirtualResult.exitCode === 0, `browser node cp virtual workflow should succeed: ${cpVirtualResult.stderr}`);
  assertCondition(
    cpVirtualResult.stdout === 'tracekernel\n' + (await workspace.readFile('cp-proc-info.json')) + 'EISDIR\n',
    `browser node cp should route virtual source/destination through tracekernel: ${cpVirtualResult.stdout}`
  );
  assertCondition(await workspace.readFile('cp-callback.txt') === 'root\n', 'browser node cp callback should persist copied files');
  assertCondition(
    cpEvents.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'cp-sync/nested/value.txt' &&
      looseChange(event.change).contents === 'nested\n'
    ),
    `browser node cp should emit live file changes: ${JSON.stringify(cpEvents)}`
  );

  const inspectResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); fs.mkdirSync(\\"tree/nested\\", { recursive: true }); fs.writeFileSync(\\"tree/nested/value.txt\\", \\"nested\\\\n\\"); console.log(fs.statSync(\\"lib/math.js\\").isFile()); console.log(fs.statSync(\\"tree\\").isDirectory()); console.log(fs.readdirSync(\\"/workspace\\").includes(\\"tree\\")); console.log(fs.readdirSync(\\"tree/nested\\").join(\\"\\,\\")); fs.rmSync(\\"tree\\", { recursive: true }); console.log(fs.existsSync(\\"tree/nested/value.txt\\"));"',
  ].join(' '));
  assertCondition(inspectResult.exitCode === 0, `browser node fs inspection should succeed: ${inspectResult.stderr}`);
  assertCondition(
    inspectResult.stdout === 'true\ntrue\ntrue\nvalue.txt\nfalse\n',
    `browser node fs inspection should match desktop-like sync fs APIs: ${inspectResult.stdout}`
  );
  await assertRejectsAsync(() => workspace.readFile('tree/nested/value.txt'), 'browser node recursive rm should persist deleted nested files');

  const promisesResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fsp = require(\\"node:fs/promises\\"); const fs = require(\\"node:fs\\"); await fsp.mkdir(\\"async-dir\\", { recursive: true }); await fsp.writeFile(\\"async-dir/value.txt\\", \\"async\\\\n\\"); await fs.promises.appendFile(\\"async-dir/value.txt\\", \\"append\\\\n\\"); console.log(await fsp.readFile(\\"async-dir/value.txt\\", \\"utf8\\")); console.log((await fsp.stat(\\"async-dir\\")).isDirectory()); console.log((await fsp.lstat(\\"async-dir/value.txt\\")).isFile()); console.log((await fsp.readdir(\\"async-dir\\")).join(\\"\\,\\")); await fsp.rm(\\"async-dir\\", { recursive: true }); console.log(fs.existsSync(\\"async-dir/value.txt\\"));"',
  ].join(' '));
  assertCondition(promisesResult.exitCode === 0, `browser node fs promises should succeed: ${promisesResult.stderr}`);
  assertCondition(
    promisesResult.stdout === 'async\nappend\n\ntrue\ntrue\nvalue.txt\nfalse\n',
    `browser node fs promises should match desktop-like async fs APIs: ${promisesResult.stdout}`
  );
  await assertRejectsAsync(() => workspace.readFile('async-dir/value.txt'), 'browser node fs promises rm should persist deleted nested files');

  const opendirResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const call = (fn) => new Promise((resolve, reject) => fn((error, value) => error ? reject(error) : resolve(value))); fs.mkdirSync(\\"open-dir/sub\\", { recursive: true }); fs.writeFileSync(\\"open-dir/file.txt\\", \\"x\\"); const syncDir = fs.opendirSync(\\"open-dir\\"); const first = syncDir.readSync(); const second = syncDir.readSync(); const third = syncDir.readSync(); syncDir.closeSync(); const callbackDir = await call((done) => fs.opendir(\\"open-dir\\", done)); const callbackEntry = await call((done) => callbackDir.read(done)); await call((done) => callbackDir.close(done)); const promiseReadDir = await fsp.opendir(\\"open-dir\\"); const promiseFirst = await promiseReadDir.read(); const promiseSecond = await promiseReadDir.read(); const promiseThird = await promiseReadDir.read(); await promiseReadDir.close(); const promiseDir = await fsp.opendir(\\"open-dir\\"); const iterated = []; for await (const entry of promiseDir) iterated.push(entry.name + \\":\\" + entry.isDirectory()); console.log([first.name + \\":\\" + first.isFile(), second.name + \\":\\" + second.isDirectory(), third].join(\\"|\\")); console.log(callbackEntry.name); console.log([promiseFirst.name + \\":\\" + promiseFirst.isFile(), promiseSecond.name + \\":\\" + promiseSecond.isDirectory(), promiseThird === null].join(\\"|\\")); console.log(iterated.sort().join(\\"|\\"));"',
  ].join(' '));
  assertCondition(opendirResult.exitCode === 0, `browser node opendir workflow should succeed: ${opendirResult.stderr}`);
  assertCondition(
    opendirResult.stdout === 'file.txt:true|sub:true|\nfile.txt\nfile.txt:true|sub:true|true\nfile.txt:false|sub:true\n',
    `browser node opendir APIs should iterate kernel directories: ${opendirResult.stdout}`
  );

  const accessResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); fs.writeFileSync(\\"access.txt\\", \\"ok\\\\n\\"); fs.accessSync(\\"access.txt\\", fs.constants.R_OK | fs.constants.W_OK); console.log(fs.F_OK, fs.constants.R_OK, fs.constants.W_OK); await fsp.access(\\"access.txt\\", fsp.constants.R_OK); await new Promise((resolve, reject) => fs.access(\\"/dev/stdout\\", fs.constants.W_OK, (error) => error ? reject(error) : resolve())); try { fs.accessSync(\\"missing.txt\\"); } catch (error) { console.log(error.code); }"',
  ].join(' '));
  assertCondition(accessResult.exitCode === 0, `browser node fs access workflow should succeed: ${accessResult.stderr}`);
  assertCondition(
    accessResult.stdout === '0 4 2\nENOENT\n',
    `browser node fs access APIs should expose constants and missing-file errors: ${accessResult.stdout}`
  );

  const openConstantsResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const constants = fs.constants; console.log(fs.O_CREAT === constants.O_CREAT, fs.O_APPEND === constants.O_APPEND, fsp.constants.O_TRUNC === constants.O_TRUNC); const fd = fs.openSync(\\"numeric-open.txt\\", constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC); fs.writeSync(fd, \\"one\\"); fs.closeSync(fd); const appendFd = fs.openSync(\\"numeric-open.txt\\", fs.O_WRONLY | fs.O_APPEND); fs.writeSync(appendFd, \\"two\\"); fs.closeSync(appendFd); try { fs.openSync(\\"numeric-open.txt\\", fs.O_CREAT | fs.O_EXCL | fs.O_WRONLY); } catch (error) { console.log(error.code); } const exclReadFd = fs.openSync(\\"numeric-open.txt\\", fs.O_RDONLY | fs.O_EXCL); console.log(fs.readFileSync(exclReadFd, \\"utf8\\")); fs.closeSync(exclReadFd); const readFd = fs.openSync(\\"numeric-open.txt\\", fs.O_RDONLY); console.log(fs.readFileSync(readFd, \\"utf8\\")); fs.closeSync(readFd); console.log((fs.statSync(\\"numeric-open.txt\\").mode & fs.S_IFMT) === fs.S_IFREG); console.log(Boolean(fs.S_IFDIR && fs.S_IFLNK));"',
  ].join(' '));
  assertCondition(openConstantsResult.exitCode === 0, `browser node numeric open constants workflow should succeed: ${openConstantsResult.stderr}`);
  assertCondition(
    openConstantsResult.stdout === 'true true true\nEEXIST\nonetwo\nonetwo\ntrue\ntrue\n',
    `browser node fs should expose and honor common numeric open/mode constants: ${openConstantsResult.stdout}`
  );

  const directoryOpenResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); fs.mkdirSync(\\"open-directory/nested\\", { recursive: true }); fs.writeFileSync(\\"open-directory/nested/value.txt\\", \\"dir-file\\\\n\\"); const fd = fs.openSync(\\"open-directory\\", \\"r\\"); console.log(fs.fstatSync(fd).isDirectory()); try { fs.readFileSync(fd); } catch (error) { console.log(error.code); } fs.closeSync(fd); for (const flags of [\\"w\\", \\"a\\", \\"r+\\", \\"w+\\", \\"a+\\"]) { try { fs.openSync(\\"open-directory\\", flags); console.log(flags + \\":ok\\"); } catch (error) { console.log(flags + \\":\\" + error.code); } } console.log(fs.statSync(\\"open-directory\\").isDirectory()); console.log(fs.readFileSync(\\"open-directory/nested/value.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(directoryOpenResult.exitCode === 0, `browser node directory open workflow should succeed: ${directoryOpenResult.stderr}`);
  assertCondition(
    directoryOpenResult.stdout === 'true\nEISDIR\nw:EISDIR\na:EISDIR\nr+:EISDIR\nw+:EISDIR\na+:EISDIR\ntrue\ndir-file\n\n',
    `browser node open should preserve directory paths and reject write-mode directory opens: ${directoryOpenResult.stdout}`
  );

  const accessModeResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const call = (fn) => new Promise((resolve, reject) => fn((error) => error ? reject(error) : resolve())); fs.writeFileSync(\\"access-mode.txt\\", \\"ok\\\\n\\"); fs.chmodSync(\\"access-mode.txt\\", 0o400); try { fs.accessSync(\\"access-mode.txt\\", fs.constants.W_OK); } catch (error) { console.log(error.code); } try { await fsp.access(\\"access-mode.txt\\", fsp.constants.X_OK); } catch (error) { console.log(error.code); } await call((done) => fs.access(\\"access-mode.txt\\", fs.constants.R_OK, done)); try { fs.accessSync(\\"/dev/stdout\\", fs.constants.R_OK); } catch (error) { console.log(error.code); }"',
  ].join(' '));
  assertCondition(accessModeResult.exitCode === 0, `browser node fs access mode workflow should succeed: ${accessModeResult.stderr}`);
  assertCondition(
    accessModeResult.stdout === 'EACCES\nEACCES\nEACCES\n',
    `browser node fs access should enforce tracked mode and device permissions: ${accessModeResult.stdout}`
  );

  const metadataResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const call = (fn) => new Promise((resolve, reject) => fn((error) => error ? reject(error) : resolve())); const code = (fn) => { try { fn(); return \\"ok\\"; } catch (error) { return error.code; } }; fs.writeFileSync(\\"metadata.txt\\", \\"meta\\\\n\\"); fs.chmodSync(\\"metadata.txt\\", 0o755); console.log(code(() => fs.chownSync(\\"metadata.txt\\", 1, 1))); fs.chownSync(\\"metadata.txt\\", 1000, 1000); fs.utimesSync(\\"metadata.txt\\", new Date(0), new Date(0)); await call((done) => fs.chmod(\\"metadata.txt\\", 0o644, done)); await call((done) => fs.chown(\\"metadata.txt\\", 1000, 1000, done)); await call((done) => fs.utimes(\\"metadata.txt\\", 1, 1, done)); const fd = fs.openSync(\\"metadata.txt\\", \\"r+\\"); fs.fchmodSync(fd, 0o600); console.log(code(() => fs.fchownSync(fd, 3, 3))); fs.fchownSync(fd, 1000, 1000); fs.futimesSync(fd, 2, 2); await call((done) => fs.fchmod(fd, 0o600, done)); await call((done) => fs.fchown(fd, 1000, 1000, done)); await call((done) => fs.futimes(fd, 3, 3, done)); fs.closeSync(fd); await fsp.chmod(\\"metadata.txt\\", 0o644); await fsp.chown(\\"metadata.txt\\", 1000, 1000); await fsp.utimes(\\"metadata.txt\\", 4, 4); const handle = await fsp.open(\\"metadata.txt\\", \\"r+\\"); await handle.chmod(0o644); await handle.chown(1000, 1000); await handle.utimes(5, 5); await handle.close(); console.log(fs.readFileSync(\\"metadata.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(metadataResult.exitCode === 0, `browser node metadata no-op workflow should succeed: ${metadataResult.stderr}`);
  assertCondition(
    metadataResult.stdout === 'EPERM\nEPERM\nmeta\n\n',
    `browser node metadata APIs should validate and preserve file contents: ${metadataResult.stdout}`
  );

  const statsMetadataResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const flush = () => new Promise((resolve) => queueMicrotask(resolve)); fs.writeFileSync(\\"stats-meta.txt\\", \\"abcdef\\"); const changes = []; fs.watchFile(\\"stats-meta.txt\\", (curr, prev) => changes.push((prev.mode & 0o777).toString(8) + \\"->\\" + (curr.mode & 0o777).toString(8) + \\":\\" + prev.uid + \\"->\\" + curr.uid + \\":\\" + (prev.mtimeMs === curr.mtimeMs))); fs.chmodSync(\\"stats-meta.txt\\", 0o751); await flush(); fs.chownSync(\\"stats-meta.txt\\", 1000, 1000); await flush(); fs.utimesSync(\\"stats-meta.txt\\", new Date(1000), new Date(2000)); await flush(); fs.unwatchFile(\\"stats-meta.txt\\"); const fd = fs.openSync(\\"stats-meta.txt\\", \\"r+\\"); fs.fchmodSync(fd, 0o640); fs.fchownSync(fd, 1000, 1000); fs.futimesSync(fd, 3, 4); const fstat = fs.fstatSync(fd); fs.closeSync(fd); const handle = await fsp.open(\\"stats-meta.txt\\", \\"r+\\"); await handle.chmod(0o600); await handle.chown(1000, 1000); await handle.utimes(5, 6); const hstat = await handle.stat(); await handle.close(); const stat = fs.statSync(\\"stats-meta.txt\\"); console.log(changes.join(\\"|\\")); console.log((fstat.mode & 0o777).toString(8), fstat.uid, fstat.gid, fstat.mtimeMs); console.log((stat.mode & 0o777).toString(8), stat.uid, stat.gid, stat.mtimeMs, stat.size, stat.blocks, stat.blksize, stat.nlink, stat.ino > 0); console.log(stat.isFile(), stat.isDirectory(), stat.isBlockDevice(), stat.isCharacterDevice(), stat.isFIFO(), stat.isSocket(), stat.isSymbolicLink()); console.log((hstat.mode & 0o777).toString(8), hstat.uid, hstat.gid, hstat.mtime.getTime());"',
  ].join(' '));
  assertCondition(statsMetadataResult.exitCode === 0, `browser node Stats metadata workflow should succeed: ${statsMetadataResult.stderr}`);
  assertCondition(
    statsMetadataResult.stdout === '644->751:1000->1000:true|751->751:1000->1000:false\n640 1000 1000 4000\n600 1000 1000 6000 6 1 4096 1 true\ntrue false false false false false false\n600 1000 1000 6000\n',
    `browser node Stats metadata should track mode, owner, times, and predicates: ${statsMetadataResult.stdout}`
  );

  const bigintStatsResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const call = (fn) => new Promise((resolve, reject) => fn((error, stats) => error ? reject(error) : resolve(stats))); fs.writeFileSync(\\"bigint-stats.txt\\", \\"abcdef\\"); const stat = fs.statSync(\\"bigint-stats.txt\\", { bigint: true }); const lstat = await fsp.lstat(\\"bigint-stats.txt\\", { bigint: true }); const callbackStat = await call((done) => fs.stat(\\"bigint-stats.txt\\", { bigint: true }, done)); const fd = fs.openSync(\\"bigint-stats.txt\\", \\"r\\"); const fstat = fs.fstatSync(fd, { bigint: true }); const callbackFstat = await call((done) => fs.fstat(fd, { bigint: true }, done)); fs.closeSync(fd); const proc = await fsp.stat(\\"/proc/kernel/info\\", { bigint: true }); const handle = await fsp.open(\\"bigint-stats.txt\\", \\"r\\"); const handleStat = await handle.stat({ bigint: true }); await handle.close(); console.log(typeof stat.size + \\":\\" + stat.size.toString() + \\":\\" + typeof stat.mode + \\":\\" + stat.isFile()); console.log(typeof lstat.ino + \\":\\" + typeof callbackStat.blocks + \\":\\" + callbackStat.size.toString()); console.log(typeof fstat.size + \\":\\" + fstat.size.toString() + \\":\\" + callbackFstat.size.toString()); console.log(typeof proc.size + \\":\\" + proc.isFile() + \\":\\" + handleStat.size.toString());"',
  ].join(' '));
  assertCondition(bigintStatsResult.exitCode === 0, `browser node BigInt Stats workflow should succeed: ${bigintStatsResult.stderr}`);
  assertCondition(
    bigintStatsResult.stdout === 'bigint:6:bigint:true\nbigint:bigint:6\nbigint:6:6\nbigint:true:6\n',
    `browser node stat/lstat/fstat APIs should honor { bigint: true }: ${bigintStatsResult.stdout}`
  );

  const throwIfNoEntryStatsResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const callStat = (path) => new Promise((resolve, reject) => fs.stat(path, { throwIfNoEntry: false }, (error, stats) => error ? reject(error) : resolve(stats))); const callLstat = (path) => new Promise((resolve) => fs.lstat(path, { throwIfNoEntry: false }, (error) => resolve(error && error.code))); console.log(fs.statSync(\\"missing-stat.txt\\", { throwIfNoEntry: false }) === undefined); console.log(fs.lstatSync(\\"missing-lstat.txt\\", { throwIfNoEntry: false }) === undefined); console.log(fs.statSync(\\"/proc/missing\\", { throwIfNoEntry: false }) === undefined); console.log(fs.lstatSync(\\"/dev/missing\\", { throwIfNoEntry: false }) === undefined); console.log(await fsp.stat(\\"missing-promise.txt\\", { throwIfNoEntry: false }) === undefined); console.log(await callStat(\\"missing-callback.txt\\") === undefined); try { await fsp.lstat(\\"missing-promise-lstat.txt\\", { throwIfNoEntry: false }); } catch (error) { console.log(error.code); } console.log(await callLstat(\\"missing-callback-lstat.txt\\")); try { fs.statfsSync(\\"missing-statfs.txt\\", { throwIfNoEntry: false }); } catch (error) { console.log(error.code); }"',
  ].join(' '));
  assertCondition(throwIfNoEntryStatsResult.exitCode === 0, `browser node throwIfNoEntry Stats workflow should succeed: ${throwIfNoEntryStatsResult.stderr}`);
  assertCondition(
    throwIfNoEntryStatsResult.stdout === 'true\ntrue\ntrue\ntrue\ntrue\ntrue\nENOENT\nENOENT\nENOENT\n',
    `browser node stat/lstat should honor throwIfNoEntry without changing statfs: ${throwIfNoEntryStatsResult.stdout}`
  );

  const statfsResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const call = (path, options) => new Promise((resolve, reject) => fs.statfs(path, options, (error, stats) => error ? reject(error) : resolve(stats))); fs.writeFileSync(\\"statfs-file.txt\\", \\"x\\"); const root = fs.statfsSync(\\".\\"); const file = await fsp.statfs(\\"statfs-file.txt\\"); const proc = fs.statfsSync(\\"/proc/kernel/info\\", { bigint: true }); const dev = await call(\\"/dev/stdout\\"); for (const path of [\\"/proc/missing\\", \\"/dev/missing\\"]) { try { fs.statfsSync(path); console.log(path + \\":ok\\"); } catch (error) { console.log(path + \\":\\" + error.code); } } console.log(root.bsize === 4096 && root.blocks > 0 && root.bfree <= root.blocks && root.bavail <= root.bfree && root.files > 0 && root.ffree > 0 && Number.isInteger(root.type)); console.log(file.bsize === root.bsize && file.type === root.type); console.log(typeof proc.bsize + \\":\\" + proc.bsize.toString()); console.log(dev.bavail > 0);"',
  ].join(' '));
  assertCondition(statfsResult.exitCode === 0, `browser node statfs workflow should succeed: ${statfsResult.stderr}`);
  assertCondition(
    statfsResult.stdout === '/proc/missing:ENOENT\n/dev/missing:ENOENT\ntrue\ntrue\nbigint:4096\ntrue\n',
    `browser node statfs APIs should expose kernel-backed filesystem stats: ${statfsResult.stdout}`
  );

  const metadataWatchResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const flush = () => new Promise((resolve) => queueMicrotask(resolve)); fs.writeFileSync(\\"metadata-watch.txt\\", \\"ok\\\\n\\"); const events = []; const watcher = fs.watch(\\"metadata-watch.txt\\", (type, name) => events.push(type + \\":\\" + name)); fs.chmodSync(\\"metadata-watch.txt\\", 0o600); fs.chownSync(\\"metadata-watch.txt\\", 1000, 1000); fs.utimesSync(\\"metadata-watch.txt\\", 1, 2); await flush(); watcher.close(); console.log(events.filter((event) => event === \\"change:metadata-watch.txt\\").length);"',
  ].join(' '));
  assertCondition(metadataWatchResult.exitCode === 0, `browser node metadata watch workflow should succeed: ${metadataWatchResult.stderr}`);
  assertCondition(
    metadataWatchResult.stdout === '2\n',
    `browser node fs.watch should observe metadata mutations: ${metadataWatchResult.stdout}`
  );

  const watchResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); fs.mkdirSync(\\"watch-dir/nested\\", { recursive: true }); fs.writeFileSync(\\"watch-dir/nested/value.txt\\", \\"one\\\\n\\"); const events = []; const dirWatcher = fs.watch(\\"watch-dir\\", { recursive: true }, (type, name) => events.push(\\"D:\\" + type + \\":\\" + name)); const fileWatcher = fs.watch(\\"watch-dir/nested/value.txt\\", (type, name) => events.push(\\"F:\\" + type + \\":\\" + name)); fs.appendFileSync(\\"watch-dir/nested/value.txt\\", \\"two\\\\n\\"); fs.renameSync(\\"watch-dir/nested/value.txt\\", \\"watch-dir/nested/moved.txt\\"); fs.unlinkSync(\\"watch-dir/nested/moved.txt\\"); await Promise.resolve(); dirWatcher.close(); fileWatcher.close(); fs.writeFileSync(\\"watch-dir/ignored.txt\\", \\"ignored\\\\n\\"); await Promise.resolve(); console.log(events.some((event) => event === \\"D:change:nested/value.txt\\")); console.log(events.some((event) => event === \\"F:change:value.txt\\")); console.log(events.some((event) => event === \\"D:rename:nested/value.txt\\")); console.log(events.some((event) => event === \\"D:rename:nested/moved.txt\\")); console.log(events.some((event) => event.includes(\\"ignored\\")));"',
  ].join(' '));
  assertCondition(watchResult.exitCode === 0, `browser node fs.watch workflow should succeed: ${watchResult.stderr}`);
  assertCondition(
    watchResult.stdout === 'true\ntrue\ntrue\ntrue\nfalse\n',
    `browser node fs.watch should observe live kernel mutations and close cleanly: ${watchResult.stdout}`
  );

  const promisesWatchResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); fs.mkdirSync(\\"promise-watch/nested\\", { recursive: true }); const watcher = fsp.watch(\\"promise-watch\\", { recursive: true }); const first = watcher.next(); fs.writeFileSync(\\"promise-watch/nested/value.txt\\", \\"one\\\\n\\"); const firstEvent = await first; const second = watcher.next(); fs.renameSync(\\"promise-watch/nested/value.txt\\", \\"promise-watch/nested/moved.txt\\"); const secondEvent = await second; await watcher.return(); const done = await watcher.next(); console.log(firstEvent.value.eventType + \\":\\" + firstEvent.value.filename); console.log(secondEvent.value.eventType + \\":\\" + secondEvent.value.filename); console.log(done.done);"',
  ].join(' '));
  assertCondition(promisesWatchResult.exitCode === 0, `browser node fs.promises.watch workflow should succeed: ${promisesWatchResult.stderr}`);
  assertCondition(
    promisesWatchResult.stdout === 'change:nested/value.txt\nrename:nested/value.txt\ntrue\n',
    `browser node fs.promises.watch should stream live kernel mutation events: ${promisesWatchResult.stdout}`
  );

  const realpathSyncResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const call = (fn) => new Promise((resolve, reject) => fn((error, value) => error ? reject(error) : resolve(value))); fs.writeFileSync(\\"sync-path.txt\\", \\"sync\\\\n\\"); const fd = fs.openSync(\\"sync-path.txt\\", \\"r+\\"); fs.fsyncSync(fd); await call((done) => fs.fdatasync(fd, done)); fs.closeSync(fd); const handle = await fsp.open(\\"sync-path.txt\\", \\"r+\\"); await handle.sync(); await handle.datasync(); await handle.close(); console.log(fs.realpathSync(\\"lib/../sync-path.txt\\")); console.log((await call((done) => fs.realpath(\\"sync-path.txt\\", done)))); console.log(fs.realpathSync.native(\\"/workspace/sync-path.txt\\")); console.log((await fsp.realpath(\\"sync-path.txt\\", { encoding: \\"buffer\\" })).toString()); console.log(fs.realpathSync(\\"/dev/stdout\\"));"',
  ].join(' '));
  assertCondition(realpathSyncResult.exitCode === 0, `browser node realpath/fsync workflow should succeed: ${realpathSyncResult.stderr}`);
  assertCondition(
    realpathSyncResult.stdout === '/workspace/sync-path.txt\n/workspace/sync-path.txt\n/workspace/sync-path.txt\n/workspace/sync-path.txt\n/dev/stdout\n',
    `browser node realpath/fsync APIs should match tracekernel paths: ${realpathSyncResult.stdout}`
  );

  const callbackFsEvents: RuntimeCommandEvent[] = [];
  const callbackFsResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const call = (fn) => new Promise((resolve, reject) => fn((error, value) => error ? reject(error) : resolve(value))); await call((done) => fs.mkdir(\\"callback-dir/nested\\", { recursive: true }, done)); await call((done) => fs.writeFile(\\"callback-dir/nested/value.txt\\", \\"callback\\\\n\\", done)); await call((done) => fs.appendFile(\\"callback-dir/nested/value.txt\\", \\"append\\\\n\\", done)); const text = await call((done) => fs.readFile(\\"callback-dir/nested/value.txt\\", \\"utf8\\", done)); const stats = await call((done) => fs.stat(\\"callback-dir\\", done)); const lstats = await call((done) => fs.lstat(\\"callback-dir/nested/value.txt\\", done)); const entries = await call((done) => fs.readdir(\\"callback-dir/nested\\", done)); await call((done) => fs.copyFile(\\"callback-dir/nested/value.txt\\", \\"callback-dir/copy.txt\\", done)); await call((done) => fs.rename(\\"callback-dir/copy.txt\\", \\"callback-dir/moved.txt\\", done)); const exists = await new Promise((resolve) => fs.exists(\\"callback-dir/moved.txt\\", resolve)); await call((done) => fs.unlink(\\"callback-dir/moved.txt\\", done)); await call((done) => fs.unlink(\\"callback-dir/nested/value.txt\\", done)); await call((done) => fs.rmdir(\\"callback-dir/nested\\", done)); await call((done) => fs.rm(\\"callback-dir\\", { recursive: true }, done)); console.log(text.trim()); console.log(stats.isDirectory()); console.log(lstats.isFile()); console.log(entries.join(\\"\\,\\")); console.log(exists); console.log(fs.existsSync(\\"callback-dir\\"));"',
  ].join(' '), { onEvent: (event) => callbackFsEvents.push(event) });
  assertCondition(callbackFsResult.exitCode === 0, `browser node callback fs workflow should succeed: ${callbackFsResult.stderr}`);
  assertCondition(
    callbackFsResult.stdout === 'callback\nappend\ntrue\ntrue\nvalue.txt\ntrue\nfalse\n',
    `browser node callback fs APIs should match desktop-like callbacks: ${callbackFsResult.stdout}`
  );
  assertCondition(
    callbackFsEvents.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'callback-dir/nested/value.txt' &&
      looseChange(event.change).contents === 'callback\nappend\n'
    ),
    `browser node callback fs writes should emit live file changes: ${JSON.stringify(callbackFsEvents)}`
  );

  const fdEvents: RuntimeCommandEvent[] = [];
  const fdResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fd = fs.openSync(\\"fd.txt\\", \\"w+\\"); fs.writeSync(fd, \\"hello\\\\n\\"); fs.writeSync(fd, Buffer.from(\\"bytes\\\\n\\")); const stat = fs.fstatSync(fd); const readBuffer = Buffer.alloc(stat.size); fs.readSync(fd, readBuffer, 0, readBuffer.length, 0); fs.closeSync(fd); const appendFd = fs.openSync(\\"fd.txt\\", \\"a\\"); fs.writeSync(appendFd, \\"append\\\\n\\"); fs.closeSync(appendFd); const stdoutFd = fs.openSync(\\"/dev/stdout\\", \\"w\\"); fs.writeSync(stdoutFd, \\"fd-device\\\\n\\"); fs.closeSync(stdoutFd); console.log(readBuffer.toString().trim());"',
  ].join(' '), { onEvent: (event) => fdEvents.push(event) });
  assertCondition(fdResult.exitCode === 0, `browser node fd workflow should succeed: ${fdResult.stderr}`);
  assertCondition(fdResult.stdout === 'fd-device\nhello\nbytes\n', `browser node fd workflow stdout should match: ${fdResult.stdout}`);
  assertCondition(await workspace.readFile('fd.txt') === 'hello\nbytes\nappend\n', 'browser node fd writes should persist through kernel FS');
  assertCondition(
    fdEvents.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'fd.txt' &&
      looseChange(event.change).contents === 'hello\nbytes\nappend\n'
    ),
    `browser node fd writes should emit live file changes: ${JSON.stringify(fdEvents)}`
  );

  const asyncFdResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const fd = await new Promise((resolve, reject) => fs.open(\\"async-fd.txt\\", \\"w+\\", (error, value) => error ? reject(error) : resolve(value))); await new Promise((resolve, reject) => fs.write(fd, Buffer.from(\\"callback\\\\n\\"), 0, 9, null, (error) => error ? reject(error) : resolve())); const stats = await new Promise((resolve, reject) => fs.fstat(fd, (error, value) => error ? reject(error) : resolve(value))); const readBuffer = Buffer.alloc(stats.size); await new Promise((resolve, reject) => fs.read(fd, readBuffer, 0, readBuffer.length, 0, (error) => error ? reject(error) : resolve())); await new Promise((resolve, reject) => fs.close(fd, (error) => error ? reject(error) : resolve())); const handle = await fsp.open(\\"async-fd.txt\\", \\"a+\\"); await handle.write(\\"promise\\\\n\\"); const stat = await handle.stat(); await handle.close(); console.log(readBuffer.toString().trim()); console.log(stat.size);"',
  ].join(' '));
  assertCondition(asyncFdResult.exitCode === 0, `browser node async fd workflow should succeed: ${asyncFdResult.stderr}`);
  assertCondition(
    asyncFdResult.stdout === 'callback\n17\n',
    `browser node async fd workflow stdout should match: ${asyncFdResult.stdout}`
  );
  assertCondition(await workspace.readFile('async-fd.txt') === 'callback\npromise\n', 'browser node async fd writes should persist through kernel FS');

  const fdFileResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fd = fs.openSync(\\"fd-file.txt\\", \\"w+\\"); fs.writeFileSync(fd, \\"one\\\\n\\"); fs.appendFileSync(fd, \\"two\\\\n\\"); fs.writeSync(fd, \\"three\\\\n\\"); fs.closeSync(fd); fs.writeFileSync(\\"fd-append-position.txt\\", \\"abcdef\\"); const posFd = fs.openSync(\\"fd-append-position.txt\\", \\"r+\\"); fs.writeSync(posFd, \\"X\\"); fs.appendFileSync(posFd, \\"Y\\"); fs.writeSync(posFd, \\"Z\\"); fs.closeSync(posFd); const readFd = fs.openSync(\\"fd-file.txt\\", \\"r\\"); const text = fs.readFileSync(readFd, \\"utf8\\"); const rest = fs.readFileSync(readFd, \\"utf8\\"); fs.closeSync(readFd); const stdoutFd = fs.openSync(\\"/dev/stdout\\", \\"w\\"); fs.writeFileSync(stdoutFd, \\"fd-writefile-out\\\\n\\"); fs.closeSync(stdoutFd); console.log(text.trim()); console.log(rest.length); console.log(fs.readFileSync(\\"fd-append-position.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(fdFileResult.exitCode === 0, `browser node fd readFile/writeFile workflow should succeed: ${fdFileResult.stderr}`);
  assertCondition(
    fdFileResult.stdout === 'fd-writefile-out\none\ntwo\nthree\n0\nXYZdef\n',
    `browser node fd readFile/writeFile workflow stdout should match: ${fdFileResult.stdout}`
  );
  assertCondition(await workspace.readFile('fd-file.txt') === 'one\ntwo\nthree\n', 'browser node fd readFile/writeFile APIs should persist through kernel FS');

  const fdUnlinkResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); fs.writeFileSync(\\"unlink-open.txt\\", \\"before\\"); const fd = fs.openSync(\\"unlink-open.txt\\", \\"r+\\"); fs.unlinkSync(\\"unlink-open.txt\\"); console.log(fs.existsSync(\\"unlink-open.txt\\")); console.log(fs.readFileSync(fd, \\"utf8\\")); fs.writeSync(fd, \\"after\\", 0); const after = Buffer.alloc(6); fs.readSync(fd, after, 0, 6, 0); console.log(after.toString()); console.log(fs.fstatSync(fd).size); fs.closeSync(fd); try { fs.readFileSync(\\"unlink-open.txt\\"); } catch (error) { console.log(error.code); } fs.writeFileSync(\\"rename-open.txt\\", \\"old\\"); const renamed = fs.openSync(\\"rename-open.txt\\", \\"r+\\"); fs.renameSync(\\"rename-open.txt\\", \\"renamed-open.txt\\"); fs.writeSync(renamed, \\"new\\", 0); fs.closeSync(renamed); console.log(fs.readFileSync(\\"renamed-open.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(fdUnlinkResult.exitCode === 0, `browser node open fd unlink/rename workflow should succeed: ${fdUnlinkResult.stderr}`);
  assertCondition(
    fdUnlinkResult.stdout === 'false\nbefore\naftere\n6\nENOENT\nnew\n',
    `browser node open descriptors should survive unlink and follow rename: ${fdUnlinkResult.stdout}`
  );
  await assertRejectsAsync(() => workspace.readFile('unlink-open.txt'), 'browser node unlink should remove pathname while open fd survives');
  assertCondition(await workspace.readFile('renamed-open.txt') === 'new', 'browser node writes through a renamed open fd should persist at the new path');

  const fileHandleEvents: RuntimeCommandEvent[] = [];
  const fileHandleResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); fs.writeFileSync(\\"handle-read.txt\\", \\"abcdef\\"); const reader = await fsp.open(\\"handle-read.txt\\", \\"r\\"); const head = Buffer.alloc(2); await reader.read(head, 0, 2, null); const rest = await reader.readFile(\\"utf8\\"); await reader.close(); const writer = await fsp.open(\\"handle-write.txt\\", \\"w+\\"); await writer.writeFile(\\"one\\"); await writer.appendFile(Buffer.from(\\"two\\")); const stat = await writer.stat(); await writer.close(); console.log(head.toString() + \\":\\" + rest); console.log(stat.size + \\":\\" + (stat.mtimeMs > 0)); console.log(await fsp.readFile(\\"handle-write.txt\\", \\"utf8\\"));"',
  ].join(' '), { onEvent: (event) => fileHandleEvents.push(event) });
  assertCondition(fileHandleResult.exitCode === 0, `browser node FileHandle workflow should succeed: ${fileHandleResult.stderr}`);
  assertCondition(
    fileHandleResult.stdout === 'ab:cdef\n6:true\nonetwo\n',
    `browser node FileHandle readFile/writeFile/appendFile should match desktop-like behavior: ${fileHandleResult.stdout}`
  );
  assertCondition(await workspace.readFile('handle-write.txt') === 'onetwo', 'browser node FileHandle writes should persist through kernel FS');
  assertCondition(
    fileHandleEvents.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'handle-write.txt' &&
      looseChange(event.change).contents === 'onetwo'
    ),
    `browser node FileHandle writes should emit live file changes: ${JSON.stringify(fileHandleEvents)}`
  );

  const fileHandleOptionsResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fsp = require(\\"node:fs/promises\\"); const fs = require(\\"node:fs\\"); await fsp.writeFile(\\"handle-options.txt\\", \\"abcdef\\"); const handle = await fsp.open(\\"handle-options.txt\\", \\"r+\\"); const firstBuffer = Buffer.alloc(4, 46); const first = await handle.read({ buffer: firstBuffer, offset: 1, length: 2, position: 2 }); const second = await handle.read({ length: 2, position: 4 }); const write = await handle.write(Buffer.from(\\"XYZZ\\"), { offset: 0, length: 2, position: 1 }); const third = await handle.read(); await handle.close(); console.log(first.bytesRead + \\":\\" + (first.buffer === firstBuffer) + \\":\\" + firstBuffer.toString()); console.log(second.bytesRead + \\":\\" + Buffer.isBuffer(second.buffer) + \\":\\" + second.buffer.subarray(0, second.bytesRead).toString()); console.log(write.bytesWritten + \\":\\" + Buffer.isBuffer(write.buffer)); console.log(third.bytesRead + \\":\\" + third.buffer.subarray(0, third.bytesRead).toString()); console.log(fs.readFileSync(\\"handle-options.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(fileHandleOptionsResult.exitCode === 0, `browser node FileHandle options workflow should succeed: ${fileHandleOptionsResult.stderr}`);
  assertCondition(
    fileHandleOptionsResult.stdout === '2:true:.cd.\n2:true:ef\n2:true\n6:aXYdef\naXYdef\n',
    `browser node FileHandle read/write should support options-object overloads: ${fileHandleOptionsResult.stdout}`
  );
  assertCondition(await workspace.readFile('handle-options.txt') === 'aXYdef', 'browser node FileHandle options writes should persist through kernel FS');

  const fileHandleTargetResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fsp = require(\\"node:fs/promises\\"); await fsp.writeFile(\\"handle-target.txt\\", \\"abcdef\\"); const handle = await fsp.open(\\"handle-target.txt\\", \\"r+\\"); const head = await handle.read({ length: 2 }); await fsp.writeFile(handle, \\"XY\\"); const after = await fsp.readFile(handle, \\"utf8\\"); await fsp.appendFile(handle, \\"Z\\"); await handle.close(); try { await fsp.readFile(handle, \\"utf8\\"); } catch (error) { console.log(error.code); } console.log(head.bytesRead + \\":\\" + head.buffer.subarray(0, head.bytesRead).toString()); console.log(after); console.log(await fsp.readFile(\\"handle-target.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(fileHandleTargetResult.exitCode === 0, `browser node FileHandle target workflow should succeed: ${fileHandleTargetResult.stderr}`);
  assertCondition(
    fileHandleTargetResult.stdout === 'EBADF\n2:ab\nef\nabXYefZ\n',
    `browser node fs.promises readFile/writeFile/appendFile should accept FileHandle targets: ${fileHandleTargetResult.stdout}`
  );
  assertCondition(await workspace.readFile('handle-target.txt') === 'abXYefZ', 'browser node FileHandle target writes should persist through kernel FS');

  const fileHandleStreamResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fsp = require(\\"node:fs/promises\\"); const writer = await fsp.open(\\"handle-stream.txt\\", \\"w+\\"); await new Promise((resolve, reject) => { const stream = writer.createWriteStream(); stream.on(\\"error\\", reject); stream.on(\\"finish\\", resolve); stream.write(\\"handle-one\\\\n\\"); stream.end(\\"handle-two\\\\n\\"); }); try { await writer.stat(); } catch (error) { console.log(\\"writer-stat:\\" + error.code); } await writer.close(); console.log(\\"writer-close-ok\\"); const reader = await fsp.open(\\"handle-stream.txt\\", \\"r\\"); const chunks = []; await new Promise((resolve, reject) => { reader.createReadStream({ encoding: \\"utf8\\" }).on(\\"error\\", reject).on(\\"data\\", (chunk) => chunks.push(chunk)).on(\\"end\\", resolve); }); try { await reader.readFile(\\"utf8\\"); } catch (error) { console.log(\\"reader-read:\\" + error.code); } await reader.close(); console.log(chunks.join(\\"\\").trim()); const forged = await fsp.open(\\"handle-stream.txt\\", \\"r\\"); const forgedStream = forged.createReadStream({ encoding: \\"utf8\\" }); forgedStream.emit(\\"close\\"); console.log((await forged.stat()).isFile()); forgedStream.removeAllListeners(\\"close\\"); await new Promise((resolve, reject) => { forgedStream.on(\\"error\\", reject).on(\\"data\\", () => {}).on(\\"end\\", resolve); }); try { await forged.stat(); } catch (error) { console.log(\\"forged-stat:\\" + error.code); } const retained = await fsp.open(\\"handle-stream.txt\\", \\"r\\"); const retainedChunks = []; await new Promise((resolve, reject) => { retained.createReadStream({ encoding: \\"utf8\\", autoClose: false }).on(\\"error\\", reject).on(\\"data\\", (chunk) => retainedChunks.push(chunk)).on(\\"end\\", resolve); }); console.log((await retained.stat()).isFile()); await retained.close(); console.log(retainedChunks.join(\\"\\").trim());"',
  ].join(' '));
  assertCondition(fileHandleStreamResult.exitCode === 0, `browser node FileHandle stream workflow should succeed: ${fileHandleStreamResult.stderr}`);
  assertCondition(
    fileHandleStreamResult.stdout === 'writer-stat:EBADF\nwriter-close-ok\nreader-read:EBADF\nhandle-one\nhandle-two\ntrue\nforged-stat:EBADF\ntrue\nhandle-one\nhandle-two\n',
    `browser node FileHandle streams should auto-close handles unless autoClose is false: ${fileHandleStreamResult.stdout}`
  );
  assertCondition(await workspace.readFile('handle-stream.txt') === 'handle-one\nhandle-two\n', 'browser node FileHandle streams should persist through kernel FS');

  const fileHandleStreamSymbolResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fsp = require(\\"node:fs/promises\\"); await fsp.writeFile(\\"handle-symbol.txt\\", \\"abcdef\\"); const symbolSets = (stream) => Object.getOwnPropertySymbols(stream).map((symbol) => stream[symbol]).filter((value) => value && typeof value.forEach === \\"function\\" && typeof value.clear === \\"function\\"); const readAll = (stream) => new Promise((resolve, reject) => stream.on(\\"error\\", reject).on(\\"data\\", () => {}).on(\\"end\\", resolve)); const forged = await fsp.open(\\"handle-symbol.txt\\", \\"r\\"); const forgedStream = forged.createReadStream({ encoding: \\"utf8\\" }); const forgedSets = symbolSets(forgedStream); console.log(\\"forge-symbols:\\" + forgedSets.length); for (const set of forgedSets) set.forEach((listener) => { if (typeof listener === \\"function\\") listener(); }); let before = \\"ok\\"; try { before = String((await forged.stat()).isFile()); } catch (error) { before = error.code; } console.log(\\"forge-before:\\" + before); await readAll(forgedStream); try { await forged.stat(); } catch (error) { console.log(\\"forge-after:\\" + error.code); } const cleared = await fsp.open(\\"handle-symbol.txt\\", \\"r\\"); const clearedStream = cleared.createReadStream({ encoding: \\"utf8\\" }); const clearedSets = symbolSets(clearedStream); console.log(\\"clear-symbols:\\" + clearedSets.length); for (const set of clearedSets) set.clear(); await readAll(clearedStream); let closeStatus = \\"ok\\"; try { await cleared.close(); } catch (error) { closeStatus = error.code; } console.log(\\"clear-close:\\" + closeStatus);"',
  ].join(' '));
  assertCondition(fileHandleStreamSymbolResult.exitCode === 0, `browser node FileHandle symbol workflow should succeed: ${fileHandleStreamSymbolResult.stderr}`);
  assertCondition(
    fileHandleStreamSymbolResult.stdout === 'forge-symbols:0\nforge-before:true\nforge-after:EBADF\nclear-symbols:0\nclear-close:ok\n',
    `browser node FileHandle stream auto-close internals should not be exposed through Symbols: ${fileHandleStreamSymbolResult.stdout}`
  );

  const vectorEvents: RuntimeCommandEvent[] = [];
  const vectorResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const call = (fn) => new Promise((resolve, reject) => fn((error, count, buffers) => error ? reject(error) : resolve({ count, buffers }))); const fd = fs.openSync(\\"vector.txt\\", \\"w+\\"); const written = fs.writevSync(fd, [Buffer.from(\\"ab\\"), Buffer.from(\\"cd\\")]); const more = await call((done) => fs.writev(fd, [Buffer.from(\\"ef\\"), Buffer.from(\\"gh\\")], done)); const a = Buffer.alloc(3); const b = Buffer.alloc(5); const read = await call((done) => fs.readv(fd, [a, Buffer.alloc(0), b], 0, done)); fs.closeSync(fd); const handle = await fsp.open(\\"vector.txt\\", \\"a+\\"); const promiseWrite = await handle.writev([Buffer.from(\\"ij\\"), Buffer.from(\\"kl\\")]); const c = Buffer.alloc(4); const d = Buffer.alloc(8); const promiseRead = await handle.readv([Buffer.alloc(0), c, d], 0); await handle.close(); console.log(written + \\":\\" + more.count + \\":\\" + read.count + \\":\\" + promiseWrite.bytesWritten + \\":\\" + promiseRead.bytesRead); console.log(a.toString() + b.toString()); console.log(c.toString() + d.toString());"',
  ].join(' '), { onEvent: (event) => vectorEvents.push(event) });
  assertCondition(vectorResult.exitCode === 0, `browser node vector fd workflow should succeed: ${vectorResult.stderr}`);
  assertCondition(
    vectorResult.stdout === '4:4:8:4:12\nabcdefgh\nabcdefghijkl\n',
    `browser node vector fd workflow stdout should match: ${vectorResult.stdout}`
  );
  assertCondition(await workspace.readFile('vector.txt') === 'abcdefghijkl', 'browser node vector fd writes should persist through kernel FS');
  assertCondition(
    vectorEvents.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'vector.txt' &&
      looseChange(event.change).contents === 'abcdefghijkl'
    ),
    `browser node vector fd writes should emit live file changes: ${JSON.stringify(vectorEvents)}`
  );

  const fdOptionsResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const callRead = (fd, buffer, options) => new Promise((resolve, reject) => fs.read(fd, buffer, options, (error, bytesRead, returnedBuffer) => error ? reject(error) : resolve({ bytesRead, returnedBuffer }))); const callWrite = (fd, value, options) => new Promise((resolve, reject) => fs.write(fd, value, options, (error, bytesWritten, returnedValue) => error ? reject(error) : resolve({ bytesWritten, returnedValue }))); fs.writeFileSync(\\"fd-options.txt\\", \\"abcdef\\"); const fd = fs.openSync(\\"fd-options.txt\\", \\"r+\\"); const first = Buffer.alloc(4, 46); const read = await callRead(fd, first, { offset: 1, length: 2, position: 2 }); const write = await callWrite(fd, Buffer.from(\\"XYZZ\\"), { offset: 0, length: 2, position: 1 }); const second = Buffer.alloc(8, 46); const readAfterWrite = await callRead(fd, second, { offset: 0, length: 6, position: 0 }); fs.closeSync(fd); console.log(read.bytesRead + \\":\\" + (read.returnedBuffer === first) + \\":\\" + first.toString()); console.log(write.bytesWritten + \\":\\" + Buffer.isBuffer(write.returnedValue)); console.log(readAfterWrite.bytesRead + \\":\\" + second.toString()); console.log(fs.readFileSync(\\"fd-options.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(fdOptionsResult.exitCode === 0, `browser node fd options workflow should succeed: ${fdOptionsResult.stderr}`);
  assertCondition(
    fdOptionsResult.stdout === '2:true:.cd.\n2:true\n6:aXYdef..\naXYdef\n',
    `browser node fs.read/fs.write should support options-object overloads: ${fdOptionsResult.stdout}`
  );
  assertCondition(await workspace.readFile('fd-options.txt') === 'aXYdef', 'browser node options-object fd writes should persist through kernel FS');

  const truncateEvents: RuntimeCommandEvent[] = [];
  const truncateResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const call = (fn) => new Promise((resolve, reject) => fn((error) => error ? reject(error) : resolve())); fs.writeFileSync(\\"truncate.txt\\", \\"abcdef\\"); fs.truncateSync(\\"truncate.txt\\", 4); await call((done) => fs.truncate(\\"truncate.txt\\", 6, done)); const fd = fs.openSync(\\"truncate.txt\\", \\"r+\\"); fs.ftruncateSync(fd, 3); await call((done) => fs.ftruncate(fd, 5, done)); fs.closeSync(fd); await fsp.truncate(\\"truncate.txt\\", 2); const handle = await fsp.open(\\"truncate.txt\\", \\"r+\\"); await handle.truncate(4); await handle.close(); const bytes = fs.readFileSync(\\"truncate.txt\\"); console.log(bytes.length); console.log(bytes.toString(\\"hex\\"));"',
  ].join(' '), { onEvent: (event) => truncateEvents.push(event) });
  assertCondition(truncateResult.exitCode === 0, `browser node truncate workflow should succeed: ${truncateResult.stderr}`);
  assertCondition(
    truncateResult.stdout === '4\n61620000\n',
    `browser node truncate APIs should preserve and zero-fill bytes: ${truncateResult.stdout}`
  );
  assertCondition(
    (await workspace.readFile('truncate.txt', 'base64')) === Buffer.from([0x61, 0x62, 0, 0]).toString('base64'),
    'browser node truncate writes should persist zero-filled bytes'
  );
  assertCondition(
    truncateEvents.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'truncate.txt' &&
      looseChange(event.change).contents === 'ab\0\0'
    ),
    `browser node truncate should emit live zero-filled file changes: ${JSON.stringify(truncateEvents)}`
  );
  const truncateConflictResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const code = (fn) => { try { fn(); return \\"ok\\"; } catch (error) { return error.code; } }; fs.writeFileSync(\\"truncate-parent-file.txt\\", \\"file\\\\n\\"); fs.mkdirSync(\\"truncate-dir\\"); console.log(code(() => fs.truncateSync(\\"missing-truncate.txt\\", 1))); console.log(code(() => fs.truncateSync(\\"missing-truncate-parent/value.txt\\", 1))); console.log(code(() => fs.truncateSync(\\"truncate-parent-file.txt/value.txt\\", 1))); console.log(code(() => fs.truncateSync(\\"truncate-dir\\", 1))); console.log(fs.existsSync(\\"missing-truncate-parent\\")); console.log(fs.statSync(\\"truncate-parent-file.txt\\").isFile()); console.log(fs.statSync(\\"truncate-dir\\").isDirectory());"',
  ].join(' '));
  assertCondition(truncateConflictResult.exitCode === 0, `browser node truncate conflict workflow should succeed: ${truncateConflictResult.stderr}`);
  assertCondition(
    truncateConflictResult.stdout === 'ENOENT\nENOENT\nENOTDIR\nEISDIR\nfalse\ntrue\ntrue\n',
    `browser node truncate conflicts should match desktop semantics without corrupting entries: ${truncateConflictResult.stdout}`
  );

  const bufferResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const { Buffer: ImportedBuffer } = require(\\"node:buffer\\"); fs.writeFileSync(\\"buffer.bin\\", Buffer.from(\\"00ff41\\", \\"hex\\")); const bytes = fs.readFileSync(\\"buffer.bin\\"); console.log(Buffer.isBuffer(bytes)); console.log(bytes.toString(\\"hex\\")); console.log(bytes.toString(\\"base64\\")); console.log(ImportedBuffer.from(\\"ok\\").toString());"',
  ].join(' '));
  assertCondition(bufferResult.exitCode === 0, `browser node Buffer workflow should succeed: ${bufferResult.stderr}`);
  assertCondition(
    bufferResult.stdout === 'true\n00ff41\nAP9B\nok\n',
    `browser node Buffer workflow should match desktop-like Buffer APIs: ${bufferResult.stdout}`
  );
  assertCondition(
    (await workspace.readFile('buffer.bin', 'base64')) === Buffer.from([0, 255, 65]).toString('base64'),
    'browser node Buffer writes should persist binary files'
  );

  const streamEvents: RuntimeCommandEvent[] = [];
  const streamResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); await new Promise((resolve, reject) => { const out = fs.createWriteStream(\\"streamed.txt\\"); out.on(\\"error\\", reject); out.on(\\"finish\\", resolve); out.write(\\"one\\\\n\\"); out.end(Buffer.from(\\"two\\\\n\\")); }); await new Promise((resolve) => { const chunks = []; fs.createReadStream(\\"streamed.txt\\", { encoding: \\"utf8\\" }).on(\\"data\\", (chunk) => chunks.push(chunk)).on(\\"end\\", () => { process.stdout.write(chunks.join(\\"\\")); resolve(); }); });"',
  ].join(' '), { onEvent: (event) => streamEvents.push(event) });
  assertCondition(streamResult.exitCode === 0, `browser node file stream workflow should succeed: ${streamResult.stderr}`);
  assertCondition(streamResult.stdout === 'one\ntwo\n', `browser node file streams should read written data: ${streamResult.stdout}`);
  assertCondition(await workspace.readFile('streamed.txt') === 'one\ntwo\n', 'browser node createWriteStream should persist written data');
  assertCondition(
    streamEvents.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'streamed.txt' &&
      looseChange(event.change).contents === 'one\ntwo\n'
    ),
    `browser node createWriteStream should emit live file mutations: ${JSON.stringify(streamEvents)}`
  );

  const streamOverwriteResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const write = (path, options, chunks) => new Promise((resolve, reject) => { const out = fs.createWriteStream(path, options); out.on(\\"error\\", reject); out.on(\\"finish\\", resolve); for (const chunk of chunks.slice(0, -1)) out.write(chunk); out.end(chunks.at(-1)); }); fs.writeFileSync(\\"stream-rplus.txt\\", \\"abcdef\\"); await write(\\"stream-rplus.txt\\", { flags: \\"r+\\" }, [\\"XY\\", \\"Z\\"]); fs.writeFileSync(\\"stream-start.txt\\", \\"abcdef\\"); await write(\\"stream-start.txt\\", { flags: \\"r+\\", start: 2 }, [\\"XY\\"]); fs.writeFileSync(\\"stream-append.txt\\", \\"abcdef\\"); await write(\\"stream-append.txt\\", { flags: \\"a+\\" }, [\\"XY\\"]); console.log(fs.readFileSync(\\"stream-rplus.txt\\", \\"utf8\\")); console.log(fs.readFileSync(\\"stream-start.txt\\", \\"utf8\\")); console.log(fs.readFileSync(\\"stream-append.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(streamOverwriteResult.exitCode === 0, `browser node overwrite stream workflow should succeed: ${streamOverwriteResult.stderr}`);
  assertCondition(
    streamOverwriteResult.stdout === 'XYZdef\nabXYef\nabcdefXY\n',
    `browser node write streams should respect overwrite, start, and append cursors: ${streamOverwriteResult.stdout}`
  );

  const streamFlagResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const streamStatus = (path, options) => new Promise((resolve) => { let out; try { out = fs.createWriteStream(path, options); } catch (error) { resolve(\\"throw:\\" + error.code + \\":\\" + fs.existsSync(path)); return; } const events = []; out.on(\\"error\\", (error) => events.push(\\"error:\\" + error.code)); out.on(\\"finish\\", () => events.push(\\"finish\\")); out.on(\\"close\\", () => resolve(events.join(\\"|\\") + \\":\\" + fs.existsSync(path))); out.end(\\"XY\\"); }); console.log(await streamStatus(\\"missing-rplus-stream.txt\\", { flags: \\"r+\\" })); console.log(await streamStatus(\\"missing-w-stream.txt\\", { flags: \\"w\\" })); fs.writeFileSync(\\"exclusive-stream.txt\\", \\"keep\\"); console.log(await streamStatus(\\"exclusive-stream.txt\\", { flags: \\"wx\\" })); console.log(await streamStatus(\\"exclusive-created-stream.txt\\", { flags: \\"wx\\" })); fs.writeFileSync(\\"readonly-stream.txt\\", \\"abcdef\\"); console.log(await streamStatus(\\"readonly-stream.txt\\", { flags: \\"r\\" })); console.log(fs.readFileSync(\\"readonly-stream.txt\\", \\"utf8\\")); console.log(fs.readFileSync(\\"exclusive-stream.txt\\", \\"utf8\\")); console.log(fs.readFileSync(\\"exclusive-created-stream.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(streamFlagResult.exitCode === 0, `browser node stream flag workflow should succeed: ${streamFlagResult.stderr}`);
  assertCondition(
    streamFlagResult.stdout === 'throw:ENOENT:false\nfinish:true\nthrow:EEXIST:true\nfinish:true\nerror:EBADF:true\nabcdef\nkeep\nXY\n',
    `browser node write streams should honor create/write flags: ${streamFlagResult.stdout}`
  );

  const streamSetEncodingResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); fs.writeFileSync(\\"stream-encoding.txt\\", Buffer.from(\\"68656c6c6f\\", \\"hex\\")); const chunks = []; await new Promise((resolve, reject) => { fs.createReadStream(\\"stream-encoding.txt\\").setEncoding(\\"utf8\\").on(\\"error\\", reject).on(\\"data\\", (chunk) => chunks.push(typeof chunk + \\":\\" + chunk)).on(\\"end\\", resolve); }); console.log(chunks.join(\\"|\\"));"',
  ].join(' '));
  assertCondition(streamSetEncodingResult.exitCode === 0, `browser node stream setEncoding workflow should succeed: ${streamSetEncodingResult.stderr}`);
  assertCondition(
    streamSetEncodingResult.stdout === 'string:hello\n',
    `browser node readable file streams should support setEncoding: ${streamSetEncodingResult.stdout}`
  );

  const streamRangeResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const read = (options) => new Promise((resolve) => { const chunks = []; let input; try { input = fs.createReadStream(\\"stream-range.txt\\", options); } catch (error) { resolve(\\"throw:\\" + error.code + \\":\\" + error.name); return; } input.on(\\"error\\", (error) => resolve(\\"error:\\" + error.code + \\":\\" + error.name)).on(\\"data\\", (chunk) => chunks.push(chunk)).on(\\"end\\", () => resolve(Buffer.concat(chunks).toString(\\"utf8\\"))); }); fs.writeFileSync(\\"stream-range.txt\\", \\"abcdef\\"); console.log(await read({ start: 2, end: 3 })); console.log(await read({ start: 4, end: 2 })); console.log(await read({ start: -1 })); console.log(await read({ end: -1 })); console.log(await read({ start: 1.5 })); console.log(await read({ end: 2.5 }));"',
  ].join(' '));
  assertCondition(streamRangeResult.exitCode === 0, `browser node stream range workflow should succeed: ${streamRangeResult.stderr}`);
  assertCondition(
    streamRangeResult.stdout === 'cd\nthrow:ERR_OUT_OF_RANGE:RangeError\nthrow:ERR_OUT_OF_RANGE:RangeError\nthrow:ERR_OUT_OF_RANGE:RangeError\nthrow:ERR_OUT_OF_RANGE:RangeError\nthrow:ERR_OUT_OF_RANGE:RangeError\n',
    `browser node readable file streams should validate ranges like Node: ${streamRangeResult.stdout}`
  );

  const streamStateResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const out = fs.createWriteStream(\\"stream-state.txt\\"); console.log(out.writable + \\":\\" + out.writableEnded + \\":\\" + out.writableFinished + \\":\\" + out.bytesWritten); out.write(\\"abc\\"); console.log(out.bytesWritten); await new Promise((resolve) => out.end(\\"def\\", resolve)); console.log(out.writableEnded + \\":\\" + out.writableFinished + \\":\\" + out.closed + \\":\\" + out.bytesWritten); const input = fs.createReadStream(\\"stream-state.txt\\"); console.log(input.readable + \\":\\" + input.readableEnded + \\":\\" + input.readableEncoding); input.setEncoding(\\"utf8\\"); console.log(input.readableEncoding); const chunks = []; await new Promise((resolve, reject) => input.on(\\"error\\", reject).on(\\"data\\", (chunk) => chunks.push(chunk)).on(\\"end\\", resolve)); console.log(chunks.join(\\"\\")); console.log(input.readableEnded + \\":\\" + input.closed);"',
  ].join(' '));
  assertCondition(streamStateResult.exitCode === 0, `browser node stream state workflow should succeed: ${streamStateResult.stderr}`);
  assertCondition(
    streamStateResult.stdout === 'true:false:false:0\n3\ntrue:true:true:6\ntrue:false:null\nutf8\nabcdef\ntrue:true\n',
    `browser node file streams should expose common stream state properties: ${streamStateResult.stdout}`
  );

  const streamWritableStateResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const out = fs.createWriteStream(\\"stream-writable-state.txt\\"); console.log(out.writableLength + \\":\\" + out.writableNeedDrain + \\":\\" + out.writableCorked); out.cork(); out.cork(); console.log(out.writableCorked); out.write(\\"a\\"); console.log(out.bytesWritten + \\":\\" + out.writableLength + \\":\\" + out.writableNeedDrain); out.uncork(); out.uncork(); out.uncork(); console.log(out.writableCorked); await new Promise((resolve) => out.end(\\"b\\", resolve)); console.log(fs.readFileSync(\\"stream-writable-state.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(streamWritableStateResult.exitCode === 0, `browser node writable stream state workflow should succeed: ${streamWritableStateResult.stderr}`);
  assertCondition(
    streamWritableStateResult.stdout === '0:false:0\n2\n1:0:false\n0\nab\n',
    `browser node writable file streams should expose cork/drain state helpers: ${streamWritableStateResult.stdout}`
  );

  const streamWriteAfterEndResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const events = []; await new Promise((resolve) => { const out = fs.createWriteStream(\\"stream-after-end.txt\\"); out.on(\\"error\\", (error) => events.push(\\"error:\\" + error.code)); out.on(\\"close\\", resolve); out.end(\\"one\\", () => events.push(\\"end-callback\\")); const accepted = out.write(\\"two\\", (error) => events.push(\\"write-callback:\\" + error.code)); events.push(\\"accepted:\\" + accepted); }); console.log(events.join(\\"|\\")); console.log(fs.readFileSync(\\"stream-after-end.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(streamWriteAfterEndResult.exitCode === 0, `browser node write-after-end stream workflow should succeed: ${streamWriteAfterEndResult.stderr}`);
  assertCondition(
    streamWriteAfterEndResult.stdout === 'write-callback:ERR_STREAM_WRITE_AFTER_END|error:ERR_STREAM_WRITE_AFTER_END|accepted:false|end-callback\none\n',
    `browser node writable streams should reject writes after end without mutating files: ${streamWriteAfterEndResult.stdout}`
  );
  assertCondition(await workspace.readFile('stream-after-end.txt') === 'one', 'browser node write-after-end should not append after stream end');

  const streamReadResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); fs.writeFileSync(\\"stream-read.txt\\", \\"abcdef\\"); const input = fs.createReadStream(\\"stream-read.txt\\"); const first = input.read(2); console.log(Buffer.isBuffer(first) + \\":\\" + first.toString() + \\":\\" + input.readableLength + \\":\\" + input.readableEnded); input.setEncoding(\\"utf8\\"); const chunks = []; await new Promise((resolve, reject) => input.on(\\"error\\", reject).on(\\"data\\", (chunk) => chunks.push(typeof chunk + \\":\\" + chunk)).on(\\"end\\", resolve)); console.log(chunks.join(\\"|\\")); console.log(input.readableEnded + \\":\\" + input.closed + \\":\\" + input.read());"',
  ].join(' '));
  assertCondition(streamReadResult.exitCode === 0, `browser node stream read workflow should succeed: ${streamReadResult.stderr}`);
  assertCondition(
    streamReadResult.stdout === 'true:ab:4:false\nstring:cdef\ntrue:true:null\n',
    `browser node readable file streams should support pull reads and event reads on the same cursor: ${streamReadResult.stdout}`
  );

  const streamPauseResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); fs.writeFileSync(\\"stream-pause.txt\\", \\"paused\\"); const input = fs.createReadStream(\\"stream-pause.txt\\", { encoding: \\"utf8\\" }); const events = []; console.log(String(input.readableFlowing)); input.pause(); console.log(String(input.readableFlowing)); input.on(\\"data\\", (chunk) => events.push(\\"data:\\" + chunk)); input.on(\\"end\\", () => events.push(\\"end\\")); await new Promise((resolve) => queueMicrotask(resolve)); console.log(events.join(\\"|\\")); input.resume(); console.log(String(input.readableFlowing)); await new Promise((resolve) => input.on(\\"close\\", resolve)); console.log(events.join(\\"|\\")); console.log(input.readableEnded + \\":\\" + input.closed); fs.writeFileSync(\\"stream-pause-pending.txt\\", \\"pending\\"); const pending = fs.createReadStream(\\"stream-pause-pending.txt\\", { encoding: \\"utf8\\" }); const pendingEvents = []; pending.on(\\"data\\", (chunk) => pendingEvents.push(\\"data:\\" + chunk)); pending.on(\\"end\\", () => pendingEvents.push(\\"end\\")); pending.pause(); await new Promise((resolve) => queueMicrotask(resolve)); console.log(pendingEvents.join(\\"|\\")); pending.resume(); await new Promise((resolve) => pending.on(\\"close\\", resolve)); console.log(pendingEvents.join(\\"|\\"));"',
  ].join(' '));
  assertCondition(streamPauseResult.exitCode === 0, `browser node stream pause/resume workflow should succeed: ${streamPauseResult.stderr}`);
  assertCondition(
    streamPauseResult.stdout === 'null\nfalse\n\ntrue\ndata:paused|end\ntrue:true\n\ndata:pending|end\n',
    `browser node readable file streams should support pause/resume flow control: ${streamPauseResult.stdout}`
  );

  const streamPipeResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); fs.writeFileSync(\\"stream-pipe-source.txt\\", \\"pipe-data\\"); const events = []; const out = fs.createWriteStream(\\"stream-pipe-target.txt\\"); out.on(\\"pipe\\", () => events.push(\\"pipe\\")); out.on(\\"unpipe\\", () => events.push(\\"unpipe\\")); fs.createReadStream(\\"stream-pipe-source.txt\\").pipe(out, { end: false }); await new Promise((resolve) => queueMicrotask(resolve)); out.end(\\"+tail\\"); await new Promise((resolve) => out.on(\\"close\\", resolve)); const skipped = fs.createWriteStream(\\"stream-pipe-skipped.txt\\"); const input = fs.createReadStream(\\"stream-pipe-source.txt\\"); input.pipe(skipped); input.unpipe(skipped); await new Promise((resolve) => queueMicrotask(resolve)); skipped.end(\\"manual\\"); await new Promise((resolve) => skipped.on(\\"close\\", resolve)); console.log(events.join(\\"|\\")); console.log(fs.readFileSync(\\"stream-pipe-target.txt\\", \\"utf8\\")); console.log(fs.readFileSync(\\"stream-pipe-skipped.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(streamPipeResult.exitCode === 0, `browser node stream pipe workflow should succeed: ${streamPipeResult.stderr}`);
  assertCondition(
    streamPipeResult.stdout === 'pipe\npipe-data+tail\nmanual\n',
    `browser node readable file streams should support pipe options and unpipe: ${streamPipeResult.stdout}`
  );

  const streamListenerAliasResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const seen = []; await new Promise((resolve, reject) => { const out = fs.createWriteStream(\\"stream-events.txt\\"); const removed = () => seen.push(\\"removed\\"); out.addListener(\\"finish\\", () => seen.push(\\"finish\\")); out.on(\\"finish\\", removed); out.off(\\"finish\\", removed); out.on(\\"error\\", reject); out.end(\\"ok\\\\n\\", resolve); }); const chunks = []; await new Promise((resolve, reject) => { const input = fs.createReadStream(\\"stream-events.txt\\", { encoding: \\"utf8\\" }); const removedData = () => chunks.push(\\"removed\\"); input.addListener(\\"data\\", removedData); input.removeListener(\\"data\\", removedData); input.addListener(\\"data\\", (chunk) => chunks.push(chunk)); input.addListener(\\"error\\", reject); input.addListener(\\"end\\", resolve); }); console.log(seen.join(\\"|\\")); console.log(chunks.join(\\"\\"));"',
  ].join(' '));
  assertCondition(streamListenerAliasResult.exitCode === 0, `browser node stream listener alias workflow should succeed: ${streamListenerAliasResult.stderr}`);
  assertCondition(
    streamListenerAliasResult.stdout === 'finish\nok\n\n',
    `browser node file streams should support EventEmitter listener aliases: ${streamListenerAliasResult.stdout}`
  );

  const streamEmitterResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const out = fs.createWriteStream(\\"stream-emitter.txt\\"); const events = []; const first = function first() { events.push(\\"first\\"); }; const second = function second() { events.push(\\"second\\"); }; const removedOnce = function removedOnce() { events.push(\\"removed-once\\"); }; out.on(\\"finish\\", second); out.prependListener(\\"finish\\", first); out.once(\\"finish\\", removedOnce); out.removeListener(\\"finish\\", removedOnce); out.prependOnceListener(\\"close\\", function closeOnce() { events.push(\\"close-once\\"); }); console.log(out.listenerCount(\\"finish\\")); console.log(out.listeners(\\"finish\\").map((listener) => listener.name).join(\\"|\\")); console.log(out.rawListeners(\\"close\\").length + \\":\\" + out.listeners(\\"close\\")[0].name); console.log(out.eventNames().sort().join(\\"|\\")); out.removeAllListeners(\\"close\\"); out.on(\\"close\\", () => events.push(\\"close\\")); await new Promise((resolve) => out.end(\\"ok\\", () => { events.push(\\"callback\\"); resolve(); })); await new Promise((resolve) => queueMicrotask(resolve)); console.log(events.join(\\"|\\")); console.log(fs.readFileSync(\\"stream-emitter.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(streamEmitterResult.exitCode === 0, `browser node stream EventEmitter workflow should succeed: ${streamEmitterResult.stderr}`);
  assertCondition(
    streamEmitterResult.stdout === '2\nfirst|second\n1:closeOnce\nclose|finish\ncallback|first|second|close\nok\n',
    `browser node streams should support EventEmitter introspection/removal helpers: ${streamEmitterResult.stdout}`
  );

  const streamLifecycleResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); fs.writeFileSync(\\"destroy-read.txt\\", \\"abcdef\\"); const readEvents = []; await new Promise((resolve) => { const input = fs.createReadStream(\\"destroy-read.txt\\", { encoding: \\"utf8\\" }); input.on(\\"data\\", () => readEvents.push(\\"data\\")); input.on(\\"end\\", () => readEvents.push(\\"end\\")); input.on(\\"close\\", () => { readEvents.push(\\"close:\\" + input.destroyed); resolve(); }); input.destroy(); }); const writeEvents = []; await new Promise((resolve) => { const out = fs.createWriteStream(\\"destroy-write.txt\\"); out.on(\\"error\\", (error) => writeEvents.push(\\"error:\\" + error.message)); out.on(\\"finish\\", () => writeEvents.push(\\"finish\\")); out.on(\\"close\\", () => { writeEvents.push(\\"close:\\" + out.destroyed); resolve(); }); out.write(\\"before\\\\n\\"); out.destroy(new Error(\\"stop\\")); }); console.log(readEvents.join(\\"|\\")); console.log(writeEvents.join(\\"|\\")); console.log(fs.readFileSync(\\"destroy-write.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(streamLifecycleResult.exitCode === 0, `browser node stream lifecycle workflow should succeed: ${streamLifecycleResult.stderr}`);
  assertCondition(
    streamLifecycleResult.stdout === 'close:true\nerror:stop|close:true\nbefore\n\n',
    `browser node file streams should support destroy/close lifecycle events: ${streamLifecycleResult.stdout}`
  );

  const fdStreamEvents: RuntimeCommandEvent[] = [];
  const fdStreamResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const writeFd = fs.openSync(\\"fd-streamed.txt\\", \\"w+\\"); await new Promise((resolve, reject) => { const out = fs.createWriteStream(null, { fd: writeFd }); out.on(\\"error\\", reject); out.on(\\"finish\\", resolve); out.write(\\"fd-one\\\\n\\"); out.end(\\"fd-two\\\\n\\"); }); let closeError = \\"none\\"; try { fs.fstatSync(writeFd); } catch (error) { closeError = error.code; } const readFd = fs.openSync(\\"fd-streamed.txt\\", \\"r\\"); const chunks = []; await new Promise((resolve, reject) => { fs.createReadStream(null, { fd: readFd, encoding: \\"utf8\\" }).on(\\"error\\", reject).on(\\"data\\", (chunk) => chunks.push(chunk)).on(\\"end\\", resolve); }); let readCloseError = \\"none\\"; try { fs.fstatSync(readFd); } catch (error) { readCloseError = error.code; } fs.writeFileSync(\\"fd-stream-start.txt\\", \\"abcdef\\"); const startFd = fs.openSync(\\"fd-stream-start.txt\\", \\"r+\\"); await new Promise((resolve, reject) => { const out = fs.createWriteStream(null, { fd: startFd, start: 2 }); out.on(\\"error\\", reject); out.on(\\"finish\\", resolve); out.write(\\"XY\\"); out.end(\\"Z\\"); }); fs.writeFileSync(\\"fd-stream-append-start.txt\\", \\"abcdef\\"); const appendFd = fs.openSync(\\"fd-stream-append-start.txt\\", \\"a+\\"); await new Promise((resolve, reject) => { const out = fs.createWriteStream(null, { fd: appendFd, start: 2 }); out.on(\\"error\\", reject); out.on(\\"finish\\", resolve); out.end(\\"XY\\"); }); console.log(chunks.join(\\"\\").trim()); console.log(closeError + \\":\\" + readCloseError); console.log(fs.readFileSync(\\"fd-stream-start.txt\\", \\"utf8\\")); console.log(fs.readFileSync(\\"fd-stream-append-start.txt\\", \\"utf8\\"));"',
  ].join(' '), { onEvent: (event) => fdStreamEvents.push(event) });
  assertCondition(fdStreamResult.exitCode === 0, `browser node fd stream workflow should succeed: ${fdStreamResult.stderr}`);
  assertCondition(
    fdStreamResult.stdout === 'fd-one\nfd-two\nEBADF:EBADF\nabXYZf\nabcdefXY\n',
    `browser node fd streams should read/write descriptor-backed files and auto-close: ${fdStreamResult.stdout}`
  );
  assertCondition(await workspace.readFile('fd-streamed.txt') === 'fd-one\nfd-two\n', 'browser node fd createWriteStream should persist through kernel FS');
  assertCondition(
    fdStreamEvents.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'fd-streamed.txt' &&
      looseChange(event.change).contents === 'fd-one\nfd-two\n'
    ) &&
      fdStreamEvents.some((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change.path === 'fd-stream-start.txt' &&
        looseChange(event.change).contents === 'abXYZf'
      ) &&
      fdStreamEvents.some((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change.path === 'fd-stream-append-start.txt' &&
        looseChange(event.change).contents === 'abcdefXY'
      ),
    `browser node fd createWriteStream should emit live file-change events: ${JSON.stringify(fdStreamEvents)}`
  );

  const fdReadStreamOffsetResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const stream = (fd, options) => new Promise((resolve, reject) => { const chunks = []; fs.createReadStream(null, { fd, autoClose: false, encoding: \\"utf8\\", ...options }).on(\\"error\\", reject).on(\\"data\\", (chunk) => chunks.push(chunk)).on(\\"end\\", () => resolve(chunks.join(\\"\\"))); }); fs.writeFileSync(\\"fd-read-stream.txt\\", \\"abcdef\\"); let fd = fs.openSync(\\"fd-read-stream.txt\\", \\"r\\"); console.log(await stream(fd, { start: 2 })); console.log(fs.readFileSync(fd, \\"utf8\\")); fs.closeSync(fd); fd = fs.openSync(\\"fd-read-stream.txt\\", \\"r\\"); console.log(await stream(fd, { start: 1, end: 3 })); console.log(fs.readFileSync(fd, \\"utf8\\")); fs.closeSync(fd); fd = fs.openSync(\\"fd-read-stream.txt\\", \\"r\\"); const head = Buffer.alloc(2); fs.readSync(fd, head, 0, 2, null); console.log(head.toString()); console.log(await stream(fd, {})); console.log(fs.readFileSync(fd, \\"utf8\\")); fs.closeSync(fd);"',
  ].join(' '));
  assertCondition(fdReadStreamOffsetResult.exitCode === 0, `browser node fd read stream offset workflow should succeed: ${fdReadStreamOffsetResult.stderr}`);
  assertCondition(
    fdReadStreamOffsetResult.stdout === 'cdef\nabcdef\nbcd\nabcdef\nab\ncdef\n\n',
    `browser node fd read streams should match host offset semantics: ${fdReadStreamOffsetResult.stdout}`
  );

  const readOnlyFdStreamResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); fs.writeFileSync(\\"readonly-fd-stream.txt\\", \\"original\\\\n\\"); const fd = fs.openSync(\\"readonly-fd-stream.txt\\", \\"r\\"); const events = []; await new Promise((resolve) => { const out = fs.createWriteStream(null, { fd }); out.on(\\"error\\", (error) => events.push(\\"error:\\" + error.code)); out.on(\\"finish\\", () => events.push(\\"finish\\")); out.on(\\"close\\", resolve); out.end(\\"bad\\\\n\\"); }); let closeError = \\"none\\"; try { fs.fstatSync(fd); } catch (error) { closeError = error.code; } console.log(events.join(\\"|\\")); console.log(closeError); console.log(fs.readFileSync(\\"readonly-fd-stream.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(readOnlyFdStreamResult.exitCode === 0, `browser node read-only fd stream should report an error event: ${readOnlyFdStreamResult.stderr}`);
  assertCondition(
    readOnlyFdStreamResult.stdout === 'error:EBADF\nEBADF\noriginal\n\n',
    `browser node read-only fd createWriteStream should not mutate or finish: ${readOnlyFdStreamResult.stdout}`
  );
  assertCondition(await workspace.readFile('readonly-fd-stream.txt') === 'original\n', 'browser node read-only fd stream should not persist failed writes');

  const fileHandleLifecycleResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fsp = require(\\"node:fs/promises\\"); const handle = await fsp.open(\\"handle-lifecycle.txt\\", \\"w+\\"); await handle.writeFile(\\"handle-data\\"); console.log((await handle.stat()).isFile()); await handle.close(); await handle.close(); for (const op of [\\"stat\\", \\"readFile\\", \\"writeFile\\", \\"truncate\\"]) { try { if (op === \\"stat\\") await handle.stat(); else if (op === \\"readFile\\") await handle.readFile(\\"utf8\\"); else if (op === \\"writeFile\\") await handle.writeFile(\\"after\\"); else await handle.truncate(0); console.log(op + \\":ok\\"); } catch (error) { console.log(op + \\":\\" + error.code); } } const proc = await fsp.open(\\"/proc/kernel/info\\", \\"r\\"); console.log(JSON.parse(await proc.readFile(\\"utf8\\")).name); for (const op of [\\"chmod\\", \\"chown\\", \\"utimes\\"]) { try { if (op === \\"chmod\\") await proc.chmod(0o600); else if (op === \\"chown\\") await proc.chown(1, 1); else await proc.utimes(new Date(), new Date()); console.log(op + \\":ok\\"); } catch (error) { console.log(op + \\":\\" + error.code); } } await proc.close(); try { await proc.readFile(\\"utf8\\"); } catch (error) { console.log(error.code); }"',
  ].join(' '));
  assertCondition(fileHandleLifecycleResult.exitCode === 0, `browser node FileHandle lifecycle workflow should succeed: ${fileHandleLifecycleResult.stderr}`);
  assertCondition(
    fileHandleLifecycleResult.stdout === 'true\nstat:EBADF\nreadFile:EBADF\nwriteFile:EBADF\ntruncate:EBADF\ntracekernel\nchmod:EROFS\nchown:EROFS\nutimes:EROFS\nEBADF\n',
    `browser node FileHandle APIs should reject use-after-close and support /proc handles: ${fileHandleLifecycleResult.stdout}`
  );
  assertCondition(await workspace.readFile('handle-lifecycle.txt') === 'handle-data', 'browser node FileHandle writes should persist through kernel FS');

  const fileHandlePermissionResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fsp = require(\\"node:fs/promises\\"); await fsp.writeFile(\\"handle-perms.txt\\", \\"original\\\\n\\"); const writeOnly = await fsp.open(\\"handle-perms.txt\\", \\"w\\"); await writeOnly.writeFile(\\"changed\\\\n\\"); try { await writeOnly.readFile(\\"utf8\\"); console.log(\\"write-only-read:ok\\"); } catch (error) { console.log(\\"write-only-read:\\" + error.code); } await writeOnly.close(); const readOnly = await fsp.open(\\"handle-perms.txt\\", \\"r\\"); try { await readOnly.writeFile(\\"bad\\\\n\\"); console.log(\\"read-only-write:ok\\"); } catch (error) { console.log(\\"read-only-write:\\" + error.code); } await readOnly.close(); console.log(await fsp.readFile(\\"handle-perms.txt\\", \\"utf8\\"));"',
  ].join(' '));
  assertCondition(fileHandlePermissionResult.exitCode === 0, `browser node FileHandle permission workflow should succeed: ${fileHandlePermissionResult.stderr}`);
  assertCondition(
    fileHandlePermissionResult.stdout === 'write-only-read:EBADF\nread-only-write:EBADF\nchanged\n\n',
    `browser node FileHandle readFile/writeFile should honor descriptor permissions: ${fileHandlePermissionResult.stdout}`
  );
  assertCondition(await workspace.readFile('handle-perms.txt') === 'changed\n', 'browser node FileHandle failed writes should not mutate files');

  const watchFileResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const flush = () => new Promise((resolve) => queueMicrotask(resolve)); fs.writeFileSync(\\"watched-file.txt\\", \\"one\\"); const records = []; const listener = (curr, prev) => records.push(prev.size + \\"->\\" + curr.size + \\":\\" + curr.isFile()); fs.watchFile(\\"watched-file.txt\\", listener); fs.appendFileSync(\\"watched-file.txt\\", \\"two\\"); await flush(); fs.renameSync(\\"watched-file.txt\\", \\"watched-file-renamed.txt\\"); await flush(); fs.unwatchFile(\\"watched-file.txt\\", listener); fs.writeFileSync(\\"watched-file.txt\\", \\"new\\"); await flush(); console.log(records.join(\\"|\\")); console.log(fs.statSync(\\"watched-file-renamed.txt\\").mtimeMs > 0);"',
  ].join(' '));
  assertCondition(watchFileResult.exitCode === 0, `browser node watchFile workflow should succeed: ${watchFileResult.stderr}`);
  assertCondition(
    watchFileResult.stdout === '3->6:true|6->0:false\ntrue\n',
    `browser node watchFile should receive live stat transitions and unwatch cleanly: ${watchFileResult.stdout}`
  );

  const stdioFdEvents: RuntimeCommandEvent[] = [];
  const stdioFdResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); console.log(fs.readFileSync(0, \\"utf8\\").trim()); console.log(\\"second:\\" + fs.readFileSync(0, \\"utf8\\").length); process.stdout.write(\\"stream-out\\\\n\\"); fs.writeFileSync(1, \\"fd-out\\\\n\\"); process.stderr.write(\\"stream-err\\\\n\\"); fs.writeFileSync(2, \\"fd-err\\\\n\\");"',
  ].join(' '), { stdinPipe: stdinPipe('from-fd\n'), onEvent: (event) => stdioFdEvents.push(event) });
  assertCondition(stdioFdResult.exitCode === 0, `browser node stdio fd workflow should succeed: ${stdioFdResult.stderr}`);
  assertCondition(
    stdioFdResult.stdout === 'from-fd\nsecond:0\nstream-out\nfd-out\n' &&
      stdioFdResult.stderr === 'stream-err\nfd-err\n',
    `browser node should map fd 0/1/2 to kernel stdio devices: ${JSON.stringify(stdioFdResult)}`
  );
  const stdioFdExitIndex = stdioFdEvents.findIndex((event) => event.type === 'status' && event.phase === 'process-exit');
  const stdioFdOutIndex = stdioFdEvents.findIndex((event) =>
    event.type === 'output' &&
    event.stream === 'stdout' &&
    event.device === '/dev/stdout' &&
    event.data === 'fd-out\n'
  );
  const stdioFdErrIndex = stdioFdEvents.findIndex((event) =>
    event.type === 'output' &&
    event.stream === 'stderr' &&
    event.device === '/dev/stderr' &&
    event.data === 'fd-err\n'
  );
  assertCondition(
    stdioFdOutIndex >= 0 &&
      stdioFdErrIndex >= 0 &&
      stdioFdExitIndex > stdioFdOutIndex &&
      stdioFdExitIndex > stdioFdErrIndex,
    `browser node fd stdio writes should stream output events before process-exit: ${JSON.stringify(stdioFdEvents)}`
  );

  const stdioDeviceStreamEvents: RuntimeCommandEvent[] = [];
  const stdioDeviceStreamResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const chunks = []; await new Promise((resolve, reject) => fs.createReadStream(null, { fd: 0, encoding: \\"utf8\\" }).on(\\"error\\", reject).on(\\"data\\", (chunk) => chunks.push(chunk)).on(\\"end\\", resolve)); console.log(chunks.join(\\"\\").trim()); const handle = await fsp.open(\\"/dev/stdin\\", \\"r\\"); console.log(\\"handle:\\" + (await handle.readFile(\\"utf8\\")).trim()); console.log(\\"handle-second:\\" + (await handle.readFile(\\"utf8\\")).length); await handle.close(); await new Promise((resolve, reject) => fs.createWriteStream(\\"/dev/stdout\\").on(\\"error\\", reject).end(\\"device-stream-out\\\\n\\", resolve)); await new Promise((resolve, reject) => fs.createWriteStream(\\"/dev/stderr\\").on(\\"error\\", reject).end(\\"device-stream-err\\\\n\\", resolve));"',
  ].join(' '), { stdinPipe: stdinPipe('from-stream\n'), onEvent: (event) => stdioDeviceStreamEvents.push(event) });
  assertCondition(stdioDeviceStreamResult.exitCode === 0, `browser node stdio device stream workflow should succeed: ${stdioDeviceStreamResult.stderr}`);
  assertCondition(
    stdioDeviceStreamResult.stdout === 'from-stream\nhandle:\nhandle-second:0\ndevice-stream-out\n' &&
      stdioDeviceStreamResult.stderr === 'device-stream-err\n',
    `browser node fd/device streams should consume stdin and stream stdout/stderr live: ${JSON.stringify(stdioDeviceStreamResult)}`
  );
  const stdioDeviceStreamExitIndex = stdioDeviceStreamEvents.findIndex((event) =>
    event.type === 'status' && event.phase === 'process-exit'
  );
  const stdioDeviceStreamOutIndex = stdioDeviceStreamEvents.findIndex((event) =>
    event.type === 'output' &&
    event.stream === 'stdout' &&
    event.device === '/dev/stdout' &&
    event.data === 'device-stream-out\n'
  );
  const stdioDeviceStreamErrIndex = stdioDeviceStreamEvents.findIndex((event) =>
    event.type === 'output' &&
    event.stream === 'stderr' &&
    event.device === '/dev/stderr' &&
    event.data === 'device-stream-err\n'
  );
  assertCondition(
    stdioDeviceStreamOutIndex >= 0 &&
      stdioDeviceStreamErrIndex >= 0 &&
      stdioDeviceStreamExitIndex > stdioDeviceStreamOutIndex &&
      stdioDeviceStreamExitIndex > stdioDeviceStreamErrIndex,
    `browser node /dev stdio streams should emit output events before process-exit: ${JSON.stringify(stdioDeviceStreamEvents)}`
  );

  const devFsResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const names = fs.readdirSync(\\"/dev\\"); console.log(names.join(\\"\\,\\")); const entries = fs.readdirSync(\\"/dev\\", { withFileTypes: true }).map((entry) => entry.name + \\":\\" + entry.isFile() + \\":\\" + entry.isDirectory() + \\":\\" + entry.isCharacterDevice() + \\":\\" + entry.isBlockDevice() + \\":\\" + entry.isFIFO() + \\":\\" + entry.isSocket()).join(\\"|\\"); console.log(entries); const stdoutStat = fs.statSync(\\"/dev/stdout\\"); const devStat = fs.statSync(\\"/dev\\"); console.log(stdoutStat.isFile() + \\":\\" + stdoutStat.isCharacterDevice() + \\":\\" + stdoutStat.isDirectory()); console.log(devStat.isDirectory() + \\":\\" + devStat.isFile()); console.log(fs.existsSync(\\"/dev/stdin\\") + \\":\\" + fs.existsSync(\\"/dev/missing\\")); try { fs.readdirSync(\\"/dev/stdout\\"); } catch (error) { console.log(error.code); }"',
  ].join(' '));
  assertCondition(devFsResult.exitCode === 0, `browser node /dev fs workflow should succeed: ${devFsResult.stderr}`);
  assertCondition(
    devFsResult.stdout === 'fd,null,stderr,stdin,stdout,tty\nfd:false:true:false:false:false:false|null:true:false:true:false:false:false|stderr:true:false:true:false:false:false|stdin:true:false:true:false:false:false|stdout:true:false:true:false:false:false|tty:true:false:true:false:false:false\ntrue:true:false\ntrue:false\ntrue:false\nENOTDIR\n',
    `browser node fs should expose tracekernel /dev namespace: ${devFsResult.stdout}`
  );

  const stdioEndResult = await workspace.runCommand([
    'node',
    '-e',
    '"const events = []; await new Promise((resolve) => { const removed = () => events.push(\\"removed-out\\"); process.stdout.addListener(\\"finish\\", removed); process.stdout.removeListener(\\"finish\\", removed); process.stdout.once(\\"finish\\", () => events.push(\\"out-finish\\")); process.stdout.end(\\"end-out\\\\n\\", resolve); }); await new Promise((resolve) => { const removed = () => events.push(\\"removed-err\\"); process.stderr.addListener(\\"finish\\", removed); process.stderr.off(\\"finish\\", removed); process.stderr.once(\\"finish\\", () => events.push(\\"err-finish\\")); process.stderr.end(\\"end-err\\\\n\\", resolve); }); console.log(events.join(\\"\\,\\")); console.log(process.stdout.writableEnded + \\":\\" + process.stdout.writableFinished + \\":\\" + process.stdout.closed + \\":\\" + process.stdout.bytesWritten); console.log(process.stderr.writableEnded + \\":\\" + process.stderr.writableFinished + \\":\\" + process.stderr.closed + \\":\\" + process.stderr.bytesWritten);"',
  ].join(' '));
  assertCondition(stdioEndResult.exitCode === 0, `browser node stdio end workflow should succeed: ${stdioEndResult.stderr}`);
  assertCondition(
    stdioEndResult.stdout === 'end-out\nout-finish,err-finish\ntrue:true:true:8\ntrue:true:true:8\n' &&
      stdioEndResult.stderr === 'end-err\n',
    `browser node process stdio end should stream, emit finish, and expose writable state: ${JSON.stringify(stdioEndResult)}`
  );

  const processStdinResult = await workspace.runCommand([
    'node',
    '-e',
    '"process.stdin.setEncoding(\\"utf8\\"); console.log(process.stdin.read().trim());"',
  ].join(' '), { stdinPipe: stdinPipe('from-process\n') });
  assertCondition(processStdinResult.exitCode === 0, `browser node process.stdin workflow should succeed: ${processStdinResult.stderr}`);
  assertCondition(
    processStdinResult.stdout === 'from-process\n',
    `browser node process.stdin should expose request stdin as a readable device: ${JSON.stringify(processStdinResult)}`
  );

  const processStdinStateResult = await workspace.runCommand([
    'node',
    '-e',
    '"process.stdin.setEncoding(\\"utf8\\"); console.log(process.stdin.readable + \\":\\" + process.stdin.readableEnded + \\":\\" + process.stdin.readableEncoding + \\":\\" + process.stdin.readableLength + \\":\\" + String(process.stdin.readableFlowing)); const first = process.stdin.read(4); console.log(first + \\":\\" + process.stdin.readableLength + \\":\\" + process.stdin.readableEnded); process.stdin.pause(); const events = []; process.stdin.on(\\"data\\", (chunk) => events.push(\\"data:\\" + chunk)); process.stdin.on(\\"end\\", () => events.push(\\"end\\")); await new Promise((resolve) => queueMicrotask(resolve)); console.log(String(process.stdin.readableFlowing) + \\":\\" + events.join(\\"|\\")); process.stdin.resume(); await new Promise((resolve) => queueMicrotask(resolve)); console.log(String(process.stdin.readableFlowing) + \\":\\" + events.join(\\"|\\")); console.log(process.stdin.readableEnded + \\":\\" + process.stdin.readableLength);"',
  ].join(' '), { stdinPipe: stdinPipe('stdin-state\n') });
  assertCondition(processStdinStateResult.exitCode === 0, `browser node process.stdin state workflow should succeed: ${processStdinStateResult.stderr}`);
  assertCondition(
    processStdinStateResult.stdout === 'true:false:utf8:12:null\nstdi:8:false\nfalse:\ntrue:data:n-state\n|end\ntrue:0\n',
    `browser node process.stdin should expose readable state and pause/resume flow: ${JSON.stringify(processStdinStateResult)}`
  );

  const processStdinAliasResult = await workspace.runCommand([
    'node',
    '-e',
    '"process.stdin.setEncoding(\\"utf8\\"); const chunks = []; const removed = () => chunks.push(\\"removed\\"); process.stdin.addListener(\\"data\\", removed); process.stdin.removeListener(\\"data\\", removed); process.stdin.addListener(\\"data\\", (chunk) => chunks.push(chunk)); process.stdin.once(\\"end\\", () => { chunks.push(\\"end\\"); console.log(chunks.join(\\"|\\")); }); process.stdin.resume();"',
  ].join(' '), { stdinPipe: stdinPipe('stdin-alias\n') });
  assertCondition(processStdinAliasResult.exitCode === 0, `browser node process.stdin listener alias workflow should succeed: ${processStdinAliasResult.stderr}`);
  assertCondition(
    processStdinAliasResult.stdout === 'stdin-alias\n|end\n',
    `browser node process.stdin should support EventEmitter listener aliases: ${JSON.stringify(processStdinAliasResult)}`
  );

  const zlibResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const zlib = require(\\"node:zlib\\"); const gz = zlib.gzipSync(\\"hello project\\"); console.log(Buffer.isBuffer(gz)); console.log(zlib.gunzipSync(gz).toString()); const deflated = zlib.deflateSync(Buffer.from(\\"raw\\")); console.log(zlib.inflateSync(deflated).toString()); fs.writeFileSync(\\"compressed.gz\\", gz);"',
  ].join(' '));
  assertCondition(zlibResult.exitCode === 0, `browser node zlib should succeed: ${zlibResult.stderr}`);
  assertCondition(zlibResult.stdout === 'true\nhello project\nraw\n', `browser node zlib should match desktop sync APIs: ${zlibResult.stdout}`);
  assertCondition((await workspace.readFile('compressed.gz', 'base64')).length > 0, 'browser node zlib output should persist binary files');

  const encodedReadResult = await workspace.runCommand([
    'node',
    '-e',
    '"(async () => { const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); fs.writeFileSync(\\"encoded.bin\\", Buffer.from([0, 255, 65])); console.log(typeof fs.readFileSync(\\"encoded.bin\\", \\"base64\\")); console.log(fs.readFileSync(\\"encoded.bin\\", \\"base64\\")); console.log(typeof fs.readFileSync(\\"encoded.bin\\", { encoding: \\"hex\\" })); console.log(fs.readFileSync(\\"encoded.bin\\", { encoding: \\"hex\\" })); console.log(typeof await fsp.readFile(\\"encoded.bin\\", \\"base64\\")); console.log(await fsp.readFile(\\"encoded.bin\\", \\"base64\\")); })();"',
  ].join(' '));
  assertCondition(encodedReadResult.exitCode === 0, `browser node encoded reads should succeed: ${encodedReadResult.stderr}`);
  assertCondition(
    encodedReadResult.stdout === 'string\nAP9B\nstring\n00ff41\nstring\nAP9B\n',
    `browser node encoded reads should return strings: ${encodedReadResult.stdout}`
  );

  const encodedWriteResult = await workspace.runCommand([
    'node',
    '-e',
    '"(async () => { const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); fs.writeFileSync(\\"encoded-write.bin\\", \\"AP9B\\", \\"base64\\"); fs.appendFileSync(\\"encoded-write.bin\\", \\"42\\", { encoding: \\"hex\\" }); await fsp.writeFile(\\"async-encoded-write.bin\\", \\"AP9B\\", \\"base64\\"); await fsp.appendFile(\\"async-encoded-write.bin\\", \\"42\\", { encoding: \\"hex\\" }); console.log(fs.readFileSync(\\"encoded-write.bin\\").toString(\\"hex\\")); console.log(fs.readFileSync(\\"async-encoded-write.bin\\").toString(\\"hex\\")); })();"',
  ].join(' '));
  assertCondition(encodedWriteResult.exitCode === 0, `browser node encoded writes should succeed: ${encodedWriteResult.stderr}`);
  assertCondition(
    encodedWriteResult.stdout === '00ff4142\n00ff4142\n',
    `browser node encoded writes should decode strings before writing: ${encodedWriteResult.stdout}`
  );

  const directoryResult = await workspace.runCommand([
    'node',
    '--input-type=module',
    '-e',
    '"const fsMod = await import(\\"node:fs\\"); const fs = fsMod.default ?? fsMod; const fsp = await import(\\"node:fs/promises\\"); fs.mkdirSync(\\"empty/nested\\", { recursive: true }); console.log(fs.statSync(\\"empty\\").isDirectory()); console.log(fs.readdirSync(\\"empty\\").join(\\"\\,\\")); console.log(fs.readdirSync(\\"empty/nested\\").join(\\"\\,\\")); fs.rmdirSync(\\"empty/nested\\"); console.log(fs.existsSync(\\"empty/nested\\")); await fsp.mkdir(\\"async-empty/nested\\", { recursive: true }); console.log((await fsp.stat(\\"async-empty\\")).isDirectory()); console.log((await fsp.readdir(\\"async-empty\\")).join(\\"\\,\\")); await fsp.rm(\\"async-empty\\", { recursive: true }); console.log(fs.existsSync(\\"async-empty\\")); fs.rmSync(\\"empty\\", { recursive: true }); console.log(fs.existsSync(\\"empty\\"));"',
  ].join(' '));
  assertCondition(directoryResult.exitCode === 0, `browser node empty directory workflow should succeed: ${directoryResult.stderr}`);
  assertCondition(
    directoryResult.stdout === 'true\nnested\n\nfalse\ntrue\nnested\nfalse\nfalse\n',
    `browser node empty directory workflow should match desktop semantics: ${directoryResult.stdout}`
  );

  await workspace.mkdir('mkdir-cwd');
  const mkdirRecursiveReturnResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); console.log(fs.mkdirSync(\\"a/b\\", { recursive: true })); console.log(fs.mkdirSync(\\"./dot/d\\", { recursive: true })); console.log(fs.mkdirSync(\\"../sibling/c\\", { recursive: true })); console.log(await new Promise((resolve, reject) => fs.mkdir(\\"async/e\\", { recursive: true }, (error, path) => error ? reject(error) : resolve(path)))); console.log(await fsp.mkdir(\\"promise/f\\", { recursive: true }));"',
  ].join(' '), { cwd: 'mkdir-cwd' });
  assertCondition(mkdirRecursiveReturnResult.exitCode === 0, `browser node recursive mkdir return workflow should succeed: ${mkdirRecursiveReturnResult.stderr}`);
  assertCondition(
    mkdirRecursiveReturnResult.stdout === 'a\n./dot\n../sibling\nasync\npromise\n',
    `browser node recursive mkdir should return caller-relative first-created directories: ${JSON.stringify(mkdirRecursiveReturnResult)}`
  );

  const mkdirConflictResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); fs.writeFileSync(\\"mkdir-file.txt\\", \\"file\\\\n\\"); fs.mkdirSync(\\"mkdir-existing-dir\\"); const code = (fn) => { try { fn(); return \\"ok\\"; } catch (error) { return error.code; } }; console.log(code(() => fs.mkdirSync(\\"mkdir-file.txt\\"))); console.log(code(() => fs.mkdirSync(\\"mkdir-file.txt\\", { recursive: true }))); console.log(code(() => fs.mkdirSync(\\"mkdir-file.txt/child\\", { recursive: true }))); console.log(code(() => fs.mkdirSync(\\"mkdir-file.txt/child\\"))); console.log(code(() => fs.mkdirSync(\\"mkdir-existing-dir\\"))); console.log(code(() => fs.mkdirSync(\\"mkdir-existing-dir\\", { recursive: true }))); console.log(fs.statSync(\\"mkdir-file.txt\\").isFile()); console.log(fs.readFileSync(\\"mkdir-file.txt\\", \\"utf8\\")); console.log(fs.statSync(\\"mkdir-existing-dir\\").isDirectory());"',
  ].join(' '));
  assertCondition(mkdirConflictResult.exitCode === 0, `browser node mkdir conflict workflow should succeed: ${mkdirConflictResult.stderr}`);
  assertCondition(
    mkdirConflictResult.stdout === 'EEXIST\nEEXIST\nENOTDIR\nENOTDIR\nEEXIST\nok\ntrue\nfile\n\ntrue\n',
    `browser node mkdir conflicts should match desktop semantics without corrupting entries: ${mkdirConflictResult.stdout}`
  );

  const fileCreationConflictResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const code = (fn) => { try { fn(); return \\"ok\\"; } catch (error) { return error.code; } }; fs.writeFileSync(\\"parent-source.txt\\", \\"source\\\\n\\"); fs.writeFileSync(\\"parent-file.txt\\", \\"file\\\\n\\"); fs.writeFileSync(\\"rename-source.txt\\", \\"rename\\\\n\\"); fs.writeFileSync(\\"rename-existing.txt\\", \\"old\\\\n\\"); fs.mkdirSync(\\"parent-dir\\"); fs.mkdirSync(\\"rename-dir-src\\"); fs.writeFileSync(\\"rename-dir-src/value.txt\\", \\"dir\\\\n\\"); console.log(code(() => fs.writeFileSync(\\"missing-write/value.txt\\", \\"x\\"))); console.log(code(() => fs.writeFileSync(\\"parent-file.txt/value.txt\\", \\"x\\"))); console.log(code(() => fs.appendFileSync(\\"missing-append/value.txt\\", \\"x\\"))); console.log(code(() => { const fd = fs.openSync(\\"missing-open/value.txt\\", \\"w\\"); fs.closeSync(fd); })); console.log(code(() => fs.copyFileSync(\\"parent-source.txt\\", \\"missing-copy/value.txt\\"))); console.log(code(() => fs.copyFileSync(\\"parent-source.txt\\", \\"parent-dir\\"))); console.log(code(() => fs.linkSync(\\"parent-source.txt\\", \\"missing-link/value.txt\\"))); console.log(code(() => fs.renameSync(\\"rename-source.txt\\", \\"missing-rename/value.txt\\"))); console.log(code(() => fs.renameSync(\\"rename-source.txt\\", \\"parent-dir\\"))); console.log(code(() => fs.renameSync(\\"rename-dir-src\\", \\"missing-dir-rename/value.txt\\"))); console.log(code(() => fs.renameSync(\\"rename-dir-src\\", \\"parent-file.txt\\"))); console.log(code(() => fs.renameSync(\\"rename-source.txt\\", \\"rename-existing.txt\\"))); console.log(fs.readFileSync(\\"rename-existing.txt\\", \\"utf8\\")); console.log(fs.existsSync(\\"missing-write\\")); console.log(fs.existsSync(\\"missing-open\\")); console.log(fs.existsSync(\\"missing-rename\\")); console.log(fs.existsSync(\\"rename-dir-src/value.txt\\"));"',
  ].join(' '));
  assertCondition(fileCreationConflictResult.exitCode === 0, `browser node file creation conflict workflow should succeed: ${fileCreationConflictResult.stderr}`);
  assertCondition(
    fileCreationConflictResult.stdout === 'ENOENT\nENOTDIR\nENOENT\nENOENT\nENOENT\nEISDIR\nENOENT\nENOENT\nEISDIR\nENOENT\nENOTDIR\nok\nrename\n\nfalse\nfalse\nfalse\ntrue\n',
    `browser node file creation conflicts should match desktop semantics without corrupting entries: ${fileCreationConflictResult.stdout}`
  );

  const readPathConflictResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const code = (fn) => { try { const value = fn(); return value === undefined ? \\"undefined\\" : \\"ok\\"; } catch (error) { return error.code; } }; const streamCode = (path) => new Promise((resolve) => { try { fs.createReadStream(path).on(\\"error\\", (error) => resolve(error.code)).on(\\"data\\", () => {}).on(\\"end\\", () => resolve(\\"ok\\")); } catch (error) { resolve(error.code); } }); fs.writeFileSync(\\"read-parent-file.txt\\", \\"file\\\\n\\"); fs.mkdirSync(\\"read-dir\\"); fs.writeFileSync(\\"read-dir/value.txt\\", \\"value\\\\n\\"); console.log(code(() => fs.statSync(\\"read-parent-file.txt/value.txt\\"))); console.log(code(() => fs.statSync(\\"read-parent-file.txt/value.txt\\", { throwIfNoEntry: false }))); console.log(code(() => fs.readdirSync(\\"read-parent-file.txt\\"))); console.log(code(() => fs.readdirSync(\\"read-parent-file.txt/value.txt\\"))); console.log(code(() => fs.readFileSync(\\"read-dir\\"))); console.log(code(() => fs.readFileSync(\\"read-parent-file.txt/value.txt\\"))); console.log(await streamCode(\\"read-dir\\")); console.log(await streamCode(\\"read-parent-file.txt/value.txt\\")); console.log(await streamCode(\\"missing-read-stream/value.txt\\")); console.log(fs.existsSync(\\"read-parent-file.txt/value.txt\\")); console.log(fs.readdirSync(\\"read-dir\\").join(\\"\\,\\"));"',
  ].join(' '));
  assertCondition(readPathConflictResult.exitCode === 0, `browser node read path conflict workflow should succeed: ${readPathConflictResult.stderr}`);
  assertCondition(
    readPathConflictResult.stdout === 'ENOTDIR\nundefined\nENOTDIR\nENOTDIR\nEISDIR\nENOTDIR\nEISDIR\nENOTDIR\nENOENT\nfalse\nvalue.txt\n',
    `browser node read path conflicts should match desktop semantics: ${readPathConflictResult.stdout}`
  );

  const metadataPathConflictResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const code = (fn) => { try { fn(); return \\"ok\\"; } catch (error) { return error.code; } }; fs.writeFileSync(\\"metadata-parent-file.txt\\", \\"file\\\\n\\"); console.log(code(() => fs.accessSync(\\"metadata-parent-file.txt/value.txt\\"))); console.log(code(() => fs.realpathSync(\\"metadata-parent-file.txt/value.txt\\"))); console.log(code(() => fs.chmodSync(\\"metadata-parent-file.txt/value.txt\\", 0o600))); console.log(code(() => fs.chownSync(\\"metadata-parent-file.txt/value.txt\\", 0, 0))); console.log(code(() => fs.utimesSync(\\"metadata-parent-file.txt/value.txt\\", new Date(), new Date()))); console.log(code(() => fs.chmodSync(\\"missing-metadata/value.txt\\", 0o600))); console.log(fs.statSync(\\"metadata-parent-file.txt\\").isFile());"',
  ].join(' '));
  assertCondition(metadataPathConflictResult.exitCode === 0, `browser node metadata path conflict workflow should succeed: ${metadataPathConflictResult.stderr}`);
  assertCondition(
    metadataPathConflictResult.stdout === 'ENOTDIR\nENOTDIR\nENOTDIR\nENOTDIR\nENOTDIR\nENOENT\ntrue\n',
    `browser node metadata path conflicts should match desktop semantics: ${metadataPathConflictResult.stdout}`
  );

  const rmConflictResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const code = (fn) => { try { fn(); return \\"ok\\"; } catch (error) { return error.code; } }; fs.writeFileSync(\\"rm-file.txt\\", \\"file\\\\n\\"); fs.writeFileSync(\\"rm-parent-file.txt\\", \\"file\\\\n\\"); fs.mkdirSync(\\"rm-empty-dir\\"); fs.mkdirSync(\\"rm-nested-empty/child\\", { recursive: true }); fs.mkdirSync(\\"rm-nonempty\\"); fs.writeFileSync(\\"rm-nonempty/value.txt\\", \\"value\\\\n\\"); console.log(code(() => fs.rmSync(\\"rm-empty-dir\\"))); console.log(code(() => fs.rmSync(\\"rm-nested-empty\\"))); console.log(code(() => fs.rmSync(\\"rm-nonempty\\"))); console.log(code(() => fs.rmSync(\\"rm-parent-file.txt/value.txt\\", { force: true }))); console.log(code(() => fs.rmSync(\\"missing-rm/value.txt\\", { force: true }))); console.log(code(() => fs.rmdirSync(\\"rm-file.txt\\"))); console.log(code(() => fs.rmdirSync(\\"rm-parent-file.txt/value.txt\\"))); console.log(code(() => fs.rmSync(\\"rm-empty-dir\\", { recursive: true }))); console.log(code(() => fs.rmSync(\\"rm-nested-empty\\", { recursive: true }))); console.log(code(() => fs.rmSync(\\"rm-nonempty\\", { recursive: true }))); console.log(fs.existsSync(\\"rm-empty-dir\\")); console.log(fs.existsSync(\\"rm-nested-empty/child\\")); console.log(fs.existsSync(\\"rm-nonempty/value.txt\\")); console.log(fs.statSync(\\"rm-parent-file.txt\\").isFile());"',
  ].join(' '));
  assertCondition(rmConflictResult.exitCode === 0, `browser node rm conflict workflow should succeed: ${rmConflictResult.stderr}`);
  assertCondition(
    rmConflictResult.stdout === 'ERR_FS_EISDIR\nERR_FS_EISDIR\nERR_FS_EISDIR\nENOTDIR\nok\nENOTDIR\nENOTDIR\nok\nok\nok\nfalse\nfalse\nfalse\ntrue\n',
    `browser node rm/rmdir conflicts should match desktop semantics without corrupting entries: ${rmConflictResult.stdout}`
  );

  const directoryMutationResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const flush = () => new Promise((resolve) => queueMicrotask(resolve)); fs.mkdirSync(\\"watch-parent\\"); const watchEvents = []; const statEvents = []; const watcher = fs.watch(\\"watch-parent\\", (type, name) => watchEvents.push(type + \\":\\" + name)); fs.watchFile(\\"appearing-dir\\", (curr, prev) => statEvents.push(prev.isDirectory() + \\"->\\" + curr.isDirectory())); fs.mkdirSync(\\"appearing-dir\\"); await flush(); fs.rmdirSync(\\"appearing-dir\\"); await flush(); fs.unwatchFile(\\"appearing-dir\\"); const syncDir = fs.mkdtempSync(\\"watch-parent/temp\\"); const callbackDir = await new Promise((resolve, reject) => fs.mkdtemp(\\"watch-parent/cb\\", (error, dir) => error ? reject(error) : resolve(dir))); const promiseDir = await fsp.mkdtemp(\\"watch-parent/pr\\"); await flush(); watcher.close(); console.log(/^watch-parent\\\\/temp[0-9a-z]{6}$/.test(syncDir)); console.log(/^watch-parent\\\\/cb[0-9a-z]{6}$/.test(callbackDir)); console.log(/^watch-parent\\\\/pr[0-9a-z]{6}$/.test(promiseDir)); console.log(watchEvents.some((event) => event === \\"rename:\\" + syncDir.split(\\"/\\").pop())); console.log(watchEvents.some((event) => event === \\"rename:\\" + callbackDir.split(\\"/\\").pop())); console.log(watchEvents.some((event) => event === \\"rename:\\" + promiseDir.split(\\"/\\").pop())); console.log(statEvents.join(\\"|\\"));"',
  ].join(' '));
  assertCondition(directoryMutationResult.exitCode === 0, `browser node directory mutation workflow should succeed: ${directoryMutationResult.stderr}`);
  assertCondition(
    directoryMutationResult.stdout === 'true\ntrue\ntrue\ntrue\ntrue\ntrue\nfalse->true|true->false\n',
    `browser node directory mutations should notify watchers and support mkdtemp APIs: ${directoryMutationResult.stdout}`
  );

  const direntResult = await workspace.runCommand([
    'node',
    '-e',
    '"(async () => { const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); fs.mkdirSync(\\"dirent/sub\\", { recursive: true }); fs.writeFileSync(\\"dirent/file.txt\\", \\"x\\"); const label = (entry) => entry.name + \\":\\" + entry.isFile() + \\":\\" + entry.isDirectory() + \\":\\" + entry.isSymbolicLink(); const syncEntries = fs.readdirSync(\\"dirent\\", { withFileTypes: true }).map(label).sort(); console.log(syncEntries.join(\\"|\\")); const asyncEntries = (await fsp.readdir(\\"dirent\\", { withFileTypes: true })).map(label).sort(); console.log(asyncEntries.join(\\"|\\")); })();"',
  ].join(' '));
  assertCondition(direntResult.exitCode === 0, `browser node readdir Dirent workflow should succeed: ${direntResult.stderr}`);
  assertCondition(
    direntResult.stdout === 'file.txt:true:false:false|sub:false:true:false\nfile.txt:true:false:false|sub:false:true:false\n',
    `browser node readdir withFileTypes should return Dirent-like entries: ${direntResult.stdout}`
  );

  const recursiveReaddirResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const call = (fn) => new Promise((resolve, reject) => fn((error, files) => error ? reject(error) : resolve(files))); fs.mkdirSync(\\"recursive/a/b\\", { recursive: true }); fs.writeFileSync(\\"recursive/root.txt\\", \\"root\\"); fs.writeFileSync(\\"recursive/a/value.txt\\", \\"a\\"); fs.writeFileSync(\\"recursive/a/b/deep.txt\\", \\"deep\\"); console.log(fs.readdirSync(\\"recursive\\", { recursive: true }).join(\\"|\\")); console.log((await call((done) => fs.readdir(\\"recursive\\", { recursive: true }, done))).join(\\"|\\")); console.log((await fsp.readdir(\\"recursive\\", { recursive: true })).join(\\"|\\")); const entries = fs.readdirSync(\\"recursive\\", { recursive: true, withFileTypes: true }).map((entry) => entry.name + \\":\\" + entry.isDirectory() + \\":\\" + entry.parentPath.replace(/^.*\\\\/recursive/, \\"recursive\\")).sort(); console.log(entries.join(\\"|\\"));"',
  ].join(' '));
  assertCondition(recursiveReaddirResult.exitCode === 0, `browser node recursive readdir workflow should succeed: ${recursiveReaddirResult.stderr}`);
  assertCondition(
    recursiveReaddirResult.stdout === 'a|a/b|a/b/deep.txt|a/value.txt|root.txt\na|a/b|a/b/deep.txt|a/value.txt|root.txt\na|a/b|a/b/deep.txt|a/value.txt|root.txt\na:true:recursive|b:true:recursive/a|deep.txt:false:recursive/a/b|root.txt:false:recursive|value.txt:false:recursive/a\n',
    `browser node readdir recursive should walk virtual directories: ${recursiveReaddirResult.stdout}`
  );

  const pathResult = await workspace.runCommand([
    'node',
    '-e',
    '"const path = require(\\"node:path\\"); console.log(path.normalize(\\"/workspace/src/../lib/file.js\\")); console.log(path.normalize(\\"src/../lib/file.js\\")); console.log(path.dirname(\\"/workspace/src/index.js\\")); console.log(path.basename(\\"/workspace/src/index.test.js\\", \\".js\\")); console.log(path.extname(\\"/workspace/src/index.test.js\\")); console.log(path.isAbsolute(\\"/workspace/src/index.js\\")); console.log(path.relative(\\"/workspace/src/app\\", \\"/workspace/src/lib/helper.js\\")); console.log(path.resolve(\\"/workspace/src/app\\", \\"../lib/helper.js\\")); console.log(path.posix.relative(\\"/workspace/a\\", \\"/workspace/b/c.js\\")); console.log(JSON.stringify(path.parse(\\"/workspace/src/app.test.js\\"))); console.log(path.format({ dir: \\"/workspace/out\\", name: \\"bundle\\", ext: \\".js\\" })); console.log(path.format({ root: \\"/\\", base: \\"x.txt\\" }));"',
  ].join(' '));
  assertCondition(pathResult.exitCode === 0, `browser node path API should succeed: ${pathResult.stderr}`);
  assertCondition(
    pathResult.stdout === '/workspace/lib/file.js\nlib/file.js\n/workspace/src\nindex.test\n.js\ntrue\n../lib/helper.js\n/workspace/src/lib/helper.js\n../b/c.js\n{"root":"/","dir":"/workspace/src","base":"app.test.js","ext":".js","name":"app.test"}\n/workspace/out/bundle.js\n/x.txt\n',
    `browser node path API should provide desktop posix behavior: ${pathResult.stdout}`
  );

  const fileUrlResult = await workspace.runCommand([
    'node',
    '-e',
    '"(async () => { const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); const url = require(\\"node:url\\"); const fileUrl = url.pathToFileURL(\\"/workspace/url-file.txt\\"); fs.writeFileSync(fileUrl, \\"url-sync\\\\n\\"); console.log(fs.readFileSync(fileUrl, \\"utf8\\")); console.log(fs.existsSync(fileUrl)); await fsp.writeFile(fileUrl, \\"url-async\\\\n\\"); console.log(await fsp.readFile(fileUrl, \\"utf8\\")); fs.unlinkSync(fileUrl); console.log(fs.existsSync(fileUrl)); })();"',
  ].join(' '));
  assertCondition(fileUrlResult.exitCode === 0, `browser node file URL fs workflow should succeed: ${fileUrlResult.stderr}`);
  assertCondition(
    fileUrlResult.stdout === 'url-sync\n\ntrue\nurl-async\n\nfalse\n',
    `browser node fs should accept file URL paths: ${fileUrlResult.stdout}`
  );

  const builtinResult = await workspace.runCommand([
    'node',
    '-e',
    '"const os = require(\\"node:os\\"); const url = require(\\"node:url\\"); const fileUrl = url.pathToFileURL(\\"/workspace/lib/math.js\\"); console.log(os.platform()); console.log(os.tmpdir()); console.log(os.EOL === \\"\\\\n\\"); console.log(new url.URL(\\"https://example.com/a?x=1\\").searchParams.get(\\"x\\")); console.log(url.fileURLToPath(fileUrl));"',
  ].join(' '));
  assertCondition(builtinResult.exitCode === 0, `browser node os/url builtins should succeed: ${builtinResult.stderr}`);
  assertCondition(
    builtinResult.stdout === 'tracekernel\n/tmp\ntrue\n1\n/workspace/lib/math.js\n',
    `browser node os/url builtins should expose desktop-shaped APIs: ${builtinResult.stdout}`
  );
}

async function testTraceKernelHttpNodeServer(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'server.js',
        contents: [
          'const http = require("node:http");',
          'const queue = [];',
          'http.createServer((req, res) => {',
          '  let body = "";',
          '  req.setEncoding("utf8");',
          '  req.on("data", (chunk) => { body += chunk; });',
          '  req.on("end", () => {',
          '    if (req.method === "GET" && req.url === "/slow") {',
          '      setTimeout(() => {',
          '        res.writeHead(200, { "content-type": "text/plain" });',
          '        res.end("slow\\n");',
          '      }, 50);',
          '      return;',
          '    }',
          '    if (req.method === "GET" && req.url.startsWith("/echo")) {',
          '      res.setHeader("x-trace", req.complete && req.rawHeaders.length > 0 ? "yes" : "no");',
          '      const headerSnapshot = res.getHeaders();',
          '      const hasTrace = res.hasHeader("x-trace");',
          '      res.writeHead(200, { "content-type": "application/json" });',
          '      res.end(JSON.stringify({ method: req.method, url: req.url, body, hasTrace, trace: headerSnapshot["x-trace"], client: req.headers["x-client"] || "" }) + "\\n");',
          '      return;',
          '    }',
          '    if (req.method === "HEAD" && req.url === "/dequeue") {',
          '      res.writeHead(200, { "content-type": "application/json", "x-queue-size": String(queue.length) });',
          '      res.end("ignored\\n");',
          '      return;',
          '    }',
          '    if (req.method === "POST" && req.url === "/enqueue") {',
          '      queue.push(JSON.parse(body));',
          '      res.writeHead(201, { "content-type": "application/json" });',
          '      res.end(JSON.stringify({ size: queue.length }) + "\\n");',
          '      return;',
          '    }',
          '    if (req.method === "GET" && req.url === "/dequeue") {',
          '      res.writeHead(200, { "content-type": "application/json" });',
          '      res.end(JSON.stringify(queue.shift() ?? null) + "\\n");',
          '      return;',
          '    }',
          '    res.writeHead(404, { "content-type": "text/plain" });',
          '    res.end("missing\\n");',
          '  });',
          '}).listen(3000, "127.0.0.1");',
          '',
        ].join('\n'),
      },
      {
        path: 'timeout-client.js',
        contents: [
          'const http = require("node:http");',
          '(async () => {',
          'await new Promise((resolve) => {',
          '  const req = http.get({ hostname: "localhost", port: 3000, path: "/slow", timeout: 1 }, () => {',
          '    console.log("unexpected-response");',
          '    resolve();',
          '  });',
          '  req.on("error", (error) => {',
          '    console.log(error.code);',
          '    resolve();',
          '  });',
          '});',
          '})().catch((error) => { console.error(error.message); process.exitCode = 1; });',
          '',
        ].join('\n'),
      },
      {
        path: 'fetch-client.js',
        contents: [
          '(async () => {',
          '  const enqueue = await fetch(new Request("http://localhost:3000/enqueue", {',
          '    method: "POST",',
          '    headers: new Headers({ "content-type": "application/json" }),',
          '    body: JSON.stringify({ id: 3 }),',
          '  }));',
          '  console.log(`${enqueue.status}:${enqueue.ok}:${enqueue.headers.get("content-type")}`);',
          '  const enqueueBody = await enqueue.json();',
          '  console.log(`${JSON.stringify(enqueueBody)}:${enqueue.bodyUsed}`);',
          '  const dequeue = await fetch("http://localhost:3000/dequeue");',
          '  console.log(`${dequeue.status}:${await dequeue.text()}`.trim());',
          '  const echo = await fetch("http://localhost:3000/echo?fetch=1", { headers: [["x-client", "fetch"]] });',
          '  console.log((await echo.text()).trim());',
          '  const controller = new AbortController();',
          '  const aborted = fetch("http://localhost:3000/slow", { signal: controller.signal }).catch((error) => error.name);',
          '  controller.abort();',
          '  console.log(await aborted);',
          '})().catch((error) => { console.error(error.message); process.exitCode = 1; });',
          '',
        ].join('\n'),
      },
      {
        path: 'client.js',
        contents: [
          'const http = require("node:http");',
          'function call(options, body) {',
          '  return new Promise((resolve, reject) => {',
          '    const req = http.request(options, (res) => {',
          '      let responseBody = "";',
          '      res.setEncoding("utf8");',
          '      res.on("data", (chunk) => { responseBody += chunk; });',
          '      res.on("end", () => resolve({ statusCode: res.statusCode, body: responseBody }));',
          '    });',
          '    req.on("error", reject);',
          '    if (body) req.write(body);',
          '    req.end();',
          '  });',
          '}',
          '(async () => {',
          '  const enqueue = await call({ hostname: "localhost", port: 3000, path: "/enqueue", method: "POST", headers: { "content-type": "application/json" } }, JSON.stringify({ id: 2 }));',
          '  const dequeue = await new Promise((resolve, reject) => {',
          '    const req = http.get("http://localhost:3000/dequeue", (res) => {',
          '      let body = "";',
          '      res.setEncoding("utf8");',
          '      res.on("data", (chunk) => { body += chunk; });',
          '      res.on("end", () => resolve({ statusCode: res.statusCode, body }));',
          '    });',
          '    req.on("error", reject);',
          '  });',
          '  console.log(`${enqueue.statusCode}:${enqueue.body.trim()}`);',
          '  console.log(`${dequeue.statusCode}:${dequeue.body.trim()}`);',
          '})().catch((error) => { console.error(error.message); process.exitCode = 1; });',
          '',
        ].join('\n'),
      },
    ],
    kernel: { scheduler: { maxConcurrentCommands: 4 } },
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true }),
  });

  const terminal = workspace.createTerminalSession();
  const start = await terminal.run('node server.js &');
  assertCondition(start.exitCode === 0, `background server should start: ${JSON.stringify(start)}`);

  let listeners = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    listeners = await workspace.readFile('/proc/tracekernel/net/listeners');
    if (listeners.includes('\thttp\t127.0.0.1\t3000\t')) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assertCondition(listeners.includes('\thttp\t127.0.0.1\t3000\t'), `tracekernel should expose HTTP listener: ${listeners}`);

  const apiResponse = await workspace.http.request({
    url: 'http://localhost:3000/echo?api=1',
    headers: { 'x-client': 'workspace-api' },
  });
  assertCondition(apiResponse.status === 200, `workspace.http.request should succeed: ${JSON.stringify(apiResponse)}`);
  assertCondition(
    apiResponse.body === '{"method":"GET","url":"/echo?api=1","body":"","hasTrace":true,"trace":"yes","client":"workspace-api"}\n',
    `workspace.http.request should dispatch through TraceKernel: ${apiResponse.body}`
  );

  const fetchClient = await workspace.runCommand('node fetch-client.js');
  assertCondition(fetchClient.exitCode === 0, `fetch client should call TraceKernel listener: ${JSON.stringify(fetchClient)}`);
  assertCondition(
    fetchClient.stdout === [
      '201:true:application/json',
      '{"size":1}:true',
      '200:{"id":3}',
      '{"method":"GET","url":"/echo?fetch=1","body":"","hasTrace":true,"trace":"yes","client":"fetch"}',
      'AbortError',
      '',
    ].join('\n'),
    `fetch should expose browser-shaped response helpers and aborts: ${fetchClient.stdout}`
  );

  const nodeClient = await workspace.runCommand('node client.js');
  assertCondition(nodeClient.exitCode === 0, `Node http client should call TraceKernel listener: ${JSON.stringify(nodeClient)}`);
  assertCondition(
    nodeClient.stdout === '201:{"size":1}\n200:{"id":2}\n',
    `Node http.request/http.get should dispatch through TraceKernel: ${nodeClient.stdout}`
  );

  const timeoutClient = await workspace.runCommand('node timeout-client.js');
  assertCondition(timeoutClient.exitCode === 0, `Node timeout client should finish: ${JSON.stringify(timeoutClient)}`);
  assertCondition(timeoutClient.stdout === 'ETIMEDOUT\n', `Node timeout should abort the client request: ${timeoutClient.stdout}`);

  const enqueue = await workspace.runCommand('curl -s --json \'{"id":1}\' http://localhost:3000/enqueue');
  assertCondition(enqueue.exitCode === 0, `curl enqueue should succeed: ${JSON.stringify(enqueue)}`);
  assertCondition(enqueue.stdout === '{"size":1}\n', `curl enqueue should return JSON: ${enqueue.stdout}`);

  const echo = await workspace.runCommand('curl -s -H "x-client: trace" -G -d "q=hello world" http://localhost:3000/echo');
  assertCondition(echo.exitCode === 0, `curl -G echo should succeed: ${JSON.stringify(echo)}`);
  assertCondition(
    echo.stdout === '{"method":"GET","url":"/echo?q=hello+world","body":"","hasTrace":true,"trace":"yes","client":"trace"}\n',
    `curl -G should append data to query and preserve Node request metadata: ${echo.stdout}`
  );

  const head = await workspace.runCommand('curl -s -I http://localhost:3000/dequeue');
  assertCondition(head.exitCode === 0, `curl HEAD should succeed: ${JSON.stringify(head)}`);
  assertCondition(
    head.stdout.includes('HTTP/1.1 200\n') &&
      head.stdout.includes('x-queue-size: 1\n') &&
      !head.stdout.includes('ignored'),
    `curl HEAD should include headers without a response body: ${head.stdout}`
  );

  const fail = await workspace.runCommand('curl -s --fail http://localhost:3000/missing');
  assertCondition(fail.exitCode === 22, `curl --fail should map HTTP errors to exit 22: ${JSON.stringify(fail)}`);

  const dequeue = await workspace.runCommand('curl -s -o out.json http://localhost:3000/dequeue');
  assertCondition(dequeue.exitCode === 0, `curl -o dequeue should succeed: ${JSON.stringify(dequeue)}`);
  assertCondition(dequeue.stdout === '', `curl -o should not write body to stdout: ${dequeue.stdout}`);
  const writtenDequeue = await workspace.readFile('out.json');
  assertCondition(writtenDequeue === '{"id":1}\n', `curl -o should write through the workspace filesystem: ${writtenDequeue}`);

  const requests = await workspace.readFile('/proc/tracekernel/net/requests');
  assertCondition(
    requests.includes('POST\thttp://localhost:3000/enqueue\t201') &&
      requests.includes('GET\thttp://localhost:3000/dequeue\t200'),
    `tracekernel should expose HTTP request log: ${requests}`
  );

  const listenerRow = listeners.split('\n').find((line) => line.includes('\thttp\t127.0.0.1\t3000\t'));
  const serverPid = listenerRow?.split('\t')[1];
  assertCondition(serverPid !== undefined, `listener row should include owning pid: ${listeners}`);
  const killed = await workspace.runCommand(`kill ${serverPid}`);
  assertCondition(killed.exitCode === 0, `kill should stop server process: ${JSON.stringify(killed)}`);
  await workspace.runCommand(`wait ${serverPid}`);

  const afterKillListeners = await workspace.readFile('/proc/tracekernel/net/listeners');
  assertCondition(!afterKillListeners.includes('\thttp\t127.0.0.1\t3000\t'), `listener should close on process exit: ${afterKillListeners}`);
  const refused = await workspace.runCommand('curl -s http://localhost:3000/dequeue');
  assertCondition(refused.exitCode === 7, `curl should fail after listener closes: ${JSON.stringify(refused)}`);
}

async function testTraceKernelHttpNodeServerWorkerBridge(): Promise<void> {
  const restoreHostGlobals = snapshotFakeWorkerHostGlobals();
  try {
    const workerUrl = `${pathToFileURL(join(testDirectory, '../packages/harness-javascript/src/project-browser-worker.ts')).href}?tracekernel-http=${Date.now()}`;
    const workspace = await createRuntimeWorkspace({
      files: [
        {
          path: 'server.js',
          contents: [
            'const http = require("node:http");',
            'const server = http.createServer((req, res) => {',
            '  res.writeHead(200, { "content-type": "text/plain" });',
            '  res.end(req.method + " " + req.url + "\\n");',
            '});',
            'server.listen(3100, "127.0.0.1");',
            'process.on("SIGTERM", () => server.close(() => console.log("worker-server-closed")));',
            '',
          ].join('\n'),
        },
        {
          path: 'client.js',
          contents: [
            'const http = require("node:http");',
            'http.get("http://localhost:3100/worker-client", (res) => {',
            '  let body = "";',
            '  res.setEncoding("utf8");',
            '  res.on("data", (chunk) => { body += chunk; });',
            '  res.on("end", () => { console.log(`${res.statusCode}:${body.trim()}`); });',
            '}).on("error", (error) => { console.error(error.message); process.exitCode = 1; });',
            '',
          ].join('\n'),
        },
        {
          path: 'duplicate.js',
          contents: [
            'const http = require("node:http");',
            'http.createServer((_req, res) => res.end("duplicate"))',
            '  .listen(3100, "127.0.0.1", () => console.log("unexpected-listen"));',
            '',
          ].join('\n'),
        },
      ],
      kernel: { scheduler: { maxConcurrentCommands: 4 } },
      nodeRunner: createBrowserJavaScriptProjectRunner({
        workerUrl,
        workerFactory: (url) => new FakeModuleWorker(String(url)),
      }),
    });

    const terminal = workspace.createTerminalSession();
    const start = await terminal.run('node server.js &');
    assertCondition(start.exitCode === 0, `worker-backed background server should start: ${JSON.stringify(start)}`);

    let listeners = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      listeners = await workspace.readFile('/proc/tracekernel/net/listeners');
      if (listeners.includes('\thttp\t127.0.0.1\t3100\t')) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assertCondition(listeners.includes('\thttp\t127.0.0.1\t3100\t'), `worker-backed HTTP listener should register with TraceKernel: ${listeners}`);

    const response = await workspace.runCommand('curl -s http://localhost:3100/worker');
    assertCondition(response.exitCode === 0, `worker-backed curl should succeed: ${JSON.stringify(response)}`);
    assertCondition(response.stdout === 'GET /worker\n', `worker-backed Node HTTP server should answer through protocol bridge: ${response.stdout}`);

    const client = await workspace.runCommand('node client.js');
    assertCondition(client.exitCode === 0, `worker-backed Node http client should succeed: ${JSON.stringify(client)}`);
    assertCondition(
      client.stdout === '200:GET /worker-client\n',
      `worker-backed Node http.get should dispatch through TraceKernel: ${client.stdout}`
    );

    const secondTerminal = workspace.createTerminalSession();
    const duplicate = await secondTerminal.run('node duplicate.js');
    assertCondition(duplicate.exitCode !== 0, `worker-backed duplicate bind should fail: ${JSON.stringify(duplicate)}`);
    assertCondition(
      duplicate.stderr.includes('EADDRINUSE: address already in use 127.0.0.1:3100'),
      `worker-backed duplicate bind should report EADDRINUSE: ${JSON.stringify(duplicate)}`
    );
    assertCondition(
      !duplicate.stdout.includes('unexpected-listen'),
      `worker-backed rejected bind must not invoke the listen callback: ${JSON.stringify(duplicate)}`
    );
    const responseAfterConflict = await workspace.runCommand('curl -s http://localhost:3100/still-listening');
    assertCondition(
      responseAfterConflict.stdout === 'GET /still-listening\n',
      `original worker-backed listener should survive a conflicting bind: ${JSON.stringify(responseAfterConflict)}`
    );

    const listenerRow = listeners.split('\n').find((line) => line.includes('\thttp\t127.0.0.1\t3100\t'));
    const serverPid = listenerRow?.split('\t')[1];
    assertCondition(serverPid !== undefined, `worker-backed listener row should include pid: ${listeners}`);
    const killed = await workspace.runCommand(`kill ${serverPid}`);
    assertCondition(killed.exitCode === 0, `worker-backed server should be killable: ${JSON.stringify(killed)}`);
    const waited = await workspace.runCommand(`wait ${serverPid}`);
    assertCondition(
      waited.exitCode === 0,
      `worker-backed signal handlers should close resources and exit naturally: ${JSON.stringify(waited)}`
    );
  } finally {
    restoreHostGlobals();
  }
}

async function testExternalFetchFromJavaScriptWorker(): Promise<void> {
  const restoreHostGlobals = snapshotFakeWorkerHostGlobals();
  const seen: Array<{ method: string; url: string; body?: string }> = [];
  try {
    const workerUrl = `${pathToFileURL(join(testDirectory, '../packages/harness-javascript/src/project-browser-worker.ts')).href}?tracekernel-external-http=${Date.now()}`;
    const workspace = await createRuntimeWorkspace({
      files: [{
        path: 'external-fetch.js',
        contents: [
          '(async () => {',
          '  const response = await fetch("https://allowed.example/x", {',
          '    method: "POST",',
          '    headers: { "x-worker": "yes" },',
          '    body: "worker-body",',
          '  });',
          '  console.log(response.status + ":" + response.headers.get("x-echo"));',
          '  console.log(await response.text());',
          '})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });',
          '',
        ].join('\n'),
      }],
      externalHttp: {
        hosts: ['allowed.example'],
        fetch: async (request) => {
          seen.push({ method: request.method, url: request.url, ...(request.body !== undefined ? { body: request.body } : {}) });
          return { status: 209, headers: { 'x-echo': request.headers['x-worker'] ?? '' }, body: `${request.method}:${request.body ?? ''}\n` };
        },
      },
      nodeRunner: createBrowserJavaScriptProjectRunner({
        workerUrl,
        workerFactory: (url) => new FakeModuleWorker(String(url)),
      }),
    });
    try {
      const result = await workspace.runCommand('node external-fetch.js');
      assertCondition(result.exitCode === 0, `browser JS worker fetch should succeed through kernel bridge: ${JSON.stringify(result)}`);
      assertCondition(
        result.stdout === '209:yes\nPOST:worker-body\n\n',
        `browser JS worker external fetch response mismatch: ${JSON.stringify(result.stdout)}`
      );
      assertCondition(
        seen.length === 1 && seen[0]?.method === 'POST' && seen[0]?.url === 'https://allowed.example/x' && seen[0]?.body === 'worker-body',
        `browser JS worker fetch should reach host delegate: ${JSON.stringify(seen)}`
      );
    } finally {
      workspace.dispose();
    }
  } finally {
    restoreHostGlobals();
  }
}

async function testTraceKernelHttpBindSemantics(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'ephemeral.js',
        contents: [
          'const fs = require("node:fs");',
          'const http = require("node:http");',
          'const server = http.createServer((req, res) => {',
          '  res.writeHead(200, { "content-type": "text/plain" });',
          '  res.end(server.address().address + ":" + server.address().port + "\\n");',
          '});',
          'server.listen(0, () => {',
          '  fs.writeFileSync("port.txt", String(server.address().port));',
          '});',
          '',
        ].join('\n'),
      },
    ],
    kernel: { scheduler: { maxConcurrentCommands: 4 } },
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true }),
  });

  const terminal = workspace.createTerminalSession();
  const start = await terminal.run('node ephemeral.js &');
  assertCondition(start.exitCode === 0, `ephemeral HTTP server should start: ${JSON.stringify(start)}`);

  let port = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await workspace.exists('port.txt')) {
      port = (await workspace.readFile('port.txt')).trim();
      if (port) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assertCondition(Number(port) >= 49152, `listen(0) should allocate an ephemeral port: ${port}`);
  const listeners = await workspace.readFile('/proc/tracekernel/net/listeners');
  assertCondition(
    listeners.includes(`\thttp\t127.0.0.1\t${port}\t`),
    `default runtime listen host should bind loopback and expose allocated port: ${listeners}`
  );

  const response = await workspace.runCommand(`curl -s http://localhost:${port}/`);
  assertCondition(response.exitCode === 0, `loopback listener should accept localhost requests: ${JSON.stringify(response)}`);
  assertCondition(response.stdout === `127.0.0.1:${port}\n`, `loopback listener should report bound address: ${response.stdout}`);

  await workspace.writeFile('duplicate.js', [
    'const http = require("node:http");',
    'try {',
    `  http.createServer((req, res) => res.end("duplicate")).listen(${port}, "127.0.0.1");`,
    '  console.log("unexpected");',
    '} catch (error) {',
    '  console.log(error.code);',
    '}',
    '',
  ].join('\n'));
  const duplicate = await workspace.runCommand('node duplicate.js');
  assertCondition(duplicate.exitCode === 0, `duplicate bind check should finish: ${JSON.stringify(duplicate)}`);
  assertCondition(duplicate.stdout === 'EADDRINUSE\n', `loopback listener should conflict with exact bind: ${duplicate.stdout}`);

  await workspace.writeFile('wildcard.js', [
    'const http = require("node:http");',
    'try {',
    '  http.createServer((req, res) => res.end("wildcard")).listen(0, "0.0.0.0");',
    '  console.log("unexpected");',
    '} catch (error) {',
    '  console.log(error.code);',
    '}',
    '',
  ].join('\n'));
  const wildcard = await workspace.runCommand('node wildcard.js');
  assertCondition(wildcard.exitCode === 0, `explicit wildcard bind check should finish: ${JSON.stringify(wildcard)}`);
  assertCondition(wildcard.stdout === 'EACCES\n', `runtime wildcard bind should be rejected: ${wildcard.stdout}`);

  const listenerRow = listeners.split('\n').find((line) => line.includes(`\thttp\t127.0.0.1\t${port}\t`));
  const serverPid = listenerRow?.split('\t')[1];
  assertCondition(serverPid !== undefined, `ephemeral listener row should include pid: ${listeners}`);
  const killed = await workspace.runCommand(`kill ${serverPid}`);
  assertCondition(killed.exitCode === 0, `ephemeral server should be killable: ${JSON.stringify(killed)}`);
  await workspace.runCommand(`wait ${serverPid}`);
}

async function testTraceKernelHttpPythonRunnerBridge(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'server.py', contents: 'import uvicorn\n' },
      {
        path: 'fetch-python.js',
        contents: [
          '(async () => {',
          '  const response = await fetch("http://localhost:3200/from-fetch", {',
          '    method: "POST",',
          '    headers: { "content-type": "text/plain" },',
          '    body: "payload",',
          '  });',
          '  console.log(`${response.status}:${response.ok}:${JSON.stringify(await response.json())}`);',
          '})().catch((error) => { console.error(error.message); process.exitCode = 1; });',
          '',
        ].join('\n'),
      },
    ],
    kernel: { scheduler: { maxConcurrentCommands: 4 } },
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true }),
    pythonRunner: async (request) => {
      const handle = request.kernelHttp?.listen({ host: '127.0.0.1', port: 3200 }, async (httpRequest) => ({
        status: httpRequest.method === 'POST' ? 201 : 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: httpRequest.method, path: httpRequest.path, body: httpRequest.body ?? '' }) + '\n',
      }));
      assertCondition(handle !== undefined, 'Python runner should receive TraceKernel HTTP bridge');
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) {
          resolve();
          return;
        }
        request.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      handle.close();
      return { stdout: '', stderr: '', exitCode: 143 };
    },
  });

  const terminal = workspace.createTerminalSession();
  const start = await terminal.run('python server.py &');
  assertCondition(start.exitCode === 0, `Python background server should start: ${JSON.stringify(start)}`);

  let listeners = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    listeners = await workspace.readFile('/proc/tracekernel/net/listeners');
    if (listeners.includes('\thttp\t127.0.0.1\t3200\t')) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assertCondition(listeners.includes('\thttp\t127.0.0.1\t3200\t'), `Python runner bridge should register HTTP listener: ${listeners}`);

  const response = await workspace.runCommand('curl -s -X POST -d payload http://localhost:3200/asgi');
  assertCondition(response.exitCode === 0, `Python runner bridge curl should succeed: ${JSON.stringify(response)}`);
  assertCondition(
    response.stdout === '{"method":"POST","path":"/asgi","body":"payload"}\n',
    `Python runner bridge should dispatch requests through TraceKernel: ${response.stdout}`
  );

  const fetchResponse = await workspace.runCommand('node fetch-python.js');
  assertCondition(fetchResponse.exitCode === 0, `fetch should call Python runner bridge: ${JSON.stringify(fetchResponse)}`);
  assertCondition(
    fetchResponse.stdout === '201:true:{"method":"POST","path":"/from-fetch","body":"payload"}\n',
    `fetch should dispatch to Python HTTP listeners through TraceKernel: ${fetchResponse.stdout}`
  );

  const listenerRow = listeners.split('\n').find((line) => line.includes('\thttp\t127.0.0.1\t3200\t'));
  const serverPid = listenerRow?.split('\t')[1];
  assertCondition(serverPid !== undefined, `Python listener row should include owning pid: ${listeners}`);
  const killed = await workspace.runCommand(`kill ${serverPid}`);
  assertCondition(killed.exitCode === 0, `Python bridge process should be killable: ${JSON.stringify(killed)}`);
  await workspace.runCommand(`wait ${serverPid}`);
}

async function testTraceKernelHttpPythonRunnerClientBridge(): Promise<void> {
  const receivedRequests: Array<{ method: string; path: string; body?: string }> = [];
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'client.py', contents: 'print("client")\n' },
    ],
    pythonRunner: async (request) => {
      const response = await request.kernelHttp?.dispatch({
        method: 'POST',
        url: 'http://localhost:3210/from-python-runner',
        path: '/from-python-runner',
        headers: { 'content-type': 'application/json', 'x-client': 'python-runner' },
        rawHeaders: [['content-type', 'application/json'], ['x-client', 'python-runner']],
        body: JSON.stringify({ scriptPath: request.scriptPath }),
      });
      return {
        stdout: `${response?.status}:${response?.body ?? ''}`,
        stderr: '',
        exitCode: response?.status === 202 ? 0 : 1,
      };
    },
  });
  const mockServer = workspace.http.listen({ host: '127.0.0.1', port: 3210 }, (request) => {
    receivedRequests.push({
      method: request.method,
      path: request.path,
      ...(request.body !== undefined ? { body: request.body } : {}),
    });
    return {
      status: 202,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: request.method,
        path: request.path,
        body: request.body ?? '',
        client: request.headers?.['x-client'] ?? '',
      }) + '\n',
    };
  });

  const result = await workspace.runCommand('python3 client.py');
  assertCondition(result.exitCode === 0, `Python project runner should call consumer-owned listener: ${JSON.stringify(result)}`);
  assertCondition(
    result.stdout === '202:{"method":"POST","path":"/from-python-runner","body":"{\\"scriptPath\\":\\"client.py\\"}","client":"python-runner"}\n',
    `Python project runner should receive consumer-owned listener response: ${result.stdout}`
  );
  assertCondition(
    receivedRequests.length === 1 &&
      receivedRequests[0]?.method === 'POST' &&
      receivedRequests[0]?.path === '/from-python-runner' &&
      receivedRequests[0]?.body === '{"scriptPath":"client.py"}',
    `consumer-owned listener should receive Python runner request: ${JSON.stringify(receivedRequests)}`
  );
  mockServer.close();
  workspace.dispose();
}

async function testTraceKernelHttpJavaRunnerBridge(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'Server.java', contents: 'class Server { public static void main(String[] args) {} }\n' },
      {
        path: 'fetch-java.js',
        contents: [
          '(async () => {',
          '  const response = await fetch("http://localhost:3220/from-fetch", {',
          '    method: "POST",',
          '    headers: { "content-type": "text/plain" },',
          '    body: "payload",',
          '  });',
          '  console.log(`${response.status}:${response.ok}:${JSON.stringify(await response.json())}`);',
          '})().catch((error) => { console.error(error.message); process.exitCode = 1; });',
          '',
        ].join('\n'),
      },
    ],
    kernel: { scheduler: { maxConcurrentCommands: 4 } },
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true }),
    javaRunner: createBrowserJavaProjectRunner({
      async executeProjectJava(request, _timeoutMs, _onEvent, signal) {
        const handle = request.kernelHttp?.listen({ host: '127.0.0.1', port: 3220 }, async (httpRequest) => ({
          status: httpRequest.method === 'POST' ? 202 : 200,
          headers: { 'content-type': 'application/json', 'x-java-runner': 'browser' },
          body: JSON.stringify({ method: httpRequest.method, path: httpRequest.path, body: httpRequest.body ?? '' }) + '\n',
        }));
        assertCondition(handle !== undefined, 'Java runner should receive TraceKernel HTTP bridge');
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        handle.close();
        return { stdout: '', stderr: '', exitCode: 143 };
      },
    }),
  });

  const terminal = workspace.createTerminalSession();
  const start = await terminal.run('java Server &');
  assertCondition(start.exitCode === 0, `Java background server should start: ${JSON.stringify(start)}`);

  let listeners = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    listeners = await workspace.readFile('/proc/tracekernel/net/listeners');
    if (listeners.includes('\thttp\t127.0.0.1\t3220\t')) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assertCondition(listeners.includes('\thttp\t127.0.0.1\t3220\t'), `Java runner bridge should register HTTP listener: ${listeners}`);

  const response = await workspace.runCommand('curl -s -X POST -d payload http://localhost:3220/java');
  assertCondition(response.exitCode === 0, `Java runner bridge curl should succeed: ${JSON.stringify(response)}`);
  assertCondition(
    response.stdout === '{"method":"POST","path":"/java","body":"payload"}\n',
    `Java runner bridge should dispatch curl requests through TraceKernel: ${response.stdout}`
  );

  const fetchResponse = await workspace.runCommand('node fetch-java.js');
  assertCondition(fetchResponse.exitCode === 0, `fetch should call Java runner bridge: ${JSON.stringify(fetchResponse)}`);
  assertCondition(
    fetchResponse.stdout === '202:true:{"method":"POST","path":"/from-fetch","body":"payload"}\n',
    `fetch should dispatch to Java HTTP listeners through TraceKernel: ${fetchResponse.stdout}`
  );

  const listenerRow = listeners.split('\n').find((line) => line.includes('\thttp\t127.0.0.1\t3220\t'));
  const serverPid = listenerRow?.split('\t')[1];
  assertCondition(serverPid !== undefined, `Java listener row should include owning pid: ${listeners}`);
  const killed = await workspace.runCommand(`kill ${serverPid}`);
  assertCondition(killed.exitCode === 0, `Java bridge process should be killable: ${JSON.stringify(killed)}`);
  await workspace.runCommand(`wait ${serverPid}`);
  workspace.dispose();
}

async function testTraceKernelHttpLanguageBridgeConformance(): Promise<void> {
  const receivedClients: string[] = [];
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'client.js',
        contents: [
          '(async () => {',
          '  const response = await fetch("http://localhost:3230/conformance", {',
          '    method: "POST",',
          '    headers: { "content-type": "text/plain", "x-client": "javascript" },',
          '    body: "js-body",',
          '  });',
          '  console.log(`${response.status}:${await response.text()}`);',
          '})().catch((error) => { console.error(error.message); process.exitCode = 1; });',
          '',
        ].join('\n'),
      },
      { path: 'client.py', contents: 'print("python")\n' },
      { path: 'Client.java', contents: 'class Client { public static void main(String[] args) {} }\n' },
    ],
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true }),
    pythonRunner: async (request) => {
      const response = await request.kernelHttp?.dispatch({
        method: 'POST',
        url: 'http://localhost:3230/conformance',
        path: '/conformance',
        headers: { 'content-type': 'text/plain', 'x-client': 'python' },
        body: 'py-body',
      });
      return {
        stdout: `${response?.status}:${response?.body ?? ''}`,
        stderr: '',
        exitCode: response?.status === 209 ? 0 : 1,
      };
    },
    javaRunner: createBrowserJavaProjectRunner({
      async executeProjectJava(request) {
        const response = await request.kernelHttp?.dispatch({
          method: 'POST',
          url: 'http://localhost:3230/conformance',
          path: '/conformance',
          headers: { 'content-type': 'text/plain', 'x-client': 'java' },
          body: 'java-body',
        });
        return {
          stdout: `${response?.status}:${response?.body ?? ''}`,
          stderr: '',
          exitCode: response?.status === 209 ? 0 : 1,
        };
      },
    }),
  });
  const listener = workspace.http.listen({ host: '127.0.0.1', port: 3230 }, (request) => {
    const client = request.headers?.['x-client'] ?? '';
    receivedClients.push(`${client}:${request.body ?? ''}`);
    return {
      status: 209,
      headers: { 'content-type': 'text/plain' },
      body: `${client}:ok\n`,
    };
  });

  const javascript = await workspace.runCommand('node client.js');
  assertCondition(javascript.exitCode === 0, `JavaScript HTTP conformance client should succeed: ${JSON.stringify(javascript)}`);
  assertCondition(javascript.stdout === '209:javascript:ok\n\n', `JavaScript HTTP conformance response should round-trip: ${javascript.stdout}`);

  const python = await workspace.runCommand('python3 client.py');
  assertCondition(python.exitCode === 0, `Python HTTP conformance client should succeed: ${JSON.stringify(python)}`);
  assertCondition(python.stdout === '209:python:ok\n', `Python HTTP conformance response should round-trip: ${python.stdout}`);

  const java = await workspace.runCommand('java Client');
  assertCondition(java.exitCode === 0, `Java HTTP conformance client should succeed: ${JSON.stringify(java)}`);
  assertCondition(java.stdout === '209:java:ok\n', `Java HTTP conformance response should round-trip: ${java.stdout}`);

  assertCondition(
    receivedClients.join(',') === 'javascript:js-body,python:py-body,java:java-body',
    `TraceKernel HTTP should preserve shared client request shape across languages: ${JSON.stringify(receivedClients)}`
  );
  listener.close();
  workspace.dispose();
}

async function testBrowserJavaScriptProjectRunnerAbortSignal(): Promise<void> {
  let commandStarted!: () => void;
  const commandStartedPromise = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  const controller = new AbortController();
  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'abort-browser.js', contents: 'await new Promise(() => {});\n' }],
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true }),
  });

  const command = workspace.runCommand('node abort-browser.js', {
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === 'status' && event.phase === 'process-start') commandStarted();
    },
  });
  await commandStartedPromise;
  controller.abort();
  const result = await Promise.race([
    command,
    new Promise<RuntimeCommandResult>((resolve) =>
      setTimeout(() => resolve({ stdout: '', stderr: 'browser node did not stop after abort\n', exitCode: 124 }), 1_000)
    ),
  ]);

  assertCondition(
    result.exitCode === 143 &&
      result.error?.code === 'EINTR' &&
      result.error.detail?.signal === 'SIGTERM',
    `browser node runner should convert aborts into kernel signal results: ${JSON.stringify(result)}`
  );
}

async function testBrowserJavaScriptProjectRunnerCwd(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'build/.keep', contents: '' },
      { path: 'src/helper.js', contents: 'exports.value = 37;\n' },
      { path: 'vendor/cwdpkg.js', contents: 'exports.value = 137;\n' },
      {
        path: 'src/index.js',
        contents: [
          'const fs = require("node:fs");',
          'const { value } = require("./helper");',
          'console.log(process.cwd());',
          'console.log(value);',
          'fs.writeFileSync("generated.txt", "created\\n");',
          '',
        ].join('\n'),
      },
    ],
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true }),
  });

  const result = await workspace.runCommand('node index.js', { cwd: 'src' });
  assertCondition(result.exitCode === 0, `browser node cwd should succeed: ${result.stderr}`);
  assertCondition(result.stdout === '/workspace/src\n37\n', `browser node cwd should run from requested directory: ${result.stdout}`);
  assertCondition(await workspace.readFile('src/generated.txt') === 'created\n', 'browser node cwd side effects should be workspace-relative');

  const parentRelativeResult = await workspace.runCommand('node ../src/index.js', { cwd: 'build' });
  assertCondition(parentRelativeResult.exitCode === 0, `browser node should resolve cwd-relative parent script paths: ${parentRelativeResult.stderr}`);
  assertCondition(
    parentRelativeResult.stdout === '/workspace/build\n37\n',
    `browser node should execute cwd-relative parent script paths with desktop cwd semantics: ${parentRelativeResult.stdout}`
  );
  assertCondition(await workspace.readFile('build/generated.txt') === 'created\n', 'browser node cwd-relative script side effects should stay under cwd');

  const cwdRelativeNodePathResult = await workspace.runCommand('node -e "console.log(require(\\"cwdpkg\\").value)"', {
    cwd: 'build',
    env: { NODE_PATH: '../vendor' },
  });
  assertCondition(cwdRelativeNodePathResult.exitCode === 0, `browser node should resolve cwd-relative NODE_PATH entries: ${cwdRelativeNodePathResult.stderr}`);
  assertCondition(cwdRelativeNodePathResult.stdout === '137\n', `browser node should import modules from cwd-relative NODE_PATH entries: ${cwdRelativeNodePathResult.stdout}`);

  const evalResult = await workspace.runCommand('node -e "const { value } = require(\\"./helper\\"); console.log(value)"', { cwd: 'src' });
  assertCondition(evalResult.exitCode === 0, `browser node cwd eval require should succeed: ${evalResult.stderr}`);
  assertCondition(evalResult.stdout === '37\n', `browser node cwd eval require should resolve from cwd: ${evalResult.stdout}`);

}

async function testBrowserJavaScriptProjectRunnerStdin(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'src/helper.js', contents: 'exports.value = 47;\n' },
    ],
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true }),
  });

  const result = await workspace.runCommand(
    [
      'printf',
      "'const fs = require(\"node:fs\");\\nconst { value } = require(\"./helper\");\\nconsole.log(process.cwd());\\nconsole.log(value);\\nfs.writeFileSync(\"generated.txt\", \"created\\\\n\");\\n'",
      '|',
      'node -',
    ].join(' '),
    { cwd: 'src' }
  );
  assertCondition(result.exitCode === 0, `browser node stdin should succeed: ${result.stderr}`);
  assertCondition(result.stdout === '/workspace/src\n47\n', `browser node stdin should execute from requested cwd: ${result.stdout}`);
  assertCondition(await workspace.readFile('src/generated.txt') === 'created\n', 'browser node stdin side effects should be workspace-relative');

  const argvResult = await workspace.runCommand(
    'printf \'console.log(process.argv.slice(1).join(","))\\n\' | node - alpha beta'
  );
  assertCondition(argvResult.exitCode === 0, `browser node stdin argv should succeed: ${argvResult.stderr}`);
  assertCondition(argvResult.stdout === '-,alpha,beta\n', `browser node stdin argv should match desktop semantics: ${argvResult.stdout}`);
}

async function testBrowserJavaScriptProjectRunnerLiveIoEvents(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'stale.txt', contents: 'stale\n' },
      {
        path: 'io.js',
        contents: [
          'const fs = require("node:fs");',
          'console.log("console-out");',
          'console.error("console-err");',
          'process.stdout.write("stream-out\\n");',
          'process.stderr.write("stream-err\\n");',
          'fs.writeFileSync("live.txt", "one\\n");',
          'fs.appendFileSync("live.txt", "two\\n");',
          'const emptyFd = fs.openSync("empty-open.txt", "w");',
          'fs.closeSync(emptyFd);',
          'fs.renameSync("live.txt", "moved.txt");',
          'fs.writeFileSync("/dev/stdout", "device-out\\n");',
          'fs.writeFileSync("/dev/stderr", "device-err\\n");',
          'fs.unlinkSync("stale.txt");',
          '',
        ].join('\n'),
      },
    ],
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true }),
  });
  const watchEvents: RuntimeWorkspaceEvent[] = [];
  const commandEvents: RuntimeCommandEvent[] = [];
  workspace.watch((event) => watchEvents.push(event));

  const result = await workspace.runCommand('node io.js', {
    onEvent: (event) => commandEvents.push(event),
  });

  assertCondition(result.exitCode === 0, `browser node live I/O command should succeed: ${result.stderr}`);
  assertCondition(
    result.stdout === 'console-out\nstream-out\ndevice-out\n',
    `browser node should preserve streamed stdout in command result: ${result.stdout}`
  );
  assertCondition(
    result.stderr === 'console-err\nstream-err\ndevice-err\n',
    `browser node should preserve streamed stderr in command result: ${result.stderr}`
  );
  assertCondition(await workspace.readFile('moved.txt') === 'one\ntwo\n', 'browser node final diff should persist moved file');
  assertCondition(await workspace.readFile('empty-open.txt') === '', 'browser node final diff should persist zero-byte open creates');
  await assertRejectsAsync(() => workspace.readFile('stale.txt'), 'browser node final diff should persist removed file');
  assertCondition(
    commandEvents.some((event) =>
      event.type === 'output' &&
      event.stream === 'stdout' &&
      event.device === '/dev/stdout' &&
      event.actor?.kind === 'runtime' &&
      event.data === 'stream-out\n'
    ),
    `browser node onEvent should receive process.stdout chunks: ${JSON.stringify(commandEvents)}`
  );
  assertCondition(
    commandEvents.some((event) =>
      event.type === 'output' &&
      event.stream === 'stderr' &&
      event.device === '/dev/stderr' &&
      event.actor?.kind === 'runtime' &&
      event.data === 'device-err\n'
    ),
    `browser node onEvent should receive /dev/stderr writes: ${JSON.stringify(commandEvents)}`
  );
  assertCondition(
    watchEvents.some((event) =>
      event.type === 'file-change' &&
      event.actor?.kind === 'runtime' &&
      event.phase === 'live' &&
      event.change.path === 'live.txt' &&
      !('deleted' in event.change) &&
      looseChange(event.change).contents === 'one\ntwo\n'
    ),
    `workspace watch should receive browser node live append events: ${JSON.stringify(watchEvents)}`
  );
  assertCondition(
    commandEvents.some((event) =>
      event.type === 'file-change' &&
      event.actor?.kind === 'runtime' &&
      event.phase === 'live' &&
      event.change.path === 'empty-open.txt' &&
      !('deleted' in event.change) &&
      looseChange(event.change).contents === ''
    ),
    `browser node onEvent should receive live zero-byte open creates: ${JSON.stringify(commandEvents)}`
  );
  assertCondition(
    commandEvents.some((event) =>
      event.type === 'file-change' &&
      event.actor?.kind === 'runtime' &&
      event.phase === 'live' &&
      event.change.path === 'live.txt' &&
      'deleted' in event.change
    ),
    `browser node onEvent should receive live rename delete events: ${JSON.stringify(commandEvents)}`
  );
  assertCondition(
    commandEvents.some((event) =>
      event.type === 'file-change' &&
      event.actor?.kind === 'runtime' &&
      event.phase === 'live' &&
      event.change.path === 'moved.txt' &&
      !('deleted' in event.change) &&
      looseChange(event.change).contents === 'one\ntwo\n'
    ),
    `browser node onEvent should receive live rename write events: ${JSON.stringify(commandEvents)}`
  );
  workspace.dispose();
}

async function testNativeJavaScriptProjectRunnerModuleGlobals(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'src/helper.js',
        contents: [
          'console.log(module.filename.endsWith("/src/helper.js"));',
          'console.log(module.parent && module.parent.filename.endsWith("/src/index.js"));',
          'console.log(module.loaded);',
          'exports.value = 7;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.js',
        contents: [
          'const helper = require(__dirname + "/helper");',
          'console.log(__filename.endsWith("/src/index.js"));',
          'console.log(__dirname.endsWith("/src"));',
          'console.log(helper.value);',
          'console.log(module.filename.endsWith("/src/index.js"));',
          'console.log(module.loaded);',
          'console.log(module.parent === null);',
          'console.log(require.main === module);',
          'console.log(module.children[0].filename.endsWith("/src/helper.js"));',
          'console.log(module.id);',
          'console.log(require.cache[__filename] === module);',
          'console.log(require.cache[require.resolve("./helper")] === module.children[0]);',
          'console.log(module.require("./helper") === helper);',
          'delete require.cache[require.resolve("./helper")];',
          'console.log(module.require("./helper") !== helper);',
          '',
        ].join('\n'),
      },
    ],
    nodeRunner: createNativeJavaScriptProjectRunner(),
  });

  const result = await workspace.runCommand('node src/index.js');
  assertCondition(result.exitCode === 0, `native node module globals should succeed: ${result.stderr}`);
  assertCondition(
    result.stdout === 'true\ntrue\nfalse\ntrue\ntrue\n7\ntrue\nfalse\ntrue\ntrue\ntrue\n.\ntrue\ntrue\ntrue\ntrue\ntrue\nfalse\ntrue\n',
    `native node module globals should match desktop behavior: ${result.stdout}`
  );
}

async function testBrowserJavaScriptProjectRunnerModuleGlobals(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'src/helper.js',
        contents: [
          'console.log(module.filename.endsWith("/src/helper.js"));',
          'console.log(module.parent && module.parent.filename.endsWith("/src/index.js"));',
          'console.log(module.loaded);',
          'exports.value = 7;',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.js',
        contents: [
          'const helper = require(__dirname + "/helper");',
          'console.log(__filename.endsWith("/src/index.js"));',
          'console.log(__dirname.endsWith("/src"));',
          'console.log(helper.value);',
          'console.log(module.filename.endsWith("/src/index.js"));',
          'console.log(module.loaded);',
          'console.log(module.parent === null);',
          'console.log(require.main === module);',
          'console.log(module.children[0].filename.endsWith("/src/helper.js"));',
          'console.log(module.id);',
          'console.log(require.cache[__filename] === module);',
          'console.log(require.cache[require.resolve("./helper")] === module.children[0]);',
          'console.log(module.require("./helper") === helper);',
          'delete require.cache[require.resolve("./helper")];',
          'console.log(module.require("./helper") !== helper);',
          '',
        ].join('\n'),
      },
    ],
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true }),
  });

  const result = await workspace.runCommand('node src/index.js');
  assertCondition(result.exitCode === 0, `browser node module globals should succeed: ${result.stderr}`);
  assertCondition(
    result.stdout === 'true\ntrue\nfalse\ntrue\ntrue\n7\ntrue\nfalse\ntrue\ntrue\ntrue\n.\ntrue\ntrue\ntrue\ntrue\ntrue\nfalse\ntrue\n',
    `browser node module globals should match desktop behavior: ${result.stdout}`
  );
}

async function testNativeJavaScriptProjectRunnerEsmImports(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'src/helper.mjs', contents: 'export function add(a, b) { return a + b; }\nexport const offset = 4;\n' },
      { path: 'src/label.mjs', contents: 'export default "esm";\n' },
      { path: 'src/legacy.cjs', contents: 'module.exports = { bonus: 6 };\n' },
      {
        path: 'src/barrel.mjs',
        contents: [
          'export { add as sum } from "./helper.mjs";',
          'export * from "./extra.mjs";',
          'export class Counter { constructor(value) { this.value = value; } }',
          '',
        ].join('\n'),
      },
      { path: 'src/extra.mjs', contents: 'export const multiplier = 2;\nexport default "ignored";\n' },
      {
        path: 'src/index.mjs',
        contents: [
          'import label from "./label.mjs";',
          'import legacy from "./legacy.cjs";',
          'import { add, offset as baseOffset } from "./helper.mjs";',
          'import { sum, multiplier, Counter } from "./barrel.mjs";',
          'const dynamic = await import("./extra.mjs");',
          'console.log(label);',
          'console.log(import.meta.url.startsWith("file:") && import.meta.url.endsWith("/src/index.mjs"));',
          'console.log(new URL("./helper.mjs", import.meta.url).pathname.endsWith("/src/helper.mjs"));',
          'console.log(add(2, 3) + baseOffset + legacy.bonus + sum(1, 2) + multiplier + dynamic.multiplier + new Counter(1).value);',
          'console.log(process.argv.slice(2).join(","));',
          '',
        ].join('\n'),
      },
    ],
    nodeRunner: createNativeJavaScriptProjectRunner(),
  });

  const result = await workspace.runCommand('node src/index.mjs alpha beta');
  assertCondition(result.exitCode === 0, `native node ESM imports should succeed: ${result.stderr}`);
  assertCondition(result.stdout === 'esm\ntrue\ntrue\n23\nalpha,beta\n', `native node ESM imports should execute project files: ${result.stdout}`);
}

async function testBrowserJavaScriptProjectRunnerEsmImports(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'src/helper.mjs', contents: 'export function add(a, b) { return a + b; }\nexport const offset = 4;\n' },
      { path: 'src/label.mjs', contents: 'export default "esm";\n' },
      { path: 'src/legacy.cjs', contents: 'module.exports = { bonus: 6 };\n' },
      {
        path: 'src/barrel.mjs',
        contents: [
          'export { add as sum } from "./helper.mjs";',
          'export * from "./extra.mjs";',
          'export class Counter { constructor(value) { this.value = value; } }',
          '',
        ].join('\n'),
      },
      { path: 'src/extra.mjs', contents: 'export const multiplier = 2;\nexport default "ignored";\n' },
      {
        path: 'src/index.mjs',
        contents: [
          'import label from "./label.mjs";',
          'import legacy from "./legacy.cjs";',
          'import { add, offset as baseOffset } from "./helper.mjs";',
          'import { sum, multiplier, Counter } from "./barrel.mjs";',
          'const dynamic = await import("./extra.mjs");',
          'console.log(label);',
          'console.log(import.meta.url === "file:///workspace/src/index.mjs");',
          'console.log(new URL("./helper.mjs", import.meta.url).pathname === "/workspace/src/helper.mjs");',
          'console.log(add(2, 3) + baseOffset + legacy.bonus + sum(1, 2) + multiplier + dynamic.multiplier + new Counter(1).value);',
          'console.log(process.argv.slice(2).join(","));',
          '',
        ].join('\n'),
      },
    ],
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true }),
  });

  const result = await workspace.runCommand('node src/index.mjs alpha beta');
  assertCondition(result.exitCode === 0, `browser node ESM imports should succeed: ${result.stderr}`);
  assertCondition(result.stdout === 'esm\ntrue\ntrue\n23\nalpha,beta\n', `browser node ESM imports should execute project files: ${result.stdout}`);
}

async function testNativeJavaScriptProjectRunnerDuplicateBasenameImports(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'src/a/helper.js', contents: 'exports.value = "a-cjs";\n' },
      {
        path: 'src/a/index.js',
        contents: [
          'const fs = require("node:fs");',
          'const { value } = require("./helper");',
          'fs.writeFileSync("a-generated.txt", value + "\\n");',
          'console.log(value);',
          '',
        ].join('\n'),
      },
      { path: 'src/b/helper.js', contents: 'exports.value = "b-cjs";\n' },
      {
        path: 'src/b/index.js',
        contents: [
          'const fs = require("node:fs");',
          'const { value } = require("./helper");',
          'fs.writeFileSync("b-generated.txt", value + "\\n");',
          'console.log(value);',
          '',
        ].join('\n'),
      },
      { path: 'src/a/helper.mjs', contents: 'export const value = "a-esm";\n' },
      {
        path: 'src/a/index.mjs',
        contents: [
          'import { writeFileSync } from "node:fs";',
          'import { value } from "./helper.mjs";',
          'writeFileSync("a-esm-generated.txt", value + "\\n");',
          'console.log(value);',
          '',
        ].join('\n'),
      },
      { path: 'src/b/helper.mjs', contents: 'export const value = "b-esm";\n' },
      {
        path: 'src/b/index.mjs',
        contents: [
          'import { writeFileSync } from "node:fs";',
          'import { value } from "./helper.mjs";',
          'writeFileSync("b-esm-generated.txt", value + "\\n");',
          'console.log(value);',
          '',
        ].join('\n'),
      },
    ],
    nodeRunner: createNativeJavaScriptProjectRunner(),
  });

  const cjsA = await workspace.runCommand('node index.js', { cwd: 'src/a' });
  const cjsB = await workspace.runCommand('node index.js', { cwd: 'src/b' });
  const esmA = await workspace.runCommand('node index.mjs', { cwd: 'src/a' });
  const esmB = await workspace.runCommand('node index.mjs', { cwd: 'src/b' });

  assertCondition(cjsA.exitCode === 0, `native node duplicate CJS A should succeed: ${cjsA.stderr}`);
  assertCondition(cjsB.exitCode === 0, `native node duplicate CJS B should succeed: ${cjsB.stderr}`);
  assertCondition(esmA.exitCode === 0, `native node duplicate ESM A should succeed: ${esmA.stderr}`);
  assertCondition(esmB.exitCode === 0, `native node duplicate ESM B should succeed: ${esmB.stderr}`);
  assertCondition(cjsA.stdout === 'a-cjs\n' && cjsB.stdout === 'b-cjs\n', `native node duplicate CJS imports should stay directory-local: ${cjsA.stdout}${cjsB.stdout}`);
  assertCondition(esmA.stdout === 'a-esm\n' && esmB.stdout === 'b-esm\n', `native node duplicate ESM imports should stay directory-local: ${esmA.stdout}${esmB.stdout}`);
  assertCondition(await workspace.readFile('src/a/a-generated.txt') === 'a-cjs\n', 'native node CJS generated file should stay under cwd A');
  assertCondition(await workspace.readFile('src/b/b-generated.txt') === 'b-cjs\n', 'native node CJS generated file should stay under cwd B');
  assertCondition(await workspace.readFile('src/a/a-esm-generated.txt') === 'a-esm\n', 'native node ESM generated file should stay under cwd A');
  assertCondition(await workspace.readFile('src/b/b-esm-generated.txt') === 'b-esm\n', 'native node ESM generated file should stay under cwd B');
}

async function testBrowserJavaScriptProjectRunnerDuplicateBasenameImports(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'src/a/helper.js', contents: 'exports.value = "a-cjs";\n' },
      {
        path: 'src/a/index.js',
        contents: [
          'const fs = require("node:fs");',
          'const { value } = require("./helper");',
          'fs.writeFileSync("a-generated.txt", value + "\\n");',
          'console.log(value);',
          '',
        ].join('\n'),
      },
      { path: 'src/b/helper.js', contents: 'exports.value = "b-cjs";\n' },
      {
        path: 'src/b/index.js',
        contents: [
          'const fs = require("node:fs");',
          'const { value } = require("./helper");',
          'fs.writeFileSync("b-generated.txt", value + "\\n");',
          'console.log(value);',
          '',
        ].join('\n'),
      },
      { path: 'src/a/helper.mjs', contents: 'export const value = "a-esm";\n' },
      {
        path: 'src/a/index.mjs',
        contents: [
          'import { writeFileSync } from "node:fs";',
          'import { value } from "./helper.mjs";',
          'writeFileSync("a-esm-generated.txt", value + "\\n");',
          'console.log(value);',
          '',
        ].join('\n'),
      },
      { path: 'src/b/helper.mjs', contents: 'export const value = "b-esm";\n' },
      {
        path: 'src/b/index.mjs',
        contents: [
          'import { writeFileSync } from "node:fs";',
          'import { value } from "./helper.mjs";',
          'writeFileSync("b-esm-generated.txt", value + "\\n");',
          'console.log(value);',
          '',
        ].join('\n'),
      },
    ],
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true }),
  });

  const cjsA = await workspace.runCommand('node index.js', { cwd: 'src/a' });
  const cjsB = await workspace.runCommand('node index.js', { cwd: 'src/b' });
  const esmA = await workspace.runCommand('node index.mjs', { cwd: 'src/a' });
  const esmB = await workspace.runCommand('node index.mjs', { cwd: 'src/b' });

  assertCondition(cjsA.exitCode === 0, `browser node duplicate CJS A should succeed: ${cjsA.stderr}`);
  assertCondition(cjsB.exitCode === 0, `browser node duplicate CJS B should succeed: ${cjsB.stderr}`);
  assertCondition(esmA.exitCode === 0, `browser node duplicate ESM A should succeed: ${esmA.stderr}`);
  assertCondition(esmB.exitCode === 0, `browser node duplicate ESM B should succeed: ${esmB.stderr}`);
  assertCondition(cjsA.stdout === 'a-cjs\n' && cjsB.stdout === 'b-cjs\n', `browser node duplicate CJS imports should stay directory-local: ${cjsA.stdout}${cjsB.stdout}`);
  assertCondition(esmA.stdout === 'a-esm\n' && esmB.stdout === 'b-esm\n', `browser node duplicate ESM imports should stay directory-local: ${esmA.stdout}${esmB.stdout}`);
  assertCondition(await workspace.readFile('src/a/a-generated.txt') === 'a-cjs\n', 'browser node CJS generated file should stay under cwd A');
  assertCondition(await workspace.readFile('src/b/b-generated.txt') === 'b-cjs\n', 'browser node CJS generated file should stay under cwd B');
  assertCondition(await workspace.readFile('src/a/a-esm-generated.txt') === 'a-esm\n', 'browser node ESM generated file should stay under cwd A');
  assertCondition(await workspace.readFile('src/b/b-esm-generated.txt') === 'b-esm\n', 'browser node ESM generated file should stay under cwd B');
}

async function testNativeJavaProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'Helper.java', contents: 'class Helper { static int add(int a, int b) { return a + b; } }\n' },
      { path: 'stale.txt', contents: 'delete me\n' },
      {
        path: 'Main.java',
        contents: [
          'class Main {',
          '  public static void main(String[] args) {',
          '    System.out.println(Helper.add(2, 3));',
          '    System.out.println(String.join(",", args));',
          '    try {',
          '      java.nio.file.Files.writeString(java.nio.file.Path.of("generated.txt"), "created\\n");',
          '      java.nio.file.Files.write(java.nio.file.Path.of("bytes.bin"), new byte[] {0, (byte) 255});',
          '      java.nio.file.Files.deleteIfExists(java.nio.file.Path.of("stale.txt"));',
          '    } catch (java.io.IOException error) {',
          '      throw new RuntimeException(error);',
          '    }',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ],
    javaRunner: createNativeJavaProjectRunner(),
  });

  const compile = await workspace.runCommand('javac Main.java');
  assertCondition(compile.exitCode === 0, `native javac should compile transitive project sources: ${compile.stderr}`);
  assertCondition((await workspace.readFile('Helper.class', 'base64')).length > 0, 'native javac should compile referenced helper sources');

  const run = await workspace.runCommand('java Main alpha beta');
  assertCondition(run.exitCode === 0, `native java should succeed: ${run.stderr}`);
  assertCondition(run.stdout === '5\nalpha,beta\n', `native java should execute project files: ${run.stdout}`);
  assertCondition(await workspace.readFile('generated.txt') === 'created\n', 'native java should persist generated text files');
  assertCondition(
    (await workspace.readFile('bytes.bin', 'base64')) === Buffer.from([0, 255]).toString('base64'),
    'native java should persist generated binary files'
  );
  await assertRejectsAsync(() => workspace.readFile('stale.txt'), 'native java should persist deleted files');

  const classpathRun = await workspace.runCommand('java -cp . Main alpha beta');
  assertCondition(classpathRun.exitCode === 0, `native java -cp should succeed: ${classpathRun.stderr}`);
  assertCondition(classpathRun.stdout === '5\nalpha,beta\n', `native java -cp should execute project files: ${classpathRun.stdout}`);

  const timeoutEvents: RuntimeCommandEvent[] = [];
  const timeoutRoot = await mkdtemp(join(tmpdir(), 'tracecode-java-timeout-command-'));
  try {
    const timeoutCommand = join(timeoutRoot, 'javac-timeout');
    await writeFile(timeoutCommand, '#!/bin/sh\nsleep 1\n', 'utf8');
    await chmod(timeoutCommand, 0o755);
    const timeoutRunner = createNativeJavaProjectRunner({ javacCommand: timeoutCommand, timeoutMs: 5 });
    const timeoutResult = await timeoutRunner({
      code: '',
      source: 'compile',
      scriptPath: 'Main.java',
      args: ['Main.java'],
      cwd: '/workspace',
      env: {},
      project: {
        files: [{ path: 'Main.java', contents: 'class Main { public static void main(String[] args) {} }\n' }],
      },
      onEvent: (event) => timeoutEvents.push(event),
    });
    assertCondition(
      timeoutResult.exitCode === 124 && timeoutResult.stderr.includes('javac: execution timed out after 5ms'),
      `native java timeout should return a timeout result: ${JSON.stringify(timeoutResult)}`
    );
    const javaTimeoutStderrIndex = timeoutEvents.findIndex(
      (event) => event.type === 'output' && event.stream === 'stderr' && event.data.includes('javac: execution timed out after 5ms')
    );
    const javaTimeoutExitIndex = timeoutEvents.findIndex(
      (event) => event.type === 'status' && event.phase === 'process-exit' && event.detail?.exitCode === 124
    );
    assertCondition(
      javaTimeoutStderrIndex >= 0 && javaTimeoutExitIndex > javaTimeoutStderrIndex,
      `native java timeout should stream timeout stderr before process-exit: ${JSON.stringify(timeoutEvents)}`
    );
  } finally {
    await rm(timeoutRoot, { recursive: true, force: true });
  }

  const startErrorEvents: RuntimeCommandEvent[] = [];
  const startErrorRunner = createNativeJavaProjectRunner({ javacCommand: 'tracecode-missing-javac-command' });
  const startErrorResult = await startErrorRunner({
    code: '',
    source: 'compile',
    scriptPath: 'Main.java',
    args: ['Main.java'],
    cwd: '/workspace',
    env: {},
    project: {
      files: [{ path: 'Main.java', contents: 'class Main { public static void main(String[] args) {} }\n' }],
    },
    onEvent: (event) => startErrorEvents.push(event),
  });
  assertCondition(startErrorResult.exitCode === 1, `native javac start error should return failure: ${JSON.stringify(startErrorResult)}`);
  const javaStartErrorStderrIndex = startErrorEvents.findIndex(
    (event) => event.type === 'output' && event.stream === 'stderr' && event.data.includes('tracecode-missing-javac-command')
  );
  const javaStartErrorStatusIndex = startErrorEvents.findIndex(
    (event) => event.type === 'status' && event.phase === 'process-error' && event.detail?.command === 'tracecode-missing-javac-command'
  );
  assertCondition(
    javaStartErrorStderrIndex >= 0 && javaStartErrorStatusIndex > javaStartErrorStderrIndex,
    `native javac start error should stream stderr before process-error: ${JSON.stringify(startErrorEvents)}`
  );
}

async function testNativeJavaAssertionProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'AssertMain.java',
        contents: [
          'class AssertMain {',
          '  public static void main(String[] args) {',
          '    boolean enabled = false;',
          '    assert enabled = true;',
          '    System.out.println(enabled);',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ],
    javaRunner: createNativeJavaProjectRunner(),
  });

  const disabled = await workspace.runCommand('java AssertMain');
  assertCondition(disabled.exitCode === 0, `native java assertion disabled run should succeed: ${disabled.stderr}`);
  assertCondition(disabled.stdout === 'false\n', `native java assertions should be disabled by default: ${disabled.stdout}`);

  const enabled = await workspace.runCommand('java -ea AssertMain');
  assertCondition(enabled.exitCode === 0, `native java -ea run should succeed: ${enabled.stderr}`);
  assertCondition(enabled.stdout === 'true\n', `native java -ea should enable assertions: ${enabled.stdout}`);
}

async function testNativeJavaSystemPropertiesProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'PropMain.java',
        contents: [
          'class PropMain {',
          '  public static void main(String[] args) {',
          '    System.out.println(System.getProperty("trace.mode", "missing"));',
          '    System.out.println(System.getProperty("empty.value", "missing"));',
          '    System.out.println(String.join(",", args));',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ],
    javaRunner: createNativeJavaProjectRunner(),
  });

  const run = await workspace.runCommand('java -Dtrace.mode=native -Dempty.value PropMain alpha beta');
  assertCondition(run.exitCode === 0, `native java -D system properties should succeed: ${run.stderr}`);
  assertCondition(
    run.stdout === 'native\n\nalpha,beta\n',
    `native java -D system properties should reach user code before args: ${run.stdout}`
  );
}

async function testNativeJavaJarProjectRunner(): Promise<void> {
  const appJar = await createRunnableJavaJarBase64();
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'dist/app.jar', contents: appJar, encoding: 'base64' },
    ],
    javaRunner: createNativeJavaProjectRunner(),
  });

  const run = await workspace.runCommand('java -Dtrace.mode=jar -jar dist/app.jar alpha beta');
  assertCondition(run.exitCode === 0, `native java -jar should run workspace jars: ${run.stderr}`);
  assertCondition(run.stdout === 'jar\nalpha,beta\n', `native java -jar should preserve -D and args: ${run.stdout}`);
}

async function testNativePackagedJavaProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'build/.keep', contents: '' },
      { path: 'src/app/Helper.java', contents: 'package app;\nclass Helper { static int add(int a, int b) { return a + b; } }\n' },
      {
        path: 'src/app/Main.java',
        contents: [
          'package app;',
          'public class Main {',
          '  public static void main(String[] args) {',
          '    System.out.println(Helper.add(2, 3));',
          '    System.out.println(String.join(",", args));',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ],
    javaRunner: createNativeJavaProjectRunner(),
  });

  const run = await workspace.runCommand('java app.Main alpha beta');
  assertCondition(run.exitCode === 0, `native packaged java should succeed: ${run.stderr}`);
  assertCondition(run.stdout === '5\nalpha,beta\n', `native packaged java should execute project files: ${run.stdout}`);

  const explicitCompile = await workspace.runCommand('javac -d out src/app/Main.java src/app/Helper.java');
  assertCondition(explicitCompile.exitCode === 0, `native packaged javac -d should succeed: ${explicitCompile.stderr}`);

  const compiledFiles = await workspace.runCommand('find out -type f | sort');
  assertCondition(compiledFiles.exitCode === 0, `native packaged javac output listing should succeed: ${compiledFiles.stderr}`);
  assertCondition(
    compiledFiles.stdout === 'out/app/Helper.class\nout/app/Main.class\n',
    `native packaged javac should persist class files in workspace: ${compiledFiles.stdout}`
  );

  const cwdRelativeCompile = await workspace.runCommand('javac -d ../rel-out ../src/app/Main.java ../src/app/Helper.java', {
    cwd: 'build',
  });
  assertCondition(cwdRelativeCompile.exitCode === 0, `native packaged javac should resolve cwd-relative parent paths: ${cwdRelativeCompile.stderr}`);
  const cwdRelativeRun = await workspace.runCommand('java -cp ../rel-out app.Main cwd relative', {
    cwd: 'build',
  });
  assertCondition(cwdRelativeRun.exitCode === 0, `native packaged java should run cwd-relative classpath output: ${cwdRelativeRun.stderr}`);
  assertCondition(
    cwdRelativeRun.stdout === '5\ncwd,relative\n',
    `native packaged java should preserve cwd-relative classpath semantics: ${cwdRelativeRun.stdout}`
  );

  await workspace.writeFile('src/app/Helper.java', 'package app;\nclass Helper { static int add(int a, int b) { return 99; } }\n');

  const explicitClasspathRun = await workspace.runCommand('java --class-path out app.Main alpha beta');
  assertCondition(explicitClasspathRun.exitCode === 0, `native packaged java --class-path should succeed: ${explicitClasspathRun.stderr}`);
  assertCondition(
    explicitClasspathRun.stdout === '5\nalpha,beta\n',
    `native packaged java --class-path should run persisted class files without recompiling sources: ${explicitClasspathRun.stdout}`
  );

  const envClasspathRun = await workspace.runCommand('java app.Main gamma delta', {
    env: { CLASSPATH: '/workspace/out' },
  });
  assertCondition(envClasspathRun.exitCode === 0, `native packaged java should honor CLASSPATH workspace paths: ${envClasspathRun.stderr}`);
  assertCondition(
    envClasspathRun.stdout === '5\ngamma,delta\n',
    `native packaged java should run persisted class files from CLASSPATH without recompiling sources: ${envClasspathRun.stdout}`
  );
}

async function testNativeJavaJarClasspathProjectRunner(): Promise<void> {
  const externalJar = await createExternalJavaJarBase64();
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'build/.keep', contents: '' },
      { path: 'lib/external.jar', contents: externalJar, encoding: 'base64' },
      { path: 'javac.args', contents: '-cp lib/external.jar\n-d out\nsrc/app/Main.java\n' },
      { path: 'java.args', contents: '-cp out:lib/external.jar\napp.Main\nfrom-runtime-argfile\n' },
      {
        path: 'src/app/Main.java',
        contents: [
          'package app;',
          'import lib.External;',
          'public class Main {',
          '  public static void main(String[] args) {',
          '    System.out.println(External.value());',
          '    System.out.println(String.join(",", args));',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ],
    javaRunner: createNativeJavaProjectRunner(),
  });

  const compile = await workspace.runCommand('javac @javac.args');
  assertCondition(compile.exitCode === 0, `native javac should compile against workspace jar argfile: ${compile.stderr}`);

  const run = await workspace.runCommand('java -cp out:lib/external.jar app.Main alpha beta');
  assertCondition(run.exitCode === 0, `native java should run against workspace jar: ${run.stderr}`);
  assertCondition(run.stdout === '42\nalpha,beta\n', `native java should link persisted jar classpath entries: ${run.stdout}`);

  const cwdRelativeCompile = await workspace.runCommand('javac -cp ../lib/external.jar -d ../rel-out ../src/app/Main.java', {
    cwd: 'build',
  });
  assertCondition(cwdRelativeCompile.exitCode === 0, `native javac should resolve cwd-relative classpath and sources: ${cwdRelativeCompile.stderr}`);
  const cwdRelativeRun = await workspace.runCommand('java -cp ../rel-out:../lib/external.jar app.Main from-cwd', {
    cwd: 'build',
  });
  assertCondition(cwdRelativeRun.exitCode === 0, `native java should resolve cwd-relative jar classpath entries: ${cwdRelativeRun.stderr}`);
  assertCondition(cwdRelativeRun.stdout === '42\nfrom-cwd\n', `native java should link cwd-relative jar classpath entries: ${cwdRelativeRun.stdout}`);

  const argfileRun = await workspace.runCommand('java @java.args');
  assertCondition(argfileRun.exitCode === 0, `native java should expand runtime argfiles: ${argfileRun.stderr}`);
  assertCondition(argfileRun.stdout === '42\nfrom-runtime-argfile\n', `native java should run expanded runtime argfiles: ${argfileRun.stdout}`);

  await workspace.writeFile('src/app/Main.java', [
    'package app;',
    'import lib.External;',
    'public class Main {',
    '  public static void main(String[] args) {',
    '    System.out.println(External.value());',
    '  }',
    '}',
    '',
  ].join('\n'));
  const envCompile = await workspace.runCommand('javac -d env-out src/app/Main.java', {
    env: { CLASSPATH: '/workspace/lib/external.jar' },
  });
  assertCondition(envCompile.exitCode === 0, `native javac should honor CLASSPATH workspace jars: ${envCompile.stderr}`);
  const envRun = await workspace.runCommand('java app.Main', {
    env: { CLASSPATH: '/workspace/env-out:/workspace/lib/external.jar' },
  });
  assertCondition(envRun.exitCode === 0, `native java should honor CLASSPATH workspace jars: ${envRun.stderr}`);
  assertCondition(envRun.stdout === '42\n', `native java should link env CLASSPATH jar entries: ${envRun.stdout}`);
}

async function testNativeJavaArgfileWorkspacePathsProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'javac.args',
        contents: [
          '-d /workspace/out',
          '-sourcepath /workspace/src',
          '/workspace/src/app/Main.java',
          '',
        ].join('\n'),
      },
      {
        path: 'src/app/Main.java',
        contents: [
          'package app;',
          'public class Main {',
          '  public static void main(String[] args) {',
          '    System.out.println(Helper.value());',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/app/Helper.java',
        contents: 'package app;\nclass Helper { static String value() { return "sourcepath-helper"; } }\n',
      },
    ],
    javaRunner: createNativeJavaProjectRunner(),
  });

  const compile = await workspace.runCommand('javac @javac.args');
  assertCondition(compile.exitCode === 0, `native javac should map /workspace paths inside argfiles: ${compile.stderr}`);
  const helperClass = await workspace.readFile('out/app/Helper.class', 'base64');
  assertCondition(helperClass.length > 0, 'native javac should discover transitive sourcepath classes from argfiles');

  const run = await workspace.runCommand('java --class-path /workspace/out app.Main');
  assertCondition(run.exitCode === 0, `native java should run classpath built from argfile /workspace paths: ${run.stderr}`);
  assertCondition(run.stdout === 'sourcepath-helper\n', `native java should link transitive sourcepath output: ${run.stdout}`);
}

async function testNativeJavaDuplicateBasenameProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'src/a/Main.java', contents: 'package a;\npublic class Main { public static int value() { return 5; } }\n' },
      { path: 'src/b/Main.java', contents: 'package b;\npublic class Main { public static void main(String[] args) { System.out.println(a.Main.value()); } }\n' },
    ],
    javaRunner: createNativeJavaProjectRunner(),
  });

  const run = await workspace.runCommand('java b.Main');
  assertCondition(run.exitCode === 0, `native duplicate-basename java should succeed: ${run.stderr}`);
  assertCondition(run.stdout === '5\n', `native duplicate-basename java should execute project files: ${run.stdout}`);
}

async function testNativeJavaProjectRunnerStdin(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'InputMain.java',
        contents: [
          'public class InputMain {',
          '  public static void main(String[] args) throws Exception {',
          '    java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(System.in));',
          '    System.out.println("stdin=" + reader.readLine());',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ],
    javaRunner: createNativeJavaProjectRunner(),
  });

  const run = await workspace.runCommand('java InputMain', { stdinPipe: stdinPipe('from-native\n') });
  assertCondition(run.exitCode === 0, `native java stdin should succeed: ${run.stderr}`);
  assertCondition(run.stdout === 'stdin=from-native\n', `native java stdin should be passed to the process: ${run.stdout}`);
}

async function testNativeJavaProjectRunnerCwd(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'src/Main.java',
        contents: [
          'public class Main {',
          '  public static void main(String[] args) throws Exception {',
          '    System.out.println(System.getProperty("user.dir").endsWith("/src"));',
          '    java.nio.file.Files.writeString(java.nio.file.Path.of("generated.txt"), "created\\n");',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ],
    javaRunner: createNativeJavaProjectRunner(),
  });

  const run = await workspace.runCommand('java Main', { cwd: 'src' });
  assertCondition(run.exitCode === 0, `native java cwd should succeed: ${run.stderr}`);
  assertCondition(run.stdout === 'true\n', `native java cwd should run from requested directory: ${run.stdout}`);
  assertCondition(await workspace.readFile('src/generated.txt') === 'created\n', 'native java cwd side effects should be workspace-relative');
}

async function testNativeJavaProjectRunnerAbsoluteWorkspaceCommandPaths(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'src/abs/Main.java',
        contents: [
          'package abs;',
          'public class Main {',
          '  public static void main(String[] args) {',
          '    System.out.println("absolute-java");',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
    ],
    javaRunner: createNativeJavaProjectRunner(),
  });

  const compile = await workspace.runCommand('javac -d /workspace/out /workspace/src/abs/Main.java');
  assertCondition(compile.exitCode === 0, `native javac should map absolute /workspace args: ${compile.stderr}`);
  const classFile = await workspace.readFile('out/abs/Main.class', 'base64');
  assertCondition(classFile.length > 0, 'native javac should persist classes from absolute /workspace output args');

  await workspace.writeFile('src/abs/Main.java', 'package abs;\npublic class Main { public static void main(String[] args) { System.out.println("changed"); } }\n');
  const run = await workspace.runCommand('java --class-path /workspace/out abs.Main');
  assertCondition(run.exitCode === 0, `native java should map absolute /workspace classpath: ${run.stderr}`);
  assertCondition(run.stdout === 'absolute-java\n', `native java should run persisted absolute classpath output: ${run.stdout}`);
}

async function testNativeJavaProjectRunnerDirectCwdBoundary(): Promise<void> {
  const runner = createNativeJavaProjectRunner();
  const request: JavaProjectCommandRequest = {
    code: '',
    source: 'compile',
    scriptPath: 'Main.java',
    args: ['Main.java'],
    cwd: '/outside',
    env: {},
    project: {
      cwd: '/workspace',
      files: [
        { path: 'Main.java', contents: 'public class Main { public static void main(String[] args) {} }\n' },
      ],
    },
  };

  await assertRejectsAsync(
    () => runner(request),
    'native java direct runner should reject cwd outside the workspace'
  );
}

async function testNativeJavaProjectRunnerDirectAbsoluteOperandBoundaries(): Promise<void> {
  const runner = createNativeJavaProjectRunner();
  const baseRequest: JavaProjectCommandRequest = {
    code: '',
    source: 'compile',
    scriptPath: 'Main.java',
    args: ['Main.java'],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      files: [
        { path: 'Main.java', contents: 'public class Main { public static void main(String[] args) {} }\n' },
      ],
    },
  };

  await assertRejectsAsync(
    () => runner({ ...baseRequest, args: ['-d', '/outside/out', 'Main.java'] }),
    'native java direct runner should reject output directories outside the workspace'
  );
  await assertRejectsAsync(
    () => runner({ ...baseRequest, args: ['-sourcepath', '/outside/src', 'Main.java'] }),
    'native java direct runner should reject source paths outside the workspace'
  );
  await assertRejectsAsync(
    () => runner({ ...baseRequest, env: { CLASSPATH: '/outside/classes' } }),
    'native java direct runner should reject compile CLASSPATH entries outside the workspace'
  );
  await assertRejectsAsync(
    () => runner({ ...baseRequest, args: ['-d', '../outside/out', 'Main.java'] }),
    'native java direct runner should reject relative output directories outside the workspace'
  );
  await assertRejectsAsync(
    () => runner({ ...baseRequest, args: ['-sourcepath', '../outside/src', 'Main.java'] }),
    'native java direct runner should reject relative source paths outside the workspace'
  );
  await assertRejectsAsync(
    () => runner({ ...baseRequest, args: ['../outside/Main.java'] }),
    'native java direct runner should reject relative source files outside the workspace'
  );
  await assertRejectsAsync(
    () => runner({ ...baseRequest, env: { CLASSPATH: '../outside/classes' } }),
    'native java direct runner should reject relative compile CLASSPATH entries outside the workspace'
  );
}

async function testNativeCppProjectRunnerDirectCwdBoundary(): Promise<void> {
  const runner = createNativeCppProjectRunner();
  const request: CppProjectCommandRequest = {
    code: '',
    source: 'compile',
    scriptPath: 'main.cpp',
    args: ['main.cpp', '-o', 'app'],
    cwd: '/outside',
    env: {},
    project: {
      cwd: '/workspace',
      files: [{ path: 'main.cpp', contents: 'int main() { return 0; }\n' }],
    },
    options: { compilerCommand: 'clang++' },
  };

  await assertRejectsAsync(
    () => runner(request),
    'native C++ direct runner should reject cwd outside the workspace'
  );
}

async function testNativeCppProjectRunnerDirectAbsoluteDefaultScriptPath(): Promise<void> {
  const runner = createNativeCppProjectRunner();
  const result = await runner({
    code: '',
    source: 'compile',
    scriptPath: '/workspace/src/main.cpp',
    args: [],
    cwd: '/workspace/src',
    env: {},
    project: {
      cwd: '/workspace',
      files: [{ path: 'src/main.cpp', contents: '#include <iostream>\nint main() { std::cout << "direct-cpp\\n"; }\n' }],
    },
    options: { compilerCommand: 'clang++' },
  });

  assertCondition(result.exitCode === 0, `native C++ direct runner should accept /workspace default scriptPath: ${result.stderr}`);
  assertCondition(
    result.files?.some((file) => file.path === 'src/a.out' && looseChange(file).encoding === 'base64') === true,
    `native C++ direct runner should emit default executable next to cwd scriptPath: ${JSON.stringify(result.files)}`
  );
  await assertRejectsAsync(
    () => runner({
      code: '',
      source: 'compile',
      scriptPath: '/outside/main.cpp',
      args: [],
      cwd: '/workspace',
      env: {},
      project: { cwd: '/workspace', files: [{ path: 'main.cpp', contents: 'int main() { return 0; }\n' }] },
      options: { compilerCommand: 'clang++' },
    }),
    'native C++ direct runner should reject default scriptPath outside the workspace'
  );
}

async function testNativeCppProjectRunnerDirectAbsoluteOperandBoundaries(): Promise<void> {
  const runner = createNativeCppProjectRunner();
  const baseRequest: CppProjectCommandRequest = {
    code: '',
    source: 'compile',
    scriptPath: 'main.cpp',
    args: ['main.cpp', '-o', 'app'],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      files: [{ path: 'main.cpp', contents: 'int main() { return 0; }\n' }],
    },
    options: { compilerCommand: 'clang++' },
  };

  await assertRejectsAsync(
    () => runner({ ...baseRequest, args: ['main.cpp', '-o', '/outside/app'] }),
    'native C++ direct runner should reject output paths outside the workspace'
  );
  await assertRejectsAsync(
    () => runner({ ...baseRequest, args: ['main.cpp', '-o', '../outside/app'] }),
    'native C++ direct runner should reject relative output paths outside the workspace'
  );
  await assertRejectsAsync(
    () => runner({ ...baseRequest, args: ['main.cpp', '-I', '/outside/include', '-o', 'app'] }),
    'native C++ direct runner should reject include paths outside the workspace'
  );
  await assertRejectsAsync(
    () => runner({ ...baseRequest, args: ['main.cpp', '-I', '../outside/include', '-o', 'app'] }),
    'native C++ direct runner should reject relative include paths outside the workspace'
  );
  await assertRejectsAsync(
    () => runner({ ...baseRequest, args: ['../outside/main.cpp', '-o', 'app'] }),
    'native C++ direct runner should reject relative source paths outside the workspace'
  );
  await assertRejectsAsync(
    () => runner({ ...baseRequest, env: { CPATH: '/outside/include' } }),
    'native C++ direct runner should reject env include paths outside the workspace'
  );
}

async function testNativeCppProjectRunnerClosedStdin(): Promise<void> {
  const runner = createNativeCppProjectRunner({ compilerCommand: 'true' });
  const result = await runner({
    code: 'int main() { return 0; }\n'.repeat(1024),
    source: 'compile',
    scriptPath: 'main.cpp',
    args: ['-'],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      files: [],
    },
    options: { compilerCommand: 'true' },
  });

  assertCondition(result.exitCode === 0, `native C++ runner should tolerate child stdin closing early: ${result.stderr}`);
}

async function testNativeCppProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'src/main.cpp',
        contents: [
          '#include "helper.hpp"',
          '#include <cstdlib>',
          '#include <fstream>',
          '#include <iostream>',
          '#include <string>',
          'int main(int argc, char** argv) {',
          '  std::string input;',
          '  std::getline(std::cin, input);',
          '  std::ofstream("generated.txt") << value() << "\\n";',
          '  std::ofstream("bytes.bin", std::ios::binary) << std::string("\\0\\xff", 2);',
          '  std::remove("stale.txt");',
          '  std::cout << value() << "\\n";',
          '  std::cout << input << "\\n";',
          '  std::cout << std::getenv("MODE") << "\\n";',
          '  for (int i = 1; i < argc; ++i) {',
          '    if (i > 1) std::cout << ",";',
          '    std::cout << argv[i];',
          '  }',
          '  std::cout << "\\n";',
          '}',
          '',
        ].join('\n'),
      },
      { path: 'src/helper.cpp', contents: '#include "helper.hpp"\nint value() { return 42; }\n' },
      { path: 'src/helper.hpp', contents: 'int value();\n' },
      { path: 'src/stale.txt', contents: 'delete me\n' },
    ],
    cppRunner: createNativeCppProjectRunner(),
  });

  const compile = await workspace.runCommand('clang++ -std=c++17 main.cpp helper.cpp -o app', { cwd: 'src' });
  assertCondition(compile.exitCode === 0, `native clang++ should compile multifile project: ${compile.stderr}`);
  assertCondition((await workspace.readFile('src/app', 'base64')).length > 0, 'native clang++ should persist generated executable');

  const verboseCompile = await workspace.runCommand('clang++ -v -std=c++17 main.cpp helper.cpp -o verbose-app', { cwd: 'src' });
  assertCondition(verboseCompile.exitCode === 0, `native clang++ should preserve -v as a verbose compile flag: ${verboseCompile.stderr}`);
  assertCondition((await workspace.readFile('src/verbose-app', 'base64')).length > 0, 'native clang++ should persist verbose compile output');

  const run = await workspace.runCommand('./app alpha beta', {
    cwd: 'src',
    env: { MODE: 'native-cpp' },
    stdinPipe: stdinPipe('from-stdin\n'),
  });
  assertCondition(run.exitCode === 0, `native C++ executable should run: ${run.stderr}`);
  assertCondition(
    run.stdout === '42\nfrom-stdin\nnative-cpp\nalpha,beta\n',
    `native C++ executable should receive stdin/env/argv and link helper: ${run.stdout}`
  );
  assertCondition(await workspace.readFile('src/generated.txt') === '42\n', 'native C++ executable should persist generated text files');
  assertCondition(
    (await workspace.readFile('src/bytes.bin', 'base64')) === Buffer.from([0, 255]).toString('base64'),
    'native C++ executable should persist generated binary files'
  );
  await assertRejectsAsync(() => workspace.readFile('src/stale.txt'), 'native C++ executable should persist deleted files');

  const timeoutEvents: RuntimeCommandEvent[] = [];
  const timeoutScript = '#!/bin/sh\nsleep 0.025\n';
  const timeoutRunner = createNativeCppProjectRunner({ timeoutMs: 5 });
  const timeoutRun = await timeoutRunner({
    code: '',
    source: 'run',
    scriptPath: 'src/app',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      files: [
        {
          path: 'src/app',
          contents: Buffer.from(timeoutScript).toString('base64'),
          encoding: 'base64',
        },
      ],
    },
    onEvent: (event) => timeoutEvents.push(event),
  });
  assertCondition(
    timeoutRun.exitCode === 124 && timeoutRun.stderr.includes('src/app: execution timed out after 5ms'),
    `native C++ timeout should return a timeout result: ${JSON.stringify(timeoutRun)}`
  );
  const cppTimeoutStderrIndex = timeoutEvents.findIndex(
    (event) => event.type === 'output' && event.stream === 'stderr' && event.data.includes('src/app: execution timed out after 5ms')
  );
  const cppTimeoutExitIndex = timeoutEvents.findIndex(
    (event) => event.type === 'status' && event.phase === 'process-exit' && event.detail?.exitCode === 124
  );
  assertCondition(
    cppTimeoutStderrIndex >= 0 && cppTimeoutExitIndex > cppTimeoutStderrIndex,
    `native C++ timeout should stream timeout stderr before process-exit: ${JSON.stringify(timeoutEvents)}`
  );

  const startErrorEvents: RuntimeCommandEvent[] = [];
  const startErrorRunner = createNativeCppProjectRunner({ compilerCommand: 'tracecode-missing-cpp-command' });
  const startErrorResult = await startErrorRunner({
    code: '',
    source: 'compile',
    scriptPath: 'src/main.cpp',
    args: ['src/main.cpp', '-o', 'src/app'],
    cwd: '/workspace',
    env: {},
    project: {
      files: [{ path: 'src/main.cpp', contents: 'int main() { return 0; }\n' }],
    },
    onEvent: (event) => startErrorEvents.push(event),
  });
  assertCondition(startErrorResult.exitCode === 1, `native C++ start error should return failure: ${JSON.stringify(startErrorResult)}`);
  const cppStartErrorStderrIndex = startErrorEvents.findIndex(
    (event) => event.type === 'output' && event.stream === 'stderr' && event.data.includes('tracecode-missing-cpp-command')
  );
  const cppStartErrorStatusIndex = startErrorEvents.findIndex(
    (event) => event.type === 'status' && event.phase === 'process-error' && event.detail?.command === 'tracecode-missing-cpp-command'
  );
  assertCondition(
    cppStartErrorStderrIndex >= 0 && cppStartErrorStatusIndex > cppStartErrorStderrIndex,
    `native C++ start error should stream stderr before process-error: ${JSON.stringify(startErrorEvents)}`
  );
}

async function testNativeCppProjectRunnerAbsoluteWorkspacePaths(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'src/main.cpp',
        contents: [
          '#include <iostream>',
          'int main(int argc, char** argv) {',
          '  std::cout << "absolute-cpp\\n";',
          '  for (int index = 1; index < argc; ++index) {',
          '    if (index > 1) std::cout << ",";',
          '    std::cout << argv[index];',
          '  }',
          '  if (argc > 1) std::cout << "\\n";',
          '}',
          '',
        ].join('\n'),
      },
      { path: 'src/plain.c', contents: '#include <stdio.h>\nint main(void) { printf("plain-c\\n"); return 0; }\n' },
      { path: 'src/link_main.cpp', contents: '#include <iostream>\nint linked_value();\nint main() { std::cout << linked_value() << "\\n"; }\n' },
      { path: 'src/linked.cpp', contents: 'int linked_value() { return 1234; }\n' },
      { path: 'data/a.txt', contents: 'a\n' },
      { path: 'data/b.txt', contents: 'b\n' },
      { path: 'build/.keep', contents: '' },
      { path: 'envinclude/env_answer.hpp', contents: 'inline int env_answer() { return 2026; }\n' },
      { path: 'src/env_include_main.cpp', contents: '#include <env_answer.hpp>\n#include <iostream>\nint main() { std::cout << env_answer() << "\\n"; }\n' },
      { path: 'cinclude/c_answer.h', contents: '#define C_ANSWER 2027\n' },
      { path: 'src/env_c_include_main.c', contents: '#include <c_answer.h>\n#include <stdio.h>\nint main(void) { printf("%d\\n", C_ANSWER); return 0; }\n' },
    ],
    cppRunner: createNativeCppProjectRunner(),
  });

  const compile = await workspace.runCommand('clang++ -std=c++17 /workspace/src/main.cpp -o /workspace/out/app');
  assertCondition(compile.exitCode === 0, `native clang++ should map absolute /workspace paths: ${compile.stderr}`);
  assertCondition((await workspace.readFile('out/app', 'base64')).length > 0, 'native clang++ should persist absolute output executable');

  const run = await workspace.runCommand('/workspace/out/app');
  assertCondition(run.exitCode === 0, `native C++ should run absolute /workspace executable paths: ${run.stderr}`);
  assertCondition(run.stdout === 'absolute-cpp\n', `native C++ should execute absolute compiled binary: ${run.stdout}`);

  const argRun = await workspace.runCommand('/workspace/out/app data/*.txt');
  assertCondition(argRun.exitCode === 0, `native C++ should rerun absolute executables with glob args: ${argRun.stderr}`);
  assertCondition(
    argRun.stdout === 'absolute-cpp\ndata/a.txt,data/b.txt\n',
    `native C++ should expand argv globs for absolute executable runs: ${argRun.stdout}`
  );

  const cCompile = await workspace.runCommand('clang /workspace/src/plain.c -o /workspace/out/plain-c');
  assertCondition(cCompile.exitCode === 0, `native clang should compile C project files: ${cCompile.stderr}`);
  const cRun = await workspace.runCommand('/workspace/out/plain-c');
  assertCondition(cRun.exitCode === 0, `native clang-built C executable should run: ${cRun.stderr}`);
  assertCondition(cRun.stdout === 'plain-c\n', `native clang-built C executable should emit stdout: ${cRun.stdout}`);

  const gccCompile = await workspace.runCommand('gcc /workspace/src/plain.c -o /workspace/out/gcc-plain-c');
  assertCondition(gccCompile.exitCode === 0, `native gcc alias should compile C project files: ${gccCompile.stderr}`);
  const gccRun = await workspace.runCommand('/workspace/out/gcc-plain-c');
  assertCondition(gccRun.exitCode === 0, `native gcc-built C executable should run: ${gccRun.stderr}`);
  assertCondition(gccRun.stdout === 'plain-c\n', `native gcc-built C executable should emit stdout: ${gccRun.stdout}`);

  const stdinCompile = await workspace.runCommand(
    'printf \'#include <iostream>\\nint main() { std::cout << "stdin-cpp\\\\n"; }\\n\' | clang++ -std=c++17 -x c++ - -o /workspace/out/stdin-app'
  );
  assertCondition(stdinCompile.exitCode === 0, `native clang++ should compile source from stdin: ${stdinCompile.stderr}`);
  const stdinRun = await workspace.runCommand('/workspace/out/stdin-app');
  assertCondition(stdinRun.exitCode === 0, `native C++ should run stdin-compiled output: ${stdinRun.stderr}`);
  assertCondition(stdinRun.stdout === 'stdin-cpp\n', `native C++ should execute stdin-compiled output: ${stdinRun.stdout}`);

  const objectCompile = await workspace.runCommand('clang++ -std=c++17 -c /workspace/src/linked.cpp -o lib/linked.o', { cwd: 'src' });
  assertCondition(objectCompile.exitCode === 0, `native clang++ should create nested relative object outputs: ${objectCompile.stderr}`);
  assertCondition((await workspace.readFile('src/lib/linked.o', 'base64')).length > 0, 'native clang++ should persist nested object output');

  const objectLink = await workspace.runCommand('clang++ -std=c++17 /workspace/src/link_main.cpp /workspace/src/lib/linked.o -o /workspace/out/linked-app');
  assertCondition(objectLink.exitCode === 0, `native clang++ should link absolute workspace object operands: ${objectLink.stderr}`);
  const linkedRun = await workspace.runCommand('/workspace/out/linked-app');
  assertCondition(linkedRun.exitCode === 0, `native C++ should run linked object output: ${linkedRun.stderr}`);
  assertCondition(linkedRun.stdout === '1234\n', `native C++ should execute linked object output: ${linkedRun.stdout}`);

  const relativeParentCompile = await workspace.runCommand('clang++ -std=c++17 ../src/link_main.cpp ../src/linked.cpp -o ../out/relative-parent-app', { cwd: 'build' });
  assertCondition(relativeParentCompile.exitCode === 0, `native clang++ should accept relative parent source and output paths inside the workspace: ${relativeParentCompile.stderr}`);
  const relativeParentRun = await workspace.runCommand('/workspace/out/relative-parent-app');
  assertCondition(relativeParentRun.exitCode === 0, `native C++ should run relative-parent compiled output: ${relativeParentRun.stderr}`);
  assertCondition(relativeParentRun.stdout === '1234\n', `native C++ should execute relative-parent compiled output: ${relativeParentRun.stdout}`);

  const objectBase64 = await workspace.readFile('src/lib/linked.o', 'base64');
  await workspace.writeFile('src/lib/liblinked.a', await createIndexedArArchiveBase64('linked.o', objectBase64), 'base64');
  const archiveLink = await workspace.runCommand('clang++ -std=c++17 /workspace/src/link_main.cpp -L /workspace/src/lib -llinked -o /workspace/out/library-app');
  assertCondition(archiveLink.exitCode === 0, `native clang++ should resolve absolute workspace library archives: ${archiveLink.stderr}`);
  const libraryRun = await workspace.runCommand('/workspace/out/library-app');
  assertCondition(libraryRun.exitCode === 0, `native C++ should run linked archive output: ${libraryRun.stderr}`);
  assertCondition(libraryRun.stdout === '1234\n', `native C++ should execute linked archive output: ${libraryRun.stdout}`);

  const envIncludeCompile = await workspace.runCommand('clang++ -std=c++17 /workspace/src/env_include_main.cpp -o /workspace/out/env-include-app', {
    env: { CPATH: '/workspace/envinclude' },
  });
  assertCondition(envIncludeCompile.exitCode === 0, `native clang++ should honor CPATH workspace includes: ${envIncludeCompile.stderr}`);
  const envIncludeRun = await workspace.runCommand('/workspace/out/env-include-app');
  assertCondition(envIncludeRun.exitCode === 0, `native C++ should run CPATH-built output: ${envIncludeRun.stderr}`);
  assertCondition(envIncludeRun.stdout === '2026\n', `native C++ should execute CPATH-built output: ${envIncludeRun.stdout}`);

  const cwdRelativeEnvIncludeCompile = await workspace.runCommand('clang++ -std=c++17 ../src/env_include_main.cpp -o ../out/cwd-env-include-app', {
    cwd: 'build',
    env: { CPATH: '../envinclude' },
  });
  assertCondition(cwdRelativeEnvIncludeCompile.exitCode === 0, `native clang++ should honor cwd-relative CPATH workspace includes: ${cwdRelativeEnvIncludeCompile.stderr}`);
  const cwdRelativeEnvIncludeRun = await workspace.runCommand('/workspace/out/cwd-env-include-app');
  assertCondition(cwdRelativeEnvIncludeRun.exitCode === 0, `native C++ should run cwd-relative CPATH-built output: ${cwdRelativeEnvIncludeRun.stderr}`);
  assertCondition(cwdRelativeEnvIncludeRun.stdout === '2026\n', `native C++ should execute cwd-relative CPATH-built output: ${cwdRelativeEnvIncludeRun.stdout}`);

  const cIncludeCompile = await workspace.runCommand('clang /workspace/src/env_c_include_main.c -o /workspace/out/env-c-include-app', {
    env: { C_INCLUDE_PATH: '/workspace/cinclude' },
  });
  assertCondition(cIncludeCompile.exitCode === 0, `native clang should honor C_INCLUDE_PATH workspace includes: ${cIncludeCompile.stderr}`);
  const cIncludeRun = await workspace.runCommand('/workspace/out/env-c-include-app');
  assertCondition(cIncludeRun.exitCode === 0, `native C executable should run C_INCLUDE_PATH-built output: ${cIncludeRun.stderr}`);
  assertCondition(cIncludeRun.stdout === '2027\n', `native C executable should execute C_INCLUDE_PATH-built output: ${cIncludeRun.stdout}`);

  const ccIncludeCompile = await workspace.runCommand('cc /workspace/src/env_c_include_main.c -o /workspace/out/cc-env-c-include-app', {
    env: { C_INCLUDE_PATH: '/workspace/cinclude' },
  });
  assertCondition(ccIncludeCompile.exitCode === 0, `native cc alias should honor C_INCLUDE_PATH workspace includes: ${ccIncludeCompile.stderr}`);
  const ccIncludeRun = await workspace.runCommand('/workspace/out/cc-env-c-include-app');
  assertCondition(ccIncludeRun.exitCode === 0, `native cc-built C executable should run C_INCLUDE_PATH-built output: ${ccIncludeRun.stderr}`);
  assertCondition(ccIncludeRun.stdout === '2027\n', `native cc-built C executable should execute C_INCLUDE_PATH-built output: ${ccIncludeRun.stdout}`);

  const envLibraryCompile = await workspace.runCommand('clang++ -std=c++17 /workspace/src/link_main.cpp -llinked -o /workspace/out/env-library-app', {
    env: { LIBRARY_PATH: '/workspace/src/lib' },
  });
  assertCondition(envLibraryCompile.exitCode === 0, `native clang++ should honor LIBRARY_PATH workspace archives: ${envLibraryCompile.stderr}`);
  const envLibraryRun = await workspace.runCommand('/workspace/out/env-library-app');
  assertCondition(envLibraryRun.exitCode === 0, `native C++ should run LIBRARY_PATH-linked output: ${envLibraryRun.stderr}`);
  assertCondition(envLibraryRun.stdout === '1234\n', `native C++ should execute LIBRARY_PATH-linked output: ${envLibraryRun.stdout}`);

  const cwdRelativeEnvLibraryCompile = await workspace.runCommand('clang++ -std=c++17 ../src/link_main.cpp -llinked -o ../out/cwd-env-library-app', {
    cwd: 'build',
    env: { LIBRARY_PATH: '../src/lib' },
  });
  assertCondition(cwdRelativeEnvLibraryCompile.exitCode === 0, `native clang++ should honor cwd-relative LIBRARY_PATH workspace archives: ${cwdRelativeEnvLibraryCompile.stderr}`);
  const cwdRelativeEnvLibraryRun = await workspace.runCommand('/workspace/out/cwd-env-library-app');
  assertCondition(cwdRelativeEnvLibraryRun.exitCode === 0, `native C++ should run cwd-relative LIBRARY_PATH-linked output: ${cwdRelativeEnvLibraryRun.stderr}`);
  assertCondition(cwdRelativeEnvLibraryRun.stdout === '1234\n', `native C++ should execute cwd-relative LIBRARY_PATH-linked output: ${cwdRelativeEnvLibraryRun.stdout}`);

  const outsideRelativeEnvIncludeCompile = await workspace.runCommand('clang++ -std=c++17 /workspace/src/env_include_main.cpp -o /workspace/out/bad-env-include-app', {
    env: { CPATH: '../outside/include' },
  });
  assertCondition(
    outsideRelativeEnvIncludeCompile.exitCode !== 0 && outsideRelativeEnvIncludeCompile.stderr.includes('Project path must stay inside the workspace'),
    `native clang++ should reject cwd-relative CPATH entries outside the workspace: ${outsideRelativeEnvIncludeCompile.stderr}`
  );
}

async function testNativeCSharpProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'src/Program.cs',
        contents: [
          'using System;',
          'using System.IO;',
          'var input = Console.ReadLine();',
          'File.WriteAllText("generated.txt", Helper.Value().ToString() + "\\n");',
          'File.WriteAllBytes("bytes.bin", new byte[] { 0, 255 });',
          'if (File.Exists("stale.txt")) File.Delete("stale.txt");',
          'Console.WriteLine(Helper.Value());',
          'Console.WriteLine(input);',
          'Console.WriteLine(Environment.GetEnvironmentVariable("MODE"));',
          'Console.WriteLine(string.Join(",", args));',
          '',
        ].join('\n'),
      },
      { path: 'src/Helper.cs', contents: 'static class Helper { public static int Value() => 42; }\n' },
      { path: 'src/stale.txt', contents: 'delete me\n' },
      { path: 'unrelated/Broken.cs', contents: 'this outside-cwd file should not compile\n' },
    ],
    csharpRunner: createNativeCSharpProjectRunner(),
  });

  const build = await workspace.runCommand('dotnet build', { cwd: 'src' });
  assertCondition(build.exitCode === 0, `native dotnet build should compile multifile project: ${build.stderr}`);
  const builtFiles = await workspace.runCommand('find bin -path "*TraceCodeProject.dll" -type f');
  assertCondition(builtFiles.exitCode === 0 && builtFiles.stdout.includes('TraceCodeProject.dll'), 'native dotnet build should persist build output');

  const run = await workspace.runCommand('dotnet run alpha beta', {
    cwd: 'src',
    env: { MODE: 'native-csharp' },
    stdinPipe: stdinPipe('from-stdin\n'),
  });
  assertCondition(run.exitCode === 0, `native dotnet run should execute project: ${run.stderr}`);
  assertCondition(
    run.stdout.endsWith('42\nfrom-stdin\nnative-csharp\nalpha,beta\n'),
    `native dotnet run should receive stdin/env/argv and link helper: ${run.stdout}`
  );
  assertCondition(await workspace.readFile('src/generated.txt') === '42\n', 'native C# executable should persist generated text files');
  assertCondition(
    (await workspace.readFile('src/bytes.bin', 'base64')) === Buffer.from([0, 255]).toString('base64'),
    'native C# executable should persist generated binary files'
  );
  await assertRejectsAsync(() => workspace.readFile('src/stale.txt'), 'native C# executable should persist deleted files');

  const launchProfileRun = await workspace.runCommand('dotnet run --launch-profile MissingProfile --no-launch-profile launch', {
    cwd: 'src',
    env: { MODE: 'native-csharp-launch' },
    stdinPipe: stdinPipe('launch-stdin\n'),
  });
  assertCondition(launchProfileRun.exitCode === 0, `native dotnet run should consume launch profile options: ${launchProfileRun.stderr}`);
  assertCondition(
    launchProfileRun.stdout.endsWith('42\nlaunch-stdin\nnative-csharp-launch\nlaunch\n'),
    `native dotnet run should not leak launch profile names into argv: ${launchProfileRun.stdout}`
  );

  await workspace.writeFile('src/Program.cs', 'Console.WriteLine("changed-source");\n');
  const noBuildRun = await workspace.runCommand('dotnet run --no-build -- stale', {
    cwd: 'src',
    env: { MODE: 'native-csharp-nobuild' },
    stdinPipe: stdinPipe('no-build-stdin\n'),
  });
  assertCondition(noBuildRun.exitCode === 0, `native dotnet run --no-build should execute persisted build output: ${noBuildRun.stderr}`);
  assertCondition(
    noBuildRun.stdout.endsWith('42\nno-build-stdin\nnative-csharp-nobuild\nstale\n'),
    `native dotnet run --no-build should skip rebuilding changed sources: ${noBuildRun.stdout}`
  );

  const timeoutEvents: RuntimeCommandEvent[] = [];
  const timeoutRoot = await mkdtemp(join(tmpdir(), 'tracecode-csharp-timeout-command-'));
  try {
    const timeoutCommand = join(timeoutRoot, 'dotnet-timeout');
    await writeFile(timeoutCommand, '#!/bin/sh\nsleep 1\n', 'utf8');
    await chmod(timeoutCommand, 0o755);
    const timeoutRunner = createNativeCSharpProjectRunner({ dotnetCommand: timeoutCommand, timeoutMs: 5 });
    const timeoutResult = await timeoutRunner({
      code: '',
      source: 'compile',
      scriptPath: '<project>',
      args: [],
      cwd: '/workspace',
      env: {},
      project: {
        files: [{ path: 'Program.cs', contents: 'Console.WriteLine("timeout");\n' }],
      },
      onEvent: (event) => timeoutEvents.push(event),
    });
    assertCondition(
      timeoutResult.exitCode === 124 && timeoutResult.stderr.includes('dotnet build: execution timed out after 5ms'),
      `native C# timeout should return a timeout result: ${JSON.stringify(timeoutResult)}`
    );
    const csharpTimeoutStderrIndex = timeoutEvents.findIndex(
      (event) => event.type === 'output' && event.stream === 'stderr' && event.data.includes('dotnet build: execution timed out after 5ms')
    );
    const csharpTimeoutExitIndex = timeoutEvents.findIndex(
      (event) => event.type === 'status' && event.phase === 'process-exit' && event.detail?.exitCode === 124
    );
    assertCondition(
      csharpTimeoutStderrIndex >= 0 && csharpTimeoutExitIndex > csharpTimeoutStderrIndex,
      `native C# timeout should stream timeout stderr before process-exit: ${JSON.stringify(timeoutEvents)}`
    );
  } finally {
    await rm(timeoutRoot, { recursive: true, force: true });
  }

  const startErrorEvents: RuntimeCommandEvent[] = [];
  const startErrorRunner = createNativeCSharpProjectRunner({ dotnetCommand: 'tracecode-missing-dotnet-command' });
  const startErrorResult = await startErrorRunner({
    code: '',
    source: 'compile',
    scriptPath: '<project>',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      files: [{ path: 'Program.cs', contents: 'Console.WriteLine("ok");\n' }],
    },
    onEvent: (event) => startErrorEvents.push(event),
  });
  assertCondition(startErrorResult.exitCode === 1, `native C# start error should return failure: ${JSON.stringify(startErrorResult)}`);
  const csharpStartErrorStderrIndex = startErrorEvents.findIndex(
    (event) => event.type === 'output' && event.stream === 'stderr' && event.data.includes('tracecode-missing-dotnet-command')
  );
  const csharpStartErrorStatusIndex = startErrorEvents.findIndex(
    (event) => event.type === 'status' && event.phase === 'process-error' && event.detail?.command === 'tracecode-missing-dotnet-command'
  );
  assertCondition(
    csharpStartErrorStderrIndex >= 0 && csharpStartErrorStatusIndex > csharpStartErrorStderrIndex,
    `native C# start error should stream stderr before process-error: ${JSON.stringify(startErrorEvents)}`
  );
}

async function testNativeCSharpProjectRunnerDirectCwdBoundary(): Promise<void> {
  const runner = createNativeCSharpProjectRunner();
  const request: CSharpProjectCommandRequest = {
    code: '',
    source: 'compile',
    scriptPath: '<project>',
    args: [],
    cwd: '/outside',
    env: {},
    project: {
      cwd: '/workspace',
      files: [{ path: 'Program.cs', contents: 'Console.WriteLine("ok");\n' }],
    },
  };

  await assertRejectsAsync(
    () => runner(request),
    'native C# direct runner should reject cwd outside the workspace'
  );
}

async function testNativeCSharpProjectRunnerDirectAbsoluteOperandBoundary(): Promise<void> {
  const runner = createNativeCSharpProjectRunner();
  const request: CSharpProjectCommandRequest = {
    code: '',
    source: 'compile',
    scriptPath: '<project>',
    args: ['/outside/Host.csproj'],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      files: [{ path: 'Program.cs', contents: 'Console.WriteLine("ok");\n' }],
    },
  };

  await assertRejectsAsync(
    () => runner(request),
    'native C# direct runner should reject build args outside the workspace'
  );
}

async function testNativeCSharpProjectRunnerAbsoluteWorkspaceProjectPath(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'build/.keep', contents: '' },
      {
        path: 'app/App.csproj',
        contents: [
          '<Project Sdk="Microsoft.NET.Sdk">',
          '  <PropertyGroup>',
          '    <OutputType>Exe</OutputType>',
          '    <TargetFramework>net10.0</TargetFramework>',
          '    <ImplicitUsings>enable</ImplicitUsings>',
          '    <Nullable>disable</Nullable>',
          '  </PropertyGroup>',
          '</Project>',
          '',
        ].join('\n'),
      },
      { path: 'app/Program.cs', contents: 'Console.WriteLine("absolute-csharp");\n' },
    ],
    csharpRunner: createNativeCSharpProjectRunner(),
  });

  const build = await workspace.runCommand('dotnet build /workspace/app/App.csproj');
  assertCondition(build.exitCode === 0, `native dotnet build should map absolute /workspace project path: ${build.stderr}`);

  const cwdRelativeBuild = await workspace.runCommand('dotnet build ../app/App.csproj', { cwd: 'build' });
  assertCondition(cwdRelativeBuild.exitCode === 0, `native dotnet build should resolve cwd-relative project path: ${cwdRelativeBuild.stderr}`);

  const run = await workspace.runCommand('dotnet run --project /workspace/app/App.csproj');
  assertCondition(run.exitCode === 0, `native dotnet run should map absolute /workspace project path: ${run.stderr}`);
  assertCondition(run.stdout.endsWith('absolute-csharp\n'), `native dotnet run should execute absolute project path: ${run.stdout}`);

  const cwdRelativeRun = await workspace.runCommand('dotnet run --project ../app/App.csproj', { cwd: 'build' });
  assertCondition(cwdRelativeRun.exitCode === 0, `native dotnet run should resolve cwd-relative project path: ${cwdRelativeRun.stderr}`);
  assertCondition(cwdRelativeRun.stdout.endsWith('absolute-csharp\n'), `native dotnet run should execute cwd-relative project path: ${cwdRelativeRun.stdout}`);

  const shortProjectRun = await workspace.runCommand('dotnet run -p ../app/App.csproj', { cwd: 'build' });
  assertCondition(shortProjectRun.exitCode === 0, `native dotnet run should accept -p project shorthand: ${shortProjectRun.stderr}`);
  assertCondition(shortProjectRun.stdout.endsWith('absolute-csharp\n'), `native dotnet run -p should execute cwd-relative project path: ${shortProjectRun.stdout}`);
}

async function testNativeCSharpEmbeddedResourceProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'resources/Resources.csproj',
        contents: [
          '<Project Sdk="Microsoft.NET.Sdk">',
          '  <PropertyGroup>',
          '    <OutputType>Exe</OutputType>',
          '    <TargetFramework>net10.0</TargetFramework>',
          '    <ImplicitUsings>enable</ImplicitUsings>',
          '    <Nullable>disable</Nullable>',
          '    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>',
          '  </PropertyGroup>',
          '  <ItemGroup>',
          '    <Compile Include="Program.cs" />',
          '    <EmbeddedResource Include="data/message.txt">',
          '      <LogicalName>App.Message</LogicalName>',
          '    </EmbeddedResource>',
          '  </ItemGroup>',
          '</Project>',
          '',
        ].join('\n'),
      },
      {
        path: 'resources/Program.cs',
        contents: [
          'using System.Reflection;',
          'using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("App.Message");',
          'using var reader = new StreamReader(stream!);',
          'Console.WriteLine(reader.ReadToEnd());',
          '',
        ].join('\n'),
      },
      { path: 'resources/data/message.txt', contents: 'embedded-resource\n' },
    ],
    csharpRunner: createNativeCSharpProjectRunner(),
  });

  const run = await workspace.runCommand('dotnet run --project /workspace/resources/Resources.csproj');
  assertCondition(run.exitCode === 0, `native dotnet run should expose embedded resources: ${run.stderr}`);
  assertCondition(
    run.stdout.endsWith('embedded-resource\n\n'),
    `native dotnet run should read embedded resources by logical name: ${run.stdout}`
  );
}

async function testNativeCSharpLibraryProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'lib/Lib.csproj',
        contents: [
          '<Project Sdk="Microsoft.NET.Sdk">',
          '  <PropertyGroup>',
          '    <OutputType>Library</OutputType>',
          '    <TargetFramework>net10.0</TargetFramework>',
          '    <ImplicitUsings>enable</ImplicitUsings>',
          '    <Nullable>disable</Nullable>',
          '  </PropertyGroup>',
          '</Project>',
          '',
        ].join('\n'),
      },
      {
        path: 'lib/Helper.cs',
        contents: 'namespace LibraryOnly; public static class Helper { public static int Value() => 91; }\n',
      },
    ],
    csharpRunner: createNativeCSharpProjectRunner(),
  });

  const build = await workspace.runCommand('dotnet build /workspace/lib/Lib.csproj');
  assertCondition(build.exitCode === 0, `native dotnet build should compile library projects without an entrypoint: ${build.stderr}`);

  const builtFiles = await workspace.runCommand('find lib/bin -path "*Lib.dll" -type f');
  assertCondition(
    builtFiles.exitCode === 0 && builtFiles.stdout.includes('Lib.dll'),
    `native dotnet build should persist library dll output: ${builtFiles.stdout}${builtFiles.stderr}`
  );

  const run = await workspace.runCommand('dotnet run --project /workspace/lib/Lib.csproj');
  assertCondition(run.exitCode !== 0, 'native dotnet run should reject library projects without an entrypoint');
}

async function testNativeCSharpHintPathReferenceProjectRunner(): Promise<void> {
  const externalDllBase64 = await createExternalCSharpDllBase64();
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'hintref/App.csproj',
        contents: [
          '<Project Sdk="Microsoft.NET.Sdk">',
          '  <PropertyGroup>',
          '    <OutputType>Exe</OutputType>',
          '    <TargetFramework>net10.0</TargetFramework>',
          '    <ImplicitUsings>enable</ImplicitUsings>',
          '    <Nullable>disable</Nullable>',
          '  </PropertyGroup>',
          '  <ItemGroup>',
          '    <Reference Include="ExternalLib">',
          '      <HintPath>lib/ExternalLib.dll</HintPath>',
          '    </Reference>',
          '  </ItemGroup>',
          '</Project>',
          '',
        ].join('\n'),
      },
      { path: 'hintref/Program.cs', contents: 'Console.WriteLine(ExternalLib.Helper.Value());\n' },
      { path: 'hintref/lib/ExternalLib.dll', contents: externalDllBase64, encoding: 'base64' },
    ],
    csharpRunner: createNativeCSharpProjectRunner(),
  });

  const run = await workspace.runCommand('dotnet run --project /workspace/hintref/App.csproj');
  assertCondition(run.exitCode === 0, `native dotnet run should link HintPath DLL references: ${run.stderr}`);
  assertCondition(run.stdout.endsWith('314\n'), `native dotnet run should execute HintPath DLL references: ${run.stdout}`);
}

async function testNativeCSharpProjectReferenceProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'refapp/App.csproj',
        contents: [
          '<Project Sdk="Microsoft.NET.Sdk">',
          '  <PropertyGroup>',
          '    <OutputType>Exe</OutputType>',
          '    <TargetFramework>net10.0</TargetFramework>',
          '    <ImplicitUsings>enable</ImplicitUsings>',
          '    <Nullable>disable</Nullable>',
          '  </PropertyGroup>',
          '  <ItemGroup>',
          '    <ProjectReference Include="../reflib/Lib.csproj" />',
          '  </ItemGroup>',
          '</Project>',
          '',
        ].join('\n'),
      },
      { path: 'refapp/Program.cs', contents: 'Console.WriteLine(RefLib.Helper.Value());\n' },
      {
        path: 'reflib/Lib.csproj',
        contents: [
          '<Project Sdk="Microsoft.NET.Sdk">',
          '  <PropertyGroup>',
          '    <TargetFramework>net10.0</TargetFramework>',
          '    <ImplicitUsings>enable</ImplicitUsings>',
          '    <Nullable>disable</Nullable>',
          '  </PropertyGroup>',
          '</Project>',
          '',
        ].join('\n'),
      },
      { path: 'reflib/Helper.cs', contents: 'namespace RefLib; public static class Helper { public static int Value() => 88; }\n' },
    ],
    csharpRunner: createNativeCSharpProjectRunner(),
  });

  const run = await workspace.runCommand('dotnet run --project /workspace/refapp/App.csproj');
  assertCondition(run.exitCode === 0, `native dotnet run should honor ProjectReference source linking: ${run.stderr}`);
  assertCondition(run.stdout.endsWith('88\n'), `native dotnet run should compile referenced project sources: ${run.stdout}`);
}

async function testNativeCSharpProjectFileBoundaryProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'escape/App.csproj',
        contents: [
          '<Project Sdk="Microsoft.NET.Sdk">',
          '  <PropertyGroup>',
          '    <OutputType>Exe</OutputType>',
          '    <TargetFramework>net10.0</TargetFramework>',
          '  </PropertyGroup>',
          '  <ItemGroup>',
          '    <Compile Include="/outside/Program.cs" />',
          '  </ItemGroup>',
          '</Project>',
          '',
        ].join('\n'),
      },
      { path: 'escape/Program.cs', contents: 'Console.WriteLine("ok");\n' },
    ],
    csharpRunner: createNativeCSharpProjectRunner(),
  });

  const compileItem = await workspace.runCommand('dotnet build /workspace/escape/App.csproj');
  assertCondition(
    compileItem.exitCode !== 0 && compileItem.stderr.includes('Project path must stay inside the workspace'),
    `native dotnet should reject Compile items outside the workspace: ${compileItem.stderr}`
  );

  await workspace.writeFile(
    'escape/App.csproj',
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup>',
      '    <OutputType>Exe</OutputType>',
      '    <TargetFramework>net10.0</TargetFramework>',
      '  </PropertyGroup>',
      '  <ItemGroup>',
      '    <ProjectReference Include="/outside/Lib.csproj" />',
      '  </ItemGroup>',
      '</Project>',
      '',
    ].join('\n')
  );
  const projectReference = await workspace.runCommand('dotnet build /workspace/escape/App.csproj');
  assertCondition(
    projectReference.exitCode !== 0 && projectReference.stderr.includes('Project path must stay inside the workspace'),
    `native dotnet should reject ProjectReference items outside the workspace: ${projectReference.stderr}`
  );

  await workspace.writeFile(
    'escape/App.csproj',
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup>',
      '    <OutputType>Exe</OutputType>',
      '    <TargetFramework>net10.0</TargetFramework>',
      '  </PropertyGroup>',
      '  <ItemGroup>',
      '    <Reference Include="ExternalLib">',
      '      <HintPath>/outside/ExternalLib.dll</HintPath>',
      '    </Reference>',
      '  </ItemGroup>',
      '</Project>',
      '',
    ].join('\n')
  );
  const hintPath = await workspace.runCommand('dotnet build /workspace/escape/App.csproj');
  assertCondition(
    hintPath.exitCode !== 0 && hintPath.stderr.includes('Project path must stay inside the workspace'),
    `native dotnet should reject HintPath items outside the workspace: ${hintPath.stderr}`
  );
}

async function testNativeCSharpProjectRunnerCwdProjectSelection(): Promise<void> {
  const projectFile = (name: string) => [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    '    <OutputType>Exe</OutputType>',
    '    <TargetFramework>net10.0</TargetFramework>',
    '    <ImplicitUsings>enable</ImplicitUsings>',
    '    <Nullable>disable</Nullable>',
    '  </PropertyGroup>',
    '</Project>',
    '',
  ].join('\n');
  const workspace = await createRuntimeWorkspace({
    files: [
      { path: 'a/A.csproj', contents: projectFile('A') },
      { path: 'a/Program.cs', contents: 'Console.WriteLine("wrong-project");\n' },
      { path: 'b/B.csproj', contents: projectFile('B') },
      { path: 'b/Program.cs', contents: 'Console.WriteLine("selected-by-cwd");\n' },
    ],
    csharpRunner: createNativeCSharpProjectRunner(),
  });

  const run = await workspace.runCommand('dotnet run', { cwd: 'b' });
  assertCondition(run.exitCode === 0, `native dotnet run should pick the project under cwd: ${run.stderr}`);
  assertCondition(run.stdout.endsWith('selected-by-cwd\n'), `native dotnet run should execute cwd project, received ${run.stdout}`);
}

async function testNativeCSharpCommandLinePropertiesProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
      {
        path: 'props/Props.csproj',
        contents: [
          '<Project Sdk="Microsoft.NET.Sdk">',
          '  <PropertyGroup>',
          '    <OutputType>Exe</OutputType>',
          '    <TargetFramework>net10.0</TargetFramework>',
          '    <ImplicitUsings>enable</ImplicitUsings>',
          '    <Nullable>disable</Nullable>',
          '  </PropertyGroup>',
          '</Project>',
          '',
        ].join('\n'),
      },
      {
        path: 'props/Program.cs',
        contents: [
          '#if CLI_ONE && CLI_TWO',
          'unsafe {',
          '  int value = 789;',
          '  int* pointer = &value;',
          '  Console.WriteLine(*pointer);',
          '}',
          '#else',
          'this branch should not compile if command-line DefineConstants is honored',
          '#endif',
          '',
        ].join('\n'),
      },
    ],
    csharpRunner: createNativeCSharpProjectRunner(),
  });

  const build = await workspace.runCommand('dotnet build /workspace/props/Props.csproj -p DefineConstants=CLI_ONE%3BCLI_TWO --property AllowUnsafeBlocks=true');
  assertCondition(build.exitCode === 0, `native dotnet build should honor command-line MSBuild properties: ${build.stderr}`);

  const run = await workspace.runCommand('dotnet run --project /workspace/props/Props.csproj --property=DefineConstants=CLI_ONE%3BCLI_TWO -p AllowUnsafeBlocks=true -- alpha beta');
  assertCondition(run.exitCode === 0, `native dotnet run should honor command-line MSBuild properties: ${run.stderr}`);
  assertCondition(run.stdout.endsWith('789\n'), `native dotnet run should execute property-built output: ${run.stdout}`);
}

async function testLiveStdinAcrossProjectRunners(): Promise<void> {
  const pythonWorkspace = await createRuntimeWorkspace({
    files: [{
      path: 'ask.py',
      contents: [
        'import sys',
        'sys.stdout.write("py> ")',
        'sys.stdout.flush()',
        'print("py=" + sys.stdin.readline().strip())',
        '',
      ].join('\n'),
    }],
    pythonRunner: createNativePythonProjectRunner(),
  });
  const pythonResult = await runCommandWithLiveInput(pythonWorkspace, 'python3 ask.py', 'py> ', 'native-python\n');
  assertCondition(pythonResult.exitCode === 0, `native Python live stdin should succeed: ${pythonResult.stderr}`);
  assertCondition(pythonResult.stdout === 'py> py=native-python\n', `native Python should receive stdin after prompting: ${pythonResult.stdout}`);
  pythonWorkspace.dispose();

  const nativeNodeWorkspace = await createRuntimeWorkspace({
    files: [{
      path: 'ask.js',
      contents: [
        'process.stdout.write("node> ");',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.once("data", (chunk) => console.log("node=" + chunk.trim()));',
        'process.stdin.resume();',
        '',
      ].join('\n'),
    }],
    nodeRunner: createNativeJavaScriptProjectRunner(),
  });
  const nativeNodeResult = await runCommandWithLiveInput(nativeNodeWorkspace, 'node ask.js', 'node> ', 'native-node\n');
  assertCondition(nativeNodeResult.exitCode === 0, `native Node live stdin should succeed: ${nativeNodeResult.stderr}`);
  assertCondition(nativeNodeResult.stdout === 'node> node=native-node\n', `native Node should receive stdin after prompting: ${nativeNodeResult.stdout}`);
  nativeNodeWorkspace.dispose();

  const browserNodeWorkspace = await createRuntimeWorkspace({
    files: [{
      path: 'ask.js',
      contents: [
        'process.stdout.write("browser-node> ");',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.once("data", (chunk) => console.log("browser-node=" + chunk.trim()));',
        'process.stdin.resume();',
        '',
      ].join('\n'),
    }],
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true }),
  });
  const browserNodeResult = await runCommandWithLiveInput(browserNodeWorkspace, 'node ask.js', 'browser-node> ', 'browser-node\n');
  assertCondition(browserNodeResult.exitCode === 0, `browser Node live stdin should succeed: ${browserNodeResult.stderr}`);
  assertCondition(
    browserNodeResult.stdout === 'browser-node> browser-node=browser-node\n',
    `browser Node should receive stdin after prompting: ${browserNodeResult.stdout}`
  );
  browserNodeWorkspace.dispose();

  const javaWorkspace = await createRuntimeWorkspace({
    files: [{
      path: 'Ask.java',
      contents: [
        'public class Ask {',
        '  public static void main(String[] args) throws Exception {',
        '    System.out.print("java> ");',
        '    System.out.flush();',
        '    java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(System.in));',
        '    System.out.println("java=" + reader.readLine());',
        '  }',
        '}',
        '',
      ].join('\n'),
    }],
    javaRunner: createNativeJavaProjectRunner(),
  });
  const javaResult = await runCommandWithLiveInput(javaWorkspace, 'java Ask', 'java> ', 'native-java\n');
  assertCondition(javaResult.exitCode === 0, `native Java live stdin should succeed: ${javaResult.stderr}`);
  assertCondition(javaResult.stdout === 'java> java=native-java\n', `native Java should receive stdin after prompting: ${javaResult.stdout}`);
  javaWorkspace.dispose();

  const javaUtf8OutputEvents: RuntimeCommandEvent[] = [];
  const javaUtf8Workspace = await createRuntimeWorkspace({
    files: [{
      path: 'Utf8Bytes.java',
      contents: [
        'public class Utf8Bytes {',
        '  public static void main(String[] args) throws Exception {',
        '    System.out.write(0xE2);',
        '    System.out.write(0x82);',
        '    System.out.write(0xAC);',
        '    System.out.write(0x0A);',
        '    System.out.flush();',
        '  }',
        '}',
        '',
      ].join('\n'),
    }],
    javaRunner: createNativeJavaProjectRunner(),
  });
  const javaUtf8Result = await javaUtf8Workspace.runCommand('java Utf8Bytes', {
    onEvent: (event) => javaUtf8OutputEvents.push(event),
  });
  const javaUtf8LiveStdout = javaUtf8OutputEvents
    .filter((event): event is Extract<RuntimeCommandEvent, { type: 'output' }> => event.type === 'output' && event.stream === 'stdout')
    .map((event) => event.data)
    .join('');
  assertCondition(javaUtf8Result.exitCode === 0, `native Java split UTF-8 stdout should succeed: ${javaUtf8Result.stderr}`);
  assertCondition(javaUtf8Result.stdout === '€\n', `native Java final stdout should preserve split UTF-8 bytes: ${JSON.stringify(javaUtf8Result)}`);
  assertCondition(
    javaUtf8LiveStdout === '€\n',
    `native Java live stdout should preserve split UTF-8 bytes: ${JSON.stringify(javaUtf8OutputEvents)}`
  );
  javaUtf8Workspace.dispose();

  const cppWorkspace = await createRuntimeWorkspace({
    files: [{
      path: 'ask.cpp',
      contents: [
        '#include <iostream>',
        '#include <string>',
        'int main() {',
        '  std::cout << "cpp> " << std::flush;',
        '  std::string value;',
        '  std::getline(std::cin, value);',
        '  std::cout << "cpp=" << value << "\\n";',
        '}',
        '',
      ].join('\n'),
    }],
    cppRunner: createNativeCppProjectRunner(),
  });
  const cppCompile = await cppWorkspace.runCommand('clang++ -std=c++17 ask.cpp -o ask');
  assertCondition(cppCompile.exitCode === 0, `native C++ live stdin fixture should compile: ${cppCompile.stderr}`);
  const cppResult = await runCommandWithLiveInput(cppWorkspace, './ask', 'cpp> ', 'native-cpp\n');
  assertCondition(cppResult.exitCode === 0, `native C++ live stdin should succeed: ${cppResult.stderr}`);
  assertCondition(cppResult.stdout === 'cpp> cpp=native-cpp\n', `native C++ should receive stdin after prompting: ${cppResult.stdout}`);
  cppWorkspace.dispose();

  const csharpWorkspace = await createRuntimeWorkspace({
    files: [{
      path: 'Program.cs',
      contents: [
        'Console.Write("csharp> ");',
        'Console.Out.Flush();',
        'Console.WriteLine("csharp=" + Console.ReadLine());',
        '',
      ].join('\n'),
    }],
    csharpRunner: createNativeCSharpProjectRunner(),
  });
  const csharpResult = await runCommandWithLiveInput(csharpWorkspace, 'dotnet run', 'csharp> ', 'native-csharp\n');
  assertCondition(csharpResult.exitCode === 0, `native C# live stdin should succeed: ${csharpResult.stderr}`);
  assertCondition(
    csharpResult.stdout.endsWith('csharp> csharp=native-csharp\n'),
    `native C# should receive stdin after prompting: ${csharpResult.stdout}`
  );
  csharpWorkspace.dispose();
}

async function testBrowserJavaProjectRunnerAdapter(): Promise<void> {
  let received: JavaProjectCommandRequest | null = null;
  let callCount = 0;
  const events: RuntimeCommandEvent[] = [];
  const appliedChanges: string[] = [];
  let fileChangeObservedAfterApply = false;
  let directoryChangeObservedAfterApply = false;
  const runner = createBrowserJavaProjectRunner({
    async executeProjectJava(request, _timeoutMs, onEvent) {
      callCount += 1;
      received = request;
      onEvent?.({ type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'java-streamed\n' });
      onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'java-live.txt', contents: 'live\n' } });
      onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'java-live-dir', directory: true } });
      onEvent?.({ type: 'file-change', phase: 'final-diff', change: { path: 'java-generated.txt', contents: 'generated\n' } });
      return {
        stdout: `java-streamed\n${request.source}:${request.scriptPath}:${request.project.files.length}`,
        stderr: '',
        exitCode: 0,
        files: [
          { path: 'java-live.txt', contents: 'live\n' },
          { path: 'java-generated.txt', contents: 'generated\n' },
          { path: 'java-returned.txt', contents: 'returned\n' },
        ],
      };
    },
  }, {
    applyFileChange: async (change) => {
      appliedChanges.push(change.path);
    },
  });

  const result = await runner({
    code: '',
    source: 'run',
    scriptPath: 'Main',
    args: ['alpha'],
    cwd: '/workspace',
    env: {},
    project: {
      files: [
        { path: 'Main.java', contents: 'class Main { public static void main(String[] args) { System.out.println(Helper.value()); } }\n' },
        { path: 'Helper.java', contents: 'class Helper { static int value() { return 5; } }\n' },
      ],
    },
    onEvent: (event) => {
      if (event.type === 'file-change' && event.change.path === 'java-live.txt') {
        fileChangeObservedAfterApply = appliedChanges.includes('java-live.txt');
      }
      if (event.type === 'file-change' && event.change.path === 'java-live-dir') {
        directoryChangeObservedAfterApply = appliedChanges.includes('java-live-dir');
      }
      events.push(event);
    },
  });

  assertCondition(result.stdout === 'java-streamed\nrun:Main:2', 'browser java runner should delegate full project snapshot to worker client');
  assertCondition((received as JavaProjectCommandRequest | null)?.scriptPath === 'Main', 'browser java runner should pass through request');
  assertCondition(
    (received as JavaProjectCommandRequest | null)?.project.files.some((file) => file.path === 'Helper.java') === true,
    'browser java runner should include referenced helper sources in project requests'
  );
  assertCondition(
    events
      .filter((event) => event.type === 'output' && event.stream === 'stdout')
      .map((event) => (event as OutputEvent).data)
      .join('') === result.stdout,
    `browser java runner should stream missing final stdout suffix after streamed stdout events: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'java-live.txt'
    ),
    `browser java runner should forward worker live file-change events: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'java-live-dir' &&
      looseChange(event.change).directory === true
    ),
    `browser java runner should forward worker live directory-change events: ${JSON.stringify(events)}`
  );
  assertCondition(
    fileChangeObservedAfterApply && directoryChangeObservedAfterApply,
    `browser java runner should apply live changes before forwarding them: ${JSON.stringify({ appliedChanges, events })}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'final-diff' &&
      event.change.path === 'java-generated.txt'
    ),
    `browser java runner should forward worker final-diff file-change events: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.filter((event) => event.type === 'file-change' && event.change.path === 'java-live.txt').length === 1,
    `browser java runner should not return already-applied live file changes as final diffs: ${JSON.stringify(events)}`
  );
  assertCondition(
    result.files?.length === 1 && result.files[0]?.path === 'java-returned.txt',
    `browser java runner should only return unapplied final files: ${JSON.stringify(result.files)}`
  );

  const previewEvents: RuntimeCommandEvent[] = [];
  const previewResult = await runner({
    code: '',
    source: 'run',
    scriptPath: 'Main',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      files: [{ path: 'Main.java', contents: 'class Main {}\n' }],
    },
    options: { enablePreview: true },
    onEvent: (event) => previewEvents.push(event),
  });
  assertCondition(
    previewResult.exitCode !== 0 &&
      previewResult.stderr.includes('--enable-preview is not supported by this runtime'),
    `browser java runner should reject preview mode locally: ${previewResult.stderr}`
  );
  const previewStderrIndex = previewEvents.findIndex(
    (event) => event.type === 'output' && event.stream === 'stderr' && event.data === previewResult.stderr
  );
  const previewExitIndex = previewEvents.findIndex(
    (event) => event.type === 'status' && event.phase === 'process-exit' && event.detail?.exitCode === 2
  );
  assertCondition(
    previewEvents.some((event) => event.type === 'status' && event.phase === 'process-start') &&
      previewStderrIndex >= 0 &&
      previewExitIndex > previewStderrIndex,
    `browser java preview rejection should stream stderr before process-exit: ${JSON.stringify(previewEvents)}`
  );
  assertCondition(callCount === 1, 'browser java runner should reject preview mode before invoking the worker');

  const assertionsEvents: RuntimeCommandEvent[] = [];
  const assertionsResult = await runner({
    code: '',
    source: 'run',
    scriptPath: 'Main',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      files: [{ path: 'Main.java', contents: 'class Main {}\n' }],
    },
    options: { enableAssertions: true },
    onEvent: (event) => assertionsEvents.push(event),
  });
  assertCondition(
    assertionsResult.exitCode !== 0 &&
      assertionsResult.stderr.includes('-ea is not supported by this runtime'),
    `browser java runner should reject assertions mode locally: ${assertionsResult.stderr}`
  );
  const assertionsStderrIndex = assertionsEvents.findIndex(
    (event) => event.type === 'output' && event.stream === 'stderr' && event.data === assertionsResult.stderr
  );
  const assertionsExitIndex = assertionsEvents.findIndex(
    (event) => event.type === 'status' && event.phase === 'process-exit' && event.detail?.exitCode === 2
  );
  assertCondition(
    assertionsEvents.some((event) => event.type === 'status' && event.phase === 'process-start') &&
      assertionsStderrIndex >= 0 &&
      assertionsExitIndex > assertionsStderrIndex,
    `browser java assertions rejection should stream stderr before process-exit: ${JSON.stringify(assertionsEvents)}`
  );
  assertCondition(callCount === 1, 'browser java runner should reject assertions mode before invoking the worker');
}

async function testPyodidePythonProjectRunnerAdapter(): Promise<void> {
  let received: PythonProjectCommandRequest | null = null;
  const events: RuntimeCommandEvent[] = [];
  const appliedChanges: string[] = [];
  let fileChangeObservedAfterApply = false;
  const client = {
    async executeProjectPython(request, _timeoutMs, onEvent) {
      received = request;
      onEvent?.({ type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'streamed\n' });
      onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'py-live.txt', contents: 'live\n' } });
      return {
        stdout: `streamed\n${request.scriptPath}:${request.project.files.length}`,
        stderr: '',
        exitCode: 0,
      };
    },
  } satisfies {
    executeProjectPython(
      request: PythonProjectCommandRequest,
      timeoutMs?: number,
      onEvent?: (event: RuntimeCommandEvent) => void
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>
  };
  const runner = createBrowserPythonProjectRunner(client, {
    applyFileChange: async (change) => {
      appliedChanges.push(change.path);
    },
  });

  const result = await runner({
    code: 'print("hello")',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      files: [
        { path: 'main.py', contents: 'from helper import value\nprint(value())\n' },
        { path: 'helper.py', contents: 'def value():\n    return 5\n' },
      ],
    },
    onEvent: (event) => {
      if (event.type === 'file-change' && event.change.path === 'py-live.txt') {
        fileChangeObservedAfterApply = appliedChanges.includes('py-live.txt');
      }
      events.push(event);
    },
  });

  assertCondition(result.stdout === 'streamed\nmain.py:2', 'pyodide runner should delegate full project snapshot to worker client');
  assertCondition((received as PythonProjectCommandRequest | null)?.scriptPath === 'main.py', 'pyodide runner should pass through request');
  assertCondition(
    (received as PythonProjectCommandRequest | null)?.project.files.some((file) => file.path === 'helper.py') === true,
    'pyodide runner should include imported helper files in project requests'
  );
  assertCondition(
    events
      .filter((event) => event.type === 'output' && event.stream === 'stdout')
      .map((event) => (event as OutputEvent).data)
      .join('') === result.stdout,
    `pyodide runner should stream missing final stdout suffix after streamed stdout events: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'py-live.txt'
    ),
    `pyodide runner should forward worker live file-change events: ${JSON.stringify(events)}`
  );
  assertCondition(
    fileChangeObservedAfterApply,
    `pyodide runner should apply live file-change before forwarding it: ${JSON.stringify({ appliedChanges, events })}`
  );
  assertCondition(
    createPyodidePythonProjectRunner(client) !== runner,
    'pyodide python project runner alias should remain available'
  );

  const rejectedEvents: RuntimeCommandEvent[] = [];
  const rejectedRunner = createBrowserPythonProjectRunner({
    async executeProjectPython() {
      throw new Error('py-worker-disconnected');
    },
  }, {
    applyFileChange: async () => undefined,
  });
  const rejectedResult = await rejectedRunner({
    code: 'print("hello")',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      files: [{ path: 'main.py', contents: 'print("hello")\n' }],
    },
    onEvent: (event) => rejectedEvents.push(event),
  });
  assertCondition(
    rejectedResult.exitCode === 137 &&
      rejectedResult.stderr === '' &&
      rejectedResult.error?.code === 'EIO' &&
      rejectedResult.error.detail?.diagnostic === 'py-worker-disconnected',
    `pyodide runner should keep worker diagnostics out of terminal stderr: ${JSON.stringify(rejectedResult)}`
  );
  assertCondition(
    rejectedEvents.some((event) => event.type === 'status' && event.phase === 'process-start') &&
      rejectedEvents.some((event) =>
        event.type === 'status' &&
          event.phase === 'process-exit' &&
          event.detail?.exitCode === 137 &&
          event.detail?.diagnostic === 'py-worker-disconnected'
      ) &&
      !rejectedEvents.some((event) => event.type === 'output' && event.stream === 'stderr'),
    `pyodide runner should report worker diagnostics through status metadata only: ${JSON.stringify(rejectedEvents)}`
  );

  const failedApplyEvents: RuntimeCommandEvent[] = [];
  const failedApplyRunner = createBrowserPythonProjectRunner({
    async executeProjectPython(_request, _timeoutMs, onEvent) {
      onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'bad-live.txt', contents: 'bad\n' } });
      return { stdout: 'after-bad-live\n', stderr: '', exitCode: 0 };
    },
  }, {
    applyFileChange: async (change) => {
      throw new Error(`reject-live:${change.path}`);
    },
  });
  const failedApplyResult = await failedApplyRunner({
    code: 'print("hello")',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      files: [{ path: 'main.py', contents: 'print("hello")\n' }],
    },
    onEvent: (event) => failedApplyEvents.push(event),
  });
  assertCondition(
    failedApplyResult.exitCode === 137 &&
      failedApplyResult.stderr === '' &&
      failedApplyResult.error?.code === 'EIO' &&
      failedApplyResult.error.detail?.diagnostic === 'reject-live:bad-live.txt',
    `pyodide runner should keep live-apply diagnostics out of terminal stderr: ${JSON.stringify(failedApplyResult)}`
  );
  assertCondition(
    failedApplyEvents.some((event) =>
      event.type === 'status' &&
        event.phase === 'process-exit' &&
        event.detail?.exitCode === 137 &&
        event.detail?.diagnostic === 'reject-live:bad-live.txt'
    ) &&
      !failedApplyEvents.some((event) => event.type === 'output' && event.stream === 'stderr') &&
      !failedApplyEvents.some((event) => event.type === 'output' && event.data.includes('after-bad-live')),
    `pyodide runner should stop later output after live apply failures: ${JSON.stringify(failedApplyEvents)}`
  );
}

async function testBrowserCSharpProjectRunnerAdapter(): Promise<void> {
  let received: CSharpProjectCommandRequest | null = null;
  const events: RuntimeCommandEvent[] = [];
  const appliedChanges: string[] = [];
  let fileChangeObservedAfterApply = false;
  let directoryChangeObservedAfterApply = false;
  const runner = createBrowserCSharpProjectRunner({
    async executeProjectCSharp(request, _timeoutMs, onEvent) {
      received = request;
      onEvent?.({ type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'csharp-streamed\n' });
      onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'csharp-live.txt', contents: 'live\n' } });
      onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'csharp-live-dir', directory: true } });
      onEvent?.({ type: 'file-change', phase: 'final-diff', change: { path: 'csharp-generated.txt', contents: 'generated\n' } });
      return {
        stdout: `csharp-streamed\n${request.source}:${request.scriptPath}:${request.args.join(',')}:${request.project.files.length}`,
        stderr: '',
        exitCode: 0,
      };
    },
  }, {
    applyFileChange: async (change) => {
      appliedChanges.push(change.path);
    },
  });

  const result = await runner({
    code: '',
    source: 'run',
    scriptPath: '<project>',
    args: ['alpha', 'beta'],
    cwd: '/workspace',
    env: {},
    project: {
      files: [
        { path: 'Program.cs', contents: 'Console.WriteLine(Helper.Value());\n' },
        { path: 'Helper.cs', contents: 'static class Helper { public static int Value() => 5; }\n' },
      ],
    },
    onEvent: (event) => {
      if (event.type === 'file-change' && event.change.path === 'csharp-live.txt') {
        fileChangeObservedAfterApply = appliedChanges.includes('csharp-live.txt');
      }
      if (event.type === 'file-change' && event.change.path === 'csharp-live-dir') {
        directoryChangeObservedAfterApply = appliedChanges.includes('csharp-live-dir');
      }
      events.push(event);
    },
  });

  assertCondition(result.stdout === 'csharp-streamed\nrun:<project>:alpha,beta:2', 'browser C# runner should delegate full project snapshot to worker client');
  assertCondition((received as CSharpProjectCommandRequest | null)?.scriptPath === '<project>', 'browser C# runner should pass through request');
  assertCondition(
    (received as CSharpProjectCommandRequest | null)?.project.files.some((file) => file.path === 'Helper.cs') === true,
    'browser C# runner should include sibling source files in project requests'
  );
  assertCondition(
    events
      .filter((event) => event.type === 'output' && event.stream === 'stdout')
      .map((event) => (event as OutputEvent).data)
      .join('') === result.stdout,
    `browser C# runner should stream missing final stdout suffix after streamed stdout events: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'csharp-live.txt'
    ),
    `browser C# runner should forward worker live file-change events: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'csharp-live-dir' &&
      looseChange(event.change).directory === true
    ),
    `browser C# runner should forward worker live directory-change events: ${JSON.stringify(events)}`
  );
  assertCondition(
    fileChangeObservedAfterApply && directoryChangeObservedAfterApply,
    `browser C# runner should apply live changes before forwarding them: ${JSON.stringify({ appliedChanges, events })}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'final-diff' &&
      event.change.path === 'csharp-generated.txt'
    ),
    `browser C# runner should forward worker final-diff file-change events: ${JSON.stringify(events)}`
  );

  const noBuildResult = await runner({
    code: '',
    source: 'run',
    scriptPath: '<project>',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      files: [{ path: 'Program.cs', contents: 'Console.WriteLine("hello");\n' }],
    },
    options: { noBuild: true },
  });
  assertCondition(
    noBuildResult.exitCode !== 0 && noBuildResult.stderr.includes('--no-build is not supported by this runtime'),
    `browser C# runner should reject no-build mode locally: ${noBuildResult.stderr}`
  );
  assertCondition((received as CSharpProjectCommandRequest | null)?.scriptPath === '<project>', 'browser C# no-build rejection should not invoke worker client');
}

async function testBrowserCppProjectRunnerAdapter(): Promise<void> {
  let received: CppProjectCommandRequest | null = null;
  const events: RuntimeCommandEvent[] = [];
  const appliedChanges: string[] = [];
  let fileChangeObservedAfterApply = false;
  let directoryChangeObservedAfterApply = false;
  const runner = createBrowserCppProjectRunner({
    async executeProjectCpp(request, _timeoutMs, onEvent) {
      received = request;
      onEvent?.({ type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'cpp-streamed\n' });
      onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'cpp-live.txt', contents: 'live\n' } });
      onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'cpp-live-dir', directory: true } });
      return {
        stdout: `cpp-streamed\n${request.source}:${request.scriptPath}:${request.args.join(',')}:${request.project.files.length}`,
        stderr: '',
        exitCode: 0,
      };
    },
  }, {
    applyFileChange: async (change) => {
      appliedChanges.push(change.path);
    },
  });

  const result = await runner({
    code: '',
    source: 'compile',
    scriptPath: 'main.cpp',
    args: ['main.cpp', 'helper.cpp', '-o', 'a.out'],
    cwd: '/workspace',
    env: {},
    project: {
      files: [
        { path: 'main.cpp', contents: '#include "helper.hpp"\nint main() { return value(); }\n' },
        { path: 'helper.cpp', contents: '#include "helper.hpp"\nint value() { return 0; }\n' },
        { path: 'helper.hpp', contents: 'int value();\n' },
      ],
    },
    onEvent: (event) => {
      if (event.type === 'file-change' && event.change.path === 'cpp-live.txt') {
        fileChangeObservedAfterApply = appliedChanges.includes('cpp-live.txt');
      }
      if (event.type === 'file-change' && event.change.path === 'cpp-live-dir') {
        directoryChangeObservedAfterApply = appliedChanges.includes('cpp-live-dir');
      }
      events.push(event);
    },
  });

  assertCondition(result.stdout === 'cpp-streamed\ncompile:main.cpp:main.cpp,helper.cpp,-o,a.out:3', 'browser C++ runner should delegate full project snapshot to worker client');
  assertCondition((received as CppProjectCommandRequest | null)?.scriptPath === 'main.cpp', 'browser C++ runner should pass through request');
  assertCondition(
    (received as CppProjectCommandRequest | null)?.project.files.some((file) => file.path === 'helper.cpp') === true &&
      (received as CppProjectCommandRequest | null)?.project.files.some((file) => file.path === 'helper.hpp') === true,
    'browser C++ runner should include linked source and header files in project requests'
  );
  assertCondition(
    events
      .filter((event) => event.type === 'output' && event.stream === 'stdout')
      .map((event) => (event as OutputEvent).data)
      .join('') === result.stdout,
    `browser C++ runner should stream missing final stdout suffix after streamed stdout events: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'cpp-live.txt'
    ),
    `browser C++ runner should forward worker live file-change events: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'cpp-live-dir' &&
      looseChange(event.change).directory === true
    ),
    `browser C++ runner should forward worker live directory-change events: ${JSON.stringify(events)}`
  );
  assertCondition(
    fileChangeObservedAfterApply && directoryChangeObservedAfterApply,
    `browser C++ runner should apply live changes before forwarding them: ${JSON.stringify({ appliedChanges, events })}`
  );
}

async function testBrowserProjectWorkspaceFactory(): Promise<void> {
  const dynamicEvalDisabledWorkspace = await createBrowserProjectWorkspace({
    files: [{ path: 'index.js', contents: 'console.log("node")\n' }],
    nodeProject: { allowDynamicEval: false, allowMainThreadExecution: true, trustedMainThreadExecution: true },
    pythonWorkerClient: {
      async executeProjectPython() {
        throw new Error('unexpected Python runner call');
      },
      terminate() {},
    },
    javaWorkerClient: {
      async executeProjectJava() {
        throw new Error('unexpected Java runner call');
      },
      terminate() {},
    },
    csharpWorkerClient: {
      async executeProjectCSharp() {
        throw new Error('unexpected C# runner call');
      },
      terminate() {},
    },
    cppWorkerClient: {
      async executeProjectCpp() {
        throw new Error('unexpected C++ runner call');
      },
      terminate() {},
    },
  });
  try {
    const dynamicEvalDisabled = await dynamicEvalDisabledWorkspace.runCommand('node index.js');
    assertCondition(
      dynamicEvalDisabled.exitCode === 126 &&
        dynamicEvalDisabled.stderr === 'node: JavaScript runtime is unavailable\n',
      `browser project workspace should pass nodeProject options to the JS runner: ${dynamicEvalDisabled.stderr}`
    );
  } finally {
    dynamicEvalDisabledWorkspace.dispose();
  }

  const nodeTimeoutWorkspace = await createBrowserProjectWorkspace({
    files: [],
    nodeProject: { allowMainThreadExecution: true, trustedMainThreadExecution: true },
    nodeProjectTimeoutMs: 5,
    pythonWorkerClient: {
      async executeProjectPython() {
        throw new Error('unexpected Python runner call');
      },
      terminate() {},
    },
    javaWorkerClient: {
      async executeProjectJava() {
        throw new Error('unexpected Java runner call');
      },
      terminate() {},
    },
    csharpWorkerClient: {
      async executeProjectCSharp() {
        throw new Error('unexpected C# runner call');
      },
      terminate() {},
    },
    cppWorkerClient: {
      async executeProjectCpp() {
        throw new Error('unexpected C++ runner call');
      },
      terminate() {},
    },
  });
  try {
    const timeoutEvents: RuntimeCommandEvent[] = [];
    const timeout = await nodeTimeoutWorkspace.runCommand(
      'node -e "await new Promise((resolve) => setTimeout(resolve, 25)); const fs = require(\\"node:fs\\"); fs.writeFileSync(\\"late.txt\\", \\"late\\\\n\\"); console.log(\\"late\\")"',
      { onEvent: (event) => timeoutEvents.push(event) }
    );
    assertCondition(
      timeout.exitCode === 124 && timeout.stderr.includes('node: execution timed out after 5ms'),
      `browser project workspace should pass nodeProjectTimeoutMs to the JS runner: ${JSON.stringify(timeout)}`
    );
    await new Promise((resolve) => setTimeout(resolve, 35));
    assertCondition(!(await nodeTimeoutWorkspace.exists('late.txt')), 'browser Node timeout should suppress late filesystem mutations');
    assertCondition(
      timeoutEvents.some((event) => event.type === 'status' && event.phase === 'process-start') &&
        timeoutEvents.some((event) => event.type === 'status' && event.phase === 'process-exit' && event.detail?.exitCode === 124) &&
        !timeoutEvents.some((event) => event.type === 'output' && event.data.includes('late')) &&
        !timeoutEvents.some((event) => event.type === 'file-change' && event.change.path === 'late.txt'),
      `browser Node timeout should emit timeout status and suppress late runtime events: ${JSON.stringify(timeoutEvents)}`
    );
  } finally {
    nodeTimeoutWorkspace.dispose();
  }

  const storageEvents: string[] = [];
  const storageWorkspace = await createBrowserProjectWorkspace({
    files: [{ path: 'persisted.txt', contents: 'persisted\n' }],
    kernelStorage: {
      async load() {
        return null;
      },
      async save(snapshot) {
        storageEvents.push(`save:${snapshot.files.length}`);
      },
      async clear() {
        storageEvents.push('clear');
      },
      async flush() {
        storageEvents.push('flush');
      },
    },
    pythonWorkerClient: {
      async executeProjectPython() {
        throw new Error('unexpected Python runner call');
      },
      terminate() {},
    },
    javaWorkerClient: {
      async executeProjectJava() {
        throw new Error('unexpected Java runner call');
      },
      terminate() {},
    },
    csharpWorkerClient: {
      async executeProjectCSharp() {
        throw new Error('unexpected C# runner call');
      },
      terminate() {},
    },
    cppWorkerClient: {
      async executeProjectCpp() {
        throw new Error('unexpected C++ runner call');
      },
      terminate() {},
    },
  });
  await storageWorkspace.writeFile('persisted.txt', 'changed\n');
  await storageWorkspace.destroy({ reason: 'test', clearStorage: true });
  assertCondition(
    storageEvents.includes('clear') &&
      storageEvents.indexOf('clear') > storageEvents.findIndex((event) => event.startsWith('save:')),
    `browser project destroy should clear kernel storage after flushing pending writes: ${JSON.stringify(storageEvents)}`
  );
  await assertRejectsAsync(() => storageWorkspace.readFile('persisted.txt'), 'destroyed browser project workspace should reject reads');

  const resetStorageEvents: string[] = [];
  const resetStorageWorkspace = await createBrowserProjectWorkspace({
    files: [{ path: 'persisted.txt', contents: 'persisted\n' }],
    kernelStorage: {
      async load() {
        return null;
      },
      async save(snapshot) {
        resetStorageEvents.push(`save:${snapshot.files.length}`);
      },
      async clear() {
        resetStorageEvents.push('clear');
      },
      async flush() {
        resetStorageEvents.push('flush');
      },
    },
    pythonWorkerClient: {
      async executeProjectPython() {
        throw new Error('unexpected Python runner call');
      },
      terminate() {},
    },
    javaWorkerClient: {
      async executeProjectJava() {
        throw new Error('unexpected Java runner call');
      },
      terminate() {},
    },
    csharpWorkerClient: {
      async executeProjectCSharp() {
        throw new Error('unexpected C# runner call');
      },
      terminate() {},
    },
    cppWorkerClient: {
      async executeProjectCpp() {
        throw new Error('unexpected C++ runner call');
      },
      terminate() {},
    },
  });
  await resetStorageWorkspace.writeFile('persisted.txt', 'changed\n');
  const resetStorageResult = await resetStorageWorkspace.runCommand('tracekernelctl reset');
  assertCondition(
    resetStorageResult.exitCode === 0 &&
      resetStorageResult.stdout === 'tracekernelctl: reset complete\n' &&
      resetStorageEvents.includes('clear') &&
      resetStorageEvents.indexOf('clear') > resetStorageEvents.findIndex((event) => event.startsWith('save:')),
    `tracekernelctl reset should clear browser kernel storage after flushing pending writes: ${JSON.stringify({ resetStorageResult, resetStorageEvents })}`
  );
  await assertRejectsAsync(() => resetStorageWorkspace.readFile('persisted.txt'), 'tracekernelctl reset should destroy browser project workspace');

  assertRejects(
    () => createIndexedDbKernelStorage({
      key: 'workspace',
      databaseName: 'tracecode-kernel-test',
      storeName: 'workspaces',
    } as Parameters<typeof createIndexedDbKernelStorage>[0]),
    'IndexedDB kernel storage should require an explicit trusted same-origin persistence opt-in'
  );
  assertRejects(
    () => createIndexedDbKernelStorage({
      key: 'workspace',
      databaseName: 'tracecode-kernel-test',
      storeName: 'workspaces',
      trustedSameOriginPersistence: true,
    } as Parameters<typeof createIndexedDbKernelStorage>[0]),
    'IndexedDB kernel storage should require an encryption key for persisted workspace snapshots'
  );
  assertRejects(
    () => createIndexedDbKernelStorage({
      key: 'workspace',
      databaseName: ' ',
      storeName: 'workspaces',
      trustedSameOriginPersistence: true,
      encryptionKey: {} as CryptoKey,
    }),
    'IndexedDB kernel storage should require an explicit non-empty database name'
  );
  const malformedStoredSnapshots = [
    {
      label: 'unsafe file paths',
      snapshot: { files: [{ path: '../escape.js', contents: 'escape\n' }] },
    },
    {
      label: 'duplicate directory paths',
      snapshot: { files: [], directories: ['src', 'src'] },
    },
    {
      label: 'orphan directory metadata',
      snapshot: { files: [], directories: ['src'], directoryMetadata: [{ path: 'missing', mode: 0o700 }] },
    },
    {
      label: 'file and directory path conflicts',
      snapshot: { files: [{ path: 'src', contents: 'file\n' }], directories: ['src'] },
    },
  ];
  for (const malformed of malformedStoredSnapshots) {
    await assertRejectsAsync(
      () => createBrowserProjectWorkspace({
        kernelStorage: {
          async load() {
            return {
              version: 1,
              savedAt: new Date().toISOString(),
              snapshot: malformed.snapshot,
            };
          },
          async save() {},
          async flush() {},
        },
        ...throwingBrowserWorkerClients(),
      }),
      `browser kernel storage should reject ${malformed.label} before hydration`
    );
  }

  let pythonTimeoutMs: number | undefined;
  let javaTimeoutMs: number | undefined;
  let csharpTimeoutMs: number | undefined;
  const cppTimeouts: Array<number | undefined> = [];
  const pythonLiveReadPromises: Promise<string>[] = [];
  const nodeLiveReadPromises: Promise<string>[] = [];
  const javaLiveReadPromises: Promise<string>[] = [];
  const csharpLiveReadPromises: Promise<string>[] = [];
  const cppLiveReadPromises: Promise<string>[] = [];
  const pythonEvents: RuntimeCommandEvent[] = [];
  const nodeEvents: RuntimeCommandEvent[] = [];
  const javaEvents: RuntimeCommandEvent[] = [];
  const csharpEvents: RuntimeCommandEvent[] = [];
  const cppEvents: RuntimeCommandEvent[] = [];
  const workspace = await createBrowserProjectWorkspace({
    files: [
      { path: 'main.py', contents: 'print("python")\n' },
      { path: 'index.js', contents: 'const fs = require("node:fs"); fs.writeFileSync("node.txt", "node\\n");\n' },
      { path: 'Main.java', contents: 'class Main {}\n' },
      { path: 'Program.cs', contents: 'Console.WriteLine("csharp");\n' },
      { path: 'main.cpp', contents: 'int main() { return 0; }\n' },
    ],
    directories: ['empty/child'],
    pythonProjectTimeoutMs: 11,
    nodeProject: { allowMainThreadExecution: true, trustedMainThreadExecution: true },
    javaProjectTimeoutMs: 12,
    csharpProjectTimeoutMs: 13,
    cppProjectTimeoutMs: 14,
    pythonWorkerClient: {
      async executeProjectPython(request, timeoutMs, onEvent) {
        pythonTimeoutMs = timeoutMs;
        onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'python-live.txt', contents: 'python-live\n' } });
        return {
          stdout: `${request.source}:${request.scriptPath}:${request.project.files.length}:${request.project.directories?.length ?? 0}\n`,
          stderr: '',
          exitCode: 0,
          files: [{ path: 'python.txt', contents: 'python\n' }],
        };
      },
      terminate() {},
    },
    javaWorkerClient: {
      async executeProjectJava(request, timeoutMs, onEvent) {
        javaTimeoutMs = timeoutMs;
        onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'java-live.txt', contents: 'java-live\n' } });
        return {
          stdout: `${request.source}:${request.scriptPath}:${request.project.files.length}:${request.project.directories?.length ?? 0}\n`,
          stderr: '',
          exitCode: 0,
          files: [{ path: 'java.txt', contents: 'java\n' }],
        };
      },
      terminate() {},
    },
    csharpWorkerClient: {
      async executeProjectCSharp(request, timeoutMs, onEvent) {
        csharpTimeoutMs = timeoutMs;
        onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'csharp-live.txt', contents: 'csharp-live\n' } });
        return {
          stdout: `${request.source}:${request.scriptPath}:${request.args.join(',')}:${request.project.files.length}:${request.project.directories?.length ?? 0}\n`,
          stderr: '',
          exitCode: 0,
          files: [{ path: 'csharp.txt', contents: 'csharp\n' }],
        };
      },
      terminate() {},
    },
    cppWorkerClient: {
      async executeProjectCpp(request, timeoutMs, onEvent) {
        cppTimeouts.push(timeoutMs);
        if (request.source === 'compile') {
          onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'cpp-live.txt', contents: 'cpp-live\n' } });
        }
        return {
          stdout: `${request.source}:${request.scriptPath}:${request.args.join(',')}:${request.project.files.length}:${request.project.directories?.length ?? 0}\n`,
          stderr: '',
          exitCode: 0,
          files: [{ path: 'cpp.txt', contents: 'cpp\n' }],
        };
      },
      terminate() {},
    },
  });

  try {
    const python = await workspace.runCommand('python3 main.py', {
      onEvent: (event) => {
        pythonEvents.push(event);
        if (event.type === 'file-change' && event.phase === 'live' && event.change.path === 'python-live.txt') {
          pythonLiveReadPromises.push(workspace.readFile('python-live.txt'));
        }
      },
    });
    assertCondition(python.exitCode === 0, `browser project workspace python should succeed: ${python.stderr}`);
    assertCondition(python.stdout === 'file:main.py:5:2\n', `browser project workspace should wire Pyodide runner with directories: ${python.stdout}`);
    assertCondition(pythonTimeoutMs === 11, 'browser project workspace should pass pythonProjectTimeoutMs to the Python runner');
    assertCondition(await workspace.readFile('python.txt') === 'python\n', 'browser project workspace should apply Python file changes');
    assertCondition(await workspace.readFile('python-live.txt') === 'python-live\n', 'browser project workspace should apply Python live file changes');
    assertCondition(
      (await Promise.all(pythonLiveReadPromises)).includes('python-live\n'),
      'browser project workspace should apply Python live file changes before forwarding the event'
    );
    assertCondition(
      pythonLiveReadPromises.length === 1,
      `browser project workspace should not duplicate Python live file-change events: ${pythonLiveReadPromises.length}`
    );
    assertCondition(
      pythonEvents.some((event) =>
        event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change.path === 'python-live.txt' &&
          event.actor?.kind === 'runtime'
      ),
      `browser project workspace should attribute Python live worker changes to the active runtime actor: ${JSON.stringify(pythonEvents)}`
    );
    assertCondition((await workspace.readDir('empty')).join(',') === 'child', 'browser project workspace should preserve empty directories in snapshots');

    const node = await workspace.runCommand('node index.js', {
      onEvent: (event) => {
        nodeEvents.push(event);
        if (event.type === 'file-change' && event.change.path === 'node.txt') {
          if (event.phase === 'live') nodeLiveReadPromises.push(workspace.readFile('node.txt'));
        }
      },
    });
    assertCondition(node.exitCode === 0, `browser project workspace node should succeed: ${node.stderr}`);
    assertCondition(await workspace.readFile('node.txt') === 'node\n', 'browser project workspace should wire browser Node runner');
    assertCondition(
      (await Promise.all(nodeLiveReadPromises)).includes('node\n'),
      'browser project workspace should apply Node live file changes before forwarding the event'
    );
    assertCondition(
      nodeEvents.filter((event) => event.type === 'file-change' && event.change.path === 'node.txt').length === 1 &&
        nodeEvents.some((event) => event.type === 'file-change' && event.change.path === 'node.txt' && event.phase === 'live'),
      `browser project workspace should not re-emit Node live file changes as final-diff: ${JSON.stringify(nodeEvents)}`
    );
    assertCondition(
      nodeEvents.some((event) => event.type === 'status' && event.phase === 'process-start' && event.actor?.kind === 'runtime') &&
        nodeEvents.some((event) => event.type === 'status' && event.phase === 'process-exit' && event.actor?.kind === 'runtime'),
      `browser project workspace should emit Node process status events: ${JSON.stringify(nodeEvents)}`
    );

    const java = await workspace.runCommand('java Main', {
      onEvent: (event) => {
        javaEvents.push(event);
        if (event.type === 'file-change' && event.phase === 'live' && event.change.path === 'java-live.txt') {
          javaLiveReadPromises.push(workspace.readFile('java-live.txt'));
        }
      },
    });
    assertCondition(java.exitCode === 0, `browser project workspace java should succeed: ${java.stderr}`);
    assertCondition(java.stdout === 'run:Main:8:2\n', `browser project workspace should wire Java runner with directories: ${java.stdout}`);
    assertCondition(javaTimeoutMs === 12, 'browser project workspace should pass javaProjectTimeoutMs to the Java runner');
    assertCondition(await workspace.readFile('java.txt') === 'java\n', 'browser project workspace should apply Java file changes');
    assertCondition(await workspace.readFile('java-live.txt') === 'java-live\n', 'browser project workspace should apply Java live file changes');
    assertCondition(
      (await Promise.all(javaLiveReadPromises)).includes('java-live\n'),
      'browser project workspace should apply Java live file changes before forwarding the event'
    );
    assertCondition(
      javaEvents.filter((event) => event.type === 'file-change' && event.change.path === 'java-live.txt').length === 1,
      `browser project workspace should not duplicate Java live file-change events: ${JSON.stringify(javaEvents)}`
    );
    assertCondition(
      javaEvents.some((event) =>
        event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change.path === 'java-live.txt' &&
          event.actor?.kind === 'runtime'
      ),
      `browser project workspace should attribute Java live worker changes to the active runtime actor: ${JSON.stringify(javaEvents)}`
    );

    const csharp = await workspace.runCommand('dotnet run alpha beta', {
      onEvent: (event) => {
        csharpEvents.push(event);
        if (event.type === 'file-change' && event.phase === 'live' && event.change.path === 'csharp-live.txt') {
          csharpLiveReadPromises.push(workspace.readFile('csharp-live.txt'));
        }
      },
    });
    assertCondition(csharp.exitCode === 0, `browser project workspace C# should succeed: ${csharp.stderr}`);
    assertCondition(csharp.stdout === 'run:<project>:alpha,beta:10:2\n', `browser project workspace should wire C# runner with directories: ${csharp.stdout}`);
    assertCondition(csharpTimeoutMs === 13, 'browser project workspace should pass csharpProjectTimeoutMs to the C# runner');
    assertCondition(await workspace.readFile('csharp.txt') === 'csharp\n', 'browser project workspace should apply C# file changes');
    assertCondition(await workspace.readFile('csharp-live.txt') === 'csharp-live\n', 'browser project workspace should apply C# live file changes');
    assertCondition(
      (await Promise.all(csharpLiveReadPromises)).includes('csharp-live\n'),
      'browser project workspace should apply C# live file changes before forwarding the event'
    );
    assertCondition(
      csharpEvents.filter((event) => event.type === 'file-change' && event.change.path === 'csharp-live.txt').length === 1,
      `browser project workspace should not duplicate C# live file-change events: ${JSON.stringify(csharpEvents)}`
    );
    assertCondition(
      csharpEvents.some((event) =>
        event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change.path === 'csharp-live.txt' &&
          event.actor?.kind === 'runtime'
      ),
      `browser project workspace should attribute C# live worker changes to the active runtime actor: ${JSON.stringify(csharpEvents)}`
    );

    const cpp = await workspace.runCommand('clang++ main.cpp -o a.out', {
      onEvent: (event) => {
        cppEvents.push(event);
        if (event.type === 'file-change' && event.phase === 'live' && event.change.path === 'cpp-live.txt') {
          cppLiveReadPromises.push(workspace.readFile('cpp-live.txt'));
        }
      },
    });
    assertCondition(cpp.exitCode === 0, `browser project workspace C++ should succeed: ${cpp.stderr}`);
    assertCondition(cpp.stdout === 'compile:main.cpp:main.cpp,-o,a.out:12:2\n', `browser project workspace should wire C++ runner with directories: ${cpp.stdout}`);
    assertCondition(cppTimeouts[0] === 14, 'browser project workspace should pass cppProjectTimeoutMs to C++ compile runner calls');
    assertCondition(await workspace.readFile('cpp.txt') === 'cpp\n', 'browser project workspace should apply C++ file changes');
    assertCondition(await workspace.readFile('cpp-live.txt') === 'cpp-live\n', 'browser project workspace should apply C++ live file changes');
    assertCondition(
      (await Promise.all(cppLiveReadPromises)).includes('cpp-live\n'),
      'browser project workspace should apply C++ live file changes before forwarding the event'
    );
    assertCondition(
      cppEvents.filter((event) => event.type === 'file-change' && event.change.path === 'cpp-live.txt').length === 1,
      `browser project workspace should not duplicate C++ live file-change events: ${JSON.stringify(cppEvents)}`
    );
    assertCondition(
      cppEvents.some((event) =>
        event.type === 'file-change' &&
          event.phase === 'live' &&
          event.change.path === 'cpp-live.txt' &&
          event.actor?.kind === 'runtime'
      ),
      `browser project workspace should attribute C++ live worker changes to the active runtime actor: ${JSON.stringify(cppEvents)}`
    );

    const cppRunEvents: RuntimeCommandEvent[] = [];
    const cppRun = await workspace.runCommand('./a.out alpha beta', {
      onEvent: (event) => cppRunEvents.push(event),
    });
    assertCondition(cppRun.exitCode === 0, `browser project workspace C++ executable should run: ${cppRun.stderr}`);
    assertCondition(
      cppRun.stdout === 'run:a.out:alpha,beta:14:2\n',
      `browser project workspace should route direct C++ executable runs with directories: ${cppRun.stdout}`
    );
    assertCondition(
      cppRunEvents.some((event) =>
        event.type === 'output' &&
        event.stream === 'stdout' &&
        event.device === '/dev/stdout' &&
        event.data === 'run:a.out:alpha,beta:14:2\n'
      ),
      `browser project workspace should emit final stdout events for direct C++ executable runs: ${JSON.stringify(cppRunEvents)}`
    );
    assertCondition(cppTimeouts[1] === 14, 'browser project workspace should pass cppProjectTimeoutMs to C++ run runner calls');
  } finally {
    workspace.dispose();
  }
}

async function testBrowserProjectWorkspaceCrossRunnerFilesystemVisibility(): Promise<void> {
  let releaseHeldPython!: () => void;
  const heldPythonReleased = new Promise<void>((resolve) => {
    releaseHeldPython = resolve;
  });
  let heldPythonStarted!: () => void;
  const heldPythonStartedPromise = new Promise<void>((resolve) => {
    heldPythonStarted = resolve;
  });
  let heldPythonInitialContents: string | undefined;
  let heldPythonContentsAfterJavaWrite: string | undefined;
  let laterCSharpContents: string | undefined;

  const workspace = await createBrowserProjectWorkspace({
    files: [
      { path: 'reader.py', contents: 'print("reader")\n' },
      { path: 'Writer.java', contents: 'class Writer {}\n' },
      { path: 'Program.cs', contents: 'Console.WriteLine("observer");\n' },
    ],
    ...throwingBrowserWorkerClients(),
    pythonWorkerClient: {
      async executeProjectPython(request) {
        heldPythonInitialContents = request.project.files.find((file) => file.path === 'shared.txt')?.contents;
        heldPythonStarted();
        await heldPythonReleased;
        heldPythonContentsAfterJavaWrite = request.project.files.find((file) => file.path === 'shared.txt')?.contents;
        return {
          stdout: `${heldPythonInitialContents ?? 'missing'}:${heldPythonContentsAfterJavaWrite ?? 'missing'}\n`,
          stderr: '',
          exitCode: 0,
        };
      },
      terminate() {},
    },
    javaWorkerClient: {
      async executeProjectJava(_request, _timeoutMs, onEvent) {
        onEvent?.({
          type: 'file-change',
          phase: 'live',
          change: { path: 'shared.txt', contents: 'written-by-java\n' },
        });
        return { stdout: 'writer:done\n', stderr: '', exitCode: 0 };
      },
      terminate() {},
    },
    csharpWorkerClient: {
      async executeProjectCSharp(request) {
        laterCSharpContents = request.project.files.find((file) => file.path === 'shared.txt')?.contents;
        return { stdout: laterCSharpContents ?? 'missing', stderr: '', exitCode: 0 };
      },
      terminate() {},
    },
  });

  try {
    const heldPython = workspace.runCommand('python3 reader.py');
    await heldPythonStartedPromise;

    const javaWriter = await workspace.runCommand('java Writer');
    assertCondition(
      javaWriter.exitCode === 0 && await workspace.readFile('shared.txt') === 'written-by-java\n',
      `a live write from Java should reach the authoritative workspace before the command completes: ${JSON.stringify(javaWriter)}`
    );

    releaseHeldPython();
    const heldPythonResult = await heldPython;
    assertCondition(
      heldPythonResult.exitCode === 0 &&
        heldPythonInitialContents === undefined &&
        heldPythonContentsAfterJavaWrite === undefined,
      `an already-running provider should retain its point-in-time command snapshot: ${JSON.stringify({
        heldPythonResult,
        heldPythonInitialContents,
        heldPythonContentsAfterJavaWrite,
      })}`
    );

    const laterCSharp = await workspace.runCommand('dotnet run');
    assertCondition(
      laterCSharp.exitCode === 0 && laterCSharpContents === 'written-by-java\n',
      `a provider started after another provider's live write should receive the updated workspace snapshot: ${JSON.stringify({
        laterCSharp,
        laterCSharpContents,
      })}`
    );
  } finally {
    releaseHeldPython();
    workspace.dispose();
  }

  let releaseConcurrentWriters!: () => void;
  const concurrentWritersReleased = new Promise<void>((resolve) => {
    releaseConcurrentWriters = resolve;
  });
  let bothConcurrentWritersStarted!: () => void;
  const bothConcurrentWritersStartedPromise = new Promise<void>((resolve) => {
    bothConcurrentWritersStarted = resolve;
  });
  const concurrentWritersStarted = new Set<string>();
  const markConcurrentWriterStarted = (runtime: string): void => {
    concurrentWritersStarted.add(runtime);
    if (concurrentWritersStarted.size === 2) bothConcurrentWritersStarted();
  };

  const concurrentWorkspace = await createBrowserProjectWorkspace({
    files: [
      { path: 'writer.py', contents: 'print("python")\n' },
      { path: 'Writer.java', contents: 'class Writer {}\n' },
    ],
    ...throwingBrowserWorkerClients(),
    pythonWorkerClient: {
      async executeProjectPython(_request, _timeoutMs, onEvent) {
        markConcurrentWriterStarted('python');
        await concurrentWritersReleased;
        onEvent?.({
          type: 'file-change',
          phase: 'live',
          change: { path: 'python-output.txt', contents: 'python\n' },
        });
        return { stdout: 'python:done\n', stderr: '', exitCode: 0 };
      },
      terminate() {},
    },
    javaWorkerClient: {
      async executeProjectJava(_request, _timeoutMs, onEvent) {
        markConcurrentWriterStarted('java');
        await concurrentWritersReleased;
        onEvent?.({
          type: 'file-change',
          phase: 'live',
          change: { path: 'java-output.txt', contents: 'java\n' },
        });
        return { stdout: 'java:done\n', stderr: '', exitCode: 0 };
      },
      terminate() {},
    },
  });

  try {
    const pythonWriter = concurrentWorkspace.runCommand('python3 writer.py');
    const javaWriter = concurrentWorkspace.runCommand('java Writer');
    await bothConcurrentWritersStartedPromise;
    releaseConcurrentWriters();
    const [pythonResult, javaResult] = await Promise.all([pythonWriter, javaWriter]);

    assertCondition(
      pythonResult.exitCode === 0 &&
        javaResult.exitCode === 0 &&
        await concurrentWorkspace.readFile('python-output.txt') === 'python\n' &&
        await concurrentWorkspace.readFile('java-output.txt') === 'java\n',
      `parallel providers should commit independent live writes into one authoritative workspace: ${JSON.stringify({
        pythonResult,
        javaResult,
      })}`
    );
  } finally {
    releaseConcurrentWriters();
    concurrentWorkspace.dispose();
  }

  let releaseConflictingWriters!: () => void;
  const conflictingWritersReleased = new Promise<void>((resolve) => {
    releaseConflictingWriters = resolve;
  });
  let bothConflictingWritersStarted!: () => void;
  const bothConflictingWritersStartedPromise = new Promise<void>((resolve) => {
    bothConflictingWritersStarted = resolve;
  });
  const conflictingWritersStarted = new Set<string>();
  const markConflictingWriterStarted = (runtime: string): void => {
    conflictingWritersStarted.add(runtime);
    if (conflictingWritersStarted.size === 2) bothConflictingWritersStarted();
  };

  const conflictingWorkspace = await createBrowserProjectWorkspace({
    files: [
      { path: 'writer.py', contents: 'print("python")\n' },
      { path: 'Writer.java', contents: 'class Writer {}\n' },
    ],
    ...throwingBrowserWorkerClients(),
    pythonWorkerClient: {
      async executeProjectPython(_request, _timeoutMs, onEvent) {
        markConflictingWriterStarted('python');
        await conflictingWritersReleased;
        onEvent?.({
          type: 'file-change',
          phase: 'live',
          change: { path: 'shared-output.txt', contents: 'python\n' },
        });
        return { stdout: 'python:done\n', stderr: '', exitCode: 0 };
      },
      terminate() {},
    },
    javaWorkerClient: {
      async executeProjectJava(_request, _timeoutMs, onEvent) {
        markConflictingWriterStarted('java');
        await conflictingWritersReleased;
        onEvent?.({
          type: 'file-change',
          phase: 'live',
          change: { path: 'shared-output.txt', contents: 'java\n' },
        });
        return { stdout: 'java:done\n', stderr: '', exitCode: 0 };
      },
      terminate() {},
    },
  });

  try {
    const pythonWriter = conflictingWorkspace.runCommand('python3 writer.py');
    const javaWriter = conflictingWorkspace.runCommand('java Writer');
    await bothConflictingWritersStartedPromise;
    releaseConflictingWriters();
    const results = await Promise.all([pythonWriter, javaWriter]);
    const successes = results.filter((result) => result.exitCode === 0);
    const staleFailures = results.filter((result) => result.error?.code === 'ESTALE');
    const finalContents = await conflictingWorkspace.readFile('shared-output.txt');

    assertCondition(
      successes.length === 1 &&
        staleFailures.length === 1 &&
        (finalContents === 'python\n' || finalContents === 'java\n'),
      `parallel providers writing the same path should produce one complete winner and one ESTALE conflict: ${JSON.stringify({
        results,
        finalContents,
      })}`
    );
  } finally {
    releaseConflictingWriters();
    conflictingWorkspace.dispose();
  }
}

async function testBrowserKernelStorageRehydrationPreservesReadonlyPolicy(): Promise<void> {
  const workspace = await createBrowserProjectWorkspace({
    projectSession: {
      id: 'readonly-rehydrate-test',
      files: [
        { path: 'locked.txt', contents: 'locked\n', readonly: true },
        { path: 'secret.txt', contents: 'secret\n', hidden: true },
        { path: 'scratch.txt', contents: 'scratch\n' },
      ],
    },
    kernelStorage: {
      async load() {
        return {
          version: 1,
          savedAt: new Date().toISOString(),
          snapshot: {
            files: [{ path: 'locked.txt', contents: 'locked\n' }],
          },
        };
      },
      async save() {},
      async flush() {},
    },
    pythonWorkerClient: {
      async executeProjectPython() {
        throw new Error('unexpected Python runner call');
      },
      terminate() {},
    },
    javaWorkerClient: {
      async executeProjectJava() {
        throw new Error('unexpected Java runner call');
      },
      terminate() {},
    },
    csharpWorkerClient: {
      async executeProjectCSharp() {
        throw new Error('unexpected C# runner call');
      },
      terminate() {},
    },
    cppWorkerClient: {
      async executeProjectCpp() {
        throw new Error('unexpected C++ runner call');
      },
      terminate() {},
    },
  });

  try {
    assertCondition(workspace.isReadOnly('locked.txt') === true, 'rehydrated readonly session file should preserve readonly policy');
    let writeError: unknown;
    try {
      await workspace.writeFile('locked.txt', 'pwned\n');
    } catch (error) {
      writeError = error;
    }
    assertCondition(
      (writeError as { code?: unknown } | undefined)?.code === 'EROFS',
      `workspace.writeFile should reject readonly rehydrated session files with EROFS: ${String(writeError)}`
    );

    const overwrite = await workspace.runCommand('echo pwned > locked.txt');
    assertCondition(
      overwrite.exitCode !== 0,
      `shell redirection should fail against readonly rehydrated session files: ${JSON.stringify(overwrite)}`
    );
    assertCondition(await workspace.readFile('locked.txt') === 'locked\n', 'readonly rehydrated session file contents should survive failed overwrite');

    const remove = await workspace.runCommand('rm locked.txt');
    assertCondition(
      remove.exitCode !== 0,
      `shell rm should fail against readonly rehydrated session files: ${JSON.stringify(remove)}`
    );
    assertCondition(await workspace.exists('locked.txt'), 'readonly rehydrated session file should survive failed rm');
    assertCondition(await workspace.readFile('locked.txt') === 'locked\n', 'readonly rehydrated session file contents should survive failed rm');

    assertCondition(!(await workspace.exists('scratch.txt')), 'stored workspace rehydration should not resurrect deleted editable session files');

    const snapshot = await workspace.snapshot();
    assertCondition(
      !snapshot.files.some((file) => file.path === 'secret.txt'),
      `hidden session files should remain absent from visible snapshots after rehydration: ${JSON.stringify(snapshot)}`
    );
    assertCondition(workspace.isReadOnly('secret.txt') === true, 'hidden session files should remain readonly after rehydration');
  } finally {
    workspace.dispose();
  }
}

async function testBrowserKernelStorageCoalescesPersistence(): Promise<void> {
  const savedSnapshots: TestRuntimeProjectSnapshot[] = [];
  const workspace = await createBrowserProjectWorkspace({
    files: [],
    kernelStorage: {
      async load() {
        return null;
      },
      async save(snapshot) {
        savedSnapshots.push(cloneProjectSnapshot(snapshot));
      },
      async clear() {},
      async flush() {},
    },
    ...throwingBrowserWorkerClients(),
  });
  try {
    const files = Array.from({ length: 20 }, (_, index) => ({
      path: `coalesced-${index}.txt`,
      contents: `coalesced ${index}\n`,
    }));
    await workspace.writeFiles(files);
    await new Promise((resolve) => setTimeout(resolve, 600));

    assertCondition(
      savedSnapshots.length <= 3,
      `browser kernel storage should coalesce tight file-change bursts: ${savedSnapshots.length} saves`
    );
    const lastSnapshot = savedSnapshots[savedSnapshots.length - 1];
    if (!lastSnapshot) {
      throw new Error('browser kernel storage should save at least one snapshot');
    }
    for (const file of files) {
      assertCondition(
        lastSnapshot.files.some((savedFile) => savedFile.path === file.path && savedFile.contents === file.contents),
        `browser kernel storage last snapshot should include ${file.path}: ${JSON.stringify(lastSnapshot.files)}`
      );
    }
  } finally {
    await workspace.destroy({ reason: 'test' });
  }
}

async function testBrowserKernelStorageFlushPersistsDirtyState(): Promise<void> {
  const storageEvents: string[] = [];
  const workspace = await createBrowserProjectWorkspace({
    files: [],
    kernelStorage: {
      async load() {
        return null;
      },
      async save(snapshot) {
        const savedDirtyFile = snapshot.files.some((file) =>
          file.path === 'dirty.txt' && file.contents === 'dirty\n'
        );
        storageEvents.push(savedDirtyFile ? 'save:dirty' : `save:${snapshot.files.length}`);
      },
      async clear() {
        storageEvents.push('clear');
      },
      async flush() {
        storageEvents.push('flush');
      },
    },
    ...throwingBrowserWorkerClients(),
  });

  await workspace.writeFile('dirty.txt', 'dirty\n');
  await workspace.destroy({ reason: 'test', clearStorage: true });

  const dirtySaveIndex = storageEvents.indexOf('save:dirty');
  const clearIndex = storageEvents.indexOf('clear');
  assertCondition(
    dirtySaveIndex >= 0 && clearIndex > dirtySaveIndex,
    `browser kernel storage destroy should flush dirty state before clearing storage: ${JSON.stringify(storageEvents)}`
  );
}

async function testBrowserKernelStorageTreatsEmptySnapshotAsAuthoritative(): Promise<void> {
  const workspace = await createBrowserProjectWorkspace({
    projectSession: {
      id: 'empty-storage-authority',
      files: [{ path: 'seed.txt', contents: 'must-not-resurrect\n' }],
    },
    kernelStorage: {
      async load() {
        return {
          version: 1,
          savedAt: new Date().toISOString(),
          snapshot: { files: [], directories: [] },
        };
      },
      async save() {},
      async flush() {},
    },
    ...throwingBrowserWorkerClients(),
  });
  try {
    assertCondition(
      !(await workspace.exists('seed.txt')) && (await workspace.snapshot()).files.length === 0,
      'an empty stored workspace must not resurrect editable project-session seed files'
    );
  } finally {
    await workspace.destroy({ reason: 'test' });
  }
}

async function testBrowserKernelStoragePersistsUnstreamedFilesystemMutations(): Promise<void> {
  let latestFiles = new Map<string, number>();
  const workspace = await createBrowserProjectWorkspace({
    files: [{ path: 'chunk.txt', contents: 'x'.repeat(1024 * 1024) }],
    kernelStorage: {
      async load() {
        return null;
      },
      async save(snapshot) {
        latestFiles = new Map(snapshot.files.map((file) => [file.path, file.contents.length]));
      },
      async flush() {},
    },
    ...throwingBrowserWorkerClients(),
  });
  const result = await workspace.runCommand('cat chunk.txt chunk.txt chunk.txt chunk.txt chunk.txt > too-large.txt');
  assertCondition(result.exitCode === 0, `oversized shell mutation should succeed: ${JSON.stringify(result)}`);
  await workspace.destroy({ reason: 'test' });
  assertCondition(
    latestFiles.get('too-large.txt') === 5 * 1024 * 1024,
    `storage mutation watcher must persist writes whose public file-change payload is suppressed: ${JSON.stringify([...latestFiles])}`
  );
}

async function testBrowserKernelStorageRetriesAndReportsBackgroundFailures(): Promise<void> {
  let saveAttempts = 0;
  const reportedErrors: string[] = [];
  let latestSnapshot: TestRuntimeProjectSnapshot | undefined;
  const workspace = await createBrowserProjectWorkspace({
    files: [],
    kernelStorage: {
      async load() {
        return null;
      },
      async save(snapshot) {
        saveAttempts += 1;
        if (saveAttempts === 2) throw new Error('transient background save failure');
        latestSnapshot = cloneProjectSnapshot(snapshot);
      },
      async flush() {},
    },
    onKernelStorageError(error) {
      reportedErrors.push(error.message);
    },
    ...throwingBrowserWorkerClients(),
  });
  await workspace.writeFile('retry.txt', 'retry\n');
  await new Promise((resolve) => setTimeout(resolve, 400));
  await workspace.destroy({ reason: 'test' });
  assertCondition(
    reportedErrors.some((message) => message.includes('transient background save failure')),
    `background persistence failures should be observable by the host: ${JSON.stringify(reportedErrors)}`
  );
  assertCondition(
    saveAttempts >= 3 && latestSnapshot?.files.some((file) => file.path === 'retry.txt' && file.contents === 'retry\n') === true,
    `failed persistence revisions should remain dirty and retry during flush: ${JSON.stringify({ saveAttempts, latestSnapshot })}`
  );
}

async function testBrowserProjectSharedWorkersRequireTrustedOptIn(): Promise<void> {
  let untrustedError = '';
  try {
    await createBrowserProjectWorkspace({
      projectWorkerIsolation: 'shared',
      ...throwingBrowserWorkerClients(),
    });
  } catch (error) {
    untrustedError = error instanceof Error ? error.message : String(error);
  }
  assertCondition(
    untrustedError.includes('trustedSharedWorkerReuse: true'),
    `shared project workers across every language should require an explicit trusted-reuse opt-in: ${untrustedError}`
  );

  const trustedWorkspace = await createBrowserProjectWorkspace({
    projectWorkerIsolation: 'shared',
    trustedSharedWorkerReuse: true,
    ...throwingBrowserWorkerClients(),
  });
  trustedWorkspace.dispose();
}

async function testBrowserProjectWorkspaceTraceKernelConfig(): Promise<void> {
  const events: RuntimeWorkspaceEvent[] = [];
  const pythonRequests: PythonProjectCommandRequest[] = [];
  const javaRequests: JavaProjectCommandRequest[] = [];
  const csharpRequests: CSharpProjectCommandRequest[] = [];
  const cppRequests: CppProjectCommandRequest[] = [];
  const workspace = await createBrowserProjectWorkspace({
    kernel: {
      user: { id: 'browser-user-123', username: 'ada' },
      host: { hostname: 'tracevm-browser' },
      workspace: {
        id: 'weather-api-browser',
        name: 'weather-api',
        startedAt: '2026-05-17T12:00:00.000Z',
      },
    },
    files: [
      { path: 'main.py', contents: 'print("python")\n' },
      {
        path: 'index.js',
        contents: [
          'const fs = require("node:fs");',
          'const os = require("node:os");',
          'const path = require("node:path");',
          'const value = require("/home/ada/weather-api/lib/value.js");',
          'console.log(process.cwd());',
          'console.log(process.env.MODE);',
          'console.log(os.homedir());',
          'console.log(path.resolve("src/alias.txt"));',
          'console.log(__filename);',
          'console.log(__dirname);',
          'console.log(require.resolve("./index.js"));',
          'console.log(require.resolve("/home/ada/weather-api/lib/value.js"));',
          'console.log(value.answer);',
          'const procInfo = JSON.parse(fs.readFileSync("/proc/kernel/info", "utf8"));',
          'console.log(`${procInfo.user.username}:${procInfo.host.hostname}:${procInfo.workspace.root}`);',
          'console.log(fs.readFileSync("/proc/kernel/version", "utf8").trim());',
          'console.log(fs.readFileSync("/skills/browser/guide.md", "utf8").trim());',
          'console.log(fs.readdirSync("/skills").join(","));',
          'try { fs.writeFileSync("/skills/browser/guide.md", "mutate\\n"); } catch (error) { console.log(error.code); }',
          'fs.copyFileSync("/skills/browser/guide.md", "copied-browser-skill.md");',
          'console.log(fs.readFileSync("copied-browser-skill.md", "utf8").trim());',
          'const procEntries = fs.readdirSync("/proc");',
          'console.log(`${procEntries.includes("kernel")}:${procEntries.includes("self")}:${procEntries.includes("tracekernel")}`);',
          'console.log(fs.readdirSync("/proc/kernel", { withFileTypes: true }).map((entry) => `${entry.name}:${entry.isFile()}`).join(","));',
          'console.log(fs.readdirSync("/proc/tracekernel").join(","));',
          'console.log(fs.readFileSync("/proc/tracekernel/processes", "utf8").includes("node /home/ada/weather-api/index.js"));',
          'console.log(`${fs.statSync("/proc").isDirectory()}:${fs.statSync("/proc/kernel/info").isFile()}`);',
          'console.log(`${fs.existsSync("/proc/self/mountinfo")}:${fs.existsSync("/proc/missing")}`);',
          'try { fs.accessSync("/proc/kernel/info", fs.constants.W_OK); } catch (error) { console.log(error.code); }',
          'console.log(fs.readFileSync("/proc/self/mountinfo", "utf8").includes("tracekernel:proc"));',
          'const procFd = fs.openSync("/proc/kernel/info", "r");',
          'console.log(JSON.parse(fs.readFileSync(procFd, "utf8")).workspaceRoot);',
          'console.log(fs.fstatSync(procFd).isFile());',
          'try { fs.fchmodSync(procFd, 0o600); } catch (error) { console.log(error.code); }',
          'fs.closeSync(procFd);',
          'try { fs.writeFileSync("/proc/kernel/info", "{}\\n"); } catch (error) { console.log(error.code); }',
          'fs.writeFileSync("copy-device.txt", "copy-device\\n");',
          'fs.copyFileSync("copy-device.txt", "/dev/stdout");',
          'try { fs.copyFileSync("copy-device.txt", "/proc/kernel/info"); } catch (error) { console.log(error.code); }',
          'fs.copyFileSync("/proc/kernel/info", "copied-proc-info.json");',
          'console.log(JSON.parse(fs.readFileSync("copied-proc-info.json", "utf8")).name);',
          'try { fs.mkdirSync("/proc/new"); } catch (error) { console.log(error.code); }',
          'try { fs.rmSync("/dev/stdout"); } catch (error) { console.log(error.code); }',
          'try { fs.renameSync("copy-device.txt", "/dev/stdout"); } catch (error) { console.log(error.code); }',
          'try { fs.chmodSync("/proc/kernel/info", 0o600); } catch (error) { console.log(error.code); }',
          'fs.chmodSync("/dev/stdout", 0o600);',
          'try { fs.utimesSync("/dev/missing", new Date(), new Date()); } catch (error) { console.log(error.code); }',
          'try { fs.truncateSync("/dev/stdout", 0); } catch (error) { console.log(error.code); }',
          'fs.writeFileSync("node-cwd.txt", process.cwd() + "\\n" + process.env.MODE + "\\n");',
          'fs.writeFileSync("/home/ada/weather-api/node-canonical.txt", "node-canonical\\n");',
          'fs.appendFileSync("/workspace/node-alias.txt", "node-alias\\n");',
          '',
        ].join('\n'),
      },
      { path: 'lib/value.js', contents: 'exports.answer = 42;\n' },
      { path: 'Main.java', contents: 'class Main {}\n' },
      { path: 'Program.cs', contents: 'Console.WriteLine("csharp");\n' },
      { path: 'main.cpp', contents: 'int main() { return 0; }\n' },
    ],
    skills: [
      { path: 'browser/guide.md', contents: 'browser skill\n' },
    ],
    nodeProject: { allowMainThreadExecution: true, trustedMainThreadExecution: true },
    pythonWorkerClient: {
      async executeProjectPython(request) {
        pythonRequests.push(request);
        return {
          stdout: `${request.cwd}:${request.project.workspaceRoot}:${request.project.workspaceAlias}:${request.env.MODE}:${request.project.kernel?.name}:${request.project.kernel?.version}\n`,
          stderr: '',
          exitCode: 0,
          files: [{ path: 'python-browser.txt', contents: 'python-browser\n' }],
        };
      },
      terminate() {},
    },
    javaWorkerClient: {
      async executeProjectJava(request) {
        javaRequests.push(request);
        return { stdout: `${request.cwd}:${request.project.workspaceRoot}:${request.project.workspaceAlias}:${request.env.MODE}:${request.project.kernel?.name}:${request.project.kernel?.version}\n`, stderr: '', exitCode: 0 };
      },
      terminate() {},
    },
    csharpWorkerClient: {
      async executeProjectCSharp(request) {
        csharpRequests.push(request);
        return { stdout: `${request.cwd}:${request.project.workspaceRoot}:${request.project.workspaceAlias}:${request.env.MODE}:${request.project.kernel?.name}:${request.project.kernel?.version}\n`, stderr: '', exitCode: 0 };
      },
      terminate() {},
    },
    cppWorkerClient: {
      async executeProjectCpp(request) {
        cppRequests.push(request);
        return {
          stdout: `${request.cwd}:${request.project.workspaceRoot}:${request.project.workspaceAlias}:${request.env.MODE}:${request.project.kernel?.name}:${request.project.kernel?.version}\n`,
          stderr: '',
          exitCode: 0,
          ...(request.source === 'compile'
            ? { files: [{ path: 'out/app', contents: Buffer.from('wasm').toString('base64'), encoding: 'base64' as const }] }
            : {}),
        };
      },
      terminate() {},
    },
  });
  const unsubscribe = workspace.watch((event) => events.push(event));

  try {
    assertCondition(workspace.cwd === '/home/ada/weather-api', `browser workspace cwd should use canonical kernel root: ${workspace.cwd}`);
    assertCondition(workspace.kernel.info.user.id === 'browser-user-123', 'browser workspace kernel should preserve user id');
    assertCondition(workspace.kernel.info.host.hostname === 'tracevm-browser', 'browser workspace kernel should preserve host identity');
    assertCondition(workspace.kernel.info.workspaceRoot === '/home/ada/weather-api', 'browser workspace kernel should expose canonical root');
    assertCondition(workspace.kernel.info.workspaceAlias === '/workspace', 'browser workspace kernel should expose /workspace compatibility alias');

    await workspace.writeFile('/workspace/src/alias.txt', 'alias\n');
    assertCondition(await workspace.readFile('/home/ada/weather-api/src/alias.txt') === 'alias\n', 'browser workspace should map alias writes to canonical root');
    assertCondition((await workspace.readDir('/workspace/src')).join(',') === 'alias.txt', 'browser workspace should list alias directories');

    const procInfo = JSON.parse(await workspace.readFile('/proc/kernel/info')) as typeof workspace.kernel.info;
    assertCondition(procInfo.workspace.root === '/workspace', 'browser workspace public /proc should expose virtual workspace root');
    assertCondition((await workspace.readDir('/proc')).join(',') === 'kernel,mounts,self,tracekernel', 'browser workspace /proc should list virtual namespaces and the canonical mount table');
    assertCondition((await workspace.readDir('/proc/kernel')).join(',') === 'info,version', 'browser workspace /proc/kernel should list info and version');
    assertCondition(
      (await workspace.readDir('/proc/tracekernel')).join(',') === 'commands,events,inodes,locks,net,processes,runtimes,sched',
      'browser workspace /proc/tracekernel should expose dynamic kernel diagnostics'
    );
    const browserPs = await workspace.runCommand('ps -ef');
    assertCondition(
      browserPs.exitCode === 0 && browserPs.stdout.includes('tracekernel') && browserPs.stdout.includes('ps -ef'),
      `browser workspace ps should use the shared kernel process table: ${JSON.stringify(browserPs)}`
    );
    const browserKernelEvents = await workspace.readFile('/proc/tracekernel/events');
    assertCondition(
      browserKernelEvents.includes('process-start') && browserKernelEvents.includes('process-exit'),
      `browser workspace proc events should expose command lifecycle: ${JSON.stringify(browserKernelEvents)}`
    );

    const outputEvents: RuntimeCommandEvent[] = [];
    const stdout = await workspace.runCommand('printf "browser-out\\n" > /dev/stdout', {
      onEvent: (event) => outputEvents.push(event),
    });
    assertCondition(stdout.stdout === 'browser-out\n', `browser workspace /dev/stdout should stream command output: ${JSON.stringify(stdout)}`);
    assertCondition(
      outputEvents.some((event) => event.type === 'output' && event.device === '/dev/stdout' && event.data === 'browser-out\n'),
      `browser workspace runCommand should surface stdout device events: ${JSON.stringify(outputEvents)}`
    );

    const python = await workspace.runCommand('python3 /workspace/main.py', {
      cwd: '/workspace',
      env: { MODE: 'browser-python' },
    });
    assertCondition(python.exitCode === 0, `browser Python project command should succeed with alias cwd: ${python.stderr}`);
    assertCondition(
      python.stdout === `/home/ada/weather-api:/home/ada/weather-api:/workspace:browser-python:tracekernel:${expectedTraceKernelVersion}\n`,
      `browser Python request should use canonical cwd and expose environment/kernel metadata: ${python.stdout}`
    );
    assertCondition(await workspace.readFile('python-browser.txt') === 'python-browser\n', 'browser Python final diff should persist through kernel FS');
    assertCondition(pythonRequests[0]?.project.kernel?.user.username === 'user', 'browser Python request should include public kernel identity');

    const nodeEvents: RuntimeCommandEvent[] = [];
    const node = await workspace.runCommand('node /home/ada/weather-api/index.js', {
      cwd: '/workspace',
      env: { MODE: 'browser-node' },
      onEvent: (event) => nodeEvents.push(event),
    });
    assertCondition(node.exitCode === 0, `browser Node project command should succeed with canonical script path: ${node.stderr}`);
    assertCondition(
      node.stdout === [
        '/home/ada/weather-api',
        'browser-node',
        '/home/ada',
        '/home/ada/weather-api/src/alias.txt',
        '/home/ada/weather-api/index.js',
        '/home/ada/weather-api',
        '/home/ada/weather-api/index.js',
        '/home/ada/weather-api/lib/value.js',
        '42',
        'user:tracevm:/workspace',
        `tracekernel ${expectedTraceKernelVersion}`,
        'browser skill',
        'browser',
        'EROFS',
        'browser skill',
        'true:true:true',
        'info:true,version:true',
        'commands,events,inodes,locks,net,processes,runtimes,sched',
        'true',
        'true:true',
        'true:false',
        'EACCES',
        'true',
        '/workspace',
        'true',
        'EROFS',
        'EROFS',
        'copy-device',
        'EROFS',
        'tracekernel',
        'EROFS',
        'EROFS',
        'EROFS',
        'EROFS',
        'ENOENT',
        'EROFS',
        '',
      ].join('\n'),
      `browser Node APIs should use canonical tracekernel paths: ${node.stdout}`
    );
    assertCondition(await workspace.readFile('node-cwd.txt') === '/home/ada/weather-api\nbrowser-node\n', 'browser Node should write cwd-relative files with runtime env');
    assertCondition(await workspace.readFile('node-canonical.txt') === 'node-canonical\n', 'browser Node should write canonical absolute paths');
    assertCondition(await workspace.readFile('node-alias.txt') === 'node-alias\n', 'browser Node should still map /workspace alias paths');
    assertCondition(await workspace.readFile('copied-browser-skill.md') === 'browser skill\n', 'browser Node should copy protected skill files into the workspace');
    assertCondition(nodeEvents.some((event) => event.type === 'output' && event.device === '/dev/stdout'), 'browser Node should stream stdout events');
    assertCondition(
      nodeEvents.some((event) => event.type === 'file-change' && event.phase === 'live' && event.change.path === 'node-canonical.txt'),
      `browser Node should stream canonical absolute file mutations live: ${JSON.stringify(nodeEvents)}`
    );
    assertCondition(
      events.filter((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change.path === 'node-canonical.txt'
      ).length === 1,
      `browser Node workspace file mutations should be applied once through the kernel hook: ${JSON.stringify(events)}`
    );

    const java = await workspace.runCommand('java Main', { cwd: '/workspace', env: { MODE: 'browser-java' } });
    assertCondition(java.exitCode === 0, `browser Java project command should succeed with alias cwd: ${java.stderr}`);
    assertCondition(
      java.stdout === `/home/ada/weather-api:/home/ada/weather-api:/workspace:browser-java:tracekernel:${expectedTraceKernelVersion}\n`,
      `browser Java request should use canonical cwd and expose environment/kernel metadata: ${java.stdout}`
    );
    assertCondition(javaRequests[0]?.project.workspaceRoot === '/home/ada/weather-api', 'browser Java request should include workspaceRoot');
    assertCondition(javaRequests[0]?.project.workspaceAlias === '/workspace', 'browser Java request should include workspaceAlias');
    assertCondition(javaRequests[0]?.project.kernel?.host.hostname === 'tracevm', 'browser Java request should include public kernel host identity');

    const csharp = await workspace.runCommand('dotnet run', { cwd: '/workspace', env: { MODE: 'browser-csharp' } });
    assertCondition(csharp.exitCode === 0, `browser C# project command should succeed with alias cwd: ${csharp.stderr}`);
    assertCondition(
      csharp.stdout === `/home/ada/weather-api:/home/ada/weather-api:/workspace:browser-csharp:tracekernel:${expectedTraceKernelVersion}\n`,
      `browser C# request should use canonical cwd and expose environment/kernel metadata: ${csharp.stdout}`
    );
    assertCondition(csharpRequests[0]?.project.workspaceRoot === '/home/ada/weather-api', 'browser C# request should include workspaceRoot');
    assertCondition(csharpRequests[0]?.project.workspaceAlias === '/workspace', 'browser C# request should include workspaceAlias');
    assertCondition(csharpRequests[0]?.project.kernel?.host.hostname === 'tracevm', 'browser C# request should include public kernel host identity');

    const cpp = await workspace.runCommand('clang++ /home/ada/weather-api/main.cpp -o /workspace/out/app', {
      cwd: '/workspace',
      env: { MODE: 'browser-cpp' },
    });
    assertCondition(cpp.exitCode === 0, `browser C++ project command should succeed with canonical and alias args: ${cpp.stderr}`);
    assertCondition(
      cpp.stdout === `/home/ada/weather-api:/home/ada/weather-api:/workspace:browser-cpp:tracekernel:${expectedTraceKernelVersion}\n`,
      `browser C++ request should use canonical cwd and expose environment/kernel metadata: ${cpp.stdout}`
    );
    assertCondition(cppRequests[0]?.project.workspaceRoot === '/home/ada/weather-api', 'browser C++ request should include workspaceRoot');
    assertCondition(cppRequests[0]?.project.workspaceAlias === '/workspace', 'browser C++ request should include workspaceAlias');
    assertCondition(cppRequests[0]?.project.kernel?.host.hostname === 'tracevm', 'browser C++ request should include public kernel host identity');

    assertCondition(
      pythonRequests[0]?.project.files.some((file) => file.path === 'src/alias.txt') === true,
      'browser runner snapshots should include files written through alias paths'
    );
    assertCondition(
      events.some((event) => event.type === 'file-change' && event.change.path === 'python-browser.txt' && event.actor?.kind === 'runtime'),
      `browser workspace watch should surface runtime final-diff file changes: ${JSON.stringify(events)}`
    );
    assertCondition(
      events.some((event) => event.type === 'output' && event.device === '/dev/stdout' && event.actor?.kind === 'runtime'),
      `browser workspace watch should surface runtime output events: ${JSON.stringify(events)}`
    );
  } finally {
    unsubscribe();
    workspace.dispose();
  }
}

async function testBrowserProjectWorkspaceAdvancedCommandTranslation(): Promise<void> {
  const pythonRequests: PythonProjectCommandRequest[] = [];
  const javaRequests: JavaProjectCommandRequest[] = [];
  const csharpRequests: CSharpProjectCommandRequest[] = [];
  const cppRequests: CppProjectCommandRequest[] = [];
  const workspace = await createBrowserProjectWorkspace({
    files: [
      { path: 'app/__init__.py', contents: '' },
      { path: 'app/main.py', contents: 'print("module")\n' },
      { path: 'src/app/Main.java', contents: 'package app; class Main {}\n' },
      { path: 'lib/external.jar', contents: Buffer.from([0, 255]).toString('base64'), encoding: 'base64' },
      {
        path: 'app/App.csproj',
        contents: [
          '<Project Sdk="Microsoft.NET.Sdk">',
          '  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup>',
          '</Project>',
          '',
        ].join('\n'),
      },
      { path: 'app/Program.cs', contents: 'Console.WriteLine("advanced");\n' },
      { path: 'src/main.cpp', contents: 'int main() { return 0; }\n' },
      { path: 'lib/liblinked.a', contents: Buffer.from([1, 255]).toString('base64'), encoding: 'base64' },
    ],
    pythonWorkerClient: {
      async executeProjectPython(request) {
        pythonRequests.push(request);
        return { stdout: `${request.source}:${request.scriptPath}\n`, stderr: '', exitCode: 0 };
      },
      terminate() {},
    },
    javaWorkerClient: {
      async executeProjectJava(request) {
        javaRequests.push(request);
        return { stdout: `${request.source}:${request.scriptPath}\n`, stderr: '', exitCode: 0 };
      },
      terminate() {},
    },
    csharpWorkerClient: {
      async executeProjectCSharp(request) {
        csharpRequests.push(request);
        return { stdout: `${request.source}:${request.scriptPath}\n`, stderr: '', exitCode: 0 };
      },
      terminate() {},
    },
    cppWorkerClient: {
      async executeProjectCpp(request) {
        cppRequests.push(request);
        return {
          stdout: `${request.source}:${request.scriptPath}\n`,
          stderr: '',
          exitCode: 0,
          ...(request.source === 'compile' ? { files: [{ path: 'out/app', contents: Buffer.from('wasm').toString('base64'), encoding: 'base64' as const }] } : {}),
        };
      },
      terminate() {},
    },
  });

  try {
    const python = await workspace.runCommand('python3 -m app.main delta');
    assertCondition(python.exitCode === 0, `browser workspace advanced python module should route through runner: ${python.stderr}`);
    assertCondition(
      pythonRequests[0]?.source === 'module' &&
        pythonRequests[0]?.scriptPath === 'app.main' &&
        pythonRequests[0]?.args.join(',') === 'delta' &&
        pythonRequests[0]?.project.files.some((file) => file.path === 'app/main.py') === true,
      `browser workspace advanced python should preserve module execution request: ${JSON.stringify(pythonRequests[0])}`
    );

    const javac = await workspace.runCommand(
      'javac -cp lib/external.jar -d out -sourcepath src src/app/Main.java',
      { env: { CLASSPATH: '/workspace/lib/external.jar' } }
    );
    assertCondition(javac.exitCode === 0, `browser workspace advanced javac should route through runner: ${javac.stderr}`);
    assertCondition(javaRequests[0]?.source === 'compile', 'browser workspace advanced javac should produce a compile request');
    assertCondition(
      javaRequests[0]?.scriptPath === 'src/app/Main.java' &&
        javaRequests[0]?.args.join(',') === '-cp,lib/external.jar,-d,out,-sourcepath,src,src/app/Main.java' &&
        javaRequests[0]?.env.CLASSPATH === '/workspace/lib/external.jar',
      `browser workspace advanced javac should preserve classpath/sourcepath args and env: ${JSON.stringify(javaRequests[0])}`
    );
    assertCondition(
      javaRequests[0]?.project.files.some((file) => file.path === 'lib/external.jar' && file.encoding === 'base64') === true,
      'browser workspace advanced javac should snapshot jar resources'
    );

    const java = await workspace.runCommand('java --class-path out app.Main alpha beta');
    assertCondition(java.exitCode === 0, `browser workspace advanced java should route through runner: ${java.stderr}`);
    assertCondition(
      javaRequests[1]?.source === 'run' &&
        javaRequests[1]?.scriptPath === 'app.Main' &&
        javaRequests[1]?.args.join(',') === 'alpha,beta' &&
        javaRequests[1]?.options?.classpath === 'out',
      `browser workspace advanced java should preserve classpath run options: ${JSON.stringify(javaRequests[1])}`
    );

    const dotnet = await workspace.runCommand(
      'dotnet run --project app/App.csproj --property=DefineConstants=CLI_ONE%3BCLI_TWO -p AllowUnsafeBlocks=true -- alpha beta'
    );
    assertCondition(dotnet.exitCode === 0, `browser workspace advanced dotnet should route through runner: ${dotnet.stderr}`);
    assertCondition(
      csharpRequests[0]?.source === 'run' &&
        csharpRequests[0]?.scriptPath === 'app/App.csproj' &&
        csharpRequests[0]?.args.join(',') === 'alpha,beta' &&
        Array.isArray(csharpRequests[0]?.options?.buildArgs) &&
        (csharpRequests[0]?.options?.buildArgs as string[]).join(',') === '--property:DefineConstants=CLI_ONE%3BCLI_TWO,-p:AllowUnsafeBlocks=true',
      `browser workspace advanced dotnet should preserve project and build properties: ${JSON.stringify(csharpRequests[0])}`
    );

    const cpp = await workspace.runCommand(
      'clang++ -std=c++17 src/main.cpp -L /workspace/lib -llinked -o out/app',
      { env: { LIBRARY_PATH: '/workspace/lib' } }
    );
    assertCondition(cpp.exitCode === 0, `browser workspace advanced C++ compile should route through runner: ${cpp.stderr}`);
    assertCondition(
      cppRequests[0]?.source === 'compile' &&
        cppRequests[0]?.scriptPath === 'src/main.cpp' &&
        cppRequests[0]?.args.join(',') === '-std=c++17,src/main.cpp,-L,/workspace/lib,-llinked,-o,out/app' &&
        cppRequests[0]?.env.LIBRARY_PATH === '/workspace/lib',
      `browser workspace advanced C++ should preserve link args and env: ${JSON.stringify(cppRequests[0])}`
    );

    const cppRun = await workspace.runCommand('./out/app gamma');
    assertCondition(cppRun.exitCode === 0, `browser workspace advanced C++ run should route through runner: ${cppRun.stderr}`);
    assertCondition(
      cppRequests[1]?.source === 'run' &&
        cppRequests[1]?.scriptPath === 'out/app' &&
        cppRequests[1]?.args.join(',') === 'gamma',
      `browser workspace advanced C++ run should preserve executable args: ${JSON.stringify(cppRequests[1])}`
    );
  } finally {
    workspace.dispose();
  }
}

async function testNativeProjectWorkspaceFactory(): Promise<void> {
  const workspace = await createNativeProjectWorkspace({
    files: [
      { path: 'main.py', contents: 'print("native-python")\n' },
      { path: 'index.js', contents: 'console.log("native-node")\n' },
      { path: 'Main.java', contents: 'class Main { public static void main(String[] args) { System.out.println("native-java"); } }\n' },
      { path: 'main.cpp', contents: '#include <iostream>\nint main() { std::cout << "native-cpp\\n"; return 0; }\n' },
      {
        path: 'NativeFactory.csproj',
        contents: [
          '<Project Sdk="Microsoft.NET.Sdk">',
          '  <PropertyGroup>',
          '    <OutputType>Exe</OutputType>',
          '    <TargetFramework>net10.0</TargetFramework>',
          '    <ImplicitUsings>enable</ImplicitUsings>',
          '  </PropertyGroup>',
          '</Project>',
          '',
        ].join('\n'),
      },
      { path: 'Program.cs', contents: 'Console.WriteLine("native-csharp");\n' },
    ],
  });

  const python = await workspace.runCommand('python3 main.py');
  assertCondition(python.exitCode === 0, `native project workspace python should succeed: ${python.stderr}`);
  assertCondition(python.stdout === 'native-python\n', `native project workspace should wire Python runner: ${python.stdout}`);

  const node = await workspace.runCommand('node index.js');
  assertCondition(node.exitCode === 0, `native project workspace node should succeed: ${node.stderr}`);
  assertCondition(node.stdout === 'native-node\n', `native project workspace should wire Node runner: ${node.stdout}`);

  const compile = await workspace.runCommand('javac Main.java');
  assertCondition(compile.exitCode === 0, `native project workspace javac should succeed: ${compile.stderr}`);
  const java = await workspace.runCommand('java Main');
  assertCondition(java.exitCode === 0, `native project workspace java should succeed: ${java.stderr}`);
  assertCondition(java.stdout === 'native-java\n', `native project workspace should wire Java runner: ${java.stdout}`);

  const cppCompile = await workspace.runCommand('clang++ main.cpp -o native-cpp');
  assertCondition(cppCompile.exitCode === 0, `native project workspace C++ compile should succeed: ${cppCompile.stderr}`);
  const cpp = await workspace.runCommand('./native-cpp');
  assertCondition(cpp.exitCode === 0, `native project workspace C++ run should succeed: ${cpp.stderr}`);
  assertCondition(cpp.stdout === 'native-cpp\n', `native project workspace should wire C++ runner: ${cpp.stdout}`);

  const csharp = await workspace.runCommand('dotnet run --project NativeFactory.csproj');
  assertCondition(csharp.exitCode === 0, `native project workspace C# should succeed: ${csharp.stderr}`);
  assertCondition(csharp.stdout.endsWith('native-csharp\n'), `native project workspace should wire C# runner: ${csharp.stdout}`);
  workspace.dispose();
}

async function testProjectWorkspaceCommandEvents(): Promise<void> {
  const events: RuntimeCommandEvent[] = [];
  const workspace = await createNativeProjectWorkspace({
    directories: ['initial-empty/deep'],
    files: [{
      path: 'events.py',
      contents: [
        'import os',
        'import sys',
        'print("event-out")',
        'print("event-err", file=sys.stderr)',
        'open("event-generated.txt", "w", encoding="utf-8").write("generated\\n")',
        'os.makedirs("event-dir/nested")',
        'os.rmdir("initial-empty/deep")',
        'os.rmdir("initial-empty")',
        '',
      ].join('\n'),
    }],
  });
  const result = await workspace.runCommand('python3 events.py', {
    onEvent: (event) => events.push(event),
  });
  assertCondition(result.exitCode === 0, `event project command should succeed: ${result.stderr}`);
  assertCondition(
    events.some((event) => event.type === 'status' && event.phase === 'process-start'),
    `project command should emit process-start status: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) => event.type === 'status' && event.phase === 'process-exit'),
    `project command should emit process-exit status: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'output' &&
      event.stream === 'stdout' &&
      event.device === '/dev/stdout' &&
      event.actor?.kind === 'runtime' &&
      event.data.includes('event-out')
    ),
    `project command should emit stdout chunks: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'output' &&
      event.stream === 'stderr' &&
      event.device === '/dev/stderr' &&
      event.actor?.kind === 'runtime' &&
      event.data.includes('event-err')
    ),
    `project command should emit stderr chunks: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.filter((event) =>
      event.type === 'file-change' &&
      event.phase === 'final-diff' &&
      event.change.path === 'event-generated.txt'
    ).length === 1,
    `project command should emit one final-diff event for native runner files: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'final-diff' &&
      event.change.path === 'event-dir' &&
      looseChange(event.change).directory === true
    ) &&
      events.some((event) =>
        event.type === 'file-change' &&
        event.phase === 'final-diff' &&
        event.change.path === 'event-dir/nested' &&
        looseChange(event.change).directory === true
      ) &&
      events.some((event) =>
        event.type === 'file-change' &&
        event.phase === 'final-diff' &&
        event.change.path === 'initial-empty/deep' &&
        looseChange(event.change).directory === true &&
        looseChange(event.change).deleted === true
    ),
    `project command should emit final-diff directory changes for native runner directories: ${JSON.stringify(events)}`
  );
  assertCondition((await workspace.stat('event-dir/nested')).isDirectory, 'project command should persist final-diff directory creates');
  assertCondition(!(await workspace.exists('initial-empty/deep')), 'project command should persist final-diff directory deletes');
  workspace.dispose();

  const directEvents: RuntimeCommandEvent[] = [];
  const direct = await createNativePythonProjectRunner()({
    code: [
      'import os',
      'import sys',
      'print("direct-out")',
      'print("direct-err", file=sys.stderr)',
      'open("direct-generated.txt", "w", encoding="utf-8").write("generated\\n")',
      'os.makedirs("direct-dir/nested")',
      'os.rmdir("direct-empty/deep")',
      'os.rmdir("direct-empty")',
      '',
    ].join('\n'),
    source: 'argument',
    scriptPath: '-c',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      directories: ['direct-empty/deep'],
      files: [],
    },
    onEvent: (event) => directEvents.push(event),
  });
  assertCondition(direct.exitCode === 0, `direct native project command should succeed: ${direct.stderr}`);
  assertCondition(
    directEvents.some((event) =>
      event.type === 'output' &&
      event.stream === 'stdout' &&
      event.device === '/dev/stdout' &&
      event.data.includes('direct-out')
    ),
    `direct native project runner should emit stdout device metadata: ${JSON.stringify(directEvents)}`
  );
  assertCondition(
    directEvents.some((event) =>
      event.type === 'output' &&
      event.stream === 'stderr' &&
      event.device === '/dev/stderr' &&
      event.data.includes('direct-err')
    ),
    `direct native project runner should emit stderr device metadata: ${JSON.stringify(directEvents)}`
  );
  assertCondition(
    directEvents.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'final-diff' &&
      event.change.path === 'direct-generated.txt'
    ),
    `direct native project runner should emit final-diff file changes: ${JSON.stringify(directEvents)}`
  );
  assertCondition(
    directEvents.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'final-diff' &&
      event.change.path === 'direct-dir/nested' &&
      looseChange(event.change).directory === true
    ) &&
      directEvents.some((event) =>
        event.type === 'file-change' &&
        event.phase === 'final-diff' &&
        event.change.path === 'direct-empty/deep' &&
        looseChange(event.change).directory === true &&
        looseChange(event.change).deleted === true
    ),
    `direct native project runner should emit final-diff directory changes: ${JSON.stringify(directEvents)}`
  );

  const partialSnapshotDelete = await createNativePythonProjectRunner()({
    code: [
      'import shutil',
      'shutil.rmtree("src")',
      '',
    ].join('\n'),
    source: 'argument',
    scriptPath: '-c',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      files: [{ path: 'src/main.py', contents: 'print("visible")\n' }],
    },
  });
  assertCondition(partialSnapshotDelete.exitCode === 0, `partial snapshot delete should run: ${partialSnapshotDelete.stderr}`);
  assertCondition(
    partialSnapshotDelete.files?.some((file) => file.path === 'src/main.py' && looseChange(file).deleted === true) &&
      !partialSnapshotDelete.files?.some((file) => file.path === 'src' && looseChange(file).directory === true && looseChange(file).deleted === true),
    `partial snapshot deletes should not emit recursive ancestor directory tombstones: ${JSON.stringify(partialSnapshotDelete.files)}`
  );
  const partialHostWorkspace = await createRuntimeWorkspace({
    files: [
      { path: 'src/main.py', contents: 'print("visible")\n' },
      { path: 'src/hidden_test.py', contents: 'print("hidden")\n' },
    ],
  });
  for (const change of partialSnapshotDelete.files ?? []) {
    await partialHostWorkspace.kernel.applyFileChange(
      change,
      { id: 'runtime:partial-final-diff', kind: 'runtime', capabilities: { write: ['/workspace/**'], delete: ['/workspace/**'], execute: true } },
      'final-diff'
    );
  }
  assertCondition(!(await partialHostWorkspace.exists('src/main.py')), 'partial final diff should delete known removed files');
  assertCondition(await partialHostWorkspace.exists('src/hidden_test.py'), 'partial final diff should preserve unsnapshotted descendants');
  partialHostWorkspace.dispose();
}

async function testRuntimeProjectEventQueueRecoversAfterApplyFailure(): Promise<void> {
  const rejectedChanges: string[] = [];
  const unsafeQueue = new RuntimeProjectEventQueue();
  unsafeQueue.enqueue(
    { type: 'file-change', phase: 'live', change: { path: '../escape.txt', contents: 'bad\n' } },
    {
      applyFileChange: async (change) => {
        rejectedChanges.push(change.path);
      },
      emit: (event) => rejectedChanges.push(`emit:${event.type}`),
    }
  );
  let unsafeError = '';
  try {
    await unsafeQueue.flush();
  } catch (error) {
    unsafeError = error instanceof Error ? error.message : String(error);
  }
  assertCondition(
    unsafeError.includes('TraceKernel file-change path must not escape the workspace') &&
      rejectedChanges.length === 0,
    `event queue should reject unsafe file-change paths before apply: ${JSON.stringify({ unsafeError, rejectedChanges })}`
  );

  const normalizedChanges: string[] = [];
  const normalizedEvents: RuntimeCommandEvent[] = [];
  const normalizedQueue = new RuntimeProjectEventQueue();
  normalizedQueue.enqueue(
    { type: 'file-change', phase: 'live', change: { path: './safe.txt', contents: 'safe\n' } },
    {
      applyFileChange: async (change) => {
        normalizedChanges.push(change.path);
      },
      emit: (event) => normalizedEvents.push(event),
    }
  );
  await normalizedQueue.flush();
  assertCondition(
    normalizedChanges.includes('safe.txt') &&
      normalizedEvents.some((event) => event.type === 'file-change' && event.change.path === 'safe.txt'),
    `event queue should normalize safe file-change paths before apply and emit: ${JSON.stringify({ normalizedChanges, normalizedEvents })}`
  );

  const events: RuntimeCommandEvent[] = [];
  const queue = new RuntimeProjectEventQueue();

  queue.enqueue(
    { type: 'file-change', phase: 'live', change: { path: 'bad.txt', contents: 'bad\n' } },
    {
      applyFileChange: async (change) => {
        throw new Error(`reject:${change.path}`);
      },
      emit: (event) => events.push(event),
    }
  );
  queue.enqueue(
    { type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'after-bad\n' },
    {
      applyFileChange: async () => undefined,
      emit: (event) => events.push(event),
    }
  );

  let failedFlush = '';
  try {
    await queue.flush();
  } catch (error) {
    failedFlush = error instanceof Error ? error.message : String(error);
  }

  assertCondition(failedFlush === 'reject:bad.txt', `event queue should surface failed live apply errors: ${failedFlush}`);
  assertCondition(
    events.length === 0,
    `event queue should suppress later events in a failed batch: ${JSON.stringify(events)}`
  );

  queue.enqueue(
    { type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'after-reset\n' },
    {
      applyFileChange: async () => undefined,
      emit: (event) => events.push(event),
    }
  );
  await queue.flush();

  assertCondition(
    events.some((event) => event.type === 'output' && event.data === 'after-reset\n'),
    `event queue should recover after a failed flush: ${JSON.stringify(events)}`
  );
}

async function testWorkspaceKernelEvents(): Promise<void> {
  const events: RuntimeWorkspaceEvent[] = [];
  const workspace = await createRuntimeWorkspace();
  const unsubscribe = workspace.watch((event) => events.push(event));

  await workspace.writeFile('user.txt', 'one\n');
  await workspace.appendFile('user.txt', 'two\n');
  await workspace.kernel.writeFile(
    'agent.txt',
    'agent\n',
    { id: 'agent:test', kind: 'principal', capabilities: { write: ['/workspace/**'], execute: true } }
  );
  await workspace.kernel.applyFileChange(
    { path: 'runtime.txt', contents: 'runtime\n' },
    { id: 'runtime:test', kind: 'runtime', capabilities: { write: ['/workspace/**'], execute: true } },
    'final-diff'
  );
  await workspace.kernel.applyFileChange(
    { path: 'runtime-dir/nested', directory: true },
    { id: 'runtime:test', kind: 'runtime', capabilities: { write: ['/workspace/**'], execute: true } },
    'final-diff'
  );
  await workspace.kernel.applyFileChange(
    { path: 'runtime-dir/nested', directory: true, deleted: true },
    { id: 'runtime:test', kind: 'runtime', capabilities: { write: ['/workspace/**'], delete: ['/workspace/**'], execute: true } },
    'final-diff'
  );
  await workspace.deleteFile('user.txt');

  assertCondition(await workspace.readFile('agent.txt') === 'agent\n', 'kernel writeFile should persist through workspace FS');
  assertCondition(await workspace.readFile('runtime.txt') === 'runtime\n', 'kernel final-diff application should persist files');
  assertCondition(!(await workspace.exists('runtime-dir/nested')), 'kernel final-diff application should persist directory deletes');
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.actor?.kind === 'principal' &&
      event.phase === 'live' &&
      event.change.path === 'user.txt' &&
      !('deleted' in event.change)
    ),
    `workspace watch should report user live writes: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.actor?.kind === 'principal' &&
      event.actor.id === 'agent:test' &&
      event.change.path === 'agent.txt'
    ),
    `workspace watch should preserve agent provenance: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.actor?.kind === 'runtime' &&
      event.phase === 'final-diff' &&
      event.change.path === 'runtime.txt'
    ),
    `workspace watch should report runtime final-diff changes: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.actor?.kind === 'runtime' &&
      event.phase === 'final-diff' &&
      event.change.path === 'runtime-dir/nested' &&
      looseChange(event.change).directory === true
    ) &&
      events.some((event) =>
        event.type === 'file-change' &&
        event.actor?.kind === 'runtime' &&
        event.phase === 'final-diff' &&
        event.change.path === 'runtime-dir/nested' &&
        looseChange(event.change).directory === true &&
        looseChange(event.change).deleted === true
      ),
    `workspace watch should report runtime final-diff directory changes: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.actor?.kind === 'principal' &&
      event.change.path === 'user.txt' &&
      'deleted' in event.change &&
      event.change.deleted === true
    ),
    `workspace watch should report deletes: ${JSON.stringify(events)}`
  );

  const countBeforeUnsubscribe = events.length;
  unsubscribe();
  await workspace.writeFile('ignored.txt', 'ignored\n');
  assertCondition(events.length === countBeforeUnsubscribe, 'workspace watch unsubscribe should stop events');
  workspace.dispose();

  const commandEvents: RuntimeWorkspaceEvent[] = [];
  const commandWorkspace = await createRuntimeWorkspace({
    files: [{ path: 'index.js', contents: 'console.log("runner")\n' }],
    nodeRunner: async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      files: [
        { path: 'generated.txt', contents: 'generated\n' },
        { path: 'generated-dir/nested', directory: true },
        { path: 'stale-dir/nested', directory: true, deleted: true },
        { path: 'stale.txt', deleted: true },
      ],
    }),
  });
  await commandWorkspace.writeFile('stale.txt', 'stale\n');
  await commandWorkspace.mkdir('stale-dir/nested');
  commandWorkspace.watch((event) => commandEvents.push(event));
  const commandResult = await commandWorkspace.runCommand('node index.js');
  assertCondition(commandResult.exitCode === 0, 'workspace command should succeed');
  assertCondition(await commandWorkspace.readFile('generated.txt') === 'generated\n', 'command final diff should persist generated files');
  assertCondition((await commandWorkspace.stat('generated-dir/nested')).isDirectory, 'command final diff should persist generated directories');
  await assertRejectsAsync(() => commandWorkspace.readFile('stale.txt'), 'command final diff should persist deletions');
  assertCondition(!(await commandWorkspace.exists('stale-dir/nested')), 'command final diff should persist directory deletions');
  assertCondition(
    commandEvents.some((event) =>
      event.type === 'file-change' &&
      event.actor?.kind === 'runtime' &&
      event.phase === 'final-diff' &&
      event.change.path === 'generated.txt'
    ),
    `workspace watch should report command final-diff writes: ${JSON.stringify(commandEvents)}`
  );
  assertCondition(
    commandEvents.some((event) =>
      event.type === 'file-change' &&
      event.actor?.kind === 'runtime' &&
      event.phase === 'final-diff' &&
      event.change.path === 'generated-dir/nested' &&
      looseChange(event.change).directory === true
    ) &&
      commandEvents.some((event) =>
        event.type === 'file-change' &&
        event.actor?.kind === 'runtime' &&
        event.phase === 'final-diff' &&
        event.change.path === 'stale-dir/nested' &&
        looseChange(event.change).directory === true &&
        looseChange(event.change).deleted === true
      ),
    `workspace watch should report command final-diff directory changes: ${JSON.stringify(commandEvents)}`
  );
  assertCondition(
    commandEvents.some((event) =>
      event.type === 'file-change' &&
      event.actor?.kind === 'runtime' &&
      event.phase === 'final-diff' &&
      event.change.path === 'stale.txt' &&
      'deleted' in event.change
    ),
    `workspace watch should report command final-diff deletes: ${JSON.stringify(commandEvents)}`
  );
  commandWorkspace.dispose();

  const liveRuntimeEvents: RuntimeWorkspaceEvent[] = [];
  const liveReadPromises: Promise<string>[] = [];
  const liveBinaryReadPromises: Promise<string>[] = [];
  const liveDeleteReadPromises: Promise<boolean>[] = [];
  const liveDirectoryStatPromises: Promise<boolean>[] = [];
  let liveTextEventObservedBeforeRunnerReturn = false;
  const liveWorkspace = await createRuntimeWorkspace({
    files: [
      { path: 'live.js', contents: 'console.log("live")\n' },
      { path: 'stale-live.txt', contents: 'stale\n' },
    ],
    nodeRunner: async (request) => {
      request.onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'live-runtime.txt', contents: 'live-runtime\n' } });
      request.onEvent?.({ type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'after-live-text\n' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      liveTextEventObservedBeforeRunnerReturn = liveRuntimeEvents.some((event) =>
        event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change.path === 'live-runtime.txt'
      );
      request.onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'live-bytes.bin', contents: 'AP8=', encoding: 'base64' } });
      request.onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'live-dir/nested', directory: true } });
      request.onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'stale-live.txt', deleted: true } });
      return { stdout: 'live-runner\n', stderr: '', exitCode: 0 };
    },
  });
  const liveResult = await liveWorkspace.runCommand('node live.js', {
    onEvent: (event) => {
      liveRuntimeEvents.push(event);
      if (event.type === 'file-change' && event.phase === 'live' && event.change.path === 'live-runtime.txt') {
        liveReadPromises.push(liveWorkspace.readFile('live-runtime.txt'));
      }
      if (event.type === 'file-change' && event.phase === 'live' && event.change.path === 'live-bytes.bin') {
        liveBinaryReadPromises.push(liveWorkspace.readFile('live-bytes.bin', 'base64'));
      }
      if (event.type === 'file-change' && event.phase === 'live' && event.change.path === 'live-dir/nested') {
        liveDirectoryStatPromises.push(liveWorkspace.stat('live-dir/nested').then((stat) => stat.isDirectory));
      }
      if (event.type === 'file-change' && event.phase === 'live' && event.change.path === 'stale-live.txt') {
        liveDeleteReadPromises.push(liveWorkspace.readFile('stale-live.txt').then(() => false, () => true));
      }
    },
  });
  assertCondition(liveResult.exitCode === 0, `live runtime event command should succeed: ${liveResult.stderr}`);
  assertCondition(
    liveTextEventObservedBeforeRunnerReturn,
    `runtime live file-change event should be emitted before the runner completes: ${JSON.stringify(liveRuntimeEvents)}`
  );
  const liveTextEventIndex = liveRuntimeEvents.findIndex((event) =>
    event.type === 'file-change' &&
    event.phase === 'live' &&
    event.change.path === 'live-runtime.txt'
  );
  const outputAfterTextIndex = liveRuntimeEvents.findIndex((event) =>
    event.type === 'output' &&
    event.stream === 'stdout' &&
    event.data === 'after-live-text\n'
  );
  assertCondition(
    liveTextEventIndex >= 0 && outputAfterTextIndex > liveTextEventIndex,
    `runtime event queue should preserve file-change before later stdout: ${JSON.stringify(liveRuntimeEvents)}`
  );
  assertCondition(await liveWorkspace.readFile('live-runtime.txt') === 'live-runtime\n', 'runtime live file-change events should update workspace files');
  assertCondition(await liveWorkspace.readFile('live-bytes.bin', 'base64') === 'AP8=', 'runtime live binary file-change events should update workspace files');
  assertCondition((await liveWorkspace.stat('live-dir/nested')).isDirectory, 'runtime live directory-change events should update workspace directories');
  await assertRejectsAsync(() => liveWorkspace.readFile('stale-live.txt'), 'runtime live deletion events should update workspace files');
  assertCondition(
    (await Promise.all(liveReadPromises)).includes('live-runtime\n'),
    `runtime live text changes should be readable before onEvent returns: ${JSON.stringify(liveRuntimeEvents)}`
  );
  assertCondition(
    (await Promise.all(liveBinaryReadPromises)).includes('AP8='),
    `runtime live binary changes should be readable before onEvent returns: ${JSON.stringify(liveRuntimeEvents)}`
  );
  assertCondition(
    (await Promise.all(liveDirectoryStatPromises)).includes(true),
    `runtime live directory changes should be visible before onEvent returns: ${JSON.stringify(liveRuntimeEvents)}`
  );
  assertCondition(
    (await Promise.all(liveDeleteReadPromises)).includes(true),
    `runtime live deletions should be visible before onEvent returns: ${JSON.stringify(liveRuntimeEvents)}`
  );
  liveWorkspace.dispose();

  let repeatedLiveRunCount = 0;
  const repeatedLiveEvents: RuntimeWorkspaceEvent[] = [];
  const repeatedLiveWorkspace = await createRuntimeWorkspace({
    files: [
      { path: 'first.js', contents: 'console.log("first")\n' },
      { path: 'second.js', contents: 'console.log("second")\n' },
    ],
    nodeRunner: async (request) => {
      repeatedLiveRunCount += 1;
      request.onEvent?.({
        type: 'file-change',
        phase: 'live',
        change: { path: 'shared.txt', contents: `live-${repeatedLiveRunCount}\n` },
      });
      return {
        stdout: `${request.scriptPath}\n`,
        stderr: '',
        exitCode: 0,
        files: [{ path: 'shared.txt', contents: `final-${repeatedLiveRunCount}\n` }],
      };
    },
  });
  const repeatedLiveResult = await repeatedLiveWorkspace.runCommand('node first.js && node second.js', {
    onEvent: (event) => repeatedLiveEvents.push(event),
  });
  assertCondition(repeatedLiveResult.exitCode === 0, `repeated live project runners should succeed: ${JSON.stringify(repeatedLiveResult)}`);
  assertCondition(
    repeatedLiveEvents.filter((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'shared.txt'
    ).length === 2,
    `live file-change events should remain active across multiple project runners: ${JSON.stringify(repeatedLiveEvents)}`
  );
  assertCondition(
    await repeatedLiveWorkspace.readFile('shared.txt') === 'final-2\n',
    'later project runner final diffs should not be filtered by earlier live file changes'
  );
  repeatedLiveWorkspace.dispose();

  const failedLiveEvents: RuntimeWorkspaceEvent[] = [];
  const failedLiveWorkspace = await createRuntimeWorkspace({
    files: [{ path: 'bad-live.js', contents: 'console.log("bad")\n' }],
    nodeRunner: async (request) => {
      request.onEvent?.({ type: 'file-change', phase: 'live', change: { path: '/proc/kernel/info', contents: '{}\n' } });
      request.onEvent?.({ type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'after-bad-live\n' });
      return { stdout: 'bad-live-runner\n', stderr: '', exitCode: 0 };
    },
  });
  let failedLiveError = '';
  let failedLiveResult: RuntimeCommandResult | null = null;
  try {
    failedLiveResult = await failedLiveWorkspace.runCommand('node bad-live.js', {
      onEvent: (event) => failedLiveEvents.push(event),
    });
  } catch (error) {
    failedLiveError = error instanceof Error ? error.message : String(error);
  }
  const failedLiveMessage = failedLiveError || failedLiveResult?.stderr || '';
  assertCondition(
    failedLiveMessage.includes('Project path must stay inside the workspace') ||
      failedLiveMessage.includes('Kernel proc path is read-only') ||
      failedLiveMessage.includes('TraceKernel file-change path must be relative'),
    `invalid live file-change should fail the command with a filesystem error: ${JSON.stringify({ failedLiveError, failedLiveResult })}`
  );
  assertCondition(
    !failedLiveEvents.some((event) => event.type === 'output' && event.data === 'after-bad-live\n'),
    `runtime event queue should stop later output after a failed live file-change: ${JSON.stringify(failedLiveEvents)}`
  );
  failedLiveWorkspace.dispose();

  const shellWorkspace = await createRuntimeWorkspace();
  const shellWatchEvents: RuntimeWorkspaceEvent[] = [];
  const shellCommandEvents: RuntimeCommandEvent[] = [];
  shellWorkspace.watch((event) => shellWatchEvents.push(event));
  const shellResult = await shellWorkspace.runCommand(
    'mkdir -p shell-dir/nested && printf "live\\n" > live.txt && printf "again\\n" >> live.txt && cp live.txt copied.txt && mv copied.txt moved.txt && rm live.txt && rmdir shell-dir/nested',
    { onEvent: (event) => shellCommandEvents.push(event) }
  );
  assertCondition(shellResult.exitCode === 0, `shell filesystem mutation command should succeed: ${shellResult.stderr}`);
  assertCondition(await shellWorkspace.readFile('moved.txt') === 'live\nagain\n', 'shell filesystem mutations should persist through just-bash FS');
  await assertRejectsAsync(() => shellWorkspace.readFile('live.txt'), 'shell rm should persist deleted files');
  assertCondition(
    shellWatchEvents.some((event) =>
      event.type === 'file-change' &&
      event.actor?.kind === 'runtime' &&
      event.phase === 'live' &&
      event.change.path === 'live.txt' &&
      !('deleted' in event.change) &&
      looseChange(event.change).contents === 'live\nagain\n'
    ),
    `workspace watch should report live shell append writes: ${JSON.stringify(shellWatchEvents)}`
  );
  assertCondition(
    shellWatchEvents.some((event) =>
      event.type === 'file-change' &&
      event.actor?.kind === 'runtime' &&
      event.phase === 'live' &&
      event.change.path === 'live.txt' &&
      'deleted' in event.change
    ),
    `workspace watch should report live shell deletes: ${JSON.stringify(shellWatchEvents)}`
  );
  assertCondition(
    shellCommandEvents.some((event) =>
      event.type === 'file-change' &&
      event.actor?.kind === 'runtime' &&
      event.phase === 'live' &&
      event.change.path === 'moved.txt'
    ),
    `runCommand onEvent should receive live shell filesystem mutations: ${JSON.stringify(shellCommandEvents)}`
  );
  assertCondition(
    shellCommandEvents.some((event) =>
      event.type === 'file-change' &&
        event.actor?.kind === 'runtime' &&
        event.phase === 'live' &&
        event.change.path === 'shell-dir/nested' &&
        'directory' in event.change &&
        event.change.directory === true
    ) &&
      shellCommandEvents.some((event) =>
        event.type === 'file-change' &&
          event.actor?.kind === 'runtime' &&
          event.phase === 'live' &&
          event.change.path === 'shell-dir/nested' &&
          'directory' in event.change &&
          event.change.directory === true &&
          event.change.deleted === true
      ),
    `runCommand onEvent should receive live shell directory mutations: ${JSON.stringify(shellCommandEvents)}`
  );
  shellWorkspace.dispose();

  const deviceWorkspace = await createRuntimeWorkspace();
  const deviceWatchEvents: RuntimeWorkspaceEvent[] = [];
  const deviceCommandEvents: RuntimeCommandEvent[] = [];
  deviceWorkspace.watch((event) => deviceWatchEvents.push(event));
  const stdinResult = await deviceWorkspace.runCommand('cat /dev/stdin', { stdinPipe: stdinPipe('from-stdin\n') });
  assertCondition(stdinResult.stdout === 'from-stdin\n', `/dev/stdin should feed command stdin: ${JSON.stringify(stdinResult)}`);
  const stdoutResult = await deviceWorkspace.runCommand('printf "device-out\\n" > /dev/stdout', {
    onEvent: (event) => deviceCommandEvents.push(event),
  });
  assertCondition(stdoutResult.stdout === 'device-out\n', `/dev/stdout writes should be command stdout: ${JSON.stringify(stdoutResult)}`);
  const ttyResult = await deviceWorkspace.runCommand('printf "tty-out\\n" > /dev/tty', {
    onEvent: (event) => deviceCommandEvents.push(event),
  });
  assertCondition(ttyResult.stdout === 'tty-out\n', `/dev/tty writes should route to command stdout: ${JSON.stringify(ttyResult)}`);
  const stderrResult = await deviceWorkspace.runCommand('printf "device-err\\n" > /dev/stderr');
  assertCondition(stderrResult.stderr === 'device-err\n', `/dev/stderr writes should be command stderr: ${JSON.stringify(stderrResult)}`);
  const nullResult = await deviceWorkspace.runCommand('cat /dev/null && printf "discarded\\n" > /dev/null', {
    onEvent: (event) => deviceCommandEvents.push(event),
  });
  assertCondition(nullResult.stdout === '' && nullResult.stderr === '', `/dev/null should read EOF and discard writes: ${JSON.stringify(nullResult)}`);
  const shellCopyVirtualResult = await deviceWorkspace.runCommand(
    'cp /proc/kernel/info shell-proc-info.json && cp shell-proc-info.json /dev/stdout',
    { onEvent: (event) => deviceCommandEvents.push(event) }
  );
  assertCondition(shellCopyVirtualResult.exitCode === 0, `shell cp virtual files should succeed: ${shellCopyVirtualResult.stderr}`);
  assertCondition(
    JSON.parse(await deviceWorkspace.readFile('shell-proc-info.json')).name === 'tracekernel',
    'shell cp should read /proc sources through the kernel copy target'
  );
  assertCondition(
    shellCopyVirtualResult.stdout === await deviceWorkspace.readFile('shell-proc-info.json'),
    `shell cp should write /dev/stdout destinations through the kernel copy target: ${JSON.stringify(shellCopyVirtualResult)}`
  );
  assertCondition(
    deviceCommandEvents.some((event) =>
      event.type === 'output' &&
      event.stream === 'stdout' &&
      event.device === '/dev/stdout' &&
      event.data === 'device-out\n'
    ),
    `runCommand onEvent should receive /dev/stdout output events: ${JSON.stringify(deviceCommandEvents)}`
  );
  assertCondition(
    deviceCommandEvents.some((event) =>
      event.type === 'output' &&
      event.stream === 'stdout' &&
      event.device === '/dev/stdout' &&
      event.sourceDevice === '/dev/tty' &&
      event.data === 'tty-out\n'
    ),
    `runCommand onEvent should preserve /dev/tty source device: ${JSON.stringify(deviceCommandEvents)}`
  );
  assertCondition((await deviceWorkspace.readDir('/dev')).join(',') === 'fd,null,stderr,stdin,stdout,tty', '/dev should list kernel devices');
  assertCondition((await deviceWorkspace.readDir('/dev/fd')).join(',') === '0,1,2', '/dev/fd should list standard descriptors');
  const fdStat = await deviceWorkspace.stat('/dev/fd');
  assertCondition(fdStat.isDirectory && !fdStat.isFile, '/dev/fd should stat as a directory');
  const stdoutStat = await deviceWorkspace.stat('/dev/stdout');
  assertCondition(stdoutStat.isFile && !stdoutStat.isDirectory, '/dev/stdout should stat as a file device');
  assertCondition(await deviceWorkspace.readFile('/dev/null') === '', '/dev/null reads should return EOF');
  await assertRejectsAsync(() => deviceWorkspace.readFile('/dev/stdout'), 'readFile should reject unreadable /dev/stdout');
  await assertRejectsAsync(() => deviceWorkspace.writeFile('/dev/stdin', 'blocked\n'), '/dev/stdin should be read-only');
  await deviceWorkspace.writeFile('/dev/stdout', 'principal-out\n');
  await deviceWorkspace.writeFile('/dev/null', 'discarded-principal\n');
  await deviceWorkspace.writeFile('/dev/tty', 'principal-tty\n');
  await deviceWorkspace.writeFile('copy-device.txt', 'copy-device-out\n');
  await deviceWorkspace.copyFile('copy-device.txt', '/dev/stdout');
  await deviceWorkspace.copyFile('copy-device.txt', '/dev/tty');
  await assertRejectsAsync(() => deviceWorkspace.copyFile('/dev/stdout', 'stdout-copy.txt'), 'copyFile should reject unreadable /dev/stdout sources');
  await assertRejectsAsync(() => deviceWorkspace.copyFile('copy-device.txt', '/proc/kernel/info'), 'copyFile should reject /proc destinations');
  await deviceWorkspace.copyFile('/proc/kernel/info', 'copied-proc-info.json');
  assertCondition(
    JSON.parse(await deviceWorkspace.readFile('copied-proc-info.json')).name === 'tracekernel',
    'copyFile should read /proc sources through kernel read target'
  );
  await deviceWorkspace.copyFile('/proc/kernel/version', 'copied-proc-version.txt');
  assertCondition(
    (await deviceWorkspace.readFile('copied-proc-version.txt')).startsWith('tracekernel '),
    'copyFile should read /proc/kernel/version through kernel read target'
  );
  const observedFs = (deviceWorkspace as unknown as {
    fs: {
      readFile?: (path: string) => Promise<string>;
      readFileBytes?: (path: string) => Promise<unknown>;
      readFileBuffer?: (path: string) => Promise<Uint8Array>;
      stat?: (path: string) => Promise<RuntimeWorkspaceStat>;
      lstat?: (path: string) => Promise<RuntimeWorkspaceStat>;
      realpath?: (path: string) => Promise<string>;
    };
  }).fs;
  const procVersionBytes = await observedFs.readFileBytes?.('/proc/kernel/version');
  assertCondition(
    typeof procVersionBytes === 'string' && procVersionBytes.startsWith('tracekernel '),
    `observed filesystem readFileBytes should return byte strings for /proc files: ${String(procVersionBytes)}`
  );
  const observedProcInfoStat = await observedFs.stat?.('/proc/kernel/info');
  const observedDevStdoutStat = await observedFs.lstat?.('/dev/stdout');
  const observedProcRealpath = await observedFs.realpath?.('/proc/kernel/info');
  assertCondition(
    observedProcInfoStat?.isFile === true && observedProcInfoStat.isDirectory === false,
    `observed filesystem stat should use kernel read targets for /proc files: ${JSON.stringify(observedProcInfoStat)}`
  );
  assertCondition(
    observedDevStdoutStat?.isFile === true && observedDevStdoutStat.isDirectory === false,
    `observed filesystem lstat should use kernel read targets for /dev files: ${JSON.stringify(observedDevStdoutStat)}`
  );
  assertCondition(
    observedProcRealpath === '/proc/kernel/info',
    `observed filesystem realpath should preserve virtual kernel paths: ${String(observedProcRealpath)}`
  );
  await assertRejectsAsync(
    () => observedFs.stat?.('/dev/missing') ?? Promise.reject(new Error('stat missing')),
    'observed filesystem stat should reject unknown /dev paths through the kernel read target'
  );
  const assertReturnsRejectedPromise = async (read: () => Promise<unknown> | undefined, message: string) => {
    let promise: Promise<unknown> | undefined;
    try {
      promise = read();
    } catch (error) {
      throw new Error(`${message} threw synchronously: ${error instanceof Error ? error.message : String(error)}`);
    }
    await assertRejectsAsync(() => promise ?? Promise.reject(new Error('read method missing')), message);
  };
  await assertReturnsRejectedPromise(
    () => observedFs.readFile?.('/dev/missing'),
    'observed filesystem readFile should return a rejected Promise for kernel read errors'
  );
  await assertReturnsRejectedPromise(
    () => observedFs.readFileBytes?.('/dev/missing'),
    'observed filesystem readFileBytes should return a rejected Promise for kernel read errors'
  );
  await assertReturnsRejectedPromise(
    () => observedFs.readFileBuffer?.('/dev/missing'),
    'observed filesystem readFileBuffer should return a rejected Promise for kernel read errors'
  );
  const observedVirtualFs = observedFs as {
    symlink?: (target: string, linkPath: string) => Promise<void>;
    link?: (existingPath: string, newPath: string) => Promise<void>;
    readlink?: (path: string) => Promise<string>;
  };
  await assertRejectsAsync(
    () => observedVirtualFs.symlink?.('target.txt', '/proc/kernel/link') ?? Promise.reject(new Error('symlink missing')),
    'observed filesystem symlink should reject /proc link paths'
  );
  await assertRejectsAsync(
    () => observedVirtualFs.link?.('/proc/kernel/info', 'proc-hardlink.json') ?? Promise.reject(new Error('link missing')),
    'observed filesystem link should reject /proc sources'
  );
  await assertRejectsAsync(
    () => observedVirtualFs.link?.('copy-device.txt', '/dev/stdout') ?? Promise.reject(new Error('link missing')),
    'observed filesystem link should reject /dev destinations'
  );
  await assertRejectsAsync(
    () => observedVirtualFs.readlink?.('/proc/kernel/info') ?? Promise.reject(new Error('readlink missing')),
    'observed filesystem readlink should reject /proc files'
  );
  await assertRejectsAsync(() => deviceWorkspace.mkdir('/proc/new'), 'mkdir should reject /proc paths');
  await assertRejectsAsync(() => deviceWorkspace.remove('/dev/stdout'), 'remove should reject /dev paths');
  await assertRejectsAsync(() => deviceWorkspace.deleteFile('/dev/stdout'), 'deleteFile should reject /dev paths');
  assertCondition(
    deviceWatchEvents.some((event) =>
      event.type === 'output' &&
      event.actor?.kind === 'principal' &&
      event.device === '/dev/stdout' &&
      event.data === 'principal-out\n'
    ),
    `workspace writeFile should emit /dev/stdout output events: ${JSON.stringify(deviceWatchEvents)}`
  );
  assertCondition(
    deviceWatchEvents.some((event) =>
      event.type === 'output' &&
      event.actor?.kind === 'principal' &&
      event.device === '/dev/stdout' &&
      event.data === 'copy-device-out\n'
    ),
    `workspace copyFile should route /dev/stdout through kernel write target: ${JSON.stringify(deviceWatchEvents)}`
  );
  assertCondition(
    deviceWatchEvents.some((event) =>
      event.type === 'output' &&
      event.actor?.kind === 'principal' &&
      event.device === '/dev/stdout' &&
      event.sourceDevice === '/dev/tty' &&
      event.data === 'principal-tty\n'
    ) &&
      deviceWatchEvents.some((event) =>
        event.type === 'output' &&
        event.actor?.kind === 'principal' &&
        event.device === '/dev/stdout' &&
        event.sourceDevice === '/dev/tty' &&
        event.data === 'copy-device-out\n'
      ),
    `workspace principal writes should preserve /dev/tty source device: ${JSON.stringify(deviceWatchEvents)}`
  );
  deviceWorkspace.dispose();
}

async function testWorkspaceTerminalSessionCwd(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    kernel: {
      user: { username: 'obi' },
      host: { hostname: 'tracevm' },
      workspace: { name: 'weather-api' },
    },
    files: [
      { path: 'main.txt', contents: 'root\n' },
      { path: 'src/app.txt', contents: 'src\n' },
      { path: 'main.js', contents: 'console.log("node-ok");\n' },
      { path: 'ask.js', contents: 'process.stdout.write("Name: ");\n' },
    ],
    nodeRunner: async (request) => {
      if (request.scriptPath.endsWith('ask.js')) {
        request.onEvent?.({ type: 'output', stream: 'stdout', data: 'Name: ' });
        const stdin = readTestRequestStdin(request).trim();
        request.onEvent?.({ type: 'output', stream: 'stdout', data: `answer=${stdin}\n` });
        return { stdout: `Name: answer=${stdin}\n`, stderr: '', exitCode: 0 };
      }
      request.onEvent?.({ type: 'status', phase: 'process-start', message: 'Starting browser Node' });
      return { stdout: 'node-ok\n', stderr: '', exitCode: 0 };
    },
  });
  await workspace.mkdir('src/nested');
  await workspace.writeFile('src/server.ts', '');
  await workspace.writeFile('src/service.ts', '');

  const session = workspace.createTerminalSession();
  assertCondition(session.cwd === '/home/obi/weather-api', `terminal session should start at workspace root: ${session.cwd}`);
  assertCondition(session.prompt.text === 'obi@tracevm weather-api $', `terminal prompt should use kernel identity: ${session.prompt.text}`);

  const cdSrc = await session.run('cd src');
  assertCondition(cdSrc.exitCode === 0, `terminal cd should succeed: ${cdSrc.stderr}`);
  assertCondition((session.cwd as string) === '/home/obi/weather-api/src', `terminal cd should update session cwd: ${session.cwd}`);
  assertCondition((session.prompt.text as string) === 'obi@tracevm src $', `terminal prompt should follow cwd basename: ${session.prompt.text}`);

  const pwd = await session.run('pwd');
  assertCondition(pwd.stdout === '/home/obi/weather-api/src\n', `terminal pwd should read session cwd: ${JSON.stringify(pwd)}`);
  const cat = await session.run('cat app.txt');
  assertCondition(cat.stdout === 'src\n', `terminal commands should run from session cwd: ${JSON.stringify(cat)}`);

  const cdParent = await session.run('cd ..');
  assertCondition(cdParent.exitCode === 0 && session.cwd === '/home/obi/weather-api', `terminal cd .. should return to root: ${session.cwd}`);
  const compoundCd = await session.run('cd src && pwd');
  assertCondition(
    compoundCd.exitCode === 0 &&
      compoundCd.stdout === '/home/obi/weather-api/src\n' &&
      (session.cwd as string) === '/home/obi/weather-api/src',
    `terminal compound cd should update session cwd after command completion: ${JSON.stringify({ compoundCd, cwd: session.cwd })}`
  );
  const compoundCdBack = await session.run('cd .. && pwd');
  assertCondition(
    compoundCdBack.exitCode === 0 &&
      compoundCdBack.stdout === '/home/obi/weather-api\n' &&
      session.cwd === '/home/obi/weather-api',
    `terminal compound cd .. should update session cwd after command completion: ${JSON.stringify({ compoundCdBack, cwd: session.cwd })}`
  );
  const exportSet = await session.run('export TRACE_TERM_ENV=alpha');
  assertCondition(exportSet.exitCode === 0, `terminal export should succeed: ${JSON.stringify(exportSet)}`);
  const exportEcho = await session.run('echo "$TRACE_TERM_ENV"');
  assertCondition(exportEcho.stdout === 'alpha\n', `terminal export should persist across submissions: ${JSON.stringify(exportEcho)}`);
  const plainAssign = await session.run('PLAIN_TERM_VAR=beta');
  assertCondition(plainAssign.exitCode === 0, `terminal assignment should succeed: ${JSON.stringify(plainAssign)}`);
  const plainEcho = await session.run('echo "$PLAIN_TERM_VAR"');
  assertCondition(plainEcho.stdout === 'beta\n', `terminal shell assignments should persist across submissions: ${JSON.stringify(plainEcho)}`);
  const mutateEnv = await session.run('export TRACE_TERM_ENV=delta; unset PLAIN_TERM_VAR');
  assertCondition(mutateEnv.exitCode === 0, `terminal export overwrite should succeed: ${JSON.stringify(mutateEnv)}`);
  const mutatedEcho = await session.run('echo "$TRACE_TERM_ENV:${PLAIN_TERM_VAR-unset}"');
  assertCondition(
    mutatedEcho.stdout === 'delta:unset\n',
    `terminal export overwrite and unset should persist across submissions: ${JSON.stringify(mutatedEcho)}`
  );
  const overlayEcho = await session.run('echo "$OVERLAY_ONCE"', { env: { OVERLAY_ONCE: 'once' } });
  assertCondition(overlayEcho.stdout === 'once\n', `terminal per-run env overlays should apply: ${JSON.stringify(overlayEcho)}`);
  const overlayGone = await session.run('echo "${OVERLAY_ONCE-gone}"');
  assertCondition(
    overlayGone.stdout === 'gone\n',
    `terminal per-run env overlays should not persist onto the session: ${JSON.stringify(overlayGone)}`
  );
  const envPwd = await session.run('pwd');
  assertCondition(
    envPwd.stdout === '/home/obi/weather-api\n',
    `terminal env persistence should not disturb session cwd: ${JSON.stringify(envPwd)}`
  );

  const cdHome = await session.run('cd ..');
  assertCondition(cdHome.exitCode === 0 && (session.cwd as string) === '/home/obi', `terminal cd .. should allow read-only home navigation: ${session.cwd}`);
  assertCondition((session.prompt.text as string) === 'obi@tracevm ~ $', `terminal prompt should label home cwd: ${session.prompt.text}`);
  const homePwd = await session.run('pwd');
  assertCondition(homePwd.stdout === '/home/obi\n', `terminal pwd should allow home cwd: ${JSON.stringify(homePwd)}`);
  const homeLs = await session.run('ls');
  assertCondition(homeLs.stdout.includes('weather-api'), `terminal ls from home should show workspace directory: ${JSON.stringify(homeLs)}`);
  const homeLongLs = await session.run('ls -l');
  assertCondition(
    /^drwxr-xr-x\s+1\s+obi\s+obi\s+\s*0\s+.+\s+weather-api\/$/m.test(homeLongLs.stdout),
    `terminal ls -l should show user ownership for workspace directories: ${JSON.stringify(homeLongLs)}`
  );
  const rootLongLs = await session.run('ls -l /');
  assertCondition(
    /^drwxr-xr-x\s+1\s+root\s+root\s+\s*0\s+.+\s+home\/$/m.test(rootLongLs.stdout),
    `terminal ls -l / should show root ownership for kernel root directories: ${JSON.stringify(rootLongLs)}`
  );
  const procLongLs = await session.run('ls -l /proc');
  assertCondition(
    /^dr-xr-xr-x\s+1\s+root\s+root\s+\s*0\s+.+\s+kernel\/$/m.test(procLongLs.stdout) &&
      /^dr-xr-xr-x\s+1\s+root\s+root\s+\s*0\s+.+\s+self\/$/m.test(procLongLs.stdout),
    `terminal ls -l /proc should show read-only root-owned proc directories: ${JSON.stringify(procLongLs)}`
  );
  const homeCompletion = await workspace.completeCommand('cd we', 'cd we'.length, { cwd: session.cwd });
  assertCondition(
    homeCompletion?.input === 'cd weather-api/' &&
      homeCompletion.cursor === 'cd weather-api/'.length,
    `workspace command completion should see terminal home cwd entries: ${JSON.stringify(homeCompletion)}`
  );
  const homeWrite = await session.run('mkdir outside-project');
  assertCondition(
    homeWrite.exitCode !== 0 &&
      homeWrite.stderr.includes("mkdir: cannot create directory 'outside-project': Read-only file system"),
    `terminal writes outside the project should fail at kernel boundary: ${JSON.stringify(homeWrite)}`
  );
  const cdBackToWorkspace = await session.run('cd weather-api');
  assertCondition(cdBackToWorkspace.exitCode === 0 && session.cwd === '/home/obi/weather-api', `terminal should return from home to workspace: ${session.cwd}`);
  const workspaceCompletion = await workspace.completeCommand('cd sr', 'cd sr'.length, { cwd: session.cwd });
  assertCondition(
    workspaceCompletion?.input === 'cd src/' &&
      workspaceCompletion.cursor === 'cd src/'.length &&
      workspaceCompletion.matches.length === 1 &&
      workspaceCompletion.matches[0]?.kind === 'directory',
    `workspace command completion should complete project directory entries: ${JSON.stringify(workspaceCompletion)}`
  );
  const partialFileCompletion = await workspace.completeCommand('cat src/se', 'cat src/se'.length, { cwd: session.cwd });
  assertCondition(
    partialFileCompletion?.input === 'cat src/serv' &&
      partialFileCompletion.cursor === 'cat src/serv'.length &&
      partialFileCompletion.replacementChanged &&
      partialFileCompletion.matches.map((match) => `${match.name}:${match.kind}`).join(',') === 'server.ts:file,service.ts:file',
    `workspace command completion should extend ambiguous file prefixes: ${JSON.stringify(partialFileCompletion)}`
  );
  const unchangedFileCompletion = await workspace.completeCommand('cat src/serv', 'cat src/serv'.length, { cwd: session.cwd });
  assertCondition(
    unchangedFileCompletion?.input === 'cat src/serv' &&
      unchangedFileCompletion.cursor === 'cat src/serv'.length &&
      !unchangedFileCompletion.replacementChanged &&
      unchangedFileCompletion.matches.map((match) => match.name).join(',') === 'server.ts,service.ts',
    `workspace command completion should expose ambiguous choices when the prefix cannot advance: ${JSON.stringify(unchangedFileCompletion)}`
  );
  const aliasCd = await session.run('cd /workspace/src/nested');
  assertCondition(aliasCd.exitCode === 0, `terminal cd should accept workspace alias: ${aliasCd.stderr}`);
  assertCondition((session.cwd as string) === '/home/obi/weather-api/src/nested', `terminal alias cd should canonicalize cwd: ${session.cwd}`);

  const escape = await session.run('cd ../../../..');
  assertCondition(escape.exitCode !== 0, 'terminal cd should reject home escapes');
  assertCondition((session.cwd as string) === '/home/obi/weather-api/src/nested', 'failed terminal cd should preserve cwd');

  const quietEvents: RuntimeCommandEvent[] = [];
  const quietNode = await session.run('node /workspace/main.js', { onEvent: (event) => quietEvents.push(event) });
  assertCondition(quietNode.exitCode === 0 && quietNode.stdout === 'node-ok\n', `quiet terminal Node should still run: ${JSON.stringify(quietNode)}`);
  assertCondition(
    !quietEvents.some((event) => event.type === 'status') &&
      quietEvents.some((event) => event.type === 'output' && event.data === 'node-ok\n'),
    `terminal sessions should hide status events by default while preserving output: ${JSON.stringify(quietEvents)}`
  );

  const terminalEvents: RuntimeProjectTerminalEvent[] = [];
  const stdinCommandEvents: RuntimeCommandEvent[] = [];
  const stdinSession = workspace.createTerminalSession({
    onTerminalEvent: (event) => {
      terminalEvents.push(event);
      if ((event as { reason?: string }).reason === 'stdin-prompt') {
        stdinSession.writeStdin('Ada\n');
      }
    },
  });
  const stdinNode = await stdinSession.run('node ask.js', {
    onEvent: (event) => stdinCommandEvents.push(event),
  });
  assertCondition(stdinNode.exitCode === 0 && stdinNode.stdout === 'Name: answer=Ada\n', `terminal stdin run should complete: ${JSON.stringify(stdinNode)}`);
  assertCondition(
    terminalEvents.map((event) => (event as { reason?: string }).reason).join(',') === 'command-start,stdin-prompt,stdin-submit,command-finish',
    `terminal sessions should publish formal input-state transitions: ${JSON.stringify(terminalEvents)}`
  );
  assertCondition(
    stdinCommandEvents.some((event) => event.type === 'output' && event.terminal?.role === 'stdin-prompt'),
    `terminal stdin prompt output should carry terminal metadata: ${JSON.stringify(stdinCommandEvents)}`
  );
  assertCondition(
    stdinSession.inputState.mode === 'command' && stdinSession.inputState.label === 'obi@tracevm weather-api $',
    `terminal input state should return to command prompt after stdin run: ${JSON.stringify(stdinSession.inputState)}`
  );

  let releaseTerminalCommand!: () => void;
  const terminalCommandReleased = new Promise<void>((resolve) => {
    releaseTerminalCommand = resolve;
  });
  let terminalCommandStarted!: () => void;
  const terminalCommandStartedPromise = new Promise<void>((resolve) => {
    terminalCommandStarted = resolve;
  });
  const terminalConcurrencyWorkspace = await createRuntimeWorkspace({
    files: [{ path: 'slow-terminal.js', contents: 'console.log("slow")\n' }],
    nodeRunner: async () => {
      terminalCommandStarted();
      await terminalCommandReleased;
      return { stdout: 'slow:done\n', stderr: '', exitCode: 0 };
    },
  });
  const oneCommandSession = terminalConcurrencyWorkspace.createTerminalSession();
  const firstTerminalRun = oneCommandSession.run('node slow-terminal.js');
  await terminalCommandStartedPromise;
  const foregroundTerminalPid = await processPidForCommand(terminalConcurrencyWorkspace, 'node slow-terminal.js');
  const foregroundTerminalStatus = await terminalConcurrencyWorkspace.readFile(`/proc/${foregroundTerminalPid}/status`);
  assertCondition(
    foregroundTerminalStatus.includes('Tty:\t/dev/tty\n') &&
      foregroundTerminalStatus.includes('Foreground:\t1\n'),
    `foreground terminal session command should own the terminal tty: ${JSON.stringify(foregroundTerminalStatus)}`
  );
  const sameSessionSecondRun = await oneCommandSession.run('pwd');
  assertCondition(
    sameSessionSecondRun.exitCode === 16 &&
      sameSessionSecondRun.error?.code === 'EBUSY' &&
      oneCommandSession.inputState.mode === 'busy',
    `same terminal session should reject overlapping foreground commands and stay busy: ${JSON.stringify({ sameSessionSecondRun, inputState: oneCommandSession.inputState })}`
  );
  const parallelSession = terminalConcurrencyWorkspace.createTerminalSession();
  const parallelPwd = await parallelSession.run('pwd');
  assertCondition(
    parallelPwd.exitCode === 0 && parallelPwd.stdout === '/workspace\n',
    `a separate terminal session should run while another session is busy: ${JSON.stringify(parallelPwd)}`
  );
  releaseTerminalCommand();
  const firstTerminalResult = await firstTerminalRun;
  assertCondition(
    firstTerminalResult.exitCode === 0 &&
      firstTerminalResult.stdout === 'slow:done\n' &&
      (oneCommandSession.inputState.mode as string) === 'command',
    `busy terminal session should return to command mode after its command completes: ${JSON.stringify({ firstTerminalResult, inputState: oneCommandSession.inputState })}`
  );

  let interruptibleTerminalCommandStarted!: () => void;
  const interruptibleTerminalCommandStartedPromise = new Promise<void>((resolve) => {
    interruptibleTerminalCommandStarted = resolve;
  });
  const interruptibleTerminalWorkspace = await createRuntimeWorkspace({
    files: [{ path: 'interruptible.js', contents: 'await new Promise(() => {})\n' }],
    nodeRunner: async (request) => {
      interruptibleTerminalCommandStarted();
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) {
          resolve();
          return;
        }
        request.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const interruptibleTerminalSession = interruptibleTerminalWorkspace.createTerminalSession();
  assertCondition(
    interruptibleTerminalSession.interrupt() === false,
    'an idle terminal session should report that there is no foreground command to interrupt'
  );
  const interruptibleTerminalRun = interruptibleTerminalSession.run('node interruptible.js');
  await interruptibleTerminalCommandStartedPromise;
  assertCondition(
    interruptibleTerminalSession.interrupt() === true && interruptibleTerminalSession.interrupt() === false,
    'terminal interrupt should signal the active foreground command exactly once'
  );
  const interruptedTerminalResult = await interruptibleTerminalRun;
  assertCondition(
    interruptedTerminalResult.exitCode === 130 &&
      interruptedTerminalResult.error?.detail?.signal === 'SIGINT' &&
      interruptibleTerminalSession.inputState.mode === 'command',
    `terminal interrupt should deliver SIGINT, return exit 130, and restore the prompt: ${JSON.stringify({ interruptedTerminalResult, inputState: interruptibleTerminalSession.inputState })}`
  );
  await interruptibleTerminalWorkspace.destroy();

  let releaseBackgroundTerminalCommand!: () => void;
  const backgroundTerminalCommandReleased = new Promise<void>((resolve) => {
    releaseBackgroundTerminalCommand = resolve;
  });
  let backgroundTerminalCommandStarted!: () => void;
  const backgroundTerminalCommandStartedPromise = new Promise<void>((resolve) => {
    backgroundTerminalCommandStarted = resolve;
  });
  const terminalBackgroundWorkspace = await createRuntimeWorkspace({
    files: [{ path: 'background-terminal.js', contents: 'console.log("background")\n' }],
    nodeRunner: async () => {
      backgroundTerminalCommandStarted();
      await backgroundTerminalCommandReleased;
      return { stdout: 'background:done\n', stderr: '', exitCode: 0 };
    },
  });
  const backgroundSession = terminalBackgroundWorkspace.createTerminalSession();
  const backgroundStart = await backgroundSession.run('node background-terminal.js &');
  const backgroundPid = await processPidForCommand(terminalBackgroundWorkspace, 'node background-terminal.js');
  assertCondition(
    backgroundStart.exitCode === 0 &&
      backgroundStart.stdout === `[1] ${backgroundPid}\n` &&
      backgroundSession.inputState.mode === 'command',
    `terminal background command should return the prompt immediately: ${JSON.stringify({ backgroundStart, inputState: backgroundSession.inputState })}`
  );
  await backgroundTerminalCommandStartedPromise;
  const backgroundPwd = await backgroundSession.run('pwd');
  assertCondition(
    backgroundPwd.exitCode === 0 && backgroundPwd.stdout === '/workspace\n',
    `terminal session should accept a new foreground command while a background job runs: ${JSON.stringify(backgroundPwd)}`
  );
  const backgroundStatus = await terminalBackgroundWorkspace.readFile(`/proc/${backgroundPid}/status`);
  assertCondition(
    backgroundStatus.includes('Tty:\t/dev/tty\n') &&
      backgroundStatus.includes('Foreground:\t0\n'),
    `terminal background job should keep the terminal tty without owning the foreground: ${JSON.stringify(backgroundStatus)}`
  );
  const backgroundJobs = await backgroundSession.run('jobs -l');
  assertCondition(
    backgroundJobs.exitCode === 0 &&
      backgroundJobs.stdout.includes(`[1]- ${backgroundPid}\tRunning\tbackground\t/dev/tty\tnode background-terminal.js\n`),
    `terminal jobs should list active background jobs: ${JSON.stringify(backgroundJobs)}`
  );
  releaseBackgroundTerminalCommand();
  const backgroundWait = await backgroundSession.run(`wait ${backgroundPid}`);
  assertCondition(backgroundWait.exitCode === 0, `terminal wait should reap background job: ${JSON.stringify(backgroundWait)}`);

  let releaseSemicolonBackgroundCommand!: () => void;
  const semicolonBackgroundCommandReleased = new Promise<void>((resolve) => {
    releaseSemicolonBackgroundCommand = resolve;
  });
  let semicolonBackgroundCommandStarted!: () => void;
  const semicolonBackgroundCommandStartedPromise = new Promise<void>((resolve) => {
    semicolonBackgroundCommandStarted = resolve;
  });
  const terminalSemicolonWorkspace = await createRuntimeWorkspace({
    files: [
      { path: 'first-terminal.js', contents: 'console.log("first")\n' },
      { path: 'background-terminal.js', contents: 'console.log("background")\n' },
    ],
    nodeRunner: async (request) => {
      if (request.scriptPath.endsWith('first-terminal.js')) {
        return { stdout: 'first:done\n', stderr: '', exitCode: 0 };
      }
      semicolonBackgroundCommandStarted();
      await semicolonBackgroundCommandReleased;
      return { stdout: 'background:done\n', stderr: '', exitCode: 0 };
    },
  });
  const semicolonSession = terminalSemicolonWorkspace.createTerminalSession();
  const semicolonBackgroundStart = await semicolonSession.run('node first-terminal.js ; node background-terminal.js &');
  await semicolonBackgroundCommandStartedPromise;
  const semicolonBackgroundPid = await processPidForCommand(terminalSemicolonWorkspace, 'node background-terminal.js');
  assertCondition(
    semicolonBackgroundStart.exitCode === 0 &&
      semicolonBackgroundStart.stdout === `first:done\n[1] ${semicolonBackgroundPid}\n` &&
      semicolonSession.inputState.mode === 'command',
    `terminal semicolon list should background only the command terminated by &: ${JSON.stringify({ semicolonBackgroundStart, inputState: semicolonSession.inputState })}`
  );
  releaseSemicolonBackgroundCommand();
  const semicolonBackgroundWait = await semicolonSession.run(`wait ${semicolonBackgroundPid}`);
  assertCondition(semicolonBackgroundWait.exitCode === 0, `terminal wait should reap semicolon background job: ${JSON.stringify(semicolonBackgroundWait)}`);

  let releaseAndBackgroundCommand!: () => void;
  const andBackgroundCommandReleased = new Promise<void>((resolve) => {
    releaseAndBackgroundCommand = resolve;
  });
  let andBackgroundCommandStarted!: () => void;
  const andBackgroundCommandStartedPromise = new Promise<void>((resolve) => {
    andBackgroundCommandStarted = resolve;
  });
  const terminalAndWorkspace = await createRuntimeWorkspace({
    files: [
      { path: 'first-terminal.js', contents: 'console.log("first")\n' },
      { path: 'background-terminal.js', contents: 'console.log("background")\n' },
    ],
    nodeRunner: async (request) => {
      if (request.scriptPath.endsWith('first-terminal.js')) {
        return { stdout: 'first:done\n', stderr: '', exitCode: 0 };
      }
      andBackgroundCommandStarted();
      await andBackgroundCommandReleased;
      return { stdout: 'background:done\n', stderr: '', exitCode: 0 };
    },
  });
  const andSession = terminalAndWorkspace.createTerminalSession();
  const andBackgroundStart = await andSession.run('node first-terminal.js && node background-terminal.js &');
  await andBackgroundCommandStartedPromise;
  const andBackgroundPid = await processPidForCommand(terminalAndWorkspace, 'node first-terminal.js && node background-terminal.js');
  assertCondition(
    andBackgroundStart.exitCode === 0 &&
      andBackgroundStart.stdout === `[1] ${andBackgroundPid}\n` &&
      andSession.inputState.mode === 'command',
    `terminal && list should background the whole and-or command: ${JSON.stringify({ andBackgroundStart, inputState: andSession.inputState })}`
  );
  const andBackgroundJobs = await andSession.run('jobs -l');
  assertCondition(
    andBackgroundJobs.exitCode === 0 &&
      andBackgroundJobs.stdout.includes(`[1]- ${andBackgroundPid}\tRunning\tbackground\t/dev/tty\tnode first-terminal.js && node background-terminal.js\n`),
    `terminal jobs should preserve && as part of the background job command: ${JSON.stringify(andBackgroundJobs)}`
  );
  releaseAndBackgroundCommand();
  const andBackgroundWait = await andSession.run(`wait ${andBackgroundPid}`);
  assertCondition(andBackgroundWait.exitCode === 0, `terminal wait should reap && background job: ${JSON.stringify(andBackgroundWait)}`);

  const directEvents: RuntimeCommandEvent[] = [];
  await workspace.runCommand('node /workspace/main.js', { onEvent: (event) => directEvents.push(event) });
  assertCondition(
    directEvents.some((event) => event.type === 'status' && event.message === 'Starting browser Node'),
    `workspace runCommand should keep status events for programmatic callers: ${JSON.stringify(directEvents)}`
  );

  const verboseOn = await session.run('tracekernelctl verbose');
  assertCondition(verboseOn.stdout === 'tracekernelctl: verbose on\n', `tracekernelctl verbose should toggle on: ${JSON.stringify(verboseOn)}`);
  const verboseEvents: RuntimeCommandEvent[] = [];
  await session.run('node /workspace/main.js', { onEvent: (event) => verboseEvents.push(event) });
  assertCondition(
    verboseEvents.some((event) => event.type === 'status' && event.message === 'Starting browser Node'),
    `terminal sessions should show status events after tracekernelctl verbose: ${JSON.stringify(verboseEvents)}`
  );

  const verboseStatus = await session.run('tracekernelctl status');
  assertCondition(verboseStatus.stdout.includes('verbose=on'), `tracekernelctl status should expose verbose mode: ${JSON.stringify(verboseStatus)}`);
  const verboseOff = await session.run('tracekernelctl verbose off');
  assertCondition(verboseOff.stdout === 'tracekernelctl: verbose off\n', `tracekernelctl verbose off should disable status output: ${JSON.stringify(verboseOff)}`);
  const quietAgainEvents: RuntimeCommandEvent[] = [];
  await session.run('node /workspace/main.js', { onEvent: (event) => quietAgainEvents.push(event) });
  assertCondition(
    !quietAgainEvents.some((event) => event.type === 'status'),
    `terminal sessions should hide status events after verbose off: ${JSON.stringify(quietAgainEvents)}`
  );

  workspace.dispose();
}

async function testProjectSessionMetadataAndCommands(): Promise<void> {
  let deeplyNestedCommand: unknown = 'python3 main.py';
  for (let depth = 0; depth < 40; depth += 1) {
    deeplyNestedCommand = { steps: [deeplyNestedCommand] };
  }
  let deepStepError = '';
  try {
    await createRuntimeWorkspace({
      projectSession: {
        id: 'deep-steps',
        name: 'Deep Steps',
        commands: {
          deep: deeplyNestedCommand as never,
        },
        files: [],
      },
    });
  } catch (error) {
    deepStepError = error instanceof Error ? error.message : String(error);
  }
  assertCondition(
    deepStepError.includes('must not nest steps deeper than'),
    `deeply nested project command steps should fail with a controlled validation error: ${deepStepError}`
  );

  const hiddenCommandAccess = createRuntimeProjectHiddenCommandAccess();
  const workspace = await createRuntimeWorkspace({
    hiddenCommandAccess,
    projectSession: {
      id: 'attempt-123',
      projectId: 'problem-weather-api',
      projectSlug: 'weather-api',
      name: 'Weather API',
      language: 'python',
      cwd: 'src',
      entrypoint: 'src/main.py',
      env: { MODE: 'session' },
      commands: {
        start: 'python3 main.py',
        test: {
          command: 'python3 -m unittest discover tests',
          cwd: '.',
          env: { TEST_MODE: 'visible' },
        },
        check: {
          steps: [
            'python3 main.py',
            { command: 'printf "step-input\\n" | python3 -m unittest discover tests', cwd: '.', env: { TEST_MODE: 'visible' } },
          ],
        },
        overrideCwd: {
          steps: [
            { command: 'python3 main.py', cwd: '../ignored-step-cwd' },
          ],
        },
        persist: {
          steps: [
            'python3 write_generated.py',
            'python3 read_generated.py',
          ],
        },
        tooManySteps: {
          steps: [
            'python3 main.py',
            'python3 main.py',
            'python3 main.py',
          ],
        },
        fixtures: 'python3 read_fixture.py',
        hiddenGate: {
          command: 'python3 read_fixture.py',
          hidden: true,
          label: 'Hidden Gate',
          description: 'Host-owned hidden verification command',
        },
        fail: {
          steps: [
            'python3 main.py',
            'python3 fail.py',
            'python3 read_generated.py',
          ],
        },
      },
      directories: ['tests'],
      files: [
        { path: 'src/main.py', contents: 'import os\nprint(os.getcwd())\nprint(os.environ["MODE"])\n' },
        { path: 'src/write_generated.py', contents: 'open("generated.txt", "w").write("from-step-one\\n")\n' },
        { path: 'src/read_generated.py', contents: 'print(open("generated.txt").read())\n' },
        { path: 'src/read_fixture.py', contents: 'print(open("../.trace/fixtures/input.txt").read())\n' },
        { path: 'src/fail.py', contents: 'raise SystemExit(9)\n' },
        { path: 'src/mutate_readonly.py', contents: 'print("mutate")\n' },
        { path: 'tests/test_sample.py', contents: '' },
        { path: '.trace/fixtures/input.txt', contents: 'hidden-input\n', hidden: true },
        { path: 'README.md', contents: 'protected\n', readonly: true },
      ],
      metadata: {
        consumer: 'test-harness',
      },
    },
    pythonRunner: async (request) => {
      if (request.scriptPath.endsWith('write_generated.py')) {
        return {
          stdout: 'wrote-generated\n',
          stderr: '',
          exitCode: 0,
          files: [{ path: 'src/generated.txt', contents: 'from-step-one\n' }],
        };
      }
      if (request.scriptPath.endsWith('read_generated.py')) {
        const generated = request.project.files.find((file) => file.path === 'src/generated.txt')?.contents ?? 'missing\n';
        return {
          stdout: `read-generated:${generated}`,
          stderr: '',
          exitCode: 0,
        };
      }
      if (request.scriptPath.endsWith('read_fixture.py')) {
        const hiddenFixture = request.project.files.find((file) => file.path === '.trace/fixtures/input.txt')?.contents ?? 'missing\n';
        const hiddenPolicy = request.project.hiddenFiles?.join(',') ?? 'no-hidden-policy';
        return {
          stdout: `fixture:${hiddenFixture}:policy:${hiddenPolicy}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      if (request.scriptPath.endsWith('fail.py')) {
        return {
          stdout: 'before-fail\n',
          stderr: 'failed-step\n',
          exitCode: 9,
        };
      }
      const stdin = readTestRequestStdin(request);
      return {
        stdout: `${request.scriptPath}:${request.cwd}:${request.env.MODE}:${request.env.TEST_MODE ?? ''}${stdin ? `:${stdin}` : '\n'}`,
        stderr: '',
        exitCode: 0,
        ...(request.scriptPath.endsWith('mutate_readonly.py')
          ? { files: [{ path: 'README.md', contents: 'runtime overwrite\n' }] }
          : {}),
      };
    },
  });

  assertCondition(workspace.cwd === '/home/user/weather-api', `project session should derive neutral workspace root: ${workspace.cwd}`);
  assertCondition(workspace.projectSession?.id === 'attempt-123', 'project session should expose stable session id');
  assertCondition(workspace.projectSession?.projectId === 'problem-weather-api', 'project session should preserve project id');
  assertCondition(workspace.projectSession?.projectSlug === 'weather-api', 'project session should preserve project slug');
  assertCondition(workspace.projectSession?.language === 'python', 'project session should preserve language as opaque metadata');
  assertCondition(workspace.projectSession?.workspaceRoot === '/home/user/weather-api', 'project session should expose canonical root');
  assertCondition(workspace.projectSession?.cwd === '/home/user/weather-api/src', 'project session should normalize relative session cwd');
  assertCondition(workspace.projectSession?.metadata?.consumer === 'test-harness', 'project session should preserve opaque metadata');
  assertCondition(workspace.projectSession?.readonlyFiles.join(',') === '.trace/fixtures/input.txt,README.md', 'project session should expose readonly file policy');
  assertCondition(workspace.projectSession?.hiddenFiles.join(',') === '.trace/fixtures/input.txt', 'project session should expose hidden file policy');
  assertCondition(
    !Object.prototype.hasOwnProperty.call(workspace.projectSession?.commands ?? {}, 'hiddenGate') &&
      Object.prototype.hasOwnProperty.call(workspace.projectSession?.commands ?? {}, 'start'),
    `project session should expose only visible command metadata: ${JSON.stringify(workspace.projectSession?.commands)}`
  );
  assertCondition(await workspace.exists('src/main.py'), 'project session starter files should be written into workspace');
  assertCondition(await workspace.exists('tests'), 'project session directories should be written into workspace');
  assertCondition(await workspace.readFile('README.md') === 'protected\n', 'project session readonly starter file should be seeded');
  assertCondition(workspace.isReadOnly('README.md'), 'workspace should report readonly files');
  assertCondition(workspace.isReadOnly('.trace/fixtures/input.txt'), 'workspace should treat hidden fixtures as readonly files');
  assertCondition(!workspace.isReadOnly('src/main.py'), 'workspace should not report editable files as readonly');
  assertCondition(!(await workspace.exists('.trace/fixtures/input.txt')), 'workspace exists should hide hidden fixture files');
  await assertRejectsAsync(() => workspace.readFile('.trace/fixtures/input.txt'), 'workspace readFile should hide hidden fixture files');
  await assertRejectsAsync(() => workspace.stat('.trace/fixtures/input.txt'), 'workspace stat should hide hidden fixture files');
  await assertRejectsAsync(() => workspace.readDir('.trace'), 'workspace readDir should hide hidden fixture directories');
  await assertRejectsAsync(
    () => workspace.copyFile('.trace/fixtures/input.txt', 'src/copied-fixture.txt'),
    'workspace copyFile should not copy hidden fixtures into visible files'
  );
  assertCondition(!(await workspace.exists('src/copied-fixture.txt')), 'hidden fixture copy target should not be created');
  assertCondition(!(await workspace.readDir('.')).includes('.trace'), 'workspace file tree reads should hide hidden fixture directories');
  const visibleSnapshot = await workspace.snapshot();
  assertCondition(
    !visibleSnapshot.files.some((file) => file.path === '.trace/fixtures/input.txt') &&
      !visibleSnapshot.directories?.some((directory) => directory === '.trace' || directory.startsWith('.trace/')) &&
      visibleSnapshot.hiddenFiles === undefined,
    `user-facing snapshots should omit hidden fixtures: ${JSON.stringify(visibleSnapshot)}`
  );
  const fullSnapshot = await workspace.snapshot({ includeHidden: true });
  assertCondition(
    fullSnapshot.files.some((file) => file.path === '.trace/fixtures/input.txt') &&
      fullSnapshot.hiddenFiles?.join(',') === '.trace/fixtures/input.txt',
    `internal snapshots should include hidden fixtures and expose hidden policy: ${JSON.stringify(fullSnapshot)}`
  );

  const start = await workspace.runProjectCommand('start');
  assertCondition(
    start.stdout === 'src/main.py:/home/user/weather-api/src:session:\n',
    `project session start command should run native command from session cwd/env: ${JSON.stringify(start)}`
  );

  const test = await workspace.runProjectCommand('test');
  assertCondition(
    test.stdout === 'unittest:/home/user/weather-api:session:visible\n',
    `project session object command should use command cwd/env overlays: ${JSON.stringify(test)}`
  );
  const stepEvents: RuntimeCommandEvent[] = [];
  const check = await workspace.runProjectCommand('check', {
    onEvent: (event) => stepEvents.push(event),
  });
  assertCondition(
    check.stdout === 'src/main.py:/home/user/weather-api/src:session:\nunittest:/home/user/weather-api:session:visible:step-input\n',
    `project session command steps should preserve ordered native commands with per-step cwd/env: ${JSON.stringify(check)}`
  );
  const stepStatuses = stepEvents.filter((event): event is Extract<RuntimeCommandEvent, { type: 'status' }> => event.type === 'status');
  assertCondition(
    stepStatuses.map((event) => event.phase).join(',') === 'project-step-start,project-step-end,project-step-start,project-step-end',
    `project session command steps should emit explicit step lifecycle events: ${JSON.stringify(stepStatuses)}`
  );
  assertCondition(
    stepStatuses[0]?.detail?.step === 1 &&
      stepStatuses[0]?.detail?.stepCount === 2 &&
      stepStatuses[0]?.detail?.shellCommand === 'python3 main.py' &&
      stepStatuses[2]?.detail?.cwd === '/home/user/weather-api',
    `project session step status details should expose command/cwd metadata: ${JSON.stringify(stepStatuses)}`
  );
  const overrideCwdEvents: RuntimeCommandEvent[] = [];
  const overrideCwd = await workspace.runProjectCommand('overrideCwd', {
    cwd: 'src',
    onEvent: (event) => overrideCwdEvents.push(event),
  });
  const overrideCwdStatuses = overrideCwdEvents.filter((event): event is Extract<RuntimeCommandEvent, { type: 'status' }> => event.type === 'status');
  assertCondition(
    overrideCwd.stdout === 'src/main.py:/home/user/weather-api/src:session:\n',
    `project session command cwd override should control step execution cwd: ${JSON.stringify(overrideCwd)}`
  );
  assertCondition(
    overrideCwdStatuses.some((event) => event.phase === 'project-step-start' && event.detail?.cwd === '/home/user/weather-api/src'),
    `project session step-start event should report the effective cwd override: ${JSON.stringify(overrideCwdStatuses)}`
  );
  const terminalStepEvents: RuntimeCommandEvent[] = [];
  const terminalCheck = await workspace.runProjectCommand('check', {
    presentation: 'terminal',
    onEvent: (event) => terminalStepEvents.push(event),
  });
  assertCondition(
    terminalCheck.stdout === check.stdout &&
      !terminalStepEvents.some((event) => event.type === 'status') &&
      terminalStepEvents.some((event) => event.type === 'output' && event.stream === 'stdout'),
    `terminal project command presentation should hide status events while preserving output: ${JSON.stringify(terminalStepEvents)}`
  );
  await workspace.runCommand('tracekernelctl verbose on');
  const verboseTerminalStepEvents: RuntimeCommandEvent[] = [];
  await workspace.runProjectCommand('check', {
    presentation: 'terminal',
    onEvent: (event) => verboseTerminalStepEvents.push(event),
  });
  assertCondition(
    verboseTerminalStepEvents.some((event) => event.type === 'status' && event.phase === 'project-step-start'),
    `terminal project command presentation should honor tracekernel verbose mode: ${JSON.stringify(verboseTerminalStepEvents)}`
  );
  await workspace.runCommand('tracekernelctl verbose off');

  const persist = await workspace.runProjectCommand('persist');
  assertCondition(
    persist.stdout === 'wrote-generated\nread-generated:from-step-one\n' &&
      await workspace.readFile('src/generated.txt') === 'from-step-one\n',
    `project session step file changes should persist into later steps: ${JSON.stringify(persist)}`
  );
  const tooManySteps = await workspace.runProjectCommand('tooManySteps', {
    executionLimits: { maxCommandCount: 2 },
  });
  assertCondition(
    tooManySteps.exitCode === 2 &&
      tooManySteps.stderr === 'Project command has too many steps: tooManySteps (3/2)\n',
    `project session steps should be capped by command-count budgets: ${JSON.stringify(tooManySteps)}`
  );
  const outputBudget = await workspace.runProjectCommand('check', {
    executionLimits: { maxOutputBytes: 60 },
  });
  assertCondition(
    outputBudget.exitCode === 1 &&
      outputBudget.error?.code === 'EMSGSIZE' &&
      outputBudget.stdout.includes('[command output truncated after 60 bytes]') &&
      !outputBudget.stdout.includes('step-input'),
    `project session steps should enforce an aggregate output budget: ${JSON.stringify(outputBudget)}`
  );
  const fixtures = await workspace.runProjectCommand('fixtures');
  assertCondition(
    fixtures.stdout === 'fixture:missing\n:policy:no-hidden-policy\n',
    `project session commands should omit hidden fixture files from runtime snapshots by default: ${JSON.stringify(fixtures)}`
  );
  const hiddenGateBlocked = await workspace.runProjectCommand('hiddenGate');
  assertCondition(
    hiddenGateBlocked.exitCode === 126 &&
      hiddenGateBlocked.stderr === 'Project command is hidden: hiddenGate\n',
    `hidden project session commands should be blocked unless explicitly allowed: ${JSON.stringify(hiddenGateBlocked)}`
  );
  const hiddenGateBooleanBypass = await workspace.runProjectCommand('hiddenGate', { allowHidden: true });
  assertCondition(
    hiddenGateBooleanBypass.exitCode === 126 &&
      hiddenGateBooleanBypass.stderr === 'Project command is hidden: hiddenGate\n',
    `hidden project session commands should reject public boolean bypasses: ${JSON.stringify(hiddenGateBooleanBypass)}`
  );
  const hiddenGate = await workspace.runProjectCommand('hiddenGate', { hiddenCommandAccess });
  assertCondition(
    hiddenGate.stdout === 'fixture:missing\n:policy:no-hidden-policy\n',
    `hidden command access alone should not mount hidden fixture files into runtime snapshots: ${JSON.stringify(hiddenGate)}`
  );
  const hiddenGateWithFiles = await workspace.runProjectCommand('hiddenGate', { hiddenCommandAccess, includeHiddenFiles: true });
  assertCondition(
    hiddenGateWithFiles.stdout === 'fixture:hidden-input\n:policy:.trace/fixtures/input.txt\n',
    `hidden project session files should require explicit runtime snapshot opt-in: ${JSON.stringify(hiddenGateWithFiles)}`
  );

  const failEvents: RuntimeCommandEvent[] = [];
  const fail = await workspace.runProjectCommand('fail', {
    onEvent: (event) => failEvents.push(event),
  });
  assertCondition(
    fail.exitCode === 9 &&
      fail.stdout === 'src/main.py:/home/user/weather-api/src:session:\nbefore-fail\n' &&
      fail.stderr === 'failed-step\n' &&
      !fail.stdout.includes('read-generated'),
    `project session failing steps should stop later steps and preserve accumulated output: ${JSON.stringify(fail)}`
  );
  assertCondition(
    failEvents
      .filter((event): event is Extract<RuntimeCommandEvent, { type: 'status' }> => event.type === 'status')
      .map((event) => `${event.phase}:${event.detail?.step}:${event.detail?.exitCode ?? ''}`)
      .join(',') === 'project-step-start:1:,project-step-end:1:0,project-step-start:2:,project-step-end:2:9',
    `project session failing steps should emit lifecycle through the failed step only: ${JSON.stringify(failEvents)}`
  );

  const manual = await workspace.runCommand('python3 main.py', { cwd: 'src', env: { MODE: 'manual' } });
  assertCondition(
    manual.stdout === 'src/main.py:/home/user/weather-api/src:manual:\n',
    `manual terminal-style command should remain native and independent of project command names: ${JSON.stringify(manual)}`
  );

  const missing = await workspace.runProjectCommand('missing');
  assertCondition(missing.exitCode === 127 && missing.stderr.includes('Project command not found'), 'missing project command should fail clearly');
  const readonlyRead = await workspace.runCommand('cat README.md');
  assertCondition(readonlyRead.stdout === 'protected\n', `commands should read readonly files: ${JSON.stringify(readonlyRead)}`);
  await assertRejectsAsync(() => workspace.writeFile('README.md', 'principal overwrite\n'), 'principal writes should reject readonly files');
  await assertRejectsAsync(() => workspace.appendFile('README.md', 'principal append\n'), 'principal appends should reject readonly files');
  await assertRejectsAsync(() => workspace.writeFile('.trace/fixtures/input.txt', 'principal overwrite\n'), 'principal writes should reject hidden fixtures');
  await assertRejectsAsync(() => workspace.writeFile('.trace/fixtures/conftest.py', 'poison\n'), 'principal writes should reject hidden fixture directory descendants');
  await assertRejectsAsync(() => workspace.copyFile('src/main.py', 'README.md'), 'copy destination should reject readonly files');
  await assertRejectsAsync(() => workspace.deleteFile('README.md'), 'delete should reject readonly files');
  await assertRejectsAsync(() => workspace.remove('.', { recursive: true }), 'recursive remove should reject readonly descendants');
  const runtimeReadonlyWrite = await workspace.runCommand('python3 mutate_readonly.py', { cwd: 'src', env: { MODE: 'runtime' } });
  assertCondition(
    runtimeReadonlyWrite.exitCode !== 0 && runtimeReadonlyWrite.stderr.includes('readonly project file'),
    `runtime final-diff writes should reject readonly files: ${JSON.stringify(runtimeReadonlyWrite)}`
  );
  assertCondition(await workspace.readFile('README.md') === 'protected\n', 'readonly file contents should remain unchanged after rejected writes');

  workspace.dispose();
}

async function testPackageManagerProjectCommands(): Promise<void> {
  const nodeRequests: JavaScriptProjectCommandRequest[] = [];
  const installRequests: Array<{
    manager: string;
    command: string;
    args: string[];
    cwd: string;
    manifestName: unknown;
    hiddenFixtureMounted: boolean;
    hiddenPolicy: string | undefined;
  }> = [];
  const workspace = await createRuntimeWorkspace({
    nodeRunner: async (request) => {
      nodeRequests.push(request);
      const path = request.scriptPath.replace(/\\/g, '/');
      if (path.endsWith('scripts/lifecycle.js')) {
        return {
          stdout: `life:${request.env.npm_lifecycle_event}:${request.args[0]}:${request.env.npm_package_name}:${request.cwd}:${request.env.INIT_CWD}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      if (path.endsWith('node_modules/@tracecode/weather-cli/bin/cli.js')) {
        return {
          stdout: `bin:${request.env.npm_lifecycle_event ?? ''}:${request.env.npm_lifecycle_script ?? ''}:${request.args.join(',')}:${request.env.PATH.includes('node_modules/.bin')}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      if (path.endsWith('scripts/test.js')) {
        request.onEvent?.({ type: 'status', phase: 'process-start', message: 'Starting browser Node' });
        return {
          stdout: `test:${request.env.npm_lifecycle_event}:${request.env.npm_package_name}:${request.cwd}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      if (path.endsWith('packages/api/api.js')) {
        return {
          stdout: `api:${request.env.npm_lifecycle_event}:${request.env.npm_package_name}:${request.cwd}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: `node:${path}:${request.args.join(',')}\n`, stderr: '', exitCode: 0 };
    },
    packageManager: {
      dependencyProvider: {
        async install(request) {
          installRequests.push({
            manager: request.manager,
            command: request.command,
            args: [...request.args],
            cwd: request.cwd,
            manifestName: request.manifest.json.name,
            hiddenFixtureMounted: request.project.files.some((file) => file.path === '.trace/fixtures/npm-secret.txt'),
            hiddenPolicy: request.project.hiddenFiles?.join(','),
          });
          return {
            stdout: 'installed\n',
            stderr: '',
            exitCode: 0,
            files: [
              {
                path: 'node_modules/@tracecode/weather-cli/package.json',
                contents: JSON.stringify({
                  name: '@tracecode/weather-cli',
                  version: '1.0.0',
                  bin: {
                    'weather-cli': 'bin/cli.js',
                  },
                }, null, 2),
              },
              {
                path: 'node_modules/@tracecode/weather-cli/bin/cli.js',
                contents: 'console.log("weather-cli");\n',
              },
            ],
          };
        },
      },
    },
    projectSession: {
      id: 'npm-session',
      projectSlug: 'npm-project',
      files: [
        {
          path: 'package.json',
          contents: JSON.stringify({
            name: 'weather-app',
            version: '1.2.3',
            workspaces: ['packages/*'],
            scripts: {
              prebuild: 'node scripts/lifecycle.js pre',
              build: 'weather-cli build',
              postbuild: 'node scripts/lifecycle.js post',
              test: 'node scripts/test.js',
            },
            dependencies: {
              '@tracecode/weather-cli': '1.0.0',
            },
          }, null, 2),
        },
        { path: 'scripts/lifecycle.js', contents: '' },
        { path: 'scripts/test.js', contents: '' },
        { path: '.trace/fixtures/npm-secret.txt', contents: 'hidden-npm\n', hidden: true },
        {
          path: 'packages/api/package.json',
          contents: JSON.stringify({
            name: '@tracecode/api',
            version: '0.1.0',
            scripts: {
              test: 'node api.js',
            },
          }, null, 2),
        },
        { path: 'packages/api/api.js', contents: '' },
      ],
    },
  });

  const install = await workspace.runCommand('npm install');
  assertCondition(install.exitCode === 0 && install.stdout === 'installed\n', `npm install should delegate to dependency provider: ${JSON.stringify(install)}`);
  assertCondition(
    installRequests.length === 1 &&
      installRequests[0]?.manager === 'npm' &&
	      installRequests[0]?.command === 'install' &&
	      installRequests[0]?.args.length === 0 &&
	      installRequests[0]?.manifestName === 'weather-app' &&
	      installRequests[0]?.hiddenFixtureMounted === false &&
	      installRequests[0]?.hiddenPolicy === undefined,
	    `package dependency provider should receive normalized install request: ${JSON.stringify(installRequests)}`
	  );
  assertCondition(await workspace.exists('node_modules/.bin/weather-cli'), 'package install should materialize local package bin shims');

  const safeInstall = await workspace.runCommand('npm install --ignore-scripts left-pad');
  assertCondition(safeInstall.exitCode === 0, `npm install --ignore-scripts should delegate to dependency provider: ${JSON.stringify(safeInstall)}`);
  assertCondition(
    installRequests[1]?.args.join(',') === '--ignore-scripts,left-pad',
    `package dependency provider should receive install safety flags: ${JSON.stringify(installRequests)}`
  );

  const build = await workspace.runCommand('npm run build -- --prod');
  assertCondition(
    build.exitCode === 0 &&
      build.stdout === [
        '',
        '> weather-app@1.2.3 prebuild',
        '> node scripts/lifecycle.js pre',
        '',
        'life:prebuild:pre:weather-app:/home/user/npm-project:/home/user/npm-project',
        '',
        '> weather-app@1.2.3 build',
        '> weather-cli build --prod',
        '',
        'bin:build:weather-cli build:build,--prod:true',
        '',
        '> weather-app@1.2.3 postbuild',
        '> node scripts/lifecycle.js post',
        '',
        'life:postbuild:post:weather-app:/home/user/npm-project:/home/user/npm-project',
        '',
      ].join('\n'),
    `npm run should execute lifecycle scripts, local bins, and forwarded args: ${JSON.stringify(build)}`
  );

  const listedScripts = await workspace.runCommand('npm run');
  assertCondition(
    listedScripts.stdout.includes('Lifecycle scripts included in weather-app@1.2.3:') &&
      listedScripts.stdout.includes('  test\n    node scripts/test.js') &&
      listedScripts.stdout.includes('available via `npm run`:') &&
      listedScripts.stdout.includes('  build\n    weather-cli build'),
    `npm run without a script should list available scripts: ${JSON.stringify(listedScripts)}`
  );

  const npmTestEvents: RuntimeCommandEvent[] = [];
  const npmTest = await workspace.runCommand('npm test', { onEvent: (event) => npmTestEvents.push(event) });
  assertCondition(
    npmTest.exitCode === 0 && npmTest.stdout === '\n> weather-app@1.2.3 test\n> node scripts/test.js\n\ntest:test:weather-app:/home/user/npm-project\n',
    `npm test should route to the test script: ${JSON.stringify(npmTest)}`
  );
  const npmTestBannerIndex = npmTestEvents.findIndex((event) =>
    event.type === 'output' &&
    event.stream === 'stdout' &&
    event.data.includes('> weather-app@1.2.3 test')
  );
  const npmTestStartIndex = npmTestEvents.findIndex((event) =>
    event.type === 'status' &&
    event.phase === 'process-start' &&
    event.message === 'Starting browser Node'
  );
  assertCondition(
    npmTestBannerIndex !== -1 && npmTestStartIndex !== -1 && npmTestBannerIndex < npmTestStartIndex,
    `npm run should stream the script banner before nested command events: ${JSON.stringify(npmTestEvents)}`
  );
  const npmTestStreamedStdout = npmTestEvents
    .filter((event): event is Extract<RuntimeCommandEvent, { type: 'output' }> =>
      event.type === 'output' && event.stream === 'stdout'
    )
    .map((event) => event.data)
    .join('');
  assertCondition(
    npmTestStreamedStdout === npmTest.stdout,
    `npm run streamed stdout should exactly match returned stdout: ${JSON.stringify({ npmTestStreamedStdout, stdout: npmTest.stdout })}`
  );
  assertCondition(
    nodeRequests
      .filter((request) => Boolean(request.env.npm_lifecycle_event))
      .every((request) => request.env.npm_config_user_agent?.includes(' tracekernel x64 ') === true),
    `npm lifecycle metadata should identify TraceKernel rather than a fabricated host OS: ${JSON.stringify(nodeRequests.map((request) => request.env.npm_config_user_agent))}`
  );

  const exec = await workspace.runCommand('npm exec weather-cli inspect');
  assertCondition(
    exec.exitCode === 0 && exec.stdout === 'bin:npx:"weather-cli":inspect:true\n',
    `npm exec should resolve local package bins through project PATH: ${JSON.stringify(exec)}`
  );

  const npxVersion = await workspace.runCommand('npx --version');
  assertCondition(
    npxVersion.exitCode === 0 && npxVersion.stdout === '11.12.1\n',
    `npx --version should report the configured npm version: ${JSON.stringify(npxVersion)}`
  );

  const npxExec = await workspace.runCommand('npx weather-cli inspect');
  assertCondition(
    npxExec.exitCode === 0 && npxExec.stdout === 'bin:npx:"weather-cli":inspect:true\n',
    `npx should resolve local package bins through project PATH: ${JSON.stringify(npxExec)}`
  );

  const workspaceScript = await workspace.runCommand('npm --workspace @tracecode/api test');
  assertCondition(
    workspaceScript.exitCode === 0 &&
      workspaceScript.stdout === '\n> @tracecode/api@0.1.0 test\n> node api.js\n\napi:test:@tracecode/api:/home/user/npm-project/packages/api\n',
    `npm --workspace should resolve workspace package manifests by name: ${JSON.stringify(workspaceScript)}`
  );

  const prefixScript = await workspace.runCommand('npm --prefix packages/api test');
  assertCondition(
    prefixScript.exitCode === 0 &&
      prefixScript.stdout === '\n> @tracecode/api@0.1.0 test\n> node api.js\n\napi:test:@tracecode/api:/home/user/npm-project/packages/api\n',
    `npm --prefix should run scripts from the selected package directory: ${JSON.stringify(prefixScript)}`
  );

  const missingIfPresent = await workspace.runCommand('npm run missing --if-present');
  assertCondition(
    missingIfPresent.exitCode === 0 && missingIfPresent.stdout === '' && missingIfPresent.stderr === '',
    `npm --if-present should allow missing scripts: ${JSON.stringify(missingIfPresent)}`
  );

  workspace.dispose();

  const disabledInstallWorkspace = await createRuntimeWorkspace({
    nodeRunner: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    files: [{ path: 'package.json', contents: '{"scripts":{"test":"node test.js"}}\n' }],
  });
  const disabledInstall = await disabledInstallWorkspace.runCommand('npm install');
  assertCondition(
    disabledInstall.exitCode === 1 &&
      disabledInstall.stderr.includes('npm error code ENETUNREACH') &&
      !disabledInstall.stderr.toLowerCase().includes('tracekernel'),
    `npm install without a dependency provider should look like an offline registry failure: ${JSON.stringify(disabledInstall)}`
  );
  disabledInstallWorkspace.dispose();
}

async function testTypeScriptProjectCommands(): Promise<void> {
  const rootTsConfig = {
    compilerOptions: {
      outDir: 'dist',
      rootDir: '.',
      module: 'commonjs',
      target: 'es2020',
      strict: true,
    },
    files: ['src/index.ts', 'src/math.ts'],
  };
  const workspace = await createRuntimeWorkspace({
    typescriptRunner: createTypeScriptProjectRunner(),
    nodeRunner: createNativeJavaScriptProjectRunner(),
    projectSession: {
      id: 'ts-session',
      projectSlug: 'ts-project',
      commands: {
        test: {
          steps: [
            'tsc',
            'node dist/src/index.js',
          ],
        },
        typecheck: 'tsc --noEmit',
      },
      files: [
        {
          path: 'tsconfig.json',
          contents: JSON.stringify(rootTsConfig, null, 2),
        },
        {
          path: 'src/math.ts',
          contents: 'export function add(left: number, right: number): number { return left + right; }\n',
        },
        {
          path: 'src/index.ts',
          contents: 'import { add } from "./math";\nconsole.log("ts=" + add(2, 3));\n',
        },
        {
          path: 'takehome/browser-ts/node_modules/@tracecode/weather-kit/package.json',
          contents: '{"name":"@tracecode/weather-kit","main":"index.js","types":"index.d.ts"}\n',
          hidden: true,
        },
        {
          path: 'takehome/browser-ts/node_modules/@tracecode/weather-kit/index.d.ts',
          contents: 'export function normalizeCity(value: string): string;\n',
          hidden: true,
        },
        {
          path: 'takehome/browser-ts/node_modules/@tracecode/weather-kit/index.js',
          contents: 'exports.normalizeCity = (value) => String(value).trim().toLowerCase().replace(/\\s+/g, "-");\n',
          hidden: true,
        },
      ],
    },
  });

  const typecheck = await workspace.runProjectCommand('typecheck');
  assertCondition(typecheck.exitCode === 0 && typecheck.files === undefined, `tsc --noEmit should typecheck without emitting files: ${JSON.stringify(typecheck)}`);
  assertCondition(!(await workspace.exists('dist/src/index.js')), 'tsc --noEmit should not write dist files');

  const compile = await workspace.runCommand('tsc');
  assertCondition(compile.exitCode === 0, `tsc should compile cleanly: ${JSON.stringify(compile)}`);
  assertCondition(
    (await workspace.readFile('dist/src/index.js')).includes('require("./math")') &&
      (await workspace.readFile('dist/src/math.js')).includes('function add'),
    'tsc should emit multi-file CommonJS output into the kernel filesystem'
  );
  const run = await workspace.runCommand('node dist/src/index.js');
  assertCondition(run.exitCode === 0 && run.stdout === 'ts=5\n', `node should run emitted TypeScript output: ${JSON.stringify(run)}`);

  await workspace.writeFile('src/index.ts', 'import { add } from "./math";\nconst value: number = "bad";\nconsole.log(add(value, 3));\n');
  const badTypecheck = await workspace.runCommand('tsc --noEmit');
  assertCondition(
    badTypecheck.exitCode !== 0 &&
      badTypecheck.stderr.includes('/home/user/ts-project/src/index.ts:2:7') &&
      badTypecheck.stderr.includes("Type 'string' is not assignable to type 'number'"),
    `tsc --noEmit should surface project-path diagnostics: ${JSON.stringify(badTypecheck)}`
  );

  await workspace.writeFile('explicit-failure.ts', 'const value: number = ;\n');
  const explicitFailure = await workspace.runCommand('tsc explicit-failure.ts');
  assertCondition(
    explicitFailure.exitCode !== 0 &&
      explicitFailure.stderr.includes('/home/user/ts-project/explicit-failure.ts:1:23') &&
      explicitFailure.stderr.includes('error TS1109'),
    `tsc with an explicit source file should compile that file instead of the tsconfig file list: ${JSON.stringify(explicitFailure)}`
  );
  await workspace.deleteFile('explicit-failure.ts');

  await workspace.writeFile('tsconfig.json', JSON.stringify({
    compilerOptions: {
      outDir: 'dist',
      rootDir: '.',
      module: 'commonjs',
      target: 'es2020',
      strict: true,
      lib: ['es2016'],
    },
    files: ['src/main.ts', 'src/rules.ts'],
  }, null, 2));
  await workspace.writeFile('src/rules.ts', [
    'export type RulePatch = Partial<{ roles: string[]; enabled: boolean }>;',
    'export function normalize(patch: RulePatch): string[] {',
    '  return patch.roles ?? [];',
    '}',
    '',
  ].join('\n'));
  await workspace.writeFile('src/main.ts', [
    'import { normalize } from "./rules";',
    'const roles = normalize({ roles: ["free", "pro"] });',
    'const hasPremium = roles.some((f) => f === "pro");',
    'console.log(roles.includes("pro") && roles.indexOf("free") === 0 && hasPremium ? "access" : "deny");',
    '',
  ].join('\n'));
  const libCompatibilityCompile = await workspace.runCommand('tsc --project tsconfig.json');
  assertCondition(
    libCompatibilityCompile.exitCode === 0,
    `tsc should keep tracekernel ambient libs compatible with utility types, array methods, and user lib options: ${JSON.stringify(libCompatibilityCompile)}`
  );

  await workspace.writeFile('tsconfig.json', JSON.stringify(rootTsConfig, null, 2));
  await workspace.writeFile('src/index.ts', 'import { add } from "./math";\nconsole.log("ts=" + add(2, 3));\n');
  await workspace.remove('dist', { recursive: true, force: true });
  const stepped = await workspace.runProjectCommand('test');
  assertCondition(
    stepped.exitCode === 0 && stepped.stdout === 'ts=5\n',
    `stepped TypeScript project command should compile then run emitted JS: ${JSON.stringify(stepped)}`
  );

  await workspace.writeFile('takehome/ts/tsconfig.json', JSON.stringify({
    compilerOptions: {
      outDir: 'dist',
      rootDir: '.',
      module: 'commonjs',
      target: 'es2020',
      strict: true,
    },
    files: ['index.ts', 'math.ts'],
  }, null, 2));
  await workspace.writeFile('takehome/ts/math.ts', 'export function add(left: number, right: number): number { return left + right; }\n');
  await workspace.writeFile('takehome/ts/index.ts', 'import { add } from "./math";\nconsole.log("subdir-ts=" + add(4, 5));\n');
  const subdirCompile = await workspace.runCommand('tsc --project takehome/ts/tsconfig.json');
  assertCondition(subdirCompile.exitCode === 0, `subdirectory tsconfig should compile cleanly: ${JSON.stringify(subdirCompile)}`);
  assertCondition(
    (await workspace.readFile('takehome/ts/dist/index.js')).includes('require("./math")') &&
      (await workspace.readFile('takehome/ts/dist/math.js')).includes('function add'),
    'subdirectory tsconfig should emit dist files relative to the tsconfig directory'
  );
  const subdirRun = await workspace.runCommand('node takehome/ts/dist/index.js');
  assertCondition(
    subdirRun.exitCode === 0 && subdirRun.stdout === 'subdir-ts=9\n',
    `node should run subdirectory TypeScript output: ${JSON.stringify(subdirRun)}`
  );

  await workspace.writeFile('takehome/ts/tsconfig.json', JSON.stringify({
    compilerOptions: {
      outDir: 'build',
      rootDir: 'src',
      module: 'commonjs',
      target: 'es2020',
      strict: true,
    },
    include: ['src/**/*.ts'],
    exclude: ['src/**/*.skip.ts'],
  }, null, 2));
  await workspace.writeFile('takehome/ts/src/util.ts', 'export const values = [1, 2, 3].map((value) => value + 1).filter((value) => value > 2);\n');
  await workspace.writeFile('takehome/ts/src/index.ts', 'import { values } from "./util";\nconst total = values.reduce((sum, value) => sum + value, 0);\nconsole.log("include-ts=" + total);\n');
  await workspace.writeFile('takehome/ts/src/broken.skip.ts', 'const broken: number = "skip me";\n');
  const includeCompile = await workspace.runCommand('tsc --project takehome/ts/tsconfig.json');
  assertCondition(includeCompile.exitCode === 0, `tsconfig include/exclude should compile cleanly: ${JSON.stringify(includeCompile)}`);
  assertCondition(
    await workspace.exists('takehome/ts/build/index.js') &&
      await workspace.exists('takehome/ts/build/util.js') &&
      !(await workspace.exists('takehome/ts/build/broken.skip.js')),
    'tsconfig include/exclude should emit included files relative to configured rootDir/outDir'
  );
  const includeRun = await workspace.runCommand('node takehome/ts/build/index.js');
  assertCondition(
    includeRun.exitCode === 0 && includeRun.stdout === 'include-ts=7\n',
    `node should run include/exclude TypeScript output: ${JSON.stringify(includeRun)}`
  );

  await workspace.writeFile('takehome/browser-ts/tsconfig.json', JSON.stringify({
    compilerOptions: {
      outDir: 'dist',
      rootDir: '.',
      module: 'commonjs',
      target: 'es2020',
      strict: true,
    },
    include: ['src/**/*.ts', 'tests/**/*.ts'],
  }, null, 2));
  await workspace.writeFile(
    'takehome/browser-ts/src/parser.ts',
    'import { normalizeCity } from "@tracecode/weather-kit";\nexport function cityKey(value: string): string { return normalizeCity(value); }\n'
  );
  await workspace.writeFile(
    'takehome/browser-ts/tests/report.test.ts',
    'import { cityKey } from "../src/parser";\nconst fs = require("node:fs");\nconst result = cityKey(" New York ");\nif (result !== "new-york") throw new Error("bad city key: " + result);\nfs.mkdirSync("takehome/browser-ts/reports", { recursive: true });\nfs.writeFileSync("takehome/browser-ts/reports/summary.txt", result + "\\n");\nconsole.log("takehome-ts=" + result);\n'
  );
  const realisticCompile = await workspace.runCommand('tsc --project takehome/browser-ts/tsconfig.json', { includeHiddenFiles: true });
  assertCondition(realisticCompile.exitCode === 0, `realistic browser TS project should compile with pre-bundled package types: ${JSON.stringify(realisticCompile)}`);
  assertCondition(
    await workspace.exists('takehome/browser-ts/dist/src/parser.js') &&
      await workspace.exists('takehome/browser-ts/dist/tests/report.test.js'),
    'realistic browser TS project should emit src and tests into dist'
  );
  const realisticRun = await workspace.runCommand('node takehome/browser-ts/dist/tests/report.test.js', { includeHiddenFiles: true });
  assertCondition(
    realisticRun.exitCode === 0 &&
      realisticRun.stdout === 'takehome-ts=new-york\n' &&
      await workspace.readFile('takehome/browser-ts/reports/summary.txt') === 'new-york\n',
    `realistic browser TS test should run emitted JS, resolve pre-bundled deps, and persist report output: ${JSON.stringify(realisticRun)}`
  );
  const install = await workspace.runCommand('node -e "try { require(\\"left-pad\\"); } catch (error) { console.log(error.message); }"');
  assertCondition(
    install.stdout.includes("Cannot find module 'left-pad'"),
    `browser project package imports should be limited to starter-provided dependencies: ${JSON.stringify(install)}`
  );
  const watch = await workspace.runCommand('tsc --watch --project takehome/browser-ts/tsconfig.json');
  assertCondition(
    watch.exitCode === 2 && watch.stderr === 'tsc: --watch is not supported by this runtime\n',
    `tsc --watch should fail without exposing the runtime implementation: ${JSON.stringify(watch)}`
  );

  workspace.dispose();
}

async function testHardLanguageTakehomeMvpGate(): Promise<void> {
  const javaWorkspace = await createRuntimeWorkspace({
    projectSession: {
      id: 'java-takehome',
      projectSlug: 'java-weather-api',
      language: 'java',
      env: { MODE: 'takehome' },
      commands: {
        build: 'javac src/Main.java src/weather/Normalizer.java tests/WeatherTest.java',
        test: {
          steps: [
            'javac src/Main.java src/weather/Normalizer.java tests/WeatherTest.java',
            'java WeatherTest',
          ],
        },
        hiddenGate: {
          command: 'java WeatherTest',
          hidden: true,
        },
      },
      files: [
        { path: 'src/Main.java', contents: 'import weather.Normalizer; class Main { public static void main(String[] args) { System.out.println(Normalizer.city(" New York ")); } }\n' },
        { path: 'src/weather/Normalizer.java', contents: 'package weather; public class Normalizer { public static String city(String value) { return value.trim().toLowerCase().replace(" ", "-"); } }\n' },
        { path: 'tests/WeatherTest.java', contents: 'class WeatherTest {}\n' },
        { path: '.trace/fixtures/weather.txt', contents: 'new-york\n', hidden: true },
        { path: 'src/Broken.java', contents: 'class Broken { missing }\n' },
      ],
    },
    javaRunner: async (request): Promise<RuntimeCommandResult> => {
      if (request.source === 'compile' && request.args.some((arg) => arg.endsWith('Broken.java'))) {
        return { stdout: '', stderr: 'src/Broken.java:1: error: cannot find symbol\n', exitCode: 1 };
      }
      if (request.source === 'compile') {
        assertCondition(
          request.project.files.some((file) => file.path === 'src/weather/Normalizer.java') &&
            request.project.files.some((file) => file.path === '.trace/fixtures/weather.txt'),
          `Java takehome compile should see multi-file sources and hidden fixtures: ${JSON.stringify(request.project.files)}`
        );
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          files: [{ path: 'build/java/classes.marker', contents: 'compiled\n' }],
        };
      }
      const fixture = request.project.files.find((file) => file.path === '.trace/fixtures/weather.txt')?.contents.trim();
      return {
        stdout: `java:${request.cwd}:${request.env.MODE}:${fixture}:${request.args.join(',')}\n`,
        stderr: '',
        exitCode: 0,
        files: [{ path: 'reports/java-summary.txt', contents: `${fixture}\n` }],
      };
    },
  });
  const javaTest = await javaWorkspace.runProjectCommand('test', { includeHiddenFiles: true });
  assertCondition(
    javaTest.exitCode === 0 &&
      javaTest.stdout === 'java:/home/user/java-weather-api:takehome:new-york:\n' &&
      await javaWorkspace.readFile('reports/java-summary.txt') === 'new-york\n',
    `Java takehome gate should build, run, see env/cwd/fixtures, and persist reports: ${JSON.stringify(javaTest)}`
  );
  const javaBroken = await javaWorkspace.runCommand('javac src/Broken.java');
  assertCondition(
    javaBroken.exitCode !== 0 && javaBroken.stderr.includes('src/Broken.java:1: error: cannot find symbol'),
    `Java takehome gate should surface expected compile failures: ${JSON.stringify(javaBroken)}`
  );
  javaWorkspace.dispose();

  const csharpWorkspace = await createRuntimeWorkspace({
    projectSession: {
      id: 'csharp-takehome',
      projectSlug: 'csharp-weather-api',
      language: 'csharp',
      env: { MODE: 'takehome' },
      commands: {
        build: 'dotnet build Weather.csproj',
        test: {
          steps: [
            'dotnet build Weather.csproj',
            'dotnet run --project Weather.csproj -- --case smoke',
          ],
        },
        hiddenGate: {
          command: 'dotnet run --project Weather.csproj -- --case hidden',
          hidden: true,
        },
      },
      files: [
        { path: 'Weather.csproj', contents: '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n' },
        { path: 'Program.cs', contents: 'Console.WriteLine(Weather.Normalizer.City(" New York "));\n' },
        { path: 'Normalizer.cs', contents: 'namespace Weather; public static class Normalizer { public static string City(string value) => value.Trim().ToLower().Replace(" ", "-"); }\n' },
        { path: 'Broken.csproj', contents: '<Project></Project>\n' },
        { path: '.trace/fixtures/weather.txt', contents: 'new-york\n', hidden: true },
      ],
    },
    csharpRunner: async (request): Promise<RuntimeCommandResult> => {
      if (request.source === 'compile' && request.scriptPath === 'Broken.csproj') {
        return { stdout: '', stderr: 'Broken.csproj(1,1): error CS1002: ; expected\n', exitCode: 1 };
      }
      if (request.source === 'compile') {
        assertCondition(
          request.scriptPath === 'Weather.csproj' &&
            request.project.files.some((file) => file.path === 'Normalizer.cs') &&
            request.project.files.some((file) => file.path === '.trace/fixtures/weather.txt'),
          `C# takehome compile should see project, sources, and hidden fixtures: ${JSON.stringify(request)}`
        );
        return {
          stdout: 'Build succeeded.\n',
          stderr: '',
          exitCode: 0,
          files: [{ path: 'bin/Weather.dll', contents: 'compiled\n' }],
        };
      }
      const fixture = request.project.files.find((file) => file.path === '.trace/fixtures/weather.txt')?.contents.trim();
      return {
        stdout: `csharp:${request.cwd}:${request.env.MODE}:${fixture}:${request.args.join(',')}\n`,
        stderr: '',
        exitCode: 0,
        files: [{ path: 'reports/csharp-summary.txt', contents: `${fixture}\n` }],
      };
    },
  });
  const csharpTest = await csharpWorkspace.runProjectCommand('test', { includeHiddenFiles: true });
  assertCondition(
    csharpTest.exitCode === 0 &&
      csharpTest.stdout === 'Build succeeded.\ncsharp:/home/user/csharp-weather-api:takehome:new-york:--case,smoke\n' &&
      await csharpWorkspace.readFile('reports/csharp-summary.txt') === 'new-york\n',
    `C# takehome gate should build, run, see env/cwd/fixtures, and persist reports: ${JSON.stringify(csharpTest)}`
  );
  const csharpBroken = await csharpWorkspace.runCommand('dotnet build Broken.csproj');
  assertCondition(
    csharpBroken.exitCode !== 0 && csharpBroken.stderr.includes('error CS1002'),
    `C# takehome gate should surface expected compile failures: ${JSON.stringify(csharpBroken)}`
  );
  csharpWorkspace.dispose();

  const cppRequests: CppProjectCommandRequest[] = [];
  const cppWorkspace = await createRuntimeWorkspace({
    projectSession: {
      id: 'cpp-takehome',
      projectSlug: 'cpp-weather-api',
      language: 'cpp',
      env: { MODE: 'takehome' },
      commands: {
        build: 'clang++ src/main.cpp src/normalizer.cpp -o build/weather-app',
        test: {
          steps: [
            'clang++ src/main.cpp src/normalizer.cpp -o build/weather-app',
            './build/weather-app smoke',
          ],
        },
        hiddenGate: {
          command: './build/weather-app hidden',
          hidden: true,
        },
      },
      files: [
        { path: 'src/main.cpp', contents: '#include "normalizer.h"\nint main() { return 0; }\n' },
        { path: 'src/normalizer.cpp', contents: '#include "normalizer.h"\n' },
        { path: 'src/normalizer.h', contents: '#pragma once\n' },
        { path: 'src/broken.cpp', contents: 'int main() { return missing; }\n' },
        { path: '.trace/fixtures/weather.txt', contents: 'new-york\n', hidden: true },
      ],
    },
    cppRunner: async (request): Promise<RuntimeCommandResult> => {
      cppRequests.push(request);
      if (request.source === 'compile' && request.args.some((arg) => arg.endsWith('broken.cpp'))) {
        return { stdout: '', stderr: 'src/broken.cpp:1:21: error: use of undeclared identifier missing\n', exitCode: 1 };
      }
      if (request.source === 'compile') {
        assertCondition(
          request.project.files.some((file) => file.path === 'src/normalizer.h') &&
            request.project.files.some((file) => file.path === '.trace/fixtures/weather.txt'),
          `C++ takehome compile should see multi-file sources and hidden fixtures: ${JSON.stringify(request.project.files)}`
        );
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          files: [{ path: 'build/weather-app', contents: 'compiled\n' }],
        };
      }
      const fixture = request.project.files.find((file) => file.path === '.trace/fixtures/weather.txt')?.contents.trim();
      const stdin = request.args[0] === 'stdin' ? readTestRequestStdin(request) : '';
      return {
        stdout: `cpp:${request.cwd}:${request.env.MODE}:${fixture}:${request.args.join(',')}${stdin ? `:${stdin.trim()}` : ''}\n`,
        stderr: '',
        exitCode: 0,
        files: [{ path: 'reports/cpp-summary.txt', contents: `${fixture}\n` }],
      };
    },
  });
  const cppTest = await cppWorkspace.runProjectCommand('test', { includeHiddenFiles: true });
  assertCondition(
    cppTest.exitCode === 0 &&
      cppTest.stdout === 'cpp:/home/user/cpp-weather-api:takehome:new-york:smoke\n' &&
      await cppWorkspace.readFile('reports/cpp-summary.txt') === 'new-york\n',
    `C++ takehome gate should build, run, see env/cwd/fixtures, and persist reports: ${JSON.stringify(cppTest)}`
  );
  const cppBroken = await cppWorkspace.runCommand('clang++ src/broken.cpp -o build/broken');
  assertCondition(
    cppBroken.exitCode !== 0 && cppBroken.stderr.includes('use of undeclared identifier missing'),
    `C++ takehome gate should surface expected compile failures: ${JSON.stringify(cppBroken)}`
  );
  const cppCompound = await cppWorkspace.runCommand('clang++ src/main.cpp src/normalizer.cpp -o build/weather-app && ./build/weather-app chain', {
    env: { MODE: 'compound' },
    includeHiddenFiles: true,
  });
  assertCondition(
    cppCompound.exitCode === 0 &&
      cppCompound.stdout === 'cpp:/home/user/cpp-weather-api:compound:new-york:chain\n' &&
      cppRequests.at(-1)?.source === 'run' &&
      cppRequests.at(-1)?.scriptPath === 'build/weather-app',
    `C++ compiled executables should run inside shell chains: ${JSON.stringify({ cppCompound, lastRequest: cppRequests.at(-1) })}`
  );
  const cppNestedCompound = await cppWorkspace.runCommand('cd src && clang++ main.cpp normalizer.cpp -o ../build/weather-app && ../build/weather-app nested', {
    env: { MODE: 'compound' },
    includeHiddenFiles: true,
  });
  assertCondition(
    cppNestedCompound.exitCode === 0 &&
      cppNestedCompound.stdout === 'cpp:/home/user/cpp-weather-api/src:compound:new-york:nested\n' &&
      cppRequests.at(-1)?.source === 'run' &&
      cppRequests.at(-1)?.scriptPath === '../build/weather-app',
    `C++ compiled executable routing should preserve relative paths inside shell chains: ${JSON.stringify({ cppNestedCompound, lastRequest: cppRequests.at(-1) })}`
  );
  const cppInteractiveCompound = await cppWorkspace.runCommand('clang++ src/main.cpp src/normalizer.cpp -o build/weather-app && ./build/weather-app stdin', {
    env: { MODE: 'compound' },
    includeHiddenFiles: true,
    stdinPipe: stdinPipe('live-chain\n'),
  });
  assertCondition(
    cppInteractiveCompound.exitCode === 0 &&
      cppInteractiveCompound.stdout === 'cpp:/home/user/cpp-weather-api:compound:new-york:stdin:live-chain\n' &&
      cppRequests.at(-1)?.source === 'run' &&
      cppRequests.at(-1)?.stdinPipe !== undefined,
    `C++ compiled executables should receive live stdin inside shell chains: ${JSON.stringify({ cppInteractiveCompound, lastRequest: cppRequests.at(-1) })}`
  );
  const cppWrongPathRunsBefore = cppRequests.filter((request) => request.source === 'run').length;
  const cppWrongPath = await cppWorkspace.runCommand('cd src && clang++ main.cpp normalizer.cpp -o ../build/weather-app && ./build/weather-app wrong', {
    includeHiddenFiles: true,
  });
  const cppWrongPathRunsAfter = cppRequests.filter((request) => request.source === 'run').length;
  assertCondition(
    cppWrongPath.exitCode !== 0 &&
      cppWrongPathRunsAfter === cppWrongPathRunsBefore &&
      cppWrongPath.stderr.includes('./build/weather-app'),
    `C++ compiled executable routing should not mask invalid relative paths: ${JSON.stringify(cppWrongPath)}`
  );
  cppWorkspace.dispose();
}

async function testProjectSessionLifecycle(): Promise<void> {
  const expiresAt = '2099-01-01T00:00:00.000Z';
  const workspace = await createRuntimeWorkspace({
    projectSession: {
      id: 'lifecycle-session',
      projectSlug: 'lifecycle-project',
      createdAt: '2098-12-31T00:00:00.000Z',
      lastOpenedAt: '2098-12-31T01:00:00.000Z',
      expiresAt,
      expirationBehavior: 'readonly',
      commands: {
        test: 'cat main.txt',
      },
      files: [
        { path: 'main.txt', contents: 'active\n' },
      ],
    },
  });
  assertCondition(
    workspace.projectSession?.lifecycle.createdAt === '2098-12-31T00:00:00.000Z' &&
      workspace.projectSession.lifecycle.lastOpenedAt === '2098-12-31T01:00:00.000Z' &&
      workspace.projectSession.lifecycle.expiresAt === expiresAt &&
      workspace.projectSession.lifecycle.expirationBehavior === 'readonly',
    `project session should expose lifecycle metadata: ${JSON.stringify(workspace.projectSession?.lifecycle)}`
  );
  const events: RuntimeCommandEvent[] = [];
  const unsubscribe = workspace.watch((event) => events.push(event));
  const activeLifecycle = await workspace.checkExpiration('2098-12-31T23:59:59.000Z');
  assertCondition(!activeLifecycle?.expiredAt, 'checkExpiration before expiresAt should not expire the session');
  const expiredLifecycle = await workspace.checkExpiration(expiresAt);
  assertCondition(
    expiredLifecycle?.expiredAt === expiresAt,
    `checkExpiration should stamp expiredAt when called after expiry: ${JSON.stringify(expiredLifecycle)}`
  );
  assertCondition(
    events.some((event) => event.type === 'lifecycle' && event.phase === 'session-expired'),
    `checkExpiration should emit a session-expired lifecycle event: ${JSON.stringify(events)}`
  );
  assertCondition(await workspace.readFile('main.txt') === 'active\n', 'expired readonly sessions should allow reads');
  await assertRejectsAsync(() => workspace.writeFile('main.txt', 'blocked\n'), 'expired readonly sessions should reject writes');
  const expiredRun = await workspace.runProjectCommand('test');
  assertCondition(
    expiredRun.exitCode !== 0 && expiredRun.stderr.includes('project session expired'),
    `expired readonly sessions should reject command runs: ${JSON.stringify(expiredRun)}`
  );
  await workspace.destroy({ reason: 'test', clearStorage: true });
  assertCondition(
    events.some((event) => event.type === 'lifecycle' && event.phase === 'session-destroyed'),
    `destroy should emit a session-destroyed lifecycle event before clearing watchers: ${JSON.stringify(events)}`
  );
  unsubscribe();
  await assertRejectsAsync(() => workspace.readFile('main.txt'), 'destroyed sessions should reject reads');

  const noneWorkspace = await createRuntimeWorkspace({
    projectSession: {
      id: 'lifecycle-none',
      expiresAt,
      expirationBehavior: 'none',
      files: [{ path: 'main.txt', contents: 'active\n' }],
    },
  });
  await noneWorkspace.checkExpiration(expiresAt);
  await noneWorkspace.writeFile('main.txt', 'still-writable\n');
  assertCondition(await noneWorkspace.readFile('main.txt') === 'still-writable\n', 'expirationBehavior none should leave policy to the host app');
  noneWorkspace.dispose();

  const destroyWorkspace = await createRuntimeWorkspace({
    projectSession: {
      id: 'lifecycle-destroy',
      expiresAt,
      expirationBehavior: 'destroy',
      files: [{ path: 'main.txt', contents: 'active\n' }],
    },
  });
  await destroyWorkspace.checkExpiration(expiresAt);
  await assertRejectsAsync(() => destroyWorkspace.readFile('main.txt'), 'expirationBehavior destroy should destroy the workspace when checked');

  const controlCalls: string[] = [];
  const controlWorkspace = await createRuntimeWorkspace({
    files: [{ path: 'main.txt', contents: 'active\n' }],
    kernelControl: {
      async reset() {
        controlCalls.push('reset');
      },
    },
  });
  const status = await controlWorkspace.runCommand('tracekernelctl status');
  assertCondition(
    status.exitCode === 0 &&
      status.stdout.includes('tracekernel ') &&
      status.stdout.includes('workspace=/workspace'),
    `tracekernelctl status should expose kernel identity: ${JSON.stringify(status)}`
  );
  const resetEvents: RuntimeWorkspaceEvent[] = [];
  controlWorkspace.watch((event) => resetEvents.push(event));
  const reset = await controlWorkspace.runCommand('tracekernelctl reset');
  assertCondition(
    reset.exitCode === 0 &&
      reset.stdout === 'tracekernelctl: reset complete\n' &&
      controlCalls.join(',') === 'reset' &&
      resetEvents.some((event) =>
        event.type === 'lifecycle' &&
          event.phase === 'session-destroyed' &&
          event.detail?.reason === 'tracekernelctl-reset'
      ),
    `tracekernelctl reset should run the reset hook and destroy the workspace: ${JSON.stringify({ reset, controlCalls, resetEvents })}`
  );
  await assertRejectsAsync(() => controlWorkspace.readFile('main.txt'), 'tracekernelctl reset should destroy the workspace');
}

async function testExpiredReadonlySessionRejectsWithoutPolling(): Promise<void> {
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  const workspace = await createRuntimeWorkspace({
    projectSession: {
      id: 'lazy-readonly-expired',
      expiresAt,
      expirationBehavior: 'readonly',
      files: [{ path: 'main.txt', contents: 'active\n' }],
    },
  });
  const events: RuntimeWorkspaceEvent[] = [];
  workspace.watch((event) => events.push(event));

  let writeError: unknown;
  try {
    await workspace.writeFile('main.txt', 'blocked\n');
  } catch (error) {
    writeError = error;
  }
  const writeErrorCode = typeof writeError === 'object' && writeError !== null
    ? (writeError as { code?: unknown }).code
    : undefined;
  assertCondition(writeErrorCode === 'EROFS', `expired readonly write should reject with EROFS: ${String(writeError)}`);

  const result = await workspace.runCommand('echo hi');
  assertCondition(
    result.exitCode !== 0 && result.stderr.includes('project session expired'),
    `expired readonly command should return the expired result without polling: ${JSON.stringify(result)}`
  );
  const expiredEvents = events.filter((event) => event.type === 'lifecycle' && event.phase === 'session-expired');
  assertCondition(expiredEvents.length === 1, `lazy readonly expiration should emit once: ${JSON.stringify(events)}`);
  assertCondition(await workspace.readFile('main.txt') === 'active\n', 'expired readonly sessions should still allow reads');
  workspace.dispose();
}

async function testExpiredDestroySessionDestroysWithoutPolling(): Promise<void> {
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  const workspace = await createRuntimeWorkspace({
    projectSession: {
      id: 'lazy-destroy-expired',
      expiresAt,
      expirationBehavior: 'destroy',
      files: [{ path: 'main.txt', contents: 'active\n' }],
    },
  });

  const result = await workspace.runCommand('echo hi');
  assertCondition(
    result.exitCode !== 0 &&
      result.stderr.includes('project session expired') &&
      !result.stderr.includes('project session is no longer available'),
    `expired destroy command should reject as expired before async destroy runs: ${JSON.stringify(result)}`
  );
  await waitForMacrotasks(3);

  let readError: unknown;
  try {
    await workspace.readFile('main.txt');
  } catch (error) {
    readError = error;
  }
  const readErrorMessage = readError instanceof Error ? readError.message : String(readError);
  assertCondition(
    readErrorMessage.includes('project session is no longer available'),
    `expired destroy session should reject reads after scheduled destroy: ${readErrorMessage}`
  );
  assertCondition(
    Boolean(workspace.projectSession?.lifecycle.destroyedAt),
    `expired destroy session should stamp destroyedAt: ${JSON.stringify(workspace.projectSession?.lifecycle)}`
  );
}

async function testExpirationEmitsOnce(): Promise<void> {
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  const workspace = await createRuntimeWorkspace({
    projectSession: {
      id: 'lazy-readonly-expired-once',
      expiresAt,
      expirationBehavior: 'readonly',
      files: [{ path: 'main.txt', contents: 'active\n' }],
    },
  });
  const events: RuntimeWorkspaceEvent[] = [];
  workspace.watch((event) => events.push(event));

  await assertRejectsAsync(() => workspace.writeFile('main.txt', 'blocked once\n'), 'first expired mutation should reject');
  await assertRejectsAsync(() => workspace.appendFile('main.txt', 'blocked twice\n'), 'second expired mutation should reject');
  const expiredEvents = events.filter((event) => event.type === 'lifecycle' && event.phase === 'session-expired');
  assertCondition(expiredEvents.length === 1, `expiration should emit once across repeated mutations: ${JSON.stringify(events)}`);
  workspace.dispose();
}

async function testTraceKernelInfoConfig(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    kernel: {
      user: {
        id: 'auth-user-123',
        username: 'obi',
      },
      host: {
        hostname: 'tracevm',
      },
      workspace: {
        id: 'weather-api-attempt-1',
        name: 'weather-api',
        startedAt: '2026-05-17T12:00:00.000Z',
      },
    },
  });

  assertCondition(workspace.cwd === '/home/obi/weather-api', `workspace cwd should default to project under home: ${workspace.cwd}`);
  assertCondition(workspace.kernel.info.name === 'tracekernel', 'kernel info should report tracekernel');
  assertCondition(
    workspace.kernel.info.version === packageJson.version,
    `kernel version should default to the published harness version: ${workspace.kernel.info.version}`
  );
  assertCondition(workspace.kernel.info.user.id === 'auth-user-123', 'kernel info should preserve stable user id');
  assertCondition(workspace.kernel.info.user.username === 'obi', 'kernel info should preserve display username');
  assertCondition(workspace.kernel.info.home === '/home/obi', `kernel home should derive from username: ${workspace.kernel.info.home}`);
  assertCondition(workspace.kernel.info.host.hostname === 'tracevm', 'kernel info should preserve hostname');
  assertCondition(workspace.kernel.info.workspace.id === 'weather-api-attempt-1', 'kernel info should preserve stable workspace id');
  assertCondition(workspace.kernel.info.workspace.name === 'weather-api', 'kernel info should preserve workspace display name');
  assertCondition(
    workspace.kernel.info.workspaceRoot === '/home/obi/weather-api' &&
      workspace.kernel.info.workspace.root === '/home/obi/weather-api',
    `kernel info should expose canonical workspace root: ${JSON.stringify(workspace.kernel.info)}`
  );
  assertCondition(workspace.kernel.info.workspaceAlias === '/workspace', 'kernel info should expose /workspace compatibility alias');

  await workspace.writeFile('src/main.py', 'print("weather")\n');
  await workspace.writeFile('/workspace/src/alias.txt', 'alias\n');
  assertCondition(await workspace.readFile('/home/obi/weather-api/src/alias.txt') === 'alias\n', 'canonical root should read alias writes');
  assertCondition(await workspace.readFile('/workspace/src/alias.txt') === 'alias\n', '/workspace alias should read canonical files');
  assertCondition(await workspace.exists('/workspace/src/alias.txt'), '/workspace alias should exist for canonical files');
  assertCondition((await workspace.readDir('/workspace/src')).join(',') === 'alias.txt,main.py', '/workspace alias should list canonical directories');
  const aliasPwd = await workspace.runCommand('pwd', { cwd: '/workspace/src' });
  assertCondition(aliasPwd.stdout === '/home/obi/weather-api/src\n', `command cwd should accept /workspace alias: ${aliasPwd.stdout}`);

  const procInfo = JSON.parse(await workspace.kernel.readFile('/proc/kernel/info')) as typeof workspace.kernel.info;
  assertCondition(procInfo.name === 'tracekernel', 'kernel /proc info should expose kernel name');
  assertCondition(procInfo.user.username === 'obi', 'kernel /proc info should expose username');
  assertCondition(procInfo.workspace.root === '/home/obi/weather-api', 'kernel /proc info should expose workspace root');
  const mountInfo = await workspace.kernel.readFile('/proc/self/mountinfo');
  assertCondition(mountInfo.includes('tracekernel:system'), 'kernel /proc mountinfo should expose the read-only system root');
  assertCondition(mountInfo.includes('tracekernel:tmp') && mountInfo.includes('tracekernel:var-tmp'), 'kernel /proc mountinfo should expose writable temporary mounts');
  assertCondition(mountInfo.includes('tracekernel:workspace'), 'kernel /proc mountinfo should expose workspace mount');
  assertCondition(mountInfo.includes('/home/obi/weather-api'), 'kernel /proc mountinfo should expose canonical workspace mountpoint');
  assertCondition(mountInfo.includes('/workspace'), 'kernel /proc mountinfo should expose compatibility alias mountpoint');
  assertCondition(mountInfo.includes('tracekernel:dev') && mountInfo.includes('tracekernel:proc'), 'kernel /proc mountinfo should expose dev and proc mounts');
  const kernelVersion = await workspace.kernel.readFile('/proc/kernel/version');
  assertCondition(kernelVersion === `tracekernel ${workspace.kernel.info.version}\n`, 'kernel /proc version should expose kernel version');
  assertCondition(await workspace.exists('/proc/kernel/info'), 'kernel /proc info should exist');
  const procInfoStat = await workspace.stat('/proc/kernel/info');
  assertCondition(
    procInfoStat.isFile &&
      !procInfoStat.isDirectory &&
      procInfoStat.uid === 0 &&
      procInfoStat.gid === 0 &&
      procInfoStat.owner === 'root' &&
      procInfoStat.group === 'root',
    'kernel /proc info should stat as a root-owned file'
  );
  assertCondition(await workspace.exists('/proc/kernel/version'), 'kernel /proc version should exist');
  const procVersionStat = await workspace.stat('/proc/kernel/version');
  assertCondition(procVersionStat.isFile && !procVersionStat.isDirectory, 'kernel /proc version should stat as file');
  assertCondition((await workspace.readDir('/proc')).join(',') === 'kernel,mounts,self,tracekernel', 'kernel /proc should list virtual namespaces and the canonical mount table');
  assertCondition((await workspace.readDir('/proc/kernel')).join(',') === 'info,version', 'kernel /proc/kernel should list info and version');
  await assertRejectsAsync(() => workspace.writeFile('/proc/kernel/info', '{}\n'), 'kernel /proc should be read-only');

  const snapshot = await workspace.snapshot();
  assertCondition(snapshot.cwd === '/home/obi/weather-api', `snapshot cwd should use canonical workspace root: ${snapshot.cwd}`);
  assertCondition(snapshot.files.some((file) => file.path === 'src/main.py'), 'snapshot should still use project-relative file paths');
  assertCondition(snapshot.kernel?.name === 'tracekernel', `snapshot should expose kernel info: ${JSON.stringify(snapshot.kernel)}`);
  assertCondition(
    snapshot.kernelDevices?.some((device) => device.path === '/dev/stdin') === true &&
      snapshot.kernelDevices?.some((device) => device.path === '/dev/stdout') === true,
    `snapshot should expose kernel device inventory: ${JSON.stringify(snapshot.kernelDevices)}`
  );
  assertCondition(
    snapshot.kernelFiles?.some((file) => file.path === '/proc/kernel/info' && JSON.parse(file.contents).workspace.root === '/workspace') === true &&
      snapshot.kernelFiles?.some((file) => file.path === '/proc/self/mountinfo' && file.contents.includes('tracekernel:workspace')) === true,
    `snapshot should expose kernel proc files: ${JSON.stringify(snapshot.kernelFiles)}`
  );
  assertCondition(
    snapshot.kernelFiles?.every((file) =>
      !file.path.startsWith('/proc/self/fd/') &&
      !file.path.startsWith('/proc/self/fdinfo/') &&
      !/^\/proc\/[1-9][0-9]*(?:\/|$)/u.test(file.path)
    ) === true,
    `runner snapshots must not export process-specific proc descriptors: ${JSON.stringify(snapshot.kernelFiles)}`
  );
  workspace.dispose();

  const versionOverride = await createRuntimeWorkspace({
    kernel: { version: 'test-kernel-version' },
  });
  assertCondition(
    versionOverride.kernel.info.version === 'test-kernel-version',
    'an explicit kernel version should override the harness release version'
  );
  assertCondition(
    await versionOverride.kernel.readFile('/proc/kernel/version') === 'tracekernel test-kernel-version\n',
    'the explicit kernel version should reach the public kernel identity files'
  );
  versionOverride.dispose();
}

async function testConfiguredKernelNativePythonAndNodeRunners(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    kernel: {
      user: { id: 'auth-user-123', username: 'obi' },
      host: { hostname: 'tracevm' },
      workspace: {
        id: 'weather-api-native',
        name: 'weather-api',
        startedAt: '2026-05-17T12:00:00.000Z',
      },
    },
    files: [
      {
        path: 'py_main.py',
        contents: [
          'import os',
          'print(os.getcwd())',
          'with open("/workspace/py-alias.txt", "w", encoding="utf-8") as handle:',
          '    handle.write("python-alias\\n")',
        ].join('\n') + '\n',
      },
      {
        path: 'node_main.js',
        contents: [
          'const fs = require("node:fs");',
          'console.log(process.cwd());',
          'fs.writeFileSync("/workspace/node-alias.txt", "node-alias\\n");',
        ].join('\n') + '\n',
      },
    ],
    pythonRunner: createNativePythonProjectRunner(),
    nodeRunner: createNativeJavaScriptProjectRunner(),
  });

  const snapshot = await workspace.snapshot();
  assertCondition(snapshot.workspaceRoot === '/home/obi/weather-api', `snapshot should expose canonical workspace root: ${JSON.stringify(snapshot)}`);
  assertCondition(snapshot.workspaceAlias === '/workspace', `snapshot should expose workspace alias: ${JSON.stringify(snapshot)}`);
  assertCondition(snapshot.kernel?.workspaceRoot === '/workspace', `snapshot should expose public kernel info for runner handoff: ${JSON.stringify(snapshot.kernel)}`);
  assertCondition(
    snapshot.kernelDevices?.some((device) => device.path === '/dev/tty') === true &&
      snapshot.kernelFiles?.some((file) => file.path === '/proc/kernel/version') === true,
    `snapshot should expose kernel devices and proc files for runner handoff: ${JSON.stringify(snapshot)}`
  );

  const python = await workspace.runCommand('python3 /workspace/py_main.py', { cwd: '/workspace' });
  assertCondition(python.exitCode === 0, `configured native Python should run through /workspace alias: ${python.stderr}`);
  assertCondition(python.stdout === '/home/obi/weather-api\n', `configured native Python should report canonical cwd: ${python.stdout}`);
  assertCondition(await workspace.readFile('py-alias.txt') === 'python-alias\n', 'configured native Python should persist /workspace alias writes');

  const node = await workspace.runCommand('node /workspace/node_main.js', { cwd: '/workspace' });
  assertCondition(node.exitCode === 0, `configured native Node should run through /workspace alias: ${node.stderr}`);
  assertCondition(node.stdout === '/home/obi/weather-api\n', `configured native Node should report canonical cwd: ${node.stdout}`);
  assertCondition(await workspace.readFile('node-alias.txt') === 'node-alias\n', 'configured native Node should persist /workspace alias writes');
  workspace.dispose();
}

async function testConfiguredKernelNativeCompiledRunners(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    kernel: {
      user: { id: 'auth-user-123', username: 'obi' },
      host: { hostname: 'tracevm' },
      workspace: {
        id: 'weather-api-native-compiled',
        name: 'weather-api',
        startedAt: '2026-05-17T12:00:00.000Z',
      },
    },
    files: [
      {
        path: 'src/java/Main.java',
        contents: [
          'package app;',
          'public class Main {',
          '  public static void main(String[] args) {',
          '    System.out.println("java-configured");',
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/cpp/main.cpp',
        contents: '#include <iostream>\nint main() { std::cout << "cpp-configured\\n"; }\n',
      },
      {
        path: 'src/csharp/App.csproj',
        contents: [
          '<Project Sdk="Microsoft.NET.Sdk">',
          '  <PropertyGroup>',
          '    <OutputType>Exe</OutputType>',
          '    <TargetFramework>net10.0</TargetFramework>',
          '    <ImplicitUsings>enable</ImplicitUsings>',
          '    <Nullable>disable</Nullable>',
          '  </PropertyGroup>',
          '</Project>',
          '',
        ].join('\n'),
      },
      { path: 'src/csharp/Program.cs', contents: 'Console.WriteLine("csharp-configured");\n' },
    ],
    javaRunner: createNativeJavaProjectRunner(),
    cppRunner: createNativeCppProjectRunner(),
    csharpRunner: createNativeCSharpProjectRunner(),
  });

  const javaCompile = await workspace.runCommand('javac -d /home/obi/weather-api/out/java /workspace/src/java/Main.java', { cwd: '/workspace' });
  assertCondition(javaCompile.exitCode === 0, `configured native javac should map canonical and alias paths: ${javaCompile.stderr}`);
  const javaRun = await workspace.runCommand('java --class-path /home/obi/weather-api/out/java app.Main', { cwd: '/workspace' });
  assertCondition(javaRun.exitCode === 0, `configured native java should run canonical classpath: ${javaRun.stderr}`);
  assertCondition(javaRun.stdout === 'java-configured\n', `configured native java should execute compiled output: ${javaRun.stdout}`);

  const cppCompile = await workspace.runCommand('clang++ -std=c++17 /home/obi/weather-api/src/cpp/main.cpp -o /workspace/out/cpp/app', { cwd: '/workspace' });
  assertCondition(cppCompile.exitCode === 0, `configured native clang++ should map canonical and alias paths: ${cppCompile.stderr}`);
  const cppRun = await workspace.runCommand('/home/obi/weather-api/out/cpp/app', { cwd: '/workspace' });
  assertCondition(cppRun.exitCode === 0, `configured native C++ should run canonical executable path: ${cppRun.stderr}`);
  assertCondition(cppRun.stdout === 'cpp-configured\n', `configured native C++ should execute compiled output: ${cppRun.stdout}`);

  const csharpBuild = await workspace.runCommand('dotnet build /home/obi/weather-api/src/csharp/App.csproj', { cwd: '/workspace' });
  assertCondition(csharpBuild.exitCode === 0, `configured native dotnet build should map canonical project path: ${csharpBuild.stderr}`);
  const csharpRun = await workspace.runCommand('dotnet run --project /workspace/src/csharp/App.csproj', { cwd: '/workspace' });
  assertCondition(csharpRun.exitCode === 0, `configured native dotnet run should map alias project path: ${csharpRun.stderr}`);
  assertCondition(csharpRun.stdout.endsWith('csharp-configured\n'), `configured native C# should execute project output: ${csharpRun.stdout}`);
  workspace.dispose();
}

async function testConfiguredKernelAliasGlobCommandTranslation(): Promise<void> {
  const pythonRequests: PythonProjectCommandRequest[] = [];
  const nodeRequests: JavaScriptProjectCommandRequest[] = [];
  const javaRequests: JavaProjectCommandRequest[] = [];
  const csharpRequests: CSharpProjectCommandRequest[] = [];
  const cppRequests: CppProjectCommandRequest[] = [];
  const workspace = await createRuntimeWorkspace({
    kernel: {
      user: { id: 'auth-user-123', username: 'obi' },
      host: { hostname: 'tracevm' },
      workspace: {
        id: 'weather-api-globs',
        name: 'weather-api',
        startedAt: '2026-05-17T12:00:00.000Z',
      },
    },
    files: [
      { path: 'scripts/main.py', contents: 'print("python")\n' },
      { path: 'scripts/main.js', contents: 'console.log("node")\n' },
      { path: 'src/Main.java', contents: 'class Main {}\n' },
      { path: 'src/main.cpp', contents: 'int main() { return 0; }\n' },
      { path: 'lib/app.jar', contents: Buffer.from('jar').toString('base64'), encoding: 'base64' },
      {
        path: 'app/App.csproj',
        contents: [
          '<Project Sdk="Microsoft.NET.Sdk">',
          '  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup>',
          '</Project>',
          '',
        ].join('\n'),
      },
    ],
    pythonRunner: async (request) => {
      pythonRequests.push(request);
      return { stdout: 'python\n', stderr: '', exitCode: 0 };
    },
    nodeRunner: async (request) => {
      nodeRequests.push(request);
      return { stdout: 'node\n', stderr: '', exitCode: 0 };
    },
    javaRunner: async (request) => {
      javaRequests.push(request);
      return { stdout: `${request.source}\n`, stderr: '', exitCode: 0 };
    },
    csharpRunner: async (request) => {
      csharpRequests.push(request);
      return { stdout: 'csharp\n', stderr: '', exitCode: 0 };
    },
    cppRunner: async (request) => {
      cppRequests.push(request);
      return {
        stdout: `${request.source}\n`,
        stderr: '',
        exitCode: 0,
        ...(request.source === 'compile'
          ? { files: [{ path: 'out/app', contents: Buffer.from('wasm').toString('base64'), encoding: 'base64' as const }] }
          : {}),
      };
    },
  });

  const python = await workspace.runCommand('python3 "/workspace/scripts/*.py" alpha', { cwd: '/workspace' });
  assertCondition(python.exitCode === 0, `configured Python alias glob should run: ${python.stderr}`);
  assertCondition(pythonRequests[0]?.scriptPath === 'scripts/main.py', `configured Python alias glob should map script path: ${JSON.stringify(pythonRequests[0])}`);

  const node = await workspace.runCommand('node "/workspace/scripts/*.js" beta', { cwd: '/workspace' });
  assertCondition(node.exitCode === 0, `configured Node alias glob should run: ${node.stderr}`);
  assertCondition(nodeRequests[0]?.scriptPath === 'scripts/main.js', `configured Node alias glob should map script path: ${JSON.stringify(nodeRequests[0])}`);

  const javac = await workspace.runCommand('javac "/workspace/src/*.java"', { cwd: '/workspace' });
  assertCondition(javac.exitCode === 0, `configured javac alias glob should run: ${javac.stderr}`);
  assertCondition(
    javaRequests[0]?.args.join(',') === '/home/obi/weather-api/src/Main.java',
    `configured javac alias glob should expand to canonical root args: ${JSON.stringify(javaRequests[0])}`
  );

  const javaJar = await workspace.runCommand('java -jar "/workspace/lib/*.jar" gamma', { cwd: '/workspace' });
  assertCondition(javaJar.exitCode === 0, `configured java -jar alias glob should run: ${javaJar.stderr}`);
  assertCondition(
    javaRequests[1]?.scriptPath === '/home/obi/weather-api/lib/app.jar' &&
      javaRequests[1]?.args.join(',') === 'gamma',
    `configured java -jar alias glob should map jar path and args: ${JSON.stringify(javaRequests[1])}`
  );

  const dotnet = await workspace.runCommand('dotnet run --project "/workspace/app/*.csproj" delta', { cwd: '/workspace' });
  assertCondition(dotnet.exitCode === 0, `configured dotnet alias glob should run: ${dotnet.stderr}`);
  assertCondition(
    csharpRequests[0]?.scriptPath === '/home/obi/weather-api/app/App.csproj' &&
      csharpRequests[0]?.args.join(',') === 'delta',
    `configured dotnet alias glob should map project path and args: ${JSON.stringify(csharpRequests[0])}`
  );

  const cppCompile = await workspace.runCommand('clang++ "/workspace/src/*.cpp" -o /workspace/out/app', { cwd: '/workspace' });
  assertCondition(cppCompile.exitCode === 0, `configured C++ alias glob should compile: ${cppCompile.stderr}`);
  assertCondition(
    cppRequests[0]?.args.join(',') === '/home/obi/weather-api/src/main.cpp,-o,/workspace/out/app',
    `configured C++ alias glob should expand source and preserve output arg: ${JSON.stringify(cppRequests[0])}`
  );

  const cppRun = await workspace.runCommand('/workspace/out/app epsilon', { cwd: '/workspace' });
  assertCondition(cppRun.exitCode === 0, `configured direct C++ alias executable should run: ${cppRun.stderr}`);
  assertCondition(
    cppRequests[1]?.source === 'run' &&
      cppRequests[1]?.scriptPath === '/workspace/out/app' &&
      cppRequests[1]?.args.join(',') === 'epsilon',
    `configured direct C++ alias executable should route to runner: ${JSON.stringify(cppRequests[1])}`
  );
  workspace.dispose();
}

function testPathValidation(): void {
  assertCondition(normalizeRuntimeProjectPath('./src/solution.py') === 'src/solution.py', 'normalizes segments');
  assertRejects(
    () => normalizeRuntimeProjectPath('../escape.py'),
    'project paths should not escape the workspace'
  );
  assertRejects(
    () => normalizeRuntimeProjectPath('/absolute.py'),
    'project paths should reject absolute paths'
  );
}

function testTerminalCommandParsingParity(): void {
  const assertSegments = (command: string, expected: Array<{ command: string; background: boolean }>): void => {
    const actual = parseTerminalCommandList(command);
    assertCondition(
      JSON.stringify(actual) === JSON.stringify(expected),
      `terminal command list mismatch for ${JSON.stringify(command)}: ${JSON.stringify(actual)}`
    );
  };

  assertSegments('a; b & c', [
    { command: 'a', background: false },
    { command: 'b', background: true },
    { command: 'c', background: false },
  ]);
  assertSegments('node a.js && node b.js &', [{ command: 'node a.js && node b.js', background: true }]);
  // Quoted separators and subshell contents must not split — the terminal
  // layer now parses with the same just-bash parser that executes commands.
  assertSegments('echo "a & b; c"', [{ command: 'echo "a & b; c"', background: false }]);
  assertSegments('(sleep 1 & echo sub)', [{ command: '(sleep 1 & echo sub)', background: false }]);
  assertSegments('echo start; (sleep 1 & echo sub)', [
    { command: 'echo start', background: false },
    { command: '(sleep 1 & echo sub)', background: false },
  ]);
  // Here-doc bodies are not reconstructable per statement; keep unsplit.
  assertSegments('cat <<EOF &\nhello\nEOF', [{ command: 'cat <<EOF &\nhello\nEOF', background: false }]);
  // Unparseable submissions run unsplit so the interpreter reports the error.
  assertSegments('echo "unterminated', [{ command: 'echo "unterminated', background: false }]);

  const assertWords = (command: string, expected: string[] | null): void => {
    const actual = parseSimpleCommandWords(command);
    assertCondition(
      JSON.stringify(actual) === JSON.stringify(expected),
      `simple command words mismatch for ${JSON.stringify(command)}: ${JSON.stringify(actual)}`
    );
  };
  assertWords('cd src', ['cd', 'src']);
  assertWords('cd "my dir"', ['cd', 'my dir']);
  assertWords("cd 'a b'", ['cd', 'a b']);
  assertWords('pwd # trailing comment', ['pwd']);
  assertWords('cd $HOME', null);
  assertWords('cd ~/x', null);
  assertWords('cd a | b', null);
  assertWords('cd a > out', null);
  assertWords('FOO=1 cd a', null);
  assertWords('cd a; cd b', null);

  const assertLeadingCd = (command: string, expected: string | undefined | null): void => {
    const actual = leadingPersistentCdTarget(command);
    assertCondition(
      JSON.stringify(actual) === JSON.stringify(expected),
      `leading cd target mismatch for ${JSON.stringify(command)}: ${JSON.stringify(actual)}`
    );
  };
  assertLeadingCd('cd src && make', 'src');
  assertLeadingCd('cd "my dir" && make', 'my dir');
  assertLeadingCd('cd src; make', 'src');
  assertLeadingCd('cd || echo fail', undefined);
  assertLeadingCd('cd $(pwd)/x && make', null);
  assertLeadingCd('cd a b && make', null);
  assertLeadingCd('cd src', null);
  assertLeadingCd('make && cd src', null);
  assertLeadingCd('cd src > log && make', null);

  console.log('PASS: terminal command parsing matches the just-bash parser');
}

async function main(): Promise<void> {
  testTerminalCommandParsingParity();
  testPathValidation();
  await testWorkspaceFilesAndCommands();
  await testSnapshotCacheReusesUnchangedWorkspace();
  await testSnapshotCacheInvalidatesOnFinalDiff();
  await testSnapshotCacheRespectsHiddenFiltering();
  await testWorkspaceProjectPatchExportImport();
  await testWorkspaceConcurrentAppendFile();
  await testWorkspaceConcurrentFilesystemMutations();
  await testWorkspaceConcurrentRunCommandSerialization();
  await testWorkspaceRunCommandsCanOverlap();
  await testWorkspaceSchedulerQueuesBeyondConcurrencyLimit();
  await testWorkspaceSchedulerRejectsBeyondQueueLimit();
  await testWorkspaceSchedulerQueueSlotReleasedAfterCancellation();
  await testWorkspaceProcProcessState();
  await testTraceKernelRuntimeDiscovery();
  await testTraceKernelSkillsRoot();
  await testWorkspaceTraceKernelKillProcess();
  await testWorkspaceTraceKernelKillPropagatesToNativeNodeRunner();
  await testWorkspaceTraceKernelKillProcessGroup();
  await testWorkspaceTraceKernelWaitBlocksUntilZombie();
  await testWorkspaceQueuedCommandCancellation();
  await testWorkspaceVfsLockWaitCancellation();
  await testWorkspaceVfsLockHolderCancellationReleasesWaiters();
  await testWorkspaceFinalDiffLockWaitCancellation();
  await testWorkspaceLiveFilesystemSyscallEventsAndCancellation();
  await testWorkspaceShellProcessUtilities();
  await testWorkspaceDestroyWaitsForActiveCommand();
  await testWorkspaceConcurrentMutationDoesNotEnterCommandEvents();
  await testWorkspaceStaleFinalDiffIsRejected();
  await testWorkspaceConcurrentStaleFinalDiffStress();
  await testWorkspaceFinalDiffTransactionRejectsWithoutPartialCommit();
  await testWorkspaceFinalDiffDirectoryDeleteTransactionIsAtomic();
  await testWorkspaceAdapterFinalDiffTransactionsRejectStaleBatches();
  await testWorkspaceFinalDiffTransactionRollsBackUnexpectedApplyFailure();
  await testWorkspaceFinalDiffUpdatesKernelInodeTable();
  await testWorkspaceMetadataIsConsistentAcrossLiveAndFinalDiffWrites();
  await testWorkspaceConcurrentIndependentFinalDiffWrites();
  await testWorkspaceRenameConflictsWithStaleFinalDiffWrite();
  await testPythonCommandAdapter();
  await testNodeCommandAdapter();
  await testPythonNodeCommandAdapterGlobScripts();
  await testCommandAdapterWorkspaceCwd();
  await testJavaCommandAdapter();
  await testJavaRunCommandGlobExpansion();
  await testCppCommandAdapter();
  await testCppBareOutputRunsInFirstCompoundCommand();
  await testCSharpCommandAdapter();
  await testCompileCommandGlobExpansion();
  await testNativeCompileGlobProjectRunners();
  await testNativePythonProjectRunner();
  await testNativeNestedPythonProjectRunner();
  await testNativePythonModuleProjectRunner();
  await testNativePythonPathProjectRunner();
  await testNativePythonProjectRunnerCwd();
  await testNativePythonProjectRunnerStdin();
  await testNativePythonProjectRunnerAbsoluteWorkspacePaths();
  await testNativePythonProjectRunnerDirectAbsoluteScriptPath();
  await testNativeJavaScriptProjectRunner();
  await testNativeJavaScriptProjectRunnerCwd();
  await testNativeJavaScriptProjectRunnerStdin();
  await testNativeJavaScriptProjectRunnerAbsoluteWorkspacePaths();
  await testProjectJavaScriptRunnersDirectAbsoluteScriptPath();
  await testBrowserJavaScriptProjectRunnerApplyFileChangeHook();
  await testBrowserJavaScriptProjectRunnerKernelDeviceInventory();
  await testProjectJavaScriptRunnersPreserveEmptyDirectories();
  await testBrowserJavaScriptProjectRunner();
  await testTraceKernelHttpNodeServer();
  await testTraceKernelHttpNodeServerWorkerBridge();
  await testExternalFetchFromJavaScriptWorker();
  await testTraceKernelHttpBindSemantics();
  await testTraceKernelHttpPythonRunnerBridge();
  await testTraceKernelHttpPythonRunnerClientBridge();
  await testTraceKernelHttpJavaRunnerBridge();
  await testTraceKernelHttpLanguageBridgeConformance();
  await testBrowserJavaScriptProjectRunnerAbortSignal();
  await testBrowserJavaScriptProjectRunnerCwd();
  await testBrowserJavaScriptProjectRunnerStdin();
  await testBrowserJavaScriptProjectRunnerLiveIoEvents();
  await testNativeJavaScriptProjectRunnerModuleGlobals();
  await testBrowserJavaScriptProjectRunnerModuleGlobals();
  await testNativeJavaScriptProjectRunnerEsmImports();
  await testBrowserJavaScriptProjectRunnerEsmImports();
  await testNativeJavaScriptProjectRunnerDuplicateBasenameImports();
  await testBrowserJavaScriptProjectRunnerDuplicateBasenameImports();
  await testNativeJavaProjectRunner();
  await testNativeJavaAssertionProjectRunner();
  await testNativeJavaSystemPropertiesProjectRunner();
  await testNativeJavaJarProjectRunner();
  await testNativePackagedJavaProjectRunner();
  await testNativeJavaJarClasspathProjectRunner();
  await testNativeJavaArgfileWorkspacePathsProjectRunner();
  await testNativeJavaDuplicateBasenameProjectRunner();
  await testNativeJavaProjectRunnerStdin();
  await testNativeJavaProjectRunnerCwd();
  await testNativeJavaProjectRunnerAbsoluteWorkspaceCommandPaths();
  await testNativeJavaProjectRunnerDirectCwdBoundary();
  await testNativeJavaProjectRunnerDirectAbsoluteOperandBoundaries();
  await testNativeCppProjectRunnerDirectCwdBoundary();
  await testNativeCppProjectRunnerDirectAbsoluteDefaultScriptPath();
  await testNativeCppProjectRunnerDirectAbsoluteOperandBoundaries();
  await testNativeCppProjectRunnerClosedStdin();
  await testNativeCppProjectRunner();
  await testNativeCppProjectRunnerAbsoluteWorkspacePaths();
  await testNativeCSharpProjectRunner();
  await testNativeCSharpProjectRunnerDirectCwdBoundary();
  await testNativeCSharpProjectRunnerDirectAbsoluteOperandBoundary();
  await testNativeCSharpProjectRunnerAbsoluteWorkspaceProjectPath();
  await testNativeCSharpEmbeddedResourceProjectRunner();
  await testNativeCSharpLibraryProjectRunner();
  await testNativeCSharpHintPathReferenceProjectRunner();
  await testNativeCSharpProjectReferenceProjectRunner();
  await testNativeCSharpProjectFileBoundaryProjectRunner();
  await testNativeCSharpProjectRunnerCwdProjectSelection();
  await testNativeCSharpCommandLinePropertiesProjectRunner();
  await testLiveStdinAcrossProjectRunners();
  await testBrowserJavaProjectRunnerAdapter();
  await testPyodidePythonProjectRunnerAdapter();
  await testBrowserCSharpProjectRunnerAdapter();
  await testBrowserCppProjectRunnerAdapter();
  await testBrowserProjectWorkspaceFactory();
  await testBrowserProjectWorkspaceCrossRunnerFilesystemVisibility();
  await testBrowserKernelStorageRehydrationPreservesReadonlyPolicy();
  await testBrowserKernelStorageCoalescesPersistence();
  await testBrowserKernelStorageFlushPersistsDirtyState();
  await testBrowserKernelStorageTreatsEmptySnapshotAsAuthoritative();
  await testBrowserKernelStoragePersistsUnstreamedFilesystemMutations();
  await testBrowserKernelStorageRetriesAndReportsBackgroundFailures();
  await testBrowserProjectSharedWorkersRequireTrustedOptIn();
  await testBrowserProjectWorkspaceTraceKernelConfig();
  await testBrowserProjectWorkspaceAdvancedCommandTranslation();
  await testNativeProjectWorkspaceFactory();
  await testProjectWorkspaceCommandEvents();
  await testRuntimeProjectEventQueueRecoversAfterApplyFailure();
  await testWorkspaceKernelEvents();
  await testWorkspaceTerminalSessionCwd();
  await testProjectSessionMetadataAndCommands();
  await testPackageManagerProjectCommands();
  await testTypeScriptProjectCommands();
  await testHardLanguageTakehomeMvpGate();
  await testProjectSessionLifecycle();
  await testExpiredReadonlySessionRejectsWithoutPolling();
  await testExpiredDestroySessionDestroysWithoutPolling();
  await testExpirationEmitsOnce();
  await testTraceKernelInfoConfig();
  await testConfiguredKernelNativePythonAndNodeRunners();
  await testConfiguredKernelNativeCompiledRunners();
  await testConfiguredKernelAliasGlobCommandTranslation();
  console.log('PASS: project workspace primitives are backed by just-bash');
}

// Keep Node alive until the asynchronous gate settles without creating a
// timer that the in-process browser runtime can mistake for learner work.
const testProcessKeepAlive = new MessageChannel();
testProcessKeepAlive.port1.on('message', () => undefined);
void test('project workspace', main).finally(() => {
  testProcessKeepAlive.port1.close();
  testProcessKeepAlive.port2.close();
});

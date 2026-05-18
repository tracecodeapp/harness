#!/usr/bin/env npx tsx

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  type JavaScriptProjectCommandRequest,
  type JavaProjectCommandRequest,
  type CppProjectCommandRequest,
  type CSharpProjectCommandRequest,
  type PythonProjectCommandRequest,
  type RuntimeCommandEvent,
  type RuntimeWorkspaceEvent,
  createRuntimeWorkspace,
  normalizeRuntimeProjectPath,
} from '../packages/harness-project/src/index';
import { createNativePythonProjectRunner } from '../packages/harness-python/src/project-node';
import {
  createBrowserPythonProjectRunner,
  createPyodidePythonProjectRunner,
} from '../packages/harness-python/src/project-browser';
import { createBrowserProjectWorkspace } from '../packages/harness-browser/src/project';
import { createNativeJavaScriptProjectRunner } from '../packages/harness-javascript/src/project-node';
import { createBrowserJavaScriptProjectRunner } from '../packages/harness-javascript/src/project-browser';
import { createNativeJavaProjectRunner } from '../packages/harness-java/src/project-node';
import { createBrowserJavaProjectRunner } from '../packages/harness-java/src/project-browser';
import { createNativeCppProjectRunner } from '../packages/harness-cpp/src/project-node';
import { createBrowserCppProjectRunner } from '../packages/harness-cpp/src/project-browser';
import { createNativeCSharpProjectRunner } from '../packages/harness-csharp/src/project-node';
import { createBrowserCSharpProjectRunner } from '../packages/harness-csharp/src/project-browser';
import { createNativeProjectWorkspace } from '../src/project-node';

const execFileAsync = promisify(execFile);

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
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
        '    <TargetFramework>net8.0</TargetFramework>',
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
    return (await readFile(join(root, 'bin', 'Release', 'net8.0', 'ExternalLib.dll'))).toString('base64');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createArArchiveBase64(memberName: string, memberBase64: string): string {
  const member = Buffer.from(memberBase64, 'base64');
  const field = (value: string | number, width: number) => String(value).slice(0, width).padEnd(width, ' ');
  const nameFieldLength = (Math.ceil(memberName.length / 8) * 8 || 8) + 4;
  const nameField = Buffer.alloc(nameFieldLength);
  nameField.write(memberName, 0, 'utf8');
  const header = Buffer.from([
    '!<arch>\n',
    field(`#1/${nameFieldLength}`, 16),
    field(0, 12),
    field(0, 6),
    field(0, 6),
    field('100644', 8),
    field(nameField.length + member.length, 10),
    '`\n',
  ].join(''));
  const padding = member.length % 2 === 0 ? Buffer.alloc(0) : Buffer.from('\n');
  return Buffer.concat([header, nameField, member, padding]).toString('base64');
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
  assertCondition(fileStat.isFile && !fileStat.isDirectory, 'stat should identify relative workspace files');
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
  await workspace.mkdir('src/created/deep');
  await workspace.mkdir('/workspace/src/absolute-created');
  await workspace.mkdir('src/persist-empty/deep');
  await workspace.mkdir('.');
  const createdStat = await workspace.stat('src/created/deep');
  assertCondition(!createdStat.isFile && createdStat.isDirectory, 'mkdir should create recursive relative directories');
  const absoluteCreatedStat = await workspace.stat('/workspace/src/absolute-created');
  assertCondition(!absoluteCreatedStat.isFile && absoluteCreatedStat.isDirectory, 'mkdir should create absolute virtual directories');
  assertCondition(
    (await workspace.readDir('src/created')).join(',') === 'deep',
    'mkdir should make created directories visible to readDir'
  );
  await workspace.copyFile('src/hello.txt', 'src/copied/hello-copy.txt');
  assertCondition(await workspace.readFile('src/copied/hello-copy.txt') === 'hello\n', 'copyFile should copy text files');
  await workspace.copyFile('/workspace/src/binary.bin', '/workspace/src/copied/binary-copy.bin');
  assertCondition(
    (await workspace.readFile('src/copied/binary-copy.bin', 'base64')) === Buffer.from([0, 1, 2, 255, 3, 4]).toString('base64'),
    'copyFile should preserve binary files'
  );
  await workspace.moveFile('src/copied/hello-copy.txt', 'src/moved/hello-moved.txt');
  assertCondition(await workspace.readFile('src/moved/hello-moved.txt') === 'hello\n', 'moveFile should move text files');
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
  await workspace.remove('src/created', { recursive: true });
  assertCondition(!(await workspace.exists('src/created/deep')), 'remove should recursively delete relative directories');
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
  assertCondition(received?.project.cwd === '/workspace', 'node adapter project snapshot should keep workspace root cwd');
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

  const explicitRun = await workspace.runCommand('cpp-run bin/*.out data/*.txt');
  assertCondition(explicitRun.exitCode === 0, 'cpp-run adapter should expand explicit executable and argv globs');
  assertCondition(
    explicitRun.stdout === 'source=run\nscript=bin/app.out\nargs=data/a.txt,data/b.txt\nfiles=a.out,bin/app.out,data/a.txt,data/b.txt,generated.txt,helper.hpp,main.cpp\n',
    `cpp-run adapter should expand script and argv globs, received ${JSON.stringify(explicitRun.stdout)}`
  );
  assertCondition(requests.length === 9, 'cpp runner should be invoked for compile variants and direct executable runs');
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

  const configuredRun = await workspace.runCommand('dotnet run --project apps/App.csproj --configuration Release --framework net8.0 --no-restore -- data/*.txt');
  assertCondition(configuredRun.exitCode === 0, 'dotnet run adapter should preserve build-affecting options');
  assertCondition(
    configuredRun.stdout === 'source=run\nscript=apps/App.csproj\nargs=data/a.txt,data/b.txt\nbuildArgs=--configuration,Release,--framework,net8.0,--no-restore\nfiles=apps/App.csproj,build/.keep,data/a.txt,data/b.txt,generated.txt,Helper.cs,Program.cs\n',
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
    cppRunner: createNativeCppProjectRunner(),
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
    stdin: '',
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
      stdin: '',
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
      stdin: '',
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
    '"(async () => { const fs = require(\\"node:fs\\"); const fsp = require(\\"node:fs/promises\\"); fs.mkdirSync(\\"dirent/sub\\", { recursive: true }); fs.writeFileSync(\\"dirent/file.txt\\", \\"x\\"); const label = (entry) => entry.name + \\":\\" + entry.isFile() + \\":\\" + entry.isDirectory() + \\":\\" + entry.isSymbolicLink(); const syncEntries = fs.readdirSync(\\"dirent\\", { withFileTypes: true }).map(label).sort(); console.log(syncEntries.join(\\"|\\")); const asyncEntries = (await fsp.readdir(\\"dirent\\", { withFileTypes: true })).map(label).sort(); console.log(asyncEntries.join(\\"|\\")); })();"',
  ].join(' '));
  assertCondition(direntResult.exitCode === 0, `native node readdir Dirent workflow should succeed: ${direntResult.stderr}`);
  assertCondition(
    direntResult.stdout === 'file.txt:true:false:false|sub:false:true:false\nfile.txt:true:false:false|sub:false:true:false\n',
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
    stdin: '',
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

  const browserResult = await createBrowserJavaScriptProjectRunner()(request);
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
  const browserOutsideResult = await createBrowserJavaScriptProjectRunner()({
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
    () => createBrowserJavaScriptProjectRunner()({
      ...request,
      cwd: '/outside',
    }),
    'browser node direct runner should reject cwd outside the workspace'
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
    stdin: '',
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

  const browserResult = await createBrowserJavaScriptProjectRunner()(request);
  assertCondition(browserResult.exitCode === 0, `browser node should see project snapshot directories: ${browserResult.stderr}`);
  assertCondition(
    browserResult.stdout === 'true\nchild\n',
    `browser node should preserve project snapshot directories: ${browserResult.stdout}`
  );
}

async function testBrowserJavaScriptProjectRunner(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [
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
      { path: 'index.js', contents: 'const { add } = require("./lib/math"); console.log(add(2, 3)); console.log(process.argv.slice(2).join(","));\n' },
    ],
    nodeRunner: createBrowserJavaScriptProjectRunner(),
  });

  const result = await workspace.runCommand('node index.js alpha beta');
  assertCondition(result.exitCode === 0, `browser node should succeed: ${result.stderr}`);
  assertCondition(result.stdout === '9\nalpha,beta\n', `browser node should support require/json/argv: ${result.stdout}`);

  const codeResult = await workspace.runCommand('node -e "const { add } = require(\\"./lib/math\\"); console.log(add(10, 7))"');
  assertCondition(codeResult.exitCode === 0, `browser node -e should succeed: ${codeResult.stderr}`);
  assertCondition(codeResult.stdout === '21\n', `browser node -e should import project files: ${codeResult.stdout}`);

  const evalArgvResult = await workspace.runCommand('node -e "console.log(process.argv.slice(1).join(\\"\\,\\"))" alpha beta');
  assertCondition(evalArgvResult.exitCode === 0, `browser node -e argv should succeed: ${evalArgvResult.stderr}`);
  assertCondition(evalArgvResult.stdout === 'alpha,beta\n', `browser node -e argv should match desktop semantics: ${evalArgvResult.stdout}`);

  const rootRequireResult = await workspace.runCommand('node -e "const { add } = require(\\"lib/math\\"); console.log(add(1, 4))"');
  assertCondition(rootRequireResult.exitCode === 0, `browser node root require should succeed: ${rootRequireResult.stderr}`);
  assertCondition(rootRequireResult.stdout === '9\n', `browser node root require should resolve from workspace root: ${rootRequireResult.stdout}`);

  const packageResult = await workspace.runCommand('node -e "const { add } = require(\\"adder\\"); console.log(add(1, 4))"');
  assertCondition(packageResult.exitCode === 0, `browser node package require should succeed: ${packageResult.stderr}`);
  assertCondition(packageResult.stdout === '105\n', `browser node package require should resolve package main: ${packageResult.stdout}`);

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

  const inspectResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); fs.writeFileSync(\\"tree/nested/value.txt\\", \\"nested\\\\n\\"); console.log(fs.statSync(\\"lib/math.js\\").isFile()); console.log(fs.statSync(\\"tree\\").isDirectory()); console.log(fs.readdirSync(\\"/workspace\\").includes(\\"tree\\")); console.log(fs.readdirSync(\\"tree/nested\\").join(\\"\\,\\")); fs.rmSync(\\"tree\\", { recursive: true }); console.log(fs.existsSync(\\"tree/nested/value.txt\\"));"',
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
      event.change.contents === 'callback\nappend\n'
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
      event.change.contents === 'hello\nbytes\nappend\n'
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
      event.change.contents === 'one\ntwo\n'
    ),
    `browser node createWriteStream should emit live file mutations: ${JSON.stringify(streamEvents)}`
  );

  const stdioFdResult = await workspace.runCommand([
    'node',
    '-e',
    '"const fs = require(\\"node:fs\\"); console.log(fs.readFileSync(0, \\"utf8\\").trim()); process.stdout.write(\\"stream-out\\\\n\\"); fs.writeFileSync(1, \\"fd-out\\\\n\\"); process.stderr.write(\\"stream-err\\\\n\\"); fs.writeFileSync(2, \\"fd-err\\\\n\\");"',
  ].join(' '), { stdin: 'from-fd\n' });
  assertCondition(stdioFdResult.exitCode === 0, `browser node stdio fd workflow should succeed: ${stdioFdResult.stderr}`);
  assertCondition(
    stdioFdResult.stdout === 'from-fd\nstream-out\nfd-out\n' &&
      stdioFdResult.stderr === 'stream-err\nfd-err\n',
    `browser node should map fd 0/1/2 to kernel stdio devices: ${JSON.stringify(stdioFdResult)}`
  );

  const processStdinResult = await workspace.runCommand([
    'node',
    '-e',
    '"process.stdin.setEncoding(\\"utf8\\"); console.log(process.stdin.read().trim());"',
  ].join(' '), { stdin: 'from-process\n' });
  assertCondition(processStdinResult.exitCode === 0, `browser node process.stdin workflow should succeed: ${processStdinResult.stderr}`);
  assertCondition(
    processStdinResult.stdout === 'from-process\n',
    `browser node process.stdin should expose request stdin as a readable device: ${JSON.stringify(processStdinResult)}`
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
    builtinResult.stdout === 'browser\n/tmp\ntrue\n1\n/workspace/lib/math.js\n',
    `browser node os/url builtins should expose desktop-shaped APIs: ${builtinResult.stdout}`
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
    nodeRunner: createBrowserJavaScriptProjectRunner(),
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
    nodeRunner: createBrowserJavaScriptProjectRunner(),
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
          'fs.renameSync("live.txt", "moved.txt");',
          'fs.writeFileSync("/dev/stdout", "device-out\\n");',
          'fs.writeFileSync("/dev/stderr", "device-err\\n");',
          'fs.unlinkSync("stale.txt");',
          '',
        ].join('\n'),
      },
    ],
    nodeRunner: createBrowserJavaScriptProjectRunner(),
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
      event.change.contents === 'one\ntwo\n'
    ),
    `workspace watch should receive browser node live append events: ${JSON.stringify(watchEvents)}`
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
      event.change.contents === 'one\ntwo\n'
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
    nodeRunner: createBrowserJavaScriptProjectRunner(),
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
    nodeRunner: createBrowserJavaScriptProjectRunner(),
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
    nodeRunner: createBrowserJavaScriptProjectRunner(),
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

  const compile = await workspace.runCommand('javac Main.java Helper.java');
  assertCondition(compile.exitCode === 0, `native javac should succeed: ${compile.stderr}`);

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

  const run = await workspace.runCommand('java InputMain', { stdin: 'from-native\n' });
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
    stdin: '',
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
    stdin: '',
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
    stdin: '',
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
    stdin: '',
    project: {
      cwd: '/workspace',
      files: [{ path: 'src/main.cpp', contents: '#include <iostream>\nint main() { std::cout << "direct-cpp\\n"; }\n' }],
    },
    options: { compilerCommand: 'clang++' },
  });

  assertCondition(result.exitCode === 0, `native C++ direct runner should accept /workspace default scriptPath: ${result.stderr}`);
  assertCondition(
    result.files?.some((file) => file.path === 'src/a.out' && file.encoding === 'base64') === true,
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
      stdin: '',
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
    stdin: '',
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
    stdin: 'from-stdin\n',
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

  const stdinCompile = await workspace.runCommand('clang++ -std=c++17 -x c++ - -o /workspace/out/stdin-app', {
    stdin: '#include <iostream>\nint main() { std::cout << "stdin-cpp\\n"; }\n',
  });
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
  await workspace.writeFile('src/lib/liblinked.a', createArArchiveBase64('linked.o', objectBase64), 'base64');
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
    stdin: 'from-stdin\n',
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
    stdin: 'launch-stdin\n',
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
    stdin: 'no-build-stdin\n',
  });
  assertCondition(noBuildRun.exitCode === 0, `native dotnet run --no-build should execute persisted build output: ${noBuildRun.stderr}`);
  assertCondition(
    noBuildRun.stdout.endsWith('42\nno-build-stdin\nnative-csharp-nobuild\nstale\n'),
    `native dotnet run --no-build should skip rebuilding changed sources: ${noBuildRun.stdout}`
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
    stdin: '',
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
    stdin: '',
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
          '    <TargetFramework>net8.0</TargetFramework>',
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
          '    <TargetFramework>net8.0</TargetFramework>',
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
          '    <TargetFramework>net8.0</TargetFramework>',
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
          '    <TargetFramework>net8.0</TargetFramework>',
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
          '    <TargetFramework>net8.0</TargetFramework>',
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
          '    <TargetFramework>net8.0</TargetFramework>',
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
          '    <TargetFramework>net8.0</TargetFramework>',
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
      '    <TargetFramework>net8.0</TargetFramework>',
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
      '    <TargetFramework>net8.0</TargetFramework>',
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
    '    <TargetFramework>net8.0</TargetFramework>',
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
          '    <TargetFramework>net8.0</TargetFramework>',
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

async function testBrowserJavaProjectRunnerAdapter(): Promise<void> {
  let received: JavaProjectCommandRequest | null = null;
  let callCount = 0;
  const events: RuntimeCommandEvent[] = [];
  const runner = createBrowserJavaProjectRunner({
    async executeProjectJava(request, _timeoutMs, onEvent) {
      callCount += 1;
      received = request;
      onEvent?.({ type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'java-streamed\n' });
      onEvent?.({ type: 'file-change', phase: 'final-diff', change: { path: 'java-generated.txt', contents: 'generated\n' } });
      return {
        stdout: `java-streamed\n${request.source}:${request.scriptPath}:${request.project.files.length}`,
        stderr: '',
        exitCode: 0,
      };
    },
  });

  const result = await runner({
    code: '',
    source: 'run',
    scriptPath: 'Main',
    args: ['alpha'],
    cwd: '/workspace',
    env: {},
    stdin: '',
    project: {
      files: [{ path: 'Main.java', contents: 'class Main {}\n' }],
    },
    onEvent: (event) => events.push(event),
  });

  assertCondition(result.stdout === 'java-streamed\nrun:Main:1', 'browser java runner should delegate to worker client');
  assertCondition(received?.scriptPath === 'Main', 'browser java runner should pass through request');
  assertCondition(
    events.filter((event) => event.type === 'output' && event.stream === 'stdout').length === 1,
    `browser java runner should not duplicate final stdout after streamed stdout events: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'final-diff' &&
      event.change.path === 'java-generated.txt'
    ),
    `browser java runner should forward worker final-diff file-change events: ${JSON.stringify(events)}`
  );

  const previewResult = await runner({
    code: '',
    source: 'run',
    scriptPath: 'Main',
    args: [],
    cwd: '/workspace',
    env: {},
    stdin: '',
    project: {
      files: [{ path: 'Main.java', contents: 'class Main {}\n' }],
    },
    options: { enablePreview: true },
  });
  assertCondition(
    previewResult.exitCode !== 0 &&
      previewResult.stderr.includes('--enable-preview is not supported in the browser project environment'),
    `browser java runner should reject preview mode locally: ${previewResult.stderr}`
  );
  assertCondition(callCount === 1, 'browser java runner should reject preview mode before invoking the worker');

  const assertionsResult = await runner({
    code: '',
    source: 'run',
    scriptPath: 'Main',
    args: [],
    cwd: '/workspace',
    env: {},
    stdin: '',
    project: {
      files: [{ path: 'Main.java', contents: 'class Main {}\n' }],
    },
    options: { enableAssertions: true },
  });
  assertCondition(
    assertionsResult.exitCode !== 0 &&
      assertionsResult.stderr.includes('-ea is not supported in the browser project environment'),
    `browser java runner should reject assertions mode locally: ${assertionsResult.stderr}`
  );
  assertCondition(callCount === 1, 'browser java runner should reject assertions mode before invoking the worker');
}

async function testPyodidePythonProjectRunnerAdapter(): Promise<void> {
  let received: PythonProjectCommandRequest | null = null;
  const events: RuntimeCommandEvent[] = [];
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
  const runner = createBrowserPythonProjectRunner(client);

  const result = await runner({
    code: 'print("hello")',
    source: 'file',
    scriptPath: 'main.py',
    args: [],
    cwd: '/workspace',
    env: {},
    stdin: '',
    project: {
      files: [{ path: 'main.py', contents: 'print("hello")\n' }],
    },
    onEvent: (event) => events.push(event),
  });

  assertCondition(result.stdout === 'streamed\nmain.py:1', 'pyodide runner should delegate to worker client');
  assertCondition(received?.scriptPath === 'main.py', 'pyodide runner should pass through request');
  assertCondition(
    events.filter((event) => event.type === 'output' && event.stream === 'stdout').length === 1,
    `pyodide runner should not duplicate final stdout after streamed stdout events: ${JSON.stringify(events)}`
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
    createPyodidePythonProjectRunner(client) !== runner,
    'pyodide python project runner alias should remain available'
  );
}

async function testBrowserCSharpProjectRunnerAdapter(): Promise<void> {
  let received: CSharpProjectCommandRequest | null = null;
  const events: RuntimeCommandEvent[] = [];
  const runner = createBrowserCSharpProjectRunner({
    async executeProjectCSharp(request, _timeoutMs, onEvent) {
      received = request;
      onEvent?.({ type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'csharp-streamed\n' });
      onEvent?.({ type: 'file-change', phase: 'final-diff', change: { path: 'csharp-generated.txt', contents: 'generated\n' } });
      return {
        stdout: `csharp-streamed\n${request.source}:${request.scriptPath}:${request.args.join(',')}:${request.project.files.length}`,
        stderr: '',
        exitCode: 0,
      };
    },
  });

  const result = await runner({
    code: '',
    source: 'run',
    scriptPath: '<project>',
    args: ['alpha', 'beta'],
    cwd: '/workspace',
    env: {},
    stdin: '',
    project: {
      files: [{ path: 'Program.cs', contents: 'Console.WriteLine("hello");\n' }],
    },
    onEvent: (event) => events.push(event),
  });

  assertCondition(result.stdout === 'csharp-streamed\nrun:<project>:alpha,beta:1', 'browser C# runner should delegate to worker client');
  assertCondition(received?.scriptPath === '<project>', 'browser C# runner should pass through request');
  assertCondition(
    events.filter((event) => event.type === 'output' && event.stream === 'stdout').length === 1,
    `browser C# runner should not duplicate final stdout after streamed stdout events: ${JSON.stringify(events)}`
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
    stdin: '',
    project: {
      files: [{ path: 'Program.cs', contents: 'Console.WriteLine("hello");\n' }],
    },
    options: { noBuild: true },
  });
  assertCondition(
    noBuildResult.exitCode !== 0 && noBuildResult.stderr.includes('--no-build is not supported in the browser project environment'),
    `browser C# runner should reject no-build mode locally: ${noBuildResult.stderr}`
  );
  assertCondition(received?.scriptPath === '<project>', 'browser C# no-build rejection should not invoke worker client');
}

async function testBrowserCppProjectRunnerAdapter(): Promise<void> {
  let received: CppProjectCommandRequest | null = null;
  const events: RuntimeCommandEvent[] = [];
  const runner = createBrowserCppProjectRunner({
    async executeProjectCpp(request, _timeoutMs, onEvent) {
      received = request;
      onEvent?.({ type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'cpp-streamed\n' });
      onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'cpp-live.txt', contents: 'live\n' } });
      return {
        stdout: `cpp-streamed\n${request.source}:${request.scriptPath}:${request.args.join(',')}:${request.project.files.length}`,
        stderr: '',
        exitCode: 0,
      };
    },
  });

  const result = await runner({
    code: '',
    source: 'compile',
    scriptPath: 'main.cpp',
    args: ['main.cpp', '-o', 'a.out'],
    cwd: '/workspace',
    env: {},
    stdin: '',
    project: {
      files: [{ path: 'main.cpp', contents: 'int main() { return 0; }\n' }],
    },
    onEvent: (event) => events.push(event),
  });

  assertCondition(result.stdout === 'cpp-streamed\ncompile:main.cpp:main.cpp,-o,a.out:1', 'browser C++ runner should delegate to worker client');
  assertCondition(received?.scriptPath === 'main.cpp', 'browser C++ runner should pass through request');
  assertCondition(
    events.filter((event) => event.type === 'output' && event.stream === 'stdout').length === 1,
    `browser C++ runner should not duplicate final stdout after streamed stdout events: ${JSON.stringify(events)}`
  );
  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
      event.phase === 'live' &&
      event.change.path === 'cpp-live.txt'
    ),
    `browser C++ runner should forward worker live file-change events: ${JSON.stringify(events)}`
  );
}

async function testBrowserProjectWorkspaceFactory(): Promise<void> {
  const dynamicEvalDisabledWorkspace = await createBrowserProjectWorkspace({
    files: [{ path: 'index.js', contents: 'console.log("node")\n' }],
    nodeProject: { allowDynamicEval: false },
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
      dynamicEvalDisabled.exitCode !== 0 &&
        dynamicEvalDisabled.stderr.includes('browser JavaScript project runner requires dynamic evaluation'),
      `browser project workspace should pass nodeProject options to the JS runner: ${dynamicEvalDisabled.stderr}`
    );
  } finally {
    dynamicEvalDisabledWorkspace.dispose();
  }

  const nodeTimeoutWorkspace = await createBrowserProjectWorkspace({
    files: [],
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
    const timeout = await nodeTimeoutWorkspace.runCommand('node -e "await new Promise((resolve) => setTimeout(resolve, 25)); console.log(\\"late\\")"');
    assertCondition(
      timeout.exitCode === 124 && timeout.stderr.includes('node: execution timed out after 5ms'),
      `browser project workspace should pass nodeProjectTimeoutMs to the JS runner: ${JSON.stringify(timeout)}`
    );
  } finally {
    nodeTimeoutWorkspace.dispose();
  }

  let pythonTimeoutMs: number | undefined;
  let javaTimeoutMs: number | undefined;
  let csharpTimeoutMs: number | undefined;
  const cppTimeouts: Array<number | undefined> = [];
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
    javaProjectTimeoutMs: 12,
    csharpProjectTimeoutMs: 13,
    cppProjectTimeoutMs: 14,
    pythonWorkerClient: {
      async executeProjectPython(request, timeoutMs) {
        pythonTimeoutMs = timeoutMs;
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
      async executeProjectJava(request, timeoutMs) {
        javaTimeoutMs = timeoutMs;
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
      async executeProjectCSharp(request, timeoutMs) {
        csharpTimeoutMs = timeoutMs;
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
      async executeProjectCpp(request, timeoutMs) {
        cppTimeouts.push(timeoutMs);
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
    const python = await workspace.runCommand('python3 main.py');
    assertCondition(python.exitCode === 0, `browser project workspace python should succeed: ${python.stderr}`);
    assertCondition(python.stdout === 'file:main.py:5:2\n', `browser project workspace should wire Pyodide runner with directories: ${python.stdout}`);
    assertCondition(pythonTimeoutMs === 11, 'browser project workspace should pass pythonProjectTimeoutMs to the Python runner');
    assertCondition(await workspace.readFile('python.txt') === 'python\n', 'browser project workspace should apply Python file changes');
    assertCondition((await workspace.readDir('empty')).join(',') === 'child', 'browser project workspace should preserve empty directories in snapshots');

    const node = await workspace.runCommand('node index.js');
    assertCondition(node.exitCode === 0, `browser project workspace node should succeed: ${node.stderr}`);
    assertCondition(await workspace.readFile('node.txt') === 'node\n', 'browser project workspace should wire browser Node runner');

    const java = await workspace.runCommand('java Main');
    assertCondition(java.exitCode === 0, `browser project workspace java should succeed: ${java.stderr}`);
    assertCondition(java.stdout === 'run:Main:7:2\n', `browser project workspace should wire Java runner with directories: ${java.stdout}`);
    assertCondition(javaTimeoutMs === 12, 'browser project workspace should pass javaProjectTimeoutMs to the Java runner');
    assertCondition(await workspace.readFile('java.txt') === 'java\n', 'browser project workspace should apply Java file changes');

    const csharp = await workspace.runCommand('dotnet run alpha beta');
    assertCondition(csharp.exitCode === 0, `browser project workspace C# should succeed: ${csharp.stderr}`);
    assertCondition(csharp.stdout === 'run:<project>:alpha,beta:8:2\n', `browser project workspace should wire C# runner with directories: ${csharp.stdout}`);
    assertCondition(csharpTimeoutMs === 13, 'browser project workspace should pass csharpProjectTimeoutMs to the C# runner');
    assertCondition(await workspace.readFile('csharp.txt') === 'csharp\n', 'browser project workspace should apply C# file changes');

    const cpp = await workspace.runCommand('clang++ main.cpp -o a.out');
    assertCondition(cpp.exitCode === 0, `browser project workspace C++ should succeed: ${cpp.stderr}`);
    assertCondition(cpp.stdout === 'compile:main.cpp:main.cpp,-o,a.out:9:2\n', `browser project workspace should wire C++ runner with directories: ${cpp.stdout}`);
    assertCondition(cppTimeouts[0] === 14, 'browser project workspace should pass cppProjectTimeoutMs to C++ compile runner calls');
    assertCondition(await workspace.readFile('cpp.txt') === 'cpp\n', 'browser project workspace should apply C++ file changes');

    const cppRunEvents: RuntimeCommandEvent[] = [];
    const cppRun = await workspace.runCommand('./a.out alpha beta', {
      onEvent: (event) => cppRunEvents.push(event),
    });
    assertCondition(cppRun.exitCode === 0, `browser project workspace C++ executable should run: ${cppRun.stderr}`);
    assertCondition(
      cppRun.stdout === 'run:a.out:alpha,beta:10:2\n',
      `browser project workspace should route direct C++ executable runs with directories: ${cppRun.stdout}`
    );
    assertCondition(
      cppRunEvents.some((event) =>
        event.type === 'output' &&
        event.stream === 'stdout' &&
        event.device === '/dev/stdout' &&
        event.data === 'run:a.out:alpha,beta:10:2\n'
      ),
      `browser project workspace should emit final stdout events for direct C++ executable runs: ${JSON.stringify(cppRunEvents)}`
    );
    assertCondition(cppTimeouts[1] === 14, 'browser project workspace should pass cppProjectTimeoutMs to C++ run runner calls');
  } finally {
    workspace.dispose();
  }
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
          'console.log(os.homedir());',
          'console.log(path.resolve("src/alias.txt"));',
          'console.log(__filename);',
          'console.log(__dirname);',
          'console.log(require.resolve("./index.js"));',
          'console.log(require.resolve("/home/ada/weather-api/lib/value.js"));',
          'console.log(value.answer);',
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
    pythonWorkerClient: {
      async executeProjectPython(request) {
        pythonRequests.push(request);
        return {
          stdout: `${request.cwd}:${request.project.workspaceRoot}:${request.project.workspaceAlias}\n`,
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
        return { stdout: `${request.cwd}:${request.project.workspaceRoot}:${request.project.workspaceAlias}\n`, stderr: '', exitCode: 0 };
      },
      terminate() {},
    },
    csharpWorkerClient: {
      async executeProjectCSharp(request) {
        csharpRequests.push(request);
        return { stdout: `${request.cwd}:${request.project.workspaceRoot}:${request.project.workspaceAlias}\n`, stderr: '', exitCode: 0 };
      },
      terminate() {},
    },
    cppWorkerClient: {
      async executeProjectCpp(request) {
        cppRequests.push(request);
        return {
          stdout: `${request.cwd}:${request.project.workspaceRoot}:${request.project.workspaceAlias}\n`,
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
    assertCondition(procInfo.workspace.root === '/home/ada/weather-api', 'browser workspace /proc should expose canonical workspace root');
    assertCondition((await workspace.readDir('/proc')).join(',') === 'kernel,self', 'browser workspace /proc should list virtual namespaces');

    const outputEvents: RuntimeCommandEvent[] = [];
    const stdout = await workspace.runCommand('printf "browser-out\\n" > /dev/stdout', {
      onEvent: (event) => outputEvents.push(event),
    });
    assertCondition(stdout.stdout === 'browser-out\n', `browser workspace /dev/stdout should stream command output: ${JSON.stringify(stdout)}`);
    assertCondition(
      outputEvents.some((event) => event.type === 'output' && event.device === '/dev/stdout' && event.data === 'browser-out\n'),
      `browser workspace runCommand should surface stdout device events: ${JSON.stringify(outputEvents)}`
    );

    const python = await workspace.runCommand('python3 /workspace/main.py', { cwd: '/workspace' });
    assertCondition(python.exitCode === 0, `browser Python project command should succeed with alias cwd: ${python.stderr}`);
    assertCondition(
      python.stdout === '/home/ada/weather-api:/home/ada/weather-api:/workspace\n',
      `browser Python request should use canonical cwd and expose alias metadata: ${python.stdout}`
    );
    assertCondition(await workspace.readFile('python-browser.txt') === 'python-browser\n', 'browser Python final diff should persist through kernel FS');

    const nodeEvents: RuntimeCommandEvent[] = [];
    const node = await workspace.runCommand('node /home/ada/weather-api/index.js', {
      cwd: '/workspace',
      onEvent: (event) => nodeEvents.push(event),
    });
    assertCondition(node.exitCode === 0, `browser Node project command should succeed with canonical script path: ${node.stderr}`);
    assertCondition(
      node.stdout === [
        '/home/ada/weather-api',
        '/home/ada',
        '/home/ada/weather-api/src/alias.txt',
        '/home/ada/weather-api/index.js',
        '/home/ada/weather-api',
        '/home/ada/weather-api/index.js',
        '/home/ada/weather-api/lib/value.js',
        '42',
        '',
      ].join('\n'),
      `browser Node APIs should use canonical tracekernel paths: ${node.stdout}`
    );
    assertCondition(await workspace.readFile('node-canonical.txt') === 'node-canonical\n', 'browser Node should write canonical absolute paths');
    assertCondition(await workspace.readFile('node-alias.txt') === 'node-alias\n', 'browser Node should still map /workspace alias paths');
    assertCondition(
      nodeEvents.some((event) => event.type === 'file-change' && event.phase === 'live' && event.change.path === 'node-canonical.txt'),
      `browser Node should stream canonical absolute file mutations live: ${JSON.stringify(nodeEvents)}`
    );

    const java = await workspace.runCommand('java Main', { cwd: '/workspace' });
    assertCondition(java.exitCode === 0, `browser Java project command should succeed with alias cwd: ${java.stderr}`);
    assertCondition(
      java.stdout === '/home/ada/weather-api:/home/ada/weather-api:/workspace\n',
      `browser Java request should use canonical cwd and expose alias metadata: ${java.stdout}`
    );
    assertCondition(javaRequests[0]?.project.workspaceRoot === '/home/ada/weather-api', 'browser Java request should include workspaceRoot');
    assertCondition(javaRequests[0]?.project.workspaceAlias === '/workspace', 'browser Java request should include workspaceAlias');

    const csharp = await workspace.runCommand('dotnet run', { cwd: '/workspace' });
    assertCondition(csharp.exitCode === 0, `browser C# project command should succeed with alias cwd: ${csharp.stderr}`);
    assertCondition(
      csharp.stdout === '/home/ada/weather-api:/home/ada/weather-api:/workspace\n',
      `browser C# request should use canonical cwd and expose alias metadata: ${csharp.stdout}`
    );
    assertCondition(csharpRequests[0]?.project.workspaceRoot === '/home/ada/weather-api', 'browser C# request should include workspaceRoot');
    assertCondition(csharpRequests[0]?.project.workspaceAlias === '/workspace', 'browser C# request should include workspaceAlias');

    const cpp = await workspace.runCommand('clang++ /home/ada/weather-api/main.cpp -o /workspace/out/app', { cwd: '/workspace' });
    assertCondition(cpp.exitCode === 0, `browser C++ project command should succeed with canonical and alias args: ${cpp.stderr}`);
    assertCondition(
      cpp.stdout === '/home/ada/weather-api:/home/ada/weather-api:/workspace\n',
      `browser C++ request should use canonical cwd and expose alias metadata: ${cpp.stdout}`
    );
    assertCondition(cppRequests[0]?.project.workspaceRoot === '/home/ada/weather-api', 'browser C++ request should include workspaceRoot');
    assertCondition(cppRequests[0]?.project.workspaceAlias === '/workspace', 'browser C++ request should include workspaceAlias');

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
          '  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework></PropertyGroup>',
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

    const cppRun = await workspace.runCommand('cpp-run out/app gamma');
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
          '    <TargetFramework>net8.0</TargetFramework>',
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
    files: [{ path: 'events.py', contents: 'import sys\nprint("event-out")\nprint("event-err", file=sys.stderr)\n' }],
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
  workspace.dispose();
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
  await workspace.deleteFile('user.txt');

  assertCondition(await workspace.readFile('agent.txt') === 'agent\n', 'kernel writeFile should persist through workspace FS');
  assertCondition(await workspace.readFile('runtime.txt') === 'runtime\n', 'kernel final-diff application should persist files');
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
        { path: 'stale.txt', deleted: true },
      ],
    }),
  });
  await commandWorkspace.writeFile('stale.txt', 'stale\n');
  commandWorkspace.watch((event) => commandEvents.push(event));
  const commandResult = await commandWorkspace.runCommand('node index.js');
  assertCondition(commandResult.exitCode === 0, 'workspace command should succeed');
  assertCondition(await commandWorkspace.readFile('generated.txt') === 'generated\n', 'command final diff should persist generated files');
  await assertRejectsAsync(() => commandWorkspace.readFile('stale.txt'), 'command final diff should persist deletions');
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
    (await Promise.all(liveDeleteReadPromises)).includes(true),
    `runtime live deletions should be visible before onEvent returns: ${JSON.stringify(liveRuntimeEvents)}`
  );
  liveWorkspace.dispose();

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
  try {
    await failedLiveWorkspace.runCommand('node bad-live.js', {
      onEvent: (event) => failedLiveEvents.push(event),
    });
  } catch (error) {
    failedLiveError = error instanceof Error ? error.message : String(error);
  }
  assertCondition(
    failedLiveError.includes('Project path must stay inside the workspace') ||
      failedLiveError.includes('Kernel proc path is read-only'),
    `invalid live file-change should reject the command with a filesystem error: ${failedLiveError}`
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
    'printf "live\\n" > live.txt && printf "again\\n" >> live.txt && cp live.txt copied.txt && mv copied.txt moved.txt && rm live.txt',
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
      event.change.contents === 'live\nagain\n'
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
  shellWorkspace.dispose();

  const deviceWorkspace = await createRuntimeWorkspace();
  const deviceWatchEvents: RuntimeWorkspaceEvent[] = [];
  const deviceCommandEvents: RuntimeCommandEvent[] = [];
  deviceWorkspace.watch((event) => deviceWatchEvents.push(event));
  const stdinResult = await deviceWorkspace.runCommand('cat /dev/stdin', { stdin: 'from-stdin\n' });
  assertCondition(stdinResult.stdout === 'from-stdin\n', `/dev/stdin should feed command stdin: ${JSON.stringify(stdinResult)}`);
  const stdoutResult = await deviceWorkspace.runCommand('printf "device-out\\n" > /dev/stdout', {
    onEvent: (event) => deviceCommandEvents.push(event),
  });
  assertCondition(stdoutResult.stdout === 'device-out\n', `/dev/stdout writes should be command stdout: ${JSON.stringify(stdoutResult)}`);
  const stderrResult = await deviceWorkspace.runCommand('printf "device-err\\n" > /dev/stderr');
  assertCondition(stderrResult.stderr === 'device-err\n', `/dev/stderr writes should be command stderr: ${JSON.stringify(stderrResult)}`);
  assertCondition(
    deviceCommandEvents.some((event) =>
      event.type === 'output' &&
      event.stream === 'stdout' &&
      event.device === '/dev/stdout' &&
      event.data === 'device-out\n'
    ),
    `runCommand onEvent should receive /dev/stdout output events: ${JSON.stringify(deviceCommandEvents)}`
  );
  assertCondition((await deviceWorkspace.readDir('/dev')).join(',') === 'stderr,stdin,stdout,tty', '/dev should list kernel devices');
  const stdoutStat = await deviceWorkspace.stat('/dev/stdout');
  assertCondition(stdoutStat.isFile && !stdoutStat.isDirectory, '/dev/stdout should stat as a file device');
  await assertRejectsAsync(() => deviceWorkspace.writeFile('/dev/stdin', 'blocked\n'), '/dev/stdin should be read-only');
  await deviceWorkspace.writeFile('/dev/stdout', 'principal-out\n');
  assertCondition(
    deviceWatchEvents.some((event) =>
      event.type === 'output' &&
      event.actor?.kind === 'principal' &&
      event.device === '/dev/stdout' &&
      event.data === 'principal-out\n'
    ),
    `workspace writeFile should emit /dev/stdout output events: ${JSON.stringify(deviceWatchEvents)}`
  );
  deviceWorkspace.dispose();
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
  assertCondition(mountInfo.includes('tracekernel:workspace'), 'kernel /proc mountinfo should expose workspace mount');
  assertCondition(mountInfo.includes('/home/obi/weather-api'), 'kernel /proc mountinfo should expose canonical workspace mountpoint');
  assertCondition(mountInfo.includes('/workspace'), 'kernel /proc mountinfo should expose compatibility alias mountpoint');
  assertCondition(mountInfo.includes('tracekernel:dev') && mountInfo.includes('tracekernel:proc'), 'kernel /proc mountinfo should expose dev and proc mounts');
  assertCondition(await workspace.exists('/proc/kernel/info'), 'kernel /proc info should exist');
  const procInfoStat = await workspace.stat('/proc/kernel/info');
  assertCondition(procInfoStat.isFile && !procInfoStat.isDirectory, 'kernel /proc info should stat as file');
  assertCondition((await workspace.readDir('/proc')).join(',') === 'kernel,self', 'kernel /proc should list virtual namespaces');
  await assertRejectsAsync(() => workspace.writeFile('/proc/kernel/info', '{}\n'), 'kernel /proc should be read-only');

  const snapshot = await workspace.snapshot();
  assertCondition(snapshot.cwd === '/home/obi/weather-api', `snapshot cwd should use canonical workspace root: ${snapshot.cwd}`);
  assertCondition(snapshot.files.some((file) => file.path === 'src/main.py'), 'snapshot should still use project-relative file paths');
  workspace.dispose();
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
          '    <TargetFramework>net8.0</TargetFramework>',
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
          '  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework></PropertyGroup>',
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

async function main(): Promise<void> {
  testPathValidation();
  await testWorkspaceFilesAndCommands();
  await testPythonCommandAdapter();
  await testNodeCommandAdapter();
  await testPythonNodeCommandAdapterGlobScripts();
  await testCommandAdapterWorkspaceCwd();
  await testJavaCommandAdapter();
  await testJavaRunCommandGlobExpansion();
  await testCppCommandAdapter();
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
  await testProjectJavaScriptRunnersPreserveEmptyDirectories();
  await testBrowserJavaScriptProjectRunner();
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
  await testBrowserJavaProjectRunnerAdapter();
  await testPyodidePythonProjectRunnerAdapter();
  await testBrowserCSharpProjectRunnerAdapter();
  await testBrowserCppProjectRunnerAdapter();
  await testBrowserProjectWorkspaceFactory();
  await testBrowserProjectWorkspaceTraceKernelConfig();
  await testBrowserProjectWorkspaceAdvancedCommandTranslation();
  await testNativeProjectWorkspaceFactory();
  await testProjectWorkspaceCommandEvents();
  await testWorkspaceKernelEvents();
  await testTraceKernelInfoConfig();
  await testConfiguredKernelNativePythonAndNodeRunners();
  await testConfiguredKernelNativeCompiledRunners();
  await testConfiguredKernelAliasGlobCommandTranslation();
  console.log('PASS: project workspace primitives are backed by just-bash');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

#!/usr/bin/env npx tsx

import type { JavaProjectCommandRequest } from '../packages/runtime-java/src/project-node';
import { createBrowserJavaProjectRunner } from '../packages/runtime-java/src/project-browser';
import { createNativeJavaProjectRunner } from '../packages/runtime-java/src/project-node';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function assertRejects(run: () => Promise<unknown>, needle: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assertCondition(message.includes(needle), `expected rejection containing ${needle}, received ${message}`);
    return;
  }
  throw new Error(`expected rejection containing ${needle}`);
}

function nativeRequest(): JavaProjectCommandRequest {
  return {
    code: '',
    source: 'run',
    scriptPath: 'Main',
    args: [],
    cwd: '/workspace',
    env: {},
    project: {
      cwd: '/workspace',
      workspaceRoot: '/workspace',
      files: [
        {
          path: 'Main.java',
          contents: [
            'import java.nio.file.*;',
            'import java.nio.file.attribute.PosixFilePermissions;',
            'public class Main {',
            '  public static void main(String[] args) throws Exception {',
            '    Path alias = Path.of("alias.txt");',
            '    Path nestedAlias = Path.of("nested-alias.txt");',
            '    System.out.println(Files.isSymbolicLink(alias));',
            '    System.out.println(Files.readSymbolicLink(alias));',
            '    System.out.println(Files.readString(alias).trim());',
            '    System.out.println(PosixFilePermissions.toString(Files.getPosixFilePermissions(Path.of("target.txt"))));',
            '    System.out.println(Files.getLastModifiedTime(Path.of("target.txt")).toMillis());',
            '    System.out.println(PosixFilePermissions.toString(Files.getPosixFilePermissions(Path.of("stable.txt"))));',
            '    System.out.println(Files.getLastModifiedTime(Path.of("stable.txt")).toMillis());',
            '    System.out.println(Files.isSymbolicLink(nestedAlias));',
            '    System.out.println(Files.readSymbolicLink(nestedAlias));',
            '    System.out.println(Files.readString(nestedAlias).trim());',
            '    System.out.println(PosixFilePermissions.toString(Files.getPosixFilePermissions(Path.of("meta"))));',
            '    System.out.println(Files.getLastModifiedTime(Path.of("meta")).toMillis());',
            '    Files.setPosixFilePermissions(Path.of("meta"), PosixFilePermissions.fromString("rwxr-x---"));',
            '    Files.setLastModifiedTime(Path.of("meta"), java.nio.file.attribute.FileTime.fromMillis(3000));',
            '    Files.setPosixFilePermissions(Path.of("target.txt"), PosixFilePermissions.fromString("rw-------"));',
            '    Files.setLastModifiedTime(Path.of("target.txt"), java.nio.file.attribute.FileTime.fromMillis(4000));',
            '    Files.delete(alias);',
            '    Files.createSymbolicLink(Path.of("created-link.txt"), Path.of("target.txt"));',
            '  }',
            '}',
            '',
          ].join('\n'),
        },
        { path: 'target.txt', contents: 'linked\n', mode: 0o640, atimeMs: 1_250, mtimeMs: 1_500 },
        { path: 'stable.txt', contents: 'stable\n', mode: 0o604, atimeMs: 1_700, mtimeMs: 1_800 },
        { path: 'nested/target.txt', contents: 'nested\n' },
      ],
      directories: ['meta', 'stable-dir'],
      directoryMetadata: [
        { path: 'meta', mode: 0o710, atimeMs: 1_000, mtimeMs: 2_000 },
        { path: 'stable-dir', mode: 0o750, atimeMs: 1_000, mtimeMs: 2_000 },
      ],
      symlinks: [
        { path: 'alias.txt', symlink: true, target: 'target.txt' },
        { path: 'nested-alias.txt', symlink: true, target: 'nested\\target.txt' },
      ],
    },
  };
}

async function testNativeJavaFilesystemParity(): Promise<void> {
  const result = await createNativeJavaProjectRunner()(nativeRequest());
  assertCondition(result.exitCode === 0, `native Java project run failed: ${result.stderr}`);
  assertCondition(
    result.stdout === 'true\ntarget.txt\nlinked\nrw-r-----\n1500\nrw----r--\n1800\ntrue\nnested/target.txt\nnested\nrwx--x---\n2000\n',
    `native Java should observe real symlinks and directory metadata: ${result.stdout}`
  );
  assertCondition(
    result.files?.some((change) => change.path === 'alias.txt' && 'deleted' in change && change.deleted) === true,
    `native Java should persist removal of an initial symlink: ${JSON.stringify(result.files)}`
  );
  assertCondition(
    result.files?.some((change) => (
      change.path === 'created-link.txt' && 'symlink' in change && change.symlink && change.target === 'target.txt'
    )) === true,
    `native Java should persist newly created symlinks without flattening them: ${JSON.stringify(result.files)}`
  );
  assertCondition(
    result.files?.some((change) => (
      change.path === 'target.txt' &&
      'contents' in change &&
      change.contents === 'linked\n' &&
      change.mode === 0o600 &&
      change.mtimeMs === 4_000
    )) === true,
    `native Java should persist file metadata mutations without changing contents: ${JSON.stringify(result.files)}`
  );
  assertCondition(
    result.files?.some((change) => change.path === 'stable.txt') !== true,
    `unchanged materialized file metadata must not create a false final diff: ${JSON.stringify(result.files)}`
  );
  assertCondition(
    result.files?.some((change) => (
      change.path === 'meta' &&
      'directory' in change &&
      change.directory &&
      change.mode === 0o750 &&
      change.mtimeMs === 3_000
    )) === true,
    `native Java should persist directory metadata mutations: ${JSON.stringify(result.files)}`
  );
  assertCondition(
    result.files?.some((change) => change.path === 'stable-dir') !== true,
    `snapshot traversal must not create an atime-only directory diff: ${JSON.stringify(result.files)}`
  );
}

async function testNativeJavaRejectsEscapingSymlinkTargets(): Promise<void> {
  const request = nativeRequest();
  request.project.symlinks = [{ path: 'escape.txt', symlink: true, target: '../../outside.txt' }];
  await assertRejects(
    () => createNativeJavaProjectRunner()(request),
    'Project symlink target must stay inside the workspace'
  );
}

async function testNativeJavaRejectsAbsoluteSymlinkTargets(): Promise<void> {
  const request = nativeRequest();
  request.project.symlinks = [{ path: 'absolute.txt', symlink: true, target: '/workspace/target.txt' }];
  await assertRejects(
    () => createNativeJavaProjectRunner()(request),
    'Native Java project provider cannot preserve absolute symlink target'
  );
}

async function testBrowserJavaProviderBoundaries(): Promise<void> {
  let calls = 0;
  const runner = createBrowserJavaProjectRunner({
    async executeProjectJava() {
      calls += 1;
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });

  const symlinkResult = await runner(nativeRequest());
  assertCondition(
    symlinkResult.exitCode === 2 &&
      symlinkResult.stderr === 'java: ENOTSUP: browser project provider cannot materialize symbolic links\n' &&
      symlinkResult.error?.code === 'ENOTSUP' &&
      symlinkResult.error.syscall === 'materialize',
    `browser Java should reject unrepresentable symlinks deterministically: ${JSON.stringify(symlinkResult)}`
  );

  assertCondition(calls === 0, 'browser Java unsupported snapshots must not reach the worker provider');
}

async function main(): Promise<void> {
  await testNativeJavaFilesystemParity();
  console.log('PASS: native Java project filesystem preserves symlinks and directory metadata');
  await testNativeJavaRejectsEscapingSymlinkTargets();
  console.log('PASS: native Java project filesystem rejects escaping symlink targets');
  await testNativeJavaRejectsAbsoluteSymlinkTargets();
  console.log('PASS: native Java project filesystem rejects virtual-absolute symlink targets');
  await testBrowserJavaProviderBoundaries();
  console.log('PASS: browser Java project filesystem rejects unsupported snapshot features');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

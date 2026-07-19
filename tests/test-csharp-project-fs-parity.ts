#!/usr/bin/env npx tsx

import { createNativeCSharpProjectRunner } from '../packages/harness-csharp/src/project-node';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const initialMtimeMs = Date.UTC(2001, 0, 2, 3, 4, 5);
  const changedMtimeMs = Date.UTC(2002, 1, 3, 4, 5, 6);
  const stableAtimeMs = Date.UTC(2003, 2, 4, 5, 6, 7);
  const runner = createNativeCSharpProjectRunner({ timeoutMs: 60_000 });
  const result = await runner({
    code: '',
    source: 'run',
    scriptPath: '<project>',
    args: [],
    cwd: '/workspace/src',
    env: {},
    project: {
      files: [
        {
          path: 'src/Program.cs',
          contents: [
            'using System.IO;',
            'Console.WriteLine(new FileInfo("link.txt").LinkTarget);',
            'Console.WriteLine(File.ReadAllText("link.txt").Trim());',
            'Console.WriteLine(((int)File.GetUnixFileMode("metadata-dir") & 0x1ff));',
            'Console.WriteLine(new DateTimeOffset(Directory.GetLastWriteTimeUtc("metadata-dir")).ToUnixTimeMilliseconds());',
            'Console.WriteLine(((int)File.GetUnixFileMode("metadata-file.txt") & 0x1ff));',
            'Console.WriteLine(new DateTimeOffset(File.GetLastWriteTimeUtc("metadata-file.txt")).ToUnixTimeMilliseconds());',
            'Console.WriteLine(new FileInfo("normalized-link.txt").LinkTarget);',
            'File.CreateSymbolicLink("created-link.txt", "target.txt");',
            'File.SetUnixFileMode("metadata-dir", (UnixFileMode)0x1c0);',
            `Directory.SetLastWriteTimeUtc("metadata-dir", DateTimeOffset.FromUnixTimeMilliseconds(${changedMtimeMs}).UtcDateTime);`,
            'File.SetUnixFileMode("metadata-file.txt", (UnixFileMode)0x180);',
            `File.SetLastWriteTimeUtc("metadata-file.txt", DateTimeOffset.FromUnixTimeMilliseconds(${changedMtimeMs}).UtcDateTime);`,
            'Directory.CreateDirectory("new-dir");',
            'File.SetUnixFileMode("new-dir", (UnixFileMode)0x1c0);',
            `Directory.SetLastWriteTimeUtc("new-dir", DateTimeOffset.FromUnixTimeMilliseconds(${changedMtimeMs}).UtcDateTime);`,
            'File.Delete("file-to-link.txt");',
            'File.CreateSymbolicLink("file-to-link.txt", "target.txt");',
            'File.Delete("link-to-file.txt");',
            'File.WriteAllText("link-to-file.txt", "now-file\\n");',
            'File.Delete("file-to-dir");',
            'Directory.CreateDirectory("file-to-dir");',
            'Directory.Delete("dir-to-file");',
            'File.WriteAllText("dir-to-file", "now-file\\n");',
            '',
          ].join('\n'),
        },
        { path: 'src/target.txt', contents: 'target-value\n' },
        { path: 'src/folder/target.txt', contents: 'nested-target\n' },
        { path: 'src/metadata-file.txt', contents: 'metadata\n', mode: 0x1a0, mtimeMs: initialMtimeMs },
        { path: 'src/stable-file.txt', contents: 'stable\n', mode: 0x180, atimeMs: stableAtimeMs, mtimeMs: initialMtimeMs },
        { path: 'src/file-to-link.txt', contents: 'was-file\n' },
        { path: 'src/file-to-dir', contents: 'was-file\n' },
      ],
      directories: ['src/metadata-dir', 'src/stable-dir', 'src/dir-to-file'],
      directoryMetadata: [
        { path: 'src/metadata-dir', mode: 0x1e8, mtimeMs: initialMtimeMs },
        { path: 'src/stable-dir', mode: 0x1c0, atimeMs: stableAtimeMs, mtimeMs: initialMtimeMs },
      ],
      symlinks: [
        { path: 'src/link.txt', symlink: true, target: 'target.txt' },
        { path: 'src/normalized-link.txt', symlink: true, target: 'folder\\target.txt' },
        { path: 'src/link-to-file.txt', symlink: true, target: 'target.txt' },
      ],
    },
  });

  assertCondition(result.exitCode === 0, `native C# project filesystem parity should run: ${result.stderr}`);
  assertCondition(
    result.stdout.trim().split('\n').slice(-7).join('\n') === [
      'target.txt',
      'target-value',
      String(0x1e8),
      String(initialMtimeMs),
      String(0x1a0),
      String(initialMtimeMs),
      'folder/target.txt',
    ].join('\n'),
    `native C# should preserve normalized relative link targets and initial file/directory metadata, received ${result.stdout}`
  );
  assertCondition(
    result.files?.some((change) => (
      'symlink' in change && change.path === 'src/created-link.txt' && change.symlink === true && change.target === 'target.txt'
    )) === true,
    `native C# should return created links as first-class links, received ${JSON.stringify(result.files)}`
  );
  assertCondition(
    result.files?.some((change) => (
      'directory' in change && change.path === 'src/metadata-dir' && change.directory === true &&
      change.mode === 0x1c0 && change.mtimeMs === changedMtimeMs
    )) === true,
    `native C# should return directory metadata changes, received ${JSON.stringify(result.files)}`
  );
  assertCondition(
    result.files?.some((change) => (
      'contents' in change && change.path === 'src/metadata-file.txt' && change.contents === 'metadata\n' &&
      change.mode === 0x180 && change.mtimeMs === changedMtimeMs
    )) === true,
    `native C# should return metadata-only regular-file changes, received ${JSON.stringify(result.files)}`
  );
  assertCondition(
    result.files?.some((change) => (
      'directory' in change && change.path === 'src/new-dir' && change.directory === true &&
      change.mode === 0x1c0 && change.mtimeMs === changedMtimeMs
    )) === true,
    `native C# should attach metadata to newly created directories, received ${JSON.stringify(result.files)}`
  );
  assertCondition(
    result.files?.every((change) => change.path !== 'src/stable-file.txt' && change.path !== 'src/stable-dir') === true,
    `native C# scans should not manufacture metadata changes, received ${JSON.stringify(result.files)}`
  );

  const changesAt = (path: string) => result.files?.filter((change) => change.path === path) ?? [];
  assertCondition(
    changesAt('src/file-to-link.txt').length === 1 && 'symlink' in changesAt('src/file-to-link.txt')[0]!,
    `file-to-link replacement should be a single link change, received ${JSON.stringify(changesAt('src/file-to-link.txt'))}`
  );
  assertCondition(
    changesAt('src/link-to-file.txt').length === 1 && 'contents' in changesAt('src/link-to-file.txt')[0]!,
    `link-to-file replacement should be a single file change, received ${JSON.stringify(changesAt('src/link-to-file.txt'))}`
  );
  assertCondition(
    changesAt('src/file-to-dir').length === 1 && 'directory' in changesAt('src/file-to-dir')[0]!,
    `file-to-directory replacement should be a single directory change, received ${JSON.stringify(changesAt('src/file-to-dir'))}`
  );
  assertCondition(
    changesAt('src/dir-to-file').length === 1 && 'contents' in changesAt('src/dir-to-file')[0]!,
    `directory-to-file replacement should be a single file change, received ${JSON.stringify(changesAt('src/dir-to-file'))}`
  );

  for (const target of ['/absolute.txt', 'C:\\absolute.txt', 'C:relative.txt', '../escape.txt']) {
    let rejected = false;
    try {
      await runner({
        code: '', source: 'run', scriptPath: '<project>', args: [], cwd: '/workspace', env: {},
        project: {
          files: [{ path: 'Program.cs', contents: 'Console.WriteLine("unreachable");\n' }],
          symlinks: [{ path: 'bad-link', symlink: true, target }],
        },
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      rejected = code === (target === '../escape.txt' ? 'EACCES' : 'ENOTSUP');
    }
    assertCondition(rejected, `native C# should reject unsafe symbolic-link target ${target}`);
  }

  console.log('PASS: C# project filesystem parity');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

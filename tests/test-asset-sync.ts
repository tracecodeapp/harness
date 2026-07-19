#!/usr/bin/env npx tsx

import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-harness-assets-'));
  const targetDir = join(tempRoot, 'public', 'workers');

  const run = spawnSync('node', ['dist/cli.js', 'sync-assets', targetDir], {
    cwd: resolve(process.cwd()),
    encoding: 'utf8',
  });

  if (run.status !== 0) {
    throw new Error(run.stderr || run.stdout || 'Asset sync CLI failed');
  }

  const requiredFiles = [
    'THIRD_PARTY_NOTICES.md',
    'pyodide-worker.js',
    'generated-python-harness-snippets.js',
    'pyodide/runtime-core.js',
    'shared/runtime-kernel-policy-classic.js',
    'javascript-worker.js',
    'javascript-project-worker.js',
    'java-worker.js',
    'cpp-worker.js',
    'shared/runtime-kernel-policy.js',
    'cpp-compiler-frame.html',
    'cpp-compiler-worker.js',
    'cpp/tracecode_runtime.hpp',
    'java-source-augmentations.js',
    'csharp-worker.js',
    'vendor/typescript.js',
    'vendor/javascript-libraries.js',
    'vendor/java-browser-helper.jar',
    'vendor/java-rewriter.jar',
    'vendor/javaparser-core-3.25.10.jar',
    'vendor/jdk.compiler-17.jar',
    'vendor/csharp/_framework/dotnet.js',
    'vendor/csharp/_framework/dotnet.native.wasm',
    'vendor/csharp/_framework/dotnet.runtime.js',
    'vendor/csharp/_framework/dotnet.boot.js',
    'vendor/cpp/yowasp/bundle.js',
    'vendor/cpp/yowasp/llvm-resources.tar',
    'vendor/cpp/yowasp/llvm.core.wasm',
    'vendor/cpp/yowasp/llvm.core2.wasm',
    'vendor/cpp/yowasp/llvm.core3.wasm',
    'vendor/cpp/yowasp/llvm.core4.wasm',
  ];

  for (const relativePath of requiredFiles) {
    const filePath = join(targetDir, relativePath);
    const fileStat = await stat(filePath);
    assertCondition(fileStat.isFile(), `Expected synced asset at ${relativePath}`);
  }

  const rootEntries = await readdir(targetDir);
  assertCondition(rootEntries.includes('pyodide-worker.js'), 'Asset sync should flatten the Python worker into the target root');
  assertCondition(rootEntries.includes('javascript-worker.js'), 'Asset sync should flatten the JavaScript worker into the target root');
  assertCondition(
    rootEntries.includes('javascript-project-worker.js'),
    'Asset sync should flatten the JavaScript project worker into the target root'
  );
  assertCondition(rootEntries.includes('java-worker.js'), 'Asset sync should flatten the Java worker into the target root');
  assertCondition(rootEntries.includes('csharp-worker.js'), 'Asset sync should flatten the C# worker into the target root');
  assertCondition(rootEntries.includes('cpp-worker.js'), 'Asset sync should flatten the C++ worker into the target root');
  assertCondition(rootEntries.includes('cpp-compiler-frame.html'), 'Asset sync should flatten the C++ compiler frame into the target root');
  assertCondition(rootEntries.includes('cpp-compiler-worker.js'), 'Asset sync should flatten the C++ compiler worker into the target root');
  assertCondition(
    rootEntries.includes('java-source-augmentations.js'),
    'Asset sync should flatten the Java augmentation helper into the target root'
  );

  for (const relativePath of ['cpp-worker.js', 'cpp-compiler-worker.js']) {
    const source = await readFile(join(targetDir, relativePath), 'utf8');
    assertCondition(
      source.includes('toolchainIntegrity'),
      `${relativePath} should enforce pinned C++ toolchain integrity manifests`
    );
    assertCondition(
      !source.includes('trusted HTTP(S) asset origin'),
      `${relativePath} should not trust arbitrary HTTP(S) C++ toolchain assets`
    );
  }

  const filteredTargetDir = join(tempRoot, 'public', 'python-workers');
  const filteredRun = spawnSync('node', ['dist/cli.js', 'sync-assets', filteredTargetDir, '--languages', 'python'], {
    cwd: resolve(process.cwd()),
    encoding: 'utf8',
  });

  if (filteredRun.status !== 0) {
    throw new Error(filteredRun.stderr || filteredRun.stdout || 'Filtered asset sync CLI failed');
  }

  for (const relativePath of [
    'THIRD_PARTY_NOTICES.md',
    'pyodide-worker.js',
    'generated-python-harness-snippets.js',
    'pyodide/runtime-core.js',
    'shared/runtime-kernel-policy-classic.js',
  ]) {
    const fileStat = await stat(join(filteredTargetDir, relativePath));
    assertCondition(fileStat.isFile(), `Expected filtered synced asset at ${relativePath}`);
  }

  const filteredEntries = await readdir(filteredTargetDir);
  assertCondition(!filteredEntries.includes('java-worker.js'), 'Filtered Python sync should not copy Java assets');
  assertCondition(!filteredEntries.includes('javascript-worker.js'), 'Filtered Python sync should not copy JavaScript assets');
  assertCondition(
    !filteredEntries.includes('javascript-project-worker.js'),
    'Filtered Python sync should not copy JavaScript project assets'
  );

  const filteredJavaScriptTargetDir = join(tempRoot, 'public', 'javascript-workers');
  const filteredJavaScriptRun = spawnSync(
    'node',
    ['dist/cli.js', 'sync-assets', filteredJavaScriptTargetDir, '--languages', 'javascript'],
    { cwd: resolve(process.cwd()), encoding: 'utf8' }
  );
  if (filteredJavaScriptRun.status !== 0) {
    throw new Error(
      filteredJavaScriptRun.stderr || filteredJavaScriptRun.stdout || 'Filtered JavaScript asset sync CLI failed'
    );
  }
  for (const relativePath of [
    'javascript-worker.js',
    'javascript-project-worker.js',
    'shared/runtime-kernel-policy-classic.js',
    'vendor/typescript.js',
    'vendor/javascript-libraries.js',
  ]) {
    const fileStat = await stat(join(filteredJavaScriptTargetDir, relativePath));
    assertCondition(fileStat.isFile(), `Expected filtered JavaScript synced asset at ${relativePath}`);
  }

  console.log('PASS: asset sync CLI copies canonical and language-filtered worker assets');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

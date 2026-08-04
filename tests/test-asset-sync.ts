#!/usr/bin/env npx tsx

import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(t: TestContext): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-harness-assets-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
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
    'python-worker.js',
    'generated-python-harness-snippets.js',
    'python/runtime-core.js',
    'shared/runtime-kernel-policy-classic.js',
    'javascript-worker.js',
    'javascript-project-worker.js',
    'java-worker.js',
    'java-runtime-worker.js',
    'shared/tracekernel-syscall-client.js',
    'shared/tracekernel-local-java-host.js',
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
    'vendor/csharp/_framework/dotnet.js',
    'vendor/csharp/_framework/dotnet.native.wasm',
    'vendor/csharp/_framework/dotnet.runtime.js',
    'vendor/csharp/_framework/dotnet.boot.js',
    'vendor/csharp-compiler/_framework/dotnet.boot.js',
    'vendor/csharp-runner/_framework/dotnet.boot.js',
    'vendor/csharp-runner/_framework/assemblies-01.pack',
    'vendor/csharp-runner/_framework/assemblies-02.pack',
    'vendor/csharp-runner/_framework/assemblies-03.pack',
    'cpp/compiler/bundle.js',
    'cpp/compiler/llvm-resources.tar',
    'cpp/compiler/llvm.core.wasm',
    'cpp/compiler/llvm.core2.wasm',
    'cpp/compiler/llvm.core3.wasm',
    'cpp/compiler/llvm.core4.wasm',
  ];

  for (const relativePath of requiredFiles) {
    const filePath = join(targetDir, relativePath);
    const fileStat = await stat(filePath);
    assertCondition(fileStat.isFile(), `Expected synced asset at ${relativePath}`);
  }

  for (const relativePath of [
    'vendor/java-rewriter.jar',
    'vendor/javaparser-core-3.25.10.jar',
    'vendor/jdk.compiler-17.jar',
  ]) {
    const exists = await stat(join(targetDir, relativePath)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    );
    assertCondition(!exists, `Retired Java build artifact must not be synced at ${relativePath}`);
  }

  const removedBrandedCppPathExists = await stat(
    join(targetDir, 'vendor/cpp/yowasp/bundle.js')
  ).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );
  assertCondition(
    !removedBrandedCppPathExists,
    'Asset sync must not republish C++ compiler assets under an implementation-branded path'
  );

  const rootEntries = await readdir(targetDir);
  assertCondition(rootEntries.includes('python-worker.js'), 'Asset sync should flatten the Python worker into the target root');
  assertCondition(rootEntries.includes('javascript-worker.js'), 'Asset sync should flatten the JavaScript worker into the target root');
  assertCondition(
    rootEntries.includes('javascript-project-worker.js'),
    'Asset sync should flatten the JavaScript project worker into the target root'
  );
  assertCondition(rootEntries.includes('java-worker.js'), 'Asset sync should flatten the Java worker into the target root');
  assertCondition(
    rootEntries.includes('java-runtime-worker.js'),
    'Asset sync should flatten the default Java runtime worker into the target root'
  );
  assertCondition(
    !rootEntries.includes('tracejvm-java-worker.js'),
    'Asset sync must not expose the Java engine implementation in the consumer worker filename'
  );
  assertCondition(rootEntries.includes('csharp-worker.js'), 'Asset sync should flatten the C# worker into the target root');
  assertCondition(rootEntries.includes('cpp-worker.js'), 'Asset sync should flatten the C++ worker into the target root');
  assertCondition(rootEntries.includes('cpp-compiler-frame.html'), 'Asset sync should flatten the C++ compiler frame into the target root');
  assertCondition(rootEntries.includes('cpp-compiler-worker.js'), 'Asset sync should flatten the C++ compiler worker into the target root');
  assertCondition(
    rootEntries.includes('java-source-augmentations.js'),
    'Asset sync should flatten the Java augmentation helper into the target root'
  );
  const syncedCSharpWorker = await readFile(
    join(targetDir, 'csharp-worker.js'),
    'utf8'
  );
  assertCondition(
    syncedCSharpWorker.includes('createTraceCodePackedAssemblyLoader'),
    'Asset sync should publish the C# packed-assembly boot loader'
  );
  const looseRunnerAssemblyExists = await stat(
    join(
      targetDir,
      'vendor/csharp-runner/_framework/System.Private.CoreLib.wasm'
    )
  ).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );
  assertCondition(
    !looseRunnerAssemblyExists,
    'Asset sync must not republish loose C# runner managed assemblies'
  );
  const sourceControlArtifactsExist = await stat(
    join(targetDir, 'vendor/csharp-role-artifacts')
  ).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );
  assertCondition(
    !sourceControlArtifactsExist,
    'Asset sync must not publish build-time C# role archives to browsers'
  );

  for (const relativePath of ['cpp-worker.js', 'cpp-compiler-worker.js']) {
    const source = await readFile(join(targetDir, relativePath), 'utf8');
    assertCondition(
      source.includes('toolchainIntegrity'),
      `${relativePath} should enforce private pinned C++ compiler integrity payloads`
    );
    assertCondition(
      !source.includes('trusted HTTP(S) asset origin'),
      `${relativePath} should not trust arbitrary HTTP(S) C++ compiler assets`
    );
  }

  for (const relativePath of [
    'python-worker.js',
    'csharp-worker.js',
    'cpp-worker.js',
  ]) {
    const source = await readFile(join(targetDir, relativePath), 'utf8');
    assertCondition(
      source.includes(
        "typeof SharedArrayBuffer !== 'undefined' &&\n"
      ),
      `${relativePath} must guard optional TraceKernel shared-memory channels on non-isolated pages`
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
    'python-worker.js',
    'generated-python-harness-snippets.js',
    'python/runtime-core.js',
    'shared/runtime-kernel-policy-classic.js',
  ]) {
    const fileStat = await stat(join(filteredTargetDir, relativePath));
    assertCondition(fileStat.isFile(), `Expected filtered synced asset at ${relativePath}`);
  }

  const filteredEntries = await readdir(filteredTargetDir);
  assertCondition(!filteredEntries.includes('java-worker.js'), 'Filtered Python sync should not copy Java assets');
  assertCondition(
    !filteredEntries.includes('java-runtime-worker.js'),
    'Filtered Python sync should not copy the Java runtime worker'
  );
  assertCondition(
    !filteredEntries.includes('tracejvm-java-worker.js'),
    'Filtered asset sync must not expose the retired implementation-branded Java worker filename'
  );
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

test('asset sync', main);

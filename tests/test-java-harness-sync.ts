#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

import { getLanguageRuntimeProfile } from '../packages/runtime-browser/src/runtime-profiles';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertFileExists(pathname: string, label: string): Promise<void> {
  await access(pathname, constants.R_OK);
  console.log(`PASS: ${label}`);
}

async function main(): Promise<void> {
  const root = process.cwd();
  const workerPath = join(root, 'workers', 'java', 'java-worker.js');
  const traceJVMWorkerPath = join(
    root,
    'workers',
    'java',
    'java-runtime-worker.js'
  );
  const augmentationPath = join(root, 'workers', 'java', 'java-source-augmentations.js');
  const syscallClientPath = join(
    root,
    'workers',
    'shared',
    'tracekernel-syscall-client.js'
  );
  const helperJarPath = join(root, 'workers', 'vendor', 'java-browser-helper.jar');
  const compilerJarPath = join(root, 'workers', 'vendor', 'jdk.compiler-17.jar');
  const rewriterJarPath = join(root, 'workers', 'vendor', 'java-rewriter.jar');
  const javaparserJarPath = join(root, 'workers', 'vendor', 'javaparser-core-3.25.10.jar');

  await assertFileExists(workerPath, 'java worker asset exists');
  await assertFileExists(traceJVMWorkerPath, 'TraceJVM Java worker asset exists');
  await assertFileExists(augmentationPath, 'java source augmentation asset exists');
  await assertFileExists(
    syscallClientPath,
    'TraceKernel syscall client asset exists'
  );
  await assertFileExists(helperJarPath, 'java helper jar exists');
  await assertFileExists(compilerJarPath, 'java compiler jar exists');
  await assertFileExists(rewriterJarPath, 'java rewriter jar exists');
  await assertFileExists(javaparserJarPath, 'javaparser jar exists');

  const workerSource = await readFile(workerPath, 'utf8');
  const traceJVMWorkerSource = await readFile(traceJVMWorkerPath, 'utf8');
  const augmentationSource = await readFile(augmentationPath, 'utf8');
  const helperSource = await readFile(
    join(root, 'workers', 'java', 'src', 'tracecode', 'browser', 'BrowserCompileAndTraceLibrary.java'),
    'utf8'
  );
  const helperApi = execFileSync(
    'javap',
    ['-classpath', helperJarPath, 'tracecode.browser.BrowserCompileAndTraceLibrary'],
    { encoding: 'utf8' }
  );
  assertCondition(
    helperApi.includes('deleteRuntimeRequestTree(java.lang.String)'),
    'Java helper jar must expose request-scoped runtime storage cleanup'
  );
  const projectEventsSource = await readFile(
    join(root, 'workers', 'java', 'src', 'tracecode', 'browser', 'ProjectEvents.java'),
    'utf8'
  );
  const requiredMarkers = [
    '/app/workers/vendor/cheerpj-loader.js',
    'assertTrustedJavaAsset',
    'local /app/ asset path',
    '/app/workers/vendor/java-browser-helper.jar',
    '/app/workers/vendor/jdk.compiler-17.jar',
    '/app/workers/vendor/java-rewriter.jar',
    '/app/workers/vendor/javaparser-core-3.25.10.jar',
    'cheerpjRunLibrary',
    'Java_tracecode_browser_ProjectEvents_emitOutputNative',
    'sourceDevice',
    'outputDevice',
    'Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative',
    'tracecode.browser.BrowserCompileAndTraceLibrary',
    'harness.browser.JavaRewriteLibrary',
    "message.type === 'init'",
    "message.type === 'warmup'",
    "message.type === 'execute-with-tracing'",
    "message.type === 'execute-code'",
    "message.type === 'execute-project-java'",
    'compileAndRunProjectSources',
    'compileAndRunProjectSourcesWithWorkspace',
    'compileAndRunProjectClassFilesWithWorkspace',
    'workspaceManifest',
    'workspaceCwd',
    'ProjectEvents.streamingOutput',
    'ProjectEvents.inputStream',
    'ProjectEvents.installHttpUrlHandler()',
    'ProjectEvents.httpClient',
    'ProjectEvents.httpClientBuilder',
    'ProjectEvents.httpServer',
    'kernel-http-dispatch-sync',
    'kernel-http-listen-sync',
    'Java_tracecode_browser_ProjectEvents_dispatchHttpNative',
    'Java_tracecode_browser_ProjectEvents_registerHttpServerNative',
    'augmentJavaProjectFileMutations',
    'projectChangedFiles(report)',
    'runJavaProjectRequest',
    'deleteJavaRuntimeRequestTree',
    "makeWorkerStageError('project runtime storage cleanup'",
    'buildProjectJavaRunnableSource',
    'Project cwd must stay inside the workspace',
    "postMessageResponse({ type: 'worker-ready' })",
    "postMessageResponse({ type: 'idle-timeout' })",
    'java-source-augmentations.js',
    'TraceCodeJavaSourceAugmentations.augmentJavaCollectionOperations',
  ];

  for (const marker of requiredMarkers) {
    assertCondition(
      workerSource.includes(marker),
      `Java worker drift detected. Missing marker: ${marker}`
    );
  }
  console.log('PASS: java worker contract markers present');

  for (const marker of [
    'TraceJVMCompiler',
    'TraceJVMRunnerHost',
    "traceJVMWorkerParameters.get('tracejvmBaseUrl')",
    'normalizeTraceJVMBaseUrl',
    'traceJVMRewriteSource',
    'traceJVMCompileAndRun',
    'traceJVMCompileAndTrace',
    'traceJVMCompileAndRunBatch',
    'traceJVMPrepareRuntimeProgram',
    'traceJVMRestoreRuntimeProgram',
    'traceJVMRunPreparedRuntimeProgram',
    'tracecode.java.tracejvm-prepared-program.v1',
    'TraceCodeTraceKernelSharedSyscallClient',
    'kernelBound: true',
    'processFiles: processFiles()',
    'CLASSIC_JAVA_WORKER_URL.href',
  ]) {
    assertCondition(
      traceJVMWorkerSource.includes(marker),
      `TraceJVM Java worker drift detected. Missing marker: ${marker}`
    );
  }
  assertCondition(
    !traceJVMWorkerSource.includes('TraceJVMRuntimeHost'),
    'TraceJVM Java provider must not restore the combined compiler/runner host'
  );
  console.log('PASS: TraceJVM Java provider markers present');

  const fullClasspathSource = workerSource.slice(workerSource.indexOf('const FULL_CLASSPATH'));
  assertCondition(
    fullClasspathSource.indexOf('REWRITER_JAR_PATH') >= 0 &&
      fullClasspathSource.indexOf('REWRITER_JAR_PATH') < fullClasspathSource.indexOf('HELPER_JAR_PATH'),
    'Java worker classpath should load java-rewriter.jar before java-browser-helper.jar so stale helper classes cannot shadow rewrite fixes'
  );
  console.log('PASS: java worker classpath prefers rewriter jar');

  const helperMarkers = [
    'compileAndRunProjectSourcesWithWorkspace',
    'compileAndRunProjectClassFilesWithWorkspace',
    'deleteRuntimeRequestTree',
    'Refusing to delete non-request Java runtime tree',
    'collectChangedProjectFilesJson',
    'System.setProperty("user.dir"',
    'changedFiles',
    ',\\"deleted\\":true',
  ];
  for (const marker of helperMarkers) {
    assertCondition(
      helperSource.includes(marker),
      `Java helper project workspace drift detected. Missing marker: ${marker}`
    );
  }
  console.log('PASS: java helper project workspace markers present');

  const projectEventsMarkers = [
    'emitFileSnapshotNative',
    'emitFileDeleteNative',
    'setProjectWorkspaceRoot',
    'Files.writeString',
    'Files.newInputStream',
    'installHttpUrlHandler',
    'ProjectHttpURLConnection',
    'ProjectHttpClient',
    'ProjectHttpClientBuilder',
    'ProjectHttpServer',
    'registerHttpServerNative',
    'pollHttpServerRequestNative',
    'dispatchHttpNative',
    'Files.newBufferedReader',
    'Files.createTempFile',
    'Files.createTempDirectory',
    'Files.setLastModifiedTime',
    'Files.setAttribute',
    'Files.readAllLines',
    'Files.lines',
    'Files.isReadable',
    'Files.isWritable',
    'Files.size',
    'Files.newOutputStream',
    'Files.newBufferedWriter',
    'Files.deleteIfExists',
    'ProjectFileWriter',
    'ProjectFileInputStream',
    'ProjectFileOutputStream',
    'ProjectPrintStream',
    'ProjectPrintWriter',
    'extends FileWriter',
    'extends FileInputStream',
    'extends FileOutputStream',
    'extends PrintStream',
    'extends PrintWriter',
  ];
  for (const marker of projectEventsMarkers) {
    assertCondition(
      projectEventsSource.includes(marker),
      `Java project events helper drift detected. Missing marker: ${marker}`
    );
  }
  console.log('PASS: java project events helper markers present');

  assertCondition(
    augmentationSource.includes('augmentJavaCollectionOperations') &&
      augmentationSource.includes('TraceCodeJavaSourceAugmentations'),
    'Java source augmentation asset should expose the shared post-rewrite helper'
  );
  console.log('PASS: java source augmentation helper markers present');

  const javaProfile = getLanguageRuntimeProfile('java');
  assertCondition(javaProfile.language === 'java', 'Java runtime profile should resolve');
  assertCondition(javaProfile.maturity === 'stable', 'Java runtime should be stable');
  assertCondition(javaProfile.capabilities.execution.styles.solutionMethod, 'Java should support solution-method style');
  assertCondition(javaProfile.capabilities.execution.styles.opsClass, 'Java should support ops-class style');
  assertCondition(javaProfile.capabilities.execution.styles.function, 'Java should support function style');
  assertCondition(javaProfile.capabilities.execution.styles.script, 'Java should expose script style');
  assertCondition(javaProfile.capabilities.execution.limits.wallClock, 'Java should honor wall-clock execution limits');
  assertCondition(javaProfile.capabilities.tracing.supported, 'Java runtime should expose tracing support');
  console.log('PASS: java runtime profile matches first-slice contract');
}

test('java harness sync', main);

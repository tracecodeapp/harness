#!/usr/bin/env npx tsx

import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

import { getLanguageRuntimeProfile } from '../packages/harness-browser/src/runtime-profiles';

function assertCondition(condition: boolean, message: string): void {
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
  const augmentationPath = join(root, 'workers', 'java', 'java-source-augmentations.js');
  const helperJarPath = join(root, 'workers', 'vendor', 'java-browser-helper.jar');
  const compilerJarPath = join(root, 'workers', 'vendor', 'jdk.compiler-17.jar');
  const rewriterJarPath = join(root, 'workers', 'vendor', 'java-rewriter.jar');
  const javaparserJarPath = join(root, 'workers', 'vendor', 'javaparser-core-3.25.10.jar');

  await assertFileExists(workerPath, 'java worker asset exists');
  await assertFileExists(augmentationPath, 'java source augmentation asset exists');
  await assertFileExists(helperJarPath, 'java helper jar exists');
  await assertFileExists(compilerJarPath, 'java compiler jar exists');
  await assertFileExists(rewriterJarPath, 'java rewriter jar exists');
  await assertFileExists(javaparserJarPath, 'javaparser jar exists');

  const workerSource = await readFile(workerPath, 'utf8');
  const augmentationSource = await readFile(augmentationPath, 'utf8');
  const helperSource = await readFile(
    join(root, 'workers', 'java', 'src', 'tracecode', 'browser', 'BrowserCompileAndTraceLibrary.java'),
    'utf8'
  );
  const projectEventsSource = await readFile(
    join(root, 'workers', 'java', 'src', 'tracecode', 'browser', 'ProjectEvents.java'),
    'utf8'
  );
  const requiredMarkers = [
    'https://cjrtnc.leaningtech.com/4.2/loader.js',
    '/app/workers/vendor/java-browser-helper.jar',
    '/app/workers/vendor/jdk.compiler-17.jar',
    '/app/workers/vendor/java-rewriter.jar',
    '/app/workers/vendor/javaparser-core-3.25.10.jar',
    'cheerpjRunLibrary',
    'Java_tracecode_browser_ProjectEvents_emitOutputNative',
    'sourceDevice',
    'Java_tracecode_browser_ProjectEvents_emitFileSnapshotNative',
    'tracecode.browser.BrowserCompileAndTraceLibrary',
    'harness.browser.JavaRewriteLibrary',
    "message.type === 'init'",
    "message.type === 'warmup'",
    "message.type === 'execute-with-tracing'",
    "message.type === 'execute-code'",
    "message.type === 'execute-code-interview'",
    "message.type === 'execute-project-java'",
    'compileAndRunProjectSources',
    'compileAndRunProjectSourcesWithWorkspace',
    'compileAndRunProjectClassFilesWithWorkspace',
    'workspaceManifest',
    'workspaceCwd',
    'ProjectEvents.streamingOutput',
    'augmentJavaProjectFileMutations',
    'projectChangedFiles(report)',
    'runJavaProjectRequest',
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

  const helperMarkers = [
    'compileAndRunProjectSourcesWithWorkspace',
    'compileAndRunProjectClassFilesWithWorkspace',
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
    'Files.newBufferedReader',
    'Files.readAllLines',
    'Files.lines',
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
  assertCondition(javaProfile.maturity === 'experimental', 'Java runtime should remain experimental');
  assertCondition(javaProfile.capabilities.execution.styles.solutionMethod, 'Java should support solution-method style');
  assertCondition(javaProfile.capabilities.execution.styles.opsClass, 'Java should support ops-class style');
  assertCondition(javaProfile.capabilities.execution.styles.function, 'Java should support function style');
  assertCondition(javaProfile.capabilities.execution.styles.script, 'Java should expose script style');
  assertCondition(javaProfile.capabilities.execution.styles.interviewMode, 'Java should expose interview mode');
  assertCondition(javaProfile.capabilities.tracing.supported, 'Java runtime should expose tracing support');
  console.log('PASS: java runtime profile matches first-slice contract');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

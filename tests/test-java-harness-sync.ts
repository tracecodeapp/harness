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
  const helperJarPath = join(root, 'workers', 'vendor', 'java-browser-spike-helper.jar');
  const compilerJarPath = join(root, 'workers', 'vendor', 'jdk.compiler-17.jar');
  const rewriterJarPath = join(root, 'workers', 'vendor', 'java-practice-rewriter.jar');
  const rewriteBridgeJarPath = join(root, 'workers', 'vendor', 'java-rewrite-bridge.jar');
  const javaparserJarPath = join(root, 'workers', 'vendor', 'javaparser-core-3.25.10.jar');

  await assertFileExists(workerPath, 'java worker asset exists');
  await assertFileExists(helperJarPath, 'java helper jar exists');
  await assertFileExists(compilerJarPath, 'java compiler jar exists');
  await assertFileExists(rewriterJarPath, 'java rewriter jar exists');
  await assertFileExists(rewriteBridgeJarPath, 'java rewrite bridge jar exists');
  await assertFileExists(javaparserJarPath, 'javaparser jar exists');

  const workerSource = await readFile(workerPath, 'utf8');
  const requiredMarkers = [
    'https://cjrtnc.leaningtech.com/4.2/loader.js',
    '/app/workers/vendor/java-browser-spike-helper.jar',
    '/app/workers/vendor/jdk.compiler-17.jar',
    '/app/workers/vendor/java-practice-rewriter.jar',
    '/app/workers/vendor/java-rewrite-bridge.jar',
    '/app/workers/vendor/javaparser-core-3.25.10.jar',
    'cheerpjRunLibrary',
    'spike.browser.BrowserCompileAndTraceLibrary',
    'harness.browser.JavaRewriteLibrary',
    "message.type === 'init'",
    "message.type === 'execute-with-tracing'",
    "message.type === 'execute-code'",
    "message.type === 'execute-code-interview'",
    "postMessageResponse({ type: 'worker-ready' })",
    "postMessageResponse({ type: 'idle-timeout' })",
  ];

  for (const marker of requiredMarkers) {
    assertCondition(
      workerSource.includes(marker),
      `Java worker drift detected. Missing marker: ${marker}`
    );
  }
  console.log('PASS: java worker contract markers present');

  const javaProfile = getLanguageRuntimeProfile('java');
  assertCondition(javaProfile.language === 'java', 'Java runtime profile should resolve');
  assertCondition(javaProfile.maturity === 'experimental', 'Java runtime should remain experimental');
  assertCondition(javaProfile.capabilities.execution.styles.solutionMethod, 'Java should support solution-method style');
  assertCondition(javaProfile.capabilities.execution.styles.opsClass, 'Java should support ops-class style');
  assertCondition(javaProfile.capabilities.execution.styles.function, 'Java should support function style');
  assertCondition(!javaProfile.capabilities.execution.styles.script, 'Java should not expose script style yet');
  assertCondition(javaProfile.capabilities.execution.styles.interviewMode, 'Java should expose interview mode');
  assertCondition(javaProfile.capabilities.tracing.supported, 'Java runtime should expose tracing support');
  console.log('PASS: java runtime profile matches first-slice contract');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

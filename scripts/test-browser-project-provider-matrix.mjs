#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const ALL_ENGINES = ['chromium', 'firefox', 'webkit'];
const ALL_LANGUAGES = ['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp'];

function selectedValues(environmentName, defaults, allowed) {
  const raw = process.env[environmentName]?.trim();
  const values = raw ? raw.split(',').map((value) => value.trim()).filter(Boolean) : defaults;
  if (values.length === 0) throw new Error(`${environmentName} must select at least one value.`);
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new Error(`${environmentName} contains unsupported value ${JSON.stringify(value)}.`);
    }
  }
  return [...new Set(values)];
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(
        `Browser project provider matrix child failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`
      ));
    });
  });
}

const engines = selectedValues('TRACECODE_PROJECT_MATRIX_ENGINES', ALL_ENGINES, ALL_ENGINES);
const languages = selectedValues('TRACECODE_PROJECT_MATRIX_LANGUAGES', ALL_LANGUAGES, ALL_LANGUAGES);
const timeoutMs = Number(process.env.TRACECODE_PROJECT_MATRIX_TIMEOUT_MS ?? 180_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  throw new Error('TRACECODE_PROJECT_MATRIX_TIMEOUT_MS must be a positive safe integer.');
}
const iterations = Number(process.env.TRACECODE_PROJECT_MATRIX_ITERATIONS ?? 1);
if (!Number.isSafeInteger(iterations) || iterations <= 0) {
  throw new Error('TRACECODE_PROJECT_MATRIX_ITERATIONS must be a positive safe integer.');
}
const reportDirectory = process.env.TRACECODE_PROJECT_MATRIX_REPORT_DIR?.trim();
const performanceGate = process.env.TRACECODE_PROJECT_MATRIX_PERFORMANCE_GATE === '1';
if (performanceGate && !reportDirectory) {
  throw new Error('TRACECODE_PROJECT_MATRIX_PERFORMANCE_GATE=1 requires TRACECODE_PROJECT_MATRIX_REPORT_DIR.');
}

const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
const benchmark = resolve('scripts/benchmark-browser-project-runtimes.ts');
const performanceCheck = resolve('scripts/check-browser-project-performance.mjs');
const javaManifest = resolve('tests/fixtures/browser-project-java-cheerpj-4.2.json');

for (const engine of engines) {
  for (const language of languages) {
    console.log(`\n=== Browser project provider matrix: ${engine}/${language} ===`);
    const reportPath = reportDirectory
      ? resolve(join(reportDirectory, `browser-project-runtime-${engine}-${language}.json`))
      : null;
    await run(process.execPath, [
      tsxCli,
      '--tsconfig',
      'tsconfig.base.json',
      benchmark,
      `--engine=${engine}`,
      `--languages=${language}`,
      `--iterations=${iterations}`,
      '--cache-assets',
      '--execution-host',
      `--runtime-manifests=${javaManifest}`,
      `--request-timeout-ms=${timeoutMs}`,
      ...(reportPath ? [`--report=${reportPath}`] : ['--no-report']),
    ]);
    if (performanceGate && reportPath) {
      await run(process.execPath, [performanceCheck, `--report=${reportPath}`]);
    }
  }
}

console.log(`\nPASS: ${languages.length} browser project providers across ${engines.length} engine(s)`);

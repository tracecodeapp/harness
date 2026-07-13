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
    if (!allowed.includes(value)) throw new Error(`${environmentName} contains unsupported value ${JSON.stringify(value)}.`);
  }
  return [...new Set(values)];
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolveRun();
      rejectRun(new Error(`Classic browser provider child failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`));
    });
  });
}

const engines = selectedValues('TRACECODE_CLASSIC_MATRIX_ENGINES', ALL_ENGINES, ALL_ENGINES);
const languages = selectedValues('TRACECODE_CLASSIC_MATRIX_LANGUAGES', ALL_LANGUAGES, ALL_LANGUAGES);
const timeoutMs = Number(process.env.TRACECODE_CLASSIC_MATRIX_TIMEOUT_MS ?? 180_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  throw new Error('TRACECODE_CLASSIC_MATRIX_TIMEOUT_MS must be a positive safe integer.');
}
const reportDirectory = process.env.TRACECODE_CLASSIC_MATRIX_REPORT_DIR?.trim();
const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
const benchmark = resolve('scripts/benchmark-browser-runtimes.ts');
const runtimeManifest = resolve('tests/fixtures/browser-project-java-cheerpj-4.2.json');

for (const engine of engines) {
  for (const language of languages) {
    console.log(`\n=== Classic browser provider matrix: ${engine}/${language} ===`);
    const reportPath = reportDirectory
      ? resolve(join(reportDirectory, `browser-classic-runtime-${engine}-${language}.json`))
      : null;
    await run(process.execPath, [
      tsxCli,
      '--tsconfig',
      'tsconfig.base.json',
      benchmark,
      `--engine=${engine}`,
      `--languages=${language}`,
      '--workloads=add',
      '--modes=execute',
      '--iterations=1',
      '--case-limit=1',
      '--cache-assets',
      `--runtime-manifests=${runtimeManifest}`,
      `--request-timeout-ms=${timeoutMs}`,
      ...(reportPath ? [`--report=${reportPath}`] : ['--no-report']),
    ]);
  }
}

console.log(`\nPASS: ${languages.length} Classic providers across ${engines.length} engine(s)`);

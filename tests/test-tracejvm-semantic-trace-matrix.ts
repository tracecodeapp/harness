#!/usr/bin/env npx tsx

import { spawnSync } from 'node:child_process';

const supportedBrowsers = new Set(['chromium', 'firefox', 'webkit']);
const browsers = (process.env.BROWSERS ?? 'chromium,firefox,webkit')
  .split(',')
  .map((browser) => browser.trim())
  .filter(Boolean);

if (browsers.length === 0) {
  throw new Error('TraceJVM semantic trace matrix selected no browsers.');
}
for (const browser of browsers) {
  if (!supportedBrowsers.has(browser)) {
    throw new Error(`Unsupported TraceJVM semantic trace browser: ${browser}`);
  }
}

for (const browser of browsers) {
  console.log(`TRACEJVM_SEMANTIC_TRACE_BROWSER_START ${browser}`);
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tests/test-runtime-trace-fixtures.ts',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TRACECODE_RUNTIME_TRACE_LANGUAGES: 'java',
        TRACECODE_JAVA_TRACE_PROVIDER: 'tracejvm',
        TRACECODE_TRACEJVM_BROWSER: browser,
      },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
  console.log(`TRACEJVM_SEMANTIC_TRACE_BROWSER_PASS ${browser}`);
}

#!/usr/bin/env npx tsx

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runCommand, waitForHttp } from './example-app-smoke';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-cpp-browser-'));
  const workersRoot = join(tempRoot, 'workers');
  const port = 5200 + Math.floor(Math.random() * 200);
  const origin = `http://127.0.0.1:${port}`;

  await runCommand('pnpm', ['exec', 'tsx', 'src/cli.ts', 'sync-assets', workersRoot], process.cwd());
  await writeFile(join(tempRoot, 'index.html'), '<!doctype html><title>C++ worker smoke</title>', 'utf8');

  const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', tempRoot], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (chunk) => process.stdout.write(String(chunk)));
  server.stderr?.on('data', (chunk) => process.stderr.write(String(chunk)));

  const browser = await chromium.launch({ headless: true });
  try {
    await waitForHttp(origin, 30_000);
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    await page.goto(origin);

    const results = await page.evaluate(`(async () => {
      const worker = new Worker('/workers/cpp-worker.js', { type: 'module' });
      let nextId = 0;
      const pending = new Map();

      worker.onmessage = (event) => {
        const { id, type, payload } = event.data;
        if (type === 'worker-ready') return;
        if (!id) return;
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        if (type === 'error') {
          request.reject(new Error(String((payload && payload.error) || 'C++ worker error')));
        } else {
          request.resolve(payload);
        }
      };
      worker.onerror = (event) => {
        for (const request of pending.values()) {
          request.reject(new Error(event.message || 'C++ worker error'));
        }
        pending.clear();
      };

      const send = (type, payload) =>
        new Promise((resolve, reject) => {
          const id = String(++nextId);
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, type, payload });
        });

      await send('init', {
        assets: {
          compilerBundleUrl: '/workers/vendor/cpp/yowasp/bundle.js',
          clangWasmUrl: '/workers/vendor/cpp/clang.wasm',
          lldWasmUrl: '/workers/vendor/cpp/lld.wasm',
          sysrootUrl: '/workers/vendor/cpp/sysroot.tar',
          runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
        },
      });

      const add = await send('compile-run', {
        code: 'class Solution { public: int add(int a, int b) { return a + b; } };',
        functionName: 'add',
        inputs: { a: 2, b: 3 },
      });
      const twoSum = await send('compile-run', {
        code: 'class Solution { public: vector<int> twoSum(vector<int>& nums, int target) { unordered_map<int,int> seen; for (int i=0;i<nums.size();++i){ int c=target-nums[i]; if(seen.count(c)) return {seen[c],i}; seen[nums[i]]=i;} return {}; } };',
        functionName: 'twoSum',
        inputs: { nums: [2, 7, 11, 15], target: 9 },
      });
      const syntaxError = await send('compile-run', {
        code: [
          'class Solution {',
          'public:',
          '  int add(int a, int b) {',
          '    return a + ;',
          '  }',
          '};',
        ].join('\\n'),
        functionName: 'add',
        inputs: { a: 2, b: 3 },
      });
      const traced = await send('execute-with-tracing', {
        code: 'class Solution { public: int add(int a, int b) { return a + b; } };',
        functionName: 'add',
        inputs: { a: 2, b: 3 },
        options: {},
      });

      worker.terminate();
      return { add, twoSum, syntaxError, traced };
    })()`);

    const add = results.add as { success?: boolean; output?: unknown; error?: string };
    const twoSum = results.twoSum as { success?: boolean; output?: unknown; error?: string };
    const syntaxError = results.syntaxError as { success?: boolean; error?: string; errorLine?: number };
    const traced = results.traced as { success?: boolean; output?: unknown; trace?: { events?: Array<{ kind?: string; value?: unknown }> } };
    assertCondition(add.success === true && add.output === 5, `C++ browser add failed: ${JSON.stringify(add)}`);
    assertCondition(
      twoSum.success === true && JSON.stringify(twoSum.output) === JSON.stringify([0, 1]),
      `C++ browser twoSum failed: ${JSON.stringify(twoSum)}`
    );
    assertCondition(
      syntaxError.success === false && syntaxError.errorLine === 4,
      `C++ browser syntax error did not map to user line 4: ${JSON.stringify(syntaxError)}`
    );
    assertCondition(traced.success === true && traced.output === 5, `C++ browser tracing failed: ${JSON.stringify(traced)}`);
    assertCondition(
      traced.trace?.events?.some((event) => event.kind === 'call') &&
        traced.trace?.events?.some((event) => event.kind === 'return' && event.value === 5),
      `C++ browser tracing should include call and return events: ${JSON.stringify(traced)}`
    );
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  console.log('PASS: C++ browser worker compiles and runs code');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

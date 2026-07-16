#!/usr/bin/env npx tsx

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { chromium } from 'playwright';

import {
  assertCondition,
  runCommand,
  startPreviewServer,
  waitForHttp,
} from './example-app-smoke';

declare global {
  interface Window {
    __terminalFormSamples?: Array<{ display: string; hidden: boolean; text: string }>;
    __terminalFormSampler?: number;
  }
}

async function runProjectTerminalSmoke(previewUrl: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const requestedUrls: string[] = [];
  page.on('request', (request) => requestedUrls.push(request.url()));

  try {
    await page.goto(previewUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('#dev-terminal-input', { timeout: 180_000 });
    await page.waitForFunction(
      () => document.querySelector('#dev-terminal-output')?.textContent?.includes('Try: ls, cat README.txt') === true,
      undefined,
      { timeout: 180_000 }
    );

    const initial = await page.evaluate(() => ({
      hasHeader: Boolean(document.querySelector('header, .dev-menubar')),
      prompt: document.querySelector('#dev-terminal-prompt')?.textContent ?? '',
      output: document.querySelector('#dev-terminal-output')?.textContent ?? '',
    }));
    assertCondition(!initial.hasHeader, 'project terminal should not render a header or menubar');
    assertCondition(initial.prompt === 'user@tracevm demo $', `project terminal prompt should use demo workspace: ${initial.prompt}`);
    assertCondition(
      initial.output.includes('C++: cd cpp && clang++ -std=c++17 report.cpp -o ../report') &&
        initial.output.includes('     ../report') &&
        initial.output.includes('Java: inject window.__tracecodeRuntimeAssetManifests.java before boot') &&
        !initial.output.includes('Project workspace ready.') &&
        !initial.output.includes('../report, ./report'),
      `project terminal should print copyable compile/run commands on separate lines: ${JSON.stringify(initial.output)}`
    );

    await page.fill('#dev-terminal-input', 'tracekernelctl verbose on');
    await page.press('#dev-terminal-input', 'Enter');
    await page.waitForFunction(
      () => document.querySelector('#dev-terminal-output')?.textContent?.includes('tracekernelctl: verbose on') === true,
      undefined,
      { timeout: 180_000 }
    );

    await page.evaluate(() => {
      window.__terminalFormSamples = [];
      window.__terminalFormSampler = window.setInterval(() => {
        const output = document.querySelector('#dev-terminal-output')?.textContent ?? '';
        const form = document.querySelector<HTMLFormElement>('#dev-terminal-form');
        if (!form || !output.includes('[compile-start]') || output.includes('[compile-end]')) return;
        window.__terminalFormSamples?.push({
          display: getComputedStyle(form).display,
          hidden: form.hidden,
          text: form.textContent ?? '',
        });
      }, 10);
    });

    await page.fill('#dev-terminal-input', 'cd cpp && clang++ -std=c++17 report.cpp -o ../report');
    await page.press('#dev-terminal-input', 'Enter');
    await page.waitForFunction(
      () => document.querySelector('#dev-terminal-output')?.textContent?.includes('[compile-end] Finished C++ browser compile') === true,
      undefined,
      { timeout: 180_000 }
    );

    const compileVisibility = await page.evaluate(() => {
      if (window.__terminalFormSampler !== undefined) {
        window.clearInterval(window.__terminalFormSampler);
      }
      const form = document.querySelector<HTMLFormElement>('#dev-terminal-form');
      return {
        samples: window.__terminalFormSamples ?? [],
        finalDisplay: form ? getComputedStyle(form).display : '',
        finalHidden: form?.hidden ?? true,
      };
    });
    assertCondition(compileVisibility.samples.length > 0, 'project terminal smoke should sample the active compile window');
    assertCondition(
      compileVisibility.samples.every((sample) => sample.hidden && sample.display === 'none'),
      `terminal input row should stay hidden while compile is running: ${JSON.stringify(compileVisibility.samples)}`
    );
    assertCondition(
      compileVisibility.finalDisplay !== 'none' && !compileVisibility.finalHidden,
      `terminal input row should return after compile exits: ${JSON.stringify(compileVisibility)}`
    );
    assertCondition(
      await page.locator('#dev-terminal-prompt').textContent() === 'user@tracevm cpp $',
      'compound cd should persist in the terminal prompt after the compile command completes'
    );

    await page.fill('#dev-terminal-input', '../report');
    await page.press('#dev-terminal-input', 'Enter');
    await page.waitForFunction(
      () => document.querySelector('#dev-terminal-output')?.textContent?.includes('Report title:') === true,
      undefined,
      { timeout: 180_000 }
    );
    await page.fill('#dev-terminal-input', 'Live stdin report');
    await page.press('#dev-terminal-input', 'Enter');
    await page.waitForFunction(
      () => document.querySelector('#dev-terminal-output')?.textContent?.includes('Team name:') === true,
      undefined,
      { timeout: 180_000 }
    );
    await page.fill('#dev-terminal-input', 'TraceCode');
    await page.press('#dev-terminal-input', 'Enter');
    await page.waitForFunction(
      () => document.querySelector('#dev-terminal-output')?.textContent?.includes('Metric name:') === true,
      undefined,
      { timeout: 180_000 }
    );
    await page.fill('#dev-terminal-input', 'iPhone compiles');
    await page.press('#dev-terminal-input', 'Enter');
    await page.waitForFunction(
      () => document.querySelector('#dev-terminal-output')?.textContent?.includes('Metric value:') === true,
      undefined,
      { timeout: 180_000 }
    );
    await page.fill('#dev-terminal-input', '2');
    await page.press('#dev-terminal-input', 'Enter');
    await page.waitForFunction(
      () => document.querySelector('#dev-terminal-output')?.textContent?.includes('[process-exit] Finished C++ browser executable') === true,
      undefined,
      { timeout: 180_000 }
    );

    const liveRunOutput = await page.locator('#dev-terminal-output').textContent();
    assertCondition(
      liveRunOutput?.includes('report.md written') === true &&
        liveRunOutput.includes('Report title: Live stdin report') &&
        liveRunOutput.includes('Team name: TraceCode') &&
        liveRunOutput.includes('title=Live stdin report') &&
        !liveRunOutput.includes('TRACE_DEMO_STDIN_COLLECTED'),
      `project terminal should drive the C++ executable with live stdin: ${JSON.stringify(liveRunOutput)}`
    );

    await page.fill('#dev-terminal-input', 'cd .. && javac java/TicketTriage.java && java -cp java TicketTriage');
    await page.press('#dev-terminal-input', 'Enter');
    await page.waitForFunction(
      () => document.querySelector('#dev-terminal-output')?.textContent?.includes('javac: command not found') === true,
      undefined,
      { timeout: 15_000 }
    );

    const javaRunOutput = await page.locator('#dev-terminal-output').textContent();
    assertCondition(
      javaRunOutput?.includes('javac: command not found') === true && javaRunOutput.includes('exit 127'),
      `project terminal should expose no Java command when the consumer runtime is unavailable: ${JSON.stringify(javaRunOutput)}`
    );
    assertCondition(
      !requestedUrls.some((url) => url.includes('cheerpj-loader.js')),
      `missing Java configuration must fail before any CheerpJ request: ${JSON.stringify(requestedUrls)}`
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const exampleDir = join(repoRoot, 'examples', 'project-terminal');
  const previewPort = 4900 + Math.floor(Math.random() * 200);

  await runCommand('pnpm', ['--dir', exampleDir, 'build'], repoRoot);

  const preview = startPreviewServer(
    'pnpm',
    ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'],
    exampleDir
  );

  try {
    const previewUrl = await preview.waitForUrl;
    await waitForHttp(previewUrl, 30_000);
    await runProjectTerminalSmoke(previewUrl);
  } finally {
    if (!preview.process.killed) {
      preview.process.kill('SIGTERM');
    }
    await preview.waitForExit;
  }

  console.log('PASS: project terminal example renders as a fullscreen terminal and hides input while compiling');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

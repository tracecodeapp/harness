#!/usr/bin/env npx tsx

import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import {
  chromium,
  firefox,
  webkit,
  type BrowserType,
} from 'playwright';

type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

const browserTypes: Record<BrowserEngine, BrowserType> = { chromium, firefox, webkit };
const allowedEngines = Object.keys(browserTypes) as BrowserEngine[];
const requestedEngines = (process.env.TRACECODE_KERNEL_STORAGE_ENGINES ?? 'chromium')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const engines = [...new Set(requestedEngines)] as BrowserEngine[];
if (engines.length === 0 || engines.some((engine) => !allowedEngines.includes(engine))) {
  throw new Error(
    `TRACECODE_KERNEL_STORAGE_ENGINES must select from ${allowedEngines.join(', ')}.`
  );
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'tracecode-kernel-storage-browser-'));
const bundlePath = join(temporaryDirectory, 'kernel-storage-browser.js');
await build({
  entryPoints: [resolve('tests/fixtures/kernel-storage-browser-entry.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: bundlePath,
  logLevel: 'silent',
});
const bundle = readFileSync(bundlePath);

const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  if (request.url === '/kernel-storage-browser.js') {
    response.setHeader('content-type', 'text/javascript; charset=utf-8');
    response.end(bundle);
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><script src="/kernel-storage-browser.js"></script>');
});

await new Promise<void>((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', () => resolveListen());
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Browser storage test server did not bind.');
const origin = `http://127.0.0.1:${address.port}`;

try {
  for (const engine of engines) {
    const browser = await browserTypes[engine].launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(origin);
      const result = await page.evaluate(async () => {
        if (!globalThis.runKernelStorageBrowserTest) {
          throw new Error('Kernel storage browser fixture did not initialize.');
        }
        return globalThis.runKernelStorageBrowserTest();
      });
      const firstSnapshot = (result.firstLoad as { snapshot?: unknown } | null)?.snapshot;
      const secondSnapshot = (result.secondLoad as { snapshot?: unknown } | null)?.snapshot;
      if (JSON.stringify(firstSnapshot) !== JSON.stringify({
        files: [{ path: 'README.md', contents: '# First\n' }],
        entrypoint: 'README.md',
      })) {
        throw new Error(`${engine} failed the first encrypted IndexedDB round trip: ${JSON.stringify(result)}`);
      }
      if (JSON.stringify(secondSnapshot) !== JSON.stringify({
        files: [
          { path: 'README.md', contents: '# Second\n' },
          { path: 'src/index.js', contents: 'console.log("ready")\n' },
        ],
        directories: ['src'],
        entrypoint: 'src/index.js',
      })) {
        throw new Error(`${engine} failed the second encrypted IndexedDB round trip: ${JSON.stringify(result)}`);
      }
      if (result.afterClear !== null || JSON.stringify(result.revisions) !== JSON.stringify([1, 2, 3])) {
        throw new Error(`${engine} failed the IndexedDB clear/revision contract: ${JSON.stringify(result)}`);
      }
      console.log(`PASS: encrypted Project persistence in ${engine}`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

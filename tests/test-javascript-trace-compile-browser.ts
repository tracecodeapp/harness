#!/usr/bin/env npx tsx

// tests/test-javascript-trace-compile.ts in Chromium: the public browser Judge
// host over synced assets, with the same matrix and the same injected faults.
//
// Takes the same TRACECODE_TRACE_COMPILE_* variables.

import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from './example-app-smoke';
import {
  injectTraceBuildFault,
  TRACE_BUILD_FAULTS,
  type TraceBuildFault,
} from './fixtures/javascript-trace-compile-matrix';
import type { UntracedRouteCheck } from './fixtures/javascript-untraced-route';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

function list(name: string): string[] {
  return (process.env[`TRACECODE_TRACE_COMPILE_${name}`] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'tracecode-trace-compile-'));
  const server = createServer(async (request, response) => {
    let path = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    let fault: TraceBuildFault | undefined;
    const injected = /^\/injected\/([^/]+)(\/.*)$/.exec(path);
    if (injected && Object.hasOwn(TRACE_BUILD_FAULTS, injected[1]!)) {
      fault = injected[1] as TraceBuildFault;
      path = injected[2]!;
    }
    const file = resolve(root, `.${path}`);
    const headers = {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    try {
      if (!file.startsWith(root + sep)) throw new Error('outside the test root');
      let body: Buffer | string = await readFile(file);
      if (fault) {
        const name = basename(file);
        if (TRACE_BUILD_FAULTS[fault].some((edit) => edit.file === name)) {
          body = injectTraceBuildFault(name, body.toString('utf8'), fault);
        }
      }
      response.writeHead(200, { ...headers, 'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404, headers).end();
    }
  });
  try {
    await runCommand(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'sync-assets', join(root, 'workers'), '--languages', 'javascript,typescript'],
      resolve('.')
    );
    await build({
      entryPoints: [resolve('tests/fixtures/javascript-trace-compile-entry.ts')],
      outfile: join(root, 'entry.mjs'),
      tsconfig: 'tsconfig.base.json',
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      alias: {
        zlib: resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    });
    await writeFile(join(root, 'index.html'), '<!doctype html><meta charset="utf-8">\n');
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const { port } = server.address() as { port: number };
    const browser = await chromium.launch({ channel: 'chromium', headless: true });
    try {
      const page = await browser.newPage();
      page.on('pageerror', (error) => console.error(`[browser pageerror] ${error.message}`));
      await page.goto(`http://127.0.0.1:${port}/index.html`);
      const startedAt = Date.now();
      const result = await page.evaluate(async (selection) => {
        const moduleUrl: string = '/entry.mjs';
        const { runInBrowser } = await import(moduleUrl);
        return runInBrowser(selection);
      }, {
        languages: list('LANGUAGES'),
        styles: list('STYLES'),
        cases: list('CASES'),
        routes: list('ROUTES'),
      }) as {
        routeChecks: UntracedRouteCheck[];
        observations: unknown[];
        violations: string[];
        checked: number;
      };
      for (const { name, compared, violations } of result.routeChecks) {
        for (const violation of violations) console.error(`FAIL: ${name}: ${violation}`);
        console.log(`${violations.length ? 'FAIL' : 'PASS'}: ${name} (${compared} compared, ${violations.length} violations)`);
        if (violations.length) process.exitCode = 1;
      }
      if (process.env.TRACECODE_TRACE_COMPILE_REPORT) {
        await writeFile(
          process.env.TRACECODE_TRACE_COMPILE_REPORT,
          `${JSON.stringify({ browser: browser.version(), ...result }, null, 1)}\n`
        );
      }
      for (const violation of result.violations) console.error(`FAIL: ${violation}`);
      console.log(
        `${result.violations.length ? 'FAIL' : 'PASS'}: JavaScript trace compile truth in Chromium ${browser.version()}, ` +
          `${result.checked} programs, ${result.violations.length} violations (${Math.round((Date.now() - startedAt) / 1000)} s)`
      );
      if (result.violations.length || !result.checked) process.exitCode = 1;
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
    server.closeAllConnections();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

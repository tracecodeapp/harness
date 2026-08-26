#!/usr/bin/env npx tsx

import { createReadStream, existsSync, statSync } from 'node:fs';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from '../tests/example-app-smoke';

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}

async function main(): Promise<void> {
  const caseCount = Number.parseInt(
    process.env.TRACECODE_JAVA_BENCHMARK_CASES ?? '100',
    10
  );
  const rounds = Number.parseInt(
    process.env.TRACECODE_JAVA_BENCHMARK_ROUNDS ?? '3',
    10
  );
  if (!Number.isInteger(caseCount) || caseCount < 1) {
    throw new TypeError('TRACECODE_JAVA_BENCHMARK_CASES must be positive.');
  }
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new TypeError('TRACECODE_JAVA_BENCHMARK_ROUNDS must be positive.');
  }

  const tempRoot = await mkdtemp(
    join(tmpdir(), 'tracecode-java-isolation-benchmark-')
  );
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await runCommand(
      'pnpm',
      [
        'exec',
        'tsx',
        'src/cli.ts',
        'sync-assets',
        join(tempRoot, 'workers'),
        '--languages',
        'java',
      ],
      process.cwd()
    );
    const traceJVMRoot = resolve(
      process.env.TRACECODE_TRACEJVM_ROOT ?? '../tracejvm'
    );
    const traceJVMTarget = join(tempRoot, 'tracejvm');
    await mkdir(traceJVMTarget, { recursive: true });
    await copyFile(
      join(traceJVMRoot, 'dist/browser-client.js'),
      join(traceJVMTarget, 'browser-client.js')
    );
    await copyFile(
      join(traceJVMRoot, 'runtime/assets/bjvm_main.wasm'),
      join(traceJVMTarget, 'bjvm_main.wasm')
    );
    await cp(
      join(traceJVMRoot, 'runtime/assets/profiles/core'),
      join(traceJVMTarget, 'profiles/core'),
      { recursive: true, force: true }
    );
    await cp(
      join(traceJVMRoot, '.cache/teavm-javac/artifacts'),
      join(traceJVMTarget, 'compiler'),
      { recursive: true, force: true }
    );
    await build({
      entryPoints: [
        resolve(
          'tests/fixtures/java-algorithm-isolation-benchmark-entry.ts'
        ),
      ],
      outfile: join(tempRoot, 'benchmark.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      alias: {
        zlib: resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': resolve(
          'packages/tracekernel/src/zlib-browser-shim.ts'
        ),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    });
    await writeFile(
      join(tempRoot, 'index.html'),
      '<!doctype html><meta charset="utf-8">\n',
      'utf8'
    );

    server = createServer((request, response) => {
      const requestUrl = new URL(
        request.url ?? '/',
        'http://127.0.0.1'
      );
      const candidate = normalize(
        join(tempRoot, decodeURIComponent(requestUrl.pathname))
      );
      if (!candidate.startsWith(tempRoot + sep) && candidate !== tempRoot) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const filePath =
        statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
          ? join(candidate, 'index.html')
          : candidate;
      if (!filePath || !existsSync(filePath)) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Length': String(statSync(filePath).size),
        'Content-Type': contentType(filePath),
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      createReadStream(filePath).pipe(response);
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server!.once('error', rejectListen);
      server!.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Java benchmark server did not bind.');
    }
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(Math.max(180_000, caseCount * rounds * 10_000));
      await page.goto(`http://127.0.0.1:${address.port}/index.html`);
      const samples = await page.evaluate(
        async ({ caseCount: cases, rounds: sampleRounds }) => {
          const moduleUrl: string = '/benchmark.mjs';
          const benchmark = await import(moduleUrl);
          return benchmark.runJavaAlgorithmIsolationBenchmark(
            '/workers',
            cases,
            sampleRounds
          );
        },
        { caseCount, rounds }
      );
      for (const sample of samples) {
        if (
          sample.verdict !== 'passed' ||
          sample.passedCount !== caseCount ||
          sample.totalCount !== caseCount
        ) {
          throw new Error(
            `Java benchmark correctness failed: ${JSON.stringify(sample)}`
          );
        }
      }
      console.log(JSON.stringify({ caseCount, rounds, samples }, null, 2));
    } finally {
      await browser.close();
    }
  } finally {
    if (server) {
      await new Promise<void>((resolveClose) => {
        server!.close(() => resolveClose());
        server!.closeAllConnections?.();
      });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

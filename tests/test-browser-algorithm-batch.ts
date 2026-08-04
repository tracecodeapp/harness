#!/usr/bin/env npx tsx

import { createReadStream, existsSync, statSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from './example-app-smoke';

type BatchLanguage =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'java'
  | 'csharp'
  | 'cpp';

interface ReceiptSummary {
  readonly verdict: string;
  readonly evaluationStatus: string;
  readonly caseVerdicts: readonly string[];
  readonly sessionIds: readonly string[];
  readonly outputs: readonly unknown[];
  readonly diagnostics: readonly unknown[];
  readonly compileStdout: string;
  readonly compileStderr: string;
}

interface BatchLanguageResult {
  readonly plain: ReceiptSummary;
  readonly plainWorkerUrls: readonly string[];
  readonly trace: ReceiptSummary;
  readonly traceWorkerUrls: readonly string[];
}

const ALL_LANGUAGES: readonly BatchLanguage[] = [
  'python',
  'javascript',
  'typescript',
  'java',
  'csharp',
  'cpp',
] as const;
const requestedLanguages =
  process.env.TRACECODE_ALGORITHM_BATCH_LANGUAGES?.split(',')
    .map((language) => language.trim())
    .filter(Boolean);
const LANGUAGES: readonly BatchLanguage[] = requestedLanguages?.length
  ? requestedLanguages.map((language) => {
      assertCondition(
        ALL_LANGUAGES.includes(language as BatchLanguage),
        `Unknown browser algorithm batch language ${JSON.stringify(language)}.`
      );
      return language as BatchLanguage;
    })
  : ALL_LANGUAGES;

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}

async function startStaticServer(root: string): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const candidate = normalize(
      join(root, decodeURIComponent(requestUrl.pathname))
    );
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const filePath = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
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
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve browser algorithm Judge server address.');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      }),
  };
}

function assertReceipt(
  language: BatchLanguage,
  mode: 'code' | 'trace',
  receipt: ReceiptSummary
): void {
  assertCondition(
    receipt.verdict === 'passed' &&
      receipt.caseVerdicts.length === 10 &&
      receipt.caseVerdicts.every((verdict) => verdict === 'passed'),
    `${language} ${mode} batch did not pass all ten cases: ${JSON.stringify(receipt)}`
  );
  assertCondition(
    new Set(receipt.sessionIds).size === 1,
    `${language} ${mode} batch did not use one TraceKernel batch process: ${JSON.stringify(receipt.sessionIds)}`
  );
  assertCondition(
    receipt.outputs.length === 10 &&
      receipt.outputs.every((output) => output === 1),
    `${language} ${mode} batch leaked mutable state between cases: ${JSON.stringify(receipt.outputs)}`
  );
}

function assertBoundedWorkers(
  language: BatchLanguage,
  scope: string,
  workerUrls: readonly string[],
  requireWorker: boolean
): void {
  const languageWorkers = workerUrls.filter((url) =>
    language === 'typescript'
      ? url.includes('javascript-worker.js')
      : language === 'java'
        ? url.includes('java-runtime-worker.js')
        : url.includes(`${language}-worker.js`)
  );
  assertCondition(
    (!requireWorker || languageWorkers.length > 0) &&
      languageWorkers.length <= 3,
    `${language} ${scope} should use a bounded preparation/execution worker set, not one worker per case: ${JSON.stringify(workerUrls)}`
  );
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(
    join(tmpdir(), 'tracecode-browser-algorithm-batch-')
  );
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
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
        LANGUAGES.join(','),
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
        resolve('tests/fixtures/browser-algorithm-batch-entry.ts'),
      ],
      outfile: join(tempRoot, 'algorithm-batch.mjs'),
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
    await writeFile(
      join(tempRoot, 'index.html'),
      '<!doctype html><meta charset="utf-8">\n',
      'utf8'
    );
    server = await startStaticServer(resolve(tempRoot));
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(180_000);
      page.on('pageerror', (error) => {
        console.error(`[browser pageerror] ${error.stack ?? error.message}`);
      });
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
      const result = await page.evaluate(async (languages) => {
        const moduleUrl: string = '/algorithm-batch.mjs';
        const module = await import(moduleUrl);
        return module.runBrowserAlgorithmBatch('/workers', languages);
      }, LANGUAGES) as Record<BatchLanguage, BatchLanguageResult>;

      for (const language of LANGUAGES) {
        const languageResult = result[language];
        assertCondition(
          languageResult !== undefined,
          `Browser algorithm batch omitted ${language}.`
        );
        assertReceipt(language, 'code', languageResult.plain);
        assertReceipt(language, 'trace', languageResult.trace);
        assertBoundedWorkers(
          language,
          'code batch',
          languageResult.plainWorkerUrls,
          false
        );
        assertBoundedWorkers(
          language,
          'trace batch',
          languageResult.traceWorkerUrls,
          false
        );
        assertBoundedWorkers(
          language,
          'code or trace batch',
          languageResult.plainWorkerUrls.length > 0
            ? languageResult.plainWorkerUrls
            : languageResult.traceWorkerUrls,
          true
        );
      }
    } finally {
      await browser.close();
    }
    console.log(
      'Browser algorithm Judge code and trace batches passed for every language with isolated case state and bounded workers.'
    );
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env npx tsx

import { createReadStream, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { JudgeAlgorithmLanguage, JudgeComparatorStrategy } from '../src/judge';
import { getLanguageRuntimeProfile } from '../packages/runtime-browser/src/runtime-profiles';
import type { ParityProblem, TraceParityRunner } from './fixtures/browser-trace-parity-entry';
import { targetedCases } from './fixtures/trace-parity-targeted-cases';
import { runCommand } from './example-preview-process';

const extensions = {
  python: 'py',
  javascript: 'js',
  typescript: 'ts',
  cpp: 'cpp',
  java: 'java',
  csharp: 'cs',
} satisfies Record<JudgeAlgorithmLanguage, string>;

interface CatalogProblem {
  id: string;
  functionName: string;
  executionStyle: ParityProblem['executionStyle'];
  solutionCode: string;
  patterns: string[];
  compareMode?: JudgeComparatorStrategy['mode'];
  customValidator?: JudgeComparatorStrategy['customValidator'];
  testCases: Array<ParityProblem['cases'][number] & {
    customValidator?: JudgeComparatorStrategy['customValidator'];
  }>;
}

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

async function startStaticServer(root: string) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const file = resolve(root, '.' + decodeURIComponent(url.pathname));
    const stat = file.startsWith(root + sep) && statSync(file, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No browser asset server port.');
  return {
    origin: 'http://127.0.0.1:' + address.port,
    close: () => new Promise<void>((closed) => {
      server.close(() => closed());
      server.closeAllConnections();
    }),
  };
}

function csv(value: string | undefined) {
  return [...new Set(value?.split(',').map((part) => part.trim()).filter(Boolean))];
}

async function loadCatalog(languages: JudgeAlgorithmLanguage[], ids: string[]) {
  const corpus = process.env.TRACECODE_PARITY_CORPUS;
  if (!corpus) throw new Error('Set TRACECODE_PARITY_CORPUS to the external corpus directory.');
  const problemDir = join(corpus, 'problems');
  const available = (await readdir(problemDir)).filter((name) => name.endsWith('.json')).sort();
  for (const id of ids) {
    if (!available.includes(id + '.json')) throw new Error('Unknown problem: ' + id);
  }
  const fixtures: ParityProblem[] = [];
  for (const file of available) {
    if (ids.length && !ids.includes(file.slice(0, -5))) continue;
    const problem: CatalogProblem = JSON.parse(await readFile(join(problemDir, file), 'utf8'));
    const comparison: JudgeComparatorStrategy = {
      schema: 'tracecode.judge.comparator.v1',
      mode: problem.compareMode ?? 'exact',
      customValidator: problem.customValidator,
    };
    for (const language of languages) {
      const code = language === 'python' ? problem.solutionCode : await readFile(
        join(corpus, 'reference-solutions', language, 'practice', problem.id + '.' + extensions[language]),
        'utf8',
      );
      if (!code || !problem.testCases.length) throw new Error('Incomplete fixture: ' + problem.id);
      const heavyRecursion = problem.patterns.includes('backtracking');
      fixtures.push({
        id: problem.id,
        language,
        code,
        functionName: problem.functionName,
        executionStyle: problem.executionStyle,
        comparison,
        cases: problem.testCases.map(({ id, input, expected, customValidator }, index) => ({
          id: id ?? 'case-' + (index + 1),
          input,
          expected,
          ...(customValidator ? { comparator: { ...comparison, customValidator } } : {}),
        })),
        // Desktop Practice Run trace budgets, independent of execution limits.
        traceOptions: Object.fromEntries(Object.entries({
          maxTraceSteps: 4_000,
          maxLineEvents: heavyRecursion ? 20_000 : 12_000,
          maxSingleLineHits: heavyRecursion ? 4_000 : 1_000,
          maxStoredEvents: 16_000,
        } as const).filter(([key]) => {
          const controls = getLanguageRuntimeProfile(language).capabilities.tracing.controls;
          return controls[key as keyof typeof controls];
        })),
      });
    }
  }
  return fixtures;
}

type Side = Awaited<ReturnType<TraceParityRunner['run']>>['traced'];

function caseOutcome(side: Side, id: string) {
  if (side.exception) return { status: 'exception' as const, failure: side.exception };
  const { receipt } = side;
  const result = receipt.cases[id];
  if (result) {
    const { status, verdict, hasValue, value, failure, notRun, protocolError } = result;
    return { status, verdict: verdict.kind, hasValue, value, failure, notRun, protocolError };
  }
  if (receipt.status === 'compile-failed') {
    return { status: 'compile-failed' as const, failure: receipt.compile?.failure };
  }
  return { status: 'missing-case' as const };
}

async function main() {
  const reportPath = process.env.TRACECODE_PARITY_REPORT;
  if (!reportPath) throw new Error('Set TRACECODE_PARITY_REPORT to the output JSON path.');
  const requested = csv(process.env.TRACECODE_PARITY_LANGUAGES);
  const languages = (requested.length ? requested : Object.keys(extensions)).map((language) => {
    if (!Object.hasOwn(extensions, language)) throw new Error('Unknown language: ' + language);
    return language as JudgeAlgorithmLanguage;
  });
  const ids = csv(process.env.TRACECODE_PARITY_PROBLEMS);
  const suite = process.env.TRACECODE_PARITY_SUITE ?? 'catalog';
  if (suite !== 'catalog' && suite !== 'targeted' && suite !== 'direct') {
    throw new Error('Unknown parity suite: ' + suite);
  }
  const fixtures = suite === 'catalog' ? await loadCatalog(languages, ids) :
    targetedCases.filter(({ id, language }) =>
      languages.includes(language) &&
      (suite === 'direct' ? id === 'box-get' : id !== 'box-get') &&
      (!ids.length || ids.includes(id)));
  if (!fixtures.length) throw new Error('No problems selected.');
  const providers = [...new Set(fixtures.map(({ language }) => language))];
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-trace-parity-'));
  const report = {
    browser: 'chromium',
    browserVersion: '',
    suite,
    complete: false,
    selected: fixtures.map(({ id, language }) => ({ id, language })),
    problems: [] as unknown[],
  };
  await mkdir(dirname(reportPath), { recursive: true });
  async function saveReport() {
    await writeFile(reportPath + '.tmp', JSON.stringify(report, null, 2) + '\n');
    await rename(reportPath + '.tmp', reportPath);
  }

  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await saveReport();
    await runCommand('corepack', [
      'pnpm', 'exec', 'tsx', '--tsconfig', 'tsconfig.base.json', 'src/cli.ts',
      'sync-assets', join(tempRoot, 'workers'), '--languages',
      [...new Set(providers.map((language) => language === 'typescript' ? 'javascript' : language))].join(','),
    ], process.cwd());
    await build({
      entryPoints: [resolve('tests/fixtures/browser-trace-parity-entry.ts')],
      outfile: join(tempRoot, 'trace-parity.mjs'),
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
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">');
    server = await startStaticServer(tempRoot);
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    report.browserVersion = browser.version();
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('[browser pageerror]', error));
    const crashed = new Promise<never>((_, reject) => {
      page.once('crash', () => reject(new Error('Chromium page crashed.')));
    });
    // A crash between evaluations must not produce an unhandled rejection.
    void crashed.catch(() => {});
    await page.goto(server.origin + '/index.html');
    const runner = await Promise.race([
      crashed,
      page.evaluateHandle(async (providers): Promise<TraceParityRunner> => {
        const moduleUrl: string = '/trace-parity.mjs';
        const { createTraceParityRunner } = await import(moduleUrl);
        return createTraceParityRunner(providers);
      }, providers),
    ]);
    for (const problem of fixtures) {
      const started = Date.now();
      const result = await Promise.race([
        crashed,
        runner.evaluate((session, fixture) => session.run(fixture), problem),
      ]);
      const cases = problem.cases.map(({ id, expected }) => {
        const untraced = caseOutcome(result.untraced, id);
        const traced = caseOutcome(result.traced, id);
        return { id, expected, different: !isDeepStrictEqual(untraced, traced), untraced, traced };
      });
      const different = cases.filter((testCase) => testCase.different).length;
      const { id, language, functionName, executionStyle } = problem;
      report.problems.push({
        id, language, functionName, executionStyle, elapsedMs: Date.now() - started,
        ...(suite === 'catalog' ? {} : { code: problem.code }),
        different, cases, ...result,
      });
      await saveReport();
      console.log(language + '/' + id + ' ' + different + '/' + cases.length + ' different (' +
        (Date.now() - started) + 'ms)');
    }
    await runner.evaluate((session) => session.dispose());
    report.complete = true;
    await saveReport();
  } finally {
    await browser?.close();
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

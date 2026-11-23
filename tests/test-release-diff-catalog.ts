#!/usr/bin/env npx tsx

// Cross-version release diff: run the app's Submit and Run requests for every catalog case
// against one Harness package and record each case's outcome. Run it once per revision
// (0.17.1 from its published npm package, the target from this checkout's built dist), then
// compare the two reports with scripts/release-diff/compare.py. Heavy: build host only, via
// scripts/release-diff/host-job.sh. Reports contain private expected outputs and app data;
// keep them out of this repository.
//
// RD_HARNESS_ROOT   package root of the Harness under test (package.json, dist/, workers/)
// RD_LABEL          name recorded in the report (e.g. v0.17.1, target)
// RD_STOP_SUBMIT    1: Submit sends stopAtFirstRunaway for non-Python languages (app main);
//                   0: it never does (app deploy, which runs 0.17.1)
// RD_CORPUS         app data directory (problems/, reference-solutions/, interviews/, ...)
// RD_CATALOG        practice, interviews, or all (default all)
// RD_LANGUAGES / RD_PROBLEMS  comma-separated filters
// RD_REPORT         output JSON path, checkpointed after every problem
// RD_BUDGET_MS      wall budget for the whole process (default 90 minutes)

import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { ReleaseDiffFixture, ReleaseDiffRunner } from './fixtures/release-diff-entry';
import { runCommand } from './example-preview-process';

const extensions: Record<string, string> = {
  python: 'py', javascript: 'js', typescript: 'ts', cpp: 'cpp', java: 'java', csharp: 'cs',
};

type Json = any;
type Fixture = ReleaseDiffFixture & { problemId: string; catalog: 'practice' | 'interview'; stage?: number };

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

// The app's lib/utils.ts getTracingOptions (desktop), identical on deploy and main.
function traceBudget(patterns: string[]) {
  const heavyRecursion = patterns.includes('backtracking');
  return {
    maxTraceSteps: 4_000,
    maxLineEvents: heavyRecursion ? 20_000 : 12_000,
    maxSingleLineHits: heavyRecursion ? 4_000 : 1_000,
    maxStoredEvents: 16_000,
  };
}

async function readJson<T = Json>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function catalogIds(dir: string) {
  return (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
    .map((name) => name.slice(0, -5));
}

async function readOptional(path: string) {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

async function loadPractice(corpus: string, languages: string[], ids: string[], stopSubmit: boolean) {
  const fixtures: Fixture[] = [];
  const missing: Json[] = [];
  for (const id of ids) {
    const problem = await readJson(join(corpus, 'problems', id + '.json'));
    const comparison = {
      schema: 'tracecode.judge.comparator.v1',
      mode: problem.compareMode ?? 'exact',
      ...(problem.customValidator ? { customValidator: problem.customValidator } : {}),
    };
    const cases = problem.testCases.map((testCase: Json, index: number) => ({
      id: testCase.id ?? 'case-' + (index + 1),
      input: testCase.input,
      ...(Object.hasOwn(testCase, 'expected') ? { expected: testCase.expected } : {}),
      ...(testCase.customValidator
        ? { comparator: { ...comparison, customValidator: testCase.customValidator } } : {}),
    }));
    for (const language of languages) {
      const path = join(corpus, 'reference-solutions', language, 'practice', id + '.' + extensions[language]);
      const code = language === 'python' ? problem.solutionCode : await readOptional(path);
      if (!code) {
        missing.push({ catalog: 'practice', problemId: id, language, path: relative(corpus, path) });
        continue;
      }
      fixtures.push({
        id: 'practice/' + id, problemId: id, catalog: 'practice', language, code,
        functionName: problem.functionName,
        executionStyle: problem.executionStyle ?? 'function',
        comparison,
        traceBudget: traceBudget(problem.patterns ?? []),
        submitCases: cases,
        runCases: cases,
        stopSubmitAtFirstRunaway: stopSubmit && language !== 'python',
      });
    }
  }
  return { fixtures, missing };
}

async function loadInterviews(corpus: string, languages: string[], ids: string[], stopSubmit: boolean) {
  // CURRENT_INTERVIEW_TEST_SET_ARTIFACT in the app's data/interview-private/revisions.ts.
  const privateTests = await readJson(join(corpus, 'interview-private', 'test-sets', 'a2-v3.generated.json'));
  const fixtures: Fixture[] = [];
  const missing: Json[] = [];
  for (const id of ids) {
    const problem = await readJson(join(corpus, 'interviews', id + '.json'));
    const privateStages = privateTests.problems[id]?.stages;
    if (problem.id !== id || privateStages?.length !== problem.stages.length) {
      throw new Error('Missing or mismatched interview stages: ' + id);
    }
    for (const [index, { sampleTests }] of problem.stages.entries()) {
      const stage = index + 1;
      const { judge, correctness, performance } = privateStages[index];
      const comparison = { schema: 'tracecode.judge.comparator.v1', mode: judge.compareMode ?? 'exact' };
      // Public Run compares samples strictly; private Submit uses the pinned judge metadata.
      const sampleComparison = { ...comparison, mode: problem.compareMode ?? 'exact', floatTolerance: false };
      const toCase = (testCase: Json, caseId: string, comparator?: Json) => ({
        id: caseId,
        input: testCase.input,
        ...(Object.hasOwn(testCase, 'expected') ? { expected: testCase.expected } : {}),
        ...(comparator ? { comparator } : {}),
      });
      const privateCases = (tests: Json[], bucket: string) => tests.map((testCase, i) => toCase(
        testCase, bucket + '-' + (i + 1),
        testCase.customValidator ? { ...comparison, customValidator: testCase.customValidator } : undefined,
      ));
      const runCases = sampleTests.map((testCase: Json, i: number) =>
        toCase(testCase, testCase.id ?? 'sample-' + (i + 1), sampleComparison));
      const submitCases = [...privateCases(correctness, 'correctness'), ...privateCases(performance, 'performance')];
      for (const language of languages) {
        const file = 'stage-' + stage + '.' + extensions[language];
        const path = language === 'python'
          ? join(corpus, 'interview-reference-solutions', id, file)
          : join(corpus, 'reference-solutions', language, 'interviews', id, file);
        const code = await readOptional(path);
        if (!code?.trim()) {
          missing.push({ catalog: 'interview', problemId: id, stage, language, path: relative(corpus, path) });
          continue;
        }
        fixtures.push({
          id: `interview/${id}/stage-${stage}`, problemId: id, catalog: 'interview', stage, language, code,
          functionName: judge.functionName,
          executionStyle: judge.executionStyle ?? 'function',
          comparison,
          limits: { wallClockMs: judge.wallTimeMs },
          traceBudget: traceBudget(problem.patterns ?? []),
          submitCases,
          runCases,
          stopSubmitAtFirstRunaway: stopSubmit && language !== 'python',
        });
      }
    }
  }
  return { fixtures, missing };
}

async function main() {
  const harnessRoot = resolve(process.env.RD_HARNESS_ROOT ?? '');
  const label = process.env.RD_LABEL ?? '';
  const reportPath = process.env.RD_REPORT ?? '';
  const corpus = process.env.RD_CORPUS ?? '';
  if (!process.env.RD_HARNESS_ROOT || !label || !reportPath || !corpus) {
    throw new Error('Set RD_HARNESS_ROOT, RD_LABEL, RD_REPORT and RD_CORPUS.');
  }
  const stopSubmit = process.env.RD_STOP_SUBMIT === '1';
  const selection = process.env.RD_CATALOG ?? 'all';
  const languages = csv(process.env.RD_LANGUAGES);
  const selectedLanguages = languages.length ? languages : Object.keys(extensions);
  for (const language of selectedLanguages) {
    if (!Object.hasOwn(extensions, language)) throw new Error('Unknown language: ' + language);
  }
  const ids = csv(process.env.RD_PROBLEMS);
  const pick = (all: string[]) => all.filter((id) => !ids.length || ids.includes(id));
  const practiceIds = selection === 'interviews' ? [] : pick(await catalogIds(join(corpus, 'problems')));
  const interviewIds = selection === 'practice' ? [] : pick(await catalogIds(join(corpus, 'interviews')));
  const practice = await loadPractice(corpus, selectedLanguages, practiceIds, stopSubmit);
  const interviews = interviewIds.length
    ? await loadInterviews(corpus, selectedLanguages, interviewIds, stopSubmit)
    : { fixtures: [], missing: [] };
  const fixtures = [...practice.fixtures, ...interviews.fixtures];
  if (!fixtures.length) throw new Error('No fixtures selected.');
  const budgetMs = Number(process.env.RD_BUDGET_MS ?? 90 * 60_000);
  const harnessPackage = await readJson(join(harnessRoot, 'package.json'));

  const report = {
    schema: 'tracecode.release-diff.raw.v1',
    label,
    harnessVersion: harnessPackage.version,
    harnessSha256: process.env.RD_HARNESS_SHA256,
    harnessRoot,
    appOptions: {
      submit: 'host.evaluateAlgorithm, untraced' + (stopSubmit ? ', stopAtFirstRunaway for non-Python' : ''),
      run: 'host.execute interactive, first case traced, then one continuation per remaining case',
      hostOptions: { cpp: { executionTimeoutMs: 20_000, tracingTimeoutMs: 20_000 } },
    },
    appDataSha: process.env.RD_APP_DATA_SHA,
    browser: 'chromium',
    browserVersion: '',
    startedAt: new Date().toISOString(),
    complete: false,
    missingReferences: [...practice.missing, ...interviews.missing],
    problems: [] as Json[],
  };
  await mkdir(dirname(resolve(reportPath)), { recursive: true });
  const saveReport = async () => {
    await writeFile(reportPath + '.tmp', JSON.stringify(report) + '\n');
    await rename(reportPath + '.tmp', reportPath);
  };

  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-release-diff-'));
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await saveReport();
    const providers = [...new Set(fixtures.map(({ language }) => language))];
    await runCommand('node', [
      join(harnessRoot, 'dist', 'cli.cjs'), 'sync-assets', join(tempRoot, 'workers'), '--languages',
      [...new Set(providers.map((language) => language === 'typescript' ? 'javascript' : language))].join(','),
    // From the package root: the CLI resolves its pinned runtime packages (tracecc) from cwd.
    ], harnessRoot);
    const exportPath = (name: string) => {
      const path = harnessPackage.exports?.[name]?.import;
      if (typeof path !== 'string' || !path.startsWith('./dist/') || path.includes('..')) {
        throw new Error(`Missing public export ${name} in ${harnessRoot}`);
      }
      return join(harnessRoot, path);
    };
    const shim = join(harnessRoot, 'dist', 'zlib-browser-shim.js');
    await build({
      entryPoints: [resolve('tests/fixtures/release-diff-entry.ts')],
      outfile: join(tempRoot, 'release-diff.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      alias: {
        'tracecode-harness-under-test/judge': exportPath('./judge'),
        'tracecode-harness-under-test/tracekernel': exportPath('./tracekernel'),
        ...(existsSync(shim) ? { zlib: shim, 'node:zlib': shim } : {}),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">');
    server = await startStaticServer(tempRoot);
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    report.browserVersion = browser.version();

    const deadline = Date.now() + budgetMs;
    let page: Awaited<ReturnType<NonNullable<typeof browser>['newPage']>> | undefined;
    let runner: Awaited<ReturnType<NonNullable<typeof page>['evaluateHandle']>> | undefined;
    let crashed: Promise<never> = new Promise(() => {});
    const openPage = async () => {
      await page?.close().catch(() => {});
      page = await browser!.newPage();
      page.on('pageerror', (error) => console.error('[browser pageerror]', error));
      crashed = new Promise<never>((_, reject) => {
        page!.once('crash', () => reject(new Error('Chromium page crashed.')));
      });
      void crashed.catch(() => {});
      await page.goto(server!.origin + '/index.html');
      runner = await page.evaluateHandle(async (providers): Promise<ReleaseDiffRunner> => {
        const moduleUrl: string = '/release-diff.mjs';
        const { createReleaseDiffRunner } = await import(moduleUrl);
        return createReleaseDiffRunner(providers);
      }, providers);
    };
    await openPage();
    // One problem may not hold the run hostage: a wedged evaluation gets a fresh page.
    const perModeMs = Number(process.env.RD_MODE_TIMEOUT_MS ?? 6 * 60_000);
    const guarded = async (mode: 'submit' | 'run', fixture: Fixture) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          crashed,
          (runner as Json).evaluate(
            (session: ReleaseDiffRunner, [m, f]: [string, ReleaseDiffFixture]) =>
              m === 'submit' ? session.submit(f) : session.run(f),
            [mode, fixture],
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('runner-timeout ' + perModeMs + 'ms')), perModeMs);
          }),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[${label}] ${fixture.language} ${fixture.id} ${mode}: ${message}; reopening page`);
        await openPage();
        return { runnerError: message };
      } finally {
        clearTimeout(timer);
      }
    };
    for (const fixture of fixtures) {
      if (Date.now() > deadline) {
        console.error('Budget exhausted before ' + fixture.language + ' ' + fixture.id);
        break;
      }
      const started = Date.now();
      const submit = await guarded('submit', fixture);
      const run = await guarded('run', fixture);
      const { code: _code, submitCases, runCases, ...identity } = fixture;
      report.problems.push({
        ...identity,
        submitCases: submitCases.map((c: Json) => ({ id: c.id, ...(Object.hasOwn(c, 'expected') ? { expected: c.expected } : {}) })),
        runCases: runCases.map((c: Json) => ({ id: c.id, ...(Object.hasOwn(c, 'expected') ? { expected: c.expected } : {}) })),
        elapsedMs: Date.now() - started,
        submit,
        run,
      });
      await saveReport();
      console.log(`[${label}] ${fixture.language} ${fixture.id} ${Date.now() - started}ms`);
    }
    await (runner as Json)?.evaluate((session: ReleaseDiffRunner) => session.dispose()).catch(() => {});
    report.complete = report.problems.length === fixtures.length && !report.missingReferences.length &&
      !report.problems.some(({ submit, run }) => submit.runnerError || run.runnerError || run.continuationError);
    await saveReport();
    if (!report.complete) throw new Error('Release diff coverage incomplete. See ' + reportPath);
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

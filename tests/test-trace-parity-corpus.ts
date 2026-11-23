#!/usr/bin/env npx tsx

// Release validation (run from this worktree once the build host has at least 15 GiB free).
// Use scp to stage problems/, reference-solutions/, interviews/, interview-reference-solutions/
// and interview-private/test-sets/ from the app data directory under /root/ci/parity-app-data.
// Run one foreground host job at a time, copy its report back, then clean up the job.
// (reports=$(mktemp -d "${TMPDIR:-/tmp}/harness-parity.XXXXXX") || exit $?; echo "$reports"; host=../../harness-artifacts/tools/ar-harness.sh; result=0; for lang in javascript typescript cpp java csharp python; do job="parity-${reports##*.}-$lang"; report="parity-$lang.json"; "$host" "$PWD" "$job" env TRACECODE_PARITY_CORPUS=/root/ci/parity-app-data TRACECODE_PARITY_CATALOG=all TRACECODE_PARITY_LANGUAGES="$lang" TRACECODE_PARITY_REPORT="$report" corepack pnpm exec tsx --tsconfig tsconfig.base.json tests/test-trace-parity-corpus.ts || result=$?; scp "agentrunner:/root/ci/work-harness-$job/$report" "$reports/" || exit $?; "$host" "$PWD" "$job" --cleanup || exit $?; done; exit "$result")
// Review complete, per-case differences, and failures. Reports contain private expected outputs.
//
// TRACECODE_PARITY_CORPUS points at the external app data directory.
// TRACECODE_PARITY_CATALOG selects practice (default), interviews, or all.
// TRACECODE_PARITY_LANGUAGES and TRACECODE_PARITY_PROBLEMS accept comma-separated IDs.
// TRACECODE_PARITY_STAGE limits interview fixtures to one 1-based stage.
// TRACECODE_PARITY_SUITE selects catalog, targeted, syntax, or the direct Box.get probe.
// The syntax gate needs no app data. Run on AgentRunner from a release worktree:
// ../../harness-artifacts/tools/ar-harness.sh "$PWD" parity-syntax bash -c '"corepack pnpm materialize:csharp-role-assets && env TRACECODE_PARITY_SUITE=syntax TRACECODE_PARITY_REPORT=syntax-parity.json corepack pnpm exec tsx --tsconfig tsconfig.base.json tests/test-trace-parity-corpus.ts"'
// TRACECODE_PARITY_REPORT is checkpointed after every complete problem pair.

import { createReadStream, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { JudgeAlgorithmLanguage, JudgeComparatorStrategy } from '../src/judge';
import { getLanguageRuntimeProfile } from '../packages/runtime-browser/src/runtime-profiles';
import type { ParityProblem, TraceParityRunner } from './fixtures/browser-trace-parity-entry';
import { syntaxParityCases, type SyntaxParityFixture } from './fixtures/trace-parity-syntax-cases';
import { checkSyntaxParity, verifySyntaxPinInventory } from './fixtures/trace-parity-syntax-comparison';
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

type FixtureIdentity = { id: string; language: JudgeAlgorithmLanguage; stage?: number };
type CatalogFixture = ParityProblem & FixtureIdentity;
type MissingReference = FixtureIdentity & { missingReference: string };
type CatalogCase = CatalogProblem['testCases'][number];
type CatalogSelection = 'practice' | 'interviews' | 'all';

interface InterviewProblem {
  id: string;
  functionName?: string;
  executionStyle?: ParityProblem['executionStyle'];
  compareMode?: JudgeComparatorStrategy['mode'];
  patterns: string[];
  stages: Array<{ sampleTests: CatalogCase[] }>;
}

interface PrivateInterviewStage {
  judge: Pick<InterviewProblem, 'functionName' | 'executionStyle' | 'compareMode'> & {
    wallTimeMs: number;
  };
  correctness: CatalogCase[];
  performance: CatalogCase[];
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

function traceOptions(language: JudgeAlgorithmLanguage, patterns: string[]) {
  const heavyRecursion = patterns.includes('backtracking');
  const controls = getLanguageRuntimeProfile(language).capabilities.tracing.controls;
  // Desktop Practice Run trace budgets, independent of execution limits.
  return Object.fromEntries(Object.entries({
    maxTraceSteps: 4_000,
    maxLineEvents: heavyRecursion ? 20_000 : 12_000,
    maxSingleLineHits: heavyRecursion ? 4_000 : 1_000,
    maxStoredEvents: 16_000,
  }).filter(([key]) => controls[key as keyof typeof controls]));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function catalogIds(dir: string) {
  const ids = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
    .map((name) => name.slice(0, -5));
  if (!ids.length) throw new Error('No problem files in ' + dir);
  return ids;
}

async function loadPractice(corpus: string, languages: JudgeAlgorithmLanguage[], ids: string[]) {
  const fixtures: CatalogFixture[] = [];
  for (const id of ids) {
    const problem = await readJson<CatalogProblem>(join(corpus, 'problems', id + '.json'));
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
        traceOptions: traceOptions(language, problem.patterns),
      });
    }
  }
  return fixtures;
}

function interviewCase(testCase: CatalogCase, id: string, comparator?: JudgeComparatorStrategy) {
  return {
    id,
    input: testCase.input,
    ...(Object.hasOwn(testCase, 'expected') ? { expected: testCase.expected } : {}),
    ...(comparator ? { comparator } : {}),
  };
}

async function loadInterviews(
  corpus: string, languages: JudgeAlgorithmLanguage[], ids: string[], stageFilter?: number,
) {
  // Match CURRENT_INTERVIEW_TEST_SET_ARTIFACT in the app's data/interview-private/revisions.ts.
  const privateTests = await readJson<{ problems: Record<string, { stages: PrivateInterviewStage[] }> }>(
    join(corpus, 'interview-private', 'test-sets', 'a2-v3.generated.json'),
  );
  const fixtures: Array<CatalogFixture | MissingReference> = [];
  for (const id of ids) {
    const problem = await readJson<InterviewProblem>(join(corpus, 'interviews', id + '.json'));
    const privateStages = privateTests.problems[id]?.stages;
    if (problem.id !== id || !problem.stages.length || privateStages?.length !== problem.stages.length) {
      throw new Error('Missing or mismatched interview stages: ' + id);
    }
    if (stageFilter !== undefined && stageFilter > problem.stages.length) {
      throw new Error('Unknown interview stage: ' + id + '/stage-' + stageFilter);
    }
    for (const [index, { sampleTests }] of problem.stages.entries()) {
      const stage = index + 1;
      if (stageFilter !== undefined && stage !== stageFilter) continue;
      const { judge, correctness, performance } = privateStages[index];
      const { functionName, executionStyle, compareMode, wallTimeMs } = judge;
      if (functionName !== problem.functionName ||
          executionStyle !== (problem.executionStyle ?? 'function')) {
        throw new Error(`Public Run and private grading entrypoints differ: ${id}/stage-${stage}`);
      }
      if (!sampleTests.length || !correctness.length || !Number.isSafeInteger(wallTimeMs) || wallTimeMs <= 0) {
        throw new Error(`Incomplete interview fixture: ${id}/stage-${stage}`);
      }
      const comparison: JudgeComparatorStrategy = {
        schema: 'tracecode.judge.comparator.v1',
        mode: compareMode ?? 'exact',
      };
      // Public Interview Run compares strictly. Private Submit uses its pinned judge metadata
      // and assigns positional IDs to the correctness and performance buckets.
      const sampleComparison: JudgeComparatorStrategy = {
        ...comparison, mode: problem.compareMode ?? 'exact', floatTolerance: false,
      };
      const privateCases = (tests: CatalogCase[], bucket: 'correctness' | 'performance') =>
        tests.map((testCase, index) => interviewCase(
          testCase,
          bucket + '-' + (index + 1),
          testCase.customValidator ? { ...comparison, customValidator: testCase.customValidator } : undefined,
        ));
      const cases = [
        ...sampleTests.map((testCase, index) => interviewCase(
          testCase, testCase.id ?? 'sample-' + (index + 1), sampleComparison,
        )),
        ...privateCases(correctness, 'correctness'),
        ...privateCases(performance, 'performance'),
      ];
      if (new Set(cases.map(({ id }) => id)).size !== cases.length) {
        throw new Error(`Duplicate interview case IDs: ${id}/stage-${stage}`);
      }
      for (const language of languages) {
        const file = 'stage-' + stage + '.' + extensions[language];
        const path = language === 'python'
          ? join(corpus, 'interview-reference-solutions', id, file)
          : join(corpus, 'reference-solutions', language, 'interviews', id, file);
        const code = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (code === undefined) {
          fixtures.push({ id, stage, language, missingReference: relative(corpus, path) });
          continue;
        }
        if (!code.trim()) throw new Error(`Empty interview reference: ${language}/${id}/${file}`);
        fixtures.push({
          id, stage, language, code, functionName, executionStyle, comparison, cases,
          limits: { wallClockMs: wallTimeMs },
          traceOptions: traceOptions(language, problem.patterns),
        });
      }
    }
  }
  return fixtures;
}

async function loadCatalog(languages: JudgeAlgorithmLanguage[], ids: string[], selection: CatalogSelection) {
  const corpus = process.env.TRACECODE_PARITY_CORPUS;
  if (!corpus) throw new Error('Set TRACECODE_PARITY_CORPUS to the external corpus directory.');
  const rawStage = process.env.TRACECODE_PARITY_STAGE;
  const stage = rawStage === undefined ? undefined : Number(rawStage);
  if (stage !== undefined && (selection === 'practice' || !Number.isSafeInteger(stage) || stage < 1)) {
    throw new Error('TRACECODE_PARITY_STAGE requires interviews or all and a positive integer.');
  }
  const practice = selection === 'interviews' ? [] : await catalogIds(join(corpus, 'problems'));
  const interviews = selection === 'practice' ? [] : await catalogIds(join(corpus, 'interviews'));
  for (const id of ids) {
    if (!practice.includes(id) && !interviews.includes(id)) throw new Error('Unknown problem: ' + id);
  }
  const selected = (catalog: string[]) => catalog.filter((id) => !ids.length || ids.includes(id));
  const selectedInterviews = selected(interviews);
  return [
    ...await loadPractice(corpus, languages, selected(practice)),
    ...(selectedInterviews.length ? await loadInterviews(corpus, languages, selectedInterviews, stage) : []),
  ];
}

function fixtureIdentity({ id, stage, language }: FixtureIdentity): FixtureIdentity {
  return { id, language, ...(stage === undefined ? {} : { stage }) };
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
  const reportPath = process.env.TRACECODE_PARITY_REPORT ?? '';
  if (!reportPath) throw new Error('Set TRACECODE_PARITY_REPORT to the output JSON path.');
  const requested = csv(process.env.TRACECODE_PARITY_LANGUAGES);
  const languages = (requested.length ? requested : Object.keys(extensions)).map((language) => {
    if (!Object.hasOwn(extensions, language)) throw new Error('Unknown language: ' + language);
    return language as JudgeAlgorithmLanguage;
  });
  const ids = csv(process.env.TRACECODE_PARITY_PROBLEMS);
  const suite = process.env.TRACECODE_PARITY_SUITE ?? 'catalog';
  if (suite !== 'catalog' && suite !== 'targeted' && suite !== 'syntax' && suite !== 'direct') {
    throw new Error('Unknown parity suite: ' + suite);
  }
  if (suite === 'syntax') {
    verifySyntaxPinInventory(syntaxParityCases);
    const fixtures = new Set(syntaxParityCases.map(({ language, id }) => language + '/' + id));
    const rows = new Set(syntaxParityCases.flatMap(({ language, id, cases }) =>
      cases.map(({ id: caseId }) => [language, id, caseId].join('/')),
    ));
    if (fixtures.size !== 148 || rows.size !== 296 || syntaxParityCases.length !== fixtures.size) {
      throw new Error('Syntax parity inventory must contain 148 fixtures and 296 case IDs');
    }
  }
  const selection = process.env.TRACECODE_PARITY_CATALOG ?? 'practice';
  if (selection !== 'practice' && selection !== 'interviews' && selection !== 'all') {
    throw new Error('Unknown parity catalog: ' + selection);
  }
  const selected: Array<CatalogFixture | MissingReference | SyntaxParityFixture | ParityProblem> =
    suite === 'catalog' ? await loadCatalog(languages, ids, selection) :
    (suite === 'syntax' ? syntaxParityCases : targetedCases).filter(({ id, language }) =>
      languages.includes(language) &&
      (suite === 'direct' ? id === 'box-get' : id !== 'box-get') &&
      (!ids.length || ids.includes(id)));
  if (!selected.length) throw new Error('No problems selected.');
  const fixtures = selected.filter((fixture) => 'code' in fixture);
  const missingReferences = selected.filter((fixture) => 'missingReference' in fixture);
  const providers = [...new Set(fixtures.map(({ language }) => language))];
  const budgetMs = Number(process.env.TRACECODE_PARITY_BUDGET_MS ?? 40 * 60_000);
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 || budgetMs > 40 * 60_000) {
    throw new Error('TRACECODE_PARITY_BUDGET_MS must be between 1 and 2400000.');
  }
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-trace-parity-'));
  const report = {
    browser: 'chromium',
    browserVersion: '',
    suite,
    complete: false,
    nextProblem: undefined as FixtureIdentity | undefined,
    selected: selected.map(fixtureIdentity),
    problems: [] as unknown[],
    ...(missingReferences.length ? { missingReferences } : {}),
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
    for (const { missingReference } of missingReferences) {
      console.error('Missing interview reference: ' + missingReference);
    }
    if (!fixtures.length) throw new Error('No selected references are available. See ' + reportPath);
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
    const deadline = Date.now() + budgetMs;
    let syntaxFailures = 0;
    let syntaxControl: { fixture: SyntaxParityFixture; result: Awaited<ReturnType<TraceParityRunner['runSyntaxParity']>> } | undefined;
    for (const problem of fixtures) {
      const remainingMs = deadline - Date.now();
      report.nextProblem = fixtureIdentity(problem);
      const label = 'stage' in problem && problem.stage !== undefined ? `${problem.id}/stage-${problem.stage}` : problem.id;
      if (remainingMs <= 0) {
        await saveReport();
        throw new Error('Parity time budget exhausted before ' + label);
      }
      const started = Date.now();
      let budgetTimer: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        crashed,
        runner.evaluate(
          async (session, { fixture, syntax }) => syntax
            ? { syntax: true as const, result: await session.runSyntaxParity(fixture) }
            : { syntax: false as const, result: await session.run(fixture) },
          { fixture: { ...problem, id: label }, syntax: suite === 'syntax' },
        ),
        new Promise<never>((_, reject) => {
          budgetTimer = setTimeout(() => {
            reject(new Error('Parity time budget exhausted during ' + label));
          }, remainingMs);
        }),
      ]).catch(async (error) => {
        await saveReport();
        throw error;
      }).finally(() => clearTimeout(budgetTimer));
      const { result } = response;
      if (response.syntax) {
        if (!('expectation' in problem)) throw new Error('Missing syntax fixture expectation for ' + label);
        const { issues, refusals, pinnedIssues } = checkSyntaxParity(problem, response.result);
        if (issues.length || refusals.length) syntaxFailures += 1;
        if (problem.language === 'javascript' && problem.id === 'function/missing-closer' && !issues.length && !refusals.length) {
          syntaxControl = { fixture: problem, result: response.result };
        }
        if (syntaxControl && problem.language === 'javascript' && problem.id === 'function/modern-syntax' &&
            !issues.length && !refusals.length) {
          // Model acceptance of the invalid source at the traced response boundary.
          const mutant = checkSyntaxParity(syntaxControl.fixture, {
            ...syntaxControl.result, traced: response.result.traced,
          });
          const hits = mutant.issues.filter(({ mode, differences }) =>
            mode === 'traced' && differences.includes('submit-verdict'));
          if (hits.length !== 1) throw new Error('Syntax/missing-closer/submit-verdict: mutant survived');
          console.log('Syntax/missing-closer/submit-verdict: seeded traced acceptance hit=1');
        }
        report.problems.push({
          ...fixtureIdentity(problem), style: problem.style, functionName: problem.functionName,
          executionStyle: problem.executionStyle, expectation: problem.expectation,
          elapsedMs: Date.now() - started, code: problem.code, cases: problem.cases,
          issues, refusals, pinnedIssues, ...result,
        });
        report.nextProblem = undefined;
        await saveReport();
        console.log(`${problem.language}/${label} ${issues.length} issue(s), ${pinnedIssues.length} pinned issue(s), ${refusals.length} trace refusal(s)`);
        continue;
      }
      const cases = problem.cases.map(({ id, expected }) => {
        const untraced = caseOutcome(result.untraced, id);
        const traced = caseOutcome(result.traced, id);
        return { id, expected, different: !isDeepStrictEqual(untraced, traced), untraced, traced };
      });
      const different = cases.filter((testCase) => testCase.different).length;
      const { language, functionName, executionStyle } = problem;
      report.problems.push({
        ...fixtureIdentity(problem), functionName, executionStyle, elapsedMs: Date.now() - started,
        ...(suite === 'catalog' ? {} : { code: problem.code }),
        different, cases, ...result,
      });
      report.nextProblem = undefined;
      await saveReport();
      console.log(language + '/' + label + ' ' + different + '/' + cases.length + ' different (' +
        (Date.now() - started) + 'ms)');
    }
    await runner.evaluate((session) => session.dispose());
    report.complete = missingReferences.length === 0;
    await saveReport();
    if (!report.complete) throw new Error('Interview references are missing. See ' + reportPath);
    if (syntaxFailures) {
      throw new Error(`Syntax parity failed for ${syntaxFailures}/${fixtures.length} programs. See ${reportPath}`);
    }
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

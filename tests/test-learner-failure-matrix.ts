#!/usr/bin/env npx tsx

/**
 * Learner-failure classification conformance matrix.
 *
 * Every language × run mode × failure kind runs through the public
 * BrowserJudgeHost in a real browser and is read the way a consumer reads it:
 * from the Judge diagnostics. A failure caused by the learner's program must
 * be the learner's (compile, runtime, or a limit with its reason) and carry a
 * readable message and, where the language can know it, the line. Only a
 * genuine provider failure may say `runtime-provider-error`. After each cell
 * the same host must still run a healthy program: recovering from a
 * learner-caused crash is the Harness's job.
 *
 * Cells that cannot be made right yet are listed in KNOWN_GAPS with the
 * reason. A listed gap that starts passing fails the run so the list stays
 * honest.
 *
 * Environment:
 * - TRACECODE_MATRIX_LANGUAGES=python,cpp   restrict languages
 * - TRACECODE_MATRIX_MODES=code,trace       restrict modes
 * - TRACECODE_MATRIX_KINDS=syntax,...       restrict failure kinds
 * - TRACECODE_MATRIX_REPORT=path.json       write the observed matrix
 * - TRACECODE_MATRIX_OBSERVE=1              report only; never fail
 * - TRACECODE_MATRIX_DEFAULT_LIMITS=1       probe the infinite loop with no
 *                                           configured limits (slow)
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from './example-app-smoke';
import { symlink } from 'node:fs/promises';
import { loadEngineRuntimePackages } from '../scripts/runtime-package-assets.mjs';
import {
  MATRIX_LANGUAGES,
  MATRIX_MODES,
  matrixCells,
  type MatrixCellResult,
  type MatrixCellSpec,
  type MatrixFailureKind,
  type MatrixLanguage,
  type MatrixMode,
  type MatrixObservation,
} from './fixtures/learner-failure-matrix-cases';

type Aspect = 'classification' | 'message' | 'line' | 'recovery';

/**
 * Known gaps: `${language}:${mode | '*'}:${kind}:${aspect}` → reason.
 * Each entry is a cell that is run and reported but cannot be made right in
 * this change.
 */
const JS_TRACE =
  `Traced JavaScript/TypeScript runs execute instrumented source and the instrumenter keeps no map back to learner lines, so the Harness omits the line rather than report an instrumentation line.`;
const JS_SYNTAX =
  `JavaScript compile errors come from engine evaluation (SES compartment or Function), which reports no position; TypeScript syntax lines come from the TypeScript compiler and are asserted.`;
const JS_WRAPPER =
  `On the compatibility worker the error's stack points into the generated wrapper, so the line is omitted rather than reported wrong.`;
const JAVA_LINES =
  `TraceJVM's algorithm profile reports exception frames without line numbers, and javac errors refer to the generated wrapper class with no map back to the learner's file.`;
const JAVA_EXIT =
  `TraceJVM treats System.exit as a no-op inside the algorithm sandbox, so the program continues and returns a value. Reporting the exit needs a TraceJVM change or a Java source rewrite, neither safe in this release. It is not reported as a provider failure.`;
const CS_FAST =
  `The C# algorithm-fast runner surfaces every managed failure as TargetInvocationException without the inner exception, so plain-mode cases cannot name the exception or give its line. Its own loop guard surfaces the same way, so a guard stop reads as a runtime failure rather than a limit. Fixing this means rebuilding the managed TraceClr runner; the classification is still the learner's.`;
const CS_TRACE_LINES =
  `Traced C# reports a line only when the trace records the exception event; exceptions raised inside framework operations (casts, division, indexing) and Environment.Exit arrive without one.`;
const CPP_LINES =
  `WebAssembly traps and exit() carry no source position (learner programs are built without debug information).`;

export const KNOWN_GAPS: Readonly<Record<string, string>> = {
  'javascript:trace:*:line': JS_TRACE,
  'javascript:trace-batch:*:line': JS_TRACE,
  'javascript:interactive:*:line': JS_TRACE,
  'javascript:code:process-exit:line': JS_WRAPPER,
  'javascript:code-batch:process-exit:line': JS_WRAPPER,
  'typescript:trace:*:line': JS_TRACE,
  'typescript:trace-batch:*:line': JS_TRACE,
  'typescript:interactive:*:line': JS_TRACE,
  'typescript:code:process-exit:line': JS_WRAPPER,
  'typescript:code-batch:process-exit:line': JS_WRAPPER,
  'javascript:code:syntax:line': JS_SYNTAX,
  'javascript:code-batch:syntax:line': JS_SYNTAX,
  'javascript:trace:syntax:line': JS_SYNTAX,
  'javascript:trace-batch:syntax:line': JS_SYNTAX,
  'javascript:interactive:syntax:line': JS_SYNTAX,
  'java:*:*:line': JAVA_LINES,
  'java:*:process-exit:classification': JAVA_EXIT,
  'csharp:code:*:message': CS_FAST,
  'csharp:code:*:line': CS_FAST,
  'csharp:code-batch:*:message': CS_FAST,
  'csharp:code-batch:*:line': CS_FAST,
  'csharp:code-batch:infinite-loop:classification': CS_FAST,
  'csharp:trace:*:line': CS_TRACE_LINES,
  'csharp:trace-batch:*:line': CS_TRACE_LINES,
  'csharp:interactive:*:line': CS_TRACE_LINES,
  'cpp:*:division-by-zero:line': CPP_LINES,
  'cpp:*:index-out-of-range:line': CPP_LINES,
  'cpp:*:process-exit:line': CPP_LINES,
  'cpp:*:memory-fault:line': CPP_LINES,
};

function csv(name: string): string[] | undefined {
  const value = process.env[name]?.split(',').map((entry) => entry.trim()).filter(Boolean);
  return value?.length ? value : undefined;
}

const LANGUAGES = (csv('TRACECODE_MATRIX_LANGUAGES') ?? MATRIX_LANGUAGES) as MatrixLanguage[];
const MODES = (csv('TRACECODE_MATRIX_MODES') ?? MATRIX_MODES) as MatrixMode[];
const KINDS = csv('TRACECODE_MATRIX_KINDS') as MatrixFailureKind[] | undefined;
const OBSERVE_ONLY = process.env.TRACECODE_MATRIX_OBSERVE === '1';
const DEFAULT_LIMITS_PROBE = process.env.TRACECODE_MATRIX_DEFAULT_LIMITS === '1';
const FULL_RUN = !process.env.TRACECODE_MATRIX_LANGUAGES &&
  !process.env.TRACECODE_MATRIX_MODES &&
  !process.env.TRACECODE_MATRIX_KINDS;
for (const language of LANGUAGES) {
  if (!MATRIX_LANGUAGES.includes(language)) throw new Error(`Unknown language ${language}`);
}
for (const mode of MODES) {
  if (!MATRIX_MODES.includes(mode)) throw new Error(`Unknown mode ${mode}`);
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

async function startServer(root: string) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const headers = {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    if (url.pathname.startsWith('/__broken__/')) {
      // The injected provider failure: an asset the runtime needs is down.
      response.writeHead(503, headers).end('injected asset outage');
      return;
    }
    const candidate = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    let filePath: string | undefined = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!existsSync(filePath)) filePath = undefined;
    if (!filePath) {
      response.writeHead(404, headers).end('Not found');
      return;
    }
    response.writeHead(200, {
      ...headers,
      'Content-Length': String(statSync(filePath).size),
      'Content-Type': contentType(filePath),
    });
    createReadStream(filePath).pipe(response);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Matrix server did not bind.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections?.();
      }),
  };
}

const UNREADABLE_MESSAGE = [
  /^\s*$/u,
  /\[object Object\]/u,
  /^(?:undefined|null)$/u,
  // .NET resource keys in place of messages, e.g. Arg_IndexOutOfRangeException.
  /^[A-Z][A-Za-z]+_[A-Z][A-Za-z]+(?:,.*)?$/u,
  // A placeholder that says the runtime could not name what was thrown.
  /did not report which/u,
];

interface CellVerdict {
  readonly result: MatrixCellResult;
  readonly spec: MatrixCellSpec;
  readonly failures: ReadonlyMap<Aspect, string>;
}

function expectedClasses(spec: MatrixCellSpec, mode: MatrixMode) {
  return spec.completesIn?.includes(mode) ? ['completed'] : spec.expected;
}

function judgeCell(spec: MatrixCellSpec, result: MatrixCellResult): CellVerdict {
  const failures = new Map<Aspect, string>();
  const expected = expectedClasses(spec, result.mode);
  if (result.observations.length === 0) {
    failures.set('classification', 'no observations');
  }
  for (const observation of result.observations) {
    if (!expected.includes(observation.class)) {
      failures.set(
        'classification',
        `expected ${expected.join('|')}, got ${observation.class}` +
          (observation.code ? ` (${observation.code})` : '') +
          (observation.message ? `: ${observation.message.slice(0, 160)}` : '')
      );
      continue;
    }
    if (
      observation.class === 'limit' &&
      spec.limitReasons &&
      !spec.limitReasons.includes(observation.reason ?? '')
    ) {
      failures.set(
        'classification',
        `limit reason ${observation.reason} not in ${spec.limitReasons.join('|')}`
      );
    }
    const learner =
      observation.class === 'compile' ||
      observation.class === 'runtime' ||
      observation.class === 'limit';
    if (learner && UNREADABLE_MESSAGE.some((pattern) => pattern.test(observation.message ?? ''))) {
      failures.set('message', `unreadable message ${JSON.stringify(observation.message?.slice(0, 160))}`);
    }
    if (
      spec.line !== undefined &&
      (observation.class === 'compile' || observation.class === 'runtime') &&
      observation.line !== spec.line
    ) {
      failures.set('line', `expected line ${spec.line}, got ${String(observation.line)}`);
    }
  }
  if (result.healthyAfter === false) {
    failures.set('recovery', `healthy program failed afterwards: ${result.healthyAfterDetail ?? ''}`);
  }
  return { result, spec, failures };
}

function knownGap(result: MatrixCellResult, aspect: Aspect): string | undefined {
  for (const mode of [result.mode, '*']) {
    for (const kind of [result.kind, '*']) {
      const reason = KNOWN_GAPS[`${result.language}:${mode}:${kind}:${aspect}`];
      if (reason) return reason;
    }
  }
  return undefined;
}

function summarize(observation: MatrixObservation): string {
  const head =
    observation.class === 'limit'
      ? `limit:${observation.reason}`
      : observation.class === 'compile' || observation.class === 'runtime'
        ? `${observation.class}${observation.line !== undefined ? ` L${observation.line}` : ''}`
        : observation.class;
  return head;
}

function cellText(verdict: CellVerdict): string {
  const distinct = [...new Set(verdict.result.observations.map(summarize))].join('/');
  const failing = [...verdict.failures.keys()];
  const unexpected = failing.filter((aspect) => !knownGap(verdict.result, aspect));
  const marker = unexpected.length > 0 ? ' ✗' : failing.length > 0 ? ' (gap)' : '';
  return `${distinct}${marker}`;
}

function printTable(verdicts: readonly CellVerdict[]): void {
  const languages = [...new Set(verdicts.map((verdict) => verdict.result.language))];
  for (const language of languages) {
    const rows = verdicts.filter((verdict) => verdict.result.language === language);
    const kinds = [...new Set(rows.map((verdict) => verdict.result.kind))];
    const modes = [...new Set(rows.map((verdict) => verdict.result.mode))];
    console.log(`\n${language}`);
    console.log(`| kind | ${modes.join(' | ')} |`);
    console.log(`|---|${modes.map(() => '---').join('|')}|`);
    for (const kind of kinds) {
      const cells = modes.map((mode) => {
        const verdict = rows.find(
          (candidate) => candidate.result.kind === kind && candidate.result.mode === mode
        );
        return verdict ? cellText(verdict) : '—';
      });
      console.log(`| ${kind} | ${cells.join(' | ')} |`);
    }
  }
}

function reportVerdicts(
  results: readonly MatrixCellResult[],
  languageFailures: readonly MatrixLanguage[]
): void {
  const languages = [...new Set(results.map((result) => result.language))];
  const specs = new Map<string, MatrixCellSpec>();
  for (const language of languages) {
    for (const spec of matrixCells(language)) specs.set(`${language}:${spec.kind}`, spec);
  }
  const verdicts = results.map((result) =>
    judgeCell(specs.get(`${result.language}:${result.kind}`)!, result)
  );
  printTable(verdicts);

  const unexpected: string[] = [];
  const gaps: string[] = [];
  const stale: string[] = [];
  for (const verdict of verdicts) {
    for (const [aspect, detail] of verdict.failures) {
      const reason = knownGap(verdict.result, aspect);
      const label = `${verdict.result.language}/${verdict.result.mode}/${verdict.result.kind}/${aspect}`;
      if (reason) gaps.push(`${label}: ${detail} — known gap: ${reason}`);
      else unexpected.push(`${label}: ${detail}`);
    }
  }
  for (const [key, reason] of Object.entries(KNOWN_GAPS)) {
    const [language, mode, kind, aspect] = key.split(':') as [MatrixLanguage, string, MatrixFailureKind | '*', Aspect];
    const matching = verdicts.filter((verdict) =>
      verdict.result.language === language &&
      (kind === '*' || verdict.result.kind === kind) &&
      (mode === '*' || verdict.result.mode === mode)
    );
    // Only a complete run can prove a gap closed.
    if (FULL_RUN && matching.length > 0 && matching.every((verdict) => !verdict.failures.has(aspect))) {
      stale.push(`${key} now passes; remove the known gap (${reason})`);
    }
  }
  if (gaps.length > 0) {
    console.log(`\nKnown gaps (${gaps.length}):`);
    for (const gap of gaps) console.log(`  GAP ${gap}`);
  }
  if (stale.length > 0) {
    console.log(`\nStale known gaps (${stale.length}):`);
    for (const entry of stale) console.log(`  STALE ${entry}`);
  }
  if (unexpected.length > 0) {
    console.log(`\nFailures (${unexpected.length}):`);
    for (const failure of unexpected) console.log(`  FAIL ${failure}`);
  }
  for (const language of languageFailures) {
    unexpected.push(`${language}: the language matrix could not run`);
  }
  if (!OBSERVE_ONLY && (unexpected.length > 0 || stale.length > 0)) {
    process.exitCode = 1;
    return;
  }
  console.log(`\nLearner-failure matrix: ${verdicts.length} cells, ${unexpected.length} failures, ${gaps.length} known gaps.`);
}

async function main(): Promise<void> {
  if (process.env.TRACECODE_MATRIX_JUDGE_REPORT) {
    // Re-judge a saved report (for example after editing KNOWN_GAPS) without
    // re-running browsers.
    const saved = JSON.parse(
      await readFile(resolve(process.env.TRACECODE_MATRIX_JUDGE_REPORT), 'utf8')
    ) as MatrixCellResult[];
    reportVerdicts(saved, []);
    return;
  }
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-learner-failure-matrix-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const syncLanguages = [...new Set(LANGUAGES)];
    await runCommand(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'sync-assets', join(tempRoot, 'workers'), '--languages', syncLanguages.join(',')],
      process.cwd()
    );
    if (LANGUAGES.includes('cpp')) {
      const { tracecc } = await loadEngineRuntimePackages(resolve('.'));
      await symlink(tracecc.sourceRoot, join(tempRoot, 'tracecc'), 'dir');
    }
    await build({
      entryPoints: [resolve('tests/fixtures/learner-failure-matrix-entry.ts')],
      outfile: join(tempRoot, 'matrix.mjs'),
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
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n', 'utf8');
    server = await startServer(resolve(tempRoot));

    const browser = await chromium.launch({ headless: true });
    const results: MatrixCellResult[] = [];
    const languageFailures: MatrixLanguage[] = [];
    try {
      for (const language of LANGUAGES) {
        const page = await browser.newPage();
        page.setDefaultTimeout(60 * 60_000);
        page.on('pageerror', (error) => console.error(`[${language} pageerror] ${error.message}`));
        await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
        const startedAt = Date.now();
        try {
          const languageResults = (await page.evaluate(async (options) => {
            const moduleUrl: string = '/matrix.mjs';
            const module = await import(moduleUrl);
            return module.runLanguageMatrix(options);
          }, {
            assetBaseUrl: '/workers',
            language,
            modes: MODES,
            ...(KINDS ? { kinds: KINDS } : {}),
            defaultLimitsProbe: DEFAULT_LIMITS_PROBE,
          })) as MatrixCellResult[];
          console.log(`${language}: ${languageResults.length} cells in ${Math.round((Date.now() - startedAt) / 1000)}s`);
          results.push(...languageResults);
        } catch (error) {
          // A language that cannot run at all is a failure of every cell, not
          // a reason to discard the other languages' evidence.
          console.error(`${language}: matrix run failed: ${error instanceof Error ? error.message : String(error)}`);
          languageFailures.push(language);
        }
        await page.close();
        if (process.env.TRACECODE_MATRIX_REPORT) {
          await writeFile(
            resolve(process.env.TRACECODE_MATRIX_REPORT),
            `${JSON.stringify(results, null, 2)}\n`,
            'utf8'
          );
        }
      }
    } finally {
      await browser.close();
    }

    if (process.env.TRACECODE_MATRIX_REPORT) {
      await writeFile(
        resolve(process.env.TRACECODE_MATRIX_REPORT),
        `${JSON.stringify(results, null, 2)}\n`,
        'utf8'
      );
    }

    if (DEFAULT_LIMITS_PROBE) {
      for (const result of results) {
        console.log(JSON.stringify({
          language: result.language,
          mode: result.mode,
          elapsedMs: result.elapsedMs,
          observations: result.observations,
          healthyAfter: result.healthyAfter,
        }));
      }
      return;
    }

    reportVerdicts(results, languageFailures);
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

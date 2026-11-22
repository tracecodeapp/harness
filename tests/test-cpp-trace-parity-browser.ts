#!/usr/bin/env node
/**
 * Traced and untraced C++ compute the same answers, in a real C++ worker driven
 * through the public BrowserJudgeHost (Chromium): every control-body form the
 * tracing rewriter normalizes (braceless bodies, one-line `else`/`else if`
 * chains, dangling `else`, loop/jump/macro bodies, comments and literals with
 * `;`/`else`/braces, Allman braces, `if (init; cond)`), the Binary Search
 * repro from the app, and programs the tracer refuses (reported as the
 * provider's failure, never the learner's, while the untraced evaluation still
 * runs them).
 *
 * The forms are grouped by how they used to fail, so a run against an older
 * Harness shows which failure each group had:
 * - compile-forms: the traced build did not compile (the learner was blamed);
 * - silent-forms: the traced build compiled and computed different answers;
 * - repro: the app's Binary Search (Run 0/10, Submit 10/10).
 *
 * Linux needs full Chromium (`channel: 'chromium'`): the headless shell crashes
 * on a C++ WebAssembly out-of-bounds write there. TRACECODE_PARITY_BROWSER_CHANNEL
 * overrides the channel.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from './example-app-smoke';
import {
  formsProgram,
  PARITY_INPUTS,
  type ParityForm,
  type ParityProgram,
  type ParitySample,
} from './fixtures/cpp-trace-parity-entry';

const BROWSER_CHANNEL = process.env.TRACECODE_PARITY_BROWSER_CHANNEL ||
  (process.platform === 'linux' ? 'chromium' : undefined);

const COMPILE_FORMS: ParityForm[] = [
  { name: 'one-line if/else', body: '    if (a < t) a += 3; else b += 5;' },
  {
    name: 'one-line if/else in a binary-search loop',
    body: [
      '    int lo = 0, hi = 20, want = 2 * t + (a & 1);',
      '    while (lo <= hi) {',
      '      int mid = lo + (hi - lo) / 2;',
      '      if (mid == want) { k = mid; break; }',
      '      if (mid < want) lo = mid + 1; else hi = mid - 1;',
      '    }',
    ].join('\n'),
  },
  { name: 'one-line else-if chain', body: '    if (a < 0) k += 1; else if (b < 0) k += 2; else if (t > 1) k += 3; else k += 4;' },
  {
    name: 'Allman braces on if/else and do',
    body: [
      '    if (a < t)',
      '    {',
      '      a += 31;',
      '    }',
      '    else',
      '    {',
      '      b += 32;',
      '    }',
      '    do',
      '    {',
      '      k += 34;',
      '    } while (k < t * 34);',
    ].join('\n'),
  },
  { name: 'dangling else on one line', body: '    if (a > 0) if (b > 0) k += 1; else k += 2;' },
  {
    name: 'dangling else across lines',
    body: ['    if (a > 0)', '      if (b > 0) k += 10;', '      else k += 20;', '    else k += 40;'].join('\n'),
  },
  { name: 'braceless for body under one-line if/else', body: '    if (a < t) for (k = 0; k < 3; k++) b += 2; else b += 50;' },
  { name: 'braceless do-while body under one-line if/else', body: '    if (a < t) do k += 2; while (k < 5); else k -= 3;' },
  { name: 'braceless return bodies', body: '    if (a > t) return 707; else if (b > t) return 808; else k += 1;' },
  { name: 'braced one-line if/else returning in both branches', body: '    if (a > t) { return 909; } else { return 910; }' },
  {
    name: 'braceless break and continue in a one-line braced loop body',
    body: '    while (b < 6) { b += 1; if (b == t + 3) break; else if (b % 2) continue; else k += b; }',
  },
  {
    name: 'braceless if/else as a braceless loop body on the next lines',
    body: ['    while (a < 3)', '      if (a++ == t) break;', '      else continue;', '    k += 1;'].join('\n'),
  },
  {
    name: 'macro-call bodies',
    body: '    if (a < t) BUMP(a); else BUMP(b);\n    if (k == 0) SWAP_DO(a, b); else k += 1;',
  },
  {
    name: 'comments and string literals holding ; else { }',
    body: `    if (a < t) s = "x; else { }"; /* ; } else { */ else s = '}'; // else { ;`,
  },
  {
    name: 'comments holding braces between header, body and else',
    body: [
      '    if (a < t) // pick { the left ;',
      '      a += 11; /* } else { */',
      '    else // else {',
      '      b += 13; // }',
      '    k += 2;',
    ].join('\n'),
  },
  { name: 'character literals holding ; and {', body: "    if (a == t) s += ';'; else s += '{';" },
  { name: 'raw string literal holding ; else { }', body: '    if (a < t) s = R"(; else { })"; else s = "y";' },
  { name: 'one-line do-while (was untraced)', body: '    do k += 1; while (k < t);' },
  { name: 'then-line of if/else with a braced else (was untraced)', body: ['    if (a < t) a += 21; else {', '      b += 22;', '    }'].join('\n') },
  { name: 'two statements and a control statement on one line', body: '    a += 1; if (a > t) b += 51; else b += 52; k += 53;' },
  { name: 'if with an init-statement', body: ['    if (int m = a + b; m > t) {', '      k += m;', '    }'].join('\n') },
  {
    name: 'one-line braceless if, for and while (unchanged forms)',
    body: ['    if (a < t) a += 41;', '    for (k = 0; k < 2; k++) b += 42;', '    while (k < 5) k += 1;'].join('\n'),
  },
];

const SILENT_FORMS: ParityForm[] = [
  {
    name: 'braceless else body on the next line',
    body: ['    if (a > t) {', '      a -= 1;', '    } else', '      b += 7;', '    k += 100;'].join('\n'),
  },
  {
    name: 'braceless then body on the next line, then a braceless else',
    body: ['    if (a < t)', '      a += 3;', '    else', '      b += 5;', '    k += 9;'].join('\n'),
  },
  {
    name: 'braceless if nested in a braceless else',
    body: ['    if (a > 1) k += 1;', '    else', '      if (b > 1) k += 2;', '      else k += 4;', '    k += 8;'].join('\n'),
  },
  {
    name: 'braceless while body under a multi-line if/else',
    body: ['    if (a < t)', '      while (k < 4) k += 1;', '    else', '      k -= 1;'].join('\n'),
  },
  {
    name: 'braceless body after a multi-line condition',
    body: ['    if (a < t &&', '        b < t)', '      k += 5;', '    k += 6;'].join('\n'),
  },
  {
    name: 'Allman braces on an if without else',
    body: ['    if (b > t)', '    {', '      k += 33;', '    }'].join('\n'),
  },
];

const REPRO = [
  '#include <vector>',
  'using namespace std;',
  'class Solution {',
  'public:',
  '  int search(vector<int>& nums, int target) {',
  '    int left = 0, right = (int)nums.size() - 1;',
  '    while (left <= right) {',
  '      int mid = left + (right - left) / 2;',
  '      if (nums[mid] == target) return mid;',
  '      if (nums[mid] < target) left = mid + 1; else right = mid - 1;',
  '    }',
  '    return -1;',
  '  }',
  '};',
].join('\n');
const REPRO_CASES: Array<{ nums: number[]; target: number; expected: number }> = [
  { nums: [-1, 0, 3, 5, 9, 12], target: 9, expected: 4 },
  { nums: [-1, 0, 3, 5, 9, 12], target: 2, expected: -1 },
  { nums: [5], target: 5, expected: 0 },
  { nums: [2, 5], target: 5, expected: 1 },
  { nums: [1, 3, 5, 7, 9, 11, 13], target: 1, expected: 0 },
];

function refusedProgram(prelude: string, body: string): string {
  return formsProgram([{ name: 'refused', body }]).replace('class Solution {', `${prelude}\nclass Solution {`);
}

function formsCases(forms: readonly ParityForm[]) {
  return forms.flatMap((_form, formIndex) =>
    PARITY_INPUTS.map((input, inputIndex) => ({
      id: `form-${formIndex + 1}-input-${inputIndex + 1}`,
      input: { form: formIndex + 1, ...input },
    }))
  );
}

function formsParityProgram(id: string, forms: readonly ParityForm[]): ParityProgram {
  const cases = formsCases(forms);
  return {
    id,
    code: formsProgram(forms),
    functionName: 'solve',
    cases,
    // Every form's first input is recorded; every case runs in the traced build.
    tracedCaseIds: cases.filter((testCase) => testCase.id.endsWith('-input-1')).map((testCase) => testCase.id),
  };
}

const PROGRAMS: ParityProgram[] = [
  formsParityProgram('compile-forms', COMPILE_FORMS),
  formsParityProgram('silent-forms', SILENT_FORMS),
  {
    id: 'repro',
    code: REPRO,
    functionName: 'search',
    cases: REPRO_CASES.map(({ nums, target }, index) => ({ id: `case-${index + 1}`, input: { nums, target } })),
    tracedCaseIds: ['case-1'],
  },
  {
    id: 'refused-multi-statement-macro-body',
    code: refusedProgram('#define TWICE(x) x; x', '    if (a < t) TWICE(k++);'),
    functionName: 'solve',
    cases: formsCases([{ name: 'refused', body: '' }]),
    tracedCaseIds: ['form-1-input-1'],
  },
  {
    id: 'refused-loop-macro-body-on-next-line',
    code: refusedProgram('#define REP(i, n) for (int i = 0; i < (n); i++)', '    REP(i, 3)\n      k += i;'),
    functionName: 'solve',
    cases: formsCases([{ name: 'refused', body: '' }]),
    tracedCaseIds: ['form-1-input-1'],
  },
];

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.wasm': return 'application/wasm';
    default: return 'application/octet-stream';
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
    const candidate = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const filePath = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!existsSync(filePath)) {
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
  if (!address || typeof address === 'string') throw new Error('Server did not bind.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections?.();
    }),
  };
}

function lineOf(source: string, needle: string): number {
  const index = source.indexOf(needle);
  assert.ok(index >= 0, `program has no ${needle}`);
  return source.slice(0, index).split('\n').length;
}

function formName(programId: string, caseId: string): string {
  const forms = programId === 'compile-forms' ? COMPILE_FORMS : programId === 'silent-forms' ? SILENT_FORMS : null;
  const match = /^form-(\d+)-input-(\d+)$/.exec(caseId);
  if (!forms || !match) return caseId;
  const input = PARITY_INPUTS[Number(match[2]) - 1];
  return `${forms[Number(match[1]) - 1]?.name} (a=${input.a}, b=${input.b}, t=${input.t})`;
}

function describeRun(run: ParitySample['traced']): string {
  if (run.error) return `threw ${run.errorName}: ${run.error}`;
  if (run.compileFailure) return `compile failed: ${JSON.stringify(run.compileFailure).slice(0, 400)}`;
  return `status ${run.status}`;
}

function checkParity(sample: ParitySample, program: ParityProgram): string[] {
  const problems: string[] = [];
  if (sample.untraced.error || sample.untraced.compileFailure || sample.untraced.cases.length !== program.cases.length) {
    return [`untraced evaluation: ${describeRun(sample.untraced)}`];
  }
  if (sample.traced.error || sample.traced.compileFailure || sample.traced.cases.length !== program.cases.length) {
    return [`traced Run: ${describeRun(sample.traced)}`];
  }
  for (const testCase of program.cases) {
    const untraced = sample.untraced.cases.find((entry) => entry.id === testCase.id);
    const traced = sample.traced.cases.find((entry) => entry.id === testCase.id);
    const label = formName(program.id, testCase.id);
    if (untraced?.status !== 'completed') {
      problems.push(`${label}: untraced ${untraced?.status} ${JSON.stringify(untraced?.failure ?? '')}`);
      continue;
    }
    if (traced?.status !== 'completed') {
      problems.push(`${label}: traced ${traced?.status} ${JSON.stringify(traced?.failure ?? '')}`);
      continue;
    }
    if (JSON.stringify(traced.value) !== JSON.stringify(untraced.value)) {
      problems.push(`${label}: traced ${JSON.stringify(traced.value)}, untraced ${JSON.stringify(untraced.value)}`);
    }
    if (program.tracedCaseIds.includes(testCase.id) && !traced.tracedLines?.length) {
      problems.push(`${label}: the traced case has no trace`);
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const root = resolve('.');
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-cpp-trace-parity-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await runCommand('pnpm', ['exec', 'tsx', 'src/cli.ts', 'sync-assets', join(tempRoot, 'workers'), '--languages', 'cpp'], root);
    await build({
      absWorkingDir: root,
      entryPoints: [join(root, 'tests/fixtures/cpp-trace-parity-entry.ts')],
      outfile: join(tempRoot, 'entry.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      alias: {
        zlib: join(root, 'packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': join(root, 'packages/tracekernel/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n', 'utf8');
    server = await startServer(resolve(tempRoot));
    const browser = await chromium.launch({
      headless: true,
      ...(BROWSER_CHANNEL ? { channel: BROWSER_CHANNEL } : {}),
    });
    let samples: ParitySample[];
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(20 * 60_000);
      page.on('pageerror', (error) => console.error(`[pageerror] ${error.message}`));
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
      const crashed = new Promise<never>((_, reject) => {
        page.once('crash', () => reject(new Error('the page crashed')));
      });
      crashed.catch(() => undefined);
      samples = (await Promise.race([crashed, page.evaluate(async (options) => {
        const moduleUrl: string = '/entry.mjs';
        const module = await import(moduleUrl);
        return module.runParity(options);
      }, { assetBaseUrl: '/workers', programs: PROGRAMS })])) as ParitySample[];
    } finally {
      await browser.close();
    }

    const failures: string[] = [];
    for (const program of PROGRAMS) {
      const sample = samples.find((entry) => entry.id === program.id);
      assert.ok(sample, `no result for ${program.id}`);
      if (program.id.startsWith('refused-')) {
        // The untraced evaluation runs it; the traced Run is refused as the
        // provider's failure with the reason, never as the learner's.
        const problems: string[] = [];
        const untracedOk = !sample.untraced.error && sample.untraced.cases.length === program.cases.length &&
          sample.untraced.cases.every((testCase) => testCase.status === 'completed');
        if (!untracedOk) problems.push(`untraced evaluation: ${describeRun(sample.untraced)}`);
        const traced = sample.traced;
        const refusalText = /C\+\+ tracing cannot instrument this program without changing its behavior/;
        const reported = traced.error ??
          JSON.stringify(traced.compileFailure ?? traced.cases.map((testCase) => testCase.failure ?? testCase.status));
        if (!refusalText.test(reported)) problems.push(`traced Run was not refused: ${describeRun(traced)} ${reported.slice(0, 400)}`);
        if (/"origin":"program"/.test(reported)) problems.push(`the refusal was reported as the learner's failure: ${reported.slice(0, 400)}`);
        console.log(`${problems.length ? 'FAIL' : 'ok  '} ${program.id}: traced ${describeRun(traced)}${traced.error ? '' : ` ${reported.slice(0, 200)}`}`);
        failures.push(...problems.map((problem) => `${program.id}: ${problem}`));
        continue;
      }
      const problems = checkParity(sample, program);
      if (program.id === 'repro' && !problems.length) {
        REPRO_CASES.forEach((testCase, index) => {
          const value = sample.traced.cases.find((entry) => entry.id === `case-${index + 1}`)?.value;
          if (value !== testCase.expected) problems.push(`repro case ${index + 1}: traced ${JSON.stringify(value)}, expected ${testCase.expected}`);
        });
      }
      if (program.id === 'silent-forms' && !problems.length) {
        // The then-body on its own line is traced now (it ran untraced before).
        const thenLine = lineOf(program.code, '      a += 3;');
        const traced = sample.traced.cases.find((entry) => entry.id === 'form-2-input-1');
        if (!traced?.tracedLines?.includes(thenLine)) {
          problems.push(`braceless then body on line ${thenLine} has no trace events: ${JSON.stringify(traced?.tracedLines)}`);
        }
      }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${program.id}: ${program.cases.length} cases traced and untraced`);
      for (const problem of problems) console.log(`       ${problem}`);
      failures.push(...problems.map((problem) => `${program.id}: ${problem}`));
    }
    assert.deepEqual(failures, [], `traced and untraced C++ differ:\n${failures.join('\n')}`);
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('Traced and untraced C++ compute the same answers for every control-body form', main);

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const extensions = { python: 'py', javascript: 'js', typescript: 'ts', java: 'java', cpp: 'cpp', csharp: 'cs' };
const languages = [...new Set((process.argv[2] ?? Object.keys(extensions).join(',')).split(','))];
for (const language of languages) {
  if (!Object.hasOwn(extensions, language)) throw new Error(`Unknown language ${language}`);
}

const cppFaultProbeIds = ['cpp-deleted-node', 'cpp-wasm-trap', 'cpp-trace-compile', 'cpp-trace-wrong'];
const referenceIds = [
  'best-time-to-buy-and-sell-stock', 'binary-search', 'climbing-stairs', 'contains-duplicate',
  'maximum-subarray', 'merge-intervals', 'min-cost-climbing-stairs', 'product-of-array-except-self',
  'two-sum', 'valid-parentheses',
];
const fixtureOnly = process.env.TRACECODE_HOST_HISTORY_FIXTURE_ONLY === '1';
const dataRoot = resolve(process.env.TRACECODE_HOST_HISTORY_APP_DATA ?? '/root/ci/parity-app-data');
const reportPath = resolve(process.env.TRACECODE_HOST_HISTORY_REPORT ?? 'untraced-host-history-report.json');
const report = { fixtureOnly, languages: {}, fallback: {} };
let saveTail = Promise.resolve();
function save() {
  const content = JSON.stringify(report, null, 2) + '\n';
  saveTail = saveTail.then(() => writeFile(reportPath, content));
  return saveTail;
}

async function references(language) {
  return Promise.all(referenceIds.map(async (id) => {
    const problem = JSON.parse(await readFile(join(dataRoot, 'problems', id + '.json'), 'utf8'));
    const code = language === 'python' ? problem.solutionCode : await readFile(
      join(dataRoot, 'reference-solutions', language, 'practice', id + '.' + extensions[language]),
      'utf8',
    );
    const executionStyle = /^\s*\* executionStyle: ([\w-]+)$/mu.exec(code)?.[1]
      ?? (language === 'python' || /\b(?:class|struct)\s+Solution\b/u.test(code) ? 'solution-method' : undefined);
    if (!executionStyle || !code || problem.testCases.length < 2) {
      throw new Error(`Missing practice code, style, or case data for ${language}/${id}`);
    }
    const comparison = { schema: 'tracecode.judge.comparator.v1', mode: problem.compareMode ?? 'exact' };
    return {
      id, code, executionStyle, functionName: problem.functionName,
      comparison: { ...comparison, ...(problem.customValidator ? { customValidator: problem.customValidator } : {}) },
      cases: problem.testCases.slice(0, 2).map(({ id: caseId, input, expected, customValidator }) => ({
        id: caseId, input, expected, ...(customValidator ? { comparator: { ...comparison, customValidator } } : {}),
      })),
      expectedStatus: 'passed',
    };
  }));
}

const contentTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm',
};

async function serve(root) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const file = resolve(root, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + sep)) return res.writeHead(403).end();
      const info = await stat(file);
      if (!info.isFile()) return res.writeHead(404).end();
      res.writeHead(200, {
        'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': file.includes('/workers/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((success, fail) => server.listen(0, '127.0.0.1', success).once('error', fail));
  return { server, url: `http://127.0.0.1:${server.address().port}/index.html` };
}

async function call(page, method, ...args) {
  let timeout;
  try {
    return await Promise.race([
      page.evaluate(async ({ method, args }) => {
        const site = await import('/host-history.mjs');
        return site[method](...args);
      }, { method, args }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Browser call timed out: ${method} ${args[0] ?? ''}`)), 150_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function comparableObject(value) {
  return value !== null && typeof value === 'object';
}

function differences(before, after, at = []) {
  if (isDeepStrictEqual(before, after)) return [];
  if (comparableObject(before) && comparableObject(after) &&
      Array.isArray(before) === Array.isArray(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) => differences(before[key], after[key], [...at, key]));
  }
  return [{ path: at.join('.'), before: before === undefined ? { absent: true } : before,
    after: after === undefined ? { absent: true } : after }];
}

function comparableObservation(language, result) {
  if (language !== 'java' || result.status !== 'compile-failed' || !result.compile?.stdout) return result;
  const stdout = result.compile.stdout.replace(/^Exports[0-9a-f]{32}(?=\.java:\d+:\d+:)/gmu, 'Exports<generated>');
  return { ...result, compile: { ...result.compile, stdout } };
}

function matchesExpected(result, expected) {
  if (expected === 'compile-failed') return result.status === expected;
  if (!result.cases?.length) return false;
  if (expected === 'runtime-error') return result.cases.every((item) => item.status === expected);
  return result.cases.every((item) => item.verdict.kind === expected);
}

function validateMidBatch(result, sample, id, name, observed) {
  const [first, runaway, third, fourth] = observed.cases ?? [];
  const problems = [];
  if (observed.cases?.length !== 4) problems.push('expected four case results');
  if (sample.freshSingle.cases?.length !== 1 || sample.freshSingle.cases[0].verdict.kind !== 'passed' ||
      !isDeepStrictEqual(first, sample.freshSingle.cases[0])) {
    problems.push('case 1 differs from a passing fresh single-case run');
  }
  if (runaway?.failure?.origin !== 'limit' || runaway.verdict.kind === 'passed') {
    problems.push('case 2 did not produce a limit');
  }
  if (third?.status !== 'not-run' || fourth?.status !== 'not-run' ||
      third.notRun?.stoppedByCaseId !== runaway?.caseId || fourth.notRun?.stoppedByCaseId !== runaway?.caseId) {
    problems.push('cases 3 and 4 were not skipped because of case 2');
  }
  if (problems.length) result.contractFailures.push({ id, name, problems });
}

function timedSample(sample) {
  return { ...sample, hostLoadAverage: loadavg(), hostLogicalCpuCount: availableParallelism() };
}

function latencyStats(samples) {
  const values = samples.map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b);
  if (!values.length) return null;
  return { count: values.length, minMs: values[0], medianMs: values[Math.floor(values.length / 2)], maxMs: values.at(-1) };
}

async function runLanguage(browser, url, language, result) {
  const page = await browser.newPage();
  try {
    await page.goto(url);
    const programs = await call(page, 'setup', language, fixtureOnly ? [] : await references(language));
    result.programs = Object.fromEntries(programs.map(({ id }) => [id, { histories: [] }]));

    // Run both fresh-host baselines for every program before any history.
    for (const { id, expectedStatus, checkMidBatch } of programs) {
      const sample = result.programs[id];
      sample.baseline = await call(page, 'untraced', id, 'fresh');
      sample.secondBaseline = await call(page, 'untraced', id, 'fresh');
      if (checkMidBatch) {
        sample.freshSingle = await call(page, 'untraced', id, 'fresh', true);
        validateMidBatch(result, sample, id, 'baseline-1', sample.baseline);
        validateMidBatch(result, sample, id, 'baseline-2', sample.secondBaseline);
      }
      const before = comparableObservation(language, sample.baseline);
      const second = comparableObservation(language, sample.secondBaseline);
      if (!isDeepStrictEqual(sample.baseline, before) || !isDeepStrictEqual(sample.secondBaseline, second)) {
        result.normalizations.push({ name: 'java-generated-export-class', program: id, history: 'fresh-baselines' });
      }
      sample.baselineDifferences = differences(before, second);
      // Record both original values. Only mask a diagnostic message proven
      // unstable at that exact field on two independent fresh hosts.
      sample.excludedFields = sample.baselineDifferences
        .map(({ path }) => path).filter((path) => path.endsWith('.failure.message'));
      if (sample.baseline.status === 'host-rejected' || sample.secondBaseline.status === 'host-rejected' ||
          sample.baselineDifferences.some(({ path }) => !sample.excludedFields.includes(path))) {
        result.coverageGaps.push(`${id}: no stable fresh-host baseline`);
      }
      if (expectedStatus && ![sample.baseline, sample.secondBaseline].every((value) =>
        matchesExpected(value, expectedStatus))) {
        result.coverageGaps.push(`${id}: fresh-host baseline did not reach ${expectedStatus}`);
      }
    }
    await save();

    async function compare(id, name, target = 'shared', observed) {
      const sample = result.programs[id];
      const after = observed ?? await call(page, 'untraced', id, target);
      if (sample.freshSingle) validateMidBatch(result, sample, id, name, after);
      const comparableAfter = comparableObservation(language, after);
      if (!isDeepStrictEqual(after, comparableAfter)) {
        result.normalizations.push({ name: 'java-generated-export-class', program: id, history: name });
      }
      const delta = differences(comparableObservation(language, sample.baseline), comparableAfter)
        .filter(({ path }) => !sample.excludedFields.includes(path));
      result.comparisons += 1;
      sample.histories.push({ name, after, differences: delta });
      if (delta.length) {
        result.differences += 1;
        console.log(`DIFF ${language}/${id}/${name} ${delta[0].path}`);
      }
    }

    async function runAbortHistories() {
      const baseline = await call(page, 'evaluateFresh');
      const secondBaseline = await call(page, 'evaluateFresh');
      result.abort = { baseline, secondBaseline, warmIdle: [], afterAbort: { evaluate: [], interactive: [] } };
      const stats = result.abort;
      const unstable = differences(baseline.observed, secondBaseline.observed);
      if (unstable.length || !matchesExpected(baseline.observed, 'passed')) {
        result.coverageGaps.push('abort: no stable fresh evaluateAlgorithm baseline');
      }

      async function one(shape, point, firstRequest) {
        const trial = timedSample(await call(page, 'abortTrial', shape, point, firstRequest));
        const name = `abort/${shape}/${point}/${firstRequest ? 'first-request' : 'warm'}`;
        result.histories[name] = trial;
        if (!trial.witnessed || !trial.after) {
          result.coverageGaps.push(`${name}: the intended in-flight abort was not observed`);
        }
        if (trial.after) {
          const delta = differences(baseline.observed, trial.after.observed);
          result.comparisons += 1;
          result.programs.correct.histories.push({ name, after: trial.after.observed, differences: delta });
          if (delta.length) {
            result.differences += 1;
            console.log(`DIFF ${language}/correct/${name} ${delta[0].path}`);
          }
        }
        for (const [id, observed] of Object.entries(trial.firstHostBatches)) {
          await compare(id, name, 'shared', observed);
        }
        return trial;
      }

      for (const shape of ['evaluate', 'interactive']) {
        for (const point of ['prepare', 'execute', 'reply']) {
          await one(shape, point, true);
          await one(shape, point, false);
          for (const { id, checkMidBatch } of programs) {
            if (checkMidBatch) await compare(id, `abort/${shape}/${point}/warm`);
          }
        }
      }

      // Interleave the two abort shapes and the warm-idle control to reduce
      // sensitivity to shifts in shared host load during one language's run.
      for (let i = 0; i < 5; i += 1) {
        await call(page, 'measureIdleVerdict');
        stats.warmIdle.push(timedSample(await call(page, 'measureIdleVerdict')));
        for (const shape of ['evaluate', 'interactive']) {
          const trial = timedSample(await call(page, 'abortTrial', shape, 'execute', false));
          stats.afterAbort[shape].push(trial);
        }
      }
      stats.summary = {
        warmIdle: latencyStats(stats.warmIdle.filter(({ observed }) => isDeepStrictEqual(baseline.observed, observed))),
        ...Object.fromEntries(Object.entries(stats.afterAbort).map(([shape, samples]) => [shape,
          latencyStats(samples.filter(({ witnessed, after }) =>
            witnessed && after && isDeepStrictEqual(baseline.observed, after.observed)).map(({ after }) => after)),
        ])),
      };
      if (Object.values(stats.summary).some((summary) => summary?.count !== 5)) {
        result.coverageGaps.push('abort latency: fewer than five valid samples in at least one condition');
      }
      console.log(`ABORT LATENCY ${language} ${JSON.stringify(stats.summary)}`);
      await save();
    }

    async function runCppFaultHistories() {
      const abortedBaseline = result.abort.baseline.observed;
      let trapObserved = false;
      for (const id of cppFaultProbeIds) {
        const name = `cpp-fault/${id}`;
        const evidence = await call(page, 'history', 'all', id);
        result.histories[name] = evidence;
        const fault = evidence.result?.cases?.find(({ failure }) =>
          failure?.origin === 'program' && /out of bounds|memory access/i.test(failure.message));
        if (id === 'cpp-deleted-node' || id === 'cpp-wasm-trap') trapObserved ||= Boolean(fault);
        if (id === 'cpp-trace-compile' && (evidence.result?.status !== 'compile-failed' ||
            evidence.result.compileFailure?.origin !== 'program')) {
          result.coverageGaps.push(`${name}: no traced-only learner compile failure observed`);
        }
        if (id === 'cpp-trace-wrong' && (!evidence.result?.cases?.some(({ verdict }) => verdict === 'failed') ||
            !matchesExpected(result.programs[id].baseline, 'passed'))) {
          result.coverageGaps.push(`${name}: no traced-only wrong verdict observed`);
        }
        for (const program of programs) {
          if (program.id === id || program.id === 'correct' || program.checkMidBatch) await compare(program.id, name);
        }

        const point = id === 'cpp-trace-compile' ? 'prepare' : 'reply';
        for (const shape of ['evaluate', 'interactive']) {
          const abortName = `${name}/abort/${shape}/${point}`;
          const trial = timedSample(await call(page, 'abortTrial', shape, point, false, id));
          result.histories[abortName] = trial;
          if (!trial.witnessed || !trial.after) {
            result.coverageGaps.push(`${abortName}: the intended in-flight abort was not observed`);
          }
          if (trial.after) {
            const delta = differences(abortedBaseline, trial.after.observed);
            result.comparisons += 1;
            result.programs.correct.histories.push({ name: abortName, after: trial.after.observed, differences: delta });
            if (delta.length) result.differences += 1;
          }
          for (const program of programs) {
            if (program.id === id || program.checkMidBatch) await compare(program.id, abortName);
          }
        }
        await save();
      }
      if (!trapObserved) result.coverageGaps.push('cpp-fault: no traced Wasm out-of-bounds trap observed');
    }

    const profiles = process.env.TRACECODE_HOST_HISTORY_PROFILE ?? 'both';
    if (!['desktop', 'both'].includes(profiles)) throw new Error(`Unknown host history profile ${profiles}`);
    for (const [flavor, target, group] of [
      ['practice', 'shared', programs],
      ...(profiles === 'both' ? [['ios', 'ios', programs.filter(({ id }) => !referenceIds.includes(id))]] : []),
    ]) {
      function historyName(name) {
        return flavor === 'practice' ? name : `ios/${name}`;
      }

      // A one-case Trace Mode drawing is this host's first request.
      const first = historyName('first-drawing');
      result.histories[first] = await call(page, 'history', 'first-drawing', undefined, flavor);
      if (!result.histories[first].witnessed) result.coverageGaps.push(`${first}: healthy trace not observed`);
      for (const { id } of group) await compare(id, first, target);
      await save();
      if (flavor === 'practice') {
        await runAbortHistories();
        if (language === 'cpp') await runCppFaultHistories();
      }

      for (const kind of ['interactive', 'all']) {
        for (const { id, expectedStatus } of group) {
          const name = historyName(`${kind}/${id}`);
          const evidence = await call(page, 'history', kind, id, flavor);
          result.histories[name] = evidence;
          if (evidence.excluded) result.exclusions.push({ history: name, reason: evidence.excluded });
          const terminal = evidence.terminalCompile ||
            (evidence.result?.status === 'compile-failed' && evidence.result.compileFailure?.origin === 'program' &&
              evidence.result.cases.length === 0);
          if (!evidence.witnessed && !(expectedStatus === 'compile-failed' && terminal)) {
            result.coverageGaps.push(`${name}: required trace/continuation or terminal compile failure not observed`);
          }
          await compare(id, name, target);
        }
        await save();
      }

      for (const kind of ['trace-limit', 'runaway', 'compile-failure', 'refused', 'disposed', 'abandoned']) {
        const name = historyName(kind);
        const evidence = await call(page, 'history', kind, undefined, flavor);
        result.histories[name] = evidence;
        if (!evidence.witnessed) result.coverageGaps.push(`${name}: intended history not observed`);
        for (const { id } of group) await compare(id, name, target);
        if (kind === 'abandoned' && evidence.witnessed) {
          evidence.finalCheck = await call(page, 'abandonCheck', flavor);
          if (!evidence.finalCheck.witnessed) result.coverageGaps.push(`${name}: retained drawing or cleanup not witnessed`);
        }
        await save();
      }

      if (language === 'python') {
        for (const [kind, observer] of [
          ['module-mutation', 'module-state'], ['changed-recursion-limit', 'interpreter-guards'],
        ]) {
          const name = historyName(kind);
          const evidence = await call(page, 'history', kind, undefined, flavor);
          result.histories[name] = evidence;
          if (!evidence.witnessed) result.coverageGaps.push(`${name}: mutation did not complete`);
          await compare(observer, name, target);
        }
      }
    }
    const expected = language === 'typescript' || language === 'javascript'
      ? (profiles === 'both' ? 330 : 222) - (fixtureOnly ? 90 : 0) : undefined;
    if (expected !== undefined && result.comparisons !== expected) {
      result.coverageGaps.push(`expected ${expected} comparisons, got ${result.comparisons}`);
    }
    await call(page, 'close');
  } finally {
    await page.close();
  }
}

async function memorySamples(cdp) {
  if (process.platform !== 'linux') return { unavailable: 'Linux /proc is required for PSS' };
  const samplesKiB = [];
  for (let i = 0; i < 3; i += 1) {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const proportionalSetSizes = await Promise.all(processInfo.map(async ({ id }) => {
      const data = await readFile(`/proc/${id}/smaps_rollup`, 'utf8');
      const sample = /^Pss:\s+(\d+) kB$/mu.exec(data);
      if (!sample) throw new Error(`No PSS reading for Chromium PID ${id}`);
      return Number(sample[1]);
    }));
    samplesKiB.push(proportionalSetSizes.reduce((sum, size) => sum + size, 0));
    if (i < 2) await new Promise((done) => setTimeout(done, 200));
  }
  return { samplesKiB, medianKiB: [...samplesKiB].sort((a, b) => a - b)[1] };
}

async function benchmark(url, language, warm) {
  // Independent browser per sample. PSS measures Chromium's renderer
  // (including dedicated workers), browser, GPU/utility processes together.
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    const cdp = await browser.newBrowserCDPSession();
    await call(page, 'openDrawingHost', language);
    await new Promise((done) => setTimeout(done, 750));
    const idleBefore = await memorySamples(cdp).catch((error) => ({ unavailable: error.message }));
    const timings = await call(page, 'measureSecondHost', language, warm);
    await new Promise((done) => setTimeout(done, 750));
    const idleAfter = await memorySamples(cdp).catch((error) => ({ unavailable: error.message }));
    await call(page, 'closeMeasurement');
    return {
      ...timings, idleBefore, idleAfter,
      ...(idleBefore.medianKiB !== undefined && idleAfter.medianKiB !== undefined
        ? { addedIdleMiB: (idleAfter.medianKiB - idleBefore.medianKiB) / 1024 } : {}),
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (commit.status !== 0) throw new Error('Could not determine Harness source commit');
  report.harnessHead = commit.stdout.trim();
  report.runnerSha256 = createHash('sha256')
    .update(await readFile('scripts/check-untraced-host-history.mjs'))
    .update(await readFile('scripts/untraced-host-history.browser.ts')).digest('hex');
  const root = await mkdtemp(join(tmpdir(), 'tracecode-host-history-'));
  let server;
  let browser;
  try {
    const sync = spawnSync('corepack', [
      'pnpm', 'exec', 'tsx', '--tsconfig', 'tsconfig.base.json', 'src/cli.ts', 'sync-assets', join(root, 'workers'),
      '--languages', languages.join(','),
    ], { stdio: 'inherit' });
    if (sync.status !== 0) throw new Error(`sync-assets failed (${String(sync.status)}): ${sync.error ?? ''}`);
    await build({
      entryPoints: ['scripts/untraced-host-history.browser.ts'],
      tsconfig: resolve('tsconfig.base.json'),
      outfile: join(root, 'host-history.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      alias: {
        zlib: resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    await writeFile(join(root, 'index.html'), '<!doctype html><meta charset="utf-8">');
    const site = await serve(root);
    server = site.server;
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    report.browser = browser.version();
    const concurrency = Number(process.env.TRACECODE_HOST_HISTORY_WORKERS ?? 4);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
      throw new Error('Set TRACECODE_HOST_HISTORY_WORKERS to an integer from 1 to 4.');
    }
    async function runNext() {
      const language = pending.shift();
      if (!language) return;
      const result = {
        comparisons: 0, differences: 0, coverageGaps: [], contractFailures: [], histories: {},
        normalizations: [], exclusions: [],
      };
      report.languages[language] = result;
      await runLanguage(browser, site.url, language, result).catch((error) => {
        result.coverageGaps.push(error.message);
      });
      result.verdict = result.differences ? 'VIOLATED' : result.coverageGaps.length || result.contractFailures.length ? 'UNPROVEN' : 'PROVEN';
      console.log(`${language}: ${result.verdict}, ${Object.keys(result.programs ?? {}).length} programs, ${result.comparisons} comparisons, ${result.differences} differences`);
      for (const gap of result.coverageGaps) console.error(`GAP ${language}: ${gap}`);
      for (const failure of result.contractFailures) console.error(`BATCH ${language}/${failure.id}/${failure.name}: ${failure.problems.join(', ')}`);
      for (const { history, reason } of result.exclusions) console.log(`OUT OF SCOPE ${language}/${history}: ${reason}`);
      if (result.normalizations.length) {
        console.log(`NORMALIZED ${language}: java-generated-export-class in ${result.normalizations.length} rows`);
      }
      await save();
      await runNext();
    }
    const pending = [...languages];
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, runNext));
    await browser.close();
    browser = undefined;
    for (const language of ['javascript', 'typescript'].filter((item) => languages.includes(item))) {
      report.fallback[language] = [];
      for (const warm of [false, true]) {
        const sample = await benchmark(site.url, language, warm).catch((error) => ({ warm, error: error.message }));
        report.fallback[language].push(sample);
        console.log(`SECOND HOST ${language} ${JSON.stringify(sample)}`);
        await save();
      }
    }
    if (Object.values(report.languages).some(({ verdict, contractFailures }) => verdict !== 'PROVEN' || contractFailures.length)) process.exitCode = 1;
  } finally {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    await rm(root, { recursive: true, force: true });
  }
}

await main();

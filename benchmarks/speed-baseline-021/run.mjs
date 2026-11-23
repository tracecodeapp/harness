import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { availableParallelism, hostname, loadavg, release } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const [outArg, mode, sampleArg = '20', seedArg = '0212026', minuteArg = '720'] = process.argv.slice(2);
const out = resolve(outArg);
const target = mode === 'smoke' ? 1 : Number(sampleArg);
const seed = Number(seedArg);
const runMinutes = Number(minuteArg);
assert.ok(Number.isInteger(target) && (mode === 'smoke' || target >= 20));
assert.ok(Number.isSafeInteger(seed) && Number.isFinite(runMinutes) && runMinutes > 0);

const languages = { python: 'py', javascript: 'js', typescript: 'ts', java: 'java', cpp: 'cpp', csharp: 'cs' };
const problemIds = ['binary-search', 'permutations'];
const appRefs = {
  '0.17.1': '083bf3f4aec34a353dd6da749d691ca29ed601e8',
  '0.20.1': 'd0debe20a21885e701731d5e10f5741390b1ddd0',
};
const versions = Object.keys(appRefs);
const corpus = process.env.SPEED_CORPUS ?? '/root/ci/parity-app-data';
const filePrefix = mode === 'smoke' ? 'smoke-' : 'speed-';
const metadataPath = join(out, filePrefix + 'metadata.json');
const samplesPath = join(out, filePrefix + 'samples.jsonl');
const deadline = Date.now() + runMinutes * 60_000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const now = () => new Date().toISOString();
const pressure = () => ({ at: now(), oneMinute: loadavg()[0] });

function random(seedValue) {
  let state = seedValue >>> 0;
  return () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const randomOrder = random(seed);
function shuffled(items) {
  const order = [...items];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(randomOrder() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

async function loadFixtures() {
  const data = {};
  const provenance = {};
  for (const id of problemIds) {
    const problemFile = 'problems/' + id + '.json';
    const problemBytes = await readFile(join(corpus, problemFile));
    const problem = JSON.parse(problemBytes);
    assert.equal(problem.id, id);
    assert.equal(problem.testCases.length, id === 'binary-search' ? 10 : 12);
    const backtracking = problem.patterns.includes('backtracking');
    const comparison = {
      schema: 'tracecode.judge.comparator.v1',
      mode: problem.compareMode ?? 'exact',
      ...(problem.customValidator && { customValidator: problem.customValidator }),
    };
    const cases = problem.testCases.map(({ id, input, expected, customValidator }, i) => ({
      id: id ?? 'case-' + (i + 1), input, expected,
      ...(customValidator && { comparator: { ...comparison, customValidator } }),
    }));
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
    assert.ok(cases.every((c) => c.expected !== undefined));
    data[id] = {};
    provenance[id] = { problemFile, problemSha256: sha256(problemBytes), caseCount: cases.length, fixture: {} };
    for (const [language, extension] of Object.entries(languages)) {
      const sourceFile = language === 'python' ? problemFile :
        'reference-solutions/' + language + '/practice/' + id + '.' + extension;
      const source = language === 'python' ? Buffer.from(problem.solutionCode) : await readFile(join(corpus, sourceFile));
      const fixture = {
        id,
        language,
        code: source.toString('utf8'),
        functionName: problem.functionName,
        executionStyle: problem.executionStyle ?? 'function',
        comparison,
        traceBudget: {
          maxTraceSteps: 4_000,
          maxLineEvents: backtracking ? 20_000 : 12_000,
          maxSingleLineHits: backtracking ? 4_000 : 1_000,
          maxStoredEvents: 16_000,
        },
        cases,
      };
      data[id][language] = fixture;
      provenance[id].fixture[language] = {
        sourceFile, codeSha256: sha256(source), fixtureSha256: sha256(JSON.stringify(fixture)),
        traceBudget: fixture.traceBudget,
      };
    }
  }
  return { data, provenance };
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

async function serve(site) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const file = resolve(site, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    const stat = file.startsWith(site + sep) && statSync(file, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) return response.writeHead(404).end();
    response.writeHead(200, {
      'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=3600',
    });
    const stream = createReadStream(file);
    response.on('close', () => stream.destroy());
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  });
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}

async function prepareVersion(version) {
  const root = join(out, 'v' + version);
  const harness = join(root, 'package');
  const site = join(root, 'site');
  const manifest = await json(join(harness, 'package.json'));
  assert.equal(manifest.version, version);
  const tarball = 'tracecode-harness-' + version + '.tgz';
  const dependencyFile = join(root, 'dependencies.json');
  await build({
    entryPoints: ['benchmarks/speed-baseline-021/entry.ts'],
    outfile: join(site, 'entry.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    alias: {
      'tracecode-harness-under-test/judge': join(harness, 'dist', 'judge.js'),
      'tracecode-harness-under-test/tracekernel': join(harness, 'dist', 'tracekernel.js'),
      zlib: join(harness, 'dist', 'zlib-browser-shim.js'),
      'node:zlib': join(harness, 'dist', 'zlib-browser-shim.js'),
    },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  await writeFile(join(site, 'index.html'), '<!doctype html><meta charset="utf-8">');
  const metadata = {
    appRef: appRefs[version], tarball, sha256: sha256(await readFile(join(root, tarball))),
    dependenciesSha256: sha256(await readFile(dependencyFile)),
    dependencies: await json(dependencyFile),
  };
  return { metadata, ...await serve(site) };
}

async function bounded(operation, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' exceeded 240 seconds')), 240_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function openPage(context, version, url, group) {
  const page = await context.newPage();
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: group.cpu });
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(async ({ language, stopSubmit }) => {
      const { createSession } = await import('/entry.mjs');
      window.bench = createSession(language, stopSubmit);
    }, { language: group.language, stopSubmit: version === '0.20.1' });
    return page;
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

function initial(page, fixture, journey, cold) {
  return bounded(page.evaluate(({ fixture, journey, cold }) => window.bench.initial(fixture, journey, cold),
    { fixture, journey, cold }), 'Initial ' + journey);
}

function second(page, caseId) {
  return bounded(page.evaluate((id) => window.bench.second(id), caseId), 'Second case');
}

function refusal(result) {
  if (!result) return;
  const { evaluation } = result;
  const issues = [
    result.error, result.warm?.error, evaluation?.compileFailure,
    ...(evaluation?.cases ?? []).flatMap((c) => [c.failure, c.traceUnavailable]),
  ];
  const match = issues.find((issue) => issue && /refus|trace.unavailable|unauthoriz|not authorized|login|sign in|access denied/i.test(JSON.stringify(issue)));
  if (match) return typeof match === 'string' ? match : match.message ?? JSON.stringify(match);
}

function outcome(result, expectedIds) {
  const { evaluation } = result;
  if (result.error || !evaluation) return result.error?.message ?? 'No evaluation';
  if (result.warm?.error || result.warm?.success === false) return result.warm.error?.message ?? 'Warmup failed';
  if (evaluation.status !== 'completed') return evaluation.compileFailure?.message ?? evaluation.status;
  const ids = evaluation.cases.map((c) => c.id);
  if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) return 'Unexpected case IDs: ' + ids.join(', ');
  const failure = evaluation.cases.find((c) => c.status !== 'completed' || c.verdict !== 'passed');
  if (failure) return failure.failure?.message ?? (failure.id + ' ' + failure.status + '/' + failure.verdict);
}

function plan() {
  const groups = [];
  for (const language of Object.keys(languages)) {
    for (const cpu of [1, 4]) {
      for (const problem of problemIds) {
        for (const state of ['warm', 'cold', 'switched']) {
          for (const journey of ['run', 'submit']) groups.push({ language, cpu, problem, state, journey, versions });
        }
      }
      groups.push({ language, cpu, problem: 'binary-search', state: 'warm', journey: 'lesson', versions: ['0.20.1'] });
    }
  }
  if (mode !== 'smoke') return shuffled(groups);
  return groups.filter(({ cpu, problem, journey, state, language }) =>
    (cpu === 1 && problem === 'binary-search' && state === 'cold' && journey === 'run') ||
    (language === 'javascript' && cpu === 4 && problem === 'permutations') ||
    (language === 'javascript' && cpu === 4 && journey === 'lesson') ||
    (language === 'java' && cpu === 4 && problem === 'permutations' && state === 'switched'));
}

function checkDeadline() {
  if (Date.now() >= deadline) throw new Error('Host window elapsed');
}

async function waitForQuiet() {
  checkDeadline();
  if (mode === 'smoke') return;
  while (loadavg()[0] > 2) {
    checkDeadline();
    await delay(5_000);
  }
}

function addressedBySample(sample) {
  if (sample.journey === 'run') return {
    verdicts: sample.initial?.elapsedMs,
    firstTrace: sample.initial?.firstTraceMs,
    secondTrace: sample.second?.elapsedMs,
  };
  return { [sample.journey === 'lesson' ? 'lessonContinue' : 'submitVerdicts']: sample.initial?.elapsedMs };
}

const prepared = {};
let browser;
const schedule = plan();
const report = {
  schema: 'tracecode.speed-baseline.v1',
  mode, target, seed, start: now(), runMinutes, loadThreshold: 2, appRefs, schedule,
  host: { hostname: hostname(), logicalCpus: availableParallelism(), kernel: release() },
  browser: { channel: 'chromium', crossOriginIsolated: false },
  packages: {},
  complete: false,
};
const save = () => writeFile(metadataPath, JSON.stringify(report, null, 2) + '\n');

try {
  await writeFile(samplesPath, '', { flag: 'wx' });
  const fixtures = await loadFixtures();
  report.fixtures = fixtures.provenance;
  for (const version of versions) {
    prepared[version] = await prepareVersion(version);
    report.packages[version] = prepared[version].metadata;
  }
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  report.browser.version = browser.version();
  await save();
  const contexts = Object.fromEntries(await Promise.all(versions.map(async (version) =>
    [version, await browser.newContext()])));
  let complete = true;
  for (const [groupIndex, group] of schedule.entries()) {
    const fixture = fixtures.data[group.problem][group.language];
    const otherProblem = problemIds.find((id) => id !== group.problem);
    const otherFixture = fixtures.data[otherProblem][group.language];
    const counts = Object.fromEntries(group.versions.map((version) => [version, { kept: 0, invalid: 0 }]));
    const warmPages = new Map();
    const groupStarted = Date.now();
    try {
      for (let round = 1; group.versions.some((v) => counts[v].kept < target && counts[v].invalid < target + 5); round++) {
        for (const [position, version] of shuffled(group.versions).entries()) {
          const count = counts[version];
          if (count.kept >= target || count.invalid >= target + 5) continue;
          await waitForQuiet();
          const sample = { ...group, groupIndex, version, round, position, sampleStarted: now() };
          delete sample.versions;
          const attemptStarted = Date.now();
          let page = warmPages.get(version);
          try {
            if (!page) page = await openPage(contexts[version], version, prepared[version].url, group);
            await page.bringToFront();
            if (group.state === 'warm' && !warmPages.has(version)) {
              sample.setupWarm = await bounded(page.evaluate(() => window.bench.warm()), 'Warmup');
              sample.refusal = refusal({ warm: sample.setupWarm });
              if (sample.refusal || sample.setupWarm.success !== true) throw new Error(sample.refusal ?? 'Warmup returned success=false');
              warmPages.set(version, page);
            }
            if (group.state === 'switched') {
              sample.previousProblem = otherProblem;
              const prior = await initial(page, otherFixture, 'run', true);
              sample.setupRun = prior;
              sample.refusal = refusal(prior);
              const priorError = outcome(prior, otherFixture.cases.map((c) => c.id));
              if (sample.refusal || priorError) throw new Error(sample.refusal ?? priorError);
              await bounded(page.evaluate(() => window.bench.release()), 'Release previous problem');
            }
            checkDeadline();
            sample.beforeInitial = pressure();
            if (mode === 'run' && sample.beforeInitial.oneMinute > 2) {
              sample.excluded = 'initial load > 2.0';
            } else {
              sample.initial = await initial(page, fixture, group.journey, group.state === 'cold');
              sample.refusal = refusal(sample.initial);
              sample.invalid = outcome(sample.initial, fixture.cases.map((c) => c.id));
              if (group.journey === 'run' && !sample.invalid && !sample.refusal) {
                sample.beforeSecond = pressure();
                if (mode === 'run' && sample.beforeSecond.oneMinute > 2) {
                  sample.excluded = 'continuation load > 2.0';
                } else {
                  sample.second = await second(page, fixture.cases[1].id);
                  sample.refusal = refusal(sample.second);
                  sample.invalid = outcome(sample.second, [fixture.cases[1].id]);
                  if (!sample.invalid && !sample.second.evaluation.cases[0]?.traceEvents) sample.invalid = 'No second-case trace';
                  if (!sample.invalid && sample.initial.firstTraceMs === null) sample.invalid = 'No first-case trace';
                }
              }
            }
            if (page === warmPages.get(version)) await bounded(page.evaluate(() => window.bench.release()), 'Release execution');
          } catch (error) {
            if (Date.now() >= deadline) throw error;
            sample.invalid = error.message;
          } finally {
            if (page && (page !== warmPages.get(version) || sample.invalid || sample.refusal)) {
              warmPages.delete(version);
              await page.close().catch(() => {});
            }
          }

          sample.wallMs = Date.now() - attemptStarted;
          sample.metrics = addressedBySample(sample);
          sample.kept = mode === 'run' && !sample.invalid && !sample.excluded && !sample.refusal;
          if (sample.invalid || sample.refusal) count.invalid++;
          else if (!sample.excluded) count.kept++;
          await appendFile(samplesPath, JSON.stringify(sample) + '\n');
          if (sample.refusal) throw new Error(sample.refusal);
          if (sample.invalid) console.error('Invalid sample', version, JSON.stringify(group), sample.invalid);
        }
      }
    } finally {
      await Promise.all([...warmPages.values()].map((page) => page.close().catch(() => {})));
    }
    if (Object.values(counts).some((c) => c.kept < target)) complete = false;
    console.log(JSON.stringify({ groupIndex, ...group, counts, wallMs: Date.now() - groupStarted }));
  }
  report.complete = complete;
  if (!complete) process.exitCode = 1;
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  report.end = now();
  try {
    await save();
  } finally {
    await browser?.close();
    for (const { server } of Object.values(prepared)) {
      server.close();
      server.closeAllConnections();
    }
  }
}

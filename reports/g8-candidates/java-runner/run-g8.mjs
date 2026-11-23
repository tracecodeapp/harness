import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { availableParallelism, hostname, loadavg, release } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { csharpCandidateCacheReceipt, csharpCandidateOutcome } from './csharp-candidate-witness.mjs';
import { javaCandidateCacheReceipt, javaCandidateOutcome } from './java-candidate-witness.mjs';
import { pythonCandidateCacheReceipt, pythonCandidateOutcome } from '../python-runner/python-candidate-witness.mjs';

const [outArg, mode, windowName, seedArg = '0212026', minuteArg = '90'] = process.argv.slice(2);
const out = resolve(outArg);
const windowLanguages = {
  'desktop-a': ['csharp', 'java'],
  'desktop-b': ['javascript', 'typescript', 'python', 'cpp'],
  phone: ['javascript', 'typescript', 'python', 'cpp', 'csharp', 'java'],
};
const selectedCpu = windowName === 'phone' ? 4 : 1;
const maxInvalid = mode === 'smoke' ? 1 : 5;
const seed = Number(seedArg);
const runMinutes = Number(minuteArg);
const groupSelector = process.env.SPEED_GROUP_SELECTOR;
const candidateScope = process.env.SPEED_JAVA_SCOPE;
const testedLanguage = process.env.SPEED_G8_LANGUAGE ?? 'java';
assert.ok(['java', 'csharp', 'python'].includes(testedLanguage));
const candidate = candidateScope ? await jsonCandidate() : undefined;
async function jsonCandidate() {
  return JSON.parse(await readFile(join(out, 'vcandidate', 'candidate.json'), 'utf8'));
}
assert.ok(mode === 'smoke' || Object.hasOwn(windowLanguages, windowName));
assert.ok(Number.isSafeInteger(seed) && Number.isFinite(runMinutes) && runMinutes > 0);
assert.ok(
  groupSelector === undefined ||
    (groupSelector === 'java-switched-run' && mode === 'run' && windowName === 'desktop-a'),
  'SPEED_GROUP_SELECTOR must be unset or java-switched-run in a Desktop A run',
);
if (candidate) {
  assert.ok(mode === 'run' && !groupSelector);
  assert.ok((candidateScope === 'desktop' || candidateScope === 'spot') && windowName === 'desktop-a' ||
    candidateScope === 'phone' && windowName === 'phone');
}

const languages = { python: 'py', javascript: 'js', typescript: 'ts', java: 'java', cpp: 'cpp', csharp: 'cs' };
const problemIds = ['binary-search', 'permutations'];
const appRefs = {
  '0.17.1': '083bf3f4aec34a353dd6da749d691ca29ed601e8',
  '0.20.1': 'd0debe20a21885e701731d5e10f5741390b1ddd0',
};
const versions = candidate ? ['candidate-main', 'candidate-deploy'] : Object.keys(appRefs);
const appLockIntegrity = {
  '0.17.1': 'sha512-iteoJHC4riHGt+EGrMsl1Kb0TbkC1WJiaA+hIoggm6hyxQBFnk8zuCY+6qFG9iPijfLpwR8fb5IwQOm5IZKtcQ==',
  '0.20.1': 'sha512-a/vYibZedmvLZzBEwlt9eeV4LdCJFlDW+U8JLnc2hP6lZm9rzRd6h21Qf5cuqc7Yzvh3MdzBe6kStxRAZ1hlQA==',
};
const corpus = process.env.SPEED_CORPUS ?? '/root/ci/parity-app-data';
const filePrefix = candidate ? 's-' + testedLanguage + '-' + candidateScope + '-' :
  mode === 'smoke' ? 'smoke-' : 'speed-' + windowName + '-';
const metadataPath = join(out, filePrefix + 'metadata.json');
const samplesPath = join(out, filePrefix + 'samples.jsonl');
const deadline = Date.now() + runMinutes * 60_000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const frozenDependencyHashes = await json(new URL('./dependency-locks/tree-sha256.json', import.meta.url));
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
  const expected = await json(new URL('./fixture-digests.json', import.meta.url));
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
      const fixtureSha256 = sha256(JSON.stringify(fixture));
      assert.equal(fixtureSha256, expected[id][language], 'Fixture differs from both app pins: ' + id + '/' + language);
      data[id][language] = fixture;
      provenance[id].fixture[language] = {
        sourceFile, codeSha256: sha256(source), fixtureSha256,
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
  const candidateVersion = version.startsWith('candidate-');
  const root = join(out, candidateVersion ? 'vcandidate' : 'v' + version);
  const harness = join(root, 'package');
  const site = join(root, 'site');
  const manifest = await json(join(harness, 'package.json'));
  assert.equal(manifest.version, candidateVersion ? candidate.version : version);
  const tarball = candidateVersion ? 'candidate.tgz' : 'tracecode-harness-' + version + '.tgz';
  const tarballBytes = await readFile(join(root, tarball));
  const integrity = 'sha512-' + createHash('sha512').update(tarballBytes).digest('base64');
  if (candidateVersion) assert.equal(sha256(tarballBytes), candidate.tarballSha256);
  else assert.equal(integrity, appLockIntegrity[version], 'Tarball differs from the app lockfile');
  const dependencyFile = join(root, 'dependencies.json');
  const dependencyBytes = await readFile(dependencyFile);
  const dependenciesSha256 = sha256(dependencyBytes);
  assert.equal(dependenciesSha256, candidateVersion ? candidate.dependenciesSha256 : frozenDependencyHashes[version],
    `Installed dependency tree differs from the frozen tree for Harness ${version}`);
  const dependencyLockSha256 = sha256(await readFile(join(harness, 'package-lock.json')));
  const expectedLock = new URL(`./dependency-locks/${version}.package-lock.json`, import.meta.url);
  assert.equal(dependencyLockSha256, candidateVersion ? candidate.dependencyLockSha256 :
    sha256(await readFile(expectedLock)), `Install lock differs from the frozen lock for Harness ${version}`);
  if (candidateVersion) {
    for (const [name, hash] of Object.entries(candidate.files)) {
      assert.equal(sha256(await readFile(join(root, name))), hash, name + ' differs from staged bytes');
    }
  }
  const shim = join(harness, 'dist', 'zlib-browser-shim.js');
  await build({
    entryPoints: [new URL('./entry.ts', import.meta.url).pathname],
    outfile: join(site, 'entry.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    alias: {
      'tracecode-harness-under-test/judge': join(harness, 'dist', 'judge.js'),
      'tracecode-harness-under-test/tracekernel': join(harness, 'dist', 'tracekernel.js'),
      ...(existsSync(shim) && { zlib: shim, 'node:zlib': shim }),
    },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  await writeFile(join(site, 'index.html'), '<!doctype html><meta charset="utf-8">');
  const metadata = {
    appRef: candidateVersion ? appRefs['0.20.1'] : appRefs[version],
    ...(candidateVersion && { commit: candidate.commit, files: candidate.files }),
    tarball, integrity, sha256: sha256(tarballBytes),
    dependencyLockSha256, dependenciesSha256,
    dependencies: JSON.parse(dependencyBytes.toString('utf8')),
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
    await page.evaluate(async ({ language, stopSubmit, candidate }) => {
      const { createSession } = await import('/entry.mjs');
      window.bench = createSession(language, stopSubmit, candidate);
  }, {
    language: group.language,
    stopSubmit: version === '0.20.1' || version === 'candidate-main',
    candidate: version.startsWith('candidate-') && group.language === testedLanguage,
  });
    return page;
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

function candidateOutcome(result, role, caseCount, caseId, version) {
  if (testedLanguage === 'java') return javaCandidateOutcome(result, role, caseCount, caseId);
  if (testedLanguage === 'csharp') return csharpCandidateOutcome(result, role, caseCount, caseId);
  return pythonCandidateOutcome(result, role, caseCount,
    role === 'run' || version === 'candidate-main');
}

function candidateCacheReceipt(result) {
  if (testedLanguage === 'java') return javaCandidateCacheReceipt(result);
  if (testedLanguage === 'csharp') return csharpCandidateCacheReceipt(result);
  return pythonCandidateCacheReceipt(result);
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
    ...(evaluation?.cases ?? []).flatMap((c) => [
      c.failure, c.traceUnavailable,
      c.attachment?.status === 'refused' ? 'Observation refused: ' + c.attachment.reason : undefined,
    ]),
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

// Approximate wall costs in seconds from the smoke and lane V's warm/cold runs.
// Only the schedule uses these estimates. The report uses measured timings.
const actionCost = {
  javascript: { warmRun: 0.25, warmSubmit: 0.15, coldStart: 0.45 },
  typescript: { warmRun: 0.3, warmSubmit: 0.2, coldStart: 0.5 },
  python: { warmRun: 0.7, warmSubmit: 0.45, coldStart: 0.9 },
  cpp: { warmRun: 0.4, warmSubmit: 0.35, coldStart: 2.6 },
  csharp: { warmRun: 0.55, warmSubmit: 0.4, coldStart: 3.8 },
  java: { warmRun: 8.0, warmSubmit: 2.0, coldStart: 2.7 },
};

function expectedGroupSeconds(group) {
  const { warmRun, warmSubmit, coldStart } = actionCost[group.language];
  const action = group.journey === 'submit' ? warmSubmit : warmRun;
  const heavy = group.problem === 'permutations' ? 1.2 : 1;
  const setup = group.state === 'warm' ? 0 : coldStart + 0.4;
  const previousRun = group.state === 'switched' ? warmRun : 0;
  return group.target * group.versions.length * (action * heavy + setup + previousRun);
}

function plan() {
  const groups = [];
  const cpuRates = mode === 'smoke' ? [1, 4] : [selectedCpu];
  const cheapFirst = candidateScope === 'spot' ? windowLanguages.phone.filter((lang) => lang !== testedLanguage) :
    candidate ? [testedLanguage] : mode === 'smoke' ? windowLanguages.phone : windowLanguages[windowName];
  for (const language of cheapFirst) {
    for (const cpu of cpuRates) {
      const target = candidate ? 20 : mode === 'smoke' ? 1 : cpu === 4 || language === 'java' ? 12 : 20;
      const phoneSubset = mode === 'run' && windowName === 'phone';
      for (const state of phoneSubset ? ['warm', 'cold'] : ['warm', 'cold', 'switched']) {
        for (const journey of phoneSubset ? ['run'] : ['submit', 'run']) {
          for (const problem of problemIds) {
            groups.push({
              language, cpu, problem, state, journey, target, versions,
              continuation: journey === 'run' && !phoneSubset,
            });
          }
        }
        if (state === 'warm' && !phoneSubset) {
          groups.push({ language, cpu, problem: 'binary-search', state, journey: 'lesson', target,
            versions: candidate ? ['candidate-main'] : ['0.20.1'] });
        }
      }
    }
  }
  if (candidateScope === 'spot') {
    return groups.filter(({ problem, state, journey }) =>
      problem === 'binary-search' && state === 'warm' && journey === 'run')
      .map((group) => ({ ...group, versions: ['candidate-main'], continuation: false }));
  }
  if (mode !== 'smoke') {
    const decide = g => testedLanguage === 'java' && candidateScope === 'desktop' &&
      g.problem === 'binary-search' && g.state === 'warm' && g.journey === 'run';
    return groups.sort((a, b) => Number(decide(b)) - Number(decide(a)) || expectedGroupSeconds(a) - expectedGroupSeconds(b));
  }
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
    ...(sample.continuation && { secondTrace: sample.second?.elapsedMs }),
  };
  return { [sample.journey === 'lesson' ? 'lessonContinue' : 'submitVerdicts']: sample.initial?.elapsedMs };
}

const prepared = {};
let browser;
const fullSchedule = plan();
const schedule = groupSelector === undefined ? fullSchedule : fullSchedule.filter(group =>
  group.language === 'java' && group.state === 'switched' && group.journey === 'run');
if (groupSelector !== undefined) {
  assert.deepEqual(schedule.map(group => group.problem).sort(), [...problemIds].sort());
}
const report = {
  schema: 'tracecode.speed-baseline.v1',
  mode, window: mode === 'smoke' ? 'smoke' : windowName, cpu: selectedCpu, seed, start: now(), runMinutes, loadThreshold: 2, appRefs, schedule,
  ...(candidate && { candidateScope, runnerCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim() }),
  ...(groupSelector !== undefined && {
    groupSelector,
    runnerCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  }),
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
    // The two app policies run on independent pages with the same installed bytes.
    prepared[version] = candidate && prepared['candidate-main']
      ? prepared['candidate-main']
      : await prepareVersion(version);
    report.packages[version] = prepared[version].metadata;
  }
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  report.browser.version = browser.version();
  if (candidate) assert.match(report.browser.version, /^145\./, 'S(Java) requires Chromium 145');
  await save();
  const contexts = Object.fromEntries(await Promise.all(versions.map(async (version) =>
    [version, await browser.newContext()])));
  let complete = true;
  for (const [groupIndex, group] of schedule.entries()) {
    const { target } = group;
    const fixture = fixtures.data[group.problem][group.language];
    const otherProblem = problemIds.find((id) => id !== group.problem);
    const otherFixture = fixtures.data[otherProblem][group.language];
    const counts = Object.fromEntries(group.versions.map((version) => [version, { kept: 0, invalid: 0 }]));
    const warmPages = new Map();
    const groupStarted = Date.now();
    try {
      for (let round = 1; group.versions.some((v) => counts[v].kept < target && counts[v].invalid < maxInvalid); round++) {
        for (const [position, version] of shuffled(group.versions).entries()) {
          const count = counts[version];
          if (count.kept >= target || count.invalid >= maxInvalid) continue;
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
              if (group.journey === 'submit' && !sample.invalid && sample.initial.verdict !== 'passed') {
                sample.invalid = 'Unexpected Submit verdict: ' + JSON.stringify(sample.initial.verdict);
              }
              if (group.journey === 'run' && !sample.invalid && sample.initial.firstTraceMs === null) {
                sample.invalid = 'No first-case trace';
              }
              if (group.language === testedLanguage && candidate && !sample.invalid && !sample.refusal) {
                const role = group.journey === 'submit' ? 'submit' : 'run';
                sample.invalid = candidateOutcome(sample.initial, role, fixture.cases.length,
                  role === 'run' ? fixture.cases[0].id : undefined, version);
              }
              if (group.continuation && !sample.invalid && !sample.refusal) {
                sample.beforeSecond = pressure();
                if (mode === 'run' && sample.beforeSecond.oneMinute > 2) {
                  sample.excluded = 'continuation load > 2.0';
                } else {
                  sample.second = await second(page, fixture.cases[1].id);
                  sample.refusal = refusal(sample.second);
                  sample.invalid = outcome(sample.second, [fixture.cases[1].id]);
                  if (!sample.invalid && !sample.second.evaluation.cases[0]?.traceEvents) sample.invalid = 'No second-case trace';
                  if (group.language === testedLanguage && candidate && !sample.invalid && !sample.refusal) {
                    sample.invalid = candidateOutcome(sample.second, 'click', 1, fixture.cases[1].id, version);
                  }
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

          if (group.language === testedLanguage && candidate) {
            sample.cache = {
              initial: candidateCacheReceipt(sample.initial),
              ...(sample.second && { second: candidateCacheReceipt(sample.second) }),
            };
          }
          sample.wallMs = Date.now() - attemptStarted;
          sample.metrics = addressedBySample(sample);
          sample.kept = mode === 'run' && !sample.invalid && !sample.excluded && !sample.refusal;
          if (sample.invalid || sample.refusal) count.invalid++;
          else if (!sample.excluded) count.kept++;
          await appendFile(samplesPath, JSON.stringify(sample) + '\n');
          if (sample.refusal && (!candidate || /login|sign in|unauthoriz|access denied/i.test(sample.refusal))) {
            throw new Error(sample.refusal);
          }
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
    for (const { server } of new Set(Object.values(prepared))) {
      server.close();
      server.closeAllConnections();
    }
  }
}

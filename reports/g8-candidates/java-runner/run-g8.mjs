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
import {
  aaClosingControlPlan,
  aaClosingAllVersions,
  aaClosingVersions,
  aaControlPlan,
  aaLanguages,
  aaVersions,
} from './aa-control.mjs';
import { csharpCandidateCacheReceipt, csharpCandidateOutcome } from './csharp-candidate-witness.mjs';
import { csharpProductionControlOutcome } from './csharp-production-control-witness.mjs';
import { csharpTrustedArtifactKey } from './csharp-replenishment-witness.mjs';
import { javaCandidateCacheReceipt, javaCandidateOutcome } from './java-candidate-witness.mjs';
import { javaProductionControlOutcome } from './java-production-control-witness.mjs';
import { pythonCandidateCacheReceipt, pythonCandidateOutcome } from '../python-runner/python-candidate-witness.mjs';
import {
  pythonProductionControlOutcome,
  pythonProductionControlWorker,
} from '../python-runner/python-production-control-witness.mjs';
import {
  liveControlPairGroups,
  liveControlVersions,
  liveLessonVersions,
  liveRoundOrder,
} from '../live-control.mjs';
import { referenceRerecordPlan, referenceRoundOrder } from '../reference-rerecord.mjs';
import { releasePythonWarmPlan } from '../release-python-warm.mjs';
import {
  pythonWarmModes,
} from '../python-warm-policy.mjs';
import {
  addCsharpFreshSubmitControl,
  csharpWarmModes,
  requiresTrustedCsharpWarmArtifact,
} from '../csharp-warm-policy.mjs';
import {
  expandWarmRepeatGroups,
  isSubmitAfterRunWarmMode,
  openIsolatedWarmAttempt,
  pairRepeatGroups,
  prioritizeSubmitAfterRunPreflights,
  repeatPenaltyLanguages,
  submitAfterRunPreflightAction,
  warmAttemptPlan,
  warmMetricName,
} from '../warm-repeat-policy.mjs';
import {
  pythonFreshAaFailFast,
  pythonFreshAaPlan,
  pythonFreshAaRoundOrder,
  pythonFreshAaVersions,
} from '../python-fresh-aa.mjs';
import {
  submitAaFailFast,
  submitAaLabelPairs,
  submitAaPlan,
  submitAaRoundOrder,
  submitAaSourceVersion,
  submitAaVersions,
} from '../submit-aa.mjs';
import { javaClosingPlan } from '../java-closing.mjs';
import {
  createUncapturedShapeGuard,
  measurementShapeKey,
  selectShapeProbeSchedule,
} from '../measurement-shapes.mjs';
import { capturedShapeKeys } from '../shape-captures.mjs';
import { csharpMeasurementPlan } from '../csharp-measurement-plan.mjs';

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
const releaseVersion = process.env.SPEED_G8_RELEASE;
const aaControl = process.env.SPEED_G8_AA === '1';
const aaClosing = process.env.SPEED_G8_AA_CLOSING === '1';
const liveControl = process.env.SPEED_G8_LIVE_CONTROL === '1';
const referenceRerecord = process.env.SPEED_G8_REFERENCE_RERECORD === '1';
const releasePythonWarm = process.env.SPEED_G8_RELEASE_PYTHON_WARM === '1';
const pythonLocalDiagnostic = process.env.SPEED_PYTHON_LOCAL_DIAGNOSTIC === '1';
const pythonFreshAa = process.env.SPEED_PYTHON_FRESH_AA === '1';
const submitAa = process.env.SPEED_SUBMIT_AA === '1';
const javaClosing = process.env.SPEED_JAVA_CLOSING === '1';
const javaClosingPhase = process.env.SPEED_JAVA_CLOSING_PHASE;
const shapeProbeFile = process.env.SPEED_G8_SHAPE_PROBE_FILE;
const inventoryOnly = process.env.SPEED_G8_INVENTORY_ONLY === '1';
const fixedWarmWitness = releasePythonWarm || pythonFreshAa || submitAa;
const testedLanguage = process.env.SPEED_G8_LANGUAGE ?? 'java';
assert.ok(['javascript', 'typescript', 'python', 'cpp', 'java', 'csharp'].includes(testedLanguage));
assert.ok(releaseVersion === undefined || releaseVersion === '0.17.3');
assert.ok(!aaControl || releaseVersion === '0.17.3', 'A/A control requires the pinned 0.17.3 release');
assert.ok(!aaClosing || releaseVersion === '0.17.3', 'Closing A/A control requires the pinned 0.17.3 release');
assert.ok(!(aaControl && aaClosing), 'Select only one A/A control');
assert.ok([aaControl, aaClosing, referenceRerecord, releasePythonWarm,
  pythonLocalDiagnostic, pythonFreshAa, submitAa, javaClosing].filter(Boolean).length <= 1,
  'Select only one special measurement mode');
assert.ok(!liveControl || pythonLocalDiagnostic ||
  ![aaControl, aaClosing, referenceRerecord, releasePythonWarm, pythonFreshAa, submitAa].some(Boolean),
  'Live control cannot be combined with another special measurement mode');
assert.ok(!releasePythonWarm || releaseVersion === '0.17.3',
  'The Python warm closing session requires the pinned 0.17.3 release');
const staged = candidateScope ? inventoryOnly ? {} : await jsonCandidate() : undefined;
const candidate = releaseVersion === undefined ? staged : undefined;
assert.ok(!liveControl || candidate, 'A live control requires a candidate session');
assert.ok(!javaClosing || liveControl && candidate && testedLanguage === 'java' &&
  candidateScope === 'desktop', 'Java closing requires the staged Java candidate and live control');
assert.ok(javaClosingPhase === undefined || javaClosing && javaClosingPhase === 'spot',
  'Java closing phase must be unset or spot');
assert.ok(!pythonLocalDiagnostic || liveControl && candidate && testedLanguage === 'python',
  'The local Python diagnostic requires a staged Python candidate and live control');
if (pythonLocalDiagnostic) assert.notEqual(hostname(), 'agentrunner', 'Run the phase diagnostic locally');
async function jsonCandidate() {
  return JSON.parse(await readFile(join(out, releaseVersion ? 'vrelease' : 'vcandidate', 'candidate.json'), 'utf8'));
}
assert.ok(mode === 'smoke' || Object.hasOwn(windowLanguages, windowName));
assert.ok(Number.isSafeInteger(seed) && Number.isFinite(runMinutes) && runMinutes > 0);
assert.ok(
  groupSelector === undefined ||
    (groupSelector === 'java-switched-run' && mode === 'run' && windowName === 'desktop-a'),
  'SPEED_GROUP_SELECTOR must be unset or java-switched-run in a Desktop A run',
);
if (staged) {
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
const candidateVersions = ['candidate-main', 'candidate-deploy'];
const csharpWarmSubmitControl = liveControl && testedLanguage === 'csharp' &&
  candidateScope === 'desktop';
const isLiveWitnessControl = (version, language) => liveControl &&
  (version === '0.17.1' || csharpWarmSubmitControl && language === 'csharp' &&
    version === '0.20.1');
const versions = submitAa ? submitAaVersions : pythonFreshAa ? pythonFreshAaVersions : releasePythonWarm ? ['release-deploy', '0.17.1', '0.20.1'] : referenceRerecord ? ['0.17.1', '0.20.1'] : aaClosing ? aaClosingAllVersions : aaControl ? aaVersions : releaseVersion ? ['release-deploy'] : candidate
  ? liveControl ? [...liveControlVersions(candidateVersions),
      ...(csharpWarmSubmitControl ? ['0.20.1'] : [])] : candidateVersions : Object.keys(appRefs);
const appLockIntegrity = {
  '0.17.1': 'sha512-iteoJHC4riHGt+EGrMsl1Kb0TbkC1WJiaA+hIoggm6hyxQBFnk8zuCY+6qFG9iPijfLpwR8fb5IwQOm5IZKtcQ==',
  '0.20.1': 'sha512-a/vYibZedmvLZzBEwlt9eeV4LdCJFlDW+U8JLnc2hP6lZm9rzRd6h21Qf5cuqc7Yzvh3MdzBe6kStxRAZ1hlQA==',
};
const corpus = process.env.SPEED_CORPUS ?? '/root/ci/parity-app-data';
const filePrefix = shapeProbeFile ? `shape-probe-${testedLanguage}-${candidateScope}-` :
  javaClosing ? `java-closing${javaClosingPhase ? '-' + javaClosingPhase : ''}-` : submitAa ? 'submit-aa-' : pythonFreshAa ? 'python-fresh-aa-' : pythonLocalDiagnostic ? 'python-local-diagnostic-' : releasePythonWarm ? 'release-python-warm-' : referenceRerecord ? 'reference-rerecord-' : aaClosing ? 'aa-release-closing-' : aaControl ? 'aa-release-' : releaseVersion ? 'r-' + releaseVersion + '-' +
    (candidateScope === 'spot' ? 'spot-' : testedLanguage + '-' + candidateScope + '-') :
  candidate ? 's-' + testedLanguage + '-' + candidateScope + '-' :
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
  const stagedVersion = version.startsWith('candidate-') || version === 'release-deploy';
  const root = join(out, stagedVersion ? (releaseVersion ? 'vrelease' : 'vcandidate') : 'v' + version);
  const harness = join(root, 'package');
  const site = join(root, 'site');
  const manifest = await json(join(harness, 'package.json'));
  assert.equal(manifest.version, stagedVersion ? staged.version : version);
  const tarball = stagedVersion ? 'candidate.tgz' : 'tracecode-harness-' + version + '.tgz';
  const tarballBytes = await readFile(join(root, tarball));
  const integrity = 'sha512-' + createHash('sha512').update(tarballBytes).digest('base64');
  if (stagedVersion) assert.equal(sha256(tarballBytes), staged.tarballSha256);
  else assert.equal(integrity, appLockIntegrity[version], 'Tarball differs from the app lockfile');
  const dependencyFile = join(root, 'dependencies.json');
  const dependencyBytes = await readFile(dependencyFile);
  const dependenciesSha256 = sha256(dependencyBytes);
  assert.equal(dependenciesSha256, stagedVersion ? staged.dependenciesSha256 : frozenDependencyHashes[version],
    `Installed dependency tree differs from the frozen tree for Harness ${version}`);
  const dependencyLockSha256 = sha256(await readFile(join(harness, 'package-lock.json')));
  const expectedLock = new URL(`./dependency-locks/${version}.package-lock.json`, import.meta.url);
  assert.equal(dependencyLockSha256, stagedVersion ? staged.dependencyLockSha256 :
    sha256(await readFile(expectedLock)), `Install lock differs from the frozen lock for Harness ${version}`);
  if (stagedVersion) {
    for (const [name, hash] of Object.entries(staged.files)) {
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
    appRef: stagedVersion ? appRefs[releaseVersion ? '0.17.1' : '0.20.1'] : appRefs[version],
    ...(stagedVersion && { ...(staged.commit && { commit: staged.commit }), files: staged.files }),
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
    const sourceVersion = submitAa ? submitAaSourceVersion(version) : version;
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: group.cpu });
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(async ({ language, stopSubmit, candidate, candidateRuntime }) => {
      const { createSession } = await import('/entry.mjs');
      window.bench = createSession(language, stopSubmit, candidate, candidateRuntime);
  }, {
    language: group.language,
    stopSubmit: sourceVersion === '0.20.1' || sourceVersion === 'candidate-main',
    candidate: version.startsWith('candidate-') && group.language === testedLanguage ||
      isLiveWitnessControl(version, group.language) &&
        ['java', 'csharp', 'python'].includes(group.language) ||
      fixedWarmWitness && repeatPenaltyLanguages.includes(group.language),
    candidateRuntime: version.startsWith('candidate-') && group.language === testedLanguage,
  });
    return page;
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

function candidateOutcome(result, role, caseCount, caseId, version, language, trustedArtifactKey,
  priorResult, context = {}) {
  const priorCsharpObserverKeys = new Set((priorResult?.csharp?.phases ?? [])
    .filter(({ role: phaseRole, type, artifactKey }) => phaseRole === 'observer' &&
      type === 'prepare-program' && typeof artifactKey === 'string' && artifactKey.length > 0)
    .map(({ artifactKey }) => artifactKey));
  const previousObserverArtifactKey = priorCsharpObserverKeys.size === 1
    ? [...priorCsharpObserverKeys][0] : undefined;
  const replenishmentOptions = language === 'csharp' ? {
    ...(context.allowCsharpTrustedPromotion && { caseCount }),
    ...(context.csharpPromotedExecutionType && {
      promotedExecutionType: context.csharpPromotedExecutionType,
      promotedPrepareRole: context.csharpPromotedPrepareRole,
    }),
    ...(context.allowColdCompilerInitialization && { allowColdCompilerInitialization: true }),
    ...(context.allowPendingCsharpTrustedPrime && { allowPendingTrustedPrime: true }),
    ...(previousObserverArtifactKey && { previousObserverArtifactKey }),
  } : undefined;
  const selectedReplenishmentOptions = replenishmentOptions &&
    Object.keys(replenishmentOptions).length > 0 ? replenishmentOptions : undefined;
  if (fixedWarmWitness && repeatPenaltyLanguages.includes(language)) {
    if (language === 'csharp') {
      return csharpProductionControlOutcome(
        result, trustedArtifactKey, selectedReplenishmentOptions);
    }
    return pythonProductionControlOutcome(result.python?.phases ?? [], role, caseCount,
      priorResult === undefined ? undefined :
        pythonProductionControlWorker(priorResult.python?.phases ?? []));
  }
  if (isLiveWitnessControl(version, language)) {
    if (language === 'java') return javaProductionControlOutcome(result, role, caseCount);
    if (language === 'csharp') return csharpProductionControlOutcome(
      result, trustedArtifactKey, selectedReplenishmentOptions);
    if (language === 'python') return pythonProductionControlOutcome(
      result.python?.phases ?? [], role, caseCount);
    return;
  }
  if (testedLanguage === 'java') return javaCandidateOutcome(result, role, caseCount, caseId);
  if (testedLanguage === 'csharp') {
    return csharpCandidateOutcome(result, role, caseCount, caseId, trustedArtifactKey,
      selectedReplenishmentOptions);
  }
  return pythonCandidateOutcome(result, role, caseCount,
    role === 'run' || version === 'candidate-main');
}

function candidateCacheReceipt(result, language = testedLanguage, trustedArtifactKey) {
  if (language === 'java') return javaCandidateCacheReceipt(result);
  if (language === 'csharp') return csharpCandidateCacheReceipt(result, trustedArtifactKey);
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
  if (javaClosing) return structuredClone(javaClosingPhase === 'spot'
    ? javaClosingPlan.slice(2) : javaClosingPlan);
  if (submitAa) return structuredClone(submitAaPlan);
  if (pythonFreshAa) return structuredClone(pythonFreshAaPlan);
  if (pythonLocalDiagnostic) return expandWarmRepeatGroups([
    { language: 'python', cpu: 1, problem: 'binary-search', state: 'warm', journey: 'run',
      target: 5, versions: ['0.17.1', 'candidate-deploy'], continuation: false },
    { language: 'python', cpu: 1, problem: 'binary-search', state: 'warm', journey: 'submit',
      target: 5, versions: ['0.17.1', 'candidate-deploy'], continuation: false },
  ], { submitAfterRun: true });
  if (releasePythonWarm) return prioritizeSubmitAfterRunPreflights(expandWarmRepeatGroups(
    structuredClone(releasePythonWarmPlan), { submitAfterRun: true }), ['python', 'csharp']);
  if (referenceRerecord) return structuredClone(referenceRerecordPlan);
  if (candidate && liveControl && testedLanguage === 'csharp') {
    return structuredClone(csharpMeasurementPlan(candidateScope, candidateVersions));
  }
  const groups = [];
  const defaultVersions = csharpWarmSubmitControl
    ? versions.filter((version) => version !== '0.20.1') : versions;
  const cpuRates = mode === 'smoke' ? [1, 4] : [selectedCpu];
  const spotExcluded = releaseVersion ? new Set(['csharp', 'python']) : new Set([testedLanguage]);
  const cheapFirst = aaControl || aaClosing ? aaLanguages : candidateScope === 'spot' ? windowLanguages.phone.filter((lang) => !spotExcluded.has(lang)) :
    staged ? [testedLanguage] : mode === 'smoke' ? windowLanguages.phone : windowLanguages[windowName];
  for (const language of cheapFirst) {
    for (const cpu of cpuRates) {
      const target = staged ? 20 : mode === 'smoke' ? 1 : cpu === 4 || language === 'java' ? 12 : 20;
      const phoneSubset = mode === 'run' && windowName === 'phone';
      for (const state of phoneSubset ? ['warm', 'cold'] : ['warm', 'cold', 'switched']) {
        for (const journey of phoneSubset ? ['run'] : ['submit', 'run']) {
          for (const problem of problemIds) {
            groups.push({
              language, cpu, problem, state, journey, target, versions: defaultVersions,
              continuation: journey === 'run' && !phoneSubset,
            });
          }
        }
        if (state === 'warm' && !phoneSubset && !releaseVersion) {
          groups.push({ language, cpu, problem: 'binary-search', state, journey: 'lesson', target,
            versions: liveControl ? liveLessonVersions(candidateVersions) : releaseVersion
              ? ['release-deploy'] : candidate ? ['candidate-main'] : ['0.20.1'] });
        }
      }
    }
  }
  if (candidateScope === 'spot') {
    const spotGroups = groups.filter(({ problem, state, journey }) =>
      problem === 'binary-search' && state === 'warm' && journey === 'run')
      .map((group) => ({ ...group,
        versions: liveControl ? versions : releaseVersion ? ['release-deploy'] : candidateVersions,
        continuation: false }));
    const scheduled = liveControl ? liveControlPairGroups(spotGroups, candidateVersions) : spotGroups;
    return scheduled.map((group) => group.language === 'python' && group.state === 'warm'
      ? { ...group, pythonWarmMode: pythonWarmModes.fresh }
      : group.language === 'csharp' && group.state === 'warm'
      ? { ...group, csharpWarmMode: csharpWarmModes.fresh }
      : group);
  }
  if (aaClosing) return aaClosingControlPlan(groups);
  if (aaControl) return aaControlPlan(groups);
  if (mode !== 'smoke') {
    const scheduledGroups = liveControl && candidateScope === 'phone'
      ? liveControlPairGroups(groups, candidateVersions)
      : groups;
    const decide = g => testedLanguage === 'java' && candidateScope === 'desktop' &&
      g.problem === 'binary-search' && g.state === 'warm' && g.journey === 'run';
    const expandedGroups = repeatPenaltyLanguages.includes(testedLanguage)
      ? pairRepeatGroups(
          expandWarmRepeatGroups(scheduledGroups, { submitAfterRun: true }), candidateVersions)
      : scheduledGroups;
    const controlledGroups = addCsharpFreshSubmitControl(expandedGroups,
      csharpWarmSubmitControl);
    return controlledGroups.sort((a, b) =>
      Number(isSubmitAfterRunWarmMode(b) && b.problem === 'binary-search') -
        Number(isSubmitAfterRunWarmMode(a) && a.problem === 'binary-search') ||
      Number(decide(b)) - Number(decide(a)) || expectedGroupSeconds(a) - expectedGroupSeconds(b));
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
  if (sample.journey === 'run') return Object.fromEntries([
    ['verdicts', sample.initial?.elapsedMs],
    ['firstTrace', sample.initial?.firstTraceMs],
    ...(sample.continuation ? [['secondTrace', sample.second?.elapsedMs]] : []),
  ].map(([endpoint, value]) => [warmMetricName(sample, endpoint), value]));
  const endpoint = sample.journey === 'lesson' ? 'lessonContinue' : 'submitVerdicts';
  return { [warmMetricName(sample, endpoint)]: sample.initial?.elapsedMs };
}

const prepared = {};
let browser;
const fullSchedule = plan();
const baseSchedule = groupSelector === undefined ? fullSchedule : fullSchedule.filter(group =>
  group.language === 'java' && group.state === 'switched' && group.journey === 'run');
const schedule = shapeProbeFile
  ? selectShapeProbeSchedule(candidateScope ?? windowName, baseSchedule,
      JSON.parse(await readFile(shapeProbeFile, 'utf8')))
  : baseSchedule;
if (groupSelector !== undefined) {
  assert.deepEqual(schedule.map(group => group.problem).sort(), [...problemIds].sort());
}
const uncapturedShapeGuard = createUncapturedShapeGuard(candidateScope ?? windowName,
  capturedShapeKeys);
if (inventoryOnly) {
  const scope = candidateScope ?? windowName;
  const shapes = schedule.flatMap((group) => group.versions.map((version) => ({
    key: measurementShapeKey(scope, group, version), scope, group, version,
  })));
  console.log(JSON.stringify({ scope, shapes }, null, 2));
  process.exit(0);
}
const report = {
  schema: 'tracecode.speed-baseline.v1',
  mode, window: mode === 'smoke' ? 'smoke' : windowName, cpu: selectedCpu, seed, start: now(), runMinutes, loadThreshold: 2, appRefs, schedule,
  ...(staged && { candidateScope, ...(releaseVersion && { releaseVersion }), runnerCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim() }),
  ...(aaControl && { aaControl: { languages: aaLanguages, versions: aaVersions, interleavedPerRound: true } }),
  ...(aaClosing && { aaClosing: {
    languages: aaLanguages, versions: aaClosingAllVersions, fixedOrderPerRound: true,
    pythonWarmSubmitControl: '0.20.1',
  } }),
  ...(referenceRerecord && { referenceRerecord: {
    date: '2026-11-24', target: 20, interleavedPerRound: true, alternatingOrderPerRound: true,
  } }),
  ...(releasePythonWarm && { releasePythonWarm: {
    release: '0.17.3', languages: ['python', 'csharp'], target: 20,
    alternatingOrderPerRound: true,
    pythonWarmSubmitControl: '0.20.1',
  } }),
  ...(pythonLocalDiagnostic && { pythonLocalDiagnostic: {
    target: 5, freshPagePerSample: true, repeatRun: true, submitAfterRun: true,
  } }),
  ...(pythonFreshAa && { pythonFreshAa: {
    sourceVersion: '0.17.1', labels: pythonFreshAaVersions, target: 20,
    languages: ['python', 'csharp'], freshPagePerSample: true,
    repeatRun: true, alternatingOrderPerRound: true,
    tolerances: { medianRatio: 1.05, p90Ratio: 1.10 },
  }, runnerCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }),
  ...(submitAa && { submitAa: {
    sourceVersions: Object.keys(submitAaLabelPairs), labelPairs: submitAaLabelPairs,
    target: 20, languages: ['python', 'csharp'], freshPagePerSample: true,
    submitAfterRun: true, alternatingOrderPerRound: true,
    tolerances: { medianRatio: 1.05, p90Ratio: 1.10 },
  }, runnerCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }),
  ...(javaClosing && { javaClosing: {
    target: 20, lessonReference: '0.17.1', pairedCandidateControls: true,
    freshPageSpotLanguages: ['python', 'csharp'], alternatingOrderPerRound: true,
    ...(javaClosingPhase && { phase: javaClosingPhase }),
  }, runnerCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }),
  ...(liveControl && { liveControl: {
    control: '0.17.1', candidateVersions, alternatingOrderPerRound: true,
    ...(['phone', 'spot'].includes(candidateScope) && { pairedCandidateControls: true }),
    ...(candidateScope === 'desktop' && repeatPenaltyLanguages.includes(testedLanguage) &&
      { pairedRepeatControls: true }),
    ...(testedLanguage === 'python' && candidateScope !== 'spot' &&
      { pythonWarmSubmitControl: '0.20.1' }),
    ...(csharpWarmSubmitControl && { csharpWarmSubmitControl: '0.20.1' }),
  } }),
  ...(groupSelector !== undefined && {
    groupSelector,
    runnerCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  }),
  ...(shapeProbeFile && { shapeProbe: { keys: JSON.parse(await readFile(shapeProbeFile, 'utf8')) } }),
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
    if (submitAa) {
      const sourceVersion = submitAaSourceVersion(version);
      const sourceLabels = submitAaLabelPairs[sourceVersion];
      prepared[version] = prepared[sourceLabels[0]] ?? await prepareVersion(sourceVersion);
    } else if (pythonFreshAa) {
      prepared[version] = prepared[pythonFreshAaVersions[0]] ?? await prepareVersion('0.17.1');
    } else {
      prepared[version] = candidate && prepared['candidate-main']
        ? prepared['candidate-main']
        : await prepareVersion(version);
    }
    report.packages[version] = prepared[version].metadata;
  }
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  report.browser.version = browser.version();
  if (staged || pythonFreshAa || submitAa) assert.match(report.browser.version, /^145\./,
    'G8 live measurement requires Chromium 145');
  await save();
  const contexts = Object.fromEntries(await Promise.all(versions.map(async (version) =>
    [version, await browser.newContext()])));
  let complete = true;
  const capturedSubmitAfterRun = new Set();
  const trustedCsharpArtifactKeys = new Map();
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
        const roundVersions = submitAa
          ? submitAaRoundOrder(group.versions, round)
          : pythonFreshAa
          ? pythonFreshAaRoundOrder(group.versions, round)
          : aaClosing ? group.versions : releasePythonWarm
          ? liveRoundOrder(group.versions, round) : referenceRerecord
          ? referenceRoundOrder(group.versions, round) : liveControl
          ? liveRoundOrder(group.versions, round) : shuffled(group.versions);
        for (const [position, version] of roundVersions.entries()) {
          const count = counts[version];
          if (count.kept >= target || count.invalid >= maxInvalid) continue;
          await waitForQuiet();
          const sample = { ...group, groupIndex, version, round, position, sampleStarted: now() };
          delete sample.versions;
          const attemptStarted = Date.now();
          let page = warmPages.get(version);
          let isolatedWarm;
          try {
            const warmPlan = warmAttemptPlan(group);
            if (warmPlan.freshPage) {
              isolatedWarm = await openIsolatedWarmAttempt(group, {
                open: () => openPage(contexts[version], version, prepared[version].url, group),
                warm: async (freshPage) => {
                  sample.setupWarm = await bounded(freshPage.evaluate(() => window.bench.warm()), 'Warmup');
                  if (group.language === 'csharp') {
                    sample.trustedCsharpArtifactKey = csharpTrustedArtifactKey(sample.setupWarm);
                    if (sample.trustedCsharpArtifactKey) {
                      trustedCsharpArtifactKeys.set(version, sample.trustedCsharpArtifactKey);
                    }
                    if (!sample.trustedCsharpArtifactKey && requiresTrustedCsharpWarmArtifact({
                      language: group.language, version, testedLanguage, fixedWarmWitness, liveControl,
                    })) {
                      throw new Error('C# warmup did not identify one trusted standby artifact');
                    }
                  }
                  sample.refusal = refusal({ warm: sample.setupWarm });
                  if (sample.refusal || sample.setupWarm.success !== true) {
                    throw new Error(sample.refusal ?? 'Warmup returned success=false');
                  }
                },
                prime: async (freshPage, journey) => {
                  const prime = await initial(freshPage, fixture, journey, false);
                  sample.prime = prime;
                  const primeRefusal = refusal(prime);
                  const primeError = outcome(prime, fixture.cases.map((c) => c.id));
                  if (primeRefusal || primeError) throw new Error(primeRefusal ?? primeError);
                  if ((candidate || fixedWarmWitness) &&
                      (version.startsWith('candidate-') && group.language === testedLanguage ||
                        isLiveWitnessControl(version, group.language) &&
                          repeatPenaltyLanguages.includes(group.language) ||
                        fixedWarmWitness && repeatPenaltyLanguages.includes(group.language))) {
                    sample.primeInvalid = candidateOutcome(prime, 'run', fixture.cases.length,
                      fixture.cases[0].id, version, group.language, sample.trustedCsharpArtifactKey);
                    if (sample.primeInvalid) throw new Error('Prime witness: ' + sample.primeInvalid);
                    sample.primeCache = candidateCacheReceipt(
                      prime, group.language, sample.trustedCsharpArtifactKey);
                  }
                  return prime;
                },
                close: (freshPage) => freshPage.close().catch(() => {}),
              });
              page = isolatedWarm.page;
            } else if (!page) {
              page = await openPage(contexts[version], version, prepared[version].url, group);
            }
            await page.bringToFront();
            if (!isolatedWarm && group.state === 'warm' && !warmPages.has(version)) {
              sample.setupWarm = await bounded(page.evaluate(() => window.bench.warm()), 'Warmup');
              if (group.language === 'csharp') {
                sample.trustedCsharpArtifactKey = csharpTrustedArtifactKey(sample.setupWarm);
                if (sample.trustedCsharpArtifactKey) {
                  trustedCsharpArtifactKeys.set(version, sample.trustedCsharpArtifactKey);
                }
              }
              sample.refusal = refusal({ warm: sample.setupWarm });
              if (sample.refusal || sample.setupWarm.success !== true) throw new Error(sample.refusal ?? 'Warmup returned success=false');
              warmPages.set(version, page);
            }
            if (group.language === 'csharp' && !sample.trustedCsharpArtifactKey) {
              sample.trustedCsharpArtifactKey = trustedCsharpArtifactKeys.get(version);
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
              if ((candidate || fixedWarmWitness) &&
                  (version.startsWith('candidate-') && group.language === testedLanguage ||
                    isLiveWitnessControl(version, group.language) &&
                      ['java', 'csharp', 'python'].includes(group.language) ||
                    fixedWarmWitness && repeatPenaltyLanguages.includes(group.language)) &&
                  !sample.invalid && !sample.refusal) {
                const role = group.journey === 'submit' ? 'submit' : 'run';
                sample.invalid = candidateOutcome(sample.initial, role, fixture.cases.length,
                  role === 'run' ? fixture.cases[0].id : undefined, version, group.language,
                  sample.trustedCsharpArtifactKey,
                  group.language === 'csharp' ? sample.prime ?? sample.setupRun : undefined, {
                    allowCsharpTrustedPromotion: group.language === 'csharp' &&
                      (group.csharpWarmMode === csharpWarmModes.repeatRun ||
                        group.state === 'cold' ||
                        group.state === 'switched' && group.journey === 'run'),
                    csharpPromotedExecutionType: group.language === 'csharp' &&
                      (group.state === 'cold' ||
                        group.state === 'switched' && group.journey === 'run')
                      ? group.journey === 'submit' || version.startsWith('candidate-')
                        ? 'execute-prepared-code'
                        : 'execute-prepared-trace'
                      : undefined,
                    csharpPromotedPrepareRole: group.language === 'csharp' &&
                      (group.state === 'cold' ||
                        group.state === 'switched' && group.journey === 'run')
                      ? group.journey === 'submit' || version.startsWith('candidate-')
                        ? 'ordinary'
                        : 'observer'
                      : undefined,
                    allowColdCompilerInitialization: group.language === 'csharp' &&
                      group.state === 'cold',
                    allowPendingCsharpTrustedPrime: group.language === 'csharp' &&
                      (group.csharpWarmMode === csharpWarmModes.submitAfterRun ||
                        group.state === 'switched' && group.journey === 'submit'),
                  });
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
                  if ((candidate || fixedWarmWitness) &&
                      (version.startsWith('candidate-') && group.language === testedLanguage ||
                        isLiveWitnessControl(version, group.language) &&
                          ['java', 'csharp', 'python'].includes(group.language) ||
                        fixedWarmWitness && repeatPenaltyLanguages.includes(group.language)) &&
                      !sample.invalid && !sample.refusal) {
                    sample.invalid = candidateOutcome(sample.second, 'click', 1,
                      fixture.cases[1].id, version, group.language, sample.trustedCsharpArtifactKey,
                      sample.initial);
                  }
                }
              }
            }
            if (isolatedWarm || page === warmPages.get(version)) {
              await bounded(page.evaluate(() => window.bench.release()), 'Release execution');
            }
          } catch (error) {
            if (Date.now() >= deadline) throw error;
            sample.invalid = error.message;
          } finally {
            if (isolatedWarm) {
              await isolatedWarm.close();
            } else if (page && (page !== warmPages.get(version) || sample.invalid || sample.refusal)) {
              warmPages.delete(version);
              await page.close().catch(() => {});
            }
          }

          if ((group.language === testedLanguage && candidate && version.startsWith('candidate-')) ||
              (isLiveWitnessControl(version, group.language) &&
                ['java', 'csharp', 'python'].includes(group.language)) ||
              (fixedWarmWitness && repeatPenaltyLanguages.includes(group.language))) {
            sample.cache = {
              initial: candidateCacheReceipt(
                sample.initial, group.language, sample.trustedCsharpArtifactKey),
              ...(sample.second && { second: candidateCacheReceipt(
                sample.second, group.language, sample.trustedCsharpArtifactKey) }),
            };
          }
          sample.wallMs = Date.now() - attemptStarted;
          sample.metrics = addressedBySample(sample);
          sample.kept = mode === 'run' && !sample.invalid && !sample.excluded && !sample.refusal;
          if (sample.invalid || sample.refusal) count.invalid++;
          else if (!sample.excluded) count.kept++;
          await appendFile(samplesPath, JSON.stringify(sample) + '\n');
          const shapeReceipt = uncapturedShapeGuard.observe(group, version, sample);
          if (shapeReceipt.action === 'fail-fast') {
            throw new Error(`Uncaptured shape rejected its first completed attempt: ${shapeReceipt.key}: ` +
              (sample.invalid ?? sample.refusal));
          }
          const submitPreflight = submitAfterRunPreflightAction(
            capturedSubmitAfterRun, group, sample);
          if (submitPreflight === 'reject') {
              throw new Error(`${group.language} Submit-after-Run preflight rejected its first ` +
                `complete attempt: ${sample.invalid ?? sample.refusal}`);
          }
          if (submitPreflight === 'capture') capturedSubmitAfterRun.add(group.language);
          if (pythonFreshAa && pythonFreshAaFailFast(groupIndex, group, sample)) {
            throw new Error('A/A C# repeat preflight rejected its first complete attempt: ' +
              (sample.invalid ?? sample.refusal));
          }
          if (submitAa && submitAaFailFast(groupIndex, sample)) {
            throw new Error('Submit A/A first-group preflight rejected its first complete attempt: ' +
              (sample.invalid ?? sample.refusal));
          }
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

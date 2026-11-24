// Invoked only on the build host. Extends the frozen baseline runner without
// altering its fixture loader, browser journeys, sample filters or clocks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const checkOnly = process.argv.includes('--check');
const [baselineArg, outArg, window, configArg, seed = '0212026', minutes = '90'] = process.argv.slice(2).filter((arg) => arg !== '--check');
assert.ok(baselineArg && outArg && configArg && ['phone', 'desktop-b'].includes(window),
  'Usage: run.mjs <frozen baseline directory> <staged out directory> phone|desktop-b <candidate manifest> [seed] [minutes]');
if (!checkOnly) assert.equal(process.env.SPEED_EXCLUSIVE_WINDOW, '1', 'An exclusive build-host window is required');
assert.equal(process.env.SPEED_GROUP_SELECTOR, undefined);
const baseline = resolve(baselineArg);
const out = resolve(outArg);
const config = JSON.parse(await readFile(configArg, 'utf8'));
const candidates = window === 'phone' ? ['concurrent', 'sequential'] : ['concurrent', 'concurrent-deploy'];
for (const policy of candidates) {
  const candidate = config[policy];
  assert.match(candidate.commit, /^[a-f0-9]{40}$/u);
  assert.match(candidate.tarballSha256, /^[a-f0-9]{64}$/u);
  assert.match(candidate.dependenciesSha256, /^[a-f0-9]{64}$/u);
  assert.match(candidate.dependencyLockSha256, /^[a-f0-9]{64}$/u);
  assert.match(candidate.packageVersion, /^[\d.]+(?:-[\w.-]+)?$/u);
}
if (window === 'phone') {
  assert.equal(config.concurrent.commit, config.sequential.commit);
  assert.notEqual(config.concurrent.tarballSha256, config.sequential.tarballSha256,
    'Supply the separately built one-engine control; a second copy of the concurrent artifact invalidates the A/B');
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const frozenRunner = await readFile(join(baseline, 'run.mjs'));
assert.equal(sha256(frozenRunner), '6f026b5b808cf63db8dbe6abb8644a96fbe5ca639823adc9d25c6349c6665abf');
assert.equal(sha256(await readFile(join(baseline, 'entry.ts'))), 'f68b7f870985c7c0e02f2e51af9a19e5f618526c63a1a583b16e7894df1a0646');
for (const [path, digest] of Object.entries({
  'fixture-digests.json': 'd13383f73e5cc6d4b5e910d8650df5650445973aa6a172de1e6d819b15784262',
  'dependency-locks/tree-sha256.json': '85dfeae5dc435ce926e1628669e6e0e3c196b6f9c1cbe19f898be4dd00e503f5',
  'dependency-locks/0.17.1.package-lock.json': 'eea0c08ceeb79a30c2bdcaf84f57874b26947419ed10dfd0b0f8a4f68ee117a3',
  'dependency-locks/0.20.1.package-lock.json': 'fe9e474ba7a0b84f464c8685bde066680977dcc23e1ffbe8fdcb8ba739329d7d',
})) {
  assert.equal(sha256(await readFile(join(baseline, path))), digest, path);
}
let source = frozenRunner.toString('utf8');
function edit(before, after) {
  assert.equal(source.split(before).length, 2, `Baseline transformation anchor changed: ${before}`);
  source = source.replace(before, () => after);
}
edit("import { chromium } from 'playwright';", `import { chromium } from 'playwright';
import { pythonCandidateCacheReceipt, pythonCandidateOutcome } from './python-candidate-witness.mjs';`);
edit("import { pythonCandidateCacheReceipt, pythonCandidateOutcome } from './python-candidate-witness.mjs';", `import { pythonCandidateCacheReceipt, pythonCandidateOutcome } from './python-candidate-witness.mjs';
import { pythonProductionControlOutcome } from './python-production-control-witness.mjs';`);
edit('const versions = Object.keys(appRefs);', `
const candidateInstalls = ${JSON.stringify(config)};
const candidateVersions = ${JSON.stringify(candidates)};
const submitControlVersions = windowName === 'desktop-b' ? ['0.20.1'] : [];
const measuredVersions = ['0.17.1', ...submitControlVersions, ...candidateVersions];
const versions = ['0.17.1', ...submitControlVersions, ...candidateVersions];
`);
edit('assert.equal(manifest.version, version);', 'assert.equal(manifest.version, candidateInstalls[version]?.packageVersion ?? version);');
edit("const tarball = 'tracecode-harness-' + version + '.tgz';", "const tarball = 'tracecode-harness-' + manifest.version + '.tgz';");
edit("assert.equal(integrity, appLockIntegrity[version], 'Tarball differs from the app lockfile');", `
  const candidate = candidateInstalls[version];
  if (candidate) assert.equal(sha256(tarballBytes), candidate.tarballSha256);
  else assert.equal(integrity, appLockIntegrity[version], 'Tarball differs from the app lockfile');
`);
edit('frozenDependencyHashes[version],', '(candidate?.dependenciesSha256 ?? frozenDependencyHashes[version]),');
edit('sha256(await readFile(expectedLock)),', '(candidate?.dependencyLockSha256 ?? sha256(await readFile(expectedLock))),');
edit("entryPoints: ['benchmarks/speed-baseline-021/entry.ts'],", "entryPoints: [new URL('./entry.ts', import.meta.url).pathname],");
edit('appRef: appRefs[version], tarball,', "appRef: appRefs[version] ?? appRefs['0.20.1'], ...(candidate ? { candidate } : {}), tarball,");
edit("stopSubmit: version === '0.20.1'", "stopSubmit: version !== '0.17.1' && version !== 'concurrent-deploy'");
edit("const target = mode === 'smoke' ? 1 : cpu === 4 || language === 'java' ? 12 : 20;", "const target = 20;");
edit("const cheapFirst = mode === 'smoke' ? windowLanguages.phone : windowLanguages[windowName];", "const cheapFirst = ['python'];");
edit('              language, cpu, problem, state, journey, target, versions,', `
              language, cpu, problem, state, journey, target,
              versions: language === 'python' && cpu === 1 && state === 'warm' && journey === 'submit'
                ? ['0.17.1', ...submitControlVersions, ...candidateVersions]
                : ['0.17.1', ...candidateVersions],`);
edit("versions: ['0.20.1']", "versions: ['0.17.1', 'concurrent']");
edit('        for (const [position, version] of shuffled(group.versions).entries()) {', `
          for (const [position, version] of (round % 2 === 1
            ? group.versions : [...group.versions].reverse()).entries()) {
`);
edit("  schema: 'tracecode.speed-baseline.v1',", `  schema: 'tracecode.speed-baseline.v1',
  liveControl: { control: '0.17.1', candidateVersions, alternatingOrderPerRound: true,
    ...(windowName === 'desktop-b' && { pythonWarmSubmitControl: '0.20.1' }) },`);
edit('  report.browser.version = browser.version();', `
  report.browser.version = browser.version();
  assert.match(report.browser.version, /^145\\./u, 'Expected frozen Chromium major 145');
`);

// Measure at the existing public response. The worker journal verifies the
// candidate labels from its actual command traffic and is read outside that
// clock. It records metadata only, with no sources, inputs or results.
edit('    await page.goto(url,', `
    if (measuredVersions.includes(version)) await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      const journal = window.pythonWorkerJournal = [];
      let id = 0;
      window.Worker = class extends NativeWorker {
        constructor(url, options) {
          super(url, options);
          const parsed = new URL(url, location.href);
          if (!parsed.pathname.endsWith('/python-worker.js') || parsed.searchParams.get('tracecodePythonRole') === 'runtime-image') return;
          const worker = ++id;
          journal.push({ worker, phase: 'worker-created', at: performance.now() });
          const active = new Map();
          const post = this.postMessage.bind(this);
          this.postMessage = (...args) => {
            const { id, type, payload } = args[0];
            if (['prepare-program', 'execute-prepared-program', 'execute-prepared-program-batch'].includes(type)) {
              const observation = payload.observationOnly === true || payload.artifact?.observationOnly === true;
              const command = {
                worker,
                id,
                role: observation ? 'observer' : payload.mode === 'code' ? 'ordinary' : 'legacy-trace',
                type,
                mode: payload.mode,
                observation,
                cases: payload.inputBatch?.length,
                tier: payload.artifact?.isolationProfile?.tier,
                stopAtFirstRunaway: payload.stopAtFirstRunaway,
                phase: 'send',
                at: performance.now(),
              };
              active.set(id, command);
              journal.push(command);
            }
            return post(...args);
          };
          const terminate = this.terminate.bind(this);
          this.terminate = () => {
            journal.push({ worker, phase: 'worker-terminated', at: performance.now() });
            return terminate();
          };
          this.addEventListener('message', ({ data }) => {
            const command = active.get(data?.id);
            if (!command) return;
            if (data.type === 'batch-case-progress') {
              journal.push({ ...command, phase: data.payload.phase, index: data.payload.index, at: performance.now() });
            } else {
              command.responseType = data.type;
              command.receivedAt = performance.now();
              command.timings = data.payload?.timings;
              command.tier ??= data.payload?.artifact?.isolationProfile?.tier;
              active.delete(data.id);
            }
          });
        }
      };
    });
    await page.goto(url,`);
edit('              sample.initial = await initial(page, fixture, group.journey, group.state === \'cold\');', `
              if (measuredVersions.includes(version)) await page.evaluate(() => { window.pythonWorkerJournal.length = 0; });
              sample.initial = await initial(page, fixture, group.journey, group.state === 'cold');
              if (measuredVersions.includes(version)) {
                sample.workerJournal = await page.evaluate(() => window.pythonWorkerJournal);
              }
`);
edit('                  sample.second = await second(page, fixture.cases[1].id);', `
                  if (measuredVersions.includes(version)) await page.evaluate(() => { window.pythonWorkerJournal.length = 0; });
                  sample.second = await second(page, fixture.cases[1].id);
                  if (measuredVersions.includes(version)) {
                    sample.secondWorkerJournal = await page.evaluate(() => window.pythonWorkerJournal);
                  }
`);
edit("                  if (!sample.invalid && !sample.second.evaluation.cases[0]?.traceEvents) sample.invalid = 'No second-case trace';", `
                  if (!sample.invalid && !sample.second.evaluation.cases[0]?.traceEvents) sample.invalid = 'No second-case trace';
                  if (sample.secondWorkerJournal && !sample.invalid) {
                    sample.invalid = pythonCandidateOutcome(
                      { workerJournal: sample.secondWorkerJournal },
                      'click',
                      1,
                      false,
                    );
                  }
                  if (sample.secondWorkerJournal) {
                    sample.cache ??= {};
                    sample.cache.second = pythonCandidateCacheReceipt({ workerJournal: sample.secondWorkerJournal });
                  }
`);
edit('              if (group.continuation && !sample.invalid && !sample.refusal) {', `
              if (sample.workerJournal && !sample.invalid) {
                const commands = sample.workerJournal;
                const ordinary = commands.filter(e => e.phase === 'send' && e.type === 'execute-prepared-program-batch' && e.mode === 'code');
                const observed = commands.filter(e => e.phase === 'send' && e.type === 'execute-prepared-program' && e.observation);
                const role = group.journey === 'submit' ? 'submit' : 'run';
                if (version === '0.17.1' || version === '0.20.1') {
                  sample.invalid = pythonProductionControlOutcome(
                    { workerJournal: commands },
                    role,
                    fixture.cases.length,
                  );
                } else if (version !== 'sequential') {
                  sample.invalid = pythonCandidateOutcome(
                    { workerJournal: commands },
                    role,
                    fixture.cases.length,
                    role === 'run' || version !== 'concurrent-deploy',
                  );
                }
                if (!sample.invalid && ordinary.length !== 1) sample.invalid = 'Expected one ordinary batch';
                else if (!sample.invalid && group.journey === 'submit' && observed.length) sample.invalid = 'Submit launched an observer';
                else if (!sample.invalid && group.journey !== 'submit') {
                  const ordinaryDone = ordinary[0].receivedAt;
                  const observerPrep = commands.find(e => e.phase === 'send' && e.type === 'prepare-program' && e.observation);
                  const first = observed[0];
                  if (observed.length !== 1 || !ordinaryDone || !observerPrep) sample.invalid = 'Missing ordinary or observer acknowledgment';
                  else if (version === 'sequential' && (first.worker !== ordinary[0].worker || observerPrep.at < ordinaryDone)) sample.invalid = 'Sequential control did not wait and reuse the ordinary worker';
                  else if ((version === 'concurrent' || version === 'concurrent-deploy') && first.worker === ordinary[0].worker) sample.invalid = 'Concurrent candidate reused the ordinary worker';
                  else sample.workerOverlap = observerPrep.at < ordinaryDone;
                }
                sample.cache = { initial: pythonCandidateCacheReceipt({ workerJournal: commands }) };
              }
              if (group.continuation && !sample.invalid && !sample.refusal) {
`);


edit("flatMap((c) => [c.failure, c.traceUnavailable])",
     "flatMap((c) => [c.failure, c.traceUnavailable, c.attachment?.status === 'refused' ? 'Observation refused: ' + c.attachment.reason : undefined])");
edit("if (sample.refusal) throw new Error(sample.refusal);",
     "if (sample.refusal && /login|sign in|unauthoriz|access denied/i.test(sample.refusal)) throw new Error(sample.refusal);");

const stage = await mkdtemp(join(process.cwd(), '.speed-b3-python-'));
try {
  for (const file of ['entry.ts', 'fixture-digests.json', 'dependency-locks']) {
    await cp(join(baseline, file), join(stage, file), { recursive: true });
  }
  await cp(new URL('./python-candidate-witness.mjs', import.meta.url),
    join(stage, 'python-candidate-witness.mjs'));
  await cp(new URL('./python-production-control-witness.mjs', import.meta.url),
    join(stage, 'python-production-control-witness.mjs'));

  const entry = join(stage, 'entry.ts');
  const entrySource = await readFile(entry, 'utf8');
  const traceAnchor = 'traceUnavailable: c.traceUnavailable,';
  assert.equal(entrySource.split(traceAnchor).length, 2);
  await writeFile(entry, entrySource.replace(traceAnchor, traceAnchor +
    ' attachment: c.attachment && { status: c.attachment.status, reason: c.attachment.reason },'));
  const wrapper = join(stage, 'run.mjs');
  await writeFile(wrapper, source);
  const args = checkOnly ? ['--check', wrapper] : [wrapper, out, 'run', window, seed, minutes];
  const child = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} finally {
  await rm(stage, { recursive: true, force: true });
}

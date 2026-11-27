import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metricEndpoints } from './aa-score-lib.mjs';
import { historicalPackageSha256 } from './java-runner/version-preparation.mjs';
import { workerThrottle022 } from './phone-cgroup-022.mjs';
import { phoneWarmAaPlan, phoneWarmAaRoundOrder, phoneWarmAaVersions } from './phone-warm-aa.mjs';
import { heavyCases022, production022, windowPlan022 } from './plan-022.mjs';
import { isRepeatWarmMode, warmMetricName } from './warm-repeat-policy.mjs';

const [root, rigCommit, launcher, tarball] = process.argv.slice(2);
assert.ok(root && rigCommit);
const json = (file, value) => writeFile(file, JSON.stringify(value) + '\n');
const jsonl = (file, rows) => writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
const metrics = (group, value) => Object.fromEntries(metricEndpoints(group).map((endpoint) =>
  [warmMetricName(group, endpoint), value]));

function runScorer(file, args, expectedExit) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url)), ...args],
    { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, expectedExit, `${file}\n${result.stderr}\n${result.stdout}`);
  console.log(JSON.stringify({ scorer: file, exit: result.status }));
  return result;
}

const aaDir = join(root, 'seeded-aa');
await mkdir(aaDir);
const prefix = 'seeded-phone-aa';
const labels = phoneWarmAaVersions;
const packagePin = { sha256: historicalPackageSha256['0.17.1'] };
await json(join(aaDir, prefix + '-metadata.json'), {
  phoneWarmAa: {
    sourceVersion: '0.17.1', labels, target: 20,
    languages: ['python', 'csharp'], cpu: 4, freshPagePerSample: true,
    repeatRun: true, alternatingOrderPerRound: true,
    tolerances: { medianRatio: 1.05, p90Ratio: 1.10 },
  },
  complete: true,
  packages: Object.fromEntries(labels.map((label) => [label, packagePin])),
  schedule: phoneWarmAaPlan,
});
const aaRowFile = join(aaDir, prefix + '-samples.jsonl');
const aaRows = phoneWarmAaPlan.flatMap((group, groupIndex) =>
  Array.from({ length: group.target }, (_, index) => {
    const round = index + 1;
    return phoneWarmAaRoundOrder(group.versions, round).map((version, position) => ({
      groupIndex, round, version, position, kept: true, cache: { initial: {} },
      metrics: metrics(group, 400),
      ...(isRepeatWarmMode(group) && { prime: {}, primeCache: {} }),
    }));
  }).flat());
const excluded = { ...aaRows[0], round: 21, kept: false, excluded: 'initial load > 2.0' };
await jsonl(aaRowFile, [excluded, ...aaRows]);
let result = runScorer('./score-phone-warm-aa.mjs', [aaDir, prefix], 0);
assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).summary.pass, true);

const aaFailed = aaRows.map((row) => row.groupIndex === 0 && row.version === labels[1]
  ? { ...row, metrics: metrics(phoneWarmAaPlan[0], 550) } : row);
await jsonl(aaRowFile, [excluded, ...aaFailed]);
result = runScorer('./score-phone-warm-aa.mjs', [aaDir, prefix], 1);
const aaScores = result.stdout.trim().split('\n').map(JSON.parse);
assert.equal(aaScores.at(-1).summary.pass, false);
assert.ok(aaScores.some(({ cell, pass }) => cell && pass));
assert.ok(aaScores.some(({ cell, pass }) => cell && !pass));

for (const disposition of ['invalid', 'refusal']) {
  await jsonl(aaRowFile, [{ ...excluded, excluded: undefined, [disposition]: `Seeded ${disposition}` },
    ...aaRows]);
  const bad = runScorer('./score-phone-warm-aa.mjs', [aaDir, prefix], 1);
  assert.match(bad.stderr, new RegExp(`Seeded ${disposition}`));
}

const [pass, fail, controlInvalid, repaired, partial] = windowPlan022().slice(0, 5);
const controlSha256 = production022.sha256;
const reference = join(root, 'seeded-reference.json');
const ref = (group, median, p90, aaPass = true) => metrics(group, { median, p90, aaPass });
await json(reference, { controlSha256, groups: {
  [pass.groupIndex]: ref(pass, 500, 500),
  [fail.groupIndex]: ref(fail, 500, 500),
  [controlInvalid.groupIndex]: ref(controlInvalid, 400, 400),
  [repaired.groupIndex]: ref(repaired, 500, 500),
  [partial.groupIndex]: ref(partial, 500, 500),
} });

function rows(group, control, candidate, count = group.target) {
  return group.versions.flatMap((version, versionIndex) =>
    Array.from({ length: count }, (_, index) => ({
      groupIndex: group.groupIndex, version, round: index + 1, kept: true,
      metrics: metrics(group, versionIndex === 0 ? control : candidate(index)),
    })));
}

async function session(name, schedule, rows) {
  const dir = join(root, name);
  await mkdir(dir);
  await json(join(dir, 'window-metadata.json'), {
    schema: 'tracecode.speed-022.window.v1', rigCommit, controlSha256,
    candidateSha256: 'a'.repeat(64), schedule,
  });
  await jsonl(join(dir, 'window-samples.jsonl'), rows);
  return dir;
}

const passRows = rows(pass, 500, () => 550);
const rejected = ['invalid', 'refusal', 'excluded'].map((reason, index) => ({
  ...passRows[0], round: pass.target + index + 1, kept: false,
  [reason]: `Seeded ${reason}`, metrics: metrics(pass, 10_000),
}));
const first = await session('seeded-session-one', [pass, fail, controlInvalid, repaired, partial],
  [...passRows, ...rejected, ...rows(fail, 500, (index) => index < 15 ? 500 : 560),
    ...rows(controlInvalid, 500, () => 500), ...rows(repaired, 1, () => 1, 1),
    ...rows(partial, 500, () => 500, 1)]);
const second = await session('seeded-session-two', [repaired], rows(repaired, 500, () => 500));
const formal = JSON.parse(runScorer('./score-022.mjs', [reference, first, second], 1).stdout);
const [passResult, failResult, controlResult, repairedResult, partialResult] = formal.groups;
assert.ok(passResult.cells.every(({ result }) => result === 'pass'));
assert.deepEqual(passResult.counts, { invalid: 1, refusal: 1, excluded: 1 });
assert.ok(failResult.cells.every(({ result, failed }) => result === 'fail' && failed.join() === 'p90'));
assert.ok(controlResult.cells.every(({ result }) => result === 'controlInvalid'));
assert.equal(repairedResult.source, second);
assert.ok(repairedResult.cells.every(({ result }) => result === 'pass'));
assert.equal(partialResult.incomplete, true);

const passing = await session('seeded-passing-session', [pass], passRows);
assert.equal(JSON.parse(runScorer('./score-022.mjs', [reference, passing], 0).stdout).pass, true);
await json(reference, { controlSha256, groups: { [pass.groupIndex]: ref(pass, 500, 500, false) } });
const failedAaReference = JSON.parse(runScorer('./score-022.mjs', [reference, passing], 1).stdout);
assert.ok(failedAaReference.groups[0].cells.every(({ result }) => result === 'controlInvalid'));
console.log('Seeded scorer outcomes passed: formal pass, formal fail, controlInvalid, A/A pass, A/A fail, partial, merge');

const phone = windowPlan022().find(({ cpu }) => cpu !== 1);
await json(reference, { controlSha256, groups: { [phone.groupIndex]: ref(phone, 500, 500) } });
const stampedPhone = await session('seeded-phone-session', [phone],
  rows(phone, 500, () => 500).map((row) => ({ ...row, workerThrottle: workerThrottle022 })));
const phoneScore = JSON.parse(runScorer('./score-022.mjs', [reference, stampedPhone], 0).stdout);
assert.equal(phoneScore.groups[0].workerThrottle, workerThrottle022);
assert.deepEqual(phoneScore.workerThrottle, [workerThrottle022]);
const unstampedPhone = await session('seeded-unstamped-phone-session', [phone], rows(phone, 500, () => 500));
assert.match(runScorer('./score-022.mjs', [reference, unstampedPhone], 1).stderr,
  /no known workerThrottle stamp/u);
console.log(`Phone rows carry "workerThrottle: ${workerThrottle022}" into the score; unstamped phone rows are rejected`);

const casesNearBand = { javascript: 3000, typescript: 999, java: 1000, cpp: 3069 };
const calibration = Object.keys(heavyCases022).map((language) =>
  ({ language, judgeMs: casesNearBand[language] ?? 2000 }));
const calibrationFile = join(root, 'seeded-calibration.json');
const warningReceipt = join(root, 'seeded-warning-receipt.json');
await json(calibrationFile, calibration);
execFileSync(process.execPath, [fileURLToPath(new URL('./selftest-receipt-022.mjs', import.meta.url)),
  'record', warningReceipt, rigCommit, controlSha256, calibrationFile]);
const warned = JSON.parse(await readFile(warningReceipt, 'utf8'));
assert.equal(warned.pass, true);
assert.deepEqual(warned.calibration, calibration);
assert.deepEqual(warned.calibrationOutsideBand, [
  { language: 'typescript', judgeMs: 999 },
  { language: 'cpp', judgeMs: 3069 },
]);

if (launcher && tarball) {
  const receipt = join(root, 'seeded-selftest-receipt.json');
  function checkWindow(archive, message, receiptFile = receipt) {
    // A nonexistent candidate also prevents a lock request if the gate regresses.
    const result = spawnSync('bash', [launcher, 'window', join(root, 'blocked-window'), archive,
      receiptFile, join(root, 'no-candidate.tgz'), 'a'.repeat(64), reference, '1'], { encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.ok(result.status > 0);
    assert.match(result.stderr, message);
  }
  checkWindow(tarball, /ENOENT.*seeded-selftest-receipt/u);
  const passReceipt = { schema: 'tracecode.speed-022.selftest.v1', pass: true,
    rigCommit, tarballSha256: controlSha256 };
  await json(receipt, { ...passReceipt, rigCommit: rigCommit.replace(/^./u, (first) => first === '0' ? '1' : '0') });
  checkWindow(tarball, /Self-test pass must match the rig commit/u);
  await json(receipt, { ...passReceipt, tarballSha256: '0'.repeat(64) });
  checkWindow(tarball, /Self-test pass must match the rig commit/u);
  await json(receipt, passReceipt);
  checkWindow(reference, /Published 0.21.0 tarball digest differs/u);
  console.log('Window gate rejected missing and stale receipts, and an unpinned tarball');
  checkWindow(tarball, /sha256sum: .*no-candidate\.tgz: No such file/u, warningReceipt);
  console.log('Window gate accepted a matching receipt with calibration warnings');
}

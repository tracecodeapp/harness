import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const [metadataPath, samplesPath, reportPath] = process.argv.slice(2);
assert.ok(reportPath, 'Usage: node report.mjs <metadata.json> <samples.jsonl> <SPEED-BASELINE.md>');
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
assert.equal(metadata.schema, 'tracecode.speed-baseline.v1');
assert.equal(metadata.mode, 'run', 'Smoke timings cannot establish a baseline');
const raw = await readFile(samplesPath, 'utf8');
const samples = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));

const names = {
  verdicts: 'Run verdicts',
  firstTrace: 'Run selected trace',
  secondTrace: 'Second case trace',
  submitVerdicts: 'Submit verdicts',
  lessonContinue: 'Lesson Run tests to Continue',
};
const langs = { cpp: 'C++', csharp: 'C#', java: 'Java', javascript: 'JavaScript', python: 'Python', typescript: 'TypeScript' };
const endpoints = {
  run: ['verdicts', 'firstTrace', 'secondTrace'],
  submit: ['submitVerdicts'],
  lesson: ['lessonContinue'],
};
const versions = Object.keys(metadata.appRefs);
const cells = new Map();
const acceptedLoads = { initial: [], continuation: [] };
const exclusions = { load: 0, invalid: 0 };
const invalidMessages = new Map();
const keysSeen = new Set();
const keyFor = (group, endpoint) =>
  [group.language, group.cpu, group.problem, group.state, endpoint].join('/');
for (const [index, group] of metadata.schedule.entries()) {
  assert.deepEqual(group.versions, group.journey === 'lesson' ? ['0.20.1'] : versions);
  for (const endpoint of endpoints[group.journey]) {
    const key = keyFor(group, endpoint);
    assert.ok(!cells.has(key), 'Repeated scheduled cell ' + key);
    cells.set(key, { index, group, endpoint, byVersion: Object.fromEntries(group.versions.map((v) => [v, []])) });
  }
}
for (const sample of samples) {
  const group = metadata.schedule[sample.groupIndex];
  assert.ok(group?.versions.includes(sample.version), 'Unexpected sampled group/version');
  for (const field of ['language', 'cpu', 'problem', 'state', 'journey']) assert.equal(sample[field], group[field]);
  const attemptKey = [sample.groupIndex, sample.version, sample.round].join('/');
  assert.ok(!keysSeen.has(attemptKey), 'Repeated attempt ' + attemptKey);
  keysSeen.add(attemptKey);
  if (!sample.kept) {
    const category = sample.excluded ? 'load' : 'invalid';
    exclusions[category]++;
    if (category === 'invalid') {
      const label = [sample.version, langs[sample.language], sample.cpu + '×', sample.problem,
        sample.state, sample.journey, sample.refusal ?? sample.invalid ?? 'Unspecified failure'].join(' / ');
      invalidMessages.set(label, (invalidMessages.get(label) ?? 0) + 1);
    }
    continue;
  }
  assert.ok(!sample.invalid && !sample.excluded && !sample.refusal);
  assert.ok(Number.isFinite(sample.beforeInitial.oneMinute) && sample.beforeInitial.oneMinute <= 2);
  acceptedLoads.initial.push(sample.beforeInitial.oneMinute);
  if (sample.journey === 'run') {
    assert.ok(Number.isFinite(sample.beforeSecond.oneMinute) && sample.beforeSecond.oneMinute <= 2);
    acceptedLoads.continuation.push(sample.beforeSecond.oneMinute);
  }
  for (const endpoint of endpoints[group.journey]) {
    const ms = sample.metrics[endpoint];
    assert.ok(Number.isFinite(ms) && ms > 0, attemptKey + '/' + endpoint);
    cells.get(keyFor(group, endpoint)).byVersion[sample.version].push(ms);
  }
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return { n };
  const median = (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2;
  const p90 = sorted[Math.ceil(n * 0.9) - 1];
  return { n, median, p90, min: sorted[0], max: sorted[n - 1], unstable: p90 > 1.5 * median };
}

function label(cell) {
  const { group, endpoint } = cell;
  return [langs[group.language], group.cpu === 1 ? 'Desktop' : 'Phone-class', group.problem, group.state, names[endpoint]];
}

const row = (columns) => '| ' + columns.join(' | ') + ' |';
const cellList = [...cells.values()].sort((a, b) =>
  label(a).slice(0, 4).join('/').localeCompare(label(b).slice(0, 4).join('/')) ||
  Object.keys(names).indexOf(a.endpoint) - Object.keys(names).indexOf(b.endpoint));
const unstable = [];
let completeCells = 0;
let versionedCells = 0;
let keptMetrics = 0;
const rows = cellList.map((cell) => row([
  ...label(cell),
  ...versions.map((version) => {
    const times = cell.byVersion[version];
    if (!times) return 'Unavailable';
    const result = stats(times);
    versionedCells++;
    if (result.n >= metadata.target) completeCells++;
    keptMetrics += result.n;
    if (result.unstable) unstable.push([...label(cell), version, (result.p90 / result.median).toFixed(2) + '×']);
    return result.n ? [result.n, result.median.toFixed(2), result.p90.toFixed(2)].join(' / ') +
      (result.unstable ? ' *' : '') : '0 / — / —';
  }),
]));
const complete = metadata.complete && completeCells === versionedCells;
const digest = createHash('sha256').update(raw).digest('hex');
const distribution = (values) => {
  const s = stats(values);
  return s.n ? [s.n, s.min.toFixed(2), s.median.toFixed(2), s.p90.toFixed(2), s.max.toFixed(2)] : [0, '—', '—', '—', '—'];
};

const lines = [
  '# Harness 0.21 speed baseline', '',
  complete ? '**Complete.** Each available versioned cell met the sample target.' :
    '**Incomplete.** The release speed gate cannot use this table as a complete baseline.',
  '',
  'The run kept ' + keptMetrics + ' endpoint timings across ' + completeCells + '/' + versionedCells +
    ' versioned cells with at least ' + metadata.target + ' samples. It excluded ' + exclusions.load +
    ' attempts for load and ' + exclusions.invalid + ' for an invalid result or runner error.',
  '',
  'Host ' + metadata.host.hostname + ', ' + metadata.host.logicalCpus + ' logical CPUs, kernel ' +
    metadata.host.kernel + ', Chromium ' + metadata.browser.version + '. UTC window ' + metadata.start +
    ' to ' + metadata.end + '. Pair order was randomized using seed ' + metadata.seed + '.',
  '',
  'Published tarballs and the app commits that supplied their execution policy.', '',
  row(['Version', 'App ref', 'Published npm tarball SHA-256']),
  row(['---', '---', '---']),
  ...versions.map((v) => row([v, '`' + metadata.appRefs[v] + '`', '`' + metadata.packages[v].sha256 + '`'])),
  '',
  'Raw attempts are in [' + basename(samplesPath) + '](./' + basename(samplesPath) + '), SHA-256 `' + digest +
    '`. [' + basename(metadataPath) + '](./' + basename(metadataPath) + ') has fixture hashes and resolved npm dependencies.',
  '',
  '## Timing boundary', '',
  '- Chromium served the installed tarballs’ workers from same-origin loopback pages without cross-origin isolation. ' +
    'Phone-class used the same Chrome environment and app budgets with CDP CPU throttling at 4×.',
  '- Binary Search uses 10 catalog cases. Permutations uses 12 catalog cases with recursive backtracking and larger results. ' +
    'Both versions use the same case data and unchanged reference source.',
  '- Warm pages settle runtime warmup before measurement and retain the same host for subsequent samples. ' +
    'Cold pages are fresh documents in the same version’s browser context, with runtime prewarm starting at the action. ' +
    'The context can reuse HTTP cache. Switched samples run the other problem first and dispose its execution on the same page.',
  '- Initial timings include bundle construction and end at the in-page Judge response. The selected trace and all verdicts ' +
    'arrive in that same response in both versions. The second-case clock starts at an immediate simulated click on the ' +
    'already-dispatched first background continuation. These clocks exclude React publication, paint, remote continuity, and cloud submission verification.',
  '- Main’s lesson finish calls Practice Run on a ready runtime and advances on a pass. The baseline uses a solved ' +
    'Binary Search program and ends when the passing verdicts reach the page. Deploy has no last-step Run tests action.',
  '- The median averages the middle pair for even sample counts. p90 uses nearest rank. An asterisk means p90 exceeds 1.5× the median.',
  '',
  '## One-minute load of kept actions', '',
  row(['Action', 'n', 'Min', 'Median', 'p90', 'Max']),
  row(['---', '---:', '---:', '---:', '---:', '---:']),
  row(['Initial Run, Submit or lesson', ...distribution(acceptedLoads.initial)]),
  row(['Second-case continuation', ...distribution(acceptedLoads.continuation)]),
  row(['All measured actions', ...distribution([...acceptedLoads.initial, ...acceptedLoads.continuation])]),
  '',
  '## Timing table', '',
  'Cells show n / median ms / p90 ms.', '',
  row(['Language', 'CPU class', 'Fixture', 'State', 'Journey', ...versions]),
  row(['---', '---', '---', '---', '---', ...versions.map(() => '---:')]),
  ...rows,
  '',
  '## Unstable cells', '',
  ...(unstable.length ? [
    row(['Language', 'CPU class', 'Fixture', 'State', 'Journey', 'Version', 'p90 / median']),
    row(['---', '---', '---', '---', '---', '---', '---:']),
    ...unstable.map(row),
  ] : ['None among recorded timings.']),
];
if (metadata.error) lines.push('', 'Run stopped with `' + metadata.error + '`.');
if (invalidMessages.size) {
  lines.push('', '## Invalid results and runner errors', '',
    ...[...invalidMessages].sort().map(([message, count]) => '- ' + count + ' × ' + message.replace(/\s+/g, ' ')));
}
await writeFile(reportPath, lines.join('\n') + '\n');
if (!complete) process.exitCode = 1;

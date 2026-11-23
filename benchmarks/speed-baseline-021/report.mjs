import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const [reportPath, ...files] = process.argv.slice(2);
assert.ok(reportPath && [2, 4, 6].includes(files.length),
  'Usage: node report.mjs <SPEED-BASELINE.md> <metadata.json> <samples.jsonl> [<metadata.json> <samples.jsonl>] ...');
const windows = [];
for (let i = 0; i < files.length; i += 2) {
  const [metadataPath, samplesPath] = files.slice(i, i + 2);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  assert.equal(metadata.schema, 'tracecode.speed-baseline.v1');
  assert.equal(metadata.mode, 'run', 'Smoke timings cannot establish a baseline');
  assert.ok(['desktop-a', 'desktop-b', 'phone'].includes(metadata.window));
  assert.equal(metadata.cpu, metadata.window === 'phone' ? 4 : 1);
  assert.ok(windows.every((w) => w.metadata.window !== metadata.window), 'Duplicate host window');
  const raw = await readFile(samplesPath, 'utf8');
  windows.push({
    metadata, metadataPath, samplesPath,
    digest: createHash('sha256').update(raw).digest('hex'),
    samples: raw.split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  });
}
const { metadata } = windows[0];
const historicalBareFsComparisons = new Set();
const tracejvmNode = (tree) => tree?.dependencies?.['@tracecode/tracejvm'];
const archiveNode = (tree) => tracejvmNode(tree)?.dependencies?.['tar-stream'];
const bareFsNode = (tree) => archiveNode(tree)?.dependencies?.['bare-fs'];

function assertDependencyTrees(reference, candidate, version) {
  const expectedTree = reference.packages[version].dependencies;
  const actualTree = candidate.packages[version].dependencies;
  if (isDeepStrictEqual(actualTree, expectedTree)) return;

  const [desktopB, other] = reference.window === 'desktop-b'
    ? [reference, candidate] : [candidate, reference];
  const matchesArchiveDependency = (metadata, expectedVersion) => {
    const tree = metadata.packages[version].dependencies;
    const entry = bareFsNode(tree);
    return tracejvmNode(tree)?.version === '0.4.1' &&
      archiveNode(tree)?.version === '3.2.0' && entry?.version === expectedVersion &&
      entry.resolved === 'https://registry.npmjs.org/bare-fs/-/bare-fs-' + expectedVersion + '.tgz';
  };
  const historicalArchiveDrift = desktopB.window === 'desktop-b' &&
    ['desktop-a', 'phone'].includes(other.window) &&
    matchesArchiveDependency(desktopB, '4.8.5') && matchesArchiveDependency(other, '4.8.6');
  if (!historicalArchiveDrift) {
    assert.deepEqual(actualTree, expectedTree);
    return;
  }

  const comparableTree = structuredClone(actualTree);
  const actualBareFs = bareFsNode(comparableTree);
  const expectedBareFs = bareFsNode(expectedTree);
  actualBareFs.version = expectedBareFs.version;
  actualBareFs.resolved = expectedBareFs.resolved;
  assert.deepEqual(comparableTree, expectedTree);
  historicalBareFsComparisons.add(other.window + ' / Harness ' + version);
}

for (const [index, { metadata: reference }] of windows.entries()) {
  for (const { metadata: candidate } of windows.slice(index + 1)) {
    assert.deepEqual(candidate.appRefs, reference.appRefs);
    assert.deepEqual(candidate.host, reference.host);
    assert.deepEqual(candidate.browser, reference.browser);
    assert.deepEqual(candidate.fixtures, reference.fixtures);
    for (const version of Object.keys(reference.appRefs)) {
      assert.equal(candidate.packages[version].sha256, reference.packages[version].sha256);
      assertDependencyTrees(reference, candidate, version);
    }
  }
}

const names = {
  verdicts: 'Run verdicts',
  firstTrace: 'Run selected trace',
  secondTrace: 'Second case trace',
  submitVerdicts: 'Submit verdicts',
  lessonContinue: 'Lesson Run tests to Continue',
};
const langs = { cpp: 'C++', csharp: 'C#', java: 'Java', javascript: 'JavaScript', python: 'Python', typescript: 'TypeScript' };
const endpoints = (group) => {
  if (group.journey === 'run') {
    const run = ['verdicts', 'firstTrace'];
    if (group.continuation) run.push('secondTrace');
    return run;
  }
  return group.journey === 'submit' ? ['submitVerdicts'] : ['lessonContinue'];
};
const versions = Object.keys(metadata.appRefs);
const cells = new Map();
const acceptedLoads = { initial: [], continuation: [] };
const exclusions = { load: 0, invalid: 0 };
const invalidMessages = new Map();
const keysSeen = new Set();
const keyFor = (group, endpoint) =>
  [group.language, group.cpu, group.problem, group.state, endpoint].join('/');
for (const window of windows) {
  for (const [index, group] of window.metadata.schedule.entries()) {
    assert.equal(group.cpu, window.metadata.cpu);
    assert.equal(group.target, group.cpu === 4 || group.language === 'java' ? 12 : 20);
    assert.deepEqual(group.versions, group.journey === 'lesson' ? ['0.20.1'] : versions);
    for (const endpoint of endpoints(group)) {
      const key = keyFor(group, endpoint);
      assert.ok(!cells.has(key), 'Repeated scheduled cell ' + key);
      cells.set(key, { index, group, endpoint, byVersion: Object.fromEntries(group.versions.map((v) => [v, []])) });
    }
  }
  for (const sample of window.samples) {
    const group = window.metadata.schedule[sample.groupIndex];
    assert.ok(group?.versions.includes(sample.version), 'Unexpected sampled group/version');
    for (const field of ['language', 'cpu', 'problem', 'state', 'journey', 'target', 'continuation']) assert.equal(sample[field], group[field]);
    const attemptKey = [window.metadata.window, sample.groupIndex, sample.version, sample.round].join('/');
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
    if (group.continuation) {
      assert.ok(Number.isFinite(sample.beforeSecond.oneMinute) && sample.beforeSecond.oneMinute <= 2);
      acceptedLoads.continuation.push(sample.beforeSecond.oneMinute);
    }
    for (const endpoint of endpoints(group)) {
      const ms = sample.metrics[endpoint];
      assert.ok(Number.isFinite(ms) && ms > 0, attemptKey + '/' + endpoint);
      cells.get(keyFor(group, endpoint)).byVersion[sample.version].push(ms);
    }
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
    if (result.n >= cell.group.target) completeCells++;
    keptMetrics += result.n;
    if (result.unstable) unstable.push([...label(cell), version, (result.p90 / result.median).toFixed(2) + '×']);
    return result.n ? [result.n, result.median.toFixed(2), result.p90.toFixed(2)].join(' / ') +
      (result.unstable ? ' *' : '') : '0 / — / —';
  }),
]));
const versionedFullMatrix = Object.keys(langs).length * (2 * 3 * 4 * versions.length + 1 + 2 * 2 * 2 * versions.length);
const complete = windows.length === 3 && windows.every((w) => w.metadata.complete) &&
  completeCells === versionedCells && completeCells === versionedFullMatrix;
const targetText = '20 per desktop cell and 12 per Java or phone-class cell';
const distribution = (values) => {
  const s = stats(values);
  return s.n ? [s.n, s.min.toFixed(2), s.median.toFixed(2), s.p90.toFixed(2), s.max.toFixed(2)] : [0, '—', '—', '—', '—'];
};

const lines = [
  '# Harness 0.21 speed baseline', '',
  complete ? '**Complete.** Each available versioned cell met the sample target.' :
    '**Incomplete.** The release speed gate cannot use this table as a complete baseline.',
  '',
  'The run kept ' + keptMetrics + ' endpoint timings across ' + completeCells + '/' + versionedFullMatrix +
    ' planned versioned cells at the target of ' + targetText + '. It excluded ' + exclusions.load +
    ' attempts for load and ' + exclusions.invalid + ' for an invalid result or runner error.',
  '',
  'Host ' + metadata.host.hostname + ', ' + metadata.host.logicalCpus + ' logical CPUs, kernel ' +
    metadata.host.kernel + ', Chromium ' + metadata.browser.version + '. Version order was randomized within matched rounds.',
  '',
  ...windows.map(({ metadata: w }) => '- ' + w.window +
    ' UTC window ' + w.start + ' to ' + w.end + ', seed ' + w.seed + '.'),
  '',
  'Published tarballs and the app commits that supplied their execution policy.', '',
  row(['Version', 'App ref', 'Published npm tarball SHA-256']),
  row(['---', '---', '---']),
  ...versions.map((v) => row([v, '`' + metadata.appRefs[v] + '`', '`' + metadata.packages[v].sha256 + '`'])),
  '',
  ...windows.map(({ samplesPath, metadataPath, digest }) =>
    '- [' + basename(samplesPath) + '](./' + basename(samplesPath) + '), SHA-256 `' + digest +
    '`. [' + basename(metadataPath) + '](./' + basename(metadataPath) + ') has fixture hashes and resolved npm dependencies.'),
  ...(historicalBareFsComparisons.size ? [
    '',
    '**Historical Node archive dependency.** Desktop B installed `bare-fs` 4.8.5 and the following comparisons installed 4.8.6 under ' +
    '`@tracecode/tracejvm > tar-stream > bare-fs` (' + [...historicalBareFsComparisons].join(', ') + '). ' +
    'Only that node’s version and corresponding registry URL may differ.',
    '',
    'A scan of the 39 served JavaScript and source-map files for each installed release, including the page entry and every worker, ' +
    'found no `bare-fs`, `tar-stream`, `bare-os`, `node-gyp-build` or native binding markers. ' +
    'The packaged TraceJVM 0.4.1 Node archive extractor imports `tar-stream` before the browser starts. ' +
    'Its 3.2.0 manifest selects `bare-fs` for the Bare runtime and built-in `fs` on Node.',
  ] : []),
  '',
  '## Timing boundary', '',
  '- Chromium served the installed tarballs’ workers from same-origin loopback pages without cross-origin isolation. ' +
    'Phone-class used the same Chrome environment and app budgets with CDP CPU throttling at 4×. ' +
    'It covers only warm and cold Run verdicts and selected traces under the coordinator’s revised scope.',
  '- Deploy Submit includes the passing Binary Search complexity fact. Main Submit uses the case-only policy and ' +
    'sets stopAtFirstRunaway for every language except Python.',
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
  '## Attempts by host window', '',
  row(['Window', 'Kept attempts', 'Excluded for load', 'Invalid other']),
  row(['---', '---:', '---:', '---:']),
  ...windows.map(({ metadata: window, samples }) => row([
    window.window,
    samples.filter((s) => s.kept).length,
    samples.filter((s) => s.excluded).length,
    samples.filter((s) => !s.kept && !s.excluded).length,
  ])),
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
for (const { metadata: window } of windows) {
  if (window.error) lines.push('', window.window +
    ' run stopped with `' + window.error + '`.');
}
if (windows.length < 3) {
  const missing = ['desktop-a', 'desktop-b', 'phone'].filter((id) => windows.every((w) => w.metadata.window !== id));
  lines.push('', 'Missing windows ' + missing.join(', ') + '.');
}
if (invalidMessages.size) {
  lines.push('', '## Invalid results and runner errors', '',
    ...[...invalidMessages].sort().map(([message, count]) => '- ' + count + ' × ' + message.replace(/\s+/g, ' ')));
}
await writeFile(reportPath, lines.join('\n') + '\n');
if (!complete) process.exitCode = 1;

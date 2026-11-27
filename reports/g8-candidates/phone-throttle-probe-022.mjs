// P27-F: does the 0.22 phone cap reach the main thread and Workers, and only the rig's Chromium?
//
// The arms, spin loop, Worker and static server are P27-C's probe (42c79e66,
// benchmarks/p27-diag/worker-throttle-probe.mjs). The phone side now launches through
// launchCapped022 and cdpRate022, the same helpers the rig uses for its phone browser.
//
// Profiles: desktop  - plain launch, CDP rate 1 (the 1x reference)
//           cdp4     - plain launch, CDP rate 4 (the old phone profile; the calibration target)
//           phone    - launchCapped022, CDP rate 1 (the new phone profile)
// Arms:     A          the main thread
//           B          a Worker created after the CDP call (the rig's order)
//           burst      a Worker running a 20 ms loop 50 times with idle gaps (R4)
//           concurrent the main thread and a Worker spinning together (R5)
//           outside    a plain node loop outside the cgroup, running throughout (R7)
//
// Usage: node phone-throttle-probe-022.mjs dryrun|selftest|hold <new-out-dir>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { availableParallelism, cpus, hostname, loadavg, release } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  assertLayout022, assertNoLeftovers022, cdpRate022, launchCapped022, newRunId022, phoneCap022,
  workerThrottle022,
} from './phone-cgroup-022.mjs';

const [mode, outArg] = process.argv.slice(2);
assert.ok(['dryrun', 'selftest', 'hold'].includes(mode) && outArg,
  'Usage: phone-throttle-probe-022.mjs dryrun|selftest|hold <new-out-dir>');
const out = resolve(outArg);
await mkdir(out);

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const deps = process.env.SPEED_G8_RUNNER_DEPS ?? '/root/ci/g8-candidates.qHpuBwkE/node_modules';
    return createRequire(join(deps, 'resolve.js'))('playwright');
  }
}
const { chromium } = await loadPlaywright();
const launchOptions = { channel: 'chromium', headless: true };
const runId = process.env.SPEED_RIG_022_CGROUP_RUN ?? newRunId022();
const epochNow = () => performance.timeOrigin + performance.now();
const factor = phoneCap022.factor;
const TRIALS = mode === 'dryrun' ? 10 : 3;
const TARGET_MS = 700;
const BURST_MS = 20;
const BURSTS = 50;
const BURST_GAP_MS = 30;

const noneAtStart = assertNoLeftovers022('at start');
const layout = assertLayout022();

// --- P27-C's spin loop and Worker, plus the burst message ---
const spinSource = `
function spin(n) {
  let x = 0x12345678 | 0, s = 0;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    s = (s + (x & 1023)) | 0;
  }
  return s;
}
function timed(n) {
  spin(Math.max(1, Math.floor(n / 50)));
  const start = performance.now();
  const checksum = spin(n);
  return { ms: performance.now() - start, checksum };
}
`;
const workerSource = spinSource + `
self.onmessage = async ({ data }) => {
  if (data.type === 'ping') return self.postMessage({ type: 'ready' });
  if (data.type === 'run') return self.postMessage({ type: 'result', ...timed(data.n) });
  if (data.type === 'bursts') {
    spin(data.n);
    const ms = [];
    for (let i = 0; i < data.count; i++) {
      await new Promise((ready) => setTimeout(ready, data.gapMs));
      const start = performance.now();
      spin(data.n);
      ms.push(performance.now() - start);
    }
    return self.postMessage({ type: 'bursts', ms });
  }
};
`;

// --- static site: P27-C's server (the run-g8.mjs serve() headers) ---
const site = join(out, 'site');
await mkdir(site);
await writeFile(join(site, 'index.html'), '<!doctype html><meta charset="utf-8">');
await writeFile(join(site, 'probe-worker.js'), workerSource);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
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
const url = 'http://127.0.0.1:' + server.address().port;

async function pageCreateWorker() {
  window.probeWorker = new Worker('/probe-worker.js', { type: 'module' });
  await new Promise((ready, fail) => {
    window.probeWorker.onerror = (event) => fail(new Error('worker error ' + event.message));
    window.probeWorker.onmessage = ({ data }) => data.type === 'ready' && ready();
    window.probeWorker.postMessage({ type: 'ping' });
  });
  return { crossOriginIsolated };
}
async function pageRunWorker(n) {
  return await new Promise((done) => {
    window.probeWorker.onmessage = ({ data }) => data.type === 'result' && done(data);
    window.probeWorker.postMessage({ type: 'run', n });
  });
}
async function pageBursts({ n, count, gapMs }) {
  return await new Promise((done) => {
    window.probeWorker.onmessage = ({ data }) => data.type === 'bursts' && done(data);
    window.probeWorker.postMessage({ type: 'bursts', n, count, gapMs });
  });
}
const concurrentSource = (n) => `(async () => {
  ${spinSource}
  const worker = new Promise((done) => {
    window.probeWorker.onmessage = ({ data }) => data.type === 'result' && done(data);
  });
  window.probeWorker.postMessage({ type: 'run', n: ${n} });
  const main = timed(${n});
  return { main, worker: await worker };
})()`;

// --- browsers: desktop (plain) and phone (capped) ---
const desktop = await chromium.launch(launchOptions);
const capped = await launchCapped022(chromium, { runId, workDir: out, launchOptions });
assert.equal(capped.browser.version(), desktop.version(), 'Phone and desktop Chromium differ');
const contexts = { desktop: await desktop.newContext(), cdp4: await desktop.newContext(),
  phone: await capped.browser.newContext() };
const rateOf = { desktop: cdpRate022(1, false), cdp4: 4, phone: cdpRate022(factor, true) };
const log = join(out, 'trials.jsonl');
await writeFile(log, '');
let membershipWithWorker;

// The rig's page path: newPage, newCDPSession, setCPUThrottlingRate, goto.
async function openProbePage(profile) {
  const page = await contexts[profile].newPage();
  const cdp = await contexts[profile].newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: rateOf[profile] });
  await page.goto(url, { waitUntil: 'load' });
  return page;
}

async function trial(profile, arm, n) {
  const record = { profile, arm, n, rate: rateOf[profile], load1Before: loadavg()[0] };
  const page = await openProbePage(profile);
  try {
    if (arm !== 'A') record.isolation = await page.evaluate(pageCreateWorker);
    if (profile === 'phone' && arm !== 'A' && !membershipWithWorker) {
      membershipWithWorker = capped.membership({ requireRenderer: true });
    }
    record.start = epochNow();
    if (arm === 'A') {
      Object.assign(record, await page.evaluate(`(() => { ${spinSource}; return timed(${n}); })()`));
    } else if (arm === 'B') {
      Object.assign(record, await page.evaluate(pageRunWorker, n));
    } else if (arm === 'burst') {
      record.burstMs = (await page.evaluate(pageBursts, { n, count: BURSTS, gapMs: BURST_GAP_MS })).ms;
    } else if (arm === 'concurrent') {
      const { main, worker } = await page.evaluate(concurrentSource(n));
      Object.assign(record, { mainMs: main.ms, workerMs: worker.ms });
    }
    record.end = epochNow();
  } finally {
    record.load1After = loadavg()[0];
    await page.close().catch(() => {});
  }
  await appendFile(log, JSON.stringify(record) + '\n');
  return record;
}

const median = (xs) => {
  assert.ok(xs.length, 'No samples');
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const round3 = (value) => Math.round(value * 1000) / 1000;

if (mode === 'hold') {
  // The killed-run check: a Worker spins inside the scope until this launcher is killed with -9.
  const page = await openProbePage('phone');
  await page.evaluate(pageCreateWorker);
  page.evaluate(pageRunWorker, 4e10).catch(() => {});
  await delay(1_000);
  const ready = { pid: process.pid, unit: capped.unit, cgroup: capped.cgroup,
    watchdogPid: capped.receipt.watchdogPid, membership: capped.membership({ requireRenderer: true }) };
  await writeFile(join(out, 'ready.json'), JSON.stringify(ready, null, 2) + '\n');
  console.log(JSON.stringify({ kind: 'hold-ready', ...ready, membership: undefined,
    processes: ready.membership.processes.length, threads: ready.membership.threads }));
  await new Promise(() => {});
}

// --- the outside loop (R7): a plain node process beside the browsers, never in the scope ---
const outsideSource = `
${spinSource}
let n = 100000;
for (;;) { const s = performance.now(); spin(n); if (performance.now() - s >= 25) break; n *= 2; }
let stop = false;
process.stdin.on('end', () => { stop = true; }).resume();
(function chunk() {
  if (stop) return process.exit(0);
  const start = performance.timeOrigin + performance.now();
  spin(n);
  process.stdout.write(start + ' ' + (performance.timeOrigin + performance.now()) + '\\n');
  setImmediate(chunk);
})();
`;
let outside;
const outsideChunks = [];
if (mode === 'dryrun') {
  outside = spawn(process.execPath, ['-e', outsideSource], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buffered = '';
  outside.stdout.on('data', (data) => {
    buffered += data;
    const lines = buffered.split('\n');
    buffered = lines.pop();
    for (const line of lines) outsideChunks.push(line.split(' ').map(Number));
  });
  await delay(500);
}
const outsideCgroup = outside && readFileSync(`/proc/${outside.pid}/cgroup`, 'utf8').trim();
if (outside) assert.ok(!outsideCgroup.includes(phoneCap022.unitPrefix), 'Outside loop is inside the rig scope');

// --- calibration at 1x inside a Worker (P27-C's B path), confirmed on the main thread ---
let n = 2_000_000;
const calibration = [];
for (let attempt = 0; attempt < 8; attempt++) {
  const { ms } = await trial('desktop', 'B', n);
  calibration.push({ n, ms });
  if (ms >= 500 && ms <= 1000) break;
  n = Math.max(1, Math.round(n * TARGET_MS / Math.max(ms, 1)));
}
const mainCheck = await trial('desktop', 'A', n);
calibration.push({ n, ms: mainCheck.ms, thread: 'main' });
let burstN = Math.max(1, Math.round(n * BURST_MS / mainCheck.ms));
if (mode === 'dryrun') {
  const probe = await trial('desktop', 'burst', burstN);
  burstN = Math.max(1, Math.round(burstN * BURST_MS / median(probe.burstMs)));
  calibration.push({ burstN, probeMedianMs: median(probe.burstMs) });
}

const aloneWindows = [];
async function alone(ms) {
  const start = epochNow();
  await delay(ms);
  aloneWindows.push([start, epochNow()]);
}
if (outside) await alone(3_000);

const trials = [];
const arms = ['A', 'B'];
for (let round = 0; round < TRIALS; round++) {
  const profiles = round % 2 === 0 ? ['desktop', 'phone'] : ['phone', 'desktop'];
  if (mode === 'dryrun') profiles.push('cdp4');
  for (const arm of arms.map((_, i) => arms[(i + round) % arms.length])) {
    for (const profile of profiles) trials.push(await trial(profile, arm, n));
  }
}
if (mode === 'dryrun') {
  for (let round = 0; round < 2; round++) {
    for (const profile of round % 2 === 0 ? ['desktop', 'phone'] : ['phone', 'desktop']) {
      trials.push(await trial(profile, 'burst', burstN));
    }
  }
  for (let round = 0; round < 5; round++) {
    for (const profile of round % 2 === 0 ? ['desktop', 'phone'] : ['phone', 'desktop']) {
      trials.push(await trial(profile, 'concurrent', n));
    }
  }
  await alone(3_000);
}

const pick = (profile, arm, field = 'ms') =>
  trials.filter((t) => t.profile === profile && t.arm === arm).flatMap((t) => t[field]);
const ratio = (arm, field = 'ms', profile = 'phone') =>
  round3(median(pick(profile, arm, field)) / median(pick('desktop', arm, field)));
const summary = {
  A: { desktopMs: median(pick('desktop', 'A')), phoneMs: median(pick('phone', 'A')), ratio: ratio('A') },
  B: { desktopMs: median(pick('desktop', 'B')), phoneMs: median(pick('phone', 'B')), ratio: ratio('B') },
};
if (mode === 'dryrun') {
  summary.cdp4 = { A: ratio('A', 'ms', 'cdp4'), B: ratio('B', 'ms', 'cdp4') };
  summary.burst = { bursts: BURSTS, gapMs: BURST_GAP_MS, n: burstN,
    desktopMs: median(pick('desktop', 'burst', 'burstMs')), phoneMs: median(pick('phone', 'burst', 'burstMs')),
    ratio: ratio('burst', 'burstMs') };
  summary.concurrent = { main: ratio('concurrent', 'mainMs'), worker: ratio('concurrent', 'workerMs'),
    desktopMainMs: median(pick('desktop', 'concurrent', 'mainMs')),
    desktopWorkerMs: median(pick('desktop', 'concurrent', 'workerMs')) };
  outside.stdin.end();
  await new Promise((done) => outside.once('exit', done));
  const inside = (chunk, windows) => windows.some(([start, end]) => chunk[0] >= start && chunk[1] <= end);
  const windowsOf = (profile) => trials.filter((t) => t.profile === profile).map((t) => [t.start, t.end]);
  const ms = (chunks) => chunks.map(([start, end]) => end - start);
  const aloneMs = ms(outsideChunks.filter((chunk) => inside(chunk, aloneWindows)));
  const phoneMs = ms(outsideChunks.filter((chunk) => inside(chunk, windowsOf('phone'))));
  summary.outside = { cgroup: outsideCgroup, aloneChunks: aloneMs.length, phoneChunks: phoneMs.length,
    aloneMs: median(aloneMs), duringPhoneMs: median(phoneMs), ratio: round3(median(phoneMs) / median(aloneMs)) };
}

const membershipEnd = capped.membership({ requireRenderer: false });
const removal = await capped.remove();
await desktop.close();
server.close();
const noneAtEnd = assertNoLeftovers022('at end');

const within = (value, target, tolerance) => Math.abs(value / target - 1) <= tolerance;
const checks = mode === 'dryrun' ? {
  mainThreadAtFactor: within(summary.A.ratio, factor, 0.15),
  workerAtFactor: within(summary.B.ratio, factor, 0.15),
  burstWithin25Percent: within(summary.burst.ratio, factor, 0.25),
  calibratedAgainstCdp4Main: within(summary.A.ratio, summary.cdp4.A, 0.10),
  outsideUnaffected: within(summary.outside.ratio, 1, 0.15),
  snapshotsIdentical: removal.snapshotsIdentical,
} : {
  // Self-test: P27-C's arm B reaches at least 3x, and arm A stays near the factor, not doubled.
  workerAtLeast3x: summary.B.ratio >= 3,
  mainThreadNearFactor: within(summary.A.ratio, factor, 0.25),
  snapshotsIdentical: removal.snapshotsIdentical,
};
const failures = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
const report = {
  lane: 'h022-p27f', mode, jobLogId: process.env.HEAVY_JOBLOG_ID ?? null, pass: failures.length === 0, failures,
  host: hostname(), kernel: release(), cores: availableParallelism(), cpuModel: cpus()[0]?.model,
  browser: desktop.version(), launch: launchOptions, workerThrottle: workerThrottle022,
  cap: capped.receipt, layout, membershipWithWorker, membershipEnd, removal, noneAtStart, noneAtEnd,
  n, calibration, summary, checks,
  load1: { max: Math.max(...trials.map((t) => Math.max(t.load1Before, t.load1After))) },
};
await writeFile(join(out, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
const line = mode === 'dryrun'
  ? `P27-F dry run ${report.jobLogId}: main thread ${summary.A.ratio}x, Worker ${summary.B.ratio}x, ` +
    `burst ${summary.burst.ratio}x, concurrent main ${summary.concurrent.main}x / Worker ` +
    `${summary.concurrent.worker}x, outside loop ${summary.outside.ratio}x (CDP-4 main ` +
    `${summary.cdp4.A}x, Worker ${summary.cdp4.B}x), ${workerThrottle022}, path snapshots identical, ` +
    `nothing left under /sys/fs/cgroup${report.pass ? '' : '; FAILED ' + failures.join(',')}`
  : `P27-F probe self-test: main thread ${summary.A.ratio}x, Worker ${summary.B.ratio}x, ` +
    `${workerThrottle022}${report.pass ? '' : '; FAILED ' + failures.join(',')}`;
await writeFile(join(out, 'receipt.txt'), line + '\n');
console.log(line);
process.exitCode = report.pass ? 0 : 1;

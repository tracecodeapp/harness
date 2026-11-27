// The 0.22 phone CPU cap (lane P27-F). Chromium refuses CDP CPU throttling on Worker targets, so
// the phone profile runs its own Chromium in a transient systemd scope whose cgroup v2 cpu.max caps
// the CPU time of every thread in the browser's process tree: the page main thread, DedicatedWorker
// threads and V8 background threads alike.
//
// Safety rules (PHASE1-CONTRACTS.md, P27-F, conditions 1-5 and R1-R7):
// - The scope is created only by `systemd-run --scope`, as the exec of Chromium itself, so only the
//   rig's Chromium is ever inside it. Nothing here does mkdir in, or writes any file to, a cgroup.
// - The parent slice must already delegate `cpu`; nothing changes cgroup.subtree_control anywhere.
// - Every launch snapshots each pre-existing cgroup on the path before and after, and they must match.
// - The scope is removed with `systemctl kill`; a detached watchdog does the same if the launcher dies.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, openSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const phoneCap022 = Object.freeze({
  // The target is CDP 4x's main-thread slowdown (P27-C: 4.04x). A 25% quota overshoots it, because
  // the browser's other threads also spend the budget. Calibration job
  // 20261127T071445.816044335-3561100 measured the main thread against CDP 4x in the same job:
  // 2500 us 4.54x / 4.16x, 2750 us 4.03x / 4.15x, 3000 us 3.56x / 4.11x. The quota is 2750 us.
  factor: 4,
  cpuQuotaPercent: 27.5,
  periodUs: 10_000,
  quotaUs: 2_750,
  slice: 'system.slice',
  unitPrefix: 'h022-p27f-',
});
export const workerThrottle022 = `cgroup-cpu.max ${phoneCap022.quotaUs} ${phoneCap022.periodUs}`;
// Stamp for CPU-4 cells measured with the CDP throttle alone, which does not reach Workers.
export const cdpOnlyWorkerThrottle = 'none';

const cgroupRoot = '/sys/fs/cgroup';
const runIdPattern = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const watchdog = fileURLToPath(new URL('./phone-cgroup-watchdog-022.sh', import.meta.url));

// The CDP rate for a page. A capped phone page gets rate 1, so nothing is throttled twice.
export function cdpRate022(cpu, capped) {
  return capped && cpu !== 1 ? 1 : cpu;
}

export function unitName022(runId) {
  assert.match(runId, runIdPattern, 'Rig cgroup run id must be a lowercase token');
  return `${phoneCap022.unitPrefix}${runId}.scope`;
}

export function newRunId022() {
  return `${new Date().toISOString().replace(/[-:]/gu, '').replace(/\..*$/u, '').toLowerCase()}-${process.pid}`;
}

function systemctl(args, { allowFailure = false } = {}) {
  const result = spawnSync('systemctl', ['--no-pager', ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (!allowFailure) assert.equal(result.status, 0, `systemctl ${args.join(' ')}: ${result.stderr}`);
  return result;
}

function loadState(unit) {
  return systemctl(['show', '-p', 'LoadState', '--value', unit], { allowFailure: true }).stdout.trim();
}

// Every rig unit and rig cgroup on the host, from any run.
export function leftovers022() {
  const units = systemctl(['list-units', '--all', '--plain', '--no-legend', `${phoneCap022.unitPrefix}*`])
    .stdout.split('\n').map((line) => line.trim().split(/\s+/u)[0]).filter(Boolean);
  const found = spawnSync('find', [cgroupRoot, '-xdev', '-type', 'd', '-name', `${phoneCap022.unitPrefix}*`],
    { encoding: 'utf8' });
  if (found.error) throw found.error;
  const cgroups = found.stdout.split('\n').filter(Boolean);
  return { units, cgroups };
}

export function assertNoLeftovers022(when) {
  const left = leftovers022();
  assert.ok(!left.units.length && !left.cgroups.length,
    `Leftover rig cgroup ${when}: ${JSON.stringify(left)}`);
  return { when, units: 0, cgroups: 0, listing: `find ${cgroupRoot} -name '${phoneCap022.unitPrefix}*': empty` };
}

const readTrim = (file) => readFileSync(file, 'utf8').trim();

// R2: the pre-existing cgroups on the path to the scope, read only.
export function snapshotPath022(slice = phoneCap022.slice) {
  return ['/', `/${slice}`].map((path) => {
    const dir = join(cgroupRoot, path);
    return {
      path,
      subtreeControl: readTrim(join(dir, 'cgroup.subtree_control')),
      cpuMax: readTrim(join(dir, 'cpu.max')),
      cpuWeight: readTrim(join(dir, 'cpu.weight')),
      // Processes directly in this cgroup (not its descendants, which other teams start and stop).
      processes: readTrim(join(dir, 'cgroup.procs')).split('\n').filter(Boolean).length,
    };
  });
}

export function assertLayout022(slice = phoneCap022.slice) {
  const path = snapshotPath022(slice);
  for (const cgroup of path) {
    assert.ok(cgroup.subtreeControl.split(' ').includes('cpu'),
      `${cgroup.path} does not delegate cpu; the rig must not change subtree_control (take the fallback)`);
  }
  assert.equal(path[1].processes, 0, `${slice} holds processes directly`);
  return path;
}

function readProc(pid, file) {
  try {
    return readFileSync(`/proc/${pid}/${file}`);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined;
    throw error;
  }
}

// Fields after "pid (comm) ": [0] is the state, [1] the parent PID, [19] the start time.
function statFields(pid) {
  const stat = readProc(pid, 'stat')?.toString('utf8');
  return stat && stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
}

function describeProcess(pid) {
  let exe;
  try {
    exe = readlinkSync(`/proc/${pid}/exe`);
  } catch {
    // A zombie keeps its PID and parent until it is reaped, but its exe link is gone.
    const stat = statFields(pid);
    return stat?.[0] === 'Z' ? { pid, ppid: Number(stat[1]), startTime: stat[19], zombie: true } : { pid, exited: true };
  }
  const stat = statFields(pid);
  if (!stat) return { pid, exited: true };
  // Zygote children set their title with setproctitle, which can join argv into one string.
  const cmdline = (readProc(pid, 'cmdline') ?? Buffer.alloc(0)).toString('utf8').replaceAll('\0', ' ');
  const type = /(?:^|\s)--type=(\S+)/u.exec(cmdline)?.[1] ?? 'browser';
  const threads = Number(/^Threads:\s+(\d+)$/mu.exec(readProc(pid, 'status')?.toString('utf8') ?? '')?.[1] ?? 0);
  return { pid, ppid: Number(stat[1]), startTime: stat[19], exe, type, threads };
}

// R3: every PID in the scope is the rig's Chromium and never the Node driver. Each one has a
// Chromium executable, and its parent chain through other members ends at the browser this driver
// spawned or, for helpers Chromium daemonises (such as chrome_crashpad_handler), at init. Only the
// browser's own PID was placed in the scope; everything else entered it by forking from that browser.
// (Chromium rewrites its environ block for the process title, so an environment marker can't be read.)
function readMembership(cgroup, chromiumDir, requireRenderer) {
  const dir = join(cgroupRoot, cgroup);
  const pids = readTrim(join(dir, 'cgroup.procs')).split('\n').filter(Boolean).map(Number);
  const processes = pids.map(describeProcess).filter(({ exited }) => !exited);
  assert.ok(processes.length > 0, `No live process in ${cgroup}`);
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  for (const entry of processes) {
    assert.notEqual(entry.pid, process.pid, 'The Node driver is inside the rig cgroup');
    assert.ok(entry.zombie || entry.exe.startsWith(chromiumDir + '/'),
      `Non-Chromium process in ${cgroup}: ${JSON.stringify(entry)}`);
    let root = entry;
    for (let hops = 0; byPid.has(root.ppid) && hops < 64; hops++) root = byPid.get(root.ppid);
    const suffix = entry.zombie ? ', exited and awaiting reap' : '';
    if (root.ppid === process.pid) {
      entry.browserPid = root.pid;
      entry.mappedBy = (root === entry ? 'browser spawned by this driver' : `descendant of browser ${root.pid}`) + suffix;
    } else {
      const parent = root.ppid;
      assert.equal(parent, 1, `Process in ${cgroup} descends from a process outside it: ${JSON.stringify(entry)}; ` +
        `parent ${parent}: ${JSON.stringify({ stat: statFields(parent)?.slice(0, 2),
          cgroup: readProc(parent, 'cgroup')?.toString('utf8').trim() })}`);
      entry.mappedBy = `Chromium helper daemonised from the browser (${entry.zombie ? 'zombie' : basename(entry.exe)})${suffix}`;
    }
  }
  const browsers = new Set(processes.map(({ browserPid }) => browserPid).filter(Boolean));
  assert.equal(browsers.size, 1, `Expected exactly one browser in ${cgroup}`);
  if (requireRenderer) {
    assert.ok(processes.some(({ type }) => type === 'renderer'), `No renderer in ${cgroup}: ` +
      JSON.stringify(processes.map(({ pid, ppid, type, zombie }) => ({ pid, ppid, type, zombie }))));
  }
  // Coverage: every live descendant of the browser, anywhere on the host, is inside the scope.
  const [browserPid] = browsers;
  const outside = descendants(browserPid).filter((pid) => {
    const own = readProc(pid, 'cgroup')?.toString('utf8').trim();
    return own !== undefined && own !== `0::${cgroup}`;
  }).map((pid) => ({ pid, cgroup: readProc(pid, 'cgroup')?.toString('utf8').trim() }));
  assert.deepEqual(outside, [], `Rig Chromium processes outside ${cgroup}`);
  const threads = readTrim(join(dir, 'cgroup.threads')).split('\n').filter(Boolean).length;
  return { cgroup, at: new Date().toISOString(), processes, threads, descendantsOutside: outside };
}

function descendants(root) {
  const children = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/u.test(name)) continue;
    const ppid = Number(statFields(Number(name))?.[1]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(Number(name));
  }
  const found = [];
  const queue = [...(children.get(root) ?? [])];
  while (queue.length) {
    const pid = queue.shift();
    found.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return found;
}

// Chromium forks short-lived helpers while it starts; retry until one consistent reading.
export async function membership022(cgroup, chromiumDir, { requireRenderer = false } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      return { ...readMembership(cgroup, chromiumDir, requireRenderer), attempt };
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError;
}

// Processes from a membership listing that are still alive (same PID and start time).
export function survivors022(processes) {
  return processes.filter(({ pid, startTime }) => statFields(pid)?.[19] === startTime);
}

// Kill and wait for one rig unit to disappear. Only ever called with this run's own unit name.
export async function removeUnit022(unit, { timeoutMs = 20_000 } = {}) {
  assert.ok(unit.startsWith(phoneCap022.unitPrefix) && unit.endsWith('.scope'));
  const started = Date.now();
  let killed = false;
  while (Date.now() - started < timeoutMs) {
    const state = loadState(unit);
    const cgroupDir = join(cgroupRoot, phoneCap022.slice, unit);
    // A scope's cgroup is removed only once it is empty, so its absence means no member is alive.
    if (state === 'not-found' && !existsSync(cgroupDir)) {
      return { unit, killed, removedAfterMs: Date.now() - started };
    }
    if (state === 'loaded') {
      systemctl(['kill', '--signal=SIGKILL', unit], { allowFailure: true });
      killed = true;
    }
    await delay(100);
  }
  throw new Error(`Rig unit ${unit} was not removed within ${timeoutMs} ms`);
}

function removeUnitSync(unit) {
  if (loadState(unit) === 'loaded') systemctl(['kill', '--signal=SIGKILL', unit], { allowFailure: true });
}

async function waitForScope(unit, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const shown = systemctl(['show', '-p', 'LoadState,ActiveState,ControlGroup', unit], { allowFailure: true })
      .stdout.trim().split('\n').map((line) => line.split('='));
    const props = Object.fromEntries(shown.map(([key, ...value]) => [key, value.join('=')]));
    if (props.LoadState === 'loaded' && props.ActiveState === 'active' && props.ControlGroup) return props;
    await delay(50);
  }
  throw new Error(`Rig scope ${unit} did not start`);
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

// Launches Chromium inside a new transient scope. `launchOptions` must be the desktop launch options.
// `quotaUs` other than the registered value is only for the probe's calibration sweep.
export async function launchCapped022(chromium, { runId, workDir, launchOptions, quotaUs = phoneCap022.quotaUs }) {
  assert.ok(Number.isSafeInteger(quotaUs) && quotaUs >= 1000 && quotaUs <= phoneCap022.periodUs && quotaUs % 10 === 0,
    'Quota must be a whole number of 10 us steps between 1 ms and the period');
  const quotaPercent = quotaUs * 100 / phoneCap022.periodUs;
  const unit = unitName022(runId);
  const slice = phoneCap022.slice;
  const noneBefore = assertNoLeftovers022('before launch');
  const before = assertLayout022(slice);
  const real = chromium.executablePath();
  assert.ok(real && existsSync(real), 'Chromium executable not found');
  const chromiumDir = dirname(real);
  const wrapper = join(workDir, `${unit}-chromium.sh`);
  // systemd-run --scope registers its own PID as the scope and then execs Chromium, so the
  // Playwright pipe and arguments pass through unchanged. Chromium on Linux moves processes into its
  // own app-org.chromium.Chromium-<pid>.scope through the session bus, which would take them out of
  // the cap, so the phone browser runs without a session bus address.
  writeFileSync(wrapper, [
    '#!/bin/sh',
    'exec env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR \\',
    `  systemd-run --quiet --scope --collect --slice=${slice} --unit=${shellQuote(unit)} \\`,
    `  -p CPUQuota=${quotaPercent}% -p CPUQuotaPeriodSec=${phoneCap022.periodUs / 1000}ms \\`,
    `  -- ${shellQuote(real)} "$@"`,
    '',
  ].join('\n'), { flag: 'wx' });
  chmodSync(wrapper, 0o755);
  const watchdogLog = openSync(join(workDir, `${unit}-watchdog.log`), 'a');
  const guard = spawn('bash', [watchdog, String(process.pid), unit], {
    detached: true, stdio: ['ignore', watchdogLog, watchdogLog],
  });
  guard.unref();
  const onExit = () => removeUnitSync(unit);
  process.on('exit', onExit);

  let browser;
  try {
    browser = await chromium.launch({ ...launchOptions, executablePath: wrapper });
    const props = await waitForScope(unit);
    const cgroup = props.ControlGroup;
    assert.equal(cgroup, `/${slice}/${unit}`, 'Rig scope is not where the layout check expected it');
    const cpuMax = readTrim(join(cgroupRoot, cgroup, 'cpu.max'));
    assert.equal(cpuMax, `${quotaUs} ${phoneCap022.periodUs}`, 'Unexpected cpu.max');
    const atLaunch = await membership022(cgroup, chromiumDir);
    const during = snapshotPath022(slice);
    assert.deepEqual(during, before, 'A pre-existing cgroup changed when the scope was created');
    const receipt = {
      mechanism: 'cgroup-v2 cpu.max via systemd-run --scope', workerThrottle: `cgroup-cpu.max ${cpuMax}`,
      factor: phoneCap022.factor, cpuQuotaPercent: quotaPercent,
      unit, slice, cgroup, cpuMax, chromium: real, wrapper, watchdogPid: guard.pid,
      noneBefore, snapshotBefore: before, membershipAtLaunch: atLaunch,
    };
    let removed;
    return {
      browser, unit, cgroup, receipt,
      membership: (options) => membership022(cgroup, chromiumDir, options),
      async remove() {
        if (removed) return removed;
        await browser.close().catch(() => {});
        // R6: the exit path always kills the scope, even when the browser has already emptied it.
        const kill = systemctl(['kill', '--signal=SIGKILL', unit], { allowFailure: true });
        const exitKill = { command: `systemctl kill --signal=SIGKILL ${unit}`, status: kill.status,
          ...(kill.status !== 0 && { stderr: kill.stderr.trim() }) };
        const removal = { ...await removeUnit022(unit), exitKill };
        const after = snapshotPath022(slice);
        assert.deepEqual(after, before, 'A pre-existing cgroup differs after the run');
        removed = { ...removal, snapshotAfter: after, snapshotsIdentical: true,
          noneAfter: assertNoLeftovers022('after removal') };
        process.off('exit', onExit);
        return removed;
      },
    };
  } catch (error) {
    await browser?.close().catch(() => {});
    await removeUnit022(unit).catch(() => {});
    process.off('exit', onExit);
    throw error;
  }
}

// CLI used by the launch scripts: `assert-clean`, `layout`, and `cleanup <run-id>`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, runId] = process.argv.slice(2);
  if (operation === 'assert-clean') {
    console.log(JSON.stringify({ kind: 'rig-cgroup-clean', ...assertNoLeftovers022('at start') }));
  } else if (operation === 'layout') {
    const path = assertLayout022();
    const own = readTrim('/proc/self/cgroup');
    console.log(JSON.stringify({ kind: 'rig-cgroup-layout', driverCgroup: own, path,
      systemd: execFileSync('systemctl', ['--version'], { encoding: 'utf8' }).split('\n')[0] }));
  } else if (operation === 'snapshot') {
    console.log(JSON.stringify(snapshotPath022()));
  } else if (operation === 'cleanup') {
    const unit = unitName022(runId);
    console.log(JSON.stringify({ kind: 'rig-cgroup-cleanup', ...await removeUnit022(unit) }));
  } else if (operation === 'survivors') {
    // runId is a ready.json from the probe's hold mode here.
    const { membership } = JSON.parse(readFileSync(runId, 'utf8'));
    const alive = survivors022(membership.processes);
    console.log(JSON.stringify({ kind: 'rig-chromium-survivors', listed: membership.processes.length,
      alive: alive.map(({ pid, type }) => ({ pid, type })) }));
    process.exitCode = alive.length ? 1 : 0;
  } else {
    console.error('Usage: phone-cgroup-022.mjs assert-clean | layout | snapshot | cleanup <run-id> | survivors <ready.json>');
    process.exitCode = 2;
  }
}

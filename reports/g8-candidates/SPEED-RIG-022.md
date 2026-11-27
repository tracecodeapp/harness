# Harness 0.22 speed rig

The 0.22 production control is the published Harness 0.21.0 archive. The plan
pins its SHA-256, the browser journey matrix, and the six heavy fixtures.
The Python fixture is available to the M2 probe through
`heavyFixture022('python')` in `plan-022.mjs`. Pass its `limits` to the
Judge bundle along with its code and case. The limits keep the untraced
line guard active and give this known search enough room to finish.

## Ordinary self-test

Run from the AgentRunner login directory with an absolute checkout path, a
new output directory outside the checkout, and the registered tarball.
Check the Harness jobs in the shared log before queueing.

```sh
HEAVY_JOB_LANE=h022-p0c nice -n 10 ionice -c3 /root/ci/bin/heavy bash "$checkout/reports/g8-candidates/session-022.sh" selftest "$out" "$control_tarball"
```

The self-test runs each matrix group once on the published package, exercises
the scorer CLIs with generated data, and records the six desktop calibration
times in the job log output and `selftest-pass.json`. The receipt lists times
outside 1–3 seconds in `calibrationOutsideBand` as warnings. Keep the receipt
with the job log and run the self-test again after changing the rig commit.

The launch cwd replay deletes only the `cd "$stage"` line immediately after
`export SPEED_G8_RUNNER_COMMIT`. The C# and A/A replays are full reverts of
`ed1f73b1` and `b28d6ddd` on separate branches. Run each replay from the
AgentRunner login directory with fresh output.

### Desktop Chromium session bus

The 0.22 desktop Chromium launch drops `DBUS_SESSION_BUS_ADDRESS` and
`XDG_RUNTIME_DIR` from the browser's environment, matching the capped phone
launch. The driver keeps its environment so the self-test can list root's
Chromium scopes before launch and after close.

The self-test opens a desktop page, obtains the browser PID over CDP, and
walks its live descendants by parent PID. It fails if any of those PIDs is
under `user@0.service`. The cgroup paths and the two informational scope
listings are in `desktop-leak.json`. A scope in a listing is attributed to
the rig only when a rig PID's cgroup identifies that scope.

Run the P27-G diagnostic with the published 0.21.0 tarball and a fresh
output directory after checking the shared Harness job log:

```sh
HEAVY_JOB_LANE=h022-p27g nice -n 10 ionice -c3 /root/ci/bin/heavy bash "$checkout/reports/g8-candidates/session-022.sh" desktop-timing "$out" "$control_tarball"
```

Each language alternates between launches with and without the bus. Each
trial opens a fresh page and warms its runtime before the Binary Search Run.
The first two trials per arm are discarded. The remaining 20 per arm use
the rig's one-minute load limit of 2.0 and require a successful Run and
first-case trace. The pinned package returns verdicts and firstTrace in the
same response. See `desktop-timing-samples.jsonl` for trial outcomes and
`desktop-timing.json` for medians, no-bus/bus ratios, and undecided cells.

## Approved window

The coordinator names the exclusive window. Pass the self-test receipt for
the current checkout commit and the supplied production archive. The script
validates that pair before staging and again before requesting the lock.
Both packages receive the same journey options, including Submit policy.

```sh
bash "$checkout/reports/g8-candidates/session-022.sh" window "$out" "$control_tarball" "$selftest_receipt" "$candidate_tarball" "$candidate_sha256" "$reference_json" "$minutes"
```

An optional ninth argument selects a JSON array of registered group indexes.
Supply a reference JSON with `controlSha256` and `groups`. The latter maps
group indexes to endpoint names and their reference `median` and `p90`.
An endpoint derived from a failed A/A check carries `aaPass: false`.

Score completed or interrupted sessions together with
`node score-022.mjs "$reference_json" "$session_one" "$session_two"`. The
scorer takes each completed group from one session and rejects duplicate
completed groups. It reports a group as incomplete if no session reaches
the registered target. Each endpoint needs a valid control reference and
passes only when both statistics pass the shared 0.22 rule.

## Phone CPU cap

P27-C measured that the CDP CPU throttle slows the page's main thread
4.04× but Web Workers only 1.01–1.02×, because Chromium refuses CPU
throttling on worker targets. The 0.22 rig therefore runs every CPU-4
group (the phone cells) in a second Chromium inside a cgroup v2 CPU cap
and sends those pages CDP rate 1, so nothing is throttled twice. Desktop
groups keep the plain Chromium. Older modes in `run-g8.mjs` still use the
CDP throttle and stamp their CPU-4 rows `workerThrottle: none`.

**What it models.** The cap limits the total CPU time of the phone
browser's whole process tree to a fixed share of one core, in
`cpu.max` periods of 10 ms. The page's main thread, its
`DedicatedWorker` threads, V8's background compiler and GC threads,
and Chromium's GPU, network and utility processes all draw on that one
budget. Total CPU time is shared across threads. A Worker spinning beside
a busy main thread gets about half the budget, and each runs about twice
as slow as either does alone (the dry run's concurrent arm measures
both). A phone with several slower cores would run them in parallel,
so cells where the main thread and a Worker are both busy at once are
pessimistic. Cells where one thread does the work are close to the
factor.

**What it doesn't model.** It is not a slower core. A thread runs at
full desktop speed until the period's quota is spent and then waits, so
it doesn't model a slower clock, smaller caches, memory bandwidth or
latency, or thermal throttling. With a 10 ms period, a burst shorter than
one period's quota (2.75 ms of CPU) can finish at desktop speed. Bursts of
20 ms and longer slow by about the factor (the dry run's burst arm),
but the timing of very short single-threaded bursts is not modelled.

**How it is applied.** `phone-cgroup-022.mjs` writes a wrapper that
Playwright launches as `executablePath`, with the same `channel` and
arguments as the desktop browser. The wrapper execs
`systemd-run --scope --collect --slice=system.slice --unit=h022-p27f-<run>.scope -p CPUQuota=… -p CPUQuotaPeriodSec=10ms`, which execs Chromium. So
the scope holds only the rig's Chromium, never the Node driver. The
wrapper unsets `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR`.
Otherwise Chromium 145 moves its own processes into
`app-org.chromium.Chromium-<pid>.scope` under root's user manager, out
of the cap; the fifth dry run caught this. The membership check maps
every PID in `cgroup.procs` to the browser the driver spawned, by parent
chain. Helpers that Chromium daemonises, such as
`chrome_crashpad_handler`, chain to init. The check also requires every
live descendant of the browser on the host to be inside the scope. The
rig never creates a cgroup directory and never writes a cgroup file.

**Host layout (AgentRunner, read on 2026-11-27).** AgentRunner is an LXC
container running systemd 252 on cgroup v2. The container root, `system.slice`, `user.slice`
and `user.slice/user-0.slice` all have `cpu memory pids` in
`cgroup.subtree_control` and no processes of their own. Every unit has
`CPUAccounting=yes`, which is why `cpu` stays enabled. Other teams'
services are in `system.slice`, and their ssh session scopes are in
`user-0.slice`. A new scope under `system.slice` therefore gets
`cpu.max` without any change to `subtree_control` and without moving
any process. Conditions 1 and 2 hold without the fallback. Each launch
snapshots `cgroup.subtree_control`, `cpu.max`, `cpu.weight` and the
direct process count of `/` and `/system.slice` before the scope exists
and after it is gone, and fails if the two differ.

**Lifetime.** `session-022.sh` refuses to start if any `h022-p27f-*`
unit or cgroup exists, and its EXIT trap removes this run's scopes with
`systemctl kill`. The driver removes its scope with `systemctl kill`
after closing the browser. A detached watchdog
(`phone-cgroup-watchdog-022.sh`) does the same if the driver dies,
including by `kill -9`. The self-test checks both: a live rig cgroup
blocks a new start, and after a `kill -9` of the launcher no unit,
cgroup or Chromium process is left.

**Stamp.** Every phone sample row carries `workerThrottle`, for example
`cgroup-cpu.max 2750 10000`. The window metadata keeps the scope receipt
under `phoneThrottle`. `score-022.mjs` rejects a phone row without a
known stamp, refuses to mix stamps within a group, and reports
`workerThrottle` per phone group and overall.

**Checks.** Each check is an ordinary `heavy` job and never a window:

```sh
bash "$checkout/reports/g8-candidates/phone-cgroup-check-022.sh" calibrate "$out"
bash "$checkout/reports/g8-candidates/phone-cgroup-check-022.sh" dryrun "$out"
bash "$checkout/reports/g8-candidates/phone-cgroup-check-022.sh" killed "$out"
```

**Calibration.** The phone factor is the quota at which the main thread
slows as much as it does under CDP 4×, measured in the same job (P27-C
measured CDP 4× at 4.04×). A 25% quota overshoots because the browser's
other threads also spend the budget. Calibration job
`20261127T071445.816044335-3561100` measured the main thread, then the
Worker, against CDP-4 main:

| `cpu.max` | Main thread | Worker | CDP-4 main |
| --- | --- | --- | --- |
| `2500 10000` | 4.54× | 4.49× | 4.16× |
| `2750 10000` | 4.03× | 4.00× | 4.15× |
| `3000 10000` | 3.56× | 3.54× | 4.11× |

The rig uses `2750 10000` (27.5% of one core). Rerun `calibrate` if the
host, its kernel or the Chromium build changes.

**Dry run.** The dry run interleaves desktop, CDP-4 and capped trials of
P27-C's arms A (main thread) and B (a Worker created after the CDP call).
It adds a Worker running a 20 ms loop 50 times with 30 ms gaps, and the
main thread and a Worker spinning together. A plain `node` loop outside
the scope runs throughout. It passes when:
- arms A and B are within ±15% of 4×;
- the burst arm is within ±25% of 4×;
- arm A is within ±10% of CDP-4 main in the same job;
- the outside loop is within ±15% of its idle speed;
- the path snapshots match;
- nothing named `h022-p27f-*` is left under `/sys/fs/cgroup`.

The self-test runs arms A and B with three trials each and requires
B ≥ 3× and A within ±25% of 4×.

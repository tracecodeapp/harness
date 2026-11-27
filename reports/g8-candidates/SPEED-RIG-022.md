# Harness 0.22 speed rig

The 0.22 production control is the published Harness 0.21.0 archive. The plan
pins its SHA-256, the browser journey matrix, and the six heavy fixtures.
The Python fixture is available to the M2 probe through
`heavyFixture022('python')` in `plan-022.mjs`.

## Ordinary self-test

Run from the AgentRunner login directory with an absolute checkout path, a
new output directory outside the checkout, and the registered tarball.
Check the Harness jobs in the shared log before queueing.

```sh
HEAVY_JOB_LANE=h022-p0c nice -n 10 ionice -c3 /root/ci/bin/heavy bash "$checkout/reports/g8-candidates/session-022.sh" selftest "$out" "$control_tarball"
```

The self-test runs each matrix group once on the published package, exercises
the scorer CLIs with generated data, and records the six desktop calibration
times in the job log output. It writes `selftest-pass.json` after those checks
pass. Keep it with the job log and run it again after changing the rig commit.

The launch cwd replay deletes only the `cd "$stage"` line immediately after
`export SPEED_G8_RUNNER_COMMIT`. The C# and A/A replays are full reverts of
`ed1f73b1` and `b28d6ddd` on separate branches. Run each replay from the
AgentRunner login directory with fresh output.

## Approved window

The coordinator names the exclusive window. Pass the self-test receipt for
the current checkout commit and the supplied production archive. The script
validates that pair before staging and again before requesting the lock.

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

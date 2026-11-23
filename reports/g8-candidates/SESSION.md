# G8 candidate timing plan

The exclusive timing windows require the coordinator's go after W and the
TraceCC check clear the host. The staging job only installs, builds, and
verifies packages. It launches no browser.

## Scope and time

Plan three exclusive language windows. Start with Java. Estimated time under
the locks is 70–115 minutes in total, with load pauses as the largest variable.
These bounds use the archived per-attempt wall times, 20 kept candidate attempts
per policy, the previous Java warm probe, and the quiet-gate delays from the
baseline. Staging and time in the host queue are outside these estimates.

| Window | Work | Estimated lock time | Deadline |
| --- | --- | ---: | ---: |
| Java step 5 | 25 desktop endpoints, eight phone-class endpoints, five spot cells | 22–42 min | 55 min |
| C# step 6 | 25 desktop endpoints, eight phone-class endpoints, five spot cells | 25–38 min | 45 min |
| Python step 3 | 25 desktop endpoints, eight phone-class endpoints for each policy, five spot cells | 23–35 min | 45 min |

Java's warm Binary Search Run is first within the Java window. Its limits are
830.4 ms median and 944.1 ms p90. It records the worker phases from the Java
lane's runner at `a2bd0190077ae0d1bf3b1292ebb42ed61dfcc397`. For Java and C#,
test both application policies on desktop and phone-class. Lesson finish uses
the preview policy. Python uses the lane's runner from
`6bbe96c15e162498b2520bc8c5f60b2242e40899`, both desktop policies, and the
concurrent versus sequential phone policies. The A/B requires the worker
journal to confirm separate leases for concurrent work and the same worker
after the ordinary reply for sequential work.

Each spot cell is the joined Run verdict endpoint on desktop warm Binary Search
for one of the other five languages. A spot median over 5% or p90 over 10%
triggers a full matrix before the registration can land. The full language
cells require a median at or below the better baseline median and a p90 at or
below 1.10 times the better baseline p90. The two C# warm Submit cells gate on
0.20.1 and also print the 0.17.1 seven-sample advisory.

Use seed 212026, the original same-origin non-isolated page and fixture
digests, and CDP 4× for phone-class. The runner excludes starts above one-minute
load 2.0 and records all failed and refused attempts. A refusal never supplies
a trace latency. An incomplete cell is reported with its kept count and
cannot pass. The scorer compares the kept timings with the archived baseline
samples, including the Desktop A Java top-up.

## Exact timing commands

Run in order after the coordinator's go. Each command releases the host before
the next begins. Transfer and checksum the metadata, raw samples and session
logs before cleanup. Leave the staging directory in place between sessions.

```bash
ar=/Users/obinnanwachukwu/Code/tracecodeapp/harness-artifacts/tools/ar-harness.sh
wt=/Users/obinnanwachukwu/.t3/worktrees/harness/t3-df2808a1-af3ae7dd551a2a6c
stage=/root/ci/g8-candidates.qHpuBwkE

"$ar" "$wt" speed-g8-java "true && bash $stage/session-and-score.sh java 55"
"$ar" "$wt" speed-g8-csharp "true && bash $stage/session-and-score.sh csharp 45"
"$ar" "$wt" speed-g8-python "true && bash $stage/session-and-score.sh python 45"
```

The staging directory contains the verified installs, the six frozen baseline
result files under `frozen-baseline/`, and `runner.sha256`. The wrapper verifies
the frozen result files against `baseline-results.sha256`, releases the exclusive
lock before scoring, and writes the scorer output to the language directory.
Before each window the entry script verifies the staged sources and prints the
committed runner source revision. Both published
controls use the baseline lock inputs and their pinned tarballs. Each package
runs with `npm ci --omit=dev --ignore-scripts`; the installed tree must exactly
match the frozen receipt after normalizing the candidate's top-level version.
The Python control manifest records the tarball digest at pack time, pack
timestamp, base commit and overlay digest.

## Staged package receipt

Java, C#, both published controls, and both Python policies installed and
passed package SHA-256 and frozen dependency checks. The Python sequential
control was packed at 2026-11-23 17:12:29 UTC from
`6bbe96c15e162498b2520bc8c5f60b2242e40899`.

- Sequential archive SHA-256 `825029b0985f2e244affaec0f1ca5aac093289c0e60151b5bc7fcf6c09d4e6fa`
- Overlay diff SHA-256 `4e209b58cbdc096a2120153d605ecf9f76928927dcace18ea1aa6d4e4b3b6fc0`
- [Python policy manifest](./manifest.json)
- [Session source checksums](./runner.sha256)

The disposable control checkout and its host job were removed after packing,
staging and verification. The benchmark installs remain in the staging directory.

### Active Python pair

The coordinator superseded `6bbe96c1` with `d084b68bcc419c8e7e1815403b5b85bced8531de`.
The same overlay passed its anchor check and built cleanly in a detached staging
checkout. Both installs match the frozen tree. The host's `python` staging link
now resolves to this pair. The prior installs and receipt are retained under
`python-6bbe96c1` for provenance.

- Concurrent tarball SHA-256 `cdb1f84a7f09bcc855c59a5f9ddcda410794d82e577c061cc99d5e4119df0d64`
- Sequential tarball SHA-256 `ae5a9a86e1255eeaac81397ba5c2aeac3cbe9c2cc9dd52a3936bb7aad7daeff6`, packed at 2026-11-23 17:29:37 UTC
- Overlay diff SHA-256 `4e209b58cbdc096a2120153d605ecf9f76928927dcace18ea1aa6d4e4b3b6fc0`
- [Active Python manifest](./d084b68b-manifest.json)

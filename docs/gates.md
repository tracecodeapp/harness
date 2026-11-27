# Running gate cells

Find the cell ID, command, and host in [the inventory](../scripts/gates/cells.json).
Use the declared host. On AgentRunner, run from a checkout with the candidate
commit and any named qualification refs available locally.

For a PR, list the selected cells and run them on their declared hosts, plus
the `canary`. Always run the canary against the landed commit.

```bash
node scripts/gates/select.mjs --base <base> --head <head>
HEAVY_JOB_LANE=h022-<lane> bash scripts/gates/run-cell.sh <cell> --rev <commit>
HEAVY_JOB_LANE=h022-<lane> bash scripts/gates/run-cell.sh canary --rev <landing> --force
node scripts/gates/job-report.mjs --since 2026-11-27T00:00:00Z --lane-prefix h022-
```

For a release candidate, run `candidate-all`. Print the complete plan first,
then run each partition once against the same revision.

```bash
node scripts/gates/candidate-all.mjs --rev <commit>
node scripts/gates/candidate-all.mjs --rev <commit> --host <agentrunner|ci|laptop-unit>
```

On CI and laptop-unit, use a clean disposable checkout at the candidate
revision with the locked dependencies installed. CI also needs Chromium and
its system dependencies, as in `.github/workflows/ci.yml`. The AgentRunner
partition uses `run-cell.sh` and waits outside `heavy` when both slots are busy.

Set `PLAYWRIGHT_BROWSERS_PATH` if the cell uses a provisioned browser cache.
GA and GB require `GATE_CANDIDATE_TARBALL` and `GATE_MUX_SOURCE`. Point them at
the exact candidate archive and the staged, pinned mux adapter directory.
GA C++ needs `GATE_APP_MANIFEST` set to the staged app manifest file.
For W on AgentRunner, point `GATE_APP_CATALOG` at the staged catalog directory.
Keep these artifacts outside the checkout.

The runner creates a fresh detached worktree, checks for a cached pass, and
queues a job on a miss. Add `--force` to rerun. Failures rerun on the next
invocation. If both Harness slots are busy, retry when a job ends. Results
are in `/root/ci/gate-results/<cell>/<hash>.json` and link to the job logs.
The report groups jobs by lane, candidate, and cell, and sums run time by lane.

Use `node scripts/gates/cell-hash.mjs <cell> --rev <commit>` to inspect a
tree-only hash. It hashes sorted Git path and blob ID pairs for the cell and
shared input globs, the root package fields the cell uses, the sorted-key cell
definition and pins, and the gate branch head for GA, GB, and W. The runner supplies `--host-pins` for the actual
lookup. Those pins include Node, pnpm, installed Playwright revisions, and
the digests of any external inputs the cell uses, including a candidate tarball.

Every cell uses the root manifest's dependency fields, `pnpm`, `packageManager`,
`engines`, `exports`, `files`, `main`, `types`, `type`, and `version`. Other
manifest inputs are limited to the scripts the cell's setup and command call,
including nested `pnpm`, `pnpm run`, and `npm run` calls.

List the files a cell actually loads, including each cross-language dependency
explicitly in its inputs. Run `node --test tests/gates/*.test.mjs` to check
command paths and direct cross-language imports and list unclaimed tracked files.

### Paths without a cell

A declared cell input always takes precedence over this list. Other paths
outside the list select every cell.

| `noCell` glob | Reason |
| --- | --- |
| `**/*.md` | Prose changes, including `AGENTS.md` and `CONTRIBUTING.md`, need a gate only when a cell consumes them or when they are fixtures. |
| `!**/fixtures/**` | Fixture paths remain eligible for selection, including unclaimed Markdown read by a test. |
| `benchmarks/**` | Benchmark scripts run separately unless a cell declares an input there. |
| `reports/**` | Reports record evidence after a run unless a cell declares one as an input. |
| `.gitignore` | Ignore rules govern untracked files, while the gate key uses Git blobs. |
| `.github/workflows/**` | A workflow affects selection only when a cell declares it. |
| `runtime-assets.lock.json` | The lock is derived. Its worker, engine, and C# role inputs select the affected cells. Lock checks declare the generator and workers. |
| `CHANGELOG.md` | Release notes describe changes for readers. The tested inputs determine which cells run. |

### Expected selections for 0.21 PRs

Compare each merge commit with its first parent. Expect every cell for each
of these historical merges.

| PR | Merge | Shared input that selects every cell |
| --- | --- | --- |
| #110, Python project paths | `c3812a36` | `package.json` and the TraceKernel workspace language dispatch. |
| #111, JS and TS stack frames | `895fa84f` | `package.json`. The stack-frame code itself lives in the runtime shared by JS and TS. |
| #108, C# conditional compilation | `1798d4ab` | `package.json` and `packages/runtime-contracts/src/runtime-calls.ts`. |
| #113, terminal output routing | `482de135` | TraceKernel's argument parsing, workspace filesystem observation, and shell output are shared. The dependency patch also changed the shared pnpm lock. |
| #103, judged output policy | `773c8ca9` | Both `src/internal/browser-judge.ts` and `packages/runtime-contracts/src/judged-output-policy.ts`. |

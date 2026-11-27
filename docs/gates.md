# Running gate cells

Find the cell ID, command, and host in [the inventory](../scripts/gates/cells.json).
Use the declared host. On AgentRunner, run from a checkout with the candidate
commit and any named qualification refs available locally.

```bash
HEAVY_JOB_LANE=h022-<lane> bash scripts/gates/run-cell.sh <cell> --rev <commit>
node scripts/gates/job-report.mjs --since 2026-11-27T00:00:00Z --lane-prefix h022-
```

Set `PLAYWRIGHT_BROWSERS_PATH` if the cell uses a provisioned browser cache.
GA and GB require `GATE_CANDIDATE_TARBALL` and `GATE_MUX_SOURCE`. Point them at
the exact candidate archive and the staged, pinned mux adapter directory.
GA C++ also needs `GATE_APP_DATA` set to the staged app manifest file.
For W on AgentRunner, point `GATE_APP_DATA` at the staged catalog directory.
Keep these artifacts outside the checkout.

The runner creates a fresh detached worktree, checks for a cached pass, and
queues a job on a miss. Add `--force` to rerun. Failures rerun on the next
invocation. If both Harness slots are busy, retry when a job ends. Results
are in `/root/ci/gate-results/<cell>/<hash>.json` and link to the job logs.
The report groups jobs by lane, candidate, and cell, and sums run time by lane.

Use `node scripts/gates/cell-hash.mjs <cell> --rev <commit>` to inspect a
tree-only hash. It hashes sorted Git paths, file modes, and blob IDs for the cell and
shared input globs, the root package fields the cell uses, the sorted-key cell
definition and pins, and the gate branch head for GA, GB, and W. The runner supplies `--host-pins` for the actual
lookup. Those pins include Node, pnpm, installed Playwright revisions, and
the digests of any external inputs the cell uses, including a candidate tarball.
Applicable cells also pin `javac -version`, `java -version`, and
`dotnet --version`. The runner forwards an allowlist of host environment
variables and includes their values in the key. GA records results for
diagnosis and always executes against its pinned candidate tarball.

Every cell uses all root manifest fields outside `scripts`. Script inputs
are limited to the entries the cell's setup and command call,
including nested `pnpm`, `pnpm run`, and `npm run` calls.

Declare the full module closure of each command and entry file, including
literal dynamic imports and cross-language dependencies. Workspace imports
resolve to repository source. Run `node --test tests/gates/*.test.mjs` after
installing the locked dependencies to check the closure and list unclaimed
tracked files.

### Paths without a cell

A declared cell input always takes precedence over this list. Other paths
outside the list select every cell.

| `noCell` glob | Reason |
| --- | --- |
| `**/*.md` | Prose changes, including `AGENTS.md` and `CONTRIBUTING.md`, need a gate only when a cell consumes them or when they are fixtures. |
| `benchmarks/**` | Benchmark scripts run separately unless a cell declares an input there. |
| `reports/**` | Reports record evidence after a run unless a cell declares one as an input. |
| `.gitignore` | Ignore rules govern untracked files, while the gate key uses Git blobs. |
| `.github/workflows/**` | A workflow affects selection only when a cell declares it. |
| `runtime-assets.lock.json` | The lock is derived. Worker, engine, and C# role inputs select the affected cells, and `test:runtime-assets-lock` checks lock consistency. |
| `CHANGELOG.md` | Release notes describe changes for readers. The tested inputs determine which cells run. |
| `!**/fixtures/**` | Fixture paths remain eligible for selection, including unclaimed Markdown read by a test. |

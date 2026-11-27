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
tree-only hash. It hashes sorted Git path and blob ID pairs for the cell and
shared input globs, the sorted-key cell definition and pins, and the gate
branch head for GA, GB, and W. The runner supplies `--host-pins` for the actual
lookup. Those pins include Node, pnpm, installed Playwright revisions, and
the digests of any external inputs the cell uses, including a candidate tarball.

List the files a cell actually loads, including each cross-language dependency
explicitly in its inputs. Run `node --test tests/gates/*.test.mjs` to check
command paths and direct cross-language imports and list unclaimed tracked files.

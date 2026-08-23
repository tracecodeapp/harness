# Python runtime snapshots

Harness restores each disposable browser Python runner from a clean Pyodide
memory snapshot. The snapshot is part of the pinned runtime tree and must be
built in the browser engine that consumes it.

Validate the existing Chromium and Firefox images with Playwright. Validation
is the default and never replaces an image. Their replacement flow is not yet
exposed by this release tool:

```bash
pnpm build:python-runtime-snapshot -- --engine=chromium
pnpm build:python-runtime-snapshot -- --engine=firefox
```

For the release WebKit image, use Mobile Safari in a booted iOS simulator. The
command opens a local build page in Safari, receives the snapshot from that
page, restores it in a fresh Worker, and only then replaces the checked-in
image:

```bash
xcrun simctl boot "iPhone 17 Pro"
pnpm build:python-runtime-snapshot -- \
  --engine=webkit \
  --runner=ios-simulator \
  --device=booted \
  --replace
```

Use `--check` when an explicit validation flag is clearer. The release WebKit
filename can only be replaced by the iOS simulator runner, and every
replacement records its runner, user agent, hash seed, size, and SHA-256 in
`snapshots/provenance.json`. An exclusive release lock prevents overlapping
replacement runs. The builder removes its lock on normal exit and reclaims a
lock whose recorded process no longer exists. It stages the image and
provenance together, verifies both after replacement, and rolls both files back
if the release write fails. A recovery journal preserves the
previous pair until verification finishes. If the process or machine stops
between writes, the next replacement restores that pair before rebuilding.
After any image changes, regenerate the runtime asset identities and run the
browser batch in the matching engine:

```bash
pnpm generate:runtime-assets-lock
TRACECODE_BROWSER_ENGINE=webkit \
TRACECODE_ALGORITHM_BATCH_LANGUAGES=python \
node --import tsx tests/test-browser-algorithm-batch.ts
```

The builder imports the same `PYTHONHASHSEED` contract as the runtime asset
resolver and asserts the restored hash probe. Before snapshotting it imports
`sys`, `json`, `math`, `os`, `ast`, `collections`, and `typing`. It then
validates a clean restore through the shipped standard-library ZIP and runs the
same default import prelude as production. The candidate stays outside the
published worker tree, and the target changes only after the restore succeeds.

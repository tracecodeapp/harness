# Python runtime snapshots

Harness restores each disposable browser Python runner from a clean Pyodide
memory snapshot. The snapshot is part of the pinned runtime tree and must be
built in the browser engine that consumes it.

Build and validate an image with Playwright:

```bash
pnpm build:python-runtime-snapshot -- --engine=chromium
pnpm build:python-runtime-snapshot -- --engine=firefox
pnpm build:python-runtime-snapshot -- --engine=webkit
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
  --device=booted
```

Use `--check` to restore the existing image without replacing it. After any
image changes, regenerate the runtime asset identities and run the browser
batch in the matching engine:

```bash
pnpm generate:runtime-assets-lock
TRACECODE_BROWSER_ENGINE=webkit \
TRACECODE_ALGORITHM_BATCH_LANGUAGES=python \
node --import tsx tests/test-browser-algorithm-batch.ts
```

The builder always uses `PYTHONHASHSEED=0`, imports the release bootstrap
modules before snapshotting, validates a clean restore without downloading the
standard library again, stages the candidate outside the published tree, and
replaces the target atomically only after the restore succeeds.

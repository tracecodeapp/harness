# TraceCode Harness — agent contract

The Harness is a published execution-runtime package consumed by TraceCode. Preserve unrelated
dirty work, use dedicated worktrees, and treat package publication as a separate authorization
boundary from commits, pushes, or merges.

## Toolchain

- Use the Node and pnpm versions pinned by this repository before installing or testing.
- Stop at preflight when the active toolchain, required compiler, Playwright browser, or measured
  memory does not match the gate being claimed.

## Test loops

- Run cheap public-surface, package, asset-lock, import, and type gates before heavyweight
  compiler, corpus, or browser phases.
- During fixes, use the suite runner's `--only` or `--from` selection. Run one complete
  uninterrupted suite only at the final immutable head.
- Use `--keep-going` when independent failures should be collected in one pass; do not use it
  to blur dependency failures.
- After a contract, wire-format, message-tag, or exported-API change, enumerate every producer
  and consumer before rerunning tests.
- Complete read-only triage before exact-head review. Any candidate-tree change invalidates the
  prior verdict.
- Run fixture-generating or checkout-mutating validation only in a disposable checkout.
- Classify failures as candidate regression, baseline failure, environment, stale test, or
  unavailable evidence before changing code.

## Release boundary

Harness-owned gates prove the package itself. Before publication, validate the packed candidate
through TraceCode's `validate-harness-release` skill and checked-in local release workflow.
Do not improvise a CDN, weaken browser security, or publish merely to make consumer tests runnable.

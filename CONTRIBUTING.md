# Contributing

This project is maintained as a standalone runtime SDK.

Before opening larger changes:

- keep the runtime contract stable
- keep browser worker behavior stable
- keep the public package surface deliberate and documented
- keep public docs focused on stable SDK contracts, not temporary status logs
- avoid changing generated artifacts by hand

The package now has two distinct responsibilities:

- runtime correctness
- SDK/consumer usability

Changes that affect exports, worker asset layout, or browser bootstrap must preserve the external consumer path, not just local integration assumptions.

Avoid reintroducing app-coupled assumptions into the runtime surface, especially:

- app-specific storage keys
- `localStorage`-driven runtime behavior
- consumer-repo file paths
- consumer app names or product-specific workflow hooks

Docs in `docs/` should be consumer-facing or stable contributor contracts.
Temporary parity ledgers, spike findings, corpus-mining notes, and migration
status reports should stay out of the public docs tree unless they are promoted
into a durable contract document.

Run the local gate before submitting changes:

```bash
pnpm test
```

The gate is resource-aware rather than fully serial. If local memory or CPU is
constrained, set `TRACECODE_TEST_JOBS=1` to force one task at a time. Do not
remove task weights, exclusivity, or named resource locks merely to increase
parallelism; those boundaries protect real browser and workspace tests from
host contention and shared-output races.

If you change the Python harness template or generated snippet content, also run:

```bash
pnpm generate:python-harness
```

If you touch the browser SDK surface, verify all of these still work:

- package import smoke tests
- asset sync contract tests
- the example app smoke test
- the standalone boundary guard

For larger API or package-surface changes, open an issue or discussion first.

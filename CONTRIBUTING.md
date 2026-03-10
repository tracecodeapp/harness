# Contributing

This project is maintained as a standalone runtime SDK.

Before opening larger changes:

- keep the runtime contract stable
- keep browser worker behavior stable
- keep the public package surface deliberate and documented
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

Run the local gate before submitting changes:

```bash
pnpm test
```

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

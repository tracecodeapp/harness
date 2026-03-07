# Contributing

This project is maintained by TraceCode.

Before opening larger changes:

- keep the runtime contract stable
- keep browser worker behavior stable
- avoid changing generated artifacts by hand

Run the local gate before submitting changes:

```bash
pnpm test
```

If you change the Python harness template or generated snippet content, also run:

```bash
pnpm generate:python-harness
```

For larger API or package-surface changes, open an issue or discussion first. The project is still settling its public API.

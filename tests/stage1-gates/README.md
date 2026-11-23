# Stage 1 G1 and G6 qualification

The default matrix resolves `@tracecode/harness/judge` from an isolated tarball installation and runs in full Chromium. `manifest.json` contains the exact programs, expected answers, comparator targets and assertion IDs. It is reproducible with `node tests/stage1-gates/build-manifest.mjs` from a checkout that can read the pinned fixture commits. The manifest contains 18 default row observations and 144 ordinary row assertions for each two-case stdout fixture.

Script invocation uses the function style with the selector omitted. Each script assigns the `result` variable and prints it. The no-default and default-constructible C++ `Value` witnesses use the same mixed argument shapes. The app stages use their own budgets and remain external to this checkout.

```bash
node tests/stage1-gates/app-cases.mjs /path/to/read-only/algoflow /outside/git/app-stage-manifest.json
bash tests/stage1-gates/stage-mux.sh /path/to/multiplexer /outside/git/mux
```

`app-cases.mjs` reads the pinned app commit without changing the worktree. It computes the answers from the graph and ranking rules and checks them against the supplied comparator targets. Stage the generated app manifest and mux directory separately on the build host. From `ar-harness.sh`, invoke the gate's host command as follows.

```bash
bash tests/stage1-gates/agent-runner.sh baseline ".*" /external/app-stage-manifest.json /external/mux
```

The host job packs and installs `b025fdb8`, stages assets with the installed CLI and archives the tarball digest, candidate build diff, runner SHA, raw observations and assertion receipts. `summary.json` reports exact missing IDs, failures and duplicate IDs. A filter produces a partial run. A build, browser or worker setup failure leaves required IDs missing. `controls.jsonl` records the original verdict checks, injected values and whether each seed reached its designated assertion. Keep the first run's evidence when retrying with a new run ID.

The pinned mux adapter runs against a Playwright-supplied private slot and checks both raw and legacy projections. Release qualification also needs the real mux worker's result writer and reader. Provider companions compile from the frozen candidate's source and serve assets from the installed artifact, with separate route IDs for the selectable JS/TS routes and C++ direct execution.

The cap dispositions are part of the assertion inventory. Python tests its existing item ceiling. The other baseline byte-limit cells fail with the recorded absence of a product-owned seam. The gate needs a product-owned policy before it can run the 1,024-byte control on those serializers.

Historical controls use separate host job suffixes and the same committed oracles. Set `TRACECODE_STAGE1_SUBJECT` to `e13bf6ec1b67681eede99c8dea1df951b424eb91` for the pre-#68 paired printer, `15ebff79943cf991ed5f4921fd9609c3b48f33d3` for the pre-cycle Java graph, or `published-0.17.1` for the published queens artifact. Compare the targeted assertion and raw receipt before accepting a historical red. Required companion routes that run only on the frozen candidate remain missing in these historical reports.

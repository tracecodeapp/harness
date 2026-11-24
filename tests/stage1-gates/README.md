# Stage 1 G1 and G6 qualification

The default matrix resolves `@tracecode/harness/judge` from an isolated tarball installation and runs in full Chromium. `manifest.json` contains the exact programs, expected answers, comparator targets and assertion IDs. It is reproducible with `node tests/stage1-gates/build-manifest.mjs` from a checkout that can read the pinned fixture commits. The core request matrix contains 18 row observations and 144 ordinary row assertions for each two-case stdout fixture. G1 adds four one-shot `execute` observations for each pair, one traced and one untraced request per case. The runner projects the requested trace options against the installed package's published capabilities before calling Judge or the mux adapter.

Script invocation uses the function style without a named selector. The invocation fixtures assign the `result` variable and print it. The no-default and default-constructible C++ `Value` witnesses use the same mixed argument shapes. The app stages use their own budgets and remain external to this checkout.

```bash
node tests/stage1-gates/app-cases.mjs /path/to/read-only/algoflow /outside/git/app-stage-manifest.json
bash tests/stage1-gates/stage-mux.sh /path/to/multiplexer /outside/git/mux
```

`app-cases.mjs` reads the pinned app commit without changing the worktree. It computes the answers from the graph and ranking rules and checks them against the supplied comparator targets. Stage the generated app manifest and mux directory separately on the build host. From `ar-harness.sh`, invoke the gate's host command as follows.

```bash
bash tests/stage1-gates/agent-runner.sh baseline ".*" /external/app-stage-manifest.json /external/mux
```

The host job copies and verifies the canonical `b025fdb8` tarball, installs it in an isolated consumer and stages assets with the installed CLI. It archives the packed and installed Judge digests, the runner SHA, raw observations and assertion receipts. `summary.json` reports exact missing IDs, failures and duplicate IDs. A filter produces a partial run. A build, browser or worker setup failure leaves required IDs missing. `controls.jsonl` records the original verdict checks, injected values and whether each seed reached its designated assertion. Keep the first run's evidence when retrying with a new run ID.

The pinned mux adapter runs against a Playwright-supplied private slot and checks both raw and legacy projections. Release qualification also needs the real mux worker's result writer and reader. Provider companions compile from the frozen candidate's source and serve assets from the installed artifact, with separate route IDs for the selectable JS/TS routes and C++ direct execution.

The cap dispositions are part of the assertion inventory. Python tests its existing item ceiling. The other baseline byte-limit cells fail with the recorded absence of a product-owned seam. The gate needs a product-owned policy before it can run the 1,024-byte control on those serializers.

The print-then-throw fixture checks for both messages and the deliberate runtime error in every receipt. For Java, Python, C# and C++, its text oracle allows one trailing LF per captured message. JS and TS use their line-oriented console and must match its LF framing. Judge paths within each language must agree byte for byte. `console-framing.jsonl` records byte differences from program writes and indicates whether framing alone accounts for each difference.

The Java and Python Playground fixtures use selector-free script source. They call `evaluateAlgorithm` with `functionName: null` and no limit override for tracing, and with `functionName: ''` and `wallClockMs: 60000` for untraced execution. The Python fixture also calls `execute` with both shapes. All requests must preserve the prints before the runtime error.

The Python tier fixtures run the untraced submit matrix with the same print and error oracle. The plain function selects `algorithm-fast`, a positional-only argument selects `judge-compatible`, and `try` with `finally` selects `hard-isolated`. The `submit-default-AB` assertion checks the prepared artifact and execution replies. The first two tiers must answer a two-case batch with the matching fast-batch or filesystem-scope timing markers. Hard isolation must answer each case in a separate worker generation.

The C++ terminator failure needs the index read on its own source line. The one-line sibling is a passing regression guard. The Java graph seed copies the second edge on the worker request, and the Python output seeds change scoped worker replies before Judge sees them.

Historical controls use separate host job suffixes and the same committed oracles. Set `TRACECODE_STAGE1_SUBJECT` to `e13bf6ec1b67681eede99c8dea1df951b424eb91` for the pre-#68 paired printer, `15ebff79943cf991ed5f4921fd9609c3b48f33d3` for the pre-cycle Java graph, or `published-0.17.1` for the published queens artifact. Compare the targeted assertion and raw receipt before accepting a historical red. Required companion routes that run only on the frozen candidate remain missing in these historical reports.

## Step candidates

To gate a step candidate (any exact commit), carry its packed tarball forward instead of rebuilding. Set `TRACECODE_STAGE1_SUBJECT` to the 40-hex commit, `TRACECODE_STAGE1_SUBJECT_TARBALL` to the tarball path on the host, and `TRACECODE_STAGE1_SUBJECT_SHA256` to its independently pinned SHA-256. The runner checks the digest before and after copying, checks out the same commit as the companion source, installs the tarball into the isolated consumer and loads only the tar-member-identical `judge.js`. The manifest's `candidatePrediction` text still describes the frozen `b025fdb8` candidate. A step candidate is judged by its assertion results, where required baseline failures are expected to turn green.

Registered 0.21 paths compare ordinary rows across requests and compare attachments on redraws of the same retained case. A cold continuation may dispatch an observer. A redraw must reuse the attachment with zero worker commands. The gate reads both converter overloads and keeps ordinary grade checks active when presentation refuses. The registered syntax fixture expects an ordinary compile failure with zero case rows and no handle, and checks the original failure across requests. The pinned mux legacy response still projects the compile failure onto each submitted case ID.

The gate detects a registered path from an attachment or a trusted scheduler event. Set `TRACECODE_STAGE1_RECEIPT_LANGUAGES` to the candidate's comma-separated registered languages to apply the contract to default and mux routes even when a request group yields no evidence. Source companions are judged by their own observed path. The frozen candidate uses its historical oracle and assertion IDs.

The `receipt-publication` and `cache-hit` IDs use the private Judge test bridge. They remain missing when the installed candidate does not supply the journal. The transport and attachment equality checks still run. The graph oracle independently accepts a bijective renaming of graph IDs and the verdict checks flag any resulting product misgrade.

The C++ `print-then-throw` fixture checks the 0.21 exception refusal on step 7's final pin and on subsequent candidates registered with `TRACECODE_STAGE1_RECEIPT_LANGUAGES=cpp`. It requires the same typed compile failure across Run, Submit, mux and both direct modes. Frozen, 0.17.1 and the two earlier carried C++ step 7 pins retain the runtime oracle.

Run the local oracle controls with `node --test tests/stage1-gates/ga-receipt-controls.test.mjs`.

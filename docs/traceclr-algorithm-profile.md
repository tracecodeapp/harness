# TraceCLR algorithm profile

## Decision

C# has two different product contracts and should not force them through one browser image:

- Project and terminal execution keep the broad .NET/Mono runtime.
- Practice and Judge execution use a generated algorithm profile and a fresh, compiler-free
  worker for every isolated case.

The compiler remains a long-lived trusted authority. It emits ordinary Roslyn PE/CIL plus a
generated typed driver. The disposable runner loads that assembly and calls the driver's binary
entry point. This preserves real C# and CLR semantics while removing Roslyn, JSON reflection,
project hosting, and broad framework roots from the per-case startup path.

No unsupported program silently falls back to a broader execution profile. Profile selection is
an explicit compiler result, and an unavailable profile is a preparation error.

## Generated corpus contract

`pnpm generate:traceclr-profile` compiles every C# practice reference solution independently with
the same global usings and structural prelude as the Harness. The generator records:

- the source-corpus digest and per-source digests;
- direct framework assembly references, type/member references, and CIL opcodes;
- public solution and operations-class call contracts;
- the typed binary wire shape of every parameter and result;
- whether a direct binary driver was generated and successfully recompiled for that exact
  Roslyn method symbol;
- compiler, current-runner, and minimal-runner root assemblies; and
- the transitive runtime closure used to audit the published runtime.

The default product checkout is the `algoflow` sibling of `tracecodeapp`; another checkout can be
provided with `TRACECODE_PRODUCT_ROOT` or `--product-root`.

```bash
pnpm generate:traceclr-profile
pnpm generate:traceclr-profile --check
pnpm check:traceclr-profile
```

The first command regenerates the JSON inventory and MSBuild props. The second independently
recompiles the product corpus into a temporary directory and byte-compares both generated files.
The third is the public Harness gate: it validates the checked-in profile, recompiles every
claimed direct driver, verifies the TypeScript binary codec, exercises `HashSet<T>`, ref/generic/
multidimensional negative signatures, and rejects syntax failures plus process, file, reflection,
interop, thread, and network APIs. The API deny rules live in the generated profile config rather
than being hidden in a test.

The product integration gate must run `generate:traceclr-profile --check`, because only the
product repository can prove that its private corpus still has the committed digest. The Harness
gate proves the committed release is internally consistent; it does not pretend to see a corpus
that is not present.

Larger external corpora can be audited without changing the release profile:

```bash
pnpm audit:traceclr-corpus \
  --corpus /path/to/tracecode-harness-corpus.json \
  --output /tmp/traceclr-audit/profile.json \
  --limit 0
```

The audit accepts JSON or JSONL, selects only C#, deduplicates source paths, and uses a
deterministic problem-balanced selection when `--limit` is nonzero. It records a source-selection
ledger beside the generated profile so every result is attributable to its corpus row.

## Current corpus result

The 2026-08-11 AgentRunner inventory compiles all 283 practice solutions. Their emitted CIL
directly references only `System.Collections`, `System.Linq`, `System.Memory`, and
`System.Runtime`. All 24 design/operations-class sources now have constructor and method
contracts; they are not treated as missing data.

Of 343 callable contracts, 340 fit the typed wire vocabulary and 257 currently qualify for the
single-method direct driver. Operations classes, void-mutation contracts, and ambiguous or
unsupported overloads remain explicit broader-profile cases. The three wire exceptions are:

- `accounts-merge.cs`, whose current signature uses nested `object` lists;
- `currency-arbitrage-detector.cs`, whose rates use `object[][]`; and
- `mini-parser.cs`, whose result is the problem-specific `NestedInteger` type.

These require dedicated tagged-union/custom-node codecs. They are not justification for keeping
generic JSON hydration in every runner.

## External compatibility evidence

The AgentRunner `leetcode-kaysss` snapshot adds 8,248 known-good C# solutions over 2,112
problems. All 8,248 compile through the profile generator. The 42,052 accepted behavioral
mutations cover 1,968 problems; all 42,052 also compile, which is essential because these are
wrong algorithms rather than invalid C# programs.

These C# rows were semantically transpiled from the snapshot's Python solutions rather than
written organically in C#. They are excellent breadth and behavioral-differential evidence, and
are complemented by the product's handwritten/reference C# corpus below.

The larger corpus expands direct dependencies from four to six assemblies:
`Microsoft.CSharp`, `System.Collections`, `System.Console`, `System.Linq`,
`System.Linq.Expressions`, and `System.Runtime`. Dynamic-language support is localized: 270 valid
solutions use `Microsoft.CSharp`, 305 use `System.Linq.Expressions`, and 205 expose `dynamic` in
their callable wire contract. Of the 8,248 valid contracts, 8,038 fit the first wire vocabulary;
the remaining 210 were 205 `dynamic` contracts and five `HashSet<T>` contracts. `HashSet<T>` is
now a generated binary codec with a cross-language round-trip and compiled-driver gate; dynamic
binding remains an explicit compatibility-profile boundary.

This supports treating dynamic binding as a separate compatibility profile, not as an invisible
dependency of every isolated case.

The invalid corpus has the same shape: the original inventory found 41,040 of 42,052 contracts in
the first wire vocabulary; 988 of the 1,012 exceptions were `dynamic`, and the other 24
`HashSet<T>` contracts are now covered by the codec.

The execution differential uses independent TypeScript encoding/decoding around generated CIL
drivers. A deterministic 500-problem valid sample produced 486 direct drivers: 485 completed and
matched exactly, while one alleged known-good transpiled source threw on its own recorded input
(a corpus defect, retained as evidence rather than waived). A 500-problem mutation sample
executed 484 direct drivers: 290 returned different results, five threw, and two timed out and
were killed. The remaining 187 matching rows show why one recorded case does not by itself prove
a mutation valid; this gate tests the runtime boundary rather than relabeling the mutation corpus.

For native C# evidence, `create-traceclr-product-corpus.mjs` extracts concrete cases from the
product's C# reference solutions while excluding `any-valid` cases that require product-specific
validators. On AgentRunner, 177 direct-driver cases executed with 177 exact matches, zero errors,
and zero timeouts. Thirteen broader/ambiguous contracts were reported as skips rather than being
silently routed through the fast path.

## Minimal runner proof

`TraceCode.CSharpAlgorithmRunner` is a compiler-free experimental runner. Its prepared boundaries
accept a SHA-256-bound CIL artifact plus binary input and return either binary output or binary
output with the canonical TraceCode event stream. It loads a normal CIL assembly and invokes
`TraceCodeDriver.Run(byte[])`. `TraceCode.TraceClrWireProbe` exercises a real C# `TwoSum`
implementation, collection use, typed binary inputs and outputs, and static-state isolation.
`TraceCode.TraceClrWire` now generates that adapter from the Roslyn method symbol, and every
supported adapter is compiled before its profile claim is accepted.

On AgentRunner (.NET SDK 10.0.300, runtime 10.0.8), the trace-capable proof bundle contains 28
files and is 4,511,646 raw bytes / 1,545,376 bytes at Brotli quality 5. The additional quarter
megabyte over the plain spike contains the shared trace sink, event backfill, and response writer;
Roslyn and project hosting remain absent.

| Browser | First worker | Cached median | Cached p95 |
| --- | ---: | ---: | ---: |
| Chromium | 119 ms | 108 ms | 115 ms |
| Firefox | 172 ms | 150 ms | 158 ms |
| WebKit | 135 ms | 159 ms | 168 ms |

The Wasm heap starts at 32 MiB. Each sample creates a new outer worker, so process globals cannot
cross cases. Loading the same learner bytes twice within a worker also created separate assembly
identities in the probe, but that is not treated as a process-isolation guarantee.

The browser gate also runs an intentional managed exception and infinite loop. The exception
retires its worker, the loop is terminated from outside the worker, and a subsequent fresh worker
succeeds with clean static state in Chromium, Firefox, and WebKit. Initial heap is capped at 64
MiB (observed 32 MiB), unique served bytes are capped at 4 MiB, and engine-specific first/p95
budgets are ratchets around the measurements above. Native corpus execution likewise uses one
child process per case; a collectible `AssemblyLoadContext` alone was rejected because it cannot
stop an infinite loop.

The current production runner is 12,824,853 raw bytes / about 4.1 MB Brotli and spends roughly
380-450 ms booting a fresh worker per case. Merely applying the generated roots to that existing
JSON/reflection runner reduced bytes by about 14% and startup by only tens of milliseconds. The
large improvement comes from changing the hot boundary, not from deleting a few assemblies.

## Deterministic production tiers

The compiler host now selects the runner tier before learner code executes. A code or trace
`solution-method` preparation uses `algorithm-fast` only when Roslyn finds one unambiguous
`Solution` method, no semantic `System.Console` use, and the shared binary-driver generator can
represent the complete signature. Operations classes, void-mutation contracts, dynamic or
unsupported signatures, ambiguous methods, and Project/general execution select the
`compatibility` tier with an explicit reason.

The selected tier and wire contract travel with the prepared artifact, and the tier is part of
the artifact identity. A fast artifact therefore cannot collide with or enter the compatibility
driver. The browser client acquires the selected runner before execution and encodes fast inputs
with the generated binary contract.

There is deliberately no cross-tier retry after execution begins. A learner exception, timeout,
or malformed result retires that worker and returns the failure; it never re-executes the same
code in the compatibility tier. Infrastructure recovery may recreate a worker and retry only the
same selected tier. This prevents duplicate side effects, timing changes, and fast-path defects
from being hidden by a broad fallback.

The first production slice runs both driver formats inside the existing disposable Judge runner
role. `algorithm-fast` bypasses JSON/reflection hydration and invokes the generated typed binary
driver, while `compatibility` retains the existing broad boundary. Both still receive the same
fresh outer-worker isolation and timeout retirement. Chromium, Firefox, and WebKit Judge batches
pass with case concurrency fixed at one, including explicit proof that an algorithm-fast learner
failure does not acquire or execute a compatibility runner. Fast trace execution uses the same
instrumentation, trace sink, source backfill, limits, and outer-worker retirement as compatibility
execution. Browser gates verify canonical event output, `recordTrace=false`, and trace-limit
behavior.

`pnpm bench:traceclr-tiers:matrix` measures the same compiled `Add` contract and input through a
fresh compatibility worker, integrated binary-driver worker, minimal runner, and native `dotnet`
process. The trace columns use the same trace-instrumented artifact, inputs, output, and five-event
stream through all three browser shells. It runs every sample sequentially. Twelve-sample
AgentRunner results were:

| Engine | Compatibility plain | Integrated plain | Minimal plain | Compatibility trace | Integrated trace | Minimal trace | Native process |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium | 452 ms | 256 ms | 119 ms | 472 ms | 307 ms | 177 ms | 68 ms |
| Firefox | 906 ms | 239 ms | 148 ms | 1,002 ms | 406 ms | 339 ms | 62 ms |
| WebKit | 432 ms | 214 ms | 148 ms | 449 ms | 298 ms | 220 ms | 78 ms |

Every trace sample records five events and requires exact canonical event equality between the
integrated and minimal shells. The benchmark also executes each trace artifact with recording
disabled and requires identical output with zero stored events. The integrated binary boundary
removes 34-60% of compatibility trace latency while preserving the existing broad runner asset
role. The minimal shell removes 51-66% from compatibility trace latency. These numbers justify
publishing a distinct minimal asset role; they are not evidence for sharing workers or weakening
isolation.

## Remaining packaging optimization

`TraceCode.CSharpAlgorithmRunner` remains an evidence-bearing minimal-runtime spike rather than a
published fourth asset role. Its trace-capable boundary is now complete, but moving
`algorithm-fast` onto that smaller manifest-locked shell is still a packaging/startup optimization,
not a fallback redesign: compiler-owned tier selection, artifact identity, isolation, and the
no-cross-tier-retry rule remain unchanged.

Every stage must preserve fresh-worker teardown, timeout retirement, exact artifact integrity,
trace parity, and the existing three-browser prepared-boundary suite.

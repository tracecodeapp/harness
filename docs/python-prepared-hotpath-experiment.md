# Python prepared-execution hot path

Date: 2026-08-09

This experiment profiles and optimizes the existing one-worker prepared Python
batch without weakening its fresh-case contract. It is a direct runtime
benchmark, not a TraceCode product A/B.

## Phase attribution

`executePreparedProgramBatch` now reports these natural per-case phases through
the existing result timing object:

- input literal conversion;
- namespace creation and destruction;
- execution-guard snapshot and restore;
- namespace binding;
- compiled executor work and result parsing; and
- filesystem journal begin and restore.

On the original three-case `sum(range(n))` workload, compiled execution was
roughly 228–235 ms per batch and the execution-guard snapshot was roughly
53–60 ms. Namespace, binding, parsing, and filesystem bookkeeping together
were below one millisecond. A trivial scalar workload still spent roughly
46–49 ms per case executing the generic prepared executor.

## Accepted optimization

Prepared inputs arrive as Python literals. `ast.literal_eval` therefore creates
a new object graph for every case, but the executor subsequently deep-copied
that graph, recursively rebuilt all lists and dictionaries in the custom-node
materializer, and recursively rebuilt primitive annotated containers such as
`list[int]` again.

The optimized path:

1. uses the fresh `literal_eval` graph directly;
2. scans the JSON-side input for TreeNode, ListNode, reference, or custom-record
   markers and runs recursive materialization only when one is present; and
3. keeps primitive-shape annotations such as `list[int]` and
   `dict[str, int]` on that fresh graph, while tuple, set, custom-class, and
   uncertain annotations retain the existing hydration path.

The marker scan is conservative: cycles and all recognized structural markers
select the old materializer. The browser isolation test mutates its input list
and verifies both cross-case freshness and that the caller-owned JavaScript
array remains unchanged. Existing custom tree/list and annotated custom-record
tests remain on the slow path.

## Measurements

Command:

```sh
node --import tsx tests/test-python-prepared-provider-browser.ts
```

The paired benchmark alternates strategy order for six iterations. Its large
input workload passes annotated lists containing 20,000, 30,000, and 40,000
integers and mutates each list inside learner code.

| Three-case batch | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Trace artifact, tracing disabled | 566.6 ms | 403.9 ms | 28.7% |
| Clean artifact | 573.2 ms | 395.5 ms | 31.0% |

The original compute-heavy scalar workload did not regress: tracing-disabled
fell from 294.9 ms to 289.4 ms, and clean fell from 298.1 ms to 287.5 ms in the
same instrumented browser test shape. These scalar changes are small enough to
treat as neutral rather than a product claim.

## Rejected experiments

- Rebuilding prepared executor source was not material; removing it moved only
  a few milliseconds inside normal variance.
- Warming the default import prelude outside learner scopes did not change the
  batch clock.
- Reusing a batch guard snapshot with defensive restore clones was slower. It
  moved snapshot work from `begin` to `restore`, raising the three-case batch
  from roughly 295–298 ms to roughly 320–330 ms.
- Sharing mutable guard templates, swapping module containers, or reusing a
  learner realm would weaken module identity and cross-case isolation and was
  not pursued.

The remaining fixed Python cost is the complete generated executor being run in
every fresh namespace plus the execution guard's module snapshot. A future fast
path must remain conservative and fall back to the current guard whenever code
can mutate imported, builtin, or module-global state.

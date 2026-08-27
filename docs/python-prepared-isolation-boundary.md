# Python prepared-execution isolation boundary

Prepared Python batches reuse one interpreter worker but preserve a fresh
learner namespace and input graph for every case. The fast path may avoid work
only when doing so keeps that case boundary intact.

## Input materialization

Prepared inputs arrive as Python literals, so `ast.literal_eval` creates a new
object graph for every case. Primitive annotated containers such as `list[int]`
and `dict[str, int]` use that fresh graph directly.

A conservative marker scan selects recursive materialization whenever an input
contains a TreeNode, ListNode, reference, custom-record marker, or cycle. Tuple,
set, custom-class, and uncertain annotations also retain the general hydration
path. Browser isolation tests must continue to prove both that learner mutation
cannot cross cases and that it cannot mutate the caller-owned JavaScript input.

## State restoration

Algorithm-fast execution snapshots and restores the Python-visible shared state
that admitted learner code can reach, including builtins, module membership,
environment variables, import paths and caches, tracing state, recursion limits,
working directory, and random state. The general guard additionally restores
module dictionaries and mutable containers reachable from them.

Code that can mutate imported, builtin, module-global, or finalizer-observable
state must remain on the conservative guard. Reusing a learner realm or sharing
mutable guard templates is outside this contract.

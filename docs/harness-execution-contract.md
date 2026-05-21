# Harness Execution Contract

Last updated: 2026-05-19

## Purpose

This document defines the V4 runtime execution contract that every TraceCode
language harness must emit. The contract is intentionally lower-level than the
visualizer, TraceLang, semantic inference, or algorithm-family systems.

The harness must describe what actually happened at runtime:

- which source line executed
- which function was entered or returned from
- which visible variables existed after a line completed
- which indexed, keyed, field, or object values were read
- which values were written
- which mutable receivers were changed
- which stdout, exception, timeout, or trace-budget events happened

The harness must not describe presentation or semantic meaning:

- no graph/list/tree/hash-map classification
- no visualizer card choices
- no algorithm family facts
- no TraceLang lowering decisions
- no presentation-only "current", "frontier", "visited", or "active" roles

## Event Model

V4 is a post-line runtime trace model.

A `line` event means the source line has executed. Events with the same `line`
describe facts caused by that source line or state visible immediately after
that source line completed.

This is not a debugger-style "next line to execute" cursor. For example,
`right -= 1` must write `right` on the decrement line, not on the next loop
condition line.

Loop and branch condition lines may emit `line` events when evaluated. They do
not need to emit scalar reads for every condition operand unless those reads are
needed as provenance for a visualizable indexed, keyed, field, or object access.
Collection metadata reads such as `queue.Count`, `list.Count`, and
`array.Length` are field-style reads when they appear in executable expressions,
including loop conditions. They should attach to the collection owner, for
example `queue` at `path:["Count"]`, so control lines carry runtime evidence
instead of only snapshots.
Looping constructs should not disappear merely because their body does not run:
`for`, `while`, `do`, `foreach`, range-for, enhanced-for, and equivalent
constructs should emit their control/enumeration line when the condition or
source enumerable is evaluated, including the final false/empty evaluation.
Those terminal loop frames should include the same in-scope `snapshot` context
as a normal control frame so downstream consumers can still render the active
line card without inventing state.

## Supported Event Kinds

The shared public event kinds are:

- `call`
- `line`
- `return`
- `snapshot`
- `read`
- `write`
- `mutate`
- `stdout`
- `exception`
- `timeout`

No language may add a new event kind without adding it to the shared type,
contract gate, documentation, and cross-language parity fixtures.

## Snapshots

Snapshots are full-frame state context. A snapshot by itself is not evidence of
a read, write, mutation, or access.

Snapshots should be useful for playback state, but consumers must not infer that
a variable was accessed merely because it appears in a snapshot.

Non-finite numeric runtime values must not silently collapse to JSON `null`.
Languages that execute with JavaScript-style JSON serialization should preserve
`Infinity`, `-Infinity`, and `NaN` as explicit sentinel strings in trace values.

Structured local initialization may emit a `write` in addition to snapshots. For
example, creating a map, list, set, queue, object, or scalar local may emit a
write on the initialized variable so consumers do not have to infer lifecycle
only from snapshots.

Snapshot omission rules do not apply to function call arguments. If a call
argument was evaluated to `undefined`, absent, or a language-specific equivalent
that cannot be represented directly in JSON, the call event must preserve an
explicit sentinel instead of silently omitting the parameter. For JavaScript and
TypeScript this sentinel is `"<undefined>"`.

User-visible object values should serialize as objects even when they are stack
locals rather than pointers or heap references. For example, C++
`ListNode dummy(0);` should emit a `write` for `dummy` whose value is a
`ListNode` object with stable identity and fields, not `{}` or snapshot-only
state.

Expression-internal interpreter frames must not leak as multiple empty public
line frames for one source assignment. For example, Python
`cloned = [[] for _ in range(n)]` should produce one public line frame for the
assignment with the completed `cloned` write, not several same-line frames from
list-comprehension iteration followed by a later write-bearing frame.

## Reads And Writes

Indexed, keyed, field, and object accesses must emit neutral `read` or `write`
events when the runtime can observe them.

Examples:

- `arr[i]` reads `arr` at `path:[valueOf(i)]`
- `matrix[r][c]` reads `matrix` at `path:[valueOf(r), valueOf(c)]`
- `map[key]`, `dict[key]`, `Map.get(key)`, and `containsKey(key)` read the keyed receiver at `path:[valueOf(key)]`
- `obj.field` reads or writes `obj` at `path:["field"]`
- `node.children[key]` reads or writes `node` at `path:["children", valueOf(key)]`
- `queue.Count` and `arr.Length` read the receiver at `path:["Count"]` or `path:["Length"]`
- `grid[0].length`, `grid[0].Length`, or equivalent nested metadata reads
  read the receiver at `path:[0, "length"]` / `path:[0, "Length"]`
- `board[0].length()` for Java `String[]` reads `board` at
  `path:[0, "length"]`, because the string length is metadata on the indexed
  receiver element

Access event values must be captured at the moment the access is observed.
They must not be reconstructed later from post-line snapshots, because the
same source line may mutate the receiver after the read. For example,
`next = curr.next; curr.next = prev` must report the original `curr.next`
value on the field-read event, not the post-mutation field value.

Reference-like structures must use stable object identity within a run. If two
events or snapshots contain `__id__:"x"`, that id must refer to the same
runtime object. Serializers must not restart local id numbering for each
individual access event in a way that lets distinct nodes in the same frame
reuse `ref-0`, or lets the same node change from `Node:1` to `Node:2` across
trace events in the same run.

Field-owned nested structures should stay attached to the owning object when
possible. Do not invent separate presentation variables such as `node.children`
unless the source runtime actually exposes that variable as a runtime local.

Pure library helper calls do not need separate public `call` / `return` events
unless they mutate state or expose an otherwise missing indexed, keyed, or field
access. For example, `board[0].isEmpty()` should expose the `board[0]` receiver
read, but the `isEmpty()` predicate itself does not require a synthetic call
event. This keeps V4 focused on state operations rather than every runtime
library helper invocation.

## Mutations

Mutable receiver operations emit `mutate` events.

Examples:

- `list.append(value)`, `array.push(value)`, `vector.push_back(value)`
- `queue.push(value)`, `queue.pop()`
- `set.add(value)`, `set.delete(value)`
- `map.put(key, value)`, `map.set(key, value)`
- in-place library mutations such as Python `list.sort(...)`, `sort(values)`,
  `Arrays.sort(array, comparator)`, and `std::sort(values.begin(), values.end())`
- fixed-size receiver mutations such as `std::array::fill(value)` and
  `Arrays.fill(array, value)`

Executed mutator calls are observable even when they are logical no-ops. For
example, `clear()` on an already-empty map, list, or set still emits a
`mutate` event because the source-level operation executed. Consumers should
not have to infer that operation from an unchanged snapshot.

When a mutation has an indexed or keyed target, the event target should include
that path and any available source-expression provenance for the path. A keyed
map put should also emit the corresponding `write` fact for the key when the
runtime can observe it.

Mutation `args` should be the source-level method arguments in order after
runtime evaluation. For keyed writes this means key and value, not value alone:

- no-argument mutators such as `clear()`, `pop()`, `pop_back()`, and `pop_front()` => `args:[]`
- no-argument removing mutators that return a value, such as Java `poll()` and
  `remove()`, still use `args:[]`; the removed value is represented by the
  corresponding receiver read and by any enclosing mutation argument that
  consumes the returned value
- `map.put(key, value)` => `args:[keyValue, writtenValue]`
- `set.add(value)` => `args:[value]`
- `list.append(value)` => `args:[value]`

Indexed receiver mutations should preserve both receiver path provenance and
mutation arguments:

- `graph[i].append(j)` / `graph[i].push(j)` / `graph[i].Add(j)` / `graph[i].push_back(j)` => `target.path:[iValue]`, `target.indexSources:["i"]`, `args:[jValue]`
- `graph[i].insert(j)` for nested set-like values => `target.path:[iValue]`, `target.indexSources:["i"]`, `args:[jValue]`
- `groups[key].append(value)` / `groups[key].push_back(value)` => `target.path:[keyValue]`, `target.indexSources:["key"]`, `args:[value]`
- `graph[w1[j]].insert(w2[j])` may use source-expression provenance for the key => `target.indexSources:["w1[j]"]`, `args:[valueOf(w2[j])]`

Languages with native containers that cannot always be replaced by tracing
wrappers still owe the same mutation facts. For example, C++ local containers
such as `std::vector<std::string>` or `std::vector<CustomStruct>` may remain
plain STL containers for compile/runtime compatibility, but
`names.push_back(emailToName[email])` must still emit both the keyed read for
`emailToName[email]` and a `mutate` event for `names.push_back(...)` with the
evaluated pushed value in `args`.
Set-like native inserts follow the same rule: `visited.insert(v)` must emit a
`mutate` event for `visited.insert(...)` on the insert line with the evaluated
inserted value in `args`.

## Iteration Binding

Foreach, enhanced-for, range-for, enumerate, and similar element binding forms
must emit provenance when the source collection is observable.

Structured binding over keyed containers must expose the produced key binding.
For example, C++ `for (const auto& [ch, _] : adj)` must emit a `read` on the
loop header line for `adj[ch]` with `binding:{kind:"iteration",variable:"ch"}`
before body writes such as `inDegree[ch] = 0` rely on `indexSources:["ch"]`.

The binding event is a `read` from the iterated collection with:

- `target.variable`: source collection variable
- `target.path`: concrete element position or key when available
- `binding.kind`: `iteration`
- `binding.variable`: loop binding variable. For destructuring bindings, use a
  stable comma-separated list of bound source names, for example
  `course,prereq` for `for (const [course, prereq] of prerequisites)`.
- `value`: concrete element value

Example:

```json
{
  "kind": "read",
  "line": 22,
  "target": { "variable": "accounts", "path": [0] },
  "binding": { "kind": "iteration", "variable": "account" },
  "value": ["John", "john@example.com"]
}
```

`indexSources` is not required for implicit iteration positions because many
languages do not expose a source-level index expression in foreach syntax.
When the iterated source is itself indexed or keyed, the binding path should
include the selected container path plus the implicit element position when
available, and `indexSources` should stay path-aligned:

- `for x in graph[course]` => `target.path:[courseValue, elementIndex]`,
  `target.indexSources:["course", null]`, `binding.variable:"x"`

Iteration binding reads should be attached to the iteration they create. The
binding read value and same-header snapshot of the loop variable should agree;
do not attach a binding read for the next iteration to the previous iteration's
header frame.

Iteration bindings should also emit scalar state for the produced binding on
the same header line. A consumer should not need to infer `account = accounts[0]`
only from binding metadata; it should see both the collection read and a
same-line `write` for `account` with the same value.

C++ range-for syntax with qualified reference types is included in this rule.
For example, `for (const std::string& s : strs)` must emit an iteration read
from `strs[path:[i]]` with `binding.variable:"s"` on the loop header line.

Index-producing iteration helpers must expose the produced index as runtime
state, not only as a snapshot. For example, Python `for i, num in
enumerate(nums):` should emit same-header evidence for both bindings: a scalar
write for `i` with the concrete index and an iteration read for `num` from
`nums[index]`. When the element read path is produced by that index binding,
the read should also carry aligned provenance such as `indexSources:["i"]`.

## Index Sources

`target.path` is the concrete runtime path. `target.indexSources` is optional
source-expression provenance for path components.

Use `indexSources` when a path component came from an observable source
expression. Preserve the expression used at the access site instead of
collapsing it to the base variable; this lets downstream consumers distinguish
`i` from `i - 1` without re-parsing source code.

- `arr[i]` => `path:[iValue]`, `indexSources:["i"]`
- `arr[i + 1]` => `path:[iValue + 1]`, `indexSources:["i + 1"]`
- `arr[i - 1]` => `path:[iValue - 1]`, `indexSources:["i - 1"]`
- `grid[row][col]` => `path:[rowValue, colValue]`, `indexSources:["row", "col"]`
- `dp[i - 1][j]` => `path:[iValue - 1, jValue]`, `indexSources:["i - 1", "j"]`
- `map[key]` => `path:[keyValue]`, `indexSources:["key"]`
- `counts[text[i] - base]` => `path:[computedValue]`, `indexSources:["text[i] - base"]`
- `counts[text.charAt(i) - base]` / `counts[text.charCodeAt(i) - base]` =>
  `path:[computedValue]`, preserving the full access-site expression in
  `indexSources`
- `lps[i++] = 0` => `path:[oldValueOf(i)]`, `indexSources:["i++"]`, with a
  same-line scalar write for `i` after the update expression is evaluated

For field-owned containers, `indexSources` is path-aligned. Static field path
segments use `null`, and dynamic keyed/indexed segments use their source
expression when available:

- `obj.children[key]` => `path:["children", keyValue]`, `indexSources:[null, "key"]`
- `this.counts[key]` => `path:["counts", keyValue]`, `indexSources:[null, "key"]`

Do not require `indexSources` for literal-only indices. The concrete path is
sufficient:

- `arr[0]` => `path:[0]`
- `obj.children["a"]` => `path:["children", "a"]`

Do not require full transitive dataflow provenance in `indexSources`. If a local
`value` was assigned from `account[i]`, then `map.put(value, owner)` may use
`indexSources:["value"]`. The runtime event should be truthful about the source
expression used at the mutation site. Deeper provenance can be reconstructed
from prior runtime reads/writes or semantic layers.

Lexically captured variables still count as observable source expressions. For
example, a C++ lambda that captures `grid` and executes `grid[r][c] = '0'`
should emit `path:[rValue, cValue]` with `indexSources:["r", "c"]` for the
read/write events. A language harness must not drop provenance merely because
the accessed collection belongs to an outer lexical frame.

Source-expression provenance must be captured before harness instrumentation
rewrites the expression. For example, JavaScript/TypeScript
`prefix[prefix.length - 1]` should preserve
`indexSources:["prefix.length - 1"]` for the indexed read even if the harness
also emits a field read for `prefix.length` while evaluating the expression.
Instrumentation helper calls must not replace source-level provenance.

If harness instrumentation cannot be applied, the runtime should make that
failure visible to development diagnostics. Synthetic fallback traces are only
a last-resort execution result; they do not satisfy the V4 contract for
control-flow-heavy code because they cannot expose nested calls, loop lines,
or access events. Regression tests should cover cases where instrumentation
previously fell back silently, such as recursive local helper functions.

## Scalars

Scalar writes are valid V4 evidence and should be emitted when the language
runtime supports them.

Examples:

- `i += 1` writes `i` on that line with the post-write value
- `i++`, `++i`, `i--`, and `--i` write `i` on that line with the post-update
  value, including when the update expression appears inside a larger source
  expression such as `nums[i++]`
- `right -= 1` writes `right` on that line with the post-write value
- `length = max(...)` writes `length` on that line with the post-write value
- `rows, cols = ...` writes both `rows` and `cols` on that line with their
  post-assignment values
- tuple/deconstruction bindings such as C# `var (r, c) = queue.Dequeue()`
  write both `r` and `c` on the binding line with the values produced by the
  right-hand side

Scalar-only reads are not required unless they are part of a visualizable
indexed, keyed, field, or object access.

Indexed augmented assignments must expose the concrete pre/post values for the
indexed cell, not only the final snapshot:

- `inDegree[course] += 1` emits a `read` with the old cell value and a `write`
  with the incremented cell value, both with `indexSources:["course"]`

Fixed-size and native arrays still follow the indexed-state contract when the
language runtime can observe them. For example, `counts[i]++` writes
`counts[path:[iValue], indexSources:["i"]]`, and raw C/C++ arrays in snapshots
serialize as indexed values instead of opaque objects. Indexed unary mutations
such as `arr[i]++` and `arr[i]--` should preserve the same path-aligned source
provenance as explicit assignments to `arr[i]`.
Native array reads also emit indexed read evidence when observable. For
example, C++ `int nr = r + dr[d];` emits a `read` for
`dr[path:[valueOf(d)], indexSources:["d"]]` on the initializer line before the
scalar write for `nr`.

C++ `std::vector<bool>` is still an indexed collection for V4 purposes even
though the C++ standard library represents elements through proxy references.
Reads and writes such as `visited[nodeIdx] = true` and
`if (!visited[neighborIdx])` must emit path-aligned `write`/`read` events with
the concrete boolean value and the same `indexSources` shape as other vectors.
Instrumentation must not rewrite identifiers inside generated C++ string or
character literals while preserving index-source metadata.

C++ references to indexed values remain observable locals when the referenced
type is visualizable. For example, after
`const std::string& w1 = words[i]`, a condition such as `w1[j] != w2[j]`
must emit string indexed reads for `w1[j]` and `w2[j]` on the condition line
with `indexSources:["j"]`.

C++ declaration discovery must be source-comment tolerant. A runtime-visible
declaration followed by a trailing comment, such as
`std::unordered_map<int, int> rightIndex; // key -> index`, is still the
declaration of `rightIndex`; later `rightIndex[key] = idx` writes must be
emitted normally.

## Line Anchoring

Events should be attached to the source line that caused them.

- Assignment writes attach to the assignment line.
- Declaration initializers attach to the declaration line.
- Multiline declaration initializers attach their creation write to the
  declaration start line, not to the previous executable line and not to the
  initializer closing line.
- Declaration instrumentation must not scan forward from a blank/comment-only
  line and then anchor the discovered declaration to that blank line.
- Method-call mutations attach to the method-call line.
- Return events attach to the return line.
- Explicit valued returns should include the returned value even when that value
  is `null` or the language equivalent. Void/no-value returns may omit `value`,
  but `return null;` should emit `value:null`.
- Function `call` events are frame-entry events. Their `line` should identify
  the user source line where the entered function/lambda/method frame begins.
  The call-site expression itself is represented by its own `line` event and
  subsequent call-stack context; do not require a second call event on the
  call-site line unless the language runtime explicitly supports that model.
- Local function-object/lambda calls may anchor the `call` event to the
  invocation line when the runtime can observe that line without guessing. In
  that model, the lambda body should still emit a frame-entry `line` event for
  the lambda declaration/body line so playback can distinguish invocation from
  entered body.
- Script mode starts at top-level executable statements, then enters function
  bodies when calls occur.
- Unbraced control-flow bodies attach to the body statement line, not the
  control header or any generated wrapper line.
- Loop control/enumeration events attach to the loop header line, including the
  final failed condition or empty enumerable evaluation.
- Terminal loop control/enumeration line frames include snapshots of in-scope
  variables; they must not be bare line-only frames unless tracing is explicitly
  in a minimal/no-snapshot mode.

Generated wrapper/helper lines must map back to the user source line whenever a
runtime fact is caused by user code.

## Frame Identity

Every event that belongs to an active runtime frame should carry enough frame
identity for downstream tooling to group same-line facts correctly. A language
may expose this as `callStack`, `frameId`, or an equivalent normalized frame
identifier, but line, snapshot, read, write, mutate, call, and return events
from the same execution frame must be correlatable.

Audit and validation tooling must preserve that frame identity. It must not
compare same-line events from different recursive frames as if they were one
source step, and it must not drop unscoped snapshot/access events when the raw
event stream already carries a frame identifier.

## Iteration Binding

Collection-backed loop bindings should emit provenance for the source element
that produced the loop variable. This applies to simple and destructuring
targets. For example, Python `for u, v, w in edges:` should emit an
iteration-binding read from `edges[path:[k]]` with
`binding:{kind:"iteration", variable:"u,v,w"}` and the concrete triple value.
The scalar writes to `u`, `v`, and `w` are useful state evidence, but they do
not replace source-element provenance.

## Destructuring Writes

Destructuring assignment to named locals is still a set of scalar writes. For
example, JavaScript/TypeScript `[n, edges, src] = [a, b, c]` should emit writes
for `n`, `edges`, and `src` on the assignment line after the assignment has
executed. Property destructuring or property swaps should not be coerced into
scalar-local writes for the receiver object; those remain field/index writes
when the runtime can observe them.

## Parity Gates

Any newly discovered invariant should be reduced to a runtime parity fixture
before or alongside the harness fix.

Relevant gates:

- `pnpm test:runtime-trace-fixtures`
- `pnpm test:runtime-trace-fixtures:raw-strict`
- `pnpm test:runtime-raw-emission-contract`
- language-specific gates such as `pnpm exec tsx tests/test-java-runtime.ts`

The cross-language fixture should cover Python, JavaScript, TypeScript, Java,
C#, and C++ unless the operation cannot be expressed equivalently in a language.
If a language differs, the fixture must document the gap instead of silently
weakening the shared expectation.

## Model Audit Role

The nano model audit is a discovery tool, not the source of truth. A model
finding becomes actionable only when it contradicts this contract or exposes an
unclear area that should be added to this document.

When the model over-requires evidence, prefer tightening the prompt or contract
wording over adding noisy runtime events.

# Python algorithm-fast batches

Date: 2026-08-26

## Product contract

Practice evaluation prepares one immutable program, runs every case through
the browser Judge and TraceKernel process boundary, and reports a result only
after all cases settle. Python exposes the shared two-profile contract. Its
classifier retains detailed internal reasons so compatibility can choose the
necessary concrete boundary:

| Tier | Batch boundary | Intended use |
| --- | --- | --- |
| `algorithm-fast` | One retained Pyodide worker with the reduced capability driver | Ordinary admitted interview algorithms |
| `compatibility` | Full generic executor, with a fresh outer Pyodide worker whenever retained state is not proven safe | Code outside the reduced contract |

The fast profile reuses one initialized interpreter. Every case still receives:

- a fresh learner namespace and a fresh `Solution` instance;
- a fresh input object graph;
- the same initial RNG state;
- independent stdout capture and resource-limit accounting; and
- no file, process, thread, network, dynamic-import, or interpreter-introspection
  authority.

The outer prepared execution owns only disposable workers. Cancellation,
client timeout, program disposal, or provider reset terminates the active
worker. Project and terminal execution are unchanged. Known ambient or
interpreter-wide capabilities and unsupported reduced-driver constructs select
the public compatibility profile.

## Admission and fallback

Preparation parses the learner source with Python's `ast` module and records an
internal admission decision in the marshaled artifact.
The fast batch driver is compiled only for an admitted code artifact and is
required by artifact validation before execution. Execution re-derives the
profile from the bound source before selecting the reduced guard, so a stored
tier cannot promote source that the active policy rejects.

The current fast profile admits synchronous `function` and `solution-method`
targets whose parameters can be called by name. It admits a reviewed
algorithm-library set, including `collections` and `deque`. Structural reduced
driver limitations such as generator expressions, exception finalizers, and
unsupported call signatures select `judge-compatible`. The following known
capability and shared-state surfaces select `hard-isolated`:

- filesystem, process, thread, network, browser, and dynamic-import modules;
- `open`, `exec`, `eval`, `compile`, `__import__`, and reflective builtins;
- dunder, frame, generator, coroutine, async-generator, traceback, and code
  object introspection, plus private access into shared runtime objects;
- string-based reflective helpers such as `operator.attrgetter` and
  `str.format` attribute traversal, plus `functools.update_wrapper`/`wraps` and
  dunder-valued call arguments that delegate attribute lookup by name;
- evaluating annotation APIs and string annotations, so type hydration never
  executes learner-controlled text;
- writes to, deletion from, or escape of imported and default-import objects;
- registration and overload APIs whose mutable registry belongs to the shared
  interpreter rather than the learner namespace;
- bare catch-all or explicit `BaseException` handling that could suppress the
  retained executor's per-case limit signal, context managers, exception or
  object finalizers, or generator-close handlers, plus bindings that collide
  with reserved runtime guard names;
- relative and unreviewed imports; and
- transitive traversal from an allowed module into hidden modules or builtins.

Tier selection is not a learner error. `judge-compatible` runs the same prepared
source through the existing full generic executor inside one retained worker.
It installs a fresh namespace and input graph per case and restores modules,
builtins, environment, RNG, recursion state, cwd, and filesystem changes.
`hard-isolated` adds a fresh interpreter boundary for nested or opaque runtime
state that cannot be reliably journaled.

If exact inputs require the generic tree, list, or reference-graph materializer,
an otherwise fast trace moves to compatibility before learner code starts.
Plain-input traces retain the admitted Pyodide worker, create a fresh namespace
for every case, reset trace/console/limit state, and use the reduced interpreter
guard. A mixed trace batch records only the selected cases and routes the
tracing-off subset through the reduced correctness driver. The artifact contains
one conditional trace executor rather than separately compiled trace and code
executors. An all-traced batch enters the reduced guard once and discards each
namespace before starting the next case.

An unexpected internal fast-driver failure is handled at the same outer
boundary: no partial batch result is exposed, the retained worker is retired,
and the provider re-evaluates every case in a fresh hard-isolated worker. This
is the only post-start cross-tier retry. The fast capability profile has no
file, process, network, or host authority, so the abandoned attempt cannot
commit an external learner side effect.

The AST decision is a fast pre-filter, not the capability boundary. An admitted
case receives a positive builtins allowlist instead of the interpreter's full
builtins dictionary. Its import hook only resolves the reviewed module set and
returns read-only module façades. Every attribute reached through a façade is
re-authorized against both its resolved module root and its true owner module,
so an allowed module cannot act as a bridge to hidden builtins or host modules;
reflective operator and wrapper helpers are absent. A façade resolves its real
module lazily once and caches authorized top-level bindings for the batch;
admission prevents learner code from retaining or mutating those shared
bindings, while reviewed immutable constants remain usable. The façade also
intercepts normal attribute lookup so its private module and cache slots are
not learner-readable. Registration/overload calls rooted in shared bindings
are rejected at admission, and the retained driver clears `re`'s private
compiled-pattern cache at every case boundary.
The per-case print function closes over only that case's stdout list, and the
node helpers expose only a fixed-name `val`/`value` accessor whose globals do
not contain real reflection builtins. A fresh learner namespace, builtins
mapping, `TreeNode` and `ListNode` class pair, `Solution`, inputs, stdout list,
resource counters, and RNG state are installed for every case. Before any case
executes, the batch driver reparses the bound learner source, repeats the
reflection audit, and compiles that audited source itself. The separately
marshaled compatibility code object is never executed by the fast path.
An explicit `wallClockMs` limit is forwarded into both retained executors. The
reduced driver keeps its trace hook armed from learner module execution through
input hydration, the target call, and output serialization. The generic
executor likewise keeps a `BaseException`-derived guard armed through callable
signature inspection and output serialization; code that can suppress the
guard or run a finalizer outside this interval cannot enter that tier. Each
retained path applies a separate deadline to every case
and reports only that case as `client-timeout`. Trusted driver frames are
excluded from the hook, while the generic finalizer retains its separate
serialization-size budget. The client also keeps a batch-wide watchdog for
native calls that cannot be interrupted by Python line tracing. That watchdog
adds bounded headroom for input conversion, namespace setup, and final result
encoding beyond the sum of per-case budgets. It measures active runtime calls,
not fresh-worker acquisition or warmup. If it trips, the worker is retired and
the caller receives a batch timeout with no partial results and no second
compatibility budget. Retire-and-retry is reserved for the typed
`algorithmFastBatchUnavailable` signal emitted before any partial result crosses
the worker boundary.

Before the final batch encode, each result envelope is encoded independently.
An unencodable learner result is replaced only for that case with a trusted
failure envelope. Class metadata is read through trusted base descriptors and
coerced to strings, so learner `__getattribute__` implementations cannot place
arbitrary objects in the result graph. Any later driver-level encoding failure
uses the outer retire-and-retry boundary rather than rewriting completed cases.

Compatibility trace execution and code batches requiring custom node
materialization use the generic executor and full module/filesystem rollback;
the provider retires the outer worker when the fast input contract was not met.

## Why this is materially faster

The compatibility batch executes the full generic prepared executor and deep
module guard for every case. The algorithm-fast batch instead:

1. converts the complete input batch once;
2. enters one reduced interpreter guard for the batch;
3. installs the trusted default-import namespace once;
4. copies only reviewed bindings and read-only module façades into a fresh
   learner namespace per case;
5. compiles the audited learner source once, executes that exact code for every
   case, and resets RNG and resource counters per case; and
6. uses the same argument filtering, annotation hydration, in-place-result
   resolution, stdout behavior, and result serializer as the compatibility
   executor before serializing the complete result batch once.

The TraceKernel algorithm syscall policy remains the outer authority boundary.
The Python admission profile additionally removes interpreter-internal routes,
such as Pyodide's own filesystem, which do not become TraceKernel syscalls.

## Local Judge measurements

The benchmark uses the real `createBrowserJudgeHost` boundary, the actual Python
Contains Duplicate reference solution, all-cases-pass policy, and 21,925 total
input integers across the proposed 100 cases. Language warmup is excluded from
the measured bundle-to-receipt interval. These are local Chromium development
measurements, not a cross-machine product claim.

| Browser Judge path | 10 cases | 100 cases |
| --- | ---: | ---: |
| 0.16.8 retained generic baseline, one sample | 817 ms | 6,965 ms |
| Hard-isolated per-case path, one sample | 2,879 ms | 28,503 ms |
| Deliberately unsafe one-call ceiling, one sample | 57 ms | 227 ms |
| Capability-safe algorithm-fast candidate, three-sample p50 | 234 ms | 287 ms |
| Capability-safe algorithm-fast candidate, three-sample p95 | 235 ms | 305 ms |

The 0.16.8 row used the retained generic executor that now forms the
`judge-compatible` tier. The hard-isolated path pays for one fresh Pyodide
worker per case and is therefore substantially slower. These original
same-workload measurements predate the three-tier routing change and remain its
design baseline.

An exact-head public-Judge routing check after the three-tier change used 100
cases for each fallback and observed 9,663 ms with one retained
`judge-compatible` worker versus 31,609 ms with 100 `hard-isolated` workers.
The fixtures exercise different code and input shapes, so those figures prove
routing and worker ownership; they are not a same-workload speedup claim. The
release benchmark must rerun every tier against the same corpus.

The 100-case candidate is about 24.3 times faster than the old retained-worker
baseline and within 78 ms of the unsafe ceiling at p95. It is about 99 times
faster than forcing the same workload through the hard-isolated path, but that
is a routing cost comparison, not a claim that hard-isolated programs can
safely take a retained tier. The 10-case candidate's first
sample was 100 ms; later alternating samples were about 234–235 ms, so the
three-sample median is retained rather than promoting the warm minimum.

## Required evidence

The browser prepared-provider gate covers:

- judge-compatible rollback for globals, builtins, modules, environment, RNG,
  recursion limit, cwd, caller inputs, and filesystem changes;
- algorithm-fast admission for ordinary code and `deque` imports;
- hard isolation for filesystem/interpreter access, implicit-module mutation,
  transitive module traversal, and unreviewed imports;
- adversarial fallback for default-module self-rebinding, operator-based dunder
  reflection, format-string attribute reflection, generator/frame traversal,
  name-parameterized `functools` wrapper reflection, and shared imports captured
  through parameter defaults, including stdlib class/function aliases laundered
  through an intermediate binding;
- hard-tier admission for transitive `json.codecs`, `re.enum`, and
  `typing.contextlib` traversal attempts;
- same-artifact differential parity between the fast driver and forced generic
  fallback for argument filtering, tuple hydration, modular `pow`, in-place
  results including `matrix`, stdout, node serialization and typed-node
  hydration, callable serialization, `deque`, `List[...]` annotations, custom
  annotated classes, repeated `math` module lookups, and line-aware exceptions,
  with explicit tier assertions;
- execution-time reclassification and an adversarial source/marshaled-code
  mismatch proving the fast path executes only the audited source;
- public browser Judge proof that hard-isolated cases mutating a nested stdlib
  class receive distinct outer workers and cannot observe prior-case state;
- public browser Judge proof that a fast artifact with tree-shaped input uses
  one retained generic batch worker;
- a single admitted trace artifact records selected cases, runs tracing-off
  cases through the reduced correctness driver, preserves result order, and
  resets trace state between recorded cases without replacing the outer worker;
- hard-isolated code batches preserve a `client-timeout` result for the timed
  out case and continue evaluating later cases in fresh workers;
- judge-compatible code batches enforce `wallClockMs` from module execution
  through signature inspection and result serialization, then continue with
  later cases in the retained worker;
- algorithm-fast batches contain hostile exception formatting, enforce
  explicit wall-clock limits across module execution and result serialization,
  contain hostile result metadata per case, and continue evaluating later
  cases;
- shared stdlib registration APIs select hard isolation, while the
  private regular-expression cache is cleared at retained case boundaries;
- direct prepared-provider trace calls reject missing or non-boolean per-case
  trace selections with the same contract as the other runtimes;
- per-case global, node-class, and RNG freshness in the fast driver;
- line-limit termination followed by successful later cases; and
- portable artifact execution across fresh browser workers.

The cross-language browser Judge batch separately proves one TraceKernel batch
process, all-case correctness, fresh learner globals, and bounded worker use for
both code and trace modes.

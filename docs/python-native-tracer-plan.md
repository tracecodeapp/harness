# Python native tracer extension — plan

Goal: move the Python tracing hot path (sys.monitoring callbacks, per-line
locals capture, event JSON emission, budgets) into a C extension compiled for
Pyodide, killing the interpreted-callback floor (~40µs/line → target ~3-5µs).
Product bar: heavy traced case ≤1s (currently ~1.6s; ~1s of that is
interpreted per-line machinery that no python-level optimization can remove).
Uncapped equal-output heavy case: 8.3s → target ~1.5-2s.

This document is the handoff artifact: everything needed to continue from any
session is here or in the memory file `csharp-trace-optimization` (which holds
the cross-language sprint state) — read both before resuming.

## Context (as of 2026-08-07, branch codex/java-trace-hotpath-snapshots)

- Runtime: `workers/python/runtime-core.js` — a JS wrapper embedding the
  python tracer source. Landed already: sys.monitoring migration (settrace
  fallback kept), single-writer event stream (`_trace_events` holds compact
  JSON strings, `_TC_JSON_ENCODER`), COW rep cache for flat lists
  (`_tc_rep_cache`, hooks invalidate/patch), fragment-spliced emission,
  post-budget hook gates. Heavy-case profile buckets (traceProfile:true):
  tracer ~3.2s incl / snapshot ~1.9s / convert ~1.1s / hooks ~0.7s at 26k
  lines / 185k events uncapped.
- Target interpreter: **Pyodide 0.29.3 = CPython 3.13.2, wasm32, ABI
  2025_0** (`workers/python/pyodide-0.29.3/pyodide-lock.json`). Wheel tag:
  `cp313-cp313-pyodide_2025_0_wasm32`.
- Vendoring discipline (established this sprint): ship the artifact AND the
  pinned recipe (see `toolchains/csharp/manifest.json` pattern, tracecc
  `toolchain/`). Native wheel + build recipe both go in the repo.

## Architecture

New package `packages/runtime-python-native/`:
- `src/tracecode_native.c` — the extension (`_tracecode_native` module).
- `build.sh` + `manifest.json` — pinned pyodide-build/xbuildenv/emscripten
  versions, output wheel sha256.
- Vendored wheel at `workers/vendor/python-native/` served as a worker asset;
  the worker loads it at init via `pyodide.loadPackage(<local url>)`,
  feature-flagged, with automatic fallback to the current python tracer if
  load/import fails (zero-risk rollout).

Core design decisions:
1. **Single ordered event buffer lives in C.** The extension owns a growing
   UTF-8 buffer of newline-separated event JSON (the single-writer, moved
   native). The existing AST-rewriter access hooks (python) keep their logic
   but append through `_tracecode_native.append_event_json(str)` so there is
   ONE ordered stream — interleaving between native line/snapshot events and
   python access events is preserved by construction.
2. **C monitoring callbacks.** Register PyCFunction callables (METH_FASTCALL)
   for LINE / PY_START / PY_RETURN / RAISE. A C callback has no python frame,
   so `PyEval_GetFrame()`/`PyThreadState_GetFrame()` yields the *traced*
   frame directly. Return `sys.monitoring.DISABLE` for non-solution code
   locations (replicate the current DISABLE logic).
3. **Native serializer with python fallback.** Replicate `_serialize` in C
   for None/bool/int/float/str/list/tuple/dict/set of those (including the
   exact caps: depth 48, 64 items, 16384 chars, NaN/Infinity strings, set
   `sorted()` with TypeError fallback, dict `str(key)` coercion, truncation
   markers `{"__truncated__":true,"remaining":N}`). Anything else (TreeNode,
   ListNode, custom objects, __ref__ id allocation) calls back into the
   python `_serialize` + json encode — parity by delegation; hot path stays
   native. Byte-for-byte output parity is the hard requirement.
4. **Budgets native.** Event count, byte budget (utf-8 length + newline
   accounting exactly as `__tracecode_append_runtime_event`), line-event and
   single-line-hit budgets, trip reasons — replicated in C, with the same
   counters exposed to python for the response envelope.
5. **Rep cache / delta detection native.** Object-identity + generation
   tracking is natural in C (pointers). Optionally implement delta snapshot
   emission here (only changed locals per line) with exact virtual-byte
   accounting — decided during M3, not required for the floor win.

## Milestones (each independently landable)

- **M0 — toolchain proof.** `pip install pyodide-build`, select xbuildenv
  matching 0.29.3, build a trivial `_tracecode_native` wheel, load it in the
  worker's pyodide (node test), assert import + calling a C function works.
  This is the riskiest unknown; do it first. Record every version pin in
  `packages/runtime-python-native/manifest.json`.
- **M1 — callback floor measurement.** Native LINE callback that only
  increments a counter while the python tracer still does all the work — then
  a variant where the native callback replaces the python LINE callback but
  delegates to python only when a line event must actually be recorded.
  Measures the real native floor before committing to the serializer.
- **M2 — native line events + snapshots.** Native emission of line events and
  per-variable snapshot events (locals via `PyFrame_GetLocals`; on 3.13 this
  is a FrameLocalsProxy — materialize once per line). Python access hooks
  rerouted through `append_event_json`. Python fallback for exotic values.
  Dual-run parity harness: run both tracers over the python-runtime suite +
  benchmark problems, byte-diff the event streams.
- **M3 — budgets, rep cache, teardown native.** Move limit enforcement and
  the delta machinery down; python tracer remains as automatic fallback.
- **M4 — flip default.** Feature flag on, suites + equal-output benchmarks
  (`scripts/benchmark-background-tracing.ts --languages=python
  --problems=coin-change [--trace-limits=uncapped]`), product-mode
  verification, commit with artifacts + recipe.

## Gotchas / notes for the implementer

- Emscripten version MUST match the xbuildenv's pin (pyodide-build downloads
  it); do not use a system emsdk.
- The worker asset server must serve the wheel with a correct integrity entry
  if the python worker enforces SRI (check how pyodide-0.29.3 assets are
  served in `workers/python/python-worker.js` before wiring).
- `_TRACE_PROFILE` wrappers in runtime-core.js rebind tracer functions —
  profile mode should keep working against the python fallback; native-path
  profiling gets its own counters exposed via a module function.
- Equal-output verification: event counts for coin-change are 185,513 /
  189,371 (two heavy-case variants — the benchmark's "hvy events" column is
  whichever case ran slowest, don't compare across variants) and 11,348
  product. The python-runtime suite carries golden traces.
- Prepared-program reuse (content-keyed) re-executes the runtime source per
  case; the native module is imported once per pyodide instance — all
  per-run state needs an explicit `reset()` called from the run prologue.
- Benchmarks need the product repo at `/Users/obinnanwachukwu/Code/algoflow`
  (default `--product-root`).

## Status

- [x] Plan written; ABI identified (cp313, pyodide_2025_0, wasm32).
- [x] M0 toolchain proof — wheel builds (pyodide-build 0.39.0, xbuildenv
      0.29.3, emscripten 4.0.9) and `_tracecode_native.ping()` returns 1
      inside the vendored pyodide loaded via node (classic script: indirect
      eval of pyodide.js, then `loadPyodide` + `loadPackage(file-url wheel)`).
      Pins + steps in packages/runtime-python-native/manifest.json.
- [ ] M1 floor measurement.
- [ ] M2 native emission + parity harness.
- [ ] M3 budgets/cache native.
- [ ] M4 default flip + benchmarks.

## Parallel open thread (do not lose)

C++ (task #34): snapshot events are 69% of its 256k-event heavy case; a COW
fragment cache + valueRef wire dedup are fully built in the DEV asset tree
(`.cache/tracecc-runtime-assets/dev-modified/tracecode_runtime.hpp`) and
worker (`workers/cpp/cpp-worker.js` valueRef resolution), but a probe proved
the `std::vector` snapshot overload is NEVER selected — the generated driver
passes dp to `emit_snapshot_value` under some other static type (wrapper
class?). Next step: inspect the generated TraceCodeDriver.cpp (log
`driverSource` in `tracecc-compiler-service.ts` compileTrusted) to find the
real static type, re-hang the cache on it, then benchmark; ship requires the
PCH shard rebuild (recipe in tracecc `docs/tracecode-pch-shards.md`, memory
file `cpp-trace-optimization`). The compiler-service DEV patches (3 sites,
marked `DEV-EXPERIMENT`) and the benchmark asset-pin fix
(`1f50b245...` replacing stale `e9457f3a...`) are uncommitted; the pin fix
and worker valueRef resolution should ship, the DEV patches must be reverted.

# Warm-and-Retire Worker Lifecycle Policy

Warm-and-Retire is the Harness policy for hiding heavyweight runtime startup
without reusing learner-tainted workers.

The policy name is `warm-and-retire`. Its lower-memory counterpart is
`retire-only`. These names describe lifecycle and capacity; they do not weaken
or replace a runtime's isolation boundary.

```ts
const host = createBrowserJudgeHost({
  safeExecution: {
    workerLifecycle: 'warm-and-retire',
  },
});
```

## Contract

A worker role that adopts Warm-and-Retire obeys all of these invariants:

1. **Warm clean capacity before demand.** The lifecycle owner starts the next
   worker before an interactive operation needs it.
2. **Lease once.** A worker that observes learner-controlled mutable state is
   never returned to the clean pool.
3. **Retire on every terminal path.** Success, learner failure, infrastructure
   failure, cancellation, timeout, and owner disposal all retire the leased
   worker exactly once.
4. **Replenish after retirement.** While the owner remains active, retirement
   starts one replacement without blocking the completed operation.
5. **Fence generations.** A replacement started by a stale, cancelled, reset,
   or disposed generation cannot publish itself into the current pool.
6. **Bound capacity.** Each declared role has an explicit standby depth.
   Warm-and-Retire does not authorize an unbounded worker cache.
7. **Keep replenishment at a useful owner.** The owner of replacement capacity
   must normally survive until the next operation. Starting a replacement from
   an object that is immediately disposed is not Warm-and-Retire; move the pool
   to a longer-lived provider/host or select `retire-only`.

An implementation may keep independent pools for different roles. For example,
a Java provider can maintain one clean preparation/compiler worker and one
clean execution worker. A compiled immutable snapshot may cross between those
roles; their mutable VM state may not.

## State Model

```text
empty -> warming -> clean standby -> leased -> retired
            |              |                     |
            |              +-- owner dispose -->+
            +-- failure ------------------------>+
                                                  |
                              active owner -------+-> warming
```

`retire-only` preserves `leased -> retired` and every isolation/fencing rule,
but omits automatic post-use replenishment. A consumer may still explicitly
warm initial capacity with `warmLanguage(...)`; after that capacity is used,
the next operation creates its worker lazily unless the consumer warms again.

## Ownership Rule

The human editing interval is the intended replenishment window. A replacement
started after Run N should remain available for Run N+1.

This makes ownership part of correctness:

- A long-lived language provider or browser host is a suitable owner.
- A prepared program that Judge disposes immediately after one batch is not.
- Language switch, host reset, and host disposal must terminate unused
  standbys and prevent late warmups from republishing.

The ownership rule explains two otherwise similar-looking cases:

- A provider-owned Java execution standby can benefit the next submission and
  belongs under Warm-and-Retire.
- A Python standby created in a short-lived prepared program immediately before
  that program is disposed cannot benefit the next submission and must be
  disabled or moved to the provider.

## Role And Test Matrix

The policy is verified at the role that owns each worker rather than by counting
network requests alone.

| Runtime role | Required evidence |
| --- | --- |
| Python prepared execution | `tests/test-python-prepared-provider.ts`: one-use retirement, cancellation retirement, replacement fencing, disposal |
| JavaScript/TypeScript executor | `tests/test-javascript-worker-lifecycle.ts`: fresh executor, clean standby, generation reset, termination |
| Java preparation and execution | `tests/test-java-prepared-provider.ts`: preparation retirement, fresh case workers, cancellation, disposal |
| C# preparation and execution | `tests/test-csharp-runtime.ts` and `tests/test-csharp-worker-lifecycle-browser.ts`: compiler retirement and fresh outer worker generations |
| C++ execution | `tests/test-cpp-compiler-lifecycle.ts`: one-command retirement, bounded clean standby, reset fencing |
| Browser-host policy selection | `tests/test-browser-worker-lifecycle-policy.ts`: named defaults, compatibility mapping, and conflict rejection |

The matrix records existing lifecycle evidence; it does not claim every role
already hides all startup cost. In particular, Java currently warms preparation
capacity but creates execution capacity on demand. Moving Java execution to a
provider-owned standby is required before claiming sub-three-second warm Runs.

## Changing The Policy

A lifecycle change is deliberate only when the same change updates:

1. the named policy union in
   `packages/runtime-browser/src/worker-lifecycle-policy.ts`;
2. this contract and its state/ownership rules;
3. the affected worker-level lifecycle tests;
4. the browser-host policy-resolution test;
5. release notes describing latency, memory, and isolation effects.

Do not silently change the meaning of `warm-and-retire`. Add a new name when
the lease, retirement, replenishment, ownership, or capacity semantics change.

`safeExecution.prewarmAfterUse` remains a deprecated compatibility alias:
`true` maps to `warm-and-retire`, and `false` maps to `retire-only`. Supplying
conflicting old and new values fails closed.

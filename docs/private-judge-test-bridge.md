# Private Judge test bridge

GB's trusted browser harness can install this bridge on the page before creating a Judge host. This is an internal test contract for installed Harness builds. The bridge is disabled by default and is not a package export, declaration, request field, or worker message. The host captures the callbacks once. Adding the property later cannot change an existing host. The page and learner workers have separate global objects.

```js
Object.defineProperty(window, Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1'), {
  configurable: true,
  value: {
    onEvent(event) {
      journal.push(event);
    },
    faultAt({ point, language, workspaceDigest, evaluationId, generation, caseId, attemptToken }) {
      // Return a matching fault name from the table, or undefined.
    },
  },
});
```

Use an own, non-enumerable data property. `onEvent` is required and `faultAt` is optional. Both callbacks run synchronously in the page. Callback errors are ignored. The bridge sees a registered receipt scheduler even if its provider has no `mark` callback. Legacy providers do not have this journal.

Each journal event carries `phase`, `evaluationId`, `workspaceDigest`, `generation`, `caseId`, `attemptToken`, and monotonic `at` in milliseconds. The last two binding identifiers can be undefined when the phase has no case or attempt.

- `ordinary-write-attempt` records each call to the ordinary receipt writer, including a write that the store rejects.
- `ordinary-commit` records evaluation-wide ordinary commit, before any attachment binds.
- `observer-start` and `observer-end` bracket the attempt at the observation lease.
- `observer-expire` records the scheduler ending a pending attempt because its case's ordinary run was stopped by the wall clock (`limit/client-timeout`) and the observer has used its budget: the same per-case budget, counted from its own `observer-start` and never ending later than twice that budget after commit. An observer that hasn't started within one budget of commit (still preparing, or queued) expires without an `observer-start`. A certified producer's attempt expires at ordinary commit, since it cannot certify a row that did not complete. The attempt then ends, and binds as `refused/observer-timeout`. Without this event, an `observer-timeout` refusal came from the provider's observation backstop or the observer's own clock.
- `attachment-bind` records a drawing or refusal bound to a committed row.
- `observation-cache-hit` records reuse of a settled attempt on continuation.
- `public-resolve` records the scheduler releasing the initial or continuation projection.

For an accepted injection, `onEvent` receives `phase: 'injection-ack'` with the same clock and binding fields, plus `language`, `point`, and `fault`. Preparation is shared by the evaluation, so its ACK has no case ID or attempt token. A redraw of a cached attachment does not apply an injection again.

| `point` | Return from `faultAt` | Effect |
|---|---|---|
| `prepare` | `prepare` | Refuse at the adapter preparation boundary before allocating an observer lease. |
| `observe` | `runtime` | Refuse at the observer invocation boundary before dispatch. |
| `observe` | `deadline` | Invoke the observer, then immediately abort its own deadline controller with `TimeoutError`. The scheduler takes its normal `observer-timeout` path. |
| `observe` | `no-recorder` | For JavaScript, disable recorder construction on the observer worker. ACK only after the authenticated worker reply confirms the disabled recorder and returns `recorder-unavailable`. |
| `encode` | `encode` | Replace a drawable reply at the observation return boundary with `observer-encode`. An existing refusal cannot ACK this injection. |

Except for the worker-confirmed `no-recorder` control, these ACKs attest scheduler-boundary faults. Use provider-side evidence for claims about a language's own encoder or worker fault handling.

## Judged-output policy

Every ordinary (code-mode) prepare for JavaScript, TypeScript, Java, C# and C++ carries the product's judged-output policy: `maxBytes` (UTF-8 bytes of the answer's compact JSON), `maxItems` (entries in any one container), `maxNodes` (JSON values in the answer) and `maxDepth` (nesting of the language value, so a Set or Map is one level, not its JSON wrappers). An answer over a bound, one with a cycle, or one with a Set or Map that can't be read, is the case's typed `serialization-limit`, with no value. Python has no policy in this release. The contract is in `packages/runtime-contracts/src/judged-output-policy.ts`.

A bridge may lower the policy with an optional third callback:

```js
judgedOutputPolicy({ language, evaluationId }) {
  return language === 'javascript' ? { maxBytes: 1024 } : undefined;
},
```

- The host calls it synchronously, once per ordinary prepare, in the page.
- A returned field is used only if it is a non-negative safe integer below the product default. Higher, fractional, negative, non-number and accessor values keep the default, and so does an error thrown by the callback. The callback can't raise a bound.
- A bridge that installs this callback also receives `onEvent({ phase: 'judged-output-policy', language, evaluationId, maxBytes, maxItems, maxNodes, maxDepth, lowered, at })` on each such prepare, before the provider prepares. This marker carries the effective policy that was sent. Bridges without the callback see no new event.

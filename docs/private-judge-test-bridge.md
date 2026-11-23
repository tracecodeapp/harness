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
- `attachment-bind` records a drawing or refusal bound to a committed row.
- `observation-cache-hit` records reuse of a settled attempt on continuation.
- `public-resolve` records the scheduler releasing the initial or continuation projection.

For an accepted injection, `onEvent` receives `phase: 'injection-ack'` with the same clock and binding fields, plus `language`, `point`, and `fault`. Preparation is shared by the evaluation, so its ACK has no case ID or attempt token. A redraw of a cached attachment does not apply an injection again.

| `point` | Return from `faultAt` | Effect |
|---|---|---|
| `prepare` | `prepare` | Refuse at the adapter preparation boundary before allocating an observer lease. |
| `observe` | `runtime` | Refuse at the observer invocation boundary before dispatch. |
| `observe` | `deadline` | Invoke the observer, then immediately abort its own deadline controller with `TimeoutError`. The scheduler takes its normal `observer-timeout` path. |
| `encode` | `encode` | Replace a drawable reply at the observation return boundary with `observer-encode`. An existing refusal cannot ACK this injection. |

These ACKs attest scheduler-boundary faults. Use provider-side evidence for claims about a language's own encoder or worker fault handling.

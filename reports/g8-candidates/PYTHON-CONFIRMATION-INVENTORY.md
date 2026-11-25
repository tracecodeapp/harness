# S-prime Python confirmation inventory

Candidate: `2ddacad971e8def9c41668ccfc5d070870c98681` (`S′`, F1 + D1 + F2 + F1b).
Comparator: the pinned live `0.17.1` package. Each group alternates the two
labels per round and keeps 20 samples per label. Median and p90 must each be at
most `1.10 ×` the same-window control.

The schedule has 12 groups and 24 exact `(group × version)` combinations. A
one-attempt capture of all 24 runs first inside the exclusive window. Capture
uses an empty prior-shape set, so the first invalid candidate or control
attempt stops the session. The full run accepts only the shapes kept by those
capture files.

| Scope | CPU | Problem | State | Action | Warm mode | Continuation | Pair | Versions | Capture |
|---|---:|---|---|---|---|---|---|---|---|
| phone | 4 | Permutations | warm | Run | fresh page | no | unpaired | 0.17.1, S′ | pending |
| phone | 4 | Permutations | cold | Run | standard | no | unpaired | 0.17.1, S′ | pending |
| phone | 4 | Permutations | warm | Run | repeat Run | no | S′ | 0.17.1, S′ | pending |
| phone | 4 | Binary Search | warm | Run | fresh page | no | unpaired | 0.17.1, S′ | pending |
| phone | 4 | Binary Search | cold | Run | standard | no | unpaired | 0.17.1, S′ | pending |
| phone | 4 | Binary Search | warm | Run | repeat Run | no | S′ | 0.17.1, S′ | pending |
| desktop | 1 | Binary Search | warm | Run | fresh page | no | unpaired | 0.17.1, S′ | pending |
| desktop | 1 | Permutations | warm | Run | fresh page | no | unpaired | 0.17.1, S′ | pending |
| desktop | 1 | Binary Search | cold | Run | standard | no | unpaired | 0.17.1, S′ | pending |
| desktop | 1 | Binary Search | warm | Run | repeat Run | click draw | S′ | 0.17.1, S′ | pending |
| desktop | 1 | Permutations | warm | Run | repeat Run | click draw | S′ | 0.17.1, S′ | pending |
| desktop | 1 | Binary Search | warm | lesson Continue | persistent page | no | unpaired | 0.17.1, S′ | pending |

For every S′ Run, the journal witness requires one algorithm-fast stopping
batch and exactly one observer prepare and execute on the verdict worker. The
prepare must be posted after the last case-finished receipt; it may be queued
before the terminal batch reply. The observer execution must start after both
the batch and observer prepare acknowledge. Click-draw must remain on that same
handed-off worker. Missing progress, a per-case restart, another learner worker,
or an early observer is invalid.

Lesson Continue is scored separately as `standby-ready` and
`straight-after-own-sample`, classified from actual adjacent measured actions.

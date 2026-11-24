# S(Python) shape inventory

Generated from the exact 3dfc7dc1 full schedule after the current witnesses were staged. Every one of the 96 language x scope x cell-kind x version combinations has at least one real host sample that passes the current witness. Probe targets were one attempt per combination; no probe value is a performance result.

| Scope | Language / CPU | Problem | State / journey | Continuation | Warm mode | Paired control for | Versions with passing capture | Evidence |
|---|---|---|---|---:|---|---|---|---|
| phone | python / 4 | binary-search | warm / run | no | repeat-run | concurrent | 0.17.1, concurrent | initial phone corpus rows 1-37 |
| phone | python / 4 | binary-search | warm / run | no | repeat-run | sequential | 0.17.1, sequential | initial phone corpus rows 1-37 |
| phone | python / 4 | permutations | warm / run | no | repeat-run | concurrent | 0.17.1, concurrent | phone probe |
| phone | python / 4 | permutations | warm / run | no | repeat-run | sequential | 0.17.1, sequential | phone probe |
| phone | python / 4 | binary-search | warm / run | no | fresh-page | unpaired | 0.17.1, concurrent, sequential | phone probe |
| phone | python / 4 | permutations | warm / run | no | fresh-page | unpaired | 0.17.1, concurrent, sequential | phone probe |
| phone | python / 4 | binary-search | cold / run | no | standard | unpaired | 0.17.1, concurrent, sequential | phone probe |
| phone | python / 4 | permutations | cold / run | no | standard | unpaired | 0.17.1, concurrent, sequential | phone probe |
| desktop | python / 1 | binary-search | warm / submit | no | submit-after-run | concurrent | 0.17.1, concurrent | desktop fail-fast capture |
| desktop | python / 1 | binary-search | warm / submit | no | submit-after-run | concurrent-deploy | 0.17.1, concurrent-deploy | desktop probe |
| desktop | python / 1 | permutations | warm / submit | no | submit-after-run | concurrent | 0.17.1, concurrent | desktop probe |
| desktop | python / 1 | permutations | warm / submit | no | submit-after-run | concurrent-deploy | 0.17.1, concurrent-deploy | desktop probe |
| desktop | python / 1 | binary-search | warm / run | yes | repeat-run | concurrent | 0.17.1, concurrent | desktop probe |
| desktop | python / 1 | binary-search | warm / run | yes | repeat-run | concurrent-deploy | 0.17.1, concurrent-deploy | desktop probe |
| desktop | python / 1 | binary-search | warm / lesson | no | standard | unpaired | 0.17.1, concurrent | desktop probe |
| desktop | python / 1 | permutations | warm / run | yes | repeat-run | concurrent | 0.17.1, concurrent | desktop probe |
| desktop | python / 1 | permutations | warm / run | yes | repeat-run | concurrent-deploy | 0.17.1, concurrent-deploy | desktop probe |
| desktop | python / 1 | binary-search | warm / submit | no | fresh-page | unpaired | 0.17.1, 0.20.1, concurrent, concurrent-deploy | desktop probe |
| desktop | python / 1 | binary-search | warm / run | yes | fresh-page | unpaired | 0.17.1, concurrent, concurrent-deploy | desktop probe |
| desktop | python / 1 | permutations | warm / submit | no | fresh-page | unpaired | 0.17.1, 0.20.1, concurrent, concurrent-deploy | desktop probe |
| desktop | python / 1 | permutations | warm / run | yes | fresh-page | unpaired | 0.17.1, concurrent, concurrent-deploy | desktop probe |
| desktop | python / 1 | binary-search | cold / submit | no | standard | unpaired | 0.17.1, concurrent, concurrent-deploy | desktop probe |
| desktop | python / 1 | permutations | cold / submit | no | standard | unpaired | 0.17.1, concurrent, concurrent-deploy | desktop probe |
| desktop | python / 1 | binary-search | cold / run | yes | standard | unpaired | 0.17.1, concurrent, concurrent-deploy | desktop probe |
| desktop | python / 1 | permutations | cold / run | yes | standard | unpaired | 0.17.1, concurrent, concurrent-deploy | desktop probe |
| desktop | python / 1 | binary-search | switched / submit | no | standard | unpaired | 0.17.1, concurrent, concurrent-deploy | desktop probe |
| desktop | python / 1 | permutations | switched / submit | no | standard | unpaired | 0.17.1, concurrent, concurrent-deploy | desktop probe |
| desktop | python / 1 | binary-search | switched / run | yes | standard | unpaired | 0.17.1, concurrent, concurrent-deploy | desktop probe |
| desktop | python / 1 | permutations | switched / run | yes | standard | unpaired | 0.17.1, concurrent, concurrent-deploy | desktop probe |
| spot | javascript / 1 | binary-search | warm / run | no | standard | candidate-main | 0.17.1, candidate-main | spot probe |
| spot | javascript / 1 | binary-search | warm / run | no | standard | candidate-deploy | 0.17.1, candidate-deploy | spot probe |
| spot | typescript / 1 | binary-search | warm / run | no | standard | candidate-main | 0.17.1, candidate-main | spot probe |
| spot | typescript / 1 | binary-search | warm / run | no | standard | candidate-deploy | 0.17.1, candidate-deploy | spot probe |
| spot | cpp / 1 | binary-search | warm / run | no | standard | candidate-main | 0.17.1, candidate-main | spot probe |
| spot | cpp / 1 | binary-search | warm / run | no | standard | candidate-deploy | 0.17.1, candidate-deploy | spot probe |
| spot | csharp / 1 | binary-search | warm / run | no | fresh-page | candidate-main | 0.17.1, candidate-main | spot probe |
| spot | csharp / 1 | binary-search | warm / run | no | fresh-page | candidate-deploy | 0.17.1, candidate-deploy | spot probe |
| spot | java / 1 | binary-search | warm / run | no | standard | candidate-main | 0.17.1, candidate-main | spot probe |
| spot | java / 1 | binary-search | warm / run | no | standard | candidate-deploy | 0.17.1, candidate-deploy | spot probe |

## Evidence

- Initial phone corpus: `/root/ci/g8-candidates.qHpuBwkE/python-3dfc7dc1-invalid-phone-ordinary-batch-20261124/speed-phone-samples.jsonl`; rows 1-37 were captured before shutdown. The four represented shapes dry-run against the current witness.
- Phone probe: `/root/ci/g8-candidates.qHpuBwkE/python/shape-probe-phone-samples.jsonl`; 16/16 kept, zero invalid.
- Desktop fail-fast capture: `/root/ci/g8-candidates.qHpuBwkE/python-shape-probe-desktop-submit-stopping-invalid-20261124/shape-probe-desktop-b-samples.jsonl`; the control was kept and the candidate journal passes after the role-correct Submit fix.
- Desktop probe: `/root/ci/g8-candidates.qHpuBwkE/python/shape-probe-desktop-b-samples.jsonl`; 54/54 kept, zero invalid.
- Spot probe: `/root/ci/g8-candidates.qHpuBwkE/python/shape-probe-python-spot-samples.jsonl`; 20/20 kept, zero invalid.

All three completed probes released their four heavy locks and passed the PGID plus output-prefix verification.

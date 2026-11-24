# S(C#) shape inventory

Recorded on 2026-11-24 before the informational S(C#) window.

- Candidate: `749f3b8dc2c1affbe74ad676ae5428d31b097189`
- Artifact: `csharp-f1-registered-749f3b8dc2c.tgz`
- SHA-256: `df77f21302e861cdfcdd3d7ebb970cbc79639fc49a6a4d8772a72d6178b8d9a7`
- Frozen exact keys: `csharp-shape-captures.mjs`

| Scope | Scheduled keys | Real passing captures | Missing | Invalid discovery rows |
| --- | ---: | ---: | ---: | ---: |
| Desktop | 56 | 56 | 0 | 8 |
| Phone | 24 | 24 | 0 | 0 |
| Spot | 20 | 20 | 0 | 0 |
| Total | 100 | 100 | 0 | 8 |

The desktop probes contain 84 total rows across ten preserved capture files. The eight invalid rows were fail-fast witness discovery attempts, not performance results. Each exposed a concrete receipt shape; every corresponding witness change kept its negative guards and was dry-run against the captured row before probing continued.

Host evidence is preserved under `/root/ci/g8-candidates.qHpuBwkE/csharp/`, including the `csharp-probe-invalid-*` directories and the final desktop, phone and spot probe outputs. Every probe stop path passed the process-group and output-prefix release check. A read-only verifier derived the 100 keys from the current measurement plan and found 100 real passing captures, with no missing or extra keys.

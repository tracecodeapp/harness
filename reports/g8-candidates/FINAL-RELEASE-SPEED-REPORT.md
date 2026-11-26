# TraceCode Harness 0.21 final side-by-side speed report

## Conclusion

Candidate `e704c90093210a14965062544467ed5222e83717`, tarball SHA-256 `c01f5198166d46c8f6d55343a06826e4607abc63755fa5e3a7ecbeb417eb21d3`, produced 203 metric rows: 129 formal passes, 52 formal median failures, and 22 control-invalid rows. The final side-by-side speed gate does not clear. Java has 33/33 formal passes; Python has no direct median miss but 14 host-check-invalid rows; JavaScript, TypeScript, C++, and C# contain formal median misses.

- Session 1 ended at 07:49:55Z. Its complete Python phone/desktop, C# phone, and C# desktop groups 0–15 remain immutable.
- Session 2 independently recorded the phone warm A/A reference from 08:41:05.827Z to 09:08:49.537Z.
- Session 3 held heavy-exclusive at 09:11:40Z, finished its last measured scope at 10:26:07.850Z, and released all four locks at 10:26:08Z. It retimed C# desktop group 16 and measured all Java, C++, TypeScript, and JavaScript scopes.
- All merged groups are complete. Session 3 has 0 invalid samples.

## Session 2 A/A reference status

The fixed offline scorer skipped only 38 rows already excluded by the pre-registered load >2.0 gate. It retained 320 samples, with 0 invalid/refusal rows and n=20 per label. Label medians and p90s pass in all affected cells. The A/A still fails its pre-registered criterion in four metric rows:

- Python Permutations fresh verdicts and firstTrace: pooled position medians 542.55 vs 514.95 ms, ratio 1.0536, above the 1.05 limit; per-label-position also fails.
- C# Permutations fresh verdicts and firstTrace: pooled position median/p90 pass, but per-label-position fails.

Exactly 12 Session 1 phone-warm rows become formal against their distinct passing Session 2 reference: Python BS fresh verdicts/firstTrace, Python BS repeat verdicts/firstTrace, Python Perm repeat verdicts/firstTrace, C# BS fresh verdicts/firstTrace, C# BS repeat verdicts/firstTrace, and C# Perm repeat verdicts/firstTrace. Four rows remain controlInvalid: Python Perm fresh verdicts/firstTrace and C# Perm fresh verdicts/firstTrace. No repeat sibling is tied to a failed fresh reference; each repeat row has its own passing A/A reference.

Direct, non-formal results for the four held rows:

| Cell | Candidate median | 0.17.1 median | Median change | Candidate p90 | 0.17.1 p90 | p90 change |
|---|---:|---:|---:|---:|---:|---:|
| python/4/permutations/warm/verdicts | 540.0 | 527.2 | +2.4% | 565.6 | 568.1 | -0.4% |
| python/4/permutations/warm/firstTrace | 540.0 | 527.2 | +2.4% | 565.6 | 568.1 | -0.4% |
| csharp/4/permutations/warm/verdicts | 1278.5 | 1064.9 | +20.1% | 1308.2 | 1078.4 | +21.3% |
| csharp/4/permutations/warm/firstTrace | 1278.5 | 1064.9 | +20.1% | 1308.2 | 1078.4 | +21.3% |

Making those four references formal would not change the overall outcome: Python Perm fresh would pass directly at +2.4%, while C# Perm fresh would fail at +20.1%, and other already-formal cells fail independently.

## Full cell table

The median verdict is against live same-window 0.17.1 at the owner’s 1.10 limit. p90 is reported but is not a gate in this final session. `S` is sampleSession; `R` is referenceSession. `frozen/prereg` means the frozen or separately pre-registered host reference. Counts are candidate/control.

### javascript

| Scope | Cell | S | R | n | invalid | excluded | Candidate median | 0.17.1 median | Δ median | Candidate p90 | 0.17.1 p90 | Δ p90 | Verdict |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| phone | javascript/4/binary-search/warm/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 41.4 | 97.0 | -57.4% | 48.4 | 104.4 | -53.6% | PASS |
| phone | javascript/4/binary-search/warm/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 41.4 | 97.0 | -57.4% | 48.4 | 104.4 | -53.6% | PASS |
| phone | javascript/4/permutations/warm/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 57.3 | 128.6 | -55.4% | 72.0 | 136.7 | -47.3% | PASS |
| phone | javascript/4/permutations/warm/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 57.3 | 128.6 | -55.4% | 72.0 | 136.7 | -47.3% | PASS |
| phone | javascript/4/binary-search/cold/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 291.5 | 402.0 | -27.5% | 305.6 | 415.3 | -26.4% | PASS |
| phone | javascript/4/binary-search/cold/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 291.5 | 402.0 | -27.5% | 305.6 | 415.3 | -26.4% | PASS |
| phone | javascript/4/permutations/cold/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/1 | 321.3 | 438.7 | -26.8% | 329.4 | 460.1 | -28.4% | PASS |
| phone | javascript/4/permutations/cold/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/1 | 321.3 | 438.7 | -26.8% | 329.4 | 460.1 | -28.4% | PASS |
| desktop | javascript/1/binary-search/warm/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 5.3 | 4.8 | +12.6% | 6.5 | 5.9 | +10.2% | FAIL |
| desktop | javascript/1/permutations/warm/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 6.5 | 5.2 | +23.8% | 8.7 | 7.2 | +20.8% | FAIL |
| desktop | javascript/1/binary-search/warm/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 27.8 | 75.4 | -63.2% | 29.4 | 79.1 | -62.8% | PASS |
| desktop | javascript/1/binary-search/warm/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 27.8 | 75.4 | -63.2% | 29.4 | 79.1 | -62.8% | PASS |
| desktop | javascript/1/binary-search/warm/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 22.4 | 7.3 | +204.1% | 23.5 | 7.8 | +201.3% | FAIL |
| desktop | javascript/1/permutations/warm/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 1/0 | 37.1 | 90.6 | -59.0% | 40.2 | 96.7 | -58.4% | PASS |
| desktop | javascript/1/permutations/warm/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 1/0 | 37.1 | 90.6 | -59.0% | 40.2 | 96.7 | -58.4% | PASS |
| desktop | javascript/1/permutations/warm/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 1/0 | 24.5 | 11.0 | +122.3% | 25.3 | 11.5 | +120.0% | FAIL |
| desktop | javascript/1/binary-search/cold/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 75.0 | 71.8 | +4.6% | 78.8 | 74.1 | +6.3% | PASS |
| desktop | javascript/1/permutations/cold/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 78.0 | 74.5 | +4.7% | 81.9 | 77.5 | +5.7% | PASS |
| desktop | javascript/1/binary-search/cold/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 1/0 | 214.4 | 280.0 | -23.4% | 219.6 | 285.7 | -23.1% | PASS |
| desktop | javascript/1/binary-search/cold/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 1/0 | 214.4 | 280.0 | -23.4% | 219.6 | 285.7 | -23.1% | PASS |
| desktop | javascript/1/binary-search/cold/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 1/0 | 23.2 | 7.8 | +199.4% | 24.4 | 8.0 | +205.0% | FAIL |
| desktop | javascript/1/permutations/cold/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 227.6 | 301.3 | -24.4% | 230.1 | 306.4 | -24.9% | PASS |
| desktop | javascript/1/permutations/cold/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 227.6 | 301.3 | -24.4% | 230.1 | 306.4 | -24.9% | PASS |
| desktop | javascript/1/permutations/cold/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 25.5 | 11.3 | +126.1% | 26.0 | 12.0 | +116.7% | FAIL |
| desktop | javascript/1/binary-search/switched/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 1/0 | 9.8 | 70.2 | -86.0% | 10.5 | 71.9 | -85.4% | PASS |
| desktop | javascript/1/permutations/switched/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 13.1 | 74.1 | -82.3% | 14.9 | 76.6 | -80.5% | PASS |
| desktop | javascript/1/binary-search/switched/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 31.8 | 77.5 | -59.0% | 33.3 | 80.9 | -58.8% | PASS |
| desktop | javascript/1/binary-search/switched/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 31.8 | 77.5 | -59.0% | 33.3 | 80.9 | -58.8% | PASS |
| desktop | javascript/1/binary-search/switched/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 23.0 | 7.6 | +202.6% | 23.7 | 8.0 | +196.3% | FAIL |
| desktop | javascript/1/permutations/switched/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 45.6 | 98.2 | -53.5% | 47.2 | 101.8 | -53.6% | PASS |
| desktop | javascript/1/permutations/switched/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 45.6 | 98.2 | -53.5% | 47.2 | 101.8 | -53.6% | PASS |
| desktop | javascript/1/permutations/switched/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 25.8 | 11.5 | +125.8% | 26.9 | 11.9 | +126.1% | FAIL |
| desktop | javascript/1/binary-search/warm/lessonContinue | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 26.9 | 72.9 | -63.1% | 29.3 | 74.8 | -60.8% | PASS |

### typescript

| Scope | Cell | S | R | n | invalid | excluded | Candidate median | 0.17.1 median | Δ median | Candidate p90 | 0.17.1 p90 | Δ p90 | Verdict |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| phone | typescript/4/binary-search/warm/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 42.7 | 98.8 | -56.7% | 50.3 | 114.6 | -56.1% | PASS |
| phone | typescript/4/binary-search/warm/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 42.7 | 98.8 | -56.7% | 50.3 | 114.6 | -56.1% | PASS |
| phone | typescript/4/permutations/warm/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 60.6 | 132.5 | -54.3% | 81.8 | 148.4 | -44.9% | controlInvalid (direct PASS) |
| phone | typescript/4/permutations/warm/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 60.6 | 132.5 | -54.3% | 81.8 | 148.4 | -44.9% | controlInvalid (direct PASS) |
| phone | typescript/4/binary-search/cold/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 1/1 | 341.0 | 429.6 | -20.6% | 351.1 | 453.9 | -22.6% | PASS |
| phone | typescript/4/binary-search/cold/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 1/1 | 341.0 | 429.6 | -20.6% | 351.1 | 453.9 | -22.6% | PASS |
| phone | typescript/4/permutations/cold/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 365.1 | 462.5 | -21.1% | 379.5 | 478.6 | -20.7% | PASS |
| phone | typescript/4/permutations/cold/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 365.1 | 462.5 | -21.1% | 379.5 | 478.6 | -20.7% | PASS |
| desktop | typescript/1/binary-search/warm/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 8.0 | 7.3 | +9.6% | 12.0 | 9.4 | +27.7% | controlInvalid (direct PASS) |
| desktop | typescript/1/permutations/warm/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 9.0 | 7.8 | +15.5% | 12.3 | 11.5 | +7.0% | FAIL |
| desktop | typescript/1/binary-search/warm/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 29.2 | 78.8 | -63.0% | 32.4 | 82.2 | -60.6% | PASS |
| desktop | typescript/1/binary-search/warm/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 29.2 | 78.8 | -63.0% | 32.4 | 82.2 | -60.6% | PASS |
| desktop | typescript/1/binary-search/warm/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 22.3 | 7.3 | +204.8% | 23.2 | 7.6 | +205.3% | FAIL |
| desktop | typescript/1/permutations/warm/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 38.3 | 96.1 | -60.1% | 46.8 | 101.8 | -54.0% | PASS |
| desktop | typescript/1/permutations/warm/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 38.3 | 96.1 | -60.1% | 46.8 | 101.8 | -54.0% | PASS |
| desktop | typescript/1/permutations/warm/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 25.0 | 10.9 | +130.4% | 26.3 | 11.5 | +128.7% | FAIL |
| desktop | typescript/1/binary-search/cold/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 212.8 | 209.8 | +1.5% | 220.6 | 214.5 | +2.8% | PASS |
| desktop | typescript/1/permutations/cold/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 217.0 | 210.5 | +3.1% | 220.4 | 216.2 | +1.9% | PASS |
| desktop | typescript/1/binary-search/cold/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 1/0 | 235.7 | 307.9 | -23.5% | 240.7 | 313.5 | -23.2% | PASS |
| desktop | typescript/1/binary-search/cold/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 1/0 | 235.7 | 307.9 | -23.5% | 240.7 | 313.5 | -23.2% | PASS |
| desktop | typescript/1/binary-search/cold/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 1/0 | 23.7 | 7.6 | +209.2% | 24.9 | 8.7 | +186.2% | FAIL |
| desktop | typescript/1/permutations/cold/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/1 | 249.0 | 331.1 | -24.8% | 258.9 | 339.9 | -23.8% | PASS |
| desktop | typescript/1/permutations/cold/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/1 | 249.0 | 331.1 | -24.8% | 258.9 | 339.9 | -23.8% | PASS |
| desktop | typescript/1/permutations/cold/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/1 | 25.8 | 11.5 | +123.9% | 26.2 | 11.9 | +120.2% | FAIL |
| desktop | typescript/1/binary-search/switched/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/2 | 13.7 | 73.6 | -81.4% | 14.6 | 76.1 | -80.8% | PASS |
| desktop | typescript/1/permutations/switched/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/1 | 17.8 | 78.6 | -77.3% | 19.4 | 81.3 | -76.1% | PASS |
| desktop | typescript/1/binary-search/switched/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 34.7 | 83.9 | -58.6% | 36.4 | 98.7 | -63.1% | PASS |
| desktop | typescript/1/binary-search/switched/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 34.7 | 83.9 | -58.6% | 36.4 | 98.7 | -63.1% | PASS |
| desktop | typescript/1/binary-search/switched/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 22.4 | 7.5 | +198.0% | 22.9 | 8.2 | +179.3% | FAIL |
| desktop | typescript/1/permutations/switched/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 2/0 | 50.2 | 107.5 | -53.3% | 52.4 | 110.1 | -52.4% | PASS |
| desktop | typescript/1/permutations/switched/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 2/0 | 50.2 | 107.5 | -53.3% | 52.4 | 110.1 | -52.4% | PASS |
| desktop | typescript/1/permutations/switched/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 2/0 | 25.3 | 11.3 | +123.9% | 26.0 | 11.6 | +124.1% | FAIL |
| desktop | typescript/1/binary-search/warm/lessonContinue | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 30.1 | 82.4 | -63.4% | 33.6 | 87.0 | -61.4% | controlInvalid (direct PASS) |

### python

| Scope | Cell | S | R | n | invalid | excluded | Candidate median | 0.17.1 median | Δ median | Candidate p90 | 0.17.1 p90 | Δ p90 | Verdict |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| phone | python/4/permutations/warm/verdicts | 1 | S2 A/A | 20/20 | 0/0 | 1/0 | 540.0 | 527.2 | +2.4% | 565.6 | 568.1 | -0.4% | controlInvalid (direct PASS) |
| phone | python/4/permutations/warm/firstTrace | 1 | S2 A/A | 20/20 | 0/0 | 1/0 | 540.0 | 527.2 | +2.4% | 565.6 | 568.1 | -0.4% | controlInvalid (direct PASS) |
| phone | python/4/permutations/cold/verdicts | 1 | frozen/prereg | 20/20 | 0/0 | 0/0 | 1082.8 | 1057.5 | +2.4% | 1118.1 | 1111.0 | +0.6% | PASS |
| phone | python/4/permutations/cold/firstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 0/0 | 1082.8 | 1057.5 | +2.4% | 1118.1 | 1111.0 | +0.6% | PASS |
| phone | python/4/permutations/warm/repeatVerdicts | 1 | S2 A/A | 20/20 | 0/0 | 2/1 | 619.7 | 656.4 | -5.6% | 669.1 | 682.5 | -2.0% | PASS |
| phone | python/4/permutations/warm/repeatFirstTrace | 1 | S2 A/A | 20/20 | 0/0 | 2/1 | 619.7 | 656.4 | -5.6% | 669.1 | 682.5 | -2.0% | PASS |
| phone | python/4/binary-search/warm/verdicts | 1 | S2 A/A | 20/20 | 0/0 | 0/0 | 407.7 | 394.6 | +3.3% | 422.6 | 431.4 | -2.0% | PASS |
| phone | python/4/binary-search/warm/firstTrace | 1 | S2 A/A | 20/20 | 0/0 | 0/0 | 407.7 | 394.6 | +3.3% | 422.6 | 431.4 | -2.0% | PASS |
| phone | python/4/binary-search/cold/verdicts | 1 | frozen/prereg | 20/20 | 0/0 | 0/0 | 935.6 | 940.1 | -0.5% | 965.9 | 987.3 | -2.2% | PASS |
| phone | python/4/binary-search/cold/firstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 0/0 | 935.6 | 940.1 | -0.5% | 965.9 | 987.3 | -2.2% | PASS |
| phone | python/4/binary-search/warm/repeatVerdicts | 1 | S2 A/A | 20/20 | 0/0 | 0/0 | 525.3 | 553.9 | -5.2% | 546.0 | 578.8 | -5.7% | PASS |
| phone | python/4/binary-search/warm/repeatFirstTrace | 1 | S2 A/A | 20/20 | 0/0 | 0/0 | 525.3 | 553.9 | -5.2% | 546.0 | 578.8 | -5.7% | PASS |
| desktop | python/1/binary-search/warm/verdicts | 1 | frozen/prereg | 20/20 | 0/0 | 1/0 | 336.0 | 347.7 | -3.4% | 371.7 | 371.5 | +0.1% | controlInvalid (direct PASS) |
| desktop | python/1/binary-search/warm/firstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 1/0 | 336.0 | 347.7 | -3.4% | 371.7 | 371.5 | +0.1% | controlInvalid (direct PASS) |
| desktop | python/1/permutations/warm/verdicts | 1 | frozen/prereg | 20/20 | 0/0 | 0/0 | 416.6 | 434.6 | -4.1% | 436.2 | 452.2 | -3.5% | controlInvalid (direct PASS) |
| desktop | python/1/permutations/warm/firstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 0/0 | 416.6 | 434.6 | -4.1% | 436.2 | 452.2 | -3.5% | controlInvalid (direct PASS) |
| desktop | python/1/binary-search/cold/verdicts | 1 | frozen/prereg | 20/20 | 0/0 | 0/0 | 832.9 | 838.2 | -0.6% | 858.1 | 860.5 | -0.3% | PASS |
| desktop | python/1/binary-search/cold/firstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 0/0 | 832.9 | 838.2 | -0.6% | 858.1 | 860.5 | -0.3% | PASS |
| desktop | python/1/binary-search/warm/repeatVerdicts | 1 | frozen/prereg | 20/20 | 0/0 | 0/1 | 473.3 | 501.3 | -5.6% | 483.5 | 523.4 | -7.6% | controlInvalid (direct PASS) |
| desktop | python/1/binary-search/warm/repeatFirstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 0/1 | 473.3 | 501.3 | -5.6% | 483.5 | 523.4 | -7.6% | controlInvalid (direct PASS) |
| desktop | python/1/binary-search/warm/repeatSecondTrace | 1 | frozen/prereg | 20/20 | 0/0 | 0/1 | 46.2 | 44.5 | +3.8% | 49.7 | 47.1 | +5.5% | controlInvalid (direct PASS) |
| desktop | python/1/permutations/warm/repeatVerdicts | 1 | frozen/prereg | 20/20 | 0/0 | 0/0 | 551.2 | 578.3 | -4.7% | 578.0 | 593.3 | -2.6% | controlInvalid (direct PASS) |
| desktop | python/1/permutations/warm/repeatFirstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 0/0 | 551.2 | 578.3 | -4.7% | 578.0 | 593.3 | -2.6% | controlInvalid (direct PASS) |
| desktop | python/1/permutations/warm/repeatSecondTrace | 1 | frozen/prereg | 20/20 | 0/0 | 0/0 | 55.4 | 51.5 | +7.4% | 57.4 | 53.4 | +7.5% | controlInvalid (direct PASS) |
| desktop | python/1/binary-search/warm/lessonContinue/standby-ready | 1 | frozen/prereg | 10/11 | 0/0 | 0/0 | 270.6 | 293.5 | -7.8% | 277.5 | 306.6 | -9.5% | controlInvalid (direct PASS) |
| desktop | python/1/binary-search/warm/lessonContinue/straight-after-own-sample | 1 | frozen/prereg | 10/9 | 0/0 | 0/0 | 461.1 | 475.6 | -3.0% | 469.5 | 492.1 | -4.6% | controlInvalid (direct PASS) |

### cpp

| Scope | Cell | S | R | n | invalid | excluded | Candidate median | 0.17.1 median | Δ median | Candidate p90 | 0.17.1 p90 | Δ p90 | Verdict |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| phone | cpp/4/binary-search/warm/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 50.3 | 54.4 | -7.5% | 61.3 | 62.0 | -1.1% | controlInvalid (direct PASS) |
| phone | cpp/4/binary-search/warm/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 50.3 | 54.4 | -7.5% | 61.3 | 62.0 | -1.1% | controlInvalid (direct PASS) |
| phone | cpp/4/permutations/warm/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 95.7 | 101.0 | -5.2% | 103.1 | 110.6 | -6.8% | PASS |
| phone | cpp/4/permutations/warm/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 95.7 | 101.0 | -5.2% | 103.1 | 110.6 | -6.8% | PASS |
| phone | cpp/4/binary-search/cold/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/1 | 2395.3 | 2114.0 | +13.3% | 2430.3 | 2159.5 | +12.5% | FAIL |
| phone | cpp/4/binary-search/cold/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/1 | 2395.3 | 2114.0 | +13.3% | 2430.3 | 2159.5 | +12.5% | FAIL |
| phone | cpp/4/permutations/cold/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 2879.5 | 2589.5 | +11.2% | 2933.0 | 2623.6 | +11.8% | FAIL |
| phone | cpp/4/permutations/cold/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 2879.5 | 2589.5 | +11.2% | 2933.0 | 2623.6 | +11.8% | FAIL |
| desktop | cpp/1/binary-search/warm/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 29.3 | 24.7 | +18.9% | 32.6 | 25.9 | +25.9% | FAIL |
| desktop | cpp/1/permutations/warm/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 31.5 | 26.1 | +20.9% | 33.3 | 27.6 | +20.7% | FAIL |
| desktop | cpp/1/binary-search/warm/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 37.2 | 40.3 | -7.7% | 40.9 | 43.3 | -5.5% | PASS |
| desktop | cpp/1/binary-search/warm/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 37.2 | 40.3 | -7.7% | 40.9 | 43.3 | -5.5% | PASS |
| desktop | cpp/1/binary-search/warm/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 35.5 | 2.4 | +1377.1% | 36.6 | 2.6 | +1307.7% | FAIL |
| desktop | cpp/1/permutations/warm/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 64.4 | 71.5 | -9.9% | 67.4 | 75.2 | -10.4% | PASS |
| desktop | cpp/1/permutations/warm/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 64.4 | 71.5 | -9.9% | 67.4 | 75.2 | -10.4% | PASS |
| desktop | cpp/1/permutations/warm/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 43.8 | 5.0 | +766.3% | 44.7 | 5.5 | +712.7% | FAIL |
| desktop | cpp/1/binary-search/cold/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 1/0 | 1941.2 | 1907.3 | +1.8% | 1993.3 | 1925.8 | +3.5% | PASS |
| desktop | cpp/1/permutations/cold/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 2347.9 | 2314.6 | +1.4% | 2374.4 | 2406.5 | -1.3% | PASS |
| desktop | cpp/1/binary-search/cold/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 1/2 | 2248.4 | 2015.8 | +11.5% | 2271.2 | 2049.7 | +10.8% | FAIL |
| desktop | cpp/1/binary-search/cold/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 1/2 | 2248.4 | 2015.8 | +11.5% | 2271.2 | 2049.7 | +10.8% | FAIL |
| desktop | cpp/1/binary-search/cold/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 1/2 | 36.3 | 3.0 | +1108.3% | 37.8 | 3.3 | +1045.5% | FAIL |
| desktop | cpp/1/permutations/cold/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 2/3 | 2720.4 | 2472.7 | +10.0% | 2752.6 | 2494.5 | +10.3% | FAIL |
| desktop | cpp/1/permutations/cold/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 2/3 | 2720.4 | 2472.7 | +10.0% | 2752.6 | 2494.5 | +10.3% | FAIL |
| desktop | cpp/1/permutations/cold/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 2/3 | 44.8 | 6.1 | +633.6% | 46.7 | 6.7 | +597.0% | FAIL |
| desktop | cpp/1/binary-search/switched/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 7/7 | 264.8 | 270.0 | -1.9% | 278.8 | 300.3 | -7.2% | PASS |
| desktop | cpp/1/permutations/switched/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 3/3 | 656.1 | 653.7 | +0.4% | 674.1 | 681.6 | -1.1% | PASS |
| desktop | cpp/1/binary-search/switched/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 2/5 | 509.2 | 312.8 | +62.8% | 535.1 | 317.4 | +68.6% | FAIL |
| desktop | cpp/1/binary-search/switched/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 2/5 | 509.2 | 312.8 | +62.8% | 535.1 | 317.4 | +68.6% | FAIL |
| desktop | cpp/1/binary-search/switched/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 2/5 | 35.7 | 2.8 | +1198.2% | 36.7 | 3.0 | +1123.3% | FAIL |
| desktop | cpp/1/permutations/switched/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 2/1 | 994.7 | 779.7 | +27.6% | 1020.4 | 787.5 | +29.6% | FAIL |
| desktop | cpp/1/permutations/switched/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 2/1 | 994.7 | 779.7 | +27.6% | 1020.4 | 787.5 | +29.6% | FAIL |
| desktop | cpp/1/permutations/switched/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 2/1 | 44.8 | 5.8 | +672.4% | 46.5 | 7.1 | +554.9% | FAIL |
| desktop | cpp/1/binary-search/warm/lessonContinue | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 38.2 | 42.0 | -9.3% | 40.7 | 44.7 | -8.9% | PASS |

### java

| Scope | Cell | S | R | n | invalid | excluded | Candidate median | 0.17.1 median | Δ median | Candidate p90 | 0.17.1 p90 | Δ p90 | Verdict |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| phone | java/4/binary-search/warm/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 330.2 | 767.2 | -57.0% | 343.5 | 829.3 | -58.6% | PASS |
| phone | java/4/binary-search/warm/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 330.2 | 767.2 | -57.0% | 343.5 | 829.3 | -58.6% | PASS |
| phone | java/4/permutations/warm/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 392.3 | 967.5 | -59.5% | 412.9 | 1031.0 | -60.0% | PASS |
| phone | java/4/permutations/warm/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 392.3 | 967.5 | -59.5% | 412.9 | 1031.0 | -60.0% | PASS |
| phone | java/4/binary-search/cold/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 1535.5 | 2041.1 | -24.8% | 1561.5 | 2074.8 | -24.7% | PASS |
| phone | java/4/binary-search/cold/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 1535.5 | 2041.1 | -24.8% | 1561.5 | 2074.8 | -24.7% | PASS |
| phone | java/4/permutations/cold/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 1/1 | 1755.1 | 2242.9 | -21.7% | 1807.8 | 2276.0 | -20.6% | PASS |
| phone | java/4/permutations/cold/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 1/1 | 1755.1 | 2242.9 | -21.7% | 1807.8 | 2276.0 | -20.6% | PASS |
| desktop | java/1/binary-search/warm/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 312.5 | 362.3 | -13.8% | 318.1 | 379.2 | -16.1% | PASS |
| desktop | java/1/permutations/warm/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 362.9 | 414.7 | -12.5% | 373.9 | 431.1 | -13.3% | PASS |
| desktop | java/1/binary-search/warm/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 316.0 | 749.7 | -57.8% | 326.3 | 781.8 | -58.3% | PASS |
| desktop | java/1/binary-search/warm/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 316.0 | 749.7 | -57.8% | 326.3 | 781.8 | -58.3% | PASS |
| desktop | java/1/binary-search/warm/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 23.0 | 164.2 | -86.0% | 24.0 | 167.1 | -85.6% | PASS |
| desktop | java/1/permutations/warm/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 367.3 | 933.3 | -60.6% | 380.4 | 965.0 | -60.6% | PASS |
| desktop | java/1/permutations/warm/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 367.3 | 933.3 | -60.6% | 380.4 | 965.0 | -60.6% | PASS |
| desktop | java/1/permutations/warm/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 40.6 | 175.2 | -76.8% | 43.0 | 179.6 | -76.1% | PASS |
| desktop | java/1/binary-search/cold/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 1269.3 | 1481.7 | -14.3% | 1287.5 | 1511.6 | -14.8% | PASS |
| desktop | java/1/permutations/cold/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 1320.8 | 1526.9 | -13.5% | 1336.4 | 1568.8 | -14.8% | PASS |
| desktop | java/1/binary-search/cold/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 2/3 | 1442.4 | 1952.0 | -26.1% | 1479.5 | 1991.7 | -25.7% | PASS |
| desktop | java/1/binary-search/cold/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 2/3 | 1442.4 | 1952.0 | -26.1% | 1479.5 | 1991.7 | -25.7% | PASS |
| desktop | java/1/binary-search/cold/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 2/3 | 25.3 | 165.8 | -84.7% | 26.7 | 169.5 | -84.2% | PASS |
| desktop | java/1/permutations/cold/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 1/0 | 1647.5 | 2148.1 | -23.3% | 1686.9 | 2186.8 | -22.9% | PASS |
| desktop | java/1/permutations/cold/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 1/0 | 1647.5 | 2148.1 | -23.3% | 1686.9 | 2186.8 | -22.9% | PASS |
| desktop | java/1/permutations/cold/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 1/0 | 43.5 | 180.2 | -75.8% | 44.7 | 184.9 | -75.8% | PASS |
| desktop | java/1/binary-search/switched/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 1/0 | 350.0 | 382.5 | -8.5% | 354.2 | 387.2 | -8.5% | PASS |
| desktop | java/1/permutations/switched/submitVerdicts | 3 | frozen/prereg | 20/20 | 0/0 | 3/3 | 415.2 | 435.0 | -4.6% | 424.8 | 443.2 | -4.2% | PASS |
| desktop | java/1/binary-search/switched/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 460.0 | 792.3 | -41.9% | 478.9 | 804.5 | -40.5% | PASS |
| desktop | java/1/binary-search/switched/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 460.0 | 792.3 | -41.9% | 478.9 | 804.5 | -40.5% | PASS |
| desktop | java/1/binary-search/switched/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 24.2 | 164.2 | -85.3% | 25.2 | 168.0 | -85.0% | PASS |
| desktop | java/1/permutations/switched/verdicts | 3 | frozen/prereg | 20/20 | 0/0 | 8/6 | 652.6 | 974.9 | -33.1% | 664.6 | 997.1 | -33.3% | PASS |
| desktop | java/1/permutations/switched/firstTrace | 3 | frozen/prereg | 20/20 | 0/0 | 8/6 | 652.6 | 974.9 | -33.1% | 664.6 | 997.1 | -33.3% | PASS |
| desktop | java/1/permutations/switched/secondTrace | 3 | frozen/prereg | 20/20 | 0/0 | 8/6 | 42.1 | 176.4 | -76.1% | 43.5 | 185.2 | -76.5% | PASS |
| desktop | java/1/binary-search/warm/lessonContinue | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 318.2 | 753.8 | -57.8% | 322.8 | 782.8 | -58.8% | PASS |

### csharp

| Scope | Cell | S | R | n | invalid | excluded | Candidate median | 0.17.1 median | Δ median | Candidate p90 | 0.17.1 p90 | Δ p90 | Verdict |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| phone | csharp/4/binary-search/warm/verdicts | 1 | S2 A/A | 20/20 | 0/0 | 6/4 | 854.0 | 704.8 | +21.2% | 885.4 | 738.7 | +19.9% | FAIL |
| phone | csharp/4/binary-search/warm/firstTrace | 1 | S2 A/A | 20/20 | 0/0 | 6/4 | 854.0 | 704.8 | +21.2% | 885.4 | 738.7 | +19.9% | FAIL |
| phone | csharp/4/binary-search/warm/repeatVerdicts | 1 | S2 A/A | 20/20 | 0/0 | 7/2 | 567.4 | 661.4 | -14.2% | 583.2 | 692.6 | -15.8% | PASS |
| phone | csharp/4/binary-search/warm/repeatFirstTrace | 1 | S2 A/A | 20/20 | 0/0 | 7/2 | 567.4 | 661.4 | -14.2% | 583.2 | 692.6 | -15.8% | PASS |
| phone | csharp/4/permutations/warm/verdicts | 1 | S2 A/A | 20/20 | 0/0 | 0/2 | 1278.5 | 1064.9 | +20.1% | 1308.2 | 1078.4 | +21.3% | controlInvalid (direct FAIL) |
| phone | csharp/4/permutations/warm/firstTrace | 1 | S2 A/A | 20/20 | 0/0 | 0/2 | 1278.5 | 1064.9 | +20.1% | 1308.2 | 1078.4 | +21.3% | controlInvalid (direct FAIL) |
| phone | csharp/4/permutations/warm/repeatVerdicts | 1 | S2 A/A | 20/20 | 0/0 | 3/4 | 918.7 | 717.9 | +28.0% | 942.4 | 760.9 | +23.9% | FAIL |
| phone | csharp/4/permutations/warm/repeatFirstTrace | 1 | S2 A/A | 20/20 | 0/0 | 3/4 | 918.7 | 717.9 | +28.0% | 942.4 | 760.9 | +23.9% | FAIL |
| phone | csharp/4/binary-search/cold/verdicts | 1 | frozen/prereg | 20/20 | 0/0 | 0/0 | 2996.7 | 2840.9 | +5.5% | 3086.6 | 2886.2 | +6.9% | PASS |
| phone | csharp/4/binary-search/cold/firstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 0/0 | 2996.7 | 2840.9 | +5.5% | 3086.6 | 2886.2 | +6.9% | PASS |
| phone | csharp/4/permutations/cold/verdicts | 1 | frozen/prereg | 20/20 | 0/0 | 0/1 | 3417.7 | 3175.4 | +7.6% | 3484.6 | 3218.2 | +8.3% | PASS |
| phone | csharp/4/permutations/cold/firstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 0/1 | 3417.7 | 3175.4 | +7.6% | 3484.6 | 3218.2 | +8.3% | PASS |
| desktop | csharp/1/binary-search/warm/submitAfterRunVerdicts | 1 | frozen/prereg | 20/20 | 0/0 | 2/0 | 416.1 | 421.6 | -1.3% | 444.1 | 435.3 | +2.0% | PASS |
| desktop | csharp/1/binary-search/warm/submitVerdicts | 1 | frozen/prereg | 20/20 | 0/0 | 4/3 | 395.8 | 392.3 | +0.9% | 401.1 | 406.2 | -1.3% | PASS |
| desktop | csharp/1/permutations/warm/submitVerdicts | 1 | frozen/prereg | 20/20 | 0/0 | 2/0 | 505.8 | 486.0 | +4.1% | 520.5 | 497.8 | +4.6% | PASS |
| desktop | csharp/1/permutations/warm/submitAfterRunVerdicts | 1 | frozen/prereg | 20/20 | 0/0 | 2/0 | 485.5 | 494.3 | -1.8% | 498.0 | 513.3 | -3.0% | PASS |
| desktop | csharp/1/binary-search/warm/verdicts | 1 | frozen/prereg | 20/20 | 0/0 | 1/1 | 797.3 | 650.3 | +22.6% | 832.2 | 663.5 | +25.4% | FAIL |
| desktop | csharp/1/binary-search/warm/firstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 1/1 | 797.3 | 650.3 | +22.6% | 832.2 | 663.5 | +25.4% | FAIL |
| desktop | csharp/1/binary-search/warm/secondTrace | 1 | frozen/prereg | 20/20 | 0/0 | 1/1 | 18.5 | 15.0 | +23.3% | 20.9 | 15.3 | +36.6% | FAIL |
| desktop | csharp/1/binary-search/warm/repeatVerdicts | 1 | frozen/prereg | 20/20 | 0/0 | 1/3 | 545.7 | 636.9 | -14.3% | 568.4 | 652.3 | -12.9% | PASS |
| desktop | csharp/1/binary-search/warm/repeatFirstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 1/3 | 545.7 | 636.9 | -14.3% | 568.4 | 652.3 | -12.9% | PASS |
| desktop | csharp/1/binary-search/warm/repeatSecondTrace | 1 | frozen/prereg | 20/20 | 0/0 | 1/3 | 16.4 | 16.0 | +2.8% | 17.4 | 16.7 | +4.2% | PASS |
| desktop | csharp/1/permutations/warm/verdicts | 1 | frozen/prereg | 20/20 | 0/0 | 1/3 | 1209.4 | 997.6 | +21.2% | 1221.2 | 1022.5 | +19.4% | FAIL |
| desktop | csharp/1/permutations/warm/firstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 1/3 | 1209.4 | 997.6 | +21.2% | 1221.2 | 1022.5 | +19.4% | FAIL |
| desktop | csharp/1/permutations/warm/secondTrace | 1 | frozen/prereg | 20/20 | 0/0 | 1/3 | 27.9 | 22.8 | +22.6% | 30.5 | 23.6 | +29.2% | FAIL |
| desktop | csharp/1/permutations/warm/repeatVerdicts | 1 | frozen/prereg | 20/20 | 0/0 | 5/1 | 879.7 | 685.0 | +28.4% | 913.0 | 707.3 | +29.1% | FAIL |
| desktop | csharp/1/permutations/warm/repeatFirstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 5/1 | 879.7 | 685.0 | +28.4% | 913.0 | 707.3 | +29.1% | FAIL |
| desktop | csharp/1/permutations/warm/repeatSecondTrace | 1 | frozen/prereg | 20/20 | 0/0 | 5/1 | 23.1 | 22.1 | +4.3% | 26.5 | 23.5 | +12.8% | PASS |
| desktop | csharp/1/binary-search/cold/submitVerdicts | 1 | frozen/prereg | 20/20 | 0/0 | 1/0 | 2467.3 | 2463.3 | +0.2% | 2567.3 | 2496.5 | +2.8% | PASS |
| desktop | csharp/1/permutations/cold/submitVerdicts | 1 | frozen/prereg | 20/20 | 0/0 | 0/1 | 2584.4 | 2563.2 | +0.8% | 2626.5 | 2681.4 | -2.0% | PASS |
| desktop | csharp/1/binary-search/cold/verdicts | 1 | frozen/prereg | 20/20 | 0/0 | 1/1 | 2883.0 | 2717.8 | +6.1% | 2920.1 | 2790.4 | +4.6% | PASS |
| desktop | csharp/1/binary-search/cold/firstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 1/1 | 2883.0 | 2717.8 | +6.1% | 2920.1 | 2790.4 | +4.6% | PASS |
| desktop | csharp/1/binary-search/cold/secondTrace | 1 | frozen/prereg | 20/20 | 0/0 | 1/1 | 18.3 | 15.0 | +21.7% | 19.2 | 15.5 | +23.9% | FAIL |
| desktop | csharp/1/permutations/cold/verdicts | 1 | frozen/prereg | 20/20 | 0/0 | 0/0 | 3297.6 | 3079.5 | +7.1% | 3393.2 | 3168.5 | +7.1% | PASS |
| desktop | csharp/1/permutations/cold/firstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 0/0 | 3297.6 | 3079.5 | +7.1% | 3393.2 | 3168.5 | +7.1% | PASS |
| desktop | csharp/1/permutations/cold/secondTrace | 1 | frozen/prereg | 20/20 | 0/0 | 0/0 | 26.9 | 22.8 | +17.8% | 28.7 | 24.7 | +16.2% | FAIL |
| desktop | csharp/1/binary-search/switched/submitVerdicts | 1 | frozen/prereg | 20/20 | 0/0 | 4/2 | 413.2 | 416.2 | -0.7% | 420.9 | 424.0 | -0.7% | PASS |
| desktop | csharp/1/permutations/switched/submitVerdicts | 1 | frozen/prereg | 20/20 | 0/0 | 8/2 | 512.2 | 519.1 | -1.3% | 534.7 | 536.9 | -0.4% | PASS |
| desktop | csharp/1/binary-search/switched/verdicts | 1 | frozen/prereg | 20/20 | 0/0 | 8/3 | 528.6 | 630.4 | -16.1% | 545.7 | 648.2 | -15.8% | PASS |
| desktop | csharp/1/binary-search/switched/firstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 8/3 | 528.6 | 630.4 | -16.1% | 545.7 | 648.2 | -15.8% | PASS |
| desktop | csharp/1/binary-search/switched/secondTrace | 1 | frozen/prereg | 20/20 | 0/0 | 8/3 | 16.6 | 16.1 | +2.8% | 18.1 | 16.7 | +8.4% | PASS |
| desktop | csharp/1/permutations/switched/verdicts | 1 | frozen/prereg | 20/20 | 0/0 | 1/0 | 944.1 | 742.0 | +27.2% | 988.7 | 759.6 | +30.2% | FAIL |
| desktop | csharp/1/permutations/switched/firstTrace | 1 | frozen/prereg | 20/20 | 0/0 | 1/0 | 944.1 | 742.0 | +27.2% | 988.7 | 759.6 | +30.2% | FAIL |
| desktop | csharp/1/permutations/switched/secondTrace | 1 | frozen/prereg | 20/20 | 0/0 | 1/0 | 25.0 | 22.4 | +11.6% | 28.1 | 24.6 | +14.2% | FAIL |
| desktop | csharp/1/binary-search/warm/lessonContinue | 3 | frozen/prereg | 20/20 | 0/0 | 0/0 | 483.0 | 443.0 | +9.0% | 518.3 | 592.4 | -12.5% | PASS |

## Owner-bound misses

Every direct candidate median more than 10% slower than live 0.17.1 is visible as `FAIL` or `controlInvalid (direct FAIL)` above. Counts by language: JavaScript 8, TypeScript 7, Python 0, C++ 20, Java 0, C# 19. The two C# Perm repeat/switched misses around +27–28% match the known fix-forward mechanism: fresh observer-runner boot plus two serial compiles, with click/repeat replenishment boot. The small switched secondTrace residual remains the separately identified 0.22 backlog item. The large JavaScript/TypeScript/C++ secondTrace ratios and the C++ cold/switched Run and warm Submit misses are additional regressions, not covered by the accepted C# cause.

## Receipt-reader changes used by this run

- Java: the reader accepts the final D-JAVA streamed completion/admission receipt only with its exact positive reuse evidence and required watchdog/admission acknowledgements; structural worker-reuse guards remain unchanged.
- C#: the reader positively identifies Fix A standby replenishment only by the pre-registered artifact key and exact init/warmup/prime sequence. Learner commands, wrong roles, mismatched prepares, missing trusted prime, or the other version’s execution type remain invalid. The C# lesson promotion path is version-specific and requires its exact trusted evidence.

## Tool faults

1. **SSH cwd / esbuild.** The first final attempt was launched by SSH with `/root` as its working directory, so its temporary runner was created outside the session directory and could not resolve the session's `node_modules/esbuild`. The earlier suspicion that `/tmp` pruning caused the failure was wrong. Commit `7ac5d86c` made the run directory self-contained, fixed the launch working directory, and added the dependency/path preflight. It touched no timing samples.
2. **C# lesson Continue witness.** The accepted witness existed but was not enabled through the real run-g8 lesson option path. Commit `ed1f73b1` enabled the exact per-version promotion branch. Session 1 group 16 was incomplete and was retimed from zero in Session 3; it was never rescored.
3. **Between-phase A/A scorer.** The scorer rejected rows already marked load-excluded and stopped after Session 2 sampling. Commit `b28d6ddd` skips only explicit pre-registered load exclusions while still rejecting invalid/refusal rows and preserving n=20 and every A/A tolerance. The stale malformed A/A score log then caused Session 3’s post-sampling merged scorer to fail; all sampling had already completed and the host was released. Commit `08fd969d` preserves each cell’s existing A/A pass/fail independently, so only rows that depend on a failed reference are held controlInvalid.

No sample value was rescored under a rule written afterward. The only after-the-fact operations were skipping rows already excluded by the pre-registered 2.0 load gate and scoring Session 1 phone-warm rows against the independently timed Session 2 A/A reference. Every cell names its sample session and reference session.


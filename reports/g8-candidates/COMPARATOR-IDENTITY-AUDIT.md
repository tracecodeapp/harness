# Comparator identity audit

## Conclusion

The 0.17.3 publish clearance is clean. Every session contributing to its 30/32 fixed-design decision ran with candidate mode off, and every 0.17.1, 0.20.1 and 0.17.3 package identity matches the immutable artifact that its label names. No 0.17.3 scored row used substituted comparator bytes.

The Python results reported to the owner are also clean. S(Python) did run in candidate mode with appended historical controls, but its Python policy labels did not create `prepared["candidate-main"]`; the recorded 0.17.1 and 0.20.1 packages are exact. E1, E2 and E-D1 likewise record the correct comparator packages.

The only identity failure in the read-only scan of every session metadata file is S(C#) at `749f3b8d`. Its appended `0.20.1` package was actually candidate commit `749f3b8dc2c1affbe74ad676ae5428d31b097189`, SHA-256 `df77f21302e861cdfcdd3d7ebb970cbc79639fc49a6a4d8772a72d6178b8d9a7`. Therefore the four C# warm-Submit candidate rows that formally compare against 0.20.1 are invalid comparator evidence. The rest of the completed C# rows compare against a genuine 0.17.1 package and remain valid.

The root cause was the candidate preparation fallback in `run-g8.mjs`: after `candidate-main` was prepared, it reused those bytes for every later version, not only `candidate-deploy`. The exact-version guard now aliases only `candidate-deploy` and rejects either historical label unless its metadata SHA matches the pinned release.

## Identity anchors

| Version | Recorded commit or published app ref | Tarball SHA-256 | Integrity check |
| --- | --- | --- | --- |
| 0.17.1 | `083bf3f4aec34a353dd6da749d691ca29ed601e8` | `e3373fa0b3e1bd6e5c167f536051a51e28344fe4e31130cc4b1c46a3a44c7df3` | Published npm integrity `sha512-iteoJHC4…` matched every metadata row |
| 0.20.1 | `d0debe20a21885e701731d5e10f5741390b1ddd0` | `e0a4c4d47b4880a49040329112fc779500b3dbeed039934873b72585eaedaf13` | Published npm integrity `sha512-a/vYibZe…` matched every valid metadata row |
| 0.17.3 | release artifact; metadata commit field absent | `d69fc275910c39a99364e9bb5e2b79d47b920ac951840e3e6b29c02ed3e2c290` | Registered coord-artifacts sidecar and tarball re-hash matched |

The audit re-hashed the historical 0.17.1 and 0.20.1 tarballs and every named registered candidate artifact against its sidecar.

## (a) 0.17.3 clearance

All sessions below ran with candidate mode **off**, so the candidate alias branch could not execute.

| Session | Recorded packages | Invalid rows |
| --- | --- | --- |
| Initial 0.17.3 C# desktop, C# phone, Python desktop, Python phone and spot | `release-deploy` = 0.17.3 SHA `d69fc275…` | None |
| Release A/A, 22:47Z | 0.17.1 `083bf3f4…` / `e3373fa0…`; 0.17.3 `d69fc275…` | Three 0.17.1 C# Submit attempts: BS round 2; Perm rounds 2 and 4; each `1 runtime-error/not-evaluated` |
| Pre-fixed closing, 01:00Z | 0.17.3 `d69fc275…`; 0.17.1 `e3373fa0…`; 0.20.1 `e0a4c4d4…` | None |
| Re-record, 02:41Z | 0.17.1 `e3373fa0…`; 0.20.1 `e0a4c4d4…` | None |
| Pre-fixed Python warm close, 02:46Z | 0.17.3 `d69fc275…`; 0.17.1 `e3373fa0…`; 0.20.1 `e0a4c4d4…` | None |
| Failed fixed-design attempt, 05:00Z | Same exact three packages | One 0.17.1 C# BS Submit round 1: `C# trusted standby replenishment witness differs`; not counted |
| Fixed-design 0.17.3 session, 05:05Z | Same exact three packages | None |
| 04:17 design A/A accepted rows | Both labels exact 0.17.1 `083bf3f4…` / `e3373fa0…` | Accepted BS fresh/repeat and Perm fresh groups: none. Unfinished C# Perm repeat group: rounds 1-4 for both labels plus round 5 for both labels; nine replenishment-witness failures and the final label-b round-5 cap-close page error; none counted |
| Replacement Perm-repeat/Python A/A, 04:48Z | Both labels exact 0.17.1 | None |
| Submit A/A, 05:49Z | 0.17.1-a/b exact `e3373fa0…`; 0.20.1-a/b exact `e0a4c4d4…` | None |

No row used by the 30/32 clearance has an invalid comparator identity. The two Python fresh warm-Submit cells remain the previously reported measurement instability.

## (b) Python evidence reported today

| Session | Candidate mode and alias exposure | Recorded packages | Invalid rows |
| --- | --- | --- | --- |
| S(Python) desktop | On; historical controls appended, but no `candidate-main` label exists, so alias cannot fire | 0.17.1 `e3373fa0…`; 0.20.1 `e0a4c4d4…`; concurrent and concurrent-deploy commit `fe58711ab7a0…`, SHA `f44bb83d…` | None |
| S(Python) phone | On; 0.17.1 appended, no `candidate-main` label | 0.17.1 `e3373fa0…`; concurrent `fe58711a` / `f44bb83d…`; sequential `fe58711a` / `3859dfdd…` | None |
| S(Python) spot | On; 0.17.1 is prepared before candidate-main, and only candidate-deploy aliases as intended | 0.17.1 `e3373fa0…`; candidate-main/deploy `fe58711a` / `f44bb83d…` | None |
| E1 | Off; experiment runner | 0.17.1 `e3373fa0…`; concurrent-e1 commit `c88ea88f…`, SHA `d65ab15e…` | None |
| E2 | On by experiment policy, but no `candidate-main` label | 0.17.1 `e3373fa0…`; sequential `9a34ea8c…` / `e643a62e…`; sequential-f1 `e7dde9f2…` / `b189c44c…`; sequential-f1-d1 `c545e0b4…` / `02f14291…` | None |
| E-D1 | Off; experiment runner | 0.17.1 `e3373fa0…`; 0.20.1 `e0a4c4d4…`; concurrent-base `bece725f…` / `fce0673b…`; concurrent-f1-d1 `26d8d99b…` / `0c57a4eb…` | None |

The concurrent, E1, E2 and E-D1 coord-artifacts sidecars all re-hashed successfully. The S(Python) sequential overlay has no separate coord sidecar; its tarball re-hashes to `3859dfdd…` and matches its staged `candidate.json`.

Affected comparator rows in section (b): **none**.

## (c) Java, A/A and frozen-reference sessions

### S(Java)

Both Java heads ran in candidate mode with an appended 0.17.1 control. In every metadata file, 0.17.1 was prepared before candidate-main and records the exact `e3373fa0…` package. The only alias was the intended candidate-deploy-to-candidate-main reuse.

| Session | Candidate identity | Comparator identity | Invalid rows |
| --- | --- | --- | --- |
| be2f3d79 desktop | `be2f3d79702c…` / `17e43a8e…` | 0.17.1 `083bf3f4…` / `e3373fa0…` | None |
| be2f3d79 phone | Same | Same | None |
| be2f3d79 spot | Same | Same | Python 0.17.1 groups 4 and 5, rounds 1-5: ten `Published Python single-worker witness differs`; C# 0.17.1 groups 8 and 9, rounds 3,5,7,9,11: ten `Published C# single-worker witness differs` |
| be2f3d79 Java closing | Same | Same | C# candidate groups 2 and 3, rounds 1-5: ten trusted-standby warmup failures. The cap then emitted page-close rows: C# control group 3 rounds 19-23; Python groups 4 and 5 rounds 1-5 for both streams; C++ group 6 rounds 1-5 for both streams |
| be2f3d79 closing spot | Same | Same | None |
| 74dc029d desktop | `74dc029d4bc4…` / `86e63eee…` | Same exact 0.17.1 | None |
| 74dc029d phone partial | Same | Same exact 0.17.1 | Java Perm cold group 7: 0.17.1 rounds 16-20 and candidate-deploy rounds 17-21. Candidate-deploy round 17 was the failed-tab protocol error; the remaining nine were cap-close page errors |

Both Java candidate tarballs re-hash against their coord-artifacts sidecars. No Java scored comparator row used substituted bytes.

### A/A and re-record

The A/A and re-record sessions are listed in section (a). All ran with candidate mode off. Every 0.17.1/0.20.1 label records its exact published app ref, tarball SHA and npm integrity. No frozen-reference row used substituted bytes.

## Corrected S(C#) desktop result

Candidate: `749f3b8dc2c1affbe74ad676ae5428d31b097189`, SHA `df77f213…`. Release: 12:59:48Z. Candidate invalid rows: none. Four invalid control attempts occurred only in lesson Continue, 0.17.1 rounds 2, 4, 6 and 8, each `C# trusted standby replenishment witness differs`. Sixty excluded rows were untimed primers. Phone and spot did not start before the hard cap.

`INVALID COMPARATOR` means the nominal 0.20.1 package was candidate bytes.

| Cell | candidate-main n median/p90 | candidate-deploy n median/p90 | Live comparator median/p90 | Result |
| --- | ---: | ---: | ---: | --- |
| BS warm verdicts | 20 1034.0/1059.8 | 20 1025.9/1053.3 | 660.5/679.5 | FAIL; +56.6%/+55.3% median |
| BS warm firstTrace | 20 1034.0/1059.8 | 20 1025.9/1053.3 | 660.5/679.5 | FAIL; +56.6%/+55.3% |
| BS warm secondTrace | 20 20.4/21.9 | 20 20.1/21.4 | 15.1/15.9 | FAIL; +34.7%/+33.0% |
| BS warm Submit | 20 398.5/420.3 | 20 397.2/417.9 | nominal 400.6/417.3 | **INVALID COMPARATOR** |
| BS cold verdicts | 20 3162.0/3234.3 | 20 3126.5/3154.9 | 2758.1/2797.0 | FAIL; +14.6%/+13.4% |
| BS cold firstTrace | 20 3162.0/3234.3 | 20 3126.5/3154.9 | 2758.1/2797.0 | FAIL; +14.6%/+13.4% |
| BS cold secondTrace | 20 20.6/21.8 | 20 20.0/21.6 | 15.1/16.1 | FAIL; +36.8%/+32.8% |
| BS cold Submit | 20 2507.1/2552.5 | 20 2511.8/2557.4 | 2513.2/2584.6 | PASS |
| BS switched, all four endpoints | 0 | 0 | — | INCOMPLETE |
| Perm warm verdicts | 20 1448.5/1483.1 | 20 1444.6/1477.3 | 1015.6/1033.0 | FAIL; +42.6%/+42.2% |
| Perm warm firstTrace | 20 1448.5/1483.1 | 20 1444.6/1477.3 | 1015.6/1033.0 | FAIL; +42.6%/+42.2% |
| Perm warm secondTrace | 20 29.7/32.9 | 20 30.0/33.5 | 22.9/25.9 | FAIL; +29.4%/+30.9% |
| Perm warm Submit | 20 490.5/505.1 | 20 486.8/511.3 | nominal 489.0/505.5 | **INVALID COMPARATOR** |
| Perm cold verdicts/firstTrace | 9 3566.5/3635.7 | 10 3547.9/3632.8 | — | INCOMPLETE |
| Perm cold secondTrace | 9 29.0/35.3 | 10 29.3/31.7 | — | INCOMPLETE |
| Perm cold Submit | 20 2604.5/2661.2 | 20 2623.3/2667.9 | 2602.5/2663.3 | PASS |
| Perm switched, all four endpoints | 0 | 0 | — | INCOMPLETE |
| BS lesson Continue | 20 664.2/726.5 | — | 580.9/644.5 | controlInvalid; no new-design reference |
| BS repeat verdicts/firstTrace | 20 764.8/787.4 | 20 772.0/785.3 | 647.3/660.6 and 642.6/660.9 | FAIL; +18.2%/+20.1% |
| BS repeat secondTrace | 20 18.2/18.6 | 20 18.1/18.8 | 16.0/17.0 and 16.1/17.4 | FAIL; +13.8%/+12.4% |
| BS Submit-after-Run | 20 414.5/419.8 | 20 411.1/432.5 | 416.5/429.5 and 420.0/433.5 | PASS |
| Perm repeat verdicts/firstTrace | 20 1108.8/1144.0 | 20 1110.6/1135.3 | 698.4/729.8 and 694.2/711.7 | FAIL; +58.8%/+60.0% |
| Perm repeat secondTrace | 20 24.9/27.4 | 20 24.9/25.8 | 22.8/24.2 and 22.7/24.0 | FAIL gate; median +9.5%/+9.7%, record-only under ruling B |
| Perm Submit-after-Run | 20 488.0/494.4 | 20 491.5/511.2 | 499.1/521.4 and 498.5/507.0 | PASS |
| Phone | — | — | — | NOT RUN |
| Spot | — | — | — | NOT RUN |

Under ruling B, every completed row above with a median over 10% is a fix-forward item. The two warm-Submit cells have no formal verdict from this session.


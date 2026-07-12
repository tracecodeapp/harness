# Browser Harness Cached E2E A/B Report — 2026-07-11

> Historical checkpoint: this report predates the clean-executor prewarm work
> completed later the same day. See
> [Classic browser provider performance ceiling](./browser-classic-performance-ceiling-2026-07-11.md)
> for the current command-ready numbers. The baseline and security conclusions
> below remain valid for the checkpoint they measured.

## Scope

- Before: `a91bca7faf18efd9e627c2cf8052c3290b5e3078`
- After: current working tree
- Browser: headless Chromium through Playwright
- Samples: 5 per language and surface, deterministic seed `20260711`
- Workload: public `add` execution path
- Runtime downloads: excluded with `Cache-Control: public, max-age=31536000, immutable`
- Acceptance: strict cached claims require every measured sample to report `transferSize === 0`
- Java: excluded because the browser-project Java lane requires consumer-provided CheerpJ assets

Classic measures command-to-result on the same public runtime client after its
first command populated the BrowserContext cache. Project measures the second
fresh command on the same public workspace after the first command populated
the cache.

## Classic browser harness

### Exact source and input repeat

| Language | Before p50 | After p50 | Delta | Transfer bytes |
|---|---:|---:|---:|---:|
| JavaScript | 14.5 ms | 16.0 ms | +1.5 ms (+10.3%) | 0 / 0 |
| TypeScript | 127.0 ms | 17.8 ms | -109.2 ms (-86.0%) | 0 / 0 |
| Python | 19.0 ms | 19.7 ms | +0.7 ms (+3.7%) | 0 / 0 |
| C# | 899.6 ms | 3.2 ms | -896.4 ms (-99.6%) | 0 / 0 |
| C++ | 2.0 ms | 17.4 ms | +15.4 ms | 0 / 0 |

### Edited source

| Language | Before p50 | After p50 | Delta | Transfer bytes |
|---|---:|---:|---:|---:|
| JavaScript | 14.4 ms | 15.8 ms | +1.4 ms (+9.7%) | 0 / 0 |
| TypeScript | 125.3 ms | 17.5 ms | -107.8 ms (-86.0%) | 0 / 0 |
| Python | 17.1 ms | 17.5 ms | +0.4 ms (+2.3%) | 0 / 0 |
| C# | 841.5 ms | 865.2 ms | +23.7 ms (+2.8%) | 0 / 0 |
| C++ | 2815.5 ms | 2011.0 ms | -804.5 ms (-28.6%) | 4.1 kB / 0 |

The C++ edited-source baseline is not a strict zero-transfer sample because its
tokenized compiler-frame document transferred 4.1 kB. The document took about
1–2 ms locally, far below the measured 804.5 ms delta, but the row is kept
separate from strict zero-transfer claims.

## Browser project workspace

### Second fresh command

| Language | Before p50 | After p50 | Delta | Transfer bytes | Interpretation |
|---|---:|---:|---:|---:|---|
| JavaScript | 13.3 ms | 13.9 ms | +0.6 ms (+4.5%) | 0 / 0 | Effectively flat |
| TypeScript | Unavailable | 37.8 ms | — | — / 0 | Baseline rejected the browser compiler path |
| Python | 1403.5 ms | 1360.2 ms | -43.3 ms (-3.1%) | 0 / 0 | Effectively flat |
| C# | Unavailable | 3569.3 ms | — | — / 0 | Baseline failed structured cloning of `kernelHttp` |
| C++ | 1905.0 ms | 1910.7 ms | +5.7 ms (+0.3%) | 4.1 / 5.0 kB | Flat; tokenized frame is not zero-transfer |

The baseline C++ first compound command also failed with exit 126 before the
produced-output resolver fix. Baseline hidden-file policy checks failed for all
languages; those failures are outside the timing phases above.

## Chrome DevTools validation

The current project-terminal production surface was traced without throttling:

| Metric | Result |
|---|---:|
| LCP | 165 ms |
| CLS | 0.00 |
| Warm terminal-command INP | 38 ms |
| INP input delay | 0.2 ms |
| INP processing | 10 ms |
| INP presentation delay | 28 ms |

## Conclusion

There is no honest single aggregate speedup. The material cached E2E wins are
Classic TypeScript compilation, Classic C# exact-repeat caching, and Classic C++
edited compilation. JavaScript and Python are essentially unchanged. C++ exact
repeat is about 15 ms slower because the current design pays for disposable user
execution instead of reusing the old execution lane. Browser project speed is
flat for paths that already worked; its largest changes are that TypeScript, C#,
C++ first-run, HTTP bridging, and hidden-file policy now work correctly.

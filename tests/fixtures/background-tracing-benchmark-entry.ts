import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
  type JudgeComparatorStrategy,
} from '../../src/judge';
import { createTraceCCRuntimeManifest } from '../../packages/runtime-cpp/src/tracecc-runtime-assets';

type BenchmarkLanguage =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'java'
  | 'csharp'
  | 'cpp';

export interface BenchmarkCase {
  readonly id: string;
  readonly input: Record<string, unknown>;
  readonly expected: unknown;
  /** Comparison policy from the problem definition; omitted means exact. */
  readonly comparator?: JudgeComparatorStrategy;
}

export interface BenchmarkFixture {
  readonly language: BenchmarkLanguage;
  readonly problem: string;
  readonly code: string;
  readonly functionName: string;
  readonly executionStyle?: 'function' | 'solution-method';
  readonly cases: readonly BenchmarkCase[];
}

export interface BenchmarkOptions {
  /**
   * Trace budget handed to every traced run. The product currently passes `{}`
   * on desktop, which lets the runtime fall back to a 500 single-line-hit
   * ceiling; benchmarking against that measures aborted traces, not real ones.
   */
  readonly traceOptions?: Record<string, unknown>;
  readonly csharpBatchConcurrency?: number;
  /** Skip the trace-all batch measurement (the current shipping behaviour). */
  readonly skipTraceAll?: boolean;
  /**
   * Base URL serving the assembled TraceCC asset tree. C++ needs an explicit
   * runtime manifest; the harness does not derive one from `assetBaseUrl`.
   */
  readonly traceccAssetBaseUrl?: string;
}

export interface PhaseSummary {
  readonly ms: number;
  readonly verdict: string;
  readonly evaluationStatus: string;
  readonly casesPassed: number;
  readonly casesTotal: number;
  readonly compileMs?: number;
  readonly diagnostics: readonly string[];
  /**
   * Actual vs expected for the first few failing cases. Verdicts alone cannot
   * distinguish "produced the wrong value" from "failed to materialize the
   * input at all", which is the difference between a comparator bug and a
   * runtime bug.
   */
  readonly failures?: readonly {
    readonly caseId: string;
    readonly status: string;
    readonly verdict: string;
    readonly got: string;
    readonly expected: string;
  }[];
}

export interface BenchmarkLanguageResult {
  readonly language: BenchmarkLanguage;
  readonly problem: string;
  readonly caseCount: number;
  readonly warmMs?: number;
  /** Compile + run every case untraced: the "all compiled, pass/fail" clock. */
  readonly correctness: PhaseSummary;
  /** Current shipping behaviour: one batch that traces every case. */
  readonly traceAll?: PhaseSummary;
  /**
   * Per-case untraced cost, one evaluation each. Carries the same
   * per-evaluation preparation overhead as `perCaseTraceMs`, so the ratio
   * between them isolates what tracing itself costs on that input.
   */
  readonly perCaseCodeMs: readonly number[];
  readonly perCaseCodeVerdicts: readonly string[];
  /**
   * Background-tracing simulation: trace one case at a time, in order, each as
   * its own evaluation against the same warm host.
   */
  readonly perCaseTraceMs: readonly number[];
  readonly perCaseVerdicts: readonly string[];
  /** Retained trace event count per case (-1 when the case had no trace). */
  readonly perCaseEventCounts: readonly number[];
  /** Optional TraceHooks profiles parsed from case stdout (Java measurement). */
  readonly perCaseProfiles?: ReadonlyArray<Record<string, unknown> | null>;
  readonly error?: string;
}

function summarize(
  startedAt: number,
  endedAt: number,
  receipt: Awaited<
    ReturnType<ReturnType<typeof createBrowserJudgeHost>['evaluateAlgorithm']>
  >
): PhaseSummary {
  const ms = endedAt - startedAt;
  if (receipt.evaluation.status !== 'completed') {
    return {
      ms,
      verdict: receipt.verdict,
      evaluationStatus: receipt.evaluation.status,
      casesPassed: 0,
      casesTotal: 0,
      diagnostics: [
        ...receipt.evaluation.compile.diagnostics.map((diagnostic) =>
          String((diagnostic as { message?: unknown }).message ?? diagnostic)
        ),
        ...(receipt.evaluation.compile.stderr
          ? [`stderr: ${receipt.evaluation.compile.stderr}`]
          : []),
        ...(receipt.evaluation.compile.stdout
          ? [`stdout: ${receipt.evaluation.compile.stdout}`]
          : []),
      ].slice(0, 5),
    };
  }
  const cases = receipt.evaluation.cases;
  const compileTotal = receipt.evaluation.compile?.timings?.totalMs;
  return {
    ms,
    verdict: receipt.verdict,
    evaluationStatus: receipt.evaluation.status,
    casesPassed: cases.filter((testCase) => testCase.verdict.kind === 'passed').length,
    casesTotal: cases.length,
    ...(typeof compileTotal === 'number' ? { compileMs: compileTotal } : {}),
    diagnostics: cases
      .flatMap((testCase) => testCase.diagnostics)
      .map((diagnostic) => String((diagnostic as { message?: unknown }).message ?? diagnostic))
      .slice(0, 5),
    failures: cases
      .filter((testCase) => testCase.verdict.kind !== 'passed')
      .slice(0, 3)
      .map((testCase) => {
        const clip = (value: unknown) => {
          try {
            return JSON.stringify(value ?? null).slice(0, 220);
          } catch {
            return String(value).slice(0, 220);
          }
        };
        return {
          caseId: testCase.caseId,
          status: testCase.status,
          verdict: testCase.verdict.kind,
          got: clip((testCase as { value?: unknown }).value),
          expected: clip((testCase as { expected?: unknown }).expected),
        };
      }),
  };
}

export async function runBackgroundTracingBenchmark(
  assetBaseUrl: string,
  fixtures: readonly BenchmarkFixture[],
  options: BenchmarkOptions = {}
): Promise<BenchmarkLanguageResult[]> {
  const results: BenchmarkLanguageResult[] = [];

  for (const fixture of fixtures) {
    let host: ReturnType<typeof createBrowserJudgeHost> | undefined;

    const bundleBase = {
      language: fixture.language,
      code: fixture.code,
      functionName: fixture.functionName,
      ...(fixture.executionStyle ? { executionStyle: fixture.executionStyle } : {}),
    } as const;

    try {
      host = createBrowserJudgeHost({
        assetBaseUrl,
        providers: [fixture.language],
        ...(fixture.language === 'csharp'
          ? {
              csharp: {
                preparedBatchConcurrency: options.csharpBatchConcurrency ?? 4,
              },
            }
          : {}),
        ...(fixture.language === 'cpp' && options.traceccAssetBaseUrl
          ? {
              assets: {
                runtimeManifests: {
                  cpp: createTraceCCRuntimeManifest(options.traceccAssetBaseUrl),
                },
              },
            }
          : {}),
        safeExecution: { prewarmAfterUse: false },
      });
      // Warm the runtime so engine download/boot is not charged to the
      // correctness clock. The product warms on route entry.
      let warmMs: number | undefined;
      const warmStartedAt = performance.now();
      try {
        await host.warmLanguage(fixture.language);
        warmMs = performance.now() - warmStartedAt;
      } catch {
        warmMs = undefined;
      }

      // Phase 1 - compile + correctness for every case, untraced.
      const correctnessBundle = await createAlgorithmJudgeBundle({
        ...bundleBase,
        id: `bg-${fixture.language}-${fixture.problem}-correctness`,
        cases: fixture.cases.map((testCase) => ({
          id: testCase.id,
          input: testCase.input,
          expected: testCase.expected,
          ...(testCase.comparator ? { comparator: testCase.comparator } : {}),
        })),
      });
      const correctnessStartedAt = performance.now();
      const correctnessReceipt = await host.evaluateAlgorithm({
        bundle: correctnessBundle,
      });
      const correctness = summarize(
        correctnessStartedAt,
        performance.now(),
        correctnessReceipt
      );

      // Phase 1b - the same cases untraced, one evaluation each. Pairs with
      // phase 2 to split interpretation cost from trace-emission cost.
      const perCaseCodeMs: number[] = [];
      const perCaseCodeVerdicts: string[] = [];
      for (const testCase of fixture.cases) {
        const caseBundle = await createAlgorithmJudgeBundle({
          ...bundleBase,
          id: `bg-${fixture.language}-${fixture.problem}-code-${testCase.id}`,
          cases: [
            {
              id: testCase.id,
              input: testCase.input,
              expected: testCase.expected,
              ...(testCase.comparator ? { comparator: testCase.comparator } : {}),
            },
          ],
        });
        const startedAt = performance.now();
        const receipt = await host.evaluateAlgorithm({ bundle: caseBundle });
        perCaseCodeMs.push(performance.now() - startedAt);
        perCaseCodeVerdicts.push(
          receipt.evaluation.status === 'completed'
            ? (receipt.evaluation.cases[0]?.verdict.kind ?? 'missing')
            : `evaluation:${receipt.evaluation.status}`
        );
      }

      // Phase 2 - background-tracing simulation: one traced case at a time.
      const perCaseTraceMs: number[] = [];
      const perCaseVerdicts: string[] = [];
      const perCaseEventCounts: number[] = [];
      const perCaseProfiles: Array<Record<string, unknown> | null> = [];
      const profileMarker = '__TRACECODE_TRACE_PROFILE_JSON__:';
      for (const testCase of fixture.cases) {
        const caseBundle = await createAlgorithmJudgeBundle({
          ...bundleBase,
          id: `bg-${fixture.language}-${fixture.problem}-trace-${testCase.id}`,
          cases: [
            {
              id: testCase.id,
              input: testCase.input,
              expected: testCase.expected,
              ...(testCase.comparator ? { comparator: testCase.comparator } : {}),
            },
          ],
          trace: true,
          ...(options.traceOptions
            ? { traceOptions: options.traceOptions as never }
            : {}),
        });
        const startedAt = performance.now();
        const receipt = await host.evaluateAlgorithm({ bundle: caseBundle });
        perCaseTraceMs.push(performance.now() - startedAt);
        {
          const caseTrace = (receipt.evaluation.status === 'completed'
            ? (receipt.evaluation.cases[0] as { trace?: { events?: unknown[] } } | undefined)?.trace
            : undefined);
          perCaseEventCounts.push(Array.isArray(caseTrace?.events) ? caseTrace.events.length : -1);
          if (Array.isArray(caseTrace?.events) && caseTrace.events.length >= 2_000) {
            let hash = 0x811c9dc5;
            const text = JSON.stringify(caseTrace.events);
            for (let i = 0; i < text.length; i++) {
              hash = ((hash ^ text.charCodeAt(i)) * 0x01000193) >>> 0;
            }
            console.log('__TRACECODE_CASEHASH__:' + JSON.stringify({
              caseIndex: perCaseEventCounts.length - 1,
              events: caseTrace.events.length,
              chars: text.length,
              hash: hash.toString(16),
              last: JSON.stringify(caseTrace.events[caseTrace.events.length - 1])?.slice(0, 160),
            }));
          }
          if (Array.isArray(caseTrace?.events) && caseTrace.events.length >= 100_000) {
            const kinds: Record<string, number> = {};
            let sample: unknown = null;
            let sampleLength = 0;
            for (const event of caseTrace.events) {
              const kind = String((event as { kind?: unknown })?.kind ?? '?');
              kinds[kind] = (kinds[kind] ?? 0) + 1;
              if (kind === 'snapshot') {
                const size = JSON.stringify(event)?.length ?? 0;
                if (size > sampleLength) {
                  sampleLength = size;
                  sample = event;
                }
              }
            }
            console.log('__TRACECODE_KINDS__:' + JSON.stringify({ kinds, sample: JSON.stringify(sample)?.slice(0, 400) }));
          }
        }
        perCaseVerdicts.push(
          receipt.evaluation.status === 'completed'
            ? (() => {
                const only = receipt.evaluation.cases[0];
                if (!only) return 'missing';
                const kind = only.verdict.kind;
                // 'not-evaluated' alone is ambiguous: a missing expected value
                // and a case that never completed look identical. Carry the
                // reason and the case status so the two can be told apart.
                if (kind !== 'not-evaluated') return kind;
                const reason = String(
                  (only.verdict as { reason?: unknown }).reason ?? '?'
                );
                const why = [
                  ...(only.diagnostics ?? []).map((d) =>
                    String((d as { message?: unknown }).message ?? d)
                  ),
                  String(only.stderr ?? ''),
                ]
                  .filter(Boolean)
                  .join(' | ')
                  .slice(0, 300);
                return `not-evaluated:${reason}:${only.status} :: ${why}`;
              })()
            : `evaluation:${receipt.evaluation.status}`
        );
        let profile: Record<string, unknown> | null = null;
        const stdout = receipt.evaluation.cases[0]?.stdout ?? '';
        for (const line of stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith(profileMarker)) continue;
          try {
            profile = JSON.parse(trimmed.slice(profileMarker.length)) as Record<
              string,
              unknown
            >;
          } catch {
            profile = { parseError: true, raw: trimmed };
          }
          break;
        }
        perCaseProfiles.push(profile);
      }

      // Phase 3 - current shipping behaviour, for comparison: trace every case
      // in one batch.
      let traceAll: PhaseSummary | undefined;
      if (!options.skipTraceAll) {
        const traceAllBundle = await createAlgorithmJudgeBundle({
          ...bundleBase,
          id: `bg-${fixture.language}-${fixture.problem}-trace-all`,
          cases: fixture.cases.map((testCase) => ({
            id: testCase.id,
            input: testCase.input,
            expected: testCase.expected,
          })),
          trace: true,
          ...(options.traceOptions
            ? { traceOptions: options.traceOptions as never }
            : {}),
        });
        const startedAt = performance.now();
        const receipt = await host.evaluateAlgorithm({ bundle: traceAllBundle });
        traceAll = summarize(startedAt, performance.now(), receipt);
      }

      results.push({
        language: fixture.language,
        problem: fixture.problem,
        caseCount: fixture.cases.length,
        ...(warmMs === undefined ? {} : { warmMs }),
        correctness,
        ...(traceAll ? { traceAll } : {}),
        perCaseCodeMs,
        perCaseCodeVerdicts,
        perCaseTraceMs,
        perCaseVerdicts,
        perCaseEventCounts,
        perCaseProfiles,
      });
    } catch (error) {
      results.push({
        language: fixture.language,
        problem: fixture.problem,
        caseCount: fixture.cases.length,
        correctness: {
          ms: 0,
          verdict: 'error',
          evaluationStatus: 'error',
          casesPassed: 0,
          casesTotal: 0,
          diagnostics: [],
        },
        perCaseCodeMs: [],
        perCaseCodeVerdicts: [],
        perCaseTraceMs: [],
        perCaseEventCounts: [],
        perCaseVerdicts: [],
        perCaseProfiles: [],
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    } finally {
      host?.dispose();
    }
  }

  return results;
}

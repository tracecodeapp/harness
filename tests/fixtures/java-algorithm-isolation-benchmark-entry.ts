import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
} from '../../src/judge';

interface BenchmarkSample {
  readonly label: 'algorithm-fast' | 'compatibility';
  readonly elapsedMs: number;
  readonly verdict: string;
  readonly passedCount: number;
  readonly totalCount: number;
}

const FAST_SOURCE = [
  'import java.util.*;',
  'class Solution {',
  '  private static int calls = 0;',
  '  public int solve(int value) {',
  '    Deque<Integer> queue = new ArrayDeque<>();',
  '    queue.addLast(value);',
  '    calls += 1;',
  '    return calls == 1 ? queue.removeFirst() : -1;',
  '  }',
  '}',
].join('\n');

const COMPATIBILITY_SOURCE = FAST_SOURCE.replace(
  '    Deque<Integer> queue = new ArrayDeque<>();',
  [
    '    // The branch is deliberately unreachable for benchmark inputs.',
    '    // Its compiled System-property reference forces the exact artifact',
    '    // onto the fresh-TraceJVM compatibility boundary.',
    '    if (value < 0) System.getProperty("tracecode.java.benchmark");',
    '    Deque<Integer> queue = new ArrayDeque<>();',
  ].join('\n')
);

async function evaluate(
  assetBaseUrl: string,
  label: BenchmarkSample['label'],
  code: string,
  caseCount: number,
  round: number
): Promise<BenchmarkSample> {
  const host = createBrowserJudgeHost({
    assetBaseUrl,
    providers: ['java'],
    safeExecution: { prewarmAfterUse: false },
  });
  try {
    const bundle = await createAlgorithmJudgeBundle({
      id: `java-isolation-${label}-${caseCount}-${round}`,
      language: 'java',
      code,
      functionName: 'solve',
      executionStyle: 'solution-method',
      cases: Array.from({ length: caseCount }, (_, index) => ({
        id: `case-${index + 1}`,
        input: { value: index + 1 },
        expected: index + 1,
      })),
    });
    const startedAt = performance.now();
    const receipt = await host.evaluateAlgorithm({ bundle });
    const elapsedMs = performance.now() - startedAt;
    const cases =
      receipt.evaluation.status === 'completed'
        ? receipt.evaluation.cases
        : [];
    return {
      label,
      elapsedMs,
      verdict: receipt.verdict,
      passedCount: cases.filter(
        (testCase) => testCase.verdict.kind === 'passed'
      ).length,
      totalCount: cases.length,
    };
  } finally {
    host.dispose();
  }
}

export async function runJavaAlgorithmIsolationBenchmark(
  assetBaseUrl: string,
  caseCount: number,
  rounds: number
): Promise<readonly BenchmarkSample[]> {
  const samples: BenchmarkSample[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const definitions =
      round % 2 === 0
        ? [
            ['algorithm-fast', FAST_SOURCE],
            ['compatibility', COMPATIBILITY_SOURCE],
          ] as const
        : [
            ['compatibility', COMPATIBILITY_SOURCE],
            ['algorithm-fast', FAST_SOURCE],
          ] as const;
    for (const [label, source] of definitions) {
      samples.push(
        await evaluate(assetBaseUrl, label, source, caseCount, round)
      );
    }
  }
  return samples;
}

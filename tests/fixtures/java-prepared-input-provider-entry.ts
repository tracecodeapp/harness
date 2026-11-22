// Java Judge outcomes for prepared inputs the Harness cannot build, through
// the public BrowserJudgeHost in a real Java worker.
import { createAlgorithmJudgeBundle, createBrowserJudgeHost } from '../../src/judge';

const CODE = [
  'class ListNode {',
  '  int val;',
  '  ListNode next;',
  '  ListNode(int val) {',
  '    if (val < 0) throw new IllegalArgumentException("negative values are not allowed");',
  '    this.val = val;',
  '  }',
  '}',
  'class Solution {',
  '  public int first(ListNode head) {',
  '    if (head.val == 9) throw new IllegalStateException("the learner\'s own failure");',
  '    return head.val;',
  '  }',
  '}',
].join('\n');

export interface ProviderOutcomeSample {
  readonly label: string;
  readonly status?: string;
  readonly cases: readonly Record<string, any>[];
  readonly error?: string;
}

const SCENARIOS: ReadonlyArray<{ label: string; input: unknown; trace?: boolean }> = [
  { label: 'constructor rejects the input', input: { head: { val: -1, next: null } } },
  { label: 'unknown reference', input: { head: { val: 1, next: { __ref__: 'missing' } } } },
  { label: 'learner method throws', input: { head: { val: 9, next: null } } },
  { label: 'unknown reference, traced', input: { head: { val: 1, next: { __ref__: 'missing' } } }, trace: true },
];

export async function runJavaPreparedInputOutcomes(options: { readonly assetBaseUrl: string }): Promise<ProviderOutcomeSample[]> {
  const host = createBrowserJudgeHost({ assetBaseUrl: options.assetBaseUrl, providers: ['java'] });
  const samples: ProviderOutcomeSample[] = [];
  try {
    for (const [index, scenario] of SCENARIOS.entries()) {
      try {
        const bundle = await createAlgorithmJudgeBundle({
          id: `java-prepared-input-provider-${index}`,
          language: 'java',
          code: CODE,
          functionName: 'first',
          executionStyle: 'solution-method',
          cases: [{ id: 'case-1', input: scenario.input as Record<string, unknown>, expected: 1 }],
          ...(scenario.trace ? { trace: true } : {}),
        });
        // As the app's Submit sends a Java evaluation.
        const receipt = await host.evaluateAlgorithm({ bundle, stopAtFirstRunaway: true } as never);
        samples.push({
          label: scenario.label,
          status: receipt.evaluation.status,
          cases: (receipt.evaluation.status === 'completed' ? receipt.evaluation.cases : []).map((testCase: any) =>
            JSON.parse(JSON.stringify({ status: testCase.status, failure: testCase.failure }))),
        });
      } catch (caught) {
        samples.push({ label: scenario.label, cases: [], error: caught instanceof Error ? caught.message : String(caught) });
      }
    }
  } finally {
    host.dispose();
  }
  return samples;
}

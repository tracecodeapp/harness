import assert from 'node:assert/strict';
import { test } from 'node:test';
import vectors from '../../../tests/fixtures/graph-ref-compare-vectors.json';
import { allCasesPassPolicy, createAlgorithmJudgeReceipt } from '../src/algorithm-evaluate';
import { compareJudgeValues, compareSerializedValues, createJudgeComparator, type JudgeCompareMode } from '../src/comparator-strategy';
import { constructJudgeVerdict } from '../src/comparison';

function actualValueForVector(actual: unknown, liveCycleAt?: string): unknown {
  if (!liveCycleAt) return actual;
  const value = structuredClone(actual) as Record<string, Record<string, unknown>>;
  const node = value[liveCycleAt]!;
  node.self = node;
  return value;
}

for (const { name, actual, expected, compareMode, equal, outcome, liveCycleAt } of vectors) {
  test(name, () => {
    const mode = compareMode as JudgeCompareMode;
    const actualValue = actualValueForVector(actual, liveCycleAt);
    if (outcome === 'limit') {
      assert.equal(equal, null);
      assert.throws(() => compareJudgeValues(actual, expected, mode), {
        name: 'GraphComparisonLimitError',
        code: 'GRAPH_COMPARISON_LIMIT',
      });
      const verdict = constructJudgeVerdict(
        { planId: 'graph-output', caseId: name, input: {}, actual, expected },
        createJudgeComparator({ schema: 'tracecode.judge.comparator.v1', mode })
      );
      assert.deepEqual(verdict, {
        kind: 'comparison-error',
        comparatorId: 'tracecode:unordered-array:v1',
        message: 'GRAPH_COMPARISON_LIMIT',
      });
      const receipt = createAlgorithmJudgeReceipt({
        id: 'graph-output',
        workspaceDigest: 'sha256:test',
        policy: allCasesPassPolicy(),
      }, {
        planId: 'graph-output',
        status: 'completed',
        cases: [{
          caseId: name,
          status: 'completed',
          verdict,
          sessionId: 'session-1',
          pid: 1,
          termination: { kind: 'exit', exitCode: 0 },
          stdout: '',
          stderr: '',
          diagnostics: [],
          timedOut: false,
        }],
      });
      assert.equal(receipt.verdict, 'indeterminate');
      assert.equal(receipt.policy.trace.reason, 'GRAPH_COMPARISON_LIMIT');
      return;
    }
    assert.equal(outcome, equal ? 'equal' : 'unequal');
    assert.equal(compareJudgeValues(actualValue, expected, mode), equal);
    assert.equal(compareJudgeValues(expected, actualValue, mode), equal);
  });
}

for (const { name, actual, expected, compareMode, equal, liveCycleAt } of vectors) {
  if (compareMode !== 'exact') continue;
  test(`default structural JSON comparator: ${name}`, () => {
    const verdict = constructJudgeVerdict({
      planId: 'graph-output', caseId: name, input: {}, actual: actualValueForVector(actual, liveCycleAt), expected,
    });
    assert.equal(verdict.kind, liveCycleAt ? 'comparison-error' : equal ? 'passed' : 'failed');
  });
}


function observeSearch(vector: (typeof vectors)[number]) {
  let steps: number | undefined;
  let outcome: 'equal' | 'unequal' | 'limit';
  try {
    const matched = compareSerializedValues(vector.actual, vector.expected,
      vector.compareMode as JudgeCompareMode, true, false, (count) => { steps = count; });
    outcome = matched ? 'equal' : 'unequal';
  } catch (error) {
    assert.ok(error instanceof Error && error.name === 'GraphComparisonLimitError');
    outcome = 'limit';
  }
  assert.ok(steps !== undefined && steps > 0);
  return { outcome, steps };
}

for (const vector of vectors) {
  if (!vector.compareStepsWith) continue;
  test(`canonical key order preserves outcome and steps for ${vector.name}`, () => {
    const paired = vectors.find(({ name }) => name === vector.compareStepsWith);
    assert.ok(paired);
    assert.deepEqual(vector.actual, paired.actual);
    assert.deepEqual(vector.expected, paired.expected);
    assert.notEqual(JSON.stringify(vector.actual), JSON.stringify(paired.actual));
    assert.deepEqual(observeSearch(vector), observeSearch(paired));
  });
}

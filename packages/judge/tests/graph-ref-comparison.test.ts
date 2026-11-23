import assert from 'node:assert/strict';
import { test } from 'node:test';
import vectors from '../../../tests/fixtures/graph-ref-compare-vectors.json';
import { allCasesPassPolicy, createAlgorithmJudgeReceipt } from '../src/algorithm-evaluate';
import { compareJudgeValues, createJudgeComparator, type JudgeCompareMode } from '../src/comparator-strategy';
import { constructJudgeVerdict } from '../src/comparison';

for (const { name, actual, expected, compareMode, equal, outcome } of vectors) {
  test(name, () => {
    const mode = compareMode as JudgeCompareMode;
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
    assert.equal(compareJudgeValues(actual, expected, mode), equal);
    assert.equal(compareJudgeValues(expected, actual, mode), equal);
  });
}

for (const { name, actual, expected, compareMode, equal } of vectors) {
  if (compareMode !== 'exact') continue;
  test(`default structural JSON comparator: ${name}`, () => {
    const verdict = constructJudgeVerdict({ planId: 'graph-output', caseId: name, input: {}, actual, expected });
    assert.equal(verdict.kind, equal ? 'passed' : 'failed');
  });
}

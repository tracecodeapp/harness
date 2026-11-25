import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { summarize } from './checks.mjs';
import {
  checkJudgedByteLimit, judgedByteLimitFixtures, judgedByteLimitId, judgedByteLimitRequest,
} from './judged-byte-limit.mjs';

function evidence(fixture) {
  const completed = ({ id, expected }) => ({ caseId: id, status: 'completed', value: expected, verdict: { kind: 'passed' } });
  const limited = { status: 'runtime-error', failure: { origin: 'limit', reason: 'serialization-limit' } };
  return {
    journal: [{ phase: 'judged-output-policy', language: fixture.language, evaluationId: 'eval-1', maxBytes: 1024, lowered: true }],
    reported: { evaluation: { status: 'completed', cases: [
      completed(fixture.cases[0]), { caseId: 'long', ...limited },
    ] } },
    completed,
    limited,
  };
}

for (const fixture of judgedByteLimitFixtures.filter(({ language }) => language !== 'python')) {
  test(`${fixture.language}: accepts the paired outcomes under the effective cap`, () => {
    assert.equal(checkJudgedByteLimit(fixture, [evidence(fixture)]).status, 'pass');
  });
  test(`${fixture.language}: rejects a removed bridge hook`, () => {
    const observation = evidence(fixture);
    observation.journal = [];
    assert.deepEqual(checkJudgedByteLimit(fixture, [observation]), {
      id: judgedByteLimitId(fixture), language: fixture.language, status: 'fail', message: 'no policy marker',
    });
  });
  test(`${fixture.language}: rejects a present marker when the long answer completes`, () => {
    const observation = evidence(fixture);
    observation.reported.evaluation.cases[1] = observation.completed(fixture.cases[1]);
    const result = checkJudgedByteLimit(fixture, [observation]);
    assert.equal(result.status, 'fail');
    assert.match(result.message, /^policy not honoured: 2048-character/);
  });
  test(`${fixture.language}: rejects refusal of both answers`, () => {
    const observation = evidence(fixture);
    observation.reported.evaluation.cases[0] = { caseId: 'short', ...observation.limited };
    const result = checkJudgedByteLimit(fixture, [observation]);
    assert.equal(result.status, 'fail');
    assert.match(result.message, /^policy not honoured: 64-character/);
  });
}

test('rejects a wrong cap and a refusal that still returns a value', () => {
  const fixture = judgedByteLimitFixtures[0];
  const wrongCap = evidence(fixture);
  wrongCap.journal[0].maxBytes = 4096;
  assert.match(checkJudgedByteLimit(fixture, [wrongCap]).message, /marker did not confirm/);

  const observation = evidence(fixture);
  const long = observation.reported.evaluation.cases[1];
  long.value = null;
  assert.equal(checkJudgedByteLimit(fixture, [observation]).status, 'fail');
  long.value = { '$gate.undefined': true };
  assert.equal(checkJudgedByteLimit(fixture, [observation]).status, 'pass');
});

test('inventory includes all six cells and Python has its own disposition', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.inventory.filter((id) => id.split('/')[2] === 'judged-byte-limit'), judgedByteLimitFixtures.map(judgedByteLimitId));
  assert.equal(judgedByteLimitRequest.trace, false);
  const fixture = judgedByteLimitFixtures.find(({ language }) => language === 'python');
  const result = checkJudgedByteLimit(fixture, []);
  assert.equal(result.status, 'not-applicable');
  const summary = summarize([result.id], [result]);
  assert.deepEqual(summary.notApplicable, [result.id]);
  assert.deepEqual(summary.counts['G6/python'], {
    expected: 1, seen: 1, passed: 0, failed: 0, missing: 0, notApplicable: 1,
  });
});

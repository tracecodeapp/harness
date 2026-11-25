import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCppNaturalShape, cppNaturalShapeId, cppNaturalShapeRequests, cppNaturalShapes } from './cpp-natural-shapes.mjs';
import { cCppQualificationSubject, cCppSubject, cppStep7Subject } from './cpp-refusal.mjs';

const fixed = cppNaturalShapes(cCppSubject);
const baseline = cppNaturalShapes(cppStep7Subject);

function outcome(fixture, request, reported) {
  const results = [];
  checkCppNaturalShape(fixture, request, { reported }, (row) => results.push(row));
  return results[0]?.status;
}

function completed(fixture, values) {
  const cases = fixture.cases.map(({ id, expected }, index) => ({
    caseId: id, status: 'completed', value: values[index],
    verdict: { kind: values[index] === expected ? 'passed' : 'failed' },
  }));
  const passedCount = cases.filter(({ verdict }) => verdict.kind === 'passed').length;
  return {
    evaluation: { status: 'completed', compile: { status: 'compiled' }, cases },
    totalCount: cases.length, passedCount, verdict: passedCount === cases.length ? 'passed' : 'failed',
  };
}

test('natural shapes plan exactly five public routes for each of the 18 fixtures on both pins', () => {
  assert.equal(fixed.length, 18);
  assert.deepEqual(cppNaturalShapes(cCppQualificationSubject), fixed);
  assert.equal(baseline.length, 18);
  assert.equal(baseline.filter(({ naturalShape }) => naturalShape.compileError).length, 12);
  assert.equal(baseline.filter(({ naturalShape }) => naturalShape.wrongAnswer).length, 1);
  assert.deepEqual(cppNaturalShapes('b025fdb8220694cdfe96b136a0b8bb82843f7371'), []);
  const planned = (fixtures) => fixtures.flatMap((fixture) => {
    const [a, b] = fixture.cases.map(({ id }) => id);
    const requests = cppNaturalShapeRequests(fixture);
    assert.deepEqual(requests.map(({ id, mode, selected, trace }) => [id, mode, selected, trace]), [
      ['run-untraced', 'initial', [], true],
      ['run-first-traced', 'initial', [a], true],
      ['run-all-traced', 'initial', [a, b], true],
      ['submit', 'submit', [], false],
      ['submit-traced', 'submit', [a, b], true],
    ]);
    return requests.map((request) => cppNaturalShapeId(fixture, request));
  });
  assert.equal(new Set(planned(fixed)).size, 90);
  assert.deepEqual(planned(fixed), planned(baseline));
});

test('step 7 needs the recorded compile diagnostic, zero rows and no handle', () => {
  const fixture = baseline.find(({ naturalShape }) => naturalShape.compileError);
  const [run] = cppNaturalShapeRequests(fixture);
  const sample = {
    evaluation: {
      status: 'compile-failed',
      compile: { status: 'compile-failed', diagnostics: [{ severity: 'error', message: fixture.naturalShape.compileError }] },
      cases: [],
    },
  };
  assert.equal(outcome(fixture, run, sample), 'pass');
  assert.equal(outcome(fixture, run, undefined), undefined);
  assert.equal(outcome(fixture, run, { ...sample, executionId: 'retained' }), 'fail');
  assert.equal(outcome(fixture, run, { evaluation: { ...sample.evaluation, cases: [{ caseId: 'A' }] } }), 'fail');
  sample.evaluation.compile.diagnostics[0].message = 'a different compile error';
  assert.equal(outcome(fixture, run, sample), 'fail');
});

test('the fixed pin must grade every value; step 7 needs an actual wrong answer on currency-s3', () => {
  const old = baseline.find(({ naturalShape }) => naturalShape.wrongAnswer);
  const fixture = fixed.find(({ name }) => name === old.name);
  const submit = cppNaturalShapeRequests(fixture).find(({ id }) => id === 'submit-traced');
  const good = completed(fixture, [true, false]);
  const wrong = completed(fixture, [false, false]);
  assert.equal(outcome(fixture, submit, good), 'pass');
  assert.equal(outcome(old, submit, wrong), 'pass');
  assert.equal(outcome(fixture, submit, wrong), 'fail');
  assert.equal(outcome(old, submit, good), 'fail');
  assert.equal(outcome(old, submit, { ...wrong, totalCount: 1 }), 'fail');
  wrong.evaluation.cases[0].verdict.kind = 'passed';
  assert.equal(outcome(old, submit, wrong), 'fail');
});

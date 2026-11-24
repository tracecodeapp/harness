import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { cCppSubject, cppStep7Subject } from './cpp-refusal.mjs';

export function cppNaturalShapes(subject) {
  // The fixture records the behavior of the two carried C++ packages. Leave
  // other subjects, including the frozen inventory, on their established matrix.
  if (subject !== cCppSubject && subject !== cppStep7Subject) return [];
  const { fixtures } = JSON.parse(readFileSync(new URL('../fixtures/cpp-natural-shapes.json', import.meta.url)));
  return fixtures.map(({ name, on571139f0, ...fixture }) => ({
    ...fixture,
    gate: 'G6', language: 'cpp', name: `cpp-natural-shape-${name}`,
    limits: { wallClockMs: 20_000 },
    naturalShape: subject === cppStep7Subject ? on571139f0 : { passes: true },
  }));
}

export function cppNaturalShapeRequests(fixture) {
  const cases = fixture.cases.map(({ id }) => id);
  return [
    { id: 'run-untraced', mode: 'initial', selected: [], trace: true },
    { id: 'run-first-traced', mode: 'initial', selected: cases.slice(0, 1), trace: true },
    { id: 'run-all-traced', mode: 'initial', selected: cases, trace: true },
    { id: 'submit', mode: 'submit', selected: [], trace: false },
    { id: 'submit-traced', mode: 'submit', selected: cases, trace: true },
  ].map((request) => ({ ...request, cases }));
}

export function cppNaturalShapeId(fixture, request) {
  return `${fixture.gate}/${fixture.language}/${fixture.name}/default/${request.id}/@request/outcome`;
}

export function checkCppNaturalShape(fixture, request, observation, record) {
  const { reported } = observation;
  if (!reported || Object.hasOwn(reported, '$gate.undefined')) return;
  const id = cppNaturalShapeId(fixture, request);
  const expected = fixture.naturalShape;
  try {
    const { evaluation } = reported;
    let passedCount = 0;
    if (expected.compileError) {
      assert.equal(evaluation.status, 'compile-failed');
      assert.equal(evaluation.compile.status, 'compile-failed');
      assert(evaluation.compile.diagnostics.some(({ severity, message }) =>
        severity === 'error' && message.includes(expected.compileError)),
      `Expected a compile error containing "${expected.compileError}"`);
      assert.deepEqual(evaluation.cases, []);
      assert(!Object.hasOwn(reported, 'executionId'), 'Compile failure retained a handle');
    } else {
      assert.equal(evaluation.status, 'completed');
      assert.equal(evaluation.compile.status, 'compiled');
      assert.deepEqual(evaluation.cases.map(({ caseId }) => caseId), request.cases);
      for (const [index, row] of evaluation.cases.entries()) {
        const want = fixture.cases[index].expected;
        assert.equal(row.status, 'completed', row.caseId);
        assert(Object.hasOwn(row, 'value') && !Object.hasOwn(row.value ?? {}, '$gate.undefined'),
          `Missing value for ${row.caseId}`);
        if (expected.passes) assert.deepEqual(row.value, want, row.caseId);
        const matches = isDeepStrictEqual(row.value, want);
        assert.equal(row.verdict.kind, matches ? 'passed' : 'failed', row.caseId);
        if (matches) passedCount++;
      }
      if (expected.wrongAnswer) assert(passedCount < request.cases.length, 'Expected a completed wrong answer');
    }
    if (request.mode === 'submit') {
      assert.equal(reported.totalCount, evaluation.cases.length);
      assert.equal(reported.passedCount, passedCount);
      assert.equal(reported.verdict, passedCount === request.cases.length ? 'passed' : 'failed');
    }
    record({ id, status: 'pass' });
  } catch (error) {
    record({ id, status: 'fail', message: error.message });
  }
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkCppDirect, checkDifferential, checkObservation } from './checks.mjs';
import { cCppQualificationSubject, cCppSubject, cppRefusalFor, cppStep7Subject } from './cpp-refusal.mjs';
import { muxRequests, requestMatrix } from './requests.mjs';

const manifest = JSON.parse(readFileSync(new URL('manifest.json', import.meta.url)));
const exceptionFixture = manifest.fixtures.find(({ language, name }) => language === 'cpp' && name === 'print-then-throw');
const fixture = { ...exceptionFixture, cppRefusal: cppRefusalFor(exceptionFixture, '9b30ad9bc203ad2ba2f159d96dfaef62940262c7',
  manifest.candidate, false) };
const message = 'C++ exceptions are not supported yet';
const diagnostic = { code: 'cpp-exceptions-unsupported', path: 'solution.cpp', line: 10, column: 5,
  severity: 'error', message, source: 'cpp' };
const compile = {
  status: 'compile-failed', stdout: '', stderr: message + '\n', timedOut: false,
  failure: { message, line: 10, origin: 'program', stage: 'compile' },
  diagnostics: [diagnostic], termination: { kind: 'exit', exitCode: 1 }, sessionId: 'test', pid: 1,
};
const projection = { kind: 'failed', error: message, errorLine: 10, diagnosticStage: 'compile', diagnostic, consoleOutput: [] };
const scope = { evaluationId: 'test-eval', workspaceDigest: 'test-digest', generation: 1 };
const mark = (phase, sequence) => ({ ...scope, phase, sequence });
const observation = {
  reported: { evaluation: { status: 'compile-failed', compile, cases: [] } }, workspaceDigest: scope.workspaceDigest,
  compileProjection: projection, tracedCompileProjection: { ...projection, executionTimeMs: 0,
    trace: { language: 'cpp', runId: 'cpp:compile', events: [] } },
  journal: [mark('ordinary-commit', 1), mark('public-resolve', 2)],
  worker: [{ action: 'command', type: 'prepare-runtime-program' }],
};
const requests = requestMatrix(fixture.cases.map(({ id }) => id), fixture);
const runFirst = requests.find(({ id }) => id === 'run-first');
const draw = requests.find(({ id }) => id === 'draw-b');
const frozen = manifest.candidate;

function status(request, observed, hook) {
  const rows = [];
  checkObservation(fixture, request, observed, (row) => rows.push(row), true);
  return rows.find(({ id }) => id.endsWith('/@request/' + hook))?.status;
}

test('CPP refusal profile is fixed by the subject, independently of its reply', () => {
  assert(cppRefusalFor(fixture, '9b30ad9bc203ad2ba2f159d96dfaef62940262c7', frozen, false));
  assert(cppRefusalFor(fixture, 'subsequent', frozen, true));
  for (const historical of [frozen, 'published-0.17.1',
    '63f1ccd1b884594eac79149e4e8d60874628e3dc', 'a637ce6c297e5fc44b8799260dbb3acf1ed899da']) {
    assert(!cppRefusalFor(fixture, historical, frozen, true));
  }
});

test('CPP refusal rejects execution, wrong diagnostics, invented results and handles', () => {
  for (const [hook, mutate] of [
    ['compile', (sample) => { sample.reported.evaluation.status = 'completed'; }],
    ['compile', (sample) => { sample.reported.evaluation.compile.failure.message = 'Different message'; }],
    ['compile', (sample) => { sample.reported.evaluation.compile.diagnostics[0].code = 'compiler-error'; }],
    ['compile', (sample) => { sample.reported.evaluation.compile.diagnostics[0].column = 6; }],
    ['compile', (sample) => { sample.reported.evaluation.compile.stdout = 'learner output'; }],
    ['order', (sample) => { sample.reported.evaluation.cases.push({ caseId: 'A' }); }],
    ['correlation', (sample) => { sample.reported.executionId = 'unexpected handle'; }],
    ['compile-footprint', (sample) => { sample.tracedCompileProjection.trace.events.push({ line: 10 }); }],
    ['worker-ack', (sample) => { sample.worker.push({ action: 'command', type: 'execute-prepared-runtime-program-batch' }); }],
    ['worker-ack', (sample) => { sample.worker.push({ action: 'ordinary-start' }); }],
    ['receipt-publication', (sample) => { sample.journal.unshift({ ...mark('ordinary-write-attempt', 0), caseId: 'A' }); }],
  ]) {
    assert.equal(status(runFirst, observation, hook), 'pass', hook);
    const sample = structuredClone(observation);
    mutate(sample);
    assert.equal(status(runFirst, sample, hook), 'fail', hook);
  }
  assert.equal(status(runFirst, { ...observation, worker: undefined }, 'worker-ack'), undefined);
  assert.equal(status(runFirst, { ...observation, journal: undefined }, 'receipt-publication'), undefined);
  const skipped = { skip: 'initial-compile-failed', worker: [] };
  assert.equal(status(draw, skipped, 'skipped'), 'pass');
  assert.equal(status(draw, { ...skipped, worker: observation.worker }, 'skipped'), 'fail');
  assert.equal(status(draw, { ...skipped, reported: observation.reported }, 'skipped'), 'fail');
});

test('direct generated batch requires a typed top-level refusal and zero rows', () => {
  const batchResult = { results: [], diagnosticStage: 'compile', error: message, errorLine: 10, consoleOutput: [],
    diagnostic: { code: diagnostic.code, file: diagnostic.path, line: 10, column: 5 } };
  const worker = [{ action: 'command', type: 'compile-run-batch', id: 'batch' },
    { action: 'response', id: 'batch' }];
  const sample = { results: [], batchResult, worker };
  function directStatus(observed, hook) {
    const rows = [];
    checkCppDirect(fixture, 'generated-batch', observed, (row) => rows.push(row));
    return rows.find(({ id }) => id.endsWith('/@request/' + hook))?.status;
  }
  assert.equal(directStatus(sample, 'compile'), 'pass');
  assert.equal(directStatus(sample, 'worker-ack'), 'pass');
  assert.equal(directStatus({ results: [], worker }, 'compile'), undefined);
  const invented = { ...sample, results: [{}], batchResult: { ...batchResult, results: [{}] } };
  assert.equal(directStatus(invented, 'compile'), 'fail');
  assert.equal(directStatus(invented, 'cardinality'), 'fail');
  assert.equal(directStatus({ ...sample, batchResult: { ...batchResult, error: 'other' } }, 'compile'), 'fail');
});

test('CPP refusal differential checks every public and mux request', () => {
  const planned = [...requests.filter(({ mode }) => mode !== 'continuation'), ...muxRequests(fixture)];
  const evidence = planned.map(({ id, route }) => structuredClone({ ...observation, request: id, route }));
  const results = [];
  checkDifferential(fixture, evidence, (row) => results.push(row), true);
  assert.equal(results[0].status, 'pass');
  evidence.at(-1).reported.evaluation.compile.diagnostics[0].code = 'wrong';
  checkDifferential(fixture, evidence, (row) => results.push(row), true);
  assert.equal(results[1].status, 'fail');
  checkDifferential(fixture, evidence.slice(0, -1), (row) => results.push(row), true);
  assert.equal(results.length, 2);
});

test('C-CPP alone expects the exact macro refusal on the define line', () => {
  const macroFixture = manifest.fixtures.find(({ name }) => name === 'cpp-delete-macro');
  const rule = cppRefusalFor(macroFixture, cCppSubject, frozen, true);
  assert.equal(cppRefusalFor(macroFixture, cCppQualificationSubject, frozen, true), rule);
  assert.match(macroFixture.code.split('\n')[rule.line - 1], /^#define delete\s/);
  for (const historical of [frozen, 'published-0.17.1', cppStep7Subject]) {
    assert.equal(cppRefusalFor(macroFixture, historical, frozen, true), undefined);
  }
  const expected = { ...macroFixture, cppRefusal: rule };
  const compileFailure = structuredClone(observation);
  const { message, code, line, column } = rule;
  const expectedDiagnostic = { ...diagnostic, message, code, line, column };
  Object.assign(compileFailure.reported.evaluation.compile.failure, { message, line });
  compileFailure.reported.evaluation.compile.diagnostics = [expectedDiagnostic];
  compileFailure.compileProjection = { ...projection, diagnostic: expectedDiagnostic, error: message, errorLine: line };
  compileFailure.tracedCompileProjection = { ...observation.tracedCompileProjection, ...compileFailure.compileProjection };
  const checks = (sample) => {
    const statuses = {};
    checkObservation(expected, runFirst, sample, ({ id, status }) => { statuses[id.split('/').at(-1)] = status; }, true);
    return statuses;
  };
  assert.equal(checks(compileFailure).compile, 'pass');
  assert.equal(checks(compileFailure)['compile-footprint'], 'pass');
  for (const field of ['code', 'message', 'line', 'column', 'path']) {
    const mutant = structuredClone(compileFailure);
    mutant.reported.evaluation.compile.diagnostics[0][field] = 'other';
    assert.equal(checks(mutant).compile, 'fail', field);
  }
  for (const projectionRoute of ['ordinary-single', 'generated-batch']) {
    const { path, ...directDiagnostic } = expectedDiagnostic;
    const reply = { ...compileFailure.compileProjection, diagnostic: { ...directDiagnostic, file: path } };
    const directSample = projectionRoute === 'ordinary-single' ? { results: [reply, reply] }
      : { results: [], batchResult: { ...reply, results: [] } };
    function directCompile(observed) {
      const rows = [];
      checkCppDirect(expected, projectionRoute, observed, (row) => rows.push(row));
      return rows.find(({ id }) => id.endsWith('/@request/compile'))?.status;
    }
    assert.equal(directCompile(directSample), 'pass', projectionRoute);
    const mutant = structuredClone(directSample);
    (mutant.batchResult ?? mutant.results[0]).diagnostic.code = 'cpp-exceptions-unsupported';
    assert.equal(directCompile(mutant), 'fail', projectionRoute);
    if (projectionRoute === 'generated-batch') assert.equal(directCompile({ results: [] }), undefined);
  }
});

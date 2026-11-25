import assert from 'node:assert/strict';

export const cppStep7Subject = '9b30ad9bc203ad2ba2f159d96dfaef62940262c7';
export const cCppSubject = '39b2119a72d5afe003dbc6d66aba19633c15292f';
export const cCppQualificationSubject = '46943f54e42abcd5c008ac88261446a89a3fd270';
export const cCppSubjects = new Set([cCppSubject, cCppQualificationSubject]);

const exceptionRefusal = Object.freeze({
  message: 'C++ exceptions are not supported yet',
  code: 'cpp-exceptions-unsupported',
  line: 10,
  column: 5,
});
const macroOperationRefusal = Object.freeze({
  message: 'C++ operation names defined with #define are not supported yet. Write the method name directly.',
  code: 'cpp-macro-operation-unsupported',
  line: 3,
  column: 1,
});
const legacySubjects = new Set([
  '63f1ccd1b884594eac79149e4e8d60874628e3dc',
  'a637ce6c297e5fc44b8799260dbb3acf1ed899da',
]);

export function cppRefusalFor(fixture, subject, frozen, registeredCpp) {
  if (fixture.language !== 'cpp') return;
  if (fixture.gate === 'G6' && fixture.name === 'cpp-delete-macro' && cCppSubjects.has(subject)) {
    return macroOperationRefusal;
  }
  if (fixture.gate === 'G1' && fixture.name === 'print-then-throw' &&
      (subject === cppStep7Subject ||
        (registeredCpp && subject !== frozen && subject !== 'published-0.17.1' && !legacySubjects.has(subject)))) {
    return exceptionRefusal;
  }
}

function checkDiagnostic(diagnostic, refusal, pathKey = 'path') {
  assert.equal(diagnostic?.code, refusal.code);
  assert.equal(diagnostic[pathKey], 'solution.cpp');
  assert.equal(diagnostic.line, refusal.line);
  assert.equal(diagnostic.column, refusal.column);
}

export function checkCppCompileRefusal(compile, refusal) {
  assert.equal(compile.failure.message, refusal.message);
  assert.equal(compile.failure.line, refusal.line);
  const errors = compile.diagnostics.filter(({ severity }) => severity === 'error');
  assert.equal(errors.length, 1);
  const [diagnostic] = errors;
  assert.equal(diagnostic.source, 'cpp');
  assert.equal(diagnostic.message, refusal.message);
  checkDiagnostic(diagnostic, refusal);
}

export function checkCppRefusalProjection(result, refusal, pathKey = 'file') {
  assert.equal(result.diagnosticStage, 'compile');
  assert.equal(result.error, refusal.message);
  assert.equal(result.errorLine, refusal.line);
  assert.deepEqual(result.consoleOutput, []);
  for (const field of ['output', 'trace', 'attachment', 'executionId']) {
    assert(!Object.hasOwn(result, field), field);
  }
  checkDiagnostic(result.diagnostic, refusal, pathKey);
}

export function checkCppRefusalWorkerLog(worker, direct = false) {
  assert(!worker.some(({ action }) => action === 'ordinary-start'), 'Refusal started an ordinary case');
  assert(!worker.some(({ action, type }) => action === 'command' &&
    (/execute|^observe-/.test(type) || (!direct && /compile-run/.test(type)))), 'Refusal dispatched case execution');
}

import assert from 'node:assert/strict';

const message = 'C++ exceptions are not supported yet';
const code = 'cpp-exceptions-unsupported';
const legacySubjects = new Set([
  '63f1ccd1b884594eac79149e4e8d60874628e3dc',
  'a637ce6c297e5fc44b8799260dbb3acf1ed899da',
]);

export function cppExceptionRefusalApplies(fixture, subject, frozen, registeredCpp) {
  return fixture.gate === 'G1' && fixture.language === 'cpp' && fixture.name === 'print-then-throw' &&
    (subject === '9b30ad9bc203ad2ba2f159d96dfaef62940262c7' ||
      (registeredCpp && subject !== frozen && subject !== 'published-0.17.1' && !legacySubjects.has(subject)));
}

function checkDiagnostic(diagnostic, pathKey = 'path') {
  assert.equal(diagnostic?.code, code);
  assert.equal(diagnostic[pathKey], 'solution.cpp');
  assert.equal(diagnostic.line, 10);
  assert.equal(diagnostic.column, 5);
}

export function checkCppExceptionCompile(compile) {
  assert.equal(compile.failure.message, message);
  assert.equal(compile.failure.line, 10);
  const errors = compile.diagnostics.filter(({ severity }) => severity === 'error');
  assert.equal(errors.length, 1);
  const [diagnostic] = errors;
  assert.equal(diagnostic.source, 'cpp');
  assert.equal(diagnostic.message, message);
  checkDiagnostic(diagnostic);
}

export function checkCppExceptionProjection(result, pathKey = 'file') {
  assert.equal(result.diagnosticStage, 'compile');
  assert.equal(result.error, message);
  assert.equal(result.errorLine, 10);
  assert.deepEqual(result.consoleOutput, []);
  for (const field of ['output', 'trace', 'attachment']) assert(!Object.hasOwn(result, field), field);
  checkDiagnostic(result.diagnostic, pathKey);
}

export function checkCppRefusalWorkerLog(worker, direct = false) {
  assert(!worker.some(({ action }) => action === 'ordinary-start'), 'Refusal started an ordinary case');
  assert(!worker.some(({ action, type }) => action === 'command' &&
    (/execute|^observe-/.test(type) || (!direct && /compile-run/.test(type)))), 'Refusal dispatched case execution');
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { csharpCandidateOutcome } from './java-runner/csharp-candidate-witness.mjs';
import { csharpProductionControlOutcome } from
  './java-runner/csharp-production-control-witness.mjs';
import { isTrustedCsharpPrime } from './java-runner/csharp-replenishment-witness.mjs';

const CASE_COUNT = 10;

function options(version) {
  return {
    caseCount: CASE_COUNT,
    promotedExecutionType: version === '0.17.1'
      ? 'execute-prepared-trace' : 'execute-prepared-code',
    promotedPrepareRole: version === '0.17.1' ? 'observer' : 'ordinary',
    requireTrustedPromotionEvidence: true,
  };
}

function classify(row) {
  if (row.version === '0.17.1') {
    return csharpProductionControlOutcome(
      row.initial, row.trustedCsharpArtifactKey, options(row.version));
  }
  return csharpCandidateOutcome(
    row.initial, 'run', CASE_COUNT, row.initial.evaluation.cases[0].id,
    row.trustedCsharpArtifactKey, options(row.version));
}

function promotedShapes(row) {
  const phases = row.initial.csharp.phases;
  return phases.filter((phase) =>
    isTrustedCsharpPrime(phase, row.trustedCsharpArtifactKey)).map((prime) => ({
    prime,
    learner: phases.filter((phase) => phase.worker === prime.worker &&
      phase !== prime && !['init', 'warmup'].includes(phase.type)),
  })).filter(({ learner }) => learner.length > 0);
}

function rejectMutation(row, label, mutate) {
  const copy = structuredClone(row);
  mutate(copy, promotedShapes(copy));
  assert.equal(typeof classify(copy), 'string', `${row.version}: ${label} was accepted`);
}

function checkOrdinaryMutations(row) {
  const ordinary = (copy, shapes) => shapes.find(({ learner }) =>
    learner.some(({ role }) => role === 'ordinary'));
  rejectMutation(row, 'nine learner commands', (copy, shapes) => {
    const shape = ordinary(copy, shapes);
    copy.initial.csharp.phases.splice(copy.initial.csharp.phases.indexOf(shape.learner.at(-1)), 1);
  });
  rejectMutation(row, 'eleven learner commands', (copy, shapes) => {
    const shape = ordinary(copy, shapes);
    copy.initial.csharp.phases.push(structuredClone(shape.learner[0]));
  });
  rejectMutation(row, 'wrong learner role', (copy, shapes) => {
    ordinary(copy, shapes).learner[0].role = 'observer';
  });
  rejectMutation(row, 'mismatched prepare', (copy, shapes) => {
    const shape = ordinary(copy, shapes);
    const prepare = copy.initial.csharp.phases.find(({ type, artifactKey }) =>
      type === 'prepare-program' && artifactKey === shape.learner[0].artifactKey);
    prepare.artifactKey += '-mismatch';
  });
  rejectMutation(row, 'missing trusted prime', (copy, shapes) => {
    const shape = ordinary(copy, shapes);
    copy.initial.csharp.phases.splice(copy.initial.csharp.phases.indexOf(shape.prime), 1);
  });
  rejectMutation(row, 'other version execution type', (copy, shapes) => {
    const shape = ordinary(copy, shapes);
    const other = row.version === '0.17.1'
      ? 'execute-prepared-code' : 'execute-prepared-trace';
    shape.learner.forEach((phase) => { phase.type = other; });
  });
}

function checkObserverMutations(row) {
  const observer = (copy, shapes) => shapes.find(({ learner }) =>
    learner.length === 1 && learner[0].role === 'observer');
  rejectMutation(row, 'two observer commands', (copy, shapes) => {
    const shape = observer(copy, shapes);
    copy.initial.csharp.phases.push(structuredClone(shape.learner[0]));
  });
  rejectMutation(row, 'wrong observer role', (copy, shapes) => {
    observer(copy, shapes).learner[0].role = 'ordinary';
  });
  rejectMutation(row, 'mismatched observer prepare', (copy, shapes) => {
    const shape = observer(copy, shapes);
    const prepare = copy.initial.csharp.phases.find(({ type, artifactKey }) =>
      type === 'prepare-program' && artifactKey === shape.learner[0].artifactKey);
    prepare.artifactKey += '-mismatch';
  });
  rejectMutation(row, 'missing observer trusted prime', (copy, shapes) => {
    const shape = observer(copy, shapes);
    copy.initial.csharp.phases.splice(copy.initial.csharp.phases.indexOf(shape.prime), 1);
  });
  rejectMutation(row, 'observer uses ordinary execution type', (copy, shapes) => {
    observer(copy, shapes).learner[0].type = 'execute-prepared-code';
  });
}

export async function auditSavedCsharpLessonRows(samplesPath) {
  const rows = (await readFile(samplesPath, 'utf8')).trim().split('\n')
    .filter(Boolean).map(JSON.parse).filter(({ groupIndex }) => groupIndex === 16);
  const previouslyInvalid = rows.filter(({ invalid }) => invalid);
  const previouslyKept = rows.filter(({ kept }) => kept);
  assert.equal(previouslyInvalid.length, 6);
  assert.equal(previouslyKept.length, 25);
  for (const row of rows) assert.equal(classify(row), undefined,
    `${row.version} round ${row.round} did not pass the corrected witness`);

  const controlPromoted = previouslyInvalid.find(({ version }) => version === '0.17.1');
  const candidatePromoted = previouslyInvalid.find(({ version }) => version === 'candidate-main');
  assert.ok(controlPromoted && candidatePromoted);
  checkOrdinaryMutations(controlPromoted);
  checkOrdinaryMutations(candidatePromoted);
  checkObserverMutations(candidatePromoted);

  return {
    rows: rows.length,
    previouslyInvalidAccepted: previouslyInvalid.length,
    previouslyKeptUnchanged: previouslyKept.length,
    rejectedMutations: 17,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const samplesPath = process.argv[2];
  assert.ok(samplesPath,
    'Usage: audit-csharp-lesson-saved-rows.mjs <final-csharp-desktop-samples.jsonl>');
  console.log(JSON.stringify(await auditSavedCsharpLessonRows(samplesPath)));
}

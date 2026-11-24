import assert from 'node:assert/strict';
import { csharpWarmModes } from './csharp-warm-policy.mjs';
import { pythonWarmModes } from './python-warm-policy.mjs';

export const submitAaLabelPairs = Object.freeze({
  '0.17.1': Object.freeze(['0.17.1-a', '0.17.1-b']),
  '0.20.1': Object.freeze(['0.20.1-a', '0.20.1-b']),
});

export const submitAaVersions = Object.freeze(Object.values(submitAaLabelPairs).flat());

function group(language, problem, sourceVersion, mode) {
  return {
    language, cpu: 1, problem, state: 'warm', journey: 'submit', target: 20,
    versions: [...submitAaLabelPairs[sourceVersion]], continuation: false,
    ...(language === 'python' ? { pythonWarmMode: mode } : { csharpWarmMode: mode }),
    submitAaSourceVersion: sourceVersion,
  };
}

const groups = ['python', 'csharp'].flatMap((language) =>
  ['binary-search', 'permutations'].flatMap((problem) => [
    group(language, problem, '0.17.1',
      language === 'python' ? pythonWarmModes.fresh : csharpWarmModes.fresh),
    group(language, problem, '0.17.1',
      language === 'python' ? pythonWarmModes.submitAfterRun : csharpWarmModes.submitAfterRun),
    ...(language === 'python' ? [
      group(language, problem, '0.20.1', pythonWarmModes.fresh),
    ] : []),
  ]));

export const submitAaPlan = Object.freeze([
  ...groups.filter(({ language, problem, csharpWarmMode }) =>
    language === 'csharp' && problem === 'binary-search' &&
    csharpWarmMode === csharpWarmModes.submitAfterRun),
  ...groups.filter(({ language, problem, csharpWarmMode }) =>
    !(language === 'csharp' && problem === 'binary-search' &&
      csharpWarmMode === csharpWarmModes.submitAfterRun)),
]);

export function submitAaSourceVersion(label) {
  const match = Object.entries(submitAaLabelPairs).find(([, labels]) => labels.includes(label));
  assert.ok(match, `Unknown Submit A/A label: ${label}`);
  return match[0];
}

export function submitAaRoundOrder(versions, round) {
  assert.ok(Object.values(submitAaLabelPairs).some((labels) =>
    labels.length === versions.length && labels.every((label, index) => label === versions[index])));
  assert.ok(Number.isSafeInteger(round) && round > 0);
  return round % 2 === 1 ? versions : [...versions].reverse();
}

export function submitAaFailFast(groupIndex, sample) {
  return groupIndex === 0 && Boolean(sample.invalid || sample.refusal);
}

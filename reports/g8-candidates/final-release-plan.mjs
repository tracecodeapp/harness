import assert from 'node:assert/strict';

import {
  expandWarmRepeatGroups,
  pairRepeatGroups,
  prioritizeSubmitAfterRunPreflights,
} from './warm-repeat-policy.mjs';

export const finalReleaseLanguages = Object.freeze([
  'javascript', 'typescript', 'python', 'cpp', 'java', 'csharp',
]);
export const finalRuntimeLanguages = Object.freeze(
  finalReleaseLanguages.filter((language) => language !== 'python'));
export const finalRunPolicy = 'candidate-main';
export const finalSubmitPolicy = 'candidate-deploy';

const problems = Object.freeze(['binary-search', 'permutations']);

function candidateForJourney(journey) {
  return journey === 'submit' ? finalSubmitPolicy : finalRunPolicy;
}

function pair(language, cpu, problem, state, journey, continuation = false) {
  const candidate = candidateForJourney(journey);
  return {
    language,
    cpu,
    problem,
    state,
    journey,
    target: 20,
    versions: ['0.17.1', candidate],
    continuation,
    pairedControlFor: candidate,
  };
}

function desktopBase(language) {
  const groups = [];
  for (const state of ['warm', 'cold', 'switched']) {
    for (const journey of ['submit', 'run']) {
      for (const problem of problems) {
        groups.push(pair(language, 1, problem, state, journey, journey === 'run'));
      }
    }
  }
  groups.push(pair(language, 1, 'binary-search', 'warm', 'lesson'));
  return groups;
}

function phoneBase(language) {
  return ['warm', 'cold'].flatMap((state) => problems.map((problem) =>
    pair(language, 4, problem, state, 'run')));
}

export function finalReleasePlan(language, scope) {
  assert.ok(finalRuntimeLanguages.includes(language),
    `Unknown final-release runtime language: ${language}`);
  assert.ok(['desktop', 'phone'].includes(scope), `Unknown final-release scope: ${scope}`);
  const base = scope === 'desktop' ? desktopBase(language) : phoneBase(language);
  if (!['python', 'csharp'].includes(language)) return base;
  const expanded = pairRepeatGroups(
    expandWarmRepeatGroups(base, { submitAfterRun: true }),
    [finalRunPolicy, finalSubmitPolicy],
  );
  return prioritizeSubmitAfterRunPreflights(expanded, [language]);
}

export function finalReleaseCellId(group, metric) {
  return [group.language, group.cpu, group.problem, group.state, metric].join('/');
}

export function finalReleaseCandidate(group) {
  const expected = candidateForJourney(group.journey);
  assert.ok(group.versions.includes(expected));
  return expected;
}

import assert from 'node:assert/strict';
import { addCsharpFreshSubmitControl } from './csharp-warm-policy.mjs';
import { liveControlPairGroups, liveControlVersions } from './live-control.mjs';
import { pythonWarmModes } from './python-warm-policy.mjs';
import {
  expandWarmRepeatGroups,
  isSubmitAfterRunWarmMode,
  pairRepeatGroups,
} from './warm-repeat-policy.mjs';

const problems = Object.freeze(['binary-search', 'permutations']);
const spotLanguages = Object.freeze(['javascript', 'typescript', 'python', 'cpp', 'java']);

const actionCost = Object.freeze({
  csharp: { warmRun: 0.55, warmSubmit: 0.4, coldStart: 3.8 },
});

function expectedGroupSeconds(group) {
  const { warmRun, warmSubmit, coldStart } = actionCost.csharp;
  const action = group.journey === 'submit' ? warmSubmit : warmRun;
  const heavy = group.problem === 'permutations' ? 1.2 : 1;
  const setup = group.state === 'warm' ? 0 : coldStart + 0.4;
  const previousRun = group.state === 'switched' ? warmRun : 0;
  return group.target * group.versions.length * (action * heavy + setup + previousRun);
}

function desktopBase(candidateVersions) {
  const versions = liveControlVersions(candidateVersions);
  const groups = [];
  for (const state of ['warm', 'cold', 'switched']) {
    for (const journey of ['submit', 'run']) {
      for (const problem of problems) {
        groups.push({
          language: 'csharp', cpu: 1, problem, state, journey, target: 20, versions,
          continuation: journey === 'run',
        });
      }
    }
    if (state === 'warm') {
      groups.push({
        language: 'csharp', cpu: 1, problem: 'binary-search', state,
        journey: 'lesson', target: 20,
        versions: liveControlVersions([candidateVersions[0]]),
      });
    }
  }
  return groups;
}

function phoneBase(candidateVersions) {
  const groups = ['warm', 'cold'].flatMap((state) => problems.map((problem) => ({
    language: 'csharp', cpu: 4, problem, state, journey: 'run', target: 20,
    versions: liveControlVersions(candidateVersions), continuation: false,
  })));
  return liveControlPairGroups(groups, candidateVersions);
}

function spotBase(candidateVersions) {
  const groups = spotLanguages.map((language) => ({
    language, cpu: 1, problem: 'binary-search', state: 'warm', journey: 'run',
    target: 20, versions: liveControlVersions(candidateVersions), continuation: false,
  }));
  return liveControlPairGroups(groups, candidateVersions).map((group) =>
    group.language === 'python'
      ? { ...group, pythonWarmMode: pythonWarmModes.fresh }
      : group);
}

export function csharpMeasurementPlan(scope,
  candidateVersions = ['candidate-main', 'candidate-deploy']) {
  assert.ok(['desktop', 'phone', 'spot'].includes(scope));
  assert.deepEqual(candidateVersions, ['candidate-main', 'candidate-deploy']);
  if (scope === 'spot') return spotBase(candidateVersions);
  const base = scope === 'desktop' ? desktopBase(candidateVersions) : phoneBase(candidateVersions);
  const expanded = pairRepeatGroups(
    expandWarmRepeatGroups(base, { submitAfterRun: true }), candidateVersions);
  const controlled = addCsharpFreshSubmitControl(expanded, scope === 'desktop');
  return controlled.sort((a, b) =>
    Number(isSubmitAfterRunWarmMode(b) && b.problem === 'binary-search') -
      Number(isSubmitAfterRunWarmMode(a) && a.problem === 'binary-search') ||
    expectedGroupSeconds(a) - expectedGroupSeconds(b));
}

import {
  csharpWarmAttemptPlan,
  csharpWarmMetricName,
  csharpWarmModes,
  expandCsharpWarmGroups,
  openIsolatedCsharpWarmAttempt,
} from './csharp-warm-policy.mjs';
import {
  expandPythonWarmGroups,
  openIsolatedPythonWarmAttempt,
  pythonWarmAttemptPlan,
  pythonWarmMetricName,
  pythonWarmModes,
} from './python-warm-policy.mjs';

export const repeatPenaltyLanguages = Object.freeze(['python', 'csharp']);

export function expandWarmRepeatGroups(groups, options) {
  return expandCsharpWarmGroups(expandPythonWarmGroups(groups, options), options);
}

export function warmAttemptPlan(group) {
  if (group.language === 'python') return pythonWarmAttemptPlan(group);
  if (group.language === 'csharp') return csharpWarmAttemptPlan(group);
  return { freshPage: false, primeJourney: undefined };
}

export function warmMetricName(group, endpoint) {
  if (group.language === 'python') return pythonWarmMetricName(group, endpoint);
  if (group.language === 'csharp') return csharpWarmMetricName(group, endpoint);
  return endpoint;
}

export function warmMode(group) {
  return group.language === 'python' ? group.pythonWarmMode :
    group.language === 'csharp' ? group.csharpWarmMode : undefined;
}

export function isFreshWarmMode(group) {
  return warmMode(group) === (group.language === 'python'
    ? pythonWarmModes.fresh : csharpWarmModes.fresh);
}

export function isRepeatWarmMode(group) {
  const mode = warmMode(group);
  return mode === pythonWarmModes.repeatRun || mode === pythonWarmModes.submitAfterRun ||
    mode === csharpWarmModes.repeatRun || mode === csharpWarmModes.submitAfterRun;
}

export async function openIsolatedWarmAttempt(group, operations) {
  if (group.language === 'python') return openIsolatedPythonWarmAttempt(group, operations);
  if (group.language === 'csharp') return openIsolatedCsharpWarmAttempt(group, operations);
  throw new Error('No isolated warm policy for ' + group.language);
}

export function pairRepeatGroups(groups, candidateVersions) {
  return groups.flatMap((group) => {
    if (!isRepeatWarmMode(group) || group.pairedControlFor !== undefined) return [group];
    const candidates = group.versions.filter((version) => candidateVersions.includes(version));
    if (candidates.length === 0) return [group];
    return candidates.map((policy) => ({
      ...group,
      versions: ['0.17.1', policy],
      pairedControlFor: policy,
    }));
  });
}

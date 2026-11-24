export function scoreThresholds(scope, requiredHistory) {
  return {
    median: (scope === 'spot' ? 1.05 : 1) * Math.min(...requiredHistory.map((row) => row.median)),
    p90: 1.10 * Math.min(...requiredHistory.map((row) => row.p90)),
  };
}

export function medianRegressionClass(candidateMedian, controlMedian) {
  const ratio = candidateMedian / controlMedian;
  if (ratio > 1.10) return { classification: 'fix-forward', ratio };
  if (ratio > 1.05) return { classification: 'record', ratio };
  return { classification: 'within-five-percent', ratio };
}

export function expectedLiveControlMetadata(primary, scope, candidateVersions,
  { pairedCandidateControls = false, pairedRepeatControls = false } = {}) {
  return {
    control: '0.17.1',
    candidateVersions,
    alternatingOrderPerRound: true,
    ...(pairedCandidateControls && { pairedCandidateControls: true }),
    ...(pairedRepeatControls && { pairedRepeatControls: true }),
    ...(primary === 'python' && scope === 'desktop' && {
      pythonWarmSubmitControl: '0.20.1',
    }),
  };
}

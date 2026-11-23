export function scoreThresholds(scope, requiredHistory) {
  return {
    median: (scope === 'spot' ? 1.05 : 1) * Math.min(...requiredHistory.map((row) => row.median)),
    p90: 1.10 * Math.min(...requiredHistory.map((row) => row.p90)),
  };
}

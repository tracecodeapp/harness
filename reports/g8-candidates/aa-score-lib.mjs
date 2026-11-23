export function stats(values = []) {
  const ordered = [...values].sort((a, b) => a - b);
  const n = ordered.length;
  return n ? {
    n,
    median: (ordered[Math.floor((n - 1) / 2)] + ordered[Math.floor(n / 2)]) / 2,
    p90: ordered[Math.ceil(0.9 * n) - 1],
  } : { n };
}

export function metricEndpoints(group) {
  if (group.journey === 'run') {
    return ['verdicts', 'firstTrace', ...(group.continuation ? ['secondTrace'] : [])];
  }
  return [group.journey === 'lesson' ? 'lessonContinue' : 'submitVerdicts'];
}

export function relative(observed, reference) {
  if (!observed.n || !reference.n) return undefined;
  return {
    medianPct: (observed.median / reference.median - 1) * 100,
    p90Pct: (observed.p90 / reference.p90 - 1) * 100,
  };
}

function warmMode(group) {
  return group.pythonWarmMode ?? group.csharpWarmMode ?? 'standard';
}

export function measurementShapeKey(scope, group, version) {
  return [
    group.language,
    scope,
    String(group.cpu),
    group.problem,
    group.state,
    group.journey,
    group.continuation ? 'continuation' : 'single',
    warmMode(group),
    group.pairedControlFor ?? 'unpaired',
    version,
  ].join('|');
}

export function createUncapturedShapeGuard(scope, capturedShapeKeys = []) {
  const captured = new Set(capturedShapeKeys);
  return {
    captured,
    observe(group, version, sample) {
      const key = measurementShapeKey(scope, group, version);
      if (sample.invalid || sample.refusal) {
        return { key, action: captured.has(key) ? 'known-reject' : 'fail-fast' };
      }
      if (sample.kept) {
        captured.add(key);
        return { key, action: 'captured' };
      }
      return { key, action: 'wait' };
    },
  };
}

export function selectShapeProbeSchedule(scope, schedule, probeKeys) {
  const selected = new Set(probeKeys);
  const matched = new Set();
  const groups = schedule.flatMap((group) => {
    const versions = group.versions.filter((version) => {
      const key = measurementShapeKey(scope, group, version);
      if (!selected.has(key)) return false;
      matched.add(key);
      return true;
    });
    return versions.length === 0 ? [] : [{ ...group, versions, target: 1 }];
  });
  const missing = [...selected].filter((key) => !matched.has(key));
  if (missing.length > 0) {
    throw new Error('Shape probe keys are absent from this schedule: ' + missing.join(', '));
  }
  return groups;
}

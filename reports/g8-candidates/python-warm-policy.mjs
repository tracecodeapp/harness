import assert from 'node:assert/strict';

export const pythonWarmModes = Object.freeze({
  fresh: 'fresh-page',
  repeatRun: 'repeat-run',
  submitAfterRun: 'submit-after-run',
});

export function pythonWarmAttemptPlan(group) {
  const mode = group.pythonWarmMode;
  if (mode === undefined) return { freshPage: false, primeJourney: undefined };
  assert.equal(group.language, 'python');
  assert.equal(group.state, 'warm');
  assert.ok(Object.values(pythonWarmModes).includes(mode));
  if (mode === pythonWarmModes.repeatRun) assert.equal(group.journey, 'run');
  if (mode === pythonWarmModes.submitAfterRun) assert.equal(group.journey, 'submit');
  return {
    freshPage: true,
    primeJourney: mode === pythonWarmModes.fresh ? undefined : 'run',
  };
}

export function expandPythonWarmGroups(groups, { submitAfterRun = false } = {}) {
  return groups.flatMap((group) => {
    if (group.language !== 'python' || group.state !== 'warm' ||
        !['run', 'submit'].includes(group.journey)) return [group];
    const fresh = { ...group, pythonWarmMode: pythonWarmModes.fresh };
    if (group.journey === 'run') return [
      fresh,
      { ...group, pythonWarmMode: pythonWarmModes.repeatRun },
    ];
    if (!submitAfterRun) return [fresh];
    // The owner's 0.20.1 better-of exception belongs only to the stable fresh
    // warm Submit cell. The explicit learner repeat is compared side by side
    // with 0.17.1, so a secondary control must not join that rotation.
    const repeatVersions = group.versions?.filter((version) => version !== '0.20.1');
    return [
      fresh,
      {
        ...group,
        ...(repeatVersions ? { versions: repeatVersions } : {}),
        pythonWarmMode: pythonWarmModes.submitAfterRun,
      },
    ];
  });
}

export function pythonWarmMetricName(group, endpoint) {
  if (group.pythonWarmMode === pythonWarmModes.repeatRun) return 'repeat' + endpoint[0].toUpperCase() + endpoint.slice(1);
  if (group.pythonWarmMode === pythonWarmModes.submitAfterRun) {
    assert.equal(endpoint, 'submitVerdicts');
    return 'submitAfterRunVerdicts';
  }
  return endpoint;
}

// This helper owns the isolation invariant so both runners exercise the same
// code path. A warm attempt opens one page, warms it outside the measurement,
// optionally performs exactly one Run primer, performs one measured action,
// and closes the page before another label can run.
export async function openIsolatedPythonWarmAttempt(group, operations) {
  const plan = pythonWarmAttemptPlan(group);
  assert.equal(plan.freshPage, true);
  const page = await operations.open();
  let prime;
  try {
    await operations.warm(page);
    prime = plan.primeJourney ? await operations.prime(page, plan.primeJourney) : undefined;
  } catch (error) {
    await operations.close(page);
    throw error;
  }
  let closed = false;
  return {
    page,
    prime,
    async close() {
      assert.equal(closed, false, 'Each isolated warm page closes exactly once');
      closed = true;
      await operations.close(page);
    },
  };
}

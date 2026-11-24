import assert from 'node:assert/strict';

export const csharpWarmModes = Object.freeze({
  fresh: 'fresh-page',
  repeatRun: 'repeat-run',
  submitAfterRun: 'submit-after-run',
});

export function csharpWarmAttemptPlan(group) {
  const mode = group.csharpWarmMode;
  if (mode === undefined) return { freshPage: false, primeJourney: undefined };
  assert.equal(group.language, 'csharp');
  assert.equal(group.state, 'warm');
  assert.ok(Object.values(csharpWarmModes).includes(mode));
  if (mode === csharpWarmModes.repeatRun) assert.equal(group.journey, 'run');
  if (mode === csharpWarmModes.submitAfterRun) assert.equal(group.journey, 'submit');
  return {
    freshPage: true,
    primeJourney: mode === csharpWarmModes.fresh ? undefined : 'run',
  };
}

export function expandCsharpWarmGroups(groups, { submitAfterRun = false } = {}) {
  return groups.flatMap((group) => {
    if (group.language !== 'csharp' || group.state !== 'warm' ||
        !['run', 'submit'].includes(group.journey)) return [group];
    const fresh = { ...group, csharpWarmMode: csharpWarmModes.fresh };
    if (group.journey === 'run') return [
      fresh,
      { ...group, csharpWarmMode: csharpWarmModes.repeatRun },
    ];
    if (!submitAfterRun) return [fresh];
    return [
      fresh,
      { ...group, csharpWarmMode: csharpWarmModes.submitAfterRun },
    ];
  });
}

export function csharpWarmMetricName(group, endpoint) {
  if (group.csharpWarmMode === csharpWarmModes.repeatRun) {
    return 'repeat' + endpoint[0].toUpperCase() + endpoint.slice(1);
  }
  if (group.csharpWarmMode === csharpWarmModes.submitAfterRun) {
    assert.equal(endpoint, 'submitVerdicts');
    return 'submitAfterRunVerdicts';
  }
  return endpoint;
}

export async function openIsolatedCsharpWarmAttempt(group, operations) {
  const plan = csharpWarmAttemptPlan(group);
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

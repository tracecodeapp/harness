import assert from 'node:assert/strict';

import { measurementShapeKey } from './measurement-shapes.mjs';

const labels = Object.freeze({
  e1: Object.freeze({ 'concurrent-e1': 'concurrent' }),
  e2: Object.freeze({
    'sequential-f1': 'sequential',
    'sequential-f1-d1': 'sequential',
  }),
  ed1: Object.freeze({
    'concurrent-base': 'concurrent',
    'concurrent-f1-d1': 'concurrent',
  }),
});

function group(problem, state, pythonWarmMode, versions, target, continuation = false,
  { cpu = 4, pairedControlFor } = {}) {
  return Object.freeze({
    language: 'python',
    cpu,
    problem,
    state,
    journey: 'run',
    target,
    versions: Object.freeze([...versions]),
    continuation,
    ...(pythonWarmMode === 'standard' ? {} : { pythonWarmMode }),
    ...(pythonWarmMode === 'repeat-run' && pairedControlFor ? { pairedControlFor } : {}),
  });
}
const plans = Object.freeze({
  e1: Object.freeze({
    name: 'e1',
    scope: 'phone',
    candidates: Object.freeze(['concurrent-e1']),
    collectReceiptSnapshotMs: true,
    groups: Object.freeze([
      group('permutations', 'warm', 'fresh-page', ['0.17.1', 'concurrent-e1'], 10),
    ]),
  }),
  e2: Object.freeze({
    name: 'e2',
    scope: 'phone',
    candidates: Object.freeze(['sequential', 'sequential-f1', 'sequential-f1-d1']),
    collectReceiptSnapshotMs: false,
    groups: Object.freeze([
      group('permutations', 'warm', 'repeat-run',
        ['0.17.1', 'sequential', 'sequential-f1', 'sequential-f1-d1'], 20, false,
        { pairedControlFor: 'sequential' }),
      group('permutations', 'warm', 'fresh-page',
        ['0.17.1', 'sequential', 'sequential-f1', 'sequential-f1-d1'], 20),
      group('permutations', 'cold', 'standard',
        ['0.17.1', 'sequential', 'sequential-f1', 'sequential-f1-d1'], 20),
      group('binary-search', 'warm', 'fresh-page',
        ['0.17.1', 'sequential', 'sequential-f1', 'sequential-f1-d1'], 20),
    ]),
  }),
  ed1: Object.freeze({
    name: 'ed1',
    scope: 'desktop',
    candidates: Object.freeze(['concurrent-base', 'concurrent-f1-d1']),
    collectReceiptSnapshotMs: false,
    groups: Object.freeze([
      group('binary-search', 'warm', 'repeat-run',
        ['0.17.1', 'concurrent-base', 'concurrent-f1-d1'], 10, true,
        { cpu: 1, pairedControlFor: 'concurrent' }),
      group('permutations', 'warm', 'repeat-run',
        ['0.17.1', 'concurrent-base', 'concurrent-f1-d1'], 10, true,
        { cpu: 1, pairedControlFor: 'concurrent' }),
    ]),
  }),
});

export function pythonExperimentPlan(name) {
  if (name === undefined) return undefined;
  const plan = plans[name];
  assert.ok(plan, `Unknown Python speed experiment: ${name}`);
  return plan;
}

export function pythonExperimentWitnessVersion(plan, version) {
  return plan ? (labels[plan.name]?.[version] ?? version) : version;
}

export function pythonExperimentShapeInventory(plan, capturedShapeKeys) {
  const captured = new Set(capturedShapeKeys);
  return plan.groups.flatMap((entry) => entry.versions.map((version) => {
    const witnessVersion = pythonExperimentWitnessVersion(plan, version);
    const witnessKey = measurementShapeKey(plan.scope, entry, witnessVersion);
    return Object.freeze({
      experiment: plan.name,
      key: measurementShapeKey(plan.scope, entry, version),
      witnessKey,
      version,
      witnessVersion,
      captured: captured.has(witnessKey),
    });
  }));
}

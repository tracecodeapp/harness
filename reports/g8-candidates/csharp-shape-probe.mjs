import assert from 'node:assert/strict';
import { csharpMeasurementPlan } from './csharp-measurement-plan.mjs';
import { measurementShapeKey } from './measurement-shapes.mjs';

const scope = process.argv[2];
assert.ok(['desktop', 'phone', 'spot'].includes(scope));
const keys = csharpMeasurementPlan(scope).flatMap((group) =>
  group.versions.map((version) => measurementShapeKey(scope, group, version)));
assert.equal(keys.length, new Set(keys).size);
process.stdout.write(JSON.stringify(keys, null, 2) + '\n');

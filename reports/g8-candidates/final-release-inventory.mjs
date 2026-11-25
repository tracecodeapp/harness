import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { finalReleaseLanguages, finalReleasePlan } from './final-release-plan.mjs';
import { measurementShapeKey } from './measurement-shapes.mjs';
import { pythonExperimentPlan, pythonExperimentShapeInventory } from './python-experiment-plan.mjs';
import { capturedShapeKeys } from './shape-captures.mjs';
import { javaCapturedShapeKeys } from './java-shape-captures.mjs';

const captured = new Set(capturedShapeKeys);
const javaCaptured = new Set(javaCapturedShapeKeys);

function witnessGroup(scope, group) {
  if (scope === 'phone' || group.csharpWarmMode === 'repeat-run' ||
      group.csharpWarmMode === 'submit-after-run') return group;
  return { ...group, pairedControlFor: undefined };
}

export function finalReleaseShapeInventory() {
  const rows = [];
  for (const language of finalReleaseLanguages) {
    for (const scope of ['phone', 'desktop']) {
      if (language === 'python') {
        const plan = pythonExperimentPlan(`final-${scope}`);
        for (const row of pythonExperimentShapeInventory(plan, capturedShapeKeys)) {
          rows.push({ language, scope, witnessRequired: true, ...row });
        }
        continue;
      }
      for (const group of finalReleasePlan(language, scope)) {
        for (const version of group.versions) {
          const key = measurementShapeKey(scope, group, version);
          const witnessKey = measurementShapeKey(scope, witnessGroup(scope, group), version);
          const witnessRequired = ['java', 'csharp'].includes(language);
          const receipts = language === 'java' ? javaCaptured : captured;
          rows.push({ language, scope, key, witnessKey, version,
            witnessRequired, captured: !witnessRequired || receipts.has(witnessKey) });
        }
      }
    }
  }
  return rows;
}

const [outArg] = process.argv.slice(2);
if (outArg) {
  const rows = finalReleaseShapeInventory();
  const missing = rows.filter((row) => row.witnessRequired && !row.captured);
  const report = {
    schema: 'tracecode.g8-final-shape-inventory.v1',
    rows: rows.length,
    witnessed: rows.filter((row) => row.witnessRequired).length,
    captured: rows.filter((row) => row.witnessRequired && row.captured).length,
    missing,
    shapes: rows,
  };
  await writeFile(resolve(outArg), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ rows: report.rows, witnessed: report.witnessed,
    captured: report.captured, missing: missing.length }));
}

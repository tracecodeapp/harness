import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { finalReleasePlan } from './final-release-plan.mjs';
import { measurementShapeKey } from './measurement-shapes.mjs';
import { phoneWarmAaPlan } from './phone-warm-aa.mjs';

const [inventoryArg, outputArg] = process.argv.slice(2);
assert.ok(inventoryArg && outputArg,
  'Usage: final-release-remainder-preflight-plan.mjs <inventory> <output>');
const inventory = JSON.parse(await readFile(resolve(inventoryArg), 'utf8'));
const output = resolve(outputArg);

const aaKeys = phoneWarmAaPlan.flatMap((group) => group.versions.map((version) =>
  measurementShapeKey('phone', group, version)));
assert.equal(aaKeys.length, 16);
await writeFile(join(output, 'phone-warm-aa.json'), JSON.stringify(aaKeys, null, 2) + '\n');

const lesson = finalReleasePlan('csharp', 'desktop')[16];
assert.equal(lesson.journey, 'lesson');
const lessonKeys = lesson.versions.map((version) => measurementShapeKey('desktop', lesson, version));
await writeFile(join(output, 'csharp-desktop.json'),
  JSON.stringify(lessonKeys, null, 2) + '\n');

let remainingAttempts = lessonKeys.length;
for (const language of ['java', 'cpp', 'typescript', 'javascript']) {
  for (const scope of ['phone', 'desktop']) {
    const keys = inventory.shapes.filter((row) =>
      row.language === language && row.scope === scope).map(({ key }) => key);
    assert.ok(keys.length > 0);
    remainingAttempts += keys.length;
    await writeFile(join(output, `${language}-${scope}.json`),
      JSON.stringify(keys, null, 2) + '\n');
  }
}
assert.equal(remainingAttempts, 138);
console.log(JSON.stringify({ aaAttempts: aaKeys.length, remainingAttempts,
  totalAttempts: aaKeys.length + remainingAttempts }));

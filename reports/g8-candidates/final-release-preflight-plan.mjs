import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [inventoryArg, outputArg] = process.argv.slice(2);
assert.ok(inventoryArg && outputArg,
  'Usage: final-release-preflight-plan.mjs <shape inventory> <output directory>');
const inventory = JSON.parse(await readFile(resolve(inventoryArg), 'utf8'));
const output = resolve(outputArg);
await mkdir(output, { recursive: false });
let attempts = 24; // Python final-phone and final-desktop capture plans.
for (const language of ['javascript', 'typescript', 'cpp', 'java', 'csharp']) {
  for (const scope of ['phone', 'desktop']) {
    const keys = inventory.shapes
      .filter((row) => row.language === language && row.scope === scope)
      .map((row) => row.key);
    assert.ok(keys.length > 0);
    assert.equal(new Set(keys).size, keys.length);
    attempts += keys.length;
    await writeFile(join(output, `${language}-${scope}.json`),
      JSON.stringify(keys, null, 2) + '\n');
  }
}
assert.equal(attempts, 206);
console.log(JSON.stringify({ groups: 103, versionAttempts: attempts }));

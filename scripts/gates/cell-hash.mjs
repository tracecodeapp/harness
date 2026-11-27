import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { blobs, loadCell, resolveCommit, tracksInput } from './inventory.mjs';

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function hashCell(cell, commit, hostPins, gateCommit) {
  const files = blobs(commit).filter(([path]) => tracksInput(cell, path));
  files.sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const inputs = { files, cell, gateCommit, hostPins };
  return createHash('sha256').update(canonical(inputs)).digest('hex');
}

function main() {
  const { values, positionals } = parseArgs({
    options: { rev: { type: 'string', default: 'HEAD' }, 'host-pins': { type: 'string' } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new Error('Usage: node scripts/gates/cell-hash.mjs <cell> [--rev <commit>] [--host-pins <file>]');
  }
  const commit = resolveCommit(values.rev);
  const cell = loadCell(commit, positionals[0]);
  const gateCommit = cell.pins.gateRef ? resolveCommit(cell.pins.gateRef) : undefined;
  const hostPins = values['host-pins'] && JSON.parse(readFileSync(values['host-pins'], 'utf8'));
  if (hostPins === undefined) console.error('Tree-only hash. Use run-cell.sh for the cache lookup key.');
  console.log(hashCell(cell, commit, hostPins, gateCommit));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { git, loadInventory, matchesInput, resolveCommit, tracksInput } from './inventory.mjs';
import { canonical, packageAt, packageInputs } from './package-inputs.mjs';

function excluded(path, noCell) {
  let skip = false;
  for (const glob of noCell) {
    const include = glob.startsWith('!');
    if (matchesInput(path, include ? glob.slice(1) : glob)) skip = !include;
  }
  return skip;
}

export function selectCells({ cells, noCell, noCellByRevision = [noCell] }, paths, packageChange) {
  const selected = new Set();
  for (const path of paths) {
    if (path === 'package.json') {
      if (!packageChange) throw new Error('Compare both root manifests to select cells for a package.json change.');
      const { before, after } = packageChange;
      for (const cell of cells) {
        if (canonical(packageInputs(cell, before)) !== canonical(packageInputs(cell, after))) {
          selected.add(cell.id);
        }
      }
      continue;
    }
    const owners = cells.filter((cell) => tracksInput(cell, path));
    if (owners.length) owners.forEach((cell) => selected.add(cell.id));
    else if (!noCellByRevision.every((rules) => excluded(path, rules))) {
      return [...new Set(cells.map(({ id }) => id))].sort();
    }
  }
  return [...selected].sort();
}

function inventoriesAt(base, head) {
  const inventories = [...new Set([head, base])].flatMap((rev) =>
    git('ls-tree', '--full-tree', rev, '--', 'scripts/gates/cells.json') ? [loadInventory(rev)] : []);
  if (!inventories.length) throw new Error('Neither --head nor --base contains scripts/gates/cells.json.');
  return {
    cells: inventories.flatMap(({ cells }) => cells),
    noCellByRevision: inventories.map(({ noCell }) => noCell),
  };
}

function main() {
  const { values } = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' } } });
  if (!values.base || !values.head) throw new Error('Usage: node scripts/gates/select.mjs --base <rev> --head <rev>');
  const base = resolveCommit(values.base);
  const head = resolveCommit(values.head);
  const paths = git('diff', '--name-only', '--no-renames', '--no-relative', '-z', base, head, '--')
    .split('\0').filter(Boolean);
  const packageChange = paths.includes('package.json') ? { before: packageAt(base), after: packageAt(head) } : undefined;
  const ids = selectCells(inventoriesAt(base, head), paths, packageChange);
  if (ids.length) console.log(ids.join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

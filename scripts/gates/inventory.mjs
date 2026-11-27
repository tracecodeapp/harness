import { execFileSync } from 'node:child_process';

export const sharedGlobs = [
  'src/**', 'packages/tracekernel/**', 'packages/runtime-contracts/**',
  'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig*', 'tsup*',
  '.nvmrc', '.npmrc', '.gitattributes',
];

export function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

export function resolveCommit(rev) {
  return git('rev-parse', '--verify', '--end-of-options', rev + '^{commit}').trim();
}

export function loadInventory(commit) {
  const inventory = JSON.parse(git('show', commit + ':scripts/gates/cells.json'));
  return Array.isArray(inventory) ? { cells: inventory, noCell: [] } : inventory;
}

export function loadCell(commit, id) {
  const cell = loadInventory(commit).cells.find((entry) => entry.id === id);
  if (!cell) throw new Error(`Unknown gate cell ${id}. See scripts/gates/cells.json at ${commit}.`);
  return cell;
}

const patterns = new Map();
export function matchesInput(path, glob) {
  if (!glob.includes('*')) return path === glob;
  if (!patterns.has(glob)) {
    // Inventory globs use * within a path segment and ** for whole directories.
    // Match tracked dotfiles as well as ordinary paths.
    const pattern = glob.replace(/[.*+?^${}()|[\]\\]/g, (char) => char === '*' ? char : '\\' + char)
      .replace(/\*\*\/|\*\*|\*/g, (part) =>
        ({ '**/': '(?:[^/]+/)*', '**': '.*', '*': '[^/]*' })[part]);
    patterns.set(glob, new RegExp('^' + pattern + '$'));
  }
  return patterns.get(glob).test(path);
}

export function tracksInput(cell, path) {
  // The root manifest is a projected input even when an old cell lists it as a blob.
  if (path === 'package.json') return false;
  return sharedGlobs.some((glob) => matchesInput(path, glob)) ||
    cell.inputs.some((glob) => matchesInput(path, glob));
}

export function blobs(commit) {
  return git('ls-tree', '-rz', '--full-tree', commit).split('\0').filter(Boolean)
    .flatMap((line) => {
      const tab = line.indexOf('\t');
      const [mode, type, id] = line.slice(0, tab).split(' ');
      return type === 'blob' ? [[line.slice(tab + 1), mode, id]] : [];
    });
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { test } from 'node:test';
import { blobs, git, matchesInput, resolveCommit, tracksInput } from '../../scripts/gates/inventory.mjs';

const manifests = new Map();
function scriptsAt(dir) {
  if (!manifests.has(dir)) {
    manifests.set(dir, JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts);
  }
  return manifests.get(dir);
}

function commandFiles(command, dir = '', seen = new Set()) {
  const files = [];
  const paths = /(?:^|[\s'"=])([\w.*-]+(?:\/[\w.*-]+)*\.(?:mjs|mts|tsx?|sh|py|js|json|csproj))(?=$|[\s'";])/g;
  for (const [, path] of command.matchAll(paths)) files.push(join(dir, path));
  const pnpmScripts = /\bpnpm (?:--dir ([\w/-]+) )?(?:run )?([\w:-]+)/g;
  for (const [, directory, script] of command.matchAll(pnpmScripts)) {
    const parent = directory ? join(dir, directory) : dir;
    const key = parent + ':' + script;
    const body = scriptsAt(parent)[script];
    if (!body || seen.has(key)) continue;
    seen.add(key);
    files.push(...commandFiles(body, parent, seen));
  }
  return files;
}

function runtimeImports(entry, source, files, language) {
  const specifiers = /\b(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)['"]([^'"]+)['"]/g;
  return [...source.matchAll(specifiers)].flatMap(([, specifier]) => {
    const base = specifier.startsWith('.') ? posix.join(posix.dirname(entry), specifier) :
      specifier.replace(/^@tracecode\/runtime-/, 'packages/runtime-');
    const owner = /^(?:packages\/runtime-|workers\/)(python|javascript|typescript|csharp|java|cpp)(?:-native)?(?:\/|$)/.exec(base)?.[1];
    if (!owner || owner === language || language === 'shared') return [];
    const candidates = [base, ...['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.json'].map((ext) => base + ext),
      ...['index.ts', 'index.js', 'index.mjs', 'package.json'].map((file) => posix.join(base, file))];
    const matches = candidates.filter((path) => files.has(path));
    return matches.length ? matches : [base];
  });
}

test('inventory claims named command files and reports unclaimed tracked paths', () => {
  const inventory = JSON.parse(readFileSync('scripts/gates/cells.json', 'utf8'));
  const paths = git('ls-files', '-z').split('\0').filter(Boolean);
  const branches = new Map();
  const imports = new Map();
  const errors = [];
  const ids = new Set();
  const coveredScripts = new Set();
  const hostNames = new Set(['ci', 'agentrunner', 'laptop-unit']);
  const languages = new Set(['python', 'javascript', 'typescript', 'csharp', 'java', 'cpp', 'shared']);
  for (const cell of inventory) {
    assert.match(cell.id, /^[a-z0-9-]+$/);
    assert(!ids.has(cell.id), `Duplicate cell ${cell.id}`);
    ids.add(cell.id);
    assert(hostNames.has(cell.host), `Unknown host for ${cell.id}`);
    assert(languages.has(cell.language), `Unknown language for ${cell.id}`);
    assert(cell.inputs.includes('scripts/gates/**'));
    assert(cell.inputs.includes('scripts/run-test-suite.ts'));
    for (const pin of cell.pins.files) assert(paths.some((path) =>
      matchesInput(path, pin) && tracksInput(cell, path)), `${cell.id} has no input for pin ${pin}`);
    const ref = cell.pins.gateRef;
    if (ref && !branches.has(ref)) {
      const head = resolveCommit(ref);
      branches.set(ref, { head, paths: new Set(blobs(head).map(([path]) => path)) });
    }
    const branch = branches.get(ref);
    const files = new Set([...paths, ...(branch?.paths ?? [])]);
    const namedFiles = commandFiles([cell.setup, cell.command].filter(Boolean).join(' && '));
    for (const named of new Set([...namedFiles, ...(cell.entryFiles ?? [])])) {
      const matches = files.has(named) ? [named] : [...files].filter((path) => matchesInput(path, named));
      if (!matches.length) errors.push(`${cell.id} names a missing command file ${named}`);
      for (const path of matches) {
        if (!tracksInput(cell, path)) errors.push(`${cell.id} does not claim ${path}`);
        if (!/\.[cm]?[jt]sx?$/.test(path) || cell.language === 'shared') continue;
        const source = branch?.paths.has(path) && !path.startsWith('scripts/gates/') ? branch.head : '';
        const key = JSON.stringify([source, path, cell.language]);
        if (!imports.has(key)) {
          const body = source ? git('show', source + ':' + path) : readFileSync(path, 'utf8');
          imports.set(key, runtimeImports(path, body, files, cell.language));
        }
        for (const imported of imports.get(key)) {
          if (!tracksInput(cell, imported)) errors.push(`${cell.id}: ${path} imports unclaimed ${imported}`);
        }
      }
    }
    for (const [, script] of cell.command.matchAll(/\bpnpm (test:[\w:-]+)/g)) coveredScripts.add(script);
    for (const alias of cell.aliases ?? []) coveredScripts.add(alias);
  }
  for (const script of Object.keys(scriptsAt('')).filter((name) => name.startsWith('test:'))) {
    if (!coveredScripts.has(script)) errors.push(`No cell for ${script}`);
  }
  const missing = paths.filter((path) => !inventory.some((cell) => tracksInput(cell, path)));
  console.log(`Unclaimed tracked files (${missing.length}):\n${missing.join('\n')}`);
  assert.equal(errors.length, 0, [...new Set(errors)].join('\n'));
});

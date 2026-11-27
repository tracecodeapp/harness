import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { blobs, git, matchesInput, resolveCommit, tracksInput } from '../../scripts/gates/inventory.mjs';
import packedDriverPaths from '../../scripts/gates/packed-driver-paths.json' with { type: 'json' };
import { moduleGraph } from './module-graph.mjs';

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

function chain(file, parents) {
  const paths = [];
  for (let path = file; path !== null; path = parents.get(path)) paths.unshift(path);
  return paths.join(' -> ');
}

function driverPath(ref, path) {
  if (ref.endsWith('/gate-g7-ci')) {
    return /^scripts\/(?:check-untraced-host-history\.mjs|untraced-host-history\.browser\.ts|run-untraced-host-history\.sh)$/.test(path);
  }
  const support = ref.endsWith('/ga-judged-byte-limit') ? packedDriverPaths.support.ga : [];
  return matchesDriverPath([packedDriverPaths.root, ...support], path);
}

function matchesDriverPath(entries, path) {
  return entries.some((entry) => path === entry || path.startsWith(entry + '/'));
}

test('the staged GB browser driver resolves its recorder decoders', () => {
  const head = resolveCommit('refs/remotes/origin/test/gate-g4-g5');
  const entries = [packedDriverPaths.root, ...packedDriverPaths.support.gb];
  const files = new Set(blobs(head).map(([path]) => path).filter((path) => matchesDriverPath(entries, path)));
  const read = (path) => git('show', head + ':' + path);
  const { parents, unresolved } = moduleGraph({ files, read, aliases: {}, allowances: {} })([
    'tests/stage1-gates/gb-browser.mjs',
  ]);
  assert.deepEqual([...unresolved], []);
  assert(parents.has('packages/runtime-browser/src/trace-event-transport.ts'));
  assert(parents.has('packages/runtime-contracts/src/trace-adapters/java.ts'));
});

test('inventory claims named command files and reports unclaimed tracked paths', () => {
  const { cells: inventory, noCell } = JSON.parse(readFileSync('scripts/gates/cells.json', 'utf8'));
  assert(noCell.includes('runtime-assets.lock.json'));
  assert(noCell.includes('CHANGELOG.md'));
  const paths = git('ls-files', '-z').split('\0').filter(Boolean);
  const aliases = JSON.parse(readFileSync('tsconfig.base.json', 'utf8')).compilerOptions.paths;
  const allowed = JSON.parse(readFileSync(new URL('./opaque-inputs.json', import.meta.url), 'utf8'));
  const unapproved = new Map();
  let exampleAllowance;
  const graphs = new Map();
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
    assert(!tracksInput(cell, 'runtime-assets.lock.json'), `${cell.id} claims a generated lock`);
    assert(!tracksInput(cell, 'CHANGELOG.md'), `${cell.id} claims the root changelog`);
    assert(!cell.inputs.includes('package.json') && !cell.pins.files.includes('package.json'),
      `${cell.id} must use the root manifest projection`);
    for (const pin of cell.pins.files) assert(paths.some((path) =>
      matchesInput(path, pin) && tracksInput(cell, path)), `${cell.id} has no input for pin ${pin}`);
    const ref = cell.pins.gateRef ?? '';
    if (!graphs.has(ref)) {
      const head = ref && resolveCommit(ref);
      const drivers = new Set(head ? blobs(head).map(([path]) => path).filter((path) => driverPath(ref, path)) : []);
      const files = new Set([...paths, ...drivers]);
      const read = (path) => drivers.has(path) ? git('show', head + ':' + path) : readFileSync(path, 'utf8');
      graphs.set(ref, { files, drivers, closure: moduleGraph({ files, read, aliases, allowances: allowed }) });
    }
    const { files, drivers, closure } = graphs.get(ref);
    // Support archived from a gate ref is already keyed by that commit.
    const covered = (path) => (drivers.has(path) && matchesDriverPath(packedDriverPaths.support.ga, path)) ||
      tracksInput(cell, path);
    const namedFiles = commandFiles([cell.setup, cell.command].filter(Boolean).join(' && '));
    const roots = [];
    for (const named of new Set([...namedFiles, ...(cell.entryFiles ?? [])])) {
      const matches = files.has(named) ? [named] : [...files].filter((path) => matchesInput(path, named));
      if (!matches.length) errors.push(`${cell.id} names a missing command file ${named}`);
      roots.push(...matches);
    }
    const { parents, unresolved, opaque, interpreters } = closure(roots);
    for (const path of parents.keys()) {
      if (path !== 'package.json' && !covered(path)) {
        errors.push(`${cell.id} missing ${path} via ${chain(path, parents)}`);
      }
    }
    for (const failure of unresolved) errors.push(`${cell.id} cannot resolve ${failure}`);
    for (const [key, site] of opaque) {
      const rule = allowed[key];
      if (!rule) {
        if (!unapproved.has(key)) unapproved.set(key, { ...site, cells: [] });
        unapproved.get(key).cells.push(cell.id);
        continue;
      }
      if (!rule.inputs?.length) errors.push(`Opaque allowance ${key} has no covering inputs`);
      for (const input of rule.inputs ?? []) {
        const matches = [...files].filter((path) => matchesInput(path, input));
        if (!matches.length || matches.some((path) => path !== 'package.json' && !covered(path))) {
          errors.push(`${cell.id} uncovered opaque input ${input} at ${key}`);
        }
      }
      if (site.file === 'tests/test-javascript-authority-browser.ts' &&
        site.text.includes("'runtime-browser', 'src', 'project.ts'")) {
        exampleAllowance = `${site.file}: ${site.text} covered by ${rule.inputs.join(', ')}`;
      }
    }
    for (const [interpreter, file] of interpreters) {
      if (!(cell.pins.interpreters ?? []).includes(interpreter)) {
        errors.push(`${cell.id} missing interpreter ${interpreter} via ${file}`);
      }
    }
    for (const [, script] of cell.command.matchAll(/\bpnpm (test:[\w:-]+)/g)) coveredScripts.add(script);
    for (const alias of cell.aliases ?? []) coveredScripts.add(alias);
  }
  for (const site of unapproved.values()) errors.push(`Unallowlisted dependency ${JSON.stringify(site)}`);
  for (const script of Object.keys(scriptsAt('')).filter((name) => name.startsWith('test:'))) {
    if (!coveredScripts.has(script)) errors.push(`No cell for ${script}`);
  }
  const missing = paths.filter((path) => path !== 'package.json' && !inventory.some((cell) => tracksInput(cell, path)));
  console.log(`Unclaimed tracked files (${missing.length}):\n${missing.join('\n')}`);
  assert.equal(errors.length, 0, [...new Set(errors)].join('\n'));
  if (exampleAllowance) console.log(`Verified explicit allowance: ${exampleAllowance}`);
});

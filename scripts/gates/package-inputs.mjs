import { git } from './inventory.mjs';

export function packageAt(commit) {
  if (!git('ls-tree', '--full-tree', commit, '--', 'package.json')) return null;
  return JSON.parse(git('show', commit + ':package.json'));
}

function rootScriptCalls(command) {
  // Calls using --dir dispatch into a workspace manifest and are covered by
  // that workspace's normal file globs.
  const calls = /(?:^|[\s;&|(!])(?:pnpm\s+(?:(run)\s+)?|npm\s+(run)\s+)(?:['"]([\w:.-]+)['"]|([\w:.-]+))(?=$|[\s;&|)])/g;
  return [...command.matchAll(calls)].flatMap(([, pnpmRun, npmRun, quoted, bare]) => {
    const name = quoted ?? bare;
    if (!pnpmRun && !npmRun && ['exec', 'install', 'pack', 'publish', 'dlx'].includes(name)) return [];
    return [name];
  });
}

export function packageInputs(cell, manifest) {
  if (manifest === null) return null;
  const { scripts = {}, ...metadata } = manifest;
  const used = new Map();
  const pending = [cell.setup, cell.command].filter(Boolean).flatMap(rootScriptCalls);
  for (let index = 0; index < pending.length; index++) {
    const name = pending[index];
    if (!Object.hasOwn(scripts, name) || used.has(name)) continue;
    const command = scripts[name];
    used.set(name, command);
    pending.push(...rootScriptCalls(command));
  }
  return { ...metadata, scripts: Object.fromEntries(used) };
}

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

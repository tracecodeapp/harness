import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');

const packageMappings = new Map([
  ['@tracecode/runtime-core', '@tracecode/harness/core'],
  ['@tracecode/runtime-browser', '@tracecode/harness/browser'],
  ['@tracecode/runtime-browser/internal', '@tracecode/harness/internal/browser'],
  ['@tracecode/runtime-browser/project', '@tracecode/harness/browser/project'],
  ['@tracecode/workspace-facade', '@tracecode/harness/project'],
  [
    '@tracecode/tracekernel/workspace',
    '@tracecode/harness/internal/tracekernel/workspace',
  ],
]);

async function declarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return declarationFiles(path);
      if (
        entry.isFile() &&
        (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.cts'))
      ) {
        return [path];
      }
      return [];
    })
  );
  return nested.flat();
}

for (const file of await declarationFiles(dist)) {
  const source = await readFile(file, 'utf8');
  let rewritten = source;
  // Longest match first so @tracecode/runtime-browser/internal is not
  // partially rewritten as @tracecode/harness/browser/internal.
  for (const [workspacePackage, rootSubpath] of [...packageMappings].sort(
    ([left], [right]) => right.length - left.length
  )) {
    rewritten = rewritten.replaceAll(workspacePackage, rootSubpath);
  }
  if (rewritten !== source) await writeFile(file, rewritten);
}

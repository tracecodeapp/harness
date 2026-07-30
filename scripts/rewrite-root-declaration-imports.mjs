import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');

const packageMappings = new Map([
  ['@tracecode/runtime-core', 'core'],
  ['@tracecode/runtime-browser', 'browser'],
  ['@tracecode/runtime-browser/internal', 'internal/browser'],
  ['@tracecode/runtime-browser/project', 'browser/project'],
  ['@tracecode/workspace-facade', 'project'],
  ['@tracecode/tracekernel/workspace', 'internal/tracekernel/workspace'],
  // Also repair declarations produced by an earlier rewrite. This keeps the
  // transform idempotent across incremental and reused-dist builds.
  ['@tracecode/harness/core', 'core'],
  ['@tracecode/harness/internal/browser', 'internal/browser'],
  [
    '@tracecode/harness/internal/tracekernel/workspace',
    'internal/tracekernel/workspace',
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

function declarationImport(file, distTarget) {
  const runtimeExtension = file.endsWith('.d.cts') ? '.cjs' : '.js';
  const target = join(dist, `${distTarget}${runtimeExtension}`);
  const path = relative(dirname(file), target).split(sep).join('/');
  return path.startsWith('.') ? path : `./${path}`;
}

for (const file of await declarationFiles(dist)) {
  const source = await readFile(file, 'utf8');
  let rewritten = source;
  // Longest match first so @tracecode/runtime-browser/internal is not
  // partially rewritten as a nested path beneath the browser entrypoint.
  for (const [workspacePackage, distTarget] of [...packageMappings].sort(
    ([left], [right]) => right.length - left.length
  )) {
    rewritten = rewritten.replaceAll(
      workspacePackage,
      declarationImport(file, distTarget)
    );
  }
  if (rewritten !== source) await writeFile(file, rewritten);
}

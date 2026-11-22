import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const dist = join(root, 'dist');

const packageMappings = new Map([
  ['@tracecode/runtime-contracts', 'core'],
  ['@tracecode/runtime-browser/internal', 'internal/browser'],
  ['@tracecode/runtime-browser/project', 'tracekernel/browser'],
  ['@tracecode/runtime-browser', 'tracekernel'],
  // The public workspace entry re-exports this API. Resolve its model types
  // through the private declaration entry so that it never imports itself.
  ['@tracecode/tracekernel/workspace', 'internal/tracekernel-workspace'],
  ['@tracecode/tracekernel', 'internal/tracekernel'],
  ['just-bash/browser', 'internal/just-bash-types'],
  // Also repair declarations produced by an earlier rewrite. This keeps the
  // transform idempotent across incremental and reused-dist builds.
  ['@tracecode/harness/core', 'core'],
  ['@tracecode/harness/internal/browser', 'internal/browser'],
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

await stageShellDeclarations();

// The compiled workspace API exposes two shell types. Stage their declaration
// dependencies without exposing just-bash as a runtime package dependency.
async function stageShellDeclarations() {
  const require = createRequire(import.meta.url);
  const upstream = dirname(dirname(require.resolve('just-bash')));
  const internal = join(dist, 'internal');
  const destination = join(internal, 'just-bash');
  const files = new Set(['custom-commands.d.ts', 'types.d.ts']);

  for (const file of files) {
    const source = await readFile(join(upstream, file), 'utf8');
    let commonJs = source;
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      if (!fileName.startsWith('.') || !fileName.endsWith('.js')) {
        throw new Error(`Unexpected shell declaration import ${fileName} in ${file}`);
      }
      const target = resolve(upstream, dirname(file), fileName.replace(/\.js$/u, '.d.ts'));
      const dependency = relative(upstream, target);
      if (dependency.startsWith(`..${sep}`)) {
        throw new Error(`Shell declaration import escapes its package: ${fileName}`);
      }
      files.add(dependency);
      for (const quote of ["'", '"']) {
        commonJs = commonJs.replaceAll(
          quote + fileName + quote,
          quote + fileName.replace(/\.js$/u, '.cjs') + quote
        );
      }
    }

    const output = join(destination, file);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, source);
    await writeFile(output.replace(/\.d\.ts$/u, '.d.cts'), commonJs);
  }

  for (const [declaration, runtime] of [['.d.ts', '.js'], ['.d.cts', '.cjs']]) {
    await writeFile(
      join(internal, `just-bash-types${declaration}`),
      `export type { CustomCommand } from './just-bash/custom-commands${runtime}';\n` +
        `export type { CommandContext } from './just-bash/types${runtime}';\n`
    );
  }
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

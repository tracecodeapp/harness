import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';

const browserModule = /(?:tracekernel-workspace|project-browser|ses-algorithm-worker-client|java-project-client|tracekernel\/workspace|tracekernel\/browser|judge\/browser)/u;
const browserImplementation = /\b(?:async\s+)?function\s+(?:createBrowserProjectWorkspace|createRuntimeWorkspace)\d*\s*\(/u;
const serverEntries = ['judge.js', 'tracekernel.js'];

function imports(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  function record(specifier: ts.Node | undefined): void {
    if (specifier && ts.isStringLiteralLike(specifier)) specifiers.push(specifier.text);
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      record(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}

/** Inspect emitted code before any consuming bundler can tree-shake it. */
export async function inspectServerClosures(dist: string) {
  return Promise.all(serverEntries.map(async (entry) => {
    const seen = new Set<string>();
    const violations = new Set<string>();
    const pending = [entry];
    while (pending.length) {
      const file = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const path = join(dist, file);
      const code = await readFile(path, 'utf8');
      if (browserModule.test(file) || browserImplementation.test(code)) violations.add(file);
      const source = ts.createSourceFile(path, code, ts.ScriptTarget.ESNext, false);
      for (const specifier of imports(source)) {
        if (browserModule.test(specifier)) violations.add(`${file} -> ${specifier}`);
        if (!specifier.startsWith('.')) continue;
        const target = relative(dist, resolve(dirname(path), specifier));
        if (target === '..' || target.startsWith(`..${sep}`)) {
          throw new Error(`${file} imports outside packaged dist: ${specifier}`);
        }
        pending.push(target);
      }
    }
    return { entry, modules: [...seen].sort(), violations: [...violations].sort() };
  }));
}

/** Retain the whole server API under Worker resolution conditions. */
export async function bundleServerEntries(fixture: string) {
  const output = await build({
    absWorkingDir: fixture,
    stdin: {
      contents: [
        "export * as judge from '@tracecode/harness/judge';",
        "export * as tracekernel from '@tracecode/harness/tracekernel';",
      ].join('\n'),
      resolveDir: fixture,
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'worker', 'import'],
    mainFields: ['module', 'main'],
    external: ['node:*', ...builtinModules, 'typescript'],
    minify: true,
    metafile: true,
    write: false,
  });
  const [file] = output.outputFiles;
  const violations = Object.keys(output.metafile.inputs).filter((input) =>
    browserModule.test(input)
  );
  return { bytes: file.contents.byteLength, violations };
}

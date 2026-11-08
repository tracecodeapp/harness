import { build } from 'esbuild';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const instrumented = new Set(['workspace-file-api.ts', 'fs-observed.ts', 'workspace-storage-quota.ts', 'tkfs-backing-filesystem.ts', 'runtime-project-workspace.ts', 'snapshot-image.ts', 'live-file-change-projector.ts', 'locks.ts']);
const mutationMethods = new Set(['writeFileAs', 'deleteFileAs', 'applyFileChangeAs', 'applyFileChangeToWorkspace', 'applyRuntimeFileChangeSilently']);
const bundled = await build({
    entryPoints: ['tests/test-tracekernel-await-boundaries.ts'], write: false,
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve('tests/test-tracekernel-await-boundaries.ts')).href) },
    bundle: true, platform: 'node', format: 'esm', packages: 'external',
    tsconfig: 'tsconfig.base.json', logLevel: 'silent',
    plugins: [{ name: 'pause-source-awaits', setup(build) {
      build.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
        if (!instrumented.has(basename(path))) return;
        const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const transform = ts.transform(source, [(context) => {
          let method;
          const visit = (node) => {
            const previous = method;
            if (ts.isMethodDeclaration(node)) method = node.name.getText(source);
            let result = ts.visitEachChild(node, visit, context);
            if (ts.isAwaitExpression(node) && (basename(path) !== 'runtime-project-workspace.ts' || mutationMethods.has(method))) {
              const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
              const site = `${basename(path)}:${line + 1}:${character + 1}`;
              // Evaluate the awaited expression exactly once, preserving throws.
              const f = ts.factory;
              result = f.updateAwaitExpression(result, f.createCallExpression(
                f.createParenthesizedExpression(f.createBinaryExpression(
                  f.createPropertyAccessExpression(f.createIdentifier('globalThis'), '__harnessAwait'),
                  f.createToken(ts.SyntaxKind.QuestionQuestionToken),
                  f.createArrowFunction(undefined, undefined, [f.createParameterDeclaration(undefined, undefined, '_site'), f.createParameterDeclaration(undefined, undefined, 'value')], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), f.createIdentifier('value'))
                )), undefined, [f.createStringLiteral(site), result.expression]
              ));
            }
            method = previous;
            return result;
          };
          return (node) => ts.visitNode(node, visit);
        }]);
        const contents = ts.createPrinter().printFile(transform.transformed[0]);
        transform.dispose();
        return { contents, loader: 'ts', resolveDir: resolve(path, '..') };
      });
    } }],
  });
// Keep the test bundle in memory. Resolve external imports from this test's
// package context before loading a data URL, which has no package ancestry.
const javascript = ts.createSourceFile('probe.mjs', bundled.outputFiles[0].text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const absoluteModule = (literal) => {
  try { return ts.factory.createStringLiteral(import.meta.resolve(literal.text)); }
  catch { return literal; }
};
const imports = ts.transform(javascript, [(context) => {
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) return ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause, absoluteModule(node.moduleSpecifier), node.attributes);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [absoluteModule(node.arguments[0])]);
    }
    return ts.visitEachChild(node, visit, context);
  };
  return (node) => ts.visitNode(node, visit);
}]);
const output = ts.createPrinter().printFile(imports.transformed[0]);
imports.dispose();
try {
  await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}


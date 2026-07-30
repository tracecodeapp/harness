import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import ts from 'typescript';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function exportedDeclarationNames(sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const names: string[] = [];

  for (const statement of source.statements) {
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    );
    if (!exported) continue;

    if (
      ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name) names.push(statement.name.text);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    }
  }

  return names;
}

async function collectPublicDeclarationNames(
  filePath: string,
  visited = new Set<string>()
): Promise<string[]> {
  if (visited.has(filePath)) return [];
  visited.add(filePath);

  const sourceText = await readFile(filePath, 'utf8');
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const reexportedNames = await Promise.all(
    source.statements
      .filter(ts.isExportDeclaration)
      .filter((statement) => !statement.exportClause && statement.moduleSpecifier)
      .map(async (statement) => {
        const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
        if (!specifier.startsWith('.')) return [];
        const unresolved = resolve(dirname(filePath), specifier);
        const target = extname(unresolved) ? unresolved : `${unresolved}.ts`;
        return collectPublicDeclarationNames(target, visited);
      })
  );

  return [...exportedDeclarationNames(sourceText, filePath), ...reexportedNames.flat()];
}

async function main(): Promise<void> {
  const coreSourceDir = resolve(process.cwd(), 'packages/harness-core/src');
  const exportedNames = await collectPublicDeclarationNames(
    resolve(coreSourceDir, 'index.ts')
  );

  const vendorBrandedPythonNames = exportedNames.filter((name) => /pyodide/i.test(name));
  assertCondition(
    vendorBrandedPythonNames.length === 0,
    `Harness core must expose Python capabilities, not its engine implementation: ${vendorBrandedPythonNames.join(', ')}`
  );

  assertCondition(
    exportedNames.includes('PythonRuntimeState'),
    'Harness core should expose the language-level PythonRuntimeState contract'
  );

  console.log('PASS: harness-core public identifiers are implementation-neutral');
}

void main();

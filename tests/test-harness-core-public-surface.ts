import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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

async function main(): Promise<void> {
  const coreSourceDir = resolve(process.cwd(), 'packages/harness-core/src');
  const publicModules = [
    'execution-outcome.ts',
    'harness-version.ts',
    'runtime-external-http.ts',
    'runtime-kernel.ts',
    'runtime-language-info.ts',
    'runtime-project.ts',
    'runtime-raw-emission-contract.ts',
    'runtime-trace.ts',
    'runtime-types.ts',
    'types.ts',
    'trace-adapters/java.ts',
  ];

  const exportedNames = (
    await Promise.all(
      publicModules.map(async (relativePath) => {
        const filePath = resolve(coreSourceDir, relativePath);
        return exportedDeclarationNames(await readFile(filePath, 'utf8'), filePath);
      })
    )
  ).flat();

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

import { resolve } from 'node:path';
import ts from 'typescript';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function loadProgram(): {
  checker: ts.TypeChecker;
  entrypoint: ts.SourceFile;
} {
  const configPath = resolve(
    process.cwd(),
    'packages/runtime-core/tsconfig.json'
  );
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assertCondition(
    !config.error,
    `Could not read runtime-core TypeScript config: ${
      config.error ? ts.flattenDiagnosticMessageText(config.error.messageText, '\n') : ''
    }`
  );
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    resolve(process.cwd(), 'packages/runtime-core')
  );
  assertCondition(
    parsed.errors.length === 0,
    `Could not parse runtime-core TypeScript config: ${parsed.errors
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
      .join('\n')}`
  );
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
  const entrypointPath = resolve(
    process.cwd(),
    'packages/runtime-core/src/index.ts'
  );
  const entrypoint = program.getSourceFile(entrypointPath);
  assertCondition(entrypoint, `Missing runtime-core entrypoint ${entrypointPath}`);
  return {
    checker: program.getTypeChecker(),
    entrypoint,
  };
}

function unalias(
  checker: ts.TypeChecker,
  symbol: ts.Symbol
): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function declarationSurfaceText(symbol: ts.Symbol): string {
  return (symbol.declarations ?? [])
    .map((declaration) => declaration.getFullText(declaration.getSourceFile()))
    .join('\n');
}

function main(): void {
  const { checker, entrypoint } = loadProgram();
  const moduleSymbol = checker.getSymbolAtLocation(entrypoint);
  assertCondition(moduleSymbol, 'Could not resolve the runtime-core public module');

  const exports = checker.getExportsOfModule(moduleSymbol);
  const publicNames = new Set<string>();
  const vendorLeaks: string[] = [];

  for (const exported of exports) {
    const target = unalias(checker, exported);
    const exportedName = exported.getName();
    publicNames.add(exportedName);

    const evidence = [
      exportedName,
      target.getName(),
      declarationSurfaceText(target),
    ].join('\n');
    if (/pyodide/i.test(evidence)) {
      vendorLeaks.push(exportedName);
    }
  }

  assertCondition(
    vendorLeaks.length === 0,
    `Harness core must expose Python capabilities, not its engine implementation: ${vendorLeaks.join(', ')}`
  );
  assertCondition(
    publicNames.has('PythonRuntimeState'),
    'Harness core should expose the language-level PythonRuntimeState contract'
  );

  console.log(
    `PASS: ${publicNames.size} runtime-core exports are implementation-neutral`
  );
}

main();

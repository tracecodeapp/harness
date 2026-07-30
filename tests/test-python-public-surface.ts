import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { getLanguageRuntimeInfo } from '../packages/runtime-contracts/src/runtime-language-info';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function unalias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function declarationSurfaceText(symbol: ts.Symbol): string {
  return (symbol.declarations ?? [])
    .map((declaration) => declaration.getFullText(declaration.getSourceFile()))
    .join('\n');
}

function loadProgram(): {
  checker: ts.TypeChecker;
  entrypoints: ts.SourceFile[];
} {
  const packageRoot = resolve(process.cwd(), 'packages/runtime-python');
  const configPath = resolve(packageRoot, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assertCondition(
    !config.error,
    `Could not read runtime-python TypeScript config: ${
      config.error ? ts.flattenDiagnosticMessageText(config.error.messageText, '\n') : ''
    }`
  );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot);
  assertCondition(
    parsed.errors.length === 0,
    `Could not parse runtime-python TypeScript config: ${parsed.errors
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
      .join('\n')}`
  );
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
  const entrypoints = [
    resolve(packageRoot, 'src/index.ts'),
    resolve(packageRoot, 'src/project-browser.ts'),
    resolve(packageRoot, 'src/project-node.ts'),
  ].map((entrypointPath) => {
    const entrypoint = program.getSourceFile(entrypointPath);
    assertCondition(entrypoint, `Missing runtime-python entrypoint ${entrypointPath}`);
    return entrypoint;
  });
  return {
    checker: program.getTypeChecker(),
    entrypoints,
  };
}

function assertDefiningInterface(
  checker: ts.TypeChecker,
  exported: ts.Symbol | undefined,
  name: string
): void {
  assertCondition(exported, `Missing canonical Python export ${name}`);
  const target = unalias(checker, exported);
  assertCondition(
    (target.declarations ?? []).some((declaration) =>
      ts.isInterfaceDeclaration(declaration) && declaration.name.text === name
    ),
    `${name} must be a defining interface, not an alias to an engine-branded declaration`
  );
}

function main(): void {
  const { checker, entrypoints } = loadProgram();
  const exportsByEntrypoint = new Map<string, Map<string, ts.Symbol>>();
  const vendorLeaks: string[] = [];

  for (const entrypoint of entrypoints) {
    const moduleSymbol = checker.getSymbolAtLocation(entrypoint);
    assertCondition(moduleSymbol, `Could not resolve public module ${entrypoint.fileName}`);
    const entrypointExports = new Map(
      checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.getName(), symbol])
    );
    exportsByEntrypoint.set(entrypoint.fileName, entrypointExports);

    for (const [exportedName, exported] of entrypointExports) {
      const target = unalias(checker, exported);
      const evidence = [
        exportedName,
        target.getName(),
        declarationSurfaceText(target),
      ].join('\n');
      if (/pyodide/i.test(evidence)) {
        vendorLeaks.push(`${entrypoint.fileName}:${exportedName}`);
      }
    }
  }

  assertCondition(
    vendorLeaks.length === 0,
    `Python packages must expose language capabilities, not engine implementation names: ${vendorLeaks.join(', ')}`
  );

  const mainExports = exportsByEntrypoint.get(resolve(
    process.cwd(),
    'packages/runtime-python/src/index.ts'
  ));
  const browserExports = exportsByEntrypoint.get(resolve(
    process.cwd(),
    'packages/runtime-python/src/project-browser.ts'
  ));
  const nativeExports = exportsByEntrypoint.get(resolve(
    process.cwd(),
    'packages/runtime-python/src/project-node.ts'
  ));
  assertCondition(mainExports, 'Missing runtime-python main export map');
  assertCondition(browserExports, 'Missing runtime-python browser-project export map');
  assertCondition(nativeExports, 'Missing runtime-python native-project export map');

  for (const name of [
    'PythonWorkerClient',
    'PythonWorkerClientOptions',
    'createPythonPreparedExecutionProvider',
    'createPythonRuntimeClient',
    'createBrowserPythonProjectRunner',
    'BrowserPythonProjectRunnerOptions',
    'BrowserPythonProjectWorkerClient',
  ]) {
    assertCondition(mainExports.has(name), `@tracecode/runtime-python must export ${name}`);
  }
  assertDefiningInterface(
    checker,
    mainExports.get('PythonWorkerClientOptions'),
    'PythonWorkerClientOptions'
  );
  assertDefiningInterface(
    checker,
    browserExports.get('BrowserPythonProjectRunnerOptions'),
    'BrowserPythonProjectRunnerOptions'
  );
  assertDefiningInterface(
    checker,
    browserExports.get('BrowserPythonProjectWorkerClient'),
    'BrowserPythonProjectWorkerClient'
  );
  assertDefiningInterface(
    checker,
    nativeExports.get('NativePythonProjectRunnerOptions'),
    'NativePythonProjectRunnerOptions'
  );
  const packageDocumentationPath = resolve(
    process.cwd(),
    'packages/runtime-python/README.md'
  );
  const packageDocumentation = readFileSync(packageDocumentationPath, 'utf8');
  const runtimeAssetsHeading = packageDocumentation.indexOf('\nRuntime assets ');
  assertCondition(
    runtimeAssetsHeading > 0,
    `Python package documentation must keep a distinct runtime-assets section: ${packageDocumentationPath}`
  );
  assertCondition(
    !/pyodide/i.test(packageDocumentation.slice(0, runtimeAssetsHeading)),
    `Public Python API documentation must describe the language contract, not its engine: ${packageDocumentationPath}`
  );
  const rootPackage = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
  ) as {
    exports?: Record<string, unknown>;
  };
  const rootEntrypoints = Object.keys(rootPackage.exports ?? {});
  assertCondition(
    JSON.stringify(rootEntrypoints.sort()) ===
      JSON.stringify(['./judge', './package.json', './tracekernel']),
    `The root package may expose only TraceKernel, Judge, and its manifest: ${rootEntrypoints.join(', ')}`
  );
  assertCondition(
    rootEntrypoints.every(
      (entrypoint) =>
        entrypoint !== './python' && !entrypoint.startsWith('./python/')
    ),
    'The retired @tracecode/harness/python language subpath must not return'
  );
  const runtimePackage = JSON.parse(
    readFileSync(resolve(process.cwd(), 'packages/runtime-python/package.json'), 'utf8')
  ) as {
    private?: boolean;
  };
  assertCondition(
    runtimePackage.private === true,
    'The Python runtime package must remain a private root-package implementation detail'
  );
  assertCondition(
    !/pyodide/i.test(JSON.stringify(getLanguageRuntimeInfo('python'))),
    'Generated Python runtime metadata must describe the language contract, not its engine'
  );
  const generatedProjectWorker = readFileSync(
    resolve(process.cwd(), 'workers/javascript/javascript-project-worker.js'),
    'utf8'
  );
  const generatedMetadataStart = generatedProjectWorker.indexOf(
    '// packages/runtime-contracts/src/generated/runtime-language-info-data.ts'
  );
  const generatedMetadataEnd = generatedProjectWorker.indexOf(
    '\n// packages/',
    generatedMetadataStart + 1
  );
  assertCondition(
    generatedMetadataStart >= 0 && generatedMetadataEnd > generatedMetadataStart,
    'Generated JavaScript project worker must embed runtime language metadata'
  );
  assertCondition(
    !/pyodide/i.test(generatedProjectWorker.slice(generatedMetadataStart, generatedMetadataEnd)),
    'Bundled Python runtime metadata must remain implementation-neutral'
  );

  console.log(
    `PASS: ${
      mainExports.size + browserExports.size + nativeExports.size
    } Python package exports and public docs are implementation-neutral`
  );
}

main();

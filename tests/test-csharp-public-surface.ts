import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { getLanguageRuntimeInfo } from '../packages/runtime-core/src/runtime-language-info';
import { getRuntimeCommandVersion } from '../packages/runtime-core/src/runtime-command-info';
import { DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS } from '../packages/runtime-browser/src/runtime-assets';
import { createNativeHarness } from '../packages/runtime-native/src/index';

const PROVIDER_BRAND = /roslyn|dotnet|\.net/i;

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function unalias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function loadProgram(entrypointPaths: readonly string[]): {
  checker: ts.TypeChecker;
  entrypoints: ts.SourceFile[];
} {
  const configPath = resolve(process.cwd(), 'tsconfig.base.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assertCondition(
    !config.error,
    `Could not read TypeScript config: ${
      config.error ? ts.flattenDiagnosticMessageText(config.error.messageText, '\n') : ''
    }`
  );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  assertCondition(
    parsed.errors.length === 0,
    `Could not parse TypeScript config: ${parsed.errors
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
      .join('\n')}`
  );
  const program = ts.createProgram({
    rootNames: [...entrypointPaths],
    options: {
      ...parsed.options,
      noEmit: true,
    },
  });
  const entrypoints = entrypointPaths.map((entrypointPath) => {
    const entrypoint = program.getSourceFile(entrypointPath);
    assertCondition(entrypoint, `Missing C# public entrypoint ${entrypointPath}`);
    return entrypoint;
  });
  return {
    checker: program.getTypeChecker(),
    entrypoints,
  };
}

function moduleExports(checker: ts.TypeChecker, entrypoint: ts.SourceFile): Map<string, ts.Symbol> {
  const moduleSymbol = checker.getSymbolAtLocation(entrypoint);
  assertCondition(moduleSymbol, `Could not resolve public module ${entrypoint.fileName}`);
  return new Map(checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.getName(), symbol]));
}

function definingInterfaceProperties(
  checker: ts.TypeChecker,
  exported: ts.Symbol | undefined,
  name: string
): Set<string> {
  assertCondition(exported, `Missing canonical C# export ${name}`);
  const target = unalias(checker, exported);
  const declaration = (target.declarations ?? []).find(
    (candidate): candidate is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(candidate) && candidate.name.text === name
  );
  assertCondition(declaration, `${name} must be a defining interface, not a compatibility alias`);
  return new Set(
    declaration.members
      .map((member) => member.name)
      .filter((memberName): memberName is ts.PropertyName => Boolean(memberName))
      .map((memberName) => memberName.getText(declaration.getSourceFile()))
  );
}

function assertNeutralExportNames(
  checker: ts.TypeChecker,
  exportsByModule: ReadonlyMap<string, ReadonlyMap<string, ts.Symbol>>
): number {
  const leaks: string[] = [];
  let exportCount = 0;
  for (const [modulePath, exportedSymbols] of exportsByModule) {
    for (const [exportedName, exported] of exportedSymbols) {
      exportCount += 1;
      const targetName = unalias(checker, exported).getName();
      if (PROVIDER_BRAND.test(`${exportedName}\n${targetName}`)) {
        leaks.push(`${modulePath}:${exportedName}`);
      }
    }
  }
  assertCondition(
    leaks.length === 0,
    `C# packages must expose language capabilities, not provider names: ${leaks.join(', ')}`
  );
  return exportCount;
}

function embeddedCSharpMetadata(): string {
  const generatedProjectWorker = readFileSync(
    resolve(process.cwd(), 'workers/javascript/javascript-project-worker.js'),
    'utf8'
  );
  const metadataStart = generatedProjectWorker.indexOf(
    '// packages/runtime-core/src/generated/runtime-language-info-data.ts'
  );
  const metadataEnd = generatedProjectWorker.indexOf('\n// packages/', metadataStart + 1);
  assertCondition(
    metadataStart >= 0 && metadataEnd > metadataStart,
    'Generated JavaScript project worker must embed runtime language metadata'
  );
  const metadata = generatedProjectWorker.slice(metadataStart, metadataEnd);
  const csharpStart = metadata.indexOf('"csharp":');
  const cppStart = metadata.indexOf('"cpp":', csharpStart);
  assertCondition(
    csharpStart >= 0 && cppStart > csharpStart,
    'Generated JavaScript project worker must embed the C# runtime metadata entry'
  );
  return metadata.slice(csharpStart, cppStart);
}

function main(): void {
  const entrypointPaths = [
    resolve(process.cwd(), 'packages/runtime-csharp/src/index.ts'),
    resolve(process.cwd(), 'packages/runtime-csharp/src/project-node.ts'),
    resolve(process.cwd(), 'packages/runtime-csharp/src/project-browser.ts'),
    resolve(process.cwd(), 'packages/runtime-native/src/index.ts'),
    resolve(process.cwd(), 'src/project-node.ts'),
  ];
  const { checker, entrypoints } = loadProgram(entrypointPaths);
  const exportsByModule = new Map(
    entrypoints.map((entrypoint) => [entrypoint.fileName, moduleExports(checker, entrypoint)])
  );
  const exportCount = assertNeutralExportNames(checker, exportsByModule);

  const csharpExports = exportsByModule.get(resolve(
    process.cwd(),
    'packages/runtime-csharp/src/index.ts'
  ));
  const csharpProjectNodeExports = exportsByModule.get(resolve(
    process.cwd(),
    'packages/runtime-csharp/src/project-node.ts'
  ));
  const nativeExports = exportsByModule.get(resolve(
    process.cwd(),
    'packages/runtime-native/src/index.ts'
  ));
  const rootProjectNodeExports = exportsByModule.get(resolve(process.cwd(), 'src/project-node.ts'));
  assertCondition(csharpExports, 'Missing @tracecode/runtime-csharp export map');
  assertCondition(csharpProjectNodeExports, 'Missing C# project-node export map');
  assertCondition(nativeExports, 'Missing native harness export map');
  assertCondition(rootProjectNodeExports, 'Missing root project-node export map');

  for (const name of [
    'CSharpWorkerClient',
    'CSharpWorkerClientOptions',
    'createCSharpBrowserRuntimeProvider',
    'CSharpBrowserRuntimeProviderOptions',
    'createCSharpRuntimeClient',
    'createBrowserCSharpProjectRunner',
    'createNativeCSharpProjectRunner',
  ]) {
    assertCondition(csharpExports.has(name), `@tracecode/runtime-csharp must export ${name}`);
  }

  const clientProperties = definingInterfaceProperties(
    checker,
    csharpExports.get('CSharpWorkerClientOptions'),
    'CSharpWorkerClientOptions'
  );
  assertCondition(clientProperties.has('assetBaseUrl'), 'CSharpWorkerClientOptions must define assetBaseUrl');

  const runnerProperties = definingInterfaceProperties(
    checker,
    csharpProjectNodeExports.get('NativeCSharpProjectRunnerOptions'),
    'NativeCSharpProjectRunnerOptions'
  );
  assertCondition(runnerProperties.has('runtimeCommand'), 'NativeCSharpProjectRunnerOptions must define runtimeCommand');
  assertCondition(!runnerProperties.has('dotnetCommand'), 'NativeCSharpProjectRunnerOptions must not expose dotnetCommand');

  const workspaceProperties = definingInterfaceProperties(
    checker,
    rootProjectNodeExports.get('CreateNativeProjectWorkspaceOptions'),
    'CreateNativeProjectWorkspaceOptions'
  );
  assertCondition(workspaceProperties.has('runtimeCommand'), 'CreateNativeProjectWorkspaceOptions must define runtimeCommand');
  assertCondition(!workspaceProperties.has('dotnetCommand'), 'CreateNativeProjectWorkspaceOptions must not expose dotnetCommand');

  const nativeProperties = definingInterfaceProperties(
    checker,
    nativeExports.get('NativeHarnessOptions'),
    'NativeHarnessOptions'
  );
  assertCondition(nativeProperties.has('csharpCommand'), 'NativeHarnessOptions must define csharpCommand');
  assertCondition(!nativeProperties.has('dotnetCommand'), 'NativeHarnessOptions must not expose dotnetCommand');

  const runtimeInfo = JSON.stringify(getLanguageRuntimeInfo('csharp'));
  assertCondition(
    !PROVIDER_BRAND.test(runtimeInfo),
    'Generated C# runtime metadata must describe the language contract, not its provider'
  );
  assertCondition(
    !PROVIDER_BRAND.test(embeddedCSharpMetadata()),
    'Bundled C# runtime metadata must remain provider-neutral'
  );
  const runtimeConfig = JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        'workers/vendor/csharp/TraceCode.CSharpHost.runtimeconfig.json'
      ),
      'utf8'
    )
  ) as {
    runtimeOptions?: {
      includedFrameworks?: Array<{ name?: string; version?: string }>;
    };
  };
  const shippedRuntimeVersion = runtimeConfig.runtimeOptions?.includedFrameworks?.find(
    (framework) => framework.name === 'Microsoft.NETCore.App'
  )?.version;
  assertCondition(
    getRuntimeCommandVersion('dotnet') === shippedRuntimeVersion,
    'dotnet CLI identity must be generated from the shipped C# runtime'
  );
  const nativeHarness = createNativeHarness();
  try {
    assertCondition(
      !PROVIDER_BRAND.test(JSON.stringify(nativeHarness.getNativeLanguageSupport('csharp'))),
      'Native C# support metadata must describe the language contract, not its provider'
    );
  } finally {
    nativeHarness.dispose();
  }

  const packageReadme = readFileSync(
    resolve(process.cwd(), 'packages/runtime-csharp/README.md'),
    'utf8'
  );
  assertCondition(
    !PROVIDER_BRAND.test(packageReadme),
    '@tracecode/runtime-csharp README must describe its public language surface without provider branding'
  );
  assertCondition(
    DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.csharpWorker === 'csharp-worker.js' &&
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.csharpAssetBaseUrl === 'vendor/csharp',
    'Default C# assets must use the canonical language worker and language-owned vendor root'
  );
  assertCondition(
    existsSync(resolve(process.cwd(), 'workers/csharp/csharp-worker.js')),
    'Canonical C# worker source must exist'
  );

  console.log(`PASS: ${exportCount} C#-reachable exports and public metadata are provider-neutral`);
}

main();

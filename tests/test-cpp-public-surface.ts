import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { getLanguageRuntimeInfo } from '../packages/runtime-core/src/runtime-language-info';
import { getRuntimeCommandVersion } from '../packages/runtime-core/src/runtime-command-info';
import {
  DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS,
  resolveBrowserRuntimeAssets,
} from '../packages/runtime-browser/src/runtime-assets';

const ROOT = process.cwd();
const VIRTUAL_OUT_DIR = '/tracecode-cpp-public-declarations';
const FORBIDDEN_PUBLIC_COMPILER_NAME = /(?:YoWASP|Toolchain|Clang|LLVM)/iu;

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parsedConfig(relativePath: string): ts.ParsedCommandLine {
  const configPath = resolve(ROOT, relativePath);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assertCondition(
    !config.error,
    `Could not read ${relativePath}: ${
      config.error
        ? ts.flattenDiagnosticMessageText(config.error.messageText, '\n')
        : ''
    }`
  );
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    resolve(configPath, '..')
  );
  assertCondition(
    parsed.errors.length === 0,
    `Could not parse ${relativePath}: ${parsed.errors
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
      .join('\n')}`
  );
  return parsed;
}

function declarationPath(sourcePath: string): string {
  return `${VIRTUAL_OUT_DIR}/${sourcePath.replace(/\.ts$/u, '.d.ts')}`;
}

function declarationIsDefiningInterface(
  declaration: string,
  name: string
): boolean {
  return new RegExp(`\\binterface\\s+${name}\\b`, 'u').test(declaration);
}

function generatedMetadataSlice(): string {
  const generatedProjectWorker = readFileSync(
    resolve(ROOT, 'workers/javascript/javascript-project-worker.js'),
    'utf8'
  );
  const start = generatedProjectWorker.indexOf(
    '// packages/runtime-core/src/generated/runtime-language-info-data.ts'
  );
  const end = generatedProjectWorker.indexOf('\n// packages/', start + 1);
  assertCondition(
    start >= 0 && end > start,
    'Generated JavaScript project worker must embed runtime language metadata'
  );
  return generatedProjectWorker.slice(start, end);
}

function main(): void {
  const configs = [
    parsedConfig('packages/runtime-core/tsconfig.json'),
    parsedConfig('packages/runtime-browser/tsconfig.json'),
    parsedConfig('packages/runtime-cpp/tsconfig.json'),
  ];
  const program = ts.createProgram({
    rootNames: [...new Set(configs.flatMap((config) => config.fileNames))],
    options: {
      ...configs[1].options,
      noEmit: false,
      noEmitOnError: false,
      declaration: true,
      declarationMap: false,
      emitDeclarationOnly: true,
      sourceMap: false,
      rootDir: ROOT,
      outDir: VIRTUAL_OUT_DIR,
      incremental: false,
      tsBuildInfoFile: undefined,
    },
  });
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assertCondition(
    errors.length === 0,
    `Could not emit C++ public declarations:\n${errors
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
      .join('\n')}`
  );

  const emitted = new Map<string, string>();
  const result = program.emit(
    undefined,
    (fileName, text) => emitted.set(fileName, text),
    undefined,
    true
  );
  assertCondition(
    result.diagnostics.length === 0,
    `C++ public declaration emit reported diagnostics:\n${result.diagnostics
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
      .join('\n')}`
  );

  const publicSources = [
    'packages/runtime-core/src/runtime-execution.ts',
    'packages/runtime-browser/src/runtime-assets.ts',
    'packages/runtime-browser/src/runtime-environment.ts',
    'packages/runtime-cpp/src/browser-runtime-provider.ts',
    'packages/runtime-cpp/src/cpp-worker-client.ts',
    'packages/runtime-cpp/src/index.ts',
    'packages/runtime-cpp/src/project-browser.ts',
    'packages/runtime-cpp/src/project-node.ts',
  ] as const;
  const publicDeclarations = new Map<string, string>();
  const implementationLeaks: string[] = [];
  for (const sourcePath of publicSources) {
    const outputPath = declarationPath(sourcePath);
    const declaration = emitted.get(outputPath);
    assertCondition(declaration, `Missing emitted declaration ${outputPath}`);
    publicDeclarations.set(sourcePath, declaration);
    if (FORBIDDEN_PUBLIC_COMPILER_NAME.test(declaration)) {
      implementationLeaks.push(sourcePath);
    }
  }
  assertCondition(
    implementationLeaks.length === 0,
    `C++ declarations must describe language-owned compiler capabilities: ${implementationLeaks.join(', ')}`
  );

  const clientDeclaration = publicDeclarations.get(
    'packages/runtime-cpp/src/cpp-worker-client.ts'
  )!;
  for (const name of [
    'CppWorkerAssets',
    'CppWorkerClientOptions',
  ]) {
    assertCondition(
      declarationIsDefiningInterface(clientDeclaration, name),
      `${name} must be a defining interface`
    );
  }
  for (const member of [
    'compilerWasmUrl',
    'linkerWasmUrl',
    'compilerIntegrity',
  ]) {
    assertCondition(
      clientDeclaration.includes(member),
      `C++ worker declaration is missing ${member}`
    );
  }

  const assetDeclaration = publicDeclarations.get(
    'packages/runtime-browser/src/runtime-assets.ts'
  )!;
  for (const name of [
    'CppCompilerIntegrityEntry',
    'CppCompilerIntegrityManifest',
  ]) {
    assertCondition(
      declarationIsDefiningInterface(assetDeclaration, name),
      `${name} must be a defining interface`
    );
  }
  for (const member of [
    'compilerWasm',
    'linkerWasm',
    'compilerResources',
    'cppCompilerWasm',
    'cppLinkerWasm',
    'cppCompilerIntegrity',
  ]) {
    assertCondition(
      assetDeclaration.includes(member),
      `C++ browser asset declaration is missing ${member}`
    );
  }

  const timingDeclaration = publicDeclarations.get(
    'packages/runtime-core/src/runtime-execution.ts'
  )!;
  assertCondition(
    timingDeclaration.includes('compilerLoadMs') &&
      !timingDeclaration.includes('toolchainLoadMs'),
    'Runtime timings must expose compilerLoadMs without the removed implementation-era timing key'
  );

  const cppInfo = getLanguageRuntimeInfo('cpp');
  assertCondition(
    cppInfo.versionLabel === 'C++23' &&
      cppInfo.compiler?.name === 'C++ browser compiler' &&
      cppInfo.compiler?.version === 'C++23',
    `C++ runtime metadata must describe the C++23 contract: ${JSON.stringify(cppInfo)}`
  );
  assertCondition(
    !FORBIDDEN_PUBLIC_COMPILER_NAME.test(JSON.stringify(cppInfo)) &&
      !FORBIDDEN_PUBLIC_COMPILER_NAME.test(generatedMetadataSlice()),
    `Generated C++ runtime metadata must be implementation-neutral: ${JSON.stringify(cppInfo)}`
  );
  const shippedCompilerPackage = JSON.parse(
    readFileSync(
      resolve(ROOT, 'node_modules/@yowasp/clang/package.json'),
      'utf8'
    )
  ) as { version?: string };
  assertCondition(
    getRuntimeCommandVersion('clang++') === shippedCompilerPackage.version,
    'clang++ CLI identity must be generated from the shipped compiler package'
  );

  const defaultAssets = resolveBrowserRuntimeAssets();
  assertCondition(
    DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.cppCompilerBundle ===
      'cpp/compiler/bundle.js' &&
      defaultAssets.cppCompilerBundle === '/workers/cpp/compiler/bundle.js',
    `C++ defaults must use the canonical compiler path: ${JSON.stringify(defaultAssets)}`
  );
  assertCondition(
    !FORBIDDEN_PUBLIC_COMPILER_NAME.test(
      JSON.stringify(DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS)
    ),
    'Default browser asset paths must not expose a C++ compiler implementation'
  );

  const syncSource = readFileSync(
    resolve(ROOT, 'scripts/sync-language-package-assets.ts'),
    'utf8'
  );
  const cliSource = readFileSync(resolve(ROOT, 'src/cli.ts'), 'utf8');
  for (const source of [syncSource, cliSource]) {
    assertCondition(
      source.includes("'cpp', 'compiler', 'bundle.js'") &&
        !source.includes("'vendor', 'cpp', 'yowasp'"),
      'C++ asset publication must map private dependency inputs to canonical compiler paths'
    );
  }

  console.log(
    `PASS: ${publicSources.length} C++ declaration surfaces, metadata, and canonical asset defaults are implementation-neutral`
  );
}

main();

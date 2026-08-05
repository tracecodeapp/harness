import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { getLanguageRuntimeInfo } from '../packages/runtime-contracts/src/runtime-language-info';
import { getRuntimeCommandVersion } from '../packages/runtime-contracts/src/runtime-command-info';
import {
  DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS,
  resolveBrowserRuntimeAssets,
} from '../packages/runtime-browser/src/runtime-assets';

const ROOT = process.cwd();
const VIRTUAL_OUT_DIR = '/tracecode-cpp-public-declarations';
const FORBIDDEN_PUBLIC_COMPILER_NAME = /(?:YoWASP|Toolchain|Clang|LLVM)/iu;
const ROOT_NEUTRAL_EXPORTS = new Set([
  './tracekernel',
  './judge',
  './package.json',
]);

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

function generatedLanguageMetadataSlice(): string {
  const generatedProjectWorker = readFileSync(
    resolve(ROOT, 'workers/javascript/javascript-project-worker.js'),
    'utf8'
  );
  const start = generatedProjectWorker.indexOf(
    '// packages/runtime-contracts/src/generated/runtime-language-info-data.ts'
  );
  const end = generatedProjectWorker.indexOf(
    '\nvar RUNTIME_COMMAND_VERSIONS',
    start + 1
  );
  assertCondition(
    start >= 0 && end > start,
    'Generated JavaScript project worker must embed language runtime metadata separately from CLI implementation identities'
  );
  return generatedProjectWorker.slice(start, end);
}

function main(): void {
  const configs = [
    parsedConfig('packages/runtime-contracts/tsconfig.json'),
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

  // These are private implementation-package entrypoints in 0.14. They still
  // need a language-owned, implementation-neutral contract because the root
  // workspace composes them behind its neutral project and judge entrypoints.
  const runtimeSources = [
    'packages/runtime-contracts/src/runtime-execution.ts',
    'packages/runtime-browser/src/runtime-assets.ts',
    'packages/runtime-browser/src/runtime-environment.ts',
    'packages/runtime-cpp/src/browser-runtime-provider.ts',
    'packages/runtime-cpp/src/cpp-worker-client.ts',
    'packages/runtime-cpp/src/index.ts',
    'packages/runtime-cpp/src/project-browser.ts',
    'packages/runtime-cpp/src/project-node.ts',
  ] as const;
  const runtimeDeclarations = new Map<string, string>();
  const implementationLeaks: string[] = [];
  for (const sourcePath of runtimeSources) {
    const outputPath = declarationPath(sourcePath);
    const declaration = emitted.get(outputPath);
    assertCondition(declaration, `Missing emitted declaration ${outputPath}`);
    runtimeDeclarations.set(sourcePath, declaration);
    if (FORBIDDEN_PUBLIC_COMPILER_NAME.test(declaration)) {
      implementationLeaks.push(sourcePath);
    }
  }
  assertCondition(
    implementationLeaks.length === 0,
    `C++ runtime declarations must describe language-owned compiler capabilities: ${implementationLeaks.join(', ')}`
  );

  const clientDeclaration = runtimeDeclarations.get(
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

  const assetDeclaration = runtimeDeclarations.get(
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

  const timingDeclaration = runtimeDeclarations.get(
    'packages/runtime-contracts/src/runtime-execution.ts'
  )!;
  assertCondition(
    timingDeclaration.includes('compilerLoadMs') &&
      !timingDeclaration.includes('toolchainLoadMs'),
    'Runtime timings must expose compilerLoadMs without the removed implementation-era timing key'
  );

  const cppInfo = getLanguageRuntimeInfo('cpp');
  assertCondition(
    cppInfo.versionLabel === 'C++23' &&
      cppInfo.compiler?.name === 'C++ compiler' &&
      cppInfo.compiler?.version === 'C++23',
    `C++ runtime metadata must describe the C++23 contract: ${JSON.stringify(cppInfo)}`
  );
  assertCondition(
    !FORBIDDEN_PUBLIC_COMPILER_NAME.test(JSON.stringify(cppInfo)) &&
      !FORBIDDEN_PUBLIC_COMPILER_NAME.test(generatedLanguageMetadataSlice()),
    `Generated C++ runtime metadata must be implementation-neutral: ${JSON.stringify(cppInfo)}`
  );
  assertCondition(
    getRuntimeCommandVersion('clang++') === '22.0.0',
    'clang++ CLI identity must match the pinned TraceCC compiler release'
  );

  const defaultAssets = resolveBrowserRuntimeAssets();
  assertCondition(
    defaultAssets.cppCompilerWasm === '' &&
      defaultAssets.cppLinkerWasm === '' &&
      defaultAssets.cppSysroot === '',
    `C++ compiler assets must be supplied by the pinned runtime manifest: ${JSON.stringify(defaultAssets)}`
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
      source.includes("'cpp', 'tracecode_runtime.hpp'") &&
        !source.includes('@yowasp/clang') &&
        !source.includes("'cpp', 'compiler'"),
      'C++ package sync must publish only the runner adapter; TraceCC releases are external immutable assets'
    );
  }

  const rootPackage = JSON.parse(
    readFileSync(resolve(ROOT, 'package.json'), 'utf8')
  ) as {
    exports?: Record<string, unknown>;
  };
  const rootExports = Object.keys(rootPackage.exports ?? {});
  assertCondition(
    rootPackage.exports?.['./cpp'] === undefined,
    'The retired @tracecode/harness/cpp language subpath must not return'
  );
  assertCondition(
    rootExports.every((subpath) => ROOT_NEUTRAL_EXPORTS.has(subpath)),
    `The root package may expose only TraceKernel, Judge, and its manifest: ${rootExports.join(', ')}`
  );

  const runtimePackage = JSON.parse(
    readFileSync(resolve(ROOT, 'packages/runtime-cpp/package.json'), 'utf8')
  ) as {
    private?: boolean;
  };
  assertCondition(
    runtimePackage.private === true,
    'The C++ runtime package must remain an unpublished implementation workspace'
  );

  console.log(
    `PASS: ${runtimeSources.length} private C++ runtime surfaces stay implementation-neutral behind ${rootExports.length} neutral root exports`
  );
}

main();

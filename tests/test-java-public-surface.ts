import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { getLanguageRuntimeInfo } from '../packages/runtime-core/src/runtime-language-info';

const ROOT = process.cwd();
const VIRTUAL_OUT_DIR = '/tracecode-java-public-declarations';
const FORBIDDEN_IMPLEMENTATION_NAME = /(?:TraceJVM|CheerpJ)/iu;
const REQUIRED_ROOT_JAVA_CAPABILITY_SUBPATHS = [
  './browser',
  './browser/project',
  './judge',
] as const;
const RETIRED_ROOT_JAVA_SUBPATH = './java';

interface PackageManifest {
  readonly private?: boolean;
  readonly exports?: Record<string, unknown>;
}

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

function main(): void {
  const javaConfig = parsedConfig('packages/runtime-java/tsconfig.json');
  const browserConfig = parsedConfig('packages/runtime-browser/tsconfig.json');
  const program = ts.createProgram({
    rootNames: [...new Set([...javaConfig.fileNames, ...browserConfig.fileNames])],
    options: {
      ...browserConfig.options,
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
    `Could not emit Java public declarations:\n${errors
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
    `Java public declaration emit reported diagnostics:\n${result.diagnostics
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
      .join('\n')}`
  );

  const implementationNeutralSources = [
    'packages/runtime-java/src/index.ts',
    'packages/runtime-java/src/java-project.ts',
    'packages/runtime-java/src/java-project-runtime.ts',
    'packages/runtime-java/src/project-browser.ts',
    'packages/runtime-java/src/java-worker-client.ts',
    'packages/runtime-java/src/java-prepared-provider.ts',
    'packages/runtime-browser/src/browser-runtime-host.ts',
    'packages/runtime-browser/src/project.ts',
    'packages/runtime-browser/src/runtime-assets.ts',
  ] as const;
  const implementationLeaks: string[] = [];
  for (const sourcePath of implementationNeutralSources) {
    const outputPath = declarationPath(sourcePath);
    const declaration = emitted.get(outputPath);
    assertCondition(declaration, `Missing emitted declaration ${outputPath}`);
    if (FORBIDDEN_IMPLEMENTATION_NAME.test(declaration)) {
      implementationLeaks.push(sourcePath);
    }
  }
  assertCondition(
    implementationLeaks.length === 0,
    `Java public declarations must describe capabilities, not runtime implementations: ${implementationLeaks.join(', ')}`
  );

  const javaProjectDeclaration = emitted.get(
    declarationPath('packages/runtime-java/src/java-project.ts')
  )!;
  for (const expected of [
    'JAVA_PROJECT_CAPABILITIES',
    'createJavaProjectRunner',
    'JavaProjectClient',
    'JavaProjectRunnerOptions',
  ]) {
    assertCondition(
      javaProjectDeclaration.includes(expected),
      `Java project declaration is missing ${expected}`
    );
  }
  assertCondition(
    javaProjectDeclaration.includes("provider: \"java\"") ||
      javaProjectDeclaration.includes("provider: 'java'"),
    'Java project capabilities must expose the language provider identity'
  );

  const browserProjectDeclaration = emitted.get(
    declarationPath('packages/runtime-browser/src/project.ts')
  )!;
  assertCondition(
    browserProjectDeclaration.includes(
      'java?: BrowserProjectJavaRuntimeOptions'
    ) &&
      browserProjectDeclaration.includes(
        'runtimeProviders?: BrowserProjectRuntimeProviders'
      ) &&
      !/\b(?:Python|Java|CSharp|Cpp)WorkerClient\b/u.test(
        browserProjectDeclaration
      ) &&
      !/\bJavaProjectRunnerOptions\b/u.test(browserProjectDeclaration) &&
      !/\bjavaRuntime\b/u.test(browserProjectDeclaration) &&
      !/\btraceJVM\b/u.test(browserProjectDeclaration),
    'Browser project options must expose provider-neutral command/runtime factories without concrete client or engine types'
  );

  const rootPackageJson = JSON.parse(
    readFileSync(resolve(ROOT, 'package.json'), 'utf8')
  ) as PackageManifest;
  const rootSubpaths = Object.keys(rootPackageJson.exports ?? {});
  for (const subpath of REQUIRED_ROOT_JAVA_CAPABILITY_SUBPATHS) {
    assertCondition(
      rootSubpaths.includes(subpath),
      `Root Harness package is missing the neutral Java capability entrypoint ${subpath}`
    );
  }
  assertCondition(
    !rootSubpaths.includes(RETIRED_ROOT_JAVA_SUBPATH),
    `Root Harness package must not restore the retired language-specific export @tracecode/harness/java: ${rootSubpaths.join(', ')}`
  );

  const javaPackageJson = JSON.parse(
    readFileSync(resolve(ROOT, 'packages/runtime-java/package.json'), 'utf8')
  ) as PackageManifest;
  assertCondition(
    javaPackageJson.private === true,
    'The Java runtime workspace must remain private until it has a standalone published contract'
  );
  const internalJavaSubpaths = Object.keys(javaPackageJson.exports ?? {});
  assertCondition(
    internalJavaSubpaths.includes('./java-project') &&
      internalJavaSubpaths.includes('./java-project-runtime'),
    `Private Java runtime workspace is missing generic project subpaths: ${internalJavaSubpaths.join(', ')}`
  );
  assertCondition(
    internalJavaSubpaths.every(
      (subpath) => !FORBIDDEN_IMPLEMENTATION_NAME.test(subpath)
    ),
    `Private Java runtime workspace exposes an engine-branded subpath: ${internalJavaSubpaths.join(', ')}`
  );
  assertCondition(
    !existsSync(resolve(ROOT, 'packages/runtime-java/src/tracejvm-project.ts')) &&
      !existsSync(resolve(ROOT, 'packages/runtime-java/src/tracejvm-runtime.ts')),
    'Removed engine-branded Java entrypoint sources must not return'
  );

  const javaInfo = getLanguageRuntimeInfo('java');
  assertCondition(
    javaInfo.versionLabel === 'Java 23' &&
      javaInfo.runtime.version === '23' &&
      javaInfo.compiler?.version === '23',
    `Java runtime metadata must describe the Java 23 contract: ${JSON.stringify(javaInfo)}`
  );
  assertCondition(
    !FORBIDDEN_IMPLEMENTATION_NAME.test(JSON.stringify(javaInfo)),
    `Java runtime metadata must be implementation-neutral: ${JSON.stringify(javaInfo)}`
  );

  console.log(
    `PASS: ${implementationNeutralSources.length} Java declaration surfaces and ${internalJavaSubpaths.length} private runtime subpaths are implementation-neutral; root Java access stays behind ${REQUIRED_ROOT_JAVA_CAPABILITY_SUBPATHS.join(', ')}`
  );
}

main();

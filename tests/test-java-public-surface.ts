import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { getLanguageRuntimeInfo } from '../packages/harness-core/src/runtime-language-info';

const ROOT = process.cwd();
const VIRTUAL_OUT_DIR = '/tracecode-java-public-declarations';
const FORBIDDEN_IMPLEMENTATION_NAME = /(?:TraceJVM|CheerpJ)/iu;

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
  const javaConfig = parsedConfig('packages/harness-java/tsconfig.json');
  const browserConfig = parsedConfig('packages/harness-browser/tsconfig.json');
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

  const publicSources = [
    'packages/harness-java/src/index.ts',
    'packages/harness-java/src/java-project.ts',
    'packages/harness-java/src/java-project-runtime.ts',
    'packages/harness-java/src/project-browser.ts',
    'packages/harness-java/src/java-worker-client.ts',
    'packages/harness-browser/src/browser-harness.ts',
    'packages/harness-browser/src/project.ts',
    'packages/harness-browser/src/runtime-assets.ts',
  ] as const;
  const implementationLeaks: string[] = [];
  for (const sourcePath of publicSources) {
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
    declarationPath('packages/harness-java/src/java-project.ts')
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
    declarationPath('packages/harness-browser/src/project.ts')
  )!;
  assertCondition(
    browserProjectDeclaration.includes('java?: Omit<JavaProjectRunnerOptions') &&
      !/\bjavaRuntime\b/u.test(browserProjectDeclaration) &&
      !/\btraceJVM\b/u.test(browserProjectDeclaration),
    'Browser project options must expose java without an engine selector or branded provider field'
  );

  const javaPackageJson = JSON.parse(
    readFileSync(resolve(ROOT, 'packages/harness-java/package.json'), 'utf8')
  ) as { exports?: Record<string, unknown> };
  const publicSubpaths = Object.keys(javaPackageJson.exports ?? {});
  assertCondition(
    publicSubpaths.includes('./java-project') &&
      publicSubpaths.includes('./java-project-runtime'),
    `Java package is missing generic project subpaths: ${publicSubpaths.join(', ')}`
  );
  assertCondition(
    publicSubpaths.every(
      (subpath) => !FORBIDDEN_IMPLEMENTATION_NAME.test(subpath)
    ),
    `Java package exposes an engine-branded subpath: ${publicSubpaths.join(', ')}`
  );
  assertCondition(
    !existsSync(resolve(ROOT, 'packages/harness-java/src/tracejvm-project.ts')) &&
      !existsSync(resolve(ROOT, 'packages/harness-java/src/tracejvm-runtime.ts')),
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
    `PASS: ${publicSources.length} Java declaration surfaces and ${publicSubpaths.length} package subpaths are implementation-neutral`
  );
}

main();

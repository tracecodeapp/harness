#!/usr/bin/env npx tsx

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CHECK_MODE = process.argv.includes('--check');
const ROOT = process.cwd();
const GENERATED_PATH = join(
  ROOT,
  'packages',
  'harness-core',
  'src',
  'generated',
  'runtime-language-info-data.ts'
);

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type RuntimeInfo = Record<string, unknown>;

async function readText(...parts: string[]): Promise<string> {
  return readFile(join(ROOT, ...parts), 'utf8');
}

async function readJson<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readText(...parts)) as T;
}

function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

function requireMatch(source: string, pattern: RegExp, label: string): RegExpMatchArray {
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Unable to derive runtime info: missing ${label}`);
  }
  return match;
}

function stripSemverRange(version: string | undefined): string | undefined {
  return version?.replace(/^[~^]/, '');
}

async function packageVersion(packageName: string, rootPackage: PackageJson): Promise<string> {
  const packageJsonPath = join(ROOT, 'node_modules', ...packageName.split('/'), 'package.json');
  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: string };
    if (packageJson.version) return packageJson.version;
  } catch {
    // Fall back to package.json below.
  }
  const declared = rootPackage.dependencies?.[packageName] ?? rootPackage.devDependencies?.[packageName];
  const version = stripSemverRange(declared);
  if (!version) {
    throw new Error(`Unable to derive runtime info: missing package version for ${packageName}`);
  }
  return version;
}

function parseImportedPackages(source: string): string[] {
  return unique(
    [...source.matchAll(/^\s*import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"];?/gm)]
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value))
  );
}

function parsePythonDefaultImports(runtimeCoreSource: string): string[] {
  const prelude = requireMatch(
    runtimeCoreSource,
    /const PYTHON_DEFAULT_IMPORT_PRELUDE = `([\s\S]*?)`;/,
    'Python default import prelude'
  )[1] ?? '';
  const imports = [
    ...[...prelude.matchAll(/^import\s+([A-Za-z_][A-Za-z0-9_.]*)/gm)].map((match) => match[1]),
    ...[...prelude.matchAll(/^from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import/gm)].map((match) => match[1]),
    ...[...runtimeCoreSource.matchAll(/^from\s+(typing)\s+import/gm)].map((match) => match[1]),
  ];
  return unique(imports.filter((name): name is string => Boolean(name) && name !== 'sortedcontainers'));
}

function parseJavaDefaultImports(javaWorkerSource: string): string[] {
  const importsBlock = requireMatch(
    javaWorkerSource,
    /const JAVA_DEFAULT_IMPORTS = \[([\s\S]*?)\];/,
    'Java default imports'
  )[1] ?? '';
  return [...importsBlock.matchAll(/'import\s+([^']+?);'/g)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
}

function parseCSharpGlobalUsings(compilerHostSource: string): string[] {
  return unique(
    [...compilerHostSource.matchAll(/^\s*global using\s+([^;]+);/gm)]
      .map((match) => match[1]?.trim())
      .filter((value): value is string => Boolean(value))
  );
}

function formatCSharpLanguageVersion(languageVersion: string): string {
  const numberedVersion = languageVersion.match(/^CSharp([0-9]+)$/);
  if (numberedVersion) return `C# ${numberedVersion[1]}`;
  if (languageVersion === 'Preview') return 'C# preview';
  if (languageVersion === 'Latest') return 'C# latest';
  if (languageVersion === 'LatestMajor') return 'C# latest major';
  if (languageVersion === 'Default') return 'C# compiler default';
  return `C# ${languageVersion}`;
}

function parseCSharpLanguageVersion(compilerHostSource: string): string {
  const languageVersion = requireMatch(
    compilerHostSource,
    /LanguageVersion\.([A-Za-z0-9_]+)/,
    'C# language version'
  )[1]!;
  return formatCSharpLanguageVersion(languageVersion);
}

function parseCppDefaultHeaders(cppWorkerSource: string): string[] {
  return unique(
    [...cppWorkerSource.matchAll(/'#include\s+<([^>]+)>'/g)]
      .map((match) => `<${match[1]}>`)
      .filter((value): value is string => Boolean(value))
  );
}

function parsePackageReferenceVersion(csprojSource: string, packageName: string): string {
  return requireMatch(
    csprojSource,
    new RegExp(`<PackageReference\\s+Include="${packageName}"\\s+Version="([^"]+)"\\s*/>`),
    `${packageName} package reference`
  )[1]!;
}

async function buildRuntimeInfo(): Promise<Record<string, RuntimeInfo>> {
  const rootPackage = await readJson<PackageJson>('package.json');
  const pythonWorkerSource = await readText('workers', 'python', 'pyodide-worker.js');
  const pythonRuntimeCoreSource = await readText('workers', 'python', 'runtime-core.js');
  const pyodideLock = await readJson<{
    info?: { python?: string };
    packages?: Record<string, { version?: string }>;
  }>('node_modules', 'pyodide', 'pyodide-lock.json');
  const pyodideVersion = requireMatch(pythonWorkerSource, /pyodide[\/@]v?([0-9]+(?:\.[0-9]+){1,2})/i, 'Pyodide worker URL version')[1]!;
  const pythonVersion = pyodideLock.info?.python;
  const sortedcontainersVersion = pyodideLock.packages?.sortedcontainers?.version;
  if (!pythonVersion) throw new Error('Unable to derive runtime info: missing Pyodide Python version');
  if (!sortedcontainersVersion) throw new Error('Unable to derive runtime info: missing sortedcontainers version');

  const javascriptEntrySource = await readText('workers', 'javascript', 'javascript-libraries-entry.js');
  const javascriptPackages = parseImportedPackages(javascriptEntrySource);
  const javascriptLibraries = await Promise.all(
    javascriptPackages.map(async (packageName) => ({
      name: packageName,
      version: await packageVersion(packageName, rootPackage),
      importName: packageName,
      ...(packageName === 'lodash' ? { globalName: '_' } : {}),
    }))
  );
  const typescriptWorkerSource = await readText('workers', 'vendor', 'typescript.js');
  const typescriptVersion =
    typescriptWorkerSource.match(/\bvar version = "([^"]+)";/)?.[1] ??
    (await packageVersion('typescript', rootPackage));

  const javaWorkerSource = await readText('workers', 'java', 'java-worker.js');
  const javaVersion = requireMatch(javaWorkerSource, /cheerpjInit\(\{\s*version:\s*([0-9]+)/, 'Java runtime version')[1]!;
  const cheerpjVersion = requireMatch(javaWorkerSource, /cjrtnc\.leaningtech\.com\/([^/]+)\/loader\.js/, 'CheerpJ loader version')[1]!;
  const javaParserVersion = requireMatch(javaWorkerSource, /javaparser-core-([0-9.]+)\.jar/, 'JavaParser version')[1]!;
  const javaDefaultImports = parseJavaDefaultImports(javaWorkerSource);

  const csharpRuntimeConfig = await readJson<{
    runtimeOptions?: {
      tfm?: string;
      includedFrameworks?: Array<{ name?: string; version?: string }>;
    };
  }>('workers', 'vendor', 'csharp', 'TraceCode.CSharpHost.runtimeconfig.json');
  const dotnetFramework = csharpRuntimeConfig.runtimeOptions?.includedFrameworks?.find(
    (framework) => framework.name === 'Microsoft.NETCore.App'
  );
  const dotnetVersion = dotnetFramework?.version;
  const csharpTfm = csharpRuntimeConfig.runtimeOptions?.tfm;
  if (!dotnetVersion) throw new Error('Unable to derive runtime info: missing .NET runtime version');
  const csharpProjectSource = await readText(
    'spikes',
    'csharp-wasm-roslyn',
    'TraceCode.CSharpHost',
    'TraceCode.CSharpHost.csproj'
  );
  const roslynVersion = parsePackageReferenceVersion(csharpProjectSource, 'Microsoft.CodeAnalysis.CSharp');
  const csharpHostSource = await readText(
    'spikes',
    'csharp-wasm-roslyn',
    'TraceCode.CSharpHost',
    'CompilerHost.cs'
  );
  const csharpLanguageVersion = parseCSharpLanguageVersion(csharpHostSource);
  const csharpDefaultImports = parseCSharpGlobalUsings(csharpHostSource);

  const cppWorkerSource = await readText('workers', 'cpp', 'cpp-worker.js');
  const cppStandard = requireMatch(cppWorkerSource, /const CPP_STANDARD = '([^']+)';/, 'C++ standard')[1]!;
  const yowaspClangVersion = await packageVersion('@yowasp/clang', rootPackage);
  const yowaspClangMajor = yowaspClangVersion.match(/^[0-9]+/)?.[0] ?? yowaspClangVersion;
  const cppDefaultHeaders = parseCppDefaultHeaders(cppWorkerSource);
  const cppStandardLabel = cppStandard.toUpperCase();

  const javascriptShared = {
    runtime: {
      name: 'Browser Worker JavaScript runtime',
      detail: 'Runs in the host browser worker; Node.js is not required for browser execution.',
    },
    libraries: javascriptLibraries,
  };

  return {
    python: {
      language: 'python',
      displayName: 'Python',
      versionLabel: `Python ${pythonVersion} (Pyodide ${pyodideVersion})`,
      runtime: {
        name: 'Pyodide',
        version: pyodideVersion,
        detail: `CPython ${pythonVersion} compiled to WebAssembly.`,
      },
      defaultImports: parsePythonDefaultImports(pythonRuntimeCoreSource),
      libraries: [
        {
          name: 'sortedcontainers',
          version: sortedcontainersVersion,
          importName: 'sortedcontainers',
          detail: 'SortedDict, SortedList, and SortedSet are loaded for tree-map/tree-set style use cases.',
        },
      ],
    },
    javascript: {
      language: 'javascript',
      displayName: 'JavaScript',
      versionLabel: 'JavaScript (ECMAScript 2023)',
      ...javascriptShared,
      standard: 'ECMAScript 2023-compatible syntax in the browser worker lane.',
    },
    typescript: {
      language: 'typescript',
      displayName: 'TypeScript',
      versionLabel: `TypeScript ${typescriptVersion}`,
      runtime: {
        ...javascriptShared.runtime,
        detail: 'TypeScript is compiled before execution and runs on the JavaScript worker lane.',
      },
      compiler: {
        name: 'TypeScript',
        version: typescriptVersion,
      },
      standard: 'Transpiles to JavaScript for the browser worker lane.',
      libraries: javascriptLibraries,
    },
    java: {
      language: 'java',
      displayName: 'Java',
      versionLabel: `Java ${javaVersion}`,
      runtime: {
        name: 'CheerpJ browser-local OpenJDK runtime',
        version: javaVersion,
        detail: `Loaded through CheerpJ ${cheerpjVersion}.`,
      },
      compiler: {
        name: 'javac',
        version: javaVersion,
      },
      defaultImports: javaDefaultImports,
      libraries: [
        { name: 'JavaParser', version: javaParserVersion, detail: 'Used internally for Java source rewriting.' },
        { name: 'javafx.util.Pair', detail: 'Small compatibility Pair class bundled with the Java helper jar.' },
      ],
    },
    csharp: {
      language: 'csharp',
      displayName: 'C#',
      versionLabel: `${csharpLanguageVersion} (.NET ${dotnetVersion})`,
      runtime: {
        name: '.NET WebAssembly runtime',
        version: dotnetVersion,
        detail: `Browser-local .NET runtime targeting ${csharpTfm ?? 'the configured target framework'}.`,
      },
      compiler: {
        name: 'Microsoft.CodeAnalysis.CSharp',
        version: roslynVersion,
      },
      standard: csharpLanguageVersion,
      defaultImports: csharpDefaultImports,
    },
    cpp: {
      language: 'cpp',
      displayName: 'C++',
      versionLabel: `${cppStandardLabel} (YoWASP Clang ${yowaspClangMajor})`,
      runtime: {
        name: 'WASI/WebAssembly execution lane',
        detail: 'Compiled and executed in a browser-local WASI-style worker lane.',
      },
      compiler: {
        name: 'YoWASP Clang/LLD',
        version: yowaspClangVersion,
      },
      standard: cppStandardLabel,
      defaultImports: cppDefaultHeaders,
      libraries: [
        {
          name: 'C++ standard library and WASI libc',
          detail: 'Provided by the YoWASP Clang toolchain bundle.',
        },
      ],
    },
  };
}

function buildGeneratedTypeScript(info: Record<string, RuntimeInfo>): string {
  return `/**
 * AUTO-GENERATED FILE. DO NOT EDIT MANUALLY.
 *
 * Sources: runtime worker constants, package manifests, vendored runtime metadata.
 * Generator: scripts/generate-runtime-language-info.ts
 */

import type { Language } from '../runtime-types';
import type { LanguageRuntimeInfo } from '../runtime-language-info';

export const LANGUAGE_RUNTIME_INFOS = Object.freeze(${JSON.stringify(info, null, 2)}) as Record<Language, LanguageRuntimeInfo>;
`;
}

async function ensureParentDir(pathname: string): Promise<void> {
  await mkdir(dirname(pathname), { recursive: true });
}

async function writeOrCheck(pathname: string, nextContent: string): Promise<void> {
  if (!CHECK_MODE) {
    await ensureParentDir(pathname);
    await writeFile(pathname, nextContent, 'utf8');
    return;
  }

  let currentContent = '';
  try {
    currentContent = await readFile(pathname, 'utf8');
  } catch {
    throw new Error(`Generated artifact is missing: ${pathname}`);
  }

  if (currentContent !== nextContent) {
    throw new Error(
      `Generated artifact is out of date: ${pathname}\nRun: pnpm generate:runtime-info`
    );
  }
}

async function main(): Promise<void> {
  const output = buildGeneratedTypeScript(await buildRuntimeInfo());
  await writeOrCheck(GENERATED_PATH, output);
  console.log(CHECK_MODE ? 'Runtime language info is up to date.' : 'Generated runtime language info.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

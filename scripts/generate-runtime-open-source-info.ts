#!/usr/bin/env npx tsx

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CHECK_MODE = process.argv.includes('--check');
const ROOT = process.cwd();
const GENERATED_PATH = join(
  ROOT,
  'packages',
  'runtime-contracts',
  'src',
  'generated',
  'runtime-open-source-info-data.ts'
);

type Repository = string | { url?: string };
type PackageJson = {
  name?: string;
  version?: string;
  license?: string;
  repository?: Repository;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type Resource =
  | { kind: string; label: string; url: string }
  | { kind: string; label: string; assetPath: string };

type Component = {
  name: string;
  version?: string;
  license: string;
  detail?: string;
  resources: Resource[];
};

type RuntimeAssetLock = {
  harness: { version: string };
  components: Record<string, { files: Array<{ path: string }> }>;
  compatibility: {
    csharp: {
      recipe: { dotnetSdk: string };
      runtime: { version: string };
    };
  };
  engineDependencies: {
    tracecc: {
      package: { version: string; license?: string; repository?: Repository };
      packageManifest: { targetPath: string };
    };
    tracejvm: {
      package: { version: string; license?: string };
      packageManifest: { targetPath: string };
      descriptor: {
        runtime: {
          javaVersion: string;
          distribution: string;
          source: { archiveUrl: string; revision: string };
        };
        files: Array<{ path: string }>;
      };
    };
  };
};

function url(kind: Resource['kind'], label: string, value: string): Resource {
  return { kind, label, url: value };
}

function asset(kind: Resource['kind'], label: string, assetPath: string): Resource {
  return { kind, label, assetPath };
}

function normalizeRepository(repository: Repository | undefined): string | undefined {
  let value = typeof repository === 'string' ? repository : repository?.url;
  if (!value) return undefined;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    value = `https://github.com/${value}`;
  }
  return value.replace(/^git\+/, '').replace(/\.git$/u, '');
}

function spdxLicenseUrl(license: string): string {
  return `https://spdx.org/licenses/${encodeURIComponent(license)}.html`;
}

async function readJson<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(join(ROOT, ...parts), 'utf8')) as T;
}

function parseImportedPackages(source: string): string[] {
  return [...new Set(
    [...source.matchAll(/^\s*import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"];?/gmu)]
      .map((match) => match[1])
      .filter((name): name is string => Boolean(name))
  )];
}

async function packageComponent(packageName: string): Promise<Component> {
  const packageRoot = join(ROOT, 'node_modules', ...packageName.split('/'));
  const [manifest, packageEntries] = await Promise.all([
    readJson<PackageJson>('node_modules', ...packageName.split('/'), 'package.json'),
    readdir(packageRoot),
  ]);
  if (!manifest.version || !manifest.license) {
    throw new Error(
      `Unable to generate open-source runtime info: ${packageName} is missing version/license metadata.`
    );
  }
  const repository = normalizeRepository(manifest.repository);
  const licenseFile = packageEntries.find((entry) => /^(?:licen[cs]e|copying)(?:\.|$)/iu.test(entry));
  const noticesFile = packageEntries.find((entry) => /^(?:third.?party.?notice|notice)(?:\.|$)/iu.test(entry));
  const packageFileUrl = (fileName: string): string =>
    `https://unpkg.com/${packageName}@${manifest.version}/${fileName}`;
  return {
    name: manifest.name ?? packageName,
    version: manifest.version,
    license: manifest.license,
    resources: [
      url(
        'license',
        'License',
        licenseFile ? packageFileUrl(licenseFile) : spdxLicenseUrl(manifest.license)
      ),
      ...(noticesFile
        ? [url('notices', 'Third-party notices', packageFileUrl(noticesFile))]
        : []),
      ...(repository ? [url('source', 'Source', repository)] : []),
      url(
        'package',
        'Package',
        `https://www.npmjs.com/package/${packageName}/v/${manifest.version}`
      ),
    ],
  };
}

function requireAssetPath(paths: Set<string>, pattern: RegExp, label: string): string {
  const path = [...paths].find((candidate) => pattern.test(candidate));
  if (!path) {
    throw new Error(`Unable to generate open-source runtime info: missing ${label} in runtime asset lock.`);
  }
  return path.replace(/^workers\//u, '');
}

async function buildOpenSourceInfo(): Promise<Record<string, { language: string; components: Component[] }>> {
  const [rootPackage, lock, pyodidePackage, pyodideLock, javascriptEntry, csharpProject] =
    await Promise.all([
      readJson<PackageJson>('package.json'),
      readJson<RuntimeAssetLock>('runtime-assets.lock.json'),
      readJson<PackageJson>('node_modules', 'pyodide', 'package.json'),
      readJson<{ info?: { python?: string } }>('node_modules', 'pyodide', 'pyodide-lock.json'),
      readFile(join(ROOT, 'workers', 'javascript', 'javascript-libraries-entry.js'), 'utf8'),
      readFile(
        join(ROOT, 'packages', 'runtime-csharp', 'dotnet', 'TraceCode.CSharpHost', 'TraceCode.CSharpHost.csproj'),
        'utf8'
      ),
    ]);

  if (rootPackage.version !== lock.harness.version) {
    throw new Error(
      `Unable to generate open-source runtime info: Harness ${String(rootPackage.version)} does not match runtime asset lock ${lock.harness.version}.`
    );
  }
  if (!pyodidePackage.version || !pyodidePackage.license || !pyodideLock.info?.python) {
    throw new Error('Unable to generate open-source runtime info: Pyodide metadata is incomplete.');
  }

  const pythonPaths = new Set(lock.components.python.files.map((file) => file.path));
  const pyodideLicense = requireAssetPath(
    pythonPaths,
    /\/LICENSE\.pyodide\.txt$/u,
    'Pyodide license'
  );
  const cpythonLicense = requireAssetPath(
    pythonPaths,
    /\/LICENSE\.cpython\.txt$/u,
    'CPython license'
  );
  const pyodideRepository = normalizeRepository(pyodidePackage.repository);
  if (!pyodideRepository) {
    throw new Error('Unable to generate open-source runtime info: Pyodide repository metadata is missing.');
  }

  const javascriptPackages = parseImportedPackages(javascriptEntry);
  const javascriptComponents = await Promise.all(javascriptPackages.map(packageComponent));
  const typescriptComponent = await packageComponent('typescript');

  const tracejvm = lock.engineDependencies.tracejvm;
  if (!tracejvm.package.license) {
    throw new Error('Unable to generate open-source runtime info: TraceJVM package license is missing.');
  }
  const tracejvmPaths = new Set(tracejvm.descriptor.files.map((file) => file.path));
  const teavmSourcePath = [...tracejvmPaths].find((path) =>
    /^source\/teavm-javac-[0-9a-f]{40}\.tar\.gz$/u.test(path)
  );
  if (!teavmSourcePath) {
    throw new Error('Unable to generate open-source runtime info: TraceJVM TeaVM source archive is missing.');
  }
  const teavmRevision = teavmSourcePath.match(/teavm-javac-([0-9a-f]{40})/u)?.[1];
  if (!teavmRevision) {
    throw new Error('Unable to generate open-source runtime info: invalid TraceJVM TeaVM source path.');
  }

  const tracecc = lock.engineDependencies.tracecc;
  if (!tracecc.package.license) {
    throw new Error('Unable to generate open-source runtime info: TraceCC package license is missing.');
  }
  const traceccRepository =
    normalizeRepository(tracecc.package.repository) ?? 'https://github.com/tracecodeapp/tracecc';

  const roslynVersion = csharpProject.match(
    /PackageReference Include="Microsoft\.CodeAnalysis\.CSharp" Version="([^"]+)"/u
  )?.[1];
  if (!roslynVersion) {
    throw new Error('Unable to generate open-source runtime info: missing Roslyn package version.');
  }

  const python: Component[] = [
    {
      name: 'CPython',
      version: pyodideLock.info.python,
      license: 'PSF-2.0',
      resources: [
        asset('license', 'License', cpythonLicense),
        url('source', 'Source', `https://github.com/python/cpython/tree/v${pyodideLock.info.python}`),
      ],
    },
    {
      name: 'Pyodide',
      version: pyodidePackage.version,
      license: pyodidePackage.license,
      detail: 'Browser distribution and WebAssembly runtime image.',
      resources: [
        asset('license', 'License', pyodideLicense),
        url('source', 'Source', `${pyodideRepository}/tree/${pyodidePackage.version}`),
        url(
          'modifications',
          'Runtime modifications',
          `https://github.com/tracecodeapp/harness/tree/v${rootPackage.version}/workers/python/pyodide-${pyodidePackage.version}`
        ),
      ],
    },
  ];

  const java: Component[] = [
    {
      name: 'TraceJVM',
      version: tracejvm.package.version,
      license: tracejvm.package.license,
      resources: [
        url('license', 'License', `https://github.com/tracecodeapp/tracejvm/blob/v${tracejvm.package.version}/LICENSE`),
        url('notices', 'Third-party notices', `https://github.com/tracecodeapp/tracejvm/blob/v${tracejvm.package.version}/THIRD_PARTY_NOTICES.md`),
        url('source', 'Source', `https://github.com/tracecodeapp/tracejvm/tree/v${tracejvm.package.version}`),
      ],
    },
    {
      name: `${tracejvm.descriptor.runtime.distribution} OpenJDK`,
      version: tracejvm.descriptor.runtime.javaVersion,
      license: 'GPL-2.0-only WITH Classpath-exception-2.0',
      detail: 'Runtime image; the distributed release also carries the Assembly Exception and module notices.',
      resources: [
        url('license', 'License', 'https://openjdk.org/legal/gplv2+ce.html'),
        url('corresponding-source', 'Corresponding source', tracejvm.descriptor.runtime.source.archiveUrl),
        url('modifications', 'Build and modifications', `https://github.com/tracecodeapp/tracejvm/tree/v${tracejvm.package.version}/runtime`),
      ],
    },
    {
      name: 'TeaVM javac',
      version: teavmRevision.slice(0, 12),
      license: 'Apache-2.0',
      resources: [
        url('license', 'License', `https://github.com/tracecodeapp/tracejvm/blob/v${tracejvm.package.version}/compiler/teavm-javac/LICENSE`),
        url('modifications', 'Notice and modifications', `https://github.com/tracecodeapp/tracejvm/tree/v${tracejvm.package.version}/compiler/teavm-javac`),
        url('corresponding-source', 'Corresponding source', `https://github.com/konsoletyper/teavm-javac/archive/${teavmRevision}.tar.gz`),
        url('source', 'Upstream source', `https://github.com/konsoletyper/teavm-javac/tree/${teavmRevision}`),
      ],
    },
    {
      name: 'b-jvm',
      version: '3fd56c746566',
      license: 'MIT',
      resources: [
        url('license', 'License', 'https://github.com/anematode/b-jvm/blob/3fd56c74656602eb32efefca46f51f074bef6bca/LICENSE'),
        url('source', 'Upstream source', 'https://github.com/anematode/b-jvm/tree/3fd56c74656602eb32efefca46f51f074bef6bca'),
      ],
    },
  ];

  const csharp: Component[] = [
    {
      name: '.NET Runtime',
      version: lock.compatibility.csharp.runtime.version,
      license: 'MIT',
      resources: [
        url('license', 'License', `https://github.com/dotnet/runtime/blob/v${lock.compatibility.csharp.runtime.version}/LICENSE.TXT`),
        url('notices', 'Third-party notices', `https://github.com/dotnet/runtime/blob/v${lock.compatibility.csharp.runtime.version}/THIRD-PARTY-NOTICES.TXT`),
        url('source', 'Source', `https://github.com/dotnet/runtime/tree/v${lock.compatibility.csharp.runtime.version}`),
      ],
    },
    {
      name: 'Roslyn C# compiler',
      version: roslynVersion,
      license: 'MIT',
      resources: [
        url('license', 'License', 'https://github.com/dotnet/roslyn/blob/main/License.txt'),
        url('notices', 'Third-party notices', 'https://github.com/dotnet/roslyn/blob/main/THIRD-PARTY-NOTICES.txt'),
        url('package', 'NuGet package', `https://www.nuget.org/packages/Microsoft.CodeAnalysis.CSharp/${roslynVersion}`),
        url('source', 'Source', 'https://github.com/dotnet/roslyn'),
      ],
    },
  ];

  const cpp: Component[] = [
    {
      name: 'TraceCC',
      version: tracecc.package.version,
      license: tracecc.package.license,
      resources: [
        url('license', 'License', spdxLicenseUrl(tracecc.package.license)),
        url('notices', 'Third-party notices', `${traceccRepository}/blob/v${tracecc.package.version}/THIRD_PARTY_NOTICES.md`),
        url('source', 'Source', `${traceccRepository}/tree/v${tracecc.package.version}`),
      ],
    },
    {
      name: 'LLVM, Clang, LLD, and libc++',
      license: 'Apache-2.0 WITH LLVM-exception',
      detail: 'Compiler, linker, and C++ standard-library resources pinned by the TraceCC release.',
      resources: [
        url('license', 'License', 'https://llvm.org/LICENSE.txt'),
        url('notices', 'TraceCC third-party notices', `${traceccRepository}/blob/v${tracecc.package.version}/THIRD_PARTY_NOTICES.md`),
        url('source', 'Upstream source', 'https://github.com/llvm/llvm-project'),
      ],
    },
    {
      name: 'WASI libc and sysroot materials',
      license: 'Apache-2.0 AND MIT AND BSD-2-Clause AND CC0-1.0',
      detail: 'Mixed permissive licenses recorded by the TraceCC release notices.',
      resources: [
        url('notices', 'TraceCC third-party notices', `${traceccRepository}/blob/v${tracecc.package.version}/THIRD_PARTY_NOTICES.md`),
        url('source', 'Upstream source', 'https://github.com/WebAssembly/wasi-libc'),
      ],
    },
  ];

  return {
    python: { language: 'python', components: python },
    javascript: { language: 'javascript', components: javascriptComponents },
    typescript: {
      language: 'typescript',
      components: [typescriptComponent, ...javascriptComponents],
    },
    java: { language: 'java', components: java },
    csharp: { language: 'csharp', components: csharp },
    cpp: { language: 'cpp', components: cpp },
  };
}

function renderGenerated(info: Record<string, { language: string; components: Component[] }>): string {
  return `/**
 * AUTO-GENERATED FILE. DO NOT EDIT MANUALLY.
 *
 * Sources: runtime-assets.lock.json, package manifests, vendored runtime metadata.
 * Generator: scripts/generate-runtime-open-source-info.ts
 */

import type { Language } from '../runtime-types';
import type { LanguageRuntimeOpenSourceInfo } from '../runtime-open-source-info';

export const LANGUAGE_RUNTIME_OPEN_SOURCE_INFOS = Object.freeze(
  Object.assign(Object.create(null), ${JSON.stringify(info, null, 2)})
) as Record<Language, LanguageRuntimeOpenSourceInfo>;
`;
}

async function writeOrCheck(nextContent: string): Promise<void> {
  if (!CHECK_MODE) {
    await mkdir(dirname(GENERATED_PATH), { recursive: true });
    await writeFile(GENERATED_PATH, nextContent, 'utf8');
    return;
  }
  let current: string;
  try {
    current = await readFile(GENERATED_PATH, 'utf8');
  } catch {
    throw new Error(`Generated artifact is missing: ${GENERATED_PATH}`);
  }
  if (current !== nextContent) {
    throw new Error(
      `Generated artifact is out of date: ${GENERATED_PATH}\nRun: pnpm generate:runtime-open-source-info`
    );
  }
}

async function main(): Promise<void> {
  const info = await buildOpenSourceInfo();
  await writeOrCheck(renderGenerated(info));
  console.log(
    CHECK_MODE
      ? 'Runtime open-source info is up to date.'
      : 'Generated runtime open-source info.'
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

#!/usr/bin/env npx tsx

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

interface PackageCheck {
  name: string;
  dir: string;
  exportName: string;
  requiredFiles: string[];
}

const PACKAGE_CHECKS: PackageCheck[] = [
  {
    name: '@tracecode/harness-core',
    dir: 'packages/harness-core',
    exportName: 'createEmptyRuntimeTrace',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
  },
  {
    name: '@tracecode/harness-browser',
    dir: 'packages/harness-browser',
    exportName: 'createBrowserHarness',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/internal.js',
      'dist/internal.cjs',
      'dist/index.d.ts',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
  },
  {
    name: '@tracecode/harness-python',
    dir: 'packages/harness-python',
    exportName: 'createPythonRuntimeClient',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'workers/pyodide-worker.js',
      'workers/generated-python-harness-snippets.js',
      'workers/pyodide/runtime-core.js',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
  },
  {
    name: '@tracecode/harness-javascript',
    dir: 'packages/harness-javascript',
    exportName: 'createJavaScriptRuntimeClient',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'workers/javascript-worker.js',
      'workers/vendor/typescript.js',
      'workers/vendor/javascript-libraries.js',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
  },
  {
    name: '@tracecode/harness-java',
    dir: 'packages/harness-java',
    exportName: 'createJavaRuntimeClient',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'workers/java-worker.js',
      'workers/java-source-augmentations.js',
      'workers/vendor/java-browser-helper.jar',
      'workers/vendor/java-rewriter.jar',
      'workers/vendor/javaparser-core-3.25.10.jar',
      'workers/vendor/jdk.compiler-17.jar',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
  },
  {
    name: '@tracecode/harness-csharp',
    dir: 'packages/harness-csharp',
    exportName: 'createCSharpRuntimeClient',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'workers/csharp-worker.js',
      'workers/vendor/csharp/_framework/dotnet.js',
      'workers/vendor/csharp/_framework/dotnet.native.wasm',
      'workers/vendor/csharp/_framework/dotnet.runtime.js',
      'workers/vendor/csharp/_framework/dotnet.boot.js',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
  },
  {
    name: '@tracecode/harness-cpp',
    dir: 'packages/harness-cpp',
    exportName: 'createCppRuntimeClient',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'workers/cpp-worker.js',
      'workers/cpp-compiler-frame.html',
      'workers/cpp-compiler-worker.js',
      'workers/cpp/tracecode_runtime.hpp',
      'workers/vendor/cpp/yowasp/bundle.js',
      'workers/vendor/cpp/yowasp/llvm-resources.tar',
      'workers/vendor/cpp/yowasp/llvm.core.wasm',
      'workers/vendor/cpp/yowasp/llvm.core2.wasm',
      'workers/vendor/cpp/yowasp/llvm.core3.wasm',
      'workers/vendor/cpp/yowasp/llvm.core4.wasm',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
  },
];

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function packageNodeModulesDir(appDir: string, packageName: string): string {
  const [scope, name] = packageName.split('/');
  assertCondition(Boolean(scope) && Boolean(name), `Expected scoped package name, received ${packageName}`);
  return join(appDir, 'node_modules', scope!, name!);
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-language-packages-'));
  const appDir = join(tempRoot, 'app');
  await mkdir(join(appDir, 'node_modules', '@tracecode'), { recursive: true });

  for (const packageCheck of PACKAGE_CHECKS) {
    const packOutput = spawnSync('pnpm', ['pack', '--pack-destination', tempRoot], {
      cwd: join(process.cwd(), packageCheck.dir),
      encoding: 'utf8',
    });

    if (packOutput.status !== 0) {
      throw new Error(packOutput.stderr || packOutput.stdout || `${packageCheck.name} pack failed`);
    }

    const tarballName = String(packOutput.stdout || '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .at(-1);
    assertCondition(Boolean(tarballName), `${packageCheck.name} pack should print a tarball`);

    const tarballPath = isAbsolute(tarballName!) ? tarballName! : join(tempRoot, tarballName!);
    const listing = spawnSync('tar', ['-tf', tarballPath], { encoding: 'utf8' });
    if (listing.status !== 0) {
      throw new Error(listing.stderr || listing.stdout || `${packageCheck.name} tar listing failed`);
    }
    const packedFiles = new Set(String(listing.stdout).trim().split('\n'));

    for (const relativePath of packageCheck.requiredFiles) {
      assertCondition(
        packedFiles.has(`package/${relativePath}`),
        `${packageCheck.name} tarball should include ${relativePath}`
      );
    }

    const packageDir = packageNodeModulesDir(appDir, packageCheck.name);
    await mkdir(packageDir, { recursive: true });
    const extract = spawnSync('tar', ['-xf', tarballPath, '-C', packageDir, '--strip-components=1'], {
      encoding: 'utf8',
    });
    if (extract.status !== 0) {
      throw new Error(extract.stderr || extract.stdout || `${packageCheck.name} extraction failed`);
    }

    for (const relativePath of packageCheck.requiredFiles) {
      const fileStat = await stat(join(packageDir, relativePath));
      assertCondition(fileStat.isFile(), `${packageCheck.name} extracted file should exist at ${relativePath}`);
    }
  }

  const evalScript = `
    (async () => {
      const checks = ${JSON.stringify(PACKAGE_CHECKS.map(({ name, exportName }) => ({ name, exportName })))};
      for (const check of checks) {
        const mod = await import(check.name);
        if (typeof mod[check.exportName] !== 'function') {
          throw new Error(check.name + ' missing ' + check.exportName);
        }
      }
      console.log('ok');
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;

  const importRun = spawnSync('node', ['-e', evalScript], {
    cwd: appDir,
    encoding: 'utf8',
  });

  if (importRun.status !== 0) {
    throw new Error(importRun.stderr || importRun.stdout || 'Language package import check failed');
  }

  console.log('PASS: standalone language packages include scoped assets and public exports');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

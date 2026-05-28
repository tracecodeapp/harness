#!/usr/bin/env npx tsx

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function runWithTempRoot(tempRoot: string): Promise<void> {
  const packOutput = spawnSync('pnpm', ['pack', '--pack-destination', tempRoot], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (packOutput.status !== 0) {
    throw new Error(packOutput.stderr || packOutput.stdout || 'pnpm pack failed');
  }

  const tarballName = String(packOutput.stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .at(-1);
  assertCondition(Boolean(tarballName), 'pnpm pack should print the generated tarball name');

  const packageDir = join(tempRoot, 'app', 'node_modules', '@tracecode', 'harness');
  await mkdir(packageDir, { recursive: true });

  const tarballPath = isAbsolute(tarballName!) ? tarballName! : join(tempRoot, tarballName!);
  const extract = spawnSync('tar', ['-xf', tarballPath, '-C', packageDir, '--strip-components=1'], {
    encoding: 'utf8',
  });
  if (extract.status !== 0) {
    throw new Error(extract.stderr || extract.stdout || 'Failed to extract packed harness tarball');
  }

  const requiredPackagedFiles = [
    'dist/index.js',
    'dist/index.cjs',
    'dist/index.d.ts',
    'dist/browser.js',
    'dist/browser.cjs',
    'dist/browser.d.ts',
    'dist/browser/project.js',
    'dist/browser/project.cjs',
    'dist/project.js',
    'dist/project.cjs',
    'dist/project.d.ts',
    'dist/project-node.js',
    'dist/project-node.cjs',
    'dist/project-node.d.ts',
    'dist/zlib-browser-shim.js',
    'dist/zlib-browser-shim.cjs',
    'dist/async-hooks-browser-shim.js',
    'dist/async-hooks-browser-shim.cjs',
    'dist/core.js',
    'dist/core.cjs',
    'dist/python.js',
    'dist/python.cjs',
    'dist/javascript.js',
    'dist/javascript.cjs',
    'dist/java.js',
    'dist/java.cjs',
    'dist/csharp.js',
    'dist/csharp.cjs',
    'dist/cpp.js',
    'dist/cpp.cjs',
    'THIRD_PARTY_NOTICES.md',
    'workers/python/pyodide-worker.js',
    'workers/javascript/javascript-worker.js',
    'workers/javascript/javascript-project-worker.js',
    'workers/java/java-worker.js',
    'workers/java/java-source-augmentations.js',
    'workers/csharp/csharp-worker.js',
    'workers/vendor/java-browser-helper.jar',
    'workers/vendor/java-rewriter.jar',
    'workers/vendor/javaparser-core-3.25.10.jar',
    'workers/vendor/jdk.compiler-17.jar',
    'workers/vendor/typescript.js',
    'workers/vendor/csharp/_framework/dotnet.js',
    'workers/vendor/csharp/_framework/dotnet.native.wasm',
    'workers/vendor/csharp/_framework/dotnet.runtime.js',
    'workers/vendor/csharp/_framework/dotnet.boot.js',
  ];

  for (const relativePath of requiredPackagedFiles) {
    const filePath = join(packageDir, relativePath);
    const fileStat = await stat(filePath);
    assertCondition(fileStat.isFile(), `Packed tarball should include ${relativePath}`);
  }

  const rootTypes = await readFile(join(packageDir, 'dist/index.d.ts'), 'utf8');
  assertCondition(
    rootTypes.includes('getRuntimeProjectIoSupport') &&
      rootTypes.includes('getRuntimeProjectIoCapabilityMatrix') &&
      rootTypes.includes('RuntimeProjectIoCapabilityRow'),
    'Root declarations should expose the stable project I/O support helpers and matrix type'
  );
  const browserTypes = await readFile(join(packageDir, 'dist/browser.d.ts'), 'utf8');
  assertCondition(
    browserTypes.includes('getRuntimeProjectIoSupport') &&
      browserTypes.includes('getRuntimeProjectIoCapabilityMatrix') &&
      browserTypes.includes('RuntimeProjectIoCapabilityRow'),
    'Browser declarations should expose the stable project I/O support helpers and matrix type'
  );

  const appDir = join(tempRoot, 'app');
  const evalScript = `
    (async () => {
      const browserRequire = require('@tracecode/harness/browser');
      if (typeof browserRequire.createBrowserHarness !== 'function') {
        throw new Error('Missing CommonJS browser export');
      }
      const projectRequire = require('@tracecode/harness/project');
      if (typeof projectRequire.createRuntimeWorkspace !== 'function') {
        throw new Error('Missing CommonJS root project subpath export');
      }
      const projectNodeRequire = require('@tracecode/harness/project-node');
      if (typeof projectNodeRequire.createNativeProjectWorkspace !== 'function') {
        throw new Error('Missing CommonJS root native project subpath export');
      }

      const root = await import('@tracecode/harness');
      const project = await import('@tracecode/harness/project');
      const projectNode = await import('@tracecode/harness/project-node');
      const browser = await import('@tracecode/harness/browser');
      const browserProject = await import('@tracecode/harness/browser/project');
      const core = await import('@tracecode/harness/core');
      const python = await import('@tracecode/harness/python');
      const javascript = await import('@tracecode/harness/javascript');
      const java = await import('@tracecode/harness/java');
      const csharp = await import('@tracecode/harness/csharp');
      const cpp = await import('@tracecode/harness/cpp');

      if (typeof browser.createBrowserHarness !== 'function') throw new Error('Missing createBrowserHarness export');
      if (typeof browser.getLanguageRuntimeInfo !== 'function') throw new Error('Missing browser runtime info export');
      if (typeof browser.getRuntimeProjectIoSupport !== 'function') {
        throw new Error('Missing browser project I/O support helper export');
      }
      if (typeof browserProject.createBrowserProjectWorkspace !== 'function') {
        throw new Error('Missing browser project workspace export');
      }
      if (typeof project.createRuntimeWorkspace !== 'function') {
        throw new Error('Missing root project workspace subpath export');
      }
      if (typeof project.RuntimeProjectLiveIoController !== 'function') {
        throw new Error('Missing project live I/O controller subpath export');
      }
      if (typeof projectNode.createNativeProjectWorkspace !== 'function') {
        throw new Error('Missing root native project workspace subpath export');
      }
      const nativeWorkspace = await projectNode.createNativeProjectWorkspace({
        files: [
          { path: 'index.js', contents: 'console.log("packed-native-project")\\n' },
          { path: 'main.py', contents: 'print("packed-native-python")\\n' },
          { path: 'Main.java', contents: 'class Main { public static void main(String[] args) { System.out.println("packed-native-java"); } }\\n' },
          { path: 'main.cpp', contents: '#include <iostream>\\nint main() { std::cout << "packed-native-cpp\\\\n"; return 0; }\\n' },
          {
            path: 'NativePacked.csproj',
            contents: [
              '<Project Sdk="Microsoft.NET.Sdk">',
              '  <PropertyGroup>',
              '    <OutputType>Exe</OutputType>',
              '    <TargetFramework>net10.0</TargetFramework>',
              '    <ImplicitUsings>enable</ImplicitUsings>',
              '  </PropertyGroup>',
              '</Project>',
              '',
            ].join('\\n'),
          },
          { path: 'Program.cs', contents: 'Console.WriteLine("packed-native-csharp");\\n' },
        ],
      });
      const nativeNode = await nativeWorkspace.runCommand('node index.js');
      if (nativeNode.exitCode !== 0 || nativeNode.stdout !== 'packed-native-project\\n') {
        throw new Error('Packed native project workspace Node smoke failed: ' + JSON.stringify(nativeNode));
      }
      const nativePython = await nativeWorkspace.runCommand('python3 main.py');
      if (nativePython.exitCode !== 0 || nativePython.stdout !== 'packed-native-python\\n') {
        throw new Error('Packed native project workspace Python smoke failed: ' + JSON.stringify(nativePython));
      }
      const nativeJavac = await nativeWorkspace.runCommand('javac Main.java');
      if (nativeJavac.exitCode !== 0) {
        throw new Error('Packed native project workspace javac smoke failed: ' + JSON.stringify(nativeJavac));
      }
      const nativeJava = await nativeWorkspace.runCommand('java Main');
      if (nativeJava.exitCode !== 0 || nativeJava.stdout !== 'packed-native-java\\n') {
        throw new Error('Packed native project workspace Java smoke failed: ' + JSON.stringify(nativeJava));
      }
      const nativeCppCompile = await nativeWorkspace.runCommand('clang++ main.cpp -o native-cpp');
      if (nativeCppCompile.exitCode !== 0) {
        throw new Error('Packed native project workspace C++ compile smoke failed: ' + JSON.stringify(nativeCppCompile));
      }
      const nativeCpp = await nativeWorkspace.runCommand('./native-cpp');
      if (nativeCpp.exitCode !== 0 || nativeCpp.stdout !== 'packed-native-cpp\\n') {
        throw new Error('Packed native project workspace C++ run smoke failed: ' + JSON.stringify(nativeCpp));
      }
      const nativeCSharp = await nativeWorkspace.runCommand('dotnet run --project NativePacked.csproj');
      if (nativeCSharp.exitCode !== 0 || !nativeCSharp.stdout.endsWith('packed-native-csharp\\n')) {
        throw new Error('Packed native project workspace C# smoke failed: ' + JSON.stringify(nativeCSharp));
      }
      const browserWorkspace = await browserProject.createBrowserProjectWorkspace({
        files: [
          { path: 'main.py', contents: 'print("browser-python")\\n' },
          { path: 'index.js', contents: 'const fs = require("node:fs"); fs.writeFileSync("node.txt", "browser-node\\\\n"); console.log("browser-node");\\n' },
          { path: 'Main.java', contents: 'class Main {}\\n' },
          { path: 'Program.cs', contents: 'Console.WriteLine("browser-csharp");\\n' },
          { path: 'main.cpp', contents: 'int main() { return 0; }\\n' },
        ],
        nodeProjectTimeoutMs: 20000,
        nodeProject: { allowDynamicEval: true },
        pythonWorkerClient: {
          async executeProjectPython(request) {
            return { stdout: request.scriptPath + ':browser-python\\n', stderr: '', exitCode: 0 };
          },
          terminate() {},
        },
        javaWorkerClient: {
          async executeProjectJava(request) {
            return { stdout: request.source + ':' + request.scriptPath + ':browser-java\\n', stderr: '', exitCode: 0 };
          },
          terminate() {},
        },
        csharpWorkerClient: {
          async executeProjectCSharp(request) {
            return { stdout: request.source + ':' + request.args.join(',') + ':browser-csharp\\n', stderr: '', exitCode: 0 };
          },
          terminate() {},
        },
        cppWorkerClient: {
          async executeProjectCpp(request) {
            return { stdout: request.source + ':' + request.args.join(',') + ':browser-cpp\\n', stderr: '', exitCode: 0 };
          },
          terminate() {},
        },
      });
      try {
        const browserPython = await browserWorkspace.runCommand('python3 main.py');
        if (browserPython.exitCode !== 0 || browserPython.stdout !== 'main.py:browser-python\\n') {
          throw new Error('Packed browser project Python smoke failed: ' + JSON.stringify(browserPython));
        }
        const browserNode = await browserWorkspace.runCommand('node index.js');
        if (browserNode.exitCode !== 0 || browserNode.stdout !== 'browser-node\\n') {
          throw new Error('Packed browser project Node smoke failed: ' + JSON.stringify(browserNode));
        }
        const nodeSideEffect = await browserWorkspace.readFile('node.txt');
        if (nodeSideEffect !== 'browser-node\\n') {
          throw new Error('Packed browser project Node side effect failed: ' + JSON.stringify(nodeSideEffect));
        }
        const browserJava = await browserWorkspace.runCommand('java Main');
        if (browserJava.exitCode !== 0 || browserJava.stdout !== 'run:Main:browser-java\\n') {
          throw new Error('Packed browser project Java smoke failed: ' + JSON.stringify(browserJava));
        }
        const browserCSharp = await browserWorkspace.runCommand('dotnet run -- alpha beta');
        if (browserCSharp.exitCode !== 0 || browserCSharp.stdout !== 'run:alpha,beta:browser-csharp\\n') {
          throw new Error('Packed browser project C# smoke failed: ' + JSON.stringify(browserCSharp));
        }
        const browserCpp = await browserWorkspace.runCommand('clang++ main.cpp -o a.out');
        if (browserCpp.exitCode !== 0 || browserCpp.stdout !== 'compile:main.cpp,-o,a.out:browser-cpp\\n') {
          throw new Error('Packed browser project C++ smoke failed: ' + JSON.stringify(browserCpp));
        }
        const browserGcc = await browserWorkspace.runCommand('gcc main.cpp -o c-app');
        if (browserGcc.exitCode !== 0 || browserGcc.stdout !== 'compile:main.cpp,-o,c-app:browser-cpp\\n') {
          throw new Error('Packed browser project gcc alias smoke failed: ' + JSON.stringify(browserGcc));
        }
        const browserCc = await browserWorkspace.runCommand('cc main.cpp -o cc-app');
        if (browserCc.exitCode !== 0 || browserCc.stdout !== 'compile:main.cpp,-o,cc-app:browser-cpp\\n') {
          throw new Error('Packed browser project cc alias smoke failed: ' + JSON.stringify(browserCc));
        }
        const browserCppRun = await browserWorkspace.runCommand('./a.out alpha beta');
        if (browserCppRun.exitCode !== 0 || browserCppRun.stdout !== 'run:alpha,beta:browser-cpp\\n') {
          throw new Error('Packed browser project C++ executable smoke failed: ' + JSON.stringify(browserCppRun));
        }
      } finally {
        browserWorkspace.dispose();
      }
      if ('getPyodideWorkerClient' in browser) throw new Error('Low-level worker clients should not be publicly exported');
      if ('enforceRuntimeWorkerIsolation' in browser) throw new Error('Worker isolation helpers should not be publicly exported');
      if (typeof core.getLanguageRuntimeInfo !== 'function') throw new Error('Missing core runtime info export');
      if (typeof python.generateSolutionScript !== 'function') throw new Error('Missing python export');
      if (typeof python.createBrowserPythonProjectRunner !== 'function') {
        throw new Error('Missing python browser project runner export');
      }
      if (typeof javascript.executeJavaScriptCode !== 'function') throw new Error('Missing javascript export');
      if (typeof java.createJavaRuntimeClient !== 'function') throw new Error('Missing java export');
      if (typeof csharp.createCSharpRuntimeClient !== 'function') throw new Error('Missing csharp export');
      if (typeof cpp.createCppRuntimeClient !== 'function') throw new Error('Missing cpp export');
      if (typeof root.createBrowserHarness !== 'function') throw new Error('Root export should expose createBrowserHarness');
      if (typeof root.getRuntimeProjectIoSupport !== 'function') {
        throw new Error('Root export should expose project I/O support helper');
      }
      const jsProjectIo = root.getRuntimeProjectIoSupport('javascript');
      const tsProjectIo = browser.getRuntimeProjectIoSupport('typescript');
      if (jsProjectIo.tier !== 'native-live' || tsProjectIo.tier !== 'final-diff') {
        throw new Error('Project I/O support helper returned unexpected tiers');
      }
      const projectIoMatrix = root.getRuntimeProjectIoCapabilityMatrix();
      const javaProjectIo = browser.getRuntimeProjectIoCapability('java');
      if (!Array.isArray(projectIoMatrix) || projectIoMatrix.length < 6) {
        throw new Error('Project I/O capability matrix should include supported language rows');
      }
      if (javaProjectIo.browser.tier !== 'bridged-live' || javaProjectIo.node.tier !== 'final-diff') {
        throw new Error('Project I/O capability row returned unexpected Java tiers');
      }
      for (const exportName of ['createRuntimeWorkspace', 'createNativeProjectWorkspace', 'createBrowserProjectWorkspace']) {
        if (exportName in root) {
          throw new Error('Root default surface should not include project-mode just-bash API: ' + exportName);
        }
      }
      for (const exportName of ['createRuntimeWorkspace', 'createBrowserProjectWorkspace']) {
        if (exportName in browser) {
          throw new Error('Browser default surface should not include project-mode just-bash API: ' + exportName);
        }
      }
      const javaInfo = root.getLanguageRuntimeInfo('java');
      if (javaInfo.versionLabel !== 'Java ' + javaInfo.runtime.version) {
        throw new Error('Root export should expose language runtime info');
      }
      if (!javaInfo.description.includes('javac')) {
        throw new Error('Root export should expose natural-language language runtime info');
      }
      console.log('ok');
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
  const run = spawnSync('node', ['-e', evalScript], {
    cwd: appDir,
    encoding: 'utf8',
  });

  if (run.status !== 0) {
    throw new Error(run.stderr || run.stdout || 'Packed surface import check failed');
  }

  await writeFile(
    join(appDir, 'browser-project-entry.js'),
    [
      'import { createBrowserProjectWorkspace } from "@tracecode/harness/browser/project";',
      'import { RuntimeProjectLiveIoController, createRuntimeWorkspace } from "@tracecode/harness/project";',
      'if (typeof createBrowserProjectWorkspace !== "function") throw new Error("missing project export");',
      'if (typeof createRuntimeWorkspace !== "function") throw new Error("missing root project export");',
      'if (typeof RuntimeProjectLiveIoController !== "function") throw new Error("missing live io controller export");',
      'console.log("ok");',
      '',
    ].join('\n'),
    'utf8'
  );
  const esbuildPath = join(process.cwd(), 'node_modules', '.bin', 'esbuild');
  const browserBundle = spawnSync(
    esbuildPath,
    [
      'browser-project-entry.js',
      '--bundle',
      '--platform=browser',
      '--format=esm',
      '--conditions=browser',
      '--outfile=browser-project-bundle.js',
      '--log-level=error',
    ],
    {
      cwd: appDir,
      encoding: 'utf8',
    }
  );
  if (browserBundle.status !== 0) {
    throw new Error(browserBundle.stderr || browserBundle.stdout || 'Packed browser project bundle check failed');
  }
  const bundledBrowserProject = await readFile(join(appDir, 'browser-project-bundle.js'), 'utf8');
  for (const forbidden of ['createRequire', 'worker_threads', 'from "module"']) {
    assertCondition(
      !bundledBrowserProject.includes(forbidden),
      `Packed browser project bundle should not include Node-only ${forbidden}`
    );
  }

  const bundledZlibShim = await readFile(join(packageDir, 'dist/zlib-browser-shim.js'), 'utf8');
  for (const forbidden of ['createRequire', 'worker_threads', 'from "module"']) {
    assertCondition(
      !bundledZlibShim.includes(forbidden),
      `Packed zlib browser shim should not include Node-only ${forbidden}`
    );
  }

  console.log('PASS: packaged public surface imports through published subpaths');
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-harness-pack-'));
  try {
    await runWithTempRoot(tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

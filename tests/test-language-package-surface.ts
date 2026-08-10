#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

interface PackageCheck {
  name: string;
  dir: string;
  exportName: string;
  requiredFiles: string[];
  forbiddenFiles?: string[];
}

const PACKAGE_CHECKS: PackageCheck[] = [
  {
    name: '@tracecode/tracekernel',
    dir: 'packages/tracekernel',
    exportName: 'makeTraceKernelHost',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'dist/workspace.js',
      'dist/workspace.cjs',
      'dist/workspace.d.ts',
      'dist/zlib-browser-shim.js',
      'dist/zlib-browser-shim.cjs',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
  },
  {
    name: '@tracecode/runtime-contracts',
    dir: 'packages/runtime-contracts',
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
    name: '@tracecode/judge',
    dir: 'packages/judge',
    exportName: 'evaluateJudgePlan',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'dist/tracekernel.js',
      'dist/tracekernel.cjs',
      'dist/tracekernel.d.ts',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
  },
  {
    name: '@tracecode/runtime-browser',
    dir: 'packages/runtime-browser',
    exportName: 'createBrowserRuntimeHost',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/internal.js',
      'dist/internal.cjs',
      'dist/project.js',
      'dist/project.cjs',
      'dist/project.d.ts',
      'dist/zlib-browser-shim.js',
      'dist/zlib-browser-shim.cjs',
      'dist/index.d.ts',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
  },
  {
    name: '@tracecode/runtime-sql',
    dir: 'packages/runtime-sql',
    exportName: 'createSqlRuntimeTraceClient',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'package.json',
      'README.md',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
  },
  {
    name: '@tracecode/runtime-python',
    dir: 'packages/runtime-python',
    exportName: 'createPythonRuntimeClient',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'dist/project-node.js',
      'dist/project-node.cjs',
      'dist/project-node.d.ts',
      'dist/project-browser.js',
      'dist/project-browser.cjs',
      'dist/project-browser.d.ts',
      'workers/python-worker.js',
      'workers/tracecode_native-0.1.0-cp313-cp313-pyemscripten_2025_0_wasm32.whl',
      'workers/generated-python-harness-snippets.js',
      'workers/python/runtime-core.js',
      'workers/shared/runtime-kernel-policy-classic.js',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
  },
  {
    name: '@tracecode/runtime-javascript',
    dir: 'packages/runtime-javascript',
    exportName: 'createJavaScriptRuntimeClient',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'dist/project-node.js',
      'dist/project-node.cjs',
      'dist/project-node.d.ts',
      'dist/project-browser.js',
      'dist/project-browser.cjs',
      'dist/project-browser.d.ts',
      'workers/javascript-worker.js',
      'workers/javascript-project-worker.js',
      'workers/vendor/typescript.js',
      'workers/vendor/javascript-libraries.js',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
  },
  {
    name: '@tracecode/runtime-java',
    dir: 'packages/runtime-java',
    exportName: 'createJavaRuntimeClient',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'dist/project-node.js',
      'dist/project-node.cjs',
      'dist/project-node.d.ts',
      'dist/project-browser.js',
      'dist/project-browser.cjs',
      'dist/project-browser.d.ts',
      'dist/java-project.js',
      'dist/java-project.cjs',
      'dist/java-project.d.ts',
      'workers/java-worker.js',
      'workers/java-runtime-worker.js',
      'workers/java-source-augmentations.js',
      'workers/shared/runtime-kernel-policy-classic.js',
      'workers/vendor/java-browser-helper.jar',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
    forbiddenFiles: [
      'workers/tracejvm-java-worker.js',
      'workers/vendor/java-rewriter.jar',
      'workers/vendor/javaparser-core-3.25.10.jar',
      'workers/vendor/jdk.compiler-17.jar',
    ],
  },
  {
    name: '@tracecode/runtime-csharp',
    dir: 'packages/runtime-csharp',
    exportName: 'createCSharpRuntimeClient',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'dist/project-node.js',
      'dist/project-node.cjs',
      'dist/project-node.d.ts',
      'dist/project-browser.js',
      'dist/project-browser.cjs',
      'dist/project-browser.d.ts',
      'workers/csharp-worker.js',
      'workers/shared/runtime-kernel-policy-classic.js',
      'workers/vendor/csharp/_framework/dotnet.js',
      'workers/vendor/csharp/_framework/dotnet.native.wasm',
      'workers/vendor/csharp/_framework/dotnet.runtime.js',
      'workers/vendor/csharp/_framework/dotnet.boot.js',
      'workers/vendor/csharp-runner/_framework/dotnet.boot.js',
      'workers/vendor/csharp-runner/_framework/assemblies-01.pack',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
    forbiddenFiles: [
      'workers/vendor/csharp-compiler/_framework/dotnet.boot.js',
    ],
  },
  {
    name: '@tracecode/runtime-cpp',
    dir: 'packages/runtime-cpp',
    exportName: 'createCppRuntimeClient',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'dist/project-node.js',
      'dist/project-node.cjs',
      'dist/project-node.d.ts',
      'dist/project-browser.js',
      'dist/project-browser.cjs',
      'dist/project-browser.d.ts',
      'workers/cpp-worker.js',
      'workers/shared/runtime-kernel-policy.js',
      'workers/cpp/tracecode_runtime.hpp',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
    forbiddenFiles: [
      'workers/cpp-compiler-frame.html',
      'workers/cpp-compiler-worker.js',
      'workers/cpp/compiler/bundle.js',
      'workers/cpp/compiler/llvm-resources.tar',
    ],
  },
  {
    name: '@tracecode/runtime-native',
    dir: 'packages/runtime-native',
    exportName: 'createNativeHarness',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'workers/python/runtime-core.js',
      'workers/javascript/javascript-worker.js',
      'workers/vendor/typescript.js',
      'workers/vendor/javascript-libraries.js',
      'workers/java/java-worker.js',
      'workers/vendor/java-browser-helper.jar',
      'workers/cpp/cpp-worker.js',
      'workers/cpp/tracecode_runtime.hpp',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ],
  },
];

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function readDeclarationTree(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return readDeclarationTree(path);
    return entry.isFile() && (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.cts'))
      ? readFile(path, 'utf8')
      : '';
  }));
  return sources.join('\n');
}

function resolvePnpmCommand(): string {
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const candidates = [
    executable,
    process.env.PNPM_HOME ? join(process.env.PNPM_HOME, executable) : undefined,
    join(homedir(), 'Library', 'pnpm', executable),
    join(homedir(), '.local', 'share', 'pnpm', executable),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (candidate !== executable && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) return candidate;
  }

  throw new Error(
    [
      'Unable to find pnpm for package-surface verification.',
      'Install pnpm, set PNPM_HOME, or add pnpm to PATH.',
    ].join('\n')
  );
}

function spawnFailure(output: ReturnType<typeof spawnSync>, fallback: string): string {
  return [output.error?.message, output.stderr, output.stdout, fallback]
    .filter(Boolean)
    .map(String)
    .join('\n');
}

function packageNodeModulesDir(appDir: string, packageName: string): string {
  const [scope, name] = packageName.split('/');
  assertCondition(Boolean(scope) && Boolean(name), `Expected scoped package name, received ${packageName}`);
  return join(appDir, 'node_modules', scope!, name!);
}

async function runWithTempRoot(tempRoot: string): Promise<void> {
  const pnpmCommand = resolvePnpmCommand();
  const rootManifest = JSON.parse(
    await readFile(join(process.cwd(), 'package.json'), 'utf8')
  ) as { version?: unknown };
  assertCondition(
    typeof rootManifest.version === 'string',
    'Root Harness manifest should declare a release version'
  );
  assertCondition(
    !existsSync(join(process.cwd(), 'packages', 'harness-sql')),
    'Removed packages/harness-sql directory should not remain in the workspace'
  );
  const appDir = join(tempRoot, 'app');
  await mkdir(join(appDir, 'node_modules', '@tracecode'), { recursive: true });
  await cp(
    join(process.cwd(), 'node_modules', 'effect'),
    join(appDir, 'node_modules', 'effect'),
    { recursive: true, dereference: true }
  );
  await cp(
    join(process.cwd(), 'node_modules', '@tracecode', 'tracejvm'),
    join(appDir, 'node_modules', '@tracecode', 'tracejvm'),
    { recursive: true, dereference: true }
  );
  await writeFile(
    join(appDir, 'package.json'),
    JSON.stringify({
      type: 'module',
      private: true,
      dependencies: {},
    }),
    'utf8'
  );

  for (const packageCheck of PACKAGE_CHECKS) {
    const packOutput = spawnSync(pnpmCommand, ['pack', '--pack-destination', tempRoot], {
      cwd: join(process.cwd(), packageCheck.dir),
      encoding: 'utf8',
    });

    if (packOutput.status !== 0) {
      throw new Error(spawnFailure(packOutput, `${packageCheck.name} pack failed`));
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
    for (const relativePath of packageCheck.forbiddenFiles ?? []) {
      assertCondition(
        !packedFiles.has(`package/${relativePath}`),
        `${packageCheck.name} tarball must not include retired artifact ${relativePath}`
      );
    }
    if (packageCheck.name === '@tracecode/runtime-cpp') {
      const brandedCompilerPaths = [...packedFiles].filter((path) =>
        /(?:yowasp|toolchain)/iu.test(path)
      );
      assertCondition(
        brandedCompilerPaths.length === 0,
        `@tracecode/runtime-cpp tarball must publish language-owned compiler paths: ${brandedCompilerPaths.join(', ')}`
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

    if (packageCheck.name === '@tracecode/runtime-contracts') {
      const declarations = await readFile(join(packageDir, 'dist/index.d.ts'), 'utf8');
      assertCondition(
        declarations.includes('interface RuntimeDirectoryChange') &&
          declarations.includes('type RuntimeFileChange = RuntimeFile | RuntimeSymlink | RuntimeFileDeletion | RuntimeDirectoryChange'),
        '@tracecode/runtime-contracts declarations should ship directory file-change events'
      );
      assertCondition(
        declarations.includes('runtimeKernelWriteTarget') &&
          declarations.includes('type RuntimeKernelWriteTarget') &&
          declarations.includes('runtimeKernelStatTarget') &&
          declarations.includes('type RuntimeKernelStatTarget') &&
          declarations.includes('runtimeKernelLinkTarget') &&
          declarations.includes('type RuntimeKernelLinkTarget') &&
          declarations.includes('runtimeKernelRenameTarget') &&
          declarations.includes('type RuntimeKernelRenameTarget') &&
          declarations.includes('runtimeKernelSymlinkTarget') &&
          declarations.includes('type RuntimeKernelSymlinkTarget') &&
          declarations.includes('runtimeKernelRemoveTarget') &&
          declarations.includes('type RuntimeKernelRemoveTarget') &&
          declarations.includes('runtimeKernelMkdirTarget') &&
          declarations.includes('type RuntimeKernelMkdirTarget') &&
          declarations.includes('runtimeKernelTruncateTarget') &&
          declarations.includes('type RuntimeKernelTruncateTarget') &&
          declarations.includes('normalizeRuntimeDevicePath'),
        '@tracecode/runtime-contracts declarations should export shared tracekernel helpers'
      );
      assertCondition(
        declarations.includes('class RuntimeProjectLiveIoController') &&
          declarations.includes('interface RuntimeProjectLiveIoControllerOptions') &&
          declarations.includes('filterAppliedResultFiles') &&
          declarations.includes('emitMissingFinalOutput'),
        '@tracecode/runtime-contracts declarations should export the shared live project I/O controller'
      );
      assertCondition(
        declarations.includes("type RuntimeProjectIoTier = 'unsupported' | 'final-diff' | 'bridged-live' | 'native-live'") &&
          declarations.includes('interface RuntimeProjectIoSupport'),
        '@tracecode/runtime-contracts declarations should export project I/O support tier types'
      );
    }
    if (packageCheck.name === '@tracecode/tracekernel') {
      const workspaceDeclarations = await readFile(
        join(packageDir, 'dist/workspace.d.ts'),
        'utf8'
      );
      const workspaceDist = await readFile(
        join(packageDir, 'dist/workspace.js'),
        'utf8'
      );
      const workspaceExportLine =
        workspaceDeclarations
          .split('\n')
          .find((line) => line.startsWith('export {')) ?? '';
      assertCondition(
        workspaceDeclarations.includes('createRuntimeWorkspace') &&
          workspaceDeclarations.includes(
            'CreateRuntimeWorkspaceOptions'
          ) &&
          !workspaceExportLine.includes(
            'RuntimeProjectLiveIoController'
          ),
        '@tracecode/tracekernel/workspace should expose workspace ownership without re-exporting core contracts'
      );
      assertCondition(
        workspaceDist.includes(
          'function isRuntimeDirectoryChange('
        ) &&
          workspaceDist.includes('directory: true'),
        '@tracecode/tracekernel/workspace should ship directory file-change application support'
      );
      assertCondition(
        workspaceDist.includes('symlink(target, linkPath)') &&
          workspaceDist.includes(
            'const symlinkTarget = kernelSymlinkTarget(linkPath)'
          ) &&
          workspaceDist.includes('link(existingPath, newPath)') &&
          workspaceDist.includes(
            'const linkTarget = kernelLinkTarget(existingPath, newPath)'
          ) &&
          workspaceDist.includes(
            'const renameTarget = kernelRenameTarget(sourcePath, destinationPath)'
          ) &&
          workspaceDist.includes(
            'const removeTarget = kernelRemoveTarget(path2)'
          ) &&
          workspaceDist.includes(
            'const mkdirTarget = kernelMkdirTarget(path2)'
          ) &&
          workspaceDist.includes(
            'Kernel virtual path is not a symbolic link'
          ) &&
          workspaceDist.includes(
            'const statTarget = kernelStatTarget(path'
          ) &&
          workspaceDist.includes('virtualStat(stat') &&
          workspaceDist.includes(
            'if (isRuntimeKernelVirtualNamespacePath(path'
          ),
        '@tracecode/tracekernel/workspace should ship shared-kernel virtual stat/link guards'
      );
    }
    if (packageCheck.name === '@tracecode/runtime-sql') {
      const declarations = await readFile(join(packageDir, 'dist/index.d.ts'), 'utf8');
      const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
        repository?: { directory?: unknown };
      };
      assertCondition(
        declarations.includes('interface SqlTrace') &&
          declarations.includes('interface SqlBatchEvent') &&
          declarations.includes('interface SqlTraceHashPolicy') &&
          declarations.includes('type SqlTraceCapturePolicyOptions') &&
          declarations.includes('type SqlTraceEventKind') &&
          declarations.includes('interface SqlRuntimeTraceClientOptions') &&
          declarations.includes('persistenceLocation?: string') &&
          declarations.includes('SQL_RUNTIME_TRACE_CAPABILITIES') &&
          declarations.includes('createSqlRuntimeTraceClient') &&
          declarations.includes('createSqlTraceClient') &&
          declarations.includes('inferSqlPersistence') &&
          declarations.includes('assertValidSqlTrace'),
        '@tracecode/runtime-sql declarations should ship the generic SQL runtime trace contract and client helpers'
      );
      for (const removedPublicName of [
        'PgliteSqlTraceClientOptions',
        'PGLITE_SQL_TRACE_CAPABILITIES',
        'createPgliteSqlTraceClient',
        'inferPgliteSqlPersistence',
      ]) {
        assertCondition(
          !declarations.includes(removedPublicName),
          `@tracecode/runtime-sql declarations should not expose removed provider-branded API ${removedPublicName}`
        );
      }
      assertCondition(
        manifest.name === '@tracecode/runtime-sql' &&
          manifest.version === rootManifest.version &&
          manifest.repository?.directory === 'packages/runtime-sql',
        '@tracecode/runtime-sql package artifact should preserve the root Harness release identity'
      );
    }
    if (packageCheck.name === '@tracecode/runtime-python') {
      assertCondition(
        !packedFiles.has('package/workers/pyodide-worker.js') &&
          !packedFiles.has('package/workers/pyodide/runtime-core.js'),
        '@tracecode/runtime-python must not publish engine-branded worker paths'
      );
      const declarations = (
        await Promise.all(
          (await readdir(join(packageDir, 'dist')))
            .filter((file) => file.endsWith('.d.ts'))
            .map((file) => readFile(join(packageDir, 'dist', file), 'utf8'))
        )
      ).join('\n');
      assertCondition(
        !/pyodide/i.test(declarations),
        '@tracecode/runtime-python declarations must remain implementation-neutral'
      );
      assertCondition(
        declarations.includes('interface PythonWorkerClientOptions') &&
          declarations.includes('interface BrowserPythonProjectRunnerOptions') &&
          declarations.includes('interface BrowserPythonProjectWorkerClient'),
        '@tracecode/runtime-python canonical option and worker-client types must be defining interfaces'
      );
      const worker = await readFile(join(packageDir, 'workers/python-worker.js'), 'utf8');
      assertCondition(
        !worker.includes('"/dev/stdout": {"readable": False, "writable": True'),
        '@tracecode/runtime-python worker should not ship fallback /dev/stdout device semantics'
      );
      assertCondition(
        worker.includes('function installPyodideProjectStdioBridge(') &&
          worker.includes('pyodide.setStdin({') &&
          worker.includes('_stdout = _TraceProjectStream("stdout")') &&
          worker.includes('_stderr = _TraceProjectStream("stderr")') &&
          worker.includes('sys.__stdout__ = _stdout') &&
          worker.includes('sys.__stderr__ = _stderr') &&
          worker.includes('sys.__stdout__ = _previous_dunder_stdout') &&
          worker.includes('sys.__stderr__ = _previous_dunder_stderr') &&
          !worker.includes('pyodide.setStdout({ write: writeHandler(') &&
          !worker.includes('pyodide.setStderr({ write: writeHandler('),
        '@tracecode/runtime-python worker should ship bounded project stdio hooks without provider callback re-entry'
      );
      assertCondition(
        worker.includes('self.__tracecodeReadProjectStdinByte = readProjectStdinByte') &&
          worker.includes('sys.stdin = _TraceProjectInputStream()') &&
          worker.includes('return _read_project_input(_device, _length)'),
        '@tracecode/runtime-python worker should route sys.stdin and device reads through one kernel stdin cursor'
      );
      assertCondition(
        worker.includes('sourceDevice') &&
          worker.includes('def write(self, _value, _source_device=None, _output_device=None):') &&
          worker.includes('_device = str(_output_device or ("/dev/stderr" if self._stream == "stderr" else "/dev/stdout"))') &&
          worker.includes('_target.write(bytes(_data).decode("utf-8", "replace"), self._device, _output_device)') &&
          worker.includes('_target.write(_bytes.decode("utf-8", "replace"), _device, _output_device)'),
        '@tracecode/runtime-python worker should ship routed output/source device events'
      );
      assertCondition(
        worker.includes("patch('open'") &&
          worker.includes('isCreateOrTruncateOpenFlags') &&
          worker.includes('kernelVirtualMutationTarget(path)') &&
          worker.includes('emitFileChange(streamPath(stream))'),
        '@tracecode/runtime-python worker should ship shared-kernel live empty-open file mutation hooks'
      );
      assertCondition(
        worker.includes('shared-kernel-policy-loaded') &&
          worker.includes('self.TraceRuntimeKernelPolicy') &&
          worker.includes('__tracecodeRuntimeKernelOpenTarget') &&
          worker.includes('__tracecodeRuntimeKernelMutationTarget') &&
          worker.includes('runtimeKernelVirtualOpenTarget') &&
          worker.includes('runtimeKernelVirtualMutationTarget') &&
          worker.includes('runtimeKernelVirtualPathTarget(path, { devices })') &&
          worker.includes('runtimeKernelDeviceOutputTarget(devices, target.path)') &&
          worker.includes('runtimeKernelDeviceInputSource(devices, device)'),
        '@tracecode/runtime-python worker should load shared worker kernel policy for virtual path, open, mutation, and device routing decisions'
      );
      assertCondition(
        worker.includes("patch('mkdir'") &&
          worker.includes("patch('rmdir'") &&
          worker.includes('emitDirectoryCreate(path)') &&
          worker.includes('emitDirectoryDelete(path)'),
        '@tracecode/runtime-python worker should ship live directory mutation hooks'
      );
      assertCondition(
        /const emitPathSnapshot = \(path(?:, [^)]+)?\) =>/.test(worker) &&
          worker.includes('emitPathSnapshot(`${String(path).replace(/\\/+$/, \'\')}/${entry}`, budget)') &&
          worker.includes('emitPathSnapshot(newPath)'),
        '@tracecode/runtime-python worker should ship recursive moved-directory live snapshots'
      );
      assertCondition(
        worker.includes('_patched_os_fchmod') &&
          worker.includes('_patched_os_fchown') &&
          worker.includes('if _fd in _proc_file_descriptors:') &&
          worker.includes('Kernel proc path is read-only'),
        '@tracecode/runtime-python worker should ship virtual fd metadata guards'
      );
      assertCondition(
        worker.includes('_patched_os_readv') &&
          worker.includes('_patched_os_writev') &&
          worker.includes('os.readv = _patched_os_readv') &&
          worker.includes('os.writev = _patched_os_writev'),
        '@tracecode/runtime-python worker should ship vectored fd I/O bridge hooks'
      );
      assertCondition(
        worker.includes('def _tracekernel_http_dispatch_async(') &&
          worker.includes('urllib.request.urlopen = _tracekernel_http_urlopen') &&
          worker.includes('_http_client.HTTPConnection = _TraceKernelHTTPConnection') &&
          worker.includes('_requests_module.request = _tracekernel_requests_request') &&
          worker.includes('_requests_module.post = lambda url, **kwargs: _tracekernel_requests_request("POST", url, **kwargs)'),
        '@tracecode/runtime-python worker should ship outbound TraceKernel HTTP client shims'
      );
      assertCondition(
        worker.includes('class _TraceKernelHTTPServer(_TraceKernelTCPServer):') &&
          worker.includes('_http_server.HTTPServer = _TraceKernelHTTPServer') &&
          worker.includes('_http_server.ThreadingHTTPServer = _TraceKernelThreadingHTTPServer') &&
          worker.includes('_socketserver.TCPServer = _TraceKernelTCPServer'),
        '@tracecode/runtime-python worker should ship stdlib HTTPServer/TCPServer TraceKernel listener shims'
      );
      assertCondition(
        worker.includes('class FastAPI:') &&
          worker.includes('_uvicorn_module.run = _uvicorn_run') &&
          worker.includes('sys.modules.setdefault("fastapi", _fastapi_module)') &&
          worker.includes('sys.modules["uvicorn"] = _uvicorn_module'),
        '@tracecode/runtime-python worker should ship FastAPI/uvicorn endpoint shims'
      );
    }
    if (packageCheck.name === '@tracecode/runtime-javascript') {
      const projectBrowser = (
        await Promise.all(
          (await readdir(join(packageDir, 'dist')))
            .filter((file) => file.endsWith('.js'))
            .map((file) => readFile(join(packageDir, 'dist', file), 'utf8'))
        )
      ).join('\n');
      const projectWorker = await readFile(join(packageDir, 'workers/javascript-project-worker.js'), 'utf8');
      // The routed-device output bridge is core code (createRuntimeProjectIoBridge);
      // the externalized project-browser bundle imports it rather than inlining it,
      // so its body is asserted in the fully-bundled worker artifact that runs it.
      assertCondition(
        projectWorker.includes('sourceDevice') &&
          projectWorker.includes('io.output(stream, data, device, sourceDevice)') &&
          projectWorker.includes('device !== outputDevice ? { sourceDevice: device } :'),
        '@tracecode/runtime-javascript browser project runner should ship routed source device output events'
      );
      assertCondition(
        projectBrowser.includes('readRuntimeCommandStdinPipeBytes') &&
          projectBrowser.includes('runtimeCommandStdinPipeRemainingBytes') &&
          projectBrowser.includes('runtimeCommandStdinPipeClosed') &&
          projectBrowser.includes('const readDeviceBytes = (device, size) =>') &&
          projectBrowser.includes('const stdinDevice = createReadableStdinDevice(') &&
          projectBrowser.includes('(size) => readDeviceBytes("/dev/stdin", size)') &&
          projectBrowser.includes('eventLoopApi.setTimeout') &&
          projectBrowser.includes('if (entry.kind === "device") return readDeviceBytes(entry.device ?? "/dev/stdin");'),
        '@tracecode/runtime-javascript browser project runner should share process.stdin and device stdin cursor through live stdin pipes'
      );
      assertCondition(
        projectBrowser.includes('const emitDirectoryCreate = (path) =>') &&
          projectBrowser.includes('directory: true') &&
          projectBrowser.includes('atimeMs: metadata.atimeMs, mtimeMs: metadata.mtimeMs') &&
          projectBrowser.includes('io.fileChange({ path, directory: true, deleted: true }, "live")'),
        '@tracecode/runtime-javascript browser project runner should ship metadata-bearing live directory mutation events'
      );
      assertCondition(
        projectBrowser.includes('readvSync') &&
          projectBrowser.includes('writevSync') &&
          projectBrowser.includes('ftruncateSync') &&
          projectBrowser.includes('descriptorMetadataPath') &&
          projectBrowser.includes('writeFileToHandle') &&
          projectBrowser.includes('appendFileToHandle') &&
          projectBrowser.includes('createWriteStream'),
        '@tracecode/runtime-javascript browser project runner should ship FileHandle/vector/truncate/metadata live I/O bridge'
      );
      assertCondition(
        projectBrowser.includes('runtimeKernelStatTarget') &&
          projectBrowser.includes('statForKernelTarget'),
        '@tracecode/runtime-javascript browser project runner should use shared tracekernel stat targets'
      );
      assertCondition(
        projectBrowser.includes('function createHttpApi(kernelHttp, signal)') &&
          projectBrowser.includes('class TraceKernelRequest') &&
          projectBrowser.includes('class TraceKernelResponse') &&
          projectBrowser.includes('["node:http", httpApi.module]') &&
          projectBrowser.includes('void kernelHttp.dispatch({'),
        '@tracecode/runtime-javascript browser project runner should ship TraceKernel fetch/node:http client and server shims'
      );
      assertCondition(
        projectBrowser.includes('dispatchWorkerKernelHttpRequest') &&
          projectBrowser.includes('handleKernelHttpProtocolMessage') &&
          projectBrowser.includes('kernel-http-dispatch-result') &&
          projectBrowser.includes('kernel-http-request'),
        '@tracecode/runtime-javascript browser project runner should ship the worker-safe HTTP message bridge'
      );
      assertCondition(
        projectWorker.includes('function createHttpApi(kernelHttp, signal)') &&
          projectWorker.includes('class TraceKernelHeaders') &&
          projectWorker.includes('class TraceKernelRequest') &&
          projectWorker.includes('class TraceKernelResponse') &&
          projectWorker.includes('activeHttpBridges.set(id, {') &&
          projectWorker.includes('new TraceKernelSharedSyscallClient(') &&
          projectWorker.includes('new TraceKernelRuntimeFileClient(') &&
          projectWorker.includes('WorkerKernelAsyncSyscallClient = class') &&
          projectWorker.includes('function createNetApi(') &&
          projectWorker.includes('["node:net", netApi.module]') &&
          projectWorker.includes('"kernel-syscall"') &&
          projectWorker.includes('"kernel-syscall-async"') &&
          projectWorker.includes('protocolToken !== command.protocolToken') &&
          projectWorker.includes('["node:http", httpApi.module]'),
        '@tracecode/runtime-javascript packaged project worker should include TraceKernel fs, node:net, and node:http bridges'
      );
    }
    if (packageCheck.name === '@tracecode/runtime-java') {
      const declarationPaths = [
        'dist/index.d.ts',
        'dist/project-browser.d.ts',
        'dist/java-project.d.ts',
      ] as const;
      const declarationLeaks: string[] = [];
      for (const declarationPath of declarationPaths) {
        const declaration = await readFile(join(packageDir, declarationPath), 'utf8');
        if (/(?:TraceJVM|CheerpJ)/iu.test(declaration)) {
          declarationLeaks.push(declarationPath);
        }
      }
      assertCondition(
        declarationLeaks.length === 0,
        `@tracecode/runtime-java public declarations must be implementation-neutral: ${declarationLeaks.join(', ')}`
      );
      const javaPackageJson = JSON.parse(
        await readFile(join(packageDir, 'package.json'), 'utf8')
      ) as { exports?: Record<string, unknown> };
      const javaSubpaths = Object.keys(javaPackageJson.exports ?? {});
      assertCondition(
        javaSubpaths.includes('./java-project') &&
          javaSubpaths.every((subpath) => !/(?:tracejvm|cheerpj)/iu.test(subpath)),
        `@tracecode/runtime-java public subpaths must be implementation-neutral: ${javaSubpaths.join(', ')}`
      );
      assertCondition(
        ![...packedFiles].some((path) => /dist\/(?:tracejvm|cheerpj)/iu.test(path)),
        '@tracecode/runtime-java tarball must not retain engine-branded public entrypoints'
      );
      const worker = await readFile(join(packageDir, 'workers/java-worker.js'), 'utf8');
      assertCondition(
        worker.includes('new tracecode.browser.ProjectEvents.ProjectFile('),
        '@tracecode/runtime-java worker should ship java.io.File live-mutation rewrites'
      );
      assertCondition(
        worker.includes('emitLiveJavaProjectDirectoryCreate') &&
          worker.includes('emitLiveJavaProjectDirectoryDelete') &&
          worker.includes('Java_tracecode_browser_ProjectEvents_emitDirectoryCreateNative') &&
          worker.includes('Java_tracecode_browser_ProjectEvents_emitDirectoryDeleteNative') &&
          worker.includes('createFile|createDirectory|createDirectories'),
        '@tracecode/runtime-java worker should ship live directory mutation bridge hooks'
      );
      assertCondition(
        worker.includes("emitLiveJavaProjectOutput(String(bridgeRunId ?? ''), String(stream ?? 'stdout'), String(data ?? ''), String(sourceDevice ?? ''), String(outputDevice ?? ''))") &&
          worker.includes('shared-kernel-policy-loaded') &&
          worker.includes('self.TraceRuntimeKernelPolicy') &&
          worker.includes('runtimeKernelDeviceOutputTarget') &&
          worker.includes('normalizeRuntimeKernelManifestDevicePath') &&
          worker.includes('normalizeRuntimeKernelPath') &&
          worker.includes('isRuntimeKernelDeviceNamespacePath') &&
          worker.includes('sourceDevice') &&
          worker.includes('outputDevicePath'),
        '@tracecode/runtime-java worker should load shared worker kernel policy for routed source, output device, and kernel manifest path decisions'
      );
      assertCondition(
        worker.includes('projectKernelFileManifest') &&
          worker.includes('ProjectEvents.setKernelFiles('),
        '@tracecode/runtime-java worker should ship manifest kernel file bridge setup'
      );
      assertCondition(
        worker.includes('Java_tracecode_browser_ProjectEvents_registerHttpServerNative') &&
          worker.includes('Java_tracecode_browser_ProjectEvents_pollHttpServerRequestNative') &&
          worker.includes('Java_tracecode_browser_ProjectEvents_completeHttpServerRequestNative') &&
          worker.includes('closeAllJavaProjectHttpServers()') &&
          worker.includes('registerJavaProjectHttpServerSync'),
        '@tracecode/runtime-java worker should ship Java HttpServer TraceKernel listener bridge hooks'
      );
      assertCondition(
        worker.includes('HttpClient\\.newHttpClient') &&
          worker.includes('tracecode.browser.ProjectEvents.httpClient(') &&
          worker.includes('HttpClient\\.newBuilder') &&
          worker.includes('tracecode.browser.ProjectEvents.httpClientBuilder(') &&
          worker.includes('HttpServer\\.create') &&
          worker.includes('tracecode.browser.ProjectEvents.httpServer('),
        '@tracecode/runtime-java worker should rewrite Java HTTP clients and HttpServer creation into TraceKernel shims'
      );
      assertCondition(
        worker.includes('newInputStream|newBufferedReader') &&
          worker.includes('readAllLines|lines|list') &&
          worker.includes('isReadable|isWritable|size'),
        '@tracecode/runtime-java worker should ship NIO read/stat device rewrites'
      );
      const helperJarListing = spawnSync('jar', ['tf', join(packageDir, 'workers/vendor/java-browser-helper.jar')], {
        encoding: 'utf8',
      });
      if (helperJarListing.status !== 0) {
        throw new Error(helperJarListing.stderr || helperJarListing.stdout || '@tracecode/runtime-java helper jar listing failed');
      }
      assertCondition(
        helperJarListing.stdout.includes('tracecode/browser/ProjectEvents$ProjectFile.class'),
        '@tracecode/runtime-java helper jar should include ProjectEvents.ProjectFile'
      );
      assertCondition(
        helperJarListing.stdout.includes('tracecode/browser/ProjectEvents$ProjectHttpClient.class') &&
          helperJarListing.stdout.includes('tracecode/browser/ProjectEvents$ProjectHttpURLConnection.class') &&
          helperJarListing.stdout.includes('tracecode/browser/ProjectEvents$ProjectHttpServer.class') &&
          helperJarListing.stdout.includes('tracecode/browser/ProjectEvents$ProjectHttpExchange.class') &&
          helperJarListing.stdout.includes('tracecode/browser/ProjectEvents$TraceKernelHttpResponse.class'),
        '@tracecode/runtime-java helper jar should include TraceKernel HTTP client and server bridge classes'
      );
      const helperApi = spawnSync(
        'javap',
        ['-classpath', join(packageDir, 'workers/vendor/java-browser-helper.jar'), '-private', 'tracecode.browser.ProjectEvents'],
        { encoding: 'utf8' }
      );
      if (helperApi.status !== 0) {
        throw new Error(helperApi.stderr || helperApi.stdout || '@tracecode/runtime-java helper jar API listing failed');
      }
      assertCondition(
        helperApi.stdout.includes('emitOutputNative(java.lang.String, java.lang.String, java.lang.String, java.lang.String, java.lang.String)'),
        '@tracecode/runtime-java helper jar should expose run-bound source/output-device native bridge'
      );
      assertCondition(
        helperApi.stdout.includes('emitDirectoryCreateNative(java.lang.String, java.lang.String)') &&
          helperApi.stdout.includes('emitDirectoryDeleteNative(java.lang.String, java.lang.String)'),
        '@tracecode/runtime-java helper jar should expose run-bound directory native bridge hooks'
      );
      assertCondition(
        helperApi.stdout.includes('setKernelFiles(java.lang.String)'),
        '@tracecode/runtime-java helper jar should expose manifest kernel file bridge'
      );
      assertCondition(
        helperApi.stdout.includes('inputStream()'),
        '@tracecode/runtime-java helper jar should expose shared stdin input stream'
      );
      assertCondition(
        helperApi.stdout.includes('httpClient()') &&
          helperApi.stdout.includes('httpClientBuilder()') &&
          helperApi.stdout.includes('httpServer()') &&
          helperApi.stdout.includes('httpServer(java.net.InetSocketAddress, int)') &&
          helperApi.stdout.includes('registerHttpServerNative(java.lang.String, int)') &&
          helperApi.stdout.includes('pollHttpServerRequestNative(java.lang.String)') &&
          helperApi.stdout.includes('completeHttpServerRequestNative(java.lang.String, java.lang.String)') &&
          helperApi.stdout.includes('closeHttpServerNative(java.lang.String)'),
        '@tracecode/runtime-java helper jar should expose TraceKernel HTTP client/server bridge methods'
      );
      assertCondition(
        helperApi.stdout.includes('newInputStream(java.nio.file.Path, java.nio.file.OpenOption...)') &&
          helperApi.stdout.includes('newBufferedReader(java.nio.file.Path, java.nio.charset.Charset)') &&
          helperApi.stdout.includes('readAllLines(java.nio.file.Path, java.nio.charset.Charset)') &&
          helperApi.stdout.includes('lines(java.nio.file.Path, java.nio.charset.Charset)') &&
          helperApi.stdout.includes('isReadable(java.nio.file.Path)') &&
          helperApi.stdout.includes('isWritable(java.nio.file.Path)') &&
          helperApi.stdout.includes('size(java.nio.file.Path)'),
        '@tracecode/runtime-java helper jar should expose NIO read/stat device bridge'
      );
      const streamingOutputApi = spawnSync(
        'javap',
        ['-classpath', join(packageDir, 'workers/vendor/java-browser-helper.jar'), '-c', 'tracecode.browser.ProjectEvents$StreamingProjectOutputStream'],
        { encoding: 'utf8' }
      );
      if (streamingOutputApi.status !== 0) {
        throw new Error(streamingOutputApi.stderr || streamingOutputApi.stdout || '@tracecode/runtime-java streaming output API listing failed');
      }
      assertCondition(
        streamingOutputApi.stdout.includes('public void write(int) throws java.io.IOException;') &&
          streamingOutputApi.stdout.includes('public void write(byte[], int, int) throws java.io.IOException;') &&
          streamingOutputApi.stdout.includes('invokevirtual #') &&
          streamingOutputApi.stdout.includes('// Method flush:()V'),
        '@tracecode/runtime-java helper jar should flush live stdio after unbuffered writes'
      );
      const fileWriterApi = spawnSync(
        'javap',
        ['-classpath', join(packageDir, 'workers/vendor/java-browser-helper.jar'), '-c', 'tracecode.browser.ProjectEvents$ProjectFileWriter'],
        { encoding: 'utf8' }
      );
      if (fileWriterApi.status !== 0) {
        throw new Error(fileWriterApi.stderr || fileWriterApi.stdout || '@tracecode/runtime-java file writer API listing failed');
      }
      const fileOutputStreamApi = spawnSync(
        'javap',
        ['-classpath', join(packageDir, 'workers/vendor/java-browser-helper.jar'), '-c', 'tracecode.browser.ProjectEvents$ProjectFileOutputStream'],
        { encoding: 'utf8' }
      );
      if (fileOutputStreamApi.status !== 0) {
        throw new Error(fileOutputStreamApi.stderr || fileOutputStreamApi.stdout || '@tracecode/runtime-java file output stream API listing failed');
      }
      assertCondition(
        fileWriterApi.stdout.includes('// Method emitOpenSnapshot:(Z)V') &&
          fileOutputStreamApi.stdout.includes('// Method emitOpenSnapshot:(Z)V'),
        '@tracecode/runtime-java helper jar should emit live snapshots for classic open/truncate constructors'
      );
    }
    if (packageCheck.name === '@tracecode/runtime-csharp') {
      const csharpPublicDeclarations = await readDeclarationTree(join(packageDir, 'dist'));
      assertCondition(
        csharpPublicDeclarations.includes('runtimeCommand?: string') &&
          !/roslyn|dotnet|\.net/i.test(csharpPublicDeclarations),
        '@tracecode/runtime-csharp declarations must expose the language-owned runtime command without provider branding'
      );
      const csharpReadme = await readFile(join(packageDir, 'README.md'), 'utf8');
      assertCondition(
        !/roslyn|dotnet|\.net/i.test(csharpReadme),
        '@tracecode/runtime-csharp packaged documentation must remain provider-neutral'
      );
      const worker = await readFile(join(packageDir, 'workers/csharp-worker.js'), 'utf8');
      assertCondition(
        !worker.includes('FALLBACK_KERNEL_DEVICES'),
        '@tracecode/runtime-csharp worker should not ship fallback kernel device inventory'
      );
      assertCondition(
        worker.includes('sourceDevice') &&
          worker.includes('const currentSourceDevice = stream === \'stdout\' ? context.stdoutSourceDevice : context.stderrSourceDevice') &&
          worker.includes('flushProjectOutput(stream)') &&
          worker.includes('context.stdoutSourceDevice = nextSourceDevice'),
        '@tracecode/runtime-csharp worker should ship routed source device events and flush on device changes'
      );
      assertCondition(
        worker.includes('readProjectInputByte: () => readProjectInputByte(\'/dev/stdin\') ?? -1'),
        '@tracecode/runtime-csharp worker should route managed stdin through the kernel stdin cursor'
      );
      assertCondition(
        worker.includes('function isCreateOrTruncateOpenFlags(') &&
          worker.includes('fs.open = function openWithProjectEvents') &&
          worker.includes('emitProjectFileSnapshot(stream.path)'),
        '@tracecode/runtime-csharp worker should ship live empty-open file mutation hooks'
      );
      assertCondition(
        worker.includes("const CSHARP_PROJECT_WORKSPACE_ROOT = '/tmp/tracecode-csharp-project'") &&
          worker.includes('function runtimeFsPath(') &&
          worker.includes('emitProjectPathSnapshot(runtimeFsPath(path) || path)'),
        '@tracecode/runtime-csharp worker should map provider-root live events back to project paths'
      );
      assertCondition(
        worker.includes('emitProjectDirectoryCreate(path)') &&
          worker.includes('emitProjectDirectoryDelete(path)') &&
          worker.includes('fs.mkdir = function mkdirWithProjectEvents') &&
          worker.includes('fs.rmdir = function rmdirWithProjectEvents') &&
          worker.includes('emitProjectPathSnapshot(newPath)'),
        '@tracecode/runtime-csharp worker should ship provider-level live directory mutation hooks'
      );
      assertCondition(
        worker.includes('let materializedKernelDevicePaths = new Set()') &&
          worker.includes('materializedKernelDevicePaths.add(devicePath)') &&
          worker.includes('shared-kernel-policy-loaded') &&
          worker.includes('self.TraceRuntimeKernelPolicy') &&
          worker.includes('runtimeKernelVirtualOpenTarget(path, flags)') &&
          worker.includes('runtimeKernelVirtualMutationTarget(path)') &&
          worker.includes('readOnlyPaths: kernelVirtualManifestPaths(request)') &&
          worker.includes('function isReadableOpenFlags(flags)') &&
          worker.includes('function isKernelDeviceNamespacePath(value)') &&
          worker.includes("runtimeKernelDeviceOutputTarget(kernelDeviceEntries(request), path)"),
        '@tracecode/runtime-csharp worker should load shared worker kernel policy for manifest-scoped /dev cleanup and namespace guards'
      );
      assertCondition(
        worker.includes('function emitMissingProjectResultOutput(result)') &&
          worker.includes('context.eventStdout.join(\'\') !== stdout'),
        '@tracecode/runtime-csharp worker should stream returned compiler/build output events'
      );
      const csharpSupportFilesDir = join(packageDir, 'workers/vendor/csharp/_framework/supportFiles');
      const csharpHostDllName = (await readdir(csharpSupportFilesDir)).find((entry) => entry.endsWith('TraceCode.CSharpHost.dll'));
      assertCondition(Boolean(csharpHostDllName), '@tracecode/runtime-csharp should ship TraceCode.CSharpHost support file');
      const csharpHostDll = await readFile(join(csharpSupportFilesDir, csharpHostDllName!));
      const csharpHostApi = `${csharpHostDll.toString('utf8')}\n${csharpHostDll.toString('utf16le')}`;
      assertCondition(
        csharpHostApi.includes('ReadProjectInputByte') &&
          csharpHostApi.includes('IsProjectFileMutationMethod') &&
          csharpHostApi.includes('EmitLiveProjectFileSnapshot'),
        '@tracecode/runtime-csharp worker should ship managed project stdin and live file bridge methods'
      );
    }
    if (packageCheck.name === '@tracecode/runtime-native') {
      const nativeDeclarations = await readDeclarationTree(join(packageDir, 'dist'));
      assertCondition(
        nativeDeclarations.includes('csharpCommand?: string') &&
          !/roslyn|dotnet|\.net/i.test(nativeDeclarations),
        '@tracecode/runtime-native declarations must expose csharpCommand without provider branding'
      );
    }
    if (packageCheck.name === '@tracecode/runtime-cpp') {
      const worker = await readFile(join(packageDir, 'workers/cpp-worker.js'), 'utf8');
      const declarations = await readDeclarationTree(join(packageDir, 'dist'));
      assertCondition(
        declarations.includes('CppCompilerIntegrityManifest') &&
          declarations.includes('compilerWasmUrl') &&
          declarations.includes('linkerWasmUrl') &&
          declarations.includes('compilerIntegrity') &&
          !/(?:YoWASP|CppToolchain|clangWasmUrl|lldWasmUrl|toolchainIntegrity)/iu.test(declarations),
        '@tracecode/runtime-cpp declarations must expose the language-owned compiler contract'
      );
      assertCondition(
        worker.includes('function standaloneKernelDevices()') &&
          !worker.includes('options.kernelDevices instanceof Map ? options.kernelDevices : projectKernelDevices()'),
        '@tracecode/runtime-cpp worker should keep standalone stdio separate from project kernel devices'
      );
      assertCondition(
        worker.includes('sourceDevice') &&
          worker.includes('this.onOutput?.(stream, decodeUtf8(concatBytes(outputChunks)), entry.device, entry.outputDevice)') &&
          worker.includes('const resolvedOutputDevice = outputDevice || (stream === \'stderr\' ? \'/dev/stderr\' : \'/dev/stdout\')'),
        '@tracecode/runtime-cpp worker should ship stdio source and resolved output device events'
      );
      assertCondition(
        worker.includes('directory: true') &&
          worker.includes('this.fileChangeObserver?.({ path: normalized, directory: true, metadata: { ...this.getMetadata(normalized) } })') &&
          worker.includes('this.fileChangeObserver?.({ path: normalized, directory: true, deleted: true })'),
        '@tracecode/runtime-cpp worker should ship metadata-bearing live directory mutation events'
      );
      assertCondition(
        worker.includes('function emitProjectResultOutputEvents(events, result)') &&
          worker.includes('emitProjectResultOutputEvents(events, result)'),
        '@tracecode/runtime-cpp worker should stream returned compiler output events'
      );
      assertCondition(
        worker.includes("from './shared/runtime-kernel-policy.js'") &&
          worker.includes('runtimeKernelVirtualPathTarget(pathname') &&
          worker.includes('runtimeKernelVirtualMutationTarget(pathname') &&
          worker.includes('knownDevices: this.knownKernelDevices'),
        '@tracecode/runtime-cpp worker should classify and guard manifest kernel namespaces with shared worker kernel policy'
      );
      assertCondition(
        worker.includes('emitPathSnapshot(pathname)') &&
          worker.includes('this.fs.emitPathSnapshot(normalized)') &&
          worker.includes('bytes: this.readFile(normalized), metadata: { ...this.getMetadata(normalized) }'),
        '@tracecode/runtime-cpp worker should ship metadata-only live file snapshots'
      );
    }

    const packedPackageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    if (packageCheck.name === '@tracecode/runtime-browser') {
      const sourcePackageJson = JSON.parse(
        await readFile(join(process.cwd(), packageCheck.dir, 'package.json'), 'utf8')
      ) as { dependencies?: Record<string, string> };
      assertCondition(
        packedPackageJson.dependencies?.['@tracecode/tracejvm'] ===
          sourcePackageJson.dependencies?.['@tracecode/tracejvm'],
        '@tracecode/runtime-browser should declare the TraceJVM dependency imported by its project bundle'
      );
      assertCondition(
        !Object.prototype.hasOwnProperty.call(packedPackageJson.dependencies ?? {}, 'just-bash'),
        '@tracecode/runtime-browser should not install just-bash unless consumers opt into project workspace primitives'
      );
      for (const languagePackage of [
        '@tracecode/runtime-python',
        '@tracecode/runtime-javascript',
        '@tracecode/runtime-java',
        '@tracecode/runtime-csharp',
        '@tracecode/runtime-cpp',
      ]) {
        assertCondition(
          !Object.prototype.hasOwnProperty.call(packedPackageJson.dependencies ?? {}, languagePackage),
          `@tracecode/runtime-browser must not depend on ${languagePackage}`
        );
      }
      const browserDeclarations = await readFile(join(packageDir, 'dist/index.d.ts'), 'utf8');
      assertCondition(
        browserDeclarations.includes('getRuntimeProjectIoSupport') &&
          browserDeclarations.includes('RuntimeProjectIoSupport'),
        '@tracecode/runtime-browser declarations should export the derived project I/O support helper'
      );
      assertCondition(
        browserDeclarations.includes('createBrowserRuntimeProviderRegistry') &&
          browserDeclarations.includes('BrowserRuntimeProviderRegistry'),
        '@tracecode/runtime-browser declarations should export provider-registry composition'
      );
      const browserDistDir = join(packageDir, 'dist');
      const browserProjectDist = (
        await Promise.all(
          (await readdir(browserDistDir))
            .filter((file) => file.endsWith('.js'))
            .map((file) => readFile(join(browserDistDir, file), 'utf8'))
        )
      ).join('\n');
      assertCondition(
        browserProjectDist.includes('enqueueKernelHttpSyncServerRequest(bridge, request, runtimeLabel)') &&
          browserProjectDist.includes('drainKernelHttpSyncServerQueue(bridge, runtimeLabel)') &&
          browserProjectDist.includes('dispatchKernelHttpSyncServerRequest(bridge, entry.request, runtimeLabel)') &&
          browserProjectDist.includes('Service Unavailable\\n'),
        '@tracecode/runtime-browser project bundle should ship the shared queued sync HTTP server bridge'
      );
      const browserOnlyAppDir = join(tempRoot, 'browser-only-app');
      const browserOnlyPackageDir = packageNodeModulesDir(browserOnlyAppDir, packageCheck.name);
      await mkdir(browserOnlyPackageDir, { recursive: true });
      await writeFile(
        join(browserOnlyAppDir, 'package.json'),
        JSON.stringify({
          type: 'module',
          private: true,
          dependencies: {},
        }),
        'utf8'
      );
      const browserOnlyExtract = spawnSync('tar', ['-xf', tarballPath, '-C', browserOnlyPackageDir, '--strip-components=1'], {
        encoding: 'utf8',
      });
      if (browserOnlyExtract.status !== 0) {
        throw new Error(browserOnlyExtract.stderr || browserOnlyExtract.stdout || '@tracecode/runtime-browser isolated extraction failed');
      }
      // runtime-browser declares a runtime dependency on @tracecode/runtime-contracts,
      // so an isolated consumer install must resolve it too (npm would install it
      // transitively). Extract it alongside into the browser-only app.
      const coreCheck = PACKAGE_CHECKS.find((check) => check.name === '@tracecode/runtime-contracts');
      if (!coreCheck) {
        throw new Error('@tracecode/runtime-contracts package check is required to satisfy runtime-browser isolated imports');
      }
      const browserOnlyCoreDir = packageNodeModulesDir(browserOnlyAppDir, coreCheck.name);
      await mkdir(browserOnlyCoreDir, { recursive: true });
      const coreOnlyPack = spawnSync(pnpmCommand, ['pack', '--pack-destination', tempRoot], {
        cwd: join(process.cwd(), coreCheck.dir),
        encoding: 'utf8',
      });
      if (coreOnlyPack.status !== 0) {
        throw new Error(spawnFailure(coreOnlyPack, '@tracecode/runtime-contracts pack for browser-only app failed'));
      }
      const coreOnlyTarballName = String(coreOnlyPack.stdout || '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .at(-1);
      assertCondition(Boolean(coreOnlyTarballName), '@tracecode/runtime-contracts pack should print a tarball for the browser-only app');
      const coreOnlyTarballPath = isAbsolute(coreOnlyTarballName!) ? coreOnlyTarballName! : join(tempRoot, coreOnlyTarballName!);
      const browserOnlyCoreExtract = spawnSync('tar', ['-xf', coreOnlyTarballPath, '-C', browserOnlyCoreDir, '--strip-components=1'], {
        encoding: 'utf8',
      });
      if (browserOnlyCoreExtract.status !== 0) {
        throw new Error(browserOnlyCoreExtract.stderr || browserOnlyCoreExtract.stdout || '@tracecode/runtime-contracts isolated extraction failed');
      }
      const traceKernelCheck = PACKAGE_CHECKS.find((check) => check.name === '@tracecode/tracekernel');
      if (!traceKernelCheck) {
        throw new Error('@tracecode/tracekernel package check is required to satisfy runtime-browser isolated imports');
      }
      const browserOnlyTraceKernelDir = packageNodeModulesDir(browserOnlyAppDir, traceKernelCheck.name);
      await mkdir(browserOnlyTraceKernelDir, { recursive: true });
      const traceKernelOnlyPack = spawnSync(pnpmCommand, ['pack', '--pack-destination', tempRoot], {
        cwd: join(process.cwd(), traceKernelCheck.dir),
        encoding: 'utf8',
      });
      if (traceKernelOnlyPack.status !== 0) {
        throw new Error(spawnFailure(traceKernelOnlyPack, '@tracecode/tracekernel pack for browser-only app failed'));
      }
      const traceKernelOnlyTarballName = String(traceKernelOnlyPack.stdout || '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .at(-1);
      assertCondition(
        Boolean(traceKernelOnlyTarballName),
        '@tracecode/tracekernel pack should print a tarball for the browser-only app'
      );
      const traceKernelOnlyTarballPath = isAbsolute(traceKernelOnlyTarballName!)
        ? traceKernelOnlyTarballName!
        : join(tempRoot, traceKernelOnlyTarballName!);
      const browserOnlyTraceKernelExtract = spawnSync(
        'tar',
        ['-xf', traceKernelOnlyTarballPath, '-C', browserOnlyTraceKernelDir, '--strip-components=1'],
        { encoding: 'utf8' }
      );
      if (browserOnlyTraceKernelExtract.status !== 0) {
        throw new Error(
          browserOnlyTraceKernelExtract.stderr ||
            browserOnlyTraceKernelExtract.stdout ||
            '@tracecode/tracekernel isolated extraction failed'
        );
      }
      await cp(
        join(process.cwd(), 'node_modules', 'effect'),
        join(browserOnlyAppDir, 'node_modules', 'effect'),
        { recursive: true, dereference: true }
      );
      await cp(
        join(process.cwd(), 'node_modules', '@tracecode', 'tracejvm'),
        join(browserOnlyAppDir, 'node_modules', '@tracecode', 'tracejvm'),
        { recursive: true, dereference: true }
      );
      const browserOnlyImportScript = `
        (async () => {
          const main = await import('@tracecode/runtime-browser');
          if (typeof main.createBrowserProjectWorkspace !== 'undefined') {
            throw new Error('@tracecode/runtime-browser main export should not expose project workspace helpers');
          }
          const project = await import('@tracecode/runtime-browser/project');
          if (typeof project.createBrowserProjectWorkspace !== 'function') {
            throw new Error('@tracecode/runtime-browser/project missing createBrowserProjectWorkspace');
          }
          const workspace = await project.createBrowserProjectWorkspace({
            providers: ['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp'],
            files: [
              { path: 'index.js', contents: 'console.log("browser-only-node")\\n' },
              { path: 'main.py', contents: 'print("browser-only-python")\\n' },
              { path: 'Main.java', contents: 'class Main {}\\n' },
              { path: 'Program.cs', contents: 'Console.WriteLine("browser-only-csharp");\\n' },
              { path: 'main.cpp', contents: 'int main() { return 0; }\\n' },
            ],
            runtimeProviders: {
              python: {
                async execute(request) {
                  return { stdout: request.scriptPath + ':browser-only-python\\n', stderr: '', exitCode: 0 };
                },
              },
              java: {
                async execute(request) {
                  return { stdout: request.source + ':' + request.scriptPath + ':browser-only-java\\n', stderr: '', exitCode: 0 };
                },
              },
              csharp: {
                async execute(request) {
                  return { stdout: request.source + ':' + request.args.join(',') + ':browser-only-csharp\\n', stderr: '', exitCode: 0 };
                },
              },
              cpp: {
                async execute(request) {
                  return { stdout: request.source + ':' + request.args.join(',') + ':browser-only-cpp\\n', stderr: '', exitCode: 0 };
                },
              },
            },
            nodeProject: {
              allowMainThreadExecution: true,
              trustedMainThreadExecution: true,
            },
          });
          try {
            const node = await workspace.runCommand('node index.js');
            if (node.exitCode !== 0 || node.stdout !== 'browser-only-node\\n') {
              throw new Error('isolated browser project Node command failed: ' + JSON.stringify(node));
            }
            const python = await workspace.runCommand('python3 main.py');
            if (python.exitCode !== 0 || python.stdout !== 'main.py:browser-only-python\\n') {
              throw new Error('isolated browser project Python command failed: ' + JSON.stringify(python));
            }
            const java = await workspace.runCommand('java Main');
            if (java.exitCode !== 0 || java.stdout !== 'run:Main:browser-only-java\\n') {
              throw new Error('isolated browser project Java command failed: ' + JSON.stringify(java));
            }
            const csharp = await workspace.runCommand('dotnet run -- alpha beta');
            if (csharp.exitCode !== 0 || csharp.stdout !== 'run:alpha,beta:browser-only-csharp\\n') {
              throw new Error('isolated browser project C# command failed: ' + JSON.stringify(csharp));
            }
            const cpp = await workspace.runCommand('clang++ main.cpp -o a.out');
            if (cpp.exitCode !== 0 || cpp.stdout !== 'compile:main.cpp,-o,a.out:browser-only-cpp\\n') {
              throw new Error('isolated browser project C++ command failed: ' + JSON.stringify(cpp));
            }
            const cppRun = await workspace.runCommand('./a.out alpha beta');
            if (cppRun.exitCode !== 0 || cppRun.stdout !== 'run:alpha,beta:browser-only-cpp\\n') {
              throw new Error('isolated browser project C++ run command failed: ' + JSON.stringify(cppRun));
            }
          } finally {
            workspace.dispose();
          }
          console.log('ok');
        })().catch((error) => {
          console.error(error);
          process.exit(1);
        });
      `;
      const browserOnlyImportRun = spawnSync('node', ['-e', browserOnlyImportScript], {
        cwd: browserOnlyAppDir,
        encoding: 'utf8',
      });
      if (browserOnlyImportRun.status !== 0) {
        throw new Error(
          browserOnlyImportRun.stderr ||
            browserOnlyImportRun.stdout ||
            '@tracecode/runtime-browser/project should work as an isolated bundled project-mode subpath'
        );
      }
    }
    if (packageCheck.name === '@tracecode/tracekernel') {
      assertCondition(
        packedPackageJson.dependencies?.['just-bash'] === '3.1.0',
        '@tracecode/tracekernel should declare the just-bash-backed workspace dependency'
      );
    }
    const browserProviderExports: Record<string, string> = {
      '@tracecode/runtime-python': 'createPythonBrowserRuntimeProvider',
      '@tracecode/runtime-javascript': 'createJavaScriptBrowserRuntimeProvider',
      '@tracecode/runtime-java': 'createJavaBrowserRuntimeProvider',
      '@tracecode/runtime-csharp': 'createCSharpBrowserRuntimeProvider',
      '@tracecode/runtime-cpp': 'createCppBrowserRuntimeProvider',
    };
    const browserProviderExport = browserProviderExports[packageCheck.name];
    if (browserProviderExport) {
      assertCondition(
        Boolean(packedPackageJson.dependencies?.['@tracecode/runtime-browser']),
        `${packageCheck.name} should declare its generic browser-host dependency`
      );
      const indexTypes = await readFile(join(packageDir, 'dist/index.d.ts'), 'utf8');
      assertCondition(
        indexTypes.includes(browserProviderExport),
        `${packageCheck.name} main declarations should export ${browserProviderExport}`
      );
    }
    const browserRunnerTypeAliases: Record<string, string> = {
      '@tracecode/runtime-python': 'BrowserPythonProjectCommandRunner',
      '@tracecode/runtime-javascript': 'BrowserJavaScriptProjectCommandRunner',
      '@tracecode/runtime-java': 'BrowserJavaProjectCommandRunner',
      '@tracecode/runtime-csharp': 'BrowserCSharpProjectCommandRunner',
      '@tracecode/runtime-cpp': 'BrowserCppProjectCommandRunner',
    };
    const browserRunnerTypeAlias = browserRunnerTypeAliases[packageCheck.name];
    if (browserRunnerTypeAlias) {
      const indexTypes = await readFile(join(packageDir, 'dist/index.d.ts'), 'utf8');
      const projectBrowserTypes = await readFile(join(packageDir, 'dist/project-browser.d.ts'), 'utf8');
      assertCondition(
        indexTypes.includes(browserRunnerTypeAlias),
        `${packageCheck.name} main declarations should export ${browserRunnerTypeAlias}`
      );
      assertCondition(
        projectBrowserTypes.includes(browserRunnerTypeAlias),
        `${packageCheck.name}/project-browser declarations should export ${browserRunnerTypeAlias}`
      );
    }
  }

  const nonProjectImportScript = `
    (async () => {
      const checks = ${JSON.stringify(PACKAGE_CHECKS
        .map(({ name, exportName }) => ({ name, exportName })))};
      for (const check of checks) {
        const mod = await import(check.name);
        if (typeof mod[check.exportName] !== 'function') {
          throw new Error(check.name + ' missing ' + check.exportName);
        }
      }
      const browser = await import('@tracecode/runtime-browser');
      if (typeof browser.createBrowserProjectWorkspace !== 'undefined') {
        throw new Error('@tracecode/runtime-browser main export should not include project workspace helpers');
      }
      const python = await import('@tracecode/runtime-python');
      const javascript = await import('@tracecode/runtime-javascript');
      const java = await import('@tracecode/runtime-java');
      const csharp = await import('@tracecode/runtime-csharp');
      const cpp = await import('@tracecode/runtime-cpp');
      for (const [name, mod, projectExport, browserProviderExport] of [
        ['@tracecode/runtime-python', python, 'createNativePythonProjectRunner', 'createPythonBrowserRuntimeProvider'],
        ['@tracecode/runtime-javascript', javascript, 'createNativeJavaScriptProjectRunner', 'createJavaScriptBrowserRuntimeProvider'],
        ['@tracecode/runtime-java', java, 'createNativeJavaProjectRunner', 'createJavaBrowserRuntimeProvider'],
        ['@tracecode/runtime-csharp', csharp, 'createNativeCSharpProjectRunner', 'createCSharpBrowserRuntimeProvider'],
        ['@tracecode/runtime-cpp', cpp, 'createNativeCppProjectRunner', 'createCppBrowserRuntimeProvider'],
      ]) {
        if (typeof mod[projectExport] !== 'function') {
          throw new Error(name + ' missing additive project runner export ' + projectExport);
        }
        if (typeof mod[browserProviderExport] !== 'function') {
          throw new Error(name + ' missing browser provider export ' + browserProviderExport);
        }
      }
      console.log('ok');
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
  const nonProjectImportRun = spawnSync('node', ['-e', nonProjectImportScript], {
    cwd: appDir,
    encoding: 'utf8',
  });
  if (nonProjectImportRun.status !== 0) {
    throw new Error(
      nonProjectImportRun.stderr ||
        nonProjectImportRun.stdout ||
        'Non-project package imports should not require just-bash'
    );
  }

  await writeFile(
    join(appDir, 'package.json'),
    JSON.stringify({
      type: 'module',
      private: true,
      dependencies: {
        'just-bash': '3.1.0',
      },
    }),
    'utf8'
  );
  const install = spawnSync(pnpmCommand, ['install', '--prod', '--ignore-scripts'], {
    cwd: appDir,
    encoding: 'utf8',
  });
  if (install.status !== 0) {
    throw new Error(spawnFailure(install, 'Language package dependency install failed'));
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
      const projectMod = await import('@tracecode/tracekernel/workspace');
      const coreMod = await import('@tracecode/runtime-contracts');
      for (const exportName of [
        'createRuntimeWorkspace',
        'createPythonProjectCommands',
        'createNodeProjectCommands',
        'createJavaProjectCommands',
        'createCppProjectCommands',
        'createCSharpProjectCommands',
        'normalizeRuntimeProjectPath',
      ]) {
        if (typeof projectMod[exportName] !== 'function') {
          throw new Error('@tracecode/tracekernel/workspace missing ' + exportName);
        }
      }
      const projectWorkspace = await projectMod.createRuntimeWorkspace({
        kernel: {
          user: { id: 'surface-user-123', username: 'surface' },
          host: { hostname: 'tracevm-surface' },
          workspace: { id: 'surface-project-1', name: 'surface-project', startedAt: '2026-05-17T12:00:00.000Z' },
        },
        files: [{ path: 'hello.txt', contents: 'hello\\n' }],
      });
      const projectCat = await projectWorkspace.runCommand('cat hello.txt');
      if (projectCat.stdout !== 'hello\\n' || projectCat.exitCode !== 0) {
        throw new Error('@tracecode/tracekernel/workspace command smoke failed');
      }
      if (projectWorkspace.cwd !== '/home/surface/surface-project') {
        throw new Error('@tracecode/tracekernel/workspace cwd mismatch: ' + projectWorkspace.cwd);
      }
      if (projectWorkspace.kernel.info.name !== 'tracekernel' || projectWorkspace.kernel.info.workspaceAlias !== '/workspace') {
        throw new Error('@tracecode/tracekernel/workspace kernel info missing: ' + JSON.stringify(projectWorkspace.kernel.info));
      }
      await projectWorkspace.writeFile('/workspace/alias.txt', 'alias\\n');
      if ((await projectWorkspace.readFile('/home/surface/surface-project/alias.txt')) !== 'alias\\n') {
        throw new Error('@tracecode/tracekernel/workspace /workspace alias smoke failed');
      }
      const mountInfo = await projectWorkspace.readFile('/proc/self/mountinfo');
      if (!mountInfo.includes('tracekernel:workspace') || !mountInfo.includes(' /workspace ')) {
        throw new Error('@tracecode/tracekernel/workspace mountinfo smoke failed: ' + mountInfo);
      }
      const outputEvents = [];
      const output = await projectWorkspace.runCommand('printf "surface-out\\\\n" > /dev/stdout', {
        onEvent(event) {
          outputEvents.push(event);
        },
      });
      if (output.stdout !== 'surface-out\\n' || !outputEvents.some((event) => event.type === 'output' && event.device === '/dev/stdout')) {
        throw new Error('@tracecode/tracekernel/workspace /dev/stdout event smoke failed: ' + JSON.stringify({ output, outputEvents }));
      }
      if (
        typeof projectWorkspace.http.request !== 'function' ||
        typeof projectWorkspace.http.json !== 'function' ||
        typeof projectWorkspace.http.listen !== 'function'
      ) {
        throw new Error('@tracecode/tracekernel/workspace HTTP client surface missing');
      }
      const mockHttp = projectWorkspace.http.listen({ host: '127.0.0.1', port: 0 }, (request) => ({
        status: 209,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: request.method, path: request.path, body: request.body || '' }) + '\\n',
      }));
      const httpRequest = await projectWorkspace.http.request({
        method: 'POST',
        url: 'http://localhost:' + mockHttp.info.port + '/surface',
        headers: { 'content-type': 'text/plain' },
        body: 'payload',
      });
      if (httpRequest.status !== 209 || httpRequest.body !== '{"method":"POST","path":"/surface","body":"payload"}\\n') {
        throw new Error('@tracecode/tracekernel/workspace HTTP request/listen smoke failed: ' + JSON.stringify(httpRequest));
      }
      if (coreMod.runtimeHttpResponseText(httpRequest) !== '{"method":"POST","path":"/surface","body":"payload"}\\n') {
        throw new Error('@tracecode/runtime-contracts HTTP response text helper smoke failed: ' + JSON.stringify(httpRequest));
      }
      const binaryPayload = coreMod.runtimeHttpBodyFromBytes(new Uint8Array([0, 255, 1]));
      if (
        binaryPayload.bodyEncoding !== 'base64' ||
        Array.from(coreMod.runtimeHttpBodyBytes(binaryPayload)).join(',') !== '0,255,1'
      ) {
        throw new Error('@tracecode/runtime-contracts HTTP body byte helper smoke failed: ' + JSON.stringify(binaryPayload));
      }
      const bomPayload = coreMod.runtimeHttpBodyFromBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]));
      if (Array.from(coreMod.runtimeHttpBodyBytes(bomPayload)).join(',') !== '239,187,191,65') {
        throw new Error('@tracecode/runtime-contracts HTTP body byte helper should preserve UTF-8 BOM bytes: ' + JSON.stringify(bomPayload));
      }
      const httpJson = await projectWorkspace.http.json({
        method: 'POST',
        url: 'http://localhost:' + mockHttp.info.port + '/json',
        body: { ok: true },
      });
      if (httpJson.status !== 209 || httpJson.json.body !== '{"ok":true}') {
        throw new Error('@tracecode/tracekernel/workspace HTTP json smoke failed: ' + JSON.stringify(httpJson));
      }
      mockHttp.close();
      const stalledHttp = projectWorkspace.http.listen({ host: '127.0.0.1', port: 0 }, () => new Promise(() => {}));
      const timedOutHttp = await projectWorkspace.http.request({
        url: 'http://localhost:' + stalledHttp.info.port + '/stall',
        timeoutMs: 1,
      });
      if (timedOutHttp.status !== 0 || timedOutHttp.body !== 'Network request timed out after 1 milliseconds\\n') {
        throw new Error('@tracecode/tracekernel/workspace HTTP timeout smoke failed: ' + JSON.stringify(timedOutHttp));
      }
      stalledHttp.close();
      const pythonMain = await import('@tracecode/runtime-python');
      if (
        typeof pythonMain.createNativePythonProjectRunner !== 'function' ||
        typeof pythonMain.createBrowserPythonProjectRunner !== 'function'
      ) {
        throw new Error('@tracecode/runtime-python missing main project runner exports');
      }
      if (Object.keys(pythonMain).some((name) => /pyodide/i.test(name))) {
        throw new Error('@tracecode/runtime-python must not expose engine-branded exports');
      }
      const javascriptMain = await import('@tracecode/runtime-javascript');
      if (
        typeof javascriptMain.createNativeJavaScriptProjectRunner !== 'function' ||
        typeof javascriptMain.createBrowserJavaScriptProjectRunner !== 'function'
      ) {
        throw new Error('@tracecode/runtime-javascript missing main project runner exports');
      }
      const javaMain = await import('@tracecode/runtime-java');
      if (
        typeof javaMain.createNativeJavaProjectRunner !== 'function' ||
        typeof javaMain.createBrowserJavaProjectRunner !== 'function'
      ) {
        throw new Error('@tracecode/runtime-java missing main project runner exports');
      }
      const csharpMain = await import('@tracecode/runtime-csharp');
      if (
        typeof csharpMain.createNativeCSharpProjectRunner !== 'function' ||
        typeof csharpMain.createBrowserCSharpProjectRunner !== 'function'
      ) {
        throw new Error('@tracecode/runtime-csharp missing main project runner exports');
      }
      const cppMain = await import('@tracecode/runtime-cpp');
      if (
        typeof cppMain.createNativeCppProjectRunner !== 'function' ||
        typeof cppMain.createBrowserCppProjectRunner !== 'function'
      ) {
        throw new Error('@tracecode/runtime-cpp missing main project runner exports');
      }
      const pythonProjectNode = await import('@tracecode/runtime-python/project-node');
      if (typeof pythonProjectNode.createNativePythonProjectRunner !== 'function') {
        throw new Error('@tracecode/runtime-python/project-node missing createNativePythonProjectRunner');
      }
      const pythonProjectBrowser = await import('@tracecode/runtime-python/project-browser');
      if (typeof pythonProjectBrowser.createBrowserPythonProjectRunner !== 'function') {
        throw new Error('@tracecode/runtime-python/project-browser missing browser project runner exports');
      }
      if (Object.keys(pythonProjectBrowser).some((name) => /pyodide/i.test(name))) {
        throw new Error('@tracecode/runtime-python/project-browser must not expose engine-branded exports');
      }
      const javascriptProjectNode = await import('@tracecode/runtime-javascript/project-node');
      if (typeof javascriptProjectNode.createNativeJavaScriptProjectRunner !== 'function') {
        throw new Error('@tracecode/runtime-javascript/project-node missing createNativeJavaScriptProjectRunner');
      }
      const javascriptProjectBrowser = await import('@tracecode/runtime-javascript/project-browser');
      if (typeof javascriptProjectBrowser.createBrowserJavaScriptProjectRunner !== 'function') {
        throw new Error('@tracecode/runtime-javascript/project-browser missing createBrowserJavaScriptProjectRunner');
      }
      const javaProjectNode = await import('@tracecode/runtime-java/project-node');
      if (typeof javaProjectNode.createNativeJavaProjectRunner !== 'function') {
        throw new Error('@tracecode/runtime-java/project-node missing createNativeJavaProjectRunner');
      }
      const javaProjectBrowser = await import('@tracecode/runtime-java/project-browser');
      if (typeof javaProjectBrowser.createBrowserJavaProjectRunner !== 'function') {
        throw new Error('@tracecode/runtime-java/project-browser missing createBrowserJavaProjectRunner');
      }
      const javaProject = await import('@tracecode/runtime-java/java-project');
      if (typeof javaProject.createJavaProjectRunner !== 'function') {
        throw new Error('@tracecode/runtime-java/java-project missing createJavaProjectRunner');
      }
      const cppProjectNode = await import('@tracecode/runtime-cpp/project-node');
      if (typeof cppProjectNode.createNativeCppProjectRunner !== 'function') {
        throw new Error('@tracecode/runtime-cpp/project-node missing createNativeCppProjectRunner');
      }
      const cppProjectBrowser = await import('@tracecode/runtime-cpp/project-browser');
      if (typeof cppProjectBrowser.createBrowserCppProjectRunner !== 'function') {
        throw new Error('@tracecode/runtime-cpp/project-browser missing createBrowserCppProjectRunner');
      }
      const csharpProjectNode = await import('@tracecode/runtime-csharp/project-node');
      if (typeof csharpProjectNode.createNativeCSharpProjectRunner !== 'function') {
        throw new Error('@tracecode/runtime-csharp/project-node missing createNativeCSharpProjectRunner');
      }
      const csharpProjectBrowser = await import('@tracecode/runtime-csharp/project-browser');
      if (typeof csharpProjectBrowser.createBrowserCSharpProjectRunner !== 'function') {
        throw new Error('@tracecode/runtime-csharp/project-browser missing createBrowserCSharpProjectRunner');
      }
      const nativeMain = await import('@tracecode/runtime-native');
      if (
        typeof nativeMain.createNativeHarness !== 'function' ||
        typeof nativeMain.createNativeProjectWorkspace !== 'function'
      ) {
        throw new Error('@tracecode/runtime-native missing native harness exports');
      }
      const nativeStandaloneWorkspace = await projectMod.createRuntimeWorkspace({
        files: [
          { path: 'native.py', contents: 'print("standalone-native-python")\\n' },
          { path: 'native.js', contents: 'console.log("standalone-native-node")\\n' },
          { path: 'Native.java', contents: 'class Native { public static void main(String[] args) { System.out.println("standalone-native-java"); } }\\n' },
          { path: 'native.cpp', contents: '#include <iostream>\\nint main() { std::cout << "standalone-native-cpp\\\\n"; return 0; }\\n' },
          {
            path: 'NativeStandalone.csproj',
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
          { path: 'Program.cs', contents: 'Console.WriteLine("standalone-native-csharp");\\n' },
        ],
        pythonRunner: pythonProjectNode.createNativePythonProjectRunner(),
        nodeRunner: javascriptProjectNode.createNativeJavaScriptProjectRunner(),
        javaRunner: javaProjectNode.createNativeJavaProjectRunner(),
        cppRunner: cppProjectNode.createNativeCppProjectRunner(),
        csharpRunner: csharpProjectNode.createNativeCSharpProjectRunner({ timeoutMs: 60000 }),
      });
      const nativePython = await nativeStandaloneWorkspace.runCommand('python3 native.py');
      if (nativePython.exitCode !== 0 || nativePython.stdout !== 'standalone-native-python\\n') {
        throw new Error('@tracecode standalone native Python project smoke failed: ' + JSON.stringify(nativePython));
      }
      const nativeNode = await nativeStandaloneWorkspace.runCommand('node native.js');
      if (nativeNode.exitCode !== 0 || nativeNode.stdout !== 'standalone-native-node\\n') {
        throw new Error('@tracecode standalone native Node project smoke failed: ' + JSON.stringify(nativeNode));
      }
      const nativeJavac = await nativeStandaloneWorkspace.runCommand('javac Native.java');
      if (nativeJavac.exitCode !== 0) {
        throw new Error('@tracecode standalone native javac project smoke failed: ' + JSON.stringify(nativeJavac));
      }
      const nativeJava = await nativeStandaloneWorkspace.runCommand('java Native');
      if (nativeJava.exitCode !== 0 || nativeJava.stdout !== 'standalone-native-java\\n') {
        throw new Error('@tracecode standalone native Java project smoke failed: ' + JSON.stringify(nativeJava));
      }
      const nativeCppCompile = await nativeStandaloneWorkspace.runCommand('clang++ native.cpp -o native-cpp');
      if (nativeCppCompile.exitCode !== 0) {
        throw new Error('@tracecode standalone native C++ project compile smoke failed: ' + JSON.stringify(nativeCppCompile));
      }
      const nativeCpp = await nativeStandaloneWorkspace.runCommand('./native-cpp');
      if (nativeCpp.exitCode !== 0 || nativeCpp.stdout !== 'standalone-native-cpp\\n') {
        throw new Error('@tracecode standalone native C++ project run smoke failed: ' + JSON.stringify(nativeCpp));
      }
      const nativeCSharp = await nativeStandaloneWorkspace.runCommand('dotnet run --project NativeStandalone.csproj');
      if (nativeCSharp.exitCode !== 0 || !nativeCSharp.stdout.endsWith('standalone-native-csharp\\n')) {
        throw new Error('@tracecode standalone native C# project smoke failed: ' + JSON.stringify(nativeCSharp));
      }
      const browserProject = await import('@tracecode/runtime-browser/project');
      if (typeof browserProject.createBrowserProjectWorkspace !== 'function') {
        throw new Error('@tracecode/runtime-browser/project missing createBrowserProjectWorkspace');
      }
      if (typeof browserProject.runtimeHttpResponseText !== 'function') {
        throw new Error('@tracecode/runtime-browser/project missing HTTP body helpers');
      }
      const browserWorkspace = await browserProject.createBrowserProjectWorkspace({
        providers: ['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp'],
        kernel: {
          user: { id: 'browser-surface-user', username: 'surface' },
          host: { hostname: 'tracevm-browser' },
          workspace: { id: 'browser-surface-project', name: 'surface-browser', startedAt: '2026-05-17T12:00:00.000Z' },
        },
        files: [
          { path: 'main.py', contents: 'print("standalone-browser-python")\\n' },
          { path: 'index.js', contents: 'const fs = require("node:fs"); fs.writeFileSync("node.txt", "standalone-browser-node\\\\n"); console.log("standalone-browser-node");\\n' },
          { path: 'Main.java', contents: 'class Main {}\\n' },
          { path: 'Program.cs', contents: 'Console.WriteLine("standalone-browser-csharp");\\n' },
          { path: 'main.cpp', contents: 'int main() { return 0; }\\n' },
        ],
        nodeProjectTimeoutMs: 20000,
        runtimeProviders: {
          python: {
            async execute(request) {
              return { stdout: request.scriptPath + ':standalone-browser-python\\n', stderr: '', exitCode: 0 };
            },
          },
          java: {
            async execute(request) {
              return { stdout: request.source + ':' + request.scriptPath + ':standalone-browser-java\\n', stderr: '', exitCode: 0 };
            },
          },
          csharp: {
            async execute(request) {
              return { stdout: request.source + ':' + request.args.join(',') + ':standalone-browser-csharp\\n', stderr: '', exitCode: 0 };
            },
          },
          cpp: {
            async execute(request) {
              return { stdout: request.source + ':' + request.args.join(',') + ':standalone-browser-cpp\\n', stderr: '', exitCode: 0 };
            },
          },
        },
        nodeProject: {
          allowMainThreadExecution: true,
          trustedMainThreadExecution: true,
        },
      });
      try {
        if (browserWorkspace.cwd !== '/home/surface/surface-browser') {
          throw new Error('@tracecode/runtime-browser/project tracekernel cwd mismatch: ' + browserWorkspace.cwd);
        }
        await browserWorkspace.writeFile('/workspace/browser-alias.txt', 'browser-alias\\n');
        if ((await browserWorkspace.readFile('/home/surface/surface-browser/browser-alias.txt')) !== 'browser-alias\\n') {
          throw new Error('@tracecode/runtime-browser/project /workspace alias smoke failed');
        }
        const browserMountInfo = await browserWorkspace.readFile('/proc/self/mountinfo');
        if (!browserMountInfo.includes('tracekernel:workspace') || !browserMountInfo.includes(' /workspace ')) {
          throw new Error('@tracecode/runtime-browser/project mountinfo smoke failed: ' + browserMountInfo);
        }
        const browserPython = await browserWorkspace.runCommand('python3 main.py');
        if (browserPython.exitCode !== 0 || browserPython.stdout !== 'main.py:standalone-browser-python\\n') {
          throw new Error('@tracecode/runtime-browser/project Python smoke failed: ' + JSON.stringify(browserPython));
        }
        const browserNode = await browserWorkspace.runCommand('node index.js');
        if (browserNode.exitCode !== 0 || browserNode.stdout !== 'standalone-browser-node\\n') {
          throw new Error('@tracecode/runtime-browser/project Node smoke failed: ' + JSON.stringify(browserNode));
        }
        if ((await browserWorkspace.readFile('node.txt')) !== 'standalone-browser-node\\n') {
          throw new Error('@tracecode/runtime-browser/project Node side effect failed');
        }
        const browserJava = await browserWorkspace.runCommand('java Main');
        if (browserJava.exitCode !== 0 || browserJava.stdout !== 'run:Main:standalone-browser-java\\n') {
          throw new Error('@tracecode/runtime-browser/project Java smoke failed: ' + JSON.stringify(browserJava));
        }
        const browserCSharp = await browserWorkspace.runCommand('dotnet run -- alpha beta');
        if (browserCSharp.exitCode !== 0 || browserCSharp.stdout !== 'run:alpha,beta:standalone-browser-csharp\\n') {
          throw new Error('@tracecode/runtime-browser/project C# smoke failed: ' + JSON.stringify(browserCSharp));
        }
        const browserCpp = await browserWorkspace.runCommand('clang++ main.cpp -o a.out');
        if (browserCpp.exitCode !== 0 || browserCpp.stdout !== 'compile:main.cpp,-o,a.out:standalone-browser-cpp\\n') {
          throw new Error('@tracecode/runtime-browser/project C++ smoke failed: ' + JSON.stringify(browserCpp));
        }
        const browserGcc = await browserWorkspace.runCommand('gcc main.cpp -o c-app');
        if (browserGcc.exitCode !== 0 || browserGcc.stdout !== 'compile:main.cpp,-o,c-app:standalone-browser-cpp\\n') {
          throw new Error('@tracecode/runtime-browser/project gcc alias smoke failed: ' + JSON.stringify(browserGcc));
        }
        const browserCc = await browserWorkspace.runCommand('cc main.cpp -o cc-app');
        if (browserCc.exitCode !== 0 || browserCc.stdout !== 'compile:main.cpp,-o,cc-app:standalone-browser-cpp\\n') {
          throw new Error('@tracecode/runtime-browser/project cc alias smoke failed: ' + JSON.stringify(browserCc));
        }
        const browserCppRun = await browserWorkspace.runCommand('./a.out alpha beta');
        if (browserCppRun.exitCode !== 0 || browserCppRun.stdout !== 'run:alpha,beta:standalone-browser-cpp\\n') {
          throw new Error('@tracecode/runtime-browser/project C++ executable smoke failed: ' + JSON.stringify(browserCppRun));
        }
      } finally {
        browserWorkspace.dispose();
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

  await writeFile(
    join(appDir, 'browser-project-entry.js'),
    [
      'import { createBrowserProjectWorkspace } from "@tracecode/runtime-browser/project";',
      'import { createRuntimeWorkspace } from "@tracecode/tracekernel/workspace";',
      'if (typeof createBrowserProjectWorkspace !== "function") throw new Error("missing browser project export");',
      'if (typeof createRuntimeWorkspace !== "function") throw new Error("missing project export");',
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
    throw new Error(browserBundle.stderr || browserBundle.stdout || 'Language browser project bundle check failed');
  }

  console.log('PASS: private runtime workspaces include scoped assets and root-compatible exports');
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-language-packages-'));
  try {
    await runWithTempRoot(tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('language package surface', main);

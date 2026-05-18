#!/usr/bin/env npx tsx

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
    name: '@tracecode/harness-project',
    dir: 'packages/harness-project',
    exportName: 'createRuntimeWorkspace',
    requiredFiles: [
      'dist/index.js',
      'dist/index.cjs',
      'dist/index.d.ts',
      'dist/zlib-browser-shim.js',
      'dist/zlib-browser-shim.cjs',
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
      'dist/project-node.js',
      'dist/project-node.cjs',
      'dist/project-node.d.ts',
      'dist/project-browser.js',
      'dist/project-browser.cjs',
      'dist/project-browser.d.ts',
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
      'dist/project-node.js',
      'dist/project-node.cjs',
      'dist/project-node.d.ts',
      'dist/project-browser.js',
      'dist/project-browser.cjs',
      'dist/project-browser.d.ts',
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
      'dist/project-node.js',
      'dist/project-node.cjs',
      'dist/project-node.d.ts',
      'dist/project-browser.js',
      'dist/project-browser.cjs',
      'dist/project-browser.d.ts',
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
      'dist/project-node.js',
      'dist/project-node.cjs',
      'dist/project-node.d.ts',
      'dist/project-browser.js',
      'dist/project-browser.cjs',
      'dist/project-browser.d.ts',
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
      'dist/project-node.js',
      'dist/project-node.cjs',
      'dist/project-node.d.ts',
      'dist/project-browser.js',
      'dist/project-browser.cjs',
      'dist/project-browser.d.ts',
      'workers/cpp-worker.js',
      'workers/shared/runtime-kernel-policy.js',
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

async function runWithTempRoot(tempRoot: string): Promise<void> {
  const appDir = join(tempRoot, 'app');
  await mkdir(join(appDir, 'node_modules', '@tracecode'), { recursive: true });
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

    if (packageCheck.name === '@tracecode/harness-core') {
      const declarations = await readFile(join(packageDir, 'dist/index.d.ts'), 'utf8');
      assertCondition(
        declarations.includes('interface RuntimeDirectoryChange') &&
          declarations.includes('type RuntimeFileChange = RuntimeFile | RuntimeFileDeletion | RuntimeDirectoryChange'),
        '@tracecode/harness-core declarations should ship directory file-change events'
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
        '@tracecode/harness-core declarations should export shared tracekernel helpers'
      );
    }
    if (packageCheck.name === '@tracecode/harness-project') {
      const projectDist = await readFile(join(packageDir, 'dist/index.js'), 'utf8');
      assertCondition(
        projectDist.includes('function isRuntimeDirectoryChange(') &&
          projectDist.includes('directory: true'),
        '@tracecode/harness-project should ship directory file-change application support'
      );
      assertCondition(
        projectDist.includes('symlink(target, linkPath)') &&
          projectDist.includes('const symlinkTarget = kernelSymlinkTarget(linkPath)') &&
          projectDist.includes('link(existingPath, newPath)') &&
          projectDist.includes('const linkTarget = kernelLinkTarget(existingPath, newPath)') &&
          projectDist.includes('const renameTarget = kernelRenameTarget(sourcePath, destinationPath)') &&
          projectDist.includes('const removeTarget = kernelRemoveTarget(path2)') &&
          projectDist.includes('const mkdirTarget = kernelMkdirTarget(path2)') &&
          projectDist.includes('Kernel virtual path is not a symbolic link') &&
          projectDist.includes('const statTarget = kernelStatTarget(path') &&
          projectDist.includes('virtualStat(stat') &&
          projectDist.includes('if (isRuntimeKernelVirtualNamespacePath(path'),
        '@tracecode/harness-project should ship shared-kernel virtual stat/link guards'
      );
    }
    if (packageCheck.name === '@tracecode/harness-python') {
      const worker = await readFile(join(packageDir, 'workers/pyodide-worker.js'), 'utf8');
      assertCondition(
        !worker.includes('"/dev/stdout": {"readable": False, "writable": True'),
        '@tracecode/harness-python worker should not ship fallback /dev/stdout device semantics'
      );
      assertCondition(
        worker.includes('function installPyodideProjectStdioBridge(') &&
          worker.includes('pyodide.setStdout({ write: writeHandler(') &&
          worker.includes('pyodide.setStderr({ write: writeHandler('),
        '@tracecode/harness-python worker should ship Pyodide project stdio bridge hooks'
      );
      assertCondition(
        worker.includes('self.__tracecodeReadProjectStdinByte = readProjectStdinByte') &&
          worker.includes('sys.stdin = _TraceProjectInputStream()') &&
          worker.includes('return _read_project_input(_device, _length)'),
        '@tracecode/harness-python worker should route sys.stdin and device reads through one kernel stdin cursor'
      );
      assertCondition(
        worker.includes('sourceDevice') &&
          worker.includes('def write(self, _value, _source_device=None, _output_device=None):') &&
          worker.includes('_device = str(_output_device or ("/dev/stderr" if self._stream == "stderr" else "/dev/stdout"))') &&
          worker.includes('_target.write(bytes(_data).decode("utf-8", "replace"), self._device, _output_device)') &&
          worker.includes('_target.write(_bytes.decode("utf-8", "replace"), _device, _output_device)'),
        '@tracecode/harness-python worker should ship routed output/source device events'
      );
      assertCondition(
        worker.includes("patch('open'") &&
          worker.includes('isCreateOrTruncateOpenFlags') &&
          worker.includes('emitFileChange(streamPath(stream))'),
        '@tracecode/harness-python worker should ship live empty-open file mutation hooks'
      );
      assertCondition(
        worker.includes("patch('mkdir'") &&
          worker.includes("patch('rmdir'") &&
          worker.includes('emitDirectoryCreate(path)') &&
          worker.includes('emitDirectoryDelete(path)'),
        '@tracecode/harness-python worker should ship live directory mutation hooks'
      );
      assertCondition(
        worker.includes('const emitPathSnapshot = (path) =>') &&
          worker.includes('emitPathSnapshot(`${String(path).replace(/\\/+$/, \'\')}/${entry}`)') &&
          worker.includes('emitPathSnapshot(newPath)'),
        '@tracecode/harness-python worker should ship recursive moved-directory live snapshots'
      );
      assertCondition(
        worker.includes('_patched_os_fchmod') &&
          worker.includes('_patched_os_fchown') &&
          worker.includes('if _fd in _proc_file_descriptors:') &&
          worker.includes('Kernel proc path is read-only'),
        '@tracecode/harness-python worker should ship virtual fd metadata guards'
      );
      assertCondition(
        worker.includes('_patched_os_readv') &&
          worker.includes('_patched_os_writev') &&
          worker.includes('os.readv = _patched_os_readv') &&
          worker.includes('os.writev = _patched_os_writev'),
        '@tracecode/harness-python worker should ship vectored fd I/O bridge hooks'
      );
    }
    if (packageCheck.name === '@tracecode/harness-javascript') {
      const projectBrowser = await readFile(join(packageDir, 'dist/project-browser.js'), 'utf8');
      assertCondition(
        projectBrowser.includes('sourceDevice') &&
          projectBrowser.includes('io.output(stream, data, device, sourceDevice)') &&
          projectBrowser.includes('device !== outputDevice ? device :'),
        '@tracecode/harness-javascript browser project runner should ship routed source device output events'
      );
      assertCondition(
        projectBrowser.includes('let stdinOffset = 0') &&
          projectBrowser.includes('const readDeviceBytes = (device, size) =>') &&
          projectBrowser.includes('const stdinDevice = createReadableStdinDevice(') &&
          projectBrowser.includes('(size) => readDeviceBytes("/dev/stdin", size)') &&
          projectBrowser.includes('if (entry.kind === "device") return readDeviceBytes(entry.device ?? "/dev/stdin");'),
        '@tracecode/harness-javascript browser project runner should share process.stdin and device stdin cursor'
      );
      assertCondition(
        projectBrowser.includes('io.fileChange({ path, directory: true }, "live")') &&
          projectBrowser.includes('io.fileChange({ path, directory: true, deleted: true }, "live")'),
        '@tracecode/harness-javascript browser project runner should ship live directory mutation events'
      );
      assertCondition(
        projectBrowser.includes('readvSync') &&
          projectBrowser.includes('writevSync') &&
          projectBrowser.includes('ftruncateSync') &&
          projectBrowser.includes('descriptorMetadataPath') &&
          projectBrowser.includes('writeFileToHandle') &&
          projectBrowser.includes('appendFileToHandle') &&
          projectBrowser.includes('createWriteStream'),
        '@tracecode/harness-javascript browser project runner should ship FileHandle/vector/truncate/metadata live I/O bridge'
      );
      assertCondition(
        projectBrowser.includes('runtimeKernelStatTarget') &&
          projectBrowser.includes('statForKernelTarget'),
        '@tracecode/harness-javascript browser project runner should use shared tracekernel stat targets'
      );
    }
    if (packageCheck.name === '@tracecode/harness-java') {
      const worker = await readFile(join(packageDir, 'workers/java-worker.js'), 'utf8');
      assertCondition(
        worker.includes('new tracecode.browser.ProjectEvents.ProjectFile('),
        '@tracecode/harness-java worker should ship java.io.File live-mutation rewrites'
      );
      assertCondition(
        worker.includes('emitLiveJavaProjectDirectoryCreate') &&
          worker.includes('emitLiveJavaProjectDirectoryDelete') &&
          worker.includes('Java_tracecode_browser_ProjectEvents_emitDirectoryCreateNative') &&
          worker.includes('Java_tracecode_browser_ProjectEvents_emitDirectoryDeleteNative') &&
          worker.includes('createFile|createDirectory|createDirectories'),
        '@tracecode/harness-java worker should ship live directory mutation bridge hooks'
      );
      assertCondition(
        worker.includes('emitLiveJavaProjectOutput(String(stream ?? \'stdout\'), String(data ?? \'\'), String(sourceDevice ?? \'\'), String(outputDevice ?? \'\'))') &&
          worker.includes('sourceDevice') &&
          worker.includes('outputDevicePath'),
        '@tracecode/harness-java worker should ship routed source and output device events'
      );
      assertCondition(
        worker.includes('projectKernelFileManifest') &&
          worker.includes('ProjectEvents.setKernelFiles('),
        '@tracecode/harness-java worker should ship manifest kernel file bridge setup'
      );
      assertCondition(
        worker.includes('newInputStream|newBufferedReader') &&
          worker.includes('readAllLines|lines|list') &&
          worker.includes('isReadable|isWritable|size'),
        '@tracecode/harness-java worker should ship NIO read/stat device rewrites'
      );
      const helperJarListing = spawnSync('jar', ['tf', join(packageDir, 'workers/vendor/java-browser-helper.jar')], {
        encoding: 'utf8',
      });
      if (helperJarListing.status !== 0) {
        throw new Error(helperJarListing.stderr || helperJarListing.stdout || '@tracecode/harness-java helper jar listing failed');
      }
      assertCondition(
        helperJarListing.stdout.includes('tracecode/browser/ProjectEvents$ProjectFile.class'),
        '@tracecode/harness-java helper jar should include ProjectEvents.ProjectFile'
      );
      const helperApi = spawnSync(
        'javap',
        ['-classpath', join(packageDir, 'workers/vendor/java-browser-helper.jar'), '-private', 'tracecode.browser.ProjectEvents'],
        { encoding: 'utf8' }
      );
      if (helperApi.status !== 0) {
        throw new Error(helperApi.stderr || helperApi.stdout || '@tracecode/harness-java helper jar API listing failed');
      }
      assertCondition(
        helperApi.stdout.includes('emitOutputNative(java.lang.String, java.lang.String, java.lang.String, java.lang.String)'),
        '@tracecode/harness-java helper jar should expose source/output-device native bridge'
      );
      assertCondition(
        helperApi.stdout.includes('emitDirectoryCreateNative(java.lang.String)') &&
          helperApi.stdout.includes('emitDirectoryDeleteNative(java.lang.String)'),
        '@tracecode/harness-java helper jar should expose directory native bridge hooks'
      );
      assertCondition(
        helperApi.stdout.includes('setKernelFiles(java.lang.String)'),
        '@tracecode/harness-java helper jar should expose manifest kernel file bridge'
      );
      assertCondition(
        helperApi.stdout.includes('inputStream()'),
        '@tracecode/harness-java helper jar should expose shared stdin input stream'
      );
      assertCondition(
        helperApi.stdout.includes('newInputStream(java.nio.file.Path, java.nio.file.OpenOption...)') &&
          helperApi.stdout.includes('newBufferedReader(java.nio.file.Path, java.nio.charset.Charset)') &&
          helperApi.stdout.includes('readAllLines(java.nio.file.Path, java.nio.charset.Charset)') &&
          helperApi.stdout.includes('lines(java.nio.file.Path, java.nio.charset.Charset)') &&
          helperApi.stdout.includes('isReadable(java.nio.file.Path)') &&
          helperApi.stdout.includes('isWritable(java.nio.file.Path)') &&
          helperApi.stdout.includes('size(java.nio.file.Path)'),
        '@tracecode/harness-java helper jar should expose NIO read/stat device bridge'
      );
      const streamingOutputApi = spawnSync(
        'javap',
        ['-classpath', join(packageDir, 'workers/vendor/java-browser-helper.jar'), '-c', 'tracecode.browser.ProjectEvents$StreamingProjectOutputStream'],
        { encoding: 'utf8' }
      );
      if (streamingOutputApi.status !== 0) {
        throw new Error(streamingOutputApi.stderr || streamingOutputApi.stdout || '@tracecode/harness-java streaming output API listing failed');
      }
      assertCondition(
        streamingOutputApi.stdout.includes('public void write(int) throws java.io.IOException;') &&
          streamingOutputApi.stdout.includes('public void write(byte[], int, int) throws java.io.IOException;') &&
          streamingOutputApi.stdout.includes('invokevirtual #') &&
          streamingOutputApi.stdout.includes('// Method flush:()V'),
        '@tracecode/harness-java helper jar should flush live stdio after unbuffered writes'
      );
      const fileWriterApi = spawnSync(
        'javap',
        ['-classpath', join(packageDir, 'workers/vendor/java-browser-helper.jar'), '-c', 'tracecode.browser.ProjectEvents$ProjectFileWriter'],
        { encoding: 'utf8' }
      );
      if (fileWriterApi.status !== 0) {
        throw new Error(fileWriterApi.stderr || fileWriterApi.stdout || '@tracecode/harness-java file writer API listing failed');
      }
      const fileOutputStreamApi = spawnSync(
        'javap',
        ['-classpath', join(packageDir, 'workers/vendor/java-browser-helper.jar'), '-c', 'tracecode.browser.ProjectEvents$ProjectFileOutputStream'],
        { encoding: 'utf8' }
      );
      if (fileOutputStreamApi.status !== 0) {
        throw new Error(fileOutputStreamApi.stderr || fileOutputStreamApi.stdout || '@tracecode/harness-java file output stream API listing failed');
      }
      assertCondition(
        fileWriterApi.stdout.includes('// Method emitOpenSnapshot:(Z)V') &&
          fileOutputStreamApi.stdout.includes('// Method emitOpenSnapshot:(Z)V'),
        '@tracecode/harness-java helper jar should emit live snapshots for classic open/truncate constructors'
      );
    }
    if (packageCheck.name === '@tracecode/harness-csharp') {
      const worker = await readFile(join(packageDir, 'workers/csharp-worker.js'), 'utf8');
      assertCondition(
        !worker.includes('FALLBACK_KERNEL_DEVICES'),
        '@tracecode/harness-csharp worker should not ship fallback kernel device inventory'
      );
      assertCondition(
        worker.includes('sourceDevice') &&
          worker.includes('const currentSourceDevice = stream === \'stdout\' ? context.stdoutSourceDevice : context.stderrSourceDevice') &&
          worker.includes('flushProjectOutput(stream)') &&
          worker.includes('context.stdoutSourceDevice = nextSourceDevice'),
        '@tracecode/harness-csharp worker should ship routed source device events and flush on device changes'
      );
      assertCondition(
        worker.includes('readProjectInputByte: () => readProjectInputByte(\'/dev/stdin\') ?? -1'),
        '@tracecode/harness-csharp worker should route managed stdin through the kernel stdin cursor'
      );
      assertCondition(
        worker.includes('function isCreateOrTruncateOpenFlags(') &&
          worker.includes('fs.open = function openWithProjectEvents') &&
          worker.includes('emitProjectFileSnapshot(stream.path)'),
        '@tracecode/harness-csharp worker should ship live empty-open file mutation hooks'
      );
      assertCondition(
        worker.includes("const CSHARP_PROJECT_WORKSPACE_ROOT = '/tmp/tracecode-csharp-project'") &&
          worker.includes("const roots = ['/workspace', CSHARP_PROJECT_WORKSPACE_ROOT]"),
        '@tracecode/harness-csharp worker should map provider-root live events back to project paths'
      );
      assertCondition(
        worker.includes('emitProjectDirectoryCreate(path)') &&
          worker.includes('emitProjectDirectoryDelete(path)') &&
          worker.includes('fs.mkdir = function mkdirWithProjectEvents') &&
          worker.includes('fs.rmdir = function rmdirWithProjectEvents') &&
          worker.includes('emitProjectPathSnapshot(newPath)'),
        '@tracecode/harness-csharp worker should ship provider-level live directory mutation hooks'
      );
      assertCondition(
        worker.includes('let materializedKernelDevicePaths = new Set()') &&
          worker.includes('materializedKernelDevicePaths.add(devicePath)') &&
          worker.includes('function isReadableOpenFlags(flags)') &&
          worker.includes('function isKernelDeviceNamespacePath(value)') &&
          worker.includes('throwKernelDevicePathError(path, \'open\')'),
        '@tracecode/harness-csharp worker should ship manifest-scoped /dev cleanup and namespace guards'
      );
      assertCondition(
        worker.includes('function emitMissingProjectResultOutput(result)') &&
          worker.includes('context.eventStdout.join(\'\') !== stdout'),
        '@tracecode/harness-csharp worker should stream returned compiler/build output events'
      );
      const csharpHostDll = await readFile(join(packageDir, 'workers/vendor/csharp/_framework/supportFiles/173_TraceCode.CSharpHost.dll'));
      const csharpHostApi = `${csharpHostDll.toString('utf8')}\n${csharpHostDll.toString('utf16le')}`;
      assertCondition(
        csharpHostApi.includes('ReadProjectInputByte') &&
          csharpHostApi.includes('IsProjectFileMutationMethod') &&
          csharpHostApi.includes('EmitLiveProjectFileSnapshot'),
        '@tracecode/harness-csharp worker should ship managed project stdin and live file bridge methods'
      );
    }
    if (packageCheck.name === '@tracecode/harness-cpp') {
      const worker = await readFile(join(packageDir, 'workers/cpp-worker.js'), 'utf8');
      assertCondition(
        worker.includes('function standaloneKernelDevices()') &&
          !worker.includes('options.kernelDevices instanceof Map ? options.kernelDevices : projectKernelDevices()'),
        '@tracecode/harness-cpp worker should keep standalone stdio separate from project kernel devices'
      );
      assertCondition(
        worker.includes('sourceDevice') &&
          worker.includes('this.onOutput?.(stream, decodeUtf8(concatBytes(chunks)), entry.device, entry.outputDevice)') &&
          worker.includes('const resolvedOutputDevice = outputDevice || (stream === \'stderr\' ? \'/dev/stderr\' : \'/dev/stdout\')'),
        '@tracecode/harness-cpp worker should ship stdio source and resolved output device events'
      );
      assertCondition(
        worker.includes('directory: true') &&
          worker.includes('this.fileChangeObserver?.({ path: normalized, directory: true })') &&
          worker.includes('this.fileChangeObserver?.({ path: normalized, directory: true, deleted: true })'),
        '@tracecode/harness-cpp worker should ship live directory mutation events'
      );
      assertCondition(
        worker.includes('function emitProjectResultOutputEvents(events, result)') &&
          worker.includes('emitProjectResultOutputEvents(events, result)'),
        '@tracecode/harness-cpp worker should stream returned compiler output events'
      );
      assertCondition(
        worker.includes("from './shared/runtime-kernel-policy.js'") &&
          worker.includes('runtimeKernelVirtualPathTarget(pathname') &&
          worker.includes('runtimeKernelVirtualMutationTarget(pathname') &&
          worker.includes('knownDevices: this.kernelDevices.keys()'),
        '@tracecode/harness-cpp worker should classify and guard manifest kernel namespaces with shared worker kernel policy'
      );
      assertCondition(
        worker.includes('emitPathSnapshot(pathname)') &&
          worker.includes('this.fs.emitPathSnapshot(pathname)'),
        '@tracecode/harness-cpp worker should ship metadata-only live file snapshots'
      );
    }

    const packedPackageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    if (packageCheck.name === '@tracecode/harness-browser') {
      assertCondition(
        !Object.prototype.hasOwnProperty.call(packedPackageJson.dependencies ?? {}, 'just-bash'),
        '@tracecode/harness-browser should not install just-bash unless consumers opt into project workspace primitives'
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
        throw new Error(browserOnlyExtract.stderr || browserOnlyExtract.stdout || '@tracecode/harness-browser isolated extraction failed');
      }
      const browserOnlyImportScript = `
        (async () => {
          const main = await import('@tracecode/harness-browser');
          if (typeof main.createBrowserProjectWorkspace !== 'undefined') {
            throw new Error('@tracecode/harness-browser main export should not expose project workspace helpers');
          }
          const project = await import('@tracecode/harness-browser/project');
          if (typeof project.createBrowserProjectWorkspace !== 'function') {
            throw new Error('@tracecode/harness-browser/project missing createBrowserProjectWorkspace');
          }
          const workspace = await project.createBrowserProjectWorkspace({
            files: [
              { path: 'index.js', contents: 'console.log("browser-only-node")\\n' },
              { path: 'main.py', contents: 'print("browser-only-python")\\n' },
              { path: 'Main.java', contents: 'class Main {}\\n' },
              { path: 'Program.cs', contents: 'Console.WriteLine("browser-only-csharp");\\n' },
              { path: 'main.cpp', contents: 'int main() { return 0; }\\n' },
            ],
            pythonWorkerClient: {
              async executeProjectPython(request) {
                return { stdout: request.scriptPath + ':browser-only-python\\n', stderr: '', exitCode: 0 };
              },
              terminate() {},
            },
            javaWorkerClient: {
              async executeProjectJava(request) {
                return { stdout: request.source + ':' + request.scriptPath + ':browser-only-java\\n', stderr: '', exitCode: 0 };
              },
              terminate() {},
            },
            csharpWorkerClient: {
              async executeProjectCSharp(request) {
                return { stdout: request.source + ':' + request.args.join(',') + ':browser-only-csharp\\n', stderr: '', exitCode: 0 };
              },
              terminate() {},
            },
            cppWorkerClient: {
              async executeProjectCpp(request) {
                return { stdout: request.source + ':' + request.args.join(',') + ':browser-only-cpp\\n', stderr: '', exitCode: 0 };
              },
              terminate() {},
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
            '@tracecode/harness-browser/project should work as an isolated bundled project-mode subpath'
        );
      }
    }
    if (packageCheck.name === '@tracecode/harness-project') {
      assertCondition(
        packedPackageJson.dependencies?.['just-bash'] === '3.0.1',
        '@tracecode/harness-project should declare the just-bash-backed project workspace dependency'
      );
    }
    const browserRunnerTypeAliases: Record<string, string> = {
      '@tracecode/harness-python': 'BrowserPythonProjectCommandRunner',
      '@tracecode/harness-javascript': 'BrowserJavaScriptProjectCommandRunner',
      '@tracecode/harness-java': 'BrowserJavaProjectCommandRunner',
      '@tracecode/harness-csharp': 'BrowserCSharpProjectCommandRunner',
      '@tracecode/harness-cpp': 'BrowserCppProjectCommandRunner',
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
        .filter(({ name }) => name !== '@tracecode/harness-project')
        .map(({ name, exportName }) => ({ name, exportName })))};
      for (const check of checks) {
        const mod = await import(check.name);
        if (typeof mod[check.exportName] !== 'function') {
          throw new Error(check.name + ' missing ' + check.exportName);
        }
      }
      const browser = await import('@tracecode/harness-browser');
      if (typeof browser.createBrowserProjectWorkspace !== 'undefined') {
        throw new Error('@tracecode/harness-browser main export should not include project workspace helpers');
      }
      const python = await import('@tracecode/harness-python');
      const javascript = await import('@tracecode/harness-javascript');
      const java = await import('@tracecode/harness-java');
      const csharp = await import('@tracecode/harness-csharp');
      const cpp = await import('@tracecode/harness-cpp');
      for (const [name, mod, projectExport] of [
        ['@tracecode/harness-python', python, 'createNativePythonProjectRunner'],
        ['@tracecode/harness-javascript', javascript, 'createNativeJavaScriptProjectRunner'],
        ['@tracecode/harness-java', java, 'createNativeJavaProjectRunner'],
        ['@tracecode/harness-csharp', csharp, 'createNativeCSharpProjectRunner'],
        ['@tracecode/harness-cpp', cpp, 'createNativeCppProjectRunner'],
      ]) {
        if (typeof mod[projectExport] !== 'function') {
          throw new Error(name + ' missing additive project runner export ' + projectExport);
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
        'just-bash': '3.0.1',
      },
    }),
    'utf8'
  );
  const install = spawnSync('pnpm', ['install', '--prod', '--ignore-scripts'], {
    cwd: appDir,
    encoding: 'utf8',
  });
  if (install.status !== 0) {
    throw new Error(install.stderr || install.stdout || 'Language package dependency install failed');
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
      const projectMod = await import('@tracecode/harness-project');
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
          throw new Error('@tracecode/harness-project missing ' + exportName);
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
        throw new Error('@tracecode/harness-project workspace command smoke failed');
      }
      if (projectWorkspace.cwd !== '/home/surface/surface-project') {
        throw new Error('@tracecode/harness-project tracekernel cwd mismatch: ' + projectWorkspace.cwd);
      }
      if (projectWorkspace.kernel.info.name !== 'tracekernel' || projectWorkspace.kernel.info.workspaceAlias !== '/workspace') {
        throw new Error('@tracecode/harness-project tracekernel info missing: ' + JSON.stringify(projectWorkspace.kernel.info));
      }
      await projectWorkspace.writeFile('/workspace/alias.txt', 'alias\\n');
      if ((await projectWorkspace.readFile('/home/surface/surface-project/alias.txt')) !== 'alias\\n') {
        throw new Error('@tracecode/harness-project /workspace alias smoke failed');
      }
      const mountInfo = await projectWorkspace.readFile('/proc/self/mountinfo');
      if (!mountInfo.includes('tracekernel:workspace') || !mountInfo.includes('/home/surface/surface-project') || !mountInfo.includes('/workspace')) {
        throw new Error('@tracecode/harness-project mountinfo smoke failed: ' + mountInfo);
      }
      const outputEvents = [];
      const output = await projectWorkspace.runCommand('printf "surface-out\\\\n" > /dev/stdout', {
        onEvent(event) {
          outputEvents.push(event);
        },
      });
      if (output.stdout !== 'surface-out\\n' || !outputEvents.some((event) => event.type === 'output' && event.device === '/dev/stdout')) {
        throw new Error('@tracecode/harness-project /dev/stdout event smoke failed: ' + JSON.stringify({ output, outputEvents }));
      }
      const pythonMain = await import('@tracecode/harness-python');
      if (
        typeof pythonMain.createNativePythonProjectRunner !== 'function' ||
        typeof pythonMain.createBrowserPythonProjectRunner !== 'function' ||
        typeof pythonMain.createPyodidePythonProjectRunner !== 'function'
      ) {
        throw new Error('@tracecode/harness-python missing main project runner exports');
      }
      const javascriptMain = await import('@tracecode/harness-javascript');
      if (
        typeof javascriptMain.createNativeJavaScriptProjectRunner !== 'function' ||
        typeof javascriptMain.createBrowserJavaScriptProjectRunner !== 'function'
      ) {
        throw new Error('@tracecode/harness-javascript missing main project runner exports');
      }
      const javaMain = await import('@tracecode/harness-java');
      if (
        typeof javaMain.createNativeJavaProjectRunner !== 'function' ||
        typeof javaMain.createBrowserJavaProjectRunner !== 'function'
      ) {
        throw new Error('@tracecode/harness-java missing main project runner exports');
      }
      const csharpMain = await import('@tracecode/harness-csharp');
      if (
        typeof csharpMain.createNativeCSharpProjectRunner !== 'function' ||
        typeof csharpMain.createBrowserCSharpProjectRunner !== 'function'
      ) {
        throw new Error('@tracecode/harness-csharp missing main project runner exports');
      }
      const cppMain = await import('@tracecode/harness-cpp');
      if (
        typeof cppMain.createNativeCppProjectRunner !== 'function' ||
        typeof cppMain.createBrowserCppProjectRunner !== 'function'
      ) {
        throw new Error('@tracecode/harness-cpp missing main project runner exports');
      }
      const pythonProjectNode = await import('@tracecode/harness-python/project-node');
      if (typeof pythonProjectNode.createNativePythonProjectRunner !== 'function') {
        throw new Error('@tracecode/harness-python/project-node missing createNativePythonProjectRunner');
      }
      const pythonProjectBrowser = await import('@tracecode/harness-python/project-browser');
      if (
        typeof pythonProjectBrowser.createBrowserPythonProjectRunner !== 'function' ||
        typeof pythonProjectBrowser.createPyodidePythonProjectRunner !== 'function'
      ) {
        throw new Error('@tracecode/harness-python/project-browser missing browser project runner exports');
      }
      const javascriptProjectNode = await import('@tracecode/harness-javascript/project-node');
      if (typeof javascriptProjectNode.createNativeJavaScriptProjectRunner !== 'function') {
        throw new Error('@tracecode/harness-javascript/project-node missing createNativeJavaScriptProjectRunner');
      }
      const javascriptProjectBrowser = await import('@tracecode/harness-javascript/project-browser');
      if (typeof javascriptProjectBrowser.createBrowserJavaScriptProjectRunner !== 'function') {
        throw new Error('@tracecode/harness-javascript/project-browser missing createBrowserJavaScriptProjectRunner');
      }
      const javaProjectNode = await import('@tracecode/harness-java/project-node');
      if (typeof javaProjectNode.createNativeJavaProjectRunner !== 'function') {
        throw new Error('@tracecode/harness-java/project-node missing createNativeJavaProjectRunner');
      }
      const javaProjectBrowser = await import('@tracecode/harness-java/project-browser');
      if (typeof javaProjectBrowser.createBrowserJavaProjectRunner !== 'function') {
        throw new Error('@tracecode/harness-java/project-browser missing createBrowserJavaProjectRunner');
      }
      const cppProjectNode = await import('@tracecode/harness-cpp/project-node');
      if (typeof cppProjectNode.createNativeCppProjectRunner !== 'function') {
        throw new Error('@tracecode/harness-cpp/project-node missing createNativeCppProjectRunner');
      }
      const cppProjectBrowser = await import('@tracecode/harness-cpp/project-browser');
      if (typeof cppProjectBrowser.createBrowserCppProjectRunner !== 'function') {
        throw new Error('@tracecode/harness-cpp/project-browser missing createBrowserCppProjectRunner');
      }
      const csharpProjectNode = await import('@tracecode/harness-csharp/project-node');
      if (typeof csharpProjectNode.createNativeCSharpProjectRunner !== 'function') {
        throw new Error('@tracecode/harness-csharp/project-node missing createNativeCSharpProjectRunner');
      }
      const csharpProjectBrowser = await import('@tracecode/harness-csharp/project-browser');
      if (typeof csharpProjectBrowser.createBrowserCSharpProjectRunner !== 'function') {
        throw new Error('@tracecode/harness-csharp/project-browser missing createBrowserCSharpProjectRunner');
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
              '    <TargetFramework>net8.0</TargetFramework>',
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
      const browserProject = await import('@tracecode/harness-browser/project');
      if (typeof browserProject.createBrowserProjectWorkspace !== 'function') {
        throw new Error('@tracecode/harness-browser/project missing createBrowserProjectWorkspace');
      }
      const browserWorkspace = await browserProject.createBrowserProjectWorkspace({
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
        pythonWorkerClient: {
          async executeProjectPython(request) {
            return { stdout: request.scriptPath + ':standalone-browser-python\\n', stderr: '', exitCode: 0 };
          },
          terminate() {},
        },
        javaWorkerClient: {
          async executeProjectJava(request) {
            return { stdout: request.source + ':' + request.scriptPath + ':standalone-browser-java\\n', stderr: '', exitCode: 0 };
          },
          terminate() {},
        },
        csharpWorkerClient: {
          async executeProjectCSharp(request) {
            return { stdout: request.source + ':' + request.args.join(',') + ':standalone-browser-csharp\\n', stderr: '', exitCode: 0 };
          },
          terminate() {},
        },
        cppWorkerClient: {
          async executeProjectCpp(request) {
            return { stdout: request.source + ':' + request.args.join(',') + ':standalone-browser-cpp\\n', stderr: '', exitCode: 0 };
          },
          terminate() {},
        },
      });
      try {
        if (browserWorkspace.cwd !== '/home/surface/surface-browser') {
          throw new Error('@tracecode/harness-browser/project tracekernel cwd mismatch: ' + browserWorkspace.cwd);
        }
        await browserWorkspace.writeFile('/workspace/browser-alias.txt', 'browser-alias\\n');
        if ((await browserWorkspace.readFile('/home/surface/surface-browser/browser-alias.txt')) !== 'browser-alias\\n') {
          throw new Error('@tracecode/harness-browser/project /workspace alias smoke failed');
        }
        const browserMountInfo = await browserWorkspace.readFile('/proc/self/mountinfo');
        if (!browserMountInfo.includes('tracekernel:workspace') || !browserMountInfo.includes('/home/surface/surface-browser')) {
          throw new Error('@tracecode/harness-browser/project mountinfo smoke failed: ' + browserMountInfo);
        }
        const browserPython = await browserWorkspace.runCommand('python3 main.py');
        if (browserPython.exitCode !== 0 || browserPython.stdout !== 'main.py:standalone-browser-python\\n') {
          throw new Error('@tracecode/harness-browser/project Python smoke failed: ' + JSON.stringify(browserPython));
        }
        const browserNode = await browserWorkspace.runCommand('node index.js');
        if (browserNode.exitCode !== 0 || browserNode.stdout !== 'standalone-browser-node\\n') {
          throw new Error('@tracecode/harness-browser/project Node smoke failed: ' + JSON.stringify(browserNode));
        }
        if ((await browserWorkspace.readFile('node.txt')) !== 'standalone-browser-node\\n') {
          throw new Error('@tracecode/harness-browser/project Node side effect failed');
        }
        const browserJava = await browserWorkspace.runCommand('java Main');
        if (browserJava.exitCode !== 0 || browserJava.stdout !== 'run:Main:standalone-browser-java\\n') {
          throw new Error('@tracecode/harness-browser/project Java smoke failed: ' + JSON.stringify(browserJava));
        }
        const browserCSharp = await browserWorkspace.runCommand('dotnet run -- alpha beta');
        if (browserCSharp.exitCode !== 0 || browserCSharp.stdout !== 'run:alpha,beta:standalone-browser-csharp\\n') {
          throw new Error('@tracecode/harness-browser/project C# smoke failed: ' + JSON.stringify(browserCSharp));
        }
        const browserCpp = await browserWorkspace.runCommand('clang++ main.cpp -o a.out');
        if (browserCpp.exitCode !== 0 || browserCpp.stdout !== 'compile:main.cpp,-o,a.out:standalone-browser-cpp\\n') {
          throw new Error('@tracecode/harness-browser/project C++ smoke failed: ' + JSON.stringify(browserCpp));
        }
        const browserGcc = await browserWorkspace.runCommand('gcc main.cpp -o c-app');
        if (browserGcc.exitCode !== 0 || browserGcc.stdout !== 'compile:main.cpp,-o,c-app:standalone-browser-cpp\\n') {
          throw new Error('@tracecode/harness-browser/project gcc alias smoke failed: ' + JSON.stringify(browserGcc));
        }
        const browserCc = await browserWorkspace.runCommand('cc main.cpp -o cc-app');
        if (browserCc.exitCode !== 0 || browserCc.stdout !== 'compile:main.cpp,-o,cc-app:standalone-browser-cpp\\n') {
          throw new Error('@tracecode/harness-browser/project cc alias smoke failed: ' + JSON.stringify(browserCc));
        }
        const browserCppRun = await browserWorkspace.runCommand('./a.out alpha beta');
        if (browserCppRun.exitCode !== 0 || browserCppRun.stdout !== 'run:alpha,beta:standalone-browser-cpp\\n') {
          throw new Error('@tracecode/harness-browser/project C++ executable smoke failed: ' + JSON.stringify(browserCppRun));
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
      'import { createBrowserProjectWorkspace } from "@tracecode/harness-browser/project";',
      'import { createRuntimeWorkspace } from "@tracecode/harness-project";',
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

  console.log('PASS: standalone language packages include scoped assets and public exports');
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-language-packages-'));
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

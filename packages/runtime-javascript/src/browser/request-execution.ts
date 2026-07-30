import type {
  RuntimeCommandEvent,
  RuntimeCommandResult,
  RuntimeFileChange,
  RuntimeKernelDevicePath,
} from "@tracecode/runtime-contracts";

import type {
  TraceKernelStat,
} from "@tracecode/tracekernel";

import {
  decodeTraceKernelWatchEvent,
} from "@tracecode/tracekernel";

import {
  RuntimeProjectLiveIoController,
  createRuntimeProjectIoBridge,
  readRuntimeCommandStdinPipeBytes,
  runtimeProjectInfrastructureFailure,
  runtimeCommandStdinPipeClosed,
  runtimeCommandStdinPipeRemainingBytes,
} from "@tracecode/runtime-contracts";

import { getLanguageRuntimeInfo } from "@tracecode/runtime-contracts";

import {
  createRuntimeKernelReadonlyFileError,
  runtimeKernelCopyErrorCode,
  runtimeKernelCopyErrorMessage,
  runtimeKernelDeviceInputRoute,
  runtimeKernelDeviceInputSource,
  runtimeKernelDeviceOutputRoute,
  runtimeKernelDeviceOutputTarget,
  runtimeKernelFileCopyErrorMessage,
  runtimeKernelFileCopyErrorCode,
  runtimeKernelFileReadFsErrorMessage,
  runtimeKernelMetadataTarget,
  runtimeKernelMutationFsErrorMessage,
  runtimeKernelOpenErrorCode,
  runtimeKernelOpenErrorMessage,
  runtimeKernelStatTarget,
  runtimeKernelWriteFsErrorMessage,
  type RuntimeKernelVirtualStat,
} from "@tracecode/runtime-contracts";

import {
  BrowserJavaScriptProjectExecutionState,
  BrowserJavaScriptProjectRunnerOptions,
  JavaScriptProjectCommandRequest,
  JavaScriptProjectFile,
} from "./contracts";

import {
  requireModulesForRequest,
} from "./worker-client";

import {
  BrowserBuffer,
  byteEqual,
  bytesFromFsWriteValue,
  bytesFromNodeValue,
  bytesToRuntimeFile,
  createZlibApi,
  fileBytes,
  requestedEncodingFromOptions,
  textEncoder,
  textFromBytes,
  utf8Bytes,
} from "../internal/encoding";

import {
  createTraceKernelApi,
} from "../kernel/process-control";
import { inodeForPath } from "../kernel/filesystem-identity";

import {
  createReadableStdinDevice,
} from "../kernel/stdio";

import {
  assertSafeWorkspaceFilePath,
  browserProcFileContents,
  createBrowserProcSnapshot,
  createWorkspacePathContext,
  fallbackKernelInfo,
  normalizeWorkspaceEntryPath,
  runtimeAccessTarget,
  runtimeCopyTarget,
  runtimeDirectoryTarget,
  runtimeFileCopyTarget,
  runtimeFileReadTarget,
  runtimeLinkTarget,
  runtimeMetadataTarget,
  runtimeMkdirTarget,
  runtimeOpenTarget,
  runtimeReadTarget,
  runtimeRemoveTarget,
  runtimeRenameTarget,
  runtimeStatTarget,
  runtimeSymlinkTarget,
  runtimeTruncateTarget,
  runtimeWriteTarget,
  throwRuntimeDirectoryTargetError,
  throwRuntimeLinkTargetError,
  throwRuntimeMetadataTargetError,
  throwRuntimeMkdirTargetError,
  throwRuntimeReadTargetError,
  throwRuntimeRemoveTargetError,
  throwRuntimeRenameTargetError,
  throwRuntimeSymlinkTargetError,
  throwRuntimeTruncateTargetError,
  throwRuntimeWriteTargetError,
  workspacePathInputToString,
  workspaceRelativeFromAbsolutePath,
} from "../kernel/workspace-paths";

import {
  AsyncFunction,
  BrowserFunction,
} from "../modules/constructors";

import {
  ModuleRecord,
} from "../modules/contracts";

import {
  formatBrowserJavaScriptErrorForStderr,
  formatConsoleValues,
  isEsmModule,
  moduleCandidates,
  moduleSearchPaths,
  nodePathEntries,
  projectDeclaresDependency,
  relativeWorkspacePath,
  resolveModulePath,
  sanitizeBrowserJavaScriptStack,
  transformDynamicImports,
  transformStaticEsmToCommonJs,
  workspaceDirname,
  workspaceFileUrl,
  workspaceFilename,
} from "../modules/resolution";
import {
  dirname,
  workspaceCwdPath,
} from "../kernel/path-normalization";
import {
  processArgvForRequest,
} from "../kernel/process-control";

import {
  createAssertApi,
} from "../node-compat/assert";

import {
  createChildProcessApi,
} from "../node-compat/child-process";

import {
  createCryptoApi,
} from "../node-compat/crypto";

import {
  createBrowserEventLoopApi,
} from "../node-compat/event-loop";

import {
  createEventsApi,
  createUtilApi,
} from "../node-compat/events-util";

import {
  createHttpApi,
  createNetApi,
  dispatchBrowserNetworkSyscall,
} from "../node-compat/network";

import {
  createOsApi,
  createPathApi,
} from "../node-compat/path-os";

import {
  addStreamInternalCloseListener,
  createStreamApi,
  setStreamInternalCloseListeners,
} from "../node-compat/streams";

import {
  createTimersPromisesApi,
} from "../node-compat/timers";

import {
  createUrlApi,
} from "../node-compat/url";

import {
  installBrowserHttpGlobalLockdown,
  installBrowserTimerGlobals,
} from "../security/authority-boundary";
import { createBrowserJavaScriptRequestState, type BrowserEntryMetadata } from './request-state';
import { createBrowserFileSystemState, type BrowserFileStat, type BrowserFileSystemStat, type BrowserFileWatcher, type BrowserFsWatcher, type BrowserStatOptions } from '../kernel/filesystem-state';
import { createBrowserFsApi } from '../kernel/fs-api';
import { createBrowserFsPromisesApi } from '../kernel/fs-promises-api';
import { createBrowserModuleRuntime } from '../modules/runtime-loader';

export async function runBrowserJavaScriptProjectRequest(
  request: JavaScriptProjectCommandRequest,
  options: BrowserJavaScriptProjectRunnerOptions,
  executionState: BrowserJavaScriptProjectExecutionState
): Promise<RuntimeCommandResult> {
    if (options.allowDynamicEval === false) {
      const stderr = 'node: JavaScript runtime is unavailable\n';
      const io = createRuntimeProjectIoBridge(request.onEvent);
      io.output('stderr', stderr);
      io.status('process-exit', 'Browser Node exited', { command: 'node', exitCode: 126 });
      return {
        stdout: '',
        stderr,
        exitCode: 126,
        error: {
          code: 'ENOEXEC',
          errno: 8,
          message: 'JavaScript runtime is unavailable',
          detail: { diagnostic: 'Dynamic evaluation is disabled' },
        },
      };
    }

    const requestState = createBrowserJavaScriptRequestState(request, options, executionState);
    const {
      assertApi,
      cache,
      childProcessApi,
      consoleApi,
      createEntryMetadata,
      cryptoApi,
      cwdPath,
      deleteEntryMetadata,
      directoryStore,
      entryMetadata,
      eventLoopApi,
      eventsApi,
      fileStore,
      hardLinkGroupForPath,
      io,
      isHiddenNamespacePath,
      kernelDevices,
      kernelInfo,
      linkPaths,
      linkedInodeForPath,
      liveIo,
      modules,
      moveHardLinkPath,
      nodePathSearchEntries,
      originalDirectoryMetadata,
      originalFiles,
      originalSymlinks,
      osApi,
      pathApi,
      procSnapshot,
      processApi,
      readDevice,
      readDeviceBytes,
      readonlyFiles,
      refreshSymlinkModuleAliases,
      requireCache,
      resolveStoredSymlinkPath,
      resolveWorkspaceEntryPath,
      runtimeFileForPath,
      stderr,
      stdout,
      streamApi,
      symlinkStore,
      syncTextModule,
      timersPromisesApi,
      touchEntryMetadata,
      traceKernelApi,
      unlinkPathFromHardLinks,
      unmodeledStorageBytes,
      unmodeledStorageEntries,
      updateEntryMetadata,
      urlApi,
      utilApi,
      virtualStorageEntries,
      workspacePathContext,
      workspaceRoot,
      writeDevice,
    } = requestState;
    const filesystemState = createBrowserFileSystemState(requestState, request, executionState);
    const {
      assertFileSystemAccess,
      assertReadonlyFilePath,
      assertStreamRangeInteger,
      assertWorkspaceFileWritePath,
      assertWorkspaceParentDirectoryPath,
      browserFileSystemStat,
      browserStatsResult,
      copyEntrySync,
      createReadableStream,
      createWritableStream,
      deleteFile,
      descriptorBytes,
      descriptorMetadataPath,
      emitDirectoryCreate,
      emitDirectoryDelete,
      emitFsWatch,
      fileDescriptor,
      fileDescriptors,
      fileSystemEntryExists,
      fsConstants,
      fsFileWatchers,
      fsWatchers,
      isWorkspaceDirectoryPath,
      metadataPathForEntry,
      missingFileStat,
      moveOpenFileDescriptorPath,
      notifyDirectoryMutation,
      notifyFsWatchers,
      notifyMetadataMutation,
      notifyWatchFileWatchers,
      parseOpenFlags,
      readDescriptorFileBytes,
      realpathForEntry,
      setFileBytes,
      statForKernelPath,
      statForKernelTarget,
      statForNormalizedPath,
      statForTraceKernelPath,
      timeToMs,
      truncateDescriptorBytes,
      truncateFileBytes,
      watchedFilename,
      workspaceFileAncestor,
      writeDescriptorBytes,
      writeDescriptorFileBytes,
    } = filesystemState;
    const fsApi = createBrowserFsApi(requestState, filesystemState, request, executionState);
    const fsPromisesApi = createBrowserFsPromisesApi(requestState, filesystemState, fsApi);
    const moduleRuntime = createBrowserModuleRuntime(
      requestState,
      filesystemState,
      fsApi,
      fsPromisesApi,
      request,
      executionState,
      options
    );
    if (moduleRuntime.cancelled) return moduleRuntime.result;
    const {
      createWorkspaceRequire,
      executeEntrypoint,
      httpApi,
      importModule,
      netApi,
      preloadParentPath,
      requireModule,
      restoreHostGlobals,
    } = moduleRuntime;

    try {
      for (const moduleName of requireModulesForRequest(request)) {
        requireModule(moduleName, preloadParentPath);
      }

      if (request.source === 'file') {
        let entryPath: string | null = null;
        try {
          const workspaceRelativePath = assertSafeWorkspaceFilePath(request.scriptPath, '', workspacePathContext);
          if (modules.has(workspaceRelativePath)) {
            entryPath = workspaceRelativePath;
          }
        } catch {
          // Fall back to cwd-relative resolution below.
        }
        await executeEntrypoint(entryPath ?? normalizeWorkspaceEntryPath(request.scriptPath, cwdPath, false, workspacePathContext));
      } else {
        const module: ModuleRecord = { exports: {} };
        const replPath = preloadParentPath;
        const requireFromRoot = createWorkspaceRequire(replPath);
        const importFromRoot = (specifier: string) => importModule(specifier, replPath);
        const evalCode = request.options?.inputType === 'module'
          ? transformStaticEsmToCommonJs(request.code, workspaceFileUrl('[eval]', workspaceRoot))
          : request.code;
        try {
          const fn = new AsyncFunction(
            'require',
            '__import',
            'module',
            'exports',
            'console',
            'process',
            'Buffer',
            '__filename',
            '__dirname',
            transformDynamicImports(evalCode)
          );
          await fn.call(
            module.exports,
            requireFromRoot,
            importFromRoot,
            module,
            module.exports,
            consoleApi,
            processApi,
            BrowserBuffer,
            `${workspaceRoot}/[eval]`,
            cwdPath ? `${workspaceRoot}/${cwdPath}` : workspaceRoot
          );
        } catch (error) {
          throw sanitizeBrowserJavaScriptStack(error, `${workspaceRoot}/[eval]`);
        }
        await Promise.resolve();
      }

      // Draining JavaScript work can create HTTP handles, and completing HTTP
      // work can schedule more JavaScript work. Alternate until both sides are
      // quiet so a detached async main cannot be truncated at process exit.
      while (!executionState.cancelled) {
        await eventLoopApi.drain();
        if (!httpApi.hasActiveWork() && !netApi.hasActiveWork()) break;
        await Promise.all([
          httpApi.hasActiveWork()
            ? httpApi.waitForClose()
            : Promise.resolve(),
          netApi.hasActiveWork()
            ? netApi.waitForClose()
            : Promise.resolve(),
        ]);
      }
      liveIo.close();
      try {
        await liveIo.flush();
      } catch (error) {
        const failed = runtimeProjectInfrastructureFailure(error, executionState.abortController.signal);
        const hostIo = createRuntimeProjectIoBridge(request.onEvent);
        hostIo.status('process-exit', 'Browser Node exited', {
          command: 'node',
          exitCode: failed.exitCode,
          error: failed.error?.message,
          ...(failed.error?.detail ?? {}),
        });
        return {
          ...failed,
          stdout: stdout.join(''),
          stderr: stderr.join(''),
        };
      }
      const resultFiles = [
        ...Array.from(fileStore.entries())
        .filter(([path, contents]) => !byteEqual(originalFiles.get(path), contents))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, contents]) => runtimeFileForPath(path, contents)),
        ...Array.from(originalFiles.keys())
          .filter((path) => !fileStore.has(path) && !symlinkStore.has(path))
          .sort((left, right) => left.localeCompare(right))
          .map((path): RuntimeFileChange => ({ path, deleted: true })),
        ...Array.from(symlinkStore.entries())
          .filter(([path, target]) => originalSymlinks.get(path) !== target)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([path, target]): RuntimeFileChange => ({ path, symlink: true, target })),
        ...Array.from(originalSymlinks.keys())
          .filter((path) => !symlinkStore.has(path) && !fileStore.has(path))
          .sort((left, right) => left.localeCompare(right))
          .map((path): RuntimeFileChange => ({ path, deleted: true })),
        ...Array.from(directoryStore)
          .filter((path) => path !== '')
          .filter((path) => {
            const current = entryMetadata.get(path);
            const original = originalDirectoryMetadata.get(path);
            return !original || !current ||
              current.mode !== original.mode ||
              current.atimeMs !== original.atimeMs ||
              current.mtimeMs !== original.mtimeMs;
          })
          .sort((left, right) => left.localeCompare(right))
          .map((path): RuntimeFileChange => {
            const metadata = entryMetadata.get(path) ?? createEntryMetadata(0o40755);
            return {
              path,
              directory: true,
              ...(metadata.mode !== undefined ? { mode: metadata.mode & 0o7777 } : {}),
              atimeMs: metadata.atimeMs,
              mtimeMs: metadata.mtimeMs,
            };
          }),
        ...Array.from(originalDirectoryMetadata.keys())
          .filter((path) => path !== '' && !directoryStore.has(path))
          .sort((left, right) => right.localeCompare(left))
          .map((path): RuntimeFileChange => ({ path, directory: true, deleted: true })),
      ]
        .sort((left, right) => left.path.localeCompare(right.path));
      const files = liveIo.filterAppliedResultFiles({
        stdout: '',
        stderr: '',
        exitCode: 0,
        files: resultFiles,
      }).files ?? [];
      httpApi.closeAll();
      eventLoopApi.clearAll();
      const exitCode = typeof processApi.exitCode === 'number' ? processApi.exitCode : 0;
      createRuntimeProjectIoBridge(request.onEvent).status('process-exit', 'Browser Node exited', { command: 'node', exitCode });
      return {
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        exitCode,
        ...(executionState.handledSignal ? { handledSignal: executionState.handledSignal } : {}),
        ...(files.length > 0 ? { files } : {}),
      };
    } catch (error) {
      httpApi.closeAll();
      eventLoopApi.clearAll();
      const sourcePath = processArgvForRequest(request)[1] ?? `${request.project.workspaceRoot ?? request.project.cwd ?? '/workspace'}/[eval]`;
      const displayError = sanitizeBrowserJavaScriptStack(error, sourcePath);
      const exitCode = typeof (displayError as { exitCode?: unknown }).exitCode === 'number'
        ? (displayError as { exitCode: number }).exitCode
        : 1;
      const stderrSuffix = (displayError as { suppressStderr?: unknown }).suppressStderr
        ? ''
        : formatBrowserJavaScriptErrorForStderr(displayError);
      const hostIo = createRuntimeProjectIoBridge(request.onEvent);
      if (stderrSuffix) {
        stderr.push(stderrSuffix);
        hostIo.output('stderr', stderrSuffix);
      }
      liveIo.close();
      try {
        await liveIo.flush();
      } catch (flushError) {
        const failed = runtimeProjectInfrastructureFailure(flushError, executionState.abortController.signal);
        hostIo.status('process-exit', 'Browser Node exited', {
          command: 'node',
          exitCode: failed.exitCode,
          error: failed.error?.message,
          ...(failed.error?.detail ?? {}),
        });
        return {
          ...failed,
          stdout: stdout.join(''),
          stderr: stderr.join(''),
        };
      }
      hostIo.status('process-exit', 'Browser Node exited', { command: 'node', exitCode });
      return {
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        exitCode,
      };
    } finally {
      // Closing sockets can cross the asynchronous TraceKernel transport.
      // Do not let the worker command finish and close that transport while
      // teardown syscalls are still in flight; doing so leaks an ECLOSED
      // rejection into the browser after an otherwise clean process exit.
      netApi.closeAll();
      try {
        await netApi.waitForClose();
      } catch {
        // The process result already owns any runtime failure. Teardown still
        // has to reach quiescence before the syscall client is released.
      }
      restoreHostGlobals();
      if (executionState.cleanupHostGlobals === restoreHostGlobals) {
        executionState.cleanupHostGlobals = undefined;
      }
    }
}

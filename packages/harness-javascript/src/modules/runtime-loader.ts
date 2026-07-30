import {
  BrowserBuffer,
  createZlibApi,
} from "../internal/encoding";

import {
  normalizeWorkspaceEntryPath,
} from "../kernel/workspace-paths";

import {
  AsyncFunction,
  BrowserFunction,
} from "./constructors";

import {
  ModuleRecord,
} from "./contracts";

import {
  isEsmModule,
  moduleCandidates,
  moduleSearchPaths,
  resolveModulePath,
  sanitizeBrowserJavaScriptStack,
  transformStaticEsmToCommonJs,
  workspaceDirname,
  workspaceFileUrl,
  workspaceFilename,
} from "./resolution";

import {
  createHttpApi,
  createNetApi,
} from "../node-compat/network";

import {
  installBrowserHttpGlobalLockdown,
  installBrowserTimerGlobals,
} from "../security/authority-boundary";

import type { BrowserJavaScriptRequestState } from '../browser/request-state';

import type { BrowserFileSystemState } from '../kernel/filesystem-state';

import type { BrowserFsApi } from '../kernel/fs-api';

import type { BrowserFsPromisesApi } from '../kernel/fs-promises-api';

import type {
  BrowserJavaScriptProjectExecutionState,
  BrowserJavaScriptProjectRunnerOptions,
  JavaScriptProjectCommandRequest,
} from '../browser/contracts';

export function createBrowserModuleRuntime(

  requestState: BrowserJavaScriptRequestState,

  filesystemState: BrowserFileSystemState,

  fsApi: BrowserFsApi,

  fsPromisesApi: BrowserFsPromisesApi,

  request: JavaScriptProjectCommandRequest,

  executionState: BrowserJavaScriptProjectExecutionState,

  options: BrowserJavaScriptProjectRunnerOptions

) {

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

  const zlibApi = createZlibApi();

  const netApi = createNetApi(
        executionState.kernelNetwork,
        request.signal
      );

  const httpApi = createHttpApi(request.kernelHttp, request.signal);

  const restoreHttpGlobals = installBrowserHttpGlobalLockdown(
        httpApi,
        options.projectUserAuthorityMode ?? 'temporary'
      );

  const restoreTimerGlobals = installBrowserTimerGlobals(eventLoopApi);

  let hostGlobalsRestored = false;

  const restoreHostGlobals = (): void => {
        if (hostGlobalsRestored) return;
        hostGlobalsRestored = true;
        eventLoopApi.clearAll();
        netApi.closeAll();
        restoreTimerGlobals();
        restoreHttpGlobals();
      };

  executionState.cleanupHostGlobals = restoreHostGlobals;

  if (executionState.cancelled) {
        restoreHostGlobals();
        return {
          cancelled: true as const,
          result: { stdout: '', stderr: '', exitCode: 1 },
        };
      }

  const builtins = new Map<string, unknown>([
        ['fs', fsApi],
        ['node:fs', fsApi],
        ['fs/promises', fsPromisesApi],
        ['node:fs/promises', fsPromisesApi],
        ['path', pathApi],
        ['node:path', pathApi],
        ['os', osApi],
        ['node:os', osApi],
        ['url', urlApi],
        ['node:url', urlApi],
        ['buffer', { Buffer: BrowserBuffer }],
        ['node:buffer', { Buffer: BrowserBuffer }],
        ['net', netApi.module],
        ['node:net', netApi.module],
        ['http', httpApi.module],
        ['node:http', httpApi.module],
        ['https', httpApi.httpsModule],
        ['node:https', httpApi.httpsModule],
        ['zlib', zlibApi],
        ['node:zlib', zlibApi],
        ['assert', assertApi],
        ['node:assert', assertApi],
        ['assert/strict', assertApi],
        ['node:assert/strict', assertApi],
        ['events', eventsApi],
        ['node:events', eventsApi],
        ['util', utilApi],
        ['node:util', utilApi],
        ['stream', streamApi],
        ['node:stream', streamApi],
        ['child_process', childProcessApi],
        ['node:child_process', childProcessApi],
        ['tracekernel', traceKernelApi],
        ['node:tracekernel', traceKernelApi],
        ['timers/promises', timersPromisesApi],
        ['node:timers/promises', timersPromisesApi],
        ['crypto', cryptoApi],
        ['node:crypto', cryptoApi],
        ['process', processApi],
        ['node:process', processApi],
      ]);

  const normalizeModuleSpecifier = (specifier: string): string => (
        specifier.startsWith('/')
          ? normalizeWorkspaceEntryPath(specifier, '', false, workspacePathContext)
          : specifier
      );

  const requireModule = (specifier: string, parentPath: string, parentModule: ModuleRecord | null = null) => {
        if (builtins.has(specifier)) return builtins.get(specifier);
        refreshSymlinkModuleAliases();
        const normalizedSpecifier = normalizeModuleSpecifier(specifier);
        return executeModule(resolveModulePath(modules, normalizedSpecifier, parentPath, nodePathSearchEntries, 'require'), parentModule);
      };

  const resolveRequireModule = (specifier: string, parentPath: string): string => {
        if (builtins.has(specifier)) return specifier;
        refreshSymlinkModuleAliases();
        const normalizedSpecifier = normalizeModuleSpecifier(specifier);
        return workspaceFilename(resolveModulePath(modules, normalizedSpecifier, parentPath, nodePathSearchEntries, 'require'), workspaceRoot);
      };

  const createWorkspaceRequire = (
        parentPath: string,
        parentModule: ModuleRecord | null = null
      ): ((specifier: string) => unknown) & {
        cache: Record<string, ModuleRecord>;
        main?: ModuleRecord;
        resolve: (specifier: string) => string;
      } => {
        const localRequire = ((specifier: string) => requireModule(specifier, parentPath, parentModule)) as ((specifier: string) => unknown) & {
          cache: Record<string, ModuleRecord>;
          resolve: (specifier: string) => string;
          main?: ModuleRecord;
        };
        localRequire.cache = requireCache;
        localRequire.resolve = (specifier: string) => resolveRequireModule(specifier, parentPath);
        Object.defineProperty(localRequire, 'main', {
          configurable: true,
          enumerable: true,
          get: () => requestState.mainModule,
        });
        return localRequire;
      };

  const importModule = (specifier: string, parentPath: string) => (
        builtins.has(specifier)
          ? Promise.resolve(builtins.get(specifier))
          : (refreshSymlinkModuleAliases(), Promise.resolve(executeModule(resolveModulePath(modules, normalizeModuleSpecifier(specifier), parentPath, nodePathSearchEntries, 'import'))))
      );

  const preloadParentPath = cwdPath ? `${cwdPath}/repl.js` : 'repl.js';

  const createModuleRecord = (normalizedPath: string, parent: ModuleRecord | null): ModuleRecord => ({
        exports: {},
        id: workspaceFilename(normalizedPath, workspaceRoot),
        filename: workspaceFilename(normalizedPath, workspaceRoot),
        loaded: false,
        parent,
        children: [],
        path: workspaceDirname(normalizedPath, workspaceRoot),
        paths: moduleSearchPaths(normalizedPath, workspaceRoot),
      });

  const executeModule = (modulePath: string, parent: ModuleRecord | null = null, isMain = false): unknown => {
        const normalizedPath = moduleCandidates(modules, modulePath, 'require').find((candidate) => modules.has(candidate));
        if (!normalizedPath) {
          throw new Error(`Cannot find module '${modulePath}'`);
        }
        const cacheKey = workspaceFilename(normalizedPath, workspaceRoot);

        const cached = cache.get(normalizedPath);
        if (cached && requireCache[cacheKey]) {
          if (parent?.children && !parent.children.includes(cached)) parent.children.push(cached);
          return cached.exports;
        } else if (cached) {
          cache.delete(normalizedPath);
        }

        const code = modules.get(normalizedPath);
        if (code === undefined) {
          throw new Error(`Cannot find module '${modulePath}'`);
        }

        if (normalizedPath.endsWith('.json')) {
          const parsed = JSON.parse(code) as unknown;
          const jsonModule = createModuleRecord(normalizedPath, parent);
          jsonModule.exports = parsed;
          jsonModule.loaded = true;
          cache.set(normalizedPath, jsonModule);
          requireCache[cacheKey] = jsonModule;
          if (parent?.children) parent.children.push(jsonModule);
          return parsed;
        }

        const module = createModuleRecord(normalizedPath, parent);
        if (isMain) {
          module.id = '.';
          requestState.mainModule = module;
        }
        cache.set(normalizedPath, module);
        requireCache[cacheKey] = module;
        if (parent?.children) parent.children.push(module);
        const localRequire = createWorkspaceRequire(normalizedPath, module);
        module.require = localRequire;
        const localImport = (specifier: string) => importModule(specifier, normalizedPath);
        const executableCode = isEsmModule(modules, normalizedPath)
          ? transformStaticEsmToCommonJs(code, workspaceFileUrl(normalizedPath, workspaceRoot))
          : code;
        try {
          const fn = new BrowserFunction(
            'require',
            '__import',
            'module',
            'exports',
            'console',
            'process',
            'Buffer',
            '__filename',
            '__dirname',
            executableCode
          );
          fn.call(
            isEsmModule(modules, normalizedPath) ? undefined : module.exports,
            localRequire,
            localImport,
            module,
            module.exports,
            consoleApi,
            processApi,
            BrowserBuffer,
            workspaceFilename(normalizedPath, workspaceRoot),
            workspaceDirname(normalizedPath, workspaceRoot)
          );
        } catch (error) {
          throw sanitizeBrowserJavaScriptStack(error, workspaceFilename(normalizedPath, workspaceRoot));
        }
        module.loaded = true;
        return module.exports;
      };

  const executeEntrypoint = async (modulePath: string): Promise<void> => {
        refreshSymlinkModuleAliases();
        const normalizedPath = moduleCandidates(modules, modulePath, 'import').find((candidate) => modules.has(candidate));
        if (!normalizedPath) {
          throw new Error(`Cannot find module '${modulePath}'`);
        }

        if (!isEsmModule(modules, normalizedPath)) {
          executeModule(normalizedPath, null, true);
          await Promise.resolve();
          return;
        }

        const cached = cache.get(normalizedPath);
        if (cached) return;

        const code = modules.get(normalizedPath);
        if (code === undefined) {
          throw new Error(`Cannot find module '${modulePath}'`);
        }

        const module = createModuleRecord(normalizedPath, null);
        module.id = '.';
        requestState.mainModule = module;
        cache.set(normalizedPath, module);
        requireCache[workspaceFilename(normalizedPath, workspaceRoot)] = module;
        const localRequire = createWorkspaceRequire(normalizedPath, module);
        module.require = localRequire;
        const localImport = (specifier: string) => importModule(specifier, normalizedPath);
        const executableCode = transformStaticEsmToCommonJs(code, workspaceFileUrl(normalizedPath, workspaceRoot));
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
            executableCode
          );
          await fn.call(
            undefined,
            localRequire,
            localImport,
            module,
            module.exports,
            consoleApi,
            processApi,
            BrowserBuffer,
            workspaceFilename(normalizedPath, workspaceRoot),
            workspaceDirname(normalizedPath, workspaceRoot)
          );
        } catch (error) {
          throw sanitizeBrowserJavaScriptStack(error, workspaceFilename(normalizedPath, workspaceRoot));
        }
        module.loaded = true;
        await Promise.resolve();
      };

  return {

    cancelled: false as const,

    createWorkspaceRequire,

    executeEntrypoint,

    httpApi,

    importModule,

    netApi,

    preloadParentPath,

    requireModule,

    restoreHostGlobals,

  };

}

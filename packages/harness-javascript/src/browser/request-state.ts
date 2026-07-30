import type {
  RuntimeCommandEvent,
  RuntimeKernelDevicePath,
} from "@tracecode/harness-core";
import {
  RuntimeProjectLiveIoController,
  createRuntimeProjectIoBridge,
  readRuntimeCommandStdinPipeBytes,
  runtimeCommandStdinPipeClosed,
  runtimeCommandStdinPipeRemainingBytes,
} from "@tracecode/harness-core";
import {
  BROWSER_PROJECT_NODE_COMPAT_VERSION,
  getLanguageRuntimeInfo,
} from "@tracecode/harness-core";
import {
  runtimeKernelDeviceInputRoute,
  runtimeKernelDeviceOutputRoute,
  runtimeKernelDeviceOutputTarget,
} from "@tracecode/harness-core";
import {
  type BrowserJavaScriptProjectExecutionState,
  type BrowserJavaScriptProjectRunnerOptions,
  type JavaScriptProjectCommandRequest,
  JavaScriptProjectFile,
} from "./contracts";
import { inodeForPath } from "../kernel/filesystem-identity";
import {
  byteEqual,
  bytesFromFsWriteValue,
  bytesToRuntimeFile,
  fileBytes,
  textEncoder,
  textFromBytes,
  utf8Bytes,
} from "../internal/encoding";
import {
  createTraceKernelApi,
} from "../kernel/process-control";
import {
  createReadableStdinDevice,
} from "../kernel/stdio";
import {
  assertSafeWorkspaceFilePath,
  createBrowserProcSnapshot,
  createWorkspacePathContext,
  fallbackKernelInfo,
  normalizeWorkspaceEntryPath,
} from "../kernel/workspace-paths";
import {
  ModuleRecord,
} from "../modules/contracts";
import {
  formatConsoleValues,
  nodePathEntries,
  projectDeclaresDependency,
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
  createOsApi,
  createPathApi,
} from "../node-compat/path-os";
import {
  createStreamApi,
} from "../node-compat/streams";
import {
  createTimersPromisesApi,
} from "../node-compat/timers";
import {
  createUrlApi,
} from "../node-compat/url";

export type BrowserEntryMetadata = {
      atimeMs: number;
      birthtimeMs: number;
      ctimeMs: number;
      gid: number;
      mode?: number;
      mtimeMs: number;
      uid: number;
    };

export function createBrowserJavaScriptRequestState(
  request: JavaScriptProjectCommandRequest,
  options: BrowserJavaScriptProjectRunnerOptions,
  executionState: BrowserJavaScriptProjectExecutionState
) {
  const stdout: string[] = [];

  const stderr: string[] = [];

  const liveIo = new RuntimeProjectLiveIoController({
        applyFileChange: options.applyFileChange ? async (change, phase, applyOptions) => {
          if (executionState.cancelled) return false;
          return options.applyFileChange?.(change, phase, applyOptions);
        } : undefined,
        onEvent: (event) => {
          if (!executionState.cancelled) request.onEvent?.(event);
        },
        signal: executionState.abortController.signal,
      });

  const emitRuntimeEvent = (event: RuntimeCommandEvent): void => {
        liveIo.handleRuntimeEvent(event);
      };

  const io = createRuntimeProjectIoBridge(emitRuntimeEvent);

  const workspacePathContext = createWorkspacePathContext(request.project);

  const workspaceRoot = workspacePathContext.root;

  const kernelInfo = request.project.kernel ?? fallbackKernelInfo(request.project, workspacePathContext);

  const kernelDevices = request.project.kernelDevices;

  const procSnapshot = createBrowserProcSnapshot(request.project.kernelFiles, request);

  const cwdPath = workspaceCwdPath(request);

  const hiddenFiles = Array.from(new Set(
        (request.project.hiddenFiles ?? []).map((path) => normalizeWorkspaceEntryPath(path, '', false, workspacePathContext))
      ));

  const hiddenNamespaces = new Set<string>();

  for (const hiddenPath of hiddenFiles) {
        if (!hiddenPath) continue;
        hiddenNamespaces.add(hiddenPath);
        const parts = hiddenPath.split('/');
        for (let index = 1; index < parts.length; index += 1) {
          hiddenNamespaces.add(parts.slice(0, index).join('/'));
        }
      }

  const isHiddenNamespacePath = (path: string): boolean =>
        Boolean(path) && Array.from(hiddenNamespaces).some((hiddenPath) => path === hiddenPath || path.startsWith(`${hiddenPath}/`));

  const isHiddenProjectPath = (path: string): boolean =>
        isHiddenNamespacePath(path) || hiddenFiles.some((hiddenPath) => hiddenPath.startsWith(`${path}/`));

  const readonlyFiles = new Set(
        (request.project.readonlyFiles ?? []).map((path) => normalizeWorkspaceEntryPath(path, '', false, workspacePathContext))
      );

  io.status('process-start', 'Starting browser Node', {
        command: 'node',
        args: processArgvForRequest(request).slice(2),
        cwd: request.cwd,
      });

  const visibleProjectFiles = request.project.files.filter((file) =>
        !isHiddenProjectPath(assertSafeWorkspaceFilePath(file.path, '', workspacePathContext))
      );

  const visibleProjectSymlinks = (request.project.symlinks ?? []).filter((symlink) =>
        !isHiddenProjectPath(assertSafeWorkspaceFilePath(symlink.path, '', workspacePathContext))
      );

  const modules = new Map(
        visibleProjectFiles
          .filter((file) => file.encoding !== 'base64')
          .map((file) => [
            assertSafeWorkspaceFilePath(file.path, '', workspacePathContext),
            file.contents.startsWith('#!')
              ? file.contents.replace(/^#![^\r\n]*(?:\r?\n|$)/, (line) => line.replace(/[^\r\n]/g, ' '))
              : file.contents,
          ])
      );

  const virtualTextFiles = new Map<string, string>();

  const virtualTypeScriptPackagePaths = [
        'node_modules/typescript/package.json',
        'node_modules/typescript/index.js',
      ];

  const hasTypeScriptPackage = Array.from(modules.keys()).some((path) => path.startsWith('node_modules/typescript/'));

  const canExposeVirtualTypeScriptPackage = virtualTypeScriptPackagePaths.every((path) => !isHiddenProjectPath(path));

  if (!hasTypeScriptPackage && canExposeVirtualTypeScriptPackage && projectDeclaresDependency(modules, 'typescript')) {
        const version = getLanguageRuntimeInfo('typescript').compiler?.version ?? '5.9.3';
        virtualTextFiles.set('node_modules/typescript/package.json', JSON.stringify({
          name: 'typescript',
          version,
          main: 'index.js',
        }, null, 2) + '\n');
        virtualTextFiles.set('node_modules/typescript/index.js', [
          `const version = ${JSON.stringify(version)};`,
          'module.exports = {',
          '  version,',
          '  versionMajorMinor: version.split(".").slice(0, 2).join("."),',
          '};',
          '',
        ].join('\n'));
      }

  for (const [path, contents] of virtualTextFiles) {
        modules.set(path, contents);
      }

  const fileStore = new Map(
        visibleProjectFiles.map((file) => [assertSafeWorkspaceFilePath(file.path, '', workspacePathContext), fileBytes(file)] as const)
      );

  const symlinkStore = new Map(
        visibleProjectSymlinks.map((symlink) => [
          assertSafeWorkspaceFilePath(symlink.path, '', workspacePathContext),
          symlink.target,
        ] as const)
      );

  for (const [path, contents] of virtualTextFiles) {
        fileStore.set(path, textEncoder.encode(contents));
      }

  const initialVisibleBytes = visibleProjectFiles.reduce((total, file) => total + fileBytes(file).byteLength, 0) +
        visibleProjectSymlinks.reduce((total, symlink) => total + utf8Bytes(symlink.target).byteLength, 0);

  const initialVisibleEntries = new Set([
        ...visibleProjectFiles.map((file) => assertSafeWorkspaceFilePath(file.path, '', workspacePathContext)),
        ...visibleProjectSymlinks.map((symlink) => assertSafeWorkspaceFilePath(symlink.path, '', workspacePathContext)),
        ...(request.project.directories ?? []).map((directory) =>
          normalizeWorkspaceEntryPath(directory, '', true, workspacePathContext)
        ).filter(Boolean),
      ]);

  const unmodeledStorageBytes = Math.max(0, (request.project.storage?.usedBytes ?? initialVisibleBytes) - initialVisibleBytes);

  const unmodeledStorageEntries = Math.max(
        0,
        (request.project.storage?.usedEntries ?? initialVisibleEntries.size) - initialVisibleEntries.size
      );

  const virtualStorageEntries = new Set<string>();

  for (const path of virtualTextFiles.keys()) {
        virtualStorageEntries.add(path);
        const parts = path.split('/');
        for (let index = 1; index < parts.length; index += 1) {
          const directory = parts.slice(0, index).join('/');
          if (!initialVisibleEntries.has(directory)) virtualStorageEntries.add(directory);
        }
      }

  const directoryStore = new Set<string>(['']);

  for (const filePath of fileStore.keys()) {
        const parts = filePath.split('/');
        for (let index = 1; index < parts.length; index += 1) {
          directoryStore.add(parts.slice(0, index).join('/'));
        }
      }

  for (const symlinkPath of symlinkStore.keys()) {
        const parts = symlinkPath.split('/');
        for (let index = 1; index < parts.length; index += 1) {
          directoryStore.add(parts.slice(0, index).join('/'));
        }
      }

  for (const directory of request.project.directories ?? []) {
        const directoryPath = normalizeWorkspaceEntryPath(directory, '', true, workspacePathContext);
        if (!directoryPath) continue;
        if (isHiddenProjectPath(directoryPath)) continue;
        const parts = directoryPath.split('/');
        for (let index = 1; index <= parts.length; index += 1) {
          directoryStore.add(parts.slice(0, index).join('/'));
        }
      }

  const projectDirectoryMetadata = new Map(
        (request.project.directoryMetadata ?? []).map((directory) => [
          normalizeWorkspaceEntryPath(directory.path, '', true, workspacePathContext),
          directory,
        ])
      );

  let fsTimestampMs = Math.max(1, ...visibleProjectFiles.map((file) => file.mtimeMs ?? 1));

  const createEntryMetadata = (
        mode?: number,
        timestamps: { atimeMs?: number; mtimeMs?: number } = {}
      ): BrowserEntryMetadata => ({
        atimeMs: timestamps.atimeMs ?? timestamps.mtimeMs ?? fsTimestampMs,
        birthtimeMs: timestamps.mtimeMs ?? fsTimestampMs,
        ctimeMs: timestamps.mtimeMs ?? fsTimestampMs,
        gid: 1000,
        mode,
        mtimeMs: timestamps.mtimeMs ?? fsTimestampMs,
        uid: 1000,
      });

  const entryMetadata = new Map<string, BrowserEntryMetadata>(
        visibleProjectFiles.map((file) => {
          const filePath = assertSafeWorkspaceFilePath(file.path, '', workspacePathContext);
          return [filePath, createEntryMetadata(0o100000 | (file.mode ?? 0o644), file)] as const;
        })
      );

  for (const symlinkPath of symlinkStore.keys()) {
        entryMetadata.set(symlinkPath, createEntryMetadata(0o120777));
      }

  for (const path of virtualTextFiles.keys()) {
        entryMetadata.set(path, createEntryMetadata(0o100644));
      }

  for (const directoryPath of directoryStore) {
        if (!entryMetadata.has(directoryPath)) {
          const metadata = projectDirectoryMetadata.get(directoryPath);
          entryMetadata.set(directoryPath, createEntryMetadata(
            0o40000 | (metadata?.mode ?? 0o755),
            { atimeMs: metadata?.atimeMs, mtimeMs: metadata?.mtimeMs }
          ));
        }
      }

  const touchEntryMetadata = (path: string): void => {
        fsTimestampMs += 1;
        const previous = entryMetadata.get(path);
        entryMetadata.set(path, {
          atimeMs: previous?.atimeMs ?? fsTimestampMs,
          birthtimeMs: previous?.birthtimeMs ?? fsTimestampMs,
          ctimeMs: fsTimestampMs,
          gid: previous?.gid ?? 1000,
          mode: previous?.mode,
          mtimeMs: fsTimestampMs,
          uid: previous?.uid ?? 1000,
        });
      };

  const updateEntryMetadata = (path: string, update: Partial<BrowserEntryMetadata>): void => {
        fsTimestampMs += 1;
        const previous = entryMetadata.get(path) ?? createEntryMetadata();
        entryMetadata.set(path, {
          ...previous,
          ...update,
          ctimeMs: fsTimestampMs,
        });
      };

  const deleteEntryMetadata = (path: string): void => {
        fsTimestampMs += 1;
        entryMetadata.delete(path);
      };

  const runtimeFileForPath = (path: string, bytes: Uint8Array): JavaScriptProjectFile => {
        const metadata = entryMetadata.get(path);
        return {
          ...bytesToRuntimeFile(path, bytes),
          ...(metadata?.mode !== undefined ? { mode: metadata.mode & 0o7777 } : {}),
          ...(metadata ? { atimeMs: metadata.atimeMs, mtimeMs: metadata.mtimeMs } : {}),
        };
      };

  const hardLinkGroups = new Map<string, Set<string>>();

  const hardLinkGroupForPath = (path: string): Set<string> => hardLinkGroups.get(path) ?? new Set([path]);

  const setHardLinkGroup = (paths: Iterable<string>): Set<string> => {
        const group = new Set(paths);
        for (const path of group) hardLinkGroups.set(path, group);
        return group;
      };

  const linkPaths = (source: string, destination: string): void => {
        setHardLinkGroup([...hardLinkGroupForPath(source), destination]);
      };

  const unlinkPathFromHardLinks = (path: string): void => {
        const group = hardLinkGroups.get(path);
        if (!group) return;
        group.delete(path);
        hardLinkGroups.delete(path);
        if (group.size <= 1) {
          for (const remaining of group) hardLinkGroups.delete(remaining);
          return;
        }
        for (const remaining of group) hardLinkGroups.set(remaining, group);
      };

  const moveHardLinkPath = (oldPath: string, newPath: string): void => {
        const group = hardLinkGroups.get(oldPath);
        if (!group) return;
        group.delete(oldPath);
        group.add(newPath);
        hardLinkGroups.delete(oldPath);
        for (const path of group) hardLinkGroups.set(path, group);
      };

  const linkedInodeForPath = (path: string): number => {
        const group = hardLinkGroups.get(path);
        return inodeForPath(group ? [...group].sort((left, right) => left.localeCompare(right))[0] ?? path : path);
      };

  const resolveStoredSymlinkPath = (path: string, followFinal = true): string => {
        let current = path;
        for (let depth = 0; depth < 40; depth += 1) {
          const parts = current.split('/').filter(Boolean);
          const limit = followFinal ? parts.length : Math.max(0, parts.length - 1);
          let linkIndex = -1;
          let linkPath = '';
          for (let index = 0; index < limit; index += 1) {
            const candidate = parts.slice(0, index + 1).join('/');
            if (symlinkStore.has(candidate)) {
              linkIndex = index;
              linkPath = candidate;
              break;
            }
          }
          if (linkIndex === -1) return current;
          const target = symlinkStore.get(linkPath)!;
          const targetPath = normalizeWorkspaceEntryPath(target, dirname(linkPath), true, workspacePathContext);
          const suffix = parts.slice(linkIndex + 1).join('/');
          current = suffix
            ? normalizeWorkspaceEntryPath(`${targetPath}/${suffix}`, '', true, workspacePathContext)
            : targetPath;
        }
        throw Object.assign(new Error(`ELOOP: too many symbolic links encountered, stat '${path}'`), { code: 'ELOOP' });
      };

  const resolveWorkspaceEntryPath = (path: unknown, followFinal = true): string =>
        resolveStoredSymlinkPath(
          normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext),
          followFinal
        );

  const originalFiles = new Map(fileStore);

  const originalSymlinks = new Map(symlinkStore);

  const originalDirectoryMetadata = new Map(
        [...directoryStore].map((path) => [path, { ...(entryMetadata.get(path) ?? createEntryMetadata(0o40755)) }])
      );

  const cache = new Map<string, ModuleRecord>();

  const requireCache: Record<string, ModuleRecord> = {};

  const symlinkModuleAliases = new Set<string>();

  const refreshSymlinkModuleAliases = (): void => {
        for (const alias of symlinkModuleAliases) {
          modules.delete(alias);
          cache.delete(alias);
          delete requireCache[workspaceFilename(alias, workspaceRoot)];
        }
        symlinkModuleAliases.clear();
        for (const linkPath of symlinkStore.keys()) {
          let resolved: string;
          try {
            resolved = resolveStoredSymlinkPath(linkPath);
          } catch {
            continue;
          }
          const linkedModule = modules.get(resolved);
          if (linkedModule !== undefined && !fileStore.has(linkPath)) {
            modules.set(linkPath, linkedModule);
            symlinkModuleAliases.add(linkPath);
          }
          const prefix = `${resolved}/`;
          for (const [modulePath, contents] of [...modules.entries()]) {
            if (!modulePath.startsWith(prefix) || symlinkModuleAliases.has(modulePath)) continue;
            const alias = `${linkPath}/${modulePath.slice(prefix.length)}`;
            if (fileStore.has(alias)) continue;
            modules.set(alias, contents);
            symlinkModuleAliases.add(alias);
          }
        }
      };

  let mainModule: ModuleRecord | undefined;

  const kernelStdioAvailability = new Map<number, boolean>();

  const tryWriteKernelStdio = (fd: 1 | 2, bytes: Uint8Array): boolean => {
        if (kernelStdioAvailability.get(fd) === false || !executionState.kernelSyscalls) {
          return false;
        }
        const result = executionState.kernelSyscalls.dispatchSync({
          op: 'write',
          fd,
          bytes,
        });
        if (result.ok === true) {
          kernelStdioAvailability.set(fd, true);
          return true;
        }
        if (result.error.code === 'EBADF') {
          kernelStdioAvailability.set(fd, false);
          return false;
        }
        throw Object.assign(new Error(result.error.message), {
          code: result.error.code,
        });
      };

  const emitOutput = (
        stream: 'stdout' | 'stderr',
        data: string,
        device?: RuntimeKernelDevicePath,
        sourceDevice?: RuntimeKernelDevicePath
      ): void => {
        if (stream === 'stdout') {
          stdout.push(data);
        } else {
          stderr.push(data);
        }
        io.output(stream, data, device, sourceDevice);
      };

  const writeDevice = (device: RuntimeKernelDevicePath, data: string): void => {
        const route = runtimeKernelDeviceOutputRoute(kernelDevices, device);
        if (!route) {
          if (runtimeKernelDeviceOutputTarget(kernelDevices, device) === '/dev/null') return;
          throw Object.assign(new Error('EBADF: bad file descriptor, write'), { code: 'EBADF' });
        }
        if (
          tryWriteKernelStdio(
            route.stream === 'stdout' ? 1 : 2,
            new TextEncoder().encode(data)
          )
        ) return;
        emitOutput(route.stream, data, route.outputDevice, route.sourceDevice);
      };

  let kernelStdinClosed = false;

  const readDeviceBytes = (device: RuntimeKernelDevicePath, size?: number): Uint8Array => {
        const inputRoute = runtimeKernelDeviceInputRoute(kernelDevices, device);
        if (!inputRoute) return new Uint8Array();
        if (executionState.kernelSyscalls) {
          if (kernelStdinClosed) return new Uint8Array();
          const result = executionState.kernelSyscalls.dispatchSync({
            op: 'read',
            fd: 0,
            maxBytes: Math.max(0, Math.floor(size ?? 16 * 1024)),
          });
          if (result.ok === false) {
            throw Object.assign(new Error(result.error.message), {
              code: result.error.code,
            });
          }
          if (result.value.op !== 'read') {
            throw Object.assign(
              new Error(`EPROTO: expected read response, received ${result.value.op}`),
              { code: 'EPROTO' }
            );
          }
          if (result.value.bytes.byteLength === 0) kernelStdinClosed = true;
          return result.value.bytes;
        }
        if (request.stdinPipe) {
          return readRuntimeCommandStdinPipeBytes(request.stdinPipe, size);
        }
        return new Uint8Array();
      };

  const remainingDeviceBytes = (device: RuntimeKernelDevicePath): number => (
        runtimeKernelDeviceInputRoute(kernelDevices, device)
          ? executionState.kernelSyscalls
            ? kernelStdinClosed ? 0 : 1
            : request.stdinPipe
            ? runtimeCommandStdinPipeRemainingBytes(request.stdinPipe)
            : 0
          : 0
      );

  const deviceInputClosed = (device: RuntimeKernelDevicePath): boolean => (
        runtimeKernelDeviceInputRoute(kernelDevices, device)
          ? executionState.kernelSyscalls
            ? kernelStdinClosed
            : request.stdinPipe ? runtimeCommandStdinPipeClosed(request.stdinPipe) : true
          : true
      );

  const readDevice = (device: RuntimeKernelDevicePath): string => textFromBytes(readDeviceBytes(device));

  const kernelDescriptorIsTerminal = (fd: number): boolean => {
        if (!executionState.kernelSyscalls) {
          return request.terminal?.isTTY === true;
        }
        const result = executionState.kernelSyscalls.dispatchSync({
          op: 'isatty',
          fd,
        });
        return result.ok &&
          result.value.op === 'isatty' &&
          result.value.isTerminal;
      };

  const kernelDescriptorWindowSize = (
        fd: number
      ): { readonly rows?: number; readonly columns?: number } => {
        if (!executionState.kernelSyscalls) {
          return {
            rows: request.terminal?.rows,
            columns: request.terminal?.columns,
          };
        }
        const result = executionState.kernelSyscalls.dispatchSync({
          op: 'tcgetwinsize',
          fd,
        });
        if (result.ok === false) {
          if (result.error.code === 'ENOTTY') return {};
          throw Object.assign(new Error(result.error.message), {
            code: result.error.code,
          });
        }
        if (result.value.op !== 'tcgetwinsize') {
          throw Object.assign(
            new Error(
              `EPROTO: expected tcgetwinsize response, received ${result.value.op}`
            ),
            { code: 'EPROTO' }
          );
        }
        return {
          rows: result.value.rows,
          columns: result.value.columns,
        };
      };

  const consoleApi = {
        log: (...values: unknown[]) => {
          writeDevice('/dev/stdout', `${formatConsoleValues(values)}\n`);
        },
        error: (...values: unknown[]) => {
          writeDevice('/dev/stderr', `${formatConsoleValues(values)}\n`);
        },
      };

  const createWritableDevice = (device: RuntimeKernelDevicePath, fd: number) => {
        const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
        let destroyed = false;
        let closed = false;
        let bytesWritten = 0;
        let writableEnded = false;
        let writableFinished = false;
        const on = (event: string, listener: (...args: unknown[]) => void): void => {
          const next = listeners.get(event) ?? [];
          next.push(listener);
          listeners.set(event, next);
        };
        const removeListener = (event: string, listener: (...args: unknown[]) => void): void => {
          const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== listener);
          if (next.length === 0) listeners.delete(event);
          else listeners.set(event, next);
        };
        const emit = (event: string, ...args: unknown[]): boolean => {
          const current = listeners.get(event) ?? [];
          for (const listener of current) listener(...args);
          return current.length > 0;
        };
        const stream = {
          fd,
          writable: true,
          isTTY: kernelDescriptorIsTerminal(fd),
          get columns() {
            return kernelDescriptorWindowSize(fd).columns;
          },
          get rows() {
            return kernelDescriptorWindowSize(fd).rows;
          },
          getWindowSize: (): [number | undefined, number | undefined] => {
            const size = kernelDescriptorWindowSize(fd);
            return [size.columns, size.rows];
          },
          getColorDepth: () => request.terminal?.colorLevel === 3
            ? 24
            : request.terminal?.colorLevel === 2
              ? 8
              : request.terminal?.colorLevel === 1
                ? 4
                : 1,
          hasColors: () => (request.terminal?.colorLevel ?? 0) > 0,
          get closed() {
            return closed;
          },
          get bytesWritten() {
            return bytesWritten;
          },
          get writableEnded() {
            return writableEnded;
          },
          get writableFinished() {
            return writableFinished;
          },
          write: (value: unknown, encoding?: string | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
            const bytes = bytesFromFsWriteValue(value, typeof encoding === 'string' ? encoding : undefined);
            if (!tryWriteKernelStdio(fd === 1 ? 1 : 2, bytes)) {
              writeDevice(device, textFromBytes(bytes));
            }
            bytesWritten += bytes.byteLength;
            const done = typeof encoding === 'function' ? encoding : callback;
            done?.(null);
            return true;
          },
          end: (value?: unknown, encoding?: string | (() => void), callback?: () => void) => {
            if (value !== undefined && value !== null) {
              stream.write(value, typeof encoding === 'string' ? encoding : undefined);
            }
            writableEnded = true;
            const done = typeof encoding === 'function' ? encoding : callback;
            queueMicrotask(() => {
              done?.();
              writableFinished = true;
              emit('finish');
              closed = true;
              emit('close');
            });
            return stream;
          },
          on: (event: string, listener: (...args: unknown[]) => void) => {
            on(event, listener);
            return stream;
          },
          addListener: (event: string, listener: (...args: unknown[]) => void) => {
            on(event, listener);
            return stream;
          },
          removeListener: (event: string, listener: (...args: unknown[]) => void) => {
            removeListener(event, listener);
            return stream;
          },
          off: (event: string, listener: (...args: unknown[]) => void) => {
            removeListener(event, listener);
            return stream;
          },
          emit,
          destroy: (error?: Error) => {
            if (destroyed) return stream;
            destroyed = true;
            queueMicrotask(() => {
              if (error) emit('error', error);
              closed = true;
              emit('close');
            });
            return stream;
          },
          close: (callback?: () => void) => {
            if (callback) stream.once('close', callback);
            return stream.destroy();
          },
          get destroyed() {
            return destroyed;
          },
          once: (event: string, listener: (...args: unknown[]) => void) => {
            const wrapped = (...args: unknown[]) => {
              removeListener(event, wrapped);
              listener(...args);
            };
            on(event, wrapped);
            return stream;
          },
        };
        return stream;
      };

  const eventLoopApi = createBrowserEventLoopApi(executionState);

  const stdinDevice = createReadableStdinDevice(
        (size) => readDeviceBytes('/dev/stdin', size),
        () => remainingDeviceBytes('/dev/stdin'),
        () => deviceInputClosed('/dev/stdin'),
        eventLoopApi.setTimeout,
        request.terminal,
        kernelDescriptorIsTerminal(0)
      );

  const nodeVersion = BROWSER_PROJECT_NODE_COMPAT_VERSION;

  const processListeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const addProcessListener = (event: string, listener: (...args: unknown[]) => void): void => {
        if ((event === 'SIGKILL' || event === 'SIGSTOP')) {
          throw Object.assign(new Error(`uv_signal_start EINVAL`), { code: 'EINVAL', errno: -22, syscall: 'uv_signal_start' });
        }
        const next = processListeners.get(event) ?? [];
        next.push(listener);
        processListeners.set(event, next);
      };

  const removeProcessListener = (event: string, listener: (...args: unknown[]) => void): void => {
        const next = (processListeners.get(event) ?? []).filter((candidate) => candidate !== listener);
        if (next.length === 0) processListeners.delete(event);
        else processListeners.set(event, next);
      };

  const emitProcessEvent = (event: string, ...args: unknown[]): boolean => {
        const current = [...(processListeners.get(event) ?? [])];
        for (const listener of current) listener(...args);
        return current.length > 0;
      };

  executionState.dispatchSignal = (signal) => {
        const handled = emitProcessEvent(signal, signal);
        if (handled) executionState.handledSignal = signal;
        return handled;
      };

  const processApi = {
        argv: processArgvForRequest(request),
        execArgv: [] as string[],
        execPath: '/usr/local/bin/node',
        env: request.env,
        version: `v${nodeVersion}`,
        versions: { node: nodeVersion },
        release: { name: 'node' },
        platform: 'tracekernel',
        arch: 'x64',
        pid: request.process?.pid ?? 1,
        get ppid(): number {
          if (!executionState.kernelSyscalls) {
            return request.process?.ppid ?? 0;
          }
          const result = executionState.kernelSyscalls.dispatchSync({
            op: 'identity',
          });
          if (result.ok === false) {
            throw Object.assign(new Error(result.error.message), {
              code: result.error.code,
            });
          }
          if (result.value.op !== 'identity') {
            throw Object.assign(
              new Error('EPROTO: identity syscall returned the wrong result'),
              { code: 'EPROTO' }
            );
          }
          return result.value.ppid;
        },
        title: 'node',
        exitCode: undefined as number | undefined,
        cwd: () => request.cwd,
        kill: (
          pid: number,
          signal:
            | 'SIGHUP'
            | 'SIGINT'
            | 'SIGQUIT'
            | 'SIGKILL'
            | 'SIGTERM'
            | 'SIGWINCH' = 'SIGTERM'
        ): true => {
          if (!Number.isSafeInteger(pid)) {
            throw Object.assign(
              new TypeError('The "pid" argument must be a safe integer'),
              { code: 'ERR_INVALID_ARG_TYPE' }
            );
          }
          if (
            signal !== 'SIGHUP' &&
            signal !== 'SIGINT' &&
            signal !== 'SIGQUIT' &&
            signal !== 'SIGTERM' &&
            signal !== 'SIGWINCH' &&
            signal !== 'SIGKILL'
          ) {
            throw Object.assign(
              new TypeError(`Unknown signal: ${String(signal)}`),
              { code: 'ERR_UNKNOWN_SIGNAL' }
            );
          }
          if (!executionState.kernelSyscalls) {
            throw Object.assign(
              new Error('ENOSYS: TraceKernel process controls are unavailable'),
              { code: 'ENOSYS' }
            );
          }
          const result = executionState.kernelSyscalls.dispatchSync({
            op: 'kill',
            pid,
            signal,
          });
          if (result.ok === false) {
            throw Object.assign(new Error(result.error.message), {
              code: result.error.code,
            });
          }
          return true;
        },
        nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
          globalThis.queueMicrotask(() => callback(...args));
        },
        on: (event: string, listener: (...args: unknown[]) => void) => {
          addProcessListener(event, listener);
          return processApi;
        },
        addListener: (event: string, listener: (...args: unknown[]) => void) => {
          addProcessListener(event, listener);
          return processApi;
        },
        once: (event: string, listener: (...args: unknown[]) => void) => {
          const wrapped = (...args: unknown[]) => {
            removeProcessListener(event, wrapped);
            listener(...args);
          };
          addProcessListener(event, wrapped);
          return processApi;
        },
        removeListener: (event: string, listener: (...args: unknown[]) => void) => {
          removeProcessListener(event, listener);
          return processApi;
        },
        off: (event: string, listener: (...args: unknown[]) => void) => {
          removeProcessListener(event, listener);
          return processApi;
        },
        removeAllListeners: (event?: string) => {
          if (event === undefined) processListeners.clear();
          else processListeners.delete(event);
          return processApi;
        },
        listeners: (event: string) => [...(processListeners.get(event) ?? [])],
        listenerCount: (event: string) => processListeners.get(event)?.length ?? 0,
        emit: emitProcessEvent,
        stdin: stdinDevice,
        stdout: createWritableDevice('/dev/stdout', 1),
        stderr: createWritableDevice('/dev/stderr', 2),
        exit: (code = 0) => {
          throw Object.assign(new Error(`process.exit(${code})`), {
            exitCode: Number(code) || 0,
            suppressStderr: true,
          });
        },
      };

  const nodePathSearchEntries = nodePathEntries(request, cwdPath, workspacePathContext);

  const pathApi = createPathApi(() => cwdPath, workspaceRoot);

  const osApi = createOsApi(workspaceRoot, kernelInfo);

  const urlApi = createUrlApi();

  const assertApi = createAssertApi();

  const eventsApi = createEventsApi();

  const utilApi = createUtilApi();

  const streamApi = createStreamApi();

  const childProcessApi = createChildProcessApi(
        executionState,
        eventLoopApi,
        request
      );

  const traceKernelApi = createTraceKernelApi(executionState);

  const cryptoApi = createCryptoApi();

  const timersPromisesApi = createTimersPromisesApi(eventLoopApi);

  const syncTextModule = (path: string, bytes: Uint8Array): void => {
        const text = textFromBytes(bytes);
        if (byteEqual(utf8Bytes(text), bytes)) {
          modules.set(path, text);
        } else {
          modules.delete(path);
        }
      };

  return {
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
    get fsTimestampMs() { return fsTimestampMs; },
    set fsTimestampMs(value) { fsTimestampMs = value; },
    get mainModule() { return mainModule; },
    set mainModule(value) { mainModule = value; },
  };
}

export type BrowserJavaScriptRequestState = ReturnType<typeof createBrowserJavaScriptRequestState>;

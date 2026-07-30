import {
  decodeTraceKernelWatchEvent,
} from "@tracecode/tracekernel";

import {
  runtimeKernelFileCopyErrorMessage,
  runtimeKernelFileCopyErrorCode,
  runtimeKernelFileReadFsErrorMessage,
  runtimeKernelMutationFsErrorMessage,
  runtimeKernelOpenErrorCode,
  runtimeKernelOpenErrorMessage,
  runtimeKernelStatTarget,
  runtimeKernelWriteFsErrorMessage,
} from "@tracecode/runtime-core";

import {
  BrowserBuffer,
  bytesFromFsWriteValue,
  bytesFromNodeValue,
  fileBytes,
  textFromBytes,
  utf8Bytes,
} from "../internal/encoding";

import {
  assertSafeWorkspaceFilePath,
  browserProcFileContents,
  normalizeWorkspaceEntryPath,
  runtimeDirectoryTarget,
  runtimeFileCopyTarget,
  runtimeFileReadTarget,
  runtimeLinkTarget,
  runtimeMkdirTarget,
  runtimeOpenTarget,
  runtimeReadTarget,
  runtimeRemoveTarget,
  runtimeRenameTarget,
  runtimeSymlinkTarget,
  runtimeTruncateTarget,
  runtimeWriteTarget,
  throwRuntimeDirectoryTargetError,
  throwRuntimeLinkTargetError,
  throwRuntimeMkdirTargetError,
  throwRuntimeReadTargetError,
  throwRuntimeRemoveTargetError,
  throwRuntimeRenameTargetError,
  throwRuntimeSymlinkTargetError,
  throwRuntimeTruncateTargetError,
  throwRuntimeWriteTargetError,
  workspacePathInputToString,
  workspaceRelativeFromAbsolutePath,
} from "./workspace-paths";

import {
  relativeWorkspacePath,
  workspaceFilename,
} from "../modules/resolution";
import {
  dirname,
} from "./path-normalization";

import {
  dispatchBrowserNetworkSyscall,
} from "../node-compat/network";

import {
  type BrowserFileStat,
  type BrowserFileSystemStat,
  type BrowserFileWatcher,
  type BrowserFsWatcher,
  type BrowserStatOptions,
} from "./filesystem-state";

import type { BrowserJavaScriptRequestState } from '../browser/request-state';

import type { BrowserFileSystemState } from './filesystem-state';

import type { BrowserJavaScriptProjectExecutionState, JavaScriptProjectCommandRequest } from '../browser/contracts';

export function createBrowserFsApi(

  requestState: BrowserJavaScriptRequestState,

  filesystemState: BrowserFileSystemState,

  request: JavaScriptProjectCommandRequest,

  executionState: BrowserJavaScriptProjectExecutionState

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

  const fsApi = {
        constants: fsConstants,
        F_OK: fsConstants.F_OK,
        R_OK: fsConstants.R_OK,
        W_OK: fsConstants.W_OK,
        X_OK: fsConstants.X_OK,
        O_RDONLY: fsConstants.O_RDONLY,
        O_WRONLY: fsConstants.O_WRONLY,
        O_RDWR: fsConstants.O_RDWR,
        O_CREAT: fsConstants.O_CREAT,
        O_EXCL: fsConstants.O_EXCL,
        O_TRUNC: fsConstants.O_TRUNC,
        O_APPEND: fsConstants.O_APPEND,
        S_IFMT: fsConstants.S_IFMT,
        S_IFREG: fsConstants.S_IFREG,
        S_IFDIR: fsConstants.S_IFDIR,
        S_IFLNK: fsConstants.S_IFLNK,
        COPYFILE_EXCL: fsConstants.COPYFILE_EXCL,
        COPYFILE_FICLONE: fsConstants.COPYFILE_FICLONE,
        COPYFILE_FICLONE_FORCE: fsConstants.COPYFILE_FICLONE_FORCE,
        accessSync: (path: unknown, mode = fsConstants.F_OK) => {
          assertFileSystemAccess(path, mode);
        },
        access: (path: unknown, mode?: number | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
          const done = typeof mode === 'function' ? mode : callback;
          try {
            assertFileSystemAccess(path, typeof mode === 'number' ? mode : fsConstants.F_OK);
            queueMicrotask(() => done?.(null));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        chmodSync: (path: unknown, mode: unknown) => {
          const normalized = metadataPathForEntry(path);
          if (normalized !== null) {
            const stats = statForNormalizedPath(normalized);
            const typeMode = stats?.isDirectory() ? 0o40000 : 0o100000;
            updateEntryMetadata(normalized, { mode: typeMode | (Number(mode) & 0o7777) });
            notifyMetadataMutation(normalized);
          }
          return undefined;
        },
        chmod: (path: unknown, mode: unknown, callback?: (error?: Error | null) => void) => {
          try {
            fsApi.chmodSync(path, mode);
            queueMicrotask(() => callback?.(null));
          } catch (error) {
            queueMicrotask(() => callback?.(error as Error));
          }
        },
        chownSync: (path: unknown, uid: unknown, gid: unknown) => {
          const normalized = metadataPathForEntry(path);
          if (normalized !== null) {
            if (Number(uid) !== 1000 || Number(gid) !== 1000) {
              throw Object.assign(new Error(`EPERM: operation not permitted, chown '${path}'`), { code: 'EPERM' });
            }
          }
          return undefined;
        },
        chown: (path: unknown, uid: unknown, gid: unknown, callback?: (error?: Error | null) => void) => {
          try {
            fsApi.chownSync(path, uid, gid);
            queueMicrotask(() => callback?.(null));
          } catch (error) {
            queueMicrotask(() => callback?.(error as Error));
          }
        },
        utimesSync: (path: unknown, atime: unknown, mtime: unknown) => {
          const normalized = metadataPathForEntry(path);
          if (normalized !== null) {
            updateEntryMetadata(normalized, { atimeMs: timeToMs(atime), mtimeMs: timeToMs(mtime) });
            notifyMetadataMutation(normalized);
          }
          return undefined;
        },
        utimes: (path: unknown, atime: unknown, mtime: unknown, callback?: (error?: Error | null) => void) => {
          try {
            fsApi.utimesSync(path, atime, mtime);
            queueMicrotask(() => callback?.(null));
          } catch (error) {
            queueMicrotask(() => callback?.(error as Error));
          }
        },
        watch: (
          path: unknown,
          optionsOrListener?: { recursive?: boolean } | string | ((eventType: string, filename: string) => void),
          listener?: (eventType: string, filename: string) => void
        ) => {
          assertFileSystemAccess(path);
          const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
          const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
          const on = (event: string, callback: (...args: unknown[]) => void): void => {
            const next = listeners.get(event) ?? [];
            next.push(callback);
            listeners.set(event, next);
          };
          const watcher: BrowserFsWatcher = {
            path: normalized,
            recursive: typeof optionsOrListener === 'object' && optionsOrListener?.recursive === true,
            closed: false,
            listeners,
          };
          if (executionState.kernelSyscalls && executionState.kernelNetwork) {
            const watched = executionState.kernelSyscalls.dispatchSync({
              op: 'watch',
              path: normalized,
              options: {
                recursive: watcher.recursive,
              },
            });
            if (watched.ok === false || watched.value.op !== 'watch') {
              const failure = watched.ok === true
                ? { code: 'EPROTO', message: 'EPROTO: invalid watch syscall response' }
                : watched.error;
              throw Object.assign(new Error(failure.message), {
                code: failure.code,
              });
            }
            watcher.kernelFd = watched.value.fd;
            void eventLoopApi.track((async () => {
              try {
                while (!watcher.closed) {
                  const read = await dispatchBrowserNetworkSyscall(
                    executionState.kernelNetwork,
                    {
                      op: 'read',
                      fd: watcher.kernelFd!,
                      maxBytes: 16 * 1024 + 9,
                    }
                  );
                  if (read.bytes.byteLength === 0) break;
                  const event = decodeTraceKernelWatchEvent(read.bytes);
                  if (event.eventType === 'overflow') {
                    const error = Object.assign(
                      new Error('ENOSPC: TraceKernel filesystem watch queue overflow'),
                      { code: 'ENOSPC' }
                    );
                    for (const errorListener of listeners.get('error') ?? []) {
                      errorListener(error);
                    }
                    continue;
                  }
                  const changedPath = workspaceRelativeFromAbsolutePath(
                    event.path,
                    workspacePathContext
                  ) ?? event.path;
                  const filename = watchedFilename(watcher, changedPath);
                  if (filename !== null) {
                    emitFsWatch(watcher, event.eventType, filename);
                    notifyWatchFileWatchers(changedPath);
                  }
                }
              } catch (error) {
                if (!watcher.closed) {
                  const errorListeners = listeners.get('error') ?? [];
                  if (errorListeners.length === 0) throw error;
                  for (const errorListener of errorListeners) errorListener(error);
                }
              }
            })());
          }
          const initialListener = typeof optionsOrListener === 'function' ? optionsOrListener : listener;
          if (initialListener) on('change', initialListener as (...args: unknown[]) => void);
          fsWatchers.add(watcher);
          const api = {
            on: (event: string, callback: (...args: unknown[]) => void) => {
              on(event, callback);
              return api;
            },
            once: (event: string, callback: (...args: unknown[]) => void) => {
              const wrapped = (...args: unknown[]) => {
                const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped);
                listeners.set(event, next);
                callback(...args);
              };
              on(event, wrapped);
              return api;
            },
            close: () => {
              if (watcher.closed) return;
              watcher.closed = true;
              fsWatchers.delete(watcher);
              if (watcher.kernelFd !== undefined && executionState.kernelSyscalls) {
                executionState.kernelSyscalls.dispatchSync({
                  op: 'close',
                  fd: watcher.kernelFd,
                });
              }
              for (const closeListener of listeners.get('close') ?? []) closeListener();
            },
          };
          return api;
        },
        watchFile: (
          path: unknown,
          optionsOrListener?: { interval?: number; persistent?: boolean } | ((curr: BrowserFileStat, prev: BrowserFileStat) => void),
          listener?: (curr: BrowserFileStat, prev: BrowserFileStat) => void
        ) => {
          const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
          const changeListener = typeof optionsOrListener === 'function' ? optionsOrListener : listener;
          if (!changeListener) {
            throw new TypeError('The "listener" argument must be of type function');
          }
          const watcher: BrowserFileWatcher = {
            path: normalized,
            listener: changeListener,
            previous: statForNormalizedPath(normalized) ?? missingFileStat(),
          };
          fsFileWatchers.add(watcher);
          const api = {
            ref: () => api,
            unref: () => api,
            close: () => {
              fsFileWatchers.delete(watcher);
            },
            on: (_event: string, nextListener: (curr: BrowserFileStat, prev: BrowserFileStat) => void) => {
              if (typeof nextListener === 'function') watcher.listener = nextListener;
              return api;
            },
            addListener: (_event: string, nextListener: (curr: BrowserFileStat, prev: BrowserFileStat) => void) => {
              if (typeof nextListener === 'function') watcher.listener = nextListener;
              return api;
            },
            removeListener: () => api,
          };
          return api;
        },
        unwatchFile: (
          path: unknown,
          listener?: (curr: BrowserFileStat, prev: BrowserFileStat) => void
        ) => {
          const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
          for (const watcher of Array.from(fsFileWatchers)) {
            if (watcher.path === normalized && (!listener || watcher.listener === listener)) {
              fsFileWatchers.delete(watcher);
            }
          }
        },
        openSync: (path: unknown, flags: unknown = 'r') => {
          const parsed = parseOpenFlags(flags);
          const openTarget = runtimeOpenTarget(path, parsed, kernelDevices, procSnapshot);
          const fd = filesystemState.nextFd++;
          if (openTarget?.kind === 'error') {
            throw Object.assign(new Error(runtimeKernelOpenErrorMessage(String(path), openTarget)), {
              code: runtimeKernelOpenErrorCode(openTarget.reason),
            });
          }
          if (openTarget?.kind === 'device') {
            fileDescriptors.set(fd, {
              kind: 'device',
              device: openTarget.device,
              offset: 0,
              readable: openTarget.readable,
              writable: openTarget.writable,
              append: true,
            });
            return fd;
          }
          if (openTarget?.kind === 'proc-file') {
            fileDescriptors.set(fd, {
              kind: 'proc',
              path: openTarget.path,
              offset: 0,
              readable: openTarget.readable,
              writable: openTarget.writable,
              append: false,
            });
            return fd;
          }
          const rawNormalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
          const normalized = resolveStoredSymlinkPath(rawNormalized);
          if (executionState.kernelFileSystem) {
            const kernelFd = executionState.kernelFileSystem.open(normalized, {
              access: parsed.readable && parsed.writable
                ? 'read-write'
                : parsed.writable
                  ? 'write'
                  : 'read',
              ...(parsed.create ? { create: true } : {}),
              ...(parsed.exclusive ? { exclusive: true } : {}),
              ...(parsed.truncate ? { truncate: true } : {}),
              ...(parsed.append ? { append: true } : {}),
            });
            executionState.kernelFileSystem.setCloseOnExec(kernelFd, true);
            fileDescriptors.set(fd, {
              kind: 'kernel',
              kernelFd,
              path: normalized,
              offset: 0,
              readable: parsed.readable,
              writable: parsed.writable,
              append: parsed.append,
            });
            return fd;
          }
          if (parsed.exclusive && (
            fileStore.has(rawNormalized) || symlinkStore.has(rawNormalized) || directoryStore.has(rawNormalized)
          )) {
            throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: 'EEXIST' });
          }
          const directoryPrefix = normalized ? `${normalized}/` : '';
          const isDirectory = directoryStore.has(normalized) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(directoryPrefix));
          if (isDirectory) {
            if (parsed.writable || parsed.create || parsed.truncate) {
              throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: 'EISDIR' });
            }
            fileDescriptors.set(fd, {
              kind: 'directory',
              path: normalized,
              offset: 0,
              readable: true,
              writable: false,
              append: false,
            });
            return fd;
          }
          if (!fileStore.has(normalized)) {
            if (!parsed.create) {
              throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
            }
            assertWorkspaceFileWritePath(normalized, path, 'write', 'open');
            setFileBytes(normalized, new Uint8Array());
          } else if (parsed.truncate) {
            assertWorkspaceFileWritePath(normalized, path, 'truncate', 'open');
            setFileBytes(normalized, new Uint8Array());
          }
          fileDescriptors.set(fd, {
            kind: 'file',
            path: normalized,
            bytes: new Uint8Array(fileStore.get(normalized) ?? new Uint8Array()),
            offset: parsed.append ? fileStore.get(normalized)?.byteLength ?? 0 : 0,
            readable: parsed.readable,
            writable: parsed.writable,
            append: parsed.append,
          });
          return fd;
        },
        open: (path: unknown, flags?: unknown, modeOrCallback?: unknown, callback?: (error: Error | null, fd?: number) => void) => {
          const done = typeof flags === 'function'
            ? flags as (error: Error | null, fd?: number) => void
            : typeof modeOrCallback === 'function'
              ? modeOrCallback as (error: Error | null, fd?: number) => void
              : callback;
          const openFlags = typeof flags === 'function' || flags === undefined ? 'r' : flags;
          try {
            const fd = fsApi.openSync(path, openFlags);
            queueMicrotask(() => done?.(null, fd));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        closeSync: (fd: number) => {
          if (Number(fd) < 3) return undefined;
          const entry = fileDescriptors.get(Number(fd));
          if (!entry) {
            throw Object.assign(new Error(`EBADF: bad file descriptor, close`), { code: 'EBADF' });
          }
          if (entry.kind === 'kernel') {
            executionState.kernelFileSystem!.closeDescriptor(entry.kernelFd!);
          }
          fileDescriptors.delete(Number(fd));
          return undefined;
        },
        close: (fd: number, callback?: (error?: Error | null) => void) => {
          try {
            fsApi.closeSync(fd);
            queueMicrotask(() => callback?.(null));
          } catch (error) {
            queueMicrotask(() => callback?.(error as Error));
          }
        },
        readSync: (fd: number, buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset, position?: number | null) => {
          const entry = fileDescriptor(fd);
          if (!entry.readable) throw Object.assign(new Error('EBADF: bad file descriptor, read'), { code: 'EBADF' });
          if (entry.kind === 'kernel') {
            const count = Math.max(0, Math.min(length, buffer.byteLength - offset));
            const bytes = executionState.kernelFileSystem!.read(
              entry.kernelFd!,
              count,
              typeof position === 'number' ? Math.max(0, position) : undefined
            );
            buffer.set(bytes, offset);
            return bytes.byteLength;
          }
          if (entry.kind === 'device') {
            const bytes = readDeviceBytes(entry.device ?? '/dev/stdin', Math.max(0, Math.min(length, buffer.byteLength - offset)));
            buffer.set(bytes, offset);
            return bytes.byteLength;
          }
          const source = descriptorBytes(entry);
          const start = typeof position === 'number' ? Math.max(0, position) : entry.offset;
          const count = Math.max(0, Math.min(length, source.byteLength - start, buffer.byteLength - offset));
          buffer.set(source.slice(start, start + count), offset);
          if (position === undefined || position === null) entry.offset = start + count;
          return count;
        },
        read: (
          fd: number,
          buffer: Uint8Array,
          offsetOrOptions?: number | { offset?: number; length?: number; position?: number | null } | ((error: Error | null, bytesRead?: number, buffer?: Uint8Array) => void),
          lengthOrCallback?: number | ((error: Error | null, bytesRead?: number, buffer?: Uint8Array) => void),
          positionOrCallback?: number | null | ((error: Error | null, bytesRead?: number, buffer?: Uint8Array) => void),
          callback?: (error: Error | null, bytesRead?: number, buffer?: Uint8Array) => void
        ) => {
          const options = typeof offsetOrOptions === 'object' && offsetOrOptions !== null ? offsetOrOptions : undefined;
          const done = typeof offsetOrOptions === 'function'
            ? offsetOrOptions
            : typeof lengthOrCallback === 'function'
              ? lengthOrCallback
              : typeof positionOrCallback === 'function'
                ? positionOrCallback
                : callback;
          const offset: number = options?.offset ?? (typeof offsetOrOptions === 'number' ? offsetOrOptions : 0);
          const length: number = options?.length ?? (typeof lengthOrCallback === 'number' ? lengthOrCallback : buffer.byteLength - offset);
          let position: number | null | undefined;
          if (options !== undefined) {
            position = options.position;
          } else if (typeof positionOrCallback === 'number') {
            position = positionOrCallback;
          } else {
            position = null;
          }
          try {
            const bytesRead = fsApi.readSync(fd, buffer, offset, length, position);
            queueMicrotask(() => done?.(null, bytesRead, buffer));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error, undefined, buffer));
          }
        },
        readvSync: (fd: number, buffers: Uint8Array[], position?: number | null) => {
          let bytesRead = 0;
          let nextPosition = typeof position === 'number' ? Math.max(0, position) : position;
          for (const buffer of buffers) {
            if (buffer.byteLength === 0) continue;
            const count = fsApi.readSync(fd, buffer, 0, buffer.byteLength, nextPosition);
            bytesRead += count;
            if (typeof nextPosition === 'number') nextPosition += count;
            if (count === 0) break;
          }
          return bytesRead;
        },
        readv: (
          fd: number,
          buffers: Uint8Array[],
          positionOrCallback?: number | null | ((error: Error | null, bytesRead?: number, buffers?: Uint8Array[]) => void),
          callback?: (error: Error | null, bytesRead?: number, buffers?: Uint8Array[]) => void
        ) => {
          const done = typeof positionOrCallback === 'function' ? positionOrCallback : callback;
          const position = typeof positionOrCallback === 'function' ? undefined : positionOrCallback;
          try {
            const bytesRead = fsApi.readvSync(fd, buffers, position);
            queueMicrotask(() => done?.(null, bytesRead, buffers));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error, undefined, buffers));
          }
        },
        writeSync: (fd: number, value: unknown, offsetOrPosition?: number, lengthOrEncoding?: number | string, position?: number | null) => {
          let bytes: Uint8Array;
          let writePosition: number | null | undefined = position;
          if (typeof value === 'string') {
            bytes = BrowserBuffer.from(value, typeof lengthOrEncoding === 'string' ? lengthOrEncoding : undefined);
            writePosition = typeof offsetOrPosition === 'number' ? offsetOrPosition : undefined;
          } else {
            const source = bytesFromNodeValue(value);
            const offset = typeof offsetOrPosition === 'number' ? offsetOrPosition : 0;
            const length = typeof lengthOrEncoding === 'number' ? lengthOrEncoding : source.byteLength - offset;
            bytes = source.slice(offset, offset + length);
          }
          writeDescriptorBytes(fileDescriptor(fd), bytes, writePosition);
          return bytes.byteLength;
        },
        write: (
          fd: number,
          value: unknown,
          offsetOrPosition?: number | { offset?: number; length?: number; position?: number | null; encoding?: string } | ((error: Error | null, written?: number, value?: unknown) => void),
          lengthOrEncoding?: number | string | ((error: Error | null, written?: number, value?: unknown) => void),
          positionOrCallback?: number | null | ((error: Error | null, written?: number, value?: unknown) => void),
          callback?: (error: Error | null, written?: number, value?: unknown) => void
        ) => {
          const options = typeof offsetOrPosition === 'object' && offsetOrPosition !== null ? offsetOrPosition : undefined;
          const done = typeof offsetOrPosition === 'function'
            ? offsetOrPosition
            : typeof lengthOrEncoding === 'function'
              ? lengthOrEncoding
              : typeof positionOrCallback === 'function'
                ? positionOrCallback
                : callback;
          let writePosition: number | null | undefined;
          if (options !== undefined) {
            writePosition = options.position;
          } else if (typeof positionOrCallback === 'number') {
            writePosition = positionOrCallback;
          } else if (positionOrCallback === null) {
            writePosition = null;
          }
          try {
            const written = fsApi.writeSync(
              fd,
              value,
              options?.offset ?? (typeof offsetOrPosition === 'number' ? offsetOrPosition : undefined),
              options?.length ?? options?.encoding ?? (typeof lengthOrEncoding === 'number' || typeof lengthOrEncoding === 'string' ? lengthOrEncoding : undefined),
              writePosition
            );
            queueMicrotask(() => done?.(null, written, value));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error, undefined, value));
          }
        },
        writevSync: (fd: number, buffers: Uint8Array[], position?: number | null) => {
          let bytesWritten = 0;
          let nextPosition = typeof position === 'number' ? Math.max(0, position) : position;
          for (const buffer of buffers) {
            const written = fsApi.writeSync(fd, buffer, 0, buffer.byteLength, nextPosition);
            bytesWritten += written;
            if (typeof nextPosition === 'number') nextPosition += written;
          }
          return bytesWritten;
        },
        writev: (
          fd: number,
          buffers: Uint8Array[],
          positionOrCallback?: number | null | ((error: Error | null, bytesWritten?: number, buffers?: Uint8Array[]) => void),
          callback?: (error: Error | null, bytesWritten?: number, buffers?: Uint8Array[]) => void
        ) => {
          const done = typeof positionOrCallback === 'function' ? positionOrCallback : callback;
          const position = typeof positionOrCallback === 'function' ? undefined : positionOrCallback;
          try {
            const bytesWritten = fsApi.writevSync(fd, buffers, position);
            queueMicrotask(() => done?.(null, bytesWritten, buffers));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error, undefined, buffers));
          }
        },
        fstatSync: (fd: number, options?: BrowserStatOptions) => {
          const entry = fileDescriptor(fd);
          let stats: BrowserFileStat;
          if (entry.kind === 'kernel') {
            stats = statForTraceKernelPath(
              executionState.kernelFileSystem!.fstat(entry.kernelFd!)
            );
          } else if (entry.kind === 'device') {
            const statTarget = runtimeKernelStatTarget(entry.device ?? '/dev/stdin', kernelInfo, kernelDevices);
            stats = statTarget.kind === 'stat' ? statForKernelPath(statTarget.path, statTarget.stat) : missingFileStat();
          } else if (entry.kind === 'proc') {
            stats = statForKernelTarget(entry.path ?? '') ?? missingFileStat();
          } else if (entry.kind === 'directory') {
            stats = statForNormalizedPath(entry.path ?? '') ?? missingFileStat();
          } else {
            stats = entry.path && fileStore.has(entry.path)
              ? statForNormalizedPath(entry.path) ?? missingFileStat()
              : {
                  ...missingFileStat(),
                  size: descriptorBytes(entry).byteLength,
                  isFile: () => true,
                  isDirectory: () => false,
                };
          }
          return browserStatsResult(stats, options);
        },
        fstat: (
          fd: number,
          optionsOrCallback?: BrowserStatOptions | ((error: Error | null, stats?: { size: number | bigint; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }) => void),
          callback?: (error: Error | null, stats?: { size: number | bigint; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }) => void
        ) => {
          const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
          const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
          try {
            const stats = fsApi.fstatSync(fd, options);
            queueMicrotask(() => done?.(null, stats));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        fchmodSync: (fd: number, mode: unknown) => {
          const path = descriptorMetadataPath(fd, 'fchmod');
          if (path !== null) {
            const stats = statForNormalizedPath(path);
            const typeMode = stats?.isDirectory() ? 0o40000 : 0o100000;
            updateEntryMetadata(path, { mode: typeMode | (Number(mode) & 0o7777) });
            notifyMetadataMutation(path);
          }
          return undefined;
        },
        fchmod: (fd: number, mode: unknown, callback?: (error?: Error | null) => void) => {
          try {
            fsApi.fchmodSync(fd, mode);
            queueMicrotask(() => callback?.(null));
          } catch (error) {
            queueMicrotask(() => callback?.(error as Error));
          }
        },
        fchownSync: (fd: number, uid: unknown, gid: unknown) => {
          const path = descriptorMetadataPath(fd, 'fchown');
          if (path !== null) {
            if (Number(uid) !== 1000 || Number(gid) !== 1000) {
              throw Object.assign(new Error('EPERM: operation not permitted, fchown'), { code: 'EPERM' });
            }
          }
          return undefined;
        },
        fchown: (fd: number, uid: unknown, gid: unknown, callback?: (error?: Error | null) => void) => {
          try {
            fsApi.fchownSync(fd, uid, gid);
            queueMicrotask(() => callback?.(null));
          } catch (error) {
            queueMicrotask(() => callback?.(error as Error));
          }
        },
        futimesSync: (fd: number, atime: unknown, mtime: unknown) => {
          const path = descriptorMetadataPath(fd, 'futimes');
          if (path !== null) {
            updateEntryMetadata(path, { atimeMs: timeToMs(atime), mtimeMs: timeToMs(mtime) });
            notifyMetadataMutation(path);
          }
          return undefined;
        },
        futimes: (fd: number, atime: unknown, mtime: unknown, callback?: (error?: Error | null) => void) => {
          try {
            fsApi.futimesSync(fd, atime, mtime);
            queueMicrotask(() => callback?.(null));
          } catch (error) {
            queueMicrotask(() => callback?.(error as Error));
          }
        },
        ftruncateSync: (fd: number, length = 0) => {
          const entry = fileDescriptor(fd);
          if (!entry.writable) throw Object.assign(new Error('EBADF: bad file descriptor, ftruncate'), { code: 'EBADF' });
          truncateDescriptorBytes(entry, length);
          return undefined;
        },
        ftruncate: (fd: number, lengthOrCallback?: number | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
          const done = typeof lengthOrCallback === 'function' ? lengthOrCallback : callback;
          try {
            fsApi.ftruncateSync(fd, typeof lengthOrCallback === 'number' ? lengthOrCallback : 0);
            queueMicrotask(() => done?.(null));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        fsyncSync: (fd: number) => {
          fileDescriptor(fd);
          return undefined;
        },
        fsync: (fd: number, callback?: (error?: Error | null) => void) => {
          try {
            fsApi.fsyncSync(fd);
            queueMicrotask(() => callback?.(null));
          } catch (error) {
            queueMicrotask(() => callback?.(error as Error));
          }
        },
        fdatasyncSync: (fd: number) => {
          fileDescriptor(fd);
          return undefined;
        },
        fdatasync: (fd: number, callback?: (error?: Error | null) => void) => {
          try {
            fsApi.fdatasyncSync(fd);
            queueMicrotask(() => callback?.(null));
          } catch (error) {
            queueMicrotask(() => callback?.(error as Error));
          }
        },
        createReadStream: (path: unknown, options?: string | { autoClose?: boolean; encoding?: string; end?: number; fd?: number; flags?: string; start?: number } | null): ReturnType<typeof createReadableStream> => {
          const optionFd = typeof options === 'object' && typeof options?.fd === 'number' ? options.fd : null;
          const readTarget = optionFd === null ? runtimeFileReadTarget(path, kernelDevices, procSnapshot) : null;
          const requestedEncoding = typeof options === 'string' ? options : options?.encoding;
          if (
            executionState.kernelFileSystem &&
            optionFd === null &&
            (readTarget === null || readTarget?.kind === 'workspace')
          ) {
            const flags = typeof options === 'object' && options?.flags ? options.flags : 'r';
            const autoClose = typeof options === 'object' && options?.autoClose === false ? false : true;
            const openedFd = fsApi.openSync(path, flags);
            return fsApi.createReadStream(null, {
              ...(typeof options === 'object' && options ? options : {}),
              fd: openedFd,
              flags,
              autoClose,
            });
          }
          let sourceBytes: Uint8Array | undefined;
          if (readTarget?.kind === 'device-file') sourceBytes = utf8Bytes(readDevice(readTarget.path));
          else if (readTarget?.kind === 'proc-file') sourceBytes = utf8Bytes(browserProcFileContents(procSnapshot, readTarget.path, kernelInfo));
          else if (readTarget?.kind === 'error') {
            throwRuntimeReadTargetError(readTarget, runtimeKernelFileReadFsErrorMessage(String(path), readTarget));
          } else if (optionFd !== null) {
            const entry = fileDescriptor(optionFd);
            if (!entry.readable) throw Object.assign(new Error('EBADF: bad file descriptor, read'), { code: 'EBADF' });
            if (typeof options === 'object' && typeof options?.start === 'number') {
              sourceBytes = descriptorBytes(entry);
            } else {
              sourceBytes = readDescriptorFileBytes(optionFd);
            }
          } else {
            const normalized = resolveWorkspaceEntryPath(path);
            if (workspaceFileAncestor(normalized) !== null) {
              throw Object.assign(new Error(`ENOTDIR: not a directory, open '${path}'`), { code: 'ENOTDIR' });
            }
            if (isWorkspaceDirectoryPath(normalized)) {
              throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: 'EISDIR' });
            }
            sourceBytes = fileStore.get(normalized);
          }
          if (!sourceBytes) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
          }
          const requestedStart = typeof options === 'object' ? assertStreamRangeInteger('start', options?.start) : undefined;
          const requestedEnd = typeof options === 'object' ? assertStreamRangeInteger('end', options?.end) : undefined;
          if (requestedStart !== undefined && requestedEnd !== undefined && requestedEnd < requestedStart) {
            throw Object.assign(new RangeError('The value of "start" is out of range.'), { code: 'ERR_OUT_OF_RANGE' });
          }
          const start = requestedStart ?? 0;
          const endInclusive = requestedEnd ?? sourceBytes.byteLength - 1;
          const autoClose = typeof options === 'object' && options?.autoClose === false ? false : true;
          return createReadableStream(
            sourceBytes.slice(start, Math.max(start, endInclusive + 1)),
            requestedEncoding,
            autoClose && optionFd !== null ? () => fsApi.closeSync(optionFd) : undefined
          );
        },
        createWriteStream: createWritableStream,
        readFileSync: (path: unknown, encoding?: string | { encoding?: string }) => {
          const requestedEncoding = typeof encoding === 'string' ? encoding : encoding?.encoding;
          if (typeof path === 'number') {
            const bytes = BrowserBuffer.from(readDescriptorFileBytes(path));
            return typeof requestedEncoding === 'string' ? bytes.toString(requestedEncoding) : bytes;
          }
          const readTarget = runtimeFileReadTarget(path, kernelDevices, procSnapshot);
          if (readTarget?.kind === 'device-file') {
            const contents = readDevice(readTarget.path);
            if (typeof requestedEncoding === 'string') return BrowserBuffer.from(contents).toString(requestedEncoding);
            return BrowserBuffer.from(contents);
          }
          if (readTarget?.kind === 'proc-file') {
            const contents = browserProcFileContents(procSnapshot, readTarget.path, kernelInfo);
            if (typeof requestedEncoding === 'string') return BrowserBuffer.from(contents).toString(requestedEncoding);
            return BrowserBuffer.from(contents);
          }
          if (readTarget?.kind === 'error') {
            throwRuntimeReadTargetError(readTarget, runtimeKernelFileReadFsErrorMessage(String(path), readTarget));
          }
          const normalized = resolveWorkspaceEntryPath(path);
          if (executionState.kernelFileSystem) {
            const fileBytes = executionState.kernelFileSystem.readFile(normalized);
            return typeof requestedEncoding === 'string'
              ? BrowserBuffer.from(fileBytes).toString(requestedEncoding)
              : BrowserBuffer.from(fileBytes);
          }
          if (workspaceFileAncestor(normalized) !== null) {
            throw Object.assign(new Error(`ENOTDIR: not a directory, open '${path}'`), { code: 'ENOTDIR' });
          }
          if (isWorkspaceDirectoryPath(normalized)) {
            throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: 'EISDIR' });
          }
          const bytes = fileStore.get(normalized);
          if (!bytes) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
          }
          if (typeof requestedEncoding === 'string') {
            return BrowserBuffer.from(bytes).toString(requestedEncoding);
          }
          return BrowserBuffer.from(bytes);
        },
        readFile: (path: unknown, encodingOrCallback?: string | { encoding?: string } | ((error: Error | null, data?: unknown) => void), callback?: (error: Error | null, data?: unknown) => void) => {
          const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
          try {
            const data = fsApi.readFileSync(path, typeof encodingOrCallback === 'function' ? undefined : encodingOrCallback);
            queueMicrotask(() => done?.(null, data));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        writeFileSync: (
          path: unknown,
          value: unknown,
          options?: string | {
            encoding?: string | null;
            flag?: string | number;
            mode?: string | number;
          } | null
        ) => {
          if (typeof path === 'number') {
            writeDescriptorFileBytes(path, bytesFromFsWriteValue(value, options));
            return;
          }
          const writeTarget = runtimeWriteTarget(path, kernelDevices);
          if (writeTarget?.kind === 'error') {
            throwRuntimeWriteTargetError(writeTarget, runtimeKernelWriteFsErrorMessage(String(path), writeTarget));
          }
          if (writeTarget?.kind === 'device') {
            writeDevice(writeTarget.device, textFromBytes(bytesFromFsWriteValue(value, options)));
            return;
          }
          const normalized = resolveWorkspaceEntryPath(path);
          const structuredOptions = typeof options === 'object' && options !== null
            ? options
            : undefined;
          const usesDefaultReplaceSemantics = (
            (structuredOptions?.flag === undefined || structuredOptions.flag === 'w') &&
            structuredOptions?.mode === undefined
          );
          if (executionState.kernelFileSystem && usesDefaultReplaceSemantics) {
            executionState.kernelFileSystem.writeFile(
              normalized,
              bytesFromFsWriteValue(value, options)
            );
            return;
          }
          assertWorkspaceFileWritePath(normalized, path, 'write', 'open');
          setFileBytes(normalized, bytesFromFsWriteValue(value, options));
        },
        writeFile: (path: unknown, value: unknown, optionsOrCallback?: string | { encoding?: string | null } | null | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
          const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
          try {
            fsApi.writeFileSync(path, value, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
            queueMicrotask(() => done?.(null));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        appendFileSync: (path: unknown, value: unknown, options?: string | { encoding?: string | null } | null) => {
          if (typeof path === 'number') {
            writeDescriptorFileBytes(path, bytesFromFsWriteValue(value, options), fileDescriptor(path).append);
            return;
          }
          const writeTarget = runtimeWriteTarget(path, kernelDevices);
          if (writeTarget?.kind === 'error') {
            throwRuntimeWriteTargetError(writeTarget, runtimeKernelWriteFsErrorMessage(String(path), writeTarget));
          }
          if (writeTarget?.kind === 'device') {
            writeDevice(writeTarget.device, textFromBytes(bytesFromFsWriteValue(value, options)));
            return;
          }
          const normalized = resolveWorkspaceEntryPath(path);
          assertWorkspaceFileWritePath(normalized, path, 'append', 'open');
          const previous = fileStore.get(normalized) ?? new Uint8Array();
          const next = bytesFromFsWriteValue(value, options);
          const combined = new Uint8Array(previous.byteLength + next.byteLength);
          combined.set(previous, 0);
          combined.set(next, previous.byteLength);
          setFileBytes(normalized, combined);
        },
        appendFile: (path: unknown, value: unknown, optionsOrCallback?: string | { encoding?: string | null } | null | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
          const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
          try {
            fsApi.appendFileSync(path, value, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
            queueMicrotask(() => done?.(null));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        copyFileSync: (source: unknown, destination: unknown, mode = 0) => {
          const copyTarget = runtimeFileCopyTarget(source, destination, kernelDevices, procSnapshot);
          if (copyTarget?.kind === 'error' && copyTarget.side === 'destination') {
            throw Object.assign(new Error(runtimeKernelFileCopyErrorMessage(String(source), String(destination), copyTarget)), {
              code: runtimeKernelFileCopyErrorCode(copyTarget),
            });
          }
          let sourceBytes: Uint8Array | undefined;
          const sourceTarget = copyTarget?.kind === 'virtual-source' || copyTarget?.kind === 'device-destination'
            ? copyTarget.source
            : runtimeFileReadTarget(source, kernelDevices, procSnapshot);
          if (sourceTarget?.kind === 'device-file') sourceBytes = utf8Bytes(readDevice(sourceTarget.path));
          else if (sourceTarget?.kind === 'proc-file') sourceBytes = utf8Bytes(browserProcFileContents(procSnapshot, sourceTarget.path, kernelInfo));
          else if (copyTarget?.kind === 'error' && copyTarget.side === 'source') {
            throw Object.assign(new Error(runtimeKernelFileCopyErrorMessage(String(source), String(destination), copyTarget)), {
              code: runtimeKernelFileCopyErrorCode(copyTarget),
            });
          } else if (sourceTarget?.kind === 'error') {
            throwRuntimeReadTargetError(sourceTarget, sourceTarget.reason === 'is-directory'
              ? `EISDIR: illegal operation on a directory, copyfile '${source}' -> '${destination}'`
              : sourceTarget.reason === 'permission-denied'
                ? `EBADF: bad file descriptor, copyfile '${source}' -> '${destination}'`
                : `ENOENT: no such file or directory, copyfile '${source}' -> '${destination}'`);
          } else sourceBytes = fileStore.get(resolveWorkspaceEntryPath(source));
          if (!sourceBytes) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, copyfile '${source}' -> '${destination}'`), { code: 'ENOENT' });
          }
          if (copyTarget?.kind === 'device-destination') {
            writeDevice(copyTarget.device, textFromBytes(sourceBytes));
            return;
          }
          const normalizedDestination = resolveWorkspaceEntryPath(destination);
          assertWorkspaceFileWritePath(normalizedDestination, destination, 'copy', 'copyfile');
          if ((Number(mode) & fsConstants.COPYFILE_EXCL) !== 0 && fileSystemEntryExists(workspaceFilename(normalizedDestination, workspaceRoot))) {
            throw Object.assign(new Error(`EEXIST: file already exists, copyfile '${source}' -> '${destination}'`), { code: 'EEXIST' });
          }
          setFileBytes(normalizedDestination, new Uint8Array(sourceBytes));
        },
        copyFile: (source: unknown, destination: unknown, modeOrCallback?: number | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
          const done = typeof modeOrCallback === 'function' ? modeOrCallback : callback;
          try {
            fsApi.copyFileSync(source, destination, typeof modeOrCallback === 'number' ? modeOrCallback : 0);
            queueMicrotask(() => done?.(null));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        linkSync: (existingPath: unknown, newPath: unknown) => {
          const linkTarget = runtimeLinkTarget(existingPath, newPath, kernelDevices);
          if (linkTarget?.kind === 'error') {
            throwRuntimeLinkTargetError(
              linkTarget,
              runtimeKernelMutationFsErrorMessage(String(existingPath), linkTarget, 'link', String(newPath))
            );
          }
          const normalizedSource = assertSafeWorkspaceFilePath(existingPath, cwdPath, workspacePathContext);
          const normalizedDestination = assertSafeWorkspaceFilePath(newPath, cwdPath, workspacePathContext);
          if (executionState.kernelFileSystem) {
            executionState.kernelFileSystem.link(normalizedSource, normalizedDestination);
            return;
          }
          const bytes = fileStore.get(normalizedSource);
          if (!bytes) {
            const sourceIsDirectory = directoryStore.has(normalizedSource)
              || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(`${normalizedSource}/`));
            if (sourceIsDirectory) {
              throw Object.assign(new Error(`EPERM: operation not permitted, link '${existingPath}' -> '${newPath}'`), { code: 'EPERM' });
            }
            throw Object.assign(new Error(`ENOENT: no such file or directory, link '${existingPath}' -> '${newPath}'`), { code: 'ENOENT' });
          }
          assertReadonlyFilePath(normalizedSource, 'link');
          if (fileStore.has(normalizedDestination) || directoryStore.has(normalizedDestination)) {
            throw Object.assign(new Error(`EEXIST: file already exists, link '${existingPath}' -> '${newPath}'`), { code: 'EEXIST' });
          }
          assertWorkspaceFileWritePath(normalizedDestination, newPath, 'link');
          fileStore.set(normalizedDestination, bytes);
          touchEntryMetadata(normalizedDestination);
          linkPaths(normalizedSource, normalizedDestination);
          syncTextModule(normalizedDestination, bytes);
          cache.delete(normalizedDestination);
          io.fileChange(runtimeFileForPath(normalizedDestination, bytes), 'live');
          notifyFsWatchers('change', normalizedDestination);
          notifyWatchFileWatchers(normalizedDestination);
        },
        link: (existingPath: unknown, newPath: unknown, callback?: (error?: Error | null) => void) => {
          try {
            fsApi.linkSync(existingPath, newPath);
            queueMicrotask(() => callback?.(null));
          } catch (error) {
            queueMicrotask(() => callback?.(error as Error));
          }
        },
        symlinkSync: (target: unknown, linkPath: unknown) => {
          const symlinkTarget = runtimeSymlinkTarget(linkPath, kernelDevices);
          if (symlinkTarget?.kind === 'error') {
            throwRuntimeSymlinkTargetError(symlinkTarget, runtimeKernelMutationFsErrorMessage(String(linkPath), symlinkTarget, 'symlink'));
          }
          const targetText = workspacePathInputToString(target);
          if (targetText.length === 0) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, symlink '${targetText}' -> '${linkPath}'`), { code: 'ENOENT' });
          }
          const normalizedLink = resolveWorkspaceEntryPath(linkPath, false);
          if (executionState.kernelFileSystem) {
            executionState.kernelFileSystem.symlink(targetText, normalizedLink);
            return;
          }
          assertReadonlyFilePath(normalizedLink, 'symlink');
          assertWorkspaceParentDirectoryPath(normalizedLink, linkPath, 'symlink');
          if (
            fileStore.has(normalizedLink) ||
            symlinkStore.has(normalizedLink) ||
            directoryStore.has(normalizedLink)
          ) {
            throw Object.assign(new Error(`EEXIST: file already exists, symlink '${targetText}' -> '${linkPath}'`), { code: 'EEXIST' });
          }
          symlinkStore.set(normalizedLink, targetText);
          entryMetadata.set(normalizedLink, createEntryMetadata(0o120777));
          io.fileChange({ path: normalizedLink, symlink: true, target: targetText }, 'live');
          notifyFsWatchers('rename', normalizedLink);
          notifyWatchFileWatchers(normalizedLink);
        },
        symlink: (target: unknown, linkPath: unknown, typeOrCallback?: string | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
          const done = typeof typeOrCallback === 'function' ? typeOrCallback : callback;
          try {
            fsApi.symlinkSync(target, linkPath);
            queueMicrotask(() => done?.(null));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        readlinkSync: (path: unknown, options?: string | { encoding?: string | null } | null) => {
          const readTarget = runtimeReadTarget(path, kernelDevices, procSnapshot);
          if (readTarget?.kind && readTarget.kind !== 'workspace') {
            throw Object.assign(new Error(`EINVAL: invalid argument, readlink '${path}'`), { code: 'EINVAL' });
          }
          const normalized = resolveWorkspaceEntryPath(path, false);
          if (executionState.kernelFileSystem) {
            const target = executionState.kernelFileSystem.readlink(normalized);
            const encoding = typeof options === 'string' ? options : options?.encoding;
            return encoding === null || encoding === 'buffer'
              ? BrowserBuffer.from(target)
              : BrowserBuffer.from(target).toString(encoding ?? 'utf8');
          }
          const target = symlinkStore.get(normalized);
          if (target === undefined) {
            const exists = fileStore.has(normalized) || directoryStore.has(normalized);
            const code = exists ? 'EINVAL' : 'ENOENT';
            const reason = exists ? 'invalid argument' : 'no such file or directory';
            throw Object.assign(new Error(`${code}: ${reason}, readlink '${path}'`), { code });
          }
          const encoding = typeof options === 'string' ? options : options?.encoding;
          return encoding === null || encoding === 'buffer'
            ? BrowserBuffer.from(target)
            : BrowserBuffer.from(target).toString(encoding ?? 'utf8');
        },
        readlink: (path: unknown, optionsOrCallback?: string | { encoding?: string | null } | null | ((error: Error | null, linkString?: unknown) => void), callback?: (error: Error | null, linkString?: unknown) => void) => {
          const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
          try {
            const linkString = fsApi.readlinkSync(path, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
            queueMicrotask(() => done?.(null, linkString));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        cpSync: (source: unknown, destination: unknown, options?: { recursive?: boolean; force?: boolean; errorOnExist?: boolean; filter?: (source: string, destination: string) => boolean }) => {
          copyEntrySync(source, destination, options);
          return undefined;
        },
        cp: (source: unknown, destination: unknown, optionsOrCallback?: { recursive?: boolean; force?: boolean; errorOnExist?: boolean; filter?: (source: string, destination: string) => boolean } | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
          const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
          try {
            fsApi.cpSync(source, destination, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
            queueMicrotask(() => done?.(null));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        renameSync: (oldPath: unknown, newPath: unknown) => {
          const renameTarget = runtimeRenameTarget(oldPath, newPath, kernelDevices);
          if (renameTarget?.kind === 'error') {
            throwRuntimeRenameTargetError(
              renameTarget,
              runtimeKernelMutationFsErrorMessage(String(oldPath), renameTarget, 'rename', String(newPath))
            );
          }
          const normalizedOldPath = resolveWorkspaceEntryPath(oldPath, false);
          const normalizedNewPath = resolveWorkspaceEntryPath(newPath, false);
          if (executionState.kernelFileSystem) {
            executionState.kernelFileSystem.rename(
              normalizedOldPath,
              normalizedNewPath
            );
            return;
          }
          if (normalizedOldPath === normalizedNewPath) {
            const prefix = normalizedOldPath ? `${normalizedOldPath}/` : '';
            if (
              fileStore.has(normalizedOldPath) ||
              symlinkStore.has(normalizedOldPath) ||
              directoryStore.has(normalizedOldPath) ||
              Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix)) ||
              Array.from(directoryStore).some((directoryPath) => directoryPath.startsWith(prefix))
            ) {
              return;
            }
            throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`), { code: 'ENOENT' });
          }
          const linkTarget = symlinkStore.get(normalizedOldPath);
          if (linkTarget !== undefined) {
            assertReadonlyFilePath(normalizedOldPath, 'move');
            assertReadonlyFilePath(normalizedNewPath, 'move');
            assertWorkspaceParentDirectoryPath(normalizedNewPath, newPath, 'rename');
            if (directoryStore.has(normalizedNewPath)) {
              throw Object.assign(new Error(`EISDIR: illegal operation on a directory, rename '${oldPath}' -> '${newPath}'`), { code: 'EISDIR' });
            }
            if (fileStore.has(normalizedNewPath)) deleteFile(newPath);
            if (symlinkStore.has(normalizedNewPath)) deleteFile(newPath);
            symlinkStore.delete(normalizedOldPath);
            deleteEntryMetadata(normalizedOldPath);
            io.fileChange({ path: normalizedOldPath, deleted: true }, 'live');
            symlinkStore.set(normalizedNewPath, linkTarget);
            entryMetadata.set(normalizedNewPath, createEntryMetadata(0o120777));
            io.fileChange({ path: normalizedNewPath, symlink: true, target: linkTarget }, 'live');
            notifyFsWatchers('rename', normalizedOldPath);
            notifyWatchFileWatchers(normalizedOldPath);
            notifyFsWatchers('rename', normalizedNewPath);
            notifyWatchFileWatchers(normalizedNewPath);
            return;
          }
          const bytes = fileStore.get(normalizedOldPath);
          if (bytes) {
            const sourceMetadata = entryMetadata.get(normalizedOldPath);
            assertReadonlyFilePath(normalizedOldPath, 'move');
            assertWorkspaceFileWritePath(normalizedNewPath, newPath, 'move', 'rename');
            fileStore.delete(normalizedOldPath);
            moveOpenFileDescriptorPath(normalizedOldPath, normalizedNewPath);
            moveHardLinkPath(normalizedOldPath, normalizedNewPath);
            modules.delete(normalizedOldPath);
            cache.delete(normalizedOldPath);
            deleteEntryMetadata(normalizedOldPath);
            io.fileChange({ path: normalizedOldPath, deleted: true }, 'live');
            notifyFsWatchers('rename', normalizedOldPath);
            notifyWatchFileWatchers(normalizedOldPath);
            setFileBytes(normalizedNewPath, bytes, sourceMetadata);
            notifyFsWatchers('rename', normalizedNewPath);
            return;
          }

          const oldPrefix = normalizedOldPath ? `${normalizedOldPath}/` : '';
          const sourceDirectories = Array.from(directoryStore)
            .filter((directoryPath) => directoryPath === normalizedOldPath || directoryPath.startsWith(oldPrefix))
            .sort((left, right) => left.localeCompare(right));
          const sourceFiles = Array.from(fileStore.entries())
            .filter(([filePath]) => filePath.startsWith(oldPrefix))
            .sort(([left], [right]) => left.localeCompare(right));
          const sourceSymlinks = Array.from(symlinkStore.entries())
            .filter(([linkPath]) => linkPath.startsWith(oldPrefix))
            .sort(([left], [right]) => left.localeCompare(right));
          const sourceFileMetadata = new Map(
            sourceFiles.map(([filePath]) => [filePath, entryMetadata.get(filePath)] as const)
          );
          const sourceDirectoryMetadata = new Map(
            sourceDirectories.map((directoryPath) => [directoryPath, entryMetadata.get(directoryPath)] as const)
          );
          if (sourceDirectories.length === 0 && sourceFiles.length === 0 && sourceSymlinks.length === 0) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`), { code: 'ENOENT' });
          }
          for (const [filePath] of sourceFiles) {
            assertReadonlyFilePath(filePath, 'move');
          }
          assertReadonlyFilePath(normalizedNewPath, 'move');
          assertWorkspaceParentDirectoryPath(normalizedNewPath, newPath, 'rename');
          if (fileStore.has(normalizedNewPath)) {
            throw Object.assign(new Error(`ENOTDIR: not a directory, rename '${oldPath}' -> '${newPath}'`), { code: 'ENOTDIR' });
          }

          const existingDestinationFiles = fileStore.has(normalizedNewPath)
            || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(`${normalizedNewPath}/`));
          const existingDestinationSymlinks = symlinkStore.has(normalizedNewPath)
            || Array.from(symlinkStore.keys()).some((linkPath) => linkPath.startsWith(`${normalizedNewPath}/`));
          const existingDestinationDirectories = directoryStore.has(normalizedNewPath)
            || Array.from(directoryStore).some((directoryPath) => directoryPath.startsWith(`${normalizedNewPath}/`));
          if (existingDestinationFiles || existingDestinationSymlinks || existingDestinationDirectories) {
            throw Object.assign(new Error(`EEXIST: file already exists, rename '${oldPath}' -> '${newPath}'`), { code: 'EEXIST' });
          }

          for (const [filePath] of sourceFiles) {
            fileStore.delete(filePath);
            const relative = filePath.slice(oldPrefix.length);
            const nextPath = normalizedNewPath ? `${normalizedNewPath}/${relative}` : relative;
            moveOpenFileDescriptorPath(filePath, nextPath);
            moveHardLinkPath(filePath, nextPath);
            modules.delete(filePath);
            cache.delete(filePath);
            deleteEntryMetadata(filePath);
            io.fileChange({ path: filePath, deleted: true }, 'live');
            notifyFsWatchers('rename', filePath);
            notifyWatchFileWatchers(filePath);
          }
          for (const [linkPath] of sourceSymlinks) {
            symlinkStore.delete(linkPath);
            deleteEntryMetadata(linkPath);
            io.fileChange({ path: linkPath, deleted: true }, 'live');
            notifyFsWatchers('rename', linkPath);
            notifyWatchFileWatchers(linkPath);
          }
          for (const directoryPath of [...sourceDirectories].sort((left, right) => right.length - left.length || right.localeCompare(left))) {
            directoryStore.delete(directoryPath);
            deleteEntryMetadata(directoryPath);
            emitDirectoryDelete(directoryPath);
            notifyDirectoryMutation(directoryPath);
          }
          for (const directoryPath of sourceDirectories) {
            const relative = directoryPath === normalizedOldPath ? '' : directoryPath.slice(oldPrefix.length);
            const nextDirectory = relative ? `${normalizedNewPath}/${relative}` : normalizedNewPath;
            const existed = directoryStore.has(nextDirectory);
            directoryStore.add(nextDirectory);
            const metadata = sourceDirectoryMetadata.get(directoryPath);
            if (metadata) {
              requestState.fsTimestampMs += 1;
              entryMetadata.set(nextDirectory, { ...metadata, ctimeMs: requestState.fsTimestampMs });
            } else if (!entryMetadata.has(nextDirectory)) {
              touchEntryMetadata(nextDirectory);
            }
            if (!existed) {
              emitDirectoryCreate(nextDirectory);
              notifyDirectoryMutation(nextDirectory);
            }
          }
          for (const [filePath, fileBytes] of sourceFiles) {
            const relative = filePath.slice(oldPrefix.length);
            const nextPath = normalizedNewPath ? `${normalizedNewPath}/${relative}` : relative;
            setFileBytes(nextPath, fileBytes, sourceFileMetadata.get(filePath));
            notifyFsWatchers('rename', nextPath);
          }
          for (const [linkPath, target] of sourceSymlinks) {
            const relative = linkPath.slice(oldPrefix.length);
            const nextPath = normalizedNewPath ? `${normalizedNewPath}/${relative}` : relative;
            symlinkStore.set(nextPath, target);
            entryMetadata.set(nextPath, createEntryMetadata(0o120777));
            io.fileChange({ path: nextPath, symlink: true, target }, 'live');
            notifyFsWatchers('rename', nextPath);
            notifyWatchFileWatchers(nextPath);
          }
        },
        rename: (oldPath: unknown, newPath: unknown, callback?: (error?: Error | null) => void) => {
          try {
            fsApi.renameSync(oldPath, newPath);
            queueMicrotask(() => callback?.(null));
          } catch (error) {
            queueMicrotask(() => callback?.(error as Error));
          }
        },
        unlinkSync: deleteFile,
        unlink: (path: unknown, callback?: (error?: Error | null) => void) => {
          try {
            fsApi.unlinkSync(path);
            queueMicrotask(() => callback?.(null));
          } catch (error) {
            queueMicrotask(() => callback?.(error as Error));
          }
        },
        rmSync: (path: unknown, options?: { force?: boolean; recursive?: boolean }) => {
          try {
            const removeTarget = runtimeRemoveTarget(path, kernelDevices);
            if (removeTarget?.kind === 'error') {
              throwRuntimeRemoveTargetError(removeTarget, runtimeKernelMutationFsErrorMessage(String(path), removeTarget, 'rm'));
            }
            const normalized = resolveWorkspaceEntryPath(path, false);
            if (executionState.kernelFileSystem) {
              const removeEntry = (entryPath: string, recursive: boolean): void => {
                const stat = executionState.kernelFileSystem!.stat(entryPath);
                if (stat.kind === 'file') {
                  executionState.kernelFileSystem!.unlink(entryPath);
                  return;
                }
                if (!recursive) {
                  throw Object.assign(
                    new Error(`ERR_FS_EISDIR: path is a directory, rm '${path}'`),
                    { code: 'ERR_FS_EISDIR' }
                  );
                }
                for (const entry of executionState.kernelFileSystem!.readdir(entryPath)) {
                  removeEntry(
                    entryPath
                      ? `${entryPath.replace(/\/+$/, '')}/${entry.name}`
                      : entry.name,
                    true
                  );
                }
                executionState.kernelFileSystem!.rmdir(entryPath);
              };
              try {
                removeEntry(normalized, options?.recursive === true);
              } catch (error) {
                if (options?.force && (error as { code?: unknown }).code === 'ENOENT') return;
                throw error;
              }
              return;
            }
            if (fileStore.has(normalized) || symlinkStore.has(normalized)) {
              deleteFile(path);
              return;
            }
            const prefix = normalized ? `${normalized}/` : '';
            assertWorkspaceParentDirectoryPath(normalized, path, 'rm');
            const descendantFiles = Array.from(fileStore.keys()).filter((filePath) => filePath.startsWith(prefix));
            const descendantSymlinks = Array.from(symlinkStore.keys()).filter((linkPath) => linkPath.startsWith(prefix));
            const descendantDirectories = Array.from(directoryStore).filter((directoryPath) => directoryPath !== normalized && directoryPath.startsWith(prefix));
            if (directoryStore.has(normalized) || descendantFiles.length > 0 || descendantSymlinks.length > 0 || descendantDirectories.length > 0) {
              if (!options?.recursive) {
                throw Object.assign(new Error(`ERR_FS_EISDIR: path is a directory, rm '${path}'`), { code: 'ERR_FS_EISDIR' });
              }
              for (const filePath of descendantFiles) {
                assertReadonlyFilePath(filePath, 'delete');
              }
              for (const filePath of descendantFiles) {
                fileStore.delete(filePath);
                modules.delete(filePath);
                cache.delete(filePath);
                deleteEntryMetadata(filePath);
                io.fileChange({ path: filePath, deleted: true }, 'live');
                notifyFsWatchers('rename', filePath);
                notifyWatchFileWatchers(filePath);
              }
              for (const linkPath of descendantSymlinks) {
                assertReadonlyFilePath(linkPath, 'delete');
                symlinkStore.delete(linkPath);
                deleteEntryMetadata(linkPath);
                io.fileChange({ path: linkPath, deleted: true }, 'live');
                notifyFsWatchers('rename', linkPath);
                notifyWatchFileWatchers(linkPath);
              }
              for (const directoryPath of Array.from(directoryStore)) {
                if (directoryPath === normalized || directoryPath.startsWith(prefix)) {
                  directoryStore.delete(directoryPath);
                  deleteEntryMetadata(directoryPath);
                  emitDirectoryDelete(directoryPath);
                  notifyDirectoryMutation(directoryPath);
                }
              }
              return;
            }
            if (!options?.force) {
              throw Object.assign(new Error(`ENOENT: no such file or directory, rm '${path}'`), { code: 'ENOENT' });
            }
          } catch (error) {
            if (options?.force && (error as { code?: unknown }).code === 'ENOENT') return;
            throw error;
          }
        },
        rm: (path: unknown, optionsOrCallback?: { force?: boolean; recursive?: boolean } | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
          const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
          try {
            fsApi.rmSync(path, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
            queueMicrotask(() => done?.(null));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        existsSync: (path: unknown) => {
          try {
            return fileSystemEntryExists(path);
          } catch {
            return false;
          }
        },
        exists: (path: unknown, callback?: (exists: boolean) => void) => {
          queueMicrotask(() => callback?.(fsApi.existsSync(path)));
        },
        readdirSync: (path: unknown, options?: { withFileTypes?: boolean; recursive?: boolean } | string | null) => {
          const directoryTarget = runtimeDirectoryTarget(path, kernelDevices, procSnapshot);
          const withFileTypes = typeof options === 'object' && options?.withFileTypes === true;
          const makeDirent = (
            name: string,
            type: 'file' | 'directory' | 'symlink',
            parentPath: string,
            characterDevice = false
          ) => ({
            name,
            path: parentPath,
            parentPath,
            isBlockDevice: () => false,
            isCharacterDevice: () => characterDevice,
            isDirectory: () => type === 'directory',
            isFIFO: () => false,
            isFile: () => type === 'file',
            isSocket: () => false,
            isSymbolicLink: () => type === 'symlink',
          });
          if (directoryTarget?.kind === 'directory') {
            const names = directoryTarget.entries.map((entry) => entry.name);
            if (!withFileTypes) return names;
            return directoryTarget.entries.map((entry) => makeDirent(
              entry.name,
              entry.kind === 'directory' ? 'directory' : 'file',
              directoryTarget.path,
              directoryTarget.path === '/dev' && entry.kind === 'file'
            ));
          }
          if (directoryTarget?.kind === 'error') {
            throwRuntimeDirectoryTargetError(directoryTarget, directoryTarget.reason === 'not-directory'
              ? `ENOTDIR: not a directory, scandir '${path}'`
              : `ENOENT: no such file or directory, scandir '${path}'`);
          }
          const normalized = resolveWorkspaceEntryPath(path);
          if (executionState.kernelFileSystem) {
            const recursive = typeof options === 'object' && options?.recursive === true;
            const entries: Array<{
              relativePath: string;
              kind: 'file' | 'directory' | 'symlink';
            }> = [];
            const collectEntries = (
              directoryPath: string,
              relativePrefix: string
            ): void => {
              for (const entry of executionState.kernelFileSystem!.readdir(directoryPath)) {
                const relativePath = relativePrefix
                  ? `${relativePrefix}/${entry.name}`
                  : entry.name;
                entries.push({ relativePath, kind: entry.kind });
                if (recursive && entry.kind === 'directory') {
                  collectEntries(
                    directoryPath
                      ? `${directoryPath.replace(/\/+$/, '')}/${entry.name}`
                      : entry.name,
                    relativePath
                  );
                }
              }
            };
            collectEntries(normalized, '');
            entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
            if (!withFileTypes) return entries.map((entry) => entry.relativePath);
            return entries.map((entry) => {
              const parts = entry.relativePath.split('/');
              const name = parts.pop() ?? entry.relativePath;
              const relativeParent = parts.join('/');
              const parentPath = relativeParent
                ? normalized
                  ? `${normalized}/${relativeParent}`
                  : relativeParent
                : normalized;
              return makeDirent(
                name,
                entry.kind,
                workspaceFilename(parentPath, workspaceRoot)
              );
            });
          }
          if (workspaceFileAncestor(normalized) !== null || fileStore.has(normalized)) {
            throw Object.assign(new Error(`ENOTDIR: not a directory, scandir '${path}'`), { code: 'ENOTDIR' });
          }
          const prefix = normalized ? `${normalized}/` : '';
          const recursive = typeof options === 'object' && options?.recursive === true;
          const makeWorkspaceDirent = (name: string, type: 'file' | 'directory' | 'symlink', parentPath = normalized) =>
            makeDirent(name, type, workspaceFilename(parentPath, workspaceRoot));
          if (recursive) {
            const entries = new Map<string, 'file' | 'directory' | 'symlink'>();
            for (const directoryPath of directoryStore) {
              if (directoryPath === normalized || !directoryPath.startsWith(prefix)) continue;
              const rest = directoryPath.slice(prefix.length);
              if (rest) entries.set(rest, 'directory');
            }
            for (const filePath of fileStore.keys()) {
              if (!filePath.startsWith(prefix)) continue;
              const rest = filePath.slice(prefix.length);
              if (rest) entries.set(rest, 'file');
            }
            for (const linkPath of symlinkStore.keys()) {
              if (!linkPath.startsWith(prefix)) continue;
              const rest = linkPath.slice(prefix.length);
              if (rest) entries.set(rest, 'symlink');
            }
            if (entries.size === 0 && !fileStore.has(normalized) && !directoryStore.has(normalized)) {
              throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), { code: 'ENOENT' });
            }
            const sortedEntries = Array.from(entries.entries()).sort(([left], [right]) => left.localeCompare(right));
            if (!withFileTypes) return sortedEntries.map(([name]) => name);
            return sortedEntries.map(([relativePath, type]) => {
              const parts = relativePath.split('/');
              const name = parts.pop() ?? relativePath;
              const parentPath = parts.length === 0
                ? normalized
                : normalized
                  ? `${normalized}/${parts.join('/')}`
                  : parts.join('/');
              return makeWorkspaceDirent(name, type, parentPath);
            });
          }
          const entries = new Map<string, 'file' | 'directory' | 'symlink'>();
          for (const filePath of fileStore.keys()) {
            if (!filePath.startsWith(prefix)) continue;
            const rest = filePath.slice(prefix.length);
            if (!rest) continue;
            const [name, ...remaining] = rest.split('/');
            if (!name) continue;
            entries.set(name, remaining.length > 0 ? 'directory' : 'file');
          }
          for (const directoryPath of directoryStore) {
            if (!directoryPath.startsWith(prefix)) continue;
            const rest = directoryPath.slice(prefix.length);
            if (!rest) continue;
            const name = rest.split('/')[0] ?? rest;
            if (!entries.has(name)) entries.set(name, 'directory');
          }
          for (const linkPath of symlinkStore.keys()) {
            if (!linkPath.startsWith(prefix)) continue;
            const rest = linkPath.slice(prefix.length);
            if (!rest) continue;
            const [name, ...remaining] = rest.split('/');
            if (!name) continue;
            entries.set(name, remaining.length > 0 ? 'directory' : 'symlink');
          }
          if (entries.size === 0 && !fileStore.has(normalized) && !directoryStore.has(normalized)) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), { code: 'ENOENT' });
          }
          const sortedEntries = Array.from(entries.entries()).sort(([left], [right]) => left.localeCompare(right));
          if (!withFileTypes) return sortedEntries.map(([name]) => name);
          return sortedEntries.map(([name, type]) => makeWorkspaceDirent(name, type));
        },
        readdir: (path: unknown, optionsOrCallback?: { withFileTypes?: boolean; recursive?: boolean } | string | null | ((error: Error | null, files?: unknown) => void), callback?: (error: Error | null, files?: unknown) => void) => {
          const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
          try {
            const entries = fsApi.readdirSync(path, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
            queueMicrotask(() => done?.(null, entries));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        opendirSync: (path: unknown) => {
          const entries = fsApi.readdirSync(path, { withFileTypes: true }) as Array<{
            name: string;
            isFile: () => boolean;
            isDirectory: () => boolean;
            isSymbolicLink: () => boolean;
          }>;
          let index = 0;
          let closed = false;
          const assertOpen = (): void => {
            if (closed) throw Object.assign(new Error('ERR_DIR_CLOSED: Directory handle was closed'), { code: 'ERR_DIR_CLOSED' });
          };
          const dir = {
            path: fsApi.realpathSync(path),
            readSync: () => {
              assertOpen();
              return entries[index++] ?? null;
            },
            read: (callback?: (error: Error | null, dirent?: unknown) => void) => {
              if (typeof callback !== 'function') {
                return new Promise((resolve, reject) => {
                  try {
                    const entry = dir.readSync();
                    queueMicrotask(() => resolve(entry));
                  } catch (error) {
                    queueMicrotask(() => reject(error));
                  }
                });
              }
              try {
                const entry = dir.readSync();
                queueMicrotask(() => callback?.(null, entry));
              } catch (error) {
                queueMicrotask(() => callback?.(error as Error));
              }
            },
            closeSync: () => {
              closed = true;
            },
            close: (callback?: (error?: Error | null) => void) => {
              if (typeof callback !== 'function') {
                return new Promise<void>((resolve) => {
                  closed = true;
                  queueMicrotask(resolve);
                });
              }
              closed = true;
              queueMicrotask(() => callback?.(null));
            },
            async *[Symbol.asyncIterator]() {
              while (true) {
                const entry = dir.readSync();
                if (entry === null) break;
                yield entry;
              }
            },
          };
          return dir;
        },
        opendir: (path: unknown, optionsOrCallback?: unknown, callback?: (error: Error | null, dir?: unknown) => void) => {
          const done = typeof optionsOrCallback === 'function' ? optionsOrCallback as (error: Error | null, dir?: unknown) => void : callback;
          try {
            const dir = fsApi.opendirSync(path);
            queueMicrotask(() => done?.(null, dir));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        statSync: (path: unknown, options?: BrowserStatOptions) => {
          const kernelStats = statForKernelTarget(path, options);
          if (kernelStats === undefined) return undefined;
          let stats = kernelStats;
          if (stats === null) {
            const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
            if (executionState.kernelFileSystem) {
              try {
                stats = statForTraceKernelPath(
                  executionState.kernelFileSystem.stat(normalized)
                );
              } catch (error) {
                if (
                  options?.throwIfNoEntry === false &&
                  (error as { code?: unknown }).code === 'ENOENT'
                ) {
                  return undefined;
                }
                throw error;
              }
            } else {
            if (workspaceFileAncestor(normalized) !== null) {
              if (options?.throwIfNoEntry === false) return undefined;
              throw Object.assign(new Error(`ENOTDIR: not a directory, stat '${path}'`), { code: 'ENOTDIR' });
            }
            stats = statForNormalizedPath(normalized);
            }
          }
          if (!stats) {
            if (options?.throwIfNoEntry === false) return undefined;
            throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: 'ENOENT' });
          }
          return browserStatsResult(stats, options);
        },
        lstatSync: (path: unknown, options?: BrowserStatOptions) => {
          const kernelStats = statForKernelTarget(path, options);
          if (kernelStats === undefined) return undefined;
          let stats = kernelStats;
          if (stats === null) {
            const normalized = resolveWorkspaceEntryPath(path, false);
            if (executionState.kernelFileSystem) {
              try {
                stats = statForTraceKernelPath(
                  executionState.kernelFileSystem.lstat(normalized)
                );
              } catch (error) {
                if (
                  options?.throwIfNoEntry === false &&
                  (error as { code?: unknown }).code === 'ENOENT'
                ) {
                  return undefined;
                }
                throw error;
              }
            } else {
            if (workspaceFileAncestor(normalized) !== null) {
              if (options?.throwIfNoEntry === false) return undefined;
              throw Object.assign(new Error(`ENOTDIR: not a directory, lstat '${path}'`), { code: 'ENOTDIR' });
            }
            stats = statForNormalizedPath(normalized, false);
            }
          }
          if (!stats) {
            if (options?.throwIfNoEntry === false) return undefined;
            throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: 'ENOENT' });
          }
          return browserStatsResult(stats, options);
        },
        statfsSync: (path: unknown, options?: { bigint?: boolean }) => {
          fsApi.statSync(path);
          return browserFileSystemStat(Boolean(options?.bigint));
        },
        stat: (
          path: unknown,
          optionsOrCallback?: BrowserStatOptions | ((error: Error | null, stats?: { size: number | bigint; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }) => void),
          callback?: (error: Error | null, stats?: { size: number | bigint; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }) => void
        ) => {
          const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
          const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
          try {
            const stats = fsApi.statSync(path, options);
            queueMicrotask(() => done?.(null, stats));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        lstat: (
          path: unknown,
          optionsOrCallback?: BrowserStatOptions | ((error: Error | null, stats?: { size: number | bigint; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }) => void),
          callback?: (error: Error | null, stats?: { size: number | bigint; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }) => void
        ) => {
          const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
          const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
          try {
            const stats = fsApi.lstatSync(path, options);
            if (stats === undefined && options?.throwIfNoEntry === false) {
              throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: 'ENOENT' });
            }
            queueMicrotask(() => done?.(null, stats));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        statfs: (
          path: unknown,
          optionsOrCallback?: { bigint?: boolean } | ((error: Error | null, stats?: BrowserFileSystemStat) => void),
          callback?: (error: Error | null, stats?: BrowserFileSystemStat) => void
        ) => {
          const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
          const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
          try {
            const stats = fsApi.statfsSync(path, options);
            queueMicrotask(() => done?.(null, stats));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        realpathSync: (path: unknown, options?: string | { encoding?: string | null } | null) => {
          const resolved = realpathForEntry(path);
          const encoding = typeof options === 'string' ? options : options?.encoding;
          return encoding === 'buffer' ? BrowserBuffer.from(resolved) : resolved;
        },
        realpath: (path: unknown, optionsOrCallback?: string | { encoding?: string | null } | null | ((error: Error | null, resolvedPath?: unknown) => void), callback?: (error: Error | null, resolvedPath?: unknown) => void) => {
          const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
          try {
            const resolved = fsApi.realpathSync(path, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
            queueMicrotask(() => done?.(null, resolved));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        truncateSync: (path: unknown, length = 0) => {
          const truncateTarget = runtimeTruncateTarget(path, kernelDevices);
          if (truncateTarget?.kind === 'error') {
            throwRuntimeTruncateTargetError(truncateTarget, runtimeKernelMutationFsErrorMessage(String(path), truncateTarget, 'truncate'));
          }
          const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
          assertWorkspaceFileWritePath(normalized, path, 'truncate');
          truncateFileBytes(normalized, length);
          return undefined;
        },
        truncate: (path: unknown, lengthOrCallback?: number | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
          const done = typeof lengthOrCallback === 'function' ? lengthOrCallback : callback;
          try {
            fsApi.truncateSync(path, typeof lengthOrCallback === 'number' ? lengthOrCallback : 0);
            queueMicrotask(() => done?.(null));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        mkdirSync: (
          path: unknown,
          options?: { recursive?: boolean; mode?: string | number } | number
        ) => {
          const mkdirTarget = runtimeMkdirTarget(path, kernelDevices);
          if (mkdirTarget?.kind === 'error') {
            throwRuntimeMkdirTargetError(mkdirTarget, runtimeKernelMutationFsErrorMessage(String(path), mkdirTarget, 'mkdir'));
          }
          const rawPath = workspacePathInputToString(path).replace(/\\/g, '/');
          const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
          if (!normalized) return undefined;
          const recursive = typeof options === 'object' && options?.recursive === true;
          const mode = typeof options === 'number'
            ? options
            : typeof options?.mode === 'number'
              ? options.mode
              : undefined;
          if (executionState.kernelFileSystem) {
            let firstCreated: string | undefined;
            if (recursive) {
              const parts = normalized.split('/');
              for (let index = 1; index <= parts.length; index += 1) {
                const candidate = parts.slice(0, index).join('/');
                try {
                  executionState.kernelFileSystem.stat(candidate);
                } catch (error) {
                  if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
                  firstCreated = candidate;
                  break;
                }
              }
            }
            executionState.kernelFileSystem.mkdir(normalized, {
              recursive,
              ...(mode !== undefined ? { mode } : {}),
            });
            if (!recursive || firstCreated === undefined) return undefined;
            if (rawPath.startsWith('/')) {
              return workspaceFilename(firstCreated, workspaceRoot);
            }
            const relativeFirstCreated = relativeWorkspacePath(cwdPath, firstCreated);
            return rawPath.startsWith('./') && !relativeFirstCreated.startsWith('.')
              ? `./${relativeFirstCreated}`
              : relativeFirstCreated;
          }
          assertReadonlyFilePath(normalized, 'mkdir');
          const parent = dirname(normalized);
          const parentPath = parent === '' ? '' : parent;
          const parts = normalized.split('/');
          for (let index = 1; index < parts.length; index += 1) {
            const directoryPath = parts.slice(0, index).join('/');
            if (fileStore.has(directoryPath)) {
              throw Object.assign(new Error(`ENOTDIR: not a directory, mkdir '${path}'`), { code: 'ENOTDIR' });
            }
          }
          if (fileStore.has(normalized)) {
            throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${path}'`), { code: 'EEXIST' });
          }
          if (directoryStore.has(normalized)) {
            if (!recursive) {
              throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${path}'`), { code: 'EEXIST' });
            }
            return undefined;
          }
          if (!recursive && parentPath && !directoryStore.has(parentPath)) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, mkdir '${path}'`), { code: 'ENOENT' });
          }
          const start = recursive ? 1 : parts.length;
          let firstCreated: string | undefined;
          for (let index = start; index <= parts.length; index += 1) {
            const directoryPath = parts.slice(0, index).join('/');
            const existed = directoryStore.has(directoryPath);
            directoryStore.add(directoryPath);
            if (!entryMetadata.has(directoryPath)) touchEntryMetadata(directoryPath);
            if (!existed) {
              firstCreated ??= directoryPath;
              emitDirectoryCreate(directoryPath);
              notifyDirectoryMutation(directoryPath);
            }
          }
          if (!recursive || firstCreated === undefined) return undefined;
          if (rawPath.startsWith('/')) return workspaceFilename(firstCreated, workspaceRoot);
          const relativeFirstCreated = relativeWorkspacePath(cwdPath, firstCreated);
          return rawPath.startsWith('./') && !relativeFirstCreated.startsWith('.')
            ? `./${relativeFirstCreated}`
            : relativeFirstCreated;
        },
        mkdir: (
          path: unknown,
          optionsOrCallback?: { recursive?: boolean } | ((error?: Error | null, path?: string) => void),
          callback?: (error?: Error | null, path?: string) => void
        ) => {
          const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
          try {
            const created = fsApi.mkdirSync(path, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
            queueMicrotask(() => done?.(null, created));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        mkdtempSync: (prefix: unknown, options?: string | { encoding?: string | null } | null) => {
          const rawPrefix = workspacePathInputToString(prefix);
          for (let attempt = 0; attempt < 1000; attempt += 1) {
            filesystemState.mkdtempCounter += 1;
            const suffix = filesystemState.mkdtempCounter.toString(36).padStart(6, '0').slice(-6);
            const candidate = `${rawPrefix}${suffix}`;
            const normalized = normalizeWorkspaceEntryPath(candidate, cwdPath, false, workspacePathContext);
            if (fileStore.has(normalized) || directoryStore.has(normalized)) continue;
            fsApi.mkdirSync(candidate);
            const encoding = typeof options === 'string' ? options : options?.encoding;
            const result = rawPrefix.startsWith('/') ? workspaceFilename(normalized, workspaceRoot) : candidate;
            return encoding === 'buffer' ? BrowserBuffer.from(result) : result;
          }
          throw Object.assign(new Error(`EEXIST: file already exists, mkdtemp '${prefix}'`), { code: 'EEXIST' });
        },
        mkdtemp: (
          prefix: unknown,
          optionsOrCallback?: string | { encoding?: string | null } | null | ((error: Error | null, directory?: unknown) => void),
          callback?: (error: Error | null, directory?: unknown) => void
        ) => {
          const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
          try {
            const directory = fsApi.mkdtempSync(prefix, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
            queueMicrotask(() => done?.(null, directory));
          } catch (error) {
            queueMicrotask(() => done?.(error as Error));
          }
        },
        rmdirSync: (path: unknown) => {
          const removeTarget = runtimeRemoveTarget(path, kernelDevices);
          if (removeTarget?.kind === 'error') {
            throwRuntimeRemoveTargetError(removeTarget, runtimeKernelMutationFsErrorMessage(String(path), removeTarget, 'rmdir'));
          }
          const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
          if (executionState.kernelFileSystem) {
            executionState.kernelFileSystem.rmdir(normalized);
            return;
          }
          assertWorkspaceParentDirectoryPath(normalized, path, 'rmdir');
          if (fileStore.has(normalized)) {
            throw Object.assign(new Error(`ENOTDIR: not a directory, rmdir '${path}'`), { code: 'ENOTDIR' });
          }
          const prefix = normalized ? `${normalized}/` : '';
          const hasChildren = Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix))
            || Array.from(directoryStore).some((directoryPath) => directoryPath !== normalized && directoryPath.startsWith(prefix));
          if (hasChildren) {
            throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`), { code: 'ENOTEMPTY' });
          }
          if (!directoryStore.delete(normalized)) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, rmdir '${path}'`), { code: 'ENOENT' });
          }
          deleteEntryMetadata(normalized);
          emitDirectoryDelete(normalized);
          notifyDirectoryMutation(normalized);
        },
        rmdir: (path: unknown, callback?: (error?: Error | null) => void) => {
          try {
            fsApi.rmdirSync(path);
            queueMicrotask(() => callback?.(null));
          } catch (error) {
            queueMicrotask(() => callback?.(error as Error));
          }
        },
      };

  filesystemState.attachFsApi(fsApi);

  return fsApi;

}

export type BrowserFsApi = ReturnType<typeof createBrowserFsApi>;

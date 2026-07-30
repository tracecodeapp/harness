import {
  BrowserBuffer,
  bytesFromFsWriteValue,
} from "../internal/encoding";

import {
  addStreamInternalCloseListener,
} from "../node-compat/streams";

import {
  type BrowserStatOptions,
} from "./filesystem-state";

import type { BrowserJavaScriptRequestState } from '../browser/request-state';

import type { BrowserFileSystemState } from './filesystem-state';

import type { BrowserFsApi } from './fs-api';

export function createBrowserFsPromisesApi(

  requestState: BrowserJavaScriptRequestState,

  filesystemState: BrowserFileSystemState,

  fsApi: BrowserFsApi

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

  const fileHandleTarget = (path: unknown): unknown => (
        typeof path === 'object' &&
          path !== null &&
          !(path instanceof URL) &&
          typeof (path as { fd?: unknown }).fd === 'number'
          ? (path as { fd: number }).fd
          : path
      );

  const fsPromisesApi = {
        constants: fsConstants,
        access: async (path: unknown, mode = fsConstants.F_OK) => {
          fsApi.accessSync(path, mode);
        },
        open: async (path: unknown, flags: unknown = 'r') => {
          const fd = fsApi.openSync(path, flags);
          let closed = false;
          const assertFileHandleOpen = (): void => {
            if (closed) throw Object.assign(new Error('file closed'), { code: 'EBADF' });
          };
          const trackAutoCloseStream = (stream: unknown, autoClose: boolean): void => {
            if (!autoClose) return;
            addStreamInternalCloseListener(stream, () => {
              closed = true;
            });
          };
          const readFileFromHandle = (encoding?: string | { encoding?: string | null } | null): BrowserBuffer | string => {
            assertFileHandleOpen();
            const bytes = BrowserBuffer.from(readDescriptorFileBytes(fd));
            const requestedEncoding = typeof encoding === 'string' ? encoding : encoding?.encoding;
            return typeof requestedEncoding === 'string' ? bytes.toString(requestedEncoding) : bytes;
          };
          const writeFileToHandle = (value: unknown, options?: string | { encoding?: string | null } | null): number => {
            assertFileHandleOpen();
            const bytes = bytesFromFsWriteValue(value, options);
            return fsApi.writeSync(fd, bytes, 0, bytes.byteLength, null);
          };
          const appendFileToHandle = (value: unknown, options?: string | { encoding?: string | null } | null): number => {
            assertFileHandleOpen();
            const entry = fileDescriptor(fd);
            const bytes = bytesFromFsWriteValue(value, options);
            const position = entry.kind === 'device' ? null : descriptorBytes(entry).byteLength;
            return fsApi.writeSync(fd, bytes, 0, bytes.byteLength, position);
          };
          return {
            fd,
            read: async (
              bufferOrOptions?: Uint8Array | { buffer?: Uint8Array; offset?: number; length?: number; position?: number | null },
              offset = 0,
              length?: number,
              position?: number | null
            ) => {
              assertFileHandleOpen();
              const options = typeof bufferOrOptions === 'object' && bufferOrOptions !== null && !ArrayBuffer.isView(bufferOrOptions)
                ? bufferOrOptions
                : undefined;
              const buffer = options?.buffer ?? (ArrayBuffer.isView(bufferOrOptions) ? bufferOrOptions : BrowserBuffer.alloc(16 * 1024));
              const readOffset = options?.offset ?? offset;
              const readLength = options?.length ?? length ?? buffer.byteLength - readOffset;
              const readPosition = options !== undefined ? options.position : position;
              const bytesRead = fsApi.readSync(fd, buffer, readOffset, readLength, readPosition);
              return { bytesRead, buffer };
            },
            readFile: async (encoding?: string | { encoding?: string | null } | null) => readFileFromHandle(encoding),
            readv: async (buffers: Uint8Array[], position?: number | null) => {
              assertFileHandleOpen();
              const bytesRead = fsApi.readvSync(fd, buffers, position);
              return { bytesRead, buffers };
            },
            write: async (
              value: unknown,
              offsetOrPosition?: number | { offset?: number; length?: number; position?: number | null },
              lengthOrEncoding?: number | string,
              position?: number | null
            ) => {
              assertFileHandleOpen();
              const options = typeof offsetOrPosition === 'object' && offsetOrPosition !== null ? offsetOrPosition : undefined;
              const bytesWritten = fsApi.writeSync(
                fd,
                value,
                options?.offset ?? (typeof offsetOrPosition === 'number' ? offsetOrPosition : undefined),
                options?.length ?? lengthOrEncoding,
                options !== undefined ? options.position : position
              );
              return {
                bytesWritten,
                buffer: value,
              };
            },
            writeFile: async (value: unknown, options?: string | { encoding?: string | null } | null) => {
              writeFileToHandle(value, options);
            },
            createReadStream: (options?: string | { autoClose?: boolean; encoding?: string; end?: number; start?: number } | null) => {
              assertFileHandleOpen();
              const streamOptions = typeof options === 'string' ? { encoding: options, fd } : { ...(options ?? {}), fd };
              const stream = fsApi.createReadStream(null, streamOptions);
              trackAutoCloseStream(stream, typeof options !== 'object' || options?.autoClose !== false);
              return stream;
            },
            createWriteStream: (options?: string | { autoClose?: boolean; encoding?: string | null; flags?: string } | null) => {
              assertFileHandleOpen();
              const streamOptions = typeof options === 'string' ? { encoding: options, fd } : { ...(options ?? {}), fd };
              const stream = fsApi.createWriteStream(null, streamOptions);
              trackAutoCloseStream(stream, typeof options !== 'object' || options?.autoClose !== false);
              return stream;
            },
            appendFile: async (value: unknown, options?: string | { encoding?: string | null } | null) => {
              appendFileToHandle(value, options);
            },
            writev: async (buffers: Uint8Array[], position?: number | null) => {
              assertFileHandleOpen();
              const bytesWritten = fsApi.writevSync(fd, buffers, position);
              return { bytesWritten, buffers };
            },
            stat: async (options?: BrowserStatOptions) => {
              assertFileHandleOpen();
              return fsApi.fstatSync(fd, options);
            },
            chmod: async (mode: unknown) => {
              assertFileHandleOpen();
              fsApi.fchmodSync(fd, mode);
            },
            chown: async (uid: unknown, gid: unknown) => {
              assertFileHandleOpen();
              fsApi.fchownSync(fd, uid, gid);
            },
            utimes: async (atime: unknown, mtime: unknown) => {
              assertFileHandleOpen();
              fsApi.futimesSync(fd, atime, mtime);
            },
            truncate: async (length = 0) => {
              assertFileHandleOpen();
              fsApi.ftruncateSync(fd, length);
            },
            sync: async () => {
              assertFileHandleOpen();
              fsApi.fsyncSync(fd);
            },
            datasync: async () => {
              assertFileHandleOpen();
              fsApi.fdatasyncSync(fd);
            },
            close: async () => {
              if (closed) return;
              closed = true;
              fsApi.closeSync(fd);
            },
          };
        },
        readFile: async (path: unknown, encoding?: string | { encoding?: string }) => fsApi.readFileSync(fileHandleTarget(path), encoding),
        writeFile: async (path: unknown, value: unknown, options?: string | { encoding?: string | null } | null) => {
          fsApi.writeFileSync(fileHandleTarget(path), value, options);
        },
        appendFile: async (path: unknown, value: unknown, options?: string | { encoding?: string | null } | null) => {
          fsApi.appendFileSync(fileHandleTarget(path), value, options);
        },
        copyFile: async (source: unknown, destination: unknown, mode = 0) => {
          fsApi.copyFileSync(source, destination, mode);
        },
        link: async (existingPath: unknown, newPath: unknown) => {
          fsApi.linkSync(existingPath, newPath);
        },
        symlink: async (target: unknown, linkPath: unknown) => {
          fsApi.symlinkSync(target, linkPath);
        },
        readlink: async (path: unknown, options?: string | { encoding?: string | null } | null) => fsApi.readlinkSync(path, options),
        cp: async (source: unknown, destination: unknown, options?: { recursive?: boolean; force?: boolean; errorOnExist?: boolean; filter?: (source: string, destination: string) => boolean }) => {
          fsApi.cpSync(source, destination, options);
        },
        chmod: async (path: unknown, mode: unknown) => {
          fsApi.chmodSync(path, mode);
        },
        chown: async (path: unknown, uid: unknown, gid: unknown) => {
          fsApi.chownSync(path, uid, gid);
        },
        utimes: async (path: unknown, atime: unknown, mtime: unknown) => {
          fsApi.utimesSync(path, atime, mtime);
        },
        rename: async (oldPath: unknown, newPath: unknown) => {
          fsApi.renameSync(oldPath, newPath);
        },
        unlink: async (path: unknown) => {
          fsApi.unlinkSync(path);
        },
        truncate: async (path: unknown, length = 0) => {
          fsApi.truncateSync(path, length);
        },
        rm: async (path: unknown, options?: { force?: boolean; recursive?: boolean }) => {
          fsApi.rmSync(path, options);
        },
        readdir: async (path: unknown, options?: { withFileTypes?: boolean; recursive?: boolean } | string | null) => fsApi.readdirSync(path, options),
        opendir: async (path: unknown) => fsApi.opendirSync(path),
        watch: (path: unknown, options?: { recursive?: boolean; signal?: AbortSignal } | string | null) => {
          type WatchEntry = { eventType: string; filename: string };
          const entries: WatchEntry[] = [];
          const waiters: Array<(result: IteratorResult<WatchEntry>) => void> = [];
          let closed = false;
          const close = (): void => {
            if (closed) return;
            closed = true;
            watcher.close();
            entries.length = 0;
            while (waiters.length > 0) {
              waiters.shift()?.({ done: true, value: undefined });
            }
          };
          const watcher = fsApi.watch(path, typeof options === 'string' ? undefined : options ?? undefined, (eventType, filename) => {
            const entry = { eventType, filename };
            const waiter = waiters.shift();
            if (waiter) {
              waiter({ done: false, value: entry });
              return;
            }
            entries.push(entry);
          });
          if (typeof options === 'object' && options?.signal) {
            if (options.signal.aborted) {
              close();
            } else {
              options.signal.addEventListener('abort', close, { once: true });
            }
          }
          const iterator = {
            [Symbol.asyncIterator]() {
              return iterator;
            },
            next: (): Promise<IteratorResult<WatchEntry>> => {
              if (entries.length > 0) return Promise.resolve({ done: false, value: entries.shift() as WatchEntry });
              if (closed) return Promise.resolve({ done: true, value: undefined });
              return new Promise((resolve) => {
                waiters.push(resolve);
              });
            },
            return: (): Promise<IteratorResult<WatchEntry>> => {
              close();
              return Promise.resolve({ done: true, value: undefined });
            },
          };
          return iterator;
        },
        stat: async (path: unknown, options?: BrowserStatOptions) => fsApi.statSync(path, options),
        lstat: async (path: unknown, options?: BrowserStatOptions) => {
          const stats = fsApi.lstatSync(path, options);
          if (stats === undefined && options?.throwIfNoEntry === false) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: 'ENOENT' });
          }
          return stats;
        },
        statfs: async (path: unknown, options?: { bigint?: boolean }) => fsApi.statfsSync(path, options),
        realpath: async (path: unknown, options?: string | { encoding?: string | null } | null) => fsApi.realpathSync(path, options),
        mkdir: async (path: unknown, options?: { recursive?: boolean }) => fsApi.mkdirSync(path, options),
        mkdtemp: async (prefix: unknown, options?: string | { encoding?: string | null } | null) => fsApi.mkdtempSync(prefix, options),
        rmdir: async (path: unknown) => {
          fsApi.rmdirSync(path);
        },
      };

  (fsApi.realpath as unknown as { native: typeof fsApi.realpath }).native = fsApi.realpath;

  (fsApi.realpathSync as unknown as { native: typeof fsApi.realpathSync }).native = fsApi.realpathSync;

  Object.assign(fsApi, { promises: fsPromisesApi });

  return fsPromisesApi;

}

export type BrowserFsPromisesApi = ReturnType<typeof createBrowserFsPromisesApi>;

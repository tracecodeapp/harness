import type {
  RuntimeKernelDevicePath,
} from "@tracecode/runtime-core";
import type {
  TraceKernelStat,
} from "@tracecode/tracekernel";
import {
  createRuntimeKernelReadonlyFileError,
  runtimeKernelCopyErrorCode,
  runtimeKernelCopyErrorMessage,
  runtimeKernelDeviceInputSource,
  runtimeKernelDeviceOutputTarget,
  runtimeKernelMetadataTarget,
  runtimeKernelOpenErrorCode,
  runtimeKernelOpenErrorMessage,
  type RuntimeKernelVirtualStat,
} from "@tracecode/runtime-core";
import {
  BrowserBuffer,
  bytesFromFsWriteValue,
  bytesToRuntimeFile,
  requestedEncodingFromOptions,
  textFromBytes,
  utf8Bytes,
} from "../internal/encoding";
import {
  inodeForPath,
} from "./filesystem-identity";
import {
  assertSafeWorkspaceFilePath,
  browserProcFileContents,
  normalizeWorkspaceEntryPath,
  runtimeAccessTarget,
  runtimeCopyTarget,
  runtimeMetadataTarget,
  runtimeOpenTarget,
  runtimeReadTarget,
  runtimeRemoveTarget,
  runtimeStatTarget,
  throwRuntimeMetadataTargetError,
  throwRuntimeRemoveTargetError,
} from "./workspace-paths";
import {
  workspaceFilename,
} from "../modules/resolution";
import {
  dirname,
} from "./path-normalization";
import {
  setStreamInternalCloseListeners,
} from "../node-compat/streams";
import type {
  BrowserJavaScriptProjectExecutionState,
  JavaScriptProjectCommandRequest,
} from '../browser/contracts';
import type {
  BrowserEntryMetadata,
  BrowserJavaScriptRequestState,
} from '../browser/request-state';

export type BrowserFsWatcher = {
      path: string;
      recursive: boolean;
      closed: boolean;
      kernelFd?: number;
      listeners: Map<string, Array<(...args: unknown[]) => void>>;
    };

export type BrowserFileStat = {
      atime: Date;
      atimeMs: number;
      birthtime: Date;
      birthtimeMs: number;
      blksize: number;
      blocks: number;
      ctime: Date;
      ctimeMs: number;
      dev: number;
      gid: number;
      ino: number;
      mode: number;
      mtime: Date;
      mtimeMs: number;
      nlink: number;
      rdev: number;
      size: number;
      uid: number;
      isBlockDevice: () => boolean;
      isCharacterDevice: () => boolean;
      isFIFO: () => boolean;
      isFile: () => boolean;
      isDirectory: () => boolean;
      isSocket: () => boolean;
      isSymbolicLink: () => boolean;
    };

export type BrowserFileStatResult = Omit<
      BrowserFileStat,
      'atimeMs' | 'birthtimeMs' | 'blksize' | 'blocks' | 'ctimeMs' | 'dev' | 'gid' | 'ino' | 'mode' | 'mtimeMs' | 'nlink' | 'rdev' | 'size' | 'uid'
    > & {
      atimeMs: number | bigint;
      birthtimeMs: number | bigint;
      blksize: number | bigint;
      blocks: number | bigint;
      ctimeMs: number | bigint;
      dev: number | bigint;
      gid: number | bigint;
      ino: number | bigint;
      mode: number | bigint;
      mtimeMs: number | bigint;
      nlink: number | bigint;
      rdev: number | bigint;
      size: number | bigint;
      uid: number | bigint;
    };

export type BrowserFileSystemStat = {
      type: number | bigint;
      bsize: number | bigint;
      blocks: number | bigint;
      bfree: number | bigint;
      bavail: number | bigint;
      files: number | bigint;
      ffree: number | bigint;
    };

export type BrowserStatOptions = {
      bigint?: boolean;
      throwIfNoEntry?: boolean;
    };

export type BrowserFileWatcher = {
      path: string;
      listener: (curr: BrowserFileStat, prev: BrowserFileStat) => void;
      previous: BrowserFileStat;
    };

export type BrowserFileDescriptor = {
      kind: 'file' | 'directory' | 'device' | 'proc' | 'kernel';
      path?: string;
      bytes?: Uint8Array;
      device?: RuntimeKernelDevicePath;
      kernelFd?: number;
      offset: number;
      readable: boolean;
      writable: boolean;
      append: boolean;
    };

export function createBrowserFileSystemState(
  requestState: BrowserJavaScriptRequestState,
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

  let fsApiBridge: {
    closeSync(fd: number): void;
    copyFileSync(source: unknown, destination: unknown): void;
    openSync(path: unknown, flags?: unknown): number;
  };

  const fsWatchers = new Set<BrowserFsWatcher>();

  const fsFileWatchers = new Set<BrowserFileWatcher>();

  const statForNormalizedPath = (normalized: string, followFinal = true): BrowserFileStat | null => {
        if (!followFinal && symlinkStore.has(normalized)) {
          const target = symlinkStore.get(normalized)!;
          const metadata = entryMetadata.get(normalized) ?? createEntryMetadata(0o120777);
          return {
            atimeMs: metadata.atimeMs,
            birthtimeMs: metadata.birthtimeMs,
            blksize: 4096,
            blocks: Math.ceil(utf8Bytes(target).byteLength / 512),
            ctimeMs: metadata.ctimeMs,
            dev: 1,
            gid: metadata.gid,
            ino: inodeForPath(normalized),
            mode: metadata.mode ?? 0o120777,
            mtimeMs: metadata.mtimeMs,
            nlink: 1,
            rdev: 0,
            size: utf8Bytes(target).byteLength,
            uid: metadata.uid,
            atime: new Date(metadata.atimeMs),
            birthtime: new Date(metadata.birthtimeMs),
            ctime: new Date(metadata.ctimeMs),
            mtime: new Date(metadata.mtimeMs),
            isBlockDevice: () => false,
            isCharacterDevice: () => false,
            isFIFO: () => false,
            isFile: () => false,
            isDirectory: () => false,
            isSocket: () => false,
            isSymbolicLink: () => true,
          };
        }
        const resolved = resolveStoredSymlinkPath(normalized, followFinal);
        const isFile = fileStore.has(resolved);
        const prefix = resolved ? `${resolved}/` : '';
        const isDirectory = !isFile && (
          directoryStore.has(resolved) ||
          Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix))
        );
        if (!isFile && !isDirectory) return null;
        const metadata = entryMetadata.get(resolved) ?? createEntryMetadata(isDirectory ? 0o40755 : 0o100644);
        const size = isFile ? fileStore.get(resolved)?.byteLength ?? 0 : 0;
        const mode = metadata.mode ?? (isDirectory ? 0o40755 : 0o100644);
        return {
          atimeMs: metadata.atimeMs,
          birthtimeMs: metadata.birthtimeMs,
          blksize: 4096,
          blocks: Math.ceil(size / 512),
          ctimeMs: metadata.ctimeMs,
          dev: 1,
          gid: metadata.gid,
          ino: isFile ? linkedInodeForPath(resolved) : inodeForPath(resolved),
          mode,
          mtimeMs: metadata.mtimeMs,
          nlink: isDirectory ? 2 : hardLinkGroupForPath(resolved).size,
          rdev: 0,
          size,
          uid: metadata.uid,
          atime: new Date(metadata.atimeMs),
          birthtime: new Date(metadata.birthtimeMs),
          ctime: new Date(metadata.ctimeMs),
          mtime: new Date(metadata.mtimeMs),
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isFIFO: () => false,
          isFile: () => isFile,
          isDirectory: () => isDirectory,
          isSocket: () => false,
          isSymbolicLink: () => false,
        };
      };

  const statForKernelPath = (path: string, kernelStat: RuntimeKernelVirtualStat): BrowserFileStat => {
        const modeType = kernelStat.isDirectory ? 0o40000 : kernelStat.isCharacterDevice ? 0o20000 : 0o100000;
        const mode = modeType | kernelStat.mode;
        return {
          atimeMs: requestState.fsTimestampMs,
          birthtimeMs: requestState.fsTimestampMs,
          blksize: 4096,
          blocks: Math.ceil(kernelStat.size / 512),
          ctimeMs: requestState.fsTimestampMs,
          dev: 1,
          gid: 0,
          ino: inodeForPath(path),
          mode,
          mtimeMs: requestState.fsTimestampMs,
          nlink: kernelStat.isDirectory ? 2 : 1,
          rdev: 0,
          size: kernelStat.size,
          uid: 0,
          atime: new Date(requestState.fsTimestampMs),
          birthtime: new Date(requestState.fsTimestampMs),
          ctime: new Date(requestState.fsTimestampMs),
          mtime: new Date(requestState.fsTimestampMs),
          isBlockDevice: () => false,
          isCharacterDevice: () => kernelStat.isCharacterDevice,
          isFIFO: () => false,
          isFile: () => kernelStat.isFile,
          isDirectory: () => kernelStat.isDirectory,
          isSocket: () => false,
          isSymbolicLink: () => false,
        };
      };

  const statForTraceKernelPath = (stat: TraceKernelStat): BrowserFileStat => {
        const directory = stat.kind === 'directory';
        const symbolicLink = stat.kind === 'symlink';
        const modeType = directory ? 0o40000 : symbolicLink ? 0o120000 : 0o100000;
        const mode = (stat.mode & 0o170000) === 0
          ? modeType | stat.mode
          : stat.mode;
        return {
          atimeMs: stat.modifiedAt,
          birthtimeMs: stat.createdAt,
          blksize: 4096,
          blocks: Math.ceil(stat.size / 512),
          ctimeMs: stat.changedAt,
          dev: 1,
          gid: 0,
          ino: stat.inode,
          mode,
          mtimeMs: stat.modifiedAt,
          nlink: stat.nlink,
          rdev: 0,
          size: stat.size,
          uid: 0,
          atime: new Date(stat.modifiedAt),
          birthtime: new Date(stat.createdAt),
          ctime: new Date(stat.changedAt),
          mtime: new Date(stat.modifiedAt),
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isFIFO: () => false,
          isFile: () => !directory && !symbolicLink,
          isDirectory: () => directory,
          isSocket: () => false,
          isSymbolicLink: () => symbolicLink,
        };
      };

  const statForKernelTarget = (path: unknown, options?: BrowserStatOptions): BrowserFileStat | null | undefined => {
        const statTarget = runtimeStatTarget(path, kernelInfo, kernelDevices, procSnapshot);
        if (!statTarget || statTarget.kind === 'workspace') return null;
        if (statTarget.kind === 'error') {
          if (options?.throwIfNoEntry === false) return undefined;
          throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: 'ENOENT' });
        }
        return statForKernelPath(statTarget.path, statTarget.stat);
      };

  const browserFileSystemStat = (bigint = false): BrowserFileSystemStat => {
        const blockSize = 4096;
        const capacityBytes = request.project.storage?.capacityBytes ?? 64 * 1024 * 1024;
        const capacityEntries = request.project.storage?.capacityEntries ?? 10_000;
        const visibleBytes = Array.from(fileStore.entries()).reduce(
          (total, [path, bytes]) => total + (virtualStorageEntries.has(path) ? 0 : bytes.byteLength),
          0
        ) + Array.from(symlinkStore.values()).reduce((total, target) => total + utf8Bytes(target).byteLength, 0);
        const visibleEntries = new Set([
          ...Array.from(fileStore.keys()).filter((path) => !virtualStorageEntries.has(path)),
          ...Array.from(symlinkStore.keys()),
          ...Array.from(directoryStore).filter((path) => path !== '' && !virtualStorageEntries.has(path)),
        ]).size;
        const usedBytes = Math.min(capacityBytes, unmodeledStorageBytes + visibleBytes);
        const usedEntries = Math.min(capacityEntries, unmodeledStorageEntries + visibleEntries);
        const blocks = Math.ceil(capacityBytes / blockSize);
        const usedBlocks = Math.ceil(usedBytes / blockSize);
        const stats = {
          type: 0x74726365,
          bsize: blockSize,
          blocks,
          bfree: Math.max(0, blocks - usedBlocks),
          bavail: Math.max(0, blocks - usedBlocks),
          files: capacityEntries,
          ffree: Math.max(0, capacityEntries - usedEntries),
        };
        if (!bigint) return stats;
        return Object.fromEntries(
          Object.entries(stats).map(([key, value]) => [key, BigInt(value)])
        ) as BrowserFileSystemStat;
      };

  const browserStatsResult = (stats: BrowserFileStat, options?: BrowserStatOptions): BrowserFileStatResult => {
        if (!options?.bigint) return stats;
        return {
          ...stats,
          atimeMs: BigInt(Math.trunc(stats.atimeMs)),
          birthtimeMs: BigInt(Math.trunc(stats.birthtimeMs)),
          blksize: BigInt(stats.blksize),
          blocks: BigInt(stats.blocks),
          ctimeMs: BigInt(Math.trunc(stats.ctimeMs)),
          dev: BigInt(stats.dev),
          gid: BigInt(stats.gid),
          ino: BigInt(stats.ino),
          mode: BigInt(stats.mode),
          mtimeMs: BigInt(Math.trunc(stats.mtimeMs)),
          nlink: BigInt(stats.nlink),
          rdev: BigInt(stats.rdev),
          size: BigInt(stats.size),
          uid: BigInt(stats.uid),
        };
      };

  const missingFileStat = (): BrowserFileStat => ({
        atime: new Date(0),
        atimeMs: 0,
        birthtime: new Date(0),
        birthtimeMs: 0,
        blksize: 4096,
        blocks: 0,
        ctime: new Date(0),
        ctimeMs: 0,
        dev: 1,
        gid: 0,
        ino: 0,
        mode: 0,
        mtime: new Date(0),
        mtimeMs: 0,
        nlink: 0,
        rdev: 0,
        size: 0,
        uid: 0,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isFile: () => false,
        isDirectory: () => false,
        isSocket: () => false,
        isSymbolicLink: () => false,
      });

  const watchedFilename = (watcher: BrowserFsWatcher, changedPath: string): string | null => {
        if (changedPath === watcher.path) return changedPath.split('/').pop() ?? changedPath;
        const prefix = watcher.path ? `${watcher.path}/` : '';
        if (!changedPath.startsWith(prefix)) return null;
        const relative = changedPath.slice(prefix.length);
        if (!watcher.recursive && relative.includes('/')) return null;
        return relative;
      };

  const emitFsWatch = (watcher: BrowserFsWatcher, eventType: 'change' | 'rename', filename: string): void => {
        if (watcher.closed) return;
        for (const listener of watcher.listeners.get('change') ?? []) listener(eventType, filename);
      };

  const notifyFsWatchers = (eventType: 'change' | 'rename', path: string): void => {
        for (const watcher of fsWatchers) {
          if (watcher.kernelFd !== undefined) continue;
          const filename = watchedFilename(watcher, path);
          if (filename !== null) queueMicrotask(() => emitFsWatch(watcher, eventType, filename));
        }
      };

  const notifyWatchFileWatchers = (path: string): void => {
        for (const watcher of fsFileWatchers) {
          if (watcher.path !== path) continue;
          const previous = watcher.previous;
          const current = statForNormalizedPath(path) ?? missingFileStat();
          watcher.previous = current;
          queueMicrotask(() => watcher.listener(current, previous));
        }
      };

  const notifyDirectoryMutation = (path: string): void => {
        notifyFsWatchers('rename', path);
        notifyWatchFileWatchers(path);
      };

  const emitDirectoryCreate = (path: string): void => {
        if (!path) return;
        const metadata = entryMetadata.get(path);
        io.fileChange({
          path,
          directory: true,
          ...(metadata?.mode !== undefined ? { mode: metadata.mode & 0o7777 } : {}),
          ...(metadata ? { atimeMs: metadata.atimeMs, mtimeMs: metadata.mtimeMs } : {}),
        }, 'live');
      };

  const emitDirectoryDelete = (path: string): void => {
        if (!path) return;
        io.fileChange({ path, directory: true, deleted: true }, 'live');
      };

  const assertReadonlyFilePath = (normalized: string, operation: string): void => {
        if (readonlyFiles.has(normalized) || isHiddenNamespacePath(normalized)) {
          throw createRuntimeKernelReadonlyFileError(normalized, operation);
        }
      };

  const setFileBytes = (path: string, bytes: Uint8Array, preservedMetadata?: BrowserEntryMetadata): void => {
        const linkedPaths = Array.from(hardLinkGroupForPath(path))
          .filter((linkedPath) => fileStore.has(linkedPath) || linkedPath === path);
        for (const linkedPath of linkedPaths) {
          assertReadonlyFilePath(linkedPath, 'write');
        }
        const parts = path.split('/');
        for (let index = 1; index < parts.length; index += 1) {
          const directoryPath = parts.slice(0, index).join('/');
          const existed = directoryStore.has(directoryPath);
          directoryStore.add(directoryPath);
          if (!entryMetadata.has(directoryPath)) touchEntryMetadata(directoryPath);
          if (!existed) emitDirectoryCreate(directoryPath);
        }
        let movedMetadata: BrowserEntryMetadata | undefined;
        if (preservedMetadata) {
          requestState.fsTimestampMs += 1;
          movedMetadata = { ...preservedMetadata, ctimeMs: requestState.fsTimestampMs };
        }
        for (const linkedPath of linkedPaths) {
          fileStore.set(linkedPath, bytes);
          if (movedMetadata) entryMetadata.set(linkedPath, { ...movedMetadata });
          else touchEntryMetadata(linkedPath);
          syncTextModule(linkedPath, bytes);
          cache.delete(linkedPath);
          io.fileChange(runtimeFileForPath(linkedPath, bytes), 'live');
          notifyFsWatchers('change', linkedPath);
          notifyWatchFileWatchers(linkedPath);
        }
      };

  const createEventTarget = () => {
        type EventListener = (...args: unknown[]) => void;
        type EventListenerWithOriginal = EventListener & { listener?: EventListener };
        const listeners = new Map<string, EventListener[]>();
        const listenerTarget = (listener: EventListener): EventListener => (
          (listener as EventListenerWithOriginal).listener ?? listener
        );
        const on = (event: string, listener: EventListener): void => {
          const next = listeners.get(event) ?? [];
          next.push(listener);
          listeners.set(event, next);
        };
        const prependListener = (event: string, listener: EventListener): void => {
          const next = listeners.get(event) ?? [];
          next.unshift(listener);
          listeners.set(event, next);
        };
        const removeListener = (event: string, listener: EventListener): void => {
          const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== listener && listenerTarget(candidate) !== listener);
          if (next.length === 0) listeners.delete(event);
          else listeners.set(event, next);
        };
        const once = (event: string, listener: EventListener, prepend = false): void => {
          const wrapped = (...args: unknown[]) => {
            removeListener(event, wrapped);
            listener(...args);
          };
          Object.defineProperty(wrapped, 'listener', { value: listener });
          if (prepend) prependListener(event, wrapped);
          else on(event, wrapped);
        };
        return {
          emit: (event: string, ...args: unknown[]) => {
            const current = listeners.get(event) ?? [];
            for (const listener of current) listener(...args);
            return current.length > 0;
          },
          on,
          addListener: on,
          prependListener,
          removeListener,
          off: removeListener,
          once: (event: string, listener: (...args: unknown[]) => void) => once(event, listener),
          prependOnceListener: (event: string, listener: (...args: unknown[]) => void) => once(event, listener, true),
          removeAllListeners: (event?: string) => {
            if (typeof event === 'string') listeners.delete(event);
            else listeners.clear();
          },
          listenerCount: (event: string) => listeners.get(event)?.length ?? 0,
          listeners: (event: string) => (listeners.get(event) ?? []).map(listenerTarget),
          rawListeners: (event: string) => [...(listeners.get(event) ?? [])],
          eventNames: () => [...listeners.keys()],
        };
      };

  const createReadableStream = (bytes: Uint8Array, encoding?: string, onClose?: () => void) => {
        const events = createEventTarget();
        type PipeDestination = {
          write?: (chunk: BrowserBuffer | string) => unknown;
          end?: () => unknown;
          emit?: (event: string, ...args: unknown[]) => unknown;
        };
        type PipeBinding = {
          destination: PipeDestination;
          onData: (chunk: unknown) => void;
          onEnd: () => void;
        };
        let started = false;
        let closed = false;
        let destroyed = false;
        let ended = false;
        let offset = 0;
        let streamEncoding = encoding;
        let readableFlowing: boolean | null = null;
        const pipeBindings: PipeBinding[] = [];
        const internalCloseListeners = new Set<() => void>();
        const closeStream = (): void => {
          if (closed) return;
          closed = true;
          onClose?.();
          for (const listener of internalCloseListeners) listener();
          internalCloseListeners.clear();
          events.emit('close');
        };
        const formatChunk = (chunk: Uint8Array): BrowserBuffer | string => {
          const buffer = BrowserBuffer.from(chunk);
          return streamEncoding ? buffer.toString(streamEncoding) : buffer;
        };
        const readChunk = (size?: number): BrowserBuffer | string | null => {
          if (destroyed || offset >= bytes.byteLength) {
            ended = offset >= bytes.byteLength;
            return null;
          }
          const requested = typeof size === 'number' && size >= 0 ? Math.floor(size) : bytes.byteLength - offset;
          const end = Math.min(bytes.byteLength, offset + requested);
          const chunk = bytes.slice(offset, end);
          offset = end;
          if (offset >= bytes.byteLength) ended = true;
          return formatChunk(chunk);
        };
        const scheduleRead = (): void => {
          if (started) return;
          if (readableFlowing === false) return;
          started = true;
          queueMicrotask(() => {
            if (closed || destroyed) return;
            if (readableFlowing === false) {
              started = false;
              return;
            }
            const chunk = readChunk();
            if (chunk !== null && (typeof chunk !== 'string' || chunk.length > 0) && (!(chunk instanceof Uint8Array) || chunk.byteLength > 0)) {
              events.emit('data', chunk);
            }
            events.emit('end');
            closeStream();
          });
        };
        const stream = {
          readable: true,
          get closed() {
            return closed;
          },
          get destroyed() {
            return destroyed;
          },
          get readableEnded() {
            return ended;
          },
          get readableEncoding() {
            return streamEncoding ?? null;
          },
          get readableLength() {
            return Math.max(0, bytes.byteLength - offset);
          },
          get readableFlowing() {
            return readableFlowing;
          },
          setEncoding: (nextEncoding: string) => {
            streamEncoding = nextEncoding;
            return stream;
          },
          read: (size?: number) => readChunk(size),
          on: (event: string, listener: (...args: unknown[]) => void) => {
            events.on(event, listener);
            if (event === 'data') {
              if (readableFlowing === null) readableFlowing = true;
              scheduleRead();
            } else if (event === 'end') {
              scheduleRead();
            }
            return stream;
          },
          addListener: (event: string, listener: (...args: unknown[]) => void) => {
            stream.on(event, listener);
            return stream;
          },
          prependListener: (event: string, listener: (...args: unknown[]) => void) => {
            events.prependListener(event, listener);
            if (event === 'data') {
              if (readableFlowing === null) readableFlowing = true;
              scheduleRead();
            } else if (event === 'end') {
              scheduleRead();
            }
            return stream;
          },
          removeListener: (event: string, listener: (...args: unknown[]) => void) => {
            events.removeListener(event, listener);
            return stream;
          },
          off: (event: string, listener: (...args: unknown[]) => void) => {
            events.off(event, listener);
            return stream;
          },
          emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
          once: (event: string, listener: (...args: unknown[]) => void) => {
            events.once(event, listener);
            if (event === 'data') {
              if (readableFlowing === null) readableFlowing = true;
              scheduleRead();
            } else if (event === 'end') {
              scheduleRead();
            }
            return stream;
          },
          prependOnceListener: (event: string, listener: (...args: unknown[]) => void) => {
            events.prependOnceListener(event, listener);
            if (event === 'data') {
              if (readableFlowing === null) readableFlowing = true;
              scheduleRead();
            } else if (event === 'end') {
              scheduleRead();
            }
            return stream;
          },
          removeAllListeners: (event?: string) => {
            events.removeAllListeners(event);
            return stream;
          },
          listenerCount: (event: string) => events.listenerCount(event),
          listeners: (event: string) => events.listeners(event),
          rawListeners: (event: string) => events.rawListeners(event),
          eventNames: () => events.eventNames(),
          pause: () => {
            readableFlowing = false;
            return stream;
          },
          resume: () => {
            readableFlowing = true;
            scheduleRead();
            return stream;
          },
          destroy: (error?: Error) => {
            if (destroyed) return stream;
            destroyed = true;
            if (error) events.emit('error', error);
            closeStream();
            return stream;
          },
          close: (callback?: () => void) => {
            if (callback) stream.once('close', callback);
            closeStream();
            return stream;
          },
          pipe: (destination: PipeDestination, options?: { end?: boolean }) => {
            const onData = (chunk: unknown) => destination.write?.(chunk as BrowserBuffer | string);
            const onEnd = () => {
              if (options?.end !== false) destination.end?.();
            };
            pipeBindings.push({ destination, onData, onEnd });
            events.on('data', onData);
            events.on('end', onEnd);
            destination.emit?.('pipe', stream);
            readableFlowing = true;
            scheduleRead();
            return destination;
          },
          unpipe: (destination?: PipeDestination) => {
            for (let index = pipeBindings.length - 1; index >= 0; index -= 1) {
              const binding = pipeBindings[index];
              if (!destination || binding.destination === destination) {
                events.removeListener('data', binding.onData);
                events.removeListener('end', binding.onEnd);
                binding.destination.emit?.('unpipe', stream);
                pipeBindings.splice(index, 1);
              }
            }
            return stream;
          },
        };
        setStreamInternalCloseListeners(stream, internalCloseListeners);
        return stream;
      };

  const createWritableStream = (
        path: unknown,
        options?: string | { autoClose?: boolean; encoding?: string | null; fd?: number; flags?: string; start?: number } | null
      ) => {
        const events = createEventTarget();
        const optionFd = typeof options === 'object' && typeof options?.fd === 'number' ? options.fd : null;
        const encoding = requestedEncodingFromOptions(options);
        const flags = typeof options === 'object' && typeof options?.flags === 'string' ? options.flags : 'w';
        const parsed = parseOpenFlags(flags);
        const openTarget = optionFd === null
            ? runtimeOpenTarget(path, {
                ...parsed,
                writable: parsed.writable,
                create: parsed.create,
                truncate: parsed.truncate,
            }, kernelDevices, procSnapshot)
          : null;
        if (openTarget?.kind === 'error') {
          throw Object.assign(new Error(runtimeKernelOpenErrorMessage(String(path), openTarget)), {
            code: runtimeKernelOpenErrorCode(openTarget.reason),
          });
        }
        const device = openTarget?.kind === 'device' ? openTarget.device : null;
        const autoClose = typeof options === 'object' && options?.autoClose === false ? false : true;
        if (
          executionState.kernelFileSystem &&
          optionFd === null &&
          (openTarget === null || openTarget?.kind === 'workspace')
        ) {
          const openedFd = fsApiBridge.openSync(path, flags);
          return createWritableStream(null, {
            ...(typeof options === 'object' && options ? options : {}),
            fd: openedFd,
            flags,
            autoClose,
          });
        }
        const rawNormalized = device || optionFd !== null
          ? null
          : assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
        const normalized = rawNormalized === null ? null : resolveStoredSymlinkPath(rawNormalized);
        if (normalized !== null) {
          assertWorkspaceFileWritePath(normalized, path, 'write');
          if (parsed.exclusive && rawNormalized !== null && (
            fileStore.has(rawNormalized) || symlinkStore.has(rawNormalized) || directoryStore.has(rawNormalized)
          )) {
            throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: 'EEXIST' });
          }
          if (!parsed.create && !fileStore.has(normalized)) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
          }
        }
        if (normalized !== null && parsed.truncate) {
          setFileBytes(normalized, new Uint8Array());
        }
        let closed = false;
        let destroyed = false;
        let bytesWritten = 0;
        let writableEnded = false;
        let writableFinished = false;
        let writableCorked = 0;
        let writeOffset = typeof options === 'object' && typeof options?.start === 'number'
          ? Math.max(0, options.start)
          : 0;
        const hasExplicitWriteStart = typeof options === 'object' && typeof options?.start === 'number';
        const internalCloseListeners = new Set<() => void>();
        const writeBytes = (value: unknown, writeEncoding?: string): number => {
          if (writableEnded) {
            throw Object.assign(new Error('ERR_STREAM_WRITE_AFTER_END: write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' });
          }
          if (closed || destroyed) {
            throw Object.assign(new Error('ERR_STREAM_DESTROYED: Cannot call write after a stream was destroyed'), { code: 'ERR_STREAM_DESTROYED' });
          }
          const bytes = bytesFromFsWriteValue(value, writeEncoding ?? encoding);
          if (optionFd !== null) {
            if (hasExplicitWriteStart) {
              writeDescriptorBytes(fileDescriptor(optionFd), bytes, writeOffset);
              writeOffset += bytes.byteLength;
            } else {
              writeDescriptorFileBytes(optionFd, bytes, flags.includes('a'));
            }
            bytesWritten += bytes.byteLength;
            return bytes.byteLength;
          }
          if (device) {
            writeDevice(device, textFromBytes(bytes));
            bytesWritten += bytes.byteLength;
            return bytes.byteLength;
          }
          if (!parsed.writable) {
            throw Object.assign(new Error('EBADF: bad file descriptor, write'), { code: 'EBADF' });
          }
          const previous = fileStore.get(normalized ?? '') ?? new Uint8Array();
          const start = parsed.append ? previous.byteLength : writeOffset;
          const next = new Uint8Array(Math.max(previous.byteLength, start + bytes.byteLength));
          next.set(previous, 0);
          next.set(bytes, start);
          setFileBytes(normalized ?? '', next);
          writeOffset = start + bytes.byteLength;
          bytesWritten += bytes.byteLength;
          return bytes.byteLength;
        };
        const closeStream = (emitFinish: boolean, done?: () => void, error?: Error): void => {
          if (closed) return;
          closed = true;
          queueMicrotask(() => {
            if (error) events.emit('error', error);
            done?.();
            if (autoClose && optionFd !== null) fsApiBridge.closeSync(optionFd);
            for (const listener of internalCloseListeners) listener();
            internalCloseListeners.clear();
            if (emitFinish) {
              writableFinished = true;
              events.emit('finish');
            }
            events.emit('close');
          });
        };
        const stream = {
          writable: true,
          get closed() {
            return closed;
          },
          get destroyed() {
            return destroyed;
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
          get writableLength() {
            return 0;
          },
          get writableNeedDrain() {
            return false;
          },
          get writableCorked() {
            return writableCorked;
          },
          on: (event: string, listener: (...args: unknown[]) => void) => {
            events.on(event, listener);
            return stream;
          },
          addListener: (event: string, listener: (...args: unknown[]) => void) => {
            stream.on(event, listener);
            return stream;
          },
          prependListener: (event: string, listener: (...args: unknown[]) => void) => {
            events.prependListener(event, listener);
            return stream;
          },
          removeListener: (event: string, listener: (...args: unknown[]) => void) => {
            events.removeListener(event, listener);
            return stream;
          },
          off: (event: string, listener: (...args: unknown[]) => void) => {
            events.off(event, listener);
            return stream;
          },
          emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
          once: (event: string, listener: (...args: unknown[]) => void) => {
            events.once(event, listener);
            return stream;
          },
          prependOnceListener: (event: string, listener: (...args: unknown[]) => void) => {
            events.prependOnceListener(event, listener);
            return stream;
          },
          removeAllListeners: (event?: string) => {
            events.removeAllListeners(event);
            return stream;
          },
          listenerCount: (event: string) => events.listenerCount(event),
          listeners: (event: string) => events.listeners(event),
          rawListeners: (event: string) => events.rawListeners(event),
          eventNames: () => events.eventNames(),
          cork: () => {
            writableCorked += 1;
          },
          uncork: () => {
            writableCorked = Math.max(0, writableCorked - 1);
          },
          write: (value: unknown, writeEncoding?: string | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
            const done = typeof writeEncoding === 'function' ? writeEncoding : callback;
            try {
              writeBytes(value, typeof writeEncoding === 'string' ? writeEncoding : undefined);
              done?.(null);
              return true;
            } catch (error) {
              const streamError = error as Error;
              done?.(streamError);
              events.emit('error', streamError);
              return false;
            }
          },
          end: (value?: unknown, writeEncoding?: string | (() => void), callback?: () => void) => {
            const done = typeof writeEncoding === 'function' ? writeEncoding : callback;
            if (value !== undefined && value !== null) {
              try {
                writeBytes(value, typeof writeEncoding === 'string' ? writeEncoding : undefined);
              } catch (error) {
                writableEnded = true;
                closeStream(false, undefined, error as Error);
                return stream;
              }
            }
            writableEnded = true;
            closeStream(true, done);
            return stream;
          },
          destroy: (error?: Error) => {
            if (destroyed) return stream;
            destroyed = true;
            closeStream(false, undefined, error);
            return stream;
          },
          close: (callback?: () => void) => {
            if (callback) stream.once('close', callback);
            closeStream(false);
            return stream;
          },
        };
        setStreamInternalCloseListeners(stream, internalCloseListeners);
        return stream;
      };

  const assertStreamRangeInteger = (name: 'start' | 'end', value: unknown): number | undefined => {
        if (value === undefined) return undefined;
        if (!Number.isInteger(value) || Number(value) < 0) {
          throw Object.assign(new RangeError(`The value of "${name}" is out of range.`), { code: 'ERR_OUT_OF_RANGE' });
        }
        return Number(value);
      };

  const deleteFile = (path: unknown): void => {
        const removeTarget = runtimeRemoveTarget(path, kernelDevices);
        if (removeTarget?.kind === 'error') {
          const message = removeTarget.reason === 'device-not-found'
            ? `ENOENT: no such file or directory, unlink '${path}'`
            : `EROFS: read-only file system, unlink '${path}'`;
          throwRuntimeRemoveTargetError(removeTarget, message);
        }
        const normalized = resolveWorkspaceEntryPath(path, false);
        if (executionState.kernelFileSystem) {
          executionState.kernelFileSystem.unlink(normalized);
          return;
        }
        assertReadonlyFilePath(normalized, 'delete');
        if (symlinkStore.delete(normalized)) {
          deleteEntryMetadata(normalized);
          io.fileChange({ path: normalized, deleted: true }, 'live');
          notifyFsWatchers('rename', normalized);
          notifyWatchFileWatchers(normalized);
          return;
        }
        if (!fileStore.delete(normalized)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, unlink '${path}'`), { code: 'ENOENT' });
        }
        detachOpenFileDescriptorsForPath(normalized);
        unlinkPathFromHardLinks(normalized);
        modules.delete(normalized);
        cache.delete(normalized);
        deleteEntryMetadata(normalized);
        io.fileChange({ path: normalized, deleted: true }, 'live');
        notifyFsWatchers('rename', normalized);
        notifyWatchFileWatchers(normalized);
      };

  const fsConstants = {
        F_OK: 0,
        R_OK: 4,
        W_OK: 2,
        X_OK: 1,
        O_RDONLY: 0,
        O_WRONLY: 1,
        O_RDWR: 2,
        O_CREAT: 0o100,
        O_EXCL: 0o200,
        O_TRUNC: 0o1000,
        O_APPEND: 0o2000,
        O_CLOEXEC: 0o2000000,
        S_IFMT: 0o170000,
        S_IFREG: 0o100000,
        S_IFDIR: 0o040000,
        S_IFLNK: 0o120000,
        COPYFILE_EXCL: 1,
        COPYFILE_FICLONE: 2,
        COPYFILE_FICLONE_FORCE: 4,
      } as const;

  let mkdtempCounter = 0;

  const fileSystemEntryExists = (path: unknown): boolean => {
        const accessTarget = runtimeAccessTarget(path, fsConstants.F_OK, kernelDevices, procSnapshot);
        if (accessTarget?.kind === 'allowed') return true;
        if (accessTarget?.kind === 'denied') return false;
        const readTarget = runtimeReadTarget(path, kernelDevices, procSnapshot);
        if (
          readTarget?.kind === 'device-file' ||
          readTarget?.kind === 'device-directory' ||
          readTarget?.kind === 'proc-file' ||
          readTarget?.kind === 'proc-directory'
        ) {
          return true;
        }
        if (readTarget?.kind === 'error') return false;
        const normalized = resolveWorkspaceEntryPath(path);
        if (executionState.kernelFileSystem) {
          try {
            executionState.kernelFileSystem.stat(normalized);
            return true;
          } catch {
            return false;
          }
        }
        const prefix = normalized ? `${normalized}/` : '';
        return fileStore.has(normalized)
          || directoryStore.has(normalized)
          || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix));
      };

  const isWorkspaceDirectoryPath = (normalized: string): boolean => {
        const prefix = normalized ? `${normalized}/` : '';
        return directoryStore.has(normalized) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix));
      };

  const workspaceFileAncestor = (normalized: string): string | null => {
        const parts = normalized.split('/');
        for (let index = 1; index < parts.length; index += 1) {
          const directoryPath = parts.slice(0, index).join('/');
          if (fileStore.has(directoryPath)) return directoryPath;
          if (symlinkStore.has(directoryPath)) {
            const resolved = resolveStoredSymlinkPath(directoryPath);
            if (fileStore.has(resolved)) return directoryPath;
          }
        }
        return null;
      };

  const assertWorkspaceParentDirectoryPath = (normalized: string, path: unknown, syscall: string): void => {
        if (workspaceFileAncestor(normalized) !== null) {
          throw Object.assign(new Error(`ENOTDIR: not a directory, ${syscall} '${path}'`), { code: 'ENOTDIR' });
        }
        const parent = dirname(normalized);
        const parentPath = parent === '' ? '' : resolveStoredSymlinkPath(parent);
        if (parentPath && !directoryStore.has(parentPath)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`), { code: 'ENOENT' });
        }
      };

  const assertWorkspaceFileWritePath = (normalized: string, path: unknown, operation: string, syscall = operation): void => {
        if (!normalized) {
          throw Object.assign(new Error(`EISDIR: illegal operation on a directory, ${syscall} '${path}'`), { code: 'EISDIR' });
        }
        assertReadonlyFilePath(normalized, operation);
        assertWorkspaceParentDirectoryPath(normalized, path, syscall);
        if (isWorkspaceDirectoryPath(normalized)) {
          throw Object.assign(new Error(`EISDIR: illegal operation on a directory, ${syscall} '${path}'`), { code: 'EISDIR' });
        }
      };

  const assertFileSystemAccess = (path: unknown, mode: number = fsConstants.F_OK): void => {
        const requested = Number(mode) || fsConstants.F_OK;
        const accessTarget = runtimeAccessTarget(path, requested, kernelDevices, procSnapshot);
        if (accessTarget?.kind === 'allowed') return;
        if (accessTarget?.kind === 'denied') {
          const code = accessTarget.reason === 'not-found' ? 'ENOENT' : 'EACCES';
          const reason = accessTarget.reason === 'not-found' ? 'no such file or directory' : 'permission denied';
          throw Object.assign(new Error(`${code}: ${reason}, access '${path}'`), { code });
        }
        const normalized = resolveWorkspaceEntryPath(path);
        let stats: BrowserFileStat | null;
        if (executionState.kernelFileSystem) {
          stats = statForTraceKernelPath(
            executionState.kernelFileSystem.stat(normalized)
          );
        } else {
          if (workspaceFileAncestor(normalized) !== null) {
            throw Object.assign(new Error(`ENOTDIR: not a directory, access '${path}'`), { code: 'ENOTDIR' });
          }
          stats = statForNormalizedPath(normalized);
        }
        if (!stats) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, access '${path}'`), { code: 'ENOENT' });
        }
        const permissionMode = stats.mode & 0o777;
        const readable = (permissionMode & 0o444) !== 0;
        const writable = (permissionMode & 0o222) !== 0;
        const executable = (permissionMode & 0o111) !== 0;
        if (
          ((requested & fsConstants.R_OK) !== 0 && !readable) ||
          ((requested & fsConstants.W_OK) !== 0 && !writable) ||
          ((requested & fsConstants.X_OK) !== 0 && !executable)
        ) {
          throw Object.assign(new Error(`EACCES: permission denied, access '${path}'`), { code: 'EACCES' });
        }
      };

  const notifyMetadataMutation = (path: string): void => {
        const bytes = fileStore.get(path);
        const metadata = entryMetadata.get(path);
        if (bytes && metadata) {
          io.fileChange({
            ...bytesToRuntimeFile(path, bytes),
            ...(metadata.mode !== undefined ? { mode: metadata.mode & 0o7777 } : {}),
            atimeMs: metadata.atimeMs,
            mtimeMs: metadata.mtimeMs,
          }, 'live');
        } else if (directoryStore.has(path) && metadata && path !== '') {
          io.fileChange({
            path,
            directory: true,
            ...(metadata.mode !== undefined ? { mode: metadata.mode & 0o7777 } : {}),
            atimeMs: metadata.atimeMs,
            mtimeMs: metadata.mtimeMs,
          }, 'live');
        }
        notifyFsWatchers('change', path);
        notifyWatchFileWatchers(path);
      };

  const metadataPathForEntry = (path: unknown): string | null => {
        const metadataTarget = runtimeMetadataTarget(path, kernelDevices);
        if (metadataTarget?.kind === 'ignored-device') return null;
        if (metadataTarget?.kind === 'error') {
          const message = metadataTarget.reason === 'proc-read-only'
            ? `EROFS: read-only file system, metadata '${path}'`
            : `ENOENT: no such file or directory, metadata '${path}'`;
          throwRuntimeMetadataTargetError(metadataTarget, message);
        }
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        if (executionState.kernelFileSystem) {
          return executionState.kernelFileSystem.realpath(normalized);
        }
        if (workspaceFileAncestor(normalized) !== null) {
          throw Object.assign(new Error(`ENOTDIR: not a directory, metadata '${path}'`), { code: 'ENOTDIR' });
        }
        if (!fileSystemEntryExists(workspaceFilename(normalized, workspaceRoot))) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: 'ENOENT' });
        }
        return normalized;
      };

  const timeToMs = (value: unknown): number => {
        if (value instanceof Date) return value.getTime();
        if (typeof value === 'number') return Math.max(0, value * 1000);
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.max(0, parsed * 1000) : requestState.fsTimestampMs;
      };

  const stdioDescriptor = (device: RuntimeKernelDevicePath, append = false): BrowserFileDescriptor => ({
        kind: 'device',
        device,
        offset: 0,
        readable: runtimeKernelDeviceInputSource(kernelDevices, device) !== null,
        writable: runtimeKernelDeviceOutputTarget(kernelDevices, device) !== null,
        append,
      });

  const fileDescriptors = new Map<number, BrowserFileDescriptor>([
        [0, stdioDescriptor('/dev/stdin')],
        [1, stdioDescriptor('/dev/stdout', true)],
        [2, stdioDescriptor('/dev/stderr', true)],
      ]);

  for (const inheritedFd of request.process?.descriptors ?? []) {
        const fd = Math.floor(Number(inheritedFd));
        if (!Number.isSafeInteger(fd) || fd < 3 || fileDescriptors.has(fd)) {
          continue;
        }
        fileDescriptors.set(fd, {
          kind: 'kernel',
          kernelFd: fd,
          offset: 0,
          // The descriptor table remains authoritative for access mode and
          // operation support. The compatibility map must not guess a narrower
          // capability and reject an inherited pipe/socket/file before syscall.
          readable: true,
          writable: true,
          append: false,
        });
      }

  let nextFd = 3;

  const workspaceFileDescriptorRecords = (): BrowserFileDescriptor[] =>
        [...fileDescriptors.values()].filter((entry) => entry.kind === 'file');

  const detachOpenFileDescriptorsForPath = (path: string): void => {
        const bytes = fileStore.get(path);
        for (const entry of workspaceFileDescriptorRecords()) {
          if (entry.path !== path) continue;
          entry.bytes = new Uint8Array(bytes ?? entry.bytes ?? new Uint8Array());
          entry.path = undefined;
        }
      };

  const moveOpenFileDescriptorPath = (oldPath: string, newPath: string): void => {
        for (const entry of workspaceFileDescriptorRecords()) {
          if (entry.path === oldPath) entry.path = newPath;
        }
      };

  const parseOpenFlags = (flags: unknown = 'r') => {
        if (typeof flags === 'number') {
          const access = flags & 3;
          const create = (flags & 0o100) !== 0;
          return {
            readable: access === 0 || access === 2,
            writable: access === 1 || access === 2,
            append: (flags & 0o2000) !== 0,
            truncate: (flags & 0o1000) !== 0,
            create,
            exclusive: create && (flags & 0o200) !== 0,
          };
        }
        const text = String(flags);
        const create = text.startsWith('w') || text.startsWith('a');
        return {
          readable: text.includes('+') || text.startsWith('r'),
          writable: text.includes('+') || create,
          append: text.startsWith('a'),
          truncate: text.startsWith('w'),
          create,
          exclusive: create && text.includes('x'),
        };
      };

  const fileDescriptor = (fd: number): BrowserFileDescriptor => {
        const entry = fileDescriptors.get(Number(fd));
        if (!entry) throw Object.assign(new Error(`EBADF: bad file descriptor, fd ${fd}`), { code: 'EBADF' });
        return entry;
      };

  const descriptorMetadataPath = (fd: number, operation: string): string | null => {
        const entry = fileDescriptor(fd);
        if (entry.kind === 'kernel') {
          throw Object.assign(
            new Error(`ENOSYS: ${operation} is not yet available for TraceKernel descriptors`),
            { code: 'ENOSYS' }
          );
        }
        if (entry.kind === 'file' && !entry.path) return null;
        const path = entry.kind === 'device' ? entry.device ?? '/dev/stdin' : entry.path ?? '';
        const metadataTarget = runtimeKernelMetadataTarget(path, kernelDevices);
        if (metadataTarget.kind === 'ignored-device') return null;
        if (metadataTarget.kind === 'error') {
          const message = metadataTarget.reason === 'proc-read-only'
            ? `EROFS: read-only file system, ${operation}`
            : `ENOENT: no such file or directory, ${operation}`;
          throwRuntimeMetadataTargetError(metadataTarget, message);
        }
        return path;
      };

  const descriptorBytes = (entry: BrowserFileDescriptor): Uint8Array => {
        if (entry.kind === 'kernel') {
          const kernelFs = executionState.kernelFileSystem!;
          const kernelFd = entry.kernelFd!;
          const size = kernelFs.fstat(kernelFd).size;
          const chunks: Uint8Array[] = [];
          let offset = 0;
          while (offset < size) {
            const chunk = kernelFs.read(kernelFd, Math.min(256 * 1024, size - offset), offset);
            if (chunk.byteLength === 0) break;
            chunks.push(chunk);
            offset += chunk.byteLength;
          }
          const bytes = new Uint8Array(offset);
          let cursor = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, cursor);
            cursor += chunk.byteLength;
          }
          return bytes;
        }
        if (entry.kind === 'device') return utf8Bytes(readDevice(entry.device ?? '/dev/stdin'));
        if (entry.kind === 'proc') return utf8Bytes(browserProcFileContents(procSnapshot, entry.path ?? '', kernelInfo));
        if (entry.kind === 'directory') {
          throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${entry.path ?? ''}'`), { code: 'EISDIR' });
        }
        if (entry.path && fileStore.has(entry.path)) return fileStore.get(entry.path) ?? new Uint8Array();
        return entry.bytes ?? new Uint8Array();
      };

  const readDescriptorFileBytes = (fd: number): Uint8Array => {
        const entry = fileDescriptor(fd);
        if (!entry.readable) throw Object.assign(new Error('EBADF: bad file descriptor, read'), { code: 'EBADF' });
        if (entry.kind === 'kernel') {
          const chunks: Uint8Array[] = [];
          let length = 0;
          while (true) {
            const chunk = executionState.kernelFileSystem!.read(entry.kernelFd!, 256 * 1024);
            if (chunk.byteLength === 0) break;
            chunks.push(chunk);
            length += chunk.byteLength;
          }
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return bytes;
        }
        if (entry.kind === 'device') return readDeviceBytes(entry.device ?? '/dev/stdin');
        const source = descriptorBytes(entry);
        const start = entry.offset;
        const bytes = source.slice(start);
        entry.offset = source.byteLength;
        return bytes;
      };

  const writeDescriptorBytes = (entry: BrowserFileDescriptor, bytes: Uint8Array, position?: number | null): void => {
        if (!entry.writable) throw Object.assign(new Error('EBADF: bad file descriptor, write'), { code: 'EBADF' });
        if (entry.kind === 'kernel') {
          executionState.kernelFileSystem!.write(
            entry.kernelFd!,
            bytes,
            typeof position === 'number' ? Math.max(0, position) : undefined
          );
          return;
        }
        if (entry.kind === 'device') {
          writeDevice(entry.device ?? '/dev/stdout', textFromBytes(bytes));
          return;
        }
        if (entry.kind === 'proc') {
          throw Object.assign(new Error(`EROFS: read-only file system, write '${entry.path ?? '/proc'}'`), { code: 'EROFS' });
        }
        const previous = descriptorBytes(entry);
        const start = entry.append ? previous.byteLength : typeof position === 'number' ? Math.max(0, position) : entry.offset;
        const next = new Uint8Array(Math.max(previous.byteLength, start + bytes.byteLength));
        next.set(previous, 0);
        next.set(bytes, start);
        entry.bytes = next;
        if (entry.path && fileStore.has(entry.path)) setFileBytes(entry.path, next);
        if (entry.append || position === undefined || position === null) entry.offset = start + bytes.byteLength;
      };

  const writeDescriptorFileBytes = (fd: number, bytes: Uint8Array, append = false): void => {
        const entry = fileDescriptor(fd);
        const position = append && entry.kind !== 'device' ? descriptorBytes(entry).byteLength : null;
        writeDescriptorBytes(entry, bytes, position);
        if (append && entry.kind !== 'device' && typeof position === 'number') entry.offset = position + bytes.byteLength;
      };

  const truncateFileBytes = (path: string, length = 0): void => {
        const previous = fileStore.get(path);
        if (!previous) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, truncate '${path}'`), { code: 'ENOENT' });
        }
        const size = Math.max(0, Number(length) || 0);
        const next = new Uint8Array(size);
        next.set(previous.slice(0, Math.min(previous.byteLength, size)));
        setFileBytes(path, next);
      };

  const truncateDescriptorBytes = (entry: BrowserFileDescriptor, length = 0): void => {
        if (entry.kind === 'kernel') {
          executionState.kernelFileSystem!.ftruncate(
            entry.kernelFd!,
            Math.max(0, Number(length) || 0)
          );
          return;
        }
        if (entry.kind !== 'file') {
          if (entry.kind === 'device') throw Object.assign(new Error('EINVAL: invalid argument, ftruncate'), { code: 'EINVAL' });
          throw Object.assign(new Error(`EROFS: read-only file system, ftruncate '${entry.path ?? ''}'`), { code: 'EROFS' });
        }
        const previous = descriptorBytes(entry);
        const size = Math.max(0, Number(length) || 0);
        const next = new Uint8Array(size);
        next.set(previous.slice(0, Math.min(previous.byteLength, size)));
        entry.bytes = next;
        if (entry.path && fileStore.has(entry.path)) setFileBytes(entry.path, next);
        if (entry.offset > size) entry.offset = size;
      };

  const realpathForEntry = (path: unknown): string => {
        const readTarget = runtimeReadTarget(path, kernelDevices, procSnapshot);
        if (
          executionState.kernelFileSystem &&
          readTarget?.kind === 'workspace'
        ) {
          const normalized = normalizeWorkspaceEntryPath(
            path,
            cwdPath,
            true,
            workspacePathContext
          );
          return executionState.kernelFileSystem.realpath(normalized);
        }
        const accessTarget = runtimeAccessTarget(path, 0, kernelDevices, procSnapshot);
        if (
          accessTarget?.kind === 'allowed' &&
          readTarget?.kind !== 'workspace'
        ) {
          return accessTarget.path;
        }
        if (accessTarget?.kind === 'denied') {
          throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: 'ENOENT' });
        }
        if (readTarget?.kind === 'device-file' || readTarget?.kind === 'proc-file' || readTarget?.kind === 'proc-directory') {
          return readTarget.path;
        }
        if (readTarget?.kind === 'device-directory') return readTarget.path;
        if (readTarget?.kind === 'error') {
          throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: 'ENOENT' });
        }
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        if (workspaceFileAncestor(normalized) !== null) {
          throw Object.assign(new Error(`ENOTDIR: not a directory, realpath '${path}'`), { code: 'ENOTDIR' });
        }
        if (!fileSystemEntryExists(workspaceFilename(normalized, workspaceRoot))) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: 'ENOENT' });
        }
        return workspaceFilename(normalized, workspaceRoot);
      };

  const copyEntrySync = (
        source: unknown,
        destination: unknown,
        options: { recursive?: boolean; force?: boolean; errorOnExist?: boolean; filter?: (source: string, destination: string) => boolean } = {}
      ): void => {
        const copyTarget = runtimeCopyTarget(source, destination, kernelDevices, procSnapshot);
        if (copyTarget?.kind === 'file-copy') {
          fsApiBridge.copyFileSync(source, destination);
          return;
        }
        if (copyTarget?.kind === 'error') {
          throw Object.assign(new Error(runtimeKernelCopyErrorMessage(String(source), String(destination), copyTarget)), {
            code: runtimeKernelCopyErrorCode(copyTarget.reason),
          });
        }

        const normalizedSource = resolveWorkspaceEntryPath(source, false);
        const normalizedDestination = resolveWorkspaceEntryPath(destination, false);
        const sourcePath = workspaceFilename(normalizedSource, workspaceRoot);
        const destinationPath = workspaceFilename(normalizedDestination, workspaceRoot);
        if (options.filter && !options.filter(sourcePath, destinationPath)) return;
        if (normalizedSource === normalizedDestination) {
          throw Object.assign(new Error(`${source} and dest cannot be the same ${destination}`), {
            code: 'ERR_FS_CP_EINVAL',
          });
        }

        const sourceLinkTarget = symlinkStore.get(normalizedSource);
        if (sourceLinkTarget !== undefined) {
          if (
            (fileStore.has(normalizedDestination) || symlinkStore.has(normalizedDestination) || directoryStore.has(normalizedDestination)) &&
            options.force === false
          ) {
            if (options.errorOnExist) {
              throw Object.assign(new Error(`EEXIST: file already exists, cp '${destination}'`), { code: 'EEXIST' });
            }
            return;
          }
          assertWorkspaceParentDirectoryPath(normalizedDestination, destination, 'cp');
          if (directoryStore.has(normalizedDestination)) {
            throw Object.assign(new Error(`Cannot overwrite directory ${destination} with non-directory ${source}`), {
              code: 'ERR_FS_CP_NON_DIR_TO_DIR',
            });
          }
          if (fileStore.has(normalizedDestination)) deleteFile(destination);
          if (symlinkStore.has(normalizedDestination)) deleteFile(destination);
          symlinkStore.set(normalizedDestination, sourceLinkTarget);
          entryMetadata.set(normalizedDestination, createEntryMetadata(0o120777));
          io.fileChange({ path: normalizedDestination, symlink: true, target: sourceLinkTarget }, 'live');
          notifyFsWatchers('rename', normalizedDestination);
          notifyWatchFileWatchers(normalizedDestination);
          return;
        }

        const sourceBytes = fileStore.get(normalizedSource);
        if (sourceBytes) {
          if (directoryStore.has(normalizedDestination)) {
            throw Object.assign(new Error(`Cannot overwrite directory ${destination} with non-directory ${source}`), {
              code: 'ERR_FS_CP_NON_DIR_TO_DIR',
            });
          }
          if (fileStore.has(normalizedDestination) && options.force === false) {
            if (options.errorOnExist) {
              throw Object.assign(new Error(`EEXIST: file already exists, cp '${destination}'`), { code: 'EEXIST' });
            }
            return;
          }
          setFileBytes(normalizedDestination, new Uint8Array(sourceBytes));
          return;
        }

        const destinationExists = fileStore.has(normalizedDestination) || directoryStore.has(normalizedDestination);
        if (destinationExists && options.force === false) {
          if (options.errorOnExist) {
            throw Object.assign(new Error(`EEXIST: file already exists, cp '${destination}'`), { code: 'EEXIST' });
          }
          return;
        }

        const sourcePrefix = normalizedSource ? `${normalizedSource}/` : '';
        const descendantFiles = Array.from(fileStore.entries()).filter(([filePath]) => filePath.startsWith(sourcePrefix));
        const descendantSymlinks = Array.from(symlinkStore.entries()).filter(([linkPath]) => linkPath.startsWith(sourcePrefix));
        const descendantDirectories = Array.from(directoryStore).filter((directoryPath) =>
          directoryPath === normalizedSource || directoryPath.startsWith(sourcePrefix)
        );
        if (!directoryStore.has(normalizedSource) && descendantFiles.length === 0 && descendantSymlinks.length === 0 && descendantDirectories.length === 0) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, cp '${source}' -> '${destination}'`), { code: 'ENOENT' });
        }
        if (!options.recursive) {
          throw Object.assign(new Error(`EISDIR: illegal operation on a directory, cp '${source}'`), { code: 'EISDIR' });
        }
        if (normalizedDestination.startsWith(`${normalizedSource}/`)) {
          throw Object.assign(new Error(`Cannot copy ${source}/ to a subdirectory of self ${destination}`), {
            code: 'ERR_FS_CP_EINVAL',
          });
        }
        if (fileStore.has(normalizedDestination)) {
          throw Object.assign(new Error(`Cannot overwrite non-directory ${destination} with directory ${source}`), {
            code: 'ERR_FS_CP_DIR_TO_NON_DIR',
          });
        }

        const destinationDirectoryExisted = directoryStore.has(normalizedDestination);
        directoryStore.add(normalizedDestination);
        if (!entryMetadata.has(normalizedDestination)) touchEntryMetadata(normalizedDestination);
        if (!destinationDirectoryExisted) emitDirectoryCreate(normalizedDestination);
        for (const directoryPath of descendantDirectories) {
          const relative = directoryPath === normalizedSource ? '' : directoryPath.slice(sourcePrefix.length);
          const nextDirectory = relative ? `${normalizedDestination}/${relative}` : normalizedDestination;
          if (options.filter && !options.filter(workspaceFilename(directoryPath, workspaceRoot), workspaceFilename(nextDirectory, workspaceRoot))) {
            continue;
          }
          const existed = directoryStore.has(nextDirectory);
          directoryStore.add(nextDirectory);
          if (!entryMetadata.has(nextDirectory)) touchEntryMetadata(nextDirectory);
          if (!existed) emitDirectoryCreate(nextDirectory);
        }
        for (const [filePath, bytes] of descendantFiles) {
          const relative = filePath.slice(sourcePrefix.length);
          const nextPath = normalizedDestination ? `${normalizedDestination}/${relative}` : relative;
          if (options.filter && !options.filter(workspaceFilename(filePath, workspaceRoot), workspaceFilename(nextPath, workspaceRoot))) {
            continue;
          }
          setFileBytes(nextPath, new Uint8Array(bytes));
        }
        for (const [linkPath, target] of descendantSymlinks) {
          const relative = linkPath.slice(sourcePrefix.length);
          const nextPath = normalizedDestination ? `${normalizedDestination}/${relative}` : relative;
          if (options.filter && !options.filter(workspaceFilename(linkPath, workspaceRoot), workspaceFilename(nextPath, workspaceRoot))) {
            continue;
          }
          symlinkStore.set(nextPath, target);
          entryMetadata.set(nextPath, createEntryMetadata(0o120777));
          io.fileChange({ path: nextPath, symlink: true, target }, 'live');
        }
      };

  return {
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
    attachFsApi(api: typeof fsApiBridge) { fsApiBridge = api; },
    get mkdtempCounter() { return mkdtempCounter; },
    set mkdtempCounter(value) { mkdtempCounter = value; },
    get nextFd() { return nextFd; },
    set nextFd(value) { nextFd = value; },
  };
}

export type BrowserFileSystemState = ReturnType<typeof createBrowserFileSystemState>;

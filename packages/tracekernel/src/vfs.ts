import * as Effect from 'effect/Effect';
import type {
  TraceKernelDescriptor,
  TraceKernelDescriptorOperationContext,
  TraceKernelSeekWhence,
} from './descriptors';
import type {
  TraceKernelFileSystemMutation,
  TraceKernelFileSystemMutationContext,
  TraceKernelFileSystemMutationOperation,
} from './watch';
import {
  TraceKernelFileSystemError,
  TraceKernelInvalidArgumentError,
  type TraceKernelFileSystemErrorCode,
} from './errors';

export type TraceKernelFileAccess = 'read' | 'write' | 'read-write';
export type TraceKernelNodeKind = 'file' | 'directory' | 'symlink';

export interface TraceKernelOpenFileOptions {
  readonly access?: TraceKernelFileAccess;
  readonly create?: boolean;
  readonly exclusive?: boolean;
  readonly truncate?: boolean;
  readonly append?: boolean;
}

export interface TraceKernelMkdirOptions {
  readonly recursive?: boolean;
  readonly mode?: number;
}

export interface TraceKernelFileSystemQuota {
  /** Absolute subtree whose descendants are counted. The root itself is free. */
  readonly root: string;
  readonly maxBytes: number;
  readonly maxFileBytes: number;
  readonly maxEntries: number;
}

export interface TraceKernelFileSystemOptions {
  readonly quota?: TraceKernelFileSystemQuota;
}

export interface TraceKernelFileSnapshot {
  readonly path: string;
  readonly contents: Uint8Array;
  readonly generation: number;
}

export const TRACEKERNEL_FILE_SYSTEM_IMAGE_SCHEMA =
  'tracekernel-tkfs-image-v1' as const;

interface TraceKernelFileSystemImageInodeBase {
  readonly inode: number;
  readonly kind: TraceKernelNodeKind;
  readonly mode: number;
  readonly generation: number;
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly changedAt: number;
}

export interface TraceKernelFileSystemImageFile
  extends TraceKernelFileSystemImageInodeBase {
  readonly kind: 'file';
  readonly contents: Uint8Array;
}

export interface TraceKernelFileSystemImageDirectory
  extends TraceKernelFileSystemImageInodeBase {
  readonly kind: 'directory';
}

export interface TraceKernelFileSystemImageSymlink
  extends TraceKernelFileSystemImageInodeBase {
  readonly kind: 'symlink';
  readonly target: string;
}

export type TraceKernelFileSystemImageInode =
  | TraceKernelFileSystemImageFile
  | TraceKernelFileSystemImageDirectory
  | TraceKernelFileSystemImageSymlink;

export interface TraceKernelFileSystemImageEntry {
  readonly path: string;
  readonly inode: number;
}

/**
 * A lossless, quiescent TKFS namespace image.
 *
 * Namespace entries and inode records are deliberately separate so hard links
 * survive persistence and hydration as shared kernel objects. Byte arrays are
 * defensively copied at both boundaries.
 */
export interface TraceKernelFileSystemImage {
  readonly schema: typeof TRACEKERNEL_FILE_SYSTEM_IMAGE_SCHEMA;
  readonly mutationGeneration: number;
  readonly entries: readonly TraceKernelFileSystemImageEntry[];
  readonly inodes: readonly TraceKernelFileSystemImageInode[];
}

export interface TraceKernelVersionedFile {
  readonly contents: Uint8Array;
  /**
   * Signed 32-bit session mutation token used by runtime read caches.
   *
   * This is deliberately distinct from the node's metadata generation. It
   * conservatively invalidates all runtime read caches after any TKFS mutation.
   */
  readonly cacheGeneration: number;
}

export interface TraceKernelStat {
  readonly path: string;
  readonly kind: TraceKernelNodeKind;
  readonly inode: number;
  readonly nlink: number;
  readonly mode: number;
  readonly size: number;
  readonly generation: number;
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly changedAt: number;
}

export interface TraceKernelDirectoryEntry {
  readonly name: string;
  readonly kind: TraceKernelNodeKind;
  readonly inode: number;
}

interface TraceKernelNodeBase {
  readonly kind: TraceKernelNodeKind;
  readonly inode: number;
  mode: number;
  generation: number;
  readonly createdAt: number;
  modifiedAt: number;
  changedAt: number;
}

interface TraceKernelFileNode extends TraceKernelNodeBase {
  readonly kind: 'file';
  contents: Uint8Array;
}

interface TraceKernelDirectoryNode extends TraceKernelNodeBase {
  readonly kind: 'directory';
}

interface TraceKernelSymlinkNode extends TraceKernelNodeBase {
  readonly kind: 'symlink';
  readonly target: string;
}

type TraceKernelNode =
  | TraceKernelFileNode
  | TraceKernelDirectoryNode
  | TraceKernelSymlinkNode;

class TraceKernelOpenFileNode {
  constructor(
    readonly openedPath: string,
    readonly node: TraceKernelFileNode
  ) {}
}

function normalizeTraceKernelPath(path: string, cwd: string): string {
  if (path.includes('\0')) {
    throw new TraceKernelFileSystemError({
      code: 'EINVAL',
      path,
      message: `EINVAL: invalid path ${JSON.stringify(path)}`,
    });
  }
  const source = path.startsWith('/') ? path : `${cwd}/${path}`;
  const parts: string[] = [];
  for (const part of source.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function parentPath(path: string): string {
  if (path === '/') return '/';
  const separator = path.lastIndexOf('/');
  return separator <= 0 ? '/' : path.slice(0, separator);
}

/**
 * TKFS: the authoritative, session-owned TraceKernel virtual filesystem.
 *
 * The namespace map owns path-to-inode bindings while open file descriptions
 * retain direct references to file nodes. Consequently rename, unlink, and
 * replacement are atomic namespace operations without redirecting descriptors
 * that were already open.
 *
 * The semaphore is the linearization point for every namespace and file-data
 * mutation. State remains explicit kernel data; Effect supplies scoped
 * concurrency and typed failure, rather than becoming the state model.
 */
export class TraceKernelFileSystem {
  private readonly nodes = new Map<string, TraceKernelNode>();
  private nextInode = 1;
  private nextGeneration = 1;
  private generationBuffer?: SharedArrayBuffer;
  private readonly mutationWatchers =
    new Set<(mutation: TraceKernelFileSystemMutation) => void>();

  private constructor(
    private readonly mutex: Effect.Semaphore,
    private readonly quota?: TraceKernelFileSystemQuota
  ) {
    if (quota) this.validateQuota(quota);
    this.installInitialDirectory('/');
    this.installInitialDirectory('/workspace');
  }

  static make(
    options: TraceKernelFileSystemOptions = {}
  ): Effect.Effect<TraceKernelFileSystem, TraceKernelFileSystemError> {
    return Effect.makeSemaphore(1).pipe(
      Effect.flatMap((mutex) => Effect.try({
        try: () => new TraceKernelFileSystem(mutex, options.quota),
        catch: (error) => error instanceof TraceKernelFileSystemError
          ? error
          : new TraceKernelFileSystemError({
              code: 'EINVAL',
              path: options.quota?.root ?? '/',
              message: error instanceof Error ? error.message : String(error),
            }),
      }))
    );
  }

  /**
   * Construct a new authoritative filesystem from one committed image.
   *
   * Hydration is a construction boundary, not a live merge operation: after
   * this succeeds, callers must send all mutations through the returned TKFS.
   */
  static fromImage(
    image: TraceKernelFileSystemImage,
    options: TraceKernelFileSystemOptions = {}
  ): Effect.Effect<TraceKernelFileSystem, TraceKernelFileSystemError> {
    return Effect.makeSemaphore(1).pipe(
      Effect.flatMap((mutex) =>
        Effect.try({
          try: () => {
            const fileSystem = new TraceKernelFileSystem(mutex, options.quota);
            fileSystem.restoreImage(image);
            return fileSystem;
          },
          catch: (error) =>
            error instanceof TraceKernelFileSystemError
              ? error
              : new TraceKernelFileSystemError({
                  code: 'EINVAL',
                  path: '/',
                  message: `EINVAL: invalid TKFS image: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                }),
        })
      )
    );
  }

  get mutationGeneration(): number {
    return this.nextGeneration - 1;
  }

  get cacheGeneration(): number {
    return this.mutationGeneration | 0;
  }

  /**
   * Lazily exposes the conservative session mutation token to isolated runtime
   * workers. Shared memory is an optimization signal only; TKFS remains the
   * source of truth and every cache miss still uses a syscall.
   */
  sharedGenerationBuffer(): SharedArrayBuffer | undefined {
    if (typeof SharedArrayBuffer === 'undefined') return undefined;
    if (!this.generationBuffer) {
      this.generationBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      Atomics.store(new Int32Array(this.generationBuffer), 0, this.cacheGeneration);
    }
    return this.generationBuffer;
  }

  watchMutations(
    listener: (mutation: TraceKernelFileSystemMutation) => void
  ): () => void {
    this.mutationWatchers.add(listener);
    return () => {
      this.mutationWatchers.delete(listener);
    };
  }

  resolve(path: string, cwd = '/workspace'): Effect.Effect<string, TraceKernelFileSystemError> {
    return Effect.try({
      try: () => normalizeTraceKernelPath(path, cwd),
      catch: (error) => error instanceof TraceKernelFileSystemError
        ? error
        : new TraceKernelFileSystemError({
            code: 'EINVAL',
            path,
            message: error instanceof Error ? error.message : String(error),
          }),
    });
  }

  stat(path: string, cwd = '/workspace'): Effect.Effect<TraceKernelStat, TraceKernelFileSystemError> {
    return this.resolve(path, cwd).pipe(
      Effect.flatMap((resolved) => this.mutex.withPermits(1)(
        Effect.suspend(() => {
          const realPath = this.resolveNodePath(resolved, true);
          if (realPath instanceof TraceKernelFileSystemError) return Effect.fail(realPath);
          const node = this.nodes.get(realPath);
          return node
            ? Effect.succeed(this.snapshotStat(realPath, node))
            : this.fail('ENOENT', realPath, 'no such file or directory');
        })
      ))
    );
  }

  lstat(path: string, cwd = '/workspace'): Effect.Effect<TraceKernelStat, TraceKernelFileSystemError> {
    return this.resolve(path, cwd).pipe(
      Effect.flatMap((resolved) => this.mutex.withPermits(1)(
        Effect.suspend(() => {
          const linkPath = this.resolveNodePath(resolved, false);
          if (linkPath instanceof TraceKernelFileSystemError) return Effect.fail(linkPath);
          const node = this.nodes.get(linkPath);
          return node
            ? Effect.succeed(this.snapshotStat(linkPath, node))
            : this.fail('ENOENT', linkPath, 'no such file or directory');
        })
      ))
    );
  }

  realpath(path: string, cwd = '/workspace'): Effect.Effect<string, TraceKernelFileSystemError> {
    return this.resolve(path, cwd).pipe(
      Effect.flatMap((resolved) => this.mutex.withPermits(1)(
        Effect.suspend(() => {
          const realPath = this.resolveNodePath(resolved, true);
          return realPath instanceof TraceKernelFileSystemError
            ? Effect.fail(realPath)
            : Effect.succeed(realPath);
        })
      ))
    );
  }

  readdir(
    path: string,
    cwd = '/workspace'
  ): Effect.Effect<readonly TraceKernelDirectoryEntry[], TraceKernelFileSystemError> {
    return this.resolve(path, cwd).pipe(
      Effect.flatMap((resolved) => this.mutex.withPermits(1)(
        Effect.suspend(() => {
          const realPath = this.resolveNodePath(resolved, true);
          if (realPath instanceof TraceKernelFileSystemError) return Effect.fail(realPath);
          const node = this.nodes.get(realPath);
          if (!node) return this.fail('ENOENT', realPath, 'no such directory');
          if (node.kind !== 'directory') {
            return this.fail('ENOTDIR', realPath, 'not a directory');
          }
          const prefix = realPath === '/' ? '/' : `${realPath}/`;
          const entries: TraceKernelDirectoryEntry[] = [];
          for (const [candidate, child] of this.nodes) {
            if (!candidate.startsWith(prefix)) continue;
            const remainder = candidate.slice(prefix.length);
            if (remainder.length === 0 || remainder.includes('/')) continue;
            entries.push(Object.freeze({
              name: remainder,
              kind: child.kind,
              inode: child.inode,
            }));
          }
          entries.sort((left, right) => left.name.localeCompare(right.name));
          return Effect.succeed(Object.freeze(entries));
        })
      ))
    );
  }

  /**
   * Return a point-in-turn namespace key snapshot for synchronous host APIs
   * such as shell glob discovery.
   *
   * TKFS mutations never await while editing the namespace map, so JavaScript
   * cannot observe a partially-applied rename or recursive construction here.
   */
  namespacePaths(): readonly string[] {
    return Object.freeze([...this.nodes.keys()].sort((left, right) => left.localeCompare(right)));
  }

  chmod(
    path: string,
    mode: number,
    cwd = '/workspace',
    mutationContext?: TraceKernelFileSystemMutationContext
  ): Effect.Effect<void, TraceKernelFileSystemError> {
    if (!Number.isSafeInteger(mode) || mode < 0) {
      return this.fail('EINVAL', path, 'invalid file mode');
    }
    return this.resolve(path, cwd).pipe(
      Effect.flatMap((resolved) => this.mutex.withPermits(1)(
        Effect.suspend(() => {
          const realPath = this.resolveNodePath(resolved, true);
          if (realPath instanceof TraceKernelFileSystemError) return Effect.fail(realPath);
          const node = this.nodes.get(realPath);
          if (!node) return this.fail('ENOENT', realPath, 'no such file or directory');
          const normalizedMode = mode & 0o7777;
          if (node.mode === normalizedMode) return Effect.void;
          node.mode = normalizedMode;
          const generation = this.beginMutation();
          this.touchNode(node, generation, Date.now(), false);
          this.notifyMutation(generation, 'change', 'chmod', this.pathsForNode(node), mutationContext);
          return Effect.void;
        })
      ))
    );
  }

  utimes(
    path: string,
    modifiedAt: number,
    cwd = '/workspace',
    mutationContext?: TraceKernelFileSystemMutationContext
  ): Effect.Effect<void, TraceKernelFileSystemError> {
    if (!Number.isFinite(modifiedAt) || modifiedAt < 0) {
      return this.fail('EINVAL', path, 'invalid modification timestamp');
    }
    return this.resolve(path, cwd).pipe(
      Effect.flatMap((resolved) => this.mutex.withPermits(1)(
        Effect.suspend(() => {
          const realPath = this.resolveNodePath(resolved, true);
          if (realPath instanceof TraceKernelFileSystemError) return Effect.fail(realPath);
          const node = this.nodes.get(realPath);
          if (!node) return this.fail('ENOENT', realPath, 'no such file or directory');
          const generation = this.beginMutation();
          node.generation = generation;
          node.modifiedAt = modifiedAt;
          node.changedAt = Date.now();
          this.notifyMutation(generation, 'change', 'utimes', this.pathsForNode(node), mutationContext);
          return Effect.void;
        })
      ))
    );
  }

  mkdir(
    path: string,
    options: TraceKernelMkdirOptions = {},
    cwd = '/workspace',
    mutationContext?: TraceKernelFileSystemMutationContext
  ): Effect.Effect<void, TraceKernelFileSystemError> {
    return this.resolve(path, cwd).pipe(
      Effect.flatMap((resolved) => this.mutex.withPermits(1)(
        Effect.suspend(() => {
          const directoryPath = this.resolveNodePath(resolved, false, options.recursive ? 'suffix' : 'final');
          if (directoryPath instanceof TraceKernelFileSystemError) return Effect.fail(directoryPath);
          const existing = this.nodes.get(directoryPath);
          if (existing) {
            if (options.recursive && existing.kind === 'directory') return Effect.void;
            return this.fail('EEXIST', directoryPath, 'file already exists');
          }
          if (directoryPath === '/') return Effect.void;

          const missing: string[] = [];
          let cursor = directoryPath;
          while (!this.nodes.has(cursor)) {
            missing.push(cursor);
            cursor = parentPath(cursor);
          }
          const ancestor = this.nodes.get(cursor)!;
          if (ancestor.kind !== 'directory') {
            return this.fail('ENOTDIR', cursor, 'path component is not a directory');
          }
          if (!options.recursive && missing.length > 1) {
            return this.fail('ENOENT', parentPath(directoryPath), 'parent directory does not exist');
          }

          const quotaError = this.additionalQuotaError(missing, 0);
          if (quotaError) return Effect.fail(quotaError);
          const generation = this.beginMutation();
          const timestamp = Date.now();
          for (const directoryPath of missing.reverse()) {
            this.nodes.set(directoryPath, this.makeDirectory(
              options.mode ?? 0o777,
              generation,
              timestamp
            ));
          }
          this.touchDirectory(cursor, generation, timestamp);
          this.notifyMutation(generation, 'rename', 'mkdir', missing, mutationContext);
          return Effect.void;
        })
      ))
    );
  }

  rmdir(
    path: string,
    cwd = '/workspace',
    mutationContext?: TraceKernelFileSystemMutationContext
  ): Effect.Effect<void, TraceKernelFileSystemError> {
    return this.resolve(path, cwd).pipe(
      Effect.flatMap((resolved) => this.mutex.withPermits(1)(
        Effect.suspend(() => {
          const directoryPath = this.resolveNodePath(resolved, false);
          if (directoryPath instanceof TraceKernelFileSystemError) return Effect.fail(directoryPath);
          if (directoryPath === '/') return this.fail('EBUSY', directoryPath, 'cannot remove root directory');
          const node = this.nodes.get(directoryPath);
          if (!node) return this.fail('ENOENT', directoryPath, 'no such directory');
          if (node.kind !== 'directory') return this.fail('ENOTDIR', directoryPath, 'not a directory');
          if (this.hasDescendants(directoryPath)) {
            return this.fail('ENOTEMPTY', directoryPath, 'directory not empty');
          }
          this.nodes.delete(directoryPath);
          const generation = this.beginMutation();
          this.touchDirectory(parentPath(directoryPath), generation, Date.now());
          this.notifyMutation(generation, 'rename', 'rmdir', [directoryPath], mutationContext);
          return Effect.void;
        })
      ))
    );
  }

  readFile(path: string, cwd = '/workspace'): Effect.Effect<Uint8Array, TraceKernelFileSystemError> {
    return this.readFileVersioned(path, cwd).pipe(
      Effect.map((file) => file.contents)
    );
  }

  readFileVersioned(
    path: string,
    cwd = '/workspace'
  ): Effect.Effect<TraceKernelVersionedFile, TraceKernelFileSystemError> {
    return this.resolve(path, cwd).pipe(
      Effect.flatMap((resolved) => this.mutex.withPermits(1)(
        Effect.suspend(() => {
          const filePath = this.resolveNodePath(resolved, true);
          if (filePath instanceof TraceKernelFileSystemError) return Effect.fail(filePath);
          const node = this.nodes.get(filePath);
          if (!node) return this.fail('ENOENT', filePath, 'no such file');
          return node.kind === 'file'
            ? Effect.succeed(Object.freeze({
                contents: Uint8Array.from(node.contents),
                cacheGeneration: this.cacheGeneration,
              }))
            : this.fail('EISDIR', filePath, 'is a directory');
        })
      ))
    );
  }

  writeFile(
    path: string,
    contents: Uint8Array,
    cwd = '/workspace',
    mutationContext?: TraceKernelFileSystemMutationContext
  ): Effect.Effect<void, TraceKernelFileSystemError> {
    return this.resolve(path, cwd).pipe(
      Effect.flatMap((resolved) => this.mutex.withPermits(1)(
        Effect.suspend(() => {
          const filePath = this.resolveNodePath(resolved, true, 'final');
          if (filePath instanceof TraceKernelFileSystemError) return Effect.fail(filePath);
          const existing = this.nodes.get(filePath);
          if (existing?.kind === 'directory') {
            return this.fail('EISDIR', filePath, 'is a directory');
          }
          if (existing?.kind === 'symlink') {
            return this.fail('ELOOP', filePath, 'unresolved symbolic link');
          }
          const parent = this.requireDirectory(parentPath(filePath));
          if (parent instanceof TraceKernelFileSystemError) return Effect.fail(parent);

          const quotaError = existing
            ? this.quotaResizeError(existing, contents.byteLength)
            : this.additionalQuotaError(
                [filePath],
                contents.byteLength,
                contents.byteLength
              );
          if (quotaError) return Effect.fail(quotaError);
          const generation = this.beginMutation();
          const timestamp = Date.now();
          if (existing) {
            existing.contents = Uint8Array.from(contents);
            this.touchNode(existing, generation, timestamp, true);
          } else {
            this.nodes.set(filePath, this.makeFile(
              Uint8Array.from(contents),
              0o666,
              generation,
              timestamp
            ));
            this.touchNode(parent, generation, timestamp, true);
          }
          this.notifyMutation(generation, existing ? 'change' : 'rename', 'write', [filePath], mutationContext);
          return Effect.void;
        })
      ))
    );
  }

  link(
    existingPath: string,
    newPath: string,
    cwd = '/workspace',
    mutationContext?: TraceKernelFileSystemMutationContext
  ): Effect.Effect<void, TraceKernelFileSystemError> {
    return Effect.all([
      this.resolve(existingPath, cwd),
      this.resolve(newPath, cwd),
    ]).pipe(
      Effect.flatMap(([unresolvedExisting, unresolvedNew]) => this.mutex.withPermits(1)(
        Effect.suspend(() => {
          const existingResult = this.resolveNodePath(unresolvedExisting, false);
          if (existingResult instanceof TraceKernelFileSystemError) {
            return Effect.fail(existingResult);
          }
          const newResult = this.resolveNodePath(unresolvedNew, false, 'final');
          if (newResult instanceof TraceKernelFileSystemError) return Effect.fail(newResult);
          const existing = this.nodes.get(existingResult);
          if (!existing) return this.fail('ENOENT', existingResult, 'no such file');
          if (existing.kind === 'directory') {
            return this.fail('EPERM', existingResult, 'hard links to directories are not permitted');
          }
          if (this.nodes.has(newResult)) {
            return this.fail('EEXIST', newResult, 'file already exists');
          }
          const parent = this.requireDirectory(parentPath(newResult));
          if (parent instanceof TraceKernelFileSystemError) return Effect.fail(parent);

          const quotaError = this.additionalQuotaError(
            [newResult],
            existing.kind === 'file'
              ? existing.contents.byteLength
              : new TextEncoder().encode(existing.target).byteLength,
            existing.kind === 'file' ? existing.contents.byteLength : undefined
          );
          if (quotaError) return Effect.fail(quotaError);
          this.nodes.set(newResult, existing);
          const generation = this.beginMutation();
          const timestamp = Date.now();
          this.touchNode(existing, generation, timestamp, false);
          this.touchNode(parent, generation, timestamp, true);
          this.notifyMutation(generation, 'rename', 'link', [newResult], mutationContext);
          return Effect.void;
        })
      ))
    );
  }

  symlink(
    target: string,
    linkPath: string,
    cwd = '/workspace',
    mutationContext?: TraceKernelFileSystemMutationContext
  ): Effect.Effect<void, TraceKernelFileSystemError> {
    return Effect.try({
      try: () => {
        if (target.includes('\0')) {
          throw this.error('EINVAL', target, 'invalid symbolic link target');
        }
        return target;
      },
      catch: (error) => error instanceof TraceKernelFileSystemError
        ? error
        : this.error('EINVAL', target, 'invalid symbolic link target'),
    }).pipe(
      Effect.zipRight(this.resolve(linkPath, cwd)),
      Effect.flatMap((unresolvedLink) => this.mutex.withPermits(1)(
        Effect.suspend(() => {
          const linkResult = this.resolveNodePath(unresolvedLink, false, 'final');
          if (linkResult instanceof TraceKernelFileSystemError) return Effect.fail(linkResult);
          if (this.nodes.has(linkResult)) {
            return this.fail('EEXIST', linkResult, 'file already exists');
          }
          const parent = this.requireDirectory(parentPath(linkResult));
          if (parent instanceof TraceKernelFileSystemError) return Effect.fail(parent);

          const quotaError = this.additionalQuotaError(
            [linkResult],
            new TextEncoder().encode(target).byteLength
          );
          if (quotaError) return Effect.fail(quotaError);
          const generation = this.beginMutation();
          const timestamp = Date.now();
          this.nodes.set(linkResult, this.makeSymlink(target, generation, timestamp));
          this.touchNode(parent, generation, timestamp, true);
          this.notifyMutation(generation, 'rename', 'symlink', [linkResult], mutationContext);
          return Effect.void;
        })
      ))
    );
  }

  readlink(path: string, cwd = '/workspace'): Effect.Effect<string, TraceKernelFileSystemError> {
    return this.resolve(path, cwd).pipe(
      Effect.flatMap((resolved) => this.mutex.withPermits(1)(
        Effect.suspend(() => {
          const linkPath = this.resolveNodePath(resolved, false);
          if (linkPath instanceof TraceKernelFileSystemError) return Effect.fail(linkPath);
          const node = this.nodes.get(linkPath);
          if (!node) return this.fail('ENOENT', linkPath, 'no such file');
          return node.kind === 'symlink'
            ? Effect.succeed(node.target)
            : this.fail('EINVAL', linkPath, 'not a symbolic link');
        })
      ))
    );
  }

  unlink(
    path: string,
    cwd = '/workspace',
    mutationContext?: TraceKernelFileSystemMutationContext
  ): Effect.Effect<void, TraceKernelFileSystemError> {
    return this.resolve(path, cwd).pipe(
      Effect.flatMap((resolved) => this.mutex.withPermits(1)(
        Effect.suspend(() => {
          const entryPath = this.resolveNodePath(resolved, false);
          if (entryPath instanceof TraceKernelFileSystemError) return Effect.fail(entryPath);
          const node = this.nodes.get(entryPath);
          if (!node) return this.fail('ENOENT', entryPath, 'no such file');
          if (node.kind === 'directory') return this.fail('EISDIR', entryPath, 'is a directory');
          this.nodes.delete(entryPath);
          const generation = this.beginMutation();
          this.touchDirectory(parentPath(entryPath), generation, Date.now());
          this.notifyMutation(generation, 'rename', 'unlink', [entryPath], mutationContext);
          return Effect.void;
        })
      ))
    );
  }

  rename(
    sourcePath: string,
    destinationPath: string,
    cwd = '/workspace',
    mutationContext?: TraceKernelFileSystemMutationContext
  ): Effect.Effect<void, TraceKernelFileSystemError> {
    return Effect.all([
      this.resolve(sourcePath, cwd),
      this.resolve(destinationPath, cwd),
    ]).pipe(
      Effect.flatMap(([unresolvedSource, unresolvedDestination]) => this.mutex.withPermits(1)(
        Effect.suspend(() => {
          const sourceResult = this.resolveNodePath(unresolvedSource, false);
          if (sourceResult instanceof TraceKernelFileSystemError) return Effect.fail(sourceResult);
          const destinationResult = this.resolveNodePath(unresolvedDestination, false, 'final');
          if (destinationResult instanceof TraceKernelFileSystemError) {
            return Effect.fail(destinationResult);
          }
          const source = sourceResult;
          const destination = destinationResult;
          if (source === destination) {
            return this.nodes.has(source)
              ? Effect.void
              : this.fail('ENOENT', source, 'no such file or directory');
          }
          if (source === '/' || destination === '/') {
            return this.fail('EBUSY', source, 'cannot rename the root directory');
          }

          const sourceNode = this.nodes.get(source);
          if (!sourceNode) {
            return this.fail('ENOENT', source, 'no such file or directory');
          }
          if (
            sourceNode.kind === 'directory' &&
            destination.startsWith(`${source}/`)
          ) {
            return this.fail('EINVAL', destination, 'cannot move a directory into itself');
          }

          const destinationParent = this.requireDirectory(parentPath(destination));
          if (destinationParent instanceof TraceKernelFileSystemError) {
            return Effect.fail(destinationParent);
          }
          const destinationNode = this.nodes.get(destination);
          if (destinationNode === sourceNode) return Effect.void;
          if (destinationNode) {
            if (sourceNode.kind !== 'directory' && destinationNode.kind === 'directory') {
              return this.fail('EISDIR', destination, 'destination is a directory');
            }
            if (sourceNode.kind === 'directory' && destinationNode.kind !== 'directory') {
              return this.fail('ENOTDIR', destination, 'destination is not a directory');
            }
            if (destinationNode.kind === 'directory' && this.hasDescendants(destination)) {
              return this.fail('ENOTEMPTY', destination, 'destination directory not empty');
            }
          }

          const movedEntries = [...this.nodes.entries()]
            .filter(([path]) => path === source || path.startsWith(`${source}/`));
          const projected = new Map(this.nodes);
          if (destinationNode) projected.delete(destination);
          for (const [path] of movedEntries) projected.delete(path);
          for (const [path, node] of movedEntries) {
            projected.set(`${destination}${path.slice(source.length)}`, node);
          }
          const quotaError = this.quotaNamespaceError(projected);
          if (quotaError) return Effect.fail(quotaError);
          if (destinationNode) this.nodes.delete(destination);
          for (const [path] of movedEntries) this.nodes.delete(path);
          for (const [path, node] of movedEntries) {
            const suffix = path.slice(source.length);
            this.nodes.set(`${destination}${suffix}`, node);
          }

          const generation = this.beginMutation();
          const timestamp = Date.now();
          this.touchNode(sourceNode, generation, timestamp, false);
          this.touchDirectory(parentPath(source), generation, timestamp);
          this.touchNode(destinationParent, generation, timestamp, true);
          this.notifyMutation(generation, 'rename', 'rename', [source, destination], mutationContext);
          return Effect.void;
        })
      ))
    );
  }

  prepareOpen(
    path: string,
    cwd: string,
    options: TraceKernelOpenFileOptions,
    mutationContext?: TraceKernelFileSystemMutationContext
  ): Effect.Effect<TraceKernelOpenFileNode, TraceKernelFileSystemError> {
    const access = options.access ?? 'read';
    return this.resolve(path, cwd).pipe(
      Effect.flatMap((resolved) => this.mutex.withPermits(1)(
        Effect.suspend(() => {
          if (options.create && options.exclusive) {
            const entryPath = this.resolveNodePath(resolved, false, 'final');
            if (entryPath instanceof TraceKernelFileSystemError) return Effect.fail(entryPath);
            if (this.nodes.has(entryPath)) {
              return this.fail('EEXIST', entryPath, 'file already exists');
            }
          }
          const filePath = this.resolveNodePath(resolved, true, options.create ? 'final' : 'none');
          if (filePath instanceof TraceKernelFileSystemError) return Effect.fail(filePath);
          const existing = this.nodes.get(filePath);
          if (!existing) {
            if (!options.create) return this.fail('ENOENT', filePath, 'no such file');
            if (access === 'read') {
              return this.fail('EACCES', filePath, 'read-only open cannot create file');
            }
            const parent = this.requireDirectory(parentPath(filePath));
            if (parent instanceof TraceKernelFileSystemError) return Effect.fail(parent);
            const quotaError = this.additionalQuotaError([filePath], 0, 0);
            if (quotaError) return Effect.fail(quotaError);
            const generation = this.beginMutation();
            const timestamp = Date.now();
            const file = this.makeFile(new Uint8Array(0), 0o666, generation, timestamp);
            this.nodes.set(filePath, file);
            this.touchNode(parent, generation, timestamp, true);
            this.notifyMutation(generation, 'rename', 'open-create', [filePath], mutationContext);
            return Effect.succeed(new TraceKernelOpenFileNode(filePath, file));
          }
          if (existing.kind === 'directory') {
            return this.fail('EISDIR', filePath, 'is a directory');
          }
          if (existing.kind === 'symlink') {
            return this.fail('ELOOP', filePath, 'unresolved symbolic link');
          }
          if (options.create && options.exclusive) {
            return this.fail('EEXIST', filePath, 'file already exists');
          }
          if (options.truncate) {
            if (access === 'read') {
              return this.fail('EACCES', resolved, 'read-only descriptor cannot truncate file');
            }
            const quotaError = this.quotaResizeError(existing, 0);
            if (quotaError) return Effect.fail(quotaError);
            existing.contents = new Uint8Array(0);
            const generation = this.beginMutation();
            this.touchNode(existing, generation, Date.now(), true);
            this.notifyMutation(generation, 'change', 'open-truncate', this.pathsForNode(existing), mutationContext);
          }
          return Effect.succeed(new TraceKernelOpenFileNode(filePath, existing));
        })
      ))
    );
  }

  readAt(
    file: TraceKernelOpenFileNode,
    offset: number,
    maxBytes: number
  ): Effect.Effect<Uint8Array, TraceKernelFileSystemError> {
    return this.mutex.withPermits(1)(
      Effect.sync(() => file.node.contents.slice(offset, offset + maxBytes))
    );
  }

  statOpen(file: TraceKernelOpenFileNode): Effect.Effect<TraceKernelStat> {
    return this.mutex.withPermits(1)(
      Effect.sync(() => this.snapshotStat(file.openedPath, file.node))
    );
  }

  truncateOpen(
    file: TraceKernelOpenFileNode,
    length: number,
    mutationContext?: TraceKernelFileSystemMutationContext
  ): Effect.Effect<void, TraceKernelFileSystemError> {
    return this.mutex.withPermits(1)(
      Effect.suspend(() => {
        const nextLength = Math.max(0, Math.floor(length));
        if (file.node.contents.byteLength === nextLength) return Effect.void;
        const quotaError = this.quotaResizeError(file.node, nextLength);
        if (quotaError) return Effect.fail(quotaError);
        const next = new Uint8Array(nextLength);
        next.set(file.node.contents.slice(0, nextLength));
        file.node.contents = next;
        const generation = this.beginMutation();
        this.touchNode(file.node, generation, Date.now(), true);
        this.notifyMutation(generation, 'change', 'truncate', this.pathsForNode(file.node), mutationContext);
        return Effect.void;
      })
    );
  }

  writeAt(
    file: TraceKernelOpenFileNode,
    offset: number,
    bytes: Uint8Array,
    append: boolean,
    mutationContext?: TraceKernelFileSystemMutationContext
  ): Effect.Effect<number, TraceKernelFileSystemError> {
    return this.mutex.withPermits(1)(
      Effect.suspend(() => {
        const node = file.node;
        const writeOffset = append ? node.contents.byteLength : offset;
        const nextLength = Math.max(node.contents.byteLength, writeOffset + bytes.byteLength);
        const quotaError = this.quotaResizeError(node, nextLength);
        if (quotaError) return Effect.fail(quotaError);
        const next = new Uint8Array(nextLength);
        next.set(node.contents);
        next.set(bytes, writeOffset);
        node.contents = next;
        if (bytes.byteLength > 0) {
          const generation = this.beginMutation();
          this.touchNode(node, generation, Date.now(), true);
          this.notifyMutation(generation, 'change', 'write', this.pathsForNode(node), mutationContext);
        }
        return Effect.succeed(writeOffset + bytes.byteLength);
      })
    );
  }

  snapshots(): readonly TraceKernelFileSnapshot[] {
    return [...this.nodes.entries()]
      .filter((entry): entry is [string, TraceKernelFileNode] => entry[1].kind === 'file')
      .map(([path, node]) => Object.freeze({
        path,
        contents: Uint8Array.from(node.contents),
        generation: node.generation,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  /**
   * Capture namespace and inode state at the same semaphore linearization point
   * used by syscalls. The returned image does not share mutable bytes with TKFS.
   */
  exportImage(): Effect.Effect<TraceKernelFileSystemImage> {
    return this.mutex.withPermits(1)(
      Effect.sync(() => {
        const inodeNodes = new Map<number, TraceKernelNode>();
        const entries = [...this.nodes.entries()]
          .map(([path, node]) => {
            inodeNodes.set(node.inode, node);
            return Object.freeze({ path, inode: node.inode });
          })
          .sort((left, right) => left.path.localeCompare(right.path));
        const inodes = [...inodeNodes.values()]
          .sort((left, right) => left.inode - right.inode)
          .map((node): TraceKernelFileSystemImageInode => {
            const metadata = {
              inode: node.inode,
              mode: node.mode,
              generation: node.generation,
              createdAt: node.createdAt,
              modifiedAt: node.modifiedAt,
              changedAt: node.changedAt,
            };
            if (node.kind === 'file') {
              return Object.freeze({
                ...metadata,
                kind: 'file',
                contents: Uint8Array.from(node.contents),
              });
            }
            if (node.kind === 'symlink') {
              return Object.freeze({
                ...metadata,
                kind: 'symlink',
                target: node.target,
              });
            }
            return Object.freeze({ ...metadata, kind: 'directory' });
          });
        return Object.freeze({
          schema: TRACEKERNEL_FILE_SYSTEM_IMAGE_SCHEMA,
          mutationGeneration: this.mutationGeneration,
          entries: Object.freeze(entries),
          inodes: Object.freeze(inodes),
        });
      })
    );
  }

  clear(mutationContext?: TraceKernelFileSystemMutationContext): void {
    if (this.nodes.size > 0) {
      const paths = [...this.nodes.keys()];
      const generation = this.beginMutation();
      this.nodes.clear();
      this.notifyMutation(generation, 'rename', 'clear', paths, mutationContext);
      return;
    }
    this.nodes.clear();
  }

  private installInitialDirectory(path: string): void {
    this.nodes.set(path, this.makeDirectory(0o777, 0, Date.now()));
  }

  private restoreImage(image: TraceKernelFileSystemImage): void {
    if (image?.schema !== TRACEKERNEL_FILE_SYSTEM_IMAGE_SCHEMA) {
      throw this.error('EINVAL', '/', 'unsupported TKFS image schema');
    }
    if (
      !Number.isSafeInteger(image.mutationGeneration) ||
      image.mutationGeneration < 0 ||
      !Array.isArray(image.entries) ||
      !Array.isArray(image.inodes)
    ) {
      throw this.error('EINVAL', '/', 'malformed TKFS image');
    }

    const restoredInodes = new Map<number, TraceKernelNode>();
    let maximumInode = 0;
    let maximumGeneration = 0;
    for (const inode of image.inodes) {
      if (
        !Number.isSafeInteger(inode.inode) ||
        inode.inode <= 0 ||
        restoredInodes.has(inode.inode) ||
        !Number.isSafeInteger(inode.mode) ||
        inode.mode < 0 ||
        !Number.isSafeInteger(inode.generation) ||
        inode.generation < 0 ||
        !this.validImageTimestamp(inode.createdAt) ||
        !this.validImageTimestamp(inode.modifiedAt) ||
        !this.validImageTimestamp(inode.changedAt)
      ) {
        throw this.error('EINVAL', '/', 'invalid TKFS inode record');
      }
      const base = {
        inode: inode.inode,
        mode: inode.mode,
        generation: inode.generation,
        createdAt: inode.createdAt,
        modifiedAt: inode.modifiedAt,
        changedAt: inode.changedAt,
      };
      let node: TraceKernelNode;
      if (inode.kind === 'file') {
        if (!(inode.contents instanceof Uint8Array)) {
          throw this.error('EINVAL', '/', 'invalid TKFS file contents');
        }
        node = {
          ...base,
          kind: 'file',
          contents: Uint8Array.from(inode.contents),
        };
      } else if (inode.kind === 'directory') {
        node = { ...base, kind: 'directory' };
      } else if (inode.kind === 'symlink' && typeof inode.target === 'string') {
        node = { ...base, kind: 'symlink', target: inode.target };
      } else {
        throw this.error('EINVAL', '/', 'invalid TKFS inode kind');
      }
      restoredInodes.set(inode.inode, node);
      maximumInode = Math.max(maximumInode, inode.inode);
      maximumGeneration = Math.max(maximumGeneration, inode.generation);
    }

    const restoredNodes = new Map<string, TraceKernelNode>();
    const referencedInodes = new Set<number>();
    for (const entry of image.entries) {
      if (
        typeof entry.path !== 'string' ||
        !entry.path.startsWith('/') ||
        normalizeTraceKernelPath(entry.path, '/') !== entry.path ||
        restoredNodes.has(entry.path)
      ) {
        throw this.error('EINVAL', '/', 'invalid TKFS namespace entry');
      }
      const node = restoredInodes.get(entry.inode);
      if (!node) {
        throw this.error('EINVAL', entry.path, 'TKFS entry references a missing inode');
      }
      if (
        node.kind === 'directory' &&
        [...restoredNodes.values()].some((candidate) => candidate === node)
      ) {
        throw this.error('EINVAL', entry.path, 'TKFS directories cannot have hard links');
      }
      restoredNodes.set(entry.path, node);
      referencedInodes.add(entry.inode);
    }

    const root = restoredNodes.get('/');
    if (!root || root.kind !== 'directory') {
      throw this.error('EINVAL', '/', 'TKFS image requires a root directory');
    }
    for (const [path] of restoredNodes) {
      if (path === '/') continue;
      const parent = restoredNodes.get(parentPath(path));
      if (!parent || parent.kind !== 'directory') {
        throw this.error('EINVAL', path, 'TKFS entry has no directory parent');
      }
    }
    if (referencedInodes.size !== restoredInodes.size) {
      throw this.error('EINVAL', '/', 'TKFS image contains an unreferenced inode');
    }
    if (image.mutationGeneration < maximumGeneration) {
      throw this.error('EINVAL', '/', 'TKFS mutation generation precedes inode state');
    }

    this.nodes.clear();
    for (const [path, node] of restoredNodes) this.nodes.set(path, node);
    this.nextInode = maximumInode + 1;
    this.nextGeneration = image.mutationGeneration + 1;
    const quotaError = this.quotaNamespaceError(this.nodes);
    if (quotaError) throw quotaError;
  }

  private validateQuota(quota: TraceKernelFileSystemQuota): void {
    if (
      !quota.root.startsWith('/') ||
      normalizeTraceKernelPath(quota.root, '/') !== quota.root ||
      !Number.isSafeInteger(quota.maxBytes) ||
      quota.maxBytes < 0 ||
      !Number.isSafeInteger(quota.maxFileBytes) ||
      quota.maxFileBytes < 0 ||
      !Number.isSafeInteger(quota.maxEntries) ||
      quota.maxEntries < 0
    ) {
      throw this.error('EINVAL', quota.root, 'invalid TKFS quota');
    }
  }

  private quotaCountsPath(path: string): boolean {
    if (!this.quota || path === this.quota.root) return false;
    return path.startsWith(`${this.quota.root}/`);
  }

  private additionalQuotaError(
    paths: readonly string[],
    bytes: number,
    fileBytes?: number
  ): TraceKernelFileSystemError | undefined {
    if (!this.quota) return undefined;
    if (fileBytes !== undefined && fileBytes > this.quota.maxFileBytes) {
      return this.error('EFBIG', paths[0] ?? this.quota.root, 'file exceeds TKFS quota');
    }
    const counted = paths.filter((path) => this.quotaCountsPath(path)).length;
    if (counted === 0) return undefined;
    const usage = this.quotaUsage(this.nodes);
    if (usage.entries + counted > this.quota.maxEntries) {
      return this.error('ENOSPC', paths[0] ?? this.quota.root, 'TKFS entry quota exceeded');
    }
    if (usage.bytes + bytes * counted > this.quota.maxBytes) {
      return this.error('ENOSPC', paths[0] ?? this.quota.root, 'TKFS byte quota exceeded');
    }
    return undefined;
  }

  private quotaResizeError(
    node: TraceKernelFileNode,
    nextSize: number
  ): TraceKernelFileSystemError | undefined {
    if (!this.quota) return undefined;
    const countedPaths = [...this.nodes.entries()]
      .filter(([path, candidate]) => candidate === node && this.quotaCountsPath(path))
      .map(([path]) => path);
    if (countedPaths.length === 0) return undefined;
    if (nextSize > this.quota.maxFileBytes) {
      return this.error('EFBIG', countedPaths[0]!, 'file exceeds TKFS quota');
    }
    const usage = this.quotaUsage(this.nodes);
    const nextBytes =
      usage.bytes + (nextSize - node.contents.byteLength) * countedPaths.length;
    if (nextBytes > this.quota.maxBytes) {
      return this.error('ENOSPC', countedPaths[0]!, 'TKFS byte quota exceeded');
    }
    return undefined;
  }

  private quotaNamespaceError(
    nodes: ReadonlyMap<string, TraceKernelNode>
  ): TraceKernelFileSystemError | undefined {
    if (!this.quota) return undefined;
    const usage = this.quotaUsage(nodes);
    if (usage.largestFileBytes > this.quota.maxFileBytes) {
      return this.error('EFBIG', this.quota.root, 'file exceeds TKFS quota');
    }
    if (usage.entries > this.quota.maxEntries) {
      return this.error('ENOSPC', this.quota.root, 'TKFS entry quota exceeded');
    }
    if (usage.bytes > this.quota.maxBytes) {
      return this.error('ENOSPC', this.quota.root, 'TKFS byte quota exceeded');
    }
    return undefined;
  }

  private quotaUsage(nodes: ReadonlyMap<string, TraceKernelNode>): {
    readonly bytes: number;
    readonly entries: number;
    readonly largestFileBytes: number;
  } {
    let bytes = 0;
    let entries = 0;
    let largestFileBytes = 0;
    for (const [path, node] of nodes) {
      if (!this.quotaCountsPath(path)) continue;
      entries += 1;
      if (node.kind === 'file') {
        bytes += node.contents.byteLength;
        largestFileBytes = Math.max(largestFileBytes, node.contents.byteLength);
      } else if (node.kind === 'symlink') {
        bytes += new TextEncoder().encode(node.target).byteLength;
      }
    }
    return { bytes, entries, largestFileBytes };
  }

  private validImageTimestamp(value: number): boolean {
    return Number.isFinite(value) && value >= 0;
  }

  private makeFile(
    contents: Uint8Array,
    mode: number,
    generation: number,
    timestamp: number
  ): TraceKernelFileNode {
    return {
      kind: 'file',
      inode: this.nextInode++,
      mode,
      contents,
      generation,
      createdAt: timestamp,
      modifiedAt: timestamp,
      changedAt: timestamp,
    };
  }

  private makeDirectory(
    mode: number,
    generation: number,
    timestamp: number
  ): TraceKernelDirectoryNode {
    return {
      kind: 'directory',
      inode: this.nextInode++,
      mode,
      generation,
      createdAt: timestamp,
      modifiedAt: timestamp,
      changedAt: timestamp,
    };
  }

  private makeSymlink(
    target: string,
    generation: number,
    timestamp: number
  ): TraceKernelSymlinkNode {
    return {
      kind: 'symlink',
      inode: this.nextInode++,
      mode: 0o777,
      target,
      generation,
      createdAt: timestamp,
      modifiedAt: timestamp,
      changedAt: timestamp,
    };
  }

  private snapshotStat(path: string, node: TraceKernelNode): TraceKernelStat {
    return Object.freeze({
      path,
      kind: node.kind,
      inode: node.inode,
      nlink: this.linkCount(node),
      mode: node.mode,
      size: node.kind === 'file'
        ? node.contents.byteLength
        : node.kind === 'symlink'
          ? new TextEncoder().encode(node.target).byteLength
          : 0,
      generation: node.generation,
      createdAt: node.createdAt,
      modifiedAt: node.modifiedAt,
      changedAt: node.changedAt,
    });
  }

  private linkCount(node: TraceKernelNode): number {
    if (node.kind === 'directory') return 2;
    let count = 0;
    for (const candidate of this.nodes.values()) {
      if (candidate === node) count += 1;
    }
    return count;
  }

  private pathsForNode(node: TraceKernelNode): readonly string[] {
    return [...this.nodes.entries()]
      .filter(([, candidate]) => candidate === node)
      .map(([path]) => path);
  }

  /**
   * Resolve symbolic links while the namespace semaphore is held.
   *
   * Parent components are always followed. The final component is optionally
   * left unresolved for operations that act on the directory entry itself
   * (lstat, readlink, unlink, rename, link). Missing paths can be admitted only
   * at the final component, or for the entire remaining suffix when recursive
   * mkdir is materializing a new subtree.
   */
  private resolveNodePath(
    path: string,
    followFinal: boolean,
    allowMissing: 'none' | 'final' | 'suffix' = 'none'
  ): string | TraceKernelFileSystemError {
    let current = path;
    let followedLinks = 0;

    resolveAgain: while (true) {
      if (current === '/') {
        return this.nodes.has('/')
          ? '/'
          : this.error('ENOENT', '/', 'no such file or directory');
      }
      const parts = current.split('/').filter(Boolean);
      for (let index = 0; index < parts.length; index += 1) {
        const candidate = `/${parts.slice(0, index + 1).join('/')}`;
        const node = this.nodes.get(candidate);
        const final = index === parts.length - 1;
        if (!node) {
          if (
            allowMissing === 'suffix' ||
            (allowMissing === 'final' && final)
          ) {
            return current;
          }
          return this.error('ENOENT', candidate, 'no such file or directory');
        }
        if (node.kind === 'symlink' && (!final || followFinal)) {
          followedLinks += 1;
          if (followedLinks > 40) {
            return this.error('ELOOP', candidate, 'too many symbolic links');
          }
          const targetPath = normalizeTraceKernelPath(node.target, parentPath(candidate));
          const remaining = parts.slice(index + 1).join('/');
          current = remaining
            ? normalizeTraceKernelPath(`${targetPath}/${remaining}`, '/')
            : targetPath;
          continue resolveAgain;
        }
        if (!final && node.kind !== 'directory') {
          return this.error('ENOTDIR', candidate, 'path component is not a directory');
        }
      }
      return current;
    }
  }

  private requireDirectory(path: string): TraceKernelDirectoryNode | TraceKernelFileSystemError {
    const node = this.nodes.get(path);
    if (!node) {
      return this.error('ENOENT', path, 'parent directory does not exist');
    }
    if (node.kind !== 'directory') {
      return this.error('ENOTDIR', path, 'path component is not a directory');
    }
    return node;
  }

  private hasDescendants(path: string): boolean {
    const prefix = `${path}/`;
    for (const candidate of this.nodes.keys()) {
      if (candidate.startsWith(prefix)) return true;
    }
    return false;
  }

  private beginMutation(): number {
    const generation = this.nextGeneration++;
    if (this.generationBuffer) {
      const sharedGeneration = new Int32Array(this.generationBuffer);
      Atomics.store(sharedGeneration, 0, generation | 0);
      Atomics.notify(sharedGeneration, 0);
    }
    return generation;
  }

  private notifyMutation(
    generation: number,
    eventType: TraceKernelFileSystemMutation['eventType'],
    operation: TraceKernelFileSystemMutationOperation,
    paths: readonly string[],
    context?: TraceKernelFileSystemMutationContext
  ): void {
    if (paths.length === 0) return;
    const mutation = Object.freeze({
      generation,
      eventType,
      operation,
      paths: Object.freeze([...new Set(paths)]),
      ...(context?.origin ? { origin: context.origin } : {}),
    });
    for (const watcher of this.mutationWatchers) {
      try {
        watcher(mutation);
      } catch {
        // Notifications are observational and cannot roll back committed VFS state.
      }
    }
  }

  private touchDirectory(path: string, generation: number, timestamp: number): void {
    const node = this.nodes.get(path);
    if (node?.kind === 'directory') this.touchNode(node, generation, timestamp, true);
  }

  private touchNode(
    node: TraceKernelNode,
    generation: number,
    timestamp: number,
    updateModifiedAt: boolean
  ): void {
    node.generation = generation;
    node.changedAt = timestamp;
    if (updateModifiedAt) node.modifiedAt = timestamp;
  }

  private error(
    code: TraceKernelFileSystemErrorCode,
    path: string,
    message: string
  ): TraceKernelFileSystemError {
    return new TraceKernelFileSystemError({
      code,
      path,
      message: `${code}: ${message} ${JSON.stringify(path)}`,
    });
  }

  private fail(
    code: TraceKernelFileSystemErrorCode,
    path: string,
    message: string
  ): Effect.Effect<never, TraceKernelFileSystemError> {
    return Effect.fail(this.error(code, path, message));
  }
}

export class TraceKernelOpenFileDescription {
  private references = 1;
  private closed = false;
  private offset = 0;

  private constructor(
    readonly id: string,
    private readonly fileSystem: TraceKernelFileSystem,
    private readonly file: TraceKernelOpenFileNode,
    readonly options: TraceKernelOpenFileOptions,
    private readonly mutex: Effect.Semaphore,
    private readonly onFullyClosed: (id: string) => void
  ) {}

  static make(
    id: string,
    fileSystem: TraceKernelFileSystem,
    path: string,
    cwd: string,
    options: TraceKernelOpenFileOptions,
    onFullyClosed: (id: string) => void,
    mutationContext?: TraceKernelFileSystemMutationContext
  ): Effect.Effect<TraceKernelOpenFileDescription, TraceKernelFileSystemError> {
    return Effect.gen(function* () {
      const file = yield* fileSystem.prepareOpen(
        path,
        cwd,
        options,
        mutationContext
      );
      const mutex = yield* Effect.makeSemaphore(1);
      return new TraceKernelOpenFileDescription(
        id,
        fileSystem,
        file,
        Object.freeze({ ...options }),
        mutex,
        onFullyClosed
      );
    });
  }

  get path(): string {
    return this.file.openedPath;
  }

  descriptor(): TraceKernelDescriptor {
    const access = this.options.access ?? 'read';
    return {
      kind: 'file',
      resourceId: this.id,
      ...(access === 'read' || access === 'read-write'
        ? { read: (maxBytes: number, position?: number) => this.read(maxBytes, position) }
        : {}),
      ...(access === 'write' || access === 'read-write'
        ? {
            write: (
              bytes: Uint8Array,
              position?: number,
              context?: TraceKernelDescriptorOperationContext
            ) => this.write(bytes, position, context),
            truncate: (
              length: number,
              context?: TraceKernelDescriptorOperationContext
            ) => this.truncate(length, context),
          }
        : {}),
      seek: (offset: number, whence: TraceKernelSeekWhence) =>
        this.seek(offset, whence),
      stat: () => this.fileSystem.statOpen(this.file),
      duplicate: () => this.duplicate(),
      close: () => this.close(),
    };
  }

  dispose(): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.closed) return;
      this.closed = true;
      this.references = 0;
      this.onFullyClosed(this.id);
    });
  }

  private read(
    maxBytes: number,
    position?: number
  ): Effect.Effect<Uint8Array, TraceKernelFileSystemError> {
    return this.mutex.withPermits(1)(
      Effect.suspend(() => {
        if (this.closed) return this.closedError();
        const readOffset = position ?? this.offset;
        return this.fileSystem.readAt(this.file, readOffset, maxBytes).pipe(
          Effect.tap((bytes) => position === undefined
            ? Effect.sync(() => {
                this.offset = readOffset + bytes.byteLength;
              })
            : Effect.void)
        );
      })
    );
  }

  private write(
    bytes: Uint8Array,
    position?: number,
    context?: TraceKernelDescriptorOperationContext
  ): Effect.Effect<number, TraceKernelFileSystemError> {
    return this.mutex.withPermits(1)(
      Effect.suspend(() => {
        if (this.closed) return this.closedError();
        return this.fileSystem.writeAt(
          this.file,
          position ?? this.offset,
          Uint8Array.from(bytes),
          this.options.append === true,
          context ? { origin: context } : undefined
        ).pipe(
          Effect.tap((nextOffset) => position === undefined || this.options.append === true
            ? Effect.sync(() => {
                this.offset = nextOffset;
              })
            : Effect.void),
          Effect.as(bytes.byteLength)
        );
      })
    );
  }

  private truncate(
    length: number,
    context?: TraceKernelDescriptorOperationContext
  ): Effect.Effect<void, TraceKernelFileSystemError> {
    return this.mutex.withPermits(1)(
      Effect.suspend(() => {
        if (this.closed) return this.closedError();
        return this.fileSystem.truncateOpen(
          this.file,
          length,
          context ? { origin: context } : undefined
        );
      })
    );
  }

  private seek(
    offset: number,
    whence: TraceKernelSeekWhence
  ): Effect.Effect<
    number,
    TraceKernelFileSystemError | TraceKernelInvalidArgumentError
  > {
    return this.mutex.withPermits(1)(
      Effect.suspend((): Effect.Effect<
        number,
        TraceKernelFileSystemError | TraceKernelInvalidArgumentError
      > => {
        if (this.closed) return this.closedError();
        const base = whence === 'set'
          ? Effect.succeed(0)
          : whence === 'current'
            ? Effect.succeed(this.offset)
            : this.fileSystem.statOpen(this.file).pipe(
                Effect.map((stat) => stat.size)
              );
        return base.pipe(
          Effect.flatMap((origin) => {
            const nextOffset = origin + offset;
            if (!Number.isSafeInteger(nextOffset) || nextOffset < 0) {
              return Effect.fail(new TraceKernelInvalidArgumentError({
                code: 'EINVAL',
                argument: 'offset',
                message: `EINVAL: seek would produce invalid offset ${nextOffset}`,
              }));
            }
            this.offset = nextOffset;
            return Effect.succeed(nextOffset);
          })
        );
      })
    );
  }

  private duplicate(): Effect.Effect<TraceKernelDescriptor, Error> {
    return Effect.suspend(() => {
      if (this.closed) return this.closedError();
      this.references += 1;
      return Effect.succeed(this.descriptor());
    });
  }

  private close(): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.closed) return;
      this.references -= 1;
      if (this.references > 0) return;
      this.closed = true;
      this.onFullyClosed(this.id);
    });
  }

  private closedError(): Effect.Effect<never, TraceKernelFileSystemError> {
    return Effect.fail(new TraceKernelFileSystemError({
      code: 'EBADF',
      path: this.path,
      message: `EBADF: open file description ${this.id} is closed`,
    }));
  }
}

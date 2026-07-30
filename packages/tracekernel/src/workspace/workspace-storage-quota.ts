import type {
  RuntimeDirectoryChange,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileDeletion,
  RuntimeSymlink,
} from '@tracecode/runtime-contracts';
import type { FileContent, IFileSystem } from 'just-bash/browser';
import { bytesFromBase64, contentToBytesForRuntimeFile } from './file-content';
import { normalizeFsLockPath } from './locks';
import { dirname, isWithinWorkspace, toProjectPath } from './paths';
import type { NormalizedRuntimeWorkspaceStorageLimits } from './workspace-storage-policy';


type FsReadFileOptions = Parameters<IFileSystem['readFile']>[1];
type FsWriteFileOptions = Parameters<IFileSystem['writeFile']>[2];
type FsMkdirOptions = Parameters<IFileSystem['mkdir']>[1];
type FsRmOptions = Parameters<IFileSystem['rm']>[1];
type FsCpOptions = Parameters<IFileSystem['cp']>[2];

type RuntimeWorkspaceQuotaEntryKind = 'file' | 'directory' | 'symlink';

interface RuntimeWorkspaceQuotaEntry {
  kind: RuntimeWorkspaceQuotaEntryKind;
  size: number;
}

type RuntimeWorkspaceQuotaChanges = Map<string, RuntimeWorkspaceQuotaEntry | null>;

export interface RuntimeWorkspaceStorageUsage {
  usedBytes: number;
  capacityBytes: number;
  availableBytes: number;
  usedEntries: number;
  capacityEntries: number;
  availableEntries: number;
}

export interface RuntimeWorkspaceQuotaPreparedChange {
  change: RuntimeFileChange;
  absolutePath: string;
}


function isRuntimeDirectoryChange(change: RuntimeFileChange): change is RuntimeDirectoryChange {
  return (change as RuntimeDirectoryChange).directory === true;
}


function isRuntimeSymlinkChange(change: RuntimeFileChange): change is RuntimeSymlink {
  return (change as RuntimeSymlink).symlink === true;
}


/**
 * A metadata-only quota boundary around the backing filesystem.
 *
 * The ledger stores sizes and entry kinds, never file contents. Hot writes
 * project only the target and any missing ancestors. Tree copies/moves and
 * final-diff transactions clone metadata because their cost is already
 * proportional to the affected tree.
 */
export class RuntimeWorkspaceQuotaFileSystem implements IFileSystem {
  private entries = new Map<string, RuntimeWorkspaceQuotaEntry>();
  private totalWorkspaceBytes = 0;
  private totalWorkspaceEntries = 0;
  private initialized = false;
  private invalidationEpoch = 0;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly inner: IFileSystem,
    private readonly workspaceRoot: () => string,
    private readonly limits: NormalizedRuntimeWorkspaceStorageLimits
  ) {}

  private async withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let initializedEpoch = this.invalidationEpoch;
    try {
      await this.ensureInitialized();
      initializedEpoch = this.invalidationEpoch;
      return await fn();
    } finally {
      if (initializedEpoch !== this.invalidationEpoch) {
        this.initialized = false;
      }
      release();
    }
  }

  private async ensureInitialized(): Promise<void> {
    while (!this.initialized) {
      const epoch = this.invalidationEpoch;
      await this.rebuildLedger();
      if (epoch === this.invalidationEpoch) this.initialized = true;
    }
  }

  invalidateLedger(): void {
    this.invalidationEpoch += 1;
    this.initialized = false;
  }

  async storageUsage(): Promise<RuntimeWorkspaceStorageUsage> {
    return this.withMutationLock(async () => ({
      usedBytes: this.totalWorkspaceBytes,
      capacityBytes: this.limits.maxWorkspaceBytes,
      availableBytes: Math.max(0, this.limits.maxWorkspaceBytes - this.totalWorkspaceBytes),
      usedEntries: this.totalWorkspaceEntries,
      capacityEntries: this.limits.maxEntryCount,
      availableEntries: Math.max(0, this.limits.maxEntryCount - this.totalWorkspaceEntries),
    }));
  }

  private async rebuildLedger(): Promise<void> {
    const entries = new Map<string, RuntimeWorkspaceQuotaEntry>();
    for (const rawPath of this.inner.getAllPaths()) {
      const path = normalizeFsLockPath(rawPath);
      const stat = await this.inner.lstat(path);
      if (stat.isSymbolicLink) {
        entries.set(path, {
          kind: 'symlink',
          size: new TextEncoder().encode(await this.inner.readlink(path)).byteLength,
        });
      } else if (stat.isFile) {
        entries.set(path, { kind: 'file', size: stat.size });
      } else if (stat.isDirectory) {
        entries.set(path, { kind: 'directory', size: 0 });
      }
    }
    this.commitSnapshot(entries);
  }

  private isCounted(path: string): boolean {
    const root = normalizeFsLockPath(this.workspaceRoot());
    return path !== root && isWithinWorkspace(root, path);
  }

  private displayPath(path: string): string {
    const root = normalizeFsLockPath(this.workspaceRoot());
    return isWithinWorkspace(root, path) ? toProjectPath(root, path) : path;
  }

  private storageError(
    code: 'EFBIG' | 'ENOSPC',
    message: string,
    path: string,
    syscall: string
  ): Error {
    const displayPath = this.displayPath(path);
    return Object.assign(
      new Error(`${code}: ${message}, ${syscall} '${displayPath}'`),
      {
        code,
        errno: code === 'EFBIG' ? 27 : 28,
        syscall,
        path: displayPath,
      }
    );
  }

  private assertSnapshotWithinLimits(entries: ReadonlyMap<string, RuntimeWorkspaceQuotaEntry>, path: string, syscall: string): void {
    let totalBytes = 0;
    let totalEntries = 0;
    for (const [entryPath, entry] of entries) {
      if (!this.isCounted(entryPath)) continue;
      if (entry.kind === 'file' && entry.size > this.limits.maxFileBytes) {
        throw this.storageError(
          'EFBIG',
          `workspace file exceeds ${this.limits.maxFileBytes} bytes`,
          entryPath,
          syscall
        );
      }
      totalBytes += entry.size;
      totalEntries += 1;
    }
    if (totalBytes > this.limits.maxWorkspaceBytes) {
      throw this.storageError(
        'ENOSPC',
        `workspace exceeds ${this.limits.maxWorkspaceBytes} logical bytes`,
        path,
        syscall
      );
    }
    if (totalEntries > this.limits.maxEntryCount) {
      throw this.storageError(
        'ENOSPC',
        `workspace exceeds ${this.limits.maxEntryCount} entries`,
        path,
        syscall
      );
    }
  }

  private assertChangesWithinLimits(changes: RuntimeWorkspaceQuotaChanges, path: string, syscall: string): void {
    let totalBytes = this.totalWorkspaceBytes;
    let totalEntries = this.totalWorkspaceEntries;
    for (const [entryPath, next] of changes) {
      if (!this.isCounted(entryPath)) continue;
      const previous = this.entries.get(entryPath);
      if (previous) {
        totalBytes -= previous.size;
        totalEntries -= 1;
      }
      if (next) {
        if (next.kind === 'file' && next.size > this.limits.maxFileBytes) {
          throw this.storageError(
            'EFBIG',
            `workspace file exceeds ${this.limits.maxFileBytes} bytes`,
            entryPath,
            syscall
          );
        }
        totalBytes += next.size;
        totalEntries += 1;
      }
    }
    if (totalBytes > this.limits.maxWorkspaceBytes) {
      throw this.storageError(
        'ENOSPC',
        `workspace exceeds ${this.limits.maxWorkspaceBytes} logical bytes`,
        path,
        syscall
      );
    }
    if (totalEntries > this.limits.maxEntryCount) {
      throw this.storageError(
        'ENOSPC',
        `workspace exceeds ${this.limits.maxEntryCount} entries`,
        path,
        syscall
      );
    }
  }

  private commitChanges(changes: RuntimeWorkspaceQuotaChanges): void {
    for (const [path, next] of changes) {
      const previous = this.entries.get(path);
      if (this.isCounted(path) && previous) {
        this.totalWorkspaceBytes -= previous.size;
        this.totalWorkspaceEntries -= 1;
      }
      if (next) {
        this.entries.set(path, next);
        if (this.isCounted(path)) {
          this.totalWorkspaceBytes += next.size;
          this.totalWorkspaceEntries += 1;
        }
      } else {
        this.entries.delete(path);
      }
    }
  }

  private commitSnapshot(entries: Map<string, RuntimeWorkspaceQuotaEntry>): void {
    this.entries = entries;
    this.totalWorkspaceBytes = 0;
    this.totalWorkspaceEntries = 0;
    for (const [path, entry] of entries) {
      if (!this.isCounted(path)) continue;
      this.totalWorkspaceBytes += entry.size;
      this.totalWorkspaceEntries += 1;
    }
  }

  private currentEntry(path: string, changes?: RuntimeWorkspaceQuotaChanges): RuntimeWorkspaceQuotaEntry | undefined {
    const normalizedPath = normalizeFsLockPath(path);
    if (changes?.has(normalizedPath)) return changes.get(normalizedPath) ?? undefined;
    return this.entries.get(normalizedPath);
  }

  private addMissingParents(path: string, changes: RuntimeWorkspaceQuotaChanges): void {
    let current = dirname(normalizeFsLockPath(path));
    const missing: string[] = [];
    while (current !== '/') {
      if (this.currentEntry(current, changes)) break;
      missing.push(current);
      current = dirname(current);
    }
    for (const directoryPath of missing.reverse()) {
      changes.set(directoryPath, { kind: 'directory', size: 0 });
    }
  }

  private writeSize(content: FileContent, options?: FsWriteFileOptions): number {
    if (typeof content !== 'string') return content.byteLength;
    const encoding = typeof options === 'string' ? options : options?.encoding;
    if (encoding === 'base64') return bytesFromBase64(content).byteLength;
    if (encoding === 'hex') return Math.floor(content.length / 2);
    if (encoding === 'ascii' || encoding === 'binary' || encoding === 'latin1') return content.length;
    return new TextEncoder().encode(content).byteLength;
  }

  private removeSubtreeFromChanges(path: string, changes: RuntimeWorkspaceQuotaChanges): void {
    const normalizedPath = normalizeFsLockPath(path);
    for (const candidate of this.entries.keys()) {
      if (candidate === normalizedPath || candidate.startsWith(`${normalizedPath}/`)) {
        changes.set(candidate, null);
      }
    }
    for (const candidate of [...changes.keys()]) {
      if (candidate === normalizedPath || candidate.startsWith(`${normalizedPath}/`)) {
        changes.set(candidate, null);
      }
    }
  }

  private ensureSnapshotParents(entries: Map<string, RuntimeWorkspaceQuotaEntry>, path: string): void {
    let current = dirname(normalizeFsLockPath(path));
    const missing: string[] = [];
    while (current !== '/') {
      if (entries.has(current)) break;
      missing.push(current);
      current = dirname(current);
    }
    for (const directoryPath of missing.reverse()) {
      entries.set(directoryPath, { kind: 'directory', size: 0 });
    }
  }

  private removeSnapshotSubtree(entries: Map<string, RuntimeWorkspaceQuotaEntry>, path: string): void {
    const normalizedPath = normalizeFsLockPath(path);
    for (const candidate of [...entries.keys()]) {
      if (candidate === normalizedPath || candidate.startsWith(`${normalizedPath}/`)) {
        entries.delete(candidate);
      }
    }
  }

  private copySnapshotTree(
    entries: Map<string, RuntimeWorkspaceQuotaEntry>,
    sourceSnapshot: ReadonlyMap<string, RuntimeWorkspaceQuotaEntry>,
    source: string,
    destination: string,
    recursive: boolean
  ): void {
    const normalizedSource = normalizeFsLockPath(source);
    const normalizedDestination = normalizeFsLockPath(destination);
    const sourceEntry = sourceSnapshot.get(normalizedSource);
    if (!sourceEntry) return;
    this.ensureSnapshotParents(entries, normalizedDestination);
    if (sourceEntry.kind !== 'directory') {
      entries.set(normalizedDestination, { ...sourceEntry });
      return;
    }
    if (!recursive) return;
    entries.set(normalizedDestination, { kind: 'directory', size: 0 });
    const sourcePaths = [...sourceSnapshot.keys()]
      .filter((path) => path.startsWith(`${normalizedSource}/`))
      .sort((left, right) => left.length - right.length || left.localeCompare(right));
    for (const sourcePath of sourcePaths) {
      const entry = sourceSnapshot.get(sourcePath)!;
      entries.set(`${normalizedDestination}${sourcePath.slice(normalizedSource.length)}`, { ...entry });
    }
  }

  async runFinalDiffTransaction<T>(
    changes: readonly RuntimeWorkspaceQuotaPreparedChange[],
    mutate: (rawFileSystem: IFileSystem) => Promise<T>
  ): Promise<T> {
    return this.withMutationLock(async () => {
      const projected = new Map(this.entries);
      for (const prepared of changes) {
        const path = normalizeFsLockPath(prepared.absolutePath);
        const change = prepared.change;
        if (isRuntimeDirectoryChange(change)) {
          if (change.deleted === true) {
            this.removeSnapshotSubtree(projected, path);
          } else {
            this.ensureSnapshotParents(projected, path);
            if (!projected.has(path)) projected.set(path, { kind: 'directory', size: 0 });
          }
        } else if ((change as RuntimeFileDeletion).deleted === true) {
          projected.delete(path);
        } else if (isRuntimeSymlinkChange(change)) {
          this.ensureSnapshotParents(projected, path);
          projected.set(path, {
            kind: 'symlink',
            size: new TextEncoder().encode(change.target).byteLength,
          });
        } else {
          this.ensureSnapshotParents(projected, path);
          projected.set(path, {
            kind: 'file',
            size: contentToBytesForRuntimeFile(change as RuntimeFile).byteLength,
          });
        }
        // Preflight every prefix, not just the final projection. This keeps
        // transient write order from exceeding the same bound while still
        // validating the complete transaction before its first mutation.
        this.assertSnapshotWithinLimits(projected, path, 'write');
      }
      const diagnosticPath = normalizeFsLockPath(changes[0]?.absolutePath ?? this.workspaceRoot());
      this.assertSnapshotWithinLimits(projected, diagnosticPath, 'write');
      try {
        const result = await mutate(this.inner);
        this.commitSnapshot(projected);
        return result;
      } catch (error) {
        // The caller owns rollback for the filesystem transaction. Rebuild the
        // metadata ledger from the resulting state so even a rollback failure
        // cannot desynchronize later quota decisions.
        await this.rebuildLedger();
        throw error;
      }
    });
  }

  readFile(path: string, options?: FsReadFileOptions): Promise<string> {
    return this.inner.readFile(path, options);
  }

  readFileBytes?(path: string): Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never> {
    if (!this.inner.readFileBytes) return Promise.reject(new Error('readFileBytes is not supported by this filesystem.'));
    return this.inner.readFileBytes(path) as Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never>;
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.inner.readFileBuffer(path);
  }

  writeFile(path: string, content: FileContent, options?: FsWriteFileOptions): Promise<void> {
    return this.withMutationLock(async () => {
      const normalizedPath = normalizeFsLockPath(path);
      const changes: RuntimeWorkspaceQuotaChanges = new Map();
      this.addMissingParents(normalizedPath, changes);
      changes.set(normalizedPath, { kind: 'file', size: this.writeSize(content, options) });
      this.assertChangesWithinLimits(changes, normalizedPath, 'write');
      await this.inner.writeFile(path, content, options);
      this.commitChanges(changes);
    });
  }

  appendFile(path: string, content: FileContent, options?: FsWriteFileOptions): Promise<void> {
    return this.withMutationLock(async () => {
      const normalizedPath = normalizeFsLockPath(path);
      const changes: RuntimeWorkspaceQuotaChanges = new Map();
      this.addMissingParents(normalizedPath, changes);
      const current = this.currentEntry(normalizedPath, changes);
      const previousBytes = current?.kind === 'file' ? current.size : 0;
      changes.set(normalizedPath, { kind: 'file', size: previousBytes + this.writeSize(content, options) });
      this.assertChangesWithinLimits(changes, normalizedPath, 'write');
      await this.inner.appendFile(path, content, options);
      this.commitChanges(changes);
    });
  }

  exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }

  stat(path: string): Promise<Awaited<ReturnType<IFileSystem['stat']>>> {
    return this.inner.stat(path);
  }

  mkdir(path: string, options?: FsMkdirOptions): Promise<void> {
    return this.withMutationLock(async () => {
      const normalizedPath = normalizeFsLockPath(path);
      const changes: RuntimeWorkspaceQuotaChanges = new Map();
      if (options?.recursive) this.addMissingParents(normalizedPath, changes);
      if (!this.currentEntry(normalizedPath, changes)) {
        changes.set(normalizedPath, { kind: 'directory', size: 0 });
      }
      this.assertChangesWithinLimits(changes, normalizedPath, 'mkdir');
      await this.inner.mkdir(path, options);
      this.commitChanges(changes);
    });
  }

  readdir(path: string): Promise<string[]> {
    return this.inner.readdir(path);
  }

  readdirWithFileTypes?(path: string): Promise<Awaited<ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>>> {
    if (!this.inner.readdirWithFileTypes) return Promise.reject(new Error('readdirWithFileTypes is not supported by this filesystem.'));
    return this.inner.readdirWithFileTypes(path) as Promise<Awaited<ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>>>;
  }

  rm(path: string, options?: FsRmOptions): Promise<void> {
    return this.withMutationLock(async () => {
      const normalizedPath = normalizeFsLockPath(path);
      const changes: RuntimeWorkspaceQuotaChanges = new Map();
      if (options?.recursive) this.removeSubtreeFromChanges(normalizedPath, changes);
      else changes.set(normalizedPath, null);
      await this.inner.rm(path, options);
      this.commitChanges(changes);
    });
  }

  cp(src: string, dest: string, options?: FsCpOptions): Promise<void> {
    return this.withMutationLock(async () => {
      const normalizedSource = normalizeFsLockPath(src);
      const normalizedDestination = normalizeFsLockPath(dest);
      const sourceEntry = this.entries.get(normalizedSource);
      if (sourceEntry && sourceEntry.kind !== 'directory') {
        const changes: RuntimeWorkspaceQuotaChanges = new Map();
        this.addMissingParents(normalizedDestination, changes);
        changes.set(normalizedDestination, { ...sourceEntry });
        this.assertChangesWithinLimits(changes, normalizedDestination, 'copy');
        await this.inner.cp(src, dest, options);
        this.commitChanges(changes);
        return;
      }
      const projected = new Map(this.entries);
      this.copySnapshotTree(projected, this.entries, src, dest, options?.recursive === true);
      this.assertSnapshotWithinLimits(projected, normalizedDestination, 'copy');
      await this.inner.cp(src, dest, options);
      this.commitSnapshot(projected);
    });
  }

  mv(src: string, dest: string): Promise<void> {
    return this.withMutationLock(async () => {
      const normalizedSource = normalizeFsLockPath(src);
      const normalizedDestination = normalizeFsLockPath(dest);
      const sourceEntry = this.entries.get(normalizedSource);
      if (sourceEntry && sourceEntry.kind !== 'directory') {
        const changes: RuntimeWorkspaceQuotaChanges = new Map();
        this.addMissingParents(normalizedDestination, changes);
        changes.set(normalizedDestination, { ...sourceEntry });
        changes.set(normalizedSource, null);
        this.assertChangesWithinLimits(changes, normalizedDestination, 'rename');
        await this.inner.mv(src, dest);
        this.commitChanges(changes);
        return;
      }
      const sourceSnapshot = new Map(this.entries);
      const projected = new Map(this.entries);
      this.copySnapshotTree(projected, sourceSnapshot, src, dest, true);
      this.removeSnapshotSubtree(projected, src);
      this.assertSnapshotWithinLimits(projected, normalizedDestination, 'rename');
      await this.inner.mv(src, dest);
      this.commitSnapshot(projected);
    });
  }

  resolvePath(base: string, path: string): string {
    return this.inner.resolvePath(base, path);
  }

  getAllPaths(): string[] {
    return this.inner.getAllPaths();
  }

  chmod(path: string, mode: number): Promise<void> {
    return this.inner.chmod(path, mode);
  }

  symlink(target: string, linkPath: string): Promise<void> {
    return this.withMutationLock(async () => {
      const normalizedPath = normalizeFsLockPath(linkPath);
      const changes: RuntimeWorkspaceQuotaChanges = new Map();
      this.addMissingParents(normalizedPath, changes);
      changes.set(normalizedPath, {
        kind: 'symlink',
        size: new TextEncoder().encode(target).byteLength,
      });
      this.assertChangesWithinLimits(changes, normalizedPath, 'symlink');
      await this.inner.symlink(target, linkPath);
      this.commitChanges(changes);
    });
  }

  link(existingPath: string, newPath: string): Promise<void> {
    return this.withMutationLock(async () => {
      const normalizedExistingPath = normalizeFsLockPath(existingPath);
      const normalizedNewPath = normalizeFsLockPath(newPath);
      const changes: RuntimeWorkspaceQuotaChanges = new Map();
      this.addMissingParents(normalizedNewPath, changes);
      const existing = this.entries.get(normalizedExistingPath);
      if (existing?.kind === 'file') {
        changes.set(normalizedNewPath, { ...existing });
      }
      this.assertChangesWithinLimits(changes, normalizedNewPath, 'link');
      await this.inner.link(existingPath, newPath);
      this.commitChanges(changes);
    });
  }

  readlink(path: string): Promise<string> {
    return this.inner.readlink(path);
  }

  lstat(path: string): Promise<Awaited<ReturnType<IFileSystem['lstat']>>> {
    return this.inner.lstat(path);
  }

  realpath(path: string): Promise<string> {
    return this.inner.realpath(path);
  }

  utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    return this.inner.utimes(path, atime, mtime);
  }
}

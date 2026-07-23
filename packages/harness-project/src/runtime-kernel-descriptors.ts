import type {
  TraceKernelOpenFileOptions,
  TraceKernelStat,
} from '@tracecode/tracekernel';
import type {
  KernelObservedFileSystem,
  RuntimeCommandExecutionContext,
  RuntimeFileSystemBeforeMutation,
} from './fs-observed';
import { normalizeFsLockPath } from './locks';

interface RuntimeKernelOpenFileNode {
  readonly inode: number;
  readonly openedPath: string;
  linkedPath?: string;
  bytes: Uint8Array;
  mode: number;
  generation: number;
  createdAt: number;
  modifiedAt: number;
  changedAt: number;
  descriptions: number;
  tail: Promise<void>;
}

interface RuntimeKernelOpenFileDescription {
  readonly node: RuntimeKernelOpenFileNode;
  readonly options: Readonly<TraceKernelOpenFileOptions>;
  offset: number;
  references: number;
  closed: boolean;
}

interface RuntimeKernelDescriptorTable {
  nextFd: number;
  readonly descriptors: Map<number, RuntimeKernelOpenFileDescription>;
}

function descriptorError(
  code: 'EACCES' | 'EBADF' | 'EEXIST' | 'EISDIR' | 'EINVAL' | 'ENOENT',
  message: string
): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function timestamp(stat: { mtime?: Date }): number {
  return stat.mtime instanceof Date ? stat.mtime.getTime() : Date.now();
}

/**
 * Transitional product adapter for process-owned regular-file descriptors.
 *
 * Descriptor tables belong to runtime PIDs. Open descriptions share offsets
 * after dup, while independently opened descriptions retain independent
 * offsets. Session-owned file nodes are keyed by the workspace inode so an
 * already-open descriptor survives rename, unlink, and path replacement.
 *
 * The adapter deliberately lives behind the TraceKernel syscall contract. When
 * RuntimeProjectWorkspace storage moves to TKFS, the product bridge can be
 * replaced by TraceKernelProcess/TraceKernelFileSystem without changing a
 * language runtime.
 */
export class RuntimeKernelDescriptorManager {
  private readonly tables = new Map<number, RuntimeKernelDescriptorTable>();
  private readonly nodes = new Map<number, RuntimeKernelOpenFileNode>();
  private readonly stopSnapshotting: () => void;
  private openTail: Promise<void> = Promise.resolve();

  constructor(private readonly fs: KernelObservedFileSystem) {
    this.stopSnapshotting = fs.watchBeforeMutations((mutation) =>
      this.snapshotAffectedNodes(mutation)
    );
  }

  open(
    pid: number,
    context: RuntimeCommandExecutionContext | undefined,
    path: string,
    options: TraceKernelOpenFileOptions = {}
  ): Promise<number> {
    const operation = () => this.openSerial(pid, context, path, options);
    const result = this.openTail.then(operation, operation);
    this.openTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async openSerial(
    pid: number,
    context: RuntimeCommandExecutionContext | undefined,
    path: string,
    options: TraceKernelOpenFileOptions
  ): Promise<number> {
    const access = options.access ?? 'read';
    let exists = await this.fs.existsWithContext(context, path);
    if (exists) {
      const stat = await this.fs.statWithContext(context, path);
      if (stat.isDirectory) {
        throw descriptorError('EISDIR', `illegal operation on a directory, open '${path}'`);
      }
      if (options.create && options.exclusive) {
        throw descriptorError('EEXIST', `file already exists, open '${path}'`);
      }
      if (options.truncate) {
        if (access === 'read') {
          throw descriptorError('EACCES', `read-only descriptor cannot truncate '${path}'`);
        }
        await this.fs.writeFileWithContext(context, path, new Uint8Array());
      }
    } else {
      if (!options.create) {
        throw descriptorError('ENOENT', `no such file or directory, open '${path}'`);
      }
      if (access === 'read') {
        throw descriptorError('EACCES', `read-only descriptor cannot create '${path}'`);
      }
      await this.fs.writeFileWithContext(context, path, new Uint8Array());
      exists = true;
    }

    if (!exists) {
      throw descriptorError('ENOENT', `no such file or directory, open '${path}'`);
    }
    const identityPath = await this.fs.inodeIdentityPathWithContext(context, path);
    const stat = await this.fs.statWithContext(context, identityPath);
    const inode = this.fs.inodeForPath(identityPath);
    let node = this.nodes.get(inode);
    if (!node) {
      const modifiedAt = timestamp(stat);
      node = {
        inode,
        openedPath: path,
        linkedPath: normalizeFsLockPath(identityPath),
        bytes: Uint8Array.from(await this.fs.readFileBufferWithContext(context, identityPath)),
        mode: stat.mode ?? 0o100666,
        generation: this.fs.mutationVersion,
        createdAt: modifiedAt,
        modifiedAt,
        changedAt: modifiedAt,
        descriptions: 0,
        tail: Promise.resolve(),
      };
      this.nodes.set(inode, node);
    } else {
      await this.refreshNode(context, node);
    }

    node.descriptions += 1;
    const description: RuntimeKernelOpenFileDescription = {
      node,
      options: Object.freeze({ ...options, access }),
      offset: options.append ? node.bytes.byteLength : 0,
      references: 1,
      closed: false,
    };
    const table = this.table(pid);
    const fd = table.nextFd++;
    table.descriptors.set(fd, description);
    return fd;
  }

  read(
    pid: number,
    context: RuntimeCommandExecutionContext | undefined,
    fd: number,
    maxBytes: number,
    position?: number
  ): Promise<Uint8Array> {
    const description = this.description(pid, fd, 'read');
    const access = description.options.access ?? 'read';
    if (access === 'write') {
      throw descriptorError('EBADF', `descriptor ${fd} is not readable`);
    }
    return this.withNode(description.node, async () => {
      this.assertDescriptionOpen(description, fd, 'read');
      await this.refreshNode(context, description.node);
      const start = position === undefined
        ? description.offset
        : Math.max(0, Math.floor(position));
      const length = Math.max(0, Math.floor(maxBytes));
      const bytes = description.node.bytes.slice(start, start + length);
      if (position === undefined) description.offset = start + bytes.byteLength;
      return bytes;
    });
  }

  write(
    pid: number,
    context: RuntimeCommandExecutionContext | undefined,
    fd: number,
    bytes: Uint8Array,
    position?: number
  ): Promise<number> {
    const description = this.description(pid, fd, 'write');
    const access = description.options.access ?? 'read';
    if (access === 'read') {
      throw descriptorError('EBADF', `descriptor ${fd} is not writable`);
    }
    return this.withNode(description.node, async () => {
      this.assertDescriptionOpen(description, fd, 'write');
      const node = description.node;
      await this.refreshNode(context, node);
      const payload = Uint8Array.from(bytes);
      const append = description.options.append === true;
      const start = append
        ? node.bytes.byteLength
        : position === undefined
          ? description.offset
          : Math.max(0, Math.floor(position));
      const next = new Uint8Array(Math.max(node.bytes.byteLength, start + payload.byteLength));
      next.set(node.bytes);
      next.set(payload, start);
      await this.commitNode(context, node, next);
      if (append || position === undefined) description.offset = start + payload.byteLength;
      return payload.byteLength;
    });
  }

  fstat(
    pid: number,
    context: RuntimeCommandExecutionContext | undefined,
    fd: number
  ): Promise<TraceKernelStat> {
    const description = this.description(pid, fd, 'fstat');
    return this.withNode(description.node, async () => {
      this.assertDescriptionOpen(description, fd, 'fstat');
      const node = description.node;
      await this.refreshNode(context, node);
      return Object.freeze({
        path: node.linkedPath ?? node.openedPath,
        kind: 'file' as const,
        inode: node.inode,
        nlink: node.linkedPath === undefined
          ? 0
          : this.fs.inodeLinkCount(node.linkedPath),
        mode: node.mode,
        size: node.bytes.byteLength,
        generation: node.generation,
        createdAt: node.createdAt,
        modifiedAt: node.modifiedAt,
        changedAt: node.changedAt,
      });
    });
  }

  ftruncate(
    pid: number,
    context: RuntimeCommandExecutionContext | undefined,
    fd: number,
    length: number
  ): Promise<void> {
    const description = this.description(pid, fd, 'ftruncate');
    const access = description.options.access ?? 'read';
    if (access === 'read') {
      throw descriptorError('EBADF', `descriptor ${fd} is not writable`);
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      throw descriptorError('EINVAL', `invalid ftruncate length ${length}`);
    }
    return this.withNode(description.node, async () => {
      this.assertDescriptionOpen(description, fd, 'ftruncate');
      const node = description.node;
      await this.refreshNode(context, node);
      const next = new Uint8Array(length);
      next.set(node.bytes.slice(0, length));
      await this.commitNode(context, node, next);
      if (description.offset > length) description.offset = length;
    });
  }

  dup(pid: number, fd: number): number {
    const description = this.description(pid, fd, 'dup');
    this.assertDescriptionOpen(description, fd, 'dup');
    description.references += 1;
    const table = this.table(pid);
    const duplicateFd = table.nextFd++;
    table.descriptors.set(duplicateFd, description);
    return duplicateFd;
  }

  close(pid: number, fd: number): void {
    const table = this.tables.get(pid);
    const description = table?.descriptors.get(fd);
    if (!table || !description) {
      throw descriptorError('EBADF', `bad file descriptor, close ${fd}`);
    }
    table.descriptors.delete(fd);
    this.release(description);
    if (table.descriptors.size === 0) this.tables.delete(pid);
  }

  closeProcess(pid: number): void {
    const table = this.tables.get(pid);
    if (!table) return;
    this.tables.delete(pid);
    for (const description of table.descriptors.values()) this.release(description);
    table.descriptors.clear();
  }

  dispose(): void {
    this.stopSnapshotting();
    for (const pid of [...this.tables.keys()]) this.closeProcess(pid);
    this.nodes.clear();
  }

  private table(pid: number): RuntimeKernelDescriptorTable {
    let table = this.tables.get(pid);
    if (!table) {
      table = { nextFd: 3, descriptors: new Map() };
      this.tables.set(pid, table);
    }
    return table;
  }

  private description(
    pid: number,
    fd: number,
    operation: string
  ): RuntimeKernelOpenFileDescription {
    const description = this.tables.get(pid)?.descriptors.get(fd);
    if (!description) {
      throw descriptorError('EBADF', `bad file descriptor, ${operation} ${fd}`);
    }
    return description;
  }

  private assertDescriptionOpen(
    description: RuntimeKernelOpenFileDescription,
    fd: number,
    operation: string
  ): void {
    if (description.closed) {
      throw descriptorError('EBADF', `bad file descriptor, ${operation} ${fd}`);
    }
  }

  private release(description: RuntimeKernelOpenFileDescription): void {
    if (description.closed) return;
    description.references -= 1;
    if (description.references > 0) return;
    description.closed = true;
    description.node.descriptions -= 1;
    if (description.node.descriptions <= 0) {
      this.nodes.delete(description.node.inode);
    }
  }

  private async refreshNode(
    context: RuntimeCommandExecutionContext | undefined,
    node: RuntimeKernelOpenFileNode
  ): Promise<void> {
    const linkedPath = this.fs.pathForInode(node.inode);
    if (!linkedPath || !(await this.fs.existsWithContext(context, linkedPath))) {
      node.linkedPath = undefined;
      return;
    }
    const stat = await this.fs.statWithContext(context, linkedPath);
    if (stat.isDirectory) {
      node.linkedPath = undefined;
      return;
    }
    node.linkedPath = linkedPath;
    node.bytes = Uint8Array.from(
      await this.fs.readFileBufferWithContext(context, linkedPath)
    );
    node.mode = stat.mode ?? node.mode;
    node.generation = this.fs.mutationVersion;
    const modifiedAt = timestamp(stat);
    node.modifiedAt = modifiedAt;
    node.changedAt = modifiedAt;
  }

  private async commitNode(
    context: RuntimeCommandExecutionContext | undefined,
    node: RuntimeKernelOpenFileNode,
    bytes: Uint8Array
  ): Promise<void> {
    if (node.linkedPath) {
      await this.fs.writeFileByInodeWithContext(context, node.linkedPath, bytes);
      node.generation = this.fs.mutationVersion;
    } else {
      node.generation += 1;
    }
    const now = Date.now();
    node.bytes = Uint8Array.from(bytes);
    node.modifiedAt = now;
    node.changedAt = now;
  }

  private withNode<T>(
    node: RuntimeKernelOpenFileNode,
    operation: () => Promise<T>
  ): Promise<T> {
    const result = node.tail.then(operation, operation);
    node.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async snapshotAffectedNodes(
    mutation: RuntimeFileSystemBeforeMutation
  ): Promise<void> {
    for (const node of this.nodes.values()) {
      const path = node.linkedPath;
      if (!path || !this.mutationAffectsPath(mutation.paths, path)) continue;
      try {
        node.bytes = Uint8Array.from(await mutation.readFile(path));
      } catch {
        // Missing targets are already detached snapshots.
      }
    }
  }

  private mutationAffectsPath(paths: readonly string[], candidate: string): boolean {
    const normalizedCandidate = normalizeFsLockPath(candidate);
    return paths.some((path) => {
      const normalizedPath = normalizeFsLockPath(path);
      return normalizedCandidate === normalizedPath ||
        normalizedCandidate.startsWith(`${normalizedPath}/`);
    });
  }
}

import {
  readPublicRuntimeProcFile,
  readRuntimeProcFile,
  runtimeWorkspaceActorPreset,
  type RuntimeCommandFileChangeEvent,
  type RuntimeDirectoryChange,
  type RuntimeFile,
  type RuntimeFileChange,
  type RuntimeFileDeletion,
  type RuntimeFileEncoding,
  type RuntimeFileMutationPhase,
  type RuntimeKernelDevicePath,
  type RuntimeKernelInfo,
  type RuntimeSymlink,
  type RuntimeWorkspaceActor,
  type RuntimeWorkspaceRemoveOptions,
  type RuntimeWorkspaceStat,
} from '@tracecode/harness-core';
import type { IFileSystem } from 'just-bash/browser';
import {
  assertSupportedEncoding,
  base64FromBytes,
  bytesFromBase64,
  collectSnapshotFiles,
  contentToText,
  kernelAccessTarget,
  kernelDirectoryTarget,
  kernelFileCopyTarget,
  kernelFileReadTarget,
  kernelMkdirTarget,
  kernelReadTarget,
  kernelRemoveTarget,
  kernelRenameTarget,
  kernelStatTarget,
  kernelWriteTarget,
  throwKernelMutationTargetError,
  throwKernelReadTargetError,
  throwKernelWriteTargetError,
  type KernelObservedFileSystem,
} from './fs-observed';
import {
  isWithinWorkspace,
  toProjectDirectoryPath,
  toProjectPath,
  toWorkspaceEntryPath,
  toWorkspaceRelativePath,
  toWorkspacePath,
} from './paths';
import type { RuntimeKernelProcessRecord } from './process-state';
import type { WorkspaceAccessPolicy } from './workspace-access-policy';
import type { WorkspaceVirtualFileSystem } from './workspace-virtual-filesystem';

const PRINCIPAL_ACTOR = runtimeWorkspaceActorPreset('principal');
const SYSTEM_ACTOR = runtimeWorkspaceActorPreset('system');

export interface WorkspaceFileApiOptions {
  readonly cwd: string;
  readonly kernelInfo: RuntimeKernelInfo;
  readonly fileSystem: KernelObservedFileSystem;
  readonly virtualFiles: WorkspaceVirtualFileSystem;
  readonly accessPolicy: WorkspaceAccessPolicy;
  readonly assertNotDestroyed: () => void;
  readonly ensureUsableForMutation: (operation: string) => void;
  readonly assertActorFileCapability: (
    actor: RuntimeWorkspaceActor,
    capability: 'read' | 'write' | 'delete',
    path: string
  ) => void;
  readonly readDevice: (device: RuntimeKernelDevicePath) => string;
  readonly writeDevice: (
    device: RuntimeKernelDevicePath,
    data: string,
    actor: RuntimeWorkspaceActor
  ) => void;
  readonly emitFileChange: (
    event: RuntimeCommandFileChangeEvent,
    process?: RuntimeKernelProcessRecord
  ) => void;
  readonly invalidateSnapshotCache: () => void;
}

/**
 * Public filesystem operations for a single workspace.
 *
 * The observed filesystem remains the sole data owner. This controller
 * composes virtual namespaces, access policy, actor capabilities, and
 * mutation events without owning lifecycle or journal state.
 */
export class WorkspaceFileApi {
  private readonly principalActor: RuntimeWorkspaceActor = PRINCIPAL_ACTOR;
  private readonly systemActor: RuntimeWorkspaceActor = SYSTEM_ACTOR;

  constructor(private readonly options: WorkspaceFileApiOptions) {}

  async writeFile(
    path: string,
    contents: string,
    encoding?: RuntimeFileEncoding
  ): Promise<void> {
    this.options.ensureUsableForMutation('write');
    await this.writeFileAs(
      path,
      contents,
      this.principalActor,
      encoding,
      'live'
    );
  }

  async writeFileAs(
    path: string,
    contents: string,
    actor: RuntimeWorkspaceActor,
    encoding?: RuntimeFileEncoding,
    phase: RuntimeFileMutationPhase = 'live',
    process?: RuntimeKernelProcessRecord
  ): Promise<void> {
    this.options.assertActorFileCapability(actor, 'write', path);
    this.options.ensureUsableForMutation('write');
    this.options.accessPolicy.assertDynamicVirtualWritable(path, 'write');
    const writeTarget = kernelWriteTarget(path);
    if (writeTarget.kind === 'error') {
      throwKernelWriteTargetError(path, writeTarget);
    }
    const normalizedEncoding = assertSupportedEncoding(encoding);
    if (writeTarget.kind === 'device') {
      this.options.writeDevice(
        writeTarget.device,
        normalizedEncoding === 'base64'
          ? new TextDecoder().decode(bytesFromBase64(contents))
          : contents,
        actor
      );
      return;
    }
    const absolutePath = this.toWorkspacePath(path);
    const mutationKind = (await this.options.fileSystem.exists(absolutePath))
      ? 'file-write'
      : 'file-create';
    await this.options.fileSystem.withBaseMutation(
      [absolutePath],
      async (fileSystem) => {
        this.options.accessPolicy.assertWorkspacePathWritable(
          absolutePath,
          'write'
        );
        await fileSystem.writeFile(
          absolutePath,
          normalizedEncoding === 'base64'
            ? bytesFromBase64(contents)
            : contents
        );
      },
      mutationKind
    );
    this.options.emitFileChange(
      {
        type: 'file-change',
        change: {
          path: toProjectPath(this.options.cwd, absolutePath),
          contents,
          ...(normalizedEncoding === 'base64'
            ? { encoding: 'base64' as const }
            : {}),
        },
        phase,
        actor,
      },
      process
    );
  }

  async writeFiles(files: readonly RuntimeFile[]): Promise<void> {
    for (const file of files) {
      await this.writeFile(file.path, file.contents, file.encoding);
    }
  }

  async writeSkillFiles(files: readonly RuntimeFile[]): Promise<void> {
    await this.writeSkillFilesAs(files, this.systemActor);
  }

  async writeSkillFilesAs(
    files: readonly RuntimeFile[],
    actor: RuntimeWorkspaceActor = this.systemActor
  ): Promise<void> {
    this.options.assertNotDestroyed();
    this.options.virtualFiles.writeSkillFiles(files, (absolutePath) => {
      this.options.assertActorFileCapability(actor, 'write', absolutePath);
    });
    this.options.invalidateSnapshotCache();
  }

  async appendFile(
    path: string,
    contents: string,
    encoding?: RuntimeFileEncoding
  ): Promise<void> {
    this.options.ensureUsableForMutation('append');
    this.options.accessPolicy.assertDynamicVirtualWritable(path, 'append');
    const normalizedEncoding = assertSupportedEncoding(encoding);
    const writeTarget = kernelWriteTarget(path);
    if (writeTarget.kind === 'error') {
      throwKernelWriteTargetError(path, writeTarget);
    }
    if (writeTarget.kind === 'device') {
      this.options.writeDevice(
        writeTarget.device,
        normalizedEncoding === 'base64'
          ? new TextDecoder().decode(bytesFromBase64(contents))
          : contents,
        this.principalActor
      );
      return;
    }
    const absolutePath = this.toWorkspacePath(path);
    const mutationKind = (await this.options.fileSystem.exists(absolutePath))
      ? 'file-write'
      : 'file-create';
    const nextBytes =
      normalizedEncoding === 'base64'
        ? bytesFromBase64(contents)
        : new TextEncoder().encode(contents);
    const bytes = await this.options.fileSystem.withBaseMutation(
      [absolutePath],
      async (fileSystem) => {
        this.options.accessPolicy.assertWorkspacePathWritable(
          absolutePath,
          'append'
        );
        await fileSystem.appendFile(absolutePath, nextBytes);
        return fileSystem.readFileBuffer(absolutePath);
      },
      mutationKind
    );
    this.options.emitFileChange({
      type: 'file-change',
      change:
        normalizedEncoding === 'base64'
          ? {
              path: toProjectPath(this.options.cwd, absolutePath),
              contents: base64FromBytes(bytes),
              encoding: 'base64',
            }
          : {
              path: toProjectPath(this.options.cwd, absolutePath),
              contents: new TextDecoder().decode(bytes),
            },
      phase: 'live',
      actor: this.principalActor,
    });
  }

  async readFile(
    path: string,
    encoding?: RuntimeFileEncoding,
    options: { publicProc?: boolean } = {}
  ): Promise<string> {
    this.options.assertNotDestroyed();
    const dynamicVirtualFile = this.options.virtualFiles.readFile(path);
    if (dynamicVirtualFile !== null) {
      if (encoding === 'base64') {
        throw new Error(
          `Kernel virtual path does not support base64 reads: ${path}`
        );
      }
      return dynamicVirtualFile;
    }
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind === 'proc-file') {
      if (encoding === 'base64') {
        throw new Error(
          `Kernel proc path does not support base64 reads: ${path}`
        );
      }
      return options.publicProc === false
        ? readRuntimeProcFile(readTarget.path, this.options.kernelInfo)
        : readPublicRuntimeProcFile(readTarget.path, this.options.kernelInfo);
    }
    if (readTarget.kind === 'proc-directory') {
      throw new Error(`Kernel proc path is a directory: ${path}`);
    }
    if (readTarget.kind === 'device-file') {
      const contents = this.options.readDevice(readTarget.path);
      return encoding === 'base64'
        ? base64FromBytes(new TextEncoder().encode(contents))
        : contents;
    }
    if (readTarget.kind === 'device-directory') {
      throw new Error(`Kernel device path is a directory: ${path}`);
    }
    if (readTarget.kind === 'error') {
      throwKernelReadTargetError(path, readTarget);
    }
    const normalizedEncoding = assertSupportedEncoding(encoding);
    const absolutePath = this.toWorkspacePath(path);
    this.options.accessPolicy.assertWorkspacePathVisible(
      absolutePath,
      'open'
    );
    if (normalizedEncoding === 'base64') {
      return base64FromBytes(
        await this.options.fileSystem.readFileBuffer(absolutePath)
      );
    }
    return this.options.fileSystem.readFile(absolutePath);
  }

  async exists(path: string): Promise<boolean> {
    this.options.assertNotDestroyed();
    if (this.options.virtualFiles.entryKind(path) !== null) return true;
    const accessTarget = kernelAccessTarget(path);
    if (accessTarget.kind === 'allowed') return true;
    if (accessTarget.kind === 'denied') return false;
    const absolutePath = this.toWorkspaceEntryPath(path);
    if (this.options.accessPolicy.isWorkspacePathHidden(absolutePath)) {
      return false;
    }
    return this.options.fileSystem.exists(absolutePath);
  }

  async stat(path: string): Promise<RuntimeWorkspaceStat> {
    this.options.assertNotDestroyed();
    const dynamicStat = this.options.virtualFiles.stat(path);
    if (dynamicStat) return this.virtualStat(dynamicStat);
    const statTarget = kernelStatTarget(path, this.options.kernelInfo);
    if (statTarget.kind === 'stat') return this.virtualStat(statTarget.stat);
    if (statTarget.kind === 'error') {
      throw new Error(`Kernel virtual path not found: ${path}`);
    }
    const absolutePath = this.toWorkspaceEntryPath(path);
    this.options.accessPolicy.assertWorkspacePathVisible(
      absolutePath,
      'stat'
    );
    const stat = await this.options.fileSystem.stat(absolutePath);
    return {
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
      mode: stat.mode,
      size: stat.size,
      mtimeMs:
        stat.mtime instanceof Date ? stat.mtime.getTime() : undefined,
      nlink:
        typeof (stat as { nlink?: unknown }).nlink === 'number'
          ? (stat as { nlink?: number }).nlink
          : 1,
      ino: this.options.fileSystem.inodeForPath(absolutePath),
    };
  }

  async readDir(path = '.'): Promise<string[]> {
    this.options.assertNotDestroyed();
    const dynamicEntries = this.options.virtualFiles.readDir(path);
    if (dynamicEntries) {
      return dynamicEntries.map((entry) => entry.name);
    }
    const directoryTarget = kernelDirectoryTarget(path);
    if (directoryTarget.kind === 'directory') {
      return directoryTarget.entries.map((entry) => entry.name);
    }
    if (directoryTarget.kind === 'error') {
      throw new Error(
        directoryTarget.reason === 'not-directory'
          ? `Kernel virtual path is not a directory: ${path}`
          : `Kernel virtual path not found: ${path}`
      );
    }
    const absoluteDirectoryPath = this.toWorkspaceEntryPath(path);
    this.options.accessPolicy.assertWorkspacePathVisible(
      absoluteDirectoryPath,
      'scandir'
    );
    const entries = await this.options.fileSystem.readdir(
      absoluteDirectoryPath
    );
    const directoryPath =
      absoluteDirectoryPath === this.options.cwd
        ? ''
        : toProjectPath(this.options.cwd, absoluteDirectoryPath);
    return [...entries]
      .filter((entry) => {
        const entryPath = directoryPath
          ? `${directoryPath}/${entry}`
          : entry;
        return !this.options.accessPolicy.isProjectPathHidden(entryPath);
      })
      .sort((left, right) => left.localeCompare(right));
  }

  async mkdir(path: string): Promise<void> {
    this.options.ensureUsableForMutation('mkdir');
    this.options.accessPolicy.assertDynamicVirtualWritable(path, 'mkdir');
    const mkdirTarget = kernelMkdirTarget(path);
    if (mkdirTarget.kind === 'error') {
      throwKernelMutationTargetError(path, mkdirTarget);
    }
    const absolutePath = this.toWorkspaceEntryPath(path);
    let createdDirectories: string[] = [];
    await this.options.fileSystem.withBaseMutation(
      [absolutePath],
      async (fileSystem) => {
        this.options.accessPolicy.assertWorkspacePathWritable(
          absolutePath,
          'mkdir'
        );
        createdDirectories =
          await this.collectMissingWorkspaceDirectories(absolutePath);
        await fileSystem.mkdir(absolutePath, { recursive: true });
      },
      'directory-create'
    );
    for (const relativePath of createdDirectories) {
      this.options.emitFileChange({
        type: 'file-change',
        change: { path: relativePath, directory: true },
        phase: 'live',
        actor: this.principalActor,
      });
    }
  }

  async copyFile(
    sourcePath: string,
    destinationPath: string
  ): Promise<void> {
    this.options.ensureUsableForMutation('copy');
    this.options.accessPolicy.assertDynamicVirtualWritable(
      destinationPath,
      'copy'
    );
    const dynamicSourceFile =
      this.options.virtualFiles.readFile(sourcePath);
    if (dynamicSourceFile !== null) {
      await this.writeFileAs(
        destinationPath,
        dynamicSourceFile,
        this.principalActor,
        undefined,
        'live'
      );
      return;
    }
    const copyTarget = kernelFileCopyTarget(sourcePath, destinationPath);
    if (
      copyTarget.kind === 'virtual-source' ||
      copyTarget.kind === 'device-destination'
    ) {
      await this.copyFileLike(sourcePath, destinationPath, copyTarget);
      return;
    }
    if (copyTarget.kind === 'error') {
      throw new Error(
        copyTarget.reason === 'is-directory'
          ? `Kernel virtual path is a directory: ${sourcePath}`
          : copyTarget.side === 'destination'
            ? `Kernel virtual destination is not writable: ${destinationPath}`
            : `Kernel virtual path not found: ${sourcePath}`
      );
    }
    const absoluteDestinationPath = this.toWorkspacePath(destinationPath);
    const absoluteSourcePath = this.toWorkspacePath(sourcePath);
    this.options.accessPolicy.assertWorkspacePathVisible(
      absoluteSourcePath,
      'open'
    );
    const sourceBytes = await this.options.fileSystem.withBaseMutation(
      [absoluteSourcePath, absoluteDestinationPath],
      async (fileSystem) => {
        this.options.accessPolicy.assertWorkspacePathWritable(
          absoluteDestinationPath,
          'copy'
        );
        const bytes = await fileSystem.readFileBuffer(absoluteSourcePath);
        await fileSystem.writeFile(absoluteDestinationPath, bytes);
        return bytes;
      },
      'copy'
    );
    this.options.emitFileChange({
      type: 'file-change',
      change: {
        path: toProjectPath(
          this.options.cwd,
          absoluteDestinationPath
        ),
        contents: base64FromBytes(sourceBytes),
        encoding: 'base64',
      },
      phase: 'live',
      actor: this.principalActor,
    });
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string
  ): Promise<void> {
    this.options.ensureUsableForMutation('move');
    this.options.accessPolicy.assertDynamicVirtualWritable(
      sourcePath,
      'move'
    );
    this.options.accessPolicy.assertDynamicVirtualWritable(
      destinationPath,
      'move'
    );
    const renameTarget = kernelRenameTarget(sourcePath, destinationPath);
    if (renameTarget.kind === 'error') {
      throw new Error(
        'Kernel virtual paths are read-only for move operations.'
      );
    }
    const absoluteSourcePath = this.toWorkspacePath(sourcePath);
    const absoluteDestinationPath = this.toWorkspacePath(destinationPath);
    let sourceBytes =
      new Uint8Array() as Awaited<
        ReturnType<IFileSystem['readFileBuffer']>
      >;
    await this.options.fileSystem.withBaseMutation(
      [absoluteSourcePath, absoluteDestinationPath],
      async (fileSystem) => {
        this.options.accessPolicy.assertWorkspaceSubtreeWritable(
          this.toWorkspaceEntryPath(sourcePath),
          'move'
        );
        this.options.accessPolicy.assertWorkspaceSubtreeWritable(
          this.toWorkspaceEntryPath(destinationPath),
          'move'
        );
        this.options.accessPolicy.assertWorkspacePathWritable(
          absoluteDestinationPath,
          'move'
        );
        sourceBytes = await fileSystem.readFileBuffer(absoluteSourcePath);
        await fileSystem.mv(
          absoluteSourcePath,
          absoluteDestinationPath
        );
      },
      'rename'
    );
    this.options.fileSystem.moveInode(
      absoluteSourcePath,
      absoluteDestinationPath
    );
    this.options.emitFileChange({
      type: 'file-change',
      change: {
        path: toProjectPath(
          this.options.cwd,
          absoluteDestinationPath
        ),
        contents: base64FromBytes(sourceBytes),
        encoding: 'base64',
      },
      phase: 'live',
      actor: this.principalActor,
    });
    this.options.emitFileChange({
      type: 'file-change',
      change: {
        path: this.toWorkspaceRelativePath(sourcePath),
        deleted: true,
      },
      phase: 'live',
      actor: this.principalActor,
    });
  }

  async deleteFile(path: string): Promise<void> {
    this.options.ensureUsableForMutation('delete');
    this.options.accessPolicy.assertDynamicVirtualWritable(path, 'delete');
    const removeTarget = kernelRemoveTarget(path);
    if (removeTarget.kind === 'error') {
      throwKernelMutationTargetError(path, removeTarget);
    }
    const absolutePath = this.toWorkspacePath(path);
    await this.options.fileSystem.withBaseMutation(
      [absolutePath],
      async (fileSystem) => {
        this.options.accessPolicy.assertWorkspacePathWritable(
          absolutePath,
          'delete'
        );
        await fileSystem.rm(absolutePath, { force: true });
      },
      'delete'
    );
    this.options.emitFileChange({
      type: 'file-change',
      change: {
        path: this.toWorkspaceRelativePath(path),
        deleted: true,
      },
      phase: 'live',
      actor: this.principalActor,
    });
  }

  async remove(
    path: string,
    options: RuntimeWorkspaceRemoveOptions = {}
  ): Promise<void> {
    this.options.ensureUsableForMutation('remove');
    this.options.accessPolicy.assertDynamicVirtualWritable(path, 'remove');
    const removeTarget = kernelRemoveTarget(path);
    if (removeTarget.kind === 'error') {
      throwKernelMutationTargetError(path, removeTarget);
    }
    let deletedChanges: RuntimeFileChange[] = [];
    const absolutePath = this.toWorkspaceEntryPath(path);
    await this.options.fileSystem.withBaseMutation(
      [absolutePath],
      async (fileSystem) => {
        deletedChanges = await this.collectDeletedChangesForRemove(
          path,
          options,
          fileSystem
        );
        this.options.accessPolicy.assertWorkspaceSubtreeWritable(
          absolutePath,
          'remove'
        );
        await fileSystem.rm(absolutePath, {
          force: options.force ?? true,
          recursive: options.recursive,
        });
      },
      options.recursive ? 'recursive-delete' : 'delete'
    );
    for (const change of deletedChanges) {
      this.options.emitFileChange({
        type: 'file-change',
        change,
        phase: 'live',
        actor: this.principalActor,
      });
    }
  }

  private virtualStat(stat: {
    readonly isFile: boolean;
    readonly isDirectory: boolean;
    readonly mode: number;
    readonly size: number;
    readonly uid?: number;
    readonly gid?: number;
    readonly owner?: string;
    readonly group?: string;
  }): RuntimeWorkspaceStat {
    return {
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
      mode: stat.mode,
      size: stat.size,
      mtimeMs: 0,
      nlink: stat.isDirectory ? 2 : 1,
      uid: stat.uid,
      gid: stat.gid,
      owner: stat.owner,
      group: stat.group,
    };
  }

  private async copyFileLike(
    sourcePath: string,
    destinationPath: string,
    copyTarget: Exclude<
      ReturnType<typeof kernelFileCopyTarget>,
      { kind: 'workspace' | 'error' }
    >
  ): Promise<void> {
    const sourceBytes = await this.readKernelCopyBytes(
      sourcePath,
      copyTarget.source
    );
    if (copyTarget.kind === 'device-destination') {
      this.options.writeDevice(
        copyTarget.device,
        contentToText(sourceBytes),
        this.principalActor
      );
      return;
    }
    await this.writeFileAs(
      destinationPath,
      base64FromBytes(sourceBytes),
      this.principalActor,
      'base64',
      'live'
    );
  }

  private async readKernelCopyBytes(
    sourcePath: string,
    sourceTarget: ReturnType<typeof kernelFileReadTarget> =
      kernelFileReadTarget(sourcePath)
  ): Promise<Uint8Array> {
    const dynamicSourceFile =
      this.options.virtualFiles.readFile(sourcePath);
    if (dynamicSourceFile !== null) {
      return new TextEncoder().encode(dynamicSourceFile);
    }
    if (sourceTarget.kind === 'device-file') {
      return new TextEncoder().encode(
        this.options.readDevice(sourceTarget.path)
      );
    }
    if (sourceTarget.kind === 'proc-file') {
      return new TextEncoder().encode(
        readPublicRuntimeProcFile(
          sourceTarget.path,
          this.options.kernelInfo
        )
      );
    }
    if (sourceTarget.kind === 'error') {
      throw new Error(
        sourceTarget.reason === 'is-directory'
          ? `Kernel virtual path is a directory: ${sourcePath}`
          : `Kernel virtual path not found: ${sourcePath}`
      );
    }
    const absolutePath = this.toWorkspacePath(sourcePath);
    this.options.accessPolicy.assertWorkspacePathVisible(
      absolutePath,
      'open'
    );
    return this.options.fileSystem.readFileBuffer(absolutePath);
  }

  private async collectMissingWorkspaceDirectories(
    absolutePath: string
  ): Promise<string[]> {
    if (
      !isWithinWorkspace(this.options.cwd, absolutePath) ||
      absolutePath === this.options.cwd
    ) {
      return [];
    }
    const relativeParts = toProjectPath(
      this.options.cwd,
      absolutePath
    )
      .split('/')
      .filter(Boolean);
    const missing: string[] = [];
    let current = this.options.cwd;
    for (const part of relativeParts) {
      current = `${current}/${part}`;
      if (!(await this.options.fileSystem.exists(current))) {
        missing.push(toProjectPath(this.options.cwd, current));
      }
    }
    return missing;
  }

  private async collectDeletedChangesForRemove(
    path: string,
    options: RuntimeWorkspaceRemoveOptions,
    fileSystem: IFileSystem = this.options.fileSystem
  ): Promise<RuntimeFileChange[]> {
    const absolutePath = this.toWorkspaceEntryPath(path);
    if (!(await fileSystem.exists(absolutePath))) return [];
    const stat = await fileSystem.stat(absolutePath);
    if (stat.isFile) {
      return [
        {
          path: toProjectPath(this.options.cwd, absolutePath),
          deleted: true,
        },
      ];
    }
    if (!stat.isDirectory || !options.recursive) return [];

    const files: RuntimeFile[] = [];
    const directories: string[] = [];
    const symlinks: RuntimeSymlink[] = [];
    await collectSnapshotFiles(
      fileSystem,
      this.options.cwd,
      absolutePath,
      files,
      directories,
      symlinks
    );
    const directoryPath = toProjectDirectoryPath(
      this.options.cwd,
      absolutePath
    );
    const deletedDirectories = [
      ...directories,
      ...(directoryPath ? [directoryPath] : []),
    ].sort((left, right) => right.localeCompare(left));
    return [
      ...files.map(
        (file): RuntimeFileDeletion => ({
          path: file.path,
          deleted: true,
        })
      ),
      ...symlinks.map(
        (symlink): RuntimeFileDeletion => ({
          path: symlink.path,
          deleted: true,
        })
      ),
      ...deletedDirectories.map(
        (deletedPath): RuntimeDirectoryChange => ({
          path: deletedPath,
          directory: true,
          deleted: true,
        })
      ),
    ];
  }

  private toWorkspacePath(path: string): string {
    return toWorkspacePath(
      this.options.cwd,
      path,
      this.options.kernelInfo.workspaceAlias
    );
  }

  private toWorkspaceEntryPath(path: string): string {
    return toWorkspaceEntryPath(
      this.options.cwd,
      path,
      this.options.kernelInfo.workspaceAlias
    );
  }

  private toWorkspaceRelativePath(path: string): string {
    return toWorkspaceRelativePath(
      this.options.cwd,
      path,
      this.options.kernelInfo.workspaceAlias
    );
  }
}

import {
  RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGES,
  RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES,
  runtimeProjectUtf8Bytes,
} from '@tracecode/runtime-core';
import type {
  RuntimeFileChange,
} from '@tracecode/runtime-core';
import type {
  IFileSystem,
} from 'just-bash/browser';
import {
  base64FromBytes,
  decodeUtf8,
} from '../file-content';
import {
  isWithinWorkspace,
  toProjectPath,
} from '../paths';

interface RuntimeLiveFileChangeContext {
  readonly process: {
    readonly pid: number;
  };
}

/**
 * Projects committed filesystem mutations into bounded, learner-visible live
 * file-change events. The authoritative filesystem remains the source of
 * truth; this projector only observes it after a mutation commits.
 */
export class RuntimeLiveFileChangeProjector<
  TContext extends RuntimeLiveFileChangeContext,
> {
  private budgetPid: number | undefined;
  private changeCount = 0;
  private changeBytes = 0;

  constructor(
    private readonly fs: IFileSystem,
    private readonly workspaceRoot: () => string,
    private readonly notificationsSuspended: () => boolean,
    private readonly onFileChange: (
      context: TContext | undefined,
      change: RuntimeFileChange
    ) => void
  ) {}

  async emitExistingFiles(context: TContext | undefined, path: string): Promise<void> {
    for (const filePath of await this.collectExistingFiles(path)) {
      await this.emitFileWrite(context, filePath);
    }
  }

  async emitExistingDirectories(context: TContext | undefined, path: string): Promise<void> {
    for (const directoryPath of await this.collectExistingDirectories(path)) {
      this.emitDirectoryCreate(context, directoryPath);
    }
  }

  async collectMissingDirectories(path: string): Promise<string[]> {
    const root = this.workspaceRoot();
    if (!isWithinWorkspace(root, path)) return [];
    if (path === root) return [];
    const relativeParts = toProjectPath(root, path).split('/').filter(Boolean);
    const missing: string[] = [];
    let current = root;
    for (const part of relativeParts) {
      current = `${current}/${part}`;
      if (!(await this.fs.exists(current))) missing.push(current);
    }
    return missing;
  }

  async collectExistingFiles(path: string): Promise<string[]> {
    if (!isWithinWorkspace(this.workspaceRoot(), path) || !(await this.fs.exists(path))) return [];
    const stat = await this.fs.stat(path);
    if (stat.isFile) return [path];
    if (!stat.isDirectory) return [];
    const files: string[] = [];
    for (const entry of await this.fs.readdir(path)) {
      files.push(...await this.collectExistingFiles(`${path}/${entry}`));
    }
    return files;
  }

  async collectExistingDirectories(path: string): Promise<string[]> {
    if (!isWithinWorkspace(this.workspaceRoot(), path) || !(await this.fs.exists(path))) return [];
    const stat = await this.fs.stat(path);
    if (!stat.isDirectory) return [];
    const directories: string[] = [];
    for (const entry of await this.fs.readdir(path)) {
      directories.push(...await this.collectExistingDirectories(`${path}/${entry}`));
    }
    directories.push(path);
    return directories.filter((directoryPath) => directoryPath !== this.workspaceRoot());
  }

  async emitFileWrite(context: TContext | undefined, path: string): Promise<void> {
    if (this.notificationsSuspended() || !isWithinWorkspace(this.workspaceRoot(), path)) return;
    const projectPath = toProjectPath(this.workspaceRoot(), path);
    const stat = await this.fs.stat(path).catch(() => null);
    if (!stat?.isFile) return;
    const contentBytes = this.liveFileChangeContentBytes(stat);
    if (contentBytes === null || !this.tryReserve(context, projectPath, contentBytes)) return;
    const bytes = await this.fs.readFileBuffer(path);
    const text = decodeUtf8(bytes);
    this.onFileChange(context, {
      path: projectPath,
      contents: text ?? base64FromBytes(bytes),
      ...(text === null ? { encoding: 'base64' as const } : {}),
    });
  }

  emitFileDelete(context: TContext | undefined, path: string): void {
    if (this.notificationsSuspended() || !isWithinWorkspace(this.workspaceRoot(), path)) return;
    const projectPath = toProjectPath(this.workspaceRoot(), path);
    if (!this.tryReserve(context, projectPath)) return;
    this.onFileChange(context, { path: projectPath, deleted: true });
  }

  emitSymlinkCreate(context: TContext | undefined, path: string, target: string): void {
    if (this.notificationsSuspended() || !isWithinWorkspace(this.workspaceRoot(), path)) return;
    const projectPath = toProjectPath(this.workspaceRoot(), path);
    if (!this.tryReserve(context, projectPath, runtimeProjectUtf8Bytes(target))) return;
    this.onFileChange(context, { path: projectPath, symlink: true, target });
  }

  emitDirectoryCreate(context: TContext | undefined, path: string): void {
    if (
      this.notificationsSuspended()
      || !isWithinWorkspace(this.workspaceRoot(), path)
      || path === this.workspaceRoot()
    ) return;
    const projectPath = toProjectPath(this.workspaceRoot(), path);
    if (!this.tryReserve(context, projectPath)) return;
    this.onFileChange(context, { path: projectPath, directory: true });
  }

  emitDirectoryDelete(context: TContext | undefined, path: string): void {
    if (
      this.notificationsSuspended()
      || !isWithinWorkspace(this.workspaceRoot(), path)
      || path === this.workspaceRoot()
    ) return;
    const projectPath = toProjectPath(this.workspaceRoot(), path);
    if (!this.tryReserve(context, projectPath)) return;
    this.onFileChange(context, { path: projectPath, directory: true, deleted: true });
  }

  private resetBudgetFor(pid: number): void {
    if (this.budgetPid === pid) return;
    this.budgetPid = pid;
    this.changeCount = 0;
    this.changeBytes = 0;
  }

  private liveFileChangeContentBytes(stat: Awaited<ReturnType<IFileSystem['stat']>>): number | null {
    const size = (stat as { size?: unknown }).size;
    if (typeof size === 'number') return Number.isFinite(size) && size >= 0 ? Math.floor(size) : null;
    if (typeof size === 'bigint') {
      if (size < BigInt(0) || size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      return Number(size);
    }
    return null;
  }

  private tryReserve(
    context: TContext | undefined,
    relativePath: string,
    contentBytes = 0
  ): boolean {
    if (!context) return false;
    this.resetBudgetFor(context.process.pid);
    const eventBytes = runtimeProjectUtf8Bytes(relativePath) + contentBytes;
    if (this.changeCount + 1 > RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGES) return false;
    if (eventBytes > RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES) return false;
    if (this.changeBytes + eventBytes > RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES) return false;
    this.changeCount += 1;
    this.changeBytes += eventBytes;
    return true;
  }
}

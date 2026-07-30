import {
  createRuntimeKernelReadonlyFileError,
} from '@tracecode/runtime-core';
import {
  isRuntimeSkillsNamespacePath,
  isTraceKernelVirtualNamespacePath,
  isWithinWorkspace,
  normalizeRuntimeProjectPath,
  toProjectDirectoryPath,
  toProjectPath,
  toWorkspacePath,
} from './paths';

export interface WorkspaceAccessPolicyOptions {
  readonly cwd: string;
  readonly workspaceAlias?: string;
  readonly readonlyFiles: ReadonlySet<string>;
  readonly hiddenFiles: readonly string[];
  readonly ensureUsableForMutation: (operation: string) => void;
}

/**
 * Filesystem visibility and mutability policy for one workspace.
 *
 * Lifecycle expiration remains a workspace concern. The workspace exposes it
 * through `ensureUsableForMutation`, while this object owns path policy and
 * the narrowly scoped readonly-policy suspension used by trusted imports.
 */
export class WorkspaceAccessPolicy {
  private readonlySuspendDepth = 0;

  constructor(private readonly options: WorkspaceAccessPolicyOptions) {}

  isReadOnly(path: string): boolean {
    return this.isWorkspacePathReadOnly(
      toWorkspacePath(
        this.options.cwd,
        path,
        this.options.workspaceAlias
      )
    );
  }

  isReadonlyPolicySuspended(): boolean {
    return this.readonlySuspendDepth > 0;
  }

  assertDynamicVirtualWritable(path: string, operation: string): void {
    if (
      !isTraceKernelVirtualNamespacePath(path) &&
      !isRuntimeSkillsNamespacePath(path)
    ) {
      return;
    }
    throw Object.assign(
      new Error(`EROFS: read-only file system, ${operation} '${path}'`),
      { code: 'EROFS' }
    );
  }

  isWorkspacePathReadOnly(absolutePath: string): boolean {
    if (
      !isWithinWorkspace(this.options.cwd, absolutePath) ||
      absolutePath === this.options.cwd
    ) {
      return false;
    }
    const relativePath = toProjectPath(this.options.cwd, absolutePath);
    return [...this.options.readonlyFiles].some(
      (path) =>
        path === relativePath || relativePath.startsWith(`${path}/`)
    );
  }

  isProjectPathHidden(path: string): boolean {
    const normalized = normalizeRuntimeProjectPath(path);
    return this.options.hiddenFiles.some((hiddenPath) => {
      if (
        hiddenPath === normalized ||
        hiddenPath.startsWith(`${normalized}/`)
      ) {
        return true;
      }
      const separatorIndex = hiddenPath.lastIndexOf('/');
      if (separatorIndex <= 0) return false;
      const hiddenDirectory = hiddenPath.slice(0, separatorIndex);
      return (
        normalized === hiddenDirectory ||
        normalized.startsWith(`${hiddenDirectory}/`)
      );
    });
  }

  isWorkspacePathHidden(absolutePath: string): boolean {
    if (
      !isWithinWorkspace(this.options.cwd, absolutePath) ||
      absolutePath === this.options.cwd
    ) {
      return false;
    }
    return this.isProjectPathHidden(
      toProjectPath(this.options.cwd, absolutePath)
    );
  }

  assertWorkspacePathVisible(
    absolutePath: string,
    operation: string
  ): void {
    if (!this.isWorkspacePathHidden(absolutePath)) return;
    throw Object.assign(
      new Error(
        `ENOENT: no such file or directory, ${operation} '${toProjectPath(
          this.options.cwd,
          absolutePath
        )}'`
      ),
      { code: 'ENOENT' }
    );
  }

  assertWorkspacePathWritable(
    absolutePath: string,
    operation: string
  ): void {
    this.options.ensureUsableForMutation(operation);
    if (this.isPathOutsideWritableMounts(absolutePath)) {
      throw Object.assign(
        new Error(
          `EROFS: read-only file system, ${operation} '${absolutePath}'`
        ),
        { code: 'EROFS' }
      );
    }
    if (
      !this.isReadonlyPolicySuspended() &&
      this.isWorkspacePathHidden(absolutePath)
    ) {
      throw Object.assign(
        new Error(
          `EROFS: hidden project path is read-only, ${operation} '${toProjectPath(
            this.options.cwd,
            absolutePath
          )}'`
        ),
        { code: 'EROFS' }
      );
    }
    if (
      this.isReadonlyPolicySuspended() ||
      !this.isWorkspacePathReadOnly(absolutePath)
    ) {
      return;
    }
    throw createRuntimeKernelReadonlyFileError(
      toProjectPath(this.options.cwd, absolutePath),
      operation
    );
  }

  assertWorkspaceSubtreeWritable(
    absolutePath: string,
    operation: string
  ): void {
    this.options.ensureUsableForMutation(operation);
    if (this.isPathOutsideWritableMounts(absolutePath)) {
      throw Object.assign(
        new Error(
          `EROFS: read-only file system, ${operation} '${absolutePath}'`
        ),
        { code: 'EROFS' }
      );
    }
    if (
      !this.isReadonlyPolicySuspended() &&
      this.isWorkspacePathHidden(absolutePath)
    ) {
      throw Object.assign(
        new Error(
          `EROFS: hidden project subtree is read-only, ${operation} '${toProjectDirectoryPath(
            this.options.cwd,
            absolutePath
          )}'`
        ),
        { code: 'EROFS' }
      );
    }
    if (
      this.isReadonlyPolicySuspended() ||
      !this.isWorkspaceSubtreeReadOnly(absolutePath)
    ) {
      return;
    }
    throw Object.assign(
      new Error(
        `EROFS: readonly project subtree, ${operation} '${toProjectDirectoryPath(
          this.options.cwd,
          absolutePath
        )}'`
      ),
      { code: 'EROFS' }
    );
  }

  async withSuspendedReadonlyPolicy<T>(
    fn: () => Promise<T>
  ): Promise<T> {
    this.readonlySuspendDepth += 1;
    try {
      return await fn();
    } finally {
      this.readonlySuspendDepth -= 1;
    }
  }

  private isWorkspaceSubtreeReadOnly(absolutePath: string): boolean {
    if (!isWithinWorkspace(this.options.cwd, absolutePath)) return false;
    if (this.isWorkspacePathReadOnly(absolutePath)) return true;
    const relativePath =
      absolutePath === this.options.cwd
        ? ''
        : toProjectDirectoryPath(this.options.cwd, absolutePath);
    const prefix = relativePath ? `${relativePath}/` : '';
    return [...this.options.readonlyFiles].some((path) =>
      path.startsWith(prefix)
    );
  }

  private isPathOutsideWritableMounts(absolutePath: string): boolean {
    return (
      !isWithinWorkspace(this.options.cwd, absolutePath) &&
      !isWithinWorkspace('/tmp', absolutePath) &&
      !isWithinWorkspace('/var/tmp', absolutePath)
    );
  }
}

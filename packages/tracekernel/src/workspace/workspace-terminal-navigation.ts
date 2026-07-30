import type {
  RuntimeCommandCompletion,
  RuntimeCommandCompletionMatch,
  RuntimeCommandCompletionOptions,
  RuntimeKernelInfo,
} from '@tracecode/runtime-contracts';
import type {
  IFileSystem,
} from 'just-bash/browser';
import {
  kernelDirectoryTarget,
  kernelStatTarget,
} from './fs-observed';
import {
  isWithinWorkspace,
  mapWorkspaceAlias,
  normalizeTerminalAbsolutePath,
  toProjectPath,
  toWorkspacePath,
} from './paths';
import {
  commandInputTokenBounds,
  longestCommonPrefix,
} from './terminal-session';
import type {
  WorkspaceVirtualFileSystem,
} from './workspace-virtual-filesystem';

export interface WorkspaceTerminalNavigationOptions {
  readonly cwd: string;
  readonly kernelInfo: RuntimeKernelInfo;
  readonly fileSystem: IFileSystem;
  readonly virtualFiles: WorkspaceVirtualFileSystem;
  readonly isProjectPathHidden: (path: string) => boolean;
}

/**
 * Resolves terminal working directories and path completions.
 *
 * Navigation is intentionally home-bounded for interactive sessions while
 * command execution remains workspace-bounded when the workspace sits outside
 * the configured home directory.
 */
export class WorkspaceTerminalNavigation {
  constructor(private readonly options: WorkspaceTerminalNavigationOptions) {}

  resolvePath(currentCwd: string, target: string): string {
    return this.resolvePathInRoot(
      currentCwd,
      target,
      this.options.cwd,
      'the workspace'
    );
  }

  resolveNavigationPath(currentCwd: string, target: string): string {
    return this.resolvePathInRoot(
      currentCwd,
      target,
      this.options.kernelInfo.home,
      'home'
    );
  }

  resolveCommandCwd(target: string): string {
    return isWithinWorkspace(
      this.options.kernelInfo.home,
      this.options.cwd
    )
      ? this.resolveNavigationPath(this.options.cwd, target)
      : toWorkspacePath(
          this.options.cwd,
          target,
          this.options.kernelInfo.workspaceAlias
        );
  }

  async resolveTerminalCwd(
    currentCwd: string,
    target: string
  ): Promise<string> {
    const absolutePath = isWithinWorkspace(
      this.options.kernelInfo.home,
      this.options.cwd
    )
      ? this.resolveNavigationPath(currentCwd, target)
      : this.resolvePath(currentCwd, target);
    const statTarget = kernelStatTarget(
      absolutePath,
      this.options.kernelInfo
    );
    const stat =
      statTarget.kind === 'stat'
        ? { isDirectory: statTarget.stat.isDirectory }
        : await this.options.fileSystem.stat(absolutePath);
    if (!stat.isDirectory) {
      throw new Error(`not a directory: ${target}`);
    }
    return absolutePath;
  }

  async completeCommand(
    input: string,
    cursor: number,
    options: RuntimeCommandCompletionOptions = {}
  ): Promise<RuntimeCommandCompletion | null> {
    const cwd = options.cwd
      ? this.resolveNavigationPath(this.options.cwd, options.cwd)
      : this.options.cwd;
    const boundedCursor = Math.max(0, Math.min(cursor, input.length));
    const { start, end } = commandInputTokenBounds(input, boundedCursor);
    const token = input.slice(start, boundedCursor);
    if (!token || token.includes('"') || token.includes("'")) return null;

    let target: {
      listPath: string;
      partial: string;
      replacementPrefix: string;
    };
    try {
      target = this.completionTarget(token, cwd);
    } catch {
      return null;
    }

    let entries: string[];
    try {
      entries = await this.listDirectory(target.listPath);
    } catch {
      return null;
    }

    const matchingNames = entries.filter((entry) =>
      entry.startsWith(target.partial)
    );
    if (matchingNames.length === 0) return null;
    const matches: RuntimeCommandCompletionMatch[] = await Promise.all(
      matchingNames.map(async (name) => ({
        name,
        kind: await this.pathIsDirectory(
          normalizeTerminalAbsolutePath(`${target.listPath}/${name}`)
        )
          ? 'directory'
          : 'file',
      }))
    );
    const completedName =
      matchingNames.length === 1
        ? matchingNames[0]
        : longestCommonPrefix(matchingNames);
    if (
      !completedName ||
      (matchingNames.length > 1 && completedName === target.partial)
    ) {
      return {
        input,
        cursor: boundedCursor,
        matches,
        replacementChanged: false,
      };
    }

    const completedPath = normalizeTerminalAbsolutePath(
      `${target.listPath}/${completedName}`
    );
    const suffix =
      matchingNames.length === 1 &&
      (await this.pathIsDirectory(completedPath))
        ? '/'
        : matchingNames.length === 1
          ? ' '
          : '';
    const replacement = `${target.replacementPrefix}${completedName}${suffix}`;
    const nextInput = `${input.slice(0, start)}${replacement}${input.slice(
      end
    )}`;
    const nextCursor = start + replacement.length;
    return {
      input: nextInput,
      cursor: nextCursor,
      matches,
      replacementChanged:
        nextInput !== input || nextCursor !== boundedCursor,
    };
  }

  private resolvePathInRoot(
    currentCwd: string,
    target: string,
    root: string,
    rootLabel: string
  ): string {
    const rawTarget = target.trim() || this.options.cwd;
    const normalizedTarget =
      rawTarget === '~' ? this.options.kernelInfo.home : rawTarget;
    const absolutePath = normalizedTarget.startsWith('/')
      ? normalizeTerminalAbsolutePath(
          mapWorkspaceAlias(
            this.options.cwd,
            this.options.kernelInfo.workspaceAlias,
            normalizedTarget
          )
        )
      : normalizeTerminalAbsolutePath(`${currentCwd}/${normalizedTarget}`);
    if (!isWithinWorkspace(root, absolutePath)) {
      throw new Error(`path must stay inside ${rootLabel}: ${target}`);
    }
    return absolutePath;
  }

  private completionTarget(
    token: string,
    cwd: string
  ): { listPath: string; partial: string; replacementPrefix: string } {
    if (token === '~' || token.startsWith('~/')) {
      const afterHome = token === '~' ? '' : token.slice(2);
      const slashIndex = afterHome.lastIndexOf('/');
      if (slashIndex >= 0) {
        const parent = afterHome.slice(0, slashIndex);
        return {
          listPath: parent
            ? this.resolveNavigationPath(this.options.kernelInfo.home, parent)
            : this.options.kernelInfo.home,
          partial: afterHome.slice(slashIndex + 1),
          replacementPrefix: `~/${parent ? `${parent}/` : ''}`,
        };
      }
      return {
        listPath: this.options.kernelInfo.home,
        partial: afterHome,
        replacementPrefix: '~/',
      };
    }

    const slashIndex = token.lastIndexOf('/');
    if (slashIndex >= 0) {
      const parent = token.slice(0, slashIndex);
      return {
        listPath: this.resolveNavigationPath(cwd, parent || '/'),
        partial: token.slice(slashIndex + 1),
        replacementPrefix: token.slice(0, slashIndex + 1),
      };
    }

    return { listPath: cwd, partial: token, replacementPrefix: '' };
  }

  private async listDirectory(path: string): Promise<string[]> {
    const dynamicEntries = this.options.virtualFiles.readDir(path);
    if (dynamicEntries) {
      return dynamicEntries.map((entry) => entry.name).sort();
    }
    const directoryTarget = kernelDirectoryTarget(path);
    if (directoryTarget.kind === 'directory') {
      return directoryTarget.entries.map((entry) => entry.name).sort();
    }
    if (directoryTarget.kind === 'error') {
      throw new Error(
        directoryTarget.reason === 'not-directory'
          ? `Kernel virtual path is not a directory: ${path}`
          : `Kernel virtual path not found: ${path}`
      );
    }

    const entries = await this.options.fileSystem.readdir(path);
    return [...entries]
      .filter((entry) => {
        if (!isWithinWorkspace(this.options.cwd, path)) return true;
        const directoryPath =
          path === this.options.cwd
            ? ''
            : toProjectPath(this.options.cwd, path);
        const entryPath = directoryPath
          ? `${directoryPath}/${entry}`
          : entry;
        return !this.options.isProjectPathHidden(entryPath);
      })
      .sort((left, right) => left.localeCompare(right));
  }

  private async pathIsDirectory(path: string): Promise<boolean> {
    const dynamicKind = this.options.virtualFiles.entryKind(path);
    if (dynamicKind) return dynamicKind === 'directory';
    const statTarget = kernelStatTarget(path, this.options.kernelInfo);
    if (statTarget.kind === 'stat') return statTarget.stat.isDirectory;
    if (statTarget.kind === 'error') return false;
    try {
      return (await this.options.fileSystem.stat(path)).isDirectory;
    } catch {
      return false;
    }
  }
}

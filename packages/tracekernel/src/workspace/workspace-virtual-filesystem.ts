import {
  readRuntimeKernelIdentityFile,
  runtimeKernelIdentityDirEntries,
  runtimeKernelIdentityEntryKind,
  runtimeKernelIdentityStat,
  type RuntimeFile,
  type RuntimeKernelInfo,
  type RuntimeKernelVirtualStat,
} from '@tracecode/runtime-contracts';
import { TRACEKERNEL_SKILLS_ROOT } from './constants';
import {
  assertSupportedEncoding,
  bytesFromBase64,
  contentToText,
  type RuntimeCommandExecutionContext,
  type RuntimeDynamicProcEntry,
} from './fs-observed';
import {
  normalizeRuntimeSkillPath,
  normalizeRuntimeSkillsVirtualPath,
  runtimeSkillAbsolutePath,
} from './paths';
import type {
  WorkspaceCommandCatalog,
} from './workspace-command-catalog';
import type {
  WorkspaceProcFileSystem,
} from './workspace-proc-filesystem';

export interface WorkspaceVirtualFileSystemOptions {
  readonly kernelInfo: RuntimeKernelInfo;
  readonly commandCatalog: WorkspaceCommandCatalog;
  readonly procFiles: WorkspaceProcFileSystem;
}

/**
 * Composes the read-only namespaces projected into the workspace filesystem.
 *
 * `/proc` and `/tracekernel/bin` keep their own policy owners. This layer owns
 * skill assets and combines all virtual namespaces behind the dynamic
 * filesystem provider contract consumed by `KernelObservedFileSystem`.
 */
export class WorkspaceVirtualFileSystem {
  private readonly skillFiles = new Map<string, RuntimeFile>();

  constructor(private readonly options: WorkspaceVirtualFileSystemOptions) {}

  writeSkillFiles(
    files: readonly RuntimeFile[],
    authorize: (absolutePath: string) => void
  ): void {
    const nextFiles = new Map(this.skillFiles);
    for (const file of files) {
      const normalized = this.normalizeSkillFile(file);
      authorize(runtimeSkillAbsolutePath(normalized.path));
      for (const existingPath of nextFiles.keys()) {
        if (existingPath === normalized.path) continue;
        if (
          existingPath.startsWith(`${normalized.path}/`) ||
          normalized.path.startsWith(`${existingPath}/`)
        ) {
          throw new Error(
            `Skill path conflicts with an existing skill path: ${runtimeSkillAbsolutePath(normalized.path)}`
          );
        }
      }
      nextFiles.set(normalized.path, normalized);
    }
    this.skillFiles.clear();
    for (const [path, file] of nextFiles) {
      this.skillFiles.set(path, file);
    }
  }

  readFile(
    path: string,
    context?: RuntimeCommandExecutionContext
  ): string | null {
    const identityFile = this.readIdentityFile(path);
    if (identityFile !== null) return identityFile;
    const skillFile = this.readSkillFile(path);
    if (skillFile !== null) return skillFile;
    const traceKernelFile = this.options.commandCatalog.readFile(path);
    if (traceKernelFile !== null) return traceKernelFile;
    return this.options.procFiles.readFile(path, context);
  }

  readDir(
    path: string,
    context?: RuntimeCommandExecutionContext
  ): RuntimeDynamicProcEntry[] | null {
    return (
      this.readIdentityDir(path) ??
      this.readSkillDir(path) ??
      this.options.commandCatalog.readDir(path) ??
      this.options.procFiles.readDir(path, context)
    );
  }

  entryKind(
    path: string,
    context?: RuntimeCommandExecutionContext
  ): 'file' | 'directory' | null {
    return (
      runtimeKernelIdentityEntryKind(path) ??
      this.skillEntryKind(path) ??
      this.options.commandCatalog.entryKind(path) ??
      this.options.procFiles.entryKind(path, context)
    );
  }

  stat(
    path: string,
    context?: RuntimeCommandExecutionContext
  ): RuntimeKernelVirtualStat | null {
    return (
      runtimeKernelIdentityStat(path, this.options.kernelInfo) ??
      this.skillStat(path) ??
      this.options.commandCatalog.stat(path) ??
      this.options.procFiles.stat(path, context)
    );
  }

  private normalizeSkillFile(file: RuntimeFile): RuntimeFile {
    const normalizedEncoding = assertSupportedEncoding(file.encoding);
    return {
      path: normalizeRuntimeSkillPath(file.path),
      contents: file.contents,
      ...(normalizedEncoding === 'base64'
        ? { encoding: normalizedEncoding }
        : {}),
    };
  }

  private skillFileContent(file: RuntimeFile): string {
    return (file.encoding ?? 'utf8') === 'base64'
      ? contentToText(bytesFromBase64(file.contents))
      : file.contents;
  }

  private skillRelativePath(path: string): string | null {
    const normalized = normalizeRuntimeSkillsVirtualPath(path);
    if (!normalized || normalized === TRACEKERNEL_SKILLS_ROOT) return null;
    return normalizeRuntimeSkillPath(
      normalized.slice(TRACEKERNEL_SKILLS_ROOT.length + 1)
    );
  }

  private readSkillFile(path: string): string | null {
    const relativePath = this.skillRelativePath(path);
    if (!relativePath) return null;
    const file = this.skillFiles.get(relativePath);
    return file ? this.skillFileContent(file) : null;
  }

  private readSkillDir(path: string): RuntimeDynamicProcEntry[] | null {
    const normalized = normalizeRuntimeSkillsVirtualPath(path);
    if (!normalized) return null;
    const directoryPath =
      normalized === TRACEKERNEL_SKILLS_ROOT
        ? ''
        : normalizeRuntimeSkillPath(
            normalized.slice(TRACEKERNEL_SKILLS_ROOT.length + 1)
          );
    const prefix = directoryPath ? `${directoryPath}/` : '';
    const entries = new Map<string, RuntimeDynamicProcEntry>();
    for (const skillPath of this.skillFiles.keys()) {
      if (directoryPath && skillPath === directoryPath) continue;
      if (!skillPath.startsWith(prefix)) continue;
      const remainder = skillPath.slice(prefix.length);
      if (!remainder) continue;
      const [name, ...rest] = remainder.split('/');
      if (!name) continue;
      entries.set(name, {
        name,
        kind: rest.length > 0 ? 'directory' : 'file',
      });
    }
    if (normalized === TRACEKERNEL_SKILLS_ROOT) {
      return [...entries.values()].sort((left, right) =>
        left.name.localeCompare(right.name)
      );
    }
    return entries.size > 0
      ? [...entries.values()].sort((left, right) =>
          left.name.localeCompare(right.name)
        )
      : null;
  }

  private skillEntryKind(path: string): 'file' | 'directory' | null {
    if (this.readSkillDir(path)) return 'directory';
    return this.readSkillFile(path) !== null ? 'file' : null;
  }

  private skillStat(path: string): RuntimeKernelVirtualStat | null {
    const kind = this.skillEntryKind(path);
    if (!kind) return null;
    const content = kind === 'file' ? this.readSkillFile(path) ?? '' : '';
    return {
      isFile: kind === 'file',
      isDirectory: kind === 'directory',
      isCharacterDevice: false,
      mode: kind === 'directory' ? 0o555 : 0o444,
      size: new TextEncoder().encode(content).byteLength,
      uid: 0,
      gid: 0,
      owner: 'root',
      group: 'root',
    };
  }

  private readIdentityFile(path: string): string | null {
    return runtimeKernelIdentityEntryKind(path) === 'file'
      ? readRuntimeKernelIdentityFile(path, this.options.kernelInfo)
      : null;
  }

  private readIdentityDir(path: string): RuntimeDynamicProcEntry[] | null {
    const entries = runtimeKernelIdentityDirEntries(path);
    return (
      entries?.map((name) => ({ name, kind: 'file' as const })) ?? null
    );
  }
}

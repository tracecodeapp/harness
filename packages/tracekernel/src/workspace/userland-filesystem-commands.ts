import {
  runtimeKernelMounts,
  type RuntimeCommandResult,
  type RuntimeKernelInfo,
} from '@tracecode/runtime-contracts';
import type { CommandContext } from 'just-bash/browser';
import {
  dirname,
  mapWorkspaceAlias,
  normalizeTerminalAbsolutePath,
  normalizeWorkspaceCwd,
  resolveWorkspaceContextPath,
} from './paths';
import {
  runtimeFileSystemEntryIsSymlink,
  runtimeFileSystemEntryKey,
  type RuntimeWorkspaceStorageUsage,
} from './fs-observed';
import {
  parseRuntimeLsArgs,
  runtimeLsFormatLine,
  runtimeLsHumanSize,
  runtimeLsIndicator,
  runtimeLsMode,
  type RuntimeLsEntry,
  type RuntimeLsStat,
} from './ls';

export interface WorkspaceFilesystemCommandsOptions {
  cwd: string;
  kernelInfo: RuntimeKernelInfo;
  storageUsage(): Promise<RuntimeWorkspaceStorageUsage>;
  allocateTemporaryEntry(): number;
}

/**
 * Read-oriented filesystem userland plus temporary-entry creation.
 *
 * Command-scoped filesystem access remains supplied by just-bash so mutations
 * continue to pass through the workspace's observation and policy boundary.
 * This module owns argument parsing and command presentation only.
 */
export class WorkspaceFilesystemCommands {
  private readonly cwd: string;
  private readonly kernelInfo: RuntimeKernelInfo;
  private readonly storageUsage: () => Promise<RuntimeWorkspaceStorageUsage>;
  private readonly allocateTemporaryEntry: () => number;

  constructor(options: WorkspaceFilesystemCommandsOptions) {
    this.cwd = options.cwd;
    this.kernelInfo = options.kernelInfo;
    this.storageUsage = options.storageUsage;
    this.allocateTemporaryEntry = options.allocateTemporaryEntry;
  }

  async stat(
    args: readonly string[],
    context: CommandContext
  ): Promise<RuntimeCommandResult> {
    let dereference = false;
    let format: string | undefined;
    const paths: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '-L' || arg === '--dereference') {
        dereference = true;
      } else if (arg === '-c' || arg === '--format') {
        const value = args[++index];
        if (value === undefined) {
          return {
            stdout: '',
            stderr:
              `stat: option requires an argument -- ` +
              `'${arg === '-c' ? 'c' : 'format'}'\n`,
            exitCode: 1,
          };
        }
        format = value;
      } else if (arg.startsWith('--format=')) {
        format = arg.slice('--format='.length);
      } else if (arg.startsWith('-')) {
        return {
          stdout: '',
          stderr: `stat: invalid option -- '${arg.slice(1)}'\n`,
          exitCode: 1,
        };
      } else {
        paths.push(arg);
      }
    }
    if (paths.length === 0) {
      return {
        stdout: '',
        stderr: 'stat: missing operand\n',
        exitCode: 1,
      };
    }

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    for (const path of paths) {
      const absolutePath = mapWorkspaceAlias(
        this.cwd,
        this.kernelInfo.workspaceAlias,
        normalizeTerminalAbsolutePath(
          context.fs.resolvePath(context.cwd, path)
        )
      );
      const stat = (await (
        dereference
          ? context.fs.stat(absolutePath)
          : context.fs.lstat(absolutePath)
      ).catch(() => null)) as
        | (RuntimeLsStat & { ino?: number })
        | null;
      if (!stat) {
        stderr +=
          `stat: cannot stat '${path}': ` +
          'No such file or directory\n';
        exitCode = 1;
        continue;
      }
      const isLink = stat.isSymbolicLink === true;
      const linkTarget = isLink
        ? await context.fs.readlink(absolutePath).catch(() => null)
        : null;
      const mode =
        stat.mode ?? (stat.isDirectory ? 0o755 : 0o644);
      const mtimeMs =
        stat.mtime instanceof Date
          ? stat.mtime.getTime()
          : stat.mtimeMs ?? 0;
      const type = isLink
        ? 'symbolic link'
        : stat.isDirectory
          ? 'directory'
          : stat.isCharacterDevice
            ? 'character special file'
            : 'regular file';
      const quotedName =
        `'${path}'` +
        (linkTarget === null ? '' : ` -> '${linkTarget}'`);
      const formattedTime =
        `${new Date(mtimeMs)
          .toISOString()
          .replace('T', ' ')
          .replace('Z', '')} +0000`;
      const renderFormat = (template: string) =>
        template.replace(
          /%([%nNsFaAuUgGYyih])/g,
          (_match, directive: string) => {
            switch (directive) {
              case '%':
                return '%';
              case 'n':
                return path;
              case 'N':
                return quotedName;
              case 's':
                return String(stat.size ?? 0);
              case 'F':
                return type;
              case 'a':
                return (mode & 0o7777).toString(8);
              case 'A':
                return runtimeLsMode(stat);
              case 'u':
                return String(stat.uid ?? 1000);
              case 'U':
                return (
                  stat.owner ?? this.kernelInfo.user.username
                );
              case 'g':
                return String(stat.gid ?? 1000);
              case 'G':
                return (
                  stat.group ?? this.kernelInfo.user.username
                );
              case 'Y':
                return String(Math.floor(mtimeMs / 1000));
              case 'y':
                return formattedTime;
              case 'i':
                return String(stat.ino ?? 0);
              case 'h':
                return String(stat.nlink ?? 1);
              default:
                return `%${directive}`;
            }
          }
        );
      if (format !== undefined) {
        stdout += `${renderFormat(format)}\n`;
      } else {
        stdout +=
          [
            `  File: ${quotedName}`,
            `  Size: ${stat.size ?? 0}\t\tBlocks: ${Math.ceil(
              (stat.size ?? 0) / 512
            )}`,
            `Access: (${(mode & 0o7777)
              .toString(8)
              .padStart(4, '0')}/${runtimeLsMode(stat)})`,
            `Modify: ${formattedTime}`,
          ].join('\n') + '\n';
      }
    }
    return { stdout, stderr, exitCode };
  }

  async df(
    args: readonly string[],
    context: CommandContext
  ): Promise<RuntimeCommandResult> {
    let humanReadable = false;
    let inodes = false;
    const paths: string[] = [];
    for (const arg of args) {
      if (arg === '--human-readable') {
        humanReadable = true;
      } else if (arg === '--inodes') {
        inodes = true;
      } else if (/^-[hkiP]+$/.test(arg)) {
        humanReadable ||= arg.includes('h');
        inodes ||= arg.includes('i');
      } else if (arg.startsWith('-')) {
        return {
          stdout: '',
          stderr: `df: unrecognized option '${arg}'\n`,
          exitCode: 1,
        };
      } else {
        paths.push(arg);
      }
    }
    for (const path of paths.length > 0 ? paths : [context.cwd]) {
      if (!(await context.fs.exists(path))) {
        return {
          stdout: '',
          stderr: `df: ${path}: No such file or directory\n`,
          exitCode: 1,
        };
      }
    }

    const usage = await this.storageUsage();
    if (inodes) {
      const percent =
        usage.capacityEntries === 0
          ? usage.usedEntries === 0
            ? 0
            : 100
          : Math.min(
              100,
              Math.ceil(
                (usage.usedEntries / usage.capacityEntries) * 100
              )
            );
      return {
        stdout:
          [
            'Filesystem Inodes IUsed IFree IUse% Mounted on',
            `tracekernel ${usage.capacityEntries} ` +
              `${usage.usedEntries} ${usage.availableEntries} ` +
              `${percent}% ${this.cwd}`,
          ].join('\n') + '\n',
        stderr: '',
        exitCode: 0,
      };
    }

    const capacityBlocks = Math.ceil(
      usage.capacityBytes / 1024
    );
    const usedBlocks = Math.ceil(usage.usedBytes / 1024);
    const availableBlocks = Math.max(
      0,
      capacityBlocks - usedBlocks
    );
    const percent =
      usage.capacityBytes === 0
        ? usage.usedBytes === 0
          ? 0
          : 100
        : Math.min(
            100,
            Math.ceil(
              (usage.usedBytes / usage.capacityBytes) * 100
            )
          );
    const capacity = humanReadable
      ? runtimeLsHumanSize(usage.capacityBytes)
      : String(capacityBlocks);
    const used = humanReadable
      ? runtimeLsHumanSize(usage.usedBytes)
      : String(usedBlocks);
    const available = humanReadable
      ? runtimeLsHumanSize(usage.availableBytes)
      : String(availableBlocks);
    return {
      stdout:
        [
          `Filesystem ${
            humanReadable ? 'Size' : '1K-blocks'
          } Used Available Use% Mounted on`,
          `tracekernel ${capacity} ${used} ${available} ` +
            `${percent}% ${this.cwd}`,
        ].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }

  async du(
    args: readonly string[],
    context: CommandContext
  ): Promise<RuntimeCommandResult> {
    let allEntries = false;
    let bytes = false;
    let humanReadable = false;
    let summarize = false;
    let total = false;
    let maxDepth: number | undefined;
    let endOfOptions = false;
    const paths: string[] = [];
    for (const arg of args) {
      if (!endOfOptions && arg === '--') {
        endOfOptions = true;
        continue;
      }
      if (
        !endOfOptions &&
        arg.startsWith('--max-depth=')
      ) {
        const value = arg.slice('--max-depth='.length);
        if (!/^\d+$/.test(value)) {
          return {
            stdout: '',
            stderr: `du: invalid maximum depth '${value}'\n`,
            exitCode: 1,
          };
        }
        maxDepth = Number(value);
        continue;
      }
      if (!endOfOptions && arg === '--all') {
        allEntries = true;
      } else if (!endOfOptions && arg === '--bytes') {
        bytes = true;
      } else if (
        !endOfOptions &&
        arg === '--human-readable'
      ) {
        humanReadable = true;
      } else if (!endOfOptions && arg === '--summarize') {
        summarize = true;
      } else if (!endOfOptions && arg === '--total') {
        total = true;
      } else if (
        !endOfOptions &&
        /^-[abhksc]+$/.test(arg)
      ) {
        allEntries ||= arg.includes('a');
        bytes ||= arg.includes('b');
        humanReadable ||= arg.includes('h');
        summarize ||= arg.includes('s');
        total ||= arg.includes('c');
      } else if (!endOfOptions && arg.startsWith('-')) {
        return {
          stdout: '',
          stderr: `du: unrecognized option '${arg}'\n`,
          exitCode: 1,
        };
      } else {
        paths.push(arg);
      }
    }
    if (summarize && maxDepth !== undefined) {
      return {
        stdout: '',
        stderr:
          'du: warning: summarizing conflicts with --max-depth\n',
        exitCode: 1,
      };
    }

    const formatSize = (size: number): string => {
      if (bytes) return String(size);
      if (humanReadable) return runtimeLsHumanSize(size);
      return String(Math.ceil(size / 1024));
    };
    const rows: Array<{ path: string; size: number }> = [];
    const visit = async (
      absolutePath: string,
      displayPath: string,
      depth: number
    ): Promise<number> => {
      let stat: Awaited<
        ReturnType<CommandContext['fs']['lstat']>
      >;
      try {
        stat = await context.fs.lstat(absolutePath);
      } catch {
        throw new Error(
          `du: cannot access '${displayPath}': ` +
            'No such file or directory'
        );
      }
      if (!stat.isDirectory) {
        if (depth === 0 || allEntries) {
          rows.push({ path: displayPath, size: stat.size });
        }
        return stat.size;
      }
      let size = 0;
      for (const entry of (
        await context.fs.readdir(absolutePath)
      ).sort()) {
        const childAbsolutePath =
          absolutePath === '/'
            ? `/${entry}`
            : `${absolutePath.replace(/\/$/, '')}/${entry}`;
        const childDisplayPath =
          displayPath === '/'
            ? `/${entry}`
            : displayPath === '.'
              ? `./${entry}`
              : `${displayPath.replace(/\/$/, '')}/${entry}`;
        size += await visit(
          childAbsolutePath,
          childDisplayPath,
          depth + 1
        );
      }
      if (
        !summarize &&
        (maxDepth === undefined || depth <= maxDepth)
      ) {
        rows.push({ path: displayPath, size });
      } else if (depth === 0) {
        rows.push({ path: displayPath, size });
      }
      return size;
    };

    let grandTotal = 0;
    try {
      for (const path of paths.length > 0 ? paths : ['.']) {
        const absolutePath = resolveWorkspaceContextPath(
          context,
          this.cwd,
          path,
          'du path'
        );
        grandTotal += await visit(absolutePath, path, 0);
      }
    } catch (error) {
      return {
        stdout: '',
        stderr:
          `${
            error instanceof Error ? error.message : String(error)
          }\n`,
        exitCode: 1,
      };
    }
    if (total) rows.push({ path: 'total', size: grandTotal });
    return {
      stdout:
        rows
          .map((row) => `${formatSize(row.size)}\t${row.path}`)
          .join('\n') + (rows.length > 0 ? '\n' : ''),
      stderr: '',
      exitCode: 0,
    };
  }

  mount(args: readonly string[]): RuntimeCommandResult {
    let endOfOptions = false;
    const operands: string[] = [];
    for (const arg of args) {
      if (!endOfOptions && arg === '--') {
        endOfOptions = true;
        continue;
      }
      if (
        !endOfOptions &&
        (arg === '-l' || arg === '--show-labels')
      ) {
        continue;
      }
      if (!endOfOptions && arg.startsWith('-')) {
        return {
          stdout: '',
          stderr: `mount: unrecognized option '${arg}'\n`,
          exitCode: 1,
        };
      }
      operands.push(arg);
    }
    if (operands.length > 0) {
      return {
        stdout: '',
        stderr:
          'mount: TraceKernel filesystem topology is fixed ' +
          'for the lifetime of a workspace\n',
        exitCode: 32,
      };
    }
    const rows = runtimeKernelMounts(this.kernelInfo).map(
      (mount) =>
        `${mount.source} on ${mount.target} type ${mount.type} ` +
        `(${mount.options.join(',')})`
    );
    return {
      stdout: `${rows.join('\n')}\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  async ls(
    args: readonly string[],
    context: CommandContext
  ): Promise<RuntimeCommandResult> {
    const parsed = parseRuntimeLsArgs([...args]);
    if ('exitCode' in parsed) return parsed;
    const options = parsed;
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    const multipleTargets = options.positional.length > 1;
    const visitedRecursiveDirectories = new Set<string>();

    const statPath = async (
      path: string
    ): Promise<RuntimeLsStat> =>
      context.fs.stat(path) as Promise<RuntimeLsStat>;
    const lstatPath = async (
      path: string
    ): Promise<RuntimeLsStat> =>
      context.fs.lstat(path) as Promise<RuntimeLsStat>;
    const sortedEntries = (
      entries: RuntimeLsEntry[]
    ): RuntimeLsEntry[] => {
      entries.sort((left, right) => {
        if (options.sortBySize) {
          return (
            (right.stat.size ?? 0) -
              (left.stat.size ?? 0) ||
            left.name.localeCompare(right.name)
          );
        }
        if (options.sortByTime) {
          const rightTime =
            right.stat.mtime instanceof Date
              ? right.stat.mtime.getTime()
              : right.stat.mtimeMs ?? 0;
          const leftTime =
            left.stat.mtime instanceof Date
              ? left.stat.mtime.getTime()
              : left.stat.mtimeMs ?? 0;
          return (
            rightTime -
              leftTime ||
            left.name.localeCompare(right.name)
          );
        }
        return left.name.localeCompare(right.name);
      });
      if (options.reverse) entries.reverse();
      return entries;
    };

    const renderEntry = async (
      path: string,
      name: string
    ): Promise<string> => {
      const stat = await lstatPath(path);
      if (options.longFormat) {
        return runtimeLsFormatLine(
          path,
          name,
          stat,
          options,
          this.kernelInfo
        );
      }
      return `${name}${
        options.classify ? runtimeLsIndicator(stat) : ''
      }\n`;
    };

    const renderDirectory = async (
      input: string,
      absolutePath: string,
      includeHeader: boolean,
      recursive: boolean
    ): Promise<void> => {
      const directoryStat = await lstatPath(absolutePath);
      if (runtimeFileSystemEntryIsSymlink(directoryStat)) {
        stdout += await renderEntry(absolutePath, input);
        return;
      }
      if (recursive) {
        const directoryKey = runtimeFileSystemEntryKey(
          absolutePath,
          directoryStat
        );
        if (visitedRecursiveDirectories.has(directoryKey)) return;
        visitedRecursiveDirectories.add(directoryKey);
      }
      if (includeHeader) stdout += `${input}:\n`;
      let names = await context.fs.readdir(absolutePath);
      if (!options.showAll && !options.showAlmostAll) {
        names = names.filter((name) => !name.startsWith('.'));
      }
      if (options.showAll) names = ['.', '..', ...names];
      const entries: RuntimeLsEntry[] = [];
      for (const name of names) {
        if (
          options.showAlmostAll &&
          (name === '.' || name === '..')
        ) {
          continue;
        }
        const childPath =
          name === '.'
            ? absolutePath
            : name === '..'
              ? dirname(absolutePath)
              : absolutePath === '/'
                ? `/${name}`
                : `${absolutePath}/${name}`;
        try {
          entries.push({
            name,
            path: childPath,
            stat: await lstatPath(childPath),
          });
        } catch {
          // Match ls when an entry disappears during listing.
        }
      }
      sortedEntries(entries);
      if (options.longFormat) {
        stdout += `total ${entries.length}\n`;
      }
      for (const entry of entries) {
        stdout += options.longFormat
          ? runtimeLsFormatLine(
              entry.path,
              entry.name,
              entry.stat,
              options,
              this.kernelInfo
            )
          : `${entry.name}${
              options.classify
                ? runtimeLsIndicator(entry.stat)
                : ''
            }\n`;
      }
      if (!recursive) return;
      const childDirectories = entries.filter(
        (entry) =>
          entry.stat.isDirectory &&
          entry.name !== '.' &&
          entry.name !== '..'
      );
      for (const entry of childDirectories) {
        stdout += '\n';
        const childInput =
          input === '/'
            ? `/${entry.name}`
            : `${input.replace(/\/+$/, '')}/${entry.name}`;
        await renderDirectory(
          childInput,
          entry.path,
          true,
          true
        );
      }
    };

    for (const [index, input] of options.positional.entries()) {
      const absolutePath = context.fs.resolvePath(
        context.cwd,
        input
      );
      try {
        const stat = await statPath(absolutePath);
        const lstat = await lstatPath(absolutePath);
        if (
          options.directoryOnly ||
          !stat.isDirectory ||
          runtimeFileSystemEntryIsSymlink(lstat)
        ) {
          stdout += await renderEntry(absolutePath, input);
          continue;
        }
        if (
          index > 0 &&
          stdout &&
          !stdout.endsWith('\n\n')
        ) {
          stdout += '\n';
        }
        await renderDirectory(
          input,
          absolutePath,
          multipleTargets || options.recursive,
          options.recursive
        );
      } catch {
        stderr +=
          `ls: cannot access '${input}': ` +
          'No such file or directory\n';
        exitCode = 2;
      }
    }
    return { stdout, stderr, exitCode };
  }

  async mktemp(
    args: readonly string[],
    context: CommandContext
  ): Promise<RuntimeCommandResult> {
    let directory = false;
    let dryRun = false;
    let quiet = false;
    let parent = context.env.get('TMPDIR') || '/tmp';
    let suffix = '';
    let template: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '-d' || arg === '--directory') {
        directory = true;
      } else if (arg === '-u' || arg === '--dry-run') {
        dryRun = true;
      } else if (arg === '-q' || arg === '--quiet') {
        quiet = true;
      } else if (arg === '-t') {
        continue;
      } else if (arg === '-p' || arg === '--tmpdir') {
        const value = args[index + 1];
        if (!value) {
          return {
            stdout: '',
            stderr: 'mktemp: option requires an argument\n',
            exitCode: 1,
          };
        }
        parent = value;
        index += 1;
      } else if (arg.startsWith('--tmpdir=')) {
        parent =
          arg.slice('--tmpdir='.length) || parent;
      } else if (arg.startsWith('--suffix=')) {
        suffix = arg.slice('--suffix='.length);
      } else if (arg.startsWith('-')) {
        return {
          stdout: '',
          stderr: `mktemp: invalid option -- '${arg}'\n`,
          exitCode: 1,
        };
      } else if (template === undefined) {
        template = arg;
      } else {
        return {
          stdout: '',
          stderr: `mktemp: extra operand '${arg}'\n`,
          exitCode: 1,
        };
      }
    }
    const rawTemplate = template ?? 'tmp.XXXXXXXXXX';
    const slashIndex = rawTemplate.lastIndexOf('/');
    if (slashIndex >= 0) {
      parent = rawTemplate.slice(0, slashIndex) || '/';
      template = rawTemplate.slice(slashIndex + 1);
    } else {
      template = rawTemplate;
    }
    const match = template.match(/X{3,}(?!.*X)/);
    if (!match || match.index === undefined) {
      return {
        stdout: '',
        stderr:
          `mktemp: too few X's in template ` +
          `'${rawTemplate}'\n`,
        exitCode: 1,
      };
    }
    const normalizedParent = parent.startsWith('/')
      ? normalizeWorkspaceCwd(parent)
      : normalizeWorkspaceCwd(`${context.cwd}/${parent}`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const token = this.allocateTemporaryEntry()
        .toString(36)
        .padStart(match[0].length, '0')
        .slice(-match[0].length);
      const name =
        `${template.slice(0, match.index)}${token}` +
        `${template.slice(
          match.index + match[0].length
        )}${suffix}`;
      const path = normalizeWorkspaceCwd(
        `${normalizedParent}/${name}`
      );
      if (await context.fs.exists(path)) continue;
      if (!dryRun) {
        try {
          if (directory) await context.fs.mkdir(path);
          else await context.fs.writeFile(path, '');
        } catch (error) {
          if (quiet) {
            return { stdout: '', stderr: '', exitCode: 1 };
          }
          return {
            stdout: '',
            stderr:
              `mktemp: ${
                error instanceof Error
                  ? error.message
                  : String(error)
              }\n`,
            exitCode: 1,
          };
        }
      }
      return {
        stdout: `${path}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    return {
      stdout: '',
      stderr: quiet
        ? ''
        : 'mktemp: failed to create a unique temporary entry\n',
      exitCode: 1,
    };
  }
}

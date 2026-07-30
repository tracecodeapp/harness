import {
  defineCommand,
} from 'just-bash/browser';
import {
  applyRuntimeCommandResultFiles,
  canCreateRuntimeCommandStdinPipe,
  createRuntimeCommandStdinPipe,
  createRuntimeCommandStdinPipeFromText,
  readRuntimeCommandStdinPipeBytes,
  RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGES,
  RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES,
  RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES,
  runtimeCommandStdinPipeClosed,
  runtimeFileChangePath,
  runtimeProjectTruncateUtf8,
  runtimeProjectUtf8Bytes,
} from '@tracecode/harness-core';
import {
  isRuntimeKernelVirtualNamespacePath,
  normalizeRuntimeProcPath,
  runtimeDeviceDirEntries,
  runtimeDeviceEntryKind,
  runtimeDeviceInputSource,
  runtimeDeviceOutputTarget,
  runtimeKernelAccessTarget,
  runtimeKernelDeviceInputRoute,
  runtimeKernelDeviceOutputRoute,
  runtimeKernelDirectoryTarget,
  runtimeKernelFileCopyTarget,
  runtimeKernelFileReadErrorMessage,
  runtimeKernelFileReadTarget,
  runtimeKernelLinkTarget,
  runtimeKernelMkdirTarget,
  runtimeKernelMetadataErrorMessage,
  runtimeKernelMetadataTarget,
  runtimeKernelMutationErrorMessage,
  runtimeKernelMutationTarget,
  runtimeKernelReadErrorMessage,
  runtimeKernelReadTarget,
  runtimeKernelRenameTarget,
  runtimeKernelRemoveTarget,
  runtimeKernelStatTarget,
  runtimeKernelSymlinkTarget,
  runtimeKernelVirtualDevices,
  runtimeKernelVirtualFiles,
  runtimeKernelVirtualPaths,
  runtimeKernelWriteErrorMessage,
  runtimeKernelWriteTarget,
  publicRuntimeKernelVirtualFiles,
  readPublicRuntimeProcFile,
  readRuntimeProcFile,
  createRuntimeKernelReadonlyFileError,
  type RuntimeKernelVirtualStat,
} from '@tracecode/harness-core';
import { getLanguageRuntimeInfo } from '@tracecode/harness-core';
import type { Language } from '@tracecode/harness-core';
import type {
  CommandContext,
  FileContent,
  IFileSystem,
} from 'just-bash/browser';
import type {
  RuntimeCommandResult,
  RuntimeCommandEventStream,
  RuntimeCommandExecutionLimits,
  RuntimeCommandError,
  RuntimeKernelDevicePath,
  RuntimeFileMutationPhase,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileDeletion,
  RuntimeDirectoryChange,
  RuntimeFileEncoding,
  RuntimeKernelInfo,
  RuntimeTraceKernelConfig,
  RuntimeTraceKernelSchedulerConfig,
  RuntimeProjectSession,
  RuntimeProjectSessionCommand,
  RuntimeProjectSessionCommandDefinition,
  RuntimeProjectSessionCommandStep,
  RuntimeProjectSessionInfo,
  RuntimeProjectPatch,
  RuntimeProjectPatchBase,
  RuntimeProjectPatchChange,
  RuntimeProjectPatchFileWrite,
  RuntimeProjectSnapshot,
  RuntimeWorkspaceActor,
} from '@tracecode/harness-core';
import type {
  CppProjectCommandRunner,
  CSharpProjectCommandRunner,
  CreateRuntimeWorkspaceOptions,
  JavaProjectCommandRunner,
  JavaScriptProjectCommandRunner,
  ProjectWorkspaceCommand,
  PythonProjectCommandRunner,
  RuntimePackageDependencyProvider,
  RuntimePackageInstallRequest,
  RuntimePackageManagerConfig,
  RuntimePackageManagerName,
  RuntimePackageManifest,
  TypeScriptProjectCommandRunner,
} from './index';
import { TRACEKERNEL_SKILLS_ROOT } from './constants';
import { normalizeTerminalAbsolutePath } from './paths';



export interface RuntimeLsOptions {
  showAll: boolean;
  showAlmostAll: boolean;
  longFormat: boolean;
  humanReadable: boolean;
  recursive: boolean;
  reverse: boolean;
  sortBySize: boolean;
  sortByTime: boolean;
  classify: boolean;
  directoryOnly: boolean;
  positional: string[];
}


export interface RuntimeLsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  isCharacterDevice?: boolean;
  mode?: number;
  size?: number;
  mtime?: Date;
  mtimeMs?: number;
  nlink?: number;
  uid?: number;
  gid?: number;
  owner?: string;
  group?: string;
}


export interface RuntimeLsEntry {
  name: string;
  path: string;
  stat: RuntimeLsStat;
}


export function parseRuntimeLsArgs(args: readonly string[]): RuntimeLsOptions | RuntimeCommandResult {
  const options: RuntimeLsOptions = {
    showAll: false,
    showAlmostAll: false,
    longFormat: false,
    humanReadable: false,
    recursive: false,
    reverse: false,
    sortBySize: false,
    sortByTime: false,
    classify: false,
    directoryOnly: false,
    positional: [],
  };
  let parsingFlags = true;
  for (const arg of args) {
    if (parsingFlags && arg === '--') {
      parsingFlags = false;
      continue;
    }
    if (parsingFlags && arg === '--help') {
      return {
        stdout: [
          'Usage: ls [OPTION]... [FILE]...',
          '  -a, --all            do not ignore entries starting with .',
          '  -A, --almost-all     do not list implied . and ..',
          '  -d, --directory      list directories themselves',
          '  -F, --classify       append indicator (one of */@)',
          '  -h, --human-readable with -l, print human-readable sizes',
          '  -l                   use a long listing format',
          '  -r, --reverse        reverse order while sorting',
          '  -R, --recursive      list subdirectories recursively',
          '  -S                   sort by file size, largest first',
          '  -t                   sort by modification time, newest first',
          '  -1                   list one file per line',
        ].join('\n') + '\n',
        stderr: '',
        exitCode: 0,
      };
    }
    if (parsingFlags && arg.startsWith('--') && arg.length > 2) {
      const long = arg.slice(2);
      if (long === 'all') options.showAll = true;
      else if (long === 'almost-all') options.showAlmostAll = true;
      else if (long === 'directory') options.directoryOnly = true;
      else if (long === 'classify') options.classify = true;
      else if (long === 'human-readable') options.humanReadable = true;
      else if (long === 'recursive') options.recursive = true;
      else if (long === 'reverse') options.reverse = true;
      else return { stdout: '', stderr: `ls: unrecognized option '--${long}'\n`, exitCode: 2 };
      continue;
    }
    if (parsingFlags && arg.startsWith('-') && arg.length > 1) {
      for (const flag of arg.slice(1)) {
        if (flag === 'a') options.showAll = true;
        else if (flag === 'A') options.showAlmostAll = true;
        else if (flag === 'd') options.directoryOnly = true;
        else if (flag === 'F') options.classify = true;
        else if (flag === 'h') options.humanReadable = true;
        else if (flag === 'l') options.longFormat = true;
        else if (flag === 'r') options.reverse = true;
        else if (flag === 'R') options.recursive = true;
        else if (flag === 'S') options.sortBySize = true;
        else if (flag === 't') options.sortByTime = true;
        else if (flag === '1') {
          // One-entry-per-line is already the only layout this harness exposes.
        } else {
          return { stdout: '', stderr: `ls: invalid option -- '${flag}'\n`, exitCode: 2 };
        }
      }
      continue;
    }
    options.positional.push(arg);
  }
  if (options.positional.length === 0) options.positional.push('.');
  return options;
}


export function runtimeLsMode(stat: RuntimeLsStat): string {
  const type = stat.isDirectory ? 'd' : stat.isSymbolicLink ? 'l' : stat.isCharacterDevice ? 'c' : '-';
  const mode = stat.mode ?? (stat.isDirectory ? 0o755 : 0o644);
  const bits = [
    0o400, 0o200, 0o100,
    0o040, 0o020, 0o010,
    0o004, 0o002, 0o001,
  ];
  const chars: string[] = bits.map((bit, index) => {
    const value = (mode & bit) !== 0;
    if (index % 3 === 0) return value ? 'r' : '-';
    if (index % 3 === 1) return value ? 'w' : '-';
    return value ? 'x' : '-';
  });
  if ((mode & 0o4000) !== 0) chars[2] = chars[2] === 'x' ? 's' : 'S';
  if ((mode & 0o2000) !== 0) chars[5] = chars[5] === 'x' ? 's' : 'S';
  if ((mode & 0o1000) !== 0) chars[8] = chars[8] === 'x' ? 't' : 'T';
  return `${type}${chars.join('')}`;
}


export function runtimeLsHumanSize(size: number): string {
  if (size < 1024) return String(size);
  if (size < 1024 * 1024) {
    const kib = size / 1024;
    return kib < 10 ? `${kib.toFixed(1)}K` : `${Math.round(kib)}K`;
  }
  if (size < 1024 * 1024 * 1024) {
    const mib = size / (1024 * 1024);
    return mib < 10 ? `${mib.toFixed(1)}M` : `${Math.round(mib)}M`;
  }
  const gib = size / (1024 * 1024 * 1024);
  return gib < 10 ? `${gib.toFixed(1)}G` : `${Math.round(gib)}G`;
}


export function runtimeLsDate(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()] ?? 'Jan';
  const day = String(date.getDate()).padStart(2, ' ');
  const now = new Date();
  const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  if (date > sixMonthsAgo) {
    return `${month} ${day} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  return `${month} ${day}  ${date.getFullYear()}`;
}


export function runtimeLsIndicator(stat: RuntimeLsStat): string {
  if (stat.isDirectory) return '/';
  if (stat.isSymbolicLink) return '@';
  return ((stat.mode ?? 0) & 0o111) !== 0 ? '*' : '';
}


export function runtimeLsIdentity(path: string, stat: RuntimeLsStat, info: RuntimeKernelInfo): { owner: string; group: string; uid: number; gid: number } {
  if (typeof stat.owner === 'string' || typeof stat.group === 'string' || typeof stat.uid === 'number' || typeof stat.gid === 'number') {
    return {
      owner: stat.owner ?? (stat.uid === 0 ? 'root' : info.user.username),
      group: stat.group ?? (stat.gid === 0 ? 'root' : info.user.username),
      uid: stat.uid ?? (stat.owner === 'root' ? 0 : 1000),
      gid: stat.gid ?? (stat.group === 'root' ? 0 : 1000),
    };
  }
  const normalized = normalizeTerminalAbsolutePath(path);
  if (
    normalized === '/' ||
    normalized === '/home' ||
    normalized === '/dev' ||
    normalized.startsWith('/dev/') ||
    normalized === '/proc' ||
    normalized.startsWith('/proc/') ||
    normalized === '/tracekernel' ||
    normalized.startsWith('/tracekernel/') ||
    normalized === TRACEKERNEL_SKILLS_ROOT ||
    normalized.startsWith(`${TRACEKERNEL_SKILLS_ROOT}/`)
  ) {
    return { owner: 'root', group: 'root', uid: 0, gid: 0 };
  }
  return { owner: info.user.username, group: info.user.username, uid: 1000, gid: 1000 };
}


export function runtimeLsFormatLine(path: string, name: string, stat: RuntimeLsStat, options: RuntimeLsOptions, info: RuntimeKernelInfo): string {
  const identity = runtimeLsIdentity(path, stat, info);
  const size = stat.size ?? 0;
  const renderedSize = options.humanReadable ? runtimeLsHumanSize(size).padStart(5) : String(size).padStart(5);
  const mtime = stat.mtime ?? new Date(stat.mtimeMs ?? 0);
  const suffix = options.classify ? runtimeLsIndicator(stat) : stat.isDirectory ? '/' : '';
  return [
    runtimeLsMode(stat),
    String(stat.nlink ?? 1),
    identity.owner,
    identity.group,
    renderedSize,
    runtimeLsDate(mtime),
    `${name}${suffix}`,
  ].join(' ') + '\n';
}

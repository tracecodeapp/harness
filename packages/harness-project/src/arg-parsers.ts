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
} from '../../harness-core/src/runtime-project';
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
} from '../../harness-core/src/runtime-kernel';
import { getLanguageRuntimeInfo } from '../../harness-core/src/runtime-language-info';
import type { Language } from '../../harness-core/src/runtime-types';
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
} from '../../harness-core/src/runtime-project';
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
import { CPP_COMPILER_COMMANDS, TRACEKERNEL_EXEC_COMMAND, TRACEKERNEL_SHELL_COMMAND_PREFIX, TRACEKERNEL_SHELL_COMMAND_REWRITES } from './constants';
import { isWithinWorkspace, resolveWorkspaceCommandPath, toProjectPath, traceKernelBinCommandName } from './paths';
import { decodeUtf8 } from './fs-observed';
import type { CSharpProjectCommandRequest } from './index';



export type VirtualExecutableKind = 'cpp';


export interface VirtualExecutableRecord {
  path: string;
  kind: VirtualExecutableKind;
}


export function decodeCommandStdin(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  if (Array.isArray(value)) {
    return new TextDecoder().decode(new Uint8Array(value));
  }
  return '';
}


export interface ParsedPythonInvocation {
  code: string | null;
  module: string | null;
  scriptFile: string | null;
  showVersion: boolean;
  scriptArgs: string[];
}


export type PythonParseResult = ParsedPythonInvocation | RuntimeCommandResult;


export function isIgnoredPythonFlag(arg: string): boolean {
  return [
    '-u',
    '-B',
    '-E',
    '-I',
    '-O',
    '-OO',
    '-P',
    '-q',
    '-s',
    '-S',
  ].includes(arg);
}


export function pythonFlagConsumesNext(arg: string): boolean {
  return arg === '-W' || arg === '-X' || arg === '--check-hash-based-pycs';
}


export function isInlinePythonFlagWithValue(arg: string): boolean {
  return /^-[WX].+/.test(arg);
}


export function parsePythonInvocation(args: string[]): PythonParseResult {
  const parsed: ParsedPythonInvocation = {
    code: null,
    module: null,
    scriptFile: null,
    showVersion: false,
    scriptArgs: [],
  };

  if (args.length === 0) return parsed;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-c') {
      const code = args[index + 1];
      if (code === undefined) {
        return { stdout: '', stderr: "python3: option requires an argument -- 'c'\n", exitCode: 2 };
      }
      parsed.code = code;
      parsed.scriptArgs = args.slice(index + 2);
      return parsed;
    }
    if (arg === '-m' || arg === '--module') {
      const moduleName = args[index + 1];
      if (moduleName === undefined) {
        return { stdout: '', stderr: `python3: option requires an argument -- '${arg === '-m' ? 'm' : 'module'}'\n`, exitCode: 2 };
      }
      parsed.module = moduleName;
      parsed.scriptArgs = args.slice(index + 2);
      return parsed;
    }
    if (arg === '--') {
      if (index + 1 < args.length) {
        parsed.scriptFile = args[index + 1] ?? null;
        parsed.scriptArgs = args.slice(index + 2);
      }
      return parsed;
    }
    if (arg === '-') {
      parsed.scriptFile = '-';
      parsed.scriptArgs = args.slice(index + 1);
      return parsed;
    }
    if (arg === '--version' || arg === '-V') {
      parsed.showVersion = true;
      return parsed;
    }
    if (isIgnoredPythonFlag(arg) || isInlinePythonFlagWithValue(arg)) {
      continue;
    }
    if (pythonFlagConsumesNext(arg)) {
      if (args[index + 1] === undefined) {
        return { stdout: '', stderr: `python3: option requires an argument -- '${arg.slice(1)}'\n`, exitCode: 2 };
      }
      index += 1;
      continue;
    }
    if (arg?.startsWith('-') && arg !== '-') {
      return { stdout: '', stderr: `python3: unrecognized option '${arg}'\n`, exitCode: 2 };
    }

    if (arg !== undefined) {
      parsed.scriptFile = arg;
      parsed.scriptArgs = args.slice(index + 1);
      return parsed;
    }
  }

  return parsed;
}


export function isCommandResult(value: PythonParseResult): value is RuntimeCommandResult {
  return typeof (value as RuntimeCommandResult).exitCode === 'number';
}


export interface ParsedNodeInvocation {
  code: string | null;
  scriptFile: string | null;
  inputType: string | null;
  requireModules: string[];
  showVersion: boolean;
  scriptArgs: string[];
}


export type NodeParseResult = ParsedNodeInvocation | RuntimeCommandResult;


export function parseNodeInvocation(args: string[]): NodeParseResult {
  const parsed: ParsedNodeInvocation = {
    code: null,
    scriptFile: null,
    inputType: null,
    requireModules: [],
    showVersion: false,
    scriptArgs: [],
  };

  if (args.length === 0) return parsed;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-e' || arg === '--eval') {
      const code = args[index + 1];
      if (code === undefined) {
        return { stdout: '', stderr: `node: ${arg} requires an argument\n`, exitCode: 9 };
      }
      parsed.code = code;
      parsed.scriptArgs = args.slice(index + 2);
      return parsed;
    }
    if (arg === '-p' || arg === '--print') {
      const code = args[index + 1];
      if (code === undefined) {
        return { stdout: '', stderr: `node: ${arg} requires an argument\n`, exitCode: 9 };
      }
      parsed.code = `console.log(${code})`;
      parsed.scriptArgs = args.slice(index + 2);
      return parsed;
    }
    if (arg === '--') {
      if (index + 1 < args.length) {
        parsed.scriptFile = args[index + 1] ?? null;
        parsed.scriptArgs = args.slice(index + 2);
      }
      return parsed;
    }
    if (arg === '-') {
      parsed.scriptFile = '-';
      parsed.scriptArgs = args.slice(index + 1);
      return parsed;
    }
    if (arg === '--version' || arg === '-v') {
      parsed.showVersion = true;
      return parsed;
    }
    if (arg === '--input-type') {
      const inputType = args[index + 1];
      if (inputType === undefined) {
        return { stdout: '', stderr: 'node: --input-type requires an argument\n', exitCode: 9 };
      }
      parsed.inputType = inputType;
      index += 1;
      continue;
    }
    if (arg.startsWith('--input-type=')) {
      parsed.inputType = arg.slice('--input-type='.length);
      continue;
    }
    if (arg === '-r' || arg === '--require') {
      const moduleName = args[index + 1];
      if (moduleName === undefined) {
        return { stdout: '', stderr: `node: ${arg} requires an argument\n`, exitCode: 9 };
      }
      parsed.requireModules.push(moduleName);
      index += 1;
      continue;
    }
    if (arg.startsWith('--require=')) {
      parsed.requireModules.push(arg.slice('--require='.length));
      continue;
    }
    if (
      arg === '--no-warnings' ||
      arg === '--trace-warnings' ||
      arg === '--trace-deprecation' ||
      arg === '--throw-deprecation' ||
      arg === '--enable-source-maps' ||
      arg === '--experimental-vm-modules' ||
      arg === '--experimental-default-type=module' ||
      arg === '--experimental-default-type=commonjs'
    ) {
      continue;
    }
    if (arg?.startsWith('-') && arg !== '-') {
      return { stdout: '', stderr: `node: bad option: ${arg}\n`, exitCode: 9 };
    }

    if (arg !== undefined) {
      parsed.scriptFile = arg;
      parsed.scriptArgs = args.slice(index + 1);
      return parsed;
    }
  }

  return parsed;
}


export function isNodeCommandResult(value: NodeParseResult): value is RuntimeCommandResult {
  return typeof (value as RuntimeCommandResult).exitCode === 'number';
}


export function parseTscInvocation(args: string[]): RuntimeCommandResult | { args: string[]; showVersion: boolean } {
  if (args.some((arg) => arg === '--version' || arg === '-v')) {
    return { args: [], showVersion: true };
  }
  const unsupported = args.find((arg) => arg === '--watch' || arg === '-w' || arg === '--build' || arg === '-b');
  if (unsupported) {
    return {
      stdout: '',
      stderr: `tracekernel: tsc ${unsupported} is not supported in the emulated project environment\n`,
      exitCode: 2,
    };
  }
  return { args, showVersion: false };
}


export function isTscCommandResult(value: ReturnType<typeof parseTscInvocation>): value is RuntimeCommandResult {
  return typeof (value as RuntimeCommandResult).exitCode === 'number';
}


export function findBytes(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
  if (needle.length === 0) return start;
  for (let index = start; index <= haystack.length - needle.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
}


export function extractStoredJarMainClass(bytes: Uint8Array): string | null {
  const manifestName = new TextEncoder().encode('META-INF/MANIFEST.MF');
  const manifestOffset = findBytes(bytes, manifestName);
  if (manifestOffset < 0) return null;
  const headerOffset = Math.max(0, manifestOffset - 30);
  for (let index = headerOffset; index >= 0; index -= 1) {
    if (
      bytes[index] === 0x50 &&
      bytes[index + 1] === 0x4b &&
      bytes[index + 2] === 0x03 &&
      bytes[index + 3] === 0x04
    ) {
      const method = bytes[index + 8] | (bytes[index + 9] << 8);
      const compressedSize = bytes[index + 18] | (bytes[index + 19] << 8) | (bytes[index + 20] << 16) | (bytes[index + 21] << 24);
      const fileNameLength = bytes[index + 26] | (bytes[index + 27] << 8);
      const extraLength = bytes[index + 28] | (bytes[index + 29] << 8);
      const nameStart = index + 30;
      const nameEnd = nameStart + fileNameLength;
      if (manifestOffset < nameStart || manifestOffset >= nameEnd || method !== 0) {
        return null;
      }
      const dataStart = nameEnd + extraLength;
      const manifest = decodeUtf8(bytes.slice(dataStart, dataStart + compressedSize));
      if (manifest === null) return null;
      const unfolded = manifest.replace(/\r\n /g, '').replace(/\n /g, '');
      const match = /^Main-Class:\s*(.+?)\s*$/im.exec(unfolded);
      return match?.[1]?.trim() || null;
    }
  }
  return null;
}


export interface ParsedJavacInvocation {
  args: string[];
  showVersion: boolean;
}


export interface ParsedJavaInvocation {
  mainClass: string | null;
  showVersion: boolean;
  programArgs: string[];
  classpath: string | null;
  jarPath: string | null;
  systemProperties: Record<string, string>;
  enablePreview: boolean;
  enableAssertions: boolean;
}


export type JavacParseResult = ParsedJavacInvocation | RuntimeCommandResult;

export type JavaParseResult = ParsedJavaInvocation | RuntimeCommandResult;


export function parseJavacInvocation(args: string[]): JavacParseResult {
  if (args.includes('-version') || args.includes('--version')) {
    return { args: [], showVersion: true };
  }
  if (args.length === 0) {
    return { stdout: '', stderr: 'javac: no source files\n', exitCode: 2 };
  }
  return { args, showVersion: false };
}


export function parseJavaArgFile(contents: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaping = false;
  for (const ch of contents) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += '\\';
  if (current.length > 0) args.push(current);
  return args;
}


export async function expandJavaCommandArgfiles(args: string[], ctx: CommandContext, workspaceRoot: string): Promise<string[]> {
  const expand = async (items: string[], seen: Set<string>): Promise<string[]> => {
    const expanded: string[] = [];
    for (const item of items) {
      if (!item.startsWith('@') || item === '@') {
        expanded.push(item);
        continue;
      }

      const argfilePath = ctx.fs.resolvePath(ctx.cwd, item.slice(1));
      if (!isWithinWorkspace(workspaceRoot, argfilePath)) {
        throw new Error(`Java argfile path must stay inside the workspace: ${item.slice(1)}`);
      }
      if (seen.has(argfilePath)) {
        throw new Error(`Recursive Java argfile reference: ${toProjectPath(workspaceRoot, argfilePath)}`);
      }
      if (!(await ctx.fs.exists(argfilePath))) {
        throw new Error(`Java argfile not found: ${toProjectPath(workspaceRoot, argfilePath)}`);
      }

      seen.add(argfilePath);
      expanded.push(...await expand(parseJavaArgFile(await ctx.fs.readFile(argfilePath)), seen));
      seen.delete(argfilePath);
    }
    return expanded;
  };
  return expand(args, new Set());
}


export function parseJavaInvocation(args: string[]): JavaParseResult {
  let classpath: string | null = null;
  let jarPath: string | null = null;
  let enablePreview = false;
  let enableAssertions = false;
  const systemProperties: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === '-version' || arg === '--version') {
      return { mainClass: null, showVersion: true, programArgs: [], classpath, jarPath, systemProperties, enablePreview, enableAssertions };
    }

    if (arg === '--enable-preview') {
      enablePreview = true;
      continue;
    }

    if (arg === '-ea' || arg === '-enableassertions') {
      enableAssertions = true;
      continue;
    }

    if (arg === '-cp' || arg === '-classpath' || arg === '--class-path') {
      if (args[index + 1] === undefined) {
        return { stdout: '', stderr: `java: option requires an argument -- ${arg}\n`, exitCode: 2 };
      }
      classpath = args[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith('--class-path=')) {
      classpath = arg.slice('--class-path='.length);
      continue;
    }

    if (arg.startsWith('-D')) {
      const rawProperty = arg.slice(2);
      if (!rawProperty) {
        return { stdout: '', stderr: 'java: option requires property name -- -D\n', exitCode: 2 };
      }
      const equalsIndex = rawProperty.indexOf('=');
      const key = equalsIndex >= 0 ? rawProperty.slice(0, equalsIndex) : rawProperty;
      if (!key) {
        return { stdout: '', stderr: 'java: option requires property name -- -D\n', exitCode: 2 };
      }
      systemProperties[key] = equalsIndex >= 0 ? rawProperty.slice(equalsIndex + 1) : '';
      continue;
    }

    if (arg === '-jar') {
      if (args[index + 1] === undefined) {
        return { stdout: '', stderr: 'java: option requires an argument -- -jar\n', exitCode: 2 };
      }
      jarPath = args[index + 1] ?? null;
      return {
        mainClass: null,
        showVersion: false,
        programArgs: args.slice(index + 2),
        classpath,
        jarPath,
        systemProperties,
        enablePreview,
        enableAssertions,
      };
    }

    if (arg.startsWith('-')) {
      return { stdout: '', stderr: `java: unsupported option ${arg}\n`, exitCode: 2 };
    }

    return {
      mainClass: arg,
      showVersion: false,
      programArgs: args.slice(index + 1),
      classpath,
      jarPath,
      systemProperties,
      enablePreview,
      enableAssertions,
    };
  }

  return { stdout: '', stderr: 'Usage: java <mainclass> [args...]\n', exitCode: 2 };
}


export function isJavacCommandResult(value: JavacParseResult): value is RuntimeCommandResult {
  return typeof (value as RuntimeCommandResult).exitCode === 'number';
}


export function isJavaCommandResult(value: JavaParseResult): value is RuntimeCommandResult {
  return typeof (value as RuntimeCommandResult).exitCode === 'number';
}


export function primaryJavacSourceArg(args: string[]): string {
  return args.find((arg) => /\.java$/i.test(arg)) ?? args[0] ?? '<javac>';
}


export interface ParsedCppCompileInvocation {
  args: string[];
  showVersion: boolean;
}


export type CppCompileParseResult = ParsedCppCompileInvocation | RuntimeCommandResult;


export function parseCppCompileInvocation(args: string[]): CppCompileParseResult {
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    return { args: [], showVersion: true };
  }
  if (args.length === 0) {
    return { stdout: '', stderr: 'clang++: error: no input files\n', exitCode: 1 };
  }
  return { args, showVersion: false };
}


export function isCppCompileCommandResult(value: CppCompileParseResult): value is RuntimeCommandResult {
  return typeof (value as RuntimeCommandResult).exitCode === 'number';
}


export function cppOutputPathFromArgs(args: string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-o' && typeof args[index + 1] === 'string') {
      return args[index + 1];
    }
    if (arg.startsWith('-o') && arg.length > 2) {
      return arg.slice(2);
    }
  }
  return 'a.out';
}


export function parseSimpleCommandWords(command: string): string[] | null {
  const words: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaping = false;
  let sawWord = false;

  for (const ch of command) {
    if (escaping) {
      current += ch;
      sawWord = true;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      sawWord = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      sawWord = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      sawWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (sawWord) {
        words.push(current);
        current = '';
        sawWord = false;
      }
      continue;
    }
    if ('|&;<>(){}~`$!#'.includes(ch)) {
      return null;
    }
    current += ch;
    sawWord = true;
  }

  if (escaping || quote !== null) return null;
  if (sawWord) words.push(current);
  return words.length > 0 ? words : null;
}


export function leadingPersistentCdTarget(command: string): string | undefined | null {
  let quote: string | null = null;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    const next = command[index + 1];
    const isPersistentSeparator = ch === ';' || (ch === '&' && next === '&') || (ch === '|' && next === '|');
    if (!isPersistentSeparator) continue;

    const words = parseSimpleCommandWords(command.slice(0, index).trim());
    if (words?.[0] !== 'cd' || words.length > 2) return null;
    return words[1];
  }

  return null;
}


export interface TerminalCommandListSegment {
  command: string;
  background: boolean;
}


export function parseTerminalCommandList(command: string): TerminalCommandListSegment[] {
  const segments: TerminalCommandListSegment[] = [];
  let quote: string | null = null;
  let escaping = false;
  let segmentStart = 0;

  const pushSegment = (end: number, background: boolean): void => {
    const segment = command.slice(segmentStart, end).trim();
    if (segment) segments.push({ command: segment, background });
    segmentStart = end + 1;
  };

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ';') {
      pushSegment(index, false);
      continue;
    }
    if (ch === '&') {
      if (command[index - 1] === '&' || command[index + 1] === '&') continue;
      pushSegment(index, true);
    }
  }

  const trailingSegment = command.slice(segmentStart).trim();
  if (trailingSegment) segments.push({ command: trailingSegment, background: false });
  return segments.length > 0 ? segments : [{ command, background: false }];
}


export function literalWordValue(word: unknown): string | null {
  const candidate = word as { type?: unknown; parts?: Array<{ type?: unknown; value?: unknown }> };
  if (candidate?.type !== 'Word' || !Array.isArray(candidate.parts)) return null;
  let value = '';
  for (const part of candidate.parts) {
    if (part?.type !== 'Literal' || typeof part.value !== 'string') return null;
    value += part.value;
  }
  return value;
}


export function literalWord(value: string): { type: 'Word'; parts: Array<{ type: 'Literal'; value: string }> } {
  return {
    type: 'Word',
    parts: [{ type: 'Literal', value }],
  };
}


export function rewriteKernelShellCommandInvocationsInAst(ast: unknown): void {
  const transformStatements = (statements: unknown): void => {
    if (!Array.isArray(statements)) return;
    for (const statement of statements) transformStatement(statement);
  };

  const transformCommand = (command: unknown): void => {
    const candidate = command as {
      type?: unknown;
      name?: unknown;
      clauses?: Array<{ condition?: unknown; body?: unknown }>;
      elseBody?: unknown;
      body?: unknown;
      items?: Array<{ body?: unknown }>;
    };
    switch (candidate?.type) {
      case 'SimpleCommand': {
        const name = literalWordValue(candidate.name);
        const rewrite = name ? TRACEKERNEL_SHELL_COMMAND_REWRITES.get(name) : undefined;
        if (rewrite) candidate.name = literalWord(rewrite);
        return;
      }
      case 'If':
        for (const clause of candidate.clauses ?? []) {
          transformStatements(clause.condition);
          transformStatements(clause.body);
        }
        transformStatements(candidate.elseBody);
        return;
      case 'For':
      case 'While':
      case 'Until':
      case 'Subshell':
      case 'Group':
        transformStatements(candidate.body);
        return;
      case 'Case':
        for (const item of candidate.items ?? []) {
          transformStatements(item.body);
        }
        return;
      case 'FunctionDef':
        transformCommand(candidate.body);
        return;
      default:
        return;
    }
  };

  const transformStatement = (statement: unknown): void => {
    const candidate = statement as {
      type?: unknown;
      pipelines?: Array<{ commands?: unknown[] }>;
    };
    if (candidate?.type !== 'Statement' || !Array.isArray(candidate.pipelines)) return;
    for (const pipeline of candidate.pipelines) {
      for (const command of pipeline.commands ?? []) {
        transformCommand(command);
      }
    }
  };

  const script = ast as { type?: unknown; statements?: unknown };
  if (script?.type === 'Script') transformStatements(script.statements);
}


export function rewriteTraceKernelBinInvocationsInAst(ast: unknown, commandNames: ReadonlySet<string>): void {
  const transformStatements = (statements: unknown): void => {
    if (!Array.isArray(statements)) return;
    for (const statement of statements) transformStatement(statement);
  };

  const transformCommand = (command: unknown): void => {
    const candidate = command as {
      type?: unknown;
      name?: unknown;
      clauses?: Array<{ condition?: unknown; body?: unknown }>;
      elseBody?: unknown;
      body?: unknown;
      items?: Array<{ body?: unknown }>;
    };
    switch (candidate?.type) {
      case 'SimpleCommand': {
        const name = literalWordValue(candidate.name);
        const commandName = name ? traceKernelBinCommandName(name) : null;
        if (commandName && commandNames.has(commandName)) candidate.name = literalWord(commandName);
        return;
      }
      case 'If':
        for (const clause of candidate.clauses ?? []) {
          transformStatements(clause.condition);
          transformStatements(clause.body);
        }
        transformStatements(candidate.elseBody);
        return;
      case 'For':
      case 'While':
      case 'Until':
      case 'Subshell':
      case 'Group':
        transformStatements(candidate.body);
        return;
      case 'Case':
        for (const item of candidate.items ?? []) {
          transformStatements(item.body);
        }
        return;
      case 'FunctionDef':
        transformCommand(candidate.body);
        return;
      default:
        return;
    }
  };

  const transformStatement = (statement: unknown): void => {
    const candidate = statement as {
      type?: unknown;
      pipelines?: Array<{ commands?: unknown[] }>;
    };
    if (candidate?.type !== 'Statement' || !Array.isArray(candidate.pipelines)) return;
    for (const pipeline of candidate.pipelines) {
      for (const command of pipeline.commands ?? []) {
        transformCommand(command);
      }
    }
  };

  const script = ast as { type?: unknown; statements?: unknown };
  if (script?.type === 'Script') transformStatements(script.statements);
}


export function rewriteVirtualExecutableInvocationsInAst(
  ast: unknown,
  initialCwd: string,
  workspaceRoot: string,
  workspaceAlias: string | undefined,
  executableRecords: ReadonlyMap<string, VirtualExecutableRecord>
): void {
  const availableExecutableRecords = new Map(executableRecords);

  const resolveExecutablePath = (cwd: string, executable: string): string | null => {
    if (!executable.includes('/') && !executable.startsWith('/')) return null;
    try {
      return toProjectPath(workspaceRoot, resolveWorkspaceCommandPath(workspaceRoot, cwd, executable, workspaceAlias));
    } catch {
      return null;
    }
  };

  const commandArgs = (command: { args?: unknown[] }): string[] | null => {
    const args: string[] = [];
    for (const arg of command.args ?? []) {
      const value = literalWordValue(arg);
      if (value === null) return null;
      args.push(value);
    }
    return args;
  };

  const transformStatements = (statements: unknown, cwd: string): string => {
    if (!Array.isArray(statements)) return cwd;
    let currentCwd = cwd;
    for (const statement of statements) {
      currentCwd = transformStatement(statement, currentCwd);
    }
    return currentCwd;
  };

  const transformCommand = (command: unknown, cwd: string): void => {
    const candidate = command as {
      type?: unknown;
      name?: unknown;
      args?: unknown[];
      clauses?: Array<{ condition?: unknown; body?: unknown }>;
      elseBody?: unknown;
      body?: unknown;
      items?: Array<{ body?: unknown }>;
    };
    switch (candidate?.type) {
      case 'SimpleCommand': {
        const name = literalWordValue(candidate.name);
        if (!name) return;
        const resolvedExecutablePath = resolveExecutablePath(cwd, name);
        if (resolvedExecutablePath && availableExecutableRecords.has(resolvedExecutablePath)) {
          candidate.args = [literalWord(name), ...(candidate.args ?? [])];
          candidate.name = literalWord(TRACEKERNEL_EXEC_COMMAND);
        }
        return;
      }
      case 'If':
        for (const clause of candidate.clauses ?? []) {
          transformStatements(clause.condition, cwd);
          transformStatements(clause.body, cwd);
        }
        transformStatements(candidate.elseBody, cwd);
        return;
      case 'For':
      case 'While':
      case 'Until':
      case 'Subshell':
      case 'Group':
        transformStatements(candidate.body, cwd);
        return;
      case 'Case':
        for (const item of candidate.items ?? []) {
          transformStatements(item.body, cwd);
        }
        return;
      case 'FunctionDef':
        transformCommand(candidate.body, cwd);
        return;
      default:
        return;
    }
  };

  const transformStatement = (statement: unknown, cwd: string): string => {
    const candidate = statement as {
      type?: unknown;
      pipelines?: Array<{ commands?: unknown[] }>;
      operators?: unknown[];
    };
    if (candidate?.type !== 'Statement' || !Array.isArray(candidate.pipelines)) return cwd;

    let currentCwd = cwd;
    for (const [index, pipeline] of candidate.pipelines.entries()) {
      for (const command of pipeline.commands ?? []) {
        transformCommand(command, currentCwd);
      }

      const simpleCommand = pipeline.commands?.length === 1
        ? pipeline.commands[0] as { type?: unknown; name?: unknown; args?: unknown[] }
        : null;
      const name = simpleCommand?.type === 'SimpleCommand' ? literalWordValue(simpleCommand.name) : null;
      const args = simpleCommand ? commandArgs(simpleCommand) : null;
      if (name && args) {
        if (CPP_COMPILER_COMMANDS.has(name)) {
          const parsed = parseCppCompileInvocation(args);
          if (!isCppCompileCommandResult(parsed) && !parsed.showVersion) {
            const outputPath = resolveExecutablePath(currentCwd, cppOutputPathFromArgs(parsed.args));
            if (outputPath) availableExecutableRecords.set(outputPath, { path: outputPath, kind: 'cpp' });
          }
        } else if (name === 'cd') {
          const target = args[0] ?? workspaceRoot;
          const nextOperator = candidate.operators?.[index];
          if (nextOperator !== '||') {
            try {
              currentCwd = resolveWorkspaceCommandPath(workspaceRoot, currentCwd, target, workspaceAlias);
            } catch {
              // Keep the static cwd unchanged if the target cannot be represented in this workspace.
            }
          }
        }
      }
    }
    return currentCwd;
  };

  const script = ast as { type?: unknown; statements?: unknown };
  if (script?.type === 'Script') {
    transformStatements(script.statements, initialCwd);
  }
}


export interface ParsedDotnetInvocation {
  source: CSharpProjectCommandRequest['source'];
  scriptPath: string;
  args: string[];
  buildArgs?: string[];
  noBuild?: boolean;
  showVersion: boolean;
}


export type DotnetParseResult = ParsedDotnetInvocation | RuntimeCommandResult;


export function collectDotnetBuildArg(args: string[], index: number, buildArgs: string[]): number {
  const arg = args[index];
  if (arg === '-p' || arg === '--property') {
    const value = args[index + 1];
    if (typeof value === 'string') {
      buildArgs.push(`${arg}:${value}`);
      return index + 1;
    }
    return index;
  }
  if (
    arg.startsWith('-p:') ||
    arg.startsWith('/p:') ||
    arg.startsWith('-property:') ||
    arg.startsWith('--property:')
  ) {
    buildArgs.push(arg);
    return index;
  }
  if (arg.startsWith('--property=')) {
    buildArgs.push(`--property:${arg.slice('--property='.length)}`);
    return index;
  }
  buildArgs.push(arg);
  return index;
}


export function dotnetRunBuildOptionConsumesNext(arg: string): boolean {
  return [
    '-c',
    '--configuration',
    '-f',
    '--framework',
    '-r',
    '--runtime',
    '--arch',
    '--os',
    '-v',
    '--verbosity',
  ].includes(arg);
}


export function collectDotnetRunBuildOption(args: string[], index: number, buildArgs: string[]): number {
  const arg = args[index];
  if (
    dotnetRunBuildOptionConsumesNext(arg) ||
    arg === '--no-restore' ||
    arg === '--self-contained' ||
    arg === '--no-self-contained'
  ) {
    buildArgs.push(arg);
    const value = args[index + 1];
    if (dotnetRunBuildOptionConsumesNext(arg) && typeof value === 'string') {
      buildArgs.push(value);
      return index + 1;
    }
    return index;
  }
  if (
    arg.startsWith('--configuration=') ||
    arg.startsWith('--framework=') ||
    arg.startsWith('--runtime=') ||
    arg.startsWith('--arch=') ||
    arg.startsWith('--os=') ||
    arg.startsWith('--verbosity=') ||
    arg.startsWith('--self-contained=')
  ) {
    buildArgs.push(arg);
    return index;
  }
  return index;
}


export function parseDotnetInvocation(args: string[]): DotnetParseResult {
  if (args.includes('--version') || args.includes('--info')) {
    return { source: 'run', scriptPath: '<dotnet>', args: [], showVersion: true };
  }
  const command = args[0];
  if (command === 'build') {
    const rest = args.slice(1);
    const project = rest.find((arg) => !arg.startsWith('-') && arg.endsWith('.csproj')) ?? '<project>';
    const buildArgs: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index];
      if (arg === project) continue;
      index = collectDotnetBuildArg(rest, index, buildArgs);
    }
    return { source: 'compile', scriptPath: project, args: buildArgs, showVersion: false };
  }
  if (command === 'run') {
    let project = '<project>';
    const buildArgs: string[] = [];
    const programArgs: string[] = [];
    let noBuild = false;
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '--') {
        programArgs.push(...args.slice(index + 1));
        break;
      }
      if (arg === '--no-build') {
        noBuild = true;
        continue;
      }
      if (arg === '--no-launch-profile') {
        continue;
      }
      if (arg === '--launch-profile') {
        if (args[index + 1] === undefined) {
          return { stdout: '', stderr: 'dotnet: --launch-profile requires an argument\n', exitCode: 2 };
        }
        index += 1;
        continue;
      }
      if (arg.startsWith('--launch-profile=')) {
        continue;
      }
      if (arg === '--project') {
        project = args[index + 1] ?? '<project>';
        index += 1;
        continue;
      }
      if (arg === '-p' && typeof args[index + 1] === 'string' && args[index + 1]!.endsWith('.csproj')) {
        project = args[index + 1]!;
        index += 1;
        continue;
      }
      if (arg.startsWith('--project=')) {
        project = arg.slice('--project='.length);
        continue;
      }
      if (
        arg === '-p' ||
        arg === '--property' ||
        arg.startsWith('-p:') ||
        arg.startsWith('/p:') ||
        arg.startsWith('-property:') ||
        arg.startsWith('--property:') ||
        arg.startsWith('--property=')
      ) {
        index = collectDotnetBuildArg(args, index, buildArgs);
        continue;
      }
      const previousIndex = index;
      const previousBuildArgCount = buildArgs.length;
      index = collectDotnetRunBuildOption(args, index, buildArgs);
      if (index !== previousIndex || buildArgs.length !== previousBuildArgCount) {
        continue;
      }
      if (arg && !arg.startsWith('-')) {
        programArgs.push(arg);
      }
    }
    return { source: 'run', scriptPath: project, args: programArgs, buildArgs, noBuild, showVersion: false };
  }
  return { stdout: '', stderr: `dotnet: unsupported project command '${command ?? ''}'\n`, exitCode: 2 };
}


export function isDotnetCommandResult(value: DotnetParseResult): value is RuntimeCommandResult {
  return typeof (value as RuntimeCommandResult).exitCode === 'number';
}

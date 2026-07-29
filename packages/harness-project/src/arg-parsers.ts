import {
  Bash,
  defineCommand,
} from 'just-bash/browser';
// Use the explicit browser entry so shared Project parsing never pulls
// fflate's Node worker_threads/createRequire adapter into browser bundles.
import * as fflateBrowser from 'fflate/browser';
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
      stderr: `tsc: ${unsupported} is not supported by this runtime\n`,
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


function zipUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function zipUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function findZipEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimumOffset = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (zipUint32(bytes, offset) === 0x06054b50) return offset;
  }
  return -1;
}

const MAX_JAR_MANIFEST_BYTES = 1024 * 1024;

export function extractJarMainClass(bytes: Uint8Array): string | null {
  const endOffset = findZipEndOfCentralDirectory(bytes);
  if (endOffset < 0 || endOffset + 22 > bytes.length) return null;
  const entryCount = zipUint16(bytes, endOffset + 10);
  let offset = zipUint32(bytes, endOffset + 16);

  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (offset + 46 > bytes.length || zipUint32(bytes, offset) !== 0x02014b50) {
      return null;
    }
    const flags = zipUint16(bytes, offset + 8);
    const method = zipUint16(bytes, offset + 10);
    const compressedSize = zipUint32(bytes, offset + 20);
    const uncompressedSize = zipUint32(bytes, offset + 24);
    const fileNameLength = zipUint16(bytes, offset + 28);
    const extraLength = zipUint16(bytes, offset + 30);
    const commentLength = zipUint16(bytes, offset + 32);
    const localHeaderOffset = zipUint32(bytes, offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > bytes.length) return null;
    const name = decodeUtf8(bytes.slice(nameStart, nameEnd));

    if (name === 'META-INF/MANIFEST.MF') {
      if (
        (flags & 0x1) !== 0 ||
        uncompressedSize > MAX_JAR_MANIFEST_BYTES ||
        localHeaderOffset + 30 > bytes.length ||
        zipUint32(bytes, localHeaderOffset) !== 0x04034b50
      ) {
        return null;
      }
      const localNameLength = zipUint16(bytes, localHeaderOffset + 26);
      const localExtraLength = zipUint16(bytes, localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.length) return null;
      const compressed = bytes.slice(dataStart, dataEnd);
      let manifestBytes: Uint8Array;
      try {
        if (method === 0) manifestBytes = compressed;
        else if (method === 8) manifestBytes = fflateBrowser.inflateSync(compressed);
        else return null;
      } catch {
        return null;
      }
      if (
        manifestBytes.byteLength !== uncompressedSize ||
        manifestBytes.byteLength > MAX_JAR_MANIFEST_BYTES
      ) {
        return null;
      }
      const manifest = decodeUtf8(manifestBytes);
      if (manifest === null) return null;
      const unfolded = manifest.replace(/\r\n /g, '').replace(/\n /g, '');
      const match = /^Main-Class:\s*(.+?)\s*$/im.exec(unfolded);
      return match?.[1]?.trim() || null;
    }

    offset = nameEnd + extraLength + commentLength;
  }
  return null;
}

/** @deprecated Use extractJarMainClass; retained for downstream compatibility. */
export const extractStoredJarMainClass = extractJarMainClass;


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


// Terminal submissions are parsed with just-bash's own parser (via
// Bash.transform, which is exported from the browser entry) so the terminal
// layer never disagrees with the interpreter about quoting, comments,
// subshells, or separators. These helpers only inspect the AST statically;
// nothing is executed.

interface TerminalAstStatement {
  type?: unknown;
  pipelines?: TerminalAstPipeline[];
  operators?: unknown[];
  background?: boolean;
  sourceText?: string;
}

interface TerminalAstPipeline {
  commands?: TerminalAstSimpleCommand[];
  negated?: boolean;
}

interface TerminalAstSimpleCommand {
  type?: unknown;
  name?: unknown;
  args?: unknown[];
  assignments?: unknown[];
  redirections?: unknown[];
}

let terminalCommandParser: Bash | null = null;

function parseTerminalStatements(command: string): TerminalAstStatement[] | null {
  terminalCommandParser ??= new Bash();
  try {
    const script = terminalCommandParser.transform(command).ast as {
      type?: unknown;
      statements?: TerminalAstStatement[];
    };
    if (script?.type !== 'Script' || !Array.isArray(script.statements)) return null;
    return script.statements;
  } catch {
    return null;
  }
}

// Static value of a word that needs no expansion at runtime: literals,
// single-quoted text, and double-quoted text without substitutions.
function terminalStaticWordValue(word: unknown): string | null {
  const candidate = word as {
    type?: unknown;
    parts?: Array<{ type?: unknown; value?: unknown; pattern?: unknown; parts?: unknown[] }>;
  };
  if (candidate?.type !== 'Word' || !Array.isArray(candidate.parts)) return null;
  let value = '';
  for (const part of candidate.parts) {
    if (part?.type === 'Literal' && typeof part.value === 'string') {
      value += part.value;
      continue;
    }
    // An unquoted glob is still a static word at this layer. Callers that
    // support workspace globbing expand the preserved pattern themselves.
    if (part?.type === 'Glob' && typeof part.pattern === 'string') {
      value += part.pattern;
      continue;
    }
    if (part?.type === 'SingleQuoted' && typeof part.value === 'string') {
      value += part.value;
      continue;
    }
    if (part?.type === 'DoubleQuoted' && Array.isArray(part.parts)) {
      for (const inner of part.parts as Array<{ type?: unknown; value?: unknown }>) {
        if (inner?.type !== 'Literal' || typeof inner.value !== 'string') return null;
        value += inner.value;
      }
      continue;
    }
    return null;
  }
  return value;
}

function terminalLoneSimpleCommand(statement: TerminalAstStatement | undefined): TerminalAstSimpleCommand | null {
  if (!statement || statement.background === true) return null;
  const pipelines = statement.pipelines ?? [];
  const pipeline = pipelines[0];
  if (!pipeline || pipeline.negated === true) return null;
  const commands = pipeline.commands ?? [];
  if (commands.length !== 1) return null;
  const command = commands[0];
  if (command?.type !== 'SimpleCommand') return null;
  if ((command.assignments?.length ?? 0) > 0 || (command.redirections?.length ?? 0) > 0) return null;
  return command;
}

export function parseSimpleCommandWords(command: string): string[] | null {
  const statements = parseTerminalStatements(command);
  if (!statements || statements.length !== 1) return null;
  const statement = statements[0];
  if ((statement?.pipelines?.length ?? 0) !== 1) return null;
  const simpleCommand = terminalLoneSimpleCommand(statement);
  if (!simpleCommand) return null;
  const name = terminalStaticWordValue(simpleCommand.name);
  if (name === null || name.length === 0) return null;
  const words = [name];
  for (const arg of simpleCommand.args ?? []) {
    const value = terminalStaticWordValue(arg);
    if (value === null) return null;
    words.push(value);
  }
  return words;
}


export function leadingPersistentCdTarget(command: string): string | undefined | null {
  const statements = parseTerminalStatements(command);
  if (!statements || statements.length === 0) return null;
  const first = statements[0];
  const pipelines = first?.pipelines ?? [];
  // Only `cd …` followed by more work in the same submission persists; a bare
  // `cd …` is handled directly by the terminal session.
  if (statements.length === 1 && pipelines.length <= 1) return null;
  const headCommand = terminalLoneSimpleCommand(first);
  if (!headCommand) return null;
  if (terminalStaticWordValue(headCommand.name) !== 'cd') return null;
  const args = headCommand.args ?? [];
  if (args.length > 1) return null;
  if (args.length === 0) return undefined;
  const target = terminalStaticWordValue(args[0]);
  return target === null ? null : target;
}


export interface TerminalCommandListSegment {
  command: string;
  background: boolean;
}


export function parseTerminalCommandList(command: string): TerminalCommandListSegment[] {
  const wholeSubmission: TerminalCommandListSegment[] = [{ command, background: false }];
  // Here-doc bodies are not part of a statement's sourceText, so reconstructed
  // segments would lose them; run those submissions unsplit.
  if (command.includes('<<')) return wholeSubmission;
  const statements = parseTerminalStatements(command);
  if (!statements || statements.length === 0) return wholeSubmission;
  const segments: TerminalCommandListSegment[] = [];
  for (const statement of statements) {
    const sourceText = typeof statement.sourceText === 'string' ? statement.sourceText.trim() : '';
    if (!sourceText) return wholeSubmission;
    if (statement.background === true) {
      const background = sourceText.replace(/\s*&$/, '').trim();
      if (!background) return wholeSubmission;
      segments.push({ command: background, background: true });
    } else {
      segments.push({ command: sourceText, background: false });
    }
  }
  return segments.length > 0 ? segments : wholeSubmission;
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
      args?: unknown[];
      clauses?: Array<{ condition?: unknown; body?: unknown }>;
      elseBody?: unknown;
      body?: unknown;
      items?: Array<{ body?: unknown }>;
    };
    switch (candidate?.type) {
      case 'SimpleCommand': {
        const name = literalWordValue(candidate.name);
        const args = candidate.args ?? [];
        const unaryTtyTest = name === 'test' && (
          (args.length === 2 && literalWordValue(args[0]) === '-t') ||
          (args.length === 3 && literalWordValue(args[0]) === '!' && literalWordValue(args[1]) === '-t')
        );
        const bracketTtyTest = name === '[' && (
          (args.length === 3 && literalWordValue(args[0]) === '-t' && literalWordValue(args[2]) === ']') ||
          (args.length === 4 && literalWordValue(args[0]) === '!' && literalWordValue(args[1]) === '-t' && literalWordValue(args[3]) === ']')
        );
        if (unaryTtyTest || bracketTtyTest) {
          candidate.name = literalWord(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}${bracketTtyTest ? 'test-bracket' : 'test'}`);
          return;
        }
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


export function rewriteTraceKernelBinInvocationsInAst(
  ast: unknown,
  commandDispatchNames: ReadonlyMap<string, string>
): void {
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
        const commandName = name ? traceKernelBinCommandName(name) ?? name : null;
        const dispatchName = commandName ? commandDispatchNames.get(commandName) : undefined;
        if (dispatchName) candidate.name = literalWord(dispatchName);
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
  executableRecords: ReadonlyMap<string, VirtualExecutableRecord>,
  rewriteWorkspaceScripts = false
): void {
  const availableExecutableRecords = new Map(executableRecords);

  const resolveWorkspaceExecutablePath = (cwd: string, executable: string): string | null => {
    try {
      return toProjectPath(workspaceRoot, resolveWorkspaceCommandPath(workspaceRoot, cwd, executable, workspaceAlias));
    } catch {
      return null;
    }
  };

  const resolveExecutableInvocationPath = (cwd: string, executable: string): string | null => {
    // A bare command name is resolved through PATH by the shell. Do not silently
    // reinterpret it as a file in cwd; virtual executables require an explicit
    // path such as ./app or bin/app at invocation time.
    if (!executable.includes('/') && !executable.startsWith('/')) return null;
    return resolveWorkspaceExecutablePath(cwd, executable);
  };

  const resolveProducedExecutablePath = (cwd: string, output: string): string | null => {
    // Compiler -o operands are filesystem paths relative to cwd even when they
    // are bare names. This resolver is intentionally separate from invocation
    // PATH semantics so `-o app && ./app` works on the first run without making
    // a bare `app` command implicitly executable from cwd.
    return resolveWorkspaceExecutablePath(cwd, output);
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
        const resolvedExecutablePath = resolveExecutableInvocationPath(cwd, name);
        if (
          resolvedExecutablePath &&
          (rewriteWorkspaceScripts || availableExecutableRecords.has(resolvedExecutablePath))
        ) {
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
            const outputPath = resolveProducedExecutablePath(currentCwd, cppOutputPathFromArgs(parsed.args));
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

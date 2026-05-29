import { emitRuntimeCommandFileChanges } from '../../harness-core/src/runtime-project';
import type {
  RuntimeCommandResult,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileEncoding,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectSnapshot,
} from '../../harness-core/src/runtime-project';
import type * as TypeScript from 'typescript';

export type TypeScriptProjectFileEncoding = RuntimeFileEncoding;
export type TypeScriptProjectFile = RuntimeFile;
export type TypeScriptProjectSnapshot = RuntimeProjectSnapshot;
export type TypeScriptProjectCommandRequest = RuntimeProjectCommandRequest<'compile'>;
export type TypeScriptProjectCommandResult = RuntimeCommandResult;
export type TypeScriptProjectCommandRunner = RuntimeProjectCommandRunner<TypeScriptProjectCommandRequest>;
export type TypeScriptProjectCompiler = typeof TypeScript;

export interface TypeScriptProjectRunnerOptions {
  defaultOutDir?: string;
  compiler?: TypeScriptProjectCompiler;
  loadCompiler?: () => Promise<TypeScriptProjectCompiler>;
}

const DEFAULT_LIB_PATH = '/__tracecode_typescript_lib.d.ts';
const DEFAULT_LIB = [
  'interface Array<T> { length: number; [n: number]: T; [Symbol.iterator](): Iterator<T>; forEach(callbackfn: (value: T, index: number, array: T[]) => void): void; map<U>(callbackfn: (value: T, index: number, array: T[]) => U): U[]; filter(callbackfn: (value: T, index: number, array: T[]) => unknown): T[]; reduce<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U, initialValue: U): U; slice(start?: number, end?: number): T[]; sort(compareFn?: (a: T, b: T) => number): this; join(separator?: string): string; push(...items: T[]): number; }',
  'interface Boolean {}',
  'interface CallableFunction {}',
  'interface Error { name: string; message: string; stack?: string; }',
  'interface Function {}',
  'interface IArguments {}',
  'interface ArrayLike<T> { readonly length: number; readonly [n: number]: T; }',
  'interface Iterable<T> { [Symbol.iterator](): Iterator<T>; }',
  'interface Iterator<T> { next(): { value: T; done?: boolean } }',
  'interface NewableFunction {}',
  'interface Number {}',
  'interface Object {}',
  'interface Promise<T> { then<TResult>(onfulfilled?: (value: T) => TResult | Promise<TResult>): Promise<TResult>; catch<TResult>(onrejected?: (reason: any) => TResult | Promise<TResult>): Promise<T | TResult>; }',
  'interface RegExp {}',
  'interface String { length: number; [Symbol.iterator](): Iterator<string>; trim(): string; split(separator: string | RegExp): string[]; includes(searchString: string): boolean; startsWith(searchString: string): boolean; endsWith(searchString: string): boolean; slice(start?: number, end?: number): string; toLowerCase(): string; toUpperCase(): string; }',
  'interface Map<K, V> { get(key: K): V | undefined; set(key: K, value: V): this; has(key: K): boolean; entries(): Iterable<[K, V]>; }',
  'interface Set<T> { add(value: T): this; has(value: T): boolean; }',
  'declare const Array: { isArray(value: any): value is any[] };',
  'declare const Number: { (value?: any): number };',
  'declare const String: { (value?: any): string };',
  'declare const Boolean: { (value?: any): boolean };',
  'declare const Error: { new(message?: string): Error };',
  'declare const Promise: { new<T>(executor: (resolve: (value: T) => void, reject: (reason?: any) => void) => void): Promise<T>; resolve<T>(value: T): Promise<T> };',
  'declare const Map: { new<K, V>(): Map<K, V> };',
  'declare const Set: { new<T>(): Set<T> };',
  'declare const Symbol: { readonly iterator: unique symbol };',
  'interface ArrayBuffer { readonly byteLength: number; slice(begin: number, end?: number): ArrayBuffer; }',
  'interface ArrayBufferView { readonly buffer: ArrayBuffer; readonly byteOffset: number; readonly byteLength: number; }',
  'interface Uint8Array extends ArrayBufferView { readonly length: number; [n: number]: number; }',
  'declare const Uint8Array: { new(length: number): Uint8Array; new(array: ArrayLike<number>): Uint8Array; from(arrayLike: ArrayLike<number>): Uint8Array; }',
  'type HeadersInit = Headers | Record<string, string> | Array<[string, string]>;',
  'type BodyInit = string | ArrayBuffer | Uint8Array;',
  'interface Headers { append(name: string, value: string): void; get(name: string): string | null; has(name: string): boolean; set(name: string, value: string): void; }',
  'declare const Headers: { new(init?: HeadersInit): Headers };',
  'interface AbortSignal { readonly aborted: boolean; }',
  'interface AbortController { readonly signal: AbortSignal; abort(reason?: any): void; }',
  'declare const AbortController: { new(): AbortController };',
  'interface RequestInit { method?: string; headers?: HeadersInit; body?: BodyInit; signal?: AbortSignal; }',
  'interface Request { readonly method: string; readonly url: string; readonly headers: Headers; clone(): Request; }',
  'declare const Request: { new(input: string | Request, init?: RequestInit): Request };',
  'interface Response { readonly status: number; readonly ok: boolean; readonly headers: Headers; readonly url: string; readonly bodyUsed: boolean; text(): Promise<string>; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer>; clone(): Response; }',
  'declare const Response: { new(body?: BodyInit, init?: { status?: number; headers?: HeadersInit }): Response };',
  'declare function fetch(input: string | Request, init?: RequestInit): Promise<Response>;',
  'declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): any;',
  'declare function clearTimeout(id: any): void;',
  'declare const JSON: { parse(text: string): any; stringify(value: any): string };',
  'declare const Math: { max(...values: number[]): number; min(...values: number[]): number; round(value: number): number; floor(value: number): number; ceil(value: number): number; abs(value: number): number };',
  'declare const console: { log(...args: any[]): void; error(...args: any[]): void; warn(...args: any[]): void };',
  'declare const process: { argv: string[]; env: Record<string, string | undefined>; exitCode?: number; cwd(): string };',
  'declare function require(specifier: string): any;',
  'declare const exports: any;',
  'declare const module: { exports: any };',
  'type Record<K extends keyof any, T> = { [P in K]: T };',
  '',
].join('\n');

function normalizeProjectPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function projectRoot(project: RuntimeProjectSnapshot): string {
  return project.workspaceRoot ?? project.cwd ?? '/workspace';
}

function stripProjectRoot(path: string, project: RuntimeProjectSnapshot): string | null {
  const normalized = path.replace(/\\/g, '/');
  const roots = [projectRoot(project), project.workspaceAlias, '/workspace']
    .filter((root): root is string => typeof root === 'string' && root.length > 0);
  for (const root of roots) {
    if (normalized === root) return '';
    if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  }
  return null;
}

function absoluteProjectPath(path: string, project: RuntimeProjectSnapshot, cwd = project.cwd ?? projectRoot(project)): string {
  const stripped = stripProjectRoot(path, project);
  if (stripped !== null) return `${projectRoot(project)}/${normalizeProjectPath(stripped)}`.replace(/\/$/, '');
  if (path.startsWith('/')) return path.replace(/\/+$/, '');
  const cwdRelative = stripProjectRoot(cwd, project) ?? '';
  return `${projectRoot(project)}/${normalizeProjectPath(`${cwdRelative}/${path}`)}`.replace(/\/$/, '');
}

function relativeProjectPath(path: string, project: RuntimeProjectSnapshot): string {
  return normalizeProjectPath(stripProjectRoot(path, project) ?? path);
}

function fileBytes(file: RuntimeFile): Uint8Array {
  if (file.encoding === 'base64') {
    const binary = typeof atob === 'function'
      ? Uint8Array.from(atob(file.contents), (char) => char.charCodeAt(0))
      : Uint8Array.from(Buffer.from(file.contents, 'base64'));
    return binary;
  }
  return new TextEncoder().encode(file.contents);
}

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function toRuntimeFile(path: string, contents: string, project: RuntimeProjectSnapshot): RuntimeFile {
  return {
    path: relativeProjectPath(path, project),
    contents,
  };
}

function parseJsonObject(contents: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(contents) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function configDirectory(configPath: string, project: RuntimeProjectSnapshot): string {
  return configPath.slice(0, Math.max(0, configPath.lastIndexOf('/'))) || projectRoot(project);
}

async function loadDefaultCompiler(): Promise<TypeScriptProjectCompiler> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<TypeScriptProjectCompiler>;
  return dynamicImport('typescript');
}

function compilerOptionsFromArgs(
  compiler: TypeScriptProjectCompiler,
  args: readonly string[],
  project: RuntimeProjectSnapshot
): TypeScript.CompilerOptions {
  const options: TypeScript.CompilerOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === '--noEmit') options.noEmit = true;
    if (arg === '--outDir' && value) {
      options.outDir = absoluteProjectPath(value, project);
      index += 1;
    }
    if (arg === '--rootDir' && value) {
      options.rootDir = absoluteProjectPath(value, project);
      index += 1;
    }
    if (arg === '--module' && value) {
      options.module = value.toLowerCase() === 'esnext' ? compiler.ModuleKind.ESNext : compiler.ModuleKind.CommonJS;
      index += 1;
    }
    if (arg === '--target' && value) {
      const target = value.toLowerCase();
      options.target = target === 'esnext'
        ? compiler.ScriptTarget.ESNext
        : target === 'es2022'
          ? compiler.ScriptTarget.ES2022
          : compiler.ScriptTarget.ES2020;
      index += 1;
    }
  }
  return options;
}

function configPathFromArgs(args: readonly string[], project: RuntimeProjectSnapshot, cwd: string): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === '-p' || arg === '--project') && args[index + 1]) {
      const value = args[index + 1]!;
      return absoluteProjectPath(value.endsWith('.json') ? value : `${value}/tsconfig.json`, project, cwd);
    }
    if (arg.startsWith('--project=')) {
      const value = arg.slice('--project='.length);
      return absoluteProjectPath(value.endsWith('.json') ? value : `${value}/tsconfig.json`, project, cwd);
    }
  }
  return absoluteProjectPath('tsconfig.json', project, cwd);
}

function allProjectSourceFiles(project: RuntimeProjectSnapshot): string[] {
  return project.files
    .map((file) => `${projectRoot(project)}/${normalizeProjectPath(file.path)}`)
    .filter((path) =>
      (path.endsWith('.ts') || path.endsWith('.tsx')) &&
      !path.endsWith('.d.ts') &&
      !path.includes('/dist/') &&
      !path.endsWith('/dist') &&
      !path.includes('/node_modules/')
    )
    .sort((left, right) => left.localeCompare(right));
}

function sourceRootsFromProject(
  project: RuntimeProjectSnapshot,
  parsedConfig: TypeScript.ParsedCommandLine | null
): string[] {
  if (parsedConfig) {
    return parsedConfig.fileNames.map((file) => file.replace(/\\/g, '/'));
  }
  return allProjectSourceFiles(project);
}

function isUnderDirectory(path: string, directory: string): boolean {
  const normalizedDirectory = directory.replace(/\/+$/, '');
  return path === normalizedDirectory || path.startsWith(`${normalizedDirectory}/`);
}

function globToRegExp(pattern: string, basePath: string): RegExp {
  const absolutePattern = pattern.startsWith('/')
    ? `/${normalizeProjectPath(pattern)}`
    : `${basePath.replace(/\/+$/, '')}/${normalizeProjectPath(pattern)}`;
  let source = '^';
  for (let index = 0; index < absolutePattern.length; index += 1) {
    const char = absolutePattern[index];
    const next = absolutePattern[index + 1];
    if (char === '*' && next === '*') {
      if (absolutePattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
    }
  }
  source += '$';
  return new RegExp(source);
}

function createConfigParseHost(
  compiler: TypeScriptProjectCompiler,
  project: RuntimeProjectSnapshot,
  files: Map<string, string>
): TypeScript.ParseConfigHost {
  return {
    useCaseSensitiveFileNames: true,
    fileExists: (path) => files.has(path.replace(/\\/g, '/')),
    readFile: (path) => files.get(path.replace(/\\/g, '/')),
    readDirectory: (rootDir, extensions, excludes, includes) => {
      const normalizedRoot = rootDir.replace(/\\/g, '/').replace(/\/+$/, '');
      const extensionSet = new Set((extensions && extensions.length > 0 ? extensions : ['.ts', '.tsx']).map((extension) => extension.toLowerCase()));
      const includePatterns = (includes && includes.length > 0 ? includes : ['**/*'])
        .map((pattern) => globToRegExp(pattern, normalizedRoot));
      const excludePatterns = (excludes ?? [])
        .map((pattern) => globToRegExp(pattern, normalizedRoot));
      return allProjectSourceFiles(project).filter((path) => {
        if (!isUnderDirectory(path, normalizedRoot)) return false;
        if (!extensionSet.has(path.slice(path.lastIndexOf('.')).toLowerCase())) return false;
        if (excludePatterns.some((pattern) => pattern.test(path))) return false;
        return includePatterns.some((pattern) => pattern.test(path));
      });
    },
  };
}

function parseConfig(
  compiler: TypeScriptProjectCompiler,
  configPath: string,
  files: Map<string, string>,
  config: Record<string, unknown> | null,
  cliOptions: TypeScript.CompilerOptions,
  project: RuntimeProjectSnapshot
): TypeScript.ParsedCommandLine {
  const basePath = configDirectory(configPath, project);
  const defaultOptions: TypeScript.CompilerOptions = {
    target: compiler.ScriptTarget.ES2020,
    module: compiler.ModuleKind.CommonJS,
    moduleResolution: compiler.ModuleResolutionKind.Node10,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    rootDir: projectRoot(project),
    outDir: `${projectRoot(project)}/dist`,
  };
  const parsedConfig = config
    ? compiler.parseJsonConfigFileContent(config, createConfigParseHost(compiler, project, files), basePath)
    : { options: {} as TypeScript.CompilerOptions, fileNames: allProjectSourceFiles(project), errors: [] };
  return {
    ...parsedConfig,
    options: {
      ...defaultOptions,
      ...parsedConfig.options,
      ...cliOptions,
      noLib: true,
      types: [],
    },
  };
}

function createCompilerHost(
  compiler: TypeScriptProjectCompiler,
  project: RuntimeProjectSnapshot,
  files: Map<string, string>,
  outputs: Map<string, string>,
  options: TypeScript.CompilerOptions
): TypeScript.CompilerHost {
  return {
    getSourceFile: (fileName, languageVersion) => {
      const normalized = fileName.replace(/\\/g, '/');
      const contents = files.get(normalized);
      return contents === undefined ? undefined : compiler.createSourceFile(normalized, contents, languageVersion);
    },
    getDefaultLibFileName: () => DEFAULT_LIB_PATH,
    writeFile: (fileName, contents) => {
      outputs.set(fileName.replace(/\\/g, '/'), contents);
    },
    getCurrentDirectory: () => project.cwd ?? projectRoot(project),
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => files.has(fileName.replace(/\\/g, '/')),
    readFile: (fileName) => files.get(fileName.replace(/\\/g, '/')),
    directoryExists: (directoryName) => {
      const directory = directoryName.replace(/\\/g, '/').replace(/\/+$/, '');
      return [...files.keys()].some((file) => file.startsWith(`${directory}/`));
    },
    getDirectories: (directoryName) => {
      const directory = directoryName.replace(/\\/g, '/').replace(/\/+$/, '');
      const children = new Set<string>();
      for (const file of files.keys()) {
        if (!file.startsWith(`${directory}/`)) continue;
        const next = file.slice(directory.length + 1).split('/')[0];
        if (next && file.slice(directory.length + 1).includes('/')) children.add(next);
      }
      return [...children].sort();
    },
  };
}

function formatDiagnostic(
  compiler: TypeScriptProjectCompiler,
  diagnostic: TypeScript.Diagnostic,
  project: RuntimeProjectSnapshot
): string {
  const message = compiler.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file || diagnostic.start === undefined) return `error TS${diagnostic.code}: ${message}`;
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${projectRoot(project)}/${relativeProjectPath(diagnostic.file.fileName, project)}:${position.line + 1}:${position.character + 1} - error TS${diagnostic.code}: ${message}`;
}

export function createTypeScriptProjectRunner(
  options: TypeScriptProjectRunnerOptions = {}
): TypeScriptProjectCommandRunner {
  return async (request) => {
    const ioStatus = (phase: string, message: string, detail?: Record<string, unknown>): void => {
      request.onEvent?.({ type: 'status', phase, message, ...(detail ? { detail } : {}) });
    };
    ioStatus('compile-start', 'Starting TypeScript project compile', { command: 'tsc', args: request.args, cwd: request.cwd });
    const compiler = options.compiler ?? await (options.loadCompiler ?? loadDefaultCompiler)();

    const files = new Map<string, string>([
      [DEFAULT_LIB_PATH, DEFAULT_LIB],
    ]);
    for (const file of request.project.files) {
      files.set(absoluteProjectPath(file.path, request.project), decodeBytes(fileBytes(file)));
    }

    const configPath = configPathFromArgs(request.args, request.project, request.cwd);
    const config = files.has(configPath)
      ? parseJsonObject(files.get(configPath)!)
      : null;
    const parsedConfig = parseConfig(
      compiler,
      configPath,
      files,
      config,
      compilerOptionsFromArgs(compiler, request.args, request.project),
      request.project
    );
    const compilerOptions = parsedConfig.options;
    const rootNames = [DEFAULT_LIB_PATH, ...sourceRootsFromProject(request.project, parsedConfig)];
    const outputs = new Map<string, string>();
    const host = createCompilerHost(compiler, request.project, files, outputs, compilerOptions);
    const program = compiler.createProgram(rootNames, compilerOptions, host);
    const emit = program.emit();
    const diagnostics = [...parsedConfig.errors, ...compiler.getPreEmitDiagnostics(program), ...emit.diagnostics]
      .filter((diagnostic) => diagnostic.file?.fileName !== DEFAULT_LIB_PATH);
    const stderr = diagnostics.map((diagnostic) => formatDiagnostic(compiler, diagnostic, request.project)).join('\n');
    const resultFiles: RuntimeFileChange[] = compilerOptions.noEmit
      ? []
      : [...outputs.entries()]
          .filter(([path]) => !path.endsWith('.map'))
          .map(([path, contents]) => toRuntimeFile(path, contents, request.project))
          .filter((file) => !file.path.startsWith('__tracecode_'));
    emitRuntimeCommandFileChanges(request.onEvent, resultFiles);
    const exitCode = diagnostics.length > 0 || emit.emitSkipped ? 1 : 0;
    ioStatus('compile-end', 'Finished TypeScript project compile', { command: 'tsc', exitCode });
    return {
      stdout: '',
      stderr: stderr ? `${stderr}\n` : '',
      exitCode,
      ...(resultFiles.length > 0 ? { files: resultFiles } : {}),
    };
  };
}

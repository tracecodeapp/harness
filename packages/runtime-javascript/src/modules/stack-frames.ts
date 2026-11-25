// Stack frames for workspace modules.
//
// `compile` turns each module body into its wrapper function with an indirect
// eval of one function expression whose header shares the body's first line:
//
//   (function (require, module, exports, ...) {<body>
//   })
//   //# sourceURL=<the module's file>
//
// The engine attributes the module's frames to its file when it captures them,
// and engine line N is the file's line N in every engine. Only columns on the
// first line are shifted, by the header's length. The body is first parsed on
// its own with the Function constructor (not run), so a body that is not a
// whole function body throws the same SyntaxError as before and a body that
// would close the wrapper early never reaches eval. If eval does not return
// exactly that function, the constructed function is used; the constructor puts
// the body on line 3, so the formatter subtracts two lines for it.
//
// On V8 an `Error.prepareStackTrace` formatter is installed while a command
// runs. It builds each stack from the error's call sites: a frame in a module
// gets the module's file, line and column (first-line columns without the
// header), the module's top-level code is named the way Node names it, and
// frames outside the workspace (the runtime, the host page, the engine) are
// left out. The stack is therefore right whenever the program reads
// `err.stack`, not only when the runner prints an uncaught error. Errors with
// no workspace frame keep the host's formatting.

import {
  AsyncFunction,
  BrowserFunction,
  browserIndirectEval,
} from "./constructors";

export type WorkspaceModuleKind = 'commonjs' | 'module' | 'script';

/** Lines the Function constructor adds before the module body. */
const FUNCTION_BODY_LINE_OFFSET = 2;

const functionToString = Function.prototype.toString;

interface WorkspaceModuleSource {
  /** The file as Node names it in a frame: a path, or a file: URL for ES modules. */
  location: string;
  kind: WorkspaceModuleKind;
  /** Engine lines before the body's first line. */
  lineOffset: number;
  /** Engine columns before the body on its first line. */
  firstLineColumnOffset: number;
  /** The module body, to read a frame's function at its source position. */
  code: string;
  /** Offsets of the body's line starts, filled on first use. */
  lineStarts?: number[];
}

/** The parameters of every module wrapper, in the order the loader passes them. */
export const MODULE_WRAPPER_PARAMETERS = Object.freeze([
  'require',
  '__import',
  'module',
  'exports',
  'console',
  'process',
  'Buffer',
  '__filename',
  '__dirname',
] as const);

export interface WorkspaceModuleCompileOptions {
  /** The wrapper's parameter names, in call order. */
  parameters: readonly string[];
  /** An async wrapper, for code that may use top-level await. */
  async?: boolean;
}

interface V8CallSite {
  getFunctionName(): string | null;
  getMethodName?(): string | null;
  getTypeName?(): string | null;
  getLineNumber(): number | null;
  getColumnNumber(): number | null;
  getEnclosingLineNumber?(): number | null;
  getEnclosingColumnNumber?(): number | null;
  getScriptNameOrSourceURL?(): string | null | undefined;
  isAsync?(): boolean;
  isConstructor?(): boolean;
  isToplevel?(): boolean;
  toString(): string;
}

type PrepareStackTrace = (error: unknown, sites: V8CallSite[]) => unknown;

// Typed loosely: lib.dom has no prepareStackTrace, and @types/node types it narrowly.
const errorConstructor = Error as unknown as { prepareStackTrace?: unknown };

export interface WorkspaceStackFrames {
  /** The module's wrapper function, compiled so its frames name `location`. */
  compile(
    code: string,
    location: string,
    kind: WorkspaceModuleKind,
    options: WorkspaceModuleCompileOptions
  ): (...args: unknown[]) => unknown;
  /** Whether a line of stack text names a frame in a workspace module. */
  isWorkspaceFrame(line: string): boolean;
  /** Stop attributing this command's modules; the last release restores the host formatter. */
  release(): void;
}

const errorToString = Error.prototype.toString;
const activeModuleSources = new Set<Map<string, WorkspaceModuleSource>>();
const formattedStacks = new WeakMap<object, string>();
let hostStackHook: { had: boolean; value: unknown } | null = null;

function errorHeader(error: unknown): string {
  try {
    return errorToString.call(error);
  } catch {
    return '<error>';
  }
}

function lookupModuleSource(sourceUrl: string): WorkspaceModuleSource | undefined {
  for (const sources of activeModuleSources) {
    const source = sources.get(sourceUrl);
    if (source) return source;
  }
  return undefined;
}

/** The body offset of an engine position, or null inside the wrapper's header. */
function bodyIndex(source: WorkspaceModuleSource, line: number, column: number): number | null {
  const bodyLine = line - source.lineOffset;
  const bodyColumn = column - 1 - (bodyLine === 1 ? source.firstLineColumnOffset : 0);
  if (bodyLine < 1 || bodyColumn < 0) return null;
  if (!source.lineStarts) {
    const starts = [0];
    for (const match of source.code.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) starts.push(match.index + match[0].length);
    source.lineStarts = starts;
  }
  const start = source.lineStarts[bodyLine - 1];
  return start === undefined ? null : start + bodyColumn;
}

// The function starts here: `eval(`, `async eval(`, `*eval(`, `function eval(`.
const EVAL_NAMED_START = /^(?:(?:async|static)\s+)*(?:function\b\s*)?\*?\s*eval\s*\(/;
// Or it is the value of an `eval` key or field: `eval: function`, `eval = () =>`.
const EVAL_NAMED_KEY = /(?:\beval|(["'])eval\1)\s*[:=]\s*(?:async\s+)?$/;

/**
 * Whether the function a frame is in is really named `eval`. V8 reports
 * `eval` for every function without a name in eval'd code, the module
 * wrapper included, so read the function's start in the module's source:
 * the wrapper starts inside the header, and a named function names itself.
 */
function namedEval(source: WorkspaceModuleSource, site: V8CallSite): boolean {
  const line = site.getEnclosingLineNumber?.();
  const column = site.getEnclosingColumnNumber?.();
  if (line === null || line === undefined || column === null || column === undefined) return false;
  const index = bodyIndex(source, line, column);
  if (index === null) return false;
  return EVAL_NAMED_START.test(source.code.slice(index, index + 80)) ||
    EVAL_NAMED_KEY.test(source.code.slice(Math.max(0, index - 80), index));
}

/** A frame in a function with no name, as V8 prints one (and Node shows it). */
function anonymousFrame(site: V8CallSite, location: string): string {
  const prefix = site.isAsync?.() ? 'async ' : '';
  if (site.isConstructor?.()) return `${prefix}new <anonymous> (${location})`;
  if (site.isToplevel?.() === false) {
    const typeName = site.getTypeName?.();
    return `${prefix}${typeName ? `${typeName}.` : ''}${site.getMethodName?.() || '<anonymous>'} (${location})`;
  }
  return `${prefix}${location}`;
}

function workspaceFrame(site: V8CallSite): string | null {
  const sourceUrl = site.getScriptNameOrSourceURL?.();
  const source = sourceUrl ? lookupModuleSource(sourceUrl) : undefined;
  const line = site.getLineNumber();
  const column = site.getColumnNumber();
  if (!sourceUrl || !source || line === null || column === null) return null;

  const bodyLine = line - source.lineOffset;
  const fileLine = Math.max(1, bodyLine);
  const fileColumn = bodyLine === 1 ? Math.max(1, column - source.firstLineColumnOffset) : column;
  const location = `${source.location}:${fileLine}:${fileColumn}`;
  // The module wrapper and every other function without a name read `eval`
  // here. Node shows them without a name: the CommonJS wrapper, called on
  // module.exports, as `Object.<anonymous>`; an ES module's top-level code and
  // a callback as a bare location.
  if (site.getFunctionName() === 'eval' && !namedEval(source, site)) return anonymousFrame(site, location);
  const engineLocation = `${sourceUrl}:${line}:${column}`;
  const frame = String(site);
  const index = frame.lastIndexOf(engineLocation);
  return index === -1
    ? frame
    : `${frame.slice(0, index)}${location}${frame.slice(index + engineLocation.length)}`;
}

function hostFormat(error: unknown, sites: V8CallSite[]): unknown {
  const host = hostStackHook?.value;
  if (typeof host === 'function') return (host as PrepareStackTrace)(error, sites);
  return `${errorHeader(error)}${sites.map((site) => `\n    at ${String(site)}`).join('')}`;
}

const prepareWorkspaceStackTrace: PrepareStackTrace = (error, sites) => {
  const frames: string[] = [];
  for (const site of sites) {
    const frame = workspaceFrame(site);
    if (frame !== null) frames.push(frame);
  }
  if (frames.length === 0) return hostFormat(error, sites);
  const stack = `${errorHeader(error)}${frames.map((frame) => `\n    at ${frame}`).join('')}`;
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    formattedStacks.set(error, stack);
  }
  return stack;
};

function installStackHook(): void {
  if (hostStackHook) return;
  const host = {
    had: Object.prototype.hasOwnProperty.call(errorConstructor, 'prepareStackTrace'),
    value: errorConstructor.prepareStackTrace,
  };
  try {
    errorConstructor.prepareStackTrace = prepareWorkspaceStackTrace;
    hostStackHook = host;
  } catch {
    // A frozen Error keeps engine formatting; frames still name their files.
  }
}

function restoreStackHook(): void {
  if (!hostStackHook) return;
  const host = hostStackHook;
  hostStackHook = null;
  try {
    if (host.had) {
      errorConstructor.prepareStackTrace = host.value;
    } else {
      delete errorConstructor.prepareStackTrace;
    }
  } catch {
    // User code can still poison same-realm globals; worker-backed runs discard the realm.
  }
}

/** The error's first lines, as an engine's own stack begins: `Name: message`. */
export function errorMessageHeader(error: unknown): string {
  return errorHeader(error);
}

/**
 * Whether a stack is in the Firefox and WebKit shape: frames only, as
 * `name@location`, with no `Name: message` lines before them.
 */
export function isEngineFrameOnlyStack(stack: string): boolean {
  const lines = stack.split('\n');
  return (lines[0] ?? '').includes('@') && !lines.some((line) => /^\s+at /.test(line));
}

/** An error's stack with its whole message first, as Node prints an error. */
export function errorTextWithMessage(error: Error): string {
  const header = errorHeader(error);
  const stack = error.stack;
  if (typeof stack !== 'string' || !stack.trim()) return header;
  return isEngineFrameOnlyStack(stack) && !stack.startsWith(`${header}\n`)
    ? `${header}\n${stack.replace(/\n+$/, '')}`
    : stack;
}

/**
 * Whether the workspace formatter built this error's current stack. Such a
 * stack already names every frame's file and holds only workspace frames.
 */
export function isWorkspaceFormattedStack(error: unknown): boolean {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return false;
  const stack = formattedStacks.get(error);
  return stack !== undefined && (error as { stack?: unknown }).stack === stack;
}

/** A sourceURL ends at whitespace, so encode whitespace in the file's name. */
function sourceUrlFor(location: string): string {
  return location.replace(/\s/g, (character) => encodeURIComponent(character));
}

export function createWorkspaceStackFrames(): WorkspaceStackFrames {
  const sources = new Map<string, WorkspaceModuleSource>();
  activeModuleSources.add(sources);
  installStackHook();
  let released = false;
  return {
    compile(code, location, kind, options) {
      const sourceUrl = sourceUrlFor(location);
      const Constructor = options.async ? AsyncFunction : BrowserFunction;
      // Parse the body alone first, without running it: this throws the same
      // SyntaxError as before for a body that is not a whole function body,
      // so a body that would close the wrapper early never reaches eval,
      // which runs the script it parses.
      const constructed = new Constructor(...options.parameters, `${code}\n//# sourceURL=${sourceUrl}`) as (...args: unknown[]) => unknown;
      const header = `(${options.async ? 'async ' : ''}function (${options.parameters.join(', ')}) {`;
      try {
        const compiled = browserIndirectEval(`${header}${code}\n})\n//# sourceURL=${sourceUrl}`);
        if (typeof compiled === 'function' && functionToString.call(compiled) === `${header.slice(1)}${code}\n}`) {
          sources.set(sourceUrl, { location, kind, lineOffset: 0, firstLineColumnOffset: header.length, code });
          return compiled as (...args: unknown[]) => unknown;
        }
      } catch {
        // Keep the constructed function below.
      }
      sources.set(sourceUrl, { location, kind, lineOffset: FUNCTION_BODY_LINE_OFFSET, firstLineColumnOffset: 0, code });
      return constructed;
    },
    isWorkspaceFrame(line) {
      for (const [sourceUrl, source] of sources) {
        for (const name of sourceUrl === source.location ? [sourceUrl] : [sourceUrl, source.location]) {
          const index = line.indexOf(`${name}:`);
          if (index !== -1 && /^\d/.test(line.slice(index + name.length + 1))) return true;
        }
      }
      return false;
    },
    release() {
      if (released) return;
      released = true;
      activeModuleSources.delete(sources);
      if (activeModuleSources.size === 0) restoreStackHook();
    },
  };
}

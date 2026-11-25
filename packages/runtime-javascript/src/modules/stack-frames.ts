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
  getLineNumber(): number | null;
  getColumnNumber(): number | null;
  getScriptNameOrSourceURL?(): string | null | undefined;
  isAsync?(): boolean;
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
  // V8 names the wrapper function `eval`. That function is the module's
  // top-level code, which Node shows as `Object.<anonymous>` for CommonJS and
  // as a bare location for ES modules and `node -e`.
  if (site.getFunctionName() === 'eval') {
    if (source.kind === 'commonjs') return `Object.<anonymous> (${location})`;
    return `${site.isAsync?.() ? 'async ' : ''}${location}`;
  }
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
          sources.set(sourceUrl, { location, kind, lineOffset: 0, firstLineColumnOffset: header.length });
          return compiled as (...args: unknown[]) => unknown;
        }
      } catch {
        // Keep the constructed function below.
      }
      sources.set(sourceUrl, { location, kind, lineOffset: FUNCTION_BODY_LINE_OFFSET, firstLineColumnOffset: 0 });
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

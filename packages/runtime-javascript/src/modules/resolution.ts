import type {
  RuntimeKernelHttpRequest,
} from "@tracecode/runtime-contracts";

import {
  JavaScriptProjectCommandRequest,
} from "../browser/contracts";

import {
  normalizeProjectPath,
  dirname,
  workspaceCwdPath,
} from "../kernel/path-normalization";

import type {
  WorkspacePathContext,
} from "../kernel/workspace-paths";

import {
  normalizeWorkspaceEntryPath,
} from "../kernel/workspace-paths";

import {
  PackageMetadata,
  PackageResolutionCondition,
} from "./contracts";

import {
  isWorkspaceFormattedStack,
  type WorkspaceStackFrames,
} from "./stack-frames";

export function moduleDefault(value: unknown): unknown {
  return (value as Record<string, unknown>).default;
}

export function workspaceFilename(path: string, workspaceRoot = '/workspace'): string {
  const normalized = normalizeProjectPath(path);
  return normalized ? `${workspaceRoot}/${normalized}` : workspaceRoot;
}

export function workspaceFileUrl(path: string, workspaceRoot = '/workspace'): string {
  return `file://${workspaceFilename(path, workspaceRoot).split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

export function relativeWorkspacePath(from: string, to: string): string {
  const fromParts = normalizeProjectPath(from).split('/').filter(Boolean);
  const toParts = normalizeProjectPath(to).split('/').filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common += 1;
  }
  return [
    ...fromParts.slice(common).map(() => '..'),
    ...toParts.slice(common),
  ].join('/') || '.';
}

export function workspaceDirname(path: string, workspaceRoot = '/workspace'): string {
  const normalizedDir = dirname(normalizeProjectPath(path));
  return normalizedDir ? `${workspaceRoot}/${normalizedDir}` : workspaceRoot;
}

export function joinModulePath(parentPath: string, specifier: string): string {
  const parentDir = dirname(parentPath);
  const joined = `${parentDir}/${specifier}`.replace(/^\//, '');
  const parts: string[] = [];
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

export function moduleFileCandidates(path: string): string[] {
  const normalized = normalizeProjectPath(path);
  const candidates = [normalized];
  if (!/\.(?:cjs|js|json|mjs)$/.test(normalized)) {
    candidates.push(`${normalized}.js`, `${normalized}.json`, `${normalized}.mjs`, `${normalized}.cjs`);
  }
  return candidates;
}

export function parsePackageJson(modules: Map<string, string>, path: string): PackageMetadata | null {
  const normalized = normalizeProjectPath(path);
  const packageJson = modules.get(normalized ? `${normalized}/package.json` : 'package.json');
  if (!packageJson) return null;

  try {
    return JSON.parse(packageJson) as PackageMetadata;
  } catch {
    return null;
  }
}

export function manifestDeclaresDependency(manifest: PackageMetadata, dependency: string): boolean {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const dependencies = manifest[field];
    if (dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies) && dependency in dependencies) {
      return true;
    }
  }
  return false;
}

export function projectDeclaresDependency(modules: Map<string, string>, dependency: string): boolean {
  for (const path of modules.keys()) {
    if (!path.endsWith('package.json')) continue;
    const directory = dirname(path);
    const manifest = parsePackageJson(modules, directory);
    if (manifest && manifestDeclaresDependency(manifest, dependency)) return true;
  }
  return false;
}

export function packageExportTarget(value: unknown, condition: PackageResolutionCondition): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  return packageExportTarget(record[condition], condition)
    ?? packageExportTarget(record.node, condition)
    ?? packageExportTarget(record.default, condition)
    ?? packageExportTarget(condition === 'require' ? record.import : record.require, condition);
}

export function packageMainCandidates(
  modules: Map<string, string>,
  path: string,
  condition: PackageResolutionCondition
): string[] {
  const normalized = normalizeProjectPath(path);
  const parsed = parsePackageJson(modules, normalized);
  if (!parsed) return [];

  const candidates: string[] = [];
  const exportsTarget = packageExportTarget(parsed.exports, condition);
  if (exportsTarget) {
    candidates.push(...moduleFileCandidates(`${normalized}/${exportsTarget}`));
  }
  if (parsed.exports && typeof parsed.exports === 'object' && !Array.isArray(parsed.exports)) {
    const dotTarget = packageExportTarget((parsed.exports as Record<string, unknown>)['.'], condition);
    if (dotTarget) {
      candidates.push(...moduleFileCandidates(`${normalized}/${dotTarget}`));
    }
  }
  if (typeof parsed.module === 'string' && parsed.module.trim().length > 0) {
    candidates.push(...moduleFileCandidates(`${normalized}/${parsed.module}`));
  }
  if (typeof parsed.main === 'string' && parsed.main.trim().length > 0) {
    candidates.push(...moduleFileCandidates(`${normalized}/${parsed.main}`));
  }

  return candidates;
}

export function packageSpecifierParts(specifier: string): { packageName: string; subpath: string } | null {
  const parts = normalizeProjectPath(specifier).split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[0]?.startsWith('@')) {
    if (parts.length < 2) return null;
    return {
      packageName: `${parts[0]}/${parts[1]}`,
      subpath: parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.',
    };
  }
  return {
    packageName: parts[0] ?? '',
    subpath: parts.length > 1 ? `./${parts.slice(1).join('/')}` : '.',
  };
}

export function packageExportCandidates(
  modules: Map<string, string>,
  specifier: string,
  condition: PackageResolutionCondition
): string[] {
  const parsedSpecifier = packageLocationForSpecifier(specifier);
  if (!parsedSpecifier) return [];

  const packageRoot = parsedSpecifier.packageRoot;
  const parsed = parsePackageJson(modules, packageRoot);
  if (!parsed?.exports) return [];

  const exportTarget = parsedSpecifier.subpath === '.'
    ? packageExportTarget(parsed.exports, condition)
    : typeof parsed.exports === 'object' && !Array.isArray(parsed.exports)
      ? packageExportTarget((parsed.exports as Record<string, unknown>)[parsedSpecifier.subpath], condition)
      : null;

  if (!exportTarget) {
    return [];
  }

  return moduleFileCandidates(`${packageRoot}/${exportTarget}`);
}

export function packageLocationForSpecifier(specifier: string): { packageRoot: string; subpath: string } | null {
  const normalized = normalizeProjectPath(specifier);
  const parts = normalized.split('/').filter(Boolean);
  const nodeModulesIndex = parts.lastIndexOf('node_modules');
  if (nodeModulesIndex !== -1) {
    const packageStart = nodeModulesIndex + 1;
    const first = parts[packageStart];
    if (!first) return null;
    const packageLength = first.startsWith('@') ? 2 : 1;
    const packageParts = parts.slice(packageStart, packageStart + packageLength);
    if (packageParts.length !== packageLength || packageParts.some((part) => !part)) return null;
    const packageRoot = parts.slice(0, packageStart + packageLength).join('/');
    const subpathParts = parts.slice(packageStart + packageLength);
    return {
      packageRoot,
      subpath: subpathParts.length > 0 ? `./${subpathParts.join('/')}` : '.',
    };
  }

  const parsedSpecifier = packageSpecifierParts(normalized);
  if (!parsedSpecifier) return null;
  return {
    packageRoot: `node_modules/${parsedSpecifier.packageName}`,
    subpath: parsedSpecifier.subpath,
  };
}

export function moduleCandidates(
  modules: Map<string, string>,
  path: string,
  condition: PackageResolutionCondition
): string[] {
  const normalized = normalizeProjectPath(path);
  return [
    ...packageExportCandidates(modules, normalized, condition),
    ...moduleFileCandidates(normalized),
    ...packageMainCandidates(modules, normalized, condition),
    `${normalized}/index.js`,
    `${normalized}/index.json`,
  ];
}

export function nodePathEntries(
  request: JavaScriptProjectCommandRequest,
  cwdPath: string,
  workspace: WorkspacePathContext
): string[] {
  const rawNodePath = request.env.NODE_PATH;
  if (typeof rawNodePath !== 'string' || rawNodePath.trim().length === 0) {
    return [];
  }

  return rawNodePath
    .split(':')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => normalizeWorkspaceEntryPath(entry, cwdPath, true, workspace))
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
}

export function packageTypeForPath(modules: Map<string, string>, path: string): string | null {
  const normalized = normalizeProjectPath(path);
  const parts = normalized.split('/');
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const directory = parts.slice(0, index).join('/');
    const parsed = parsePackageJson(modules, directory);
    if (typeof parsed?.type === 'string') return parsed.type;
  }
  return null;
}

export function isEsmModule(modules: Map<string, string>, path: string): boolean {
  const normalized = normalizeProjectPath(path);
  if (normalized.endsWith('.mjs')) return true;
  if (normalized.endsWith('.cjs') || normalized.endsWith('.json')) return false;
  return normalized.endsWith('.js') && packageTypeForPath(modules, normalized) === 'module';
}

export function toRequireBinding(specifier: string): string {
  return `require(${JSON.stringify(specifier)})`;
}

export function toDynamicImportBinding(specifier: string): string {
  return `__import(${JSON.stringify(specifier)})`;
}

export function transformDynamicImports(code: string): string {
  return code.replace(
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    keepingLineBreaks((_match, _quote: string, specifier: string) => toDynamicImportBinding(specifier))
  );
}

type LineReplacer = (match: string, ...groups: any[]) => string;

const LINE_BREAKS = /\r\n|[\r\n\u2028\u2029]/g;

/**
 * A rewrite that keeps the source's line count, so the lines of a rewritten
 * module are the lines of its file and its stack frames point at them. Line
 * breaks a match spanned (a multi-line import list, trailing blank lines) are
 * put back after the replacement.
 */
function keepingLineBreaks(replacer: LineReplacer): LineReplacer {
  return (match, ...groups) => {
    const replacement = replacer(match, ...groups);
    // A function replacer's last two arguments are the offset and the source.
    const offset = groups[groups.length - 2] as number;
    const source = groups[groups.length - 1] as string;
    let breaks = match.match(LINE_BREAKS)?.length ?? 0;
    // A match that ends inside a CRLF pair leaves the LF, which still ends the line.
    if (match.endsWith('\r') && source[offset + match.length] === '\n') breaks -= 1;
    const missing = breaks - (replacement.match(LINE_BREAKS)?.length ?? 0);
    return missing > 0 ? `${replacement}${'\n'.repeat(missing)}` : replacement;
  };
}

export function serializableKernelHttpRequest(request: RuntimeKernelHttpRequest): RuntimeKernelHttpRequest {
  const { signal: _signal, ...serializable } = request;
  return serializable;
}

export function defaultImportBinding(name: string, specifier: string, index: number): string {
  const moduleName = `__tracecode_esm_default_${index}`;
  return [
    `const ${moduleName} = ${toRequireBinding(specifier)};`,
    `const ${name} = ${moduleName} && typeof ${moduleName} === "object" && "default" in ${moduleName} ? ${moduleName}.default : ${moduleName};`,
  ].join(' ');
}

export function transformNamedBindings(bindings: string): string {
  return bindings
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [importedName, localName] = part.split(/\s+as\s+/).map((value) => value.trim());
      return localName ? `${importedName}: ${localName}` : importedName;
    })
    .join(', ');
}

export function namedExportAssignments(bindings: string, moduleName?: string): string {
  return bindings
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [localName, exportedName] = part.split(/\s+as\s+/).map((value) => value.trim());
      const targetName = exportedName ?? localName;
      const source = moduleName ? `${moduleName}.${localName}` : localName;
      return `exports.${targetName} = ${source};`;
    })
    .join(' ');
}

// Leading whitespace on the statement's own line; never an earlier line.
const STATEMENT_INDENT = '[^\\S\\r\\n\\u2028\\u2029]*';

function statementPattern(pattern: string): RegExp {
  return new RegExp(`^${STATEMENT_INDENT}${pattern}`, 'gm');
}

export function transformStaticEsmToCommonJs(code: string, importMetaUrl?: string): string {
  let defaultImportIndex = 0;
  let reExportIndex = 0;
  return transformDynamicImports(code)
    .replace(
      /\bimport\.meta\.url\b/g,
      JSON.stringify(importMetaUrl ?? 'file:///workspace/[eval]')
    )
    .replace(
      statementPattern(String.raw`export\s+\*\s+from\s+(['"])([^'"]+)\1\s*;?\s*$`),
      keepingLineBreaks((_match, _quote: string, specifier: string) => {
        const moduleName = `__tracecode_esm_reexport_${reExportIndex++}`;
        return `const ${moduleName} = ${toRequireBinding(specifier)}; for (const __tracecode_key of Object.keys(${moduleName})) { if (__tracecode_key !== "default") exports[__tracecode_key] = ${moduleName}[__tracecode_key]; }`;
      })
    )
    .replace(
      statementPattern(String.raw`export\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2\s*;?\s*$`),
      keepingLineBreaks((_match, namedExports: string, _quote: string, specifier: string) => {
        const moduleName = `__tracecode_esm_reexport_${reExportIndex++}`;
        return `const ${moduleName} = ${toRequireBinding(specifier)}; ${namedExportAssignments(namedExports, moduleName)}`;
      })
    )
    .replace(
      statementPattern(String.raw`import\s+([\w$]+)\s*,\s*\*\s+as\s+([\w$]+)\s+from\s+(['"])([^'"]+)\3\s*;?\s*$`),
      keepingLineBreaks((_match, defaultName: string, namespaceName: string, _quote: string, specifier: string) => {
        const required = toRequireBinding(specifier);
        const moduleName = `__tracecode_esm_default_${defaultImportIndex++}`;
        return `const ${namespaceName} = ${required}; const ${moduleName} = ${namespaceName}; const ${defaultName} = ${moduleName} && typeof ${moduleName} === "object" && "default" in ${moduleName} ? ${moduleName}.default : ${moduleName};`;
      })
    )
    .replace(
      statementPattern(String.raw`import\s+([\w$]+)\s*,\s*\{([^}]+)\}\s+from\s+(['"])([^'"]+)\3\s*;?\s*$`),
      keepingLineBreaks((_match, defaultName: string, namedImports: string, _quote: string, specifier: string) => {
        const required = toRequireBinding(specifier);
        const moduleName = `__tracecode_esm_default_${defaultImportIndex++}`;
        return `const ${moduleName} = ${required}; const { ${transformNamedBindings(namedImports)} } = ${moduleName}; const ${defaultName} = ${moduleName} && typeof ${moduleName} === "object" && "default" in ${moduleName} ? ${moduleName}.default : ${moduleName};`;
      })
    )
    .replace(
      statementPattern(String.raw`import\s+\*\s+as\s+([\w$]+)\s+from\s+(['"])([^'"]+)\2\s*;?\s*$`),
      keepingLineBreaks((_match, namespaceName: string, _quote: string, specifier: string) =>
        `const ${namespaceName} = ${toRequireBinding(specifier)};`)
    )
    .replace(
      /\bimport\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2\s*;?/g,
      keepingLineBreaks((_match, namedImports: string, _quote: string, specifier: string) =>
        `const { ${transformNamedBindings(namedImports)} } = ${toRequireBinding(specifier)};`)
    )
    .replace(
      statementPattern(String.raw`import\s+([\w$]+)\s+from\s+(['"])([^'"]+)\2\s*;?\s*$`),
      keepingLineBreaks((_match, defaultName: string, _quote: string, specifier: string) =>
        defaultImportBinding(defaultName, specifier, defaultImportIndex++))
    )
    .replace(
      statementPattern(String.raw`import\s+(['"])([^'"]+)\1\s*;?\s*$`),
      keepingLineBreaks((_match, _quote: string, specifier: string) => `${toRequireBinding(specifier)};`)
    )
    .replace(
      statementPattern(String.raw`export\s+function\s+([\w$]+)\s*\(`),
      keepingLineBreaks((_match, name: string) => `exports.${name} = function ${name}(`)
    )
    .replace(
      statementPattern(String.raw`export\s+class\s+([\w$]+)\s*`),
      keepingLineBreaks((_match, name: string) => `exports.${name} = class ${name} `)
    )
    .replace(
      statementPattern(String.raw`export\s+(const|let|var)\s+([\w$]+)\s*=`),
      keepingLineBreaks((_match, declaration: string, name: string) => `${declaration} ${name} = exports.${name} =`)
    )
    .replace(
      statementPattern(String.raw`export\s+default\s+`),
      keepingLineBreaks(() => 'exports.default = ')
    )
    .replace(
      statementPattern(String.raw`export\s+\{([^}]+)\}\s*;?\s*$`),
      keepingLineBreaks((_match, namedExports: string) => namedExportAssignments(namedExports))
    );
}

export function resolveModulePath(
  modules: Map<string, string>,
  specifier: string,
  parentPath: string,
  nodePathSearchEntries: readonly string[] = [],
  condition: PackageResolutionCondition = 'require'
): string {
  const basePaths = specifier.startsWith('.')
    ? [joinModulePath(parentPath, specifier)]
    : [
        ...nodeModulesSearchPaths(parentPath, specifier),
        specifier,
        ...nodePathSearchEntries.map((entry) => entry ? `${entry}/${specifier}` : specifier),
      ];

  for (const basePath of basePaths) {
    for (const candidate of moduleCandidates(modules, basePath, condition)) {
      if (modules.has(candidate)) return candidate;
    }
  }

  throw new Error(`Cannot find module '${specifier}'`);
}

export function nodeModulesSearchPaths(parentPath: string, specifier: string): string[] {
  const parentDirectory = dirname(normalizeProjectPath(parentPath));
  const parts = parentDirectory ? parentDirectory.split('/').filter(Boolean) : [];
  const paths: string[] = [];

  for (let index = parts.length; index >= 0; index -= 1) {
    const directory = parts.slice(0, index).join('/');
    paths.push(directory ? `${directory}/node_modules/${specifier}` : `node_modules/${specifier}`);
  }

  return paths;
}

export function moduleSearchPaths(parentPath: string, workspaceRoot = '/workspace'): string[] {
  return nodeModulesSearchPaths(parentPath, '').map((path) => workspaceFilename(path.replace(/\/$/, ''), workspaceRoot));
}

export function formatConsoleValues(values: unknown[]): string {
  return values
    .map((value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.stack ?? value.message;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(' ');
}

export function formatBrowserJavaScriptErrorForStderr(error: unknown): string {
  if (error instanceof Error) {
    const text = typeof error.stack === 'string' && error.stack.trim()
      ? error.stack
      : error.message;
    return `${text.trimEnd()}\n`;
  }
  return `${String(error)}\n`;
}

export function isBrowserJavaScriptUserStackFrame(line: string, sourcePath: string): boolean {
  return (
    line.includes(sourcePath) ||
    line.includes('/workspace/')
  );
}

export function isBrowserJavaScriptInternalStackFrame(line: string): boolean {
  return (
    line.includes('/@fs/') ||
    line.includes('/packages/harness-') ||
    line.includes('/workers/javascript-project-worker.js') ||
    line.includes('javascript-project-worker.js:') ||
    line.includes('blob:') ||
    line.includes('runBrowserJavaScriptProjectRequest') ||
    line.includes('executeEntrypoint') ||
    line.includes('executeModule') ||
    line.includes('resolveModulePath') ||
    line.includes('requireModule') ||
    line.includes('createHttpApi') ||
    line.includes('registerHttpListener') ||
    line.includes('at new Function') ||
    line.includes('at new AsyncFunction')
  );
}

export function sanitizeBrowserJavaScriptStack(
  error: unknown,
  sourcePath: string,
  stackFrames?: WorkspaceStackFrames
): unknown {
  if (!(error instanceof Error) || typeof error.stack !== 'string' || !error.stack.trim()) {
    return error;
  }
  // The workspace formatter already built this stack from the error's own
  // frames, with each frame's file and line and nothing from the host.
  if (isWorkspaceFormattedStack(error)) return error;

  const stackLines = error.stack.split('\n');
  const lines: string[] = [stackLines[0] ?? error.message];
  for (const line of stackLines.slice(1)) {
    if (stackFrames ? stackFrames.isWorkspaceFrame(line) : isBrowserJavaScriptUserStackFrame(line, sourcePath)) {
      lines.push(line);
      continue;
    }
    if (isBrowserJavaScriptInternalStackFrame(line)) continue;
    // Browser engine frames and host URLs are implementation details. Keep
    // only frames that can be attributed to the submitted workspace.
  }
  if (lines.length === 1) lines.push(`    at ${sourcePath}:1:1`);
  Object.defineProperty(error, 'stack', {
    configurable: true,
    value: lines.join('\n'),
  });
  return error;
}

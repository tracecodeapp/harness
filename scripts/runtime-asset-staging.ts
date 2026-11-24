// What `tracecode-harness sync-assets` stages, shared by the CLI (which copies
// it and can print it with --inventory) and the runtime asset lock generator
// (which records its totals as `stagedInventory`). One plan, so the staged
// inventory a release operator uploads is the one the lock describes.

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { EngineRuntimePackageComponent } from './runtime-package-assets.mjs';

export type AssetLanguage = 'python' | 'javascript' | 'java' | 'csharp' | 'cpp';

export interface AssetCopyPlanEntry {
  readonly source: readonly string[];
  readonly target: readonly string[];
  readonly languages?: readonly AssetLanguage[];
}

export const ASSET_COPY_PLAN: readonly AssetCopyPlanEntry[] = [
  { source: ['THIRD_PARTY_NOTICES.md'], target: ['THIRD_PARTY_NOTICES.md'] },
  { source: ['workers', 'python', 'python-worker.js'], target: ['python-worker.js'], languages: ['python'] },
  {
    source: ['workers', 'python', 'generated-python-harness-snippets.js'],
    target: ['generated-python-harness-snippets.js'],
    languages: ['python'],
  },
  { source: ['workers', 'python', 'python-runtime.js'], target: ['python', 'python-runtime.js'], languages: ['python'] },
  { source: ['workers', 'python', 'pyodide-0.29.3'], target: ['python', 'pyodide-0.29.3'], languages: ['python'] },
  {
    // Native tracing hot path; the worker resolves it next to its own script
    // and falls back to the python tracer when absent.
    source: ['workers', 'python', 'tracecode_native-0.1.0-cp313-cp313-pyemscripten_2025_0_wasm32.whl'],
    target: ['tracecode_native-0.1.0-cp313-cp313-pyemscripten_2025_0_wasm32.whl'],
    languages: ['python'],
  },
  {
    source: ['workers', 'shared', 'runtime-kernel-policy-classic.js'],
    target: ['shared', 'runtime-kernel-policy-classic.js'],
    languages: ['python', 'javascript', 'java', 'csharp'],
  },
  {
    source: ['workers', 'shared', 'runtime-kernel-policy.js'],
    target: ['shared', 'runtime-kernel-policy.js'],
    languages: ['python', 'csharp', 'cpp'],
  },
  { source: ['workers', 'javascript', 'javascript-worker.js'], target: ['javascript-worker.js'], languages: ['javascript'] },
  {
    source: ['workers', 'javascript', 'javascript-ses-algorithm-worker.js'],
    target: ['javascript-ses-algorithm-worker.js'],
    languages: ['javascript'],
  },
  {
    source: ['workers', 'javascript', 'javascript-project-worker.js'],
    target: ['javascript-project-worker.js'],
    languages: ['javascript'],
  },
  { source: ['workers', 'java', 'java-worker.js'], target: ['java-worker.js'], languages: ['java'] },
  { source: ['workers', 'java', 'java-runtime-worker.js'], target: ['java-runtime-worker.js'], languages: ['java'] },
  {
    source: ['workers', 'java', 'java-source-augmentations.js'],
    target: ['java-source-augmentations.js'],
    languages: ['java'],
  },
  {
    source: ['workers', 'shared', 'tracekernel-syscall-client.js'],
    target: ['shared', 'tracekernel-syscall-client.js'],
    languages: ['java'],
  },
  {
    source: ['workers', 'shared', 'tracekernel-local-java-host.js'],
    target: ['shared', 'tracekernel-local-java-host.js'],
    languages: ['java'],
  },
  { source: ['workers', 'csharp', 'csharp-worker.js'], target: ['csharp-worker.js'], languages: ['csharp'] },
  { source: ['workers', 'cpp', 'cpp-worker.js'], target: ['cpp-worker.js'], languages: ['cpp'] },
  { source: ['workers', 'cpp', 'cpp-exceptions.js'], target: ['cpp-exceptions.js'], languages: ['cpp'] },
  // The C++ project worker is the same script under a second name.
  { source: ['workers', 'cpp', 'cpp-worker.js'], target: ['project-cpp-worker.js'], languages: ['cpp'] },
  { source: ['workers', 'cpp', 'tracecode_runtime.hpp'], target: ['cpp', 'tracecode_runtime.hpp'], languages: ['cpp'] },
  { source: ['workers', 'vendor', 'typescript.js'], target: ['vendor', 'typescript.js'], languages: ['javascript'] },
  {
    source: ['workers', 'vendor', 'javascript-libraries.js'],
    target: ['vendor', 'javascript-libraries.js'],
    languages: ['javascript'],
  },
  { source: ['workers', 'vendor', 'java-browser-helper.jar'], target: ['vendor', 'java-browser-helper.jar'], languages: ['java'] },
  { source: ['workers', 'vendor', 'csharp'], target: ['vendor', 'csharp'], languages: ['csharp'] },
  { source: ['workers', 'vendor', 'csharp-runner'], target: ['vendor', 'csharp-runner'], languages: ['csharp'] },
];

/**
 * Package paths the published tarball leaves out (package.json `files`). A
 * source checkout has them; the staged inventory describes the package.
 */
export const PACKAGE_PATH_EXCLUDES: readonly RegExp[] = [
  /^workers\/java\/(?:\.build|src)(?:\/|$)/u,
  /^workers\/javascript\/javascript-libraries-entry\.js$/u,
  /^workers\/vendor\/csharp-compiler(?:\/|$)/u,
  /^workers\/vendor\/csharp-role-artifacts(?:\/|$)/u,
  /^workers\/vendor\/(?:java-rewriter|javaparser-core-3\.25\.10|jdk\.compiler-17)\.jar$/u,
  /(?:^|\/)\.stamp$/u,
];

/**
 * - `locked`: a file the runtime asset lock lists (a packaged worker asset or
 *   an engine runtime file).
 * - `alias`: a second staged copy of a locked file under another name.
 * - `metadata`: staged but outside the locked runtime totals (notices,
 *   engine manifests and provenance, TraceJVM legal and source files).
 */
export type StagedFileClass = 'locked' | 'alias' | 'metadata';

export interface StagedFile {
  /** Path under the sync target directory. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly class: StagedFileClass;
  /** Package path the file is copied from (packaged assets). */
  readonly source?: string;
  /** Engine the file belongs to (engine runtime trees). */
  readonly engine?: 'tracecc' | 'tracejvm';
  /** For an alias: the staged path of the locked copy. */
  readonly aliasOf?: string;
}

export interface StagedTotals {
  readonly files: number;
  readonly bytes: number;
}

export interface StagedInventory {
  readonly languages: readonly AssetLanguage[];
  readonly files: readonly StagedFile[];
  readonly totals: StagedTotals & {
    readonly byClass: Readonly<Record<StagedFileClass, StagedTotals>>;
  };
}

export const ALL_ASSET_LANGUAGES: readonly AssetLanguage[] = ['python', 'javascript', 'java', 'csharp', 'cpp'];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portable(pathname: string): string {
  return pathname.split(sep).join('/');
}

export function selectsAsset(
  asset: AssetCopyPlanEntry,
  languages: ReadonlySet<AssetLanguage> | null
): boolean {
  return !languages || !asset.languages || asset.languages.some((language) => languages.has(language));
}

async function packageFiles(packageRoot: string, sourcePath: string): Promise<string[]> {
  const absolute = join(packageRoot, sourcePath);
  const identity = await lstat(absolute);
  if (identity.isFile()) return [sourcePath];
  if (!identity.isDirectory()) {
    throw new Error(`Staged runtime assets refuse links or special files: ${sourcePath}`);
  }
  const files: string[] = [];
  const entries = await readdir(absolute, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const child = portable(join(sourcePath, entry.name));
    if (PACKAGE_PATH_EXCLUDES.some((pattern) => pattern.test(child))) continue;
    files.push(...(await packageFiles(packageRoot, child)));
  }
  return files;
}

async function fileIdentity(pathname: string): Promise<{ size: number; sha256: string }> {
  const bytes = await readFile(pathname);
  return { size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function engineFileClass(engine: 'tracecc' | 'tracejvm', path: string, lockedTraceCC: ReadonlySet<string>): StagedFileClass {
  if (engine === 'tracecc') return lockedTraceCC.has(path) ? 'locked' : 'metadata';
  return path === 'release.json' || path.startsWith('legal/') || path.startsWith('source/') ? 'metadata' : 'locked';
}

/**
 * The files `sync-assets` stages for `languages` (all when null), computed
 * from the package and its engine runtime packages without copying anything.
 * `traceccLockedPaths` names the TraceCC files the lock lists (its runtime
 * manifest's assets); the rest of that tree is metadata.
 */
export async function computeStagedInventory(options: {
  readonly packageRoot: string;
  readonly engines: Readonly<{ tracejvm: EngineRuntimePackageComponent; tracecc: EngineRuntimePackageComponent }>;
  readonly traceccLockedPaths: ReadonlySet<string>;
  readonly languages?: ReadonlySet<AssetLanguage> | null;
}): Promise<StagedInventory> {
  const languages = options.languages ?? null;
  const staged = new Map<string, StagedFile>();
  const firstTargetBySource = new Map<string, string>();
  for (const asset of ASSET_COPY_PLAN) {
    if (!selectsAsset(asset, languages)) continue;
    const sourceRoot = asset.source.join('/');
    const targetRoot = asset.target.join('/');
    for (const source of await packageFiles(options.packageRoot, sourceRoot)) {
      const path = source === sourceRoot ? targetRoot : `${targetRoot}${source.slice(sourceRoot.length)}`;
      const existing = staged.get(path);
      if (existing) {
        if (existing.source !== source) {
          throw new Error(`Two package files stage to ${path}: ${existing.source} and ${source}.`);
        }
        continue;
      }
      const identity = await fileIdentity(join(options.packageRoot, source));
      const primary = firstTargetBySource.get(source);
      if (primary === undefined) firstTargetBySource.set(source, path);
      const locked = source.startsWith('workers/');
      staged.set(path, {
        path,
        ...identity,
        class: primary !== undefined ? 'alias' : locked ? 'locked' : 'metadata',
        source,
        ...(primary !== undefined ? { aliasOf: primary } : {}),
      });
    }
  }
  const engines: ['tracejvm' | 'tracecc', AssetLanguage][] = [['tracejvm', 'java'], ['tracecc', 'cpp']];
  for (const [engine, language] of engines) {
    if (languages && !languages.has(language)) continue;
    const component = options.engines[engine];
    for (const file of component.files) {
      const path = `${component.targetPath}/${file.path}`;
      if (staged.has(path)) throw new Error(`Engine file ${path} collides with a packaged asset.`);
      staged.set(path, {
        path,
        size: file.size,
        sha256: file.sha256,
        class: engineFileClass(engine, file.path, options.traceccLockedPaths),
        engine,
      });
    }
  }
  const files = [...staged.values()].sort((left, right) => compareText(left.path, right.path));
  const byClass: Record<StagedFileClass, { files: number; bytes: number }> = {
    locked: { files: 0, bytes: 0 },
    alias: { files: 0, bytes: 0 },
    metadata: { files: 0, bytes: 0 },
  };
  for (const file of files) {
    byClass[file.class].files += 1;
    byClass[file.class].bytes += file.size;
  }
  return {
    languages: languages ? ALL_ASSET_LANGUAGES.filter((language) => languages.has(language)) : ALL_ASSET_LANGUAGES,
    files,
    totals: {
      files: files.length,
      bytes: files.reduce((total, file) => total + file.size, 0),
      byClass,
    },
  };
}

/** Staged files grouped by their first path segment (engine trees by root). */
export function stagedPathGroups(files: readonly StagedFile[]): { path: string; files: number; bytes: number }[] {
  const groups = new Map<string, { files: number; bytes: number }>();
  for (const file of files) {
    const parts = file.path.split('/');
    const key = file.engine ? parts.slice(0, 2).join('/') : parts[0];
    const group = groups.get(key) ?? { files: 0, bytes: 0 };
    group.files += 1;
    group.bytes += file.size;
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([path, totals]) => ({ path, ...totals }));
}

/**
 * The lock's `stagedInventory`: the full-language totals, every alias by
 * name, and the totals per staged path group. The per-file listing comes from
 * `tracecode-harness sync-assets <dir> --inventory`.
 */
export function lockStagedInventory(inventory: StagedInventory) {
  return {
    description:
      'Files `tracecode-harness sync-assets <dir>` stages for every language. A consumer adds only its own files (such as a commit marker).',
    files: inventory.totals.files,
    bytes: inventory.totals.bytes,
    byClass: inventory.totals.byClass,
    aliases: inventory.files
      .filter((file) => file.class === 'alias')
      .map((file) => ({ path: file.path, aliasOf: file.aliasOf, source: file.source, size: file.size, sha256: file.sha256 })),
    groups: stagedPathGroups(inventory.files),
  };
}

export function relativeTargetPath(targetRoot: string, absolute: string): string {
  return portable(relative(targetRoot, absolute));
}

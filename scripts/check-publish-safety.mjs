#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT_PACKAGE_NAME = '@tracecode/harness';
const RETIRED_INTERNAL_PACKAGE_NAMES = new Set([
  '@tracecode/harness-browser',
  '@tracecode/harness-core',
  '@tracecode/harness-cpp',
  '@tracecode/harness-csharp',
  '@tracecode/harness-java',
  '@tracecode/harness-javascript',
  '@tracecode/harness-native',
  '@tracecode/harness-project',
  '@tracecode/harness-python',
]);
const RELEASE_CHECK_SCRIPT = 'node scripts/check-publish-safety.mjs';
const ROOT_RELEASE_SCRIPT =
  'pnpm release:check && pnpm publish . --access public';
const PREPUBLISH_SCRIPT =
  'pnpm release:check && pnpm test:runtime-assets-lock && pnpm build && pnpm release:check && pnpm test:runtime-assets-lock';
const WORKSPACE_SCOPE_ENVIRONMENT_KEYS = [
  'npm_config_filter',
  'npm_config_recursive',
  'npm_config_workspace',
  'npm_config_workspace_root',
  'npm_config_workspaces',
];

function fail(message) {
  throw new Error(`Publish safety check failed: ${message}`);
}

async function readJson(path, label) {
  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    fail(`unable to read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`invalid JSON in ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseWorkspacePatterns(source) {
  const lines = source.split(/\r?\n/u);
  const patterns = [];
  let packagesIndent = -1;
  let readingPackages = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!readingPackages) {
      const packagesMatch = line.match(/^(\s*)packages:\s*(?:#.*)?$/u);
      if (packagesMatch) {
        packagesIndent = packagesMatch[1].length;
        readingPackages = true;
      }
      continue;
    }

    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= packagesIndent) break;

    const itemMatch = line.match(/^\s*-\s*(.*?)\s*$/u);
    if (!itemMatch) {
      fail('pnpm-workspace.yaml packages must be a plain list of workspace directory patterns');
    }

    let pattern = itemMatch[1];
    if (
      (pattern.startsWith('"') && pattern.endsWith('"')) ||
      (pattern.startsWith("'") && pattern.endsWith("'"))
    ) {
      pattern = pattern.slice(1, -1);
    } else {
      pattern = pattern.replace(/\s+#.*$/u, '');
    }
    if (!pattern) fail('pnpm-workspace.yaml contains an empty workspace pattern');
    patterns.push(pattern);
  }

  if (!readingPackages || patterns.length === 0) {
    fail('pnpm-workspace.yaml must define at least one packages entry');
  }
  return patterns;
}

function assertInsideRoot(root, path, label) {
  const relativePath = relative(root, path);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    fail(`${label} escapes the workspace root: ${path}`);
  }
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function expandWorkspacePattern(root, pattern) {
  if (isAbsolute(pattern) || pattern.startsWith('!')) {
    fail(`unsupported workspace pattern ${JSON.stringify(pattern)}; publish auditing fails closed`);
  }

  const wildcardCount = [...pattern].filter((character) => character === '*').length;
  if (wildcardCount === 0) {
    const directory = resolve(root, pattern);
    assertInsideRoot(root, directory, 'workspace pattern');
    return (await fileExists(join(directory, 'package.json'))) ? [directory] : [];
  }

  const match = pattern.match(/^(.+)\/\*$/u);
  if (!match || wildcardCount !== 1) {
    fail(`unsupported workspace pattern ${JSON.stringify(pattern)}; only explicit paths and trailing /* are allowed`);
  }

  const parent = resolve(root, match[1]);
  assertInsideRoot(root, parent, 'workspace pattern');
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    fail(`unable to enumerate workspace pattern ${JSON.stringify(pattern)}: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }

  const directories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(parent, entry.name);
    if (await fileExists(join(directory, 'package.json'))) directories.push(directory);
  }
  return directories;
}

function npmrcValue(source, key) {
  const values = new Map();
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    values.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim());
  }
  return values.get(key);
}

function enabledConfigValue(value) {
  if (value === undefined) return false;
  return !['', '0', 'false', 'null', 'undefined'].includes(String(value).trim().toLowerCase());
}

function configuredCommandArguments(serializedArguments) {
  if (!serializedArguments) return [];
  try {
    const parsed = JSON.parse(serializedArguments);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (parsed && typeof parsed === 'object') {
      for (const key of ['original', 'cooked', 'remain']) {
        if (Array.isArray(parsed[key])) return parsed[key].map(String);
      }
    }
  } catch {
    // Newer package managers may expose a plain command string instead.
  }
  return serializedArguments.trim().split(/\s+/u).filter(Boolean);
}

function assertRootOnlyInvocation(environment) {
  const scopedKey = WORKSPACE_SCOPE_ENVIRONMENT_KEYS.find((key) =>
    enabledConfigValue(environment[key])
  );
  if (scopedKey) {
    fail(`workspace-scoped publication is forbidden (${scopedKey}=${JSON.stringify(environment[scopedKey])})`);
  }

  const scopedArgument = configuredCommandArguments(environment.npm_config_argv).find(
    (argument) =>
      [
        '-r',
        '-w',
        '--recursive',
        '--workspace',
        '--workspace-root',
        '--workspaces',
        '--filter',
      ].includes(argument) ||
      argument.startsWith('--filter=') ||
      argument.startsWith('--workspace=')
  );
  if (scopedArgument) {
    fail(`workspace-scoped publication is forbidden (${scopedArgument})`);
  }
}

function assertRootReleaseConfiguration(rootManifest, npmrcSource) {
  if (rootManifest.name !== ROOT_PACKAGE_NAME) {
    fail(`workspace root must be ${ROOT_PACKAGE_NAME}, found ${JSON.stringify(rootManifest.name)}`);
  }
  if (rootManifest.private === true) {
    fail(`${ROOT_PACKAGE_NAME} must remain publishable`);
  }
  if (typeof rootManifest.version !== 'string' || rootManifest.version.length === 0) {
    fail(`${ROOT_PACKAGE_NAME} must declare a release version`);
  }
  if (rootManifest.publishConfig?.access !== 'public') {
    fail(`${ROOT_PACKAGE_NAME} publishConfig.access must be "public"`);
  }
  if (rootManifest.scripts?.['release:check'] !== RELEASE_CHECK_SCRIPT) {
    fail(`release:check must be ${JSON.stringify(RELEASE_CHECK_SCRIPT)}`);
  }
  if (rootManifest.scripts?.['release:root'] !== ROOT_RELEASE_SCRIPT) {
    fail(`release:root must publish only the workspace root via ${JSON.stringify(ROOT_RELEASE_SCRIPT)}`);
  }
  if (rootManifest.scripts?.prepublishOnly !== PREPUBLISH_SCRIPT) {
    fail(`prepublishOnly must audit before and after the build via ${JSON.stringify(PREPUBLISH_SCRIPT)}`);
  }
  if (npmrcValue(npmrcSource, 'include-workspace-root') !== 'false') {
    fail('.npmrc must set include-workspace-root=false so ordinary recursive commands exclude the root release');
  }
}

export async function auditPublishSafety(rootDirectory = process.cwd(), environment = process.env) {
  const root = resolve(rootDirectory);
  assertRootOnlyInvocation(environment);
  const rootManifest = await readJson(join(root, 'package.json'), 'root package manifest');
  const workspaceSource = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const npmrcSource = await readFile(join(root, '.npmrc'), 'utf8');
  assertRootReleaseConfiguration(rootManifest, npmrcSource);

  const workspacePatterns = parseWorkspacePatterns(workspaceSource);
  const workspaceDirectories = new Set();
  for (const pattern of workspacePatterns) {
    const matches = await expandWorkspacePattern(root, pattern);
    if (matches.length === 0) {
      fail(`workspace pattern ${JSON.stringify(pattern)} does not contain a package manifest`);
    }
    for (const directory of matches) workspaceDirectories.add(directory);
  }

  const names = new Map([[rootManifest.name, 'package.json']]);
  const internalPackages = [];
  for (const directory of [...workspaceDirectories].sort()) {
    const manifestPath = join(directory, 'package.json');
    const relativeManifestPath = relative(root, manifestPath);
    const manifest = await readJson(manifestPath, `workspace package manifest ${relativeManifestPath}`);
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
      fail(`${relativeManifestPath} must declare a package name`);
    }
    if (RETIRED_INTERNAL_PACKAGE_NAMES.has(manifest.name)) {
      fail(
        `${relativeManifestPath} (${manifest.name}) uses a retired harness-* ` +
        'workspace namespace; private implementation packages must use ownership-based names'
      );
    }
    const existingPath = names.get(manifest.name);
    if (existingPath) {
      fail(`duplicate workspace package name ${manifest.name} in ${existingPath} and ${relativeManifestPath}`);
    }
    names.set(manifest.name, relativeManifestPath);
    if (manifest.private !== true) {
      fail(`${relativeManifestPath} (${manifest.name}) must set "private": true`);
    }
    if (
      relativeManifestPath.startsWith(`packages${sep}`) &&
      manifest.version !== rootManifest.version
    ) {
      fail(
        `${relativeManifestPath} (${manifest.name}) version must match ` +
        `${ROOT_PACKAGE_NAME} ${rootManifest.version}, found ${JSON.stringify(manifest.version)}`
      );
    }
    internalPackages.push({
      name: manifest.name,
      manifestPath: relativeManifestPath,
    });
  }

  if (internalPackages.length === 0) {
    fail('workspace package inventory is empty');
  }

  return {
    rootPackage: ROOT_PACKAGE_NAME,
    internalPackages,
  };
}

function parseRootArgument(argv) {
  if (argv.length === 0) return process.cwd();
  if (argv.length === 2 && argv[0] === '--root') return argv[1];
  fail(`usage: node scripts/check-publish-safety.mjs [--root <workspace>]`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    const result = await auditPublishSafety(parseRootArgument(process.argv.slice(2)));
    console.log(
      `PASS: ${result.rootPackage} is the only publishable workspace manifest; ` +
      `${result.internalPackages.length} internal manifests are private.`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

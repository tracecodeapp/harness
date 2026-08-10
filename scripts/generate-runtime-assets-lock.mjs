#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeCSharpRoleAssets } from './csharp-role-artifacts.ts';
import { loadEngineRuntimePackages } from './runtime-package-assets.mjs';

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_ROOT, '..');
const LOCK_PATH = join(ROOT, 'runtime-assets.lock.json');
const PYTHON_GENERATED_PATH = join(
  ROOT,
  'packages/runtime-python/src/python-runtime-assets.generated.ts'
);
const TRACECC_GENERATED_PATH = join(
  ROOT,
  'packages/runtime-cpp/src/tracecc-runtime-assets.generated.ts'
);
const TRACEJVM_GENERATED_PATH = join(
  ROOT,
  'packages/runtime-java/src/tracejvm-runtime-assets.generated.ts'
);
const LOCK_SCHEMA = 'tracecode.runtime-assets-lock.v1';
const TREE_ALGORITHM = 'sha256-path-nul-bytes-nul-v1';

const ROOT_PACKAGE_EXCLUDES = [
  /^workers\/java\/(?:\.build|src)(?:\/|$)/u,
  /^workers\/javascript\/javascript-libraries-entry\.js$/u,
  /^workers\/vendor\/csharp-compiler(?:\/|$)/u,
  /^workers\/vendor\/csharp-role-artifacts(?:\/|$)/u,
  /^workers\/vendor\/(?:java-rewriter|javaparser-core-3\.25\.10|jdk\.compiler-17)\.jar$/u,
  /(?:^|\/)\.stamp$/u,
];

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portablePath(pathname) {
  return pathname.split(sep).join('/');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function integrityForSha256(digest) {
  return `sha256-${Buffer.from(digest, 'hex').toString('base64')}`;
}

function sha256FromIntegrity(integrity) {
  const match = /^sha256-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity ?? '');
  if (!match) throw new Error(`Invalid SHA-256 integrity value: ${String(integrity)}`);
  return Buffer.from(match[1], 'base64').toString('hex');
}

function mediaTypeFor(pathname) {
  const lower = pathname.toLowerCase();
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'text/javascript';
  if (lower.endsWith('.json') || lower.endsWith('.map')) return 'application/json';
  if (lower.endsWith('.wasm')) return 'application/wasm';
  if (lower.endsWith('.html')) return 'text/html';
  if (lower.endsWith('.hpp') || lower.endsWith('.h') || lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.tar')) return 'application/x-tar';
  if (lower.endsWith('.zip') || lower.endsWith('.jar') || lower.endsWith('.whl')) return 'application/zip';
  return 'application/octet-stream';
}

function componentFor(pathname) {
  if (pathname.startsWith('workers/python/')) return 'python';
  if (pathname.startsWith('workers/javascript/')) return 'javascript';
  if (pathname === 'workers/vendor/typescript.js') return 'typescript';
  if (pathname === 'workers/vendor/javascript-libraries.js') return 'javascript';
  if (pathname.startsWith('workers/java/') || pathname === 'workers/vendor/java-browser-helper.jar') return 'java';
  if (pathname.startsWith('workers/csharp/') || pathname.startsWith('workers/vendor/csharp')) return 'csharp';
  if (pathname.startsWith('workers/cpp/')) return 'cpp';
  if (pathname.startsWith('workers/shared/')) return 'shared';
  throw new Error(`Published worker asset is not assigned to a runtime component: ${pathname}`);
}

async function collectFiles(root, prefix = '') {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const pathname = join(directory, entry.name);
      const relativePath = portablePath(relative(ROOT, pathname));
      if (ROOT_PACKAGE_EXCLUDES.some((pattern) => pattern.test(relativePath))) continue;
      if (entry.isDirectory()) {
        await visit(pathname);
      } else if (entry.isFile()) {
        if (prefix && !relativePath.startsWith(prefix)) continue;
        const bytes = await readFile(pathname);
        const digest = sha256(bytes);
        files.push({
          path: relativePath,
          size: bytes.byteLength,
          sha256: digest,
          integrity: integrityForSha256(digest),
          mediaType: mediaTypeFor(relativePath),
          _bytes: bytes,
        });
      } else {
        throw new Error(`Runtime asset lock refuses links or special files: ${relativePath}`);
      }
    }
  }
  await visit(root);
  files.sort((left, right) => compareText(left.path, right.path));
  return files;
}

function treeSha256(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path, 'utf8');
    hash.update('\0');
    hash.update(file._bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function publicFile(file) {
  const { _bytes: ignored, ...identity } = file;
  return identity;
}

async function readJson(pathname) {
  return JSON.parse(await readFile(pathname, 'utf8'));
}

async function readExistingLock() {
  try {
    return await readJson(LOCK_PATH);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function buildPackagedComponents() {
  const files = await collectFiles(join(ROOT, 'workers'), 'workers/');
  const grouped = new Map();
  for (const file of files) {
    const component = componentFor(file.path);
    const entries = grouped.get(component) ?? [];
    entries.push(file);
    grouped.set(component, entries);
  }
  const components = {};
  for (const component of [...grouped.keys()].sort(compareText)) {
    const entries = grouped.get(component);
    const digest = treeSha256(entries);
    components[component] = {
      releaseId: `${component}+sha256.${digest}`,
      treeSha256: digest,
      totalBytes: entries.reduce((total, file) => total + file.size, 0),
      files: entries.map(publicFile),
    };
  }
  return { files, components };
}

function findPythonRuntime(components) {
  const python = components.python;
  const directories = new Set();
  for (const file of python.files) {
    const match = /^workers\/python\/(pyodide-\d+\.\d+\.\d+)\//u.exec(file.path);
    if (match) directories.add(match[1]);
  }
  if (directories.size !== 1) {
    throw new Error(
      `Runtime asset lock requires exactly one Pyodide runtime directory; found ${JSON.stringify([...directories])}.`
    );
  }
  const runtimeDirectory = [...directories][0];
  const required = [
    'pyodide.js',
    'pyodide.asm.js',
    'pyodide.asm.wasm',
    'pyodide-lock.json',
    'python_stdlib.zip',
    'snapshots/chromium.bin',
    'snapshots/firefox.bin',
    'snapshots/webkit.bin',
  ];
  const byPath = new Map(python.files.map((file) => [file.path, file]));
  for (const relativePath of required) {
    const path = `workers/python/${runtimeDirectory}/${relativePath}`;
    if (!byPath.has(path)) throw new Error(`Python runtime lock is missing required asset ${path}.`);
  }
  return { runtimeDirectory, byPath };
}

async function assertPythonNativeManifest(python) {
  const manifest = await readJson(join(ROOT, 'packages/runtime-python-native/manifest.json'));
  const wheel = python.byPath.get(manifest.vendoredWheel?.path);
  if (!wheel) {
    throw new Error(`Python native manifest references an unpackaged wheel: ${String(manifest.vendoredWheel?.path)}`);
  }
  if (wheel.sha256 !== manifest.vendoredWheel.sha256) {
    throw new Error(
      `Python native wheel mismatch for ${wheel.path}: expected ${manifest.vendoredWheel.sha256}, received ${wheel.sha256}.`
    );
  }
  const version = python.runtimeDirectory.slice('pyodide-'.length);
  if (manifest.target?.pyodide !== version) {
    throw new Error(
      `Python native target mismatch: runtime is Pyodide ${version}, native manifest targets ${String(manifest.target?.pyodide)}.`
    );
  }
  return {
    schema: manifest.schemaVersion,
    module: manifest.module,
    target: manifest.target,
    wheel: publicFile(wheel),
    required: false,
  };
}

function traceccDescriptors(manifest) {
  const assets = manifest.assets ?? {};
  const named = [
    ['runtimeHeader', assets.runtimeHeader],
    ['compilerWasm', assets.compilerWasm],
    ['sysroot', assets.sysroot],
    ...Object.entries(assets.compilerResources ?? {}),
  ];
  return named.map(([role, descriptor]) => {
    if (!descriptor?.url || !descriptor.integrity || !Number.isSafeInteger(descriptor.size)) {
      throw new Error(`TraceCC manifest has an incomplete ${role} descriptor.`);
    }
    return {
      role,
      path: descriptor.url,
      size: descriptor.size,
      sha256: sha256FromIntegrity(descriptor.integrity),
      integrity: descriptor.integrity,
      mediaType: descriptor.mediaType ?? mediaTypeFor(descriptor.url),
    };
  });
}

async function findTraceCCManifest(traceccPackage) {
  const configured = process.env.TRACECC_ASSET_MANIFEST;
  if (configured) return resolve(configured);
  return join(traceccPackage.sourceRoot, 'cpp-runtime-manifest.json');
}

async function buildTraceCC(traceccPackage, cppComponent) {
  const manifestPath = await findTraceCCManifest(traceccPackage);
  const manifest = await readJson(manifestPath);
  const match = /\/([0-9a-f]{64})\/$/u.exec(manifest.assetBaseUrl ?? '');
  if (!match) throw new Error('TraceCC manifest assetBaseUrl must end in its 64-character consumer hash.');
  const consumerHash = match[1];
  const files = traceccDescriptors(manifest);
  const header = files.find((file) => file.role === 'runtimeHeader');
  const packagedHeader = cppComponent.files.find(
    (file) => file.path === 'workers/cpp/tracecode_runtime.hpp'
  );
  if (!header || !packagedHeader || header.sha256 !== packagedHeader.sha256) {
    throw new Error(
      `TraceCC runtime header mismatch: prepared ${header?.sha256 ?? 'missing'}, packaged ${packagedHeader?.sha256 ?? 'missing'}. ` +
        'Rebuild the TraceCC PCH/object shards and run prepare:tracecc-assets before generating the release lock.'
    );
  }
  const assetRoot = dirname(manifestPath);
  for (const file of files) {
    const bytes = await readFile(join(assetRoot, file.path));
    const actual = sha256(bytes);
    if (bytes.byteLength !== file.size || actual !== file.sha256) {
      throw new Error(
        `TraceCC package asset mismatch for ${file.path}: expected ${file.size} bytes/${file.sha256}, ` +
          `received ${bytes.byteLength} bytes/${actual}.`
      );
    }
  }
  const provenance = await readJson(
    join(dirname(manifestPath), 'tracecc-consumer-lock.json')
  );
  if (provenance) {
    if (
      provenance.schema !== 'tracecode.tracecc-consumer-lock.v1' ||
      provenance.consumerHash !== consumerHash
    ) {
      throw new Error(
        `TraceCC consumer provenance mismatch: expected ${consumerHash}, received ${String(provenance.consumerHash)}.`
      );
    }
    const provenanceFiles = new Map(
      (provenance.files ?? []).map((file) => [file.path, file])
    );
    for (const file of files) {
      const recorded = provenanceFiles.get(file.path);
      if (
        !recorded ||
        recorded.size !== file.size ||
        recorded.sha256 !== file.sha256
      ) {
        throw new Error(`TraceCC consumer provenance is stale for ${file.path}.`);
      }
    }
  }
  return {
    releaseId: traceccPackage.releaseId,
    package: traceccPackage.package,
    consumerHash,
    treeSha256Algorithm: 'tracecc-consumer-sha256-v1',
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    files,
  };
}

async function findTraceJVMRelease(tracejvmPackage) {
  const configured = process.env.TRACECODE_TRACEJVM_RELEASE;
  if (configured) return resolve(configured);
  return join(tracejvmPackage.sourceRoot, 'release.json');
}

async function buildTraceJVM(tracejvmPackage) {
  const runtimeJavaPackage = await readJson(join(ROOT, 'packages/runtime-java/package.json'));
  const clientVersion = runtimeJavaPackage.dependencies?.['@tracecode/tracejvm'];
  if (!/^\d+\.\d+\.\d+$/u.test(clientVersion ?? '')) {
    throw new Error('@tracecode/runtime-java must pin an exact @tracecode/tracejvm version.');
  }
  if (clientVersion !== tracejvmPackage.package.version) {
    throw new Error(
      `@tracecode/runtime-java requires TraceJVM ${clientVersion}, but Harness resolved ${tracejvmPackage.package.version}.`
    );
  }
  const releasePath = await findTraceJVMRelease(tracejvmPackage);
  const releaseBytes = await readFile(releasePath);
  const release = JSON.parse(releaseBytes.toString('utf8'));
  const version = release.package?.version;
  if (
    release.schema !== 'tracejvm-runtime-release-v2' ||
    release.package?.name !== '@tracecode/tracejvm' ||
    !/^\d+\.\d+\.\d+$/u.test(version ?? '') ||
    !/^[0-9a-f]{64}$/u.test(release.contentHash ?? '') ||
    release.relativePrefix !== `tracejvm/${version}/${release.contentHash}`
  ) {
    throw new Error(
      `TraceJVM release identity mismatch: @tracecode/runtime-java requires ${clientVersion}, descriptor reports ` +
        `${String(release.package?.version)} at ${String(release.relativePrefix)}.`
    );
  }
  return {
    releaseId: tracejvmPackage.releaseId,
    package: tracejvmPackage.package,
    contentHash: release.contentHash,
    relativePrefix: release.relativePrefix,
    descriptorSha256: sha256(releaseBytes),
    descriptorSize: releaseBytes.byteLength,
    totalBytes: release.files
      .filter((file) => !file.path.startsWith('legal/') && !file.path.startsWith('source/'))
      .reduce((total, file) => total + file.size, 0),
  };
}

function renderPythonGenerated(python) {
  const wasm = python.byPath.get(
    `workers/python/${python.runtimeDirectory}/pyodide.asm.wasm`
  );
  const snapshots = Object.fromEntries(
    ['chromium', 'firefox', 'webkit'].map((engine) => [
      engine,
      python.byPath.get(
        `workers/python/${python.runtimeDirectory}/snapshots/${engine}.bin`
      ),
    ])
  );
  return `// Generated by scripts/generate-runtime-assets-lock.mjs. Do not edit.\n` +
    `export const PYTHON_RUNTIME_DIRECTORY = ${JSON.stringify(`python/${python.runtimeDirectory}`)};\n` +
    `export const PYTHON_RUNTIME_WASM = Object.freeze(${JSON.stringify({ integrity: wasm.integrity, size: wasm.size }, null, 2)} as const);\n` +
    `export const PYTHON_RUNTIME_SNAPSHOTS = Object.freeze(${JSON.stringify(
      Object.fromEntries(Object.entries(snapshots).map(([engine, file]) => [engine, { integrity: file.integrity, size: file.size }])),
      null,
      2
    )} as const);\n`;
}

function renderTraceCCGenerated(tracecc) {
  const roleNames = {
    runtimeHeader: 'runtimeHeader',
    compilerWasm: 'compilerWasm',
    sysroot: 'sysroot',
    'tracecc-narrow-pch': 'narrowPch',
    'tracecc-narrow-pch-source': 'narrowPchSource',
    'tracecc-narrow-runtime-object': 'narrowRuntimeObject',
    'tracecc-broad-pch': 'broadPch',
    'tracecc-broad-pch-source': 'broadPchSource',
    'tracecc-broad-runtime-object': 'broadRuntimeObject',
    'tracecc-map-pch': 'mapPch',
    'tracecc-map-pch-source': 'mapPchSource',
    'tracecc-map-runtime-object': 'mapRuntimeObject',
  };
  const assets = {};
  for (const file of tracecc.files) {
    const key = roleNames[file.role];
    if (!key) throw new Error(`TraceCC generated module does not recognize role ${file.role}.`);
    assets[key] = {
      fileName: file.path,
      integrity: file.integrity,
      mediaType: file.mediaType,
      size: file.size,
    };
  }
  return `// Generated by scripts/generate-runtime-assets-lock.mjs. Do not edit.\n` +
    `export const TRACECC_RUNTIME_CONTENT_HASH = ${JSON.stringify(tracecc.consumerHash)};\n` +
    `export const TRACECC_RUNTIME_ASSETS = Object.freeze(${JSON.stringify(assets, null, 2)} as const);\n`;
}

function renderTraceJVMGenerated(tracejvm) {
  return `// Generated by scripts/generate-runtime-assets-lock.mjs. Do not edit.\n` +
    `export const TRACEJVM_RUNTIME_VERSION = ${JSON.stringify(tracejvm.package.version)};\n` +
    `export const TRACEJVM_RUNTIME_CONTENT_HASH = ${JSON.stringify(tracejvm.contentHash)};\n` +
    `export const TRACEJVM_RUNTIME_ASSET_RELATIVE_PATH = ${JSON.stringify(`java/${tracejvm.relativePrefix}`)};\n` +
    `export const TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR = Object.freeze(${JSON.stringify({
      integrity: integrityForSha256(tracejvm.descriptorSha256),
      size: tracejvm.descriptorSize,
    }, null, 2)} as const);\n`;
}

async function buildLock() {
  // The canonical C# release artifacts are compressed, tracked inputs. Always
  // expand and verify them here so a clean checkout cannot produce (or accept)
  // a lock that silently omits the C# runtime trees.
  await materializeCSharpRoleAssets(ROOT);
  const packageJson = await readJson(join(ROOT, 'package.json'));
  const engines = await loadEngineRuntimePackages(ROOT);
  const packaged = await buildPackagedComponents();
  const packageTreeSha256 = treeSha256(packaged.files);
  const python = findPythonRuntime(packaged.components);
  const pythonNative = await assertPythonNativeManifest(python);
  const tracecc = await buildTraceCC(engines.tracecc, packaged.components.cpp);
  const tracejvm = await buildTraceJVM(engines.tracejvm);
  const csharp = await readJson(join(ROOT, 'workers/vendor/csharp-role-artifacts/manifest.json'));
  const general = csharp.roles?.general;
  const compiler = csharp.roles?.compiler;
  const aliasedFields = [
    'artifact',
    'artifactBytes',
    'artifactSha256',
    'fileCount',
    'treeSha256',
    'uncompressedBytes',
  ];
  if (
    csharp.deployment?.compilerSharesGeneralAssets !== true ||
    csharp.deployment?.browserAssets?.general?.packagePath !== 'workers/vendor/csharp' ||
    csharp.deployment?.browserAssets?.general?.targetPath !== 'vendor/csharp' ||
    csharp.deployment?.browserAssets?.compiler?.packagePath !== 'workers/vendor/csharp' ||
    csharp.deployment?.browserAssets?.compiler?.targetPath !== 'vendor/csharp' ||
    csharp.deployment?.browserAssets?.runner?.packagePath !== 'workers/vendor/csharp-runner' ||
    csharp.deployment?.browserAssets?.runner?.targetPath !== 'vendor/csharp-runner' ||
    aliasedFields.some((field) => general?.[field] !== compiler?.[field])
  ) {
    throw new Error(
      'C# compiler asset alias is invalid: general and compiler must be byte-identical and map to vendor/csharp. ' +
        'Publish a distinct compiler asset path before allowing the role trees to diverge.'
    );
  }
  const lock = {
    schema: LOCK_SCHEMA,
    harness: {
      name: packageJson.name,
      version: packageJson.version,
      releaseId: `${packageJson.name}@${packageJson.version}+sha256.${packageTreeSha256}`,
    },
    treeSha256Algorithm: TREE_ALGORITHM,
    packageTreeSha256,
    totalPackagedRuntimeBytes: packaged.files.reduce((total, file) => total + file.size, 0),
    components: packaged.components,
    compatibility: {
      python: {
        runtimeDirectory: python.runtimeDirectory,
        native: pythonNative,
      },
      csharp,
    },
    engineDependencies: { tracecc, tracejvm },
  };
  return {
    lock,
    rendered: `${JSON.stringify(lock, null, 2)}\n`,
    pythonGenerated: renderPythonGenerated(python),
    traceccGenerated: renderTraceCCGenerated(tracecc),
    tracejvmGenerated: renderTraceJVMGenerated(tracejvm),
  };
}

async function assertCurrent(pathname, expected, label) {
  let actual;
  try {
    actual = await readFile(pathname, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') actual = '';
    else throw error;
  }
  if (actual !== expected) {
    throw new Error(
      `${label} is stale: ${portablePath(relative(ROOT, pathname))}. ` +
        'Run: pnpm generate:runtime-assets-lock'
    );
  }
}

async function main() {
  const check = process.argv.slice(2).includes('--check');
  const unknown = process.argv.slice(2).filter((argument) => argument !== '--check');
  if (unknown.length > 0) {
    throw new Error('Usage: node scripts/generate-runtime-assets-lock.mjs [--check]');
  }
  const output = await buildLock();
  if (check) {
    await assertCurrent(LOCK_PATH, output.rendered, 'Runtime asset lock');
    await assertCurrent(PYTHON_GENERATED_PATH, output.pythonGenerated, 'Python runtime metadata');
    await assertCurrent(TRACECC_GENERATED_PATH, output.traceccGenerated, 'TraceCC runtime metadata');
    await assertCurrent(TRACEJVM_GENERATED_PATH, output.tracejvmGenerated, 'TraceJVM runtime metadata');
    console.log(
      `PASS: ${output.lock.harness.releaseId} locks ${output.lock.totalPackagedRuntimeBytes} packaged runtime bytes.`
    );
    return;
  }
  await writeFile(LOCK_PATH, output.rendered);
  await writeFile(PYTHON_GENERATED_PATH, output.pythonGenerated);
  await writeFile(TRACECC_GENERATED_PATH, output.traceccGenerated);
  await writeFile(TRACEJVM_GENERATED_PATH, output.tracejvmGenerated);
  console.log(
    `Generated ${output.lock.harness.releaseId} with ${output.lock.totalPackagedRuntimeBytes} packaged runtime bytes.`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

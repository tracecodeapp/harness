import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const COMPONENTS = Object.freeze({
  tracejvm: {
    packageName: '@tracecode/tracejvm',
    rootEnvironment: 'TRACECODE_TRACEJVM_PACKAGE_ROOT',
    schema: 'tracejvm-package-runtime-v1',
    sourceRoot(manifest, packageRoot) {
      return join(
        packageRoot,
        'runtime-release',
        manifest.package.version,
        manifest.contentHash
      );
    },
    expectedTargetPath(manifest) {
      return `java/tracejvm/${manifest.package.version}/${manifest.contentHash}`;
    },
    expectedReleaseId(manifest) {
      return `tracejvm@${manifest.package.version}+sha256.${manifest.contentHash}`;
    },
    contentHash(manifest) {
      return manifest.contentHash;
    },
  },
  tracecc: {
    packageName: '@tracecode/tracecc',
    rootEnvironment: 'TRACECODE_TRACECC_PACKAGE_ROOT',
    schema: 'tracecc-package-runtime-v1',
    sourceRoot(manifest, packageRoot) {
      return join(packageRoot, 'runtime-release', manifest.consumerHash);
    },
    expectedTargetPath(manifest) {
      return `cpp/tracecc/${manifest.consumerHash}`;
    },
    expectedReleaseId(manifest) {
      return `tracecc@${manifest.package.version}+sha256.${manifest.consumerHash}`;
    },
    contentHash(manifest) {
      return manifest.consumerHash;
    },
  },
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSafeRelativePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

async function listFiles(directory, base = directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const identity = await lstat(absolute);
    if (identity.isSymbolicLink()) {
      throw new Error(`Runtime package assets cannot contain symlinks: ${absolute}`);
    }
    if (identity.isDirectory()) {
      files.push(...(await listFiles(absolute, base)));
    } else if (identity.isFile()) {
      files.push({
        absolute,
        path: relative(base, absolute).split(sep).join('/'),
      });
    } else {
      throw new Error(`Runtime package assets cannot contain special files: ${absolute}`);
    }
  }
  return files.sort((left, right) => compareText(left.path, right.path));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function resolvePackageRoot(harnessRoot, definition) {
  const configured = process.env[definition.rootEnvironment];
  if (configured) return resolve(configured);
  const require = createRequire(
    pathToFileURL(join(harnessRoot, 'package.json'))
  );
  return dirname(require.resolve(`${definition.packageName}/package.json`));
}

async function loadComponent(harnessRoot, componentName, expectedVersion) {
  const definition = COMPONENTS[componentName];
  const packageRoot = await resolvePackageRoot(harnessRoot, definition);
  const packageJson = await readJson(join(packageRoot, 'package.json'));
  const manifest = await readJson(join(packageRoot, 'runtime-release', 'manifest.json'));
  if (
    packageJson.name !== definition.packageName ||
    packageJson.version !== expectedVersion ||
    manifest.schema !== definition.schema ||
    manifest.package?.name !== definition.packageName ||
    manifest.package?.version !== expectedVersion ||
    !/^[0-9a-f]{64}$/u.test(definition.contentHash(manifest) ?? '') ||
    manifest.releaseId !== definition.expectedReleaseId(manifest) ||
    manifest.targetPath !== definition.expectedTargetPath(manifest) ||
    !isSafeRelativePath(manifest.targetPath) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.some((file) => !isSafeRelativePath(file?.path))
  ) {
    throw new Error(
      `${definition.packageName} runtime package mismatch: Harness requires ${expectedVersion}, ` +
        `resolved package ${String(packageJson.version)} with manifest ${String(manifest.package?.version)}.`
    );
  }
  const sourceRoot = definition.sourceRoot(manifest, packageRoot);
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const files = [];
  for (const file of await listFiles(sourceRoot)) {
    const declared = expected.get(file.path);
    const bytes = await readFile(file.absolute);
    const digest = sha256(bytes);
    if (
      !declared ||
      declared.size !== bytes.byteLength ||
      declared.sha256 !== digest
    ) {
      throw new Error(
        `${definition.packageName} runtime asset mismatch for ${file.path}: expected ` +
          `${String(declared?.size)}/${String(declared?.sha256)}, received ` +
          `${bytes.byteLength}/${digest}.`
      );
    }
    expected.delete(file.path);
    files.push({ ...declared, absolute: file.absolute });
  }
  if (expected.size > 0) {
    throw new Error(
      `${definition.packageName} runtime package is missing: ${[...expected.keys()].join(', ')}.`
    );
  }
  return Object.freeze({
    component: componentName,
    packageRoot,
    package: Object.freeze({ name: packageJson.name, version: packageJson.version }),
    manifest: Object.freeze(manifest),
    releaseId: manifest.releaseId,
    sourceRoot,
    targetPath: manifest.targetPath,
    files: Object.freeze(files),
  });
}

export async function loadEngineRuntimePackages(harnessRoot = resolve(process.cwd())) {
  const packageJson = await readJson(join(harnessRoot, 'package.json'));
  const versions = {
    tracejvm: packageJson.dependencies?.['@tracecode/tracejvm'],
    tracecc: packageJson.dependencies?.['@tracecode/tracecc'],
  };
  for (const [component, version] of Object.entries(versions)) {
    if (!/^\d+\.\d+\.\d+$/u.test(version ?? '')) {
      throw new Error(
        `Harness must pin an exact ${COMPONENTS[component].packageName} version.`
      );
    }
  }
  const [tracejvm, tracecc] = await Promise.all([
    loadComponent(harnessRoot, 'tracejvm', versions.tracejvm),
    loadComponent(harnessRoot, 'tracecc', versions.tracecc),
  ]);
  return Object.freeze({ tracejvm, tracecc });
}

export async function installEngineRuntimePackage(component, targetRoot) {
  const target = join(targetRoot, ...component.targetPath.split('/'));
  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(
    join(dirname(target), `.${component.component}-runtime-staging-`)
  );
  const backup = `${target}.backup-${process.pid}-${Date.now()}`;
  let movedPrevious = false;
  try {
    await cp(component.sourceRoot, staging, {
      recursive: true,
      dereference: false,
      force: false,
      errorOnExist: true,
    });
    try {
      await rename(target, backup);
      movedPrevious = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(staging, target);
    if (movedPrevious) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (movedPrevious) await rename(backup, target).catch(() => undefined);
    throw error;
  }
  return target;
}

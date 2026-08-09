import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = process.cwd();
const lock = JSON.parse(readFileSync(resolve(root, 'runtime-assets.lock.json'), 'utf8'));

assert.equal(lock.schema, 'tracecode.runtime-assets-lock.v1');
assert.match(lock.harness.releaseId, /^@tracecode\/harness@0\.16\.0\+sha256\.[0-9a-f]{64}$/u);
assert.equal(
  lock.engineDependencies.tracecc.consumerHash,
  lock.engineDependencies.tracecc.provenance.consumerHash
);
assert.deepEqual(lock.engineDependencies.tracecc.package, {
  name: '@tracecode/tracecc',
  version: '0.1.0',
});
assert.deepEqual(lock.engineDependencies.tracejvm.package, {
  name: '@tracecode/tracejvm',
  version: '0.4.1',
});
assert.equal(
  lock.components.cpp.files.some((file) =>
    file.path.startsWith('workers/cpp/tracecc/')
  ),
  false,
  'the Harness package must not duplicate the TraceCC dependency tree'
);
assert.equal(
  lock.components.java.files.some((file) =>
    file.path.startsWith('workers/java/tracejvm/0.4.1/')
  ),
  false,
  'the Harness package must not duplicate the TraceJVM dependency tree'
);
assert.equal(lock.compatibility.python.runtimeDirectory, 'pyodide-0.29.3');
assert.equal(lock.compatibility.csharp.deployment.compilerSharesGeneralAssets, true);
assert.deepEqual(lock.compatibility.csharp.deployment.browserAssets, {
  general: {
    packagePath: 'workers/vendor/csharp',
    targetPath: 'vendor/csharp',
  },
  compiler: {
    packagePath: 'workers/vendor/csharp',
    targetPath: 'vendor/csharp',
  },
  runner: {
    packagePath: 'workers/vendor/csharp-runner',
    targetPath: 'vendor/csharp-runner',
  },
});
assert.equal(
  lock.compatibility.csharp.roles.general.treeSha256,
  lock.compatibility.csharp.roles.compiler.treeSha256
);
assert.equal(
  lock.components.csharp.files.some((file) =>
    file.path.startsWith('workers/vendor/csharp-compiler/')
  ),
  false,
  'the release lock must not publish the compiler alias as a second tree'
);

for (const [component, release] of Object.entries(lock.components)) {
  assert.match(release.releaseId, new RegExp(`^${component}\\+sha256\\.[0-9a-f]{64}$`, 'u'));
  for (const file of release.files) {
    assert.equal(
      Buffer.from(file.integrity.slice('sha256-'.length), 'base64').toString('hex'),
      file.sha256,
      `${file.path} SRI must represent its recorded SHA-256`
    );
  }
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'tracecode-runtime-lock-'));
try {
  const staleManifestPath = join(temporaryDirectory, 'cpp-runtime-manifest.json');
  writeFileSync(
    staleManifestPath,
    `${JSON.stringify({
      runtime: 'cpp',
      runtimeVersion: 'tracecc-stale',
      protocolVersion: 'browser-runtime-assets-v1',
      assetBaseUrl: `/workers/cpp/tracecc/${'0'.repeat(64)}/`,
      workerFormat: 'module',
      assets: {
        worker: { url: '/workers/cpp-worker.js' },
        runtimeHeader: {
          url: 'tracecode_runtime.hpp',
          integrity: `sha256-${Buffer.alloc(32).toString('base64')}`,
          size: 1,
          mediaType: 'text/plain',
        },
        compilerWasm: {
          url: 'tracecc-reactor.wasm',
          integrity: `sha256-${Buffer.alloc(32).toString('base64')}`,
          size: 1,
          mediaType: 'application/wasm',
        },
        sysroot: {
          url: 'llvm-resources.tar',
          integrity: `sha256-${Buffer.alloc(32).toString('base64')}`,
          size: 1,
          mediaType: 'application/x-tar',
        },
        compilerResources: {},
      },
    }, null, 2)}\n`
  );
  const staleRun = spawnSync(
    process.execPath,
    ['scripts/generate-runtime-assets-lock.mjs', '--check'],
    {
      cwd: root,
      env: { ...process.env, TRACECC_ASSET_MANIFEST: staleManifestPath },
      encoding: 'utf8',
    }
  );
  assert.notEqual(staleRun.status, 0, 'a stale TraceCC runtime must fail closed');
  assert.match(
    staleRun.stderr,
    /TraceCC runtime header mismatch: prepared [0-9a-f]{64}, packaged [0-9a-f]{64}\. Rebuild the TraceCC PCH\/object shards and run prepare:tracecc-assets/u
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log('Runtime asset lock invariants and stale TraceCC diagnostics passed.');

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = process.cwd();
const lock = JSON.parse(readFileSync(resolve(root, 'runtime-assets.lock.json'), 'utf8'));

assert.equal(lock.schema, 'tracecode.runtime-assets-lock.v1');
assert.match(lock.harness.releaseId, /^@tracecode\/harness@0\.16\.0\+sha256\.[0-9a-f]{64}$/u);
assert.equal(lock.external.tracecc.consumerHash, lock.external.tracecc.provenance.consumerHash);
assert.equal(lock.external.tracejvm.package.version, '0.4.0');
assert.equal(lock.compatibility.python.runtimeDirectory, 'pyodide-0.29.3');

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

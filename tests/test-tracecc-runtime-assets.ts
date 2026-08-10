import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createTraceCCRuntimeManifest,
  resolveBuiltInTraceCCProjectRuntimeManifest,
  resolveBuiltInTraceCCRuntimeManifest,
  TRACECC_RUNTIME_ASSET_RELATIVE_PATH,
  TRACECC_RUNTIME_CONTENT_HASH,
  TRACECC_RUNTIME_MANIFEST,
} from '../packages/runtime-cpp/src/tracecc-runtime-assets';
import {
  resolveBrowserRuntimeAssets,
} from '../packages/runtime-browser/src/runtime-assets';

const baseUrl =
  `/runtime-assets/cpp/tracecc/${TRACECC_RUNTIME_CONTENT_HASH}`;
const manifest = createTraceCCRuntimeManifest(baseUrl);
const customWorkerManifest = createTraceCCRuntimeManifest(baseUrl, {
  workerUrl: 'https://workers.example.test/cpp-worker.js',
});
const builtInManifest = resolveBuiltInTraceCCRuntimeManifest();
const builtInProjectManifest =
  resolveBuiltInTraceCCProjectRuntimeManifest();
const builtInConstant = TRACECC_RUNTIME_MANIFEST;
const builtInResolved = resolveBrowserRuntimeAssets({
  assetBaseUrl: '/workers',
  assets: {
    runtimeManifests: { cpp: builtInManifest },
  },
});
const resolved = resolveBrowserRuntimeAssets({
  assetBaseUrl: '/workers',
  assets: {
    runtimeManifests: { cpp: manifest },
  },
});

assert.equal(
  manifest.runtimeVersion,
  `tracecc-${TRACECC_RUNTIME_CONTENT_HASH.slice(0, 12)}`
);
assert.equal(manifest.assetBaseUrl, `${baseUrl}/`);
assert.equal(manifest.assets.worker.url, '/workers/cpp-worker.js');
assert.equal(
  customWorkerManifest.assets.worker.url,
  'https://workers.example.test/cpp-worker.js'
);
assert.equal(
  TRACECC_RUNTIME_ASSET_RELATIVE_PATH,
  `cpp/tracecc/${TRACECC_RUNTIME_CONTENT_HASH}`
);
assert.equal(
  builtInManifest.assetBaseUrl,
  `/workers/${TRACECC_RUNTIME_ASSET_RELATIVE_PATH}/`
);
assert.equal(
  builtInProjectManifest.assetBaseUrl,
  `/workers/${TRACECC_RUNTIME_ASSET_RELATIVE_PATH}/`
);
assert.equal(
  builtInProjectManifest.assets.worker.url,
  '/workers/project-cpp-worker.js'
);
assert.deepEqual(
  builtInConstant,
  builtInManifest,
  'the exported built-in manifest must be the standard /workers manifest'
);
const customRootManifest = resolveBuiltInTraceCCRuntimeManifest('/cdn/workers/');
const customProjectRootManifest =
  resolveBuiltInTraceCCProjectRuntimeManifest('/cdn/workers/');
assert.equal(
  customRootManifest.assetBaseUrl,
  `/cdn/workers/${TRACECC_RUNTIME_ASSET_RELATIVE_PATH}/`
);
assert.equal(
  customRootManifest.assets.worker.url,
  '/cdn/workers/cpp-worker.js'
);
assert.equal(
  customProjectRootManifest.assets.worker.url,
  '/cdn/workers/project-cpp-worker.js'
);
assert.equal(
  builtInResolved.cppCompilerWasm,
  `/workers/${TRACECC_RUNTIME_ASSET_RELATIVE_PATH}/tracecc-reactor.wasm`
);
assert.equal(
  resolved.cppCompilerWasm,
  `${baseUrl}/tracecc-reactor.wasm`
);
assert.equal(resolved.cppLinkerWasm, resolved.cppCompilerWasm);
assert.equal(
  resolved.cppRuntimeHeader,
  `${baseUrl}/tracecode_runtime.hpp`
);
assert.equal(
  resolved.runtimeManifests?.cpp?.assets.compilerResources?.[
    'tracecc-narrow-pch'
  ]?.url,
  `${baseUrl}/narrow.pch`
);
assert.equal(
  resolved.cppCompilerIntegrity?.assets.length,
  12,
  'every direct compiler and lazy shard asset must carry an exact pin'
);
assert.equal(
  resolved.cppCompilerIntegrity?.assets.find(
    (entry) => entry.url === resolved.cppCompilerWasm
  )?.sha256,
  '02de34842538466bf29e9d6cf14cd0d5e5ff519c9ba390561ccb158105d44d41'
);

assert.throws(
  () => createTraceCCRuntimeManifest(''),
  /non-empty asset base URL/
);
assert.throws(
  () => createTraceCCRuntimeManifest('/cdn/workers?version=1'),
  /without a query or fragment/
);
assert.throws(
  () => resolveBuiltInTraceCCRuntimeManifest('/cdn/workers#release'),
  /without a query or fragment/
);
assert.throws(
  () => createTraceCCRuntimeManifest(baseUrl, { workerUrl: '   ' }),
  /worker URL must not be empty/
);

const workerSource = readFileSync(
  new URL('../workers/cpp/cpp-worker.js', import.meta.url),
  'utf8'
);
assert.doesNotMatch(
  workerSource,
  /yowasp/iu,
  'the shipped C++ worker must not retain the retired compiler/download path or branding'
);
assert.match(workerSource, /tracecc-compile:start/u);
assert.doesNotMatch(workerSource, /external-compile:start/u);

console.log('TraceCC runtime asset manifest tests passed');

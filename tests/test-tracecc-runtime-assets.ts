import assert from 'node:assert/strict';
import {
  createTraceCCRuntimeManifest,
  TRACECC_RUNTIME_CONTENT_HASH,
} from '../packages/runtime-cpp/src/tracecc-runtime-assets';
import {
  resolveBrowserRuntimeAssets,
} from '../packages/runtime-browser/src/runtime-assets';

const baseUrl =
  `/runtime-assets/cpp/tracecc/${TRACECC_RUNTIME_CONTENT_HASH}`;
const manifest = createTraceCCRuntimeManifest(baseUrl);
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

console.log('TraceCC runtime asset manifest tests passed');

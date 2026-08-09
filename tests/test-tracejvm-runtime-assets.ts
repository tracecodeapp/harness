#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadEngineRuntimePackages } from '../scripts/runtime-package-assets.mjs';
import {
  preflightBuiltInTraceJVMRuntimeAssets,
  resolveBuiltInTraceJVMRuntimeAssetBaseUrl,
  TRACEJVM_RUNTIME_ASSET_RELATIVE_PATH,
  TRACEJVM_RUNTIME_CONTENT_HASH,
  TRACEJVM_RUNTIME_VERSION,
} from '../packages/runtime-java/src/tracejvm-runtime-assets';

assert.equal(
  resolveBuiltInTraceJVMRuntimeAssetBaseUrl(),
  `/workers/${TRACEJVM_RUNTIME_ASSET_RELATIVE_PATH}`
);
assert.equal(
  resolveBuiltInTraceJVMRuntimeAssetBaseUrl('https://assets.example/workers/'),
  `https://assets.example/workers/${TRACEJVM_RUNTIME_ASSET_RELATIVE_PATH}`
);
assert.equal(TRACEJVM_RUNTIME_VERSION, '0.4.1');
assert.match(TRACEJVM_RUNTIME_CONTENT_HASH, /^[0-9a-f]{64}$/u);

void (async () => {
  const engines = await loadEngineRuntimePackages(resolve('.'));
  const releaseBytes = await readFile(
    join(engines.tracejvm.sourceRoot, 'release.json')
  );
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests += 1;
    assert.equal(
      String(input),
      `/workers/${TRACEJVM_RUNTIME_ASSET_RELATIVE_PATH}/release.json`
    );
    return new Response(releaseBytes, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await Promise.all([
      preflightBuiltInTraceJVMRuntimeAssets(
        `/workers/${TRACEJVM_RUNTIME_ASSET_RELATIVE_PATH}`
      ),
      preflightBuiltInTraceJVMRuntimeAssets(
        `/workers/${TRACEJVM_RUNTIME_ASSET_RELATIVE_PATH}`
      ),
    ]);
    assert.equal(
      requests,
      1,
      'TraceJVM release preflight must be single-flight and cached'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('TraceJVM built-in runtime asset identity tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

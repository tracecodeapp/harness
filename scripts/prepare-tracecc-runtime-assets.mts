import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  resolveBrowserRuntimeAssetManifests,
  type BrowserRuntimeAssetManifest,
} from '../packages/runtime-browser/src/runtime-assets';
import {
  createTraceCCRuntimeManifest,
  TRACECC_RUNTIME_CONTENT_HASH,
} from '../packages/runtime-cpp/src/tracecc-runtime-assets';

interface FileIdentity {
  readonly source: string;
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly integrity: string;
  readonly mediaType: string;
}

const releaseDirectory = process.env.TRACECC_RELEASE_DIR;
const pchDirectory = process.env.TRACECC_PCH_DIR;
const outputRoot = resolve(
  process.env.TRACECC_ASSET_OUTPUT_ROOT ?? '.cache/tracecc-runtime-assets'
);
const publicBaseRoot = (
  process.env.TRACECC_ASSET_BASE_URL ??
  '/workers/cpp/tracecc'
).replace(/\/+$/u, '');

if (!releaseDirectory || !pchDirectory) {
  throw new Error(
    'TRACECC_RELEASE_DIR and TRACECC_PCH_DIR are required.'
  );
}

async function identity(
  source: string,
  name: string,
  mediaType: string
): Promise<FileIdentity> {
  const content = await readFile(source);
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    source,
    name,
    bytes: content.byteLength,
    sha256,
    integrity: `sha256-${Buffer.from(sha256, 'hex').toString('base64')}`,
    mediaType,
  };
}

function descriptor(file: FileIdentity) {
  return {
    url: file.name,
    integrity: file.integrity,
    mediaType: file.mediaType,
    size: file.bytes,
    delivery: {
      mutability: 'immutable' as const,
      address: 'content' as const,
    },
  };
}

async function main(): Promise<void> {
  const releaseRoot = resolve(releaseDirectory);
  const release = JSON.parse(
    await readFile(join(releaseRoot, 'release.json'), 'utf8')
  ) as {
    protocolVersion?: string;
    contentHash?: string;
    artifacts?: {
      reactor?: { path?: string; sha256?: string };
      resources?: { path?: string; sha256?: string };
    };
  };
  if (
    release.protocolVersion !== 'tracecc-toolchain-release-v1' ||
    !/^[0-9a-f]{64}$/u.test(release.contentHash ?? '') ||
    !release.artifacts?.reactor?.path ||
    !release.artifacts.resources?.path
  ) {
    throw new Error('TRACECC_RELEASE_DIR does not contain a valid release.');
  }

  const pchRoot = resolve(pchDirectory);
  const files = {
    reactor: await identity(
      join(releaseRoot, release.artifacts.reactor.path),
      'tracecc-reactor.wasm',
      'application/wasm'
    ),
    resources: await identity(
      join(releaseRoot, release.artifacts.resources.path),
      'llvm-resources.tar',
      'application/x-tar'
    ),
    runtimeHeader: await identity(
      resolve('workers/cpp/tracecode_runtime.hpp'),
      'tracecode_runtime.hpp',
      'text/plain'
    ),
    narrowPch: await identity(
      join(
        pchRoot,
        'tracecode_pch-codegen-common-event-helpers-v2.hpp.pch'
      ),
      'narrow.pch',
      'application/octet-stream'
    ),
    narrowPchSource: await identity(
      join(
        pchRoot,
        'tracecode_pch-codegen-common-event-helpers-v2.hpp.pch.source.hpp'
      ),
      'narrow.source.hpp',
      'text/plain'
    ),
    narrowRuntimeObject: await identity(
      join(pchRoot, 'tracecode_pch-common-event-helpers-v2.o'),
      'narrow.o',
      'application/wasm'
    ),
    broadPch: await identity(
      join(
        pchRoot,
        'tracecode_pch-codegen-corpus-event-helpers-v2.hpp.pch'
      ),
      'broad.pch',
      'application/octet-stream'
    ),
    broadPchSource: await identity(
      join(
        pchRoot,
        'tracecode_pch-codegen-corpus-event-helpers-v2.hpp.pch.source.hpp'
      ),
      'broad.source.hpp',
      'text/plain'
    ),
    broadRuntimeObject: await identity(
      join(pchRoot, 'tracecode_pch-corpus-event-helpers-v2.o'),
      'broad.o',
      'application/wasm'
    ),
    mapPch: await identity(
      join(
        pchRoot,
        'tracecode_pch-codegen-maps-event-helpers-v2.hpp.pch'
      ),
      'map.pch',
      'application/octet-stream'
    ),
    mapPchSource: await identity(
      join(
        pchRoot,
        'tracecode_pch-codegen-maps-event-helpers-v2.hpp.pch.source.hpp'
      ),
      'map.source.hpp',
      'text/plain'
    ),
    mapRuntimeObject: await identity(
      join(pchRoot, 'tracecode_pch-maps-event-helpers-v2.o'),
      'map.o',
      'application/wasm'
    ),
  };
  if (
    files.reactor.sha256 !== release.artifacts.reactor.sha256 ||
    files.resources.sha256 !== release.artifacts.resources.sha256
  ) {
    throw new Error('TraceCC release artifact digest mismatch.');
  }

  const consumerHash = createHash('sha256')
    .update(release.contentHash)
    .update(
      Object.values(files)
        .map((file) => file.sha256)
        .join('')
    )
    .digest('hex');
  const outputDirectory = join(outputRoot, consumerHash);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    Object.values(files).map((file) =>
      cp(file.source, join(outputDirectory, file.name))
    )
  );

  const manifest = {
    runtime: 'cpp',
    runtimeVersion: `tracecc-${consumerHash.slice(0, 12)}`,
    protocolVersion: 'browser-runtime-assets-v1',
    assetBaseUrl: `${publicBaseRoot}/${consumerHash}/`,
    workerFormat: 'module',
    assets: {
      worker: { url: '/workers/cpp-worker.js' },
      runtimeHeader: descriptor(files.runtimeHeader),
      compilerWasm: descriptor(files.reactor),
      // The v9r1 reactor contains both the fixed frontend and Wasm-only LLD.
      linkerWasm: descriptor(files.reactor),
      sysroot: descriptor(files.resources),
      compilerResources: {
        'tracecc-narrow-pch': descriptor(files.narrowPch),
        'tracecc-narrow-pch-source': descriptor(files.narrowPchSource),
        'tracecc-narrow-runtime-object':
          descriptor(files.narrowRuntimeObject),
        'tracecc-broad-pch': descriptor(files.broadPch),
        'tracecc-broad-pch-source': descriptor(files.broadPchSource),
        'tracecc-broad-runtime-object':
          descriptor(files.broadRuntimeObject),
        'tracecc-map-pch': descriptor(files.mapPch),
        'tracecc-map-pch-source': descriptor(files.mapPchSource),
        'tracecc-map-runtime-object': descriptor(files.mapRuntimeObject),
      },
    },
  };
  if (consumerHash !== TRACECC_RUNTIME_CONTENT_HASH) {
    throw new Error(
      `TraceCC consumer hash drifted: expected ${TRACECC_RUNTIME_CONTENT_HASH}, received ${consumerHash}.`
    );
  }
  const frozenManifest = createTraceCCRuntimeManifest(
    manifest.assetBaseUrl
  );
  if (JSON.stringify(frozenManifest) !== JSON.stringify(manifest)) {
    throw new Error(
      'TraceCC v9r1 generated assets no longer match the harness-owned browser manifest.'
    );
  }
  resolveBrowserRuntimeAssetManifests({
    assetBaseUrl: '/',
    manifests: {
      cpp: manifest as BrowserRuntimeAssetManifest<'cpp'>,
    },
  });
  const manifestPath = join(outputDirectory, 'cpp-runtime-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(JSON.stringify({
    outputDirectory,
    manifestPath,
    publicBaseUrl: manifest.assetBaseUrl,
    contentHash: consumerHash,
    rawBytes: Object.values(files).reduce(
      (total, file) => total + file.bytes,
      0
    ),
    narrowInitialRawBytes:
      files.reactor.bytes +
      files.resources.bytes +
      files.runtimeHeader.bytes +
      files.narrowPch.bytes +
      files.narrowPchSource.bytes +
      files.narrowRuntimeObject.bytes,
  }, null, 2));
}

void main();

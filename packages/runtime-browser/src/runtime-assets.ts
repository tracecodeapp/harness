const DEFAULT_ASSET_BASE_URL = '/workers';

/**
 * Version of the consumer-facing browser runtime asset manifest contract.
 *
 * This is intentionally independent from each runtime's own version. A consumer
 * can upgrade a runtime without changing the manifest protocol, and the harness
 * can reject manifests that use a newer contract it does not understand.
 */
export const BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION = 'browser-runtime-assets-v1';

export const BROWSER_RUNTIME_IDS = Object.freeze([
  'python',
  'javascript',
  'typescript',
  'java',
  'csharp',
  'cpp',
] as const);

export type BrowserRuntimeId = (typeof BROWSER_RUNTIME_IDS)[number];

export type BrowserRuntimeAssetOriginPolicy =
  | Readonly<{ mode: 'any' }>
  | Readonly<{ mode: 'same-origin' }>
  | Readonly<{ mode: 'allow-list'; origins: readonly string[] }>;

export type BrowserRuntimeWorkerFormat = 'classic' | 'module';
export type BrowserRuntimeLoaderFormat = 'classic-script' | 'module';

export interface CppCompilerIntegrityEntry {
  url: string;
  sha256: string;
  size?: number;
}

export interface CppCompilerIntegrityManifest {
  assets: readonly CppCompilerIntegrityEntry[];
}

export interface BrowserRuntimeAssetDelivery {
  /** The publisher promises that bytes at this URL never change. */
  mutability: 'immutable';
  /** Whether immutability comes from a digest address or a pinned version path. */
  address: 'content' | 'versioned';
}

/** A single consumer-owned browser runtime asset. */
export interface BrowserRuntimeAssetDescriptor {
  /** Absolute consumer URL or a path relative to the manifest/global asset base URL. */
  url: string;
  /**
   * Optional runtime-native reference for an asset whose delivery URL is not
   * the value the runtime consumes (for example a runtime-native VFS path).
   * Preflight and origin policy always apply to url.
   */
  runtimePath?: string;
  /**
   * Integrity for the harness preflight response. Most browser loaders fetch
   * the URL again, so this is not execution-bound SRI. Use immutable delivery;
   * C++ compiler pins are the current exception with exact internal binding.
   */
  integrity?: string;
  /** Expected response Content-Type verified before the runtime asset may be used. */
  mediaType?: string;
  /** Expected decoded response byte size retained for pre-execution verification. */
  size?: number;
  /** Overrides the manifest-level origin policy for this asset. */
  originPolicy?: BrowserRuntimeAssetOriginPolicy;
  /** Explicit publisher attestation that permits successful preflight caching. */
  delivery?: BrowserRuntimeAssetDelivery;
}

export interface BrowserRuntimeAssetsByRuntime {
  python: {
    worker: BrowserRuntimeAssetDescriptor;
    runtimeCore: BrowserRuntimeAssetDescriptor;
    snippets: BrowserRuntimeAssetDescriptor;
    /** Python runtime bootstrap module or script. */
    runtimeLoader: BrowserRuntimeAssetDescriptor;
    /** Base URL used by the Python runtime to resolve its distribution assets. */
    runtimeIndex: BrowserRuntimeAssetDescriptor;
    /**
     * Optional complete self-hosted distribution inventory keyed by the exact
     * deployment-relative path beneath runtimeIndex.
     */
    distribution?: Readonly<Record<string, BrowserRuntimeAssetDescriptor>>;
    /** Optional package artifacts keyed by the package name passed to the Python runtime. */
    packages?: Readonly<Record<string, BrowserRuntimeAssetDescriptor>>;
  };
  javascript: {
    worker: BrowserRuntimeAssetDescriptor;
    projectWorker: BrowserRuntimeAssetDescriptor;
    libraries?: BrowserRuntimeAssetDescriptor;
  };
  typescript: {
    compiler: BrowserRuntimeAssetDescriptor;
  };
  java: {
    worker: BrowserRuntimeAssetDescriptor;
  };
  csharp: {
    worker: BrowserRuntimeAssetDescriptor;
    assetBaseUrl: BrowserRuntimeAssetDescriptor;
    /** Runtime files beneath assetBaseUrl, keyed by their deployment-relative path. */
    dependencies?: Readonly<Record<string, BrowserRuntimeAssetDescriptor>>;
  };
  cpp: {
    worker: BrowserRuntimeAssetDescriptor;
    compilerFrame: BrowserRuntimeAssetDescriptor;
    compilerWorker: BrowserRuntimeAssetDescriptor;
    runtimeHeader: BrowserRuntimeAssetDescriptor;
    /** The bundled compiler is optional when all three direct compiler assets are supplied. */
    compilerBundle?: BrowserRuntimeAssetDescriptor;
    compilerWasm?: BrowserRuntimeAssetDescriptor;
    linkerWasm?: BrowserRuntimeAssetDescriptor;
    sysroot?: BrowserRuntimeAssetDescriptor;
    /** Additional lazy compiler resources keyed by a consumer-defined stable name. */
    compilerResources?: Readonly<Record<string, BrowserRuntimeAssetDescriptor>>;
  };
}

export interface BrowserRuntimeAssetManifest<Runtime extends BrowserRuntimeId = BrowserRuntimeId> {
  runtime: Runtime;
  runtimeVersion: string;
  protocolVersion: typeof BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION;
  /** Base used only for relative URLs in this manifest. */
  assetBaseUrl?: string;
  originPolicy?: BrowserRuntimeAssetOriginPolicy;
  /** Worker construction mode. Normalized manifests always make this explicit when applicable. */
  workerFormat?: BrowserRuntimeWorkerFormat;
  /** Loader mechanism used inside the worker. */
  loaderFormat?: BrowserRuntimeLoaderFormat;
  assets: BrowserRuntimeAssetsByRuntime[Runtime];
}

export type AnyBrowserRuntimeAssetManifest = {
  [Runtime in BrowserRuntimeId]: BrowserRuntimeAssetManifest<Runtime>;
}[BrowserRuntimeId];

export type BrowserRuntimeAssetManifests = Partial<{
  [Runtime in BrowserRuntimeId]: BrowserRuntimeAssetManifest<Runtime>;
}>;

/**
 * Synchronous provider hook for deployments that construct manifests from
 * environment or tenant configuration. Explicit manifests take precedence.
 */
export type BrowserRuntimeAssetManifestProvider = (
  runtime: BrowserRuntimeId
) => AnyBrowserRuntimeAssetManifest | undefined;

export interface BrowserRuntimeAssets {
  pythonWorker: string;
  pythonRuntimeCore: string;
  pythonSnippets: string;
  javascriptWorker: string;
  javascriptProjectWorker: string;
  javaWorker: string;
  csharpWorker: string;
  csharpAssetBaseUrl: string;
  typescriptCompiler: string;
  cppWorker: string;
  cppCompilerFrame: string;
  cppCompilerWorker: string;
  cppCompilerWasm: string;
  cppLinkerWasm: string;
  cppSysroot: string;
  cppRuntimeHeader: string;
  cppCompilerBundle: string;
  cppCompilerIntegrity?: CppCompilerIntegrityManifest;
  /** Validated, URL-resolved manifests supplied by the consumer. */
  runtimeManifests?: BrowserRuntimeAssetManifests;
}

type LegacyBrowserRuntimeAssetOverrides = Partial<Omit<BrowserRuntimeAssets, 'runtimeManifests'>>;

export type BrowserRuntimeAssetOverrides = LegacyBrowserRuntimeAssetOverrides & {
  runtimeManifests?: BrowserRuntimeAssetManifests;
  runtimeAssetProvider?: BrowserRuntimeAssetManifestProvider;
};

export const DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS: Readonly<BrowserRuntimeAssets> = Object.freeze({
  pythonWorker: 'python-worker.js',
  pythonRuntimeCore: 'python/runtime-core.js',
  pythonSnippets: 'generated-python-harness-snippets.js',
  javascriptWorker: 'javascript-worker.js',
  javascriptProjectWorker: 'javascript-project-worker.js',
  // The Java runtime bridge extends the canonical Classic protocol and imports
  // java-worker.js as its sibling, so deployments must continue shipping both.
  javaWorker: 'java-runtime-worker.js',
  csharpWorker: 'csharp-worker.js',
  csharpAssetBaseUrl: 'vendor/csharp',
  typescriptCompiler: 'vendor/typescript.js',
  cppWorker: 'cpp-worker.js',
  cppCompilerFrame: 'cpp-compiler-frame.html',
  cppCompilerWorker: 'cpp-compiler-worker.js',
  cppCompilerWasm: '',
  cppLinkerWasm: '',
  cppSysroot: '',
  cppRuntimeHeader: 'cpp/tracecode_runtime.hpp',
  cppCompilerBundle: 'cpp/compiler/bundle.js',
});

const RUNTIME_ASSET_NAMES = Object.freeze({
  python: ['worker', 'runtimeCore', 'snippets', 'runtimeLoader', 'runtimeIndex', 'distribution', 'packages'],
  javascript: ['worker', 'projectWorker', 'libraries'],
  typescript: ['compiler'],
  java: ['worker'],
  csharp: ['worker', 'assetBaseUrl', 'dependencies'],
  cpp: [
    'worker',
    'compilerFrame',
    'compilerWorker',
    'runtimeHeader',
    'compilerBundle',
    'compilerWasm',
    'linkerWasm',
    'sysroot',
    'compilerResources',
  ],
} satisfies Record<BrowserRuntimeId, readonly string[]>);

const RUNTIME_ASSET_COLLECTION_NAMES = Object.freeze({
  python: ['distribution', 'packages'],
  javascript: [],
  typescript: [],
  java: [],
  csharp: ['dependencies'],
  cpp: ['compilerResources'],
} satisfies Record<BrowserRuntimeId, readonly string[]>);

const EXPECTED_WORKER_FORMAT = Object.freeze({
  javascript: 'classic',
  java: 'classic',
  csharp: 'module',
  cpp: 'module',
} satisfies Partial<Record<BrowserRuntimeId, BrowserRuntimeWorkerFormat>>);

const EXPECTED_LOADER_FORMAT = Object.freeze({
  typescript: 'classic-script',
  java: 'classic-script',
  csharp: 'module',
} satisfies Partial<Record<BrowserRuntimeId, BrowserRuntimeLoaderFormat>>);

const REQUIRED_RUNTIME_ASSET_NAMES = Object.freeze({
  python: ['worker', 'runtimeCore', 'snippets', 'runtimeLoader', 'runtimeIndex'],
  javascript: ['worker', 'projectWorker'],
  typescript: ['compiler'],
  java: ['worker'],
  csharp: ['worker', 'assetBaseUrl'],
  cpp: ['worker', 'compilerFrame', 'compilerWorker', 'runtimeHeader'],
} satisfies Record<BrowserRuntimeId, readonly string[]>);

const RUNTIME_LEGACY_ASSET_KEYS = Object.freeze({
  python: ['pythonWorker', 'pythonRuntimeCore', 'pythonSnippets'],
  javascript: ['javascriptWorker', 'javascriptProjectWorker'],
  typescript: ['typescriptCompiler'],
  java: ['javaWorker'],
  csharp: ['csharpWorker', 'csharpAssetBaseUrl'],
  cpp: [
    'cppWorker',
    'cppCompilerFrame',
    'cppCompilerWorker',
    'cppCompilerWasm',
    'cppLinkerWasm',
    'cppSysroot',
    'cppRuntimeHeader',
    'cppCompilerBundle',
  ],
} satisfies Record<BrowserRuntimeId, readonly (keyof LegacyBrowserRuntimeAssetOverrides)[]>);

function isExplicitAssetPath(pathname: string): boolean {
  return (
    pathname.startsWith('/') ||
    pathname.startsWith('./') ||
    pathname.startsWith('../') ||
    pathname.startsWith('http://') ||
    pathname.startsWith('https://') ||
    pathname.startsWith('data:') ||
    pathname.startsWith('blob:')
  );
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function trimLeadingSlash(value: string): string {
  return value.replace(/^\/+/, '');
}

function resolveAssetPath(baseUrl: string, pathname: string): string {
  if (pathname === '') {
    return '';
  }
  if (isExplicitAssetPath(pathname)) {
    return pathname;
  }
  const normalizedBase = stripTrailingSlash(baseUrl || DEFAULT_ASSET_BASE_URL);
  const normalizedPath = trimLeadingSlash(pathname);
  return `${normalizedBase}/${normalizedPath}`;
}

function resolveManifestAssetPath(baseUrl: string, pathname: string): string {
  if (pathname === '') return '';
  if (
    pathname.startsWith('/') ||
    pathname.startsWith('http://') ||
    pathname.startsWith('https://') ||
    pathname.startsWith('data:') ||
    pathname.startsWith('blob:')
  ) {
    return pathname;
  }
  const normalizedBase = stripTrailingSlash(baseUrl || DEFAULT_ASSET_BASE_URL);
  if (normalizedBase.startsWith('http://') || normalizedBase.startsWith('https://')) {
    return new URL(pathname, `${normalizedBase}/`).href;
  }
  return `${normalizedBase}/${pathname.replace(/^\.\//u, '')}`;
}

function manifestError(runtime: BrowserRuntimeId, detail: string): TypeError {
  return new TypeError(`Invalid browser runtime asset manifest "${runtime}": ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOriginPolicy(
  runtime: BrowserRuntimeId,
  label: string,
  value: unknown
): BrowserRuntimeAssetOriginPolicy | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw manifestError(runtime, `${label} must be an origin policy object.`);
  }
  if (value.mode === 'any' || value.mode === 'same-origin') {
    if (Object.keys(value).some((key) => key !== 'mode')) {
      throw manifestError(runtime, `${label} mode "${value.mode}" does not accept additional fields.`);
    }
    return Object.freeze({ mode: value.mode });
  }
  if (value.mode !== 'allow-list') {
    throw manifestError(runtime, `${label}.mode must be "any", "same-origin", or "allow-list".`);
  }
  if (!Array.isArray(value.origins) || value.origins.length === 0) {
    throw manifestError(runtime, `${label}.origins must be a non-empty array for "allow-list" mode.`);
  }
  const origins = value.origins.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw manifestError(runtime, `${label}.origins[${index}] must be a non-empty absolute HTTP(S) origin.`);
    }
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw manifestError(runtime, `${label}.origins[${index}] must be a valid absolute HTTP(S) origin.`);
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin === 'null') {
      throw manifestError(runtime, `${label}.origins[${index}] must use HTTP or HTTPS.`);
    }
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw manifestError(runtime, `${label}.origins[${index}] must contain only an origin, without credentials, path, query, or hash.`);
    }
    return parsed.origin;
  });
  return Object.freeze({ mode: 'allow-list', origins: Object.freeze([...new Set(origins)]) });
}

function assertOriginPolicyAllowsUrl(
  runtime: BrowserRuntimeId,
  assetName: string,
  url: string,
  policy: BrowserRuntimeAssetOriginPolicy | undefined
): void {
  if (!policy || policy.mode === 'any') return;
  const isAbsoluteHttpUrl = url.startsWith('http://') || url.startsWith('https://');
  if (policy.mode === 'same-origin') {
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      throw manifestError(
        runtime,
        `asset "${assetName}" cannot use a data: or blob: URL under the "same-origin" policy.`
      );
    }
    if (isAbsoluteHttpUrl && typeof globalThis.location?.href === 'string') {
      const assetOrigin = new URL(url).origin;
      const documentOrigin = new URL(globalThis.location.href).origin;
      if (assetOrigin !== documentOrigin) {
        throw manifestError(
          runtime,
          `asset "${assetName}" uses origin "${assetOrigin}", which is not the current origin "${documentOrigin}".`
        );
      }
    }
    return;
  }
  if (!isAbsoluteHttpUrl) {
    throw manifestError(runtime, `asset "${assetName}" must use an absolute HTTP(S) URL under the "allow-list" policy.`);
  }
  const origin = new URL(url).origin;
  if (!policy.origins.includes(origin)) {
    throw manifestError(runtime, `asset "${assetName}" uses origin "${origin}", which is not in its origin allow-list.`);
  }
}

function normalizeAssetDescriptor(
  runtime: BrowserRuntimeId,
  assetName: string,
  value: unknown,
  baseUrl: string,
  manifestOriginPolicy: BrowserRuntimeAssetOriginPolicy | undefined
): Readonly<BrowserRuntimeAssetDescriptor> {
  if (!isRecord(value)) {
    throw manifestError(runtime, `asset "${assetName}" must be an object.`);
  }
  const allowedFields = new Set(['url', 'runtimePath', 'integrity', 'mediaType', 'size', 'originPolicy', 'delivery']);
  const unknownField = Object.keys(value).find((field) => !allowedFields.has(field));
  if (unknownField) {
    throw manifestError(runtime, `asset "${assetName}" has unknown field "${unknownField}".`);
  }
  if (typeof value.url !== 'string' || value.url.trim() === '') {
    throw manifestError(runtime, `asset "${assetName}" must provide a non-empty URL.`);
  }
  if (value.url !== value.url.trim() || /[\u0000-\u001f\u007f]/u.test(value.url)) {
    throw manifestError(runtime, `asset "${assetName}" URL must not contain surrounding whitespace or control characters.`);
  }
  if (
    value.runtimePath !== undefined &&
    (
      typeof value.runtimePath !== 'string' ||
      value.runtimePath.trim() === '' ||
      value.runtimePath !== value.runtimePath.trim() ||
      /[\u0000-\u001f\u007f]/u.test(value.runtimePath)
    )
  ) {
    throw manifestError(runtime, `asset "${assetName}" runtimePath must be a non-empty string without surrounding whitespace or control characters.`);
  }
  const scheme = /^([a-z][a-z\d+.-]*):/iu.exec(value.url)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https' && scheme !== 'data' && scheme !== 'blob') {
    throw manifestError(runtime, `asset "${assetName}" URL uses unsupported scheme "${scheme}".`);
  }
  if (value.integrity !== undefined && (typeof value.integrity !== 'string' || value.integrity.trim() === '')) {
    throw manifestError(runtime, `asset "${assetName}" integrity must be a non-empty string.`);
  }
  if (value.mediaType !== undefined && (typeof value.mediaType !== 'string' || value.mediaType.trim() === '')) {
    throw manifestError(runtime, `asset "${assetName}" mediaType must be a non-empty string.`);
  }
  if (
    value.size !== undefined &&
    (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0)
  ) {
    throw manifestError(runtime, `asset "${assetName}" size must be a non-negative safe integer.`);
  }
  let delivery: BrowserRuntimeAssetDelivery | undefined;
  if (value.delivery !== undefined) {
    const rawDelivery = value.delivery;
    if (!isRecord(rawDelivery)) {
      throw manifestError(runtime, `asset "${assetName}" delivery must be an object.`);
    }
    if (
      rawDelivery.mutability !== 'immutable' ||
      (rawDelivery.address !== 'content' && rawDelivery.address !== 'versioned') ||
      Object.keys(rawDelivery).some((field) => field !== 'mutability' && field !== 'address')
    ) {
      throw manifestError(
        runtime,
        `asset "${assetName}" delivery must declare { mutability: "immutable", address: "content" | "versioned" }.`
      );
    }
    delivery = {
      mutability: 'immutable',
      address: rawDelivery.address,
    };
  }
  const originPolicy = normalizeOriginPolicy(runtime, `asset "${assetName}" originPolicy`, value.originPolicy);
  const url = resolveManifestAssetPath(baseUrl, value.url);
  assertOriginPolicyAllowsUrl(runtime, assetName, url, originPolicy ?? manifestOriginPolicy);
  const normalized: BrowserRuntimeAssetDescriptor = { url };
  if (value.runtimePath !== undefined) normalized.runtimePath = value.runtimePath as string;
  if (value.integrity !== undefined) normalized.integrity = value.integrity as string;
  if (value.mediaType !== undefined) normalized.mediaType = value.mediaType as string;
  if (value.size !== undefined) normalized.size = value.size as number;
  if (originPolicy) normalized.originPolicy = originPolicy;
  if (delivery) normalized.delivery = Object.freeze(delivery);
  return Object.freeze(normalized);
}

function normalizeAssetDescriptorCollection(
  runtime: BrowserRuntimeId,
  collectionName: string,
  value: unknown,
  baseUrl: string,
  manifestOriginPolicy: BrowserRuntimeAssetOriginPolicy | undefined
): Readonly<Record<string, Readonly<BrowserRuntimeAssetDescriptor>>> {
  if (!isRecord(value)) {
    throw manifestError(runtime, `asset collection "${collectionName}" must be an object.`);
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw manifestError(runtime, `asset collection "${collectionName}" must not be empty.`);
  }
  const normalized: Record<string, Readonly<BrowserRuntimeAssetDescriptor>> = Object.create(null) as Record<
    string,
    Readonly<BrowserRuntimeAssetDescriptor>
  >;
  for (const [name, descriptor] of entries) {
    if (
      name.trim() === '' ||
      name !== name.trim() ||
      /[\u0000-\u001f\u007f]/u.test(name) ||
      name === '__proto__' ||
      name === 'prototype' ||
      name === 'constructor'
    ) {
      throw manifestError(runtime, `asset collection "${collectionName}" contains an invalid key.`);
    }
    normalized[name] = normalizeAssetDescriptor(
      runtime,
      `${collectionName}.${name}`,
      descriptor,
      baseUrl,
      manifestOriginPolicy
    );
  }
  return Object.freeze(normalized);
}

function assertPythonDistributionManifestCompatibility(
  assets: BrowserRuntimeAssetsByRuntime['python']
): void {
  if (!assets.distribution) return;
  const runtimeIndex = assets.runtimeIndex?.url;
  if (!runtimeIndex) {
    throw manifestError('python', 'assets.distribution requires assets.runtimeIndex.');
  }
  const syntheticOrigin = 'https://tracecode-relative.invalid';
  const indexUrl = new URL(runtimeIndex, `${syntheticOrigin}/`);
  if (!indexUrl.pathname.endsWith('/')) indexUrl.pathname += '/';
  const seenUrls = new Set<string>();
  for (const [path, descriptor] of Object.entries(assets.distribution)) {
    if (
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw manifestError(
        'python',
        `assets.distribution key ${JSON.stringify(path)} must be a normalized deployment-relative path beneath runtimeIndex.`
      );
    }
    const expectedUrl = new URL(path, indexUrl).href;
    const descriptorUrl = new URL(descriptor.url, `${syntheticOrigin}/`).href;
    if (descriptorUrl !== expectedUrl) {
      throw manifestError(
        'python',
        `assets.distribution.${path} URL must resolve exactly beneath assets.runtimeIndex.`
      );
    }
    if (seenUrls.has(descriptorUrl)) {
      throw manifestError('python', `assets.distribution contains a duplicate URL for ${JSON.stringify(path)}.`);
    }
    seenUrls.add(descriptorUrl);
  }
}

const CPP_DIRECT_COMPILER_ASSET_NAMES = Object.freeze([
  'runtimeHeader',
  'compilerBundle',
  'compilerWasm',
  'linkerWasm',
  'sysroot',
] as const);

function assetOriginKey(url: string): string {
  const relativeOrigin = 'https://tracecode-relative.invalid';
  const parsed = new URL(url, `${relativeOrigin}/`);
  return parsed.origin === relativeOrigin ? '$document-origin' : parsed.origin;
}

function decodeSha256Base64(value: string): string | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/u.test(value)) return undefined;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let accumulator = 0;
  let bitCount = 0;
  const bytes: number[] = [];
  for (const character of value.replace(/=+$/u, '')) {
    const index = alphabet.indexOf(character);
    if (index < 0) return undefined;
    accumulator = (accumulator << 6) | index;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((accumulator >> bitCount) & 0xff);
    }
  }
  if (bytes.length !== 32) return undefined;
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function descriptorSha256(
  assetName: string,
  descriptor: BrowserRuntimeAssetDescriptor
): string | undefined {
  if (!descriptor.integrity) return undefined;
  const digests = new Set<string>();
  for (const token of descriptor.integrity.trim().split(/\s+/u)) {
    const match = /^sha256-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/u.exec(token);
    if (!match) continue;
    const hex = decodeSha256Base64(match[1]);
    if (!hex) {
      throw manifestError('cpp', `asset "${assetName}" contains an invalid SHA-256 SRI digest.`);
    }
    digests.add(hex);
  }
  if (digests.size > 1) {
    throw manifestError(
      'cpp',
      `asset "${assetName}" must declare one unambiguous SHA-256 digest for compiler pinning.`
    );
  }
  return digests.values().next().value as string | undefined;
}

function cppCompilerDescriptors(
  assets: BrowserRuntimeAssetsByRuntime['cpp']
): Array<{ name: string; descriptor: BrowserRuntimeAssetDescriptor }> {
  const descriptors: Array<{ name: string; descriptor: BrowserRuntimeAssetDescriptor }> = [];
  for (const name of CPP_DIRECT_COMPILER_ASSET_NAMES) {
    const descriptor = assets[name];
    if (descriptor) descriptors.push({ name, descriptor });
  }
  for (const [name, descriptor] of Object.entries(assets.compilerResources ?? {})) {
    descriptors.push({ name: `compilerResources.${name}`, descriptor });
  }
  return descriptors;
}

function assertCppCompilerManifestCompatibility(
  assets: BrowserRuntimeAssetsByRuntime['cpp']
): void {
  const compilerOrigin = assetOriginKey(assets.compilerWorker.url);
  if (assetOriginKey(assets.compilerFrame.url) !== compilerOrigin) {
    throw manifestError('cpp', 'assets.compilerFrame and assets.compilerWorker must share an origin.');
  }
  for (const { name, descriptor } of cppCompilerDescriptors(assets)) {
    const sha256 = descriptorSha256(name, descriptor);
    if (assetOriginKey(descriptor.url) !== compilerOrigin && !sha256) {
      throw manifestError(
        'cpp',
        `cross-origin asset "${name}" must include an exact sha256 SRI token for compiler pinning.`
      );
    }
  }
}

function derivedCppCompilerIntegrity(
  manifests: BrowserRuntimeAssetManifests
): CppCompilerIntegrityManifest | undefined {
  const manifest = manifests.cpp;
  if (!manifest) return undefined;
  const entries = cppCompilerDescriptors(manifest.assets).flatMap(({ name, descriptor }) => {
    const sha256 = descriptorSha256(name, descriptor);
    return sha256
      ? [{
          url: descriptor.url,
          sha256,
          ...(descriptor.size === undefined ? {} : { size: descriptor.size }),
        }]
      : [];
  });
  return entries.length > 0 ? Object.freeze({ assets: Object.freeze(entries) }) : undefined;
}

function mergeCppCompilerIntegrity(
  explicit: CppCompilerIntegrityManifest | undefined,
  derived: CppCompilerIntegrityManifest | undefined
): CppCompilerIntegrityManifest | undefined {
  if (!derived) return explicit;
  if (!explicit) return derived;
  const entries = new Map<string, CppCompilerIntegrityManifest['assets'][number]>();
  for (const entry of [...explicit.assets, ...derived.assets]) {
    const existing = entries.get(entry.url);
    if (
      existing &&
      (existing.sha256.toLowerCase() !== entry.sha256.toLowerCase() ||
        (existing.size !== undefined && entry.size !== undefined && existing.size !== entry.size))
    ) {
      throw manifestError('cpp', `conflicting exact integrity pins were provided for ${JSON.stringify(entry.url)}.`);
    }
    entries.set(entry.url, {
      ...existing,
      ...entry,
      ...(existing?.size !== undefined && entry.size === undefined ? { size: existing.size } : {}),
    });
  }
  return Object.freeze({ assets: Object.freeze(Array.from(entries.values())) });
}

function normalizeWorkerAndLoaderFormats(
  runtime: BrowserRuntimeId,
  value: BrowserRuntimeAssetManifest,
  assets: Record<string, unknown>
): Pick<BrowserRuntimeAssetManifest, 'workerFormat' | 'loaderFormat'> {
  const expectedWorkerFormat = EXPECTED_WORKER_FORMAT[runtime as keyof typeof EXPECTED_WORKER_FORMAT];
  const expectedLoaderFormat = EXPECTED_LOADER_FORMAT[runtime as keyof typeof EXPECTED_LOADER_FORMAT];
  const workerFormat = value.workerFormat ?? expectedWorkerFormat;
  const loaderFormat = value.loaderFormat ?? expectedLoaderFormat;

  if (value.workerFormat !== undefined && value.workerFormat !== 'classic' && value.workerFormat !== 'module') {
    throw manifestError(runtime, 'workerFormat must be "classic" or "module".');
  }
  if (workerFormat && expectedWorkerFormat && workerFormat !== expectedWorkerFormat) {
    throw manifestError(
      runtime,
      `workerFormat "${workerFormat}" is incompatible with this harness worker; expected "${expectedWorkerFormat}".`
    );
  }
  if (value.loaderFormat !== undefined && value.loaderFormat !== 'classic-script' && value.loaderFormat !== 'module') {
    throw manifestError(runtime, 'loaderFormat must be "classic-script" or "module".');
  }
  if (runtime === 'python') {
    if (value.workerFormat === undefined || value.loaderFormat === undefined) {
      throw manifestError(
        runtime,
        'Python manifests must explicitly declare workerFormat and loaderFormat; legacy defaults apply only when no Python manifest is active.'
      );
    }
    const pythonWorkerFormat = value.workerFormat ?? 'classic';
    const pythonLoaderFormat = value.loaderFormat ?? 'classic-script';
    const coherentPythonPair =
      (pythonWorkerFormat === 'classic' && pythonLoaderFormat === 'classic-script') ||
      (pythonWorkerFormat === 'module' && pythonLoaderFormat === 'module');
    if (!coherentPythonPair) {
      throw manifestError(
        runtime,
        `workerFormat "${pythonWorkerFormat}" and loaderFormat "${pythonLoaderFormat}" are incompatible; ` +
          'Python requires classic + classic-script or module + module.'
      );
    }
    return {
      workerFormat: pythonWorkerFormat,
      loaderFormat: pythonLoaderFormat,
    };
  }
  if (loaderFormat && expectedLoaderFormat && loaderFormat !== expectedLoaderFormat) {
    throw manifestError(
      runtime,
      `loaderFormat "${loaderFormat}" is incompatible with this harness loader; expected "${expectedLoaderFormat}".`
    );
  }

  return {
    ...(workerFormat ? { workerFormat } : {}),
    ...(loaderFormat ? { loaderFormat } : {}),
  };
}

function normalizeManifest<Runtime extends BrowserRuntimeId>(
  expectedRuntime: Runtime,
  value: BrowserRuntimeAssetManifest<Runtime>,
  globalAssetBaseUrl: string
): BrowserRuntimeAssetManifest<Runtime> {
  if (!isRecord(value)) {
    throw manifestError(expectedRuntime, 'manifest must be an object.');
  }
  const allowedManifestFields = new Set([
    'runtime',
    'runtimeVersion',
    'protocolVersion',
    'assetBaseUrl',
    'originPolicy',
    'workerFormat',
    'loaderFormat',
    'assets',
  ]);
  const unknownManifestField = Object.keys(value).find((field) => !allowedManifestFields.has(field));
  if (unknownManifestField) {
    throw manifestError(expectedRuntime, `unknown manifest field "${unknownManifestField}".`);
  }
  if (value.runtime !== expectedRuntime) {
    throw manifestError(expectedRuntime, `runtime must be "${expectedRuntime}", received "${String(value.runtime)}".`);
  }
  if (typeof value.runtimeVersion !== 'string' || value.runtimeVersion.trim() === '') {
    throw manifestError(expectedRuntime, 'runtimeVersion must be a non-empty string.');
  }
  if (value.runtimeVersion !== value.runtimeVersion.trim() || /[\u0000-\u001f\u007f]/u.test(value.runtimeVersion)) {
    throw manifestError(expectedRuntime, 'runtimeVersion must not contain surrounding whitespace or control characters.');
  }
  if (value.protocolVersion !== BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION) {
    throw manifestError(
      expectedRuntime,
      `unsupported protocolVersion "${String(value.protocolVersion)}"; expected "${BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION}".`
    );
  }
  if (value.assetBaseUrl !== undefined && (typeof value.assetBaseUrl !== 'string' || value.assetBaseUrl.trim() === '')) {
    throw manifestError(expectedRuntime, 'assetBaseUrl must be a non-empty string when provided.');
  }
  if (typeof value.assetBaseUrl === 'string') {
    if (value.assetBaseUrl !== value.assetBaseUrl.trim() || /[\u0000-\u001f\u007f]/u.test(value.assetBaseUrl)) {
      throw manifestError(expectedRuntime, 'assetBaseUrl must not contain surrounding whitespace or control characters.');
    }
    const scheme = /^([a-z][a-z\d+.-]*):/iu.exec(value.assetBaseUrl)?.[1]?.toLowerCase();
    if (scheme && scheme !== 'http' && scheme !== 'https') {
      throw manifestError(expectedRuntime, `assetBaseUrl uses unsupported scheme "${scheme}".`);
    }
  }
  if (!isRecord(value.assets)) {
    throw manifestError(expectedRuntime, 'assets must be an object.');
  }
  const allowedAssetNames = new Set<string>(RUNTIME_ASSET_NAMES[expectedRuntime]);
  for (const assetName of Object.keys(value.assets)) {
    if (!allowedAssetNames.has(assetName)) {
      throw manifestError(expectedRuntime, `unknown asset "${assetName}".`);
    }
  }
  for (const requiredAssetName of REQUIRED_RUNTIME_ASSET_NAMES[expectedRuntime]) {
    if (!Object.hasOwn(value.assets, requiredAssetName)) {
      throw manifestError(expectedRuntime, `missing required asset "${requiredAssetName}".`);
    }
  }
  if (expectedRuntime === 'cpp') {
    const cppAssets = value.assets as unknown as BrowserRuntimeAssetsByRuntime['cpp'];
    const hasCompilerBundle = cppAssets.compilerBundle !== undefined;
    const hasCompleteDirectCompiler =
      cppAssets.compilerWasm !== undefined &&
      cppAssets.linkerWasm !== undefined &&
      cppAssets.sysroot !== undefined;
    if (!hasCompilerBundle && !hasCompleteDirectCompiler) {
      throw manifestError(
        expectedRuntime,
        'assets must provide compilerBundle or the complete compilerWasm/linkerWasm/sysroot compiler set.'
      );
    }
  }
  const originPolicy = normalizeOriginPolicy(expectedRuntime, 'originPolicy', value.originPolicy);
  const assetBaseUrl = value.assetBaseUrl === undefined
    ? globalAssetBaseUrl
    : resolveManifestAssetPath(globalAssetBaseUrl, value.assetBaseUrl);
  const assets: Record<string, unknown> = {};
  const assetCollectionNames = new Set<string>(RUNTIME_ASSET_COLLECTION_NAMES[expectedRuntime]);
  for (const assetName of RUNTIME_ASSET_NAMES[expectedRuntime]) {
    const descriptor = (value.assets as Record<string, unknown>)[assetName];
    if (descriptor !== undefined) {
      assets[assetName] = assetCollectionNames.has(assetName)
        ? normalizeAssetDescriptorCollection(
            expectedRuntime,
            assetName,
            descriptor,
            assetBaseUrl,
            originPolicy
          )
        : normalizeAssetDescriptor(
            expectedRuntime,
            assetName,
            descriptor,
            assetBaseUrl,
            originPolicy
      );
    }
  }
  if (expectedRuntime === 'cpp') {
    assertCppCompilerManifestCompatibility(
      assets as unknown as BrowserRuntimeAssetsByRuntime['cpp']
    );
  }
  if (expectedRuntime === 'python') {
    assertPythonDistributionManifestCompatibility(
      assets as unknown as BrowserRuntimeAssetsByRuntime['python']
    );
  }
  const formats = normalizeWorkerAndLoaderFormats(expectedRuntime, value, assets);
  return Object.freeze({
    runtime: expectedRuntime,
    runtimeVersion: value.runtimeVersion,
    protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
    ...(value.assetBaseUrl !== undefined ? { assetBaseUrl } : {}),
    ...(originPolicy ? { originPolicy } : {}),
    ...formats,
    assets: Object.freeze(assets),
  }) as unknown as BrowserRuntimeAssetManifest<Runtime>;
}

export function resolveBrowserRuntimeAssetManifests(options: {
  assetBaseUrl?: string;
  manifests?: BrowserRuntimeAssetManifests;
  provider?: BrowserRuntimeAssetManifestProvider;
} = {}): BrowserRuntimeAssetManifests {
  const assetBaseUrl = options.assetBaseUrl ?? DEFAULT_ASSET_BASE_URL;
  const resolved: BrowserRuntimeAssetManifests = {};
  for (const runtime of BROWSER_RUNTIME_IDS) {
    const explicitManifest = options.manifests?.[runtime] as AnyBrowserRuntimeAssetManifest | undefined;
    const providedManifest = explicitManifest ?? options.provider?.(runtime);
    if (providedManifest !== undefined) {
      (resolved as Record<string, AnyBrowserRuntimeAssetManifest>)[runtime] = normalizeManifest(
        runtime,
        providedManifest as BrowserRuntimeAssetManifest<typeof runtime>,
        assetBaseUrl
      ) as AnyBrowserRuntimeAssetManifest;
    }
  }
  return Object.freeze(resolved);
}

function assertNoAmbiguousLegacyOverrides(
  assets: BrowserRuntimeAssetOverrides,
  manifests: BrowserRuntimeAssetManifests
): void {
  for (const runtime of BROWSER_RUNTIME_IDS) {
    if (!manifests[runtime]) continue;
    const conflictingKey = RUNTIME_LEGACY_ASSET_KEYS[runtime].find((key) => assets[key] !== undefined);
    if (conflictingKey) {
      throw new TypeError(
        `Browser runtime "${runtime}" cannot combine its manifest with legacy asset override "${String(conflictingKey)}".`
      );
    }
  }
}

function manifestAssetUrl(
  manifests: BrowserRuntimeAssetManifests,
  runtime: BrowserRuntimeId,
  assetName: string
): string | undefined {
  const manifest = manifests[runtime] as AnyBrowserRuntimeAssetManifest | undefined;
  const descriptor = (manifest?.assets as Record<string, BrowserRuntimeAssetDescriptor> | undefined)?.[assetName];
  return descriptor?.url;
}

function optionalManifestAssetUrl(
  manifests: BrowserRuntimeAssetManifests,
  runtime: BrowserRuntimeId,
  assetName: string
): string | undefined {
  if (!manifests[runtime]) return undefined;
  return manifestAssetUrl(manifests, runtime, assetName) ?? '';
}

export function resolveBrowserRuntimeAssets(options: {
  assetBaseUrl?: string;
  assets?: BrowserRuntimeAssetOverrides;
} = {}): BrowserRuntimeAssets {
  const assetBaseUrl = options.assetBaseUrl ?? DEFAULT_ASSET_BASE_URL;
  const assets = options.assets ?? {};
  const runtimeManifests = resolveBrowserRuntimeAssetManifests({
    assetBaseUrl,
    manifests: assets.runtimeManifests,
    provider: assets.runtimeAssetProvider,
  });
  assertNoAmbiguousLegacyOverrides(assets, runtimeManifests);
  const cppCompilerIntegrity = mergeCppCompilerIntegrity(
    assets.cppCompilerIntegrity,
    derivedCppCompilerIntegrity(runtimeManifests)
  );

  const resolve = (legacyValue: string | undefined, defaultValue: string, manifestValue?: string): string =>
    manifestValue ?? resolveAssetPath(assetBaseUrl, legacyValue ?? defaultValue);

  return {
    pythonWorker: resolve(
      assets.pythonWorker,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.pythonWorker,
      manifestAssetUrl(runtimeManifests, 'python', 'worker')
    ),
    pythonRuntimeCore: resolve(
      assets.pythonRuntimeCore,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.pythonRuntimeCore,
      manifestAssetUrl(runtimeManifests, 'python', 'runtimeCore')
    ),
    pythonSnippets: resolve(
      assets.pythonSnippets,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.pythonSnippets,
      manifestAssetUrl(runtimeManifests, 'python', 'snippets')
    ),
    javascriptWorker: resolve(
      assets.javascriptWorker,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.javascriptWorker,
      manifestAssetUrl(runtimeManifests, 'javascript', 'worker')
    ),
    javascriptProjectWorker: resolve(
      assets.javascriptProjectWorker,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.javascriptProjectWorker,
      manifestAssetUrl(runtimeManifests, 'javascript', 'projectWorker')
    ),
    javaWorker: resolve(
      assets.javaWorker,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.javaWorker,
      manifestAssetUrl(runtimeManifests, 'java', 'worker')
    ),
    csharpWorker: resolve(
      assets.csharpWorker,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.csharpWorker,
      manifestAssetUrl(runtimeManifests, 'csharp', 'worker')
    ),
    csharpAssetBaseUrl: resolve(
      assets.csharpAssetBaseUrl,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.csharpAssetBaseUrl,
      manifestAssetUrl(runtimeManifests, 'csharp', 'assetBaseUrl')
    ),
    typescriptCompiler: resolve(
      assets.typescriptCompiler,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.typescriptCompiler,
      manifestAssetUrl(runtimeManifests, 'typescript', 'compiler')
    ),
    cppWorker: resolve(
      assets.cppWorker,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.cppWorker,
      manifestAssetUrl(runtimeManifests, 'cpp', 'worker')
    ),
    cppCompilerFrame: resolve(
      assets.cppCompilerFrame,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.cppCompilerFrame,
      manifestAssetUrl(runtimeManifests, 'cpp', 'compilerFrame')
    ),
    cppCompilerWorker: resolve(
      assets.cppCompilerWorker,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.cppCompilerWorker,
      manifestAssetUrl(runtimeManifests, 'cpp', 'compilerWorker')
    ),
    cppCompilerWasm: resolve(
      assets.cppCompilerWasm,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.cppCompilerWasm,
      optionalManifestAssetUrl(runtimeManifests, 'cpp', 'compilerWasm')
    ),
    cppLinkerWasm: resolve(
      assets.cppLinkerWasm,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.cppLinkerWasm,
      optionalManifestAssetUrl(runtimeManifests, 'cpp', 'linkerWasm')
    ),
    cppSysroot: resolve(
      assets.cppSysroot,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.cppSysroot,
      optionalManifestAssetUrl(runtimeManifests, 'cpp', 'sysroot')
    ),
    cppRuntimeHeader: resolve(
      assets.cppRuntimeHeader,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.cppRuntimeHeader,
      manifestAssetUrl(runtimeManifests, 'cpp', 'runtimeHeader')
    ),
    cppCompilerBundle: resolve(
      assets.cppCompilerBundle,
      DEFAULT_BROWSER_RUNTIME_ASSET_RELATIVE_PATHS.cppCompilerBundle,
      optionalManifestAssetUrl(runtimeManifests, 'cpp', 'compilerBundle')
    ),
    ...(cppCompilerIntegrity ? { cppCompilerIntegrity } : {}),
    ...(Object.keys(runtimeManifests).length > 0 ? { runtimeManifests } : {}),
  };
}

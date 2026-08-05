import type {
  AnyBrowserRuntimeAssetManifest,
  BrowserRuntimeAssetDescriptor,
  BrowserRuntimeAssetManifests,
  BrowserRuntimeAssetOriginPolicy,
  BrowserRuntimeId,
} from './runtime-assets';

export interface BrowserRuntimeAssetPreflightOptions {
  fetch?: typeof globalThis.fetch;
  /** Browser page URL used to resolve relative assets and enforce same-origin policies. */
  documentUrl?: string;
}

export interface BrowserRuntimeAssetPreflight {
  preflight(runtime: BrowserRuntimeId, assetNames?: readonly string[]): Promise<void>;
}

interface AssetEntry {
  name: string;
  descriptor: BrowserRuntimeAssetDescriptor;
}

const SUPPORTED_INTEGRITY_ALGORITHMS = Object.freeze({
  sha256: 'SHA-256',
  sha384: 'SHA-384',
  sha512: 'SHA-512',
} as const);
const MAX_UNSIZED_INTEGRITY_BYTES = 256 * 1024 * 1024;

function preflightError(runtime: BrowserRuntimeId, assetName: string, detail: string): Error {
  return new Error(`Browser runtime asset preflight failed for ${runtime}.${assetName}: ${detail}`);
}

function documentUrl(options: BrowserRuntimeAssetPreflightOptions): string | undefined {
  return options.documentUrl ?? (
    typeof globalThis.location?.href === 'string' ? globalThis.location.href : undefined
  );
}

function resolveRuntimeUrl(url: string, baseUrl: string | undefined): URL | undefined {
  try {
    return new URL(url, baseUrl);
  } catch {
    return undefined;
  }
}

function assertRuntimeOriginPolicy(
  runtime: BrowserRuntimeId,
  assetName: string,
  descriptor: BrowserRuntimeAssetDescriptor,
  manifestPolicy: BrowserRuntimeAssetOriginPolicy | undefined,
  pageUrl: string | undefined
): void {
  const policy = descriptor.originPolicy ?? manifestPolicy;
  if (!policy || policy.mode === 'any') return;
  const parsed = resolveRuntimeUrl(descriptor.url, pageUrl);
  if (!parsed) {
    throw preflightError(runtime, assetName, `URL ${JSON.stringify(descriptor.url)} could not be resolved.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw preflightError(runtime, assetName, `origin policy does not permit the ${parsed.protocol} scheme.`);
  }
  if (policy.mode === 'same-origin') {
    if (!pageUrl) {
      if (/^https?:/iu.test(descriptor.url)) {
        throw preflightError(runtime, assetName, 'same-origin could not be verified without a browser document URL.');
      }
      return;
    }
    const expectedOrigin = new URL(pageUrl).origin;
    if (parsed.origin !== expectedOrigin) {
      throw preflightError(
        runtime,
        assetName,
        `origin ${JSON.stringify(parsed.origin)} does not match ${JSON.stringify(expectedOrigin)}.`
      );
    }
    return;
  }
  if (!policy.origins.includes(parsed.origin)) {
    throw preflightError(runtime, assetName, `origin ${JSON.stringify(parsed.origin)} is not allow-listed.`);
  }
}

function descriptorEntries(manifest: AnyBrowserRuntimeAssetManifest): AssetEntry[] {
  const entries: AssetEntry[] = [];
  for (const [name, value] of Object.entries(manifest.assets as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (typeof (value as { url?: unknown }).url === 'string') {
      entries.push({ name, descriptor: value as BrowserRuntimeAssetDescriptor });
      continue;
    }
    for (const [childName, child] of Object.entries(value as Record<string, unknown>)) {
      if (child && typeof child === 'object' && typeof (child as { url?: unknown }).url === 'string') {
        entries.push({ name: `${name}.${childName}`, descriptor: child as BrowserRuntimeAssetDescriptor });
      }
    }
  }
  return entries;
}

function normalizeMediaType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

async function readVerifiedResponseBytes(
  runtime: BrowserRuntimeId,
  assetName: string,
  response: Response,
  declaredSize: number | undefined
): Promise<Uint8Array> {
  const maxBytes = declaredSize ?? MAX_UNSIZED_INTEGRITY_BYTES;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw preflightError(runtime, assetName, `response exceeded the verification limit of ${maxBytes} bytes.`);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw preflightError(runtime, assetName, `response exceeded the verification limit of ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    for (const byte of chunk) binary += String.fromCharCode(byte);
  }
  if (typeof globalThis.btoa !== 'function') {
    throw new Error('base64 encoding is unavailable in this environment');
  }
  return globalThis.btoa(binary);
}

async function assertIntegrity(
  runtime: BrowserRuntimeId,
  assetName: string,
  integrity: string,
  bytes: Uint8Array
): Promise<void> {
  if (!globalThis.crypto?.subtle) {
    throw preflightError(runtime, assetName, 'Web Crypto is required to enforce declared integrity metadata.');
  }
  const candidates = integrity.trim().split(/\s+/u).map((token) => {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/u.exec(token);
    return match ? { algorithm: match[1] as keyof typeof SUPPORTED_INTEGRITY_ALGORITHMS, digest: match[2] } : null;
  }).filter((entry): entry is { algorithm: keyof typeof SUPPORTED_INTEGRITY_ALGORITHMS; digest: string } => entry !== null);
  if (candidates.length === 0) {
    throw preflightError(runtime, assetName, 'integrity must contain a supported sha256, sha384, or sha512 SRI token.');
  }

  const algorithmStrength = { sha256: 1, sha384: 2, sha512: 3 } as const;
  const strongest = Math.max(...candidates.map((candidate) => algorithmStrength[candidate.algorithm]));
  const strongestCandidates = candidates.filter(
    (candidate) => algorithmStrength[candidate.algorithm] === strongest
  );

  const digests = new Map<string, string>();
  for (const candidate of strongestCandidates) {
    let actual = digests.get(candidate.algorithm);
    if (!actual) {
      const digest = await globalThis.crypto.subtle.digest(
        SUPPORTED_INTEGRITY_ALGORITHMS[candidate.algorithm],
        Uint8Array.from(bytes).buffer
      );
      actual = bytesToBase64(new Uint8Array(digest));
      digests.set(candidate.algorithm, actual);
    }
    if (actual === candidate.digest) return;
  }
  throw preflightError(runtime, assetName, 'response bytes did not match the declared integrity metadata.');
}

async function verifyDescriptor(
  runtime: BrowserRuntimeId,
  assetName: string,
  descriptor: BrowserRuntimeAssetDescriptor,
  manifestPolicy: BrowserRuntimeAssetOriginPolicy | undefined,
  options: BrowserRuntimeAssetPreflightOptions
): Promise<void> {
  const pageUrl = documentUrl(options);
  assertRuntimeOriginPolicy(runtime, assetName, descriptor, manifestPolicy, pageUrl);
  const requiresResponseVerification =
    descriptor.integrity !== undefined || descriptor.mediaType !== undefined || descriptor.size !== undefined;
  if (!requiresResponseVerification) return;

  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw preflightError(runtime, assetName, 'fetch is unavailable for declared response metadata.');
  }
  let response: Response;
  try {
    response = await fetchImplementation(descriptor.url, {
      cache: 'force-cache',
      credentials: 'omit',
      redirect: 'error',
      ...(descriptor.integrity ? { integrity: descriptor.integrity } : {}),
    });
  } catch (error) {
    throw preflightError(
      runtime,
      assetName,
      `verification request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok || response.type === 'opaque') {
    throw preflightError(runtime, assetName, `verification request returned HTTP ${response.status}.`);
  }
  if (descriptor.mediaType !== undefined) {
    const actualMediaType = normalizeMediaType(response.headers.get('content-type') ?? '');
    const expectedMediaType = normalizeMediaType(descriptor.mediaType);
    if (actualMediaType !== expectedMediaType) {
      throw preflightError(
        runtime,
        assetName,
        `Content-Type ${JSON.stringify(actualMediaType || '(missing)')} did not match ${JSON.stringify(expectedMediaType)}.`
      );
    }
  }
  if (descriptor.integrity === undefined && descriptor.size === undefined) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }
  const bytes = await readVerifiedResponseBytes(runtime, assetName, response, descriptor.size);
  if (descriptor.size !== undefined && bytes.byteLength !== descriptor.size) {
    throw preflightError(
      runtime,
      assetName,
      `decoded size ${bytes.byteLength} did not match declared size ${descriptor.size}.`
    );
  }
  if (descriptor.integrity !== undefined) {
    await assertIntegrity(runtime, assetName, descriptor.integrity, bytes);
  }
}

export function createBrowserRuntimeAssetPreflight(
  manifests: BrowserRuntimeAssetManifests | undefined,
  options: BrowserRuntimeAssetPreflightOptions = {}
): BrowserRuntimeAssetPreflight {
  const verificationPromises = new Map<string, Promise<void>>();
  return Object.freeze({
    async preflight(runtime: BrowserRuntimeId, assetNames?: readonly string[]): Promise<void> {
      const manifest = manifests?.[runtime] as AnyBrowserRuntimeAssetManifest | undefined;
      if (!manifest) return;
      const selectedNames = assetNames ? new Set(assetNames) : undefined;
      const entries = descriptorEntries(manifest).filter(({ name }) => (
        !selectedNames || selectedNames.has(name) || selectedNames.has(name.split('.', 1)[0] ?? name)
      ));
      await Promise.all(entries.map(({ name, descriptor }) => {
        // Multiple manifest roles may intentionally resolve to one immutable
        // artifact (TraceCC v9r1 uses one reactor for compiler and linker).
        // Cache verification by exact response identity rather than role name
        // so the same large body is not downloaded and hashed twice.
        const cacheKey = [
          runtime,
          descriptor.url,
          descriptor.integrity ?? '',
          descriptor.size ?? '',
          descriptor.mediaType ?? '',
        ].join('\u0000');
        let promise = verificationPromises.get(cacheKey);
        if (!promise) {
          let trackedPromise: Promise<void>;
          trackedPromise = verifyDescriptor(runtime, name, descriptor, manifest.originPolicy, options)
            .then(() => {
              // Without an explicit immutable-delivery attestation, a later
              // preflight must fetch again rather than treating mutable URL
              // bytes as permanently verified.
              if (descriptor.delivery?.mutability !== 'immutable' && verificationPromises.get(cacheKey) === trackedPromise) {
                verificationPromises.delete(cacheKey);
              }
            })
            .catch((error) => {
              // Share concurrent work, but do not permanently brick a runtime
              // after a transient CDN/CORS failure.
              if (verificationPromises.get(cacheKey) === trackedPromise) {
                verificationPromises.delete(cacheKey);
              }
              throw error;
            });
          promise = trackedPromise;
          verificationPromises.set(cacheKey, promise);
        }
        return promise;
      }));
    },
  });
}

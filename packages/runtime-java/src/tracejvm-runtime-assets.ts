import {
  TRACEJVM_RUNTIME_ASSET_RELATIVE_PATH,
  TRACEJVM_RUNTIME_CONTENT_HASH,
  TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR,
  TRACEJVM_RUNTIME_VERSION,
} from './tracejvm-runtime-assets.generated';

export {
  TRACEJVM_RUNTIME_ASSET_RELATIVE_PATH,
  TRACEJVM_RUNTIME_CONTENT_HASH,
  TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR,
  TRACEJVM_RUNTIME_VERSION,
};

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

/**
 * Normalizes an immutable TraceJVM runtime directory used by any browser
 * client. Query strings and fragments are intentionally rejected because the
 * bridge and project clients append fixed runtime-relative paths.
 */
export function normalizeTraceJVMRuntimeAssetBaseUrl(value: string): string {
  const normalized = stripTrailingSlash(value.trim());
  if (!normalized) {
    throw new TypeError('TraceJVM runtime asset base URL must not be empty.');
  }
  if (/[?#]/u.test(normalized)) {
    throw new TypeError(
      'TraceJVM runtime asset base URL must be a directory without a query or fragment.'
    );
  }
  return normalized;
}

/** Resolves the TraceJVM release owned by this Harness version. */
export function resolveBuiltInTraceJVMRuntimeAssetBaseUrl(
  assetBaseUrl = '/workers'
): string {
  const normalized = normalizeTraceJVMRuntimeAssetBaseUrl(assetBaseUrl);
  return `${normalized}/${TRACEJVM_RUNTIME_ASSET_RELATIVE_PATH}`;
}

const verifiedReleaseUrls = new Map<string, Promise<void>>();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof globalThis.btoa !== 'function') {
    throw new Error('TraceJVM release verification requires base64 support.');
  }
  return globalThis.btoa(binary);
}

/** Verifies that an override location serves this Harness's TraceJVM release. */
export function preflightBuiltInTraceJVMRuntimeAssets(
  runtimeAssetBaseUrl: string
): Promise<void> {
  const baseUrl = normalizeTraceJVMRuntimeAssetBaseUrl(runtimeAssetBaseUrl);
  const releaseUrl = `${baseUrl}/release.json`;
  const cached = verifiedReleaseUrls.get(releaseUrl);
  if (cached) return cached;
  const verification = (async () => {
    if (typeof globalThis.fetch !== 'function') {
      throw new Error('TraceJVM release preflight requires fetch.');
    }
    if (!globalThis.crypto?.subtle) {
      throw new Error('TraceJVM release preflight requires Web Crypto.');
    }
    const response = await globalThis.fetch(releaseUrl);
    if (!response.ok) {
      throw new Error(
        `TraceJVM release preflight failed for ${releaseUrl}: HTTP ${response.status}.`
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR.size) {
      throw new Error(
        `TraceJVM release descriptor size mismatch at ${releaseUrl}: expected ` +
          `${TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR.size}, received ${bytes.byteLength}.`
      );
    }
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
    );
    const integrity = `sha256-${bytesToBase64(digest)}`;
    if (integrity !== TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR.integrity) {
      throw new Error(
        `TraceJVM release descriptor integrity mismatch at ${releaseUrl}: expected ` +
          `${TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR.integrity}, received ${integrity}.`
      );
    }
    const descriptor = JSON.parse(new TextDecoder().decode(bytes)) as {
      schema?: string;
      package?: { version?: string };
      contentHash?: string;
      relativePrefix?: string;
    };
    const expectedPrefix =
      `tracejvm/${TRACEJVM_RUNTIME_VERSION}/${TRACEJVM_RUNTIME_CONTENT_HASH}`;
    if (
      descriptor.schema !== 'tracejvm-runtime-release-v2' ||
      descriptor.package?.version !== TRACEJVM_RUNTIME_VERSION ||
      descriptor.contentHash !== TRACEJVM_RUNTIME_CONTENT_HASH ||
      descriptor.relativePrefix !== expectedPrefix
    ) {
      throw new Error(
        `TraceJVM release identity mismatch at ${releaseUrl}: expected ${expectedPrefix}.`
      );
    }
  })();
  verifiedReleaseUrls.set(releaseUrl, verification);
  void verification.catch(() => {
    if (verifiedReleaseUrls.get(releaseUrl) === verification) {
      verifiedReleaseUrls.delete(releaseUrl);
    }
  });
  return verification;
}

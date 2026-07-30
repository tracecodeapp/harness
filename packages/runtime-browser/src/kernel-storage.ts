import type {
  RuntimeFile,
  RuntimeFileEncoding,
  RuntimeDirectory,
  RuntimeProjectSnapshot,
  RuntimeSymlink,
  RuntimeWorkspace,
  RuntimeWorkspaceUnsubscribe,
} from '@tracecode/runtime-contracts';
import { normalizeRuntimeProjectPath } from '@tracecode/runtime-contracts';

const STORAGE_VERSION = 1;
const LEGACY_ENCRYPTED_STORAGE_VERSION = 2;
const ENCRYPTED_STORAGE_VERSION = 3;
const MAX_STORAGE_OPTION_LENGTH = 256;
const STORAGE_ENCRYPTION_ALGORITHM = 'AES-GCM';
const STORAGE_ENCRYPTION_IV_BYTES = 12;
const PERSIST_DEBOUNCE_MS = 250;
const PERSIST_MAX_STALENESS_MS = 2000;
const storageTextEncoder = new TextEncoder();
const storageTextDecoder = new TextDecoder();

export interface BrowserKernelStorageSnapshot {
  version: 1;
  savedAt: string;
  snapshot: RuntimeProjectSnapshot;
}

interface BrowserKernelStorageEncryptedRecordV2 {
  version: 2;
  savedAt: string;
  encrypted: {
    algorithm: 'AES-GCM';
    iv: string;
    ciphertext: string;
    keyId?: string;
  };
}

interface BrowserKernelStorageEncryptedRecord {
  version: 3;
  savedAt: string;
  revision: number;
  encrypted: {
    algorithm: 'AES-GCM';
    iv: string;
    ciphertext: string;
    keyId?: string;
  };
}

type BrowserKernelStorageIndexedDbRecord =
  | BrowserKernelStorageSnapshot
  | BrowserKernelStorageEncryptedRecordV2
  | BrowserKernelStorageEncryptedRecord;

interface BrowserKernelStorageEncryptionContext {
  databaseName: string;
  storeName: string;
  key: string;
  keyId?: string;
}

/**
 * Optional monotonic authority for replay-sensitive persistence. Its state must
 * live outside the same-origin IndexedDB being protected (for example, a host
 * service or hardware-backed store). nextRevision must atomically reserve a
 * strictly increasing value; assertCurrentRevision must reject stale values.
 */
export interface IndexedDbKernelStorageRevisionAuthority {
  trustedExternalState: true;
  nextRevision(): number | Promise<number>;
  assertCurrentRevision(revision: number): void | Promise<void>;
}

export interface BrowserKernelStorage {
  load(): Promise<BrowserKernelStorageSnapshot | null>;
  save(snapshot: RuntimeProjectSnapshot): Promise<void>;
  clear?(): Promise<void>;
  flush?(): Promise<void>;
}

export interface IndexedDbKernelStorageOptions {
  key: string;
  databaseName: string;
  storeName: string;
  trustedSameOriginPersistence: true;
  encryptionKey: CryptoKey;
  keyId?: string;
  allowPlaintextSnapshotMigration?: true;
  allowLegacyEncryptedSnapshotMigration?: true;
  revisionAuthority?: IndexedDbKernelStorageRevisionAuthority;
}

export interface BrowserKernelStorageBinding {
  flush(): Promise<void>;
  dispose(): void;
}

export interface BrowserKernelStorageBindingOptions {
  onError?: (error: Error) => void;
}

export function createIndexedDbKernelStorage(options: IndexedDbKernelStorageOptions): BrowserKernelStorage {
  if (options.trustedSameOriginPersistence !== true) {
    throw new Error(
      'IndexedDB kernel storage is same-origin browser persistence and requires trustedSameOriginPersistence: true.'
    );
  }
  if (!options.encryptionKey) {
    throw new Error(
      'IndexedDB kernel storage persists workspace snapshots and requires an AES-GCM encryptionKey that is not stored in same-origin browser storage.'
    );
  }
  if (options.revisionAuthority && (
    options.revisionAuthority.trustedExternalState !== true ||
    typeof options.revisionAuthority.nextRevision !== 'function' ||
    typeof options.revisionAuthority.assertCurrentRevision !== 'function'
  )) {
    throw new Error(
      'IndexedDB kernel storage revisionAuthority must use trusted external state and implement nextRevision/assertCurrentRevision.'
    );
  }
  const databaseName = normalizeStorageOption(options.databaseName, 'IndexedDB kernel storage databaseName');
  const storeName = normalizeStorageOption(options.storeName, 'IndexedDB kernel storage storeName');
  const key = normalizeStorageOption(options.key, 'IndexedDB kernel storage key');
  const keyId = options.keyId === undefined
    ? undefined
    : normalizeStorageOption(options.keyId, 'IndexedDB kernel storage keyId');
  const encryptionKey = options.encryptionKey;
  const encryptionContext: BrowserKernelStorageEncryptionContext = {
    databaseName,
    storeName,
    key,
    ...(keyId ? { keyId } : {}),
  };

  let dbPromise: Promise<IDBDatabase> | null = null;
  let pendingWrite: Promise<void> = Promise.resolve();
  let lastRevision = 0;

  const openDb = (): Promise<IDBDatabase> => {
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('IndexedDB kernel storage is not available in this browser.'));
    }
    dbPromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, STORAGE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB kernel storage.'));
      request.onblocked = () => reject(new Error('IndexedDB kernel storage upgrade was blocked.'));
    });
    return dbPromise;
  };

  const request = async <Result>(
    mode: IDBTransactionMode,
    createRequest: (store: IDBObjectStore) => IDBRequest<Result>
  ): Promise<Result> => {
    const db = await openDb();
    // Queue the first request in the same synchronous continuation that opens
    // the transaction. WebKit aggressively auto-commits an IndexedDB
    // transaction when control returns to the event loop without a pending
    // request, so callers must finish encryption and revision allocation
    // before reaching this boundary.
    const store = db.transaction(storeName, mode).objectStore(storeName);
    return idbRequest(createRequest(store));
  };

  return {
    async load(): Promise<BrowserKernelStorageSnapshot | null> {
      const value = await request<BrowserKernelStorageIndexedDbRecord | undefined>(
        'readonly',
        (store) => store.get(key)
      );
      if (!value) return null;
      if (isEncryptedStorageRecord(value)) {
        const snapshot = await decryptStorageSnapshot(value, encryptionKey, encryptionContext);
        await options.revisionAuthority?.assertCurrentRevision(value.revision);
        lastRevision = Math.max(lastRevision, value.revision);
        return snapshot;
      }
      if (isLegacyEncryptedStorageRecord(value)) {
        if (options.allowLegacyEncryptedSnapshotMigration === true) {
          return decryptLegacyStorageSnapshot(value, encryptionKey, keyId);
        }
        throw new Error(
          'IndexedDB kernel storage contains a legacy encrypted workspace snapshot without namespace authentication; enable allowLegacyEncryptedSnapshotMigration to load and re-save it.'
        );
      }
      if (isRecord(value) && value.version === STORAGE_VERSION) {
        if (options.allowPlaintextSnapshotMigration === true) {
          return value as BrowserKernelStorageSnapshot;
        }
        throw new Error(
          'IndexedDB kernel storage contains a plaintext workspace snapshot; clear it or enable allowPlaintextSnapshotMigration to re-save it encrypted.'
        );
      }
      throw new Error('IndexedDB kernel storage record is malformed.');
    },
    async save(snapshot: RuntimeProjectSnapshot): Promise<void> {
      pendingWrite = pendingWrite.catch(() => undefined).then(async () => {
        const savedAt = new Date().toISOString();
        const revision = await nextStorageRevision(options.revisionAuthority, lastRevision);
        const record = await encryptStorageSnapshot({
          version: STORAGE_VERSION,
          savedAt,
          snapshot,
        }, encryptionKey, encryptionContext, revision);
        await request('readwrite', (store) => store.put(record, key));
        lastRevision = revision;
      });
      await pendingWrite;
    },
    async clear(): Promise<void> {
      pendingWrite = pendingWrite.catch(() => undefined).then(async () => {
        // Reserve a tombstone revision before deleting the local record. With
        // an external authority this makes a subsequently restored ciphertext
        // stale instead of allowing a cleared workspace to be replayed.
        const revision = await nextStorageRevision(options.revisionAuthority, lastRevision);
        await request('readwrite', (store) => store.delete(key));
        lastRevision = revision;
      });
      await pendingWrite;
    },
    async flush(): Promise<void> {
      await pendingWrite;
    },
  };
}

function getStorageCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== 'function') {
    throw new Error('Encrypted IndexedDB kernel storage requires Web Crypto with AES-GCM support.');
  }
  return globalThis.crypto;
}

function isEncryptedStorageRecord(value: unknown): value is BrowserKernelStorageEncryptedRecord {
  return (
    isRecord(value) &&
    value.version === ENCRYPTED_STORAGE_VERSION &&
    typeof value.savedAt === 'string' &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) > 0 &&
    isRecord(value.encrypted) &&
    value.encrypted.algorithm === STORAGE_ENCRYPTION_ALGORITHM &&
    typeof value.encrypted.iv === 'string' &&
    typeof value.encrypted.ciphertext === 'string'
  );
}

function isLegacyEncryptedStorageRecord(value: unknown): value is BrowserKernelStorageEncryptedRecordV2 {
  return (
    isRecord(value) &&
    value.version === LEGACY_ENCRYPTED_STORAGE_VERSION &&
    typeof value.savedAt === 'string' &&
    isRecord(value.encrypted) &&
    value.encrypted.algorithm === STORAGE_ENCRYPTION_ALGORITHM &&
    typeof value.encrypted.iv === 'string' &&
    typeof value.encrypted.ciphertext === 'string'
  );
}

function storageEncryptionAdditionalData(
  savedAt: string,
  context: BrowserKernelStorageEncryptionContext,
  revision: number
): Uint8Array<ArrayBuffer> {
  return storageTextEncoder.encode(JSON.stringify({
    // Persisted authenticated-data schema. Keep this stable across package renames
    // so records written by earlier harness versions remain decryptable.
    schema: '@tracecode/harness-browser/kernel-storage/aes-gcm-v3',
    version: ENCRYPTED_STORAGE_VERSION,
    databaseName: context.databaseName,
    storeName: context.storeName,
    key: context.key,
    keyId: context.keyId ?? null,
    savedAt,
    revision,
  }));
}

async function nextStorageRevision(
  authority: IndexedDbKernelStorageRevisionAuthority | undefined,
  previousRevision: number
): Promise<number> {
  const revision = authority ? await authority.nextRevision() : previousRevision + 1;
  if (!Number.isSafeInteger(revision) || revision <= previousRevision) {
    throw new Error(
      `IndexedDB kernel storage revision must be a safe integer greater than ${previousRevision}; received ${String(revision)}.`
    );
  }
  return revision;
}

async function encryptStorageSnapshot(
  snapshot: BrowserKernelStorageSnapshot,
  encryptionKey: CryptoKey,
  context: BrowserKernelStorageEncryptionContext,
  revision: number
): Promise<BrowserKernelStorageEncryptedRecord> {
  const storageCrypto = getStorageCrypto();
  const iv = new Uint8Array(STORAGE_ENCRYPTION_IV_BYTES);
  storageCrypto.getRandomValues(iv);
  const plaintext = storageTextEncoder.encode(JSON.stringify(snapshot));
  const ciphertext = new Uint8Array(await storageCrypto.subtle.encrypt(
    {
      name: STORAGE_ENCRYPTION_ALGORITHM,
      iv,
      additionalData: storageEncryptionAdditionalData(snapshot.savedAt, context, revision),
    },
    encryptionKey,
    plaintext
  ));
  return {
    version: ENCRYPTED_STORAGE_VERSION,
    savedAt: snapshot.savedAt,
    revision,
    encrypted: {
      algorithm: STORAGE_ENCRYPTION_ALGORITHM,
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext),
      ...(context.keyId ? { keyId: context.keyId } : {}),
    },
  };
}

async function decryptStorageSnapshot(
  record: BrowserKernelStorageEncryptedRecord,
  encryptionKey: CryptoKey,
  context: BrowserKernelStorageEncryptionContext
): Promise<BrowserKernelStorageSnapshot> {
  try {
    if (record.encrypted.keyId !== context.keyId) {
      throw new Error('encrypted snapshot keyId does not match the configured keyId');
    }
    const storageCrypto = getStorageCrypto();
    const iv = base64ToBytes(record.encrypted.iv);
    if (iv.byteLength !== STORAGE_ENCRYPTION_IV_BYTES) {
      throw new Error(`encrypted snapshot IV must be ${STORAGE_ENCRYPTION_IV_BYTES} bytes`);
    }
    const ciphertext = base64ToBytes(record.encrypted.ciphertext);
    const plaintext = await storageCrypto.subtle.decrypt(
      {
        name: STORAGE_ENCRYPTION_ALGORITHM,
        iv,
        additionalData: storageEncryptionAdditionalData(record.savedAt, context, record.revision),
      },
      encryptionKey,
      ciphertext
    );
    const parsed = JSON.parse(storageTextDecoder.decode(plaintext)) as unknown;
    if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION || !isRecord(parsed.snapshot)) {
      throw new Error('decrypted snapshot is malformed');
    }
    if (parsed.savedAt !== record.savedAt) {
      throw new Error('encrypted snapshot timestamp does not match its authenticated record');
    }
    return parsed as unknown as BrowserKernelStorageSnapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to decrypt IndexedDB kernel storage snapshot: ${message}`);
  }
}

async function decryptLegacyStorageSnapshot(
  record: BrowserKernelStorageEncryptedRecordV2,
  encryptionKey: CryptoKey,
  expectedKeyId: string | undefined
): Promise<BrowserKernelStorageSnapshot> {
  try {
    if (record.encrypted.keyId !== expectedKeyId) {
      throw new Error('legacy encrypted snapshot keyId does not match the configured keyId');
    }
    const storageCrypto = getStorageCrypto();
    const iv = base64ToBytes(record.encrypted.iv);
    const ciphertext = base64ToBytes(record.encrypted.ciphertext);
    const plaintext = await storageCrypto.subtle.decrypt(
      { name: STORAGE_ENCRYPTION_ALGORITHM, iv },
      encryptionKey,
      ciphertext
    );
    const parsed = JSON.parse(storageTextDecoder.decode(plaintext)) as unknown;
    if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION || !isRecord(parsed.snapshot)) {
      throw new Error('decrypted legacy snapshot is malformed');
    }
    return parsed as unknown as BrowserKernelStorageSnapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to decrypt legacy IndexedDB kernel storage snapshot: ${message}`);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    const chunk = bytes.subarray(offset, offset + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function hydrateBrowserKernelStorage(
  storage: BrowserKernelStorage | undefined
): Promise<RuntimeProjectSnapshot | null> {
  if (!storage) return null;
  const stored = await storage.load();
  if (!stored) return null;
  return normalizeStoredSnapshot(stored);
}

export async function persistInitialBrowserKernelSnapshot(
  workspace: RuntimeWorkspace,
  storage: BrowserKernelStorage | undefined
): Promise<void> {
  if (!storage) return;
  await storage.save(await workspace.snapshot());
}

export function bindBrowserKernelStorage(
  workspace: RuntimeWorkspace,
  storage: BrowserKernelStorage | undefined,
  options: BrowserKernelStorageBindingOptions = {}
): BrowserKernelStorageBinding {
  if (!storage) {
    return {
      flush: async () => undefined,
      dispose: () => undefined,
    };
  }

  let pendingPersist: Promise<void> = Promise.resolve();
  let persistQueued = false;
  let dirtyRevision = 0;
  let persistedRevision = 0;
  let lastPersistError: Error | null = null;
  let lastCompletedPersistAt = Date.now();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const reportError = (error: unknown): Error => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    lastPersistError = normalized;
    try {
      options.onError?.(normalized);
    } catch {
      // A host observer must not replace the persistence failure being reported.
    }
    return normalized;
  };

  const cancelDebounceTimer = (): void => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const queuePersist = (): void => {
    if (persistQueued) return;
    persistQueued = true;
    pendingPersist = pendingPersist
      .then(async () => {
        while (persistedRevision < dirtyRevision) {
          const revision = dirtyRevision;
          try {
            const snapshot: RuntimeProjectSnapshot = await workspace.snapshot();
            await storage.save(snapshot);
            persistedRevision = revision;
            lastPersistError = null;
            lastCompletedPersistAt = Date.now();
          } catch (error) {
            reportError(error);
            return;
          }
        }
      })
      .catch((error) => {
        // Keep background persistence promises handled. flush() rethrows the
        // recorded error while dirty state remains pending for a later retry.
        reportError(error);
      })
      .finally(() => {
        persistQueued = false;
      });
  };

  const schedulePersist = (): void => {
    cancelDebounceTimer();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (persistedRevision < dirtyRevision) queuePersist();
    }, PERSIST_DEBOUNCE_MS);
  };

  const unsubscribe: RuntimeWorkspaceUnsubscribe = workspace.kernel.watchMutations(() => {
    dirtyRevision += 1;
    if (Date.now() - lastCompletedPersistAt >= PERSIST_MAX_STALENESS_MS) {
      cancelDebounceTimer();
      queuePersist();
      return;
    }
    schedulePersist();
  });

  return {
    async flush(): Promise<void> {
      cancelDebounceTimer();
      if (persistedRevision < dirtyRevision) queuePersist();
      await pendingPersist;
      if (persistedRevision < dirtyRevision) {
        throw lastPersistError ?? new Error('Browser kernel storage did not persist the latest workspace revision.');
      }
      try {
        await storage.flush?.();
      } catch (error) {
        throw reportError(error);
      }
    },
    dispose(): void {
      cancelDebounceTimer();
      if (persistedRevision < dirtyRevision) queuePersist();
      unsubscribe();
    },
  };
}

function idbRequest<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB kernel storage request failed.'));
  });
}

function normalizeStorageOption(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  if (trimmed.length > MAX_STORAGE_OPTION_LENGTH) {
    throw new Error(`${label} must be ${MAX_STORAGE_OPTION_LENGTH} characters or fewer.`);
  }
  if (/[\0\r\n]/.test(trimmed)) throw new Error(`${label} must not contain control characters.`);
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeStoredSnapshot(stored: BrowserKernelStorageSnapshot): RuntimeProjectSnapshot {
  if (!isRecord(stored) || stored.version !== STORAGE_VERSION || !isRecord(stored.snapshot)) {
    throw new Error('IndexedDB kernel storage snapshot is malformed.');
  }
  const snapshot = stored.snapshot;
  if (!Array.isArray(snapshot.files)) {
    throw new Error('IndexedDB kernel storage snapshot files must be an array.');
  }

  const seenFiles = new Set<string>();
  const files = snapshot.files.map((file, index) => {
    const normalized = normalizeStoredFile(file, `IndexedDB kernel storage snapshot files[${index}]`);
    if (seenFiles.has(normalized.path)) {
      throw new Error(`IndexedDB kernel storage snapshot contains duplicate file path: ${normalized.path}`);
    }
    seenFiles.add(normalized.path);
    return normalized;
  });

  let symlinks: RuntimeSymlink[] | undefined;
  if (snapshot.symlinks !== undefined) {
    if (!Array.isArray(snapshot.symlinks)) {
      throw new Error('IndexedDB kernel storage snapshot symlinks must be an array.');
    }
    const seenSymlinks = new Set<string>();
    symlinks = snapshot.symlinks.map((symlink, index) => {
      const normalized = normalizeStoredSymlink(symlink, `IndexedDB kernel storage snapshot symlinks[${index}]`);
      if (seenFiles.has(normalized.path) || seenSymlinks.has(normalized.path)) {
        throw new Error(`IndexedDB kernel storage snapshot contains duplicate entry path: ${normalized.path}`);
      }
      seenSymlinks.add(normalized.path);
      return normalized;
    }).sort((left, right) => left.path.localeCompare(right.path));
  }

  let directories: string[] | undefined;
  const seenDirectories = new Set<string>();
  if (snapshot.directories !== undefined) {
    if (!Array.isArray(snapshot.directories)) {
      throw new Error('IndexedDB kernel storage snapshot directories must be an array.');
    }
    directories = snapshot.directories.map((directory, index) => {
      if (typeof directory !== 'string') {
        throw new Error(`IndexedDB kernel storage snapshot directories[${index}] must be a string.`);
      }
      const normalized = normalizeRuntimeProjectPath(directory);
      if (seenDirectories.has(normalized)) {
        throw new Error(`IndexedDB kernel storage snapshot contains duplicate directory path: ${normalized}`);
      }
      if (seenFiles.has(normalized) || symlinks?.some((symlink) => symlink.path === normalized)) {
        throw new Error(`IndexedDB kernel storage snapshot contains conflicting entry path: ${normalized}`);
      }
      seenDirectories.add(normalized);
      return normalized;
    }).sort((left, right) => left.localeCompare(right));
  }

  let directoryMetadata: RuntimeDirectory[] | undefined;
  if (snapshot.directoryMetadata !== undefined) {
    if (!Array.isArray(snapshot.directoryMetadata)) {
      throw new Error('IndexedDB kernel storage snapshot directoryMetadata must be an array.');
    }
    const seenDirectoryMetadata = new Set<string>();
    directoryMetadata = snapshot.directoryMetadata.map((directory, index) => {
      const normalized = normalizeStoredDirectory(directory, `IndexedDB kernel storage snapshot directoryMetadata[${index}]`);
      if (seenDirectoryMetadata.has(normalized.path)) {
        throw new Error(`IndexedDB kernel storage snapshot contains duplicate directory metadata path: ${normalized.path}`);
      }
      if (!seenDirectories.has(normalized.path)) {
        throw new Error(`IndexedDB kernel storage snapshot directory metadata references missing directory path: ${normalized.path}`);
      }
      seenDirectoryMetadata.add(normalized.path);
      return normalized;
    }).sort((left, right) => left.path.localeCompare(right.path));
  }

  let entrypoint: string | undefined;
  if (snapshot.entrypoint !== undefined) {
    if (typeof snapshot.entrypoint !== 'string') {
      throw new Error('IndexedDB kernel storage snapshot entrypoint must be a string.');
    }
    entrypoint = normalizeRuntimeProjectPath(snapshot.entrypoint);
  }

  return {
    files,
    ...(symlinks && symlinks.length > 0 ? { symlinks } : {}),
    ...(directories && directories.length > 0 ? { directories } : {}),
    ...(directoryMetadata && directoryMetadata.length > 0 ? { directoryMetadata } : {}),
    ...(entrypoint ? { entrypoint } : {}),
  };
}

function normalizeStoredDirectory(value: unknown, label: string): RuntimeDirectory {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (typeof value.path !== 'string') throw new Error(`${label}.path must be a string.`);
  if (value.mode !== undefined && (!Number.isInteger(value.mode) || (value.mode as number) < 0 || (value.mode as number) > 0o7777)) {
    throw new Error(`${label}.mode must be permission bits.`);
  }
  for (const field of ['atimeMs', 'mtimeMs'] as const) {
    const timestamp = value[field];
    if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0)) {
      throw new Error(`${label}.${field} must be a non-negative finite timestamp.`);
    }
  }
  return {
    path: normalizeRuntimeProjectPath(value.path),
    ...(value.mode !== undefined ? { mode: value.mode as number } : {}),
    ...(value.atimeMs !== undefined ? { atimeMs: value.atimeMs as number } : {}),
    ...(value.mtimeMs !== undefined ? { mtimeMs: value.mtimeMs as number } : {}),
  };
}

function normalizeStoredSymlink(value: unknown, label: string): RuntimeSymlink {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (typeof value.path !== 'string') throw new Error(`${label}.path must be a string.`);
  if (value.symlink !== true) throw new Error(`${label}.symlink must be true.`);
  if (typeof value.target !== 'string' || value.target.length === 0 || value.target.includes('\0')) {
    throw new Error(`${label}.target must be a non-empty string without NUL bytes.`);
  }
  return {
    path: normalizeRuntimeProjectPath(value.path),
    symlink: true,
    target: value.target,
  };
}

function normalizeStoredFile(value: unknown, label: string): RuntimeFile {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (typeof value.path !== 'string') throw new Error(`${label}.path must be a string.`);
  if (typeof value.contents !== 'string') throw new Error(`${label}.contents must be a string.`);
  const path = normalizeRuntimeProjectPath(value.path);
  if (value.encoding !== undefined && value.encoding !== 'utf8' && value.encoding !== 'base64') {
    throw new Error(`${label}.encoding must be "utf8" or "base64".`);
  }
  if (value.mode !== undefined && (!Number.isInteger(value.mode) || (value.mode as number) < 0 || (value.mode as number) > 0o7777)) {
    throw new Error(`${label}.mode must be permission bits.`);
  }
  for (const field of ['atimeMs', 'mtimeMs'] as const) {
    const timestamp = value[field];
    if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0)) {
      throw new Error(`${label}.${field} must be a non-negative finite timestamp.`);
    }
  }
  return {
    path,
    contents: value.contents,
    ...(value.encoding
      ? { encoding: value.encoding as RuntimeFileEncoding }
      : {}),
    ...(value.mode !== undefined ? { mode: value.mode as number } : {}),
    ...(value.atimeMs !== undefined ? { atimeMs: value.atimeMs as number } : {}),
    ...(value.mtimeMs !== undefined ? { mtimeMs: value.mtimeMs as number } : {}),
  };
}

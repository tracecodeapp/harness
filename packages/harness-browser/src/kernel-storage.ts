import type {
  RuntimeFile,
  RuntimeProjectSnapshot,
  RuntimeWorkspace,
  RuntimeWorkspaceUnsubscribe,
} from '../../harness-core/src/runtime-project';
import { normalizeRuntimeProjectPath } from '../../harness-project/src/index';

const STORAGE_VERSION = 1;
const MAX_STORAGE_OPTION_LENGTH = 256;

export interface BrowserKernelStorageSnapshot {
  version: 1;
  savedAt: string;
  snapshot: RuntimeProjectSnapshot;
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
}

export interface BrowserKernelStorageBinding {
  flush(): Promise<void>;
  dispose(): void;
}

export function createIndexedDbKernelStorage(options: IndexedDbKernelStorageOptions): BrowserKernelStorage {
  if (options.trustedSameOriginPersistence !== true) {
    throw new Error(
      'IndexedDB kernel storage is same-origin browser persistence and requires trustedSameOriginPersistence: true.'
    );
  }
  const databaseName = normalizeStorageOption(options.databaseName, 'IndexedDB kernel storage databaseName');
  const storeName = normalizeStorageOption(options.storeName, 'IndexedDB kernel storage storeName');
  const key = normalizeStorageOption(options.key, 'IndexedDB kernel storage key');

  let dbPromise: Promise<IDBDatabase> | null = null;
  let pendingWrite: Promise<void> = Promise.resolve();

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

  const transaction = async (mode: IDBTransactionMode): Promise<IDBObjectStore> => {
    const db = await openDb();
    return db.transaction(storeName, mode).objectStore(storeName);
  };

  return {
    async load(): Promise<BrowserKernelStorageSnapshot | null> {
      const store = await transaction('readonly');
      return idbRequest<BrowserKernelStorageSnapshot | undefined>(store.get(key)).then((value) => value ?? null);
    },
    async save(snapshot: RuntimeProjectSnapshot): Promise<void> {
      pendingWrite = pendingWrite.then(async () => {
        const store = await transaction('readwrite');
        await idbRequest(
          store.put(
            {
              version: STORAGE_VERSION,
              savedAt: new Date().toISOString(),
              snapshot,
            } satisfies BrowserKernelStorageSnapshot,
            key
          )
        );
      });
      await pendingWrite;
    },
    async clear(): Promise<void> {
      pendingWrite = pendingWrite.then(async () => {
        const store = await transaction('readwrite');
        await idbRequest(store.delete(key));
      });
      await pendingWrite;
    },
    async flush(): Promise<void> {
      await pendingWrite;
    },
  };
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
  storage: BrowserKernelStorage | undefined
): BrowserKernelStorageBinding {
  if (!storage) {
    return {
      flush: async () => undefined,
      dispose: () => undefined,
    };
  }

  let pendingPersist: Promise<void> = Promise.resolve();
  const persist = (): void => {
    pendingPersist = pendingPersist
      .catch(() => undefined)
      .then(async () => {
        await storage.save(await workspace.snapshot());
      });
  };

  const unsubscribe: RuntimeWorkspaceUnsubscribe = workspace.watch((event) => {
    if (event.type === 'file-change') persist();
  });

  return {
    async flush(): Promise<void> {
      await pendingPersist;
      await storage.flush?.();
    },
    dispose(): void {
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

  let directories: string[] | undefined;
  if (snapshot.directories !== undefined) {
    if (!Array.isArray(snapshot.directories)) {
      throw new Error('IndexedDB kernel storage snapshot directories must be an array.');
    }
    directories = [...new Set(snapshot.directories.map((directory, index) => {
      if (typeof directory !== 'string') {
        throw new Error(`IndexedDB kernel storage snapshot directories[${index}] must be a string.`);
      }
      return normalizeRuntimeProjectPath(directory);
    }))].sort((left, right) => left.localeCompare(right));
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
    ...(directories && directories.length > 0 ? { directories } : {}),
    ...(entrypoint ? { entrypoint } : {}),
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
  return {
    path,
    contents: value.contents,
    ...(value.encoding ? { encoding: value.encoding } : {}),
  };
}

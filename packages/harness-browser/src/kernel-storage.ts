import type {
  RuntimeProjectSnapshot,
  RuntimeWorkspace,
  RuntimeWorkspaceUnsubscribe,
} from '../../harness-core/src/runtime-project';

const DEFAULT_INDEXED_DB_NAME = 'tracecode-kernel';
const DEFAULT_INDEXED_DB_STORE = 'workspaces';
const STORAGE_VERSION = 1;

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
  databaseName?: string;
  storeName?: string;
}

export interface BrowserKernelStorageBinding {
  flush(): Promise<void>;
  dispose(): void;
}

export function createIndexedDbKernelStorage(options: IndexedDbKernelStorageOptions): BrowserKernelStorage {
  const databaseName = options.databaseName ?? DEFAULT_INDEXED_DB_NAME;
  const storeName = options.storeName ?? DEFAULT_INDEXED_DB_STORE;
  const key = options.key.trim();
  if (!key) throw new Error('IndexedDB kernel storage key is required.');

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
  return (await storage.load())?.snapshot ?? null;
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

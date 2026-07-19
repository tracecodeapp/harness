import { createIndexedDbKernelStorage } from '../../packages/harness-browser/src/kernel-storage';

declare global {
  var runKernelStorageBrowserTest: (() => Promise<{
    firstLoad: unknown;
    secondLoad: unknown;
    afterClear: unknown;
    revisions: number[];
  }>) | undefined;
}

globalThis.runKernelStorageBrowserTest = async () => {
  const encryptionKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const revisions: number[] = [];
  const storage = createIndexedDbKernelStorage({
    key: 'workspace',
    databaseName: `tracecode-kernel-storage-${crypto.randomUUID()}`,
    storeName: 'workspaces',
    trustedSameOriginPersistence: true,
    encryptionKey,
    revisionAuthority: {
      trustedExternalState: true,
      async nextRevision() {
        // Exercise the WebKit failure boundary explicitly. An IndexedDB
        // transaction opened before this await will be inactive by the time
        // the encrypted record is ready to write.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const revision = revisions.length + 1;
        revisions.push(revision);
        return revision;
      },
      async assertCurrentRevision(revision) {
        await Promise.resolve();
        if (revision !== revisions.at(-1)) {
          throw new Error(`stale revision ${revision}`);
        }
      },
    },
  });

  await storage.save({
    files: [{ path: 'README.md', contents: '# First\n' }],
    entrypoint: 'README.md',
  });
  const firstLoad = await storage.load();

  await storage.save({
    files: [
      { path: 'README.md', contents: '# Second\n' },
      { path: 'src/index.js', contents: 'console.log("ready")\n' },
    ],
    directories: ['src'],
    entrypoint: 'src/index.js',
  });
  await storage.flush?.();
  const secondLoad = await storage.load();

  await storage.clear?.();
  const afterClear = await storage.load();
  return { firstLoad, secondLoad, afterClear, revisions };
};

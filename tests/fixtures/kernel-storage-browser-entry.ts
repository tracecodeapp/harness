import { createIndexedDbKernelStorage } from '../../packages/runtime-browser/src/kernel-storage';

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

// The test controller retains key material across navigation; the app never
// writes the encryption key into same-origin persistence.
import { createRuntimeWorkspace } from '../../packages/tracekernel/src/workspace/index';
import { hydrateBrowserKernelStorage } from '../../packages/runtime-browser/src/kernel-storage';

declare global {
  var runExecutableStorageBrowserTest: ((input: {
    databaseName: string; keyBytes: number[]; seed: boolean;
  }) => Promise<{ script: number; binary: number; mode?: number }>) | undefined;
}

globalThis.runExecutableStorageBrowserTest = async ({ databaseName, keyBytes, seed }) => {
  const encryptionKey = await crypto.subtle.importKey('raw', new Uint8Array(keyBytes), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const storage = createIndexedDbKernelStorage({
    databaseName, storeName: 'workspaces', key: 'executable',
    trustedSameOriginPersistence: true, encryptionKey,
  });
  const binary = btoa(String.fromCharCode(...[
    0,97,115,109,1,0,0,0, 1,4,1,96,0,0, 3,2,1,0, 5,3,1,0,1,
    7,19,2,6,109,101,109,111,114,121,2,0,6,95,115,116,97,114,116,0,0,
    10,4,1,2,0,11,
  ]));
  const snapshot = seed ? null : await hydrateBrowserKernelStorage(storage);
  if (!seed && !snapshot) throw new Error('Expected encrypted persisted executable snapshot');
  const workspace = await createRuntimeWorkspace({
    ...(snapshot ?? { files: [{ path: 'script.sh', contents: '#!/bin/bash\necho restored\n', mode: 0o755 }] }),
    cppRunner: async (request) => request.source === 'compile'
      ? { stdout: '', stderr: '', exitCode: 0, files: [{ path: 'app', contents: binary, encoding: 'base64' }] }
      : { stdout: 'compiled-restored\n', stderr: '', exitCode: 0 },
  });
  try {
    if (seed) await workspace.runCommand('clang main.c -o app');
    const script = await workspace.runCommand('./script.sh');
    const executable = await workspace.runCommand('./app');
    if (script.stdout !== 'restored\n' || executable.stdout !== 'compiled-restored\n') {
      throw new Error(`Executable reload failed: ${JSON.stringify({ script, executable })}`);
    }
    const current = await workspace.snapshot();
    if (seed) { await storage.save(current); await storage.flush?.(); }
    const mode = current.files.find(file => file.path === 'app')?.mode;
    return { script: script.exitCode, binary: executable.exitCode, mode };
  } finally { workspace.dispose(); }
};

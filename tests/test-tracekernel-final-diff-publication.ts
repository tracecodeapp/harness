import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { TraceKernelFileSystem } from '../packages/tracekernel/src/vfs';
import { TraceKernelBackingFileSystem } from '../packages/tracekernel/src/workspace/tkfs-backing-filesystem';
import { ProcessAuthority } from '../packages/tracekernel/src/workspace/process-authority';

const fs = await Effect.runPromise(TraceKernelFileSystem.make());
const backing = new TraceKernelBackingFileSystem(fs);
try {
  await backing.writeFile('/workspace/file', 'old');
  await backing.link('/workspace/file', '/workspace/hard');
  const opened = await Effect.runPromise(fs.prepareOpen('/workspace/file', '/', { access: 'read-write' }));
  await backing.transaction(async (staged) => {
    await staged.writeFile('/workspace/file', 'published');
    await staged.mkdir('/workspace/new');
  });
  assert.equal(new TextDecoder().decode(await Effect.runPromise(fs.readAt(opened, 0, 100))), 'published');
  assert.equal(await backing.readFile('/workspace/hard'), 'published');
  console.log('PASS atomic final diff preserves open inode and hard-link identities');

  await backing.writeFile('/workspace/unlinked', 'old');
  const unlinked = await Effect.runPromise(fs.prepareOpen('/workspace/unlinked', '/', { access: 'read' }));
  await backing.transaction(async (staged) => {
    await staged.writeFile('/workspace/unlinked', 'last contents');
    await staged.rm('/workspace/unlinked');
  });
  assert.equal(await backing.exists('/workspace/unlinked'), false);
  assert.equal(new TextDecoder().decode(await Effect.runPromise(fs.readAt(unlinked, 0, 100))), 'last contents');
  console.log('PASS staged unlink preserves the contents of an open description');

  const scope = new ProcessAuthority();
  const before = await Effect.runPromise(fs.exportImage());
  await assert.rejects(backing.withAuthority(scope.assertActive).transaction(async (staged) => {
    await staged.writeFile('/workspace/file', 'must not publish');
    scope.revoke();
  }), /revoked/);
  assert.deepEqual(await Effect.runPromise(fs.exportImage()), before);
  console.log('PASS revocation after staging leaves the complete live image unchanged');

  await assert.rejects(backing.transaction(async (staged) => {
    await staged.writeFile('/workspace/file', 'stale');
    await backing.writeFile('/workspace/other-actor', 'preserved');
  }), /changed during final-diff staging/);
  assert.equal(await backing.readFile('/workspace/file'), 'published');
  assert.equal(await backing.readFile('/workspace/other-actor'), 'preserved');
  console.log('PASS concurrent actor survives generation-conflicting publication');
} finally { backing.dispose(); }

import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  beginSnapshotRelease,
  publishSnapshotRelease,
  recoverSnapshotRelease,
  snapshotReleasePaths,
} from '../scripts/python-runtime-snapshot-release.js';
import {
  runSnapshotReleaseLockCommand,
  SnapshotReleaseLockUnavailableError,
  spawnSnapshotReleaseLockCommand,
} from '../scripts/python-runtime-snapshot-lock.js';
import { runPythonRuntimeSnapshotBuilder } from '../scripts/build-python-runtime-snapshot.js';

async function fixture(): Promise<{
  readonly imagePath: string;
  readonly provenancePath: string;
  readonly root: string;
  readonly paths: ReturnType<typeof snapshotReleasePaths>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'tracecode-snapshot-release-'));
  const published = join(root, 'published');
  await mkdir(published);
  const imagePath = join(published, 'webkit.bin');
  const provenancePath = join(published, 'provenance.json');
  return {
    imagePath,
    provenancePath,
    root,
    paths: snapshotReleasePaths(root, imagePath, provenancePath),
  };
}

async function waitForLockHolder(holder: ChildProcess): Promise<void> {
  const stdout = holder.stdout;
  assert.ok(stdout);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const removeListeners = (): void => {
      stdout.off('data', onData);
      holder.off('error', onError);
      holder.off('exit', onExit);
    };
    const onData = (): void => {
      removeListeners();
      resolvePromise();
    };
    const onError = (error: Error): void => {
      removeListeners();
      rejectPromise(error);
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null
    ): void => {
      removeListeners();
      rejectPromise(
        new Error(
          `Lock holder exited before acquisition: ${String(code ?? signal)}.`
        )
      );
    };
    stdout.once('data', onData);
    holder.once('error', onError);
    holder.once('exit', onExit);
  });
}

test('publishes and verifies an image and provenance pair', async () => {
  const state = await fixture();
  try {
    await writeFile(state.imagePath, 'old-image');
    await writeFile(state.provenancePath, 'old-provenance');
    await publishSnapshotRelease({
      engine: 'webkit',
      image: Buffer.from('new-image'),
      paths: state.paths,
      provenance: Buffer.from('new-provenance'),
      verify: async () => {
        assert.equal(await readFile(state.imagePath, 'utf8'), 'new-image');
        assert.equal(
          await readFile(state.provenancePath, 'utf8'),
          'new-provenance'
        );
      },
    });
    assert.equal(await readFile(state.imagePath, 'utf8'), 'new-image');
    assert.equal(await readFile(state.provenancePath, 'utf8'), 'new-provenance');
    await assert.rejects(access(state.paths.journal), { code: 'ENOENT' });
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('rolls both files back when post-write verification fails', async () => {
  const state = await fixture();
  try {
    await writeFile(state.imagePath, 'old-image');
    await writeFile(state.provenancePath, 'old-provenance');
    await assert.rejects(
      publishSnapshotRelease({
        engine: 'webkit',
        image: Buffer.from('bad-image'),
        paths: state.paths,
        provenance: Buffer.from('bad-provenance'),
        verify: async () => {
          throw new Error('injected verification failure');
        },
      }),
      /injected verification failure/u
    );
    assert.equal(await readFile(state.imagePath, 'utf8'), 'old-image');
    assert.equal(await readFile(state.provenancePath, 'utf8'), 'old-provenance');
    await assert.rejects(access(state.paths.journal), { code: 'ENOENT' });
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('recovers the previous pair after an interrupted replacement', async () => {
  const state = await fixture();
  try {
    const oldImage = Buffer.from('old-image');
    const oldProvenance = Buffer.from('old-provenance');
    await writeFile(state.imagePath, oldImage);
    await writeFile(state.provenancePath, oldProvenance);
    await beginSnapshotRelease(
      state.paths,
      'webkit',
      oldImage,
      oldProvenance
    );
    await writeFile(state.imagePath, 'interrupted-image');
    await writeFile(state.provenancePath, 'interrupted-provenance');

    assert.equal(await recoverSnapshotRelease(state.paths, 'webkit'), true);
    assert.equal(await readFile(state.imagePath, 'utf8'), 'old-image');
    assert.equal(await readFile(state.provenancePath, 'utf8'), 'old-provenance');
    assert.equal(await recoverSnapshotRelease(state.paths, 'webkit'), false);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('names an invalid recovery journal instead of silently deleting it', async () => {
  const state = await fixture();
  try {
    await writeFile(state.paths.journal, '{');
    await assert.rejects(
      recoverSnapshotRelease(state.paths, 'webkit'),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(state.paths.journal)
    );
    assert.equal(await readFile(state.paths.journal, 'utf8'), '{');
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test(
  'advisory lock rejects overlap and releases when the holder exits',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracecode-snapshot-lock-'));
    const lockPath = join(root, 'release.lock');
    const holder = spawnSnapshotReleaseLockCommand({
      args: [
        '-e',
        "process.stdout.write('locked\\n'); process.stdin.resume();",
      ],
      command: process.execPath,
      lockPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      await waitForLockHolder(holder);
      await assert.rejects(
        runSnapshotReleaseLockCommand({
          args: ['-e', ''],
          command: process.execPath,
          lockPath,
          stdio: 'pipe',
        }),
        SnapshotReleaseLockUnavailableError
      );

      holder.kill('SIGTERM');
      await once(holder, 'exit');
      await runSnapshotReleaseLockCommand({
        args: ['-e', ''],
        command: process.execPath,
        lockPath,
        stdio: 'pipe',
      });
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        holder.kill('SIGKILL');
        await once(holder, 'exit');
      }
      await rm(root, { recursive: true, force: true });
    }
  }
);

test('replace entry point cannot run its worker outside the release lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tracecode-snapshot-entry-lock-'));
  const lockPath = join(root, '.python-runtime-snapshot-release.lock');
  const markerPath = join(root, 'worker-ran');
  const workerPath = join(root, 'probe-worker.mjs');
  await writeFile(
    workerPath,
    [
      "import { writeFile } from 'node:fs/promises';",
      "await writeFile(process.argv[3], 'ran');",
    ].join('\n')
  );
  const holder = spawnSnapshotReleaseLockCommand({
    args: [
      '-e',
      "process.stdout.write('locked\\n'); process.stdin.resume();",
    ],
    command: process.execPath,
    lockPath,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    await waitForLockHolder(holder);
    await assert.rejects(
      runPythonRuntimeSnapshotBuilder({
        args: ['--replace', markerPath],
        repositoryRoot: root,
        stdio: 'pipe',
        workerPath,
      }),
      SnapshotReleaseLockUnavailableError
    );
    await assert.rejects(access(markerPath), { code: 'ENOENT' });

    holder.kill('SIGTERM');
    await once(holder, 'exit');
    await runPythonRuntimeSnapshotBuilder({
      args: ['--replace', markerPath],
      repositoryRoot: root,
      stdio: 'pipe',
      workerPath,
    });
    assert.equal(await readFile(markerPath, 'utf8'), 'ran');
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill('SIGKILL');
      await once(holder, 'exit');
    }
    await rm(root, { recursive: true, force: true });
  }
});

import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

interface FileIdentity {
  readonly bytes: number | null;
  readonly sha256: string | null;
}

interface ReleaseTransaction {
  readonly schema: 'tracecode.python-runtime-snapshot-release.v1';
  readonly engine: string;
  readonly previousImage: FileIdentity;
  readonly previousProvenance: FileIdentity;
}

export interface SnapshotReleasePaths {
  readonly journal: string;
  readonly previousImage: string;
  readonly previousProvenance: string;
  readonly publishedImage: string;
  readonly publishedProvenance: string;
  readonly temporaryRoot: string;
}

export function snapshotReleasePaths(
  repositoryRoot: string,
  publishedImage: string,
  publishedProvenance: string
): SnapshotReleasePaths {
  return {
    journal: join(
      repositoryRoot,
      '.python-runtime-snapshot-release.transaction.json'
    ),
    previousImage: join(
      repositoryRoot,
      '.python-runtime-snapshot-release.previous.bin'
    ),
    previousProvenance: join(
      repositoryRoot,
      '.python-runtime-snapshot-release.previous-provenance.json'
    ),
    publishedImage,
    publishedProvenance,
    temporaryRoot: repositoryRoot,
  };
}

async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function identity(bytes: Buffer | undefined): FileIdentity {
  return bytes === undefined
    ? { bytes: null, sha256: null }
    : {
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
}

function assertIdentity(
  bytes: Buffer,
  expected: FileIdentity,
  path: string
): void {
  if (
    expected.bytes === null ||
    expected.sha256 === null ||
    bytes.byteLength !== expected.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== expected.sha256
  ) {
    throw new Error(`Python runtime snapshot recovery backup is invalid: ${path}.`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function durableWrite(
  path: string,
  bytes: string | Buffer,
  temporaryRoot: string
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(
    temporaryRoot,
    `.python-runtime-snapshot-release.write-${process.pid}-${randomUUID()}`
  );
  try {
    const file = await open(temporaryPath, 'wx');
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function removeDurably(path: string): Promise<void> {
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}

async function clearOrphanedBackups(
  paths: SnapshotReleasePaths
): Promise<void> {
  await Promise.all([
    rm(paths.previousImage, { force: true }),
    rm(paths.previousProvenance, { force: true }),
  ]);
}

async function completeTransaction(paths: SnapshotReleasePaths): Promise<void> {
  await removeDurably(paths.journal);
  await clearOrphanedBackups(paths).catch(() => undefined);
}

export async function beginSnapshotRelease(
  paths: SnapshotReleasePaths,
  engine: string,
  previousImage: Buffer | undefined,
  previousProvenance: Buffer | undefined
): Promise<void> {
  const existingJournal = await readOptionalFile(paths.journal);
  if (existingJournal !== undefined) {
    throw new Error(
      `Python runtime snapshot recovery is pending in ${paths.journal}.`
    );
  }
  await clearOrphanedBackups(paths);
  try {
    if (previousImage !== undefined) {
      await durableWrite(
        paths.previousImage,
        previousImage,
        paths.temporaryRoot
      );
    }
    if (previousProvenance !== undefined) {
      await durableWrite(
        paths.previousProvenance,
        previousProvenance,
        paths.temporaryRoot
      );
    }
    const transaction: ReleaseTransaction = {
      schema: 'tracecode.python-runtime-snapshot-release.v1',
      engine,
      previousImage: identity(previousImage),
      previousProvenance: identity(previousProvenance),
    };
    await durableWrite(
      paths.journal,
      `${JSON.stringify(transaction, null, 2)}\n`,
      paths.temporaryRoot
    );
  } catch (error) {
    await removeDurably(paths.journal).catch(() => undefined);
    await clearOrphanedBackups(paths).catch(() => undefined);
    throw error;
  }
}

async function restoreFile(
  paths: SnapshotReleasePaths,
  expected: FileIdentity,
  backupPath: string,
  targetPath: string
): Promise<void> {
  if (expected.bytes === null && expected.sha256 === null) {
    await removeDurably(targetPath);
    return;
  }
  if (expected.bytes === null || expected.sha256 === null) {
    throw new Error(
      `Python runtime snapshot recovery identity is incomplete in ${paths.journal}.`
    );
  }
  const backup = await readFile(backupPath);
  assertIdentity(backup, expected, backupPath);
  await durableWrite(targetPath, backup, paths.temporaryRoot);
  assertIdentity(await readFile(targetPath), expected, targetPath);
}

export async function recoverSnapshotRelease(
  paths: SnapshotReleasePaths,
  engine: string
): Promise<boolean> {
  const journalBytes = await readOptionalFile(paths.journal);
  if (journalBytes === undefined) {
    await clearOrphanedBackups(paths);
    return false;
  }

  let transaction: ReleaseTransaction;
  try {
    transaction = JSON.parse(journalBytes.toString('utf8')) as ReleaseTransaction;
  } catch (error) {
    throw new Error(
      `Python runtime snapshot recovery journal is invalid: ${paths.journal}.`,
      { cause: error }
    );
  }
  if (
    transaction.schema !== 'tracecode.python-runtime-snapshot-release.v1' ||
    transaction.engine !== engine
  ) {
    throw new Error(
      `Python runtime snapshot recovery journal is incompatible: ${paths.journal}.`
    );
  }

  await restoreFile(
    paths,
    transaction.previousImage,
    paths.previousImage,
    paths.publishedImage
  );
  await restoreFile(
    paths,
    transaction.previousProvenance,
    paths.previousProvenance,
    paths.publishedProvenance
  );
  await completeTransaction(paths);
  return true;
}

export async function publishSnapshotRelease(args: {
  readonly engine: string;
  readonly image: Buffer;
  readonly paths: SnapshotReleasePaths;
  readonly provenance: Buffer;
  readonly verify: () => Promise<void>;
}): Promise<void> {
  const previousImage = await readOptionalFile(args.paths.publishedImage);
  const previousProvenance = await readOptionalFile(
    args.paths.publishedProvenance
  );
  await beginSnapshotRelease(
    args.paths,
    args.engine,
    previousImage,
    previousProvenance
  );
  try {
    await durableWrite(
      args.paths.publishedImage,
      args.image,
      args.paths.temporaryRoot
    );
    await durableWrite(
      args.paths.publishedProvenance,
      args.provenance,
      args.paths.temporaryRoot
    );
    await args.verify();
    await completeTransaction(args.paths);
  } catch (releaseError) {
    try {
      await recoverSnapshotRelease(args.paths, args.engine);
    } catch (rollbackError) {
      throw new AggregateError(
        [releaseError, rollbackError],
        'Snapshot release failed and rollback was incomplete.'
      );
    }
    throw releaseError;
  }
}

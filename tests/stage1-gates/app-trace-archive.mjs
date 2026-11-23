import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

export async function installAppTraceArchive(page, evidence) {
  const directory = join(evidence, 'app-traces');
  mkdirSync(directory, { recursive: true });
  const pending = new Map();
  const scope = randomUUID();

  await page.exposeFunction('recordGateTraceChunk', async (id, chunk, count) => {
    assert(Number.isSafeInteger(id) && id > 0);
    let entry = pending.get(id);
    if (!entry) {
      const path = join(directory, `${scope}-${id}.partial`);
      const output = createWriteStream(path, { flags: 'wx' });
      const gzip = createGzip({ level: 1 });
      const done = pipeline(gzip, output);
      // Surface stream errors when the browser finalizes the archive.
      done.catch(() => {});
      entry = { path, gzip, output, done, hash: createHash('sha256'), count: 0, bytes: 0 };
      pending.set(id, entry);
    }
    if (chunk !== null) {
      assert(typeof chunk === 'string' && chunk.length <= 256 * 1024);
      const bytes = Buffer.from(chunk);
      entry.hash.update(bytes);
      entry.bytes += bytes.length;
      let offset = -1;
      while ((offset = bytes.indexOf(10, offset + 1)) !== -1) entry.count++;
      if (!entry.gzip.write(bytes)) await Promise.race([once(entry.gzip, 'drain'), entry.done]);
      return;
    }
    assert.equal(entry.count, count, 'Trace archive event count');
    entry.gzip.end();
    await entry.done;
    const sha256 = entry.hash.digest('hex');
    renameSync(entry.path, join(directory, `${sha256}.jsonl.gz`));
    pending.delete(id);
    const reference = { archive: 'ga-app-trace-jsonl-v1', count, sha256 };
    appendFileSync(join(evidence, 'app-traces.jsonl'), JSON.stringify({ ...reference, bytes: entry.bytes }) + '\n');
    return reference;
  });

  return async () => {
    for (const entry of pending.values()) {
      entry.gzip.destroy();
      entry.output.destroy();
      await entry.done.catch(() => {});
      rmSync(entry.path, { force: true });
    }
  };
}

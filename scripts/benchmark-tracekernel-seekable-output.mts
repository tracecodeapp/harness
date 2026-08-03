#!/usr/bin/env node

import * as Effect from 'effect/Effect';
import { TraceKernelFileSystem } from '../packages/tracekernel/src/vfs';

// Captured from a real Clang/LLVM object emission. Keep this workload stable:
// it guards against rebuilding the complete file for every small positioned
// write, which previously made compiler output quadratic.
const WRITE_COUNT = 133_322;
const OUTPUT_BYTES = 1_089_441;

async function main(): Promise<void> {
  const fileSystem = await Effect.runPromise(TraceKernelFileSystem.make());
  const file = await Effect.runPromise(
    fileSystem.prepareOpen(
      '/workspace/program.o',
      '/',
      { access: 'write', create: true, truncate: true }
    )
  );
  const baseChunkBytes = Math.floor(OUTPUT_BYTES / WRITE_COUNT);
  const largerChunkCount = OUTPUT_BYTES % WRITE_COUNT;
  let offset = 0;
  const startedAt = performance.now();
  for (let index = 0; index < WRITE_COUNT; index += 1) {
    const chunkBytes =
      baseChunkBytes + (index < largerChunkCount ? 1 : 0);
    await Effect.runPromise(
      fileSystem.writeAt(
        file,
        offset,
        new Uint8Array(chunkBytes),
        false
      )
    );
    offset += chunkBytes;
  }
  const elapsedMs = performance.now() - startedAt;
  const stat = await Effect.runPromise(fileSystem.statOpen(file));
  if (stat.size !== OUTPUT_BYTES) {
    throw new Error(
      `Expected ${OUTPUT_BYTES} output bytes, observed ${stat.size}.`
    );
  }
  process.stdout.write(`${JSON.stringify({
    schema: 'tracekernel-seekable-output-benchmark-v1',
    writes: WRITE_COUNT,
    outputBytes: stat.size,
    elapsedMs,
    microsecondsPerWrite: elapsedMs * 1000 / WRITE_COUNT,
  }, null, 2)}\n`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

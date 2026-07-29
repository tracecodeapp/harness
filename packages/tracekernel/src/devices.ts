import * as Effect from 'effect/Effect';
import type {
  TraceKernelDescriptor,
  TraceKernelDescriptorReadiness,
  TraceKernelPollEvents,
} from './descriptors';
import type { TraceKernelStat } from './vfs';

export type TraceKernelDeviceAccess = 'read' | 'write' | 'read-write';

const NULL_STAT: TraceKernelStat = Object.freeze({
  path: '/dev/null',
  kind: 'file',
  inode: 2,
  nlink: 1,
  mode: 0o20666,
  size: 0,
  generation: 0,
  createdAt: 0,
  modifiedAt: 0,
  changedAt: 0,
});

/**
 * Stateless character-device descriptors used for detached standard streams.
 *
 * A null descriptor is deliberately a real entry in the process descriptor
 * table. Reserving 0/1/2 through kernel resources prevents later file, pipe,
 * watch, and socket allocation from creating overlapping FD identities.
 */
export function makeTraceKernelNullDescriptor(
  resourceId: string,
  access: TraceKernelDeviceAccess
): TraceKernelDescriptor {
  const descriptor = (): TraceKernelDescriptor => ({
    kind: 'device',
    resourceId,
    ...(access === 'write'
      ? {}
      : {
          read: () => Effect.succeed(new Uint8Array()),
          readNonblocking: () => Effect.succeed(new Uint8Array()),
        }),
    ...(access === 'read'
      ? {}
      : {
          write: (bytes: Uint8Array) => Effect.succeed(bytes.byteLength),
          writeNonblocking: (bytes: Uint8Array) =>
            Effect.succeed(bytes.byteLength),
        }),
    readiness: (events: TraceKernelPollEvents) =>
      Effect.succeed<TraceKernelDescriptorReadiness>({
        read: events.read && access !== 'write',
        write: events.write && access !== 'read',
        hangup: false,
        error: false,
      }),
    awaitReadiness: (events: TraceKernelPollEvents) =>
      Effect.succeed<TraceKernelDescriptorReadiness>({
        read: events.read && access !== 'write',
        write: events.write && access !== 'read',
        hangup: false,
        error: false,
      }),
    stat: () => Effect.succeed(NULL_STAT),
    duplicate: () => Effect.succeed(descriptor()),
    close: () => Effect.void,
  });
  return descriptor();
}

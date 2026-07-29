#!/usr/bin/env npx tsx

import * as Effect from 'effect/Effect';
import {
  makeTraceKernelHost,
  type TraceKernelProcess,
  type TraceKernelRuntimeProvider,
  type TraceKernelSession,
} from '@tracecode/tracekernel';

const runtimeNames = [
  'javascript',
  'python',
  'cpp',
  'csharp',
  'tracejvm',
] as const;

type SoakRuntimeName = (typeof runtimeNames)[number];

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function positiveInteger(name: string, fallback: number): number {
  const configured = process.env[name]?.trim();
  if (!configured) return fallback;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

const profile = process.env.TRACECODE_TRACEKERNEL_SOAK_PROFILE === 'extended'
  ? 'extended'
  : 'bounded';
const singleSessionChildren = positiveInteger(
  'TRACECODE_TRACEKERNEL_SOAK_CHILDREN',
  profile === 'extended' ? 1_000 : 100
);
const sessionCycles = positiveInteger(
  'TRACECODE_TRACEKERNEL_SOAK_SESSIONS',
  profile === 'extended' ? 100 : 10
);
const processesPerCycle = positiveInteger(
  'TRACECODE_TRACEKERNEL_SOAK_PROCESSES_PER_SESSION',
  profile === 'extended' ? 10 : 5
);

const acquired = new Map<SoakRuntimeName, number>();
const released = new Map<SoakRuntimeName, number>();
let nextLeaseId = 1;

function count(
  counts: Map<SoakRuntimeName, number>,
  runtime: SoakRuntimeName
): void {
  counts.set(runtime, (counts.get(runtime) ?? 0) + 1);
}

function provider(runtime: SoakRuntimeName): TraceKernelRuntimeProvider {
  return {
    runtime,
    initialize: Effect.succeed({
      acquire: () =>
        Effect.sync(() => {
          const leaseId = `${runtime}-${nextLeaseId++}`;
          count(acquired, runtime);
          return {
            id: leaseId,
            runtime,
            execute: () => Effect.never,
            release: () =>
              Effect.sync(() => {
                count(released, runtime);
              }),
          };
        }),
    }),
  };
}

function expectedBytes(runtime: SoakRuntimeName, index: number): Uint8Array {
  return new TextEncoder().encode(`${runtime}:${index}\n`);
}

function exerciseChildResources(
  session: TraceKernelSession,
  child: TraceKernelProcess,
  runtime: SoakRuntimeName,
  index: number
) {
  return Effect.gen(function* () {
    const contents = expectedBytes(runtime, index);
    const fd = yield* session.openFile(
      child,
      `/workspace/soak/${runtime}-${index}.txt`,
      {
        access: 'read-write',
        create: true,
        truncate: true,
      }
    );
    const written = yield* child.write(fd, contents);
    const read = yield* child.read(fd, contents.byteLength, 0);
    assertCondition(
      written === contents.byteLength &&
        new TextDecoder().decode(read) === new TextDecoder().decode(contents),
      `Child ${index} did not round-trip its process-owned TKFS descriptor.`
    );
    yield* child.close(fd);

    if (index % 10 === 0) {
      const pipe = yield* session.createPipe(child, child, {
        capacityChunks: 2,
      });
      yield* child.write(pipe.writeFd, contents);
      yield* child.close(pipe.writeFd);
      const piped = yield* child.read(pipe.readFd, contents.byteLength);
      assertCondition(
        new TextDecoder().decode(piped) === new TextDecoder().decode(contents),
        `Child ${index} did not round-trip its process-owned pipe.`
      );
      yield* child.close(pipe.readFd);
    }

    if (index % 20 === 0) {
      const listenerFd = yield* session.createTcpSocket(child);
      const bound = yield* session.bindTcp(child, listenerFd, {
        host: '127.0.0.1',
        port: 0,
      });
      yield* session.listenTcp(child, listenerFd, {
        backlog: 1,
        capacityChunks: 2,
      });
      const clientFd = yield* session.createTcpSocket(child);
      yield* session.connectTcp(child, clientFd, bound);
      const accepted = yield* session.acceptTcp(child, listenerFd);
      yield* child.write(clientFd, contents);
      yield* session.shutdownTcp(child, clientFd, 'write');
      const received = yield* child.read(accepted.fd, contents.byteLength);
      assertCondition(
        new TextDecoder().decode(received) ===
          new TextDecoder().decode(contents),
        `Child ${index} did not round-trip its process-owned TCP stream.`
      );
      yield* child.close(accepted.fd);
      yield* child.close(clientFd);
      yield* child.close(listenerFd);
    }
  });
}

const startedAt = Date.now();
const heapBefore = process.memoryUsage().heapUsed;

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* makeTraceKernelHost({
        providers: runtimeNames.map(provider),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* host.openSession({
            cwd: '/workspace',
            maxProcesses: 4,
            signalGracePeriodMs: 0,
          });
          yield* session.fileSystem.mkdir(
            '/workspace/soak',
            { recursive: true }
          );
          const parent = yield* session.spawn({
            runtime: 'javascript',
            command: 'soak-parent',
          });
          yield* parent.awaitStarted();

          for (let index = 0; index < singleSessionChildren; index += 1) {
            const runtime = runtimeNames[index % runtimeNames.length];
            const child = yield* session.spawnChild(parent, {
              runtime,
              command: `soak-child-${index}`,
            });
            yield* child.awaitStarted();
            yield* exerciseChildResources(
              session,
              child,
              runtime,
              index
            );
            yield* child.signal('SIGKILL');
            const waited = yield* session.waitChild(parent, child.pid);
            assertCondition(
              waited?.termination?.kind === 'signal' &&
                waited.termination.signal === 'SIGKILL',
              `Child ${index} did not preserve kernel-owned termination.`
            );
            assertCondition(
              session.processTableSnapshots().length === 1,
              `Child ${index} leaked into the authoritative process table.`
            );
            assertCondition(
              session.resourceIds().length === 0,
              `Child ${index} leaked descriptors or sockets: ${JSON.stringify(
                session.resourceIds()
              )}`
            );
          }

          yield* parent.signal('SIGKILL');
          yield* parent.wait();
          assertCondition(
            session.processTableSnapshots().length === 0,
            'The persistent soak parent leaked after termination.'
          );
          yield* session.shutdown();
          assertCondition(
            session.resourceIds().length === 0 &&
              session.terminalSnapshots().length === 0,
            'The single-session soak leaked kernel resources.'
          );
        })
      );
      assertCondition(
        host.sessionIds().length === 0,
        'The single-session soak remained registered with its host.'
      );

      for (let cycle = 0; cycle < sessionCycles; cycle += 1) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* host.openSession({
              cwd: '/workspace',
              maxProcesses: processesPerCycle,
              signalGracePeriodMs: 0,
            });
            const processes = yield* Effect.forEach(
              Array.from({ length: processesPerCycle }, (_, index) => index),
              (index) => {
                const runtime =
                  runtimeNames[(cycle * processesPerCycle + index) %
                    runtimeNames.length];
                return session.spawn({
                  runtime,
                  command: `cycle-${cycle}-process-${index}`,
                });
              },
              { concurrency: 'unbounded' }
            );
            yield* Effect.forEach(
              processes,
              (kernelProcess) => kernelProcess.awaitStarted(),
              { concurrency: 'unbounded', discard: true }
            );
            assertCondition(
              session.processSnapshots().length === processesPerCycle,
              `Session cycle ${cycle} did not register every process.`
            );
            yield* session.shutdown();
            assertCondition(
              session.processTableSnapshots().length === 0 &&
                session.resourceIds().length === 0 &&
                session.terminalSnapshots().length === 0,
              `Session cycle ${cycle} leaked authoritative kernel state.`
            );
          })
        );
        assertCondition(
          host.sessionIds().length === 0,
          `Session cycle ${cycle} remained registered with its host.`
        );
      }
    })
  )
);

const acquiredTotal = [...acquired.values()].reduce(
  (total, value) => total + value,
  0
);
const releasedTotal = [...released.values()].reduce(
  (total, value) => total + value,
  0
);
const expectedLeases =
  1 + singleSessionChildren + sessionCycles * processesPerCycle;
assertCondition(
  acquiredTotal === expectedLeases && releasedTotal === expectedLeases,
  `Runtime leases were not acquired and released exactly once: ${JSON.stringify({
    acquired: Object.fromEntries(acquired),
    released: Object.fromEntries(released),
    expectedLeases,
  })}`
);
for (const runtime of runtimeNames) {
  assertCondition(
    acquired.get(runtime) === released.get(runtime),
    `${runtime} leases were not released exactly once.`
  );
}

console.log(
  JSON.stringify(
    {
      schema: 'tracekernel-soak-v1',
      profile,
      singleSessionChildren,
      sessionCycles,
      processesPerCycle,
      mixedRuntimeNames: runtimeNames,
      processLeases: expectedLeases,
      acquired: Object.fromEntries(acquired),
      released: Object.fromEntries(released),
      exactlyOnceLeaseRelease: true,
      leakedProcesses: 0,
      leakedResources: 0,
      heapBeforeBytes: heapBefore,
      heapAfterBytes: process.memoryUsage().heapUsed,
      elapsedMs: Date.now() - startedAt,
    },
    null,
    2
  )
);

import type {
  JudgeObservationLease,
  JudgeObservationProgram,
  JudgeReceiptProvider,
} from '@tracecode/runtime-browser/browser-runtime-host-internal';
import type {
  Drawing,
  ExecutionResult,
  Refusal,
  RuntimeObservationCall,
} from '@tracecode/runtime-contracts';
import type { CppWorkerClient } from './cpp-worker-client';
import {
  verifyCppStage1Artifact,
  type CppStage1Artifact,
  type CppStage1CoordinateVerifier,
  type VerifiedCppStage1Artifact,
} from './cpp-stage1-artifact';

type Preparation = Pick<RuntimeObservationCall, 'traceOptions' | 'signal'> & {
  readonly program: JudgeObservationProgram;
};

/** Internal composition supplies exactly one producer. */
export interface CppDrawingProducer {
  prepare(call: Preparation): Promise<JudgeObservationLease>;
}

function refused(reason: Refusal): Drawing {
  return { status: 'refused', reason };
}

function refusalLease(reason: Refusal): JudgeObservationLease {
  return { observe: async () => refused(reason), dispose() {} };
}

/** Keeps the observation adapter limited to presentation data. */
export function createCppObservationRegistration(
  producer: CppDrawingProducer,
  options: {
    readonly runtimeVersion: string;
    readonly observationDeadlineMs: number;
    readonly observationPrepareDeadlineMs?: number;
  }
) {
  const { runtimeVersion, ...deadlines } = options;
  return {
    runtimeVersion,
    capabilities: { observationLease: 'separate' as const, ...deadlines },
    async prepareObservation(
      program: JudgeObservationProgram,
      signal: AbortSignal,
      traceOptions?: Preparation['traceOptions']
    ): Promise<JudgeObservationLease> {
      signal.throwIfAborted();
      let lease: JudgeObservationLease;
      try {
        lease = await producer.prepare({ program, traceOptions, signal });
      } catch {
        signal.throwIfAborted();
        lease = refusalLease('observer-prepare');
      }
      if (signal.aborted) {
        await lease.dispose();
        signal.throwIfAborted();
      }

      const lifetime = new AbortController();
      return {
        async observe(attempt) {
          const signal = attempt.signal
            ? AbortSignal.any([attempt.signal, lifetime.signal])
            : lifetime.signal;
          signal.throwIfAborted();
          let drawing: Drawing;
          try {
            drawing = await lease.observe({ ...attempt, signal });
          } catch {
            signal.throwIfAborted();
            return refused('observer-runtime');
          }
          signal.throwIfAborted();
          switch (drawing?.status) {
            case 'drawn':
              return { status: 'drawn', trace: drawing.trace };
            case 'truncated':
              return {
                status: 'truncated',
                reason: drawing.reason,
                trace: drawing.trace,
                attemptedEvents: drawing.attemptedEvents,
              };
            case 'refused':
              return refused(drawing.reason);
            default:
              return refused('observer-protocol');
          }
        },
        dispose() {
          if (lifetime.signal.aborted) return;
          lifetime.abort();
          return lease.dispose();
        },
      };
    },
  } satisfies JudgeReceiptProvider;
}

interface LegacyCppDrawingOptions {
  /** Must allocate an observer-owned worker client, never the ordinary client. */
  createObserverWorkerClient(): Pick<CppWorkerClient,
    'init' | 'prepareRuntimeProgram' | 'executePreparedTrace' | 'terminate'>;
}

/**
 * Compatibility presentation for the explicitly selected legacy producer.
 * Recorded events describe the rewritten execution. A legacy budget signal
 * supplies neither a certified prefix nor an attempted-event count.
 */
function legacyDrawing(result: ExecutionResult): Drawing {
  if (result.kind === 'limit' && result.reason === 'client-timeout') {
    return refused('observer-timeout');
  }
  if (result.traceTruncated || result.kind === 'limit') {
    return refused('uncertified-drawing');
  }
  if (result.kind === 'failed') {
    return refused(result.providerFailure ? 'recorder-unavailable' : 'observer-runtime');
  }
  const { trace } = result;
  if (trace.language !== 'cpp') return refused('observer-protocol');
  if (!trace.events.some(({ kind }) => kind === 'line')) return refused('recorder-unavailable');
  return { status: 'drawn', trace };
}

export function createLegacyCppDrawingProducer(options: LegacyCppDrawingOptions): CppDrawingProducer {
  return {
    async prepare({ program, traceOptions, signal }) {
      type ObserverClient = ReturnType<LegacyCppDrawingOptions['createObserverWorkerClient']>;
      const clients = new Set<ObserverClient>();
      const retire = (client: ObserverClient) => {
        if (clients.delete(client)) client.terminate();
      };

      async function compile(signal?: AbortSignal) {
        signal?.throwIfAborted();
        const client = options.createObserverWorkerClient();
        clients.add(client);
        const abort = () => retire(client);
        signal?.addEventListener('abort', abort, { once: true });
        try {
          await client.init();
          signal?.throwIfAborted();
          const preparation = await client.prepareRuntimeProgram({
            code: program.code,
            functionName: program.functionName,
            executionStyle: program.executionStyle,
            mode: 'trace',
            traceOptions,
            signal,
          });
          signal?.throwIfAborted();
          if (preparation.success === false) {
            retire(client);
            return undefined;
          }
          return { client, handle: preparation.handle };
        } catch (error) {
          retire(client);
          throw error;
        } finally {
          signal?.removeEventListener('abort', abort);
        }
      }

      let standby = await compile(signal);
      if (!standby) return refusalLease('observer-prepare');
      return {
        async observe(call) {
          call.signal?.throwIfAborted();
          // A contender must never run on a worker another attempt can abort.
          // The separate trusted compiler may cache immutable compiler output.
          let artifact = standby;
          standby = undefined;
          if (!artifact) {
            try {
              artifact = await compile(call.signal);
            } catch {
              call.signal?.throwIfAborted();
              return refused('observer-prepare');
            }
          }
          if (!artifact) return refused('observer-prepare');
          const { client, handle } = artifact;
          const abort = () => retire(client);
          call.signal?.addEventListener('abort', abort, { once: true });
          try {
            call.signal?.throwIfAborted();
            const result = await client.executePreparedTrace(handle, {
              inputs: call.inputs,
              recordTrace: true,
              signal: call.signal,
            });
            call.signal?.throwIfAborted();
            return legacyDrawing(result);
          } finally {
            call.signal?.removeEventListener('abort', abort);
            retire(client);
          }
        },
        dispose() {
          standby = undefined;
          for (const client of clients) retire(client);
        },
      };
    },
  };
}

interface SparseCppDrawingOptions {
  /** Supplies the exact ordinary module and its independently extractable map. */
  loadArtifact(call: Preparation): Promise<CppStage1Artifact | undefined>;
  verifySites: CppStage1CoordinateVerifier;
  /**
   * Derive a probe copy without changing ordinary bytes. Each observer owns a
   * separate worker and instantiates fresh memory and WASI for its attempt.
   * The site map alone supplies no browser drawing qualification.
   */
  createObserver(artifact: VerifiedCppStage1Artifact): JudgeObservationLease;
}

export function createSparseCppDrawingProducer(options: SparseCppDrawingOptions): CppDrawingProducer {
  return {
    async prepare(call) {
      const artifact = await options.loadArtifact(call);
      call.signal?.throwIfAborted();
      if (!artifact) return refusalLease('uncertified-drawing');
      const verified = await verifyCppStage1Artifact(artifact, call.program.code, options.verifySites, call.signal);
      call.signal?.throwIfAborted();
      if (!verified) return refusalLease('uncertified-drawing');
      const active = new Set<() => void | Promise<void>>();
      return {
        async observe(attempt) {
          // Own the bytes of this copy. Neither a probe rewriter nor a
          // transfer to its worker can modify/detach the certified original.
          attempt.signal?.throwIfAborted();
          const observer = options.createObserver({
            ordinaryModule: verified.ordinaryModule.slice(),
            sites: structuredClone(verified.sites),
          });
          let disposal: Promise<void> | undefined;
          const retire = () => {
            active.delete(retire);
            disposal ??= Promise.resolve().then(() => observer.dispose());
            return disposal;
          };
          const abort = () => { void retire().catch(() => {}); };
          active.add(retire);
          attempt.signal?.addEventListener('abort', abort, { once: true });
          try {
            attempt.signal?.throwIfAborted();
            return await observer.observe(attempt);
          } finally {
            attempt.signal?.removeEventListener('abort', abort);
            await retire();
          }
        },
        async dispose() {
          await Promise.allSettled([...active].map((retire) => retire()));
        },
      };
    },
  };
}

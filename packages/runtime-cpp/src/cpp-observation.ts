import type {
  Drawing,
  ExecutionResult,
  Refusal,
  RuntimeObservationCall,
  RuntimeObservationProvider,
} from '@tracecode/runtime-contracts';
import type { CppWorkerClient } from './cpp-worker-client';
import {
  verifyCppStage1Artifact,
  type CppStage1Artifact,
  type CppStage1CoordinateVerifier,
  type VerifiedCppStage1Artifact,
} from './cpp-stage1-artifact';

type Preparation = Pick<RuntimeObservationCall, 'program' | 'traceOptions' | 'signal'>;

interface CppDrawingLease extends RuntimeObservationProvider {
  dispose(): void | Promise<void>;
}

/** Internal composition supplies exactly one producer. */
export interface CppDrawingProducer {
  prepare(call: Preparation): Promise<CppDrawingLease>;
}

function refused(reason: Refusal): Drawing {
  return { status: 'refused', reason };
}

function refusalLease(reason: Refusal): CppDrawingLease {
  return { observe: async () => refused(reason), dispose() {} };
}

/** Keeps the observation adapter limited to presentation data. */
export function createCppObservationRegistration(
  producer: CppDrawingProducer,
  observationDeadlineMs: number
) {
  return {
    capabilities: { observationLease: 'separate' as const, observationDeadlineMs },
    async prepareObservation(call: Preparation): Promise<CppDrawingLease> {
      call.signal?.throwIfAborted();
      let lease: CppDrawingLease;
      try {
        lease = await producer.prepare(call);
      } catch {
        call.signal?.throwIfAborted();
        return refusalLease('observer-prepare');
      }
      if (call.signal?.aborted) {
        await lease.dispose();
        call.signal.throwIfAborted();
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
          switch (drawing.status) {
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
  };
}

interface LegacyCppDrawingOptions {
  /** Must allocate an observer-owned worker client, never the ordinary client. */
  createObserverWorkerClient(): Pick<CppWorkerClient,
    'init' | 'prepareRuntimeProgram' | 'executePreparedTrace' | 'terminate'>;
  /** Runtime events from the rewritten program require independent certification. */
  certify(result: ExecutionResult, call: RuntimeObservationCall): Drawing | Promise<Drawing>;
}

export function createLegacyCppDrawingProducer(options: LegacyCppDrawingOptions): CppDrawingProducer {
  return {
    async prepare({ program, traceOptions, signal }) {
      const client = options.createObserverWorkerClient();
      try {
        await client.init();
        signal?.throwIfAborted();
        const preparation = await client.prepareRuntimeProgram({
          ...program,
          mode: 'trace',
          traceOptions,
          signal,
        });
        signal?.throwIfAborted();
        if (preparation.success === false) {
          client.terminate();
          return refusalLease('observer-prepare');
        }
        return {
          async observe(call) {
            const result = await client.executePreparedTrace(preparation.handle, {
              inputs: call.inputs,
              recordTrace: true,
              signal: call.signal,
            });
            call.signal?.throwIfAborted();
            if (result.kind === 'limit' && result.reason === 'client-timeout') {
              return refused('observer-timeout');
            }
            try {
              return await options.certify(result, call);
            } catch {
              call.signal?.throwIfAborted();
              return refused('observer-encode');
            }
          },
          dispose() { client.terminate(); },
        };
      } catch (error) {
        client.terminate();
        throw error;
      }
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
  createObserver(artifact: VerifiedCppStage1Artifact): CppDrawingLease;
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
      return {
        async observe(attempt) {
          // Own the bytes of this copy. Neither a probe rewriter nor a
          // transfer to its worker can modify/detach the certified original.
          const observer = options.createObserver({
            ordinaryModule: verified.ordinaryModule.slice(),
            sites: structuredClone(verified.sites),
          });
          try {
            return await observer.observe(attempt);
          } finally {
            await observer.dispose();
          }
        },
        dispose() {},
      };
    },
  };
}

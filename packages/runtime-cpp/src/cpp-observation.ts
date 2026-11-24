import type {
  JudgeObservationLease,
  JudgeObservationProgram,
  JudgeReceiptProvider,
} from '@tracecode/runtime-browser/browser-runtime-host-internal';
import type {
  Drawing,
  ExecutionResult,
  ObservationFinalState,
  RuntimeObservationReply,
  Refusal,
  RuntimeObservationCall,
} from '@tracecode/runtime-contracts';
import type { CppRecorderEvidence, CppWorkerClient } from './cpp-worker-client';
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
  readonly certification?: 'ends-same';
  prepare(call: Preparation): Promise<JudgeObservationLease>;
}

function refused(reason: Refusal): Extract<Drawing, { status: 'refused' }> {
  return { status: 'refused', reason };
}

function refusalLease(reason: Refusal, finalState?: ObservationFinalState): JudgeObservationLease {
  return {
    observe: async () => ({ ...refused(reason), ...(finalState && { finalState }) }),
    dispose() {},
  };
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
    capabilities: {
      observationLease: 'separate' as const,
      ...deadlines,
      ...(producer.certification && { certification: producer.certification }),
    },
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
          let drawing: RuntimeObservationReply;
          try {
            drawing = await lease.observe({ ...attempt, signal });
          } catch {
            signal.throwIfAborted();
            return refused('observer-runtime');
          }
          signal.throwIfAborted();
          const finalState = drawing?.finalState;
          const evidence = finalState ? { finalState } : {};
          switch (drawing?.status) {
            case 'drawn':
              return { status: 'drawn', trace: drawing.trace, ...evidence };
            case 'truncated':
              return {
                status: 'truncated',
                reason: drawing.reason,
                trace: drawing.trace,
                attemptedEvents: drawing.attemptedEvents,
                ...evidence,
              };
            case 'refused':
              return { ...refused(drawing.reason), ...evidence };
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

function legacyDrawing(result: ExecutionResult, observation?: CppRecorderEvidence): Drawing {
  if (result.kind === 'limit' && result.reason === 'client-timeout') {
    return refused('observer-timeout');
  }
  if (result.kind === 'failed') {
    return refused(result.providerFailure ? 'recorder-unavailable' : 'observer-runtime');
  }
  if (result.kind === 'limit' || result.traceTruncated) return refused('uncertified-drawing');

  const { trace } = result;
  if (trace.language !== 'cpp') return refused('observer-protocol');
  if (!observation?.recorderCompleted) return refused('recorder-unavailable');
  const sourceEvent = trace.events.some(({ kind }) => kind === 'line' || kind === 'call');
  const { cut, attemptedEvents } = observation;
  if (cut) {
    if (!Number.isSafeInteger(attemptedEvents) || attemptedEvents <= trace.events.length ||
      (!sourceEvent && !(cut === 'byte-budget' && trace.events.length === 0))) {
      return refused('uncertified-drawing');
    }
    return { status: 'truncated', reason: cut, trace, attemptedEvents };
  }
  if (!trace.events.some(({ kind }) => kind === 'line')) return refused('recorder-unavailable');
  return { status: 'drawn', trace };
}

function legacyFinalState(result: ExecutionResult): ObservationFinalState {
  // Match Judge's ordinary outputText framing. The runtime already decoded
  // the value with its prepared driver's JSON result protocol.
  const console = result.consoleOutput
    .map((line) => line.endsWith('\n') ? line : `${line}\n`)
    .join('');
  if (result.kind === 'completed') {
    return {
      status: 'completed',
      value: result.output === undefined ? { present: false } : { present: true, value: result.output },
      console,
    };
  }
  return { status: result.kind === 'limit' && result.reason === 'client-timeout' ? 'timed-out' : 'trapped', console };
}

type LegacyPrepareFailure = 'compile-failed' | 'timed-out';

function legacyPrepareRefusal(status: LegacyPrepareFailure): JudgeObservationLease {
  return refusalLease(status === 'timed-out' ? 'observer-timeout' : 'observer-prepare', { status, console: '' });
}

export function createLegacyCppDrawingProducer(options: LegacyCppDrawingOptions): CppDrawingProducer {
  return {
    certification: 'ends-same',
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
            observationOnly: true,
            traceOptions,
            signal,
          });
          signal?.throwIfAborted();
          if (preparation.success === false) {
            retire(client);
            return { status: preparation.compileDeadlineExceeded ? 'timed-out' : 'compile-failed' } as const;
          }
          return { status: 'prepared', client, handle: preparation.handle } as const;
        } catch {
          retire(client);
          signal?.throwIfAborted();
          return { status: 'compile-failed' } as const;
        } finally {
          signal?.removeEventListener('abort', abort);
        }
      }

      const initial = await compile(signal);
      if (initial.status !== 'prepared') return legacyPrepareRefusal(initial.status);
      let standby: typeof initial | undefined = initial;
      return {
        async observe(call) {
          call.signal?.throwIfAborted();
          // A contender must never run on a worker another attempt can abort.
          // The separate trusted compiler may cache immutable compiler output.
          const ready = standby;
          standby = undefined;
          const artifact = ready ?? await compile(call.signal);
          if (artifact.status !== 'prepared') {
            return legacyPrepareRefusal(artifact.status).observe(call);
          }
          const { client, handle } = artifact;
          const abort = () => retire(client);
          call.signal?.addEventListener('abort', abort, { once: true });
          try {
            call.signal?.throwIfAborted();
            const result = await client.executePreparedTrace(handle, {
              inputs: call.inputs,
              recordTrace: true,
              attemptToken: call.attemptToken,
              signal: call.signal,
            });
            call.signal?.throwIfAborted();
            return { ...legacyDrawing(result, result.observation), finalState: legacyFinalState(result) };
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

import type {
  Language,
  RuntimePreparedCodeBatchCall,
  RuntimePreparedExecutionProvider,
  TraceExecutionOptions,
} from '@tracecode/runtime-contracts';
import type {
  RuntimeObservationCall,
  RuntimeObservationProvider,
  RuntimeObservationReply,
} from '../../runtime-contracts/src/runtime-calls';
import type { BrowserRuntimeProviderLease } from './runtime-provider-registry';
import type { BrowserRuntimeHost } from './browser-runtime-host';

export type JudgeObservationProgram = RuntimeObservationCall['program'] & {
  readonly runtimeVersion: string;
};

const ordinaryPreparationKeys = new WeakMap<JudgeObservationProgram, object>();

export function bindJudgeOrdinaryPreparation(program: JudgeObservationProgram, key: object): void {
  ordinaryPreparationKeys.set(program, key);
}

/**
 * The ordinary preparation a Judge observation program belongs to, or
 * undefined for a program no Judge evaluation bound (a direct observe call).
 */
export function findJudgeOrdinaryPreparationKey(program: object): object | undefined {
  return ordinaryPreparationKeys.get(program as JudgeObservationProgram);
}

export function getJudgeOrdinaryPreparationKey(program: JudgeObservationProgram): object {
  const key = ordinaryPreparationKeys.get(program);
  if (!key) throw new Error('Missing ordinary preparation for Judge observation.');
  return key;
}

type ObservationRefusal = Extract<RuntimeObservationReply, { status: 'refused' }>;

export interface JudgeObservationLease extends RuntimeObservationProvider {
  /**
   * Each observe call gets fresh learner state. An abort must retire or reset
   * that state before the adapter admits a subsequent case on the lease.
   */
  observe(call: RuntimeObservationCall): Promise<RuntimeObservationReply>;
  /** Only the captured Judge test bridge can request this observer control. */
  observeWithoutRecorderForTest?(call: RuntimeObservationCall): Promise<RuntimeObservationReply>;
  dispose(): void | Promise<void>;
}

export interface JudgeOrdinaryBatchCall extends RuntimePreparedCodeBatchCall {
  /** Called only when the worker has admitted this entry to execute. */
  readonly onCaseStarted?: (index: number) => void;
}

export type JudgeSchedulePhase =
  | 'ordinary-write-attempt'
  | 'ordinary-commit'
  | 'observer-start'
  | 'observer-expire'
  | 'observer-end'
  | 'attachment-bind'
  | 'observation-cache-hit'
  | 'public-resolve';

export interface JudgeScheduleMarker {
  readonly phase: JudgeSchedulePhase;
  readonly evaluationId: string;
  readonly workspaceDigest: string;
  readonly generation: number;
  readonly caseId?: string;
  readonly attemptToken?: string;
  readonly at: number;
}

export interface JudgeReceiptProvider {
  /** Identity of the runtime build selected for this host. */
  readonly runtimeVersion: string;
  readonly capabilities: {
    readonly observationLease: 'separate';
    readonly certification?: 'ends-same';
    /** Backstop for an observer that fails to return a terminal drawing. */
    readonly observationDeadlineMs: number;
    readonly observationPrepareDeadlineMs?: number;
    /** Observation can initialize concurrently with ordinary provider readiness. */
    readonly overlapObservationWithInitialization?: true;
    /** Native stopping batches can acknowledge admission before delivering rows. */
    readonly stoppingBatchAdmission?: 'worker-start';
    readonly nonStoppingBatchAdmission?: 'worker-start';
    /**
     * Each observe() reply is a graph built for that call (decoded from the
     * worker message, parsed or normalized) that the adapter never retains,
     * reuses or mutates once it resolves. The receipt then freezes the reply
     * in place instead of copying it. Declare it only for an audited adapter.
     */
    readonly observationReplyOwnership?: 'transferred';
    /**
     * With a transferred reply: every object in it is a structured clone of a
     * worker message, a JSON.parse result, or plain data the adapter built
     * from those with literals, spreads, array methods and null-prototype
     * records. It then has only enumerable, string-keyed data properties and
     * no proxies, so the receipt checks one prototype per object and one type
     * per value and skips the descriptor walk. The adapter must never add an
     * accessor, a symbol or non-enumerable key, a proxy or a class instance.
     * Ignored without `observationReplyOwnership`. Declare it only for an
     * audited adapter.
     */
    readonly observationReplyProvenance?: 'structured-clone';
    /**
     * When a selected case's ordinary row commits `limit/client-timeout`.
     * `ordinary-budget` (the default): its pending observer gets the ordinary
     * per-case budget, then settles as `observer-timeout`, so Run is released
     * at the ordinary deadline. `backstop`: the observer keeps running until
     * it answers or `observationDeadlineMs` fires.
     */
    readonly runawayObservationRelease?: 'ordinary-budget' | 'backstop';
  };
  prepareObservation(
    program: JudgeObservationProgram,
    signal: AbortSignal,
    traceOptions?: Readonly<TraceExecutionOptions>,
  ): Promise<JudgeObservationLease | ObservationRefusal>;
  /** Private trusted composition journal. Never comes from a request or a worker. */
  mark?(marker: JudgeScheduleMarker): void;
}

/**
 * Bind these adapters in BrowserRuntimeProvider.create(context), where the
 * provider owns its selected assets, transport and language-specific worker
 * and immutable image factories. Each adapter opens separate observer capacity
 * using those factories and owns its lease cleanup. Omit an entry until the
 * language qualifies.
 */
export interface BrowserRuntimeJudgeReceiptLease extends BrowserRuntimeProviderLease {
  readonly judgeReceiptProviders?: ReadonlyMap<Language, JudgeReceiptProvider>;
}

type PreparedProviderResolver = (
  language: Language
) => RuntimePreparedExecutionProvider;

/*
 * BrowserRuntimeHost and Judge are separate package entrypoints. ESM builds
 * share this module through an emitted chunk, but CommonJS entrypoints are
 * intentionally self-contained. Keep the WeakMap on a non-enumerable global
 * symbol so genuine hosts retain their identity across both bundle formats.
 */
const PREPARED_PROVIDER_RESOLVERS = Symbol.for(
  '@tracecode/runtime-browser/internal/prepared-provider-resolvers'
);

function preparedProviderResolvers(): WeakMap<
  object,
  PreparedProviderResolver
> {
  const globalRecord = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globalRecord[PREPARED_PROVIDER_RESOLVERS];
  if (existing !== undefined) {
    if (!(existing instanceof WeakMap)) {
      throw new Error(
        'Browser runtime host provider registry was initialized with an invalid value.'
      );
    }
    return existing as WeakMap<object, PreparedProviderResolver>;
  }

  const resolvers = new WeakMap<object, PreparedProviderResolver>();
  Object.defineProperty(globalRecord, PREPARED_PROVIDER_RESOLVERS, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: resolvers,
  });
  return resolvers;
}

const resolvers = preparedProviderResolvers();

export function registerBrowserRuntimeHostPreparedProviderResolver(
  host: BrowserRuntimeHost,
  resolve: PreparedProviderResolver
): void {
  if (resolvers.has(host)) {
    throw new Error('Browser runtime host was registered more than once.');
  }
  resolvers.set(host, resolve);
}

export function getBrowserRuntimeHostPreparedProvider(
  host: BrowserRuntimeHost,
  language: Language
): RuntimePreparedExecutionProvider {
  const resolve =
    (typeof host === 'object' && host !== null) ||
      typeof host === 'function'
      ? resolvers.get(host)
      : undefined;
  if (!resolve) {
    throw new TypeError(
      'Browser runtime Judge requires a genuine BrowserRuntimeHost created by createBrowserRuntimeHost().'
    );
  }
  return resolve(language);
}

// Keep this separate from the prepared-provider resolver so older entrypoints
// can continue to share the existing prepared resolver in the same realm.
const JUDGE_RECEIPT_PROVIDERS = Symbol.for(
  '@tracecode/runtime-browser/internal/judge-receipt-providers'
);

function judgeReceiptProviders(): WeakMap<object, ReadonlyMap<Language, JudgeReceiptProvider>> {
  const globalRecord = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globalRecord[JUDGE_RECEIPT_PROVIDERS];
  if (existing instanceof WeakMap) return existing;
  const providers = new WeakMap<object, ReadonlyMap<Language, JudgeReceiptProvider>>();
  Object.defineProperty(globalRecord, JUDGE_RECEIPT_PROVIDERS, { value: providers });
  return providers;
}

export function registerBrowserRuntimeHostJudgeReceiptProviders(
  host: BrowserRuntimeHost,
  providers: ReadonlyMap<Language, JudgeReceiptProvider>
): void {
  judgeReceiptProviders().set(host, providers);
}

export function getBrowserRuntimeHostJudgeReceiptProvider(
  host: BrowserRuntimeHost,
  language: Language
): JudgeReceiptProvider | undefined {
  return judgeReceiptProviders().get(host)?.get(language);
}

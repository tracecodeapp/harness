import type {
  CodeExecutionResult,
  Language,
  TraceExecutionOptions,
  RuntimePreparedCodeCall,
  RuntimePreparedCodeBatchCall,
  RuntimePreparedExecutionProvider,
  RuntimePreparedProgram,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
} from '../../packages/runtime-contracts/src/index';
import {
  isTraceUnavailableError,
  RuntimeProviderError,
} from '../../packages/runtime-contracts/src/execution-outcome';
import { RuntimeProgramConcurrencyGate } from '../../packages/runtime-browser/src/program-concurrency-gate';

import type {
  RuntimeObservationReply,
} from '../../packages/runtime-contracts/src/runtime-calls';
import type {
  JudgeObservationLease,
  JudgeObservationProgram,
  JudgeOrdinaryBatchCall,
  JudgeReceiptProvider,
  JudgeScheduleMarker,
  JudgeSchedulePhase,
} from '../../packages/runtime-browser/src/browser-runtime-host-internal';
import { bindJudgeOrdinaryPreparation } from '../../packages/runtime-browser/src/browser-runtime-host-internal';
import type { JudgeAlgorithmBundle, JudgeAlgorithmReceipt } from '../../packages/judge/src/algorithm-model';
import type { Binding } from '../../packages/judge/src/internal/receipt-types';
import type { JudgeEvaluationResult } from '../../packages/judge/src/model';
import { VerdictReceiptStore, type DrawingOwnership } from '../../packages/judge/src/internal/receipt-store';

import type { JudgeTestBridge } from './judge-test-bridge';

type ObservationRefusal = Extract<RuntimeObservationReply, { status: 'refused' }>;
type ObservationPreparation = JudgeObservationLease | ObservationRefusal;

function observationRefused(reason: ObservationRefusal['reason']): ObservationRefusal {
  return { status: 'refused', reason };
}

export function judgeAbortError(): DOMException {
  return new DOMException('The run was aborted.', 'AbortError');
}

function waitForSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

interface ObservationAttempt {
  readonly controller: AbortController;
  /**
   * Ends this attempt as `observer-timeout` once its case's ordinary run has
   * been stopped by the wall clock and the observer has had the same budget.
   * Separate from `controller`, whose abort discards the attempt instead.
   */
  readonly expiry: AbortController;
  readonly token: ReturnType<VerdictReceiptStore['beginObservation']>;
  done: Promise<void>;
  waiters: number;
  settled: boolean;
  /** `performance.now()` at `observer-start`. */
  startedAt?: number;
  /** Observer budget set by an ordinary client-timeout, in ms. */
  expiresAfterMs?: number;
  /** `performance.now()` when that budget was set (ordinary commit or a later click). */
  limitedAt?: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

/** The ordinary role's own wall clock stopped this row. */
function stoppedByOrdinaryClock(row: JudgeEvaluationResult['cases'][number]): boolean {
  return row.status === 'timed-out' && row.failure.origin === 'limit' &&
    row.failure.reason === 'client-timeout';
}

/**
 * The coordinator's journal of one ordinary batch dispatch. The registry
 * forwards each start and finish it learns of; the journal checks the index
 * and fences a batch the service watchdog already stopped.
 */
export interface OrdinaryBatchProgress {
  /** The registry will journal every entry's start (worker ACKs or per-entry calls). */
  acknowledgesStarts(): void;
  started(index: number): void;
  finished(index: number, result: CodeExecutionResult): void;
  /** Progress that arrived after its batch call was stopped or settled. */
  fenced(progress: 'started' | 'finished', index: number): void;
}

/** Owns one prepare journal and the observation lifetime for a committed evaluation. */
export class JudgeObservationSchedule<Result, Expected> {
  private readonly lifetime = new AbortController();
  private readonly gate = new RuntimeProgramConcurrencyGate(1);
  private readonly attempts = new Map<string, ObservationAttempt>();
  private readonly admitted = new Set<string>();
  private readonly inputs: ReadonlyMap<string, Record<string, unknown>>;
  private readonly receipt: VerdictReceiptStore;
  private readonly binding: Omit<Binding, 'caseId'>;
  /**
   * The per-case wall clock the ordinary run had. An observer of a case that
   * clock stopped gets the same budget from its own start, then expires.
   */
  private readonly ordinaryClockMs: number;
  /** Committed cases the ordinary wall clock stopped. */
  private readonly clockStopped = new Set<string>();
  private program?: JudgeObservationProgram;
  private artifact?: Promise<ObservationPreparation>;
  /** Ordinary batch dispatches so far (journal generations). */
  private dispatches = 0;
  /** Accepted journal starts and finishes so far. */
  private sequence = 0;
  private lease?: JudgeObservationLease;
  private settled?: () => void;

  constructor(
    evaluationId: string,
    bundle: JudgeAlgorithmBundle<Record<string, unknown>, Expected, Result>,
    private readonly registration: JudgeReceiptProvider,
    private readonly selected: ReadonlySet<string>,
    private readonly traceOptions: Readonly<TraceExecutionOptions> | undefined,
    private readonly testBridge: JudgeTestBridge | undefined,
    private readonly language: Language
  ) {
    this.binding = { evaluationId, workspaceDigest: bundle.workspaceDigest, generation: 1 };
    this.inputs = new Map(bundle.plan.cases.map(({ id, input }) => [id, input]));
    // A certified producer can never attach a drawing to a row that did not
    // complete (`#certify`), so waiting for its observer gains nothing.
    this.ordinaryClockMs = registration.capabilities.certification ? 0 : bundle.plan.run.timeoutMs ?? 0;
    this.receipt = new VerdictReceiptStore(this.binding, bundle, registration.mark || testBridge
      ? ({ event, binding }) => {
          if (event === 'attachment-bind' || event === 'ordinary-write-attempt') {
            this.mark(event, binding.caseId, this.attempts.get(binding.caseId)?.token.token);
          }
        }
      : undefined,
      registration.capabilities.certification
    );
  }

  recordPrepare(call: RuntimeProgramPreparationCall): void {
    this.program = Object.freeze({
      code: call.code,
      functionName: call.functionName,
      executionStyle: call.executionStyle,
      runtimeVersion: this.registration.runtimeVersion,
    });
    bindJudgeOrdinaryPreparation(this.program, call);
    if (this.selected.size > 0) this.prepareObserver();
  }

  admit(caseId: string): void {
    if (this.lifetime.signal.aborted || this.admitted.has(caseId)) return;
    this.admitted.add(caseId);
    if (this.selected.has(caseId)) this.attempt(caseId);
  }

  commit(evaluation: JudgeEvaluationResult<Result, Expected>): void {
    for (const row of evaluation.cases) {
      this.receipt.commitOrdinary({ ...this.binding, caseId: row.caseId }, row);
    }
    this.mark('ordinary-commit');
    if (evaluation.status === 'compile-failed') {
      this.receipt.seal({ status: 'compile-failed', compile: evaluation.compile });
      return;
    }
    this.receipt.seal({ status: 'completed', compile: evaluation.compile });
    // The verdict is now fixed. A selected case the ordinary clock stopped
    // keeps whatever its observer already delivered (sealing bound it). A
    // pending observer gets the ordinary budget from its own start and then
    // settles as `observer-timeout`, so Run is released at the ordinary
    // deadline rather than the observer backstop.
    // A later click-to-draw on such a case gets the same budget (`attempt`).
    // A provider that opts out keeps the observation backstop.
    if (this.registration.capabilities.runawayObservationRelease === 'backstop') return;
    for (const row of evaluation.cases) {
      if (!stoppedByOrdinaryClock(row)) continue;
      this.clockStopped.add(row.caseId);
      const attempt = this.attempts.get(row.caseId);
      if (attempt && !attempt.settled) this.limitObservation(row.caseId, attempt, this.ordinaryClockMs);
    }
  }

  /**
   * Arm or fire the ordinary-budget expiry of a pending observation attempt.
   * Before observer-start (preparing, or queued behind another selected
   * case) the observer has one budget from when it was limited to start.
   * Once started, the budget counts from its own start, never past
   * `limitedAt + 2 × budget`. Re-armed at observer-start.
   */
  private limitObservation(caseId: string, attempt: ObservationAttempt, budgetMs: number): void {
    const now = globalThis.performance.now();
    attempt.expiresAfterMs = budgetMs;
    attempt.limitedAt ??= now;
    // Subtract elapsed time from the budget rather than `now` from an
    // absolute instant: (t + budget) - t is not always budget in floating
    // point, which would arm the timer a hair late.
    const sinceLimited = now - attempt.limitedAt;
    const remaining = attempt.startedAt === undefined
      ? budgetMs - sinceLimited
      : Math.min(budgetMs - (now - attempt.startedAt), 2 * budgetMs - sinceLimited);
    const expire = () => {
      attempt.expiryTimer = undefined;
      if (attempt.settled || attempt.expiry.signal.aborted || attempt.controller.signal.aborted) return;
      this.mark('observer-expire', caseId, attempt.token.token);
      attempt.expiry.abort(new DOMException('Observation reached the ordinary time limit.', 'TimeoutError'));
    };
    clearTimeout(attempt.expiryTimer);
    if (remaining <= 0) expire();
    else attempt.expiryTimer = setTimeout(expire, remaining);
  }

  /**
   * The sealed verdict with no drawing on any row, whatever has settled, so
   * its shape never depends on a race. Nothing here waits on an observer.
   */
  verdict() {
    return this.receipt.projectReceipt([]) as JudgeAlgorithmReceipt<Result, Expected>;
  }

  /** Joined delivery: the verdict once every selected drawing has settled. */
  async initial(signal: AbortSignal) {
    await Promise.all([...this.selected].map((caseId) => this.waitForDrawing(caseId, signal, false)));
    return this.receipt.projectReceipt([...this.selected]) as JudgeAlgorithmReceipt<Result, Expected>;
  }

  /** Whether an observer attempt is still running (it holds the idle lease). */
  observing(): boolean {
    for (const attempt of this.attempts.values()) {
      if (!attempt.settled) return true;
    }
    return false;
  }

  /** Called after each live attempt settles, so the owner can re-arm its idle lease. */
  onObservationSettled(listener: () => void): void {
    this.settled = listener;
  }

  async continue(caseIds: readonly string[], signal: AbortSignal) {
    const active = AbortSignal.any([signal, this.lifetime.signal]);
    await Promise.all(caseIds.map((caseId) => this.waitForDrawing(caseId, active)));
    active.throwIfAborted();
    return this.receipt.projectEvaluation(caseIds, caseIds);
  }

  mark(
    phase: JudgeSchedulePhase,
    caseId?: string,
    attemptToken?: string,
    journal?: Pick<JudgeScheduleMarker,
      'caseIndex' | 'dispatchGeneration' | 'sequence' | 'progress' | 'reason' | 'cause' | 'accepted' | 'request'>
  ): void {
    if (!this.registration.mark && !this.testBridge) return;
    const marker = {
      phase,
      ...this.binding,
      caseId,
      attemptToken,
      ...journal,
      at: globalThis.performance.now(),
    };
    this.testBridge?.onEvent(Object.freeze(marker));
    this.registration.mark?.(marker);
  }

  /** The next ordinary batch dispatch of this evaluation. */
  beginDispatch(): number {
    return ++this.dispatches;
  }

  /** The coordinator journalled a case's start or finish. */
  journalled(progress: 'started' | 'finished', caseId: string, caseIndex: number, dispatchGeneration: number): void {
    this.sequence += 1;
    this.mark(progress === 'started' ? 'ordinary-case-started' : 'ordinary-case-accepted', caseId, undefined,
      { caseIndex, dispatchGeneration, sequence: this.sequence });
  }

  /** The coordinator refused a case's start or finish; the journal is unchanged. */
  journalRejected(
    progress: 'started' | 'finished',
    caseId: string | undefined,
    caseIndex: number,
    dispatchGeneration: number,
    reason: NonNullable<JudgeScheduleMarker['reason']>
  ): void {
    this.mark('ordinary-case-rejected', caseId, undefined, { caseIndex, dispatchGeneration, progress, reason });
  }

  /**
   * Trusted test control: should the service watchdog expire right after
   * this journalled progress? Acknowledged when it does.
   */
  serviceDeadlineInjected(
    progress: 'started' | 'finished',
    caseId: string,
    caseIndex: number,
    dispatchGeneration: number
  ): boolean {
    if (!this.testBridge?.faultAt) return false;
    const context = { ...this.faultContext(caseId), caseIndex, dispatchGeneration, progress };
    if (this.testBridge.faultAt({ ...context, point: 'service' }) !== 'deadline') return false;
    this.ack(context, 'service', 'deadline');
    return true;
  }

  /** The service watchdog stopped a batch and sealed its journal. */
  serviceDeadline(dispatchGeneration: number, cause: 'backstop' | 'injected', accepted: number): void {
    this.mark('service-deadline', undefined, undefined,
      { dispatchGeneration, sequence: this.sequence, cause, accepted });
  }

  private faultContext(caseId?: string, attemptToken?: string) {
    return { ...this.binding, language: this.language, caseId, attemptToken };
  }

  private ack(
    context: ReturnType<JudgeObservationSchedule<Result, Expected>['faultContext']> & {
      readonly caseIndex?: number;
      readonly dispatchGeneration?: number;
      readonly progress?: 'started' | 'finished';
    },
    point: 'prepare' | 'observe' | 'encode' | 'service',
    fault: 'prepare' | 'runtime' | 'deadline' | 'encode' | 'no-recorder' | 'stall'
  ): void {
    this.testBridge?.onEvent(Object.freeze({
      ...context, phase: 'injection-ack', point, fault, at: globalThis.performance.now(),
    }));
  }

  async dispose(reason: Error = judgeAbortError()): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    this.receipt.dispose();
    this.lifetime.abort(reason);
    for (const attempt of this.attempts.values()) attempt.controller.abort(this.lifetime.signal.reason);
    this.attempts.clear();
    const lease = this.lease;
    this.lease = undefined;
    if (lease) await lease.dispose();
  }

  private prepareObserver(): Promise<ObservationPreparation> {
    // Start ordinary preparation in the current turn before allocating the
    // derived artifact. Both variants refer to the same captured source.
    const program = this.program!;
    return this.artifact ??= Promise.resolve().then(async () => {
      if (this.lifetime.signal.aborted) return observationRefused('observer-prepare');
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
      const timer = setTimeout(
        () => controller.abort(new DOMException('Observer preparation timed out.', 'TimeoutError')),
        this.registration.capabilities.observationPrepareDeadlineMs ?? 30_000
      );
      try {
        if (this.testBridge?.faultAt) {
          const context = this.faultContext();
          if (this.testBridge.faultAt({ ...context, point: 'prepare' }) === 'prepare') {
            this.ack(context, 'prepare', 'prepare');
            return observationRefused('observer-prepare');
          }
        }
        const prepared = this.registration.prepareObservation(program, signal, this.traceOptions).then(async (artifact) => {
          if ('status' in artifact) return artifact;
          if (signal.aborted) await artifact.dispose();
          else this.lease = artifact;
          return artifact;
        });
        return await waitForSignal(prepared, signal);
      } catch (cause) {
        if (controller.signal.aborted) return observationRefused('observer-timeout');
        return observationRefused(isTraceUnavailableError(cause) ? 'unsupported-program' : 'observer-prepare');
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /** How the receipt owns this provider's replies: copied, or adopted with the full or the clone check. */
  private replyOwnership(): DrawingOwnership {
    const { observationReplyOwnership, observationReplyProvenance } = this.registration.capabilities;
    if (observationReplyOwnership !== 'transferred') return 'borrowed';
    return observationReplyProvenance === 'structured-clone' ? 'transferred-clone' : 'transferred';
  }

  private attempt(caseId: string): ObservationAttempt {
    const existing = this.attempts.get(caseId);
    if (existing) return existing;
    const attempt: ObservationAttempt = {
      controller: new AbortController(),
      expiry: new AbortController(),
      token: this.receipt.beginObservation(caseId),
      done: Promise.resolve(),
      waiters: 0,
      settled: false,
    };
    this.attempts.set(caseId, attempt);
    attempt.done = this.draw(caseId, attempt).then((drawing) => {
      attempt.settled = true;
      clearTimeout(attempt.expiryTimer);
      attempt.expiryTimer = undefined;
      if (this.attempts.get(caseId) === attempt && !attempt.controller.signal.aborted) {
        this.receipt.publishDrawing(attempt.token, attempt.token.binding, drawing, this.replyOwnership());
        this.settled?.();
      }
    });
    if (this.clockStopped.has(caseId)) this.limitObservation(caseId, attempt, this.ordinaryClockMs);
    return attempt;
  }

  /**
   * Waits for one case's drawing. `continuation` marks a cache hit; the joined
   * initial request never does.
   */
  private async waitForDrawing(caseId: string, signal: AbortSignal, continuation = true): Promise<void> {
    signal.throwIfAborted();
    if (!this.admitted.has(caseId)) {
      if (continuation && this.receipt.hasCachedNotRunAttachment(caseId)) this.mark('observation-cache-hit', caseId);
      return;
    }
    // Coalescing: every request for a case joins its one live attempt, which
    // may have started at ordinary admission, before the verdict.
    const attempt = this.attempt(caseId);
    if (attempt.settled) {
      if (continuation) this.mark('observation-cache-hit', caseId, attempt.token.token);
      return;
    }
    attempt.waiters += 1;
    await new Promise<void>((resolve, reject) => {
      let waiting = true;
      const detach = () => {
        if (!waiting) return;
        waiting = false;
        signal.removeEventListener('abort', abort);
        attempt.waiters -= 1;
        // The last waiter's abort cancels and evicts an unsettled attempt
        // that some request joined; the next request starts a new one. An
        // attempt started at admission that no request has joined has no
        // waiters, so it keeps running after the verdict until it settles.
        if (!attempt.settled && attempt.waiters === 0 && this.attempts.get(caseId) === attempt) {
          this.attempts.delete(caseId);
          this.receipt.cancelObservation(attempt.token);
          attempt.controller.abort(judgeAbortError());
        }
      };
      const abort = () => {
        detach();
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      attempt.done.then(() => {
        detach();
        resolve();
      }, (error: unknown) => {
        detach();
        reject(error);
      });
    });
  }

  private async draw(caseId: string, attempt: ObservationAttempt): Promise<RuntimeObservationReply> {
    // Expiry ends the attempt with a terminal refusal; the controller's abort
    // discards it. Either stops the observer.
    const signal = AbortSignal.any([attempt.controller.signal, attempt.expiry.signal]);
    const expired = () => attempt.expiry.signal.aborted && !attempt.controller.signal.aborted;
    try {
      return await this.gate.run(signal, async () => {
        const lease = await waitForSignal(this.prepareObserver(), signal);
        if ('status' in lease) return lease;
        signal.throwIfAborted();
        const deadline = new AbortController();
        const observationSignal = AbortSignal.any([signal, deadline.signal]);
        const timer = setTimeout(
          () => deadline.abort(new DOMException('Observation timed out.', 'TimeoutError')),
          this.registration.capabilities.observationDeadlineMs
        );
        const attemptToken = attempt.token.token;
        this.mark('observer-start', caseId, attemptToken);
        attempt.startedAt = globalThis.performance.now();
        if (attempt.expiresAfterMs !== undefined) {
          this.limitObservation(caseId, attempt, attempt.expiresAfterMs);
        }
        try {
          const context = this.testBridge?.faultAt && this.faultContext(caseId, attemptToken);
          const fault = context && this.testBridge?.faultAt?.({ ...context, point: 'observe' });
          if (context && fault === 'runtime') {
            this.ack(context, 'observe', fault);
            return observationRefused('observer-runtime');
          }
          if (context && fault === 'stall') {
            this.ack(context, 'observe', fault);
            const release = this.testBridge?.releaseStall?.(context) ?? new Promise<never>(() => undefined);
            await waitForSignal(release, observationSignal);
          }
          const call = {
            program: this.program!,
            inputs: structuredClone(this.inputs.get(caseId)!),
            traceOptions: this.traceOptions,
            attemptToken,
            signal: observationSignal,
          };
          const withoutRecorder = this.language === 'javascript' && fault === 'no-recorder'
            ? lease.observeWithoutRecorderForTest
            : undefined;
          const work = waitForSignal(
            withoutRecorder ? withoutRecorder.call(lease, call) : lease.observe(call), observationSignal
          );
          if (context && fault === 'deadline') {
            deadline.abort(new DOMException('Observation timed out.', 'TimeoutError'));
            this.ack(context, 'observe', fault);
          }
          const drawing = await work;
          if (context && withoutRecorder && drawing.status === 'refused' &&
            drawing.reason === 'recorder-unavailable') {
            this.ack(context, 'observe', 'no-recorder');
          }
          if (context && (drawing?.status === 'drawn' || drawing?.status === 'truncated') &&
            this.testBridge?.faultAt?.({ ...context, point: 'encode' }) === 'encode') {
            this.ack(context, 'encode', 'encode');
            return observationRefused('observer-encode');
          }
          return drawing;
        } catch (cause) {
          if (deadline.signal.aborted || expired()) return observationRefused('observer-timeout');
          return observationRefused(isTraceUnavailableError(cause) ? 'unsupported-program' : 'observer-runtime');
        } finally {
          clearTimeout(timer);
          this.mark('observer-end', caseId, attemptToken);
        }
      });
    } catch {
      // Expired while preparing or queued: the observer never got to run.
      return observationRefused(expired() ? 'observer-timeout' : 'observer-runtime');
    }
  }
}

export function isPreparedExecutionProvider(
  provider: object
): provider is RuntimePreparedExecutionProvider {
  return (
    'prepareProgram' in provider &&
    typeof provider.prepareProgram === 'function'
  );
}

interface PreparedEvaluationState {
  closed: boolean;
  preparing: boolean;
  program?: RuntimePreparedProgram;
  gate?: RuntimeProgramConcurrencyGate;
}

/**
 * A preparation that breaks the registry's ownership contract is a provider
 * or orchestration defect, never the learner's compile failure.
 */
function invalidPreparation(message: string): never {
  throw new RuntimeProviderError(message);
}

/**
 * Private ownership boundary for provider artifacts.
 *
 * Each evaluation may prepare one program. Cases share only its immutable
 * artifact and are throttled to the provider-declared concurrency limit. The
 * provider remains responsible for fresh mutable language state on every
 * executeIsolated call.
 */
export class RuntimePreparedProgramRegistry {
  private readonly evaluations = new Map<string, PreparedEvaluationState>();
  private readonly disposedPrograms = new WeakSet<object>();

  constructor(
    private readonly provider: RuntimePreparedExecutionProvider
  ) {}

  begin(evaluationId: string): void {
    if (this.evaluations.has(evaluationId)) {
      throw new Error(
        `Prepared runtime evaluation ${JSON.stringify(evaluationId)} already exists.`
      );
    }
    this.evaluations.set(evaluationId, {
      closed: false,
      preparing: false,
    });
  }

  async prepare(
    evaluationId: string,
    call: RuntimeProgramPreparationCall
  ): Promise<RuntimeProgramPreparationResult> {
    const state = this.requireState(evaluationId);
    if (call.mode !== 'code') {
      // Grades come only from ordinary programs; observers own their own
      // instrumented artifacts and never reach this registry.
      invalidPreparation('The Judge prepares only ordinary (code-mode) programs.');
    }
    if (state.closed) {
      invalidPreparation('Prepared runtime evaluation is already closed.');
    }
    if (state.preparing || state.program) {
      invalidPreparation(
        'Prepared runtime evaluation may prepare exactly one program.'
      );
    }
    state.preparing = true;
    try {
      const result = await this.provider.prepareProgram(call);
      if (result.kind !== 'prepared') return result;

      const program = result.program;
      const maximum = program.capabilities.maxConcurrency;
      if (program.mode !== call.mode) {
        await this.disposeOnce(program);
        invalidPreparation(
          `Prepared runtime returned ${JSON.stringify(program.mode)} mode ` +
          `for a ${JSON.stringify(call.mode)} preparation.`
        );
      }
      if (
        program.capabilities.caseIsolation !== 'fresh-case-state' ||
        !Number.isSafeInteger(maximum) ||
        maximum < 1
      ) {
        await this.disposeOnce(program);
        invalidPreparation(
          'Prepared runtime must guarantee fresh-case-state isolation and a ' +
          'positive integer maxConcurrency.'
        );
      }
      if (state.closed) {
        try {
          await this.disposeOnce(program);
        } catch {
          // The evaluation has already been interrupted. Teardown was still
          // attempted exactly once; the active evaluation owns no result path
          // on which a late disposal error could be reported.
        }
        invalidPreparation(
          'Prepared runtime evaluation closed before preparation completed.'
        );
      }
      state.program = program;
      state.gate = new RuntimeProgramConcurrencyGate(maximum);
      return result;
    } finally {
      state.preparing = false;
    }
  }

  executeCode(
    evaluationId: string,
    call: RuntimePreparedCodeCall,
    admit?: () => void
  ): Promise<CodeExecutionResult> {
    const { program, gate } = this.preparedState(evaluationId);
    if (program.mode !== 'code') {
      return Promise.reject(
        new Error('Tracing prepared program cannot execute a code-only case.')
      );
    }
    return gate.run(call.signal, () => {
      admit?.();
      return program.executeIsolated(call);
    });
  }

  /**
   * The prepared program's batch path stops itself at the first runaway case
   * (`capabilities.stopsAtFirstRunaway`), so a stopping evaluation can send
   * one batch instead of one request per case.
   */
  stopsAtFirstRunaway(evaluationId: string): boolean {
    const { program } = this.preparedState(evaluationId);
    return program.capabilities.stopsAtFirstRunaway === true &&
      typeof program.executeBatchIsolated === 'function';
  }

  executeCodeBatch(
    evaluationId: string,
    call: RuntimePreparedCodeBatchCall,
    admit?: (index: number) => void,
    acknowledgeStarts = false,
    journal?: OrdinaryBatchProgress
  ): Promise<readonly CodeExecutionResult[]> {
    const { program, gate } = this.preparedState(evaluationId);
    if (program.mode !== 'code') {
      return Promise.reject(
        new Error('Tracing prepared program cannot execute a code-only batch.')
      );
    }
    if (program.executeBatchIsolated) {
      return gate.run(call.signal, async () => {
        const acknowledged = acknowledgeStarts && admit !== undefined;
        if (!acknowledged && !call.stopAtFirstRunaway) call.inputBatch.forEach((_, index) => admit?.(index));
        if (!acknowledged && !journal) return program.executeBatchIsolated!(call);
        let live = true;
        // Admission and the journal take progress only while the call runs.
        const open = () => live && !call.signal?.aborted;
        if (acknowledged) journal?.acknowledgesStarts();
        const progressBatch: JudgeOrdinaryBatchCall = {
          ...call,
          ...(acknowledged ? {
            onCaseStarted: (index: number) => {
              if (!open()) {
                journal?.fenced('started', index);
                return;
              }
              if (Number.isSafeInteger(index) && index >= 0 && index < call.inputBatch.length) admit!(index);
              // The journal checks the index itself.
              journal?.started(index);
            },
          } : {}),
          ...(journal ? {
            onCaseFinished: (index: number, result: CodeExecutionResult) => {
              if (open()) journal.finished(index, result);
              else journal.fenced('finished', index);
            },
          } : {}),
        };
        try {
          return await program.executeBatchIsolated!(progressBatch);
        } finally {
          live = false;
        }
      });
    }
    // No native batch: each entry is its own call, so its start and its
    // finish are the coordinator's to journal, while the batch runs.
    journal?.acknowledgesStarts();
    let live = true;
    const open = () => live && !call.signal?.aborted;
    return Promise.all(
      call.inputBatch.map((inputs, index) =>
        gate.run(call.signal, async () => {
          if (journal && !open()) {
            // An earlier entry already failed the batch: run nothing more.
            journal.fenced('started', index);
            throw new Error('The prepared batch already failed.');
          }
          admit?.(index);
          journal?.started(index);
          try {
            const result = await program.executeIsolated({
              inputs,
              signal: call.signal,
              limits: call.limits,
            });
            if (open()) journal?.finished(index, result);
            else journal?.fenced('finished', index);
            return result;
          } catch (error) {
            live = false;
            throw error;
          }
        })
      )
    ).finally(() => {
      live = false;
    });
  }

  async dispose(evaluationId: string): Promise<void> {
    const state = this.evaluations.get(evaluationId);
    if (!state) return;
    this.evaluations.delete(evaluationId);
    state.closed = true;
    if (state.program) {
      const program = state.program;
      state.program = undefined;
      state.gate = undefined;
      await this.disposeOnce(program);
    }
  }

  private preparedState(evaluationId: string): {
    readonly program: RuntimePreparedProgram;
    readonly gate: RuntimeProgramConcurrencyGate;
  } {
    const state = this.requireState(evaluationId);
    if (state.closed || !state.program || !state.gate) {
      throw new Error(
        `Prepared runtime evaluation ${JSON.stringify(evaluationId)} ` +
        'does not own a prepared program.'
      );
    }
    return {
      program: state.program,
      gate: state.gate,
    };
  }

  private requireState(evaluationId: string): PreparedEvaluationState {
    const state = this.evaluations.get(evaluationId);
    if (!state) {
      throw new Error(
        `Unknown prepared runtime evaluation ${JSON.stringify(evaluationId)}.`
      );
    }
    return state;
  }

  private async disposeOnce(program: RuntimePreparedProgram): Promise<void> {
    if (this.disposedPrograms.has(program)) return;
    this.disposedPrograms.add(program);
    await program.dispose();
  }
}

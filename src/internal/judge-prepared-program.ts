import type {
  CodeExecutionResult,
  Language,
  ExecutionResult,
  TraceExecutionOptions,
  RuntimePreparedCodeCall,
  RuntimePreparedCodeBatchCall,
  RuntimePreparedExecutionProvider,
  RuntimePreparedProgram,
  RuntimePreparedTraceBatchCall,
  RuntimePreparedTraceCall,
  RuntimeProgramPreparationCall,
  RuntimeProgramPreparationResult,
} from '../../packages/runtime-contracts/src/index';
import {
  isTraceUnavailableError,
  RuntimeProviderError,
} from '../../packages/runtime-contracts/src/execution-outcome';
import { RuntimeProgramConcurrencyGate } from '../../packages/runtime-browser/src/program-concurrency-gate';

import type {
  Drawing,
  RuntimeObservationCall,
} from '../../packages/runtime-contracts/src/runtime-calls';
import type {
  JudgeObservationLease,
  JudgeObservationProgram,
  JudgeOrdinaryBatchCall,
  JudgeReceiptProvider,
  JudgeSchedulePhase,
} from '../../packages/runtime-browser/src/browser-runtime-host-internal';
import type { JudgeAlgorithmBundle, JudgeAlgorithmReceipt } from '../../packages/judge/src/algorithm-model';
import type { Binding } from '../../packages/judge/src/internal/receipt-types';
import type { JudgeEvaluationResult } from '../../packages/judge/src/model';
import { VerdictReceiptStore } from '../../packages/judge/src/internal/receipt-store';

import type { JudgeTestBridge } from './judge-test-bridge';

type ObservationRefusal = Extract<Drawing, { status: 'refused' }>;
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
  readonly token: ReturnType<VerdictReceiptStore['beginObservation']>;
  done: Promise<void>;
  waiters: number;
  settled: boolean;
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
  private program?: JudgeObservationProgram;
  private artifact?: Promise<ObservationPreparation>;
  private lease?: JudgeObservationLease;

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
    this.receipt = new VerdictReceiptStore(this.binding, bundle, registration.mark || testBridge
      ? ({ event, binding }) => {
          if (event === 'attachment-bind' || event === 'ordinary-write-attempt') {
            this.mark(event, binding.caseId, this.attempts.get(binding.caseId)?.token.token);
          }
        }
      : undefined);
  }

  recordPrepare(call: RuntimeObservationCall['program']): void {
    this.program = Object.freeze({
      code: call.code,
      functionName: call.functionName,
      executionStyle: call.executionStyle,
      runtimeVersion: this.registration.runtimeVersion,
    });
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
    } else {
      this.receipt.seal({ status: 'completed', compile: evaluation.compile });
    }
  }

  async initial(signal: AbortSignal) {
    await waitForSignal(Promise.all(
      [...this.selected].map((caseId) => this.attempts.get(caseId)?.done)
    ), signal);
    return this.receipt.projectReceipt([...this.selected]) as JudgeAlgorithmReceipt<Result, Expected>;
  }

  async continue(caseIds: readonly string[], signal: AbortSignal) {
    const active = AbortSignal.any([signal, this.lifetime.signal]);
    await Promise.all(caseIds.map((caseId) => this.waitForDrawing(caseId, active)));
    active.throwIfAborted();
    return this.receipt.projectEvaluation(caseIds, caseIds);
  }

  mark(phase: JudgeSchedulePhase, caseId?: string, attemptToken?: string): void {
    if (!this.registration.mark && !this.testBridge) return;
    const marker = {
      phase,
      ...this.binding,
      caseId,
      attemptToken,
      at: globalThis.performance.now(),
    };
    this.testBridge?.onEvent(Object.freeze(marker));
    this.registration.mark?.(marker);
  }

  private faultContext(caseId?: string, attemptToken?: string) {
    return { ...this.binding, language: this.language, caseId, attemptToken };
  }

  private ack(
    context: ReturnType<JudgeObservationSchedule<Result, Expected>['faultContext']>,
    point: 'prepare' | 'observe' | 'encode',
    fault: 'prepare' | 'runtime' | 'deadline' | 'encode'
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

  private attempt(caseId: string): ObservationAttempt {
    const existing = this.attempts.get(caseId);
    if (existing) return existing;
    const attempt: ObservationAttempt = {
      controller: new AbortController(),
      token: this.receipt.beginObservation(caseId),
      done: Promise.resolve(),
      waiters: 0,
      settled: false,
    };
    this.attempts.set(caseId, attempt);
    attempt.done = this.draw(caseId, attempt).then((drawing) => {
      attempt.settled = true;
      if (this.attempts.get(caseId) === attempt && !attempt.controller.signal.aborted) {
        this.receipt.publishDrawing(attempt.token, attempt.token.binding, drawing);
      }
    });
    return attempt;
  }

  private async waitForDrawing(caseId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.admitted.has(caseId)) return;
    const attempt = this.attempt(caseId);
    if (attempt.settled) {
      this.mark('observation-cache-hit', caseId, attempt.token.token);
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

  private async draw(caseId: string, attempt: ObservationAttempt): Promise<Drawing> {
    const signal = attempt.controller.signal;
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
        try {
          const context = this.testBridge?.faultAt && this.faultContext(caseId, attemptToken);
          const fault = context && this.testBridge?.faultAt?.({ ...context, point: 'observe' });
          if (context && fault === 'runtime') {
            this.ack(context, 'observe', fault);
            return observationRefused('observer-runtime');
          }
          const work = waitForSignal(lease.observe({
            program: this.program!,
            inputs: structuredClone(this.inputs.get(caseId)!),
            traceOptions: this.traceOptions,
            attemptToken,
            signal: observationSignal,
          }), observationSignal);
          if (context && fault === 'deadline') {
            deadline.abort(new DOMException('Observation timed out.', 'TimeoutError'));
            this.ack(context, 'observe', fault);
          }
          const drawing = await work;
          if (context && (drawing?.status === 'drawn' || drawing?.status === 'truncated') &&
            this.testBridge?.faultAt?.({ ...context, point: 'encode' }) === 'encode') {
            this.ack(context, 'encode', 'encode');
            return observationRefused('observer-encode');
          }
          return drawing;
        } catch (cause) {
          if (deadline.signal.aborted) return observationRefused('observer-timeout');
          return observationRefused(isTraceUnavailableError(cause) ? 'unsupported-program' : 'observer-runtime');
        } finally {
          clearTimeout(timer);
          this.mark('observer-end', caseId, attemptToken);
        }
      });
    } catch {
      return observationRefused('observer-runtime');
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
    acknowledgeStarts = false
  ): Promise<readonly CodeExecutionResult[]> {
    const { program, gate } = this.preparedState(evaluationId);
    if (program.mode !== 'code') {
      return Promise.reject(
        new Error('Tracing prepared program cannot execute a code-only batch.')
      );
    }
    if (program.executeBatchIsolated) {
      return gate.run(call.signal, async () => {
        if (!call.stopAtFirstRunaway) call.inputBatch.forEach((_, index) => admit?.(index));
        if (!acknowledgeStarts || !admit) return program.executeBatchIsolated!(call);
        let live = true;
        const admittedBatch: JudgeOrdinaryBatchCall = {
          ...call,
          onCaseStarted: (index) => {
            if (live && !call.signal?.aborted && Number.isSafeInteger(index)
              && index >= 0 && index < call.inputBatch.length) {
              admit(index);
            }
          },
        };
        try {
          return await program.executeBatchIsolated!(admittedBatch);
        } finally {
          live = false;
        }
      });
    }
    return Promise.all(
      call.inputBatch.map((inputs, index) =>
        gate.run(call.signal, () => {
          admit?.(index);
          return program.executeIsolated({
            inputs,
            signal: call.signal,
            limits: call.limits,
          });
        })
      )
    );
  }

  executeTrace(
    evaluationId: string,
    call: RuntimePreparedTraceCall
  ): Promise<ExecutionResult> {
    const { program, gate } = this.preparedState(evaluationId);
    if (program.mode !== 'trace') {
      return Promise.reject(
        new Error('Code-only prepared program cannot execute a tracing case.')
      );
    }
    return gate.run(call.signal, () => program.executeIsolated(call));
  }

  executeTraceBatch(
    evaluationId: string,
    call: RuntimePreparedTraceBatchCall
  ): Promise<readonly ExecutionResult[]> {
    const { program, gate } = this.preparedState(evaluationId);
    if (program.mode !== 'trace') {
      return Promise.reject(
        new Error('Code-only prepared program cannot execute a tracing batch.')
      );
    }
    if (
      call.traceEnabledBatch !== undefined &&
      (
        call.traceEnabledBatch.length !== call.inputBatch.length ||
        call.traceEnabledBatch.some((enabled) => typeof enabled !== 'boolean')
      )
    ) {
      return Promise.reject(
        new TypeError(
          'Prepared trace selection must contain one boolean per batch case.'
        )
      );
    }
    if (program.executeBatchIsolated) {
      return gate.run(call.signal, () => program.executeBatchIsolated!(call));
    }
    return Promise.all(
      call.inputBatch.map((inputs, index) =>
        gate.run(call.signal, () =>
          program.executeIsolated({
            inputs,
            ...(call.traceEnabledBatch === undefined
              ? {}
              : { recordTrace: call.traceEnabledBatch[index] }),
            signal: call.signal,
            limits: call.limits,
          })
        )
      )
    );
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

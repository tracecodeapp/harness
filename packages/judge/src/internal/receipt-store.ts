import {
  RUNTIME_TRACE_SCHEMA_VERSION,
  type RuntimeTrace,
} from '../../../runtime-contracts/src/runtime-trace';
import type { ObservationFinalState } from '../../../runtime-contracts/src/runtime-calls';
import { structuralJsonComparator } from '../comparison';
import { compareObservationValues } from '../comparator-strategy';
import { createAlgorithmJudgeReceipt } from '../algorithm-evaluate';
import type { JudgeAlgorithmBundle, JudgeAlgorithmReceipt } from '../algorithm-model';
import type { JudgeCaseResult, JudgeEvaluationResult } from '../model';
import type { Attachment, Binding, Cut, Drawing, Frozen, OrdinaryRow, Refusal, Row, VerdictReceipt } from './receipt-types';

type ReceiptScope = Omit<Binding, 'caseId'>;
type ReceiptContext = Pick<JudgeAlgorithmBundle, 'id' | 'workspaceDigest' | 'policy' | 'facts'>;
type SealDecision = Omit<Extract<JudgeEvaluationResult, { status: 'completed' }>, 'planId' | 'cases'>
  | Omit<Extract<JudgeEvaluationResult, { status: 'compile-failed' }>, 'planId' | 'cases'>;

/** Host-issued attempt. The owner accepts only the original token object. */
export type ObservationAttempt = Readonly<{
  binding: Binding;
  token: string;
}>;

interface AttemptState {
  readonly attempt: ObservationAttempt;
  candidate?: Frozen<{ drawing: Drawing; finalState?: ObservationFinalState }>;
}

export type ReceiptJournalEvent = Readonly<{
  event: 'ordinary-write-attempt' | 'ordinary-commit' | 'attachment-bind';
  binding: Binding;
}>;

const cuts = {
  'step-budget': true,
  'line-budget': true,
  'single-line-budget': true,
  'stored-event-budget': true,
  'byte-budget': true,
  'observer-deadline': true,
  'depth-budget': true,
} satisfies Record<Cut, true>;

const refusals = {
  'recorder-unavailable': true,
  'unsupported-program': true,
  'unsupported-option': true,
  'observer-prepare': true,
  'observer-encode': true,
  'observer-runtime': true,
  'observer-protocol': true,
  'observer-timeout': true,
  'uncertified-drawing': true,
  'case-not-run': true,
} satisfies Record<Refusal, true>;

function matches(binding: Binding, reply: Binding): boolean {
  return binding.evaluationId === reply.evaluationId
    && binding.workspaceDigest === reply.workspaceDigest
    && binding.caseId === reply.caseId
    && binding.generation === reply.generation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Checks the envelope. Recorder provenance and event validity belong to the trusted adapter. */
function isTrace(value: unknown): value is RuntimeTrace {
  return isRecord(value)
    && value.schemaVersion === RUNTIME_TRACE_SCHEMA_VERSION
    && typeof value.language === 'string'
    && typeof value.runId === 'string'
    && Array.isArray(value.events)
    && nonnegativeInteger(value.lineEventCount)
    && nonnegativeInteger(value.traceStepCount);
}

function refuse(reason: Refusal): Frozen<Extract<Drawing, { status: 'refused' }>> {
  return Object.freeze({ status: 'refused', reason });
}

/** Makes one reply value the receipt's own: a frozen copy, or the value itself frozen in place. */
type Own = <T>(value: T) => Frozen<T>;

/**
 * Builds the receipt's own envelope. Each envelope field is read once, and the
 * trace is owned before it is checked, so the checks read the graph the
 * receipt keeps.
 */
function readDrawing(message: unknown, own: Own): Frozen<Drawing> {
  if (!isRecord(message)) return refuse('observer-protocol');
  const { status, reason, trace: reply, attemptedEvents } = message;
  // Only the receipt owner knows whether the ordinary case ran.
  if (status === 'refused' && typeof reason === 'string'
    && reason !== 'case-not-run' && Object.hasOwn(refusals, reason)) {
    return refuse(reason as Refusal);
  }
  const cut = status === 'truncated' && typeof reason === 'string' && Object.hasOwn(cuts, reason)
    ? reason as Cut
    : undefined;
  if (status !== 'drawn' && !cut) return refuse('observer-protocol');
  const trace = own(reply) as unknown;
  if (!isTrace(trace)) return refuse('observer-protocol');
  if (!cut) return Object.freeze({ status: 'drawn', trace });
  if (cut === 'observer-deadline' && trace.events.length === 0) {
    return refuse('observer-timeout');
  }
  if (nonnegativeInteger(attemptedEvents) && attemptedEvents > 0 && attemptedEvents >= trace.events.length) {
    return Object.freeze({ status: 'truncated', reason: cut, trace, attemptedEvents });
  }
  return refuse('observer-protocol');
}

function readFinalState(message: unknown, own: Own): Frozen<ObservationFinalState> | undefined {
  if (!isRecord(message)) return;
  const finalState = message.finalState;
  if (!isRecord(finalState)) return;
  const { status, console, value } = finalState;
  if (typeof console !== 'string') return;
  switch (status) {
    case 'compile-failed':
    case 'trapped':
    case 'timed-out':
      return Object.freeze({ status, console });
    case 'completed': {
      if (!isRecord(value) || typeof value.present !== 'boolean') return;
      return Object.freeze({
        status, console,
        value: Object.freeze(value.present ? { present: true, value: own(value.value) } : { present: false }),
      });
    }
  }
}

/**
 * Own the portable payload before freezing it. Copy data properties in order,
 * keeping sparse arrays, undefined fields, aliases and cycles. An iterative
 * walk lets large judged graphs retain their original shape at any depth.
 */
function snapshot<T>(value: T, omitRootKeys?: ReadonlySet<string>): Frozen<T> {
  const seen = new WeakMap<object, object>();
  const pending: { source: object; copy: object }[] = [];

  function copyValue(source: unknown): unknown {
    if (typeof source === 'function' || typeof source === 'symbol') {
      throw new TypeError('Judge receipt payload must be portable data.');
    }
    if (source === null || typeof source !== 'object') return source;
    const existing = seen.get(source);
    if (existing) return existing;

    const prototype = Object.getPrototypeOf(source);
    if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) {
      throw new TypeError('Judge receipt payload must contain only plain records and arrays.');
    }
    const copy = Array.isArray(source) ? new Array(source.length) : Object.create(prototype);
    seen.set(source, copy);
    pending.push({ source, copy });
    return copy;
  }

  const root = copyValue(value);
  for (const { source, copy } of pending) {
    for (const key of Reflect.ownKeys(source)) {
      if (Array.isArray(source) && key === 'length') continue;
      if (source === value && typeof key === 'string' && omitRootKeys?.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(source, key)!;
      if (typeof key !== 'string' || !('value' in descriptor)) {
        throw new TypeError('Judge receipt payload must contain only data properties.');
      }
      Object.defineProperty(copy, key, {
        value: copyValue(descriptor.value),
        enumerable: descriptor.enumerable,
      });
    }
    Object.freeze(copy);
  }
  return root as Frozen<T>;
}

const notOwned = Symbol('not exclusively owned');

/**
 * Takes ownership of a graph a trusted adapter transferred: one that it built
 * for this reply and never retains, reuses or mutates. Each node is checked as
 * snapshot() checks it, then frozen in place, so no node is copied.
 *
 * Every node is frozen before its properties are read. A data property of a
 * frozen object can no longer change, and the proxy invariants hold even an
 * exotic object to the frozen values it reports. A node that was already
 * non-extensible was frozen by someone else, for example an earlier receipt
 * or a producer cache, so this receipt cannot own it exclusively. The value
 * that reaches such a node is copied instead.
 *
 * One adoption serves one reply, so a node shared by the trace and the final
 * state is adopted once.
 */
class Adoption {
  readonly #owned = new Set<object>();

  readonly own: Own = <T>(value: T): Frozen<T> => {
    try {
      return this.#adopt(value);
    } catch (error) {
      if (error === notOwned) return snapshot(value);
      throw error;
    }
  };

  #adopt<T>(value: T): Frozen<T> {
    const owned = this.#owned;
    const adopted: object[] = [];
    const visit = (node: unknown): void => {
      if (typeof node === 'function' || typeof node === 'symbol') {
        throw new TypeError('Judge receipt payload must be portable data.');
      }
      if (node === null || typeof node !== 'object' || owned.has(node)) return;
      if (!Object.isExtensible(node)) throw notOwned;
      const prototype = Object.getPrototypeOf(node);
      if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) {
        throw new TypeError('Judge receipt payload must contain only plain records and arrays.');
      }
      owned.add(node);
      adopted.push(node);
      Object.freeze(node);
    };
    try {
      visit(value);
      for (let index = 0; index < adopted.length; index += 1) {
        const node = adopted[index]!;
        const array = Array.isArray(node);
        for (const key of Reflect.ownKeys(node)) {
          const descriptor = Reflect.getOwnPropertyDescriptor(node, key)!;
          if (typeof key !== 'string' || !('value' in descriptor)) {
            throw new TypeError('Judge receipt payload must contain only data properties.');
          }
          if (!array || key !== 'length') visit(descriptor.value);
        }
      }
    } catch (error) {
      // These nodes are frozen but not all checked. A later value in this
      // reply that reaches one must treat it as not owned.
      for (const node of adopted) owned.delete(node);
      throw error;
    }
    return value as Frozen<T>;
  }
}

/**
 * Who owns the reply passed to publishDrawing. 'borrowed' replies are copied.
 * A 'transferred' reply is one the adapter built for this call and will never
 * retain, reuse or mutate; the store adopts it in place (see Adoption).
 */
export type DrawingOwnership = 'borrowed' | 'transferred';

const observationFields = new Set(['trace', 'attachment']);

/**
 * Coordinator-owned. Only the ordinary branch hands rows to commitOrdinary.
 * Observer leases receive a RuntimeObservationCall and return a drawing,
 * with no reference to this owner or its writer.
 */
export class VerdictReceiptStore {
  readonly #context: ReceiptContext;
  readonly #planId: string;
  readonly #certification?: 'ends-same';
  readonly #comparison?: JudgeAlgorithmBundle['comparison'];
  readonly #bindings = new Map<string, Binding>();
  readonly #rows = new Map<string, Row>();
  // Canonical binding objects carry the scope and case. Attempt identity
  // additionally fences old callbacks when the same binding is retried.
  readonly #attempts = new Map<Binding, AttemptState>();
  readonly #attachments = new Map<Binding, Attachment>();
  readonly #testJournal?: (event: ReceiptJournalEvent) => void;
  #receipt?: VerdictReceipt;
  #nextAttempt = 0;
  #disposed = false;

  constructor(
    scope: ReceiptScope,
    bundle: JudgeAlgorithmBundle,
    testJournal?: (event: ReceiptJournalEvent) => void,
    certification?: 'ends-same',
  ) {
    if (scope.workspaceDigest !== bundle.workspaceDigest) {
      throw new Error('Receipt scope does not match the bundle workspace.');
    }
    const { id, workspaceDigest, policy, facts } = bundle;
    const { evaluationId, generation } = scope;
    this.#context = snapshot({ id, workspaceDigest, policy, facts });
    this.#planId = bundle.plan.id;
    this.#testJournal = testJournal;
    this.#certification = certification;
    this.#comparison = certification && bundle.comparison ? snapshot(bundle.comparison) : undefined;
    for (const { id: caseId } of bundle.plan.cases) {
      if (this.#bindings.has(caseId)) throw new Error(`Duplicate receipt case ${caseId}.`);
      this.#bindings.set(caseId, Object.freeze({ evaluationId, workspaceDigest, caseId, generation }));
    }
  }

  #requireLive(): void {
    if (this.#disposed) throw new Error('Judge receipt owner is disposed.');
  }

  #binding(caseId: string): Binding {
    const binding = this.#bindings.get(caseId);
    if (!binding) throw new Error(`Unknown receipt case ${caseId}.`);
    return binding;
  }

  #record(event: ReceiptJournalEvent['event'], binding: Binding): void {
    this.#testJournal?.(Object.freeze({ event, binding }));
  }

  commitOrdinary(binding: Binding, result: OrdinaryRow<JudgeCaseResult>): Row {
    if (this.#testJournal) this.#record('ordinary-write-attempt', Object.freeze({ ...binding }));
    this.#requireLive();
    const expected = this.#binding(binding.caseId);
    if (!matches(expected, binding) || result.caseId !== expected.caseId) {
      throw new Error('Ordinary row binding mismatch.');
    }
    if (this.#rows.has(expected.caseId)) throw new Error('Ordinary row already committed.');
    if (this.#receipt) throw new Error('Ordinary receipt already sealed.');

    const row = snapshot(result, observationFields);
    this.#rows.set(expected.caseId, row);
    this.#record('ordinary-commit', expected);
    return row;
  }

  seal(decision: SealDecision, evaluatedAt?: string): VerdictReceipt {
    this.#requireLive();
    if (this.#receipt) throw new Error('Ordinary receipt already sealed.');
    const receipt = createAlgorithmJudgeReceipt(
      this.#context,
      this.#ordinaryEvaluation(decision),
      evaluatedAt,
    );
    this.#receipt = Object.freeze({ ...receipt, policy: snapshot(receipt.policy) });
    if (this.#receipt.evaluation.status === 'compile-failed') {
      this.#attempts.clear();
    } else {
      for (const { attempt, candidate } of this.#attempts.values()) {
        if (candidate) this.#bind(attempt.binding, candidate.drawing, candidate.finalState);
      }
    }
    return this.#receipt;
  }

  #ordinaryEvaluation(decision: SealDecision): JudgeEvaluationResult {
    if (decision.status === 'compile-failed') {
      if (this.#rows.size) throw new Error('Compile failure cannot follow a committed row.');
      return snapshot({ planId: this.#planId, ...decision, cases: [] as const });
    }
    const cases = [...this.#bindings.keys()].map((caseId) => {
      const row = this.#rows.get(caseId);
      if (!row) throw new Error(`Missing ordinary row ${caseId}.`);
      return row;
    });
    return Object.freeze({
      planId: this.#planId,
      ...snapshot(decision),
      cases: Object.freeze(cases),
    });
  }

  hasCachedNotRunAttachment(caseId: string): boolean {
    const attachment = this.#attachments.get(this.#binding(caseId));
    return attachment?.status === 'refused' && attachment.reason === 'case-not-run';
  }

  beginObservation(caseId: string): ObservationAttempt {
    this.#requireLive();
    const binding = this.#binding(caseId);
    if (this.#receipt?.evaluation.status === 'compile-failed') {
      throw new Error('Cannot observe a compile-failed evaluation.');
    }
    if (this.#rows.get(caseId)?.status === 'not-run') {
      throw new Error('Cannot observe a case that was not run.');
    }
    if (this.#attempts.has(binding) || this.#attachments.has(binding)) {
      throw new Error('Observation already started for this case.');
    }
    const token = JSON.stringify([
      binding.evaluationId, binding.workspaceDigest, binding.caseId, binding.generation, ++this.#nextAttempt,
    ]);
    const attempt = Object.freeze({ binding, token });
    this.#attempts.set(binding, { attempt });
    return attempt;
  }

  cancelObservation(attempt: ObservationAttempt): void {
    const entry = this.#attempts.get(attempt.binding);
    if (entry?.attempt === attempt) this.#attempts.delete(attempt.binding);
  }

  publishDrawing(
    attempt: ObservationAttempt,
    replyBinding: Binding,
    message: unknown,
    ownership: DrawingOwnership = 'borrowed',
  ): boolean {
    const entry = this.#attempts.get(attempt.binding);
    if (this.#disposed || entry?.attempt !== attempt || entry.candidate
      || !matches(attempt.binding, replyBinding)) {
      return false;
    }

    const own: Own = ownership === 'transferred' ? new Adoption().own : snapshot;
    let drawing: Frozen<Drawing>;
    try {
      drawing = readDrawing(message, own);
    } catch {
      drawing = refuse('observer-protocol');
    }
    let finalState: Frozen<ObservationFinalState> | undefined;
    if (this.#certification) {
      try {
        finalState = readFinalState(message, own);
      } catch {
        // Malformed evidence cannot certify a drawing or affect the grade.
      }
    }
    entry.candidate = { drawing, finalState };
    if (this.#receipt) this.#bind(attempt.binding, drawing, finalState);
    return true;
  }

  #certify(
    row: Row,
    drawing: Frozen<Drawing>,
    finalState?: Frozen<ObservationFinalState>
  ): Frozen<Drawing> {
    if (finalState?.status === 'compile-failed') return refuse('observer-prepare');
    if (finalState?.status === 'trapped') return refuse('observer-runtime');
    if (finalState?.status === 'timed-out') return refuse('observer-timeout');
    if (drawing.status === 'refused') return drawing;
    const result = finalState?.value;
    if (row.status !== 'completed' || finalState?.console !== row.stdout ||
      !result || result.present !== Object.hasOwn(row, 'value')) {
      return refuse('uncertified-drawing');
    }
    if (!result.present) return drawing;

    try {
      const matched = this.#comparison &&
        compareObservationValues(this.#comparison, row.caseId, result.value, row.value);
      // A predicate or opaque comparator has no declared pairwise equality
      // rule. Use structural equality and never rerun the verdict predicate.
      const equal = matched ?? structuralJsonComparator.compare({
        planId: this.#planId, caseId: row.caseId, input: undefined,
        expected: row.value, actual: result.value,
      }).matched;
      return equal ? drawing : refuse('uncertified-drawing');
    } catch {
      return refuse('uncertified-drawing');
    }
  }

  #bind(
    binding: Binding,
    drawing: Frozen<Drawing>,
    finalState?: Frozen<ObservationFinalState>
  ): Attachment {
    const row = this.#rows.get(binding.caseId);
    if (this.#receipt?.evaluation.status !== 'completed' || !row) {
      throw new Error('Cannot bind a drawing before ordinary receipt publication.');
    }
    const observation = row.status === 'not-run'
      ? refuse('case-not-run')
      : this.#certification ? this.#certify(row, drawing, finalState) : drawing;
    const attachment = Object.freeze({ ...binding, ...observation });
    this.#attachments.set(binding, attachment);
    this.#attempts.delete(binding);
    this.#record('attachment-bind', binding);
    return attachment;
  }

  projectEvaluation(
    selectedCaseIds: readonly string[] = [],
    caseIds?: readonly string[],
  ): JudgeEvaluationResult {
    this.#requireLive();
    const evaluation = this.#receipt?.evaluation;
    if (!evaluation) throw new Error('Ordinary receipt has not been sealed.');
    if (evaluation.status === 'compile-failed') return evaluation;

    const selected = new Set(selectedCaseIds);
    const rows = caseIds?.map((caseId) => {
      this.#binding(caseId);
      return this.#rows.get(caseId)!;
    }) ?? evaluation.cases;
    if (!selected.size && !caseIds) return evaluation;
    const cases = rows.map((row): JudgeCaseResult => {
      if (!selected.has(row.caseId)) return row;
      const binding = this.#binding(row.caseId);
      const attachment = this.#attachments.get(binding) ?? this.#bind(binding, refuse('observer-protocol'));
      return attachment.status === 'refused'
        ? Object.freeze({ ...row, attachment })
        : Object.freeze({ ...row, attachment, trace: attachment.trace });
    });
    return Object.freeze({ ...evaluation, cases: Object.freeze(cases) });
  }

  projectReceipt(selectedCaseIds: readonly string[] = []): JudgeAlgorithmReceipt {
    const evaluation = this.projectEvaluation(selectedCaseIds);
    const receipt = this.#receipt!;
    if (evaluation === receipt.evaluation) return receipt;
    return Object.freeze({ ...receipt, evaluation });
  }

  dispose(): void {
    this.#disposed = true;
    this.#attempts.clear();
    this.#attachments.clear();
    this.#rows.clear();
    this.#receipt = undefined;
  }
}

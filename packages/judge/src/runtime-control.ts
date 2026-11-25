import * as Effect from 'effect/Effect';
import {
  JudgeRuntimeProtocolError,
} from './errors';
import type {
  JudgeRuntimeBatchCaseOutput,
  JudgeRuntimeCaseProgress,
  JudgeRuntimeControlPort,
  JudgeRuntimeInvocationInput,
  JudgeRuntimeInvocationOutput,
  JudgeRuntimeProgressDisposition,
} from './port';

interface InvocationRecord {
  readonly input: JudgeRuntimeInvocationInput;
  output?: JudgeRuntimeInvocationOutput;
  /** Batch invocations only: the accepted per-case progress. */
  readonly journal?: {
    readonly caseIds: ReadonlySet<string>;
    readonly started: string[];
    readonly finished: Map<string, JudgeRuntimeBatchCaseOutput>;
    /** The watchdog deadline (epoch ms) from which progress is fenced. */
    sealAt?: number;
  };
}

/**
 * In-memory implementation used by same-realm runtime providers and tests.
 *
 * Worker-backed providers may implement the same port over MessagePort or
 * another private transport without changing Judge. The invocation token is
 * carried in protected process environment; payloads and results are not.
 */
export class InMemoryJudgeRuntimeControl implements JudgeRuntimeControlPort {
  private readonly invocations = new Map<string, InvocationRecord>();
  private nextId = 1;

  begin(
    input: JudgeRuntimeInvocationInput
  ): Effect.Effect<string, Error> {
    return Effect.sync(() => {
      const id = `judge-invocation-${this.nextId++}`;
      this.invocations.set(id, {
        input: Object.freeze({ ...input }),
        ...(input.phase === 'batch'
          ? {
              journal: {
                caseIds: new Set((input.cases ?? []).map(({ caseId }) => caseId)),
                started: [],
                finished: new Map(),
              },
            }
          : {}),
      });
      return id;
    });
  }

  read(
    invocationId: string
  ): Effect.Effect<JudgeRuntimeInvocationInput, Error> {
    return Effect.suspend(() => {
      const record = this.invocations.get(invocationId);
      return record
        ? Effect.succeed(record.input)
        : Effect.fail(new JudgeRuntimeProtocolError({
            invocationId,
            message: `Unknown Judge runtime invocation ${JSON.stringify(invocationId)}.`,
          }));
    });
  }

  publish(
    invocationId: string,
    output: JudgeRuntimeInvocationOutput
  ): Effect.Effect<void, Error> {
    return Effect.suspend(() => {
      const record = this.invocations.get(invocationId);
      if (!record) {
        return Effect.fail(new JudgeRuntimeProtocolError({
          invocationId,
          message: `Cannot publish to unknown Judge invocation ${JSON.stringify(invocationId)}.`,
        }));
      }
      if (record.output) {
        return Effect.fail(new JudgeRuntimeProtocolError({
          invocationId,
          message: `Judge invocation ${JSON.stringify(invocationId)} already published a result.`,
        }));
      }
      // The journal is the control port's own record; a runtime cannot forge it.
      const { journal: _forged, ...published } = output;
      record.output = Object.freeze({
        ...published,
        diagnostics: Object.freeze([...(output.diagnostics ?? [])]),
        ...(output.timings
          ? { timings: Object.freeze({ ...output.timings }) }
          : {}),
      });
      return Effect.void;
    });
  }

  record(
    invocationId: string,
    progress: JudgeRuntimeCaseProgress
  ): Effect.Effect<JudgeRuntimeProgressDisposition> {
    return Effect.sync(() => {
      const record = this.invocations.get(invocationId);
      // A taken (or discarded) invocation's process has ended; a published
      // one has its result. Either way its journal is sealed.
      if (!record || record.output) return 'fenced';
      const journal = record.journal;
      if (!journal) return 'unknown-case';
      if (journal.sealAt !== undefined && Date.now() >= journal.sealAt) return 'fenced';
      const caseId = progress.kind === 'started' ? progress.caseId : progress.output.caseId;
      if (!journal.caseIds.has(caseId)) return 'unknown-case';
      if (journal.finished.has(caseId)) return 'duplicate';
      if (progress.kind === 'started') {
        if (journal.started.includes(caseId)) return 'duplicate';
        journal.started.push(caseId);
        return 'accepted';
      }
      if (journal.started.length > 0 && !journal.started.includes(caseId)) {
        return 'out-of-order';
      }
      journal.finished.set(caseId, Object.freeze({
        ...progress.output,
        diagnostics: Object.freeze([...(progress.output.diagnostics ?? [])]),
        ...(progress.output.timings
          ? { timings: Object.freeze({ ...progress.output.timings }) }
          : {}),
      }));
      return 'accepted';
    });
  }

  sealAt(invocationId: string, deadlineAt: number): Effect.Effect<void> {
    return Effect.sync(() => {
      const journal = this.invocations.get(invocationId)?.journal;
      if (journal) journal.sealAt = deadlineAt;
    });
  }

  take(
    invocationId: string
  ): Effect.Effect<JudgeRuntimeInvocationOutput | undefined, Error> {
    return Effect.sync(() => {
      const record = this.invocations.get(invocationId);
      this.invocations.delete(invocationId);
      const journal = record?.journal;
      if (!journal || (journal.started.length === 0 && journal.finished.size === 0)) {
        return record?.output;
      }
      return Object.freeze({
        ...(record.output ?? { diagnostics: Object.freeze([]) }),
        journal: Object.freeze({
          started: Object.freeze([...journal.started]),
          finished: Object.freeze([...journal.finished.values()]),
        }),
      });
    });
  }

  discard(invocationId: string): Effect.Effect<void> {
    return Effect.sync(() => {
      this.invocations.delete(invocationId);
    });
  }

  activeInvocationCount(): number {
    return this.invocations.size;
  }
}

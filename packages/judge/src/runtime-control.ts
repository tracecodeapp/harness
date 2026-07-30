import * as Effect from 'effect/Effect';
import {
  JudgeRuntimeProtocolError,
} from './errors';
import type {
  JudgeRuntimeControlPort,
  JudgeRuntimeInvocationInput,
  JudgeRuntimeInvocationOutput,
} from './port';

interface InvocationRecord {
  readonly input: JudgeRuntimeInvocationInput;
  output?: JudgeRuntimeInvocationOutput;
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
      record.output = Object.freeze({
        ...output,
        diagnostics: Object.freeze([...(output.diagnostics ?? [])]),
        ...(output.timings
          ? { timings: Object.freeze({ ...output.timings }) }
          : {}),
      });
      return Effect.void;
    });
  }

  take(
    invocationId: string
  ): Effect.Effect<JudgeRuntimeInvocationOutput | undefined, Error> {
    return Effect.sync(() => {
      const record = this.invocations.get(invocationId);
      this.invocations.delete(invocationId);
      return record?.output;
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

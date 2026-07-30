import * as Data from 'effect/Data';

export class JudgePlanError extends Data.TaggedError('JudgePlanError')<{
  readonly message: string;
}> {}

export class JudgeInfrastructureError extends Data.TaggedError(
  'JudgeInfrastructureError'
)<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class JudgeRuntimeProtocolError extends Data.TaggedError(
  'JudgeRuntimeProtocolError'
)<{
  readonly invocationId: string;
  readonly message: string;
}> {}

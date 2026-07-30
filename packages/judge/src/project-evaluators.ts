import * as Effect from 'effect/Effect';
import type {
  JudgeObservation,
  JudgeProjectClaim,
  JudgeProjectClaimStatus,
  JudgeProjectReceiptV1,
  JudgeProjectStepReceipt,
} from './project-model';
import type { JudgeProjectEvaluator } from './project-port';

export interface DebuggingEvaluatorConfigV1 {
  readonly relevantPaths: readonly string[];
  readonly regressionTestPaths: readonly string[];
  readonly reproductionCommands: readonly string[];
  readonly repositoryTestsStepId: string;
  readonly regressionReplayStepId: string;
  readonly validationCommands?: readonly string[];
  readonly failureSignal?:
    | {
        readonly kind: 'http-status';
        readonly host: string;
        readonly status: number;
      }
    | {
        readonly kind: 'process-failure';
      }
    | {
        readonly kind: 'invariant-contradiction';
        readonly invariant: Omit<
          BehaviorEvaluatorConfigV1,
          'acceptanceStepId'
        >;
      };
}

export type BehaviorEvaluatorConfigV1 =
  | {
      readonly kind: 'auth-boundary';
      readonly acceptanceStepId: string;
      readonly upstreamHost: string;
    }
  | {
      readonly kind: 'idempotency';
      readonly acceptanceStepId: string;
      readonly path: string;
    }
  | {
      readonly kind: 'rate-limit';
      readonly acceptanceStepId: string;
      readonly pathPrefix: string;
      readonly limit: number;
    };

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || !entry.trim())
  ) {
    throw new TypeError(`${label} must be a non-empty string array.`);
  }
  return Object.freeze([...value]);
}

function requiredString(
  value: unknown,
  label: string
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function debuggingConfig(value: unknown): DebuggingEvaluatorConfigV1 {
  const input = record(value, 'Debugging evaluator config');
  let failureSignal: DebuggingEvaluatorConfigV1['failureSignal'];
  if (input.failureSignal !== undefined) {
    const failure = record(input.failureSignal, 'Debugging failure signal');
    if (failure.kind === 'process-failure') {
      failureSignal = { kind: 'process-failure' };
    } else if (failure.kind === 'invariant-contradiction') {
      const invariant = record(
        failure.invariant,
        'Debugging invariant contradiction'
      );
      failureSignal = {
        kind: 'invariant-contradiction',
        invariant: behaviorConfig({
          ...invariant,
          acceptanceStepId: '__debugging_pre_edit__',
        }),
      };
    } else if (
      failure.kind === 'http-status' &&
      typeof failure.host === 'string' &&
      Number.isSafeInteger(failure.status)
    ) {
      failureSignal = {
        kind: 'http-status',
        host: failure.host,
        status: failure.status as number,
      };
    } else {
      throw new TypeError('Debugging failure signal is invalid.');
    }
  }
  return Object.freeze({
    relevantPaths: strings(input.relevantPaths, 'relevantPaths'),
    regressionTestPaths: strings(
      input.regressionTestPaths,
      'regressionTestPaths'
    ),
    reproductionCommands: strings(
      input.reproductionCommands,
      'reproductionCommands'
    ),
    repositoryTestsStepId: requiredString(
      input.repositoryTestsStepId,
      'repositoryTestsStepId'
    ),
    regressionReplayStepId: requiredString(
      input.regressionReplayStepId,
      'regressionReplayStepId'
    ),
    ...(input.validationCommands === undefined
      ? {}
      : {
          validationCommands: strings(
            input.validationCommands,
            'validationCommands'
          ),
        }),
    ...(failureSignal ? { failureSignal } : {}),
  });
}

function behaviorConfig(value: unknown): BehaviorEvaluatorConfigV1 {
  const input = record(value, 'Behavior evaluator config');
  const acceptanceStepId = requiredString(
    input.acceptanceStepId,
    'acceptanceStepId'
  );
  switch (input.kind) {
    case 'auth-boundary':
      return Object.freeze({
        kind: 'auth-boundary',
        acceptanceStepId,
        upstreamHost: requiredString(input.upstreamHost, 'upstreamHost'),
      });
    case 'idempotency':
      return Object.freeze({
        kind: 'idempotency',
        acceptanceStepId,
        path: requiredString(input.path, 'path'),
      });
    case 'rate-limit':
      if (
        !Number.isSafeInteger(input.limit) ||
        (input.limit as number) <= 0
      ) {
        throw new TypeError('rate-limit limit must be a positive integer.');
      }
      return Object.freeze({
        kind: 'rate-limit',
        acceptanceStepId,
        pathPrefix: requiredString(input.pathPrefix, 'pathPrefix'),
        limit: input.limit as number,
      });
    default:
      throw new TypeError('Behavior evaluator kind is unsupported.');
  }
}

function globMatch(path: string, pattern: string): boolean {
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${expression}$`, 'u').test(path);
}

function matches(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.includes('*') ? globMatch(path, pattern) : path === pattern
  );
}

function processSucceeded(step: JudgeProjectStepReceipt | undefined): boolean {
  const process = step?.kind === 'command' ? step.process : step?.probe;
  return Boolean(
    process &&
    !process.timedOut &&
    process.termination.kind === 'exit' &&
    process.termination.exitCode === 0
  );
}

function processExitCode(
  step: JudgeProjectStepReceipt | undefined
): number | null {
  const process = step?.kind === 'command' ? step.process : step?.probe;
  return process?.termination.kind === 'exit'
    ? process.termination.exitCode
    : null;
}

const SUCCESSFUL_SYNTHETIC_PROCESS = Object.freeze({
  sessionId: 'judge-evidence',
  pid: 0,
  termination: Object.freeze({ kind: 'exit' as const, exitCode: 0 }),
  stdout: '',
  stderr: '',
  diagnostics: Object.freeze([]),
  timedOut: false,
});

function claim(
  id: string,
  label: string,
  status: JudgeProjectClaimStatus,
  evidence: JudgeProjectClaim['evidence'] = []
): JudgeProjectClaim {
  const summaries: Readonly<
    Record<string, Partial<Record<JudgeProjectClaimStatus, string>>>
  > = {
    'debugging.reproduced': {
      proven: 'The reported failure was exercised before the first relevant change.',
      contradicted: 'The configured reproduction contradicted the reported failure.',
      'not-demonstrated':
        'No configured reproduction established the reported failure before the first relevant change.',
      insufficient:
        'The repair is present, but the evidence cannot order reproduction before the change.',
    },
    'debugging.relevant-change': {
      proven: 'A file at the assessed implementation boundary was changed.',
      contradicted: 'The submitted change moved the assessed boundary away from the required behavior.',
      'not-demonstrated':
        'No change was observed at the assessed implementation boundary.',
      insufficient: 'The submitted workspace changed, but the assessed boundary could not be verified.',
    },
    'debugging.failure-signal': {
      proven: 'The failing system boundary was observed before the first relevant change.',
      contradicted: 'The observed boundary did not match the configured failure.',
      'not-demonstrated':
        'The configured failure signal was not observed before the first relevant change.',
      insufficient:
        'The repair is present, but the evidence cannot prove the failure signal preceded it.',
    },
    'debugging.regression-test': {
      proven:
        'The submitted tests passed on the repair and failed when the assessed implementation was restored.',
      contradicted:
        'The submitted tests still passed against the starter implementation.',
      'not-demonstrated':
        'No regression test change was submitted for the repaired behavior.',
      insufficient:
        'The isolated regression replay did not complete.',
    },
    'debugging.validated': {
      proven: 'The expanded test suite passed after the implementation and regression test changes.',
      contradicted: 'Validation after the submitted changes failed.',
      'not-demonstrated':
        'No successful configured validation ran after both relevant changes.',
      insufficient:
        'The final workspace is changed, but the evidence cannot order validation after both changes.',
    },
    'validation.repository-tests': {
      proven: 'The submitted workspace passed its repository test suite.',
      contradicted: 'The submitted workspace failed its repository test suite.',
      insufficient: 'The repository test run did not produce a usable result.',
      'not-demonstrated': 'The repository test suite was not run.',
    },
    'behavior.auth-boundary': {
      proven: 'The service used its own credential at the upstream boundary.',
      contradicted: 'The final upstream exchange violated the service authentication boundary.',
      insufficient: 'The authentication evidence was incomplete.',
      'not-demonstrated':
        'The final validation did not exercise an attributable upstream credential boundary.',
    },
    'behavior.idempotency': {
      proven: 'Repeated logical requests replayed one stable result.',
      contradicted: 'A repeated logical request produced more than one result.',
      insufficient: 'Replay traffic was observed, but response identity evidence was incomplete.',
      'not-demonstrated':
        'The final validation did not exercise a repeated logical request.',
    },
    'behavior.rate-limit': {
      proven: 'Every final keyed burst enforced the configured request budget.',
      contradicted: 'At least one final keyed burst violated the configured request budget.',
      insufficient: 'The rate-limit evidence was incomplete.',
      'not-demonstrated':
        'The final validation did not push a keyed request burst past the configured limit.',
    },
  };
  return Object.freeze({
    id,
    label,
    status,
    summary:
      summaries[id]?.[status] ??
      `${label} is ${status.replace('-', ' ')}.`,
    scored: id !== 'debugging.relevant-change',
    evidence: Object.freeze([...evidence]),
  });
}

function evaluateDebugging(
  configValue: unknown,
  receipt: JudgeProjectReceiptV1
): readonly JudgeProjectClaim[] {
  const config = debuggingConfig(configValue);
  const interactive = receipt.observations.filter(
    (event) => !('stepId' in event) || event.stepId === undefined
  );
  const relevantEdit = interactive.find((event) =>
    event.kind === 'edit' && matches(event.path, config.relevantPaths)
  );
  const regressionEdit = interactive.find((event) =>
    event.kind === 'edit' && matches(event.path, config.regressionTestPaths)
  );
  const relevantChangedPath = receipt.changes.find((change) =>
    matches(change.path, config.relevantPaths)
  )?.path;
  const regressionChangedPath = receipt.changes.find((change) =>
    change.kind !== 'deleted' &&
    matches(change.path, config.regressionTestPaths)
  )?.path;
  const firstEditSeq = relevantEdit?.seq ?? Number.POSITIVE_INFINITY;
  const reproduction = interactive.find((event) =>
    event.kind === 'process' &&
    config.reproductionCommands.some((command) =>
      event.command === command || event.argv === command
    ) &&
    event.seq < firstEditSeq
  );
  const failureSignal = config.failureSignal;
  const diagnosedHttp = failureSignal?.kind === 'http-status'
    ? interactive.find((event) =>
        event.kind === 'http' &&
        event.seq < firstEditSeq &&
        event.host === failureSignal.host &&
        event.status === failureSignal.status
      )
    : undefined;
  const preEditObservations = interactive
    .filter((event) => event.seq < firstEditSeq)
    .map((event) => Object.freeze({
      ...event,
      stepId: '__debugging_pre_edit__',
    }));
  const invariantContradicted =
    failureSignal?.kind === 'invariant-contradiction' &&
    evaluateBehavior(
      failureSignal.invariant,
      Object.freeze({
        ...receipt,
        steps: Object.freeze([{
          id: '__debugging_pre_edit__',
          kind: 'command' as const,
          process: SUCCESSFUL_SYNTHETIC_PROCESS,
          observations: Object.freeze(preEditObservations),
        }]),
        observations: Object.freeze(preEditObservations),
      })
    )[0]?.status === 'contradicted';
  const failureObserved = failureSignal === undefined
    ? reproduction !== undefined
    : failureSignal.kind === 'process-failure'
      ? reproduction?.kind === 'process' && reproduction.exitCode !== 0
      : failureSignal.kind === 'invariant-contradiction'
        ? invariantContradicted
        : diagnosedHttp !== undefined;
  const repositoryStep = receipt.steps.find(
    (step) => step.id === config.repositoryTestsStepId
  );
  const replayStep = receipt.steps.find(
    (step) => step.id === config.regressionReplayStepId
  );
  const validationBoundary = Math.max(
    relevantEdit?.seq ?? Number.POSITIVE_INFINITY,
    regressionEdit?.seq ?? Number.POSITIVE_INFINITY
  );
  const validation = Number.isFinite(validationBoundary)
    ? interactive.find((event) =>
        event.kind === 'process' &&
        event.exitCode === 0 &&
        (config.validationCommands ?? ['test']).some((command) =>
          event.command === command || event.argv === command
        ) &&
        event.seq > validationBoundary
      )
    : undefined;

  const claims: JudgeProjectClaim[] = [
    relevantChangedPath && !relevantEdit
      ? claim(
          'debugging.reproduced',
          'Failure reproduced',
          'insufficient'
        )
      : reproduction && failureObserved
        ? claim(
            'debugging.reproduced',
            'Failure reproduced',
            'proven',
            [{
              observationSeq: reproduction.seq,
              note: 'The configured failure was exercised before the repair.',
            }]
          )
        : claim(
            'debugging.reproduced',
            'Failure reproduced',
            'not-demonstrated',
            reproduction
              ? [{
                  observationSeq: reproduction.seq,
                  note:
                    'The reproduction command ran, but the configured failure signal was not observed.',
                }]
              : []
          ),
    relevantChangedPath
      ? claim(
          'debugging.relevant-change',
          'Relevant change',
          'proven',
          [{
            ...(relevantEdit
              ? { observationSeq: relevantEdit.seq }
              : {
                  artifactPath: relevantChangedPath,
                  actor: 'submission',
                }),
            note: `Changed ${relevantChangedPath}.`,
          }]
        )
      : claim(
          'debugging.relevant-change',
          'Relevant change',
          'not-demonstrated'
        ),
    regressionChangedPath &&
      processExitCode(replayStep) !== null &&
      processExitCode(replayStep) !== 0 &&
      processSucceeded(repositoryStep)
      ? claim(
          'debugging.regression-test',
          'Regression coverage',
          'proven',
          [
            {
              ...(regressionEdit
                ? { observationSeq: regressionEdit.seq }
                : {
                    artifactPath: regressionChangedPath,
                    actor: 'submission',
                  }),
              note: `Changed ${regressionChangedPath}.`,
            },
            {
              stepId: config.regressionReplayStepId,
              note: 'The submitted tests failed against the starter implementation.',
            },
          ]
        )
      : claim(
          'debugging.regression-test',
          'Regression coverage',
          !regressionChangedPath
            ? 'not-demonstrated'
            : processExitCode(replayStep) === null
              ? 'insufficient'
              : 'contradicted'
        ),
    validation
      ? claim(
          'debugging.validated',
          'Validation performed',
          'proven',
          [{
            observationSeq: validation.seq,
            note: 'Validation passed after the repair and regression test change.',
          }]
        )
      : relevantChangedPath &&
          regressionChangedPath &&
          (!relevantEdit || !regressionEdit)
        ? claim(
            'debugging.validated',
            'Validation performed',
            'insufficient'
          )
        : claim(
            'debugging.validated',
            'Validation performed',
            'not-demonstrated'
          ),
    processSucceeded(repositoryStep)
      ? claim(
          'validation.repository-tests',
          'Repository tests',
          'proven',
          [{
            stepId: config.repositoryTestsStepId,
            note: 'Repository tests passed in the locked submission.',
          }]
        )
      : claim(
          'validation.repository-tests',
          'Repository tests',
          processExitCode(repositoryStep) === null
            ? 'insufficient'
            : 'contradicted'
        ),
  ];
  if (failureSignal?.kind === 'http-status') {
    claims.splice(
      1,
      0,
      relevantChangedPath && !relevantEdit
        ? claim(
            'debugging.failure-signal',
            'Relevant failure observed',
            'insufficient'
          )
        : diagnosedHttp
          ? claim(
              'debugging.failure-signal',
              'Relevant failure observed',
              'proven',
              [{
                observationSeq: diagnosedHttp.seq,
                note: 'Observed before the first relevant change.',
              }]
            )
          : claim(
              'debugging.failure-signal',
              'Relevant failure observed',
              'not-demonstrated'
            )
    );
  }
  return Object.freeze(claims);
}

type HttpObservation = Extract<JudgeObservation, { kind: 'http' }>;

function acceptanceHttp(
  receipt: JudgeProjectReceiptV1,
  stepId: string
): readonly HttpObservation[] {
  return receipt.observations.filter(
    (event): event is HttpObservation =>
      event.kind === 'http' && event.stepId === stepId
  );
}

function metaString(
  event: HttpObservation,
  key: string
): string | undefined {
  const value = event.meta?.[key];
  return typeof value === 'string' ? value : undefined;
}

function evaluateBehavior(
  configValue: unknown,
  receipt: JudgeProjectReceiptV1
): readonly JudgeProjectClaim[] {
  const config = behaviorConfig(configValue);
  const step = receipt.steps.find((entry) => entry.id === config.acceptanceStepId);
  if (!processSucceeded(step)) {
    return Object.freeze([
      claim(
        `behavior.${config.kind}`,
        config.kind,
        processExitCode(step) === null ? 'insufficient' : 'contradicted',
        [{
          stepId: config.acceptanceStepId,
          note: 'The acceptance probe did not complete successfully.',
        }]
      ),
    ]);
  }
  const http = acceptanceHttp(receipt, config.acceptanceStepId);

  switch (config.kind) {
    case 'auth-boundary': {
      const callerFingerprints = new Set(http
        .filter((event) =>
          event.via === 'listener' && event.authFingerprint !== undefined
        )
        .map((event) => event.authFingerprint!));
      const upstream = http.filter((event) =>
        event.via === 'external' && event.host === config.upstreamHost
      );
      const finalRequest = upstream.at(-1);
      if (!finalRequest || callerFingerprints.size === 0) {
        return Object.freeze([
          claim(
            'behavior.auth-boundary',
            'Authentication boundary',
            'not-demonstrated'
          ),
        ]);
      }
      const serviceCredential = !finalRequest.authFingerprint ||
        !callerFingerprints.has(finalRequest.authFingerprint);
      return Object.freeze([
        claim(
          'behavior.auth-boundary',
          'Authentication boundary',
          serviceCredential && finalRequest.status === 200
            ? 'proven'
            : 'contradicted',
          [{
            observationSeq: finalRequest.seq,
            stepId: config.acceptanceStepId,
            note: 'Final attributable upstream request.',
          }]
        ),
      ]);
    }
    case 'idempotency': {
      const requests = http.filter((event) =>
        event.via === 'listener' &&
        event.path === config.path &&
        metaString(event, 'idempotencyKeyFingerprint') !== undefined
      );
      const groups = new Map<string, HttpObservation[]>();
      for (const request of requests) {
        const key =
          `${metaString(request, 'idempotencyKeyFingerprint') ?? ''}\0` +
          `${metaString(request, 'requestBodyFingerprint') ?? ''}`;
        groups.set(key, [...(groups.get(key) ?? []), request]);
      }
      const repeated = [...groups.values()].filter((group) => group.length >= 2);
      if (repeated.length === 0) {
        return Object.freeze([
          claim('behavior.idempotency', 'Idempotency', 'not-demonstrated'),
        ]);
      }
      const incomplete = repeated.some((group) =>
        group.some((request) =>
          metaString(request, 'responseBodyFingerprint') === undefined
        )
      );
      const violating = repeated.find((group) =>
        new Set(group.map((request) =>
          metaString(request, 'responseBodyFingerprint')
        )).size > 1
      );
      const decisive = violating ?? repeated.at(-1)!;
      return Object.freeze([
        claim(
          'behavior.idempotency',
          'Idempotency',
          incomplete
            ? 'insufficient'
            : violating
              ? 'contradicted'
              : 'proven',
          decisive.slice(0, 2).map((event) => ({
            observationSeq: event.seq,
            stepId: config.acceptanceStepId,
            note: 'Repeated logical request.',
          }))
        ),
      ]);
    }
    case 'rate-limit': {
      const bursts = new Map<string, HttpObservation[]>();
      for (const event of http) {
        if (
          event.via !== 'listener' ||
          !event.path.startsWith(config.pathPrefix) ||
          event.authFingerprint === undefined
        ) continue;
        const key = `${event.pid ?? 'app'}:${event.authFingerprint}`;
        bursts.set(key, [...(bursts.get(key) ?? []), event]);
      }
      const exercising = [...bursts.values()]
        .map((burst) => [...burst].sort((left, right) => left.seq - right.seq))
        .filter((burst) => burst.length > config.limit);
      if (exercising.length === 0) {
        return Object.freeze([
          claim('behavior.rate-limit', 'Rate limit', 'not-demonstrated'),
        ]);
      }
      const violating = exercising.find((burst) =>
        burst.some((event, index) =>
          index < config.limit
            ? event.status === 429
            : event.status !== 429 ||
              metaString(event, 'retryAfter') === undefined
        )
      );
      const decisive = violating ?? exercising.at(-1)!;
      return Object.freeze([
        claim(
          'behavior.rate-limit',
          'Rate limit',
          violating ? 'contradicted' : 'proven',
          [
            decisive[Math.max(0, config.limit - 1)],
            decisive[config.limit],
          ].filter(Boolean).map((event) => ({
            observationSeq: event!.seq,
            stepId: config.acceptanceStepId,
            note: 'Configured request-budget boundary.',
          }))
        ),
      ]);
    }
  }
}

export const debuggingProjectEvaluatorV1: JudgeProjectEvaluator =
  Object.freeze<JudgeProjectEvaluator>({
    kind: 'debugging',
    version: 1,
    evaluate: (input) =>
      Effect.try({
        try: () => evaluateDebugging(input.config, input.receipt),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }),
  });

export const behaviorProjectEvaluatorV1: JudgeProjectEvaluator =
  Object.freeze<JudgeProjectEvaluator>({
    kind: 'behavior',
    version: 1,
    evaluate: (input) =>
      Effect.try({
        try: () => evaluateBehavior(input.config, input.receipt),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }),
  });

export const builtInProjectEvaluators: readonly JudgeProjectEvaluator[] =
  Object.freeze([
    debuggingProjectEvaluatorV1,
    behaviorProjectEvaluatorV1,
  ]);

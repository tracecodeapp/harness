import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import {
  JudgeInfrastructureError,
  JudgePlanError,
} from './errors';
import type {
  JudgeProcessPlan,
  JudgeProcessResult,
  JudgeWorkspaceFile,
} from './model';
import type {
  JudgeKernelProcessOutcome,
  JudgeKernelSignal,
} from './port';
import { evaluateJudgeVerdictPolicy } from './policy';
import type {
  JudgeArtifactRef,
  JudgeObservation,
  JudgeProjectBundleV1,
  JudgeProjectClaim,
  JudgeProjectCommandStepReceipt,
  JudgeProjectReceiptV1,
  JudgeProjectResultV1,
  JudgeProjectServiceProbeStepReceipt,
  JudgeProjectStep,
  JudgeProjectStepReceipt,
} from './project-model';
import { PROJECT_RECEIPT_SCHEMA } from './project-model';
import type {
  JudgeProjectEvaluationOptions,
  JudgeProjectPort,
  JudgeProjectWorkspace,
} from './project-port';
import { validateProjectJudgeBundle } from './project-validate';

function infrastructureError(
  operation: string,
  error: unknown
): JudgeInfrastructureError {
  return new JudgeInfrastructureError({
    operation,
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

function processResult(
  outcome: JudgeKernelProcessOutcome
): JudgeProcessResult {
  return Object.freeze({
    sessionId: outcome.sessionId,
    pid: outcome.pid,
    termination: outcome.termination,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    diagnostics: Object.freeze([...(outcome.diagnostics ?? [])]),
    ...(outcome.timings
      ? { timings: Object.freeze({ ...outcome.timings }) }
      : {}),
    timedOut: outcome.timedOut,
    ...(outcome.startedAt === undefined ? {} : { startedAt: outcome.startedAt }),
    ...(outcome.endedAt === undefined ? {} : { endedAt: outcome.endedAt }),
  });
}

function waitForProcess(
  process: import('./project-port').JudgeProjectProcess,
  operation: string
): Effect.Effect<JudgeKernelProcessOutcome, JudgeInfrastructureError> {
  return process.wait().pipe(
    Effect.mapError((error) => infrastructureError(operation, error)),
    Effect.onInterrupt(() =>
      process.signal('SIGKILL').pipe(Effect.catchAll(() => Effect.void))
    )
  );
}

function fileBytes(contents: string | Uint8Array): Uint8Array {
  return typeof contents === 'string'
    ? new TextEncoder().encode(contents)
    : contents;
}

function sameFile(left: JudgeWorkspaceFile, right: JudgeWorkspaceFile): boolean {
  const leftBytes = fileBytes(left.contents);
  const rightBytes = fileBytes(right.contents);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function workspaceChanges(
  starter: readonly JudgeWorkspaceFile[],
  submission: readonly JudgeWorkspaceFile[]
): JudgeProjectReceiptV1['changes'] {
  const starterByPath = new Map(starter.map((file) => [file.path, file]));
  const submissionByPath = new Map(submission.map((file) => [file.path, file]));
  const paths = new Set([...starterByPath.keys(), ...submissionByPath.keys()]);
  const changes: Array<JudgeProjectReceiptV1['changes'][number]> = [];
  for (const path of paths) {
    const before = starterByPath.get(path);
    const after = submissionByPath.get(path);
    if (!before && after) changes.push({ path, kind: 'added' });
    else if (before && !after) changes.push({ path, kind: 'deleted' });
    else if (before && after && !sameFile(before, after)) {
      changes.push({ path, kind: 'modified' });
    }
  }
  return Object.freeze(
    changes.sort((left, right) => left.path.localeCompare(right.path))
  );
}

function overlayWorkspace(
  step: JudgeProjectStep,
  starter: readonly JudgeWorkspaceFile[],
  submission: readonly JudgeWorkspaceFile[]
): readonly JudgeWorkspaceFile[] {
  const sources = {
    starter: new Map(starter.map((file) => [file.path, file])),
    submission: new Map(submission.map((file) => [file.path, file])),
  };
  const base = step.workspace.base === 'starter' ? starter : submission;
  const result = new Map(base.map((file) => [file.path, file]));
  for (const overlay of step.workspace.overlays ?? []) {
    for (const path of overlay.paths) {
      const file = sources[overlay.source].get(path);
      if (file) result.set(path, file);
      else result.delete(path);
    }
  }
  return Object.freeze([...result.values()]);
}

function resolveArtifact(
  artifact: JudgeArtifactRef,
  options: JudgeProjectEvaluationOptions,
  visibility: JudgeWorkspaceFile['visibility']
): Effect.Effect<readonly JudgeWorkspaceFile[], JudgeInfrastructureError> {
  const validateResolved = (
    files: readonly JudgeWorkspaceFile[]
  ): Effect.Effect<
    readonly JudgeWorkspaceFile[],
    JudgeInfrastructureError
  > => {
    const invalid = files.find((file) => {
      const privatePath = file.path.startsWith('/.tracecode/judge/');
      return (
        file.visibility !== visibility ||
        (visibility === 'judge-private' ? !privatePath : privatePath)
      );
    });
    return invalid
      ? Effect.fail(new JudgeInfrastructureError({
          operation: `resolve project artifact ${artifact.digest}`,
          message:
            `Resolved file ${JSON.stringify(invalid.path)} crosses the Judge-private boundary.`,
        }))
      : Effect.succeed(Object.freeze([...files]));
  };
  if (artifact.kind === 'inline') {
    return validateResolved(artifact.files);
  }
  if (!options.artifactResolver) {
    return Effect.fail(new JudgeInfrastructureError({
      operation: 'resolve project artifact',
      message: 'No artifact resolver is configured.',
    }));
  }
  return options.artifactResolver.resolve(artifact).pipe(
    Effect.flatMap(validateResolved),
    Effect.mapError((error) =>
      error instanceof JudgeInfrastructureError
        ? error
        :
      infrastructureError(
        `resolve project artifact ${artifact.digest}`,
        error
      )
    )
  );
}

function runCommandStep<Snapshot>(
  workspace: JudgeProjectWorkspace<Snapshot>,
  step: Extract<JudgeProjectStep, { kind: 'command' }>
): Effect.Effect<JudgeProjectCommandStepReceipt, JudgeInfrastructureError> {
  return Effect.gen(function* () {
    const process = yield* workspace.run(step.process).pipe(
      Effect.mapError((error) =>
        infrastructureError(`spawn project step ${step.id}`, error)
      )
    );
    const outcome = yield* waitForProcess(
      process,
      `wait for project step ${step.id}`
    );
    const observations = yield* workspace.observations().pipe(
      Effect.mapError((error) =>
        infrastructureError(
          `collect observations for project step ${step.id}`,
          error
        )
      )
    );
    return Object.freeze({
      id: step.id,
      kind: 'command' as const,
      process: processResult(outcome),
      observations: Object.freeze([...observations]),
    });
  });
}

function runServiceProbeStep<Snapshot>(
  workspace: JudgeProjectWorkspace<Snapshot>,
  step: Extract<JudgeProjectStep, { kind: 'service-probe' }>
): Effect.Effect<
  JudgeProjectServiceProbeStepReceipt,
  JudgeInfrastructureError
> {
  return Effect.gen(function* () {
    const service = yield* workspace.run(step.service).pipe(
      Effect.mapError((error) =>
        infrastructureError(`spawn service for project step ${step.id}`, error)
      )
    );
    const serviceFiber = yield* Effect.fork(
      waitForProcess(service, `wait for service in project step ${step.id}`)
    );
    if ((step.readinessDelayMs ?? 0) > 0) {
      yield* Effect.sleep(step.readinessDelayMs!);
    }
    const probe = yield* workspace.run(step.probe).pipe(
      Effect.mapError((error) =>
        infrastructureError(`spawn probe for project step ${step.id}`, error)
      )
    );
    const probeOutcome = yield* waitForProcess(
      probe,
      `wait for probe in project step ${step.id}`
    );
    yield* service.signal(
      step.shutdownSignal ?? 'SIGTERM'
    ).pipe(Effect.catchAll(() => Effect.void));
    const serviceOutcome = yield* Fiber.join(serviceFiber);
    const observations = yield* workspace.observations().pipe(
      Effect.mapError((error) =>
        infrastructureError(
          `collect observations for project step ${step.id}`,
          error
        )
      )
    );
    return Object.freeze({
      id: step.id,
      kind: 'service-probe' as const,
      service: processResult(serviceOutcome),
      probe: processResult(probeOutcome),
      observations: Object.freeze([...observations]),
    });
  }).pipe(
    Effect.onInterrupt(() => Effect.void)
  );
}

function runStep<Snapshot>(
  port: JudgeProjectPort<Snapshot>,
  cwd: string,
  step: JudgeProjectStep,
  files: readonly JudgeWorkspaceFile[],
  privateFiles: readonly JudgeWorkspaceFile[]
): Effect.Effect<JudgeProjectStepReceipt, JudgeInfrastructureError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const workspace = yield* port.openWorkspace({ cwd }).pipe(
        Effect.mapError((error) =>
          infrastructureError(`open workspace for project step ${step.id}`, error)
        )
      );
      yield* workspace.mount([...files, ...privateFiles]).pipe(
        Effect.mapError((error) =>
          infrastructureError(`mount workspace for project step ${step.id}`, error)
        )
      );
      return step.kind === 'command'
        ? yield* runCommandStep(workspace, step)
        : yield* runServiceProbeStep(workspace, step);
    })
  );
}

function resequenceObservations(
  evidence: readonly JudgeObservation[],
  steps: readonly JudgeProjectStepReceipt[]
): readonly JudgeObservation[] {
  const combined = [
    ...evidence,
    ...steps.flatMap((step) =>
      step.observations.map((observation) => ({
        ...observation,
        stepId:
          ('stepId' in observation ? observation.stepId : undefined) ??
          step.id,
      }))
    ),
  ];
  return Object.freeze(combined.map((observation, index) =>
    Object.freeze({ ...observation, seq: index + 1 })
  ));
}

function processDiagnostics(
  steps: readonly JudgeProjectStepReceipt[]
): readonly import('./model').JudgeDiagnostic[] {
  return Object.freeze(steps.flatMap((step) =>
    step.kind === 'command'
      ? step.process.diagnostics
      : [...step.service.diagnostics, ...step.probe.diagnostics]
  ));
}

function infraResult(
  error: JudgeInfrastructureError
): JudgeProjectResultV1 {
  return Object.freeze({
    execution: 'infrastructure-failed',
    verdict: 'not-evaluated',
    claims: Object.freeze([]),
    diagnostics: Object.freeze([{
      severity: 'error' as const,
      code: 'judge-infrastructure-error',
      source: 'judge',
      message: `${error.operation}: ${error.message}`,
    }]),
  });
}

function evaluateProjectJudgeInternal<Snapshot>(
  port: JudgeProjectPort<Snapshot> | undefined,
  bundle: JudgeProjectBundleV1,
  options: JudgeProjectEvaluationOptions,
  evidenceOnly: boolean
): Effect.Effect<JudgeProjectResultV1, JudgePlanError> {
  const program = Effect.gen(function* () {
    yield* validateProjectJudgeBundle(bundle, options);
    if (evidenceOnly && !bundle.attempt.executionEvidence) {
      return yield* Effect.fail(new JudgePlanError({
        message:
          'Evidence-only project evaluation requires project execution evidence.',
      }));
    }
    const [starter, submission, privateFiles] = yield* Effect.all([
      resolveArtifact(
        bundle.definition.workspace.starter,
        options,
        'submission'
      ),
      resolveArtifact(
        bundle.attempt.submittedWorkspace,
        options,
        'submission'
      ),
      bundle.definition.workspace.privateFiles
        ? resolveArtifact(
            bundle.definition.workspace.privateFiles,
            options,
            'judge-private'
          )
        : Effect.succeed(Object.freeze([])),
    ]);
    const steps: JudgeProjectStepReceipt[] = bundle.attempt.executionEvidence
      ? [...bundle.attempt.executionEvidence.steps]
      : [];
    if (!bundle.attempt.executionEvidence) {
      if (!port) {
        return yield* Effect.fail(new JudgeInfrastructureError({
          operation: 'execute project steps',
          message: 'No project execution port is configured.',
        }));
      }
      for (const step of bundle.definition.steps) {
        steps.push(yield* runStep(
          port,
          bundle.definition.workspace.cwd,
          step,
          overlayWorkspace(step, starter, submission),
          privateFiles
        ));
      }
    }
    const observations = resequenceObservations(
      bundle.attempt.evidence ?? [],
      steps
    );
    const changes = workspaceChanges(starter, submission);
    const receipt: JudgeProjectReceiptV1 = Object.freeze({
      schema: PROJECT_RECEIPT_SCHEMA,
      definition: Object.freeze({
        id: bundle.definition.id,
        revision: bundle.definition.revision,
      }),
      attemptId: bundle.attempt.attemptId,
      artifacts: Object.freeze({
        submission: bundle.attempt.submittedWorkspace.digest,
        starter: bundle.definition.workspace.starter.digest,
        ...(bundle.definition.workspace.privateFiles
          ? { privateFiles: bundle.definition.workspace.privateFiles.digest }
          : {}),
      }),
      changes,
      changedPaths: Object.freeze(changes.map((change) => change.path)),
      executionVerification:
        bundle.attempt.executionEvidence?.verification ?? 'judge-executed',
      steps: Object.freeze(steps),
      observations,
      facts: Object.freeze([...(bundle.attempt.facts ?? [])]),
    });
    const claims: JudgeProjectClaim[] = [];
    for (const reference of bundle.definition.evaluators ?? []) {
      const evaluator = options.evaluators!.find((candidate) =>
        candidate.kind === reference.kind &&
        candidate.version === reference.version
      )!;
      claims.push(...yield* evaluator.evaluate({
        config: reference.config,
        receipt,
      }).pipe(
        Effect.mapError((error) =>
          infrastructureError(
            `evaluate project pattern ${reference.kind}@${reference.version}`,
            error
          )
        )
      ));
    }
    const policy = evaluateJudgeVerdictPolicy(
      bundle.definition.verdictPolicy,
      {
        workspaceDigest: bundle.attempt.submittedWorkspace.digest,
        facts: bundle.attempt.facts,
        values: Object.freeze({
          steps: receipt.steps,
          claims: Object.freeze(claims),
          observations: receipt.observations,
          changes: receipt.changes,
          changedPaths: receipt.changedPaths,
        }),
      }
    );
    return Object.freeze({
      execution: 'completed' as const,
      verdict: policy.result === true
        ? 'passed' as const
        : policy.result === false
          ? 'failed' as const
          : 'not-evaluated' as const,
      ...(policy.score === undefined ? {} : { score: policy.score }),
      receipt,
      claims: Object.freeze(claims),
      policy,
      diagnostics: processDiagnostics(steps),
    });
  });
  return program.pipe(
    Effect.catchIf(
      (error): error is JudgeInfrastructureError =>
        error instanceof JudgeInfrastructureError,
      (error) => Effect.succeed(infraResult(error))
    )
  );
}

export function evaluateProjectJudgeBundle<Snapshot>(
  port: JudgeProjectPort<Snapshot>,
  bundle: JudgeProjectBundleV1,
  options: JudgeProjectEvaluationOptions = {}
): Effect.Effect<JudgeProjectResultV1, JudgePlanError> {
  return evaluateProjectJudgeInternal(port, bundle, options, false);
}

/**
 * Evaluates a receipt produced by an already-running browser workspace.
 * This is the migration path for products that already execute their lock,
 * replay, and acceptance phases. It performs no runtime I/O.
 */
export function evaluateProjectJudgeEvidenceBundle(
  bundle: JudgeProjectBundleV1,
  options: JudgeProjectEvaluationOptions = {}
): Effect.Effect<JudgeProjectResultV1, JudgePlanError> {
  return evaluateProjectJudgeInternal<never>(
    undefined,
    bundle,
    options,
    true
  );
}

export function evaluateProjectJudgeEvidenceBundleSync(
  bundle: JudgeProjectBundleV1,
  options: JudgeProjectEvaluationOptions = {}
): JudgeProjectResultV1 {
  return Effect.runSync(
    evaluateProjectJudgeEvidenceBundle(bundle, options)
  );
}

export function evaluateProjectJudgeEvidenceBundlePromise(
  bundle: JudgeProjectBundleV1,
  options: JudgeProjectEvaluationOptions = {}
): Promise<JudgeProjectResultV1> {
  return Effect.runPromise(
    evaluateProjectJudgeEvidenceBundle(bundle, options)
  );
}

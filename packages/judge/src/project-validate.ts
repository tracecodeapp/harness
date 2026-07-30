import * as Effect from 'effect/Effect';
import { JudgePlanError } from './errors';
import type {
  JudgeArtifactRef,
  JudgeProjectBundleV1,
  JudgeProjectStep,
} from './project-model';
import {
  PROJECT_ATTEMPT_SCHEMA,
  PROJECT_BUNDLE_SCHEMA,
  PROJECT_DEFINITION_SCHEMA,
  PROJECT_EXECUTION_EVIDENCE_SCHEMA,
} from './project-model';
import type { JudgeProjectEvaluationOptions } from './project-port';
import { assertJudgeFacts } from './facts';
import type { JudgeProcessResult, JudgeWorkspaceFile } from './model';
import { assertJudgeVerdictPolicy } from './policy';

function fail(message: string): Effect.Effect<never, JudgePlanError> {
  return Effect.fail(new JudgePlanError({ message }));
}

function canonicalAbsolutePath(path: string): boolean {
  if (!path.startsWith('/') || path.includes('\0')) return false;
  const parts = path.split('/');
  if (parts.includes('..')) return false;
  return path === `/${parts
    .filter((part) => part.length > 0 && part !== '.')
    .join('/')}`;
}

function validateArtifact(
  artifact: JudgeArtifactRef,
  label: string,
  visibility: JudgeWorkspaceFile['visibility']
): Effect.Effect<void, JudgePlanError> {
  return Effect.gen(function* () {
    if (!artifact.digest.trim()) {
      return yield* fail(`${label} digest must not be empty.`);
    }
    if (artifact.kind === 'content-addressed') {
      if (!artifact.locator.trim()) {
        return yield* fail(`${label} locator must not be empty.`);
      }
      return;
    }
    if (artifact.files.length > 10_000) {
      return yield* fail(`${label} contains too many files.`);
    }
    const paths = new Set<string>();
    for (const [index, file] of artifact.files.entries()) {
      if (!canonicalAbsolutePath(file.path) || file.path === '/') {
        return yield* fail(
          `${label} file ${index} must use a canonical absolute path.`
        );
      }
      if (file.visibility !== visibility) {
        return yield* fail(
          `${label} file ${JSON.stringify(file.path)} has invalid visibility.`
        );
      }
      const isPrivatePath = file.path.startsWith('/.tracecode/judge/');
      if (
        (visibility === 'judge-private' && !isPrivatePath) ||
        (visibility === 'submission' && isPrivatePath)
      ) {
        return yield* fail(
          `${label} file ${JSON.stringify(file.path)} crosses the Judge-private boundary.`
        );
      }
      if (
        typeof file.contents !== 'string' &&
        !(file.contents instanceof Uint8Array)
      ) {
        return yield* fail(
          `${label} file ${JSON.stringify(file.path)} has invalid contents.`
        );
      }
      if (paths.has(file.path)) {
        return yield* fail(
          `${label} contains duplicate path ${JSON.stringify(file.path)}.`
        );
      }
      paths.add(file.path);
    }
  });
}

function validateObservation(
  value: unknown,
  label: string
): Effect.Effect<void, JudgePlanError> {
  return Effect.gen(function* () {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return yield* fail(`${label} must be an object.`);
    }
    const observation = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(observation.seq) ||
      (observation.seq as number) < 0
    ) {
      return yield* fail(`${label} sequence is invalid.`);
    }
    if (
      typeof observation.actor !== 'string' ||
      !observation.actor.trim() ||
      observation.actor.length > 512
    ) {
      return yield* fail(`${label} actor is invalid.`);
    }
    switch (observation.kind) {
      case 'edit':
        if (
          typeof observation.path !== 'string' ||
          !canonicalAbsolutePath(observation.path)
        ) {
          return yield* fail(`${label} edit path is invalid.`);
        }
        return;
      case 'process':
        if (
          typeof observation.command !== 'string' ||
          typeof observation.argv !== 'string' ||
          !Number.isSafeInteger(observation.exitCode)
        ) {
          return yield* fail(`${label} process observation is invalid.`);
        }
        return;
      case 'http':
        if (
          typeof observation.host !== 'string' ||
          !observation.host.trim() ||
          typeof observation.path !== 'string' ||
          !observation.path.startsWith('/') ||
          (
            observation.status !== null &&
            !Number.isSafeInteger(observation.status)
          ) ||
          !['listener', 'external', 'loopback'].includes(
            observation.via as string
          )
        ) {
          return yield* fail(`${label} HTTP observation is invalid.`);
        }
        return;
      default:
        return yield* fail(`${label} kind is unsupported.`);
    }
  });
}

function validateProcessResult(
  value: unknown,
  label: string
): Effect.Effect<void, JudgePlanError> {
  return Effect.gen(function* () {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return yield* fail(`${label} must be an object.`);
    }
    const process = value as Record<string, unknown>;
    if (
      typeof process.sessionId !== 'string' ||
      !process.sessionId.trim() ||
      !Number.isSafeInteger(process.pid) ||
      (process.pid as number) < 0 ||
      typeof process.stdout !== 'string' ||
      typeof process.stderr !== 'string' ||
      typeof process.timedOut !== 'boolean'
    ) {
      return yield* fail(`${label} process result is invalid.`);
    }
    if (
      process.termination === null ||
      typeof process.termination !== 'object' ||
      Array.isArray(process.termination)
    ) {
      return yield* fail(`${label} termination is invalid.`);
    }
    const termination = process.termination as Record<string, unknown>;
    if (
      !['exit', 'signal', 'failure'].includes(termination.kind as string) ||
      !Number.isSafeInteger(termination.exitCode)
    ) {
      return yield* fail(`${label} termination is invalid.`);
    }
    if (
      (termination.kind === 'signal' &&
        typeof termination.signal !== 'string') ||
      (termination.kind === 'failure' &&
        typeof termination.message !== 'string')
    ) {
      return yield* fail(`${label} termination detail is invalid.`);
    }
    if (!Array.isArray(process.diagnostics) || process.diagnostics.length > 256) {
      return yield* fail(`${label} diagnostics are invalid.`);
    }
    for (const diagnostic of process.diagnostics) {
      if (
        diagnostic === null ||
        typeof diagnostic !== 'object' ||
        Array.isArray(diagnostic)
      ) {
        return yield* fail(`${label} diagnostic is invalid.`);
      }
      const record = diagnostic as Record<string, unknown>;
      if (
        !['error', 'warning', 'info'].includes(record.severity as string) ||
        typeof record.message !== 'string'
      ) {
        return yield* fail(`${label} diagnostic is invalid.`);
      }
    }
  });
}

function validateStep(
  step: JudgeProjectStep
): Effect.Effect<void, JudgePlanError> {
  return Effect.gen(function* () {
    if (!step.id.trim()) return yield* fail('Project step id must not be empty.');
    const overlays = step.workspace.overlays ?? [];
    for (const overlay of overlays) {
      if (overlay.paths.length === 0) {
        return yield* fail(
          `Project step ${JSON.stringify(step.id)} contains an empty overlay.`
        );
      }
      for (const path of overlay.paths) {
        if (!canonicalAbsolutePath(path) || path === '/') {
          return yield* fail(
            `Project step ${JSON.stringify(step.id)} overlay path must be canonical and absolute.`
          );
        }
        if (path.startsWith('/.tracecode/judge/')) {
          return yield* fail(
            `Project step ${JSON.stringify(step.id)} must not overlay Judge-private files.`
          );
        }
      }
    }
    const processes = step.kind === 'command'
      ? [step.process]
      : [step.service, step.probe];
    for (const process of processes) {
      if (!process.command.trim()) {
        return yield* fail(
          `Project step ${JSON.stringify(step.id)} command must not be empty.`
        );
      }
      if (
        process.cwd !== undefined &&
        (!canonicalAbsolutePath(process.cwd) && process.cwd !== '/')
      ) {
        return yield* fail(
          `Project step ${JSON.stringify(step.id)} cwd must be canonical and absolute.`
        );
      }
      if (
        process.timeoutMs !== undefined &&
        (!Number.isSafeInteger(process.timeoutMs) || process.timeoutMs <= 0)
      ) {
        return yield* fail(
          `Project step ${JSON.stringify(step.id)} timeout must be a positive safe integer.`
        );
      }
    }
    if (
      step.kind === 'service-probe' &&
      step.readinessDelayMs !== undefined &&
      (
        !Number.isSafeInteger(step.readinessDelayMs) ||
        step.readinessDelayMs < 0 ||
        step.readinessDelayMs > 30_000
      )
    ) {
      return yield* fail(
        `Project step ${JSON.stringify(step.id)} readiness delay is invalid.`
      );
    }
  });
}

function validateExecutionEvidence(
  bundle: JudgeProjectBundleV1
): Effect.Effect<void, JudgePlanError> {
  return Effect.gen(function* () {
    const evidence = bundle.attempt.executionEvidence;
    if (!evidence) return;
    if (evidence.schema !== PROJECT_EXECUTION_EVIDENCE_SCHEMA) {
      return yield* fail('Unsupported project execution evidence schema.');
    }
    if (
      !['browser-asserted', 'mux-computed', 'signed'].includes(
        evidence.verification
      )
    ) {
      return yield* fail('Project execution evidence verification is invalid.');
    }
    if (
      evidence.steps.length !== bundle.definition.steps.length
    ) {
      return yield* fail(
        'Project execution evidence must contain exactly one receipt for every definition step.'
      );
    }
    for (const [index, expected] of bundle.definition.steps.entries()) {
      const actual = evidence.steps[index];
      if (!actual || actual.id !== expected.id || actual.kind !== expected.kind) {
        return yield* fail(
          `Project execution receipt ${index} does not match definition step ${JSON.stringify(expected.id)}.`
        );
      }
      const observations = actual.observations;
      if (!Array.isArray(observations) || observations.length > 10_000) {
        return yield* fail(
          `Project execution receipt ${index} observations are invalid.`
        );
      }
      for (const [observationIndex, observation] of observations.entries()) {
        yield* validateObservation(
          observation,
          `Project execution receipt ${index} observation ${observationIndex}`
        );
      }
      if (actual.kind === 'command') {
        yield* validateProcessResult(
          actual.process,
          `Project execution receipt ${index}`
        );
      } else {
        yield* validateProcessResult(
          actual.service,
          `Project execution receipt ${index} service`
        );
        yield* validateProcessResult(
          actual.probe,
          `Project execution receipt ${index} probe`
        );
      }
    }
  });
}

export function validateProjectJudgeBundle(
  bundle: JudgeProjectBundleV1,
  options: JudgeProjectEvaluationOptions = {}
): Effect.Effect<void, JudgePlanError> {
  return Effect.gen(function* () {
    if (bundle.schema !== PROJECT_BUNDLE_SCHEMA) {
      return yield* fail(`Unsupported project bundle schema ${JSON.stringify(bundle.schema)}.`);
    }
    if (bundle.definition.schema !== PROJECT_DEFINITION_SCHEMA) {
      return yield* fail('Unsupported project definition schema.');
    }
    if (bundle.attempt.schema !== PROJECT_ATTEMPT_SCHEMA) {
      return yield* fail('Unsupported project attempt schema.');
    }
    if (!bundle.definition.id.trim() || !bundle.definition.revision.trim()) {
      return yield* fail('Project definition id and revision must not be empty.');
    }
    if (!bundle.attempt.attemptId.trim()) {
      return yield* fail('Project attempt id must not be empty.');
    }
    try {
      assertJudgeVerdictPolicy(bundle.definition.verdictPolicy);
      assertJudgeFacts(
        bundle.attempt.facts ?? [],
        bundle.attempt.submittedWorkspace.digest
      );
    } catch (error) {
      return yield* fail(
        error instanceof Error ? error.message : 'Project policy is invalid.'
      );
    }
    if (
      !canonicalAbsolutePath(bundle.definition.workspace.cwd) &&
      bundle.definition.workspace.cwd !== '/'
    ) {
      return yield* fail('Project workspace cwd must be canonical and absolute.');
    }
    yield* validateArtifact(
      bundle.definition.workspace.starter,
      'Starter artifact',
      'submission'
    );
    yield* validateArtifact(
      bundle.attempt.submittedWorkspace,
      'Submission artifact',
      'submission'
    );
    if (bundle.definition.workspace.privateFiles) {
      yield* validateArtifact(
        bundle.definition.workspace.privateFiles,
        'Private artifact',
        'judge-private'
      );
    }
    const attemptEvidence = bundle.attempt.evidence ?? [];
    if (!Array.isArray(attemptEvidence) || attemptEvidence.length > 10_000) {
      return yield* fail('Project attempt observations are invalid.');
    }
    for (const [index, observation] of attemptEvidence.entries()) {
      yield* validateObservation(
        observation,
        `Project attempt observation ${index}`
      );
    }
    if (bundle.definition.steps.length === 0) {
      return yield* fail('Project definition must contain at least one step.');
    }
    const stepIds = new Set<string>();
    for (const step of bundle.definition.steps) {
      if (stepIds.has(step.id)) {
        return yield* fail(
          `Project definition contains duplicate step id ${JSON.stringify(step.id)}.`
        );
      }
      stepIds.add(step.id);
      yield* validateStep(step);
    }
    yield* validateExecutionEvidence(bundle);
    const evaluatorKeys = new Set<string>();
    for (const reference of bundle.definition.evaluators ?? []) {
      const key = `${reference.kind}@${reference.version}`;
      if (evaluatorKeys.has(key)) {
        return yield* fail(
          `Project definition contains duplicate evaluator ${JSON.stringify(key)}.`
        );
      }
      evaluatorKeys.add(key);
      if (
        !(options.evaluators ?? []).some((evaluator) =>
          evaluator.kind === reference.kind &&
          evaluator.version === reference.version
        )
      ) {
        return yield* fail(
          `Project evaluator ${JSON.stringify(key)} is not registered.`
        );
      }
    }
    const hasExternalArtifact = [
      bundle.definition.workspace.starter,
      bundle.definition.workspace.privateFiles,
      bundle.attempt.submittedWorkspace,
    ].some((artifact) => artifact?.kind === 'content-addressed');
    if (hasExternalArtifact && !options.artifactResolver) {
      return yield* fail(
        'Project bundle contains content-addressed artifacts without an artifact resolver.'
      );
    }
  });
}

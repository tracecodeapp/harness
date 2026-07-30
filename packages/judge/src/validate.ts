import * as Effect from 'effect/Effect';
import { JudgePlanError } from './errors';
import type {
  JudgeEvaluationPlan,
  JudgeProcessPlan,
  JudgeWorkspaceFile,
} from './model';

const RESERVED_ENV_PREFIX = 'TRACECODE_JUDGE_';

function fail(message: string): Effect.Effect<never, JudgePlanError> {
  return Effect.fail(new JudgePlanError({ message }));
}

function validateAbsolutePath(
  path: string,
  description: string,
  allowRoot = false
): Effect.Effect<void, JudgePlanError> {
  if (!path.startsWith('/') || path.includes('\0')) {
    return fail(`${description} must be an absolute path without NUL bytes.`);
  }
  const parts = path.split('/');
  if (parts.includes('..')) {
    return fail(`${description} must not contain parent traversal.`);
  }
  const canonical = `/${parts
    .filter((part) => part.length > 0 && part !== '.')
    .join('/')}`;
  if (path !== canonical || (!allowRoot && canonical === '/')) {
    return fail(
      `${description} must be a canonical absolute file path; received ` +
      `${JSON.stringify(path)} and expected ${JSON.stringify(canonical)}.`
    );
  }
  return Effect.void;
}

function validateProcess(
  process: JudgeProcessPlan,
  description: string
): Effect.Effect<void, JudgePlanError> {
  return Effect.gen(function* () {
    if (process.command.trim().length === 0) {
      return yield* fail(`${description} command must not be empty.`);
    }
    if (process.cwd !== undefined) {
      yield* validateAbsolutePath(process.cwd, `${description} cwd`, true);
    }
    if (
      process.timeoutMs !== undefined &&
      (
        !Number.isSafeInteger(process.timeoutMs) ||
        process.timeoutMs <= 0
      )
    ) {
      return yield* fail(`${description} timeoutMs must be a positive safe integer.`);
    }
    const reserved = Object.keys(process.env ?? {}).find((key) =>
      key.startsWith(RESERVED_ENV_PREFIX)
    );
    if (reserved) {
      return yield* fail(
        `${description} env must not define reserved variable ${JSON.stringify(reserved)}.`
      );
    }
  });
}

function validateFile(
  file: JudgeWorkspaceFile,
  description: string,
  expectedVisibility: JudgeWorkspaceFile['visibility']
): Effect.Effect<void, JudgePlanError> {
  return Effect.gen(function* () {
    yield* validateAbsolutePath(file.path, `${description} path`);
    if (file.visibility !== expectedVisibility) {
      return yield* fail(
        `${description} must use ${JSON.stringify(expectedVisibility)} visibility.`
      );
    }
    if (
      expectedVisibility === 'judge-private' &&
      !file.path.startsWith('/.tracecode/judge/')
    ) {
      return yield* fail(
        `${description} must live below "/.tracecode/judge/".`
      );
    }
    if (
      expectedVisibility === 'submission' &&
      file.path.startsWith('/.tracecode/judge/')
    ) {
      return yield* fail(
        `${description} must not use the reserved "/.tracecode/judge/" namespace.`
      );
    }
  });
}

export function validateJudgePlan(
  plan: JudgeEvaluationPlan
): Effect.Effect<void, JudgePlanError> {
  return Effect.gen(function* () {
    if (plan.id.trim().length === 0) {
      return yield* fail('Judge plan id must not be empty.');
    }
    if (plan.runtime.trim().length === 0) {
      return yield* fail('Judge runtime must not be empty.');
    }
    if (plan.cases.length === 0) {
      return yield* fail('Judge plan must define at least one case.');
    }
    if (plan.workspace.cwd !== undefined) {
      yield* validateAbsolutePath(plan.workspace.cwd, 'Judge workspace cwd', true);
    }

    const paths = new Set<string>();
    for (const [index, file] of plan.workspace.files.entries()) {
      yield* validateFile(file, `Workspace file ${index}`, 'submission');
      if (paths.has(file.path)) {
        return yield* fail(`Judge plan mounts duplicate path ${JSON.stringify(file.path)}.`);
      }
      paths.add(file.path);
    }
    for (const [index, file] of plan.driver.files.entries()) {
      yield* validateFile(file, `Driver file ${index}`, 'judge-private');
      if (paths.has(file.path)) {
        return yield* fail(`Judge plan mounts duplicate path ${JSON.stringify(file.path)}.`);
      }
      paths.add(file.path);
    }

    if (plan.compile) yield* validateProcess(plan.compile, 'Compile phase');
    yield* validateProcess(plan.run, 'Run phase');

    const caseIds = new Set<string>();
    for (const [index, testCase] of plan.cases.entries()) {
      if (testCase.id.trim().length === 0) {
        return yield* fail(`Case ${index} id must not be empty.`);
      }
      if (caseIds.has(testCase.id)) {
        return yield* fail(`Judge plan contains duplicate case id ${JSON.stringify(testCase.id)}.`);
      }
      caseIds.add(testCase.id);
      const reserved = Object.keys(testCase.env ?? {}).find((key) =>
        key.startsWith(RESERVED_ENV_PREFIX)
      );
      if (reserved) {
        return yield* fail(
          `Case ${JSON.stringify(testCase.id)} env must not define reserved variable ` +
          `${JSON.stringify(reserved)}.`
        );
      }
    }

    const maxConcurrency = plan.isolation?.maxConcurrency;
    if (
      maxConcurrency !== undefined &&
      (
        !Number.isSafeInteger(maxConcurrency) ||
        maxConcurrency <= 0
      )
    ) {
      return yield* fail('Judge isolation maxConcurrency must be a positive safe integer.');
    }
  });
}

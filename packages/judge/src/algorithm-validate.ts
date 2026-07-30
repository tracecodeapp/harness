import * as Effect from 'effect/Effect';
import { JudgePlanError } from './errors';
import type { JudgeAlgorithmBundle } from './algorithm-model';
import { ALGORITHM_BUNDLE_SCHEMA } from './algorithm-model';
import { assertJudgeComparatorPolicy } from './comparator-strategy';
import { assertJudgeFacts } from './facts';
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

/**
 * Validates the portable algorithm authority manifest before any runtime or
 * comparator is allocated. The full bundle stays plain serializable data, so
 * this same validation runs in a client browser and in a mux browser slot.
 */
export function validateAlgorithmJudgeBundle(
  bundle: JudgeAlgorithmBundle
): Effect.Effect<void, JudgePlanError> {
  return Effect.gen(function* () {
    if (bundle.schema !== ALGORITHM_BUNDLE_SCHEMA) {
      return yield* fail(
        `Unsupported algorithm bundle schema ${JSON.stringify(bundle.schema)}.`
      );
    }
    if (!bundle.id.trim() || !bundle.plan.id.trim()) {
      return yield* fail('Algorithm bundle and plan ids must not be empty.');
    }
    if (!bundle.workspaceDigest.trim()) {
      return yield* fail('Algorithm workspace digest must not be empty.');
    }
    if (!bundle.plan.runtime.trim()) {
      return yield* fail('Algorithm runtime must not be empty.');
    }
    try {
      assertJudgeVerdictPolicy(bundle.policy);
      if (bundle.comparison !== undefined) {
        assertJudgeComparatorPolicy(bundle.comparison);
      }
      assertJudgeFacts(bundle.facts ?? [], bundle.workspaceDigest);
    } catch (error) {
      return yield* fail(
        error instanceof Error ? error.message : 'Algorithm policy is invalid.'
      );
    }
    if (
      !canonicalAbsolutePath(bundle.execution.sourcePath) ||
      bundle.execution.sourcePath.startsWith('/.tracecode/judge/')
    ) {
      return yield* fail(
        'Algorithm execution source must be a canonical submission path.'
      );
    }

    const workspacePaths = new Set<string>();
    for (const file of bundle.plan.workspace.files) {
      if (!canonicalAbsolutePath(file.path)) {
        return yield* fail(
          `Algorithm workspace file ${JSON.stringify(file.path)} is not canonical.`
        );
      }
      if (workspacePaths.has(file.path)) {
        return yield* fail(
          `Algorithm workspace contains duplicate path ${JSON.stringify(file.path)}.`
        );
      }
      workspacePaths.add(file.path);
    }
    if (!workspacePaths.has(bundle.execution.sourcePath)) {
      return yield* fail(
        'Algorithm execution source is missing from the submitted workspace.'
      );
    }

    const driverPaths = new Set<string>();
    for (const file of bundle.plan.driver.files) {
      if (
        !canonicalAbsolutePath(file.path) ||
        !file.path.startsWith('/.tracecode/judge/')
      ) {
        return yield* fail(
          'Algorithm driver files must live below /.tracecode/judge/.'
        );
      }
      if (driverPaths.has(file.path) || workspacePaths.has(file.path)) {
        return yield* fail(
          `Algorithm bundle contains duplicate path ${JSON.stringify(file.path)}.`
        );
      }
      driverPaths.add(file.path);
    }

    if (bundle.plan.cases.length === 0) {
      return yield* fail('Algorithm plan must contain at least one case.');
    }
    const caseIds = new Set<string>();
    for (const testCase of bundle.plan.cases) {
      if (!testCase.id.trim()) {
        return yield* fail('Algorithm case id must not be empty.');
      }
      if (caseIds.has(testCase.id)) {
        return yield* fail(
          `Algorithm plan contains duplicate case id ${JSON.stringify(testCase.id)}.`
        );
      }
      caseIds.add(testCase.id);
    }
    for (const caseId of Object.keys(bundle.comparison?.cases ?? {})) {
      if (!caseIds.has(caseId)) {
        return yield* fail(
          `Algorithm comparison override references unknown case ${JSON.stringify(caseId)}.`
        );
      }
    }

  });
}

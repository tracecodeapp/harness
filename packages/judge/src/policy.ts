import type {
  JudgeFact,
  JudgeFactRequirement,
} from './facts';
import { judgeFactMeetsRequirement } from './facts';

export type JudgeTruth = true | false | 'unknown';

export type JudgeComplexityClass =
  | 'constant'
  | 'logarithmic'
  | 'linear'
  | 'linearithmic'
  | 'quadratic'
  | 'cubic'
  | 'exponential'
  | 'factorial'
  | 'unknown';

export type JudgeLiteral = string | number | boolean | null;

export type JudgeValueExpression =
  | {
      readonly op: 'literal';
      readonly value: JudgeLiteral;
    }
  | {
      readonly op: 'ref';
      readonly path: string;
    }
  | {
      readonly op: 'fact';
      readonly id: string;
    };

export type JudgeBooleanExpression =
  | {
      readonly op: 'all';
      readonly conditions: readonly JudgeBooleanExpression[];
    }
  | {
      readonly op: 'any';
      readonly conditions: readonly JudgeBooleanExpression[];
    }
  | {
      readonly op: 'not';
      readonly condition: JudgeBooleanExpression;
    }
  | {
      readonly op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';
      readonly left: JudgeValueExpression;
      readonly right: JudgeValueExpression;
    }
  | {
      readonly op: 'complexity-at-most';
      readonly actual: JudgeValueExpression;
      readonly expected: JudgeValueExpression;
    }
  | {
      readonly op: 'every' | 'some';
      readonly collection: JudgeValueExpression;
      readonly variable: string;
      readonly condition: JudgeBooleanExpression;
    };

export interface JudgeWeightedScoreDimension {
  readonly id: string;
  readonly weight: number;
  readonly when: JudgeBooleanExpression;
}

export interface JudgeWeightedScorePolicy {
  readonly kind: 'weighted-sum';
  readonly dimensions: readonly JudgeWeightedScoreDimension[];
}

export interface JudgeVerdictPolicy {
  readonly schema: 'tracecode.judge.verdict-policy.v1';
  readonly requires?: readonly JudgeFactRequirement[];
  readonly passWhen: JudgeBooleanExpression;
  readonly score?: JudgeWeightedScorePolicy;
}

export interface JudgePolicyContext {
  readonly workspaceDigest: string;
  readonly facts?: readonly JudgeFact[];
  readonly values: Readonly<Record<string, unknown>>;
}

export interface JudgePolicyTrace {
  readonly expression: JudgeBooleanExpression;
  readonly result: JudgeTruth;
  readonly actual?: unknown;
  readonly expected?: unknown;
  readonly children?: readonly JudgePolicyTrace[];
  readonly reason?: string;
}

export interface JudgePolicyEvaluation {
  readonly result: JudgeTruth;
  readonly score?: number;
  readonly trace: JudgePolicyTrace;
  readonly missingFacts: readonly JudgeFactRequirement[];
}

const MAX_POLICY_DEPTH = 32;
const MAX_POLICY_NODES = 1_024;
const MAX_SCORE_DIMENSIONS = 64;

const complexityRank: Readonly<Record<JudgeComplexityClass, number>> =
  Object.freeze({
    constant: 0,
    logarithmic: 1,
    linear: 2,
    linearithmic: 3,
    quadratic: 4,
    cubic: 5,
    exponential: 6,
    factorial: 7,
    unknown: Number.POSITIVE_INFINITY,
  });

const missing = Symbol('judge-policy-missing');
type ResolvedValue = unknown | typeof missing;

function inputRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new TypeError(`${label} must be a non-empty bounded string.`);
  }
  return value;
}

function validateValueExpression(
  value: unknown,
  state: { nodes: number },
  depth: number
): void {
  if (depth > MAX_POLICY_DEPTH) {
    throw new TypeError('Judge policy exceeds the maximum expression depth.');
  }
  state.nodes += 1;
  if (state.nodes > MAX_POLICY_NODES) {
    throw new TypeError('Judge policy exceeds the maximum expression size.');
  }
  const expression = inputRecord(value, 'Judge value expression');
  switch (expression.op) {
    case 'literal':
      if (
        expression.value !== null &&
        !['string', 'number', 'boolean'].includes(typeof expression.value)
      ) {
        throw new TypeError('Judge policy literal is not serializable.');
      }
      if (
        typeof expression.value === 'number' &&
        !Number.isFinite(expression.value)
      ) {
        throw new TypeError('Judge policy number literal must be finite.');
      }
      return;
    case 'ref': {
      const path = nonEmptyString(expression.path, 'Judge policy reference');
      if (
        path.split('.').some((part) =>
          !part ||
          part === '__proto__' ||
          part === 'prototype' ||
          part === 'constructor'
        )
      ) {
        throw new TypeError('Judge policy reference path is unsafe.');
      }
      return;
    }
    case 'fact':
      nonEmptyString(expression.id, 'Judge policy fact id');
      return;
    default:
      throw new TypeError('Judge value expression operation is unsupported.');
  }
}

function validateBooleanExpression(
  value: unknown,
  state: { nodes: number },
  depth: number
): void {
  if (depth > MAX_POLICY_DEPTH) {
    throw new TypeError('Judge policy exceeds the maximum expression depth.');
  }
  state.nodes += 1;
  if (state.nodes > MAX_POLICY_NODES) {
    throw new TypeError('Judge policy exceeds the maximum expression size.');
  }
  const expression = inputRecord(value, 'Judge boolean expression');
  switch (expression.op) {
    case 'all':
    case 'any':
      if (
        !Array.isArray(expression.conditions) ||
        expression.conditions.length === 0
      ) {
        throw new TypeError(
          `Judge policy ${expression.op} requires at least one condition.`
        );
      }
      for (const condition of expression.conditions) {
        validateBooleanExpression(condition, state, depth + 1);
      }
      return;
    case 'not':
      validateBooleanExpression(expression.condition, state, depth + 1);
      return;
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      validateValueExpression(expression.left, state, depth + 1);
      validateValueExpression(expression.right, state, depth + 1);
      return;
    case 'complexity-at-most':
      validateValueExpression(expression.actual, state, depth + 1);
      validateValueExpression(expression.expected, state, depth + 1);
      return;
    case 'every':
    case 'some':
      validateValueExpression(expression.collection, state, depth + 1);
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(
          nonEmptyString(expression.variable, 'Judge policy variable')
        )
      ) {
        throw new TypeError('Judge policy variable is invalid.');
      }
      validateBooleanExpression(expression.condition, state, depth + 1);
      return;
    default:
      throw new TypeError('Judge boolean expression operation is unsupported.');
  }
}

/**
 * Validates a policy received across a browser or mux authority boundary.
 *
 * The policy language is intentionally finite and non-Turing-complete. These
 * bounds prevent a signed but malformed product request from turning policy
 * evaluation into unbounded recursion or work.
 */
export function assertJudgeVerdictPolicy(
  value: unknown
): asserts value is JudgeVerdictPolicy {
  const policy = inputRecord(value, 'Judge verdict policy');
  if (policy.schema !== 'tracecode.judge.verdict-policy.v1') {
    throw new TypeError('Unsupported Judge verdict policy schema.');
  }
  const requirements = policy.requires ?? [];
  if (!Array.isArray(requirements) || requirements.length > 128) {
    throw new TypeError('Judge policy fact requirements are invalid.');
  }
  const requirementKeys = new Set<string>();
  for (const value of requirements) {
    const requirement = inputRecord(value, 'Judge fact requirement');
    const id = nonEmptyString(requirement.id, 'Judge fact requirement id');
    if (
      !Number.isSafeInteger(requirement.schema) ||
      (requirement.schema as number) < 1
    ) {
      throw new TypeError('Judge fact requirement schema is invalid.');
    }
    if (requirement.producer !== undefined) {
      nonEmptyString(
        requirement.producer,
        'Judge fact requirement producer'
      );
    }
    if (
      requirement.minimumVerification !== undefined &&
      !['browser-asserted', 'mux-computed', 'signed'].includes(
        requirement.minimumVerification as string
      )
    ) {
      throw new TypeError('Judge fact verification requirement is invalid.');
    }
    if (
      requirement.minimumConfidence !== undefined &&
      (
        typeof requirement.minimumConfidence !== 'number' ||
        !Number.isFinite(requirement.minimumConfidence) ||
        requirement.minimumConfidence < 0 ||
        requirement.minimumConfidence > 1
      )
    ) {
      throw new TypeError('Judge fact confidence requirement is invalid.');
    }
    const key = `${id}\0${requirement.schema as number}`;
    if (requirementKeys.has(key)) {
      throw new TypeError('Judge policy contains duplicate fact requirements.');
    }
    requirementKeys.add(key);
  }

  const state = { nodes: 0 };
  validateBooleanExpression(policy.passWhen, state, 0);

  if (policy.score === undefined) return;
  const score = inputRecord(policy.score, 'Judge score policy');
  if (score.kind !== 'weighted-sum') {
    throw new TypeError('Judge score policy kind is unsupported.');
  }
  if (
    !Array.isArray(score.dimensions) ||
    score.dimensions.length === 0 ||
    score.dimensions.length > MAX_SCORE_DIMENSIONS
  ) {
    throw new TypeError('Judge score dimensions are invalid.');
  }
  const dimensionIds = new Set<string>();
  for (const value of score.dimensions) {
    const dimension = inputRecord(value, 'Judge score dimension');
    const id = nonEmptyString(dimension.id, 'Judge score dimension id');
    if (dimensionIds.has(id)) {
      throw new TypeError('Judge score dimension ids must be unique.');
    }
    dimensionIds.add(id);
    if (
      typeof dimension.weight !== 'number' ||
      !Number.isFinite(dimension.weight) ||
      dimension.weight <= 0
    ) {
      throw new TypeError('Judge score dimension weight must be positive.');
    }
    validateBooleanExpression(dimension.when, state, 0);
  }
}

function ownPath(value: unknown, path: string): ResolvedValue {
  if (!path || path.includes('__proto__') || path.includes('prototype')) {
    return missing;
  }
  let cursor: unknown = value;
  for (const part of path.split('.')) {
    if (
      cursor === null ||
      typeof cursor !== 'object' ||
      !Object.prototype.hasOwnProperty.call(cursor, part)
    ) {
      return missing;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function resolveValue(
  expression: JudgeValueExpression,
  context: JudgePolicyContext,
  scope: Readonly<Record<string, unknown>>
): ResolvedValue {
  switch (expression.op) {
    case 'literal':
      return expression.value;
    case 'fact':
      return context.facts?.find((fact) => fact.id === expression.id)?.value ??
        missing;
    case 'ref': {
      const [root, ...rest] = expression.path.split('.');
      const base = root && Object.prototype.hasOwnProperty.call(scope, root)
        ? scope[root]
        : ownPath(context.values, root ?? '');
      if (base === missing) return missing;
      return rest.length === 0 ? base : ownPath(base, rest.join('.'));
    }
  }
  return missing;
}

function truthNot(value: JudgeTruth): JudgeTruth {
  return value === 'unknown' ? value : !value;
}

function compare(
  op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte',
  left: unknown,
  right: unknown
): boolean {
  switch (op) {
    case 'eq':
      return Object.is(left, right);
    case 'neq':
      return !Object.is(left, right);
    case 'lt':
      return typeof left === 'number' &&
        typeof right === 'number' &&
        left < right;
    case 'lte':
      return typeof left === 'number' &&
        typeof right === 'number' &&
        left <= right;
    case 'gt':
      return typeof left === 'number' &&
        typeof right === 'number' &&
        left > right;
    case 'gte':
      return typeof left === 'number' &&
        typeof right === 'number' &&
        left >= right;
  }
}

function evaluateExpression(
  expression: JudgeBooleanExpression,
  context: JudgePolicyContext,
  scope: Readonly<Record<string, unknown>>
): JudgePolicyTrace {
  switch (expression.op) {
    case 'all': {
      const children = expression.conditions.map((condition) =>
        evaluateExpression(condition, context, scope)
      );
      const result: JudgeTruth = children.some((child) => child.result === false)
        ? false
        : children.some((child) => child.result === 'unknown')
          ? 'unknown'
          : true;
      return Object.freeze({ expression, result, children });
    }
    case 'any': {
      const children = expression.conditions.map((condition) =>
        evaluateExpression(condition, context, scope)
      );
      const result: JudgeTruth = children.some((child) => child.result === true)
        ? true
        : children.some((child) => child.result === 'unknown')
          ? 'unknown'
          : false;
      return Object.freeze({ expression, result, children });
    }
    case 'not': {
      const child = evaluateExpression(expression.condition, context, scope);
      return Object.freeze({
        expression,
        result: truthNot(child.result),
        children: Object.freeze([child]),
      });
    }
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const left = resolveValue(expression.left, context, scope);
      const right = resolveValue(expression.right, context, scope);
      if (left === missing || right === missing) {
        return Object.freeze({
          expression,
          result: 'unknown',
          reason: 'A referenced value is missing.',
        });
      }
      return Object.freeze({
        expression,
        result: compare(expression.op, left, right),
        actual: left,
        expected: right,
      });
    }
    case 'complexity-at-most': {
      const actual = resolveValue(expression.actual, context, scope);
      const expected = resolveValue(expression.expected, context, scope);
      if (
        actual === missing ||
        expected === missing ||
        typeof actual !== 'string' ||
        typeof expected !== 'string' ||
        !(actual in complexityRank) ||
        !(expected in complexityRank)
      ) {
        return Object.freeze({
          expression,
          result: 'unknown',
          reason: 'Complexity evidence is missing or unsupported.',
        });
      }
      return Object.freeze({
        expression,
        result:
          complexityRank[actual as JudgeComplexityClass] <=
          complexityRank[expected as JudgeComplexityClass],
        actual,
        expected,
      });
    }
    case 'every':
    case 'some': {
      const collection = resolveValue(expression.collection, context, scope);
      if (!Array.isArray(collection)) {
        return Object.freeze({
          expression,
          result: 'unknown',
          reason: 'The quantified collection is missing or is not an array.',
        });
      }
      const children = collection.map((item) =>
        evaluateExpression(
          expression.condition,
          context,
          Object.freeze({ ...scope, [expression.variable]: item })
        )
      );
      const result: JudgeTruth = expression.op === 'every'
        ? children.some((child) => child.result === false)
          ? false
          : children.some((child) => child.result === 'unknown')
            ? 'unknown'
            : true
        : children.some((child) => child.result === true)
          ? true
          : children.some((child) => child.result === 'unknown')
            ? 'unknown'
            : false;
      return Object.freeze({ expression, result, children });
    }
  }
}

export function evaluateJudgeVerdictPolicy(
  policy: JudgeVerdictPolicy,
  context: JudgePolicyContext
): JudgePolicyEvaluation {
  const facts = context.facts ?? [];
  const missingFacts = (policy.requires ?? []).filter((requirement) =>
    !facts.some((fact) =>
      judgeFactMeetsRequirement(
        fact,
        requirement,
        context.workspaceDigest
      )
    )
  );
  const trace = missingFacts.length > 0
    ? Object.freeze({
        expression: policy.passWhen,
        result: 'unknown' as const,
        reason: 'One or more required facts are unavailable or untrusted.',
      })
    : evaluateExpression(policy.passWhen, context, Object.freeze({}));

  let score: number | undefined;
  if (policy.score) {
    const totalWeight = policy.score.dimensions.reduce(
      (sum, dimension) => sum + dimension.weight,
      0
    );
    if (totalWeight > 0) {
      const earnedWeight = policy.score.dimensions.reduce(
        (sum, dimension) =>
          sum +
          (
            evaluateExpression(
              dimension.when,
              context,
              Object.freeze({})
            ).result === true
              ? dimension.weight
              : 0
          ),
        0
      );
      score = Math.round((earnedWeight / totalWeight) * 10_000) / 100;
    }
  }

  return Object.freeze({
    result: trace.result,
    ...(score === undefined ? {} : { score }),
    trace,
    missingFacts: Object.freeze(missingFacts),
  });
}

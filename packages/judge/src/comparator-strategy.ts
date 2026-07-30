import type {
  JudgeComparator,
  JudgeComparisonInput,
  JudgeComparisonResult,
} from './comparison';

export type JudgeCompareMode =
  | 'exact'
  | 'unordered-array'
  | 'unordered-nested-array';

export type JudgeCustomValidatorId =
  | 'alien-order'
  | 'course-schedule-order'
  | 'n-queens-solutions'
  | 'tree-round-trip'
  | 'top-k-result'
  | 'two-sum-indices';

export interface JudgeComparatorStrategy {
  readonly schema: 'tracecode.judge.comparator.v1';
  readonly mode?: JudgeCompareMode;
  readonly customValidator?: JudgeCustomValidatorId;
  readonly floatTolerance?: boolean;
}

/**
 * Serializable comparison policy carried by an algorithm bundle.
 *
 * A problem may define one default comparison rule and override it for the
 * small number of cases whose valid outputs are described by a different
 * predicate. Executable comparator functions never cross a Judge authority
 * boundary.
 */
export interface JudgeComparatorPolicy {
  readonly schema: 'tracecode.judge.comparator-policy.v1';
  readonly default: JudgeComparatorStrategy;
  readonly cases?: Readonly<Record<string, JudgeComparatorStrategy>>;
}

const comparatorModes = new Set<JudgeCompareMode>([
  'exact',
  'unordered-array',
  'unordered-nested-array',
]);
const customValidators = new Set<JudgeCustomValidatorId>([
  'alien-order',
  'course-schedule-order',
  'n-queens-solutions',
  'tree-round-trip',
  'top-k-result',
  'two-sum-indices',
]);

function assertComparatorStrategy(
  value: unknown,
  label: string
): asserts value is JudgeComparatorStrategy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const strategy = value as Record<string, unknown>;
  if (strategy.schema !== 'tracecode.judge.comparator.v1') {
    throw new TypeError(`${label} uses an unsupported schema.`);
  }
  if (
    strategy.mode !== undefined &&
    !comparatorModes.has(strategy.mode as JudgeCompareMode)
  ) {
    throw new TypeError(`${label} uses an unsupported comparison mode.`);
  }
  if (
    strategy.customValidator !== undefined &&
    !customValidators.has(
      strategy.customValidator as JudgeCustomValidatorId
    )
  ) {
    throw new TypeError(`${label} uses an unsupported custom validator.`);
  }
  if (
    strategy.floatTolerance !== undefined &&
    typeof strategy.floatTolerance !== 'boolean'
  ) {
    throw new TypeError(`${label} float tolerance must be boolean.`);
  }
}

/**
 * Validates a serialized comparator policy before Judge materializes the
 * corresponding executable comparator inside its own authority.
 */
export function assertJudgeComparatorPolicy(
  value: unknown
): asserts value is JudgeComparatorPolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Judge comparator policy must be an object.');
  }
  const policy = value as Record<string, unknown>;
  if (policy.schema !== 'tracecode.judge.comparator-policy.v1') {
    throw new TypeError('Unsupported Judge comparator policy schema.');
  }
  assertComparatorStrategy(policy.default, 'Judge default comparator');
  if (policy.cases === undefined) return;
  if (
    policy.cases === null ||
    typeof policy.cases !== 'object' ||
    Array.isArray(policy.cases)
  ) {
    throw new TypeError('Judge case comparators must be an object.');
  }
  const entries = Object.entries(policy.cases as Record<string, unknown>);
  if (entries.length > 1_024) {
    throw new TypeError('Judge comparator policy contains too many cases.');
  }
  for (const [caseId, strategy] of entries) {
    if (
      !caseId ||
      caseId.length > 512 ||
      caseId === '__proto__' ||
      caseId === 'prototype' ||
      caseId === 'constructor'
    ) {
      throw new TypeError('Judge comparator case id is unsafe.');
    }
    assertComparatorStrategy(
      strategy,
      `Judge comparator for case ${JSON.stringify(caseId)}`
    );
  }
}

const METADATA_KEYS = new Set(['__class__', '__id__', '__type__']);
const FLOAT_ABS_EPSILON = 1e-10;
const FLOAT_REL_EPSILON = 1e-9;

function compareNumbers(
  actual: number,
  expected: number,
  tolerance: boolean
): boolean {
  if (!tolerance || (Number.isInteger(actual) && Number.isInteger(expected))) {
    return actual === expected;
  }
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
    return actual === expected;
  }
  const difference = Math.abs(actual - expected);
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  return difference <= Math.max(
    FLOAT_ABS_EPSILON,
    FLOAT_REL_EPSILON * scale
  );
}

function compareUnordered(
  actual: readonly unknown[],
  expected: readonly unknown[],
  compareElement: (left: unknown, right: unknown) => boolean
): boolean {
  if (actual.length !== expected.length) return false;
  const matched = new Set<number>();
  return actual.every((actualValue) => {
    const index = expected.findIndex(
      (expectedValue, expectedIndex) =>
        !matched.has(expectedIndex) &&
        compareElement(actualValue, expectedValue)
    );
    if (index < 0) return false;
    matched.add(index);
    return true;
  });
}

export function compareJudgeValues(
  actual: unknown,
  expected: unknown,
  mode: JudgeCompareMode = 'exact',
  floatTolerance = true
): boolean {
  if (actual === expected) return true;
  if (
    (actual === undefined && expected === null) ||
    (actual === null && expected === undefined)
  ) {
    return true;
  }
  if (actual === null || expected === null) return false;
  if (actual === undefined || expected === undefined) return false;
  if (typeof actual === 'number' && typeof expected === 'number') {
    return compareNumbers(actual, expected, floatTolerance);
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (mode === 'unordered-array') {
      return compareUnordered(actual, expected, (left, right) =>
        compareJudgeValues(left, right, 'exact', floatTolerance)
      );
    }
    if (mode === 'unordered-nested-array') {
      return compareUnordered(actual, expected, (left, right) =>
        Array.isArray(left) && Array.isArray(right)
          ? compareUnordered(left, right, (nestedLeft, nestedRight) =>
              compareJudgeValues(
                nestedLeft,
                nestedRight,
                'exact',
                floatTolerance
              )
            )
          : compareJudgeValues(left, right, 'exact', floatTolerance)
      );
    }
    if (actual.length !== expected.length) return false;
    return actual.every((value, index) =>
      compareJudgeValues(value, expected[index], mode, floatTolerance)
    );
  }
  if (typeof actual === 'object' && typeof expected === 'object') {
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    const actualKeys = Object.keys(actualRecord).filter(
      (key) => !METADATA_KEYS.has(key)
    );
    const expectedKeys = Object.keys(expectedRecord).filter(
      (key) => !METADATA_KEYS.has(key)
    );
    return (
      actualKeys.length === expectedKeys.length &&
      actualKeys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(expectedRecord, key) &&
          compareJudgeValues(
            actualRecord[key],
            expectedRecord[key],
            mode,
            floatTolerance
          )
      )
    );
  }
  return false;
}

function isValidTopK(
  actual: unknown[],
  nums: unknown[],
  requested: number
): boolean {
  const frequencies = new Map<unknown, number>();
  for (const value of nums) {
    frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
  }
  const k = Math.max(0, Math.min(Math.floor(requested), frequencies.size));
  if (actual.length !== k || new Set(actual).size !== actual.length) return false;
  if (k === 0) return true;
  const cutoff = [...frequencies.values()].sort((a, b) => b - a)[k - 1];
  if (cutoff === undefined) return false;
  const required = new Set<unknown>();
  const eligible = new Set<unknown>();
  for (const [value, count] of frequencies) {
    if (count > cutoff) required.add(value);
    if (count >= cutoff) eligible.add(value);
  }
  return (
    [...required].every((value) => actual.includes(value)) &&
    actual.every((value) => eligible.has(value))
  );
}

function validNQueensBoard(board: unknown, n: number): board is string[] {
  if (
    !Array.isArray(board) ||
    board.length !== n ||
    !board.every(
      (row) =>
        typeof row === 'string' &&
        row.length === n &&
        /^[.Q]+$/.test(row)
    )
  ) {
    return false;
  }
  const columns = new Set<number>();
  const ascending = new Set<number>();
  const descending = new Set<number>();
  for (let row = 0; row < n; row += 1) {
    const queens = [...board[row]!]
      .flatMap((value, column) => value === 'Q' ? [column] : []);
    if (queens.length !== 1) return false;
    const column = queens[0]!;
    if (
      columns.has(column) ||
      ascending.has(row - column) ||
      descending.has(row + column)
    ) {
      return false;
    }
    columns.add(column);
    ascending.add(row - column);
    descending.add(row + column);
  }
  return true;
}

const N_QUEENS_COUNTS: Readonly<Record<number, number>> = Object.freeze({
  1: 1,
  2: 0,
  3: 0,
  4: 2,
  5: 10,
  6: 4,
  7: 40,
  8: 92,
  9: 352,
});

function alienGraphHasOrder(words: readonly string[]): boolean {
  const characters = new Set(words.flatMap((word) => [...word]));
  const edges = new Map([...characters].map((value) => [value, new Set<string>()]));
  const indegree = new Map([...characters].map((value) => [value, 0]));
  for (let index = 0; index + 1 < words.length; index += 1) {
    const first = words[index]!;
    const second = words[index + 1]!;
    if (first.length > second.length && first.startsWith(second)) return false;
    for (
      let character = 0;
      character < Math.min(first.length, second.length);
      character += 1
    ) {
      const before = first[character]!;
      const after = second[character]!;
      if (before === after) continue;
      if (!edges.get(before)!.has(after)) {
        edges.get(before)!.add(after);
        indegree.set(after, (indegree.get(after) ?? 0) + 1);
      }
      break;
    }
  }
  const queue = [...characters].filter((value) => indegree.get(value) === 0);
  let visited = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const value = queue[index]!;
    visited += 1;
    for (const next of edges.get(value) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  return visited === characters.size;
}

function validAlienOrder(words: readonly string[], order: string): boolean {
  const characters = new Set(words.flatMap((word) => [...word]));
  if (order.length !== characters.size) return false;
  const position = new Map<string, number>();
  for (let index = 0; index < order.length; index += 1) {
    const character = order[index]!;
    if (!characters.has(character) || position.has(character)) return false;
    position.set(character, index);
  }
  for (let index = 0; index + 1 < words.length; index += 1) {
    const first = words[index]!;
    const second = words[index + 1]!;
    if (first.length > second.length && first.startsWith(second)) return false;
    for (
      let character = 0;
      character < Math.min(first.length, second.length);
      character += 1
    ) {
      if (first[character] === second[character]) continue;
      if (
        (position.get(first[character]!) ?? -1) >=
        (position.get(second[character]!) ?? -1)
      ) {
        return false;
      }
      break;
    }
  }
  return true;
}

function hasDirectedCycle(
  courseCount: number,
  prerequisites: readonly unknown[]
): boolean {
  const outgoing = Array.from({ length: courseCount }, () => [] as number[]);
  const indegree = Array.from({ length: courseCount }, () => 0);
  for (const rawEdge of prerequisites) {
    if (!Array.isArray(rawEdge) || rawEdge.length !== 2) return false;
    const [course, prerequisite] = rawEdge;
    if (
      !Number.isInteger(course) ||
      !Number.isInteger(prerequisite) ||
      (course as number) < 0 ||
      (course as number) >= courseCount ||
      (prerequisite as number) < 0 ||
      (prerequisite as number) >= courseCount
    ) {
      return false;
    }
    outgoing[prerequisite as number]!.push(course as number);
    indegree[course as number]! += 1;
  }
  const queue = indegree.flatMap((degree, course) =>
    degree === 0 ? [course] : []
  );
  let visited = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const course = queue[index]!;
    visited += 1;
    for (const next of outgoing[course]!) {
      indegree[next]! -= 1;
      if (indegree[next] === 0) queue.push(next);
    }
  }
  return visited !== courseCount;
}

type CanonicalTree = {
  readonly val: unknown;
  readonly left: CanonicalTree;
  readonly right: CanonicalTree;
} | null;
const INVALID_TREE = Symbol('invalid-tree');

function canonicalTree(value: unknown): CanonicalTree | typeof INVALID_TREE {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 0 || value[0] === null || value[0] === undefined) {
      return value.every((entry) => entry === null || entry === undefined)
        ? null
        : INVALID_TREE;
    }
    const root: { val: unknown; left: CanonicalTree; right: CanonicalTree } = {
      val: value[0],
      left: null,
      right: null,
    };
    const queue = [root];
    let cursor = 1;
    for (
      let queueIndex = 0;
      queueIndex < queue.length && cursor < value.length;
      queueIndex += 1
    ) {
      const node = queue[queueIndex]!;
      for (const side of ['left', 'right'] as const) {
        if (cursor >= value.length) break;
        const entry = value[cursor++];
        if (entry === null || entry === undefined) continue;
        const child = { val: entry, left: null, right: null };
        node[side] = child;
        queue.push(child);
      }
    }
    return cursor === value.length ? root : INVALID_TREE;
  }
  if (typeof value !== 'object') return INVALID_TREE;
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, '__ref__')) {
    return INVALID_TREE;
  }
  const hasVal = Object.prototype.hasOwnProperty.call(record, 'val');
  const hasValue = Object.prototype.hasOwnProperty.call(record, 'value');
  if (!hasVal && !hasValue) return INVALID_TREE;
  const left = canonicalTree(record.left);
  const right = canonicalTree(record.right);
  return left === INVALID_TREE || right === INVALID_TREE
    ? INVALID_TREE
    : {
        val: hasVal ? record.val : record.value,
        left,
        right,
      };
}

export function runJudgeCustomValidator(
  validator: JudgeCustomValidatorId,
  actual: unknown,
  input: Readonly<Record<string, unknown>>
): boolean {
  switch (validator) {
    case 'two-sum-indices': {
      if (!Array.isArray(actual) || actual.length !== 2) return false;
      const nums = input.nums;
      const target = input.target;
      if (!Array.isArray(nums) || typeof target !== 'number') return false;
      const [left, right] = actual;
      return (
        Number.isInteger(left) &&
        Number.isInteger(right) &&
        left !== right &&
        (left as number) >= 0 &&
        (right as number) >= 0 &&
        (left as number) < nums.length &&
        (right as number) < nums.length &&
        typeof nums[left as number] === 'number' &&
        typeof nums[right as number] === 'number' &&
        (nums[left as number] as number) +
          (nums[right as number] as number) === target
      );
    }
    case 'top-k-result':
      return (
        Array.isArray(actual) &&
        Array.isArray(input.nums) &&
        typeof input.k === 'number' &&
        isValidTopK(actual, input.nums, input.k)
      );
    case 'n-queens-solutions': {
      if (!Number.isInteger(input.n) || !Array.isArray(actual)) return false;
      const n = input.n as number;
      if (actual.length !== N_QUEENS_COUNTS[n]) return false;
      const boards = actual.filter((board) => validNQueensBoard(board, n));
      return (
        boards.length === actual.length &&
        new Set(boards.map((board) => JSON.stringify(board))).size ===
          boards.length
      );
    }
    case 'alien-order': {
      const words = input.words;
      if (
        !Array.isArray(words) ||
        !words.every((word) => typeof word === 'string') ||
        typeof actual !== 'string'
      ) {
        return false;
      }
      return actual.length === 0
        ? !alienGraphHasOrder(words)
        : validAlienOrder(words, actual);
    }
    case 'course-schedule-order': {
      if (
        !Number.isInteger(input.numCourses) ||
        (input.numCourses as number) < 0 ||
        !Array.isArray(input.prerequisites) ||
        !Array.isArray(actual)
      ) {
        return false;
      }
      const count = input.numCourses as number;
      if (actual.length === 0) {
        return hasDirectedCycle(count, input.prerequisites);
      }
      if (
        actual.length !== count ||
        !actual.every((course) => Number.isInteger(course)) ||
        new Set(actual).size !== count
      ) {
        return false;
      }
      const order = actual as number[];
      if (order.some((course) => course < 0 || course >= count)) return false;
      const position = new Map(order.map((course, index) => [course, index]));
      return input.prerequisites.every((rawEdge) => {
        if (!Array.isArray(rawEdge) || rawEdge.length !== 2) return false;
        const [course, prerequisite] = rawEdge;
        return (
          Number.isInteger(course) &&
          Number.isInteger(prerequisite) &&
          (position.get(prerequisite as number) ?? Infinity) <
            (position.get(course as number) ?? -Infinity)
        );
      });
    }
    case 'tree-round-trip': {
      const actualTree = canonicalTree(actual);
      const expectedTree = canonicalTree(input.root);
      return (
        actualTree !== INVALID_TREE &&
        expectedTree !== INVALID_TREE &&
        compareJudgeValues(actualTree, expectedTree)
      );
    }
  }
}

function comparatorStrategy(
  policy: JudgeComparatorStrategy | JudgeComparatorPolicy,
  caseId: string
): JudgeComparatorStrategy {
  return policy.schema === 'tracecode.judge.comparator-policy.v1'
    ? policy.cases?.[caseId] ?? policy.default
    : policy;
}

export function createJudgeComparator<
  Input extends Record<string, unknown> = Record<string, unknown>,
>(
  policy: JudgeComparatorStrategy | JudgeComparatorPolicy
): JudgeComparator<Input> {
  const id = [
    'tracecode',
    policy.schema === 'tracecode.judge.comparator-policy.v1'
      ? 'case-policy'
      : policy.customValidator ?? policy.mode ?? 'exact',
    'v1',
  ].join(':');
  return Object.freeze({
    id,
    compare({
      caseId,
      input,
      expected,
      actual,
    }: JudgeComparisonInput<Input>): JudgeComparisonResult {
      const strategy = comparatorStrategy(policy, caseId);
      const matched = strategy.customValidator
        ? runJudgeCustomValidator(strategy.customValidator, actual, input)
        : compareJudgeValues(
            actual,
            expected,
            strategy.mode,
            strategy.floatTolerance ?? true
          );
      return Object.freeze({
        matched,
        ...(matched
          ? {}
          : {
              message: strategy.customValidator
                ? `Output did not satisfy ${strategy.customValidator}.`
                : 'Output did not satisfy the configured comparison strategy.',
            }),
      });
    },
  });
}

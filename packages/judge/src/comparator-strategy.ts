import type {
  JudgeComparator,
  JudgeComparisonInput,
  JudgeComparisonResult,
} from './comparison';
import { isArrayIndex, refineGraphSignatures, type GraphReferenceIndex } from './graph-refinement';

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

// Preserve the original short-circuit and array comparison semantics for values
// without resolved graph references.
function compareNonGraphValues(
  actual: unknown,
  expected: unknown,
  mode: JudgeCompareMode,
  floatTolerance: boolean
): boolean {
  if (actual === expected ||
    (actual === undefined && expected === null) ||
    (actual === null && expected === undefined)) return true;
  if (typeof actual === 'number' && typeof expected === 'number') {
    return compareNumbers(actual, expected, floatTolerance);
  }
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') {
    return false;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    const exact = (left: unknown, right: unknown) =>
      compareNonGraphValues(left, right, 'exact', floatTolerance);
    if (mode === 'unordered-array') return compareUnordered(actual, expected, exact);
    if (mode === 'unordered-nested-array') {
      return compareUnordered(actual, expected, (left, right) =>
        Array.isArray(left) && Array.isArray(right) ? compareUnordered(left, right, exact) : exact(left, right)
      );
    }
    return actual.length === expected.length && actual.every((value, index) =>
      compareNonGraphValues(value, expected[index], mode, floatTolerance)
    );
  }
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const actualKeys = Object.keys(actualRecord).filter((key) => !METADATA_KEYS.has(key));
  const expectedKeys = Object.keys(expectedRecord).filter((key) => !METADATA_KEYS.has(key));
  return actualKeys.length === expectedKeys.length && actualKeys.every((key) =>
    Object.hasOwn(expectedRecord, key) &&
    compareNonGraphValues(actualRecord[key], expectedRecord[key], mode, floatTolerance)
  );
}

export const GRAPH_COMPARISON_LIMIT = 'GRAPH_COMPARISON_LIMIT';
// Shared with the app comparator. Charge for a value pair, an ordered child
// slot, or an unordered slot considered for indexing, matching or retrying.
const GRAPH_COMPARISON_STEP_BUDGET = 100_000;

class GraphComparisonLimitError extends Error {
  readonly name = 'GraphComparisonLimitError';
  readonly code = GRAPH_COMPARISON_LIMIT;

  constructor() {
    super(GRAPH_COMPARISON_LIMIT);
  }
}

type DeferredArray = {
  readonly actual: readonly unknown[];
  readonly expected: readonly unknown[];
  readonly nested: boolean;
};

type GraphSearch = {
  step(): void;
  defer(array: DeferredArray): void;
};

const LEAVE_VALUE = Symbol('leave value');

function indexSerializedGraph(
  root: unknown,
  structuralJson: boolean,
  forSearch: boolean
): GraphReferenceIndex & { readonly hasLiveCycle: boolean } {
  const definitions = new Map<string, object | undefined>();
  const markers = new Map<object, string>();
  const visited = new Map<object, 'active' | 'done'>();
  const pending = [root];
  const postorder: object[] = [];
  let canRefine = forSearch;
  let hasLiveCycle = false;
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === LEAVE_VALUE) {
      const node = pending.pop() as object;
      visited.set(node, 'done');
      if (forSearch) postorder.push(node);
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    const state = visited.get(value);
    if (state === 'done') continue;
    if (state === 'active') {
      hasLiveCycle = true;
      continue;
    }
    visited.set(value, 'active');
    pending.push(value, LEAVE_VALUE);
    const keys = Object.keys(value);
    if (Array.isArray(value)) {
      if (keys.length !== value.length) canRefine = false;
      for (const key of keys) {
        if (!isArrayIndex(key)) {
          canRefine = false;
          continue;
        }
        pushDataProperty(value, key);
      }
      continue;
    }
    if (keys.length === 1 && keys[0] === '__ref__') {
      const marker = Object.getOwnPropertyDescriptor(value, '__ref__')?.value;
      if (typeof marker === 'string') {
        markers.set(value, marker);
        continue;
      }
    }
    const id = Object.getOwnPropertyDescriptor(value, '__id__')?.value;
    if (typeof id === 'string') {
      definitions.set(id, definitions.has(id) ? undefined : value);
    }
    for (const key of keys) {
      if (structuralJson || !METADATA_KEYS.has(key)) pushDataProperty(value, key);
    }
  }

  const targets = new Set<object>();
  const references = new Map<object, object>();
  for (const [marker, id] of markers) {
    const target = definitions.get(id);
    // Unresolved or ambiguous markers retain their literal record semantics.
    if (target === undefined) continue;
    references.set(marker, target);
    targets.add(target);
  }
  return { references, targets, postorder, canRefine, hasLiveCycle };

  function pushDataProperty(owner: object, key: string): void {
    // Discover serialized references without evaluating native getters.
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor && 'value' in descriptor) pending.push(descriptor.value);
    else canRefine = false;
  }
}

/** Internal comparison entry point. The optional observer reads the test's search cost. */
export function compareSerializedValues(
  actual: unknown,
  expected: unknown,
  mode: JudgeCompareMode,
  floatTolerance: boolean,
  structuralJson: boolean,
  recordSearchSteps?: (steps: number) => void
): boolean {
  if (actual === expected) return true;
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') {
    return structuralJson ? false : compareNonGraphValues(actual, expected, mode, floatTolerance);
  }
  const actualGraph = indexSerializedGraph(actual, structuralJson, mode !== 'exact');
  const expectedGraph = indexSerializedGraph(expected, structuralJson, mode !== 'exact');
  const hasGraph = actualGraph.targets.size > 0 || expectedGraph.targets.size > 0;
  if (!hasGraph) {
    return structuralJson ? false : compareNonGraphValues(actual, expected, mode, floatTolerance);
  }
  if (actualGraph.hasLiveCycle || expectedGraph.hasLiveCycle) {
    throw new RangeError('Comparison requires cycles to use serialized references.');
  }
  const forward = new Map<object, object>();
  const reverse = new Set<object>();
  const changes: object[] = [];

  function rollback(checkpoint: number): void {
    while (changes.length > checkpoint) {
      const node = changes.pop()!;
      reverse.delete(forward.get(node)!);
      forward.delete(node);
    }
  }

  function compare(
    left: unknown,
    right: unknown,
    currentMode: JudgeCompareMode,
    search?: GraphSearch
  ): boolean {
    const pending: Array<[unknown, unknown]> = [[left, right]];
    while (pending.length > 0) {
      search?.step();
      let [a, b] = pending.pop()!;
      if (a !== null && typeof a === 'object') a = actualGraph.references.get(a) ?? a;
      if (b !== null && typeof b === 'object') b = expectedGraph.references.get(b) ?? b;
      if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
        const aTarget = actualGraph.targets.has(a);
        const bTarget = expectedGraph.targets.has(b);
        if (aTarget !== bTarget) return false;
        if (aTarget) {
          const paired = forward.get(a);
          if (paired !== undefined) {
            if (paired !== b) return false;
            // The first visit owns comparison of the node's payload.
            continue;
          }
          if (reverse.has(b)) return false;
          forward.set(a, b);
          reverse.add(b);
          changes.push(a);
        }

        if (Array.isArray(a) && Array.isArray(b)) {
          if (a.length !== b.length) return false;
          const nested = currentMode === 'unordered-nested-array';
          if (currentMode === 'exact') {
            for (let index = a.length - 1; index >= 0; index--) {
              search?.step();
              if (index in a) pending.push([a[index], b[index]]);
            }
          } else {
            search!.defer({ actual: a, expected: b, nested });
          }
          continue;
        }
        if (structuralJson && Array.isArray(a) !== Array.isArray(b)) return false;
        const aRecord = a as Record<string, unknown>;
        const bRecord = b as Record<string, unknown>;
        const aKeys = Object.keys(aRecord).filter(includeKey);
        const bKeys = Object.keys(bRecord).filter(includeKey);
        if (aKeys.length !== bKeys.length) return false;
        if (search) aKeys.sort();
        for (let index = aKeys.length - 1; index >= 0; index--) {
          search?.step();
          const key = aKeys[index]!;
          if (structuralJson ? key !== bKeys[index] : !Object.hasOwn(bRecord, key)) return false;
          pending.push([aRecord[key], bRecord[key]]);
        }
        continue;
      }

      if (!compareLeaves(a, b)) return false;
    }
    return true;
  }

  function compareLeaves(left: unknown, right: unknown): boolean {
    if (left === right || (!structuralJson && left == null && right == null)) return true;
    return typeof left === 'number' && typeof right === 'number' &&
      compareNumbers(left, right, floatTolerance);
  }

  function includeKey(key: string): boolean {
    return structuralJson ? !(hasGraph && key === '__id__') : !METADATA_KEYS.has(key);
  }

  let searchSteps = 0;
  if (mode === 'exact') return compare(actual, expected, mode);
  try {
    return compareGraphUnordered();
  } finally {
    recordSearchSteps?.(searchSteps);
  }

  function compareGraphUnordered(): boolean {
    let signatures: ReturnType<typeof refineGraphSignatures> | undefined;
    function signature(side: 0 | 1, value: unknown): number {
      signatures ??= refineGraphSignatures(actualGraph, expectedGraph, includeKey, floatTolerance);
      return signatures[side](value);
    }
    function step(): void {
      if (searchSteps === GRAPH_COMPARISON_STEP_BUDGET) throw new GraphComparisonLimitError();
      searchSteps++;
    }

    type ArrayWork = DeferredArray & {
      readonly groups: ReadonlyMap<number, readonly number[]>;
      readonly used: Set<number>;
      readonly index: number;
      readonly next?: ArrayWork;
    };
    type Choice = {
      readonly array: ArrayWork;
      readonly index: number;
      readonly candidates: readonly number[];
      readonly checkpoint: number;
      offset: number;
      selected?: number;
    };
    let work: ArrayWork | undefined;
    const choices: Choice[] = [];

    // Finish fixed object/array edges before choosing an unordered pairing.
    // Any deferred arrays belong to this branch of the search.
    function match(
      left: unknown,
      right: unknown,
      currentMode: JudgeCompareMode,
      resume?: ArrayWork
    ): boolean {
      const deferred: DeferredArray[] = [];
      if (!compare(left, right, currentMode, { step, defer: (array) => deferred.push(array) })) {
        return false;
      }
      work = resume;
      for (let index = deferred.length - 1; index >= 0; index--) {
        const array = deferred[index]!;
        const groups = new Map<number, number[]>();
        for (let slot = 0; slot < array.expected.length; slot++) {
          step();
          const color = signature(1, array.expected[slot]);
          const group = groups.get(color);
          if (group === undefined) groups.set(color, [slot]);
          else group.push(slot);
        }
        work = { ...array, groups, used: new Set(), index: 0, next: work };
      }
      return true;
    }

    if (!match(actual, expected, mode)) return false;
    search: while (true) {
      // Skip sparse actual slots as the ordinary unordered matcher does.
      while (work) {
        const array = work;
        let index = array.index;
        for (; index < array.actual.length; index++) {
          step();
          if (index in array.actual) break;
        }
        if (index < array.actual.length) {
          choices.push({
            array,
            index,
            candidates: array.groups.get(signature(0, array.actual[index])) ?? [],
            checkpoint: changes.length,
            offset: 0,
          });
          break;
        }
        work = array.next;
      }
      if (!work) return true;

      // Keep earlier successful choices until every sibling has matched.
      // Failed branches unwind both their occupied slots and identity bindings.
      while (choices.length > 0) {
        const choice = choices.at(-1)!;
        const { array, candidates, checkpoint, index } = choice;
        if (choice.selected !== undefined) {
          array.used.delete(choice.selected);
          choice.selected = undefined;
        }
        rollback(checkpoint);
        while (choice.offset < candidates.length) {
          step();
          const candidate = candidates[choice.offset++]!;
          if (array.used.has(candidate)) continue;
          const left = array.actual[index];
          const right = array.expected[candidate];
          array.used.add(candidate);
          if (match(left, right, elementMode(array.nested, left, right), { ...array, index: index + 1 })) {
            choice.selected = candidate;
            continue search;
          }
          array.used.delete(candidate);
          rollback(checkpoint);
        }
        choices.pop();
      }
      return false;
    }
  }
}

function elementMode(nested: boolean, actual: unknown, expected: unknown): JudgeCompareMode {
  return nested && Array.isArray(actual) && Array.isArray(expected) ? 'unordered-array' : 'exact';
}

export function compareJudgeValues(
  actual: unknown,
  expected: unknown,
  mode: JudgeCompareMode = 'exact',
  floatTolerance = true
): boolean {
  return compareSerializedValues(actual, expected, mode, floatTolerance, false);
}

export function compareStructuralJsonGraphValues(actual: unknown, expected: unknown): boolean {
  return compareSerializedValues(actual, expected, 'exact', false, true);
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

/** Compare two outputs using a case's equality settings. A custom validator
 * checks whether an answer is valid, so it cannot attest that two runs agree.
 */
export function compareObservationValues(
  policy: JudgeComparatorPolicy,
  caseId: string,
  observed: unknown,
  ordinary: unknown
): boolean | undefined {
  const strategy = comparatorStrategy(policy, caseId);
  if (strategy.customValidator) return undefined;
  return compareJudgeValues(observed, ordinary, strategy.mode, strategy.floatTolerance ?? true);
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

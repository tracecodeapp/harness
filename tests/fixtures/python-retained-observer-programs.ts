// Programs drawn by a retained Python observer, shared by the Node (real
// Pyodide) and browser (BrowserJudgeHost) retained-observer tests. Each
// program's cases are drawn in order on one interpreter and each drawing is
// compared with a fresh interpreter's drawing of the same case.
//
// The comparison is byte for byte, so the programs avoid two places where
// the Python tracer's output depends on heap addresses, between two fresh
// interpreters too (it keys frames and objects by id()):
// - accesses recorded by module-level assignments stay pending under the
//   module frame's id, and are attached to the first learner step whose
//   frame reuses that address. Globals are created inside functions here;
//   a namespace that outlived its drawing would still show, because the
//   next drawing would find them already defined;
// - an object's trace label is keyed by its id, so a freed instance's label
//   is reused for a new instance at the same address. Learner instances are
//   kept alive for the whole drawing here.

export type Style = 'function' | 'solution-method';

export interface Program {
  readonly code: string;
  readonly functionName: string;
  readonly executionStyle: Style;
  /** The classification the program must have. */
  readonly expectTier: 'algorithm-fast' | 'compatibility';
  /** Drawn in this order: the first by Run, the rest by continuation. */
  readonly inputs: readonly Record<string, unknown>[];
  readonly traceOptions?: Record<string, number>;
  /** What each case's call returns, when a test checks it. */
  readonly returns?: readonly unknown[];
}

const lines = (...source: string[]) => source.join('\n');

export const PROGRAMS: Record<string, Program> = {
  // Module globals: a memo, a call counter and histories, created on first
  // use. A drawing that saw an earlier drawing's namespace would skip the
  // creation and continue the counts.
  globalsAndMemo: {
    code: lines(
      'def state():',
      '    global memo, calls, history, order',
      '    try:',
      '        return memo',
      '    except NameError:',
      '        memo, calls, history, order = {}, 0, [], [0]',
      '        return memo',
      '',
      'def fib(n):',
      '    global calls',
      '    table = state()',
      '    calls += 1',
      '    if n in table:',
      '        return table[n]',
      '    value = n if n < 2 else fib(n - 1) + fib(n - 2)',
      '    table[n] = value',
      '    return value',
      '',
      'def solve(n):',
      '    state()',
      '    history.append(n)',
      '    order[0] += 1',
      '    return [fib(n), calls, len(memo), len(history), order[0]]',
    ),
    functionName: 'solve',
    executionStyle: 'function',
    expectTier: 'algorithm-fast',
    inputs: [{ n: 6 }, { n: 5 }, { n: 7 }, { n: 6 }],
  },
  // Mutable default arguments.
  mutableDefaults: {
    code: lines(
      'def collect(value, seen=[], counts={}):',
      '    seen.append(value)',
      '    counts[value] = counts.get(value, 0) + 1',
      '    return [len(seen), counts[value]]',
      '',
      'def solve(values):',
      '    out = []',
      '    for v in values:',
      '        out.append(collect(v))',
      '    return out',
    ),
    functionName: 'solve',
    executionStyle: 'function',
    expectTier: 'algorithm-fast',
    inputs: [{ values: [1, 2, 1] }, { values: [1, 1] }, { values: [3] }, { values: [1, 2, 1] }],
  },
  // Class attributes, on the learner's class and on Solution.
  classAttributes: {
    code: lines(
      'class Tally:',
      '    total = 0',
      '    log = []',
      '',
      '    def __init__(self, step):',
      '        Tally.total += step',
      '        Tally.log.append(step)',
      '        self.snapshot = [Tally.total, len(Tally.log)]',
      '',
      'class Solution:',
      '    made_for = {}',
      '',
      '    def solve(self, n):',
      '        if n in Solution.made_for:',
      '            return Solution.made_for[n]',
      '        alive = [Tally(i) for i in range(1, n + 1)]',
      '        made = [tally.snapshot for tally in alive]',
      '        Solution.made_for[n] = made',
      '        return [made, len(alive)]',
    ),
    functionName: 'solve',
    executionStyle: 'solution-method',
    expectTier: 'algorithm-fast',
    inputs: [{ n: 3 }, { n: 3 }, { n: 2 }, { n: 4 }],
  },
  // Cached recursion, and default-import containers held as globals.
  cachesAndContainers: {
    code: lines(
      'def containers():',
      '    global heap, window, groups, tally',
      '    try:',
      '        return heap',
      '    except NameError:',
      '        heap, window, groups, tally = [], deque(), defaultdict(list), Counter()',
      '        return heap',
      '',
      '@lru_cache(maxsize=None)',
      'def ways(n):',
      '    if n <= 1:',
      '        return 1',
      '    return ways(n - 1) + ways(n - 2)',
      '',
      '@cache',
      'def depth(n):',
      '    return 0 if n == 0 else 1 + depth(n - 1)',
      '',
      'def solve(nums):',
      '    containers()',
      '    for x in nums:',
      '        heappush(heap, x)',
      '        window.append(x)',
      '        groups[x % 3].append(x)',
      '        tally[x] += 1',
      '    best = [heappop(heap) for _ in range(min(2, len(heap)))]',
      '    hits = ways.cache_info()[0]',
      '    return [best, len(window), sorted(groups), tally.most_common(1),',
      '            ways(len(nums) + 5), hits, depth(len(nums) * 10)]',
    ),
    functionName: 'solve',
    executionStyle: 'function',
    expectTier: 'algorithm-fast',
    inputs: [{ nums: [5, 1, 4] }, { nums: [5, 1, 4] }, { nums: [2, 2] }, { nums: [9, 3, 6, 1] }],
  },
  // A seeded global random stream, and an instance stream.
  seededRandom: {
    code: lines(
      'import random',
      '',
      'def solve(seed):',
      '    random.seed(seed)',
      '    first = [random.randint(1, 100) for _ in range(3)]',
      '    rng = random.Random(seed + 1)',
      '    second = [rng.randint(1, 100) for _ in range(3)]',
      '    return [first, second]',
    ),
    functionName: 'solve',
    executionStyle: 'function',
    expectTier: 'algorithm-fast',
    inputs: [{ seed: 1 }, { seed: 2 }, { seed: 1 }],
  },
  // Deep recursion that raises from the bottom, then shallow calls: the
  // tracer's call stack and exception state between drawings.
  recursionAndExceptions: {
    code: lines(
      'def walk(n, path):',
      '    path.append(n)',
      '    if n == 0:',
      '        return len(path)',
      '    return walk(n - 1, path)',
      '',
      'def solve(n, fail):',
      '    trail = []',
      '    total = walk(n, trail)',
      '    print("walked", total)',
      '    if fail:',
      '        raise ValueError("stop at " + str(total))',
      '    return total',
    ),
    functionName: 'solve',
    executionStyle: 'function',
    expectTier: 'algorithm-fast',
    inputs: [
      { n: 40, fail: true },
      { n: 3, fail: false },
      { n: 30, fail: true },
      { n: 5, fail: false },
    ],
  },
  // The tracer's step, line and single-line counters and its stored bytes:
  // each 900-step drawing stays under every budget on its own, but two in a
  // row would not if any counter carried over. The 1,200 case trips the
  // single-line budget (a truncated drawing retires the observer).
  tracerBudgets: {
    code: lines(
      'def solve(n):',
      '    total = 0',
      '    i = 0',
      '    while i < n:',
      '        total += i',
      '        i += 1',
      '    print("total", total)',
      '    return total',
    ),
    functionName: 'solve',
    executionStyle: 'function',
    expectTier: 'algorithm-fast',
    traceOptions: { maxTraceSteps: 4000, maxLineEvents: 12000, maxSingleLineHits: 1000, maxStoredEvents: 16000 },
    inputs: [{ n: 900 }, { n: 900 }, { n: 950 }, { n: 1200 }, { n: 900 }, { n: 900 }],
  },
  // Programs that change shared module or interpreter state are classified
  // off the fast tier; their drawings must still be correct.
  moduleAttributeWrite: {
    code: lines(
      'import heapq',
      '',
      'def solve(n):',
      '    try:',
      '        heapq.tc_hits += n',
      '    except AttributeError:',
      '        heapq.tc_hits = n',
      '    return heapq.tc_hits',
    ),
    functionName: 'solve',
    executionStyle: 'function',
    expectTier: 'compatibility',
    inputs: [{ n: 1 }, { n: 1 }, { n: 2 }],
    returns: [1, 1, 2],
  },
  overloadRegistry: {
    code: lines(
      'from typing import overload, get_overloads',
      '',
      'def solve(n):',
      '    @overload',
      '    def f(x: int) -> int: ...',
      '    def f(x):',
      '        return x',
      '    return [f(n), len(get_overloads(f))]',
    ),
    functionName: 'solve',
    executionStyle: 'function',
    expectTier: 'compatibility',
    inputs: [{ n: 1 }, { n: 2 }, { n: 3 }],
    returns: [[1, 1], [2, 1], [3, 1]],
  },
  recursionLimit: {
    code: lines(
      'def solve(n):',
      '    before = sys.getrecursionlimit()',
      '    sys.setrecursionlimit(before + n)',
      '    return [before, sys.getrecursionlimit()]',
    ),
    functionName: 'solve',
    executionStyle: 'function',
    expectTier: 'compatibility',
    inputs: [{ n: 10 }, { n: 10 }, { n: 25 }],
  },
  compatibilityGlobals: {
    code: lines(
      'def solve(n):',
      '    global seen',
      '    try:',
      '        seen.append(ast.literal_eval(str(n)))',
      '    except NameError:',
      '        seen = [ast.literal_eval(str(n))]',
      '    return [len(seen), sum(seen)]',
    ),
    functionName: 'solve',
    executionStyle: 'function',
    expectTier: 'compatibility',
    inputs: [{ n: 4 }, { n: 4 }, { n: 7 }],
    returns: [[1, 4], [1, 4], [1, 7]],
  },
};

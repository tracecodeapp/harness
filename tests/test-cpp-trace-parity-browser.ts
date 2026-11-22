#!/usr/bin/env node
/**
 * Traced and untraced C++ compute the same answers, in a real C++ worker driven
 * through the public BrowserJudgeHost (Chromium): every control-body form the
 * tracing rewriter normalizes (braceless bodies, one-line `else`/`else if`
 * chains, dangling `else`, loop/jump/macro bodies, comments and literals with
 * `;`/`else`/braces, Allman braces, `if (init; cond)`), the Binary Search
 * repro from the app, and programs the tracer refuses (reported as the
 * provider's failure, never the learner's, while the untraced evaluation still
 * runs them).
 *
 * The forms are grouped by how they used to fail, so a run against an older
 * Harness shows which failure each group had:
 * - compile-forms: the traced build did not compile (the learner was blamed);
 * - silent-forms: the traced build compiled and computed different answers;
 * - repro: the app's Binary Search (Run 0/10, Submit 10/10).
 *
 * Linux needs full Chromium (`channel: 'chromium'`): the headless shell crashes
 * on a C++ WebAssembly out-of-bounds write there. TRACECODE_PARITY_BROWSER_CHANNEL
 * overrides the channel.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from './example-app-smoke';
import {
  formsProgram,
  PARITY_INPUTS,
  type ParityForm,
  type ParityProgram,
  type ParitySample,
} from './fixtures/cpp-trace-parity-entry';

const BROWSER_CHANNEL = process.env.TRACECODE_PARITY_BROWSER_CHANNEL ||
  (process.platform === 'linux' ? 'chromium' : undefined);

const COMPILE_FORMS: ParityForm[] = [
  { name: 'one-line if/else', body: '    if (a < t) a += 3; else b += 5;' },
  {
    name: 'one-line if/else in a binary-search loop',
    body: [
      '    int lo = 0, hi = 20, want = 2 * t + (a & 1);',
      '    while (lo <= hi) {',
      '      int mid = lo + (hi - lo) / 2;',
      '      if (mid == want) { k = mid; break; }',
      '      if (mid < want) lo = mid + 1; else hi = mid - 1;',
      '    }',
    ].join('\n'),
  },
  { name: 'one-line else-if chain', body: '    if (a < 0) k += 1; else if (b < 0) k += 2; else if (t > 1) k += 3; else k += 4;' },
  {
    name: 'Allman braces on if/else and do',
    body: [
      '    if (a < t)',
      '    {',
      '      a += 31;',
      '    }',
      '    else',
      '    {',
      '      b += 32;',
      '    }',
      '    do',
      '    {',
      '      k += 34;',
      '    } while (k < t * 34);',
    ].join('\n'),
  },
  { name: 'dangling else on one line', body: '    if (a > 0) if (b > 0) k += 1; else k += 2;' },
  {
    name: 'dangling else across lines',
    body: ['    if (a > 0)', '      if (b > 0) k += 10;', '      else k += 20;', '    else k += 40;'].join('\n'),
  },
  { name: 'braceless for body under one-line if/else', body: '    if (a < t) for (k = 0; k < 3; k++) b += 2; else b += 50;' },
  { name: 'braceless do-while body under one-line if/else', body: '    if (a < t) do k += 2; while (k < 5); else k -= 3;' },
  { name: 'braceless return bodies', body: '    if (a > t) return 707; else if (b > t) return 808; else k += 1;' },
  { name: 'braced one-line if/else returning in both branches', body: '    if (a > t) { return 909; } else { return 910; }' },
  {
    name: 'braceless break and continue in a one-line braced loop body',
    body: '    while (b < 6) { b += 1; if (b == t + 3) break; else if (b % 2) continue; else k += b; }',
  },
  {
    name: 'braceless if/else as a braceless loop body on the next lines',
    body: ['    while (a < 3)', '      if (a++ == t) break;', '      else continue;', '    k += 1;'].join('\n'),
  },
  {
    name: 'macro-call bodies',
    body: '    if (a < t) BUMP(a); else BUMP(b);\n    if (k == 0) SWAP_DO(a, b); else k += 1;',
  },
  {
    name: 'comments and string literals holding ; else { }',
    body: `    if (a < t) s = "x; else { }"; /* ; } else { */ else s = '}'; // else { ;`,
  },
  {
    name: 'comments holding braces between header, body and else',
    body: [
      '    if (a < t) // pick { the left ;',
      '      a += 11; /* } else { */',
      '    else // else {',
      '      b += 13; // }',
      '    k += 2;',
    ].join('\n'),
  },
  { name: 'character literals holding ; and {', body: "    if (a == t) s += ';'; else s += '{';" },
  { name: 'raw string literal holding ; else { }', body: '    if (a < t) s = R"(; else { })"; else s = "y";' },
  { name: 'one-line do-while (was untraced)', body: '    do k += 1; while (k < t);' },
  { name: 'then-line of if/else with a braced else (was untraced)', body: ['    if (a < t) a += 21; else {', '      b += 22;', '    }'].join('\n') },
  { name: 'two statements and a control statement on one line', body: '    a += 1; if (a > t) b += 51; else b += 52; k += 53;' },
  { name: 'if with an init-statement', body: ['    if (int m = a + b; m > t) {', '      k += m;', '    }'].join('\n') },
  {
    name: 'one-line braceless if, for and while (unchanged forms)',
    body: ['    if (a < t) a += 41;', '    for (k = 0; k < 2; k++) b += 42;', '    while (k < 5) k += 1;'].join('\n'),
  },
  // Review findings 6, 7, 9, and __LINE__ (the same learner line in both builds).
  {
    name: 'do-while with `while` on the line after `}`',
    body: ['    do {', '      k += 1;', '    }', '    while (k < t);', '    b += 61;'].join('\n'),
  },
  {
    name: 'else if constexpr with braceless bodies',
    body: ['    if (a < t) k = 71;', '    else if constexpr (sizeof(int) == 4) k = 72;', '    else k = 73;'].join('\n'),
  },
  {
    name: 'conditions that declare variables with multi-word types',
    body: [
      '    if (unsigned long n = a + 1) k += (int)n;',
      '    if (unsigned long long u = b + 1) { k += 2 * (int)u; }',
      '    if (long double d = 0.5L * t) k += 3;',
      '    if (const auto& r = a) k += 4 * r;',
      '    if (std::size_t z = t) k += 5 * (int)z;',
      '    if (std::string::size_type q = s.size()) k += 6;',
      '    if (int* p = &k) *p += 7;',
      '    for (int i = 0; int j = 2 - i; ++i) k += j;',
    ].join('\n'),
  },
  { name: '__LINE__', body: ['    k = __LINE__ % 1000;', '    if (a < t) k += __LINE__ % 100; else k -= __LINE__ % 10;'].join('\n') },
  // Round 3: indexed writes and calls that compile only on the element itself.
  {
    name: 'int fields of an element written through the index',
    body: ['    vector<QQ> qs(3);', '    int i = 2;', '    qs[i].val = 5;', '    ++qs[i].val;', '    qs[i].val += a;', '    k = qs[i].val;'].join('\n'),
  },
  {
    name: 'a reference to an element',
    body: ['    vector<QQ> qs(3);', '    int i = 1;', '    QQ& qr = qs[i];', '    qr.val = 3 + b;', '    k = qs[1].val;'].join('\n'),
  },
  {
    name: 'elements passed to a lambda taking a non-const reference',
    body: [
      '    array<int, 3> ar{};',
      '    vector<int> v(3, 2);',
      '    auto inc = [](int& x) { x += 4; };',
      '    inc(ar[1]);',
      '    inc(v[2]);',
      '    k = ar[1] * 10 + v[2];',
    ].join('\n'),
  },
  {
    name: 'iterators of elements',
    body: [
      '    vector<string> names(3, "abc");',
      '    vector<set<int>> sets(3);',
      '    int i = 1;',
      '    reverse(names[i].begin(), names[i].end());',
      '    sets[i].insert(a + 5);',
      '    if (sets[i].find(a + 5) != sets[i].end()) k += 1;',
      '    s = names[i];',
    ].join('\n'),
  },
  // Round 3, E and common macros: traced, not refused.
  { name: 'an if-macro used standalone in a braced block', body: ['    {', '      LOG_IF(b > t);', '    }'].join('\n') },
  {
    name: 'common competitive-programming macros (ll, all, F, REP)',
    body: [
      '    vector<ll> v{3, 1, 2};',
      '    if (a < t) sort(all(v));',
      '    pair<int, int> p{a, b};',
      '    if (p.F > 0) k += p.F;',
      '    REP(i, 3) k += (int)v[i] * (i + 1);',
      '    REP(i, 2) {',
      '      k += i;',
      '    }',
    ].join('\n'),
  },
];

// Round 3, B: computed differently by origin/main's traced build (a learner
// expression evaluated twice, or a write that landed on a copy).
const COPY_FORMS: ParityForm[] = [
  { name: 'std::array fill evaluates its argument once', body: ['    array<int, 3> ar{};', '    int i = 1;', '    ar.fill(i++);', '    k = ar[0] * 10 + i;'].join('\n') },
  { name: 'a field read with a side-effecting index', body: ['    vector<QQ> qs(3);', '    int i = 0;', '    k = qs[i++].val;', '    k += 10 * i;'].join('\n') },
  {
    name: 'a field read with a call as index',
    body: ['    vector<QQ> qs(3);', '    int calls = 0;', '    auto pick = [&]() { return calls++ % 3; };', '    k = qs[pick()].val;', '    k += 100 * calls;'].join('\n'),
  },
  {
    name: 'mutating container elements through an index',
    body: [
      '    vector<string> names(3, "n");',
      '    vector<set<int>> sets(3);',
      '    int i = 1;',
      "    names[i].push_back('a');",
      '    sets[i].insert(4);',
      '    sets[i].insert(9);',
      '    sets[i].erase(4);',
      '    vector<vector<int>> rows(2, vector<int>(3, 1));',
      '    rows[i].pop_back();',
      '    rows[i].clear();',
      "    names[i].back() = 'q';",
      "    for (char& c : names[0]) c = 'z';",
      '    k = (int)names[i].size() * 100 + (int)sets[i].size() * 10 + (sets[i].count(9) ? 1 : 0) + (int)rows[i].size() * 1000 + (int)rows[0].size() * 10000;',
      '    s = names[i] + names[0];',
    ].join('\n'),
  },
  // Round 4: writes through parentheses and calls that contain the access,
  // identity at const reference parameters, and arguments bound once
  // without an extra move.
  {
    name: 'writes through a parenthesized element and through std::get',
    body: [
      '    vector<string> names(3, "ab");',
      '    vector<tuple<vector<int>, int>> rows(2, make_tuple(vector<int>{1, 2}, 3));',
      '    int i = 1;',
      '    (names[0]).clear();',
      '    std::get<0>(rows[i]).clear();',
      '    string taken = std::move(names[1]);',
      '    k = (int)names[0].size() * 100 + (int)std::get<0>(rows[i]).size() * 10 + (int)names[1].size();',
      '    s = taken;',
    ].join('\n'),
  },
  {
    name: 'elements at const reference parameters keep their identity',
    body: [
      '    array<int, 3> ar{};',
      '    vector<vector<int>> grid(3, vector<int>(3, 2));',
      '    auto same = [](const int& p, const int& q) { return &p == &q; };',
      '    auto rowSum = [](const vector<int>& row) { int total = 0; for (int value : row) total += value; return total; };',
      '    k = same(ar[0], ar[0]) ? 1000 : 0;',
      '    k += same(grid[0][1], grid[0][1]) ? 100 : 0;',
      '    for (int r = 0; r < 3; r++) k += rowSum(grid[r]);',
    ].join('\n'),
  },
  {
    name: 'fill and push_back arguments bound once, without an extra move',
    body: [
      '    array<string, 3> ar{};',
      '    string seed = "s";',
      '    ar.fill(std::move(seed));',
      '    vector<string> parts;',
      '    string piece = "ab";',
      '    parts.push_back(std::move(piece));',
      '    parts.push_back(seed);',
      '    s = seed + ar[1] + parts[0] + parts[1];',
      '    k = (int)piece.size();',
    ].join('\n'),
  },
  {
    // blast-radius-analysis: `for (int nxt : graph[node])` over a
    // vector<set<int>> did not compile traced on origin/main.
    name: 'range-for over elements of vectors of sets, unordered sets and strings',
    body: [
      '    vector<set<int>> graph(3);',
      '    graph[1].insert(4);',
      '    graph[1].insert(7);',
      '    vector<unordered_set<string>> tags(2);',
      '    tags[0].insert("abc");',
      '    vector<string> names(2, "ab");',
      '    int u = 1;',
      '    for (int nxt : graph[u]) k += nxt;',
      '    for (const auto& tag : tags[0]) k += (int)tag.size() * 10;',
      "    for (char& c : names[0]) c = 'z';",
      '    s = names[0];',
    ].join('\n'),
  },
  {
    name: 'struct members of an element',
    body: [
      '    vector<QQ> qs(3);',
      '    int i = 2;',
      '    qs[i].name = "xy";',
      '    qs[i].name += "z";',
      '    qs[i].adj.push_back(4);',
      '    qs[i].adj.push_back(6);',
      '    qs[i].adj[0] = 7;',
      '    qs[i].seen.insert(3);',
      '    k = (int)qs[i].name.size() * 100 + qs[i].adj[0] * 10 + (int)qs[i].seen.size();',
      '    s = qs[i].name;',
    ].join('\n'),
  },
];

const SILENT_FORMS: ParityForm[] = [
  {
    name: 'braceless else body on the next line',
    body: ['    if (a > t) {', '      a -= 1;', '    } else', '      b += 7;', '    k += 100;'].join('\n'),
  },
  {
    name: 'braceless then body on the next line, then a braceless else',
    body: ['    if (a < t)', '      a += 3;', '    else', '      b += 5;', '    k += 9;'].join('\n'),
  },
  {
    name: 'braceless if nested in a braceless else',
    body: ['    if (a > 1) k += 1;', '    else', '      if (b > 1) k += 2;', '      else k += 4;', '    k += 8;'].join('\n'),
  },
  {
    name: 'braceless while body under a multi-line if/else',
    body: ['    if (a < t)', '      while (k < 4) k += 1;', '    else', '      k -= 1;'].join('\n'),
  },
  {
    name: 'braceless body after a multi-line condition',
    body: ['    if (a < t &&', '        b < t)', '      k += 5;', '    k += 6;'].join('\n'),
  },
  {
    name: 'Allman braces on an if without else',
    body: ['    if (b > t)', '    {', '      k += 33;', '    }'].join('\n'),
  },
];

const REPRO = [
  '#include <vector>',
  'using namespace std;',
  'class Solution {',
  'public:',
  '  int search(vector<int>& nums, int target) {',
  '    int left = 0, right = (int)nums.size() - 1;',
  '    while (left <= right) {',
  '      int mid = left + (right - left) / 2;',
  '      if (nums[mid] == target) return mid;',
  '      if (nums[mid] < target) left = mid + 1; else right = mid - 1;',
  '    }',
  '    return -1;',
  '  }',
  '};',
].join('\n');
const REPRO_CASES: Array<{ nums: number[]; target: number; expected: number }> = [
  { nums: [-1, 0, 3, 5, 9, 12], target: 9, expected: 4 },
  { nums: [-1, 0, 3, 5, 9, 12], target: 2, expected: -1 },
  { nums: [5], target: 5, expected: 0 },
  { nums: [2, 5], target: 5, expected: 1 },
  { nums: [1, 3, 5, 7, 9, 11, 13], target: 1, expected: 0 },
];

// [id, prelude, body]: programs the tracer refuses (rare forms it cannot
// instrument without changing them); each is valid C++ that runs untraced.
const REFUSED_PROGRAMS: Array<[string, string, string]> = [
  ['multi-statement-macro-body', '#define TWICE(x) x; x', '    if (a < t) TWICE(k++);'],
  ['loop-macro-body-on-next-line', '#define REP(i, n) for (int i = 0; i < (n); i++)', '    REP(i, 3)\n      k += i;'],
  ['attributed-block-body', '', ['    if (a == 99)', '      [[likely]] { ++k; }', '    k += 2;'].join('\n')],
  ['multi-statement-macro-alias', '#define TWICE(x) x; x\n#define APPLY(x) TWICE(x)', '    if (a < t) APPLY(++k);'],
  ['multi-statement-macro-as-argument', '#define TWICE(x) x; x\n#define CALL(f, x) f(x)', '    if (a < t) CALL(TWICE, ++k);'],
  ['line-comment-continued-by-backslash', '', ['    if (a < t) k = 1; // note \\', '    k = 5;'].join('\n')],
  ['multiline-raw-string', '', ['    s = R"(a', 'b)";'].join('\n')],
  ['learner-line-directive', '', ['#line 700', '    k = __LINE__;'].join('\n')],
  ['function-name', '', '    s = __func__;'],
  ['braceless-switch', '', ['    switch (t)', '      case 1: k = 7;'].join('\n')],
  ['macros-hiding-braces', '#define BEGIN {\n#define END }', '    if (a < t) BEGIN k = 1; END'],
  ['undelimited-control-statement', '#define REP2(i, n) for (int i = 0; i < (n); i++)', '    if (a < t) REP2(i, 2) if (i) k += i;'],
  // Round 3, A: the traced build does not compile (instrumentation defects
  // the compile safety net catches), while the program does.
  ['traced-build-compile-error-decltype-condition', '', '    if (decltype(k) n = k + 1) k += n;'],
  [
    'traced-build-compile-error-while-declaration',
    '',
    [
      '    struct Node { int val; Node* next; };',
      '    Node n2{2, nullptr};',
      '    Node n1{1, &n2};',
      '    Node* head = &n1;',
      '    while (Node* p = head) { k += p->val; head = p->next; }',
    ].join('\n'),
  ],
  // A container parameter of a learner function is itself traced
  // (tracecode::Vector<int>&), so a plain element of a traced vector cannot
  // bind to it; origin/main failed the same way and blamed the learner.
  [
    'traced-build-compile-error-element-to-traced-container-parameter',
    '',
    [
      '    vector<vector<int>> g(3, vector<int>(2, 1));',
      '    auto bump = [](vector<int>& row) { row[0] += 2; };',
      '    bump(g[2]);',
      '    k = g[2][0];',
    ].join('\n'),
  ],
  // Round 3, C, D, E.
  ['two-do-while-zero-macro', '#define TWO do { ++k; } while (0); do { ++k; } while (0)', '    if (a < t) TWO;'],
  ['redefined-macro', '#define STEP(x) x; x\n#define USE_STEP(x) STEP(x)\n#undef STEP\n#define STEP(x) ((x) += 1)', '    if (a < t) STEP(k);'],
  ['continued-directive-comment', '#define X1 1 // note \\\n#define Y1 2', '    k = X1;'],
  ['multiline-function-macro', '#define ADD2(p, q) \\\n  ((p) + (q))', '    k = ADD2(a, b);'],
  ['hidden-line-directive', '', ['#/**/line 700', '    k = __LINE__;'].join('\n')],
  ['function-name-in-macro', '#define FN __func__', '    s = FN;'],
  ['if-macro-braceless-body', '', '    if (a < t) LOG_IF(b > t);'],
  ['if-macro-followed-by-else', '', '    LOG_IF(b > t); else k -= 1;'],
  ['else-macro', '#define OTHERWISE else', '    if (a < t) k = 1; OTHERWISE k = 2;'],
  // Round 4, item 3.
  ['multi-statement-macro-defined-with-a-comment', '#/**/define TWICE2(x) x; x', '    if (a < t) TWICE2(k++);'],
];

function refusedProgram(prelude: string, body: string): string {
  return formsProgram([{ name: 'refused', body }]).replace('class Solution {', `${prelude}\nclass Solution {`);
}

function formsCases(forms: readonly ParityForm[]) {
  return forms.flatMap((_form, formIndex) =>
    PARITY_INPUTS.map((input, inputIndex) => ({
      id: `form-${formIndex + 1}-input-${inputIndex + 1}`,
      input: { form: formIndex + 1, ...input },
    }))
  );
}

function formsParityProgram(id: string, forms: readonly ParityForm[]): ParityProgram {
  const cases = formsCases(forms);
  return {
    id,
    code: formsProgram(forms),
    functionName: 'solve',
    cases,
    // Every form's first input is recorded; every case runs in the traced build.
    tracedCaseIds: cases.filter((testCase) => testCase.id.endsWith('-input-1')).map((testCase) => testCase.id),
  };
}

const PROGRAMS: ParityProgram[] = [
  formsParityProgram('compile-forms', COMPILE_FORMS),
  formsParityProgram('silent-forms', SILENT_FORMS),
  formsParityProgram('copy-forms', COPY_FORMS),
  {
    id: 'repro',
    code: REPRO,
    functionName: 'search',
    cases: REPRO_CASES.map(({ nums, target }, index) => ({ id: `case-${index + 1}`, input: { nums, target } })),
    tracedCaseIds: ['case-1'],
  },
  {
    id: 'refused-multi-statement-macro-body',
    code: refusedProgram('#define TWICE(x) x; x', '    if (a < t) TWICE(k++);'),
    functionName: 'solve',
    cases: formsCases([{ name: 'refused', body: '' }]),
    tracedCaseIds: ['form-1-input-1'],
  },
  ...REFUSED_PROGRAMS.map(([id, prelude, body]) => ({
    id: `refused-${id}`,
    code: refusedProgram(prelude, body),
    functionName: 'solve',
    cases: formsCases([{ name: 'refused', body: '' }]),
    tracedCaseIds: ['form-1-input-1'],
  })),
  // A refused program that does not compile: the traced Run reports the
  // learner's compile error, as the untraced evaluation does, not a refusal.
  {
    id: 'invalid-refused-program',
    code: refusedProgram('#define TWICE(x) x; x', '    if (a < t) TWICE(k++); else b += 1;'),
    functionName: 'solve',
    cases: formsCases([{ name: 'invalid', body: '' }]),
    tracedCaseIds: ['form-1-input-1'],
  },
];

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.wasm': return 'application/wasm';
    default: return 'application/octet-stream';
  }
}

async function startServer(root: string) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const headers = {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    const candidate = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const filePath = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!existsSync(filePath)) {
      response.writeHead(404, headers).end('Not found');
      return;
    }
    response.writeHead(200, {
      ...headers,
      'Content-Length': String(statSync(filePath).size),
      'Content-Type': contentType(filePath),
    });
    createReadStream(filePath).pipe(response);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections?.();
    }),
  };
}

function lineOf(source: string, needle: string): number {
  const index = source.indexOf(needle);
  assert.ok(index >= 0, `program has no ${needle}`);
  return source.slice(0, index).split('\n').length;
}

function formName(programId: string, caseId: string): string {
  const forms = programId === 'compile-forms'
    ? COMPILE_FORMS
    : programId === 'silent-forms'
    ? SILENT_FORMS
    : programId === 'copy-forms'
    ? COPY_FORMS
    : null;
  const match = /^form-(\d+)-input-(\d+)$/.exec(caseId);
  if (!forms || !match) return caseId;
  const input = PARITY_INPUTS[Number(match[2]) - 1];
  return `${forms[Number(match[1]) - 1]?.name} (a=${input.a}, b=${input.b}, t=${input.t})`;
}

function describeRun(run: ParitySample['traced']): string {
  if (run.error) return `threw ${run.errorName}: ${run.error}`;
  if (run.compileFailure) return `compile failed: ${JSON.stringify(run.compileFailure).slice(0, 400)}`;
  return `status ${run.status}`;
}

function checkParity(sample: ParitySample, program: ParityProgram): string[] {
  const problems: string[] = [];
  if (sample.untraced.error || sample.untraced.compileFailure || sample.untraced.cases.length !== program.cases.length) {
    return [`untraced evaluation: ${describeRun(sample.untraced)}`];
  }
  if (sample.traced.error || sample.traced.compileFailure || sample.traced.cases.length !== program.cases.length) {
    return [`traced Run: ${describeRun(sample.traced)}`];
  }
  for (const testCase of program.cases) {
    const untraced = sample.untraced.cases.find((entry) => entry.id === testCase.id);
    const traced = sample.traced.cases.find((entry) => entry.id === testCase.id);
    const label = formName(program.id, testCase.id);
    if (untraced?.status !== 'completed') {
      problems.push(`${label}: untraced ${untraced?.status} ${JSON.stringify(untraced?.failure ?? '')}`);
      continue;
    }
    if (traced?.status !== 'completed') {
      problems.push(`${label}: traced ${traced?.status} ${JSON.stringify(traced?.failure ?? '')}`);
      continue;
    }
    if (JSON.stringify(traced.value) !== JSON.stringify(untraced.value)) {
      problems.push(`${label}: traced ${JSON.stringify(traced.value)}, untraced ${JSON.stringify(untraced.value)}`);
    }
    if (program.tracedCaseIds.includes(testCase.id) && !traced.tracedLines?.length) {
      problems.push(`${label}: the traced case has no trace`);
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const root = resolve('.');
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-cpp-trace-parity-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await runCommand('pnpm', ['exec', 'tsx', 'src/cli.ts', 'sync-assets', join(tempRoot, 'workers'), '--languages', 'cpp'], root);
    await build({
      absWorkingDir: root,
      entryPoints: [join(root, 'tests/fixtures/cpp-trace-parity-entry.ts')],
      outfile: join(tempRoot, 'entry.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      alias: {
        zlib: join(root, 'packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': join(root, 'packages/tracekernel/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n', 'utf8');
    server = await startServer(resolve(tempRoot));
    const browser = await chromium.launch({
      headless: true,
      ...(BROWSER_CHANNEL ? { channel: BROWSER_CHANNEL } : {}),
    });
    let samples: ParitySample[];
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(20 * 60_000);
      page.on('pageerror', (error) => console.error(`[pageerror] ${error.message}`));
      await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
      const crashed = new Promise<never>((_, reject) => {
        page.once('crash', () => reject(new Error('the page crashed')));
      });
      crashed.catch(() => undefined);
      samples = (await Promise.race([crashed, page.evaluate(async (options) => {
        const moduleUrl: string = '/entry.mjs';
        const module = await import(moduleUrl);
        return module.runParity(options);
      }, { assetBaseUrl: '/workers', programs: PROGRAMS })])) as ParitySample[];
    } finally {
      await browser.close();
    }

    const failures: string[] = [];
    for (const program of PROGRAMS) {
      const sample = samples.find((entry) => entry.id === program.id);
      assert.ok(sample, `no result for ${program.id}`);
      if (program.id.startsWith('refused-')) {
        // The untraced evaluation runs it; the traced Run is refused as the
        // provider's failure with the reason, never as the learner's.
        const problems: string[] = [];
        const untracedOk = !sample.untraced.error && sample.untraced.cases.length === program.cases.length &&
          sample.untraced.cases.every((testCase) => testCase.status === 'completed');
        if (!untracedOk) problems.push(`untraced evaluation: ${describeRun(sample.untraced)}`);
        const traced = sample.traced;
        const refusalText = /C\+\+ tracing cannot instrument this program/;
        // The machine-readable marker at every layer the app reads: the
        // diagnostic code, the provider failure, and the error the outcome
        // converter throws.
        const marked = traced.compileCode === 'trace-unavailable' &&
          (traced.compileFailure as { origin?: string; reason?: string } | undefined)?.origin === 'provider' &&
          (traced.compileFailure as { reason?: string } | undefined)?.reason === 'runtime-failure' &&
          traced.compileOutcome?.threw === 'RuntimeProviderError' &&
          traced.compileOutcome?.code === 'trace-unavailable';
        if (!marked) problems.push(`refusal is not marked trace-unavailable: ${JSON.stringify({ code: traced.compileCode, failure: traced.compileFailure, outcome: traced.compileOutcome }).slice(0, 400)}`);
        if (program.id.startsWith('refused-traced-build-compile-error') && !/traced build did not compile/.test(JSON.stringify(traced.compileFailure))) {
          problems.push('the compile safety net did not say the traced build failed to compile');
        }
        const reported = traced.error ??
          JSON.stringify(traced.compileFailure ?? traced.cases.map((testCase) => testCase.failure ?? testCase.status));
        if (!refusalText.test(reported)) problems.push(`traced Run was not refused: ${describeRun(traced)} ${reported.slice(0, 400)}`);
        if (/"origin":"program"/.test(reported)) problems.push(`the refusal was reported as the learner's failure: ${reported.slice(0, 400)}`);
        console.log(`${problems.length ? 'FAIL' : 'ok  '} ${program.id}: traced ${describeRun(traced)}${traced.error ? '' : ` ${reported.slice(0, 200)}`}`);
        console.log(`       refusal ms: ${traced.compileMs ?? '?'}`);
        failures.push(...problems.map((problem) => `${program.id}: ${problem}`));
        continue;
      }
      if (program.id.startsWith('invalid-')) {
        // Both builds report the learner's compile error, on the same line.
        const problems: string[] = [];
        const untraced = sample.untraced.compileFailure as { origin?: string; stage?: string; line?: number } | undefined;
        const traced = sample.traced.compileFailure as { origin?: string; stage?: string; line?: number } | undefined;
        if (untraced?.origin !== 'program') problems.push(`untraced evaluation: ${describeRun(sample.untraced)}`);
        if (traced?.origin !== 'program' || traced?.stage !== untraced?.stage || traced?.line !== untraced?.line) {
          problems.push(`traced Run: ${describeRun(sample.traced)}`);
        }
        if (sample.traced.compileCode !== 'compile' || sample.traced.compileOutcome?.diagnosticStage !== 'compile') {
          problems.push(`traced Run is not the learner's compile failure: ${JSON.stringify({ code: sample.traced.compileCode, outcome: sample.traced.compileOutcome })}`);
        }
        // Cost of the compile safety net on a learner compile error: the
        // traced compile, then the untraced one, against the untraced alone.
        console.log(`       compile ms: traced Run ${sample.traced.compileMs ?? '?'}, untraced ${sample.untraced.compileMs ?? '?'}`);
        console.log(`${problems.length ? 'FAIL' : 'ok  '} ${program.id}: traced ${describeRun(sample.traced).slice(0, 200)}`);
        failures.push(...problems.map((problem) => `${program.id}: ${problem}`));
        continue;
      }
      const problems = checkParity(sample, program);
      if (program.id === 'repro' && !problems.length) {
        REPRO_CASES.forEach((testCase, index) => {
          const value = sample.traced.cases.find((entry) => entry.id === `case-${index + 1}`)?.value;
          if (value !== testCase.expected) problems.push(`repro case ${index + 1}: traced ${JSON.stringify(value)}, expected ${testCase.expected}`);
        });
      }
      if (program.id === 'silent-forms' && !problems.length) {
        // The then-body on its own line is traced now (it ran untraced before).
        const thenLine = lineOf(program.code, '      a += 3;');
        const traced = sample.traced.cases.find((entry) => entry.id === 'form-2-input-1');
        if (!traced?.tracedLines?.includes(thenLine)) {
          problems.push(`braceless then body on line ${thenLine} has no trace events: ${JSON.stringify(traced?.tracedLines)}`);
        }
      }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${program.id}: ${program.cases.length} cases traced and untraced`);
      for (const problem of problems) console.log(`       ${problem}`);
      failures.push(...problems.map((problem) => `${program.id}: ${problem}`));
    }
    assert.deepEqual(failures, [], `traced and untraced C++ differ:\n${failures.join('\n')}`);
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('Traced and untraced C++ compute the same answers for every control-body form', main);

// The legacy projection checks only the listed operations. Expected values come
// from executing the source on paper. The full candidate uses the stricter contract.
const method = (body, preamble = '') =>
  [preamble, 'class Solution {', 'public:', '  int solve(int seed) {',
    ...body.split('\n').map(line => '    ' + line), '  }', '};', ''].join('\n');

const witness = (id, family, code, output, ...steps) => ({
  id, family, code, output, steps, functionName: 'solve', inputs: { seed: 1 },
});
const event = (anchor, kind, variable, values, path = []) => ({ anchor, kind, variable, values, path });

export const legacyCases = [
  witness('scalar-overwrite', 'scalars', method('int k = seed;\nk = 7;\nk = 1;\nreturn k;'), 1,
    event('k = 7;', 'write', 'k', [7]), event('k = 1;', 'write', 'k', [1])),
  witness('braceless-write', 'scalars', method('int k = 0;\nif (seed)\n  k = 5;\nreturn k;'), 5,
    event('k = 5;', 'write', 'k', [5])),
  witness('loop-reentry', 'loops', method('int sum = 0;\nfor (int i = 0; i < 2; ++i) {\n  int local = i + 3;\n  sum += local;\n}\nreturn sum;'), 7,
    event('int local = i + 3;', 'write', 'local', [3, 4]),
    event('sum += local;', 'write', 'sum', [3, 7]),
    event('i < 2', 'branch', 'i', [true, true, false])),
  witness('short-skipped-field', 'short circuits', method(
    'ListNode node(4);\nListNode* p = &node;\nint got = 0;\nif (true || p->val == 1) {\n  got = 7;\n}\nreturn got;'), 7,
    event('p->val == 1', 'read', 'p', [], ['val'])),
  witness('short-taken-field', 'short circuits', method(
    'ListNode node(4);\nListNode* p = &node;\nint got = 0;\nif (false || p->val == 4) {\n  got = 7;\n}\nreturn got;'), 7,
    event('p->val == 4', 'read', 'p', [4], ['val'])),
  witness('reference-after-write', 'aliases and references', method(
    'std::vector<int> v(3, 3);\nconst int& ref = v[0];\nv[0] = 9;\nint check = ref;\nreturn check;', '#include <vector>'), 9,
    event('int check = ref;', 'snapshot', 'ref', [9])),
  witness('vector-overwrite', 'vectors and arrays', method(
    'std::vector<int> v(3, 3);\nv[0] = 9;\nint got = v[0];\nreturn got;', '#include <vector>'), 9,
    event('v[0] = 9;', 'write', 'v', [9], [0]), event('int got = v[0];', 'read', 'v', [9], [0])),
  witness('string-element-mutation', 'strings', method(
    "std::vector<std::string> v(1, \"x\");\nv[0].push_back('a');\nreturn int(v[0].size());", '#include <string>\n#include <vector>'), 2,
    event("v[0].push_back('a');", 'write', 'v', ['xa'], [0])),
  witness('map-insert-on-read', 'maps and sets', method(
    'std::map<int, int> m;\nint got = m[2];\nreturn got + int(m.size());', '#include <map>'), 1,
    event('int got = m[2];', 'read', 'm', [0], [2]), event('int got = m[2];', 'write', 'm', [0], [2])),
  witness('set-insert', 'maps and sets', method(
    'std::set<int> s;\ns.insert(seed);\nreturn int(s.size());', '#include <set>'), 1,
    event('s.insert(seed);', 'snapshot', 's', [[1]])),
  witness('struct-field', 'structs', method(
    'Cell cell{seed};\ncell.value = 9;\nint got = cell.value;\nreturn got;', 'struct Cell { int value; };'), 9,
    event('cell.value = 9;', 'write', 'cell', [9], ['value']),
    event('int got = cell.value;', 'read', 'cell', [9], ['value'])),
  witness('recursive-call', 'recursion', method(
    'if (seed == 0) {\n  return 1;\n}\nint got = solve(seed - 1);\nreturn got + 1;'), 2,
    event('int got = solve(seed - 1);', 'call', 'solve', [0])),
  witness('uninitialized-scalar', 'uninitialized locals', method(
    'int unread;\nunread = 9;\nreturn unread;'), 9,
    event('int unread;', 'snapshot', 'unread', []), event('unread = 9;', 'write', 'unread', [9])),
  witness('freed-node', 'other', method(
    'ListNode* gone = new ListNode(3);\ndelete gone;\nint got = seed + 3;\nreturn got;'), 4,
    event('int got = seed + 3;', 'snapshot', 'gone', [])),
  { ...witness('invalid-vector-bool-or', 'compile negative', method(
    'std::vector<bool> flags{false};\nflags[0] |= true;\nreturn seed;', '#include <vector>'), undefined),
    invalid: true },
  witness('string-terminator', 'strings', method(
    'std::string text = "cat";\nchar end = text[text.size()];\nreturn int(end);', '#include <string>'), 0,
    event('char end = text[text.size()];', 'read', 'text', ['\0'], [3])),
];

export const families = [...new Set(legacyCases.filter(c => !c.invalid).map(c => c.family))];

export function lineOf(code, anchor) {
  const start = code.indexOf(anchor);
  if (start < 0 || start !== code.lastIndexOf(anchor)) throw new Error('Ambiguous anchor: ' + anchor);
  return code.slice(0, start).split('\n').length;
}

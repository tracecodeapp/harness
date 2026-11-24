export const mixedExceptionSource = [
  '// try throw catch',
  'const char* text = "throw; try catch";',
  'const auto* raw = u8R"mark("try" // catch /* throw */)mark";',
  'void solve() { throw 7; } // catch',
].join('\r\n');
export const cppExceptionPositives = [
  ['  throw 7;', 'throw', 1, 3],
  ['throw;', 'throw', 1, 1],
  ['try {} catch (...) {}', 'try', 1, 1],
  ['catch (...) {}', 'catch', 1, 1],
  ['A::A() try : x(0) {} catch (...) {}', 'try', 1, 8],
  ['int f() try { return 0; } catch (...) {}', 'try', 1, 9],
  ['#define RAISE throw', 'throw', 1, 15],
  ['#define RAISE throw\nvoid f() { RAISE 7; }', 'throw', 1, 15],
  [['  thr\\', 'ow 7;'].join('\r\n'), 'throw', 1, 3],
  [['// catch \\', 'throw;', '  try {} catch (...) {}'].join('\n'), 'try', 3, 3],
  [['auto s = R\\', '"delim(try)delim";  throw 7;'].join('\n'), 'throw', 2, 21],
  [['auto s = R"de\\', 'lim(catch)delim";  throw 7;'].join('\n'), 'throw', 2, 20],
  [mixedExceptionSource, 'throw', 4, 16],
] as const;

export const cppExceptionNegatives = [
  'int f() noexcept(noexcept(std::stoi("7"))) { return 0; }',
  'v.at(10); std::stoi(s); map.at(k); auto p = new int;',
  'auto thrower = retry + catchup + _throw + throw2 + πthrow + catchπ;',
  String.raw`auto throw\u03c0 = \u03c0try + catch\U000003C0;`,
  '/* try */\n// throw \\\ncatch\nint n;',
  `"try \\"throw" L"catch" u"try" U"throw" u8"catch" '\\'' L'try' u't' U'c' u8't'`,
  'R"(throw)" u8R"x(try " // catch)x" LR"_(catch)_" uR"(throw)" UR"(try)"',
  ['auto s = R"delim()de\\', 'lim" throw )delim";'].join('\n'),
  'auto n = 1\'000; auto x = 1.2e-3; // throw',
  '#include <example/throw>',
  '# /* comment */ include /* comment */ <example/throw>',
  ['auto s = R"delim(try)de\\', 'lim";  throw 7;'].join('\n'),
  ['auto s = R"delim(catch)delim\\', '";  throw 7;'].join('\n'),
] as const;

// Place fragments in a translation unit without changing their tokens.
function ordinaryDriver(source: string): string {
  if (source.startsWith('A::')) {
    return `struct A { int x; A(); };\n${source}\nint main() { return 0; }`;
  }
  if (source === mixedExceptionSource || source.startsWith('int f()') || source.startsWith('#')) {
    return `${source}\nint main() { return 0; }`;
  }
  return `int main() {\n${source}\n;\nreturn 0;\n}`;
}

export const cppExceptionOracleCases = [
  ...cppExceptionPositives.map(([source]) => ({
    source,
    driverSource: ordinaryDriver(source),
    // The learner policy also recognizes written tokens in malformed
    // statements and unexpanded macro definitions.
    expectedDifference: source === 'catch (...) {}' || source === '#define RAISE throw',
  })),
  ...cppExceptionNegatives.map((source) => ({
    source,
    driverSource: ordinaryDriver(source),
    expectedDifference: false,
  })),
];

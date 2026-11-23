import type { ParityProblem } from './browser-trace-parity-entry';

const styles = ['function', 'solution-method', 'ops-class', 'script'] as const;
type Style = typeof styles[number];
type Language = ParityProblem['language'];

interface SyntaxPrograms {
  entry: (style: Style, body: string) => string;
  normal: (style: Style) => string;
  missing: (style: Style) => string;
  extra: string;
  invalidReturn: string;
  invalidMethod: string;
  invalidHelper: (style: Style) => string;
  nonParseError: (style: Style) => string;
  badIndent?: (style: Style) => string;
  control: (style: Style) => { prelude?: string; body: string };
}

function indent(code: string, width: number) {
  return code.split('\n').map((line) => ' '.repeat(width) + line).join('\n');
}

function pythonEntry(style: Style, body: string) {
  if (style === 'script') return body;
  if (style === 'function') return 'def solve():\n' + indent(body, 4);
  const name = style === 'solution-method' ? 'Solution' : 'Counter';
  return 'class ' + name + ':\n    def solve(self):\n' + indent(body, 8);
}

function javascriptEntry(style: Style, body: string) {
  if (style === 'script') return body;
  if (style === 'function') return 'function solve() {\n' + indent(body, 2) + '\n}';
  const name = style === 'solution-method' ? 'Solution' : 'Counter';
  return 'class ' + name + ' {\n  solve() {\n' + indent(body, 4) + '\n  }\n}';
}

function compiledEntry(language: 'cpp' | 'java' | 'csharp', style: Style, body: string) {
  if (style === 'script') return body;
  if (style === 'function' && language === 'cpp') {
    return 'int solve() {\n' + indent(body, 2) + '\n}';
  }
  const name = style === 'ops-class' ? 'Counter' : 'Solution';
  const header = language === 'cpp' ? 'class ' + name + ' {\npublic:' : 'public class ' + name + ' {';
  const method = language === 'cpp' ? 'int solve' : language === 'java' ? 'public int solve' : 'public int Solve';
  return header + '\n  ' + method + '() {\n' + indent(body, 4) + '\n  }\n}' +
    (language === 'cpp' ? ';' : '');
}

function javascriptPrograms(typescript: boolean): SyntaxPrograms {
  const normal = (style: Style) => style === 'script' ? 'let result = 7;' : 'return 7;';
  return {
    entry: javascriptEntry,
    normal,
    missing: (style) => style === 'script'
      ? 'let result = 7;\nif (true) {\n  result = 7;'
      : javascriptEntry(style, normal(style)).slice(0, -1),
    extra: '}',
    invalidReturn: 'return 1 +;',
    invalidMethod: 'class BrokenMethod {\n  check() { return 1 +; }\n}',
    invalidHelper: () => 'function brokenHelper() {\n  const x = ;\n}',
    // This TypeScript lane transpiles without semantic type checking.
    // Duplicate lexical declarations fail early in both runtimes.
    nonParseError: () => typescript
      ? 'let duplicate: number = 1;\nlet duplicate: number = 2;'
      : 'let duplicate = 1;\nlet duplicate = 2;',
    control: (style) => ({
      body: [
        typescript ? 'const box = { value: 7 } satisfies { value: number };' : 'const box = { value: 7 };',
        'const text = "{/}"; // a stray closing brace } and opening brace {',
        String.raw`const regex = /\{\/\}/;`,
        (style === 'script' ? 'const result = ' : 'return ') +
          '(regex.test(text) ? box?.value : 0) ?? 0;',
      ].join('\n'),
    }),
  };
}

function compiledPrograms(language: 'cpp' | 'java' | 'csharp'): SyntaxPrograms {
  const entry: SyntaxPrograms['entry'] = (style, body) => compiledEntry(language, style, body);
  const normal = (style: Style) => style === 'script'
    ? (language === 'java' ? 'result = 7;' : 'int result = 7;')
    : 'return 7;';
  return {
    entry,
    normal,
    missing: (style) => style === 'script'
      ? normal(style) + '\nif (true) {\n  result = 7;'
      : entry(style, normal(style)).slice(0, language === 'cpp' && style !== 'function' ? -2 : -1),
    extra: '}',
    invalidReturn: 'return 1 +;',
    invalidMethod: {
      cpp: 'class BrokenMethod {\npublic:\n  int check() { return 1 +; }\n};',
      java: 'class BrokenMethod {\n  int check() { return 1 +; }\n}',
      csharp: 'class BrokenMethod {\n  int Check() { return 1 +; }\n}',
    }[language],
    invalidHelper: (style) => ({
      cpp: style === 'script'
        ? 'auto brokenHelper = []() {\n  int value = ;\n  return value;\n};'
        : 'int brokenHelper() {\n  int value = ;\n  return value;\n}',
      java: 'class Helpers {\n  static int brokenHelper() { int value = ; return value; }\n}',
      csharp: 'class Helpers {\n  static int BrokenHelper() { int value = ; return value; }\n}',
    })[language],
    nonParseError: () => 'int bad = missingIdentifier;',
    control: (style) => {
      const output = style === 'script' ? (language === 'java' ? 'result = ' : 'int result = ') : 'return ';
      const controls = {
        cpp: {
          prelude: '#include <regex>\n#include <utility>',
          body: [
            'const auto [value, fallback] = std::pair<int, int>{7, 0};',
            'const char* text = R"({/})"; // } {',
            'const std::regex pattern(R"(\\{/\\})");',
            output + 'std::regex_match(text, pattern) ? value : fallback;',
          ].join('\n'),
        },
        java: {
          body: [
            'String text = "{/}"; // } {',
            'boolean matched = text.matches("\\\\{/\\\\}");',
            'int value = switch (text.length()) { case 3 -> 7; default -> 0; };',
            output + 'matched ? value : 0;',
          ].join('\n'),
        },
        csharp: {
          body: [
            'string text = "{/}"; // } {',
            String.raw`bool matched = System.Text.RegularExpressions.Regex.IsMatch(text, @"\{/\}");`,
            'int value = text?.Length switch { 3 => 7, _ => 0 };',
            output + 'matched ? value : 0;',
          ].join('\n'),
        },
      };
      return controls[language];
    },
  };
}

const programs: Record<Language, SyntaxPrograms> = {
  python: {
    entry: pythonEntry,
    normal: (style) => style === 'script' ? 'result = 7' : 'return 7',
    missing: (style) => pythonEntry(style, style === 'script' ? 'result = [7' : 'return [7'),
    extra: ')',
    invalidReturn: 'return 1 +',
    invalidMethod: 'class BrokenMethod:\n    def check(self):\n        return 1 +',
    invalidHelper: () => 'def broken_helper():\n    value =\n    return value',
    nonParseError: () => 'nonlocal missing_binding',
    badIndent: (style) => pythonEntry(style, style === 'script' ? 'if True:\nresult = 7' : 'if True:\nreturn 7'),
    control: (style) => {
      const output = style === 'script' ? 'result = ' : 'return ';
      return {
        prelude: 'import re',
        body: [
          'text = "{/}"  # } {',
          String.raw`matched = re.fullmatch(r"\{/\}", text) is not None`,
          'match (matched, text):',
          '    case (True, _):',
          '        ' + output + '7',
          '    case _:',
          '        ' + output + '0',
        ].join('\n'),
      };
    },
  },
  javascript: javascriptPrograms(false),
  typescript: javascriptPrograms(true),
  java: compiledPrograms('java'),
  cpp: compiledPrograms('cpp'),
  csharp: compiledPrograms('csharp'),
};

export interface SyntaxParityFixture extends ParityProblem {
  readonly style: Style;
  readonly expectation: 'compile-error' | 'pass';
}

export const syntaxParityCases = (Object.keys(programs) as Language[]).flatMap((language) => {
  const program = programs[language];
  const method = language === 'csharp' ? 'Solve' : 'solve';
  return styles.flatMap((style): SyntaxParityFixture[] => {
    const script = style === 'script';
    const ops = style === 'ops-class';
    const base = program.entry(style, program.normal(style));
    const cases = ['selected', 'continuation'].map((id, index) => ({
      id,
      input: ops
        ? { operations: ['Counter', ...Array<string>(index + 1).fill(method)], arguments: index === 0 ? [[], []] : [[], [], []] }
        : {},
      expected: ops ? (index === 0 ? [null, 7] : [null, 7, 7]) : 7,
    }));
    const fixture = (name: string, code: string, expectation: SyntaxParityFixture['expectation'] = 'compile-error'):
      SyntaxParityFixture => ({
      id: style + '/' + name, language, style, code, expectation, cases,
      functionName: script ? '' : ops ? 'Counter' : method,
      executionStyle: script ? 'function' : style,
    });
    const control = program.control(style);
    // C# top-level statements precede type declarations.
    const withDeclaration = (declaration: string) => script && language === 'csharp'
      ? base + '\n\n' + declaration
      : declaration + '\n\n' + base;
    return [
      fixture('missing-closer', program.missing(style)),
      fixture('extra-closer', base + '\n' + program.extra),
      fixture('class-method', style === 'solution-method' || ops
        ? program.entry(style, program.invalidReturn)
        : withDeclaration(program.invalidMethod)),
      fixture('external-helper', withDeclaration(program.invalidHelper(style))),
      fixture('non-parse', program.entry(style, program.nonParseError(style) + '\n' + program.normal(style))),
      ...(program.badIndent ? [fixture('bad-indentation', program.badIndent(style))] : []),
      fixture('modern-syntax', [control.prelude, program.entry(style, control.body)].filter(Boolean).join('\n'), 'pass'),
    ];
  });
});

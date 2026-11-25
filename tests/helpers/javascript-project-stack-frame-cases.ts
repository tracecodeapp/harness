// Stack-frame cases for the browser JavaScript and TypeScript project runner.
//
// Every case runs in a workspace rooted at /home/guest/playground, the
// Playground terminal's folder. `expected` is what the runner must print.
// `node` is what Node 22 prints for the same files in a folder of that name,
// reduced to the frames that point into the folder (Node also prints the
// source line, its own `node:internal` frames and a version footer, which the
// runner does not imitate). The Node test re-derives those frames live and
// checks that they still match `node` and the runner's output.

export const STACK_FRAME_WORKSPACE_ROOT = '/home/guest/playground';

export interface StackFrameCaseStream {
  stdout: string;
  stderr: string;
}

export interface StackFrameCase {
  name: string;
  files: Record<string, string>;
  /** Commands that must succeed first, such as `tsc`. */
  setup?: readonly string[];
  command: string;
  /** The entry file Node runs for the reference, relative to the folder. */
  nodeEntry: string;
  expected: StackFrameCaseStream & { exitCode: number };
  /** Node's frames into the folder, per stream, in order. */
  node: { stdout: readonly string[]; stderr: readonly string[] };
}

const root = STACK_FRAME_WORKSPACE_ROOT;
const rootUrl = `file://${root}`;

export const stackFrameCases: readonly StackFrameCase[] = [
  {
    // The report's case: the helper's frame was labelled with main.js.
    name: 'javascript helper throw (report)',
    files: {
      'main.js': "require('./helper').fail();\n",
      'helper.js': 'exports.fail = () => { throw new Error("helper probe"); };\n',
    },
    command: 'node main.js',
    nodeEntry: 'main.js',
    expected: {
      exitCode: 1,
      stdout: '',
      stderr: [
        'Error: helper probe',
        `    at exports.fail (${root}/helper.js:1:30)`,
        `    at Object.<anonymous> (${root}/main.js:1:21)`,
        '',
      ].join('\n'),
    },
    node: {
      stdout: [],
      stderr: [
        `    at exports.fail (${root}/helper.js:1:30)`,
        `    at Object.<anonymous> (${root}/main.js:1:21)`,
      ],
    },
  },
  {
    // Three modules in nested folders, multi-line, thrown deep and uncaught.
    name: 'javascript nested folders, frame in a third module',
    files: {
      'main.js': [
        "const { start } = require('./src/app');",
        '',
        'start();',
        '',
      ].join('\n'),
      'src/app.js': [
        "const service = require('./lib/service');",
        '',
        'exports.start = function start() {',
        '  return service.run(2);',
        '};',
        '',
      ].join('\n'),
      'src/lib/service.js': [
        'function check(value) {',
        '  if (value > 1) {',
        '    throw new RangeError(`value ${value} is too large`);',
        '  }',
        '}',
        '',
        'exports.run = (value) => {',
        '  check(value);',
        '  return value;',
        '};',
        '',
      ].join('\n'),
    },
    command: 'node main.js',
    nodeEntry: 'main.js',
    expected: {
      exitCode: 1,
      stdout: '',
      stderr: [
        'RangeError: value 2 is too large',
        `    at check (${root}/src/lib/service.js:3:11)`,
        `    at exports.run (${root}/src/lib/service.js:8:3)`,
        `    at start (${root}/src/app.js:4:18)`,
        `    at Object.<anonymous> (${root}/main.js:3:1)`,
        '',
      ].join('\n'),
    },
    node: {
      stdout: [],
      stderr: [
        `    at check (${root}/src/lib/service.js:3:11)`,
        `    at exports.run (${root}/src/lib/service.js:8:3)`,
        `    at start (${root}/src/app.js:4:18)`,
        `    at Object.<anonymous> (${root}/main.js:3:1)`,
      ],
    },
  },
  {
    // A module that throws while it is being required.
    name: 'javascript throw while a module loads',
    files: {
      'main.js': [
        "console.log('loading');",
        "require('./config/load');",
        '',
      ].join('\n'),
      'config/load.js': [
        "const settings = { port: 'eighty' };",
        '',
        "if (typeof settings.port !== 'number') {",
        "  throw new TypeError('port must be a number');",
        '}',
        '',
      ].join('\n'),
    },
    command: 'node main.js',
    nodeEntry: 'main.js',
    expected: {
      exitCode: 1,
      stdout: 'loading\n',
      stderr: [
        'TypeError: port must be a number',
        `    at Object.<anonymous> (${root}/config/load.js:4:9)`,
        `    at Object.<anonymous> (${root}/main.js:2:1)`,
        '',
      ].join('\n'),
    },
    node: {
      stdout: [],
      stderr: [
        `    at Object.<anonymous> (${root}/config/load.js:4:9)`,
        `    at Object.<anonymous> (${root}/main.js:2:1)`,
      ],
    },
  },
  {
    // Caught, then printed with err.stack and console.error(err).
    name: 'javascript caught error printed with err.stack and console.error',
    files: {
      'main.js': [
        "const { parse } = require('./lib/parser');",
        '',
        'try {',
        "  parse('{');",
        '} catch (err) {',
        '  const saved = err.stack;',
        '  console.log(saved);',
        '  console.error(err);',
        '}',
        "console.log('after');",
        '',
      ].join('\n'),
      'lib/parser.js': [
        "const { fail } = require('./util/errors');",
        '',
        'exports.parse = function parse(text) {',
        "  if (text === '{') fail('unexpected end of input');",
        '  return JSON.parse(text);',
        '};',
        '',
      ].join('\n'),
      'lib/util/errors.js': [
        'exports.fail = function fail(message) {',
        '  throw new SyntaxError(message);',
        '};',
        '',
      ].join('\n'),
    },
    command: 'node main.js',
    nodeEntry: 'main.js',
    expected: {
      exitCode: 0,
      stdout: [
        'SyntaxError: unexpected end of input',
        `    at fail (${root}/lib/util/errors.js:2:9)`,
        `    at parse (${root}/lib/parser.js:4:21)`,
        `    at Object.<anonymous> (${root}/main.js:4:3)`,
        'after',
        '',
      ].join('\n'),
      stderr: [
        'SyntaxError: unexpected end of input',
        `    at fail (${root}/lib/util/errors.js:2:9)`,
        `    at parse (${root}/lib/parser.js:4:21)`,
        `    at Object.<anonymous> (${root}/main.js:4:3)`,
        '',
      ].join('\n'),
    },
    node: {
      stdout: [
        `    at fail (${root}/lib/util/errors.js:2:9)`,
        `    at parse (${root}/lib/parser.js:4:21)`,
        `    at Object.<anonymous> (${root}/main.js:4:3)`,
      ],
      stderr: [
        `    at fail (${root}/lib/util/errors.js:2:9)`,
        `    at parse (${root}/lib/parser.js:4:21)`,
        `    at Object.<anonymous> (${root}/main.js:4:3)`,
      ],
    },
  },
  {
    // ES modules: file URLs, a multi-line import, and blank lines before an
    // export, which the ES-module rewrite must not swallow.
    name: 'javascript ES module import',
    files: {
      'main.mjs': [
        'import {',
        '  explode,',
        "} from './lib/helper.mjs';",
        '',
        'console.log(import.meta.url);',
        'explode();',
        '',
      ].join('\n'),
      'lib/helper.mjs': [
        '// helper module',
        '',
        'export function explode() {',
        "  throw new Error('esm probe');",
        '}',
        '',
      ].join('\n'),
    },
    command: 'node main.mjs',
    nodeEntry: 'main.mjs',
    expected: {
      exitCode: 1,
      stdout: `${rootUrl}/main.mjs\n`,
      stderr: [
        'Error: esm probe',
        `    at explode (${rootUrl}/lib/helper.mjs:4:9)`,
        `    at ${rootUrl}/main.mjs:6:1`,
        '',
      ].join('\n'),
    },
    node: {
      stdout: [],
      stderr: [
        `    at explode (${rootUrl}/lib/helper.mjs:4:9)`,
        `    at ${rootUrl}/main.mjs:6:1`,
      ],
    },
  },
  {
    // The report's TypeScript case, run from the emitted JavaScript.
    name: 'typescript helper throw (report)',
    files: {
      'main.ts': "import { fail } from './helper';\nfail();\n",
      'helper.ts': 'export function fail(): never { throw new Error("helper probe"); }\n',
    },
    setup: ['tsc --target es2022 --module commonjs --outDir out main.ts'],
    command: 'node out/main.js',
    nodeEntry: 'out/main.js',
    expected: {
      exitCode: 1,
      stdout: '',
      stderr: [
        'Error: helper probe',
        `    at fail (${root}/out/helper.js:4:25)`,
        `    at Object.<anonymous> (${root}/out/main.js:4:19)`,
        '',
      ].join('\n'),
    },
    node: {
      stdout: [],
      stderr: [
        `    at fail (${root}/out/helper.js:4:25)`,
        `    at Object.<anonymous> (${root}/out/main.js:4:19)`,
      ],
    },
  },
  {
    // TypeScript in nested folders, a frame in a third module, caught and
    // printed with err.stack.
    name: 'typescript nested folders, caught err.stack',
    files: {
      'src/main.ts': [
        "import { placeOrder } from './services/orders';",
        '',
        'try {',
        '  placeOrder(-1);',
        '} catch (err) {',
        '  console.log((err as Error).stack);',
        '}',
        '',
      ].join('\n'),
      'src/services/orders.ts': [
        "import { assertQuantity } from './validation/rules';",
        '',
        'export function placeOrder(quantity: number): number {',
        '  assertQuantity(quantity);',
        '  return quantity;',
        '}',
        '',
      ].join('\n'),
      'src/services/validation/rules.ts': [
        'export function assertQuantity(quantity: number): void {',
        '  if (quantity < 1) {',
        "    throw new RangeError('quantity must be positive');",
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    setup: ['tsc --target es2022 --module commonjs --rootDir src --outDir out src/main.ts'],
    command: 'node out/main.js',
    nodeEntry: 'out/main.js',
    expected: {
      exitCode: 0,
      stdout: [
        'RangeError: quantity must be positive',
        `    at assertQuantity (${root}/out/services/validation/rules.js:6:15)`,
        `    at placeOrder (${root}/out/services/orders.js:6:32)`,
        `    at Object.<anonymous> (${root}/out/main.js:5:29)`,
        '',
      ].join('\n'),
      stderr: '',
    },
    node: {
      stdout: [
        `    at assertQuantity (${root}/out/services/validation/rules.js:6:15)`,
        `    at placeOrder (${root}/out/services/orders.js:6:32)`,
        `    at Object.<anonymous> (${root}/out/main.js:5:29)`,
      ],
      stderr: [],
    },
  },
  {
    // Text that looks like a stack frame is ordinary output, on both streams,
    // and is printed byte for byte.
    name: 'console text that looks like a frame is printed verbatim',
    files: {
      'main.js': [
        `console.log('${root}/main.js:1:30');`,
        "console.log('    at eval (eval at executeModule (blob:x), <anonymous>:3:30)');",
        `console.error('    at exports.fail (${root}/main.js:1:30)');`,
        "process.stdout.write('at eval (\\n');",
        "process.stderr.write('at eval (\\n');",
        '',
      ].join('\n'),
    },
    command: 'node main.js',
    nodeEntry: 'main.js',
    expected: {
      exitCode: 0,
      stdout: [
        `${root}/main.js:1:30`,
        '    at eval (eval at executeModule (blob:x), <anonymous>:3:30)',
        'at eval (',
        '',
      ].join('\n'),
      stderr: [
        `    at exports.fail (${root}/main.js:1:30)`,
        'at eval (',
        '',
      ].join('\n'),
    },
    node: {
      stdout: [],
      stderr: [
        `    at exports.fail (${root}/main.js:1:30)`,
      ],
    },
  },
  {
    // Only an Error's own frames are attributed; a multi-line message, even
    // one that looks like a frame, stays whole.
    name: 'a multi-line error message is printed whole',
    files: {
      'main.js': [
        "console.log('before');",
        "throw new Error('first line\\n    at eval (not a frame)');",
        '',
      ].join('\n'),
    },
    command: 'node main.js',
    nodeEntry: 'main.js',
    expected: {
      exitCode: 1,
      stdout: 'before\n',
      stderr: [
        'Error: first line',
        '    at eval (not a frame)',
        `    at Object.<anonymous> (${root}/main.js:2:7)`,
        '',
      ].join('\n'),
    },
    node: {
      stdout: [],
      stderr: [
        `    at Object.<anonymous> (${root}/main.js:2:7)`,
      ],
    },
  },
];

/** Frames that point into the workspace folder, in order. */
export function workspaceFrames(text: string, workspaceRoot = STACK_FRAME_WORKSPACE_ROOT): string[] {
  return text
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .filter((line) => line.includes(`${workspaceRoot}/`) || line.includes(`file://${workspaceRoot}/`));
}

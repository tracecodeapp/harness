#!/usr/bin/env npx tsx

import type { RuntimeProjectTerminalCapabilities } from '../packages/runtime-core/src/index';
import {
  WorkspaceTerminalCommands,
  type RuntimeCommandUmaskState,
} from '../packages/tracekernel/src/workspace/userland-terminal-commands';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

const terminal: RuntimeProjectTerminalCapabilities = {
  isTTY: true,
  columns: 120,
  rows: 40,
  term: 'xterm-256color',
  colorLevel: 2,
};
const commands = new WorkspaceTerminalCommands();

assertEqual(commands.tty([], terminal).stdout, '/dev/tty\n', 'TTY path');
assertEqual(commands.tty([], undefined).exitCode, 1, 'non-TTY exit');
assertEqual(
  commands.testTerminal(['-t', '1'], 'test', terminal).exitCode,
  0,
  'stdout should be attached'
);
assertEqual(
  commands.testTerminal(['!', '-t', '1'], 'test', terminal).exitCode,
  1,
  'negated attached test'
);
assertEqual(
  commands.testTerminal(['-t', '1'], '[', terminal).exitCode,
  2,
  'unclosed bracket expression'
);

let observedUmask: number | undefined;
const state: RuntimeCommandUmaskState = {
  umask: 0o022,
  onUmaskChange: (value) => {
    observedUmask = value;
  },
};
assertEqual(commands.umask([], state).stdout, '0022\n', 'default umask');
assertEqual(commands.umask(['077'], state).exitCode, 0, 'numeric umask');
assertEqual(state.umask, 0o077, 'numeric umask mutation');
assertEqual(observedUmask, 0o077, 'numeric umask callback');
assertEqual(
  commands.umask(['u=rwx,g=rx,o='], state).exitCode,
  0,
  'symbolic umask'
);
assertEqual(state.umask, 0o027, 'symbolic umask mutation');

assertEqual(
  commands.stty(['size'], terminal).stdout,
  '40 120\n',
  'terminal dimensions'
);
assertEqual(
  commands.stty([], undefined).exitCode,
  1,
  'stty requires a terminal'
);
assertEqual(commands.tput(['cols'], terminal).stdout, '120\n', 'columns');
assertEqual(commands.tput(['colors'], terminal).stdout, '256\n', 'colors');
assertEqual(
  commands.tput(['missing'], terminal).exitCode,
  4,
  'unknown capability'
);

console.log('terminal userland command tests passed');

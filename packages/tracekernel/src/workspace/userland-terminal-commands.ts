import type {
  RuntimeCommandOptions,
  RuntimeCommandResult,
} from '@tracecode/harness-core';

type RuntimeTerminalSnapshot =
  | RuntimeCommandOptions['terminal']
  | undefined;

export interface RuntimeCommandUmaskState {
  umask?: number;
  onUmaskChange?(umask: number): void;
}

function invalidUmask(raw: string): RuntimeCommandResult {
  return {
    stdout: '',
    stderr: `bash: umask: ${raw}: invalid symbolic mode operator\n`,
    exitCode: 1,
  };
}

/**
 * Terminal and shell-session userland behavior.
 *
 * The workspace resolves its live command context before calling this
 * boundary. This module only interprets terminal snapshots and the command's
 * mutable umask value; it has no process-table or filesystem authority.
 */
export class WorkspaceTerminalCommands {
  tty(
    args: readonly string[],
    terminal: RuntimeTerminalSnapshot
  ): RuntimeCommandResult {
    if (
      args.length > 0 &&
      (args.length !== 1 || args[0] !== '-s')
    ) {
      return {
        stdout: '',
        stderr: 'usage: tty [-s]\n',
        exitCode: 2,
      };
    }
    if (!terminal?.isTTY) {
      return {
        stdout: args[0] === '-s' ? '' : 'not a tty\n',
        stderr: '',
        exitCode: 1,
      };
    }
    return {
      stdout: args[0] === '-s' ? '' : '/dev/tty\n',
      stderr: '',
      exitCode: 0,
    };
  }

  testTerminal(
    args: readonly string[],
    commandName: 'test' | '[',
    terminal: RuntimeTerminalSnapshot
  ): RuntimeCommandResult {
    const expression =
      commandName === '[' && args.at(-1) === ']'
        ? args.slice(0, -1)
        : args;
    const bracketClosed =
      commandName !== '[' || args.at(-1) === ']';
    const negated = expression[0] === '!';
    const ttyExpression = negated
      ? expression.slice(1)
      : expression;
    if (
      bracketClosed &&
      ttyExpression.length === 2 &&
      ttyExpression[0] === '-t'
    ) {
      const rawFd = ttyExpression[1] ?? '';
      const fd = /^\d+$/.test(rawFd) ? Number(rawFd) : -1;
      const attached =
        terminal?.isTTY === true && fd >= 0 && fd <= 2;
      return {
        stdout: '',
        stderr: '',
        exitCode: (negated ? !attached : attached) ? 0 : 1,
      };
    }
    return {
      stdout: '',
      stderr: `${commandName}: invalid terminal test\n`,
      exitCode: 2,
    };
  }

  umask(
    args: readonly string[],
    state: RuntimeCommandUmaskState | undefined
  ): RuntimeCommandResult {
    const current = state?.umask ?? 0o022;
    if (args.length === 0) {
      return {
        stdout: `${current.toString(8).padStart(4, '0')}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (args.length === 1 && args[0] === '-p') {
      return {
        stdout: `umask ${current
          .toString(8)
          .padStart(4, '0')}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (args.length === 1 && args[0] === '-S') {
      const allowed = 0o777 & ~current;
      const permissions = (bits: number) =>
        `${bits & 4 ? 'r' : ''}${bits & 2 ? 'w' : ''}${
          bits & 1 ? 'x' : ''
        }`;
      return {
        stdout:
          `u=${permissions((allowed >> 6) & 7)},` +
          `g=${permissions((allowed >> 3) & 7)},` +
          `o=${permissions(allowed & 7)}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (args.length !== 1) {
      return invalidUmask(args.join(' '));
    }

    const rawMode = args[0]!;
    let next: number;
    if (/^[0-7]{1,4}$/.test(rawMode)) {
      next = Number.parseInt(rawMode, 8);
      if (next > 0o777) {
        return {
          stdout: '',
          stderr:
            `bash: umask: ${rawMode}: ` +
            'octal number out of range\n',
          exitCode: 1,
        };
      }
    } else {
      const clauses = rawMode.split(',');
      let allowed = 0o777 & ~current;
      for (const clause of clauses) {
        const match = /^([ugoa]*)([+=-][rwx]*)+$/.exec(clause);
        if (!match) return invalidUmask(rawMode);

        const whoText = match[1] || 'a';
        const classes = new Set(
          whoText.includes('a')
            ? ['u', 'g', 'o']
            : [...whoText]
        );
        const classMask =
          (classes.has('u') ? 0o700 : 0) |
          (classes.has('g') ? 0o070 : 0) |
          (classes.has('o') ? 0o007 : 0);
        const operations =
          clause
            .slice(match[1]!.length)
            .match(/[+=-][rwx]*/g) ?? [];
        for (const operation of operations) {
          const permissionText = operation.slice(1);
          const permissionBits =
            (permissionText.includes('r') ? 4 : 0) |
            (permissionText.includes('w') ? 2 : 0) |
            (permissionText.includes('x') ? 1 : 0);
          const requested =
            (classes.has('u') ? permissionBits << 6 : 0) |
            (classes.has('g') ? permissionBits << 3 : 0) |
            (classes.has('o') ? permissionBits : 0);
          if (operation[0] === '=') {
            allowed = (allowed & ~classMask) | requested;
          } else if (operation[0] === '+') {
            allowed |= requested;
          } else {
            allowed &= ~requested;
          }
        }
      }
      next = 0o777 & ~allowed;
    }

    if (state) {
      state.umask = next;
      state.onUmaskChange?.(next);
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  stty(
    args: readonly string[],
    terminal: RuntimeTerminalSnapshot
  ): RuntimeCommandResult {
    if (!terminal?.isTTY) {
      return {
        stdout: '',
        stderr:
          'stty: standard input: ' +
          'Inappropriate ioctl for device\n',
        exitCode: 1,
      };
    }
    if (args.length === 0) {
      return {
        stdout:
          `speed 38400 baud; rows ${terminal.rows}; ` +
          `columns ${terminal.columns}; line = 0;\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (args.length === 1 && args[0] === 'size') {
      return {
        stdout: `${terminal.rows} ${terminal.columns}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (args.length === 1 && args[0] === '-a') {
      return {
        stdout:
          [
            `speed 38400 baud; rows ${terminal.rows}; ` +
              `columns ${terminal.columns}; line = 0;`,
            'intr = ^C; quit = ^\\; erase = ^?; ' +
              'kill = ^U; eof = ^D;',
            'echo icanon isig',
          ].join('\n') + '\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return {
      stdout: '',
      stderr:
        `stty: unsupported terminal setting: ` +
        `${args.join(' ')}\n`,
      exitCode: 1,
    };
  }

  tput(
    args: readonly string[],
    terminal: RuntimeTerminalSnapshot
  ): RuntimeCommandResult {
    if (!terminal?.isTTY) {
      return {
        stdout: '',
        stderr:
          'tput: No value for $TERM and no -T specified\n',
        exitCode: 2,
      };
    }
    const capability = args[0];
    if (!capability) {
      return {
        stdout: '',
        stderr: 'tput: missing operand\n',
        exitCode: 2,
      };
    }
    if (capability === 'cols') {
      return {
        stdout: `${terminal.columns}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (capability === 'lines') {
      return {
        stdout: `${terminal.rows}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (capability === 'colors') {
      const colors = [-1, 16, 256, 16_777_216][
        terminal.colorLevel
      ] ?? -1;
      return {
        stdout: `${colors}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (capability === 'longname') {
      return {
        stdout:
          `${terminal.columns}-column ` +
          `${terminal.term} terminal\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (
      [
        'clear',
        'el',
        'ed',
        'cup',
        'bold',
        'sgr0',
        'setaf',
        'setab',
      ].includes(capability)
    ) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return {
      stdout: '',
      stderr:
        `tput: unknown terminfo capability '${capability}'\n`,
      exitCode: 4,
    };
  }
}

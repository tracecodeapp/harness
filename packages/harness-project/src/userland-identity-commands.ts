import type {
  RuntimeCommandOptions,
  RuntimeCommandResult,
  RuntimeKernelInfo,
} from '@tracecode/harness-core';
import {
  TRACE_KERNEL_ARCHITECTURE,
  TRACEKERNEL_BIN_PATH,
} from './constants';
import {
  traceKernelRuntimeRegistry,
  type TraceKernelCommandInfo,
} from './language-commands';
import type { HostResolution } from './http-state';

export interface WorkspaceIdentityCommandsOptions {
  kernelInfo: RuntimeKernelInfo;
  environment: Readonly<Record<string, string>>;
  commands: readonly TraceKernelCommandInfo[];
  resolveHost(hostname: string): HostResolution;
}

/**
 * Identity and environment-facing userland commands.
 *
 * These commands read immutable workspace identity plus an explicit terminal
 * snapshot. They do not own process, filesystem, or lifecycle state.
 */
export class WorkspaceIdentityCommands {
  private readonly kernelInfo: RuntimeKernelInfo;
  private readonly environment: Readonly<Record<string, string>>;
  private readonly commands: readonly TraceKernelCommandInfo[];
  private readonly resolveHost: (hostname: string) => HostResolution;

  constructor(options: WorkspaceIdentityCommandsOptions) {
    this.kernelInfo = options.kernelInfo;
    this.environment = options.environment;
    this.commands = options.commands;
    this.resolveHost = options.resolveHost;
  }

  whoami(args: readonly string[]): RuntimeCommandResult {
    if (args.length > 0) {
      return {
        stdout: '',
        stderr: `whoami: extra operand '${args[0]}'\n`,
        exitCode: 1,
      };
    }
    return {
      stdout: `${this.kernelInfo.user.username}\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  hostname(args: readonly string[]): RuntimeCommandResult {
    if (
      args.length > 1 ||
      (args.length === 1 && args[0] !== '-s' && args[0] !== '-f')
    ) {
      return {
        stdout: '',
        stderr: 'usage: hostname [-s|-f]\n',
        exitCode: 1,
      };
    }
    return {
      stdout: `${this.kernelInfo.host.hostname}\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  id(args: readonly string[]): RuntimeCommandResult {
    const username = this.kernelInfo.user.username;
    const userId = 1000;
    const groupId = 1000;
    const fullIdentity =
      `uid=${userId}(${username}) gid=${groupId}(${username}) ` +
      `groups=${groupId}(${username})\n`;
    if (args.length === 0) {
      return { stdout: fullIdentity, stderr: '', exitCode: 0 };
    }
    const flags = new Set(
      args
        .filter((arg) => arg.startsWith('-'))
        .flatMap((arg) => arg.slice(1).split(''))
    );
    const operands = args.filter((arg) => !arg.startsWith('-'));
    if (
      operands.length > 1 ||
      (operands[0] !== undefined && operands[0] !== username)
    ) {
      return {
        stdout: '',
        stderr: `id: '${operands[0] ?? ''}': no such user\n`,
        exitCode: 1,
      };
    }
    if (
      [...flags].some((flag) => !'ugn'.includes(flag)) ||
      (flags.has('n') && !flags.has('u') && !flags.has('g'))
    ) {
      return {
        stdout: '',
        stderr: 'usage: id [-u|-g] [-n] [USER]\n',
        exitCode: 1,
      };
    }
    if (flags.has('u')) {
      return {
        stdout: `${flags.has('n') ? username : userId}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (flags.has('g')) {
      return {
        stdout: `${flags.has('n') ? username : groupId}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: fullIdentity, stderr: '', exitCode: 0 };
  }

  groups(args: readonly string[]): RuntimeCommandResult {
    const username = this.kernelInfo.user.username;
    if (
      args.length > 1 ||
      (args[0] !== undefined && args[0] !== username)
    ) {
      return {
        stdout: '',
        stderr: `groups: '${args[0] ?? ''}': no such user\n`,
        exitCode: 1,
      };
    }
    return {
      stdout:
        args.length === 0
          ? `${username}\n`
          : `${username} : ${username}\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  getconf(args: readonly string[]): RuntimeCommandResult {
    const values: Readonly<Record<string, string>> = {
      PATH: `${TRACEKERNEL_BIN_PATH}:/usr/local/bin:/usr/bin:/bin`,
      ARG_MAX: '2097152',
      OPEN_MAX: '1024',
      PAGESIZE: '65536',
      PAGE_SIZE: '65536',
      _NPROCESSORS_ONLN: '1',
    };
    if (args.length !== 1) {
      return { stdout: '', stderr: 'usage: getconf NAME\n', exitCode: 2 };
    }
    const value = values[args[0]!];
    if (value === undefined) {
      return {
        stdout: '',
        stderr: `getconf: Unrecognized variable '${args[0]}'\n`,
        exitCode: 2,
      };
    }
    return { stdout: `${value}\n`, stderr: '', exitCode: 0 };
  }

  getent(args: readonly string[]): RuntimeCommandResult {
    const database = args[0];
    const keys = args.slice(1);
    const username = this.kernelInfo.user.username;
    if (!database) {
      return {
        stdout: '',
        stderr: 'usage: getent database [key ...]\n',
        exitCode: 2,
      };
    }
    if (database === 'passwd') {
      if (
        keys.length > 1 ||
        (keys[0] !== undefined &&
          keys[0] !== username &&
          keys[0] !== '1000')
      ) {
        return { stdout: '', stderr: '', exitCode: 2 };
      }
      return {
        stdout:
          `${username}:x:1000:1000:TraceKernel user:` +
          `${this.environment.HOME}:/bin/bash\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (database === 'group') {
      if (
        keys.length > 1 ||
        (keys[0] !== undefined &&
          keys[0] !== username &&
          keys[0] !== '1000')
      ) {
        return { stdout: '', stderr: '', exitCode: 2 };
      }
      return {
        stdout: `${username}:x:1000:${username}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (database === 'hosts' || database === 'ahosts') {
      if (keys.length !== 1) {
        return { stdout: '', stderr: '', exitCode: 2 };
      }
      const host = keys[0]!;
      const resolution = this.resolveHost(host);
      if (!resolution.reachable) {
        return { stdout: '', stderr: '', exitCode: 2 };
      }
      return {
        stdout: `${resolution.ip} ${host}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    return {
      stdout: '',
      stderr: `Unknown database: ${database}\n`,
      exitCode: 1,
    };
  }

  locale(args: readonly string[]): RuntimeCommandResult {
    if (args.length === 1 && args[0] === '-a') {
      return { stdout: 'C\nC.utf8\nPOSIX\n', stderr: '', exitCode: 0 };
    }
    if (args.length === 1 && args[0] === 'charmap') {
      return { stdout: 'UTF-8\n', stderr: '', exitCode: 0 };
    }
    if (args.length > 0) {
      return {
        stdout: '',
        stderr: `locale: unknown name '${args[0]}'\n`,
        exitCode: 1,
      };
    }
    const lang = this.environment.LANG ?? 'C.UTF-8';
    return {
      stdout:
        [
          `LANG=${lang}`,
          'LANGUAGE=',
          `LC_CTYPE="${lang}"`,
          `LC_NUMERIC="${lang}"`,
          `LC_TIME="${lang}"`,
          `LC_COLLATE="${lang}"`,
          `LC_MONETARY="${lang}"`,
          `LC_MESSAGES="${lang}"`,
          `LC_PAPER="${lang}"`,
          `LC_NAME="${lang}"`,
          `LC_ADDRESS="${lang}"`,
          `LC_TELEPHONE="${lang}"`,
          `LC_MEASUREMENT="${lang}"`,
          `LC_IDENTIFICATION="${lang}"`,
          'LC_ALL=',
        ].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }

  uname(args: readonly string[]): RuntimeCommandResult {
    const fields = {
      s: 'TraceKernel',
      n: this.kernelInfo.host.hostname,
      r: this.kernelInfo.version,
      v: `TraceKernel ${this.kernelInfo.version}`,
      m: TRACE_KERNEL_ARCHITECTURE,
      p: TRACE_KERNEL_ARCHITECTURE,
      i: TRACE_KERNEL_ARCHITECTURE,
      o: 'TraceKernel',
    } as const;
    const requested =
      args.length === 0
        ? ['s']
        : args.flatMap((arg) => {
            if (arg === '--all') return ['a'];
            if (arg.startsWith('--')) {
              const names: Readonly<
                Record<string, keyof typeof fields>
              > = {
                '--kernel-name': 's',
                '--nodename': 'n',
                '--kernel-release': 'r',
                '--kernel-version': 'v',
                '--machine': 'm',
                '--processor': 'p',
                '--hardware-platform': 'i',
                '--operating-system': 'o',
              };
              return names[arg] ? [names[arg]!] : ['?'];
            }
            return arg.startsWith('-')
              ? arg.slice(1).split('')
              : ['?'];
          });
    if (
      requested.includes('?') ||
      requested.some(
        (flag) => flag !== 'a' && !(flag in fields)
      )
    ) {
      return {
        stdout: '',
        stderr: 'uname: invalid option\n',
        exitCode: 1,
      };
    }
    const order: Array<keyof typeof fields> = [
      's',
      'n',
      'r',
      'v',
      'm',
      'p',
      'i',
      'o',
    ];
    const selected = requested.includes('a')
      ? order
      : order.filter((flag) => requested.includes(flag));
    return {
      stdout: `${selected.map((flag) => fields[flag]).join(' ')}\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  fastfetch(
    args: readonly string[],
    terminal: RuntimeCommandOptions['terminal'] | undefined
  ): RuntimeCommandResult {
    if (args.length === 1 && args[0] === '--version') {
      return {
        stdout: `fastfetch ${this.kernelInfo.version} (TraceKernel)\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (args.length > 0) {
      return {
        stdout: '',
        stderr: `fastfetch: unknown option: ${args[0]}\n`,
        exitCode: 1,
      };
    }

    const elapsedSeconds = Math.max(
      0,
      Math.floor(
        (Date.now() -
          Date.parse(this.kernelInfo.workspace.startedAt)) /
          1_000
      )
    );
    const uptimeParts: string[] = [];
    const hours = Math.floor(elapsedSeconds / 3_600);
    const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
    const seconds = elapsedSeconds % 60;
    if (hours > 0) {
      uptimeParts.push(
        `${hours} hour${hours === 1 ? '' : 's'}`
      );
    }
    if (minutes > 0) uptimeParts.push(`${minutes} min`);
    if (hours === 0 && minutes === 0) {
      uptimeParts.push(`${seconds} sec`);
    }

    const availableRuntimes = traceKernelRuntimeRegistry(this.commands)
      .filter((runtime) => runtime.available).length;
    const logo = [
      '    ⣀            ⣀',
      '   ⣾⠋⠱⢦⣄⣀      ⠈⠙⣷',
      '  ⣸⡏      ⠈⠙⠛⢶⣤⡀  ⢹⣇',
      '  ⣿     ⢀⣠⡴⠾⠛⠉     ⣿',
      '  ⢹⣇    ⠛⠷⣤⣀⡀      ⣸⡏',
      '   ⢿⣄⡀      ⠉⠙⠿⢆⣠⡿',
      '    ⠉            ⠉',
    ];
    const heading =
      `${this.kernelInfo.user.username}@` +
      this.kernelInfo.host.hostname;
    const details = [
      heading,
      '-'.repeat(heading.length),
      `OS: ${
        this.kernelInfo.host.osName === 'tracekernel'
          ? 'TraceKernel'
          : this.kernelInfo.host.osName
      }`,
      `Host: ${this.kernelInfo.host.hostname}`,
      `Kernel: ${this.kernelInfo.version}`,
      `Uptime: ${uptimeParts.join(', ')}`,
      'Shell: /bin/bash',
      `Terminal: ${terminal?.term ?? 'dumb'} ` +
        `(${terminal?.columns ?? 80}x${terminal?.rows ?? 24})`,
      `Architecture: ${TRACE_KERNEL_ARCHITECTURE}`,
      `Workspace: ${this.kernelInfo.workspace.name}`,
      `Runtimes: ${availableRuntimes} available`,
      `Commands: ${this.commands.length}`,
    ];
    const rows = Array.from(
      { length: Math.max(logo.length, details.length) },
      (_, index) =>
        `${(logo[index] ?? '').padEnd(24)}${
          details[index] ?? ''
        }`.trimEnd()
    );
    return {
      stdout: `${rows.join('\n')}\n`,
      stderr: '',
      exitCode: 0,
    };
  }
}

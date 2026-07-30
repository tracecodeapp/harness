import type {
  RuntimeCommandResult,
  RuntimeKernelHttpListenerInfo,
  RuntimeKernelInfo,
} from '@tracecode/harness-core';
import {
  normalizeTraceKernelSignal,
  type RuntimeKernelProcessRecord,
} from './process-state';

export interface WorkspaceProcessInspectionOptions {
  kernelInfo: RuntimeKernelInfo;
  principalProcess(): RuntimeKernelProcessRecord;
  findProcess(pid: number): RuntimeKernelProcessRecord | undefined;
  signalProcess(
    process: RuntimeKernelProcessRecord,
    signal: string
  ): boolean;
}

export function processDisplayName(
  process: RuntimeKernelProcessRecord
): string {
  const executable =
    process.command.trim().split(/\s+/, 1)[0] ?? process.command;
  return executable.split('/').pop() || executable || 'process';
}

function processStat(process: RuntimeKernelProcessRecord): string {
  const state =
    process.state === 'running'
      ? 'R'
      : process.state === 'blocked' ||
          process.state === 'queued'
        ? 'S'
        : process.state === 'zombie'
          ? 'Z'
          : process.state === 'signaled'
            ? 'X'
            : 'S';
  return `${state}${process.foreground ? '+' : ''}`;
}

function processStartLabel(
  process: RuntimeKernelProcessRecord
): string {
  const startedAt = new Date(process.startedAt);
  if (Number.isNaN(startedAt.getTime())) return '--:--';
  return startedAt.toISOString().slice(11, 16);
}

/**
 * Presentation and matching behavior for process-oriented userland commands.
 *
 * The workspace supplies authoritative snapshots and performs signals. This
 * boundary never mutates the process table directly.
 */
export class WorkspaceProcessInspection {
  private readonly kernelInfo: RuntimeKernelInfo;
  private readonly principalProcess: () => RuntimeKernelProcessRecord;
  private readonly findProcess: (
    pid: number
  ) => RuntimeKernelProcessRecord | undefined;
  private readonly signalProcess: (
    process: RuntimeKernelProcessRecord,
    signal: string
  ) => boolean;

  constructor(options: WorkspaceProcessInspectionOptions) {
    this.kernelInfo = options.kernelInfo;
    this.principalProcess = options.principalProcess;
    this.findProcess = options.findProcess;
    this.signalProcess = options.signalProcess;
  }

  ss(
    args: readonly string[],
    listeners: readonly RuntimeKernelHttpListenerInfo[]
  ): RuntimeCommandResult {
    const longFlags = new Map([
      ['--listening', 'l'],
      ['--tcp', 't'],
      ['--numeric', 'n'],
      ['--processes', 'p'],
    ]);
    let flags = '';
    for (const arg of args) {
      const longFlag = longFlags.get(arg);
      if (longFlag) {
        flags += longFlag;
      } else if (/^-[ltnp]+$/.test(arg)) {
        flags += arg.slice(1);
      } else {
        return {
          stdout: '',
          stderr: 'Usage: ss [-ltnp]\n',
          exitCode: 2,
        };
      }
    }
    const showListeners = flags.includes('l');
    const showProcesses = flags.includes('p');
    const rows = [...listeners]
      .sort(
        (left, right) =>
          left.port - right.port ||
          left.host.localeCompare(right.host)
      )
      .filter(() => showListeners || flags.length === 0)
      .map((listener) => {
        const process =
          this.findProcess(listener.pid) ??
          this.principalProcess();
        const processColumn = showProcesses
          ? ` users:(("${processDisplayName(process)}",` +
            `pid=${listener.pid},fd=3))`
          : '';
        return (
          `LISTEN 0      511    ${listener.host}:` +
          `${listener.port}      0.0.0.0:*${processColumn}`
        );
      });
    return {
      stdout:
        [
          'State  Recv-Q Send-Q Local Address:Port ' +
            `Peer Address:Port${
              showProcesses ? ' Process' : ''
            }`,
          ...rows,
        ].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }

  lsof(
    args: readonly string[],
    listeners: readonly RuntimeKernelHttpListenerInfo[]
  ): RuntimeCommandResult {
    let port: number | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? '';
      if (arg === '-i') {
        const selector = args[++index];
        if (!selector) {
          return {
            stdout: '',
            stderr:
              'lsof: option requires an argument -- i\n',
            exitCode: 1,
          };
        }
        const match = /^:(\d+)$/.exec(selector);
        if (!match) {
          return {
            stdout: '',
            stderr:
              `lsof: unsupported network selector: ` +
              `${selector}\n`,
            exitCode: 1,
          };
        }
        port = Number(match[1]);
        continue;
      }
      const match = /^-i:(\d+)$/.exec(arg);
      if (match) {
        port = Number(match[1]);
        continue;
      }
      return {
        stdout: '',
        stderr: `lsof: unsupported option: ${arg}\n`,
        exitCode: 1,
      };
    }
    if (port === undefined) {
      return {
        stdout: '',
        stderr: 'lsof: usage: lsof -i :PORT\n',
        exitCode: 1,
      };
    }
    const selected = [...listeners]
      .filter((listener) => listener.port === port)
      .sort((left, right) => left.pid - right.pid);
    if (selected.length === 0) {
      return { stdout: '', stderr: '', exitCode: 1 };
    }
    const rows = selected.map((listener) => {
      const process =
        this.findProcess(listener.pid) ?? this.principalProcess();
      return [
        processDisplayName(process).padEnd(9, ' '),
        String(listener.pid).padStart(5, ' '),
        this.kernelInfo.user.username.padEnd(8, ' '),
        '3u',
        'IPv4',
        '-'.padStart(8, ' '),
        '0t0'.padStart(8, ' '),
        'TCP',
        `${listener.host}:${listener.port} (LISTEN)`,
      ].join(' ');
    });
    return {
      stdout:
        [
          'COMMAND     PID USER     FD TYPE   DEVICE ' +
            'SIZE/OFF NODE NAME',
          ...rows,
        ].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }

  processMatch(
    args: readonly string[],
    commandName: 'pgrep' | 'pkill',
    processes: readonly RuntimeKernelProcessRecord[]
  ): RuntimeCommandResult {
    let fullCommand = false;
    let exact = false;
    let listName = false;
    let listFull = false;
    let signalName = 'SIGTERM';
    const positional: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '--') {
        positional.push(...args.slice(index + 1));
        break;
      }
      if (arg === '-f') {
        fullCommand = true;
      } else if (arg === '-x') {
        exact = true;
      } else if (commandName === 'pgrep' && arg === '-l') {
        listName = true;
      } else if (commandName === 'pgrep' && arg === '-a') {
        listFull = true;
      } else if (
        commandName === 'pgrep' &&
        /^-[aflx]+$/.test(arg)
      ) {
        fullCommand ||= arg.includes('f');
        exact ||= arg.includes('x');
        listName ||= arg.includes('l');
        listFull ||= arg.includes('a');
      } else if (
        commandName === 'pkill' &&
        /^-[fx]+$/.test(arg)
      ) {
        fullCommand ||= arg.includes('f');
        exact ||= arg.includes('x');
      } else if (
        commandName === 'pkill' &&
        arg.startsWith('-') &&
        arg.length > 1
      ) {
        const signal = normalizeTraceKernelSignal(arg.slice(1));
        if (!signal) {
          return {
            stdout: '',
            stderr:
              `${commandName}: invalid signal: ` +
              `${arg.slice(1)}\n`,
            exitCode: 2,
          };
        }
        signalName = signal.name;
      } else if (arg.startsWith('-')) {
        return this.processMatchUsage(commandName);
      } else {
        positional.push(arg);
      }
    }
    if (positional.length !== 1) {
      return this.processMatchUsage(commandName);
    }

    let pattern: RegExp;
    try {
      pattern = new RegExp(
        exact ? `^(?:${positional[0]})$` : positional[0]
      );
    } catch {
      return {
        stdout: '',
        stderr: `${commandName}: invalid regular expression\n`,
        exitCode: 2,
      };
    }
    const matches = processes.filter((process) => {
      const candidate = fullCommand
        ? process.command
        : processDisplayName(process);
      return pattern.test(candidate);
    });
    if (matches.length === 0) {
      return { stdout: '', stderr: '', exitCode: 1 };
    }
    if (commandName === 'pgrep') {
      const rows = matches.map((process) =>
        listFull
          ? `${process.pid} ${process.command}`
          : listName
            ? `${process.pid} ${processDisplayName(process)}`
            : String(process.pid)
      );
      return {
        stdout: `${rows.join('\n')}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    let denied = 0;
    let signaled = 0;
    for (const process of matches) {
      if (this.signalProcess(process, signalName)) signaled += 1;
      else denied += 1;
    }
    if (signaled === 0 && denied > 0) {
      return {
        stdout: '',
        stderr: `${commandName}: Operation not permitted\n`,
        exitCode: 1,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  ps(
    args: readonly string[],
    processes: readonly RuntimeKernelProcessRecord[]
  ): RuntimeCommandResult {
    const supported = new Set(['', '-e', '-f', '-ef', 'aux']);
    const mode = args.join('');
    if (!supported.has(mode)) {
      return {
        stdout: '',
        stderr: 'usage: ps [-e|-f|-ef|aux]\n',
        exitCode: 2,
      };
    }
    if (mode === 'aux') {
      const rows = processes.map((process) =>
        [
          this.kernelInfo.user.username.padEnd(8, ' '),
          String(process.pid).padStart(5, ' '),
          '0.0'.padStart(4, ' '),
          '0.0'.padStart(4, ' '),
          '0'.padStart(7, ' '),
          '0'.padStart(5, ' '),
          (
            process.tty === '?'
              ? '?'
              : process.tty.replace('/dev/', '')
          ).padEnd(7, ' '),
          processStat(process).padEnd(4, ' '),
          processStartLabel(process).padEnd(5, ' '),
          '0:00'.padStart(5, ' '),
          process.command,
        ].join(' ')
      );
      return {
        stdout:
          [
            'USER       PID %CPU %MEM    VSZ   RSS TTY     ' +
              'STAT START  TIME COMMAND',
            ...rows,
          ].join('\n') + '\n',
        stderr: '',
        exitCode: 0,
      };
    }
    const rows = processes.map((process) =>
      [
        String(process.pid).padStart(5, ' '),
        String(process.ppid).padStart(5, ' '),
        String(process.pgid).padStart(5, ' '),
        String(process.sid).padStart(5, ' '),
        process.state.padEnd(8, ' '),
        process.foreground ? '+' : '-',
        process.tty.padEnd(8, ' '),
        process.command,
      ].join(' ')
    );
    return {
      stdout:
        [
          '  PID  PPID  PGID   SID STAT     FG TTY      CMD',
          ...rows,
        ].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }

  jobs(
    args: readonly string[],
    processes: readonly RuntimeKernelProcessRecord[],
    currentPid: number | undefined
  ): RuntimeCommandResult {
    if (
      args.length > 1 ||
      (args[0] !== undefined && args[0] !== '-l')
    ) {
      return {
        stdout: '',
        stderr: 'usage: jobs [-l]\n',
        exitCode: 2,
      };
    }
    const rows = processes
      .filter(
        (process) =>
          process.pid !== currentPid && process.pid !== 1
      )
      .map((process, index) => {
        const marker = process.foreground ? '+' : '-';
        const status =
          process.state === 'running'
            ? 'Running'
            : process.state === 'zombie'
              ? 'Done'
              : process.state;
        const placement = process.foreground
          ? 'foreground'
          : 'background';
        return args[0] === '-l'
          ? `[${index + 1}]${marker} ${process.pid}\t` +
              `${status}\t${placement}\t${process.tty}\t` +
              process.command
          : `[${index + 1}]${marker} ${status}\t` +
              process.command;
      });
    return {
      stdout: rows.length > 0 ? `${rows.join('\n')}\n` : '',
      stderr: '',
      exitCode: 0,
    };
  }

  private processMatchUsage(
    commandName: 'pgrep' | 'pkill'
  ): RuntimeCommandResult {
    return {
      stdout: '',
      stderr:
        `usage: ${commandName} [-f] [-x]${
          commandName === 'pgrep' ? ' [-a|-l]' : ' [-SIGNAL]'
        } pattern\n`,
      exitCode: 2,
    };
  }
}

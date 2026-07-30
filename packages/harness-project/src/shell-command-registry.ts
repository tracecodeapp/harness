import type { RuntimeCommandResult } from '@tracecode/harness-core';
import {
  defineCommand,
  type Command,
  type CommandContext,
  type CustomCommand,
} from 'just-bash/browser';
import {
  TRACEKERNEL_COMMAND_DISPATCH_PREFIX,
  TRACEKERNEL_EXEC_COMMAND,
  TRACEKERNEL_SHELL_COMMAND_PREFIX,
} from './constants';

type WorkspaceShellCommandHandler = (
  args: string[],
  context: CommandContext
) => RuntimeCommandResult | Promise<RuntimeCommandResult>;

interface RuntimeLazyCommand {
  name: string;
  load: () => Promise<Command>;
}

export interface WorkspaceShellCommandRegistryOptions {
  runtimeCommands: readonly CustomCommand[];
  customCommands?: readonly CustomCommand[];
  handlers: Readonly<Record<string, WorkspaceShellCommandHandler>>;
  help(
    name: string,
    args: readonly string[]
  ): RuntimeCommandResult | null;
  withSignalContext(context: CommandContext): CommandContext;
}

export interface WorkspaceShellCommandRegistry {
  exposedCommands: readonly CustomCommand[];
  commands: readonly CustomCommand[];
  dispatchNames: ReadonlyMap<string, string>;
}

const PUBLIC_COMMAND_NAMES = [
  'bg',
  'curl',
  'df',
  'du',
  'fastfetch',
  'fg',
  'getconf',
  'getent',
  'groups',
  'kill',
  'jobs',
  'hostname',
  'id',
  'lsof',
  'locale',
  'ls',
  'man',
  'mktemp',
  'mount',
  'neofetch',
  'pgrep',
  'ping',
  'pkill',
  'ps',
  'ss',
  'stat',
  'stty',
  'tput',
  'tracekernelctl',
  'tty',
  'umask',
  'uname',
  'wait',
  'wget',
  'which',
  'whoami',
  'command',
] as const;

const SHELL_COMMAND_ALIASES = [
  ['bg', 'bg'],
  ['command', 'command'],
  ['fg', 'fg'],
  ['kill', 'kill'],
  ['jobs', 'jobs'],
  ['lsof', 'lsof'],
  ['pgrep', 'pgrep'],
  ['pkill', 'pkill'],
  ['ps', 'ps'],
  ['ss', 'ss'],
  ['test', 'test'],
  ['test-bracket', 'test-bracket'],
  ['wait', 'wait'],
] as const;

function isCommand(command: CustomCommand): command is Command {
  return typeof (command as Command).execute === 'function';
}

function isLazyCommand(
  command: CustomCommand
): command is RuntimeLazyCommand {
  return typeof (command as RuntimeLazyCommand).load === 'function';
}

function aliasCommand(
  command: CustomCommand,
  name: string
): CustomCommand {
  if (isCommand(command)) return { ...command, name };
  return {
    name,
    load: async () => ({ ...(await command.load()), name }),
  };
}

function wrapCommand(
  command: CustomCommand,
  options: Pick<
    WorkspaceShellCommandRegistryOptions,
    'help' | 'withSignalContext'
  >
): CustomCommand {
  if (isCommand(command)) {
    return {
      ...command,
      execute: (args, context) => {
        const help = options.help(command.name, args);
        if (help) return Promise.resolve(help);
        return command.execute(
          args,
          options.withSignalContext(context)
        );
      },
    };
  }
  if (isLazyCommand(command)) {
    return {
      ...command,
      load: async () =>
        wrapCommand(await command.load(), options) as Command,
    };
  }
  return command;
}

/**
 * Compose language runtimes, workspace userland, custom commands, and the
 * private shell adapters used by AST rewriting into one just-bash registry.
 */
export function createWorkspaceShellCommandRegistry(
  options: WorkspaceShellCommandRegistryOptions
): WorkspaceShellCommandRegistry {
  const handler = (name: string): WorkspaceShellCommandHandler => {
    const resolved = options.handlers[name];
    if (!resolved) {
      throw new Error(
        `Workspace shell command "${name}" has no registered handler.`
      );
    }
    return resolved;
  };
  const exposedCommands: CustomCommand[] = [
    ...options.runtimeCommands,
    defineCommand(
      TRACEKERNEL_EXEC_COMMAND,
      (args, context) =>
        Promise.resolve(handler('exec')(args, context))
    ),
    ...PUBLIC_COMMAND_NAMES.map((name) =>
      defineCommand(
        name,
        (args, context) =>
          Promise.resolve(handler(name)(args, context))
      )
    ),
    ...(options.customCommands ?? []),
    ...SHELL_COMMAND_ALIASES.map(([name, handlerName]) =>
      defineCommand(
        `${TRACEKERNEL_SHELL_COMMAND_PREFIX}${name}`,
        (args, context) =>
          Promise.resolve(handler(handlerName)(args, context))
      )
    ),
  ];
  const dispatchNames = new Map(
    exposedCommands.map((command) => [
      command.name,
      `${TRACEKERNEL_COMMAND_DISPATCH_PREFIX}${command.name}`,
    ])
  );
  const commands = [
    ...exposedCommands,
    ...exposedCommands.map((command) =>
      aliasCommand(command, dispatchNames.get(command.name)!)
    ),
  ].map((command) => wrapCommand(command, options));
  return {
    exposedCommands,
    commands,
    dispatchNames,
  };
}

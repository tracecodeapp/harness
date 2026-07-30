import type {
  RuntimeCommandOptions,
  RuntimeCommandResult,
  RuntimeKernelHttpListenerInfo,
  RuntimeWorkspaceActor,
} from '@tracecode/runtime-contracts';
import type { CommandContext } from 'just-bash/browser';
import type { RuntimeCommandExecutionContext } from './fs-observed';
import type { RuntimeKernelProcessRecord } from './process-state';
import type { WorkspaceCommandCatalog } from './workspace-command-catalog';
import type { WorkspaceFilesystemCommands } from './userland-filesystem-commands';
import type { WorkspaceIdentityCommands } from './userland-identity-commands';
import type { WorkspaceNetworkCommands } from './userland-network-commands';
import type { WorkspaceProcessInspection } from './userland-process-inspection';
import type { WorkspaceTerminalCommands } from './userland-terminal-commands';
import {
  createWorkspaceShellCommandRegistry,
  type WorkspaceShellCommandRegistry,
} from './shell-command-registry';
import type { ProjectWorkspaceCommand } from './workspace-options';

type WorkspaceShellHandler = (
  args: string[],
  context: CommandContext
) => RuntimeCommandResult | Promise<RuntimeCommandResult>;

export interface WorkspaceShellCommandOptions {
  readonly runtimeCommands: readonly ProjectWorkspaceCommand[];
  readonly customCommands?: readonly ProjectWorkspaceCommand[];
  readonly filesystem: WorkspaceFilesystemCommands;
  readonly identity: WorkspaceIdentityCommands;
  readonly network: WorkspaceNetworkCommands;
  readonly processInspection: WorkspaceProcessInspection;
  readonly terminal: WorkspaceTerminalCommands;
  readonly commandCatalog: WorkspaceCommandCatalog;
  readonly resolveCommandContext: (
    context?: CommandContext
  ) => RuntimeCommandExecutionContext | undefined;
  readonly principalProcess: () => RuntimeKernelProcessRecord;
  readonly presentationProcesses: (
    actor?: RuntimeWorkspaceActor
  ) => readonly RuntimeKernelProcessRecord[];
  readonly httpListeners: () => readonly RuntimeKernelHttpListenerInfo[];
  readonly terminalForCommand: (
    context: CommandContext
  ) => RuntimeCommandOptions['terminal'] | undefined;
  readonly exec: WorkspaceShellHandler;
  readonly placeJob: (
    args: string[],
    placement: 'bg' | 'fg',
    context: CommandContext
  ) => Promise<RuntimeCommandResult>;
  readonly kill: WorkspaceShellHandler;
  readonly man: (
    args: readonly string[]
  ) => RuntimeCommandResult;
  readonly control: WorkspaceShellHandler;
  readonly wait: WorkspaceShellHandler;
  readonly which: WorkspaceShellHandler;
  readonly command: WorkspaceShellHandler;
  readonly withSignalContext: (
    context: CommandContext
  ) => CommandContext;
}

/**
 * Composes TraceKernel's public userland commands with the language runtime
 * commands mounted into the workspace.
 *
 * Command behavior remains in the focused filesystem, identity, network,
 * process, and terminal modules. This boundary owns only dispatch wiring and
 * the process views each command is allowed to inspect.
 */
export function createRuntimeWorkspaceShellCommands(
  options: WorkspaceShellCommandOptions
): WorkspaceShellCommandRegistry {
  const commandContext = (
    context: CommandContext
  ): RuntimeCommandExecutionContext | undefined =>
    options.resolveCommandContext(context);
  const visibleProcesses = (
    context: CommandContext,
    includePrincipal: boolean
  ): readonly RuntimeKernelProcessRecord[] => {
    const current = commandContext(context);
    const processes = options.presentationProcesses(
      current?.actor
    );
    return includePrincipal
      ? [options.principalProcess(), ...processes]
      : processes;
  };

  return createWorkspaceShellCommandRegistry({
    runtimeCommands: options.runtimeCommands,
    customCommands: options.customCommands,
    handlers: {
      exec: options.exec,
      bg: (args, context) =>
        options.placeJob(args, 'bg', context),
      curl: (args, context) =>
        options.network.curl(args, context),
      df: (args, context) =>
        options.filesystem.df(args, context),
      du: (args, context) =>
        options.filesystem.du(args, context),
      fastfetch: (args, context) =>
        options.identity.fastfetch(
          args,
          options.terminalForCommand(context)
        ),
      fg: (args, context) =>
        options.placeJob(args, 'fg', context),
      getconf: (args) => options.identity.getconf(args),
      getent: (args) => options.identity.getent(args),
      groups: (args) => options.identity.groups(args),
      kill: options.kill,
      jobs: (args, context) => {
        const current = commandContext(context);
        return options.processInspection.jobs(
          args,
          visibleProcesses(context, false),
          current?.process.pid
        );
      },
      hostname: (args) => options.identity.hostname(args),
      id: (args) => options.identity.id(args),
      lsof: (args) =>
        options.processInspection.lsof(
          args,
          options.httpListeners()
        ),
      locale: (args) => options.identity.locale(args),
      ls: (args, context) =>
        options.filesystem.ls(args, context),
      man: (args) => options.man(args),
      mktemp: (args, context) =>
        options.filesystem.mktemp(args, context),
      mount: (args) => options.filesystem.mount(args),
      neofetch: (args, context) =>
        options.identity.fastfetch(
          args,
          options.terminalForCommand(context)
        ),
      pgrep: (args, context) => {
        const current = commandContext(context);
        return options.processInspection.processMatch(
          args,
          'pgrep',
          visibleProcesses(context, true).filter(
            (process) => process.pid !== current?.process.pid
          )
        );
      },
      ping: (args) => options.network.ping(args),
      pkill: (args, context) => {
        const current = commandContext(context);
        return options.processInspection.processMatch(
          args,
          'pkill',
          visibleProcesses(context, true).filter(
            (process) => process.pid !== current?.process.pid
          )
        );
      },
      ps: (args, context) =>
        options.processInspection.ps(
          args,
          visibleProcesses(context, true)
        ),
      ss: (args) =>
        options.processInspection.ss(
          args,
          options.httpListeners()
        ),
      stat: (args, context) =>
        options.filesystem.stat(args, context),
      stty: (args, context) =>
        options.terminal.stty(
          args,
          options.terminalForCommand(context)
        ),
      tput: (args, context) =>
        options.terminal.tput(
          args,
          options.terminalForCommand(context)
        ),
      tracekernelctl: options.control,
      tty: (args, context) =>
        options.terminal.tty(
          args,
          options.terminalForCommand(context)
        ),
      umask: (args, context) =>
        options.terminal.umask(
          args,
          commandContext(context)
        ),
      uname: (args) => options.identity.uname(args),
      wait: options.wait,
      wget: (args, context) =>
        options.network.wget(args, context),
      which: options.which,
      whoami: (args) => options.identity.whoami(args),
      command: options.command,
      test: (args, context) =>
        options.terminal.testTerminal(
          args,
          'test',
          options.terminalForCommand(context)
        ),
      'test-bracket': (args, context) =>
        options.terminal.testTerminal(
          args,
          '[',
          options.terminalForCommand(context)
        ),
    },
    help: (name, args) =>
      options.commandCatalog.help(name, args),
    withSignalContext: options.withSignalContext,
  });
}

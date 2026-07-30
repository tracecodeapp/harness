import type {
  RuntimeCommandResult,
} from '@tracecode/runtime-contracts';
import type {
  RuntimeKernelVirtualStat,
} from '@tracecode/runtime-contracts';
import {
  TRACEKERNEL_BIN_PATH,
  TRACEKERNEL_COMMAND_DISPATCH_PREFIX,
  TRACEKERNEL_SHELL_COMMAND_PREFIX,
} from './constants';
import {
  normalizeTraceKernelVirtualPath,
  traceKernelBinCommandName,
} from './paths';
import {
  traceKernelRuntimeRegistry,
  type TraceKernelCommandInfo,
} from './language-commands';
import type {
  RuntimeDynamicProcEntry,
} from './fs-observed';

function traceKernelTsv(value: unknown): string {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ');
}

/**
 * Immutable projection of the executables exposed by a workspace.
 *
 * Runtime authority stays with the workspace and its runner adapters. This
 * catalog owns only command discovery, learner-facing help, and the generated
 * `/tracekernel/bin` namespace.
 */
export class WorkspaceCommandCatalog {
  constructor(
    private readonly commands: readonly TraceKernelCommandInfo[],
    private readonly dispatchNames: () => ReadonlyMap<string, string>
  ) {}

  info(nameOrPath: string): TraceKernelCommandInfo | undefined {
    const rawCommandName = traceKernelBinCommandName(nameOrPath) ?? nameOrPath;
    const dispatchCommandName = rawCommandName.startsWith(
      TRACEKERNEL_COMMAND_DISPATCH_PREFIX
    )
      ? rawCommandName.slice(TRACEKERNEL_COMMAND_DISPATCH_PREFIX.length)
      : rawCommandName;
    const commandName = dispatchCommandName.startsWith(
      TRACEKERNEL_SHELL_COMMAND_PREFIX
    )
      ? dispatchCommandName.slice(TRACEKERNEL_SHELL_COMMAND_PREFIX.length)
      : dispatchCommandName;
    return this.commands.find((command) => command.name === commandName);
  }

  help(name: string, args: readonly string[]): RuntimeCommandResult | null {
    const info = this.info(name);
    const help = info?.help;
    if (
      !help ||
      args.length !== 1 ||
      !(help.flags ?? ['--help']).includes(args[0]!)
    ) {
      return null;
    }
    const flags = help.flags ?? ['--help'];
    const helpFlags = flags.join(', ');
    const helpOption = `${helpFlags}${' '.repeat(
      Math.max(1, 20 - helpFlags.length)
    )}display this help and exit`;
    return {
      stdout:
        [
          `${info.name} - ${help.summary}`,
          '',
          `Usage: ${help.usage}`,
          ...((help.options?.length ?? 0) > 0 || flags.length > 0
            ? [
                '',
                'Options:',
                ...(help.options ?? []).map((option) => `  ${option}`),
                `  ${helpOption}`,
              ]
            : []),
          ...((help.notes?.length ?? 0) > 0
            ? ['', 'Notes:', ...help.notes!.map((note) => `  ${note}`)]
            : []),
        ].join('\n') +
        '\n',
      stderr: '',
      exitCode: 0,
    };
  }

  readFile(path: string): string | null {
    const commandName = traceKernelBinCommandName(path);
    if (!commandName) return null;
    if (commandName.startsWith(TRACEKERNEL_COMMAND_DISPATCH_PREFIX)) {
      return null;
    }
    const info = this.info(commandName);
    if (!info) return null;
    const dispatchName =
      this.dispatchNames().get(info.name) ??
      `${TRACEKERNEL_COMMAND_DISPATCH_PREFIX}${info.name}`;
    return `#!/bin/sh\nexec ${dispatchName} "$@"\n`;
  }

  readDir(path: string): RuntimeDynamicProcEntry[] | null {
    const normalized = normalizeTraceKernelVirtualPath(path);
    if (normalized === '/tracekernel') {
      return [{ name: 'bin', kind: 'directory' }];
    }
    if (normalized === TRACEKERNEL_BIN_PATH) {
      return this.commands.map((command) => ({
        name: command.name,
        kind: 'file' as const,
      }));
    }
    return null;
  }

  entryKind(path: string): 'file' | 'directory' | null {
    if (this.readDir(path)) return 'directory';
    return this.readFile(path) !== null ? 'file' : null;
  }

  stat(path: string): RuntimeKernelVirtualStat | null {
    const kind = this.entryKind(path);
    if (!kind) return null;
    const content = kind === 'file' ? this.readFile(path) ?? '' : '';
    return {
      isFile: kind === 'file',
      isDirectory: kind === 'directory',
      isCharacterDevice: false,
      mode: 0o555,
      size: new TextEncoder().encode(content).byteLength,
      uid: 0,
      gid: 0,
      owner: 'root',
      group: 'root',
    };
  }

  renderCommands(): string {
    const rows = this.commands.map((command) =>
      [
        command.name,
        command.path,
        command.kind,
        command.language ?? '',
        command.adapter,
        command.versionLabel ?? '',
        command.description ?? '',
      ]
        .map(traceKernelTsv)
        .join('\t')
    );
    return [
      'name\tpath\tkind\tlanguage\tadapter\tversion\tdescription',
      ...rows,
    ].join('\n') + '\n';
  }

  renderRuntimes(): string {
    return (
      JSON.stringify(
        {
          schema: 'tracekernel.runtimes.v1',
          binPath: TRACEKERNEL_BIN_PATH,
          runtimes: traceKernelRuntimeRegistry(this.commands),
        },
        null,
        2
      ) + '\n'
    );
  }
}

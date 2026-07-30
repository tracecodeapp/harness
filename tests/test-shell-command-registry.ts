#!/usr/bin/env npx tsx

import {
  defineCommand,
  type Command,
  type CommandContext,
  type CustomCommand,
} from 'just-bash/browser';
import {
  createWorkspaceShellCommandRegistry,
} from '../packages/harness-project/src/shell-command-registry';

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function commandByName(
  commands: readonly CustomCommand[],
  name: string
): CustomCommand {
  const command = commands.find((candidate) => candidate.name === name);
  assertCondition(command, `missing command ${name}`);
  return command;
}

function isCommand(command: CustomCommand): command is Command {
  return typeof (command as Command).execute === 'function';
}

async function main(): Promise<void> {
  const handled: string[] = [];
  const signaled: string[] = [];
  const handlers = new Proxy(
    {},
    {
      get: (_target, property) =>
        async (args: string[], context: CommandContext) => {
          handled.push(`${String(property)}:${args.join(',')}:${context.cwd}`);
          return { stdout: `${String(property)}\n`, stderr: '', exitCode: 0 };
        },
    }
  ) as Record<string, (
    args: string[],
    context: CommandContext
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>>;
  const runtimeCommand = defineCommand(
    'runtime-tool',
    async () => ({ stdout: 'runtime\n', stderr: '', exitCode: 0 })
  );
  const lazyRuntimeCommand: CustomCommand = {
    name: 'lazy-tool',
    load: async () =>
      defineCommand(
        'lazy-tool',
        async () => ({ stdout: 'lazy\n', stderr: '', exitCode: 0 })
      ),
  };
  const customCommand = defineCommand(
    'user-tool',
    async () => ({ stdout: 'user\n', stderr: '', exitCode: 0 })
  );
  const registry = createWorkspaceShellCommandRegistry({
    runtimeCommands: [runtimeCommand, lazyRuntimeCommand],
    customCommands: [customCommand],
    handlers,
    help: (name, args) =>
      args.length === 1 && args[0] === '--help'
        ? { stdout: `help:${name}\n`, stderr: '', exitCode: 0 }
        : null,
    withSignalContext: (context) => {
      signaled.push(context.cwd);
      return { ...context, cwd: '/signaled' };
    },
  });

  assertEqual(
    registry.exposedCommands[0]?.name,
    'runtime-tool',
    'runtime commands should stay first'
  );
  assertCondition(
    registry.exposedCommands.some((command) => command.name === 'user-tool'),
    'custom commands should remain exposed'
  );
  assertCondition(
    registry.exposedCommands.some(
      (command) => command.name === 'tracekernel-shell-test-bracket'
    ),
    'private shell adapters should be registered'
  );
  assertEqual(
    registry.commands.length,
    registry.exposedCommands.length * 2,
    'each exposed command should have a dispatch alias'
  );
  assertEqual(
    registry.dispatchNames.get('curl'),
    'tracekernel-dispatch-curl',
    'dispatch name should be deterministic'
  );

  const context = { cwd: '/workspace' } as CommandContext;
  const curl = commandByName(registry.commands, 'curl');
  assertCondition(isCommand(curl), 'curl should be eager');
  const result = await curl.execute(['example.test'], context);
  assertEqual(result.stdout, 'curl\n', 'built-in should dispatch to its handler');
  assertEqual(
    handled[0],
    'curl:example.test:/signaled',
    'signal context should wrap built-in execution'
  );

  const curlHelp = await curl.execute(['--help'], context);
  assertEqual(curlHelp.stdout, 'help:curl\n', 'help should bypass the handler');
  assertEqual(handled.length, 1, 'help should not execute the command handler');

  const lazyAlias = commandByName(
    registry.commands,
    'tracekernel-dispatch-lazy-tool'
  );
  assertCondition(!isCommand(lazyAlias), 'lazy command should remain lazy');
  const loaded = await lazyAlias.load();
  assertEqual(
    loaded.name,
    'tracekernel-dispatch-lazy-tool',
    'lazy dispatch alias should preserve its alias after loading'
  );
  const lazyResult = await loaded.execute([], context);
  assertEqual(lazyResult.stdout, 'lazy\n', 'lazy command should still execute');
  assertCondition(
    signaled.length >= 2,
    'eager and lazy commands should both receive signal context'
  );
}

await main();
console.log('shell command registry tests passed');

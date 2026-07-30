#!/usr/bin/env npx tsx

import type { RuntimeKernelInfo } from '../packages/runtime-contracts/src/index';
import { WorkspaceIdentityCommands } from '../packages/tracekernel/src/workspace/userland-identity-commands';

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

const kernelInfo: RuntimeKernelInfo = {
  name: 'tracekernel',
  version: '0.14.0-test',
  user: {
    id: 'learner',
    username: 'learner',
    home: '/home/learner',
  },
  host: {
    hostname: 'tracevm',
    osName: 'tracekernel',
  },
  workspace: {
    id: 'workspace-test',
    name: 'api-service',
    root: '/home/learner/api-service',
    startedAt: new Date().toISOString(),
  },
  home: '/home/learner',
  cwd: '/home/learner/api-service',
  workspaceRoot: '/home/learner/api-service',
  workspaceAlias: '/workspace',
};

const commands = new WorkspaceIdentityCommands({
  kernelInfo,
  environment: {
    HOME: kernelInfo.home,
    LANG: 'C.UTF-8',
  },
  commands: [],
  resolveHost: (hostname) =>
    hostname === 'api.example'
      ? {
          reachable: true,
          via: 'external',
          ip: '203.0.113.10',
          latencyMs: 2,
        }
      : {
          reachable: false,
          reason: 'unknown-host',
        },
});

assertEqual(commands.whoami([]).stdout, 'learner\n', 'whoami identity');
assertEqual(commands.whoami(['extra']).exitCode, 1, 'whoami operands');
assertEqual(commands.id(['-un']).stdout, 'learner\n', 'named user id');
assertEqual(commands.id(['other']).exitCode, 1, 'unknown user');
assertEqual(
  commands.getent(['hosts', 'api.example']).stdout,
  '203.0.113.10 api.example\n',
  'reachable host lookup'
);
assertEqual(
  commands.getent(['hosts', 'missing.example']).exitCode,
  2,
  'unreachable host lookup'
);
assertEqual(commands.locale(['charmap']).stdout, 'UTF-8\n', 'locale charmap');
assertEqual(commands.uname(['-s']).stdout, 'TraceKernel\n', 'kernel name');
assertEqual(commands.uname(['-m']).stdout, 'wasm32\n', 'architecture');

const fastfetch = commands.fastfetch([], {
  isTTY: true,
  term: 'xterm-256color',
  columns: 120,
  rows: 40,
  colorLevel: 2,
});
assertCondition(
  fastfetch.stdout.includes('OS: TraceKernel'),
  'fastfetch should report the TraceKernel identity'
);
assertCondition(
  fastfetch.stdout.includes('Architecture: wasm32'),
  'fastfetch should report the runtime architecture'
);
assertCondition(
  !fastfetch.stdout.toLowerCase().includes('linux'),
  'fastfetch should not claim a Linux identity'
);

console.log('identity userland command tests passed');

#!/usr/bin/env npx tsx

import {
  createRuntimeCommandStdinPipeFromText,
  RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES,
  runtimeWorkspaceActorPreset,
} from '../packages/harness-core/src/index';
import type { RuntimeCommandExecutionContext } from '../packages/harness-project/src/fs-observed';
import { WorkspaceDeviceIo } from '../packages/harness-project/src/workspace-device-io';

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

function commandContext(
  input = ''
): RuntimeCommandExecutionContext {
  return {
    actor: runtimeWorkspaceActorPreset('principal'),
    process: { pid: 2 },
    signal: new AbortController().signal,
    stdinPipe: createRuntimeCommandStdinPipeFromText(input),
    umask: 0o022,
    runtimeIo: {} as RuntimeCommandExecutionContext['runtimeIo'],
    generationBaseline: new Map(),
    mutatedGenerationPaths: new Set(),
    deviceStdout: '',
    deviceStderr: '',
    outputBytes: { stdout: 0, stderr: 0 },
    truncatedOutputStreams: new Set(),
  };
}

function main(): void {
  const events: Array<{
    stream: string;
    device?: string;
    data: string;
  }> = [];
  const io = new WorkspaceDeviceIo({
    emitOutput: (event) => {
      events.push(event);
    },
  });

  const inputContext = commandContext('hello\n');
  assertCondition(
    io.read('/dev/stdin', inputContext) === 'hello\n',
    'stdin devices should consume the command pipe'
  );
  assertCondition(
    io.read('/dev/null', inputContext) === '',
    'non-input devices should read as empty'
  );

  io.write(
    '/dev/stdout',
    'visible\n',
    runtimeWorkspaceActorPreset('principal')
  );
  io.write('/dev/null', 'discarded\n');
  assertCondition(
    events.length === 1 &&
      events[0]?.stream === 'stdout' &&
      events[0]?.device === '/dev/stdout' &&
      events[0]?.data === 'visible\n',
    'device routing should emit stdout and discard /dev/null'
  );

  let readonlyError = '';
  try {
    io.write('/dev/stdin', 'invalid');
  } catch (error) {
    readonlyError =
      error instanceof Error ? error.message : String(error);
  }
  assertCondition(
    readonlyError.includes('read-only'),
    'input-only devices should reject output'
  );

  const outputContext = commandContext();
  io.write('/dev/stderr', 'device error\n', outputContext);
  const returned = io.captureReturnedOutput(outputContext, {
    stdout: 'returned output\n',
    stderr: '',
  });
  assertCondition(
    returned.stdout === 'returned output\n' &&
      returned.stderr === 'device error\n',
    'returned and device output should be combined once'
  );

  const truncationContext = commandContext();
  const oversized = 'x'.repeat(
    RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES + 1
  );
  const truncated = io.captureCommandOutput(
    truncationContext,
    'stdout',
    oversized
  );
  assertCondition(
    truncated.includes('stdout output truncated') &&
      truncationContext.truncatedOutputStreams.has('stdout') &&
      io.captureCommandOutput(
        truncationContext,
        'stdout',
        'ignored'
      ) === '',
    'the first oversized write should mark and close the stream budget'
  );
}

main();
console.log('workspace device IO tests passed');

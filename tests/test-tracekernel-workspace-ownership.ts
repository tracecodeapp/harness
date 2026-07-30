#!/usr/bin/env npx tsx

import * as legacyProject from '../packages/harness-project/src/index';
import * as traceKernelWorkspace from '../packages/tracekernel/src/workspace/index';

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  assertCondition(
    typeof legacyProject.createRuntimeWorkspace === 'function' &&
      typeof traceKernelWorkspace.createRuntimeWorkspace ===
        'function',
    'both the compatibility facade and TraceKernel workspace entrypoint should expose the workspace factory'
  );
  assertCondition(
    !('runtimeHttpBodyText' in traceKernelWorkspace),
    'the TraceKernel workspace surface should not re-export core helpers'
  );
  assertCondition(
    typeof legacyProject.runtimeHttpBodyText === 'function',
    'the compatibility facade should preserve the legacy core helper surface'
  );

  const workspace =
    await traceKernelWorkspace.createRuntimeWorkspace();
  try {
    const result = await workspace.runCommand(
      'printf tracekernel-workspace'
    );
    assertCondition(
      result.exitCode === 0 &&
        result.stdout === 'tracekernel-workspace',
      'the TraceKernel-owned workspace should execute commands'
    );
  } finally {
    await workspace.destroy();
  }
}

void main().then(() => {
  console.log('tracekernel workspace ownership tests passed');
});

#!/usr/bin/env npx tsx

import * as publicTraceKernel from '../src/tracekernel';
import * as traceKernelWorkspace from '../packages/tracekernel/src/workspace/index';

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  assertCondition(
    typeof publicTraceKernel.createRuntimeWorkspace === 'function' &&
      typeof traceKernelWorkspace.createRuntimeWorkspace ===
        'function',
    'the public TraceKernel surface should expose the TraceKernel-owned workspace factory'
  );
  assertCondition(
    typeof traceKernelWorkspace.runtimeHttpBodyText === 'function',
    'the TraceKernel workspace surface should re-export the contracts it implements'
  );
  assertCondition(
    typeof publicTraceKernel.runtimeHttpBodyText === 'function',
    'the public TraceKernel surface should compose its shared HTTP helpers'
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

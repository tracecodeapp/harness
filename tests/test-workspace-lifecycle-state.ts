#!/usr/bin/env npx tsx

import { WorkspaceLifecycleState } from '../packages/harness-project/src/workspace-lifecycle-state';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function testIdentityAllocation(): void {
  const state = new WorkspaceLifecycleState();
  assertEqual(state.allocateRuntimeActorId(), 'runtime:1', 'first runtime actor');
  assertEqual(state.allocateRuntimeActorId(), 'runtime:2', 'second runtime actor');
  assertEqual(state.allocateTemporaryEntry(), 1, 'first temporary entry');
  assertEqual(state.allocateTemporaryEntry(), 2, 'second temporary entry');
  assertEqual(
    state.allocateTerminalSessionId(),
    'terminal-1',
    'first terminal session'
  );
  assertEqual(
    state.allocateTerminalSessionId(),
    'terminal-2',
    'second terminal session'
  );
}

function testLifecycleFlags(): void {
  const state = new WorkspaceLifecycleState();
  assertEqual(state.destroyed, false, 'workspace should begin available');
  state.destroyed = true;
  assertEqual(state.destroyed, true, 'destroyed flag should be session-owned');

  assertEqual(
    state.scheduleExpirationDestroy(),
    true,
    'first expiration destroy should schedule'
  );
  assertEqual(
    state.scheduleExpirationDestroy(),
    false,
    'expiration destroy should schedule exactly once'
  );
}

function testTerminalVerbosity(): void {
  const state = new WorkspaceLifecycleState();
  assertEqual(state.terminalVerbose, false, 'terminal should begin concise');
  assertEqual(state.toggleTerminalVerbose(), true, 'toggle should enable');
  assertEqual(
    state.setTerminalVerbose(false),
    false,
    'explicit setter should disable'
  );
}

testIdentityAllocation();
testLifecycleFlags();
testTerminalVerbosity();

console.log('workspace lifecycle state tests passed');

import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { createRuntimeWorkspace } from '../packages/tracekernel/src/workspace/index';
import { runtimeWorkspaceActorPreset } from '../packages/runtime-contracts/src/runtime-workspace-manifest';
import { createRuntimeCommandStdinPipe, readRuntimeCommandStdinPipeBytes } from '../packages/runtime-contracts/src/runtime-command';
import { TraceKernelPipe } from '../packages/tracekernel/src/descriptors';
import { ProcessAuthority } from '../packages/tracekernel/src/workspace/process-authority';

// A missed cancellation must fail the suite instead of leaving a pending read
// or delivery finalizer suspended indefinitely.
const watchdog = setTimeout(() => { throw new Error('Revocation delivery test timed out'); }, 15_000);
watchdog.unref();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const kind of ['input', 'signal-character', 'eof', 'resize', 'signal'] as const) {
  const workspace = await createRuntimeWorkspace({ files: [] });
  const internal = workspace as any;
  const actor = workspace.kernel.createProcess({ name: 'learner', actor: runtimeWorkspaceActorPreset('runtime') });
  const parent = internal.processState.table.get(actor.pid);
  const barrier = deferred();
  const entered = deferred();
  const finalizing = deferred();
  const finish = deferred();
  try {
    let id!: string;
    const allocate = internal.lifecycleState.allocateTerminalSessionId.bind(internal.lifecycleState);
    internal.lifecycleState.allocateTerminalSessionId = () => (id = allocate());
    actor.createTerminalSession();
    await internal.ensureTerminalShell(id, {}, parent);
    internal.kernelTerminalInputRoute = () => 'kernel';
    const session = internal.traceKernelAuthority.session;
    const method = kind === 'eof' ? 'sendTerminalInputEof' : kind === 'resize' ? 'resizeTerminal' : kind === 'signal' ? 'signalTerminalForeground' : 'writeTerminalInput';
    const original = session[method].bind(session);
    let delivered = false;
    let settled = false;
    session[method] = (...args: any[]) => Effect.promise(() => { entered.resolve(); return barrier.promise; }).pipe(
      Effect.zipRight(original(...args)),
      Effect.tap(() => Effect.sync(() => { delivered = true; })),
      Effect.ensuring(Effect.promise(() => { finalizing.resolve(); return finish.promise; }).pipe(Effect.tap(() => Effect.sync(() => { settled = true; }))))
    );
    if (kind === 'eof') internal.endKernelTerminalInput(id);
    else if (kind === 'resize') internal.resizeKernelTerminal(id, 100, 40);
    else if (kind === 'signal') internal.signalTerminalForeground(id, 'SIGINT');
    else internal.writeKernelTerminalInput(id, kind === 'input' ? 'late input\n' : '\u0003');
    await entered.promise;
    let drained = false;
    const drain = actor.revokeAndDrain().then(() => { drained = true; });
    await finalizing.promise;
    await Promise.resolve();
    assert.equal(drained, false, `${kind}: drain skipped delivery finalization`);
    finish.resolve();
    await drain;
    assert.equal(settled, true);
    barrier.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(delivered, false, `${kind}: queued kernel delivery escaped revocation`);
    console.log(`PASS queued ${kind}: refused and finalized before drain`);
  } finally {
    barrier.resolve(); finish.resolve();
    await workspace.destroy();
  }
}

{
  const workspace = await createRuntimeWorkspace({ files: [] });
  const internal = workspace as any;
  try {
    const actor = workspace.kernel.createProcess({ name: 'learner', actor: runtimeWorkspaceActorPreset('runtime') });
    let id!: string;
    const allocate = internal.lifecycleState.allocateTerminalSessionId.bind(internal.lifecycleState);
    internal.lifecycleState.allocateTerminalSessionId = () => (id = allocate());
    actor.createTerminalSession();
    internal.queueTerminalStartupInput(id, { data: 'startup', eof: true });
    const parent = internal.processState.table.get(actor.pid);
    const shell = await internal.ensureTerminalShell(id, {}, parent);
    const session = internal.traceKernelAuthority.session;
    await Effect.runPromise(session.writeTerminalInput(shell.terminalId, new TextEncoder().encode('already buffered')));
    const read = shell.process.read(0, 64); // Constructed before revocation.
    const drain = actor.revokeAndDrain();
    assert.equal(internal.pendingTerminalStartupInput.has(id), false);
    await assert.rejects(Effect.runPromise(read), /revoked|bad file descriptor/i);
    await drain;
    console.log('PASS startup queue discarded and buffered terminal read refused');
  } finally { await workspace.destroy(); }
}

{
  const root = new ProcessAuthority();
  const child = new ProcessAuthority(root);
  const scope = new ProcessAuthority(child);
  const context = { pid: 1, pgid: 1, sid: 1, assertActive: scope.assertActive, signal: scope.signal };
  const pipe = await Effect.runPromise(TraceKernelPipe.make('revocation-pipe', { capacityChunks: 1 }));
  const reader = pipe.reader();
  const writer = pipe.writer();
  try {
    await Effect.runPromise(writer.write(new Uint8Array([1])));
    const pending = scope.run(() => Effect.runPromise(writer.write(new Uint8Array([2]), undefined, context)));
    const refused = assert.rejects(pending, /revoked/);
    root.revoke();
    await root.drain();
    await refused;
    assert.deepEqual(await Effect.runPromise(reader.read(1)), new Uint8Array([1]));
    await assert.rejects(Effect.runPromise(reader.readNonblocking!(1)), /EAGAIN/);
    await assert.rejects(Effect.runPromise(reader.read(1, undefined, context)), /revoked/);
    console.log('PASS grandchild backpressured pipe delivery canceled; independent reader unaffected');
  } finally { await Effect.runPromise(pipe.dispose()); }
}

{
  const started = deferred();
  const finish = deferred();
  const pipe = createRuntimeCommandStdinPipe();
  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'main.js', contents: '// fixture' }],
    nodeRunner: async () => { started.resolve(); await finish.promise; return { stdout: '', stderr: '', exitCode: 0 }; },
  });
  try {
    const actor = workspace.kernel.createProcess({ name: 'learner', actor: runtimeWorkspaceActorPreset('runtime') });
    const run = actor.runCommand('node main.js', { stdinPipe: pipe }).catch(() => undefined);
    await started.promise;
    pipe.write('queued legacy input');
    const drain = actor.revokeAndDrain();
    assert.equal(readRuntimeCommandStdinPipeBytes(pipe).byteLength, 0);
    assert.throws(() => pipe.write('late'), /closed/);
    finish.resolve();
    await drain; await run;
    console.log('PASS legacy shared stdin closed and unread input discarded synchronously');
  } finally { finish.resolve(); await workspace.destroy(); }
}

clearTimeout(watchdog);

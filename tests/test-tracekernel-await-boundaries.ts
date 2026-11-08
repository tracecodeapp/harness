import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { createRuntimeWorkspace } from '../packages/tracekernel/src/workspace/index';
import { runtimeWorkspaceActorPreset } from '../packages/runtime-contracts/src/runtime-workspace-manifest';
import type { RuntimeWorkspaceProcess } from '../packages/runtime-contracts/src/runtime-workspace';

// This entrypoint is bundled only by test-tracekernel-await-injection.mjs.
// Production modules acquire no fault-injection hooks.
const scenarios: Array<[string, (actor: RuntimeWorkspaceProcess) => Promise<unknown>]> = [
  ['write', (actor) => actor.writeFile('file', 'late')],
  ['replace-symlink', (actor) => actor.writeFile('soft', 'late')],
  ['create-parents', (actor) => actor.writeFile('new/parents/file', 'late')],
  ['delete', (actor) => actor.deleteFile('file')],
  ['file-metadata', (actor) => actor.applyFileChange({ path: 'file', contents: 'late', mode: 0o600, mtimeMs: 1234 })],
  ['directory-metadata', (actor) => actor.applyFileChange({ path: 'new', directory: true, mode: 0o700, mtimeMs: 1234 })],
  ['recursive-delete', (actor) => actor.applyFileChange({ path: 'dir', directory: true, deleted: true })],
  ['worker-failed-batch', (actor) => actor.runCommand('node invalid.js')],
  ['worker-final-diff', (actor) => actor.runCommand('node main.js')],
  ['replace-file-with-symlink', (actor) => actor.applyFileChange({ path: 'file', symlink: true, target: 'dir/one' })],
  ['symlink-diff', (actor) => actor.applyFileChange({ path: 'new-link', symlink: true, target: 'file' })],
  ...['echo late >> file', 'rm -r dir', 'mv dir moved', 'cp -r dir copied', 'ln file hard', 'ln -s file link', 'mkdir -p a/b', 'rmdir empty', 'chmod 600 file', 'touch file'].map((command): [string, (actor: RuntimeWorkspaceProcess) => Promise<unknown>] => [command, (actor) => actor.runCommand(command)]),
];
const probeGlobal = globalThis as typeof globalThis & {
  __harnessAwait?: (site: string, value: unknown) => Promise<unknown>;
};
let total = 0;
for (const [name, execute] of scenarios) {
  const run = async (target?: string): Promise<Set<string>> => {
    const workspace = await createRuntimeWorkspace({
      nodeRunner: async (request) => request.scriptPath.endsWith('invalid.js')
        ? ({ stdout: '', stderr: '', exitCode: 0, files: [{ path: 'file', contents: 'never live' }, { path: 'bad', contents: 'invalid mode', mode: -1 }] })
        : ({ stdout: '', stderr: '', exitCode: 0, files: [{ path: 'file', contents: 'worker result', mode: 0o600 }, { path: 'worker-dir', directory: true }] }),
      files: [
      { path: 'main.js', contents: '// fixture' },
      { path: 'invalid.js', contents: '// fixture' },
      { path: 'file', contents: 'before' },
      { path: 'dir/one', contents: 'one' },
      { path: 'dir/sub/two', contents: 'two' },
    ] });
    await workspace.mkdir('empty');
    await workspace.kernel.applyFileChange({ path: 'soft', symlink: true, target: 'file' });
    const actor = workspace.kernel.createProcess({ name: 'learner', actor: runtimeWorkspaceActorPreset('runtime') });
    const fs = (workspace as any).traceKernelAuthority.session.fileSystem;
    const sites = new Set<string>();
    const occurrences = new Map<string, number>();
    let reached!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    probeGlobal.__harnessAwait = async (site, value) => {
      const result = await value;
      const occurrence = (occurrences.get(site) ?? 0) + 1;
      occurrences.set(site, occurrence);
      const point = `${site}#${occurrence}`;
      sites.add(point);
      if (point === target && !held) { held = true; reached(); await barrier; }
      return result;
    };
    const pending = execute(actor);
    const settled = pending.then(() => undefined, () => undefined);
    try {
      if (target) {
        await Promise.race([paused, settled.then(() => { if (!held) throw new Error(`Unreached await: ${name}: ${target}`); })]);
        // Some operations have already committed an earlier sub-operation at
        // this boundary. Preserve that state exactly; no later commit is legal.
        const before = await Effect.runPromise(fs.exportImage());
        const drain = actor.revokeAndDrain();
        release();
        await settled;
        await drain;
        probeGlobal.__harnessAwait = undefined;
        assert.deepEqual(await Effect.runPromise(fs.exportImage()), before, `${name}: mutation after ${target}`);
        const exited = new Set<number>();
        for (const record of workspace.journal()) {
          if (!('pid' in record) || record.pid === undefined) continue;
          assert.equal(exited.has(record.pid), false, `${name}: journal after exit at ${target}`);
          if (record.kind === 'process' && record.op === 'exit') exited.add(record.pid);
        }
      } else {
        await pending;
        probeGlobal.__harnessAwait = undefined;
        await actor.revokeAndDrain();
      }
      return sites;
    } finally {
      release();
      probeGlobal.__harnessAwait = undefined;
      await workspace.destroy();
    }
  };
  const sites = await run();
  assert.ok(sites.size, `No instrumented boundaries: ${name}`);
  for (const site of sites) { await run(site); total++; }
  console.log(`PASS ${name}: ${sites.size} awaited continuations`);
}
console.log(`PASS ${total} mutation await-boundary schedules`);

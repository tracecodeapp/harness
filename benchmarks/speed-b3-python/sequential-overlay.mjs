// Apply to a disposable, clean copy of the concurrent candidate on the build
// host. The output is an experiment package, never a release candidate.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [checkout, commit, mode] = process.argv.slice(2);
assert.ok(checkout && /^[0-9a-f]{40}$/u.test(commit ?? ''), 'Supply a disposable checkout and the candidate commit');
const root = resolve(checkout);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), commit);
if (mode !== '--check') assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '');
const file = join(root, 'packages/runtime-python/src/python-runtime-client.ts');
let source = await readFile(file, 'utf8');
function edit(anchor, replacement) {
  assert.equal(source.split(anchor).length, 2, 'Python benchmark overlay anchor changed: ' + anchor);
  source = source.replace(anchor, () => replacement);
}
edit('    initialWorker: WarmedPythonWorker\n  ) {', `
    initialWorker: WarmedPythonWorker,
    private readonly transferBenchmarkWorker?: (take: () => WarmedPythonWorker) => void
  ) {`);
edit(`      return await this.executeSerial(call.signal, (client, signal) =>
        call.stopAtFirstRunaway === true`, `      const results = await this.executeSerial(call.signal, (client, signal) =>
        call.stopAtFirstRunaway === true`);
edit(`          : budget.run((budgetSignal) => runBatch(client, budgetSignal), signal)
      );`, `          : budget.run((budgetSignal) => runBatch(client, budgetSignal), signal),
        (rows) => call.stopAtFirstRunaway === true &&
          rows.length === call.inputBatch.length &&
          rows.every((row) => row.kind === 'completed' && row.timings?.algorithmFastBatch === true)
      );
      if (this.initialWorker) {
        this.transferBenchmarkWorker?.(() => {
          const warmed = this.initialWorker!;
          this.initialWorker = null;
          this.ownedWorkers.delete(warmed.client);
          return warmed;
        });
      }
      return results;`);
edit('  private preparationTail: Promise<void> = Promise.resolve();', `
  // The frozen browser runner has one outstanding evaluation per host and
  // waits for disposal between runs. The control fails outside that shape.
  private readonly pendingBenchmarkWorkers = new Map<string, (worker: WarmedPythonWorker) => void>();
  private preparationTail: Promise<void> = Promise.resolve();
`);
edit(`    const worker = this.options.createWorkerClient();
    this.preparationWorkers.add(worker);
    const controller = new AbortController();`, `
    const controller = new AbortController();`);
edit(`    const { signal } = controller;
    try {
      const warmup = await raceWithAbort(worker.warmup(), signal);`, `
    const { signal } = controller;
    const key = JSON.stringify([program.code, program.functionName, program.executionStyle ?? 'function']);
    let claimed: WarmedPythonWorker | undefined;
    const workerReady = new Promise<WarmedPythonWorker>((resolve, reject) => {
      if (this.pendingBenchmarkWorkers.has(key)) {
        reject(new Error('Sequential phone control received overlapping observations'));
        return;
      }
      this.pendingBenchmarkWorkers.set(key, (worker) => {
        claimed = worker;
        this.preparationWorkers.add(worker.client);
        resolve(worker);
      });
    });
    try {
      const { client: worker, warmup } = await raceWithAbort(workerReady, signal);
      signal.throwIfAborted();`);
edit(`      this.preparationControllers.delete(controller);
      this.retirePreparationWorker(worker);
    }
  }

  reset(): void`, `
      this.preparationControllers.delete(controller);
      this.pendingBenchmarkWorkers.delete(key);
      if (claimed) this.retirePreparationWorker(claimed.client);
    }
  }

  reset(): void`);
edit(`      preparationWorker
    );
    this.programs.add(lifetime);

    if (call.mode === 'trace')`, `      preparationWorker,
      (take) => {
        const key = JSON.stringify([call.code, call.functionName, call.executionStyle ?? 'function']);
        const claim = this.pendingBenchmarkWorkers.get(key);
        if (claim) claim(take());
      }
    );
    this.programs.add(lifetime);

    if (call.mode === 'trace')`);
if (mode !== '--check') await writeFile(file, source);

import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
} from '../../src/judge';

// Real C# workers in a browser. Every command a page worker receives is
// journaled in send order with its worker, role and kind, so the checks read
// command order only and take no timing.

interface JournalEntry {
  readonly seq: number;
  readonly workerId: number;
  readonly role: string;
  readonly kind: string;
  readonly direction: 'send' | 'reply';
}

const healthyCode = `public class Solution
{
    public int solve(int n)
    {
        int doubled = n * 2;
        return doubled - n;
    }
}`;

function installJournal() {
  const NativeWorker = globalThis.Worker;
  const journal: JournalEntry[] = [];
  const roles = new Map<number, string>();
  let seq = 0;
  let nextWorkerId = 0;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      const workerId = ++nextWorkerId;
      const kinds = new Map<string, string>();
      const post = this.postMessage.bind(this);
      this.postMessage = ((message, transfer) => {
        const payload = message?.payload ?? {};
        if (typeof payload.runtimeRole === 'string') roles.set(workerId, payload.runtimeRole);
        const prime = message?.type === 'execute-prepared-code' &&
          payload.inputs?.a === 1 && payload.inputs?.b === 2;
        const kind = prime
          ? 'prime'
          : message?.type === 'execute-prepared-trace' && payload.observation !== undefined
            ? 'observe'
            : message?.type === 'prepare-program'
              ? `prepare-program:${payload.mode}`
              : String(message?.type);
        if (typeof message?.id === 'string' && message.type !== 'compiler-artifact-cache-response') {
          kinds.set(message.id, kind);
          journal.push({ seq: ++seq, workerId, role: roles.get(workerId) ?? 'unknown', kind, direction: 'send' });
        }
        post(message, transfer as Transferable[]);
      }) as typeof this.postMessage;
      this.addEventListener('message', (event) => {
        const kind = kinds.get(event.data?.id);
        if (!kind || event.data?.type === 'runtime-progress') return;
        kinds.delete(event.data.id);
        journal.push({ seq: ++seq, workerId, role: roles.get(workerId) ?? 'unknown', kind, direction: 'reply' });
      });
    }
  };
  return {
    journal,
    roles,
    restore() {
      globalThis.Worker = NativeWorker;
    },
  };
}

function bundle(source: string, trace: boolean) {
  return createAlgorithmJudgeBundle({
    id: 'csharp-observer-routes',
    language: 'csharp',
    code: source,
    functionName: 'solve',
    executionStyle: 'solution-method',
    trace,
    limits: { wallClockMs: 10_000 },
    cases: [
      { id: 'A', input: { n: 7 }, expected: 7 },
      { id: 'B', input: { n: 11 }, expected: 11 },
    ],
    comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
  });
}

function countByRole(entries: readonly JournalEntry[], roles: ReadonlyMap<number, string>) {
  const workers = new Map<string, Set<number>>();
  for (const entry of entries) {
    const role = roles.get(entry.workerId) ?? 'unknown';
    let set = workers.get(role);
    if (!set) workers.set(role, set = new Set());
    set.add(entry.workerId);
  }
  return Object.fromEntries([...workers].map(([role, set]) => [role, set.size]));
}

/**
 * Fix A in real workers: the observer runner loads .NET and runs the trusted
 * prime before the companion compile is even sent, and observe() sends it
 * the drawing alone. Returns worker counts by role for the report.
 */
export async function assertCSharpObserverPrestart(
  csharpWorker: string,
  csharpRunnerAssetBaseUrl: string
): Promise<Record<string, unknown>> {
  const recorder = installJournal();
  const { journal, roles } = recorder;
  try {
    const host = createBrowserJudgeHost({
      providers: ['csharp'],
      assetBaseUrl: '/workers',
      assets: { csharpWorker, csharpRunnerAssetBaseUrl },
      safeExecution: { workerLifecycle: 'warm-and-retire' },
    });
    try {
      await host.warmLanguage('csharp');

      // Run: ordinary grades plus one selected drawing.
      const runFrom = journal.length;
      const run = await host.execute({ bundle: await bundle(healthyCode, true), interactive: true, tracing: { caseIds: ['A'] } });
      const { evaluation, executionId } = run;
      if (evaluation.status !== 'completed' || !executionId ||
          evaluation.cases.map((row) => row.status === 'completed' && row.verdict.kind).join() !== 'passed,passed') {
        throw new Error(`C# Run verdict changed: ${JSON.stringify(evaluation)}`);
      }
      const selected = evaluation.cases[0];
      if (selected?.attachment?.status !== 'drawn') {
        throw new Error(`C# Run did not draw the selected case: ${JSON.stringify(selected?.attachment)}`);
      }
      const runEntries = journal.slice(runFrom);
      const observeSends = runEntries.filter((entry) => entry.kind === 'observe' && entry.direction === 'send');
      if (observeSends.length !== 1) throw new Error(`C# Run sent ${observeSends.length} drawings`);
      const observer = observeSends[0]!.workerId;
      const observerSends = runEntries.filter((entry) => entry.workerId === observer && entry.direction === 'send');
      const companionSend = runEntries.find((entry) => entry.kind === 'prepare-program:trace' && entry.direction === 'send');
      if (!companionSend) throw new Error('C# Run did not compile the companion');
      const observerKinds = observerSends.map((entry) => entry.kind);
      const learnerCommands = observerKinds.filter((kind) => kind.startsWith('execute-') || kind === 'observe');
      if (learnerCommands.join() !== 'observe' ||
          !(observerKinds.indexOf('init') >= 0 &&
            observerKinds.indexOf('init') < observerKinds.indexOf('warmup') &&
            observerKinds.indexOf('warmup') < observerKinds.indexOf('prime') &&
            observerKinds.indexOf('prime') < observerKinds.indexOf('observe'))) {
        throw new Error(`C# observer runner commands: ${observerKinds.join()}`);
      }
      if (!(observerSends[0]!.seq < companionSend.seq)) {
        throw new Error('C# observer runner must start loading .NET before the companion compile is sent');
      }
      const primeReply = runEntries.find((entry) => entry.workerId === observer && entry.kind === 'prime' && entry.direction === 'reply');
      if (!primeReply || !(primeReply.seq < observeSends[0]!.seq)) {
        throw new Error('C# observer runner must finish the trusted prime before it receives learner code');
      }
      const ordinaryWorkers = new Set(runEntries
        .filter((entry) => entry.kind === 'execute-prepared-code' && entry.direction === 'send')
        .map((entry) => entry.workerId));
      if (ordinaryWorkers.has(observer)) throw new Error('C# observer runner ran an ordinary case');
      const runCounts = countByRole(runEntries, roles);

      // Click: one command on the retained observer, no compile.
      const clickFrom = journal.length;
      const click = await host.execute({ executionId, tracing: { caseIds: ['B'] } });
      // A continuation projects only the requested cases.
      const clicked = click.evaluation.cases.find((row) => row.caseId === 'B');
      if (click.evaluation.cases.length !== 1 || clicked?.attachment?.status !== 'drawn') {
        throw new Error(`C# click did not draw case B: ${JSON.stringify(click.evaluation.cases)}`);
      }
      const clickSends = journal.slice(clickFrom).filter((entry) => entry.direction === 'send' && entry.role !== 'compiler');
      const clickDrawings = clickSends.filter((entry) => entry.kind === 'observe');
      if (clickDrawings.length !== 1 || clickDrawings[0]!.workerId !== observer ||
          journal.slice(clickFrom).some((entry) => entry.kind.startsWith('prepare-program'))) {
        throw new Error(`C# click was not one drawing on the retained observer: ${JSON.stringify(journal.slice(clickFrom))}`);
      }
      await host.disposeExecution(executionId);

      // Submit: no observation lease, so no observer runner.
      const submitFrom = journal.length;
      const submit = await host.evaluateAlgorithm({ bundle: await bundle(healthyCode, false) });
      if (submit.verdict !== 'passed') throw new Error(`C# Submit verdict changed: ${submit.verdict}`);
      const submitEntries = journal.slice(submitFrom);
      if (submitEntries.some((entry) => entry.kind === 'observe' || entry.kind === 'prepare-program:trace')) {
        throw new Error('C# Submit must not observe or compile a companion');
      }
      const submitRunnerWorkers = new Set(submitEntries
        .filter((entry) => roles.get(entry.workerId) === 'runner')
        .map((entry) => entry.workerId));
      const submitOrdinary = new Set(submitEntries
        .filter((entry) => entry.kind === 'execute-prepared-code')
        .map((entry) => entry.workerId));
      for (const workerId of submitRunnerWorkers) {
        const kinds = submitEntries.filter((entry) => entry.workerId === workerId && entry.direction === 'send').map((entry) => entry.kind);
        // Each runner Submit touches either grades or is the standby
        // replenishment; none is an unused primed observer.
        if (!submitOrdinary.has(workerId) && kinds.some((kind) => !['init', 'warmup', 'prime'].includes(kind))) {
          throw new Error(`C# Submit touched an unexpected runner: ${kinds.join()}`);
        }
      }
      return {
        runWorkersByRole: runCounts,
        submitWorkersByRole: countByRole(submitEntries, roles),
        observerCommands: observerKinds,
      };
    } finally {
      await host.dispose();
    }
  } finally {
    recorder.restore();
  }
}

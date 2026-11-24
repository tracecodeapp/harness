import {
  allCasesPassPolicy,
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
  judgeCaseExecutionOutcome,
} from 'tracecode-harness-under-test/judge';

export async function run() {
  // A real same-origin Python worker still handles every command. Record the
  // role from the transport and keep IDs only long enough to correlate ACKs.
  const NativeWorker = window.Worker;
  const traffic = [];
  let sequence = 0;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      const path = new URL(url, location.href);
      if (!path.pathname.endsWith('/python-worker.js') || path.searchParams.get('tracecodePythonRole') === 'runtime-image') return;
      const worker = ++sequence;
      const commands = new Map();
      const send = this.postMessage.bind(this);
      this.postMessage = (message, transfer) => {
        if (message.type === 'execute-prepared-program-batch' || message.type === 'execute-prepared-program') {
          const record = {
            worker,
            mode: message.payload.mode,
            observer: message.payload.artifact?.observationOnly === true,
            count: message.payload.inputBatch?.length ?? 1,
          };
          commands.set(message.id, { protocolToken: message.protocolToken, record });
          traffic.push({ ...record, phase: 'dispatch' });
        }
        return send(message, transfer ?? []);
      };
      this.addEventListener('message', ({ data }) => {
        const command = commands.get(data?.id);
        if (!command || data.protocolToken !== command.protocolToken) return;
        const { record } = command;
        if (data.type === 'batch-case-progress' && data.payload.phase === 'started') {
          traffic.push({ ...record, phase: 'admit', index: data.payload.index });
        } else if (data.type === 'execute-result') {
          traffic.push({ ...record, phase: 'ack' });
          commands.delete(data.id);
        }
      });
    }
  };
  const host = createBrowserJudgeHost({ assetBaseUrl: '/staged/workers', providers: ['python'] });
  const code = 'def solve(n):\n    print(n)\n    if n == 7:\n        raise ValueError("bad seven")\n    return n + 1';
  const cases = [{ id: 'A', input: { n: 7 }, expected: 8 }, { id: 'B', input: { n: 11 }, expected: 12 }];
  const options = { language: 'python', functionName: 'solve', code, cases, policy: allCasesPassPolicy() };
  const projection = (evaluation) => evaluation.cases.map((row) => {
    const { timings, ...outcome } = judgeCaseExecutionOutcome(row, { language: 'python' });
    return {
      outcome,
      diagnostics: row.diagnostics,
      stdout: row.stdout,
      stderr: row.stderr,
      failure: row.failure,
      verdict: row.verdict,
    };
  });
  try {
    const run = await host.execute({
      bundle: await createAlgorithmJudgeBundle({ ...options, id: 'run', trace: true }),
      interactive: true,
      tracing: { caseIds: ['A'] },
    });
    const continuation = await host.execute({ executionId: run.executionId, tracing: { caseIds: ['B'] } });
    const redraw = await host.execute({ executionId: run.executionId, tracing: { caseIds: ['B'] } });
    const watchedTraffic = traffic.splice(0);
    const submit = await host.evaluateAlgorithm({
      bundle: await createAlgorithmJudgeBundle({ ...options, id: 'submit', trace: false }),
    });
    const submitTraffic = traffic.splice(0);
    const runPassingCase = await host.execute({
      bundle: await createAlgorithmJudgeBundle({ ...options, id: 'run-passing-case', trace: true }),
      tracing: { caseIds: ['B'] },
    });
    const byte = await host.execute({
      bundle: await createAlgorithmJudgeBundle({
        ...options,
        id: 'byte',
        trace: true,
        traceOptions: { maxTraceBytes: 1 },
      }),
      tracing: { caseIds: ['B'] },
    });
    const [selected, unselected] = run.evaluation.cases;
    return {
      initial: projection(run.evaluation),
      submit: projection(submit.evaluation),
      runPassingCase: projection(runPassingCase.evaluation),
      failingCaseHasAttachment: Object.hasOwn(runPassingCase.evaluation.cases[0], 'attachment'),
      submitTraffic,
      continuation: projection(continuation.evaluation),
      redraw: projection(redraw.evaluation),
      drawing: selected.attachment,
      continuationDrawing: continuation.evaluation.cases[0].attachment,
      byte: byte.evaluation.cases[1].attachment,
      unselectedHasAttachment: Object.hasOwn(unselected, 'attachment'),
      legacyRefusalFields: run.evaluation.cases.flatMap((row) =>
        ['traceUnavailable', 'traceUnavailableRun', 'untracedRunNeeded'].filter((key) => Object.hasOwn(row, key))),
      watchedTraffic,
    };
  } finally {
    host.dispose();
    window.Worker = NativeWorker;
  }
}

import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
  judgeCaseExecutionOutcome,
} from '@tracecode/harness/judge';

const faults = {
  'no-recorder': 'recorder-unavailable',
  'observer-compile-fault': 'observer-prepare',
  'observer-encoder-fault': 'observer-encode',
};
const refusals = ['traceUnavailable', 'traceUnavailableRun', 'untracedRunNeeded'];

export async function runFixture(fixture, fault) {
  const NativeWorker = globalThis.Worker;
  const journal = [];
  const assertions = [];
  let generation = 0;
  const name = fault ?? fixture.name;
  const check = (route, suffix, pass, actual) => {
    assertions.push({ id: ['G5', fixture.language, name, route, suffix].join('/'), pass: Boolean(pass), actual });
  };
  globalThis.Worker = class ObservedWorker extends NativeWorker {
    constructor(url, options) {
      const route = new URL(String(url), location.href);
      if (fault && route.pathname.endsWith('/javascript-worker.js')) {
        route.pathname = route.pathname.replace(/javascript-worker\.js$/u, `b4-${fault}.js`);
      }
      super(route, options);
      this.generation = ++generation;
      this.prepares = new Map();
      this.inFlight = new Map();
      this.addEventListener('message', ({ data }) => {
        if (data.type === 'observation-started') {
          journal.push({ worker: this.generation, type: data.type, token: data.payload.attemptToken });
          return;
        }
        if (data.type === 'b4-injection-ack') {
          journal.push({ worker: this.generation, type: data.type, token: data.token, fault: data.fault });
          return;
        }
        const dispatch = this.inFlight.get(data.id);
        if (dispatch && (data.type === 'execute-result' || data.type === 'error' || 'ok' in data)) {
          this.inFlight.delete(data.id);
          journal.push({
            worker: this.generation, type: 'reply', dispatched: dispatch.type,
            token: data.payload?.attemptToken, input: dispatch.input, mode: dispatch.mode,
          });
        }
      });
    }

    postMessage(message, ...transfer) {
      const payload = message.payload ?? message;
      if (message.type === 'prepare') this.prepares.set(message.programId, message.source.mode);
      if (message.type === 'prepare-execution' || message.type === 'prepare-observation') {
        journal.push({ worker: this.generation, type: message.type, operation: payload.operation });
      }
      if (['execute-batch', 'execute-code', 'observe-execution'].includes(message.type)) {
        const entry = {
          worker: this.generation,
          type: message.type,
          mode: this.prepares.get(message.programId) ?? (message.type === 'execute-code' ? 'code' : 'observation'),
          input: payload.inputs?.n ?? payload.inputBatch?.[0]?.n,
          token: payload.attemptToken,
        };
        this.inFlight.set(message.id, entry);
        journal.push(entry);
      }
      return super.postMessage(message, ...transfer);
    }
  };

  const host = createBrowserJudgeHost({ providers: [fixture.language], assetBaseUrl: '/workers' });
  let executionId;
  let initial;
  let continuation;
  let repeated;
  let submit;
  let error;
  try {
    const bundle = await createAlgorithmJudgeBundle({
      ...fixture,
      id: `b4-${fixture.language}-${name}`,
      trace: true,
      cases: fixture.cases.map(({ id, input, expected }) => ({ id, input, expected })),
      limits: { wallClockMs: 10_000 },
    });
    initial = await host.execute({ bundle, interactive: true, tracing: { caseIds: ['A'] } });
    executionId = initial.executionId;
    const [a, b] = initial.evaluation.cases;
    check('run-first', 'compile', initial.evaluation.compile?.status === 'compiled', initial.evaluation.compile);
    for (const [row, expected] of [[a, fixture.cases[0]], [b, fixture.cases[1]]]) {
      check('run-first', `${expected.id}/status`, row?.caseId === expected.id && row?.status === 'completed' &&
        row?.verdict.kind === 'passed' && row?.value === expected.actual && row?.stdout === expected.stdout, row);
      if (!row) continue;
      const converted = judgeCaseExecutionOutcome(row, { language: fixture.language, trace: true });
      check('run-first', `${expected.id}/legacy-fields-absent`,
        [row, converted].every((result) => refusals.every((field) => !Object.hasOwn(result, field))) &&
        row.diagnostics.every(({ code }) => code !== 'trace-unavailable'), converted.kind);
    }
    check('run-first', 'B/unselected', b && !Object.hasOwn(b, 'attachment') && !Object.hasOwn(b, 'trace'), b?.attachment);
    const attachment = a?.attachment;
    if (fault) {
      check('run-first', 'A/attachment', attachment?.status === 'refused' && attachment.reason === faults[fault], attachment);
      const injected = journal.filter(({ type }) => type === 'b4-injection-ack');
      const dispatch = journal.find(({ type }) => type === 'observe-execution');
      check('run-first', 'A/injection-ack', injected.length === 1 && injected[0].token === dispatch?.token &&
        injected[0].worker === dispatch?.worker && injected[0].fault === fault, injected);
    } else if (fixture.name === 'stdout') {
      check('run-first', 'A/anchor', attachment?.status === 'drawn' &&
        attachment.trace.events.some((event) => event.kind === 'stdout' && event.line === 2), attachment);
    } else {
      const byteCap = fixture.name === 'byte-cap';
      check('run-first', 'A/attachment', attachment?.status === 'truncated' &&
        attachment.reason === (byteCap ? 'byte-budget' : 'step-budget') &&
        (byteCap ? attachment.trace.events.length === 0 : attachment.trace.events.length > 0) &&
        attachment.attemptedEvents > attachment.trace.events.length, attachment);
    }
    const initialDispatch = journal.filter(({ type }) => type === 'observe-execution' || type === 'execute-batch' || type === 'execute-code');
    const ordinary = initialDispatch.filter(({ mode }) => mode === 'code');
    const observers = initialDispatch.filter(({ mode }) => mode === 'observation');
    check('run-first', 'ordinary-start-count', ordinary.length === 2 &&
      ordinary.map(({ input }) => input).join(',') === fixture.cases.map(({ input }) => input.n).join(',') &&
      journal.filter(({ type }) => type === 'prepare-execution').length === 1, journal);
    check('run-first', 'separate-observer-lease', observers.length === 1 &&
      ordinary.every(({ worker }) => worker !== observers[0].worker) &&
      journal.some(({ type, worker, token }) =>
        type === 'observation-started' && worker === observers[0].worker && token === observers[0].token) &&
      journal.some(({ type, token }) => type === 'reply' && token === observers[0].token), initialDispatch);
    if (!fault && executionId) {
      continuation = await host.execute({ executionId, tracing: { caseIds: ['B'] } });
      const countBeforeRedraw = journal.length;
      repeated = await host.execute({ executionId, tracing: { caseIds: ['B'] } });
      const [second] = continuation.evaluation.cases;
      check('continue-B', 'ordinary-start-count', journal.filter(({ type, mode }) =>
        mode === 'code' && (type === 'execute-batch' || type === 'execute-code')).length === 2, journal);
      check('continue-B', 'B/attachment', continuation.executionId === executionId &&
        continuation.evaluation.cases.length === 1 && second?.caseId === 'B' &&
        second?.value === b?.value && second?.stdout === b?.stdout &&
        (second?.attachment?.status === 'drawn' || second?.attachment?.status === 'truncated'), second);
      check('repeat-B', 'cache', journal.length === countBeforeRedraw &&
        repeated.evaluation.cases[0]?.attachment === second?.attachment, repeated.evaluation.cases[0]?.attachment);
    }
    if (!fault && fixture.name === 'stdout') {
      submit = await host.evaluateAlgorithm({ bundle });
      check('submit-traced', 'aggregate', submit.verdict === 'passed' && submit.passedCount === 2 &&
        submit.evaluation.cases.every((row) => row.attachment?.status === 'drawn'), submit.evaluation.cases);
    }
  } catch (cause) {
    error = String(cause);
  } finally {
    if (executionId) await host.disposeExecution(executionId);
    host.dispose();
    globalThis.Worker = NativeWorker;
  }
  return { fixture: [fixture.language, name], assertions, initial, continuation, repeated, submit, error, journal };
}

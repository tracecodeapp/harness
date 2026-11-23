import { createAlgorithmJudgeBundle, createBrowserJudgeHost } from '@tracecode/harness/judge';

const bridgeKey = Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1');
const faults = {
  'no-recorder': { point: 'observe', fault: 'no-recorder', reason: 'recorder-unavailable' },
  'observer-compile-fault': { point: 'prepare', fault: 'prepare', reason: 'observer-prepare' },
  'observer-encoder-fault': { point: 'encode', fault: 'encode', reason: 'observer-encode' },
};

export async function runHooks(language, route) {
  const NativeWorker = globalThis.Worker;
  const events = [];
  const assertions = [];
  const check = (name, pass, actual) =>
    assertions.push({ id: ['B4-hooks', language, route, name].join('/'), pass: Boolean(pass), actual });
  const stopping = route === 'submit-stop';
  const disposable = route === 'disposable';
  const control = faults[route];
  const inputs = stopping ? [11, 0, 33] : [7, 11, 33];
  const code = `function solve(n${language === 'typescript' ? ': number' : ''}) {
  ${stopping ? 'if (n === 0) { while (true) {} }' : ''}
  console.log(n);
  return n;
}`;
  Object.defineProperty(globalThis, bridgeKey, {
    configurable: true,
    value: {
      onEvent: (event) => events.push({ kind: 'schedule', ...event }),
      faultAt: ({ point, language: selected, caseId }) =>
        selected === 'javascript' && point === control?.point && (caseId === 'A' || point === 'prepare')
          ? control.fault : undefined,
    },
  });
  globalThis.Worker = class extends NativeWorker {
    programs = new Map();
    requests = new Map();
    constructor(url, options) {
      super(url, options);
      const route = String(url);
      this.addEventListener('message', ({ data, isTrusted }) => {
        const request = this.requests.get(data.id);
        if (!request || !isTrusted || !request.protocolToken || request.protocolToken !== data.protocolToken) return;
        if (data.type === 'runtime-progress' && data.payload?.stage === 'ordinary-case-started') {
          events.push({ kind: 'start', request, route, index: data.payload.detail?.caseIndex });
        }
        if (request.type === 'observe-execution' && data.type === 'execute-result' &&
            request.payload.attemptToken === data.payload.attemptToken) {
          events.push({ kind: 'observer-reply', ...data.payload });
        }
      });
    }
    postMessage(message, ...transfer) {
      if (message.type === 'prepare') this.programs.set(message.programId, message.source.mode);
      const ordinary = message.type === 'execute-code' ||
        (message.type === 'execute-batch' && this.programs.get(message.programId) === 'code');
      if (ordinary || message.type === 'observe-execution') this.requests.set(message.id, message);
      if (ordinary) events.push({ kind: 'dispatch', request: message });
      return super.postMessage(message, ...transfer);
    }
  };
  const host = createBrowserJudgeHost({
    providers: [language], assetBaseUrl: '/workers',
  });
  let executionId;
  try {
    const bundle = await createAlgorithmJudgeBundle({
      id: `b4-hooks-${language}-${route}`, language, code, functionName: 'solve', executionStyle: 'function',
      trace: !stopping,
      limits: { wallClockMs: stopping ? 4000 : 10000 },
      cases: inputs.map((n, i) => {
        const shared = {};
        return { id: 'ABC'[i], input: disposable ? { n, left: shared, right: shared } : { n }, expected: n };
      }),
    });
    const first = stopping
      ? await host.evaluateAlgorithm({ bundle, stopAtFirstRunaway: true })
      : await host.execute({ bundle, interactive: true, tracing: { caseIds: ['A'] } });
    executionId = first.executionId;
    const rows = first.evaluation.cases;
    const admitted = stopping ? inputs.slice(0, 2) : inputs;
    const wire = (kind) => events.filter((event) => event.kind === kind);
    const inputOf = ({ request, index = 0 }) => request.payload?.inputs?.n ?? request.inputBatch?.[index]?.n;
    const starts = wire('start');
    check('start-coverage', JSON.stringify(starts.map(inputOf)) === JSON.stringify(admitted) &&
      starts.every(({ index }) => index === 0), starts);
    check('dispatch-coverage', JSON.stringify(wire('dispatch').map(inputOf)) === JSON.stringify(admitted), wire('dispatch'));
    if (stopping) {
      check('limited-B-no-start-C', rows[1]?.failure?.origin === 'limit' &&
        rows[1].failure.reason === 'client-timeout' && rows[2]?.status === 'not-run' &&
        starts.filter((event) => inputOf(event) === 0).length === 1 &&
        starts.every((event) => inputOf(event) !== 33), rows);
    }
    const schedule = (phase) => wire('schedule').filter((event) => event.phase === phase);
    const commit = schedule('ordinary-commit')[0];
    const sameBinding = (event) => event.evaluationId === commit?.evaluationId &&
      event.workspaceDigest === bundle.workspaceDigest && event.generation === commit?.generation;
    const writes = schedule('ordinary-write-attempt');
    const resolve = schedule('public-resolve')[0];
    check('ordinary-journal', !!commit && !!resolve && sameBinding(commit) && sameBinding(resolve) &&
      writes.length === 3 && writes.map(({ caseId }) => caseId).join('') === 'ABC' &&
      writes.every((event) => sameBinding(event) && event.at <= commit.at) && commit.at <= resolve.at, wire('schedule'));
    if (!stopping) {
      const attachment = rows[0]?.attachment;
      const bind = schedule('attachment-bind')[0];
      check('attachment-journal', !!bind && !!commit && !!resolve && sameBinding(bind) &&
        bind.caseId === 'A' && bind.attemptToken && commit.at <= bind.at && bind.at <= resolve.at, wire('schedule'));
      if (control) {
        const ack = schedule('injection-ack')[0];
        const replies = wire('observer-reply');
        check('fault-ack', !!ack && sameBinding(ack) && ack.point === control.point && ack.fault === control.fault &&
          attachment?.status === 'refused' && attachment.reason === control.reason &&
          (control.point === 'prepare' ? ack.caseId === undefined && replies.length === 0 :
            ack.caseId === 'A' && ack.attemptToken === bind?.attemptToken && replies.length === 1 &&
            replies[0].attemptToken === ack.attemptToken && events.indexOf(replies[0]) < events.indexOf(ack)), { ack, replies, attachment });
        if (control.point === 'encode') {
          check('pre-encode-drawing', replies[0]?.drawing?.status === 'drawn' &&
            replies[0].drawing.trace.events.some(({ kind }) => kind === 'stdout'), replies);
        }
        if (route === 'no-recorder') {
          check('worker-recorder-disabled', replies[0]?.recorderDisabled === true &&
            replies[0].drawing?.reason === 'recorder-unavailable', replies);
        }
      } else {
        await host.execute({ executionId, tracing: { caseIds: ['B'] } });
        await host.execute({ executionId, tracing: { caseIds: ['B'] } });
        const cache = schedule('observation-cache-hit');
        const replies = wire('observer-reply');
        check('redraw-binding', cache.length === 1 && cache[0].caseId === 'B' &&
          sameBinding(cache[0]) && replies.length === 2 &&
          cache[0].attemptToken === replies[1].attemptToken, { cache, replies });
        check('zero-continuation-writes', schedule('ordinary-write-attempt').length === writes.length &&
          wire('dispatch').length === admitted.length && wire('start').length === admitted.length, events);
        check('observed-profile', starts.length === 3 && starts.every(({ route }) =>
          disposable ? route.includes('/javascript-worker.js') : route.includes('/javascript-ses-algorithm-worker.js')), starts);
      }
    }
  } catch (error) {
    return { fixture: [language, route], assertions, error: String(error), events };
  } finally {
    if (executionId) await host.disposeExecution(executionId);
    await host.dispose();
    globalThis.Worker = NativeWorker;
    Reflect.deleteProperty(globalThis, bridgeKey);
  }
  return { fixture: [language, route], assertions, events };
}

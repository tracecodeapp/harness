import { createPythonClock } from './gb-python-clock.mjs';
import { serviceDeadlineRoute } from './gb-probe.mjs';

function recorderEvents(payload) {
  const events = payload.trace?.events;
  const transfer = payload.__traceEventTransport;
  if (!transfer) return events;
  const { schema, encoding, path, eventCount, byteLength, chunks } = transfer;
  if (schema !== 'tracecode.trace-events.transfer.v1' || path !== 'trace.events' ||
      encoding !== 'json-utf8' || !Array.isArray(events) || events.length !== 0 ||
      !Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > 64 * 1024 * 1024 ||
      !Array.isArray(chunks) || chunks.some((chunk) => !(chunk instanceof ArrayBuffer)) ||
      chunks.reduce((size, chunk) => size + chunk.byteLength, 0) !== byteLength) return;
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  try {
    const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (Array.isArray(decoded) && decoded.length === eventCount) return decoded;
  } catch {
    // The oracle treats a malformed terminal as failed recorder evidence.
  }
}

function javaCaseProgress(type, payload) {
  return type === 'runtime-progress' &&
    (payload?.stage === 'ordinary-case-started' || payload?.stage === 'ordinary-case-finished');
}

// The browser page owns this transport. The installed Judge and worker files
// remain untouched. A real worker runs each released row. The transport holds
// the terminal batch response, leaving the production client to handle loss.
export function installJournal(fixture, { decodeJavaObservation } = {}) {
  const NativeWorker = globalThis.Worker;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const journal = [];
  let generation = 0;
  let request;
  let fault;
  let injected = false;
  let javaTimeoutWire;
  let serviceFinish;
  const scheduled = new Map();
  const pythonClock = fixture.language === 'python' && fixture.name === 'transport'
    ? createPythonClock({ record, nativeSetTimeout, nativeClearTimeout }) : undefined;

  function record(kind, fields) {
    journal.push({ sequence: journal.length + 1, kind, ...fields });
  }

  function matchesInput(row, input) {
    if (!input || typeof input !== 'object') return undefined;
    return Object.keys(row.input).length === Object.keys(input).length &&
      Object.entries(row.input).every(([key, value]) => JSON.stringify(value) === JSON.stringify(input[key]));
  }

  function deadlineMatches(ms) {
    return fault === 'timeout-fanout' && fixture.language === 'java' && ms === 132000;
  }

  function expire(at) {
    const timers = [...scheduled.entries()].filter(([, timer]) => timer.due <= at);
    record('production-timers-fired', { delays: timers.map(([, timer]) => timer.ms), at });
    for (const [token, timer] of timers) {
      if (!scheduled.delete(token)) continue;
      nativeClearTimeout(token);
      timer.run();
    }
  }

  globalThis.setTimeout = function (handler, ms, ...args) {
    const pythonTimer = pythonClock?.arm(handler, ms, args);
    if (pythonTimer !== undefined) return pythonTimer;
    if (typeof handler !== 'function' || !deadlineMatches(ms)) {
      return nativeSetTimeout(handler, ms, ...args);
    }
    const timerRequest = request;
    const run = () => {
      if (javaTimeoutWire && javaTimeoutWire.request === timerRequest) {
        javaTimeoutWire.closed = true;
        javaTimeoutWire = undefined;
      }
      handler(...args);
    };
    const token = nativeSetTimeout(() => {
      scheduled.delete(token);
      run();
    }, ms);
    scheduled.set(token, { ms, due: ms, run });
    return token;
  };
  globalThis.clearTimeout = function (token) {
    if (pythonClock?.clear(token)) return;
    scheduled.delete(token);
    nativeClearTimeout(token);
  };

  globalThis.Worker = class JournalWorker extends NativeWorker {
    #generation = ++generation;
    #wire = new Map();
    #judgeWire = new Map();
    #javaFault;
    #forwardingProgress = false;

    constructor(url, options) {
      super(url, options);
      record('worker', { generation: this.#generation, url: String(url), request });
      this.addEventListener('message', (event) => this.#read(event));
    }

    postMessage(message, ...transfer) {
      const payload = message?.payload ?? message;
      const inputs = payload?.inputBatch ?? [payload?.inputs];
      const inPlanOrder = inputs.length === fixture.cases.length &&
        fixture.cases.every((row, i) => matchesInput(row, inputs[i]));
      const matches = inputs.map((input) => fixture.cases.filter((row) => matchesInput(row, input)));
      const rows = inPlanOrder ? fixture.cases.map(({ id }) => id) : matches.map(([row]) => row?.id);
      const proofRows = inPlanOrder ? rows : matches.map((found) => found.length === 1 ? found[0].id : undefined);
      const javaObserver = fixture.language === 'java' && message.type === 'execute-prepared-runtime-program-batch' &&
        typeof payload.attemptToken === 'string' && payload.attemptToken.length > 0;
      this.#trackJudgeWorker(message, payload, proofRows, javaObserver);
      if (request && rows.length && rows.every(Boolean) && /^execute/u.test(message.type)) {
        const mode = javaObserver ? 'trace' : payload.mode ?? message.type;
        const wire = { request, rows, mode, message, index: 0 };
        this.#wire.set(message.id, wire);
        record('dispatch', {
          generation: this.#generation, request, rows, mode, type: message.type,
          tier: payload.artifact?.isolationProfile?.tier, progressRequested: payload.reportCaseProgress === true,
          tracingEnabled: payload.tracingEnabled, traceEnabledBatch: payload.traceEnabledBatch,
          ...(javaObserver ? { observationOnly: true } : {}),
        });
        wire.pythonClock = pythonClock?.dispatch(wire, this.#generation);
        if (wire.pythonClock) {
          wire.fault = wire.pythonClock.route;
          super.postMessage(message, ...transfer);
          return;
        }
        const pythonPrepared = fixture.language === 'python' && message.type === 'execute-prepared-program-batch' &&
          mode === 'code';
        const pythonBatch = pythonPrepared && payload.artifact?.isolationProfile?.tier === 'algorithm-fast';
        const javaBatch = fixture.language === 'java' && !javaObserver &&
          message.type === 'execute-prepared-runtime-program-batch';
        if (serviceDeadlineRoute(fixture, request) && !injected && inPlanOrder && (pythonPrepared || javaBatch)) {
          const command = { request, generation: this.#generation, commandId: message.id };
          wire.serviceDeadline = { command };
          injected = true;
          record('deadline-release', { ...command, rows: [rows[0]], held: rows.slice(1) });
          // Keep the client and Judge's original batch. Only the worker gets
          // A, so B cannot enter before the synchronous service control.
          super.postMessage({
            ...message, payload: { ...payload, inputBatch: [inputs[0]] },
          }, ...transfer);
          return;
        }
        const javaSupported = javaBatch && (fault?.startsWith('cut-') ||
          fault?.startsWith('during-') || fault === 'timeout-fanout');
        if (fault && !injected && rows.length === 3 && (pythonBatch || javaSupported)) {
          wire.fault = fault;
          injected = true;
          wire.transfer = transfer;
          if (javaSupported) {
            wire.java = { next: 0, sliced: fault !== 'timeout-fanout' };
            this.#javaFault = wire;
            if (!wire.java.sliced) javaTimeoutWire = wire;
          }
          this.#release(wire);
          return;
        }
      }
      super.postMessage(message, ...transfer);
    }

    #trackJudgeWorker(message, payload, rows, javaObserver) {
      const cpp = fixture.language === 'cpp';
      const java = fixture.language === 'java';
      const js = ['javascript', 'typescript'].includes(fixture.language);
      if (!request) return;
      const correlated = { request, generation: this.#generation, commandId: message.id };
      const token = typeof message.protocolToken === 'string' && message.protocolToken ? message.protocolToken : undefined;
      const track = ({ ordinary, attemptToken, terminal, ses, admissionId,
        reportsStarts = payload.reportCaseProgress === true }) => {
        if (ordinary) record('ordinary-dispatch', {
          ...correlated, rows, reportsStarts: !!token && reportsStarts,
        });
        if (token) this.#judgeWire.set(message.id, {
          correlated, rows, ordinary, token, attemptToken, terminal, ses, cpp, java, admissionId,
          maxPathDepth: payload.observationOptions?.maxPathDepth,
        });
      };
      if (java) {
        if (!/^execute/u.test(message.type)) return;
        const prepared = message.type === 'execute-prepared-runtime-program-batch';
        const admissionId = Number.isSafeInteger(payload.admissionId) && payload.admissionId > 0
          ? payload.admissionId : undefined;
        track({
          ordinary: !javaObserver, attemptToken: javaObserver ? payload.attemptToken : undefined,
          terminal: prepared ? message.type : undefined, admissionId,
          reportsStarts: prepared && admissionId !== undefined,
        });
        return;
      }
      if (cpp) {
        const single = message.type === 'execute-prepared-runtime-program';
        if (!single && message.type !== 'execute-prepared-runtime-program-batch') return;
        const ordinary = payload.mode === 'code';
        const attemptToken = single && payload.mode === 'trace' ? payload.attemptToken : undefined;
        if (!ordinary && typeof attemptToken !== 'string') return;
        track({ ordinary, attemptToken, terminal: message.type });
        return;
      }
      if (js) {
        if (message.type === 'observe-execution' && typeof payload.attemptToken === 'string') {
          track({ ordinary: false, attemptToken: payload.attemptToken });
        } else if (/^execute/u.test(message.type)) {
          track({ ordinary: true, ses: message.type === 'execute-batch' });
        }
        return;
      }
      if (fixture.language !== 'python') return;
      const prepared = message.type === 'execute-prepared-program';
      const ordinary = (prepared || message.type === 'execute-prepared-program-batch') &&
        payload.mode === 'code';
      const observation = prepared && payload.mode === 'trace' && payload.artifact?.observationOnly === true;
      if (!ordinary && !observation) return;
      track({ ordinary });
    }

    terminate() {
      // SES can retire an executing case at its deadline without a reply.
      // The oracle still requires a correlated start for every row it sent.
      for (const wire of this.#judgeWire.values()) {
        if (wire.ordinary && wire.ses) record('ordinary-terminal', { ...wire.correlated, retired: true });
      }
      for (const wire of this.#wire.values()) {
        if (wire.java) wire.closed = true;
        if (wire.pythonClock) pythonClock.retire(wire.pythonClock);
        if (wire.serviceDeadline) wire.serviceDeadline.closed = true;
      }
      this.#judgeWire.clear();
      super.terminate();
    }

    #readJudgeWorker(event) {
      const { id, type, payload, protocolToken } = event.data ?? {};
      const wire = this.#judgeWire.get(id);
      if (!wire || !event.isTrusted) return;
      // SES keeps the existing terminal envelope for its client. Each start
      // still carries the command token. The terminal closes that worker/id.
      const sesTerminal = wire.ses && type === undefined && protocolToken === undefined &&
        typeof event.data.ok === 'boolean';
      if (protocolToken !== wire.token && !sesTerminal) return;
      if (wire.ordinary && !wire.java && type === 'batch-case-progress' && payload?.phase === 'started') {
        record('ordinary-start', { ...wire.correlated, caseId: wire.rows[payload.index], index: payload.index });
      }
      if (wire.ordinary && type === 'runtime-progress' && payload?.stage === 'ordinary-case-started') {
        const { caseIndex: index, admissionId } = payload.detail ?? {};
        if (wire.java && (wire.admissionId === undefined || wire.admissionId !== admissionId ||
            !Number.isSafeInteger(index) || !wire.rows[index])) return;
        record('ordinary-start', { ...wire.correlated, caseId: wire.rows[index], index });
        if (wire.cpp && fixture.gate === 'G4') record('worker-started', {
          ...wire.correlated, caseId: wire.rows[index], index, mode: 'code',
        });
      }
      const terminal = wire.terminal ?? 'execute-result';
      const completed = type === terminal || (wire.ses && type === undefined && event.data.ok === true);
      if (!completed && type !== 'error' && !(wire.ses && event.data.ok === false)) return;
      this.#judgeWire.delete(id);
      if (wire.ordinary && completed) {
        // Untokened SES terminal envelopes can close the command, but
        // cannot attest anything about the set of cases that started.
        const startedCaseIndices = payload?.startedCaseIndexes ?? payload?.startedCaseIndices;
        record('ordinary-terminal', {
          ...wire.correlated,
          ...(protocolToken === wire.token && Array.isArray(startedCaseIndices)
            ? { startedCaseIndices: [...startedCaseIndices] } : {}),
        });
      }
      if (wire.java && !wire.ordinary) {
        if (completed && wire.rows.length === 1 && Array.isArray(payload?.results) &&
            payload.results.length === 1 && payload.results[0]?.observation?.attemptToken === wire.attemptToken &&
            decodeJavaObservation) {
          record('observer-reply', {
            ...wire.correlated, caseId: wire.rows[0], attemptToken: wire.attemptToken,
            ...decodeJavaObservation(payload, wire.maxPathDepth),
          });
        }
        return;
      }
      if (wire.cpp && payload?.observation?.attemptToken !== wire.attemptToken) return;
      if (!wire.ordinary && completed && (wire.cpp || wire.attemptToken === undefined || payload?.attemptToken === wire.attemptToken)) {
        record('observer-reply', {
          ...wire.correlated,
          caseId: wire.rows[0],
          ...(wire.attemptToken === undefined ? {} : { attemptToken: wire.attemptToken }),
          ...(wire.attemptToken === undefined || wire.cpp ? {} : {
            drawing: payload.drawing,
            ...(payload.recorderDisabled === true ? { recorderDisabled: true } : {}),
          }),
          recorder: payload?.observation,
          schemaVersion: payload?.trace?.schemaVersion,
          events: payload && recorderEvents(payload),
        });
      }
    }

    #release(wire) {
      const { message, index } = wire;
      if (wire.java) {
        const rows = wire.java.sliced ? [wire.rows[index]] : wire.rows;
        record('java-release', {
          request: wire.request, generation: this.#generation, commandId: message.id, rows,
          admissionId: message.payload.admissionId,
        });
        if (!wire.java.sliced) {
          super.postMessage(message, ...wire.transfer);
          return;
        }
      }
      record('release-row', { request: wire.request, generation: this.#generation, caseId: wire.rows[index] });
      // Python's stopping transport already has a worker-side progress
      // reporter. Ask it for an ACK, and forward only to a client that asked.
      const progress = fixture.language === 'python'
        ? { stopAtFirstRunaway: true, reportCaseProgress: true }
        : {};
      super.postMessage({
        ...message,
        payload: { ...message.payload, ...progress, inputBatch: [message.payload.inputBatch[index]] },
      }, ...wire.transfer);
    }

    #lose(wire) {
      fault = undefined;
      if (javaTimeoutWire === wire) javaTimeoutWire = undefined;
      record('injection', {
        request: wire.request, generation: this.#generation, fault: wire.fault,
        ...(wire.java ? { commandId: wire.message.id, admissionId: wire.message.payload.admissionId } : {}),
      });
      this.terminate();
      this.dispatchEvent(new ErrorEvent('error', { message: 'G4 test transport ended the worker after its progress witness' }));
    }

    #readJavaFault(event, wire) {
      const { id, type, payload, protocolToken } = event.data;
      const progress = javaCaseProgress(type, payload);
      const terminal = type === wire.message.type || type === 'error';
      if (!progress && !terminal) return;
      event.stopImmediatePropagation();
      const command = this.#judgeWire.get(id);
      if (wire.closed || !event.isTrusted || !command || command.token !== protocolToken) return;
      const { java } = wire;
      const correlated = { ...command.correlated, admissionId: command.admissionId };
      if (progress) {
        const { admissionId, caseIndex, result } = payload.detail ?? {};
        if (command.admissionId === undefined || command.admissionId !== admissionId ||
            !Number.isSafeInteger(caseIndex) || caseIndex < 0 ||
            (java.sliced && caseIndex !== 0)) return;
        const index = java.sliced ? wire.index : caseIndex;
        if (index !== java.next || !wire.rows[index]) return;
        const started = payload.stage === 'ordinary-case-started';
        if (started ? java.running !== undefined : java.running !== index || typeof result?.success !== 'boolean') return;
        const witness = { ...correlated, caseId: wire.rows[index], index };
        if (started) {
          java.running = index;
        } else {
          java.running = undefined;
          java.next++;
        }
        record(started ? 'ordinary-start' : 'ordinary-finish', started ? witness : { ...witness, result });
        this.#forwardingProgress = true;
        try {
          // Only the slice-local index changes. Preserve the real message and result.
          this.dispatchEvent(new MessageEvent('message', {
            data: index === caseIndex ? event.data : {
              ...event.data, payload: { ...payload, detail: { ...payload.detail, caseIndex: index } },
            },
          }));
        } finally {
          this.#forwardingProgress = false;
        }
        record('forwarded-progress', { ...witness, phase: started ? 'started' : 'finished' });
        if ((!started && wire.fault.startsWith('cut-')) ||
            (started && index === 1 && wire.fault.startsWith('during-'))) this.#lose(wire);
        return;
      }

      record('worker-reply', { ...correlated, rows: wire.rows, type, payload });
      if (type === 'error' || payload?.success !== true) {
        record('test-transport-failure', { ...correlated, payload });
        this.#lose(wire);
      } else if (!java.sliced) {
        record('injection', { ...correlated, fault: wire.fault });
        fault = undefined;
        expire(Infinity);
      } else if (wire.fault.startsWith('during-') &&
          java.next === 1 && java.running === undefined && payload.resultsStreamed === 1) {
        wire.index++;
        this.#release(wire);
      } else {
        // Historic workers have a terminal witness but no stream to forward.
        record('subbatch-reply', { ...correlated, caseId: wire.rows[wire.index], payload });
        this.#lose(wire);
      }
    }

    #readServiceDeadline(event, wire) {
      const { id, type, payload, protocolToken } = event.data;
      const state = wire.serviceDeadline;
      const java = fixture.language === 'java';
      const progress = java ? javaCaseProgress(type, payload) : type === 'batch-case-progress';
      const terminal = type === wire.message.type || type === 'execute-result' || type === 'error';
      if (!progress && !terminal) return;
      const command = this.#judgeWire.get(id);
      if (state.closed || !event.isTrusted || !command || command.token !== protocolToken) {
        event.stopImmediatePropagation();
        return;
      }
      if (!progress) {
        // Legacy pins have no service control. Let the real singleton terminal
        // settle that request, then report the route as unwitnessed.
        record('deadline-terminal', { ...state.command, held: state.sealed === true });
        if (state.sealed) event.stopImmediatePropagation();
        state.closed = true;
        return;
      }
      event.stopImmediatePropagation();
      const detail = java ? payload.detail : payload;
      const phase = java ? payload.stage.slice('ordinary-case-'.length) : payload?.phase;
      const index = java ? detail?.caseIndex : detail?.index;
      if (index !== 0 || (java && (command.admissionId === undefined || detail.admissionId !== command.admissionId)) ||
          (phase === 'started' ? state.started : phase !== 'finished' || !state.started ||
            state.finished || typeof detail.result?.success !== 'boolean')) return;
      state.started = true;
      state.finished = phase === 'finished';
      const delivery = { ...state.command, caseId: wire.rows[0], index };
      record(state.finished ? 'deadline-worker-finish' : 'deadline-worker-start',
        state.finished ? { ...delivery, result: detail.result } : delivery);
      if (state.finished) serviceFinish = { delivery, state };
      this.#forwardingProgress = true;
      try {
        this.dispatchEvent(new MessageEvent('message', { data: event.data }));
      } finally {
        this.#forwardingProgress = false;
        serviceFinish = undefined;
      }
    }

    #read(event) {
      if (this.#forwardingProgress) return;
      const { id, type, payload } = event.data ?? {};
      const wire = this.#wire.get(id);
      if (wire?.serviceDeadline) {
        this.#readServiceDeadline(event, wire);
        return;
      }
      if (wire?.pythonClock) {
        pythonClock.receive(wire.pythonClock, event, (data) => {
          this.#forwardingProgress = true;
          try {
            this.dispatchEvent(new MessageEvent('message', { data }));
          } finally {
            this.#forwardingProgress = false;
          }
        }, () => this.#lose(wire));
        return;
      }
      if (wire?.java) {
        this.#readJavaFault(event, wire);
        return;
      }
      if (this.#javaFault && !wire && javaCaseProgress(type, payload)) {
        event.stopImmediatePropagation();
        return;
      }
      this.#readJudgeWorker(event);
      if (!wire) return;
      if (type === 'batch-case-progress') {
        const index = wire.fault ? wire.index : payload.index;
        record('worker-' + payload.phase, {
          request: wire.request, generation: this.#generation, caseId: wire.rows[index], mode: wire.mode,
          detail: payload.result,
        });
        if (!wire.fault) return;
        event.stopImmediatePropagation();
        if (wire.message.payload.reportCaseProgress === true) {
          this.#forwardingProgress = true;
          try {
            this.dispatchEvent(new MessageEvent('message', {
              data: { ...event.data, payload: { ...payload, index } },
            }));
          } finally {
            this.#forwardingProgress = false;
          }
          record('forwarded-progress', { request: wire.request, generation: this.#generation, caseId: wire.rows[index], phase: payload.phase });
        }
        if (index === 1 && payload.phase === 'started' && wire.fault.startsWith('during-')) {
          this.#lose(wire);
        }
        return;
      }

      const terminal = type === 'execute-result' || type === wire.message.type || type === 'error';
      if (!terminal) return;
      record('worker-reply', { request: wire.request, generation: this.#generation, rows: wire.rows, type, payload });
      if (!wire.fault) {
        this.#wire.delete(id);
        return;
      }
      event.stopImmediatePropagation();
      if (type === 'error' || payload?.success === false || payload?.algorithmFastBatchUnavailable === true) {
        record('test-transport-failure', { request: wire.request, generation: this.#generation, payload });
        this.#lose(wire);
        return;
      }
      record('subbatch-reply', { request: wire.request, generation: this.#generation, caseId: wire.rows[wire.index], payload });
      if (wire.fault.startsWith('cut-')) {
        this.#lose(wire);
        return;
      }
      if (wire.fault.startsWith('during-')) {
        wire.index += 1;
        this.#release(wire);
        return;
      }
    }
  };

  return {
    record(kind, fields) {
      record(kind, { ...fields, request });
      if (!serviceFinish) return;
      if (kind === 'service-deadline-offer') serviceFinish.state.offer = fields;
      const offer = serviceFinish.state.offer;
      if (offer && kind === 'schedule' && fields.phase === 'service-deadline' && fields.cause === 'injected' &&
          (fields.language === undefined || fields.language === offer.language) &&
          ['evaluationId', 'workspaceDigest', 'generation', 'dispatchGeneration']
            .every((key) => fields[key] === offer[key])) {
        serviceFinish.state.sealed = true;
      }
    },
    serviceFinish() {
      return serviceFinish?.delivery;
    },
    track(route, injectedFault) {
      request = route;
      fault = injectedFault;
      injected = false;
      pythonClock?.track(injectedFault);
    },
    since(index) {
      return journal.slice(index);
    },
    size() {
      return journal.length;
    },
    restore() {
      globalThis.Worker = NativeWorker;
      globalThis.setTimeout = nativeSetTimeout;
      globalThis.clearTimeout = nativeClearTimeout;
      pythonClock?.restore();
    },
  };
}

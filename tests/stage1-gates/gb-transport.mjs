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

// The browser page owns this transport. The installed Judge and worker files
// remain untouched. A real worker runs each released row. The transport holds
// the terminal batch response, leaving the production client to handle loss.
export function installJournal(fixture) {
  const NativeWorker = globalThis.Worker;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const journal = [];
  let generation = 0;
  let request;
  let fault;
  let injected = false;
  const scheduled = new Map();
  let virtualTime = 0;
  const linger = new Set();

  function record(kind, fields) {
    journal.push({ sequence: journal.length + 1, kind, ...fields });
  }

  function identify(input) {
    if (!input || typeof input !== 'object') return undefined;
    return fixture.cases.find((row) =>
      Object.keys(row.input).length === Object.keys(input).length &&
      Object.entries(row.input).every(([key, value]) => JSON.stringify(value) === JSON.stringify(input[key]))
    )?.id;
  }

  function deadlineMatches(ms) {
    if (!fault) return false;
    if (fault === 'timeout-fanout' && fixture.language === 'java') return ms === 132000;
    if (fault === 'timeout-fanout') return ms === 17300;
    return fault === 'clock-virtual' && ms === 30000;
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
    if (typeof handler !== 'function' || !deadlineMatches(ms)) {
      return nativeSetTimeout(handler, ms, ...args);
    }
    const token = nativeSetTimeout(() => {
      scheduled.delete(token);
      handler(...args);
    }, ms);
    scheduled.set(token, { ms, due: virtualTime + ms, run: () => handler(...args) });
    return token;
  };
  globalThis.clearTimeout = function (token) {
    scheduled.delete(token);
    nativeClearTimeout(token);
  };

  globalThis.Worker = class JournalWorker extends NativeWorker {
    #generation = ++generation;
    #wire = new Map();
    #judgeWire = new Map();
    #forwardingProgress = false;

    constructor(url, options) {
      super(url, options);
      record('worker', { generation: this.#generation, url: String(url), request });
      this.addEventListener('message', (event) => this.#read(event));
    }

    postMessage(message, ...transfer) {
      const payload = message?.payload ?? message;
      const rows = (payload?.inputBatch ?? [payload?.inputs]).map(identify);
      this.#trackJudgeWorker(message, payload, rows);
      if (request && rows.length && rows.every(Boolean) && /^execute/u.test(message.type)) {
        const mode = payload.mode ?? message.type;
        const wire = { request, rows, mode, message, index: 0 };
        this.#wire.set(message.id, wire);
        record('dispatch', {
          generation: this.#generation, request, rows, mode, type: message.type,
          tier: payload.artifact?.isolationProfile?.tier, progressRequested: payload.reportCaseProgress === true,
          tracingEnabled: payload.tracingEnabled, traceEnabledBatch: payload.traceEnabledBatch,
        });
        const pythonBatch = fixture.language === 'python' && message.type === 'execute-prepared-program-batch' &&
          mode === 'code' && payload.artifact?.isolationProfile?.tier === 'algorithm-fast';
        const javaBatch = fixture.language === 'java' && message.type === 'execute-prepared-runtime-program-batch';
        const javaSupported = fault?.startsWith('cut-') || fault === 'timeout-fanout';
        if (fault && !injected && rows.length === 3 && (pythonBatch || (javaBatch && javaSupported))) {
          wire.fault = fault;
          injected = true;
          wire.transfer = transfer;
          this.#release(wire);
          return;
        }
      }
      super.postMessage(message, ...transfer);
    }

    #trackJudgeWorker(message, payload, rows) {
      const cpp = fixture.language === 'cpp';
      if ((!cpp && fixture.gate !== 'G5') || !request || typeof message.protocolToken !== 'string' ||
          !message.protocolToken) return;
      const correlated = { request, generation: this.#generation, commandId: message.id };
      if (cpp) {
        const single = message.type === 'execute-prepared-runtime-program';
        if (!single && message.type !== 'execute-prepared-runtime-program-batch') return;
        const ordinary = payload.mode === 'code';
        const attemptToken = single && payload.mode === 'trace' ? payload.attemptToken : undefined;
        if (!ordinary && typeof attemptToken !== 'string') return;
        this.#judgeWire.set(message.id, {
          correlated, rows, ordinary, token: message.protocolToken, attemptToken,
          terminal: message.type, cpp: true,
        });
        if (ordinary && fixture.gate === 'G5') {
          record('ordinary-dispatch', { ...correlated, rows, reportsStarts: payload.reportCaseProgress === true });
        }
        return;
      }
      if (['javascript', 'typescript'].includes(fixture.language) && message.type === 'observe-execution' &&
          typeof payload.attemptToken === 'string') {
        this.#judgeWire.set(message.id, {
          correlated, rows, token: message.protocolToken, attemptToken: payload.attemptToken,
        });
        return;
      }
      if (fixture.language !== 'python') return;
      const prepared = message.type === 'execute-prepared-program';
      const ordinary = (prepared || message.type === 'execute-prepared-program-batch') &&
        payload.mode === 'code';
      const observation = prepared && payload.mode === 'trace' && payload.artifact?.observationOnly === true;
      if (!ordinary && !observation) return;
      this.#judgeWire.set(message.id, { correlated, rows, ordinary, token: message.protocolToken });
      if (ordinary) {
        record('ordinary-dispatch', { ...correlated, rows, reportsStarts: payload.reportCaseProgress === true });
      }
    }

    #readJudgeWorker(event) {
      const { id, type, payload, protocolToken } = event.data ?? {};
      const wire = this.#judgeWire.get(id);
      if (!wire || !event.isTrusted || protocolToken !== wire.token) return;
      if (wire.ordinary && type === 'batch-case-progress' && payload?.phase === 'started') {
        record('ordinary-start', { ...wire.correlated, caseId: wire.rows[payload.index], index: payload.index });
      }
      if (wire.cpp && wire.ordinary && type === 'runtime-progress' && payload?.stage === 'ordinary-case-started') {
        const index = payload.detail?.caseIndex;
        record(fixture.gate === 'G4' ? 'worker-started' : 'ordinary-start', {
          ...wire.correlated, caseId: wire.rows[index], index, mode: 'code',
        });
      }
      const terminal = wire.terminal ?? 'execute-result';
      if (type !== terminal && type !== 'error') return;
      this.#judgeWire.delete(id);
      if (wire.cpp && payload?.observation?.attemptToken !== wire.attemptToken) return;
      if (!wire.ordinary && type === terminal) {
        record('observer-reply', {
          ...wire.correlated,
          caseId: wire.rows[0],
          ...(wire.attemptToken === undefined ? {} : { attemptToken: wire.attemptToken }),
          ...(wire.attemptToken === undefined || wire.cpp ? {} : {
            drawing: payload?.attemptToken === wire.attemptToken ? payload.drawing : null,
          }),
          recorder: payload?.observation,
          schemaVersion: payload?.trace?.schemaVersion,
          events: payload && recorderEvents(payload),
        });
      }
    }

    #release(wire) {
      const { message, index } = wire;
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
      record('injection', { request: wire.request, generation: this.#generation, fault: wire.fault });
      this.terminate();
      this.dispatchEvent(new ErrorEvent('error', { message: 'G4 test transport ended the worker after its progress witness' }));
    }

    #read(event) {
      if (this.#forwardingProgress) return;
      this.#readJudgeWorker(event);
      const { id, type, payload } = event.data ?? {};
      const wire = this.#wire.get(id);
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
      if (wire.fault === 'timeout-fanout') {
        record('injection', { request: wire.request, generation: this.#generation, fault: wire.fault });
        fault = undefined;
        expire(Infinity);
        return;
      }
      if (wire.fault.startsWith('during-')) {
        wire.index += 1;
        this.#release(wire);
        return;
      }
      if (wire.fault === 'clock-virtual' || wire.fault === 'clock-real') {
        if (wire.fault === 'clock-real' && wire.index === 2) {
          record('injection', { request: wire.request, generation: this.#generation, fault: wire.fault });
          record('held-terminal', { request: wire.request, generation: this.#generation, due: 33000 });
        }
        const advance = () => {
          virtualTime += 11000;
          record('advance-clock', { request: wire.request, generation: this.#generation, caseId: wire.rows[wire.index], virtualTime });
          wire.index += 1;
          if (wire.index < wire.rows.length) {
            this.#release(wire);
            return;
          }
          record('injection', { request: wire.request, generation: this.#generation, fault: wire.fault });
          expire(virtualTime);
        };
        if (wire.fault === 'clock-virtual') {
          advance();
        } else {
          const timer = nativeSetTimeout(() => {
            linger.delete(timer);
            advance();
          }, 11000);
          linger.add(timer);
        }
      }
    }
  };

  return {
    record(kind, fields) {
      record(kind, { ...fields, request });
    },
    track(route, injectedFault) {
      request = route;
      fault = injectedFault;
      injected = false;
      virtualTime = 0;
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
      for (const timer of linger) nativeClearTimeout(timer);
    },
  };
}

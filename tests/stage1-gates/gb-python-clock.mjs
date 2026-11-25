const caseHeadroom = 1000;
const caseAdvance = 11000;

export function pythonClockRoute(route) {
  return route === 'timeout-fanout' || route === 'clock-virtual' || route === 'clock-real';
}

// Interpose on the client clock only while delivering an authenticated start.
// Native batches and terminal envelopes still come from the installed worker.
export function createPythonClock({ record, nativeSetTimeout, nativeClearTimeout }) {
  const timers = new Map();
  const delays = new Map();
  let route;
  let activeStart;
  let virtualTime = 0;

  function fire(token) {
    const timer = timers.get(token);
    if (!timer) return;
    timers.delete(token);
    nativeClearTimeout(token);
    timer.batch.closed = true;
    record('python-case-timer-fired', timer.evidence);
    timer.run();
  }

  function advance(batch, evidence) {
    virtualTime += caseAdvance;
    record('advance-clock', { ...evidence, virtualTime, delta: caseAdvance });
    if (batch.route !== 'clock-virtual') return;
    for (const [token, timer] of timers) {
      if (timer.batch === batch && timer.due <= virtualTime) fire(token);
    }
  }

  function drain(batch, forward, lose) {
    while (!batch.closed && !batch.waiting && batch.pending.length) {
      const data = batch.pending.shift();
      if (data.type !== 'batch-case-progress') {
        batch.closed = true;
        record('python-clock-terminal', {
          ...batch.command, type: data.type, resultsStreamed: data.payload?.resultsStreamed,
          hasResults: Array.isArray(data.payload?.results),
        });
        if (batch.route.startsWith('clock-')) record('injection', { ...batch.command, fault: batch.route });
        forward(data);
        continue;
      }
      const { index, phase, result } = data.payload;
      const started = phase === 'started';
      if (!Number.isSafeInteger(index) || !batch.rows[index] || index !== batch.finished ||
          (started ? batch.running !== undefined
            : phase !== 'finished' || batch.running !== index || typeof result?.success !== 'boolean')) continue;
      const evidence = { ...batch.command, index, caseId: batch.rows[index] };
      if (!started) {
        batch.running = undefined;
        batch.finished++;
        record('python-clock-finish', { ...evidence, result });
        forward(data);
        continue;
      }

      batch.running = index;
      record('python-clock-start', evidence);
      const start = { batch, evidence };
      activeStart = start;
      try {
        forward(data);
      } finally {
        activeStart = undefined;
      }
      if (batch.route === 'timeout-fanout' && evidence.caseId === 'B' && batch.initial) {
        const armed = [...timers].filter(([, timer]) => timer.start === start);
        if (armed.length === 1) {
          record('injection', { ...evidence, fault: batch.route });
          fire(armed[0][0]);
        } else {
          record('test-transport-failure', { ...evidence, reason: 'Expected one production case timer for B' });
          lose();
        }
      } else if (batch.route === 'clock-virtual') {
        advance(batch, evidence);
      } else if (batch.route === 'clock-real') {
        batch.waiting = true;
        const token = nativeSetTimeout(() => {
          delays.delete(batch);
          if (batch.closed) return;
          advance(batch, evidence);
          batch.waiting = false;
          drain(batch, forward, lose);
        }, caseAdvance);
        delays.set(batch, token);
      }
    }
  }

  return {
    track(fault) {
      route = pythonClockRoute(fault) ? fault : undefined;
      virtualTime = 0;
    },
    dispatch(wire, generation) {
      if (!route || wire.message.type !== 'execute-prepared-program-batch' || wire.mode !== 'code') return;
      const { id: commandId, protocolToken, payload } = wire.message;
      const batch = {
        route, protocolToken, rows: wire.rows, initial: wire.rows.length === 3,
        command: { request: wire.request, generation, commandId },
        expectedDelay: payload.limits?.wallClockMs + caseHeadroom,
        pending: [], finished: 0,
      };
      record('python-clock-command', {
        ...batch.command, rows: batch.rows, reportsProgress: payload.reportCaseProgress === true,
        ...(Number.isSafeInteger(batch.expectedDelay) ? { expectedDelay: batch.expectedDelay } : {}),
      });
      return batch;
    },
    receive(batch, event, forward, lose) {
      const { type, payload, protocolToken } = event.data;
      if (type !== 'batch-case-progress' && type !== 'execute-result' && type !== 'error') return;
      event.stopImmediatePropagation();
      if (batch.closed || !event.isTrusted || !batch.protocolToken || protocolToken !== batch.protocolToken ||
          (type === 'batch-case-progress' && !payload)) return;
      batch.pending.push(event.data);
      drain(batch, forward, lose);
    },
    arm(handler, ms, args) {
      const start = activeStart;
      if (!start || typeof handler !== 'function' || ms !== start.batch.expectedDelay) return;
      const { batch } = start;
      // A virtual advance can fire the same callback early. The real timer is
      // still a backstop if the worker stops answering.
      const token = nativeSetTimeout(() => fire(token), ms);
      const evidence = { ...start.evidence, delay: ms };
      timers.set(token, { start, batch, evidence, due: virtualTime + ms, run: () => handler(...args) });
      record('python-case-timer-armed', evidence);
      return token;
    },
    clear(token) {
      const timer = timers.get(token);
      if (!timer) return false;
      timers.delete(token);
      nativeClearTimeout(token);
      record('python-case-timer-cleared', timer.evidence);
      return true;
    },
    retire(batch) {
      if (batch.retired) return;
      batch.retired = true;
      batch.closed = true;
      batch.pending.length = 0;
      nativeClearTimeout(delays.get(batch));
      delays.delete(batch);
      record('python-clock-worker-retired', batch.command);
    },
    restore() {
      for (const token of timers.keys()) nativeClearTimeout(token);
      for (const token of delays.values()) nativeClearTimeout(token);
    },
  };
}

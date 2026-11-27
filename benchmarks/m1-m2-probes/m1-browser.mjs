import { probeHost, probeProvider, compareJudgeValues } from 'probe-judge';

export async function measureHostControls() {
  const url = URL.createObjectURL(new Blob(['onmessage = () => postMessage(null)'], { type: 'text/javascript' }));
  const worker = new Worker(url);
  try {
    const ping = () => new Promise((resolve) => {
      worker.addEventListener('message', resolve, { once: true });
      worker.postMessage(null);
    });
    await ping();
    const echoRoundTripMs = [];
    const timerArmCancelMs = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      await ping();
      echoRoundTripMs.push(performance.now() - start);
      const timerStart = performance.now();
      for (let j = 0; j < 1_000; j++) clearTimeout(setTimeout(() => {}, 60_000));
      timerArmCancelMs.push((performance.now() - timerStart) / 1_000);
    }
    return { echoRoundTripMs, timerArmCancelMs };
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}

export function openM1(language) {
  if (crossOriginIsolated) throw new Error('The rig uses a non-isolated document');
  const host = probeHost({ assetBaseUrl: '/workers', providers: [language] });
  const transport = [];
  const workerIds = new WeakMap();
  const post = Worker.prototype.postMessage;
  let observe = false;
  Worker.prototype.postMessage = function (message, ...args) {
    if (observe && typeof message?.type === 'string') {
      if (!workerIds.has(this)) workerIds.set(this, transport.length);
      transport.push({ type: message.type, worker: workerIds.get(this) });
    }
    return post.call(this, message, ...args);
  };
  let program;
  let fixture;
  return {
    async prepare(next) {
      if (program) {
        await program.dispose();
        program = undefined;
      }
      fixture = next;
      const ready = await host.warmLanguage(language);
      if (!ready.success) throw new Error('Could not warm ' + language);
      const prepared = await probeProvider(host, language).prepareProgram({
        mode: 'code', code: next.code, functionName: next.functionName,
        executionStyle: next.executionStyle,
      });
      if (prepared.kind !== 'prepared') {
        return { kind: prepared.kind, error: prepared.error };
      }
      program = prepared.program;
      if (typeof program.executeBatchIsolated !== 'function') throw new Error('No prepared batch');
      return { kind: prepared.kind, capabilities: program.capabilities };
    },
    async pair(first, sample = false, traceTransport = false) {
      const rows = {};
      const makeVerdicts = (outputs) => outputs.map((outcome, index) => ({
        kind: outcome.kind,
        passed: outcome.kind === 'completed' &&
          compareJudgeValues(outcome.output, fixture.cases[index].expected),
        ...(outcome.kind === 'limit' && { reason: outcome.reason }),
      }));
      for (const arm of [first, first === 'batch' ? 'singleton' : 'batch']) {
        const inputs = fixture.cases.map((entry) => structuredClone(entry.input));
        const limits = language === 'java'
          ? { wallClockMs: 60_000, ...fixture.limits } : fixture.limits;
        transport.length = 0;
        observe = traceTransport;
        const started = sample ? performance.now() : undefined;
        try {
          let outputs;
          if (arm === 'batch') {
            outputs = await program.executeBatchIsolated({ inputBatch: inputs, limits });
          } else {
            outputs = [];
            for (const input of inputs) outputs.push(await program.executeIsolated({ inputs: input, limits }));
          }
          const verdicts = makeVerdicts(outputs);
          const elapsedMs = sample ? performance.now() - started : undefined;
          rows[arm] = {
            verdicts, passed: verdicts.length === inputs.length && verdicts.every((row) => row.passed),
            ...(sample && {
              elapsedMs,
              combinedSetup: outputs.map(({ timings }) => ({
                ...(Number.isFinite(timings?.classLoadMs) && { classLoadMs: timings.classLoadMs }),
                ...(language === 'csharp' && Number.isFinite(timings?.hostCallMs) && {
                  managedCallMs: timings.hostCallMs,
                }),
              })),
            }),
          };
        } catch (error) {
          rows[arm] = { passed: false, error: error.name, message: error.message };
        } finally {
          observe = false;
          if (traceTransport) rows[arm].transport = [...transport];
        }
      }
      return {
        ...rows,
        pass: rows.batch.passed && rows.singleton.passed &&
          JSON.stringify(rows.batch.verdicts) === JSON.stringify(rows.singleton.verdicts),
      };
    },
    async prime() {
      return (await program.executeIsolated({
        inputs: structuredClone(fixture.cases[0].input),
        limits: fixture.limits,
      })).kind;
    },
  };
}

// Continued Python drawings on a retained observer, through the public
// BrowserJudgeHost in a real Pyodide worker. Each program's later drawings
// are compared with a fresh observer's drawing of the same case.
import { createAlgorithmJudgeBundle, createBrowserJudgeHost } from '../../src/judge';
import { PROGRAMS, type Program } from './python-retained-observer-programs';

/** One observer execution the page's workers received. */
export interface ObserverDispatch {
  readonly worker: number;
  readonly tier: string;
  readonly code: string;
}

export interface DrawingSample {
  readonly caseId: string;
  /** The drawing without its binding (evaluation id, generation). */
  readonly drawing: string;
  /** Observer executions this drawing dispatched. */
  readonly dispatches: readonly ObserverDispatch[];
  /** Observer executions the dispatching worker had received before. */
  readonly priorOnWorker: number;
}

export interface ProgramSample {
  readonly program: string;
  readonly retained: readonly DrawingSample[];
  readonly fresh: readonly DrawingSample[];
  readonly error?: string;
}

export interface SensitivitySample {
  /** Two drawings of one case on one interpreter, under each tier label. */
  readonly asClassified: readonly [string, string];
  readonly forcedFast: readonly [string, string];
  readonly classifiedTier: string;
  readonly error?: string;
}

const dispatches: ObserverDispatch[] = [];
let workerCount = 0;

// Every Worker the page creates records each observer execution it is sent.
function installObserverWitness(): void {
  const NativeWorker = globalThis.Worker as unknown as { new (url: string | URL, options?: WorkerOptions): Worker };
  if ((NativeWorker as unknown as { tracecodeWitness?: boolean }).tracecodeWitness) return;
  class WitnessedWorker extends NativeWorker {
    static tracecodeWitness = true;
    readonly witnessId = workerCount++;
    override postMessage(message: any, transfer?: any): void {
      const artifact = message?.type === 'execute-prepared-program' ? message.payload?.artifact : undefined;
      if (artifact?.observationOnly === true) {
        dispatches.push({ worker: this.witnessId, tier: artifact.isolationProfile?.tier, code: artifact.code });
      }
      if (transfer === undefined) super.postMessage(message);
      else super.postMessage(message, transfer);
    }
  }
  (globalThis as any).Worker = WitnessedWorker;
}

let sequence = 0;

async function bundleFor(name: string, program: Program) {
  sequence += 1;
  return createAlgorithmJudgeBundle({
    id: `python-retained-observer-${name}-${sequence}`,
    language: 'python',
    code: program.code,
    functionName: program.functionName,
    executionStyle: program.executionStyle,
    trace: true,
    ...(program.traceOptions ? { traceOptions: program.traceOptions } : {}),
    // The verdict is not under test; the drawing is.
    cases: program.inputs.map((input, index) => ({ id: String(index + 1), input, expected: null })),
  } as never);
}

function drawingOf(evaluation: any, caseId: string): string {
  const row = (evaluation?.cases ?? []).find((entry: any) => entry.caseId === caseId);
  if (!row) throw new Error(`no row for case ${caseId}: ${JSON.stringify(evaluation).slice(0, 400)}`);
  const attachment = row.attachment;
  if (!attachment) throw new Error(`case ${caseId} has no attachment: ${JSON.stringify(row).slice(0, 400)}`);
  const { status, reason, attemptedEvents, trace } = attachment;
  return JSON.stringify({ status, reason, attemptedEvents, trace });
}

async function sample(caseId: string, draw: () => Promise<any>, programCode: string): Promise<DrawingSample> {
  const before = dispatches.length;
  const evaluation = await draw();
  const mine = dispatches.slice(before).filter((entry) => entry.code === programCode);
  const worker = mine[0]?.worker;
  const priorOnWorker = worker === undefined
    ? -1
    : dispatches.slice(0, before).filter((entry) => entry.worker === worker).length;
  return { caseId, drawing: drawingOf(evaluation, caseId), dispatches: mine, priorOnWorker };
}

export async function runRetainedObserver(options: {
  readonly assetBaseUrl: string;
  readonly programs: readonly string[];
}): Promise<ProgramSample[]> {
  installObserverWitness();
  // One host draws continuations on its retained observer; the other draws
  // each case first, on a fresh observer.
  const retainedHost = createBrowserJudgeHost({ assetBaseUrl: options.assetBaseUrl, providers: ['python'] });
  const freshHost = createBrowserJudgeHost({ assetBaseUrl: options.assetBaseUrl, providers: ['python'] });
  const samples: ProgramSample[] = [];
  try {
    for (const name of options.programs) {
      const program = PROGRAMS[name];
      const retained: DrawingSample[] = [];
      const fresh: DrawingSample[] = [];
      try {
        const caseIds = program.inputs.map((_, index) => String(index + 1));
        const bundle = await bundleFor(name, program);
        let executionId: string | undefined;
        try {
          retained.push(await sample(caseIds[0], async () => {
            const initial = await retainedHost.execute({ bundle, interactive: true, tracing: { caseIds: [caseIds[0]] } });
            executionId = initial.executionId;
            return initial.evaluation;
          }, program.code));
          if (!executionId) throw new Error('the interactive Run retained no execution');
          for (const caseId of caseIds.slice(1)) {
            retained.push(await sample(caseId, async () => (
              await retainedHost.execute({ executionId: executionId!, tracing: { caseIds: [caseId] } })
            ).evaluation, program.code));
          }
        } finally {
          if (executionId) await retainedHost.disposeExecution(executionId);
        }
        for (const caseId of caseIds) {
          const freshBundle = await bundleFor(name, program);
          fresh.push(await sample(caseId, async () => {
            const executed = await freshHost.execute({ bundle: freshBundle, interactive: true, tracing: { caseIds: [caseId] } });
            try {
              return executed.evaluation;
            } finally {
              if (executed.executionId) await freshHost.disposeExecution(executed.executionId);
            }
          }, program.code));
        }
        samples.push({ program: name, retained, fresh });
      } catch (error) {
        samples.push({ program: name, retained, fresh, error: error instanceof Error ? error.stack ?? error.message : String(error) });
      }
    }
  } finally {
    retainedHost.dispose();
    freshHost.dispose();
  }
  return samples;
}

/**
 * The comparison above can see a leak: on one raw worker interpreter, a
 * program that writes a module attribute draws twice. As classified (off the
 * fast tier) the compatibility scope restores the module and both drawings
 * match; with its tier forced to algorithm-fast the second drawing sees the
 * first one's write.
 */
export async function runSensitivityControl(options: { readonly workerBaseUrl: string }): Promise<SensitivitySample> {
  const base = new URL(options.workerBaseUrl, location.href).href.replace(/\/?$/, '/');
  const runtimeAssets = {
    runtimeUrl: base + 'python/python-runtime.js',
    snippetsUrl: base + 'generated-python-harness-snippets.js',
    loaderUrl: base + 'python/pyodide-0.29.3/pyodide.js',
    indexUrl: base + 'python/pyodide-0.29.3/',
    loaderFormat: 'classic-script',
  };
  const program = PROGRAMS.moduleAttributeWrite;
  const workers: Worker[] = [];
  async function client() {
    const worker = new Worker(base + 'python-worker.js');
    workers.push(worker);
    await new Promise<void>((accept, reject) => {
      worker.addEventListener('message', ({ data }) => { if (data?.type === 'worker-ready') accept(); });
      worker.addEventListener('error', (event) => reject(new Error(event.message)), { once: true });
    });
    const request = (type: string, payload: unknown) => new Promise<any>((accept, reject) => {
      const id = crypto.randomUUID();
      const protocolToken = crypto.randomUUID();
      function onMessage({ data }: MessageEvent) {
        if (data?.id !== id || data?.protocolToken !== protocolToken) return;
        if (data.type === 'batch-case-progress') return;
        worker.removeEventListener('message', onMessage);
        if (data.type === 'error') reject(new Error(data.payload?.error));
        else accept(data.payload);
      }
      worker.addEventListener('message', onMessage);
      worker.postMessage({ type, id, protocolToken, payload });
    });
    await request('init', { runtimeAssets });
    return request;
  }
  const drawTwice = async (tier?: string): Promise<[string, string]> => {
    const request = await client();
    const prepared = await request('prepare-program', {
      code: program.code,
      mode: 'trace',
      functionName: program.functionName,
      executionStyle: program.executionStyle,
      observationOnly: true,
      traceOptions: {},
    });
    if (!prepared?.success) throw new Error('prepare failed: ' + JSON.stringify(prepared).slice(0, 400));
    const artifact = tier
      ? { ...prepared.artifact, isolationProfile: { ...prepared.artifact.isolationProfile, tier } }
      : prepared.artifact;
    const draw = async () => {
      const result = await request('execute-prepared-program', { mode: 'trace', artifact, inputs: program.inputs[0] });
      return JSON.stringify({ events: result?.trace?.events, observation: result?.observation });
    };
    return [await draw(), await draw()];
  };
  try {
    const classify = await client();
    const prepared = await classify('prepare-program', {
      code: program.code, mode: 'trace', functionName: program.functionName,
      executionStyle: program.executionStyle, observationOnly: true, traceOptions: {},
    });
    return {
      classifiedTier: prepared?.artifact?.isolationProfile?.tier,
      asClassified: await drawTwice(),
      forcedFast: await drawTwice('algorithm-fast'),
    };
  } catch (error) {
    return {
      classifiedTier: '',
      asClassified: ['', ''],
      forcedFast: ['', ''],
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  } finally {
    for (const worker of workers) worker.terminate();
  }
}

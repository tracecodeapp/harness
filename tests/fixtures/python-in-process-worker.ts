/**
 * A Python "worker" that runs the shipped worker runtime
 * (workers/python/python-runtime.js) on a real Pyodide interpreter in this
 * process, behind the worker protocol the real PythonWorkerClient speaks.
 *
 * One instance is one interpreter. Like the browser worker it answers one
 * command at a time, in arrival order, and it streams a stopping batch's
 * case results as progress. The interpreter loads on the first command that
 * needs it, so a standby that is never used costs nothing.
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  PYTHON_TRACE_SERIALIZE_FUNCTION,
  toPythonLiteral,
} from '../../packages/runtime-python/src/python-harness';

const NATIVE_WHEEL = 'workers/python/tracecode_native-0.1.0-cp313-cp313-pyemscripten_2025_0_wasm32.whl';

type Runtime = Record<string, (...args: any[]) => any>;

let loadPyodide: ((options?: Record<string, unknown>) => Promise<any>) | undefined;
let runtimeSource: string | undefined;

/** One real interpreter with the worker runtime's dependencies. */
export interface PythonInterpreter {
  readonly pyodide: any;
  readonly runtime: Runtime;
  readonly deps: Record<string, unknown>;
}

export async function loadPythonInterpreter(): Promise<PythonInterpreter> {
  if (!loadPyodide || !runtimeSource) {
    const require = createRequire(join(process.cwd(), 'package.json'));
    loadPyodide = require('pyodide').loadPyodide;
    runtimeSource = await readFile(join(process.cwd(), 'workers/python/python-runtime.js'), 'utf8');
  }
  const pyodide = await loadPyodide!();
  pyodide.setStdout({ batched: () => undefined });
  pyodide.setStderr({ batched: () => undefined });
  await pyodide.loadPackage(join(process.cwd(), NATIVE_WHEEL), {
    messageCallback: () => undefined,
    errorCallback: () => undefined,
  });
  pyodide.runPython('import _tracecode_native');
  const self: Record<string, any> = {};
  vm.runInContext(runtimeSource!, vm.createContext({ console, self, globalThis: {} }), {
    filename: 'python-runtime.js',
  });
  const runtime: Runtime = self.__TRACECODE_PYODIDE_RUNTIME__;
  const deps = {
    toPythonLiteral,
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    // python-worker.js INTERVIEW_GUARD_DEFAULTS
    INTERVIEW_GUARD_DEFAULTS: {
      maxLineEvents: 4_000_000,
      maxSingleLineHits: 1_500_000,
      maxCallDepth: 2000,
      memoryCheckEvery: 200,
    },
    loadPyodideInstance: async () => {},
    getPyodide: () => pyodide,
    performanceNow: () => performance.now(),
  };
  return { pyodide, runtime, deps };
}

/** python-worker.js guestGuardOptionsFromLimits */
export function guestGuardOptions(limits: Record<string, unknown> | undefined) {
  if (!limits || typeof limits !== 'object') return undefined;
  const guard: Record<string, unknown> = {};
  let interviewGuard = false;
  for (const key of ['wallClockMs', 'maxLineEvents', 'maxSingleLineHits', 'maxCallDepth', 'maxMemoryBytes']) {
    const value = limits[key];
    if (typeof value === 'number' && Number.isFinite(value) && (key !== 'wallClockMs' || value > 0)) {
      guard[key] = value;
      interviewGuard = true;
    }
  }
  if (Object.keys(guard).length === 0) return undefined;
  if (interviewGuard) guard.interviewGuard = true;
  return guard;
}

export interface InProcessCommand {
  readonly worker: number;
  readonly type: string;
  readonly mode?: string;
  readonly observationOnly?: boolean;
}

export interface InProcessWorld {
  readonly workers: InProcessPythonWorker[];
  readonly commands: InProcessCommand[];
  /** Runs on each worker's interpreter as soon as it loads, before any command. */
  readonly prime?: (python: PythonInterpreter) => void;
  factory(): InProcessPythonWorker;
}

export function createInProcessWorld(
  options: { prime?: (python: PythonInterpreter) => void } = {}
): InProcessWorld {
  const world: InProcessWorld = {
    workers: [],
    commands: [],
    ...(options.prime ? { prime: options.prime } : {}),
    factory() {
      const worker = new InProcessPythonWorker(world, world.workers.length);
      world.workers.push(worker);
      return worker;
    },
  };
  return world;
}

export class InProcessPythonWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  private interpreter: Promise<PythonInterpreter> | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly world: InProcessWorld, readonly id: number) {
    queueMicrotask(() => this.emit({ type: 'worker-ready' }));
  }

  /** This worker's interpreter (loaded on first use). */
  python(): Promise<PythonInterpreter> {
    return this.interpreter ??= loadPythonInterpreter().then((python) => {
      this.world.prime?.(python);
      return python;
    });
  }

  postMessage(message: unknown): void {
    const { id, type, payload, protocolToken } = message as {
      id?: string;
      type?: string;
      payload?: Record<string, any>;
      protocolToken?: string;
    };
    if (!id || !protocolToken || !type) return;
    this.world.commands.push({
      worker: this.id,
      type,
      ...(typeof payload?.mode === 'string' ? { mode: payload.mode } : {}),
      ...(payload?.observationOnly === true || payload?.artifact?.observationOnly === true
        ? { observationOnly: true }
        : {}),
    });
    const reply = (replyType: string, replyPayload: unknown) =>
      this.emit({ id, type: replyType, payload: replyPayload, protocolToken });
    this.queue = this.queue
      .then(() => this.process(id, type, payload ?? {}, protocolToken, reply))
      .catch((error: unknown) => reply('error', { error: error instanceof Error ? error.message : String(error) }));
  }

  private async process(
    id: string,
    type: string,
    payload: Record<string, any>,
    protocolToken: string,
    reply: (type: string, payload: unknown) => void
  ): Promise<void> {
    if (this.terminated) return;
    if (type === 'init') return reply('init-result', { success: true, loadTimeMs: 0 });
    if (type === 'warmup') return reply('warmup-result', { success: true, loadTimeMs: 0 });
    const { runtime, deps } = await this.python();
    if (type === 'prepare-program') {
      return reply('prepare-result', await runtime.prepareProgram!(deps, {
        mode: payload.mode,
        code: payload.code,
        functionName: payload.functionName,
        executionStyle: payload.executionStyle ?? 'function',
        traceOptions: payload.traceOptions ?? {},
        ...(payload.observationOnly === true ? { observationOnly: true } : {}),
      }));
    }
    if (type === 'execute-prepared-program') {
      const result = await runtime.executePreparedProgram!(
        deps,
        payload.artifact,
        payload.inputs ?? {},
        { guest: guestGuardOptions(payload.limits) },
        payload.tracingEnabled
      );
      return reply('execute-result', result);
    }
    if (type === 'execute-prepared-program-batch') {
      const finished: unknown[] = [];
      const progress = (body: Record<string, unknown>) =>
        this.emit({ id, type: 'batch-case-progress', payload: body, protocolToken });
      const caseProgress = payload.reportCaseProgress === true
        ? {
            startedCaseIndexes: [] as number[],
            get finishedCount() {
              return finished.length;
            },
            started(index: number) {
              this.startedCaseIndexes.push(index);
              progress({ index, phase: 'started' });
            },
            finished(index: number, result: unknown) {
              finished.push(result);
              progress({ index, phase: 'finished', result });
            },
          }
        : undefined;
      const result = await runtime.executePreparedProgramBatch!(
        deps,
        payload.artifact,
        payload.inputBatch ?? [],
        { guest: guestGuardOptions(payload.limits) },
        payload.traceEnabledBatch,
        payload.forceJudgeCompatible,
        payload.stopAtFirstRunaway === true,
        caseProgress
      );
      // python-worker.js batchReplyWithProgress
      if (
        caseProgress &&
        result?.algorithmFastBatchUnavailable !== true &&
        Array.isArray(result?.results) &&
        result.results.length === caseProgress.finishedCount
      ) {
        const { results: _streamed, ...rest } = result;
        return reply('execute-result', {
          ...rest,
          startedCaseIndexes: caseProgress.startedCaseIndexes,
          resultsStreamed: caseProgress.finishedCount,
        });
      }
      return reply('execute-result', result);
    }
    return reply('error', { error: `Unknown message type: ${type}` });
  }

  terminate(): void {
    this.terminated = true;
  }

  private emit(data: unknown): void {
    if (this.terminated) return;
    // postMessage's structured clone: the runtime's values come from its own
    // realm, and a worker reply reaches the page as page-realm data.
    this.onmessage?.({ data: structuredClone(data) } as MessageEvent);
  }
}

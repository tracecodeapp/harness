/**
 * A Python worker double that speaks the real worker protocol to the real
 * PythonWorkerClient. Each instance stands for one Pyodide worker: it
 * answers one command at a time, in arrival order (the worker's own
 * message queue), and journals every command with a global sequence
 * number so a test can read the order of work across workers.
 *
 * Learner code is a function of the case input. A case can be made to hang
 * (learner code that never yields), to end the Python runtime, or to raise.
 * The observer's execution can be made to fail its prepare, hang, crash the
 * worker, or take a fixed time.
 */
import { RUNTIME_TRACE_SCHEMA_VERSION } from '../../packages/runtime-contracts/src/index';

export interface ProtocolCommand {
  readonly seq: number;
  readonly worker: number;
  readonly type: string;
  readonly mode?: string;
  readonly observationOnly?: boolean;
  readonly cases?: number;
  /** Sequence number at which the worker began processing it. */
  startedAt?: number;
  /** Sequence number of the reply, when there was one. */
  repliedAt?: number;
}

export interface ProtocolCaseEvent {
  readonly seq: number;
  readonly worker: number;
  readonly index: number;
  readonly phase: 'started' | 'finished';
}

export interface ProtocolWorkerBehaviour {
  /** Classification the worker gives every program. */
  tier?: 'algorithm-fast' | 'judge-compatible' | 'hard-isolated';
  /** Inputs whose learner call never returns. */
  hangsOn?: (input: Record<string, unknown>) => boolean;
  /** Inputs whose learner call ends the interpreter (os._exit). */
  endsRuntimeOn?: (input: Record<string, unknown>) => boolean;
  /** Inputs whose learner call raises. */
  raisesOn?: (input: Record<string, unknown>) => boolean;
  /** The observation-only prepare reports a trace-side compile failure. */
  observerPrepareFails?: boolean;
  /** How the observer's execution ends. */
  observerExecution?: 'draws' | 'hangs' | 'crashes';
  /** Milliseconds each observer execution takes. */
  observerDelayMs?: number;
  /** Milliseconds each ordinary case takes. */
  caseDelayMs?: number;
}

export interface ProtocolWorld {
  readonly behaviour: ProtocolWorkerBehaviour;
  readonly workers: ProtocolWorker[];
  readonly commands: ProtocolCommand[];
  readonly cases: ProtocolCaseEvent[];
  seq: number;
  /** Learner-visible values each observer execution returned, by worker. */
  readonly drawings: Array<{ worker: number; input: Record<string, unknown> }>;
  /** Workers busy preparing or executing right now. */
  readonly busy: Set<number>;
  /** The most workers ever busy preparing or executing at the same time. */
  maxBusyWorkers: number;
  factory(): ProtocolWorker;
  live(): ProtocolWorker[];
}

export function createProtocolWorld(behaviour: ProtocolWorkerBehaviour = {}): ProtocolWorld {
  const world: ProtocolWorld = {
    behaviour,
    workers: [],
    commands: [],
    cases: [],
    seq: 0,
    drawings: [],
    busy: new Set(),
    maxBusyWorkers: 0,
    factory() {
      const worker = new ProtocolWorker(world, world.workers.length);
      world.workers.push(worker);
      return worker;
    },
    live() {
      return world.workers.filter((worker) => !worker.terminated);
    },
  };
  return world;
}

export function learnerValue(input: Record<string, unknown>): unknown {
  return input.value;
}

function artifact(mode: string, code: string, functionName: string, tier: string, observationOnly: boolean) {
  return {
    schemaVersion: 'tracecode.python.prepared-program.v4',
    fingerprint: { cacheTag: 'cpython-test', magicNumber: 'test', marshalVersion: 4 },
    mode,
    code,
    functionName,
    executionStyle: 'function',
    traceOptions: {},
    ...(observationOnly ? { observationOnly: true } : {}),
    isolationProfile: { tier, reasons: [] },
    ...(mode === 'code' && tier === 'algorithm-fast' ? { algorithmFastBatchCode: 'fast-batch' } : {}),
    userCode: 'user-code',
    executorCode: 'executor-code',
  };
}

export class ProtocolWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  /** Commands that ran learner code (ordinary cases or observer executions). */
  executions = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly world: ProtocolWorld, readonly id: number) {
    queueMicrotask(() => this.emit({ type: 'worker-ready' }));
  }

  postMessage(message: unknown): void {
    const { id, type, payload, protocolToken } = message as {
      id?: string;
      type?: string;
      payload?: Record<string, unknown>;
      protocolToken?: string;
    };
    if (!id || !protocolToken || !type) return;
    const command: ProtocolCommand = {
      seq: ++this.world.seq,
      worker: this.id,
      type,
      ...(typeof payload?.mode === 'string' ? { mode: payload.mode } : {}),
      ...(payload?.observationOnly === true || (payload?.artifact as { observationOnly?: unknown } | undefined)?.observationOnly === true
        ? { observationOnly: true }
        : {}),
      ...(Array.isArray(payload?.inputBatch) ? { cases: payload.inputBatch.length } : {}),
    };
    this.world.commands.push(command);
    const reply = (replyType: string, replyPayload: unknown) => {
      if (this.terminated) return;
      command.repliedAt = ++this.world.seq;
      this.emit({ id, type: replyType, payload: replyPayload, protocolToken });
    };
    const progress = (progressPayload: Record<string, unknown>) =>
      this.emit({ id, type: 'batch-case-progress', payload: progressPayload, protocolToken });
    const work = type === 'prepare-program' || type.startsWith('execute-');
    this.queue = this.queue.then(async () => {
      if (this.terminated) return;
      command.startedAt = ++this.world.seq;
      if (work) {
        this.world.busy.add(this.id);
        this.world.maxBusyWorkers = Math.max(this.world.maxBusyWorkers, this.world.busy.size);
      }
      try {
        await this.process(type, payload ?? {}, reply, progress);
      } finally {
        if (work) this.world.busy.delete(this.id);
      }
    }).catch(() => undefined);
  }

  private async process(
    type: string,
    payload: Record<string, unknown>,
    reply: (type: string, payload: unknown) => void,
    progress: (payload: Record<string, unknown>) => void
  ): Promise<void> {
    if (this.terminated) return;
    const behaviour = this.world.behaviour;
    const tier = behaviour.tier ?? 'algorithm-fast';
    if (type === 'init') return reply('init-result', { success: true, loadTimeMs: 0 });
    if (type === 'warmup') return reply('warmup-result', { success: true, loadTimeMs: 0 });
    if (type === 'prepare-program') {
      const mode = String(payload.mode);
      const observationOnly = payload.observationOnly === true;
      await tick();
      if (observationOnly && behaviour.observerPrepareFails) {
        return reply('prepare-result', {
          success: false,
          error: 'SyntaxError: trace-side compile failed',
          errorLine: 1,
          consoleOutput: [],
        });
      }
      return reply('prepare-result', {
        success: true,
        mode,
        artifact: artifact(mode, String(payload.code), String(payload.functionName), tier, observationOnly),
        consoleOutput: [],
      });
    }
    if (type === 'execute-prepared-program-batch') return this.batch(payload, reply, progress);
    if (type === 'execute-prepared-program') {
      const artifactPayload = payload.artifact as { observationOnly?: boolean } | undefined;
      const inputs = (payload.inputs ?? {}) as Record<string, unknown>;
      this.markExecuting();
      if (artifactPayload?.observationOnly === true) return this.observe(inputs, reply);
      // A single ordinary case (the per-case compatibility path).
      if (payload.reportCaseProgress === true) progress({ index: 0, phase: 'started' });
      const result = await this.runCase(inputs);
      if (result === 'hang' || this.terminated) return;
      return reply('execute-result', result);
    }
  }

  private markExecuting(): void {
    this.executions += 1;
  }

  private async runCase(inputs: Record<string, unknown>): Promise<Record<string, unknown> | 'hang'> {
    const behaviour = this.world.behaviour;
    if (behaviour.hangsOn?.(inputs)) return 'hang';
    await delay(behaviour.caseDelayMs ?? 1);
    if (behaviour.endsRuntimeOn?.(inputs)) {
      return {
        success: false,
        output: null,
        error: 'The program ended the Python runtime (os._exit).',
        errorType: 'SystemExit',
        diagnosticStage: 'runtime',
        consoleOutput: [],
        timings: { runMs: 1, algorithmFastBatch: true },
      };
    }
    if (behaviour.raisesOn?.(inputs)) {
      return {
        success: false,
        output: null,
        error: 'ValueError: learner raised',
        errorType: 'ValueError',
        errorLine: 2,
        diagnosticStage: 'runtime',
        consoleOutput: [],
        timings: { runMs: 1, algorithmFastBatch: true },
      };
    }
    return {
      success: true,
      output: learnerValue(inputs),
      consoleOutput: [],
      timings: { runMs: 1, algorithmFastBatch: true },
    };
  }

  private async batch(
    payload: Record<string, unknown>,
    reply: (type: string, payload: unknown) => void,
    progress: (payload: Record<string, unknown>) => void
  ): Promise<void> {
    const inputBatch = (payload.inputBatch ?? []) as Record<string, unknown>[];
    const stream = payload.reportCaseProgress === true;
    const stopping = payload.stopAtFirstRunaway === true;
    const results: Record<string, unknown>[] = [];
    this.markExecuting();
    for (const [index, inputs] of inputBatch.entries()) {
      this.world.cases.push({ seq: ++this.world.seq, worker: this.id, index, phase: 'started' });
      if (stream) progress({ index, phase: 'started' });
      const result = await this.runCase(inputs);
      if (result === 'hang' || this.terminated) return;
      results.push(result);
      this.world.cases.push({ seq: ++this.world.seq, worker: this.id, index, phase: 'finished' });
      if (stream) progress({ index, phase: 'finished', result });
      if (stopping && result.success === false && typeof result.timeoutReason === 'string') break;
    }
    await tick();
    reply('execute-result', stream
      ? { success: results.every((result) => result.success === true), resultsStreamed: results.length, consoleOutput: [] }
      : { success: results.every((result) => result.success === true), results, consoleOutput: [] });
  }

  private async observe(inputs: Record<string, unknown>, reply: (type: string, payload: unknown) => void): Promise<void> {
    const behaviour = this.world.behaviour;
    const execution = behaviour.observerExecution ?? 'draws';
    if (execution === 'hangs') return;
    if (execution === 'crashes') {
      await tick();
      if (!this.terminated) this.onerror?.({ message: 'RangeError: worker crashed' } as ErrorEvent);
      return;
    }
    await delay(behaviour.observerDelayMs ?? 1);
    if (this.terminated) return;
    this.world.drawings.push({ worker: this.id, input: inputs });
    reply('execute-result', {
      success: true,
      output: null,
      consoleOutput: [],
      executionTimeMs: 1,
      trace: {
        schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
        language: 'python',
        runId: 'python:run',
        events: [{ kind: 'line', runId: 'python:run', file: 'solution.py', line: 2, step: 0 }],
      },
      observation: { recorderCompleted: true, attemptedEvents: 1 },
    });
  }

  terminate(): void {
    this.terminated = true;
    this.world.busy.delete(this.id);
  }

  private emit(data: unknown): void {
    if (this.terminated) return;
    this.onmessage?.({ data } as MessageEvent);
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

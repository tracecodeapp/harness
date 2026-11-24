import type { RuntimeTrace } from '../../packages/runtime-contracts/src/runtime-trace';
import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
  judgeCaseExecutionOutcome,
} from '../../src/judge';

const code = `public class Solution
{
    public int Search(int[] nums, int target)
    {
        int start = 0;
        int end = nums.Length;
        while (start < end)
        {
            int mid = start + (end - start) / 2;
            if (nums[mid] == target) return mid;
            if (nums[mid] < target) start = mid + 1;
            else end = mid;
        }
        return -1;
    }
}`;

const cases = [
  { id: 'present', input: { nums: [-10, -5, -2, 0, 4, 8, 19], target: 8 }, expected: 5 },
  { id: 'absent', input: { nums: [-2, 1, 9], target: 3 }, expected: -1 },
];

interface WorkerCommand {
  workerId: number;
  mode: string;
  type: string;
  functionName: string;
  success?: boolean;
  tier?: string;
  sentAt: number;
  completedAt?: number;
}

export async function assertCSharpWarmResubmit(csharpWorker?: string): Promise<void> {
  const NativeWorker = globalThis.Worker;
  const commands: WorkerCommand[] = [];
  const replacementPrime = Promise.withResolvers<WorkerCommand>();
  let workerId = 0;
  let initialRunnerId: number | undefined;
  let trackInitialSubmit = false;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      const id = ++workerId;
      const pending = new Map<string, WorkerCommand>();
      this.addEventListener('message', ({ data }) => {
        const command = pending.get(data?.id);
        if (!command || (data.type !== command.type && data.type !== 'error')) return;
        pending.delete(data.id);
        command.success = data.payload?.success ??
          (data.payload?.observationStatus === 'drawn' || data.payload?.observationStatus === 'truncated');
        command.tier = data.payload?.timings?.preparedRunnerTier;
        command.completedAt = performance.now();
        if (
          initialRunnerId !== undefined &&
          command.workerId !== initialRunnerId &&
          command.mode === 'trace' &&
          command.functionName === 'Add' &&
          command.success === true
        ) {
          replacementPrime.resolve(command);
        }
      });
      const post = this.postMessage.bind(this);
      this.postMessage = ((message, transfer) => {
        const prepared = message?.payload?.prepared;
        if (
          (message?.type === 'execute-prepared-code' || message?.type === 'execute-prepared-trace') &&
          prepared
        ) {
          const command: WorkerCommand = {
            workerId: id,
            type: message.type,
            mode: prepared.mode,
            functionName: prepared.functionName,
            sentAt: performance.now(),
          };
          if (trackInitialSubmit && command.mode === 'code' && command.functionName === 'Search') {
            initialRunnerId ??= id;
          }
          commands.push(command);
          pending.set(message.id, command);
        }
        post(message, transfer as Transferable[]);
      }) as typeof this.postMessage;
    }
  };

  try {
    const host = createBrowserJudgeHost({
      providers: ['csharp'],
      assetBaseUrl: '/workers',
      ...(csharpWorker ? { assets: { csharpWorker } } : {}),
      safeExecution: { workerLifecycle: 'warm-and-retire' },
    });
    try {
      const warm = await host.warmLanguage('csharp');
      if (!warm.success) throw new Error('C# warmup failed before the history test.');

      async function submit(id: string) {
        const bundle = await createAlgorithmJudgeBundle({
          id,
          language: 'csharp',
          code,
          functionName: 'Search',
          executionStyle: 'solution-method',
          trace: false,
          cases,
          comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
        });
        const receipt = await host.evaluateAlgorithm({ bundle, stopAtFirstRunaway: true });
        const rows = receipt.evaluation.cases;
        if (
          receipt.verdict !== 'passed' || receipt.evaluation.status !== 'completed' ||
          rows.length !== cases.length ||
          !cases.every((testCase, index) =>
            rows[index]?.caseId === testCase.id &&
            rows[index]?.status === 'completed' &&
            rows[index]?.verdict.kind === 'passed' &&
            rows[index]?.value === testCase.expected &&
            rows[index]?.trace === undefined
          )
        ) {
          throw new Error(`C# ${id} failed: ${JSON.stringify(receipt.evaluation)}`);
        }
      }
      const tracedBundle = await createAlgorithmJudgeBundle({
        id: 'run-before-warm-resubmit',
        language: 'csharp',
        code,
        functionName: 'Search',
        executionStyle: 'solution-method',
        trace: true,
        cases,
        comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
      });
      const run = await host.execute({
        bundle: tracedBundle, interactive: true, tracing: { caseIds: ['present'] },
      });
      const traced = commands.find((command) =>
        command.type === 'execute-prepared-trace' && command.functionName === 'Search' && command.success === true
      );
      const trace = run.evaluation.cases[0]?.trace as RuntimeTrace | undefined;
      if (!run.executionId || !trace?.events.length || !traced) {
        throw new Error('C# warm resubmit history did not complete a traced execution.');
      }
      await host.disposeExecution(run.executionId);
      trackInitialSubmit = true;
      await submit('initial-submit');

      // The initial Submit releases its runner and starts warming a standby.
      // Start the idle interval only after that replacement's trusted prime.
      let primeTimeout: ReturnType<typeof setTimeout> | undefined;
      const prime = await Promise.race([
        replacementPrime.promise,
        new Promise<never>((_, reject) => {
          primeTimeout = setTimeout(() => {
            reject(new Error(`C# replacement runner did not acknowledge its prime: ${JSON.stringify(commands)}`));
          }, 30_000);
        }),
      ]).finally(() => clearTimeout(primeTimeout));

      await new Promise((resolve) => setTimeout(resolve, 2_500));
      const beforeResubmit = commands.length;
      await submit('submit-after-idle');

      const firstCase = commands.slice(beforeResubmit).find(
        (command) => command.mode === 'code' && command.functionName === 'Search'
      );
      if (
        firstCase?.tier !== 'algorithm-fast' ||
        firstCase.workerId !== prime.workerId ||
        prime.completedAt === undefined ||
        firstCase.sentAt - prime.completedAt <= 2_000
      ) {
        throw new Error(`C# resubmit did not use the aged replacement runner: ${JSON.stringify({ prime, firstCase })}`);
      }
    } finally {
      await host.dispose();
    }
  } finally {
    globalThis.Worker = NativeWorker;
  }
}


const jsonElementCode = `using System.Text.Json;
public class Solution {
  public int solve(int n) {
    JsonElement element = default(JsonElement);
    int result = n + (int)element.ValueKind;
    return result;
  }
}`;
const healthyCode = `public class Solution {
  private static int count;
  public int solve(int n) {
    count++;
    return n + count - 1;
  }
}`;

export async function assertCSharpObservationBoundary(
  csharpWorker: string,
  csharpRunnerAssetBaseUrl: string,
  fault: boolean
): Promise<void> {
  const NativeWorker = globalThis.Worker;
  type Command = {
    workerId: number;
    type: string;
    mode: string;
    inputs: unknown;
    attemptToken?: string;
    started: number[];
    terminal?: {
      startedCaseIndexes?: number[];
      observation?: {
        attemptToken?: string;
        recorderCompleted?: boolean;
        encodeFailed?: boolean;
        cut?: string;
        attemptedEvents?: number;
      };
    };
  };
  type Mark = {
    phase: string;
    evaluationId: string;
    workspaceDigest: string;
    generation: number;
    caseId?: string;
    attemptToken?: string;
  };
  const starts: Command[] = [];
  const journal: Mark[] = [];
  const bridge = Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1');
  let nextWorkerId = 0;
  let injected = false;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      const workerId = ++nextWorkerId;
      const pending = new Map<string, { command: Command; protocolToken: string }>();
      const post = this.postMessage.bind(this);
      this.postMessage = ((message, transfer) => {
        const { prepared, inputs, observation } = message?.payload ?? {};
        if (prepared?.functionName === 'solve' && message.type.startsWith('execute-prepared-')) {
          const command: Command = {
            workerId, type: message.type, mode: prepared.mode, inputs,
            attemptToken: observation?.attemptToken, started: [],
          };
          starts.push(command);
          pending.set(message.id, { command, protocolToken: message.protocolToken });
        }
        post(message, transfer as Transferable[]);
      }) as typeof this.postMessage;
      this.addEventListener('message', (event) => {
        const message = event.data;
        const request = pending.get(message?.id);
        if (!event.isTrusted || !request?.protocolToken ||
            message.protocolToken !== request.protocolToken) return;
        const reply = message.payload;
        if (message.type === 'runtime-progress' && reply?.stage === 'ordinary-case-started') {
          request.command.started.push(reply.detail?.caseIndex);
        }
        if (message.type === request.command.type) {
          pending.delete(message.id);
          request.command.terminal = reply;
          if (reply?.encoderInjectionAck === true) injected = true;
        }
      });
    }
  };

  try {
    Object.defineProperty(window, bridge, {
      configurable: true,
      value: { onEvent: (mark: Mark) => journal.push(mark) },
    });
    const host = createBrowserJudgeHost({
      providers: ['csharp'],
      assetBaseUrl: '/workers',
      assets: { csharpWorker, csharpRunnerAssetBaseUrl },
      safeExecution: { workerLifecycle: 'warm-and-retire' },
    });
    Reflect.deleteProperty(window, bridge);
    try {
      await host.warmLanguage('csharp');
      const makeBundle = (source: string, trace: boolean, maxTraceBytes?: number) =>
        createAlgorithmJudgeBundle({
          id: 'csharp-observation-boundary',
          language: 'csharp',
          code: source,
          functionName: 'solve',
          executionStyle: 'solution-method',
          trace,
          ...(maxTraceBytes === undefined ? {} : { traceOptions: { maxTraceBytes } }),
          limits: { wallClockMs: 10_000 },
          cases: [
            { id: 'A', input: { n: 7 }, expected: 7 },
            { id: 'B', input: { n: 11 }, expected: 11 },
          ],
          comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
        });
      const assertGrades = (rows: Awaited<ReturnType<typeof host.evaluateAlgorithm>>['evaluation']['cases']) => {
        for (const [index, expected] of [7, 11].entries()) {
          const row = rows[index];
          if (row?.status !== 'completed' || row.value !== expected || row.verdict.kind !== 'passed') {
            throw new Error(`C# ordinary grade ${index} failed: ${JSON.stringify(row)}`);
          }
          const outcome = judgeCaseExecutionOutcome(row, { language: 'csharp', trace: false });
          for (const field of ['untracedRunNeeded', 'traceUnavailable', 'traceUnavailableRun', 'providerFailure']) {
            if (Object.hasOwn(row, field) || Object.hasOwn(outcome, field)) {
              throw new Error(`C# leaked ${field} onto an ordinary result`);
            }
          }
        }
      };

      async function run(source: string, maxTraceBytes?: number) {
        const before = starts.length;
        const markFrom = journal.length;
        const bundle = await makeBundle(source, true, maxTraceBytes);
        const result = await host.execute({ bundle, interactive: true, tracing: { caseIds: ['A'] } });
        const { evaluation, executionId } = result;
        if (evaluation.status !== 'completed' || !executionId || evaluation.compile?.failure) {
          throw new Error(`C# ordinary compile failed: ${JSON.stringify(evaluation)}`);
        }
        try {
          assertGrades(evaluation.cases);
          const [selected, unselected] = evaluation.cases;
          if (!selected?.attachment || !unselected || Object.hasOwn(unselected, 'attachment') || Object.hasOwn(unselected, 'trace')) {
            throw new Error('C# did not attach exactly the requested drawing.');
          }
          const gradeStarts = starts.slice(before).filter((entry) => entry.type === 'execute-prepared-code');
          const observerStarts = starts.slice(before).filter((entry) => entry.type === 'execute-prepared-trace');
          if (gradeStarts.length !== 2 || gradeStarts.some((entry) => entry.mode !== 'code') ||
              observerStarts.length !== 1 || observerStarts[0]?.mode !== 'trace' ||
              gradeStarts.some((entry) => entry.workerId === observerStarts[0]?.workerId)) {
            throw new Error(`C# used the wrong artifact or worker: ${JSON.stringify(starts.slice(before))}`);
          }
          for (const command of gradeStarts) {
            if (JSON.stringify(command.started) !== '[0]' ||
                JSON.stringify(command.terminal?.startedCaseIndexes) !== '[0]') {
              throw new Error(`C# grade lacks an authenticated start and terminal: ${JSON.stringify(command)}`);
            }
          }
          const attestation = observerStarts[0]?.terminal?.observation;
          const attachment = selected.attachment;
          if (!attestation || !attestation.attemptToken ||
              attestation.attemptToken !== observerStarts[0]?.attemptToken ||
              (attachment.status === 'refused'
                ? attachment.reason !== 'observer-encode' || attestation.encodeFailed !== true
                : attestation.recorderCompleted !== true ||
                  (attachment.status === 'truncated' &&
                    (attestation.cut !== attachment.reason || attestation.attemptedEvents !== attachment.attemptedEvents)))) {
            throw new Error(`C# observer lacks an authenticated recorder reply: ${JSON.stringify(attestation)}`);
          }
          const initial = journal.slice(markFrom);
          const expectedPhases = [
            'ordinary-write-attempt', 'ordinary-write-attempt', 'ordinary-commit',
            'attachment-bind', 'public-resolve',
          ];
          const publication = initial.filter(({ phase }) => expectedPhases.includes(phase));
          if (publication.map(({ phase }) => phase).join() !== expectedPhases.join() ||
              publication.slice(0, 2).map(({ caseId }) => caseId).join() !== 'A,B' ||
              publication[3]?.caseId !== 'A' ||
              publication[3]?.attemptToken !== attestation.attemptToken ||
              initial.some((mark) => mark.evaluationId !== attachment.evaluationId ||
                mark.workspaceDigest !== attachment.workspaceDigest || mark.generation !== attachment.generation)) {
            throw new Error(`C# receipt journal does not bind the worker reply: ${JSON.stringify(initial)}`);
          }
          const redrawMarkFrom = journal.length;
          const beforeRedraw = starts.length;
          const redraw = await host.execute({ executionId, tracing: { caseIds: ['A'] } });
          if (starts.length !== beforeRedraw || redraw.evaluation.cases[0]?.value !== 7 ||
              redraw.evaluation.cases[0]?.attachment !== selected.attachment) {
            throw new Error('C# redraw changed the verdict or dispatched learner work.');
          }
          const redrawMarks = journal.slice(redrawMarkFrom);
          const cache = redrawMarks[0];
          if (redrawMarks.map(({ phase }) => phase).join() !== 'observation-cache-hit,public-resolve' ||
              cache?.caseId !== 'A' || cache.attemptToken !== attestation.attemptToken ||
              cache.evaluationId !== attachment.evaluationId || cache.workspaceDigest !== attachment.workspaceDigest ||
              cache.generation !== attachment.generation) {
            throw new Error(`C# redraw did not cite the original observer reply: ${JSON.stringify(redrawMarks)}`);
          }
          if (selected.attachment.status === 'refused') {
            const presentation = judgeCaseExecutionOutcome(selected, { language: 'csharp', trace: true });
            if (presentation.kind !== 'trace-refused' || Object.keys(presentation).length !== 1) {
              throw new Error(`C# refused drawing leaked legacy fields: ${JSON.stringify(presentation)}`);
            }
          }
          return selected.attachment;
        } finally {
          await host.disposeExecution(executionId);
        }
      }

      if (fault) {
        const drawing = await run(healthyCode);
        if (!injected || drawing.status !== 'refused' || drawing.reason !== 'observer-encode') {
          throw new Error(`C# encoder fault was not acknowledged: ${JSON.stringify(drawing)}`);
        }
        return;
      }
      const jsonDrawing = await run(jsonElementCode);
      if (jsonDrawing.status !== 'drawn' &&
          !(jsonDrawing.status === 'refused' && jsonDrawing.reason === 'observer-encode')) {
        throw new Error(`C# JSON element drawing had the wrong origin: ${JSON.stringify(jsonDrawing)}`);
      }
      const healthy = await run(healthyCode);
      if (healthy.status !== 'drawn' || !healthy.trace.events.some((event) => event.kind === 'line' && event.line === 4)) {
        throw new Error(`C# observer did not draw the learner line: ${JSON.stringify(healthy)}`);
      }
      const capped = await run(healthyCode, 1);
      if (capped.status !== 'truncated' || capped.reason !== 'byte-budget' ||
          capped.trace.events.length !== 0 || capped.attemptedEvents < 1) {
        throw new Error(`C# one-byte cap did not preserve attempted-event evidence: ${JSON.stringify(capped)}`);
      }
      for (const trace of [false, true]) {
        const receipt = await host.evaluateAlgorithm({ bundle: await makeBundle(jsonElementCode, trace) });
        if (receipt.verdict !== 'passed') throw new Error('C# mux-shaped receipt failed.');
        assertGrades(receipt.evaluation.cases);
        if (receipt.evaluation.cases.some((row) => Object.hasOwn(row, 'attachment') !== trace)) {
          throw new Error('C# mux-shaped receipt did not preserve the requested selection.');
        }
      }
    } finally {
      await host.dispose();
    }
  } finally {
    Reflect.deleteProperty(window, bridge);
    globalThis.Worker = NativeWorker;
  }
}

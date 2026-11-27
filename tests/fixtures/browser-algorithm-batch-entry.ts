import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
} from '../../src/judge';

type BatchLanguage =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'java'
  | 'csharp'
  | 'cpp';

type BatchWarmMode = 'cold' | 'runtime' | 'trace-prime';
type BatchWorkerLifecycle = 'warm-and-retire' | 'retire-only';

interface BatchFixture {
  readonly language: BatchLanguage;
  readonly code: string;
  readonly functionName: string;
  readonly executionStyle?: 'function' | 'solution-method';
}

const BATCH_FIXTURES: readonly BatchFixture[] = [
  {
    language: 'python',
    code: [
      'history = []',
      'def solve(value):',
      '    history.append(value)',
      '    return len(history)',
    ].join('\n'),
    functionName: 'solve',
  },
  {
    language: 'javascript',
    code: [
      'const history = [];',
      'function solve(value) {',
      '  history.push(value);',
      '  return history.length;',
      '}',
    ].join('\n'),
    functionName: 'solve',
  },
  {
    language: 'typescript',
    code: [
      'const history: number[] = [];',
      'function solve(value: number): number {',
      '  history.push(value);',
      '  return history.length;',
      '}',
    ].join('\n'),
    functionName: 'solve',
  },
  {
    language: 'java',
    code: [
      'class Solution {',
      '  private static int history = 0;',
      '  public int solve(int value) {',
      '    history += 1;',
      '    return history;',
      '  }',
      '}',
    ].join('\n'),
    functionName: 'solve',
    executionStyle: 'solution-method',
  },
  {
    language: 'csharp',
    code: [
      'public class Solution {',
      '  private static int history = 0;',
      '  public int Solve(int value) {',
      '    history += 1;',
      '    return history;',
      '  }',
      '}',
    ].join('\n'),
    functionName: 'Solve',
    executionStyle: 'solution-method',
  },
  {
    language: 'cpp',
    code: [
      'class Solution {',
      'public:',
      '  int solve(int value) {',
      '    static int history = 0;',
      '    history += 1;',
      '    return history;',
      '  }',
      '};',
    ].join('\n'),
    functionName: 'solve',
    executionStyle: 'solution-method',
  },
] as const;

function trustedTracePrime(
  language: BatchLanguage
): Pick<BatchFixture, 'code' | 'functionName' | 'executionStyle'> {
  switch (language) {
    case 'python':
      return { code: 'def tracecode_warmup():\n    return 0', functionName: 'tracecode_warmup' };
    case 'javascript':
      return { code: 'function tracecodeWarmup() { return 0; }', functionName: 'tracecodeWarmup' };
    case 'typescript':
      return { code: 'function tracecodeWarmup(): number { return 0; }', functionName: 'tracecodeWarmup' };
    case 'java':
      return {
        code: 'class Solution { public int tracecodeWarmup() { return 0; } }',
        functionName: 'tracecodeWarmup',
        executionStyle: 'solution-method',
      };
    case 'csharp':
      return {
        code: 'public class Solution { public int TraceCodeWarmup() => 0; }',
        functionName: 'TraceCodeWarmup',
        executionStyle: 'solution-method',
      };
    case 'cpp':
      return {
        code: 'class Solution { public: int tracecodeWarmup() { return 0; } };',
        functionName: 'tracecodeWarmup',
        executionStyle: 'solution-method',
      };
  }
}

type AlgorithmReceipt = Awaited<ReturnType<ReturnType<
  typeof createBrowserJudgeHost
>['evaluateAlgorithm']>>;

function receiptSummary(receipt: Pick<AlgorithmReceipt, 'evaluation'> & { verdict?: string }): {
  verdict: string | undefined;
  evaluationStatus: string;
  caseVerdicts: string[];
  sessionIds: string[];
  outputs: unknown[];
  diagnostics: readonly unknown[];
  compileStdout: string;
  compileStderr: string;
} {
  if (receipt.evaluation.status !== 'completed') {
    return {
      verdict: receipt.verdict,
      evaluationStatus: receipt.evaluation.status,
      caseVerdicts: [],
      sessionIds: [],
      outputs: [],
      diagnostics: receipt.evaluation.compile.diagnostics,
      compileStdout: receipt.evaluation.compile.stdout,
      compileStderr: receipt.evaluation.compile.stderr,
    };
  }
  return {
    verdict: receipt.verdict,
    evaluationStatus: receipt.evaluation.status,
    caseVerdicts: receipt.evaluation.cases.map(
      (testCase) => testCase.verdict.kind
    ),
    sessionIds: receipt.evaluation.cases.map(
      (testCase) => testCase.sessionId
    ),
    outputs: receipt.evaluation.cases.map((testCase) => testCase.value),
    diagnostics: receipt.evaluation.cases.flatMap(
      (testCase) => testCase.diagnostics
    ),
    compileStdout: receipt.evaluation.compile?.stdout ?? '',
    compileStderr: receipt.evaluation.compile?.stderr ?? '',
  };
}

function traceEventCount(trace: unknown): number {
  const events = (trace as { readonly events?: unknown } | undefined)?.events;
  return Array.isArray(events) ? events.length : -1;
}

const graphOutputPrograms = {
  javascript: 'function solve(root) {\n  return root;\n}\n',
  typescript: 'function solve(root: TreeNode | null): TreeNode | null {\n  return root;\n}\n',
  cpp: 'TreeNode* solve(TreeNode* root) {\n  return root;\n}\n',
} as const;

export async function runBrowserGraphOutput(
  assetBaseUrl: string,
  selectedLanguages: readonly BatchLanguage[],
  workerLifecycle: BatchWorkerLifecycle
) {
  // G6 graph-output: A has a back edge and two edges to the same child.
  // B has two independent children with equal values.
  const cases = [true, false].map((cyclic) => {
    const left = { __id__: 'c', val: 2, left: cyclic ? { __ref__: 'r' } : null, right: null };
    const child = { val: 2, left: null, right: null };
    const root = { __id__: 'r', val: 1, left, right: cyclic ? { __ref__: 'c' } : child };
    const expected = {
      ...root,
      __type__: 'TreeNode',
      left: { ...left, __type__: 'TreeNode' },
      right: cyclic ? root.right : { ...child, __type__: 'TreeNode' },
    };
    return { id: cyclic ? 'A' : 'B', input: { root }, expected };
  });
  const results = [];
  for (const language of ['javascript', 'typescript', 'cpp'] as const) {
    if (!selectedLanguages.includes(language)) continue;
    for (const mode of ['run', 'submit'] as const) {
      const host = createBrowserJudgeHost({
        providers: [language],
        assetBaseUrl,
        safeExecution: { workerLifecycle },
      });
      try {
        const bundle = await createAlgorithmJudgeBundle({
          id: `g6-graph-output-${language}-${mode}`,
          language,
          code: graphOutputPrograms[language],
          functionName: 'solve',
          executionStyle: 'function',
          cases,
          trace: mode === 'run',
          limits: { wallClockMs: 10_000 },
          comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
        });
        const receipt = mode === 'run'
          ? await host.execute({ bundle, interactive: true, tracing: { caseIds: ['A'] } })
          : await host.evaluateAlgorithm({ bundle });
        results.push({ language, mode, ...receiptSummary(receipt) });
        if ('executionId' in receipt && typeof receipt.executionId === 'string') {
          await host.disposeExecution(receipt.executionId);
        }
      } finally {
        host.dispose();
      }
    }
  }
  return results;
}

interface PythonInteractiveCommand {
  readonly type: string;
  readonly mode?: string;
  readonly observationOnly?: boolean;
  readonly batchSize?: number;
}

export interface PythonInteractiveWorker {
  readonly url: string;
  readonly createdDuringRun: boolean;
  readonly commands: PythonInteractiveCommand[];
}

export interface DisposableObserverWorker {
  readonly created: number;
  observations: number;
  retired?: number;
}

export async function runBrowserAlgorithmBatch(
  assetBaseUrl: string,
  selectedLanguages: readonly BatchLanguage[] = BATCH_FIXTURES.map(
    (fixture) => fixture.language
  ),
  csharpBatchConcurrency = 4,
  pythonCompatibilityCaseCount = 3,
  algorithmCaseCount = 10,
  warmMode: BatchWarmMode = 'cold',
  workerLifecycle: BatchWorkerLifecycle = 'warm-and-retire'
): Promise<unknown> {
  const NativeWorker = globalThis.Worker;
  const workerUrls: string[] = [];
  const observerWorkers: DisposableObserverWorker[] = [];
  const takeObservers = () => observerWorkers.splice(0).map((worker) => ({ ...worker }));
  let workerLifecycleEvent = 0;
  let activeWorkers = 0;
  let pythonInteractiveWorkers: Map<Worker, PythonInteractiveWorker> | undefined;
  let maximumActiveWorkers = 0;
  const workerCommands: Array<{
    id?: string;
    type?: string;
    runtimeRole?: string;
    preparedMode?: string;
    preparedFunctionName?: string;
    inputs?: unknown;
    responseReceived?: boolean;
    responseSuccess?: boolean;
    responseOutput?: unknown;
  }> = [];
  class ObservedWorker extends NativeWorker {
    private observedTerminated = false;
    private readonly created = ++workerLifecycleEvent;
    private observer?: DisposableObserverWorker;

    constructor(url: string | URL, options?: WorkerOptions) {
      workerUrls.push(String(url));
      super(url, options);
      const workerUrl = String(url);
      const isPythonWorker = new URL(workerUrl, globalThis.location.href).pathname.endsWith('/python-worker.js');
      if (isPythonWorker) {
        pythonInteractiveWorkers?.set(this, { url: workerUrl, createdDuringRun: true, commands: [] });
      }
      activeWorkers += 1;
      maximumActiveWorkers = Math.max(maximumActiveWorkers, activeWorkers);
      const observedCommands = new Map<
        string,
        (typeof workerCommands)[number]
      >();
      this.addEventListener('message', (event) => {
        const response = event.data as {
          id?: string;
          payload?: { success?: boolean; output?: unknown };
        } | undefined;
        if (!response?.id) return;
        const command = observedCommands.get(response.id);
        if (!command) return;
        command.responseReceived = true;
        command.responseSuccess = response.payload?.success === true;
        command.responseOutput = response.payload?.output;
      });
      const nativePostMessage = this.postMessage.bind(this);
      this.postMessage = ((
        message: {
          id?: string;
          type?: string;
          payload?: {
            runtimeRole?: string;
            prepared?: { mode?: string; functionName?: string };
            inputs?: unknown;
            mode?: string;
            observationOnly?: boolean;
            attemptToken?: string;
            artifact?: { observationOnly?: boolean };
            inputBatch?: unknown[];
          };
        },
        transferOrOptions?: StructuredSerializeOptions | Transferable[]
      ) => {
        const observes = message?.type === 'observe-execution' ||
          (message?.type === 'execute-prepared-runtime-program' &&
            message.payload?.mode === 'trace' &&
            typeof message.payload.attemptToken === 'string');
        if (observes) {
          if (!this.observer) {
            this.observer = { created: this.created, observations: 0 };
            observerWorkers.push(this.observer);
          }
          this.observer.observations += 1;
        }
        const command: (typeof workerCommands)[number] = {
          id: message?.id,
          type: message?.type,
          runtimeRole: message?.payload?.runtimeRole,
          preparedMode: message?.payload?.prepared?.mode,
          preparedFunctionName: message?.payload?.prepared?.functionName,
          inputs: message?.payload?.inputs,
        };
        if (isPythonWorker && pythonInteractiveWorkers && message?.type) {
          let witness = pythonInteractiveWorkers.get(this);
          if (!witness) {
            witness = { url: workerUrl, createdDuringRun: false, commands: [] };
            pythonInteractiveWorkers.set(this, witness);
          }
          witness.commands.push({
            type: message.type,
            mode: message.payload?.mode,
            observationOnly: message.payload?.artifact?.observationOnly ?? message.payload?.observationOnly,
            batchSize: message.payload?.inputBatch?.length,
          });
        }
        workerCommands.push(command);
        if (message?.id) observedCommands.set(message.id, command);
        nativePostMessage(message, transferOrOptions as Transferable[]);
      }) as typeof this.postMessage;
    }

    override terminate(): void {
      if (!this.observedTerminated) {
        this.observedTerminated = true;
        activeWorkers -= 1;
        if (this.observer) {
          this.observer.retired = ++workerLifecycleEvent;
        }
      }
      super.terminate();
    }
  }
  globalThis.Worker = ObservedWorker;

  const results: Record<string, unknown> = {};
  try {
    for (const fixture of BATCH_FIXTURES.filter((candidate) =>
      selectedLanguages.includes(candidate.language)
    )) {
      const host = createBrowserJudgeHost({
        assetBaseUrl,
        providers: [fixture.language],
        ...(fixture.language === 'csharp'
          ? { csharp: { preparedBatchConcurrency: csharpBatchConcurrency } }
          : {}),
        safeExecution: {
          workerLifecycle,
        },
      });
      try {
        let trustedPrewarm = false;
        let warmMs: number | undefined;
        let tracePrimeMs: number | undefined;
        if (fixture.language === 'csharp' || warmMode !== 'cold') {
          const warmStartedAt = performance.now();
          const warmup = await host.warmLanguage(fixture.language);
          warmMs = performance.now() - warmStartedAt;
          if (!warmup.success) {
            throw new Error(`${fixture.language} runtime warmup failed.`);
          }
          if (fixture.language !== 'csharp') {
            workerUrls.splice(0);
          }
          if (fixture.language === 'csharp') {
          const observedTrustedPrime = workerCommands.some(
            (command) =>
              command.type === 'execute-prepared-code' &&
              command.runtimeRole === 'runner' &&
              command.preparedMode === 'trace' &&
              command.preparedFunctionName === 'Add' &&
              JSON.stringify(command.inputs) === '{"a":1,"b":2}' &&
              command.responseReceived === true &&
              command.responseSuccess === true &&
              command.responseOutput === 3
          );
          if (!warmup.success || !observedTrustedPrime) {
            throw new Error(
              'C# public Judge provider did not complete its fixed trusted standby-runner prime.'
            );
          }
          trustedPrewarm = true;
          }
        }
        if (warmMode === 'trace-prime') {
          const prime = trustedTracePrime(fixture.language);
          const primeBundle = await createAlgorithmJudgeBundle({
            id: `browser-${fixture.language}-trusted-trace-prime`,
            language: fixture.language,
            code: prime.code,
            functionName: prime.functionName,
            ...(prime.executionStyle
              ? { executionStyle: prime.executionStyle }
              : {}),
            cases: [{ id: 'prime', input: {}, expected: 0 }],
            trace: true,
          });
          const primeStartedAt = performance.now();
          const primed = await host.execute({
            bundle: primeBundle,
            interactive: true,
            tracing: { caseIds: ['prime'] },
          });
          if (primed.evaluation.status !== 'completed') {
            throw new Error(`${fixture.language} trusted trace prime failed.`);
          }
          if (primed.executionId) {
            await host.disposeExecution(primed.executionId);
          }
          tracePrimeMs = performance.now() - primeStartedAt;
          workerUrls.splice(0);
          observerWorkers.splice(0);
        }
        const cases = Array.from({ length: algorithmCaseCount }, (_, index) => ({
          id: `case-${index + 1}`,
          input: { value: index + 1 },
          expected: 1,
        }));
        const traceBundle = await createAlgorithmJudgeBundle({
          id: `browser-${fixture.language}-isolated-trace-batch`,
          language: fixture.language,
          code: fixture.code,
          functionName: fixture.functionName,
          ...(fixture.executionStyle
            ? { executionStyle: fixture.executionStyle }
            : {}),
          cases,
          trace: true,
        });
        const selectedCaseId = cases[0]!.id;
        maximumActiveWorkers = activeWorkers;
        if (fixture.language === 'python') pythonInteractiveWorkers = new Map();
        const interactiveStartedAt = performance.now();
        const interactive = await host.execute({
          bundle: traceBundle,
          interactive: true,
          tracing: { caseIds: [selectedCaseId] },
        });
        const interactiveInitialMs = performance.now() - interactiveStartedAt;
        const initialTraceCases =
          interactive.evaluation.status === 'completed'
            ? interactive.evaluation.cases.filter(
                (result) => result.caseId === selectedCaseId
              )
            : [];
        const backgroundCaseIds = cases
          .slice(1)
          .map((testCase) => testCase.id);
        const backgroundTraceCaseIds: string[] = [];
        const backgroundTraceEventCounts: number[] = [];
        const backgroundStartedAt = performance.now();
        try {
          if (!interactive.executionId && backgroundCaseIds.length > 0) {
            throw new Error(
              `${fixture.language} interactive execution did not retain a trace program.`
            );
          }
          for (const caseId of backgroundCaseIds) {
            const continuation = await host.execute({
              executionId: interactive.executionId!,
              tracing: { caseIds: [caseId] },
            });
            if (continuation.evaluation.status !== 'completed') continue;
            for (const result of continuation.evaluation.cases) {
              backgroundTraceCaseIds.push(result.caseId);
              backgroundTraceEventCounts.push(traceEventCount(result.trace));
            }
          }
        } finally {
          if (interactive.executionId) {
            await host.disposeExecution(interactive.executionId);
          }
        }
        const interactiveBackgroundMs =
          performance.now() - backgroundStartedAt;
        const interactiveMaximumActiveWorkers = maximumActiveWorkers;
        const interactiveWorkerUrls = workerUrls.splice(0);
        const interactiveObservers = takeObservers();
        const interactivePythonWorkers = pythonInteractiveWorkers && [...pythonInteractiveWorkers.values()];
        pythonInteractiveWorkers = undefined;

        const plainBundle = await createAlgorithmJudgeBundle({
          id: `browser-${fixture.language}-isolated-batch`,
          language: fixture.language,
          code: fixture.code,
          functionName: fixture.functionName,
          ...(fixture.executionStyle
            ? { executionStyle: fixture.executionStyle }
            : {}),
          cases,
        });
        maximumActiveWorkers = activeWorkers;
        const plainStartedAt = performance.now();
        const plainReceipt = await host.evaluateAlgorithm({
          bundle: plainBundle,
        });
        const plainMs = performance.now() - plainStartedAt;
        const plainMaximumActiveWorkers = maximumActiveWorkers;
        const plainWorkerUrls = workerUrls.splice(0);
        const plainObservers = takeObservers();

        maximumActiveWorkers = activeWorkers;
        const traceStartedAt = performance.now();
        const traceReceipt = await host.evaluateAlgorithm({
          bundle: traceBundle,
        });
        const traceMs = performance.now() - traceStartedAt;
        const traceMaximumActiveWorkers = maximumActiveWorkers;
        const traceWorkerUrls = workerUrls.splice(0);
        const traceObservers = takeObservers();

        let compatibilityIsolation:
          | ReturnType<typeof receiptSummary>
          | undefined;
        let compatibilityIsolationWorkerUrls: string[] | undefined;
        let compatibilityIsolationMaximumActiveWorkers: number | undefined;
        let compatibilityIsolationMs: number | undefined;
        let judgeFallbackIsolation:
          | ReturnType<typeof receiptSummary>
          | undefined;
        let judgeFallbackIsolationWorkerUrls: string[] | undefined;
        let judgeFallbackIsolationMaximumActiveWorkers: number | undefined;
        let judgeFallbackIsolationMs: number | undefined;
        if (fixture.language === 'python') {
          const compatibilityBundle = await createAlgorithmJudgeBundle({
            id: 'browser-python-compatibility-nested-state-isolation',
            language: 'python',
            code: [
              'sink = json.JSONEncoder',
              'def solve(value):',
              '    try:',
              '        before = sink.tracecode_case_leak',
              '    except AttributeError:',
              '        before = None',
              '    sink.tracecode_case_leak = value',
              '    return before',
            ].join('\n'),
            functionName: 'solve',
            cases: Array.from(
              { length: pythonCompatibilityCaseCount },
              (_, index) => ({
                id: `compatibility-case-${index + 1}`,
                input: { value: index + 1 },
                expected: null,
              })
            ),
          });
          maximumActiveWorkers = activeWorkers;
          const compatibilityStartedAt = performance.now();
          const compatibilityReceipt = await host.evaluateAlgorithm({
            bundle: compatibilityBundle,
          });
          compatibilityIsolationMs =
            performance.now() - compatibilityStartedAt;
          compatibilityIsolation = receiptSummary(compatibilityReceipt);
          compatibilityIsolationMaximumActiveWorkers = maximumActiveWorkers;
          compatibilityIsolationWorkerUrls = workerUrls.splice(0);

          const judgeFallbackBundle = await createAlgorithmJudgeBundle({
            id: 'browser-python-fast-artifact-custom-input-judge-fallback',
            language: 'python',
            code: [
              'def solve(value, root):',
              '    return value + root.val',
            ].join('\n'),
            functionName: 'solve',
            cases: Array.from(
              { length: pythonCompatibilityCaseCount },
              (_, index) => ({
              id: `judge-fallback-case-${index + 1}`,
              input: {
                value: index + 1,
                root: {
                  val: index + 1,
                  left: null,
                  right: null,
                },
              },
              expected: (index + 1) * 2,
              })
            ),
          });
          maximumActiveWorkers = activeWorkers;
          const judgeFallbackStartedAt = performance.now();
          const judgeFallbackReceipt = await host.evaluateAlgorithm({
            bundle: judgeFallbackBundle,
          });
          judgeFallbackIsolationMs =
            performance.now() - judgeFallbackStartedAt;
          judgeFallbackIsolation = receiptSummary(judgeFallbackReceipt);
          judgeFallbackIsolationMaximumActiveWorkers = maximumActiveWorkers;
          judgeFallbackIsolationWorkerUrls = workerUrls.splice(0);
        }

        // Verdict first, drawing after: the same Run with after-verdict
        // delivery, then the selected drawing through a continuation. Last,
        // so its post-verdict teardown cannot count against another phase.
        const deferredStartedAt = performance.now();
        const deferredVerdict = await host.execute({
          bundle: traceBundle,
          interactive: true,
          drawingDelivery: 'after-verdict',
          tracing: { caseIds: [selectedCaseId] },
        });
        const deferredVerdictMs = performance.now() - deferredStartedAt;
        let deferredDrawing: {
          readonly caseIds: readonly string[];
          readonly statuses: readonly (string | undefined)[];
          readonly eventCounts: readonly number[];
          readonly valuesMatchVerdict: boolean;
          readonly ms: number;
        } | undefined;
        try {
          if (deferredVerdict.executionId && deferredVerdict.deferredDrawings?.length) {
            const drawing = await host.execute({
              executionId: deferredVerdict.executionId,
              tracing: { caseIds: deferredVerdict.deferredDrawings },
            });
            const rows = drawing.evaluation.status === 'completed' ? drawing.evaluation.cases : [];
            const verdictRows = deferredVerdict.evaluation.status === 'completed'
              ? deferredVerdict.evaluation.cases
              : [];
            deferredDrawing = {
              caseIds: rows.map((row) => row.caseId),
              statuses: rows.map((row) => row.attachment?.status),
              eventCounts: rows.map((row) => traceEventCount(row.trace)),
              valuesMatchVerdict: rows.every((row) =>
                verdictRows.some((verdictRow) =>
                  verdictRow.caseId === row.caseId && verdictRow.status === row.status &&
                  JSON.stringify(verdictRow.value) === JSON.stringify(row.value))),
              ms: performance.now() - deferredStartedAt,
            };
          }
        } finally {
          if (deferredVerdict.executionId) {
            await host.disposeExecution(deferredVerdict.executionId);
          }
        }
        const deferred = {
          verdictMs: deferredVerdictMs,
          verdictStatus: deferredVerdict.evaluation.status,
          verdictOutputs: deferredVerdict.evaluation.cases.map((result) => result.value),
          verdictDrawingRows: deferredVerdict.evaluation.cases.filter((result) =>
            Object.hasOwn(result, 'attachment') || Object.hasOwn(result, 'trace')).length,
          deferredDrawings: deferredVerdict.deferredDrawings,
          drawing: deferredDrawing,
        };

        results[fixture.language] = {
          deferred,
          warmMode,
          warmMs,
          tracePrimeMs,
          plain: receiptSummary(plainReceipt),
          plainMs,
          plainMaximumActiveWorkers,
          plainWorkerUrls,
          plainObservers,
          trace: receiptSummary(traceReceipt),
          traceMs,
          traceMaximumActiveWorkers,
          traceWorkerUrls,
          traceObservers,
          interactive: {
            initialMs: interactiveInitialMs,
            compileTimings: interactive.evaluation.compile?.timings,
            caseTimings: interactive.evaluation.cases.map(
              (result) => result.timings
            ),
            judgeTimings: interactive.timings,
            correctnessStatus: interactive.evaluation.status,
            correctnessCaseIds: interactive.evaluation.cases.map(
              (result) => result.caseId
            ),
            correctnessOutputs: interactive.evaluation.cases.map(
              (result) => result.value
            ),
            selectedTraceStatus:
              interactive.evaluation.status,
            selectedTraceCaseIds: initialTraceCases.map(
              (result) => result.caseId
            ),
            selectedTraceEventCounts: initialTraceCases.map((result) =>
              traceEventCount(result.trace)
            ),
            backgroundMs: interactiveBackgroundMs,
            backgroundTraceCaseIds,
            backgroundTraceEventCounts,
            maximumActiveWorkers: interactiveMaximumActiveWorkers,
            workerUrls: interactiveWorkerUrls,
            observerWorkers: interactiveObservers,
            pythonWorkers: interactivePythonWorkers,
          },
          ...(compatibilityIsolation
            ? {
                compatibilityIsolation,
                compatibilityIsolationWorkerUrls,
                compatibilityIsolationMaximumActiveWorkers,
                compatibilityIsolationMs,
                judgeFallbackIsolation,
                judgeFallbackIsolationWorkerUrls,
                judgeFallbackIsolationMaximumActiveWorkers,
                judgeFallbackIsolationMs,
              }
            : {}),
          ...(fixture.language === 'csharp'
            ? { csharpBatchConcurrency, trustedPrewarm }
            : {}),
        };
      } finally {
        host.dispose();
      }
    }
    return results;
  } finally {
    globalThis.Worker = NativeWorker;
  }
}

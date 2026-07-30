import * as Effect from 'effect/Effect';
import type * as Scope from 'effect/Scope';
import {
  evaluateProjectJudgeBundle,
  type JudgeKernelProcessOutcome,
  type JudgeKernelSignal,
  type JudgeObservation,
  type JudgeProcessPlan,
  type JudgeProjectBundleV1,
  type JudgeProjectEvaluationOptions,
  type JudgeProjectPort,
  type JudgeProjectProcess,
  type JudgeProjectResultV1,
  type JudgeProjectWorkspace,
  type JudgeWorkspaceFile,
} from '../../packages/judge/src/index';
import {
  createBrowserProjectWorkspace,
  type CreateBrowserProjectWorkspaceOptions,
} from '../../packages/runtime-browser/src/project';
import {
  runtimeWorkspaceActorPreset,
  type KernelJournalRecord,
  type RuntimeCommandResult,
  type RuntimeFile,
  type RuntimeProjectSnapshot,
  type RuntimeWorkspace,
  type RuntimeWorkspaceProcess,
} from '../../packages/runtime-contracts/src/index';

export type BrowserProjectJudgeWorkspaceOptions = Omit<
  CreateBrowserProjectWorkspaceOptions,
  | 'cwd'
  | 'directories'
  | 'directoryMetadata'
  | 'entrypoint'
  | 'files'
  | 'kernel'
  | 'projectSession'
  | 'symlinks'
>;

export interface CreateBrowserProjectJudgeOptions {
  readonly workspace?: BrowserProjectJudgeWorkspaceOptions;
  readonly evaluation?: JudgeProjectEvaluationOptions;
}

export interface BrowserProjectJudge {
  evaluate(
    bundle: JudgeProjectBundleV1,
    options?: JudgeProjectEvaluationOptions
  ): Effect.Effect<
    JudgeProjectResultV1,
    import('../../packages/judge/src/index').JudgePlanError
  >;
  evaluatePromise(
    bundle: JudgeProjectBundleV1,
    options?: JudgeProjectEvaluationOptions
  ): Promise<JudgeProjectResultV1>;
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function workspaceRelativePath(
  absolutePath: string,
  workspaceRoot: string
): string {
  if (absolutePath === workspaceRoot) {
    throw new Error('Judge artifacts must point to files below the workspace root.');
  }
  if (absolutePath.startsWith(`${workspaceRoot}/`)) {
    return absolutePath.slice(workspaceRoot.length + 1);
  }
  if (absolutePath.startsWith('/.tracecode/judge/')) {
    return absolutePath.slice(1);
  }
  throw new Error(
    `Judge artifact path ${JSON.stringify(absolutePath)} is outside ` +
      `workspace root ${JSON.stringify(workspaceRoot)}.`
  );
}

function encodeFile(
  file: JudgeWorkspaceFile,
  workspaceRoot: string
): RuntimeFile {
  const path = workspaceRelativePath(file.path, workspaceRoot);
  if (typeof file.contents === 'string') {
    return {
      path,
      contents: file.contents,
      encoding: 'utf8',
    };
  }
  let binary = '';
  for (const byte of file.contents) binary += String.fromCharCode(byte);
  return {
    path,
    contents: btoa(binary),
    encoding: 'base64',
  };
}

function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function commandLine(plan: JudgeProcessPlan): string {
  return [plan.command, ...(plan.args ?? [])].map(shellWord).join(' ');
}

function terminationFor(
  result: RuntimeCommandResult,
  signal: JudgeKernelSignal | undefined
): JudgeKernelProcessOutcome['termination'] {
  if (signal && result.exitCode !== 0) {
    return {
      kind: 'signal',
      signal,
      exitCode: result.exitCode,
    };
  }
  if (result.exitCode === 0) {
    return { kind: 'exit', exitCode: 0 };
  }
  return {
    kind: 'failure',
    exitCode: result.exitCode,
    message:
      result.error?.message ||
      result.stderr.trim() ||
      `Process exited with status ${result.exitCode}.`,
  };
}

class BrowserProjectProcess implements JudgeProjectProcess {
  private signalName: JudgeKernelSignal | undefined;

  constructor(
    readonly sessionId: string,
    readonly pid: number,
    private readonly controller: AbortController,
    private readonly result: Promise<RuntimeCommandResult>,
    private readonly startedAt: number,
    private readonly timeoutMs: number | undefined
  ) {}

  wait(): Effect.Effect<JudgeKernelProcessOutcome, Error> {
    return Effect.tryPromise({
      try: async () => {
        const result = await this.result;
        const endedAt = Date.now();
        const timedOut =
          result.error?.code === 'ETIMEDOUT' ||
          (this.timeoutMs !== undefined &&
            result.exitCode === 124 &&
            endedAt - this.startedAt >= this.timeoutMs);
        return {
          sessionId: this.sessionId,
          pid: this.pid,
          termination: terminationFor(result, this.signalName),
          stdout: result.stdout,
          stderr: result.stderr,
          diagnostics: result.error
            ? [{
                severity: 'error' as const,
                code: result.error.code,
                source: 'tracekernel',
                message: result.error.message,
                ...(result.error.path ? { path: result.error.path } : {}),
              }]
            : [],
          timings: {
            totalMs: endedAt - this.startedAt,
          },
          timedOut,
          startedAt: this.startedAt,
          endedAt,
        };
      },
      catch: errorFromUnknown,
    });
  }

  signal(signal: JudgeKernelSignal): Effect.Effect<void, Error> {
    return Effect.sync(() => {
      this.signalName = signal;
      if (!this.controller.signal.aborted) {
        this.controller.abort({ signal });
      }
    });
  }
}

function processObservations(
  journal: readonly KernelJournalRecord[]
): readonly JudgeObservation[] {
  const processStarts = new Map<number, {
    readonly actor?: string;
    readonly argv?: string;
    readonly ts?: string;
  }>();
  const observations: JudgeObservation[] = [];

  for (const record of journal) {
    if (record.kind === 'process' && record.op === 'exec') {
      processStarts.set(record.pid, record);
      continue;
    }
    if (record.kind === 'process' && record.op === 'exit') {
      const start = processStarts.get(record.pid);
      observations.push({
        seq: record.seq,
        kind: 'process',
        actor: record.actor ?? start?.actor ?? 'judge',
        command: start?.argv?.split(/\s/u, 1)[0] ?? '',
        argv: start?.argv ?? '',
        exitCode: record.exitCode ?? 1,
        ...(start?.ts ? { startedAt: start.ts } : {}),
        ...(record.ts ? { completedAt: record.ts } : {}),
      });
      continue;
    }
    if (record.kind === 'fs') {
      if (record.op === 'write' || record.op === 'delete' || record.op === 'rename') {
        observations.push({
          seq: record.seq,
          kind: 'edit',
          actor: record.actor,
          path: record.path,
          ...(record.ts ? { observedAt: record.ts } : {}),
        });
      }
      continue;
    }
    if (record.kind === 'http') {
      observations.push({
        seq: record.seq,
        kind: 'http',
        actor: record.actor ?? 'judge',
        method: record.method,
        host: record.host,
        path: record.path,
        status: record.status ?? null,
        via: record.via,
        ...(record.pid === undefined ? {} : { pid: record.pid }),
        ...(record.authFingerprint
          ? { authFingerprint: record.authFingerprint }
          : {}),
        ...(record.meta ? { meta: record.meta } : {}),
        ...(record.ts ? { observedAt: record.ts } : {}),
      });
    }
  }

  return Object.freeze(observations);
}

function snapshotOptions(
  snapshot: RuntimeProjectSnapshot | undefined
): Partial<CreateBrowserProjectWorkspaceOptions> {
  if (!snapshot) return {};
  return {
    files: snapshot.files,
    symlinks: snapshot.symlinks,
    directories: snapshot.directories,
    directoryMetadata: snapshot.directoryMetadata,
    entrypoint: snapshot.entrypoint,
    cwd: snapshot.cwd,
  };
}

class BrowserProjectWorkspace
  implements JudgeProjectWorkspace<RuntimeProjectSnapshot> {
  readonly id: string;
  private readonly process: RuntimeWorkspaceProcess;
  private observationStartSeq = 0;

  constructor(private readonly workspace: RuntimeWorkspace) {
    this.id = workspace.kernel.info.workspace.id;
    this.process = workspace.kernel.createProcess({
      name: 'judge',
      actor: runtimeWorkspaceActorPreset('hidden-test', {
        id: 'judge',
        capabilities: {
          read: ['**'],
          write: ['**'],
          delete: ['**'],
          execute: true,
          http: {
            listen: true,
            dispatch: true,
            externalFetch: true,
            readDiagnostics: true,
          },
        },
      }),
      cwd: workspace.cwd,
      signalPolicy: 'system-only',
    });
  }

  mount(files: readonly JudgeWorkspaceFile[]): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: async () => {
        await this.workspace.writeFiles(
          files.map((file) =>
            encodeFile(file, this.workspace.kernel.info.workspace.root)
          )
        );
        this.observationStartSeq =
          this.workspace.journal().at(-1)?.seq ?? 0;
      },
      catch: errorFromUnknown,
    });
  }

  snapshot(): Effect.Effect<RuntimeProjectSnapshot, Error> {
    return Effect.tryPromise({
      try: () => this.workspace.snapshot({ includeHidden: true }),
      catch: errorFromUnknown,
    });
  }

  run(plan: JudgeProcessPlan): Effect.Effect<JudgeProjectProcess, Error> {
    return Effect.tryPromise({
      try: async () => {
        const controller = new AbortController();
        const startedAt = Date.now();
        let resolvePid!: (pid: number) => void;
        let rejectPid!: (error: Error) => void;
        let started = false;
        const pidPromise = new Promise<number>((resolve, reject) => {
          resolvePid = resolve;
          rejectPid = reject;
        });
        const result = this.process.runCommand(commandLine(plan), {
          cwd: plan.cwd,
          env: plan.env ? { ...plan.env } : undefined,
          signal: controller.signal,
          executionLimits:
            plan.timeoutMs === undefined
              ? undefined
              : { timeoutMs: plan.timeoutMs },
          presentation: 'programmatic',
          includeHiddenFiles: true,
          onProcessStart: (pid) => {
            started = true;
            resolvePid(pid);
          },
        });
        void result.then(
          () => {
            if (!started) resolvePid(this.process.pid);
          },
          (error) => {
            if (!started) rejectPid(errorFromUnknown(error));
          }
        );
        const pid = await pidPromise;
        return new BrowserProjectProcess(
          this.id,
          pid,
          controller,
          result,
          startedAt,
          plan.timeoutMs
        );
      },
      catch: errorFromUnknown,
    });
  }

  observations(): Effect.Effect<readonly JudgeObservation[], Error> {
    return Effect.sync(() =>
      processObservations(
        this.workspace.journal(this.observationStartSeq + 1)
      )
    );
  }

  dispose(): Promise<void> {
    this.process.dispose();
    return this.workspace
      .destroy({ reason: 'judge-evaluation-complete' })
      .finally(() => this.workspace.dispose());
  }
}

export class BrowserProjectJudgePort
  implements JudgeProjectPort<RuntimeProjectSnapshot> {
  constructor(
    private readonly options: BrowserProjectJudgeWorkspaceOptions = {}
  ) {}

  openWorkspace(openOptions: {
    readonly cwd?: string;
    readonly snapshot?: RuntimeProjectSnapshot;
  } = {}): Effect.Effect<
    JudgeProjectWorkspace<RuntimeProjectSnapshot>,
    Error,
    Scope.Scope
  > {
    return Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const workspace = await createBrowserProjectWorkspace({
            ...this.options,
            ...snapshotOptions(openOptions.snapshot),
            cwd: openOptions.cwd ?? openOptions.snapshot?.cwd,
          });
          return new BrowserProjectWorkspace(workspace);
        },
        catch: errorFromUnknown,
      }),
      (workspace) =>
        Effect.promise(() => workspace.dispose()).pipe(
          Effect.catchAll(() => Effect.void)
        )
    );
  }
}

export function createBrowserProjectJudge(
  options: CreateBrowserProjectJudgeOptions = {}
): BrowserProjectJudge {
  const port = new BrowserProjectJudgePort(options.workspace);
  const evaluate = (
    bundle: JudgeProjectBundleV1,
    evaluation: JudgeProjectEvaluationOptions = {}
  ) =>
    evaluateProjectJudgeBundle(port, bundle, {
      ...options.evaluation,
      ...evaluation,
      evaluators:
        evaluation.evaluators ??
        options.evaluation?.evaluators,
      artifactResolver:
        evaluation.artifactResolver ??
        options.evaluation?.artifactResolver,
    });
  return Object.freeze({
    evaluate,
    evaluatePromise: (
      bundle: JudgeProjectBundleV1,
      evaluation?: JudgeProjectEvaluationOptions
    ) =>
      Effect.runPromise(evaluate(bundle, evaluation)),
  });
}

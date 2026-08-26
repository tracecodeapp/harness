import * as Effect from 'effect/Effect';
import type {
  TraceKernelFileSystemImage,
  TraceKernelPrincipal,
  TraceKernelProcess,
  TraceKernelProcessSnapshot,
  TraceKernelSession,
  TraceKernelHost,
  TraceKernelSignal,
  TraceKernelRuntimeSyscallPolicy,
} from '@tracecode/tracekernel';
import type {
  JudgeKernelPort,
  JudgeKernelProcess,
  JudgeKernelSession,
  JudgeKernelSignal,
  JudgeKernelSpawnRequest,
  JudgeRuntimeControlPort,
} from './port';
import type {
  JudgeTermination,
  JudgeWorkspaceFile,
} from './model';

export const JUDGE_INVOCATION_ID_ENV =
  'TRACECODE_JUDGE_INVOCATION_ID' as const;

const DEFAULT_GRADER: TraceKernelPrincipal = Object.freeze({
  id: 'tracecode-judge',
  kind: 'grader',
});

function bytes(contents: string | Uint8Array): Uint8Array {
  return typeof contents === 'string'
    ? new TextEncoder().encode(contents)
    : Uint8Array.from(contents);
}

function parentDirectories(path: string): readonly string[] {
  const parts = path.split('/').filter(Boolean);
  const directories: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    directories.push(`/${parts.slice(0, index).join('/')}`);
  }
  return directories;
}

function termination(
  snapshot: TraceKernelProcessSnapshot
): JudgeTermination {
  const value = snapshot.termination;
  if (value) return Object.freeze({ ...value });
  return Object.freeze({
    kind: 'failure',
    exitCode: 1,
    message: 'TraceKernel process completed without a termination record.',
  });
}

function kernelSignal(signal: JudgeKernelSignal): TraceKernelSignal {
  return signal;
}

class TraceKernelJudgeProcess implements JudgeKernelProcess {
  readonly pid: number;

  constructor(
    readonly sessionId: string,
    private readonly process: TraceKernelProcess,
    private readonly invocationId: string,
    private readonly control: JudgeRuntimeControlPort,
    private readonly timeoutDeadlineAt?: number
  ) {
    this.pid = process.pid;
  }

  wait() {
    return this.process.wait().pipe(
      Effect.flatMap((snapshot) =>
        this.control.take(this.invocationId).pipe(
          Effect.map((controlOutput) => Object.freeze({
            sessionId: this.sessionId,
            pid: snapshot.pid,
            termination: termination(snapshot),
            stdout: snapshot.stdout,
            stderr: snapshot.stderr,
            diagnostics: Object.freeze([
              ...(controlOutput?.diagnostics ?? []),
            ]),
            ...(controlOutput?.timings
              ? { timings: Object.freeze({ ...controlOutput.timings }) }
              : {}),
            ...(controlOutput && 'value' in controlOutput
              ? { structuredResult: controlOutput.value }
              : {}),
            ...(controlOutput && 'trace' in controlOutput
              ? { trace: controlOutput.trace }
              : {}),
            ...(controlOutput?.batch
              ? { batch: Object.freeze([...controlOutput.batch]) }
              : {}),
            timedOut:
              this.timeoutDeadlineAt !== undefined &&
              snapshot.termination?.kind === 'signal' &&
              (snapshot.endedAt ?? 0) >= this.timeoutDeadlineAt,
            ...(snapshot.startedAt === undefined
              ? {}
              : { startedAt: snapshot.startedAt }),
            ...(snapshot.endedAt === undefined
              ? {}
              : { endedAt: snapshot.endedAt }),
          }))
        )
      ),
      Effect.ensuring(this.control.discard(this.invocationId))
    );
  }

  signal(signal: JudgeKernelSignal): Effect.Effect<void, Error> {
    return this.process.signal(kernelSignal(signal));
  }
}

class TraceKernelJudgeSession
  implements JudgeKernelSession<TraceKernelFileSystemImage> {
  readonly id: string;

  constructor(
    private readonly session: TraceKernelSession,
    private readonly runtimeControl: JudgeRuntimeControlPort,
    private readonly grader: TraceKernelPrincipal,
    private readonly runtimeSyscalls: TraceKernelRuntimeSyscallPolicy
  ) {
    this.id = session.id;
  }

  mount(files: readonly JudgeWorkspaceFile[]): Effect.Effect<void, Error> {
    return Effect.gen(this, function* () {
      const createdDirectories = new Set<string>();
      for (const file of files) {
        for (const directory of parentDirectories(file.path)) {
          if (createdDirectories.has(directory)) continue;
          yield* this.session.mkdir(directory, { recursive: true });
          createdDirectories.add(directory);
        }
        yield* this.session.writeFile(file.path, bytes(file.contents));
      }
    });
  }

  snapshot(): Effect.Effect<TraceKernelFileSystemImage, Error> {
    return this.session.fileSystem.exportImage();
  }

  spawn(
    request: JudgeKernelSpawnRequest
  ): Effect.Effect<JudgeKernelProcess, Error> {
    return Effect.gen(this, function* () {
      const invocationId = yield* this.runtimeControl.begin(request.invocation);
      const process = yield* this.session.spawn({
        runtime: request.runtime,
        command: request.process.command,
        args: request.process.args,
        cwd: request.process.cwd,
        env: Object.freeze({
          ...(request.process.env ?? {}),
          [JUDGE_INVOCATION_ID_ENV]: invocationId,
        }),
        owner: this.grader,
        protected: true,
        visible: false,
        runtimeSyscalls: this.runtimeSyscalls,
      }).pipe(
        Effect.tapError(() => this.runtimeControl.discard(invocationId))
      );
      const watchdog = request.process.timeoutMs === undefined
        ? undefined
        : yield* this.session.configureProcessWatchdog(process, 'arm', {
          timeoutMs: request.process.timeoutMs,
          signal: 'SIGKILL',
        }).pipe(
          Effect.tapError(() =>
            process.signal('SIGKILL').pipe(
              Effect.catchAll(() => Effect.void)
            )
          ),
          Effect.tapError(() => this.runtimeControl.discard(invocationId))
        );
      return new TraceKernelJudgeProcess(
        this.id,
        process,
        invocationId,
        this.runtimeControl,
        watchdog?.deadlineAt
      );
    });
  }
}

export interface TraceKernelJudgePortOptions {
  readonly host: TraceKernelHost;
  readonly runtimeControl: JudgeRuntimeControlPort;
  readonly grader?: TraceKernelPrincipal;
  /**
   * Exact TKFS files the algorithm runtime adapter may read atomically.
   * All other runtime-visible syscalls are disabled by TraceKernel.
   */
  readonly readableFiles?: readonly string[];
}

/**
 * Binds Judge's neutral execution port to TraceKernel sessions and processes.
 *
 * Each session is scope-owned. Processes are protected, invisible grader
 * processes. The only value shared with a runtime provider is an opaque
 * invocation id; case inputs, diagnostics, and structured results remain on
 * the private runtime control port.
 */
export class TraceKernelJudgePort
  implements JudgeKernelPort<TraceKernelFileSystemImage> {
  private readonly host: TraceKernelHost;
  private readonly runtimeControl: JudgeRuntimeControlPort;
  private readonly grader: TraceKernelPrincipal;
  private readonly runtimeSyscalls: TraceKernelRuntimeSyscallPolicy;

  constructor(options: TraceKernelJudgePortOptions) {
    this.host = options.host;
    this.runtimeControl = options.runtimeControl;
    this.grader = options.grader ?? DEFAULT_GRADER;
    this.runtimeSyscalls = Object.freeze({
      profile: 'algorithm',
      readableFiles: Object.freeze([
        ...new Set(options.readableFiles ?? []),
      ]),
    });
  }

  openSession(options: {
    readonly cwd?: string;
    readonly snapshot?: TraceKernelFileSystemImage;
  } = {}) {
    return this.host.openSession({
      cwd: options.cwd,
      fileSystemImage: options.snapshot,
    }).pipe(
      Effect.map((session) =>
        new TraceKernelJudgeSession(
          session,
          this.runtimeControl,
          this.grader,
          this.runtimeSyscalls
        )
      )
    );
  }
}

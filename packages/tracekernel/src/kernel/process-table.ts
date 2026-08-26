import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import type { TraceKernelDescriptorInheritanceError } from '../descriptors';
import {
  TraceKernelChildProcessError,
  TraceKernelInvalidArgumentError,
  TraceKernelProcessLimitError,
  TraceKernelProcessPermissionError,
  TraceKernelProcessStateError,
  TraceKernelSessionClosedError,
} from '../errors';
import type {
  TraceKernelPrincipal,
  TraceKernelProcessSchedulingState,
  TraceKernelProcessSnapshot,
  TraceKernelProcessSpec,
  TraceKernelRuntimeSyscallPolicy,
  TraceKernelSignal,
} from '../model';
import type { TraceKernelProcessInfo } from '../syscalls';
import {
  SYSTEM_PRINCIPAL,
  TraceKernelProcess,
  processInfoProjection,
  type MutableProcessRecord,
} from './process';

interface TraceKernelProcessTableOptions {
  readonly sessionId: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly maxDescriptorsPerProcess: number;
  readonly maxProcesses: number;
  readonly signalGracePeriodMs: number;
  readonly controllingTerminalForSession: (sessionId: number) => string | undefined;
}

function invalidRuntimeSyscallPolicy(
  argument: string
): TraceKernelInvalidArgumentError {
  return new TraceKernelInvalidArgumentError({
    code: 'EINVAL',
    argument,
    message: `EINVAL: invalid ${argument}`,
  });
}

function normalizeRuntimeSyscallPolicy(
  policy: unknown
): TraceKernelRuntimeSyscallPolicy {
  if (policy === undefined) {
    return Object.freeze({ profile: 'unrestricted' as const });
  }
  if (typeof policy !== 'object' || policy === null) {
    throw invalidRuntimeSyscallPolicy('runtimeSyscalls');
  }

  const profile = (policy as { readonly profile?: unknown }).profile;
  if (profile === 'unrestricted') {
    return Object.freeze({ profile });
  }
  if (profile !== 'algorithm') {
    throw invalidRuntimeSyscallPolicy('runtimeSyscalls.profile');
  }

  const readableFiles = (
    policy as { readonly readableFiles?: unknown }
  ).readableFiles;
  if (
    !Array.isArray(readableFiles) ||
    !readableFiles.every((path) => typeof path === 'string')
  ) {
    throw invalidRuntimeSyscallPolicy(
      'runtimeSyscalls.readableFiles'
    );
  }
  return Object.freeze({
    profile,
    readableFiles: Object.freeze([...new Set(readableFiles)]),
  });
}

/**
 * Authoritative process registry for one TraceKernel session.
 *
 * This state machine owns PID allocation, live/zombie membership, topology,
 * child retention, wait/reap coordination, visibility, scheduling metadata,
 * and signal target selection. Resource installation and runtime execution
 * remain session concerns.
 */
export class TraceKernelProcessTable {
  private readonly processes = new Map<number, TraceKernelProcess>();
  private readonly exitedChildren = new Map<number, TraceKernelProcess>();
  private readonly initRetainedProcesses = new Set<number>();
  private readonly waitingChildren = new Set<number>();
  private readonly reapedBeforeUnregister = new Set<number>();
  private readonly childWaiters = new Set<Deferred.Deferred<void>>();
  private nextPid = 100;
  private closed = false;

  constructor(private readonly options: TraceKernelProcessTableOptions) {}

  register(
    spec: TraceKernelProcessSpec,
    started: Deferred.Deferred<void, TraceKernelProcessStateError>
  ): TraceKernelProcess {
    if (this.closed) {
      throw new TraceKernelSessionClosedError({
        sessionId: this.options.sessionId,
        message: `TraceKernel session ${this.options.sessionId} is closed.`,
      });
    }
    if (this.processes.size + this.exitedChildren.size >= this.options.maxProcesses) {
      throw new TraceKernelProcessLimitError({
        code: 'EAGAIN',
        maxProcesses: this.options.maxProcesses,
        message: `EAGAIN: session process limit ${this.options.maxProcesses} reached`,
      });
    }
    const ppid = spec.parentPid ?? 1;
    const parent = ppid === 1 ? undefined : this.processes.get(ppid);
    if (ppid !== 1 && !parent) {
      throw new TraceKernelProcessStateError({
        pid: ppid,
        message: `ESRCH: parent process ${ppid} does not exist in session ${this.options.sessionId}`,
      });
    }
    const pid = this.nextPid;
    const parentSnapshot = parent?.snapshot();
    if (
      spec.sessionId !== undefined &&
      (!Number.isSafeInteger(spec.sessionId) || spec.sessionId < 0)
    ) {
      throw new TraceKernelInvalidArgumentError({
        code: 'EINVAL',
        argument: 'sessionId',
        message: `EINVAL: invalid session id ${spec.sessionId}`,
      });
    }
    if (
      spec.processGroupId !== undefined &&
      (!Number.isSafeInteger(spec.processGroupId) || spec.processGroupId < 0)
    ) {
      throw new TraceKernelInvalidArgumentError({
        code: 'EINVAL',
        argument: 'processGroupId',
        message: `EINVAL: invalid process group id ${spec.processGroupId}`,
      });
    }
    const startsNewSession = spec.sessionId === 0;
    const inheritedSid = parentSnapshot?.sid ?? pid;
    if (
      parent &&
      spec.sessionId !== undefined &&
      !startsNewSession &&
      spec.sessionId !== inheritedSid
    ) {
      throw new TraceKernelInvalidArgumentError({
        code: 'EINVAL',
        argument: 'sessionId',
        message: `EINVAL: child session ${spec.sessionId} does not match parent session ${inheritedSid}`,
      });
    }
    const sid = startsNewSession
      ? pid
      : parent
        ? inheritedSid
        : spec.sessionId ?? inheritedSid;
    const pgid = startsNewSession || spec.processGroupId === 0
      ? pid
      : spec.processGroupId ?? parentSnapshot?.pgid ?? pid;
    if (
      pgid !== pid &&
      !this.hasProcessGroup(pgid, sid)
    ) {
      throw new TraceKernelInvalidArgumentError({
        code: 'EINVAL',
        argument: 'processGroupId',
        message: `EINVAL: process group ${pgid} does not exist in session ${sid}`,
      });
    }
    const runtimeSyscalls = normalizeRuntimeSyscallPolicy(
      spec.runtimeSyscalls
    );
    this.nextPid += 1;
    const controllingTerminalId = !startsNewSession
      ? parentSnapshot?.controllingTerminalId ??
        this.options.controllingTerminalForSession(sid)
      : undefined;
    const record: MutableProcessRecord = {
      pid,
      ppid,
      pgid,
      sid,
      ...(controllingTerminalId === undefined
        ? {}
        : { controllingTerminalId }),
      phase: 'created',
      schedulingState: 'queued',
      runtime: spec.runtime,
      command: spec.command,
      args: Object.freeze([...(spec.args ?? [])]),
      cwd: spec.cwd ?? this.options.cwd,
      env: Object.freeze({ ...this.options.env, ...(spec.env ?? {}) }),
      owner: spec.owner ?? SYSTEM_PRINCIPAL,
      protected: spec.protected ?? false,
      visible: spec.visible ?? true,
      runtimeSyscalls,
      stdout: '',
      stderr: '',
    };
    const process = new TraceKernelProcess(
      record,
      started,
      this.options.maxDescriptorsPerProcess,
      this.options.signalGracePeriodMs
    );
    this.processes.set(pid, process);
    if (ppid === 1 && spec.retainOnExit === true) {
      this.initRetainedProcesses.add(pid);
    }
    return process;
  }

  unregister(pid: number): void {
    const exited = this.processes.get(pid);
    this.processes.delete(pid);
    const alreadyReaped = this.reapedBeforeUnregister.delete(pid);
    if (exited) {
      const snapshot = exited.snapshot();
      if (
        snapshot.phase === 'exited' &&
        !alreadyReaped &&
        (
          snapshot.ppid !== 1 ||
          this.initRetainedProcesses.has(pid)
        )
      ) {
        this.exitedChildren.set(pid, exited);
      } else {
        this.initRetainedProcesses.delete(pid);
      }
    } else {
      this.initRetainedProcesses.delete(pid);
    }
    for (const process of this.processes.values()) {
      process.reparent(pid, 1);
    }
    for (const [childPid, child] of this.exitedChildren) {
      if (childPid === pid) continue;
      if (child.snapshot().ppid === pid) {
        child.reparent(pid, 1);
        this.exitedChildren.delete(childPid);
      }
    }
    Effect.runSync(this.notifyChildWaiters());
  }

  inheritDescriptors(
    process: TraceKernelProcess,
    spec: TraceKernelProcessSpec
  ): Effect.Effect<
    void,
    TraceKernelProcessStateError | TraceKernelDescriptorInheritanceError
  > {
    if (
      spec.inheritDescriptors === undefined &&
      (spec.descriptorMappings?.length ?? 0) === 0
    ) {
      return Effect.void;
    }
    const parentPid = spec.parentPid ?? 1;
    const parent = this.processes.get(parentPid);
    if (!parent || parent === process) {
      return Effect.fail(new TraceKernelProcessStateError({
        pid: parentPid,
        message: `ESRCH: descriptor inheritance requires a live parent process in session ${this.options.sessionId}`,
      }));
    }
    return Effect.gen(function* () {
      if (spec.inheritDescriptors !== undefined) {
        yield* process.descriptors.inherit(
          parent.descriptors,
          spec.inheritDescriptors === 'all' ? undefined : spec.inheritDescriptors
        );
      }
      if (spec.descriptorMappings && spec.descriptorMappings.length > 0) {
        yield* process.descriptors.inheritMapped(
          parent.descriptors,
          spec.descriptorMappings.map(({ parentFd, childFd }) => ({
            sourceFd: parentFd,
            targetFd: childFd,
          }))
        );
      }
    });
  }

  waitChild(
    parent: TraceKernelProcess,
    pid: number,
    options: { readonly noHang?: boolean } = {}
  ): Effect.Effect<
    TraceKernelProcessSnapshot | undefined,
    TraceKernelProcessStateError | TraceKernelChildProcessError
  > {
    return Effect.gen(this, function* () {
      const selector = Math.trunc(pid);
      if (!Number.isSafeInteger(pid)) {
        return yield* Effect.fail(new TraceKernelChildProcessError({
          code: 'ECHILD',
          pid: selector,
          message: `ECHILD: invalid child selector ${pid}`,
        }));
      }
      yield* this.assertOwned(parent);
      const snapshot = parent.snapshot();
      return yield* this.waitChildSelection(
        snapshot.pid,
        snapshot.pgid,
        selector,
        options,
        false
      );
    });
  }

  waitInitChild(
    pid: number,
    options: { readonly noHang?: boolean } = {}
  ): Effect.Effect<
    TraceKernelProcessSnapshot | undefined,
    TraceKernelProcessStateError | TraceKernelChildProcessError
  > {
    return Effect.suspend(() => {
      const selector = Math.trunc(pid);
      if (!Number.isSafeInteger(pid)) {
        return Effect.fail(new TraceKernelChildProcessError({
          code: 'ECHILD',
          pid: selector,
          message: `ECHILD: invalid child selector ${pid}`,
        }));
      }
      return this.waitChildSelection(1, 1, selector, options, true);
    });
  }

  processSnapshots(
    requester: TraceKernelPrincipal = SYSTEM_PRINCIPAL
  ): readonly TraceKernelProcessSnapshot[] {
    return this.visibleProcessSnapshots(this.processes.values(), requester);
  }

  processTableSnapshots(
    requester: TraceKernelPrincipal = SYSTEM_PRINCIPAL
  ): readonly TraceKernelProcessSnapshot[] {
    return this.visibleProcessSnapshots(this.allProcesses(), requester);
  }

  setSchedulingState(
    process: TraceKernelProcess,
    state: TraceKernelProcessSchedulingState
  ): Effect.Effect<TraceKernelProcessSchedulingState, TraceKernelProcessStateError> {
    return this.assertOwned(process).pipe(
      Effect.tap(() => Effect.sync(() => process.setSchedulingState(state))),
      Effect.as(state)
    );
  }

  processIdentity(
    caller: TraceKernelProcess,
    requestedPid?: number
  ): Effect.Effect<
    {
      readonly pid: number;
      readonly ppid: number;
      readonly pgid: number;
      readonly sid: number;
    },
    TraceKernelProcessStateError
  > {
    return Effect.gen(this, function* () {
      yield* this.assertOwned(caller);
      const pid = requestedPid === undefined || requestedPid === 0
        ? caller.pid
        : Math.trunc(requestedPid);
      if (!Number.isSafeInteger(requestedPid ?? 0) || pid <= 0) {
        return yield* this.processNotFound(
          pid,
          `ESRCH: invalid process identity target ${requestedPid}`
        );
      }
      const target = this.get(pid);
      if (!target) {
        return yield* this.processNotFound(pid);
      }
      const callerOwner = caller.snapshot().owner;
      const snapshot = target.snapshot();
      if (
        !snapshot.visible &&
        callerOwner.kind !== 'system' &&
        (
          callerOwner.id !== snapshot.owner.id ||
          callerOwner.kind !== snapshot.owner.kind
        )
      ) {
        return yield* this.processNotFound(pid);
      }
      return {
        pid: snapshot.pid,
        ppid: snapshot.ppid,
        pgid: snapshot.pgid,
        sid: snapshot.sid,
      };
    });
  }

  processInfo(
    caller: TraceKernelProcess,
    requestedPid?: number
  ): Effect.Effect<TraceKernelProcessInfo, TraceKernelProcessStateError> {
    return Effect.gen(this, function* () {
      const identity = yield* this.processIdentity(caller, requestedPid);
      const target = this.get(identity.pid);
      if (!target) return yield* this.processNotFound(identity.pid);
      return processInfoProjection(target.snapshot());
    });
  }

  processList(
    caller: TraceKernelProcess
  ): Effect.Effect<readonly TraceKernelProcessInfo[], TraceKernelProcessStateError> {
    return this.assertOwned(caller).pipe(
      Effect.map(() =>
        Object.freeze(
          this.processTableSnapshots(caller.snapshot().owner)
            .map(processInfoProjection)
        )
      )
    );
  }

  processEnvironment(
    caller: TraceKernelProcess
  ): Effect.Effect<
    Readonly<Record<string, string>>,
    TraceKernelProcessStateError
  > {
    return this.assertOwned(caller).pipe(
      Effect.map(() => Object.freeze({ ...caller.snapshot().env }))
    );
  }

  createProcessSession(
    process: TraceKernelProcess
  ): Effect.Effect<
    number,
    TraceKernelProcessStateError | TraceKernelProcessPermissionError
  > {
    return Effect.gen(this, function* () {
      yield* this.assertOwned(process);
      const snapshot = process.snapshot();
      if (snapshot.pgid === snapshot.pid) {
        return yield* Effect.fail(new TraceKernelProcessPermissionError({
          code: 'EPERM',
          pid: process.pid,
          requesterId: snapshot.owner.id,
          message: `EPERM: process ${process.pid} is already a process-group leader`,
        }));
      }
      process.setTopology(process.pid, process.pid);
      process.setControllingTerminal(undefined);
      yield* this.notifyChildWaiters();
      return process.pid;
    });
  }

  setProcessGroup(
    caller: TraceKernelProcess,
    targetPid: number,
    processGroupId: number
  ): Effect.Effect<
    number,
    TraceKernelProcessStateError |
      TraceKernelProcessPermissionError |
      TraceKernelInvalidArgumentError
  > {
    return Effect.gen(this, function* () {
      yield* this.assertOwned(caller);
      const requestedPid = Math.trunc(targetPid);
      const requestedGroup = Math.trunc(processGroupId);
      if (
        !Number.isSafeInteger(targetPid) ||
        !Number.isSafeInteger(processGroupId) ||
        requestedPid < 0 ||
        requestedGroup < 0
      ) {
        return yield* Effect.fail(new TraceKernelInvalidArgumentError({
          code: 'EINVAL',
          argument: 'setpgid',
          message: `EINVAL: invalid setpgid(${targetPid}, ${processGroupId})`,
        }));
      }
      const target = requestedPid === 0 ? caller : this.processes.get(requestedPid);
      if (!target) return yield* this.processNotFound(requestedPid);
      if (target !== caller) {
        return yield* Effect.fail(new TraceKernelProcessPermissionError({
          code: 'EPERM',
          pid: target.pid,
          requesterId: caller.snapshot().owner.id,
          message: 'EPERM: a running process may only change its own process group',
        }));
      }
      const snapshot = target.snapshot();
      if (snapshot.sid === snapshot.pid) {
        return yield* Effect.fail(new TraceKernelProcessPermissionError({
          code: 'EPERM',
          pid: target.pid,
          requesterId: snapshot.owner.id,
          message: `EPERM: session leader ${target.pid} cannot change process group`,
        }));
      }
      const pgid = requestedGroup === 0 ? target.pid : requestedGroup;
      if (pgid !== target.pid && !this.hasProcessGroup(pgid, snapshot.sid)) {
        return yield* Effect.fail(new TraceKernelInvalidArgumentError({
          code: 'EINVAL',
          argument: 'processGroupId',
          message: `EINVAL: process group ${pgid} does not exist in session ${snapshot.sid}`,
        }));
      }
      target.setTopology(pgid, snapshot.sid);
      yield* this.notifyChildWaiters();
      return pgid;
    });
  }

  signalProcess(
    requester: TraceKernelPrincipal,
    pid: number,
    signal: TraceKernelSignal
  ): Effect.Effect<
    void,
    TraceKernelProcessStateError | TraceKernelProcessPermissionError
  > {
    const process = this.processes.get(pid);
    return process
      ? process.signal(signal, requester)
      : this.processNotFound(pid);
  }

  signalProcessTarget(
    requester: TraceKernelPrincipal,
    caller: TraceKernelProcess,
    targetPid: number,
    signal: TraceKernelSignal
  ): Effect.Effect<
    void,
    TraceKernelProcessStateError | TraceKernelProcessPermissionError
  > {
    return Effect.gen(this, function* () {
      yield* this.assertOwned(caller);
      const selector = Math.trunc(targetPid);
      if (!Number.isSafeInteger(targetPid)) {
        return yield* this.processNotFound(
          selector,
          `ESRCH: invalid process selector ${targetPid}`
        );
      }
      if (selector > 0) {
        return yield* this.signalProcess(requester, selector, signal);
      }
      const callerSnapshot = caller.snapshot();
      const candidates = this.activeProcesses().filter((process) => {
        const snapshot = process.snapshot();
        if (selector === -1) return snapshot.pid !== caller.pid;
        const processGroupId = selector === 0
          ? callerSnapshot.pgid
          : -selector;
        return snapshot.pgid === processGroupId;
      });
      if (candidates.length === 0) {
        return yield* this.processNotFound(
          selector,
          selector === -1
            ? `ESRCH: no other processes exist in session ${this.options.sessionId}`
            : `ESRCH: process group ${selector === 0 ? callerSnapshot.pgid : -selector} does not exist in session ${this.options.sessionId}`
        );
      }
      const deliveries = yield* Effect.forEach(
        candidates,
        (process) => process.signal(signal, requester).pipe(
          Effect.match({
            onFailure: (error) => ({ delivered: false as const, error }),
            onSuccess: () => ({ delivered: true as const }),
          })
        ),
        { concurrency: 'unbounded' }
      );
      if (deliveries.some((delivery) => delivery.delivered)) return;
      const denied = deliveries.find(
        (delivery): delivery is {
          readonly delivered: false;
          readonly error: TraceKernelProcessPermissionError;
        } => !delivery.delivered
      );
      if (denied) return yield* Effect.fail(denied.error);
    });
  }

  activeProcesses(): readonly TraceKernelProcess[] {
    return [...this.processes.values()];
  }

  getActive(pid: number): TraceKernelProcess | undefined {
    return this.processes.get(pid);
  }

  get(pid: number): TraceKernelProcess | undefined {
    return this.processes.get(pid) ?? this.exitedChildren.get(pid);
  }

  hasActive(pid: number): boolean {
    return this.processes.has(pid);
  }

  hasProcessGroup(processGroupId: number, sessionId: number): boolean {
    return this.activeProcesses().some((candidate) => {
      const snapshot = candidate.snapshot();
      return snapshot.pgid === processGroupId && snapshot.sid === sessionId;
    });
  }

  assertOwned(
    process: TraceKernelProcess
  ): Effect.Effect<void, TraceKernelProcessStateError> {
    return !this.closed && this.processes.get(process.pid) === process
      ? Effect.void
      : Effect.fail(new TraceKernelProcessStateError({
          pid: process.pid,
          message: this.closed
            ? `Session ${this.options.sessionId} is closed.`
            : `Process ${process.pid} is not running in session ${this.options.sessionId}.`,
        }));
  }

  close(): void {
    this.closed = true;
  }

  clear(): void {
    this.processes.clear();
    this.exitedChildren.clear();
    this.initRetainedProcesses.clear();
    this.waitingChildren.clear();
    this.reapedBeforeUnregister.clear();
    this.childWaiters.clear();
  }

  private waitChildSelection(
    parentPid: number,
    parentProcessGroupId: number,
    selector: number,
    options: { readonly noHang?: boolean },
    requireInitRetention: boolean
  ): Effect.Effect<
    TraceKernelProcessSnapshot | undefined,
    TraceKernelProcessStateError | TraceKernelChildProcessError
  > {
    return Effect.gen(this, function* () {
      const changed = yield* Deferred.make<void>();
      this.childWaiters.add(changed);
      const candidates = this.waitableChildren(
        parentPid,
        parentProcessGroupId,
        selector,
        requireInitRetention
      );
      if (candidates.length === 0) {
        this.childWaiters.delete(changed);
        return yield* Effect.fail(new TraceKernelChildProcessError({
          code: 'ECHILD',
          pid: selector,
          message: `ECHILD: selector ${selector} has no unreaped children of process ${parentPid}`,
        }));
      }
      const child = candidates.find(
        (candidate) => candidate.snapshot().phase === 'exited'
      );
      if (!child && options.noHang) {
        this.childWaiters.delete(changed);
        return undefined;
      }
      if (!child) {
        yield* Deferred.await(changed).pipe(
          Effect.ensuring(Effect.sync(() => {
            this.childWaiters.delete(changed);
          }))
        );
        return yield* this.waitChildSelection(
          parentPid,
          parentProcessGroupId,
          selector,
          options,
          requireInitRetention
        );
      }
      this.childWaiters.delete(changed);
      this.waitingChildren.add(child.pid);
      let reaped = false;
      if (this.processes.has(child.pid)) {
        this.reapedBeforeUnregister.add(child.pid);
      }
      return yield* child.wait().pipe(
        Effect.tap(() => Effect.sync(() => {
          reaped = true;
          this.exitedChildren.delete(child.pid);
          this.initRetainedProcesses.delete(child.pid);
        })),
        Effect.ensuring(Effect.sync(() => {
          this.waitingChildren.delete(child.pid);
          if (!reaped) {
            this.reapedBeforeUnregister.delete(child.pid);
            Effect.runSync(this.notifyChildWaiters());
          }
        }))
      );
    });
  }

  private waitableChildren(
    parentPid: number,
    parentProcessGroupId: number,
    selector: number,
    requireInitRetention: boolean
  ): readonly TraceKernelProcess[] {
    return this.allProcesses()
      .filter((child) => {
        const snapshot = child.snapshot();
        if (
          snapshot.ppid !== parentPid ||
          this.waitingChildren.has(snapshot.pid) ||
          this.reapedBeforeUnregister.has(snapshot.pid) ||
          (
            requireInitRetention &&
            !this.initRetainedProcesses.has(snapshot.pid)
          )
        ) {
          return false;
        }
        if (selector > 0) return snapshot.pid === selector;
        if (selector === -1) return true;
        const processGroupId = selector === 0
          ? parentProcessGroupId
          : -selector;
        return snapshot.pgid === processGroupId;
      })
      .sort((left, right) => left.pid - right.pid);
  }

  private allProcesses(): TraceKernelProcess[] {
    return [...new Map<number, TraceKernelProcess>([
      ...this.processes,
      ...this.exitedChildren,
    ]).values()];
  }

  private visibleProcessSnapshots(
    processes: Iterable<TraceKernelProcess>,
    requester: TraceKernelPrincipal
  ): readonly TraceKernelProcessSnapshot[] {
    return [...processes]
      .map((process) => process.snapshot())
      .filter((process) =>
        requester.kind === 'system' ||
        process.visible ||
        (
          process.owner.id === requester.id &&
          process.owner.kind === requester.kind
        )
      )
      .sort((left, right) => left.pid - right.pid);
  }

  private notifyChildWaiters(): Effect.Effect<void> {
    return Effect.forEach(
      [...this.childWaiters],
      (waiter) => Deferred.succeed(waiter, undefined),
      { concurrency: 'unbounded', discard: true }
    );
  }

  private processNotFound(
    pid: number,
    message = `ESRCH: process ${pid} does not exist in session ${this.options.sessionId}`
  ): Effect.Effect<never, TraceKernelProcessStateError> {
    return Effect.fail(new TraceKernelProcessStateError({ pid, message }));
  }
}

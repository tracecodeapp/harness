import type {
  RuntimeCommandResult,
  RuntimeProjectSessionInfo,
  RuntimeProjectSessionLifecycle,
} from '@tracecode/runtime-contracts';

export interface WorkspaceLifecycleStateOptions {
  readonly session?: RuntimeProjectSessionInfo;
  readonly workspaceRoot: string;
  readonly isReadonlyPolicySuspended: () => boolean;
  readonly onExpired: (
    lifecycle: RuntimeProjectSessionLifecycle
  ) => void;
  readonly destroyExpired: () => Promise<void>;
}

/**
 * Session-scoped lifecycle policy, flags, and identity allocation.
 *
 * Teardown remains workspace orchestration. This state object owns expiration
 * transitions and admission decisions so run and mutation entrypoints cannot
 * drift into subtly different lifecycle policy.
 */
export class WorkspaceLifecycleState {
  destroyed = false;
  expirationDestroyScheduled = false;
  terminalVerbose = false;
  private nextCommandId = 1;
  private nextTemporaryEntry = 1;
  private nextTerminalSession = 1;

  constructor(
    private readonly options: WorkspaceLifecycleStateOptions
  ) {}

  allocateRuntimeActorId(): string {
    return `runtime:${this.nextCommandId++}`;
  }

  allocateTemporaryEntry(): number {
    return this.nextTemporaryEntry++;
  }

  allocateTerminalSessionId(): string {
    return `terminal-${this.nextTerminalSession++}`;
  }

  setTerminalVerbose(enabled: boolean): boolean {
    this.terminalVerbose = enabled;
    return this.terminalVerbose;
  }

  toggleTerminalVerbose(): boolean {
    this.terminalVerbose = !this.terminalVerbose;
    return this.terminalVerbose;
  }

  scheduleExpirationDestroy(): boolean {
    if (this.expirationDestroyScheduled) return false;
    this.expirationDestroyScheduled = true;
    return true;
  }

  assertNotDestroyed(): void {
    if (!this.destroyed) return;
    throw Object.assign(
      new Error('EINVAL: project session is no longer available'),
      { code: 'EINVAL' }
    );
  }

  assertUsableForMutation(operation: string): void {
    this.assertNotDestroyed();
    if (this.options.isReadonlyPolicySuspended()) return;
    this.transitionExpiredIfDue(Date.now());
    if (!this.isSessionExpired()) return;
    const expirationBehavior =
      this.options.session?.lifecycle.expirationBehavior;
    if (expirationBehavior === 'none') return;
    if (expirationBehavior === 'destroy') {
      this.scheduleDestroyAfterExpiration();
    } else if (expirationBehavior !== 'readonly') {
      return;
    }
    throw Object.assign(
      new Error(
        `EROFS: project session expired, ${operation} ` +
          `'${this.options.workspaceRoot}'`
      ),
      { code: 'EROFS' }
    );
  }

  unusableRunResult(command: string): RuntimeCommandResult | null {
    if (this.destroyed) {
      return {
        stdout: '',
        stderr: 'project session is no longer available\n',
        exitCode: 1,
      };
    }
    this.transitionExpiredIfDue(Date.now());
    if (!this.isSessionExpired()) return null;
    const expirationBehavior =
      this.options.session?.lifecycle.expirationBehavior;
    if (expirationBehavior === 'readonly') {
      return this.expiredCommandResult(command);
    }
    if (expirationBehavior === 'destroy') {
      this.scheduleDestroyAfterExpiration();
      return this.expiredCommandResult(command);
    }
    return null;
  }

  async checkExpiration(
    now: Date | string | number = new Date()
  ): Promise<RuntimeProjectSessionLifecycle | null> {
    this.assertNotDestroyed();
    const lifecycle = this.options.session?.lifecycle;
    if (!lifecycle?.expiresAt) return lifecycle ?? null;
    const wasExpired = Boolean(lifecycle.expiredAt);
    const nowTime =
      now instanceof Date ? now.getTime() : new Date(now).getTime();
    const expired = this.transitionExpiredIfDue(nowTime);
    if (
      expired &&
      !wasExpired &&
      lifecycle.expirationBehavior === 'destroy'
    ) {
      await this.options.destroyExpired();
    }
    return lifecycle;
  }

  private isSessionExpired(): boolean {
    return Boolean(this.options.session?.lifecycle.expiredAt);
  }

  private transitionExpiredIfDue(nowMs: number): boolean {
    const lifecycle = this.options.session?.lifecycle;
    if (!lifecycle) return false;
    if (!lifecycle.expiresAt) return false;
    if (lifecycle.expiredAt) return true;
    const expiresTime = new Date(lifecycle.expiresAt).getTime();
    if (
      Number.isNaN(nowMs) ||
      Number.isNaN(expiresTime) ||
      nowMs < expiresTime
    ) {
      return false;
    }
    lifecycle.expiredAt = new Date(nowMs).toISOString();
    this.options.onExpired(lifecycle);
    return true;
  }

  private scheduleDestroyAfterExpiration(): void {
    if (!this.scheduleExpirationDestroy()) return;
    queueMicrotask(() => {
      void this.options.destroyExpired().catch(() => undefined);
    });
  }

  private expiredCommandResult(
    command: string
  ): RuntimeCommandResult {
    return {
      stdout: '',
      stderr: `project session expired; command not run: ${command}\n`,
      exitCode: 1,
    };
  }
}

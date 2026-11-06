/** Host-owned lifetime shared by a process and the work it admits. */
export class ProcessAuthority {
  private revoked = false;
  private finished = false;
  private readonly childRuns = new Set<Promise<unknown>>();
  private readonly revocationListeners = new Set<() => void>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly children = new Set<ProcessAuthority>();

  constructor(private readonly parent?: ProcessAuthority) {
    parent?.children.add(this);
    if (parent?.isRevoked()) this.revoked = true;
  }

  assertActive = (): void => {
    if (this.finished || this.isRevoked()) throw Object.assign(new Error('Process authority has been revoked'), { code: 'ESRCH' });
  };

  isRevoked(): boolean { return this.revoked || Boolean(this.parent?.isRevoked()); }

  onRevoke(listener: () => void): void {
    if (this.isRevoked()) listener();
    else this.revocationListeners.add(listener);
  }

  revoke(): void {
    this.revoked = true;
    for (const listener of this.revocationListeners) listener();
    this.revocationListeners.clear();
    for (const child of this.children) child.revoke();
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    const result = operation();
    this.pending.add(result);
    void result.then(() => this.pending.delete(result), () => this.pending.delete(result));
    return result;
  }

  runChild<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    const result = operation();
    this.childRuns.add(result);
    void result.then(() => this.childRuns.delete(result), () => this.childRuns.delete(result));
    return result;
  }

  finish(): void {
    this.finished = true;
    this.revocationListeners.clear();
    this.releaseFinished();
  }

  private releaseFinished(): void {
    if (this.finished && this.children.size === 0) {
      this.parent?.children.delete(this);
      this.parent?.releaseFinished();
    }
  }

  async drainOperations(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  async drain(): Promise<void> {
    await this.drainOperations();
    while (this.childRuns.size) await Promise.allSettled([...this.childRuns]);
    await Promise.all([...this.children].map((child) => child.drain()));
  }
}

/** Bind per-operation dependencies while retaining shared counters and caches. */
export function withDependencies<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      return Object.prototype.hasOwnProperty.call(overrides, key)
        ? Reflect.get(overrides, key)
        : Reflect.get(object, key, receiver);
    },
    set(object, key, value) { return Reflect.set(object, key, value); },
  });
}

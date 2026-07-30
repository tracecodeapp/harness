/**
 * Session-scoped lifecycle flags and identity allocation.
 *
 * The workspace remains responsible for deciding when a transition is valid.
 * This object only owns mutable lifecycle state so teardown, expiration, and
 * terminal sessions do not rely on scattered counters and booleans.
 */
export class WorkspaceLifecycleState {
  destroyed = false;
  expirationDestroyScheduled = false;
  terminalVerbose = false;
  private nextCommandId = 1;
  private nextTemporaryEntry = 1;
  private nextTerminalSession = 1;

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
}

package tracecode.user;

/**
 * Thrown once when the stored-event budget is first exhausted so the traced
 * run aborts immediately. TraceExecutionRunner catches it and re-runs the
 * whole case from run() — never a single method, whose partial side effects
 * would otherwise execute twice. Extends {@link RuntimeException} (not
 * {@link Error}) so TraceJVM's exception handling reliably delivers it.
 */
public final class TraceBudgetExceededError extends RuntimeException {
  private static final long serialVersionUID = 1L;

  public TraceBudgetExceededError() {
    super("Trace event storage budget exceeded");
  }
}

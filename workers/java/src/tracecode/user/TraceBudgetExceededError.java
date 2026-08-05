package tracecode.user;

/**
 * Thrown once when the stored-event budget is first exhausted so rewritten
 * learner methods can abort the instrumented path and finish via an untraced
 * copy. Extends {@link RuntimeException} (not {@link Error}) so TraceJVM's
 * exception handling reliably delivers it to the rewritten catch clause.
 */
public final class TraceBudgetExceededError extends RuntimeException {
  private static final long serialVersionUID = 1L;

  public TraceBudgetExceededError() {
    super("Trace event storage budget exceeded");
  }
}

package tracecode.browser;

import java.io.PrintWriter;
import java.io.Writer;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import tracecode.user.TraceBudgetExceededError;
import tracecode.user.TraceHooks;

/**
 * Harness-owned entry point for executing an already-compiled semantic trace
 * wrapper. Keeping this class in the browser helper JAR means providers only
 * load class files; they never need to compile TraceCode's runner at runtime.
 */
public final class TraceExecutionRunner {
  public static final String OUTPUT_MARKER = "__TRACECODE_TRACE_OUTPUT__:";
  public static final String EVENT_MARKER = "__TRACECODE_TRACE_EVENT__:";
  public static final String EVENTS_BEGIN_MARKER = "__TRACECODE_TRACE_EVENTS_BEGIN__:";
  public static final String EVENTS_END_MARKER = "__TRACECODE_TRACE_EVENTS_END__";
  public static final String EXPORT_MARKER = "__TRACECODE_TRACE_EXPORT_MS__:";
  public static final String LIMIT_MARKER = "__TRACECODE_TRACE_LIMIT__:";
  public static final String DROPPED_MARKER = "__TRACECODE_TRACE_DROPPED__:";
  public static final String PROFILE_MARKER = "__TRACECODE_TRACE_PROFILE__:";
  public static final String ERROR_MARKER = "__TRACECODE_TRACE_ERROR__:";

  private TraceExecutionRunner() {}

  private static String encode(String value) {
    return Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8));
  }

  private static final class BoundedStackWriter extends Writer {
    private static final int MAX_CHARS = 2_048;
    private final StringBuilder text = new StringBuilder(512);

    @Override
    public void write(char[] characters, int offset, int length) {
      int remaining = MAX_CHARS - text.length();
      if (remaining <= 0) return;
      text.append(characters, offset, Math.min(length, remaining));
    }

    @Override
    public void flush() {
    }

    @Override
    public void close() {
    }

    @Override
    public String toString() {
      return text.toString();
    }
  }

  private static String learnerFailure(
      Throwable error,
      String learnerFrame
  ) {
    if (learnerFrame != null && !learnerFrame.isEmpty()) {
      StringBuilder result = new StringBuilder(128);
      result.append(error.getClass().getName());
      String message = error.getMessage();
      if (message != null && !message.isEmpty()) {
        result.append(": ").append(message);
      }
      result.append("\n\tat ").append(learnerFrame);
      return result.toString();
    }

    BoundedStackWriter text = new BoundedStackWriter();
    error.printStackTrace(new PrintWriter(text));
    String result = text.toString();
    if (result.isEmpty()) {
      StringBuilder fallback = new StringBuilder(error.getClass().getName());
      String message = error.getMessage();
      if (message != null && !message.isEmpty()) {
        fallback.append(": ").append(message);
      }
      return fallback.toString();
    }
    return result;
  }

  public static void main(String[] args) throws Exception {
    if (args.length < 2) {
      throw new IllegalArgumentException(
          "TraceExecutionRunner requires an entry class and maximum stored event count");
    }

    String entryClass = args[0];
    int maxStoredEvents = Integer.parseInt(args[1]);
    String learnerFrame = args.length >= 3 ? args[2] : "";
    boolean profile = args.length >= 4 && "profile".equals(args[3]);
    int token = TraceHooks.beginRun(maxStoredEvents, profile, true);
    Object output = null;
    Throwable failure = null;
    try {
      ClassLoader loader = Thread.currentThread().getContextClassLoader();
      Class<?> entry = Class.forName(entryClass, true, loader);
      Method run = entry.getMethod("run");
      run.setAccessible(true);
      boolean budgetAborted = false;
      try {
        output = run.invoke(null);
      } catch (InvocationTargetException error) {
        Throwable cause = error.getCause() == null ? error : error.getCause();
        if (cause instanceof TraceBudgetExceededError) {
          budgetAborted = true;
        } else {
          failure = cause;
        }
      }
      if (budgetAborted) {
        // The budget tripped mid-run, so learner state (input arrays, fields)
        // may be half-mutated; a partial replay of any single method would
        // double its side effects. Re-run the whole case instead: run()
        // rebuilds its inputs from scratch, and with the budget flag set the
        // hooks are dead, so the rerun executes near-plain and stores nothing.
        // The recorded trace stays truncated at the budget. Learner *static*
        // state is not reset (classes stay loaded); non-idempotent statics are
        // a known limitation of the rerun.
        TraceHooks.markBudgetAbortFallback();
        try {
          output = run.invoke(null);
        } catch (InvocationTargetException error) {
          failure = error.getCause() == null ? error : error.getCause();
        }
      }
    } catch (Throwable error) {
      failure = error;
    } finally {
      // Snapshot before event export so TraceHooks totals exclude transport.
      String profileJson = profile ? TraceHooks.profileReportJson() : null;
      if (output != null) {
        System.out.println(OUTPUT_MARKER + encode(String.valueOf(output)));
      }
      long exportStarted = System.nanoTime();
      StringBuilder eventBlock = new StringBuilder(256);
      int eventCount = TraceHooks.drainEventsNdjson(eventBlock);
      System.out.println(EVENTS_BEGIN_MARKER + eventCount);
      if (eventCount > 0) {
        // One bulk UTF-8 encode + one raw write. PrintStream.print would
        // route the multi-megabyte block through its per-char encoder loop,
        // which dominates export time on an interpreted JVM.
        try {
          System.out.flush();
          System.out.write(
              eventBlock.toString().getBytes(StandardCharsets.UTF_8));
          System.out.flush();
        } catch (java.io.IOException error) {
          System.out.print(eventBlock);
        }
      }
      System.out.println(EVENTS_END_MARKER);
      double exportMs = Math.round((System.nanoTime() - exportStarted) / 1e4) / 1e2;
      System.out.println(EXPORT_MARKER + exportMs);
      System.out.println(LIMIT_MARKER + TraceHooks.traceLimitExceeded());
      System.out.println(DROPPED_MARKER + TraceHooks.droppedEventCount());
      if (profileJson != null) {
        System.out.println(PROFILE_MARKER + encode(profileJson));
      }
      if (failure != null) {
        System.out.println(
            ERROR_MARKER + encode(learnerFailure(failure, learnerFrame)));
      }
      TraceHooks.endRun(token);
    }
  }
}

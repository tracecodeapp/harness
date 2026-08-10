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
  public static final String FALLBACK_MARKER = "__TRACECODE_TRACE_FALLBACK_REQUIRED__:";

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
    boolean enableTracing = !(args.length >= 5 && "notrace".equals(args[4]));
    int token = TraceHooks.beginRun(maxStoredEvents, profile, true, enableTracing);
    Object output = null;
    Throwable failure = null;
    boolean fallbackRequired = false;
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
        // The traced attempt may have mutated learner globals or emitted
        // output. Ask the host to run the clean companion through a fresh
        // process boundary, then merge this attempt's truncated trace with
        // that clean result. Re-entering here would repeat externally visible
        // side effects in the same JVM.
        TraceHooks.markBudgetAbortFallback();
        fallbackRequired = true;
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
      TraceHooks.DrainedEvents drained = TraceHooks.drainEventsUtf8();
      System.out.println(EVENTS_BEGIN_MARKER + drained.count);
      if (drained.count > 0) {
        // One bulk UTF-8 encode + one raw write. PrintStream.print would
        // route the multi-megabyte block through its per-char encoder loop,
        // which dominates export time on an interpreted JVM.
        try {
          System.out.flush();
          System.out.write(drained.utf8);
          System.out.flush();
        } catch (java.io.IOException error) {
          System.out.print(new String(drained.utf8, StandardCharsets.UTF_8));
        }
      }
      System.out.println(EVENTS_END_MARKER);
      double exportMs = Math.round((System.nanoTime() - exportStarted) / 1e4) / 1e2;
      System.out.println(EXPORT_MARKER + exportMs);
      System.out.println(LIMIT_MARKER + TraceHooks.traceLimitExceeded());
      System.out.println(DROPPED_MARKER + TraceHooks.droppedEventCount());
      System.out.println(FALLBACK_MARKER + fallbackRequired);
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

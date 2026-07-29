package tracecode.browser;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import tracecode.user.TraceHooks;

/**
 * Harness-owned entry point for executing an already-compiled semantic trace
 * wrapper. Keeping this class in the browser helper JAR means providers only
 * load class files; they never need to compile TraceCode's runner at runtime.
 */
public final class TraceExecutionRunner {
  public static final String OUTPUT_MARKER = "__TRACECODE_TRACE_OUTPUT__:";
  public static final String EVENT_MARKER = "__TRACECODE_TRACE_EVENT__:";
  public static final String LIMIT_MARKER = "__TRACECODE_TRACE_LIMIT__:";
  public static final String DROPPED_MARKER = "__TRACECODE_TRACE_DROPPED__:";
  public static final String ERROR_MARKER = "__TRACECODE_TRACE_ERROR__:";

  private TraceExecutionRunner() {}

  private static String encode(String value) {
    return Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8));
  }

  private static String stackTrace(Throwable error) {
    StringWriter text = new StringWriter();
    error.printStackTrace(new PrintWriter(text));
    return text.toString();
  }

  public static void main(String[] args) throws Exception {
    if (args.length < 2) {
      throw new IllegalArgumentException(
          "TraceExecutionRunner requires an entry class and maximum stored event count");
    }

    String entryClass = args[0];
    int maxStoredEvents = Integer.parseInt(args[1]);
    int token = TraceHooks.beginRun(maxStoredEvents);
    Object output = null;
    Throwable failure = null;
    try {
      ClassLoader loader = Thread.currentThread().getContextClassLoader();
      Class<?> entry = Class.forName(entryClass, true, loader);
      Method run = entry.getMethod("run");
      run.setAccessible(true);
      output = run.invoke(null);
    } catch (InvocationTargetException error) {
      failure = error.getCause() == null ? error : error.getCause();
    } catch (Throwable error) {
      failure = error;
    } finally {
      if (output != null) {
        System.out.println(OUTPUT_MARKER + encode(String.valueOf(output)));
      }
      for (String event : TraceHooks.drainEvents()) {
        System.out.println(EVENT_MARKER + encode(event));
      }
      System.out.println(LIMIT_MARKER + TraceHooks.traceLimitExceeded());
      System.out.println(DROPPED_MARKER + TraceHooks.droppedEventCount());
      if (failure != null) {
        System.out.println(ERROR_MARKER + encode(stackTrace(failure)));
      }
      TraceHooks.endRun(token);
    }
  }
}

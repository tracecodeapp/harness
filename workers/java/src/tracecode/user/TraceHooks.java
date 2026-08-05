package tracecode.user;

import java.util.ArrayList;
import java.util.List;

public final class TraceHooks {
  private static final int DEFAULT_MAX_EVENTS = 50000;
  private static final int MAX_SERIALIZE_DEPTH = 48;
  private static final int MAX_SERIALIZED_ITEMS = 64;
  private static final int MAX_BULK_INDEXED_WRITES = 512;
  private static final int MAX_OBJECT_FIELDS = 32;
  private static final Object STATE_LOCK = new Object();
  private static final List<String> EVENTS = new ArrayList<>();
  /**
   * Per-thread tracing state. TraceJVM interprets {@code ThreadLocal} map
   * lookups, and the hooks used to perform around eight of them per stored
   * event; consolidating every per-thread slot into one holder behind an
   * owner-checked one-slot cache makes the common single-threaded learner pay
   * a single reference compare instead.
   */
  private static final class ThreadState {
    final Thread owner = Thread.currentThread();
    final java.util.List<TraceFrame> callStack = new java.util.ArrayList<>();
    /** Serialized call stack, or null when invalidated by a call/return. */
    String callStackJson;
    int callStackJsonId;
    /** Prebuilt {@code ,"callStackRef":N} suffix for the current stack state. */
    String callStackRefSuffix;
    String lastIndexSource;
    /** Identity-keyed memo for single-source indexSources JSON (rewriter
     * passes the same constant-pool string on every hit of a call site). */
    String memoIndexSource;
    String memoIndexSourcesJson;
    /** Cached copy of {@link #RUN_TOKEN}; both are updated together. */
    Integer runToken = RUN_TOKEN.get();
    final java.util.IdentityHashMap<Object, String> serializeSeen =
        new java.util.IdentityHashMap<>();
    final StringBuilder eventBuilder = new StringBuilder(256);
    boolean eventBuilderInUse;
  }

  private static final ThreadLocal<ThreadState> THREAD_STATE =
      ThreadLocal.withInitial(ThreadState::new);
  /**
   * One-slot cache for {@link #state()}. Racy publication is safe: every field
   * read through the cache is final or owner-thread-confined, and a wrong-owner
   * hit falls back to the ThreadLocal map.
   */
  private static ThreadState hotThreadState;

  private static ThreadState state() {
    ThreadState cached = hotThreadState;
    if (cached != null && cached.owner == Thread.currentThread()) return cached;
    ThreadState state = THREAD_STATE.get();
    hotThreadState = state;
    return state;
  }

  /**
   * Serializing a value can execute instrumented learner code (a learner
   * {@code Iterable} being walked, a learner {@code toString()} on a map key),
   * which re-enters these hooks while an event is mid-build. Hand re-entrant
   * callers a fresh builder so the shared one is never clobbered.
   */
  private static StringBuilder acquireEventBuilder() {
    ThreadState state = state();
    if (state.eventBuilderInUse) {
      return new StringBuilder(128);
    }
    state.eventBuilderInUse = true;
    StringBuilder out = state.eventBuilder;
    out.setLength(0);
    return out;
  }

  private static void releaseEventBuilder(StringBuilder builder) {
    ThreadState state = state();
    if (builder == state.eventBuilder) {
      state.eventBuilderInUse = false;
    }
  }
  /**
   * TraceJVM registers C implementations for these (bjvm
   * {@code natives/share/tracecode/user/TraceHooks.c}); on a stock JVM the
   * first call throws {@link UnsatisfiedLinkError} and the probe below pins
   * every caller to the pure-Java paths. Each native returns {@code null} for
   * any input it will not handle byte-identically, and callers must fall back.
   */
  private static native String jsonIntArray0(int[] values, int emitted, int total);

  private static native String jsonLongArray0(long[] values, int emitted, int total);

  private static native String serializeScalar0(Object value);

  private static native String jsonEscape0(String value);

  private static native String buildIndexedEvent0(
      String kind,
      int line,
      String name,
      int index,
      String indexSourcesJson,
      String valueJson,
      String stackSuffix);

  private static native String buildEvent0(
      String kind,
      int line,
      String name,
      String pathJson,
      String indexSourcesJson,
      String valueJson,
      String functionName,
      String stackSuffix);

  private static native byte[] encodeLinesUtf8(String[] lines, int count);

  private static final boolean NATIVE_JSON_AVAILABLE = probeNativeJson();

  private static boolean probeNativeJson() {
    try {
      return "[]".equals(jsonIntArray0(new int[0], 0, 0));
    } catch (Throwable error) {
      return false;
    }
  }

  private static final InheritableThreadLocal<Integer> RUN_TOKEN = new InheritableThreadLocal<>();
  private static final java.util.IdentityHashMap<Object, String> TRACE_REFERENCE_IDS = new java.util.IdentityHashMap<>();
  private static int maxEvents = DEFAULT_MAX_EVENTS;
  private static volatile boolean traceLimitExceeded = false;
  /** Public hot-path flag for rewritten call-site elision (field read, not a method call). */
  public static volatile boolean limitExceeded = false;
  private static int droppedEventCount = 0;
  private static int nextTraceReferenceId = 0;
  private static int nextRunToken = 0;
  private static volatile int activeRunToken = 0;
  // Optional hot-path profile for TraceJVM / native measurement runs.
  // Counters are always maintained (they are close to free); nanoTime spans
  // are captured only when a run is started with profiling enabled.
  private static boolean profileEnabled = false;
  private static boolean budgetAbortArmed = false;
  private static int nextCallStackId = 0;
  private static long profileRunStartNs = 0L;
  private static long profileBudgetTripNs = 0L;
  private static long profileSerializeNs = 0L;
  private static long profileSerializeCalls = 0L;
  private static long profileSerializeChars = 0L;
  private static long profileEmitBuildNs = 0L;
  private static long profileEmitBuildCalls = 0L;
  private static long profileStoreNs = 0L;
  private static long profileStoreCalls = 0L;
  private static long profileStoredEvents = 0L;
  private static long profileStoredChars = 0L;
  private static long profileDropFastPathCalls = 0L;
  private static long profileReadArrayCalls = 0L;
  private static long profileReadArrayEarlyExits = 0L;
  private static long profileWriteArrayCalls = 0L;
  private static long profileSnapshotCalls = 0L;
  private static long profileLengthCalls = 0L;
  private static long profileLineCalls = 0L;
  private static long profileScalarWriteCalls = 0L;
  private static long profileBudgetAbortFallbackNs = 0L;
  private static long profileBudgetAbortFallbacks = 0L;

  private TraceHooks() {}

  private static void resetProfileLocked() {
    profileRunStartNs = System.nanoTime();
    profileBudgetTripNs = 0L;
    profileSerializeNs = 0L;
    profileSerializeCalls = 0L;
    profileSerializeChars = 0L;
    profileEmitBuildNs = 0L;
    profileEmitBuildCalls = 0L;
    profileStoreNs = 0L;
    profileStoreCalls = 0L;
    profileStoredEvents = 0L;
    profileStoredChars = 0L;
    profileDropFastPathCalls = 0L;
    profileReadArrayCalls = 0L;
    profileReadArrayEarlyExits = 0L;
    profileWriteArrayCalls = 0L;
    profileSnapshotCalls = 0L;
    profileLengthCalls = 0L;
    profileLineCalls = 0L;
    profileScalarWriteCalls = 0L;
    profileBudgetAbortFallbackNs = 0L;
    profileBudgetAbortFallbacks = 0L;
  }

  /** Called by TraceExecutionRunner before re-running the whole case untraced. */
  public static void markBudgetAbortFallback() {
    if (profileBudgetAbortFallbackNs == 0L) {
      profileBudgetAbortFallbackNs = System.nanoTime();
    }
    profileBudgetAbortFallbacks += 1;
  }

  /** JSON profile snapshot for the current run. Safe to call before {@link #endRun(int)}. */
  public static String profileReportJson() {
    long now = System.nanoTime();
    long totalNs = profileRunStartNs == 0L ? 0L : Math.max(0L, now - profileRunStartNs);
    long beforeBudgetNs =
        profileBudgetTripNs > 0L
            ? Math.max(0L, profileBudgetTripNs - profileRunStartNs)
            : totalNs;
    long afterBudgetNs =
        profileBudgetTripNs > 0L ? Math.max(0L, now - profileBudgetTripNs) : 0L;
    StringBuilder out = new StringBuilder(512);
    out.append('{');
    out.append("\"totalMs\":").append(nsToMs(totalNs));
    out.append(",\"beforeBudgetMs\":").append(nsToMs(beforeBudgetNs));
    out.append(",\"afterBudgetMs\":").append(nsToMs(afterBudgetNs));
    out.append(",\"budgetTripped\":").append(profileBudgetTripNs > 0L || traceLimitExceeded);
    out.append(",\"serializeMs\":").append(nsToMs(profileSerializeNs));
    out.append(",\"serializeCalls\":").append(profileSerializeCalls);
    out.append(",\"serializeChars\":").append(profileSerializeChars);
    out.append(",\"emitBuildMs\":").append(nsToMs(profileEmitBuildNs));
    out.append(",\"emitBuildCalls\":").append(profileEmitBuildCalls);
    out.append(",\"storeMs\":").append(nsToMs(profileStoreNs));
    out.append(",\"storeCalls\":").append(profileStoreCalls);
    out.append(",\"storedEvents\":").append(profileStoredEvents);
    out.append(",\"storedChars\":").append(profileStoredChars);
    out.append(",\"dropFastPathCalls\":").append(profileDropFastPathCalls);
    out.append(",\"readArrayCalls\":").append(profileReadArrayCalls);
    out.append(",\"readArrayEarlyExits\":").append(profileReadArrayEarlyExits);
    out.append(",\"writeArrayCalls\":").append(profileWriteArrayCalls);
    out.append(",\"snapshotCalls\":").append(profileSnapshotCalls);
    out.append(",\"lengthCalls\":").append(profileLengthCalls);
    out.append(",\"lineCalls\":").append(profileLineCalls);
    out.append(",\"scalarWriteCalls\":").append(profileScalarWriteCalls);
    out.append(",\"budgetAbortFallbacks\":").append(profileBudgetAbortFallbacks);
    out.append(",\"budgetAbortFallbackMs\":").append(
        profileBudgetAbortFallbackNs > 0L
            ? nsToMs(Math.max(0L, now - profileBudgetAbortFallbackNs))
            : 0);
    out.append(",\"eventsSize\":").append(EVENTS.size());
    out.append(",\"maxEvents\":").append(maxEvents);
    out.append(",\"droppedEventCount\":").append(droppedEventCount);
    out.append('}');
    return out.toString();
  }

  private static double nsToMs(long ns) {
    return Math.round(ns / 1e4) / 1e2; // 0.01ms precision
  }

  public static void emit(String event) {
    if (!runActiveForCurrentThread()) return;
    if (event == null || !event.startsWith("trace:")) {
      throw new IllegalArgumentException("TraceHooks.emit only accepts native trace: runtime events");
    }
    if (dropIfStorageExhausted()) return;
    String sanitizedEvent = sanitizeJsonNonFiniteNumbers(withCallStack(event));
    storeEvent(sanitizedEvent);
  }

  /**
   * Hot-path emit for internally built events. {@code body} must contain the
   * full event through the last property and must NOT include the closing
   * {@code '}'}. Call-stack injection and closing happen here so we avoid an
   * extra substring/copy of large snapshot payloads.
   */
  /**
   * Assemble and store one complete event via {@code buildEvent0}, replacing
   * the interpreted StringBuilder pipeline for the hot hook shapes. Returns
   * true when the event was fully handled (stored, or correctly dropped by
   * the same checks {@link #emitEventBody} performs); false means the caller
   * must run its interpreted path — including the rare first event of a new
   * call-stack state, which carries the full serialized stack.
   */
  private static boolean emitFast(
      String kind,
      int line,
      String name,
      String pathJson,
      String indexSourcesJson,
      String valueJson,
      String functionName) {
    if (!NATIVE_JSON_AVAILABLE) return false;
    ThreadState state = state();
    String stackSuffix = "";
    if (!state.callStack.isEmpty()) {
      if (state.callStackJson == null) return false;
      stackSuffix = state.callStackRefSuffix;
    }
    if (!runActiveForCurrentThread()) return true;
    if (dropIfStorageExhausted()) return true;
    long started = profileEnabled ? System.nanoTime() : 0L;
    String event =
        buildEvent0(kind, line, name, pathJson, indexSourcesJson, valueJson, functionName, stackSuffix);
    if (event == null) return false;
    if (event.indexOf("NaN") >= 0 || event.indexOf("Infinity") >= 0) {
      event = sanitizeJsonNonFiniteNumbers(event);
    }
    if (profileEnabled) profileEmitBuildNs += System.nanoTime() - started;
    profileEmitBuildCalls += 1;
    storeEvent(event);
    return true;
  }

  /** {@link #emitFast} variant for single-int-index array accesses. */
  private static boolean emitFastIndexed(
      String kind, int line, String name, int index, String indexSourcesJson, String valueJson) {
    if (!NATIVE_JSON_AVAILABLE) return false;
    ThreadState state = state();
    String stackSuffix = "";
    if (!state.callStack.isEmpty()) {
      if (state.callStackJson == null) return false;
      stackSuffix = state.callStackRefSuffix;
    }
    if (!runActiveForCurrentThread()) return true;
    if (dropIfStorageExhausted()) return true;
    long started = profileEnabled ? System.nanoTime() : 0L;
    String event = buildIndexedEvent0(kind, line, name, index, indexSourcesJson, valueJson, stackSuffix);
    if (event == null) return false;
    if (event.indexOf("NaN") >= 0 || event.indexOf("Infinity") >= 0) {
      event = sanitizeJsonNonFiniteNumbers(event);
    }
    if (profileEnabled) profileEmitBuildNs += System.nanoTime() - started;
    profileEmitBuildCalls += 1;
    storeEvent(event);
    return true;
  }

  private static String indexSourcesJsonSingle(String source) {
    ThreadState state = state();
    if (source == state.memoIndexSource) return state.memoIndexSourcesJson;
    String json = "[" + jsonString(source) + "]";
    state.memoIndexSource = source;
    state.memoIndexSourcesJson = json;
    return json;
  }

  private static void emitEventBody(StringBuilder body) {
    if (!runActiveForCurrentThread()) return;
    if (dropIfStorageExhausted()) {
      releaseEventBuilder(body);
      return;
    }
    long started = profileEnabled ? System.nanoTime() : 0L;
    String event;
    try {
      appendCallStackProperty(body);
      body.append('}');
      event = body.toString();
    } finally {
      releaseEventBuilder(body);
    }
    if (event.indexOf("NaN") >= 0 || event.indexOf("Infinity") >= 0) {
      event = sanitizeJsonNonFiniteNumbers(event);
    }
    if (profileEnabled) profileEmitBuildNs += System.nanoTime() - started;
    profileEmitBuildCalls += 1;
    storeEvent(event);
  }

  /**
   * Append the current call stack to an event body. The serialized stack only
   * changes on call/return, so each distinct stack state is emitted in full
   * exactly once ({@code callStackId}); every later event in the same state
   * carries a {@code callStackRef} that the host trace adapter resolves and
   * strips. Loop-heavy learner code repeats one stack state across thousands
   * of events, so this removes most of the event payload.
   */
  private static void appendCallStackProperty(StringBuilder out) {
    ThreadState state = state();
    java.util.List<TraceFrame> stack = state.callStack;
    if (stack.isEmpty()) return;
    String serializedStack = state.callStackJson;
    if (serializedStack != null) {
      out.append(state.callStackRefSuffix);
      return;
    }
    serializedStack = serializeCallStack(stack);
    state.callStackJson = serializedStack;
    int id;
    synchronized (STATE_LOCK) {
      id = ++nextCallStackId;
    }
    state.callStackJsonId = id;
    state.callStackRefSuffix = ",\"callStackRef\":" + id;
    out.append(",\"callStack\":").append(serializedStack);
    out.append(",\"callStackId\":").append(id);
  }

  private static void storeEvent(String sanitizedEvent) {
    long started = profileEnabled ? System.nanoTime() : 0L;
    boolean throwBudgetExceeded = false;
    synchronized (STATE_LOCK) {
      if (!runActiveForCurrentThread()) return;
      if (traceLimitExceeded) {
        droppedEventCount += 1;
        return;
      }
      if (EVENTS.size() >= maxEvents) {
        traceLimitExceeded = true;
        limitExceeded = true;
        if (profileBudgetTripNs == 0L) profileBudgetTripNs = System.nanoTime();
        droppedEventCount += 1;
        throwBudgetExceeded = true;
      } else {
        EVENTS.add(sanitizedEvent);
        profileStoredEvents += 1;
        profileStoredChars += sanitizedEvent.length();
      }
    }
    if (profileEnabled) profileStoreNs += System.nanoTime() - started;
    profileStoreCalls += 1;
    if (throwBudgetExceeded && budgetAbortArmed) {
      throw new TraceBudgetExceededError();
    }
  }

  private static boolean dropIfStorageExhausted() {
    if (!traceLimitExceeded) return false;
    Integer token = state().runToken;
    if (token == null || token.intValue() != activeRunToken || activeRunToken == 0) {
      return false;
    }
    // Hot exhausted path: learners keep running after the budget trips, and
    // instrumented DP loops can invoke this millions of times. Avoid locking;
    // droppedEventCount is diagnostic-only and may be slightly racy under
    // rare learner threads that share a run token.
    droppedEventCount += 1;
    profileDropFastPathCalls += 1;
    return true;
  }

  public static void reset() {
    reset(DEFAULT_MAX_EVENTS);
  }

  public static void reset(int nextMaxEvents) {
    Integer currentToken = RUN_TOKEN.get();
    if (currentToken != null) {
      synchronized (STATE_LOCK) {
        if (currentToken.intValue() == activeRunToken && activeRunToken != 0) {
          resetStateLocked(nextMaxEvents);
        } else {
          RUN_TOKEN.remove();
          state().runToken = null;
        }
      }
      return;
    }
    beginRun(nextMaxEvents);
  }

  public static int beginRun() {
    return beginRun(DEFAULT_MAX_EVENTS);
  }

  public static int beginRun(int nextMaxEvents) {
    return beginRun(nextMaxEvents, false, false);
  }

  public static int beginRun(int nextMaxEvents, boolean enableProfile) {
    return beginRun(nextMaxEvents, enableProfile, false);
  }

  /**
   * {@code abortOnBudget} makes the first budget trip throw
   * {@link TraceBudgetExceededError} to end the traced run immediately. Only
   * arm it from an entry point that catches the error and re-runs the case
   * (TraceExecutionRunner); direct TraceHooks users and the project bootstrap
   * keep the drop-silently behaviour.
   */
  public static int beginRun(int nextMaxEvents, boolean enableProfile, boolean abortOnBudget) {
    int token;
    profileEnabled = enableProfile;
    synchronized (STATE_LOCK) {
      token = nextRunToken + 1;
      if (token <= 0) token = 1;
      nextRunToken = token;
      activeRunToken = token;
      resetStateLocked(nextMaxEvents);
      budgetAbortArmed = abortOnBudget;
      if (EVENTS instanceof ArrayList<?>) {
        ((ArrayList<String>) EVENTS).ensureCapacity(maxEvents);
      }
    }
    RUN_TOKEN.set(token);
    state().runToken = token;
    return token;
  }

  public static void endRun(int runToken) {
    synchronized (STATE_LOCK) {
      if (activeRunToken == runToken) {
        activeRunToken = 0;
        resetStateLocked(DEFAULT_MAX_EVENTS);
      }
    }
    ThreadState state = state();
    state.callStack.clear();
    state.callStackJson = null;
    state.lastIndexSource = null;
    RUN_TOKEN.remove();
    state.runToken = null;
  }

  private static void resetStateLocked(int nextMaxEvents) {
    EVENTS.clear();
    ThreadState state = state();
    state.callStack.clear();
    state.callStackJson = null;
    state.lastIndexSource = null;
    TRACE_REFERENCE_IDS.clear();
    maxEvents = Math.max(1, nextMaxEvents);
    traceLimitExceeded = false;
    limitExceeded = false;
    droppedEventCount = 0;
    nextTraceReferenceId = 0;
    nextCallStackId = 0;
    budgetAbortArmed = false;
    resetProfileLocked();
  }

  private static boolean runActiveForCurrentThread() {
    Integer token = state().runToken;
    return token != null && token.intValue() == activeRunToken && activeRunToken != 0;
  }

  public static List<String> drainEvents() {
    synchronized (STATE_LOCK) {
      List<String> copy = new ArrayList<>(EVENTS);
      EVENTS.clear();
      return copy;
    }
  }

  /**
   * Append stored events as NDJSON into {@code out} and clear storage.
   * Preferred TraceJVM export path: one buffered write beats thousands of
   * tiny {@code PrintStream} calls through the WASM stdout bridge.
   *
   * @return number of events drained
   */
  public static int drainEventsNdjson(StringBuilder out) {
    synchronized (STATE_LOCK) {
      int count = EVENTS.size();
      if (count == 0) return 0;
      int chars = 0;
      for (int index = 0; index < count; index++) {
        chars += EVENTS.get(index).length() + 1;
      }
      out.ensureCapacity(out.length() + chars);
      for (int index = 0; index < count; index++) {
        out.append(EVENTS.get(index)).append('\n');
      }
      EVENTS.clear();
      return count;
    }
  }

  /** Result of {@link #drainEventsUtf8()}: event count plus the encoded block. */
  public static final class DrainedEvents {
    public final int count;
    public final byte[] utf8;

    DrainedEvents(int count, byte[] utf8) {
      this.count = count;
      this.utf8 = utf8;
    }
  }

  private static final byte[] EMPTY_BYTES = new byte[0];

  /**
   * Drain stored events as one UTF-8 NDJSON byte block. On TraceJVM the
   * join + encode runs in C ({@code encodeLinesUtf8}); elsewhere — or when any
   * event holds non-latin1 text — it falls back to the StringBuilder path.
   */
  public static DrainedEvents drainEventsUtf8() {
    synchronized (STATE_LOCK) {
      int count = EVENTS.size();
      if (count == 0) return new DrainedEvents(0, EMPTY_BYTES);
      if (NATIVE_JSON_AVAILABLE) {
        String[] lines = EVENTS.toArray(new String[0]);
        byte[] block = encodeLinesUtf8(lines, count);
        if (block != null) {
          EVENTS.clear();
          return new DrainedEvents(count, block);
        }
      }
      StringBuilder out = new StringBuilder(256);
      drainEventsNdjson(out);
      return new DrainedEvents(
          count, out.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
  }

  public static boolean traceLimitExceeded() {
    // Volatile field read. Prefer {@link #limitExceeded} at rewritten call sites
    // so TraceJVM does not pay for an invokestatic on every access.
    return traceLimitExceeded;
  }

  public static int droppedEventCount() {
    synchronized (STATE_LOCK) {
      return droppedEventCount;
    }
  }

  public static String serializeResult(Object value) {
    // Once the storage budget has been exhausted, no later event can retain
    // this value. Avoid repeatedly walking growing learner collections just
    // to construct an event that emit() will discard.
    if (traceLimitExceeded && runActiveForCurrentThread()) return "null";
    long started = profileEnabled ? System.nanoTime() : 0L;
    profileSerializeCalls += 1;
    String json;
    if (value instanceof int[]) {
      json = serializeIntArrayRoot((int[]) value, true);
    } else if (value instanceof long[]) {
      json = serializeLongArrayRoot((long[]) value, true);
    } else {
      java.util.IdentityHashMap<Object, String> seen = state().serializeSeen;
      seen.clear();
      json = serializeResult(value, seen, 0, true);
    }
    profileSerializeChars += json.length();
    if (profileEnabled) profileSerializeNs += System.nanoTime() - started;
    return json;
  }

  public static String serializeOutputResult(Object value) {
    java.util.IdentityHashMap<Object, String> seen = state().serializeSeen;
    seen.clear();
    return serializeResult(value, seen, 0, false);
  }

  public static void emitLineAtLine(int line) {
    profileLineCalls += 1;
    if (dropIfStorageExhausted()) return;
    java.util.List<TraceFrame> stack = state().callStack;
    String functionName = stack.isEmpty() ? null : stack.get(stack.size() - 1).functionName;
    if (emitFast("line", line, null, null, null, null, functionName)) return;
    StringBuilder out = acquireEventBuilder();
    out.append("trace:{\"kind\":\"line\",\"line\":").append(line);
    if (functionName != null) {
      out.append(",\"function\":").append(jsonString(functionName));
    }
    emitEventBody(out);
  }

  public static void emitLineAtLine(int line, String snapshotFragment) {
    emitLineAtLine(line);
    if (traceLimitExceeded) return;
    emitSnapshotsFromFragment(line, snapshotFragment);
  }

  public static <T> T callSiteAtLine(int line, java.util.function.Supplier<T> supplier) {
    emitLineAtLine(line);
    return supplier.get();
  }

  public static void emitCallAtLine(int line, String functionName, String argsJson) {
    ThreadState state = state();
    if (dropIfStorageExhausted()) {
      state.callStack.add(new TraceFrame(functionName == null ? "" : functionName, line, null));
      state.callStackJson = null;
      return;
    }
    StringBuilder out = new StringBuilder("trace:{\"kind\":\"call\",\"line\":");
    out.append(line).append(",\"function\":").append(jsonString(functionName == null ? "" : functionName));
    String argsPayload = argsJsonPayload(argsJson);
    if (argsPayload != null) out.append(",\"args\":").append(argsPayload);
    state.callStack.add(new TraceFrame(functionName == null ? "" : functionName, line, argsPayload));
    state.callStackJson = null;
    out.append("}");
    emit(out.toString());
    emitSnapshotsFromFragment(line, argsJson);
  }

  public static void emitReturnAtLine(int line, String functionName) {
    emitReturnAtLine(line, functionName, null);
  }

  public static void emitReturnAtLine(int line, String functionName, Object value) {
    if (dropIfStorageExhausted()) {
      popCallFrame(functionName);
      return;
    }
    StringBuilder out = new StringBuilder("trace:{\"kind\":\"return\",\"line\":");
    out.append(line).append(",\"function\":").append(jsonString(functionName == null ? "" : functionName));
    if (value != null) out.append(",\"value\":").append(serializeResult(value));
    out.append("}");
    emit(out.toString());
    popCallFrame(functionName);
  }

  public static void emitSerializedReturnAtLine(int line, String functionName, String serializedValue) {
    if (dropIfStorageExhausted()) {
      popCallFrame(functionName);
      return;
    }
    StringBuilder out = new StringBuilder("trace:{\"kind\":\"return\",\"line\":");
    out.append(line).append(",\"function\":").append(jsonString(functionName == null ? "" : functionName));
    if (serializedValue != null) out.append(",\"value\":").append(serializedValue);
    out.append("}");
    emit(out.toString());
    popCallFrame(functionName);
  }

  public static void emitRuntimeSnapshotAtLine(int line, String name, Object value) {
    profileSnapshotCalls += 1;
    if (dropIfStorageExhausted()) return;
    emitSnapshot(line, name, serializeResult(value));
  }

  public static void emitFieldWriteAtLine(int line, String name, String field, Object value) {
    emitTraceWrite(line, name, "[" + jsonString(field) + "]", value);
  }

  public static void emitFieldPathWriteAtLine(int line, String name, String[] fields, Object value) {
    StringBuilder path = new StringBuilder("[");
    for (int index = 0; index < fields.length; index++) {
      if (index > 0) path.append(",");
      path.append(jsonString(fields[index]));
    }
    path.append("]");
    emitTraceWrite(line, name, path.toString(), value);
  }

  public static <T> T readFieldPathAtLine(int line, String name, String[] fields, T value) {
    StringBuilder path = new StringBuilder("[");
    for (int index = 0; index < fields.length; index++) {
      if (index > 0) path.append(",");
      path.append(jsonString(fields[index]));
    }
    path.append("]");
    emitTraceRead(line, name, path.toString(), value);
    return value;
  }

  public static void emitArrayWriteAtLine(int line, String name, int index, Object value) {
    if (dropIfStorageExhausted()) return;
    emitTraceWrite(line, name, "[" + index + "]", value);
  }

  public static void emitArrayWriteAtLine(int line, String name, int index, Object value, String indexSource) {
    profileWriteArrayCalls += 1;
    if (dropIfStorageExhausted()) return;
    if (NATIVE_JSON_AVAILABLE) {
      String sourcesJson = indexSource == null || indexSource.isEmpty()
          ? INDEX_SOURCES_SINGLE_NULL
          : indexSourcesJsonSingle(indexSource);
      String valueJson = serializeResult(value);
      if (emitFastIndexed("write", line, name, index, sourcesJson, valueJson)) return;
      emitTraceWriteSerialized(line, name, "[" + index + "]", valueJson, sourcesJson);
      return;
    }
    emitTraceWrite(line, name, "[" + index + "]", value, indexSourcesJson(indexSource));
  }

  public static void emitArrayWriteAtLine(int line, String name, int row, int col, Object value) {
    if (dropIfStorageExhausted()) return;
    emitTraceWrite(line, name, "[" + row + "," + col + "]", value);
  }

  public static void emitArrayWriteAtLine(int line, String name, int row, int col, Object value, String rowSource, String colSource) {
    if (dropIfStorageExhausted()) return;
    emitTraceWrite(line, name, "[" + row + "," + col + "]", value, indexSourcesJson(rowSource, colSource));
  }

  public static void emitIndexedWriteAtLine(int line, String name, Object[] path, Object value, String... indexSources) {
    if (dropIfStorageExhausted()) return;
    StringBuilder pathJson = new StringBuilder("[");
    for (int index = 0; index < path.length; index++) {
      if (index > 0) pathJson.append(",");
      pathJson.append(serializeResult(path[index]));
    }
    pathJson.append("]");
    emitTraceWrite(line, name, pathJson.toString(), value, indexSourcesJson(indexSources));
  }

  public static void fillArrayAtLine(int line, String name, int[] values, int value) {
    java.util.Arrays.fill(values, value);
    emitTraceMutate(line, name, null, "fill", null, "[" + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static void fillArrayAtLine(int line, String name, long[] values, long value) {
    java.util.Arrays.fill(values, value);
    emitTraceMutate(line, name, null, "fill", null, "[" + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static void fillArrayAtLine(int line, String name, boolean[] values, boolean value) {
    java.util.Arrays.fill(values, value);
    emitTraceMutate(line, name, null, "fill", null, "[" + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static void fillArrayAtLine(int line, String name, char[] values, char value) {
    java.util.Arrays.fill(values, value);
    emitTraceMutate(line, name, null, "fill", null, "[" + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static void fillArrayAtLine(int line, String name, byte[] values, byte value) {
    java.util.Arrays.fill(values, value);
    emitTraceMutate(line, name, null, "fill", null, "[" + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static void fillArrayAtLine(int line, String name, short[] values, short value) {
    java.util.Arrays.fill(values, value);
    emitTraceMutate(line, name, null, "fill", null, "[" + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static void fillArrayAtLine(int line, String name, float[] values, float value) {
    java.util.Arrays.fill(values, value);
    emitTraceMutate(line, name, null, "fill", null, "[" + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static void fillArrayAtLine(int line, String name, double[] values, double value) {
    java.util.Arrays.fill(values, value);
    emitTraceMutate(line, name, null, "fill", null, "[" + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static <T> void fillArrayAtLine(int line, String name, T[] values, T value) {
    java.util.Arrays.fill(values, value);
    emitTraceMutate(line, name, null, "fill", null, "[" + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static void fillArrayAtLine(int line, String name, int[][] values, int index, String indexSource, int value) {
    int[] row = values[index];
    emitArrayRowReadAtLine(line, name, index, indexSource, row);
    java.util.Arrays.fill(row, value);
    emitArrayRowFillAtLine(line, name, values, index, indexSource, row, value);
  }

  public static void fillArrayAtLine(int line, String name, long[][] values, int index, String indexSource, long value) {
    long[] row = values[index];
    emitArrayRowReadAtLine(line, name, index, indexSource, row);
    java.util.Arrays.fill(row, value);
    emitArrayRowFillAtLine(line, name, values, index, indexSource, row, value);
  }

  public static void fillArrayAtLine(int line, String name, boolean[][] values, int index, String indexSource, boolean value) {
    boolean[] row = values[index];
    emitArrayRowReadAtLine(line, name, index, indexSource, row);
    java.util.Arrays.fill(row, value);
    emitArrayRowFillAtLine(line, name, values, index, indexSource, row, value);
  }

  public static void fillArrayAtLine(int line, String name, char[][] values, int index, String indexSource, char value) {
    char[] row = values[index];
    emitArrayRowReadAtLine(line, name, index, indexSource, row);
    java.util.Arrays.fill(row, value);
    emitArrayRowFillAtLine(line, name, values, index, indexSource, row, value);
  }

  public static void fillArrayAtLine(int line, String name, byte[][] values, int index, String indexSource, byte value) {
    byte[] row = values[index];
    emitArrayRowReadAtLine(line, name, index, indexSource, row);
    java.util.Arrays.fill(row, value);
    emitArrayRowFillAtLine(line, name, values, index, indexSource, row, value);
  }

  public static void fillArrayAtLine(int line, String name, short[][] values, int index, String indexSource, short value) {
    short[] row = values[index];
    emitArrayRowReadAtLine(line, name, index, indexSource, row);
    java.util.Arrays.fill(row, value);
    emitArrayRowFillAtLine(line, name, values, index, indexSource, row, value);
  }

  public static void fillArrayAtLine(int line, String name, float[][] values, int index, String indexSource, float value) {
    float[] row = values[index];
    emitArrayRowReadAtLine(line, name, index, indexSource, row);
    java.util.Arrays.fill(row, value);
    emitArrayRowFillAtLine(line, name, values, index, indexSource, row, value);
  }

  public static void fillArrayAtLine(int line, String name, double[][] values, int index, String indexSource, double value) {
    double[] row = values[index];
    emitArrayRowReadAtLine(line, name, index, indexSource, row);
    java.util.Arrays.fill(row, value);
    emitArrayRowFillAtLine(line, name, values, index, indexSource, row, value);
  }

  public static <T> void fillArrayAtLine(int line, String name, T[][] values, int index, String indexSource, T value) {
    T[] row = values[index];
    emitArrayRowReadAtLine(line, name, index, indexSource, row);
    java.util.Arrays.fill(row, value);
    emitArrayRowFillAtLine(line, name, values, index, indexSource, row, value);
  }

  public static void sortArrayAtLine(int line, String name, int[] values) {
    java.util.Arrays.sort(values);
    emitTraceMutate(line, name, null, "sort", null, "[]");
    emitArrayIndexedWritesAtLine(line, name, values);
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static void sortArrayAtLine(int line, String name, long[] values) {
    java.util.Arrays.sort(values);
    emitTraceMutate(line, name, null, "sort", null, "[]");
    emitArrayIndexedWritesAtLine(line, name, values);
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static void sortArrayAtLine(int line, String name, double[] values) {
    java.util.Arrays.sort(values);
    emitTraceMutate(line, name, null, "sort", null, "[]");
    emitArrayIndexedWritesAtLine(line, name, values);
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static void sortArrayAtLine(int line, String name, char[] values) {
    java.util.Arrays.sort(values);
    emitTraceMutate(line, name, null, "sort", null, "[]");
    emitArrayIndexedWritesAtLine(line, name, values);
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static <T> void sortArrayAtLine(int line, String name, T[] values) {
    java.util.Arrays.sort(values);
    emitTraceMutate(line, name, null, "sort", null, "[]");
    emitArrayIndexedWritesAtLine(line, name, values);
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static <T> void sortArrayAtLine(int line, String name, T[] values, java.util.Comparator<? super T> comparator) {
    java.util.Arrays.sort(values, comparator);
    emitTraceMutate(line, name, null, "sort", null, "[]");
    emitArrayIndexedWritesAtLine(line, name, values);
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static <T> void sortListAtLine(int line, String name, java.util.List<T> values, java.util.Comparator<? super T> comparator) {
    values.sort(comparator);
    emitTraceMutate(line, name, null, "sort", null, "[]");
    emitCollectionIndexedWritesAtLine(line, name, values);
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static <T> void sortFieldListAtLine(
      int line,
      String name,
      String field,
      java.util.List<T> values,
      java.util.Comparator<? super T> comparator,
      String snapshotName,
      Object snapshotValue) {
    String pathJson = "[" + jsonString(field) + "]";
    emitTraceRead(line, name, pathJson, values);
    values.sort(comparator);
    emitTraceMutate(line, name, pathJson, "sort", null, "[]");
    emitCollectionIndexedWritesAtLine(line, name, new Object[] { field }, values);
    emitRuntimeSnapshotAtLine(line, snapshotName, snapshotValue);
  }

  public static <T> T readObjectFieldAtLine(int line, String name, String field, T value) {
    emitTraceRead(line, name, "[" + jsonString(field) + "]", value);
    return value;
  }

  public static <T> T readIndexedObjectFieldAtLine(int line, String name, Object index, String field, T value) {
    emitTraceRead(line, name, "[" + serializeResult(index) + "," + jsonString(field) + "]", value);
    return value;
  }

  public static <T> T readIndexedObjectFieldAtLine(int line, String name, Object index, String field, T value, String indexSource) {
    emitTraceRead(line, name, "[" + serializeResult(index) + "," + jsonString(field) + "]", value, indexSourcesJson(indexSource, null));
    return value;
  }

  public static void emitExceptionAtLine(int line, Object value) {
    if (dropIfStorageExhausted()) return;
    emit("trace:{\"kind\":\"exception\",\"line\":" + line + ",\"value\":" + serializeResult(value) + "}");
  }

  public static void emitStdoutAtLine(int line, Object value) {
    if (dropIfStorageExhausted()) return;
    emit("trace:{\"kind\":\"stdout\",\"line\":" + line + ",\"value\":" + serializeResult(value) + "}");
  }

  public static boolean traceCondition(int line, boolean value) {
    emitLineAtLine(line);
    return value;
  }

  private static String serializeResult(Object value, java.util.IdentityHashMap<Object, String> seen, int depth, boolean capValues) {
    if (depth > MAX_SERIALIZE_DEPTH) return "\"<max depth>\"";
    if (value == null) return "null";
    if (NATIVE_JSON_AVAILABLE) {
      // One native call replaces the whole interpreted instanceof cascade for
      // the final scalar box classes; anything else comes back null.
      String fast = serializeScalar0(value);
      if (fast != null) return fast;
    }
    if (value instanceof int[]) {
      return serializePrimitiveIntArray((int[]) value, seen, capValues);
    }
    if (value instanceof long[]) {
      return serializePrimitiveLongArray((long[]) value, seen, capValues);
    }
    if (value instanceof double[]) {
      return serializePrimitiveDoubleArray((double[]) value, seen, capValues);
    }
    if (value instanceof boolean[]) {
      return serializePrimitiveBooleanArray((boolean[]) value, seen, capValues);
    }
    if (value instanceof byte[]) {
      return serializePrimitiveByteArray((byte[]) value, seen, capValues);
    }
    if (value instanceof short[]) {
      return serializePrimitiveShortArray((short[]) value, seen, capValues);
    }
    if (value instanceof float[]) {
      return serializePrimitiveFloatArray((float[]) value, seen, capValues);
    }
    if (value instanceof char[]) {
      return serializePrimitiveCharArray((char[]) value, seen, capValues);
    }
    if (value != null && value.getClass().isArray()) {
      if (seen.containsKey(value)) return "{\"__ref__\":" + jsonString(seen.get(value)) + "}";
      seen.put(value, "ref-" + seen.size());
      int length = java.lang.reflect.Array.getLength(value);
      int emitted = capValues ? Math.min(length, MAX_SERIALIZED_ITEMS) : length;
      StringBuilder out = new StringBuilder("[");
      for (int index = 0; index < emitted; index++) {
        if (index > 0) out.append(",");
        out.append(serializeResult(java.lang.reflect.Array.get(value, index), seen, depth + 1, capValues));
      }
      if (capValues) appendArrayTruncationMarker(out, emitted, length);
      out.append("]");
      return out.toString();
    }
    if (value instanceof Double) {
      double number = ((Double) value).doubleValue();
      if (Double.isNaN(number)) return "\"NaN\"";
      if (Double.isInfinite(number)) return number > 0 ? "\"Infinity\"" : "\"-Infinity\"";
    }
    if (value instanceof Float) {
      float number = ((Float) value).floatValue();
      if (Float.isNaN(number)) return "\"NaN\"";
      if (Float.isInfinite(number)) return number > 0 ? "\"Infinity\"" : "\"-Infinity\"";
    }
    if (value instanceof java.util.Set<?>) {
      if (seen.containsKey(value)) return "{\"__ref__\":" + jsonString(seen.get(value)) + "}";
      seen.put(value, "ref-" + seen.size());
      java.util.Set<?> set = (java.util.Set<?>) value;
      StringBuilder out = new StringBuilder("{\"__type__\":\"set\",\"values\":[");
      int index = 0;
      for (Object item : set) {
        if (capValues && index >= MAX_SERIALIZED_ITEMS) break;
        if (index > 0) out.append(",");
        out.append(serializeResult(item, seen, depth + 1, capValues));
        index++;
      }
      out.append("]");
      if (capValues && index < set.size()) {
        out.append(",");
        appendObjectTruncationFields(out, set.size() - index);
      }
      out.append("}");
      return out.toString();
    }
    if (value instanceof java.util.Collection<?>) {
      if (seen.containsKey(value)) return "{\"__ref__\":" + jsonString(seen.get(value)) + "}";
      seen.put(value, "ref-" + seen.size());
      java.util.Collection<?> collection = (java.util.Collection<?>) value;
      StringBuilder out = new StringBuilder("[");
      int index = 0;
      for (Object item : collection) {
        if (capValues && index >= MAX_SERIALIZED_ITEMS) break;
        if (index > 0) out.append(",");
        out.append(serializeResult(item, seen, depth + 1, capValues));
        index++;
      }
      if (capValues) appendArrayTruncationMarker(out, index, collection.size());
      out.append("]");
      return out.toString();
    }
    if (value instanceof java.util.Map<?, ?>) {
      if (seen.containsKey(value)) return "{\"__ref__\":" + jsonString(seen.get(value)) + "}";
      seen.put(value, "ref-" + seen.size());
      java.util.Map<?, ?> map = (java.util.Map<?, ?>) value;
      StringBuilder out = new StringBuilder("{");
      int index = 0;
      for (java.util.Map.Entry<?, ?> entry : map.entrySet()) {
        if (capValues && index >= MAX_SERIALIZED_ITEMS) break;
        if (index > 0) out.append(",");
        out.append(jsonString(String.valueOf(entry.getKey()))).append(":").append(serializeResult(entry.getValue(), seen, depth + 1, capValues));
        index++;
      }
      if (capValues && index < map.size()) {
        if (index > 0) out.append(",");
        appendObjectTruncationFields(out, map.size() - index);
      }
      out.append("}");
      return out.toString();
    }
    if (isUserObject(value)) {
      return serializeUserObject(value, seen, depth, capValues);
    }
    if (value instanceof Number || value instanceof Boolean) {
      return String.valueOf(value);
    }
    if (value instanceof Character || value instanceof CharSequence || value instanceof Enum<?>) {
      return jsonString(String.valueOf(value));
    }
    return jsonString(String.valueOf(value));
  }

  private static void appendArrayTruncationMarker(StringBuilder out, int emitted, int total) {
    if (emitted >= total) return;
    if (emitted > 0) out.append(",");
    out.append("{\"__truncated__\":true,\"remaining\":").append(total - emitted).append("}");
  }

  private static String serializePrimitiveIntArray(int[] values, java.util.IdentityHashMap<Object, String> seen, boolean capValues) {
    if (seen.containsKey(values)) return "{\"__ref__\":" + jsonString(seen.get(values)) + "}";
    seen.put(values, "ref-" + seen.size());
    return serializeIntArrayRoot(values, capValues);
  }

  private static String serializeIntArrayRoot(int[] values, boolean capValues) {
    int emitted = capValues ? Math.min(values.length, MAX_SERIALIZED_ITEMS) : values.length;
    if (NATIVE_JSON_AVAILABLE) {
      String json = jsonIntArray0(values, emitted, values.length);
      if (json != null) return json;
    }
    StringBuilder out = new StringBuilder(32 + emitted * 3);
    out.append('[');
    for (int index = 0; index < emitted; index++) {
      if (index > 0) out.append(',');
      out.append(values[index]);
    }
    if (capValues) appendArrayTruncationMarker(out, emitted, values.length);
    out.append(']');
    return out.toString();
  }

  private static String serializePrimitiveLongArray(long[] values, java.util.IdentityHashMap<Object, String> seen, boolean capValues) {
    if (seen.containsKey(values)) return "{\"__ref__\":" + jsonString(seen.get(values)) + "}";
    seen.put(values, "ref-" + seen.size());
    return serializeLongArrayRoot(values, capValues);
  }

  private static String serializeLongArrayRoot(long[] values, boolean capValues) {
    int emitted = capValues ? Math.min(values.length, MAX_SERIALIZED_ITEMS) : values.length;
    if (NATIVE_JSON_AVAILABLE) {
      String json = jsonLongArray0(values, emitted, values.length);
      if (json != null) return json;
    }
    StringBuilder out = new StringBuilder(32 + emitted * 3);
    out.append('[');
    for (int index = 0; index < emitted; index++) {
      if (index > 0) out.append(',');
      out.append(values[index]);
    }
    if (capValues) appendArrayTruncationMarker(out, emitted, values.length);
    out.append(']');
    return out.toString();
  }

  private static String serializePrimitiveDoubleArray(double[] values, java.util.IdentityHashMap<Object, String> seen, boolean capValues) {
    if (seen.containsKey(values)) return "{\"__ref__\":" + jsonString(seen.get(values)) + "}";
    seen.put(values, "ref-" + seen.size());
    int emitted = capValues ? Math.min(values.length, MAX_SERIALIZED_ITEMS) : values.length;
    StringBuilder out = new StringBuilder("[");
    for (int index = 0; index < emitted; index++) {
      if (index > 0) out.append(",");
      out.append(serializeResult(values[index], seen, 1, capValues));
    }
    if (capValues) appendArrayTruncationMarker(out, emitted, values.length);
    out.append("]");
    return out.toString();
  }

  private static String serializePrimitiveBooleanArray(boolean[] values, java.util.IdentityHashMap<Object, String> seen, boolean capValues) {
    if (seen.containsKey(values)) return "{\"__ref__\":" + jsonString(seen.get(values)) + "}";
    seen.put(values, "ref-" + seen.size());
    int emitted = capValues ? Math.min(values.length, MAX_SERIALIZED_ITEMS) : values.length;
    StringBuilder out = new StringBuilder("[");
    for (int index = 0; index < emitted; index++) {
      if (index > 0) out.append(",");
      out.append(values[index]);
    }
    if (capValues) appendArrayTruncationMarker(out, emitted, values.length);
    out.append("]");
    return out.toString();
  }

  private static String serializePrimitiveByteArray(byte[] values, java.util.IdentityHashMap<Object, String> seen, boolean capValues) {
    if (seen.containsKey(values)) return "{\"__ref__\":" + jsonString(seen.get(values)) + "}";
    seen.put(values, "ref-" + seen.size());
    int emitted = capValues ? Math.min(values.length, MAX_SERIALIZED_ITEMS) : values.length;
    StringBuilder out = new StringBuilder("[");
    for (int index = 0; index < emitted; index++) {
      if (index > 0) out.append(",");
      out.append(values[index]);
    }
    if (capValues) appendArrayTruncationMarker(out, emitted, values.length);
    out.append("]");
    return out.toString();
  }

  private static String serializePrimitiveShortArray(short[] values, java.util.IdentityHashMap<Object, String> seen, boolean capValues) {
    if (seen.containsKey(values)) return "{\"__ref__\":" + jsonString(seen.get(values)) + "}";
    seen.put(values, "ref-" + seen.size());
    int emitted = capValues ? Math.min(values.length, MAX_SERIALIZED_ITEMS) : values.length;
    StringBuilder out = new StringBuilder("[");
    for (int index = 0; index < emitted; index++) {
      if (index > 0) out.append(",");
      out.append(values[index]);
    }
    if (capValues) appendArrayTruncationMarker(out, emitted, values.length);
    out.append("]");
    return out.toString();
  }

  private static String serializePrimitiveFloatArray(float[] values, java.util.IdentityHashMap<Object, String> seen, boolean capValues) {
    if (seen.containsKey(values)) return "{\"__ref__\":" + jsonString(seen.get(values)) + "}";
    seen.put(values, "ref-" + seen.size());
    int emitted = capValues ? Math.min(values.length, MAX_SERIALIZED_ITEMS) : values.length;
    StringBuilder out = new StringBuilder("[");
    for (int index = 0; index < emitted; index++) {
      if (index > 0) out.append(",");
      out.append(serializeResult(values[index], seen, 1, capValues));
    }
    if (capValues) appendArrayTruncationMarker(out, emitted, values.length);
    out.append("]");
    return out.toString();
  }

  private static String serializePrimitiveCharArray(char[] values, java.util.IdentityHashMap<Object, String> seen, boolean capValues) {
    if (seen.containsKey(values)) return "{\"__ref__\":" + jsonString(seen.get(values)) + "}";
    seen.put(values, "ref-" + seen.size());
    int emitted = capValues ? Math.min(values.length, MAX_SERIALIZED_ITEMS) : values.length;
    StringBuilder out = new StringBuilder("[");
    for (int index = 0; index < emitted; index++) {
      if (index > 0) out.append(",");
      out.append(jsonString(String.valueOf(values[index])));
    }
    if (capValues) appendArrayTruncationMarker(out, emitted, values.length);
    out.append("]");
    return out.toString();
  }

  private static void appendObjectTruncationFields(StringBuilder out, int remaining) {
    out.append("\"__truncated__\":true,\"remaining\":").append(Math.max(0, remaining));
  }

  private static boolean isUserObject(Object value) {
    if (value == null) return false;
    if (value instanceof java.util.Collection<?>) return false;
    if (value instanceof java.util.Map<?, ?>) return false;
    if (value instanceof Number || value instanceof Boolean || value instanceof CharSequence || value instanceof Character) return false;
    Package packageInfo = value.getClass().getPackage();
    String packageName = packageInfo == null ? "" : packageInfo.getName();
    return packageName.equals("harness.user")
        || packageName.startsWith("harness.user.")
        || packageName.equals("tracecode.user")
        || packageName.startsWith("tracecode.user.");
  }

  private static String serializeUserObject(Object value, java.util.IdentityHashMap<Object, String> seen, int depth, boolean capValues) {
    if (seen.containsKey(value)) return "{\"__ref__\":" + jsonString(seen.get(value)) + "}";
    String nodeId = stableTraceReferenceId(value, value.getClass().getSimpleName());
    seen.put(value, nodeId);
    StringBuilder out = new StringBuilder("{");
    out.append("\"__type__\":").append(jsonString(value.getClass().getSimpleName()));
    out.append(",\"__class__\":").append(jsonString(value.getClass().getSimpleName()));
    out.append(",\"__id__\":").append(jsonString(nodeId));
    java.lang.reflect.Field[] fields = value.getClass().getDeclaredFields();
    java.util.Arrays.sort(fields, java.util.Comparator.comparing(java.lang.reflect.Field::getName));
    int emitted = 0;
    int eligible = 0;
    for (java.lang.reflect.Field field : fields) {
      if (java.lang.reflect.Modifier.isStatic(field.getModifiers())) continue;
      eligible++;
      if (capValues && emitted >= MAX_OBJECT_FIELDS) continue;
      try {
        field.setAccessible(true);
        out.append(",").append(jsonString(field.getName())).append(":").append(serializeResult(field.get(value), seen, depth + 1, capValues));
        emitted++;
      } catch (Exception ignored) {
      }
    }
    if (capValues && eligible > emitted) {
      out.append(",");
      appendObjectTruncationFields(out, eligible - emitted);
    }
    out.append("}");
    return out.toString();
  }

  private static String stableTraceReferenceId(Object value, String typeName) {
    synchronized (STATE_LOCK) {
      String existing = TRACE_REFERENCE_IDS.get(value);
      if (existing != null) return existing;
      String id = typeName + ":" + (++nextTraceReferenceId);
      TRACE_REFERENCE_IDS.put(value, id);
      return id;
    }
  }

  private static String sanitizeJsonNonFiniteNumbers(String event) {
    if (event.indexOf("NaN") < 0 && event.indexOf("Infinity") < 0) return event;
    return event
        .replaceAll("(?<![A-Za-z0-9_\\\"])-Infinity(?![A-Za-z0-9_\\\"])", "\"-Infinity\"")
        .replaceAll("(?<![A-Za-z0-9_\\\"])Infinity(?![A-Za-z0-9_\\\"])", "\"Infinity\"")
        .replaceAll("(?<![A-Za-z0-9_\\\"])NaN(?![A-Za-z0-9_\\\"])", "\"NaN\"");
  }

  private static String withCallStack(String event) {
    java.util.List<TraceFrame> stack = state().callStack;
    if (stack.isEmpty() || !event.endsWith("}")) return event;
    StringBuilder out = acquireEventBuilder();
    try {
      out.append(event, 0, event.length() - 1);
      appendCallStackProperty(out);
      out.append('}');
      return out.toString();
    } finally {
      releaseEventBuilder(out);
    }
  }

  private static String serializeCallStack(java.util.List<TraceFrame> stack) {
    StringBuilder out = new StringBuilder("[");
    for (int index = 0; index < stack.size(); index++) {
      if (index > 0) out.append(",");
      TraceFrame frame = stack.get(index);
      out.append("{\"function\":").append(jsonString(frame.functionName)).append(",\"line\":").append(frame.line);
      if (frame.argsJson != null) out.append(",\"args\":").append(frame.argsJson);
      out.append("}");
    }
    out.append("]");
    return out.toString();
  }

  private static void popCallFrame(String functionName) {
    ThreadState state = state();
    java.util.List<TraceFrame> stack = state.callStack;
    if (stack.isEmpty()) return;
    String normalized = functionName == null ? "" : functionName;
    int last = stack.size() - 1;
    if (stack.get(last).functionName.equals(normalized)) {
      stack.remove(last);
      state.callStackJson = null;
      return;
    }
    for (int index = last; index >= 0; index--) {
      if (stack.get(index).functionName.equals(normalized)) {
        stack.subList(index, stack.size()).clear();
        state.callStackJson = null;
        return;
      }
    }
  }

  private static String argsJsonPayload(String snapshotFragment) {
    if (snapshotFragment == null) return null;
    String fragment = snapshotFragment.trim();
    if (fragment.isEmpty()) return null;
    if (fragment.startsWith("{")) return fragment;
    java.util.List<SnapshotEntry> entries = parseSnapshotEntries(fragment);
    if (entries.isEmpty()) return null;
    StringBuilder out = new StringBuilder("{");
    for (int index = 0; index < entries.size(); index++) {
      SnapshotEntry entry = entries.get(index);
      if (index > 0) out.append(",");
      out.append(jsonString(entry.name)).append(":").append(entry.value);
    }
    out.append("}");
    return out.toString();
  }

  private static void emitSnapshotsFromFragment(int line, String snapshotFragment) {
    for (SnapshotEntry entry : parseSnapshotEntries(snapshotFragment)) {
      emitSnapshot(line, entry.name, entry.value);
    }
  }

  private static java.util.List<SnapshotEntry> parseSnapshotEntries(String snapshotFragment) {
    java.util.List<SnapshotEntry> entries = new java.util.ArrayList<>();
    if (snapshotFragment == null) return entries;
    String fragment = snapshotFragment.trim();
    if (fragment.isEmpty() || fragment.startsWith("{")) return entries;

    int cursor = 0;
    while (cursor < fragment.length()) {
      while (cursor < fragment.length() && Character.isWhitespace(fragment.charAt(cursor))) cursor++;
      int nameStart = cursor;
      while (cursor < fragment.length()) {
        char ch = fragment.charAt(cursor);
        if (ch == '=') break;
        if (Character.isWhitespace(ch)) break;
        cursor++;
      }
      if (cursor >= fragment.length() || fragment.charAt(cursor) != '=') {
        cursor++;
        continue;
      }
      String name = fragment.substring(nameStart, cursor).trim().replace('.', '_');
      cursor++;
      int valueStart = cursor;
      int valueEnd = findSerializedValueEnd(fragment, valueStart);
      if (valueEnd <= valueStart) break;
      String value = fragment.substring(valueStart, valueEnd).trim();
      if (!name.isEmpty() && !value.isEmpty()) entries.add(new SnapshotEntry(name, value));
      cursor = valueEnd;
    }
    return entries;
  }

  private static int findSerializedValueEnd(String source, int start) {
    int cursor = start;
    while (cursor < source.length() && Character.isWhitespace(source.charAt(cursor))) cursor++;
    if (cursor >= source.length()) return cursor;

    char first = source.charAt(cursor);
    if (first == '"' || first == '\'') return findQuotedValueEnd(source, cursor, first);
    if (first == '[' || first == '{') return findBalancedValueEnd(source, cursor);

    while (cursor < source.length()) {
      char ch = source.charAt(cursor);
      if (Character.isWhitespace(ch) && looksLikeNextSnapshotName(source, cursor + 1)) break;
      cursor++;
    }
    return cursor;
  }

  private static int findQuotedValueEnd(String source, int start, char quote) {
    boolean escaped = false;
    for (int index = start + 1; index < source.length(); index++) {
      char ch = source.charAt(index);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch == '\\') {
        escaped = true;
        continue;
      }
      if (ch == quote) return index + 1;
    }
    return source.length();
  }

  private static int findBalancedValueEnd(String source, int start) {
    int depth = 0;
    boolean inString = false;
    boolean escaped = false;
    for (int index = start; index < source.length(); index++) {
      char ch = source.charAt(index);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString) {
        if (ch == '\\') {
          escaped = true;
        } else if (ch == '"') {
          inString = false;
        }
        continue;
      }
      if (ch == '"') {
        inString = true;
        continue;
      }
      if (ch == '[' || ch == '{') depth++;
      if (ch == ']' || ch == '}') {
        depth--;
        if (depth <= 0) return index + 1;
      }
    }
    return source.length();
  }

  private static boolean looksLikeNextSnapshotName(String source, int start) {
    int cursor = start;
    while (cursor < source.length() && Character.isWhitespace(source.charAt(cursor))) cursor++;
    if (cursor >= source.length()) return false;
    char first = source.charAt(cursor);
    if (!(Character.isLetter(first) || first == '_')) return false;
    cursor++;
    while (cursor < source.length()) {
      char ch = source.charAt(cursor);
      if (ch == '=') return true;
      if (!(Character.isLetterOrDigit(ch) || ch == '_' || ch == '.')) return false;
      cursor++;
    }
    return false;
  }

  private static void emitSnapshot(int line, String name, String serializedValue) {
    if (dropIfStorageExhausted()) return;
    if (emitFast("snapshot", line, name, null, null, serializedValue, null)) return;
    StringBuilder out = acquireEventBuilder();
    out.append("trace:{\"kind\":\"snapshot\",\"line\":").append(line);
    out.append(",\"target\":{\"variable\":").append(jsonString(name)).append("},\"value\":").append(serializedValue);
    emitEventBody(out);
  }

  public static void emitMutatingCallAtLine(int line, String name, String method) {
    emitTraceMutate(line, name, null, method, null, "[]");
  }

  public static void emitMutatingCallAtLine(int line, String name, String method, Object... args) {
    emitTraceMutate(line, name, null, method, null, serializeArgs(args));
  }

  public static void emitNoArgMutatingCallAtLine(int line, String name, String method) {
    emitTraceMutate(line, name, null, method, null, "[]");
  }

  public static <T> T readQueuePeekAtLine(int line, String name, java.util.Queue<T> queue) {
    T value = queue.peek();
    emitTraceRead(line, name, "[0]", value);
    return value;
  }

  public static <T> T removeQueueAtLine(int line, String name, java.util.Queue<T> queue) {
    T value = queue.peek();
    emitTraceRead(line, name, "[0]", value);
    value = queue.remove();
    emitTraceMutate(line, name, null, "remove", null, "[]");
    if (queue instanceof java.util.PriorityQueue<?>) {
      emitCollectionIndexedWritesAtLine(line, name, queue);
    }
    emitSnapshot(line, name, serializeResult(queue));
    return value;
  }

  public static void emitMutatingCallAtLine(int line, String name, int index, String method) {
    emitTraceMutate(line, name, "[" + serializeResult(index) + "]", method, null, "[]");
  }

  public static void emitMutatingCallAtLine(int line, String name, int index, String method, String indexSource) {
    emitTraceMutate(line, name, "[" + serializeResult(index) + "]", method, indexSourcesJson(indexSource), "[]");
  }

  public static void emitMutatingCallAtLine(int line, String name, Object key, String method, String indexSource) {
    emitTraceMutate(line, name, "[" + serializeResult(key) + "]", method, indexSourcesJson(indexSource), "[]");
  }

  public static void emitMutatingCallAtLine(int line, String name, Object key, String method, String indexSource, Object value) {
    emitTraceMutate(line, name, "[" + serializeResult(key) + "]", method, indexSourcesJson(indexSource), "[" + serializeResult(value) + "]");
  }

  public static void emitKeyedMutatingCallAtLine(int line, String name, String method, Object key) {
    emitTraceMutate(line, name, "[" + serializeResult(key) + "]", method, null, "[]");
  }

  public static void emitKeyedMutatingCallAtLine(int line, String name, String method, Object key, Object value) {
    emitTraceMutate(line, name, "[" + serializeResult(key) + "]", method, null, "[" + serializeResult(value) + "]");
  }

  public static <T> Iterable<T> iterationBindAtLine(int line, String name, Iterable<T> values, String bindingVariable) {
    return new Iterable<T>() {
      @Override
      public java.util.Iterator<T> iterator() {
        final java.util.Iterator<T> iterator = values.iterator();
        return new java.util.Iterator<T>() {
          private int index = 0;

          @Override
          public boolean hasNext() {
            boolean hasNext = iterator.hasNext();
            if (!hasNext) {
              emitLineAtLine(line);
            }
            return hasNext;
          }

          @Override
          public T next() {
            T value = iterator.next();
            emitTraceReadWithIterationBinding(line, name, "[" + serializeResult(index) + "]", value, bindingVariable);
            index++;
            return value;
          }
        };
      }
    };
  }

  public static <T> Iterable<T> iterationBindAtLine(int line, String name, Object parentKey, Iterable<T> values, String bindingVariable, String parentKeySource) {
    return new Iterable<T>() {
      @Override
      public java.util.Iterator<T> iterator() {
        final java.util.Iterator<T> iterator = values.iterator();
        return new java.util.Iterator<T>() {
          private int index = 0;

          @Override
          public boolean hasNext() {
            boolean hasNext = iterator.hasNext();
            if (!hasNext) {
              emitLineAtLine(line);
            }
            return hasNext;
          }

          @Override
          public T next() {
            T value = iterator.next();
            emitTraceReadWithIterationBinding(
                line,
                name,
                "[" + serializeResult(parentKey) + "," + serializeResult(index) + "]",
                value,
                bindingVariable,
                indexSourcesJson(parentKeySource, null));
            index++;
            return value;
          }
        };
      }
    };
  }

  @SuppressWarnings("unchecked")
  public static <T> Iterable<T> iterationBindListAtLine(
      int line,
      String name,
      java.util.List<?> values,
      int index,
      String bindingVariable,
      String indexSource) {
    Object row = values.get(index);
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", row, indexSourcesJson(indexSource));
    return iterationBindNestedValuesAtLine(line, name, index, row, bindingVariable, indexSource);
  }

  public static <T> Iterable<T> iterationBindArrayAtLine(
      int line,
      String name,
      Object values,
      int index,
      String bindingVariable,
      String indexSource) {
    Object row = java.lang.reflect.Array.get(values, index);
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", row, indexSourcesJson(indexSource));
    return iterationBindNestedValuesAtLine(line, name, index, row, bindingVariable, indexSource);
  }

  public static <T> Iterable<T> iterationBindAtLine(int line, String name, T[] values, String bindingVariable) {
    return iterationBindAtLine(line, name, java.util.Arrays.asList(values), bindingVariable);
  }

  public static Iterable<Integer> iterationBindAtLine(int line, String name, int[] values, String bindingVariable) {
    java.util.List<Integer> boxed = new java.util.ArrayList<>(values.length);
    for (int value : values) boxed.add(value);
    return iterationBindAtLine(line, name, boxed, bindingVariable);
  }

  public static Iterable<Integer> iterationBindAtLine(int line, String name, Object parentKey, int[] values, String bindingVariable, String parentKeySource) {
    java.util.List<Integer> boxed = new java.util.ArrayList<>(values.length);
    for (int value : values) boxed.add(value);
    return iterationBindAtLine(line, name, parentKey, boxed, bindingVariable, parentKeySource);
  }

  public static Iterable<Long> iterationBindAtLine(int line, String name, long[] values, String bindingVariable) {
    java.util.List<Long> boxed = new java.util.ArrayList<>(values.length);
    for (long value : values) boxed.add(value);
    return iterationBindAtLine(line, name, boxed, bindingVariable);
  }

  public static Iterable<Double> iterationBindAtLine(int line, String name, double[] values, String bindingVariable) {
    java.util.List<Double> boxed = new java.util.ArrayList<>(values.length);
    for (double value : values) boxed.add(value);
    return iterationBindAtLine(line, name, boxed, bindingVariable);
  }

  public static Iterable<Character> iterationBindAtLine(int line, String name, char[] values, String bindingVariable) {
    java.util.List<Character> boxed = new java.util.ArrayList<>(values.length);
    for (char value : values) boxed.add(value);
    return iterationBindAtLine(line, name, boxed, bindingVariable);
  }

  public static Iterable<Boolean> iterationBindAtLine(int line, String name, boolean[] values, String bindingVariable) {
    java.util.List<Boolean> boxed = new java.util.ArrayList<>(values.length);
    for (boolean value : values) boxed.add(value);
    return iterationBindAtLine(line, name, boxed, bindingVariable);
  }

  @SuppressWarnings("unchecked")
  private static <T> Iterable<T> iterationBindNestedValuesAtLine(
      int line,
      String name,
      Object parentKey,
      Object values,
      String bindingVariable,
      String parentKeySource) {
    if (values instanceof Iterable<?>) {
      return iterationBindAtLine(line, name, parentKey, (Iterable<T>) values, bindingVariable, parentKeySource);
    }
    if (values instanceof Object[]) {
      return iterationBindAtLine(line, name, parentKey, java.util.Arrays.asList((T[]) values), bindingVariable, parentKeySource);
    }
    if (values instanceof int[]) {
      return (Iterable<T>) iterationBindAtLine(line, name, parentKey, (int[]) values, bindingVariable, parentKeySource);
    }
    if (values instanceof long[]) {
      java.util.List<Long> boxed = new java.util.ArrayList<>(((long[]) values).length);
      for (long value : (long[]) values) boxed.add(value);
      return (Iterable<T>) iterationBindAtLine(line, name, parentKey, boxed, bindingVariable, parentKeySource);
    }
    if (values instanceof double[]) {
      java.util.List<Double> boxed = new java.util.ArrayList<>(((double[]) values).length);
      for (double value : (double[]) values) boxed.add(value);
      return (Iterable<T>) iterationBindAtLine(line, name, parentKey, boxed, bindingVariable, parentKeySource);
    }
    if (values instanceof float[]) {
      java.util.List<Float> boxed = new java.util.ArrayList<>(((float[]) values).length);
      for (float value : (float[]) values) boxed.add(value);
      return (Iterable<T>) iterationBindAtLine(line, name, parentKey, boxed, bindingVariable, parentKeySource);
    }
    if (values instanceof char[]) {
      java.util.List<Character> boxed = new java.util.ArrayList<>(((char[]) values).length);
      for (char value : (char[]) values) boxed.add(value);
      return (Iterable<T>) iterationBindAtLine(line, name, parentKey, boxed, bindingVariable, parentKeySource);
    }
    if (values instanceof boolean[]) {
      java.util.List<Boolean> boxed = new java.util.ArrayList<>(((boolean[]) values).length);
      for (boolean value : (boolean[]) values) boxed.add(value);
      return (Iterable<T>) iterationBindAtLine(line, name, parentKey, boxed, bindingVariable, parentKeySource);
    }
    if (values instanceof byte[]) {
      java.util.List<Byte> boxed = new java.util.ArrayList<>(((byte[]) values).length);
      for (byte value : (byte[]) values) boxed.add(value);
      return (Iterable<T>) iterationBindAtLine(line, name, parentKey, boxed, bindingVariable, parentKeySource);
    }
    if (values instanceof short[]) {
      java.util.List<Short> boxed = new java.util.ArrayList<>(((short[]) values).length);
      for (short value : (short[]) values) boxed.add(value);
      return (Iterable<T>) iterationBindAtLine(line, name, parentKey, boxed, bindingVariable, parentKeySource);
    }
    throw new IllegalArgumentException("Enhanced-for trace target is not iterable");
  }

  private static final String ARRAY_LENGTH_PATH = "[\"length\"]";

  public static int readArrayLengthAtLine(int line, String name, Object value) {
    profileLengthCalls += 1;
    int length = value == null ? 0 : java.lang.reflect.Array.getLength(value);
    if (traceLimitExceeded) return length;
    emitTraceRead(line, name, ARRAY_LENGTH_PATH, length);
    emitRuntimeSnapshotAtLine(line, name, value);
    return length;
  }

  public static int readArrayLengthAtLine(int line, String name, Object value, int index, String indexSource) {
    int length = value == null ? 0 : java.lang.reflect.Array.getLength(value);
    emitTraceRead(
      line,
      name,
      "[" + serializeResult(index) + "," + jsonString("length") + "]",
      length,
      indexSourcesJson(indexSource, null)
    );
    return length;
  }

  public static int readIndexedStringLengthAtLine(int line, String name, CharSequence[] values, int index, String indexSource) {
    int length = values[index] == null ? 0 : values[index].length();
    emitTraceRead(
      line,
      name,
      "[" + serializeResult(index) + "," + jsonString("length") + "]",
      length,
      indexSourcesJson(indexSource, null)
    );
    return length;
  }

  public static <V> V readMapAtLine(int line, String name, java.util.Map<?, V> values, Object key) {
    V value = values.get(key);
    emitTraceRead(line, name, "[" + serializeResult(key) + "]", value);
    return value;
  }

  public static <V> V readMapAtLine(int line, String name, java.util.Map<?, V> values, Object key, String keySource) {
    V value = values.get(key);
    emitTraceRead(line, name, "[" + serializeResult(key) + "]", value, indexSourcesJson(keySource));
    return value;
  }

  public static <V> V readFieldMapAtLine(int line, String ownerName, String field, java.util.Map<?, V> values, Object key) {
    V value = values.get(key);
    emitTraceRead(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", value);
    return value;
  }

  public static <V> V readFieldMapAtLine(int line, String ownerName, String field, java.util.Map<?, V> values, Object key, String keySource) {
    V value = values.get(key);
    emitTraceRead(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", value, indexSourcesJson(null, keySource));
    return value;
  }

  public static <V> V readMapOrDefaultAtLine(int line, String name, java.util.Map<?, V> values, Object key, V defaultValue) {
    V value = values.getOrDefault(key, defaultValue);
    emitTraceRead(line, name, "[" + serializeResult(key) + "]", value);
    return value;
  }

  public static <V> V readMapOrDefaultAtLine(int line, String name, java.util.Map<?, V> values, Object key, V defaultValue, String keySource) {
    V value = values.getOrDefault(key, defaultValue);
    emitTraceRead(line, name, "[" + serializeResult(key) + "]", value, indexSourcesJson(keySource));
    return value;
  }

  public static <V> V readFieldMapOrDefaultAtLine(int line, String ownerName, String field, java.util.Map<?, V> values, Object key, V defaultValue) {
    V value = values.getOrDefault(key, defaultValue);
    emitTraceRead(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", value);
    return value;
  }

  public static <V> V readFieldMapOrDefaultAtLine(int line, String ownerName, String field, java.util.Map<?, V> values, Object key, V defaultValue, String keySource) {
    V value = values.getOrDefault(key, defaultValue);
    emitTraceRead(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", value, indexSourcesJson(null, keySource));
    return value;
  }

  public static boolean containsMapKeyAtLine(int line, String name, java.util.Map<?, ?> values, Object key) {
    boolean value = values.containsKey(key);
    emitTraceRead(line, name, "[" + serializeResult(key) + "]", value);
    return value;
  }

  public static boolean containsMapKeyAtLine(int line, String name, java.util.Map<?, ?> values, Object key, String keySource) {
    boolean value = values.containsKey(key);
    emitTraceRead(line, name, "[" + serializeResult(key) + "]", value, indexSourcesJson(keySource));
    return value;
  }

  public static boolean containsFieldMapKeyAtLine(int line, String ownerName, String field, java.util.Map<?, ?> values, Object key) {
    boolean value = values.containsKey(key);
    emitTraceRead(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", value);
    return value;
  }

  public static boolean containsFieldMapKeyAtLine(int line, String ownerName, String field, java.util.Map<?, ?> values, Object key, String keySource) {
    boolean value = values.containsKey(key);
    emitTraceRead(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", value, indexSourcesJson(null, keySource));
    return value;
  }

  public static boolean readSetAtLine(int line, String name, java.util.Set<?> values, Object key) {
    boolean value = values.contains(key);
    emitTraceRead(line, name, "[" + serializeResult(key) + "]", value);
    return value;
  }

  public static boolean readSetAtLine(int line, String name, java.util.Set<?> values, Object key, String keySource) {
    boolean value = values.contains(key);
    emitTraceRead(line, name, "[" + serializeResult(key) + "]", value, indexSourcesJson(keySource));
    return value;
  }

  public static <K, V> V putMapAtLine(int line, String name, java.util.Map<K, V> values, K key, V value) {
    V previous = values.put(key, value);
    emitTraceWrite(line, name, "[" + serializeResult(key) + "]", values.get(key));
    emitTraceMutate(line, name, "[" + serializeResult(key) + "]", "put", null, "[" + serializeResult(key) + "," + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
    return previous;
  }

  public static <K, V> V putMapAtLine(int line, String name, java.util.Map<K, V> values, K key, V value, String keySource) {
    V previous = values.put(key, value);
    if (keySource == null) keySource = consumeLastIndexSource();
    String indexSources = indexSourcesJson(keySource);
    emitTraceWrite(line, name, "[" + serializeResult(key) + "]", values.get(key), indexSources);
    emitTraceMutate(line, name, "[" + serializeResult(key) + "]", "put", indexSources, "[" + serializeResult(key) + "," + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
    return previous;
  }

  public static <K, V> V writeMapAtLine(int line, String name, java.util.Map<K, V> values, K key, V value) {
    return putMapAtLine(line, name, values, key, value);
  }

  public static <K, V> V writeMapAtLine(int line, String name, java.util.Map<K, V> values, K key, V value, String keySource) {
    return putMapAtLine(line, name, values, key, value, keySource);
  }

  public static <K, V> V putMapIfAbsentAtLine(int line, String name, java.util.Map<K, V> values, K key, V value) {
    V previous = values.putIfAbsent(key, value);
    if (previous == null) {
      emitTraceWrite(line, name, "[" + serializeResult(key) + "]", values.get(key));
    } else {
      emitTraceRead(line, name, "[" + serializeResult(key) + "]", previous);
    }
    emitTraceMutate(line, name, "[" + serializeResult(key) + "]", "putIfAbsent", null, "[" + serializeResult(key) + "," + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
    return previous;
  }

  public static <K, V> V putMapIfAbsentAtLine(int line, String name, java.util.Map<K, V> values, K key, V value, String keySource) {
    V previous = values.putIfAbsent(key, value);
    if (keySource == null) keySource = consumeLastIndexSource();
    String indexSources = indexSourcesJson(keySource);
    if (previous == null) {
      emitTraceWrite(line, name, "[" + serializeResult(key) + "]", values.get(key), indexSources);
    } else {
      emitTraceRead(line, name, "[" + serializeResult(key) + "]", previous, indexSources);
    }
    emitTraceMutate(line, name, "[" + serializeResult(key) + "]", "putIfAbsent", indexSources, "[" + serializeResult(key) + "," + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
    return previous;
  }

  public static <K, V> V putFieldMapAtLine(int line, String ownerName, String field, java.util.Map<K, V> values, K key, V value) {
    V previous = values.put(key, value);
    emitTraceWrite(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", values.get(key));
    return previous;
  }

  public static <K, V> V putFieldMapAtLine(int line, String ownerName, String field, java.util.Map<K, V> values, K key, V value, String keySource) {
    V previous = values.put(key, value);
    emitTraceWrite(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", values.get(key), indexSourcesJson(null, keySource));
    return previous;
  }

  public static <K, V> V putFieldMapIfAbsentAtLine(int line, String ownerName, String field, java.util.Map<K, V> values, K key, V value) {
    V previous = values.putIfAbsent(key, value);
    if (previous == null) {
      emitTraceWrite(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", values.get(key));
    } else {
      emitTraceRead(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", previous);
    }
    emitTraceMutate(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", "putIfAbsent", null, "[" + serializeResult(key) + "," + serializeResult(value) + "]");
    return previous;
  }

  public static <K, V> V putFieldMapIfAbsentAtLine(int line, String ownerName, String field, java.util.Map<K, V> values, K key, V value, String keySource) {
    V previous = values.putIfAbsent(key, value);
    String indexSources = indexSourcesJson(null, keySource);
    if (previous == null) {
      emitTraceWrite(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", values.get(key), indexSources);
    } else {
      emitTraceRead(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", previous, indexSources);
    }
    emitTraceMutate(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", "putIfAbsent", indexSources, "[" + serializeResult(key) + "," + serializeResult(value) + "]");
    return previous;
  }

  public static <T> boolean addSetAtLine(int line, String name, java.util.Set<T> values, T key) {
    boolean changed = values.add(key);
    emitTraceMutate(line, name, null, "add", null, "[" + serializeResult(key) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
    return changed;
  }

  public static <T> boolean addCollectionAtLine(int line, String name, java.util.Collection<T> values, T value) {
    boolean changed = values.add(value);
    emitTraceMutate(line, name, null, "add", null, "[" + serializeResult(value) + "]");
    if (changed && values instanceof java.util.PriorityQueue<?>) {
      emitCollectionIndexedWritesAtLine(line, name, values);
    }
    emitRuntimeSnapshotAtLine(line, name, values);
    return changed;
  }

  public static <T> boolean offerQueueAtLine(int line, String name, java.util.Queue<T> values, T value) {
    boolean changed = values.offer(value);
    emitTraceMutate(line, name, null, "offer", null, "[" + serializeResult(value) + "]");
    if (changed && values instanceof java.util.PriorityQueue<?>) {
      emitCollectionIndexedWritesAtLine(line, name, values);
    } else if (changed) {
      emitTraceWrite(line, name, "[" + serializeResult(values.size() - 1) + "]", value);
    }
    emitRuntimeSnapshotAtLine(line, name, values);
    return changed;
  }

  public static <T> void addDequeLastAtLine(int line, String name, java.util.Deque<T> values, T value) {
    values.addLast(value);
    emitTraceMutate(line, name, null, "addLast", null, "[" + serializeResult(value) + "]");
    emitTraceWrite(line, name, "[" + serializeResult(values.size() - 1) + "]", value);
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static <T> boolean offerDequeLastAtLine(int line, String name, java.util.Deque<T> values, T value) {
    boolean changed = values.offerLast(value);
    emitTraceMutate(line, name, null, "offerLast", null, "[" + serializeResult(value) + "]");
    if (changed) {
      emitTraceWrite(line, name, "[" + serializeResult(values.size() - 1) + "]", value);
    }
    emitRuntimeSnapshotAtLine(line, name, values);
    return changed;
  }

  public static <T> void addDequeFirstAtLine(int line, String name, java.util.Deque<T> values, T value) {
    values.addFirst(value);
    emitTraceMutate(line, name, null, "addFirst", null, "[" + serializeResult(value) + "]");
    emitTraceWrite(line, name, "[0]", value);
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static <T> boolean offerDequeFirstAtLine(int line, String name, java.util.Deque<T> values, T value) {
    boolean changed = values.offerFirst(value);
    emitTraceMutate(line, name, null, "offerFirst", null, "[" + serializeResult(value) + "]");
    if (changed) {
      emitTraceWrite(line, name, "[0]", value);
    }
    emitRuntimeSnapshotAtLine(line, name, values);
    return changed;
  }

  public static <T> T pollQueueAtLine(int line, String name, java.util.Queue<T> values) {
    T value = values.peek();
    emitTraceRead(line, name, "[0]", value);
    value = values.poll();
    emitTraceMutate(line, name, null, "poll", null, "[]");
    if (values instanceof java.util.PriorityQueue<?>) {
      emitCollectionIndexedWritesAtLine(line, name, values);
    }
    emitRuntimeSnapshotAtLine(line, name, values);
    return value;
  }

  public static boolean removeSetAtLine(int line, String name, java.util.Set<?> values, Object key) {
    boolean changed = values.remove(key);
    emitTraceMutate(line, name, "[" + serializeResult(key) + "]", "remove", null, "[" + serializeResult(key) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
    return changed;
  }

  public static boolean removeSetAtLine(int line, String name, java.util.Set<?> values, Object key, String keySource) {
    boolean changed = values.remove(key);
    emitTraceMutate(line, name, "[" + serializeResult(key) + "]", "remove", indexSourcesJson(keySource), "[" + serializeResult(key) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
    return changed;
  }

  public static <V> V removeMapAtLine(int line, String name, java.util.Map<?, V> values, Object key) {
    V removed = values.remove(key);
    emitTraceMutate(line, name, "[" + serializeResult(key) + "]", "remove", null, "[" + serializeResult(key) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
    return removed;
  }

  public static <V> V removeMapAtLine(int line, String name, java.util.Map<?, V> values, Object key, String keySource) {
    V removed = values.remove(key);
    emitTraceMutate(line, name, "[" + serializeResult(key) + "]", "remove", indexSourcesJson(keySource), "[" + serializeResult(key) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
    return removed;
  }

  public static <T> T popListAtLine(int line, String name, java.util.List<T> values, int index) {
    T value = values.remove(index);
    emitTraceMutate(line, name, null, "remove", null, "[" + serializeResult(index) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
    return value;
  }

  public static <T> T popListAtLine(int line, String name, java.util.List<T> values) {
    return popListAtLine(line, name, values, values.size() - 1);
  }

  public static <T> T popStackAtLine(int line, String name, java.util.Stack<T> values) {
    int index = values.size() - 1;
    T value = values.peek();
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", value);
    value = values.pop();
    emitTraceMutate(line, name, null, "pop", null, "[]");
    emitRuntimeSnapshotAtLine(line, name, values);
    return value;
  }

  public static <T> T popDequeAtLine(int line, String name, java.util.Deque<T> values) {
    T value = values.peek();
    emitTraceRead(line, name, "[0]", value);
    value = values.pop();
    emitTraceMutate(line, name, null, "pop", null, "[]");
    emitRuntimeSnapshotAtLine(line, name, values);
    return value;
  }

  public static <T> T readListAtLine(int line, String name, java.util.List<T> values, int index) {
    T value = values.get(index);
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", value);
    return value;
  }

  public static <T> T readListAtLine(int line, String name, java.util.List<T> values, int index, String indexSource) {
    T value = values.get(index);
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", value, indexSourcesJson(indexSource));
    return value;
  }

  public static <T> T readObjectListAtLine(int line, String name, java.util.List<T> values, int index, String indexSource) {
    return readListAtLine(line, name, values, index, indexSource);
  }

  public static <T> T writeListAtLine(int line, String name, java.util.List<T> values, int index, T value) {
    T previous = values.set(index, value);
    emitTraceWrite(line, name, "[" + serializeResult(index) + "]", values.get(index));
    emitTraceMutate(line, name, null, "set", null, "[" + serializeResult(index) + "," + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
    return previous;
  }

  public static <T> T writeListAtLine(int line, String name, java.util.List<T> values, int index, T value, String indexSource) {
    T previous = values.set(index, value);
    emitTraceWrite(line, name, "[" + serializeResult(index) + "]", values.get(index), indexSourcesJson(indexSource));
    emitTraceMutate(line, name, null, "set", null, "[" + serializeResult(index) + "," + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
    return previous;
  }

  public static int readIntArrayAtLine(int line, String name, int[] values, int index, String indexSource) {
    profileReadArrayCalls += 1;
    if (traceLimitExceeded) {
      profileReadArrayEarlyExits += 1;
      return values[index];
    }
    int value = values[index];
    emitTraceRead(line, name, "[" + index + "]", value, indexSourcesJson(indexSource));
    return value;
  }

  public static long readLongArrayAtLine(int line, String name, long[] values, int index, String indexSource) {
    if (traceLimitExceeded) return values[index];
    long value = values[index];
    emitTraceRead(line, name, "[" + index + "]", value, indexSourcesJson(indexSource));
    return value;
  }

  public static boolean readBooleanArrayAtLine(int line, String name, boolean[] values, int index, String indexSource) {
    if (traceLimitExceeded) return values[index];
    boolean value = values[index];
    emitTraceRead(line, name, "[" + index + "]", value, indexSourcesJson(indexSource));
    return value;
  }

  public static double readDoubleArrayAtLine(int line, String name, double[] values, int index, String indexSource) {
    if (traceLimitExceeded) return values[index];
    double value = values[index];
    emitTraceRead(line, name, "[" + index + "]", value, indexSourcesJson(indexSource));
    return value;
  }

  public static float readFloatArrayAtLine(int line, String name, float[] values, int index, String indexSource) {
    if (traceLimitExceeded) return values[index];
    float value = values[index];
    emitTraceRead(line, name, "[" + index + "]", value, indexSourcesJson(indexSource));
    return value;
  }

  public static char readCharArrayAtLine(int line, String name, char[] values, int index, String indexSource) {
    if (traceLimitExceeded) return values[index];
    char value = values[index];
    emitTraceRead(line, name, "[" + index + "]", String.valueOf(value), indexSourcesJson(indexSource));
    return value;
  }

  public static byte readByteArrayAtLine(int line, String name, byte[] values, int index, String indexSource) {
    if (traceLimitExceeded) return values[index];
    byte value = values[index];
    emitTraceRead(line, name, "[" + index + "]", value, indexSourcesJson(indexSource));
    return value;
  }

  public static short readShortArrayAtLine(int line, String name, short[] values, int index, String indexSource) {
    if (traceLimitExceeded) return values[index];
    short value = values[index];
    emitTraceRead(line, name, "[" + index + "]", value, indexSourcesJson(indexSource));
    return value;
  }

  public static <T> T readObjectArrayAtLine(int line, String name, T[] values, int index, String indexSource) {
    if (traceLimitExceeded) return values[index];
    T value = values[index];
    emitTraceRead(line, name, "[" + index + "]", value, indexSourcesJson(indexSource));
    return value;
  }

  public static int readIntArrayListAtLine(int line, String name, java.util.List<int[]> values, int index, int elementIndex) {
    int value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static int readIntArrayListAtLine(int line, String name, java.util.List<int[]> values, int index, int elementIndex, String indexSource, String elementIndexSource) {
    int value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value, indexSourcesJson(indexSource, elementIndexSource));
    return value;
  }

  public static long readLongArrayListAtLine(int line, String name, java.util.List<long[]> values, int index, int elementIndex) {
    long value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static long readLongArrayListAtLine(int line, String name, java.util.List<long[]> values, int index, int elementIndex, String indexSource, String elementIndexSource) {
    long value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value, indexSourcesJson(indexSource, elementIndexSource));
    return value;
  }

  public static char readCharArrayListAtLine(int line, String name, java.util.List<char[]> values, int index, int elementIndex) {
    char value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static char readCharArrayListAtLine(int line, String name, java.util.List<char[]> values, int index, int elementIndex, String indexSource, String elementIndexSource) {
    char value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, String.valueOf(value), indexSourcesJson(indexSource, elementIndexSource));
    return value;
  }

  public static boolean readBooleanArrayListAtLine(int line, String name, java.util.List<boolean[]> values, int index, int elementIndex) {
    boolean value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static boolean readBooleanArrayListAtLine(int line, String name, java.util.List<boolean[]> values, int index, int elementIndex, String indexSource, String elementIndexSource) {
    boolean value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value, indexSourcesJson(indexSource, elementIndexSource));
    return value;
  }

  public static double readDoubleArrayListAtLine(int line, String name, java.util.List<double[]> values, int index, int elementIndex) {
    double value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static double readDoubleArrayListAtLine(int line, String name, java.util.List<double[]> values, int index, int elementIndex, String indexSource, String elementIndexSource) {
    double value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value, indexSourcesJson(indexSource, elementIndexSource));
    return value;
  }

  public static float readFloatArrayListAtLine(int line, String name, java.util.List<float[]> values, int index, int elementIndex) {
    float value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static float readFloatArrayListAtLine(int line, String name, java.util.List<float[]> values, int index, int elementIndex, String indexSource, String elementIndexSource) {
    float value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value, indexSourcesJson(indexSource, elementIndexSource));
    return value;
  }

  public static byte readByteArrayListAtLine(int line, String name, java.util.List<byte[]> values, int index, int elementIndex) {
    byte value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static byte readByteArrayListAtLine(int line, String name, java.util.List<byte[]> values, int index, int elementIndex, String indexSource, String elementIndexSource) {
    byte value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value, indexSourcesJson(indexSource, elementIndexSource));
    return value;
  }

  public static short readShortArrayListAtLine(int line, String name, java.util.List<short[]> values, int index, int elementIndex) {
    short value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static short readShortArrayListAtLine(int line, String name, java.util.List<short[]> values, int index, int elementIndex, String indexSource, String elementIndexSource) {
    short value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value, indexSourcesJson(indexSource, elementIndexSource));
    return value;
  }

  public static <T> T readObjectArrayListAtLine(int line, String name, java.util.List<T[]> values, int index, int elementIndex) {
    T value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static <T> T readObjectArrayListAtLine(int line, String name, java.util.List<T[]> values, int index, int elementIndex, String indexSource, String elementIndexSource) {
    T value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value, indexSourcesJson(indexSource, elementIndexSource));
    return value;
  }

  public static char readStringCharAtLine(int line, String name, CharSequence value, int index) {
    char result = value.charAt(index);
    emit("trace:{\"kind\":\"read\",\"line\":" + line + ",\"target\":{\"variable\":\"" + name + "\",\"path\":[" + serializeResult(index) + "]},\"value\":" + serializeResult(String.valueOf(result)) + "}");
    return result;
  }

  public static char readStringCharAtLine(int line, String name, CharSequence value, int index, String indexSource) {
    char result = value.charAt(index);
    if (indexSource != null) state().lastIndexSource = indexSource;
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", String.valueOf(result), indexSourcesJson(indexSource));
    return result;
  }

  public static char readStringMatrixCharAtLine(int line, String name, CharSequence[] values, int row, int col) {
    char result = values[row].charAt(col);
    emitTraceRead(line, name, "[" + serializeResult(row) + "," + serializeResult(col) + "]", String.valueOf(result));
    return result;
  }

  public static char readStringMatrixCharAtLine(int line, String name, CharSequence[] values, int row, int col, String rowSource, String colSource) {
    char result = values[row].charAt(col);
    emitTraceRead(line, name, "[" + serializeResult(row) + "," + serializeResult(col) + "]", String.valueOf(result), indexSourcesJson(rowSource, colSource));
    return result;
  }

  private static String consumeLastIndexSource() {
    ThreadState state = state();
    String source = state.lastIndexSource;
    state.lastIndexSource = null;
    return source;
  }

  public static String jsonString(String value) {
    if (value == null) return "null";
    if (NATIVE_JSON_AVAILABLE) {
      String fast = jsonEscape0(value);
      if (fast != null) return fast;
    }
    // Hot path: variable names and simple index sources never need escaping.
    boolean simple = true;
    for (int index = 0; index < value.length(); index++) {
      char ch = value.charAt(index);
      if (ch < 0x20 || ch == '"' || ch == '\\') {
        simple = false;
        break;
      }
    }
    if (simple) {
      return "\"" + value + "\"";
    }
    StringBuilder builder = new StringBuilder(value.length() + 8);
    builder.append('"');
    for (int index = 0; index < value.length(); index++) {
      char ch = value.charAt(index);
      switch (ch) {
        case '"':
          builder.append("\\\"");
          break;
        case '\\':
          builder.append("\\\\");
          break;
        case '\n':
          builder.append("\\n");
          break;
        case '\r':
          builder.append("\\r");
          break;
        case '\t':
          builder.append("\\t");
          break;
        default:
          if (ch < 0x20) {
            builder.append(String.format("\\u%04x", (int) ch));
          } else {
            builder.append(ch);
          }
      }
    }
    builder.append('"');
    return builder.toString();
  }

  public static int readIntMatrixAtLine(int line, String name, int[][] values, int row, int col, String rowSource, String colSource) {
    int value = values[row][col];
    emitMatrixRead(line, name, row, col, value, indexSourcesJson(rowSource, colSource));
    return value;
  }

  public static boolean readBooleanMatrixAtLine(int line, String name, boolean[][] values, int row, int col, String rowSource, String colSource) {
    boolean value = values[row][col];
    emitMatrixRead(line, name, row, col, value, indexSourcesJson(rowSource, colSource));
    return value;
  }

  public static char readCharMatrixAtLine(int line, String name, char[][] values, int row, int col, String rowSource, String colSource) {
    char value = values[row][col];
    emitMatrixRead(line, name, row, col, String.valueOf(value), indexSourcesJson(rowSource, colSource));
    return value;
  }

  public static long readLongMatrixAtLine(int line, String name, long[][] values, int row, int col) {
    long value = values[row][col];
    emitMatrixRead(line, name, row, col, value);
    return value;
  }

  public static long readLongMatrixAtLine(int line, String name, long[][] values, int row, int col, String rowSource, String colSource) {
    long value = values[row][col];
    emitMatrixRead(line, name, row, col, value, indexSourcesJson(rowSource, colSource));
    return value;
  }

  public static double readDoubleMatrixAtLine(int line, String name, double[][] values, int row, int col) {
    double value = values[row][col];
    emitMatrixRead(line, name, row, col, value);
    return value;
  }

  public static double readDoubleMatrixAtLine(int line, String name, double[][] values, int row, int col, String rowSource, String colSource) {
    double value = values[row][col];
    emitMatrixRead(line, name, row, col, value, indexSourcesJson(rowSource, colSource));
    return value;
  }

  public static float readFloatMatrixAtLine(int line, String name, float[][] values, int row, int col) {
    float value = values[row][col];
    emitMatrixRead(line, name, row, col, value);
    return value;
  }

  public static float readFloatMatrixAtLine(int line, String name, float[][] values, int row, int col, String rowSource, String colSource) {
    float value = values[row][col];
    emitMatrixRead(line, name, row, col, value, indexSourcesJson(rowSource, colSource));
    return value;
  }

  public static byte readByteMatrixAtLine(int line, String name, byte[][] values, int row, int col) {
    byte value = values[row][col];
    emitMatrixRead(line, name, row, col, value);
    return value;
  }

  public static byte readByteMatrixAtLine(int line, String name, byte[][] values, int row, int col, String rowSource, String colSource) {
    byte value = values[row][col];
    emitMatrixRead(line, name, row, col, value, indexSourcesJson(rowSource, colSource));
    return value;
  }

  public static short readShortMatrixAtLine(int line, String name, short[][] values, int row, int col) {
    short value = values[row][col];
    emitMatrixRead(line, name, row, col, value);
    return value;
  }

  public static short readShortMatrixAtLine(int line, String name, short[][] values, int row, int col, String rowSource, String colSource) {
    short value = values[row][col];
    emitMatrixRead(line, name, row, col, value, indexSourcesJson(rowSource, colSource));
    return value;
  }

  public static <T> T readObjectMatrixAtLine(int line, String name, T[][] values, int row, int col, String rowSource, String colSource) {
    T value = values[row][col];
    emitMatrixRead(line, name, row, col, value, indexSourcesJson(rowSource, colSource));
    return value;
  }

  private static void emitMatrixRead(int line, String name, int row, int col, Object value) {
    if (dropIfStorageExhausted()) return;
    emit("trace:{\"kind\":\"read\",\"line\":" + line + ",\"target\":{\"variable\":\"" + name + "\",\"path\":[" + serializeResult(row) + "," + serializeResult(col) + "]},\"value\":" + serializeResult(value) + "}");
  }

  private static void emitMatrixRead(int line, String name, int row, int col, Object value, String indexSourcesJson) {
    emitTraceRead(line, name, "[" + serializeResult(row) + "," + serializeResult(col) + "]", value, indexSourcesJson);
  }

  private static void emitNestedListArrayRead(int line, String name, int index, int elementIndex, Object value) {
    if (dropIfStorageExhausted()) return;
    emit("trace:{\"kind\":\"read\",\"line\":" + line + ",\"target\":{\"variable\":\"" + name + "\",\"path\":[" + serializeResult(index) + "," + serializeResult(elementIndex) + "]},\"value\":" + serializeResult(value) + "}");
  }

  private static void emitNestedListArrayRead(int line, String name, int index, int elementIndex, Object value, String indexSourcesJson) {
    emitTraceRead(line, name, "[" + serializeResult(index) + "," + serializeResult(elementIndex) + "]", value, indexSourcesJson);
  }

  private static void emitTraceRead(int line, String name, String pathJson, Object value) {
    emitTraceRead(line, name, pathJson, value, null);
  }

  private static void emitTraceRead(int line, String name, String pathJson, Object value, String indexSourcesJson) {
    if (dropIfStorageExhausted()) return;
    String valueJson = serializeResult(value);
    if (emitFast("read", line, name, pathJson, indexSourcesJson, valueJson, null)) return;
    StringBuilder out = acquireEventBuilder();
    out.append("trace:{\"kind\":\"read\",\"line\":").append(line);
    out.append(",\"target\":{\"variable\":").append(jsonString(name)).append(",\"path\":").append(pathJson);
    if (indexSourcesJson != null) out.append(",\"indexSources\":").append(indexSourcesJson);
    out.append("},\"value\":").append(valueJson);
    emitEventBody(out);
  }

  private static void emitArrayRowReadAtLine(int line, String name, int index, String indexSource, Object row) {
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", row, indexSourcesJson(indexSource));
  }

  private static void emitTraceReadWithIterationBinding(int line, String name, String pathJson, Object value, String bindingVariable) {
    emitTraceReadWithIterationBinding(line, name, pathJson, value, bindingVariable, null);
  }

  private static void emitTraceReadWithIterationBinding(int line, String name, String pathJson, Object value, String bindingVariable, String indexSourcesJson) {
    if (dropIfStorageExhausted()) return;
    StringBuilder out = new StringBuilder("trace:{\"kind\":\"read\",\"line\":");
    out.append(line).append(",\"target\":{\"variable\":").append(jsonString(name)).append(",\"path\":").append(pathJson);
    if (indexSourcesJson != null) out.append(",\"indexSources\":").append(indexSourcesJson);
    out.append("}");
    out.append(",\"value\":").append(serializeResult(value));
    out.append(",\"binding\":{\"kind\":\"iteration\",\"variable\":").append(jsonString(bindingVariable)).append("}}");
    emit(out.toString());
  }

  private static void emitTraceWrite(int line, String name, String pathJson, Object value) {
    emitTraceWrite(line, name, pathJson, value, null);
  }

  public static void emitScalarWriteAtLine(int line, String name, Object value) {
    profileScalarWriteCalls += 1;
    if (dropIfStorageExhausted()) return;
    String valueJson = serializeResult(value);
    if (emitFast("write", line, name, null, null, valueJson, null)) return;
    StringBuilder out = acquireEventBuilder();
    out.append("trace:{\"kind\":\"write\",\"line\":").append(line);
    out.append(",\"target\":{\"variable\":").append(jsonString(name)).append("},\"value\":");
    out.append(valueJson);
    emitEventBody(out);
  }

  private static void emitTraceWrite(int line, String name, String pathJson, Object value, String indexSourcesJson) {
    if (dropIfStorageExhausted()) return;
    emitTraceWriteSerialized(line, name, pathJson, serializeResult(value), indexSourcesJson);
  }

  private static void emitTraceWriteSerialized(int line, String name, String pathJson, String valueJson, String indexSourcesJson) {
    if (emitFast("write", line, name, pathJson, indexSourcesJson, valueJson, null)) return;
    StringBuilder out = acquireEventBuilder();
    out.append("trace:{\"kind\":\"write\",\"line\":").append(line);
    out.append(",\"target\":{\"variable\":").append(jsonString(name)).append(",\"path\":").append(pathJson);
    if (indexSourcesJson != null) out.append(",\"indexSources\":").append(indexSourcesJson);
    out.append("},\"value\":").append(valueJson);
    emitEventBody(out);
  }

  private static void emitArrayIndexedWritesAtLine(int line, String name, Object values) {
    int length = java.lang.reflect.Array.getLength(values);
    int limit = bulkIndexedWriteLimit(length);
    for (int index = 0; index < limit; index++) {
      emitTraceWrite(line, name, "[" + serializeResult(index) + "]", java.lang.reflect.Array.get(values, index), null);
    }
  }

  public static void emitCollectionIndexedWritesAtLine(int line, String name, java.util.Collection<?> values) {
    int index = 0;
    int limit = bulkIndexedWriteLimit(Math.min(values.size(), MAX_SERIALIZED_ITEMS));
    for (Object value : values) {
      if (index >= limit) {
        break;
      }
      emitTraceWrite(line, name, "[" + serializeResult(index) + "]", value, null);
      index++;
    }
  }

  public static void emitCollectionIndexedWritesAtLine(int line, String name, Object[] prefixPath, java.util.Collection<?> values) {
    int index = 0;
    int limit = bulkIndexedWriteLimit(Math.min(values.size(), MAX_SERIALIZED_ITEMS));
    for (Object value : values) {
      if (index >= limit) {
        break;
      }
      Object[] path = java.util.Arrays.copyOf(prefixPath, prefixPath.length + 1);
      path[prefixPath.length] = index;
      emitIndexedWriteAtLine(line, name, path, value);
      index++;
    }
  }

  private static int bulkIndexedWriteLimit(int requested) {
    if (requested <= 0 || !runActiveForCurrentThread()) return 0;
    synchronized (STATE_LOCK) {
      if (!runActiveForCurrentThread() || traceLimitExceeded) return 0;
      int remainingEvents = Math.max(0, maxEvents - EVENTS.size());
      return Math.min(Math.min(requested, MAX_BULK_INDEXED_WRITES), remainingEvents);
    }
  }

  private static void emitArrayRowFillAtLine(
      int line,
      String name,
      Object parent,
      int index,
      String indexSource,
      Object row,
      Object value) {
    String pathJson = "[" + serializeResult(index) + "]";
    String indexSourcesJson = indexSourcesJson(indexSource);
    emitTraceWrite(line, name, pathJson, row, indexSourcesJson);
    emitTraceMutate(line, name, pathJson, "fill", indexSourcesJson, "[" + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, parent);
  }

  private static void emitTraceMutate(int line, String name, String pathJson, String method) {
    emitTraceMutate(line, name, pathJson, method, null);
  }

  private static void emitTraceMutate(int line, String name, String pathJson, String method, String indexSourcesJson) {
    emitTraceMutate(line, name, pathJson, method, indexSourcesJson, null);
  }

  private static void emitTraceMutate(int line, String name, String pathJson, String method, String indexSourcesJson, String argsJson) {
    if (dropIfStorageExhausted()) return;
    StringBuilder out = acquireEventBuilder();
    out.append("trace:{\"kind\":\"mutate\",\"line\":").append(line);
    out.append(",\"target\":{\"variable\":").append(jsonString(name));
    if (pathJson != null) out.append(",\"path\":").append(pathJson);
    if (indexSourcesJson != null) out.append(",\"indexSources\":").append(indexSourcesJson);
    out.append("}");
    if (method != null && !method.isEmpty()) out.append(",\"method\":").append(jsonString(method));
    if (argsJson != null) out.append(",\"args\":").append(argsJson);
    emitEventBody(out);
  }

  private static String serializeArgs(Object... args) {
    StringBuilder out = new StringBuilder("[");
    if (args != null) {
      for (int index = 0; index < args.length; index++) {
        if (index > 0) out.append(",");
        out.append(serializeResult(args[index]));
      }
    }
    out.append("]");
    return out.toString();
  }

  private static final String INDEX_SOURCES_SINGLE_NULL = "[null]";

  private static String indexSourcesJson(String... sources) {
    if (sources == null || sources.length == 0) return null;
    if (sources.length == 1 && (sources[0] == null || sources[0].isEmpty())) {
      return INDEX_SOURCES_SINGLE_NULL;
    }
    StringBuilder out = new StringBuilder("[");
    for (int index = 0; index < sources.length; index++) {
      if (index > 0) out.append(",");
      String source = sources[index];
      out.append(source == null || source.isEmpty() ? "null" : jsonString(source));
    }
    out.append("]");
    return out.toString();
  }

  private static final class SnapshotEntry {
    final String name;
    final String value;

    SnapshotEntry(String name, String value) {
      this.name = name;
      this.value = value;
    }
  }

  private static final class TraceFrame {
    final String functionName;
    final int line;
    final String argsJson;

    TraceFrame(String functionName, int line, String argsJson) {
      this.functionName = functionName == null ? "" : functionName;
      this.line = line;
      this.argsJson = argsJson;
    }
  }
}

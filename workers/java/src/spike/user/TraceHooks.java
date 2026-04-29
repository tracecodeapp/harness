package spike.user;

import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Collection;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class TraceHooks {
  private static final int DEFAULT_MAX_EVENTS = 50000;
  private static final List<String> EVENTS = new ArrayList<>();
  private static final IdentityHashMap<Object, String> IDENTITIES = new IdentityHashMap<>();
  private static int nextListIdentityIndex = 0;
  private static int maxEvents = DEFAULT_MAX_EVENTS;
  private static boolean traceLimitExceeded = false;
  private static int droppedEventCount = 0;
  private static String currentFunction = "<module>";
  private static final List<String> FUNCTION_STACK = new ArrayList<>();
  private static final Map<String, String> CURRENT_SNAPSHOTS = new LinkedHashMap<>();
  private static final Pattern LINE_EVENT_PATTERN = Pattern.compile("^line=(\\d+)(?:\\s+(.*))?$");
  private static final Pattern KEY_VALUE_PATTERN = Pattern.compile("\\b([A-Za-z_][A-Za-z0-9_.]*)=");

  private TraceHooks() {}

  public static void emit(String event) {
    if (event != null && event.startsWith("trace:")) {
      appendEvent(event);
      return;
    }
    emitLegacyTraceEvent(event);
  }

  private static void appendEvent(String event) {
    if (traceLimitExceeded) {
      droppedEventCount += 1;
      return;
    }
    if (EVENTS.size() >= maxEvents) {
      traceLimitExceeded = true;
      droppedEventCount += 1;
      return;
    }
    EVENTS.add(event);
  }

  private static void emitLegacyTraceEvent(String event) {
    if (event == null) return;
    Matcher lineMatch = LINE_EVENT_PATTERN.matcher(event);
    if (!lineMatch.matches()) {
      appendEvent(event);
      return;
    }

    int line = Integer.parseInt(lineMatch.group(1));
    String payload = lineMatch.group(2) == null ? "" : lineMatch.group(2);

    if (payload.startsWith("call ")) {
      String rest = payload.substring("call ".length()).trim();
      int space = rest.indexOf(' ');
      String function = space >= 0 ? rest.substring(0, space) : rest;
      String argsFragment = space >= 0 ? rest.substring(space + 1) : "";
      currentFunction = function.length() > 0 ? function : currentFunction;
      FUNCTION_STACK.add(currentFunction);
      emitTraceCall(line, currentFunction, argsFragment);
      return;
    }

    if (payload.startsWith("return ")) {
      String rest = payload.substring("return ".length()).trim();
      int valueIndex = rest.indexOf(" value=");
      String function = valueIndex >= 0 ? rest.substring(0, valueIndex) : rest;
      String value = valueIndex >= 0 ? rest.substring(valueIndex + " value=".length()) : null;
      emitTraceReturn(line, function.length() > 0 ? function : currentFunction, value);
      if (!FUNCTION_STACK.isEmpty()) {
        FUNCTION_STACK.remove(FUNCTION_STACK.size() - 1);
      }
      currentFunction = FUNCTION_STACK.isEmpty() ? "<module>" : FUNCTION_STACK.get(FUNCTION_STACK.size() - 1);
      return;
    }

    if (payload.startsWith("exception ")) {
      emitTraceException(line, payload.substring("exception ".length()));
      return;
    }

    if (payload.startsWith("stdout ")) {
      emitTraceStdout(line, payload.substring("stdout ".length()));
      return;
    }

    if (payload.startsWith("access ") || payload.startsWith("write ") || payload.startsWith("write-array ")) {
      emitTraceAccessPayload(line, payload);
      return;
    }

    if (payload.startsWith("mutate ") || payload.startsWith("mutate-indexed ") || payload.startsWith("keyed-call ")) {
      emitTraceMutatePayload(line, payload);
      return;
    }


    if (payload.startsWith("map-state ") || payload.startsWith("set-state ")) {
      // Dedicated map/set helpers emit neutral runtime trace snapshots directly.
      return;
    }

    emitTraceLine(line);
    emitTraceSnapshotsFromFragment(line, payload);
  }

  private static String baseEvent(int line, String kind) {
    StringBuilder builder = new StringBuilder();
    builder.append("trace:{\"kind\":").append(jsonString(kind));
    builder.append(",\"line\":").append(line);
    if (currentFunction != null && currentFunction.length() > 0) {
      builder.append(",\"function\":").append(jsonString(currentFunction));
    }
    return builder.toString();
  }

  private static void emitTraceLine(int line) {
    appendEvent(baseEvent(line, "line") + "}");
    for (Map.Entry<String, String> entry : CURRENT_SNAPSHOTS.entrySet()) {
      emitTraceSnapshotEvent(line, entry.getKey(), entry.getValue());
    }
  }

  private static void emitTraceCall(int line, String function, String argsFragment) {
    StringBuilder builder = new StringBuilder();
    builder.append("trace:{\"kind\":\"call\",\"line\":").append(line);
    builder.append(",\"function\":").append(jsonString(function));
    String args = objectFromKeyValueFragment(argsFragment);
    if (args.length() > 2) {
      builder.append(",\"args\":").append(args);
    }
    builder.append("}");
    appendEvent(builder.toString());
    emitTraceSnapshotsFromFragment(line, argsFragment);
  }

  private static void emitTraceReturn(int line, String function, String valueJson) {
    StringBuilder builder = new StringBuilder();
    builder.append("trace:{\"kind\":\"return\",\"line\":").append(line);
    builder.append(",\"function\":").append(jsonString(function));
    if (valueJson != null) {
      builder.append(",\"value\":").append(asJsonValue(valueJson));
    }
    builder.append("}");
    appendEvent(builder.toString());
  }

  private static void emitTraceException(int line, String messageJson) {
    appendEvent(baseEvent(line, "exception") + ",\"message\":" + asJsonValue(messageJson) + "}");
  }

  private static void emitTraceStdout(int line, String textJson) {
    appendEvent(baseEvent(line, "stdout") + ",\"text\":" + asJsonValue(textJson) + "}");
  }

  private static void emitTraceSnapshot(int line, String variable, String valueJson) {
    CURRENT_SNAPSHOTS.put(variable, valueJson);
    emitTraceSnapshotEvent(line, variable, valueJson);
  }

  private static void emitTraceSnapshotEvent(int line, String variable, String valueJson) {
    appendEvent(baseEvent(line, "snapshot")
        + ",\"target\":{\"variable\":" + jsonString(variable) + "}"
        + ",\"value\":" + asJsonValue(valueJson) + "}");
  }

  private static void emitTraceAccess(int line, String kind, String variable, String pathJson, String valueJson) {
    StringBuilder builder = new StringBuilder(baseEvent(line, kind));
    builder.append(",\"target\":{\"variable\":").append(jsonString(variable));
    if (pathJson != null) {
      builder.append(",\"path\":").append(pathJson);
    }
    builder.append("}");
    if (valueJson != null && !"mutate".equals(kind)) {
      builder.append(",\"value\":").append(asJsonValue(valueJson));
    }
    builder.append("}");
    appendEvent(builder.toString());
  }

  private static void emitTraceMutate(int line, String variable, String pathJson, String method) {
    String normalizedMethod = normalizeMutationMethod(method);
    StringBuilder builder = new StringBuilder(baseEvent(line, "mutate"));
    builder.append(",\"target\":{\"variable\":").append(jsonString(variable));
    if (pathJson != null) {
      builder.append(",\"path\":").append(pathJson);
    }
    builder.append("}");
    if (normalizedMethod != null && normalizedMethod.length() > 0) {
      builder.append(",\"method\":").append(jsonString(normalizedMethod));
    }
    builder.append("}");
    appendEvent(builder.toString());
  }

  private static String normalizeMutationMethod(String method) {
    if ("add".equals(method) || "push".equals(method)) return "append";
    if ("put".equals(method)) return "set";
    return method;
  }

  private static String asJsonValue(String raw) {
    if (raw == null) return "null";
    String trimmed = raw.trim();
    if (trimmed.length() == 0) return jsonString("");
    if ("null".equals(trimmed) || "true".equals(trimmed) || "false".equals(trimmed)) return trimmed;
    if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) return trimmed;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
    if (trimmed.matches("-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?")) return trimmed;
    return jsonString(trimmed);
  }

  private static String objectFromKeyValueFragment(String fragment) {
    StringBuilder builder = new StringBuilder();
    builder.append('{');
    int count = 0;
    for (KeyValuePair pair : parseKeyValuePairs(fragment)) {
      if (count++ > 0) builder.append(',');
      builder.append(jsonString(pair.key.replace('.', '_'))).append(':').append(asJsonValue(pair.value));
    }
    builder.append('}');
    return builder.toString();
  }

  private static void emitTraceSnapshotsFromFragment(int line, String fragment) {
    for (KeyValuePair pair : parseKeyValuePairs(fragment)) {
      if ("method".equals(pair.key)) continue;
      emitTraceSnapshot(line, pair.key.replace('.', '_'), pair.value);
    }
  }

  private static List<KeyValuePair> parseKeyValuePairs(String fragment) {
    List<KeyValuePair> pairs = new ArrayList<>();
    if (fragment == null || fragment.length() == 0) return pairs;
    Matcher matcher = KEY_VALUE_PATTERN.matcher(fragment);
    List<MatchRange> matches = new ArrayList<>();
    while (matcher.find()) {
      matches.add(new MatchRange(matcher.start(), matcher.end(), matcher.group(1)));
    }
    for (int index = 0; index < matches.size(); index++) {
      MatchRange current = matches.get(index);
      int valueStart = current.end;
      int valueEnd = index + 1 < matches.size() ? matches.get(index + 1).start : fragment.length();
      String value = fragment.substring(valueStart, valueEnd).trim();
      if (current.key != null && current.key.length() > 0 && value.length() > 0) {
        pairs.add(new KeyValuePair(current.key, value));
      }
    }
    return pairs;
  }

  private static void emitTraceAccessPayload(int line, String payload) {
    Matcher cellRead = Pattern.compile("^access ([A-Za-z_][A-Za-z0-9_]*)\\[(\\d+)\\]\\[(\\d+)\\]=(.+)$").matcher(payload);
    if (cellRead.matches()) {
      emitTraceAccess(line, "read", cellRead.group(1), "[" + cellRead.group(2) + "," + cellRead.group(3) + "]", cellRead.group(4));
      return;
    }
    Matcher indexedRead = Pattern.compile("^access ([A-Za-z_][A-Za-z0-9_]*)\\[(\\d+)\\]=(.+)$").matcher(payload);
    if (indexedRead.matches()) {
      emitTraceAccess(line, "read", indexedRead.group(1), "[" + indexedRead.group(2) + "]", indexedRead.group(3));
      return;
    }
    Matcher cellWrite = Pattern.compile("^write-array ([A-Za-z_][A-Za-z0-9_]*)\\[(\\d+)\\]\\[(\\d+)\\]=(.+)$").matcher(payload);
    if (cellWrite.matches()) {
      emitTraceAccess(line, "write", cellWrite.group(1), "[" + cellWrite.group(2) + "," + cellWrite.group(3) + "]", cellWrite.group(4));
      return;
    }
    Matcher indexedWrite = Pattern.compile("^write-array ([A-Za-z_][A-Za-z0-9_]*)\\[(\\d+)\\]=(.+)$").matcher(payload);
    if (indexedWrite.matches()) {
      emitTraceAccess(line, "write", indexedWrite.group(1), "[" + indexedWrite.group(2) + "]", indexedWrite.group(3));
      return;
    }
    Matcher fieldRead = Pattern.compile("^access ([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)=(.+)$").matcher(payload);
    if (fieldRead.matches()) {
      emitTraceAccess(line, "read", fieldRead.group(1), "[" + jsonString(fieldRead.group(2)) + "]", fieldRead.group(3));
      return;
    }
    Matcher fieldWrite = Pattern.compile("^write ([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)=(.+)$").matcher(payload);
    if (fieldWrite.matches()) {
      emitTraceAccess(line, "write", fieldWrite.group(1), "[" + jsonString(fieldWrite.group(2)) + "]", fieldWrite.group(3));
    }
  }

  private static void emitTraceMutatePayload(int line, String payload) {
    Matcher mutatingCall = Pattern.compile("^mutate ([A-Za-z_][A-Za-z0-9_]*) method=([A-Za-z_][A-Za-z0-9_]*)$").matcher(payload);
    if (mutatingCall.matches()) {
      emitTraceMutate(line, mutatingCall.group(1), null, mutatingCall.group(2));
      return;
    }
    Matcher indexedMutatingCall = Pattern.compile("^mutate-indexed ([A-Za-z_][A-Za-z0-9_]*)\\[(\\d+)\\] method=([A-Za-z_][A-Za-z0-9_]*)$").matcher(payload);
    if (indexedMutatingCall.matches()) {
      emitTraceMutate(line, indexedMutatingCall.group(1), "[" + indexedMutatingCall.group(2) + "]", indexedMutatingCall.group(3));
      return;
    }
    Matcher keyedCall = Pattern.compile("^keyed-call ([A-Za-z_][A-Za-z0-9_]*) method=([A-Za-z_][A-Za-z0-9_]*)(?:\\s+.*)?$").matcher(payload);
    if (keyedCall.matches()) {
      emitTraceMutate(line, keyedCall.group(1), null, keyedCall.group(2));
    }
  }

  private static final class MatchRange {
    final int start;
    final int end;
    final String key;

    MatchRange(int start, int end, String key) {
      this.start = start;
      this.end = end;
      this.key = key;
    }
  }

  private static final class KeyValuePair {
    final String key;
    final String value;

    KeyValuePair(String key, String value) {
      this.key = key;
      this.value = value;
    }
  }

  public static boolean traceCondition(int line, boolean value) {
    emit("line=" + line);
    return value;
  }

  public static void reset() {
    reset(DEFAULT_MAX_EVENTS);
  }

  public static void reset(int nextMaxEvents) {
    EVENTS.clear();
    IDENTITIES.clear();
    CURRENT_SNAPSHOTS.clear();
    FUNCTION_STACK.clear();
    currentFunction = "<module>";
    nextListIdentityIndex = 0;
    maxEvents = Math.max(1, nextMaxEvents);
    traceLimitExceeded = false;
    droppedEventCount = 0;
  }

  public static List<String> drainEvents() {
    List<String> copy = new ArrayList<>(EVENTS);
    EVENTS.clear();
    return copy;
  }

  public static boolean traceLimitExceeded() {
    return traceLimitExceeded;
  }

  public static int droppedEventCount() {
    return droppedEventCount;
  }

  public static void registerIdentity(Object value, String id) {
    if (value != null) {
      IDENTITIES.put(value, id);
    }
  }

  public static String identityFor(Object value) {
    return IDENTITIES.get(value);
  }

  public static <T> T reindexListIds(T head) {
    Object current = head;
    IdentityHashMap<Object, Boolean> seen = new IdentityHashMap<>();
    while (current != null && !seen.containsKey(current)) {
      seen.put(current, Boolean.TRUE);
      registerIdentity(current, "node-" + nextListIdentityIndex++);
      current = readField(current, "next");
    }
    return head;
  }

  public static int readIntArrayAtLine(int line, String name, int[] values, int index) {
    int value = values[index];
    emitIndexedState(line, name, values);
    emit("line=" + line + " access " + name + "[" + index + "]=" + value);
    return value;
  }

  public static int readIntMatrixAtLine(int line, String name, int[][] values, int row, int col) {
    int value = values[row][col];
    emitIndexedState(line, name, values);
    emit("line=" + line + " access " + name + "[" + row + "][" + col + "]=" + value);
    return value;
  }

  public static boolean readBooleanArrayAtLine(int line, String name, boolean[] values, int index) {
    boolean value = values[index];
    emitIndexedState(line, name, values);
    emit("line=" + line + " access " + name + "[" + index + "]=" + value);
    return value;
  }

  public static boolean readBooleanMatrixAtLine(int line, String name, boolean[][] values, int row, int col) {
    boolean value = values[row][col];
    emitIndexedState(line, name, values);
    emit("line=" + line + " access " + name + "[" + row + "][" + col + "]=" + value);
    return value;
  }

  public static long readLongArrayAtLine(int line, String name, long[] values, int index) {
    long value = values[index];
    emitIndexedState(line, name, values);
    emit("line=" + line + " access " + name + "[" + index + "]=" + value);
    return value;
  }

  public static double readDoubleArrayAtLine(int line, String name, double[] values, int index) {
    double value = values[index];
    emitIndexedState(line, name, values);
    emit("line=" + line + " access " + name + "[" + index + "]=" + value);
    return value;
  }

  public static float readFloatArrayAtLine(int line, String name, float[] values, int index) {
    float value = values[index];
    emitIndexedState(line, name, values);
    emit("line=" + line + " access " + name + "[" + index + "]=" + value);
    return value;
  }

  public static char readCharArrayAtLine(int line, String name, char[] values, int index) {
    char value = values[index];
    emitIndexedState(line, name, values);
    emit("line=" + line + " access " + name + "[" + index + "]=" + jsonString(String.valueOf(value)));
    return value;
  }

  public static char readCharMatrixAtLine(int line, String name, char[][] values, int row, int col) {
    char value = values[row][col];
    emitIndexedState(line, name, values);
    emit("line=" + line + " access " + name + "[" + row + "][" + col + "]=" + jsonString(String.valueOf(value)));
    return value;
  }

  public static byte readByteArrayAtLine(int line, String name, byte[] values, int index) {
    byte value = values[index];
    emitIndexedState(line, name, values);
    emit("line=" + line + " access " + name + "[" + index + "]=" + value);
    return value;
  }

  public static short readShortArrayAtLine(int line, String name, short[] values, int index) {
    short value = values[index];
    emitIndexedState(line, name, values);
    emit("line=" + line + " access " + name + "[" + index + "]=" + value);
    return value;
  }

  public static char readStringCharAtLine(int line, String name, String value, int index) {
    char ch = value.charAt(index);
    emit("line=" + line + " " + name + "=" + jsonString(value));
    emit("line=" + line + " access " + name + "[" + index + "]=" + jsonString(String.valueOf(ch)));
    return ch;
  }

  public static String serializeStringState(String value) {
    return jsonString(value);
  }

  public static char readStringMatrixCharAtLine(int line, String name, String[] values, int row, int col) {
    char ch = values[row].charAt(col);
    emitIndexedState(line, name, values);
    emit("line=" + line + " access " + name + "[" + row + "][" + col + "]=" + jsonString(String.valueOf(ch)));
    return ch;
  }

  public static <T> T readObjectArrayAtLine(int line, String name, T[] values, int index) {
    T value = values[index];
    emitIndexedState(line, name, values);
    emit("line=" + line + " access " + name + "[" + index + "]=" + serializeValue(value));
    return value;
  }

  public static <T> T readObjectListAtLine(int line, String name, List<T> values, int index) {
    T value = values.get(index);
    emitIndexedState(line, name, values);
    emit("line=" + line + " access " + name + "[" + index + "]=" + serializeValue(value));
    return value;
  }

  public static <T> T readCollectionFrontAtLine(int line, String name, T value) {
    emit("line=" + line + " access " + name + "[0]=" + serializeValue(value));
    return value;
  }

  public static Iterator<?> toIterator(Object value) {
    if (value instanceof Iterable<?>) {
      return ((Iterable<?>) value).iterator();
    }
    if (value != null && value.getClass().isArray()) {
      List<Object> list = new ArrayList<>();
      int length = Array.getLength(value);
      for (int index = 0; index < length; index++) {
        list.add(Array.get(value, index));
      }
      return list.iterator();
    }
    return new ArrayList<>().iterator();
  }

  public static int readArrayLengthAtLine(int line, String name, Object value) {
    int length = value == null ? 0 : Array.getLength(value);
    emitIndexedState(line, name, value);
    return length;
  }

  public static <T> T readObjectMatrixAtLine(int line, String name, T[][] values, int row, int col) {
    T value = values[row][col];
    emitIndexedState(line, name, values);
    emit("line=" + line + " access " + name + "[" + row + "][" + col + "]=" + serializeValue(value));
    return value;
  }

  public static int readIntFieldAtLine(int line, String name, String field, int value) {
    emit("line=" + line + " access " + name + "." + field + "=" + value);
    return value;
  }

  public static void emitArrayWriteAtLine(int line, String name, int index, Object value) {
    emit("line=" + line + " write-array " + name + "[" + index + "]=" + serializeValue(value));
  }

  public static void emitArrayWriteAtLine(int line, String name, int row, int col, Object value) {
    emit("line=" + line + " write-array " + name + "[" + row + "][" + col + "]=" + serializeValue(value));
  }

  public static <T> T readObjectFieldAtLine(int line, String name, String field, T value) {
    emit("line=" + line + " access " + name + "." + field + "=" + serializeValue(value));
    return value;
  }

  public static void emitFieldWriteAtLine(int line, String name, String field, Object value) {
    emit("line=" + line + " write " + name + "." + field + "=" + serializeValue(value));
  }

  public static void emitMutatingCallAtLine(int line, String name, String method) {
    emit("line=" + line + " mutate " + name + " method=" + method);
  }

  public static void emitMutatingCallAtLine(int line, String name, int index, String method) {
    emit("line=" + line + " mutate-indexed " + name + "[" + index + "] method=" + method);
  }

  public static <K, V> V readMapAtLine(int line, String name, Map<K, V> values, K key) {
    V value = values.get(key);
    emitKeyedMutatingCallAtLine(line, name, "get", key);
    emitMapSnapshotAtLine(line, name, values, key);
    return value;
  }

  public static <K, V> V readMapOrDefaultAtLine(int line, String name, Map<K, V> values, K key, V defaultValue) {
    V value = values.getOrDefault(key, defaultValue);
    emitKeyedMutatingCallAtLine(line, name, "get", key);
    emitMapSnapshotAtLine(line, name, values, key);
    return value;
  }

  public static boolean containsMapKeyAtLine(int line, String name, Map<?, ?> values, Object key) {
    boolean value = values.containsKey(key);
    emitKeyedMutatingCallAtLine(line, name, "containsKey", key);
    emitMapSnapshotAtLine(line, name, values, key);
    return value;
  }

  public static <K, V> V writeMapAtLine(int line, String name, Map<K, V> values, K key, V value) {
    V previous = values.put(key, value);
    emitKeyedMutatingCallAtLine(line, name, "put", key, value);
    emitMapSnapshotAtLine(line, name, values, key);
    return previous;
  }

  public static boolean readSetAtLine(int line, String name, Set<?> values, Object key) {
    boolean value = values.contains(key);
    emitKeyedMutatingCallAtLine(line, name, "contains", key);
    emitSetSnapshotAtLine(line, name, values, key);
    return value;
  }

  public static <T> boolean addSetAtLine(int line, String name, Set<T> values, T key) {
    boolean changed = values.add(key);
    emitKeyedMutatingCallAtLine(line, name, "add", key);
    emitSetSnapshotAtLine(line, name, values, key);
    return changed;
  }

  public static boolean removeSetAtLine(int line, String name, Set<?> values, Object key) {
    boolean changed = values.remove(key);
    emitKeyedMutatingCallAtLine(line, name, "remove", key);
    emitSetSnapshotAtLine(line, name, values, null, false, key, true);
    return changed;
  }

  public static void emitKeyedMutatingCallAtLine(int line, String name, String method, Object key) {
    emit("line=" + line + " keyed-call " + name + " method=" + method + " key=" + serializeValue(key));
  }

  public static void emitKeyedMutatingCallAtLine(int line, String name, String method, Object key, Object value) {
    emit("line=" + line + " keyed-call " + name + " method=" + method + " key=" + serializeValue(key)
        + " value=" + serializeValue(value));
  }

  public static void emitMapSnapshotAtLine(int line, String name, Map<?, ?> values) {
    emitTraceSnapshot(line, name, buildMapRuntimeValue(values));
  }

  public static void emitMapSnapshotAtLine(int line, String name, Map<?, ?> values, Object highlightedKey) {
    emitTraceSnapshot(line, name, buildMapRuntimeValue(values));
  }

  public static void emitSetSnapshotAtLine(int line, String name, Set<?> values) {
    emitSetSnapshotAtLine(line, name, values, null, false, null, false);
  }

  public static void emitSetSnapshotAtLine(int line, String name, Set<?> values, Object highlightedKey) {
    emitSetSnapshotAtLine(line, name, values, highlightedKey, true, null, false);
  }

  public static void emitSetSnapshotAtLine(int line, String name, Set<?> values, Object highlightedKey, Object deletedKey) {
    emitSetSnapshotAtLine(line, name, values, highlightedKey, true, deletedKey, true);
  }

  public static void emitListStateAtLine(int line, String name, Object value) {
    emitTraceSnapshot(line, name, serializeValue(value));
  }

  public static void emitTreeStateAtLine(int line, String name, Object value) {
    emitTraceSnapshot(line, name, serializeValue(value));
  }

  public static void emitObjectStateAtLine(int line, String name, Object value) {
    emitTraceSnapshot(line, name, serializeValue(value));
  }

  public static <T> T popListAtLine(int line, String name, List<T> values) {
    T value = values.remove(values.size() - 1);
    emit("line=" + line + " mutate " + name + " method=pop");
    return value;
  }


  public static String serializeResult(Object value) {
    return serializeValue(value);
  }

  private static void emitSetSnapshotAtLine(
    int line,
    String name,
    Set<?> values,
    Object highlightedKey,
    boolean hasHighlightedKey,
    Object deletedKey,
    boolean hasDeletedKey
  ) {
    emitTraceSnapshot(line, name, buildSetRuntimeValue(values));
  }

  private static String buildMapRuntimeValue(Map<?, ?> values) {
    StringBuilder builder = new StringBuilder();
    builder.append("{\"__type__\":\"map\",\"entries\":[");
    int index = 0;
    if (values != null) {
      for (Map.Entry<?, ?> entry : values.entrySet()) {
        if (index++ > 0) builder.append(',');
        builder.append('[')
            .append(serializeValue(entry.getKey()))
            .append(',')
            .append(serializeValue(entry.getValue()))
            .append(']');
      }
    }
    builder.append("]}");
    return builder.toString();
  }

  private static String buildSetRuntimeValue(Set<?> values) {
    StringBuilder builder = new StringBuilder();
    builder.append("{\"__type__\":\"set\",\"values\":[");
    int index = 0;
    if (values != null) {
      for (Object entry : values) {
        if (index++ > 0) builder.append(',');
        builder.append(serializeValue(entry));
      }
    }
    builder.append("]}");
    return builder.toString();
  }

  private static String buildMapVisualization(
    String name,
    Map<?, ?> values,
    Object highlightedKey,
    boolean hasHighlightedKey,
    Object deletedKey,
    boolean hasDeletedKey
  ) {
    StringBuilder builder = new StringBuilder();
    builder.append("{\"name\":").append(jsonString(name));
    builder.append(",\"kind\":\"map\"");
    if (hasHighlightedKey) {
      builder.append(",\"highlightedKey\":").append(serializeValue(highlightedKey));
    }
    if (hasDeletedKey) {
      builder.append(",\"deletedKey\":").append(serializeValue(deletedKey));
    }
    builder.append(",\"entries\":[");
    int index = 0;
    if (values != null) {
      for (Map.Entry<?, ?> entry : values.entrySet()) {
        if (index++ > 0) builder.append(',');
        Object key = entry.getKey();
        builder.append("{\"key\":").append(serializeValue(key));
        builder.append(",\"value\":").append(serializeValue(entry.getValue()));
        if (hasHighlightedKey && keysEqual(key, highlightedKey)) {
          builder.append(",\"highlight\":true");
        }
        builder.append('}');
      }
    }
    builder.append("]}");
    return builder.toString();
  }

  private static String buildSetVisualization(
    String name,
    Set<?> values,
    Object highlightedKey,
    boolean hasHighlightedKey,
    Object deletedKey,
    boolean hasDeletedKey
  ) {
    StringBuilder builder = new StringBuilder();
    builder.append("{\"name\":").append(jsonString(name));
    builder.append(",\"kind\":\"set\"");
    if (hasHighlightedKey) {
      builder.append(",\"highlightedKey\":").append(serializeValue(highlightedKey));
    }
    if (hasDeletedKey) {
      builder.append(",\"deletedKey\":").append(serializeValue(deletedKey));
    }
    builder.append(",\"entries\":[");
    int index = 0;
    if (values != null) {
      for (Object entry : values) {
        if (index++ > 0) builder.append(',');
        builder.append("{\"key\":").append(serializeValue(entry));
        builder.append(",\"value\":true");
        if (hasHighlightedKey && keysEqual(entry, highlightedKey)) {
          builder.append(",\"highlight\":true");
        }
        builder.append('}');
      }
    }
    builder.append("]}");
    return builder.toString();
  }

  private static boolean keysEqual(Object left, Object right) {
    if (left == null) return right == null;
    return left.equals(right);
  }

  public static String jsonString(String value) {
    if (value == null) return "null";
    StringBuilder builder = new StringBuilder();
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

  private static void emitIndexedState(int line, String name, Object values) {
    emit("line=" + line + " " + name + "=" + serializeValue(values));
  }

  private static Object readField(Object object, String fieldName) {
    if (object == null) return null;
    try {
      Field field = object.getClass().getDeclaredField(fieldName);
      field.setAccessible(true);
      return field.get(object);
    } catch (Exception ignored) {
      return null;
    }
  }

  private static String serializeValue(Object value) {
    return serializeValue(value, new IdentityHashMap<Object, Boolean>(), 0);
  }

  private static String serializeValue(Object value, IdentityHashMap<Object, Boolean> seen, int depth) {
    if (depth > 48) return jsonString("<max depth>");
    if (value == null) return "null";
    if (value instanceof String || value instanceof Character) return jsonString(String.valueOf(value));
    if (value instanceof Number || value instanceof Boolean) return String.valueOf(value);
    Class<?> valueClass = value.getClass();
    if (valueClass.isArray()) {
      int length = Array.getLength(value);
      StringBuilder builder = new StringBuilder("[");
      for (int index = 0; index < length; index++) {
        if (index > 0) builder.append(',');
        builder.append(serializeValue(Array.get(value, index), seen, depth + 1));
      }
      builder.append(']');
      return builder.toString();
    }
    if (value instanceof List<?>) {
      List<?> list = (List<?>) value;
      StringBuilder builder = new StringBuilder("[");
      for (int index = 0; index < list.size(); index++) {
        if (index > 0) builder.append(',');
        builder.append(serializeValue(list.get(index), seen, depth + 1));
      }
      builder.append(']');
      return builder.toString();
    }
    if (value instanceof Set<?>) {
      StringBuilder builder = new StringBuilder("{\"__type__\":\"set\",\"values\":[");
      int index = 0;
      for (Object entry : (Set<?>) value) {
        if (index++ > 0) builder.append(',');
        builder.append(serializeValue(entry, seen, depth + 1));
      }
      builder.append("]}");
      return builder.toString();
    }
    if (value instanceof Map<?, ?>) {
      StringBuilder builder = new StringBuilder("{\"__type__\":\"map\",\"entries\":[");
      int index = 0;
      for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
        if (index++ > 0) builder.append(',');
        builder.append('[');
        builder.append(serializeValue(entry.getKey(), seen, depth + 1));
        builder.append(',');
        builder.append(serializeValue(entry.getValue(), seen, depth + 1));
        builder.append(']');
      }
      builder.append("]}");
      return builder.toString();
    }
    if (value instanceof Collection<?>) {
      StringBuilder builder = new StringBuilder("[");
      int index = 0;
      for (Object entry : (Collection<?>) value) {
        if (index++ > 0) builder.append(',');
        builder.append(serializeValue(entry, seen, depth + 1));
      }
      builder.append(']');
      return builder.toString();
    }
    if (seen.containsKey(value)) {
      String identity = identityFor(value);
      return identity == null ? jsonString("<cycle>") : "{\"__ref__\":" + jsonString(identity) + "}";
    }
    seen.put(value, Boolean.TRUE);
    String identity = identityFor(value);
    StringBuilder builder = new StringBuilder("{");
    builder.append("\"__type__\":\"object\"");
    builder.append(",\"__class__\":").append(jsonString(valueClass.getSimpleName()));
    if (identity != null) {
      builder.append(",\"__id__\":").append(jsonString(identity));
    }
    Field[] fields = valueClass.getDeclaredFields();
    int emitted = 0;
    for (Field field : fields) {
      if (java.lang.reflect.Modifier.isStatic(field.getModifiers())) continue;
      if (emitted >= 32) {
        builder.append(",\"__truncated__\":true");
        break;
      }
      try {
        field.setAccessible(true);
        builder.append(',').append(jsonString(field.getName())).append(':');
        builder.append(serializeValue(field.get(value), seen, depth + 1));
        emitted += 1;
      } catch (Exception ignored) {
        // Skip inaccessible fields.
      }
    }
    builder.append('}');
    seen.remove(value);
    return builder.toString();
  }
}

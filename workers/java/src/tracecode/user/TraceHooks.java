package tracecode.user;

import java.util.ArrayList;
import java.util.List;

public final class TraceHooks {
  private static final int DEFAULT_MAX_EVENTS = 50000;
  private static final int MAX_SERIALIZE_DEPTH = 48;
  private static final int MAX_SERIALIZED_ITEMS = 64;
  private static final int MAX_OBJECT_FIELDS = 32;
  private static final List<String> EVENTS = new ArrayList<>();
  private static final ThreadLocal<java.util.List<TraceFrame>> CALL_STACK = ThreadLocal.withInitial(java.util.ArrayList::new);
  private static final ThreadLocal<String> LAST_INDEX_SOURCE = new ThreadLocal<>();
  private static int maxEvents = DEFAULT_MAX_EVENTS;
  private static boolean traceLimitExceeded = false;
  private static int droppedEventCount = 0;

  private TraceHooks() {}

  public static void emit(String event) {
    if (traceLimitExceeded) {
      droppedEventCount += 1;
      return;
    }
    if (event == null || !event.startsWith("trace:")) {
      throw new IllegalArgumentException("TraceHooks.emit only accepts native trace: runtime events");
    }
    if (EVENTS.size() >= maxEvents) {
      traceLimitExceeded = true;
      droppedEventCount += 1;
      return;
    }
    EVENTS.add(sanitizeJsonNonFiniteNumbers(withCallStack(event)));
  }

  public static void reset() {
    reset(DEFAULT_MAX_EVENTS);
  }

  public static void reset(int nextMaxEvents) {
    EVENTS.clear();
    CALL_STACK.get().clear();
    LAST_INDEX_SOURCE.remove();
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

  public static String serializeResult(Object value) {
    return serializeResult(value, new java.util.IdentityHashMap<Object, String>(), 0, true);
  }

  public static String serializeOutputResult(Object value) {
    return serializeResult(value, new java.util.IdentityHashMap<Object, String>(), 0, false);
  }

  public static void emitLineAtLine(int line) {
    emit("trace:{\"kind\":\"line\",\"line\":" + line + "}");
  }

  public static void emitLineAtLine(int line, String snapshotFragment) {
    emitLineAtLine(line);
    emitSnapshotsFromFragment(line, snapshotFragment);
  }

  public static void emitCallAtLine(int line, String functionName, String argsJson) {
    StringBuilder out = new StringBuilder("trace:{\"kind\":\"call\",\"line\":");
    out.append(line).append(",\"function\":").append(jsonString(functionName == null ? "" : functionName));
    String argsPayload = argsJsonPayload(argsJson);
    if (argsPayload != null) out.append(",\"args\":").append(argsPayload);
    CALL_STACK.get().add(new TraceFrame(functionName == null ? "" : functionName, line, argsPayload));
    out.append("}");
    emit(out.toString());
    emitSnapshotsFromFragment(line, argsJson);
  }

  public static void emitReturnAtLine(int line, String functionName) {
    emitReturnAtLine(line, functionName, null);
  }

  public static void emitReturnAtLine(int line, String functionName, Object value) {
    StringBuilder out = new StringBuilder("trace:{\"kind\":\"return\",\"line\":");
    out.append(line).append(",\"function\":").append(jsonString(functionName == null ? "" : functionName));
    if (value != null) out.append(",\"value\":").append(serializeResult(value));
    out.append("}");
    emit(out.toString());
    popCallFrame(functionName);
  }

  public static void emitSerializedReturnAtLine(int line, String functionName, String serializedValue) {
    StringBuilder out = new StringBuilder("trace:{\"kind\":\"return\",\"line\":");
    out.append(line).append(",\"function\":").append(jsonString(functionName == null ? "" : functionName));
    if (serializedValue != null) out.append(",\"value\":").append(serializedValue);
    out.append("}");
    emit(out.toString());
    popCallFrame(functionName);
  }

  public static void emitRuntimeSnapshotAtLine(int line, String name, Object value) {
    emitSnapshot(line, name, serializeResult(value));
  }

  public static void emitFieldWriteAtLine(int line, String name, String field, Object value) {
    emitTraceWrite(line, name, "[" + jsonString(field) + "]", value);
  }

  public static void emitArrayWriteAtLine(int line, String name, int index, Object value) {
    emitTraceWrite(line, name, "[" + serializeResult(index) + "]", value);
  }

  public static void emitArrayWriteAtLine(int line, String name, int index, Object value, String indexSource) {
    emitTraceWrite(line, name, "[" + serializeResult(index) + "]", value, indexSourcesJson(indexSource));
  }

  public static void emitArrayWriteAtLine(int line, String name, int row, int col, Object value) {
    emitTraceWrite(line, name, "[" + serializeResult(row) + "," + serializeResult(col) + "]", value);
  }

  public static void emitArrayWriteAtLine(int line, String name, int row, int col, Object value, String rowSource, String colSource) {
    emitTraceWrite(line, name, "[" + serializeResult(row) + "," + serializeResult(col) + "]", value, indexSourcesJson(rowSource, colSource));
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

  public static void sortArrayAtLine(int line, String name, int[] values) {
    java.util.Arrays.sort(values);
    emitTraceMutate(line, name, null, "sort", null, "[]");
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static void sortArrayAtLine(int line, String name, long[] values) {
    java.util.Arrays.sort(values);
    emitTraceMutate(line, name, null, "sort", null, "[]");
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static void sortArrayAtLine(int line, String name, double[] values) {
    java.util.Arrays.sort(values);
    emitTraceMutate(line, name, null, "sort", null, "[]");
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static void sortArrayAtLine(int line, String name, char[] values) {
    java.util.Arrays.sort(values);
    emitTraceMutate(line, name, null, "sort", null, "[]");
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static <T> void sortArrayAtLine(int line, String name, T[] values) {
    java.util.Arrays.sort(values);
    emitTraceMutate(line, name, null, "sort", null, "[]");
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static <T> void sortArrayAtLine(int line, String name, T[] values, java.util.Comparator<? super T> comparator) {
    java.util.Arrays.sort(values, comparator);
    emitTraceMutate(line, name, null, "sort", null, "[]");
    emitRuntimeSnapshotAtLine(line, name, values);
  }

  public static <T> T readObjectFieldAtLine(int line, String name, String field, T value) {
    emitTraceRead(line, name, "[" + jsonString(field) + "]", value);
    return value;
  }

  public static void emitExceptionAtLine(int line, Object value) {
    emit("trace:{\"kind\":\"exception\",\"line\":" + line + ",\"value\":" + serializeResult(value) + "}");
  }

  public static void emitStdoutAtLine(int line, Object value) {
    emit("trace:{\"kind\":\"stdout\",\"line\":" + line + ",\"value\":" + serializeResult(value) + "}");
  }

  public static boolean traceCondition(int line, boolean value) {
    emitLineAtLine(line);
    return value;
  }

  private static String serializeResult(Object value, java.util.IdentityHashMap<Object, String> seen, int depth, boolean capValues) {
    if (depth > MAX_SERIALIZE_DEPTH) return "\"<max depth>\"";
    if (value == null) return "null";
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
    return packageName.startsWith("harness.user.") || packageName.startsWith("tracecode.user.");
  }

  private static String serializeUserObject(Object value, java.util.IdentityHashMap<Object, String> seen, int depth, boolean capValues) {
    if (seen.containsKey(value)) return "{\"__ref__\":" + jsonString(seen.get(value)) + "}";
    String nodeId = "ref-" + seen.size();
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

  private static String sanitizeJsonNonFiniteNumbers(String event) {
    return event
        .replaceAll("(?<![A-Za-z0-9_\\\"])-Infinity(?![A-Za-z0-9_\\\"])", "\"-Infinity\"")
        .replaceAll("(?<![A-Za-z0-9_\\\"])Infinity(?![A-Za-z0-9_\\\"])", "\"Infinity\"")
        .replaceAll("(?<![A-Za-z0-9_\\\"])NaN(?![A-Za-z0-9_\\\"])", "\"NaN\"");
  }

  private static String withCallStack(String event) {
    java.util.List<TraceFrame> stack = CALL_STACK.get();
    if (stack.isEmpty() || !event.endsWith("}")) return event;
    return event.substring(0, event.length() - 1) + ",\"callStack\":" + serializeCallStack(stack) + "}";
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
    java.util.List<TraceFrame> stack = CALL_STACK.get();
    if (stack.isEmpty()) return;
    String normalized = functionName == null ? "" : functionName;
    int last = stack.size() - 1;
    if (stack.get(last).functionName.equals(normalized)) {
      stack.remove(last);
      return;
    }
    for (int index = last; index >= 0; index--) {
      if (stack.get(index).functionName.equals(normalized)) {
        stack.subList(index, stack.size()).clear();
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
    emit("trace:{\"kind\":\"snapshot\",\"line\":" + line + ",\"target\":{\"variable\":" + jsonString(name) + "},\"value\":" + serializedValue + "}");
  }

  public static void emitMutatingCallAtLine(int line, String name, String method) {
    emitTraceMutate(line, name, null, method);
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
    emitSnapshot(line, name, serializeResult(queue));
    return value;
  }

  public static void emitMutatingCallAtLine(int line, String name, int index, String method) {
    emitTraceMutate(line, name, "[" + serializeResult(index) + "]", method);
  }

  public static void emitMutatingCallAtLine(int line, String name, int index, String method, String indexSource) {
    emitTraceMutate(line, name, "[" + serializeResult(index) + "]", method, indexSourcesJson(indexSource));
  }

  public static void emitMutatingCallAtLine(int line, String name, Object key, String method, String indexSource) {
    emitTraceMutate(line, name, "[" + serializeResult(key) + "]", method, indexSourcesJson(indexSource));
  }

  public static void emitMutatingCallAtLine(int line, String name, Object key, String method, String indexSource, Object value) {
    emitTraceMutate(line, name, "[" + serializeResult(key) + "]", method, indexSourcesJson(indexSource), "[" + serializeResult(value) + "]");
  }

  public static void emitKeyedMutatingCallAtLine(int line, String name, String method, Object key) {
    emitTraceMutate(line, name, "[" + serializeResult(key) + "]", method);
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

  public static <T> Iterable<T> iterationBindAtLine(int line, String name, T[] values, String bindingVariable) {
    return iterationBindAtLine(line, name, java.util.Arrays.asList(values), bindingVariable);
  }

  public static Iterable<Integer> iterationBindAtLine(int line, String name, int[] values, String bindingVariable) {
    java.util.List<Integer> boxed = new java.util.ArrayList<>(values.length);
    for (int value : values) boxed.add(value);
    return iterationBindAtLine(line, name, boxed, bindingVariable);
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

  public static int readArrayLengthAtLine(int line, String name, Object value) {
    int length = value == null ? 0 : java.lang.reflect.Array.getLength(value);
    emitTraceRead(line, name, "[" + jsonString("length") + "]", length);
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

  public static <K, V> V readMapAtLine(int line, String name, java.util.Map<K, V> values, K key) {
    V value = values.get(key);
    emitTraceRead(line, name, "[" + serializeResult(key) + "]", value);
    return value;
  }

  public static <K, V> V readMapAtLine(int line, String name, java.util.Map<K, V> values, K key, String keySource) {
    V value = values.get(key);
    emitTraceRead(line, name, "[" + serializeResult(key) + "]", value, indexSourcesJson(keySource));
    return value;
  }

  public static <K, V> V readFieldMapAtLine(int line, String ownerName, String field, java.util.Map<K, V> values, K key) {
    V value = values.get(key);
    emitTraceRead(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", value);
    return value;
  }

  public static <K, V> V readFieldMapAtLine(int line, String ownerName, String field, java.util.Map<K, V> values, K key, String keySource) {
    V value = values.get(key);
    emitTraceRead(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", value, indexSourcesJson(null, keySource));
    return value;
  }

  public static <K, V> V readMapOrDefaultAtLine(int line, String name, java.util.Map<K, V> values, K key, V defaultValue) {
    V value = values.getOrDefault(key, defaultValue);
    emitTraceRead(line, name, "[" + serializeResult(key) + "]", value);
    return value;
  }

  public static <K, V> V readMapOrDefaultAtLine(int line, String name, java.util.Map<K, V> values, K key, V defaultValue, String keySource) {
    V value = values.getOrDefault(key, defaultValue);
    emitTraceRead(line, name, "[" + serializeResult(key) + "]", value, indexSourcesJson(keySource));
    return value;
  }

  public static <K, V> V readFieldMapOrDefaultAtLine(int line, String ownerName, String field, java.util.Map<K, V> values, K key, V defaultValue) {
    V value = values.getOrDefault(key, defaultValue);
    emitTraceRead(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", value);
    return value;
  }

  public static <K, V> V readFieldMapOrDefaultAtLine(int line, String ownerName, String field, java.util.Map<K, V> values, K key, V defaultValue, String keySource) {
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
    emitRuntimeSnapshotAtLine(line, name, values);
    return changed;
  }

  public static <T> boolean offerQueueAtLine(int line, String name, java.util.Queue<T> values, T value) {
    boolean changed = values.offer(value);
    emitTraceMutate(line, name, null, "offer", null, "[" + serializeResult(value) + "]");
    emitRuntimeSnapshotAtLine(line, name, values);
    return changed;
  }

  public static <T> T pollQueueAtLine(int line, String name, java.util.Queue<T> values) {
    T value = values.peek();
    emitTraceRead(line, name, "[0]", value);
    value = values.poll();
    emitTraceMutate(line, name, null, "poll", null, "[]");
    emitRuntimeSnapshotAtLine(line, name, values);
    return value;
  }

  public static boolean removeSetAtLine(int line, String name, java.util.Set<?> values, Object key) {
    boolean changed = values.remove(key);
    emitTraceMutate(line, name, null, "remove");
    emitRuntimeSnapshotAtLine(line, name, values);
    return changed;
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
    emitRuntimeSnapshotAtLine(line, name, values);
    return previous;
  }

  public static <T> T writeListAtLine(int line, String name, java.util.List<T> values, int index, T value, String indexSource) {
    T previous = values.set(index, value);
    emitTraceWrite(line, name, "[" + serializeResult(index) + "]", values.get(index), indexSourcesJson(indexSource));
    emitRuntimeSnapshotAtLine(line, name, values);
    return previous;
  }

  public static int readIntArrayAtLine(int line, String name, int[] values, int index, String indexSource) {
    int value = values[index];
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", value, indexSourcesJson(indexSource));
    return value;
  }

  public static long readLongArrayAtLine(int line, String name, long[] values, int index, String indexSource) {
    long value = values[index];
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", value, indexSourcesJson(indexSource));
    return value;
  }

  public static boolean readBooleanArrayAtLine(int line, String name, boolean[] values, int index, String indexSource) {
    boolean value = values[index];
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", value, indexSourcesJson(indexSource));
    return value;
  }

  public static double readDoubleArrayAtLine(int line, String name, double[] values, int index, String indexSource) {
    double value = values[index];
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", value, indexSourcesJson(indexSource));
    return value;
  }

  public static float readFloatArrayAtLine(int line, String name, float[] values, int index, String indexSource) {
    float value = values[index];
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", value, indexSourcesJson(indexSource));
    return value;
  }

  public static char readCharArrayAtLine(int line, String name, char[] values, int index, String indexSource) {
    char value = values[index];
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", String.valueOf(value), indexSourcesJson(indexSource));
    return value;
  }

  public static byte readByteArrayAtLine(int line, String name, byte[] values, int index, String indexSource) {
    byte value = values[index];
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", value, indexSourcesJson(indexSource));
    return value;
  }

  public static short readShortArrayAtLine(int line, String name, short[] values, int index, String indexSource) {
    short value = values[index];
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", value, indexSourcesJson(indexSource));
    return value;
  }

  public static <T> T readObjectArrayAtLine(int line, String name, T[] values, int index, String indexSource) {
    T value = values[index];
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", value, indexSourcesJson(indexSource));
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
    if (indexSource != null) LAST_INDEX_SOURCE.set(indexSource);
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
    String source = LAST_INDEX_SOURCE.get();
    LAST_INDEX_SOURCE.remove();
    return source;
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
    emit("trace:{\"kind\":\"read\",\"line\":" + line + ",\"target\":{\"variable\":\"" + name + "\",\"path\":[" + serializeResult(row) + "," + serializeResult(col) + "]},\"value\":" + serializeResult(value) + "}");
  }

  private static void emitMatrixRead(int line, String name, int row, int col, Object value, String indexSourcesJson) {
    emitTraceRead(line, name, "[" + serializeResult(row) + "," + serializeResult(col) + "]", value, indexSourcesJson);
  }

  private static void emitNestedListArrayRead(int line, String name, int index, int elementIndex, Object value) {
    emit("trace:{\"kind\":\"read\",\"line\":" + line + ",\"target\":{\"variable\":\"" + name + "\",\"path\":[" + serializeResult(index) + "," + serializeResult(elementIndex) + "]},\"value\":" + serializeResult(value) + "}");
  }

  private static void emitNestedListArrayRead(int line, String name, int index, int elementIndex, Object value, String indexSourcesJson) {
    emitTraceRead(line, name, "[" + serializeResult(index) + "," + serializeResult(elementIndex) + "]", value, indexSourcesJson);
  }

  private static void emitTraceRead(int line, String name, String pathJson, Object value) {
    emitTraceRead(line, name, pathJson, value, null);
  }

  private static void emitTraceRead(int line, String name, String pathJson, Object value, String indexSourcesJson) {
    StringBuilder out = new StringBuilder("trace:{\"kind\":\"read\",\"line\":");
    out.append(line).append(",\"target\":{\"variable\":").append(jsonString(name)).append(",\"path\":").append(pathJson);
    if (indexSourcesJson != null) out.append(",\"indexSources\":").append(indexSourcesJson);
    out.append("},\"value\":").append(serializeResult(value)).append("}");
    emit(out.toString());
  }

  private static void emitTraceReadWithIterationBinding(int line, String name, String pathJson, Object value, String bindingVariable) {
    emitTraceReadWithIterationBinding(line, name, pathJson, value, bindingVariable, null);
  }

  private static void emitTraceReadWithIterationBinding(int line, String name, String pathJson, Object value, String bindingVariable, String indexSourcesJson) {
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
    emit("trace:{\"kind\":\"write\",\"line\":" + line + ",\"target\":{\"variable\":" + jsonString(name) + "},\"value\":" + serializeResult(value) + "}");
  }

  private static void emitTraceWrite(int line, String name, String pathJson, Object value, String indexSourcesJson) {
    StringBuilder out = new StringBuilder("trace:{\"kind\":\"write\",\"line\":");
    out.append(line).append(",\"target\":{\"variable\":").append(jsonString(name)).append(",\"path\":").append(pathJson);
    if (indexSourcesJson != null) out.append(",\"indexSources\":").append(indexSourcesJson);
    out.append("},\"value\":").append(serializeResult(value)).append("}");
    emit(out.toString());
  }

  private static void emitTraceMutate(int line, String name, String pathJson, String method) {
    emitTraceMutate(line, name, pathJson, method, null);
  }

  private static void emitTraceMutate(int line, String name, String pathJson, String method, String indexSourcesJson) {
    emitTraceMutate(line, name, pathJson, method, indexSourcesJson, null);
  }

  private static void emitTraceMutate(int line, String name, String pathJson, String method, String indexSourcesJson, String argsJson) {
    StringBuilder out = new StringBuilder("trace:{\"kind\":\"mutate\",\"line\":");
    out.append(line).append(",\"target\":{\"variable\":").append(jsonString(name));
    if (pathJson != null) out.append(",\"path\":").append(pathJson);
    if (indexSourcesJson != null) out.append(",\"indexSources\":").append(indexSourcesJson);
    out.append("}");
    if (method != null && !method.isEmpty()) out.append(",\"method\":").append(jsonString(method));
    if (argsJson != null) out.append(",\"args\":").append(argsJson);
    out.append("}");
    emit(out.toString());
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

  private static String indexSourcesJson(String... sources) {
    if (sources == null || sources.length == 0) return null;
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

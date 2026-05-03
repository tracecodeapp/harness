package tracecode.user;

public final class TraceHooks extends \u0073pike.user.TraceHooks {
  private static final int MAX_SERIALIZE_DEPTH = 48;
  private static final int MAX_SERIALIZED_ITEMS = 64;
  private static final int MAX_OBJECT_FIELDS = 32;

  private TraceHooks() {}

  public static void emit(String event) {
    \u0073pike.user.TraceHooks.emit(sanitizeJsonNonFiniteNumbers(event));
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
  }

  public static void emitSerializedReturnAtLine(int line, String functionName, String serializedValue) {
    StringBuilder out = new StringBuilder("trace:{\"kind\":\"return\",\"line\":");
    out.append(line).append(",\"function\":").append(jsonString(functionName == null ? "" : functionName));
    if (serializedValue != null) out.append(",\"value\":").append(serializedValue);
    out.append("}");
    emit(out.toString());
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

  public static void emitArrayWriteAtLine(int line, String name, int row, int col, Object value) {
    emitTraceWrite(line, name, "[" + serializeResult(row) + "," + serializeResult(col) + "]", value);
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
    return \u0073pike.user.TraceHooks.serializeResult(value);
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

  public static void emitMutatingCallAtLine(int line, String name, int index, String method) {
    emitTraceMutate(line, name, "[" + serializeResult(index) + "]", method);
  }

  public static void emitKeyedMutatingCallAtLine(int line, String name, String method, Object key) {
    emitTraceMutate(line, name, null, method);
  }

  public static void emitKeyedMutatingCallAtLine(int line, String name, String method, Object key, Object value) {
    emitTraceMutate(line, name, null, method);
  }

  public static <K, V> V readMapAtLine(int line, String name, java.util.Map<K, V> values, K key) {
    V value = values.get(key);
    emitTraceRead(line, name, "[" + serializeResult(key) + "]", value);
    return value;
  }

  public static <K, V> V readFieldMapAtLine(int line, String ownerName, String field, java.util.Map<K, V> values, K key) {
    V value = values.get(key);
    emitTraceRead(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", value);
    return value;
  }

  public static <K, V> V readMapOrDefaultAtLine(int line, String name, java.util.Map<K, V> values, K key, V defaultValue) {
    V value = values.getOrDefault(key, defaultValue);
    emitTraceRead(line, name, "[" + serializeResult(key) + "]", value);
    return value;
  }

  public static <K, V> V readFieldMapOrDefaultAtLine(int line, String ownerName, String field, java.util.Map<K, V> values, K key, V defaultValue) {
    V value = values.getOrDefault(key, defaultValue);
    emitTraceRead(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", value);
    return value;
  }

  public static boolean containsMapKeyAtLine(int line, String name, java.util.Map<?, ?> values, Object key) {
    boolean value = values.containsKey(key);
    emitTraceRead(line, name, "[" + serializeResult(key) + "]", value);
    return value;
  }

  public static boolean containsFieldMapKeyAtLine(int line, String ownerName, String field, java.util.Map<?, ?> values, Object key) {
    boolean value = values.containsKey(key);
    emitTraceRead(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", value);
    return value;
  }

  public static boolean readSetAtLine(int line, String name, java.util.Set<?> values, Object key) {
    boolean value = values.contains(key);
    emitTraceRead(line, name, "[" + serializeResult(key) + "]", value);
    return value;
  }

  public static <K, V> V putMapAtLine(int line, String name, java.util.Map<K, V> values, K key, V value) {
    V previous = values.put(key, value);
    emitTraceWrite(line, name, "[" + serializeResult(key) + "]", values.get(key));
    return previous;
  }

  public static <K, V> V putFieldMapAtLine(int line, String ownerName, String field, java.util.Map<K, V> values, K key, V value) {
    V previous = values.put(key, value);
    emitTraceWrite(line, ownerName, "[" + jsonString(field) + "," + serializeResult(key) + "]", values.get(key));
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

  public static <T> boolean addSetAtLine(int line, String name, java.util.Set<T> values, T key) {
    boolean changed = values.add(key);
    emitTraceMutate(line, name, null, "add");
    return changed;
  }

  public static boolean removeSetAtLine(int line, String name, java.util.Set<?> values, Object key) {
    boolean changed = values.remove(key);
    emitTraceMutate(line, name, null, "remove");
    return changed;
  }

  public static <T> T popListAtLine(int line, String name, java.util.List<T> values, int index) {
    T value = values.remove(index);
    emitTraceMutate(line, name, null, "remove");
    return value;
  }

  public static <T> T readListAtLine(int line, String name, java.util.List<T> values, int index) {
    T value = values.get(index);
    emitTraceRead(line, name, "[" + serializeResult(index) + "]", value);
    return value;
  }

  public static <T> T writeListAtLine(int line, String name, java.util.List<T> values, int index, T value) {
    T previous = values.set(index, value);
    emitTraceWrite(line, name, "[" + serializeResult(index) + "]", values.get(index));
    return previous;
  }

  public static int readIntArrayListAtLine(int line, String name, java.util.List<int[]> values, int index, int elementIndex) {
    int value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static long readLongArrayListAtLine(int line, String name, java.util.List<long[]> values, int index, int elementIndex) {
    long value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static char readCharArrayListAtLine(int line, String name, java.util.List<char[]> values, int index, int elementIndex) {
    char value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static boolean readBooleanArrayListAtLine(int line, String name, java.util.List<boolean[]> values, int index, int elementIndex) {
    boolean value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static double readDoubleArrayListAtLine(int line, String name, java.util.List<double[]> values, int index, int elementIndex) {
    double value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static float readFloatArrayListAtLine(int line, String name, java.util.List<float[]> values, int index, int elementIndex) {
    float value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static byte readByteArrayListAtLine(int line, String name, java.util.List<byte[]> values, int index, int elementIndex) {
    byte value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static short readShortArrayListAtLine(int line, String name, java.util.List<short[]> values, int index, int elementIndex) {
    short value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static <T> T readObjectArrayListAtLine(int line, String name, java.util.List<T[]> values, int index, int elementIndex) {
    T value = values.get(index)[elementIndex];
    emitNestedListArrayRead(line, name, index, elementIndex, value);
    return value;
  }

  public static char readStringCharAtLine(int line, String name, CharSequence value, int index) {
    char result = value.charAt(index);
    emit("trace:{\"kind\":\"read\",\"line\":" + line + ",\"target\":{\"variable\":\"" + name + "\",\"path\":[" + serializeResult(index) + "]},\"value\":" + serializeResult(String.valueOf(result)) + "}");
    return result;
  }

  public static long readLongMatrixAtLine(int line, String name, long[][] values, int row, int col) {
    long value = values[row][col];
    emitMatrixRead(line, name, row, col, value);
    return value;
  }

  public static double readDoubleMatrixAtLine(int line, String name, double[][] values, int row, int col) {
    double value = values[row][col];
    emitMatrixRead(line, name, row, col, value);
    return value;
  }

  public static float readFloatMatrixAtLine(int line, String name, float[][] values, int row, int col) {
    float value = values[row][col];
    emitMatrixRead(line, name, row, col, value);
    return value;
  }

  public static byte readByteMatrixAtLine(int line, String name, byte[][] values, int row, int col) {
    byte value = values[row][col];
    emitMatrixRead(line, name, row, col, value);
    return value;
  }

  public static short readShortMatrixAtLine(int line, String name, short[][] values, int row, int col) {
    short value = values[row][col];
    emitMatrixRead(line, name, row, col, value);
    return value;
  }

  private static void emitMatrixRead(int line, String name, int row, int col, Object value) {
    emit("trace:{\"kind\":\"read\",\"line\":" + line + ",\"target\":{\"variable\":\"" + name + "\",\"path\":[" + serializeResult(row) + "," + serializeResult(col) + "]},\"value\":" + serializeResult(value) + "}");
  }

  private static void emitNestedListArrayRead(int line, String name, int index, int elementIndex, Object value) {
    emit("trace:{\"kind\":\"read\",\"line\":" + line + ",\"target\":{\"variable\":\"" + name + "\",\"path\":[" + serializeResult(index) + "," + serializeResult(elementIndex) + "]},\"value\":" + serializeResult(value) + "}");
  }

  private static void emitTraceRead(int line, String name, String pathJson, Object value) {
    emit("trace:{\"kind\":\"read\",\"line\":" + line + ",\"target\":{\"variable\":" + jsonString(name) + ",\"path\":" + pathJson + "},\"value\":" + serializeResult(value) + "}");
  }

  private static void emitTraceWrite(int line, String name, String pathJson, Object value) {
    emit("trace:{\"kind\":\"write\",\"line\":" + line + ",\"target\":{\"variable\":" + jsonString(name) + ",\"path\":" + pathJson + "},\"value\":" + serializeResult(value) + "}");
  }

  private static void emitTraceMutate(int line, String name, String pathJson, String method) {
    StringBuilder out = new StringBuilder("trace:{\"kind\":\"mutate\",\"line\":");
    out.append(line).append(",\"target\":{\"variable\":").append(jsonString(name));
    if (pathJson != null) out.append(",\"path\":").append(pathJson);
    out.append("}");
    if (method != null && !method.isEmpty()) out.append(",\"method\":").append(jsonString(method));
    out.append("}");
    emit(out.toString());
  }

  private static final class SnapshotEntry {
    final String name;
    final String value;

    SnapshotEntry(String name, String value) {
      this.name = name;
      this.value = value;
    }
  }
}

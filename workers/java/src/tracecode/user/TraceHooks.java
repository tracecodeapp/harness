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
    return packageName.startsWith("harness.user.");
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

  private static void emitTraceMutate(int line, String name, String pathJson, String method) {
    StringBuilder out = new StringBuilder("trace:{\"kind\":\"mutate\",\"line\":");
    out.append(line).append(",\"target\":{\"variable\":").append(jsonString(name));
    if (pathJson != null) out.append(",\"path\":").append(pathJson);
    out.append("}");
    if (method != null && !method.isEmpty()) out.append(",\"method\":").append(jsonString(method));
    out.append("}");
    emit(out.toString());
  }
}

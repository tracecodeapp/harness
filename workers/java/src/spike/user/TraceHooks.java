package spike.user;

import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Collection;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class TraceHooks {
  private static final int DEFAULT_MAX_EVENTS = 50000;
  private static final List<String> EVENTS = new ArrayList<>();
  private static final IdentityHashMap<Object, String> IDENTITIES = new IdentityHashMap<>();
  private static int nextListIdentityIndex = 0;
  private static int maxEvents = DEFAULT_MAX_EVENTS;
  private static boolean traceLimitExceeded = false;
  private static int droppedEventCount = 0;

  private TraceHooks() {}

  public static void emit(String event) {
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
      registerIdentity(current, "list-" + nextListIdentityIndex++);
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
    emitMapStateAtLine(line, name, values, key);
    return value;
  }

  public static <K, V> V readMapOrDefaultAtLine(int line, String name, Map<K, V> values, K key, V defaultValue) {
    V value = values.getOrDefault(key, defaultValue);
    emitKeyedMutatingCallAtLine(line, name, "get", key);
    emitMapStateAtLine(line, name, values, key);
    return value;
  }

  public static boolean containsMapKeyAtLine(int line, String name, Map<?, ?> values, Object key) {
    boolean value = values.containsKey(key);
    emitKeyedMutatingCallAtLine(line, name, "containsKey", key);
    emitMapStateAtLine(line, name, values, key);
    return value;
  }

  public static <K, V> V writeMapAtLine(int line, String name, Map<K, V> values, K key, V value) {
    V previous = values.put(key, value);
    emitKeyedMutatingCallAtLine(line, name, "put", key, value);
    emitMapStateAtLine(line, name, values, key);
    return previous;
  }

  public static boolean readSetAtLine(int line, String name, Set<?> values, Object key) {
    boolean value = values.contains(key);
    emitKeyedMutatingCallAtLine(line, name, "contains", key);
    emitSetStateAtLine(line, name, values, key);
    return value;
  }

  public static <T> boolean addSetAtLine(int line, String name, Set<T> values, T key) {
    boolean changed = values.add(key);
    emitKeyedMutatingCallAtLine(line, name, "add", key);
    emitSetStateAtLine(line, name, values, key);
    return changed;
  }

  public static boolean removeSetAtLine(int line, String name, Set<?> values, Object key) {
    boolean changed = values.remove(key);
    emitKeyedMutatingCallAtLine(line, name, "remove", key);
    emitSetStateAtLine(line, name, values, null, false, key, true);
    return changed;
  }

  public static void emitKeyedMutatingCallAtLine(int line, String name, String method, Object key) {
    emit("line=" + line + " keyed-call " + name + " method=" + method + " key=" + serializeValue(key));
  }

  public static void emitKeyedMutatingCallAtLine(int line, String name, String method, Object key, Object value) {
    emit("line=" + line + " keyed-call " + name + " method=" + method + " key=" + serializeValue(key)
        + " value=" + serializeValue(value));
  }

  public static void emitMapStateAtLine(int line, String name, Map<?, ?> values) {
    emit("line=" + line + " map-state " + name + "=" + buildMapVisualization(name, values, null, false, null, false));
  }

  public static void emitMapStateAtLine(int line, String name, Map<?, ?> values, Object highlightedKey) {
    emit("line=" + line + " map-state " + name + "=" + buildMapVisualization(name, values, highlightedKey, true, null, false));
  }

  public static void emitSetStateAtLine(int line, String name, Set<?> values) {
    emitSetStateAtLine(line, name, values, null, false, null, false);
  }

  public static void emitSetStateAtLine(int line, String name, Set<?> values, Object highlightedKey) {
    emitSetStateAtLine(line, name, values, highlightedKey, true, null, false);
  }

  public static void emitSetStateAtLine(int line, String name, Set<?> values, Object highlightedKey, Object deletedKey) {
    emitSetStateAtLine(line, name, values, highlightedKey, true, deletedKey, true);
  }

  public static <T> T popListAtLine(int line, String name, List<T> values) {
    T value = values.remove(values.size() - 1);
    emit("line=" + line + " mutate " + name + " method=pop");
    return value;
  }

  public static void emitListStateAtLine(int line, String name, Object value) {
    emit("line=" + line + " state linked-list " + name + "=" + serializeValue(value));
  }

  public static void emitTreeStateAtLine(int line, String name, Object value) {
    emit("line=" + line + " state tree " + name + "=" + serializeValue(value));
  }

  public static void emitGraphAdjacencyStateAtLine(int line, String name, Object value) {
    emit("line=" + line + " state graph-adjacency " + name + "=" + serializeValue(value));
  }

  public static void emitObjectStateAtLine(
    int line,
    String name,
    Object object,
    String className,
    String[] fieldNames,
    Object[] fieldValues,
    String highlightedField
  ) {
    String objectId = identityFor(object);
    if (objectId == null) {
      objectId = "object-" + System.identityHashCode(object);
      registerIdentity(object, objectId);
    }
    StringBuilder builder = new StringBuilder();
    builder.append("{\"name\":").append(jsonString(name));
    builder.append(",\"kind\":\"object\"");
    builder.append(",\"objectClassName\":").append(jsonString(className));
    builder.append(",\"objectId\":").append(jsonString(objectId));
    if (highlightedField != null) {
      builder.append(",\"highlightedKey\":").append(jsonString(highlightedField));
    }
    builder.append(",\"entries\":[");
    for (int index = 0; index < fieldNames.length; index++) {
      if (index > 0) builder.append(',');
      builder.append("{\"key\":").append(jsonString(fieldNames[index]));
      builder.append(",\"value\":").append(serializeValue(fieldValues[index]));
      if (fieldNames[index] != null && fieldNames[index].equals(highlightedField)) {
        builder.append(",\"highlight\":true");
      }
      builder.append('}');
    }
    builder.append("]}");
    emit("line=" + line + " object-state " + name + "=" + builder);
  }

  public static String serializeResult(Object value) {
    return serializeValue(value);
  }

  private static void emitSetStateAtLine(
    int line,
    String name,
    Set<?> values,
    Object highlightedKey,
    boolean hasHighlightedKey,
    Object deletedKey,
    boolean hasDeletedKey
  ) {
    emit("line=" + line + " set-state " + name + "="
        + buildSetVisualization(name, values, highlightedKey, hasHighlightedKey, deletedKey, hasDeletedKey));
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

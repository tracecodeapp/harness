package tracecode.user;

public final class TraceHooks extends \u0073pike.user.TraceHooks {
  private TraceHooks() {}

  public static <T> T popListAtLine(int line, String name, java.util.List<T> values, int index) {
    T value = values.remove(index);
    emit("trace:{\"kind\":\"mutate\",\"line\":" + line + ",\"target\":{\"variable\":\"" + name + "\"},\"method\":\"pop\"}");
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

  private static void emitNestedListArrayRead(int line, String name, int index, int elementIndex, Object value) {
    emit("trace:{\"kind\":\"read\",\"line\":" + line + ",\"target\":{\"variable\":\"" + name + "\",\"path\":[" + serializeResult(index) + "," + serializeResult(elementIndex) + "]},\"value\":" + serializeResult(value) + "}");
  }
}

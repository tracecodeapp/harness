package tracecode.user;

/**
 * Native latin1 text-assembly primitives provided by TraceJVM (bjvm
 * {@code natives/share/tracecode/user/TextOps.c}). On a stock JVM the first
 * call throws {@link UnsatisfiedLinkError} and {@link #AVAILABLE} pins every
 * caller to pure-Java paths. Each native returns {@code null} for any input
 * it will not handle byte-identically, and callers must fall back.
 */
final class TextOps {
  private TextOps() {}

  static native String jsonIntArray0(int[] values, int emitted, int total);

  static native String jsonLongArray0(long[] values, int emitted, int total);

  static native String jsonScalar0(Object value);

  static native String jsonEscape0(String value);

  static native String buildRecord0(
      String header,
      int line,
      String name,
      String pathJson,
      String indexSourcesJson,
      String valueJson,
      String functionName,
      String stackSuffix);

  static native String buildIndexedRecord0(
      String header,
      int line,
      String name,
      int index,
      String indexSourcesJson,
      String valueJson,
      String stackSuffix);

  static native byte[] encodeLinesUtf8(String[] lines, int count);

  static final boolean AVAILABLE = probe();

  private static boolean probe() {
    try {
      return "[]".equals(jsonIntArray0(new int[0], 0, 0));
    } catch (Throwable error) {
      return false;
    }
  }
}

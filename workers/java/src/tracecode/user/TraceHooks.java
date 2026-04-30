package tracecode.user;

public final class TraceHooks extends \u0073pike.user.TraceHooks {
  private TraceHooks() {}

  public static <T> T popListAtLine(int line, String name, java.util.List<T> values, int index) {
    T value = values.remove(index);
    emit("trace:{\"kind\":\"mutate\",\"line\":" + line + ",\"target\":{\"variable\":\"" + name + "\"},\"method\":\"pop\"}");
    return value;
  }
}

package tracecode.browser;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public final class ProjectEvents {
  private static final ThreadLocal<Boolean> PROJECT_EVENT_BRIDGE_ENABLED =
      ThreadLocal.withInitial(() -> Boolean.FALSE);

  private ProjectEvents() {}

  public static void setProjectEventBridgeEnabled(boolean enabled) {
    PROJECT_EVENT_BRIDGE_ENABLED.set(enabled);
  }

  public static OutputStream streamingOutput(ByteArrayOutputStream capture, String stream) {
    return new StreamingProjectOutputStream(capture, stream);
  }

  private static void emitOutput(String stream, String data) {
    if (!PROJECT_EVENT_BRIDGE_ENABLED.get() || data.isEmpty()) return;
    try {
      emitOutputNative(stream, data);
    } catch (UnsatisfiedLinkError | SecurityException ignored) {
      // Host JVM tests and older browser runtimes may not expose the CheerpJ native bridge.
    }
  }

  private static native void emitOutputNative(String stream, String data);

  private static final class StreamingProjectOutputStream extends OutputStream {
    private final ByteArrayOutputStream capture;
    private final String stream;
    private final ByteArrayOutputStream pending = new ByteArrayOutputStream();

    StreamingProjectOutputStream(ByteArrayOutputStream capture, String stream) {
      this.capture = capture;
      this.stream = stream;
    }

    @Override
    public void write(int value) throws IOException {
      capture.write(value);
      pending.write(value);
    }

    @Override
    public void write(byte[] bytes, int offset, int length) throws IOException {
      capture.write(bytes, offset, length);
      pending.write(bytes, offset, length);
    }

    @Override
    public void flush() throws IOException {
      if (pending.size() == 0) return;
      emitOutput(stream, pending.toString(StandardCharsets.UTF_8.name()));
      pending.reset();
    }

    @Override
    public void close() throws IOException {
      flush();
    }
  }
}

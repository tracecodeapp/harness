package tracecode.browser;

import java.io.ByteArrayOutputStream;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.charset.Charset;
import java.nio.file.CopyOption;
import java.nio.file.Files;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

public final class ProjectEvents {
  private static final ThreadLocal<Boolean> PROJECT_EVENT_BRIDGE_ENABLED =
      ThreadLocal.withInitial(() -> Boolean.FALSE);
  private static final ThreadLocal<Path> PROJECT_WORKSPACE_ROOT = new ThreadLocal<>();
  private static final ThreadLocal<Map<String, KernelDevice>> KERNEL_DEVICES =
      ThreadLocal.withInitial(HashMap::new);
  private static final ThreadLocal<byte[]> KERNEL_STDIN =
      ThreadLocal.withInitial(() -> new byte[0]);
  private static final ThreadLocal<ByteArrayOutputStream> STDOUT_CAPTURE = new ThreadLocal<>();
  private static final ThreadLocal<ByteArrayOutputStream> STDERR_CAPTURE = new ThreadLocal<>();

  private ProjectEvents() {}

  public static void setProjectEventBridgeEnabled(boolean enabled) {
    PROJECT_EVENT_BRIDGE_ENABLED.set(enabled);
  }

  public static void setProjectWorkspaceRoot(Path root) {
    PROJECT_WORKSPACE_ROOT.set(root == null ? null : root.toAbsolutePath().normalize());
  }

  public static void setKernelDevices(String manifest, String stdin) {
    KERNEL_DEVICES.set(parseKernelDevices(manifest));
    KERNEL_STDIN.set(stdin == null ? new byte[0] : stdin.getBytes(StandardCharsets.UTF_8));
  }

  public static void clearKernelDevices() {
    KERNEL_DEVICES.remove();
    KERNEL_STDIN.remove();
    STDOUT_CAPTURE.remove();
    STDERR_CAPTURE.remove();
  }

  public static OutputStream streamingOutput(ByteArrayOutputStream capture, String stream) {
    if ("stderr".equals(stream)) {
      STDERR_CAPTURE.set(capture);
    } else {
      STDOUT_CAPTURE.set(capture);
    }
    return new StreamingProjectOutputStream(capture, stream);
  }

  public static String readString(Path path) throws IOException {
    KernelDevice device = readableKernelDevice(path);
    if (device != null) return new String(readKernelDevice(device), StandardCharsets.UTF_8);
    return Files.readString(path);
  }

  public static String readString(Path path, Charset charset) throws IOException {
    KernelDevice device = readableKernelDevice(path);
    if (device != null) return new String(readKernelDevice(device), charset);
    return Files.readString(path, charset);
  }

  public static byte[] readAllBytes(Path path) throws IOException {
    KernelDevice device = readableKernelDevice(path);
    if (device != null) return readKernelDevice(device);
    return Files.readAllBytes(path);
  }

  public static Path writeString(Path path, CharSequence contents, OpenOption... options) throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) {
      writeKernelDevice(device, String.valueOf(contents).getBytes(StandardCharsets.UTF_8));
      return path;
    }
    assertWritableProjectPath(path);
    Path result = Files.writeString(path, contents, options);
    emitFileSnapshot(path);
    return result;
  }

  public static Path writeString(Path path, CharSequence contents, java.nio.charset.Charset charset, OpenOption... options)
      throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) {
      writeKernelDevice(device, String.valueOf(contents).getBytes(charset));
      return path;
    }
    assertWritableProjectPath(path);
    Path result = Files.writeString(path, contents, charset, options);
    emitFileSnapshot(path);
    return result;
  }

  public static Path write(Path path, byte[] bytes, OpenOption... options) throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) {
      writeKernelDevice(device, bytes);
      return path;
    }
    assertWritableProjectPath(path);
    Path result = Files.write(path, bytes, options);
    emitFileSnapshot(path);
    return result;
  }

  public static Path write(Path path, Iterable<? extends CharSequence> lines, OpenOption... options)
      throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) {
      StringBuilder contents = new StringBuilder();
      for (CharSequence line : lines) contents.append(line).append(System.lineSeparator());
      writeKernelDevice(device, contents.toString().getBytes(StandardCharsets.UTF_8));
      return path;
    }
    assertWritableProjectPath(path);
    Path result = Files.write(path, lines, options);
    emitFileSnapshot(path);
    return result;
  }

  public static Path write(
      Path path,
      Iterable<? extends CharSequence> lines,
      java.nio.charset.Charset charset,
      OpenOption... options
  ) throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) {
      StringBuilder contents = new StringBuilder();
      for (CharSequence line : lines) contents.append(line).append(System.lineSeparator());
      writeKernelDevice(device, contents.toString().getBytes(charset));
      return path;
    }
    assertWritableProjectPath(path);
    Path result = Files.write(path, lines, charset, options);
    emitFileSnapshot(path);
    return result;
  }

  public static void delete(Path path) throws IOException {
    assertWritableProjectPath(path);
    Files.delete(path);
    emitFileDelete(path);
  }

  public static boolean deleteIfExists(Path path) throws IOException {
    assertWritableProjectPath(path);
    boolean deleted = Files.deleteIfExists(path);
    if (deleted) emitFileDelete(path);
    return deleted;
  }

  public static Path copy(Path source, Path target, CopyOption... options) throws IOException {
    assertWritableProjectPath(target);
    Path result = Files.copy(source, target, options);
    emitFileSnapshot(target);
    return result;
  }

  public static Path move(Path source, Path target, CopyOption... options) throws IOException {
    assertWritableProjectPath(source);
    assertWritableProjectPath(target);
    Path result = Files.move(source, target, options);
    emitFileDelete(source);
    emitFileSnapshot(target);
    return result;
  }

  public static OutputStream newOutputStream(Path path, OpenOption... options) throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) return new KernelDeviceOutputStream(device);
    assertWritableProjectPath(path);
    return new ProjectOutputStream(Files.newOutputStream(path, options), path);
  }

  public static BufferedWriter newBufferedWriter(Path path, OpenOption... options) throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) {
      return new BufferedWriter(new OutputStreamWriter(new KernelDeviceOutputStream(device), StandardCharsets.UTF_8));
    }
    assertWritableProjectPath(path);
    return new ProjectBufferedWriter(Files.newBufferedWriter(path, options), path);
  }

  public static BufferedWriter newBufferedWriter(Path path, Charset charset, OpenOption... options) throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) {
      return new BufferedWriter(new OutputStreamWriter(new KernelDeviceOutputStream(device), charset));
    }
    assertWritableProjectPath(path);
    return new ProjectBufferedWriter(Files.newBufferedWriter(path, charset, options), path);
  }

  public static final class ProjectFileWriter extends FileWriter {
    private final Path path;

    public ProjectFileWriter(String fileName) throws IOException {
      super(writableFileName(fileName));
      this.path = Path.of(fileName);
    }

    public ProjectFileWriter(String fileName, boolean append) throws IOException {
      super(writableFileName(fileName), append);
      this.path = Path.of(fileName);
    }

    public ProjectFileWriter(String fileName, Charset charset) throws IOException {
      super(writableFileName(fileName), charset);
      this.path = Path.of(fileName);
    }

    public ProjectFileWriter(String fileName, Charset charset, boolean append) throws IOException {
      super(writableFileName(fileName), charset, append);
      this.path = Path.of(fileName);
    }

    public ProjectFileWriter(File file) throws IOException {
      super(writableFile(file));
      this.path = file.toPath();
    }

    public ProjectFileWriter(File file, boolean append) throws IOException {
      super(writableFile(file), append);
      this.path = file.toPath();
    }

    public ProjectFileWriter(File file, Charset charset) throws IOException {
      super(writableFile(file), charset);
      this.path = file.toPath();
    }

    public ProjectFileWriter(File file, Charset charset, boolean append) throws IOException {
      super(writableFile(file), charset, append);
      this.path = file.toPath();
    }

    @Override
    public void flush() throws IOException {
      super.flush();
      emitFileSnapshot(path);
    }

    @Override
    public void close() throws IOException {
      super.close();
      emitFileSnapshot(path);
    }
  }

  public static final class ProjectFileOutputStream extends FileOutputStream {
    private final Path path;
    private final KernelDevice device;

    public ProjectFileOutputStream(String name) throws IOException {
      super(outputFileTarget(Path.of(name)));
      this.path = Path.of(name);
      this.device = kernelDevice(this.path);
    }

    public ProjectFileOutputStream(String name, boolean append) throws IOException {
      super(outputFileTarget(Path.of(name)), append);
      this.path = Path.of(name);
      this.device = kernelDevice(this.path);
    }

    public ProjectFileOutputStream(File file) throws IOException {
      super(outputFileTarget(file == null ? null : file.toPath()));
      this.path = file.toPath();
      this.device = kernelDevice(this.path);
    }

    public ProjectFileOutputStream(File file, boolean append) throws IOException {
      super(outputFileTarget(file == null ? null : file.toPath()), append);
      this.path = file.toPath();
      this.device = kernelDevice(this.path);
    }

    public ProjectFileOutputStream(FileDescriptor fdObj) {
      super(fdObj);
      this.path = null;
      this.device = null;
    }

    @Override
    public void write(int value) throws IOException {
      if (device != null) {
        writeKernelDevice(device, new byte[] { (byte) value });
        return;
      }
      super.write(value);
    }

    @Override
    public void write(byte[] bytes) throws IOException {
      if (device != null) {
        writeKernelDevice(device, bytes);
        return;
      }
      super.write(bytes);
    }

    @Override
    public void write(byte[] bytes, int offset, int length) throws IOException {
      if (device != null) {
        byte[] chunk = new byte[length];
        System.arraycopy(bytes, offset, chunk, 0, length);
        writeKernelDevice(device, chunk);
        return;
      }
      super.write(bytes, offset, length);
    }

    @Override
    public void flush() throws IOException {
      if (device != null) return;
      super.flush();
      emitFileSnapshot(path);
    }

    @Override
    public void close() throws IOException {
      if (device != null) {
        super.close();
        return;
      }
      super.close();
      emitFileSnapshot(path);
    }
  }

  public static final class ProjectFileInputStream extends FileInputStream {
    private final Path path;
    private final byte[] deviceBytes;
    private int deviceOffset = 0;

    public ProjectFileInputStream(String name) throws IOException {
      super(inputFileTarget(Path.of(name)));
      this.path = Path.of(name);
      this.deviceBytes = kernelInputBytes(this.path);
    }

    public ProjectFileInputStream(File file) throws IOException {
      super(inputFileTarget(file == null ? null : file.toPath()));
      this.path = file.toPath();
      this.deviceBytes = kernelInputBytes(this.path);
    }

    public ProjectFileInputStream(FileDescriptor fdObj) {
      super(fdObj);
      this.path = null;
      this.deviceBytes = null;
    }

    @Override
    public int read() throws IOException {
      if (deviceBytes == null) return super.read();
      if (deviceOffset >= deviceBytes.length) return -1;
      return deviceBytes[deviceOffset++] & 0xff;
    }

    @Override
    public int read(byte[] bytes) throws IOException {
      return read(bytes, 0, bytes.length);
    }

    @Override
    public int read(byte[] bytes, int offset, int length) throws IOException {
      if (deviceBytes == null) return super.read(bytes, offset, length);
      if (length == 0) return 0;
      if (deviceOffset >= deviceBytes.length) return -1;
      int count = Math.min(length, deviceBytes.length - deviceOffset);
      System.arraycopy(deviceBytes, deviceOffset, bytes, offset, count);
      deviceOffset += count;
      return count;
    }

    @Override
    public long skip(long count) throws IOException {
      if (deviceBytes == null) return super.skip(count);
      if (count <= 0) return 0;
      long skipped = Math.min(count, deviceBytes.length - deviceOffset);
      deviceOffset += (int) skipped;
      return skipped;
    }

    @Override
    public int available() throws IOException {
      if (deviceBytes == null) return super.available();
      return deviceBytes.length - deviceOffset;
    }
  }

  private static final class ProjectOutputStream extends OutputStream {
    private final OutputStream delegate;
    private final Path path;

    ProjectOutputStream(OutputStream delegate, Path path) {
      this.delegate = delegate;
      this.path = path;
    }

    @Override
    public void write(int value) throws IOException {
      delegate.write(value);
    }

    @Override
    public void write(byte[] bytes) throws IOException {
      delegate.write(bytes);
    }

    @Override
    public void write(byte[] bytes, int offset, int length) throws IOException {
      delegate.write(bytes, offset, length);
    }

    @Override
    public void flush() throws IOException {
      delegate.flush();
      emitFileSnapshot(path);
    }

    @Override
    public void close() throws IOException {
      delegate.close();
      emitFileSnapshot(path);
    }
  }

  private static final class ProjectBufferedWriter extends BufferedWriter {
    private final Path path;

    ProjectBufferedWriter(Writer delegate, Path path) {
      super(delegate);
      this.path = path;
    }

    @Override
    public void flush() throws IOException {
      super.flush();
      emitFileSnapshot(path);
    }

    @Override
    public void close() throws IOException {
      super.close();
      emitFileSnapshot(path);
    }
  }

  public static final class ProjectPrintWriter extends PrintWriter {
    private final Path path;

    public ProjectPrintWriter(String fileName) throws IOException {
      super(writableFileName(fileName));
      this.path = Path.of(fileName);
    }

    public ProjectPrintWriter(String fileName, String charsetName) throws IOException {
      super(writableFileName(fileName), charsetName);
      this.path = Path.of(fileName);
    }

    public ProjectPrintWriter(String fileName, Charset charset) throws IOException {
      super(writableFileName(fileName), charset);
      this.path = Path.of(fileName);
    }

    public ProjectPrintWriter(File file) throws IOException {
      super(writableFile(file));
      this.path = file.toPath();
    }

    public ProjectPrintWriter(File file, String charsetName) throws IOException {
      super(writableFile(file), charsetName);
      this.path = file.toPath();
    }

    public ProjectPrintWriter(File file, Charset charset) throws IOException {
      super(writableFile(file), charset);
      this.path = file.toPath();
    }

    public ProjectPrintWriter(OutputStream out) {
      super(out);
      this.path = null;
    }

    public ProjectPrintWriter(OutputStream out, boolean autoFlush) {
      super(out, autoFlush);
      this.path = null;
    }

    public ProjectPrintWriter(OutputStream out, boolean autoFlush, Charset charset) {
      super(out, autoFlush, charset);
      this.path = null;
    }

    public ProjectPrintWriter(Writer out) {
      super(out);
      this.path = null;
    }

    public ProjectPrintWriter(Writer out, boolean autoFlush) {
      super(out, autoFlush);
      this.path = null;
    }

    @Override
    public void flush() {
      super.flush();
      emitFileSnapshot(path);
    }

    @Override
    public void close() {
      super.close();
      emitFileSnapshot(path);
    }
  }

  public static final class ProjectPrintStream extends PrintStream {
    public ProjectPrintStream(String fileName) throws IOException {
      super(printStreamOutput(Path.of(fileName)));
    }

    public ProjectPrintStream(String fileName, String charsetName) throws IOException {
      super(printStreamOutput(Path.of(fileName)), false, charsetName);
    }

    public ProjectPrintStream(String fileName, Charset charset) throws IOException {
      super(printStreamOutput(Path.of(fileName)), false, charset);
    }

    public ProjectPrintStream(File file) throws IOException {
      super(printStreamOutput(file == null ? null : file.toPath()));
    }

    public ProjectPrintStream(File file, String charsetName) throws IOException {
      super(printStreamOutput(file == null ? null : file.toPath()), false, charsetName);
    }

    public ProjectPrintStream(File file, Charset charset) throws IOException {
      super(printStreamOutput(file == null ? null : file.toPath()), false, charset);
    }

    public ProjectPrintStream(OutputStream out) {
      super(out);
    }

    public ProjectPrintStream(OutputStream out, boolean autoFlush) {
      super(out, autoFlush);
    }

    public ProjectPrintStream(OutputStream out, boolean autoFlush, String charsetName)
        throws java.io.UnsupportedEncodingException {
      super(out, autoFlush, charsetName);
    }

    public ProjectPrintStream(OutputStream out, boolean autoFlush, Charset charset) {
      super(out, autoFlush, charset);
    }
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
  private static native void emitFileSnapshotNative(String path, String contents);
  private static native void emitFileDeleteNative(String path);

  private static Map<String, KernelDevice> parseKernelDevices(String manifest) {
    Map<String, KernelDevice> devices = new HashMap<>();
    if (manifest == null || manifest.isEmpty()) return devices;
    String[] lines = manifest.split("\\n");
    for (String line : lines) {
      if (line.isEmpty()) continue;
      String[] fields = line.split("\\t", -1);
      if (fields.length < 5) continue;
      String path = decodeManifestField(fields[0]);
      if (!path.startsWith("/dev/")) continue;
      devices.put(path, new KernelDevice(
          path,
          "1".equals(decodeManifestField(fields[1])),
          "1".equals(decodeManifestField(fields[2])),
          decodeManifestField(fields[3]),
          decodeManifestField(fields[4])));
    }
    return devices;
  }

  private static String decodeManifestField(String field) {
    return new String(Base64.getDecoder().decode(field), StandardCharsets.UTF_8);
  }

  private static KernelDevice readableKernelDevice(Path path) throws IOException {
    KernelDevice device = kernelDevice(path);
    if (device == null) return null;
    if (!device.readable) throw new IOException("Kernel device is not readable: " + device.path);
    return device;
  }

  private static KernelDevice writableKernelDevice(Path path) throws IOException {
    KernelDevice device = kernelDevice(path);
    if (device == null) return null;
    if (!device.writable) throw new IOException("Kernel device is not writable: " + device.path);
    return device;
  }

  private static KernelDevice kernelDevice(Path path) {
    if (path == null) return null;
    String normalized = path.toString().replace('\\', '/');
    if (!normalized.startsWith("/dev/")) return null;
    return KERNEL_DEVICES.get().get(normalized);
  }

  private static byte[] readKernelDevice(KernelDevice device) {
    String inputDevice = device.inputDevice.isEmpty() ? device.path : device.inputDevice;
    if (!"/dev/stdin".equals(inputDevice) && !"/dev/tty".equals(device.path)) return new byte[0];
    return KERNEL_STDIN.get();
  }

  private static void writeKernelDevice(KernelDevice device, byte[] bytes) {
    String outputDevice = device.outputDevice.isEmpty() ? device.path : device.outputDevice;
    String stream = "/dev/stderr".equals(outputDevice) ? "stderr" : "stdout";
    ByteArrayOutputStream capture = "stderr".equals(stream) ? STDERR_CAPTURE.get() : STDOUT_CAPTURE.get();
    if (capture != null) {
      capture.write(bytes, 0, bytes.length);
    }
    emitOutput(stream, new String(bytes, StandardCharsets.UTF_8));
  }

  private static final class KernelDevice {
    final String path;
    final boolean readable;
    final boolean writable;
    final String inputDevice;
    final String outputDevice;

    KernelDevice(String path, boolean readable, boolean writable, String inputDevice, String outputDevice) {
      this.path = path;
      this.readable = readable;
      this.writable = writable;
      this.inputDevice = inputDevice == null ? "" : inputDevice;
      this.outputDevice = outputDevice == null ? "" : outputDevice;
    }
  }

  private static final class KernelDeviceOutputStream extends OutputStream {
    private final KernelDevice device;

    KernelDeviceOutputStream(KernelDevice device) {
      this.device = device;
    }

    @Override
    public void write(int value) {
      writeKernelDevice(device, new byte[] { (byte) value });
    }

    @Override
    public void write(byte[] bytes, int offset, int length) {
      byte[] chunk = new byte[length];
      System.arraycopy(bytes, offset, chunk, 0, length);
      writeKernelDevice(device, chunk);
    }
  }

  private static String writableFileName(String fileName) throws IOException {
    assertWritableProjectPath(Path.of(fileName));
    return fileName;
  }

  private static File writableFile(File file) throws IOException {
    assertWritableProjectPath(file == null ? null : file.toPath());
    return file;
  }

  private static File outputFileTarget(Path path) throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) return temporaryDeviceFile();
    assertWritableProjectPath(path);
    return path.toFile();
  }

  private static File inputFileTarget(Path path) throws IOException {
    KernelDevice device = readableKernelDevice(path);
    if (device != null) return temporaryDeviceFile();
    return path.toFile();
  }

  private static byte[] kernelInputBytes(Path path) throws IOException {
    KernelDevice device = readableKernelDevice(path);
    return device == null ? null : readKernelDevice(device);
  }

  private static OutputStream printStreamOutput(Path path) throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) return new KernelDeviceOutputStream(device);
    assertWritableProjectPath(path);
    return new ProjectOutputStream(new FileOutputStream(path.toFile()), path);
  }

  private static File temporaryDeviceFile() throws IOException {
    File file = File.createTempFile("tracecode-device-", ".tmp");
    file.deleteOnExit();
    return file;
  }

  private static void assertWritableProjectPath(Path path) throws IOException {
    if (isKernelReadOnlyPath(path)) {
      throw new IOException("Read-only kernel virtual path: " + path);
    }
  }

  private static boolean isKernelReadOnlyPath(Path path) {
    if (path == null) return false;
    String normalized = path.toString().replace('\\', '/');
    return normalized.equals("/proc") || normalized.startsWith("/proc/");
  }

  private static void emitFileSnapshot(Path path) {
    if (!PROJECT_EVENT_BRIDGE_ENABLED.get()) return;
    String relativePath = projectRelativePath(path);
    if (relativePath == null) return;
    try {
      emitFileSnapshotNative(relativePath, Base64.getEncoder().encodeToString(Files.readAllBytes(path)));
    } catch (UnsatisfiedLinkError | SecurityException | IOException ignored) {
      // Final-diff persistence still captures writes when live browser bridge emission is unavailable.
    }
  }

  private static void emitFileDelete(Path path) {
    if (!PROJECT_EVENT_BRIDGE_ENABLED.get()) return;
    String relativePath = projectRelativePath(path);
    if (relativePath == null) return;
    try {
      emitFileDeleteNative(relativePath);
    } catch (UnsatisfiedLinkError | SecurityException ignored) {
      // Final-diff persistence still captures deletes when live browser bridge emission is unavailable.
    }
  }

  private static String projectRelativePath(Path path) {
    Path root = PROJECT_WORKSPACE_ROOT.get();
    if (root == null || path == null) return null;
    Path absolute = path.toAbsolutePath().normalize();
    if (!absolute.startsWith(root)) return null;
    Path relative = root.relativize(absolute);
    if (relative.getNameCount() == 0) return null;
    return relative.toString().replace('\\', '/');
  }

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

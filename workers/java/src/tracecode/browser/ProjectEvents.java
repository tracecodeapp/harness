package tracecode.browser;

import java.io.ByteArrayOutputStream;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.charset.Charset;
import java.nio.file.CopyOption;
import java.nio.file.Files;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.util.Base64;

public final class ProjectEvents {
  private static final ThreadLocal<Boolean> PROJECT_EVENT_BRIDGE_ENABLED =
      ThreadLocal.withInitial(() -> Boolean.FALSE);
  private static final ThreadLocal<Path> PROJECT_WORKSPACE_ROOT = new ThreadLocal<>();

  private ProjectEvents() {}

  public static void setProjectEventBridgeEnabled(boolean enabled) {
    PROJECT_EVENT_BRIDGE_ENABLED.set(enabled);
  }

  public static void setProjectWorkspaceRoot(Path root) {
    PROJECT_WORKSPACE_ROOT.set(root == null ? null : root.toAbsolutePath().normalize());
  }

  public static OutputStream streamingOutput(ByteArrayOutputStream capture, String stream) {
    return new StreamingProjectOutputStream(capture, stream);
  }

  public static Path writeString(Path path, CharSequence contents, OpenOption... options) throws IOException {
    assertWritableProjectPath(path);
    Path result = Files.writeString(path, contents, options);
    emitFileSnapshot(path);
    return result;
  }

  public static Path writeString(Path path, CharSequence contents, java.nio.charset.Charset charset, OpenOption... options)
      throws IOException {
    assertWritableProjectPath(path);
    Path result = Files.writeString(path, contents, charset, options);
    emitFileSnapshot(path);
    return result;
  }

  public static Path write(Path path, byte[] bytes, OpenOption... options) throws IOException {
    assertWritableProjectPath(path);
    Path result = Files.write(path, bytes, options);
    emitFileSnapshot(path);
    return result;
  }

  public static Path write(Path path, Iterable<? extends CharSequence> lines, OpenOption... options)
      throws IOException {
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
    assertWritableProjectPath(path);
    return new ProjectOutputStream(Files.newOutputStream(path, options), path);
  }

  public static BufferedWriter newBufferedWriter(Path path, OpenOption... options) throws IOException {
    assertWritableProjectPath(path);
    return new ProjectBufferedWriter(Files.newBufferedWriter(path, options), path);
  }

  public static BufferedWriter newBufferedWriter(Path path, Charset charset, OpenOption... options) throws IOException {
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

    public ProjectFileOutputStream(String name) throws IOException {
      super(writableFileName(name));
      this.path = Path.of(name);
    }

    public ProjectFileOutputStream(String name, boolean append) throws IOException {
      super(writableFileName(name), append);
      this.path = Path.of(name);
    }

    public ProjectFileOutputStream(File file) throws IOException {
      super(writableFile(file));
      this.path = file.toPath();
    }

    public ProjectFileOutputStream(File file, boolean append) throws IOException {
      super(writableFile(file), append);
      this.path = file.toPath();
    }

    public ProjectFileOutputStream(FileDescriptor fdObj) {
      super(fdObj);
      this.path = null;
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

  private static String writableFileName(String fileName) throws IOException {
    assertWritableProjectPath(Path.of(fileName));
    return fileName;
  }

  private static File writableFile(File file) throws IOException {
    assertWritableProjectPath(file == null ? null : file.toPath());
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

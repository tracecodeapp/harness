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
import java.io.RandomAccessFile;
import java.io.Writer;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.charset.Charset;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.file.CopyOption;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.NotDirectoryException;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.FileAttribute;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

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

  public static Stream<Path> list(Path path) throws IOException {
    String normalized = normalizeVirtualPath(path);
    if (isVirtualDeviceDirectory(normalized)) {
      return kernelDevicePaths().stream();
    }
    if (isVirtualDevicePath(normalized)) throwKernelDeviceNotDirectory(normalized);
    return Files.list(path);
  }

  public static DirectoryStream<Path> newDirectoryStream(Path dir) throws IOException {
    String normalized = normalizeVirtualPath(dir);
    if (isVirtualDeviceDirectory(normalized)) return new KernelDirectoryStream(kernelDevicePaths());
    if (isVirtualDevicePath(normalized)) throwKernelDeviceNotDirectory(normalized);
    return Files.newDirectoryStream(dir);
  }

  public static DirectoryStream<Path> newDirectoryStream(Path dir, String glob) throws IOException {
    String normalized = normalizeVirtualPath(dir);
    if (isVirtualDeviceDirectory(normalized)) {
      DirectoryStream.Filter<Path> filter = (entry) -> dir.getFileSystem()
          .getPathMatcher("glob:" + glob)
          .matches(entry.getFileName());
      return newDirectoryStream(dir, filter);
    }
    if (isVirtualDevicePath(normalized)) throwKernelDeviceNotDirectory(normalized);
    return Files.newDirectoryStream(dir, glob);
  }

  public static DirectoryStream<Path> newDirectoryStream(Path dir, DirectoryStream.Filter<? super Path> filter)
      throws IOException {
    String normalized = normalizeVirtualPath(dir);
    if (isVirtualDeviceDirectory(normalized)) {
      ArrayList<Path> entries = new ArrayList<>();
      for (Path entry : kernelDevicePaths()) {
        if (filter == null || filter.accept(entry)) entries.add(entry);
      }
      return new KernelDirectoryStream(entries);
    }
    if (isVirtualDevicePath(normalized)) throwKernelDeviceNotDirectory(normalized);
    return Files.newDirectoryStream(dir, filter);
  }

  public static boolean exists(Path path, LinkOption... options) {
    String normalized = normalizeVirtualPath(path);
    if (isVirtualDeviceDirectory(normalized)) return true;
    if (isVirtualDevicePath(normalized)) return KERNEL_DEVICES.get().containsKey(normalized);
    return Files.exists(path, options);
  }

  public static boolean notExists(Path path, LinkOption... options) {
    String normalized = normalizeVirtualPath(path);
    if (isVirtualDeviceNamespacePath(normalized)) {
      return !exists(path, options);
    }
    return Files.notExists(path, options);
  }

  public static boolean isDirectory(Path path, LinkOption... options) {
    String normalized = normalizeVirtualPath(path);
    if (isVirtualDeviceDirectory(normalized)) return true;
    if (isVirtualDevicePath(normalized)) return false;
    return Files.isDirectory(path, options);
  }

  public static boolean isRegularFile(Path path, LinkOption... options) {
    String normalized = normalizeVirtualPath(path);
    if (isVirtualDeviceDirectory(normalized)) return false;
    if (isVirtualDevicePath(normalized)) return KERNEL_DEVICES.get().containsKey(normalized);
    return Files.isRegularFile(path, options);
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

  public static Path createFile(Path path, FileAttribute<?>... attrs) throws IOException {
    assertWritableProjectPath(path);
    Path result = Files.createFile(path, attrs);
    emitFileSnapshot(path);
    return result;
  }

  public static Path createDirectory(Path dir, FileAttribute<?>... attrs) throws IOException {
    assertWritableProjectPath(dir);
    Path result = Files.createDirectory(dir, attrs);
    emitDirectoryCreate(dir);
    return result;
  }

  public static Path createDirectories(Path dir, FileAttribute<?>... attrs) throws IOException {
    assertWritableProjectPath(dir);
    List<Path> missing = missingDirectories(dir);
    Path result = Files.createDirectories(dir, attrs);
    for (Path created : missing) {
      if (Files.isDirectory(created)) emitDirectoryCreate(created);
    }
    return result;
  }

  public static void delete(Path path) throws IOException {
    assertWritableProjectPath(path);
    boolean directory = Files.isDirectory(path);
    Files.delete(path);
    if (directory) {
      emitDirectoryDelete(path);
    } else {
      emitFileDelete(path);
    }
  }

  public static boolean deleteIfExists(Path path) throws IOException {
    assertWritableProjectPath(path);
    boolean directory = Files.isDirectory(path);
    boolean deleted = Files.deleteIfExists(path);
    if (deleted) {
      if (directory) {
        emitDirectoryDelete(path);
      } else {
        emitFileDelete(path);
      }
    }
    return deleted;
  }

  public static Path copy(Path source, Path target, CopyOption... options) throws IOException {
    KernelDevice sourceDevice = readableKernelDevice(source);
    KernelDevice targetDevice = writableKernelDevice(target);
    if (targetDevice != null) {
      byte[] bytes = sourceDevice != null ? readKernelDevice(sourceDevice) : Files.readAllBytes(source);
      writeKernelDevice(targetDevice, bytes);
      return target;
    }
    assertWritableProjectPath(target);
    if (sourceDevice != null) {
      Files.write(target, readKernelDevice(sourceDevice));
      emitFileSnapshot(target);
      return target;
    }
    boolean directory = Files.isDirectory(source);
    Path result = Files.copy(source, target, options);
    if (directory) {
      emitDirectoryCreate(target);
    } else {
      emitFileSnapshot(target);
    }
    return result;
  }

  public static Path move(Path source, Path target, CopyOption... options) throws IOException {
    assertWritableProjectPath(source);
    assertWritableProjectPath(target);
    boolean directory = Files.isDirectory(source);
    Path result = Files.move(source, target, options);
    if (directory) {
      emitDirectoryDelete(source);
      emitDirectoryCreate(target);
    } else {
      emitFileDelete(source);
      emitFileSnapshot(target);
    }
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

  public static SeekableByteChannel newByteChannel(Path path, OpenOption... options) throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) return new KernelDeviceByteChannel(device);
    boolean writable = byteChannelCanWrite(options);
    if (writable) assertWritableProjectPath(path);
    return new ProjectSeekableByteChannel(Files.newByteChannel(path, options), path, writable);
  }

  public static SeekableByteChannel newByteChannel(
      Path path,
      Set<? extends OpenOption> options,
      FileAttribute<?>... attrs
  ) throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) return new KernelDeviceByteChannel(device);
    boolean writable = byteChannelCanWrite(options == null ? null : options.toArray(new OpenOption[0]));
    if (writable) assertWritableProjectPath(path);
    return new ProjectSeekableByteChannel(Files.newByteChannel(path, options, attrs), path, writable);
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

    private void emitAfterWrite() throws IOException {
      super.flush();
      emitFileSnapshot(path);
    }

    @Override
    public void write(int value) throws IOException {
      super.write(value);
      emitAfterWrite();
    }

    @Override
    public void write(char[] chars, int offset, int length) throws IOException {
      super.write(chars, offset, length);
      emitAfterWrite();
    }

    @Override
    public void write(String text, int offset, int length) throws IOException {
      super.write(text, offset, length);
      emitAfterWrite();
    }

    @Override
    public Writer append(CharSequence value) throws IOException {
      String text = String.valueOf(value);
      write(text, 0, text.length());
      return this;
    }

    @Override
    public Writer append(CharSequence value, int start, int end) throws IOException {
      String text = String.valueOf(value).subSequence(start, end).toString();
      write(text, 0, text.length());
      return this;
    }

    @Override
    public Writer append(char value) throws IOException {
      write(value);
      return this;
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
      emitFileSnapshot(path);
    }

    @Override
    public void write(byte[] bytes) throws IOException {
      if (device != null) {
        writeKernelDevice(device, bytes);
        return;
      }
      super.write(bytes);
      emitFileSnapshot(path);
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
      emitFileSnapshot(path);
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

  public static final class ProjectRandomAccessFile extends RandomAccessFile {
    private final Path path;
    private final boolean writable;

    public ProjectRandomAccessFile(String name, String mode) throws IOException {
      super(randomAccessFileTarget(Path.of(name), mode), mode);
      this.path = Path.of(name);
      this.writable = randomAccessFileCanWrite(mode);
    }

    public ProjectRandomAccessFile(File file, String mode) throws IOException {
      super(randomAccessFileTarget(file == null ? null : file.toPath(), mode), mode);
      this.path = file == null ? null : file.toPath();
      this.writable = randomAccessFileCanWrite(mode);
    }

    @Override
    public void write(int value) throws IOException {
      super.write(value);
      if (writable) emitFileSnapshot(path);
    }

    @Override
    public void write(byte[] bytes) throws IOException {
      super.write(bytes);
      if (writable) emitFileSnapshot(path);
    }

    @Override
    public void write(byte[] bytes, int offset, int length) throws IOException {
      super.write(bytes, offset, length);
      if (writable) emitFileSnapshot(path);
    }

    @Override
    public void setLength(long newLength) throws IOException {
      super.setLength(newLength);
      if (writable) emitFileSnapshot(path);
    }

    @Override
    public void close() throws IOException {
      super.close();
      if (writable) emitFileSnapshot(path);
    }
  }

  public static final class ProjectFile extends File {
    public ProjectFile(String pathname) {
      super(pathname);
    }

    public ProjectFile(String parent, String child) {
      super(parent, child);
    }

    public ProjectFile(File parent, String child) {
      super(parent, child);
    }

    public ProjectFile(URI uri) {
      super(uri);
    }

    @Override
    public boolean createNewFile() throws IOException {
      assertWritableProjectPath(toPath());
      boolean created = super.createNewFile();
      if (created) emitFileSnapshot(toPath());
      return created;
    }

    @Override
    public boolean delete() {
      try {
        assertWritableProjectPath(toPath());
      } catch (IOException error) {
        return false;
      }
      boolean directory = isDirectory();
      boolean deleted = super.delete();
      if (deleted) {
        if (directory) {
          emitDirectoryDelete(toPath());
        } else {
          emitFileDelete(toPath());
        }
      }
      return deleted;
    }

    @Override
    public boolean mkdir() {
      try {
        assertWritableProjectPath(toPath());
      } catch (IOException error) {
        return false;
      }
      boolean created = super.mkdir();
      if (created) emitDirectoryCreate(toPath());
      return created;
    }

    @Override
    public boolean mkdirs() {
      try {
        assertWritableProjectPath(toPath());
      } catch (IOException error) {
        return false;
      }
      List<Path> missing = missingDirectories(toPath());
      boolean created = super.mkdirs();
      if (created) {
        for (Path dir : missing) {
          if (Files.isDirectory(dir)) emitDirectoryCreate(dir);
        }
      }
      return created;
    }

    @Override
    public boolean renameTo(File dest) {
      try {
        assertWritableProjectPath(toPath());
        assertWritableProjectPath(dest == null ? null : dest.toPath());
      } catch (IOException error) {
        return false;
      }
      boolean directory = isDirectory();
      boolean renamed = super.renameTo(dest);
      if (renamed) {
        if (directory) {
          emitDirectoryDelete(toPath());
          if (dest != null) emitDirectoryCreate(dest.toPath());
        } else {
          emitFileDelete(toPath());
          if (dest != null) emitFileSnapshot(dest.toPath());
        }
      }
      return renamed;
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
      emitFileSnapshot(path);
    }

    @Override
    public void write(byte[] bytes) throws IOException {
      delegate.write(bytes);
      emitFileSnapshot(path);
    }

    @Override
    public void write(byte[] bytes, int offset, int length) throws IOException {
      delegate.write(bytes, offset, length);
      emitFileSnapshot(path);
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

  private static final class ProjectSeekableByteChannel implements SeekableByteChannel {
    private final SeekableByteChannel delegate;
    private final Path path;
    private final boolean writable;

    ProjectSeekableByteChannel(SeekableByteChannel delegate, Path path, boolean writable) {
      this.delegate = delegate;
      this.path = path;
      this.writable = writable;
    }

    @Override
    public int read(ByteBuffer dst) throws IOException {
      return delegate.read(dst);
    }

    @Override
    public int write(ByteBuffer src) throws IOException {
      int written = delegate.write(src);
      if (writable && written > 0) emitFileSnapshot(path);
      return written;
    }

    @Override
    public long position() throws IOException {
      return delegate.position();
    }

    @Override
    public SeekableByteChannel position(long newPosition) throws IOException {
      delegate.position(newPosition);
      return this;
    }

    @Override
    public long size() throws IOException {
      return delegate.size();
    }

    @Override
    public SeekableByteChannel truncate(long size) throws IOException {
      delegate.truncate(size);
      if (writable) emitFileSnapshot(path);
      return this;
    }

    @Override
    public boolean isOpen() {
      return delegate.isOpen();
    }

    @Override
    public void close() throws IOException {
      delegate.close();
      if (writable) emitFileSnapshot(path);
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
    emitOutput(stream, data, "");
  }

  private static void emitOutput(String stream, String data, String sourceDevice) {
    if (!PROJECT_EVENT_BRIDGE_ENABLED.get() || data.isEmpty()) return;
    try {
      emitOutputNative(stream, data, sourceDevice == null ? "" : sourceDevice);
    } catch (UnsatisfiedLinkError | SecurityException ignored) {
      // Host JVM tests and older browser runtimes may not expose the CheerpJ native bridge.
    }
  }

  private static native void emitOutputNative(String stream, String data, String sourceDevice);
  private static native void emitFileSnapshotNative(String path, String contents);
  private static native void emitFileDeleteNative(String path);
  private static native void emitDirectoryCreateNative(String path);
  private static native void emitDirectoryDeleteNative(String path);

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
    String normalized = normalizeVirtualPath(path);
    if (!isVirtualDevicePath(normalized)) return null;
    return KERNEL_DEVICES.get().get(normalized);
  }

  private static ArrayList<Path> kernelDevicePaths() {
    ArrayList<String> devices = new ArrayList<>(KERNEL_DEVICES.get().keySet());
    Collections.sort(devices);
    ArrayList<Path> paths = new ArrayList<>();
    for (String device : devices) paths.add(Path.of(device));
    return paths;
  }

  private static String normalizeVirtualPath(Path path) {
    if (path == null) return null;
    String normalized = path.toString().replace('\\', '/');
    while (normalized.endsWith("/") && normalized.length() > 1) {
      normalized = normalized.substring(0, normalized.length() - 1);
    }
    return normalized.isEmpty() ? "/" : normalized;
  }

  private static boolean isVirtualDeviceDirectory(String normalized) {
    return "/dev".equals(normalized);
  }

  private static boolean isVirtualDevicePath(String normalized) {
    return normalized != null && normalized.startsWith("/dev/");
  }

  private static boolean isVirtualDeviceNamespacePath(String normalized) {
    return isVirtualDeviceDirectory(normalized) || isVirtualDevicePath(normalized);
  }

  private static void throwKernelDeviceNotDirectory(String normalized) throws IOException {
    if (KERNEL_DEVICES.get().containsKey(normalized)) throw new NotDirectoryException(normalized);
    throw new NoSuchFileException(normalized);
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
    emitOutput(stream, new String(bytes, StandardCharsets.UTF_8), device.path.equals(outputDevice) ? "" : device.path);
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

  private static final class KernelDirectoryStream implements DirectoryStream<Path> {
    private final Iterable<Path> entries;
    private boolean open = true;

    KernelDirectoryStream(Iterable<Path> entries) {
      this.entries = entries;
    }

    @Override
    public Iterator<Path> iterator() {
      if (!open) throw new IllegalStateException("Directory stream is closed");
      return entries.iterator();
    }

    @Override
    public void close() {
      open = false;
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

  private static final class KernelDeviceByteChannel implements SeekableByteChannel {
    private final KernelDevice device;
    private boolean open = true;

    KernelDeviceByteChannel(KernelDevice device) {
      this.device = device;
    }

    @Override
    public int read(ByteBuffer dst) throws IOException {
      throw new IOException("Kernel device is not readable: " + device.path);
    }

    @Override
    public int write(ByteBuffer src) {
      int length = src.remaining();
      byte[] bytes = new byte[length];
      src.get(bytes);
      writeKernelDevice(device, bytes);
      return length;
    }

    @Override
    public long position() {
      return 0;
    }

    @Override
    public SeekableByteChannel position(long newPosition) {
      return this;
    }

    @Override
    public long size() {
      return 0;
    }

    @Override
    public SeekableByteChannel truncate(long size) {
      return this;
    }

    @Override
    public boolean isOpen() {
      return open;
    }

    @Override
    public void close() {
      open = false;
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

  private static File randomAccessFileTarget(Path path, String mode) throws IOException {
    if (randomAccessFileCanWrite(mode)) assertWritableProjectPath(path);
    return path.toFile();
  }

  private static boolean randomAccessFileCanWrite(String mode) {
    return mode != null && mode.indexOf('w') >= 0;
  }

  private static boolean byteChannelCanWrite(OpenOption... options) {
    if (options == null) return false;
    for (OpenOption option : options) {
      if (
          option == StandardOpenOption.WRITE ||
          option == StandardOpenOption.APPEND ||
          option == StandardOpenOption.CREATE ||
          option == StandardOpenOption.CREATE_NEW ||
          option == StandardOpenOption.TRUNCATE_EXISTING
      ) {
        return true;
      }
    }
    return false;
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
    String normalized = normalizeVirtualPath(path);
    if (normalized == null) return false;
    return normalized.equals("/proc") ||
        normalized.startsWith("/proc/") ||
        isVirtualDeviceNamespacePath(normalized);
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

  private static void emitDirectoryCreate(Path path) {
    if (!PROJECT_EVENT_BRIDGE_ENABLED.get()) return;
    String relativePath = projectRelativePath(path);
    if (relativePath == null) return;
    try {
      emitDirectoryCreateNative(relativePath);
    } catch (UnsatisfiedLinkError | SecurityException ignored) {
      // Final-diff persistence still captures directory creates when live browser bridge emission is unavailable.
    }
  }

  private static void emitDirectoryDelete(Path path) {
    if (!PROJECT_EVENT_BRIDGE_ENABLED.get()) return;
    String relativePath = projectRelativePath(path);
    if (relativePath == null) return;
    try {
      emitDirectoryDeleteNative(relativePath);
    } catch (UnsatisfiedLinkError | SecurityException ignored) {
      // Final-diff persistence still captures directory deletes when live browser bridge emission is unavailable.
    }
  }

  private static List<Path> missingDirectories(Path path) {
    ArrayList<Path> missing = new ArrayList<>();
    Path root = PROJECT_WORKSPACE_ROOT.get();
    if (root == null || path == null) return missing;
    Path absolute = path.toAbsolutePath().normalize();
    if (!absolute.startsWith(root)) return missing;
    ArrayList<Path> candidates = new ArrayList<>();
    Path current = absolute;
    while (current != null && !current.equals(root)) {
      candidates.add(current);
      current = current.getParent();
    }
    Collections.reverse(candidates);
    for (Path candidate : candidates) {
      if (!Files.exists(candidate)) missing.add(candidate);
    }
    return missing;
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

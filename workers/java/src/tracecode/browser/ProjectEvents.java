package tracecode.browser;

import java.io.BufferedWriter;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileFilter;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.FilenameFilter;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.io.RandomAccessFile;
import java.io.Reader;
import java.io.Writer;
import java.net.Authenticator;
import java.net.CookieHandler;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.ProxySelector;
import java.net.URI;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.net.URLStreamHandlerFactory;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.charset.Charset;
import java.nio.ByteBuffer;
import java.nio.channels.ClosedChannelException;
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
import java.nio.file.attribute.FileTime;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.Flow;
import com.sun.net.httpserver.Filter;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpContext;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpPrincipal;
import com.sun.net.httpserver.HttpServer;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;
import java.util.stream.Stream;

public final class ProjectEvents {
  private static final InheritableThreadLocal<Boolean> PROJECT_EVENT_BRIDGE_ENABLED =
      new InheritableThreadLocal<Boolean>() {
        @Override
        protected Boolean initialValue() {
          return Boolean.FALSE;
        }
      };
  private static final InheritableThreadLocal<Integer> PROJECT_RUN_TOKEN = new InheritableThreadLocal<>();
  private static final InheritableThreadLocal<String> PROJECT_BRIDGE_RUN_ID = new InheritableThreadLocal<>();
  private static final ThreadLocal<Path> PROJECT_WORKSPACE_ROOT = new ThreadLocal<>();
  private static final ThreadLocal<String> PROJECT_VIRTUAL_WORKSPACE_ROOT = new ThreadLocal<>();
  private static final ThreadLocal<String> PROJECT_WORKSPACE_ALIAS = new ThreadLocal<>();
  private static final ThreadLocal<Map<String, String>> PROJECT_ENVIRONMENT =
      ThreadLocal.withInitial(HashMap::new);
  private static final ThreadLocal<Map<String, KernelDevice>> KERNEL_DEVICES =
      ThreadLocal.withInitial(HashMap::new);
  private static final ThreadLocal<Map<String, byte[]>> KERNEL_VIRTUAL_FILES =
      ThreadLocal.withInitial(HashMap::new);
  private static final ThreadLocal<ByteArrayOutputStream> STDOUT_CAPTURE = new ThreadLocal<>();
  private static final ThreadLocal<ByteArrayOutputStream> STDERR_CAPTURE = new ThreadLocal<>();
  private static final ThreadLocal<OutputFileTargetInfo> LAST_OUTPUT_FILE_TARGET = new ThreadLocal<>();
  private static volatile boolean HTTP_URL_HANDLER_INSTALLED = false;
  private static volatile ProjectHttpDispatcher HTTP_DISPATCHER_FOR_TESTING = null;
  private static final Map<Integer, ProjectHttpServer> PROJECT_HTTP_SERVERS = new HashMap<>();
  private static int NEXT_PROJECT_HTTP_PORT = 32000;
  private static final int PROJECT_MAX_OUTPUT_STREAM_BYTES = 1024 * 1024;
  private static final int PROJECT_MAX_LIVE_FILE_CHANGES = 1024;
  private static final long PROJECT_MAX_LIVE_FILE_CHANGE_BYTES = 4L * 1024L * 1024L;
  private static final InheritableThreadLocal<ProjectEventBudget> PROJECT_EVENT_BUDGET =
      new InheritableThreadLocal<ProjectEventBudget>() {
        @Override
        protected ProjectEventBudget initialValue() {
          return new ProjectEventBudget();
        }
      };
  private static int NEXT_PROJECT_RUN_TOKEN = 0;
  private static volatile int ACTIVE_PROJECT_RUN_TOKEN = 0;

  private ProjectEvents() {}

  public interface ProjectHttpDispatcher {
    String dispatch(String requestJson) throws IOException;
  }

  public static void setHttpDispatcherForTesting(ProjectHttpDispatcher dispatcher) {
    HTTP_DISPATCHER_FOR_TESTING = dispatcher;
  }

  public static void installHttpUrlHandler() {
    if (HTTP_URL_HANDLER_INSTALLED) return;
    synchronized (ProjectEvents.class) {
      if (HTTP_URL_HANDLER_INSTALLED) return;
      try {
        URL.setURLStreamHandlerFactory(new ProjectHttpUrlStreamHandlerFactory());
        HTTP_URL_HANDLER_INSTALLED = true;
      } catch (Error error) {
        HTTP_URL_HANDLER_INSTALLED = true;
      }
    }
  }

  public static HttpClient httpClient() {
    return new ProjectHttpClientBuilder().build();
  }

  public static HttpClient.Builder httpClientBuilder() {
    return new ProjectHttpClientBuilder();
  }

  public static HttpServer httpServer() throws IOException {
    return httpServer(new InetSocketAddress(0), 0);
  }

  public static HttpServer httpServer(InetSocketAddress address, int backlog) throws IOException {
    ProjectHttpServer server = new ProjectHttpServer();
    if (address != null) server.bind(address, backlog);
    return server;
  }

  public static void setProjectEventBridgeEnabled(boolean enabled) {
    if (enabled) {
      beginProjectRun();
    } else {
      Integer token = PROJECT_RUN_TOKEN.get();
      if (token == null) {
        disableProjectRunForCurrentThread();
      } else {
        endProjectRun(token.intValue());
      }
    }
  }

  public static int beginProjectRun() {
    return beginProjectRun(null);
  }

  public static int beginProjectRun(String bridgeRunId) {
    int token;
    synchronized (ProjectEvents.class) {
      token = NEXT_PROJECT_RUN_TOKEN + 1;
      if (token <= 0) token = 1;
      NEXT_PROJECT_RUN_TOKEN = token;
      ACTIVE_PROJECT_RUN_TOKEN = token;
    }
    PROJECT_RUN_TOKEN.set(token);
    setProjectBridgeRunIdForCurrentThread(bridgeRunId);
    PROJECT_EVENT_BRIDGE_ENABLED.set(Boolean.TRUE);
    PROJECT_EVENT_BUDGET.set(new ProjectEventBudget());
    return token;
  }

  public static void endProjectRun(int token) {
    synchronized (ProjectEvents.class) {
      if (ACTIVE_PROJECT_RUN_TOKEN == token) {
        ACTIVE_PROJECT_RUN_TOKEN = 0;
      }
    }
    disableProjectRunForCurrentThread();
  }

  private static void disableProjectRunForCurrentThread() {
    PROJECT_EVENT_BRIDGE_ENABLED.set(Boolean.FALSE);
    PROJECT_RUN_TOKEN.remove();
    PROJECT_BRIDGE_RUN_ID.remove();
    PROJECT_EVENT_BUDGET.remove();
  }

  private static void setProjectBridgeRunIdForCurrentThread(String bridgeRunId) {
    if (bridgeRunId == null || bridgeRunId.isEmpty() || bridgeRunId.indexOf('\0') >= 0 || bridgeRunId.length() > 256) {
      PROJECT_BRIDGE_RUN_ID.remove();
      return;
    }
    PROJECT_BRIDGE_RUN_ID.set(bridgeRunId);
  }

  private static int currentProjectRunToken() {
    Integer token = PROJECT_RUN_TOKEN.get();
    return token == null ? 0 : token.intValue();
  }

  private static String currentProjectBridgeRunId() {
    String bridgeRunId = PROJECT_BRIDGE_RUN_ID.get();
    return bridgeRunId == null ? "" : bridgeRunId;
  }

  private static boolean projectRunActiveForCurrentThread() {
    return projectRunTokenActive(currentProjectRunToken());
  }

  private static boolean projectRunTokenActive(int token) {
    return token != 0 &&
        token == ACTIVE_PROJECT_RUN_TOKEN &&
        Boolean.TRUE.equals(PROJECT_EVENT_BRIDGE_ENABLED.get());
  }

  public static void setProjectWorkspaceRoot(Path root) {
    PROJECT_WORKSPACE_ROOT.set(root == null ? null : root.toAbsolutePath().normalize());
  }

  public static void setProjectVirtualWorkspaceRoot(String root, String alias) {
    PROJECT_VIRTUAL_WORKSPACE_ROOT.set(normalizeKernelAbsoluteString(root));
    PROJECT_WORKSPACE_ALIAS.set(normalizeKernelAbsoluteString(alias));
  }

  public static void setEnvironment(String manifest) {
    PROJECT_ENVIRONMENT.set(parseEnvironment(manifest));
  }

  public static String getenv(String name) {
    return PROJECT_ENVIRONMENT.get().get(name);
  }

  public static Map<String, String> getenv() {
    return new HashMap<>(PROJECT_ENVIRONMENT.get());
  }

  public static void setKernelDevices(String manifest) {
    KERNEL_DEVICES.set(parseKernelDevices(manifest));
  }

  public static void setKernelFiles(String manifest) {
    KERNEL_VIRTUAL_FILES.set(parseKernelFilePaths(manifest));
  }

  public static void clearKernelDevices() {
    clearProjectHttpServers();
    KERNEL_DEVICES.remove();
    KERNEL_VIRTUAL_FILES.remove();
    STDOUT_CAPTURE.remove();
    STDERR_CAPTURE.remove();
    PROJECT_WORKSPACE_ROOT.remove();
    PROJECT_ENVIRONMENT.remove();
    PROJECT_VIRTUAL_WORKSPACE_ROOT.remove();
    PROJECT_WORKSPACE_ALIAS.remove();
    PROJECT_EVENT_BUDGET.remove();
  }

  private static void clearProjectHttpServers() {
    List<ProjectHttpServer> servers;
    synchronized (PROJECT_HTTP_SERVERS) {
      servers = new ArrayList<>(PROJECT_HTTP_SERVERS.values());
      PROJECT_HTTP_SERVERS.clear();
    }
    for (ProjectHttpServer server : servers) {
      try {
        server.stop(0);
      } catch (RuntimeException ignored) {
      }
    }
  }

  public static InputStream inputStream() {
    return new ProjectInputStream(null);
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
    byte[] kernelFile = readableKernelFile(path);
    if (kernelFile != null) return new String(kernelFile, StandardCharsets.UTF_8);
    return Files.readString(runtimePath(path));
  }

  public static String readString(Path path, Charset charset) throws IOException {
    KernelDevice device = readableKernelDevice(path);
    if (device != null) return new String(readKernelDevice(device), charset);
    byte[] kernelFile = readableKernelFile(path);
    if (kernelFile != null) return new String(kernelFile, charset);
    return Files.readString(runtimePath(path), charset);
  }

  public static byte[] readAllBytes(Path path) throws IOException {
    KernelDevice device = readableKernelDevice(path);
    if (device != null) return readKernelDevice(device);
    byte[] kernelFile = readableKernelFile(path);
    if (kernelFile != null) return kernelFile;
    return Files.readAllBytes(runtimePath(path));
  }

  public static InputStream newInputStream(Path path, OpenOption... options) throws IOException {
    KernelDevice device = readableKernelDevice(path);
    if (device != null) return new ByteArrayInputStream(readKernelDevice(device));
    byte[] kernelFile = readableKernelFile(path);
    if (kernelFile != null) return new ByteArrayInputStream(kernelFile);
    return Files.newInputStream(runtimePath(path), options);
  }

  public static BufferedReader newBufferedReader(Path path) throws IOException {
    return newBufferedReader(path, StandardCharsets.UTF_8);
  }

  public static BufferedReader newBufferedReader(Path path, Charset charset) throws IOException {
    KernelDevice device = readableKernelDevice(path);
    if (device != null) {
      Charset effectiveCharset = charset == null ? StandardCharsets.UTF_8 : charset;
      return new BufferedReader(new InputStreamReader(new ByteArrayInputStream(readKernelDevice(device)), effectiveCharset));
    }
    byte[] kernelFile = readableKernelFile(path);
    if (kernelFile != null) {
      Charset effectiveCharset = charset == null ? StandardCharsets.UTF_8 : charset;
      return new BufferedReader(new InputStreamReader(new ByteArrayInputStream(kernelFile), effectiveCharset));
    }
    return Files.newBufferedReader(runtimePath(path), charset);
  }

  public static List<String> readAllLines(Path path) throws IOException {
    return readAllLines(path, StandardCharsets.UTF_8);
  }

  public static List<String> readAllLines(Path path, Charset charset) throws IOException {
    KernelDevice device = readableKernelDevice(path);
    if (device != null) {
      Charset effectiveCharset = charset == null ? StandardCharsets.UTF_8 : charset;
      return new BufferedReader(new InputStreamReader(new ByteArrayInputStream(readKernelDevice(device)), effectiveCharset))
          .lines()
          .collect(java.util.stream.Collectors.toList());
    }
    byte[] kernelFile = readableKernelFile(path);
    if (kernelFile != null) {
      Charset effectiveCharset = charset == null ? StandardCharsets.UTF_8 : charset;
      return new BufferedReader(new InputStreamReader(new ByteArrayInputStream(kernelFile), effectiveCharset))
          .lines()
          .collect(java.util.stream.Collectors.toList());
    }
    return Files.readAllLines(runtimePath(path), charset);
  }

  public static Stream<String> lines(Path path) throws IOException {
    return lines(path, StandardCharsets.UTF_8);
  }

  public static Stream<String> lines(Path path, Charset charset) throws IOException {
    KernelDevice device = readableKernelDevice(path);
    if (device != null) {
      Charset effectiveCharset = charset == null ? StandardCharsets.UTF_8 : charset;
      return new String(readKernelDevice(device), effectiveCharset).lines();
    }
    byte[] kernelFile = readableKernelFile(path);
    if (kernelFile != null) {
      Charset effectiveCharset = charset == null ? StandardCharsets.UTF_8 : charset;
      return new String(kernelFile, effectiveCharset).lines();
    }
    return Files.lines(runtimePath(path), charset);
  }

  public static Stream<Path> list(Path path) throws IOException {
    String normalized = normalizeVirtualPath(path);
    if (isVirtualDeviceDirectory(normalized)) {
      return kernelDeviceDirectoryPaths(normalized).stream();
    }
    if (isVirtualDevicePath(normalized)) throwKernelDeviceNotDirectory(normalized);
    if (isKernelVirtualDirectory(normalized)) return kernelVirtualDirectoryPaths(normalized).stream();
    if (isKernelVirtualFile(normalized)) throw new NotDirectoryException(normalized);
    return Files.list(runtimePath(path));
  }

  public static DirectoryStream<Path> newDirectoryStream(Path dir) throws IOException {
    String normalized = normalizeVirtualPath(dir);
    if (isVirtualDeviceDirectory(normalized)) return new KernelDirectoryStream(kernelDeviceDirectoryPaths(normalized));
    if (isVirtualDevicePath(normalized)) throwKernelDeviceNotDirectory(normalized);
    if (isKernelVirtualDirectory(normalized)) return new KernelDirectoryStream(kernelVirtualDirectoryPaths(normalized));
    if (isKernelVirtualFile(normalized)) throw new NotDirectoryException(normalized);
    return Files.newDirectoryStream(runtimePath(dir));
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
    if (isKernelVirtualDirectory(normalized)) {
      DirectoryStream.Filter<Path> filter = (entry) -> dir.getFileSystem()
          .getPathMatcher("glob:" + glob)
          .matches(entry.getFileName());
      return newDirectoryStream(dir, filter);
    }
    if (isKernelVirtualFile(normalized)) throw new NotDirectoryException(normalized);
    return Files.newDirectoryStream(runtimePath(dir), glob);
  }

  public static DirectoryStream<Path> newDirectoryStream(Path dir, DirectoryStream.Filter<? super Path> filter)
      throws IOException {
    String normalized = normalizeVirtualPath(dir);
    if (isVirtualDeviceDirectory(normalized)) {
      ArrayList<Path> entries = new ArrayList<>();
      for (Path entry : kernelDeviceDirectoryPaths(normalized)) {
        if (filter == null || filter.accept(entry)) entries.add(entry);
      }
      return new KernelDirectoryStream(entries);
    }
    if (isVirtualDevicePath(normalized)) throwKernelDeviceNotDirectory(normalized);
    if (isKernelVirtualDirectory(normalized)) {
      ArrayList<Path> entries = new ArrayList<>();
      for (Path entry : kernelVirtualDirectoryPaths(normalized)) {
        if (filter == null || filter.accept(entry)) entries.add(entry);
      }
      return new KernelDirectoryStream(entries);
    }
    if (isKernelVirtualFile(normalized)) throw new NotDirectoryException(normalized);
    return Files.newDirectoryStream(runtimePath(dir), filter);
  }

  public static boolean exists(Path path, LinkOption... options) {
    String normalized = normalizeVirtualPath(path);
    if (isVirtualDeviceDirectory(normalized)) return true;
    if (isVirtualDevicePath(normalized)) return KERNEL_DEVICES.get().containsKey(normalized);
    if (isKernelVirtualDirectory(normalized) || isKernelVirtualFile(normalized)) return true;
    return Files.exists(runtimePath(path), options);
  }

  public static boolean notExists(Path path, LinkOption... options) {
    String normalized = normalizeVirtualPath(path);
    if (isVirtualDeviceNamespacePath(normalized) || isKernelVirtualNamespacePath(normalized)) {
      return !exists(path, options);
    }
    return Files.notExists(runtimePath(path), options);
  }

  public static boolean isDirectory(Path path, LinkOption... options) {
    String normalized = normalizeVirtualPath(path);
    if (isVirtualDeviceDirectory(normalized)) return true;
    if (isVirtualDevicePath(normalized)) return false;
    if (isKernelVirtualDirectory(normalized)) return true;
    if (isKernelVirtualFile(normalized)) return false;
    return Files.isDirectory(runtimePath(path), options);
  }

  public static boolean isRegularFile(Path path, LinkOption... options) {
    String normalized = normalizeVirtualPath(path);
    if (isVirtualDeviceDirectory(normalized)) return false;
    if (isVirtualDevicePath(normalized)) return KERNEL_DEVICES.get().containsKey(normalized);
    if (isKernelVirtualDirectory(normalized)) return false;
    if (isKernelVirtualFile(normalized)) return true;
    return Files.isRegularFile(runtimePath(path), options);
  }

  public static boolean isReadable(Path path) {
    String normalized = normalizeVirtualPath(path);
    if (isVirtualDeviceDirectory(normalized)) return true;
    if (isVirtualDevicePath(normalized)) {
      KernelDevice device = KERNEL_DEVICES.get().get(normalized);
      return device != null && device.readable;
    }
    if (isKernelVirtualDirectory(normalized) || isKernelVirtualFile(normalized)) return true;
    if (isKernelVirtualNamespacePath(normalized)) return false;
    return Files.isReadable(runtimePath(path));
  }

  public static boolean isWritable(Path path) {
    String normalized = normalizeVirtualPath(path);
    if (isVirtualDeviceDirectory(normalized)) return false;
    if (isVirtualDevicePath(normalized)) {
      KernelDevice device = KERNEL_DEVICES.get().get(normalized);
      return device != null && device.writable;
    }
    if (isKernelVirtualNamespacePath(normalized)) return false;
    return Files.isWritable(runtimePath(path));
  }

  public static long size(Path path) throws IOException {
    String normalized = normalizeVirtualPath(path);
    if (isVirtualDeviceNamespacePath(normalized)) {
      if (isVirtualDeviceDirectory(normalized) || KERNEL_DEVICES.get().containsKey(normalized)) return 0L;
      throw new NoSuchFileException(normalized);
    }
    if (isKernelVirtualDirectory(normalized)) return 0L;
    if (isKernelVirtualFile(normalized)) return KERNEL_VIRTUAL_FILES.get().get(normalized).length;
    if (isKernelVirtualNamespacePath(normalized)) throw new NoSuchFileException(normalized);
    return Files.size(runtimePath(path));
  }

  public static Path writeString(Path path, CharSequence contents, OpenOption... options) throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) {
      writeKernelDevice(device, String.valueOf(contents).getBytes(StandardCharsets.UTF_8));
      return path;
    }
    assertWritableProjectPath(path);
    Path runtime = runtimePath(path);
    Path result = Files.writeString(runtime, contents, options);
    emitPostWritePathChange(path, optionDeletesOnClose(options));
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
    Path runtime = runtimePath(path);
    Path result = Files.writeString(runtime, contents, charset, options);
    emitPostWritePathChange(path, optionDeletesOnClose(options));
    return result;
  }

  public static Path write(Path path, byte[] bytes, OpenOption... options) throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) {
      writeKernelDevice(device, bytes);
      return path;
    }
    assertWritableProjectPath(path);
    Path runtime = runtimePath(path);
    Path result = Files.write(runtime, bytes, options);
    emitPostWritePathChange(path, optionDeletesOnClose(options));
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
    Path runtime = runtimePath(path);
    Path result = Files.write(runtime, lines, options);
    emitPostWritePathChange(path, optionDeletesOnClose(options));
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
    Path runtime = runtimePath(path);
    Path result = Files.write(runtime, lines, charset, options);
    emitPostWritePathChange(path, optionDeletesOnClose(options));
    return result;
  }

  public static Path createFile(Path path, FileAttribute<?>... attrs) throws IOException {
    assertWritableProjectPath(path);
    Path runtime = runtimePath(path);
    Path result = Files.createFile(runtime, attrs);
    emitFileSnapshot(path);
    return result;
  }

  public static Path createDirectory(Path dir, FileAttribute<?>... attrs) throws IOException {
    assertWritableProjectPath(dir);
    Path runtime = runtimePath(dir);
    Path result = Files.createDirectory(runtime, attrs);
    emitDirectoryCreate(dir);
    return result;
  }

  public static Path createDirectories(Path dir, FileAttribute<?>... attrs) throws IOException {
    assertWritableProjectPath(dir);
    List<Path> missing = missingDirectories(dir);
    Path runtime = runtimePath(dir);
    Path result = Files.createDirectories(runtime, attrs);
    for (Path created : missing) {
      if (Files.isDirectory(created)) emitDirectoryCreate(created);
    }
    return result;
  }

  public static Path createTempFile(Path dir, String prefix, String suffix, FileAttribute<?>... attrs)
      throws IOException {
    assertWritableProjectPath(dir);
    Path runtime = runtimePath(dir);
    Path result = Files.createTempFile(runtime, prefix, suffix, attrs);
    emitFileSnapshot(result);
    return result;
  }

  public static Path createTempFile(String prefix, String suffix, FileAttribute<?>... attrs) throws IOException {
    Path result = Files.createTempFile(prefix, suffix, attrs);
    emitFileSnapshot(result);
    return result;
  }

  public static Path createTempPath(Path dir, String prefix, String suffix, FileAttribute<?>... attrs)
      throws IOException {
    return createTempFile(dir, prefix, suffix, attrs);
  }

  public static Path createTempPath(String prefix, String suffix, FileAttribute<?>... attrs) throws IOException {
    Path result = Files.createTempFile(prefix, suffix, attrs);
    emitFileSnapshot(result);
    return result;
  }

  public static File createTempFile(String prefix, String suffix) throws IOException {
    File result = File.createTempFile(prefix, suffix);
    emitFileSnapshot(result.toPath());
    return result;
  }

  public static File createTempFile(String prefix, String suffix, File directory) throws IOException {
    if (directory != null) assertWritableProjectPath(directory.toPath());
    File result = File.createTempFile(prefix, suffix, directory);
    emitFileSnapshot(result.toPath());
    return result;
  }

  public static Path createTempDirectory(Path dir, String prefix, FileAttribute<?>... attrs) throws IOException {
    assertWritableProjectPath(dir);
    Path runtime = runtimePath(dir);
    Path result = Files.createTempDirectory(runtime, prefix, attrs);
    emitDirectoryCreate(result);
    return result;
  }

  public static Path createTempDirectory(String prefix, FileAttribute<?>... attrs) throws IOException {
    Path result = Files.createTempDirectory(prefix, attrs);
    emitDirectoryCreate(result);
    return result;
  }

  public static Path setLastModifiedTime(Path path, FileTime time) throws IOException {
    assertWritableProjectPath(path);
    Path runtime = runtimePath(path);
    Path result = Files.setLastModifiedTime(runtime, time);
    emitPathSnapshot(path);
    return result;
  }

  public static Path setAttribute(Path path, String attribute, Object value, LinkOption... options) throws IOException {
    assertWritableProjectPath(path);
    Path runtime = runtimePath(path);
    Path result = Files.setAttribute(runtime, attribute, value, options);
    emitPathSnapshot(path);
    return result;
  }

  public static void delete(Path path) throws IOException {
    assertWritableProjectPath(path);
    Path runtime = runtimePath(path);
    boolean directory = Files.isDirectory(runtime);
    Files.delete(runtime);
    if (directory) {
      emitDirectoryDelete(path);
    } else {
      emitFileDelete(path);
    }
  }

  public static boolean deleteIfExists(Path path) throws IOException {
    assertWritableProjectPath(path);
    Path runtime = runtimePath(path);
    boolean directory = Files.isDirectory(runtime);
    boolean deleted = Files.deleteIfExists(runtime);
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
    byte[] sourceKernelFile = sourceDevice == null ? readableKernelFile(source) : null;
    if (targetDevice != null) {
      byte[] bytes = sourceDevice != null ? readKernelDevice(sourceDevice) : sourceKernelFile != null ? sourceKernelFile : Files.readAllBytes(runtimePath(source));
      writeKernelDevice(targetDevice, bytes);
      return target;
    }
    assertWritableProjectPath(target);
    if (sourceDevice != null) {
      Files.write(runtimePath(target), readKernelDevice(sourceDevice));
      emitFileSnapshot(target);
      return target;
    }
    if (sourceKernelFile != null) {
      Files.write(runtimePath(target), sourceKernelFile);
      emitFileSnapshot(target);
      return target;
    }
    Path runtimeSource = runtimePath(source);
    Path runtimeTarget = runtimePath(target);
    boolean directory = Files.isDirectory(runtimeSource);
    Path result = Files.copy(runtimeSource, runtimeTarget, options);
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
    Path runtimeSource = runtimePath(source);
    Path runtimeTarget = runtimePath(target);
    boolean directory = Files.isDirectory(runtimeSource);
    Path result = Files.move(runtimeSource, runtimeTarget, options);
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
    Path runtime = runtimePath(path);
    boolean existed = Files.exists(runtime);
    OutputStream stream = Files.newOutputStream(runtime, options);
    return new ProjectOutputStream(stream, runtime, outputOpenSnapshotRequired(existed, options), optionDeletesOnClose(options));
  }

  public static BufferedWriter newBufferedWriter(Path path, OpenOption... options) throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) {
      return new BufferedWriter(new OutputStreamWriter(new KernelDeviceOutputStream(device), StandardCharsets.UTF_8));
    }
    assertWritableProjectPath(path);
    Path runtime = runtimePath(path);
    boolean existed = Files.exists(runtime);
    BufferedWriter writer = Files.newBufferedWriter(runtime, options);
    return new ProjectBufferedWriter(writer, runtime, outputOpenSnapshotRequired(existed, options), optionDeletesOnClose(options));
  }

  public static BufferedWriter newBufferedWriter(Path path, Charset charset, OpenOption... options) throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) {
      return new BufferedWriter(new OutputStreamWriter(new KernelDeviceOutputStream(device), charset));
    }
    assertWritableProjectPath(path);
    Path runtime = runtimePath(path);
    boolean existed = Files.exists(runtime);
    BufferedWriter writer = Files.newBufferedWriter(runtime, charset, options);
    return new ProjectBufferedWriter(writer, runtime, outputOpenSnapshotRequired(existed, options), optionDeletesOnClose(options));
  }

  public static SeekableByteChannel newByteChannel(Path path, OpenOption... options) throws IOException {
    SeekableByteChannel deviceChannel = kernelDeviceByteChannel(path, options);
    if (deviceChannel != null) return deviceChannel;
    SeekableByteChannel kernelFileChannel = kernelFileByteChannel(path, options);
    if (kernelFileChannel != null) return kernelFileChannel;
    boolean writable = byteChannelCanWrite(options);
    if (writable) assertWritableProjectPath(path);
    Path runtime = runtimePath(path);
    boolean existed = Files.exists(runtime);
    SeekableByteChannel channel = Files.newByteChannel(runtime, options);
    return new ProjectSeekableByteChannel(channel, runtime, writable, byteChannelOpenSnapshotRequired(existed, options), optionDeletesOnClose(options));
  }

  public static SeekableByteChannel newByteChannel(
      Path path,
      Set<? extends OpenOption> options,
      FileAttribute<?>... attrs
  ) throws IOException {
    OpenOption[] optionArray = options == null ? null : options.toArray(new OpenOption[0]);
    SeekableByteChannel deviceChannel = kernelDeviceByteChannel(path, optionArray);
    if (deviceChannel != null) return deviceChannel;
    SeekableByteChannel kernelFileChannel = kernelFileByteChannel(path, optionArray);
    if (kernelFileChannel != null) return kernelFileChannel;
    boolean writable = byteChannelCanWrite(optionArray);
    if (writable) assertWritableProjectPath(path);
    Path runtime = runtimePath(path);
    boolean existed = Files.exists(runtime);
    SeekableByteChannel channel = Files.newByteChannel(runtime, options, attrs);
    return new ProjectSeekableByteChannel(channel, runtime, writable, byteChannelOpenSnapshotRequired(existed, optionArray), optionDeletesOnClose(optionArray));
  }

  public static final class ProjectFileWriter extends FileWriter {
    private final Path path;
    private final KernelDevice device;
    private final Charset charset;

    public ProjectFileWriter(String fileName) throws IOException {
      super(outputFileTarget(Path.of(fileName)));
      this.path = Path.of(fileName);
      this.device = kernelDevice(this.path);
      this.charset = Charset.defaultCharset();
      emitOpenSnapshot(false);
    }

    public ProjectFileWriter(String fileName, boolean append) throws IOException {
      super(outputFileTarget(Path.of(fileName)), append);
      this.path = Path.of(fileName);
      this.device = kernelDevice(this.path);
      this.charset = Charset.defaultCharset();
      emitOpenSnapshot(append);
    }

    public ProjectFileWriter(String fileName, Charset charset) throws IOException {
      super(outputFileTarget(Path.of(fileName)), charset);
      this.path = Path.of(fileName);
      this.device = kernelDevice(this.path);
      this.charset = charset == null ? Charset.defaultCharset() : charset;
      emitOpenSnapshot(false);
    }

    public ProjectFileWriter(String fileName, Charset charset, boolean append) throws IOException {
      super(outputFileTarget(Path.of(fileName)), charset, append);
      this.path = Path.of(fileName);
      this.device = kernelDevice(this.path);
      this.charset = charset == null ? Charset.defaultCharset() : charset;
      emitOpenSnapshot(append);
    }

    public ProjectFileWriter(File file) throws IOException {
      super(outputFileTarget(file == null ? null : file.toPath()));
      this.path = file.toPath();
      this.device = kernelDevice(this.path);
      this.charset = Charset.defaultCharset();
      emitOpenSnapshot(false);
    }

    public ProjectFileWriter(File file, boolean append) throws IOException {
      super(outputFileTarget(file == null ? null : file.toPath()), append);
      this.path = file.toPath();
      this.device = kernelDevice(this.path);
      this.charset = Charset.defaultCharset();
      emitOpenSnapshot(append);
    }

    public ProjectFileWriter(File file, Charset charset) throws IOException {
      super(outputFileTarget(file == null ? null : file.toPath()), charset);
      this.path = file.toPath();
      this.device = kernelDevice(this.path);
      this.charset = charset == null ? Charset.defaultCharset() : charset;
      emitOpenSnapshot(false);
    }

    public ProjectFileWriter(File file, Charset charset, boolean append) throws IOException {
      super(outputFileTarget(file == null ? null : file.toPath()), charset, append);
      this.path = file.toPath();
      this.device = kernelDevice(this.path);
      this.charset = charset == null ? Charset.defaultCharset() : charset;
      emitOpenSnapshot(append);
    }

    public ProjectFileWriter(FileDescriptor fdObj) {
      super(fdObj);
      this.path = null;
      this.device = writableKernelDevice(fdObj);
      this.charset = Charset.defaultCharset();
    }

    private void emitAfterWrite() throws IOException {
      if (device != null) return;
      super.flush();
      emitFileSnapshot(path);
    }

    private void emitOpenSnapshot(boolean append) throws IOException {
      OutputFileTargetInfo target = LAST_OUTPUT_FILE_TARGET.get();
      LAST_OUTPUT_FILE_TARGET.remove();
      if (device != null) return;
      if (append && target != null && target.existed) return;
      super.flush();
      emitFileSnapshot(path);
    }

    private void writeDeviceChars(char[] chars, int offset, int length) {
      writeKernelDevice(device, new String(chars, offset, length).getBytes(charset));
    }

    private void writeDeviceString(String text, int offset, int length) {
      writeKernelDevice(device, text.substring(offset, offset + length).getBytes(charset));
    }

    @Override
    public void write(int value) throws IOException {
      if (device != null) {
        writeKernelDevice(device, String.valueOf((char) value).getBytes(charset));
        return;
      }
      super.write(value);
      emitAfterWrite();
    }

    @Override
    public void write(char[] chars, int offset, int length) throws IOException {
      if (device != null) {
        writeDeviceChars(chars, offset, length);
        return;
      }
      super.write(chars, offset, length);
      emitAfterWrite();
    }

    @Override
    public void write(String text, int offset, int length) throws IOException {
      if (device != null) {
        writeDeviceString(text, offset, length);
        return;
      }
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

  public static final class ProjectFileOutputStream extends FileOutputStream {
    private final Path path;
    private final KernelDevice device;

    public ProjectFileOutputStream(String name) throws IOException {
      super(outputFileTarget(Path.of(name)));
      this.path = Path.of(name);
      this.device = kernelDevice(this.path);
      emitOpenSnapshot(false);
    }

    public ProjectFileOutputStream(String name, boolean append) throws IOException {
      super(outputFileTarget(Path.of(name)), append);
      this.path = Path.of(name);
      this.device = kernelDevice(this.path);
      emitOpenSnapshot(append);
    }

    public ProjectFileOutputStream(File file) throws IOException {
      super(outputFileTarget(file == null ? null : file.toPath()));
      this.path = file.toPath();
      this.device = kernelDevice(this.path);
      emitOpenSnapshot(false);
    }

    public ProjectFileOutputStream(File file, boolean append) throws IOException {
      super(outputFileTarget(file == null ? null : file.toPath()), append);
      this.path = file.toPath();
      this.device = kernelDevice(this.path);
      emitOpenSnapshot(append);
    }

    public ProjectFileOutputStream(FileDescriptor fdObj) {
      super(fdObj);
      this.path = null;
      this.device = writableKernelDevice(fdObj);
    }

    private void emitOpenSnapshot(boolean append) throws IOException {
      OutputFileTargetInfo target = LAST_OUTPUT_FILE_TARGET.get();
      LAST_OUTPUT_FILE_TARGET.remove();
      if (device != null) return;
      if (append && target != null && target.existed) return;
      super.flush();
      emitFileSnapshot(path);
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
    private final KernelDevice device;

    public ProjectFileInputStream(String name) throws IOException {
      super(inputFileTarget(Path.of(name)));
      this.path = Path.of(name);
      this.device = readableKernelDevice(this.path);
    }

    public ProjectFileInputStream(File file) throws IOException {
      super(inputFileTarget(file == null ? null : file.toPath()));
      this.path = file.toPath();
      this.device = readableKernelDevice(this.path);
    }

    public ProjectFileInputStream(FileDescriptor fdObj) {
      super(fdObj);
      this.path = null;
      this.device = readableKernelDevice(fdObj);
    }

    @Override
    public int read() throws IOException {
      if (device == null) return super.read();
      return readKernelDeviceByte(device);
    }

    @Override
    public int read(byte[] bytes) throws IOException {
      return read(bytes, 0, bytes.length);
    }

    @Override
    public int read(byte[] bytes, int offset, int length) throws IOException {
      if (device == null) return super.read(bytes, offset, length);
      return readKernelDeviceBytes(device, bytes, offset, length);
    }

    @Override
    public long skip(long count) throws IOException {
      if (device == null) return super.skip(count);
      if (count <= 0) return 0;
      return skipKernelDeviceBytes(device, count);
    }

    @Override
    public int available() throws IOException {
      if (device == null) return super.available();
      return kernelDeviceAvailable(device);
    }
  }

  public static final class ProjectFileReader extends FileReader {
    private final Reader deviceReader;

    public ProjectFileReader(String fileName) throws IOException {
      super(inputReaderTarget(Path.of(fileName)));
      this.deviceReader = kernelInputReader(Path.of(fileName), Charset.defaultCharset());
    }

    public ProjectFileReader(String fileName, Charset charset) throws IOException {
      super(inputReaderTarget(Path.of(fileName)), charset);
      this.deviceReader = kernelInputReader(Path.of(fileName), charset);
    }

    public ProjectFileReader(File file) throws IOException {
      super(inputReaderTarget(file == null ? null : file.toPath()));
      this.deviceReader = kernelInputReader(file == null ? null : file.toPath(), Charset.defaultCharset());
    }

    public ProjectFileReader(File file, Charset charset) throws IOException {
      super(inputReaderTarget(file == null ? null : file.toPath()), charset);
      this.deviceReader = kernelInputReader(file == null ? null : file.toPath(), charset);
    }

    public ProjectFileReader(FileDescriptor fdObj) {
      super(fdObj);
      this.deviceReader = kernelInputReader(fdObj, Charset.defaultCharset());
    }

    @Override
    public int read() throws IOException {
      if (deviceReader == null) return super.read();
      return deviceReader.read();
    }

    @Override
    public int read(char[] buffer, int offset, int length) throws IOException {
      if (deviceReader == null) return super.read(buffer, offset, length);
      return deviceReader.read(buffer, offset, length);
    }

    @Override
    public long skip(long count) throws IOException {
      if (deviceReader == null) return super.skip(count);
      return deviceReader.skip(count);
    }

    @Override
    public boolean ready() throws IOException {
      if (deviceReader == null) return super.ready();
      return deviceReader.ready();
    }

    @Override
    public void close() throws IOException {
      if (deviceReader != null) {
        IOException thrown = null;
        try {
          deviceReader.close();
        } catch (IOException error) {
          thrown = error;
        }
        try {
          super.close();
        } catch (IOException error) {
          if (thrown == null) {
            thrown = error;
          } else {
            thrown.addSuppressed(error);
          }
        }
        if (thrown != null) throw thrown;
        return;
      }
      super.close();
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
    public boolean exists() {
      String normalized = normalizeVirtualPath(toPath());
      if (isVirtualDeviceDirectory(normalized)) return true;
      if (isVirtualDevicePath(normalized)) return KERNEL_DEVICES.get().containsKey(normalized);
      if (isKernelVirtualDirectory(normalized) || isKernelVirtualFile(normalized)) return true;
      return super.exists();
    }

    @Override
    public boolean isDirectory() {
      String normalized = normalizeVirtualPath(toPath());
      if (isVirtualDeviceDirectory(normalized)) return true;
      if (isVirtualDevicePath(normalized)) return false;
      if (isKernelVirtualDirectory(normalized)) return true;
      if (isKernelVirtualFile(normalized)) return false;
      return super.isDirectory();
    }

    @Override
    public boolean isFile() {
      String normalized = normalizeVirtualPath(toPath());
      if (isVirtualDeviceDirectory(normalized)) return false;
      if (isVirtualDevicePath(normalized)) return KERNEL_DEVICES.get().containsKey(normalized);
      if (isKernelVirtualDirectory(normalized)) return false;
      if (isKernelVirtualFile(normalized)) return true;
      return super.isFile();
    }

    @Override
    public boolean canRead() {
      String normalized = normalizeVirtualPath(toPath());
      if (isVirtualDeviceDirectory(normalized)) return true;
      if (isVirtualDevicePath(normalized)) {
        KernelDevice device = KERNEL_DEVICES.get().get(normalized);
        return device != null && device.readable;
      }
      if (isKernelVirtualDirectory(normalized) || isKernelVirtualFile(normalized)) return true;
      return super.canRead();
    }

    @Override
    public boolean canWrite() {
      String normalized = normalizeVirtualPath(toPath());
      if (isVirtualDeviceDirectory(normalized)) return false;
      if (isVirtualDevicePath(normalized)) {
        KernelDevice device = KERNEL_DEVICES.get().get(normalized);
        return device != null && device.writable;
      }
      if (isKernelVirtualNamespacePath(normalized)) return false;
      return super.canWrite();
    }

    @Override
    public long length() {
      String normalized = normalizeVirtualPath(toPath());
      if (isKernelVirtualFile(normalized)) return KERNEL_VIRTUAL_FILES.get().get(normalized).length;
      if (isVirtualDeviceNamespacePath(normalized)) return 0L;
      return super.length();
    }

    @Override
    public String[] list() {
      String normalized = normalizeVirtualPath(toPath());
      if (isVirtualDeviceDirectory(normalized)) return kernelDeviceDirectoryNames(normalized);
      if (isVirtualDevicePath(normalized)) return null;
      if (isKernelVirtualDirectory(normalized)) return kernelVirtualDirectoryNames(normalized);
      if (isKernelVirtualFile(normalized)) return null;
      return super.list();
    }

    @Override
    public String[] list(FilenameFilter filter) {
      String normalized = normalizeVirtualPath(toPath());
      if (isVirtualDeviceDirectory(normalized)) {
        ArrayList<String> names = new ArrayList<>();
        for (String name : kernelDeviceDirectoryNames(normalized)) {
          if (filter == null || filter.accept(this, name)) names.add(name);
        }
        return names.toArray(new String[0]);
      }
      if (isVirtualDevicePath(normalized)) return null;
      if (isKernelVirtualDirectory(normalized)) {
        ArrayList<String> names = new ArrayList<>();
        for (String name : kernelVirtualDirectoryNames(normalized)) {
          if (filter == null || filter.accept(this, name)) names.add(name);
        }
        return names.toArray(new String[0]);
      }
      if (isKernelVirtualFile(normalized)) return null;
      return super.list(filter);
    }

    @Override
    public File[] listFiles() {
      String[] names = list();
      if (names == null) return null;
      File[] files = new File[names.length];
      for (int index = 0; index < names.length; index += 1) {
        files[index] = new ProjectFile(this, names[index]);
      }
      return files;
    }

    @Override
    public File[] listFiles(FilenameFilter filter) {
      String[] names = list(filter);
      if (names == null) return null;
      File[] files = new File[names.length];
      for (int index = 0; index < names.length; index += 1) {
        files[index] = new ProjectFile(this, names[index]);
      }
      return files;
    }

    @Override
    public File[] listFiles(FileFilter filter) {
      File[] files = listFiles();
      if (files == null) return null;
      ArrayList<File> accepted = new ArrayList<>();
      for (File file : files) {
        if (filter == null || filter.accept(file)) accepted.add(file);
      }
      return accepted.toArray(new File[0]);
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

    @Override
    public boolean setLastModified(long time) {
      try {
        assertWritableProjectPath(toPath());
      } catch (IOException error) {
        return false;
      }
      boolean result = super.setLastModified(time);
      if (result) emitPathSnapshot(toPath());
      return result;
    }

    @Override
    public boolean setReadOnly() {
      try {
        assertWritableProjectPath(toPath());
      } catch (IOException error) {
        return false;
      }
      boolean result = super.setReadOnly();
      if (result) emitPathSnapshot(toPath());
      return result;
    }

    @Override
    public boolean setWritable(boolean writable) {
      try {
        assertWritableProjectPath(toPath());
      } catch (IOException error) {
        return false;
      }
      boolean result = super.setWritable(writable);
      if (result) emitPathSnapshot(toPath());
      return result;
    }

    @Override
    public boolean setWritable(boolean writable, boolean ownerOnly) {
      try {
        assertWritableProjectPath(toPath());
      } catch (IOException error) {
        return false;
      }
      boolean result = super.setWritable(writable, ownerOnly);
      if (result) emitPathSnapshot(toPath());
      return result;
    }

    @Override
    public boolean setReadable(boolean readable) {
      try {
        assertWritableProjectPath(toPath());
      } catch (IOException error) {
        return false;
      }
      boolean result = super.setReadable(readable);
      if (result) emitPathSnapshot(toPath());
      return result;
    }

    @Override
    public boolean setReadable(boolean readable, boolean ownerOnly) {
      try {
        assertWritableProjectPath(toPath());
      } catch (IOException error) {
        return false;
      }
      boolean result = super.setReadable(readable, ownerOnly);
      if (result) emitPathSnapshot(toPath());
      return result;
    }

    @Override
    public boolean setExecutable(boolean executable) {
      try {
        assertWritableProjectPath(toPath());
      } catch (IOException error) {
        return false;
      }
      boolean result = super.setExecutable(executable);
      if (result) emitPathSnapshot(toPath());
      return result;
    }

    @Override
    public boolean setExecutable(boolean executable, boolean ownerOnly) {
      try {
        assertWritableProjectPath(toPath());
      } catch (IOException error) {
        return false;
      }
      boolean result = super.setExecutable(executable, ownerOnly);
      if (result) emitPathSnapshot(toPath());
      return result;
    }
  }

  private static final class ProjectOutputStream extends OutputStream {
    private final OutputStream delegate;
    private final Path path;
    private final boolean deleteOnClose;

    ProjectOutputStream(OutputStream delegate, Path path, boolean emitInitialSnapshot, boolean deleteOnClose) {
      this.delegate = delegate;
      this.path = path;
      this.deleteOnClose = deleteOnClose;
      if (emitInitialSnapshot) emitFileSnapshot(path);
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
      emitPostWritePathChange(path, deleteOnClose);
    }
  }

  private static final class ProjectSeekableByteChannel implements SeekableByteChannel {
    private final SeekableByteChannel delegate;
    private final Path path;
    private final boolean writable;
    private final boolean deleteOnClose;

    ProjectSeekableByteChannel(
        SeekableByteChannel delegate,
        Path path,
        boolean writable,
        boolean emitInitialSnapshot,
        boolean deleteOnClose
    ) {
      this.delegate = delegate;
      this.path = path;
      this.writable = writable;
      this.deleteOnClose = deleteOnClose;
      if (emitInitialSnapshot) emitFileSnapshot(path);
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
      if (writable || deleteOnClose) emitPostWritePathChange(path, deleteOnClose);
    }
  }

  private static final class ProjectBufferedWriter extends BufferedWriter {
    private final Path path;
    private final boolean deleteOnClose;

    ProjectBufferedWriter(Writer delegate, Path path, boolean emitInitialSnapshot, boolean deleteOnClose) {
      super(delegate);
      this.path = path;
      this.deleteOnClose = deleteOnClose;
      if (emitInitialSnapshot) emitFileSnapshot(path);
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
    public void write(char[] buffer, int offset, int length) throws IOException {
      super.write(buffer, offset, length);
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
      emitPostWritePathChange(path, deleteOnClose);
    }
  }

  public static final class ProjectPrintWriter extends PrintWriter {
    private final Path path;

    public ProjectPrintWriter(String fileName) throws IOException {
      super(printWriterOutput(Path.of(fileName), StandardCharsets.UTF_8));
      this.path = Path.of(fileName);
    }

    public ProjectPrintWriter(String fileName, String charsetName) throws IOException {
      super(printWriterOutput(Path.of(fileName), printWriterCharset(charsetName)));
      this.path = Path.of(fileName);
    }

    public ProjectPrintWriter(String fileName, Charset charset) throws IOException {
      super(printWriterOutput(Path.of(fileName), charset));
      this.path = Path.of(fileName);
    }

    public ProjectPrintWriter(File file) throws IOException {
      super(printWriterOutput(file == null ? null : file.toPath(), StandardCharsets.UTF_8));
      this.path = file.toPath();
    }

    public ProjectPrintWriter(File file, String charsetName) throws IOException {
      super(printWriterOutput(file == null ? null : file.toPath(), printWriterCharset(charsetName)));
      this.path = file.toPath();
    }

    public ProjectPrintWriter(File file, Charset charset) throws IOException {
      super(printWriterOutput(file == null ? null : file.toPath(), charset));
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

    private static Charset printWriterCharset(String charsetName) throws java.io.UnsupportedEncodingException {
      try {
        return Charset.forName(charsetName);
      } catch (IllegalArgumentException error) {
        java.io.UnsupportedEncodingException converted = new java.io.UnsupportedEncodingException(charsetName);
        converted.initCause(error);
        throw converted;
      }
    }

    private void emitAfterWrite() {
      if (path != null) flush();
    }

    @Override
    public void write(int value) {
      super.write(value);
      emitAfterWrite();
    }

    @Override
    public void write(char[] buffer, int offset, int length) {
      super.write(buffer, offset, length);
      emitAfterWrite();
    }

    @Override
    public void write(String text, int offset, int length) {
      super.write(text, offset, length);
      emitAfterWrite();
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

  private static final class ProjectHttpUrlStreamHandlerFactory implements URLStreamHandlerFactory {
    @Override
    public URLStreamHandler createURLStreamHandler(String protocol) {
      if ("http".equalsIgnoreCase(protocol)) {
        return new ProjectHttpUrlStreamHandler();
      }
      return null;
    }
  }

  private static final class ProjectHttpUrlStreamHandler extends URLStreamHandler {
    @Override
    protected URLConnection openConnection(URL url) throws IOException {
      return new ProjectHttpURLConnection(url);
    }
  }

  public static final class ProjectHttpServer extends HttpServer {
    private final Map<String, ProjectHttpContext> contexts = new HashMap<>();
    private Executor executor;
    private InetSocketAddress address;
    private boolean bound = false;
    private boolean started = false;
    private volatile boolean externalRunning = false;
    private String externalServerId = "";
    private Thread externalThread;

    @Override
    public synchronized void bind(InetSocketAddress address, int backlog) throws IOException {
      if (bound) throw new IOException("HttpServer is already bound");
      InetSocketAddress requested = address == null ? new InetSocketAddress(0) : address;
      int port = requested.getPort();
      if (port <= 0) {
        synchronized (PROJECT_HTTP_SERVERS) {
          port = NEXT_PROJECT_HTTP_PORT++;
        }
      }
      String host = requested.getHostString();
      if (host == null || host.isEmpty() || "0.0.0.0".equals(host)) host = "127.0.0.1";
      this.address = new InetSocketAddress(host, port);
      this.bound = true;
    }

    @Override
    public synchronized void start() {
      if (!bound) {
        try {
          bind(new InetSocketAddress(0), 0);
        } catch (IOException error) {
          throw new IllegalStateException(error);
        }
      }
      synchronized (PROJECT_HTTP_SERVERS) {
        PROJECT_HTTP_SERVERS.put(address.getPort(), this);
      }
      started = true;
      startExternalBridge();
    }

    @Override
    public void setExecutor(Executor executor) {
      this.executor = executor;
    }

    @Override
    public Executor getExecutor() {
      return executor;
    }

    @Override
    public synchronized void stop(int delay) {
      if (address != null) {
        synchronized (PROJECT_HTTP_SERVERS) {
          if (PROJECT_HTTP_SERVERS.get(address.getPort()) == this) {
            PROJECT_HTTP_SERVERS.remove(address.getPort());
          }
        }
      }
      started = false;
      externalRunning = false;
      if (externalServerId != null && !externalServerId.isEmpty()) {
        try {
          closeHttpServerNative(externalServerId);
        } catch (UnsatisfiedLinkError | SecurityException ignored) {
        }
      }
      externalServerId = "";
    }

    @Override
    public synchronized HttpContext createContext(String path, HttpHandler handler) {
      if (handler == null) throw new NullPointerException("handler");
      ProjectHttpContext context = (ProjectHttpContext) createContext(path);
      context.setHandler(handler);
      return context;
    }

    @Override
    public synchronized HttpContext createContext(String path) {
      String normalized = normalizeHttpContextPath(path);
      ProjectHttpContext context = new ProjectHttpContext(this, normalized);
      contexts.put(normalized, context);
      return context;
    }

    @Override
    public synchronized void removeContext(String path) throws IllegalArgumentException {
      String normalized = normalizeHttpContextPath(path);
      if (contexts.remove(normalized) == null) {
        throw new IllegalArgumentException("No such context: " + path);
      }
    }

    @Override
    public synchronized void removeContext(HttpContext context) {
      if (!(context instanceof ProjectHttpContext)) throw new IllegalArgumentException("Unknown context");
      contexts.values().remove(context);
    }

    @Override
    public synchronized InetSocketAddress getAddress() {
      return address == null ? new InetSocketAddress(0) : address;
    }

    private synchronized ProjectHttpContext contextForPath(String path) {
      ProjectHttpContext best = null;
      for (ProjectHttpContext context : contexts.values()) {
        String contextPath = context.getPath();
        if (path.equals(contextPath) || path.startsWith(contextPath.endsWith("/") ? contextPath : contextPath + "/")) {
          if (best == null || contextPath.length() > best.getPath().length()) best = context;
        }
      }
      return best;
    }

    private TraceKernelHttpResponse dispatch(String method, URI uri, Map<String, List<String>> headers, byte[] body)
        throws IOException {
      if (!started) return new TraceKernelHttpResponse(503, rawHeaders(Map.of("content-type", List.of("text/plain"))), "server stopped".getBytes(StandardCharsets.UTF_8));
      ProjectHttpContext context = contextForPath(uri.getPath() == null || uri.getPath().isEmpty() ? "/" : uri.getPath());
      if (context == null || context.getHandler() == null) {
        return new TraceKernelHttpResponse(404, rawHeaders(Map.of("content-type", List.of("text/plain"))), "not found".getBytes(StandardCharsets.UTF_8));
      }
      ProjectHttpExchange exchange = new ProjectHttpExchange(this, context, method, uri, headers, body);
      context.getHandler().handle(exchange);
      return exchange.toResponse();
    }

    private void startExternalBridge() {
      String registered;
      try {
        registered = registerHttpServerNative(address.getHostString(), address.getPort());
      } catch (UnsatisfiedLinkError | SecurityException ignored) {
        return;
      }
      if (registered == null || !registered.startsWith("OK\n")) return;
      externalServerId = registered.substring(3).trim();
      if (externalServerId.isEmpty()) return;
      externalRunning = true;
      externalThread = new Thread(() -> {
        while (externalRunning) {
          String requestManifest;
          try {
            requestManifest = pollHttpServerRequestNative(externalServerId);
          } catch (UnsatisfiedLinkError | SecurityException error) {
            return;
          }
          if (requestManifest == null || requestManifest.startsWith("ERROR\n")) {
            return;
          }
          String responseManifest;
          try {
            ProjectHttpServerRequest request = httpRequestFromManifest(requestManifest);
            responseManifest = httpResponseManifest(dispatch(request.method, request.uri, request.headers, request.body));
          } catch (Exception error) {
            responseManifest = httpErrorResponseManifest(error instanceof IOException ? error.getMessage() : String.valueOf(error));
          }
          try {
            completeHttpServerRequestNative(externalServerId, responseManifest);
          } catch (UnsatisfiedLinkError | SecurityException error) {
            return;
          }
        }
      }, "TraceKernel-Java-HttpServer");
      externalThread.setDaemon(false);
      externalThread.start();
    }
  }

  public static final class ProjectHttpContext extends HttpContext {
    private final ProjectHttpServer server;
    private final String path;
    private final Map<String, Object> attributes = new HashMap<>();
    private final List<Filter> filters = new ArrayList<>();
    private HttpHandler handler;
    private com.sun.net.httpserver.Authenticator authenticator;

    ProjectHttpContext(ProjectHttpServer server, String path) {
      this.server = server;
      this.path = path;
    }

    @Override
    public HttpHandler getHandler() {
      return handler;
    }

    @Override
    public void setHandler(HttpHandler handler) {
      this.handler = handler;
    }

    @Override
    public String getPath() {
      return path;
    }

    @Override
    public HttpServer getServer() {
      return server;
    }

    @Override
    public Map<String, Object> getAttributes() {
      return attributes;
    }

    @Override
    public List<Filter> getFilters() {
      return filters;
    }

    @Override
    public com.sun.net.httpserver.Authenticator setAuthenticator(com.sun.net.httpserver.Authenticator authenticator) {
      com.sun.net.httpserver.Authenticator previous = this.authenticator;
      this.authenticator = authenticator;
      return previous;
    }

    @Override
    public com.sun.net.httpserver.Authenticator getAuthenticator() {
      return authenticator;
    }
  }

  private static final class ProjectHttpExchange extends HttpExchange {
    private final ProjectHttpServer server;
    private final ProjectHttpContext context;
    private final Headers requestHeaders = new Headers();
    private final Headers responseHeaders = new Headers();
    private final URI uri;
    private final String method;
    private final ByteArrayInputStream requestBody;
    private final ByteArrayOutputStream responseBody = new ByteArrayOutputStream();
    private final Map<String, Object> attributes = new HashMap<>();
    private int responseCode = -1;

    ProjectHttpExchange(ProjectHttpServer server, ProjectHttpContext context, String method, URI uri, Map<String, List<String>> headers, byte[] body) {
      this.server = server;
      this.context = context;
      this.method = method == null ? "GET" : method;
      this.uri = uri;
      for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
        requestHeaders.put(entry.getKey(), new ArrayList<>(entry.getValue()));
      }
      requestBody = new ByteArrayInputStream(body == null ? new byte[0] : body);
    }

    @Override
    public Headers getRequestHeaders() {
      return requestHeaders;
    }

    @Override
    public Headers getResponseHeaders() {
      return responseHeaders;
    }

    @Override
    public URI getRequestURI() {
      return uri;
    }

    @Override
    public String getRequestMethod() {
      return method;
    }

    @Override
    public HttpContext getHttpContext() {
      return context;
    }

    @Override
    public void close() {}

    @Override
    public InputStream getRequestBody() {
      return requestBody;
    }

    @Override
    public OutputStream getResponseBody() {
      return responseBody;
    }

    @Override
    public void sendResponseHeaders(int responseCode, long responseLength) {
      this.responseCode = responseCode;
      if (responseLength >= 0) responseHeaders.set("content-length", Long.toString(responseLength));
    }

    @Override
    public InetSocketAddress getRemoteAddress() {
      return new InetSocketAddress("127.0.0.1", 0);
    }

    @Override
    public int getResponseCode() {
      return responseCode;
    }

    @Override
    public InetSocketAddress getLocalAddress() {
      return server.getAddress();
    }

    @Override
    public String getProtocol() {
      return "HTTP/1.1";
    }

    @Override
    public Object getAttribute(String name) {
      return attributes.get(name);
    }

    @Override
    public void setAttribute(String name, Object value) {
      attributes.put(name, value);
    }

    @Override
    public void setStreams(InputStream input, OutputStream output) {}

    @Override
    public HttpPrincipal getPrincipal() {
      return null;
    }

    TraceKernelHttpResponse toResponse() {
      int status = responseCode <= 0 ? 200 : responseCode;
      return new TraceKernelHttpResponse(status, rawHeaders(responseHeaders), responseBody.toByteArray());
    }
  }

  public static final class ProjectHttpClientBuilder implements HttpClient.Builder {
    private CookieHandler cookieHandler;
    private Duration connectTimeout;
    private SSLContext sslContext;
    private SSLParameters sslParameters;
    private Executor executor;
    private HttpClient.Redirect followRedirects = HttpClient.Redirect.NEVER;
    private HttpClient.Version version = HttpClient.Version.HTTP_1_1;
    private ProxySelector proxy;
    private Authenticator authenticator;

    @Override
    public HttpClient.Builder cookieHandler(CookieHandler cookieHandler) {
      this.cookieHandler = cookieHandler;
      return this;
    }

    @Override
    public HttpClient.Builder connectTimeout(Duration duration) {
      this.connectTimeout = duration;
      return this;
    }

    @Override
    public HttpClient.Builder sslContext(SSLContext sslContext) {
      this.sslContext = sslContext;
      return this;
    }

    @Override
    public HttpClient.Builder sslParameters(SSLParameters sslParameters) {
      this.sslParameters = sslParameters;
      return this;
    }

    @Override
    public HttpClient.Builder executor(Executor executor) {
      this.executor = executor;
      return this;
    }

    @Override
    public HttpClient.Builder followRedirects(HttpClient.Redirect policy) {
      this.followRedirects = policy == null ? HttpClient.Redirect.NEVER : policy;
      return this;
    }

    @Override
    public HttpClient.Builder version(HttpClient.Version version) {
      this.version = version == null ? HttpClient.Version.HTTP_1_1 : version;
      return this;
    }

    @Override
    public HttpClient.Builder priority(int priority) {
      return this;
    }

    @Override
    public HttpClient.Builder proxy(ProxySelector proxySelector) {
      this.proxy = proxySelector;
      return this;
    }

    @Override
    public HttpClient.Builder authenticator(Authenticator authenticator) {
      this.authenticator = authenticator;
      return this;
    }

    @Override
    public HttpClient build() {
      return new ProjectHttpClient(this);
    }
  }

  public static final class ProjectHttpClient extends HttpClient {
    private final Optional<CookieHandler> cookieHandler;
    private final Optional<Duration> connectTimeout;
    private final SSLContext sslContext;
    private final SSLParameters sslParameters;
    private final Optional<Executor> executor;
    private final HttpClient.Redirect followRedirects;
    private final HttpClient.Version version;
    private final Optional<ProxySelector> proxy;
    private final Optional<Authenticator> authenticator;

    private ProjectHttpClient(ProjectHttpClientBuilder builder) {
      this.cookieHandler = Optional.ofNullable(builder.cookieHandler);
      this.connectTimeout = Optional.ofNullable(builder.connectTimeout);
      this.sslContext = builder.sslContext == null ? defaultSslContext() : builder.sslContext;
      this.sslParameters = builder.sslParameters == null ? this.sslContext.getDefaultSSLParameters() : builder.sslParameters;
      this.executor = Optional.ofNullable(builder.executor);
      this.followRedirects = builder.followRedirects;
      this.version = builder.version;
      this.proxy = Optional.ofNullable(builder.proxy);
      this.authenticator = Optional.ofNullable(builder.authenticator);
    }

    @Override
    public Optional<CookieHandler> cookieHandler() {
      return cookieHandler;
    }

    @Override
    public Optional<Duration> connectTimeout() {
      return connectTimeout;
    }

    @Override
    public HttpClient.Redirect followRedirects() {
      return followRedirects;
    }

    @Override
    public Optional<ProxySelector> proxy() {
      return proxy;
    }

    @Override
    public SSLContext sslContext() {
      return sslContext;
    }

    @Override
    public SSLParameters sslParameters() {
      return sslParameters;
    }

    @Override
    public Optional<Authenticator> authenticator() {
      return authenticator;
    }

    @Override
    public HttpClient.Version version() {
      return version;
    }

    @Override
    public Optional<Executor> executor() {
      return executor;
    }

    @Override
    public <T> HttpResponse<T> send(HttpRequest request, HttpResponse.BodyHandler<T> responseBodyHandler)
        throws IOException, InterruptedException {
      if (request == null) throw new NullPointerException("request");
      if (responseBodyHandler == null) throw new NullPointerException("responseBodyHandler");
      byte[] requestBody = httpRequestBodyBytes(request);
      TraceKernelHttpResponse response = dispatchHttpRequest(
          request.method(),
          request.uri().toString(),
          httpRequestPath(request.uri()),
          request.headers().map(),
          requestBody,
          httpTimeoutMillis(request.timeout(), connectTimeout));
      HttpHeaders headers = httpHeaders(response.rawHeaders);
      ProjectHttpResponseInfo info = new ProjectHttpResponseInfo(response.status, headers, version);
      HttpResponse.BodySubscriber<T> subscriber = responseBodyHandler.apply(info);
      T body = httpBodyFromSubscriber(subscriber, response.body);
      return new ProjectHttpResponse<>(request, response.status, headers, body, request.uri(), version);
    }

    @Override
    public <T> CompletableFuture<HttpResponse<T>> sendAsync(
        HttpRequest request,
        HttpResponse.BodyHandler<T> responseBodyHandler) {
      return sendAsync(request, responseBodyHandler, null);
    }

    @Override
    public <T> CompletableFuture<HttpResponse<T>> sendAsync(
        HttpRequest request,
        HttpResponse.BodyHandler<T> responseBodyHandler,
        HttpResponse.PushPromiseHandler<T> pushPromiseHandler) {
      java.util.function.Supplier<HttpResponse<T>> supplier = () -> {
        try {
          return send(request, responseBodyHandler);
        } catch (IOException | InterruptedException error) {
          if (error instanceof InterruptedException) Thread.currentThread().interrupt();
          throw new CompletionException(error);
        }
      };
      return executor.map((value) -> CompletableFuture.supplyAsync(supplier, value))
          .orElseGet(() -> CompletableFuture.supplyAsync(supplier));
    }
  }

  public static final class ProjectHttpURLConnection extends HttpURLConnection {
    private final Map<String, List<String>> requestProperties = new HashMap<>();
    private final ByteArrayOutputStream requestBody = new ByteArrayOutputStream();
    private TraceKernelHttpResponse traceKernelResponse;

    public ProjectHttpURLConnection(URL url) {
      super(url);
    }

    @Override
    public void connect() throws IOException {
      ensureResponse();
    }

    @Override
    public void disconnect() {
      connected = false;
    }

    @Override
    public boolean usingProxy() {
      return false;
    }

    @Override
    public OutputStream getOutputStream() throws IOException {
      if (connected) throw new IOException("Already connected");
      doOutput = true;
      return requestBody;
    }

    @Override
    public InputStream getInputStream() throws IOException {
      ensureResponse();
      if (responseCode >= HTTP_BAD_REQUEST) {
        throw new IOException("HTTP request failed with status " + responseCode);
      }
      return new ByteArrayInputStream(traceKernelResponse.body);
    }

    @Override
    public InputStream getErrorStream() {
      try {
        ensureResponse();
      } catch (IOException ignored) {
        return null;
      }
      if (responseCode < HTTP_BAD_REQUEST) return null;
      return new ByteArrayInputStream(traceKernelResponse.body);
    }

    @Override
    public int getResponseCode() throws IOException {
      ensureResponse();
      return responseCode;
    }

    @Override
    public String getResponseMessage() throws IOException {
      ensureResponse();
      return responseMessage;
    }

    @Override
    public String getHeaderField(String name) {
      try {
        ensureResponse();
      } catch (IOException ignored) {
        return null;
      }
      if (name == null) return null;
      for (Map.Entry<String, List<String>> entry : traceKernelResponse.headers.entrySet()) {
        if (entry.getKey().equalsIgnoreCase(name) && !entry.getValue().isEmpty()) {
          return entry.getValue().get(entry.getValue().size() - 1);
        }
      }
      return null;
    }

    @Override
    public String getHeaderField(int index) {
      try {
        ensureResponse();
      } catch (IOException ignored) {
        return null;
      }
      if (index == 0) return "HTTP/1.1 " + responseCode;
      int headerIndex = index - 1;
      if (headerIndex < 0 || headerIndex >= traceKernelResponse.rawHeaders.size()) return null;
      return traceKernelResponse.rawHeaders.get(headerIndex)[1];
    }

    @Override
    public String getHeaderFieldKey(int index) {
      try {
        ensureResponse();
      } catch (IOException ignored) {
        return null;
      }
      if (index == 0) return null;
      int headerIndex = index - 1;
      if (headerIndex < 0 || headerIndex >= traceKernelResponse.rawHeaders.size()) return null;
      return traceKernelResponse.rawHeaders.get(headerIndex)[0];
    }

    @Override
    public Map<String, List<String>> getHeaderFields() {
      try {
        ensureResponse();
      } catch (IOException ignored) {
        return Collections.emptyMap();
      }
      return traceKernelResponse.headers;
    }

    @Override
    public String getContentType() {
      return getHeaderField("content-type");
    }

    @Override
    public int getContentLength() {
      long length = getContentLengthLong();
      return length > Integer.MAX_VALUE ? -1 : (int) length;
    }

    @Override
    public long getContentLengthLong() {
      String value = getHeaderField("content-length");
      if (value == null) return -1;
      try {
        return Long.parseLong(value.trim());
      } catch (NumberFormatException ignored) {
        return -1;
      }
    }

    @Override
    public void setRequestProperty(String key, String value) {
      if (connected) throw new IllegalStateException("Already connected");
      if (key == null) throw new NullPointerException("key");
      List<String> values = new ArrayList<>();
      values.add(value == null ? "" : value);
      requestProperties.put(key, values);
    }

    @Override
    public void addRequestProperty(String key, String value) {
      if (connected) throw new IllegalStateException("Already connected");
      if (key == null) throw new NullPointerException("key");
      requestProperties.computeIfAbsent(key, ignored -> new ArrayList<>()).add(value == null ? "" : value);
    }

    @Override
    public String getRequestProperty(String key) {
      List<String> values = requestProperties.get(key);
      if (values == null || values.isEmpty()) return null;
      return values.get(values.size() - 1);
    }

    @Override
    public Map<String, List<String>> getRequestProperties() {
      if (connected) throw new IllegalStateException("Already connected");
      Map<String, List<String>> copy = new HashMap<>();
      for (Map.Entry<String, List<String>> entry : requestProperties.entrySet()) {
        copy.put(entry.getKey(), Collections.unmodifiableList(new ArrayList<>(entry.getValue())));
      }
      return Collections.unmodifiableMap(copy);
    }

    private void ensureResponse() throws IOException {
      if (traceKernelResponse != null) return;
      traceKernelResponse = dispatchHttpRequest(this);
      responseCode = traceKernelResponse.status;
      responseMessage = "";
      connected = true;
    }
  }

  private static final class TraceKernelHttpResponse {
    final int status;
    final List<String[]> rawHeaders;
    final Map<String, List<String>> headers;
    final byte[] body;

    TraceKernelHttpResponse(int status, List<String[]> rawHeaders, byte[] body) {
      this.status = status;
      this.rawHeaders = Collections.unmodifiableList(rawHeaders);
      Map<String, List<String>> grouped = new HashMap<>();
      for (String[] header : rawHeaders) {
        grouped.computeIfAbsent(header[0], ignored -> new ArrayList<>()).add(header[1]);
      }
      Map<String, List<String>> immutable = new HashMap<>();
      for (Map.Entry<String, List<String>> entry : grouped.entrySet()) {
        immutable.put(entry.getKey(), Collections.unmodifiableList(entry.getValue()));
      }
      this.headers = Collections.unmodifiableMap(immutable);
      this.body = body == null ? new byte[0] : body;
    }
  }

  private static final class ProjectHttpServerRequest {
    final String method;
    final URI uri;
    final Map<String, List<String>> headers;
    final byte[] body;

    ProjectHttpServerRequest(String method, URI uri, Map<String, List<String>> headers, byte[] body) {
      this.method = method;
      this.uri = uri;
      this.headers = headers;
      this.body = body;
    }
  }

  private static TraceKernelHttpResponse dispatchHttpRequest(ProjectHttpURLConnection connection)
      throws IOException {
    return dispatchHttpRequest(
        connection.getRequestMethod(),
        connection.getURL().toString(),
        httpRequestPath(connection.getURL()),
        connection.requestProperties,
        connection.requestBody.toByteArray(),
        httpTimeoutMillis(connection.getReadTimeout(), connection.getConnectTimeout()));
  }

  private static TraceKernelHttpResponse dispatchHttpRequest(
      String method,
      String url,
      String path,
      Map<String, List<String>> headers,
      byte[] body,
      Long timeoutMs)
      throws IOException {
    TraceKernelHttpResponse localResponse = dispatchLocalHttpServer(method, url, headers, body);
    if (localResponse != null) return localResponse;
    String manifest;
    try {
      manifest = dispatchHttp(httpRequestJson(method, url, path, headers, body, timeoutMs));
    } catch (UnsatisfiedLinkError | SecurityException error) {
      throw new IOException("TraceKernel HTTP bridge is not available", error);
    }
    return httpResponseFromManifest(manifest);
  }

  private static TraceKernelHttpResponse dispatchLocalHttpServer(
      String method,
      String url,
      Map<String, List<String>> headers,
      byte[] body)
      throws IOException {
    URI uri;
    try {
      uri = URI.create(url);
    } catch (IllegalArgumentException error) {
      return null;
    }
    int port = uri.getPort();
    if (port < 0) return null;
    ProjectHttpServer server;
    synchronized (PROJECT_HTTP_SERVERS) {
      server = PROJECT_HTTP_SERVERS.get(port);
    }
    return server == null ? null : server.dispatch(method, uri, headers, body);
  }

  private static String dispatchHttp(String requestJson) throws IOException {
    ProjectHttpDispatcher dispatcher = HTTP_DISPATCHER_FOR_TESTING;
    return dispatcher == null ? dispatchHttpNative(requestJson) : dispatcher.dispatch(requestJson);
  }

  private static String httpRequestJson(
      String method,
      String url,
      String path,
      Map<String, List<String>> headers,
      byte[] body,
      Long timeoutMs) {
    StringBuilder builder = new StringBuilder();
    builder.append('{');
    appendJsonField(builder, "method", method, false);
    appendJsonField(builder, "url", url, true);
    appendJsonField(builder, "path", path, true);
    builder.append(",\"headers\":{");
    boolean firstHeader = true;
    for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
      if (!firstHeader) builder.append(',');
      firstHeader = false;
      builder.append(jsonString(entry.getKey())).append(':').append(jsonString(String.join(",", entry.getValue())));
    }
    builder.append('}');
    if (body != null && body.length > 0) {
      appendJsonField(builder, "body", Base64.getEncoder().encodeToString(body), true);
      appendJsonField(builder, "bodyEncoding", "base64", true);
    }
    if (timeoutMs != null && timeoutMs > 0) {
      builder.append(",\"_tracekernelTimeoutMs\":").append(timeoutMs.longValue());
    }
    builder.append('}');
    return builder.toString();
  }

  private static Long httpTimeoutMillis(Optional<Duration> requestTimeout, Optional<Duration> clientTimeout) {
    Duration timeout = requestTimeout.orElseGet(() -> clientTimeout.orElse(null));
    if (timeout == null) return null;
    long millis = timeout.toMillis();
    return millis <= 0 ? 1L : millis;
  }

  private static Long httpTimeoutMillis(int readTimeoutMs, int connectTimeoutMs) {
    int timeoutMs = readTimeoutMs > 0 ? readTimeoutMs : connectTimeoutMs;
    return timeoutMs > 0 ? Long.valueOf(timeoutMs) : null;
  }

  private static String httpRequestPath(URL url) {
    String file = url.getFile();
    if (file == null || file.isEmpty()) return "/";
    return file.startsWith("/") ? file : "/" + file;
  }

  private static String httpRequestPath(URI uri) {
    String rawPath = uri.getRawPath();
    String path = rawPath == null || rawPath.isEmpty() ? "/" : rawPath;
    String rawQuery = uri.getRawQuery();
    return rawQuery == null || rawQuery.isEmpty() ? path : path + "?" + rawQuery;
  }

  private static SSLContext defaultSslContext() {
    try {
      return SSLContext.getDefault();
    } catch (Exception error) {
      throw new IllegalStateException("Unable to initialize TraceKernel HTTP SSL context", error);
    }
  }

  private static HttpHeaders httpHeaders(List<String[]> rawHeaders) {
    Map<String, List<String>> map = new HashMap<>();
    for (String[] header : rawHeaders) {
      map.computeIfAbsent(header[0], ignored -> new ArrayList<>()).add(header[1]);
    }
    return HttpHeaders.of(map, (name, value) -> true);
  }

  private static List<String[]> rawHeaders(Map<String, List<String>> headers) {
    List<String[]> raw = new ArrayList<>();
    for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
      for (String value : entry.getValue()) {
        raw.add(new String[] {entry.getKey(), value});
      }
    }
    return raw;
  }

  private static String normalizeHttpContextPath(String path) {
    if (path == null || path.isEmpty() || !path.startsWith("/")) {
      throw new IllegalArgumentException("HttpServer context path must start with /");
    }
    return path;
  }

  private static byte[] httpRequestBodyBytes(HttpRequest request) throws IOException, InterruptedException {
    Optional<HttpRequest.BodyPublisher> bodyPublisher = request.bodyPublisher();
    if (bodyPublisher.isEmpty()) return new byte[0];
    CompletableFuture<byte[]> body = new CompletableFuture<>();
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    bodyPublisher.get().subscribe(new Flow.Subscriber<ByteBuffer>() {
      @Override
      public void onSubscribe(Flow.Subscription subscription) {
        subscription.request(Long.MAX_VALUE);
      }

      @Override
      public void onNext(ByteBuffer item) {
        byte[] bytes = new byte[item.remaining()];
        item.get(bytes);
        try {
          output.write(bytes);
        } catch (IOException error) {
          body.completeExceptionally(error);
        }
      }

      @Override
      public void onError(Throwable throwable) {
        body.completeExceptionally(throwable);
      }

      @Override
      public void onComplete() {
        body.complete(output.toByteArray());
      }
    });
    try {
      return body.get();
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw error;
    } catch (ExecutionException error) {
      Throwable cause = error.getCause();
      if (cause instanceof IOException) throw (IOException) cause;
      throw new IOException("Unable to read Java HTTP request body", cause);
    }
  }

  private static <T> T httpBodyFromSubscriber(HttpResponse.BodySubscriber<T> subscriber, byte[] body)
      throws IOException {
    subscriber.onSubscribe(new Flow.Subscription() {
      @Override
      public void request(long count) {}

      @Override
      public void cancel() {}
    });
    if (body != null && body.length > 0) {
      subscriber.onNext(Collections.singletonList(ByteBuffer.wrap(body)));
    }
    subscriber.onComplete();
    try {
      return subscriber.getBody().toCompletableFuture().get();
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IOException("Interrupted while reading Java HTTP response body", error);
    } catch (ExecutionException error) {
      Throwable cause = error.getCause();
      if (cause instanceof IOException) throw (IOException) cause;
      throw new IOException("Unable to read Java HTTP response body", cause);
    }
  }

  private static final class ProjectHttpResponseInfo implements HttpResponse.ResponseInfo {
    private final int status;
    private final HttpHeaders headers;
    private final HttpClient.Version version;

    ProjectHttpResponseInfo(int status, HttpHeaders headers, HttpClient.Version version) {
      this.status = status;
      this.headers = headers;
      this.version = version;
    }

    @Override
    public int statusCode() {
      return status;
    }

    @Override
    public HttpHeaders headers() {
      return headers;
    }

    @Override
    public HttpClient.Version version() {
      return version;
    }
  }

  private static final class ProjectHttpResponse<T> implements HttpResponse<T> {
    private final HttpRequest request;
    private final int status;
    private final HttpHeaders headers;
    private final T body;
    private final URI uri;
    private final HttpClient.Version version;

    ProjectHttpResponse(HttpRequest request, int status, HttpHeaders headers, T body, URI uri, HttpClient.Version version) {
      this.request = request;
      this.status = status;
      this.headers = headers;
      this.body = body;
      this.uri = uri;
      this.version = version;
    }

    @Override
    public int statusCode() {
      return status;
    }

    @Override
    public HttpRequest request() {
      return request;
    }

    @Override
    public Optional<HttpResponse<T>> previousResponse() {
      return Optional.empty();
    }

    @Override
    public HttpHeaders headers() {
      return headers;
    }

    @Override
    public T body() {
      return body;
    }

    @Override
    public Optional<SSLSession> sslSession() {
      return Optional.empty();
    }

    @Override
    public URI uri() {
      return uri;
    }

    @Override
    public HttpClient.Version version() {
      return version;
    }
  }

  private static void appendJsonField(StringBuilder builder, String name, String value, boolean prependComma) {
    if (prependComma) builder.append(',');
    builder.append(jsonString(name)).append(':').append(jsonString(value == null ? "" : value));
  }

  private static String jsonString(String value) {
    StringBuilder builder = new StringBuilder();
    builder.append('"');
    for (int index = 0; index < value.length(); index += 1) {
      char ch = value.charAt(index);
      switch (ch) {
        case '"':
          builder.append("\\\"");
          break;
        case '\\':
          builder.append("\\\\");
          break;
        case '\b':
          builder.append("\\b");
          break;
        case '\f':
          builder.append("\\f");
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

  private static TraceKernelHttpResponse httpResponseFromManifest(String manifest) throws IOException {
    if (manifest == null || manifest.isEmpty()) {
      throw new IOException("TraceKernel HTTP returned an empty response");
    }
    String[] lines = manifest.split("\\n", -1);
    if ("ERROR".equals(lines[0])) {
      String message = lines.length > 1 ? decodeBase64Text(lines[1]) : "TraceKernel HTTP request failed";
      throw new IOException(message);
    }
    if (!"OK".equals(lines[0]) || lines.length < 4) {
      throw new IOException("TraceKernel HTTP returned an invalid response");
    }
    int status;
    int headerCount;
    try {
      status = Integer.parseInt(lines[1]);
      headerCount = Integer.parseInt(lines[2]);
    } catch (NumberFormatException error) {
      throw new IOException("TraceKernel HTTP returned an invalid status", error);
    }
    if (status < 100 || status > 999 || headerCount < 0 || lines.length < 4 + headerCount) {
      throw new IOException("TraceKernel HTTP returned an invalid response");
    }
    List<String[]> headers = new ArrayList<>();
    for (int index = 0; index < headerCount; index += 1) {
      String[] pair = lines[3 + index].split("\\t", -1);
      if (pair.length != 2) throw new IOException("TraceKernel HTTP returned an invalid header");
      headers.add(new String[] {decodeBase64Text(pair[0]), decodeBase64Text(pair[1])});
    }
    byte[] body;
    try {
      body = Base64.getDecoder().decode(lines[3 + headerCount]);
    } catch (IllegalArgumentException error) {
      throw new IOException("TraceKernel HTTP returned an invalid body", error);
    }
    return new TraceKernelHttpResponse(status, headers, body);
  }

  private static ProjectHttpServerRequest httpRequestFromManifest(String manifest) throws IOException {
    if (manifest == null || manifest.isEmpty()) throw new IOException("TraceKernel HTTP returned an empty request");
    String[] lines = manifest.split("\\n", -1);
    if (!"REQUEST".equals(lines[0]) || lines.length < 6) throw new IOException("TraceKernel HTTP returned an invalid request");
    String method = decodeBase64Text(lines[1]);
    URI uri = URI.create(decodeBase64Text(lines[2]));
    int headerCount;
    try {
      headerCount = Integer.parseInt(lines[4]);
    } catch (NumberFormatException error) {
      throw new IOException("TraceKernel HTTP returned invalid request headers", error);
    }
    if (headerCount < 0 || lines.length < 6 + headerCount) throw new IOException("TraceKernel HTTP returned an invalid request");
    Map<String, List<String>> headers = new HashMap<>();
    for (int index = 0; index < headerCount; index += 1) {
      String[] pair = lines[5 + index].split("\\t", -1);
      if (pair.length != 2) throw new IOException("TraceKernel HTTP returned an invalid request header");
      headers.computeIfAbsent(decodeBase64Text(pair[0]), ignored -> new ArrayList<>()).add(decodeBase64Text(pair[1]));
    }
    byte[] body;
    try {
      body = Base64.getDecoder().decode(lines[5 + headerCount]);
    } catch (IllegalArgumentException error) {
      throw new IOException("TraceKernel HTTP returned an invalid request body", error);
    }
    return new ProjectHttpServerRequest(method, uri, headers, body);
  }

  private static String httpResponseManifest(TraceKernelHttpResponse response) {
    List<String> lines = new ArrayList<>();
    lines.add("OK");
    lines.add(Integer.toString(response.status));
    lines.add(Integer.toString(response.rawHeaders.size()));
    for (String[] header : response.rawHeaders) {
      lines.add(Base64.getEncoder().encodeToString(header[0].getBytes(StandardCharsets.UTF_8))
          + "\t"
          + Base64.getEncoder().encodeToString(header[1].getBytes(StandardCharsets.UTF_8)));
    }
    lines.add(Base64.getEncoder().encodeToString(response.body));
    return String.join("\n", lines);
  }

  private static String httpErrorResponseManifest(String message) {
    return httpResponseManifest(new TraceKernelHttpResponse(
        500,
        rawHeaders(Map.of("content-type", List.of("text/plain"))),
        ((message == null || message.isEmpty() ? "Java HTTP server request failed" : message) + "\n").getBytes(StandardCharsets.UTF_8)));
  }

  private static String decodeBase64Text(String encoded) throws IOException {
    try {
      return new String(Base64.getDecoder().decode(encoded), StandardCharsets.UTF_8);
    } catch (IllegalArgumentException error) {
      throw new IOException("TraceKernel HTTP returned invalid text", error);
    }
  }

  private static void emitOutput(String stream, String data) {
    emitOutput(stream, data, "", "");
  }

  private static void emitOutput(String stream, String data, String sourceDevice) {
    emitOutput(stream, data, sourceDevice, "");
  }

  private static void emitOutput(String stream, String data, String sourceDevice, String outputDevice) {
    emitOutput(currentProjectBridgeRunId(), stream, data, sourceDevice, outputDevice);
  }

  private static void emitOutput(String bridgeRunId, String stream, String data, String sourceDevice, String outputDevice) {
    if (!projectRunActiveForCurrentThread() || data.isEmpty()) return;
    if (bridgeRunId == null || bridgeRunId.isEmpty()) return;
    try {
      emitOutputNative(
          bridgeRunId,
          stream,
          data,
          sourceDevice == null ? "" : sourceDevice,
          outputDevice == null ? "" : outputDevice);
    } catch (UnsatisfiedLinkError | SecurityException ignored) {
      // Host JVM tests and older browser runtimes may not expose the CheerpJ native bridge.
    }
  }

  private static native void emitOutputNative(String bridgeRunId, String stream, String data, String sourceDevice, String outputDevice);
  private static native void emitFileSnapshotNative(String bridgeRunId, String path, String contents);
  private static native void emitFileDeleteNative(String bridgeRunId, String path);
  private static native void emitDirectoryCreateNative(String bridgeRunId, String path);
  private static native void emitDirectoryDeleteNative(String bridgeRunId, String path);
  private static native int readInputNative(String device);
  private static native int readInputAvailableNative(String device);
  private static native int inputAvailableNative(String device);
  private static native String dispatchHttpNative(String requestJson);
  private static native String registerHttpServerNative(String host, int port);
  private static native String pollHttpServerRequestNative(String serverId);
  private static native void completeHttpServerRequestNative(String serverId, String responseManifest);
  private static native void closeHttpServerNative(String serverId);

  private static Map<String, KernelDevice> parseKernelDevices(String manifest) {
    Map<String, KernelDevice> devices = new HashMap<>();
    if (manifest == null || manifest.isEmpty()) return devices;
    String[] lines = manifest.split("\\n");
    for (String line : lines) {
      if (line.isEmpty()) continue;
      String[] fields = line.split("\\t", -1);
      if (fields.length < 5) continue;
      String path = normalizeKernelDeviceReference(decodeManifestField(fields[0]));
      if (path == null) continue;
      String inputDevice = normalizeKernelDeviceReference(decodeManifestField(fields[3]));
      String outputDevice = normalizeKernelDeviceReference(decodeManifestField(fields[4]));
      devices.put(path, new KernelDevice(
          path,
          "1".equals(decodeManifestField(fields[1])),
          "1".equals(decodeManifestField(fields[2])),
          inputDevice == null ? "" : inputDevice,
          outputDevice == null ? "" : outputDevice));
    }
    return devices;
  }

  private static Map<String, byte[]> parseKernelFilePaths(String manifest) {
    Map<String, byte[]> files = new HashMap<>();
    if (manifest == null || manifest.isEmpty()) return files;
    String[] lines = manifest.split("\\n");
    for (String line : lines) {
      if (line.isEmpty()) continue;
      String[] fields = line.split("\\t", -1);
      if (fields.length < 2) continue;
      String path = decodeManifestField(fields[0]);
      String normalized = normalizeVirtualString(path);
      if (normalized == null || !normalized.startsWith("/") || isVirtualDeviceNamespacePath(normalized)) continue;
      files.put(normalized, Base64.getDecoder().decode(fields[1]));
    }
    return files;
  }

  private static Map<String, String> parseEnvironment(String manifest) {
    Map<String, String> env = new HashMap<>();
    if (manifest == null || manifest.isEmpty()) return env;
    String[] lines = manifest.split("\\n");
    for (String line : lines) {
      if (line.isEmpty()) continue;
      String[] fields = line.split("\\t", -1);
      if (fields.length < 2) continue;
      String key = decodeManifestField(fields[0]);
      if (key == null || key.isEmpty() || key.indexOf('\0') >= 0 || key.indexOf('=') >= 0) continue;
      env.put(key, decodeManifestField(fields[1]));
    }
    return env;
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

  private static KernelDevice readableKernelDevice(FileDescriptor fdObj) {
    KernelDevice device = kernelDevice(fdObj);
    return device != null && device.readable ? device : null;
  }

  private static KernelDevice writableKernelDevice(FileDescriptor fdObj) {
    KernelDevice device = kernelDevice(fdObj);
    return device != null && device.writable ? device : null;
  }

  private static KernelDevice kernelDevice(Path path) {
    String normalized = normalizeVirtualPath(path);
    if (!isVirtualDevicePath(normalized)) return null;
    return KERNEL_DEVICES.get().get(normalized);
  }

  private static KernelDevice kernelDevice(FileDescriptor fdObj) {
    if (fdObj == FileDescriptor.in) return KERNEL_DEVICES.get().get("/dev/stdin");
    if (fdObj == FileDescriptor.out) return KERNEL_DEVICES.get().get("/dev/stdout");
    if (fdObj == FileDescriptor.err) return KERNEL_DEVICES.get().get("/dev/stderr");
    return null;
  }

  private static ArrayList<Path> kernelDevicePaths() {
    ArrayList<String> devices = new ArrayList<>(KERNEL_DEVICES.get().keySet());
    Collections.sort(devices);
    ArrayList<Path> paths = new ArrayList<>();
    for (String device : devices) paths.add(Path.of(device));
    return paths;
  }

  private static ArrayList<Path> kernelDeviceDirectoryPaths(String normalized) {
    ArrayList<Path> paths = new ArrayList<>();
    for (String name : kernelDeviceDirectoryNames(normalized)) {
      paths.add(Path.of(("/".equals(normalized) ? "" : normalized) + "/" + name));
    }
    return paths;
  }

  private static String[] kernelDeviceNames() {
    return kernelDeviceDirectoryNames("/dev");
  }

  private static String[] kernelDeviceDirectoryNames(String normalized) {
    String prefix = normalized.endsWith("/") ? normalized : normalized + "/";
    ArrayList<String> names = new ArrayList<>();
    for (String device : KERNEL_DEVICES.get().keySet()) {
      if (!device.startsWith(prefix)) continue;
      String remaining = device.substring(prefix.length());
      if (remaining.isEmpty()) continue;
      int slash = remaining.indexOf('/');
      String name = slash < 0 ? remaining : remaining.substring(0, slash);
      if (!names.contains(name)) names.add(name);
    }
    Collections.sort(names);
    return names.toArray(new String[0]);
  }

  private static String normalizeVirtualPath(Path path) {
    if (path == null) return null;
    String normalized = normalizeVirtualString(path.toString());
    String relative = virtualWorkspaceRelativePath(normalized);
    Path workspaceRoot = PROJECT_WORKSPACE_ROOT.get();
    if (relative == null || workspaceRoot == null) return normalized;
    return resolveWorkspaceRelativePath(workspaceRoot, relative, normalized).toString().replace('\\', '/');
  }

  private static String normalizeVirtualString(String value) {
    if (value == null) return null;
    String normalized = value.replace('\\', '/');
    while (normalized.endsWith("/") && normalized.length() > 1) {
      normalized = normalized.substring(0, normalized.length() - 1);
    }
    return normalized.isEmpty() ? "/" : normalized;
  }

  private static String normalizeKernelAbsoluteString(String value) {
    if (value == null) return null;
    String raw = value.replace('\\', '/');
    if (!raw.startsWith("/")) return null;
    ArrayList<String> parts = new ArrayList<>();
    for (String part : raw.split("/")) {
      if (part.isEmpty() || ".".equals(part)) continue;
      if ("..".equals(part)) {
        if (!parts.isEmpty()) parts.remove(parts.size() - 1);
      } else {
        parts.add(part);
      }
    }
    return "/" + String.join("/", parts);
  }

  private static String normalizeKernelDeviceReference(String value) {
    String normalized = normalizeKernelAbsoluteString(value);
    if (normalized == null || "/dev".equals(normalized) || !normalized.startsWith("/dev/")) return null;
    return normalized.length() > "/dev/".length() ? normalized : null;
  }

  private static String virtualWorkspaceRelativePath(String normalized) {
    if (normalized == null) return null;
    for (String root : new String[] { PROJECT_VIRTUAL_WORKSPACE_ROOT.get(), PROJECT_WORKSPACE_ALIAS.get() }) {
      if (root == null || root.isEmpty()) continue;
      if (normalized.equals(root)) return "";
      if (normalized.startsWith(root + "/")) return normalized.substring(root.length() + 1);
    }
    return null;
  }

  private static Path runtimePath(Path path) {
    if (path == null) return null;
    Path workspaceRoot = PROJECT_WORKSPACE_ROOT.get();
    if (workspaceRoot == null) return path;
    if (!path.isAbsolute()) {
      String userDir = System.getProperty("user.dir");
      String cwdRelative = virtualWorkspaceRelativePath(normalizeVirtualString(userDir));
      Path runtimeCwd = cwdRelative == null || cwdRelative.isEmpty()
          ? workspaceRoot
          : resolveWorkspaceRelativePath(workspaceRoot, cwdRelative, userDir);
      return requireWorkspacePath(workspaceRoot, runtimeCwd.resolve(path).normalize(), path.toString());
    }
    String normalized = normalizeVirtualString(path.toString());
    String relative = virtualWorkspaceRelativePath(normalized);
    if (relative == null) return path;
    return resolveWorkspaceRelativePath(workspaceRoot, relative, normalized);
  }

  private static Path resolveWorkspaceRelativePath(Path workspaceRoot, String relative, String sourcePath) {
    Path resolved = relative == null || relative.isEmpty()
        ? workspaceRoot
        : workspaceRoot.resolve(relative).normalize();
    return requireWorkspacePath(workspaceRoot, resolved, sourcePath);
  }

  private static Path requireWorkspacePath(Path workspaceRoot, Path resolved, String sourcePath) {
    Path normalizedRoot = workspaceRoot.toAbsolutePath().normalize();
    Path normalizedPath = resolved.toAbsolutePath().normalize();
    if (!normalizedPath.startsWith(normalizedRoot)) {
      throw new SecurityException("Path must not escape the project workspace: " + sourcePath);
    }
    return normalizedPath;
  }

  private static boolean isVirtualDeviceDirectory(String normalized) {
    if ("/dev".equals(normalized)) return true;
    if (normalized == null || !normalized.startsWith("/dev/")) return false;
    String prefix = normalized.endsWith("/") ? normalized : normalized + "/";
    for (String device : KERNEL_DEVICES.get().keySet()) {
      if (device.startsWith(prefix)) return true;
    }
    return false;
  }

  private static boolean isVirtualDevicePath(String normalized) {
    return normalized != null && normalized.startsWith("/dev/");
  }

  private static boolean isVirtualDeviceNamespacePath(String normalized) {
    return isVirtualDeviceDirectory(normalized) || isVirtualDevicePath(normalized);
  }

  private static boolean isKernelVirtualFile(String normalized) {
    return normalized != null && KERNEL_VIRTUAL_FILES.get().containsKey(normalized);
  }

  private static boolean isKernelVirtualDirectory(String normalized) {
    if (normalized == null || "/".equals(normalized)) return false;
    for (String filePath : KERNEL_VIRTUAL_FILES.get().keySet()) {
      if (filePath.startsWith(normalized.endsWith("/") ? normalized : normalized + "/")) return true;
    }
    return false;
  }

  private static boolean isKernelVirtualNamespacePath(String normalized) {
    if (isKernelVirtualFile(normalized) || isKernelVirtualDirectory(normalized)) return true;
    if (normalized == null) return false;
    for (String filePath : KERNEL_VIRTUAL_FILES.get().keySet()) {
      int slash = filePath.indexOf('/', 1);
      String root = slash < 0 ? filePath : filePath.substring(0, slash);
      if (normalized.startsWith(root + "/")) return true;
    }
    return false;
  }

  private static void throwKernelDeviceNotDirectory(String normalized) throws IOException {
    if (KERNEL_DEVICES.get().containsKey(normalized)) throw new NotDirectoryException(normalized);
    throw new NoSuchFileException(normalized);
  }

  private static byte[] readableKernelFile(Path path) throws IOException {
    String normalized = normalizeVirtualPath(path);
    byte[] contents = normalized == null ? null : KERNEL_VIRTUAL_FILES.get().get(normalized);
    if (contents != null) return contents;
    if (isKernelVirtualDirectory(normalized)) throw new IOException("Kernel virtual path is a directory: " + normalized);
    if (isKernelVirtualNamespacePath(normalized)) throw new NoSuchFileException(normalized);
    return null;
  }

  private static ArrayList<Path> kernelVirtualDirectoryPaths(String normalized) {
    ArrayList<Path> paths = new ArrayList<>();
    for (String name : kernelVirtualDirectoryNames(normalized)) {
      paths.add(Path.of(("/".equals(normalized) ? "" : normalized) + "/" + name));
    }
    return paths;
  }

  private static String[] kernelVirtualDirectoryNames(String normalized) {
    String prefix = normalized.endsWith("/") ? normalized : normalized + "/";
    ArrayList<String> names = new ArrayList<>();
    for (String filePath : KERNEL_VIRTUAL_FILES.get().keySet()) {
      if (!filePath.startsWith(prefix)) continue;
      String remaining = filePath.substring(prefix.length());
      if (remaining.isEmpty()) continue;
      int slash = remaining.indexOf('/');
      String name = slash < 0 ? remaining : remaining.substring(0, slash);
      if (!names.contains(name)) names.add(name);
    }
    Collections.sort(names);
    return names.toArray(new String[0]);
  }

  private static byte[] readKernelDevice(KernelDevice device) {
    if (!device.readable) return new byte[0];
    if ("/dev/null".equals(device.inputDevice) || "/dev/null".equals(device.path)) return new byte[0];
    int firstByte = readHostInputByte(device.path);
    if (firstByte >= 0) {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      out.write(firstByte);
      while (true) {
        int nextByte = readHostInputAvailableByte(device.path);
        if (nextByte < 0) break;
        out.write(nextByte);
      }
      return out.toByteArray();
    }
    return new byte[0];
  }

  private static int readKernelDeviceByte(KernelDevice device) {
    if (!device.readable) return -1;
    if ("/dev/null".equals(device.inputDevice) || "/dev/null".equals(device.path)) return -1;
    int hostByte = readHostInputByte(device.path);
    if (hostByte >= 0) return hostByte;
    return -1;
  }

  private static int readKernelDeviceBytes(KernelDevice device, byte[] bytes, int offset, int length) {
    if (!device.readable) return -1;
    if ("/dev/null".equals(device.inputDevice) || "/dev/null".equals(device.path)) return length == 0 ? 0 : -1;
    return readKernelStdinBytes(bytes, offset, length);
  }

  private static int readKernelDeviceAvailableBytes(KernelDevice device, byte[] bytes, int offset, int length) {
    if (!device.readable) return -1;
    if ("/dev/null".equals(device.inputDevice) || "/dev/null".equals(device.path)) return length == 0 ? 0 : -1;
    return readKernelStdinAvailableBytes(bytes, offset, length);
  }

  private static long skipKernelDeviceBytes(KernelDevice device, long count) {
    if (!device.readable || count <= 0) return 0;
    if ("/dev/null".equals(device.inputDevice) || "/dev/null".equals(device.path)) return 0;
    return 0;
  }

  private static int kernelDeviceAvailable(KernelDevice device) {
    if (!device.readable) return 0;
    if ("/dev/null".equals(device.inputDevice) || "/dev/null".equals(device.path)) return 0;
    return inputAvailable(device.path);
  }

  private static int readKernelStdinByte() {
    int hostByte = readHostInputByte("/dev/stdin");
    if (hostByte >= 0) return hostByte;
    return -1;
  }

  private static int readKernelStdinBytes(byte[] bytes, int offset, int length) {
    if (length == 0) return 0;
    int firstByte = readHostInputByte("/dev/stdin");
    if (firstByte >= 0) {
      bytes[offset] = (byte) firstByte;
      int count = 1;
      while (count < length) {
        int nextByte = readHostInputAvailableByte("/dev/stdin");
        if (nextByte < 0) break;
        bytes[offset + count] = (byte) nextByte;
        count += 1;
      }
      return count;
    }
    return -1;
  }

  private static int readKernelStdinAvailableBytes(byte[] bytes, int offset, int length) {
    if (length == 0) return 0;
    int firstByte = readHostInputAvailableByte("/dev/stdin");
    if (firstByte >= 0) {
      bytes[offset] = (byte) firstByte;
      int count = 1;
      while (count < length) {
        int nextByte = readHostInputAvailableByte("/dev/stdin");
        if (nextByte < 0) break;
        bytes[offset + count] = (byte) nextByte;
        count += 1;
      }
      return count;
    }
    return -1;
  }

  private static int kernelStdinAvailable() {
    return inputAvailable("/dev/stdin");
  }

  private static int inputAvailable(String device) {
    if (!projectRunActiveForCurrentThread()) return 0;
    try {
      return inputAvailableNative(device == null ? "/dev/stdin" : device);
    } catch (UnsatisfiedLinkError | SecurityException ignored) {
      return 0;
    }
  }

  private static int readHostInputByte(String device) {
    if (!projectRunActiveForCurrentThread()) return -1;
    try {
      return readInputNative(device == null ? "/dev/stdin" : device);
    } catch (UnsatisfiedLinkError | SecurityException ignored) {
      return -1;
    }
  }

  private static int readHostInputAvailableByte(String device) {
    if (!projectRunActiveForCurrentThread()) return -1;
    try {
      return readInputAvailableNative(device == null ? "/dev/stdin" : device);
    } catch (UnsatisfiedLinkError | SecurityException ignored) {
      return -1;
    }
  }

  private static final class ProjectInputStream extends InputStream {
    private final KernelDevice device;
    private byte[] pending = new byte[0];
    private int pendingOffset = 0;

    ProjectInputStream(KernelDevice device) {
      this.device = device;
    }

    private int fillPending() {
      pending = new byte[0];
      pendingOffset = 0;
      byte[] oneByte = new byte[1];
      int count = device != null
          ? readKernelDeviceBytes(device, oneByte, 0, 1)
          : readKernelStdinBytes(oneByte, 0, 1);
      if (count <= 0) return count;
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      out.write(oneByte[0]);
      while (oneByte[0] != (byte) '\n') {
        count = device != null
            ? readKernelDeviceAvailableBytes(device, oneByte, 0, 1)
            : readKernelStdinAvailableBytes(oneByte, 0, 1);
        if (count <= 0) break;
        out.write(oneByte[0]);
      }
      pending = out.toByteArray();
      return pending.length;
    }

    @Override
    public int read() {
      if (pendingOffset >= pending.length) {
        int count = fillPending();
        if (count <= 0) return -1;
      }
      return pending[pendingOffset++] & 0xff;
    }

    @Override
    public int read(byte[] bytes, int offset, int length) {
      if (length == 0) return 0;
      if (pendingOffset >= pending.length) {
        int count = fillPending();
        if (count <= 0) return count;
      }
      int count = Math.min(length, pending.length - pendingOffset);
      System.arraycopy(pending, pendingOffset, bytes, offset, count);
      pendingOffset += count;
      return count;
    }

    @Override
    public long skip(long count) {
      if (count <= 0) return 0;
      if (device != null) return skipKernelDeviceBytes(device, count);
      return 0;
    }

    @Override
    public int available() {
      if (device != null) return kernelDeviceAvailable(device);
      return kernelStdinAvailable();
    }
  }

  private static int utf8ByteLength(String value) {
    return value == null ? 0 : value.getBytes(StandardCharsets.UTF_8).length;
  }

  private static byte[] copyBytes(byte[] bytes, int offset, int length) {
    if (bytes == null || length <= 0) return new byte[0];
    int safeOffset = Math.max(0, Math.min(bytes.length, offset));
    int safeLength = Math.max(0, Math.min(length, bytes.length - safeOffset));
    byte[] copy = new byte[safeLength];
    System.arraycopy(bytes, safeOffset, copy, 0, safeLength);
    return copy;
  }

  private static byte[] budgetProjectOutputBytes(String stream, byte[] bytes, int offset, int length) {
    return PROJECT_EVENT_BUDGET.get().captureOutput(stream, bytes, offset, length);
  }

  private static boolean reserveLiveFileChange(String relativePath, long contentsBytes) {
    return PROJECT_EVENT_BUDGET.get().reserveLiveFileChange(relativePath, contentsBytes);
  }

  private static final class ProjectEventBudget {
    private long stdoutBytes = 0;
    private long stderrBytes = 0;
    private boolean stdoutTruncated = false;
    private boolean stderrTruncated = false;
    private int liveFileChangeCount = 0;
    private long liveFileChangeBytes = 0;

    synchronized byte[] captureOutput(String stream, byte[] bytes, int offset, int length) {
      if (bytes == null || length <= 0) return new byte[0];
      boolean stderr = "stderr".equals(stream);
      if (stderr ? stderrTruncated : stdoutTruncated) return new byte[0];

      long used = stderr ? stderrBytes : stdoutBytes;
      long remaining = PROJECT_MAX_OUTPUT_STREAM_BYTES - used;
      if (length <= remaining) {
        if (stderr) {
          stderrBytes = used + length;
        } else {
          stdoutBytes = used + length;
        }
        return copyBytes(bytes, offset, length);
      }

      int prefixLength = (int) Math.max(0, Math.min(remaining, length));
      byte[] prefix = copyBytes(bytes, offset, prefixLength);
      byte[] marker = ("\n[tracekernel: " + (stderr ? "stderr" : "stdout") +
          " output truncated after " + PROJECT_MAX_OUTPUT_STREAM_BYTES + " bytes]\n")
          .getBytes(StandardCharsets.UTF_8);
      byte[] output = new byte[prefix.length + marker.length];
      System.arraycopy(prefix, 0, output, 0, prefix.length);
      System.arraycopy(marker, 0, output, prefix.length, marker.length);

      if (stderr) {
        stderrBytes = PROJECT_MAX_OUTPUT_STREAM_BYTES + marker.length;
        stderrTruncated = true;
      } else {
        stdoutBytes = PROJECT_MAX_OUTPUT_STREAM_BYTES + marker.length;
        stdoutTruncated = true;
      }
      return output;
    }

    synchronized boolean reserveLiveFileChange(String relativePath, long contentsBytes) {
      liveFileChangeCount += 1;
      long safeContentsBytes = Math.max(0, contentsBytes);
      long eventBytes = utf8ByteLength(relativePath) + safeContentsBytes;
      boolean overBudget =
          liveFileChangeCount > PROJECT_MAX_LIVE_FILE_CHANGES ||
          eventBytes > PROJECT_MAX_LIVE_FILE_CHANGE_BYTES ||
          liveFileChangeBytes + eventBytes > PROJECT_MAX_LIVE_FILE_CHANGE_BYTES;
      if (overBudget) return false;
      liveFileChangeBytes += eventBytes;
      return true;
    }
  }

  private static void writeKernelDevice(KernelDevice device, byte[] bytes) {
    String outputDevice = device.outputDevice.isEmpty() ? device.path : device.outputDevice;
    if ("/dev/null".equals(outputDevice)) return;
    String stream = "/dev/stderr".equals(outputDevice) ? "stderr" : "stdout";
    ByteArrayOutputStream capture = "stderr".equals(stream) ? STDERR_CAPTURE.get() : STDOUT_CAPTURE.get();
    byte[] outputBytes = budgetProjectOutputBytes(stream, bytes, 0, bytes.length);
    if (outputBytes.length == 0) return;
    if (capture != null) {
      capture.write(outputBytes, 0, outputBytes.length);
    }
    emitOutput(stream, new String(outputBytes, StandardCharsets.UTF_8), device.path.equals(outputDevice) ? "" : device.path, outputDevice);
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

  private static final class OutputFileTargetInfo {
    final boolean existed;

    OutputFileTargetInfo(boolean existed) {
      this.existed = existed;
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
    private final boolean readable;
    private final boolean writable;
    private final byte[] inputBytes;
    private int position = 0;
    private boolean open = true;

    KernelDeviceByteChannel(KernelDevice device, boolean readable, boolean writable) {
      this.device = device;
      this.readable = readable;
      this.writable = writable;
      this.inputBytes = readable ? readKernelDevice(device) : new byte[0];
    }

    @Override
    public int read(ByteBuffer dst) throws IOException {
      if (!readable) throw new IOException("Kernel device is not readable: " + device.path);
      if (position >= inputBytes.length) return -1;
      int length = Math.min(dst.remaining(), inputBytes.length - position);
      dst.put(inputBytes, position, length);
      position += length;
      return length;
    }

    @Override
    public int write(ByteBuffer src) throws IOException {
      if (!writable) throw new IOException("Kernel device is not writable: " + device.path);
      int length = src.remaining();
      byte[] bytes = new byte[length];
      src.get(bytes);
      writeKernelDevice(device, bytes);
      return length;
    }

    @Override
    public long position() {
      return position;
    }

    @Override
    public SeekableByteChannel position(long newPosition) {
      if (newPosition < 0 || newPosition > Integer.MAX_VALUE) {
        throw new IllegalArgumentException("Invalid kernel device channel position: " + newPosition);
      }
      position = (int) newPosition;
      return this;
    }

    @Override
    public long size() {
      return inputBytes.length;
    }

    @Override
    public SeekableByteChannel truncate(long size) throws IOException {
      if (!writable) throw new IOException("Kernel device is not writable: " + device.path);
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

  private static final class KernelFileByteChannel implements SeekableByteChannel {
    private final byte[] contents;
    private int position = 0;
    private boolean open = true;

    KernelFileByteChannel(byte[] contents) {
      this.contents = contents;
    }

    @Override
    public int read(ByteBuffer dst) throws IOException {
      if (!open) throw new ClosedChannelException();
      if (position >= contents.length) return -1;
      int length = Math.min(dst.remaining(), contents.length - position);
      dst.put(contents, position, length);
      position += length;
      return length;
    }

    @Override
    public int write(ByteBuffer src) throws IOException {
      throw new IOException("Read-only kernel virtual file");
    }

    @Override
    public long position() throws IOException {
      if (!open) throw new ClosedChannelException();
      return position;
    }

    @Override
    public SeekableByteChannel position(long newPosition) throws IOException {
      if (!open) throw new ClosedChannelException();
      if (newPosition < 0 || newPosition > Integer.MAX_VALUE) {
        throw new IllegalArgumentException("Invalid kernel file channel position: " + newPosition);
      }
      position = (int) newPosition;
      return this;
    }

    @Override
    public long size() throws IOException {
      if (!open) throw new ClosedChannelException();
      return contents.length;
    }

    @Override
    public SeekableByteChannel truncate(long size) throws IOException {
      throw new IOException("Read-only kernel virtual file");
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
    if (device != null) {
      LAST_OUTPUT_FILE_TARGET.set(new OutputFileTargetInfo(false));
      return temporaryDeviceFile();
    }
    assertWritableProjectPath(path);
    Path runtime = runtimePath(path);
    LAST_OUTPUT_FILE_TARGET.set(new OutputFileTargetInfo(Files.exists(runtime)));
    return runtime.toFile();
  }

  private static File inputFileTarget(Path path) throws IOException {
    KernelDevice device = readableKernelDevice(path);
    if (device != null) return temporaryDeviceFile();
    byte[] kernelFile = readableKernelFile(path);
    if (kernelFile != null) return temporaryFileWithContents(kernelFile);
    return runtimePath(path).toFile();
  }

  private static File inputReaderTarget(Path path) throws IOException {
    KernelDevice device = readableKernelDevice(path);
    if (device != null) return temporaryDeviceFile();
    byte[] kernelFile = readableKernelFile(path);
    if (kernelFile != null) return temporaryFileWithContents(kernelFile);
    return runtimePath(path).toFile();
  }

  private static File randomAccessFileTarget(Path path, String mode) throws IOException {
    if (randomAccessFileCanWrite(mode)) assertWritableProjectPath(path);
    KernelDevice device = readableKernelDevice(path);
    if (device != null) return temporaryFileWithContents(readKernelDevice(device));
    byte[] kernelFile = readableKernelFile(path);
    if (kernelFile != null) return temporaryFileWithContents(kernelFile);
    return runtimePath(path).toFile();
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
          option == StandardOpenOption.TRUNCATE_EXISTING ||
          option == StandardOpenOption.DELETE_ON_CLOSE
      ) {
        return true;
      }
    }
    return false;
  }

  private static boolean optionDeletesOnClose(OpenOption... options) {
    if (options == null) return false;
    for (OpenOption option : options) {
      if (option == StandardOpenOption.DELETE_ON_CLOSE) return true;
    }
    return false;
  }

  private static void emitPostWritePathChange(Path path, boolean deleteOnClose) {
    if (deleteOnClose && !Files.exists(path)) {
      emitFileDelete(path);
      return;
    }
    emitFileSnapshot(path);
  }

  private static boolean outputOpenSnapshotRequired(boolean existed, OpenOption... options) {
    if (options == null || options.length == 0) return true;
    boolean creates = false;
    boolean appends = false;
    boolean truncates = false;
    for (OpenOption option : options) {
      if (option == StandardOpenOption.CREATE || option == StandardOpenOption.CREATE_NEW) creates = true;
      if (option == StandardOpenOption.APPEND) appends = true;
      if (option == StandardOpenOption.TRUNCATE_EXISTING) truncates = true;
    }
    if (!existed && creates) return true;
    if (truncates) return true;
    return !existed && !appends;
  }

  private static boolean byteChannelOpenSnapshotRequired(boolean existed, OpenOption... options) {
    if (!byteChannelCanWrite(options)) return false;
    return outputOpenSnapshotRequired(existed, options);
  }

  private static boolean byteChannelCanRead(OpenOption... options) {
    if (options == null || options.length == 0) return true;
    for (OpenOption option : options) {
      if (option == StandardOpenOption.READ) return true;
    }
    return !byteChannelCanWrite(options);
  }

  private static SeekableByteChannel kernelDeviceByteChannel(Path path, OpenOption... options) throws IOException {
    KernelDevice device = kernelDevice(path);
    if (device == null) return null;
    boolean readable = byteChannelCanRead(options);
    boolean writable = byteChannelCanWrite(options);
    if (readable && !device.readable) throw new IOException("Kernel device is not readable: " + device.path);
    if (writable && !device.writable) throw new IOException("Kernel device is not writable: " + device.path);
    return new KernelDeviceByteChannel(device, readable, writable);
  }

  private static SeekableByteChannel kernelFileByteChannel(Path path, OpenOption... options) throws IOException {
    String normalized = normalizeVirtualPath(path);
    if (!isKernelVirtualNamespacePath(normalized)) return null;
    if (byteChannelCanWrite(options)) throw new IOException("Read-only kernel virtual path: " + normalized);
    byte[] contents = readableKernelFile(path);
    if (contents == null) throw new NoSuchFileException(normalized);
    return new KernelFileByteChannel(contents);
  }

  private static byte[] kernelInputBytes(Path path) throws IOException {
    KernelDevice device = readableKernelDevice(path);
    return device == null ? null : readKernelDevice(device);
  }

  private static byte[] kernelInputBytes(FileDescriptor fdObj) {
    KernelDevice device = readableKernelDevice(fdObj);
    return device == null ? null : readKernelDevice(device);
  }

  private static Reader kernelInputReader(Path path, Charset charset) throws IOException {
    KernelDevice device = readableKernelDevice(path);
    if (device == null) return null;
    return new InputStreamReader(new ProjectInputStream(device), charset == null ? Charset.defaultCharset() : charset);
  }

  private static Reader kernelInputReader(FileDescriptor fdObj, Charset charset) {
    KernelDevice device = readableKernelDevice(fdObj);
    if (device == null) return null;
    return new InputStreamReader(new ProjectInputStream(device), charset == null ? Charset.defaultCharset() : charset);
  }

  private static OutputStream printStreamOutput(Path path) throws IOException {
    KernelDevice device = writableKernelDevice(path);
    if (device != null) return new KernelDeviceOutputStream(device);
    assertWritableProjectPath(path);
    return new ProjectOutputStream(new FileOutputStream(path.toFile()), path, true, false);
  }

  private static Writer printWriterOutput(Path path, Charset charset) throws IOException {
    return new OutputStreamWriter(printStreamOutput(path), charset == null ? StandardCharsets.UTF_8 : charset);
  }

  private static File temporaryDeviceFile() throws IOException {
    File file = File.createTempFile("tracecode-device-", ".tmp");
    file.deleteOnExit();
    return file;
  }

  private static File temporaryFileWithContents(byte[] contents) throws IOException {
    File file = temporaryDeviceFile();
    Files.write(file.toPath(), contents);
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
        isVirtualDeviceNamespacePath(normalized) ||
        isKernelVirtualNamespacePath(normalized);
  }

  private static void emitFileSnapshot(Path path) {
    if (!projectRunActiveForCurrentThread()) return;
    String bridgeRunId = currentProjectBridgeRunId();
    if (bridgeRunId.isEmpty()) return;
    String relativePath = projectRelativePath(path);
    if (relativePath == null) return;
    try {
      long size = Files.size(path);
      if (!reserveLiveFileChange(relativePath, size)) return;
      emitFileSnapshotNative(bridgeRunId, relativePath, Base64.getEncoder().encodeToString(Files.readAllBytes(path)));
    } catch (UnsatisfiedLinkError | SecurityException | IOException ignored) {
      // Final-diff persistence still captures writes when live browser bridge emission is unavailable.
    }
  }

  private static void emitPathSnapshot(Path path) {
    if (path == null) return;
    if (Files.isDirectory(path)) {
      emitDirectoryCreate(path);
    } else {
      emitFileSnapshot(path);
    }
  }

  private static void emitFileDelete(Path path) {
    if (!projectRunActiveForCurrentThread()) return;
    String bridgeRunId = currentProjectBridgeRunId();
    if (bridgeRunId.isEmpty()) return;
    String relativePath = projectRelativePath(path);
    if (relativePath == null) return;
    if (!reserveLiveFileChange(relativePath, 0)) return;
    try {
      emitFileDeleteNative(bridgeRunId, relativePath);
    } catch (UnsatisfiedLinkError | SecurityException ignored) {
      // Final-diff persistence still captures deletes when live browser bridge emission is unavailable.
    }
  }

  private static void emitDirectoryCreate(Path path) {
    if (!projectRunActiveForCurrentThread()) return;
    String bridgeRunId = currentProjectBridgeRunId();
    if (bridgeRunId.isEmpty()) return;
    String relativePath = projectRelativePath(path);
    if (relativePath == null) return;
    if (!reserveLiveFileChange(relativePath, 0)) return;
    try {
      emitDirectoryCreateNative(bridgeRunId, relativePath);
    } catch (UnsatisfiedLinkError | SecurityException ignored) {
      // Final-diff persistence still captures directory creates when live browser bridge emission is unavailable.
    }
  }

  private static void emitDirectoryDelete(Path path) {
    if (!projectRunActiveForCurrentThread()) return;
    String bridgeRunId = currentProjectBridgeRunId();
    if (bridgeRunId.isEmpty()) return;
    String relativePath = projectRelativePath(path);
    if (relativePath == null) return;
    if (!reserveLiveFileChange(relativePath, 0)) return;
    try {
      emitDirectoryDeleteNative(bridgeRunId, relativePath);
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
    Path absolute = runtimePath(path).toAbsolutePath().normalize();
    if (!absolute.startsWith(root)) return null;
    Path relative = root.relativize(absolute);
    if (relative.getNameCount() == 0) return null;
    return relative.toString().replace('\\', '/');
  }

  private static final class StreamingProjectOutputStream extends OutputStream {
    private final ByteArrayOutputStream capture;
    private final String stream;
    private final ByteArrayOutputStream pending = new ByteArrayOutputStream();
    private final int runToken;
    private final String bridgeRunId;

    StreamingProjectOutputStream(ByteArrayOutputStream capture, String stream) {
      this.capture = capture;
      this.stream = stream;
      this.runToken = currentProjectRunToken();
      this.bridgeRunId = currentProjectBridgeRunId();
    }

    @Override
    public void write(int value) throws IOException {
      if (!projectRunTokenActive(runToken)) return;
      byte[] bytes = new byte[] { (byte) value };
      byte[] outputBytes = budgetProjectOutputBytes(stream, bytes, 0, 1);
      if (outputBytes.length == 0) return;
      capture.write(outputBytes, 0, outputBytes.length);
      if (outputBytes.length == 1 && outputBytes[0] == (byte) value) {
        pending.write(value);
        emitPending(false);
        return;
      }
      pending.write(outputBytes, 0, outputBytes.length);
      emitPending(false);
    }

    @Override
    public void write(byte[] bytes, int offset, int length) throws IOException {
      if (!projectRunTokenActive(runToken)) return;
      byte[] outputBytes = budgetProjectOutputBytes(stream, bytes, offset, length);
      if (outputBytes.length == 0) return;
      capture.write(outputBytes, 0, outputBytes.length);
      if (outputBytes.length == length) {
        pending.write(bytes, offset, length);
        emitPending(false);
        return;
      }
      pending.write(outputBytes, 0, outputBytes.length);
      emitPending(false);
    }

    @Override
    public void flush() throws IOException {
      if (!projectRunTokenActive(runToken)) return;
      emitPending(true);
    }

    private void emitPending(boolean endOfInput) throws IOException {
      if (pending.size() == 0) return;
      byte[] bytes = pending.toByteArray();
      int length = endOfInput ? bytes.length : completeUtf8PrefixLength(bytes);
      if (length == 0) return;
      emitOutput(bridgeRunId, stream, new String(bytes, 0, length, StandardCharsets.UTF_8), "", "");
      pending.reset();
      if (length < bytes.length) {
        pending.write(bytes, length, bytes.length - length);
      }
    }

    private static int completeUtf8PrefixLength(byte[] bytes) {
      int index = 0;
      int complete = 0;
      while (index < bytes.length) {
        int first = bytes[index] & 0xff;
        int width;
        if (first < 0x80) {
          width = 1;
        } else if (first >= 0xc2 && first <= 0xdf) {
          width = 2;
        } else if (first >= 0xe0 && first <= 0xef) {
          width = 3;
        } else if (first >= 0xf0 && first <= 0xf4) {
          width = 4;
        } else {
          index += 1;
          complete = index;
          continue;
        }
        if (index + width > bytes.length) break;
        boolean valid = true;
        for (int offset = 1; offset < width; offset += 1) {
          int continuation = bytes[index + offset] & 0xff;
          if (continuation < 0x80 || continuation > 0xbf) {
            valid = false;
            break;
          }
        }
        if (!valid) {
          index += 1;
          complete = index;
          continue;
        }
        index += width;
        complete = index;
      }
      return complete;
    }

    @Override
    public void close() throws IOException {
      flush();
    }
  }
}

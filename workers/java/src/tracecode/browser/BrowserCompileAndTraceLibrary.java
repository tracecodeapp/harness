package tracecode.browser;

import java.io.IOException;
import java.io.File;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Method;
import java.lang.reflect.InvocationTargetException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import javax.tools.JavaCompiler;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;
import tracecode.user.TraceHooks;

public final class BrowserCompileAndTraceLibrary {
  private static final String RUN_CACHE_VERSION = "tracecode-java-run-v2";

  private BrowserCompileAndTraceLibrary() {}

  /**
   * Clears CheerpJ's persistent read-write mount before an isolated learner
   * execution. This is host lifecycle work; it must run while no learner code
   * from another execution is active on the same browser origin.
   */
  public static void resetPersistentRuntimeStorage() throws IOException {
    resetDirectory(Paths.get("/files"));
  }

  /**
   * Removes one request-scoped browser compilation tree without touching the
   * session VM warmup or any CheerpJ runtime files outside TraceCode's root.
   */
  public static void deleteRuntimeRequestTree(String root) throws IOException {
    Path runtimeRoot = Paths.get("/files/java-worker").normalize();
    Path requestRoot = Paths.get(root).normalize();
    if (
        !requestRoot.startsWith(runtimeRoot) ||
        requestRoot.equals(runtimeRoot) ||
        requestRoot.equals(runtimeRoot.resolve("__warm_run__")) ||
        requestRoot.getNameCount() != runtimeRoot.getNameCount() + 1
    ) {
      throw new IOException("Refusing to delete non-request Java runtime tree: " + root);
    }
    if (!Files.exists(requestRoot)) return;
    try (Stream<Path> stream = Files.walk(requestRoot)) {
      List<Path> paths = stream
          .sorted((left, right) -> right.getNameCount() - left.getNameCount())
          .collect(Collectors.toList());
      for (Path path : paths) Files.deleteIfExists(path);
    }
  }

  /** Restores validated compiler output into a fresh request-scoped classes directory. */
  public static boolean restoreCompileCache(String cacheRoot, String classesDir) throws IOException {
    Path cache = safeCompileCacheRoot(cacheRoot);
    Path destination = safeRequestClassesDir(classesDir);
    if (!Files.exists(cache)) return false;
    resetDirectory(destination);
    copyDirectory(cache, destination);
    return true;
  }

  /** Stores compiler output only when the helper wrote complete cache metadata. */
  public static boolean commitCompileCache(String classesDir, String cacheRoot) throws IOException {
    Path source = safeRequestClassesDir(classesDir);
    boolean hasRunMetadata = Files.exists(source.resolve(".tracecode-run-cache-key")) &&
        Files.exists(source.resolve(".tracecode-run-cache-key.manifest"));
    boolean hasTraceMetadata = Files.exists(source.resolve(".tracecode-cache-key")) &&
        Files.exists(source.resolve(".tracecode-cache-key.manifest"));
    if (!hasRunMetadata && !hasTraceMetadata) return false;
    Path cache = safeCompileCacheRoot(cacheRoot);
    resetDirectory(cache);
    copyDirectory(source, cache);
    return true;
  }

  private static Path safeCompileCacheRoot(String value) throws IOException {
    Path runtimeRoot = Paths.get("/files/java-worker").toAbsolutePath().normalize();
    Path target = Paths.get(value).toAbsolutePath().normalize();
    if (
        !target.startsWith(runtimeRoot) ||
        target.getNameCount() != runtimeRoot.getNameCount() + 1 ||
        !target.getFileName().toString().startsWith("compile-cache-")
    ) {
      throw new IOException("Invalid Java compile cache root: " + value);
    }
    return target;
  }

  private static Path safeRequestClassesDir(String value) throws IOException {
    Path runtimeRoot = Paths.get("/files/java-worker").toAbsolutePath().normalize();
    Path target = Paths.get(value).toAbsolutePath().normalize();
    if (
        !target.startsWith(runtimeRoot) ||
        target.getNameCount() != runtimeRoot.getNameCount() + 2 ||
        !target.getFileName().toString().equals("classes") ||
        target.getParent().getFileName().toString().startsWith("compile-cache-")
    ) {
      throw new IOException("Invalid request-scoped Java classes directory: " + value);
    }
    return target;
  }

  private static void copyDirectory(Path source, Path destination) throws IOException {
    try (Stream<Path> stream = Files.walk(source)) {
      for (Path path : stream.sorted().collect(Collectors.toList())) {
        Path relative = source.relativize(path);
        Path target = destination.resolve(relative).normalize();
        if (!target.startsWith(destination)) throw new IOException("Compile cache entry escaped destination.");
        if (Files.isDirectory(path)) {
          Files.createDirectories(target);
        } else if (Files.isRegularFile(path)) {
          Files.createDirectories(target.getParent());
          Files.write(target, Files.readAllBytes(path));
        }
      }
    }
  }

  public static String compileAndTrace(
      String sourcePath,
      String classesDir,
      String entryClass,
      String compileClasspath,
      String compilerProfile
  ) throws Exception {
    return compileAndTrace(sourcePath, classesDir, entryClass, compileClasspath, compilerProfile, 50000);
  }

  public static String compileAndTrace(
      String sourcePath,
      String classesDir,
      String entryClass,
      String compileClasspath,
      String compilerProfile,
      String maxStoredEvents
  ) throws Exception {
    int parsedMaxEvents;
    try {
      parsedMaxEvents = Integer.parseInt(maxStoredEvents);
    } catch (Exception ignored) {
      parsedMaxEvents = 50000;
    }
    return compileAndTrace(sourcePath, classesDir, entryClass, compileClasspath, compilerProfile, parsedMaxEvents);
  }

  public static String compileAndTrace(
      String sourcePath,
      String classesDir,
      String entryClass,
      String compileClasspath,
      String compilerProfile,
      int maxStoredEvents
  ) throws Exception {
    Path sourceFile = Paths.get(sourcePath);
    Path classesPath = Paths.get(classesDir);
    Files.createDirectories(classesPath);

    String source = Files.readString(sourceFile, StandardCharsets.UTF_8);
    String compilerDebugArg = compilerDebugArgForProfile(compilerProfile);
    String cacheKey = hashSource(source, compileClasspath, entryClass, compilerDebugArg);
    Path cacheKeyPath = classesPath.resolve(".tracecode-cache-key");

    StringWriter compilerStdout = new StringWriter();
    StringWriter compilerStderr = new StringWriter();
    PrintWriter compilerStdoutWriter = new PrintWriter(compilerStdout, true);
    PrintWriter compilerStderrWriter = new PrintWriter(compilerStderr, true);

    long compileStart = System.nanoTime();
    boolean compiled;
    boolean compileCacheHit = false;
    if (canReuseCompiledClasses(classesPath, cacheKeyPath, cacheKey, entryClass)) {
      compiled = true;
      compileCacheHit = true;
    } else {
      resetDirectory(classesPath);
      compiled = compileSource(
          sourcePath,
          classesDir,
          compileClasspath,
          compilerDebugArg,
          compilerStdoutWriter,
          compilerStderrWriter);
      if (compiled) {
        writeCompileCacheMetadata(classesPath, cacheKeyPath, cacheKey);
      }
    }
    long compileEnd = System.nanoTime();

    long classLoadStart = System.nanoTime();
    long classLoadEnd = classLoadStart;
    long runStart = 0;
    long runEnd = 0;
    Object output = null;
    String runtimeError = null;
    List<String> events = new ArrayList<>();
    boolean success = compiled;
    boolean traceLimitExceeded = false;
    int droppedEventCount = 0;

    if (compiled) {
      int traceRunToken = TraceHooks.beginRun(maxStoredEvents);
      try (URLClassLoader loader = new URLClassLoader(
          new URL[] { classesPath.toUri().toURL() },
          BrowserCompileAndTraceLibrary.class.getClassLoader())) {
        Class<?> entry = Class.forName(entryClass, true, loader);
        Method run = entry.getMethod("run");
        run.setAccessible(true);
        classLoadEnd = System.nanoTime();
        runStart = System.nanoTime();
        output = run.invoke(null);
        runEnd = System.nanoTime();
      } catch (InvocationTargetException error) {
        Throwable cause = error.getCause() == null ? error : error.getCause();
        runEnd = System.nanoTime();
        runtimeError = stackTrace(cause);
        success = false;
      } catch (Throwable error) {
        long end = System.nanoTime();
        if (runStart == 0) {
          classLoadEnd = end;
        } else {
          runEnd = end;
        }
        runtimeError = stackTrace(error);
        success = false;
      } finally {
        events = TraceHooks.drainEvents();
        traceLimitExceeded = TraceHooks.traceLimitExceeded();
        droppedEventCount = TraceHooks.droppedEventCount();
        TraceHooks.endRun(traceRunToken);
      }
    } else {
      runtimeError = null;
    }

    return buildTraceReportJson(
        success,
        output == null ? null : String.valueOf(output),
        events,
        compilerStdout.toString(),
        compilerStderr.toString(),
        runtimeError,
        millisBetween(compileStart, compileEnd),
        millisBetween(classLoadStart, classLoadEnd),
        runStart == 0 ? 0 : millisBetween(runStart, runEnd),
        compileCacheHit,
        compilerProfile,
        traceLimitExceeded,
        droppedEventCount);
  }

  public static String compileAndRun(
      String sourcePath,
      String classesDir,
      String entryClass,
      String compileClasspath,
      String compilerProfile
  ) throws Exception {
    Path sourceFile = Paths.get(sourcePath);
    Path classesPath = Paths.get(classesDir);
    Files.createDirectories(classesPath);

    String compilerDebugArg = compilerDebugArgForProfile(compilerProfile);
    Path cacheKeyPath = classesPath.resolve(".tracecode-run-cache-key");

    StringWriter compilerStdout = new StringWriter();
    StringWriter compilerStderr = new StringWriter();
    PrintWriter compilerStdoutWriter = new PrintWriter(compilerStdout, true);
    PrintWriter compilerStderrWriter = new PrintWriter(compilerStderr, true);

    long compileStart = System.nanoTime();
    boolean compiled;
    boolean compileCacheHit = false;
    try {
      String source = Files.readString(sourceFile, StandardCharsets.UTF_8);
      String cacheKey = hashSource(source, compileClasspath, entryClass, compilerDebugArg);
      if (canReuseCompiledClasses(classesPath, cacheKeyPath, cacheKey, entryClass)) {
        compiled = true;
        compileCacheHit = true;
      } else {
        resetDirectory(classesPath);
        compiled = compileSource(
            sourcePath,
            classesDir,
            compileClasspath,
            compilerDebugArg,
            compilerStdoutWriter,
            compilerStderrWriter);
        if (compiled) {
          writeCompileCacheMetadata(classesPath, cacheKeyPath, cacheKey);
        }
      }
    } catch (Throwable error) {
      long compileEnd = System.nanoTime();
      return buildRunReportJson(
          false,
          null,
          compilerStdout.toString(),
          compilerStderr.toString(),
          stackTrace(error),
          millisBetween(compileStart, compileEnd),
          0,
          0,
          compileCacheHit,
          compilerProfile);
    }
    long compileEnd = System.nanoTime();

    if (!compiled) {
      return buildRunReportJson(
          false,
          null,
          compilerStdout.toString(),
          compilerStderr.toString(),
          null,
          millisBetween(compileStart, compileEnd),
          0,
          0,
          compileCacheHit,
          compilerProfile);
    }

    long classLoadStart = System.nanoTime();
    long classLoadEnd = classLoadStart;
    long runStart = 0;
    long runEnd = 0;
    int traceRunToken = TraceHooks.beginRun();
    try (URLClassLoader loader = new URLClassLoader(
        new URL[] { classesPath.toUri().toURL() },
        BrowserCompileAndTraceLibrary.class.getClassLoader())) {
      Class<?> entry = Class.forName(entryClass, true, loader);
      Method run = entry.getMethod("run");
      run.setAccessible(true);
      classLoadEnd = System.nanoTime();
      runStart = System.nanoTime();
      Object output = run.invoke(null);
      runEnd = System.nanoTime();
      return buildRunReportJson(
          true,
          String.valueOf(output),
          compilerStdout.toString(),
          compilerStderr.toString(),
          null,
          millisBetween(compileStart, compileEnd),
          millisBetween(classLoadStart, classLoadEnd),
          millisBetween(runStart, runEnd),
          compileCacheHit,
          compilerProfile);
    } catch (InvocationTargetException error) {
      Throwable cause = error.getCause() == null ? error : error.getCause();
      runEnd = System.nanoTime();
      return buildRunReportJson(
          false,
          null,
          compilerStdout.toString(),
          compilerStderr.toString(),
          stackTrace(cause),
          millisBetween(compileStart, compileEnd),
          millisBetween(classLoadStart, classLoadEnd),
          runStart == 0 ? 0 : millisBetween(runStart, runEnd),
          compileCacheHit,
          compilerProfile);
    } catch (Throwable error) {
      long end = System.nanoTime();
      if (runStart == 0) {
        classLoadEnd = end;
      } else {
        runEnd = end;
      }
      return buildRunReportJson(
          false,
          null,
          compilerStdout.toString(),
          compilerStderr.toString(),
          stackTrace(error),
          millisBetween(compileStart, compileEnd),
          millisBetween(classLoadStart, classLoadEnd),
          runStart == 0 ? 0 : millisBetween(runStart, runEnd),
          compileCacheHit,
          compilerProfile);
    } finally {
      TraceHooks.endRun(traceRunToken);
    }
  }

  public static String runCompiledClassManifest(
      String classManifest,
      String classesDir,
      String entryClass,
      String runtimeClasspath,
      String compilerProfile,
      String compileTimeMs,
      String compilerStdout,
      String compilerStderr,
      String compileCacheHit
  ) throws Exception {
    Path classesPath = Paths.get(classesDir);
    writeCompiledClassManifest(classManifest, classesPath);
    InvocationReport result = runEntryClass(classesPath, entryClass, classpathPaths(runtimeClasspath));
    return buildRunReportJson(
        result.success,
        result.output,
        compilerStdout,
        compilerStderr,
        result.runtimeError,
        parseLongOrZero(compileTimeMs),
        result.classLoadTimeMs,
        result.runTimeMs,
        parseBoolean(compileCacheHit),
        compilerProfile);
  }

  public static String runCachedClasses(
      String classesDir,
      String entryClass,
      String runtimeClasspath,
      String compilerProfile
  ) throws Exception {
    try {
      Path classesPath = safeRequestClassesDir(classesDir);
      assertRestoredCompileCache(classesPath, ".tracecode-run-cache-key", List.of(entryClass));
      InvocationReport result = runEntryClass(classesPath, entryClass, classpathPaths(runtimeClasspath));
      return buildRunReportJson(
          result.success,
          result.output,
          "",
          "",
          result.runtimeError,
          0,
          result.classLoadTimeMs,
          result.runTimeMs,
          true,
          compilerProfile);
    } catch (Throwable error) {
      return buildRunReportJson(false, null, "", "", stackTrace(error), 0, 0, 0, true, compilerProfile);
    }
  }

  public static String traceCompiledClassManifest(
      String classManifest,
      String classesDir,
      String entryClass,
      String runtimeClasspath,
      String compilerProfile,
      String compileTimeMs,
      String compilerStdout,
      String compilerStderr,
      String compileCacheHit,
      String maxStoredEvents
  ) throws Exception {
    int parsedMaxEvents;
    try {
      parsedMaxEvents = Integer.parseInt(maxStoredEvents);
    } catch (Exception ignored) {
      parsedMaxEvents = 50000;
    }
    Path classesPath = Paths.get(classesDir);
    writeCompiledClassManifest(classManifest, classesPath);
    TraceInvocationReport result = traceEntryClass(
        classesPath,
        entryClass,
        classpathPaths(runtimeClasspath),
        parsedMaxEvents);
    return buildTraceReportJson(
        result.success,
        result.output,
        result.events,
        compilerStdout,
        compilerStderr,
        result.runtimeError,
        parseLongOrZero(compileTimeMs),
        result.classLoadTimeMs,
        result.runTimeMs,
        parseBoolean(compileCacheHit),
        compilerProfile,
        result.traceLimitExceeded,
        result.droppedEventCount);
  }

  public static String traceCachedClasses(
      String classesDir,
      String entryClass,
      String runtimeClasspath,
      String compilerProfile,
      String maxStoredEvents
  ) throws Exception {
    int parsedMaxEvents;
    try {
      parsedMaxEvents = Integer.parseInt(maxStoredEvents);
    } catch (Exception ignored) {
      parsedMaxEvents = 50000;
    }
    Path classesPath = safeRequestClassesDir(classesDir);
    assertRestoredCompileCache(classesPath, ".tracecode-cache-key", List.of(entryClass));
    TraceInvocationReport result = traceEntryClass(
        classesPath,
        entryClass,
        classpathPaths(runtimeClasspath),
        parsedMaxEvents);
    return buildTraceReportJson(
        result.success,
        result.output,
        result.events,
        "",
        "",
        result.runtimeError,
        0,
        result.classLoadTimeMs,
        result.runTimeMs,
        true,
        compilerProfile,
        result.traceLimitExceeded,
        result.droppedEventCount);
  }

  public static String runCompiledClassManifestBatch(
      String classManifest,
      String classesDir,
      String entryClasses,
      String runtimeClasspath,
      String compilerProfile,
      String compileTimeMs,
      String compilerStdout,
      String compilerStderr,
      String compileCacheHit
  ) throws Exception {
    List<String> entries = splitEntryClasses(entryClasses);
    if (entries.isEmpty()) {
      throw new IllegalArgumentException("runCompiledClassManifestBatch requires at least one entry class");
    }

    Path classesPath = Paths.get(classesDir);
    writeCompiledClassManifest(classManifest, classesPath);

    List<String> resultJson = new ArrayList<>();
    boolean success = true;
    List<Path> runtimeClasspathPaths = classpathPaths(runtimeClasspath);
    for (String entry : entries) {
      InvocationReport result = runEntryClass(classesPath, entry, runtimeClasspathPaths);
      if (!result.success) success = false;
      resultJson.add(buildInvocationReportJson(result));
    }

    return buildRunBatchReportJson(
        success,
        resultJson,
        compilerStdout,
        compilerStderr,
        null,
        parseLongOrZero(compileTimeMs),
        parseBoolean(compileCacheHit),
        compilerProfile);
  }

  public static String runCachedClassesBatch(
      String classesDir,
      String entryClasses,
      String runtimeClasspath,
      String compilerProfile
  ) throws Exception {
    List<String> entries = splitEntryClasses(entryClasses);
    if (entries.isEmpty()) throw new IllegalArgumentException("runCachedClassesBatch requires entry classes");
    Path classesPath = safeRequestClassesDir(classesDir);
    assertRestoredCompileCache(classesPath, ".tracecode-run-cache-key", entries);
    List<String> resultJson = new ArrayList<>();
    boolean success = true;
    List<Path> runtimeClasspathPaths = classpathPaths(runtimeClasspath);
    for (String entry : entries) {
      InvocationReport result = runEntryClass(classesPath, entry, runtimeClasspathPaths);
      if (!result.success) success = false;
      resultJson.add(buildInvocationReportJson(result));
    }
    return buildRunBatchReportJson(success, resultJson, "", "", null, 0, true, compilerProfile);
  }

  public static String compileAndRunProject(
      String sourcePaths,
      String classesDir,
      String entryClass,
      String compileClasspath,
      String compilerProfile
  ) throws Exception {
    List<String> sources = splitLines(sourcePaths);
    if (sources.isEmpty()) {
      throw new IllegalArgumentException("compileAndRunProject requires at least one source path");
    }

    Path classesPath = Paths.get(classesDir);
    Files.createDirectories(classesPath);

    String compilerDebugArg = compilerDebugArgForProfile(compilerProfile);
    String cacheKey = hashSources(sources, compileClasspath, entryClass, compilerDebugArg);
    Path cacheKeyPath = classesPath.resolve(".tracecode-run-cache-key");

    StringWriter compilerStdout = new StringWriter();
    StringWriter compilerStderr = new StringWriter();
    PrintWriter compilerStdoutWriter = new PrintWriter(compilerStdout, true);
    PrintWriter compilerStderrWriter = new PrintWriter(compilerStderr, true);

    long compileStart = System.nanoTime();
    boolean compiled;
    boolean compileCacheHit = false;
    if (canReuseCompiledClasses(classesPath, cacheKeyPath, cacheKey, entryClass)) {
      compiled = true;
      compileCacheHit = true;
    } else {
      resetDirectory(classesPath);
      compiled = compileSources(
          sources,
          classesDir,
          compileClasspath,
          compilerDebugArg,
          compilerStdoutWriter,
          compilerStderrWriter);
      if (compiled) {
        writeCompileCacheMetadata(classesPath, cacheKeyPath, cacheKey);
      }
    }
    long compileEnd = System.nanoTime();

    if (!compiled) {
      return buildRunReportJson(
          false,
          null,
          compilerStdout.toString(),
          compilerStderr.toString(),
          null,
          millisBetween(compileStart, compileEnd),
          0,
          0,
          compileCacheHit,
          compilerProfile);
    }

    InvocationReport result = runEntryClass(classesPath, entryClass, classpathPaths(compileClasspath));
    return buildRunReportJson(
        result.success,
        result.output,
        compilerStdout.toString(),
        compilerStderr.toString(),
        result.runtimeError,
        millisBetween(compileStart, compileEnd),
        result.classLoadTimeMs,
        result.runTimeMs,
        compileCacheHit,
        compilerProfile,
        collectCompiledFilesJson(classesPath));
  }

  public static String compileAndRunProjectSources(
      String sourceManifest,
      String sourceRoot,
      String classesDir,
      String entryClass,
      String compileClasspath,
      String compilerProfile
  ) throws Exception {
    List<String> sources = writeProjectSources(sourceManifest, Paths.get(sourceRoot));
    return compileAndRunProject(
        String.join("\n", sources),
        classesDir,
        entryClass,
        compileClasspath,
        compilerProfile);
  }

  public static String compileAndRunProjectSourcesWithResources(
      String sourceManifest,
      String sourceRoot,
      String resourceManifest,
      String resourceRoot,
      String classesDir,
      String entryClass,
      String compileClasspath,
      String compilerProfile
  ) throws Exception {
    writeProjectResourceFiles(resourceManifest, Paths.get(resourceRoot));
    List<String> sources = writeProjectSources(sourceManifest, Paths.get(sourceRoot));
    return compileAndRunProject(
        String.join("\n", sources),
        classesDir,
        entryClass,
        compileClasspath,
        compilerProfile);
  }

  public static String compileAndRunProjectSourcesWithWorkspace(
      String sourceManifest,
      String sourceRoot,
      String resourceManifest,
      String resourceRoot,
      String workspaceManifest,
      String workspaceRoot,
      String workspaceCwd,
      String classesDir,
      String entryClass,
      String compileClasspath,
      String compilerProfile
  ) throws Exception {
    writeProjectResourceFiles(resourceManifest, Paths.get(resourceRoot));
    writeProjectResourceFiles(workspaceManifest, Paths.get(workspaceRoot));
    List<String> sources = writeProjectSources(sourceManifest, Paths.get(sourceRoot));

    Path classesPath = Paths.get(classesDir);
    Files.createDirectories(classesPath);

    String compilerDebugArg = compilerDebugArgForProfile(compilerProfile);
    String cacheKey = hashSources(sources, compileClasspath, entryClass, compilerDebugArg);
    Path cacheKeyPath = classesPath.resolve(".tracecode-run-cache-key");

    StringWriter compilerStdout = new StringWriter();
    StringWriter compilerStderr = new StringWriter();
    PrintWriter compilerStdoutWriter = new PrintWriter(compilerStdout, true);
    PrintWriter compilerStderrWriter = new PrintWriter(compilerStderr, true);

    long compileStart = System.nanoTime();
    boolean compiled;
    boolean compileCacheHit = false;
    if (canReuseCompiledClasses(classesPath, cacheKeyPath, cacheKey, entryClass)) {
      compiled = true;
      compileCacheHit = true;
    } else {
      resetDirectory(classesPath);
      compiled = compileSources(
          sources,
          classesDir,
          compileClasspath,
          compilerDebugArg,
          compilerStdoutWriter,
          compilerStderrWriter);
      if (compiled) {
        writeCompileCacheMetadata(classesPath, cacheKeyPath, cacheKey);
      }
    }
    long compileEnd = System.nanoTime();

    if (!compiled) {
      return buildRunReportJson(
          false,
          null,
          compilerStdout.toString(),
          compilerStderr.toString(),
          null,
          millisBetween(compileStart, compileEnd),
          0,
          0,
          compileCacheHit,
          compilerProfile);
    }

    InvocationReport result = runEntryClass(classesPath, entryClass, classpathPaths(compileClasspath), Paths.get(workspaceCwd));
    return buildRunReportJson(
        result.success,
        result.output,
        compilerStdout.toString(),
        compilerStderr.toString(),
        result.runtimeError,
        millisBetween(compileStart, compileEnd),
        result.classLoadTimeMs,
        result.runTimeMs,
        compileCacheHit,
        compilerProfile,
        null,
        collectChangedProjectFilesJson(Paths.get(workspaceRoot), workspaceManifest));
  }

  public static String compileProjectSourcesWithResources(
      String sourceManifest,
      String sourceRoot,
      String resourceManifest,
      String resourceRoot,
      String compileSourcePaths,
      String compileSourceRootPaths,
      String classesDir,
      String compileClasspath,
      String compilerProfile
  ) throws Exception {
    writeProjectResourceFiles(resourceManifest, Paths.get(resourceRoot));
    List<String> selectedSources = selectedProjectSources(
        splitLines(compileSourcePaths),
        Paths.get(sourceRoot));
    List<String> sourceRoots = selectedProjectSourceRoots(
        splitLines(compileSourceRootPaths),
        Paths.get(sourceRoot));
    writeProjectSources(sourceManifest, Paths.get(sourceRoot));
    if (selectedSources.isEmpty()) {
      throw new IllegalArgumentException("compileProjectSourcesWithResources requires at least one source path");
    }

    Path classesPath = Paths.get(classesDir);
    Files.createDirectories(classesPath);

    String compilerDebugArg = compilerDebugArgForProfile(compilerProfile);
    StringWriter compilerStdout = new StringWriter();
    StringWriter compilerStderr = new StringWriter();
    PrintWriter compilerStdoutWriter = new PrintWriter(compilerStdout, true);
    PrintWriter compilerStderrWriter = new PrintWriter(compilerStderr, true);

    long compileStart = System.nanoTime();
    resetDirectory(classesPath);
    boolean compiled = compileSources(
        selectedSources,
        sourceRoots,
        classesDir,
        compileClasspath,
        compilerDebugArg,
        compilerStdoutWriter,
        compilerStderrWriter);
    long compileEnd = System.nanoTime();

    return buildRunReportJson(
        compiled,
        compiled ? "{\"stdout\":\"\",\"stderr\":\"\",\"exitCode\":0}" : null,
        compilerStdout.toString(),
        compilerStderr.toString(),
        compiled ? null : "Java compilation failed",
        millisBetween(compileStart, compileEnd),
        0,
        0,
        false,
        compilerProfile,
        compiled ? collectCompiledFilesJson(classesPath) : null);
  }

  public static String compileAndRunProjectClassFiles(
      String classManifest,
      String classRoot,
      String sourceManifest,
      String sourceRoot,
      String classesDir,
      String entryClass,
      String runtimeClasspath,
      String compileClasspath,
      String compilerProfile
  ) throws Exception {
    writeProjectResourceFiles(classManifest, Paths.get(classRoot));
    List<String> sources = writeProjectSources(sourceManifest, Paths.get(sourceRoot));
    if (sources.isEmpty()) {
      throw new IllegalArgumentException("compileAndRunProjectClassFiles requires an adapter source");
    }

    Path classesPath = Paths.get(classesDir);
    Files.createDirectories(classesPath);

    String compilerDebugArg = compilerDebugArgForProfile(compilerProfile);
    StringWriter compilerStdout = new StringWriter();
    StringWriter compilerStderr = new StringWriter();
    PrintWriter compilerStdoutWriter = new PrintWriter(compilerStdout, true);
    PrintWriter compilerStderrWriter = new PrintWriter(compilerStderr, true);

    long compileStart = System.nanoTime();
    resetDirectory(classesPath);
    boolean compiled = compileSources(
        sources,
        classesDir,
        combineClasspaths(runtimeClasspath, compileClasspath),
        compilerDebugArg,
        compilerStdoutWriter,
        compilerStderrWriter);
    long compileEnd = System.nanoTime();

    if (!compiled) {
      return buildRunReportJson(
          false,
          null,
          compilerStdout.toString(),
          compilerStderr.toString(),
          null,
          millisBetween(compileStart, compileEnd),
          0,
          0,
          false,
          compilerProfile);
    }

    InvocationReport result = runEntryClass(classesPath, entryClass, classpathPaths(runtimeClasspath));
    return buildRunReportJson(
        result.success,
        result.output,
        compilerStdout.toString(),
        compilerStderr.toString(),
        result.runtimeError,
        millisBetween(compileStart, compileEnd),
        result.classLoadTimeMs,
        result.runTimeMs,
        false,
        compilerProfile);
  }

  public static String compileAndRunProjectClassFilesWithWorkspace(
      String classManifest,
      String classRoot,
      String sourceManifest,
      String sourceRoot,
      String workspaceManifest,
      String workspaceRoot,
      String workspaceCwd,
      String classesDir,
      String entryClass,
      String runtimeClasspath,
      String compileClasspath,
      String compilerProfile
  ) throws Exception {
    writeProjectResourceFiles(classManifest, Paths.get(classRoot));
    writeProjectResourceFiles(workspaceManifest, Paths.get(workspaceRoot));
    List<String> sources = writeProjectSources(sourceManifest, Paths.get(sourceRoot));
    if (sources.isEmpty()) {
      throw new IllegalArgumentException("compileAndRunProjectClassFilesWithWorkspace requires an adapter source");
    }

    Path classesPath = Paths.get(classesDir);
    Files.createDirectories(classesPath);

    String compilerDebugArg = compilerDebugArgForProfile(compilerProfile);
    StringWriter compilerStdout = new StringWriter();
    StringWriter compilerStderr = new StringWriter();
    PrintWriter compilerStdoutWriter = new PrintWriter(compilerStdout, true);
    PrintWriter compilerStderrWriter = new PrintWriter(compilerStderr, true);

    long compileStart = System.nanoTime();
    resetDirectory(classesPath);
    boolean compiled = compileSources(
        sources,
        classesDir,
        combineClasspaths(runtimeClasspath, compileClasspath),
        compilerDebugArg,
        compilerStdoutWriter,
        compilerStderrWriter);
    long compileEnd = System.nanoTime();

    if (!compiled) {
      return buildRunReportJson(
          false,
          null,
          compilerStdout.toString(),
          compilerStderr.toString(),
          null,
          millisBetween(compileStart, compileEnd),
          0,
          0,
          false,
          compilerProfile);
    }

    InvocationReport result = runEntryClass(classesPath, entryClass, classpathPaths(runtimeClasspath), Paths.get(workspaceCwd));
    return buildRunReportJson(
        result.success,
        result.output,
        compilerStdout.toString(),
        compilerStderr.toString(),
        result.runtimeError,
        millisBetween(compileStart, compileEnd),
        result.classLoadTimeMs,
        result.runTimeMs,
        false,
        compilerProfile,
        null,
        collectChangedProjectFilesJson(Paths.get(workspaceRoot), workspaceManifest));
  }

  public static String compileAndRunBatch(
      String sourcePath,
      String classesDir,
      String entryClasses,
      String compileClasspath,
      String compilerProfile
  ) throws Exception {
    List<String> entries = splitEntryClasses(entryClasses);
    if (entries.isEmpty()) {
      throw new IllegalArgumentException("compileAndRunBatch requires at least one entry class");
    }

    Path sourceFile = Paths.get(sourcePath);
    Path classesPath = Paths.get(classesDir);
    Files.createDirectories(classesPath);

    String source = Files.readString(sourceFile, StandardCharsets.UTF_8);
    String compilerDebugArg = compilerDebugArgForProfile(compilerProfile);
    String cacheKey = hashSource(source, compileClasspath, String.join("\n", entries), compilerDebugArg);
    Path cacheKeyPath = classesPath.resolve(".tracecode-run-cache-key");

    StringWriter compilerStdout = new StringWriter();
    StringWriter compilerStderr = new StringWriter();
    PrintWriter compilerStdoutWriter = new PrintWriter(compilerStdout, true);
    PrintWriter compilerStderrWriter = new PrintWriter(compilerStderr, true);

    long compileStart = System.nanoTime();
    boolean compiled;
    boolean compileCacheHit = false;
    if (canReuseCompiledClasses(classesPath, cacheKeyPath, cacheKey, entries)) {
      compiled = true;
      compileCacheHit = true;
    } else {
      resetDirectory(classesPath);
      compiled = compileSource(
          sourcePath,
          classesDir,
          compileClasspath,
          compilerDebugArg,
          compilerStdoutWriter,
          compilerStderrWriter);
      if (compiled) {
        writeCompileCacheMetadata(classesPath, cacheKeyPath, cacheKey);
      }
    }
    long compileEnd = System.nanoTime();

    List<String> resultJson = new ArrayList<>();
    boolean success = compiled;
    if (compiled) {
      for (String entry : entries) {
        InvocationReport result = runEntryClass(classesPath, entry);
        if (!result.success) success = false;
        resultJson.add(buildInvocationReportJson(result));
      }
    }

    return buildRunBatchReportJson(
        success,
        resultJson,
        compilerStdout.toString(),
        compilerStderr.toString(),
        compiled ? null : "Java compilation failed",
        millisBetween(compileStart, compileEnd),
        compileCacheHit,
        compilerProfile);
  }

  private static boolean compileSource(
      String sourcePath,
      String classesDir,
      String compileClasspath,
      String compilerDebugArg,
      PrintWriter compilerStdout,
      PrintWriter compilerStderr
  ) throws Exception {
    List<String> javacArgs = new ArrayList<>();
    javacArgs.add(compilerDebugArg);
    javacArgs.add("-d");
    javacArgs.add(classesDir);
    if (compileClasspath != null && !compileClasspath.isEmpty()) {
      javacArgs.add("-classpath");
      javacArgs.add(compileClasspath);
    }
    javacArgs.add(sourcePath);

    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    if (compiler == null) {
      return compileWithBundledJavac(javacArgs.toArray(new String[0]), compilerStderr);
    }

    List<String> options = new ArrayList<>();
    options.add("--release");
    options.add("17");
    options.addAll(javacArgs);
    options.remove(options.size() - 1);

    try (StandardJavaFileManager fileManager = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
      fileManager.setLocationFromPaths(StandardLocation.CLASS_OUTPUT, List.of(Paths.get(classesDir)));
      Iterable<? extends javax.tools.JavaFileObject> units =
          fileManager.getJavaFileObjectsFromStrings(List.of(sourcePath));
      return Boolean.TRUE.equals(
          compiler.getTask(compilerStdout, fileManager, null, options, null, units).call());
    }
  }

  private static boolean compileSources(
      List<String> sourcePaths,
      String classesDir,
      String compileClasspath,
      String compilerDebugArg,
      PrintWriter compilerStdout,
      PrintWriter compilerStderr
  ) throws Exception {
    return compileSources(sourcePaths, List.of(), classesDir, compileClasspath, compilerDebugArg, compilerStdout, compilerStderr);
  }

  private static boolean compileSources(
      List<String> sourcePaths,
      List<String> sourceRootPaths,
      String classesDir,
      String compileClasspath,
      String compilerDebugArg,
      PrintWriter compilerStdout,
      PrintWriter compilerStderr
  ) throws Exception {
    List<String> javacArgs = new ArrayList<>();
    javacArgs.add(compilerDebugArg);
    javacArgs.add("-d");
    javacArgs.add(classesDir);
    if (compileClasspath != null && !compileClasspath.isEmpty()) {
      javacArgs.add("-classpath");
      javacArgs.add(compileClasspath);
    }
    if (sourceRootPaths != null && !sourceRootPaths.isEmpty()) {
      javacArgs.add("-sourcepath");
      javacArgs.add(String.join(File.pathSeparator, sourceRootPaths));
    }
    javacArgs.addAll(sourcePaths);

    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    if (compiler == null) {
      return compileWithBundledJavac(javacArgs.toArray(new String[0]), compilerStderr);
    }

    List<String> options = new ArrayList<>();
    options.add("--release");
    options.add("17");
    options.addAll(javacArgs);
    options.removeAll(sourcePaths);

    try (StandardJavaFileManager fileManager = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
      fileManager.setLocationFromPaths(StandardLocation.CLASS_OUTPUT, List.of(Paths.get(classesDir)));
      if (sourceRootPaths != null && !sourceRootPaths.isEmpty()) {
        fileManager.setLocationFromPaths(
            StandardLocation.SOURCE_PATH,
            sourceRootPaths.stream().map(Paths::get).collect(Collectors.toList()));
      }
      Iterable<? extends javax.tools.JavaFileObject> units =
          fileManager.getJavaFileObjectsFromStrings(sourcePaths);
      return Boolean.TRUE.equals(
          compiler.getTask(compilerStdout, fileManager, null, options, null, units).call());
    }
  }

  private static List<String> writeProjectSources(String sourceManifest, Path sourceRoot) throws IOException {
    resetDirectory(sourceRoot);
    Files.createDirectories(sourceRoot);

    List<String> sources = new ArrayList<>();
    if (sourceManifest == null || sourceManifest.isEmpty()) {
      return sources;
    }

    for (String line : sourceManifest.split("\\n")) {
      if (line.isEmpty()) continue;
      int separator = line.indexOf('\t');
      if (separator <= 0) {
        throw new IOException("Invalid Java project source manifest entry");
      }

      String relativePath = line.substring(0, separator);
      String encodedSource = line.substring(separator + 1);
      Path target = safeProjectSourcePath(sourceRoot, relativePath);
      Files.createDirectories(target.getParent());
      Files.writeString(
          target,
          new String(Base64.getDecoder().decode(encodedSource), StandardCharsets.UTF_8),
          StandardCharsets.UTF_8);
      sources.add(target.toString());
    }
    return sources;
  }

  private static void writeProjectResourceFiles(String resourceManifest, Path resourceRoot) throws IOException {
    resetDirectory(resourceRoot);
    Files.createDirectories(resourceRoot);
    for (ProjectManifestEntry entry : parseProjectManifest(resourceManifest)) {
      if (isKernelVirtualManifestPath(entry.path)) continue;
      Path target = safeProjectResourcePath(resourceRoot, entry.path);
      if (entry.directory) {
        Files.createDirectories(target);
      } else {
        Files.createDirectories(target.getParent());
        Files.write(target, entry.contents);
      }
    }
  }

  private static void writeCompiledClassManifest(String classManifest, Path classesPath) throws IOException {
    resetDirectory(classesPath);
    Files.createDirectories(classesPath);
    if (classManifest == null || classManifest.isEmpty()) {
      throw new IOException("Compiled Java class manifest is empty");
    }

    int count = 0;
    for (String line : classManifest.split("\\n")) {
      if (line.isEmpty()) continue;
      int separator = line.indexOf('\t');
      if (separator <= 0) {
        throw new IOException("Invalid compiled Java class manifest entry");
      }

      String relativePath = line.substring(0, separator);
      if (!relativePath.endsWith(".class")) {
        throw new IOException("Compiled Java artifact is not a class file: " + relativePath);
      }
      if (relativePath.startsWith(".tracecode-") || relativePath.contains("/.tracecode-")) {
        throw new IOException("Compiled Java artifact path is reserved: " + relativePath);
      }
      Path target = safeProjectSourcePath(classesPath, relativePath);
      Files.createDirectories(target.getParent());
      Files.write(target, Base64.getDecoder().decode(line.substring(separator + 1)));
      count += 1;
    }

    if (count == 0) {
      throw new IOException("Compiled Java class manifest did not contain class files");
    }
  }

  private static List<ProjectManifestEntry> parseProjectManifest(String manifest) throws IOException {
    List<ProjectManifestEntry> entries = new ArrayList<>();
    if (manifest == null || manifest.isEmpty()) {
      return entries;
    }

    for (String line : manifest.split("\\n")) {
      if (line.isEmpty()) continue;
      if (line.startsWith("\tdir\t")) {
        entries.add(new ProjectManifestEntry(line.substring("\tdir\t".length()), new byte[0], true));
        continue;
      }
      int separator = line.indexOf('\t');
      if (separator <= 0) {
        throw new IOException("Invalid Java project manifest entry");
      }
      entries.add(new ProjectManifestEntry(
          line.substring(0, separator),
          Base64.getDecoder().decode(line.substring(separator + 1)),
          false));
    }
    return entries;
  }

  private static final class ProjectManifestEntry {
    final String path;
    final byte[] contents;
    final boolean directory;

    ProjectManifestEntry(String path, byte[] contents, boolean directory) {
      this.path = path;
      this.contents = contents;
      this.directory = directory;
    }
  }

  private static List<String> selectedProjectSources(List<String> sourcePaths, Path sourceRoot) throws IOException {
    List<String> sources = new ArrayList<>();
    for (String sourcePath : sourcePaths) {
      sources.add(safeProjectSourcePath(sourceRoot, sourcePath).toString());
    }
    return sources;
  }

  private static List<String> selectedProjectSourceRoots(List<String> sourcePaths, Path sourceRoot) throws IOException {
    List<String> sources = new ArrayList<>();
    for (String sourcePath : sourcePaths) {
      sources.add(sourcePath == null || sourcePath.isEmpty()
          ? sourceRoot.toString()
          : safeProjectSourcePath(sourceRoot, sourcePath).toString());
    }
    return sources;
  }

  private static Path safeProjectSourcePath(Path sourceRoot, String relativePath) throws IOException {
    if (relativePath == null || relativePath.isEmpty() || relativePath.startsWith("/") || relativePath.contains("\\")) {
      throw new IOException("Invalid Java project source path: " + relativePath);
    }

    Path root = sourceRoot.toAbsolutePath().normalize();
    Path target = root.resolve(relativePath).normalize();
    if (!target.startsWith(root) || target.equals(root)) {
      throw new IOException("Java project source path escapes source root: " + relativePath);
    }
    return target;
  }

  private static Path safeProjectResourcePath(Path resourceRoot, String path) throws IOException {
    if (isKernelVirtualManifestPath(path)) {
      return Paths.get(path).toAbsolutePath().normalize();
    }
    return safeProjectSourcePath(resourceRoot, path);
  }

  private static boolean isKernelVirtualManifestPath(String path) {
    return path != null && path.startsWith("/") && !path.equals("/dev") && !path.startsWith("/dev/");
  }

  private static boolean compileWithBundledJavac(String[] args, PrintWriter compilerStderr) throws Exception {
    Class<?> javacMain = Class.forName("com.sun.tools.javac.Main");
    Method compile = javacMain.getMethod("compile", String[].class, PrintWriter.class);
    Object result = compile.invoke(null, args, compilerStderr);
    if (!(result instanceof Integer)) {
      throw new IllegalStateException("Bundled javac returned an unexpected result");
    }
    return ((Integer) result).intValue() == 0;
  }

  private static boolean canReuseCompiledClasses(
      Path classesDir,
      Path cacheKeyPath,
      String cacheKey,
      String entryClass
  ) throws IOException {
    return canReuseCompiledClasses(classesDir, cacheKeyPath, cacheKey, List.of(entryClass));
  }

  private static void assertRestoredCompileCache(
      Path classesDir,
      String cacheKeyFile,
      List<String> entryClasses
  ) throws IOException {
    Path cacheKeyPath = classesDir.resolve(cacheKeyFile);
    if (!Files.exists(cacheKeyPath)) throw new IOException("Restored Java compile cache is missing its key.");
    String storedKey = Files.readString(cacheKeyPath, StandardCharsets.UTF_8);
    if (!canReuseCompiledClasses(classesDir, cacheKeyPath, storedKey, entryClasses)) {
      throw new IOException("Restored Java compile cache failed entry or manifest validation.");
    }
  }

  private static boolean canReuseCompiledClasses(
      Path classesDir,
      Path cacheKeyPath,
      String cacheKey,
      List<String> entryClasses
  ) throws IOException {
    if (!Files.exists(cacheKeyPath)) return false;
    for (String entryClass : entryClasses) {
      Path classFile = classesDir.resolve(entryClass.replace('.', '/') + ".class");
      if (!Files.exists(classFile)) return false;
    }
    if (!cacheKey.equals(Files.readString(cacheKeyPath, StandardCharsets.UTF_8))) return false;
    Path manifestPath = cacheManifestPath(cacheKeyPath);
    return Files.exists(manifestPath) &&
        Files.readString(manifestPath, StandardCharsets.UTF_8).equals(compiledOutputManifest(classesDir));
  }

  private static void writeCompileCacheMetadata(Path classesDir, Path cacheKeyPath, String cacheKey) throws IOException {
    Files.writeString(cacheKeyPath, cacheKey, StandardCharsets.UTF_8);
    Files.writeString(cacheManifestPath(cacheKeyPath), compiledOutputManifest(classesDir), StandardCharsets.UTF_8);
  }

  private static Path cacheManifestPath(Path cacheKeyPath) {
    return cacheKeyPath.resolveSibling(cacheKeyPath.getFileName().toString() + ".manifest");
  }

  private static String compiledOutputManifest(Path classesDir) throws IOException {
    MessageDigest digest = newSha256Digest();
    updateDigest(digest, RUN_CACHE_VERSION);
    if (!Files.exists(classesDir)) return hexDigest(digest.digest());

    List<Path> files;
    try (Stream<Path> stream = Files.walk(classesDir)) {
      files = stream
          .filter(Files::isRegularFile)
          .filter(path -> !path.getFileName().toString().startsWith(".tracecode-"))
          .sorted()
          .collect(Collectors.toList());
    }
    for (Path file : files) {
      byte[] bytes = Files.readAllBytes(file);
      updateDigest(digest, classesDir.relativize(file).toString().replace('\\', '/'));
      updateDigest(digest, Integer.toString(bytes.length));
      digest.update((byte) 1);
      digest.update(bytes);
    }
    return hexDigest(digest.digest());
  }

  private static void resetDirectory(Path dir) throws IOException {
    if (!Files.exists(dir)) {
      Files.createDirectories(dir);
      return;
    }
    try (Stream<Path> stream = Files.walk(dir)) {
      stream
          .sorted((left, right) -> right.getNameCount() - left.getNameCount())
          .filter(path -> !path.equals(dir))
          .forEach(path -> {
            try {
              Files.deleteIfExists(path);
            } catch (IOException error) {
              throw new RuntimeException(error);
            }
          });
    } catch (RuntimeException error) {
      if (error.getCause() instanceof IOException) throw (IOException) error.getCause();
      throw error;
    }
  }

  private static String hashSource(
      String source,
      String compileClasspath,
      String entryClass,
      String compilerDebugArg
  ) throws Exception {
    MessageDigest digest = newSha256Digest();
    updateDigest(digest, RUN_CACHE_VERSION);
    updateDigest(digest, source);
    updateDigest(digest, compileClasspath == null ? "" : compileClasspath);
    updateDigest(digest, entryClass == null ? "" : entryClass);
    updateDigest(digest, compilerDebugArg == null ? "" : compilerDebugArg);
    return hexDigest(digest.digest());
  }

  private static String hashSources(
      List<String> sourcePaths,
      String compileClasspath,
      String entryClass,
      String compilerDebugArg
  ) throws Exception {
    MessageDigest digest = newSha256Digest();
    updateDigest(digest, RUN_CACHE_VERSION);
    for (String sourcePath : sourcePaths) {
      updateDigest(digest, sourcePath);
      updateDigest(digest, Files.readString(Paths.get(sourcePath), StandardCharsets.UTF_8));
    }
    updateDigest(digest, compileClasspath == null ? "" : compileClasspath);
    updateDigest(digest, entryClass == null ? "" : entryClass);
    updateDigest(digest, compilerDebugArg == null ? "" : compilerDebugArg);
    return hexDigest(digest.digest());
  }

  private static MessageDigest newSha256Digest() throws IOException {
    try {
      return MessageDigest.getInstance("SHA-256");
    } catch (java.security.NoSuchAlgorithmException error) {
      throw new IOException("SHA-256 digest is unavailable", error);
    }
  }

  private static String hexDigest(byte[] bytes) {
    StringBuilder out = new StringBuilder(bytes.length * 2);
    for (byte value : bytes) {
      out.append(Character.forDigit((value >> 4) & 0xf, 16));
      out.append(Character.forDigit(value & 0xf, 16));
    }
    return out.toString();
  }

  private static void updateDigest(MessageDigest digest, String value) {
    digest.update((byte) 0);
    digest.update(value.getBytes(StandardCharsets.UTF_8));
  }

  private static String compilerDebugArgForProfile(String profile) {
    if ("none".equals(profile)) return "-g:none";
    if ("lines".equals(profile)) return "-g:source,lines";
    return "-g";
  }

  private static long millisBetween(long start, long end) {
    return Math.max(0, (end - start) / 1_000_000L);
  }

  private static long parseLongOrZero(String value) {
    try {
      return Math.max(0, Long.parseLong(String.valueOf(value)));
    } catch (Exception ignored) {
      return 0;
    }
  }

  private static boolean parseBoolean(String value) {
    return "true".equalsIgnoreCase(String.valueOf(value));
  }

  private static String buildRunReportJson(
      boolean success,
      String output,
      String compilerStdout,
      String compilerStderr,
      String runtimeError,
      long compileTimeMs,
      long classLoadTimeMs,
      long runTimeMs,
      boolean compileCacheHit,
      String compilerProfile
  ) {
    return buildRunReportJson(
        success,
        output,
        compilerStdout,
        compilerStderr,
        runtimeError,
        compileTimeMs,
        classLoadTimeMs,
        runTimeMs,
        compileCacheHit,
        compilerProfile,
        null);
  }

  private static String buildRunReportJson(
      boolean success,
      String output,
      String compilerStdout,
      String compilerStderr,
      String runtimeError,
      long compileTimeMs,
      long classLoadTimeMs,
      long runTimeMs,
      boolean compileCacheHit,
      String compilerProfile,
      String compiledFilesJson
  ) {
    return buildRunReportJson(
        success,
        output,
        compilerStdout,
        compilerStderr,
        runtimeError,
        compileTimeMs,
        classLoadTimeMs,
        runTimeMs,
        compileCacheHit,
        compilerProfile,
        compiledFilesJson,
        null);
  }

  private static String buildRunReportJson(
      boolean success,
      String output,
      String compilerStdout,
      String compilerStderr,
      String runtimeError,
      long compileTimeMs,
      long classLoadTimeMs,
      long runTimeMs,
      boolean compileCacheHit,
      String compilerProfile,
      String compiledFilesJson,
      String changedFilesJson
  ) {
    StringBuilder out = new StringBuilder();
    out.append('{');
    out.append("\"success\":").append(success);
    if (output != null) {
      out.append(",\"output\":").append(quote(output));
    }
    out.append(",\"compilerStdout\":").append(quote(compilerStdout == null ? "" : compilerStdout));
    out.append(",\"compilerStderr\":").append(quote(compilerStderr == null ? "" : compilerStderr));
    out.append(",\"compileTimeMs\":").append(compileTimeMs);
    out.append(",\"classLoadTimeMs\":").append(classLoadTimeMs);
    out.append(",\"runTimeMs\":").append(runTimeMs);
    out.append(",\"compileCacheHit\":").append(compileCacheHit);
    out.append(",\"compilerDebugProfile\":").append(quote(compilerProfile == null ? "" : compilerProfile));
    if (compiledFilesJson != null) {
      out.append(",\"compiledFiles\":").append(compiledFilesJson);
    }
    if (changedFilesJson != null) {
      out.append(",\"changedFiles\":").append(changedFilesJson);
    }
    if (runtimeError != null) {
      out.append(",\"runtimeError\":").append(quote(runtimeError));
    }
    out.append('}');
    return out.toString();
  }

  private static String collectCompiledFilesJson(Path classesPath) throws IOException {
    StringBuilder out = new StringBuilder();
    out.append('[');
    if (Files.exists(classesPath)) {
      List<Path> files;
      try (Stream<Path> stream = Files.walk(classesPath)) {
        files = stream
            .filter(Files::isRegularFile)
            .filter(path -> !path.getFileName().toString().startsWith(".tracecode-"))
            .sorted()
            .collect(Collectors.toList());
      }
      for (int index = 0; index < files.size(); index++) {
        Path file = files.get(index);
        if (index > 0) out.append(',');
        out.append('{');
        out.append("\"path\":").append(quote(classesPath.relativize(file).toString().replace('\\', '/')));
        out.append(",\"contents\":").append(quote(Base64.getEncoder().encodeToString(Files.readAllBytes(file))));
        out.append(",\"encoding\":\"base64\"");
        out.append('}');
      }
    }
    out.append(']');
    return out.toString();
  }

  private static String collectChangedProjectFilesJson(Path workspaceRoot, String workspaceManifest) throws IOException {
    List<ProjectManifestEntry> originalFiles = parseProjectManifest(workspaceManifest);
    java.util.Map<String, byte[]> originalByPath = new java.util.HashMap<>();
    for (ProjectManifestEntry entry : originalFiles) {
      if (entry.directory) continue;
      if (isKernelVirtualManifestPath(entry.path)) continue;
      originalByPath.put(entry.path, entry.contents);
    }

    StringBuilder out = new StringBuilder();
    out.append('[');
    if (Files.exists(workspaceRoot)) {
      List<Path> files;
      try (Stream<Path> stream = Files.walk(workspaceRoot)) {
        files = stream
            .filter(Files::isRegularFile)
            .sorted()
            .collect(Collectors.toList());
      }
      int count = 0;
      for (Path file : files) {
        String relativePath = workspaceRoot.relativize(file).toString().replace('\\', '/');
        byte[] contents = Files.readAllBytes(file);
        byte[] original = originalByPath.get(relativePath);
        originalByPath.remove(relativePath);
        if (original != null && java.util.Arrays.equals(original, contents)) continue;
        if (count > 0) out.append(',');
        out.append('{');
        out.append("\"path\":").append(quote(relativePath));
        out.append(",\"contents\":").append(quote(Base64.getEncoder().encodeToString(contents)));
        out.append(",\"encoding\":\"base64\"");
        out.append('}');
        count += 1;
      }
      List<String> deletedPaths = new java.util.ArrayList<>(originalByPath.keySet());
      java.util.Collections.sort(deletedPaths);
      for (String deletedPath : deletedPaths) {
        if (count > 0) out.append(',');
        out.append('{');
        out.append("\"path\":").append(quote(deletedPath));
        out.append(",\"deleted\":true");
        out.append('}');
        count += 1;
      }
    }
    out.append(']');
    return out.toString();
  }

  private static String buildRunBatchReportJson(
      boolean success,
      List<String> results,
      String compilerStdout,
      String compilerStderr,
      String runtimeError,
      long compileTimeMs,
      boolean compileCacheHit,
      String compilerProfile
  ) {
    StringBuilder out = new StringBuilder();
    out.append('{');
    out.append("\"success\":").append(success);
    out.append(",\"results\":[");
    for (int index = 0; index < results.size(); index++) {
      if (index > 0) out.append(',');
      out.append(results.get(index));
    }
    out.append(']');
    out.append(",\"compilerStdout\":").append(quote(compilerStdout == null ? "" : compilerStdout));
    out.append(",\"compilerStderr\":").append(quote(compilerStderr == null ? "" : compilerStderr));
    out.append(",\"compileTimeMs\":").append(compileTimeMs);
    out.append(",\"compileCacheHit\":").append(compileCacheHit);
    out.append(",\"compilerDebugProfile\":").append(quote(compilerProfile == null ? "" : compilerProfile));
    if (runtimeError != null) {
      out.append(",\"runtimeError\":").append(quote(runtimeError));
    }
    out.append('}');
    return out.toString();
  }

  private static String buildTraceReportJson(
      boolean success,
      String output,
      List<String> events,
      String compilerStdout,
      String compilerStderr,
      String runtimeError,
      long compileTimeMs,
      long classLoadTimeMs,
      long runTimeMs,
      boolean compileCacheHit,
      String compilerProfile,
      boolean traceLimitExceeded,
      int droppedEventCount
  ) {
    StringBuilder out = new StringBuilder();
    out.append('{');
    out.append("\"success\":").append(success);
    if (output != null) {
      out.append(",\"output\":").append(quote(output));
    }
    out.append(",\"events\":[");
    for (int index = 0; index < events.size(); index++) {
      if (index > 0) out.append(',');
      out.append(quote(events.get(index)));
    }
    out.append(']');
    out.append(",\"compilerStdout\":").append(quote(compilerStdout == null ? "" : compilerStdout));
    out.append(",\"compilerStderr\":").append(quote(compilerStderr == null ? "" : compilerStderr));
    out.append(",\"compileTimeMs\":").append(compileTimeMs);
    out.append(",\"classLoadTimeMs\":").append(classLoadTimeMs);
    out.append(",\"runTimeMs\":").append(runTimeMs);
    out.append(",\"compileCacheHit\":").append(compileCacheHit);
    out.append(",\"compilerDebugProfile\":").append(quote(compilerProfile == null ? "" : compilerProfile));
    out.append(",\"traceLimitExceeded\":").append(traceLimitExceeded);
    out.append(",\"droppedEventCount\":").append(droppedEventCount);
    if (runtimeError != null) {
      out.append(",\"runtimeError\":").append(quote(runtimeError));
    }
    out.append('}');
    return out.toString();
  }

  private static String buildInvocationReportJson(InvocationReport result) {
    StringBuilder out = new StringBuilder();
    out.append('{');
    out.append("\"success\":").append(result.success);
    if (result.output != null) {
      out.append(",\"output\":").append(quote(result.output));
    }
    out.append(",\"classLoadTimeMs\":").append(result.classLoadTimeMs);
    out.append(",\"runTimeMs\":").append(result.runTimeMs);
    if (result.runtimeError != null) {
      out.append(",\"runtimeError\":").append(quote(result.runtimeError));
    }
    out.append('}');
    return out.toString();
  }

  private static InvocationReport runEntryClass(Path classesPath, String entryClass) {
    return runEntryClass(classesPath, entryClass, List.of());
  }

  private static InvocationReport runEntryClass(Path classesPath, String entryClass, List<Path> runtimeClasspath) {
    return runEntryClass(classesPath, entryClass, runtimeClasspath, null);
  }

  private static InvocationReport runEntryClass(
      Path classesPath,
      String entryClass,
      List<Path> runtimeClasspath,
      Path workingDirectory
  ) {
    long classLoadStart = System.nanoTime();
    long classLoadEnd = classLoadStart;
    long runStart = 0;
    long runEnd = 0;
    String previousUserDir = System.getProperty("user.dir");
    int traceRunToken = TraceHooks.beginRun();
    try (URLClassLoader loader = new URLClassLoader(
        classpathUrls(classesPath, runtimeClasspath),
        BrowserCompileAndTraceLibrary.class.getClassLoader())) {
      Class<?> entry = Class.forName(entryClass, true, loader);
      Method run = entry.getMethod("run");
      run.setAccessible(true);
      classLoadEnd = System.nanoTime();
      runStart = System.nanoTime();
      if (workingDirectory != null) {
        Files.createDirectories(workingDirectory);
        System.setProperty("user.dir", workingDirectory.toAbsolutePath().normalize().toString());
      }
      Object output = run.invoke(null);
      runEnd = System.nanoTime();
      return new InvocationReport(
          true,
          String.valueOf(output),
          null,
          millisBetween(classLoadStart, classLoadEnd),
          millisBetween(runStart, runEnd));
    } catch (InvocationTargetException error) {
      Throwable cause = error.getCause() == null ? error : error.getCause();
      runEnd = System.nanoTime();
      return new InvocationReport(
          false,
          null,
          stackTrace(cause),
          millisBetween(classLoadStart, classLoadEnd),
          runStart == 0 ? 0 : millisBetween(runStart, runEnd));
    } catch (Throwable error) {
      long end = System.nanoTime();
      if (runStart == 0) {
        classLoadEnd = end;
      } else {
        runEnd = end;
      }
      return new InvocationReport(
          false,
          null,
          stackTrace(error),
          millisBetween(classLoadStart, classLoadEnd),
          runStart == 0 ? 0 : millisBetween(runStart, runEnd));
    } finally {
      if (workingDirectory != null && previousUserDir != null) {
        System.setProperty("user.dir", previousUserDir);
      }
      TraceHooks.endRun(traceRunToken);
    }
  }

  private static TraceInvocationReport traceEntryClass(
      Path classesPath,
      String entryClass,
      List<Path> runtimeClasspath,
      int maxStoredEvents
  ) {
    long classLoadStart = System.nanoTime();
    long classLoadEnd = classLoadStart;
    long runStart = 0;
    long runEnd = 0;
    Object output = null;
    String runtimeError = null;
    List<String> events = new ArrayList<>();
    boolean success = true;
    boolean traceLimitExceeded = false;
    int droppedEventCount = 0;

    int traceRunToken = TraceHooks.beginRun(maxStoredEvents);
    try (URLClassLoader loader = new URLClassLoader(
        classpathUrls(classesPath, runtimeClasspath),
        BrowserCompileAndTraceLibrary.class.getClassLoader())) {
      Class<?> entry = Class.forName(entryClass, true, loader);
      Method run = entry.getMethod("run");
      run.setAccessible(true);
      classLoadEnd = System.nanoTime();
      runStart = System.nanoTime();
      output = run.invoke(null);
      runEnd = System.nanoTime();
    } catch (InvocationTargetException error) {
      Throwable cause = error.getCause() == null ? error : error.getCause();
      runEnd = System.nanoTime();
      runtimeError = stackTrace(cause);
      success = false;
    } catch (Throwable error) {
      long end = System.nanoTime();
      if (runStart == 0) {
        classLoadEnd = end;
      } else {
        runEnd = end;
      }
      runtimeError = stackTrace(error);
      success = false;
    } finally {
      events = TraceHooks.drainEvents();
      traceLimitExceeded = TraceHooks.traceLimitExceeded();
      droppedEventCount = TraceHooks.droppedEventCount();
      TraceHooks.endRun(traceRunToken);
    }

    return new TraceInvocationReport(
        success,
        output == null ? null : String.valueOf(output),
        runtimeError,
        events,
        millisBetween(classLoadStart, classLoadEnd),
        runStart == 0 ? 0 : millisBetween(runStart, runEnd),
        traceLimitExceeded,
        droppedEventCount);
  }

  private static URL[] classpathUrls(Path classesPath, List<Path> runtimeClasspath) throws IOException {
    List<URL> urls = new ArrayList<>();
    urls.add(classesPath.toUri().toURL());
    for (Path entry : runtimeClasspath) {
      urls.add(entry.toUri().toURL());
    }
    return urls.toArray(new URL[0]);
  }

  private static List<Path> classpathPaths(String runtimeClasspath) {
    List<Path> paths = new ArrayList<>();
    if (runtimeClasspath == null || runtimeClasspath.isEmpty()) return paths;
    for (String entry : runtimeClasspath.split(java.util.regex.Pattern.quote(File.pathSeparator))) {
      if (!entry.isEmpty()) {
        paths.add(Paths.get(entry));
      }
    }
    return paths;
  }

  private static String combineClasspaths(String left, String right) {
    boolean hasLeft = left != null && !left.isEmpty();
    boolean hasRight = right != null && !right.isEmpty();
    if (hasLeft && hasRight) return left + File.pathSeparator + right;
    if (hasLeft) return left;
    if (hasRight) return right;
    return "";
  }

  private static List<String> splitEntryClasses(String entryClasses) {
    return splitLines(entryClasses);
  }

  private static List<String> splitLines(String value) {
    List<String> entries = new ArrayList<>();
    if (value == null) return entries;
    for (String entry : value.split("\\n")) {
      String trimmed = entry.trim();
      if (!trimmed.isEmpty()) entries.add(trimmed);
    }
    return entries;
  }

  private static final class InvocationReport {
    final boolean success;
    final String output;
    final String runtimeError;
    final long classLoadTimeMs;
    final long runTimeMs;

    InvocationReport(
        boolean success,
        String output,
        String runtimeError,
        long classLoadTimeMs,
        long runTimeMs
    ) {
      this.success = success;
      this.output = output;
      this.runtimeError = runtimeError;
      this.classLoadTimeMs = classLoadTimeMs;
      this.runTimeMs = runTimeMs;
    }
  }

  private static final class TraceInvocationReport {
    final boolean success;
    final String output;
    final String runtimeError;
    final List<String> events;
    final long classLoadTimeMs;
    final long runTimeMs;
    final boolean traceLimitExceeded;
    final int droppedEventCount;

    TraceInvocationReport(
        boolean success,
        String output,
        String runtimeError,
        List<String> events,
        long classLoadTimeMs,
        long runTimeMs,
        boolean traceLimitExceeded,
        int droppedEventCount
    ) {
      this.success = success;
      this.output = output;
      this.runtimeError = runtimeError;
      this.events = events;
      this.classLoadTimeMs = classLoadTimeMs;
      this.runTimeMs = runTimeMs;
      this.traceLimitExceeded = traceLimitExceeded;
      this.droppedEventCount = droppedEventCount;
    }
  }

  private static String stackTrace(Throwable error) {
    StringWriter writer = new StringWriter();
    error.printStackTrace(new PrintWriter(writer, true));
    return writer.toString();
  }

  private static String quote(String value) {
    StringBuilder out = new StringBuilder(value.length() + 16);
    out.append('"');
    for (int index = 0; index < value.length(); index++) {
      char ch = value.charAt(index);
      switch (ch) {
        case '\\':
          out.append("\\\\");
          break;
        case '"':
          out.append("\\\"");
          break;
        case '\n':
          out.append("\\n");
          break;
        case '\r':
          out.append("\\r");
          break;
        case '\t':
          out.append("\\t");
          break;
        case '\b':
          out.append("\\b");
          break;
        case '\f':
          out.append("\\f");
          break;
        default:
          if (ch < 32) {
            out.append(String.format("\\u%04x", (int) ch));
          } else {
            out.append(ch);
          }
      }
    }
    out.append('"');
    return out.toString();
  }
}

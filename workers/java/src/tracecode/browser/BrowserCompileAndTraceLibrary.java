package tracecode.browser;

import java.io.IOException;
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
import java.util.List;
import java.util.stream.Stream;
import javax.tools.JavaCompiler;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;

public final class BrowserCompileAndTraceLibrary {
  private static final String LEGACY_PACKAGE = "spi" + "ke.browser.";
  private static final String RUN_CACHE_VERSION = "tracecode-java-run-v1";

  private BrowserCompileAndTraceLibrary() {}

  public static String compileAndTrace(
      String sourcePath,
      String classesDir,
      String entryClass,
      String compileClasspath,
      String compilerProfile
  ) throws Exception {
    Method method = legacyClass().getMethod(
        "compileAndTrace",
        String.class,
        String.class,
        String.class,
        String.class,
        String.class
    );
    return (String) method.invoke(null, sourcePath, classesDir, entryClass, compileClasspath, compilerProfile);
  }

  public static String compileAndTrace(
      String sourcePath,
      String classesDir,
      String entryClass,
      String compileClasspath,
      String compilerProfile,
      String maxStoredEvents
  ) throws Exception {
    Method method = legacyClass().getMethod(
        "compileAndTrace",
        String.class,
        String.class,
        String.class,
        String.class,
        String.class,
        String.class
    );
    return (String) method.invoke(null, sourcePath, classesDir, entryClass, compileClasspath, compilerProfile, maxStoredEvents);
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

    String source = Files.readString(sourceFile, StandardCharsets.UTF_8);
    String compilerDebugArg = compilerDebugArgForProfile(compilerProfile);
    String cacheKey = hashSource(source, compileClasspath, entryClass, compilerDebugArg);
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
      compiled = compileSource(
          sourcePath,
          classesDir,
          compileClasspath,
          compilerDebugArg,
          compilerStdoutWriter,
          compilerStderrWriter);
      if (compiled) {
        Files.writeString(cacheKeyPath, cacheKey, StandardCharsets.UTF_8);
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

    long classLoadStart = System.nanoTime();
    long classLoadEnd = classLoadStart;
    long runStart = 0;
    long runEnd = 0;
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
    }
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
        Files.writeString(cacheKeyPath, cacheKey, StandardCharsets.UTF_8);
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

  private static Class<?> legacyClass() throws ClassNotFoundException {
    return Class.forName(LEGACY_PACKAGE + "BrowserCompileAndTraceLibrary");
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
    return cacheKey.equals(Files.readString(cacheKeyPath, StandardCharsets.UTF_8));
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
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    updateDigest(digest, RUN_CACHE_VERSION);
    updateDigest(digest, source);
    updateDigest(digest, compileClasspath == null ? "" : compileClasspath);
    updateDigest(digest, entryClass == null ? "" : entryClass);
    updateDigest(digest, compilerDebugArg == null ? "" : compilerDebugArg);
    byte[] bytes = digest.digest();
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
    if (runtimeError != null) {
      out.append(",\"runtimeError\":").append(quote(runtimeError));
    }
    out.append('}');
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
    long classLoadStart = System.nanoTime();
    long classLoadEnd = classLoadStart;
    long runStart = 0;
    long runEnd = 0;
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
    }
  }

  private static List<String> splitEntryClasses(String entryClasses) {
    List<String> entries = new ArrayList<>();
    if (entryClasses == null) return entries;
    for (String entry : entryClasses.split("\\n")) {
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

package tracecode.browser;

public final class BrowserCompileAndTraceMain {
  private BrowserCompileAndTraceMain() {}

  public static void main(String[] args) throws Exception {
    if (args.length < 4) {
      throw new IllegalArgumentException("Usage: <sourceFile> <classesDir> <reportPath> <entryClass> [compileClasspath]");
    }
    String sourcePath = args[0];
    String classesDir = args[1];
    String reportPath = args[2];
    String entryClass = args[3];
    String compileClasspath = args.length >= 5 ? args[4] : "";
    String compilerProfile = "full";
    int maxStoredEvents = 50000;
    if (args.length >= 6) {
      if (isInteger(args[5])) {
        maxStoredEvents = Integer.parseInt(args[5]);
      } else {
        compilerProfile = args[5];
      }
    }
    if (args.length >= 7) {
      maxStoredEvents = Integer.parseInt(args[6]);
    }
    String report = compileAndTrace(sourcePath, classesDir, entryClass, compileClasspath, compilerProfile, maxStoredEvents);
    java.nio.file.Path outputPath = java.nio.file.Paths.get(reportPath);
    if (outputPath.getParent() != null) {
      java.nio.file.Files.createDirectories(outputPath.getParent());
    }
    java.nio.file.Files.writeString(outputPath, report, java.nio.charset.StandardCharsets.UTF_8);
  }

  public static String compileAndTrace(
      String sourcePath,
      String classesDir,
      String entryClass,
      String compileClasspath,
      String compilerProfile
  ) throws Exception {
    return BrowserCompileAndTraceLibrary.compileAndTrace(
        sourcePath,
        classesDir,
        entryClass,
        compileClasspath,
        compilerProfile);
  }

  public static String compileAndTrace(
      String sourcePath,
      String classesDir,
      String entryClass,
      String compileClasspath,
      String compilerProfile,
      int maxStoredEvents
  ) throws Exception {
    return BrowserCompileAndTraceLibrary.compileAndTrace(
        sourcePath,
        classesDir,
        entryClass,
        compileClasspath,
        compilerProfile,
        maxStoredEvents);
  }

  private static boolean isInteger(String value) {
    if (value == null || value.isEmpty()) return false;
    for (int index = 0; index < value.length(); index++) {
      char ch = value.charAt(index);
      if (index == 0 && ch == '-') continue;
      if (ch < '0' || ch > '9') return false;
    }
    return true;
  }
}

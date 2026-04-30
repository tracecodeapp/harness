package tracecode.browser;

import java.lang.reflect.Method;

public final class BrowserCompileAndTraceMain {
  private static final String LEGACY_PACKAGE = "spi" + "ke.browser.";

  private BrowserCompileAndTraceMain() {}

  public static void main(String[] args) throws Exception {
    Method method = legacyClass().getMethod("main", String[].class);
    method.invoke(null, (Object) args);
  }

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
      int maxStoredEvents
  ) throws Exception {
    Method method = legacyClass().getMethod(
        "compileAndTrace",
        String.class,
        String.class,
        String.class,
        String.class,
        String.class,
        int.class
    );
    return (String) method.invoke(null, sourcePath, classesDir, entryClass, compileClasspath, compilerProfile, maxStoredEvents);
  }

  private static Class<?> legacyClass() throws ClassNotFoundException {
    return Class.forName(LEGACY_PACKAGE + "BrowserCompileAndTraceMain");
  }
}

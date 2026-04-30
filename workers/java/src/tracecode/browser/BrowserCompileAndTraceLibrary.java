package tracecode.browser;

import java.lang.reflect.Method;

public final class BrowserCompileAndTraceLibrary {
  private static final String LEGACY_PACKAGE = "spi" + "ke.browser.";

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

  private static Class<?> legacyClass() throws ClassNotFoundException {
    return Class.forName(LEGACY_PACKAGE + "BrowserCompileAndTraceLibrary");
  }
}

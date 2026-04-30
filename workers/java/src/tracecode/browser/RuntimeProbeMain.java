package tracecode.browser;

import java.lang.reflect.Method;

public final class RuntimeProbeMain {
  private static final String LEGACY_PACKAGE = "spi" + "ke.browser.";

  private RuntimeProbeMain() {}

  public static void main(String[] args) throws Exception {
    Method method = Class.forName(LEGACY_PACKAGE + "RuntimeProbeMain").getMethod("main", String[].class);
    method.invoke(null, (Object) args);
  }
}

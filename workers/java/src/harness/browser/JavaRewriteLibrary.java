package harness.browser;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import spike.rewriter.GenericPracticeRewriter;

public final class JavaRewriteLibrary {
  private JavaRewriteLibrary() {}

  public static String rewriteSource(
      String source,
      String executionStyle,
      String entryName,
      String exportsSource,
      String exportsClassName,
      String packageName
  ) throws Exception {
    Path workDir = Files.createTempDirectory("tracecode-java-rewrite-");
    Path inputPath = workDir.resolve("Input.java");
    Path outputPath = workDir.resolve("Output.java");

    try {
      Files.writeString(inputPath, normalizeTopLevelPublicClasses(source), StandardCharsets.UTF_8);
      GenericPracticeRewriter.main(
          new String[] {
              inputPath.toString(),
              outputPath.toString(),
              executionStyle,
              entryName,
          });
      String rewrittenSource = normalizeRuntimeSnapshotHooks(Files.readString(outputPath, StandardCharsets.UTF_8));
      String renamedExports =
          exportsSource.replaceAll("\\bpublic class Exports\\b", "public class " + exportsClassName);
      return "package " + packageName + ";\n\n" + rewrittenSource.trim() + "\n\n" + renamedExports.trim() + "\n";
    } finally {
      try (var paths = Files.walk(workDir)) {
        paths
            .sorted((left, right) -> right.getNameCount() - left.getNameCount())
            .forEach(
                path -> {
                  try {
                    Files.deleteIfExists(path);
                  } catch (Exception ignored) {
                  }
                });
      }
    }
  }

  private static String normalizeTopLevelPublicClasses(String source) {
    return source.replaceAll("(^|\\n)\\s*public\\s+class\\s+", "$1class ");
  }

  private static String normalizeRuntimeSnapshotHooks(String source) {
    return source.replaceAll(
        "TraceHooks\\.emit(?:List|Tree|Object)StateAtLine\\(",
        "TraceHooks.emitRuntimeSnapshotAtLine(");
  }
}

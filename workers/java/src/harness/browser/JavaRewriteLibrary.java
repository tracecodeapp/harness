package harness.browser;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class JavaRewriteLibrary {
  private static final String CALL_ARGS_WITH_NESTED_PARENS = "((?:[^()\\n;]|\\([^()]*\\))+?)";
  private static final Pattern METHOD_START = Pattern.compile(
      "^(\\s*)(?:(?:public|private|protected|static|final|synchronized)\\s+)*(?:[A-Za-z_][A-Za-z0-9_<>, ?]*(?:\\s*\\[\\])*\\s+)+([A-Za-z_][A-Za-z0-9_]*)\\s*\\(([^)]*)\\)\\s*(?:throws\\s+[^\\{]+)?\\{\\s*$",
      Pattern.DOTALL);
  private static final Pattern METHOD_HEADER_START = Pattern.compile(
      "^\\s*(?:(?:public|private|protected|static|final|synchronized)\\s+)*(?:[A-Za-z_][A-Za-z0-9_<>, ?]*(?:\\s*\\[\\])*\\s+)+[A-Za-z_][A-Za-z0-9_]*\\s*\\(");
  private static final Pattern RETURN_STMT = Pattern.compile("^(\\s*)return(?:\\s+(.+?))?;\\s*$");
  private static final Pattern ARRAY_WRITE_2D = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]]+)\\]\\s*\\[([^;\\]]+)\\]\\s*=(?!=)\\s*(.+);\\s*$");
  private static final Pattern ARRAY_WRITE_1D = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]]+)\\]\\s*=(?!=)\\s*(.+);\\s*$");
  private static final Pattern ARRAY_COMPOUND_WRITE_2D = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]]+)\\]\\s*\\[([^;\\]]+)\\]\\s*([+\\-*/%&|^]|<<|>>|>>>)=\\s*(.+);\\s*$");
  private static final Pattern ARRAY_COMPOUND_WRITE_1D = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]]+)\\]\\s*([+\\-*/%&|^]|<<|>>|>>>)=\\s*(.+);\\s*$");
  private static final Pattern ARRAY_UPDATE_2D = Pattern.compile(
      "^(\\s*)(?:(\\+\\+|--))?\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]]+)\\]\\s*\\[([^;\\]]+)\\]\\s*(?:(\\+\\+|--))?;\\s*$");
  private static final Pattern ARRAY_UPDATE_1D = Pattern.compile(
      "^(\\s*)(?:(\\+\\+|--))?\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]]+)\\]\\s*(?:(\\+\\+|--))?;\\s*$");
  private static final Pattern STRING_CHAR_AT = Pattern.compile("\\b([A-Za-z_][A-Za-z0-9_]*)\\.charAt\\(([^()]+)\\)");
  private static final Pattern STRING_ARRAY_CHAR_AT = Pattern.compile("\\b([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]\\[]+)\\]\\.charAt\\(([^()]+)\\)");
  private static final Pattern STRING_ARRAY_LENGTH_CALL = Pattern.compile("\\b([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]\\[]+)\\]\\.length\\(\\)");
  private static final Pattern LIST_ARRAY_READ = Pattern.compile("\\b([A-Za-z_][A-Za-z0-9_]*)\\.get\\(([^()\\n;]+)\\)\\s*\\[([^;\\]\\[]+)\\]");
  private static final Pattern FIELD_WRITE = Pattern.compile("^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.+);\\s*$");
  private static final Pattern FIELD_PATH_WRITE = Pattern.compile(
      "^(\\s*)((?:this\\s*\\.\\s*)?[A-Za-z_][A-Za-z0-9_]*(?:\\s*\\.\\s*[A-Za-z_][A-Za-z0-9_]*){2,})\\s*=\\s*(.+);\\s*$");
  private static final Pattern FIELD_READ = Pattern.compile("(?<!\\.)\\b(?!System\\b|TraceHooks\\b)([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\b(?!\\s*\\()");
  private static final Pattern FIELD_DECLARATION = Pattern.compile(
      "^\\s*(?:public|private|protected|static|final|transient|volatile|\\s)*([A-Za-z_][A-Za-z0-9_<>?, \\[\\]]*(?:\\s*\\[\\])*)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*(?:=\\s*.+)?;\\s*$");
  private static final Pattern LOCAL_DECLARATION = Pattern.compile(
      "^(\\s*)(?:final\\s+)?([A-Za-z_][A-Za-z0-9_<>?, \\[\\]]*(?:\\s*\\[\\])*)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.+);\\s*$");
  private static final Pattern LOCAL_ASSIGNMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\s*=(?!=)\\s*(.+);\\s*$");
  private static final Pattern LOCAL_COMPOUND_ASSIGNMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\s*([+\\-*/%&|^]|<<|>>|>>>)=\\s*(.+);\\s*$");
  private static final Pattern LOCAL_UPDATE = Pattern.compile(
      "^(\\s*)(?:(\\+\\+|--))?\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*(?:(\\+\\+|--))?;\\s*$");
  private static final Pattern MUTATING_CALL_STATEMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)\\);\\s*$");
  private static final Pattern FIELD_INDEXED_MUTATING_CALL_STATEMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\.get\\(([^()\\n;]+)\\)\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)\\);\\s*$");
  private static final Pattern FIELD_MUTATING_CALL_STATEMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)\\);\\s*$");
  private static final Pattern FRONT_FIELD_MUTATING_CALL_STATEMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\.peek\\(\\)\\.([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)\\);\\s*$");
  private static final Pattern COMPUTE_IF_ABSENT_MUTATING_CALL_STATEMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\.computeIfAbsent\\((.+),\\s*([^;]+)\\)\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)\\);\\s*$");
  private static final Pattern INDEXED_MUTATING_CALL_STATEMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\.get\\(([^()\\n;]+)\\)\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)\\);\\s*$");
  private static final Pattern INDEXED_FIELD_MUTATING_CALL_STATEMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\.get\\(([^()\\n;]+)\\)\\.([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)\\);\\s*$");
  private static final Pattern ARRAY_INDEXED_MUTATING_CALL_STATEMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]\\[]+)\\]\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)\\);\\s*$");
  private static final Pattern ARRAY_INDEXED_MAP_WRITE_STATEMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]\\[]+)\\]\\.(put|merge)\\((.*)\\);\\s*$");
  private static final Pattern LIST_ARRAY_WRITE = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\.get\\(([^()\\n;]+)\\)\\s*\\[([^;\\]\\[]+)\\]\\s*=(?!=)\\s*(.+);\\s*$");
  private static final Pattern ARRAYS_FILL_STATEMENT = Pattern.compile(
      "^(\\s*)(?:java\\.util\\.)?Arrays\\.fill\\((.*)\\);\\s*$");
  private static final Pattern INDEXED_ARRAY_TARGET = Pattern.compile(
      "^([A-Za-z_][A-Za-z0-9_]*)\\s*\\[((?:[^\\]\\[()]|\\([^()]*\\))+)\\]$");
  private static final Pattern MUTATING_CALL_EXPRESSION = Pattern.compile(
      "^([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)\\)$");
  private static final Pattern MAP_GET_CALL = Pattern.compile("(?<!\\.)\\b([A-Za-z_][A-Za-z0-9_]*)\\.get\\(" + CALL_ARGS_WITH_NESTED_PARENS + "\\)");
  private static final Pattern MAP_GET_OR_DEFAULT_CALL = Pattern.compile("(?<!\\.)\\b([A-Za-z_][A-Za-z0-9_]*)\\.getOrDefault\\(" + CALL_ARGS_WITH_NESTED_PARENS + "\\)");
  private static final Pattern MAP_CONTAINS_KEY_CALL = Pattern.compile("(?<!\\.)\\b([A-Za-z_][A-Za-z0-9_]*)\\.containsKey\\(" + CALL_ARGS_WITH_NESTED_PARENS + "\\)");
  private static final Pattern QUEUE_PEEK_CALL = Pattern.compile("(?<!\\.)\\b([A-Za-z_][A-Za-z0-9_]*)\\.peek\\(\\)");
  private static final Pattern QUEUE_REMOVE_CALL = Pattern.compile("(?<!\\.)\\b([A-Za-z_][A-Za-z0-9_]*)\\.(remove|poll)\\(\\)");
  private static final Pattern STACK_DEQUE_POP_CALL = Pattern.compile("(?<!\\.)\\b([A-Za-z_][A-Za-z0-9_]*)\\.pop\\(\\)");
  private static final Pattern COLLECTION_CONTAINS_CALL = Pattern.compile("(?<!\\.)\\b([A-Za-z_][A-Za-z0-9_]*)\\.contains\\(([^()\\n;]+)\\)");
  private static final Pattern THIS_FIELD_MAP_GET_CALL = Pattern.compile("\\bthis\\.([A-Za-z_][A-Za-z0-9_]*)\\.get\\(" + CALL_ARGS_WITH_NESTED_PARENS + "\\)");
  private static final Pattern THIS_FIELD_MAP_GET_OR_DEFAULT_CALL = Pattern.compile("\\bthis\\.([A-Za-z_][A-Za-z0-9_]*)\\.getOrDefault\\(" + CALL_ARGS_WITH_NESTED_PARENS + "\\)");
  private static final Pattern THIS_FIELD_MAP_CONTAINS_KEY_CALL = Pattern.compile("\\bthis\\.([A-Za-z_][A-Za-z0-9_]*)\\.containsKey\\(" + CALL_ARGS_WITH_NESTED_PARENS + "\\)");
  private static final Pattern OBJECT_FIELD_MAP_GET_CALL = Pattern.compile("(?<!\\.)\\b(?!this\\b)([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\.get\\(" + CALL_ARGS_WITH_NESTED_PARENS + "\\)");
  private static final Pattern OBJECT_FIELD_MAP_GET_OR_DEFAULT_CALL = Pattern.compile("(?<!\\.)\\b(?!this\\b)([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\.getOrDefault\\(" + CALL_ARGS_WITH_NESTED_PARENS + "\\)");
  private static final Pattern OBJECT_FIELD_MAP_CONTAINS_KEY_CALL = Pattern.compile("(?<!\\.)\\b(?!this\\b)([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\.containsKey\\(" + CALL_ARGS_WITH_NESTED_PARENS + "\\)");
  private static final Pattern MATRIX_READ = Pattern.compile("(?<!\\.)\\b([A-Za-z_][A-Za-z0-9_]*)\\s*\\[((?:[^\\]\\[()]|\\([^()]*\\))+)\\]\\s*\\[((?:[^\\]\\[()]|\\([^()]*\\))+)\\]");
  private static final Pattern ARRAY_READ = Pattern.compile("(?<!\\.)\\b([A-Za-z_][A-Za-z0-9_]*)\\s*\\[((?:[^\\]\\[()]|\\([^()]*\\))+)\\]");

  private JavaRewriteLibrary() {}

  public static void main(String[] args) throws Exception {
    if (args.length < 7) {
      throw new IllegalArgumentException(
          "Usage: <source> <output> <executionStyle> <entryName> <exportsSource> <exportsClassName> <packageName>");
    }
    String source = Files.readString(Path.of(args[0]), StandardCharsets.UTF_8);
    String exportsSource = Files.readString(Path.of(args[4]), StandardCharsets.UTF_8);
    String rewritten = rewriteSource(source, args[2], args[3], exportsSource, args[5], args[6]);
    Files.createDirectories(Path.of(args[1]).getParent());
    Files.writeString(Path.of(args[1]), rewritten, StandardCharsets.UTF_8);
  }

  public static String rewriteSource(
      String source,
      String executionStyle,
      String entryName,
      String exportsSource,
      String exportsClassName,
      String packageName
  ) {
    String rewrittenSource = rewriteJava(normalizeTopLevelPublicClasses(source));
    String renamedExports = exportsSource.replaceAll("\\bpublic class Exports\\b", "public class " + exportsClassName);
    return "package " + packageName + ";\n\n" + rewrittenSource.trim() + "\n\n" + renamedExports.trim() + "\n";
  }

  private static String normalizeTopLevelPublicClasses(String source) {
    return source.replaceAll("(?m)^([ \\t]*)public\\s+class\\s+", "$1class ");
  }

  private static String extractReturnType(String methodLine, String methodName) {
    int nameIndex = methodLine.indexOf(methodName);
    if (nameIndex <= 0) return "var";
    String beforeName = methodLine.substring(0, nameIndex).trim();
    if (beforeName.isEmpty()) return "var";
    String[] parts = beforeName.split("\\s+");
    return parts.length == 0 ? "var" : parts[parts.length - 1];
  }

  private static String rewriteJava(String source) {
    StringBuilder out = new StringBuilder();
    out.append("import tracecode.user.TraceHooks;\n");
    String[] lines = source.split("\\r?\\n", -1);
    Deque<MethodFrame> methods = new ArrayDeque<>();
    Map<String, String> fields = new HashMap<>();
    PendingMethodHeader pendingMethodHeader = null;

    for (int index = 0; index < lines.length; index++) {
      String line = lines[index];
      int sourceLine = index + 1;
      if (pendingMethodHeader != null) {
        out.append(line).append('\n');
        pendingMethodHeader.appendLine(line);
        if (line.contains("{")) {
          MethodSignature signature = parseMethodSignature(pendingMethodHeader.source());
          if (signature != null) {
            methods.push(new MethodFrame(
                signature.name,
                signature.returnType,
                braceDelta(line),
                fields,
                signature.parametersSource));
            out.append(signature.indent).append("  TraceHooks.emitCallAtLine(")
                .append(pendingMethodHeader.startLine).append(", ").append(quote(signature.name)).append(", \"\");\n");
          }
          pendingMethodHeader = null;
        }
        continue;
      }

      Matcher method = METHOD_START.matcher(line);
      if (method.matches()) {
        out.append(line).append('\n');
        String name = method.group(2);
        methods.push(new MethodFrame(name, extractReturnType(line, name), braceDelta(line), fields, method.group(3)));
        out.append(method.group(1)).append("  TraceHooks.emitCallAtLine(")
            .append(sourceLine).append(", ").append(quote(name)).append(", \"\");\n");
        continue;
      }

      MethodFrame current = methods.peek();
      if (current == null) {
        if (startsMultilineMethodHeader(line)) {
          pendingMethodHeader = new PendingMethodHeader(line, sourceLine);
          out.append(line).append('\n');
          continue;
        }
        registerFieldDeclaration(fields, line);
        out.append(line).append('\n');
        continue;
      }

      String trimmed = line.trim();
      if (trimmed.startsWith("@")) {
        out.append(line).append('\n');
        current.depth += braceDelta(line);
        current.pendingAnnotation = true;
        continue;
      }

      if (current.initializerDepth > 0 || startsMultilineInitializer(trimmed)) {
        if (current.initializerDepth <= 0) {
          current.pendingMultilineMutation = multilineMutationStart(line, sourceLine, current);
        }
        if (
            current.initializerDepth <= 0 &&
            !current.pendingAnnotation &&
            shouldEmitLine(trimmed)
        ) {
          out.append(indentOf(line)).append("TraceHooks.emitLineAtLine(").append(sourceLine).append(");\n");
        }
        registerMultilineLocalDeclaration(current, trimmed);
        out.append(line).append('\n');
        if (current.pendingMultilineMutation != null) {
          current.pendingMultilineMutation.appendLine(line);
        }
        current.initializerDepth = Math.max(0, current.initializerDepth + braceDelta(line));
        if (current.initializerDepth == 0 && current.pendingMultilineMutation != null) {
          out.append(current.pendingMultilineMutation.emitHook(current)).append('\n');
          current.pendingMultilineMutation = null;
        }
        current.depth += braceDelta(line);
        while (!methods.isEmpty() && methods.peek().depth <= 0) {
          methods.pop();
        }
        continue;
      }

      if (current.headerParenDepth > 0) {
        String rewrittenLine = rewriteStatement(line, sourceLine, current);
        out.append(rewrittenLine).append('\n');
        current.headerParenDepth = Math.max(0, current.headerParenDepth + parenDelta(line));
        current.depth += braceDelta(rewrittenLine);
        while (!methods.isEmpty() && methods.peek().depth <= 0) {
          methods.pop();
        }
        continue;
      }

      boolean continuingExpression = current.expressionParenDepth > 0 || current.statementContinuation;
      boolean postLineStateStatement = emitsPostLineState(trimmed, current);
      boolean suppressLineHook = current.suppressNextLineHook || continuingExpression || postLineStateStatement ||
          isEnhancedForHeader(trimmed) || isControlHeaderContinuation(trimmed);
      current.suppressNextLineHook = false;
      if (!current.pendingAnnotation && !suppressLineHook && shouldEmitLine(trimmed)) {
        out.append(indentOf(line)).append("TraceHooks.emitLineAtLine(").append(sourceLine).append(");\n");
      }

      String rewrittenLine = rewriteStatement(line, sourceLine, current);
      if ("void".equals(current.returnType) && current.depth + braceDelta(line) <= 0) {
        out.append(indentOf(line)).append("TraceHooks.emitReturnAtLine(")
            .append(sourceLine).append(", ").append(quote(current.name)).append(");\n");
      }
      out.append(rewrittenLine).append('\n');
      current.pendingAnnotation = false;
      if (startsMultilineControlHeader(trimmed)) {
        current.headerParenDepth = Math.max(0, parenDelta(line));
      }
      if (startsUnbracedControlHeader(trimmed)) {
        current.suppressNextLineHook = true;
      }
      if (endsWithExpressionContinuation(trimmed)) {
        current.suppressNextLineHook = true;
      }
      updateExpressionContinuation(current, trimmed);

      current.depth += braceDelta(rewrittenLine);
      while (!methods.isEmpty() && methods.peek().depth <= 0) {
        methods.pop();
        if (!methods.isEmpty()) {
          methods.peek().depth += current.depth;
        }
      }
    }
    return out.toString();
  }

  private static String rewriteStatement(String line, int sourceLine, MethodFrame frame) {
    String inlineControl = rewriteInlineControlStatement(line, sourceLine, frame);
    if (inlineControl != null) {
      return inlineControl;
    }

    Matcher returnMatch = RETURN_STMT.matcher(line);
    if (returnMatch.matches()) {
      String indent = returnMatch.group(1);
      String expression = returnMatch.group(2);
      StringBuilder out = new StringBuilder();
      if (expression == null || expression.trim().isEmpty()) {
        out.append(indent).append("TraceHooks.emitReturnAtLine(").append(sourceLine).append(", ").append(quote(frame.name)).append(");\n");
        out.append(indent).append("return;");
      } else {
        String rewrittenExpression = rewriteReads(expression.trim(), sourceLine, frame);
        String tempName = "__tracecodeReturnValue" + sourceLine;
        out.append(indent).append(frame.returnTypeOrVar()).append(" ").append(tempName).append(" = ").append(rewrittenExpression).append(";\n");
        out.append(indent).append("TraceHooks.emitSerializedReturnAtLine(").append(sourceLine).append(", ").append(quote(frame.name)).append(", TraceHooks.serializeResult(").append(tempName).append("));\n");
        out.append(indent).append("return ").append(tempName).append(';');
      }
      return out.toString();
    }

    Matcher declaration = LOCAL_DECLARATION.matcher(line);
    if (declaration.matches() && !line.trim().startsWith("for ") && !isControlKeyword(declaration.group(2).trim())) {
      String indent = declaration.group(1);
      String type = declaration.group(2).trim();
      String name = declaration.group(3);
      String rawInitializer = declaration.group(4).trim();
      if (rawInitializer.contains("->") && rawInitializer.contains("{")) {
        registerLocalDeclarators(frame, type, name + " = " + rawInitializer);
        return line;
      }
      java.util.List<String> declaredNames = registerLocalDeclarators(frame, type, name + " = " + rawInitializer);
      String value = rewriteReads(rawInitializer, sourceLine, frame);
      String prefix = line.substring(0, declaration.start(3));
      String rewritten = frame.pendingAnnotation
          ? prefix + name + " = " + value + ";\n" + indent + "TraceHooks.emitLineAtLine(" + sourceLine + ");"
          : indent + "TraceHooks.emitLineAtLine(" + sourceLine + ");\n" + prefix + name + " = " + value + ";";
      Matcher mutatingExpression = MUTATING_CALL_EXPRESSION.matcher(rawInitializer);
      if (mutatingExpression.matches() && isTrackedMutationMethod(mutatingExpression.group(2))) {
        String receiver = mutatingExpression.group(1);
        if (!value.contains("TraceHooks.") || !value.contains(receiver)) {
          rewritten += " TraceHooks.emitMutatingCallAtLine(" + sourceLine + ", " +
              quote(receiver) + ", " + quote(mutatingExpression.group(2)) + ");";
          rewritten += " TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " +
              quote(receiver) + ", " + receiver + ");";
        }
      }
      for (String declaredName : declaredNames) {
        rewritten += "\n" + indent + "TraceHooks.emitScalarWriteAtLine(" + sourceLine + ", " + quote(declaredName) + ", " + declaredName + ");";
        rewritten += "\n" + indent + "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(declaredName) + ", " + declaredName + ");";
      }
      return rewritten;
    }

    Matcher forDeclaration = Pattern.compile("^(\\s*)for\\s*\\(\\s*(?:final\\s+)?([A-Za-z_][A-Za-z0-9_<>.?\\[\\] ]*)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=([^;]+);(.*)\\)\\s*\\{\\s*$").matcher(line);
    if (forDeclaration.matches()) {
      String indent = forDeclaration.group(1);
      String type = forDeclaration.group(2).trim();
      String name = forDeclaration.group(3);
      registerLocalDeclarators(frame, type, name + " = " + forDeclaration.group(4).trim());
      String bodyIndent = indent + "  ";
      if (isEmptyForUpdateClause(forDeclaration.group(5))) {
        String guardName = "__tracecodeForInit" + sourceLine + "_" + name;
        return indent + "boolean " + guardName + " = true;\n" +
            line + "\n" +
            bodyIndent + "if (" + guardName + ") {\n" +
            bodyIndent + "  " + guardName + " = false;\n" +
            bodyIndent + "  TraceHooks.emitScalarWriteAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");\n" +
            bodyIndent + "  TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");\n" +
            bodyIndent + "}";
      }
      return line + "\n" +
          bodyIndent + "TraceHooks.emitScalarWriteAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");\n" +
          bodyIndent + "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");";
    }

    Matcher enhancedForStringCharsDeclaration = Pattern.compile("^(\\s*)for\\s*\\(\\s*(?:final\\s+)?([A-Za-z_][A-Za-z0-9_<>.?\\[\\] ]*)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*:\\s*([A-Za-z_][A-Za-z0-9_]*)\\.toCharArray\\(\\)\\s*\\)\\s*\\{\\s*$").matcher(line);
    if (enhancedForStringCharsDeclaration.matches()) {
      String indent = enhancedForStringCharsDeclaration.group(1);
      String type = enhancedForStringCharsDeclaration.group(2).trim();
      String name = enhancedForStringCharsDeclaration.group(3);
      String sourceName = enhancedForStringCharsDeclaration.group(4);
      registerLocalDeclarators(frame, type, name);
      if (frame.variables.containsKey(sourceName) || frame.isField(sourceName)) {
        return indent + "for (" + type + " " + name + " : TraceHooks.iterationBindAtLine(" +
            sourceLine + ", " + quote(sourceName) + ", " + sourceName + ".toCharArray(), " + quote(name) + ")) {";
      }
      return line;
    }

    Matcher enhancedForDeclaration = Pattern.compile("^(\\s*)for\\s*\\(\\s*(?:final\\s+)?([A-Za-z_][A-Za-z0-9_<>.?\\[\\] ]*)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*:\\s*((?:[^()]|\\([^()]*\\))+)\\)\\s*\\{\\s*$").matcher(line);
    if (enhancedForDeclaration.matches()) {
      String indent = enhancedForDeclaration.group(1);
      String type = enhancedForDeclaration.group(2).trim();
      String name = enhancedForDeclaration.group(3);
      String source = enhancedForDeclaration.group(4).trim();
      registerLocalDeclarators(frame, type, name);
      Matcher arraySource = ARRAY_READ.matcher(source);
      if (arraySource.matches()) {
        String sourceName = arraySource.group(1);
        String rawIndex = arraySource.group(2).trim();
        String helper = arrayReadHelper(frame.typeOf(sourceName));
        if (helper != null) {
          String index = rewriteReads(rawIndex, sourceLine, frame);
          return indent + "for (" + type + " " + name + " : TraceHooks.iterationBindAtLine(" +
              sourceLine + ", " + quote(sourceName) + ", " + index + ", TraceHooks." + helper + "(" +
              sourceLine + ", " + quote(sourceName) + ", " + sourceName + ", " + index + ", " +
              indexSourceArgument(rawIndex) + "), " + quote(name) + ", " + indexSourceArgument(rawIndex) + ")) {";
        }
      }
      Matcher indexedListSource = Pattern.compile("^([A-Za-z_][A-Za-z0-9_]*)\\.get\\(((?:[^()]|\\([^()]*\\))+?)\\)$").matcher(source);
      if (indexedListSource.matches()) {
        String sourceName = indexedListSource.group(1);
        String rawIndex = indexedListSource.group(2).trim();
        if (isListType(frame.typeOf(sourceName))) {
          String index = rewriteReads(rawIndex, sourceLine, frame);
          String indexSource = indexSourceArgument(rawIndex);
          return indent + "for (" + type + " " + name + " : TraceHooks.iterationBindAtLine(" +
              sourceLine + ", " + quote(sourceName) + ", " + index + ", TraceHooks.readListAtLine(" +
              sourceLine + ", " + quote(sourceName) + ", " + sourceName + ", " + index + ", " +
              indexSource + "), " + quote(name) + ", " + indexSource + ")) {";
        }
      }
      if (
          isSimpleIdentifierExpression(source) &&
          (frame.variables.containsKey(source) || frame.isField(source))
      ) {
        return indent + "for (" + type + " " + name + " : TraceHooks.iterationBindAtLine(" +
            sourceLine + ", " + quote(source) + ", " + source + ", " + quote(name) + ")) {";
      }
      return line;
    }

    Matcher assignment = LOCAL_ASSIGNMENT.matcher(line);
    if (assignment.matches() && frame.variables.containsKey(assignment.group(2))) {
      String indent = assignment.group(1);
      String name = assignment.group(2);
      String rawValue = assignment.group(3).trim();
      String value = rewriteReads(rawValue, sourceLine, frame);
      String rewritten = indent + "TraceHooks.emitLineAtLine(" + sourceLine + ");\n" +
          indent + name + " = " + value + ";\n" +
          indent + "TraceHooks.emitScalarWriteAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");\n" +
          indent + "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");";
      Matcher mutatingExpression = MUTATING_CALL_EXPRESSION.matcher(rawValue);
      if (mutatingExpression.matches() && isTrackedMutationMethod(mutatingExpression.group(2))) {
        String receiver = mutatingExpression.group(1);
        if (!value.contains("TraceHooks.") || !value.contains(receiver)) {
          rewritten += "\n" + indent + "TraceHooks.emitMutatingCallAtLine(" + sourceLine + ", " +
              quote(receiver) + ", " + quote(mutatingExpression.group(2)) + ");";
          rewritten += " TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " +
              quote(receiver) + ", " + receiver + ");";
        }
      }
      return rewritten;
    }

    Matcher compoundAssignment = LOCAL_COMPOUND_ASSIGNMENT.matcher(line);
    if (compoundAssignment.matches() && frame.variables.containsKey(compoundAssignment.group(2))) {
      String indent = compoundAssignment.group(1);
      String name = compoundAssignment.group(2);
      String operator = compoundAssignment.group(3);
      String value = rewriteReads(compoundAssignment.group(4).trim(), sourceLine, frame);
      return indent + "TraceHooks.emitLineAtLine(" + sourceLine + ");\n" +
          indent + name + " " + operator + "= " + value + ";\n" +
          indent + "TraceHooks.emitScalarWriteAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");\n" +
          indent + "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");";
    }

    Matcher localUpdate = LOCAL_UPDATE.matcher(line);
    if (localUpdate.matches() && (localUpdate.group(2) != null || localUpdate.group(4) != null) && frame.variables.containsKey(localUpdate.group(3))) {
      String indent = localUpdate.group(1);
      String prefix = localUpdate.group(2);
      String name = localUpdate.group(3);
      String suffix = localUpdate.group(4);
      String operator = prefix != null ? prefix : suffix;
      return indent + "TraceHooks.emitLineAtLine(" + sourceLine + ");\n" +
          indent + name + ("++".equals(operator) ? " += 1;" : " -= 1;") + "\n" +
          indent + "TraceHooks.emitScalarWriteAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");\n" +
          indent + "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");";
    }

    Matcher fieldPathWrite = FIELD_PATH_WRITE.matcher(line);
    if (fieldPathWrite.matches()) {
      String indent = fieldPathWrite.group(1);
      String left = fieldPathWrite.group(2).replaceAll("\\s+", "");
      String value = rewriteReads(fieldPathWrite.group(3).trim(), sourceLine, frame);
      java.util.List<String> parts = java.util.Arrays.asList(left.split("\\."));
      String variable = parts.get(0);
      int pathStart = 1;
      if ("this".equals(variable)) {
        pathStart = 1;
      }
      java.util.List<String> receiverPath = parts.subList(pathStart, parts.size() - 1);
      java.util.List<String> writePath = parts.subList(pathStart, parts.size());
      String receiverExpression = String.join(".", parts.subList(0, parts.size() - 1));
      String finalField = parts.get(parts.size() - 1);
      String receiverRead = "TraceHooks.readFieldPathAtLine(" + sourceLine + ", " + quote(variable) + ", " +
          stringArrayLiteral(receiverPath) + ", " + receiverExpression + ")";
      String snapshotExpression = "this".equals(variable) ? "this" : variable;
      return indent + receiverRead + "." + finalField + " = " + value + "; " +
          "TraceHooks.emitFieldPathWriteAtLine(" + sourceLine + ", " + quote(variable) + ", " +
          stringArrayLiteral(writePath) + ", " + left + "); " +
          "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(variable) + ", " + snapshotExpression + ");";
    }

    Matcher fieldWrite = FIELD_WRITE.matcher(line);
    if (fieldWrite.matches()) {
      String indent = fieldWrite.group(1);
      String name = fieldWrite.group(2);
      String field = fieldWrite.group(3);
      String value = rewriteReads(fieldWrite.group(4).trim(), sourceLine, frame);
      return indent + name + "." + field + " = " + value + "; TraceHooks.emitFieldWriteAtLine(" + sourceLine + ", " + quote(name) + ", " + quote(field) + ", " + name + "." + field + "); TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(field) + ", " + name + "." + field + ");";
    }

    Matcher fieldIndexedMutatingCall = FIELD_INDEXED_MUTATING_CALL_STATEMENT.matcher(line);
    if (fieldIndexedMutatingCall.matches() && isTrackedMutationMethod(fieldIndexedMutatingCall.group(5))) {
      String indent = fieldIndexedMutatingCall.group(1);
      String name = fieldIndexedMutatingCall.group(2);
      String field = fieldIndexedMutatingCall.group(3);
      String index = rewriteReads(fieldIndexedMutatingCall.group(4).trim(), sourceLine, frame);
      String method = fieldIndexedMutatingCall.group(5);
      MutatingArgs rewrittenArgs = mutatingArgs(fieldIndexedMutatingCall.group(6).trim(), sourceLine, frame);
      String target = name + "." + field + ".get(" + index + ")";
      String pathPrefix = "\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[\\\"" + field + "\\\",";
      String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + (" + index + ") + \"]},\\\"value\\\":\" + TraceHooks.serializeResult(" + target + ") + \"}\");";
      String mutateEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"mutate\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + (" + index + ") + \"]},\\\"method\\\":\\\"" + method + "\\\"" + rewrittenArgs.eventSegment + "}\");";
      java.util.List<String> rawArgs = splitTopLevel(fieldIndexedMutatingCall.group(6).trim());
      String writeEvent = "";
      if ("add".equals(method) && rawArgs.size() == 1) {
        String value = rewriteReads(rawArgs.get(0), sourceLine, frame);
        writeEvent = " if (" + target + " instanceof java.util.List) TraceHooks.emitIndexedWriteAtLine(" + sourceLine + ", " + quote(name) +
            ", new Object[] { " + quote(field) + ", " + index + ", ((java.util.List) " + target + ").size() - 1 }, " +
            value + ", null, " + indexSourceArgument(index) + ", null);";
      }
      String snapshotEvent = "this".equals(name) && frame.isField(field)
          ? "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(field) + ", " + field + ");"
          : "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");";
      return indent + "{ " + readEvent + " " + rewrittenArgs.prefix + target + "." + method + "(" + rewrittenArgs.callArgs + "); " + mutateEvent + writeEvent + " " + snapshotEvent + " }";
    }

    Matcher frontFieldMutatingCall = FRONT_FIELD_MUTATING_CALL_STATEMENT.matcher(line);
    if (frontFieldMutatingCall.matches() && isTrackedMutationMethod(frontFieldMutatingCall.group(4))) {
      String indent = frontFieldMutatingCall.group(1);
      String name = frontFieldMutatingCall.group(2);
      String field = frontFieldMutatingCall.group(3);
      String method = frontFieldMutatingCall.group(4);
      MutatingArgs rewrittenArgs = mutatingArgs(frontFieldMutatingCall.group(5).trim(), sourceLine, frame);
      String target = name + ".peek()." + field;
      String pathPrefix = "\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[0,\\\"" + field + "\\\"]}";
      String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + ",\\\"value\\\":\" + TraceHooks.serializeResult(" + target + ") + \"}\");";
      String mutateEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"mutate\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + ",\\\"method\\\":\\\"" + method + "\\\"" + rewrittenArgs.eventSegment + "}\");";
      java.util.List<String> rawArgs = splitTopLevel(frontFieldMutatingCall.group(5).trim());
      String writeEvent = "";
      if (rawArgs.size() == 1 && !rewrittenArgs.callArgs.trim().isEmpty()) {
        if ("add".equals(method) || "push".equals(method) || "offer".equals(method) ||
            "addLast".equals(method) || "offerLast".equals(method)) {
          writeEvent = " TraceHooks.emitIndexedWriteAtLine(" + sourceLine + ", " + quote(name) +
              ", new Object[] { 0, " + quote(field) + ", ((java.util.Collection) " + target + ").size() - 1 }, " +
              rewrittenArgs.callArgs + ", null, null, null);";
        } else if ("addFirst".equals(method) || "offerFirst".equals(method)) {
          writeEvent = " TraceHooks.emitIndexedWriteAtLine(" + sourceLine + ", " + quote(name) +
              ", new Object[] { 0, " + quote(field) + ", 0 }, " + rewrittenArgs.callArgs + ", null, null, null);";
        }
      }
      String snapshotEvent = "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");";
      return indent + "{ " + readEvent + " " + rewrittenArgs.prefix + target + "." + method + "(" + rewrittenArgs.callArgs + "); " + mutateEvent + writeEvent + " " + snapshotEvent + " }";
    }

    Matcher fieldMutatingCall = FIELD_MUTATING_CALL_STATEMENT.matcher(line);
    if (fieldMutatingCall.matches() && isTrackedMutationMethod(fieldMutatingCall.group(4))) {
      String indent = fieldMutatingCall.group(1);
      String name = fieldMutatingCall.group(2);
      String field = fieldMutatingCall.group(3);
      String method = fieldMutatingCall.group(4);
      String rawArgs = fieldMutatingCall.group(5).trim();
      String target = name + "." + field;
      if ("this".equals(name) && "put".equals(method) && isMapType(frame.typeOf(field))) {
        java.util.List<String> parts = splitTopLevel(rawArgs);
        if (parts.size() >= 2) {
          String key = rewriteReads(parts.get(0), sourceLine, frame);
          String value = rewriteReads(parts.get(1), sourceLine, frame);
          return indent + "TraceHooks.putFieldMapAtLine(" + sourceLine + ", \"this\", " + quote(field) + ", " + target + ", " + key + ", " + value + ", " + indexSourceArgument(parts.get(0)) + ");";
        }
      }
      if (!"this".equals(name) && ("put".equals(method) || "putIfAbsent".equals(method)) && isMapType(frame.typeOf(field))) {
        java.util.List<String> parts = splitTopLevel(rawArgs);
        if (parts.size() >= 2) {
          String key = rewriteReads(parts.get(0), sourceLine, frame);
          String value = rewriteReads(parts.get(1), sourceLine, frame);
          String hook = "putIfAbsent".equals(method) ? "putFieldMapIfAbsentAtLine" : "putFieldMapAtLine";
          return indent + "TraceHooks." + hook + "(" + sourceLine + ", " + quote(name) + ", " + quote(field) + ", " + target + ", " + key + ", " + value + ", " + indexSourceArgument(parts.get(0)) + ");";
        }
      }
      String pathPrefix = "\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[\\\"" + field + "\\\"]}";
      MutatingArgs rewrittenArgs = mutatingArgs(rawArgs, sourceLine, frame);
      String mutateEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"mutate\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + ",\\\"method\\\":\\\"" + method + "\\\"" + rewrittenArgs.eventSegment + "}\");";
      String writeEvent = "";
      if (("add".equals(method) || "push".equals(method) || "addLast".equals(method) || "offerLast".equals(method)) && splitTopLevel(rawArgs).size() == 1) {
        writeEvent = " TraceHooks.emitIndexedWriteAtLine(" + sourceLine + ", " + quote(name) +
            ", new Object[] { " + quote(field) + ", ((java.util.Collection) " + target + ").size() - 1 }, " +
            rewrittenArgs.callArgs + ", null, null);";
      } else if (("addFirst".equals(method) || "offerFirst".equals(method)) && splitTopLevel(rawArgs).size() == 1) {
        writeEvent = " TraceHooks.emitIndexedWriteAtLine(" + sourceLine + ", " + quote(name) +
            ", new Object[] { " + quote(field) + ", 0 }, " + rewrittenArgs.callArgs + ", null, null);";
      }
      String snapshotEvent = "this".equals(name) && frame.isField(field)
          ? "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(field) + ", " + field + ");"
          : "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");";
      return indent + "{ " + rewrittenArgs.prefix + target + "." + method + "(" + rewrittenArgs.callArgs + "); " + mutateEvent + writeEvent + " " + snapshotEvent + " }";
    }

    Matcher computeMutatingCall = COMPUTE_IF_ABSENT_MUTATING_CALL_STATEMENT.matcher(line);
    if (computeMutatingCall.matches() && isTrackedMutationMethod(computeMutatingCall.group(5))) {
      String indent = computeMutatingCall.group(1);
      String name = computeMutatingCall.group(2);
      String rawKey = computeMutatingCall.group(3).trim();
      String key = rewriteReads(rawKey, sourceLine, frame);
      String fallback = computeMutatingCall.group(4).trim();
      String method = computeMutatingCall.group(5);
      MutatingArgs rewrittenArgs = mutatingArgs(computeMutatingCall.group(6).trim(), sourceLine, frame);
      String target = name + ".computeIfAbsent(" + key + ", " + fallback + ")";
      String temp = "__tracecodeComputedTarget" + sourceLine;
      String pathPrefix = "\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[";
      String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + TraceHooks.serializeResult(" + key + ") + \"]" + escapedIndexSourcesTargetSegment(rawKey) + "},\\\"value\\\":\" + TraceHooks.serializeResult(" + temp + ") + \"}\");";
      String mutateEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"mutate\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + TraceHooks.serializeResult(" + key + ") + \"]" + escapedIndexSourcesTargetSegment(rawKey) + "},\\\"method\\\":\\\"" + method + "\\\"" + rewrittenArgs.eventSegment + "}\");";
      String snapshotEvent = "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");";
      return indent + "{ var " + temp + " = " + target + "; " + readEvent + " " + rewrittenArgs.prefix + temp + "." + method + "(" + rewrittenArgs.callArgs + "); " + mutateEvent + " " + snapshotEvent + " }";
    }

    Matcher indexedFieldMutatingCall = INDEXED_FIELD_MUTATING_CALL_STATEMENT.matcher(line);
    if (indexedFieldMutatingCall.matches() && isTrackedMutationMethod(indexedFieldMutatingCall.group(5))) {
      String indent = indexedFieldMutatingCall.group(1);
      String name = indexedFieldMutatingCall.group(2);
      String rawIndex = indexedFieldMutatingCall.group(3).trim();
      String index = rewriteReads(rawIndex, sourceLine, frame);
      String field = indexedFieldMutatingCall.group(4);
      String method = indexedFieldMutatingCall.group(5);
      MutatingArgs rewrittenArgs = mutatingArgs(indexedFieldMutatingCall.group(6).trim(), sourceLine, frame);
      String temp = "__tracecodeIndexedFieldTarget" + sourceLine;
      String target = name + ".get(" + index + ")." + field;
      String pathPrefix = "\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[";
      String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + TraceHooks.serializeResult(" + index + ") + \",\\\"" + field + "\\\"]" + escapedIndexSourcesTargetSegment(rawIndex, null) + "},\\\"value\\\":\" + TraceHooks.serializeResult(" + temp + ") + \"}\");";
      String mutateEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"mutate\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + TraceHooks.serializeResult(" + index + ") + \",\\\"" + field + "\\\"]" + escapedIndexSourcesTargetSegment(rawIndex, null) + "},\\\"method\\\":\\\"" + method + "\\\"" + rewrittenArgs.eventSegment + "}\");";
      String snapshotEvent = "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");";
      return indent + "{ var " + temp + " = " + target + "; " + readEvent + " " + rewrittenArgs.prefix + temp + "." + method + "(" + rewrittenArgs.callArgs + "); " + mutateEvent + " " + snapshotEvent + " }";
    }

    Matcher indexedMutatingCall = INDEXED_MUTATING_CALL_STATEMENT.matcher(line);
    if (indexedMutatingCall.matches() && isTrackedMutationMethod(indexedMutatingCall.group(4))) {
      String indent = indexedMutatingCall.group(1);
      String name = indexedMutatingCall.group(2);
      String rawIndex = indexedMutatingCall.group(3).trim();
      String index = rewriteReads(rawIndex, sourceLine, frame);
      String method = indexedMutatingCall.group(4);
      MutatingArgs rewrittenArgs = mutatingArgs(indexedMutatingCall.group(5).trim(), sourceLine, frame);
      String temp = "__tracecodeIndexedTarget" + sourceLine;
      String target = indexedAccessExpression(name, frame.typeOf(name), index);
      String pathPrefix = "\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[";
      String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + TraceHooks.serializeResult(" + index + ") + \"]" + escapedIndexSourcesTargetSegment(rawIndex) + "},\\\"value\\\":\" + TraceHooks.serializeResult(" + temp + ") + \"}\");";
      String mutateEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"mutate\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + TraceHooks.serializeResult(" + index + ") + \"]" + escapedIndexSourcesTargetSegment(rawIndex) + "},\\\"method\\\":\\\"" + method + "\\\"" + rewrittenArgs.eventSegment + "}\");";
      java.util.List<String> rawArgs = splitTopLevel(indexedMutatingCall.group(5).trim());
      String writeEvent = "";
      if ("add".equals(method) && rawArgs.size() == 1) {
        String value = rewriteReads(rawArgs.get(0), sourceLine, frame);
        writeEvent = " if (" + temp + " instanceof java.util.List) TraceHooks.emitIndexedWriteAtLine(" + sourceLine + ", " + quote(name) +
            ", new Object[] { " + index + ", ((java.util.List) " + temp + ").size() - 1 }, " +
            value + ", " + indexSourceArgument(rawIndex) + ", null);";
      }
      String snapshotEvent = "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");";
      return indent + "{ var " + temp + " = " + target + "; " + readEvent + " " + rewrittenArgs.prefix + temp + "." + method + "(" + rewrittenArgs.callArgs + "); " + mutateEvent + writeEvent + " " + snapshotEvent + " }";
    }

    Matcher arrayIndexedMapWrite = ARRAY_INDEXED_MAP_WRITE_STATEMENT.matcher(line);
    if (arrayIndexedMapWrite.matches() && isArrayOfMapType(frame.typeOf(arrayIndexedMapWrite.group(2)))) {
      String indent = arrayIndexedMapWrite.group(1);
      String name = arrayIndexedMapWrite.group(2);
      String rawIndex = arrayIndexedMapWrite.group(3).trim();
      String index = rewriteReads(rawIndex, sourceLine, frame);
      String method = arrayIndexedMapWrite.group(4);
      java.util.List<String> args = splitTopLevel(arrayIndexedMapWrite.group(5).trim());
      if (args.size() < 2) {
        return rewriteReads(line, sourceLine, frame);
      }
      String rawKey = args.get(0);
      String key = rewriteReads(rawKey, sourceLine, frame);
      java.util.List<String> rewrittenArgs = new java.util.ArrayList<>();
      rewrittenArgs.add(key);
      for (int i = 1; i < args.size(); i++) {
        rewrittenArgs.add(rewriteReads(args.get(i), sourceLine, frame));
      }
      String target = name + "[" + index + "]";
      String joinedArgs = String.join(", ", rewrittenArgs);
      String pathPrefix = "\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[";
      String writeEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"write\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + TraceHooks.serializeResult(" + index + ") + \",\" + TraceHooks.serializeResult(" + key + ") + \"]" + escapedIndexSourcesTargetSegment(rawIndex, rawKey) + "},\\\"value\\\":\" + TraceHooks.serializeResult(" + target + ".get(" + key + ")) + \"}\");";
      String snapshotEvent = "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");";
      return indent + target + "." + method + "(" + joinedArgs + "); " + writeEvent + " " + snapshotEvent;
    }

    Matcher listArrayWrite = LIST_ARRAY_WRITE.matcher(line);
    if (listArrayWrite.matches()) {
      String indent = listArrayWrite.group(1);
      String name = listArrayWrite.group(2);
      String rawRow = listArrayWrite.group(3).trim();
      String rawCol = listArrayWrite.group(4).trim();
      String row = rewriteReads(rawRow, sourceLine, frame);
      String col = rewriteReads(rawCol, sourceLine, frame);
      String value = rewriteReads(listArrayWrite.group(5).trim(), sourceLine, frame);
      String temp = "__tracecodeArrayListTarget" + sourceLine;
      String target = "((int[])((java.util.List)" + name + ").get(" + row + "))";
      String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + ",\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[\" + TraceHooks.serializeResult(" + row + ") + \",\" + TraceHooks.serializeResult(" + col + ") + \"]" + escapedIndexSourcesTargetSegment(rawRow, rawCol) + "},\\\"value\\\":\" + TraceHooks.serializeResult(" + temp + "[" + col + "]) + \"}\");";
      String writeEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"write\\\",\\\"line\\\":" + sourceLine + ",\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[\" + TraceHooks.serializeResult(" + row + ") + \",\" + TraceHooks.serializeResult(" + col + ") + \"]" + escapedIndexSourcesTargetSegment(rawRow, rawCol) + "},\\\"value\\\":\" + TraceHooks.serializeResult(" + value + ") + \"}\");";
      return indent + "{ int[] " + temp + " = " + target + "; " + readEvent + " " + temp + "[" + col + "] = " + value + "; " + writeEvent + " }";
    }

    Matcher arraysFill = ARRAYS_FILL_STATEMENT.matcher(line);
    if (arraysFill.matches()) {
      String indent = arraysFill.group(1);
      java.util.List<String> args = splitTopLevel(arraysFill.group(2).trim());
      if (args.size() == 2) {
        String target = args.get(0).trim();
        String value = rewriteReads(args.get(1).trim(), sourceLine, frame);
        if (isSimpleIdentifierExpression(target) && isArrayType(frame.typeOf(target))) {
          return indent + "TraceHooks.fillArrayAtLine(" + sourceLine + ", " + quote(target) + ", " + target + ", " + value + ");";
        }
        Matcher indexedTarget = INDEXED_ARRAY_TARGET.matcher(target);
        if (indexedTarget.matches() && isNestedArrayType(frame.typeOf(indexedTarget.group(1)))) {
          String name = indexedTarget.group(1);
          String rawIndex = indexedTarget.group(2).trim();
          String index = rewriteReads(rawIndex, sourceLine, frame);
          return indent + "TraceHooks.fillArrayAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ", " +
              index + ", " + indexSourceArgument(rawIndex) + ", " + value + ");";
        }
      }
    }

    Matcher arrayIndexedMutatingCall = ARRAY_INDEXED_MUTATING_CALL_STATEMENT.matcher(line);
    if (arrayIndexedMutatingCall.matches() && isTrackedMutationMethod(arrayIndexedMutatingCall.group(4))) {
      String indent = arrayIndexedMutatingCall.group(1);
      String name = arrayIndexedMutatingCall.group(2);
      String rawIndex = arrayIndexedMutatingCall.group(3).trim();
      String index = rewriteReads(rawIndex, sourceLine, frame);
      String method = arrayIndexedMutatingCall.group(4);
      MutatingArgs rewrittenArgs = mutatingArgs(arrayIndexedMutatingCall.group(5).trim(), sourceLine, frame);
      String target = name + "[" + index + "]";
      String pathPrefix = "\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[";
      String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + TraceHooks.serializeResult(" + index + ") + \"]" + escapedIndexSourcesTargetSegment(rawIndex) + "},\\\"value\\\":\" + TraceHooks.serializeResult(" + target + ") + \"}\");";
      String mutateEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"mutate\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + TraceHooks.serializeResult(" + index + ") + \"]" + escapedIndexSourcesTargetSegment(rawIndex) + "},\\\"method\\\":\\\"" + method + "\\\"" + rewrittenArgs.eventSegment + "}\");";
      String writeEvent = "";
      if (("add".equals(method) || "push".equals(method)) && splitTopLevel(arrayIndexedMutatingCall.group(5).trim()).size() == 1) {
        writeEvent = " TraceHooks.emitIndexedWriteAtLine(" + sourceLine + ", " + quote(name) +
            ", new Object[] { " + index + ", ((java.util.Collection) " + target + ").size() - 1 }, " +
            rewrittenArgs.callArgs + ", " + indexSourceArgument(rawIndex) + ", null);";
      }
      String snapshotEvent = "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");";
      return indent + "{ " + readEvent + " " + rewrittenArgs.prefix + target + "." + method + "(" + rewrittenArgs.callArgs + "); " + mutateEvent + writeEvent + " " + snapshotEvent + " }";
    }

    Matcher update2d = ARRAY_UPDATE_2D.matcher(line);
    if (update2d.matches() && (update2d.group(2) != null || update2d.group(6) != null)) {
      String indent = update2d.group(1);
      String operator = update2d.group(2) != null ? update2d.group(2) : update2d.group(6);
      String name = update2d.group(3);
      String row = update2d.group(4).trim();
      String col = update2d.group(5).trim();
      if (hasIndexSideEffect(row) || hasIndexSideEffect(col)) {
        return rewriteReads(line, sourceLine, frame);
      }
      String target = name + "[" + row + "][" + col + "]";
      String delta = "++".equals(operator) ? "1" : "-1";
      String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + ",\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[\" + TraceHooks.serializeResult(" + row + ") + \",\" + TraceHooks.serializeResult(" + col + ") + \"]" + escapedIndexSourcesTargetSegment(row, col) + "},\\\"value\\\":\" + TraceHooks.serializeResult(" + target + ") + \"}\");";
      return indent + readEvent + " " + target + " += " + delta + "; TraceHooks.emitArrayWriteAtLine(" + sourceLine + ", " + quote(name) + ", " + row + ", " + col + ", " + target + ", " + indexSourceArgument(row) + ", " + indexSourceArgument(col) + ");";
    }

    Matcher update1d = ARRAY_UPDATE_1D.matcher(line);
    if (update1d.matches() && (update1d.group(2) != null || update1d.group(5) != null)) {
      String indent = update1d.group(1);
      String operator = update1d.group(2) != null ? update1d.group(2) : update1d.group(5);
      String name = update1d.group(3);
      String idx = update1d.group(4).trim();
      if (hasIndexSideEffect(idx)) {
        return rewriteReads(line, sourceLine, frame);
      }
      String target = name + "[" + idx + "]";
      String delta = "++".equals(operator) ? "1" : "-1";
      String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + ",\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[\" + TraceHooks.serializeResult(" + idx + ") + \"]" + escapedIndexSourcesTargetSegment(idx) + "},\\\"value\\\":\" + TraceHooks.serializeResult(" + target + ") + \"}\");";
      return indent + readEvent + " " + target + " += " + delta + "; TraceHooks.emitArrayWriteAtLine(" + sourceLine + ", " + quote(name) + ", " + idx + ", (Object) " + target + ", " + indexSourceArgument(idx) + ");";
    }

    Matcher compoundWrite2d = ARRAY_COMPOUND_WRITE_2D.matcher(line);
    if (compoundWrite2d.matches()) {
      String indent = compoundWrite2d.group(1);
      String name = compoundWrite2d.group(2);
      String row = compoundWrite2d.group(3).trim();
      String col = compoundWrite2d.group(4).trim();
      if (hasIndexSideEffect(row) || hasIndexSideEffect(col)) {
        return rewriteReads(line, sourceLine, frame);
      }
      String operator = compoundWrite2d.group(5);
      String value = rewriteReads(compoundWrite2d.group(6).trim(), sourceLine, frame);
      String target = name + "[" + row + "][" + col + "]";
      String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + ",\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[\" + TraceHooks.serializeResult(" + row + ") + \",\" + TraceHooks.serializeResult(" + col + ") + \"]" + escapedIndexSourcesTargetSegment(row, col) + "},\\\"value\\\":\" + TraceHooks.serializeResult(" + target + ") + \"}\");";
      return indent + readEvent + " " + target + " " + operator + "= " + value + "; TraceHooks.emitArrayWriteAtLine(" + sourceLine + ", " + quote(name) + ", " + row + ", " + col + ", " + target + ", " + indexSourceArgument(row) + ", " + indexSourceArgument(col) + ");";
    }

    Matcher compoundWrite1d = ARRAY_COMPOUND_WRITE_1D.matcher(line);
    if (compoundWrite1d.matches()) {
      String indent = compoundWrite1d.group(1);
      String name = compoundWrite1d.group(2);
      String idx = compoundWrite1d.group(3).trim();
      if (hasIndexSideEffect(idx)) {
        return rewriteReads(line, sourceLine, frame);
      }
      String operator = compoundWrite1d.group(4);
      String value = rewriteReads(compoundWrite1d.group(5).trim(), sourceLine, frame);
      String target = name + "[" + idx + "]";
      String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + ",\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[\" + TraceHooks.serializeResult(" + idx + ") + \"]" + escapedIndexSourcesTargetSegment(idx) + "},\\\"value\\\":\" + TraceHooks.serializeResult(" + target + ") + \"}\");";
      return indent + readEvent + " " + target + " " + operator + "= " + value + "; TraceHooks.emitArrayWriteAtLine(" + sourceLine + ", " + quote(name) + ", " + idx + ", (Object) " + target + ", " + indexSourceArgument(idx) + ");";
    }

    Matcher write2d = ARRAY_WRITE_2D.matcher(line);
    if (write2d.matches()) {
      String indent = write2d.group(1);
      String name = write2d.group(2);
      String row = write2d.group(3).trim();
      String col = write2d.group(4).trim();
      String value = rewriteReads(write2d.group(5).trim(), sourceLine, frame);
      String rowTemp = "__tracecodeRow" + sourceLine;
      String colTemp = "__tracecodeCol" + sourceLine;
      return indent + "{ int " + rowTemp + " = " + row + "; int " + colTemp + " = " + col + "; " +
          name + "[" + rowTemp + "][" + colTemp + "] = " + value + "; TraceHooks.emitArrayWriteAtLine(" +
          sourceLine + ", " + quote(name) + ", " + rowTemp + ", " + colTemp + ", " +
          name + "[" + rowTemp + "][" + colTemp + "], " + indexSourceArgument(row) + ", " + indexSourceArgument(col) + "); }";
    }

    Matcher write1d = ARRAY_WRITE_1D.matcher(line);
    if (write1d.matches()) {
      String indent = write1d.group(1);
      String name = write1d.group(2);
      String idx = write1d.group(3).trim();
      String value = rewriteReads(write1d.group(4).trim(), sourceLine, frame);
      String indexTemp = "__tracecodeIndex" + sourceLine;
      return indent + "{ int " + indexTemp + " = " + idx + "; " + name + "[" + indexTemp + "] = " + value +
          "; TraceHooks.emitArrayWriteAtLine(" + sourceLine + ", " + quote(name) + ", " + indexTemp + ", " +
          "(Object) " + name + "[" + indexTemp + "], " + indexSourceArgument(idx) + "); }";
    }

    Matcher mutatingCall = MUTATING_CALL_STATEMENT.matcher(line);
    if (mutatingCall.matches() && isTrackedMutationMethod(mutatingCall.group(3))) {
      String indent = mutatingCall.group(1);
      String name = mutatingCall.group(2);
      String method = mutatingCall.group(3);
      String rawArgs = mutatingCall.group(4).trim();
      String args = rewriteReads(rawArgs, sourceLine, frame);
      if (("put".equals(method) || "putIfAbsent".equals(method)) && frame.isField(name) && isMapType(frame.typeOf(name))) {
        java.util.List<String> parts = splitTopLevel(rawArgs);
        if (parts.size() >= 2) {
          String key = rewriteReads(parts.get(0), sourceLine, frame);
          String value = rewriteReads(parts.get(1), sourceLine, frame);
          String keySource = indexSourceArgument(parts.get(0));
          String hook = "putIfAbsent".equals(method) ? "putMapIfAbsentAtLine" : "putMapAtLine";
          return indent + "TraceHooks." + hook + "(" + sourceLine + ", " + quote(name) + ", " + name + ", " + key + ", " + value + ", " + keySource + ");";
        }
      }
      if (("put".equals(method) || "putIfAbsent".equals(method)) && isMapType(frame.typeOf(name))) {
        java.util.List<String> parts = splitTopLevel(mutatingCall.group(4).trim());
        if (parts.size() >= 2) {
          String key = rewriteReads(parts.get(0), sourceLine, frame);
          String value = rewriteReads(parts.get(1), sourceLine, frame);
          String keySource = indexSourceArgument(parts.get(0));
          String hook = "putIfAbsent".equals(method) ? "putMapIfAbsentAtLine" : "putMapAtLine";
          return indent + "TraceHooks." + hook + "(" + sourceLine + ", " + quote(name) + ", " + name + ", " + key + ", " + value + ", " + keySource + ");";
        }
      }
      if ("remove".equals(method) && isMapType(frame.typeOf(name))) {
        java.util.List<String> parts = splitTopLevel(rawArgs);
        if (parts.size() == 1) {
          String key = rewriteReads(parts.get(0), sourceLine, frame);
          String keySource = indexSourceArgument(parts.get(0));
          if ("null".equals(keySource) && isLiteralIndexSource(parts.get(0))) keySource = quote(parts.get(0).trim());
          return indent + "TraceHooks.removeMapAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ", " + key + ", " + keySource + ");";
        }
      }
      if ("remove".equals(method) && isSetType(frame.typeOf(name))) {
        java.util.List<String> parts = splitTopLevel(rawArgs);
        if (parts.size() == 1) {
          String key = rewriteReads(parts.get(0), sourceLine, frame);
          String keySource = indexSourceArgument(parts.get(0));
          if ("null".equals(keySource) && isLiteralIndexSource(parts.get(0))) keySource = quote(parts.get(0).trim());
          return indent + "TraceHooks.removeSetAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ", " + key + ", " + keySource + ");";
        }
      }
      if ("set".equals(method) && isListType(frame.typeOf(name))) {
        java.util.List<String> parts = splitTopLevel(mutatingCall.group(4).trim());
        if (parts.size() >= 2) {
          String index = rewriteReads(parts.get(0), sourceLine, frame);
          String value = rewriteReads(parts.get(1), sourceLine, frame);
          return indent + "TraceHooks.writeListAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ", " + index + ", " + value + ", " + indexSourceArgument(parts.get(0)) + ");";
        }
      }
      if (frame.isField(name)) {
        String pathPrefix = "\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\"}";
        String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + "," +
            pathPrefix + ",\\\"value\\\":\" + TraceHooks.serializeResult(" + name + ") + \"}\");";
        MutatingArgs rewrittenArgs = mutatingArgs(rawArgs, sourceLine, frame);
        String mutateEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"mutate\\\",\\\"line\\\":" + sourceLine + "," +
            pathPrefix + ",\\\"method\\\":\\\"" + method + "\\\"" + rewrittenArgs.eventSegment + "}\");";
        String writeEvent = sequenceAppendWriteHook(sourceLine, name, frame.typeOf(name), method, rawArgs, rewrittenArgs.callArgs);
        String snapshotEvent = "TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");";
        return indent + "{ " + readEvent + " " + rewrittenArgs.prefix + name + "." + method + "(" + rewrittenArgs.callArgs + "); " + mutateEvent + writeEvent + " " + snapshotEvent + " }";
      }
      MutatingArgs rewrittenArgs = mutatingArgs(rawArgs, sourceLine, frame);
      String mutateHook = rawArgs.isEmpty()
          ? "TraceHooks.emitNoArgMutatingCallAtLine(" + sourceLine + ", " + quote(name) + ", " + quote(method) + ")"
          : "TraceHooks.emitMutatingCallAtLine(" + sourceLine + ", " + quote(name) + ", " + quote(method) + ", " + rewrittenArgs.callArgs + ")";
      String writeEvent = sequenceAppendWriteHook(sourceLine, name, frame.typeOf(name), method, rawArgs, rewrittenArgs.callArgs);
      return indent + "{ " + rewrittenArgs.prefix + name + "." + method + "(" + rewrittenArgs.callArgs + "); " + mutateHook + ";" + writeEvent + " TraceHooks.emitRuntimeSnapshotAtLine(" + sourceLine + ", " + quote(name) + ", " + name + "); }";
    }

    return rewriteReads(line, sourceLine, frame);
  }

  private static boolean emitsPostLineState(String trimmed, MethodFrame frame) {
    if (trimmed.startsWith("for ")) return false;
    Matcher declaration = LOCAL_DECLARATION.matcher(trimmed);
    if (declaration.matches() && !isControlKeyword(declaration.group(2).trim())) return true;
    Matcher assignment = LOCAL_ASSIGNMENT.matcher(trimmed);
    if (assignment.matches() && frame.variables.containsKey(assignment.group(2))) return true;
    Matcher compoundAssignment = LOCAL_COMPOUND_ASSIGNMENT.matcher(trimmed);
    if (compoundAssignment.matches() && frame.variables.containsKey(compoundAssignment.group(2))) return true;
    Matcher localUpdate = LOCAL_UPDATE.matcher(trimmed);
    return localUpdate.matches() && (localUpdate.group(2) != null || localUpdate.group(4) != null) && frame.variables.containsKey(localUpdate.group(3));
  }

  private static String rewriteInlineControlStatement(String line, int sourceLine, MethodFrame frame) {
    String trimmed = line.trim();
    if (trimmed.startsWith("if ") || trimmed.startsWith("if(")) {
      return rewriteInlineIfStatement(line, sourceLine, frame);
    }
    if (trimmed.startsWith("else ") && !trimmed.startsWith("else if ") && !trimmed.startsWith("else if(")) {
      String indent = indentOf(line);
      String body = stripTrailingLineComment(trimmed.substring("else".length()).trim()).trim();
      if (body.isEmpty() || body.startsWith("{") || !body.endsWith(";")) {
        return null;
      }
      return indent + "else {\n" +
          indent + "  TraceHooks.emitLineAtLine(" + sourceLine + ");\n" +
          rewriteBranchStatement(indent + "  ", body, sourceLine, frame) + "\n" +
          indent + "}";
    }
    return null;
  }

  private static String rewriteInlineIfStatement(String line, int sourceLine, MethodFrame frame) {
    String indent = indentOf(line);
    int keyword = firstNonWhitespace(line);
    int openParen = line.indexOf('(', keyword + 2);
    if (openParen < 0) return null;
    int closeParen = findMatchingParen(line, openParen);
    if (closeParen < 0) return null;
    String rest = stripTrailingLineComment(line.substring(closeParen + 1)).trim();
    if (rest.isEmpty() || rest.startsWith("{") || !rest.endsWith(";")) {
      return null;
    }
    int elseIndex = findTopLevelElse(rest);
    String thenBody = elseIndex >= 0 ? rest.substring(0, elseIndex).trim() : rest;
    if (thenBody.isEmpty() || !thenBody.endsWith(";")) {
      return null;
    }
    String condition = rewriteReads(line.substring(openParen + 1, closeParen).trim(), sourceLine, frame);
    StringBuilder out = new StringBuilder();
    out.append(indent).append("if (").append(condition).append(") {\n")
        .append(rewriteBranchStatement(indent + "  ", thenBody, sourceLine, frame)).append('\n')
        .append(indent).append("}");
    if (elseIndex >= 0) {
      String elseBody = rest.substring(elseIndex + "else".length()).trim();
      if (elseBody.isEmpty() || elseBody.startsWith("{") || !elseBody.endsWith(";")) {
        return null;
      }
      out.append(" else {\n")
          .append(rewriteBranchStatement(indent + "  ", elseBody, sourceLine, frame)).append('\n')
          .append(indent).append("}");
    }
    return out.toString();
  }

  private static String rewriteBranchStatement(String indent, String statement, int sourceLine, MethodFrame frame) {
    String rewritten = rewriteStatement(indent + stripTrailingLineComment(statement).trim(), sourceLine, frame);
    return stripLeadingLineHook(rewritten, indent, sourceLine);
  }

  private static String stripLeadingLineHook(String rewritten, String indent, int sourceLine) {
    String hook = indent + "TraceHooks.emitLineAtLine(" + sourceLine + ");\n";
    if (rewritten.startsWith(hook)) {
      return rewritten.substring(hook.length());
    }
    return rewritten;
  }

  private static String rewriteReads(String source, int line, MethodFrame frame) {
    String next = replaceAll(STRING_ARRAY_CHAR_AT, source, match -> {
      String name = match.group(1);
      if (!isStringArrayType(frame.typeOf(name))) return match.group(0);
      String rawRow = match.group(2).trim();
      String rawCol = match.group(3).trim();
      String row = rewriteReads(rawRow, line, frame);
      String col = rewriteReads(rawCol, line, frame);
      return "TraceHooks.readStringMatrixCharAtLine(" + line + ", " + quote(name) + ", " + name + ", " + row + ", " + col + ", " + indexSourceArgument(rawRow) + ", " + indexSourceArgument(rawCol) + ")";
    });
    next = replaceAll(STRING_ARRAY_LENGTH_CALL, next, match -> {
      String name = match.group(1);
      if (!isStringArrayType(frame.typeOf(name))) return match.group(0);
      String rawIndex = match.group(2).trim();
      String index = rewriteReads(rawIndex, line, frame);
      return "TraceHooks.readIndexedStringLengthAtLine(" + line + ", " + quote(name) + ", " + name + ", " + index + ", " + indexSourceArgument(rawIndex) + ")";
    });
    next = replaceAll(STRING_CHAR_AT, next, match -> {
      String rawIndex = match.group(2).trim();
      String index = rewriteReads(rawIndex, line, frame);
      return "TraceHooks.readStringCharAtLine(" + line + ", " + quote(match.group(1)) + ", " + match.group(1) + ", " + index + ", " + indexSourceArgument(rawIndex) + ")";
    });
    next = replaceAll(LIST_ARRAY_READ, next, match -> {
      String name = match.group(1);
      String helper = listArrayReadHelper(frame.typeOf(name));
      if (helper == null) return match.group(0);
      String rawRow = match.group(2).trim();
      String rawCol = match.group(3).trim();
      String row = rewriteReads(rawRow, line, frame);
      String col = rewriteReads(rawCol, line, frame);
      return "TraceHooks." + helper + "(" + line + ", " + quote(name) + ", " + name + ", " + row + ", " + col + ", " + indexSourceArgument(rawRow) + ", " + indexSourceArgument(rawCol) + ")";
    });
    next = replaceAll(THIS_FIELD_MAP_CONTAINS_KEY_CALL, next, match -> {
      String field = match.group(1);
      if (!isMapType(frame.typeOf(field))) return match.group(0);
      String rawKey = match.group(2).trim();
      String key = rewriteReads(rawKey, line, frame);
      return "TraceHooks.containsFieldMapKeyAtLine(" + line + ", \"this\", " + quote(field) + ", this." + field + ", " + key + ", " + indexSourceArgument(rawKey) + ")";
    });
    next = replaceAll(THIS_FIELD_MAP_GET_OR_DEFAULT_CALL, next, match -> {
      String field = match.group(1);
      if (!isMapType(frame.typeOf(field))) return match.group(0);
      java.util.List<String> args = splitTopLevel(match.group(2).trim());
      if (args.size() != 2) return match.group(0);
      String rawKey = args.get(0);
      String rawDefault = args.get(1);
      return "TraceHooks.readFieldMapOrDefaultAtLine(" + line + ", \"this\", " + quote(field) + ", this." + field + ", " + rewriteReads(rawKey, line, frame) + ", " + rewriteReads(rawDefault, line, frame) + ", " + indexSourceArgument(rawKey) + ")";
    });
    next = replaceAll(THIS_FIELD_MAP_GET_CALL, next, match -> {
      String field = match.group(1);
      if (!isMapType(frame.typeOf(field))) return match.group(0);
      String rawKey = match.group(2).trim();
      String key = rewriteReads(rawKey, line, frame);
      return "TraceHooks.readFieldMapAtLine(" + line + ", \"this\", " + quote(field) + ", this." + field + ", " + key + ", " + indexSourceArgument(rawKey) + ")";
    });
    next = replaceAll(OBJECT_FIELD_MAP_CONTAINS_KEY_CALL, next, match -> {
      String name = match.group(1);
      String field = match.group(2);
      if (!isMapType(frame.typeOf(field))) return match.group(0);
      String rawKey = match.group(3).trim();
      String key = rewriteReads(rawKey, line, frame);
      return "TraceHooks.containsFieldMapKeyAtLine(" + line + ", " + quote(name) + ", " + quote(field) + ", " + name + "." + field + ", " + key + ", " + indexSourceArgument(rawKey) + ")";
    });
    next = replaceAll(OBJECT_FIELD_MAP_GET_OR_DEFAULT_CALL, next, match -> {
      String name = match.group(1);
      String field = match.group(2);
      if (!isMapType(frame.typeOf(field))) return match.group(0);
      java.util.List<String> args = splitTopLevel(match.group(3).trim());
      if (args.size() != 2) return match.group(0);
      String rawKey = args.get(0);
      String rawDefault = args.get(1);
      return "TraceHooks.readFieldMapOrDefaultAtLine(" + line + ", " + quote(name) + ", " + quote(field) + ", " + name + "." + field + ", " + rewriteReads(rawKey, line, frame) + ", " + rewriteReads(rawDefault, line, frame) + ", " + indexSourceArgument(rawKey) + ")";
    });
    next = replaceAll(OBJECT_FIELD_MAP_GET_CALL, next, match -> {
      String name = match.group(1);
      String field = match.group(2);
      if (!isMapType(frame.typeOf(field))) return match.group(0);
      String rawKey = match.group(3).trim();
      String key = rewriteReads(rawKey, line, frame);
      return "TraceHooks.readFieldMapAtLine(" + line + ", " + quote(name) + ", " + quote(field) + ", " + name + "." + field + ", " + key + ", " + indexSourceArgument(rawKey) + ")";
    });
    next = replaceAll(MAP_CONTAINS_KEY_CALL, next, match -> {
      String name = match.group(1);
      if (!isMapType(frame.typeOf(name))) return match.group(0);
      if (frame.isField(name)) {
        String rawKey = match.group(2).trim();
        String key = rewriteReads(rawKey, line, frame);
        return "TraceHooks.containsFieldMapKeyAtLine(" + line + ", \"this\", " + quote(name) + ", " + name + ", " + key + ", " + indexSourceArgument(rawKey) + ")";
      }
      String rawKey = match.group(2).trim();
      String key = rewriteReads(rawKey, line, frame);
      return "TraceHooks.containsMapKeyAtLine(" + line + ", " + quote(name) + ", " + name + ", " + key + ", " + indexSourceArgument(rawKey) + ")";
    });
    next = replaceAll(COLLECTION_CONTAINS_CALL, next, match -> {
      String name = match.group(1);
      if (!isSetType(frame.typeOf(name))) return match.group(0);
      String rawKey = match.group(2).trim();
      String key = rewriteReads(rawKey, line, frame);
      return "TraceHooks.readSetAtLine(" + line + ", " + quote(name) + ", " + name + ", " + key + ", " + indexSourceArgument(rawKey) + ")";
    });
    next = replaceAll(MAP_GET_OR_DEFAULT_CALL, next, match -> {
      String name = match.group(1);
      if (!isMapType(frame.typeOf(name))) return match.group(0);
      java.util.List<String> args = splitTopLevel(match.group(2).trim());
      if (args.size() != 2) return match.group(0);
      String rawKey = args.get(0);
      String rawDefault = args.get(1);
      if (frame.isField(name)) {
        return "TraceHooks.readFieldMapOrDefaultAtLine(" + line + ", \"this\", " + quote(name) + ", " + name + ", " + rewriteReads(rawKey, line, frame) + ", " + rewriteReads(rawDefault, line, frame) + ", " + indexSourceArgument(rawKey) + ")";
      }
        return "TraceHooks.readMapOrDefaultAtLine(" + line + ", " + quote(name) + ", " + name + ", " + rewriteReads(rawKey, line, frame) + ", " + rewriteReads(rawDefault, line, frame) + ", " + indexSourceArgument(rawKey) + ")";
    });
    next = replaceAll(MAP_GET_CALL, next, match -> {
      String name = match.group(1);
      String receiverType = frame.typeOf(name);
      if (isMapType(receiverType)) {
        if (frame.isField(name)) {
          String rawKey = match.group(2).trim();
          String key = rewriteReads(rawKey, line, frame);
          return "TraceHooks.readFieldMapAtLine(" + line + ", \"this\", " + quote(name) + ", " + name + ", " + key + ", " + indexSourceArgument(rawKey) + ")";
        }
        String rawKey = match.group(2).trim();
        String key = rewriteReads(rawKey, line, frame);
        return "TraceHooks.readMapAtLine(" + line + ", " + quote(name) + ", " + name + ", " + key + ", " + indexSourceArgument(rawKey) + ")";
      }
      if (isListType(receiverType)) {
        String rawIndex = match.group(2).trim();
        String index = rewriteReads(rawIndex, line, frame);
        return "TraceHooks.readListAtLine(" + line + ", " + quote(name) + ", " + name + ", " + index + ", " + indexSourceArgument(rawIndex) + ")";
      }
      return match.group(0);
    });
    final String matrixReadSource = next;
    next = replaceAll(MATRIX_READ, matrixReadSource, match -> {
      String full = match.group(0);
      if (full.contains("TraceHooks.")) return full;
      String name = match.group(1);
      if (isArrayAllocationTypeMatch(matrixReadSource, match.start())) return full;
      if (isArrayWriteTarget(matrixReadSource, match.start(), match.end())) return full;
      if (nextNonWhitespace(matrixReadSource, match.end()) == '[') return full;
      String helper = matrixReadHelper(frame.typeOf(name));
      if (helper == null) return full;
      String rawRow = match.group(2).trim();
      String rawCol = match.group(3).trim();
      String row = rewriteReads(rawRow, line, frame);
      String col = rewriteReads(rawCol, line, frame);
      return "TraceHooks." + helper + "(" + line + ", " + quote(name) + ", " + name + ", " + row + ", " + col + ", " + indexSourceArgument(rawRow) + ", " + indexSourceArgument(rawCol) + ")";
    });
    next = rewriteArrayReads(next, line, frame);
    next = replaceAll(QUEUE_REMOVE_CALL, next, match -> {
      String name = match.group(1);
      if (!isQueueLikeType(frame.typeOf(name))) return match.group(0);
      String method = match.group(2);
      String hook = "poll".equals(method) ? "pollQueueAtLine" : "removeQueueAtLine";
      return "TraceHooks." + hook + "(" + line + ", " + quote(name) + ", " + name + ")";
    });
    next = replaceAll(QUEUE_PEEK_CALL, next, match -> {
      String name = match.group(1);
      if (!isQueueLikeType(frame.typeOf(name))) return match.group(0);
      return "TraceHooks.readQueuePeekAtLine(" + line + ", " + quote(name) + ", " + name + ")";
    });
    next = replaceAll(STACK_DEQUE_POP_CALL, next, match -> {
      String name = match.group(1);
      String receiverType = frame.typeOf(name);
      if (isStackType(receiverType)) {
        return "TraceHooks.popStackAtLine(" + line + ", " + quote(name) + ", " + name + ")";
      }
      if (isDequeType(receiverType)) {
        return "TraceHooks.popDequeAtLine(" + line + ", " + quote(name) + ", " + name + ")";
      }
      return match.group(0);
    });
    final String fieldReadSource = next;
    next = replaceAll(FIELD_READ, fieldReadSource, match -> {
      String full = match.group(0);
      if (full.contains("TraceHooks.")) return full;
      if (isInsideTraceHooksCall(fieldReadSource, match.start())) return full;
      if (isArrayWriteTarget(fieldReadSource, match.start(), match.end())) return full;
      String name = match.group(1);
      String field = match.group(2);
      if ("java".equals(name) || Character.isUpperCase(name.charAt(0)) || "out".equals(field) || "err".equals(field)) return full;
      if ("length".equals(field) && arrayReadHelper(frame.typeOf(name)) != null) return full;
      return "TraceHooks.readObjectFieldAtLine(" + line + ", " + quote(name) + ", " + quote(field) + ", " + name + "." + field + ")";
    });
    return next;
  }

  private static void registerFieldDeclaration(Map<String, String> fields, String line) {
    Matcher field = FIELD_DECLARATION.matcher(stripTrailingLineComment(line));
    if (field.matches()) {
      fields.put(field.group(2), normalizeJavaType(field.group(1)));
    }
  }

  private static String stripTrailingLineComment(String line) {
    boolean inString = false;
    boolean inChar = false;
    boolean escaped = false;
    for (int index = 0; index < line.length() - 1; index++) {
      char ch = line.charAt(index);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch == '\\') {
        escaped = inString || inChar;
        continue;
      }
      if (inString) {
        if (ch == '"') inString = false;
        continue;
      }
      if (inChar) {
        if (ch == '\'') inChar = false;
        continue;
      }
      if (ch == '"') {
        inString = true;
        continue;
      }
      if (ch == '\'') {
        inChar = true;
        continue;
      }
      if (ch == '/' && line.charAt(index + 1) == '/') {
        return line.substring(0, index).replaceAll("\\s+$", "");
      }
    }
    return line;
  }

  private static boolean startsMultilineInitializer(String trimmed) {
    return trimmed.contains("{") && !trimmed.contains(";") &&
        !trimmed.startsWith("if ") && !trimmed.startsWith("for ") && !trimmed.startsWith("while ") &&
        !trimmed.startsWith("switch ") && !trimmed.startsWith("try") && !trimmed.startsWith("catch") &&
        !trimmed.startsWith("finally") && !trimmed.startsWith("else") && !trimmed.startsWith("do ");
  }

  private static PendingMultilineMutation multilineMutationStart(String line, int sourceLine, MethodFrame frame) {
    Matcher mutation = Pattern.compile("^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)$").matcher(line);
    if (!mutation.matches() || !isTrackedMutationMethod(mutation.group(3))) return null;
    String name = mutation.group(2);
    if (!frame.variables.containsKey(name) && !frame.isField(name)) return null;
    return new PendingMultilineMutation(mutation.group(1), sourceLine, name, mutation.group(3));
  }

  private static void registerMultilineLocalDeclaration(MethodFrame frame, String trimmed) {
    int equalsIndex = trimmed.indexOf('=');
    if (equalsIndex <= 0) return;
    String beforeEquals = trimmed.substring(0, equalsIndex).trim();
    String[] parts = beforeEquals.split("\\s+");
    if (parts.length < 2) return;
    String name = parts[parts.length - 1];
    if (!name.matches("[A-Za-z_][A-Za-z0-9_]*")) return;
    String type = beforeEquals.substring(0, beforeEquals.length() - name.length()).trim();
    if (type.startsWith("final ")) type = type.substring("final ".length()).trim();
    if (type.isEmpty() || isControlKeyword(type)) return;
    registerLocalDeclarators(frame, type, name);
  }

  private static boolean startsMultilineControlHeader(String trimmed) {
    if (!(trimmed.startsWith("if ") || trimmed.startsWith("if(") ||
        trimmed.startsWith("while ") || trimmed.startsWith("while(") ||
        trimmed.startsWith("for ") || trimmed.startsWith("for(") ||
        trimmed.startsWith("switch ") || trimmed.startsWith("switch("))) {
      return false;
    }
    return parenDelta(trimmed) > 0;
  }

  private static boolean isControlHeaderContinuation(String trimmed) {
    return trimmed.startsWith(")") || trimmed.startsWith("&&") || trimmed.startsWith("||");
  }

  private static boolean isEnhancedForHeader(String trimmed) {
    return trimmed.startsWith("for ") || trimmed.startsWith("for(")
        ? Pattern.compile("^for\\s*\\([^;]+:[^;]+\\)\\s*\\{?\\s*$").matcher(trimmed).matches()
        : false;
  }

  private static boolean startsUnbracedControlHeader(String trimmed) {
    if (trimmed.contains("{") || trimmed.endsWith(";")) return false;
    if (startsMultilineControlHeader(trimmed)) return false;
    return trimmed.startsWith("if ") || trimmed.startsWith("if(") ||
        trimmed.startsWith("while ") || trimmed.startsWith("while(") ||
        trimmed.startsWith("for ") || trimmed.startsWith("for(") ||
        trimmed.startsWith("else if ") || trimmed.startsWith("else if(") ||
        trimmed.equals("else") ||
        trimmed.startsWith("else ");
  }

  private static boolean endsWithExpressionContinuation(String trimmed) {
    if (trimmed.isEmpty()) return false;
    return trimmed.endsWith("||") || trimmed.endsWith("&&") ||
        trimmed.endsWith("+") || trimmed.endsWith("-") || trimmed.endsWith("*") ||
        trimmed.endsWith("/") || trimmed.endsWith("%") || trimmed.endsWith("?") ||
        trimmed.endsWith(":") || trimmed.endsWith(",") ||
        trimmed.endsWith("(") || trimmed.endsWith("[");
  }

  private static void updateExpressionContinuation(MethodFrame frame, String trimmed) {
    if (trimmed.isEmpty() || trimmed.startsWith("//") || trimmed.startsWith("@")) {
      return;
    }
    int nextParenDepth = Math.max(0, frame.expressionParenDepth + parenDelta(trimmed));
    boolean startsStatementContinuation = !trimmed.endsWith(";") &&
        !trimmed.endsWith("{") &&
        !trimmed.endsWith("}") &&
        !startsMultilineControlHeader(trimmed) &&
        !trimmed.startsWith("if ") && !trimmed.startsWith("if(") &&
        !trimmed.startsWith("while ") && !trimmed.startsWith("while(") &&
        !trimmed.startsWith("for ") && !trimmed.startsWith("for(") &&
        !trimmed.startsWith("switch ") && !trimmed.startsWith("switch(") &&
        !trimmed.startsWith("else") &&
        !trimmed.startsWith("catch") &&
        !trimmed.startsWith("finally");
    frame.expressionParenDepth = nextParenDepth;
    frame.statementContinuation = nextParenDepth > 0 || (startsStatementContinuation && frame.depth > 0);
  }

  private static boolean isArrayAllocationTypeMatch(String source, int matchStart) {
    String prefix = source.substring(0, matchStart).replaceAll("\\s+$", "");
    return prefix.matches("(?s).*\\bnew$");
  }

  private static boolean isArrayWriteTarget(String source, int start, int end) {
    String before = source.substring(0, start).replaceAll("\\s+$", "");
    if (before.endsWith("++") || before.endsWith("--")) return true;
    String after = source.substring(end).replaceAll("^\\s+", "");
    if (after.startsWith("++") || after.startsWith("--")) return true;
    if (after.startsWith("=") && !after.startsWith("==")) return true;
    if (after.length() >= 2 && "+-*/%&|^".indexOf(after.charAt(0)) >= 0 && after.charAt(1) == '=') return true;
    return false;
  }

  private static String rewriteArrayReads(String source, int line, MethodFrame frame) {
    StringBuilder out = new StringBuilder();
    int index = 0;
    while (index < source.length()) {
      char current = source.charAt(index);
      if (current == '"' || current == '\'') {
        int literalEnd = skipJavaLiteral(source, index);
        out.append(source, index, literalEnd);
        index = literalEnd;
        continue;
      }
      if (!isJavaIdentifierStart(current) || (index > 0 && isJavaIdentifierPart(source.charAt(index - 1)))) {
        out.append(current);
        index++;
        continue;
      }
      int nameStart = index;
      int nameEnd = index + 1;
      while (nameEnd < source.length() && isJavaIdentifierPart(source.charAt(nameEnd))) nameEnd++;
      String name = source.substring(nameStart, nameEnd);
      int bracketStart = skipWhitespace(source, nameEnd);
      if (
          bracketStart >= source.length() ||
          source.charAt(bracketStart) != '[' ||
          (nameStart > 0 && source.charAt(nameStart - 1) == '.') ||
          "TraceHooks".equals(name)
      ) {
        out.append(source, nameStart, nameEnd);
        index = nameEnd;
        continue;
      }
      int bracketEnd = findMatchingBracket(source, bracketStart);
      if (bracketEnd < 0) {
        out.append(source, nameStart, nameEnd);
        index = nameEnd;
        continue;
      }
      String full = source.substring(nameStart, bracketEnd + 1);
      String helper = arrayReadHelper(frame.typeOf(name));
      if (
          helper == null ||
          isArrayAllocationTypeMatch(source, nameStart) ||
          isArrayWriteTarget(source, nameStart, bracketEnd + 1) ||
          nextNonWhitespace(source, bracketEnd + 1) == '['
      ) {
        out.append(full);
        index = bracketEnd + 1;
        continue;
      }
      String rawIndex = source.substring(bracketStart + 1, bracketEnd).trim();
      String indexExpression = rewriteReads(rawIndex, line, frame);
      out.append("TraceHooks.")
          .append(helper)
          .append("(")
          .append(line)
          .append(", ")
          .append(quote(name))
          .append(", ")
          .append(name)
          .append(", ")
          .append(indexExpression)
          .append(", ")
          .append(indexSourceArgument(rawIndex))
          .append(")");
      index = bracketEnd + 1;
    }
    return out.toString();
  }

  private static int findMatchingBracket(String source, int openIndex) {
    int depth = 0;
    for (int index = openIndex; index < source.length(); index++) {
      char current = source.charAt(index);
      if (current == '"' || current == '\'') {
        index = skipJavaLiteral(source, index) - 1;
        continue;
      }
      if (current == '[') {
        depth++;
      } else if (current == ']') {
        depth--;
        if (depth == 0) return index;
      }
    }
    return -1;
  }

  private static int skipJavaLiteral(String source, int start) {
    char quote = source.charAt(start);
    int index = start + 1;
    while (index < source.length()) {
      char current = source.charAt(index);
      if (current == '\\') {
        index += 2;
        continue;
      }
      index++;
      if (current == quote) return index;
    }
    return source.length();
  }

  private static int skipWhitespace(String source, int start) {
    int index = start;
    while (index < source.length() && Character.isWhitespace(source.charAt(index))) index++;
    return index;
  }

  private static boolean isJavaIdentifierStart(char value) {
    return Character.isLetter(value) || value == '_' || value == '$';
  }

  private static boolean isJavaIdentifierPart(char value) {
    return Character.isLetterOrDigit(value) || value == '_' || value == '$';
  }

  private static boolean hasIndexSideEffect(String source) {
    if (source.contains("++") || source.contains("--")) return true;
    Matcher call = Pattern.compile("\\.([A-Za-z_][A-Za-z0-9_]*)\\s*\\(").matcher(source);
    while (call.find()) {
      if (isTrackedMutationMethod(call.group(1))) return true;
    }
    return false;
  }

  private static char nextNonWhitespace(String source, int start) {
    int index = start;
    while (index < source.length() && Character.isWhitespace(source.charAt(index))) index++;
    return index < source.length() ? source.charAt(index) : '\0';
  }

  private static String arrayReadHelper(String type) {
    if (type == null) return null;
    String normalized = normalizeJavaType(type);
    if (!normalized.endsWith("[]")) return null;
    String element = normalized.substring(0, normalized.length() - 2).trim();
    if (element.endsWith("[]")) return "readObjectArrayAtLine";
    if ("int".equals(element)) return "readIntArrayAtLine";
    if ("boolean".equals(element)) return "readBooleanArrayAtLine";
    if ("long".equals(element)) return "readLongArrayAtLine";
    if ("double".equals(element)) return "readDoubleArrayAtLine";
    if ("float".equals(element)) return "readFloatArrayAtLine";
    if ("char".equals(element)) return "readCharArrayAtLine";
    if ("byte".equals(element)) return "readByteArrayAtLine";
    if ("short".equals(element)) return "readShortArrayAtLine";
    return "readObjectArrayAtLine";
  }

  private static String matrixReadHelper(String type) {
    if (type == null) return null;
    String normalized = normalizeJavaType(type);
    if (!normalized.endsWith("[][]")) return null;
    String element = normalized.substring(0, normalized.length() - 4).trim();
    if ("int".equals(element)) return "readIntMatrixAtLine";
    if ("boolean".equals(element)) return "readBooleanMatrixAtLine";
    if ("long".equals(element)) return "readLongMatrixAtLine";
    if ("double".equals(element)) return "readDoubleMatrixAtLine";
    if ("float".equals(element)) return "readFloatMatrixAtLine";
    if ("char".equals(element)) return "readCharMatrixAtLine";
    if ("byte".equals(element)) return "readByteMatrixAtLine";
    if ("short".equals(element)) return "readShortMatrixAtLine";
    return "readObjectMatrixAtLine";
  }

  private static String listArrayReadHelper(String type) {
    if (type == null) return null;
    String normalized = normalizeJavaType(type);
    if (!normalized.contains("List<") || !normalized.contains("[]")) return null;
    if (normalized.contains("int[]")) return "readIntArrayListAtLine";
    if (normalized.contains("long[]")) return "readLongArrayListAtLine";
    if (normalized.contains("char[]")) return "readCharArrayListAtLine";
    if (normalized.contains("boolean[]")) return "readBooleanArrayListAtLine";
    if (normalized.contains("double[]")) return "readDoubleArrayListAtLine";
    if (normalized.contains("float[]")) return "readFloatArrayListAtLine";
    if (normalized.contains("byte[]")) return "readByteArrayListAtLine";
    if (normalized.contains("short[]")) return "readShortArrayListAtLine";
    return "readObjectArrayListAtLine";
  }

  private static boolean isStringArrayType(String type) {
    return "String[]".equals(type == null ? null : normalizeJavaType(type));
  }

  private static boolean isArrayType(String type) {
    return type != null && normalizeJavaType(type).endsWith("[]");
  }

  private static boolean isNestedArrayType(String type) {
    return type != null && normalizeJavaType(type).endsWith("[][]");
  }

  private static boolean isArrayOfMapType(String type) {
    if (type == null) return false;
    String normalized = normalizeJavaType(type);
    return normalized.endsWith("[]") && normalized.contains("Map");
  }

  private static boolean isMapType(String type) {
    if (type == null) return false;
    return normalizeJavaType(type).contains("Map");
  }

  private static boolean isSetType(String type) {
    if (type == null) return false;
    return normalizeJavaType(type).contains("Set<");
  }

  private static boolean isListType(String type) {
    if (type == null) return false;
    String normalized = normalizeJavaType(type);
    return normalized.contains("List<") && !normalized.contains("Map");
  }

  private static boolean isQueueLikeType(String type) {
    if (type == null) return false;
    String normalized = normalizeJavaType(type);
    return normalized.contains("Queue<") || normalized.contains("Deque<") || normalized.contains("PriorityQueue<");
  }

  private static boolean isPriorityQueueType(String type) {
    if (type == null) return false;
    return normalizeJavaType(type).contains("PriorityQueue<");
  }

  private static boolean isStackType(String type) {
    if (type == null) return false;
    return normalizeJavaType(type).contains("Stack<");
  }

  private static boolean isDequeType(String type) {
    if (type == null) return false;
    return normalizeJavaType(type).contains("Deque<");
  }

  private static String indexedAccessExpression(String name, String type, String index) {
    String normalized = type == null ? "" : normalizeJavaType(type);
    if (normalized.contains("Map")) {
      return "((" + indexedValueCastType(normalized, "java.util.Map") + ")((java.util.Map)" + name + ").get(" + index + "))";
    }
    return "((" + indexedValueCastType(normalized, "java.util.List") + ")((java.util.List)" + name + ").get(" + index + "))";
  }

  private static String indexedValueCastType(String normalizedType, String fallback) {
    if (normalizedType.contains("Deque<")) return "java.util.Deque";
    if (normalizedType.contains("Queue<")) return "java.util.Queue";
    if (normalizedType.contains("Set<")) return "java.util.Set";
    if (normalizedType.contains("Collection<")) return "java.util.Collection";
    if (normalizedType.contains("List<")) return "java.util.List";
    return fallback;
  }

  private static String normalizeJavaType(String type) {
    return type.trim().replaceAll("\\s+", " ").replaceAll("\\s*\\[\\s*\\]", "[]");
  }

  private static java.util.List<String> registerLocalDeclarators(
      MethodFrame frame,
      String type,
      String declaratorsSource
  ) {
    java.util.List<String> names = new java.util.ArrayList<>();
    String normalizedType = normalizeJavaType(type);
    for (String declarator : splitTopLevel(declaratorsSource)) {
      String name = declaratorName(declarator);
      if (name == null) continue;
      frame.variables.put(name, normalizedType);
      names.add(name);
    }
    return names;
  }

  private static String declaratorName(String declarator) {
    int assignment = declarator.indexOf('=');
    String left = assignment >= 0 ? declarator.substring(0, assignment).trim() : declarator.trim();
    Matcher name = Pattern.compile("([A-Za-z_][A-Za-z0-9_]*)\\s*(?:\\[\\s*\\])*\\s*$").matcher(left);
    return name.find() ? name.group(1) : null;
  }

  private static void registerParameters(Map<String, String> variables, String parametersSource) {
    if (parametersSource == null || parametersSource.trim().isEmpty()) return;
    for (String parameter : splitTopLevel(parametersSource)) {
      String cleaned = parameter.replaceAll("@\\w+(?:\\([^)]*\\))?", "").replaceAll("\\bfinal\\b", "").trim();
      Matcher name = Pattern.compile("([A-Za-z_][A-Za-z0-9_]*)\\s*(?:\\.\\.\\.)?$").matcher(cleaned);
      if (!name.find()) continue;
      String paramName = name.group(1);
      String type = cleaned.substring(0, name.start()).trim();
      if (cleaned.endsWith("...")) type += "[]";
      if (!type.isEmpty()) variables.put(paramName, normalizeJavaType(type));
    }
  }

  private static java.util.List<String> splitTopLevel(String source) {
    java.util.List<String> parts = new java.util.ArrayList<>();
    int start = 0;
    int angleDepth = 0;
    int parenDepth = 0;
    int bracketDepth = 0;
    int braceDepth = 0;
    boolean inString = false;
    boolean inChar = false;
    boolean escaped = false;
    for (int index = 0; index < source.length(); index++) {
      char ch = source.charAt(index);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch == '\\') {
        escaped = inString || inChar;
        continue;
      }
      if (inString) {
        if (ch == '"') inString = false;
        continue;
      }
      if (inChar) {
        if (ch == '\'') inChar = false;
        continue;
      }
      if (ch == '"') {
        inString = true;
        continue;
      }
      if (ch == '\'') {
        inChar = true;
        continue;
      }
      if (ch == '<') angleDepth++;
      if (ch == '>') angleDepth = Math.max(0, angleDepth - 1);
      if (ch == '(') parenDepth++;
      if (ch == ')') parenDepth = Math.max(0, parenDepth - 1);
      if (ch == '[') bracketDepth++;
      if (ch == ']') bracketDepth = Math.max(0, bracketDepth - 1);
      if (ch == '{') braceDepth++;
      if (ch == '}') braceDepth = Math.max(0, braceDepth - 1);
      if (ch == ',' && angleDepth == 0 && parenDepth == 0 && bracketDepth == 0 && braceDepth == 0) {
        parts.add(source.substring(start, index).trim());
        start = index + 1;
      }
    }
    String tail = source.substring(start).trim();
    if (!tail.isEmpty()) parts.add(tail);
    return parts;
  }

  private static String replaceAll(Pattern pattern, String source, Replacer replacer) {
    Matcher matcher = pattern.matcher(source);
    StringBuffer out = new StringBuffer();
    while (matcher.find()) {
      if (isInsideJavaLiteral(source, matcher.start())) {
        matcher.appendReplacement(out, Matcher.quoteReplacement(matcher.group(0)));
        continue;
      }
      matcher.appendReplacement(out, Matcher.quoteReplacement(replacer.replace(matcher)));
    }
    matcher.appendTail(out);
    return out.toString();
  }

  private static boolean isInsideJavaLiteral(String source, int offset) {
    boolean inString = false;
    boolean inChar = false;
    boolean escaped = false;
    for (int index = 0; index < offset; index++) {
      char ch = source.charAt(index);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch == '\\') {
        escaped = inString || inChar;
        continue;
      }
      if (inString) {
        if (ch == '"') inString = false;
        continue;
      }
      if (inChar) {
        if (ch == '\'') inChar = false;
        continue;
      }
      if (ch == '"') {
        inString = true;
        continue;
      }
      if (ch == '\'') {
        inChar = true;
      }
    }
    return inString || inChar;
  }

  private static boolean isInsideTraceHooksCall(String source, int offset) {
    int marker = source.lastIndexOf("TraceHooks.", offset);
    if (marker < 0) return false;
    int delimiter = Math.max(source.lastIndexOf(';', offset), source.lastIndexOf('\n', offset));
    return marker > delimiter;
  }

  private static boolean shouldEmitLine(String trimmed) {
    if (trimmed.isEmpty()) return false;
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return false;
    if (trimmed.startsWith("{") || trimmed.equals("}")) return false;
    if (trimmed.startsWith("}")) return false;
    if (trimmed.startsWith(")")) return false;
    if (trimmed.startsWith(".")) return false;
    if (trimmed.startsWith("case ") || trimmed.startsWith("default:")) return false;
    if (trimmed.startsWith("?") || trimmed.startsWith(":")) return false;
    if (trimmed.startsWith("&&") || trimmed.startsWith("||")) return false;
    if (trimmed.startsWith("else")) return false;
    if (trimmed.startsWith("catch") || trimmed.startsWith("finally")) return false;
    return true;
  }

  private static boolean isScalarSnapshotType(String type) {
    return "boolean".equals(type) || "byte".equals(type) || "char".equals(type) || "short".equals(type) ||
        "int".equals(type) || "long".equals(type) || "float".equals(type) || "double".equals(type) || "String".equals(type);
  }

  private static boolean isTrackedMutationMethod(String method) {
    return "add".equals(method) || "push".equals(method) || "offer".equals(method) ||
        "append".equals(method) ||
        "addAll".equals(method) ||
        "addLast".equals(method) || "offerLast".equals(method) || "put".equals(method) || "putIfAbsent".equals(method) ||
        "addFirst".equals(method) || "offerFirst".equals(method) ||
        "remove".equals(method) || "clear".equals(method) || "poll".equals(method) ||
        "pollFirst".equals(method) || "removeFirst".equals(method) || "set".equals(method) ||
        "pollLast".equals(method) || "removeLast".equals(method) || "pop".equals(method);
  }

  private static String sequenceAppendWriteHook(int sourceLine, String name, String receiverType, String method, String rawArgs, String callArgs) {
    java.util.List<String> rawParts = splitTopLevel(rawArgs);
    if (rawParts.size() != 1 || callArgs.trim().isEmpty()) return "";
    if (isPriorityQueueType(receiverType) && ("add".equals(method) || "offer".equals(method))) {
      return " TraceHooks.emitCollectionIndexedWritesAtLine(" + sourceLine + ", " + quote(name) + ", " + name + ");";
    }
    String normalizedType = receiverType == null ? "" : normalizeJavaType(receiverType);
    boolean backAppend =
        ("add".equals(method) && isListType(receiverType)) ||
        (("push".equals(method) || "offer".equals(method)) && isQueueLikeType(receiverType)) ||
        (("addLast".equals(method) || "offerLast".equals(method)) && isDequeType(receiverType));
    boolean frontAppend = ("addFirst".equals(method) || "offerFirst".equals(method)) && isDequeType(receiverType);
    if (!backAppend && !frontAppend) return "";
    String index = frontAppend ? "0" : "((" + (normalizedType.contains("List<") ? "java.util.List" : "java.util.Collection") + ") " + name + ").size() - 1";
    return " TraceHooks.emitIndexedWriteAtLine(" + sourceLine + ", " + quote(name) + ", new Object[] { " + index + " }, " + callArgs + ", null);";
  }
  private static int braceDelta(String line) {
    int delta = 0;
    boolean inString = false;
    boolean escaped = false;
    for (int i = 0; i < line.length(); i++) {
      char ch = line.charAt(i);
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch == '\\') {
          escaped = true;
        } else if (ch == '"') {
          inString = false;
        }
        continue;
      }
      if (ch == '"') inString = true;
      if (ch == '{') delta++;
      if (ch == '}') delta--;
    }
    return delta;
  }

  private static int parenDelta(String line) {
    int delta = 0;
    boolean inString = false;
    boolean inChar = false;
    boolean escaped = false;
    for (int i = 0; i < line.length(); i++) {
      char ch = line.charAt(i);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch == '\\') {
        escaped = true;
        continue;
      }
      if (inString) {
        if (ch == '"') inString = false;
        continue;
      }
      if (inChar) {
        if (ch == '\'') inChar = false;
        continue;
      }
      if (ch == '"') {
        inString = true;
        continue;
      }
      if (ch == '\'') {
        inChar = true;
        continue;
      }
      if (ch == '(') delta++;
      if (ch == ')') delta--;
    }
    return delta;
  }

  private static String indentOf(String line) {
    int index = 0;
    while (index < line.length() && Character.isWhitespace(line.charAt(index))) index++;
    return line.substring(0, index);
  }

  private static int firstNonWhitespace(String line) {
    int index = 0;
    while (index < line.length() && Character.isWhitespace(line.charAt(index))) index++;
    return index;
  }

  private static int findMatchingParen(String source, int openParen) {
    int depth = 0;
    boolean inString = false;
    boolean inChar = false;
    boolean escaped = false;
    for (int index = openParen; index < source.length(); index++) {
      char ch = source.charAt(index);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch == '\\') {
        escaped = inString || inChar;
        continue;
      }
      if (inString) {
        if (ch == '"') inString = false;
        continue;
      }
      if (inChar) {
        if (ch == '\'') inChar = false;
        continue;
      }
      if (ch == '"') {
        inString = true;
        continue;
      }
      if (ch == '\'') {
        inChar = true;
        continue;
      }
      if (ch == '(') depth++;
      if (ch == ')') {
        depth--;
        if (depth == 0) return index;
      }
    }
    return -1;
  }

  private static int findTopLevelElse(String source) {
    int parenDepth = 0;
    int bracketDepth = 0;
    int braceDepth = 0;
    boolean inString = false;
    boolean inChar = false;
    boolean escaped = false;
    for (int index = 0; index < source.length(); index++) {
      char ch = source.charAt(index);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch == '\\') {
        escaped = inString || inChar;
        continue;
      }
      if (inString) {
        if (ch == '"') inString = false;
        continue;
      }
      if (inChar) {
        if (ch == '\'') inChar = false;
        continue;
      }
      if (ch == '"') {
        inString = true;
        continue;
      }
      if (ch == '\'') {
        inChar = true;
        continue;
      }
      if (ch == '(') parenDepth++;
      if (ch == ')') parenDepth = Math.max(0, parenDepth - 1);
      if (ch == '[') bracketDepth++;
      if (ch == ']') bracketDepth = Math.max(0, bracketDepth - 1);
      if (ch == '{') braceDepth++;
      if (ch == '}') braceDepth = Math.max(0, braceDepth - 1);
      if (parenDepth == 0 && bracketDepth == 0 && braceDepth == 0 && source.startsWith("else", index)) {
        boolean beforeBoundary = index == 0 || !Character.isJavaIdentifierPart(source.charAt(index - 1));
        boolean afterBoundary = index + 4 >= source.length() || !Character.isJavaIdentifierPart(source.charAt(index + 4));
        if (beforeBoundary && afterBoundary) return index;
      }
    }
    return -1;
  }

  private static boolean isControlKeyword(String value) {
    return "else".equals(value) || "if".equals(value) || "for".equals(value) ||
        "while".equals(value) || "switch".equals(value) || "catch".equals(value) ||
        "finally".equals(value) || "do".equals(value) || "try".equals(value);
  }

  private static boolean startsMultilineMethodHeader(String line) {
    String trimmed = stripTrailingLineComment(line).trim();
    if (trimmed.isEmpty() || trimmed.startsWith("@")) return false;
    if (trimmed.contains("{") || trimmed.endsWith(";")) return false;
    if (trimmed.startsWith("class ") || trimmed.startsWith("interface ") || trimmed.startsWith("enum ") || trimmed.startsWith("record ")) {
      return false;
    }
    if (isControlKeyword(trimmed.split("\\s+", 2)[0])) return false;
    return METHOD_HEADER_START.matcher(trimmed).find();
  }

  private static MethodSignature parseMethodSignature(String source) {
    Matcher method = METHOD_START.matcher(source);
    if (!method.matches()) return null;
    String name = method.group(2);
    return new MethodSignature(method.group(1), name, extractReturnType(source, name), method.group(3));
  }

  private static boolean isEmptyForUpdateClause(String conditionAndUpdateClause) {
    if (conditionAndUpdateClause == null) return false;
    int delimiter = conditionAndUpdateClause.lastIndexOf(';');
    if (delimiter < 0) return false;
    return conditionAndUpdateClause.substring(delimiter + 1).trim().isEmpty();
  }

  private static String quote(String value) {
    return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
  }

  private static String stringArrayLiteral(java.util.List<String> values) {
    StringBuilder out = new StringBuilder("new String[] { ");
    for (int index = 0; index < values.size(); index++) {
      if (index > 0) out.append(", ");
      out.append(quote(values.get(index)));
    }
    out.append(" }");
    return out.toString();
  }

  private static boolean isSimpleIdentifierExpression(String value) {
    return value != null && value.matches("[A-Za-z_][A-Za-z0-9_]*");
  }

  private static String singleIdentifierIndexSource(String value) {
    if (value == null) return null;
    java.util.regex.Matcher identifiers = java.util.regex.Pattern
        .compile("[A-Za-z_][A-Za-z0-9_]*")
        .matcher(value);
    java.util.LinkedHashSet<String> unique = new java.util.LinkedHashSet<>();
    while (identifiers.find()) {
      String name = identifiers.group();
      if (!"TraceHooks".equals(name)) unique.add(name);
    }
    if (unique.size() != 1) return null;
    String stripped = value
        .replaceAll("[A-Za-z_][A-Za-z0-9_]*", "")
        .replaceAll("[0-9]+", "")
        .replaceAll("[+\\-*/%() \\t]", "");
    return stripped.isEmpty() ? unique.iterator().next() : null;
  }

  private static String safeIndexSourceExpression(String value) {
    if (value == null) return null;
    String normalized = value.trim().replaceAll("\\s+", " ");
    if (normalized.isEmpty()) return null;
    if (!java.util.regex.Pattern.compile("[A-Za-z_][A-Za-z0-9_]*").matcher(normalized).find()) return null;
    if (isSimpleIdentifierExpression(normalized)) return normalized;
    java.util.regex.Matcher unaryIndex = java.util.regex.Pattern
        .compile("^(?:\\+\\+|--)\\s*([A-Za-z_][A-Za-z0-9_]*)$|^([A-Za-z_][A-Za-z0-9_]*)\\s*(?:\\+\\+|--)$")
        .matcher(normalized);
    if (unaryIndex.matches()) {
      return unaryIndex.group(1) != null ? unaryIndex.group(1) : unaryIndex.group(2);
    }
    if (normalized.matches("^[A-Za-z_][A-Za-z0-9_]*\\s*\\[[^\\]]+\\]\\s*$")) {
      return normalized.replaceAll("\\s+", "");
    }
    if (normalized.matches("^[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*\\(\\))+(?:\\s*[+\\-*/%]\\s*[0-9]+)?$")) {
      return normalized;
    }
    String stripped = stripJavaLiteralTokens(normalized)
        .replaceAll("[A-Za-z_][A-Za-z0-9_]*", "")
        .replaceAll("[0-9]+", "")
        .replaceAll("[+\\-*/%.() \\t]", "");
    return stripped.isEmpty() ? normalized : null;
  }

  private static String stripJavaLiteralTokens(String value) {
    return value.replaceAll("\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'", "");
  }

  private static String indexSourceArgument(String value) {
    if (value != null) {
      String tracedSource = tracedIndexedReadSource(value.trim());
      if (tracedSource != null) return quote(tracedSource);
      if (value.contains("TraceHooks.")) return "null";
      java.util.regex.Matcher charAtIndex = java.util.regex.Pattern
        .compile("^[A-Za-z_][A-Za-z0-9_]*\\.charAt\\(\\s*([\\s\\S]+)\\s*\\)$")
        .matcher(value.trim());
      if (charAtIndex.matches()) {
        String charAtSource = safeIndexSourceExpression(charAtIndex.group(1));
        if (charAtSource == null) charAtSource = singleIdentifierIndexSource(charAtIndex.group(1));
        if (charAtSource != null) return quote(charAtSource);
      }
      String expressionSource = safeIndexSourceExpression(value.trim());
      if (expressionSource == null) expressionSource = singleIdentifierIndexSource(value.trim());
      if (expressionSource != null) return quote(expressionSource);
    }
    return isSimpleIdentifierExpression(value) ? quote(value) : "null";
  }

  private static boolean isLiteralIndexSource(String value) {
    return value != null && value.trim().matches("^(?:\"(?:\\\\.|[^\"\\\\])*\"|[0-9]+)$");
  }

  private static String tracedIndexedReadSource(String value) {
    if (value == null || !value.startsWith("TraceHooks.read")) return null;
    int open = value.indexOf('(');
    if (open < 0 || !value.endsWith(")")) return null;
    java.util.List<String> args = splitTopLevel(value.substring(open + 1, value.length() - 1));
    if (args.size() < 2) return null;
    java.util.regex.Matcher name = java.util.regex.Pattern
      .compile("^\"([A-Za-z_][A-Za-z0-9_]*)\"$")
      .matcher(args.get(1).trim());
    if (!name.matches()) return null;
    java.util.regex.Matcher explicitSource = java.util.regex.Pattern
      .compile("^\"([^\"]+)\"$")
      .matcher(args.get(args.size() - 1).trim());
    return explicitSource.matches() ? explicitSource.group(1) : name.group(1);
  }

  private static String escapedIndexSourcesTargetSegment(String... values) {
    StringBuilder out = new StringBuilder(",\\\"indexSources\\\":[");
    for (int index = 0; index < values.length; index++) {
      if (index > 0) out.append(",");
      String value = values[index];
      String expressionSource = safeIndexSourceExpression(value);
      if (expressionSource == null) expressionSource = singleIdentifierIndexSource(value);
      if (expressionSource != null) {
        out.append("\\\"").append(expressionSource).append("\\\"");
      } else {
        out.append("null");
      }
    }
    out.append("]");
    return out.toString();
  }

  private static String mutationArgsEventSegment(String rawArgs, int sourceLine, MethodFrame frame) {
    java.util.List<String> args = splitTopLevel(rawArgs == null ? "" : rawArgs.trim());
    if (args.isEmpty()) return ",\\\"args\\\":[]";
    StringBuilder out = new StringBuilder(",\\\"args\\\":[");
    for (int index = 0; index < args.size(); index++) {
      if (index > 0) out.append(",");
      out.append("\" + TraceHooks.serializeResult(")
          .append(rewriteReads(args.get(index), sourceLine, frame))
          .append(") + \"");
    }
    out.append("]");
    return out.toString();
  }

  private static MutatingArgs mutatingArgs(String rawArgs, int sourceLine, MethodFrame frame) {
    java.util.List<String> args = splitTopLevel(rawArgs == null ? "" : rawArgs.trim());
    if (args.isEmpty()) {
      return new MutatingArgs("", "", ",\\\"args\\\":[]");
    }
    java.util.List<String> callArgs = new java.util.ArrayList<>();
    java.util.List<String> eventArgs = new java.util.ArrayList<>();
    StringBuilder prefix = new StringBuilder();
    for (int index = 0; index < args.size(); index++) {
      String rewritten = rewriteReads(args.get(index), sourceLine, frame);
      if (rewritten.contains("TraceHooks.")) {
        String temp = "__tracecodeArg" + sourceLine + "_" + index;
        prefix.append("var ").append(temp).append(" = ").append(rewritten).append("; ");
        callArgs.add(temp);
        eventArgs.add(temp);
      } else {
        callArgs.add(rewritten);
        eventArgs.add(rewritten);
      }
    }
    StringBuilder event = new StringBuilder(",\\\"args\\\":[");
    for (int index = 0; index < eventArgs.size(); index++) {
      if (index > 0) event.append(",");
      event.append("\" + TraceHooks.serializeResult(").append(eventArgs.get(index)).append(") + \"");
    }
    event.append("]");
    return new MutatingArgs(prefix.toString(), String.join(", ", callArgs), event.toString());
  }

  private static final class MutatingArgs {
    final String prefix;
    final String callArgs;
    final String eventSegment;

    MutatingArgs(String prefix, String callArgs, String eventSegment) {
      this.prefix = prefix;
      this.callArgs = callArgs;
      this.eventSegment = eventSegment;
    }
  }

  private static final class PendingMultilineMutation {
    final String indent;
    final int sourceLine;
    final String name;
    final String method;
    final StringBuilder callSource;

    PendingMultilineMutation(String indent, int sourceLine, String name, String method) {
      this.indent = indent;
      this.sourceLine = sourceLine;
      this.name = name;
      this.method = method;
      this.callSource = new StringBuilder();
    }

    void appendLine(String line) {
      if (callSource.length() > 0) callSource.append('\n');
      callSource.append(line);
    }

    String emitHook(MethodFrame frame) {
      String args = rawArgs();
      return indent + "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"mutate\\\",\\\"line\\\":" + sourceLine +
          ",\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\"},\\\"method\\\":\\\"" + method + "\\\"" +
          mutationArgsEventSegment(args, sourceLine, frame) + "}\"); TraceHooks.emitRuntimeSnapshotAtLine(" +
          sourceLine + ", " + quote(name) + ", " + name + ");";
    }

    private String rawArgs() {
      String source = callSource.toString();
      int open = source.indexOf('(');
      int close = source.lastIndexOf(')');
      if (open < 0 || close <= open) return "";
      return source.substring(open + 1, close).trim();
    }
  }

  private static final class PendingMethodHeader {
    final StringBuilder header;
    final int startLine;

    PendingMethodHeader(String line, int startLine) {
      this.header = new StringBuilder(line);
      this.startLine = startLine;
    }

    void appendLine(String line) {
      header.append('\n').append(line);
    }

    String source() {
      return header.toString();
    }
  }

  private static final class MethodSignature {
    final String indent;
    final String name;
    final String returnType;
    final String parametersSource;

    MethodSignature(String indent, String name, String returnType, String parametersSource) {
      this.indent = indent;
      this.name = name;
      this.returnType = returnType;
      this.parametersSource = parametersSource;
    }
  }

  private static final class MethodFrame {
    final String name;
    final String returnType;
    int depth;
    int initializerDepth;
    int headerParenDepth;
    int expressionParenDepth;
    boolean pendingAnnotation;
    boolean suppressNextLineHook;
    boolean statementContinuation;
    PendingMultilineMutation pendingMultilineMutation;
    final java.util.Set<String> fields;
    final Map<String, String> variables;

    MethodFrame(String name, String returnType, int depth, Map<String, String> fields, String parametersSource) {
      this.name = name;
      this.returnType = returnType == null || returnType.isBlank() ? "var" : returnType;
      this.depth = depth;
      this.initializerDepth = 0;
      this.headerParenDepth = 0;
      this.expressionParenDepth = 0;
      this.pendingAnnotation = false;
      this.suppressNextLineHook = false;
      this.statementContinuation = false;
      this.pendingMultilineMutation = null;
      this.fields = new java.util.HashSet<>(fields.keySet());
      this.variables = new HashMap<>(fields);
      registerParameters(this.variables, parametersSource);
    }

    String typeOf(String variable) {
      return variables.get(variable);
    }

    boolean isField(String variable) {
      return fields.contains(variable);
    }

    String returnTypeOrVar() {
      return "void".equals(returnType) ? "var" : returnType;
    }
  }

  private interface Replacer {
    String replace(Matcher matcher);
  }
}

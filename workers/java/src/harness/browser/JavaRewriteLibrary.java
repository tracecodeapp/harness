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
  private static final Pattern METHOD_START = Pattern.compile(
      "^(\\s*)(?:(?:public|private|protected|static|final|synchronized)\\s+)*(?:[A-Za-z_][A-Za-z0-9_<>, ?]*(?:\\s*\\[\\])*\\s+)+([A-Za-z_][A-Za-z0-9_]*)\\s*\\(([^)]*)\\)\\s*\\{\\s*$");
  private static final Pattern RETURN_STMT = Pattern.compile("^(\\s*)return(?:\\s+(.+?))?;\\s*$");
  private static final Pattern ARRAY_WRITE_2D = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]]+)\\]\\s*\\[([^;\\]]+)\\]\\s*=\\s*(.+);\\s*$");
  private static final Pattern ARRAY_WRITE_1D = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]]+)\\]\\s*=\\s*(.+);\\s*$");
  private static final Pattern ARRAY_COMPOUND_WRITE_2D = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]]+)\\]\\s*\\[([^;\\]]+)\\]\\s*([+\\-*/%&|^]|<<|>>|>>>)=\\s*(.+);\\s*$");
  private static final Pattern ARRAY_COMPOUND_WRITE_1D = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]]+)\\]\\s*([+\\-*/%&|^]|<<|>>|>>>)=\\s*(.+);\\s*$");
  private static final Pattern STRING_CHAR_AT = Pattern.compile("\\b([A-Za-z_][A-Za-z0-9_]*)\\.charAt\\(([^()]+)\\)");
  private static final Pattern FIELD_WRITE = Pattern.compile("^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.+);\\s*$");
  private static final Pattern FIELD_READ = Pattern.compile("(?<!\\.)\\b(?!System\\b|TraceHooks\\b)([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\b(?!\\s*\\()");
  private static final Pattern FIELD_DECLARATION = Pattern.compile(
      "^\\s*(?:public|private|protected|static|final|transient|volatile|\\s)*([A-Za-z_][A-Za-z0-9_<>?, ]*(?:\\s*\\[\\])*)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*(?:=\\s*.+)?;\\s*$");
  private static final Pattern LOCAL_DECLARATION = Pattern.compile(
      "^(\\s*)(?:final\\s+)?([A-Za-z_][A-Za-z0-9_<>?, ]*(?:\\s*\\[\\])*)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.+);\\s*$");
  private static final Pattern MUTATING_CALL_STATEMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)\\);\\s*$");
  private static final Pattern FIELD_INDEXED_MUTATING_CALL_STATEMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\.get\\(([^()\\n;]+)\\)\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)\\);\\s*$");
  private static final Pattern FIELD_MUTATING_CALL_STATEMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)\\);\\s*$");
  private static final Pattern COMPUTE_IF_ABSENT_MUTATING_CALL_STATEMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\.computeIfAbsent\\((.+),\\s*([^;]+)\\)\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)\\);\\s*$");
  private static final Pattern INDEXED_MUTATING_CALL_STATEMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\.get\\(([^()\\n;]+)\\)\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)\\);\\s*$");
  private static final Pattern ARRAY_INDEXED_MUTATING_CALL_STATEMENT = Pattern.compile(
      "^(\\s*)([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]\\[]+)\\]\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)\\);\\s*$");
  private static final Pattern MUTATING_CALL_EXPRESSION = Pattern.compile(
      "^([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)\\((.*)\\)$");
  private static final Pattern MATRIX_READ = Pattern.compile("(?<!\\.)\\b([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]\\[]+)\\]\\s*\\[([^;\\]\\[]+)\\]");
  private static final Pattern ARRAY_READ = Pattern.compile("(?<!\\.)\\b([A-Za-z_][A-Za-z0-9_]*)\\s*\\[([^;\\]\\[]+)\\]");

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
    return source.replaceAll("(^|\\n)\\s*public\\s+class\\s+", "$1class ");
  }

  private static String rewriteJava(String source) {
    StringBuilder out = new StringBuilder();
    out.append("import tracecode.user.TraceHooks;\n");
    String[] lines = source.split("\\r?\\n", -1);
    Deque<MethodFrame> methods = new ArrayDeque<>();
    Map<String, String> fields = new HashMap<>();

    for (int index = 0; index < lines.length; index++) {
      String line = lines[index];
      int sourceLine = index + 1;
      Matcher method = METHOD_START.matcher(line);
      if (method.matches()) {
        out.append(line).append('\n');
        String name = method.group(2);
        methods.push(new MethodFrame(name, braceDelta(line), fields, method.group(3)));
        out.append(method.group(1)).append("  TraceHooks.emitCallAtLine(")
            .append(sourceLine).append(", ").append(quote(name)).append(", \"\");\n");
        continue;
      }

      MethodFrame current = methods.peek();
      if (current == null) {
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
        out.append(line).append('\n');
        current.initializerDepth = Math.max(0, current.initializerDepth + braceDelta(line));
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

      if (!current.pendingAnnotation && shouldEmitLine(trimmed)) {
        out.append(indentOf(line)).append("TraceHooks.emitLineAtLine(").append(sourceLine).append(");\n");
      }

      String rewrittenLine = rewriteStatement(line, sourceLine, current);
      out.append(rewrittenLine).append('\n');
      current.pendingAnnotation = false;
      if (startsMultilineControlHeader(trimmed)) {
        current.headerParenDepth = Math.max(0, parenDelta(line));
      }

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
    Matcher returnMatch = RETURN_STMT.matcher(line);
    if (returnMatch.matches()) {
      String indent = returnMatch.group(1);
      String expression = returnMatch.group(2);
      StringBuilder out = new StringBuilder();
      out.append(indent).append("TraceHooks.emitReturnAtLine(").append(sourceLine).append(", ").append(quote(frame.name)).append(");\n");
      if (expression == null || expression.trim().isEmpty()) {
        out.append(indent).append("return;");
      } else {
        out.append(indent).append("return ").append(rewriteReads(expression.trim(), sourceLine, frame)).append(';');
      }
      return out.toString();
    }

    Matcher declaration = LOCAL_DECLARATION.matcher(line);
    if (declaration.matches() && !line.trim().startsWith("for ")) {
      String indent = declaration.group(1);
      String type = declaration.group(2).trim();
      String name = declaration.group(3);
      frame.variables.put(name, normalizeJavaType(type));
      String value = rewriteReads(declaration.group(4).trim(), sourceLine, frame);
      String prefix = line.substring(0, declaration.start(3));
      String rewritten = prefix + name + " = " + value + ";";
      Matcher mutatingExpression = MUTATING_CALL_EXPRESSION.matcher(declaration.group(4).trim());
      if (mutatingExpression.matches() && isTrackedMutationMethod(mutatingExpression.group(2))) {
        rewritten += " TraceHooks.emitMutatingCallAtLine(" + sourceLine + ", " +
            quote(mutatingExpression.group(1)) + ", " + quote(normalizeMutationMethod(mutatingExpression.group(2))) + ");";
      }
      if (isScalarSnapshotType(type)) {
        rewritten += "\n" + indent + "TraceHooks.emitLineAtLine(" + sourceLine + ", \" "+ name + "=\" + TraceHooks.serializeResult(" + name + "));";
      }
      return rewritten;
    }

    Matcher fieldWrite = FIELD_WRITE.matcher(line);
    if (fieldWrite.matches()) {
      String indent = fieldWrite.group(1);
      String name = fieldWrite.group(2);
      String field = fieldWrite.group(3);
      String value = rewriteReads(fieldWrite.group(4).trim(), sourceLine, frame);
      return indent + name + "." + field + " = " + value + "; TraceHooks.emitFieldWriteAtLine(" + sourceLine + ", " + quote(name) + ", " + quote(field) + ", " + name + "." + field + ");";
    }

    Matcher fieldIndexedMutatingCall = FIELD_INDEXED_MUTATING_CALL_STATEMENT.matcher(line);
    if (fieldIndexedMutatingCall.matches() && isTrackedMutationMethod(fieldIndexedMutatingCall.group(5))) {
      String indent = fieldIndexedMutatingCall.group(1);
      String name = fieldIndexedMutatingCall.group(2);
      String field = fieldIndexedMutatingCall.group(3);
      String index = rewriteReads(fieldIndexedMutatingCall.group(4).trim(), sourceLine, frame);
      String method = fieldIndexedMutatingCall.group(5);
      String args = rewriteReads(fieldIndexedMutatingCall.group(6).trim(), sourceLine, frame);
      String target = name + "." + field + ".get(" + index + ")";
      String pathPrefix = "\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[\\\"" + field + "\\\",";
      String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + (" + index + ") + \"]},\\\"value\\\":\" + TraceHooks.serializeResult(" + target + ") + \"}\");";
      String mutateEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"mutate\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + (" + index + ") + \"]},\\\"method\\\":\\\"" + normalizeMutationMethod(method) + "\\\"}\");";
      return indent + "{ " + readEvent + " " + target + "." + method + "(" + args + "); " + mutateEvent + " }";
    }

    Matcher fieldMutatingCall = FIELD_MUTATING_CALL_STATEMENT.matcher(line);
    if (fieldMutatingCall.matches() && isTrackedMutationMethod(fieldMutatingCall.group(4))) {
      String indent = fieldMutatingCall.group(1);
      String name = fieldMutatingCall.group(2);
      String field = fieldMutatingCall.group(3);
      String method = fieldMutatingCall.group(4);
      String args = rewriteReads(fieldMutatingCall.group(5).trim(), sourceLine, frame);
      String target = name + "." + field;
      String pathPrefix = "\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[\\\"" + field + "\\\"]}";
      String mutateEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"mutate\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + ",\\\"method\\\":\\\"" + normalizeMutationMethod(method) + "\\\"}\");";
      return indent + "{ " + target + "." + method + "(" + args + "); " + mutateEvent + " }";
    }

    Matcher computeMutatingCall = COMPUTE_IF_ABSENT_MUTATING_CALL_STATEMENT.matcher(line);
    if (computeMutatingCall.matches() && isTrackedMutationMethod(computeMutatingCall.group(5))) {
      String indent = computeMutatingCall.group(1);
      String name = computeMutatingCall.group(2);
      String key = rewriteReads(computeMutatingCall.group(3).trim(), sourceLine, frame);
      String fallback = computeMutatingCall.group(4).trim();
      String method = computeMutatingCall.group(5);
      String args = rewriteReads(computeMutatingCall.group(6).trim(), sourceLine, frame);
      String target = name + ".computeIfAbsent(" + key + ", " + fallback + ")";
      String pathPrefix = "\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[";
      String mutateEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"mutate\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + TraceHooks.serializeResult(" + key + ") + \"]},\\\"method\\\":\\\"" + normalizeMutationMethod(method) + "\\\"}\");";
      return indent + "{ " + target + "." + method + "(" + args + "); " + mutateEvent + " }";
    }

    Matcher indexedMutatingCall = INDEXED_MUTATING_CALL_STATEMENT.matcher(line);
    if (indexedMutatingCall.matches() && isTrackedMutationMethod(indexedMutatingCall.group(4))) {
      String indent = indexedMutatingCall.group(1);
      String name = indexedMutatingCall.group(2);
      String index = rewriteReads(indexedMutatingCall.group(3).trim(), sourceLine, frame);
      String method = indexedMutatingCall.group(4);
      String args = rewriteReads(indexedMutatingCall.group(5).trim(), sourceLine, frame);
      String temp = "__tracecodeIndexedTarget" + sourceLine;
      String target = indexedAccessExpression(name, frame.typeOf(name), index);
      String pathPrefix = "\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[";
      String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + TraceHooks.serializeResult(" + index + ") + \"]},\\\"value\\\":\" + TraceHooks.serializeResult(" + temp + ") + \"}\");";
      String mutateEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"mutate\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + TraceHooks.serializeResult(" + index + ") + \"]},\\\"method\\\":\\\"" + normalizeMutationMethod(method) + "\\\"}\");";
      return indent + "{ var " + temp + " = " + target + "; " + readEvent + " " + temp + "." + method + "(" + args + "); " + mutateEvent + " }";
    }

    Matcher arrayIndexedMutatingCall = ARRAY_INDEXED_MUTATING_CALL_STATEMENT.matcher(line);
    if (arrayIndexedMutatingCall.matches() && isTrackedMutationMethod(arrayIndexedMutatingCall.group(4))) {
      String indent = arrayIndexedMutatingCall.group(1);
      String name = arrayIndexedMutatingCall.group(2);
      String index = rewriteReads(arrayIndexedMutatingCall.group(3).trim(), sourceLine, frame);
      String method = arrayIndexedMutatingCall.group(4);
      String args = rewriteReads(arrayIndexedMutatingCall.group(5).trim(), sourceLine, frame);
      String target = name + "[" + index + "]";
      String pathPrefix = "\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[";
      String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + TraceHooks.serializeResult(" + index + ") + \"]},\\\"value\\\":\" + TraceHooks.serializeResult(" + target + ") + \"}\");";
      String mutateEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"mutate\\\",\\\"line\\\":" + sourceLine + "," +
          pathPrefix + "\" + TraceHooks.serializeResult(" + index + ") + \"]},\\\"method\\\":\\\"" + normalizeMutationMethod(method) + "\\\"}\");";
      return indent + "{ " + readEvent + " " + target + "." + method + "(" + args + "); " + mutateEvent + " }";
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
      String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + ",\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[\" + TraceHooks.serializeResult(" + row + ") + \",\" + TraceHooks.serializeResult(" + col + ") + \"]},\\\"value\\\":\" + TraceHooks.serializeResult(" + target + ") + \"}\");";
      return indent + readEvent + " " + target + " " + operator + "= " + value + "; TraceHooks.emitArrayWriteAtLine(" + sourceLine + ", " + quote(name) + ", " + row + ", " + col + ", " + target + ");";
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
      String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + ",\\\"target\\\":{\\\"variable\\\":\\\"" + name + "\\\",\\\"path\\\":[\" + TraceHooks.serializeResult(" + idx + ") + \"]},\\\"value\\\":\" + TraceHooks.serializeResult(" + target + ") + \"}\");";
      return indent + readEvent + " " + target + " " + operator + "= " + value + "; TraceHooks.emitArrayWriteAtLine(" + sourceLine + ", " + quote(name) + ", " + idx + ", " + target + ");";
    }

    Matcher write2d = ARRAY_WRITE_2D.matcher(line);
    if (write2d.matches()) {
      String indent = write2d.group(1);
      String name = write2d.group(2);
      String row = write2d.group(3).trim();
      String col = write2d.group(4).trim();
      if (hasIndexSideEffect(row) || hasIndexSideEffect(col)) {
        return rewriteReads(line, sourceLine, frame);
      }
      String value = rewriteReads(write2d.group(5).trim(), sourceLine, frame);
      return indent + name + "[" + row + "][" + col + "] = " + value + "; TraceHooks.emitArrayWriteAtLine(" + sourceLine + ", " + quote(name) + ", " + row + ", " + col + ", " + name + "[" + row + "][" + col + "]);";
    }

    Matcher write1d = ARRAY_WRITE_1D.matcher(line);
    if (write1d.matches()) {
      String indent = write1d.group(1);
      String name = write1d.group(2);
      String idx = write1d.group(3).trim();
      if (hasIndexSideEffect(idx)) {
        return rewriteReads(line, sourceLine, frame);
      }
      String value = rewriteReads(write1d.group(4).trim(), sourceLine, frame);
      return indent + name + "[" + idx + "] = " + value + "; TraceHooks.emitArrayWriteAtLine(" + sourceLine + ", " + quote(name) + ", " + idx + ", " + name + "[" + idx + "]);";
    }

    Matcher mutatingCall = MUTATING_CALL_STATEMENT.matcher(line);
    if (mutatingCall.matches() && isTrackedMutationMethod(mutatingCall.group(3))) {
      String indent = mutatingCall.group(1);
      String name = mutatingCall.group(2);
      String method = mutatingCall.group(3);
      String args = rewriteReads(mutatingCall.group(4).trim(), sourceLine, frame);
      if (frame.isField(name)) {
        String pathPrefix = "\\\"target\\\":{\\\"variable\\\":\\\"this\\\",\\\"path\\\":[\\\"" + name + "\\\"]}";
        String readEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"read\\\",\\\"line\\\":" + sourceLine + "," +
            pathPrefix + ",\\\"value\\\":\" + TraceHooks.serializeResult(" + name + ") + \"}\");";
        String mutateEvent = "TraceHooks.emit(\"trace:{\\\"kind\\\":\\\"mutate\\\",\\\"line\\\":" + sourceLine + "," +
            pathPrefix + ",\\\"method\\\":\\\"" + normalizeMutationMethod(method) + "\\\"}\");";
        return indent + "{ " + readEvent + " " + name + "." + method + "(" + args + "); " + mutateEvent + " }";
      }
      return indent + name + "." + method + "(" + args + "); TraceHooks.emitMutatingCallAtLine(" + sourceLine + ", " + quote(name) + ", " + quote(normalizeMutationMethod(method)) + ");";
    }

    return rewriteReads(line, sourceLine, frame);
  }

  private static String rewriteReads(String source, int line, MethodFrame frame) {
    String next = replaceAll(STRING_CHAR_AT, source, match ->
        "TraceHooks.readStringCharAtLine(" + line + ", " + quote(match.group(1)) + ", " + match.group(1) + ", " + match.group(2).trim() + ")");
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
      return "TraceHooks." + helper + "(" + line + ", " + quote(name) + ", " + name + ", " + match.group(2).trim() + ", " + match.group(3).trim() + ")";
    });
    final String arrayReadSource = next;
    next = replaceAll(ARRAY_READ, next, match -> {
      String full = match.group(0);
      if (full.contains("TraceHooks.")) return full;
      if (isArrayAllocationTypeMatch(arrayReadSource, match.start())) return full;
      if (isArrayWriteTarget(arrayReadSource, match.start(), match.end())) return full;
      String name = match.group(1);
      String helper = arrayReadHelper(frame.typeOf(name));
      if (helper == null) return full;
      return "TraceHooks." + helper + "(" + line + ", " + quote(name) + ", " + name + ", " + match.group(2).trim() + ")";
    });
    next = replaceAll(FIELD_READ, next, match -> {
      String full = match.group(0);
      if (full.contains("TraceHooks.")) return full;
      String name = match.group(1);
      String field = match.group(2);
      if ("java".equals(name) || Character.isUpperCase(name.charAt(0)) || "out".equals(field) || "err".equals(field) || "length".equals(field)) return full;
      return "TraceHooks.readObjectFieldAtLine(" + line + ", " + quote(name) + ", " + quote(field) + ", " + name + "." + field + ")";
    });
    return next;
  }

  private static void registerFieldDeclaration(Map<String, String> fields, String line) {
    Matcher field = FIELD_DECLARATION.matcher(line);
    if (field.matches()) {
      fields.put(field.group(2), normalizeJavaType(field.group(1)));
    }
  }

  private static boolean startsMultilineInitializer(String trimmed) {
    return trimmed.contains("{") && !trimmed.contains(";") &&
        !trimmed.startsWith("if ") && !trimmed.startsWith("for ") && !trimmed.startsWith("while ") &&
        !trimmed.startsWith("switch ") && !trimmed.startsWith("try") && !trimmed.startsWith("catch") &&
        !trimmed.startsWith("finally") && !trimmed.startsWith("else") && !trimmed.startsWith("do ");
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

  private static boolean hasIndexSideEffect(String source) {
    return source.contains("++") || source.contains("--");
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
    if ("char".equals(element)) return "readCharMatrixAtLine";
    return "readObjectMatrixAtLine";
  }

  private static String indexedAccessExpression(String name, String type, String index) {
    String normalized = type == null ? "" : normalizeJavaType(type);
    if (normalized.contains("Map")) {
      return "((java.util.Collection)((java.util.Map)" + name + ").get(" + index + "))";
    }
    return "((java.util.Collection)((java.util.List)" + name + ").get(" + index + "))";
  }

  private static String normalizeJavaType(String type) {
    return type.trim().replaceAll("\\s+", " ").replaceAll("\\s*\\[\\s*\\]", "[]");
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
    for (int index = 0; index < source.length(); index++) {
      char ch = source.charAt(index);
      if (ch == '<') angleDepth++;
      if (ch == '>') angleDepth = Math.max(0, angleDepth - 1);
      if (ch == ',' && angleDepth == 0) {
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

  private static boolean shouldEmitLine(String trimmed) {
    if (trimmed.isEmpty()) return false;
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return false;
    if (trimmed.startsWith("{") || trimmed.equals("}")) return false;
    if (trimmed.startsWith("}")) return false;
    if (trimmed.startsWith(".")) return false;
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
        "addLast".equals(method) || "offerLast".equals(method) || "put".equals(method) ||
        "addFirst".equals(method) || "offerFirst".equals(method) ||
        "remove".equals(method) || "clear".equals(method) || "poll".equals(method) ||
        "pollFirst".equals(method) || "removeFirst".equals(method) ||
        "pollLast".equals(method) || "removeLast".equals(method) || "pop".equals(method);
  }

  private static String normalizeMutationMethod(String method) {
    if ("add".equals(method) || "push".equals(method) || "offer".equals(method) ||
        "addLast".equals(method) || "offerLast".equals(method)) {
      return "append";
    }
    if ("addFirst".equals(method) || "offerFirst".equals(method)) {
      return "appendleft";
    }
    if ("poll".equals(method) || "pollFirst".equals(method) || "removeFirst".equals(method)) {
      return "popleft";
    }
    if ("pollLast".equals(method) || "removeLast".equals(method)) {
      return "pop";
    }
    if ("put".equals(method)) {
      return "set";
    }
    return method;
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

  private static String quote(String value) {
    return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
  }

  private static final class MethodFrame {
    final String name;
    int depth;
    int initializerDepth;
    int headerParenDepth;
    boolean pendingAnnotation;
    final java.util.Set<String> fields;
    final Map<String, String> variables;

    MethodFrame(String name, int depth, Map<String, String> fields, String parametersSource) {
      this.name = name;
      this.depth = depth;
      this.initializerDepth = 0;
      this.headerParenDepth = 0;
      this.pendingAnnotation = false;
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
  }

  private interface Replacer {
    String replace(Matcher matcher);
  }
}

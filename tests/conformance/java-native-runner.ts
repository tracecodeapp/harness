import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface JavaConformanceFixture {
  id: string;
  title: string;
  entryStyle: string;
  methodName: string;
  source: string;
  input: Record<string, unknown>;
  expectedReturn: unknown;
  expectedMutations: Record<string, unknown>;
  expectedHarnessOutput?: unknown;
  coverage: string[];
  notes: string;
}

export interface JavaExecutionResult {
  success: boolean;
  output?: unknown;
  mutations?: Record<string, unknown>;
  error?: string;
}

export interface JavaConformanceRunResult {
  success: boolean;
  expectedOutput: unknown;
  untraced?: JavaExecutionResult;
  phase?: 'compile' | 'untraced' | 'mutations';
  error?: string;
}

function normalizeForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeForJson(child)])
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForJson(value));
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

const JAVA_REFLECTION_RUNNER = String.raw`
public class TracecodeRunner {
  public static void main(String[] args) throws Exception {
    String methodName = args[0];
    String json = new String(java.util.Base64.getDecoder().decode(args[1]), java.nio.charset.StandardCharsets.UTF_8);
    Object parsed = Json.parse(json);
    if (!(parsed instanceof java.util.Map)) throw new IllegalArgumentException("input must be a JSON object");
    @SuppressWarnings("unchecked")
    java.util.LinkedHashMap<String, Object> input = (java.util.LinkedHashMap<String, Object>) parsed;
    java.util.LinkedHashMap<String, Object> result = execute(methodName, input);
    System.out.println(Json.stringify(result));
  }

  static java.util.LinkedHashMap<String, Object> execute(String methodName, java.util.LinkedHashMap<String, Object> input) throws Exception {
    Class<?> solutionClass = Class.forName("Solution");
    java.lang.reflect.Method method = selectMethod(solutionClass, methodName, input);
    Object receiver = java.lang.reflect.Modifier.isStatic(method.getModifiers()) ? null : solutionClass.getDeclaredConstructor().newInstance();
    Object[] args = hydrateArgs(method, input);
    method.setAccessible(true);
    Object output = method.invoke(receiver, args);
    java.util.LinkedHashMap<String, Object> postInputs = new java.util.LinkedHashMap<>();
    java.lang.reflect.Parameter[] params = method.getParameters();
    for (int i = 0; i < params.length; i++) {
      String key = params[i].getName();
      if (!input.containsKey(key) && params.length == 1 && input.size() == 1) key = input.keySet().iterator().next();
      postInputs.put(key, serialize(args[i]));
    }
    java.util.LinkedHashMap<String, Object> out = new java.util.LinkedHashMap<>();
    out.put("output", serialize(output));
    out.put("mutations", postInputs);
    return out;
  }

  static java.lang.reflect.Method selectMethod(Class<?> solutionClass, String methodName, java.util.LinkedHashMap<String, Object> input) {
    java.util.ArrayList<java.lang.reflect.Method> methods = new java.util.ArrayList<>();
    for (java.lang.reflect.Method method : solutionClass.getDeclaredMethods()) {
      if (method.getName().equals(methodName)) methods.add(method);
    }
    methods.sort((a, b) -> Integer.compare(scoreMethod(b, input), scoreMethod(a, input)));
    if (methods.isEmpty() || scoreMethod(methods.get(0), input) < 0) {
      throw new IllegalArgumentException("Method Solution." + methodName + " not found for input keys " + input.keySet());
    }
    return methods.get(0);
  }

  static int scoreMethod(java.lang.reflect.Method method, java.util.LinkedHashMap<String, Object> input) {
    java.lang.reflect.Parameter[] params = method.getParameters();
    if (params.length != input.size()) return -1;
    int score = 0;
    for (int i = 0; i < params.length; i++) {
      java.lang.reflect.Parameter param = params[i];
      String key = param.getName();
      if (!input.containsKey(key)) {
        if (!(params.length == 1 && input.size() == 1)) return -1;
        key = input.keySet().iterator().next();
      }
      int paramScore = scoreType(param.getParameterizedType(), input.get(key));
      if (paramScore < 0) return -1;
      score += paramScore;
    }
    return score;
  }

  static int scoreType(java.lang.reflect.Type type, Object value) {
    Class<?> raw = rawClass(type);
    if (value == null) return raw.isPrimitive() ? -1 : 1;
    if (raw == Object.class) return 1;
    if (raw == String.class) return value instanceof String ? 20 : -1;
    if (raw == StringBuilder.class) return value instanceof String ? 20 : -1;
    if (raw == char.class || raw == Character.class) return value instanceof String && ((String) value).length() == 1 ? 20 : -1;
    if (raw == boolean.class || raw == Boolean.class) return value instanceof Boolean ? 20 : -1;
    if (isNumeric(raw)) return value instanceof Number ? 20 : -1;
    if (raw.isEnum()) return value instanceof String ? 20 : -1;
    if (raw.isArray()) return value instanceof java.util.List ? 25 + scoreType(raw.getComponentType(), firstListValue(value)) : -1;
    if (java.util.Collection.class.isAssignableFrom(raw)) return value instanceof java.util.List ? 25 + scoreType(firstTypeArgument(type), firstListValue(value)) : -1;
    if (java.util.Map.class.isAssignableFrom(raw)) return value instanceof java.util.Map ? 25 : -1;
    return value instanceof java.util.Map ? 30 : -1;
  }

  static Object firstListValue(Object value) {
    java.util.List<?> list = (java.util.List<?>) value;
    return list.isEmpty() ? null : list.get(0);
  }

  static boolean isNumeric(Class<?> raw) {
    return raw == byte.class || raw == Byte.class || raw == short.class || raw == Short.class || raw == int.class || raw == Integer.class ||
      raw == long.class || raw == Long.class || raw == float.class || raw == Float.class || raw == double.class || raw == Double.class;
  }

  static Object[] hydrateArgs(java.lang.reflect.Method method, java.util.LinkedHashMap<String, Object> input) throws Exception {
    java.lang.reflect.Parameter[] params = method.getParameters();
    Object[] out = new Object[params.length];
    for (int i = 0; i < params.length; i++) {
      String key = params[i].getName();
      if (!input.containsKey(key) && params.length == 1 && input.size() == 1) key = input.keySet().iterator().next();
      out[i] = hydrate(input.get(key), params[i].getParameterizedType());
    }
    return out;
  }

  static Object hydrate(Object value, java.lang.reflect.Type type) throws Exception {
    Class<?> raw = rawClass(type);
    if (value == null) return null;
    if (raw == Object.class) return value;
    if (raw == String.class) return String.valueOf(value);
    if (raw == StringBuilder.class) return new StringBuilder(String.valueOf(value));
    if (raw == char.class || raw == Character.class) return ((String) value).charAt(0);
    if (raw == boolean.class || raw == Boolean.class) return ((Boolean) value).booleanValue();
    if (raw == byte.class || raw == Byte.class) return ((Number) value).byteValue();
    if (raw == short.class || raw == Short.class) return ((Number) value).shortValue();
    if (raw == int.class || raw == Integer.class) return ((Number) value).intValue();
    if (raw == long.class || raw == Long.class) return ((Number) value).longValue();
    if (raw == float.class || raw == Float.class) return ((Number) value).floatValue();
    if (raw == double.class || raw == Double.class) return ((Number) value).doubleValue();
    if (raw.isEnum()) {
      @SuppressWarnings({"unchecked", "rawtypes"})
      Object enumValue = java.lang.Enum.valueOf((Class<? extends java.lang.Enum>) raw, String.valueOf(value));
      return enumValue;
    }
    if (raw.isArray()) {
      java.util.List<?> list = (java.util.List<?>) value;
      Class<?> component = raw.getComponentType();
      Object array = java.lang.reflect.Array.newInstance(component, list.size());
      for (int i = 0; i < list.size(); i++) java.lang.reflect.Array.set(array, i, hydrate(list.get(i), component));
      return array;
    }
    if (java.util.Collection.class.isAssignableFrom(raw)) {
      java.util.Collection<Object> out = createCollection(raw);
      java.lang.reflect.Type elementType = firstTypeArgument(type);
      for (Object item : (java.util.List<?>) value) out.add(hydrate(item, elementType));
      return out;
    }
    if (java.util.Map.class.isAssignableFrom(raw)) {
      java.util.Map<Object, Object> out = createMap(raw);
      java.lang.reflect.Type keyType = typeArgument(type, 0);
      java.lang.reflect.Type valueType = typeArgument(type, 1);
      for (java.util.Map.Entry<?, ?> entry : ((java.util.Map<?, ?>) value).entrySet()) {
        out.put(hydrate(entry.getKey(), keyType), hydrate(entry.getValue(), valueType));
      }
      return out;
    }
    return hydrateObject((java.util.Map<?, ?>) value, raw);
  }

  static Object hydrateObject(java.util.Map<?, ?> value, Class<?> raw) throws Exception {
    java.lang.reflect.Constructor<?> ctor = raw.getDeclaredConstructor();
    ctor.setAccessible(true);
    Object instance = ctor.newInstance();
    for (java.util.Map.Entry<?, ?> entry : value.entrySet()) {
      String key = String.valueOf(entry.getKey());
      java.lang.reflect.Field field = findField(raw, key);
      if (field != null) {
        field.setAccessible(true);
        field.set(instance, hydrate(entry.getValue(), field.getGenericType()));
        continue;
      }
      java.lang.reflect.Method setter = findSetter(raw, key);
      if (setter != null) {
        setter.setAccessible(true);
        setter.invoke(instance, hydrate(entry.getValue(), setter.getGenericParameterTypes()[0]));
      }
    }
    return instance;
  }

  static java.lang.reflect.Field findField(Class<?> raw, String name) {
    Class<?> current = raw;
    while (current != null && current != Object.class) {
      try { return current.getDeclaredField(name); } catch (NoSuchFieldException _e) { current = current.getSuperclass(); }
    }
    return null;
  }

  static java.lang.reflect.Method findSetter(Class<?> raw, String key) {
    String name = "set" + Character.toUpperCase(key.charAt(0)) + key.substring(1);
    for (java.lang.reflect.Method method : raw.getMethods()) {
      if (method.getName().equals(name) && method.getParameterCount() == 1) return method;
    }
    return null;
  }

  static java.util.Collection<Object> createCollection(Class<?> raw) throws Exception {
    if (raw.isInterface() || java.lang.reflect.Modifier.isAbstract(raw.getModifiers())) return new java.util.ArrayList<>();
    @SuppressWarnings("unchecked")
    java.util.Collection<Object> out = (java.util.Collection<Object>) raw.getDeclaredConstructor().newInstance();
    return out;
  }

  static java.util.Map<Object, Object> createMap(Class<?> raw) throws Exception {
    if (raw == java.util.SortedMap.class || raw == java.util.NavigableMap.class || raw == java.util.TreeMap.class) return new java.util.TreeMap<>();
    if (raw == java.util.LinkedHashMap.class) return new java.util.LinkedHashMap<>();
    if (raw.isInterface() || java.lang.reflect.Modifier.isAbstract(raw.getModifiers())) return new java.util.LinkedHashMap<>();
    @SuppressWarnings("unchecked")
    java.util.Map<Object, Object> out = (java.util.Map<Object, Object>) raw.getDeclaredConstructor().newInstance();
    return out;
  }

  static java.lang.reflect.Type firstTypeArgument(java.lang.reflect.Type type) {
    return typeArgument(type, 0);
  }

  static java.lang.reflect.Type typeArgument(java.lang.reflect.Type type, int index) {
    if (type instanceof java.lang.reflect.ParameterizedType) {
      java.lang.reflect.Type[] args = ((java.lang.reflect.ParameterizedType) type).getActualTypeArguments();
      if (index < args.length) return args[index];
    }
    return Object.class;
  }

  static Class<?> rawClass(java.lang.reflect.Type type) {
    if (type instanceof Class<?>) return (Class<?>) type;
    if (type instanceof java.lang.reflect.ParameterizedType) return rawClass(((java.lang.reflect.ParameterizedType) type).getRawType());
    if (type instanceof java.lang.reflect.GenericArrayType) {
      Class<?> component = rawClass(((java.lang.reflect.GenericArrayType) type).getGenericComponentType());
      return java.lang.reflect.Array.newInstance(component, 0).getClass();
    }
    return Object.class;
  }

  static Object serialize(Object value) {
    if (value == null) return null;
    if (value instanceof String || value instanceof Number || value instanceof Boolean) return value;
    if (value instanceof Character) return String.valueOf(value);
    if (value instanceof StringBuilder) return value.toString();
    if (value instanceof Enum<?>) return ((Enum<?>) value).name();
    Class<?> raw = value.getClass();
    if (raw.isArray()) {
      java.util.ArrayList<Object> out = new java.util.ArrayList<>();
      int length = java.lang.reflect.Array.getLength(value);
      for (int i = 0; i < length; i++) out.add(serialize(java.lang.reflect.Array.get(value, i)));
      return out;
    }
    if (value instanceof Iterable<?>) {
      java.util.ArrayList<Object> out = new java.util.ArrayList<>();
      for (Object item : (Iterable<?>) value) out.add(serialize(item));
      return out;
    }
    if (value instanceof java.util.Map<?, ?>) {
      java.util.LinkedHashMap<String, Object> out = new java.util.LinkedHashMap<>();
      for (java.util.Map.Entry<?, ?> entry : ((java.util.Map<?, ?>) value).entrySet()) out.put(String.valueOf(entry.getKey()), serialize(entry.getValue()));
      return out;
    }
    java.util.LinkedHashMap<String, Object> out = new java.util.LinkedHashMap<>();
    java.util.ArrayList<java.lang.reflect.Field> fields = new java.util.ArrayList<>();
    Class<?> current = raw;
    while (current != null && current != Object.class) {
      for (java.lang.reflect.Field field : current.getDeclaredFields()) {
        if (!java.lang.reflect.Modifier.isStatic(field.getModifiers())) fields.add(field);
      }
      current = current.getSuperclass();
    }
    fields.sort(java.util.Comparator.comparing(java.lang.reflect.Field::getName));
    for (java.lang.reflect.Field field : fields) {
      try {
        field.setAccessible(true);
        out.put(field.getName(), serialize(field.get(value)));
      } catch (Throwable _ignored) {
      }
    }
    return out;
  }

  static final class Json {
    private final String text;
    private int pos;
    private Json(String text) { this.text = text; }
    static Object parse(String text) { return new Json(text).parseValue(); }
    static String stringify(Object value) {
      StringBuilder out = new StringBuilder();
      write(value, out);
      return out.toString();
    }
    private Object parseValue() {
      skip();
      if (pos >= text.length()) throw new IllegalArgumentException("unexpected end of JSON");
      char ch = text.charAt(pos);
      if (ch == 'n') { expect("null"); return null; }
      if (ch == 't') { expect("true"); return Boolean.TRUE; }
      if (ch == 'f') { expect("false"); return Boolean.FALSE; }
      if (ch == '"') return parseString();
      if (ch == '[') return parseArray();
      if (ch == '{') return parseObject();
      return parseNumber();
    }
    private java.util.List<Object> parseArray() {
      pos++;
      java.util.ArrayList<Object> out = new java.util.ArrayList<>();
      skip();
      if (peek(']')) { pos++; return out; }
      while (true) {
        out.add(parseValue());
        skip();
        if (peek(']')) { pos++; return out; }
        expect(",");
      }
    }
    private java.util.LinkedHashMap<String, Object> parseObject() {
      pos++;
      java.util.LinkedHashMap<String, Object> out = new java.util.LinkedHashMap<>();
      skip();
      if (peek('}')) { pos++; return out; }
      while (true) {
        String key = parseString();
        skip();
        expect(":");
        out.put(key, parseValue());
        skip();
        if (peek('}')) { pos++; return out; }
        expect(",");
      }
    }
    private String parseString() {
      expect("\"");
      StringBuilder out = new StringBuilder();
      while (pos < text.length()) {
        char ch = text.charAt(pos++);
        if (ch == '"') return out.toString();
        if (ch == '\\') {
          char esc = text.charAt(pos++);
          if (esc == '"' || esc == '\\' || esc == '/') out.append(esc);
          else if (esc == 'b') out.append('\b');
          else if (esc == 'f') out.append('\f');
          else if (esc == 'n') out.append('\n');
          else if (esc == 'r') out.append('\r');
          else if (esc == 't') out.append('\t');
          else if (esc == 'u') {
            out.append((char) Integer.parseInt(text.substring(pos, pos + 4), 16));
            pos += 4;
          }
        } else {
          out.append(ch);
        }
      }
      throw new IllegalArgumentException("unterminated JSON string");
    }
    private Number parseNumber() {
      int start = pos;
      while (pos < text.length() && "-+0123456789.eE".indexOf(text.charAt(pos)) >= 0) pos++;
      String raw = text.substring(start, pos);
      return raw.contains(".") || raw.contains("e") || raw.contains("E") ? Double.valueOf(raw) : Long.valueOf(raw);
    }
    private void skip() { while (pos < text.length() && Character.isWhitespace(text.charAt(pos))) pos++; }
    private boolean peek(char ch) { return pos < text.length() && text.charAt(pos) == ch; }
    private void expect(String token) {
      if (!text.startsWith(token, pos)) throw new IllegalArgumentException("expected " + token + " at " + pos);
      pos += token.length();
    }
    @SuppressWarnings("unchecked")
    private static void write(Object value, StringBuilder out) {
      if (value == null) { out.append("null"); return; }
      if (value instanceof String) { writeString((String) value, out); return; }
      if (value instanceof Number || value instanceof Boolean) { out.append(value); return; }
      if (value instanceof java.util.Map<?, ?>) {
        out.append('{');
        boolean first = true;
        for (java.util.Map.Entry<?, ?> entry : ((java.util.Map<?, ?>) value).entrySet()) {
          if (!first) out.append(',');
          first = false;
          writeString(String.valueOf(entry.getKey()), out);
          out.append(':');
          write(entry.getValue(), out);
        }
        out.append('}');
        return;
      }
      if (value instanceof Iterable<?>) {
        out.append('[');
        boolean first = true;
        for (Object item : (Iterable<?>) value) {
          if (!first) out.append(',');
          first = false;
          write(item, out);
        }
        out.append(']');
        return;
      }
      writeString(String.valueOf(value), out);
    }
    private static void writeString(String value, StringBuilder out) {
      out.append('"');
      for (int i = 0; i < value.length(); i++) {
        char ch = value.charAt(i);
        if (ch == '"' || ch == '\\') out.append('\\').append(ch);
        else if (ch == '\n') out.append("\\n");
        else if (ch == '\r') out.append("\\r");
        else if (ch == '\t') out.append("\\t");
        else if (ch < 32) out.append(String.format("\\u%04x", (int) ch));
        else out.append(ch);
      }
      out.append('"');
    }
  }
}
`;

function buildJavaSource(source: string): string {
  return `${source}\n\n${JAVA_REFLECTION_RUNNER}\n`;
}

function errorResult(error: unknown): JavaExecutionResult {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export async function runJavaNativeFixture(fixture: JavaConformanceFixture): Promise<JavaConformanceRunResult> {
  const expectedOutput = fixture.expectedHarnessOutput ?? fixture.expectedReturn;
  const tempDir = await mkdtemp(join(tmpdir(), 'tracecode-java-conformance-'));
  const sourcePath = join(tempDir, 'TracecodeRunner.java');
  try {
    await writeFile(sourcePath, buildJavaSource(fixture.source), 'utf8');
    execFileSync('javac', ['-parameters', sourcePath], { cwd: tempDir, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const inputBase64 = Buffer.from(JSON.stringify(fixture.input), 'utf8').toString('base64');
    const stdout = execFileSync('java', ['-cp', tempDir, 'TracecodeRunner', fixture.methodName, inputBase64], {
      cwd: tempDir,
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(stdout.trim()) as { output?: unknown; mutations?: Record<string, unknown> };
    const untraced: JavaExecutionResult = { success: true, output: parsed.output, mutations: parsed.mutations ?? {} };
    if (!jsonEqual(untraced.output, expectedOutput)) {
      return {
        success: false,
        expectedOutput,
        untraced,
        phase: 'untraced',
        error: `${fixture.id}: output mismatch\nExpected: ${stableStringify(expectedOutput)}\nReceived: ${stableStringify(untraced.output)}`,
      };
    }
    for (const [key, expectedMutation] of Object.entries(fixture.expectedMutations)) {
      const actualMutation = untraced.mutations?.[key];
      if (!jsonEqual(actualMutation, expectedMutation)) {
        return {
          success: false,
          expectedOutput,
          untraced,
          phase: 'mutations',
          error: `${fixture.id}: mutation mismatch for ${key}\nExpected: ${stableStringify(expectedMutation)}\nReceived: ${stableStringify(actualMutation)}`,
        };
      }
    }
    return { success: true, expectedOutput, untraced };
  } catch (error) {
    return {
      success: false,
      expectedOutput,
      untraced: errorResult(error),
      phase: 'compile',
      error: `${fixture.id}: Java native execution failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

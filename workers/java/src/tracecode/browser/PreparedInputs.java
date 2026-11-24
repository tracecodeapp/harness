package tracecode.browser;

import tracecode.user.TraceHooks;

/** Materializes one case in a generated Java driver. */
public final class PreparedInputs {

  // A node that appears more than once in a case's input graph (a list cycle,
  // a node two parameters share) is written once with "__id__" and afterwards
  // as {"__ref__": id}. These tables give every such occurrence the one
  // object and build each parsed JSON node once. Each driver run owns a new instance.
  private final java.util.HashMap<String, Object> preparedNodesById = new java.util.HashMap<>();
  private final java.util.IdentityHashMap<Object, Object> preparedNodesBySource = new java.util.IdentityHashMap<>();
  // From the scan of each input document: JSON objects with a reference back
  // to themselves inside their own subtree, and JSON values holding any
  // reference.
  private final java.util.IdentityHashMap<Object, Boolean> preparedSelfReferenced = new java.util.IdentityHashMap<>();
  private final java.util.IdentityHashMap<Object, Boolean> preparedHoldsReference = new java.util.IdentityHashMap<>();
  private final java.util.IdentityHashMap<Object, Boolean> preparedRawResolved = new java.util.IdentityHashMap<>();
  private final java.util.IdentityHashMap<Object, Boolean> preparedUnderConstruction = new java.util.IdentityHashMap<>();
  private Object parsePreparedJsonInput(String source) {
    Object document = new __TracecodeJsonParser(source).parse();
    scanPreparedReferences(document);
    return document;
  }

  /**
   * Numbers the document's values in preorder and records each JSON object
   * with an __id__ that a reference inside its own subtree (its preorder
   * span) points back to. Only such an object has to exist before its links
   * are built; every other one is built as before.
   */
  private void scanPreparedReferences(Object document) {
    java.util.HashMap<String, java.util.ArrayList<Integer>> referencePositions = new java.util.HashMap<>();
    java.util.ArrayList<Object> definitions = new java.util.ArrayList<>();
    java.util.ArrayList<int[]> spans = new java.util.ArrayList<>();
    scanPreparedValue(document, new int[] { 0 }, referencePositions, definitions, spans);
    for (int index = 0; index < definitions.size(); index += 1) {
      Object definition = definitions.get(index);
      int[] span = spans.get(index);
      java.util.ArrayList<Integer> positions = referencePositions.get(((java.util.Map<?, ?>) definition).get("__id__"));
      if (positions == null) continue;
      for (int position : positions) {
        if (position > span[0] && position <= span[1]) {
          preparedSelfReferenced.put(definition, Boolean.TRUE);
          break;
        }
      }
    }
  }

  private boolean scanPreparedValue(
      Object value,
      int[] counter,
      java.util.HashMap<String, java.util.ArrayList<Integer>> referencePositions,
      java.util.ArrayList<Object> definitions,
      java.util.ArrayList<int[]> spans
  ) {
    int position = counter[0]++;
    boolean holdsReference = false;
    java.util.Collection<?> children;
    int[] span = null;
    if (value instanceof java.util.Map<?, ?>) {
      java.util.Map<?, ?> fields = (java.util.Map<?, ?>) value;
      Object target = fields.get("__ref__");
      if (target instanceof String) {
        referencePositions.computeIfAbsent((String) target, key -> new java.util.ArrayList<>()).add(position);
        holdsReference = true;
      }
      if (fields.get("__id__") instanceof String) {
        span = new int[] { position, position };
        definitions.add(value);
        spans.add(span);
      }
      children = fields.values();
    } else if (value instanceof java.util.List<?>) {
      children = (java.util.List<?>) value;
    } else {
      return false;
    }
    for (Object child : children) {
      if (scanPreparedValue(child, counter, referencePositions, definitions, spans)) holdsReference = true;
    }
    if (span != null) span[1] = counter[0] - 1;
    if (holdsReference) preparedHoldsReference.put(value, Boolean.TRUE);
    return holdsReference;
  }

  private String preparedInputSource(String key) {
    String source = System.getProperty(key);
    if (source == null) {
      throw new RuntimeException("Missing TraceCode prepared input " + key);
    }
    return source;
  }

  public Object readJsonInputProperty(String key, java.lang.reflect.Type targetType) {
    return coerceJsonInput(parsePreparedJsonInput(preparedInputSource(key)), targetType);
  }

  public Object readJsonInput(String path, java.lang.reflect.Type targetType) {
    try {
      String source = java.nio.file.Files.readString(java.nio.file.Paths.get(path), java.nio.charset.StandardCharsets.UTF_8);
      return coerceJsonInput(parsePreparedJsonInput(source), targetType);
    } catch (java.io.IOException error) {
      throw new RuntimeException("Unable to read TraceCode input " + path, error);
    }
  }

  public java.lang.reflect.Type preparedParameterType(
      Class<?> owner,
      String methodName,
      int parameterIndex,
      Class<?>[] parameterTypes
  ) {
    try {
      java.lang.reflect.Method method = owner.getDeclaredMethod(methodName, parameterTypes);
      return method.getGenericParameterTypes()[parameterIndex];
    } catch (ReflectiveOperationException exactFailure) {
      for (java.lang.reflect.Method method : owner.getDeclaredMethods()) {
        if (method.getName().equals(methodName) && method.getParameterCount() == parameterTypes.length) {
          return method.getGenericParameterTypes()[parameterIndex];
        }
      }
      throw new RuntimeException("Unable to resolve prepared Java parameter " + methodName, exactFailure);
    }
  }

  private Class<?> preparedRawClass(java.lang.reflect.Type type) {
    if (type instanceof Class<?>) return (Class<?>) type;
    if (type instanceof java.lang.reflect.ParameterizedType) {
      return preparedRawClass(((java.lang.reflect.ParameterizedType) type).getRawType());
    }
    if (type instanceof java.lang.reflect.GenericArrayType) {
      Class<?> component = preparedRawClass(
          ((java.lang.reflect.GenericArrayType) type).getGenericComponentType()
      );
      return java.lang.reflect.Array.newInstance(component, 0).getClass();
    }
    return Object.class;
  }

  private java.lang.reflect.Type preparedTypeArgument(
      java.lang.reflect.Type type,
      int index
  ) {
    if (type instanceof java.lang.reflect.ParameterizedType) {
      java.lang.reflect.Type[] arguments =
          ((java.lang.reflect.ParameterizedType) type).getActualTypeArguments();
      if (index >= 0 && index < arguments.length) return arguments[index];
    }
    return Object.class;
  }

  private java.util.Collection<Object> preparedCollection(
      Class<?> targetType
  ) {
    try {
      if (
          targetType == java.util.Set.class ||
          targetType == java.util.HashSet.class ||
          targetType == java.util.LinkedHashSet.class
      ) {
        return new java.util.LinkedHashSet<>();
      }
      if (
          targetType == java.util.Queue.class ||
          targetType == java.util.Deque.class ||
          targetType == java.util.ArrayDeque.class
      ) {
        return new java.util.ArrayDeque<>();
      }
      if (
          targetType.isInterface() ||
          java.lang.reflect.Modifier.isAbstract(targetType.getModifiers())
      ) {
        return new java.util.ArrayList<>();
      }
      @SuppressWarnings("unchecked")
      java.util.Collection<Object> value =
          (java.util.Collection<Object>) targetType.getDeclaredConstructor().newInstance();
      return value;
    } catch (ReflectiveOperationException error) {
      throw new RuntimeException("Unable to create prepared Java collection " + targetType.getName(), error);
    }
  }

  private java.util.Map<Object, Object> preparedMap(Class<?> targetType) {
    try {
      if (
          targetType == java.util.SortedMap.class ||
          targetType == java.util.NavigableMap.class ||
          targetType == java.util.TreeMap.class
      ) {
        return new java.util.TreeMap<>();
      }
      if (
          targetType.isInterface() ||
          java.lang.reflect.Modifier.isAbstract(targetType.getModifiers())
      ) {
        return new java.util.LinkedHashMap<>();
      }
      @SuppressWarnings("unchecked")
      java.util.Map<Object, Object> value =
          (java.util.Map<Object, Object>) targetType.getDeclaredConstructor().newInstance();
      return value;
    } catch (ReflectiveOperationException error) {
      throw new RuntimeException("Unable to create prepared Java map " + targetType.getName(), error);
    }
  }

  private java.lang.reflect.Field preparedField(
      Class<?> targetType,
      String name
  ) {
    Class<?> current = targetType;
    while (current != null && current != Object.class) {
      try {
        return current.getDeclaredField(name);
      } catch (NoSuchFieldException ignored) {
        current = current.getSuperclass();
      }
    }
    return null;
  }

  /**
   * Rethrows a trace-budget abort that reflection wrapped.
   *
   * Constructor.newInstance wraps anything the constructor throws in an
   * InvocationTargetException, which is a ReflectiveOperationException. In
   * trace mode the learner's own types are instrumented, so a budget trip
   * inside a constructor arrives here looking exactly like "wrong constructor"
   * and gets discarded by the candidate loops -- every candidate then fails and
   * materialization reports "Unable to materialize prepared Java input" instead
   * of letting TraceExecutionRunner catch the abort and re-run the case.
   */
  private void rethrowBudgetAbort(Throwable error) {
    // A learner exception's causes can form a cycle (A caused by B caused by
    // A); visit each exception once.
    java.util.IdentityHashMap<Throwable, Boolean> seen = new java.util.IdentityHashMap<>();
    Throwable current = error;
    while (current != null && seen.put(current, Boolean.TRUE) == null) {
      if (current instanceof tracecode.user.TraceBudgetExceededError) {
        throw (tracecode.user.TraceBudgetExceededError) current;
      }
      try {
        current = current.getCause();
      } catch (tracecode.user.TraceBudgetExceededError budgetExceeded) {
        // getCause() is traced code: a trip inside it is the abort itself.
        throw budgetExceeded;
      } catch (Throwable getCauseFailure) {
        // getCause() is the learner's to override. Once the budget has
        // tripped, one that throws is not a budget error; otherwise it
        // propagates, in untraced and traced runs alike.
        if (tracecode.user.TraceHooks.traceLimitExceeded()) return;
        throw getCauseFailure;
      }
    }
  }

  // For the catches around receiver construction and operation probes, which
  // otherwise move on to the next overload without looking at the exception.
  // TraceHooks sets traceLimitExceeded before it throws the budget error and
  // clears it for each run. "Recording is on" would be the wrong test: the
  // worker also starts a plain (Submit) program with recording on, but that
  // program has no hooks, so it never trips.
  private void rethrowTrippedBudgetAbort(Throwable error) {
    if (tracecode.user.TraceHooks.traceLimitExceeded()) rethrowBudgetAbort(error);
  }

  private void assignPreparedJsonFields(
      Class<?> targetType,
      Object instance,
      java.util.Map<?, ?> fields
  ) throws ReflectiveOperationException {
    for (java.util.Map.Entry<?, ?> entry : fields.entrySet()) {
      String name = String.valueOf(entry.getKey());
      if (name.startsWith("__")) continue;
      java.lang.reflect.Field field = preparedField(targetType, name);
      if (field == null) continue;
      field.setAccessible(true);
      field.set(instance, coerceJsonInput(entry.getValue(), field.getGenericType()));
    }
  }

  private Object defaultJsonArgument(Class<?> parameterType) {
    if (!parameterType.isPrimitive()) return null;
    if (parameterType == boolean.class) return Boolean.FALSE;
    if (parameterType == char.class) return Character.valueOf('\0');
    if (parameterType == byte.class) return Byte.valueOf((byte) 0);
    if (parameterType == short.class) return Short.valueOf((short) 0);
    if (parameterType == int.class) return Integer.valueOf(0);
    if (parameterType == long.class) return Long.valueOf(0L);
    if (parameterType == float.class) return Float.valueOf(0f);
    if (parameterType == double.class) return Double.valueOf(0d);
    return null;
  }

  private Object materializePreparedJsonObject(
      java.util.Map<?, ?> fields,
      Class<?> targetType
  ) {
    Object reference = fields.get("__ref__");
    if (reference instanceof String) {
      Object node = preparedNodesById.get(reference);
      if (node == null) {
        throw new IllegalStateException(
            "Prepared input reference " + reference + " does not name an earlier node in this case"
        );
      }
      if (
          !targetType.isInstance(node) &&
          node instanceof java.util.Map<?, ?> &&
          preparedRawResolved.containsKey(node)
      ) {
        // An Object-typed input took this node as its raw JSON object; build
        // it as the requested type now, which also registers it.
        return materializePreparedJsonObject((java.util.Map<?, ?>) node, targetType);
      }
      if (!targetType.isInstance(node)) {
        throw new IllegalArgumentException(
            "Prepared input reference " + reference + " is not a " + targetType.getName()
        );
      }
      return node;
    }
    // Constructor arguments and the by-name field assignment both reach the
    // same JSON node; build it once so each subtree is not built again.
    Object built = preparedNodesBySource.get(fields);
    if (built != null && targetType.isInstance(built)) return built;
    if (preparedUnderConstruction.containsKey(fields)) {
      throw new IllegalStateException("Prepared input contains itself without a reference: " + targetType.getName());
    }
    preparedUnderConstruction.put(fields, Boolean.TRUE);
    try {
      return materializeUnbuiltPreparedJsonObject(fields, targetType);
    } finally {
      preparedUnderConstruction.remove(fields);
    }
  }

  private Object materializeUnbuiltPreparedJsonObject(
      java.util.Map<?, ?> fields,
      Class<?> targetType
  ) {
    if (preparedSelfReferenced.containsKey(fields)) {
      // Something inside this node points back to it, so it has to exist
      // before the links that lead there are built.
      Object instance = allocateSelfReferencedPreparedObject(fields, targetType);
      recordPreparedNode(fields, instance);
      try {
        assignPreparedJsonFields(targetType, instance, fields);
      } catch (ReflectiveOperationException error) {
        rethrowBudgetAbort(error);
        throw new RuntimeException("Unable to materialize prepared Java input " + targetType.getName(), error);
      }
      return instance;
    }
    return recordPreparedNode(fields, constructPreparedJsonObject(fields, targetType));
  }

  private Object recordPreparedNode(java.util.Map<?, ?> fields, Object instance) {
    preparedNodesBySource.put(fields, instance);
    Object id = fields.get("__id__");
    if (id instanceof String) preparedNodesById.put((String) id, instance);
    return instance;
  }

  private boolean preparedScalarFits(Object value, Class<?> type) {
    if (value instanceof Number) {
      return type == int.class || type == long.class || type == double.class || type == float.class ||
          type == short.class || type == byte.class || Number.class.isAssignableFrom(type);
    }
    if (value instanceof Boolean) return type == boolean.class || type == Boolean.class;
    if (value instanceof String) {
      return type == String.class ||
          ((type == char.class || type == Character.class) && ((String) value).length() == 1);
    }
    return false;
  }

  /**
   * Constructs a node that its own input points back to, before its links
   * are built. The constructor gets the input's real values, with null for
   * the fields that lead back to the node: a constructor taking every field
   * in order; a no-arg one; one taking the leading scalar values; and only
   * then one called with type-default arguments. The by-name field
   * assignment that follows supplies the rest, as for every node.
   */
  private Object allocateSelfReferencedPreparedObject(
      java.util.Map<?, ?> fields,
      Class<?> targetType
  ) {
    java.util.ArrayList<Object> values = new java.util.ArrayList<>();
    java.util.ArrayList<Boolean> leadsBack = new java.util.ArrayList<>();
    for (java.util.Map.Entry<?, ?> entry : fields.entrySet()) {
      if (String.valueOf(entry.getKey()).startsWith("__")) continue;
      values.add(entry.getValue());
      leadsBack.add(preparedHoldsReference.containsKey(entry.getValue()) && preparedFieldLeadsBack(entry.getValue()));
    }
    java.lang.reflect.Constructor<?>[] constructors = targetType.getDeclaredConstructors();
    for (java.lang.reflect.Constructor<?> constructor : constructors) {
      if (constructor.getParameterCount() != values.size() || values.isEmpty()) continue;
      try {
        java.lang.reflect.Type[] parameterTypes = constructor.getGenericParameterTypes();
        Class<?>[] rawTypes = constructor.getParameterTypes();
        Object[] arguments = new Object[values.size()];
        for (int index = 0; index < values.size(); index += 1) {
          if (leadsBack.get(index)) {
            if (rawTypes[index].isPrimitive()) throw new IllegalArgumentException("primitive back-reference");
            arguments[index] = null;
          } else {
            arguments[index] = coerceJsonInput(values.get(index), parameterTypes[index]);
          }
        }
        constructor.setAccessible(true);
        return constructor.newInstance(arguments);
      } catch (ReflectiveOperationException | IllegalArgumentException candidateFailure) {
        rethrowBudgetAbort(candidateFailure);
      }
    }
    for (java.lang.reflect.Constructor<?> constructor : constructors) {
      if (constructor.getParameterCount() != 0) continue;
      try {
        constructor.setAccessible(true);
        return constructor.newInstance();
      } catch (ReflectiveOperationException candidateFailure) {
        rethrowBudgetAbort(candidateFailure);
      }
    }
    java.util.ArrayList<Object> leadingScalars = new java.util.ArrayList<>();
    for (int index = 0; index < values.size(); index += 1) {
      Object value = values.get(index);
      if (leadsBack.get(index) || value == null || value instanceof java.util.Map<?, ?> || value instanceof java.util.List<?>) break;
      leadingScalars.add(value);
    }
    java.lang.reflect.Constructor<?>[] widestFirst = constructors.clone();
    java.util.Arrays.sort(
        widestFirst,
        java.util.Comparator.comparingInt((java.lang.reflect.Constructor<?> constructor) -> constructor.getParameterCount()).reversed()
    );
    for (java.lang.reflect.Constructor<?> constructor : widestFirst) {
      Class<?>[] parameterTypes = constructor.getParameterTypes();
      if (parameterTypes.length == 0 || parameterTypes.length > leadingScalars.size()) continue;
      boolean fits = true;
      for (int index = 0; index < parameterTypes.length && fits; index += 1) {
        fits = preparedScalarFits(leadingScalars.get(index), parameterTypes[index]);
      }
      if (!fits) continue;
      try {
        Object[] arguments = new Object[parameterTypes.length];
        for (int index = 0; index < parameterTypes.length; index += 1) {
          arguments[index] = coerceJsonInput(leadingScalars.get(index), parameterTypes[index]);
        }
        constructor.setAccessible(true);
        return constructor.newInstance(arguments);
      } catch (ReflectiveOperationException | IllegalArgumentException candidateFailure) {
        rethrowBudgetAbort(candidateFailure);
      }
    }
    for (java.lang.reflect.Constructor<?> constructor : declaredByArity(constructors)) {
      try {
        Class<?>[] parameterTypes = constructor.getParameterTypes();
        Object[] arguments = new Object[parameterTypes.length];
        for (int index = 0; index < parameterTypes.length; index += 1) {
          arguments[index] = defaultJsonArgument(parameterTypes[index]);
        }
        constructor.setAccessible(true);
        return constructor.newInstance(arguments);
      } catch (ReflectiveOperationException | IllegalArgumentException candidateFailure) {
        rethrowBudgetAbort(candidateFailure);
      }
    }
    throw new RuntimeException("Unable to materialize prepared Java input " + targetType.getName());
  }

  /**
   * Whether building this field value now would need a node that does not
   * exist yet: the node being built (or another one under construction), or
   * a reference to an id neither built already nor defined inside the value.
   */
  private boolean preparedFieldLeadsBack(Object value) {
    java.util.HashSet<String> defined = new java.util.HashSet<>();
    java.util.ArrayList<String> references = new java.util.ArrayList<>();
    java.util.ArrayDeque<Object> pending = new java.util.ArrayDeque<>();
    java.util.IdentityHashMap<Object, Boolean> seen = new java.util.IdentityHashMap<>();
    if (value != null) pending.add(value);
    while (!pending.isEmpty()) {
      Object current = pending.pop();
      if (seen.put(current, Boolean.TRUE) != null) continue;
      if (preparedUnderConstruction.containsKey(current)) return true;
      if (current instanceof java.util.Map<?, ?>) {
        java.util.Map<?, ?> map = (java.util.Map<?, ?>) current;
        Object target = map.get("__ref__");
        if (target instanceof String) references.add((String) target);
        Object id = map.get("__id__");
        if (id instanceof String) defined.add((String) id);
        for (Object child : map.values()) if (child != null) pending.add(child);
      } else if (current instanceof java.util.List<?>) {
        for (Object child : (java.util.List<?>) current) if (child != null) pending.add(child);
      }
    }
    for (String reference : references) {
      if (!defined.contains(reference) && !preparedNodesById.containsKey(reference)) return true;
    }
    return false;
  }

  private java.lang.reflect.Constructor<?>[] declaredByArity(java.lang.reflect.Constructor<?>[] constructors) {
    java.lang.reflect.Constructor<?>[] sorted = constructors.clone();
    java.util.Arrays.sort(sorted, java.util.Comparator.comparingInt(java.lang.reflect.Constructor::getParameterCount));
    return sorted;
  }

  private Object constructPreparedJsonObject(
      java.util.Map<?, ?> fields,
      Class<?> targetType
  ) {
    java.util.ArrayList<Object> materializedValues = new java.util.ArrayList<>();
    for (java.util.Map.Entry<?, ?> entry : fields.entrySet()) {
      if (!String.valueOf(entry.getKey()).startsWith("__")) {
        materializedValues.add(entry.getValue());
      }
    }
    Object[] values = materializedValues.toArray();
    for (java.lang.reflect.Constructor<?> constructor : targetType.getDeclaredConstructors()) {
      if (constructor.getParameterCount() != values.length) continue;
      try {
        java.lang.reflect.Type[] parameterTypes = constructor.getGenericParameterTypes();
        Object[] arguments = new Object[values.length];
        for (int index = 0; index < values.length; index += 1) {
          arguments[index] = coerceJsonInput(values[index], parameterTypes[index]);
        }
        constructor.setAccessible(true);
        Object instance = constructor.newInstance(arguments);
        assignPreparedJsonFields(targetType, instance, fields);
        return instance;
      } catch (ReflectiveOperationException | IllegalArgumentException candidateFailure) {
        rethrowBudgetAbort(candidateFailure);
      }
    }
    try {
      java.lang.reflect.Constructor<?> constructor = targetType.getDeclaredConstructor();
      constructor.setAccessible(true);
      Object instance = constructor.newInstance();
      assignPreparedJsonFields(targetType, instance, fields);
      return instance;
    } catch (ReflectiveOperationException candidateFailure) {
      rethrowBudgetAbort(candidateFailure);
    }
    // Learner types often declare a single convenience constructor (the classic
    // TreeNode(int val)) and no no-arg constructor, so an interior node that
    // serializes as {val,left,right} matches no constructor arity. Construct
    // with type-default arguments and let the by-name field assignment below
    // populate the real values.
    java.lang.reflect.Constructor<?>[] declared = targetType.getDeclaredConstructors();
    java.util.Arrays.sort(declared, java.util.Comparator.comparingInt(java.lang.reflect.Constructor::getParameterCount));
    for (java.lang.reflect.Constructor<?> constructor : declared) {
      try {
        Class<?>[] parameterTypes = constructor.getParameterTypes();
        Object[] arguments = new Object[parameterTypes.length];
        for (int index = 0; index < parameterTypes.length; index += 1) {
          arguments[index] = defaultJsonArgument(parameterTypes[index]);
        }
        constructor.setAccessible(true);
        Object instance = constructor.newInstance(arguments);
        assignPreparedJsonFields(targetType, instance, fields);
        return instance;
      } catch (ReflectiveOperationException | IllegalArgumentException candidateFailure) {
        rethrowBudgetAbort(candidateFailure);
      }
    }
    throw new RuntimeException("Unable to materialize prepared Java input " + targetType.getName());
  }

  private Object preparedLinkedNodes(
      java.util.List<?> values,
      Class<?> targetType
  ) {
    if (values.isEmpty()) return null;
    Object head = null;
    Object tail = null;
    for (Object value : values) {
      java.util.LinkedHashMap<String, Object> fields = new java.util.LinkedHashMap<>();
      fields.put("val", value);
      fields.put("next", null);
      Object node = materializePreparedJsonObject(fields, targetType);
      if (head == null) {
        head = node;
      } else {
        try {
          java.lang.reflect.Field next = preparedField(targetType, "next");
          if (next == null) throw new NoSuchFieldException("next");
          next.setAccessible(true);
          next.set(tail, node);
        } catch (ReflectiveOperationException error) {
          throw new RuntimeException("Unable to link prepared ListNode input", error);
        }
      }
      tail = node;
    }
    return head;
  }

  private Object preparedTreeNodes(
      java.util.List<?> values,
      Class<?> targetType
  ) {
    if (values.isEmpty() || values.get(0) == null) return null;
    java.util.ArrayList<Object> nodes = new java.util.ArrayList<>();
    for (Object value : values) {
      if (value == null) {
        nodes.add(null);
        continue;
      }
      java.util.LinkedHashMap<String, Object> fields = new java.util.LinkedHashMap<>();
      fields.put("val", value);
      fields.put("left", null);
      fields.put("right", null);
      nodes.add(materializePreparedJsonObject(fields, targetType));
    }
    int child = 1;
    for (int index = 0; index < nodes.size() && child < nodes.size(); index += 1) {
      Object parent = nodes.get(index);
      if (parent == null) continue;
      try {
        java.lang.reflect.Field left = preparedField(targetType, "left");
        java.lang.reflect.Field right = preparedField(targetType, "right");
        if (left == null || right == null) throw new NoSuchFieldException("left/right");
        left.setAccessible(true);
        right.setAccessible(true);
        left.set(parent, nodes.get(child++));
        if (child < nodes.size()) right.set(parent, nodes.get(child++));
      } catch (ReflectiveOperationException error) {
        throw new RuntimeException("Unable to link prepared TreeNode input", error);
      }
    }
    return nodes.get(0);
  }

  private Object coerceJsonInput(
      Object value,
      java.lang.reflect.Type targetType
  ) {
    if (value == null) return null;
    Class<?> rawType = preparedRawClass(targetType);
    if (rawType == Object.class) return resolvePreparedRawReferences(value);
    if (rawType.isArray()) {
      java.util.List<?> list = (java.util.List<?>) value;
      Class<?> componentType = rawType.getComponentType();
      Object array = java.lang.reflect.Array.newInstance(componentType, list.size());
      for (int i = 0; i < list.size(); i++) {
        java.lang.reflect.Array.set(array, i, coerceJsonInput(list.get(i), componentType));
      }
      return array;
    }
    if ((rawType == byte.class || rawType == Byte.class) && value instanceof Number) return ((Number) value).byteValue();
    if ((rawType == short.class || rawType == Short.class) && value instanceof Number) return ((Number) value).shortValue();
    if ((rawType == int.class || rawType == Integer.class) && value instanceof Number) return ((Number) value).intValue();
    if ((rawType == long.class || rawType == Long.class) && value instanceof Number) return ((Number) value).longValue();
    if ((rawType == float.class || rawType == Float.class) && value instanceof Number) return ((Number) value).floatValue();
    if ((rawType == double.class || rawType == Double.class) && value instanceof Number) return ((Number) value).doubleValue();
    if ((rawType == boolean.class || rawType == Boolean.class) && value instanceof Boolean) return value;
    if ((rawType == char.class || rawType == Character.class) && value instanceof String && ((String) value).length() == 1) {
      return ((String) value).charAt(0);
    }
    if (rawType == String.class) return String.valueOf(value);
    if (rawType == StringBuilder.class) return new StringBuilder(String.valueOf(value));
    if (rawType.isEnum()) {
      @SuppressWarnings({"unchecked", "rawtypes"})
      Object enumValue = java.lang.Enum.valueOf(
          (Class<? extends java.lang.Enum>) rawType,
          String.valueOf(value)
      );
      return enumValue;
    }
    if (java.util.Collection.class.isAssignableFrom(rawType)) {
      java.util.Collection<Object> output = preparedCollection(rawType);
      java.lang.reflect.Type itemType = preparedTypeArgument(targetType, 0);
      for (Object item : (java.util.List<?>) value) {
        output.add(coerceJsonInput(item, itemType));
      }
      return output;
    }
    if (java.util.Map.class.isAssignableFrom(rawType)) {
      java.util.Map<Object, Object> output = preparedMap(rawType);
      java.lang.reflect.Type keyType = preparedTypeArgument(targetType, 0);
      java.lang.reflect.Type valueType = preparedTypeArgument(targetType, 1);
      for (java.util.Map.Entry<?, ?> entry : ((java.util.Map<?, ?>) value).entrySet()) {
        output.put(
            coerceJsonInput(entry.getKey(), keyType),
            coerceJsonInput(entry.getValue(), valueType)
        );
      }
      return output;
    }
    if (
        value instanceof java.util.List<?> &&
        rawType.getSimpleName().equals("ListNode")
    ) {
      return preparedLinkedNodes((java.util.List<?>) value, rawType);
    }
    if (
        value instanceof java.util.List<?> &&
        rawType.getSimpleName().equals("TreeNode")
    ) {
      return preparedTreeNodes((java.util.List<?>) value, rawType);
    }
    if (value instanceof java.util.Map<?, ?>) {
      return materializePreparedJsonObject((java.util.Map<?, ?>) value, rawType);
    }
    if (rawType.isInstance(value)) return value;
    throw new IllegalArgumentException(
        "Cannot materialize prepared Java input as " + rawType.getTypeName()
    );
  }

  /**
   * An input declared Object keeps its JSON shape, but a reference inside it
   * names the node it refers to once that node exists, and a JSON object
   * there that defines an id can be referred to from elsewhere in the case.
   */
  @SuppressWarnings("unchecked")
  private Object resolvePreparedRawReferences(Object value) {
    if (value instanceof java.util.Map<?, ?>) {
      java.util.Map<Object, Object> fields = (java.util.Map<Object, Object>) value;
      Object reference = fields.get("__ref__");
      if (reference instanceof String && fields.size() == 1) {
        Object node = preparedNodesById.get(reference);
        return node != null ? node : value;
      }
      // Once resolved, a value can contain itself: resolve each one once.
      if (preparedRawResolved.put(value, Boolean.TRUE) != null) return value;
      Object id = fields.get("__id__");
      if (id instanceof String) preparedNodesById.putIfAbsent((String) id, value);
      for (java.util.Map.Entry<Object, Object> entry : fields.entrySet()) {
        entry.setValue(resolvePreparedRawReferences(entry.getValue()));
      }
      return value;
    }
    if (value instanceof java.util.List<?>) {
      if (preparedRawResolved.put(value, Boolean.TRUE) != null) return value;
      java.util.List<Object> items = (java.util.List<Object>) value;
      for (int index = 0; index < items.size(); index += 1) {
        items.set(index, resolvePreparedRawReferences(items.get(index)));
      }
    }
    return value;
  }

  private Object[] preparedArguments(
      java.util.List<?> rawArguments,
      java.lang.reflect.Type[] parameterTypes
  ) {
    if (rawArguments.size() != parameterTypes.length) {
      throw new IllegalArgumentException("Prepared Java argument count mismatch");
    }
    Object[] arguments = new Object[parameterTypes.length];
    for (int index = 0; index < parameterTypes.length; index += 1) {
      arguments[index] = coerceJsonInput(rawArguments.get(index), parameterTypes[index]);
    }
    return arguments;
  }

  private Object constructPreparedReceiver(
      Class<?> targetType,
      java.util.List<?> rawArguments
  ) {
    Throwable lastFailure = null;
    for (java.lang.reflect.Constructor<?> constructor : targetType.getDeclaredConstructors()) {
      if (constructor.getParameterCount() != rawArguments.size()) continue;
      try {
        Object[] arguments = preparedArguments(
            rawArguments,
            constructor.getGenericParameterTypes()
        );
        constructor.setAccessible(true);
        return constructor.newInstance(arguments);
      } catch (Throwable error) {
        // A trace budget that trips inside the constructor is not a
        // constructor that did not fit: let it reach the runner, which keeps
        // the steps recorded so far. Constructor selection is unchanged.
        rethrowTrippedBudgetAbort(error);
        lastFailure = error;
      }
    }
    throw new RuntimeException(
        "No matching prepared Java constructor for " + targetType.getName(),
        lastFailure
    );
  }

  private java.lang.reflect.Method preparedOperationMethod(
      Class<?> targetType,
      String operation,
      java.util.List<?> rawArguments
  ) {
    for (java.lang.reflect.Method method : targetType.getDeclaredMethods()) {
      if (
          method.getName().equals(operation) &&
          method.getParameterCount() == rawArguments.size()
      ) {
        try {
          preparedArguments(rawArguments, method.getGenericParameterTypes());
          method.setAccessible(true);
          return method;
        } catch (RuntimeException probeFailure) {
          // As for receivers: a trace budget trip reaches the runner.
          rethrowTrippedBudgetAbort(probeFailure);
        }
      }
    }
    throw new IllegalArgumentException(
        "No matching prepared Java operation " + targetType.getName() + "." + operation
    );
  }

  public String runOperations(Class<?> targetType, String property) {
    // Each operation's arguments are converted when that operation runs.
    return runPreparedOperations(targetType, parsePreparedJsonInput(preparedInputSource(property)));
  }

  private String runPreparedOperations(
      Class<?> targetType,
      Object rawInput
  ) {
    if (!(rawInput instanceof java.util.Map<?, ?>)) {
      throw new IllegalArgumentException("Prepared ops-class input must be an object");
    }
    java.util.Map<?, ?> input = (java.util.Map<?, ?>) rawInput;
    Object rawOperations = input.get("operations");
    Object rawArgumentLists = input.get("arguments");
    if (
        !(rawOperations instanceof java.util.List<?>) ||
        !(rawArgumentLists instanceof java.util.List<?>)
    ) {
      throw new IllegalArgumentException(
          "Prepared ops-class input requires operations and arguments arrays"
      );
    }
    java.util.List<?> operations = (java.util.List<?>) rawOperations;
    java.util.List<?> argumentLists = (java.util.List<?>) rawArgumentLists;
    if (operations.size() != argumentLists.size()) {
      throw new IllegalArgumentException(
          "Prepared ops-class operations and arguments must have equal lengths"
      );
    }

    int operationIndex = 0;
    java.util.List<?> constructorArguments = java.util.Collections.emptyList();
    if (!operations.isEmpty()) {
      String firstOperation = String.valueOf(operations.get(0));
      boolean namesConstructor =
          firstOperation.equals(targetType.getSimpleName()) ||
          firstOperation.equals("__init__") ||
          firstOperation.equals("init");
      boolean namesMethod = false;
      for (java.lang.reflect.Method method : targetType.getDeclaredMethods()) {
        if (method.getName().equals(firstOperation)) {
          namesMethod = true;
          break;
        }
      }
      if (namesConstructor || !namesMethod) {
        Object firstArguments = argumentLists.get(0);
        if (!(firstArguments instanceof java.util.List<?>)) {
          throw new IllegalArgumentException(
              "Prepared ops-class constructor arguments must be an array"
          );
        }
        constructorArguments = (java.util.List<?>) firstArguments;
        operationIndex = 1;
      }
    }

    Object receiver = constructPreparedReceiver(targetType, constructorArguments);
    java.util.ArrayList<Object> output = new java.util.ArrayList<>();
    if (operationIndex == 1) output.add(null);
    for (; operationIndex < operations.size(); operationIndex += 1) {
      String operation = String.valueOf(operations.get(operationIndex));
      Object rawArguments = argumentLists.get(operationIndex);
      if (!(rawArguments instanceof java.util.List<?>)) {
        throw new IllegalArgumentException(
            "Prepared ops-class method arguments must be arrays"
        );
      }
      java.util.List<?> methodArguments = (java.util.List<?>) rawArguments;
      java.lang.reflect.Method method = preparedOperationMethod(
          targetType,
          operation,
          methodArguments
      );
      try {
        Object result = method.invoke(
            receiver,
            preparedArguments(methodArguments, method.getGenericParameterTypes())
        );
        output.add(method.getReturnType() == void.class ? null : result);
      } catch (ReflectiveOperationException error) {
        Throwable cause = error.getCause();
        if (cause instanceof RuntimeException) throw (RuntimeException) cause;
        if (cause instanceof Error) throw (Error) cause;
        throw new RuntimeException(
            "Prepared Java operation failed: " + operation,
            cause == null ? error : cause
        );
      }
    }
    return TraceHooks.serializeOutputResult(output);
  }

  private static final class __TracecodeJsonParser {
    private final String source;
    private int index = 0;

    __TracecodeJsonParser(String source) {
      this.source = source == null || source.isEmpty() ? "null" : source;
    }

    Object parse() {
      skipWhitespace();
      Object value = parseValue();
      skipWhitespace();
      if (index != source.length()) {
        throw new IllegalArgumentException("Unexpected trailing JSON input");
      }
      return value;
    }

    private Object parseValue() {
      skipWhitespace();
      char ch = peek();
      if (ch == '"') return parseString();
      if (ch == '[') return parseArray();
      if (ch == '{') return parseObject();
      if (ch == '-' || (ch >= '0' && ch <= '9')) return parseNumber();
      if (consume("true")) return Boolean.TRUE;
      if (consume("false")) return Boolean.FALSE;
      if (consume("null")) return null;
      throw new IllegalArgumentException("Invalid JSON input");
    }

    private java.util.List<Object> parseArray() {
      expect('[');
      java.util.ArrayList<Object> values = new java.util.ArrayList<>();
      skipWhitespace();
      if (peek() == ']') {
        index++;
        return values;
      }
      while (true) {
        values.add(parseValue());
        skipWhitespace();
        char separator = take();
        if (separator == ']') return values;
        if (separator != ',') throw new IllegalArgumentException("Invalid JSON array");
      }
    }

    private java.util.LinkedHashMap<String, Object> parseObject() {
      expect('{');
      java.util.LinkedHashMap<String, Object> values = new java.util.LinkedHashMap<>();
      skipWhitespace();
      if (peek() == '}') {
        index++;
        return values;
      }
      while (true) {
        skipWhitespace();
        String key = parseString();
        skipWhitespace();
        expect(':');
        values.put(key, parseValue());
        skipWhitespace();
        char separator = take();
        if (separator == '}') return values;
        if (separator != ',') throw new IllegalArgumentException("Invalid JSON object");
      }
    }

    private String parseString() {
      expect('"');
      StringBuilder out = new StringBuilder();
      while (true) {
        char ch = take();
        if (ch == '"') return out.toString();
        if (ch != '\\') {
          out.append(ch);
          continue;
        }
        char escaped = take();
        switch (escaped) {
          case '"': out.append('"'); break;
          case '\\': out.append('\\'); break;
          case '/': out.append('/'); break;
          case 'b': out.append('\b'); break;
          case 'f': out.append('\f'); break;
          case 'n': out.append('\n'); break;
          case 'r': out.append('\r'); break;
          case 't': out.append('\t'); break;
          case 'u':
            int codePoint = 0;
            for (int i = 0; i < 4; i++) {
              codePoint = (codePoint << 4) + Character.digit(take(), 16);
            }
            out.append((char) codePoint);
            break;
          default:
            throw new IllegalArgumentException("Invalid JSON string escape");
        }
      }
    }

    private Number parseNumber() {
      int start = index;
      if (peek() == '-') index++;
      while (peek() >= '0' && peek() <= '9') index++;
      boolean floating = false;
      if (peek() == '.') {
        floating = true;
        index++;
        while (peek() >= '0' && peek() <= '9') index++;
      }
      if (peek() == 'e' || peek() == 'E') {
        floating = true;
        index++;
        if (peek() == '+' || peek() == '-') index++;
        while (peek() >= '0' && peek() <= '9') index++;
      }
      String raw = source.substring(start, index);
      return floating ? Double.valueOf(raw) : Long.valueOf(raw);
    }

    private boolean consume(String literal) {
      if (!source.startsWith(literal, index)) return false;
      index += literal.length();
      return true;
    }

    private void skipWhitespace() {
      while (index < source.length() && Character.isWhitespace(source.charAt(index))) index++;
    }

    private char peek() {
      return index < source.length() ? source.charAt(index) : '\0';
    }

    private char take() {
      if (index >= source.length()) throw new IllegalArgumentException("Unexpected end of JSON input");
      return source.charAt(index++);
    }

    private void expect(char expected) {
      char actual = take();
      if (actual != expected) throw new IllegalArgumentException("Unexpected JSON character");
    }
  }
}

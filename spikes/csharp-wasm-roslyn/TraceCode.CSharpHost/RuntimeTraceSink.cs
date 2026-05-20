namespace TraceCode.CSharpHost;

public static class RuntimeTraceSink
{
    private const int MaxNodeDepth = 64;
    private const int MaxCollectionItems = 64;
    private const int MaxObjectFields = 32;
    private static readonly List<RuntimeTraceEvent> Events = new();
    private static readonly List<RuntimeTraceCallFrame> CallStack = new();
    private static readonly HashSet<string> SnapshottedVariablesInCurrentLine = new(StringComparer.Ordinal);
    private static readonly Dictionary<int, int> LineHitCounts = new();
    private static readonly Stack<Dictionary<string, string>> VariableAliasScopes = new();
    private static readonly Dictionary<object, string> TraceReferenceIds = new(ReferenceEqualityComparer.Instance);
    private static DateTime deadlineUtc;
    private static int? maxTraceSteps;
    private static int? maxLineEvents;
    private static int? maxSingleLineHits;
    private static int? maxStoredEvents;
    private static int currentLine;
    private static int scopedSourceLine;
    private static int lineEventCount;
    private static string? timeoutReason;
    private static bool minimalTrace;
    private static bool traceLimitExceeded;
    private static int nextTraceReferenceId;

    public static void Reset()
    {
        Events.Clear();
        CallStack.Clear();
        SnapshottedVariablesInCurrentLine.Clear();
        LineHitCounts.Clear();
        VariableAliasScopes.Clear();
        TraceReferenceIds.Clear();
        deadlineUtc = DateTime.UtcNow.AddSeconds(2);
        maxTraceSteps = null;
        maxLineEvents = null;
        maxSingleLineHits = null;
        maxStoredEvents = null;
        currentLine = 0;
        scopedSourceLine = 0;
        lineEventCount = 0;
        timeoutReason = null;
        minimalTrace = false;
        traceLimitExceeded = false;
        nextTraceReferenceId = 0;
    }

    public static void Configure(
        int timeoutMs,
        int? traceStepLimit,
        int? lineEventLimit = null,
        int? singleLineHitLimit = null,
        int? storedEventLimit = null,
        bool minimalTraceEnabled = false
    )
    {
        int clampedTimeoutMs = Math.Clamp(timeoutMs, 100, 20_000);
        deadlineUtc = DateTime.UtcNow.AddMilliseconds(clampedTimeoutMs);
        maxTraceSteps = PositiveBudget(traceStepLimit);
        maxLineEvents = PositiveBudget(lineEventLimit);
        maxSingleLineHits = PositiveBudget(singleLineHitLimit);
        maxStoredEvents = PositiveBudget(storedEventLimit);
        minimalTrace = minimalTraceEnabled;
        lineEventCount = 0;
        timeoutReason = null;
        LineHitCounts.Clear();
        SnapshottedVariablesInCurrentLine.Clear();
        traceLimitExceeded = false;
    }

    public static List<RuntimeTraceEvent> Snapshot()
    {
        return Events.ToList();
    }

    public static bool TraceLimitExceeded => traceLimitExceeded;

    public static string? TimeoutReason => timeoutReason;

    public static int EventCount => Events.Count;

    public static void Line(int line, string? function)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        currentLine = line;
        SnapshottedVariablesInCurrentLine.Clear();
        if (!CheckLineBudget(line))
        {
            return;
        }

        Add(new RuntimeTraceEvent
        {
            Kind = "line",
            Line = line,
            Function = function,
        });
    }

    public static void Call(string function, int line)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        CallStack.Add(new RuntimeTraceCallFrame
        {
            Function = function,
            Line = line,
        });
        Add(new RuntimeTraceEvent
        {
            Kind = "call",
            Line = line,
            Function = function,
        });
    }

    public static void Call(string function, int line, IReadOnlyList<object?> args)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        CallStack.Add(new RuntimeTraceCallFrame
        {
            Function = function,
            Line = line,
            Args = args.ToList(),
        });
        Add(new RuntimeTraceEvent
        {
            Kind = "call",
            Line = line,
            Function = function,
            Args = args.ToList(),
        });
    }

    public static void Return(string function, int line, object? value = null)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        Add(new RuntimeTraceEvent
        {
            Kind = "return",
            Line = line,
            Function = function,
            Value = value,
        });
    }

    public static void Leave(string function)
    {
        if (CallStack.Count == 0)
        {
            return;
        }

        int topIndex = CallStack.Count - 1;
        if (string.IsNullOrWhiteSpace(function) || CallStack[topIndex].Function == function)
        {
            CallStack.RemoveAt(topIndex);
            return;
        }

        for (int index = topIndex; index >= 0; index--)
        {
            if (CallStack[index].Function == function)
            {
                CallStack.RemoveRange(index, CallStack.Count - index);
                return;
            }
        }
    }

    public static void Exception(int line, string? message)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        Add(new RuntimeTraceEvent
        {
            Kind = "exception",
            Line = line,
            Message = message ?? "Exception",
        });
    }

    public static void Write(string variable, object? value, int line)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        Add(new RuntimeTraceEvent
        {
            Kind = "write",
            Line = line,
            Target = new RuntimeTraceTarget { Variable = ResolveVariableAlias(variable) },
            Value = value,
        });
    }

    public static void IndexedRead(string variable, object index, object? value, int line)
    {
        IndexedRead(variable, new object?[] { index }, value, line);
    }

    public static void IndexedRead(string variable, object index, object? value, int line, string? bindingVariable, IReadOnlyList<string?>? indexSources)
    {
        IndexedRead(variable, new object?[] { index }, value, line, bindingVariable, indexSources);
    }

    public static void IndexedRead(string variable, IReadOnlyList<object?> path, object? value, int line)
    {
        IndexedRead(variable, path, value, line, null);
    }

    public static void IndexedRead(string variable, IReadOnlyList<object?> path, object? value, int line, string? bindingVariable)
    {
        IndexedRead(variable, path, value, line, bindingVariable, null);
    }

    public static void IndexedRead(string variable, IReadOnlyList<object?> path, object? value, int line, string? bindingVariable, IReadOnlyList<string?>? indexSources)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        RuntimeTraceEvent traceEvent = new RuntimeTraceEvent
        {
            Kind = "read",
            Line = line,
            Target = new RuntimeTraceTarget
            {
                Variable = ResolveVariableAlias(variable),
                Path = path.ToList(),
                IndexSources = NormalizeIndexSources(indexSources, path.Count),
            },
            Value = value,
        };
        if (!string.IsNullOrWhiteSpace(bindingVariable))
        {
            traceEvent.Binding = new RuntimeTraceBinding
            {
                Kind = "iteration",
                Variable = bindingVariable,
            };
        }
        Add(traceEvent);
    }

    public static IEnumerable<T> IterationBind<T>(
        IEnumerable<T> values,
        string variable,
        string bindingVariable,
        int line,
        string? function = null,
        bool emitInitialLine = true,
        Action? snapshot = null
    )
    {
        int index = 0;
        using IEnumerator<T> enumerator = values.GetEnumerator();
        if (!enumerator.MoveNext())
        {
            if (emitInitialLine)
            {
                Line(line, function);
                snapshot?.Invoke();
            }
            yield break;
        }

        do
        {
            T item = enumerator.Current;
            if (!string.IsNullOrWhiteSpace(variable))
            {
                IndexedRead(variable, new object?[] { index }, item, line, bindingVariable);
            }
            if (!string.IsNullOrWhiteSpace(bindingVariable))
            {
                Write(bindingVariable, item, line);
            }
            index++;
            Line(line, function);
            snapshot?.Invoke();
            yield return item;
        }
        while (enumerator.MoveNext());
        Line(line, function);
        snapshot?.Invoke();
    }

    public static IEnumerable<T> NestedIterationBind<T>(
        IEnumerable<T> values,
        string variable,
        object? parentIndex,
        string? parentIndexSource,
        string bindingVariable,
        int line,
        string? function = null,
        bool emitInitialLine = true,
        Action? snapshot = null
    )
    {
        int index = 0;
        using IEnumerator<T> enumerator = values.GetEnumerator();
        if (!enumerator.MoveNext())
        {
            if (emitInitialLine)
            {
                Line(line, function);
                snapshot?.Invoke();
            }
            yield break;
        }

        do
        {
            T item = enumerator.Current;
            if (!string.IsNullOrWhiteSpace(variable))
            {
                IndexedRead(
                    variable,
                    new object?[] { parentIndex, index },
                    item,
                    line,
                    bindingVariable,
                    new string?[] { parentIndexSource, null }
                );
            }
            if (!string.IsNullOrWhiteSpace(bindingVariable))
            {
                Write(bindingVariable, item, line);
            }
            index++;
            Line(line, function);
            snapshot?.Invoke();
            yield return item;
        }
        while (enumerator.MoveNext());
        Line(line, function);
        snapshot?.Invoke();
    }

    public static void IndexedWrite(string variable, object index, object? value, int line)
    {
        IndexedWrite(variable, new object?[] { index }, value, line);
    }

    public static void IndexedWrite(string variable, object index, object? value, int line, IReadOnlyList<string?>? indexSources)
    {
        IndexedWrite(variable, new object?[] { index }, value, line, indexSources);
    }

    public static void IndexedWrite(string variable, IReadOnlyList<object?> path, object? value, int line)
    {
        IndexedWrite(variable, path, value, line, null);
    }

    public static void IndexedWrite(string variable, IReadOnlyList<object?> path, object? value, int line, IReadOnlyList<string?>? indexSources)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        Add(new RuntimeTraceEvent
        {
            Kind = "write",
            Line = line,
            Target = new RuntimeTraceTarget
            {
                Variable = ResolveVariableAlias(variable),
                Path = path.ToList(),
                IndexSources = NormalizeIndexSources(indexSources, path.Count),
            },
            Value = value,
        });
    }

    public static void FieldRead(string variable, string field, object? value, int line)
    {
        FieldRead(variable, new object?[] { field }, value, line);
    }

    public static void FieldRead(string variable, IReadOnlyList<object?> path, object? value, int line)
    {
        FieldRead(variable, path, value, line, null);
    }

    public static void FieldRead(string variable, IReadOnlyList<object?> path, object? value, int line, IReadOnlyList<string?>? indexSources)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        Add(new RuntimeTraceEvent
        {
            Kind = "read",
            Line = line,
            Target = new RuntimeTraceTarget
            {
                Variable = ResolveVariableAlias(variable),
                Path = path.ToList(),
                IndexSources = NormalizeIndexSources(indexSources, path.Count),
            },
            Value = value,
        });
    }

    public static void FieldWrite(string variable, string field, object? value, int line)
    {
        FieldWrite(variable, new object?[] { field }, value, line);
    }

    public static void FieldWrite(string variable, IReadOnlyList<object?> path, object? value, int line)
    {
        FieldWrite(variable, path, value, line, null);
    }

    public static void FieldWrite(string variable, IReadOnlyList<object?> path, object? value, int line, IReadOnlyList<string?>? indexSources)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        Add(new RuntimeTraceEvent
        {
            Kind = "write",
            Line = line,
            Target = new RuntimeTraceTarget
            {
                Variable = ResolveVariableAlias(variable),
                Path = path.ToList(),
                IndexSources = NormalizeIndexSources(indexSources, path.Count),
            },
            Value = value,
        });
    }

    public static void Mutate(string variable, string method, IReadOnlyList<object?> args)
    {
        Mutate(variable, null, method, args);
    }

    public static void Mutate(string variable, string method, IReadOnlyList<object?> args, int line)
    {
        Mutate(variable, null, method, args, line);
    }

    public static void Mutate(string variable, IReadOnlyList<object?>? path, string method, IReadOnlyList<object?> args)
    {
        Mutate(variable, path, method, args, currentLine);
    }

    public static void Mutate(string variable, IReadOnlyList<object?>? path, string method, IReadOnlyList<object?> args, int line)
    {
        Mutate(variable, path, method, args, line, null);
    }

    public static void Mutate(string variable, IReadOnlyList<object?>? path, string method, IReadOnlyList<object?> args, int line, IReadOnlyList<string?>? indexSources)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        Add(new RuntimeTraceEvent
        {
            Kind = "mutate",
            Line = line,
            Target = new RuntimeTraceTarget
            {
                Variable = ResolveVariableAlias(variable),
                Path = path?.ToList(),
                IndexSources = path is null ? null : NormalizeIndexSources(indexSources, path.Count),
            },
            Method = method,
            Args = args.ToList(),
        });
    }

    public static bool HasMutationSince(int startIndex, string variable, string method, int line)
    {
        string resolvedVariable = ResolveVariableAlias(variable);
        int boundedStartIndex = Math.Clamp(startIndex, 0, Events.Count);
        for (int index = boundedStartIndex; index < Events.Count; index++)
        {
            RuntimeTraceEvent traceEvent = Events[index];
            if (traceEvent.Kind == "mutate"
                && traceEvent.Line == line
                && string.Equals(traceEvent.Method, method, StringComparison.Ordinal)
                && string.Equals(traceEvent.Target?.Variable, resolvedVariable, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    public static void Snapshot(string variable, object? value)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        string resolvedVariable = ResolveVariableAlias(variable);
        if (!MarkSnapshot(resolvedVariable, currentLine))
        {
            return;
        }

        Add(new RuntimeTraceEvent
        {
            Kind = "snapshot",
            Line = currentLine,
            Target = new RuntimeTraceTarget { Variable = resolvedVariable },
            Value = value,
        });
    }

    public static void Snapshot(string variable, object? value, int line)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        string resolvedVariable = ResolveVariableAlias(variable);
        if (!MarkSnapshot(resolvedVariable, line))
        {
            return;
        }

        Add(new RuntimeTraceEvent
        {
            Kind = "snapshot",
            Line = line,
            Target = new RuntimeTraceTarget { Variable = resolvedVariable },
            Value = value,
        });
    }

    private static bool MarkSnapshot(string variable, int line)
    {
        return SnapshottedVariablesInCurrentLine.Add($"{line}:{variable}");
    }

    public static void WithVariableAlias(string actualVariable, string sourceVariable, Action action)
    {
        VariableAliasScopes.Push(new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [actualVariable] = sourceVariable,
        });
        try
        {
            action();
        }
        finally
        {
            VariableAliasScopes.Pop();
        }
    }

    public static T WithVariableAlias<T>(string actualVariable, string sourceVariable, Func<T> action)
    {
        VariableAliasScopes.Push(new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [actualVariable] = sourceVariable,
        });
        try
        {
            return action();
        }
        finally
        {
            VariableAliasScopes.Pop();
        }
    }

    private static string ResolveVariableAlias(string variable)
    {
        foreach (Dictionary<string, string> scope in VariableAliasScopes)
        {
            if (scope.TryGetValue(variable, out string? alias))
            {
                return alias;
            }
        }

        return variable;
    }

    public static int CurrentLine => currentLine;

    public static int ScopedSourceLine => scopedSourceLine > 0 ? scopedSourceLine : currentLine;

    public static void SetCurrentLine(int line)
    {
        if (line > 0)
        {
            currentLine = line;
        }
    }

    public static int CurrentScopedSourceLine => scopedSourceLine;

    public static void SetScopedSourceLine(int line)
    {
        scopedSourceLine = Math.Max(0, line);
    }

    public static void CheckTimeout()
    {
        if (DateTime.UtcNow <= deadlineUtc)
        {
            return;
        }

        Add(new RuntimeTraceEvent
        {
            Kind = "timeout",
            Message = "C# execution timed out.",
        }, enforceTraceBudget: false);
        throw new TraceCodeTimeoutException("C# execution timed out.");
    }

    private static void Add(RuntimeTraceEvent traceEvent, bool enforceTraceBudget = true)
    {
        if (ShouldSuppressForMinimalTrace(traceEvent))
        {
            return;
        }

        if (enforceTraceBudget && StoredEventLimit is int limit && Events.Count >= limit)
        {
            MarkTraceBudgetExceeded("trace-limit");
            return;
        }

        AttachCallStack(traceEvent);
        NormalizeTraceEvent(traceEvent);
        Events.Add(traceEvent);
    }

    private static int? StoredEventLimit
    {
        get
        {
            if (maxStoredEvents is int storedLimit && maxTraceSteps is int traceLimit)
            {
                return Math.Min(storedLimit, traceLimit);
            }

            return maxStoredEvents ?? maxTraceSteps;
        }
    }

    private static int? PositiveBudget(int? budget)
    {
        return budget > 0 ? budget : null;
    }

    private static bool CheckLineBudget(int line)
    {
        lineEventCount++;
        if (maxLineEvents is int lineLimit && lineEventCount > lineLimit)
        {
            StopForLineBudget(line, "line-limit", $"C# line event limit exceeded after {lineLimit} line events.");
            return false;
        }

        int nextHits = LineHitCounts.TryGetValue(line, out int hits) ? hits + 1 : 1;
        LineHitCounts[line] = nextHits;
        if (maxSingleLineHits is int hitLimit && nextHits > hitLimit)
        {
            StopForLineBudget(line, "single-line-limit", $"C# line {line} exceeded {hitLimit} hits.");
            return false;
        }

        return true;
    }

    private static void StopForLineBudget(int line, string reason, string message)
    {
        MarkTraceBudgetExceeded(reason);
        Add(new RuntimeTraceEvent
        {
            Kind = "timeout",
            Line = line,
            Reason = reason,
            Message = message,
        }, enforceTraceBudget: false);
        throw new TraceLimitExceededException(message, reason);
    }

    private static void MarkTraceBudgetExceeded(string reason)
    {
        traceLimitExceeded = true;
        timeoutReason ??= reason;
    }

    private static bool ShouldSuppressForMinimalTrace(RuntimeTraceEvent traceEvent)
    {
        if (!minimalTrace)
        {
            return false;
        }

        return traceEvent.Kind is "snapshot" or "read" or "write" or "mutate" or "control";
    }

    private static void NormalizeTraceEvent(RuntimeTraceEvent traceEvent)
    {
        var references = new ReferenceTracker();
        traceEvent.Value = NormalizeTraceValue(traceEvent.Value, references);
        traceEvent.Args = traceEvent.Args?.Select(arg => NormalizeTraceValue(arg, references)).ToList();
        if (traceEvent.CallStack is not null)
        {
            foreach (RuntimeTraceCallFrame frame in traceEvent.CallStack)
            {
                frame.Args = frame.Args?.Select(arg => NormalizeTraceValue(arg, references)).ToList();
            }
        }
        if (traceEvent.Target?.Path is not null)
        {
            traceEvent.Target.Path = traceEvent.Target.Path.Select(NormalizeTracePathValue).ToList();
            traceEvent.Target.IndexSources = NormalizeIndexSources(traceEvent.Target.IndexSources, traceEvent.Target.Path.Count);
        }
    }

    private static List<string?>? NormalizeIndexSources(IReadOnlyList<string?>? indexSources, int pathLength)
    {
        if (indexSources is null || pathLength <= 0)
        {
            return null;
        }

        List<string?> normalized = new();
        for (int index = 0; index < pathLength; index++)
        {
            string? source = index < indexSources.Count ? indexSources[index] : null;
            normalized.Add(string.IsNullOrWhiteSpace(source) ? null : source);
        }

        return normalized.Any(source => source is not null) ? normalized : null;
    }

    private static void AttachCallStack(RuntimeTraceEvent traceEvent)
    {
        if (CallStack.Count == 0 || traceEvent.CallStack is not null)
        {
            return;
        }

        traceEvent.CallStack = CallStack
            .Select(frame => new RuntimeTraceCallFrame
            {
                Function = frame.Function,
                Line = frame.Line,
                Args = frame.Args?.ToList(),
            })
            .ToList();
    }

    private static object? NormalizeTracePathValue(object? value)
    {
        return NormalizeTraceValue(value);
    }

    private static object? NormalizeTraceValue(object? value)
    {
        return NormalizeTraceValue(value, new ReferenceTracker());
    }

    private static object? NormalizeTraceValue(object? value, ReferenceTracker references)
    {
        return NormalizeTraceValue(value, 0, references);
    }

    private static object? NormalizeTraceValue(object? value, int depth, ReferenceTracker references)
    {
        if (value is null
            || value is string
            || value is bool
            || value is byte
            || value is sbyte
            || value is short
            || value is ushort
            || value is int
            || value is uint
            || value is long
            || value is ulong
            || value is decimal)
        {
            return value;
        }

        if (value is float floatValue)
        {
            return float.IsFinite(floatValue) ? floatValue : floatValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        if (value is double doubleValue)
        {
            return double.IsFinite(doubleValue) ? doubleValue : doubleValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        Type type = value.GetType();
        if (value is Delegate)
        {
            return null;
        }

        if (value is Type typeValue)
        {
            return typeValue.FullName ?? typeValue.Name;
        }

        if (type.FullName?.StartsWith("System.Collections.Generic.LinkedListNode`1", StringComparison.Ordinal) == true)
        {
            return NormalizeFrameworkLinkedListNode(value, depth, references);
        }

        if (type.FullName?.StartsWith("System.ValueTuple`", StringComparison.Ordinal) == true)
        {
            return NormalizeValueTuple(value, depth, references);
        }

        if (IsPriorityQueueType(type))
        {
            return NormalizePriorityQueue(value, depth, references);
        }

        if (value is System.Text.StringBuilder stringBuilder)
        {
            return NormalizeStringBuilder(stringBuilder);
        }

        if (value is System.Collections.IDictionary dictionary)
        {
            return NormalizeDictionary(dictionary, depth, references);
        }

        if (value is Array array)
        {
            return NormalizeArray(array, depth, references);
        }

        if (value is System.Collections.IEnumerable enumerable && IsSafeFrameworkEnumerableType(type))
        {
            return NormalizeEnumerable(enumerable, depth, references);
        }

        return type.Name switch
        {
            "ListNode" => NormalizeListNode(value, depth, references),
            "TreeNode" => NormalizeTreeNode(value, depth, references),
            _ => NormalizeObject(value, depth, references),
        };
    }

    private static bool IsPriorityQueueType(Type type)
    {
        for (Type? current = type; current is not null; current = current.BaseType)
        {
            if (current.IsGenericType
                && current.GetGenericTypeDefinition() == typeof(PriorityQueue<,>))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsSafeFrameworkEnumerableType(Type type)
    {
        if (type.IsArray)
        {
            return true;
        }

        string? fullName = type.FullName;
        if (fullName is null)
        {
            return false;
        }

        return fullName.StartsWith("System.Collections.", StringComparison.Ordinal)
            || fullName.StartsWith("System.Linq.", StringComparison.Ordinal)
            || fullName.StartsWith("TraceCode.Internal.TraceCode", StringComparison.Ordinal)
            || fullName.StartsWith("TraceCode.CSharpHost.TraceCode", StringComparison.Ordinal);
    }

    private static object? NormalizeStringBuilder(System.Text.StringBuilder builder)
    {
        var values = new List<object?>();
        int limit = Math.Min(builder.Length, MaxCollectionItems);
        for (int index = 0; index < limit; index++)
        {
            values.Add(builder[index].ToString());
        }

        return values;
    }

    private static object? NormalizePriorityQueue(object queue, int depth, ReferenceTracker references)
    {
        if (depth >= MaxNodeDepth)
        {
            return new List<object?>();
        }
        if (references.TryCreateReference(queue, queue.GetType().Name, out Dictionary<string, object?> reference))
        {
            return reference;
        }
        references.Track(queue, queue.GetType().Name);

        object? unorderedItems = queue.GetType().GetProperty("UnorderedItems")?.GetValue(queue);
        if (unorderedItems is not System.Collections.IEnumerable items)
        {
            return new List<object?>();
        }

        var values = new List<object?>();
        foreach (object? item in items)
        {
            if (values.Count >= MaxCollectionItems)
            {
                break;
            }

            values.Add(NormalizeTraceValue(GetPriorityQueueElement(item), depth + 1, references));
        }

        return values;
    }

    private static object? GetPriorityQueueElement(object? item)
    {
        if (item is null)
        {
            return null;
        }

        Type itemType = item.GetType();
        return itemType.GetField("Element")?.GetValue(item)
            ?? itemType.GetProperty("Element")?.GetValue(item)
            ?? itemType.GetField("Item1")?.GetValue(item)
            ?? item;
    }

    private static object? NormalizeValueTuple(object tuple, int depth, ReferenceTracker references)
    {
        if (depth >= MaxNodeDepth)
        {
            return tuple.ToString();
        }

        return tuple
            .GetType()
            .GetFields()
            .Where(field => field.Name.StartsWith("Item", StringComparison.Ordinal))
            .OrderBy(field => field.Name, StringComparer.Ordinal)
            .Select(field => NormalizeTraceValue(field.GetValue(tuple), depth + 1, references))
            .ToList();
    }

    private static object? NormalizeDictionary(System.Collections.IDictionary dictionary, int depth, ReferenceTracker references)
    {
        if (depth >= MaxNodeDepth)
        {
            return new List<object?>();
        }
        if (references.TryCreateReference(dictionary, dictionary.GetType().Name, out Dictionary<string, object?> reference))
        {
            return reference;
        }
        references.Track(dictionary, dictionary.GetType().Name);

        var entries = new List<Dictionary<string, object?>>();
        foreach (System.Collections.DictionaryEntry entry in dictionary)
        {
            if (entries.Count >= MaxCollectionItems)
            {
                break;
            }

            entries.Add(new Dictionary<string, object?>
            {
                ["key"] = NormalizeTraceValue(entry.Key, depth + 1, references),
                ["value"] = NormalizeTraceValue(entry.Value, depth + 1, references),
            });
        }

        var result = new Dictionary<string, object?>
        {
            ["__type__"] = "map",
            ["entries"] = entries,
        };
        if (entries.Count < dictionary.Count)
        {
            result["__truncated__"] = true;
            result["remaining"] = dictionary.Count - entries.Count;
        }

        return result;
    }

    private static object? NormalizeArray(Array array, int depth, ReferenceTracker references)
    {
        if (depth >= MaxNodeDepth)
        {
            return new List<object?>();
        }
        if (references.TryCreateReference(array, array.GetType().Name, out Dictionary<string, object?> reference))
        {
            return reference;
        }
        references.Track(array, array.GetType().Name);

        return NormalizeArrayDimension(array, 0, new int[array.Rank], depth, references);
    }

    private static object? NormalizeArrayDimension(Array array, int dimension, int[] indices, int depth, ReferenceTracker references)
    {
        var values = new List<object?>();
        int lower = array.GetLowerBound(dimension);
        int upper = array.GetUpperBound(dimension);
        int limitedUpper = Math.Min(upper, lower + MaxCollectionItems - 1);
        for (int index = lower; index <= limitedUpper; index++)
        {
            indices[dimension] = index;
            values.Add(dimension == array.Rank - 1
                ? NormalizeTraceValue(array.GetValue(indices), depth + 1, references)
                : NormalizeArrayDimension(array, dimension + 1, indices, depth + 1, references));
        }

        return values;
    }

    private static object? NormalizeEnumerable(System.Collections.IEnumerable enumerable, int depth, ReferenceTracker references)
    {
        if (depth >= MaxNodeDepth)
        {
            return new List<object?>();
        }
        if (references.TryCreateReference(enumerable, enumerable.GetType().Name, out Dictionary<string, object?> reference))
        {
            return reference;
        }
        references.Track(enumerable, enumerable.GetType().Name);

        var values = new List<object?>();
        foreach (object? item in enumerable)
        {
            if (values.Count >= MaxCollectionItems)
            {
                break;
            }

            values.Add(NormalizeTraceValue(item, depth + 1, references));
        }

        return values;
    }

    private static object? NormalizeListNode(object node, int depth, ReferenceTracker references)
    {
        if (depth >= MaxNodeDepth)
        {
            return new Dictionary<string, object?> { ["__ref__"] = "ListNode" };
        }
        if (references.TryCreateReference(node, "ListNode", out Dictionary<string, object?> reference))
        {
            return reference;
        }

        Type type = node.GetType();
        object? val = type.GetField("val")?.GetValue(node) ?? type.GetField("value")?.GetValue(node);
        object? next = type.GetField("next")?.GetValue(node);
        var result = new Dictionary<string, object?>
        {
            ["__type__"] = "ListNode",
            ["val"] = NormalizeTraceValue(val, depth + 1, references),
        };
        references.Track(node, "ListNode", result);
        result["next"] = next is null ? null : NormalizeTraceValue(next, depth + 1, references);
        return result;
    }

    private static object? NormalizeTreeNode(object node, int depth, ReferenceTracker references)
    {
        if (depth >= MaxNodeDepth)
        {
            return new Dictionary<string, object?> { ["__ref__"] = "TreeNode" };
        }
        if (references.TryCreateReference(node, "TreeNode", out Dictionary<string, object?> reference))
        {
            return reference;
        }

        Type type = node.GetType();
        object? val = type.GetField("val")?.GetValue(node) ?? type.GetField("value")?.GetValue(node);
        object? left = type.GetField("left")?.GetValue(node);
        object? right = type.GetField("right")?.GetValue(node);
        var result = new Dictionary<string, object?>
        {
            ["__type__"] = "TreeNode",
            ["val"] = NormalizeTraceValue(val, depth + 1, references),
        };
        references.Track(node, "TreeNode", result);
        result["left"] = left is null ? null : NormalizeTraceValue(left, depth + 1, references);
        result["right"] = right is null ? null : NormalizeTraceValue(right, depth + 1, references);
        return result;
    }

    private static object? NormalizeFrameworkLinkedListNode(object node, int depth, ReferenceTracker references)
    {
        if (depth >= MaxNodeDepth)
        {
            return new Dictionary<string, object?> { ["__ref__"] = "LinkedListNode" };
        }
        if (references.TryCreateReference(node, "LinkedListNode", out Dictionary<string, object?> reference))
        {
            return reference;
        }

        object? value = node.GetType().GetProperty("Value")?.GetValue(node);
        var result = new Dictionary<string, object?>
        {
            ["__type__"] = "LinkedListNode",
        };
        references.Track(node, "LinkedListNode", result);
        result["value"] = NormalizeTraceValue(value, depth + 1, references);
        return result;
    }

    private static object? NormalizeObject(object value, int depth, ReferenceTracker references)
    {
        Type type = value.GetType();
        if (type.Namespace?.StartsWith("System", StringComparison.Ordinal) == true)
        {
            return value;
        }

        if (depth >= MaxNodeDepth)
        {
            return new Dictionary<string, object?> { ["__ref__"] = type.Name };
        }
        if (references.TryCreateReference(value, type.Name, out Dictionary<string, object?> reference))
        {
            return reference;
        }

        var result = new Dictionary<string, object?>
        {
            ["__type__"] = type.Name,
        };
        references.Track(value, type.Name, result);

        int emittedFields = 0;
        foreach (System.Reflection.FieldInfo field in type.GetFields(
            System.Reflection.BindingFlags.Public
                | System.Reflection.BindingFlags.NonPublic
                | System.Reflection.BindingFlags.Instance
        ))
        {
            if (emittedFields >= MaxObjectFields)
            {
                return result;
            }

            if (field.IsSpecialName
                || field.Name.Contains("k__BackingField", StringComparison.Ordinal)
                || typeof(Delegate).IsAssignableFrom(field.FieldType)
                || field.FieldType.IsByRef
                || field.FieldType.IsByRefLike
                || field.FieldType.IsPointer)
            {
                continue;
            }

            try
            {
                result[field.Name] = NormalizeTraceValue(field.GetValue(value), depth + 1, references);
                emittedFields++;
            }
            catch
            {
                // Reflection over user helper objects should not make tracing fail.
            }
        }

        foreach (System.Reflection.PropertyInfo property in type.GetProperties(
            System.Reflection.BindingFlags.Public
                | System.Reflection.BindingFlags.Instance
        ))
        {
            if (emittedFields >= MaxObjectFields)
            {
                break;
            }

            if (!property.CanRead
                || property.GetIndexParameters().Length > 0
                || property.PropertyType.IsByRef
                || property.PropertyType.IsByRefLike)
            {
                continue;
            }

            try
            {
                result[property.Name] = NormalizeTraceValue(property.GetValue(value), depth + 1, references);
                emittedFields++;
            }
            catch
            {
                // Some framework properties expose by-ref/pointer-backed values that System.Text.Json
                // cannot represent in the browser host; skip them instead of failing the trace.
            }
        }

        return result;
    }

    private sealed class ReferenceTracker
    {
        private sealed class Entry
        {
            public Entry(string typeName, IDictionary<string, object?>? anchor)
            {
                TypeName = typeName;
                Anchor = anchor;
            }

            public string TypeName { get; }
            public IDictionary<string, object?>? Anchor { get; }
            public string? Id { get; set; }
        }

        private readonly Dictionary<object, Entry> entries = new(ReferenceEqualityComparer.Instance);

        public void Track(object value, string typeName, IDictionary<string, object?>? anchor = null)
        {
            if (!entries.ContainsKey(value))
            {
                entries[value] = new Entry(typeName, anchor);
            }
        }

        public bool TryCreateReference(object value, string typeName, out Dictionary<string, object?> reference)
        {
            if (!entries.TryGetValue(value, out Entry? entry))
            {
                reference = new Dictionary<string, object?>();
                return false;
            }

            string id = entry.Id ??= GetStableTraceReferenceId(value, entry.TypeName);
            if (entry.Anchor is not null)
            {
                entry.Anchor["__id__"] = id;
            }

            reference = new Dictionary<string, object?> { ["__ref__"] = id };
            return true;
        }
    }

    private static string GetStableTraceReferenceId(object value, string typeName)
    {
        if (!TraceReferenceIds.TryGetValue(value, out string? id))
        {
            id = $"{typeName}:{++nextTraceReferenceId}";
            TraceReferenceIds[value] = id;
        }

        return id;
    }
}

public sealed class TraceCodeTimeoutException : Exception
{
    public TraceCodeTimeoutException(string message)
        : base(message)
    {
    }
}

public sealed class TraceLimitExceededException : Exception
{
    public TraceLimitExceededException(string message, string timeoutReason = "trace-limit")
        : base(message)
    {
        TimeoutReason = timeoutReason;
    }

    public string TimeoutReason { get; }
}

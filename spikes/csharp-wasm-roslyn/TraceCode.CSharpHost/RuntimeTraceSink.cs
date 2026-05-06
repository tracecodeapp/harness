namespace TraceCode.CSharpHost;

public static class RuntimeTraceSink
{
    private const int MaxNodeDepth = 64;
    private const int MaxCollectionItems = 64;
    private const int MaxObjectFields = 32;
    private static readonly List<RuntimeTraceEvent> Events = new();
    private static readonly HashSet<string> SnapshottedVariablesInCurrentLine = new(StringComparer.Ordinal);
    private static DateTime deadlineUtc;
    private static int? maxTraceSteps;
    private static int currentLine;
    private static bool traceLimitExceeded;

    public static void Reset()
    {
        Events.Clear();
        SnapshottedVariablesInCurrentLine.Clear();
        deadlineUtc = DateTime.UtcNow.AddSeconds(2);
        maxTraceSteps = null;
        currentLine = 0;
        traceLimitExceeded = false;
    }

    public static void Configure(int timeoutMs, int? traceStepLimit)
    {
        int clampedTimeoutMs = Math.Clamp(timeoutMs, 100, 20_000);
        deadlineUtc = DateTime.UtcNow.AddMilliseconds(clampedTimeoutMs);
        maxTraceSteps = traceStepLimit > 0 ? traceStepLimit : null;
    }

    public static List<RuntimeTraceEvent> Snapshot()
    {
        return Events.ToList();
    }

    public static bool TraceLimitExceeded => traceLimitExceeded;

    public static void Line(int line, string? function)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        currentLine = line;
        SnapshottedVariablesInCurrentLine.Clear();
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
            Target = new RuntimeTraceTarget { Variable = variable },
            Value = value,
        });
    }

    public static void IndexedRead(string variable, object index, object? value, int line)
    {
        IndexedRead(variable, new object?[] { index }, value, line);
    }

    public static void IndexedRead(string variable, IReadOnlyList<object?> path, object? value, int line)
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
                Variable = variable,
                Path = path.ToList(),
            },
            Value = value,
        });
    }

    public static void IndexedWrite(string variable, object index, object? value, int line)
    {
        IndexedWrite(variable, new object?[] { index }, value, line);
    }

    public static void IndexedWrite(string variable, IReadOnlyList<object?> path, object? value, int line)
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
                Variable = variable,
                Path = path.ToList(),
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
                Variable = variable,
                Path = path.ToList(),
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
                Variable = variable,
                Path = path.ToList(),
            },
            Value = value,
        });
    }

    public static void Mutate(string variable, string method, IReadOnlyList<object?> args)
    {
        Mutate(variable, null, method, args);
    }

    public static void Mutate(string variable, IReadOnlyList<object?>? path, string method, IReadOnlyList<object?> args)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        Add(new RuntimeTraceEvent
        {
            Kind = "mutate",
            Line = currentLine,
            Target = new RuntimeTraceTarget
            {
                Variable = variable,
                Path = path?.ToList(),
            },
            Method = method,
            Args = args.ToList(),
        });
    }

    public static void Snapshot(string variable, object? value)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        if (!MarkSnapshot(variable, currentLine))
        {
            return;
        }

        Add(new RuntimeTraceEvent
        {
            Kind = "snapshot",
            Line = currentLine,
            Target = new RuntimeTraceTarget { Variable = variable },
            Value = value,
        });
    }

    public static void Snapshot(string variable, object? value, int line)
    {
        if (traceLimitExceeded)
        {
            return;
        }

        if (!MarkSnapshot(variable, line))
        {
            return;
        }

        Add(new RuntimeTraceEvent
        {
            Kind = "snapshot",
            Line = line,
            Target = new RuntimeTraceTarget { Variable = variable },
            Value = value,
        });
    }

    private static bool MarkSnapshot(string variable, int line)
    {
        return SnapshottedVariablesInCurrentLine.Add($"{line}:{variable}");
    }

    public static int CurrentLine => currentLine;

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
        if (enforceTraceBudget && maxTraceSteps is int limit && Events.Count >= limit)
        {
            traceLimitExceeded = true;
            return;
        }

        NormalizeTraceEvent(traceEvent);
        Events.Add(traceEvent);
    }

    private static void NormalizeTraceEvent(RuntimeTraceEvent traceEvent)
    {
        traceEvent.Value = NormalizeTraceValue(traceEvent.Value);
        traceEvent.Args = traceEvent.Args?.Select(NormalizeTraceValue).ToList();
        if (traceEvent.Target?.Path is not null)
        {
            traceEvent.Target.Path = traceEvent.Target.Path.Select(NormalizeTracePathValue).ToList();
        }
    }

    private static object? NormalizeTracePathValue(object? value)
    {
        return NormalizeTraceValue(value);
    }

    private static object? NormalizeTraceValue(object? value)
    {
        return NormalizeTraceValue(value, 0, new HashSet<object>(ReferenceEqualityComparer.Instance));
    }

    private static object? NormalizeTraceValue(object? value, int depth, ISet<object> seen)
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
            return NormalizeFrameworkLinkedListNode(value, depth, seen);
        }

        if (type.FullName?.StartsWith("System.ValueTuple`", StringComparison.Ordinal) == true)
        {
            return NormalizeValueTuple(value, depth, seen);
        }

        if (value is System.Collections.IDictionary dictionary)
        {
            return NormalizeDictionary(dictionary, depth, seen);
        }

        if (value is Array array)
        {
            return NormalizeArray(array, depth, seen);
        }

        if (value is System.Collections.IEnumerable enumerable)
        {
            return NormalizeEnumerable(enumerable, depth, seen);
        }

        return type.Name switch
        {
            "ListNode" => NormalizeListNode(value, depth, seen),
            "TreeNode" => NormalizeTreeNode(value, depth, seen),
            _ => NormalizeObject(value, depth, seen),
        };
    }

    private static object? NormalizeValueTuple(object tuple, int depth, ISet<object> seen)
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
            .Select(field => NormalizeTraceValue(field.GetValue(tuple), depth + 1, seen))
            .ToList();
    }

    private static object? NormalizeDictionary(System.Collections.IDictionary dictionary, int depth, ISet<object> seen)
    {
        if (depth >= MaxNodeDepth || !seen.Add(dictionary))
        {
            return new List<object?>();
        }

        var entries = new List<Dictionary<string, object?>>();
        foreach (System.Collections.DictionaryEntry entry in dictionary)
        {
            if (entries.Count >= MaxCollectionItems)
            {
                break;
            }

            entries.Add(new Dictionary<string, object?>
            {
                ["key"] = NormalizeTraceValue(entry.Key, depth + 1, seen),
                ["value"] = NormalizeTraceValue(entry.Value, depth + 1, seen),
            });
        }

        return entries;
    }

    private static object? NormalizeArray(Array array, int depth, ISet<object> seen)
    {
        if (depth >= MaxNodeDepth || !seen.Add(array))
        {
            return new List<object?>();
        }

        return NormalizeArrayDimension(array, 0, new int[array.Rank], depth, seen);
    }

    private static object? NormalizeArrayDimension(Array array, int dimension, int[] indices, int depth, ISet<object> seen)
    {
        var values = new List<object?>();
        int lower = array.GetLowerBound(dimension);
        int upper = array.GetUpperBound(dimension);
        int limitedUpper = Math.Min(upper, lower + MaxCollectionItems - 1);
        for (int index = lower; index <= limitedUpper; index++)
        {
            indices[dimension] = index;
            values.Add(dimension == array.Rank - 1
                ? NormalizeTraceValue(array.GetValue(indices), depth + 1, seen)
                : NormalizeArrayDimension(array, dimension + 1, indices, depth + 1, seen));
        }

        return values;
    }

    private static object? NormalizeEnumerable(System.Collections.IEnumerable enumerable, int depth, ISet<object> seen)
    {
        if (depth >= MaxNodeDepth || !seen.Add(enumerable))
        {
            return new List<object?>();
        }

        var values = new List<object?>();
        foreach (object? item in enumerable)
        {
            if (values.Count >= MaxCollectionItems)
            {
                break;
            }

            values.Add(NormalizeTraceValue(item, depth + 1, seen));
        }

        return values;
    }

    private static object? NormalizeListNode(object node, int depth, ISet<object> seen)
    {
        if (depth >= MaxNodeDepth || !seen.Add(node))
        {
            return new Dictionary<string, object?> { ["__ref__"] = "ListNode" };
        }

        Type type = node.GetType();
        object? val = type.GetField("val")?.GetValue(node) ?? type.GetField("value")?.GetValue(node);
        object? next = type.GetField("next")?.GetValue(node);
        return new Dictionary<string, object?>
        {
            ["__type__"] = "ListNode",
            ["val"] = NormalizeTraceValue(val, depth + 1, seen),
            ["next"] = next is null ? null : NormalizeTraceValue(next, depth + 1, seen),
        };
    }

    private static object? NormalizeTreeNode(object node, int depth, ISet<object> seen)
    {
        if (depth >= MaxNodeDepth || !seen.Add(node))
        {
            return new Dictionary<string, object?> { ["__ref__"] = "TreeNode" };
        }

        Type type = node.GetType();
        object? val = type.GetField("val")?.GetValue(node) ?? type.GetField("value")?.GetValue(node);
        object? left = type.GetField("left")?.GetValue(node);
        object? right = type.GetField("right")?.GetValue(node);
        return new Dictionary<string, object?>
        {
            ["__type__"] = "TreeNode",
            ["val"] = NormalizeTraceValue(val, depth + 1, seen),
            ["left"] = left is null ? null : NormalizeTraceValue(left, depth + 1, seen),
            ["right"] = right is null ? null : NormalizeTraceValue(right, depth + 1, seen),
        };
    }

    private static object? NormalizeFrameworkLinkedListNode(object node, int depth, ISet<object> seen)
    {
        if (depth >= MaxNodeDepth || !seen.Add(node))
        {
            return new Dictionary<string, object?> { ["__ref__"] = "LinkedListNode" };
        }

        object? value = node.GetType().GetProperty("Value")?.GetValue(node);
        return new Dictionary<string, object?>
        {
            ["__type__"] = "LinkedListNode",
            ["value"] = NormalizeTraceValue(value, depth + 1, seen),
        };
    }

    private static object? NormalizeObject(object value, int depth, ISet<object> seen)
    {
        Type type = value.GetType();
        if (type.Namespace?.StartsWith("System", StringComparison.Ordinal) == true)
        {
            return value;
        }

        if (depth >= MaxNodeDepth || !seen.Add(value))
        {
            return new Dictionary<string, object?> { ["__ref__"] = type.Name };
        }

        var result = new Dictionary<string, object?>
        {
            ["__type__"] = type.Name,
        };

        int emittedFields = 0;
        foreach (System.Reflection.FieldInfo field in type.GetFields(
            System.Reflection.BindingFlags.Public
                | System.Reflection.BindingFlags.Instance
        ))
        {
            if (emittedFields >= MaxObjectFields)
            {
                return result;
            }

            result[field.Name] = NormalizeTraceValue(field.GetValue(value), depth + 1, seen);
            emittedFields++;
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
                result[property.Name] = NormalizeTraceValue(property.GetValue(value), depth + 1, seen);
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
    public TraceLimitExceededException(string message)
        : base(message)
    {
    }
}

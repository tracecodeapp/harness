namespace TraceCode.CSharpHost;

public static class RuntimeTraceSink
{
    private const int MaxNodeDepth = 64;
    private static readonly List<RuntimeTraceEvent> Events = new();
    private static DateTime deadlineUtc;
    private static int? maxTraceSteps;
    private static int currentLine;

    public static void Reset()
    {
        Events.Clear();
        deadlineUtc = DateTime.UtcNow.AddSeconds(2);
        maxTraceSteps = null;
        currentLine = 0;
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

    public static void Line(int line, string? function)
    {
        currentLine = line;
        Add(new RuntimeTraceEvent
        {
            Kind = "line",
            Line = line,
            Function = function,
        });
    }

    public static void Call(string function, int line)
    {
        Add(new RuntimeTraceEvent
        {
            Kind = "call",
            Line = line,
            Function = function,
        });
    }

    public static void Call(string function, int line, IReadOnlyList<object?> args)
    {
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
        Add(new RuntimeTraceEvent
        {
            Kind = "exception",
            Line = line,
            Message = message ?? "Exception",
        });
    }

    public static void Write(string variable, object? value, int line)
    {
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
        Add(new RuntimeTraceEvent
        {
            Kind = "snapshot",
            Line = line,
            Target = new RuntimeTraceTarget { Variable = variable },
            Value = value,
        });
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
            Events.Add(new RuntimeTraceEvent
            {
                Kind = "timeout",
                Message = "C# trace step limit exceeded.",
            });
            throw new TraceLimitExceededException("C# trace step limit exceeded.");
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
            || value is float
            || value is double
            || value is decimal)
        {
            return value;
        }

        Type type = value.GetType();
        return type.Name switch
        {
            "ListNode" => NormalizeListNode(value, depth, seen),
            "TreeNode" => NormalizeTreeNode(value, depth, seen),
            _ => value,
        };
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

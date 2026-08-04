using System.Globalization;
using System.Text.RegularExpressions;

namespace TraceCode.CSharpHost;

// Shared Roslyn-free trace normalization used by both general execution and
// the disposable prepared runner. Keep this type outside CompilerHost so
// Mono never resolves compiler-generated Roslyn-bearing closure metadata.
public static class TraceEventBackfill
{
    private sealed record SourceCollectionMutation(
        int Position,
        RuntimeTraceTarget Target,
        string Method,
        List<object?> Args
    );

    private static void RemoveSupersededSyntheticSortMutationEvents(
        List<RuntimeTraceEvent> events
    )
    {
        for (int index = events.Count - 1; index >= 0; index -= 1)
        {
            RuntimeTraceEvent traceEvent = events[index];
            if (!traceEvent.IsSyntheticBackfill
                || traceEvent.Kind != "mutate"
                || !string.Equals(traceEvent.Method, "Sort", StringComparison.Ordinal)
                || traceEvent.Target is null)
            {
                continue;
            }

            bool hasObservedSortOnSameLine = false;
            for (int nextIndex = index + 1; nextIndex < events.Count; nextIndex += 1)
            {
                RuntimeTraceEvent next = events[nextIndex];
                if (next.Line != traceEvent.Line)
                {
                    break;
                }
                if (next.Kind == "mutate"
                    && string.Equals(next.Method, "Sort", StringComparison.Ordinal)
                    && !next.IsSyntheticBackfill
                    && next.Target is not null
                    && TargetsEqual(next.Target, traceEvent.Target))
                {
                    hasObservedSortOnSameLine = true;
                    break;
                }
            }

            if (hasObservedSortOnSameLine)
            {
                events.RemoveAt(index);
            }
        }
    }

    public static void Apply(
        string source,
        List<RuntimeTraceEvent> events,
        bool minimalTrace = false
    )
    {
        if (minimalTrace)
        {
            return;
        }

        string[] sourceLines = source.Split('\n');
        Dictionary<string, object?> latestValues = new(StringComparer.Ordinal);
        for (int index = 0; index < events.Count; index += 1)
        {
            RuntimeTraceEvent lineEvent = events[index];
            if (lineEvent.Kind != "line" || lineEvent.Line is not int line || line <= 0 || line > sourceLines.Length)
            {
                TrackLatestTraceValue(latestValues, lineEvent);
                continue;
            }

            int end = index + 1;
            while (end < events.Count
                && (events[end].Kind != "line"
                    || events[end].Line == line))
            {
                end += 1;
            }

            List<SourceCollectionMutation> mutations =
                FindSourceCollectionMutations(sourceLines[line - 1]);
            if (mutations.Count == 0)
            {
                TrackLatestTraceValues(latestValues, events, index + 1, end);
                index = end - 1;
                continue;
            }

            List<RuntimeTraceEvent> observedMutations = events
                .Skip(index + 1)
                .Take(end - index - 1)
                .Where(traceEvent =>
                    traceEvent.Kind == "mutate"
                    && traceEvent.Target is not null)
                .ToList();
            bool[] consumedObservedMutations =
                new bool[observedMutations.Count];
            Dictionary<string, object?> workingValues =
                new(StringComparer.Ordinal);

            var inserts = new List<RuntimeTraceEvent>();
            foreach (SourceCollectionMutation mutation in mutations)
            {
                bool hasMutation = TryConsumeObservedMutation(
                    mutation,
                    observedMutations,
                    consumedObservedMutations
                );
                string targetKey = TargetKey(mutation.Target);
                if (!workingValues.TryGetValue(
                        targetKey,
                        out object? baseValue
                    ))
                {
                    baseValue = latestValues.TryGetValue(
                        targetKey,
                        out object? knownValue
                    )
                        ? knownValue
                        : FindLatestLineValue(
                            events,
                            index + 1,
                            end,
                            mutation.Target
                        );
                }

                if (!hasMutation)
                {
                    inserts.Add(new RuntimeTraceEvent
                    {
                        IsSyntheticBackfill = true,
                        Kind = "mutate",
                        RunId = lineEvent.RunId,
                        File = lineEvent.File,
                        Line = line,
                        Target = mutation.Target,
                        Method = mutation.Method,
                        Args = mutation.Args,
                        CallStack = lineEvent.CallStack,
                    });
                }

                if (TryDerivePostCollectionMutationValue(
                        mutation.Method,
                        baseValue,
                        mutation.Args,
                        out object? postValue
                    ))
                {
                    if (!HasPostCollectionWrite(
                            events,
                            index + 1,
                            end,
                            mutation.Target,
                            postValue
                        )
                        && !HasPostCollectionWrite(
                            inserts,
                            0,
                            inserts.Count,
                            mutation.Target,
                            postValue
                        ))
                    {
                        inserts.Add(new RuntimeTraceEvent
                        {
                            Kind = "write",
                            RunId = lineEvent.RunId,
                            File = lineEvent.File,
                            Line = line,
                            Target = CloneTarget(mutation.Target),
                            Value = postValue,
                            CallStack = lineEvent.CallStack,
                        });
                        inserts.AddRange(
                            CreateIndexedWriteEvents(
                                lineEvent,
                                mutation.Target,
                                postValue
                            )
                        );
                    }
                    workingValues[targetKey] = postValue;
                }
                else if (hasMutation
                    && TryFindLatestValueAfterMutation(
                        events,
                        index + 1,
                        end,
                        mutation.Target,
                        mutation.Method,
                        out object? observedPostValue
                    )
                    && observedPostValue is not string
                    && observedPostValue is
                        System.Collections.IEnumerable)
                {
                    if (!HasPostCollectionWrite(
                            events,
                            index + 1,
                            end,
                            mutation.Target,
                            observedPostValue
                        )
                        && !HasPostCollectionWrite(
                            inserts,
                            0,
                            inserts.Count,
                            mutation.Target,
                            observedPostValue
                        ))
                    {
                        inserts.Add(new RuntimeTraceEvent
                        {
                            Kind = "write",
                            RunId = lineEvent.RunId,
                            File = lineEvent.File,
                            Line = line,
                            Target = CloneTarget(mutation.Target),
                            Value = observedPostValue,
                            CallStack = lineEvent.CallStack,
                        });
                        inserts.AddRange(
                            CreateIndexedWriteEvents(
                                lineEvent,
                                mutation.Target,
                                observedPostValue
                            )
                        );
                    }
                    workingValues[targetKey] = observedPostValue;
                }
            }

            TrackLatestTraceValues(latestValues, events, index + 1, end);
            foreach (
                KeyValuePair<string, object?> workingValue
                in workingValues
            )
            {
                latestValues[workingValue.Key] = workingValue.Value;
            }

            if (inserts.Count > 0)
            {
                events.InsertRange(end, inserts);
                index = end + inserts.Count - 1;
            }
            else
            {
                index = end - 1;
            }
        }
        RemoveSupersededSyntheticSortMutationEvents(events);
    }

    private static List<SourceCollectionMutation>
        FindSourceCollectionMutations(string sourceLine)
    {
        MatchCollection matches = Regex.Matches(
            sourceLine,
            @"\b(?:(this)\s*\.\s*)?([A-Za-z_]\w*)\s*\.\s*(Sort|RemoveAt)\s*\(([^)]*)\)"
        );
        var mutations = new List<SourceCollectionMutation>(
            matches.Count
        );
        foreach (Match match in matches)
        {
            string receiver = match.Groups[2].Value;
            string method = match.Groups[3].Value;
            string rawArguments = match.Groups[4].Value.Trim();
            RuntimeTraceTarget target = match.Groups[1].Success
                ? new RuntimeTraceTarget
                {
                    Variable = "this",
                    Path = new List<object?> { receiver },
                }
                : new RuntimeTraceTarget { Variable = receiver };
            List<object?> args = method == "RemoveAt"
                ? new List<object?>
                {
                    ParseMutationArgument(rawArguments),
                }
                : string.IsNullOrWhiteSpace(rawArguments)
                    ? new List<object?>()
                    : new List<object?>
                    {
                        "<unobserved-source-arguments>",
                    };
            mutations.Add(
                new SourceCollectionMutation(
                    match.Index,
                    target,
                    method,
                    args
                )
            );
        }

        return mutations
            .OrderBy(mutation => mutation.Position)
            .ToList();
    }

    private static bool TryConsumeObservedMutation(
        SourceCollectionMutation mutation,
        IReadOnlyList<RuntimeTraceEvent> observedMutations,
        bool[] consumed
    )
    {
        for (int index = 0; index < observedMutations.Count; index += 1)
        {
            RuntimeTraceEvent observed = observedMutations[index];
            if (!consumed[index]
                && string.Equals(
                    observed.Method,
                    mutation.Method,
                    StringComparison.Ordinal
                )
                && observed.Target is not null
                && TargetsEqual(observed.Target, mutation.Target))
            {
                consumed[index] = true;
                return true;
            }
        }

        return false;
    }

    private static void TrackLatestTraceValues(Dictionary<string, object?> latestValues, List<RuntimeTraceEvent> events, int start, int end)
    {
        for (int index = start; index < end; index += 1)
        {
            TrackLatestTraceValue(latestValues, events[index]);
        }
    }

    private static void TrackLatestTraceValue(Dictionary<string, object?> latestValues, RuntimeTraceEvent traceEvent)
    {
        if (traceEvent.Kind is not ("read" or "write" or "snapshot") || traceEvent.Target is null)
        {
            return;
        }

        latestValues[TargetKey(traceEvent.Target)] = traceEvent.Value;
    }

    private static object? FindLatestLineValue(List<RuntimeTraceEvent> events, int start, int end, RuntimeTraceTarget target)
    {
        for (int index = end - 1; index >= start; index -= 1)
        {
            RuntimeTraceEvent traceEvent = events[index];
            if (traceEvent.Kind is ("read" or "write" or "snapshot")
                && traceEvent.Target is not null
                && TargetsEqual(traceEvent.Target, target))
            {
                return traceEvent.Value;
            }
        }
        return null;
    }

    private static bool TryFindLatestValueAfterMutation(
        List<RuntimeTraceEvent> events,
        int start,
        int end,
        RuntimeTraceTarget target,
        string method,
        out object? value)
    {
        bool sawMutation = false;
        bool sawValue = false;
        value = null;
        for (int index = start; index < end; index += 1)
        {
            RuntimeTraceEvent traceEvent = events[index];
            if (traceEvent.Kind == "mutate"
                && string.Equals(traceEvent.Method, method, StringComparison.Ordinal)
                && traceEvent.Target is not null
                && TargetsEqual(traceEvent.Target, target))
            {
                sawMutation = true;
                sawValue = false;
                value = null;
                continue;
            }

            if (sawMutation
                && traceEvent.Kind is ("read" or "write" or "snapshot")
                && traceEvent.Target is not null
                && TargetsEqual(traceEvent.Target, target))
            {
                sawValue = true;
                value = traceEvent.Value;
            }
        }

        return sawValue;
    }

    private static bool TryDerivePostCollectionMutationValue(string method, object? baseValue, IReadOnlyList<object?> args, out object? postValue)
    {
        postValue = null;
        if (baseValue is string || baseValue is not System.Collections.IEnumerable enumerable)
        {
            return false;
        }

        List<object?> values = enumerable.Cast<object?>().ToList();
        if (method == "Sort")
        {
            if (args.Count > 0
                || !values.All(IsDeterministicallySortableTraceValue))
            {
                return false;
            }
            values.Sort(CompareTraceValues);
            postValue = values;
            return true;
        }

        if (method == "RemoveAt"
            && args.Count >= 1
            && TryCoerceIndex(args[0], out int index)
            && index >= 0
            && index < values.Count)
        {
            values.RemoveAt(index);
            postValue = values;
            return true;
        }

        return false;
    }

    private static bool HasPostCollectionWrite(List<RuntimeTraceEvent> events, int start, int end, RuntimeTraceTarget target, object? postValue)
    {
        for (int index = start; index < end; index += 1)
        {
            RuntimeTraceEvent traceEvent = events[index];
            if (traceEvent.Kind == "write"
                && traceEvent.Target is not null
                && TargetsEqual(traceEvent.Target, target)
                && TraceValuesEqual(traceEvent.Value, postValue))
            {
                return true;
            }
        }
        return false;
    }

    private static bool TraceValuesEqual(object? left, object? right)
    {
        if (ReferenceEquals(left, right)) return true;
        if (left is null || right is null) return false;
        if (left is string || right is string) return object.Equals(left, right);
        if (left is System.Collections.IEnumerable leftItems && right is System.Collections.IEnumerable rightItems)
        {
            IEnumerator<object?> leftEnumerator = leftItems.Cast<object?>().GetEnumerator();
            IEnumerator<object?> rightEnumerator = rightItems.Cast<object?>().GetEnumerator();
            while (true)
            {
                bool leftHasValue = leftEnumerator.MoveNext();
                bool rightHasValue = rightEnumerator.MoveNext();
                if (leftHasValue != rightHasValue) return false;
                if (!leftHasValue) return true;
                if (!TraceValuesEqual(leftEnumerator.Current, rightEnumerator.Current)) return false;
            }
        }
        return object.Equals(left, right);
    }

    private static int CompareTraceValues(object? left, object? right)
    {
        if (left is null && right is null) return 0;
        if (left is null) return -1;
        if (right is null) return 1;
        if (IsNumericTraceValue(left) && IsNumericTraceValue(right))
        {
            return Convert.ToDecimal(left, CultureInfo.InvariantCulture)
                .CompareTo(Convert.ToDecimal(right, CultureInfo.InvariantCulture));
        }
        return string.CompareOrdinal(Convert.ToString(left, CultureInfo.InvariantCulture), Convert.ToString(right, CultureInfo.InvariantCulture));
    }

    private static bool IsDeterministicallySortableTraceValue(object? value)
    {
        return value is null
            || value is string
            || value is char
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
            || value is decimal;
    }

    private static bool IsNumericTraceValue(object value)
    {
        return value is byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal;
    }

    private static bool TryCoerceIndex(object? value, out int index)
    {
        if (value is int intValue)
        {
            index = intValue;
            return true;
        }
        if (value is long longValue && longValue >= int.MinValue && longValue <= int.MaxValue)
        {
            index = (int)longValue;
            return true;
        }
        if (value is string text && int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsed))
        {
            index = parsed;
            return true;
        }
        index = 0;
        return false;
    }

    private static IEnumerable<RuntimeTraceEvent> CreateIndexedWriteEvents(RuntimeTraceEvent lineEvent, RuntimeTraceTarget target, object? postValue)
    {
        if (postValue is string || postValue is not System.Collections.IEnumerable enumerable)
        {
            yield break;
        }

        int index = 0;
        foreach (object? item in enumerable)
        {
            yield return new RuntimeTraceEvent
            {
                Kind = "write",
                RunId = lineEvent.RunId,
                File = lineEvent.File,
                Line = lineEvent.Line,
                Target = new RuntimeTraceTarget
                {
                    Variable = target.Variable,
                    Path = AppendPath(target.Path, index),
                },
                Value = item,
                CallStack = lineEvent.CallStack,
            };
            index += 1;
        }
    }

    private static RuntimeTraceTarget CloneTarget(RuntimeTraceTarget target)
    {
        return new RuntimeTraceTarget
        {
            Variable = target.Variable,
            Path = target.Path?.ToList(),
        };
    }

    private static List<object?> AppendPath(IReadOnlyList<object?>? path, object? value)
    {
        var next = path is null ? new List<object?>() : path.ToList();
        next.Add(value);
        return next;
    }

    private static string TargetKey(RuntimeTraceTarget target)
    {
        (string variable, List<object?>? pathParts) = CanonicalTargetParts(target);
        string path = pathParts is null || pathParts.Count == 0
            ? string.Empty
            : string.Join("\u001f", pathParts.Select(part => Convert.ToString(part, CultureInfo.InvariantCulture)));
        return $"{variable}\u001e{path}";
    }

    private static bool TargetsEqual(RuntimeTraceTarget left, RuntimeTraceTarget right)
    {
        (string leftVariable, List<object?>? leftPath) = CanonicalTargetParts(left);
        (string rightVariable, List<object?>? rightPath) = CanonicalTargetParts(right);
        return string.Equals(leftVariable, rightVariable, StringComparison.Ordinal)
            && PathsEqual(leftPath, rightPath);
    }

    private static (string Variable, List<object?>? Path) CanonicalTargetParts(RuntimeTraceTarget target)
    {
        if (target.Path is not null && target.Path.Count > 0)
        {
            if (string.Equals(target.Variable, "this", StringComparison.Ordinal)
                && target.Path[0] is string member
                && !string.IsNullOrWhiteSpace(member))
            {
                return (
                    member,
                    target.Path.Count == 1
                        ? null
                        : target.Path.Skip(1).ToList()
                );
            }
            return (target.Variable, target.Path.ToList());
        }

        string[] parts = target.Variable.Split('.', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length <= 1)
        {
            return (target.Variable, target.Path?.ToList());
        }

        return (parts[0], parts.Skip(1).Cast<object?>().ToList());
    }

    private static object? ParseMutationArgument(string raw)
    {
        return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int integer)
            ? integer
            : raw;
    }

    private static bool PathsEqual(IReadOnlyList<object?>? left, IReadOnlyList<object?>? right)
    {
        if (left is null || left.Count == 0) return right is null || right.Count == 0;
        if (right is null || right.Count == 0) return false;
        if (left.Count != right.Count) return false;
        for (int index = 0; index < left.Count; index += 1)
        {
            if (!object.Equals(left[index], right[index])) return false;
        }
        return true;
    }

}

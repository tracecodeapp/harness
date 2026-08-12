using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Loader;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TraceCode.CSharpHost;

/// <summary>
/// Roslyn-free entrypoint for disposable Judge runners.
///
/// Keep this type graph independent from <see cref="CompilerHost"/>. Mono may
/// resolve compiler-generated nested types when it JITs an exported method, so
/// even calling a seemingly Roslyn-free method on CompilerHost can force the
/// runner to load Microsoft.CodeAnalysis. This class is the hard metadata
/// boundary between the trusted compiler authority and learner execution.
/// </summary>
public static partial class PreparedExecutionHost
{
    private const int MaxInputDepth = 128;
    private const int MaxInputCollectionItems = 200_000;
    private const int MaxInputObjectProperties = 50_000;
    private const int MaxInputTraversalNodes = 750_000;
    private const long MaxArtifactBytes = 8L * 1024 * 1024;
    private const string ArtifactCacheSchema = "tracecode-csharp-compile-v1";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        IncludeFields = true,
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
        MaxDepth = 256,
    };

    [JSExport]
    [SupportedOSPlatform("browser")]
    public static string ExecutePrepared(string requestJson)
    {
        Stopwatch stopwatch = Stopwatch.StartNew();
        TextWriter originalOut = Console.Out;
        using TracingConsoleWriter capturedOut = new();
        Console.SetOut(capturedOut);
        Dictionary<string, object> timings = new()
        {
            ["compileCacheHit"] = false,
            ["hostArtifactCacheHit"] = false,
        };

        try
        {
            PreparedRequest? request = JsonSerializer.Deserialize<PreparedRequest>(
                requestJson,
                JsonOptions
            );
            if (request is null)
            {
                return SerializeError(
                    "Invalid prepared C# execution request.",
                    stopwatch,
                    capturedOut,
                    timings: timings
                );
            }

            request.Inputs ??= new Dictionary<string, JsonElement>(
                StringComparer.Ordinal
            );
            ValidateExecutionInputs(request.Inputs);

            string artifactKey = CompiledArtifactKey(request);
            if (
                !string.Equals(
                    request.CompiledArtifactKey,
                    artifactKey,
                    StringComparison.Ordinal
                ) ||
                string.IsNullOrEmpty(request.CompiledArtifactBase64)
            )
            {
                return SerializeError(
                    "Prepared C# artifact is unavailable or invalid.",
                    stopwatch,
                    capturedOut,
                    timings: timings
                );
            }

            byte[] peBytes;
            try
            {
                peBytes = Convert.FromBase64String(request.CompiledArtifactBase64);
            }
            catch (FormatException)
            {
                return SerializeError(
                    "Prepared C# artifact is unavailable or invalid.",
                    stopwatch,
                    capturedOut,
                    timings: timings
                );
            }

            if (
                peBytes.LongLength > MaxArtifactBytes ||
                peBytes.Length < 2 ||
                peBytes[0] != (byte)'M' ||
                peBytes[1] != (byte)'Z' ||
                string.IsNullOrEmpty(request.CompiledArtifactSha256) ||
                !string.Equals(
                    request.CompiledArtifactSha256,
                    Convert.ToHexString(SHA256.HashData(peBytes))
                        .ToLowerInvariant(),
                    StringComparison.Ordinal
                )
            )
            {
                return SerializeError(
                    "Prepared C# artifact is unavailable or invalid.",
                    stopwatch,
                    capturedOut,
                    timings: timings
                );
            }

            timings["compileCacheHit"] = true;
            timings["hostArtifactCacheHit"] = true;
            timings["compileArtifactKey"] = artifactKey;
            timings["compileArtifactBytes"] = peBytes.LongLength;
            timings["compileMs"] = 0d;

            string inputsJson = JsonSerializer.Serialize(
                request.Inputs,
                JsonOptions
            );
            RuntimeTraceSink.Reset();
            bool recordTrace = request.RecordTrace ?? request.Trace;
            RuntimeTraceSink.Configure(
                request.TimeoutMs,
                recordTrace ? request.MaxTraceSteps : null,
                recordTrace ? request.MaxLineEvents : null,
                recordTrace ? request.MaxSingleLineHits : null,
                recordTrace ? request.MaxStoredEvents : null,
                recordTrace && request.MinimalTrace,
                recordTrace
            );

            double runStartedAt = stopwatch.Elapsed.TotalMilliseconds;
            var loadContext = new UserExecutionLoadContext(
                "TraceCode.PreparedUserExecution." + Guid.NewGuid().ToString("N")
            );
            try
            {
                using MemoryStream assemblyStream = new(peBytes, writable: false);
                Assembly userAssembly = loadContext.LoadFromStream(assemblyStream);
                object? output = InvokeDriver(userAssembly, inputsJson);
                object? normalizedOutput = NormalizeOutput(output);
                timings["runMs"] =
                    stopwatch.Elapsed.TotalMilliseconds - runStartedAt;
                timings["executionRealm"] =
                    "collectible-assembly-load-context";
                List<RuntimeTraceEvent> events =
                    SnapshotTraceEvents(capturedOut);
                TraceEventBackfill.Apply(
                    request.Source,
                    events,
                    recordTrace && request.MinimalTrace
                );
                return Serialize(new PreparedResponse
                {
                    Success = true,
                    Output = normalizedOutput,
                    ConsoleOutput = SplitConsoleOutput(capturedOut),
                    Events = events,
                    TraceLimitExceeded = RuntimeTraceSink.TraceLimitExceeded,
                    TimeoutReason =
                        RuntimeTraceSink.TraceLimitExceeded
                            ? RuntimeTraceSink.TimeoutReason
                            : null,
                    ExecutionTimeMs = stopwatch.Elapsed.TotalMilliseconds,
                    Timings = WithTotalTiming(timings, stopwatch),
                    CompiledArtifactKey = artifactKey,
                });
            }
            finally
            {
                loadContext.Unload();
            }
        }
        catch (Exception error)
            when (error.GetBaseException() is TraceCodeTimeoutException timeout)
        {
            return SerializeError(
                timeout.Message,
                stopwatch,
                capturedOut,
                traceLimitExceeded: RuntimeTraceSink.TraceLimitExceeded,
                timeoutReason: "client-timeout",
                timings: timings
            );
        }
        catch (Exception error)
            when (error.GetBaseException() is TraceLimitExceededException traceLimit)
        {
            return SerializeError(
                traceLimit.Message,
                stopwatch,
                capturedOut,
                traceLimitExceeded: true,
                timeoutReason: traceLimit.TimeoutReason,
                timings: timings
            );
        }
        catch (Exception error)
        {
            return SerializeError(
                error.GetBaseException().Message,
                stopwatch,
                capturedOut,
                timings: timings
            );
        }
        finally
        {
            RuntimeTraceSink.Reset();
            Console.SetOut(originalOut);
        }
    }

    [JSExport]
    [SupportedOSPlatform("browser")]
    public static bool DisposePreparedArtifact(string artifactKey) => true;

    // Marshaling a multi-megabyte response as a JS string forces a UTF-16
    // conversion at the interop boundary; a byte[] crosses as a Uint8Array
    // memcpy and the worker decodes it with TextDecoder instead.
    [JSExport]
    [SupportedOSPlatform("browser")]
    public static byte[] ExecutePreparedUtf8(string requestJson) =>
        Encoding.UTF8.GetBytes(ExecutePrepared(requestJson));

    private static string CompiledArtifactKey(PreparedRequest request)
    {
        StringBuilder key = new();
        key.Append(ArtifactCacheSchema).Append('\n');
        AppendCacheKeyPart(key, request.Source);
        AppendCacheKeyPart(key, request.FunctionName);
        AppendCacheKeyPart(key, request.ExecutionStyle);
        key.Append(request.Trace ? "trace\n" : "plain\n");
        key.Append("prepared-driver-v2\n");
        AppendCacheKeyPart(key, request.PreparedRunnerTier);
        return Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(key.ToString()))
        ).ToLowerInvariant();
    }

    private static void AppendCacheKeyPart(StringBuilder target, string value)
    {
        target.Append(value.Length).Append(':').Append(value).Append('\n');
    }

    private static void ValidateExecutionInputs(
        IReadOnlyDictionary<string, JsonElement> inputs
    )
    {
        InputTraversalBudget budget = new();
        int inputIndex = 0;
        foreach (KeyValuePair<string, JsonElement> input in inputs)
        {
            budget.RecordObjectProperty(inputIndex++, "C# inputs");
            ValidateInputElement(input.Value, budget, 0);
        }
    }

    private static void ValidateInputElement(
        JsonElement value,
        InputTraversalBudget budget,
        int depth
    )
    {
        budget.EnterNode(depth);
        if (value.ValueKind == JsonValueKind.Array)
        {
            int itemIndex = 0;
            foreach (JsonElement item in value.EnumerateArray())
            {
                budget.RecordCollectionItem(itemIndex++, "C# input array");
                ValidateInputElement(item, budget, depth + 1);
            }
        }
        else if (value.ValueKind == JsonValueKind.Object)
        {
            int propertyIndex = 0;
            foreach (JsonProperty property in value.EnumerateObject())
            {
                budget.RecordObjectProperty(
                    propertyIndex++,
                    "C# input object"
                );
                ValidateInputElement(property.Value, budget, depth + 1);
            }
        }
    }

    private static object? InvokeDriver(Assembly userAssembly, string inputsJson)
    {
        Type driverType = userAssembly.GetType("TraceCodeDriver")
            ?? throw new InvalidOperationException(
                "TraceCode generated driver was not found."
            );
        MethodInfo method = driverType.GetMethod(
            "Run",
            BindingFlags.Static | BindingFlags.Public
        ) ?? throw new InvalidOperationException(
            "TraceCode generated driver did not expose Run()."
        );
        object? result = method.Invoke(null, new object?[] { inputsJson });
        if (result is not Task task)
        {
            return result;
        }

        task.GetAwaiter().GetResult();
        Type taskType = result.GetType();
        return taskType.IsGenericType
            ? taskType
                .GetProperty("Result", BindingFlags.Instance | BindingFlags.Public)
                ?.GetValue(result)
            : null;
    }

    private static object? NormalizeOutput(object? output)
    {
        if (output is null) return null;
        object? normalized = NormalizeOutputValue(
            output,
            0,
            new OutputReferenceTracker()
        );
        string json = JsonSerializer.Serialize(
            normalized,
            normalized?.GetType() ?? typeof(object),
            JsonOptions
        );
        return JsonSerializer.Deserialize<JsonElement>(json, JsonOptions);
    }

    private static object? NormalizeOutputValue(
        object? value,
        int depth,
        OutputReferenceTracker references
    )
    {
        RuntimeTraceSink.CheckTimeout();
        if (
            value is null ||
            value is string ||
            value is bool ||
            value is byte ||
            value is sbyte ||
            value is short ||
            value is ushort ||
            value is int ||
            value is uint ||
            value is long ||
            value is ulong ||
            value is float ||
            value is double ||
            value is decimal ||
            value is char ||
            value is JsonElement
        )
        {
            return value;
        }
        if (depth > 64) return "<max depth>";

        Type type = value.GetType();
        if (type.IsEnum) return value.ToString();
        if (
            type.Namespace?.StartsWith("System", StringComparison.Ordinal) == true &&
            value is not System.Collections.IDictionary &&
            value is not System.Collections.IEnumerable
        )
        {
            return value;
        }

        if (value is System.Collections.IDictionary dictionary)
        {
            if (
                references.TryCreateReference(
                    value,
                    type.Name,
                    out Dictionary<string, object?> reference
                )
            )
            {
                return reference;
            }
            references.Track(value, type.Name);
            Dictionary<string, object?> result = new();
            foreach (System.Collections.DictionaryEntry entry in dictionary)
            {
                RuntimeTraceSink.CheckTimeout();
                result[NormalizeOutputKey(entry.Key)] = NormalizeOutputValue(
                    entry.Value,
                    depth + 1,
                    references
                );
            }
            return result;
        }

        if (value is Array array)
        {
            if (
                references.TryCreateReference(
                    value,
                    type.Name,
                    out Dictionary<string, object?> reference
                )
            )
            {
                return reference;
            }
            references.Track(value, type.Name);
            return NormalizeOutputArray(
                array,
                0,
                new int[array.Rank],
                depth,
                references
            );
        }

        if (value is System.Collections.IEnumerable enumerable)
        {
            if (
                references.TryCreateReference(
                    value,
                    type.Name,
                    out Dictionary<string, object?> reference
                )
            )
            {
                return reference;
            }
            references.Track(value, type.Name);
            List<object?> result = new();
            foreach (object? item in enumerable)
            {
                RuntimeTraceSink.CheckTimeout();
                result.Add(
                    NormalizeOutputValue(item, depth + 1, references)
                );
            }
            return result;
        }

        return NormalizeOutputObject(value, type, depth, references);
    }

    private static string NormalizeOutputKey(object? key) =>
        key switch
        {
            null => "null",
            string text => text,
            bool flag => flag ? "true" : "false",
            IFormattable formattable =>
                formattable.ToString(null, CultureInfo.InvariantCulture),
            _ => Convert.ToString(key, CultureInfo.InvariantCulture) ?? "null",
        };

    private static object? NormalizeOutputArray(
        Array array,
        int dimension,
        int[] indices,
        int depth,
        OutputReferenceTracker references
    )
    {
        List<object?> values = new();
        int lower = array.GetLowerBound(dimension);
        int upper = array.GetUpperBound(dimension);
        for (int index = lower; index <= upper; index++)
        {
            RuntimeTraceSink.CheckTimeout();
            indices[dimension] = index;
            values.Add(
                dimension == array.Rank - 1
                    ? NormalizeOutputValue(
                        array.GetValue(indices),
                        depth + 1,
                        references
                    )
                    : NormalizeOutputArray(
                        array,
                        dimension + 1,
                        indices,
                        depth + 1,
                        references
                    )
            );
        }
        return values;
    }

    private static object? NormalizeOutputObject(
        object value,
        Type type,
        int depth,
        OutputReferenceTracker references
    )
    {
        if (
            references.TryCreateReference(
                value,
                type.Name,
                out Dictionary<string, object?> reference
            )
        )
        {
            return reference;
        }

        Dictionary<string, object?> result = new();
        references.Track(value, type.Name, result);
        foreach (
            FieldInfo field in OrderOutputMembers(
                type.GetFields(BindingFlags.Public | BindingFlags.Instance)
            )
        )
        {
            RuntimeTraceSink.CheckTimeout();
            result[field.Name] = NormalizeOutputValue(
                field.GetValue(value),
                depth + 1,
                references
            );
        }
        foreach (
            PropertyInfo property in OrderOutputMembers(
                type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            )
        )
        {
            RuntimeTraceSink.CheckTimeout();
            if (
                result.ContainsKey(property.Name) ||
                !property.CanRead ||
                property.GetIndexParameters().Length > 0 ||
                property.PropertyType.IsByRef ||
                property.PropertyType.IsByRefLike
            )
            {
                continue;
            }
            try
            {
                result[property.Name] = NormalizeOutputValue(
                    property.GetValue(value),
                    depth + 1,
                    references
                );
            }
            catch (Exception error)
                when (
                    error.GetBaseException()
                        is TraceCodeTimeoutException
                            or TraceLimitExceededException
                )
            {
                throw;
            }
            catch
            {
                // User accessors may throw. Keep output conversion best-effort.
            }
        }
        return result.Count > 0 ? result : value;
    }

    private static IEnumerable<T> OrderOutputMembers<T>(IEnumerable<T> members)
        where T : MemberInfo =>
        members.OrderBy(member => member.Name == "__type__" ? 0 : 1);

    private static string SerializeError(
        string error,
        Stopwatch stopwatch,
        StringWriter capturedOut,
        bool traceLimitExceeded = false,
        string? timeoutReason = null,
        IDictionary<string, object>? timings = null
    ) =>
        Serialize(new PreparedResponse
        {
            Success = false,
            Error = error,
            ConsoleOutput = SplitConsoleOutput(capturedOut),
            Events = SnapshotTraceEvents(capturedOut),
            TraceLimitExceeded = traceLimitExceeded,
            TimeoutReason = timeoutReason,
            ExecutionTimeMs = stopwatch.Elapsed.TotalMilliseconds,
            Timings = WithTotalTiming(timings, stopwatch),
        });

    private static Dictionary<string, object> WithTotalTiming(
        IDictionary<string, object>? timings,
        Stopwatch stopwatch
    )
    {
        Dictionary<string, object> result =
            timings is null
                ? new Dictionary<string, object>(StringComparer.Ordinal)
                : new Dictionary<string, object>(timings, StringComparer.Ordinal);
        result["totalMs"] = stopwatch.Elapsed.TotalMilliseconds;
        return result;
    }

    private static string Serialize(PreparedResponse response)
    {
        // Reflection-based System.Text.Json cannot be AOT-compiled for these
        // object-graph payloads and runs interpreted under wasm, costing
        // ~40us per trace event on heavy responses. The known response and
        // event shapes are written directly; only unrecognized leaf values
        // fall back to the reflection serializer.
        using MemoryStream stream = new();
        using (Utf8JsonWriter writer = new(stream))
        {
            writer.WriteStartObject();
            writer.WriteBoolean("success", response.Success);
            writer.WritePropertyName("output");
            TraceResponseJson.WriteNormalizedValue(writer, response.Output, JsonOptions);
            if (response.Error is null) writer.WriteNull("error");
            else writer.WriteString("error", response.Error);
            writer.WritePropertyName("diagnostics");
            JsonSerializer.Serialize(writer, response.Diagnostics, JsonOptions);
            writer.WriteStartArray("consoleOutput");
            foreach (string line in response.ConsoleOutput)
            {
                writer.WriteStringValue(line);
            }
            writer.WriteEndArray();
            writer.WriteStartArray("events");
            foreach (RuntimeTraceEvent traceEvent in response.Events)
            {
                TraceResponseJson.WriteTraceEvent(writer, traceEvent, JsonOptions);
            }
            writer.WriteEndArray();
            writer.WriteNumber("executionTimeMs", response.ExecutionTimeMs);
            writer.WriteBoolean("traceLimitExceeded", response.TraceLimitExceeded);
            if (response.TimeoutReason is null) writer.WriteNull("timeoutReason");
            else writer.WriteString("timeoutReason", response.TimeoutReason);
            writer.WritePropertyName("timings");
            JsonSerializer.Serialize(writer, response.Timings, JsonOptions);
            if (response.CompiledArtifactKey is not null)
            {
                writer.WriteString("compiledArtifactKey", response.CompiledArtifactKey);
            }
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static List<string> SplitConsoleOutput(StringWriter capturedOut) =>
        capturedOut
            .ToString()
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .ToList();

    private static List<RuntimeTraceEvent> SnapshotTraceEvents(
        StringWriter capturedOut
    )
    {
        capturedOut.Flush();
        return RuntimeTraceSink.Snapshot();
    }

    private sealed class UserExecutionLoadContext : AssemblyLoadContext
    {
        public UserExecutionLoadContext(string name)
            : base(name, isCollectible: true) { }

        protected override Assembly? Load(AssemblyName assemblyName) =>
            AssemblyLoadContext.Default.Assemblies.FirstOrDefault(candidate =>
                AssemblyName.ReferenceMatchesDefinition(
                    candidate.GetName(),
                    assemblyName
                )
            );
    }

    private sealed class InputTraversalBudget
    {
        private int nodes;

        public void EnterNode(int depth)
        {
            if (depth > MaxInputDepth)
            {
                throw new InvalidOperationException(
                    $"C# input exceeds maximum depth of {MaxInputDepth}."
                );
            }
            if (++nodes > MaxInputTraversalNodes)
            {
                throw new InvalidOperationException(
                    $"C# input exceeds maximum JSON value count of {MaxInputTraversalNodes}."
                );
            }
        }

        public void RecordCollectionItem(int index, string label)
        {
            if (index >= MaxInputCollectionItems)
            {
                throw new InvalidOperationException(
                    $"{label} exceeds maximum item count of {MaxInputCollectionItems}."
                );
            }
        }

        public void RecordObjectProperty(int index, string label)
        {
            if (index >= MaxInputObjectProperties)
            {
                throw new InvalidOperationException(
                    $"{label} exceeds maximum property count of {MaxInputObjectProperties}."
                );
            }
        }
    }

    private sealed class OutputReferenceTracker
    {
        private sealed class Entry
        {
            public Entry(
                string typeName,
                IDictionary<string, object?>? anchor
            )
            {
                TypeName = typeName;
                Anchor = anchor;
            }

            public string TypeName { get; }
            public IDictionary<string, object?>? Anchor { get; }
            public string? Id { get; set; }
        }

        private readonly Dictionary<object, Entry> entries = new(
            ReferenceEqualityComparer.Instance
        );
        private int nextId;

        public void Track(
            object value,
            string typeName,
            IDictionary<string, object?>? anchor = null
        )
        {
            if (!entries.ContainsKey(value))
            {
                entries[value] = new Entry(typeName, anchor);
            }
        }

        public bool TryCreateReference(
            object value,
            string typeName,
            out Dictionary<string, object?> reference
        )
        {
            if (!entries.TryGetValue(value, out Entry? entry))
            {
                reference = new Dictionary<string, object?>();
                return false;
            }

            string id = entry.Id ??= $"{entry.TypeName}:{++nextId}";
            if (entry.Anchor is not null)
            {
                entry.Anchor["__id__"] = id;
            }
            reference = new Dictionary<string, object?> { ["__ref__"] = id };
            return true;
        }
    }

    private sealed class TracingConsoleWriter : StringWriter
    {
        private readonly StringBuilder lineBuffer = new();

        public override void Flush()
        {
            base.Flush();
            EmitBufferedPartialLine();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) EmitBufferedPartialLine();
            base.Dispose(disposing);
        }

        public override void Write(char value)
        {
            base.Write(value);
            AppendForTrace(value);
        }

        public override void Write(string? value)
        {
            if (string.IsNullOrEmpty(value)) return;
            base.Write(value);
            foreach (char character in value) AppendForTrace(character);
        }

        public override void Write(char[] buffer, int index, int count)
        {
            base.Write(buffer, index, count);
            foreach (char character in buffer.AsSpan(index, count))
            {
                AppendForTrace(character);
            }
        }

        public override void WriteLine() => Write(NewLine);

        public override void WriteLine(string? value)
        {
            Write(value);
            WriteLine();
        }

        private void AppendForTrace(char value)
        {
            if (value == '\n')
            {
                EmitBufferedLine();
            }
            else if (value != '\r')
            {
                lineBuffer.Append(value);
            }
        }

        private void EmitBufferedLine()
        {
            string text = lineBuffer.ToString();
            lineBuffer.Clear();
            RuntimeTraceSink.Stdout(text);
        }

        private void EmitBufferedPartialLine()
        {
            if (lineBuffer.Length > 0) EmitBufferedLine();
        }
    }

    private sealed class PreparedRequest
    {
        [JsonPropertyName("source")]
        public string Source { get; set; } = string.Empty;

        [JsonPropertyName("functionName")]
        public string FunctionName { get; set; } = string.Empty;

        [JsonPropertyName("inputs")]
        public Dictionary<string, JsonElement> Inputs { get; set; } = new();

        [JsonPropertyName("executionStyle")]
        public string ExecutionStyle { get; set; } = "solution-method";

        [JsonPropertyName("trace")]
        public bool Trace { get; set; }

        [JsonPropertyName("recordTrace")]
        public bool? RecordTrace { get; set; }

        [JsonPropertyName("timeoutMs")]
        public int TimeoutMs { get; set; } = 19_000;

        [JsonPropertyName("maxTraceSteps")]
        public int? MaxTraceSteps { get; set; }

        [JsonPropertyName("maxLineEvents")]
        public int? MaxLineEvents { get; set; }

        [JsonPropertyName("maxSingleLineHits")]
        public int? MaxSingleLineHits { get; set; }

        [JsonPropertyName("maxStoredEvents")]
        public int? MaxStoredEvents { get; set; }

        [JsonPropertyName("minimalTrace")]
        public bool MinimalTrace { get; set; }

        [JsonPropertyName("compiledArtifactKey")]
        public string? CompiledArtifactKey { get; set; }

        [JsonPropertyName("compiledArtifactBase64")]
        public string? CompiledArtifactBase64 { get; set; }

        [JsonPropertyName("compiledArtifactSha256")]
        public string? CompiledArtifactSha256 { get; set; }

        [JsonPropertyName("preparedRunnerTier")]
        public string PreparedRunnerTier { get; set; } = "compatibility";
    }

    private sealed class PreparedResponse
    {
        [JsonPropertyName("success")]
        public bool Success { get; set; }

        [JsonPropertyName("output")]
        public object? Output { get; set; }

        [JsonPropertyName("error")]
        public string? Error { get; set; }

        [JsonPropertyName("diagnostics")]
        public List<object> Diagnostics { get; set; } = new();

        [JsonPropertyName("consoleOutput")]
        public List<string> ConsoleOutput { get; set; } = new();

        [JsonPropertyName("events")]
        public List<RuntimeTraceEvent> Events { get; set; } = new();

        [JsonPropertyName("executionTimeMs")]
        public double ExecutionTimeMs { get; set; }

        [JsonPropertyName("traceLimitExceeded")]
        public bool TraceLimitExceeded { get; set; }

        [JsonPropertyName("timeoutReason")]
        public string? TimeoutReason { get; set; }

        [JsonPropertyName("timings")]
        public Dictionary<string, object> Timings { get; set; } = new();

        [JsonPropertyName("compiledArtifactKey")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? CompiledArtifactKey { get; set; }
    }
}

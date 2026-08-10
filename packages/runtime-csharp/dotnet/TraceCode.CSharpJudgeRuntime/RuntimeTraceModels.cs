using System.Text.Json.Serialization;

namespace TraceCode.CSharpHost;

public sealed class RuntimeTraceEvent
{
    internal bool IsSyntheticBackfill { get; set; }

    [JsonPropertyName("kind")]
    public string Kind { get; set; } = string.Empty;

    [JsonPropertyName("runId")]
    public string RunId { get; set; } = "csharp:run";

    [JsonPropertyName("file")]
    public string File { get; set; } = "solution.cs";

    [JsonPropertyName("line")]
    public int? Line { get; set; }

    [JsonPropertyName("function")]
    public string? Function { get; set; }

    [JsonPropertyName("target")]
    public RuntimeTraceTarget? Target { get; set; }

    [JsonPropertyName("value")]
    public object? Value { get; set; }

    [JsonPropertyName("method")]
    public string? Method { get; set; }

    [JsonPropertyName("args")]
    public object? Args { get; set; }

    [JsonPropertyName("binding")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public RuntimeTraceBinding? Binding { get; set; }

    [JsonPropertyName("message")]
    public string? Message { get; set; }

    [JsonPropertyName("text")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Text { get; set; }

    [JsonPropertyName("reason")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Reason { get; set; }

    [JsonPropertyName("callStackId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? CallStackId { get; set; }

    [JsonPropertyName("callStackRef")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? CallStackRef { get; set; }

    [JsonPropertyName("callStack")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<RuntimeTraceCallFrame>? CallStack { get; set; }
}

public sealed class RuntimeTraceBinding
{
    [JsonPropertyName("kind")]
    public string? Kind { get; set; }

    [JsonPropertyName("variable")]
    public string Variable { get; set; } = string.Empty;
}

public sealed class RuntimeTraceTarget
{
    [JsonPropertyName("variable")]
    public string Variable { get; set; } = string.Empty;

    [JsonPropertyName("path")]
    public List<object?>? Path { get; set; }

    [JsonPropertyName("indexSources")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string?>? IndexSources { get; set; }
}

public sealed class RuntimeTraceCallFrame
{
    [JsonPropertyName("function")]
    public string Function { get; set; } = string.Empty;

    [JsonPropertyName("line")]
    public int? Line { get; set; }

    [JsonPropertyName("args")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public object? Args { get; set; }
}

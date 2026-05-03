using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace TraceCode.CSharpHost;

public sealed class CSharpExecuteRequest
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

    [JsonPropertyName("timeoutMs")]
    public int TimeoutMs { get; set; } = 19_000;

    [JsonPropertyName("maxTraceSteps")]
    public int? MaxTraceSteps { get; set; }
}

public sealed class CSharpExecuteResponse
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("output")]
    public object? Output { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("diagnostics")]
    public List<CSharpDiagnostic> Diagnostics { get; set; } = new();

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
}

public sealed class RuntimeTraceEvent
{
    [JsonPropertyName("kind")]
    public string Kind { get; set; } = string.Empty;

    [JsonPropertyName("runId")]
    public string RunId { get; set; } = "csharp:run";

    [JsonPropertyName("file")]
    public string File { get; set; } = "UserCode.cs";

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
    public List<object?>? Args { get; set; }

    [JsonPropertyName("message")]
    public string? Message { get; set; }
}

public sealed class RuntimeTraceTarget
{
    [JsonPropertyName("variable")]
    public string Variable { get; set; } = string.Empty;

    [JsonPropertyName("path")]
    public List<object?>? Path { get; set; }
}

public sealed class CSharpDiagnostic
{
    [JsonPropertyName("file")]
    public string File { get; set; } = "UserCode.cs";

    [JsonPropertyName("line")]
    public int Line { get; set; }

    [JsonPropertyName("column")]
    public int Column { get; set; }

    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;

    [JsonPropertyName("severity")]
    public string Severity { get; set; } = string.Empty;

    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    public static CSharpDiagnostic FromRoslyn(Diagnostic diagnostic)
    {
        FileLinePositionSpan span = diagnostic.Location.GetLineSpan();
        LinePosition start = span.StartLinePosition;
        return new CSharpDiagnostic
        {
            File = string.IsNullOrWhiteSpace(span.Path) ? "UserCode.cs" : span.Path,
            Line = start.Line + 1,
            Column = start.Character + 1,
            Message = diagnostic.GetMessage(),
            Severity = diagnostic.Severity.ToString().ToLowerInvariant(),
            Id = diagnostic.Id,
        };
    }
}

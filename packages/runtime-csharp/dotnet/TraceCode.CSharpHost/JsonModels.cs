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

    [JsonPropertyName("preparedProgram")]
    public bool PreparedProgram { get; set; }

    [JsonPropertyName("preparedRunnerTier")]
    public string PreparedRunnerTier { get; set; } = "compatibility";

    [JsonPropertyName("allowAlgorithmFast")]
    public bool AllowAlgorithmFast { get; set; }

    [JsonPropertyName("requirePreparedArtifact")]
    public bool RequirePreparedArtifact { get; set; }
}

public sealed class CSharpProjectCommandRequest
{
    [JsonPropertyName("source")]
    public string Source { get; set; } = "run";

    [JsonPropertyName("scriptPath")]
    public string ScriptPath { get; set; } = "<project>";

    [JsonPropertyName("args")]
    public List<string> Args { get; set; } = new();

    [JsonPropertyName("cwd")]
    public string Cwd { get; set; } = "/workspace";

    [JsonPropertyName("env")]
    public Dictionary<string, string> Env { get; set; } = new();

    [JsonPropertyName("stdin")]
    public string Stdin { get; set; } = string.Empty;

    [JsonPropertyName("project")]
    public CSharpProjectSnapshot Project { get; set; } = new();

    [JsonPropertyName("options")]
    public Dictionary<string, JsonElement> Options { get; set; } = new();

    [JsonPropertyName("traceKernelFileSystem")]
    public bool TraceKernelFileSystem { get; set; }
}

public sealed class CSharpProjectSnapshot
{
    [JsonPropertyName("files")]
    public List<CSharpProjectFile> Files { get; set; } = new();

    [JsonPropertyName("directories")]
    public List<string> Directories { get; set; } = new();

    [JsonPropertyName("directoryMetadata")]
    public List<CSharpProjectDirectoryMetadata> DirectoryMetadata { get; set; } = new();
}

public sealed class CSharpProjectDirectoryMetadata
{
    [JsonPropertyName("path")]
    public string Path { get; set; } = string.Empty;

    [JsonPropertyName("mode")]
    public int? Mode { get; set; }

    [JsonPropertyName("atimeMs")]
    public double? AtimeMs { get; set; }

    [JsonPropertyName("mtimeMs")]
    public double? MtimeMs { get; set; }
}

public sealed class CSharpProjectFile
{
    [JsonPropertyName("path")]
    public string Path { get; set; } = string.Empty;

    [JsonPropertyName("contents")]
    public string Contents { get; set; } = string.Empty;

    [JsonPropertyName("encoding")]
    public string? Encoding { get; set; }

    [JsonPropertyName("mode")]
    public int? Mode { get; set; }

    [JsonPropertyName("atimeMs")]
    public double? AtimeMs { get; set; }

    [JsonPropertyName("mtimeMs")]
    public double? MtimeMs { get; set; }
}

public sealed class CSharpProjectFileChange
{
    [JsonPropertyName("path")]
    public string Path { get; set; } = string.Empty;

    [JsonPropertyName("directory")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Directory { get; set; }

    [JsonPropertyName("mode")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Mode { get; set; }

    [JsonPropertyName("atimeMs")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? AtimeMs { get; set; }

    [JsonPropertyName("mtimeMs")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? MtimeMs { get; set; }

    [JsonPropertyName("contents")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Contents { get; set; }

    [JsonPropertyName("encoding")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Encoding { get; set; }

    [JsonPropertyName("deleted")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Deleted { get; set; }
}

public sealed class CSharpProjectCommandResponse
{
    [JsonPropertyName("stdout")]
    public string Stdout { get; set; } = string.Empty;

    [JsonPropertyName("stderr")]
    public string Stderr { get; set; } = string.Empty;

    [JsonPropertyName("exitCode")]
    public int ExitCode { get; set; }

    [JsonPropertyName("files")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<CSharpProjectFileChange>? Files { get; set; }
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

    [JsonPropertyName("timings")]
    public Dictionary<string, object> Timings { get; set; } = new();

    [JsonPropertyName("compiledArtifactBase64")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? CompiledArtifactBase64 { get; set; }

    [JsonPropertyName("compiledArtifactKey")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? CompiledArtifactKey { get; set; }

    [JsonPropertyName("compiledArtifactSha256")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? CompiledArtifactSha256 { get; set; }

    [JsonPropertyName("preparedRunnerTier")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? PreparedRunnerTier { get; set; }

    [JsonPropertyName("preparedRunnerReason")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? PreparedRunnerReason { get; set; }

    [JsonPropertyName("traceClrWireContract")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public TraceClrWireContractDescriptor? TraceClrWireContract { get; set; }
}

public sealed class TraceClrWireContractDescriptor
{
    [JsonPropertyName("parameters")]
    public List<TraceClrWireParameterDescriptor> Parameters { get; set; } = new();

    [JsonPropertyName("returnType")]
    public TraceClrWireTypeDescriptor ReturnType { get; set; } = new();
}

public sealed class TraceClrWireParameterDescriptor
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("type")]
    public TraceClrWireTypeDescriptor Type { get; set; } = new();
}

public sealed class TraceClrWireTypeDescriptor
{
    [JsonPropertyName("wireType")]
    public string WireType { get; set; } = string.Empty;
}

public sealed class CSharpDiagnostic
{
    [JsonPropertyName("file")]
    public string File { get; set; } = "solution.cs";

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
            File = string.IsNullOrWhiteSpace(span.Path) ? "solution.cs" : span.Path,
            Line = start.Line + 1,
            Column = start.Character + 1,
            Message = diagnostic.GetMessage(),
            Severity = diagnostic.Severity.ToString().ToLowerInvariant(),
            Id = diagnostic.Id,
        };
    }
}

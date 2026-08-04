using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.Loader;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Emit;
using Microsoft.CodeAnalysis.Text;

namespace TraceCode.CSharpHost;

public static partial class CompilerHost
{
    private const string UserCodePath = "solution.cs";
    private const string ProjectWorkspaceRoot = "/tmp/tracecode-csharp-project";
    private const string ScriptRunnerClassName = "__TraceCodeScriptRunner";
    private const int MaxInputDepth = 128;
    private const int MaxInputCollectionItems = 200_000;
    private const int MaxInputObjectProperties = 50_000;
    private const int MaxInputTraversalNodes = 750_000;
    private const int ProjectMaxOutputStreamBytes = 1024 * 1024;
    private const int ProjectMaxLiveFileChanges = 1024;
    private const long ProjectMaxLiveFileChangeBytes = 4L * 1024 * 1024;
    private const int CompiledArtifactCacheMaxEntries = 24;
    private const long CompiledArtifactCacheMaxBytes = 8L * 1024 * 1024;
    private const string CompiledArtifactCacheSchema = "tracecode-csharp-compile-v1";
    private static readonly string[] DeniedUserApiText =
    {
        "System.Net",
        "System.Reflection.Emit",
        "System.Reflection.Assembly",
        "System.Runtime.Loader",
        "System.Type",
        "System.AppDomain",
        "System.Runtime.InteropServices.JavaScript",
        "TraceCode.CSharpHost.JudgeRuntimeContext",
        "AssemblyLoadContext",
    };
    private static readonly string[] DeniedUserReflectionInvocations =
    {
        "Assembly.Load",
        "System.Reflection.Assembly.Load",
        "Type.GetType",
        "System.Type.GetType",
        "AppDomain.CurrentDomain.GetAssemblies",
        "AssemblyLoadContext",
    };
    // Keep every Roslyn-typed static inside a lazily touched compiler-only type.
    // Disposable prepared runners load this host assembly without shipping
    // Microsoft.CodeAnalysis, so the outer execution host must remain loadable
    // without resolving compiler metadata.
    private static class CompilerAuthorityState
    {
        internal static readonly CSharpParseOptions ParseOptions =
            new(LanguageVersion.CSharp14);
#if TRACECODE_CSHARP_DEBUG_EMIT
        internal const OptimizationLevel JudgeOptimizationLevel =
            OptimizationLevel.Debug;
#else
        internal const OptimizationLevel JudgeOptimizationLevel =
            OptimizationLevel.Release;
#endif
        internal static readonly Lazy<MetadataReference[]> CachedReferences =
            new(() => ResolveReferences().ToArray());
        internal static readonly Dictionary<string, CSharpCompilation>
            TrustedCompilationTemplates = new(StringComparer.Ordinal);
        internal static readonly object TrustedCompilationTemplatesLock = new();
    }
    private static readonly Dictionary<string, CompiledArtifact> CompiledArtifacts = new(StringComparer.Ordinal);
    private static readonly LinkedList<string> CompiledArtifactRecency = new();
    private static long compiledArtifactCacheBytes;
    private static int projectLiveFileChangeCount;
    private static long projectLiveFileChangeBytes;
    private static bool projectLiveFileChangeBudgetWarningEmitted;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        IncludeFields = true,
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
        MaxDepth = 256,
    };

    private sealed class CompiledArtifact
    {
        public required byte[] PeBytes { get; init; }
        public required LinkedListNode<string> RecencyNode { get; init; }
    }

    private sealed class ProjectWorkspaceSnapshot
    {
        public Dictionary<string, ProjectFileState> Files { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, ProjectDirectoryState> Directories { get; } = new(StringComparer.Ordinal);
    }

    private sealed record ProjectFileState(byte[] Bytes, int Mode, double AtimeMs, double MtimeMs)
    {
        public CSharpProjectFileChange ToChange(string path) => EncodeProjectFileChange(path, Bytes, Mode, AtimeMs, MtimeMs);
    }

    private sealed record ProjectDirectoryState(int Mode, double AtimeMs, double MtimeMs)
    {
        public CSharpProjectFileChange ToChange(string path) => new()
        {
            Path = path,
            Directory = true,
            Mode = Mode,
            AtimeMs = AtimeMs,
            MtimeMs = MtimeMs,
        };
    }

    private sealed class UserExecutionLoadContext : AssemblyLoadContext
    {
        public UserExecutionLoadContext(string name) : base(name, isCollectible: true)
        {
        }

        protected override Assembly? Load(AssemblyName assemblyName)
        {
            // User assemblies share only already-loaded host/framework assemblies. They cannot
            // resolve arbitrary files, while a fresh collectible context gives every command a
            // new static/type universe without throwing away Roslyn and its metadata references.
            return AssemblyLoadContext.Default.Assemblies.FirstOrDefault(candidate =>
                AssemblyName.ReferenceMatchesDefinition(candidate.GetName(), assemblyName));
        }
    }

    [JSImport("emitProjectEvent", "tracecode")]
    internal static partial void EmitProjectEventJson(string payloadJson);

    [JSImport("readProjectInputByte", "tracecode")]
    public static partial int ReadProjectInputByte();

    [JSExport]
    [SupportedOSPlatform("browser")]
    public static string GetCompiledArtifactKey(string requestJson)
    {
        CSharpExecuteRequest? request = JsonSerializer.Deserialize<CSharpExecuteRequest>(requestJson, JsonOptions);
        if (request is null) throw new ArgumentException("Invalid C# execution request.");
        request.Inputs ??= new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        ValidateExecutionInputs(request.Inputs);
        return CompiledArtifactKey(request);
    }

    [JSExport]
    [SupportedOSPlatform("browser")]
    public static string Prepare(string requestJson)
    {
        Stopwatch stopwatch = Stopwatch.StartNew();
        Stopwatch phaseStopwatch = Stopwatch.StartNew();
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
            CSharpExecuteRequest? request = JsonSerializer.Deserialize<CSharpExecuteRequest>(requestJson, JsonOptions);
            timings["prepareDeserializeMs"] = phaseStopwatch.Elapsed.TotalMilliseconds;
            if (request is null)
            {
                return SerializeError("Invalid C# preparation request.", stopwatch, capturedOut, timings: timings);
            }

            phaseStopwatch.Restart();
            request.PreparedProgram = true;
            request.RequirePreparedArtifact = false;
            request.Inputs = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            string artifactKey = CompiledArtifactKey(request);
            timings["compileArtifactKeyMs"] = phaseStopwatch.Elapsed.TotalMilliseconds;

            phaseStopwatch.Restart();
            double compileStartedAt = stopwatch.Elapsed.TotalMilliseconds;
            byte[]? peBytes = TryGetCompiledArtifact(artifactKey);
            timings["compileCacheLookupMs"] = phaseStopwatch.Elapsed.TotalMilliseconds;
            bool compileCacheHit = peBytes is not null;

            if (peBytes is null)
            {
                CSharpCompilation compilation = CreateCompilation(request, timings);
                using MemoryStream peStream = new();
                phaseStopwatch.Restart();
                EmitResult emitResult = compilation.Emit(peStream);
                timings["compileEmitMs"] = phaseStopwatch.Elapsed.TotalMilliseconds;
                timings["compileMs"] = stopwatch.Elapsed.TotalMilliseconds - compileStartedAt;
                if (!emitResult.Success)
                {
                    phaseStopwatch.Restart();
                    List<CSharpDiagnostic> diagnostics = emitResult.Diagnostics
                        .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
                        .Select(CSharpDiagnostic.FromRoslyn)
                        .ToList();
                    timings["compileDiagnosticsMs"] = phaseStopwatch.Elapsed.TotalMilliseconds;
                    return Serialize(new CSharpExecuteResponse
                    {
                        Success = false,
                        Error = diagnostics.FirstOrDefault()?.Message ?? "C# compilation failed.",
                        Diagnostics = diagnostics,
                        ConsoleOutput = SplitConsoleOutput(capturedOut),
                        ExecutionTimeMs = stopwatch.Elapsed.TotalMilliseconds,
                        Timings = WithTotalTiming(timings, stopwatch),
                    });
                }

                phaseStopwatch.Restart();
                peBytes = peStream.ToArray();
                timings["compilePeExtractionMs"] = phaseStopwatch.Elapsed.TotalMilliseconds;
                phaseStopwatch.Restart();
                StoreCompiledArtifact(artifactKey, peBytes);
                timings["compileCacheStoreMs"] = phaseStopwatch.Elapsed.TotalMilliseconds;
            }
            else
            {
                timings["compileMs"] = stopwatch.Elapsed.TotalMilliseconds - compileStartedAt;
            }

            timings["compileCacheHit"] = compileCacheHit;
            timings["compileArtifactKey"] = artifactKey;
            timings["compileArtifactBytes"] = peBytes.LongLength;
            timings["compileCacheEntries"] = CompiledArtifacts.Count;
            timings["compileCacheBytes"] = compiledArtifactCacheBytes;
            phaseStopwatch.Restart();
            string compiledArtifactBase64 = Convert.ToBase64String(peBytes);
            timings["prepareBase64EncodeMs"] = phaseStopwatch.Elapsed.TotalMilliseconds;
            string compiledArtifactSha256 = Convert.ToHexString(
                SHA256.HashData(peBytes)
            ).ToLowerInvariant();
            return Serialize(new CSharpExecuteResponse
            {
                Success = true,
                ConsoleOutput = SplitConsoleOutput(capturedOut),
                ExecutionTimeMs = stopwatch.Elapsed.TotalMilliseconds,
                Timings = WithTotalTiming(timings, stopwatch),
                CompiledArtifactKey = artifactKey,
                CompiledArtifactBase64 = compiledArtifactBase64,
                CompiledArtifactSha256 = compiledArtifactSha256,
            });
        }
        catch (Exception error)
        {
            return SerializeError(error.GetBaseException().Message, stopwatch, capturedOut, timings: timings);
        }
        finally
        {
            Console.SetOut(originalOut);
        }
    }

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

        CSharpExecuteRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<CSharpExecuteRequest>(
                requestJson,
                JsonOptions
            );
        }
        catch (Exception)
        {
            // Prepared execution is a fail-closed boundary. Malformed requests
            // must never fall through to Execute, whose non-prepared path is
            // allowed to invoke Roslyn.
            string response = SerializeError(
                "Invalid prepared C# execution request.",
                stopwatch,
                capturedOut,
                timings: timings
            );
            Console.SetOut(originalOut);
            return response;
        }

        if (request is null)
        {
            string response = SerializeError(
                "Invalid prepared C# execution request.",
                stopwatch,
                capturedOut,
                timings: timings
            );
            Console.SetOut(originalOut);
            return response;
        }

        try
        {
            request.PreparedProgram = true;
            request.RequirePreparedArtifact = true;
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
                peBytes = Convert.FromBase64String(
                    request.CompiledArtifactBase64
                );
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
                peBytes.LongLength > CompiledArtifactCacheMaxBytes ||
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
            RuntimeTraceSink.Configure(
                request.TimeoutMs,
                request.Trace ? request.MaxTraceSteps : null,
                request.Trace ? request.MaxLineEvents : null,
                request.Trace ? request.MaxSingleLineHits : null,
                request.Trace ? request.MaxStoredEvents : null,
                request.Trace && request.MinimalTrace
            );

            double runStartedAt = stopwatch.Elapsed.TotalMilliseconds;
            var loadContext = new UserExecutionLoadContext(
                "TraceCode.PreparedUserExecution." +
                Guid.NewGuid().ToString("N")
            );
            try
            {
                using MemoryStream assemblyStream = new(
                    peBytes,
                    writable: false
                );
                Assembly userAssembly = loadContext.LoadFromStream(
                    assemblyStream
                );
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
                    events
                );
                return Serialize(new CSharpExecuteResponse
                {
                    Success = true,
                    Output = normalizedOutput,
                    ConsoleOutput = SplitConsoleOutput(capturedOut),
                    Events = events,
                    TraceLimitExceeded =
                        RuntimeTraceSink.TraceLimitExceeded,
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
            // This is the lifecycle boundary for all prepared attempts, not
            // only attempts that reached the collectible load context.
            RuntimeTraceSink.Reset();
            Console.SetOut(originalOut);
        }
    }

    [JSExport]
    [SupportedOSPlatform("browser")]
    public static bool DisposePreparedArtifact(string artifactKey)
    {
        return RemoveCompiledArtifact(artifactKey);
    }

    [JSExport]
    [SupportedOSPlatform("browser")]
    public static string Execute(string requestJson)
    {
        Stopwatch stopwatch = Stopwatch.StartNew();
        TextWriter originalOut = Console.Out;
        using TracingConsoleWriter capturedOut = new();
        Console.SetOut(capturedOut);
        RuntimeTraceSink.Reset();
        Dictionary<string, object> timings = new();

        try
        {
            CSharpExecuteRequest? request = JsonSerializer.Deserialize<CSharpExecuteRequest>(requestJson, JsonOptions);
            if (request is null)
            {
                return SerializeError("Invalid C# execution request.", stopwatch, capturedOut);
            }

            request.Inputs ??= new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            ValidateExecutionInputs(request.Inputs);

            string artifactKey = CompiledArtifactKey(request);
            byte[]? peBytes = TryGetCompiledArtifact(artifactKey);
            bool hostArtifactCacheHit = false;
            bool compiledArtifactForHost = false;
            if (peBytes is null
                && string.Equals(request.CompiledArtifactKey, artifactKey, StringComparison.Ordinal)
                && !string.IsNullOrEmpty(request.CompiledArtifactBase64))
            {
                try
                {
                    byte[] candidate = Convert.FromBase64String(request.CompiledArtifactBase64);
                    if (candidate.LongLength <= CompiledArtifactCacheMaxBytes
                        && candidate.Length >= 2
                        && candidate[0] == (byte)'M'
                        && candidate[1] == (byte)'Z'
                        && !string.IsNullOrEmpty(request.CompiledArtifactSha256)
                        && string.Equals(
                            request.CompiledArtifactSha256,
                            Convert.ToHexString(SHA256.HashData(candidate))
                                .ToLowerInvariant(),
                            StringComparison.Ordinal
                        ))
                    {
                        peBytes = candidate;
                        StoreCompiledArtifact(artifactKey, peBytes);
                        hostArtifactCacheHit = true;
                    }
                }
                catch (FormatException)
                {
                    // Treat malformed host cache data as a miss and compile normally.
                }
            }
            timings["compileCacheHit"] = peBytes is not null;
            timings["hostArtifactCacheHit"] = hostArtifactCacheHit;
            timings["compileArtifactKey"] = artifactKey;
            double compileStartedAt = stopwatch.Elapsed.TotalMilliseconds;
            if (peBytes is null)
            {
                if (request.RequirePreparedArtifact)
                {
                    timings["compileMs"] = stopwatch.Elapsed.TotalMilliseconds - compileStartedAt;
                    return SerializeError(
                        "Prepared C# artifact is unavailable or invalid.",
                        stopwatch,
                        capturedOut,
                        timings: timings
                    );
                }

                CSharpCompilation compilation = CreateCompilation(request);
                using MemoryStream peStream = new();
                var emitResult = compilation.Emit(peStream);
                timings["compileMs"] = stopwatch.Elapsed.TotalMilliseconds - compileStartedAt;

                if (!emitResult.Success)
                {
                    var diagnostics = emitResult.Diagnostics
                        .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
                        .Select(CSharpDiagnostic.FromRoslyn)
                        .ToList();
                    return Serialize(new CSharpExecuteResponse
                    {
                        Success = false,
                        Error = diagnostics.FirstOrDefault()?.Message ?? "C# compilation failed.",
                        Diagnostics = diagnostics,
                        ConsoleOutput = SplitConsoleOutput(capturedOut),
                        Events = SnapshotTraceEvents(capturedOut),
                        ExecutionTimeMs = stopwatch.Elapsed.TotalMilliseconds,
                        Timings = WithTotalTiming(timings, stopwatch),
                    });
                }

                peBytes = peStream.ToArray();
                StoreCompiledArtifact(artifactKey, peBytes);
                compiledArtifactForHost = true;
            }
            else
            {
                timings["compileMs"] = stopwatch.Elapsed.TotalMilliseconds - compileStartedAt;
            }

            timings["compileArtifactBytes"] = peBytes.LongLength;
            timings["compileCacheEntries"] = CompiledArtifacts.Count;
            timings["compileCacheBytes"] = compiledArtifactCacheBytes;
            string inputsJson = JsonSerializer.Serialize(
                request.Inputs,
                JsonOptions
            );
            RuntimeTraceSink.Configure(
                request.TimeoutMs,
                request.Trace ? request.MaxTraceSteps : null,
                request.Trace ? request.MaxLineEvents : null,
                request.Trace ? request.MaxSingleLineHits : null,
                request.Trace ? request.MaxStoredEvents : null,
                request.Trace && request.MinimalTrace
            );
            double runStartedAt = stopwatch.Elapsed.TotalMilliseconds;
            var loadContext = new UserExecutionLoadContext("TraceCode.UserExecution." + Guid.NewGuid().ToString("N"));
            try
            {
                using MemoryStream assemblyStream = new(peBytes, writable: false);
                Assembly userAssembly = loadContext.LoadFromStream(assemblyStream);
                object? output = InvokeDriver(userAssembly, inputsJson);
                object? normalizedOutput = NormalizeOutput(output);
                timings["runMs"] = stopwatch.Elapsed.TotalMilliseconds - runStartedAt;
                timings["executionRealm"] = "collectible-assembly-load-context";
                List<RuntimeTraceEvent> events = SnapshotTraceEvents(capturedOut);
                TraceEventBackfill.Apply(request.Source, events);
                return Serialize(new CSharpExecuteResponse
                {
                    Success = true,
                    Output = normalizedOutput,
                    ConsoleOutput = SplitConsoleOutput(capturedOut),
                    Events = events,
                    TraceLimitExceeded = RuntimeTraceSink.TraceLimitExceeded,
                    TimeoutReason = RuntimeTraceSink.TraceLimitExceeded ? RuntimeTraceSink.TimeoutReason : null,
                    ExecutionTimeMs = stopwatch.Elapsed.TotalMilliseconds,
                    Timings = WithTotalTiming(timings, stopwatch),
                    CompiledArtifactBase64 = compiledArtifactForHost ? Convert.ToBase64String(peBytes) : null,
                    CompiledArtifactKey = artifactKey,
                    CompiledArtifactSha256 = compiledArtifactForHost
                        ? Convert.ToHexString(SHA256.HashData(peBytes))
                            .ToLowerInvariant()
                        : null,
                });
            }
            finally
            {
                loadContext.Unload();
            }
        }
        catch (Exception error) when (error.GetBaseException() is TraceCodeTimeoutException timeout)
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
        catch (Exception error) when (error.GetBaseException() is TraceLimitExceededException traceLimit)
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
            return SerializeError(error.GetBaseException().Message, stopwatch, capturedOut, timings: timings);
        }
        finally
        {
            RuntimeTraceSink.Reset();
            Console.SetOut(originalOut);
        }
    }

    [JSExport]
    [SupportedOSPlatform("browser")]
    public static string ExecuteProject(string requestJson)
    {
        Stopwatch stopwatch = Stopwatch.StartNew();
        TextWriter originalOut = Console.Out;
        TextWriter originalError = Console.Error;
        string originalDirectory = Directory.GetCurrentDirectory();
        var originalEnvironment = Environment.GetEnvironmentVariables();
        using StreamingProjectTextWriter capturedOut = new("stdout");
        using StreamingProjectTextWriter capturedError = new("stderr");
        Console.SetOut(capturedOut);
        Console.SetError(capturedError);

        try
        {
            CSharpProjectCommandRequest? request = JsonSerializer.Deserialize<CSharpProjectCommandRequest>(requestJson, JsonOptions);
            if (request is null)
            {
                return SerializeProject(new CSharpProjectCommandResponse
                {
                    Stderr = "dotnet: invalid C# project request\n",
                    ExitCode = 2,
                });
            }

            ResetProjectLiveEventBudgets();
            PrepareProjectWorkspace(request, out ProjectWorkspaceSnapshot beforeSnapshot);
            string cwd = ResolveProjectPath(request.Cwd);
            Directory.CreateDirectory(cwd);
            Directory.SetCurrentDirectory(cwd);
            foreach ((string key, string value) in request.Env)
            {
                Environment.SetEnvironmentVariable(key, value);
            }

            CSharpCompilation compilation = CreateProjectCompilation(request);
            IEnumerable<ResourceDescription> manifestResources = ResolveProjectEmbeddedResources(request);
            using MemoryStream peStream = new();
            EmitResult emitResult = compilation.Emit(peStream, manifestResources: manifestResources);
            if (!emitResult.Success)
            {
                return SerializeProject(new CSharpProjectCommandResponse
                {
                    Stdout = capturedOut.ToString(),
                    Stderr = capturedError.ToString() + FormatProjectDiagnostics(emitResult.Diagnostics),
                    ExitCode = 1,
                });
            }
            byte[] peBytes = peStream.ToArray();
            ProjectOutputInfo outputInfo = MaterializeProjectAssembly(request, peBytes);

            if (string.Equals(request.Source, "compile", StringComparison.Ordinal))
            {
                string buildOutput = FormatDotnetBuildOutput(request, outputInfo, emitResult.Diagnostics, stopwatch.Elapsed);
                List<CSharpProjectFileChange> files = DiffProjectWorkspace(
                    beforeSnapshot,
                    request.TraceKernelFileSystem
                );
                EmitProjectFileChanges(files, "final-diff");
                return SerializeProject(new CSharpProjectCommandResponse
                {
                    Stdout = capturedOut.ToString() + buildOutput,
                    Stderr = capturedError.ToString(),
                    ExitCode = 0,
                    Files = files,
                });
            }

            ProjectHintPathAssembly[] projectAssemblies = ResolveProjectHintPathAssemblies(request).ToArray();
            Assembly? ResolveProjectAssembly(AssemblyLoadContext context, AssemblyName assemblyName)
            {
                ProjectHintPathAssembly? match = projectAssemblies.FirstOrDefault(assembly =>
                    string.Equals(assembly.Name, assemblyName.Name, StringComparison.OrdinalIgnoreCase));
                return match is null ? null : context.LoadFromStream(new MemoryStream(match.Bytes));
            }

            AssemblyLoadContext.Default.Resolving += ResolveProjectAssembly;
            try
            {
                Assembly assembly = AssemblyLoadContext.Default.LoadFromStream(new MemoryStream(peBytes, writable: false));
                InvokeProjectEntryPoint(assembly, request.Args.ToArray());
            }
            finally
            {
                AssemblyLoadContext.Default.Resolving -= ResolveProjectAssembly;
            }
            List<CSharpProjectFileChange> runFiles = DiffProjectWorkspace(
                beforeSnapshot,
                request.TraceKernelFileSystem
            );
            EmitProjectFileChanges(runFiles, "final-diff");
            return SerializeProject(new CSharpProjectCommandResponse
            {
                Stdout = capturedOut.ToString(),
                Stderr = capturedError.ToString(),
                ExitCode = 0,
                Files = runFiles,
            });
        }
        catch (Exception error)
        {
            return SerializeProject(new CSharpProjectCommandResponse
            {
                Stdout = capturedOut.ToString(),
                Stderr = capturedError.ToString() + FormatProjectUnhandledException(error),
                ExitCode = 1,
            });
        }
        finally
        {
            Console.SetOut(originalOut);
            Console.SetError(originalError);
            Directory.SetCurrentDirectory(originalDirectory);
            RestoreEnvironment(originalEnvironment);
        }
    }

    private sealed record ProjectOutputInfo(
        string ProjectPath,
        string ProjectDirectory,
        string AssemblyName,
        string TargetFramework,
        string DllRelativePath
    );

    private static ProjectOutputInfo MaterializeProjectAssembly(CSharpProjectCommandRequest request, byte[] peBytes)
    {
        ProjectOutputInfo outputInfo = ResolveProjectOutputInfo(request);
        string absoluteOutputPath = ResolveProjectPath(outputInfo.DllRelativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(absoluteOutputPath) ?? ProjectWorkspaceRoot);
        File.WriteAllBytes(absoluteOutputPath, peBytes);
        return outputInfo;
    }

    private static ProjectOutputInfo ResolveProjectOutputInfo(CSharpProjectCommandRequest request)
    {
        Dictionary<string, CSharpProjectFile> filesByPath = request.Project.Files
            .Select(file => new KeyValuePair<string, CSharpProjectFile>(NormalizeProjectPath(file.Path), file))
            .GroupBy(entry => entry.Key, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Last().Value, StringComparer.Ordinal);
        string? projectPath = ResolveProjectFilePath(request, filesByPath.Keys);
        string projectDirectory = projectPath is null ? NormalizeProjectDirectoryPath(request.Cwd) : ProjectDirectory(projectPath);
        string assemblyName = ResolveProjectPropertyValue(request, "AssemblyName")
            ?? (projectPath is null ? "TraceCodeProject" : Path.GetFileNameWithoutExtension(projectPath));
        if (string.IsNullOrWhiteSpace(assemblyName))
        {
            assemblyName = "TraceCodeProject";
        }

        string targetFramework = ResolveProjectPropertyValue(request, "TargetFramework") ?? "net10.0";
        if (string.IsNullOrWhiteSpace(targetFramework))
        {
            targetFramework = "net10.0";
        }

        string outputPath = string.IsNullOrEmpty(projectDirectory)
            ? $"bin/Debug/{targetFramework}/{assemblyName}.dll"
            : $"{projectDirectory}/bin/Debug/{targetFramework}/{assemblyName}.dll";
        return new ProjectOutputInfo(
            projectPath ?? string.Empty,
            projectDirectory,
            assemblyName,
            targetFramework,
            outputPath
        );
    }

    private static string FormatDotnetBuildOutput(
        CSharpProjectCommandRequest request,
        ProjectOutputInfo outputInfo,
        IEnumerable<Diagnostic> diagnostics,
        TimeSpan elapsed
    )
    {
        string verbosity = ResolveDotnetBuildVerbosity(request);
        if (string.Equals(verbosity, "quiet", StringComparison.OrdinalIgnoreCase))
        {
            return string.Empty;
        }

        int warningCount = diagnostics.Count(diagnostic =>
            diagnostic.Severity == DiagnosticSeverity.Warning &&
            !IsSyntheticProjectDiagnostic(diagnostic));
        int errorCount = diagnostics.Count(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);
        string dllPath = "/workspace/" + outputInfo.DllRelativePath;
        string elapsedText = $"{(int)elapsed.TotalHours:00}:{elapsed.Minutes:00}:{elapsed.Seconds:00}.{elapsed.Milliseconds / 10:00}";

        StringBuilder output = new();
        if (!string.Equals(verbosity, "minimal", StringComparison.OrdinalIgnoreCase))
        {
            output.AppendLine("  Determining projects to restore...");
            output.AppendLine("  All projects are up-to-date for restore.");
        }
        output.AppendLine($"  {outputInfo.AssemblyName} -> {dllPath}");
        output.AppendLine();
        output.AppendLine(errorCount == 0 ? "Build succeeded." : "Build FAILED.");
        output.AppendLine($"    {warningCount} Warning(s)");
        output.AppendLine($"    {errorCount} Error(s)");
        output.AppendLine();
        output.AppendLine($"Time Elapsed {elapsedText}");
        return output.ToString();
    }

    private static bool IsSyntheticProjectDiagnostic(Diagnostic diagnostic)
    {
        string? path = diagnostic.Location.SourceTree?.FilePath;
        return path is not null && path.StartsWith("TraceCode", StringComparison.Ordinal);
    }

    private static string ResolveDotnetBuildVerbosity(CSharpProjectCommandRequest request)
    {
        IReadOnlyList<string> args = ResolveProjectCommandLinePropertyArgs(request);
        for (int index = 0; index < args.Count; index += 1)
        {
            string arg = args[index];
            if (arg.Equals("--verbosity", StringComparison.OrdinalIgnoreCase) || arg.Equals("-v", StringComparison.OrdinalIgnoreCase))
            {
                if (index + 1 < args.Count)
                {
                    return NormalizeDotnetVerbosity(args[index + 1]);
                }
                continue;
            }
            if (arg.StartsWith("--verbosity:", StringComparison.OrdinalIgnoreCase))
            {
                return NormalizeDotnetVerbosity(arg["--verbosity:".Length..]);
            }
            if (arg.StartsWith("--verbosity=", StringComparison.OrdinalIgnoreCase))
            {
                return NormalizeDotnetVerbosity(arg["--verbosity=".Length..]);
            }
            if (arg.StartsWith("-v:", StringComparison.OrdinalIgnoreCase))
            {
                return NormalizeDotnetVerbosity(arg["-v:".Length..]);
            }
        }
        return "normal";
    }

    private static string NormalizeDotnetVerbosity(string value)
    {
        string normalized = value.Trim();
        return normalized.ToLowerInvariant() switch
        {
            "q" => "quiet",
            "quiet" => "quiet",
            "m" => "minimal",
            "minimal" => "minimal",
            "n" => "normal",
            "normal" => "normal",
            "d" => "detailed",
            "detailed" => "detailed",
            "diag" => "diagnostic",
            "diagnostic" => "diagnostic",
            _ => "normal",
        };
    }

    private static void RestoreEnvironment(System.Collections.IDictionary originalEnvironment)
    {
        HashSet<string> originalKeys = new(StringComparer.Ordinal);
        HashSet<string> currentKeys = new(StringComparer.Ordinal);

        foreach (System.Collections.DictionaryEntry entry in originalEnvironment)
        {
            if (entry.Key is string key)
            {
                originalKeys.Add(key);
            }
        }

        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            if (entry.Key is string key)
            {
                currentKeys.Add(key);
            }
        }

        foreach (string key in currentKeys)
        {
            if (!originalKeys.Contains(key))
            {
                Environment.SetEnvironmentVariable(key, null);
            }
        }

        foreach (System.Collections.DictionaryEntry entry in originalEnvironment)
        {
            if (entry.Key is string key)
            {
                Environment.SetEnvironmentVariable(key, entry.Value?.ToString());
            }
        }
    }

    private static string CompiledArtifactKey(CSharpExecuteRequest request)
    {
        StringBuilder key = new();
        key.Append(CompiledArtifactCacheSchema).Append('\n');
        AppendCacheKeyPart(key, request.Source);
        AppendCacheKeyPart(key, request.FunctionName);
        AppendCacheKeyPart(key, request.ExecutionStyle);
        key.Append(request.Trace ? "trace\n" : "plain\n");
        if (request.PreparedProgram)
        {
            key.Append("prepared-driver-v1\n");
        }
        else
        {
            key.Append("input-shaped-driver-v1\n");
            foreach ((string name, JsonElement value) in request.Inputs)
            {
                AppendCacheKeyPart(key, name);
                AppendInputCompileShape(key, value);
                key.Append('\n');
            }
        }

        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key.ToString()))).ToLowerInvariant();
    }

    private static void AppendCacheKeyPart(StringBuilder target, string value)
    {
        target.Append(value.Length).Append(':').Append(value).Append('\n');
    }

    private static void AppendInputCompileShape(StringBuilder target, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                target.Append('{');
                foreach (JsonProperty property in value.EnumerateObject())
                {
                    AppendCacheKeyPart(target, property.Name);
                    AppendInputCompileShape(target, property.Value);
                }
                target.Append('}');
                return;
            case JsonValueKind.Array:
                target.Append('[');
                foreach (JsonElement item in value.EnumerateArray())
                {
                    AppendInputCompileShape(target, item);
                }
                target.Append(']');
                return;
            case JsonValueKind.String:
                target.Append('s');
                return;
            case JsonValueKind.Number:
                target.Append('n');
                return;
            case JsonValueKind.True:
            case JsonValueKind.False:
                target.Append('b');
                return;
            case JsonValueKind.Null:
                target.Append('0');
                return;
            default:
                target.Append('?');
                return;
        }
    }

    private static byte[]? TryGetCompiledArtifact(string key)
    {
        if (!CompiledArtifacts.TryGetValue(key, out CompiledArtifact? artifact))
        {
            return null;
        }

        CompiledArtifactRecency.Remove(artifact.RecencyNode);
        CompiledArtifactRecency.AddLast(artifact.RecencyNode);
        return artifact.PeBytes;
    }

    private static void StoreCompiledArtifact(string key, byte[] peBytes)
    {
        if (peBytes.LongLength > CompiledArtifactCacheMaxBytes)
        {
            return;
        }

        if (CompiledArtifacts.TryGetValue(key, out CompiledArtifact? existing))
        {
            compiledArtifactCacheBytes -= existing.PeBytes.LongLength;
            CompiledArtifactRecency.Remove(existing.RecencyNode);
            CompiledArtifacts.Remove(key);
        }

        LinkedListNode<string> recencyNode = CompiledArtifactRecency.AddLast(key);
        CompiledArtifacts[key] = new CompiledArtifact
        {
            PeBytes = peBytes,
            RecencyNode = recencyNode,
        };
        compiledArtifactCacheBytes += peBytes.LongLength;

        while (CompiledArtifacts.Count > CompiledArtifactCacheMaxEntries
            || compiledArtifactCacheBytes > CompiledArtifactCacheMaxBytes)
        {
            LinkedListNode<string>? oldest = CompiledArtifactRecency.First;
            if (oldest is null)
            {
                break;
            }

            CompiledArtifactRecency.RemoveFirst();
            if (CompiledArtifacts.Remove(oldest.Value, out CompiledArtifact? removed))
            {
                compiledArtifactCacheBytes -= removed.PeBytes.LongLength;
            }
        }
    }

    private static bool RemoveCompiledArtifact(string key)
    {
        if (!CompiledArtifacts.Remove(key, out CompiledArtifact? artifact))
        {
            return false;
        }

        CompiledArtifactRecency.Remove(artifact.RecencyNode);
        compiledArtifactCacheBytes -= artifact.PeBytes.LongLength;
        return true;
    }

    private static CSharpCompilation CreateCompilation(
        CSharpExecuteRequest request,
        IDictionary<string, object>? timings = null
    )
    {
        Stopwatch phaseStopwatch = Stopwatch.StartNew();
        SyntaxTree originalUserTree = CSharpSyntaxTree.ParseText(
            request.Source,
            CompilerAuthorityState.ParseOptions,
            path: UserCodePath
        );
        RecordCompilePhase(timings, "compileParseUserMs", phaseStopwatch);

        phaseStopwatch.Restart();
        ValidateUserSourcePolicy(originalUserTree);
        RecordCompilePhase(timings, "compilePolicyValidationMs", phaseStopwatch);

        phaseStopwatch.Restart();
        SyntaxTree executableUserTree = IsScriptExecutionRequest(request)
            ? CreateScriptUserTree(originalUserTree)
            : originalUserTree;
        RecordCompilePhase(timings, "compileScriptTransformMs", phaseStopwatch);

        phaseStopwatch.Restart();
        SyntaxTree userTree = TraceRewriter.Instrument(executableUserTree, request.Trace);
        RecordCompilePhase(timings, "compileTraceRewriteMs", phaseStopwatch);

        phaseStopwatch.Restart();
        bool embedLearnerRuntime = UserDeclaresNodeSupport(originalUserTree);
        if (timings is not null)
        {
            timings["compilePrecompiledRuntime"] = !embedLearnerRuntime;
        }
        CSharpCompilation trustedTemplate = GetTrustedCompilationTemplate(
            originalUserTree,
            embedLearnerRuntime,
            timings
        );
        RecordCompilePhase(timings, "compileTrustedTemplateAccessMs", phaseStopwatch);

        phaseStopwatch.Restart();
        string driverSource = request.PreparedProgram
            ? GeneratePreparedDriverSource(originalUserTree, request)
            : GenerateDriverSource(originalUserTree, request);
        RecordCompilePhase(timings, "compileGenerateDriverMs", phaseStopwatch);
        phaseStopwatch.Restart();
        SyntaxTree driverTree = CSharpSyntaxTree.ParseText(
            driverSource,
            CompilerAuthorityState.ParseOptions,
            path: "TraceCodeDriver.cs"
        );
        RecordCompilePhase(timings, "compileParseDriverMs", phaseStopwatch);

        phaseStopwatch.Restart();
        CSharpCompilation compilation = trustedTemplate
            .AddSyntaxTrees(userTree, driverTree)
            .WithAssemblyName("TraceCode.UserCode." + Guid.NewGuid().ToString("N"));
        RecordCompilePhase(timings, "compileCreateCompilationMs", phaseStopwatch);
        phaseStopwatch.Restart();
        ValidateUserSemanticPolicy(compilation, new[] { userTree });
        RecordCompilePhase(
            timings,
            "compileSemanticPolicyValidationMs",
            phaseStopwatch
        );
        return compilation;
    }

    private static CSharpCompilation GetTrustedCompilationTemplate(
        SyntaxTree originalUserTree,
        bool embedLearnerRuntime,
        IDictionary<string, object>? timings
    )
    {
        Stopwatch phaseStopwatch = Stopwatch.StartNew();
#if TRACECODE_PRECOMPILED_JUDGE_RUNTIME
        string preludeSource = embedLearnerRuntime
            ? GenerateNodePreludeSource(originalUserTree)
            : "precompiled-trusted-judge-runtime-v1";
#else
        string preludeSource = GenerateNodePreludeSource(originalUserTree);
#endif
        RecordCompilePhase(timings, "compileGenerateRuntimePreludeMs", phaseStopwatch);

        lock (CompilerAuthorityState.TrustedCompilationTemplatesLock)
        {
            if (CompilerAuthorityState.TrustedCompilationTemplates.TryGetValue(
                preludeSource,
                out CSharpCompilation? cached
            ))
            {
                timings?["compileTrustedTemplateHit"] = true;
                timings?["compileGenerateGlobalUsingsMs"] = 0d;
                timings?["compileParseGlobalUsingsMs"] = 0d;
                timings?["compileGenerateRuntimeMs"] = 0d;
                timings?["compileParseRuntimeMs"] = 0d;
                timings?["compileReferenceAccessMs"] = 0d;
                return cached;
            }

            timings?["compileTrustedTemplateHit"] = false;

            phaseStopwatch.Restart();
            string globalUsingsSource = GenerateGlobalUsingsSource();
            RecordCompilePhase(timings, "compileGenerateGlobalUsingsMs", phaseStopwatch);
            phaseStopwatch.Restart();
            SyntaxTree globalUsingsTree = CSharpSyntaxTree.ParseText(
                globalUsingsSource,
                CompilerAuthorityState.ParseOptions,
                path: "TraceCodeGlobalUsings.cs"
            );
            RecordCompilePhase(timings, "compileParseGlobalUsingsMs", phaseStopwatch);

#if TRACECODE_PRECOMPILED_JUDGE_RUNTIME
            if (!embedLearnerRuntime)
            {
                timings?["compileGenerateRuntimeMs"] = 0d;
                timings?["compileParseRuntimeMs"] = 0d;
                SyntaxTree[] precompiledSyntaxTrees = new[] { globalUsingsTree };
                phaseStopwatch.Restart();
                MetadataReference[] precompiledReferences =
                    CompilerAuthorityState.CachedReferences.Value;
                if (timings is not null)
                {
                    timings["compileReferenceCount"] = precompiledReferences.Length;
                }
                RecordCompilePhase(timings, "compileReferenceAccessMs", phaseStopwatch);
                CSharpCompilation precompiledTemplate = CreateTrustedCompilationTemplate(
                    preludeSource,
                    precompiledSyntaxTrees,
                    precompiledReferences
                );
                CompilerAuthorityState.TrustedCompilationTemplates[preludeSource] =
                    precompiledTemplate;
                return precompiledTemplate;
            }
#endif
            phaseStopwatch.Restart();
            string runtimeSource = GenerateRuntimeSource(preludeSource);
            RecordCompilePhase(timings, "compileGenerateRuntimeMs", phaseStopwatch);
            phaseStopwatch.Restart();
            SyntaxTree runtimeTree = CSharpSyntaxTree.ParseText(
                runtimeSource,
                CompilerAuthorityState.ParseOptions,
                path: "TraceCodeRuntime.cs"
            );
            RecordCompilePhase(timings, "compileParseRuntimeMs", phaseStopwatch);
            SyntaxTree[] trustedSyntaxTrees = new[] { globalUsingsTree, runtimeTree };

            phaseStopwatch.Restart();
            MetadataReference[] references =
                CompilerAuthorityState.CachedReferences.Value;
            if (timings is not null)
            {
                timings["compileReferenceCount"] = references.Length;
            }
            RecordCompilePhase(timings, "compileReferenceAccessMs", phaseStopwatch);

            CSharpCompilation template = CreateTrustedCompilationTemplate(
                preludeSource,
                trustedSyntaxTrees,
                references
            );
            CompilerAuthorityState.TrustedCompilationTemplates[preludeSource] =
                template;
            return template;
        }
    }

    private static CSharpCompilation CreateTrustedCompilationTemplate(
        string assemblySuffix,
        IEnumerable<SyntaxTree> syntaxTrees,
        IEnumerable<MetadataReference> references
    )
    {
        string assemblyNameSuffix = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(assemblySuffix))
        )[..12];
        return CSharpCompilation.Create(
            assemblyName: "TraceCode.TrustedCompilationTemplate." + assemblyNameSuffix,
            syntaxTrees: syntaxTrees,
            references: references,
            options: new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                optimizationLevel: CompilerAuthorityState.JudgeOptimizationLevel,
                concurrentBuild: false,
                allowUnsafe: false
            )
        );
    }

    private static bool UserDeclaresNodeSupport(SyntaxTree userTree)
    {
        return userTree
            .GetCompilationUnitRoot()
            .DescendantNodes()
            .OfType<ClassDeclarationSyntax>()
            .Any(type => type.Identifier.ValueText is "ListNode" or "TreeNode");
    }

    private static void RecordCompilePhase(
        IDictionary<string, object>? timings,
        string name,
        Stopwatch stopwatch
    )
    {
        if (timings is not null)
        {
            timings[name] = stopwatch.Elapsed.TotalMilliseconds;
        }
    }

    private static CSharpCompilation CreateProjectCompilation(CSharpProjectCommandRequest request)
    {
        List<SyntaxTree> syntaxTrees = new()
        {
            CSharpSyntaxTree.ParseText(
                SourceText.From(GenerateGlobalUsingsSource(), Encoding.UTF8),
                CompilerAuthorityState.ParseOptions,
                path: "TraceCodeGlobalUsings.cs"
            ),
            CSharpSyntaxTree.ParseText(
                SourceText.From(GenerateProjectRuntimeSource(), Encoding.UTF8),
                CompilerAuthorityState.ParseOptions,
                path: "TraceCodeProjectRuntime.cs"
            ),
        };

        HashSet<string> compileFilePaths = ResolveProjectCompileFilePaths(request);
        CSharpParseOptions projectParseOptions =
            CompilerAuthorityState.ParseOptions.WithPreprocessorSymbols(
                ResolveProjectDefineConstants(request)
            );
        List<SyntaxTree> userSyntaxTrees = new();
        foreach (CSharpProjectFile file in request.Project.Files)
        {
            string path = NormalizeProjectPath(file.Path);
            if (!compileFilePaths.Contains(path))
            {
                continue;
            }
            SyntaxTree projectTree = CSharpSyntaxTree.ParseText(
                SourceText.From(DecodeProjectFileContents(file), Encoding.UTF8),
                projectParseOptions,
                path: path
            );
            ValidateUserSourcePolicy(projectTree);
            SyntaxTree rewrittenProjectTree = RewriteProjectSyntaxTree(
                projectTree
            );
            syntaxTrees.Add(rewrittenProjectTree);
            userSyntaxTrees.Add(rewrittenProjectTree);
        }

        CSharpCompilationOptions options = new CSharpCompilationOptions(
            ResolveProjectOutputKind(request),
            optimizationLevel: OptimizationLevel.Release,
            concurrentBuild: false,
            allowUnsafe: ResolveProjectBooleanProperty(request, "AllowUnsafeBlocks")
        );
        string? startupObject = ResolveProjectStartupObject(request);
        if (!string.IsNullOrWhiteSpace(startupObject))
        {
            options = options.WithMainTypeName(startupObject);
        }

        CSharpCompilation compilation = CSharpCompilation.Create(
            assemblyName: "TraceCode.Project." + Guid.NewGuid().ToString("N"),
            syntaxTrees: syntaxTrees,
            references: CompilerAuthorityState.CachedReferences.Value.Concat(
                ResolveProjectMetadataReferences(request)
            ),
            options: options
        );
        ValidateUserSemanticPolicy(compilation, userSyntaxTrees);
        return compilation;
    }

    private static void ValidateUserSourcePolicy(SyntaxTree tree)
    {
        SyntaxNode root = tree.GetRoot();
        HashSet<string> deniedAliases = root
            .DescendantNodes()
            .OfType<UsingDirectiveSyntax>()
            .Where(usingDirective => usingDirective.Alias is not null && DeniedUserApiSymbol(usingDirective.Name?.ToString()) is not null)
            .Select(usingDirective => usingDirective.Alias!.Name.Identifier.ValueText)
            .Where(alias => !string.IsNullOrWhiteSpace(alias))
            .ToHashSet(StringComparer.Ordinal);
        foreach (SyntaxNode node in root.DescendantNodesAndSelf())
        {
            string? deniedApi = DeniedUserApiForNode(node, deniedAliases);
            if (deniedApi is not null)
            {
                throw new InvalidOperationException($"C# user code references denied browser runtime API: {deniedApi}.");
            }
        }
    }

    private static void ValidateUserSemanticPolicy(
        CSharpCompilation compilation,
        IEnumerable<SyntaxTree> userTrees
    )
    {
        foreach (SyntaxTree tree in userTrees)
        {
            SemanticModel model = compilation.GetSemanticModel(
                tree,
                ignoreAccessibility: false
            );
            foreach (
                SimpleNameSyntax name in tree
                    .GetRoot()
                    .DescendantNodesAndSelf()
                    .OfType<SimpleNameSyntax>()
            )
            {
                SymbolInfo symbolInfo = model.GetSymbolInfo(name);
                IEnumerable<ISymbol> symbols = symbolInfo.Symbol is null
                    ? symbolInfo.CandidateSymbols
                    : new[] { symbolInfo.Symbol };
                if (symbols.Any(IsTrustedCompilerHostSymbol))
                {
                    throw new InvalidOperationException(
                        "C# user code references denied browser runtime API: TraceCode.CSharpHost.CompilerHost."
                    );
                }
                if (symbols.Any(IsTrustedJudgeRuntimeContextSymbol))
                {
                    throw new InvalidOperationException(
                        "C# user code references denied browser runtime API: TraceCode.CSharpHost.JudgeRuntimeContext."
                    );
                }
            }
        }
    }

    private static bool IsTrustedCompilerHostSymbol(ISymbol symbol)
    {
        ISymbol target = symbol is IAliasSymbol alias ? alias.Target : symbol;
        INamedTypeSymbol? containingType =
            target as INamedTypeSymbol ?? target.ContainingType;
        return string.Equals(
            containingType?.ToDisplayString(
                SymbolDisplayFormat.FullyQualifiedFormat
            ),
            "global::TraceCode.CSharpHost.CompilerHost",
            StringComparison.Ordinal
        );
    }

    private static bool IsTrustedJudgeRuntimeContextSymbol(ISymbol symbol)
    {
        ISymbol target = symbol is IAliasSymbol alias ? alias.Target : symbol;
        INamedTypeSymbol? containingType =
            target as INamedTypeSymbol ?? target.ContainingType;
        return string.Equals(
            containingType?.ToDisplayString(
                SymbolDisplayFormat.FullyQualifiedFormat
            ),
            "global::TraceCode.CSharpHost.JudgeRuntimeContext",
            StringComparison.Ordinal
        );
    }

    private static string? DeniedUserApiForNode(SyntaxNode node, IReadOnlySet<string> deniedAliases)
    {
        if (node is IdentifierNameSyntax identifierName && deniedAliases.Contains(identifierName.Identifier.ValueText))
        {
            return identifierName.Identifier.ValueText;
        }

        if (node is UsingDirectiveSyntax usingDirective)
        {
            return DeniedUserApiSymbol(usingDirective.Name?.ToString());
        }

        if (node is QualifiedNameSyntax qualifiedName)
        {
            return DeniedUserApiSymbol(qualifiedName.ToString());
        }

        if (node is AliasQualifiedNameSyntax aliasQualifiedName)
        {
            return DeniedUserApiSymbol(aliasQualifiedName.ToString());
        }

        if (node is MemberAccessExpressionSyntax memberAccess)
        {
            string memberText = NormalizeCSharpSymbolText(memberAccess.ToString());
            foreach (string alias in deniedAliases)
            {
                if (string.Equals(memberText, alias, StringComparison.Ordinal) ||
                    memberText.StartsWith(alias + ".", StringComparison.Ordinal))
                {
                    return alias;
                }
            }
            return DeniedUserApiSymbol(memberAccess.ToString());
        }

        if (node is ObjectCreationExpressionSyntax objectCreation)
        {
            return DeniedUserApiSymbol(objectCreation.Type.ToString());
        }

        if (node is InvocationExpressionSyntax invocation)
        {
            string expression = NormalizeCSharpSymbolText(invocation.Expression.ToString());
            foreach (string deniedInvocation in DeniedUserReflectionInvocations)
            {
                if (string.Equals(expression, deniedInvocation, StringComparison.Ordinal))
                {
                    return deniedInvocation;
                }
            }
        }

        return null;
    }

    private static string? DeniedUserApiSymbol(string? symbolText)
    {
        string symbol = NormalizeCSharpSymbolText(symbolText ?? string.Empty);
        if (symbol.StartsWith("global::", StringComparison.Ordinal))
        {
            symbol = symbol["global::".Length..];
        }

        foreach (string deniedApi in DeniedUserApiText)
        {
            if (string.Equals(symbol, deniedApi, StringComparison.Ordinal) ||
                symbol.StartsWith(deniedApi + ".", StringComparison.Ordinal))
            {
                return deniedApi;
            }
        }

        return null;
    }

    private static string NormalizeCSharpSymbolText(string value)
    {
        return Regex.Replace(value, "\\s+", string.Empty);
    }

    private static OutputKind ResolveProjectOutputKind(CSharpProjectCommandRequest request)
    {
        string? outputType = ResolveProjectPropertyValue(request, "OutputType");
        if (string.Equals(outputType, "Library", StringComparison.OrdinalIgnoreCase))
        {
            return OutputKind.DynamicallyLinkedLibrary;
        }

        return OutputKind.ConsoleApplication;
    }

    private static string? ResolveProjectStartupObject(CSharpProjectCommandRequest request)
    {
        return ResolveProjectPropertyValue(request, "StartupObject");
    }

    private static IReadOnlyList<string> ResolveProjectDefineConstants(CSharpProjectCommandRequest request)
    {
        string? value = ResolveProjectPropertyValue(request, "DefineConstants");
        if (string.IsNullOrWhiteSpace(value))
        {
            return Array.Empty<string>();
        }

        return value
            .Split(new[] { ';', ',', ' ' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(symbol => Regex.IsMatch(symbol, @"^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.CultureInvariant))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }

    private static bool ResolveProjectBooleanProperty(CSharpProjectCommandRequest request, string propertyName)
    {
        string? value = ResolveProjectPropertyValue(request, propertyName);
        return string.Equals(value, "true", StringComparison.OrdinalIgnoreCase);
    }

    private static string? ResolveProjectPropertyValue(CSharpProjectCommandRequest request, string propertyName)
    {
        string? commandLineValue = ResolveProjectCommandLinePropertyValue(request, propertyName);
        if (!string.IsNullOrWhiteSpace(commandLineValue))
        {
            return commandLineValue;
        }

        Dictionary<string, CSharpProjectFile> filesByPath = request.Project.Files
            .Select(file => new KeyValuePair<string, CSharpProjectFile>(NormalizeProjectPath(file.Path), file))
            .GroupBy(entry => entry.Key, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Last().Value, StringComparer.Ordinal);
        string? projectPath = ResolveProjectFilePath(request, filesByPath.Keys);
        if (projectPath is null || !filesByPath.TryGetValue(projectPath, out CSharpProjectFile? projectFile))
        {
            return null;
        }

        try
        {
            XDocument document = XDocument.Parse(DecodeProjectFileContents(projectFile));
            return document
                .Descendants()
                .Where(element => string.Equals(element.Name.LocalName, propertyName, StringComparison.OrdinalIgnoreCase))
                .Select(element => (element.Value ?? string.Empty).Trim())
                .FirstOrDefault(value => value.Length > 0);
        }
        catch
        {
            return null;
        }
    }

    private static string? ResolveProjectCommandLinePropertyValue(CSharpProjectCommandRequest request, string propertyName)
    {
        foreach (string arg in ResolveProjectCommandLinePropertyArgs(request))
        {
            string text = arg.Trim();
            string propertyText;
            if (text.StartsWith("-p:", StringComparison.OrdinalIgnoreCase) || text.StartsWith("/p:", StringComparison.OrdinalIgnoreCase))
            {
                propertyText = text[3..];
            }
            else if (text.StartsWith("-property:", StringComparison.OrdinalIgnoreCase))
            {
                propertyText = text["-property:".Length..];
            }
            else if (text.StartsWith("--property:", StringComparison.OrdinalIgnoreCase))
            {
                propertyText = text["--property:".Length..];
            }
            else
            {
                continue;
            }

            foreach ((string name, string value) in ParseProjectCommandLineProperties(propertyText))
            {
                if (string.Equals(name, propertyName, StringComparison.OrdinalIgnoreCase))
                {
                    return value;
                }
            }
        }

        return null;
    }

    private static IReadOnlyList<string> ResolveProjectCommandLinePropertyArgs(CSharpProjectCommandRequest request)
    {
        if (string.Equals(request.Source, "compile", StringComparison.Ordinal))
        {
            return request.Args;
        }

        if (
            request.Options.TryGetValue("buildArgs", out JsonElement buildArgsElement) &&
            buildArgsElement.ValueKind == JsonValueKind.Array
        )
        {
            return buildArgsElement
                .EnumerateArray()
                .Where(element => element.ValueKind == JsonValueKind.String)
                .Select(element => element.GetString() ?? string.Empty)
                .ToArray();
        }

        return Array.Empty<string>();
    }

    private static IEnumerable<(string Name, string Value)> ParseProjectCommandLineProperties(string propertyText)
    {
        string? currentName = null;
        StringBuilder currentValue = new();

        foreach (string segment in propertyText.Split(';', StringSplitOptions.None))
        {
            int equalsIndex = segment.IndexOf('=');
            string candidateName = equalsIndex > 0 ? segment[..equalsIndex].Trim() : string.Empty;
            bool startsProperty = candidateName.Length > 0 && Regex.IsMatch(candidateName, @"^[A-Za-z_][A-Za-z0-9_.-]*$", RegexOptions.CultureInvariant);
            if (startsProperty)
            {
                if (currentName is not null)
                {
                    yield return (currentName, UnescapeProjectCommandLinePropertyValue(currentValue.ToString().Trim()));
                }

                currentName = candidateName;
                currentValue.Clear();
                currentValue.Append(segment[(equalsIndex + 1)..]);
                continue;
            }

            if (currentName is null)
            {
                continue;
            }

            currentValue.Append(';');
            currentValue.Append(segment);
        }

        if (currentName is not null)
        {
            yield return (currentName, UnescapeProjectCommandLinePropertyValue(currentValue.ToString().Trim()));
        }
    }

    private static string UnescapeProjectCommandLinePropertyValue(string value)
    {
        try
        {
            return System.Uri.UnescapeDataString(value);
        }
        catch
        {
            return value;
        }
    }

    private static IEnumerable<MetadataReference> ResolveProjectMetadataReferences(CSharpProjectCommandRequest request)
    {
        foreach (ProjectHintPathAssembly referenceAssembly in ResolveProjectHintPathAssemblies(request))
        {
            if (!IsAllowedUserAssemblyName(referenceAssembly.Name) ||
                !IsAllowedUserMetadataReference(referenceAssembly.FileName))
            {
                continue;
            }
            yield return MetadataReference.CreateFromImage(referenceAssembly.Bytes);
        }
    }

    private sealed record ProjectHintPathAssembly(string Name, string FileName, byte[] Bytes);

    private static IEnumerable<ProjectHintPathAssembly> ResolveProjectHintPathAssemblies(CSharpProjectCommandRequest request)
    {
        Dictionary<string, CSharpProjectFile> filesByPath = request.Project.Files
            .Select(file => new KeyValuePair<string, CSharpProjectFile>(NormalizeProjectPath(file.Path), file))
            .GroupBy(entry => entry.Key, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Last().Value, StringComparer.Ordinal);
        string? projectPath = ResolveProjectFilePath(request, filesByPath.Keys);
        if (projectPath is null || !filesByPath.TryGetValue(projectPath, out CSharpProjectFile? projectFile))
        {
            yield break;
        }

        XDocument document;
        try
        {
            document = XDocument.Parse(DecodeProjectFileContents(projectFile));
        }
        catch
        {
            yield break;
        }

        string projectDirectory = ProjectDirectory(projectPath);
        HashSet<string> yielded = new(StringComparer.Ordinal);
        foreach (XElement referenceElement in document.Descendants().Where(element => string.Equals(element.Name.LocalName, "Reference", StringComparison.OrdinalIgnoreCase)))
        {
            string? hintPath = referenceElement
                .Elements()
                .Where(element => string.Equals(element.Name.LocalName, "HintPath", StringComparison.OrdinalIgnoreCase))
                .Select(element => (element.Value ?? string.Empty).Trim())
                .FirstOrDefault(value => value.Length > 0);
            if (string.IsNullOrWhiteSpace(hintPath))
            {
                continue;
            }

            string referencePath = NormalizeProjectItemPattern(projectDirectory, hintPath);
            if (!yielded.Add(referencePath))
            {
                continue;
            }
            if (filesByPath.TryGetValue(referencePath, out CSharpProjectFile? referenceFile))
            {
                byte[] referenceBytes = DecodeProjectFileBytes(referenceFile);
                string fileName = Path.GetFileName(referencePath);
                if (!IsAllowedUserMetadataReference(fileName))
                {
                    continue;
                }
                string name = Path.GetFileNameWithoutExtension(referencePath);
                try
                {
                    name = AssemblyName.GetAssemblyName(ResolveProjectPath(referencePath)).Name ?? name;
                }
                catch
                {
                }
                if (!IsAllowedUserAssemblyName(name))
                {
                    continue;
                }
                yield return new ProjectHintPathAssembly(name, fileName, referenceBytes);
            }
        }
    }

    private static IEnumerable<ResourceDescription> ResolveProjectEmbeddedResources(CSharpProjectCommandRequest request)
    {
        Dictionary<string, CSharpProjectFile> filesByPath = request.Project.Files
            .Select(file => new KeyValuePair<string, CSharpProjectFile>(NormalizeProjectPath(file.Path), file))
            .GroupBy(entry => entry.Key, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Last().Value, StringComparer.Ordinal);
        string? projectPath = ResolveProjectFilePath(request, filesByPath.Keys);
        if (projectPath is null || !filesByPath.TryGetValue(projectPath, out CSharpProjectFile? projectFile))
        {
            return Array.Empty<ResourceDescription>();
        }

        XDocument document;
        try
        {
            document = XDocument.Parse(DecodeProjectFileContents(projectFile));
        }
        catch
        {
            return Array.Empty<ResourceDescription>();
        }

        string projectDirectory = ProjectDirectory(projectPath);
        List<ResourceDescription> resources = new();
        foreach (XElement resourceElement in document.Descendants().Where(element => string.Equals(element.Name.LocalName, "EmbeddedResource", StringComparison.OrdinalIgnoreCase)))
        {
            string? include = resourceElement.Attribute("Include")?.Value;
            if (string.IsNullOrWhiteSpace(include))
            {
                continue;
            }

            string? logicalName = ProjectItemMetadata(resourceElement, "LogicalName") ?? ProjectItemMetadata(resourceElement, "ManifestResourceName");
            foreach (string resourcePath in ResolveProjectItemPaths(include, projectDirectory, filesByPath.Keys))
            {
                if (!filesByPath.TryGetValue(resourcePath, out CSharpProjectFile? resourceFile))
                {
                    continue;
                }

                byte[] bytes = DecodeProjectFileBytes(resourceFile);
                string resourceName = !string.IsNullOrWhiteSpace(logicalName)
                    ? logicalName
                    : DefaultEmbeddedResourceName(request, projectPath, resourcePath);
                resources.Add(new ResourceDescription(resourceName, () => new MemoryStream(bytes, writable: false), isPublic: true));
            }
        }
        return resources;
    }

    private static string? ProjectItemMetadata(XElement element, string metadataName)
    {
        return element
            .Elements()
            .Where(child => string.Equals(child.Name.LocalName, metadataName, StringComparison.OrdinalIgnoreCase))
            .Select(child => (child.Value ?? string.Empty).Trim())
            .FirstOrDefault(value => value.Length > 0);
    }

    private static IEnumerable<string> ResolveProjectItemPaths(string value, string projectDirectory, IEnumerable<string> candidatePaths)
    {
        foreach (string rawPattern in value.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            string pattern = NormalizeProjectItemPattern(projectDirectory, rawPattern);
            foreach (string path in candidatePaths.Where(path => ProjectGlobMatches(pattern, path)).OrderBy(path => path, StringComparer.Ordinal))
            {
                yield return path;
            }
        }
    }

    private static string DefaultEmbeddedResourceName(CSharpProjectCommandRequest request, string projectPath, string resourcePath)
    {
        string? rootNamespace = ResolveProjectPropertyValue(request, "RootNamespace");
        string projectDirectory = ProjectDirectory(projectPath);
        string relativePath = IsUnderProjectDirectory(resourcePath, projectDirectory) && !string.IsNullOrEmpty(projectDirectory)
            ? resourcePath[(projectDirectory.Length + 1)..]
            : resourcePath;
        string normalized = Regex.Replace(relativePath, @"[^A-Za-z0-9_]+", ".", RegexOptions.CultureInvariant).Trim('.');
        return string.IsNullOrWhiteSpace(rootNamespace) ? normalized : rootNamespace + "." + normalized;
    }

    private static HashSet<string> ResolveProjectCompileFilePaths(CSharpProjectCommandRequest request)
    {
        Dictionary<string, CSharpProjectFile> filesByPath = request.Project.Files
            .Select(file => new KeyValuePair<string, CSharpProjectFile>(NormalizeProjectPath(file.Path), file))
            .GroupBy(entry => entry.Key, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Last().Value, StringComparer.Ordinal);
        List<string> csharpFiles = filesByPath.Keys
            .Where(path => path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToList();
        string? projectPath = ResolveProjectFilePath(request, filesByPath.Keys);
        if (projectPath is null || !filesByPath.TryGetValue(projectPath, out CSharpProjectFile? projectFile))
        {
            string cwd = NormalizeProjectDirectoryPath(request.Cwd);
            return csharpFiles
                .Where(path => IsUnderProjectDirectory(path, cwd)
                    && !IsInBuildOutputDirectory(path, cwd))
                .ToHashSet(StringComparer.Ordinal);
        }

        return ResolveProjectCompileFilePaths(projectPath, projectFile, filesByPath, csharpFiles, new HashSet<string>(StringComparer.Ordinal));
    }

    private static HashSet<string> ResolveProjectCompileFilePaths(
        string projectPath,
        CSharpProjectFile projectFile,
        IReadOnlyDictionary<string, CSharpProjectFile> filesByPath,
        IReadOnlyList<string> csharpFiles,
        HashSet<string> visitedProjects
    )
    {
        if (!visitedProjects.Add(projectPath))
        {
            return new HashSet<string>(StringComparer.Ordinal);
        }

        string projectDirectory = ProjectDirectory(projectPath);
        XDocument document;
        try
        {
            document = XDocument.Parse(DecodeProjectFileContents(projectFile));
        }
        catch
        {
            return csharpFiles
                .Where(path => IsUnderProjectDirectory(path, projectDirectory)
                    && !IsInBuildOutputDirectory(path, projectDirectory))
                .ToHashSet(StringComparer.Ordinal);
        }

        bool enableDefaultCompileItems = !document
            .Descendants()
            .Where(element => string.Equals(element.Name.LocalName, "EnableDefaultCompileItems", StringComparison.OrdinalIgnoreCase))
            .Any(element => string.Equals((element.Value ?? string.Empty).Trim(), "false", StringComparison.OrdinalIgnoreCase));

        HashSet<string> selected = enableDefaultCompileItems
            ? csharpFiles
                .Where(path => IsUnderProjectDirectory(path, projectDirectory)
                    && !IsInBuildOutputDirectory(path, projectDirectory))
                .ToHashSet(StringComparer.Ordinal)
            : new HashSet<string>(StringComparer.Ordinal);

        foreach (XElement compileElement in document.Descendants().Where(element => string.Equals(element.Name.LocalName, "Compile", StringComparison.OrdinalIgnoreCase)))
        {
            ApplyCompileAttribute(compileElement.Attribute("Include")?.Value, projectDirectory, csharpFiles, selected, include: true);
            ApplyCompileAttribute(compileElement.Attribute("Remove")?.Value, projectDirectory, csharpFiles, selected, include: false);
            ApplyCompileAttribute(compileElement.Attribute("Exclude")?.Value, projectDirectory, csharpFiles, selected, include: false);
        }

        foreach (XElement referenceElement in document.Descendants().Where(element => string.Equals(element.Name.LocalName, "ProjectReference", StringComparison.OrdinalIgnoreCase)))
        {
            foreach (string referencedProjectPath in ResolveProjectReferencePaths(referenceElement.Attribute("Include")?.Value, projectDirectory))
            {
                if (filesByPath.TryGetValue(referencedProjectPath, out CSharpProjectFile? referencedProjectFile))
                {
                    selected.UnionWith(ResolveProjectCompileFilePaths(
                        referencedProjectPath,
                        referencedProjectFile,
                        filesByPath,
                        csharpFiles,
                        visitedProjects
                    ));
                }
            }
        }

        return selected;
    }

    private static IEnumerable<string> ResolveProjectReferencePaths(string? value, string projectDirectory)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            yield break;
        }

        foreach (string rawPath in value.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            string path = NormalizeProjectItemPattern(projectDirectory, rawPath);
            if (path.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
            {
                yield return path;
            }
        }
    }

    private static string? ResolveProjectFilePath(CSharpProjectCommandRequest request, IEnumerable<string> projectPaths)
    {
        if (request.ScriptPath.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
        {
            string scriptCwd = NormalizeProjectDirectoryPath(request.Cwd);
            return NormalizeProjectItemPattern(scriptCwd, request.ScriptPath);
        }

        string cwd = NormalizeProjectDirectoryPath(request.Cwd);
        return projectPaths
            .Where(path => path.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(path => IsUnderProjectDirectory(path, cwd))
            .ThenBy(path => path, StringComparer.Ordinal)
            .FirstOrDefault();
    }

    private static string ProjectDirectory(string path)
    {
        int index = path.LastIndexOf('/');
        return index < 0 ? string.Empty : path[..index];
    }

    private static string NormalizeProjectDirectoryPath(string path)
    {
        if (string.Equals(path, "/workspace", StringComparison.Ordinal)
            || string.Equals(path, "<project>", StringComparison.Ordinal))
        {
            return string.Empty;
        }
        return NormalizeProjectPath(path);
    }

    private static bool IsUnderProjectDirectory(string path, string projectDirectory)
    {
        return string.IsNullOrEmpty(projectDirectory)
            || path.StartsWith(projectDirectory + "/", StringComparison.Ordinal);
    }

    private static bool IsInBuildOutputDirectory(string path, string projectDirectory)
    {
        string relativePath = string.IsNullOrEmpty(projectDirectory) ? path : path[(projectDirectory.Length + 1)..];
        return relativePath.StartsWith("bin/", StringComparison.Ordinal)
            || relativePath.StartsWith("obj/", StringComparison.Ordinal);
    }

    private static void ApplyCompileAttribute(
        string? value,
        string projectDirectory,
        IReadOnlyList<string> csharpFiles,
        HashSet<string> selected,
        bool include
    )
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return;
        }

        foreach (string rawPattern in value.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            string pattern = NormalizeProjectItemPattern(projectDirectory, rawPattern);
            foreach (string path in csharpFiles.Where(path => ProjectGlobMatches(pattern, path)))
            {
                if (include)
                {
                    selected.Add(path);
                }
                else
                {
                    selected.Remove(path);
                }
            }
        }
    }

    private static string NormalizeProjectItemPattern(string projectDirectory, string pattern)
    {
        string normalized = pattern.Replace('\\', '/');
        if (normalized.StartsWith("/workspace/", StringComparison.Ordinal))
        {
            return NormalizeProjectPath(normalized);
        }
        if (normalized.StartsWith("/", StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Project path escapes workspace: {pattern}");
        }
        normalized = normalized.TrimStart('/');
        return NormalizeProjectPath(string.IsNullOrEmpty(projectDirectory) ? normalized : projectDirectory + "/" + normalized);
    }

    private static bool ProjectGlobMatches(string pattern, string path)
    {
        string regex = "^" + Regex.Escape(pattern)
            .Replace("\\*\\*/", "(?:.*/)?", StringComparison.Ordinal)
            .Replace("\\*\\*", ".*", StringComparison.Ordinal)
            .Replace("\\*", "[^/]*", StringComparison.Ordinal)
            .Replace("\\?", "[^/]", StringComparison.Ordinal) + "$";
        return Regex.IsMatch(path, regex, RegexOptions.CultureInvariant);
    }

    private static SyntaxTree RewriteProjectSyntaxTree(SyntaxTree tree)
    {
        SyntaxNode root = tree.GetRoot();
        SyntaxNode rewrittenRoot = new ProjectConsoleRewriter(root).Visit(root) ?? root;
        return CSharpSyntaxTree.Create(
            (CSharpSyntaxNode)rewrittenRoot,
            CompilerAuthorityState.ParseOptions,
            path: tree.FilePath,
            encoding: Encoding.UTF8
        );
    }

    private sealed class ProjectConsoleRewriter : CSharpSyntaxRewriter
    {
        private readonly HashSet<string> fileAliases;
        private readonly HashSet<string> directoryAliases;
        private readonly HashSet<string> streamWriterAliases;
        private readonly HashSet<string> fileStreamAliases;

        public ProjectConsoleRewriter(SyntaxNode root)
        {
            fileAliases = CollectTypeAliases(root, "File", "System.IO.File", "global::System.IO.File");
            directoryAliases = CollectTypeAliases(root, "Directory", "System.IO.Directory", "global::System.IO.Directory");
            streamWriterAliases = CollectTypeAliases(root, "StreamWriter", "System.IO.StreamWriter", "global::System.IO.StreamWriter");
            fileStreamAliases = CollectTypeAliases(root, "FileStream", "System.IO.FileStream", "global::System.IO.FileStream");
        }

        public override SyntaxNode? VisitInvocationExpression(InvocationExpressionSyntax node)
        {
            if (node.Expression is MemberAccessExpressionSyntax memberAccess
                && string.Equals(memberAccess.Name.Identifier.ValueText, "ReadLine", StringComparison.Ordinal)
                && memberAccess.Expression is IdentifierNameSyntax identifier
                && string.Equals(identifier.Identifier.ValueText, "Console", StringComparison.Ordinal))
            {
                return node.WithExpression(
                    SyntaxFactory.ParseExpression("TraceCode.Project.ProjectStdin.ReadLine")
                        .WithTriviaFrom(node.Expression)
                );
            }
            if (node.Expression is MemberAccessExpressionSyntax fileMemberAccess
                && IsProjectFileApi(fileMemberAccess.Expression)
                && IsProjectFileMutationMethod(fileMemberAccess.Name.Identifier.ValueText))
            {
                return node.WithExpression(
                    SyntaxFactory.ParseExpression($"TraceCode.Project.ProjectFile.{fileMemberAccess.Name.Identifier.ValueText}")
                        .WithTriviaFrom(node.Expression)
                );
            }
            if (node.Expression is MemberAccessExpressionSyntax directoryMemberAccess
                && IsProjectDirectoryApi(directoryMemberAccess.Expression)
                && IsProjectDirectoryMutationMethod(directoryMemberAccess.Name.Identifier.ValueText))
            {
                return node.WithExpression(
                    SyntaxFactory.ParseExpression($"TraceCode.Project.ProjectDirectory.{directoryMemberAccess.Name.Identifier.ValueText}")
                        .WithTriviaFrom(node.Expression)
                );
            }

            return base.VisitInvocationExpression(node);
        }

        public override SyntaxNode? VisitObjectCreationExpression(ObjectCreationExpressionSyntax node)
        {
            if (IsProjectStreamWriterType(node.Type))
            {
                return node.WithType(
                    SyntaxFactory.ParseTypeName("TraceCode.Project.ProjectStreamWriter")
                        .WithTriviaFrom(node.Type)
                );
            }
            if (IsProjectFileStreamType(node.Type))
            {
                return node.WithType(
                    SyntaxFactory.ParseTypeName("TraceCode.Project.ProjectFileStream")
                        .WithTriviaFrom(node.Type)
                );
            }

            return base.VisitObjectCreationExpression(node);
        }

        private bool IsProjectStreamWriterType(TypeSyntax type)
        {
            string text = type.ToString();
            return MatchesAliasOrName(type, streamWriterAliases)
                || string.Equals(text, "StreamWriter", StringComparison.Ordinal)
                || string.Equals(text, "System.IO.StreamWriter", StringComparison.Ordinal)
                || string.Equals(text, "global::System.IO.StreamWriter", StringComparison.Ordinal);
        }

        private bool IsProjectFileStreamType(TypeSyntax type)
        {
            string text = type.ToString();
            return MatchesAliasOrName(type, fileStreamAliases)
                || string.Equals(text, "FileStream", StringComparison.Ordinal)
                || string.Equals(text, "System.IO.FileStream", StringComparison.Ordinal)
                || string.Equals(text, "global::System.IO.FileStream", StringComparison.Ordinal);
        }

        private bool IsProjectFileApi(ExpressionSyntax expression)
        {
            string text = expression.ToString();
            return MatchesAliasOrName(expression, fileAliases)
                || string.Equals(text, "File", StringComparison.Ordinal)
                || string.Equals(text, "System.IO.File", StringComparison.Ordinal)
                || string.Equals(text, "global::System.IO.File", StringComparison.Ordinal);
        }

        private bool IsProjectDirectoryApi(ExpressionSyntax expression)
        {
            string text = expression.ToString();
            return MatchesAliasOrName(expression, directoryAliases)
                || string.Equals(text, "Directory", StringComparison.Ordinal)
                || string.Equals(text, "System.IO.Directory", StringComparison.Ordinal)
                || string.Equals(text, "global::System.IO.Directory", StringComparison.Ordinal);
        }

        private static HashSet<string> CollectTypeAliases(SyntaxNode root, params string[] typeNames)
        {
            HashSet<string> aliases = new(StringComparer.Ordinal);
            HashSet<string> targets = new(typeNames, StringComparer.Ordinal);
            foreach (UsingDirectiveSyntax directive in root.DescendantNodes().OfType<UsingDirectiveSyntax>())
            {
                string? alias = directive.Alias?.Name.Identifier.ValueText;
                string? name = directive.Name?.ToString();
                if (!string.IsNullOrWhiteSpace(alias) && name is not null && targets.Contains(name))
                {
                    aliases.Add(alias);
                }
            }
            return aliases;
        }

        private static bool MatchesAliasOrName(SyntaxNode node, HashSet<string> aliases)
        {
            return node is IdentifierNameSyntax identifier && aliases.Contains(identifier.Identifier.ValueText);
        }

        private static bool IsProjectFileMutationMethod(string method)
        {
            return method is
                "WriteAllText" or
                "WriteAllBytes" or
                "WriteAllLines" or
                "WriteAllTextAsync" or
                "WriteAllBytesAsync" or
                "WriteAllLinesAsync" or
                "AppendAllLines" or
                "AppendAllBytes" or
                "AppendAllText" or
                "AppendAllLinesAsync" or
                "AppendAllBytesAsync" or
                "AppendAllTextAsync" or
                "CreateText" or
                "AppendText" or
                "OpenWrite" or
                "Create" or
                "Open" or
                "SetAttributes" or
                "SetCreationTime" or
                "SetCreationTimeUtc" or
                "SetLastAccessTime" or
                "SetLastAccessTimeUtc" or
                "SetLastWriteTime" or
                "SetLastWriteTimeUtc" or
                "Delete" or
                "Move" or
                "Copy";
        }

        private static bool IsProjectDirectoryMutationMethod(string method)
        {
            return method is
                "CreateDirectory" or
                "SetCreationTime" or
                "SetCreationTimeUtc" or
                "SetLastAccessTime" or
                "SetLastAccessTimeUtc" or
                "SetLastWriteTime" or
                "SetLastWriteTimeUtc" or
                "Delete" or
                "Move";
        }
    }

    private static string GenerateProjectRuntimeSource()
    {
        return $$"""
namespace TraceCode.Project;

public static class ProjectStdin
{
    public static string? ReadLine()
    {
        System.Text.StringBuilder builder = new();
        bool readAny = false;
        while (true)
        {
            int value = TraceCode.CSharpHost.CompilerHost.ReadProjectInputByte();
            if (value < 0)
            {
                return readAny ? builder.ToString() : null;
            }
            readAny = true;
            if (value == 10)
            {
                return builder.ToString();
            }
            if (value != 13)
            {
                builder.Append((char)value);
            }
        }
    }
}

public static class ProjectFile
{
    public static void WriteAllText(string path, string? contents)
    {
        System.IO.File.WriteAllText(path, contents);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }

    public static void WriteAllText(string path, string? contents, System.Text.Encoding encoding)
    {
        System.IO.File.WriteAllText(path, contents, encoding);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }

    public static void WriteAllBytes(string path, byte[] bytes)
    {
        System.IO.File.WriteAllBytes(path, bytes);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }

    public static void WriteAllLines(string path, System.Collections.Generic.IEnumerable<string> contents)
    {
        System.IO.File.WriteAllLines(path, contents);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }

    public static void WriteAllLines(string path, System.Collections.Generic.IEnumerable<string> contents, System.Text.Encoding encoding)
    {
        System.IO.File.WriteAllLines(path, contents, encoding);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }

    public static void AppendAllLines(string path, System.Collections.Generic.IEnumerable<string> contents)
    {
        System.IO.File.AppendAllLines(path, contents);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }

    public static void AppendAllLines(string path, System.Collections.Generic.IEnumerable<string> contents, System.Text.Encoding encoding)
    {
        System.IO.File.AppendAllLines(path, contents, encoding);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }

    public static void AppendAllBytes(string path, byte[] bytes)
    {
        System.IO.File.AppendAllBytes(path, bytes);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }

    public static void AppendAllText(string path, string? contents)
    {
        System.IO.File.AppendAllText(path, contents);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }

    public static void AppendAllText(string path, string? contents, System.Text.Encoding encoding)
    {
        System.IO.File.AppendAllText(path, contents, encoding);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }

    public static System.Threading.Tasks.Task WriteAllTextAsync(string path, string? contents, System.Threading.CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        System.IO.File.WriteAllText(path, contents);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public static System.Threading.Tasks.Task WriteAllTextAsync(string path, string? contents, System.Text.Encoding encoding, System.Threading.CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        System.IO.File.WriteAllText(path, contents, encoding);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public static System.Threading.Tasks.Task WriteAllBytesAsync(string path, byte[] bytes, System.Threading.CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        System.IO.File.WriteAllBytes(path, bytes);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public static System.Threading.Tasks.Task WriteAllLinesAsync(string path, System.Collections.Generic.IEnumerable<string> contents, System.Threading.CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        System.IO.File.WriteAllLines(path, contents);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public static System.Threading.Tasks.Task WriteAllLinesAsync(string path, System.Collections.Generic.IEnumerable<string> contents, System.Text.Encoding encoding, System.Threading.CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        System.IO.File.WriteAllLines(path, contents, encoding);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public static System.Threading.Tasks.Task AppendAllTextAsync(string path, string? contents, System.Threading.CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        System.IO.File.AppendAllText(path, contents);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public static System.Threading.Tasks.Task AppendAllTextAsync(string path, string? contents, System.Text.Encoding encoding, System.Threading.CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        System.IO.File.AppendAllText(path, contents, encoding);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public static System.Threading.Tasks.Task AppendAllLinesAsync(string path, System.Collections.Generic.IEnumerable<string> contents, System.Threading.CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        System.IO.File.AppendAllLines(path, contents);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public static System.Threading.Tasks.Task AppendAllLinesAsync(string path, System.Collections.Generic.IEnumerable<string> contents, System.Text.Encoding encoding, System.Threading.CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        System.IO.File.AppendAllLines(path, contents, encoding);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public static System.Threading.Tasks.Task AppendAllBytesAsync(string path, byte[] bytes, System.Threading.CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        System.IO.File.AppendAllBytes(path, bytes);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
        return System.Threading.Tasks.Task.CompletedTask;
    }

    public static System.IO.StreamWriter CreateText(string path)
    {
        return new ProjectStreamWriter(path, append: false);
    }

    public static System.IO.StreamWriter AppendText(string path)
    {
        return new ProjectStreamWriter(path, append: true);
    }

    public static System.IO.FileStream OpenWrite(string path)
    {
        return new ProjectFileStream(path, System.IO.FileMode.OpenOrCreate, System.IO.FileAccess.Write, System.IO.FileShare.None);
    }

    public static System.IO.FileStream Create(string path)
    {
        return new ProjectFileStream(path, System.IO.FileMode.Create, System.IO.FileAccess.ReadWrite, System.IO.FileShare.None);
    }

    public static System.IO.FileStream Create(string path, int bufferSize)
    {
        return new ProjectFileStream(path, System.IO.FileMode.Create, System.IO.FileAccess.ReadWrite, System.IO.FileShare.None, bufferSize);
    }

    public static System.IO.FileStream Create(string path, int bufferSize, System.IO.FileOptions options)
    {
        return new ProjectFileStream(path, System.IO.FileMode.Create, System.IO.FileAccess.ReadWrite, System.IO.FileShare.None, bufferSize, options);
    }

    public static System.IO.FileStream Open(string path, System.IO.FileMode mode)
    {
        return new ProjectFileStream(path, mode);
    }

    public static System.IO.FileStream Open(string path, System.IO.FileMode mode, System.IO.FileAccess access)
    {
        return new ProjectFileStream(path, mode, access);
    }

    public static System.IO.FileStream Open(string path, System.IO.FileMode mode, System.IO.FileAccess access, System.IO.FileShare share)
    {
        return new ProjectFileStream(path, mode, access, share);
    }

    public static void Delete(string path)
    {
        System.IO.File.Delete(path);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileDelete(path);
    }

    public static void Move(string sourceFileName, string destFileName)
    {
        System.IO.File.Move(sourceFileName, destFileName);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileDelete(sourceFileName);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(destFileName);
    }

    public static void Move(string sourceFileName, string destFileName, bool overwrite)
    {
        System.IO.File.Move(sourceFileName, destFileName, overwrite);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileDelete(sourceFileName);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(destFileName);
    }

    public static void Copy(string sourceFileName, string destFileName)
    {
        System.IO.File.Copy(sourceFileName, destFileName);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(destFileName);
    }

    public static void Copy(string sourceFileName, string destFileName, bool overwrite)
    {
        System.IO.File.Copy(sourceFileName, destFileName, overwrite);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(destFileName);
    }

    public static void SetAttributes(string path, System.IO.FileAttributes fileAttributes)
    {
        TraceCode.CSharpHost.CompilerHost.ThrowIfProjectKernelVirtualMutation(path, "chmod");
        System.IO.File.SetAttributes(path, fileAttributes);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }

    public static void SetCreationTime(string path, System.DateTime creationTime)
    {
        TraceCode.CSharpHost.CompilerHost.ThrowIfProjectKernelVirtualMutation(path, "utime");
        System.IO.File.SetCreationTime(path, creationTime);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }

    public static void SetCreationTimeUtc(string path, System.DateTime creationTimeUtc)
    {
        TraceCode.CSharpHost.CompilerHost.ThrowIfProjectKernelVirtualMutation(path, "utime");
        System.IO.File.SetCreationTimeUtc(path, creationTimeUtc);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }

    public static void SetLastAccessTime(string path, System.DateTime lastAccessTime)
    {
        TraceCode.CSharpHost.CompilerHost.ThrowIfProjectKernelVirtualMutation(path, "utime");
        System.IO.File.SetLastAccessTime(path, lastAccessTime);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }

    public static void SetLastAccessTimeUtc(string path, System.DateTime lastAccessTimeUtc)
    {
        TraceCode.CSharpHost.CompilerHost.ThrowIfProjectKernelVirtualMutation(path, "utime");
        System.IO.File.SetLastAccessTimeUtc(path, lastAccessTimeUtc);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }

    public static void SetLastWriteTime(string path, System.DateTime lastWriteTime)
    {
        TraceCode.CSharpHost.CompilerHost.ThrowIfProjectKernelVirtualMutation(path, "utime");
        System.IO.File.SetLastWriteTime(path, lastWriteTime);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }

    public static void SetLastWriteTimeUtc(string path, System.DateTime lastWriteTimeUtc)
    {
        TraceCode.CSharpHost.CompilerHost.ThrowIfProjectKernelVirtualMutation(path, "utime");
        System.IO.File.SetLastWriteTimeUtc(path, lastWriteTimeUtc);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(path);
    }
}

public static class ProjectDirectory
{
    public static System.IO.DirectoryInfo CreateDirectory(string path)
    {
        string[] missingDirectories = TraceCode.CSharpHost.CompilerHost.MissingProjectDirectories(path);
        System.IO.DirectoryInfo directory = System.IO.Directory.CreateDirectory(path);
        foreach (string missingDirectory in missingDirectories)
        {
            if (System.IO.Directory.Exists(missingDirectory))
            {
                TraceCode.CSharpHost.CompilerHost.EmitLiveProjectDirectorySnapshot(missingDirectory);
            }
        }
        return directory;
    }

    public static void Delete(string path)
    {
        System.IO.Directory.Delete(path);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectDirectoryDelete(path);
    }

    public static void Delete(string path, bool recursive)
    {
        System.IO.Directory.Delete(path, recursive);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectDirectoryDelete(path);
    }

    public static void Move(string sourceDirName, string destDirName)
    {
        System.IO.Directory.Move(sourceDirName, destDirName);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectDirectoryDelete(sourceDirName);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectPathSnapshot(destDirName);
    }

    public static void SetCreationTime(string path, System.DateTime creationTime)
    {
        TraceCode.CSharpHost.CompilerHost.ThrowIfProjectKernelVirtualMutation(path, "utime");
        System.IO.Directory.SetCreationTime(path, creationTime);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectPathSnapshot(path);
    }

    public static void SetCreationTimeUtc(string path, System.DateTime creationTimeUtc)
    {
        TraceCode.CSharpHost.CompilerHost.ThrowIfProjectKernelVirtualMutation(path, "utime");
        System.IO.Directory.SetCreationTimeUtc(path, creationTimeUtc);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectPathSnapshot(path);
    }

    public static void SetLastAccessTime(string path, System.DateTime lastAccessTime)
    {
        TraceCode.CSharpHost.CompilerHost.ThrowIfProjectKernelVirtualMutation(path, "utime");
        System.IO.Directory.SetLastAccessTime(path, lastAccessTime);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectPathSnapshot(path);
    }

    public static void SetLastAccessTimeUtc(string path, System.DateTime lastAccessTimeUtc)
    {
        TraceCode.CSharpHost.CompilerHost.ThrowIfProjectKernelVirtualMutation(path, "utime");
        System.IO.Directory.SetLastAccessTimeUtc(path, lastAccessTimeUtc);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectPathSnapshot(path);
    }

    public static void SetLastWriteTime(string path, System.DateTime lastWriteTime)
    {
        TraceCode.CSharpHost.CompilerHost.ThrowIfProjectKernelVirtualMutation(path, "utime");
        System.IO.Directory.SetLastWriteTime(path, lastWriteTime);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectPathSnapshot(path);
    }

    public static void SetLastWriteTimeUtc(string path, System.DateTime lastWriteTimeUtc)
    {
        TraceCode.CSharpHost.CompilerHost.ThrowIfProjectKernelVirtualMutation(path, "utime");
        System.IO.Directory.SetLastWriteTimeUtc(path, lastWriteTimeUtc);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectPathSnapshot(path);
    }
}

public sealed class ProjectStreamWriter : System.IO.StreamWriter
{
    private readonly string Path;

    public ProjectStreamWriter(string path)
        : base(path)
    {
        Path = path;
    }

    public ProjectStreamWriter(string path, bool append)
        : base(path, append)
    {
        Path = path;
    }

    public ProjectStreamWriter(string path, bool append, System.Text.Encoding encoding)
        : base(path, append, encoding)
    {
        Path = path;
    }

    public ProjectStreamWriter(string path, bool append, System.Text.Encoding encoding, int bufferSize)
        : base(path, append, encoding, bufferSize)
    {
        Path = path;
    }

    public override void Flush()
    {
        base.Flush();
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(Path);
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(Path);
    }
}

public sealed class ProjectFileStream : System.IO.FileStream
{
    private readonly string Path;

    public ProjectFileStream(string path, System.IO.FileMode mode)
        : base(path, mode)
    {
        Path = path;
    }

    public ProjectFileStream(string path, System.IO.FileMode mode, System.IO.FileAccess access)
        : base(path, mode, access)
    {
        Path = path;
    }

    public ProjectFileStream(string path, System.IO.FileMode mode, System.IO.FileAccess access, System.IO.FileShare share)
        : base(path, mode, access, share)
    {
        Path = path;
    }

    public ProjectFileStream(string path, System.IO.FileMode mode, System.IO.FileAccess access, System.IO.FileShare share, int bufferSize)
        : base(path, mode, access, share, bufferSize)
    {
        Path = path;
    }

    public ProjectFileStream(string path, System.IO.FileMode mode, System.IO.FileAccess access, System.IO.FileShare share, int bufferSize, bool useAsync)
        : base(path, mode, access, share, bufferSize, useAsync)
    {
        Path = path;
    }

    public ProjectFileStream(string path, System.IO.FileMode mode, System.IO.FileAccess access, System.IO.FileShare share, int bufferSize, System.IO.FileOptions options)
        : base(path, mode, access, share, bufferSize, options)
    {
        Path = path;
    }

    public override void Flush()
    {
        base.Flush();
        EmitSnapshotIfWritable();
    }

    public override void Flush(bool flushToDisk)
    {
        base.Flush(flushToDisk);
        EmitSnapshotIfWritable();
    }

    protected override void Dispose(bool disposing)
    {
        bool canWrite = CanWrite;
        base.Dispose(disposing);
        if (canWrite)
        {
            TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(Path);
        }
    }

    private void EmitSnapshotIfWritable()
    {
        if (CanWrite)
        {
            TraceCode.CSharpHost.CompilerHost.EmitLiveProjectFileSnapshot(Path);
        }
    }
}
""";
    }

    private static void PrepareProjectWorkspace(
        CSharpProjectCommandRequest request,
        out ProjectWorkspaceSnapshot beforeSnapshot
    )
    {
        if (request.TraceKernelFileSystem)
        {
            if (!Directory.Exists(ProjectWorkspaceRoot))
            {
                throw new DirectoryNotFoundException(
                    "TraceKernel project filesystem is not mounted."
                );
            }
            beforeSnapshot = new ProjectWorkspaceSnapshot();
            return;
        }

        if (Directory.Exists(ProjectWorkspaceRoot))
        {
            Directory.Delete(ProjectWorkspaceRoot, recursive: true);
        }
        Directory.CreateDirectory(ProjectWorkspaceRoot);

        foreach (string directory in request.Project.Directories)
        {
            string relativePath = NormalizeProjectPath(directory);
            if (string.IsNullOrEmpty(relativePath) || string.Equals(relativePath, ".", StringComparison.Ordinal))
            {
                continue;
            }
            Directory.CreateDirectory(ResolveProjectPath(relativePath));
        }

        foreach (CSharpProjectFile file in request.Project.Files)
        {
            string relativePath = NormalizeProjectPath(file.Path);
            string absolutePath = ResolveProjectPath(relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(absolutePath) ?? ProjectWorkspaceRoot);
            File.WriteAllBytes(absolutePath, DecodeProjectFileBytes(file));
            if (file.Mode is int mode)
            {
                File.SetUnixFileMode(absolutePath, (UnixFileMode)(mode & 0x0fff));
            }
            if (file.AtimeMs is double atimeMs)
            {
                File.SetLastAccessTimeUtc(absolutePath, DateTimeOffset.FromUnixTimeMilliseconds((long)atimeMs).UtcDateTime);
            }
            if (file.MtimeMs is double mtimeMs)
            {
                File.SetLastWriteTimeUtc(absolutePath, DateTimeOffset.FromUnixTimeMilliseconds((long)mtimeMs).UtcDateTime);
            }
        }

        foreach (CSharpProjectDirectoryMetadata metadata in request.Project.DirectoryMetadata)
        {
            string relativePath = NormalizeProjectPath(metadata.Path);
            string absolutePath = ResolveProjectPath(relativePath);
            if (!Directory.Exists(absolutePath))
            {
                throw new DirectoryNotFoundException($"Directory metadata path does not exist: {metadata.Path}");
            }
            if (metadata.Mode is int mode)
            {
                File.SetUnixFileMode(absolutePath, (UnixFileMode)(mode & 0x0fff));
            }
            if (metadata.AtimeMs is double atimeMs)
            {
                Directory.SetLastAccessTimeUtc(absolutePath, DateTimeOffset.FromUnixTimeMilliseconds((long)atimeMs).UtcDateTime);
            }
            if (metadata.MtimeMs is double mtimeMs)
            {
                Directory.SetLastWriteTimeUtc(absolutePath, DateTimeOffset.FromUnixTimeMilliseconds((long)mtimeMs).UtcDateTime);
            }
        }

        beforeSnapshot = SnapshotProjectWorkspace();
    }

    private static ProjectWorkspaceSnapshot SnapshotProjectWorkspace()
    {
        ProjectWorkspaceSnapshot snapshot = new();
        if (!Directory.Exists(ProjectWorkspaceRoot))
        {
            return snapshot;
        }
        SnapshotProjectDirectory(ProjectWorkspaceRoot, snapshot);
        return snapshot;
    }

    private static void SnapshotProjectDirectory(string directoryPath, ProjectWorkspaceSnapshot snapshot)
    {
        foreach (string entryPath in Directory.EnumerateFileSystemEntries(directoryPath))
        {
            string relativePath = Path.GetRelativePath(ProjectWorkspaceRoot, entryPath).Replace('\\', '/');
            FileSystemInfo info = Directory.Exists(entryPath)
                ? new DirectoryInfo(entryPath)
                : new FileInfo(entryPath);
            if (info is DirectoryInfo)
            {
                SnapshotProjectDirectory(entryPath, snapshot);
                snapshot.Directories[relativePath] = SnapshotProjectDirectoryMetadata(entryPath);
                continue;
            }
            snapshot.Files[relativePath] = SnapshotProjectFile(entryPath);
        }
    }

    private static ProjectFileState SnapshotProjectFile(string path)
    {
        int mode = (int)File.GetUnixFileMode(path) & 0x0fff;
        DateTime atimeUtc = File.GetLastAccessTimeUtc(path);
        DateTime mtimeUtc = File.GetLastWriteTimeUtc(path);
        byte[] bytes = File.ReadAllBytes(path);
        File.SetLastAccessTimeUtc(path, atimeUtc);
        return new ProjectFileState(
            bytes,
            mode,
            new DateTimeOffset(atimeUtc).ToUnixTimeMilliseconds(),
            new DateTimeOffset(mtimeUtc).ToUnixTimeMilliseconds()
        );
    }

    private static ProjectDirectoryState SnapshotProjectDirectoryMetadata(string path)
    {
        int mode = (int)File.GetUnixFileMode(path) & 0x0fff;
        double atimeMs = new DateTimeOffset(Directory.GetLastAccessTimeUtc(path)).ToUnixTimeMilliseconds();
        double mtimeMs = new DateTimeOffset(Directory.GetLastWriteTimeUtc(path)).ToUnixTimeMilliseconds();
        return new ProjectDirectoryState(mode, atimeMs, mtimeMs);
    }

    private static List<CSharpProjectFileChange> DiffProjectWorkspace(
        ProjectWorkspaceSnapshot beforeSnapshot,
        bool traceKernelFileSystem
    )
    {
        if (traceKernelFileSystem)
        {
            return new List<CSharpProjectFileChange>();
        }
        ProjectWorkspaceSnapshot afterSnapshot = SnapshotProjectWorkspace();
        List<CSharpProjectFileChange> changes = new();

        foreach ((string path, ProjectFileState afterFile) in afterSnapshot.Files.OrderBy(entry => entry.Key, StringComparer.Ordinal))
        {
            if (beforeSnapshot.Files.TryGetValue(path, out ProjectFileState? beforeFile)
                && beforeFile.Mode == afterFile.Mode
                && beforeFile.AtimeMs == afterFile.AtimeMs
                && beforeFile.MtimeMs == afterFile.MtimeMs
                && beforeFile.Bytes.SequenceEqual(afterFile.Bytes))
            {
                continue;
            }
            changes.Add(afterFile.ToChange(path));
        }

        foreach ((string path, ProjectDirectoryState metadata) in afterSnapshot.Directories.OrderBy(entry => entry.Key, StringComparer.Ordinal))
        {
            if (beforeSnapshot.Directories.TryGetValue(path, out ProjectDirectoryState? beforeMetadata)
                && beforeMetadata == metadata)
            {
                continue;
            }
            changes.Add(metadata.ToChange(path));
        }

        foreach (string deletedPath in beforeSnapshot.Files.Keys
            .Except(afterSnapshot.Files.Keys, StringComparer.Ordinal)
            .Except(afterSnapshot.Directories.Keys, StringComparer.Ordinal)
            .OrderBy(path => path, StringComparer.Ordinal))
        {
            changes.Add(new CSharpProjectFileChange { Path = deletedPath, Deleted = true });
        }

        foreach (string deletedPath in beforeSnapshot.Directories.Keys
            .Except(afterSnapshot.Directories.Keys, StringComparer.Ordinal)
            .Except(afterSnapshot.Files.Keys, StringComparer.Ordinal)
            .OrderBy(path => path, StringComparer.Ordinal))
        {
            changes.Add(new CSharpProjectFileChange { Path = deletedPath, Directory = true, Deleted = true });
        }

        return changes;
    }

    private static void EmitProjectFileChanges(
        IEnumerable<CSharpProjectFileChange> changes,
        string phase,
        bool liveBudgetReserved = false)
    {
        foreach (CSharpProjectFileChange change in changes)
        {
            if (!liveBudgetReserved && !ShouldEmitProjectFileChange(change, phase))
            {
                continue;
            }
            EmitProjectEvent(new
            {
                type = "file-change",
                phase,
                change,
            });
        }
    }

    private static void ResetProjectLiveEventBudgets()
    {
        projectLiveFileChangeCount = 0;
        projectLiveFileChangeBytes = 0;
        projectLiveFileChangeBudgetWarningEmitted = false;
    }

    private static bool ShouldEmitProjectFileChange(CSharpProjectFileChange change, string phase)
    {
        if (!string.Equals(phase, "live", StringComparison.Ordinal))
        {
            return true;
        }

        return TryReserveLiveProjectFileChangeBudget(ProjectFileChangeByteSize(change));
    }

    private static bool TryReserveLiveProjectFileChangeBudget(long size)
    {
        projectLiveFileChangeCount++;
        bool overBudget = projectLiveFileChangeCount > ProjectMaxLiveFileChanges
            || size > ProjectMaxLiveFileChangeBytes
            || projectLiveFileChangeBytes + size > ProjectMaxLiveFileChangeBytes;
        if (overBudget)
        {
            EmitProjectLiveBudgetWarning();
            return false;
        }

        projectLiveFileChangeBytes += size;
        return true;
    }

    private static long ProjectFileChangeByteSize(CSharpProjectFileChange change)
    {
        long size = Encoding.UTF8.GetByteCount(change.Path ?? string.Empty);
        if (change.Contents is not null)
        {
            size += string.Equals(change.Encoding, "base64", StringComparison.OrdinalIgnoreCase)
                ? (long)Math.Ceiling(change.Contents.Length * 3d / 4d)
                : Encoding.UTF8.GetByteCount(change.Contents);
        }
        return size;
    }

    private static bool TryReserveLiveFileSnapshotBudget(string relativePath, string absolutePath)
    {
        try
        {
            long size = new FileInfo(absolutePath).Length + Encoding.UTF8.GetByteCount(relativePath);
            return TryReserveLiveProjectFileChangeBudget(size);
        }
        catch
        {
            EmitProjectLiveBudgetWarning();
            return false;
        }
    }

    private static void EmitProjectLiveBudgetWarning()
    {
        if (projectLiveFileChangeBudgetWarningEmitted)
        {
            return;
        }
        projectLiveFileChangeBudgetWarningEmitted = true;
        EmitProjectOutput("stderr", "EMSGSIZE: TraceKernel live file-change budget exceeded\n");
    }

    public static void EmitLiveProjectFileSnapshot(string path)
    {
        string? relativePath = ProjectRelativePathForRuntimePath(path);
        if (relativePath is null)
        {
            return;
        }

        try
        {
            string absolutePath = Path.GetFullPath(path);
            if (!File.Exists(absolutePath))
            {
                return;
            }
            if (!TryReserveLiveFileSnapshotBudget(relativePath, absolutePath))
            {
                return;
            }
            EmitProjectFileChanges(
                new[] { EncodeProjectFileChange(relativePath, File.ReadAllBytes(absolutePath)) },
                "live",
                liveBudgetReserved: true);
        }
        catch
        {
            // Live project events are best-effort and must not change user code behavior.
        }
    }

    public static void EmitLiveProjectPathSnapshot(string path)
    {
        string? relativePath = ProjectRelativePathForRuntimePath(path);
        if (relativePath is null)
        {
            return;
        }

        try
        {
            string absolutePath = Path.GetFullPath(path);
            if (File.Exists(absolutePath))
            {
                if (!TryReserveLiveFileSnapshotBudget(relativePath, absolutePath))
                {
                    return;
                }
                EmitProjectFileChanges(
                    new[] { EncodeProjectFileChange(relativePath, File.ReadAllBytes(absolutePath)) },
                    "live",
                    liveBudgetReserved: true);
                return;
            }
            if (!Directory.Exists(absolutePath))
            {
                return;
            }

            EmitProjectFileChanges(new[] { EncodeProjectDirectoryChange(relativePath) }, "live");
            foreach (string directoryPath in Directory.EnumerateDirectories(absolutePath, "*", SearchOption.AllDirectories))
            {
                string? nestedRelativePath = ProjectRelativePathForRuntimePath(directoryPath);
                if (nestedRelativePath is not null)
                {
                    EmitProjectFileChanges(new[] { EncodeProjectDirectoryChange(nestedRelativePath) }, "live");
                }
            }
            foreach (string filePath in Directory.EnumerateFiles(absolutePath, "*", SearchOption.AllDirectories))
            {
                string? nestedRelativePath = ProjectRelativePathForRuntimePath(filePath);
                if (nestedRelativePath is not null)
                {
                    if (!TryReserveLiveFileSnapshotBudget(nestedRelativePath, filePath))
                    {
                        continue;
                    }
                    EmitProjectFileChanges(
                        new[] { EncodeProjectFileChange(nestedRelativePath, File.ReadAllBytes(filePath)) },
                        "live",
                        liveBudgetReserved: true);
                }
            }
        }
        catch
        {
            // Live project events are best-effort and must not change user code behavior.
        }
    }

    public static string[] MissingProjectDirectories(string path)
    {
        try
        {
            string absolutePath = Path.GetFullPath(path);
            if (!absolutePath.StartsWith(ProjectWorkspaceRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal)
                && !string.Equals(absolutePath, ProjectWorkspaceRoot, StringComparison.Ordinal))
            {
                return Array.Empty<string>();
            }

            List<string> candidates = new();
            string? current = absolutePath;
            while (!string.IsNullOrEmpty(current) && !string.Equals(current, ProjectWorkspaceRoot, StringComparison.Ordinal))
            {
                candidates.Add(current);
                current = Path.GetDirectoryName(current);
            }
            candidates.Reverse();

            List<string> missing = new();
            foreach (string candidate in candidates)
            {
                if (!Directory.Exists(candidate))
                {
                    missing.Add(candidate);
                }
            }
            return missing.ToArray();
        }
        catch
        {
            return Array.Empty<string>();
        }
    }

    public static void EmitLiveProjectDirectorySnapshot(string path)
    {
        string? relativePath = ProjectRelativePathForRuntimePath(path);
        if (relativePath is null)
        {
            return;
        }

        EmitProjectFileChanges(new[] { EncodeProjectDirectoryChange(relativePath) }, "live");
    }

    public static void EmitLiveProjectDirectoryDelete(string path)
    {
        string? relativePath = ProjectRelativePathForRuntimePath(path);
        if (relativePath is null)
        {
            return;
        }

        EmitProjectFileChanges(new[] { EncodeProjectDirectoryChange(relativePath, deleted: true) }, "live");
    }

    public static void EmitLiveProjectFileDelete(string path)
    {
        string? relativePath = ProjectRelativePathForRuntimePath(path);
        if (relativePath is null)
        {
            return;
        }

        EmitProjectFileChanges(new[] { new CSharpProjectFileChange { Path = relativePath, Deleted = true } }, "live");
    }

    public static void ThrowIfProjectKernelVirtualMutation(string path, string operation)
    {
        string normalized = path.Replace('\\', '/').TrimEnd('/');
        if (string.IsNullOrEmpty(normalized))
        {
            return;
        }
        if (string.Equals(normalized, "/dev", StringComparison.Ordinal)
            || normalized.StartsWith("/dev/", StringComparison.Ordinal)
            || string.Equals(normalized, "/proc", StringComparison.Ordinal)
            || normalized.StartsWith("/proc/", StringComparison.Ordinal))
        {
            throw new IOException($"Kernel virtual filesystem is read-only: {operation} '{path}'");
        }
    }

    private static CSharpProjectFileChange EncodeProjectDirectoryChange(string path, bool deleted = false)
    {
        CSharpProjectFileChange change = new()
        {
            Path = path,
            Directory = true,
            Deleted = deleted,
        };
        if (!deleted)
        {
            string absolutePath = ResolveProjectPath(path);
            if (Directory.Exists(absolutePath))
            {
                ProjectDirectoryState metadata = SnapshotProjectDirectoryMetadata(absolutePath);
                change.Mode = metadata.Mode;
                change.AtimeMs = metadata.AtimeMs;
                change.MtimeMs = metadata.MtimeMs;
            }
        }
        return change;
    }

    private static string? ProjectRelativePathForRuntimePath(string path)
    {
        try
        {
            string absolutePath = Path.GetFullPath(path);
            if (!absolutePath.StartsWith(ProjectWorkspaceRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal)
                && !string.Equals(absolutePath, ProjectWorkspaceRoot, StringComparison.Ordinal))
            {
                return null;
            }
            string relativePath = Path.GetRelativePath(ProjectWorkspaceRoot, absolutePath).Replace('\\', '/');
            return string.IsNullOrEmpty(relativePath) || string.Equals(relativePath, ".", StringComparison.Ordinal)
                ? null
                : relativePath;
        }
        catch
        {
            return null;
        }
    }

    private static void EmitProjectOutput(string stream, string data)
    {
        if (string.IsNullOrEmpty(data))
        {
            return;
        }

        EmitProjectEvent(new
        {
            type = "output",
            stream,
            device = string.Equals(stream, "stderr", StringComparison.Ordinal) ? "/dev/stderr" : "/dev/stdout",
            data,
        });
    }

    private static string TruncateUtf8(string value, int maxBytes)
    {
        if (maxBytes <= 0)
        {
            return string.Empty;
        }

        int used = 0;
        StringBuilder output = new();
        foreach (char ch in value)
        {
            string next = ch.ToString();
            int nextBytes = Encoding.UTF8.GetByteCount(next);
            if (used + nextBytes > maxBytes)
            {
                break;
            }
            used += nextBytes;
            output.Append(ch);
        }
        return output.ToString();
    }

    private static void EmitProjectEvent(object payload)
    {
        try
        {
            EmitProjectEventJson(JsonSerializer.Serialize(payload, JsonOptions));
        }
        catch
        {
            // Project events are best-effort and must not change user code behavior.
        }
    }

    private sealed class StreamingProjectTextWriter : TextWriter
    {
        private readonly string stream;
        private readonly StringBuilder buffer = new();
        private int bytesWritten;
        private bool truncated;

        public StreamingProjectTextWriter(string stream)
        {
            this.stream = stream;
        }

        public override Encoding Encoding => Encoding.UTF8;

        public override void Write(char value)
        {
            Write(value.ToString());
        }

        public override void Write(string? value)
        {
            if (value is null)
            {
                return;
            }

            string budgetedValue = BudgetText(value);
            if (budgetedValue.Length == 0)
            {
                return;
            }

            buffer.Append(budgetedValue);
            EmitProjectOutput(stream, budgetedValue);
        }

        public override void Write(char[] buffer, int index, int count)
        {
            string value = new(buffer, index, count);
            Write(value);
        }

        public override string ToString()
        {
            return buffer.ToString();
        }

        private string BudgetText(string value)
        {
            if (truncated)
            {
                return string.Empty;
            }

            int bytes = Encoding.UTF8.GetByteCount(value);
            int remaining = ProjectMaxOutputStreamBytes - bytesWritten;
            if (bytes <= remaining)
            {
                bytesWritten += bytes;
                return value;
            }

            truncated = true;
            string marker = $"\n[tracekernel: {stream} output truncated after {ProjectMaxOutputStreamBytes} bytes]\n";
            string output = TruncateUtf8(value, Math.Max(0, remaining)) + marker;
            bytesWritten = ProjectMaxOutputStreamBytes + Encoding.UTF8.GetByteCount(marker);
            return output;
        }
    }

    private static CSharpProjectFileChange EncodeProjectFileChange(
        string path,
        byte[] bytes,
        int? mode = null,
        double? atimeMs = null,
        double? mtimeMs = null
    )
    {
        string text = Encoding.UTF8.GetString(bytes);
        if (Encoding.UTF8.GetBytes(text).SequenceEqual(bytes))
        {
            return new CSharpProjectFileChange
            {
                Path = path,
                Contents = text,
                Encoding = "utf8",
                Mode = mode,
                AtimeMs = atimeMs,
                MtimeMs = mtimeMs,
            };
        }

        return new CSharpProjectFileChange
        {
            Path = path,
            Contents = Convert.ToBase64String(bytes),
            Encoding = "base64",
            Mode = mode,
            AtimeMs = atimeMs,
            MtimeMs = mtimeMs,
        };
    }

    private static byte[] DecodeProjectFileBytes(CSharpProjectFile file)
    {
        return string.Equals(file.Encoding, "base64", StringComparison.OrdinalIgnoreCase)
            ? Convert.FromBase64String(file.Contents)
            : Encoding.UTF8.GetBytes(file.Contents);
    }

    private static string DecodeProjectFileContents(CSharpProjectFile file)
    {
        return Encoding.UTF8.GetString(DecodeProjectFileBytes(file));
    }

    private static string NormalizeProjectPath(string path)
    {
        string normalized = path.Replace('\\', '/');
        if (normalized.StartsWith("/workspace/", StringComparison.Ordinal))
        {
            normalized = normalized["/workspace/".Length..];
        }
        else if (normalized.StartsWith("/", StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Project path escapes workspace: {path}");
        }
        normalized = normalized.TrimStart('/');
        string collapsed = Path.GetFullPath(Path.Combine(ProjectWorkspaceRoot, normalized));
        if (!collapsed.StartsWith(ProjectWorkspaceRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            && !string.Equals(collapsed, ProjectWorkspaceRoot, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Project path escapes workspace: {path}");
        }
        return Path.GetRelativePath(ProjectWorkspaceRoot, collapsed).Replace('\\', '/');
    }

    private static string ResolveProjectPath(string path)
    {
        string normalized = path.Replace('\\', '/');
        if (string.Equals(normalized, "/workspace", StringComparison.Ordinal) || string.Equals(normalized, "<project>", StringComparison.Ordinal))
        {
            normalized = string.Empty;
        }
        else if (normalized.StartsWith("/workspace/", StringComparison.Ordinal))
        {
            normalized = normalized["/workspace/".Length..];
        }
        else if (normalized.StartsWith("/", StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Project path escapes workspace: {path}");
        }
        normalized = normalized.TrimStart('/');
        string resolved = Path.GetFullPath(Path.Combine(ProjectWorkspaceRoot, normalized));
        if (!resolved.StartsWith(ProjectWorkspaceRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            && !string.Equals(resolved, ProjectWorkspaceRoot, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Project path escapes workspace: {path}");
        }
        return resolved;
    }

    private static string FormatProjectDiagnostics(IEnumerable<Diagnostic> diagnostics)
    {
        StringBuilder builder = new();
        foreach (Diagnostic diagnostic in diagnostics.Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error))
        {
            CSharpDiagnostic mapped = CSharpDiagnostic.FromRoslyn(diagnostic);
            builder.Append(mapped.File);
            builder.Append('(');
            builder.Append(mapped.Line);
            builder.Append(',');
            builder.Append(mapped.Column);
            builder.Append("): error ");
            builder.Append(mapped.Id);
            builder.Append(": ");
            builder.AppendLine(mapped.Message);
        }
        return builder.ToString();
    }

    private static string FormatProjectUnhandledException(Exception error)
    {
        Exception exception = error.GetBaseException();
        string typeName = exception.GetType().FullName ?? exception.GetType().Name;
        string message = SanitizeProjectErrorText(exception.Message);
        if (string.IsNullOrWhiteSpace(message))
        {
            return $"Unhandled exception. {typeName}\n";
        }
        return $"Unhandled exception. {typeName}: {message.TrimEnd()}\n";
    }

    private static string SanitizeProjectErrorText(string? text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return string.Empty;
        }
        return text
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n')
            .Replace(ProjectWorkspaceRoot, "/workspace", StringComparison.Ordinal);
    }

    private static void InvokeProjectEntryPoint(Assembly assembly, string[] args)
    {
        MethodInfo entryPoint = assembly.EntryPoint
            ?? throw new InvalidOperationException("Program does not contain a static entry point.");
        object? result = entryPoint.GetParameters().Length == 0
            ? entryPoint.Invoke(null, null)
            : entryPoint.Invoke(null, new object?[] { args });
        if (result is Task task)
        {
            task.GetAwaiter().GetResult();
        }
    }

    private static bool IsScriptExecutionRequest(CSharpExecuteRequest request)
    {
        return string.Equals(request.ExecutionStyle, "function", StringComparison.Ordinal)
            && string.IsNullOrWhiteSpace(request.FunctionName);
    }

    private static void ValidateExecutionInputs(IReadOnlyDictionary<string, JsonElement> inputs)
    {
        InputTraversalBudget budget = new();
        int inputIndex = 0;
        foreach (KeyValuePair<string, JsonElement> input in inputs)
        {
            budget.RecordObjectProperty(inputIndex++, "C# inputs");
            ValidateInputElement(input.Value, budget, 0);
        }
    }

    private static void ValidateInputElement(JsonElement value, InputTraversalBudget budget, int depth)
    {
        budget.EnterNode(depth);
        switch (value.ValueKind)
        {
            case JsonValueKind.Array:
            {
                int itemIndex = 0;
                foreach (JsonElement item in value.EnumerateArray())
                {
                    budget.RecordCollectionItem(itemIndex++, "C# input array");
                    ValidateInputElement(item, budget, depth + 1);
                }
                break;
            }
            case JsonValueKind.Object:
            {
                int propertyIndex = 0;
                foreach (JsonProperty property in value.EnumerateObject())
                {
                    budget.RecordObjectProperty(propertyIndex++, "C# input object");
                    ValidateInputElement(property.Value, budget, depth + 1);
                }
                break;
            }
        }
    }

    private sealed class InputTraversalBudget
    {
        private int nodes;

        public void EnterNode(int depth)
        {
            if (depth > MaxInputDepth)
            {
                throw new InvalidOperationException($"C# input exceeds maximum depth of {MaxInputDepth}.");
            }

            nodes++;
            if (nodes > MaxInputTraversalNodes)
            {
                throw new InvalidOperationException($"C# input exceeds maximum JSON value count of {MaxInputTraversalNodes}.");
            }
        }

        public void RecordCollectionItem(int index, string label)
        {
            if (index >= MaxInputCollectionItems)
            {
                throw new InvalidOperationException($"{label} exceeds maximum item count of {MaxInputCollectionItems}.");
            }
        }

        public void RecordObjectProperty(int index, string label)
        {
            if (index >= MaxInputObjectProperties)
            {
                throw new InvalidOperationException($"{label} exceeds maximum property count of {MaxInputObjectProperties}.");
            }
        }
    }

    private static SyntaxTree CreateScriptUserTree(SyntaxTree originalUserTree)
    {
        return CSharpSyntaxTree.ParseText(
            GenerateScriptUserSource(originalUserTree),
            CompilerAuthorityState.ParseOptions,
            path: UserCodePath
        );
    }

    private static string GenerateScriptUserSource(SyntaxTree originalUserTree)
    {
        CompilationUnitSyntax root = originalUserTree.GetCompilationUnitRoot();
        List<GlobalStatementSyntax> globalStatements = root.Members.OfType<GlobalStatementSyntax>().ToList();
        if (globalStatements.Count == 0)
        {
            throw new InvalidOperationException("C# script style requires top-level statements and a result variable.");
        }

        SourceText sourceText = originalUserTree.GetText();
        string inputsParameterName = UniqueGeneratedIdentifier(
            root,
            "__tracecodeInputsJson"
        );
        var inputRewriter = new ScriptInputInvocationRewriter(
            inputsParameterName
        );
        var builder = new StringBuilder();
        AppendSourcePrelude(builder, sourceText, root);

        foreach (MemberDeclarationSyntax member in root.Members.Where(member => member is not GlobalStatementSyntax))
        {
            AppendMappedSource(builder, sourceText, member.FullSpan);
        }

        AppendLineIfNeeded(builder);
        builder.AppendLine($"internal static class {ScriptRunnerClassName}");
        builder.AppendLine("{");
        builder.AppendLine(
            $"    public static object? Run(string {inputsParameterName})"
        );
        builder.AppendLine("    {");

        foreach (GlobalStatementSyntax statement in globalStatements)
        {
            GlobalStatementSyntax rewritten =
                (GlobalStatementSyntax?)inputRewriter.Visit(statement)
                ?? throw new InvalidOperationException(
                    "Unable to rewrite C# script input access."
                );
            AppendMappedText(
                builder,
                sourceText,
                statement.FullSpan,
                rewritten.ToFullString()
            );
        }

        int resultLine = sourceText.Lines.GetLineFromPosition(globalStatements[^1].Span.End).LineNumber + 1;
        builder.AppendLine($"#line {resultLine} \"{UserCodePath}\"");
        builder.AppendLine("        return result;");
        builder.AppendLine("    }");
        builder.AppendLine("}");

        return builder.ToString();
    }

    private static string UniqueGeneratedIdentifier(
        SyntaxNode root,
        string candidate
    )
    {
        HashSet<string> identifiers = root
            .DescendantTokens()
            .Where(token => token.IsKind(SyntaxKind.IdentifierToken))
            .Select(token => token.ValueText)
            .ToHashSet(StringComparer.Ordinal);
        while (identifiers.Contains(candidate))
        {
            candidate += "_";
        }
        return candidate;
    }

    private sealed class ScriptInputInvocationRewriter : CSharpSyntaxRewriter
    {
        private readonly string inputsParameterName;

        public ScriptInputInvocationRewriter(string inputsParameterName)
        {
            this.inputsParameterName = inputsParameterName;
        }

        public override SyntaxNode? VisitInvocationExpression(
            InvocationExpressionSyntax node
        )
        {
            InvocationExpressionSyntax visited =
                (InvocationExpressionSyntax?)base.VisitInvocationExpression(node)
                ?? node;
            if (
                visited.ArgumentList.Arguments.Count != 2
                || visited.Expression is not MemberAccessExpressionSyntax member
                || !string.Equals(
                    NormalizeCSharpSymbolText(member.Expression.ToString()),
                    "TraceCode.Internal.TraceCodeJsonInput",
                    StringComparison.Ordinal
                )
                || member.Name.Identifier.ValueText is not ("Read" or "Has")
            )
            {
                return visited;
            }

            return visited.WithArgumentList(
                visited.ArgumentList.WithArguments(
                    visited.ArgumentList.Arguments.Insert(
                        0,
                        SyntaxFactory.Argument(
                            SyntaxFactory.IdentifierName(inputsParameterName)
                        )
                    )
                )
            );
        }
    }

    private static void AppendSourcePrelude(StringBuilder builder, SourceText sourceText, CompilationUnitSyntax root)
    {
        if (root.Members.Count == 0)
        {
            builder.Append(sourceText.ToString());
            return;
        }

        int preludeEnd = root.Members.Min(member => member.FullSpan.Start);
        if (preludeEnd > 0)
        {
            builder.Append(sourceText.ToString(TextSpan.FromBounds(0, preludeEnd)));
        }
    }

    private static void AppendMappedSource(StringBuilder builder, SourceText sourceText, TextSpan span)
    {
        if (span.Length == 0)
        {
            return;
        }

        AppendMappedText(
            builder,
            sourceText,
            span,
            sourceText.ToString(span)
        );
    }

    private static void AppendMappedText(
        StringBuilder builder,
        SourceText sourceText,
        TextSpan span,
        string text
    )
    {
        AppendLineIfNeeded(builder);
        int line = sourceText.Lines.GetLineFromPosition(span.Start).LineNumber + 1;
        builder.AppendLine($"#line {line} \"{UserCodePath}\"");
        builder.Append(text);
        if (!EndsWithLineBreak(text))
        {
            builder.AppendLine();
        }
    }

    private static void AppendLineIfNeeded(StringBuilder builder)
    {
        if (builder.Length == 0 || builder[^1] is '\n' or '\r')
        {
            return;
        }

        builder.AppendLine();
    }

    private static bool EndsWithLineBreak(string text)
    {
        return text.EndsWith("\n", StringComparison.Ordinal)
            || text.EndsWith("\r", StringComparison.Ordinal);
    }

    private static string GeneratePreparedDriverSource(SyntaxTree userTree, CSharpExecuteRequest request)
    {
        if (IsScriptExecutionRequest(request)
            || string.Equals(request.ExecutionStyle, "ops-class", StringComparison.Ordinal))
        {
            // Both supported shapes are input-independent at compile time.
            // Script code can read TraceCodeJsonInput, and the ops-class driver
            // reads operations/arguments only when Run executes. Browser
            // lifecycle coverage executes each prepared shape with distinct
            // input payloads to guard this invariant.
            return GenerateDriverSource(userTree, request);
        }

        _ = FindSolutionMethod(
            userTree,
            request.FunctionName,
            new Dictionary<string, JsonElement>(StringComparer.Ordinal)
        );
        string functionNameLiteral = JsonSerializer.Serialize(request.FunctionName);

        return $$"""
using System;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;

public static class TraceCodeDriver
{
    public static object? Run(string inputsJson)
    {
        using JsonDocument inputs = JsonDocument.Parse(inputsJson);
        JsonElement rawInputs = inputs.RootElement;
        MethodInfo method = SelectSolutionMethod(rawInputs);
        ParameterInfo[] parameters = method.GetParameters();
        object?[] args = new object?[parameters.Length];

        for (int index = 0; index < parameters.Length; index++)
        {
            ParameterInfo parameter = parameters[index];
            Type targetType = ParameterType(parameter);
            if (parameter.IsOut)
            {
                args[index] = DefaultValue(targetType);
                continue;
            }

            if (TryGetInput(rawInputs, parameter.Name ?? string.Empty, index, out JsonElement input))
            {
                args[index] = TraceCode.Internal.TraceCodeJsonInput.Convert(input, targetType);
                continue;
            }

            if (parameter.HasDefaultValue)
            {
                args[index] = parameter.DefaultValue;
                continue;
            }

            throw new InvalidOperationException($"Missing input value for parameter \"{parameter.Name}\".");
        }

        object? instance = method.IsStatic ? null : Activator.CreateInstance(method.DeclaringType!);
        object? output = AwaitInvocation(method.Invoke(instance, args), method.ReturnType);
        if (IsVoidLike(method.ReturnType))
        {
            return ShouldReturnFirstVoidArgument(parameters) ? args[0] : null;
        }

        return output;
    }

    private static MethodInfo SelectSolutionMethod(JsonElement rawInputs)
    {
        MethodInfo[] methods = typeof(Solution)
            .GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance)
            .Where(method =>
                !method.ContainsGenericParameters
                && string.Equals(method.Name, {{functionNameLiteral}}, StringComparison.Ordinal))
            .ToArray();
        if (methods.Length == 0)
        {
            methods = typeof(Solution)
                .GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance)
                .Where(method =>
                    !method.ContainsGenericParameters
                    && string.Equals(method.Name, {{functionNameLiteral}}, StringComparison.OrdinalIgnoreCase))
                .ToArray();
        }
        if (methods.Length == 0)
        {
            throw new InvalidOperationException($"Expected public method Solution.{{request.FunctionName}}.");
        }

        MethodInfo? compatible = methods
            .Select(method => new { Method = method, Score = ScoreMethod(method, rawInputs) })
            .Where(candidate => candidate.Score > int.MinValue)
            .OrderByDescending(candidate => candidate.Method.IsPublic)
            .ThenByDescending(candidate => candidate.Score)
            .Select(candidate => candidate.Method)
            .FirstOrDefault();
        return compatible ?? methods.FirstOrDefault(method => method.IsPublic) ?? methods[0];
    }

    private static int ScoreMethod(MethodInfo method, JsonElement rawInputs)
    {
        int score = 0;
        ParameterInfo[] parameters = method.GetParameters();
        for (int index = 0; index < parameters.Length; index++)
        {
            ParameterInfo parameter = parameters[index];
            if (parameter.IsOut)
            {
                score += 1;
                continue;
            }

            if (!TryGetInput(rawInputs, parameter.Name ?? string.Empty, index, out JsonElement input))
            {
                if (parameter.HasDefaultValue)
                {
                    continue;
                }
                return int.MinValue;
            }

            try
            {
                _ = TraceCode.Internal.TraceCodeJsonInput.Convert(input, ParameterType(parameter));
                score += 4;
            }
            catch
            {
                return int.MinValue;
            }
        }

        return score;
    }

    private static bool TryGetInput(
        JsonElement rawInputs,
        string name,
        int index,
        out JsonElement input
    )
    {
        if (rawInputs.ValueKind == JsonValueKind.Object)
        {
            if (rawInputs.TryGetProperty(name, out input))
            {
                return true;
            }

            int propertyIndex = 0;
            foreach (JsonProperty property in rawInputs.EnumerateObject())
            {
                if (propertyIndex == index)
                {
                    input = property.Value;
                    return true;
                }
                propertyIndex++;
            }
        }

        input = default;
        return false;
    }

    private static Type ParameterType(ParameterInfo parameter)
    {
        Type type = parameter.ParameterType;
        return type.IsByRef ? type.GetElementType() ?? typeof(object) : type;
    }

    private static object? DefaultValue(Type type)
    {
        return type.IsValueType && Nullable.GetUnderlyingType(type) is null
            ? Activator.CreateInstance(type)
            : null;
    }

    private static bool ShouldReturnFirstVoidArgument(ParameterInfo[] parameters)
    {
        if (parameters.Length == 0)
        {
            return false;
        }

        Type type = ParameterType(parameters[0]);
        return parameters[0].ParameterType.IsByRef
            || type.IsArray
            || (!type.IsPrimitive
                && type != typeof(string)
                && type != typeof(decimal)
                && type != typeof(DateTime));
    }

    private static bool IsVoidLike(Type returnType)
    {
        if (returnType == typeof(void)
            || returnType == typeof(Task)
            || returnType == typeof(ValueTask))
        {
            return true;
        }

        return false;
    }

    private static object? AwaitInvocation(object? result, Type returnType)
    {
        if (result is Task task)
        {
            task.GetAwaiter().GetResult();
            return TaskResult(task);
        }

        if (result is ValueTask valueTask)
        {
            valueTask.GetAwaiter().GetResult();
            return null;
        }

        if (result is not null
            && returnType.IsGenericType
            && returnType.GetGenericTypeDefinition() == typeof(ValueTask<>))
        {
            MethodInfo asTask = returnType.GetMethod("AsTask", BindingFlags.Public | BindingFlags.Instance)
                ?? throw new InvalidOperationException("Unable to await ValueTask result.");
            Task taskResult = (Task)(asTask.Invoke(result, null)
                ?? throw new InvalidOperationException("ValueTask did not expose a Task."));
            taskResult.GetAwaiter().GetResult();
            return TaskResult(taskResult);
        }

        return result;
    }

    private static object? TaskResult(Task task)
    {
        Type taskType = task.GetType();
        return taskType.IsGenericType
            ? taskType.GetProperty("Result", BindingFlags.Instance | BindingFlags.Public)?.GetValue(task)
            : null;
    }
}
""";
    }

    private static string GenerateDriverSource(SyntaxTree userTree, CSharpExecuteRequest request)
    {
        if (IsScriptExecutionRequest(request))
        {
            return $$"""
using System;

public static class TraceCodeDriver
{
    public static object? Run(string inputsJson)
    {
        return {{ScriptRunnerClassName}}.Run(inputsJson);
    }
}
""";
        }

        if (string.Equals(request.ExecutionStyle, "ops-class", StringComparison.Ordinal))
        {
            ClassDeclarationSyntax targetClass = FindClass(userTree, request.FunctionName);
            string className = targetClass.Identifier.ValueText;
            return $$"""
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;

public static class TraceCodeDriver
{
    public static object? Run(string inputsJson)
    {
        string[] operations = TraceCode.Internal.TraceCodeJsonInput.Read<string[]>(inputsJson, "operations", 0) ?? Array.Empty<string>();
        JsonElement[][] arguments = TraceCode.Internal.TraceCodeJsonInput.Read<JsonElement[][]>(inputsJson, "arguments", 1) ?? Array.Empty<JsonElement[]>();
        if (operations.Length != arguments.Length)
        {
            throw new InvalidOperationException("operations and arguments must have the same length");
        }

        Type targetType = typeof({{className}});
        object? instance = null;
        List<object?> output = new List<object?>();

        for (int i = 0; i < operations.Length; i++)
        {
            string operation = operations[i];
            JsonElement[] rawArgs = i < arguments.Length ? arguments[i] : Array.Empty<JsonElement>();
            if (instance is null && (i == 0
                || string.Equals(operation, {{JsonSerializer.Serialize(className)}}, StringComparison.OrdinalIgnoreCase)
                || string.Equals(operation, "__init__", StringComparison.OrdinalIgnoreCase)))
            {
                ConstructorInfo constructor = SelectConstructor(targetType.GetConstructors(BindingFlags.Public | BindingFlags.Instance), rawArgs.Length);
                instance = constructor.Invoke(ConvertArgs(rawArgs, constructor.GetParameters()));
                output.Add(null);
                continue;
            }

            if (instance is null)
            {
                throw new InvalidOperationException("Ops-class operation invoked before constructor.");
            }

            MethodInfo method = SelectMethod(targetType, operation, rawArgs.Length);
            output.Add(method.Invoke(instance, ConvertArgs(rawArgs, method.GetParameters())));
        }

        return output;
    }

    private static ConstructorInfo SelectConstructor(ConstructorInfo[] constructors, int arity)
    {
        return constructors.FirstOrDefault(constructor => constructor.GetParameters().Length == arity)
            ?? throw new InvalidOperationException($"No constructor with {arity} arguments.");
    }

    private static MethodInfo SelectMethod(Type targetType, string name, int arity)
    {
        return targetType
            .GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(method => string.Equals(method.Name, name, StringComparison.OrdinalIgnoreCase) && method.GetParameters().Length == arity)
            ?? throw new InvalidOperationException($"No method {name} with {arity} arguments.");
    }

    private static object?[] ConvertArgs(JsonElement[] rawArgs, ParameterInfo[] parameters)
    {
        object?[] converted = new object?[parameters.Length];
        for (int i = 0; i < parameters.Length; i++)
        {
            converted[i] = TraceCode.Internal.TraceCodeJsonInput.Convert(rawArgs[i], parameters[i].ParameterType);
        }
        return converted;
    }
}
""";
        }

        MethodDeclarationSyntax method = FindSolutionMethod(userTree, request.FunctionName, request.Inputs);
        string methodName = method.Identifier.ValueText;
        ISet<string> nestedSolutionTypeNames = GetNestedSolutionTypeNames(method);
        bool returnsVoid = method.ReturnType is PredefinedTypeSyntax predefinedType
            && predefinedType.Keyword.IsKind(SyntaxKind.VoidKeyword);
        bool returnsTaskLike = TryGetTaskLikeReturn(method.ReturnType, out bool returnsTaskResult);
        var parameterReads = method.ParameterList.Parameters.Select((parameter, index) =>
        {
            string parameterName = parameter.Identifier.ValueText;
            string parameterType = GetDriverParameterType(parameter, nestedSolutionTypeNames);
            if (parameter.Modifiers.Any(modifier => modifier.IsKind(SyntaxKind.OutKeyword)))
            {
                return $"        {parameterType} {parameterName} = default!;";
            }

            if (parameter.Default is not null)
            {
                return $"        {parameterType} {parameterName} = TraceCode.Internal.TraceCodeJsonInput.Has(inputsJson, {JsonSerializer.Serialize(parameterName)}, {index}) ? TraceCode.Internal.TraceCodeJsonInput.Read<{parameterType}>(inputsJson, {JsonSerializer.Serialize(parameterName)}, {index})! : {parameter.Default.Value};";
            }

            return $"        {parameterType} {parameterName} = TraceCode.Internal.TraceCodeJsonInput.Read<{parameterType}>(inputsJson, {JsonSerializer.Serialize(parameterName)}, {index})!;";
        }).ToList();
        string readStatements = string.Join("\n", parameterReads);
        string arguments = string.Join(", ", method.ParameterList.Parameters.Select(DriverArgumentExpression));
        bool isStatic = method.Modifiers.Any(modifier => modifier.IsKind(SyntaxKind.StaticKeyword));
        string invocation = isStatic ? $"Solution.{methodName}({arguments})" : $"solution.{methodName}({arguments})";
        string solutionDeclaration = isStatic ? string.Empty : "        var solution = new Solution();\n";
        string? firstParameterName = method.ParameterList.Parameters.FirstOrDefault()?.Identifier.ValueText;
        bool returnsMutatedFirstParameter = returnsVoid
            && firstParameterName is not null
            && (method.ParameterList.Parameters.First().Modifiers.Any(modifier => modifier.IsKind(SyntaxKind.RefKeyword) || modifier.IsKind(SyntaxKind.OutKeyword))
                || MutatesParameter(method, firstParameterName));
        string driverBody = returnsTaskLike
            ? returnsTaskResult
                ? $"return await {invocation};"
                : $"await {invocation};\n        return null;"
            : returnsVoid
            ? returnsMutatedFirstParameter
                ? $"{invocation};\n        return {firstParameterName};"
                : $"{invocation};\n        return null;"
            : $"return {invocation};";
        string runSignature = returnsTaskLike
            ? "public static async System.Threading.Tasks.Task<object?> Run(string inputsJson)"
            : "public static object? Run(string inputsJson)";

        return $$"""
using System;

public static class TraceCodeDriver
{
    {{runSignature}}
    {
{{solutionDeclaration}}{{readStatements}}
        {{driverBody}}
    }
}
""";
    }

    private static string DriverArgumentExpression(ParameterSyntax parameter)
    {
        string name = parameter.Identifier.ValueText;
        if (parameter.Modifiers.Any(modifier => modifier.IsKind(SyntaxKind.RefKeyword)))
        {
            return "ref " + name;
        }
        if (parameter.Modifiers.Any(modifier => modifier.IsKind(SyntaxKind.OutKeyword)))
        {
            return "out " + name;
        }
        if (parameter.Modifiers.Any(modifier => modifier.IsKind(SyntaxKind.InKeyword)))
        {
            return "in " + name;
        }
        return name;
    }

    private static ISet<string> GetNestedSolutionTypeNames(MethodDeclarationSyntax method)
    {
        if (method.Parent is not ClassDeclarationSyntax solutionClass)
        {
            return new HashSet<string>(StringComparer.Ordinal);
        }

        return solutionClass.Members
            .OfType<BaseTypeDeclarationSyntax>()
            .Select(type => type.Identifier.ValueText)
            .ToHashSet(StringComparer.Ordinal);
    }

    private static string GetDriverParameterType(ParameterSyntax parameter, ISet<string> nestedSolutionTypeNames)
    {
        string parameterType = parameter.Type?.ToString() ?? "object";
        foreach (string nestedTypeName in nestedSolutionTypeNames)
        {
            parameterType = Regex.Replace(
                parameterType,
                $@"(?<![\w.]){Regex.Escape(nestedTypeName)}(?![\w])",
                $"Solution.{nestedTypeName}"
            );
        }

        return parameterType;
    }

    private static bool TryGetTaskLikeReturn(TypeSyntax returnType, out bool returnsResult)
    {
        string? typeName = null;
        int typeArgumentCount = 0;

        switch (returnType)
        {
            case IdentifierNameSyntax identifier:
                typeName = identifier.Identifier.ValueText;
                break;
            case GenericNameSyntax generic:
                typeName = generic.Identifier.ValueText;
                typeArgumentCount = generic.TypeArgumentList.Arguments.Count;
                break;
            case QualifiedNameSyntax { Right: IdentifierNameSyntax identifier }:
                typeName = identifier.Identifier.ValueText;
                break;
            case QualifiedNameSyntax { Right: GenericNameSyntax generic }:
                typeName = generic.Identifier.ValueText;
                typeArgumentCount = generic.TypeArgumentList.Arguments.Count;
                break;
            case AliasQualifiedNameSyntax { Name: IdentifierNameSyntax identifier }:
                typeName = identifier.Identifier.ValueText;
                break;
            case AliasQualifiedNameSyntax { Name: GenericNameSyntax generic }:
                typeName = generic.Identifier.ValueText;
                typeArgumentCount = generic.TypeArgumentList.Arguments.Count;
                break;
        }

        bool isTaskLike = typeName is "Task" or "ValueTask";
        returnsResult = isTaskLike && typeArgumentCount == 1;
        return isTaskLike;
    }

    private static bool MutatesParameter(MethodDeclarationSyntax method, string parameterName)
    {
        HashSet<string> aliases = method
            .DescendantNodes()
            .OfType<ForEachStatementSyntax>()
            .Where(statement => IsExpressionRootedAtParameter(statement.Expression, parameterName))
            .Select(statement => statement.Identifier.ValueText)
            .ToHashSet(StringComparer.Ordinal);
        aliases.Add(parameterName);

        bool hasElementAssignment = method
            .DescendantNodes()
            .OfType<AssignmentExpressionSyntax>()
            .Any(assignment => aliases.Any(alias => IsExpressionRootedAtParameter(assignment.Left, alias)));
        if (hasElementAssignment)
        {
            return true;
        }

        bool hasIncrementOrDecrement = method
            .DescendantNodes()
            .Any(node =>
                node is PrefixUnaryExpressionSyntax prefix && aliases.Any(alias => IsExpressionRootedAtParameter(prefix.Operand, alias))
                || node is PostfixUnaryExpressionSyntax postfix && aliases.Any(alias => IsExpressionRootedAtParameter(postfix.Operand, alias))
            );
        if (hasIncrementOrDecrement)
        {
            return true;
        }

        return method
            .DescendantNodes()
            .OfType<InvocationExpressionSyntax>()
            .Any(invocation =>
                invocation.Expression is MemberAccessExpressionSyntax memberAccess
                && aliases.Any(alias => IsExpressionRootedAtParameter(memberAccess.Expression, alias)));
    }

    private static bool IsExpressionRootedAtParameter(ExpressionSyntax expression, string parameterName)
    {
        ExpressionSyntax current = expression;
        while (true)
        {
            ExpressionSyntax next = current switch
            {
                ElementAccessExpressionSyntax elementAccess => elementAccess.Expression,
                MemberAccessExpressionSyntax memberAccess => memberAccess.Expression,
                ParenthesizedExpressionSyntax parenthesized => parenthesized.Expression,
                _ => current,
            };
            if (ReferenceEquals(next, current))
            {
                break;
            }
            current = next;
        }

        return current is IdentifierNameSyntax identifier
            && string.Equals(identifier.Identifier.ValueText, parameterName, StringComparison.Ordinal);
    }

    private static ClassDeclarationSyntax FindClass(SyntaxTree userTree, string className)
    {
        CompilationUnitSyntax root = userTree.GetCompilationUnitRoot();
        ClassDeclarationSyntax? candidate = root
            .DescendantNodes()
            .OfType<ClassDeclarationSyntax>()
            .FirstOrDefault(type => string.Equals(type.Identifier.ValueText, className, StringComparison.Ordinal))
            ?? root
                .DescendantNodes()
                .OfType<ClassDeclarationSyntax>()
                .FirstOrDefault(type => string.Equals(type.Identifier.ValueText, className, StringComparison.OrdinalIgnoreCase));

        return candidate ?? throw new InvalidOperationException($"Expected class {className}.");
    }

    private static MethodDeclarationSyntax FindSolutionMethod(
        SyntaxTree userTree,
        string functionName,
        IReadOnlyDictionary<string, JsonElement> inputs
    )
    {
        CompilationUnitSyntax root = userTree.GetCompilationUnitRoot();
        var solutionClasses = root
            .DescendantNodes()
            .OfType<ClassDeclarationSyntax>()
            .Where(type => type.Identifier.ValueText == "Solution");

        var candidates = solutionClasses
            .SelectMany(type => type.Members.OfType<MethodDeclarationSyntax>())
            .Where(method => string.Equals(method.Identifier.ValueText, functionName, StringComparison.Ordinal))
            .ToList();

        if (candidates.Count == 0)
        {
            candidates = solutionClasses
                .SelectMany(type => type.Members.OfType<MethodDeclarationSyntax>())
                .Where(method => string.Equals(method.Identifier.ValueText, functionName, StringComparison.OrdinalIgnoreCase))
                .ToList();
        }

        if (candidates.Count == 0)
        {
            throw new InvalidOperationException($"Expected public method Solution.{functionName}.");
        }

        MethodDeclarationSyntax? compatibleCandidate = candidates
            .OrderByDescending(method => method.Modifiers.Any(modifier => modifier.IsKind(SyntaxKind.PublicKeyword)))
            .ThenByDescending(method => ScoreInputCompatibility(method, inputs))
            .FirstOrDefault(method => ScoreInputCompatibility(method, inputs) > int.MinValue);
        if (compatibleCandidate is not null)
        {
            return compatibleCandidate;
        }

        MethodDeclarationSyntax? publicCandidate = candidates.FirstOrDefault(method =>
            method.Modifiers.Any(modifier => modifier.IsKind(SyntaxKind.PublicKeyword)));
        return publicCandidate ?? candidates[0];
    }

    private static int ScoreInputCompatibility(
        MethodDeclarationSyntax method,
        IReadOnlyDictionary<string, JsonElement> inputs
    )
    {
        int score = 0;
        string[] keys = inputs.Keys.ToArray();
        for (int index = 0; index < method.ParameterList.Parameters.Count; index++)
        {
            ParameterSyntax parameter = method.ParameterList.Parameters[index];
            if (parameter.Type is null)
            {
                continue;
            }

            JsonElement input = inputs.TryGetValue(parameter.Identifier.ValueText, out JsonElement named)
                ? named
                : index < keys.Length && inputs.TryGetValue(keys[index], out JsonElement positional)
                    ? positional
                    : default;
            int parameterScore = ScoreJsonCompatibility(input, parameter.Type.ToString());
            if (parameterScore == int.MinValue)
            {
                return int.MinValue;
            }

            score += parameterScore;
        }

        return score;
    }

    private static int ScoreJsonCompatibility(JsonElement value, string typeName)
    {
        string normalizedType = typeName.Replace(" ", string.Empty, StringComparison.Ordinal);
        if (normalizedType is "object" or "System.Object")
        {
            return 1;
        }

        if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return 0;
        }

        if (normalizedType.EndsWith("[]", StringComparison.Ordinal))
        {
            if (value.ValueKind != JsonValueKind.Array)
            {
                return int.MinValue;
            }

            string elementType = normalizedType[..^2];
            int score = 2;
            foreach (JsonElement item in value.EnumerateArray())
            {
                int itemScore = ScoreJsonCompatibility(item, elementType);
                if (itemScore == int.MinValue)
                {
                    return int.MinValue;
                }

                score += itemScore;
            }

            return score;
        }

        return value.ValueKind switch
        {
            JsonValueKind.String when normalizedType is "string" or "System.String" => 4,
            JsonValueKind.True or JsonValueKind.False when normalizedType is "bool" or "Boolean" or "System.Boolean" => 4,
            JsonValueKind.Number when normalizedType is "double" or "Double" or "System.Double"
                or "float" or "Single" or "System.Single"
                or "decimal" or "Decimal" or "System.Decimal" => 4,
            JsonValueKind.Number when normalizedType is "int" or "Int32" or "System.Int32"
                or "long" or "Int64" or "System.Int64" => 4,
            _ => int.MinValue,
        };
    }

    private static string GenerateGlobalUsingsSource()
    {
        return """
global using System;
global using System.Collections;
global using System.Collections.Generic;
global using System.IO;
global using System.Linq;
global using System.Numerics;
global using System.Text;
global using System.Text.RegularExpressions;
""";
    }

    private static string GenerateRuntimeSource(IReadOnlyDictionary<string, JsonElement> inputs, SyntaxTree userTree)
    {
        _ = inputs;
        return GenerateRuntimeSource(GenerateNodePreludeSource(userTree));
    }

    private static string GenerateRuntimeSource(string preludeSource)
    {
        return $$"""
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

{{preludeSource}}

namespace TraceCode.Internal
{
    public static class TraceCodeJsonInput
    {
        private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
        {
            PropertyNameCaseInsensitive = true,
            IncludeFields = true,
            NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
            MaxDepth = 256,
        };

        private const int MaxInputDepth = 128;
        private const int MaxInputCollectionItems = 200_000;
        private const int MaxInputObjectProperties = 50_000;
        private const int MaxInputHydrationNodes = 750_000;
        private const int MaxInputConstructorCandidates = 32;
        private const int MaxInputConstructorParameters = 32;
""" + GenerateRuntimeSourceTail();
    }

    private static string GenerateNodePreludeSource(SyntaxTree userTree)
    {
        CompilationUnitSyntax root = userTree.GetCompilationUnitRoot();
        var classNames = root.Members
            .OfType<ClassDeclarationSyntax>()
            .Select(type => type.Identifier.ValueText)
            .ToHashSet(StringComparer.Ordinal);
        StringBuilder builder = new();
        if (!classNames.Contains("ListNode"))
        {
            builder.AppendLine("""
public class ListNode
{
    public int val;
    public int value;
    public ListNode? next;

    public ListNode(int val = 0, ListNode? next = null)
    {
        this.val = val;
        this.value = val;
        this.next = next;
    }
}
""");
        }

        if (!classNames.Contains("TreeNode"))
        {
            builder.AppendLine("""
public class TreeNode
{
    public int val;
    public int value;
    public TreeNode? left;
    public TreeNode? right;

    public TreeNode(int val = 0, TreeNode? left = null, TreeNode? right = null)
    {
        this.val = val;
        this.value = val;
        this.left = left;
        this.right = right;
    }
}
""");
        }

        return builder.ToString();
    }

    private static string GenerateRuntimeSourceTail()
    {
        return """
        private static JsonElement ParseRoot(string inputsJson) =>
            JsonSerializer.Deserialize<JsonElement>(inputsJson, JsonOptions);

        public static T? Read<T>(string inputsJson, string name, int index)
        {
            JsonElement root = ParseRoot(inputsJson);
            if (root.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidOperationException("TraceCode C# inputs must be a JSON object.");
            }

            if (root.TryGetProperty(name, out JsonElement namedValue))
            {
                return ReadValue<T>(namedValue);
            }

            string[] keys = root
                .EnumerateObject()
                .Select(property => property.Name)
                .ToArray();
            if (index >= 0
                && index < keys.Length
                && root.TryGetProperty(keys[index], out JsonElement indexedValue))
            {
                return ReadValue<T>(indexedValue);
            }

            throw new InvalidOperationException($"Missing input value for parameter \"{name}\".");
        }

        public static bool Has(string inputsJson, string name, int index)
        {
            JsonElement root = ParseRoot(inputsJson);
            if (root.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidOperationException("TraceCode C# inputs must be a JSON object.");
            }

            if (root.TryGetProperty(name, out _))
            {
                return true;
            }

            string[] keys = root
                .EnumerateObject()
                .Select(property => property.Name)
                .ToArray();
            return index >= 0
                && index < keys.Length
                && root.TryGetProperty(keys[index], out _);
        }

        public static object? Convert(JsonElement value, Type targetType)
        {
            InputHydrationBudget budget = new();
            if (targetType == typeof(ListNode))
            {
                return ReadListNode(value, new Dictionary<string, ListNode>(StringComparer.Ordinal), budget, 0);
            }

            if (targetType == typeof(TreeNode))
            {
                return ReadTreeNode(value, new Dictionary<string, TreeNode>(StringComparer.Ordinal), budget, 0);
            }

            if (targetType == typeof(object[]))
            {
                return ReadObjectArray(value, budget, 0);
            }

            if (targetType == typeof(object[][]))
            {
                return ReadObjectMatrix(value, budget, 0);
            }

            if (targetType == typeof(object))
            {
                return ReadObjectValue(value, budget, 0);
            }

            if (TryReadObjectValueDictionary(value, targetType, budget, 0, out object? objectValueDictionary))
            {
                return objectValueDictionary;
            }

            RejectUnsafeFrameworkObjectInput(value, targetType);

            if (ShouldUseStructuredObjectReader(value, targetType))
            {
                return ReadStructuredValue(value, targetType, new Dictionary<string, object>(StringComparer.Ordinal), budget, 0);
            }

            return JsonSerializer.Deserialize(value.GetRawText(), targetType, JsonOptions);
        }

        private static T? ReadValue<T>(JsonElement value)
        {
            InputHydrationBudget budget = new();
            if (typeof(T) == typeof(ListNode))
            {
                return (T?)(object?)ReadListNode(value, new Dictionary<string, ListNode>(StringComparer.Ordinal), budget, 0);
            }

            if (typeof(T) == typeof(TreeNode))
            {
                return (T?)(object?)ReadTreeNode(value, new Dictionary<string, TreeNode>(StringComparer.Ordinal), budget, 0);
            }

            if (typeof(T) == typeof(object[]))
            {
                return (T?)(object?)ReadObjectArray(value, budget, 0);
            }

            if (typeof(T) == typeof(object[][]))
            {
                return (T?)(object?)ReadObjectMatrix(value, budget, 0);
            }

            if (typeof(T) == typeof(object))
            {
                return (T?)ReadObjectValue(value, budget, 0);
            }

            if (TryReadObjectValueDictionary(value, typeof(T), budget, 0, out object? objectValueDictionary))
            {
                return (T?)objectValueDictionary;
            }

            RejectUnsafeFrameworkObjectInput(value, typeof(T));

            if (ShouldUseStructuredObjectReader(value, typeof(T)))
            {
                return (T?)ReadStructuredValue(value, typeof(T), new Dictionary<string, object>(StringComparer.Ordinal), budget, 0);
            }

            return JsonSerializer.Deserialize<T>(value.GetRawText(), JsonOptions);
        }

        private static bool ShouldUseStructuredObjectReader(JsonElement value, Type targetType)
        {
            Type effectiveType = Nullable.GetUnderlyingType(targetType) ?? targetType;
            if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            {
                return false;
            }

            if (effectiveType == typeof(string)
                || effectiveType.IsPrimitive
                || effectiveType.IsEnum
                || effectiveType == typeof(decimal)
                || effectiveType == typeof(DateTime)
                || effectiveType == typeof(JsonElement)
                || IsSupportedDictionaryType(effectiveType))
            {
                return false;
            }

            return value.ValueKind == JsonValueKind.Object
                || value.ValueKind == JsonValueKind.Array && IsSupportedStructuredSequenceType(effectiveType);
        }

        private static void RejectUnsafeFrameworkObjectInput(JsonElement value, Type targetType)
        {
            Type effectiveType = Nullable.GetUnderlyingType(targetType) ?? targetType;
            if (value.ValueKind != JsonValueKind.Object
                || effectiveType == typeof(object)
                || effectiveType == typeof(JsonElement)
                || IsSupportedDictionaryType(effectiveType)
                || !IsFrameworkInputHydrationType(effectiveType))
            {
                return;
            }

            throw new InvalidOperationException($"C# input hydration does not support object-shaped JSON for framework type {effectiveType.FullName}.");
        }

        private static bool IsFrameworkInputHydrationType(Type targetType)
        {
            if (targetType.IsArray)
            {
                return false;
            }

            string? ns = targetType.Namespace;
            return ns is not null && ns.StartsWith("System", StringComparison.Ordinal);
        }

        private static bool IsSupportedStructuredSequenceType(Type targetType)
        {
            if (targetType.IsArray)
            {
                return true;
            }

            return targetType.IsGenericType
                && targetType.GetGenericTypeDefinition() == typeof(List<>);
        }

        private static object? ReadStructuredValue(JsonElement value, Type targetType, IDictionary<string, object> refs, InputHydrationBudget budget, int depth)
        {
            budget.EnterNode(depth);
            Type effectiveType = Nullable.GetUnderlyingType(targetType) ?? targetType;
            if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            {
                return null;
            }

            if (effectiveType == typeof(JsonElement))
            {
                return value;
            }

            if (effectiveType == typeof(string))
            {
                return value.GetString();
            }

            if (effectiveType == typeof(object))
            {
                return ReadObjectValue(value, budget, depth);
            }

            if (effectiveType.IsPrimitive || effectiveType.IsEnum || effectiveType == typeof(decimal))
            {
                return JsonSerializer.Deserialize(value.GetRawText(), effectiveType, JsonOptions);
            }

            if (IsSupportedDictionaryType(effectiveType))
            {
                if (TryReadObjectValueDictionary(value, effectiveType, budget, depth, out object? objectValueDictionary))
                {
                    return objectValueDictionary;
                }

                return JsonSerializer.Deserialize(value.GetRawText(), effectiveType, JsonOptions);
            }

            RejectUnsafeFrameworkObjectInput(value, effectiveType);

            if (effectiveType.IsArray)
            {
                Type elementType = effectiveType.GetElementType() ?? typeof(object);
                JsonElement[] values = ReadInputArrayItems(value, budget, "C# input array");
                Array array = Array.CreateInstance(elementType, values.Length);
                for (int i = 0; i < values.Length; i++)
                {
                    array.SetValue(ReadStructuredValue(values[i], elementType, refs, budget, depth + 1), i);
                }
                return array;
            }

            if (effectiveType.IsGenericType && effectiveType.GetGenericTypeDefinition() == typeof(List<>))
            {
                Type elementType = effectiveType.GetGenericArguments()[0];
                System.Collections.IList list = (System.Collections.IList)Activator.CreateInstance(effectiveType)!;
                foreach (JsonElement item in ReadInputArrayItems(value, budget, "C# input list"))
                {
                    list.Add(ReadStructuredValue(item, elementType, refs, budget, depth + 1));
                }
                return list;
            }

            if (value.ValueKind != JsonValueKind.Object)
            {
                return JsonSerializer.Deserialize(value.GetRawText(), effectiveType, JsonOptions);
            }

            if (TryReadStringProperty(value, "__ref__", out string? refId))
            {
                return refs.TryGetValue(refId, out object? referenced)
                    ? referenced
                    : throw new InvalidOperationException($"Unknown object reference \"{refId}\".");
            }

            GuardInputObjectPropertyCount(value, budget, "C# input object");
            object instance = CreateStructuredObject(value, effectiveType, refs, budget, depth);
            if (TryReadStringProperty(value, "__id__", out string? id))
            {
                refs[id] = instance;
            }

            foreach (FieldInfo field in effectiveType.GetFields(BindingFlags.Public | BindingFlags.Instance))
            {
                if (TryGetProperty(value, field.Name, out JsonElement property))
                {
                    field.SetValue(instance, ReadStructuredValue(property, field.FieldType, refs, budget, depth + 1));
                }
            }

            foreach (PropertyInfo property in effectiveType.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (!property.CanWrite
                    || property.GetIndexParameters().Length > 0
                    || !TryGetProperty(value, property.Name, out JsonElement propertyValue))
                {
                    continue;
                }

                property.SetValue(instance, ReadStructuredValue(propertyValue, property.PropertyType, refs, budget, depth + 1));
            }

            return instance;
        }

        private static bool IsSupportedDictionaryType(Type type)
        {
            return TryGetSupportedDictionaryTypes(type, out _, out _);
        }

        private static bool TryGetSupportedDictionaryTypes(Type type, out Type keyType, out Type valueType)
        {
            if (type.IsGenericType && IsDictionaryGenericType(type.GetGenericTypeDefinition()))
            {
                Type[] args = type.GetGenericArguments();
                keyType = args[0];
                valueType = args[1];
                return true;
            }

            Type? interfaceType = type
                .GetInterfaces()
                .FirstOrDefault(candidate => candidate.IsGenericType && IsDictionaryGenericType(candidate.GetGenericTypeDefinition()));
            if (interfaceType is not null)
            {
                Type[] args = interfaceType.GetGenericArguments();
                keyType = args[0];
                valueType = args[1];
                return true;
            }

            keyType = typeof(object);
            valueType = typeof(object);
            return false;
        }

        private static bool IsDictionaryGenericType(Type type)
        {
            return type == typeof(Dictionary<,>)
                || type == typeof(IDictionary<,>)
                || type == typeof(IReadOnlyDictionary<,>);
        }

        private static bool TryReadObjectValueDictionary(JsonElement value, Type targetType, InputHydrationBudget budget, int depth, out object? dictionary)
        {
            Type effectiveType = Nullable.GetUnderlyingType(targetType) ?? targetType;
            if (value.ValueKind != JsonValueKind.Object
                || !TryGetSupportedDictionaryTypes(effectiveType, out Type keyType, out Type valueType)
                || valueType != typeof(object))
            {
                dictionary = null;
                return false;
            }

            Type dictionaryType = effectiveType.IsInterface || effectiveType.IsAbstract
                ? typeof(Dictionary<,>).MakeGenericType(keyType, typeof(object))
                : effectiveType;
            Type mutableDictionaryType = typeof(IDictionary<,>).MakeGenericType(keyType, typeof(object));
            if (!mutableDictionaryType.IsAssignableFrom(dictionaryType))
            {
                dictionary = null;
                return false;
            }

            object result = Activator.CreateInstance(dictionaryType)!;
            System.Reflection.MethodInfo addMethod = mutableDictionaryType.GetMethod("Add", new[] { keyType, typeof(object) })
                ?? throw new InvalidOperationException("Unable to resolve dictionary Add method.");
            GuardInputObjectPropertyCount(value, budget, "C# input dictionary");
            foreach (JsonProperty property in value.EnumerateObject())
            {
                addMethod.Invoke(result, new[] { ReadDictionaryKey(property.Name, keyType), ReadObjectValue(property.Value, budget, depth + 1) });
            }

            dictionary = result;
            return true;
        }

        private static object ReadDictionaryKey(string key, Type keyType)
        {
            if (keyType == typeof(string) || keyType == typeof(object))
            {
                return key;
            }

            if (keyType.IsEnum)
            {
                return Enum.Parse(keyType, key, ignoreCase: true);
            }

            return System.Convert.ChangeType(key, keyType, System.Globalization.CultureInfo.InvariantCulture);
        }

        private static object CreateStructuredObject(JsonElement value, Type targetType, IDictionary<string, object> refs, InputHydrationBudget budget, int depth)
        {
            ConstructorInfo? parameterless = targetType.GetConstructor(Type.EmptyTypes);
            if (parameterless is not null)
            {
                return parameterless.Invoke(null);
            }

            int constructorIndex = 0;
            foreach (ConstructorInfo constructor in targetType
                .GetConstructors(BindingFlags.Public | BindingFlags.Instance)
                .OrderByDescending(candidate => candidate.GetParameters().Length))
            {
                budget.RecordConstructorCandidate(constructorIndex++, targetType.FullName ?? targetType.Name);
                ParameterInfo[] parameters = constructor.GetParameters();
                budget.RecordConstructorParameterCount(parameters.Length, targetType.FullName ?? targetType.Name);
                if (!parameters.All(IsSafeInputConstructorParameter))
                {
                    continue;
                }

                if (!parameters.All(parameter => TryGetProperty(value, parameter.Name ?? string.Empty, out _) || parameter.HasDefaultValue))
                {
                    continue;
                }

                object?[] args = parameters.Select(parameter =>
                    TryGetProperty(value, parameter.Name ?? string.Empty, out JsonElement property)
                        ? ReadStructuredValue(property, parameter.ParameterType, refs, budget, depth + 1)
                        : parameter.DefaultValue
                ).ToArray();
                return constructor.Invoke(args);
            }

            if (targetType.IsValueType)
            {
                return Activator.CreateInstance(targetType)!;
            }

            throw new InvalidOperationException($"Cannot hydrate input object of type {targetType.FullName}.");
        }

        private static bool IsSafeInputConstructorParameter(ParameterInfo parameter)
        {
            Type parameterType = parameter.ParameterType;
            return !parameter.IsOut
                && !parameterType.IsByRef
                && !parameterType.IsPointer
                && parameterType != typeof(IntPtr)
                && parameterType != typeof(UIntPtr)
                && !typeof(Delegate).IsAssignableFrom(parameterType);
        }

        private static object[][] ReadObjectMatrix(JsonElement value, InputHydrationBudget budget, int depth)
        {
            budget.EnterNode(depth);
            JsonElement[] rows = ReadInputArrayItems(value, budget, "C# input object matrix");
            object[][] matrix = new object[rows.Length][];
            for (int i = 0; i < rows.Length; i++)
            {
                matrix[i] = ReadObjectArray(rows[i], budget, depth + 1);
            }
            return matrix;
        }

        private static object[] ReadObjectArray(JsonElement value, InputHydrationBudget budget, int depth)
        {
            budget.EnterNode(depth);
            JsonElement[] values = ReadInputArrayItems(value, budget, "C# input array");
            object[] result = new object[values.Length];
            for (int i = 0; i < values.Length; i++)
            {
                result[i] = ReadObjectValue(values[i], budget, depth + 1);
            }
            return result;
        }

        private static object? ReadObjectValue(JsonElement value, InputHydrationBudget budget, int depth)
        {
            budget.EnterNode(depth);
            return value.ValueKind switch
            {
                JsonValueKind.String => value.GetString(),
                JsonValueKind.Number => ReadObjectNumber(value),
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                JsonValueKind.Null or JsonValueKind.Undefined => null,
                JsonValueKind.Array => ReadObjectArray(value, budget, depth),
                JsonValueKind.Object => ReadObjectDictionary(value, budget, depth),
                _ => null,
            };
        }

        private static Dictionary<string, object?> ReadObjectDictionary(JsonElement value, InputHydrationBudget budget, int depth)
        {
            GuardInputObjectPropertyCount(value, budget, "C# input object");
            Dictionary<string, object?> result = new(StringComparer.Ordinal);
            foreach (JsonProperty property in value.EnumerateObject())
            {
                result[property.Name] = ReadObjectValue(property.Value, budget, depth + 1);
            }
            return result;
        }

        private static object ReadObjectNumber(JsonElement value)
        {
            if (value.TryGetInt32(out int intValue))
            {
                return intValue;
            }

            if (value.TryGetInt64(out long longValue))
            {
                return longValue;
            }

            double doubleValue = value.GetDouble();
            if (double.IsFinite(doubleValue) && Math.Truncate(doubleValue) == doubleValue)
            {
                if (doubleValue >= int.MinValue && doubleValue <= int.MaxValue)
                {
                    return (int)doubleValue;
                }

                if (doubleValue >= long.MinValue && doubleValue <= long.MaxValue)
                {
                    return (long)doubleValue;
                }
            }

            return doubleValue;
        }

        private static ListNode? ReadListNode(JsonElement value, IDictionary<string, ListNode> refs, InputHydrationBudget budget, int depth)
        {
            budget.EnterNode(depth);
            if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            {
                return null;
            }

            if (value.ValueKind == JsonValueKind.Array)
            {
                ListNode? head = null;
                ListNode? cursor = null;
                foreach (JsonElement item in ReadInputArrayItems(value, budget, "C# ListNode input array"))
                {
                    budget.EnterNode(depth + 1);
                    if (item.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
                    {
                        continue;
                    }

                    ListNode node = new(item.GetInt32());
                    if (head is null)
                    {
                        head = node;
                    }
                    else
                    {
                        cursor!.next = node;
                    }

                    cursor = node;
                }

                return head;
            }

            if (value.ValueKind == JsonValueKind.Object)
            {
                GuardInputObjectPropertyCount(value, budget, "C# ListNode input object");
                if (TryReadStringProperty(value, "__ref__", out string? refId))
                {
                    return refs.TryGetValue(refId, out ListNode? referenced)
                        ? referenced
                        : throw new InvalidOperationException($"Unknown ListNode reference \"{refId}\".");
                }

                int nodeValue = ReadIntProperty(value, "val", "value");
                ListNode node = new(nodeValue);
                if (TryReadStringProperty(value, "__id__", out string? id))
                {
                    refs[id] = node;
                }

                if (TryGetProperty(value, "next", out JsonElement next))
                {
                    node.next = ReadListNode(next, refs, budget, depth + 1);
                }

                return node;
            }

            return new ListNode(value.GetInt32());
        }

        private static TreeNode? ReadTreeNode(JsonElement value, IDictionary<string, TreeNode> refs, InputHydrationBudget budget, int depth)
        {
            budget.EnterNode(depth);
            if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            {
                return null;
            }

            if (value.ValueKind == JsonValueKind.Array)
            {
                JsonElement[] values = ReadInputArrayItems(value, budget, "C# TreeNode input array");
                if (values.Length == 0 || values[0].ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
                {
                    return null;
                }

                TreeNode root = new(values[0].GetInt32());
                Queue<TreeNode> queue = new();
                queue.Enqueue(root);
                int cursor = 1;

                while (queue.Count > 0 && cursor < values.Length)
                {
                    TreeNode parent = queue.Dequeue();

                    if (cursor < values.Length && values[cursor].ValueKind is not JsonValueKind.Null and not JsonValueKind.Undefined)
                    {
                        parent.left = new TreeNode(values[cursor].GetInt32());
                        queue.Enqueue(parent.left);
                    }
                    cursor++;

                    if (cursor < values.Length && values[cursor].ValueKind is not JsonValueKind.Null and not JsonValueKind.Undefined)
                    {
                        parent.right = new TreeNode(values[cursor].GetInt32());
                        queue.Enqueue(parent.right);
                    }
                    cursor++;
                }

                return root;
            }

            if (value.ValueKind == JsonValueKind.Object)
            {
                GuardInputObjectPropertyCount(value, budget, "C# TreeNode input object");
                if (TryReadStringProperty(value, "__ref__", out string? refId))
                {
                    return refs.TryGetValue(refId, out TreeNode? referenced)
                        ? referenced
                        : throw new InvalidOperationException($"Unknown TreeNode reference \"{refId}\".");
                }

                TreeNode node = new(ReadIntProperty(value, "val", "value"));
                if (TryReadStringProperty(value, "__id__", out string? id))
                {
                    refs[id] = node;
                }

                if (TryGetProperty(value, "left", out JsonElement left))
                {
                    node.left = ReadTreeNode(left, refs, budget, depth + 1);
                }

                if (TryGetProperty(value, "right", out JsonElement right))
                {
                    node.right = ReadTreeNode(right, refs, budget, depth + 1);
                }

                return node;
            }

            return new TreeNode(value.GetInt32());
        }

        private static JsonElement[] ReadInputArrayItems(JsonElement value, InputHydrationBudget budget, string label)
        {
            List<JsonElement> items = new();
            int index = 0;
            foreach (JsonElement item in value.EnumerateArray())
            {
                budget.RecordCollectionItem(index++, label);
                items.Add(item);
            }
            return items.ToArray();
        }

        private static void GuardInputObjectPropertyCount(JsonElement value, InputHydrationBudget budget, string label)
        {
            int index = 0;
            foreach (JsonProperty _ in value.EnumerateObject())
            {
                budget.RecordObjectProperty(index++, label);
            }
        }

        private sealed class InputHydrationBudget
        {
            private int nodes;

            public void EnterNode(int depth)
            {
                if (depth > MaxInputDepth)
                {
                    throw new InvalidOperationException($"C# input exceeds maximum depth of {MaxInputDepth}.");
                }

                nodes++;
                if (nodes > MaxInputHydrationNodes)
                {
                    throw new InvalidOperationException($"C# input hydration exceeds maximum JSON value count of {MaxInputHydrationNodes}.");
                }
            }

            public void RecordCollectionItem(int index, string label)
            {
                if (index >= MaxInputCollectionItems)
                {
                    throw new InvalidOperationException($"{label} exceeds maximum item count of {MaxInputCollectionItems}.");
                }
            }

            public void RecordObjectProperty(int index, string label)
            {
                if (index >= MaxInputObjectProperties)
                {
                    throw new InvalidOperationException($"{label} exceeds maximum property count of {MaxInputObjectProperties}.");
                }
            }

            public void RecordConstructorCandidate(int index, string label)
            {
                if (index >= MaxInputConstructorCandidates)
                {
                    throw new InvalidOperationException($"{label} exceeds maximum constructor candidate count of {MaxInputConstructorCandidates}.");
                }
            }

            public void RecordConstructorParameterCount(int count, string label)
            {
                if (count > MaxInputConstructorParameters)
                {
                    throw new InvalidOperationException($"{label} constructor exceeds maximum parameter count of {MaxInputConstructorParameters}.");
                }
            }
        }

        private static bool TryGetProperty(JsonElement value, string name, out JsonElement property)
        {
            foreach (JsonProperty candidate in value.EnumerateObject())
            {
                if (string.Equals(candidate.Name, name, StringComparison.OrdinalIgnoreCase))
                {
                    property = candidate.Value;
                    return true;
                }
            }

            property = default;
            return false;
        }

        private static bool TryReadStringProperty(JsonElement value, string name, out string? text)
        {
            if (TryGetProperty(value, name, out JsonElement property)
                && property.ValueKind == JsonValueKind.String)
            {
                text = property.GetString();
                return !string.IsNullOrEmpty(text);
            }

            text = null;
            return false;
        }

        private static int ReadIntProperty(JsonElement value, string primaryName, string fallbackName)
        {
            if (TryGetProperty(value, primaryName, out JsonElement primary) && primary.ValueKind == JsonValueKind.Number)
            {
                return primary.GetInt32();
            }

            if (TryGetProperty(value, fallbackName, out JsonElement fallback) && fallback.ValueKind == JsonValueKind.Number)
            {
                return fallback.GetInt32();
            }

            return 0;
        }
    }

    public static class TraceCodeTrace
    {
        public static void Line(int line, string? function)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Line(line, function);
        }

        public static void Call(string function, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Call(function, line);
        }

        public static void Call(string function, int line, IReadOnlyList<object?> args)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Call(function, line, args);
        }

        public static void Call(string function, int line, IReadOnlyDictionary<string, object?> args)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Call(function, line, args);
        }

        public static void Return(string function, int line, object? value = null)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Return(function, line, value);
        }

        public static void Leave(string function)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Leave(function);
        }

        public static void Exception(int line, string? message)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Exception(line, message);
        }

        public static void Write(string variable, object? value, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Write(variable, value, line);
        }

        public static void Read(string variable, object? value, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Read(variable, value, line);
        }

        public static void Snapshot(string variable, object? value, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, value, line);
        }

        public static void SetCurrentLine(int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.SetCurrentLine(line);
        }

        public static void WithSourceLine(int line, Action action)
        {
            int previousLine = TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine;
            int previousScopedLine = TraceCode.CSharpHost.RuntimeTraceSink.CurrentScopedSourceLine;
            TraceCode.CSharpHost.RuntimeTraceSink.Line(line, TraceCode.CSharpHost.RuntimeTraceSink.CurrentFunction);
            TraceCode.CSharpHost.RuntimeTraceSink.SetCurrentLine(line);
            TraceCode.CSharpHost.RuntimeTraceSink.SetScopedSourceLine(line);
            try
            {
                action();
            }
            finally
            {
                TraceCode.CSharpHost.RuntimeTraceSink.SetScopedSourceLine(previousScopedLine);
                TraceCode.CSharpHost.RuntimeTraceSink.SetCurrentLine(previousLine);
            }
        }

        public static void CollectionMutationCall(int line, string variable, string method, IReadOnlyList<object?> args, Action action)
        {
            int startIndex = TraceCode.CSharpHost.RuntimeTraceSink.EventCount;
            WithSourceLine(line, action);
            if (!TraceCode.CSharpHost.RuntimeTraceSink.HasMutationSince(startIndex, variable, method, line))
            {
                TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, method, args, line);
            }
        }

        public static void CollectionMutationCall(int line, string variable, string method, IReadOnlyList<object?> args, Action action, object? collection)
        {
            int startIndex = TraceCode.CSharpHost.RuntimeTraceSink.EventCount;
            WithSourceLine(line, action);
            if (TraceCode.CSharpHost.RuntimeTraceSink.HasMutationSince(startIndex, variable, method, line))
            {
                return;
            }

            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, method, args, line);
            TraceCode.CSharpHost.RuntimeTraceSink.Write(variable, collection, line);
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedBulkWrite(variable, collection, line);
        }

        public static void FieldCollectionMutationCall(int line, string variable, string[] path, string method, IReadOnlyList<object?> args, Action action, object? collection)
        {
            int startIndex = TraceCode.CSharpHost.RuntimeTraceSink.EventCount;
            WithSourceLine(line, action);
            if (TraceCode.CSharpHost.RuntimeTraceSink.HasMutationSince(startIndex, variable, path, method, line))
            {
                return;
            }
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, path, method, args, line);
            TraceCode.CSharpHost.RuntimeTraceSink.FieldWrite(variable, path, collection, line);
            EmitFieldIndexedWrites(variable, path, collection, line);
        }

        private static void EmitFieldIndexedWrites(string variable, string[] path, object? collection, int line)
        {
            if (collection is string || collection is not System.Collections.IEnumerable enumerable)
            {
                return;
            }

            int index = 0;
            int limit = TraceCode.CSharpHost.RuntimeTraceSink.BulkIndexedWriteLimit(collection is System.Collections.ICollection collectionWithCount
                ? collectionWithCount.Count
                : int.MaxValue);
            foreach (object? item in enumerable)
            {
                if (index >= limit)
                {
                    break;
                }
                object?[] indexedPath = new object?[path.Length + 1];
                for (int pathIndex = 0; pathIndex < path.Length; pathIndex += 1)
                {
                    indexedPath[pathIndex] = path[pathIndex];
                }
                indexedPath[path.Length] = index;
                TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, indexedPath, item, line);
                index += 1;
            }
        }

        public static bool LoopCondition(int line, string? function, Func<bool> action)
        {
            return WithSourceLine(line, action);
        }

        public static bool LoopCondition(int line, string? function, Func<bool> action, Action snapshot)
        {
            bool result = WithSourceLine(line, action);
            snapshot();
            return result;
        }

        public static IEnumerable<T> EnumerableSource<T>(int line, string? function, Func<IEnumerable<T>> action)
        {
            return WithSourceLine(line, action);
        }

        public static IEnumerable<T> EnumerableSource<T>(int line, string? function, Func<IEnumerable<T>> action, Action snapshot)
        {
            IEnumerable<T> result = WithSourceLine(line, action);
            snapshot();
            return result;
        }

        public static T WithSourceLine<T>(int line, Func<T> action)
        {
            int previousLine = TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine;
            int previousScopedLine = TraceCode.CSharpHost.RuntimeTraceSink.CurrentScopedSourceLine;
            TraceCode.CSharpHost.RuntimeTraceSink.Line(line, TraceCode.CSharpHost.RuntimeTraceSink.CurrentFunction);
            TraceCode.CSharpHost.RuntimeTraceSink.SetCurrentLine(line);
            TraceCode.CSharpHost.RuntimeTraceSink.SetScopedSourceLine(line);
            try
            {
                return action();
            }
            finally
            {
                TraceCode.CSharpHost.RuntimeTraceSink.SetScopedSourceLine(previousScopedLine);
                TraceCode.CSharpHost.RuntimeTraceSink.SetCurrentLine(previousLine);
            }
        }

        public static void Mutate(string variable, string method, IReadOnlyList<object?> args)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, method, args);
        }

        public static void Mutate(string variable, string method, IReadOnlyList<object?> args, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, method, args, line);
        }

        public static void Mutate(string variable, object index, string method, IReadOnlyList<object?> args)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, new object?[] { index }, method, args);
        }

        public static void Mutate(string variable, object index, string method, IReadOnlyList<object?> args, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, new object?[] { index }, method, args, line);
        }

        public static void Mutate(string variable, object index, string method, IReadOnlyList<object?> args, int line, IReadOnlyList<string?>? indexSources)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, new object?[] { index }, method, args, line, indexSources);
        }

        public static void Mutate(string variable, string[] path, string method, IReadOnlyList<object?> args)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, path, method, args);
        }

        public static void Mutate(string variable, string[] path, string method, IReadOnlyList<object?> args, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, path, method, args, line);
        }

        public static void Mutate(string variable, object?[] path, string method, IReadOnlyList<object?> args)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, path, method, args);
        }

        public static void Mutate(string variable, object?[] path, string method, IReadOnlyList<object?> args, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, path, method, args, line);
        }

        public static void Mutate(string variable, object?[] path, string method, IReadOnlyList<object?> args, int line, IReadOnlyList<string?>? indexSources)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, path, method, args, line, indexSources);
        }

        public static void IndexedRead(string variable, object index, object? value, int line, IReadOnlyList<string?>? indexSources = null)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, index, value, line, null, indexSources);
        }

        public static T IndexedRead<T>(string variable, object?[] path, T value, int line, IReadOnlyList<string?>? indexSources = null)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, path, value, line, null, indexSources);
            return value;
        }

        public static bool ContainsRead(bool contains, string variable, object? key, int line, IReadOnlyList<string?>? indexSources = null)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, key!, contains, line, null, indexSources);
            return contains;
        }

        public static bool ContainsRead(bool contains, string variable, object?[] path, int line, IReadOnlyList<string?>? indexSources = null)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, path, contains, line, null, indexSources);
            return contains;
        }

        public static T ArrayRead<T>(T[] array, int index, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            T value = array[index];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, index, value, line, null, indexSources);
            return value;
        }

        public static T[] ArraySliceRead<T>(T[] array, Range range, object?[] path, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            T[] value = array[range];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, path, value, line, null, indexSources);
            return value;
        }

        public static T[] ArraySliceRead<T>(T[] array, Range range, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            T[] value = array[range];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, ArraySlicePath(array.Length, range), value, line, null, indexSources);
            return value;
        }

        private static object?[] ArraySlicePath(int length, Range range)
        {
            return new object?[] { range.Start.GetOffset(length), range.End.GetOffset(length) };
        }

        public static T ArrayRead<T>(IList<T> list, int index, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            T value = list[index];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, index, value, line, null, indexSources);
            return value;
        }

        public static TValue ArrayRead<TKey, TValue>(IDictionary<TKey, TValue> dictionary, TKey key, string variable, int line, IReadOnlyList<string?>? indexSources = null)
            where TKey : notnull
        {
            TValue value = dictionary[key];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, key, value, line, null, indexSources);
            return value;
        }

        public static TValue ArrayRead<TKey, TValue>(
            IDictionary<TKey, TValue[]> dictionary,
            TKey key,
            int index,
            string variable,
            int line,
            IReadOnlyList<string?>? indexSources = null
        ) where TKey : notnull
        {
            TValue value = dictionary[key][index];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { key, index }, value, line, null, indexSources);
            return value;
        }

        public static TValue ArrayRead<TKey, TValue>(
            IDictionary<TKey, List<TValue>> dictionary,
            TKey key,
            int index,
            string variable,
            int line,
            IReadOnlyList<string?>? indexSources = null
        ) where TKey : notnull
        {
            TValue value = dictionary[key][index];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { key, index }, value, line, null, indexSources);
            return value;
        }

        public static TValue ArrayRead<TKey, TValue>(
            IDictionary<TKey, TraceCodeList<TValue>> dictionary,
            TKey key,
            int index,
            string variable,
            int line,
            IReadOnlyList<string?>? indexSources = null
        ) where TKey : notnull
        {
            TValue value = dictionary[key][index];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { key, index }, value, line, null, indexSources);
            return value;
        }

        public static char ArrayRead<TKey>(IDictionary<TKey, string> dictionary, TKey key, int index, string variable, int line, IReadOnlyList<string?>? indexSources = null)
            where TKey : notnull
        {
            char value = dictionary[key][index];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { key, index }, value, line, null, indexSources);
            return value;
        }

        public static T ArrayRead<T>(T[][] array, int row, int column, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            T value = array[row][column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line, null, indexSources);
            return value;
        }

        public static T ArrayRead<T>(T[,] array, int row, int column, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            T value = array[row, column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line, null, indexSources);
            return value;
        }

        public static T ArrayRead<T>(T[,,] array, int first, int second, int third, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            T value = array[first, second, third];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { first, second, third }, value, line, null, indexSources);
            return value;
        }

        public static T ArrayRead<T>(TraceCodeList<T[]> list, int row, int column, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            T value = ((List<T[]>)list)[row][column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line, null, indexSources);
            return value;
        }

        public static T ArrayRead<T>(IList<T[]> list, int row, int column, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            T value = list[row][column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line, null, indexSources);
            return value;
        }

        public static T ArrayRead<T>(IList<T>[] array, int row, int column, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            T value = array[row][column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line, null, indexSources);
            return value;
        }

        public static T ArrayRead<T>(List<List<T>> list, int row, int column, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            T value = list[row][column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line, null, indexSources);
            return value;
        }

        public static T ArrayRead<T>(IList<IList<T>> list, int row, int column, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            T value = list[row][column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line, null, indexSources);
            return value;
        }

        public static TValue ArrayRead<TKey, TValue>(
            IList<Dictionary<TKey, TValue>> list,
            int row,
            TKey key,
            string variable,
            int line,
            IReadOnlyList<string?>? indexSources = null
        ) where TKey : notnull
        {
            TValue value = list[row][key];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, key }, value, line, null, indexSources);
            return value;
        }

        public static TValue ArrayRead<TKey, TValue>(
            IList<TraceCodeDictionary<TKey, TValue>> list,
            int row,
            TKey key,
            string variable,
            int line,
            IReadOnlyList<string?>? indexSources = null
        ) where TKey : notnull
        {
            TValue value = list[row][key];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, key }, value, line, null, indexSources);
            return value;
        }

        public static char ArrayRead(string text, int index, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            char value = text[index];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, index, value, line, null, indexSources);
            return value;
        }

        public static char ArrayRead(StringBuilder text, int index, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            char value = text[index];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, index, value, line, null, indexSources);
            return value;
        }

        public static char ArrayRead(IList<string> list, int row, int column, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            char value = list[row][column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line, null, indexSources);
            return value;
        }

        public static char ArrayRead(string[] array, int row, int column, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            char value = array[row][column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line, null, indexSources);
            return value;
        }

        public static TValue ArrayRead<TKey, TValue>(
            Dictionary<TKey, TValue>[] array,
            int row,
            TKey key,
            string variable,
            int line,
            IReadOnlyList<string?>? indexSources = null
        ) where TKey : notnull
        {
            TValue value = array[row][key];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, key }, value, line, null, indexSources);
            return value;
        }

        public static TValue ArrayRead<TKey, TValue>(
            TraceCodeDictionary<TKey, TValue>[] array,
            int row,
            TKey key,
            string variable,
            int line,
            IReadOnlyList<string?>? indexSources = null
        ) where TKey : notnull
        {
            TValue value = array[row][key];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, key }, value, line, null, indexSources);
            return value;
        }

        public static void ArrayWrite<T>(T[] array, int index, T value, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            array[index] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, index, value, line, indexSources);
        }

        public static void ArrayWrite(char[] array, int index, int value, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            char charValue = (char)value;
            array[index] = charValue;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, index, charValue, line, indexSources);
        }

        public static void ArrayWrite(StringBuilder text, int index, char value, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            text[index] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, index, value, line, indexSources);
        }

        public static void ArrayWrite(StringBuilder text, int index, int value, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            char charValue = (char)value;
            text[index] = charValue;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, index, charValue, line, indexSources);
        }

        public static void ArrayWrite<T>(IList<T> list, int index, T value, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            list[index] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, index, value, line, indexSources);
        }

        public static void ArrayWrite<TKey, TValue>(
            IDictionary<TKey, TValue> dictionary,
            TKey key,
            TValue value,
            string variable,
            int line,
            IReadOnlyList<string?>? indexSources = null
        ) where TKey : notnull
        {
            dictionary[key] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, key, value, line, indexSources);
        }

        public static void ArrayWrite<TKey, TValue>(
            IDictionary<TKey, TValue[]> dictionary,
            TKey key,
            int index,
            TValue value,
            string variable,
            int line,
            IReadOnlyList<string?>? indexSources = null
        ) where TKey : notnull
        {
            dictionary[key][index] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { key, index }, value, line, indexSources);
        }

        public static void ArrayWrite<TKey, TValue>(
            IDictionary<TKey, List<TValue>> dictionary,
            TKey key,
            int index,
            TValue value,
            string variable,
            int line,
            IReadOnlyList<string?>? indexSources = null
        ) where TKey : notnull
        {
            dictionary[key][index] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { key, index }, value, line, indexSources);
        }

        public static void ArrayWrite<TKey, TValue>(
            IDictionary<TKey, TraceCodeList<TValue>> dictionary,
            TKey key,
            int index,
            TValue value,
            string variable,
            int line,
            IReadOnlyList<string?>? indexSources = null
        ) where TKey : notnull
        {
            dictionary[key][index] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { key, index }, value, line, indexSources);
        }

        public static void ArrayWrite<T>(T[][] array, int row, int column, T value, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            array[row][column] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, column }, value, line, indexSources);
        }

        public static void ArrayWrite<T>(T[,] array, int row, int column, T value, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            array[row, column] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, column }, value, line, indexSources);
        }

        public static void ArrayWrite<T>(T[,,] array, int first, int second, int third, T value, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            array[first, second, third] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { first, second, third }, value, line, indexSources);
        }

        public static void ArrayWrite<T>(IList<T[]> list, int row, int column, T value, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            list[row][column] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, column }, value, line, indexSources);
        }

        public static void ArrayWrite<T>(IList<T>[] array, int row, int column, T value, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            array[row][column] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, column }, value, line, indexSources);
        }

        public static void ArrayWrite<T>(List<List<T>> list, int row, int column, T value, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            list[row][column] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, column }, value, line, indexSources);
        }

        public static void ArrayWrite<T>(IList<IList<T>> list, int row, int column, T value, string variable, int line, IReadOnlyList<string?>? indexSources = null)
        {
            list[row][column] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, column }, value, line, indexSources);
        }

        public static void ArrayWrite<TKey, TValue>(
            IList<Dictionary<TKey, TValue>> list,
            int row,
            TKey key,
            TValue value,
            string variable,
            int line,
            IReadOnlyList<string?>? indexSources = null
        ) where TKey : notnull
        {
            list[row][key] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, key }, value, line, indexSources);
        }

        public static void ArrayWrite<TKey, TValue>(
            IList<TraceCodeDictionary<TKey, TValue>> list,
            int row,
            TKey key,
            TValue value,
            string variable,
            int line,
            IReadOnlyList<string?>? indexSources = null
        ) where TKey : notnull
        {
            list[row][key] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, key }, value, line, indexSources);
        }

        public static void ArrayWrite<TKey, TValue>(
            Dictionary<TKey, TValue>[] array,
            int row,
            TKey key,
            TValue value,
            string variable,
            int line,
            IReadOnlyList<string?>? indexSources = null
        ) where TKey : notnull
        {
            array[row][key] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, key }, value, line, indexSources);
        }

        public static void ArrayWrite<TKey, TValue>(
            TraceCodeDictionary<TKey, TValue>[] array,
            int row,
            TKey key,
            TValue value,
            string variable,
            int line,
            IReadOnlyList<string?>? indexSources = null
        ) where TKey : notnull
        {
            array[row][key] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, key }, value, line, indexSources);
        }

        public static T FieldRead<T>(T value, string variable, string field, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.FieldRead(variable, field, value, line);
            return value;
        }

        public static T FieldRead<T>(T value, string variable, string[] path, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.FieldRead(variable, path, value, line);
            return value;
        }

        public static T FieldRead<T>(T value, string variable, object?[] path, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.FieldRead(variable, path, value, line);
            return value;
        }

        public static T FieldRead<T>(T value, string variable, object?[] path, int line, IReadOnlyList<string?>? indexSources)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.FieldRead(variable, path, value, line, indexSources);
            return value;
        }

        public static T FieldWrite<T>(T value, string variable, string field, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.FieldWrite(variable, field, value, line);
            return value;
        }

        public static T FieldWrite<T>(T value, string variable, string[] path, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.FieldWrite(variable, path, value, line);
            return value;
        }

        public static T FieldWrite<T>(T value, string variable, object?[] path, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.FieldWrite(variable, path, value, line);
            return value;
        }

        public static T FieldWrite<T>(T value, string variable, object?[] path, int line, IReadOnlyList<string?>? indexSources)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.FieldWrite(variable, path, value, line, indexSources);
            return value;
        }

        public static void CheckTimeout()
        {
            TraceCode.CSharpHost.RuntimeTraceSink.CheckTimeout();
        }

        public static void WithVariableAlias(string actualVariable, string sourceVariable, Action action)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.WithVariableAlias(actualVariable, sourceVariable, action);
        }

        public static T WithVariableAlias<T>(string actualVariable, string sourceVariable, Func<T> action)
        {
            return TraceCode.CSharpHost.RuntimeTraceSink.WithVariableAlias(actualVariable, sourceVariable, action);
        }

        public static T WithIndexSources<T>(IReadOnlyList<string?>? indexSources, Func<T> action)
        {
            return TraceCode.CSharpHost.RuntimeTraceSink.WithIndexSources(indexSources, action);
        }

        public static void WithIndexSources(IReadOnlyList<string?>? indexSources, Action action)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.WithIndexSources(indexSources, action);
        }

        public static bool DictionaryTryGetValue<TKey, TValue>(
            TraceCodeDictionary<TKey, TValue> dictionary,
            TKey key,
            out TValue value,
            int line,
            IReadOnlyList<string?>? indexSources)
            where TKey : notnull
        {
            return dictionary.TryGetValue(key, out value, line, indexSources);
        }
    }

    public sealed class TraceCodeList<T> : List<T>
    {
        private readonly string variable;

        public TraceCodeList(string variable, int line)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeList(string variable, int line, int capacity)
            : base(capacity)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeList(string variable, int line, IEnumerable<T> collection)
            : base(collection)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new T this[int index]
        {
            get
            {
                T value = base[index];
                TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, index, value, TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine, null, TraceCode.CSharpHost.RuntimeTraceSink.CurrentScopedIndexSources);
                return value;
            }
            set
            {
                base[index] = value;
                TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, index, value, TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine, TraceCode.CSharpHost.RuntimeTraceSink.CurrentScopedIndexSources);
                TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            }
        }

        public new void Add(T item)
        {
            int index = Count;
            base.Add(item);
            int line = TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine;
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Add", new object?[] { item }, line);
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, index, item, line);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new void RemoveAt(int index)
        {
            base.RemoveAt(index);
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "RemoveAt", new object?[] { index }, TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new void Clear()
        {
            base.Clear();
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Clear", Array.Empty<object?>(), TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new void Sort()
        {
            base.Sort();
            EmitSortMutation(Array.Empty<object?>());
        }

        public new void Sort(Comparison<T> comparison)
        {
            base.Sort(comparison);
            EmitSortMutation(new object?[] { "<comparison>" });
        }

        public new void Sort(IComparer<T>? comparer)
        {
            base.Sort(comparer);
            EmitSortMutation(new object?[] { "<comparer>" });
        }

        public new void Sort(int index, int count, IComparer<T>? comparer)
        {
            base.Sort(index, count, comparer);
            EmitSortMutation(new object?[] { index, count, "<comparer>" });
        }

        private void EmitSortMutation(IReadOnlyList<object?> args)
        {
            int line = TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine;
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Sort", args, line);
            int limit = TraceCode.CSharpHost.RuntimeTraceSink.BulkIndexedWriteLimit(Count);
            for (int index = 0; index < limit; index += 1)
            {
                TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, index, base[index], line);
            }
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }
    }

    public sealed class TraceCodeDictionary<TKey, TValue> : Dictionary<TKey, TValue>
        where TKey : notnull
    {
        private readonly string variable;

        public TraceCodeDictionary(string variable, int line)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeDictionary(string variable, int line, int capacity)
            : base(capacity)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeDictionary(string variable, int line, IEqualityComparer<TKey>? comparer)
            : base(comparer)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeDictionary(string variable, int line, int capacity, IEqualityComparer<TKey>? comparer)
            : base(capacity, comparer)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeDictionary(string variable, int line, IDictionary<TKey, TValue> dictionary)
            : base(dictionary)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeDictionary(string variable, int line, IDictionary<TKey, TValue> dictionary, IEqualityComparer<TKey>? comparer)
            : base(dictionary, comparer)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeDictionary(string variable, int line, IEnumerable<KeyValuePair<TKey, TValue>> collection)
            : base(collection)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeDictionary(
            string variable,
            int line,
            IEnumerable<KeyValuePair<TKey, TValue>> collection,
            IEqualityComparer<TKey>? comparer)
            : base(collection, comparer)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new TValue this[TKey key]
        {
            get
            {
                TValue value = base[key];
                TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, key, value, TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine, null, TraceCode.CSharpHost.RuntimeTraceSink.CurrentScopedIndexSources);
                return value;
            }
            set
            {
                base[key] = value;
                TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, key, value, TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine, TraceCode.CSharpHost.RuntimeTraceSink.CurrentScopedIndexSources);
                TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            }
        }

        public new void Add(TKey key, TValue value)
        {
            base.Add(key, value);
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Add", new object?[] { key, value }, TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new bool Remove(TKey key)
        {
            bool removed = base.Remove(key);
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(
                variable,
                new object?[] { key },
                "Remove",
                new object?[] { key },
                TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine,
                TraceCode.CSharpHost.RuntimeTraceSink.CurrentScopedIndexSources);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            return removed;
        }

        public new void Clear()
        {
            base.Clear();
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Clear", Array.Empty<object?>(), TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new bool ContainsKey(TKey key)
        {
            return base.ContainsKey(key);
        }

        public new bool TryGetValue(TKey key, out TValue value)
        {
            return TryGetValue(key, out value, TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine, TraceCode.CSharpHost.RuntimeTraceSink.CurrentScopedIndexSources);
        }

        public bool TryGetValue(TKey key, out TValue value, int line, IReadOnlyList<string?>? indexSources)
        {
            bool found = base.TryGetValue(key, out value!);
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, key, found ? value : default, line, null, indexSources);
            return found;
        }
    }

    public sealed class TraceCodeHashSet<T> : HashSet<T>
    {
        private readonly string variable;

        public TraceCodeHashSet(string variable, int line)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeHashSet(string variable, int line, int capacity)
            : base(capacity)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeHashSet(string variable, int line, IEqualityComparer<T>? comparer)
            : base(comparer)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeHashSet(string variable, int line, int capacity, IEqualityComparer<T>? comparer)
            : base(capacity, comparer)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeHashSet(string variable, int line, IEnumerable<T> collection)
            : base(collection)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeHashSet(string variable, int line, IEnumerable<T> collection, IEqualityComparer<T>? comparer)
            : base(collection, comparer)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new bool Add(T item)
        {
            bool added = base.Add(item);
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Add", new object?[] { item }, TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            return added;
        }

        public new bool Contains(T item)
        {
            bool contains = base.Contains(item);
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, item!, contains, TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine);
            return contains;
        }

        public new bool Remove(T item)
        {
            bool removed = base.Remove(item);
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(
                variable,
                new object?[] { item },
                "Remove",
                new object?[] { item },
                TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine,
                TraceCode.CSharpHost.RuntimeTraceSink.CurrentScopedIndexSources);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            return removed;
        }

        public new void Clear()
        {
            base.Clear();
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Clear", Array.Empty<object?>(), TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }
    }

    public sealed class TraceCodeQueue<T> : Queue<T>
    {
        private readonly string variable;

        public TraceCodeQueue(string variable, int line)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeQueue(string variable, int line, int capacity)
            : base(capacity)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeQueue(string variable, int line, IEnumerable<T> collection)
            : base(collection)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new void Enqueue(T item)
        {
            base.Enqueue(item);
            int line = TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine;
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Enqueue", new object?[] { item }, line);
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, Count - 1, item, line);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new T Dequeue()
        {
            T item = base.Dequeue();
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Dequeue", Array.Empty<object?>(), TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            return item;
        }

        public new T Peek()
        {
            T item = base.Peek();
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, 0, item, TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine);
            return item;
        }
    }

    public sealed class TraceCodePriorityQueue<TElement, TPriority> : PriorityQueue<TElement, TPriority>
    {
        private readonly string variable;

        public TraceCodePriorityQueue(string variable, int line)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodePriorityQueue(string variable, int line, IComparer<TPriority>? comparer)
            : base(comparer)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodePriorityQueue(string variable, int line, int initialCapacity)
            : base(initialCapacity)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodePriorityQueue(string variable, int line, int initialCapacity, IComparer<TPriority>? comparer)
            : base(initialCapacity, comparer)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodePriorityQueue(string variable, int line, IEnumerable<(TElement Element, TPriority Priority)> items)
            : base(items)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodePriorityQueue(
            string variable,
            int line,
            IEnumerable<(TElement Element, TPriority Priority)> items,
            IComparer<TPriority>? comparer)
            : base(items, comparer)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new void Enqueue(TElement element, TPriority priority)
        {
            base.Enqueue(element, priority);
            int line = TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine;
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Enqueue", new object?[] { element }, line);
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedPriorityQueueWrites(variable, this, line);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new TElement Dequeue()
        {
            TElement item = base.Dequeue();
            int line = TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine;
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Dequeue", Array.Empty<object?>(), line);
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedPriorityQueueWrites(variable, this, line);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            return item;
        }

        public new TElement Peek()
        {
            TElement item = base.Peek();
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, 0, item, TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine);
            return item;
        }
    }

    public sealed class TraceCodeLinkedList<T> : LinkedList<T>
    {
        private readonly string variable;

        public TraceCodeLinkedList(string variable, int line)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeLinkedList(string variable, int line, IEnumerable<T> collection)
            : base(collection)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new LinkedListNode<T> AddLast(T value)
        {
            LinkedListNode<T> node = base.AddLast(value);
            int line = TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine;
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "append", new object?[] { value }, line);
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, Count - 1, value, line);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            return node;
        }

        public new LinkedListNode<T> AddFirst(T value)
        {
            LinkedListNode<T> node = base.AddFirst(value);
            int line = TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine;
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "appendleft", new object?[] { value }, line);
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, 0, value, line);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            return node;
        }

        public new void RemoveFirst()
        {
            base.RemoveFirst();
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "popleft", Array.Empty<object?>(), TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new void RemoveLast()
        {
            base.RemoveLast();
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "pop", Array.Empty<object?>(), TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }
    }

    public sealed class TraceCodeStack<T> : Stack<T>
    {
        private readonly string variable;

        public TraceCodeStack(string variable, int line)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeStack(string variable, int line, int capacity)
            : base(capacity)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public TraceCodeStack(string variable, int line, IEnumerable<T> collection)
            : base(collection)
        {
            this.variable = variable;
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new void Push(T item)
        {
            base.Push(item);
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Push", new object?[] { item }, TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new T Pop()
        {
            T item = base.Pop();
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Pop", Array.Empty<object?>(), TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            return item;
        }

        public new T Peek()
        {
            T item = base.Peek();
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, 0, item, TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine);
            return item;
        }
    }
}
""";
    }

    private static IEnumerable<MetadataReference> ResolveReferences()
    {
        var referencePaths = new HashSet<string>(StringComparer.Ordinal);
        AddVfsReferences(referencePaths);

        string? trustedPlatformAssemblies = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (!string.IsNullOrWhiteSpace(trustedPlatformAssemblies))
        {
            foreach (string path in trustedPlatformAssemblies
                .Split(Path.PathSeparator)
                .Where(path => !string.IsNullOrWhiteSpace(path)))
            {
                if (IsAllowedUserMetadataReference(path))
                {
                    referencePaths.Add(path);
                }
            }
        }

        foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (!string.IsNullOrWhiteSpace(assembly.Location))
            {
                if (IsAllowedUserMetadataReference(assembly.Location))
                {
                    referencePaths.Add(assembly.Location);
                }
            }
        }

        if (referencePaths.Count == 0)
        {
            Type[] fallbackTypes =
            {
                typeof(object),
                typeof(Console),
                typeof(Dictionary<,>),
                typeof(Enumerable),
                typeof(JsonSerializer),
            };

            foreach (string path in fallbackTypes
                .Select(type => type.Assembly.Location)
                .Where(path => !string.IsNullOrWhiteSpace(path)))
            {
                if (IsAllowedUserMetadataReference(path))
                {
                    referencePaths.Add(path);
                }
            }
        }

        return referencePaths.Select(path => MetadataReference.CreateFromFile(path));
    }

    private static bool IsAllowedUserMetadataReference(string path)
    {
        string fileName = Path.GetFileName(path);
        if (string.IsNullOrWhiteSpace(fileName))
        {
            return false;
        }

        string assemblyName = Path.GetFileNameWithoutExtension(fileName);
        return IsAllowedUserAssemblyName(assemblyName)
            && !string.Equals(fileName, "System.Runtime.InteropServices.JavaScript.dll", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsAllowedUserAssemblyName(string assemblyName)
    {
        return !string.Equals(assemblyName, "System.Net", StringComparison.OrdinalIgnoreCase)
            && !assemblyName.StartsWith("System.Net.", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(assemblyName, "System.Reflection.Emit", StringComparison.OrdinalIgnoreCase)
            && !assemblyName.StartsWith("System.Reflection.Emit.", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(assemblyName, "System.Runtime.InteropServices.JavaScript", StringComparison.OrdinalIgnoreCase);
    }

    private static void AddVfsReferences(ISet<string> referencePaths)
    {
        const string referenceDirectory = "/tracecode-refs";
        if (!Directory.Exists(referenceDirectory))
        {
            return;
        }

        foreach (string path in Directory.EnumerateFiles(referenceDirectory, "*.dll"))
        {
            if (IsAllowedUserMetadataReference(path))
            {
                referencePaths.Add(path);
            }
        }
    }

    private static object? InvokeDriver(Assembly userAssembly, string inputsJson)
    {
        Type driverType = userAssembly.GetType("TraceCodeDriver")
            ?? throw new InvalidOperationException("TraceCode generated driver was not found.");
        MethodInfo method = driverType.GetMethod("Run", BindingFlags.Static | BindingFlags.Public)
            ?? throw new InvalidOperationException("TraceCode generated driver did not expose Run().");
        object? result = method.Invoke(null, new object?[] { inputsJson });
        if (result is not Task task)
        {
            return result;
        }

        task.GetAwaiter().GetResult();
        Type taskType = result.GetType();
        if (!taskType.IsGenericType)
        {
            return null;
        }

        return taskType.GetProperty("Result", BindingFlags.Instance | BindingFlags.Public)?.GetValue(result);
    }

    private static object? NormalizeOutput(object? output)
    {
        if (output is null)
        {
            return null;
        }

        object? normalized = NormalizeOutputValue(
            output,
            0,
            new OutputReferenceTracker()
        );
        string json = JsonSerializer.Serialize(normalized, normalized?.GetType() ?? typeof(object), JsonOptions);
        return JsonSerializer.Deserialize<JsonElement>(json, JsonOptions);
    }

    private static object? NormalizeOutputValue(object? value, int depth, OutputReferenceTracker references)
    {
        RuntimeTraceSink.CheckTimeout();

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
            || value is decimal
            || value is char
            || value is JsonElement)
        {
            return value;
        }

        if (depth > 64)
        {
            return "<max depth>";
        }

        Type type = value.GetType();
        if (type.IsEnum)
        {
            return value.ToString();
        }

        if (type.Namespace?.StartsWith("System", StringComparison.Ordinal) == true
            && value is not System.Collections.IDictionary
            && value is not System.Collections.IEnumerable)
        {
            return value;
        }

        if (value is System.Collections.IDictionary dictionary)
        {
            if (references.TryCreateReference(value, type.Name, out Dictionary<string, object?> reference))
            {
                return reference;
            }
            references.Track(value, type.Name);

            var result = new Dictionary<string, object?>();
            foreach (System.Collections.DictionaryEntry entry in dictionary)
            {
                RuntimeTraceSink.CheckTimeout();
                result[NormalizeOutputKey(entry.Key)] = NormalizeOutputValue(entry.Value, depth + 1, references);
            }

            return result;
        }

        if (value is Array array)
        {
            if (references.TryCreateReference(value, type.Name, out Dictionary<string, object?> reference))
            {
                return reference;
            }
            references.Track(value, type.Name);

            return NormalizeOutputArray(array, 0, new int[array.Rank], depth, references);
        }

        if (value is System.Collections.IEnumerable enumerable)
        {
            if (references.TryCreateReference(value, type.Name, out Dictionary<string, object?> reference))
            {
                return reference;
            }
            references.Track(value, type.Name);

            var result = new List<object?>();
            foreach (object? item in enumerable)
            {
                RuntimeTraceSink.CheckTimeout();
                result.Add(NormalizeOutputValue(item, depth + 1, references));
            }

            return result;
        }

        return NormalizeOutputObject(value, type, depth, references);
    }

    private static string NormalizeOutputKey(object? key)
    {
        return key switch
        {
            null => "null",
            string text => text,
            bool flag => flag ? "true" : "false",
            IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
            _ => Convert.ToString(key, CultureInfo.InvariantCulture) ?? "null",
        };
    }

    private static object? NormalizeOutputArray(Array array, int dimension, int[] indices, int depth, OutputReferenceTracker references)
    {
        var values = new List<object?>();
        int lower = array.GetLowerBound(dimension);
        int upper = array.GetUpperBound(dimension);
        for (int index = lower; index <= upper; index++)
        {
            RuntimeTraceSink.CheckTimeout();
            indices[dimension] = index;
            values.Add(dimension == array.Rank - 1
                ? NormalizeOutputValue(array.GetValue(indices), depth + 1, references)
                : NormalizeOutputArray(array, dimension + 1, indices, depth + 1, references));
        }

        return values;
    }

    private static object? NormalizeOutputObject(object value, Type type, int depth, OutputReferenceTracker references)
    {
        if (references.TryCreateReference(value, type.Name, out Dictionary<string, object?> reference))
        {
            return reference;
        }

        var result = new Dictionary<string, object?>();
        references.Track(value, type.Name, result);
        AddOutputFieldMembers(result, value, type, depth, references);
        AddOutputPropertyMembers(result, value, type, depth, references);
        return result.Count > 0 ? result : value;
    }

    private static void AddOutputFieldMembers(
        IDictionary<string, object?> result,
        object value,
        Type type,
        int depth,
        OutputReferenceTracker references
    )
    {
        foreach (FieldInfo field in OrderOutputMembers(type.GetFields(BindingFlags.Public | BindingFlags.Instance)))
        {
            RuntimeTraceSink.CheckTimeout();
            result[field.Name] = NormalizeOutputValue(field.GetValue(value), depth + 1, references);
        }
    }

    private static void AddOutputPropertyMembers(
        IDictionary<string, object?> result,
        object value,
        Type type,
        int depth,
        OutputReferenceTracker references
    )
    {
        foreach (PropertyInfo property in OrderOutputMembers(type.GetProperties(BindingFlags.Public | BindingFlags.Instance)))
        {
            RuntimeTraceSink.CheckTimeout();
            if (result.ContainsKey(property.Name)
                || !property.CanRead
                || property.GetIndexParameters().Length > 0
                || property.PropertyType.IsByRef
                || property.PropertyType.IsByRefLike)
            {
                continue;
            }

            try
            {
                result[property.Name] = NormalizeOutputValue(property.GetValue(value), depth + 1, references);
            }
            catch (Exception error) when (error.GetBaseException() is TraceCodeTimeoutException or TraceLimitExceededException)
            {
                throw;
            }
            catch
            {
                // Keep output serialization best-effort for user-defined objects with throwing accessors.
            }
        }
    }

    private sealed class OutputReferenceTracker
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
        private int nextId;

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

            string id = entry.Id ??= $"{entry.TypeName}:{++nextId}";
            if (entry.Anchor is not null)
            {
                entry.Anchor["__id__"] = id;
            }

            reference = new Dictionary<string, object?> { ["__ref__"] = id };
            return true;
        }
    }

    private static IEnumerable<T> OrderOutputMembers<T>(IEnumerable<T> members)
        where T : MemberInfo
    {
        return members.OrderBy(member => member.Name == "__type__" ? 0 : 1);
    }

    private static string SerializeError(
        string error,
        Stopwatch stopwatch,
        StringWriter capturedOut,
        bool traceLimitExceeded = false,
        string? timeoutReason = null,
        IDictionary<string, object>? timings = null
    )
    {
        return Serialize(new CSharpExecuteResponse
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
    }

    private static Dictionary<string, object> WithTotalTiming(
        IDictionary<string, object>? timings,
        Stopwatch stopwatch
    )
    {
        Dictionary<string, object> result = timings is null
            ? new Dictionary<string, object>(StringComparer.Ordinal)
            : new Dictionary<string, object>(timings, StringComparer.Ordinal);
        result["totalMs"] = stopwatch.Elapsed.TotalMilliseconds;
        return result;
    }

    private static string Serialize(CSharpExecuteResponse response)
    {
        return JsonSerializer.Serialize(response, JsonOptions);
    }

    private static string SerializeProject(CSharpProjectCommandResponse response)
    {
        return JsonSerializer.Serialize(response, JsonOptions);
    }

    private static List<string> SplitConsoleOutput(StringWriter capturedOut)
    {
        return capturedOut
            .ToString()
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .ToList();
    }

    private static List<RuntimeTraceEvent> SnapshotTraceEvents(StringWriter capturedOut)
    {
        capturedOut.Flush();
        return RuntimeTraceSink.Snapshot();
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
            if (disposing)
            {
                EmitBufferedPartialLine();
            }

            base.Dispose(disposing);
        }

        public override void Write(char value)
        {
            base.Write(value);
            AppendForTrace(value);
        }

        public override void Write(string? value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return;
            }

            base.Write(value);
            AppendForTrace(value);
        }

        public override void Write(char[] buffer, int index, int count)
        {
            base.Write(buffer, index, count);
            AppendForTrace(buffer.AsSpan(index, count));
        }

        public override void WriteLine()
        {
            Write(NewLine);
        }

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
                return;
            }

            if (value != '\r')
            {
                lineBuffer.Append(value);
            }
        }

        private void AppendForTrace(string value)
        {
            foreach (char character in value)
            {
                AppendForTrace(character);
            }
        }

        private void AppendForTrace(ReadOnlySpan<char> value)
        {
            foreach (char character in value)
            {
                AppendForTrace(character);
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
            if (lineBuffer.Length > 0)
            {
                EmitBufferedLine();
            }
        }
    }
}

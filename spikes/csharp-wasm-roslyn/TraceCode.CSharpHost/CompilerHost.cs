using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.Loader;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
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
    private const int CompilationCacheLimit = 32;
    private const string UserCodePath = "solution.cs";
    private const string ProjectWorkspaceRoot = "/tmp/tracecode-csharp-project";
    private const string ScriptRunnerClassName = "__TraceCodeScriptRunner";
    private static readonly CSharpParseOptions ParseOptions = new(LanguageVersion.CSharp14);
    private static readonly Lazy<MetadataReference[]> CachedReferences = new(() => ResolveReferences().ToArray());
    private static readonly Dictionary<string, byte[]> CompilationCache = new(StringComparer.Ordinal);
    private static readonly Queue<string> CompilationCacheOrder = new();
    private static string currentInputsJson = "{}";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        IncludeFields = true,
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
        MaxDepth = 256,
    };

    [JSImport("emitProjectEvent", "tracecode")]
    internal static partial void EmitProjectEventJson(string payloadJson);

    [JSExport]
    [SupportedOSPlatform("browser")]
    public static string Execute(string requestJson)
    {
        Stopwatch stopwatch = Stopwatch.StartNew();
        TextWriter originalOut = Console.Out;
        using StringWriter capturedOut = new();
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

            string compileCacheKey = BuildCompilationCacheKey(request);
            if (!CompilationCache.TryGetValue(compileCacheKey, out byte[]? peBytes))
            {
                timings["compileCacheHit"] = false;
                double compileStartedAt = stopwatch.Elapsed.TotalMilliseconds;
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
                        Events = RuntimeTraceSink.Snapshot(),
                        ExecutionTimeMs = stopwatch.Elapsed.TotalMilliseconds,
                        Timings = WithTotalTiming(timings, stopwatch),
                    });
                }

                peBytes = peStream.ToArray();
                StoreCompilationCacheEntry(compileCacheKey, peBytes);
            }
            else
            {
                timings["compileCacheHit"] = true;
                timings["compileMs"] = 0d;
            }

            Assembly userAssembly = Assembly.Load(peBytes);
            currentInputsJson = JsonSerializer.Serialize(request.Inputs, JsonOptions);
            RuntimeTraceSink.Configure(
                request.TimeoutMs,
                request.Trace ? request.MaxTraceSteps : null,
                request.Trace ? request.MaxLineEvents : null,
                request.Trace ? request.MaxSingleLineHits : null,
                request.Trace ? request.MaxStoredEvents : null,
                request.Trace && request.MinimalTrace
            );
            double runStartedAt = stopwatch.Elapsed.TotalMilliseconds;
            object? output = InvokeDriver(userAssembly);
            timings["runMs"] = stopwatch.Elapsed.TotalMilliseconds - runStartedAt;
            return Serialize(new CSharpExecuteResponse
            {
                Success = true,
                Output = NormalizeOutput(output),
                ConsoleOutput = SplitConsoleOutput(capturedOut),
                Events = RuntimeTraceSink.Snapshot(),
                TraceLimitExceeded = RuntimeTraceSink.TraceLimitExceeded,
                TimeoutReason = RuntimeTraceSink.TraceLimitExceeded ? RuntimeTraceSink.TimeoutReason : null,
                ExecutionTimeMs = stopwatch.Elapsed.TotalMilliseconds,
                Timings = WithTotalTiming(timings, stopwatch),
            });
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
            Console.SetOut(originalOut);
        }
    }

    [JSExport]
    [SupportedOSPlatform("browser")]
    public static string ExecuteProject(string requestJson)
    {
        Stopwatch stopwatch = Stopwatch.StartNew();
        TextWriter originalOut = Console.Out;
        string originalDirectory = Directory.GetCurrentDirectory();
        var originalEnvironment = Environment.GetEnvironmentVariables();
        using StreamingProjectTextWriter capturedOut = new("stdout");
        Console.SetOut(capturedOut);

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

            PrepareProjectWorkspace(request, out Dictionary<string, byte[]> beforeSnapshot);
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
                    Stderr = FormatProjectDiagnostics(emitResult.Diagnostics),
                    ExitCode = 1,
                });
            }
            byte[] peBytes = peStream.ToArray();
            ProjectOutputInfo outputInfo = MaterializeProjectAssembly(request, peBytes);

            if (string.Equals(request.Source, "compile", StringComparison.Ordinal))
            {
                string buildOutput = FormatDotnetBuildOutput(request, outputInfo, emitResult.Diagnostics, stopwatch.Elapsed);
                List<CSharpProjectFileChange> files = DiffProjectWorkspace(beforeSnapshot);
                EmitProjectFileChanges(files, "final-diff");
                return SerializeProject(new CSharpProjectCommandResponse
                {
                    Stdout = capturedOut.ToString() + buildOutput,
                    Stderr = string.Empty,
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
            List<CSharpProjectFileChange> runFiles = DiffProjectWorkspace(beforeSnapshot);
            EmitProjectFileChanges(runFiles, "final-diff");
            return SerializeProject(new CSharpProjectCommandResponse
            {
                Stdout = capturedOut.ToString(),
                Stderr = string.Empty,
                ExitCode = 0,
                Files = runFiles,
            });
        }
        catch (Exception error)
        {
            return SerializeProject(new CSharpProjectCommandResponse
            {
                Stdout = capturedOut.ToString(),
                Stderr = error.GetBaseException().Message + "\n",
                ExitCode = 1,
            });
        }
        finally
        {
            Console.SetOut(originalOut);
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

        string targetFramework = ResolveProjectPropertyValue(request, "TargetFramework") ?? "net8.0";
        if (string.IsNullOrWhiteSpace(targetFramework))
        {
            targetFramework = "net8.0";
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

    private static CSharpCompilation CreateCompilation(CSharpExecuteRequest request)
    {
        SyntaxTree originalUserTree = CSharpSyntaxTree.ParseText(
            request.Source,
            ParseOptions,
            path: UserCodePath
        );
        SyntaxTree executableUserTree = IsScriptExecutionRequest(request)
            ? CreateScriptUserTree(originalUserTree)
            : originalUserTree;
        SyntaxTree userTree = TraceRewriter.Instrument(executableUserTree, request.Trace);
        SyntaxTree globalUsingsTree = CSharpSyntaxTree.ParseText(
            GenerateGlobalUsingsSource(),
            ParseOptions,
            path: "TraceCodeGlobalUsings.cs"
        );
        SyntaxTree runtimeTree = CSharpSyntaxTree.ParseText(
            GenerateRuntimeSource(request.Inputs, originalUserTree),
            ParseOptions,
            path: "TraceCodeRuntime.cs"
        );
        SyntaxTree driverTree = CSharpSyntaxTree.ParseText(
            GenerateDriverSource(originalUserTree, request),
            ParseOptions,
            path: "TraceCodeDriver.cs"
        );

        return CSharpCompilation.Create(
            assemblyName: "TraceCode.UserCode." + Guid.NewGuid().ToString("N"),
            syntaxTrees: new[] { globalUsingsTree, userTree, runtimeTree, driverTree },
            references: CachedReferences.Value,
            options: new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                optimizationLevel: OptimizationLevel.Release,
                concurrentBuild: false,
                allowUnsafe: false
            )
        );
    }

    private static CSharpCompilation CreateProjectCompilation(CSharpProjectCommandRequest request)
    {
        List<SyntaxTree> syntaxTrees = new()
        {
            CSharpSyntaxTree.ParseText(
                GenerateGlobalUsingsSource(),
                ParseOptions,
                path: "TraceCodeGlobalUsings.cs"
            ),
            CSharpSyntaxTree.ParseText(
                GenerateProjectRuntimeSource(request.Stdin ?? string.Empty),
                ParseOptions,
                path: "TraceCodeProjectRuntime.cs"
            ),
        };

        HashSet<string> compileFilePaths = ResolveProjectCompileFilePaths(request);
        CSharpParseOptions projectParseOptions = ParseOptions.WithPreprocessorSymbols(ResolveProjectDefineConstants(request));
        foreach (CSharpProjectFile file in request.Project.Files)
        {
            string path = NormalizeProjectPath(file.Path);
            if (!compileFilePaths.Contains(path))
            {
                continue;
            }
            SyntaxTree projectTree = CSharpSyntaxTree.ParseText(
                DecodeProjectFileContents(file),
                projectParseOptions,
                path: path
            );
            syntaxTrees.Add(RewriteProjectSyntaxTree(projectTree));
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

        return CSharpCompilation.Create(
            assemblyName: "TraceCode.Project." + Guid.NewGuid().ToString("N"),
            syntaxTrees: syntaxTrees,
            references: CachedReferences.Value.Concat(ResolveProjectMetadataReferences(request)),
            options: options
        );
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
            yield return MetadataReference.CreateFromImage(referenceAssembly.Bytes);
        }
    }

    private sealed record ProjectHintPathAssembly(string Name, byte[] Bytes);

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
                string name = Path.GetFileNameWithoutExtension(referencePath);
                try
                {
                    name = AssemblyName.GetAssemblyName(ResolveProjectPath(referencePath)).Name ?? name;
                }
                catch
                {
                }
                yield return new ProjectHintPathAssembly(name, referenceBytes);
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
        SyntaxNode rewrittenRoot = new ProjectConsoleRewriter().Visit(tree.GetRoot()) ?? tree.GetRoot();
        return CSharpSyntaxTree.Create(
            (CSharpSyntaxNode)rewrittenRoot,
            ParseOptions,
            path: tree.FilePath,
            encoding: Encoding.UTF8
        );
    }

    private sealed class ProjectConsoleRewriter : CSharpSyntaxRewriter
    {
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

            return base.VisitInvocationExpression(node);
        }
    }

    private static string GenerateProjectRuntimeSource(string stdin)
    {
        string serializedLines = JsonSerializer.Serialize(SplitProjectStdinLines(stdin), JsonOptions);
        return $$"""
namespace TraceCode.Project;

public static class ProjectStdin
{
    private static readonly string[] Lines = System.Text.Json.JsonSerializer.Deserialize<string[]>({{JsonSerializer.Serialize(serializedLines)}}) ?? System.Array.Empty<string>();
    private static int Index;

    public static string? ReadLine()
    {
        if (Index >= Lines.Length)
        {
            return null;
        }

        return Lines[Index++];
    }
}
""";
    }

    private static string[] SplitProjectStdinLines(string stdin)
    {
        string normalized = stdin.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
        if (normalized.Length == 0)
        {
            return Array.Empty<string>();
        }
        string[] lines = normalized.Split('\n');
        if (normalized.EndsWith("\n", StringComparison.Ordinal))
        {
            return lines.Take(lines.Length - 1).ToArray();
        }
        return lines;
    }

    private static void PrepareProjectWorkspace(
        CSharpProjectCommandRequest request,
        out Dictionary<string, byte[]> beforeSnapshot
    )
    {
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
        }

        beforeSnapshot = SnapshotProjectWorkspace();
    }

    private static Dictionary<string, byte[]> SnapshotProjectWorkspace()
    {
        Dictionary<string, byte[]> files = new(StringComparer.Ordinal);
        if (!Directory.Exists(ProjectWorkspaceRoot))
        {
            return files;
        }

        foreach (string filePath in Directory.EnumerateFiles(ProjectWorkspaceRoot, "*", SearchOption.AllDirectories))
        {
            string relativePath = Path.GetRelativePath(ProjectWorkspaceRoot, filePath).Replace('\\', '/');
            files[relativePath] = File.ReadAllBytes(filePath);
        }
        return files;
    }

    private static List<CSharpProjectFileChange> DiffProjectWorkspace(Dictionary<string, byte[]> beforeSnapshot)
    {
        Dictionary<string, byte[]> afterSnapshot = SnapshotProjectWorkspace();
        List<CSharpProjectFileChange> changes = new();

        foreach ((string path, byte[] afterBytes) in afterSnapshot.OrderBy(entry => entry.Key, StringComparer.Ordinal))
        {
            if (beforeSnapshot.TryGetValue(path, out byte[]? beforeBytes) && beforeBytes.SequenceEqual(afterBytes))
            {
                continue;
            }
            changes.Add(EncodeProjectFileChange(path, afterBytes));
        }

        foreach (string deletedPath in beforeSnapshot.Keys.Except(afterSnapshot.Keys, StringComparer.Ordinal).OrderBy(path => path, StringComparer.Ordinal))
        {
            changes.Add(new CSharpProjectFileChange { Path = deletedPath, Deleted = true });
        }

        return changes;
    }

    private static void EmitProjectFileChanges(IEnumerable<CSharpProjectFileChange> changes, string phase)
    {
        foreach (CSharpProjectFileChange change in changes)
        {
            EmitProjectEvent(new
            {
                type = "file-change",
                phase,
                change,
            });
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

        public StreamingProjectTextWriter(string stream)
        {
            this.stream = stream;
        }

        public override Encoding Encoding => Encoding.UTF8;

        public override void Write(char value)
        {
            buffer.Append(value);
            EmitProjectOutput(stream, value.ToString());
        }

        public override void Write(string? value)
        {
            if (value is null)
            {
                return;
            }

            buffer.Append(value);
            EmitProjectOutput(stream, value);
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
    }

    private static CSharpProjectFileChange EncodeProjectFileChange(string path, byte[] bytes)
    {
        string text = Encoding.UTF8.GetString(bytes);
        if (Encoding.UTF8.GetBytes(text).SequenceEqual(bytes))
        {
            return new CSharpProjectFileChange
            {
                Path = path,
                Contents = text,
                Encoding = "utf8",
            };
        }

        return new CSharpProjectFileChange
        {
            Path = path,
            Contents = Convert.ToBase64String(bytes),
            Encoding = "base64",
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

    private static string BuildCompilationCacheKey(CSharpExecuteRequest request)
    {
        return JsonSerializer.Serialize(new
        {
            request.Source,
            request.FunctionName,
            request.ExecutionStyle,
            request.Trace,
            InputShape = BuildInputShape(request.Inputs),
        }, JsonOptions);
    }

    public static string GetCurrentInputsJson()
    {
        return currentInputsJson;
    }

    private static object BuildInputShape(JsonElement value)
    {
        return value.ValueKind switch
        {
            JsonValueKind.Object => value
                .EnumerateObject()
                .OrderBy(property => property.Name, StringComparer.Ordinal)
                .ToDictionary(property => property.Name, property => BuildInputShape(property.Value), StringComparer.Ordinal),
            JsonValueKind.Array => new
            {
                kind = "array",
                elements = value.EnumerateArray().Select(BuildInputShape).Distinct().OrderBy(item => JsonSerializer.Serialize(item, JsonOptions)).ToArray(),
            },
            _ => value.ValueKind.ToString(),
        };
    }

    private static object BuildInputShape(IReadOnlyDictionary<string, JsonElement> inputs)
    {
        return inputs
            .OrderBy(entry => entry.Key, StringComparer.Ordinal)
            .ToDictionary(entry => entry.Key, entry => BuildInputShape(entry.Value), StringComparer.Ordinal);
    }

    private static void StoreCompilationCacheEntry(string cacheKey, byte[] peBytes)
    {
        if (CompilationCache.ContainsKey(cacheKey))
        {
            return;
        }

        CompilationCache[cacheKey] = peBytes;
        CompilationCacheOrder.Enqueue(cacheKey);

        while (CompilationCacheOrder.Count > CompilationCacheLimit)
        {
            string expiredKey = CompilationCacheOrder.Dequeue();
            CompilationCache.Remove(expiredKey);
        }
    }

    private static SyntaxTree CreateScriptUserTree(SyntaxTree originalUserTree)
    {
        return CSharpSyntaxTree.ParseText(
            GenerateScriptUserSource(originalUserTree),
            ParseOptions,
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
        var builder = new StringBuilder();
        AppendSourcePrelude(builder, sourceText, root);

        foreach (MemberDeclarationSyntax member in root.Members.Where(member => member is not GlobalStatementSyntax))
        {
            AppendMappedSource(builder, sourceText, member.FullSpan);
        }

        AppendLineIfNeeded(builder);
        builder.AppendLine($"internal static class {ScriptRunnerClassName}");
        builder.AppendLine("{");
        builder.AppendLine("    public static object? Run()");
        builder.AppendLine("    {");

        foreach (GlobalStatementSyntax statement in globalStatements)
        {
            AppendMappedSource(builder, sourceText, statement.FullSpan);
        }

        int resultLine = sourceText.Lines.GetLineFromPosition(globalStatements[^1].Span.End).LineNumber + 1;
        builder.AppendLine($"#line {resultLine} \"{UserCodePath}\"");
        builder.AppendLine("        return result;");
        builder.AppendLine("    }");
        builder.AppendLine("}");

        return builder.ToString();
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

        AppendLineIfNeeded(builder);
        int line = sourceText.Lines.GetLineFromPosition(span.Start).LineNumber + 1;
        builder.AppendLine($"#line {line} \"{UserCodePath}\"");
        string text = sourceText.ToString(span);
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

    private static string GenerateDriverSource(SyntaxTree userTree, CSharpExecuteRequest request)
    {
        if (IsScriptExecutionRequest(request))
        {
            return $$"""
using System;

public static class TraceCodeDriver
{
    public static object? Run()
    {
        return {{ScriptRunnerClassName}}.Run();
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
    public static object? Run()
    {
        string[] operations = TraceCode.Internal.TraceCodeJsonInput.Read<string[]>("operations", 0) ?? Array.Empty<string>();
        JsonElement[][] arguments = TraceCode.Internal.TraceCodeJsonInput.Read<JsonElement[][]>("arguments", 1) ?? Array.Empty<JsonElement[]>();
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
        var parameterReads = method.ParameterList.Parameters.Select((parameter, index) =>
        {
            string parameterName = parameter.Identifier.ValueText;
            string parameterType = GetDriverParameterType(parameter, nestedSolutionTypeNames);
            return $"        {parameterType} {parameterName} = TraceCode.Internal.TraceCodeJsonInput.Read<{parameterType}>({JsonSerializer.Serialize(parameterName)}, {index});";
        }).ToList();
        string readStatements = string.Join("\n", parameterReads);
        string arguments = string.Join(", ", method.ParameterList.Parameters.Select(parameter => parameter.Identifier.ValueText));
        string invocation = $"solution.{methodName}({arguments})";
        string? firstParameterName = method.ParameterList.Parameters.FirstOrDefault()?.Identifier.ValueText;
        bool returnsMutatedFirstParameter = returnsVoid
            && firstParameterName is not null
            && MutatesParameter(method, firstParameterName);
        string driverBody = returnsVoid
            ? returnsMutatedFirstParameter
                ? $"{invocation};\n        return {firstParameterName};"
                : $"{invocation};\n        return null;"
            : $"return {invocation};";

        return $$"""
using System;

public static class TraceCodeDriver
{
    public static object? Run()
    {
        var solution = new Solution();
{{readStatements}}
        {{driverBody}}
    }
}
""";
    }

    private static ISet<string> GetNestedSolutionTypeNames(MethodDeclarationSyntax method)
    {
        if (method.Parent is not ClassDeclarationSyntax solutionClass)
        {
            return new HashSet<string>(StringComparer.Ordinal);
        }

        return solutionClass.Members
            .OfType<ClassDeclarationSyntax>()
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

    private static bool MutatesParameter(MethodDeclarationSyntax method, string parameterName)
    {
        bool hasElementAssignment = method
            .DescendantNodes()
            .OfType<AssignmentExpressionSyntax>()
            .Any(assignment => IsParameterElementAccess(assignment.Left, parameterName));
        if (hasElementAssignment)
        {
            return true;
        }

        return method
            .DescendantNodes()
            .Any(node =>
                node is PrefixUnaryExpressionSyntax prefix && IsParameterElementAccess(prefix.Operand, parameterName)
                || node is PostfixUnaryExpressionSyntax postfix && IsParameterElementAccess(postfix.Operand, parameterName)
            );
    }

    private static bool IsParameterElementAccess(ExpressionSyntax expression, string parameterName)
    {
        ExpressionSyntax current = expression;
        while (current is ElementAccessExpressionSyntax elementAccess)
        {
            current = elementAccess.Expression;
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
        string preludeSource = GenerateNodePreludeSource(userTree);

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
        };
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
    public ListNode? next;

    public ListNode(int val = 0, ListNode? next = null)
    {
        this.val = val;
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
    public TreeNode? left;
    public TreeNode? right;

    public TreeNode(int val = 0, TreeNode? left = null, TreeNode? right = null)
    {
        this.val = val;
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
        private static JsonElement Root => JsonSerializer.Deserialize<JsonElement>(
            TraceCode.CSharpHost.CompilerHost.GetCurrentInputsJson(),
            JsonOptions
        );

        private static string[] Keys => Root.ValueKind == JsonValueKind.Object
            ? Root.EnumerateObject().Select(property => property.Name).ToArray()
            : Array.Empty<string>();

        public static T? Read<T>(string name, int index)
        {
            if (Root.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidOperationException("TraceCode C# inputs must be a JSON object.");
            }

            if (Root.TryGetProperty(name, out JsonElement namedValue))
            {
                return ReadValue<T>(namedValue);
            }

            if (index >= 0 && index < Keys.Length && Root.TryGetProperty(Keys[index], out JsonElement indexedValue))
            {
                return ReadValue<T>(indexedValue);
            }

            throw new InvalidOperationException($"Missing input value for parameter \"{name}\".");
        }

        public static object? Convert(JsonElement value, Type targetType)
        {
            if (targetType == typeof(ListNode))
            {
                return ReadListNode(value, new Dictionary<string, ListNode>(StringComparer.Ordinal));
            }

            if (targetType == typeof(TreeNode))
            {
                return ReadTreeNode(value, new Dictionary<string, TreeNode>(StringComparer.Ordinal));
            }

            if (targetType == typeof(object[]))
            {
                return ReadObjectArray(value);
            }

            if (targetType == typeof(object[][]))
            {
                return value.EnumerateArray().Select(item => ReadObjectArray(item)).ToArray();
            }

            if (targetType == typeof(object))
            {
                return ReadObjectValue(value);
            }

            if (TryReadObjectValueDictionary(value, targetType, out object? objectValueDictionary))
            {
                return objectValueDictionary;
            }

            if (ShouldUseStructuredObjectReader(value, targetType))
            {
                return ReadStructuredValue(value, targetType, new Dictionary<string, object>(StringComparer.Ordinal));
            }

            return JsonSerializer.Deserialize(value.GetRawText(), targetType, JsonOptions);
        }

        private static T? ReadValue<T>(JsonElement value)
        {
            if (typeof(T) == typeof(ListNode))
            {
                return (T?)(object?)ReadListNode(value, new Dictionary<string, ListNode>(StringComparer.Ordinal));
            }

            if (typeof(T) == typeof(TreeNode))
            {
                return (T?)(object?)ReadTreeNode(value, new Dictionary<string, TreeNode>(StringComparer.Ordinal));
            }

            if (typeof(T) == typeof(object[]))
            {
                return (T?)(object?)ReadObjectArray(value);
            }

            if (typeof(T) == typeof(object[][]))
            {
                return (T?)(object?)value.EnumerateArray().Select(item => ReadObjectArray(item)).ToArray();
            }

            if (typeof(T) == typeof(object))
            {
                return (T?)ReadObjectValue(value);
            }

            if (TryReadObjectValueDictionary(value, typeof(T), out object? objectValueDictionary))
            {
                return (T?)objectValueDictionary;
            }

            if (ShouldUseStructuredObjectReader(value, typeof(T)))
            {
                return (T?)ReadStructuredValue(value, typeof(T), new Dictionary<string, object>(StringComparer.Ordinal));
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

        private static bool IsSupportedStructuredSequenceType(Type targetType)
        {
            if (targetType.IsArray)
            {
                return true;
            }

            return targetType.IsGenericType
                && targetType.GetGenericTypeDefinition() == typeof(List<>);
        }

        private static object? ReadStructuredValue(JsonElement value, Type targetType, IDictionary<string, object> refs)
        {
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
                return ReadObjectValue(value);
            }

            if (effectiveType.IsPrimitive || effectiveType.IsEnum || effectiveType == typeof(decimal))
            {
                return JsonSerializer.Deserialize(value.GetRawText(), effectiveType, JsonOptions);
            }

            if (IsSupportedDictionaryType(effectiveType))
            {
                if (TryReadObjectValueDictionary(value, effectiveType, out object? objectValueDictionary))
                {
                    return objectValueDictionary;
                }

                return JsonSerializer.Deserialize(value.GetRawText(), effectiveType, JsonOptions);
            }

            if (effectiveType.IsArray)
            {
                Type elementType = effectiveType.GetElementType() ?? typeof(object);
                JsonElement[] values = value.EnumerateArray().ToArray();
                Array array = Array.CreateInstance(elementType, values.Length);
                for (int i = 0; i < values.Length; i++)
                {
                    array.SetValue(ReadStructuredValue(values[i], elementType, refs), i);
                }
                return array;
            }

            if (effectiveType.IsGenericType && effectiveType.GetGenericTypeDefinition() == typeof(List<>))
            {
                Type elementType = effectiveType.GetGenericArguments()[0];
                System.Collections.IList list = (System.Collections.IList)Activator.CreateInstance(effectiveType)!;
                foreach (JsonElement item in value.EnumerateArray())
                {
                    list.Add(ReadStructuredValue(item, elementType, refs));
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

            object instance = CreateStructuredObject(value, effectiveType, refs);
            if (TryReadStringProperty(value, "__id__", out string? id))
            {
                refs[id] = instance;
            }

            foreach (FieldInfo field in effectiveType.GetFields(BindingFlags.Public | BindingFlags.Instance))
            {
                if (TryGetProperty(value, field.Name, out JsonElement property))
                {
                    field.SetValue(instance, ReadStructuredValue(property, field.FieldType, refs));
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

                property.SetValue(instance, ReadStructuredValue(propertyValue, property.PropertyType, refs));
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

        private static bool TryReadObjectValueDictionary(JsonElement value, Type targetType, out object? dictionary)
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
            System.Collections.IDictionary result = (System.Collections.IDictionary)Activator.CreateInstance(dictionaryType)!;
            foreach (JsonProperty property in value.EnumerateObject())
            {
                result[ReadDictionaryKey(property.Name, keyType)] = ReadObjectValue(property.Value);
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

        private static object CreateStructuredObject(JsonElement value, Type targetType, IDictionary<string, object> refs)
        {
            foreach (ConstructorInfo constructor in targetType
                .GetConstructors(BindingFlags.Public | BindingFlags.Instance)
                .OrderByDescending(candidate => candidate.GetParameters().Length))
            {
                ParameterInfo[] parameters = constructor.GetParameters();
                if (!parameters.All(parameter => TryGetProperty(value, parameter.Name ?? string.Empty, out _) || parameter.HasDefaultValue))
                {
                    continue;
                }

                object?[] args = parameters.Select(parameter =>
                    TryGetProperty(value, parameter.Name ?? string.Empty, out JsonElement property)
                        ? ReadStructuredValue(property, parameter.ParameterType, refs)
                        : parameter.DefaultValue
                ).ToArray();
                return constructor.Invoke(args);
            }

            ConstructorInfo? parameterless = targetType.GetConstructor(Type.EmptyTypes);
            if (parameterless is not null)
            {
                return parameterless.Invoke(null);
            }

            throw new InvalidOperationException($"Cannot hydrate input object of type {targetType.FullName}.");
        }

        private static object[] ReadObjectArray(JsonElement value)
        {
            return value.EnumerateArray().Select(ReadObjectValue).ToArray();
        }

        private static object? ReadObjectValue(JsonElement value)
        {
            return value.ValueKind switch
            {
                JsonValueKind.String => value.GetString(),
                JsonValueKind.Number => ReadObjectNumber(value),
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                JsonValueKind.Null or JsonValueKind.Undefined => null,
                JsonValueKind.Array => ReadObjectArray(value),
                JsonValueKind.Object => value.EnumerateObject().ToDictionary(
                    property => property.Name,
                    property => ReadObjectValue(property.Value),
                    StringComparer.Ordinal
                ),
                _ => null,
            };
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

        private static ListNode? ReadListNode(JsonElement value, IDictionary<string, ListNode> refs)
        {
            if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            {
                return null;
            }

            if (value.ValueKind == JsonValueKind.Array)
            {
                ListNode? head = null;
                ListNode? cursor = null;
                foreach (JsonElement item in value.EnumerateArray())
                {
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
                    node.next = ReadListNode(next, refs);
                }

                return node;
            }

            return new ListNode(value.GetInt32());
        }

        private static TreeNode? ReadTreeNode(JsonElement value, IDictionary<string, TreeNode> refs)
        {
            if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            {
                return null;
            }

            if (value.ValueKind == JsonValueKind.Array)
            {
                JsonElement[] values = value.EnumerateArray().ToArray();
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
                    node.left = ReadTreeNode(left, refs);
                }

                if (TryGetProperty(value, "right", out JsonElement right))
                {
                    node.right = ReadTreeNode(right, refs);
                }

                return node;
            }

            return new TreeNode(value.GetInt32());
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

        public static void Snapshot(string variable, object? value, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, value, line);
        }

        public static void Mutate(string variable, string method, IReadOnlyList<object?> args)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, method, args);
        }

        public static void Mutate(string variable, object index, string method, IReadOnlyList<object?> args)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, new object?[] { index }, method, args);
        }

        public static void Mutate(string variable, string[] path, string method, IReadOnlyList<object?> args)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, path, method, args);
        }

        public static void Mutate(string variable, object?[] path, string method, IReadOnlyList<object?> args)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, path, method, args);
        }

        public static void IndexedRead(string variable, object index, object? value, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, index, value, line);
        }

        public static T IndexedRead<T>(string variable, object?[] path, T value, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, path, value, line);
            return value;
        }

        public static bool ContainsRead(bool contains, string variable, object? key, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, key!, contains, line);
            return contains;
        }

        public static bool ContainsRead(bool contains, string variable, object?[] path, int line)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, path, contains, line);
            return contains;
        }

        public static T ArrayRead<T>(T[] array, int index, string variable, int line)
        {
            T value = array[index];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, index, value, line);
            return value;
        }

        public static T ArrayRead<T>(IList<T> list, int index, string variable, int line)
        {
            T value = list[index];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, index, value, line);
            return value;
        }

        public static TValue ArrayRead<TKey, TValue>(IDictionary<TKey, TValue> dictionary, TKey key, string variable, int line)
            where TKey : notnull
        {
            TValue value = dictionary[key];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, key, value, line);
            return value;
        }

        public static TValue ArrayRead<TKey, TValue>(
            IDictionary<TKey, TValue[]> dictionary,
            TKey key,
            int index,
            string variable,
            int line
        ) where TKey : notnull
        {
            TValue value = dictionary[key][index];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { key, index }, value, line);
            return value;
        }

        public static TValue ArrayRead<TKey, TValue>(
            IDictionary<TKey, List<TValue>> dictionary,
            TKey key,
            int index,
            string variable,
            int line
        ) where TKey : notnull
        {
            TValue value = dictionary[key][index];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { key, index }, value, line);
            return value;
        }

        public static TValue ArrayRead<TKey, TValue>(
            IDictionary<TKey, TraceCodeList<TValue>> dictionary,
            TKey key,
            int index,
            string variable,
            int line
        ) where TKey : notnull
        {
            TValue value = dictionary[key][index];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { key, index }, value, line);
            return value;
        }

        public static char ArrayRead<TKey>(IDictionary<TKey, string> dictionary, TKey key, int index, string variable, int line)
            where TKey : notnull
        {
            char value = dictionary[key][index];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { key, index }, value, line);
            return value;
        }

        public static T ArrayRead<T>(T[][] array, int row, int column, string variable, int line)
        {
            T value = array[row][column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line);
            return value;
        }

        public static T ArrayRead<T>(T[,] array, int row, int column, string variable, int line)
        {
            T value = array[row, column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line);
            return value;
        }

        public static T ArrayRead<T>(T[,,] array, int first, int second, int third, string variable, int line)
        {
            T value = array[first, second, third];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { first, second, third }, value, line);
            return value;
        }

        public static T ArrayRead<T>(TraceCodeList<T[]> list, int row, int column, string variable, int line)
        {
            T value = list[row][column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line);
            return value;
        }

        public static T ArrayRead<T>(IList<T[]> list, int row, int column, string variable, int line)
        {
            T value = list[row][column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line);
            return value;
        }

        public static T ArrayRead<T>(IList<T>[] array, int row, int column, string variable, int line)
        {
            T value = array[row][column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line);
            return value;
        }

        public static T ArrayRead<T>(List<List<T>> list, int row, int column, string variable, int line)
        {
            T value = list[row][column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line);
            return value;
        }

        public static T ArrayRead<T>(IList<IList<T>> list, int row, int column, string variable, int line)
        {
            T value = list[row][column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line);
            return value;
        }

        public static TValue ArrayRead<TKey, TValue>(
            IList<Dictionary<TKey, TValue>> list,
            int row,
            TKey key,
            string variable,
            int line
        ) where TKey : notnull
        {
            TValue value = list[row][key];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, key }, value, line);
            return value;
        }

        public static TValue ArrayRead<TKey, TValue>(
            IList<TraceCodeDictionary<TKey, TValue>> list,
            int row,
            TKey key,
            string variable,
            int line
        ) where TKey : notnull
        {
            TValue value = list[row][key];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, key }, value, line);
            return value;
        }

        public static char ArrayRead(string text, int index, string variable, int line)
        {
            char value = text[index];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, index, value, line);
            return value;
        }

        public static char ArrayRead(StringBuilder text, int index, string variable, int line)
        {
            char value = text[index];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, index, value, line);
            return value;
        }

        public static char ArrayRead(IList<string> list, int row, int column, string variable, int line)
        {
            char value = list[row][column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line);
            return value;
        }

        public static char ArrayRead(string[] array, int row, int column, string variable, int line)
        {
            char value = array[row][column];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, column }, value, line);
            return value;
        }

        public static TValue ArrayRead<TKey, TValue>(
            Dictionary<TKey, TValue>[] array,
            int row,
            TKey key,
            string variable,
            int line
        ) where TKey : notnull
        {
            TValue value = array[row][key];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, key }, value, line);
            return value;
        }

        public static TValue ArrayRead<TKey, TValue>(
            TraceCodeDictionary<TKey, TValue>[] array,
            int row,
            TKey key,
            string variable,
            int line
        ) where TKey : notnull
        {
            TValue value = array[row][key];
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, new object?[] { row, key }, value, line);
            return value;
        }

        public static void ArrayWrite<T>(T[] array, int index, T value, string variable, int line)
        {
            array[index] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, index, value, line);
        }

        public static void ArrayWrite(char[] array, int index, int value, string variable, int line)
        {
            char charValue = (char)value;
            array[index] = charValue;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, index, charValue, line);
        }

        public static void ArrayWrite(StringBuilder text, int index, char value, string variable, int line)
        {
            text[index] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, index, value, line);
        }

        public static void ArrayWrite(StringBuilder text, int index, int value, string variable, int line)
        {
            char charValue = (char)value;
            text[index] = charValue;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, index, charValue, line);
        }

        public static void ArrayWrite<T>(IList<T> list, int index, T value, string variable, int line)
        {
            list[index] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, index, value, line);
        }

        public static void ArrayWrite<TKey, TValue>(
            IDictionary<TKey, TValue> dictionary,
            TKey key,
            TValue value,
            string variable,
            int line
        ) where TKey : notnull
        {
            dictionary[key] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, key, value, line);
        }

        public static void ArrayWrite<TKey, TValue>(
            IDictionary<TKey, TValue[]> dictionary,
            TKey key,
            int index,
            TValue value,
            string variable,
            int line
        ) where TKey : notnull
        {
            dictionary[key][index] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { key, index }, value, line);
        }

        public static void ArrayWrite<TKey, TValue>(
            IDictionary<TKey, List<TValue>> dictionary,
            TKey key,
            int index,
            TValue value,
            string variable,
            int line
        ) where TKey : notnull
        {
            dictionary[key][index] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { key, index }, value, line);
        }

        public static void ArrayWrite<TKey, TValue>(
            IDictionary<TKey, TraceCodeList<TValue>> dictionary,
            TKey key,
            int index,
            TValue value,
            string variable,
            int line
        ) where TKey : notnull
        {
            dictionary[key][index] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { key, index }, value, line);
        }

        public static void ArrayWrite<T>(T[][] array, int row, int column, T value, string variable, int line)
        {
            array[row][column] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, column }, value, line);
        }

        public static void ArrayWrite<T>(T[,] array, int row, int column, T value, string variable, int line)
        {
            array[row, column] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, column }, value, line);
        }

        public static void ArrayWrite<T>(T[,,] array, int first, int second, int third, T value, string variable, int line)
        {
            array[first, second, third] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { first, second, third }, value, line);
        }

        public static void ArrayWrite<T>(IList<T[]> list, int row, int column, T value, string variable, int line)
        {
            list[row][column] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, column }, value, line);
        }

        public static void ArrayWrite<T>(IList<T>[] array, int row, int column, T value, string variable, int line)
        {
            array[row][column] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, column }, value, line);
        }

        public static void ArrayWrite<T>(List<List<T>> list, int row, int column, T value, string variable, int line)
        {
            list[row][column] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, column }, value, line);
        }

        public static void ArrayWrite<T>(IList<IList<T>> list, int row, int column, T value, string variable, int line)
        {
            list[row][column] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, column }, value, line);
        }

        public static void ArrayWrite<TKey, TValue>(
            IList<Dictionary<TKey, TValue>> list,
            int row,
            TKey key,
            TValue value,
            string variable,
            int line
        ) where TKey : notnull
        {
            list[row][key] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, key }, value, line);
        }

        public static void ArrayWrite<TKey, TValue>(
            IList<TraceCodeDictionary<TKey, TValue>> list,
            int row,
            TKey key,
            TValue value,
            string variable,
            int line
        ) where TKey : notnull
        {
            list[row][key] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, key }, value, line);
        }

        public static void ArrayWrite<TKey, TValue>(
            Dictionary<TKey, TValue>[] array,
            int row,
            TKey key,
            TValue value,
            string variable,
            int line
        ) where TKey : notnull
        {
            array[row][key] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, key }, value, line);
        }

        public static void ArrayWrite<TKey, TValue>(
            TraceCodeDictionary<TKey, TValue>[] array,
            int row,
            TKey key,
            TValue value,
            string variable,
            int line
        ) where TKey : notnull
        {
            array[row][key] = value;
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, new object?[] { row, key }, value, line);
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

        public static void CheckTimeout()
        {
            TraceCode.CSharpHost.RuntimeTraceSink.CheckTimeout();
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
                TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, index, value, TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine);
                return value;
            }
            set
            {
                base[index] = value;
                TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, index, value, TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine);
                TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            }
        }

        public new void Add(T item)
        {
            base.Add(item);
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Add", new object?[] { item });
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new void RemoveAt(int index)
        {
            base.RemoveAt(index);
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "RemoveAt", new object?[] { index });
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
                TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, key, value, TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine);
                return value;
            }
            set
            {
                base[key] = value;
                TraceCode.CSharpHost.RuntimeTraceSink.IndexedWrite(variable, key, value, TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine);
                TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            }
        }

        public new void Add(TKey key, TValue value)
        {
            base.Add(key, value);
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Add", new object?[] { key, value });
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new bool Remove(TKey key)
        {
            bool removed = base.Remove(key);
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Remove", new object?[] { key });
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            return removed;
        }

        public new bool ContainsKey(TKey key)
        {
            bool contains = base.ContainsKey(key);
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, key, contains, TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine);
            return contains;
        }

        public new bool TryGetValue(TKey key, out TValue value)
        {
            bool found = base.TryGetValue(key, out value!);
            TraceCode.CSharpHost.RuntimeTraceSink.IndexedRead(variable, key, found ? value : default, TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine);
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
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Add", new object?[] { item });
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
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Remove", new object?[] { item });
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            return removed;
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
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Enqueue", new object?[] { item });
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new T Dequeue()
        {
            T item = base.Dequeue();
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Dequeue", Array.Empty<object?>());
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            return item;
        }

        public new T Peek()
        {
            T item = base.Peek();
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Peek", Array.Empty<object?>());
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
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Enqueue", new object?[] { element });
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new TElement Dequeue()
        {
            TElement item = base.Dequeue();
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Dequeue", Array.Empty<object?>());
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
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
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "append", new object?[] { value });
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            return node;
        }

        public new LinkedListNode<T> AddFirst(T value)
        {
            LinkedListNode<T> node = base.AddFirst(value);
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "appendleft", new object?[] { value });
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            return node;
        }

        public new void RemoveFirst()
        {
            base.RemoveFirst();
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "popleft", Array.Empty<object?>());
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new void RemoveLast()
        {
            base.RemoveLast();
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "pop", Array.Empty<object?>());
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
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Push", new object?[] { item });
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new T Pop()
        {
            T item = base.Pop();
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Pop", Array.Empty<object?>());
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            return item;
        }

        public new T Peek()
        {
            T item = base.Peek();
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Peek", Array.Empty<object?>());
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
                referencePaths.Add(path);
            }
        }

        foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (!string.IsNullOrWhiteSpace(assembly.Location))
            {
                referencePaths.Add(assembly.Location);
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
                referencePaths.Add(path);
            }
        }

        return referencePaths.Select(path => MetadataReference.CreateFromFile(path));
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
            referencePaths.Add(path);
        }
    }

    private static object? InvokeDriver(Assembly userAssembly)
    {
        Type driverType = userAssembly.GetType("TraceCodeDriver")
            ?? throw new InvalidOperationException("TraceCode generated driver was not found.");
        MethodInfo method = driverType.GetMethod("Run", BindingFlags.Static | BindingFlags.Public)
            ?? throw new InvalidOperationException("TraceCode generated driver did not expose Run().");
        return method.Invoke(null, null);
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
        if (type.Name is not ("ListNode" or "TreeNode"))
        {
            result["__type__"] = type.Name;
        }
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
            Events = RuntimeTraceSink.Snapshot(),
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
}

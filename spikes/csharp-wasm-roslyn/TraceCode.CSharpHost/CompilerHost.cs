using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace TraceCode.CSharpHost;

public static partial class CompilerHost
{
    private const int CompilationCacheLimit = 32;
    private const string UserCodePath = "solution.cs";
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

        public static bool LoopCondition(int line, string? function, Func<bool> action)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Line(line, function);
            return WithSourceLine(line, action);
        }

        public static bool LoopCondition(int line, string? function, Func<bool> action, Action snapshot)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Line(line, function);
            bool result = WithSourceLine(line, action);
            snapshot();
            return result;
        }

        public static IEnumerable<T> EnumerableSource<T>(int line, string? function, Func<IEnumerable<T>> action)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Line(line, function);
            return WithSourceLine(line, action);
        }

        public static IEnumerable<T> EnumerableSource<T>(int line, string? function, Func<IEnumerable<T>> action, Action snapshot)
        {
            TraceCode.CSharpHost.RuntimeTraceSink.Line(line, function);
            IEnumerable<T> result = WithSourceLine(line, action);
            snapshot();
            return result;
        }

        public static T WithSourceLine<T>(int line, Func<T> action)
        {
            int previousLine = TraceCode.CSharpHost.RuntimeTraceSink.CurrentLine;
            int previousScopedLine = TraceCode.CSharpHost.RuntimeTraceSink.CurrentScopedSourceLine;
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
            T value = list[row][column];
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
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Add", new object?[] { item }, TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
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
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Add", new object?[] { key, value }, TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new bool Remove(TKey key)
        {
            bool removed = base.Remove(key);
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Remove", new object?[] { key }, TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
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
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Remove", new object?[] { item }, TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
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
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Enqueue", new object?[] { item }, TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
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
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Enqueue", new object?[] { element }, TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
        }

        public new TElement Dequeue()
        {
            TElement item = base.Dequeue();
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "Dequeue", Array.Empty<object?>(), TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
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
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "append", new object?[] { value }, TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
            TraceCode.CSharpHost.RuntimeTraceSink.Snapshot(variable, this);
            return node;
        }

        public new LinkedListNode<T> AddFirst(T value)
        {
            LinkedListNode<T> node = base.AddFirst(value);
            TraceCode.CSharpHost.RuntimeTraceSink.Mutate(variable, "appendleft", new object?[] { value }, TraceCode.CSharpHost.RuntimeTraceSink.ScopedSourceLine);
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

    private static List<string> SplitConsoleOutput(StringWriter capturedOut)
    {
        return capturedOut
            .ToString()
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .ToList();
    }

    private sealed class TracingConsoleWriter : StringWriter
    {
        private readonly StringBuilder lineBuffer = new();

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
    }
}

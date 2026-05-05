using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace TraceCode.CSharpHost;

public static partial class CompilerHost
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        IncludeFields = true,
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
    };

    [JSExport]
    [SupportedOSPlatform("browser")]
    public static string Execute(string requestJson)
    {
        Stopwatch stopwatch = Stopwatch.StartNew();
        TextWriter originalOut = Console.Out;
        using StringWriter capturedOut = new();
        Console.SetOut(capturedOut);
        RuntimeTraceSink.Reset();

        try
        {
            CSharpExecuteRequest? request = JsonSerializer.Deserialize<CSharpExecuteRequest>(requestJson, JsonOptions);
            if (request is null)
            {
                return SerializeError("Invalid C# execution request.", stopwatch, capturedOut);
            }
            RuntimeTraceSink.Configure(request.TimeoutMs, request.Trace ? request.MaxTraceSteps : null);

            CSharpCompilation compilation = CreateCompilation(request);
            using MemoryStream peStream = new();
            var emitResult = compilation.Emit(peStream);

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
                });
            }

            Assembly userAssembly = Assembly.Load(peStream.ToArray());
            object? output = InvokeDriver(userAssembly);
            return Serialize(new CSharpExecuteResponse
            {
                Success = true,
                Output = NormalizeOutput(output),
                ConsoleOutput = SplitConsoleOutput(capturedOut),
                Events = RuntimeTraceSink.Snapshot(),
                ExecutionTimeMs = stopwatch.Elapsed.TotalMilliseconds,
            });
        }
        catch (Exception error) when (error.GetBaseException() is TraceCodeTimeoutException timeout)
        {
            return SerializeError(timeout.Message, stopwatch, capturedOut, timeoutReason: "client-timeout");
        }
        catch (Exception error) when (error.GetBaseException() is TraceLimitExceededException traceLimit)
        {
            return SerializeError(
                traceLimit.Message,
                stopwatch,
                capturedOut,
                traceLimitExceeded: true,
                timeoutReason: "trace-limit"
            );
        }
        catch (Exception error)
        {
            return SerializeError(error.GetBaseException().Message, stopwatch, capturedOut);
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
            new CSharpParseOptions(LanguageVersion.CSharp12),
            path: "UserCode.cs"
        );
        SyntaxTree userTree = TraceRewriter.Instrument(originalUserTree, request.Trace);
        SyntaxTree globalUsingsTree = CSharpSyntaxTree.ParseText(
            GenerateGlobalUsingsSource(),
            new CSharpParseOptions(LanguageVersion.CSharp12),
            path: "TraceCodeGlobalUsings.cs"
        );
        SyntaxTree runtimeTree = CSharpSyntaxTree.ParseText(
            GenerateRuntimeSource(request.Inputs, originalUserTree),
            new CSharpParseOptions(LanguageVersion.CSharp12),
            path: "TraceCodeRuntime.cs"
        );
        SyntaxTree driverTree = CSharpSyntaxTree.ParseText(
            GenerateDriverSource(originalUserTree, request),
            new CSharpParseOptions(LanguageVersion.CSharp12),
            path: "TraceCodeDriver.cs"
        );

        return CSharpCompilation.Create(
            assemblyName: "TraceCode.UserCode." + Guid.NewGuid().ToString("N"),
            syntaxTrees: new[] { globalUsingsTree, userTree, runtimeTree, driverTree },
            references: ResolveReferences(),
            options: new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                optimizationLevel: OptimizationLevel.Release,
                concurrentBuild: false,
                allowUnsafe: false
            )
        );
    }

    private static string GenerateDriverSource(SyntaxTree userTree, CSharpExecuteRequest request)
    {
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
        bool returnsVoid = method.ReturnType is PredefinedTypeSyntax predefinedType
            && predefinedType.Keyword.IsKind(SyntaxKind.VoidKeyword);
        var parameterReads = method.ParameterList.Parameters.Select((parameter, index) =>
        {
            string parameterName = parameter.Identifier.ValueText;
            string parameterType = parameter.Type?.ToString() ?? "object";
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
global using System.Collections.Generic;
global using System.Linq;
""";
    }

    private static string GenerateRuntimeSource(IReadOnlyDictionary<string, JsonElement> inputs, SyntaxTree userTree)
    {
        string inputsJson = JsonSerializer.Serialize(inputs, JsonOptions);
        string inputsBase64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(inputsJson));
        string preludeSource = GenerateNodePreludeSource(userTree);

        return $$"""
using System;
using System.Collections.Generic;
using System.Linq;
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
""" + GenerateRuntimeSourceTail(inputsBase64);
    }

    private static string GenerateNodePreludeSource(SyntaxTree userTree)
    {
        CompilationUnitSyntax root = userTree.GetCompilationUnitRoot();
        var classNames = root
            .DescendantNodes()
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

    private static string GenerateRuntimeSourceTail(string inputsBase64)
    {
        return $$"""
        private static readonly JsonElement Root = JsonSerializer.Deserialize<JsonElement>(
            Encoding.UTF8.GetString(System.Convert.FromBase64String("{{inputsBase64}}")),
            JsonOptions
        );

        private static readonly string[] Keys = Root.ValueKind == JsonValueKind.Object
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

            return JsonSerializer.Deserialize<T>(value.GetRawText(), JsonOptions);
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
                JsonValueKind.Number => value.TryGetInt64(out long longValue) ? longValue : value.GetDouble(),
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

        private static ListNode? ReadListNode(JsonElement value, IDictionary<string, ListNode> refs)
        {
            if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            {
                return null;
            }

            if (value.ValueKind == JsonValueKind.Array)
            {
                ListNode sentinel = new();
                ListNode cursor = sentinel;
                foreach (JsonElement item in value.EnumerateArray())
                {
                    if (item.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
                    {
                        continue;
                    }

                    cursor.next = new ListNode(item.GetInt32());
                    cursor = cursor.next;
                }

                return sentinel.next;
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

        public static char ArrayRead(string text, int index, string variable, int line)
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
            new HashSet<object>(ReferenceEqualityComparer.Instance)
        );
        string json = JsonSerializer.Serialize(normalized, normalized?.GetType() ?? typeof(object), JsonOptions);
        return JsonSerializer.Deserialize<JsonElement>(json, JsonOptions);
    }

    private static object? NormalizeOutputValue(object? value, int depth, ISet<object> seen)
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
            if (!seen.Add(value))
            {
                return new Dictionary<string, object?> { ["__ref__"] = type.Name };
            }

            var result = new Dictionary<string, object?>();
            foreach (System.Collections.DictionaryEntry entry in dictionary)
            {
                result[NormalizeOutputKey(entry.Key)] = NormalizeOutputValue(entry.Value, depth + 1, seen);
            }

            return result;
        }

        if (value is Array array)
        {
            if (!seen.Add(value))
            {
                return new List<object?>();
            }

            return NormalizeOutputArray(array, 0, new int[array.Rank], depth, seen);
        }

        if (value is System.Collections.IEnumerable enumerable)
        {
            if (!seen.Add(value))
            {
                return new List<object?>();
            }

            var result = new List<object?>();
            foreach (object? item in enumerable)
            {
                result.Add(NormalizeOutputValue(item, depth + 1, seen));
            }

            return result;
        }

        return NormalizeOutputObject(value, type, depth, seen);
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

    private static object? NormalizeOutputArray(Array array, int dimension, int[] indices, int depth, ISet<object> seen)
    {
        var values = new List<object?>();
        int lower = array.GetLowerBound(dimension);
        int upper = array.GetUpperBound(dimension);
        for (int index = lower; index <= upper; index++)
        {
            indices[dimension] = index;
            values.Add(dimension == array.Rank - 1
                ? NormalizeOutputValue(array.GetValue(indices), depth + 1, seen)
                : NormalizeOutputArray(array, dimension + 1, indices, depth + 1, seen));
        }

        return values;
    }

    private static object? NormalizeOutputObject(object value, Type type, int depth, ISet<object> seen)
    {
        if (!seen.Add(value))
        {
            return new Dictionary<string, object?> { ["__ref__"] = type.Name };
        }

        var result = new Dictionary<string, object?>();
        AddOutputFieldMembers(result, value, type, depth, seen);
        AddOutputPropertyMembers(result, value, type, depth, seen);
        return result.Count > 0 ? result : value;
    }

    private static void AddOutputFieldMembers(
        IDictionary<string, object?> result,
        object value,
        Type type,
        int depth,
        ISet<object> seen
    )
    {
        foreach (FieldInfo field in OrderOutputMembers(type.GetFields(BindingFlags.Public | BindingFlags.Instance)))
        {
            result[field.Name] = NormalizeOutputValue(field.GetValue(value), depth + 1, seen);
        }
    }

    private static void AddOutputPropertyMembers(
        IDictionary<string, object?> result,
        object value,
        Type type,
        int depth,
        ISet<object> seen
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
                result[property.Name] = NormalizeOutputValue(property.GetValue(value), depth + 1, seen);
            }
            catch
            {
                // Keep output serialization best-effort for user-defined objects with throwing accessors.
            }
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
        string? timeoutReason = null
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
        });
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
}

using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Microsoft.CodeAnalysis.Text;
using TraceCode.TraceClrWire;

return await TraceClrProfileGenerator.RunAsync(args);

internal static class TraceClrProfileGenerator
{
    private const string ProfileSchema = "tracecode.traceclr-algorithm-profile.v1";
    private const string ConfigSchema = "tracecode.traceclr-algorithm-profile-config.v1";
    private static readonly CSharpParseOptions ParseOptions = new(LanguageVersion.CSharp14);
    private static readonly IReadOnlyDictionary<short, OpCode> OpCodesByValue = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where(field => field.FieldType == typeof(OpCode))
        .Select(field => (OpCode)field.GetValue(null)!)
        .ToDictionary(opCode => opCode.Value);

    public static async Task<int> RunAsync(string[] args)
    {
        Options options;
        try
        {
            options = Options.Parse(args);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            Console.Error.WriteLine(Options.Usage);
            return 2;
        }

        ProfileConfig config = await ReadJsonAsync<ProfileConfig>(options.ConfigPath);
        if (config.Schema != ConfigSchema)
        {
            throw new InvalidDataException(
                $"TraceCLR profile config schema mismatch: expected {ConfigSchema}, received {config.Schema}."
            );
        }

        string corpusRoot = Path.GetFullPath(options.CorpusRoot);
        string problemDirectory = Path.GetFullPath(options.ProblemDirectory);
        string referenceDirectory = Path.GetFullPath(options.ReferenceDirectory);
        string runtimeDirectory = Path.GetFullPath(options.RuntimeDirectory);
        string[] sourcePaths = Directory
            .EnumerateFiles(corpusRoot, "*.cs", SearchOption.AllDirectories)
            .OrderBy(path => RelativePath(corpusRoot, path), StringComparer.Ordinal)
            .ToArray();
        if (sourcePaths.Length == 0)
        {
            throw new InvalidDataException($"TraceCLR corpus is empty: {corpusRoot}");
        }

        string[] referencePaths = Directory
            .EnumerateFiles(referenceDirectory, "*.dll", SearchOption.TopDirectoryOnly)
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (referencePaths.Length == 0)
        {
            throw new InvalidDataException($"TraceCLR reference directory is empty: {referenceDirectory}");
        }

        MetadataReference[] references = referencePaths
            .Select(path => MetadataReference.CreateFromFile(path))
            .ToArray();
        SyntaxTree globalUsingsTree = CSharpSyntaxTree.ParseText(
            string.Join('\n', config.GlobalUsings.Select(value => $"global using {value};")) + "\n",
            ParseOptions,
            path: "TraceCodeGlobalUsings.cs"
        );

        var sources = new List<SourceProfile>(sourcePaths.Length);
        var assemblyReferences = new SortedSet<string>(StringComparer.Ordinal);
        var typeReferences = new SortedSet<string>(StringComparer.Ordinal);
        var memberReferences = new SortedSet<string>(StringComparer.Ordinal);
        var cilOpcodes = new SortedSet<string>(StringComparer.Ordinal);
        var failures = new List<CompilationFailure>();
        var driverArtifacts = new List<DriverArtifactProfile>();
        if (options.DriverOutputDirectory is not null)
        {
            string outputDirectory = Path.GetFullPath(options.DriverOutputDirectory);
            if (Directory.Exists(outputDirectory) && Directory.EnumerateFileSystemEntries(outputDirectory).Any())
            {
                throw new InvalidDataException($"TraceCLR driver output directory must be empty: {outputDirectory}");
            }
            Directory.CreateDirectory(outputDirectory);
        }

        foreach (string sourcePath in sourcePaths)
        {
            string relativePath = RelativePath(corpusRoot, sourcePath);
            string? functionName = await ReadFunctionNameAsync(
                Path.Combine(
                    problemDirectory,
                    Path.GetFileNameWithoutExtension(sourcePath) + ".json"
                )
            );
            string sourceText = await File.ReadAllTextAsync(sourcePath);
            string sourceSha256 = Sha256(Encoding.UTF8.GetBytes(sourceText));
            SyntaxTree userTree = CSharpSyntaxTree.ParseText(sourceText, ParseOptions, path: relativePath);
            SyntaxTree nodePreludeTree = CSharpSyntaxTree.ParseText(
                GenerateNodePreludeSource(userTree),
                ParseOptions,
                path: "TraceCodeNodePrelude.cs"
            );
            CSharpCompilation compilation = CSharpCompilation.Create(
                assemblyName: "TraceClr.Corpus." + sourceSha256[..16],
                syntaxTrees: new[] { globalUsingsTree, nodePreludeTree, userTree },
                references: references,
                options: new CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    optimizationLevel: OptimizationLevel.Release,
                    concurrentBuild: false,
                    deterministic: true,
                    allowUnsafe: false
                )
            );

            using var peStream = new MemoryStream();
            EmitResult emitResult = compilation.Emit(peStream);
            string[] diagnostics = emitResult.Diagnostics
                .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
                .Select(FormatDiagnostic)
                .Order(StringComparer.Ordinal)
                .ToArray();
            if (!emitResult.Success)
            {
                failures.Add(new CompilationFailure(relativePath, diagnostics));
                sources.Add(
                    new SourceProfile(
                        relativePath,
                        sourceSha256,
                        functionName,
                        "failed",
                        Array.Empty<string>(),
                        Array.Empty<WireContractProfile>(),
                        0,
                        0,
                        0
                    )
                );
                continue;
            }

            AssemblyInventory inventory = ReadAssemblyInventory(peStream.ToArray());
            WireContractProfile[] wireContracts = ReadWireContracts(
                compilation,
                userTree,
                functionName
            );
            for (int index = 0; index < wireContracts.Length; index++)
            {
                WireContractProfile contract = wireContracts[index];
                if (contract.DriverSource is null)
                {
                    continue;
                }
                SyntaxTree driverTree = CSharpSyntaxTree.ParseText(
                    contract.DriverSource,
                    ParseOptions,
                    path: "TraceCodeDirectDriver.cs"
                );
                using var driverStream = new MemoryStream();
                EmitResult driverResult = compilation.AddSyntaxTrees(driverTree).Emit(driverStream);
                string[] driverDiagnostics = driverResult.Diagnostics
                    .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
                    .Select(FormatDiagnostic)
                    .Order(StringComparer.Ordinal)
                    .ToArray();
                if (!driverResult.Success)
                {
                    wireContracts[index] = contract with
                    {
                        DirectDriverSupported = false,
                        DirectDriverUnsupportedReasons = new[] { "generated driver did not compile" },
                    };
                    failures.Add(new CompilationFailure(
                        $"{relativePath}#{contract.Signature}",
                        driverDiagnostics
                    ));
                }
                else if (options.DriverOutputDirectory is not null)
                {
                    byte[] assemblyBytes = driverStream.ToArray();
                    string artifactId = Sha256(Encoding.UTF8.GetBytes(
                        relativePath + "\0" + contract.Signature
                    ))[..24];
                    string fileName = artifactId + ".dll";
                    await File.WriteAllBytesAsync(
                        Path.Combine(options.DriverOutputDirectory, fileName),
                        assemblyBytes
                    );
                    driverArtifacts.Add(new DriverArtifactProfile(
                        relativePath,
                        contract.Signature,
                        fileName,
                        assemblyBytes.Length,
                        Sha256(assemblyBytes)
                    ));
                }
            }
            assemblyReferences.UnionWith(inventory.AssemblyReferences);
            typeReferences.UnionWith(inventory.TypeReferences);
            memberReferences.UnionWith(inventory.MemberReferences);
            cilOpcodes.UnionWith(inventory.CilOpcodes);
            sources.Add(
                new SourceProfile(
                    relativePath,
                    sourceSha256,
                    functionName,
                    "compiled",
                    inventory.AssemblyReferences,
                    wireContracts,
                    inventory.TypeReferences.Length,
                    inventory.MemberReferences.Length,
                    inventory.CilOpcodes.Length
                )
            );
        }

        string[] deniedAssemblies = assemblyReferences
            .Where(name => IsDenied(name, config.DeniedAssemblyPrefixes, dottedBoundary: true))
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (deniedAssemblies.Length > 0)
        {
            failures.Add(
                new CompilationFailure(
                    "<profile-policy>",
                    new[] { "Denied assembly references: " + string.Join(", ", deniedAssemblies) }
                )
            );
        }
        string[] deniedTypes = typeReferences
            .Where(name => IsDenied(name, config.DeniedTypePrefixes, dottedBoundary: false))
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (deniedTypes.Length > 0)
        {
            failures.Add(new CompilationFailure(
                "<profile-policy>",
                new[] { "Denied type references: " + string.Join(", ", deniedTypes) }
            ));
        }
        string[] deniedMembers = memberReferences
            .Where(name => IsDenied(name, config.DeniedMemberPrefixes, dottedBoundary: false))
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (deniedMembers.Length > 0)
        {
            failures.Add(new CompilationFailure(
                "<profile-policy>",
                new[] { "Denied member references: " + string.Join(", ", deniedMembers) }
            ));
        }

        string[] compilerAssemblies = config.AlgorithmSurfaceAssemblies
            .Concat(config.CompilerHostAssemblies)
            .Concat(assemblyReferences)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        string[] runnerRootAssemblies = config.AlgorithmSurfaceAssemblies
            .Concat(config.RunnerHostAssemblies)
            .Concat(assemblyReferences)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        string[] algorithmRunnerRootAssemblies = config.AlgorithmRunnerHostAssemblies
            .Concat(assemblyReferences)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        string[] runtimeClosure = ReadRuntimeClosure(runtimeDirectory, runnerRootAssemblies);
        string corpusSha256 = Sha256(
            Encoding.UTF8.GetBytes(
                string.Concat(sources.Select(source => source.Path + "\0" + source.Sha256 + "\n"))
            )
        );

        string sdkVersion = GetDotnetSdkVersion();
        string runtimeVersion = GetRuntimeVersion(runtimeDirectory);
        var profile = new TraceClrProfile(
            ProfileSchema,
            config.TargetFramework,
            sdkVersion,
            runtimeVersion,
            new ProfilePolicy(
                config.DeniedAssemblyPrefixes.Order(StringComparer.Ordinal).ToArray(),
                config.DeniedTypePrefixes.Order(StringComparer.Ordinal).ToArray(),
                config.DeniedMemberPrefixes.Order(StringComparer.Ordinal).ToArray()
            ),
            new CorpusIdentity(sourcePaths.Length, sources.Count(source => source.Status == "compiled"), failures.Count, corpusSha256),
            config.GlobalUsings.Order(StringComparer.Ordinal).ToArray(),
            compilerAssemblies,
            runnerRootAssemblies,
            algorithmRunnerRootAssemblies,
            runtimeClosure,
            assemblyReferences.ToArray(),
            typeReferences.ToArray(),
            memberReferences.ToArray(),
            cilOpcodes.ToArray(),
            sources,
            failures
        );

        await WriteJsonAsync(options.OutputPath, profile);
        await WritePropsAsync(
            options.PropsOutputPath,
            compilerAssemblies,
            runnerRootAssemblies,
            algorithmRunnerRootAssemblies
        );
        if (options.DriverOutputDirectory is not null)
        {
            await WriteJsonAsync(
                Path.Combine(options.DriverOutputDirectory, "manifest.json"),
                new DriverArtifactManifest(
                    "tracecode.traceclr-driver-artifacts.v1",
                    driverArtifacts.OrderBy(artifact => artifact.SourcePath, StringComparer.Ordinal)
                        .ThenBy(artifact => artifact.Signature, StringComparer.Ordinal)
                        .ToArray()
                )
            );
            Console.WriteLine($"Direct driver artifacts: {driverArtifacts.Count} in {Path.GetFullPath(options.DriverOutputDirectory)}");
        }

        Console.WriteLine(
            $"TraceCLR profile: {profile.Corpus.CompiledSourceCount}/{profile.Corpus.SourceCount} sources compiled; "
            + $"{profile.DirectAssemblyReferences.Count} direct assemblies; "
            + $"{profile.RuntimeAssemblyClosure.Count} runtime assemblies; "
            + $"{profile.MemberReferences.Count} member references; "
            + $"{profile.CilOpcodes.Count} CIL opcodes."
        );
        Console.WriteLine($"Profile: {Path.GetFullPath(options.OutputPath)}");
        Console.WriteLine($"MSBuild props: {Path.GetFullPath(options.PropsOutputPath)}");
        if (failures.Count > 0)
        {
            foreach (CompilationFailure failure in failures.Take(20))
            {
                Console.Error.WriteLine($"{failure.Path}: {string.Join(" | ", failure.Diagnostics)}");
            }
            return 1;
        }
        return 0;
    }

    private static AssemblyInventory ReadAssemblyInventory(byte[] peBytes)
    {
        using var peReader = new PEReader(new MemoryStream(peBytes, writable: false));
        MetadataReader reader = peReader.GetMetadataReader();
        string[] assemblies = reader.AssemblyReferences
            .Select(handle => reader.GetString(reader.GetAssemblyReference(handle).Name))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        string[] types = reader.TypeReferences
            .Select(handle => TypeReferenceName(reader, handle))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        string[] members = reader.MemberReferences
            .Select(handle => MemberReferenceName(reader, handle))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var opcodes = new SortedSet<string>(StringComparer.Ordinal);
        foreach (MethodDefinitionHandle handle in reader.MethodDefinitions)
        {
            MethodDefinition definition = reader.GetMethodDefinition(handle);
            if (definition.RelativeVirtualAddress == 0)
            {
                continue;
            }
            ReadOpcodes(
                peReader.GetMethodBody(definition.RelativeVirtualAddress).GetILBytes()
                    ?? throw new BadImageFormatException("CIL method body has no bytes."),
                opcodes
            );
        }
        return new AssemblyInventory(assemblies, types, members, opcodes.ToArray());
    }

    private static WireContractProfile[] ReadWireContracts(
        CSharpCompilation compilation,
        SyntaxTree userTree,
        string? functionName
    )
    {
        SemanticModel model = compilation.GetSemanticModel(userTree);
        IMethodSymbol[] solutionMethods = userTree
            .GetRoot()
            .DescendantNodes()
            .OfType<Microsoft.CodeAnalysis.CSharp.Syntax.ClassDeclarationSyntax>()
            .Where(type => type.Identifier.ValueText == "Solution")
            .SelectMany(type => type.Members.OfType<Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax>())
            .Select(method => model.GetDeclaredSymbol(method))
            .Where(symbol =>
                symbol is not null
                && (functionName is null
                    ? symbol.DeclaredAccessibility == Accessibility.Public
                    : string.Equals(
                        symbol.Name,
                        functionName,
                        StringComparison.OrdinalIgnoreCase
                    ))
            )
            .Select(symbol => symbol!)
            .ToArray();
        if (solutionMethods.Length > 0)
        {
            return solutionMethods
                .Select(CreateWireContract)
                .GroupBy(contract => contract.Signature, StringComparer.Ordinal)
                .Select(group => group.First())
                .OrderBy(contract => contract.Signature, StringComparer.Ordinal)
                .ToArray();
        }

        Microsoft.CodeAnalysis.CSharp.Syntax.ClassDeclarationSyntax[] operationClasses = userTree
            .GetRoot()
            .DescendantNodes()
            .OfType<Microsoft.CodeAnalysis.CSharp.Syntax.ClassDeclarationSyntax>()
            .Where(type =>
                type.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.CompilationUnitSyntax
                && type.Identifier.ValueText is not ("ListNode" or "TreeNode" or "NestedInteger")
                && (functionName is null
                    ? type.Modifiers.Any(modifier => modifier.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.PublicKeyword))
                    : string.Equals(type.Identifier.ValueText, functionName, StringComparison.OrdinalIgnoreCase))
            )
            .ToArray();
        return operationClasses
            .SelectMany(type =>
                type.Members
                    .Where(member => member is Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax
                        or Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax)
                    .Select(member => model.GetDeclaredSymbol(member))
                    .OfType<IMethodSymbol>()
                    .Where(symbol => symbol.DeclaredAccessibility == Accessibility.Public)
            )
            .Select(CreateWireContract)
            .GroupBy(contract => contract.Signature, StringComparer.Ordinal)
            .Select(group => group.First())
            .OrderBy(contract => contract.Signature, StringComparer.Ordinal)
            .ToArray();
    }

    private static WireContractProfile CreateWireContract(IMethodSymbol method)
    {
        bool isConstructor = method.MethodKind == MethodKind.Constructor;
        string returnDisplay = isConstructor
            ? "void"
            : method.ReturnType.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        string signature = returnDisplay
            + " "
            + (isConstructor ? method.ContainingType.Name + ".ctor" : method.Name)
            + "("
            + string.Join(
                ", ",
                method.Parameters.Select(parameter =>
                    parameter.Type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)
                    + " "
                    + parameter.Name
                )
            )
            + ")";
        WireParameterProfile[] parameters = method.Parameters
            .Select(parameter =>
            {
                WireTypeProfile type = DescribeWireType(parameter.Type);
                return new WireParameterProfile(parameter.Name, type);
            })
            .ToArray();
        bool nullOnlyObjectReturn = !isConstructor
            && TraceClrWireDriverGenerator.IsNullOnlyObjectReturn(method);
        WireTypeProfile returnType = isConstructor
            ? new WireTypeProfile("void", "void", Array.Empty<string>())
            : nullOnlyObjectReturn
                ? new WireTypeProfile("null", returnDisplay, Array.Empty<string>())
                : DescribeWireType(method.ReturnType);
        string[] unsupported = parameters
            .SelectMany(parameter => parameter.Type.UnsupportedTypes)
            .Concat(returnType.UnsupportedTypes)
            .Concat(method.Parameters
                .Where(parameter => parameter.RefKind != RefKind.None)
                .Select(parameter => $"{parameter.RefKind.ToString().ToLowerInvariant()} parameter {parameter.Name}"))
            .Concat(method.IsGenericMethod ? new[] { "generic method" } : Array.Empty<string>())
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        bool directDriverSupported = TraceClrWireDriverGenerator.TryGenerate(
            method,
            nullOnlyObjectReturn,
            out TraceClrWireDriver? driver,
            out string[] driverUnsupportedReasons
        );
        return new WireContractProfile(
            signature,
            isConstructor ? "constructor" : "method",
            unsupported.Length == 0,
            parameters,
            returnType,
            unsupported,
            directDriverSupported,
            driverUnsupportedReasons,
            driver?.Source
        );
    }

    private static WireTypeProfile DescribeWireType(ITypeSymbol type)
    {
        TraceClrWireType described = TraceClrWireDriverGenerator.DescribeWireType(type);
        return new WireTypeProfile(
            described.WireType,
            described.CSharpType,
            described.UnsupportedTypes
        );
    }

    private static string[] ReadRuntimeClosure(string runtimeDirectory, IEnumerable<string> roots)
    {
        var assembliesByName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string path in Directory.EnumerateFiles(runtimeDirectory, "*.dll", SearchOption.TopDirectoryOnly))
        {
            try
            {
                assembliesByName[AssemblyName.GetAssemblyName(path).Name ?? Path.GetFileNameWithoutExtension(path)] = path;
            }
            catch (BadImageFormatException)
            {
                // Native support libraries are not managed runtime profile members.
            }
        }

        var seen = new SortedSet<string>(StringComparer.Ordinal);
        var pending = new Queue<string>(roots.Where(assembliesByName.ContainsKey));
        while (pending.TryDequeue(out string? assemblyName))
        {
            if (!seen.Add(assemblyName) || !assembliesByName.TryGetValue(assemblyName, out string? path))
            {
                continue;
            }
            using var peReader = new PEReader(File.OpenRead(path));
            if (!peReader.HasMetadata)
            {
                continue;
            }
            MetadataReader reader = peReader.GetMetadataReader();
            foreach (AssemblyReferenceHandle handle in reader.AssemblyReferences)
            {
                string referencedName = reader.GetString(reader.GetAssemblyReference(handle).Name);
                if (assembliesByName.ContainsKey(referencedName) && !seen.Contains(referencedName))
                {
                    pending.Enqueue(referencedName);
                }
            }
        }
        return seen.ToArray();
    }

    private static void ReadOpcodes(IReadOnlyList<byte> bytes, ISet<string> opcodes)
    {
        int offset = 0;
        while (offset < bytes.Count)
        {
            short value = bytes[offset++] == 0xfe
                ? unchecked((short)(0xfe00 | bytes[offset++]))
                : bytes[offset - 1];
            if (!OpCodesByValue.TryGetValue(value, out OpCode opCode))
            {
                throw new BadImageFormatException($"Unknown CIL opcode 0x{unchecked((ushort)value):x4}.");
            }
            opcodes.Add(opCode.Name ?? $"0x{unchecked((ushort)value):x4}");
            offset += OperandSize(opCode.OperandType, bytes, offset);
            if (offset > bytes.Count)
            {
                throw new BadImageFormatException($"CIL operand for {opCode.Name} exceeds the method body.");
            }
        }
    }

    private static int OperandSize(OperandType operandType, IReadOnlyList<byte> bytes, int offset)
    {
        return operandType switch
        {
            OperandType.InlineNone => 0,
            OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
            OperandType.InlineVar => 2,
            OperandType.InlineBrTarget or OperandType.InlineField or OperandType.InlineI
                or OperandType.InlineMethod or OperandType.InlineSig or OperandType.InlineString
                or OperandType.InlineTok or OperandType.InlineType or OperandType.ShortInlineR => 4,
            OperandType.InlineI8 or OperandType.InlineR => 8,
            OperandType.InlineSwitch => 4 + BitConverter.ToInt32(bytes.Skip(offset).Take(4).ToArray()) * 4,
            _ => throw new BadImageFormatException($"Unsupported CIL operand type {operandType}."),
        };
    }

    private static string TypeReferenceName(MetadataReader reader, TypeReferenceHandle handle)
    {
        TypeReference type = reader.GetTypeReference(handle);
        string name = reader.GetString(type.Name);
        string @namespace = reader.GetString(type.Namespace);
        if (type.ResolutionScope.Kind == HandleKind.TypeReference)
        {
            return TypeReferenceName(reader, (TypeReferenceHandle)type.ResolutionScope) + "+" + name;
        }
        return string.IsNullOrEmpty(@namespace) ? name : @namespace + "." + name;
    }

    private static string MemberReferenceName(MetadataReader reader, MemberReferenceHandle handle)
    {
        MemberReference member = reader.GetMemberReference(handle);
        string parent = member.Parent.Kind switch
        {
            HandleKind.TypeReference => TypeReferenceName(reader, (TypeReferenceHandle)member.Parent),
            HandleKind.TypeDefinition => TypeDefinitionName(reader, (TypeDefinitionHandle)member.Parent),
            HandleKind.TypeSpecification => reader
                .GetTypeSpecification((TypeSpecificationHandle)member.Parent)
                .DecodeSignature(new SignatureNameProvider(), genericContext: null),
            HandleKind.MethodDefinition => "<method-definition>",
            HandleKind.ModuleReference => reader.GetString(reader.GetModuleReference((ModuleReferenceHandle)member.Parent).Name),
            _ => "<" + member.Parent.Kind + ">",
        };
        return parent + "::" + reader.GetString(member.Name);
    }

    private static string TypeDefinitionName(MetadataReader reader, TypeDefinitionHandle handle)
    {
        TypeDefinition type = reader.GetTypeDefinition(handle);
        string name = reader.GetString(type.Name);
        string @namespace = reader.GetString(type.Namespace);
        return string.IsNullOrEmpty(@namespace) ? name : @namespace + "." + name;
    }

    private static string FormatDiagnostic(Diagnostic diagnostic)
    {
        FileLinePositionSpan span = diagnostic.Location.GetLineSpan();
        LinePosition start = span.StartLinePosition;
        string path = string.IsNullOrEmpty(span.Path) ? "<unknown>" : span.Path;
        return $"{path}:{start.Line + 1}:{start.Character + 1} {diagnostic.Id}: {diagnostic.GetMessage()}";
    }

    private static bool IsDenied(string name, IEnumerable<string> prefixes, bool dottedBoundary) =>
        prefixes.Any(prefix => name.StartsWith(prefix, StringComparison.Ordinal)
            && (!dottedBoundary
                || name.Length == prefix.Length
                || (name.Length > prefix.Length && name[prefix.Length] == '.')));

    private static string GenerateNodePreludeSource(SyntaxTree userTree)
    {
        HashSet<string> classNames = userTree
            .GetRoot()
            .DescendantNodes()
            .OfType<Microsoft.CodeAnalysis.CSharp.Syntax.ClassDeclarationSyntax>()
            .Select(type => type.Identifier.ValueText)
            .ToHashSet(StringComparer.Ordinal);
        var builder = new StringBuilder();
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

    private static string RelativePath(string root, string path) =>
        Path.GetRelativePath(root, path).Replace(Path.DirectorySeparatorChar, '/');

    private static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static string GetDotnetSdkVersion()
    {
        using var process = new System.Diagnostics.Process
        {
            StartInfo = new System.Diagnostics.ProcessStartInfo("dotnet", "--version")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
            },
        };
        process.Start();
        string version = process.StandardOutput.ReadToEnd().Trim();
        process.WaitForExit();
        return process.ExitCode == 0 && version.Length > 0 ? version : "unknown";
    }

    private static string GetRuntimeVersion(string runtimeDirectory) =>
        new DirectoryInfo(runtimeDirectory).Name;

    private static async Task<T> ReadJsonAsync<T>(string path)
    {
        await using FileStream stream = File.OpenRead(path);
        return await JsonSerializer.DeserializeAsync<T>(stream, JsonOptions())
            ?? throw new InvalidDataException($"Unable to deserialize {path}.");
    }

    private static async Task<string?> ReadFunctionNameAsync(string path)
    {
        if (!File.Exists(path))
        {
            return null;
        }
        await using FileStream stream = File.OpenRead(path);
        using JsonDocument document = await JsonDocument.ParseAsync(stream);
        if (!document.RootElement.TryGetProperty("functionName", out JsonElement value)
            || value.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(value.GetString()))
        {
            throw new InvalidDataException($"Problem metadata has no functionName: {path}");
        }
        return value.GetString()!;
    }

    private static async Task WriteJsonAsync<T>(string path, T value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        await using FileStream stream = File.Create(path);
        await JsonSerializer.SerializeAsync(stream, value, JsonOptions(writeIndented: true));
        await stream.WriteAsync("\n"u8.ToArray());
    }

    private static async Task WritePropsAsync(
        string path,
        IEnumerable<string> compilerAssemblies,
        IEnumerable<string> runnerRootAssemblies,
        IEnumerable<string> algorithmRunnerRootAssemblies
    )
    {
        var project = new XElement("Project",
            new XComment(" Generated by TraceCode.TraceClrProfile. Do not edit by hand. "),
            new XElement("ItemGroup",
                compilerAssemblies.Select(name =>
                    new XElement("TraceClrAlgorithmCompilerAssembly", new XAttribute("Include", name))
                )
            ),
            new XElement("ItemGroup",
                runnerRootAssemblies.Select(name =>
                    new XElement("TraceClrAlgorithmRunnerRootAssembly", new XAttribute("Include", name))
                )
            ),
            new XElement("ItemGroup",
                algorithmRunnerRootAssemblies.Select(name =>
                    new XElement("TraceClrMinimalRunnerRootAssembly", new XAttribute("Include", name))
                )
            )
        );
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        await File.WriteAllTextAsync(
            path,
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" + project + "\n",
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)
        );
    }

    private static JsonSerializerOptions JsonOptions(bool writeIndented = false) => new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = writeIndented,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private sealed record Options(
        string CorpusRoot,
        string ProblemDirectory,
        string ReferenceDirectory,
        string RuntimeDirectory,
        string ConfigPath,
        string OutputPath,
        string PropsOutputPath,
        string? DriverOutputDirectory
    )
    {
        public const string Usage = "Usage: dotnet run --project tools/TraceCode.TraceClrProfile -- "
            + "--corpus-root <dir> --reference-dir <dir> --runtime-dir <dir> "
            + "--problem-dir <dir> --config <json> --output <json> --props-output <props> "
            + "[--driver-output-dir <empty-dir>]";

        public static Options Parse(string[] args)
        {
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int index = 0; index < args.Length; index += 2)
            {
                if (index + 1 >= args.Length || !args[index].StartsWith("--", StringComparison.Ordinal))
                {
                    throw new ArgumentException("TraceCLR profile options must be --name value pairs.");
                }
                values.Add(args[index], args[index + 1]);
            }
            string Required(string name) => values.TryGetValue(name, out string? value) && !string.IsNullOrWhiteSpace(value)
                ? value
                : throw new ArgumentException($"Missing required option {name}.");
            return new Options(
                Required("--corpus-root"),
                Required("--problem-dir"),
                Required("--reference-dir"),
                Required("--runtime-dir"),
                Required("--config"),
                Required("--output"),
                Required("--props-output"),
                values.GetValueOrDefault("--driver-output-dir")
            );
        }
    }

    private sealed record ProfileConfig(
        string Schema,
        string TargetFramework,
        IReadOnlyList<string> GlobalUsings,
        IReadOnlyList<string> AlgorithmSurfaceAssemblies,
        IReadOnlyList<string> CompilerHostAssemblies,
        IReadOnlyList<string> RunnerHostAssemblies,
        IReadOnlyList<string> AlgorithmRunnerHostAssemblies,
        IReadOnlyList<string> DeniedAssemblyPrefixes,
        IReadOnlyList<string> DeniedTypePrefixes,
        IReadOnlyList<string> DeniedMemberPrefixes
    );

    private sealed record TraceClrProfile(
        string Schema,
        string TargetFramework,
        string DotnetSdkVersion,
        string RuntimeVersion,
        ProfilePolicy Policy,
        CorpusIdentity Corpus,
        IReadOnlyList<string> GlobalUsings,
        IReadOnlyList<string> CompilerReferenceAssemblies,
        IReadOnlyList<string> RunnerRootAssemblies,
        IReadOnlyList<string> AlgorithmRunnerRootAssemblies,
        IReadOnlyList<string> RuntimeAssemblyClosure,
        IReadOnlyList<string> DirectAssemblyReferences,
        IReadOnlyList<string> TypeReferences,
        IReadOnlyList<string> MemberReferences,
        IReadOnlyList<string> CilOpcodes,
        IReadOnlyList<SourceProfile> Sources,
        IReadOnlyList<CompilationFailure> Failures
    );

    private sealed record ProfilePolicy(
        IReadOnlyList<string> DeniedAssemblyPrefixes,
        IReadOnlyList<string> DeniedTypePrefixes,
        IReadOnlyList<string> DeniedMemberPrefixes
    );

    private sealed record CorpusIdentity(
        int SourceCount,
        int CompiledSourceCount,
        int FailureCount,
        string Sha256
    );

    private sealed record SourceProfile(
        string Path,
        string Sha256,
        string? FunctionName,
        string Status,
        IReadOnlyList<string> AssemblyReferences,
        IReadOnlyList<WireContractProfile> WireContracts,
        int TypeReferenceCount,
        int MemberReferenceCount,
        int CilOpcodeCount
    );

    private sealed record CompilationFailure(string Path, IReadOnlyList<string> Diagnostics);

    private sealed record DriverArtifactManifest(
        string Schema,
        IReadOnlyList<DriverArtifactProfile> Artifacts
    );

    private sealed record DriverArtifactProfile(
        string SourcePath,
        string Signature,
        string File,
        int Bytes,
        string Sha256
    );

    private sealed record WireContractProfile(
        string Signature,
        string Kind,
        bool Supported,
        IReadOnlyList<WireParameterProfile> Parameters,
        WireTypeProfile ReturnType,
        IReadOnlyList<string> UnsupportedTypes,
        bool DirectDriverSupported,
        IReadOnlyList<string> DirectDriverUnsupportedReasons,
        [property: JsonIgnore] string? DriverSource
    );

    private sealed record WireParameterProfile(string Name, WireTypeProfile Type);

    private sealed record WireTypeProfile(
        string WireType,
        string CSharpType,
        IReadOnlyList<string> UnsupportedTypes
    );

    private sealed record AssemblyInventory(
        string[] AssemblyReferences,
        string[] TypeReferences,
        string[] MemberReferences,
        string[] CilOpcodes
    );

    private sealed class SignatureNameProvider : ISignatureTypeProvider<string, object?>
    {
        public string GetArrayType(string elementType, ArrayShape shape) => elementType + "[" + new string(',', shape.Rank - 1) + "]";
        public string GetByReferenceType(string elementType) => elementType + "&";
        public string GetFunctionPointerType(MethodSignature<string> signature) => "fnptr";
        public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments) =>
            genericType + "<" + string.Join(",", typeArguments) + ">";
        public string GetGenericMethodParameter(object? genericContext, int index) => "!!" + index;
        public string GetGenericTypeParameter(object? genericContext, int index) => "!" + index;
        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) => unmodifiedType;
        public string GetPinnedType(string elementType) => elementType;
        public string GetPointerType(string elementType) => elementType + "*";
        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode.ToString();
        public string GetSZArrayType(string elementType) => elementType + "[]";
        public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind) =>
            TypeDefinitionName(reader, handle);
        public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind) =>
            TypeReferenceName(reader, handle);
        public string GetTypeFromSpecification(
            MetadataReader reader,
            object? genericContext,
            TypeSpecificationHandle handle,
            byte rawTypeKind
        ) => reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);
    }
}

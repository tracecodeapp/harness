using System.Globalization;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace TraceCode.TraceClrWire;

public sealed record TraceClrWireType(
    string WireType,
    string CSharpType,
    IReadOnlyList<string> UnsupportedTypes
);

public sealed record TraceClrWireDriver(
    string Source,
    TraceClrWireType[] Parameters,
    TraceClrWireType ReturnType
);

public static class TraceClrWireDriverGenerator
{
    private const int MaxBytes = 16 * 1024 * 1024;
    private const int MaxCollectionItems = 1_000_000;
    private static readonly SymbolDisplayFormat TypeFormat = SymbolDisplayFormat.FullyQualifiedFormat;

    public static TraceClrWireType DescribeWireType(ITypeSymbol type)
    {
        string display = type.ToDisplayString(TypeFormat);
        if (type is IArrayTypeSymbol array)
        {
            if (array.Rank != 1)
            {
                return Unsupported(display);
            }
            TraceClrWireType element = DescribeWireType(array.ElementType);
            return new TraceClrWireType(
                $"array<{element.WireType}>",
                display,
                element.UnsupportedTypes
            );
        }
        string? primitive = type.SpecialType switch
        {
            SpecialType.System_Void => "void",
            SpecialType.System_Boolean => "bool",
            SpecialType.System_Char => "char",
            SpecialType.System_Byte => "uint8",
            SpecialType.System_SByte => "int8",
            SpecialType.System_Int16 => "int16",
            SpecialType.System_UInt16 => "uint16",
            SpecialType.System_Int32 => "int32",
            SpecialType.System_UInt32 => "uint32",
            SpecialType.System_Int64 => "int64",
            SpecialType.System_UInt64 => "uint64",
            SpecialType.System_Single => "float32",
            SpecialType.System_Double => "float64",
            SpecialType.System_String => "string",
            _ => null,
        };
        if (primitive is not null)
        {
            return new TraceClrWireType(primitive, display, Array.Empty<string>());
        }
        if (type is INamedTypeSymbol named && named.TypeArguments.Length == 1)
        {
            string definition = named.OriginalDefinition.ToDisplayString();
            TraceClrWireType element = DescribeWireType(named.TypeArguments[0]);
            if (definition is "System.Collections.Generic.List<T>"
                or "System.Collections.Generic.IList<T>"
                or "System.Collections.Generic.IReadOnlyList<T>"
                or "System.Collections.Generic.IEnumerable<T>")
            {
                return new TraceClrWireType(
                    $"list<{element.WireType}>",
                    display,
                    element.UnsupportedTypes
                );
            }
            if (definition == "System.Collections.Generic.HashSet<T>")
            {
                return new TraceClrWireType(
                    $"set<{element.WireType}>",
                    display,
                    element.UnsupportedTypes
                );
            }
        }
        if (type.Name is "ListNode" or "TreeNode" && type.ContainingNamespace.IsGlobalNamespace)
        {
            return new TraceClrWireType(
                type.Name == "ListNode" ? "list-node<int32>" : "tree-node<int32>",
                display,
                Array.Empty<string>()
            );
        }
        return Unsupported(display);
    }

    public static bool TryGenerate(IMethodSymbol method, bool nullOnlyObjectReturn, out TraceClrWireDriver? driver, out string[] reasons)
    {
        var unsupported = new SortedSet<string>(StringComparer.Ordinal);
        if (method.MethodKind != MethodKind.Ordinary) unsupported.Add("only ordinary solution methods use the direct driver");
        if (!string.Equals(method.ContainingType.Name, "Solution", StringComparison.Ordinal)) unsupported.Add("declaring type is not Solution");
        if (method.DeclaredAccessibility != Accessibility.Public) unsupported.Add("method is not public");
        if (method.IsGenericMethod) unsupported.Add("generic method");
        if (method.IsAsync) unsupported.Add("async method");
        foreach (IParameterSymbol parameter in method.Parameters)
        {
            if (parameter.RefKind != RefKind.None) unsupported.Add($"{parameter.RefKind.ToString().ToLowerInvariant()} parameter {parameter.Name}");
            if (parameter.IsOptional || parameter.HasExplicitDefaultValue)
            {
                unsupported.Add($"optional parameter {parameter.Name} requires the compatibility runner");
            }
        }
        TraceClrWireType[] parameters = method.Parameters.Select(parameter => DescribeWireType(parameter.Type)).ToArray();
        TraceClrWireType returnType = nullOnlyObjectReturn
            ? new TraceClrWireType("null", method.ReturnType.ToDisplayString(TypeFormat), Array.Empty<string>())
            : DescribeWireType(method.ReturnType);
        foreach (string value in parameters.SelectMany(type => type.UnsupportedTypes).Concat(returnType.UnsupportedTypes))
        {
            unsupported.Add(value);
        }
        if (parameters.Append(returnType).Any(type =>
            type.WireType.Contains("list-node<", StringComparison.Ordinal)
            || type.WireType.Contains("tree-node<", StringComparison.Ordinal)))
        {
            unsupported.Add("reference-bearing node topology requires the compatibility runner");
        }
        if (ContainsDeferredEnumerable(method.ReturnType))
        {
            unsupported.Add(
                "deferred IEnumerable result requires the compatibility runner"
            );
        }
        if (returnType.WireType == "void") unsupported.Add("void mutation result");
        if (!method.IsStatic && method.ContainingType.InstanceConstructors.All(constructor =>
            constructor.Parameters.Length != 0 || constructor.DeclaredAccessibility == Accessibility.Private))
        {
            unsupported.Add("solution type has no accessible parameterless constructor");
        }
        if (unsupported.Count > 0)
        {
            driver = null;
            reasons = unsupported.ToArray();
            return false;
        }

        driver = new TraceClrWireSourceBuilder(method, parameters, returnType).Build();
        reasons = Array.Empty<string>();
        return true;
    }

    public static bool IsNullOnlyObjectReturn(IMethodSymbol method)
    {
        if (method.ReturnType.SpecialType != SpecialType.System_Object)
        {
            return false;
        }
        MethodDeclarationSyntax? declaration = method
            .DeclaringSyntaxReferences
            .Select(reference => reference.GetSyntax())
            .OfType<MethodDeclarationSyntax>()
            .SingleOrDefault();
        if (declaration is null)
        {
            return false;
        }
        ExpressionSyntax[] returnedExpressions = declaration
            .DescendantNodes()
            .OfType<ReturnStatementSyntax>()
            .Select(statement => statement.Expression)
            .Where(expression => expression is not null)
            .Select(expression => expression!)
            .Concat(declaration.ExpressionBody is null
                ? Array.Empty<ExpressionSyntax>()
                : new[] { declaration.ExpressionBody.Expression })
            .ToArray();
        return returnedExpressions.Length > 0
            && returnedExpressions.All(expression => expression.IsKind(
                SyntaxKind.NullLiteralExpression
            ));
    }

    private static TraceClrWireType Unsupported(string display) =>
        new("unsupported", display, new[] { display });

    private static bool ContainsDeferredEnumerable(ITypeSymbol type)
    {
        if (type is IArrayTypeSymbol array)
        {
            return ContainsDeferredEnumerable(array.ElementType);
        }
        if (type is not INamedTypeSymbol named)
        {
            return false;
        }
        return named.OriginalDefinition.ToDisplayString()
                == "System.Collections.Generic.IEnumerable<T>"
            || named.TypeArguments.Any(ContainsDeferredEnumerable);
    }

    private sealed class TraceClrWireSourceBuilder
    {
        private readonly IMethodSymbol method;
        private readonly TraceClrWireType[] parameters;
        private readonly TraceClrWireType returnType;
        private readonly Dictionary<string, string> readMethods = new(StringComparer.Ordinal);
        private readonly Dictionary<string, string> writeMethods = new(StringComparer.Ordinal);
        private readonly List<string> helpers = new();

        public TraceClrWireSourceBuilder(IMethodSymbol method, TraceClrWireType[] parameters, TraceClrWireType returnType)
        {
            this.method = method;
            this.parameters = parameters;
            this.returnType = returnType;
        }

        public TraceClrWireDriver Build()
        {
            string[] readers = method.Parameters.Select(parameter => ReaderFor(parameter.Type)).ToArray();
            string writer = WriterFor(method.ReturnType, returnType.WireType);
            var source = new StringBuilder();
            source.AppendLine("using System;");
            source.AppendLine("using System.Collections.Generic;");
            source.AppendLine("using System.Text;");
            source.AppendLine();
            source.AppendLine("public static class TraceCodeDriver");
            source.AppendLine("{");
            source.AppendLine("    public static byte[] Run(byte[] inputBytes, Action checkTimeout)");
            source.AppendLine("    {");
            source.AppendLine("        ArgumentNullException.ThrowIfNull(checkTimeout);");
            source.AppendLine("        var reader = new Reader(inputBytes);");
            source.AppendLine($"        reader.Begin({parameters.Length.ToString(CultureInfo.InvariantCulture)});");
            for (int index = 0; index < parameters.Length; index++)
            {
                source.AppendLine($"        {parameters[index].CSharpType} argument{index} = {readers[index]}(reader);");
            }
            source.AppendLine("        reader.Done();");
            string target = method.IsStatic
                ? method.ContainingType.ToDisplayString(TypeFormat)
                : $"new {method.ContainingType.ToDisplayString(TypeFormat)}()";
            string arguments = string.Join(", ", Enumerable.Range(0, parameters.Length).Select(index => $"argument{index}"));
            source.AppendLine($"        {returnType.CSharpType} result = {target}.{EscapeIdentifier(method.Name)}({arguments});");
            source.AppendLine("        var writer = new Writer(checkTimeout);");
            source.AppendLine("        writer.Begin();");
            source.AppendLine($"        {writer}(writer, result);");
            source.AppendLine("        return writer.Finish();");
            source.AppendLine("    }");
            source.AppendLine();
            foreach (string helper in helpers) source.AppendLine(helper);
            source.AppendLine(RuntimeSource);
            source.AppendLine("}");
            return new TraceClrWireDriver(source.ToString(), parameters, returnType);
        }

        private static string EscapeIdentifier(string value) =>
            SyntaxFacts.GetKeywordKind(value) == SyntaxKind.None ? value : "@" + value;

        private string ReaderFor(ITypeSymbol type)
        {
            string key = type.ToDisplayString(TypeFormat);
            if (readMethods.TryGetValue(key, out string? existing)) return existing;
            string name = "Read" + readMethods.Count.ToString(CultureInfo.InvariantCulture);
            readMethods[key] = name;
            helpers.Add(BuildReader(name, type));
            return name;
        }

        private string WriterFor(ITypeSymbol type, string wireType)
        {
            string key = wireType + "\0" + type.ToDisplayString(TypeFormat);
            if (writeMethods.TryGetValue(key, out string? existing)) return existing;
            string name = "Write" + writeMethods.Count.ToString(CultureInfo.InvariantCulture);
            writeMethods[key] = name;
            helpers.Add(BuildWriter(name, type, wireType));
            return name;
        }

        private string BuildReader(string name, ITypeSymbol type)
        {
            string display = type.ToDisplayString(TypeFormat);
            if (type is IArrayTypeSymbol array)
            {
                string elementReader = ReaderFor(array.ElementType);
                string arrayCreation = ArrayCreation(array);
                return $$"""
    private static {{display}} {{name}}(Reader reader)
    {
        int length = reader.Length();
        if (length < 0) return null!;
        var value = {{arrayCreation}};
        for (int index = 0; index < length; index++) value[index] = {{elementReader}}(reader);
        return value;
    }
""";
            }
            if (type is INamedTypeSymbol named && named.TypeArguments.Length == 1)
            {
                string definition = named.OriginalDefinition.ToDisplayString();
                ITypeSymbol element = named.TypeArguments[0];
                string elementReader = ReaderFor(element);
                string elementType = element.ToDisplayString(TypeFormat);
                if (definition == "System.Collections.Generic.HashSet<T>")
                {
                    return $$"""
    private static {{display}} {{name}}(Reader reader)
    {
        int length = reader.Length();
        if (length < 0) return null!;
        var value = new global::System.Collections.Generic.HashSet<{{elementType}}>();
        for (int index = 0; index < length; index++) value.Add({{elementReader}}(reader));
        return value;
    }
""";
                }
                if (definition is "System.Collections.Generic.List<T>"
                    or "System.Collections.Generic.IList<T>"
                    or "System.Collections.Generic.IReadOnlyList<T>"
                    or "System.Collections.Generic.IEnumerable<T>")
                {
                    return $$"""
    private static {{display}} {{name}}(Reader reader)
    {
        int length = reader.Length();
        if (length < 0) return null!;
        var value = new global::System.Collections.Generic.List<{{elementType}}>(length);
        for (int index = 0; index < length; index++) value.Add({{elementReader}}(reader));
        return value;
    }
""";
                }
            }
            if (type.Name == "ListNode" && type.ContainingNamespace.IsGlobalNamespace)
            {
                return $$"""
    private static global::ListNode {{name}}(Reader reader)
    {
        int length = reader.Length();
        if (length < 0) return null!;
        global::ListNode? head = null;
        global::ListNode? tail = null;
        for (int index = 0; index < length; index++)
        {
            var node = new global::ListNode(reader.Int32());
            if (head is null) head = node; else tail!.next = node;
            tail = node;
        }
        return head!;
    }
""";
            }
            if (type.Name == "TreeNode" && type.ContainingNamespace.IsGlobalNamespace)
            {
                return $$"""
    private static global::TreeNode {{name}}(Reader reader)
    {
        int length = reader.Length();
        if (length < 0) return null!;
        if (length == 0) return null!;
        var nodes = new global::TreeNode?[length];
        for (int index = 0; index < length; index++) nodes[index] = reader.Byte() == 0 ? null : new global::TreeNode(reader.Int32());
        if (nodes[0] is null) return null!;
        int child = 1;
        for (int parent = 0; parent < length && child < length; parent++)
        {
            if (nodes[parent] is null) continue;
            nodes[parent]!.left = nodes[child++];
            if (child < length) nodes[parent]!.right = nodes[child++];
        }
        return nodes[0]!;
    }
""";
            }
            string expression = DescribeWireType(type).WireType switch
            {
                "bool" => "reader.Bool()",
                "char" => "reader.Char()",
                "uint8" => "reader.Byte()",
                "int8" => "reader.SByte()",
                "int16" => "reader.Int16()",
                "uint16" => "reader.UInt16()",
                "int32" => "reader.Int32()",
                "uint32" => "reader.UInt32()",
                "int64" => "reader.Int64()",
                "uint64" => "reader.UInt64()",
                "float32" => "reader.Single()",
                "float64" => "reader.Double()",
                "string" => "reader.String()!",
                _ => throw new InvalidOperationException($"Cannot generate TraceCLR reader for {display}."),
            };
            return $"    private static {display} {name}(Reader reader) => {expression};\n";
        }

        private static string ArrayCreation(IArrayTypeSymbol array)
        {
            int nestedRanks = 0;
            ITypeSymbol element = array.ElementType;
            while (element is IArrayTypeSymbol nested)
            {
                nestedRanks++;
                element = nested.ElementType;
            }
            return "new "
                + element.ToDisplayString(TypeFormat)
                + "[length]"
                + string.Concat(Enumerable.Repeat("[]", nestedRanks));
        }

        private string BuildWriter(string name, ITypeSymbol type, string wireType)
        {
            string display = type.ToDisplayString(TypeFormat);
            if (wireType == "null")
            {
                return $"    private static void {name}(Writer writer, {display} value) {{ if (value is not null) throw new InvalidOperationException(\"Expected null result.\"); writer.Byte(0); }}\n";
            }
            if (type is IArrayTypeSymbol array)
            {
                string elementWriter = WriterFor(array.ElementType, DescribeWireType(array.ElementType).WireType);
                return $$"""
    private static void {{name}}(Writer writer, {{display}} value)
    {
        if (value is null) { writer.Int32(-1); return; }
        writer.Length(value.Length);
        int index = 0;
        foreach (var item in value)
        {
            if ((index++ & 1023) == 0) writer.CheckTimeout();
            {{elementWriter}}(writer, item);
        }
    }
""";
            }
            if (type is INamedTypeSymbol named && named.TypeArguments.Length == 1)
            {
                string definition = named.OriginalDefinition.ToDisplayString();
                ITypeSymbol element = named.TypeArguments[0];
                string elementWriter = WriterFor(element, DescribeWireType(element).WireType);
                if (definition is "System.Collections.Generic.List<T>"
                    or "System.Collections.Generic.IList<T>"
                    or "System.Collections.Generic.IReadOnlyList<T>"
                    or "System.Collections.Generic.HashSet<T>")
                {
                    return $$"""
    private static void {{name}}(Writer writer, {{display}} value)
    {
        if (value is null) { writer.Int32(-1); return; }
        writer.Length(value.Count);
        int index = 0;
        foreach (var item in value)
        {
            if ((index++ & 1023) == 0) writer.CheckTimeout();
            {{elementWriter}}(writer, item);
        }
    }
""";
                }
            }
            if (type.Name == "ListNode" && type.ContainingNamespace.IsGlobalNamespace)
            {
                return $$"""
    private static void {{name}}(Writer writer, global::ListNode value)
    {
        if (value is null) { writer.Int32(-1); return; }
        var values = new global::System.Collections.Generic.List<int>();
        var seen = new global::System.Collections.Generic.HashSet<global::ListNode>();
        for (global::ListNode? node = value; node is not null; node = node.next)
        {
            if (!seen.Add(node)) throw new InvalidOperationException("ListNode result is cyclic.");
            values.Add(node.val);
            if (values.Count > {{MaxCollectionItems}}) throw new InvalidOperationException("ListNode result is too long.");
        }
        writer.Length(values.Count);
        foreach (int item in values) writer.Int32(item);
    }
""";
            }
            if (type.Name == "TreeNode" && type.ContainingNamespace.IsGlobalNamespace)
            {
                return $$"""
    private static void {{name}}(Writer writer, global::TreeNode value)
    {
        if (value is null) { writer.Int32(-1); return; }
        var nodes = new global::System.Collections.Generic.List<global::TreeNode?> { value };
        for (int index = 0; index < nodes.Count; index++)
        {
            global::TreeNode? node = nodes[index];
            if (node is null) continue;
            nodes.Add(node.left);
            nodes.Add(node.right);
            if (nodes.Count > {{MaxCollectionItems}}) throw new InvalidOperationException("TreeNode result is too large.");
        }
        while (nodes.Count > 0 && nodes[^1] is null) nodes.RemoveAt(nodes.Count - 1);
        writer.Length(nodes.Count);
        foreach (global::TreeNode? node in nodes)
        {
            writer.Byte(node is null ? (byte)0 : (byte)1);
            if (node is not null) writer.Int32(node.val);
        }
    }
""";
            }
            string statement = wireType switch
            {
                "bool" => "writer.Bool(value);",
                "char" => "writer.Char(value);",
                "uint8" => "writer.Byte(value);",
                "int8" => "writer.SByte(value);",
                "int16" => "writer.Int16(value);",
                "uint16" => "writer.UInt16(value);",
                "int32" => "writer.Int32(value);",
                "uint32" => "writer.UInt32(value);",
                "int64" => "writer.Int64(value);",
                "uint64" => "writer.UInt64(value);",
                "float32" => "writer.Single(value);",
                "float64" => "writer.Double(value);",
                "string" => "writer.String(value);",
                _ => throw new InvalidOperationException($"Cannot generate TraceCLR writer for {display}."),
            };
            return $"    private static void {name}(Writer writer, {display} value) => {statement}\n";
        }

        private static readonly string RuntimeSource = $$"""
    private sealed class Reader
    {
        private readonly byte[] bytes;
        private int offset;
        public Reader(byte[] bytes) { this.bytes = bytes ?? throw new ArgumentNullException(nameof(bytes)); if (bytes.Length > {{MaxBytes}}) throw new InvalidOperationException("TraceCLR input is too large."); }
        public void Begin(int parameters) { if (UInt32() != 0x31574354u) throw new InvalidOperationException("TraceCLR wire magic/version mismatch."); if (UInt16() != parameters) throw new InvalidOperationException("TraceCLR parameter count mismatch."); }
        public void Done() { if (offset != bytes.Length) throw new InvalidOperationException("TraceCLR input has trailing bytes."); }
        private void Need(int count) { if (count < 0 || offset > bytes.Length - count) throw new InvalidOperationException("TraceCLR input ended unexpectedly."); }
        public byte Byte() { Need(1); return bytes[offset++]; }
        public sbyte SByte() => unchecked((sbyte)Byte());
        public ushort UInt16() { Need(2); uint value = (uint)(bytes[offset] | bytes[offset + 1] << 8); offset += 2; return (ushort)value; }
        public short Int16() => unchecked((short)UInt16());
        public uint UInt32() { Need(4); uint value = (uint)(bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24); offset += 4; return value; }
        public int Int32() => unchecked((int)UInt32());
        public ulong UInt64() { ulong low = UInt32(); return low | ((ulong)UInt32() << 32); }
        public long Int64() => unchecked((long)UInt64());
        public float Single() => BitConverter.Int32BitsToSingle(Int32());
        public double Double() => BitConverter.Int64BitsToDouble(Int64());
        public bool Bool() { byte value = Byte(); return value switch { 0 => false, 1 => true, _ => throw new InvalidOperationException("Invalid TraceCLR bool.") }; }
        public char Char() => (char)UInt16();
        public int Length() { int value = Int32(); if (value < -1 || value > {{MaxCollectionItems}}) throw new InvalidOperationException("Invalid TraceCLR collection length."); return value; }
        public string? String() { int length = Int32(); if (length == -1) return null; if (length < 0 || length > {{MaxBytes}}) throw new InvalidOperationException("Invalid TraceCLR string length."); Need(length); string value = new UTF8Encoding(false, true).GetString(bytes, offset, length); offset += length; return value; }
    }

    private sealed class Writer
    {
        private readonly Action checkTimeout;
        private byte[] bytes = new byte[256];
        private int length;
        public Writer(Action checkTimeout) { this.checkTimeout = checkTimeout; }
        public void CheckTimeout() => checkTimeout();
        private void Reserve(int count) { if (count < 0 || length > {{MaxBytes}} - count) throw new InvalidOperationException("TraceCLR output is too large."); int needed = length + count; if (needed <= bytes.Length) return; int capacity = bytes.Length; while (capacity < needed) capacity = Math.Min({{MaxBytes}}, capacity * 2); Array.Resize(ref bytes, capacity); }
        public void Begin() => UInt32(0x31574354u);
        public byte[] Finish() { Array.Resize(ref bytes, length); return bytes; }
        public void Byte(byte value) { Reserve(1); bytes[length++] = value; }
        public void SByte(sbyte value) => Byte(unchecked((byte)value));
        public void UInt16(ushort value) { Reserve(2); bytes[length++] = (byte)value; bytes[length++] = (byte)(value >> 8); }
        public void Int16(short value) => UInt16(unchecked((ushort)value));
        public void UInt32(uint value) { Reserve(4); bytes[length++] = (byte)value; bytes[length++] = (byte)(value >> 8); bytes[length++] = (byte)(value >> 16); bytes[length++] = (byte)(value >> 24); }
        public void Int32(int value) => UInt32(unchecked((uint)value));
        public void UInt64(ulong value) { UInt32((uint)value); UInt32((uint)(value >> 32)); }
        public void Int64(long value) => UInt64(unchecked((ulong)value));
        public void Single(float value) => Int32(BitConverter.SingleToInt32Bits(value));
        public void Double(double value) => Int64(BitConverter.DoubleToInt64Bits(value));
        public void Bool(bool value) => Byte(value ? (byte)1 : (byte)0);
        public void Char(char value) => UInt16(value);
        public void Length(int value) { if (value < 0 || value > {{MaxCollectionItems}}) throw new InvalidOperationException("Invalid TraceCLR collection length."); Int32(value); }
        public void String(string? value) { if (value is null) { Int32(-1); return; } byte[] encoded = new UTF8Encoding(false, true).GetBytes(value); Int32(encoded.Length); Reserve(encoded.Length); Array.Copy(encoded, 0, bytes, length, encoded.Length); length += encoded.Length; }
    }
""";
    }
}

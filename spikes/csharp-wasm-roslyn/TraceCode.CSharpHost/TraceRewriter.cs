using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using System.Text.RegularExpressions;

namespace TraceCode.CSharpHost;

public sealed class TraceRewriter : CSharpSyntaxRewriter
{
    private readonly Stack<string> methodNames = new();
    private readonly Stack<string> methodReturnTypes = new();
    private readonly Stack<HashSet<string>> variableScopes = new();
    private readonly Stack<HashSet<string>> declaredLocalVariables = new();
    private readonly Stack<HashSet<string>> stringBuilderScopes = new();
    private readonly HashSet<string> collectionVariables = new(StringComparer.Ordinal);
    private readonly HashSet<string> interfaceDispatchedCollectionVariables = new(StringComparer.Ordinal);
    private readonly HashSet<string> collectionParameterVariables = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (string TypeName, string TypeArguments)> collectionVariableTypes = new(StringComparer.Ordinal);
    private readonly HashSet<string> memberNames;
    private readonly HashSet<string> memberCollectionNames;
    private readonly HashSet<string> memberStringBuilderNames;
    private readonly SourceText originalSourceText;
    private readonly bool emitTraceEvents;
    private int returnValueCounter;
    private int exceptionValueCounter;
    private int conditionValueCounter;

    private TraceRewriter(
        bool emitTraceEvents,
        IEnumerable<string> memberNames,
        IEnumerable<string> memberCollectionNames,
        IEnumerable<string> memberStringBuilderNames,
        SourceText originalSourceText)
    {
        this.emitTraceEvents = emitTraceEvents;
        this.memberNames = memberNames.ToHashSet(StringComparer.Ordinal);
        this.memberCollectionNames = memberCollectionNames.ToHashSet(StringComparer.Ordinal);
        this.memberStringBuilderNames = memberStringBuilderNames.ToHashSet(StringComparer.Ordinal);
        this.originalSourceText = originalSourceText;
    }

    public static SyntaxTree Instrument(SyntaxTree userTree, bool emitTraceEvents)
    {
        CompilationUnitSyntax root = userTree.GetCompilationUnitRoot();
        var rewriter = new TraceRewriter(
            emitTraceEvents,
            GetDeclaredMemberNames(root),
            GetDeclaredCollectionMemberNames(root),
            GetDeclaredStringBuilderMemberNames(root),
            userTree.GetText()
        );
        var rewritten = (CompilationUnitSyntax)rewriter.Visit(root)!;
        return CSharpSyntaxTree.Create(
            rewritten,
            (CSharpParseOptions)userTree.Options,
            path: userTree.FilePath
        );
    }

    private static IEnumerable<string> GetDeclaredMemberNames(CompilationUnitSyntax root)
    {
        foreach (FieldDeclarationSyntax field in root.DescendantNodes().OfType<FieldDeclarationSyntax>())
        {
            foreach (VariableDeclaratorSyntax variable in field.Declaration.Variables)
            {
                yield return variable.Identifier.ValueText;
            }
        }

        foreach (PropertyDeclarationSyntax property in root.DescendantNodes().OfType<PropertyDeclarationSyntax>())
        {
            yield return property.Identifier.ValueText;
        }
    }

    private static IEnumerable<string> GetDeclaredCollectionMemberNames(CompilationUnitSyntax root)
    {
        foreach (FieldDeclarationSyntax field in root.DescendantNodes().OfType<FieldDeclarationSyntax>())
        {
            if (TryGetGenericType(field.Declaration.Type, out string typeName, out _)
                && IsSupportedCollectionType(typeName))
            {
                foreach (VariableDeclaratorSyntax variable in field.Declaration.Variables)
                {
                    yield return variable.Identifier.ValueText;
                }
            }
        }

        foreach (PropertyDeclarationSyntax property in root.DescendantNodes().OfType<PropertyDeclarationSyntax>())
        {
            if (TryGetGenericType(property.Type, out string typeName, out _)
                && IsSupportedCollectionType(typeName))
            {
                yield return property.Identifier.ValueText;
            }
        }
    }

    private static IEnumerable<string> GetDeclaredStringBuilderMemberNames(CompilationUnitSyntax root)
    {
        foreach (FieldDeclarationSyntax field in root.DescendantNodes().OfType<FieldDeclarationSyntax>())
        {
            if (!IsStringBuilderType(field.Declaration.Type))
            {
                continue;
            }

            foreach (VariableDeclaratorSyntax variable in field.Declaration.Variables)
            {
                yield return variable.Identifier.ValueText;
            }
        }

        foreach (PropertyDeclarationSyntax property in root.DescendantNodes().OfType<PropertyDeclarationSyntax>())
        {
            if (IsStringBuilderType(property.Type))
            {
                yield return property.Identifier.ValueText;
            }
        }
    }

    public override SyntaxNode? VisitMethodDeclaration(MethodDeclarationSyntax node)
    {
        if (node.Body is null && node.ExpressionBody is null)
        {
            return base.VisitMethodDeclaration(node);
        }

        MethodDeclarationSyntax methodNode = ConvertExpressionBodiedMethod(node);

        methodNames.Push(methodNode.Identifier.ValueText);
        methodReturnTypes.Push(methodNode.ReturnType.ToString());
        variableScopes.Push(new HashSet<string>(
            methodNode.ParameterList.Parameters.Select(parameter => parameter.Identifier.ValueText),
            StringComparer.Ordinal
        ));
        declaredLocalVariables.Push(new HashSet<string>(
            methodNode.ParameterList.Parameters.Select(parameter => parameter.Identifier.ValueText),
            StringComparer.Ordinal
        ));
        stringBuilderScopes.Push(GetStringBuilderParameterNames(methodNode).ToHashSet(StringComparer.Ordinal));
        List<string> collectionParameters = GetCollectionParameterNames(methodNode).ToList();
        foreach (string collectionParameter in collectionParameters)
        {
            collectionParameterVariables.Add(collectionParameter);
        }
        HashSet<string> collectionVariablesBeforeMethod = collectionVariables.ToHashSet(StringComparer.Ordinal);
        HashSet<string> interfaceDispatchedCollectionVariablesBeforeMethod = interfaceDispatchedCollectionVariables.ToHashSet(StringComparer.Ordinal);

        MethodDeclarationSyntax rewritten;
        try
        {
            rewritten = (MethodDeclarationSyntax)base.VisitMethodDeclaration(methodNode)!;
        }
        finally
        {
            foreach (string collectionParameter in collectionParameters)
            {
                collectionParameterVariables.Remove(collectionParameter);
            }
            collectionVariables.Clear();
            foreach (string collectionVariable in collectionVariablesBeforeMethod)
            {
                collectionVariables.Add(collectionVariable);
            }
            interfaceDispatchedCollectionVariables.Clear();
            foreach (string collectionVariable in interfaceDispatchedCollectionVariablesBeforeMethod)
            {
                interfaceDispatchedCollectionVariables.Add(collectionVariable);
            }
            declaredLocalVariables.Pop();
            variableScopes.Pop();
            stringBuilderScopes.Pop();
            methodReturnTypes.Pop();
            methodNames.Pop();
        }

        if (!emitTraceEvents)
        {
            return rewritten;
        }

        int line = GetLine(node);
        string arguments = string.Join(
            ", ",
            methodNode.ParameterList.Parameters.Select(parameter => parameter.Identifier.ValueText)
        );
        StatementSyntax callStatement = TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Call({Literal(node.Identifier.ValueText)}, {line}, new object?[] {{ {arguments} }});"
        );

        SyntaxList<StatementSyntax> statements = rewritten.Body!.Statements.Insert(0, callStatement);
        if (IsVoidReturnType(rewritten.ReturnType))
        {
            statements = statements
                .Add(CreateImplicitReturnStatement(node.Identifier.ValueText, line))
                .Add(CreateLeaveStatement(node.Identifier.ValueText));
        }

        return rewritten.WithBody(rewritten.Body.WithStatements(statements));
    }

    public override SyntaxNode? VisitConstructorDeclaration(ConstructorDeclarationSyntax node)
    {
        if (node.Body is null)
        {
            return base.VisitConstructorDeclaration(node);
        }

        if (IsTrivialDataConstructor(node))
        {
            return node;
        }

        methodNames.Push(node.Identifier.ValueText);
        variableScopes.Push(new HashSet<string>(
            node.ParameterList.Parameters.Select(parameter => parameter.Identifier.ValueText),
            StringComparer.Ordinal
        ));
        declaredLocalVariables.Push(new HashSet<string>(
            node.ParameterList.Parameters.Select(parameter => parameter.Identifier.ValueText),
            StringComparer.Ordinal
        ));
        stringBuilderScopes.Push(GetStringBuilderParameterNames(node).ToHashSet(StringComparer.Ordinal));

        ConstructorDeclarationSyntax rewritten;
        try
        {
            rewritten = (ConstructorDeclarationSyntax)base.VisitConstructorDeclaration(node)!;
        }
        finally
        {
            declaredLocalVariables.Pop();
            variableScopes.Pop();
            stringBuilderScopes.Pop();
            methodNames.Pop();
        }

        if (!emitTraceEvents)
        {
            return rewritten;
        }

        int line = GetLine(node);
        string arguments = string.Join(
            ", ",
            node.ParameterList.Parameters.Select(parameter => parameter.Identifier.ValueText)
        );
        StatementSyntax callStatement = TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Call({Literal(node.Identifier.ValueText)}, {line}, new object?[] {{ {arguments} }});"
        );

        SyntaxList<StatementSyntax> statements = rewritten.Body!.Statements
            .Insert(0, callStatement)
            .Add(CreateImplicitReturnStatement(node.Identifier.ValueText, line))
            .Add(CreateLeaveStatement(node.Identifier.ValueText));
        return rewritten.WithBody(rewritten.Body.WithStatements(statements));
    }

    public override SyntaxNode? VisitLocalFunctionStatement(LocalFunctionStatementSyntax node)
    {
        if (node.Body is null)
        {
            return base.VisitLocalFunctionStatement(node);
        }

        LocalFunctionStatementSyntax localFunctionNode = node;

        methodNames.Push(localFunctionNode.Identifier.ValueText);
        methodReturnTypes.Push(localFunctionNode.ReturnType.ToString());
        variableScopes.Push(new HashSet<string>(
            localFunctionNode.ParameterList.Parameters.Select(parameter => parameter.Identifier.ValueText),
            StringComparer.Ordinal
        ));
        declaredLocalVariables.Push(new HashSet<string>(
            localFunctionNode.ParameterList.Parameters.Select(parameter => parameter.Identifier.ValueText),
            StringComparer.Ordinal
        ));
        stringBuilderScopes.Push(GetStringBuilderParameterNames(localFunctionNode).ToHashSet(StringComparer.Ordinal));
        List<string> collectionParameters = GetCollectionParameterNames(localFunctionNode).ToList();
        foreach (string collectionParameter in collectionParameters)
        {
            collectionParameterVariables.Add(collectionParameter);
        }

        LocalFunctionStatementSyntax rewritten;
        try
        {
            rewritten = (LocalFunctionStatementSyntax)base.VisitLocalFunctionStatement(localFunctionNode)!;
        }
        finally
        {
            foreach (string collectionParameter in collectionParameters)
            {
                collectionParameterVariables.Remove(collectionParameter);
            }
            declaredLocalVariables.Pop();
            variableScopes.Pop();
            stringBuilderScopes.Pop();
            methodReturnTypes.Pop();
            methodNames.Pop();
        }

        if (!emitTraceEvents)
        {
            return rewritten;
        }

        int line = GetLine(node);
        string arguments = string.Join(
            ", ",
            localFunctionNode.ParameterList.Parameters.Select(parameter => parameter.Identifier.ValueText)
        );
        StatementSyntax callStatement = TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Call({Literal(localFunctionNode.Identifier.ValueText)}, {line}, new object?[] {{ {arguments} }});"
        );

        SyntaxList<StatementSyntax> statements = rewritten.Body!.Statements.Insert(0, callStatement);
        if (IsVoidReturnType(rewritten.ReturnType))
        {
            statements = statements
                .Add(CreateImplicitReturnStatement(localFunctionNode.Identifier.ValueText, line))
                .Add(CreateLeaveStatement(localFunctionNode.Identifier.ValueText));
        }

        return rewritten.WithBody(rewritten.Body.WithStatements(statements));
    }

    public override SyntaxNode? VisitParenthesizedLambdaExpression(ParenthesizedLambdaExpressionSyntax node)
    {
        if (!emitTraceEvents || IsExpressionTreeLambda(node))
        {
            return node;
        }

        string functionName = GetAnonymousFunctionName(node);
        List<ParameterSyntax> parameters = node.ParameterList.Parameters.ToList();
        List<string> collectionParameters = PushAnonymousFunctionContext(functionName, parameters);

        CSharpSyntaxNode rewrittenBody;
        try
        {
            rewrittenBody = (CSharpSyntaxNode)Visit(node.Body)!;
        }
        finally
        {
            PopAnonymousFunctionContext(collectionParameters);
        }

        if (rewrittenBody is BlockSyntax block)
        {
            return node.WithBody(AddAnonymousFunctionTraceStatements(block, functionName, parameters, GetLine(node)));
        }

        return rewrittenBody is ExpressionSyntax expression
            ? node.WithBody(AddExpressionBodiedAnonymousFunctionTraceBlock(
                expression,
                functionName,
                parameters,
                GetLine(node),
                IsVoidReturningLambda(node)))
            : node;
    }

    public override SyntaxNode? VisitSimpleLambdaExpression(SimpleLambdaExpressionSyntax node)
    {
        if (!emitTraceEvents || IsExpressionTreeLambda(node))
        {
            return node;
        }

        string functionName = GetAnonymousFunctionName(node);
        var parameters = new List<ParameterSyntax> { node.Parameter };
        List<string> collectionParameters = PushAnonymousFunctionContext(functionName, parameters);

        CSharpSyntaxNode rewrittenBody;
        try
        {
            rewrittenBody = (CSharpSyntaxNode)Visit(node.Body)!;
        }
        finally
        {
            PopAnonymousFunctionContext(collectionParameters);
        }

        if (rewrittenBody is BlockSyntax block)
        {
            return node.WithBody(AddAnonymousFunctionTraceStatements(block, functionName, parameters, GetLine(node)));
        }

        return rewrittenBody is ExpressionSyntax expression
            ? node.WithBody(AddExpressionBodiedAnonymousFunctionTraceBlock(
                expression,
                functionName,
                parameters,
                GetLine(node),
                IsVoidReturningLambda(node)))
            : node;
    }

    public override SyntaxNode? VisitAnonymousMethodExpression(AnonymousMethodExpressionSyntax node)
    {
        if (!emitTraceEvents)
        {
            return node;
        }

        string functionName = GetAnonymousFunctionName(node);
        List<ParameterSyntax> parameters = node.ParameterList?.Parameters.ToList() ?? new List<ParameterSyntax>();
        List<string> collectionParameters = PushAnonymousFunctionContext(functionName, parameters);

        AnonymousMethodExpressionSyntax rewritten;
        try
        {
            rewritten = (AnonymousMethodExpressionSyntax)base.VisitAnonymousMethodExpression(node)!;
        }
        finally
        {
            PopAnonymousFunctionContext(collectionParameters);
        }

        return rewritten.WithBlock(AddAnonymousFunctionTraceStatements(rewritten.Block, functionName, parameters, GetLine(node)));
    }

    private List<string> PushAnonymousFunctionContext(string functionName, IReadOnlyList<ParameterSyntax> parameters)
    {
        List<string> parameterNames = GetTraceableParameterNames(parameters).ToList();
        methodNames.Push(functionName);
        methodReturnTypes.Push("var");
        variableScopes.Push(new HashSet<string>(parameterNames, StringComparer.Ordinal));
        declaredLocalVariables.Push(new HashSet<string>(parameterNames, StringComparer.Ordinal));
        stringBuilderScopes.Push(GetStringBuilderParameterNames(parameters).ToHashSet(StringComparer.Ordinal));

        List<string> collectionParameters = GetCollectionParameterNames(parameters).ToList();
        foreach (string collectionParameter in collectionParameters)
        {
            collectionParameterVariables.Add(collectionParameter);
        }

        return collectionParameters;
    }

    private void PopAnonymousFunctionContext(IEnumerable<string> collectionParameters)
    {
        foreach (string collectionParameter in collectionParameters)
        {
            collectionParameterVariables.Remove(collectionParameter);
        }

        declaredLocalVariables.Pop();
        variableScopes.Pop();
        stringBuilderScopes.Pop();
        methodReturnTypes.Pop();
        methodNames.Pop();
    }

    private static BlockSyntax AddAnonymousFunctionTraceStatements(
        BlockSyntax block,
        string functionName,
        IReadOnlyList<ParameterSyntax> parameters,
        int line)
    {
        string arguments = string.Join(", ", GetTraceableCallParameterNames(parameters));
        StatementSyntax callStatement = TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Call({Literal(functionName)}, {line}, new object?[] {{ {arguments} }});"
        );

        SyntaxList<StatementSyntax> statements = block.Statements
            .Insert(0, callStatement)
            .Add(CreateImplicitReturnStatement(functionName, line))
            .Add(CreateLeaveStatement(functionName));
        return block.WithStatements(statements);
    }

    private BlockSyntax AddExpressionBodiedAnonymousFunctionTraceBlock(
        ExpressionSyntax expression,
        string functionName,
        IReadOnlyList<ParameterSyntax> parameters,
        int line,
        bool returnsVoid)
    {
        string arguments = string.Join(", ", GetTraceableCallParameterNames(parameters));
        var statements = new List<StatementSyntax>
        {
            TraceStatement(
                $"TraceCode.Internal.TraceCodeTrace.Call({Literal(functionName)}, {line}, new object?[] {{ {arguments} }});"
            ),
        };

        if (returnsVoid)
        {
            statements.Add(SyntaxFactory.ExpressionStatement(expression));
            statements.Add(CreateImplicitReturnStatement(functionName, line));
            statements.Add(CreateLeaveStatement(functionName));
            return SyntaxFactory.Block(statements);
        }

        string tempName = $"__tracecode_lambda_return_{returnValueCounter++}";
        statements.Add(TraceStatement($"var {tempName} = {expression};"));
        statements.Add(TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Return({Literal(functionName)}, {line}, {tempName});"
        ));
        statements.Add(CreateLeaveStatement(functionName));
        statements.Add(TraceStatement($"return {tempName};"));
        return SyntaxFactory.Block(statements);
    }

    private static string GetAnonymousFunctionName(AnonymousFunctionExpressionSyntax node)
    {
        if (node.Parent is EqualsValueClauseSyntax { Parent: VariableDeclaratorSyntax variable })
        {
            return variable.Identifier.ValueText;
        }

        if (node.Parent is AssignmentExpressionSyntax assignment
            && assignment.Right == node)
        {
            if (assignment.Left is IdentifierNameSyntax identifier)
            {
                return identifier.Identifier.ValueText;
            }

            if (assignment.Left is MemberAccessExpressionSyntax memberAccess)
            {
                return memberAccess.Name.Identifier.ValueText;
            }
        }

        string kind = node is AnonymousMethodExpressionSyntax ? "anonymous" : "lambda";
        return $"<{kind}:{GetLine(node)}>";
    }

    private static bool IsExpressionTreeLambda(AnonymousFunctionExpressionSyntax node)
    {
        TypeSyntax? targetType = GetLambdaTargetType(node);
        if (targetType is null)
        {
            return false;
        }

        string normalized = targetType.ToString().Replace(" ", string.Empty, StringComparison.Ordinal);
        return normalized.StartsWith("Expression<", StringComparison.Ordinal)
            || normalized.StartsWith("System.Linq.Expressions.Expression<", StringComparison.Ordinal);
    }

    private static bool IsVoidReturningLambda(AnonymousFunctionExpressionSyntax node)
    {
        TypeSyntax? targetType = GetLambdaTargetType(node);
        return targetType is not null && IsActionType(targetType);
    }

    private static TypeSyntax? GetLambdaTargetType(AnonymousFunctionExpressionSyntax node)
    {
        if (node.Parent is EqualsValueClauseSyntax { Parent: VariableDeclaratorSyntax { Parent: VariableDeclarationSyntax declaration } })
        {
            return declaration.Type;
        }

        if (node.Parent is AssignmentExpressionSyntax assignment
            && assignment.Left is DeclarationExpressionSyntax declarationExpression)
        {
            return declarationExpression.Type;
        }

        if (node.Parent is CastExpressionSyntax cast)
        {
            return cast.Type;
        }

        if (node.Parent is ParenthesizedExpressionSyntax { Parent: CastExpressionSyntax parenthesizedCast })
        {
            return parenthesizedCast.Type;
        }

        return null;
    }

    private static bool IsActionType(TypeSyntax type)
    {
        if (type is IdentifierNameSyntax identifier)
        {
            return identifier.Identifier.ValueText == "Action";
        }

        if (type is GenericNameSyntax generic)
        {
            return generic.Identifier.ValueText == "Action";
        }

        if (type is QualifiedNameSyntax qualified)
        {
            return IsActionType(qualified.Right);
        }

        if (type is AliasQualifiedNameSyntax aliasQualified)
        {
            return IsActionType(aliasQualified.Name);
        }

        return false;
    }

    private static IEnumerable<string> GetTraceableParameterNames(IEnumerable<ParameterSyntax> parameters)
    {
        return parameters
            .Select(parameter => parameter.Identifier.ValueText)
            .Where(name => !string.IsNullOrWhiteSpace(name) && !string.Equals(name, "_", StringComparison.Ordinal))
            .Distinct(StringComparer.Ordinal);
    }

    private static IEnumerable<string> GetTraceableCallParameterNames(IEnumerable<ParameterSyntax> parameters)
    {
        return parameters
            .Where(parameter => !parameter.Modifiers.Any(SyntaxKind.OutKeyword))
            .Select(parameter => parameter.Identifier.ValueText)
            .Where(name => !string.IsNullOrWhiteSpace(name) && !string.Equals(name, "_", StringComparison.Ordinal))
            .Distinct(StringComparer.Ordinal);
    }

    private static IEnumerable<string> GetDeclarationExpressionVariableNames(ExpressionSyntax expression)
    {
        if (expression is not DeclarationExpressionSyntax declaration)
        {
            yield break;
        }

        foreach (string name in GetVariableDesignationNames(declaration.Designation))
        {
            yield return name;
        }
    }

    private static bool IsDeconstructionAssignmentLeft(ExpressionSyntax expression)
    {
        return expression is DeclarationExpressionSyntax
            || expression is TupleExpressionSyntax;
    }

    private static IEnumerable<string> GetDeconstructionDeclarationNames(ExpressionSyntax expression)
    {
        if (expression is DeclarationExpressionSyntax declaration)
        {
            foreach (string name in GetVariableDesignationNames(declaration.Designation))
            {
                yield return name;
            }
            yield break;
        }

        if (expression is TupleExpressionSyntax tuple)
        {
            foreach (ArgumentSyntax argument in tuple.Arguments)
            {
                foreach (string name in GetDeconstructionDeclarationNames(argument.Expression))
                {
                    yield return name;
                }
            }
        }
    }

    private static IEnumerable<string> GetDeconstructionAssignmentTargetNames(ExpressionSyntax expression)
    {
        if (expression is DeclarationExpressionSyntax declaration)
        {
            foreach (string name in GetVariableDesignationNames(declaration.Designation))
            {
                yield return name;
            }
            yield break;
        }

        if (expression is IdentifierNameSyntax identifier)
        {
            string name = identifier.Identifier.ValueText;
            if (!string.IsNullOrWhiteSpace(name) && !string.Equals(name, "_", StringComparison.Ordinal))
            {
                yield return name;
            }
            yield break;
        }

        if (expression is TupleExpressionSyntax tuple)
        {
            foreach (ArgumentSyntax argument in tuple.Arguments)
            {
                foreach (string name in GetDeconstructionAssignmentTargetNames(argument.Expression))
                {
                    yield return name;
                }
            }
        }
    }

    private static IEnumerable<string> GetVariableDesignationNames(VariableDesignationSyntax designation)
    {
        if (designation is SingleVariableDesignationSyntax single)
        {
            string name = single.Identifier.ValueText;
            if (!string.IsNullOrWhiteSpace(name) && !string.Equals(name, "_", StringComparison.Ordinal))
            {
                yield return name;
            }

            yield break;
        }

        if (designation is ParenthesizedVariableDesignationSyntax parenthesized)
        {
            foreach (VariableDesignationSyntax child in parenthesized.Variables)
            {
                foreach (string name in GetVariableDesignationNames(child))
                {
                    yield return name;
                }
            }
        }
    }

    private static bool IsVoidReturnType(TypeSyntax returnType)
    {
        return returnType is PredefinedTypeSyntax predefinedType
            && predefinedType.Keyword.IsKind(SyntaxKind.VoidKeyword);
    }

    private static StatementSyntax CreateImplicitReturnStatement(string methodName, int line)
    {
        return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Return({Literal(methodName)}, {line});"
        );
    }

    private static StatementSyntax CreateLeaveStatement(string methodName)
    {
        return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Leave({Literal(methodName)});"
        );
    }

    private static IEnumerable<string> GetRewritableCollectionParameterNames(MethodDeclarationSyntax method)
    {
        if (method.Modifiers.Any(SyntaxKind.PublicKeyword)
            || method.Parent is not ClassDeclarationSyntax classDeclaration)
        {
            yield break;
        }

        List<(ParameterSyntax Parameter, int Index)> collectionParameters = method.ParameterList.Parameters
            .Select((parameter, index) => (Parameter: parameter, Index: index))
            .Where(item =>
                item.Parameter.Type is not null
                && TryGetGenericType(item.Parameter.Type, out string typeName, out _)
                && IsSupportedCollectionType(typeName)
            )
            .ToList();
        if (collectionParameters.Count == 0)
        {
            yield break;
        }

        foreach ((ParameterSyntax parameter, int index) in collectionParameters)
        {
            if (ShouldRewriteCollectionParameter(classDeclaration, method.Identifier.ValueText, index, parameter.Identifier.ValueText))
            {
                yield return parameter.Identifier.ValueText;
            }
        }
    }

    private static ParameterListSyntax RewriteCollectionParameterTypes(ParameterListSyntax parameterList, IReadOnlySet<string> parameterNames)
    {
        return parameterList.WithParameters(SyntaxFactory.SeparatedList(
            parameterList.Parameters.Select(parameter =>
                parameterNames.Contains(parameter.Identifier.ValueText)
                    && parameter.Type is not null
                    && TryRewriteCollectionDeclarationType(parameter.Type, out TypeSyntax? replacementType)
                    ? parameter.WithType(replacementType!)
                    : parameter
            )
        ));
    }

    private static bool ShouldRewriteCollectionParameter(
        ClassDeclarationSyntax classDeclaration,
        string methodName,
        int parameterIndex,
        string parameterName)
    {
        bool hasPublicLocalCollectionCall = false;

        foreach (InvocationExpressionSyntax invocation in classDeclaration.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (!IsInvocationOfMethod(invocation, methodName))
            {
                continue;
            }

            SeparatedSyntaxList<ArgumentSyntax> arguments = invocation.ArgumentList.Arguments;
            if (arguments.Count <= parameterIndex
                || arguments[parameterIndex].NameColon is not null
                || arguments[parameterIndex].RefOrOutKeyword.RawKind != 0)
            {
                return false;
            }

            ExpressionSyntax argument = arguments[parameterIndex].Expression;
            if (argument is not IdentifierNameSyntax identifier)
            {
                return false;
            }

            MethodDeclarationSyntax? containingMethod = invocation.FirstAncestorOrSelf<MethodDeclarationSyntax>();
            if (containingMethod?.Identifier.ValueText == methodName
                && string.Equals(identifier.Identifier.ValueText, parameterName, StringComparison.Ordinal))
            {
                continue;
            }

            if (containingMethod is not null
                && containingMethod.Modifiers.Any(SyntaxKind.PublicKeyword)
                && HasSupportedLocalCollectionInitializer(invocation, identifier.Identifier.ValueText))
            {
                hasPublicLocalCollectionCall = true;
                continue;
            }

            return false;
        }

        return hasPublicLocalCollectionCall;
    }

    private static bool IsInvocationOfMethod(InvocationExpressionSyntax invocation, string methodName)
    {
        return invocation.Expression switch
        {
            IdentifierNameSyntax identifier => string.Equals(identifier.Identifier.ValueText, methodName, StringComparison.Ordinal),
            MemberAccessExpressionSyntax memberAccess => string.Equals(memberAccess.Name.Identifier.ValueText, methodName, StringComparison.Ordinal),
            _ => false,
        };
    }

    private static bool HasSupportedLocalCollectionInitializer(InvocationExpressionSyntax invocation, string variableName)
    {
        foreach (BlockSyntax block in invocation.Ancestors().OfType<BlockSyntax>())
        {
            StatementSyntax? containingStatement = invocation
                .AncestorsAndSelf()
                .OfType<StatementSyntax>()
                .FirstOrDefault(statement => statement.Parent == block);
            foreach (StatementSyntax statement in block.Statements)
            {
                if (statement == containingStatement || statement.SpanStart > invocation.SpanStart)
                {
                    break;
                }

                bool? declarationSupport = GetLocalCollectionInitializerSupport(statement, variableName);
                if (declarationSupport.HasValue)
                {
                    return declarationSupport.Value;
                }
            }
        }

        return false;
    }

    private static bool? GetLocalCollectionInitializerSupport(StatementSyntax statement, string variableName)
    {
        VariableDeclarationSyntax? declaration = statement switch
        {
            LocalDeclarationStatementSyntax localDeclaration => localDeclaration.Declaration,
            ForStatementSyntax forStatement => forStatement.Declaration,
            _ => null,
        };
        if (declaration is null)
        {
            return null;
        }

        foreach (VariableDeclaratorSyntax variable in declaration.Variables)
        {
            if (!string.Equals(variable.Identifier.ValueText, variableName, StringComparison.Ordinal))
            {
                continue;
            }

            return variable.Initializer?.Value is ExpressionSyntax initializer
                && IsSupportedCollectionInitializer(initializer, declaration.Type);
        }

        return null;
    }

    private static bool IsSupportedCollectionInitializer(ExpressionSyntax initializer, TypeSyntax declaredType)
    {
        if (initializer is ObjectCreationExpressionSyntax objectCreation
            && TryGetGenericType(objectCreation.Type, out string createdTypeName, out _)
            && IsSupportedCollectionType(createdTypeName))
        {
            return true;
        }

        return initializer is ImplicitObjectCreationExpressionSyntax
            && TryGetGenericType(declaredType, out string declaredTypeName, out _)
            && IsSupportedCollectionType(declaredTypeName);
    }

    private static bool IsTrivialDataConstructor(ConstructorDeclarationSyntax node)
    {
        if (node.Body is null || node.Body.Statements.Count == 0)
        {
            return false;
        }

        var parameterNames = node.ParameterList.Parameters
            .Select(parameter => parameter.Identifier.ValueText)
            .ToHashSet(StringComparer.Ordinal);
        return node.Body.Statements.All(statement =>
            statement is ExpressionStatementSyntax expressionStatement
            && expressionStatement.Expression is AssignmentExpressionSyntax assignment
            && assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
            && IsInstanceFieldLikeAssignmentTarget(assignment.Left)
            && IsTrivialConstructorValue(assignment.Right, parameterNames)
        );
    }

    private static bool IsInstanceFieldLikeAssignmentTarget(ExpressionSyntax expression)
    {
        return expression is IdentifierNameSyntax
            || expression is MemberAccessExpressionSyntax
            {
                Expression: ThisExpressionSyntax,
            };
    }

    private static bool IsTrivialConstructorValue(ExpressionSyntax expression, ISet<string> parameterNames)
    {
        return expression is LiteralExpressionSyntax
            || expression is DefaultExpressionSyntax
            || expression is IdentifierNameSyntax identifier && parameterNames.Contains(identifier.Identifier.ValueText);
    }

    private static MethodDeclarationSyntax ConvertExpressionBodiedMethod(MethodDeclarationSyntax node)
    {
        if (node.Body is not null || node.ExpressionBody is null)
        {
            return node;
        }

        if (node.ReturnType is PredefinedTypeSyntax predefinedType
            && predefinedType.Keyword.IsKind(SyntaxKind.VoidKeyword)
        )
        {
            return node
                .WithBody(SyntaxFactory.Block(
                    SyntaxFactory.ExpressionStatement(node.ExpressionBody.Expression),
                    SyntaxFactory.ReturnStatement()
                ))
                .WithExpressionBody(null)
                .WithSemicolonToken(default);
        }

        StatementSyntax statement = SyntaxFactory.ReturnStatement(node.ExpressionBody.Expression);

        return node
            .WithBody(SyntaxFactory.Block(statement))
            .WithExpressionBody(null)
            .WithSemicolonToken(default);
    }

    private static IEnumerable<string> GetCollectionParameterNames(BaseMethodDeclarationSyntax node)
    {
        foreach (ParameterSyntax parameter in node.ParameterList.Parameters)
        {
            if (parameter.Type is not null
                && TryGetGenericType(parameter.Type, out string typeName, out _)
                && IsSupportedCollectionType(typeName))
            {
                yield return parameter.Identifier.ValueText;
            }
        }
    }

    private static IEnumerable<string> GetCollectionParameterNames(LocalFunctionStatementSyntax node)
    {
        foreach (ParameterSyntax parameter in node.ParameterList.Parameters)
        {
            if (parameter.Type is not null
                && TryGetGenericType(parameter.Type, out string typeName, out _)
                && IsSupportedCollectionType(typeName))
            {
                yield return parameter.Identifier.ValueText;
            }
        }
    }

    private static IEnumerable<string> GetCollectionParameterNames(IEnumerable<ParameterSyntax> parameters)
    {
        foreach (ParameterSyntax parameter in parameters)
        {
            if (parameter.Type is not null
                && TryGetGenericType(parameter.Type, out string typeName, out _)
                && IsSupportedCollectionType(typeName))
            {
                yield return parameter.Identifier.ValueText;
            }
        }
    }

    private static IEnumerable<string> GetStringBuilderParameterNames(BaseMethodDeclarationSyntax node)
    {
        foreach (ParameterSyntax parameter in node.ParameterList.Parameters)
        {
            if (parameter.Type is not null && IsStringBuilderType(parameter.Type))
            {
                yield return parameter.Identifier.ValueText;
            }
        }
    }

    private static IEnumerable<string> GetStringBuilderParameterNames(LocalFunctionStatementSyntax node)
    {
        foreach (ParameterSyntax parameter in node.ParameterList.Parameters)
        {
            if (parameter.Type is not null && IsStringBuilderType(parameter.Type))
            {
                yield return parameter.Identifier.ValueText;
            }
        }
    }

    private static IEnumerable<string> GetStringBuilderParameterNames(IEnumerable<ParameterSyntax> parameters)
    {
        foreach (ParameterSyntax parameter in parameters)
        {
            if (parameter.Type is not null && IsStringBuilderType(parameter.Type))
            {
                yield return parameter.Identifier.ValueText;
            }
        }
    }

    public override SyntaxNode? VisitBlock(BlockSyntax node)
    {
        if (methodNames.Count == 0)
        {
            return base.VisitBlock(node);
        }

        variableScopes.Push(new HashSet<string>(StringComparer.Ordinal));
        stringBuilderScopes.Push(new HashSet<string>(StringComparer.Ordinal));
        var rewrittenStatements = new List<StatementSyntax>();
        try
        {
            foreach (StatementSyntax statement in node.Statements)
            {
                int originalLine = GetLine(statement);
                StatementSyntax visited = (StatementSyntax)Visit(statement)!;
                rewrittenStatements.AddRange(ExpandStatement(visited, originalLine));
            }
        }
        finally
        {
            stringBuilderScopes.Pop();
            variableScopes.Pop();
        }

        return node.WithStatements(SyntaxFactory.List(rewrittenStatements));
    }

    private IEnumerable<StatementSyntax> ExpandStatement(StatementSyntax statement, int line)
    {
        if (!emitTraceEvents)
        {
            yield return statement;
            yield break;
        }

        string methodName = methodNames.Peek();
        bool suppressInheritedElseIfLineFrame = false;
        if (statement is IfStatementSyntax statementIf)
        {
            int inheritedLine = line;
            line = GetIfConditionLineOrFallback(statementIf, line);
            suppressInheritedElseIfLineFrame =
                line == inheritedLine &&
                statementIf.Parent is ElseClauseSyntax &&
                TryGetRewrittenTraceLine(statementIf.Condition) is null;
        }

        if (statement is WhileStatementSyntax
            or ForStatementSyntax
            or ForEachStatementSyntax
            or ForEachVariableStatementSyntax
            or DoStatementSyntax)
        {
            yield return statement;
            yield break;
        }

        if (!suppressInheritedElseIfLineFrame)
        {
            yield return TraceStatement(
                $"TraceCode.Internal.TraceCodeTrace.Line({line}, {Literal(methodName)});"
            );
        }

        if (statement is IfStatementSyntax ifStatement)
        {
            foreach (StatementSyntax ifTraceStatement in RewriteIfStatement(ifStatement, line))
            {
                yield return ifTraceStatement;
            }
            yield break;
        }

        if (statement is ReturnStatementSyntax returnStatement)
        {
            foreach (StatementSyntax returnTraceStatement in RewriteReturnStatement(returnStatement, methodName, line))
            {
                yield return returnTraceStatement;
            }
            yield break;
        }

        if (statement is ThrowStatementSyntax throwStatement)
        {
            foreach (StatementSyntax throwTraceStatement in RewriteThrowStatement(throwStatement, line))
            {
                yield return throwTraceStatement;
            }
            yield break;
        }

        if (statement is BreakStatementSyntax or ContinueStatementSyntax)
        {
            foreach (StatementSyntax snapshotStatement in CreateSnapshotStatements(line))
            {
                yield return snapshotStatement;
            }
            yield return statement;
            yield break;
        }

        StatementSyntax executableStatement = RewriteArrayUnaryWriteStatement(
            RewriteFieldWriteStatement(
                RewriteFieldIndexedWriteStatement(
                    RewriteArrayWriteStatement(
                        RewriteCollectionAssignmentStatement(statement, line),
                        line
                    ),
                    line
                ),
                line
            ),
            line
        );
        foreach (StatementSyntax readStatement in CreateConstructorConsumptionReadStatements(executableStatement, line))
        {
            yield return readStatement;
        }
        yield return executableStatement;

        RegisterDeclaredVariables(executableStatement);
        foreach (StatementSyntax writeStatement in CreateWriteStatements(executableStatement, line))
        {
            yield return writeStatement;
        }
        foreach (StatementSyntax readStatement in CreateScalarExpressionReadStatements(executableStatement, line))
        {
            yield return readStatement;
        }
        foreach (StatementSyntax readStatement in CreateImplicitFieldAliasReadStatements(executableStatement, line))
        {
            yield return readStatement;
        }
        foreach (StatementSyntax mutationStatement in CreateCollectionParameterMutationStatements(executableStatement, line))
        {
            yield return mutationStatement;
        }
        foreach (StatementSyntax mutationStatement in CreateIdentifierReceiverMutationStatements(executableStatement, line))
        {
            yield return mutationStatement;
        }
        foreach (StatementSyntax mutationStatement in CreateIndexedReceiverMutationStatements(executableStatement, line))
        {
            yield return mutationStatement;
        }
        foreach (StatementSyntax mutationStatement in CreateMemberReceiverMutationStatements(executableStatement, line))
        {
            yield return mutationStatement;
        }
        foreach (StatementSyntax mutationStatement in CreateFieldIndexedReceiverMutationStatements(executableStatement, line))
        {
            yield return mutationStatement;
        }
        foreach (StatementSyntax mutationStatement in CreateIndexedFieldReceiverMutationStatements(executableStatement, line))
        {
            yield return mutationStatement;
        }
        foreach (StatementSyntax mutationStatement in CreateStringBuilderMutationStatements(executableStatement, line))
        {
            yield return mutationStatement;
        }
        foreach (StatementSyntax mutationStatement in CreateStaticArrayMutationStatements(executableStatement, line))
        {
            yield return mutationStatement;
        }
        foreach (StatementSyntax snapshotStatement in CreateSnapshotStatements(line))
        {
            yield return snapshotStatement;
        }
    }

    private IEnumerable<StatementSyntax> RewriteReturnStatement(
        ReturnStatementSyntax returnStatement,
        string methodName,
        int line
    )
    {
        if (returnStatement.Expression is null)
        {
            yield return TraceStatement(
                $"TraceCode.Internal.TraceCodeTrace.Return({Literal(methodName)}, {line});"
            );
            foreach (StatementSyntax snapshotStatement in CreateSnapshotStatements(line))
            {
                yield return snapshotStatement;
            }
            yield return CreateLeaveStatement(methodName);
            yield return returnStatement;
            yield break;
        }

        if (returnStatement.Expression.IsKind(SyntaxKind.NullLiteralExpression))
        {
            yield return TraceStatement(
                $"TraceCode.Internal.TraceCodeTrace.Return({Literal(methodName)}, {line}, null);"
            );
            foreach (StatementSyntax snapshotStatement in CreateSnapshotStatements(line))
            {
                yield return snapshotStatement;
            }
            yield return CreateLeaveStatement(methodName);
            yield return returnStatement;
            yield break;
        }

        string tempName = $"__tracecode_return_{returnValueCounter++}";
        yield return TraceStatement($"{GetCurrentReturnTempType()} {tempName} = {returnStatement.Expression};");
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Return({Literal(methodName)}, {line}, {tempName});"
        );
        foreach (StatementSyntax snapshotStatement in CreateSnapshotStatements(line))
        {
            yield return snapshotStatement;
        }
        yield return CreateLeaveStatement(methodName);
        yield return TraceStatement($"return {tempName};");
    }

    private string GetCurrentReturnTempType()
    {
        return methodReturnTypes.Count > 0 ? methodReturnTypes.Peek() : "var";
    }

    private IEnumerable<StatementSyntax> RewriteThrowStatement(ThrowStatementSyntax throwStatement, int line)
    {
        if (throwStatement.Expression is null)
        {
            yield return TraceStatement(
                $"TraceCode.Internal.TraceCodeTrace.Exception({line}, null);"
            );
            yield return throwStatement;
            yield break;
        }

        string tempName = $"__tracecode_exception_{exceptionValueCounter++}";
        yield return TraceStatement($"var {tempName} = {throwStatement.Expression};");
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Exception({line}, {tempName}.Message);"
        );
        yield return TraceStatement($"throw {tempName};");
    }

    private IEnumerable<StatementSyntax> RewriteIfStatement(IfStatementSyntax ifStatement, int line)
    {
        IfStatementSyntax expandedIfStatement = ExpandIfEmbeddedStatements(ifStatement, line);
        if (ContainsPatternDeclaration(ifStatement.Condition))
        {
            foreach (StatementSyntax snapshotStatement in CreateSnapshotStatements(line))
            {
                yield return snapshotStatement;
            }
            yield return expandedIfStatement;
            yield break;
        }

        string tempName = $"__tracecode_condition_{conditionValueCounter++}";
        yield return TraceStatement($"bool {tempName} = {expandedIfStatement.Condition};");
        foreach (StatementSyntax snapshotStatement in CreateSnapshotStatements(line))
        {
            yield return snapshotStatement;
        }
        yield return expandedIfStatement.WithCondition(SyntaxFactory.IdentifierName(tempName));
    }

    private IfStatementSyntax ExpandIfEmbeddedStatements(IfStatementSyntax ifStatement, int fallbackLine)
    {
        int conditionLine = GetIfConditionLineOrFallback(ifStatement, fallbackLine);
        int statementFallbackLine = GetUnbracedIfBodyLineOrFallback(ifStatement, conditionLine);
        IfStatementSyntax expanded = ifStatement.WithStatement(ExpandEmbeddedStatement(ifStatement.Statement, conditionLine, statementFallbackLine));
        if (ifStatement.Else is { Statement: StatementSyntax elseStatement } elseClause)
        {
            expanded = expanded.WithElse(elseClause.WithStatement(ExpandEmbeddedStatement(elseStatement, conditionLine)));
        }

        return expanded;
    }

    private StatementSyntax ExpandEmbeddedStatement(StatementSyntax statement, int fallbackLine, int? exactLine = null)
    {
        if (statement is BlockSyntax)
        {
            return statement;
        }

        int line = exactLine is > 0 ? exactLine.Value : GetEmbeddedStatementLineOrFallback(statement, fallbackLine);
        return SyntaxFactory.Block(ExpandScopedEmbeddedStatement(statement, line));
    }

    private static int GetEmbeddedStatementLineOrFallback(StatementSyntax statement, int fallbackLine)
    {
        int? rewrittenTraceLine = TryGetRewrittenTraceLine(statement);
        if (rewrittenTraceLine is > 0 && rewrittenTraceLine.Value > fallbackLine)
        {
            return rewrittenTraceLine.Value;
        }

        int line = statement switch
        {
            ExpressionStatementSyntax
            {
                Expression: AssignmentExpressionSyntax assignment
            } => GetLine(assignment.OperatorToken),
            IfStatementSyntax ifStatement => GetIfConditionLineOrFallback(ifStatement, fallbackLine),
            WhileStatementSyntax whileStatement => GetLine(whileStatement.Condition),
            ForStatementSyntax forStatement => GetLine(forStatement),
            ForEachStatementSyntax forEachStatement => GetLine(forEachStatement),
            ForEachVariableStatementSyntax forEachVariableStatement => GetLine(forEachVariableStatement),
            DoStatementSyntax doStatement => GetLine(doStatement),
            _ => GetLine(statement),
        };
        if (line <= fallbackLine && statement is not BlockSyntax)
        {
            int? nextLine = GetNextExecutableLineIfStatementIsNotOnFallbackLine(statement, fallbackLine);
            if (nextLine is > 0)
            {
                return nextLine.Value;
            }
        }
        return line > fallbackLine ? line : fallbackLine;
    }

    private List<StatementSyntax> ExpandScopedEmbeddedStatement(StatementSyntax statement, int line)
    {
        variableScopes.Push(new HashSet<string>(StringComparer.Ordinal));
        declaredLocalVariables.Push(new HashSet<string>(StringComparer.Ordinal));
        stringBuilderScopes.Push(new HashSet<string>(StringComparer.Ordinal));
        try
        {
            return ExpandStatement(statement, line).ToList();
        }
        finally
        {
            stringBuilderScopes.Pop();
            declaredLocalVariables.Pop();
            variableScopes.Pop();
        }
    }

    public override SyntaxNode? VisitElementAccessExpression(ElementAccessExpressionSyntax node)
    {
        if (!emitTraceEvents)
        {
            return base.VisitElementAccessExpression(node);
        }

        if (IsAssignmentLeft(node)
            || IsUnaryMutationOperand(node)
            || IsWithinElementAccessAssignmentLeftChain(node)
            || IsWithinTupleAssignmentLeft(node)
            || IsWithinElementAccessUnaryMutationChain(node)
            || IsCollectionMutationInvocationReceiver(node))
        {
            return node;
        }

        if (TryGetNestedElementAccess(node, out string nestedVariable, out string firstIndex, out string secondIndex))
        {
            if (IsRangeIndex(firstIndex) || IsRangeIndex(secondIndex))
            {
                return base.VisitElementAccessExpression(node);
            }

            int nestedLine = GetLine(node);
            return SyntaxFactory.ParseExpression(
                $"TraceCode.Internal.TraceCodeTrace.ArrayRead({nestedVariable}, {firstIndex}, {secondIndex}, {Literal(nestedVariable)}, {nestedLine}, {CreateIndexSourcesExpression(firstIndex, secondIndex)})"
            );
        }

        if (TryGetFieldElementAccessPath(node, out string fieldVariable, out List<string>? fieldPath, out string fieldIndex))
        {
            int fieldLine = GetLine(node);
            string pathExpression = CreateObjectArrayExpression(fieldPath, fieldIndex);
            return SyntaxFactory.ParseExpression(
                $"TraceCode.Internal.TraceCodeTrace.FieldRead({node}, {Literal(fieldVariable)}, {pathExpression}, {fieldLine}, {CreateFieldIndexSourcesExpression(fieldPath, fieldIndex)})"
            );
        }

        var rewritten = (ElementAccessExpressionSyntax)base.VisitElementAccessExpression(node)!;
        if (rewritten.Expression is IdentifierNameSyntax rectangularIdentifier
            && !collectionVariables.Contains(rectangularIdentifier.Identifier.ValueText)
            && IsSupportedRectangularRank(rewritten.ArgumentList.Arguments.Count))
        {
            int rectangularLine = GetLine(node);
            string rectangularArrayExpression = rewritten.Expression.ToString();
            List<string> indexExpressions = GetArgumentExpressions(rewritten.ArgumentList.Arguments);
            if (indexExpressions.Any(IsRangeIndex))
            {
                return rewritten;
            }

            return SyntaxFactory.ParseExpression(
                $"TraceCode.Internal.TraceCodeTrace.ArrayRead({rectangularArrayExpression}, {string.Join(", ", indexExpressions)}, {Literal(rectangularIdentifier.Identifier.ValueText)}, {rectangularLine}, {CreateIndexSourcesExpression(indexExpressions)})"
            );
        }

        if (rewritten.Expression is not IdentifierNameSyntax identifier
            || rewritten.ArgumentList.Arguments.Count != 1)
        {
            return rewritten;
        }

        int line = GetLine(node);
        string arrayExpression = rewritten.Expression.ToString();
        string indexExpression = rewritten.ArgumentList.Arguments[0].Expression.ToString();
        string indexSourceExpression = node.ArgumentList.Arguments[0].Expression.ToString();
        if (IsRangeIndex(indexSourceExpression))
        {
            return rewritten;
        }

        return SyntaxFactory.ParseExpression(
            $"TraceCode.Internal.TraceCodeTrace.ArrayRead({arrayExpression}, {indexExpression}, {Literal(identifier.Identifier.ValueText)}, {line}, {CreateIndexSourcesExpression(indexSourceExpression)})"
        );
    }

    public override SyntaxNode? VisitInvocationExpression(InvocationExpressionSyntax node)
    {
        if (!emitTraceEvents)
        {
            return base.VisitInvocationExpression(node);
        }

        int originalLine = GetLine(node);
        if (TryRewriteIndexedReceiverRead(node, out ExpressionSyntax? originalIndexedReadReplacement))
        {
            return originalIndexedReadReplacement;
        }
        if (TryRewriteCollectionContainsRead(node, out ExpressionSyntax? originalContainsReadReplacement))
        {
            return originalContainsReadReplacement;
        }

        var rewritten = (InvocationExpressionSyntax)base.VisitInvocationExpression(node)!;

        if (TryRewriteTrackedCollectionInvocationLine(rewritten, originalLine, out ExpressionSyntax? lineScopedReplacement))
        {
            return lineScopedReplacement;
        }

        if (TryRewriteIdentifierReceiverRead(rewritten, out ExpressionSyntax? identifierReadReplacement))
        {
            return identifierReadReplacement;
        }

        if (TryRewriteIndexedReceiverRead(rewritten, out ExpressionSyntax? indexedReadReplacement))
        {
            return indexedReadReplacement;
        }

        if (TryRewriteCollectionContainsRead(rewritten, out ExpressionSyntax? replacement))
        {
            return replacement;
        }

        return rewritten;
    }

    private bool TryRewriteTrackedCollectionInvocationLine(InvocationExpressionSyntax invocation, int line, out ExpressionSyntax? replacement)
    {
        replacement = null;
        if (invocation.Expression is not MemberAccessExpressionSyntax memberAccess
            || memberAccess.Expression is not IdentifierNameSyntax receiver
            || !IsTrackedCollectionReceiver(receiver.Identifier.ValueText)
            || !IsTrackedCollectionWrapperMethod(memberAccess.Name.Identifier.ValueText)
            || invocation.ArgumentList.Arguments.Any(argument => argument.NameColon is not null || argument.RefOrOutKeyword.RawKind != 0)
            || IsInsideTraceCodeSourceLineScope(invocation))
        {
            return false;
        }

        string method = memberAccess.Name.Identifier.ValueText;
        if (interfaceDispatchedCollectionVariables.Contains(receiver.Identifier.ValueText)
            && IsIndexedReceiverMutationMethod(method))
        {
            return false;
        }

        if (method == "Enqueue" && invocation.Parent is ExpressionStatementSyntax)
        {
            string args = string.Join(", ", invocation.ArgumentList.Arguments.Select(argument => argument.Expression.ToString()));
            replacement = SyntaxFactory.ParseExpression(
                $"TraceCode.Internal.TraceCodeTrace.CollectionMutationCall({line}, {Literal(receiver.Identifier.ValueText)}, {Literal(method)}, new object?[] {{ {args} }}, () => {invocation})"
            );
            return true;
        }

        string scopedInvocation = $"TraceCode.Internal.TraceCodeTrace.WithSourceLine({line}, () => {invocation})";
        if (memberCollectionNames.Contains(receiver.Identifier.ValueText)
            && !IsDeclaredLocalVariable(receiver.Identifier.ValueText))
        {
            string sourceVariable = receiver.Identifier.ValueText;
            string actualVariable = $"this.{sourceVariable}";
            scopedInvocation = $"TraceCode.Internal.TraceCodeTrace.WithVariableAlias({Literal(actualVariable)}, {Literal(sourceVariable)}, () => {scopedInvocation})";
        }

        replacement = SyntaxFactory.ParseExpression(scopedInvocation);
        return true;
    }

    private bool TryRewriteIdentifierReceiverRead(InvocationExpressionSyntax invocation, out ExpressionSyntax? replacement)
    {
        replacement = null;
        if (invocation.Expression is not MemberAccessExpressionSyntax memberAccess
            || !IsIndexedReceiverReadMethod(memberAccess.Name.Identifier.ValueText)
            || memberAccess.Expression is not IdentifierNameSyntax identifier)
        {
            return false;
        }

        string variable = identifier.Identifier.ValueText;
        if (!collectionParameterVariables.Contains(variable) || collectionVariables.Contains(variable))
        {
            return false;
        }

        int line = GetLine(invocation);
        replacement = SyntaxFactory.ParseExpression(
            $"TraceCode.Internal.TraceCodeTrace.IndexedRead({Literal(variable)}, new object?[] {{ 0 }}, {invocation}, {line})"
        );
        return true;
    }

    public override SyntaxNode? VisitMemberAccessExpression(MemberAccessExpressionSyntax node)
    {
        if (!emitTraceEvents)
        {
            return base.VisitMemberAccessExpression(node);
        }

        if (IsAssignmentLeft(node)
            || IsUnaryMutationOperand(node)
            || IsWithinAssignmentLeftChain(node)
            || IsWithinTupleAssignmentLeft(node)
            || IsCollectionMutationInvocationReceiver(node))
        {
            return node;
        }

        if (IsInvocationMethodAccess(node))
        {
            return base.VisitMemberAccessExpression(node);
        }

        if (TryRewriteIndexedMetadataRead(node, out ExpressionSyntax? indexedMetadataRead))
        {
            return indexedMetadataRead;
        }

        if (!TryGetMemberAccessPath(node, out string variable, out List<string>? path))
        {
            return base.VisitMemberAccessExpression(node);
        }

        int line = GetLine(node);
        string pathExpression = CreateStringArrayExpression(path);
        return SyntaxFactory.ParseExpression(
            $"TraceCode.Internal.TraceCodeTrace.FieldRead({node}, {Literal(variable)}, {pathExpression}, {line})"
        );
    }

    private bool TryRewriteIndexedMetadataRead(MemberAccessExpressionSyntax memberAccess, out ExpressionSyntax? replacement)
    {
        replacement = null;
        string metadataName = memberAccess.Name.Identifier.ValueText;
        if (!IsCollectionMetadataMember(metadataName)
            || memberAccess.Expression is not ElementAccessExpressionSyntax elementAccess)
        {
            return false;
        }

        int line = GetLine(memberAccess);
        if (TryGetIdentifierElementAccessPath(elementAccess, out string variable, out string index))
        {
            if (IsRangeIndex(index))
            {
                return false;
            }

            string pathExpression = CreateObjectArrayExpression(Array.Empty<string>(), index, Literal(metadataName));
            string indexSourcesExpression = CreateIndexedMetadataIndexSourcesExpression(index);
            replacement = SyntaxFactory.ParseExpression(
                $"TraceCode.Internal.TraceCodeTrace.FieldRead({memberAccess}, {Literal(variable)}, {pathExpression}, {line}, {indexSourcesExpression})"
            );
            return true;
        }

        if (TryGetFieldElementAccessPath(elementAccess, out string fieldVariable, out List<string>? fieldPath, out string fieldIndex))
        {
            if (IsRangeIndex(fieldIndex))
            {
                return false;
            }

            string pathExpression = CreateObjectArrayExpression(fieldPath, fieldIndex, Literal(metadataName));
            string indexSourcesExpression = CreateFieldIndexedMetadataIndexSourcesExpression(fieldPath, fieldIndex);
            replacement = SyntaxFactory.ParseExpression(
                $"TraceCode.Internal.TraceCodeTrace.FieldRead({memberAccess}, {Literal(fieldVariable)}, {pathExpression}, {line}, {indexSourcesExpression})"
            );
            return true;
        }

        return false;
    }

    private bool TryRewriteIndexedReceiverRead(InvocationExpressionSyntax invocation, out ExpressionSyntax? replacement)
    {
        replacement = null;
        if (invocation.Expression is not MemberAccessExpressionSyntax memberAccess
            || !IsIndexedReceiverReadMethod(memberAccess.Name.Identifier.ValueText)
            || memberAccess.Expression is not ElementAccessExpressionSyntax elementAccess
            || !TryGetIdentifierElementAccessPath(elementAccess, out string variable, out string index)
            || IsRangeIndex(index))
        {
            return false;
        }

        int line = GetLine(invocation);
        string pathExpression = CreateObjectArrayExpression(Array.Empty<string>(), index, "0");
        string indexSourcesExpression = CreateIndexSourcesExpression(index, "0");
        replacement = SyntaxFactory.ParseExpression(
            $"TraceCode.Internal.TraceCodeTrace.IndexedRead({Literal(variable)}, {pathExpression}, {invocation}, {line}, {indexSourcesExpression})"
        );
        return true;
    }

    private bool TryRewriteCollectionContainsRead(InvocationExpressionSyntax invocation, out ExpressionSyntax? replacement)
    {
        replacement = null;
        if (invocation.Expression is not MemberAccessExpressionSyntax memberAccess
            || memberAccess.Name.Identifier.ValueText is not ("Contains" or "ContainsKey")
            || invocation.ArgumentList.Arguments.Count != 1
            || invocation.ArgumentList.Arguments[0].NameColon is not null
            || invocation.ArgumentList.Arguments[0].RefOrOutKeyword.RawKind != 0)
        {
            return false;
        }

        string keyExpression = invocation.ArgumentList.Arguments[0].Expression.ToString();
        int line = GetLine(invocation);

        if (memberAccess.Expression is IdentifierNameSyntax identifier)
        {
            string variable = identifier.Identifier.ValueText;
            if (!collectionParameterVariables.Contains(variable) && !collectionVariables.Contains(variable))
            {
                return false;
            }

            replacement = SyntaxFactory.ParseExpression(
                $"TraceCode.Internal.TraceCodeTrace.ContainsRead({invocation}, {Literal(variable)}, {keyExpression}, {line}, {CreateIndexSourcesExpression(keyExpression)})"
            );
            return true;
        }

        if (memberAccess.Expression is ElementAccessExpressionSyntax elementAccess)
        {
            if (TryGetIdentifierElementAccessPath(elementAccess, out string variable, out string index))
            {
                if (IsRangeIndex(index))
                {
                    return false;
                }

                string pathExpression = CreateObjectArrayExpression(Array.Empty<string>(), index, keyExpression);
                replacement = SyntaxFactory.ParseExpression(
                    $"TraceCode.Internal.TraceCodeTrace.ContainsRead({invocation}, {Literal(variable)}, {pathExpression}, {line}, {CreateIndexSourcesExpression(index, keyExpression)})"
                );
                return true;
            }

            if (TryGetFieldElementAccessPath(elementAccess, out string fieldVariable, out List<string>? fieldPath, out string fieldIndex))
            {
                if (IsRangeIndex(fieldIndex))
                {
                    return false;
                }

                string pathExpression = CreateObjectArrayExpression(fieldPath, fieldIndex, keyExpression);
                replacement = SyntaxFactory.ParseExpression(
                    $"TraceCode.Internal.TraceCodeTrace.ContainsRead({invocation}, {Literal(fieldVariable)}, {pathExpression}, {line}, {CreateFieldIndexSourcesExpression(fieldPath, fieldIndex, keyExpression)})"
                );
                return true;
            }
        }

        if (memberAccess.Expression is MemberAccessExpressionSyntax receiverField
            && TryGetMemberAccessPath(receiverField, out string receiverVariable, out List<string>? receiverPath))
        {
            string pathExpression = CreateObjectArrayExpression(receiverPath, keyExpression);
            replacement = SyntaxFactory.ParseExpression(
                $"TraceCode.Internal.TraceCodeTrace.ContainsRead({invocation}, {Literal(receiverVariable)}, {pathExpression}, {line}, {CreateFieldIndexSourcesExpression(receiverPath, keyExpression)})"
            );
            return true;
        }

        return false;
    }

    public override SyntaxNode? VisitForStatement(ForStatementSyntax node)
    {
        List<string> declaredNames = node.Declaration?.Variables
            .Select(variable => variable.Identifier.ValueText)
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .ToList() ?? new List<string>();
        if (variableScopes.Count > 0)
        {
            foreach (string name in declaredNames)
            {
                variableScopes.Peek().Add(name);
            }
        }

        try
        {
            var rewritten = (ForStatementSyntax)base.VisitForStatement(node)!;
            if (!emitTraceEvents || methodNames.Count == 0)
            {
                return rewritten.WithStatement(AddTimeoutCheck(rewritten.Statement));
            }

            int line = GetLine(node);
            if (rewritten.Condition is not null)
            {
                var scopedCondition = SyntaxFactory.ParseExpression(
                    $"TraceCode.Internal.TraceCodeTrace.LoopCondition({line}, {Literal(methodNames.Peek())}, () => {rewritten.Condition}, {CreateSnapshotActionExpression(line)})"
                );
                rewritten = rewritten.WithCondition(scopedCondition);
            }

            StatementSyntax loopStatement = ExpandEmbeddedLoopStatement(rewritten.Statement, node.Statement, line);
            if (declaredNames.Count > 0)
            {
                BlockSyntax loopBlock = loopStatement is BlockSyntax block
                    ? block
                    : SyntaxFactory.Block(loopStatement);
                IEnumerable<StatementSyntax> headerWrites = declaredNames.Select(name => TraceStatement(
                    $"TraceCode.CSharpHost.RuntimeTraceSink.Write({Literal(name)}, {name}, {line});"
                ));
                loopStatement = loopBlock.WithStatements(SyntaxFactory.List(headerWrites.Concat(loopBlock.Statements)));
            }

            return rewritten.WithStatement(AddLoopHeaderTrace(loopStatement, line, methodNames.Peek(), emitLine: false));
        }
        finally
        {
            if (variableScopes.Count > 0)
            {
                foreach (string name in declaredNames)
                {
                    variableScopes.Peek().Remove(name);
                }
            }
            if (stringBuilderScopes.Count > 0)
            {
                foreach (string name in declaredNames)
                {
                    stringBuilderScopes.Peek().Remove(name);
                }
            }
        }
    }

    public override SyntaxNode? VisitForEachStatement(ForEachStatementSyntax node)
    {
        string iterationName = node.Identifier.ValueText;
        if (variableScopes.Count > 0 && !string.IsNullOrWhiteSpace(iterationName))
        {
            variableScopes.Peek().Add(iterationName);
        }

        try
        {
            var rewritten = (ForEachStatementSyntax)base.VisitForEachStatement(node)!;
            if (!emitTraceEvents || methodNames.Count == 0)
            {
                return rewritten.WithStatement(AddTimeoutCheck(rewritten.Statement));
            }

            int line = GetLine(node);
            var snapshotExclusions = new HashSet<string>(StringComparer.Ordinal);
            if (!string.IsNullOrWhiteSpace(iterationName))
            {
                snapshotExclusions.Add(iterationName);
            }
            string snapshotAction = CreateSnapshotActionExpression(line, snapshotExclusions);
            var scopedExpression = SyntaxFactory.ParseExpression(
                $"TraceCode.Internal.TraceCodeTrace.WithSourceLine({line}, () => {rewritten.Expression})"
            );
            if (node.Expression is IdentifierNameSyntax identifier && !string.IsNullOrWhiteSpace(iterationName))
            {
                scopedExpression = SyntaxFactory.ParseExpression(
                    $"TraceCode.CSharpHost.RuntimeTraceSink.IterationBind(TraceCode.Internal.TraceCodeTrace.WithSourceLine({line}, () => {rewritten.Expression}), {Literal(identifier.Identifier.ValueText)}, {Literal(iterationName)}, {line}, {Literal(methodNames.Peek())}, true, {snapshotAction})"
                );
            }
            else if (
                !string.IsNullOrWhiteSpace(iterationName)
                && node.Expression is ElementAccessExpressionSyntax elementAccess
                && TryGetIdentifierElementAccessPath(elementAccess, out string variable, out string index)
            )
            {
                scopedExpression = SyntaxFactory.ParseExpression(
                    $"TraceCode.CSharpHost.RuntimeTraceSink.NestedIterationBind(TraceCode.Internal.TraceCodeTrace.EnumerableSource({line}, {Literal(methodNames.Peek())}, () => {rewritten.Expression}, {snapshotAction}), {Literal(variable)}, {index}, {CreateIndexSourceLiteral(index)}, {Literal(iterationName)}, {line}, {Literal(methodNames.Peek())}, false, {snapshotAction})"
                );
            }
            else if (!string.IsNullOrWhiteSpace(iterationName))
            {
                string sourceName = GetIterationSourceName(node.Expression);
                scopedExpression = SyntaxFactory.ParseExpression(
                    $"TraceCode.CSharpHost.RuntimeTraceSink.IterationBind(TraceCode.Internal.TraceCodeTrace.EnumerableSource({line}, {Literal(methodNames.Peek())}, () => {rewritten.Expression}, {snapshotAction}), {Literal(sourceName)}, {Literal(iterationName)}, {line}, {Literal(methodNames.Peek())}, false, {snapshotAction})"
                );
            }
            rewritten = rewritten.WithExpression(scopedExpression);
            return rewritten.WithStatement(AddLoopHeaderTrace(ExpandEmbeddedLoopStatement(rewritten.Statement, node.Statement, line), line, methodNames.Peek(), emitLine: false));
        }
        finally
        {
            if (variableScopes.Count > 0 && !string.IsNullOrWhiteSpace(iterationName))
            {
                variableScopes.Peek().Remove(iterationName);
            }
            if (stringBuilderScopes.Count > 0 && !string.IsNullOrWhiteSpace(iterationName))
            {
                stringBuilderScopes.Peek().Remove(iterationName);
            }
        }
    }

    public override SyntaxNode? VisitForEachVariableStatement(ForEachVariableStatementSyntax node)
    {
        List<string> iterationNames = GetDeclarationExpressionVariableNames(node.Variable).ToList();
        if (variableScopes.Count > 0)
        {
            foreach (string name in iterationNames)
            {
                variableScopes.Peek().Add(name);
            }
        }

        try
        {
            var rewritten = (ForEachVariableStatementSyntax)base.VisitForEachVariableStatement(node)!;
            if (!emitTraceEvents || methodNames.Count == 0)
            {
                return rewritten.WithStatement(AddTimeoutCheck(rewritten.Statement));
            }

            int line = GetLine(node);
            var snapshotExclusions = new HashSet<string>(iterationNames, StringComparer.Ordinal);
            string snapshotAction = CreateSnapshotActionExpression(line, snapshotExclusions);
            string bindingVariablesExpression = CreateStringArrayExpression(iterationNames);
            ExpressionSyntax scopedExpression;
            if (node.Expression is IdentifierNameSyntax identifier && iterationNames.Count > 0)
            {
                scopedExpression = SyntaxFactory.ParseExpression(
                    $"TraceCode.CSharpHost.RuntimeTraceSink.TupleIterationBind(TraceCode.Internal.TraceCodeTrace.EnumerableSource({line}, {Literal(methodNames.Peek())}, () => {rewritten.Expression}, {snapshotAction}), {Literal(identifier.Identifier.ValueText)}, {bindingVariablesExpression}, {line}, {Literal(methodNames.Peek())}, false, {snapshotAction})"
                );
            }
            else if (
                iterationNames.Count > 0
                && node.Expression is ElementAccessExpressionSyntax elementAccess
                && TryGetIdentifierElementAccessPath(elementAccess, out string variable, out string index)
            )
            {
                scopedExpression = SyntaxFactory.ParseExpression(
                    $"TraceCode.CSharpHost.RuntimeTraceSink.TupleNestedIterationBind(TraceCode.Internal.TraceCodeTrace.EnumerableSource({line}, {Literal(methodNames.Peek())}, () => {rewritten.Expression}, {snapshotAction}), {Literal(variable)}, {index}, {CreateIndexSourceLiteral(index)}, {bindingVariablesExpression}, {line}, {Literal(methodNames.Peek())}, false, {snapshotAction})"
                );
            }
            else
            {
                string sourceName = GetIterationSourceName(node.Expression);
                scopedExpression = SyntaxFactory.ParseExpression(
                    $"TraceCode.CSharpHost.RuntimeTraceSink.TupleIterationBind(TraceCode.Internal.TraceCodeTrace.EnumerableSource({line}, {Literal(methodNames.Peek())}, () => {rewritten.Expression}, {snapshotAction}), {Literal(sourceName)}, {bindingVariablesExpression}, {line}, {Literal(methodNames.Peek())}, false, {snapshotAction})"
                );
            }
            return rewritten
                .WithExpression(scopedExpression)
                .WithStatement(AddLoopHeaderTrace(ExpandEmbeddedLoopStatement(rewritten.Statement, node.Statement, line), line, methodNames.Peek(), emitLine: false));
        }
        finally
        {
            if (variableScopes.Count > 0)
            {
                foreach (string name in iterationNames)
                {
                    variableScopes.Peek().Remove(name);
                }
            }
            if (stringBuilderScopes.Count > 0)
            {
                foreach (string name in iterationNames)
                {
                    stringBuilderScopes.Peek().Remove(name);
                }
            }
        }
    }

    public override SyntaxNode? VisitWhileStatement(WhileStatementSyntax node)
    {
        var rewritten = (WhileStatementSyntax)base.VisitWhileStatement(node)!;
        if (!emitTraceEvents || methodNames.Count == 0)
        {
            return rewritten.WithStatement(AddTimeoutCheck(rewritten.Statement));
        }

        int line = GetLine(node);
        var scopedCondition = SyntaxFactory.ParseExpression(
            $"TraceCode.Internal.TraceCodeTrace.LoopCondition({line}, {Literal(methodNames.Peek())}, () => {rewritten.Condition}, {CreateSnapshotActionExpression(line)})"
        );
        return rewritten
            .WithCondition(scopedCondition)
            .WithStatement(AddLoopHeaderTrace(ExpandEmbeddedLoopStatement(rewritten.Statement, node.Statement, line), line, methodNames.Peek(), emitLine: false));
    }

    public override SyntaxNode? VisitDoStatement(DoStatementSyntax node)
    {
        var rewritten = (DoStatementSyntax)base.VisitDoStatement(node)!;
        if (!emitTraceEvents || methodNames.Count == 0)
        {
            return rewritten.WithStatement(AddTimeoutCheck(rewritten.Statement));
        }

        int line = GetLine(node);
        var scopedCondition = SyntaxFactory.ParseExpression(
            $"TraceCode.Internal.TraceCodeTrace.LoopCondition({line}, {Literal(methodNames.Peek())}, () => {rewritten.Condition}, {CreateSnapshotActionExpression(line)})"
        );
        return rewritten
            .WithCondition(scopedCondition)
            .WithStatement(AddLoopHeaderTrace(ExpandEmbeddedLoopStatement(rewritten.Statement, node.Statement, line), line, methodNames.Peek(), emitLine: false));
    }

    private static string GetIterationSourceName(ExpressionSyntax expression)
    {
        string source = expression.ToString().Trim();
        return string.IsNullOrWhiteSpace(source) ? string.Empty : source;
    }

    public override SyntaxNode? VisitVariableDeclarator(VariableDeclaratorSyntax node)
    {
        if (!emitTraceEvents)
        {
            return base.VisitVariableDeclarator(node);
        }

        VariableDeclaratorSyntax rewritten = (VariableDeclaratorSyntax)base.VisitVariableDeclarator(node)!;
        TypeSyntax? declaredType = (node.Parent as VariableDeclarationSyntax)?.Type;
        if (IsInsideAnonymousFunction(node))
        {
            return rewritten;
        }

        if (IsStringBuilderType(declaredType)
            || rewritten.Initializer?.Value is ExpressionSyntax initializer
                && IsStringBuilderCreation(initializer, declaredType))
        {
            TrackStringBuilderVariable(rewritten.Identifier.ValueText);
        }

        if (IsNonRewritableCollectionFieldDeclarator(node))
        {
            return rewritten;
        }

        if (rewritten.Initializer?.Value is not ExpressionSyntax creation
            || !TryRewriteCollectionCreation(creation, rewritten.Identifier.ValueText, declaredType, out ExpressionSyntax? replacement))
        {
            return rewritten;
        }

        collectionVariables.Add(node.Identifier.ValueText);
        if (ShouldEmitExplicitCollectionMutationForDeclaredType(declaredType))
        {
            interfaceDispatchedCollectionVariables.Add(node.Identifier.ValueText);
        }
        TrackCollectionVariable(node.Identifier.ValueText, declaredType, creation);
        return rewritten.WithInitializer(rewritten.Initializer.WithValue(replacement!));
    }

    public override SyntaxNode? VisitLocalDeclarationStatement(LocalDeclarationStatementSyntax node)
    {
        if (!emitTraceEvents)
        {
            return base.VisitLocalDeclarationStatement(node);
        }

        LocalDeclarationStatementSyntax rewritten = (LocalDeclarationStatementSyntax)base.VisitLocalDeclarationStatement(node)!;
        if (!TryRewriteCollectionDeclarationType(rewritten.Declaration.Type, out TypeSyntax? replacementType))
        {
            return rewritten;
        }

        bool hasRewrittenCollectionInitializer = node.Declaration.Variables.Any(variable =>
            variable.Initializer?.Value is ObjectCreationExpressionSyntax objectCreation
                && TryGetGenericType(objectCreation.Type, out string typeName, out _)
                && IsSupportedCollectionType(typeName)
            || variable.Initializer?.Value is ImplicitObjectCreationExpressionSyntax
                && TryGetGenericType(node.Declaration.Type, out string declaredTypeName, out _)
                && IsSupportedCollectionType(declaredTypeName));

        return hasRewrittenCollectionInitializer
            ? rewritten.WithDeclaration(rewritten.Declaration.WithType(replacementType!))
            : rewritten;
    }

    public override SyntaxNode? VisitFieldDeclaration(FieldDeclarationSyntax node)
    {
        if (!emitTraceEvents)
        {
            return base.VisitFieldDeclaration(node);
        }

        FieldDeclarationSyntax rewritten = (FieldDeclarationSyntax)base.VisitFieldDeclaration(node)!;
        if (!IsRewritableCollectionField(node))
        {
            return rewritten;
        }

        if (!TryRewriteCollectionDeclarationType(rewritten.Declaration.Type, out TypeSyntax? replacementType))
        {
            return rewritten;
        }

        return rewritten.WithDeclaration(rewritten.Declaration.WithType(replacementType!));
    }

    private StatementSyntax RewriteCollectionAssignmentStatement(StatementSyntax statement, int line)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not AssignmentExpressionSyntax assignment
            || !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
            || !TryGetAssignedCollectionVariableName(assignment.Left, out string variableName))
        {
            return statement;
        }

        if (!TryRewriteCollectionCreation(assignment.Right, variableName, null, out ExpressionSyntax? replacement)
            && !TryRewriteCollectionFactoryAssignment(assignment.Right, variableName, line, out replacement)
            && !TryRewriteCollectionCompatibleAssignment(assignment.Right, variableName, line, out replacement))
        {
            return statement;
        }

        return expressionStatement.WithExpression(assignment.WithRight(replacement!));
    }

    private bool TryGetAssignedCollectionVariableName(ExpressionSyntax left, out string variableName)
    {
        if (left is IdentifierNameSyntax identifier
            && collectionVariables.Contains(identifier.Identifier.ValueText))
        {
            variableName = identifier.Identifier.ValueText;
            return true;
        }

        if (left is IdentifierNameSyntax implicitField
            && memberCollectionNames.Contains(implicitField.Identifier.ValueText)
            && !IsDeclaredLocalVariable(implicitField.Identifier.ValueText))
        {
            variableName = implicitField.Identifier.ValueText;
            return true;
        }

        if (left is MemberAccessExpressionSyntax memberAccess
            && TryGetMemberAccessPath(memberAccess, out string root, out List<string>? path)
            && IsDeclaredMemberCollectionPath(root, path))
        {
            variableName = path[0];
            return true;
        }

        variableName = string.Empty;
        return false;
    }

    private IEnumerable<StatementSyntax> CreateWriteStatements(StatementSyntax statement, int line)
    {
        if (statement is LocalDeclarationStatementSyntax localDeclaration)
        {
            foreach (VariableDeclaratorSyntax variable in localDeclaration.Declaration.Variables)
            {
                string name = variable.Identifier.ValueText;
                if (string.IsNullOrWhiteSpace(name) || variable.Initializer is null)
                {
                    continue;
                }

                yield return TraceStatement(
                    $"TraceCode.CSharpHost.RuntimeTraceSink.Write({Literal(name)}, {name}, {line});"
                );
            }
            yield break;
        }

        if (statement is ExpressionStatementSyntax expressionStatement)
        {
            if (expressionStatement.Expression is AssignmentExpressionSyntax assignment
                && assignment.Left is IdentifierNameSyntax identifier)
            {
                string name = identifier.Identifier.ValueText;
                if (ShouldEmitBareIdentifierWrite(name))
                {
                    yield return TraceStatement(
                        $"TraceCode.CSharpHost.RuntimeTraceSink.Write({Literal(name)}, {name}, {line});"
                    );
                }
                yield break;
            }

            if (expressionStatement.Expression is AssignmentExpressionSyntax deconstructionAssignment
                && IsDeconstructionAssignmentLeft(deconstructionAssignment.Left))
            {
                foreach (string name in GetDeconstructionAssignmentTargetNames(deconstructionAssignment.Left))
                {
                    if (ShouldEmitBareIdentifierWrite(name))
                    {
                        yield return TraceStatement(
                            $"TraceCode.CSharpHost.RuntimeTraceSink.Write({Literal(name)}, {name}, {line});"
                        );
                    }
                }
                yield break;
            }

            if (expressionStatement.Expression is PostfixUnaryExpressionSyntax postfix
                && postfix.Operand is IdentifierNameSyntax postfixIdentifier)
            {
                string name = postfixIdentifier.Identifier.ValueText;
                if (ShouldEmitBareIdentifierWrite(name))
                {
                    yield return TraceStatement(
                        $"TraceCode.CSharpHost.RuntimeTraceSink.Write({Literal(name)}, {name}, {line});"
                    );
                }
                yield break;
            }

            if (expressionStatement.Expression is PrefixUnaryExpressionSyntax prefix
                && prefix.Operand is IdentifierNameSyntax prefixIdentifier
                && (prefix.IsKind(SyntaxKind.PreIncrementExpression) || prefix.IsKind(SyntaxKind.PreDecrementExpression)))
            {
                string name = prefixIdentifier.Identifier.ValueText;
                if (ShouldEmitBareIdentifierWrite(name))
                {
                    yield return TraceStatement(
                        $"TraceCode.CSharpHost.RuntimeTraceSink.Write({Literal(name)}, {name}, {line});"
                    );
                }
                yield break;
            }
        }

        yield break;
    }

    private IEnumerable<StatementSyntax> CreateConstructorConsumptionReadStatements(StatementSyntax statement, int line)
    {
        foreach (string name in GetConstructorConsumptionReadNames(statement))
        {
            yield return TraceStatement(
                $"TraceCode.CSharpHost.RuntimeTraceSink.Read({Literal(name)}, {name}, {line});"
            );
        }
    }

    private IEnumerable<StatementSyntax> CreateScalarExpressionReadStatements(StatementSyntax statement, int line)
    {
        if (statement is not LocalDeclarationStatementSyntax localDeclaration)
        {
            yield break;
        }

        foreach (VariableDeclaratorSyntax variable in localDeclaration.Declaration.Variables)
        {
            if (variable.Initializer?.Value is not ExpressionSyntax initializer
                || !initializer.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>().Any())
            {
                continue;
            }

            foreach (string name in GetScalarReadIdentifierNames(initializer, variable.Identifier.ValueText))
            {
                yield return TraceStatement(
                    $"TraceCode.CSharpHost.RuntimeTraceSink.Read({Literal(name)}, {name}, {line});"
                );
            }
        }
    }

    private IEnumerable<StatementSyntax> CreateImplicitFieldAliasReadStatements(StatementSyntax statement, int line)
    {
        if (statement is not LocalDeclarationStatementSyntax localDeclaration)
        {
            yield break;
        }

        foreach (VariableDeclaratorSyntax variable in localDeclaration.Declaration.Variables)
        {
            if (variable.Initializer?.Value is not IdentifierNameSyntax initializer
                || !TryGetImplicitThisFieldPath(initializer, out string pathExpression))
            {
                continue;
            }

            string name = initializer.Identifier.ValueText;
            yield return TraceStatement(
                $"TraceCode.CSharpHost.RuntimeTraceSink.FieldRead({Literal("this")}, {pathExpression}, {name}, {line});"
            );
        }
    }

    private IEnumerable<StatementSyntax> CreateCollectionParameterMutationStatements(StatementSyntax statement, int line)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not InvocationExpressionSyntax invocation
            || invocation.Expression is not MemberAccessExpressionSyntax memberAccess
            || memberAccess.Expression is not IdentifierNameSyntax receiver
            || !collectionParameterVariables.Contains(receiver.Identifier.ValueText)
            || collectionVariables.Contains(receiver.Identifier.ValueText)
            || !IsIndexedReceiverMutationMethod(memberAccess.Name.Identifier.ValueText)
            || invocation.ArgumentList.Arguments.Any(argument => argument.NameColon is not null || argument.RefOrOutKeyword.RawKind != 0))
        {
            yield break;
        }

        string variable = receiver.Identifier.ValueText;
        string method = memberAccess.Name.Identifier.ValueText;
        string args = string.Join(", ", invocation.ArgumentList.Arguments.Select(argument => argument.Expression.ToString()));
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Mutate({Literal(variable)}, {Literal(method)}, new object?[] {{ {args} }}, {line});"
        );
    }

    private IEnumerable<StatementSyntax> CreateIdentifierReceiverMutationStatements(StatementSyntax statement, int line)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not InvocationExpressionSyntax invocation
            || invocation.Expression is not MemberAccessExpressionSyntax memberAccess
            || memberAccess.Expression is not IdentifierNameSyntax receiver
            || IsTrackedCollectionReceiver(receiver.Identifier.ValueText)
                && !interfaceDispatchedCollectionVariables.Contains(receiver.Identifier.ValueText)
            || collectionParameterVariables.Contains(receiver.Identifier.ValueText)
            || !string.Equals(memberAccess.Name.Identifier.ValueText, "Add", StringComparison.Ordinal)
            || invocation.ArgumentList.Arguments.Count != 1)
        {
            yield break;
        }

        string variable = receiver.Identifier.ValueText;
        string argument = invocation.ArgumentList.Arguments[0].Expression.ToString();
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Mutate({Literal(variable)}, {Literal("Add")}, new object?[] {{ {argument} }}, {line});"
        );
    }

    private IEnumerable<StatementSyntax> CreateIndexedReceiverMutationStatements(StatementSyntax statement, int line)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not InvocationExpressionSyntax invocation
            || invocation.Expression is not MemberAccessExpressionSyntax memberAccess
            || memberAccess.Expression is not ElementAccessExpressionSyntax receiver
            || receiver.Expression is not IdentifierNameSyntax identifier
            || !IsIndexedReceiverMutationMethod(memberAccess.Name.Identifier.ValueText)
            || receiver.ArgumentList.Arguments.Count != 1)
        {
            yield break;
        }

        string variable = identifier.Identifier.ValueText;
        string index = receiver.ArgumentList.Arguments[0].Expression.ToString();
        string args = string.Join(", ", invocation.ArgumentList.Arguments.Select(argument => argument.Expression.ToString()));
        string method = memberAccess.Name.Identifier.ValueText;
        string indexSourcesExpression = CreateIndexSourcesExpression(index);
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.IndexedRead({Literal(variable)}, {index}, null, {line}, {indexSourcesExpression});"
        );
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Mutate({Literal(variable)}, {index}, {Literal(method)}, new object?[] {{ {args} }}, {line}, {indexSourcesExpression});"
        );
    }

    private IEnumerable<StatementSyntax> CreateMemberReceiverMutationStatements(StatementSyntax statement, int line)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not InvocationExpressionSyntax invocation
            || invocation.Expression is not MemberAccessExpressionSyntax invocationMemberAccess
            || invocationMemberAccess.Expression is not MemberAccessExpressionSyntax receiver
            || !TryGetMemberAccessPath(receiver, out string variable, out List<string>? path))
        {
            yield break;
        }

        string method = invocationMemberAccess.Name.Identifier.ValueText;
        if (method is not ("Add" or "Remove")
            || method == "Remove" && !IsDeclaredMemberCollectionPath(variable, path))
        {
            yield break;
        }

        string pathExpression = CreateStringArrayExpression(path);
        string args = string.Join(", ", invocation.ArgumentList.Arguments.Select(argument => argument.Expression.ToString()));
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.FieldRead({receiver}, {Literal(variable)}, {pathExpression}, {line});"
        );
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Mutate({Literal(variable)}, {pathExpression}, {Literal(method)}, new object?[] {{ {args} }}, {line});"
        );
    }

    private IEnumerable<StatementSyntax> CreateFieldIndexedReceiverMutationStatements(StatementSyntax statement, int line)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not InvocationExpressionSyntax invocation
            || invocation.Expression is not MemberAccessExpressionSyntax invocationMemberAccess
            || invocationMemberAccess.Expression is not ElementAccessExpressionSyntax receiver
            || !string.Equals(invocationMemberAccess.Name.Identifier.ValueText, "Add", StringComparison.Ordinal)
            || !TryGetFieldElementAccessPath(receiver, out string variable, out List<string>? path, out string index))
        {
            yield break;
        }

        string pathExpression = CreateObjectArrayExpression(path, index);
        string args = string.Join(", ", invocation.ArgumentList.Arguments.Select(argument => argument.Expression.ToString()));
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.FieldRead({receiver}, {Literal(variable)}, {pathExpression}, {line});"
        );
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Mutate({Literal(variable)}, {pathExpression}, {Literal("Add")}, new object?[] {{ {args} }}, {line});"
        );
    }

    private IEnumerable<StatementSyntax> CreateIndexedFieldReceiverMutationStatements(StatementSyntax statement, int line)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not InvocationExpressionSyntax invocation
            || invocation.Expression is not MemberAccessExpressionSyntax invocationMemberAccess
            || invocationMemberAccess.Expression is not MemberAccessExpressionSyntax receiverField
            || receiverField.Expression is not ElementAccessExpressionSyntax elementAccess
            || elementAccess.Expression is not IdentifierNameSyntax identifier
            || elementAccess.ArgumentList.Arguments.Count != 1
            || !string.Equals(invocationMemberAccess.Name.Identifier.ValueText, "Add", StringComparison.Ordinal))
        {
            yield break;
        }

        string variable = identifier.Identifier.ValueText;
        string index = elementAccess.ArgumentList.Arguments[0].Expression.ToString();
        string field = receiverField.Name.Identifier.ValueText;
        string pathExpression = $"new object?[] {{ {index}, {Literal(field)} }}";
        string args = string.Join(", ", invocation.ArgumentList.Arguments.Select(argument => argument.Expression.ToString()));
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.FieldRead({receiverField}, {Literal(variable)}, {pathExpression}, {line});"
        );
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Mutate({Literal(variable)}, {pathExpression}, {Literal("Add")}, new object?[] {{ {args} }}, {line});"
        );
    }

    private IEnumerable<StatementSyntax> CreateStringBuilderMutationStatements(StatementSyntax statement, int line)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not InvocationExpressionSyntax invocation
            || invocation.Expression is not MemberAccessExpressionSyntax memberAccess
            || !IsStringBuilderMutationMethod(memberAccess.Name.Identifier.ValueText))
        {
            yield break;
        }

        string method = memberAccess.Name.Identifier.ValueText;
        if (memberAccess.Expression is IdentifierNameSyntax identifier
            && IsTrackedStringBuilderVariable(identifier.Identifier.ValueText))
        {
            yield return TraceStatement(
                $"TraceCode.Internal.TraceCodeTrace.Mutate({Literal(identifier.Identifier.ValueText)}, {Literal(method)}, System.Array.Empty<object?>(), {line});"
            );
            yield break;
        }

        if (memberAccess.Expression is MemberAccessExpressionSyntax receiver
            && TryGetMemberAccessPath(receiver, out string variable, out List<string>? path)
            && IsStringBuilderMemberPath(variable, path))
        {
            string pathExpression = CreateStringArrayExpression(path);
            yield return TraceStatement(
                $"TraceCode.Internal.TraceCodeTrace.Mutate({Literal(variable)}, {pathExpression}, {Literal(method)}, System.Array.Empty<object?>(), {line});"
            );
        }
    }

    private IEnumerable<StatementSyntax> CreateStaticArrayMutationStatements(StatementSyntax statement, int line)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not InvocationExpressionSyntax invocation
            || invocation.Expression is not MemberAccessExpressionSyntax memberAccess
            || !IsSystemArrayTypeExpression(memberAccess.Expression)
            || !IsStaticArrayMutationMethod(memberAccess.Name.Identifier.ValueText)
            || invocation.ArgumentList.Arguments.Count < 1
            || invocation.ArgumentList.Arguments[0].Expression is not IdentifierNameSyntax receiver)
        {
            yield break;
        }

        string method = memberAccess.Name.Identifier.ValueText;
        string variable = receiver.Identifier.ValueText;
        string args = string.Join(", ", invocation.ArgumentList.Arguments.Skip(1).Select(argument =>
            argument.Expression is AnonymousFunctionExpressionSyntax
                ? Literal("<lambda>")
                : argument.Expression.ToString()));
        string argsExpression = string.IsNullOrWhiteSpace(args)
            ? "System.Array.Empty<object?>()"
            : $"new object?[] {{ {args} }}";
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Mutate({Literal(variable)}, {Literal($"Array.{method}")}, {argsExpression}, {line});"
        );
    }

    private static bool IsSystemArrayTypeExpression(ExpressionSyntax expression)
    {
        string text = expression.ToString();
        return string.Equals(text, "Array", StringComparison.Ordinal)
            || string.Equals(text, "System.Array", StringComparison.Ordinal)
            || string.Equals(text, "global::System.Array", StringComparison.Ordinal);
    }

    private static bool IsStaticArrayMutationMethod(string method)
    {
        return method is "Sort" or "Reverse";
    }

    private bool ShouldEmitBareIdentifierWrite(string name)
    {
        return !string.IsNullOrWhiteSpace(name)
            && (IsDeclaredLocalVariable(name) || !memberNames.Contains(name));
    }

    private IEnumerable<string> GetScalarReadIdentifierNames(ExpressionSyntax expression, string declaredName)
    {
        return expression
            .DescendantNodesAndSelf()
            .OfType<IdentifierNameSyntax>()
            .Where(IsScalarReadIdentifier)
            .Select(identifier => identifier.Identifier.ValueText)
            .Where(name =>
                !string.IsNullOrWhiteSpace(name)
                && !string.Equals(name, declaredName, StringComparison.Ordinal)
                && ShouldEmitBareIdentifierWrite(name)
                && !collectionVariables.Contains(name)
                && !collectionParameterVariables.Contains(name))
            .Distinct(StringComparer.Ordinal);
    }

    private static bool IsScalarReadIdentifier(IdentifierNameSyntax identifier)
    {
        return identifier.Parent is not MemberAccessExpressionSyntax
            && identifier.Parent is not QualifiedNameSyntax
            && identifier.Ancestors().OfType<ArgumentSyntax>().Any(argument =>
                argument.Ancestors().OfType<InvocationExpressionSyntax>().Any())
            && !identifier.Ancestors().Any(ancestor =>
                ancestor is ParenthesizedLambdaExpressionSyntax
                    or SimpleLambdaExpressionSyntax
                    or AnonymousMethodExpressionSyntax);
    }

    private IEnumerable<string> GetConstructorConsumptionReadNames(StatementSyntax statement)
    {
        var declaredNames = new HashSet<string>(StringComparer.Ordinal);
        var expressions = new List<ExpressionSyntax>();

        if (statement is LocalDeclarationStatementSyntax localDeclaration)
        {
            foreach (VariableDeclaratorSyntax variable in localDeclaration.Declaration.Variables)
            {
                declaredNames.Add(variable.Identifier.ValueText);
                if (variable.Initializer?.Value is ExpressionSyntax initializer)
                {
                    expressions.Add(initializer);
                }
            }
        }
        else if (statement is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax assignment })
        {
            expressions.Add(assignment.Right);
        }

        return expressions
            .SelectMany(GetConstructorConsumptionIdentifierNames)
            .Where(name =>
                !declaredNames.Contains(name)
                && !string.IsNullOrWhiteSpace(name)
                && (ShouldEmitBareIdentifierWrite(name) || collectionVariables.Contains(name) || collectionParameterVariables.Contains(name)))
            .Distinct(StringComparer.Ordinal);
    }

    private static IEnumerable<string> GetConstructorConsumptionIdentifierNames(ExpressionSyntax expression)
    {
        return expression
            .DescendantNodesAndSelf()
            .Where(node => node is ObjectCreationExpressionSyntax or ImplicitObjectCreationExpressionSyntax)
            .SelectMany(GetObjectCreationArguments)
            .SelectMany(argument => argument.Expression.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>())
            .Where(IsConstructorConsumptionIdentifier)
            .Select(identifier => identifier.Identifier.ValueText);
    }

    private static IEnumerable<ArgumentSyntax> GetObjectCreationArguments(SyntaxNode creation)
    {
        return creation switch
        {
            ObjectCreationExpressionSyntax objectCreation => objectCreation.ArgumentList?.Arguments ?? default,
            ImplicitObjectCreationExpressionSyntax implicitCreation => implicitCreation.ArgumentList.Arguments,
            _ => Enumerable.Empty<ArgumentSyntax>(),
        };
    }

    private static bool IsConstructorConsumptionIdentifier(IdentifierNameSyntax identifier)
    {
        return identifier.Parent is not MemberAccessExpressionSyntax
            && identifier.Parent is not QualifiedNameSyntax
            && !identifier.Ancestors().Any(ancestor =>
                ancestor is ParenthesizedLambdaExpressionSyntax
                    or SimpleLambdaExpressionSyntax
                    or AnonymousMethodExpressionSyntax);
    }

    private void RegisterDeclaredVariables(StatementSyntax statement)
    {
        if (variableScopes.Count == 0)
        {
            return;
        }

        if (statement is LocalDeclarationStatementSyntax localDeclaration)
        {
            HashSet<string> currentScope = variableScopes.Peek();
            HashSet<string> currentDeclarations = declaredLocalVariables.Peek();
            foreach (VariableDeclaratorSyntax variable in localDeclaration.Declaration.Variables)
            {
                currentDeclarations.Add(variable.Identifier.ValueText);
                if (variable.Initializer is not null)
                {
                    currentScope.Add(variable.Identifier.ValueText);
                }
            }
        }

        if (statement is ExpressionStatementSyntax expressionStatement
            && expressionStatement.Expression is AssignmentExpressionSyntax assignment
            && assignment.Left is IdentifierNameSyntax identifier)
        {
            string name = identifier.Identifier.ValueText;
            if (IsDeclaredLocalVariable(name) || !memberNames.Contains(name))
            {
                variableScopes.Peek().Add(name);
            }
        }

        if (statement is ExpressionStatementSyntax deconstructionStatement
            && deconstructionStatement.Expression is AssignmentExpressionSyntax deconstructionAssignment
            && IsDeconstructionAssignmentLeft(deconstructionAssignment.Left))
        {
            HashSet<string> currentScope = variableScopes.Peek();
            HashSet<string> currentDeclarations = declaredLocalVariables.Peek();
            foreach (string name in GetDeconstructionDeclarationNames(deconstructionAssignment.Left))
            {
                currentDeclarations.Add(name);
                currentScope.Add(name);
            }
        }

        RegisterStringBuilderAssignment(statement);
    }

    private IEnumerable<StatementSyntax> CreateSnapshotStatements(int line)
    {
        if (variableScopes.Count == 0)
        {
            yield break;
        }

        foreach (string name in variableScopes.Reverse().SelectMany(scope => scope).Distinct(StringComparer.Ordinal))
        {
            yield return TraceStatement(
                $"TraceCode.Internal.TraceCodeTrace.Snapshot({Literal(name)}, {name}, {line});"
            );
        }
    }

    private string CreateSnapshotActionExpression(int line, IReadOnlySet<string>? excludedNames = null)
    {
        if (variableScopes.Count == 0)
        {
            return "() => { }";
        }

        IEnumerable<string> snapshots = variableScopes
            .Reverse()
            .SelectMany(scope => scope)
            .Distinct(StringComparer.Ordinal)
            .Where(name => excludedNames is null || !excludedNames.Contains(name))
            .Select(name => $"TraceCode.Internal.TraceCodeTrace.Snapshot({Literal(name)}, {name}, {line});");
        return $"() => {{ {string.Join(" ", snapshots)} }}";
    }

    private StatementSyntax RewriteArrayWriteStatement(StatementSyntax statement, int line)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not AssignmentExpressionSyntax assignment
            || assignment.Left is not ElementAccessExpressionSyntax elementAccess)
        {
            return statement;
        }
        line = GetAssignmentWriteLineOrFallback(assignment, line);

        if (TryGetNestedElementAccess(elementAccess, out string nestedVariable, out string firstIndex, out string secondIndex))
        {
            if (IsRangeIndex(firstIndex) || IsRangeIndex(secondIndex))
            {
                return statement;
            }

            string nestedValueExpression = assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                ? assignment.Right.ToString()
                : CreateCompoundNestedArrayValueExpression(assignment, nestedVariable, firstIndex, secondIndex, line);
            if (string.IsNullOrWhiteSpace(nestedValueExpression))
            {
                return statement;
            }

            return TraceStatement(
                $"TraceCode.Internal.TraceCodeTrace.ArrayWrite({nestedVariable}, {firstIndex}, {secondIndex}, {nestedValueExpression}, {Literal(nestedVariable)}, {line}, {CreateIndexSourcesExpression(firstIndex, secondIndex)});"
            );
        }

        if (elementAccess.Expression is IdentifierNameSyntax rectangularIdentifier
            && !collectionVariables.Contains(rectangularIdentifier.Identifier.ValueText)
            && IsSupportedRectangularRank(elementAccess.ArgumentList.Arguments.Count))
        {
            string rectangularArrayExpression = elementAccess.Expression.ToString();
            List<string> indexExpressions = GetArgumentExpressions(elementAccess.ArgumentList.Arguments);
            if (indexExpressions.Any(IsRangeIndex))
            {
                return statement;
            }

            string rectangularValueExpression = assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                ? assignment.Right.ToString()
                : CreateCompoundRectangularArrayValueExpression(
                    assignment,
                    rectangularArrayExpression,
                    indexExpressions,
                    rectangularIdentifier.Identifier.ValueText,
                    line
                );
            if (string.IsNullOrWhiteSpace(rectangularValueExpression))
            {
                return statement;
            }

            return TraceStatement(
                $"TraceCode.Internal.TraceCodeTrace.ArrayWrite({rectangularArrayExpression}, {string.Join(", ", indexExpressions)}, {rectangularValueExpression}, {Literal(rectangularIdentifier.Identifier.ValueText)}, {line}, {CreateIndexSourcesExpression(indexExpressions)});"
            );
        }

        if (elementAccess.Expression is not IdentifierNameSyntax identifier
            || elementAccess.ArgumentList.Arguments.Count != 1)
        {
            return statement;
        }

        string arrayExpression = elementAccess.Expression.ToString();
        string sourceIndexExpression = elementAccess.ArgumentList.Arguments[0].Expression.ToString();
        string runtimeIndexExpression = ((ExpressionSyntax)Visit(elementAccess.ArgumentList.Arguments[0].Expression)!).ToString();
        if (IsRangeIndex(sourceIndexExpression))
        {
            return statement;
        }

        string valueExpression = assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
            ? assignment.Right.ToString()
            : CreateCompoundArrayValueExpression(assignment, arrayExpression, runtimeIndexExpression, identifier.Identifier.ValueText, line);
        if (string.IsNullOrWhiteSpace(valueExpression))
        {
            return statement;
        }

        return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.ArrayWrite({arrayExpression}, {runtimeIndexExpression}, {valueExpression}, {Literal(identifier.Identifier.ValueText)}, {line}, {CreateIndexSourcesExpression(sourceIndexExpression)});"
        );
    }

    private StatementSyntax RewriteFieldIndexedWriteStatement(StatementSyntax statement, int line)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not AssignmentExpressionSyntax assignment
            || !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
            || assignment.Left is not ElementAccessExpressionSyntax elementAccess
            || !TryGetFieldElementAccessPath(elementAccess, out string variable, out List<string>? path, out string index))
        {
            return statement;
        }
        line = GetAssignmentWriteLineOrFallback(assignment, line);

        string left = elementAccess.ToString();
        string pathExpression = CreateObjectArrayExpression(path, index);
        string indexSourcesExpression = CreateFieldIndexSourcesExpression(path, index);
        if (assignment.Right.IsKind(SyntaxKind.NullLiteralExpression))
        {
            return TraceStatement(
                $"{{ TraceCode.CSharpHost.RuntimeTraceSink.FieldWrite({Literal(variable)}, {pathExpression}, null, {line}, {indexSourcesExpression}); {left} = null; }}"
            );
        }

        string right = assignment.Right.ToString();
        return TraceStatement(
            $"{left} = TraceCode.Internal.TraceCodeTrace.FieldWrite({right}, {Literal(variable)}, {pathExpression}, {line}, {indexSourcesExpression});"
        );
    }

    private StatementSyntax RewriteArrayUnaryWriteStatement(StatementSyntax statement, int line)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not PrefixUnaryExpressionSyntax and not PostfixUnaryExpressionSyntax)
        {
            return statement;
        }

        ExpressionSyntax operand = expressionStatement.Expression switch
        {
            PrefixUnaryExpressionSyntax prefix => prefix.Operand,
            PostfixUnaryExpressionSyntax postfix => postfix.Operand,
            _ => throw new InvalidOperationException("Unsupported unary expression."),
        };

        if (operand is not ElementAccessExpressionSyntax elementAccess)
        {
            return statement;
        }

        string operatorText = expressionStatement.Expression.Kind() switch
        {
            SyntaxKind.PreIncrementExpression or SyntaxKind.PostIncrementExpression => "+",
            SyntaxKind.PreDecrementExpression or SyntaxKind.PostDecrementExpression => "-",
            _ => string.Empty,
        };
        if (operatorText.Length == 0)
        {
            return statement;
        }

        if (TryGetNestedElementAccess(elementAccess, out string nestedVariable, out string firstIndex, out string secondIndex))
        {
            if (IsRangeIndex(firstIndex) || IsRangeIndex(secondIndex))
            {
                return statement;
            }

            string nestedIndexSourcesExpression = CreateIndexSourcesExpression(firstIndex, secondIndex);
            string currentNestedValue = $"TraceCode.Internal.TraceCodeTrace.ArrayRead({nestedVariable}, {firstIndex}, {secondIndex}, {Literal(nestedVariable)}, {line}, {nestedIndexSourcesExpression})";
            return TraceStatement(
                $"TraceCode.Internal.TraceCodeTrace.ArrayWrite({nestedVariable}, {firstIndex}, {secondIndex}, {currentNestedValue} {operatorText} 1, {Literal(nestedVariable)}, {line}, {nestedIndexSourcesExpression});"
            );
        }

        if (elementAccess.Expression is IdentifierNameSyntax rectangularIdentifier
            && !collectionVariables.Contains(rectangularIdentifier.Identifier.ValueText)
            && IsSupportedRectangularRank(elementAccess.ArgumentList.Arguments.Count))
        {
            string rectangularArrayExpression = elementAccess.Expression.ToString();
            List<string> indexExpressions = GetArgumentExpressions(elementAccess.ArgumentList.Arguments);
            if (indexExpressions.Any(IsRangeIndex))
            {
                return statement;
            }

            string rectangularVariableName = rectangularIdentifier.Identifier.ValueText;
            string rectangularIndexSourcesExpression = CreateIndexSourcesExpression(indexExpressions);
            string rectangularCurrentValue =
                $"TraceCode.Internal.TraceCodeTrace.ArrayRead({rectangularArrayExpression}, {string.Join(", ", indexExpressions)}, {Literal(rectangularVariableName)}, {line}, {rectangularIndexSourcesExpression})";
            return TraceStatement(
                $"TraceCode.Internal.TraceCodeTrace.ArrayWrite({rectangularArrayExpression}, {string.Join(", ", indexExpressions)}, {rectangularCurrentValue} {operatorText} 1, {Literal(rectangularVariableName)}, {line}, {rectangularIndexSourcesExpression});"
            );
        }

        if (elementAccess.Expression is not IdentifierNameSyntax identifier
            || collectionVariables.Contains(identifier.Identifier.ValueText)
            || elementAccess.ArgumentList.Arguments.Count != 1)
        {
            return statement;
        }

        string arrayExpression = elementAccess.Expression.ToString();
        string indexExpression = elementAccess.ArgumentList.Arguments[0].Expression.ToString();
        if (IsRangeIndex(indexExpression))
        {
            return statement;
        }

        string variableName = identifier.Identifier.ValueText;
        string indexSourcesExpression = CreateIndexSourcesExpression(indexExpression);
        string currentValue = $"TraceCode.Internal.TraceCodeTrace.ArrayRead({arrayExpression}, {indexExpression}, {Literal(variableName)}, {line}, {indexSourcesExpression})";
        return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.ArrayWrite({arrayExpression}, {indexExpression}, {currentValue} {operatorText} 1, {Literal(variableName)}, {line}, {indexSourcesExpression});"
        );
    }

    private StatementSyntax RewriteFieldWriteStatement(StatementSyntax statement, int line)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not AssignmentExpressionSyntax assignment
            || !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression))
        {
            return statement;
        }

        if (assignment.Left is IdentifierNameSyntax identifier
            && TryGetImplicitThisFieldPath(identifier, out string implicitThisPathExpression))
        {
            string left = identifier.ToString();
            if (assignment.Right.IsKind(SyntaxKind.NullLiteralExpression))
            {
                return TraceStatement(
                    $"{{ TraceCode.CSharpHost.RuntimeTraceSink.FieldWrite({Literal("this")}, {implicitThisPathExpression}, null, {line}); {left} = null; }}"
                );
            }

            string implicitRight = assignment.Right.ToString();
            return TraceStatement(
                $"{left} = TraceCode.Internal.TraceCodeTrace.FieldWrite({implicitRight}, {Literal("this")}, {implicitThisPathExpression}, {line});"
            );
        }

        if (assignment.Left is not MemberAccessExpressionSyntax memberAccess
            || !TryGetMemberAccessPath(memberAccess, out string variable, out List<string>? path))
        {
            return statement;
        }

        string memberLeft = memberAccess.ToString();
        string pathExpression = CreateStringArrayExpression(path);
        if (assignment.Right.IsKind(SyntaxKind.NullLiteralExpression))
        {
            return TraceStatement(
                $"{{ TraceCode.CSharpHost.RuntimeTraceSink.FieldWrite({Literal(variable)}, {pathExpression}, null, {line}); {memberLeft} = null; }}"
            );
        }

        string right = assignment.Right.ToString();
        return TraceStatement(
            $"{memberLeft} = TraceCode.Internal.TraceCodeTrace.FieldWrite({right}, {Literal(variable)}, {pathExpression}, {line});"
        );
    }

    private static bool IsAssignmentLeft(SyntaxNode node)
    {
        return node.Parent is AssignmentExpressionSyntax assignment && assignment.Left == node;
    }

    private static bool IsWithinAssignmentLeftChain(SyntaxNode node)
    {
        SyntaxNode current = node;
        while (current.Parent is MemberAccessExpressionSyntax parentMember && parentMember.Expression == current)
        {
            current = parentMember;
        }

        return IsAssignmentLeft(current);
    }

    private static bool IsWithinElementAccessAssignmentLeftChain(SyntaxNode node)
    {
        SyntaxNode current = node;
        while (current.Parent is ElementAccessExpressionSyntax parentElement && parentElement.Expression == current)
        {
            current = parentElement;
        }

        return IsAssignmentLeft(current);
    }

    private static bool IsWithinTupleAssignmentLeft(SyntaxNode node)
    {
        SyntaxNode current = node;
        while (true)
        {
            if (current.Parent is ElementAccessExpressionSyntax parentElement && parentElement.Expression == current)
            {
                current = parentElement;
                continue;
            }

            if (current.Parent is MemberAccessExpressionSyntax parentMember && parentMember.Expression == current)
            {
                current = parentMember;
                continue;
            }

            break;
        }

        return current.Parent is ArgumentSyntax argument
            && argument.Parent is TupleExpressionSyntax tuple
            && tuple.Parent is AssignmentExpressionSyntax assignment
            && assignment.Left == tuple;
    }

    private static bool IsWithinElementAccessUnaryMutationChain(SyntaxNode node)
    {
        SyntaxNode current = node;
        while (current.Parent is ElementAccessExpressionSyntax parentElement && parentElement.Expression == current)
        {
            current = parentElement;
        }

        return IsUnaryMutationOperand(current);
    }

    private static bool IsUnaryMutationOperand(SyntaxNode node)
    {
        return node.Parent is PrefixUnaryExpressionSyntax prefix
            && (prefix.IsKind(SyntaxKind.PreIncrementExpression) || prefix.IsKind(SyntaxKind.PreDecrementExpression))
            || node.Parent is PostfixUnaryExpressionSyntax postfix
            && (postfix.IsKind(SyntaxKind.PostIncrementExpression) || postfix.IsKind(SyntaxKind.PostDecrementExpression));
    }

    private static bool IsCollectionMutationInvocationReceiver(SyntaxNode node)
    {
        return node.Parent is MemberAccessExpressionSyntax memberAccess
            && memberAccess.Expression == node
            && IsIndexedReceiverMutationMethod(memberAccess.Name.Identifier.ValueText)
            && memberAccess.Parent is InvocationExpressionSyntax;
    }

    private static bool IsInvocationMethodAccess(SyntaxNode node)
    {
        return node.Parent is InvocationExpressionSyntax invocation
            && invocation.Expression == node;
    }

    private static bool IsCollectionMetadataAccess(MemberAccessExpressionSyntax node)
    {
        return node.Expression is not ElementAccessExpressionSyntax
            && IsCollectionMetadataMember(node.Name.Identifier.ValueText);
    }

    private static bool IsCollectionMetadataMember(string memberName)
    {
        return memberName is "Length" or "LongLength" or "Rank" or "Count";
    }

    private static bool IsRangeIndex(string expression)
    {
        return expression.Contains("..", StringComparison.Ordinal)
            || expression.StartsWith("^", StringComparison.Ordinal);
    }

    private static bool IsStringBuilderCreation(ExpressionSyntax creation, TypeSyntax? declaredType)
    {
        TypeSyntax? creationType = creation switch
        {
            ObjectCreationExpressionSyntax objectCreation => objectCreation.Type,
            ImplicitObjectCreationExpressionSyntax => declaredType,
            _ => null,
        };

        return IsStringBuilderType(creationType);
    }

    private static bool IsStringBuilderType(TypeSyntax? type)
    {
        if (type is null)
        {
            return false;
        }

        return type switch
        {
            IdentifierNameSyntax identifier => string.Equals(identifier.Identifier.ValueText, "StringBuilder", StringComparison.Ordinal),
            QualifiedNameSyntax qualified => string.Equals(qualified.Right.Identifier.ValueText, "StringBuilder", StringComparison.Ordinal),
            AliasQualifiedNameSyntax aliasQualified => string.Equals(aliasQualified.Name.Identifier.ValueText, "StringBuilder", StringComparison.Ordinal),
            NullableTypeSyntax nullable => IsStringBuilderType(nullable.ElementType),
            _ => false,
        };
    }

    private static bool IsStringBuilderMutationMethod(string method)
    {
        return method is "Append" or "AppendFormat" or "AppendJoin" or "AppendLine" or "Clear" or "Insert" or "Remove" or "Replace";
    }

    private static bool IsIndexedReceiverMutationMethod(string method)
    {
        return method is "Add" or "AddLast" or "AddFirst" or "Append" or "AppendLine" or "Clear" or "Dequeue" or "Enqueue" or "Insert" or "Pop" or "Push" or "Remove" or "RemoveAt" or "RemoveFirst" or "RemoveLast" or "Replace";
    }

    private static bool IsIndexedReceiverReadMethod(string method)
    {
        return method is "Peek";
    }

    private static bool IsTrackedCollectionWrapperMethod(string method)
    {
        return IsIndexedReceiverMutationMethod(method) || IsIndexedReceiverReadMethod(method) || method is "Contains" or "TryGetValue";
    }

    private static bool IsInsideTraceCodeSourceLineScope(SyntaxNode node)
    {
        return node.Ancestors().OfType<InvocationExpressionSyntax>().Any(invocation =>
            invocation.Expression is MemberAccessExpressionSyntax memberAccess
            && string.Equals(memberAccess.Name.Identifier.ValueText, "WithSourceLine", StringComparison.Ordinal)
        );
    }

    private static bool IsInsideAnonymousFunction(SyntaxNode node)
    {
        return node.Ancestors().Any(ancestor =>
            ancestor is ParenthesizedLambdaExpressionSyntax
                or SimpleLambdaExpressionSyntax
                or AnonymousMethodExpressionSyntax
        );
    }

    private static bool ContainsPatternDeclaration(ExpressionSyntax expression)
    {
        return expression
            .DescendantNodesAndSelf()
            .Any(node => node is DeclarationPatternSyntax or RecursivePatternSyntax or DeclarationExpressionSyntax);
    }

    private bool TryGetMemberAccessPath(
        MemberAccessExpressionSyntax memberAccess,
        out string variable,
        out List<string> path
    )
    {
        path = new List<string>();
        ExpressionSyntax current = memberAccess;

        while (current is MemberAccessExpressionSyntax currentMember)
        {
            string field = currentMember.Name.Identifier.ValueText;
            path.Insert(0, field);
            current = currentMember.Expression;
        }

        if (current is IdentifierNameSyntax identifier)
        {
            variable = identifier.Identifier.ValueText;
            return path.Count > 0 && IsTraceableValueRoot(variable);
        }

        if (current is ThisExpressionSyntax)
        {
            variable = "this";
            return path.Count > 0;
        }

        variable = string.Empty;
        path.Clear();
        return false;
    }

    private bool IsTraceableValueRoot(string variable)
    {
        if (memberNames.Contains(variable))
        {
            return true;
        }

        return variableScopes.Any(scope => scope.Contains(variable));
    }

    private void TrackStringBuilderVariable(string variable)
    {
        if (stringBuilderScopes.Count > 0)
        {
            stringBuilderScopes.Peek().Add(variable);
        }
    }

    private void RegisterStringBuilderAssignment(StatementSyntax statement)
    {
        if (statement is ExpressionStatementSyntax expressionStatement
            && expressionStatement.Expression is AssignmentExpressionSyntax assignment
            && assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
            && assignment.Left is IdentifierNameSyntax identifier
            && IsStringBuilderCreation(assignment.Right, null))
        {
            TrackStringBuilderVariable(identifier.Identifier.ValueText);
        }
    }

    private bool IsTrackedStringBuilderVariable(string variable)
    {
        if (stringBuilderScopes.Any(scope => scope.Contains(variable)))
        {
            return true;
        }

        return memberStringBuilderNames.Contains(variable) && !IsDeclaredLocalVariable(variable);
    }

    private bool IsStringBuilderMemberPath(string variable, IReadOnlyList<string> path)
    {
        return string.Equals(variable, "this", StringComparison.Ordinal)
            && path.Count == 1
            && memberStringBuilderNames.Contains(path[0]);
    }

    private bool IsDeclaredLocalVariable(string variable)
    {
        return declaredLocalVariables.Any(scope => scope.Contains(variable));
    }

    private bool TryGetImplicitThisFieldPath(IdentifierNameSyntax identifier, out string pathExpression)
    {
        string name = identifier.Identifier.ValueText;
        if (!memberNames.Contains(name) || IsDeclaredLocalVariable(name))
        {
            pathExpression = string.Empty;
            return false;
        }

        pathExpression = CreateStringArrayExpression(new[] { name });
        return true;
    }

    private bool IsTrackedCollectionReceiver(string variable)
    {
        return collectionVariables.Contains(variable)
            || memberCollectionNames.Contains(variable) && !IsDeclaredLocalVariable(variable);
    }

    private bool IsDeclaredMemberCollectionPath(string variable, IReadOnlyList<string> path)
    {
        return string.Equals(variable, "this", StringComparison.Ordinal)
            && path.Count == 1
            && memberCollectionNames.Contains(path[0]);
    }

    private static bool IsNonRewritableCollectionFieldDeclarator(VariableDeclaratorSyntax variable)
    {
        return variable.Parent?.Parent is FieldDeclarationSyntax fieldDeclaration
            && !IsRewritableCollectionField(fieldDeclaration);
    }

    private static bool IsRewritableCollectionField(FieldDeclarationSyntax fieldDeclaration)
    {
        if (fieldDeclaration.Parent is ClassDeclarationSyntax classDeclaration
            && string.Equals(classDeclaration.Identifier.ValueText, "Solution", StringComparison.Ordinal))
        {
            return true;
        }

        return IsPrivateInitializedCollectionBackingField(fieldDeclaration);
    }

    private static bool IsPrivateInitializedCollectionBackingField(FieldDeclarationSyntax fieldDeclaration)
    {
        if (!fieldDeclaration.Modifiers.Any(SyntaxKind.PrivateKeyword)
            || fieldDeclaration.Modifiers.Any(SyntaxKind.StaticKeyword)
            || !TryGetGenericType(fieldDeclaration.Declaration.Type, out string typeName, out _)
            || !IsSupportedCollectionType(typeName))
        {
            return false;
        }

        return fieldDeclaration.Declaration.Variables.Count > 0
            && fieldDeclaration.Declaration.Variables.All(variable =>
                variable.Initializer is null
                || variable.Initializer.Value is ExpressionSyntax initializer
                    && IsSupportedCollectionInitializer(initializer, fieldDeclaration.Declaration.Type));
    }

    private static bool TryGetNestedElementAccess(
        ElementAccessExpressionSyntax elementAccess,
        out string variable,
        out string firstIndex,
        out string secondIndex
    )
    {
        variable = string.Empty;
        firstIndex = string.Empty;
        secondIndex = string.Empty;

        if (elementAccess.Expression is not ElementAccessExpressionSyntax innerAccess
            || innerAccess.Expression is not IdentifierNameSyntax identifier
            || innerAccess.ArgumentList.Arguments.Count != 1
            || elementAccess.ArgumentList.Arguments.Count != 1)
        {
            return false;
        }

        variable = identifier.Identifier.ValueText;
        firstIndex = innerAccess.ArgumentList.Arguments[0].Expression.ToString();
        secondIndex = elementAccess.ArgumentList.Arguments[0].Expression.ToString();
        return true;
    }

    private bool TryGetFieldElementAccessPath(
        ElementAccessExpressionSyntax elementAccess,
        out string variable,
        out List<string> path,
        out string index
    )
    {
        variable = string.Empty;
        path = new List<string>();
        index = string.Empty;

        if (elementAccess.Expression is not MemberAccessExpressionSyntax memberAccess
            || elementAccess.ArgumentList.Arguments.Count != 1
            || !TryGetMemberAccessPath(memberAccess, out variable, out path))
        {
            return false;
        }

        index = elementAccess.ArgumentList.Arguments[0].Expression.ToString();
        return true;
    }

    private bool TryGetIdentifierElementAccessPath(
        ElementAccessExpressionSyntax elementAccess,
        out string variable,
        out string index
    )
    {
        variable = string.Empty;
        index = string.Empty;

        if (elementAccess.Expression is not IdentifierNameSyntax identifier
            || elementAccess.ArgumentList.Arguments.Count != 1
            || !IsTraceableValueRoot(identifier.Identifier.ValueText))
        {
            return false;
        }

        variable = identifier.Identifier.ValueText;
        index = elementAccess.ArgumentList.Arguments[0].Expression.ToString();
        return true;
    }

    private static string CreateStringArrayExpression(IReadOnlyList<string> values)
    {
        return $"new string[] {{ {string.Join(", ", values.Select(Literal))} }}";
    }

    private static string CreateObjectArrayExpression(IReadOnlyList<string> values, string finalExpression)
    {
        return $"new object?[] {{ {string.Join(", ", values.Select(Literal).Append(finalExpression))} }}";
    }

    private static string CreateObjectArrayExpression(IReadOnlyList<string> values, params string[] finalExpressions)
    {
        return $"new object?[] {{ {string.Join(", ", values.Select(Literal).Concat(finalExpressions))} }}";
    }

    private static string CreateCompoundArrayValueExpression(
        AssignmentExpressionSyntax assignment,
        string arrayExpression,
        string indexExpression,
        string variableName,
        int line
    )
    {
        string operatorText = assignment.Kind() switch
        {
            SyntaxKind.AddAssignmentExpression => "+",
            SyntaxKind.SubtractAssignmentExpression => "-",
            SyntaxKind.MultiplyAssignmentExpression => "*",
            SyntaxKind.DivideAssignmentExpression => "/",
            SyntaxKind.ModuloAssignmentExpression => "%",
            _ => string.Empty,
        };

        if (operatorText.Length == 0)
        {
            return string.Empty;
        }

        return $"{CreateArrayReadExpression(arrayExpression, indexExpression, variableName, line)} {operatorText} {assignment.Right}";
    }

    private static string CreateCompoundNestedArrayValueExpression(
        AssignmentExpressionSyntax assignment,
        string variableName,
        string firstIndex,
        string secondIndex,
        int line
    )
    {
        string operatorText = assignment.Kind() switch
        {
            SyntaxKind.AddAssignmentExpression => "+",
            SyntaxKind.SubtractAssignmentExpression => "-",
            SyntaxKind.MultiplyAssignmentExpression => "*",
            SyntaxKind.DivideAssignmentExpression => "/",
            SyntaxKind.ModuloAssignmentExpression => "%",
            _ => string.Empty,
        };

        if (operatorText.Length == 0)
        {
            return string.Empty;
        }

        return $"TraceCode.Internal.TraceCodeTrace.ArrayRead({variableName}, {firstIndex}, {secondIndex}, {Literal(variableName)}, {line}) {operatorText} {assignment.Right}";
    }

    private static string CreateCompoundRectangularArrayValueExpression(
        AssignmentExpressionSyntax assignment,
        string arrayExpression,
        IReadOnlyList<string> indexExpressions,
        string variableName,
        int line
    )
    {
        string operatorText = assignment.Kind() switch
        {
            SyntaxKind.AddAssignmentExpression => "+",
            SyntaxKind.SubtractAssignmentExpression => "-",
            SyntaxKind.MultiplyAssignmentExpression => "*",
            SyntaxKind.DivideAssignmentExpression => "/",
            SyntaxKind.ModuloAssignmentExpression => "%",
            _ => string.Empty,
        };

        if (operatorText.Length == 0)
        {
            return string.Empty;
        }

        return $"{CreateRectangularArrayReadExpression(arrayExpression, indexExpressions, variableName, line)} {operatorText} {assignment.Right}";
    }

    private static string CreateArrayReadExpression(
        string arrayExpression,
        string indexExpression,
        string variableName,
        int line
    )
    {
        return $"TraceCode.Internal.TraceCodeTrace.ArrayRead({arrayExpression}, {indexExpression}, {Literal(variableName)}, {line})";
    }

    private static string CreateRectangularArrayReadExpression(
        string arrayExpression,
        IReadOnlyList<string> indexExpressions,
        string variableName,
        int line
    )
    {
        return $"TraceCode.Internal.TraceCodeTrace.ArrayRead({arrayExpression}, {string.Join(", ", indexExpressions)}, {Literal(variableName)}, {line})";
    }

    private static List<string> GetArgumentExpressions(SeparatedSyntaxList<ArgumentSyntax> arguments)
    {
        return arguments.Select(argument => argument.Expression.ToString()).ToList();
    }

    private static string CreateIndexSourcesExpression(params string[] indexExpressions)
    {
        return CreateIndexSourcesExpression((IReadOnlyList<string>)indexExpressions);
    }

    private static string CreateIndexSourcesExpression(IReadOnlyList<string> indexExpressions)
    {
        string[] sources = indexExpressions
            .Select(expression => CreateIndexSourceLiteral(expression))
            .ToArray();
        return $"new string?[] {{ {string.Join(", ", sources)} }}";
    }

    private static string CreateIndexSourceLiteral(string indexExpression)
    {
        string? source = NormalizeIndexSourceExpression(indexExpression);
        return source is not null ? Literal(source) : "null";
    }

    private static string CreateFieldIndexSourcesExpression(IReadOnlyList<string> fieldPath, params string[] indexExpressions)
    {
        List<string> sources = fieldPath.Select(_ => "null").ToList();
        sources.AddRange(indexExpressions.Select(expression => CreateIndexSourceLiteral(expression)));
        return $"new string?[] {{ {string.Join(", ", sources)} }}";
    }

    private static string CreateIndexedMetadataIndexSourcesExpression(string indexExpression)
    {
        return $"new string?[] {{ {CreateIndexSourceLiteral(indexExpression)}, null }}";
    }

    private static string CreateFieldIndexedMetadataIndexSourcesExpression(IReadOnlyList<string> fieldPath, string indexExpression)
    {
        List<string> sources = fieldPath.Select(_ => "null").ToList();
        sources.Add(CreateIndexSourceLiteral(indexExpression));
        sources.Add("null");
        return $"new string?[] {{ {string.Join(", ", sources)} }}";
    }

    private static string? NormalizeIndexSourceExpression(string expression)
    {
        string trimmed = expression.Trim();
        if (trimmed.Length == 0) return null;

        ExpressionSyntax parsed;
        try
        {
            parsed = SyntaxFactory.ParseExpression(trimmed);
        }
        catch
        {
            return null;
        }

        return IsSafeIndexSourceExpression(parsed) ? trimmed : null;
    }

    private static bool IsSafeIndexSourceExpression(ExpressionSyntax expression)
    {
        return expression switch
        {
            IdentifierNameSyntax => true,
            LiteralExpressionSyntax literal => literal.IsKind(SyntaxKind.NumericLiteralExpression)
                || literal.IsKind(SyntaxKind.StringLiteralExpression)
                || literal.IsKind(SyntaxKind.CharacterLiteralExpression),
            ThisExpressionSyntax => true,
            ParenthesizedExpressionSyntax parenthesized => IsSafeIndexSourceExpression(parenthesized.Expression),
            PrefixUnaryExpressionSyntax prefix => (prefix.IsKind(SyntaxKind.UnaryPlusExpression)
                    || prefix.IsKind(SyntaxKind.UnaryMinusExpression))
                && IsSafeIndexSourceExpression(prefix.Operand),
            MemberAccessExpressionSyntax memberAccess => IsSafeIndexSourceExpression(memberAccess.Expression),
            InvocationExpressionSyntax invocation => invocation.Expression is MemberAccessExpressionSyntax invocationMemberAccess
                && invocation.ArgumentList.Arguments.Count == 0
                && IsSafeIndexSourceExpression(invocationMemberAccess),
            ElementAccessExpressionSyntax elementAccess => IsSafeIndexSourceExpression(elementAccess.Expression)
                && elementAccess.ArgumentList.Arguments.Count == 1
                && elementAccess.ArgumentList.Arguments[0].NameColon is null
                && elementAccess.ArgumentList.Arguments[0].RefKindKeyword.RawKind == 0
                && IsSafeIndexSourceExpression(elementAccess.ArgumentList.Arguments[0].Expression),
            BinaryExpressionSyntax binary => IsSafeIndexSourceBinaryOperator(binary.Kind())
                && IsSafeIndexSourceExpression(binary.Left)
                && IsSafeIndexSourceExpression(binary.Right),
            _ => false,
        };
    }

    private static bool IsSafeIndexSourceBinaryOperator(SyntaxKind kind)
    {
        return kind is SyntaxKind.AddExpression
            or SyntaxKind.SubtractExpression
            or SyntaxKind.MultiplyExpression
            or SyntaxKind.DivideExpression
            or SyntaxKind.ModuloExpression;
    }

    private static bool IsSupportedRectangularRank(int argumentCount)
    {
        return argumentCount is 2 or 3;
    }

    private void TrackCollectionVariable(string variableName, TypeSyntax? declaredType, ExpressionSyntax creation)
    {
        TypeSyntax? collectionType = GetCollectionCreationType(creation, declaredType);
        if (collectionType is not null
            && TryGetGenericType(collectionType, out string typeName, out string typeArguments)
            && IsSupportedCollectionType(typeName))
        {
            collectionVariableTypes[variableName] = (typeName, typeArguments);
        }
    }

    private static TypeSyntax? GetCollectionCreationType(ExpressionSyntax creation, TypeSyntax? declaredType)
    {
        return creation switch
        {
            ObjectCreationExpressionSyntax objectCreation => objectCreation.Type,
            ImplicitObjectCreationExpressionSyntax => declaredType,
            _ => null,
        };
    }

    private static bool ShouldEmitExplicitCollectionMutationForDeclaredType(TypeSyntax? declaredType)
    {
        if (declaredType is null || IsVarType(declaredType))
        {
            return false;
        }

        return !TryRewriteCollectionDeclarationType(declaredType, out _);
    }

    private static bool IsVarType(TypeSyntax type)
    {
        return type is IdentifierNameSyntax identifier
            && string.Equals(identifier.Identifier.ValueText, "var", StringComparison.Ordinal);
    }

    private bool TryRewriteCollectionFactoryAssignment(
        ExpressionSyntax value,
        string variableName,
        int line,
        out ExpressionSyntax? replacement
    )
    {
        replacement = null;
        if (!collectionVariableTypes.TryGetValue(variableName, out var collectionType)
            || value is not InvocationExpressionSyntax invocation
            || !IsCollectionFactoryInvocation(collectionType.TypeName, invocation)
            || GetTraceCollectionTypeName(collectionType.TypeName) is not string wrapperType)
        {
            return false;
        }

        replacement = SyntaxFactory.ParseExpression(
            $"new TraceCode.Internal.{wrapperType}<{collectionType.TypeArguments}>({Literal(variableName)}, {line}, {value})"
        );
        return true;
    }

    private bool TryRewriteCollectionCompatibleAssignment(
        ExpressionSyntax value,
        string variableName,
        int line,
        out ExpressionSyntax? replacement
    )
    {
        replacement = null;
        if (!collectionVariableTypes.TryGetValue(variableName, out var collectionType)
            || value.IsKind(SyntaxKind.NullLiteralExpression)
            || value is DefaultExpressionSyntax
            || GetTraceCollectionTypeName(collectionType.TypeName) is not string wrapperType)
        {
            return false;
        }

        replacement = SyntaxFactory.ParseExpression(
            $"new TraceCode.Internal.{wrapperType}<{collectionType.TypeArguments}>({Literal(variableName)}, {line}, {value})"
        );
        return true;
    }

    private static bool IsCollectionFactoryInvocation(string typeName, InvocationExpressionSyntax invocation)
    {
        if (invocation.Expression is not MemberAccessExpressionSyntax memberAccess)
        {
            return false;
        }

        string methodName = memberAccess.Name.Identifier.ValueText;
        return typeName switch
        {
            "List" => methodName is "GetRange" or "ToList",
            "Dictionary" => methodName is "ToDictionary",
            "HashSet" => methodName is "ToHashSet",
            _ => false,
        };
    }

    private static string? GetTraceCollectionTypeName(string typeName)
    {
        return typeName switch
        {
            "List" => "TraceCodeList",
            "Dictionary" => "TraceCodeDictionary",
            "HashSet" => "TraceCodeHashSet",
            "Queue" => "TraceCodeQueue",
            "PriorityQueue" => "TraceCodePriorityQueue",
            "LinkedList" => "TraceCodeLinkedList",
            "Stack" => "TraceCodeStack",
            _ => null,
        };
    }

    private static bool TryRewriteCollectionCreation(
        ExpressionSyntax creation,
        string variableName,
        TypeSyntax? declaredType,
        out ExpressionSyntax? replacement
    )
    {
        replacement = null;

        TypeSyntax? collectionType = GetCollectionCreationType(creation, declaredType);
        if (collectionType is null)
        {
            return false;
        }

        SeparatedSyntaxList<ArgumentSyntax> arguments = creation switch
        {
            ObjectCreationExpressionSyntax objectCreation => objectCreation.ArgumentList?.Arguments ?? default,
            ImplicitObjectCreationExpressionSyntax implicitCreation => implicitCreation.ArgumentList.Arguments,
            _ => default,
        };
        if (arguments.Count > 2)
        {
            return false;
        }

        if (!TryGetGenericType(collectionType, out string typeName, out string typeArguments))
        {
            return false;
        }

        InitializerExpressionSyntax? initializerSyntax = creation switch
        {
            ObjectCreationExpressionSyntax objectCreation => objectCreation.Initializer,
            ImplicitObjectCreationExpressionSyntax implicitCreation => implicitCreation.Initializer,
            _ => null,
        };

        int line = GetLine(creation);
        string constructorArguments = arguments.Count == 0
            ? string.Empty
            : ", " + string.Join(", ", arguments.Select(argument => argument.ToString()));
        string initializer = initializerSyntax is null
            ? string.Empty
            : $" {initializerSyntax}";
        string? wrapperType = GetTraceCollectionTypeName(typeName);
        replacement = wrapperType is null
            ? null
            : SyntaxFactory.ParseExpression(
                $"new TraceCode.Internal.{wrapperType}<{typeArguments}>({Literal(variableName)}, {line}{constructorArguments}){initializer}"
            );

        return replacement is not null;
    }

    private static bool TryRewriteCollectionDeclarationType(TypeSyntax type, out TypeSyntax? replacement)
    {
        replacement = null;
        if (!TryGetGenericType(type, out string typeName, out string typeArguments))
        {
            return false;
        }

        replacement = typeName switch
        {
            "List" => SyntaxFactory.ParseTypeName($"TraceCode.Internal.TraceCodeList<{typeArguments}>"),
            "Dictionary" => SyntaxFactory.ParseTypeName($"TraceCode.Internal.TraceCodeDictionary<{typeArguments}>"),
            "HashSet" => SyntaxFactory.ParseTypeName($"TraceCode.Internal.TraceCodeHashSet<{typeArguments}>"),
            "Queue" => SyntaxFactory.ParseTypeName($"TraceCode.Internal.TraceCodeQueue<{typeArguments}>"),
            "PriorityQueue" => SyntaxFactory.ParseTypeName($"TraceCode.Internal.TraceCodePriorityQueue<{typeArguments}>"),
            "LinkedList" => SyntaxFactory.ParseTypeName($"TraceCode.Internal.TraceCodeLinkedList<{typeArguments}>"),
            "Stack" => SyntaxFactory.ParseTypeName($"TraceCode.Internal.TraceCodeStack<{typeArguments}>"),
            _ => null,
        };

        return replacement is not null;
    }

    private static bool TryGetGenericType(TypeSyntax type, out string typeName, out string typeArguments)
    {
        typeName = string.Empty;
        typeArguments = string.Empty;

        GenericNameSyntax? genericName = type switch
        {
            GenericNameSyntax direct => direct,
            QualifiedNameSyntax { Right: GenericNameSyntax right } => right,
            AliasQualifiedNameSyntax { Name: GenericNameSyntax aliasRight } => aliasRight,
            _ => null,
        };

        if (genericName is null)
        {
            return false;
        }

        typeName = genericName.Identifier.ValueText;
        typeArguments = string.Join(", ", genericName.TypeArgumentList.Arguments.Select(argument => argument.ToString()));
        return true;
    }

    private static bool IsSupportedCollectionType(string typeName)
    {
        return typeName is "List" or "Dictionary" or "HashSet" or "Queue" or "PriorityQueue" or "LinkedList" or "Stack";
    }

    private static StatementSyntax TraceStatement(string source)
    {
        return SyntaxFactory.ParseStatement(source);
    }

    private static StatementSyntax AddTimeoutCheck(StatementSyntax statement)
    {
        StatementSyntax checkStatement = TraceStatement("TraceCode.Internal.TraceCodeTrace.CheckTimeout();");

        if (statement is BlockSyntax block)
        {
            return block.WithStatements(block.Statements.Insert(0, checkStatement));
        }

        return SyntaxFactory.Block(checkStatement, statement);
    }

    private StatementSyntax ExpandEmbeddedLoopStatement(StatementSyntax statement, StatementSyntax originalStatement, int fallbackLine)
    {
        if (!emitTraceEvents || methodNames.Count == 0 || statement is BlockSyntax)
        {
            return statement;
        }

        int line = GetEmbeddedStatementLineOrFallback(originalStatement, fallbackLine);
        return SyntaxFactory.Block(SyntaxFactory.List(ExpandStatement(statement, line)));
    }

    private StatementSyntax AddLoopHeaderTrace(StatementSyntax statement, int line, string methodName, bool emitLine = true)
    {
        var headerStatements = new List<StatementSyntax>();
        if (emitLine)
        {
            headerStatements.Add(TraceStatement($"TraceCode.Internal.TraceCodeTrace.Line({line}, {Literal(methodName)});"));
        }
        headerStatements.AddRange(CreateSnapshotStatements(line));
        headerStatements.Add(TraceStatement("TraceCode.Internal.TraceCodeTrace.CheckTimeout();"));

        if (statement is BlockSyntax block)
        {
            return block.WithStatements(block.Statements.InsertRange(0, headerStatements));
        }

        return SyntaxFactory.Block(headerStatements.Append(statement));
    }

    private static int GetLine(SyntaxNode node)
    {
        FileLinePositionSpan span = node.SyntaxTree.GetLineSpan(node.Span);
        return span.StartLinePosition.Line + 1;
    }

    private static int GetLine(SyntaxToken token)
    {
        FileLinePositionSpan span = token.SyntaxTree!.GetLineSpan(token.Span);
        return span.StartLinePosition.Line + 1;
    }

    private static int GetLineOrFallback(SyntaxNode node, int fallbackLine)
    {
        int line = GetLine(node);
        return line > fallbackLine ? line : fallbackLine;
    }

    private static int GetAssignmentWriteLineOrFallback(AssignmentExpressionSyntax assignment, int fallbackLine)
    {
        int operatorLine = GetLine(assignment.OperatorToken);
        return operatorLine > fallbackLine ? operatorLine : fallbackLine;
    }

    private int GetUnbracedIfBodyLineOrFallback(IfStatementSyntax ifStatement, int fallbackLine)
    {
        if (ifStatement.Statement is BlockSyntax)
        {
            return fallbackLine;
        }

        SourceText sourceText = originalSourceText;
        int conditionLineIndex = Math.Max(0, fallbackLine - 1);
        while (conditionLineIndex < sourceText.Lines.Count)
        {
            string candidate = sourceText.Lines[conditionLineIndex].ToString().TrimStart();
            if (candidate.StartsWith("if", StringComparison.Ordinal))
            {
                fallbackLine = conditionLineIndex + 1;
                break;
            }
            if (!string.IsNullOrWhiteSpace(candidate) && candidate is not "{" and not "}")
            {
                break;
            }
            conditionLineIndex++;
        }

        conditionLineIndex = Math.Max(0, fallbackLine - 1);
        if (conditionLineIndex < sourceText.Lines.Count)
        {
            string conditionLine = sourceText.Lines[conditionLineIndex].ToString();
            int closeParenIndex = conditionLine.LastIndexOf(')');
            if (closeParenIndex >= 0 && closeParenIndex + 1 < conditionLine.Length)
            {
                string trailingBody = conditionLine[(closeParenIndex + 1)..].Trim();
                if (!string.IsNullOrWhiteSpace(trailingBody))
                {
                    return fallbackLine;
                }
            }
        }

        for (int index = fallbackLine; index < sourceText.Lines.Count; index++)
        {
            string trimmed = sourceText.Lines[index].ToString().Trim();
            if (string.IsNullOrWhiteSpace(trimmed) || trimmed is "{" or "}")
            {
                continue;
            }
            return index + 1;
        }

        return fallbackLine;
    }

    private static int GetIfConditionLineOrFallback(IfStatementSyntax ifStatement, int fallbackLine)
    {
        int? rewrittenAccessLine = TryGetRewrittenTraceLine(ifStatement.Condition);
        if (rewrittenAccessLine is > 0 && rewrittenAccessLine.Value > fallbackLine)
        {
            return rewrittenAccessLine.Value;
        }

        int ifKeywordLine = GetLine(ifStatement.IfKeyword);
        if (ifKeywordLine > fallbackLine)
        {
            return ifKeywordLine;
        }

        int? concreteConditionLine = ifStatement.Condition
            .DescendantNodesAndSelf()
            .Select(GetLine)
            .Where(line => line > fallbackLine)
            .DefaultIfEmpty()
            .Min();
        if (concreteConditionLine is > 0)
        {
            return concreteConditionLine.Value;
        }

        return GetLineOrFallback(ifStatement.Condition, fallbackLine);
    }

    private static int? TryGetRewrittenTraceLine(SyntaxNode node)
    {
        string source = node.ToString();
        Match sourceLineScopeMatch = Regex.Match(
            source,
            @"TraceCode\.Internal\.TraceCodeTrace\.WithSourceLine\(\s*(\d+)\s*,"
        );
        if (sourceLineScopeMatch.Success && int.TryParse(sourceLineScopeMatch.Groups[1].Value, out int scopedLine))
        {
            return scopedLine;
        }

        Match traceCallLineMatch = Regex.Match(
            source,
            @"TraceCode\.Internal\.TraceCodeTrace\.[A-Za-z]+\([^;]*?,\s*(\d+)\s*\)"
        );
        if (traceCallLineMatch.Success && int.TryParse(traceCallLineMatch.Groups[1].Value, out int line))
        {
            return line;
        }

        return null;
    }

    private static int? GetNextExecutableLineIfStatementIsNotOnFallbackLine(StatementSyntax statement, int fallbackLine)
    {
        string statementText = statement.ToString().Trim();
        if (string.IsNullOrWhiteSpace(statementText) || statement.SyntaxTree is null)
        {
            return null;
        }

        SourceText sourceText = statement.SyntaxTree.GetText();
        string fallbackLineText = sourceText.Lines.Count >= fallbackLine
            ? sourceText.Lines[fallbackLine - 1].ToString()
            : string.Empty;
        if (fallbackLineText.Contains(statementText, StringComparison.Ordinal))
        {
            return null;
        }

        for (int index = fallbackLine; index < sourceText.Lines.Count; index++)
        {
            string trimmed = sourceText.Lines[index].ToString().Trim();
            if (string.IsNullOrWhiteSpace(trimmed) || trimmed is "{" or "}")
            {
                continue;
            }
            return index + 1;
        }

        return null;
    }

    private static string Literal(string value)
    {
        return SymbolDisplay.FormatLiteral(value, true);
    }
}

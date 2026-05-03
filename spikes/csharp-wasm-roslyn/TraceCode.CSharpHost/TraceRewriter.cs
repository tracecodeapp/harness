using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace TraceCode.CSharpHost;

public sealed class TraceRewriter : CSharpSyntaxRewriter
{
    private readonly Stack<string> methodNames = new();
    private readonly Stack<HashSet<string>> variableScopes = new();
    private readonly Stack<HashSet<string>> declaredLocalVariables = new();
    private readonly HashSet<string> collectionVariables = new(StringComparer.Ordinal);
    private readonly HashSet<string> collectionParameterVariables = new(StringComparer.Ordinal);
    private readonly HashSet<string> memberNames;
    private readonly bool emitTraceEvents;
    private int returnValueCounter;
    private int exceptionValueCounter;
    private int conditionValueCounter;

    private TraceRewriter(bool emitTraceEvents, IEnumerable<string> memberNames)
    {
        this.emitTraceEvents = emitTraceEvents;
        this.memberNames = memberNames.ToHashSet(StringComparer.Ordinal);
    }

    public static SyntaxTree Instrument(SyntaxTree userTree, bool emitTraceEvents)
    {
        CompilationUnitSyntax root = userTree.GetCompilationUnitRoot();
        var rewriter = new TraceRewriter(emitTraceEvents, GetDeclaredMemberNames(root));
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

    public override SyntaxNode? VisitMethodDeclaration(MethodDeclarationSyntax node)
    {
        if (node.Body is null && node.ExpressionBody is null)
        {
            return base.VisitMethodDeclaration(node);
        }

        MethodDeclarationSyntax methodNode = ConvertExpressionBodiedMethod(node);
        List<string> wrappedCollectionParameters = GetRewritableCollectionParameterNames(methodNode).ToList();
        if (wrappedCollectionParameters.Count > 0)
        {
            methodNode = methodNode.WithParameterList(RewriteCollectionParameterTypes(methodNode.ParameterList, wrappedCollectionParameters.ToHashSet(StringComparer.Ordinal)));
            foreach (string collectionParameter in wrappedCollectionParameters)
            {
                collectionVariables.Add(collectionParameter);
            }
        }

        methodNames.Push(methodNode.Identifier.ValueText);
        variableScopes.Push(new HashSet<string>(
            methodNode.ParameterList.Parameters.Select(parameter => parameter.Identifier.ValueText),
            StringComparer.Ordinal
        ));
        declaredLocalVariables.Push(new HashSet<string>(
            methodNode.ParameterList.Parameters.Select(parameter => parameter.Identifier.ValueText),
            StringComparer.Ordinal
        ));
        List<string> collectionParameters = GetCollectionParameterNames(methodNode).ToList();
        foreach (string collectionParameter in collectionParameters)
        {
            collectionParameterVariables.Add(collectionParameter);
        }

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
            foreach (string collectionParameter in wrappedCollectionParameters)
            {
                collectionVariables.Remove(collectionParameter);
            }
            declaredLocalVariables.Pop();
            variableScopes.Pop();
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
            statements = statements.Add(CreateImplicitReturnStatement(node.Identifier.ValueText, line));
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

        ConstructorDeclarationSyntax rewritten;
        try
        {
            rewritten = (ConstructorDeclarationSyntax)base.VisitConstructorDeclaration(node)!;
        }
        finally
        {
            declaredLocalVariables.Pop();
            variableScopes.Pop();
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
            .Add(CreateImplicitReturnStatement(node.Identifier.ValueText, line));
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
        variableScopes.Push(new HashSet<string>(
            localFunctionNode.ParameterList.Parameters.Select(parameter => parameter.Identifier.ValueText),
            StringComparer.Ordinal
        ));
        declaredLocalVariables.Push(new HashSet<string>(
            localFunctionNode.ParameterList.Parameters.Select(parameter => parameter.Identifier.ValueText),
            StringComparer.Ordinal
        ));
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
            statements = statements.Add(CreateImplicitReturnStatement(localFunctionNode.Identifier.ValueText, line));
        }

        return rewritten.WithBody(rewritten.Body.WithStatements(statements));
    }

    public override SyntaxNode? VisitParenthesizedLambdaExpression(ParenthesizedLambdaExpressionSyntax node)
    {
        return node;
    }

    public override SyntaxNode? VisitSimpleLambdaExpression(SimpleLambdaExpressionSyntax node)
    {
        return node;
    }

    public override SyntaxNode? VisitAnonymousMethodExpression(AnonymousMethodExpressionSyntax node)
    {
        return node;
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
                && HasSupportedLocalCollectionInitializer(containingMethod, identifier.Identifier.ValueText))
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

    private static bool HasSupportedLocalCollectionInitializer(MethodDeclarationSyntax method, string variableName)
    {
        foreach (VariableDeclaratorSyntax variable in method.Body?.DescendantNodes().OfType<VariableDeclaratorSyntax>() ?? Enumerable.Empty<VariableDeclaratorSyntax>())
        {
            if (!string.Equals(variable.Identifier.ValueText, variableName, StringComparison.Ordinal)
                || variable.Initializer?.Value is not ExpressionSyntax initializer)
            {
                continue;
            }

            TypeSyntax? declaredType = (variable.Parent as VariableDeclarationSyntax)?.Type;
            if (initializer is ObjectCreationExpressionSyntax objectCreation
                && TryGetGenericType(objectCreation.Type, out string createdTypeName, out _)
                && IsSupportedCollectionType(createdTypeName))
            {
                return true;
            }

            if (initializer is ImplicitObjectCreationExpressionSyntax
                && declaredType is not null
                && TryGetGenericType(declaredType, out string declaredTypeName, out _)
                && IsSupportedCollectionType(declaredTypeName))
            {
                return true;
            }
        }

        return false;
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

    public override SyntaxNode? VisitBlock(BlockSyntax node)
    {
        if (methodNames.Count == 0)
        {
            return base.VisitBlock(node);
        }

        variableScopes.Push(new HashSet<string>(StringComparer.Ordinal));
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

        if (statement is WhileStatementSyntax)
        {
            yield return statement;
            yield break;
        }

        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Line({line}, {Literal(methodName)});"
        );

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
                    RewriteArrayWriteStatement(statement, line),
                    line
                ),
                line
            ),
            line
        );
        yield return executableStatement;

        RegisterDeclaredVariables(executableStatement);
        foreach (StatementSyntax writeStatement in CreateWriteStatements(executableStatement, line))
        {
            yield return writeStatement;
        }
        foreach (StatementSyntax mutationStatement in CreateCollectionParameterMutationStatements(executableStatement))
        {
            yield return mutationStatement;
        }
        foreach (StatementSyntax mutationStatement in CreateIdentifierReceiverMutationStatements(executableStatement))
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
            yield return returnStatement;
            yield break;
        }

        string tempName = $"__tracecode_return_{returnValueCounter++}";
        yield return TraceStatement($"var {tempName} = {returnStatement.Expression};");
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Return({Literal(methodName)}, {line}, {tempName});"
        );
        foreach (StatementSyntax snapshotStatement in CreateSnapshotStatements(line))
        {
            yield return snapshotStatement;
        }
        yield return TraceStatement($"return {tempName};");
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
        IfStatementSyntax expandedIfStatement = ExpandIfEmbeddedStatements(ifStatement);
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

    private IfStatementSyntax ExpandIfEmbeddedStatements(IfStatementSyntax ifStatement)
    {
        IfStatementSyntax expanded = ifStatement.WithStatement(ExpandEmbeddedStatement(ifStatement.Statement));
        if (ifStatement.Else is { Statement: StatementSyntax elseStatement } elseClause)
        {
            expanded = expanded.WithElse(elseClause.WithStatement(ExpandEmbeddedStatement(elseStatement)));
        }

        return expanded;
    }

    private StatementSyntax ExpandEmbeddedStatement(StatementSyntax statement)
    {
        if (statement is BlockSyntax)
        {
            return statement;
        }

        int line = GetLine(statement);
        return SyntaxFactory.Block(ExpandStatement(statement, line));
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
            || IsAddInvocationReceiver(node))
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
                $"TraceCode.Internal.TraceCodeTrace.ArrayRead({nestedVariable}, {firstIndex}, {secondIndex}, {Literal(nestedVariable)}, {nestedLine})"
            );
        }

        if (TryGetFieldElementAccessPath(node, out string fieldVariable, out List<string>? fieldPath, out string fieldIndex))
        {
            int fieldLine = GetLine(node);
            string pathExpression = CreateObjectArrayExpression(fieldPath, fieldIndex);
            return SyntaxFactory.ParseExpression(
                $"TraceCode.Internal.TraceCodeTrace.FieldRead({node}, {Literal(fieldVariable)}, {pathExpression}, {fieldLine})"
            );
        }

        var rewritten = (ElementAccessExpressionSyntax)base.VisitElementAccessExpression(node)!;
        if (rewritten.Expression is IdentifierNameSyntax rectangularIdentifier
            && !collectionVariables.Contains(rectangularIdentifier.Identifier.ValueText)
            && rewritten.ArgumentList.Arguments.Count == 2)
        {
            int rectangularLine = GetLine(node);
            string rectangularArrayExpression = rewritten.Expression.ToString();
            string rowExpression = rewritten.ArgumentList.Arguments[0].Expression.ToString();
            string columnExpression = rewritten.ArgumentList.Arguments[1].Expression.ToString();
            if (IsRangeIndex(rowExpression) || IsRangeIndex(columnExpression))
            {
                return rewritten;
            }

            return SyntaxFactory.ParseExpression(
                $"TraceCode.Internal.TraceCodeTrace.ArrayRead({rectangularArrayExpression}, {rowExpression}, {columnExpression}, {Literal(rectangularIdentifier.Identifier.ValueText)}, {rectangularLine})"
            );
        }

        if (rewritten.Expression is not IdentifierNameSyntax identifier
            || collectionVariables.Contains(identifier.Identifier.ValueText)
            || rewritten.ArgumentList.Arguments.Count != 1)
        {
            return rewritten;
        }

        int line = GetLine(node);
        string arrayExpression = rewritten.Expression.ToString();
        string indexExpression = rewritten.ArgumentList.Arguments[0].Expression.ToString();
        if (IsRangeIndex(indexExpression))
        {
            return rewritten;
        }

        return SyntaxFactory.ParseExpression(
            $"TraceCode.Internal.TraceCodeTrace.ArrayRead({arrayExpression}, {indexExpression}, {Literal(identifier.Identifier.ValueText)}, {line})"
        );
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
            || IsAddInvocationReceiver(node)
            || IsCollectionMetadataAccess(node))
        {
            return node;
        }

        if (IsInvocationMethodAccess(node))
        {
            return base.VisitMemberAccessExpression(node);
        }

        if (!TryGetMemberAccessPath(node, out string variable, out List<string>? path))
        {
            return base.VisitMemberAccessExpression(node);
        }

        int line = GetLine(node);
        string pathExpression = CreateStringArrayExpression(path.Take(1).ToList());
        return SyntaxFactory.ParseExpression(
            $"TraceCode.Internal.TraceCodeTrace.FieldRead({node}, {Literal(variable)}, {pathExpression}, {line})"
        );
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
            return rewritten.WithStatement(AddTimeoutCheck(rewritten.Statement));
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
        }
    }

    public override SyntaxNode? VisitForEachStatement(ForEachStatementSyntax node)
    {
        var rewritten = (ForEachStatementSyntax)base.VisitForEachStatement(node)!;
        return rewritten.WithStatement(AddTimeoutCheck(rewritten.Statement));
    }

    public override SyntaxNode? VisitWhileStatement(WhileStatementSyntax node)
    {
        var rewritten = (WhileStatementSyntax)base.VisitWhileStatement(node)!;
        if (!emitTraceEvents || methodNames.Count == 0)
        {
            return rewritten.WithStatement(AddTimeoutCheck(rewritten.Statement));
        }

        int line = GetLine(node);
        string methodName = methodNames.Peek();
        var conditionStatements = new List<StatementSyntax>
        {
            TraceStatement($"TraceCode.Internal.TraceCodeTrace.Line({line}, {Literal(methodName)});"),
        };
        conditionStatements.AddRange(CreateSnapshotStatements(line));
        conditionStatements.Add(TraceStatement("TraceCode.Internal.TraceCodeTrace.CheckTimeout();"));

        StatementSyntax body = rewritten.Statement is BlockSyntax block
            ? block.WithStatements(block.Statements.InsertRange(0, conditionStatements))
            : SyntaxFactory.Block(conditionStatements.Append(rewritten.Statement));

        return rewritten.WithStatement(body);
    }

    public override SyntaxNode? VisitDoStatement(DoStatementSyntax node)
    {
        var rewritten = (DoStatementSyntax)base.VisitDoStatement(node)!;
        return rewritten.WithStatement(AddTimeoutCheck(rewritten.Statement));
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

        if (rewritten.Initializer?.Value is not ExpressionSyntax creation
            || !TryRewriteCollectionCreation(creation, rewritten.Identifier.ValueText, declaredType, out ExpressionSyntax? replacement))
        {
            return rewritten;
        }

        collectionVariables.Add(node.Identifier.ValueText);
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

    private static IEnumerable<StatementSyntax> CreateWriteStatements(StatementSyntax statement, int line)
    {
        yield break;
    }

    private IEnumerable<StatementSyntax> CreateCollectionParameterMutationStatements(StatementSyntax statement)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not InvocationExpressionSyntax invocation
            || invocation.Expression is not MemberAccessExpressionSyntax memberAccess
            || memberAccess.Expression is not IdentifierNameSyntax receiver
            || !collectionParameterVariables.Contains(receiver.Identifier.ValueText)
            || collectionVariables.Contains(receiver.Identifier.ValueText)
            || invocation.ArgumentList.Arguments.Any(argument => argument.NameColon is not null || argument.RefOrOutKeyword.RawKind != 0))
        {
            yield break;
        }

        string variable = receiver.Identifier.ValueText;
        string method = memberAccess.Name.Identifier.ValueText;
        string args = string.Join(", ", invocation.ArgumentList.Arguments.Select(argument => argument.Expression.ToString()));
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Mutate({Literal(variable)}, {Literal(method)}, new object?[] {{ {args} }});"
        );
    }

    private IEnumerable<StatementSyntax> CreateIdentifierReceiverMutationStatements(StatementSyntax statement)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not InvocationExpressionSyntax invocation
            || invocation.Expression is not MemberAccessExpressionSyntax memberAccess
            || memberAccess.Expression is not IdentifierNameSyntax receiver
            || collectionVariables.Contains(receiver.Identifier.ValueText)
            || collectionParameterVariables.Contains(receiver.Identifier.ValueText)
            || !string.Equals(memberAccess.Name.Identifier.ValueText, "Add", StringComparison.Ordinal)
            || invocation.ArgumentList.Arguments.Count != 1)
        {
            yield break;
        }

        string variable = receiver.Identifier.ValueText;
        string argument = invocation.ArgumentList.Arguments[0].Expression.ToString();
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Mutate({Literal(variable)}, {Literal("Add")}, new object?[] {{ {argument} }});"
        );
    }

    private IEnumerable<StatementSyntax> CreateIndexedReceiverMutationStatements(StatementSyntax statement, int line)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not InvocationExpressionSyntax invocation
            || invocation.Expression is not MemberAccessExpressionSyntax memberAccess
            || memberAccess.Expression is not ElementAccessExpressionSyntax receiver
            || receiver.Expression is not IdentifierNameSyntax identifier
            || !string.Equals(memberAccess.Name.Identifier.ValueText, "Add", StringComparison.Ordinal)
            || receiver.ArgumentList.Arguments.Count != 1)
        {
            yield break;
        }

        string variable = identifier.Identifier.ValueText;
        string index = receiver.ArgumentList.Arguments[0].Expression.ToString();
        string args = string.Join(", ", invocation.ArgumentList.Arguments.Select(argument => argument.Expression.ToString()));
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.IndexedRead({Literal(variable)}, {index}, null, {line});"
        );
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Mutate({Literal(variable)}, {index}, {Literal("Add")}, new object?[] {{ {args} }});"
        );
    }

    private IEnumerable<StatementSyntax> CreateMemberReceiverMutationStatements(StatementSyntax statement, int line)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not InvocationExpressionSyntax invocation
            || invocation.Expression is not MemberAccessExpressionSyntax invocationMemberAccess
            || invocationMemberAccess.Expression is not MemberAccessExpressionSyntax receiver
            || !string.Equals(invocationMemberAccess.Name.Identifier.ValueText, "Add", StringComparison.Ordinal)
            || !TryGetMemberAccessPath(receiver, out string variable, out List<string>? path))
        {
            yield break;
        }

        string pathExpression = CreateStringArrayExpression(path);
        string args = string.Join(", ", invocation.ArgumentList.Arguments.Select(argument => argument.Expression.ToString()));
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.FieldRead({receiver}, {Literal(variable)}, {pathExpression}, {line});"
        );
        yield return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.Mutate({Literal(variable)}, {pathExpression}, {Literal("Add")}, new object?[] {{ {args} }});"
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
            $"TraceCode.Internal.TraceCodeTrace.Mutate({Literal(variable)}, {pathExpression}, {Literal("Add")}, new object?[] {{ {args} }});"
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
            $"TraceCode.Internal.TraceCodeTrace.Mutate({Literal(variable)}, {pathExpression}, {Literal("Add")}, new object?[] {{ {args} }});"
        );
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

    private StatementSyntax RewriteArrayWriteStatement(StatementSyntax statement, int line)
    {
        if (statement is not ExpressionStatementSyntax expressionStatement
            || expressionStatement.Expression is not AssignmentExpressionSyntax assignment
            || assignment.Left is not ElementAccessExpressionSyntax elementAccess)
        {
            return statement;
        }

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
                $"TraceCode.Internal.TraceCodeTrace.ArrayWrite({nestedVariable}, {firstIndex}, {secondIndex}, {nestedValueExpression}, {Literal(nestedVariable)}, {line});"
            );
        }

        if (elementAccess.Expression is IdentifierNameSyntax rectangularIdentifier
            && !collectionVariables.Contains(rectangularIdentifier.Identifier.ValueText)
            && elementAccess.ArgumentList.Arguments.Count == 2)
        {
            string rectangularArrayExpression = elementAccess.Expression.ToString();
            string rowExpression = elementAccess.ArgumentList.Arguments[0].Expression.ToString();
            string columnExpression = elementAccess.ArgumentList.Arguments[1].Expression.ToString();
            if (IsRangeIndex(rowExpression) || IsRangeIndex(columnExpression))
            {
                return statement;
            }

            string rectangularValueExpression = assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                ? assignment.Right.ToString()
                : CreateCompoundNestedArrayValueExpression(assignment, rectangularIdentifier.Identifier.ValueText, rowExpression, columnExpression, line);
            if (string.IsNullOrWhiteSpace(rectangularValueExpression))
            {
                return statement;
            }

            return TraceStatement(
                $"TraceCode.Internal.TraceCodeTrace.ArrayWrite({rectangularArrayExpression}, {rowExpression}, {columnExpression}, {rectangularValueExpression}, {Literal(rectangularIdentifier.Identifier.ValueText)}, {line});"
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

        string valueExpression = assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
            ? assignment.Right.ToString()
            : CreateCompoundArrayValueExpression(assignment, arrayExpression, indexExpression, identifier.Identifier.ValueText, line);
        if (string.IsNullOrWhiteSpace(valueExpression))
        {
            return statement;
        }

        return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.ArrayWrite({arrayExpression}, {indexExpression}, {valueExpression}, {Literal(identifier.Identifier.ValueText)}, {line});"
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

        string left = elementAccess.ToString();
        string pathExpression = CreateObjectArrayExpression(path, index);
        if (assignment.Right.IsKind(SyntaxKind.NullLiteralExpression))
        {
            return TraceStatement(
                $"{{ TraceCode.CSharpHost.RuntimeTraceSink.FieldWrite({Literal(variable)}, {pathExpression}, null, {line}); {left} = null; }}"
            );
        }

        string right = assignment.Right.ToString();
        return TraceStatement(
            $"{left} = TraceCode.Internal.TraceCodeTrace.FieldWrite({right}, {Literal(variable)}, {pathExpression}, {line});"
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

            string currentNestedValue = $"TraceCode.Internal.TraceCodeTrace.ArrayRead({nestedVariable}, {firstIndex}, {secondIndex}, {Literal(nestedVariable)}, {line})";
            return TraceStatement(
                $"TraceCode.Internal.TraceCodeTrace.ArrayWrite({nestedVariable}, {firstIndex}, {secondIndex}, {currentNestedValue} {operatorText} 1, {Literal(nestedVariable)}, {line});"
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
        string currentValue = CreateArrayReadExpression(arrayExpression, indexExpression, variableName, line);
        return TraceStatement(
            $"TraceCode.Internal.TraceCodeTrace.ArrayWrite({arrayExpression}, {indexExpression}, {currentValue} {operatorText} 1, {Literal(variableName)}, {line});"
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

    private static bool IsAddInvocationReceiver(SyntaxNode node)
    {
        return node.Parent is MemberAccessExpressionSyntax memberAccess
            && memberAccess.Expression == node
            && string.Equals(memberAccess.Name.Identifier.ValueText, "Add", StringComparison.Ordinal)
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
            && node.Name.Identifier.ValueText is "Length" or "LongLength" or "Rank" or "Count";
    }

    private static bool IsRangeIndex(string expression)
    {
        return expression.Contains("..", StringComparison.Ordinal)
            || expression.StartsWith("^", StringComparison.Ordinal);
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
            .Any(node => node is DeclarationPatternSyntax or RecursivePatternSyntax);
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

    private static string CreateStringArrayExpression(IReadOnlyList<string> values)
    {
        return $"new string[] {{ {string.Join(", ", values.Select(Literal))} }}";
    }

    private static string CreateObjectArrayExpression(IReadOnlyList<string> values, string finalExpression)
    {
        return $"new object?[] {{ {string.Join(", ", values.Select(Literal).Append(finalExpression))} }}";
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

    private static string CreateArrayReadExpression(
        string arrayExpression,
        string indexExpression,
        string variableName,
        int line
    )
    {
        return $"TraceCode.Internal.TraceCodeTrace.ArrayRead({arrayExpression}, {indexExpression}, {Literal(variableName)}, {line})";
    }

    private static bool TryRewriteCollectionCreation(
        ExpressionSyntax creation,
        string variableName,
        TypeSyntax? declaredType,
        out ExpressionSyntax? replacement
    )
    {
        replacement = null;

        TypeSyntax? collectionType = creation switch
        {
            ObjectCreationExpressionSyntax objectCreation => objectCreation.Type,
            ImplicitObjectCreationExpressionSyntax => declaredType,
            _ => null,
        };

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
        replacement = typeName switch
        {
            "List" => SyntaxFactory.ParseExpression(
                $"new TraceCode.Internal.TraceCodeList<{typeArguments}>({Literal(variableName)}, {line}{constructorArguments}){initializer}"
            ),
            "Dictionary" => SyntaxFactory.ParseExpression(
                $"new TraceCode.Internal.TraceCodeDictionary<{typeArguments}>({Literal(variableName)}, {line}{constructorArguments}){initializer}"
            ),
            "HashSet" => SyntaxFactory.ParseExpression(
                $"new TraceCode.Internal.TraceCodeHashSet<{typeArguments}>({Literal(variableName)}, {line}{constructorArguments}){initializer}"
            ),
            "Queue" => SyntaxFactory.ParseExpression(
                $"new TraceCode.Internal.TraceCodeQueue<{typeArguments}>({Literal(variableName)}, {line}{constructorArguments}){initializer}"
            ),
            "PriorityQueue" => SyntaxFactory.ParseExpression(
                $"new TraceCode.Internal.TraceCodePriorityQueue<{typeArguments}>({Literal(variableName)}, {line}{constructorArguments}){initializer}"
            ),
            "LinkedList" => SyntaxFactory.ParseExpression(
                $"new TraceCode.Internal.TraceCodeLinkedList<{typeArguments}>({Literal(variableName)}, {line}{constructorArguments}){initializer}"
            ),
            "Stack" => SyntaxFactory.ParseExpression(
                $"new TraceCode.Internal.TraceCodeStack<{typeArguments}>({Literal(variableName)}, {line}{constructorArguments}){initializer}"
            ),
            _ => null,
        };

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

    private static int GetLine(SyntaxNode node)
    {
        FileLinePositionSpan span = node.SyntaxTree.GetLineSpan(node.Span);
        return span.StartLinePosition.Line + 1;
    }

    private static string Literal(string value)
    {
        return SymbolDisplay.FormatLiteral(value, true);
    }
}

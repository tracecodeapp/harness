using System.Reflection;

namespace TraceCode.CSharpHost;

// Used by both the precompiled nodes and the compiler-emitted prelude. The
// compiler reserves the marker for trusted syntax so a learner's own type
// with the same name and shape keeps all of its members.
[AttributeUsage(AttributeTargets.Class, Inherited = false)]
public sealed class BuiltinNodeAttribute : Attribute
{
}

internal static class BuiltinNodeOutput
{
    internal const string MarkerTypeName = "TraceCode.CSharpHost.BuiltinNodeAttribute";

    internal static bool IsBuiltin(Type? type) =>
        type is { Namespace: null, Name: "ListNode" or "TreeNode" } &&
        type.IsDefined(typeof(BuiltinNodeAttribute), inherit: false);

    internal static bool IsAlias(PropertyInfo property) =>
        property.Name == "value" && IsBuiltin(property.DeclaringType);
}

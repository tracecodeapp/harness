using System.Reflection;
using System.Runtime.Loader;

namespace TraceCode.CSharpHost;

/// <summary>
/// Collectible learner context whose dependencies resolve exclusively through
/// the trusted default runtime context rather than learner-controlled probing.
/// </summary>
internal sealed class RestrictedUserExecutionLoadContext : AssemblyLoadContext
{
    public RestrictedUserExecutionLoadContext(string name)
        : base(name, isCollectible: true) { }

    protected override Assembly? Load(AssemblyName assemblyName) =>
        Default.LoadFromAssemblyName(assemblyName);
}

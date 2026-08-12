using System.Diagnostics;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;

if (args.Length != 2)
{
    Console.Error.WriteLine("Usage: TraceCode.TraceClrNativeProbe <manifest.json> <results.json>");
    return 2;
}

JsonSerializerOptions jsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };
ProbeManifest manifest = JsonSerializer.Deserialize<ProbeManifest>(await File.ReadAllTextAsync(args[0]), jsonOptions)
    ?? throw new InvalidDataException("TraceCLR native probe manifest is empty.");
if (manifest.Schema != "tracecode.traceclr-native-probe.v1")
{
    throw new InvalidDataException($"TraceCLR native probe schema mismatch: {manifest.Schema}");
}

var results = new List<ProbeResult>(manifest.Cases.Count);
foreach (ProbeCase probe in manifest.Cases)
{
    var stopwatch = Stopwatch.StartNew();
    var loadContext = new AssemblyLoadContext($"traceclr-probe-{probe.Id}", isCollectible: true);
    TextWriter originalOutput = Console.Out;
    using var capturedOutput = new StringWriter();
    try
    {
        Console.SetOut(capturedOutput);
        byte[] assemblyBytes = await File.ReadAllBytesAsync(probe.AssemblyPath);
        using var stream = new MemoryStream(assemblyBytes, writable: false);
        Assembly assembly = loadContext.LoadFromStream(stream);
        Type driverType = assembly.GetType("TraceCodeDriver", throwOnError: true)!;
        MethodInfo run = driverType.GetMethod(
            "Run",
            BindingFlags.Public | BindingFlags.Static,
            binder: null,
            types: new[] { typeof(byte[]) },
            modifiers: null
        ) ?? throw new MissingMethodException("TraceCodeDriver", "Run(byte[])");
        byte[] input = Convert.FromBase64String(probe.InputBase64);
        byte[] output = (byte[])(run.Invoke(null, new object?[] { input })
            ?? throw new InvalidOperationException("TraceCodeDriver.Run returned null."));
        stopwatch.Stop();
        results.Add(new ProbeResult(probe.Id, Convert.ToBase64String(output), null, capturedOutput.ToString(), stopwatch.Elapsed.TotalMilliseconds));
    }
    catch (Exception error)
    {
        stopwatch.Stop();
        Exception root = error is TargetInvocationException { InnerException: not null } invocation
            ? invocation.InnerException!
            : error;
        results.Add(new ProbeResult(probe.Id, null, $"{root.GetType().Name}: {root.Message}", capturedOutput.ToString(), stopwatch.Elapsed.TotalMilliseconds));
    }
    finally
    {
        Console.SetOut(originalOutput);
        loadContext.Unload();
    }
}

await File.WriteAllTextAsync(
    args[1],
    JsonSerializer.Serialize(
        new ProbeResults("tracecode.traceclr-native-probe-results.v1", results),
        jsonOptions
    ) + "\n"
);
return results.Any(result => result.Error is not null) ? 1 : 0;

internal sealed record ProbeManifest(string Schema, IReadOnlyList<ProbeCase> Cases);
internal sealed record ProbeCase(string Id, string AssemblyPath, string InputBase64);
internal sealed record ProbeResults(string Schema, IReadOnlyList<ProbeResult> Results);
internal sealed record ProbeResult(string Id, string? OutputBase64, string? Error, string Stdout, double ElapsedMs);

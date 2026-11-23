using System;
using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using TraceCode.CSharpHost;

namespace TraceCode.CSharpAlgorithmRunner;

public static partial class Program
{
    public static void Main()
    {
    }

    [JSExport]
    [SupportedOSPlatform("browser")]
    public static byte[] Execute(byte[] assemblyBytes, byte[] inputBytes)
    {
        Assembly assembly = Assembly.Load(assemblyBytes);
        Type driverType = assembly.GetType("TraceCodeDriver", throwOnError: true)!;
        MethodInfo run = driverType.GetMethod(
            "Run",
            BindingFlags.Public | BindingFlags.Static,
            binder: null,
            types: new[] { typeof(byte[]), typeof(Action) },
            modifiers: null
        ) ?? throw new MissingMethodException(
            "TraceCodeDriver",
            "Run(byte[], Action)"
        );
        return (byte[])(run.Invoke(
            null,
            new object?[] { inputBytes, static () => { } }
        )
            ?? throw new InvalidOperationException("TraceCodeDriver.Run returned null."));
    }

    [JSExport]
    [SupportedOSPlatform("browser")]
    public static byte[] ExecutePrepared(
        string artifactKey,
        string artifactBase64,
        string artifactSha256,
        byte[] inputBytes,
        int timeoutMs
    ) => TraceClrAlgorithmExecutionCore.ExecutePrepared(
        artifactKey,
        artifactBase64,
        artifactSha256,
        inputBytes,
        timeoutMs
    );

    /// <summary>
    /// After <c>ExecutePrepared</c> returned empty output: the program's
    /// failure as JSON <c>{"error","timeoutReason"}</c>.
    /// </summary>
    [JSExport]
    [SupportedOSPlatform("browser")]
    public static string TakeProgramFailure() =>
        TraceClrAlgorithmExecutionCore.TakeProgramFailure();

    [JSExport]
    [SupportedOSPlatform("browser")]
    public static string ExecutePreparedTrace(
        string artifactKey,
        string artifactBase64,
        string artifactSha256,
        byte[] inputBytes,
        string source,
        int timeoutMs,
        int maxTraceSteps,
        int maxLineEvents,
        int maxSingleLineHits,
        int maxStoredEvents,
        bool minimalTrace,
        bool recordTrace,
        int maxTraceBytes
    )
    {
        TraceClrAlgorithmExecutionResult result =
            TraceClrAlgorithmExecutionCore.ExecutePreparedTrace(
                artifactKey,
                artifactBase64,
                artifactSha256,
                inputBytes,
                source,
                timeoutMs,
                PositiveOrNull(maxTraceSteps),
                PositiveOrNull(maxLineEvents),
                PositiveOrNull(maxSingleLineHits),
                PositiveOrNull(maxStoredEvents),
                minimalTrace,
                recordTrace,
                maxTraceBytes,
                TraceClrAlgorithmResponseJson.CreateTraceEventMeasurer(maxTraceBytes)
            );
        return TraceClrAlgorithmResponseJson.Serialize(result);
    }

    private static int? PositiveOrNull(int value) => value > 0 ? value : null;
}

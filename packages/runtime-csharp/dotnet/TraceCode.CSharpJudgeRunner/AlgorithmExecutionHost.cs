using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;

namespace TraceCode.CSharpHost;

/// <summary>
/// Binary, compiler-free execution boundary for eligible algorithm methods.
/// The compiler has already bound the learner method and generated the typed
/// TraceCodeDriver; this host only validates the immutable assembly and invokes
/// that driver. The outer worker remains the hard per-case isolation boundary.
/// </summary>
public static partial class AlgorithmExecutionHost
{
    [JSExport]
    [SupportedOSPlatform("browser")]
    public static byte[] ExecutePrepared(
        string artifactBase64,
        string artifactSha256,
        byte[] inputBytes
    )
    {
        return TraceClrAlgorithmExecutionCore.ExecutePrepared(
            artifactBase64,
            artifactSha256,
            inputBytes
        );
    }

    [JSExport]
    [SupportedOSPlatform("browser")]
    public static string ExecutePreparedTrace(
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
        bool recordTrace
    )
    {
        TraceClrAlgorithmExecutionResult result =
            TraceClrAlgorithmExecutionCore.ExecutePreparedTrace(
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
                recordTrace
            );
        return TraceClrAlgorithmResponseJson.Serialize(result);
    }

    private static int? PositiveOrNull(int value) => value > 0 ? value : null;
}

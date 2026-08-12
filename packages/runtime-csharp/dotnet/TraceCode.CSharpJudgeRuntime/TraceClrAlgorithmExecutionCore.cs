using System.Reflection;
using System.Security.Cryptography;

namespace TraceCode.CSharpHost;

public sealed record TraceClrAlgorithmExecutionResult(
    bool Success,
    byte[]? OutputBytes,
    List<RuntimeTraceEvent> Events,
    bool TraceLimitExceeded,
    string? TimeoutReason,
    string? Error
);

/// <summary>
/// Shared compiler-free execution core for the broad and minimal TraceCLR
/// runner shells. The outer worker remains the hard per-case boundary.
/// </summary>
public static class TraceClrAlgorithmExecutionCore
{
    private const long MaxArtifactBytes = 8L * 1024 * 1024;

    public static byte[] ExecutePrepared(
        string artifactBase64,
        string artifactSha256,
        byte[] inputBytes
    )
    {
        byte[] assemblyBytes = DecodeAndValidateArtifact(
            artifactBase64,
            artifactSha256
        );
        return InvokeDriver(assemblyBytes, inputBytes);
    }

    public static TraceClrAlgorithmExecutionResult ExecutePreparedTrace(
        string artifactBase64,
        string artifactSha256,
        byte[] inputBytes,
        string source,
        int timeoutMs,
        int? maxTraceSteps,
        int? maxLineEvents,
        int? maxSingleLineHits,
        int? maxStoredEvents,
        bool minimalTrace,
        bool recordTrace
    )
    {
        byte[] assemblyBytes = DecodeAndValidateArtifact(
            artifactBase64,
            artifactSha256
        );
        RuntimeTraceSink.Reset();
        RuntimeTraceSink.Configure(
            timeoutMs,
            recordTrace ? maxTraceSteps : null,
            recordTrace ? maxLineEvents : null,
            recordTrace ? maxSingleLineHits : null,
            recordTrace ? maxStoredEvents : null,
            recordTrace && minimalTrace,
            recordTrace
        );
        try
        {
            byte[] outputBytes = InvokeDriver(assemblyBytes, inputBytes);
            List<RuntimeTraceEvent> events = RuntimeTraceSink.Snapshot();
            TraceEventBackfill.Apply(source, events, recordTrace && minimalTrace);
            return new TraceClrAlgorithmExecutionResult(
                true,
                outputBytes,
                events,
                RuntimeTraceSink.TraceLimitExceeded,
                RuntimeTraceSink.TraceLimitExceeded
                    ? RuntimeTraceSink.TimeoutReason
                    : null,
                null
            );
        }
        catch (Exception error)
            when (error.GetBaseException() is TraceCodeTimeoutException timeout)
        {
            return LimitResult(source, recordTrace, minimalTrace, timeout.Message, "client-timeout");
        }
        catch (Exception error)
            when (error.GetBaseException() is TraceLimitExceededException traceLimit)
        {
            return LimitResult(source, recordTrace, minimalTrace, traceLimit.Message, traceLimit.TimeoutReason);
        }
        catch (Exception error)
        {
            return FailureResult(
                source,
                recordTrace,
                minimalTrace,
                error.GetBaseException().Message
            );
        }
        finally
        {
            RuntimeTraceSink.Reset();
        }
    }

    private static TraceClrAlgorithmExecutionResult FailureResult(
        string source,
        bool recordTrace,
        bool minimalTrace,
        string error
    )
    {
        List<RuntimeTraceEvent> events = RuntimeTraceSink.Snapshot();
        TraceEventBackfill.Apply(source, events, recordTrace && minimalTrace);
        return new TraceClrAlgorithmExecutionResult(
            false,
            null,
            events,
            RuntimeTraceSink.TraceLimitExceeded,
            null,
            error
        );
    }

    private static TraceClrAlgorithmExecutionResult LimitResult(
        string source,
        bool recordTrace,
        bool minimalTrace,
        string error,
        string timeoutReason
    )
    {
        List<RuntimeTraceEvent> events = RuntimeTraceSink.Snapshot();
        TraceEventBackfill.Apply(source, events, recordTrace && minimalTrace);
        return new TraceClrAlgorithmExecutionResult(
            false,
            null,
            events,
            RuntimeTraceSink.TraceLimitExceeded,
            timeoutReason,
            error
        );
    }

    private static byte[] DecodeAndValidateArtifact(
        string artifactBase64,
        string artifactSha256
    )
    {
        byte[] assemblyBytes;
        try
        {
            assemblyBytes = Convert.FromBase64String(artifactBase64);
        }
        catch (FormatException error)
        {
            throw new ArgumentException(
                "Prepared TraceCLR artifact is not valid base64.",
                nameof(artifactBase64),
                error
            );
        }
        if (
            assemblyBytes.LongLength > MaxArtifactBytes
            || assemblyBytes.Length < 2
            || assemblyBytes[0] != (byte)'M'
            || assemblyBytes[1] != (byte)'Z'
            || !string.Equals(
                artifactSha256,
                Convert.ToHexString(SHA256.HashData(assemblyBytes))
                    .ToLowerInvariant(),
                StringComparison.Ordinal
            )
        )
        {
            throw new ArgumentException(
                "Prepared TraceCLR artifact identity is invalid."
            );
        }
        return assemblyBytes;
    }

    private static byte[] InvokeDriver(
        byte[] assemblyBytes,
        byte[] inputBytes
    )
    {
        Assembly assembly = Assembly.Load(assemblyBytes);
        Type driverType = assembly.GetType(
            "TraceCodeDriver",
            throwOnError: true
        )!;
        MethodInfo run = driverType.GetMethod(
            "Run",
            BindingFlags.Public | BindingFlags.Static,
            binder: null,
            types: new[] { typeof(byte[]) },
            modifiers: null
        ) ?? throw new MissingMethodException(
            "TraceCodeDriver",
            "Run(byte[])"
        );
        return (byte[])(run.Invoke(null, new object?[] { inputBytes })
            ?? throw new InvalidOperationException(
                "TraceCodeDriver.Run returned null."
            ));
    }
}

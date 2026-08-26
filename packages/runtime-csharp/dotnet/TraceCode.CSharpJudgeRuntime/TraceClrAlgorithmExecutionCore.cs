using System.Reflection;
using System.Runtime.Loader;
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
/// runner shells. Eligible algorithm batches may retain the outer worker, so
/// each invocation owns a fresh collectible load context for learner statics.
/// </summary>
public static class TraceClrAlgorithmExecutionCore
{
    private const long MaxArtifactBytes = 8L * 1024 * 1024;
    private const string PreparedArtifactMetadataSchema =
        "tracecode-csharp-prepared-artifact-v1";
    private const string AlgorithmFastRunnerTier = "algorithm-fast";

    public static byte[] ExecutePrepared(
        string artifactKey,
        string artifactBase64,
        string artifactSha256,
        byte[] inputBytes
    )
    {
        byte[] assemblyBytes = DecodeAndValidateArtifact(
            artifactBase64,
            artifactSha256
        );
        return InvokeDriver(
            assemblyBytes,
            artifactKey,
            inputBytes,
            static () => { }
        );
    }

    public static TraceClrAlgorithmExecutionResult ExecutePreparedTrace(
        string artifactKey,
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
            byte[] outputBytes = InvokeDriver(
                assemblyBytes,
                artifactKey,
                inputBytes,
                RuntimeTraceSink.CheckTimeout
            );
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
            when (UnwrapDriverException(error) is TraceCodeTimeoutException timeout)
        {
            return LimitResult(source, recordTrace, minimalTrace, timeout.Message, "client-timeout");
        }
        catch (Exception error)
            when (UnwrapDriverException(error) is TraceLimitExceededException traceLimit)
        {
            return LimitResult(source, recordTrace, minimalTrace, traceLimit.Message, traceLimit.TimeoutReason);
        }
        catch (Exception error)
        {
            return FailureResult(
                source,
                recordTrace,
                minimalTrace,
                UnwrapDriverException(error).Message
            );
        }
        finally
        {
            RuntimeTraceSink.Reset();
        }
    }

    private static Exception UnwrapDriverException(Exception error)
    {
        Exception current = error;
        while (
            current is TargetInvocationException { InnerException: not null } target
        )
        {
            current = target.InnerException!;
        }
        return current.GetBaseException();
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
        string artifactKey,
        byte[] inputBytes,
        Action checkTimeout
    )
    {
        var loadContext = new RestrictedUserExecutionLoadContext(
            "TraceCode.AlgorithmCase"
        );
        try
        {
            using MemoryStream assemblyStream = new(
                assemblyBytes,
                writable: false
            );
            Assembly assembly = loadContext.LoadFromStream(assemblyStream);
            ValidatePreparedArtifactIdentity(assembly, artifactKey);
            Type driverType = assembly.GetType(
                "TraceCodeDriver",
                throwOnError: true
            )!;
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
                new object?[] { inputBytes, checkTimeout }
            )
                ?? throw new InvalidOperationException(
                    "TraceCodeDriver.Run returned null."
                ));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static void ValidatePreparedArtifactIdentity(
        Assembly assembly,
        string artifactKey
    )
    {
        bool validArtifactKey = artifactKey.Length == 64;
        foreach (char character in artifactKey)
        {
            if (character is not (>= '0' and <= '9')
                and not (>= 'a' and <= 'f'))
            {
                validArtifactKey = false;
                break;
            }
        }
        if (!validArtifactKey)
        {
            throw new ArgumentException(
                "Prepared TraceCLR artifact identity is invalid."
            );
        }

        string? schema = null;
        string? embeddedArtifactKey = null;
        string? runnerTier = null;
        bool duplicateMetadata = false;
        foreach (
            AssemblyMetadataAttribute attribute in assembly
                .GetCustomAttributes<AssemblyMetadataAttribute>()
        )
        {
            switch (attribute.Key)
            {
                case "TraceCode.PreparedArtifactSchema":
                    duplicateMetadata |= schema is not null;
                    schema = attribute.Value ?? string.Empty;
                    break;
                case "TraceCode.PreparedArtifactKey":
                    duplicateMetadata |= embeddedArtifactKey is not null;
                    embeddedArtifactKey = attribute.Value ?? string.Empty;
                    break;
                case "TraceCode.PreparedRunnerTier":
                    duplicateMetadata |= runnerTier is not null;
                    runnerTier = attribute.Value ?? string.Empty;
                    break;
            }
        }
        if (
            duplicateMetadata
            || !string.Equals(
                schema,
                PreparedArtifactMetadataSchema,
                StringComparison.Ordinal
            )
            || !string.Equals(
                embeddedArtifactKey,
                artifactKey,
                StringComparison.Ordinal
            )
            || !string.Equals(
                runnerTier,
                AlgorithmFastRunnerTier,
                StringComparison.Ordinal
            )
        )
        {
            throw new ArgumentException(
                "Prepared TraceCLR artifact identity is invalid."
            );
        }
    }

}
